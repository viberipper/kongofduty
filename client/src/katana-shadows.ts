import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { assetUrl } from "./asset-base";

export type KatanaShadowAssetBase = string | ((path: string) => string);

export type KatanaShadowProxyOptions = {
  shadowUrl?: string;
  mapUrl?: string;
  fetchFn?: typeof fetch;
  onError?: (error: unknown) => void;
};

type Collider = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw?: number;
  climb?: boolean;
  visual?: string;
  kind?: string;
};

type ShadowColliderFile = { solids?: Collider[]; colliders?: Collider[] };
type GeometryEntry = { quadrant: string; geometry: THREE.BufferGeometry };

const EXCLUDE = /boundary|railing|stair_guard|water|trim|joinery|lattice|grate|gutter|aqueduct-(?:rib|corb)|screen-stile|riverbed|stone_plinth|bridge-(?:baluster|newel)|sconce|sign_beam/i;
const LAYER_CONTRACT = Object.freeze({ detailedColor: 0, proxyOnly: 1, actorsThatCast: [0, 1], shadowCameraEnable: 1 });

function resolveAsset(base: KatanaShadowAssetBase, file: string): string {
  if (typeof base === "function") return base(file);
  if (!base) return file;
  return `${base.endsWith("/") ? base : `${base}/`}${file}`;
}

function quadrant(x: number, z: number): string {
  return `${z >= 0 ? "s" : "n"}${x >= 0 ? "e" : "w"}`;
}

function selectedColliders(colliders: Collider[]): Collider[] {
  return colliders.filter((box) => {
    const values = [box.x, box.y, box.z, box.sx, box.sy, box.sz];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return false;
    if (box.sx <= 0 || box.sy < 0.35 || box.sz <= 0) return false;
    if (box.kind === "trigger" || EXCLUDE.test(box.visual ?? "")) return false;
    return box.yaw === undefined || (typeof box.yaw === "number" && Number.isFinite(box.yaw));
  });
}

function depthOnly(source: THREE.BufferGeometry, transform?: THREE.Matrix4): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  if (transform) geometry.applyMatrix4(transform);
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== "position") geometry.deleteAttribute(name);
  }
  return geometry;
}

function emptyGroup(source: string): THREE.Group {
  const group = new THREE.Group();
  group.name = "katana/shadow-proxies";
  group.layers.set(1);
  group.userData = {
    qaIgnore: true,
    kind: "shadowProxy",
    selectable: false,
    shadowSource: source,
    drawCalls: 0,
    triangles: 0,
    layerContract: LAYER_CONTRACT,
  };
  return group;
}

function groupFromGeometry(entries: GeometryEntry[], source: string): THREE.Group {
  const group = emptyGroup(source);
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.FrontSide });
  material.name = "katana/shadow-depth";
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  for (const entry of entries) {
    const list = buckets.get(entry.quadrant) ?? [];
    list.push(entry.geometry);
    buckets.set(entry.quadrant, list);
  }
  let triangles = 0;
  for (const [name, geometries] of buckets) {
    const geometry = geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries, false);
    if (!geometry) {
      console.warn(`[katana] could not merge Katana shadow quadrant ${name}; skipping`);
      continue;
    }
    if (geometries.length > 1) for (const item of geometries) item.dispose();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `katana/shadow-${name}`;
    mesh.layers.set(1);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.userData = {
      qaIgnore: true,
      kind: "shadowProxy",
      selectable: false,
      colorLayer: 0,
      shadowLayer: 1,
    };
    group.add(mesh);
    triangles += (geometry.getAttribute("position")?.count ?? 0) / 3;
  }
  if (group.children.length > 6) {
    console.warn(`[katana] Katana shadow proxy has ${group.children.length} draw calls; returning empty group`);
    for (const child of group.children) (child as THREE.Mesh).geometry?.dispose();
    material.dispose();
    return emptyGroup(source);
  }
  group.userData.drawCalls = group.children.length;
  group.userData.triangles = triangles;
  return group;
}

function groupFromGLTF(scene: THREE.Object3D): THREE.Group {
  scene.updateMatrixWorld(true);
  const entries: GeometryEntry[] = [];
  const oldGeometry = new Set<THREE.BufferGeometry>();
  const oldMaterials = new Set<THREE.Material>();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = depthOnly(mesh.geometry, mesh.matrixWorld);
    geometry.computeBoundingBox();
    const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
    entries.push({ quadrant: quadrant(center.x, center.z), geometry });
    oldGeometry.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) oldMaterials.add(material);
  });
  for (const geometry of oldGeometry) geometry.dispose();
  for (const material of oldMaterials) material.dispose();
  return groupFromGeometry(entries, "katana-shadow.glb");
}

export function buildKatanaShadowProxiesFromColliders(colliders: Collider[]): THREE.Group {
  const entries: GeometryEntry[] = [];
  for (const box of selectedColliders(colliders)) {
    const transform = new THREE.Matrix4().makeRotationY(-(box.yaw ?? 0));
    transform.setPosition(box.x, box.y, box.z);
    const source = new THREE.BoxGeometry(box.sx, box.sy, box.sz);
    entries.push({ quadrant: quadrant(box.x, box.z), geometry: depthOnly(source, transform) });
    source.dispose();
  }
  return groupFromGeometry(entries, "colliders-fallback");
}

/**
 * Loads four merged static occluders on shadow-only layer 1. A confirmed 404/410
 * falls back to the same boxes from katana.json; malformed assets or network
 * errors return an empty group instead of preventing world boot.
 *
 * Integration contract: detailed static meshes use layers.set(0), actors that
 * cast enable layers 0 and 1, and the shadow camera disables layer 0 and
 * enables layer 1 (or simply uses layers.set(1)).
 */
export async function createKatanaShadowProxies(
  assetBase: KatanaShadowAssetBase = "/assets/katana/",
  options: KatanaShadowProxyOptions = {},
): Promise<THREE.Group> {
  const shadowUrl = options.shadowUrl ?? resolveAsset(assetBase, "katana-shadow.glb");
  // Explicit map URL (never derived via "../" from the katana asset base —
  // the function-form base would otherwise emit "/assets/katana/../maps/...").
  const mapUrl = options.mapUrl ?? assetUrl("/assets/maps/katana.json");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const onError = options.onError ?? ((error: unknown) => console.warn("[katana] shadow proxies unavailable", error));
  try {
    const response = await fetchFn(shadowUrl);
    if (response.status === 404 || response.status === 410) {
      const fallback = await fetchFn(mapUrl);
      if (!fallback.ok) throw new Error(`shadow collider fallback HTTP ${fallback.status}: ${mapUrl}`);
      const data = await fallback.json() as ShadowColliderFile;
      return buildKatanaShadowProxiesFromColliders(data.solids ?? data.colliders ?? []);
    }
    if (!response.ok) throw new Error(`shadow GLB HTTP ${response.status}: ${shadowUrl}`);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(await response.arrayBuffer(), resolveAsset(assetBase, ""));
    return groupFromGLTF(gltf.scene);
  } catch (error) {
    onError(error);
    const group = emptyGroup("unavailable");
    group.userData.error = error instanceof Error ? error.message : String(error);
    return group;
  }
}
