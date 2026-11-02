import * as THREE from "three";

type LightCandidate = { position: THREE.Vector3; district: string; order: string };

type Draw = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
  district: string;
  lod: "near" | "far";
  tint?: THREE.Color;
  start: number;
  count: number;
};

type Bin = {
  material: THREE.Material;
  kind: string;
  district: string;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  layout: Map<string, number>;
  draws: Draw[];
};

export type KatanaStaticBatchStats = {
  sourceMeshes: number;
  sourceCalls: number;
  sourceTriangles: number;
  batches: number;
  geometries: number;
  triangles: number;
};

const emptyStats = (): KatanaStaticBatchStats => ({
  sourceMeshes: 0,
  sourceCalls: 0,
  sourceTriangles: 0,
  batches: 0,
  geometries: 0,
  triangles: 0,
});

function compatible(layout: Map<string, number>, geometry: THREE.BufferGeometry): boolean {
  for (const [name, itemSize] of layout) {
    const attribute = geometry.getAttribute(name);
    if (attribute && attribute.itemSize !== itemSize) return false;
  }
  return true;
}

function bakeDraw(draw: Draw, layout: Map<string, number>): THREE.BufferGeometry {
  const source = draw.geometry;
  const sourceIndex = source.getIndex();
  const remap = new Map<number, number>();
  const vertices: number[] = [];
  const indices = new Uint32Array(draw.count);
  for (let i = 0; i < draw.count; i++) {
    const offset = draw.start + i;
    const oldIndex = sourceIndex ? sourceIndex.getX(offset) : offset;
    let newIndex = remap.get(oldIndex);
    if (newIndex === undefined) {
      newIndex = vertices.length;
      remap.set(oldIndex, newIndex);
      vertices.push(oldIndex);
    }
    indices[i] = newIndex;
  }

  const geometry = new THREE.BufferGeometry();
  for (const [name, itemSize] of layout) {
    const attribute = source.getAttribute(name);
    const values = new Float32Array(vertices.length * itemSize);
    if (attribute) {
      for (let i = 0; i < vertices.length; i++) {
        for (let component = 0; component < itemSize; component++) {
          values[i * itemSize + component] = attribute.getComponent(vertices[i]!, component);
        }
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.applyMatrix4(draw.matrix);
  if (draw.matrix.determinant() < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const swap = indices[i + 1]!;
      indices[i + 1] = indices[i + 2]!;
      indices[i + 2] = swap;
    }
    geometry.index!.needsUpdate = true;
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function spatialShellDraws(draw: Draw): Draw[] {
  if (draw.count < 768) return [draw];
  const source = draw.geometry;
  const index = source.getIndex();
  const position = source.getAttribute("position");
  const cells = new Map<string, number[]>();
  const center = new THREE.Vector3();
  for (let offset = draw.start; offset < draw.start + draw.count; offset += 3) {
    center.set(0, 0, 0);
    for (let corner = 0; corner < 3; corner++) {
      const vertex = index ? index.getX(offset + corner) : offset + corner;
      center.x += position.getX(vertex) / 3;
      center.y += position.getY(vertex) / 3;
      center.z += position.getZ(vertex) / 3;
    }
    center.applyMatrix4(draw.matrix);
    const key = `${Math.floor(center.x / 18)},${Math.floor(center.y / 12)},${Math.floor(center.z / 18)}`;
    const indices = cells.get(key) ?? [];
    if (!indices.length) cells.set(key, indices);
    for (let corner = 0; corner < 3; corner++) indices.push(index ? index.getX(offset + corner) : offset + corner);
  }
  if (cells.size < 2) return [draw];
  return [...cells.values()].map((indices) => {
    const geometry = source.clone();
    geometry.setIndex(indices);
    return { ...draw, geometry, start: 0, count: indices.length };
  });
}

export function batchKatanaStaticMeshes(root: THREE.Group, idPrefix = "static"): KatanaStaticBatchStats {
  const stats = emptyStats();
  const sources = new Set<THREE.Mesh>();
  const bins = new Map<string, Bin[]>();
  const lightCandidates: LightCandidate[] = [];
  root.updateMatrixWorld(true);
  const inverseRoot = root.matrixWorld.clone().invert();

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.BatchedMesh).isBatchedMesh) return;
    if (!mesh.visible || !mesh.frustumCulled || mesh.userData.qaIgnore || typeof mesh.userData.kind !== "string") return;
    for (let parent = mesh.parent; parent && parent !== root; parent = parent.parent) {
      if (!parent.visible || parent.userData.qaIgnore) return;
    }
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (!position || Object.keys(geometry.morphAttributes).length) return;
    if ((mesh as THREE.InstancedMesh).instanceColor) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some((material) => (material as THREE.MeshStandardMaterial).wireframe)) return;

    const instanceCount = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
    const total = geometry.getIndex()?.count ?? position.count;
    const rangeStart = Math.max(0, geometry.drawRange.start);
    const rangeEnd = Math.min(total, geometry.drawRange.start + geometry.drawRange.count);
    const baseMatrix = inverseRoot.clone().multiply(mesh.matrixWorld);
    let meshAdded = false;

    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material?.visible) continue;
      const start = Math.max(rangeStart, group.start);
      const end = Math.min(rangeEnd, group.start + group.count);
      const count = end - start;
      if (!(count > 0) || !Number.isFinite(count)) continue;
      stats.sourceCalls++;
      stats.sourceTriangles += count / 3 * instanceCount;
      for (let instance = 0; instance < instanceCount; instance++) {
        const matrix = baseMatrix.clone();
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
          const instanceMatrix = new THREE.Matrix4();
          (mesh as THREE.InstancedMesh).getMatrixAt(instance, instanceMatrix);
          matrix.multiply(instanceMatrix);
        }
        const alias = material.userData.ktBatchAlias as string | undefined;
        const key = [alias ?? material.uuid, mesh.castShadow, mesh.receiveShadow, mesh.renderOrder].join("|");
        let matches = bins.get(key);
        if (!matches) bins.set(key, (matches = []));
        let bin = matches.find((candidate) => compatible(candidate.layout, geometry));
        if (!bin) {
          bin = {
            material,
            kind: mesh.userData.kind,
            district: typeof mesh.userData.district === "string" ? mesh.userData.district : "garden",
            castShadow: mesh.castShadow,
            receiveShadow: mesh.receiveShadow,
            renderOrder: mesh.renderOrder,
            layout: new Map(),
            draws: [],
          };
          matches.push(bin);
        }
        for (const [name, attribute] of Object.entries(geometry.attributes)) {
          if (!bin.layout.has(name)) bin.layout.set(name, attribute.itemSize);
        }
        const instanceDistricts = mesh.userData.ktInstanceDistricts as string[] | undefined;
        const district = instanceDistricts?.[instance] ?? (typeof mesh.userData.district === "string" ? mesh.userData.district : "garden");
        const sourceColor = (material as THREE.MeshStandardMaterial).color;
        const baseColor = (bin.material as THREE.MeshStandardMaterial).color;
        const tint = alias && sourceColor && baseColor ? new THREE.Color(
          sourceColor.r / Math.max(baseColor.r, 1e-8),
          sourceColor.g / Math.max(baseColor.g, 1e-8),
          sourceColor.b / Math.max(baseColor.b, 1e-8),
        ) : undefined;
        const draw = { geometry, material, matrix, district, tint, lod: mesh.userData.ktLodMode === "far" || (mesh.userData.ktLodMode === undefined && idPrefix === "far") ? "far" as const : "near" as const, start, count };
        const pieces = mesh.userData.kind === "shell" && !(mesh as THREE.InstancedMesh).isInstancedMesh ? spatialShellDraws(draw) : [draw];
        bin.draws.push(...pieces);
        stats.geometries += pieces.length;
        stats.triangles += count / 3;
        meshAdded = true;
      }
    }
    if (meshAdded) sources.add(mesh);
  });

  stats.sourceMeshes = sources.size;
  if (!sources.size) return emptyStats();
  for (const source of sources) {
    const candidates = source.userData.ktLightCandidates as LightCandidate[] | undefined;
    if (candidates) lightCandidates.push(...candidates);
  }

  const outputs: THREE.BatchedMesh[] = [];
  try {
    for (const matches of bins.values()) {
      for (const bin of matches) {
        const geometries: THREE.BufferGeometry[] = [];
        let batch: THREE.BatchedMesh | null = null;
        try {
          for (const draw of bin.draws) geometries.push(bakeDraw(draw, bin.layout));
          const vertexCount = geometries.reduce((sum, geometry) => sum + geometry.getAttribute("position").count, 0);
          const indexCount = bin.draws.reduce((sum, draw) => sum + draw.count, 0);
          batch = new THREE.BatchedMesh(geometries.length, vertexCount, indexCount, bin.material);
          const identity = new THREE.Matrix4();
          for (let index = 0; index < geometries.length; index++) {
            const geometryId = batch.addGeometry(geometries[index]!);
            const instanceId = batch.addInstance(geometryId);
            batch.setMatrixAt(instanceId, identity);
            const tint = bin.draws[index]!.tint;
            if (tint) batch.setColorAt(instanceId, tint);
          }
          batch.computeBoundingBox();
          batch.computeBoundingSphere();
          batch.perObjectFrustumCulled = true;
          batch.sortObjects = true;
          batch.castShadow = bin.castShadow;
          batch.receiveShadow = bin.receiveShadow;
          batch.renderOrder = bin.renderOrder;
          batch.name = `katana/${idPrefix}-${bin.kind}-${outputs.length}`;
          batch.userData.kind = bin.kind;
          batch.userData.district = bin.district;
          batch.userData.qaId = `${idPrefix}-${bin.kind}-${outputs.length}`;
          batch.userData.instances = bin.draws.length;
          batch.userData.triangles = bin.draws.reduce((sum, draw) => sum + draw.count / 3, 0);
          batch.userData.ktInstanceDistricts = bin.draws.map((draw) => draw.district);
          batch.userData.ktInstanceLevels = bin.draws.map((draw) => draw.lod);
          batch.matrixAutoUpdate = false;
          batch.updateMatrix();
          outputs.push(batch);
        } finally {
          for (const geometry of geometries) geometry.dispose();
          if (batch && !outputs.includes(batch)) batch.dispose();
        }
      }
    }
  } catch (error) {
    for (const output of outputs) output.dispose();
    console.warn("Katana static batching failed; original meshes retained", error);
    return { ...stats, batches: 0, geometries: 0, triangles: 0 };
  }

  for (const source of sources) source.removeFromParent();
  for (const output of outputs) root.add(output);
  if (lightCandidates.length) root.userData.ktLightCandidates = lightCandidates;
  stats.batches = outputs.length;
  root.userData.staticBatch = { ...stats };
  return stats;
}
