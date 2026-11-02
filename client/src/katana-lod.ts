import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

type MeshoptSimplifyFn = (
  indices: Uint32Array,
  positions: Float32Array,
  stride: number,
  targetCount: number,
  targetError: number,
  options?: string[],
) => [Uint32Array, number];
type MeshoptSimplifierApi = { ready: Promise<void>; simplify: MeshoptSimplifyFn };

/**
 * Local adaptation: the `meshoptimizer` npm package is not vendored
 * (client/vendor/three only ships the GLTF *decoder*), so the runtime
 * simplifier loads lazily and every caller falls back to full detail when it
 * is absent. The authored far shell (katana-low.glb) never needs it.
 * r187-verified (Nov 2026): still no `meshoptimizer` npm dependency and
 * VERSION.txt confirms only the decoder is vendored — the lazy import stays.
 */
let simplifierPromise: Promise<MeshoptSimplifierApi | null> | null = null;
function loadMeshoptSimplifier(): Promise<MeshoptSimplifierApi | null> {
  if (!simplifierPromise) {
    simplifierPromise = (async () => {
      try {
        // Built indirectly so the bundler leaves this as a runtime-only
        // import (the package is optional; absence falls back to full detail).
        const specifier = ["meshopt", "imizer"].join("");
        const mod = (await import(/* @vite-ignore */ specifier)) as unknown as {
          MeshoptSimplifier?: MeshoptSimplifierApi;
        } & MeshoptSimplifierApi;
        const api = mod.MeshoptSimplifier ?? (mod as unknown as MeshoptSimplifierApi);
        if (!api || typeof api.simplify !== "function") return null;
        await api.ready;
        return api;
      } catch {
        return null;
      }
    })();
  }
  return simplifierPromise;
}

type Range = { start: number; count: number; materialIndex: number };
type LowGeometry = {
  geometry: THREE.BufferGeometry;
  sourceTriangles: number;
  triangles: number;
  maxError: number;
};
type SimplifyOptions = { ratio: number; error: number };

export type KatanaLodMode = "near" | "far";
export type KatanaLodDistrict = "garden" | "shrine" | "town";

export type KatanaDistrictLod = {
  state: Record<KatanaLodDistrict, KatanaLodMode>;
  transitions: number;
  toFar: number;
  toNear: number;
  update: (camera: THREE.Camera) => void;
  setOverride: (mode: KatanaLodMode | null) => void;
};

const LOW_GEOMETRIES = new Map<string, LowGeometry>();
const CENTERS: Record<KatanaLodDistrict, THREE.Vector3> = {
  garden: new THREE.Vector3(0, 0, -4),
  shrine: new THREE.Vector3(0, 8, -38),
  town: new THREE.Vector3(0, -6, 40),
};

function rangesFor(mesh: THREE.Mesh): Range[] {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const total = geometry.getIndex()?.count ?? position.count;
  const rangeStart = Math.max(0, geometry.drawRange.start);
  const rangeEnd = Math.min(total, geometry.drawRange.start + geometry.drawRange.count);
  const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
  return groups.map((group) => {
    const start = Math.max(rangeStart, group.start);
    const end = Math.min(rangeEnd, group.start + group.count);
    return { start, count: Math.max(0, end - start), materialIndex: group.materialIndex ?? 0 };
  }).filter((range) => Number.isFinite(range.count) && range.count > 0);
}

