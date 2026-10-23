import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { AnyRenderer } from "./gpu-backend";
import { assetUrl } from "./asset-base";
import { isSoftwareGL } from "./textures";
import type { WorldApi } from "./world";
import { BACKDROP_SETS } from "./nuketown-backdrop";
import { buildNuketownFoliage } from "./nuketown-foliage";
import { applyLightmap, buildSkyRig, loadLightmaps, type LightmapsFile } from "./nuketown-sky";
import { SPECS, loadSets, makeMaterial, type Manifest } from "./nuketown-specs";

export { NUKETOWN_SUN_DIR } from "./nuketown-sky";

/**
 * NUKETOWN — "hazy Nevada afternoon, 1950s doom town": the world LOADER.
 *
 * FROZEN (orchestrator) since WO-0. What changes lives in the owned modules:
 *  - nuketown-specs.ts (MAT): every `nt_*` material -> CC0 PBR set (SPECS,
 *    aliases), the paint-mask / macro shader patch, makeMaterial;
 *  - nuketown-sky.ts (LIGHT): sun, exposure target, sky, haze, light rig,
 *    baked AO / GI lightmaps;
 *  - nuketown-backdrop.ts (LIGHT): the desert floor, road out, mesas;
 *  - nuketown-foliage.ts (GROUND): grass and plantings (a no-op stub today).
 *
 * Geometry: static/assets/nuketown/nuketown.glb, built offline from the
 * SketchUp source by scripts/nuketown/build.sh (houses rebuilt with real
 * interiors, every face carrying an `nt_*` material name and world-metre UV0).
 * This file loads it, gives every mesh its material (+ lightmaps), and places
 * the hero props (static/assets/nuketown/placements.json: one entry per prop
 * GLB, optional `replaces` hides the SketchUp stand-in) with their runtime
 * hooks (swing seats, clock sweep hand).
 *
 * Zero-flicker rules this file keeps: every material is single-sided (no two
 * coplanar faces can both face the camera), glass never writes depth, decals
 * (`_decal` names) take polygonOffset, and the backdrop sits >= 10 cm under
 * anything walkable.
 */

const A = (p: string) => assetUrl(`/assets/nuketown/${p}`);

// ------------------------------------------------------------------ build
type Placement = { id?: string; asset: string; pos: number[]; yaw: number; scale?: number; replaces?: string };

