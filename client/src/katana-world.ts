import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { assetUrl, sameOriginManager } from "./asset-base";
import { activeMap } from "@shared/maps";
import { isWebGpuRenderer, type AnyRenderer } from "./gpu-backend";
import { isSoftwareGL } from "./textures";
import { specularAA } from "./specular-aa";
import type { WorldApi } from "./world";
import { createKatanaProp } from "./katana-props";
import { createKatanaDistrictLod, createKatanaPropLod } from "./katana-lod";
import { batchKatanaStaticMeshes } from "./katana-static-batch";
import { createKatanaShadowProxies } from "./katana-shadows";
import { KATANA_SPECS, katanaSpec, loadKatanaSets, makeKatanaMaterial, setKatanaTime } from "./katana-specs";
import {
  applyKatanaLightmap,
  buildKatanaSky,
  loadKatanaLightmaps,
  KATANA_BG_HEX,
  KATANA_FOG_DENSITY,
  KATANA_FOG_HEX,
  makeKatanaHemisphere,
  makeKatanaSun,
  type KatanaLightmap,
} from "./katana-sky";

export { KATANA_EXPOSURE } from "./katana-sky";

const A = (p: string) => assetUrl(`/assets/katana/${p}`);
const DISTRICTS = new Set(["terrain", "garden", "town", "shrine"]);

type Placement = {
  id: string;
  asset: string;
  pos: [number, number, number];
  yaw: number;
  scale?: number;
};

type PlacementFile = { placements?: Placement[] };

function districtOf(object: THREE.Object3D): string {
  for (let p: THREE.Object3D | null = object; p; p = p.parent) {
    const name = p.name.toLowerCase();
    if (DISTRICTS.has(name)) return name;
  }
  return "garden";
}

function districtAt(x: number, z: number): string {
  if (z < -24) return "shrine";
  if (z > 20) return "town";
  return "garden";
}

type AtlasCell = { offset: [number, number]; scale: [number, number]; giScale: number };
type LightmapAtlas = { lightmap: KatanaLightmap; cells: Record<string, AtlasCell>; neutral: AtlasCell };

function createLightmapAtlas(lightmaps: Record<string, KatanaLightmap>): LightmapAtlas | null {
  const districts = ["garden", "shrine", "terrain", "town"] as const;
  try {
    const entries = districts.map((district) => {
      const lightmap = lightmaps[district];
      const ao = lightmap?.ao?.image as { width?: number; height?: number } | undefined;
      const gi = lightmap?.gi?.image as { width?: number; height?: number } | undefined;
      if (!lightmap?.ao || !lightmap.gi || !ao?.width || !ao?.height || !gi?.width || !gi?.height) return null;
      return {
        district,
        lightmap,
        ao: { image: lightmap.ao.image, width: ao.width, height: ao.height },
        gi: { image: lightmap.gi.image, width: gi.width, height: gi.height },
      };
    });
    if (entries.some((entry) => !entry)) return null;
    const valid = entries as NonNullable<(typeof entries)[number]>[];
    const padding = 8;
    const tileWidth = Math.max(...valid.flatMap((entry) => [entry.ao.width, entry.gi.width]));
    const tileHeight = Math.max(...valid.flatMap((entry) => [entry.ao.height, entry.gi.height]));
    const strideX = tileWidth + padding * 2;
    const strideY = tileHeight + padding * 2;
    const width = strideX * 2;
    const height = strideY * 3;
    const cells: Record<string, AtlasCell> = {};
    const makeTexture = (kind: "ao" | "gi"): THREE.CanvasTexture | null => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      valid.forEach((entry, index) => {
        const tileX = (index % 2) * strideX;
        const tileY = Math.floor(index / 2) * strideY;
        const x = tileX + padding;
        const y = tileY + padding;
        const { image, width: sourceWidth, height: sourceHeight } = entry[kind];
        context.drawImage(image, 0, 0, sourceWidth, sourceHeight, x, y, tileWidth, tileHeight);
        context.drawImage(image, 0, 0, sourceWidth, 1, x, y - padding, tileWidth, padding);
        context.drawImage(image, 0, sourceHeight - 1, sourceWidth, 1, x, y + tileHeight, tileWidth, padding);
        context.drawImage(image, 0, 0, 1, sourceHeight, x - padding, y, padding, tileHeight);
        context.drawImage(image, sourceWidth - 1, 0, 1, sourceHeight, x + tileWidth, y, padding, tileHeight);
        context.drawImage(image, 0, 0, 1, 1, x - padding, y - padding, padding, padding);
        context.drawImage(image, sourceWidth - 1, 0, 1, 1, x + tileWidth, y - padding, padding, padding);
        context.drawImage(image, 0, sourceHeight - 1, 1, 1, x - padding, y + tileHeight, padding, padding);
        context.drawImage(image, sourceWidth - 1, sourceHeight - 1, 1, 1, x + tileWidth, y + tileHeight, padding, padding);
        if (kind === "ao") {
          cells[entry.district] = {
            offset: [x / width, y / height],
            scale: [tileWidth / width, tileHeight / height],
            giScale: entry.lightmap.giScale,
          };
        }
      });
      context.fillStyle = kind === "ao" ? "#ffffff" : "#000000";
      context.fillRect(0, strideY * 2, strideX, strideY);
      const texture = new THREE.CanvasTexture(canvas);
      texture.channel = 1;
      texture.flipY = false;
      if (kind === "gi") texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const ao = makeTexture("ao");
    const gi = makeTexture("gi");
    if (!ao || !gi) {
      ao?.dispose();
      gi?.dispose();
      return null;
    }
    const neutral: AtlasCell = {
      offset: [padding / width, (strideY * 2 + padding) / height],
      scale: [tileWidth / width, tileHeight / height],
      giScale: 0,
    };
    return { lightmap: { ao, gi, giScale: 1 }, cells, neutral };
  } catch {
    return null;
  }
}