function simplifyRange(source: THREE.BufferGeometry, range: Range, options: SimplifyOptions, api: MeshoptSimplifierApi): LowGeometry {
  const sourceIndex = source.getIndex();
  const position = source.getAttribute("position");
  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  const indices = new Uint32Array(range.count);
  for (let i = 0; i < range.count; i++) {
    const offset = range.start + i;
    indices[i] = sourceIndex ? sourceIndex.getX(offset) : offset;
  }
  const targetCount = Math.floor(indices.length * options.ratio / 3) * 3;
  let simplified: Uint32Array<ArrayBufferLike> = indices;
  let maxError = 0;
  if (indices.length > 36 && targetCount < indices.length) {
    try {
      [simplified, maxError] = api.simplify(indices, positions, 3, targetCount, options.error, ["ErrorAbsolute", "LockBorder"]);
    } catch {
      simplified = indices;
    }
  }

  const remap = new Map<number, number>();
  const vertices: number[] = [];
  const outputIndices = new Uint32Array(simplified.length);
  for (let i = 0; i < simplified.length; i++) {
    const oldIndex = simplified[i]!;
    let newIndex = remap.get(oldIndex);
    if (newIndex === undefined) {
      newIndex = vertices.length;
      remap.set(oldIndex, newIndex);
      vertices.push(oldIndex);
    }
    outputIndices[i] = newIndex;
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const values = new Float32Array(vertices.length * attribute.itemSize);
    for (let i = 0; i < vertices.length; i++) {
      for (let component = 0; component < attribute.itemSize; component++) {
        values[i * attribute.itemSize + component] = attribute.getComponent(vertices[i]!, component);
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(outputIndices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, sourceTriangles: range.count / 3, triangles: outputIndices.length / 3, maxError };
}

function lowGeometry(mesh: THREE.Mesh, options: SimplifyOptions, api: MeshoptSimplifierApi): LowGeometry {
  const ranges = rangesFor(mesh);
  const key = `${mesh.geometry.uuid}|${options.ratio}|${options.error}|${ranges.map((range) => `${range.start}:${range.count}:${range.materialIndex}`).join(",")}`;
  const cached = LOW_GEOMETRIES.get(key);
  if (cached) return cached;
  const parts = ranges.map((range) => simplifyRange(mesh.geometry, range, options, api));
  let geometry: THREE.BufferGeometry;
  if (parts.length === 1) {
    geometry = parts[0]!.geometry;
  } else {
    geometry = mergeGeometries(parts.map((part) => part.geometry), true);
    for (const part of parts) part.geometry.dispose();
    for (let i = 0; i < ranges.length; i++) geometry.groups[i]!.materialIndex = ranges[i]!.materialIndex;
  }
  const result = {
    geometry,
    sourceTriangles: parts.reduce((sum, part) => sum + part.sourceTriangles, 0),
    triangles: parts.reduce((sum, part) => sum + part.triangles, 0),
    maxError: parts.reduce((max, part) => Math.max(max, part.maxError), 0),
  };
  LOW_GEOMETRIES.set(key, result);
  return result;
}

export async function createKatanaPropLod(template: THREE.Object3D, options: Partial<SimplifyOptions> = {}): Promise<THREE.Object3D> {
  const settings = { ratio: options.ratio ?? 0.3, error: options.error ?? 0.05 };
  const object = template.clone(true);
  const api = await loadMeshoptSimplifier();
  if (!api) {
    // No runtime simplifier available — keep the authored geometry as-is.
    // Callers already treat this as a full-detail fallback.
    object.userData.ktPropLod = {
      sourceTriangles: 0,
      triangles: 0,
      maxError: 0,
      ratio: 1,
      targetErrorMeters: settings.error,
      fallback: "full-detail",
    };
    object.userData.ktPropLodFallback = true;
    return object;
  }
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && mesh.geometry.getAttribute("position")) meshes.push(mesh);
  });
  let sourceTriangles = 0;
  let triangles = 0;
  let maxError = 0;
  for (const mesh of meshes) {
    const low = lowGeometry(mesh, settings, api);
    mesh.geometry = low.geometry;
    const count = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    sourceTriangles += low.sourceTriangles * count;
    triangles += low.triangles * count;
    maxError = Math.max(maxError, low.maxError);
  }
  object.userData.ktPropLod = {
    sourceTriangles,
    triangles,
    maxError,
    ratio: sourceTriangles ? triangles / sourceTriangles : 1,
    targetErrorMeters: settings.error,
  };
  return object;
}