export async function buildNuketownWorld(renderer: AnyRenderer): Promise<WorldApi> {
  const soft = isSoftwareGL(renderer);
  const scene = new THREE.Scene();
  scene.name = "NUKETOWN";
  const gltfLoader = new GLTFLoader();
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  const json = (p: string) => fetch(A(p)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [gltf, manifest, placementsFile, lightmaps] = await Promise.all([
    gltfLoader.loadAsync(A("nuketown.glb")),
    json("tex/manifest.json") as Promise<Manifest | null>,
    json("placements.json") as Promise<{ placements?: Placement[]; hiddenStandins?: string[] } | null>,
    json("lightmaps.json") as Promise<LightmapsFile | null>,
  ]);
  const used = new Set<string>(BACKDROP_SETS);
  for (const s of Object.values(SPECS)) if (s.set) used.add(s.set);
  const sets = await loadSets(used, manifest ?? {}, renderer, soft);

  // ---------------------------------------------------------- lightmaps (optional)
  const lm = await loadLightmaps(lightmaps, soft);

  // ---------------------------------------------------------- materials
  const base = new Map<string, THREE.Material>();
  const matFor = (rawName: string, obj: string): THREE.Material => {
    const key = `${obj}|${rawName}`;
    let m = base.get(key);
    if (m) return m;
    // `__2s`: a two-sided SketchUp surface on thin geometry (lattice, fence
    // boards, signs, gables) — one surface rendered DoubleSide, never a pair
    const twoSided = rawName.endsWith("__2s");
    const name = twoSided ? rawName.slice(0, -4) : rawName.replace(/\.\d+$/, "");
    const spec = SPECS[name] ?? SPECS.nt_default!;
    m = makeMaterial(name, spec, sets);
    if (twoSided) m.side = THREE.DoubleSide;
    applyLightmap(m, lm[obj], !!spec.glass);
    base.set(key, m);
    return m;
  };

  const root = new THREE.Group();
  root.name = "nuketown/root";
  scene.add(root);
  const hidden = new Set(placementsFile?.hiddenStandins ?? []);
  const map = gltf.scene;
  const KIND: Record<string, string> = { terrain: "floor", houses: "shell", fences: "wall", hedges: "wall", structures: "shell" };
  map.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // the object (role) name is the node name in the GLB: terrain / houses / standin:bus ...
    let obj = mesh.name;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
      if (p.name && (KIND[p.name] || p.name.startsWith("standin_"))) {
        obj = p.name;
        break;
      }
    }
    const roleKey = obj;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((mm) => matFor((mm as THREE.Material).name || "nt_default", obj));
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
    const glass = next.some((x) => (x as THREE.MeshStandardMaterial).transparent);
    mesh.castShadow = !glass && obj !== "terrain";
    mesh.receiveShadow = !glass;
    // fixed blend order per family (houses 10, vehicles/props 11): never sorted
    // against each other by a camera-distance tie
    if (glass) mesh.renderOrder = obj.startsWith("standin") ? 11 : 10;
    const kind = KIND[obj] ?? (obj.startsWith("standin") ? "prop" : "shell");
    mesh.userData.kind = kind;
    mesh.userData.qaId = `${roleKey}-${mesh.id}`;
    if (obj.startsWith("standin")) {
      const key = obj.slice("standin_".length);
      mesh.userData.standin = key;
      if (hidden.has(key)) mesh.visible = false;
    }
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  });
  map.updateMatrixWorld(true);
  root.add(map);

  // ---------------------------------------------------------- hero props by placement
  const placements = placementsFile?.placements ?? [];
  // runtime hooks the props ship with (props-out/PLACEMENT-NOTES.md): swing seats sway,
  // the clock's sweep hand turns (about its pivot's local +Z, clockwise = negative)
  const swings: { o: THREE.Object3D; x0: number; ph: number }[] = [];
  const sweeps: { o: THREE.Object3D; z0: number }[] = [];
  if (placements.length) {
    const cache = new Map<string, Promise<THREE.Group | null>>();
    const get = (asset: string) => {
      let p = cache.get(asset);
      if (!p) {
        p = gltfLoader.loadAsync(A(`props/${asset}${soft ? "-low" : ""}.glb`))
          .catch(() => gltfLoader.loadAsync(A(`props/${asset}.glb`)))
          .then((g) => g.scene)
          .catch(() => null);
        cache.set(asset, p);
      }
      return p;
    };
    await Promise.all(placements.map(async (pl) => {
      const tpl = await get(pl.asset);
      if (!tpl) return;
      const inst = tpl.clone(true);
      inst.position.set(pl.pos[0]!, pl.pos[1]!, pl.pos[2]!);
      inst.rotation.y = -pl.yaw; // OBB yaw -> three rotation (shared/map.ts RENDER_YAW)
      inst.scale.setScalar(pl.scale ?? 1);
      inst.userData.kind = "prop";
      inst.userData.qaId = `prop-${pl.id ?? pl.asset}`;
      inst.traverse((o) => {
        if (/^pivot_swing\d$/.test(o.name)) swings.push({ o, x0: o.rotation.x, ph: swings.length * 1.7 });
        if (o.name === "clock_hand_sweep") sweeps.push({ o, z0: o.rotation.z });
      });
      inst.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // a map-space prop surface named with the map's own `nt_*` name (street_out's asphalt, gutter
        // pan, curb, sidewalk, lawn) takes the map's SPECS material, so the joint with the map is seamless
        const own = Array.isArray(m.material) ? m.material : [m.material];
        if (own.some((x) => SPECS[x.name])) {
          const next = own.map((x) => (SPECS[x.name] ? matFor(x.name, `prop:${pl.asset}`) : x));
          m.material = Array.isArray(m.material) ? next : next[0]!;
        }
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const glass = mats.some((x) => /_glass$/.test(x.name));
        for (const x of mats) {
          if (/_glass$/.test(x.name)) {
            (x as THREE.MeshStandardMaterial).transparent = true;
            x.depthWrite = false;
          }
          // cutouts (lattice, chain-link, foliage cards): MSAA-smoothed, never sorted
          if (x.alphaTest > 0 && !x.transparent) x.alphaToCoverage = true;
          if (/_decal$/.test(x.name)) {
            x.polygonOffset = true;
            x.polygonOffsetFactor = -2;
            x.polygonOffsetUnits = -2;
          }
        }
        m.castShadow = !glass;
        m.receiveShadow = true;
        if (glass) m.renderOrder = 11;
      });
      root.add(inst);
    }));
  }

  // ---------------------------------------------------------- sky, haze, backdrop, light (LIGHT)
  const rig = await buildSkyRig(scene, renderer, soft, sets, lm);
  // ---------------------------------------------------------- grass / plantings (GROUND; a no-op stub today)
  const foliage = await buildNuketownFoliage({ scene, root, map, renderer, soft, sets, asset: A });

  let clock = 0;
  return {
    scene,
    sun: rig.sun,
    root,
    update: (dt: number, cam: THREE.Camera) => {
      rig.update(dt, cam);
      foliage?.update?.(dt, cam);
      clock += dt;
      for (const w of swings) w.o.rotation.x = w.x0 + 0.07 * Math.sin(clock * 1.85 + w.ph) + 0.025 * Math.sin(clock * 0.53 + w.ph * 2.1);
      for (const h of sweeps) h.o.rotation.z = h.z0 - ((clock % 60) / 60) * Math.PI * 2;
    },
  };
}