function remapLightmapGeometry(source: THREE.BufferGeometry, cell: AtlasCell): THREE.BufferGeometry {
  const geometry = source.clone();
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv1");
  const values = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    values[index * 2] = cell.offset[0] + (uv ? uv.getX(index) : 0) * cell.scale[0];
    values[index * 2 + 1] = cell.offset[1] + (uv ? uv.getY(index) : 0) * cell.scale[1];
  }
  geometry.setAttribute("uv1", new THREE.BufferAttribute(values, 2));
  geometry.setAttribute("ktLightmapScale", new THREE.BufferAttribute(new Float32Array(position.count).fill(cell.giScale), 1));
  return geometry;
}

function mergeKatanaShadowProxies(group: THREE.Group): void {
  const meshes: THREE.Mesh[] = [];
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  if (meshes.length < 2) return;
  group.updateMatrixWorld(true);
  const geometries = meshes.map((mesh) => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
  const geometry = mergeGeometries(geometries, false);
  for (const item of geometries) item.dispose();
  if (!geometry) return;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const first = meshes[0]!;
  const merged = new THREE.Mesh(geometry, first.material);
  merged.name = "katana/shadow-merged";
  merged.castShadow = first.castShadow;
  merged.receiveShadow = first.receiveShadow;
  merged.layers.mask = first.layers.mask;
  merged.userData = { ...first.userData };
  group.clear();
  group.add(merged);
  group.userData.drawCalls = 1;
  group.userData.triangles = (geometry.getIndex()?.count ?? geometry.getAttribute("position").count) / 3;
  for (const mesh of meshes) mesh.geometry.dispose();
}

function applyAtlasLightmapScale(material: THREE.MeshStandardMaterial): void {
  // r187-verified (Nov 2026, against vendored three.module.js): every anchor
  // below is stable. The #include names exist, and the ShaderChunk substrings
  // ("lightMapTexel.rgb * lightMapIntensity", the aoMap sample,
  // "aoMapIntensity") are unchanged. The "irradiance = vec3( 0.0 );" /
  // "iblIrradiance = vec3( 0.0 );" / "radiance *= ktSkyVisibility;" targets are
  // Katana's OWN lines injected by applyKatanaLightmap (which always runs first
  // via previous.call), not three chunk text — no upstream chunk rename or
  // move (e.g. into lights_fragment_begin) can silently break them. No
  // r170-era workaround in this chain (cf. depth-precision.ts): nothing to
  // remove or modernise.
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float ktLightmapScale;\nvarying float vKtLightmapScale;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvKtLightmapScale = ktLightmapScale;");
    const lightmapChunk = THREE.ShaderChunk.lights_fragment_maps.replace(
      "lightMapTexel.rgb * lightMapIntensity",
      "lightMapTexel.rgb * lightMapIntensity * vKtLightmapScale",
    );
    const aoChunk = `
      float ktAoSample = 1.0;
      if ( vKtLightmapScale > 0.001 ) ktAoSample = texture2D( aoMap, vAoMapUv ).r;
      #ifdef USE_ROUGHNESSMAP
        else ktAoSample = texture2D( roughnessMap, vRoughnessMapUv ).r;
      #endif
    ` + THREE.ShaderChunk.aomap_fragment
      .replace("texture2D( aoMap, vAoMapUv ).r", "ktAoSample")
      .replace("aoMapIntensity", "mix( 0.72, aoMapIntensity, step( 0.001, vKtLightmapScale ) )");
    const baked = "step( 0.001, vKtLightmapScale )";
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vKtLightmapScale;")
      .replace("#include <lights_fragment_maps>", lightmapChunk)
      .replace("#include <aomap_fragment>", aoChunk)
      .replace("irradiance = vec3( 0.0 );", `irradiance = mix( irradiance, vec3( 0.0 ), ${baked} );`)
      .replace("iblIrradiance = vec3( 0.0 );", `iblIrradiance = mix( iblIrradiance, vec3( 0.0 ), ${baked} );`)
      .replace("radiance *= ktSkyVisibility;", `radiance *= mix( 1.0, ktSkyVisibility, ${baked} );`)
      .replace("clearcoatRadiance *= ktSkyVisibility;", `clearcoatRadiance *= mix( 1.0, ktSkyVisibility, ${baked} );`);
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|kt-lightmap-atlas1`;
  material.needsUpdate = true;
}

export async function buildKatanaWorld(renderer: AnyRenderer): Promise<WorldApi> {
  // WebGPU: the authored path below is WebGL-only (GLSL sky, onBeforeCompile
  // patches, PMREM) — fall back to a flat background + the same fog and key
  // light, so the map stays playable. game.ts keeps the neutral basis
  // exposure (1.12) on this path; the WebGL path is the authored look.
  // DELIBERATE (r187 review, Nov 2026): no TSL port this round, unlike
  // ares-world.ts (`useTsl()` + tsl-materials.ts). A Katana port would have to
  // cover the gradient/cloud sky, the mountain canopy patch, the height mist,
  // the wood deck/soffit blend, the wet/puddle/paper surface patch, the
  // baked-fill + atlas-scale lightmap gating and the drizzle points — all of
  // it onBeforeCompile/ShaderMaterial work with no node mapping. The flat
  // fallback stays until that port lands.
  if (isWebGpuRenderer(renderer)) return buildKatanaWebGpuFallback(renderer);
  const gl = renderer as THREE.WebGLRenderer;
  const low = isSoftwareGL(renderer);
  const scene = new THREE.Scene();
  scene.name = "KATANA";
  const root = new THREE.Group();
  root.name = "katana/root";
  scene.add(root);

  const loader = new GLTFLoader(sameOriginManager());
  loader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, lowGltf, placementFile, sets, nightEnvironment, lightmaps, shadows] = await Promise.all([
    loader.loadAsync(A("katana.glb")),
    loader.loadAsync(A("katana-low.glb")).catch((error) => {
      console.warn("[katana] far shell unavailable; using full-detail fallback", error);
      return null;
    }),
    fetch(A("placements.json")).then((r) => (r.ok ? r.json() as Promise<PlacementFile> : null)).catch(() => null),
    loadKatanaSets(gl, low),
    new RGBELoader(sameOriginManager()).loadAsync(A("sky/qwantani_night_puresky_1k.hdr")).catch(() => null),
    loadKatanaLightmaps(low),
    createKatanaShadowProxies(A),
  ]);
  if (shadows.userData.error) {
    console.warn("[katana] shadow proxies unavailable; continuing without them", shadows.userData.error);
  }

  const lightmapAtlas = createLightmapAtlas(lightmaps);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const materialFor = (rawName: string, lightmapKey = "prop"): THREE.MeshStandardMaterial => {
    const twoSided = rawName.endsWith("__2s");
    const name = (twoSided ? rawName.slice(0, -4) : rawName).replace(/\.\d+$/, "") || "kt_default";
    const spec = katanaSpec(name);
    const useAtlas = !!lightmapAtlas && !spec.water;
    const lightmap = useAtlas ? lightmapAtlas.lightmap : lightmaps[lightmapKey];
    const hasLightmap = !spec.water && !!(lightmap?.ao || lightmap?.gi);
    const key = [useAtlas && hasLightmap ? "atlas" : hasLightmap ? lightmapKey : "none", JSON.stringify(spec), twoSided, name.endsWith("_decal")].join("|");
    let material = materials.get(key);
    if (!material) {
      material = makeKatanaMaterial(name, sets);
      if (spec === KATANA_SPECS.kt_koi || spec === KATANA_SPECS.kt_koi_red) material.userData.ktBatchAlias = "koi";
      if (twoSided) material.side = THREE.DoubleSide;
      applyKatanaLightmap(material, lightmap);
      if (useAtlas && hasLightmap) applyAtlasLightmapScale(material);
      materials.set(key, material);
    }
    return material;
  };

  const prepareMesh = (mesh: THREE.Mesh, district: string, propsOnly = false): void => {
    const original = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = original.map((material) => {
      if (!propsOnly || material.name.startsWith("kt_")) return materialFor(material.name || "kt_default", propsOnly ? "prop" : district);
      if (material instanceof THREE.MeshStandardMaterial) specularAA(material);
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
    const water = next.some((material) => !!material.userData.ktWater);
    for (const material of next) {
      if (material.alphaTest > 0 && !material.transparent) material.alphaToCoverage = true;
    }
    if (!water && lightmapAtlas) {
      const cell = propsOnly ? lightmapAtlas.neutral : lightmapAtlas.cells[district];
      if (cell) mesh.geometry = remapLightmapGeometry(mesh.geometry, cell);
    }
    mesh.castShadow = district !== "terrain" && !water;
    mesh.receiveShadow = !water;
    mesh.userData.kind = district === "terrain" ? "floor" : propsOnly ? "prop" : "shell";
    mesh.userData.district = district;
    if (water) mesh.renderOrder = 6;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  };

  const prepareMap = (map: THREE.Object3D, name: string): THREE.Object3D => {
    map.name = name;
    map.traverse((object) => {
      if ((object as THREE.Light).isLight) object.visible = false;
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const district = districtOf(mesh);
      prepareMesh(mesh, district);
      mesh.userData.qaId = `${name}-${district}-${mesh.id}`;
    });
    return map;
  };
  const near = new THREE.Group();
  const far = new THREE.Group();
  near.name = "katana/lod-near";
  far.name = "katana/lod-far";
  near.add(prepareMap(gltf.scene, "katana/districts-near"));
  let farShell: THREE.Object3D = lowGltf?.scene ?? gltf.scene.clone(true);
  let shellSimplified = false;
  if (lowGltf) {
    try {
      farShell = await createKatanaPropLod(lowGltf.scene, { error: 0.03 });
      shellSimplified = true;
    } catch (error) {
      console.warn("[katana] additional far-shell simplification failed; using the authored low GLB", error);
    }
  }
  far.add(prepareMap(farShell, "katana/districts-far"));
  mergeKatanaShadowProxies(shadows);
  root.add(shadows);

  const placements = placementFile?.placements ?? [];
  const cache = new Map<string, Promise<THREE.Object3D | null>>();
  const getProp = (asset: string) => {
    let pending = cache.get(asset);
    if (!pending) {
      pending = Promise.resolve(createKatanaProp(asset)).then((prop) => prop ?? null).catch(() => null);
      cache.set(asset, pending);
    }
    return pending;
  };
  const valid = placements.map((placement, index) => ({ placement, index })).filter(({ placement }) =>
    !!placement.asset && Array.isArray(placement.pos) && placement.pos.length === 3 && placement.pos.every(Number.isFinite));
  const templates = await Promise.all(valid.map(({ placement }) => getProp(placement.asset)));
  const lowCache = new Map<string, Promise<THREE.Object3D | null>>();
  const lowTemplates = await Promise.all(valid.map(({ placement }, index) => {
    const template = templates[index];
    if (!template) return Promise.resolve(null);
    let pending = lowCache.get(placement.asset);
    if (!pending) {
      pending = createKatanaPropLod(template).catch((error) => {
        console.warn(`[katana] far prop ${placement.asset} unavailable; using full-detail fallback`, error);
        const fallback = template.clone(true);
        fallback.userData.ktPropLodFallback = true;
        return fallback;
      });
      lowCache.set(placement.asset, pending);
    }
    return pending;
  }));

  type PropItem = { matrix: THREE.Matrix4; district: string; order: string };
  type PropGroup = { template: THREE.Object3D; items: PropItem[] };
  type PropBatch = {
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
    entries: PropItem[];
    lantern: boolean;
  };
  const buildPropLevel = (level: THREE.Group, sources: (THREE.Object3D | null)[], idPrefix: string): number => {
    const groups = new Map<string, PropGroup>();
    let placedCount = 0;
    for (let i = 0; i < valid.length; i++) {
      const template = sources[i];
      if (!template) continue;
      const { placement, index } = valid[i]!;
      const scale = Number.isFinite(placement.scale) && placement.scale! > 0 ? placement.scale! : 1;
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(...placement.pos),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(Number.isFinite(placement.yaw) ? placement.yaw : 0)),
        new THREE.Vector3(scale, scale, scale),
      );
      const item = {
        matrix,
        district: districtAt(placement.pos[0], placement.pos[2]),
        order: `prop-${placement.id || placement.asset || index}`,
      };
      let group = groups.get(placement.asset);
      if (!group) {
        group = { template, items: [] };
        groups.set(placement.asset, group);
      }
      group.items.push(item);
      placedCount++;
    }

    const batches = new Map<string, PropBatch>();
    for (const group of groups.values()) {
      group.template.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) prepareMesh(mesh, "garden", true);
      });
      group.template.updateMatrixWorld(true);
      group.template.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material;
        const list = Array.isArray(material) ? material : [material];
        const key = `${mesh.geometry.uuid}|${list.map((entry) => entry.uuid).join(",")}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = { geometry: mesh.geometry, material, entries: [], lantern: list.some((entry) => !!entry.userData.ktLantern) };
          batches.set(key, batch);
        }
        if (batch.lantern && !mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const add = (matrix: THREE.Matrix4, item: PropItem) => batch!.entries.push({ matrix, district: item.district, order: item.order });
        for (const item of group.items) {
          const base = item.matrix.clone().multiply(mesh.matrixWorld);
          if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
            const source = mesh as THREE.InstancedMesh;
            for (let index = 0; index < source.count; index++) {
              const instance = new THREE.Matrix4();
              source.getMatrixAt(index, instance);
              add(base.clone().multiply(instance), item);
            }
          } else {
            add(base, item);
          }
        }
      });
    }

    let batchIndex = 0;
    for (const batch of batches.values()) {
      const instances = new THREE.InstancedMesh(batch.geometry, batch.material, batch.entries.length);
      instances.name = `katana/${idPrefix}-props-${batchIndex}`;
      instances.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const lightCandidates: { position: THREE.Vector3; district: string; order: string }[] = [];
      for (let index = 0; index < batch.entries.length; index++) {
        const entry = batch.entries[index]!;
        instances.setMatrixAt(index, entry.matrix);
        if (batch.lantern) {
          const sourceCenter = batch.geometry.boundingBox!.getCenter(new THREE.Vector3());
          lightCandidates.push({ position: sourceCenter.applyMatrix4(entry.matrix), district: entry.district, order: entry.order });
        }
      }
      instances.instanceMatrix.needsUpdate = true;
      instances.computeBoundingBox();
      instances.computeBoundingSphere();
      const list = Array.isArray(batch.material) ? batch.material : [batch.material];
      const water = list.some((material) => !!material.userData.ktWater);
      instances.castShadow = !water;
      instances.receiveShadow = !water;
      instances.userData.kind = "prop";
      instances.userData.district = "garden";
      instances.userData.qaId = `${idPrefix}-props-${batchIndex}`;
      instances.userData.instances = batch.entries.length;
      instances.userData.ktInstanceDistricts = batch.entries.map((entry) => entry.district);
      if (lightCandidates.length) instances.userData.ktLightCandidates = lightCandidates;
      if (water) instances.renderOrder = 6;
      instances.matrixAutoUpdate = false;
      instances.updateMatrix();
      level.add(instances);
      batchIndex++;
    }
    return placedCount;
  };
  const placedCount = buildPropLevel(near, templates, "near");
  buildPropLevel(far, lowTemplates, "far");
  near.updateMatrixWorld(true);
  far.updateMatrixWorld(true);
  const sourceStats = (level: THREE.Group) => {
    let sourceMeshes = 0, sourceCalls = 0, sourceTriangles = 0;
    level.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      sourceMeshes++;
      const groups = Array.isArray(mesh.material) ? mesh.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
      const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
      const total = mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute("position").count;
      for (const group of groups) {
        sourceCalls++;
        sourceTriangles += Math.min(total, group.count) / 3 * instances;
      }
    });
    return { sourceMeshes, sourceCalls, sourceTriangles };
  };
  const nearStats = sourceStats(near);
  const farStats = sourceStats(far);
  root.add(near, far);
  near.traverse((object) => { object.userData.ktLodMode = "near"; });
  far.traverse((object) => { object.userData.ktLodMode = "far"; });
  const combined = batchKatanaStaticMeshes(root, "static");
  const lod = createKatanaDistrictLod(root, near, far);
  root.userData.placements = placedCount;
  root.userData.lodInventory = {
    near: nearStats,
    far: farStats,
    combined,
    shellFar: lowGltf ? shellSimplified ? "katana-low.glb+meshopt-error-0.03m" : "katana-low.glb" : "full-fallback",
    propFar: lowTemplates.some((template) => template?.userData.ktPropLodFallback) ? "partial-full-fallback" : "meshopt-ratio-0.30-error-0.05m",
  };
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && !object.userData.qaIgnore) object.layers.set(0);
  });
  const rig = buildKatanaSky(scene, gl, low, nightEnvironment);
  rig.sun.shadow.camera.layers.set(1);
  const shaded = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (shaded.has(material)) continue;
      shaded.add(material);
      rig.atmosphere(material);
    }
  });

  const candidates: { position: THREE.Vector3; district: string; order: string }[] = [];
  if (root.userData.ktLightCandidates) {
    candidates.push(...root.userData.ktLightCandidates as { position: THREE.Vector3; district: string; order: string }[]);
  }
  near.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    if (mesh.userData.ktLightCandidates) {
      candidates.push(...mesh.userData.ktLightCandidates as { position: THREE.Vector3; district: string; order: string }[]);
      return;
    }
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!list.some((material) => material.userData.ktLantern)) return;
    const position = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    if (!Number.isFinite(position.x + position.y + position.z)) return;
    candidates.push({ position, district: mesh.userData.district ?? districtAt(position.x, position.z), order: object.userData.qaId ?? object.name });
  });
  candidates.sort((a, b) => a.order.localeCompare(b.order) || a.position.x - b.position.x || a.position.z - b.position.z);
  const chosen: typeof candidates = [];
  const pools = ["shrine", "garden", "town"].map((district) => candidates.filter((candidate) => candidate.district === district));
  for (let index = 0; chosen.length < 8; index++) {
    let remaining = false;
    for (const pool of pools) {
      const candidate = pool[index];
      if (!candidate) continue;
      remaining = true;
      if (chosen.some((other) => other.position.distanceToSquared(candidate.position) < 30)) continue;
      chosen.push(candidate);
      if (chosen.length === 8) break;
    }
    if (!remaining) break;
  }
  for (const candidate of chosen.slice(0, 8)) {
    const light = new THREE.PointLight(0xe8141f, 11, 9.5, 2);
    light.name = "katana/lantern-accent";
    light.position.copy(candidate.position);
    light.castShadow = false;
    scene.add(light);
  }

  let clock = 0;
  return {
    scene,
    sun: rig.sun,
    root,
    update: (dt, cam) => {
      const step = Math.max(0, Math.min(dt, 0.1));
      clock += step;
      setKatanaTime(clock);
      lod.update(cam);
      rig.update(step, cam);
    },
  };
}