export function createKatanaDistrictLod(root: THREE.Group, near: THREE.Group, far: THREE.Group): KatanaDistrictLod {
  const levels = [
    { mode: "near" as const, root: near },
    { mode: "far" as const, root: far },
  ];
  const batches = levels.flatMap((level) => {
    const meshes: THREE.BatchedMesh[] = [];
    level.root.traverse((object) => {
      if ((object as THREE.BatchedMesh).isBatchedMesh) meshes.push(object as THREE.BatchedMesh);
    });
    return meshes.map((mesh) => ({ ...level, mesh, districts: mesh.userData.ktInstanceDistricts as string[], instanceLevels: mesh.userData.ktInstanceLevels as KatanaLodMode[] | undefined }));
  });
  const nested = new Set(batches.map((batch) => batch.mesh));
  root.traverse((object) => {
    const mesh = object as THREE.BatchedMesh;
    if (!mesh.isBatchedMesh || nested.has(mesh)) return;
    batches.push({ mesh, mode: "near", root, districts: mesh.userData.ktInstanceDistricts as string[], instanceLevels: mesh.userData.ktInstanceLevels as KatanaLodMode[] | undefined });
  });
  const state: Record<KatanaLodDistrict, KatanaLodMode> = { garden: "near", shrine: "near", town: "near" };
  const districts = Object.keys(CENTERS) as KatanaLodDistrict[];
  const chunks: {
    mesh: THREE.BatchedMesh;
    mode: KatanaLodMode;
    district: KatanaLodDistrict;
    index: number;
    center: THREE.Sphere | null;
    current: KatanaLodMode;
  }[] = [];
  for (const batch of batches) {
    if (!batch.districts) {
      console.warn("[katana] LOD batch is missing district metadata; skipping batch");
      continue;
    }
    batch.mesh.updateMatrixWorld(true);
    for (let index = 0; index < batch.districts.length; index++) {
      const district = batch.districts[index]!;
      if (district === "terrain") continue;
      if (!(district in CENTERS)) {
        console.warn(`[katana] unknown LOD district "${district}"; skipping instance ${index}`);
        continue;
      }
      const center = batch.mesh.getBoundingSphereAt(batch.mesh.getGeometryIdAt(index), new THREE.Sphere());
      center?.applyMatrix4(batch.mesh.matrixWorld);
      chunks.push({ ...batch, mode: batch.instanceLevels?.[index] ?? batch.mode, district: district as KatanaLodDistrict, index, center, current: state[district as KatanaLodDistrict] });
    }
  }
  let override: KatanaLodMode | null = null;
  let camera: THREE.Camera | null = null;
  const position = new THREE.Vector3();
  const applyAll = (): void => {
    for (const batch of batches) {
      for (let index = 0; index < batch.districts.length; index++) {
        if (batch.districts[index] === "terrain") batch.mesh.setVisibleAt(index, (batch.instanceLevels?.[index] ?? batch.mode) === "near");
      }
    }
    for (const chunk of chunks) {
      chunk.current = override ?? state[chunk.district];
      chunk.mesh.setVisibleAt(chunk.index, chunk.current === chunk.mode);
    }
  };
  const select = (district: KatanaLodDistrict, mode: KatanaLodMode): void => {
    if (state[district] === mode) return;
    state[district] = mode;
    api.transitions++;
  };
  const api: KatanaDistrictLod = {
    state,
    transitions: 0,
    toFar: 45,
    toNear: 40,
    update: (nextCamera) => {
      camera = nextCamera;
      if (override) return;
      camera.getWorldPosition(position);
      for (const district of districts) {
        const distance = position.distanceTo(CENTERS[district]);
        if (state[district] === "near" && distance > api.toFar) select(district, "far");
        else if (state[district] === "far" && distance < api.toNear) select(district, "near");
      }
      for (const chunk of chunks) {
        let mode = chunk.center ? chunk.current : state[chunk.district];
        if (chunk.center) {
          const distance = position.distanceTo(chunk.center.center);
          if (mode === "near" && distance > 28) mode = "far";
          else if (mode === "far" && distance < 23) mode = "near";
        }
        if (mode === chunk.current && chunk.center) continue;
        chunk.current = mode;
        chunk.mesh.setVisibleAt(chunk.index, mode === chunk.mode);
        if (chunk.center) api.transitions++;
      }
    },
    setOverride: (mode) => {
      const previous = override;
      override = mode;
      if (mode) for (const district of districts) select(district, mode);
      applyAll();
      if (!mode && camera && previous) api.update(camera);
    },
  };
  applyAll();
  // near/far are attached by the caller (katana-world adds them before
  // batching); only attach here if a future caller passes detached groups.
  for (const level of [near, far]) if (level.parent !== root) root.add(level);
  root.userData.katanaLod = api;
  return api;
}