/** Palette bin for a collider visual tag (shrine cedar + stone + vermilion). */
function binColor(tag: string | undefined): number {
  const t = (tag ?? "").toLowerCase();
  if (/torii|vermilion|red/.test(t)) return 0xa83226;
  if (/shoji|paper|plaster|white/.test(t)) return 0xe6dcc4;
  if (/cedar|wood|beam|joinery|lattice|deck|porch|eaves|plank|door/.test(t)) return 0x6b4a2e;
  if (/railing|rail|darkwood/.test(t)) return 0x453322;
  if (/roof|tile|thatch/.test(t)) return 0x33383f;
  if (/stone|rock|plinth|lantern|parapet|masonry|step/.test(t)) return 0x8d8d88;
  if (/dfloor|dstair/.test(t)) return 0x99917e;
  if (/metal|steel|iron|pipe|tank/.test(t)) return 0x5a6068;
  if (/moss|grass|hedge|bush|tree|trunk/.test(t)) return 0x44583a;
  if (/water|pond/.test(t)) return 0x2e4a56;
  return 0x77716a;
}

/**
 * WebGPU fallback (kept from the previous hand-written builder): no GLSL sky
 * — the shipped colliders drawn directly (one merged mesh per palette bin)
 * under a flat background + the same fog and key light as the WebGL rig, so
 * the map stays playable. The WebGL path above is the authored look.
 */
async function buildKatanaWebGpuFallback(renderer: AnyRenderer): Promise<WorldApi> {
  const MAP = activeMap();
  const scene = new THREE.Scene();
  const low = isSoftwareGL(renderer);

  // ---- solids: one merged mesh per palette bin ---------------------------
  const bins = new Map<number, THREE.BufferGeometry[]>();
  const scratch = new THREE.Object3D();
  for (const o of MAP.solids) {
    const color = binColor(o.visual);
    let list = bins.get(color);
    if (!list) bins.set(color, (list = []));
    const g = new THREE.BoxGeometry(Math.max(o.sx, 0.01), Math.max(o.sy, 0.01), Math.max(o.sz, 0.01));
    scratch.position.set(o.x, o.y, o.z);
    scratch.rotation.set(0, o.yaw, 0);
    scratch.updateMatrix();
    g.applyMatrix4(scratch.matrix);
    list.push(g);
  }
  for (const [color, geos] of bins) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02 });
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
    mesh.name = "katana/solids";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    for (const g of geos) g.dispose();
  }

  // ---- ground plane at the map floor --------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP.bounds.maxX - MAP.bounds.minX + 80, MAP.bounds.maxZ - MAP.bounds.minZ + 80),
    new THREE.MeshStandardMaterial({ color: 0x4a4234, roughness: 1, metalness: 0 }),
  );
  ground.name = "katana/ground";
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(
    (MAP.bounds.minX + MAP.bounds.maxX) / 2,
    MAP.floorY - 0.02,
    (MAP.bounds.minZ + MAP.bounds.maxZ) / 2,
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- flat background + the same fog and key light ------------------------
  scene.background = new THREE.Color(KATANA_BG_HEX);
  scene.fog = new THREE.FogExp2(new THREE.Color(KATANA_FOG_HEX), KATANA_FOG_DENSITY);
  const sun = makeKatanaSun(low);
  sun.shadow.camera.layers.set(1);
  scene.add(sun, sun.target);
  scene.add(makeKatanaHemisphere(low));

  // Contract parity with the WebGL path: callers expect a `root` group.
  const root = new THREE.Group();
  root.name = "katana/root";
  scene.add(root);

  return {
    scene,
    sun,
    root,
    update: () => undefined,
  };
}
