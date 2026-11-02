/**
 * KATANA — the mountain-shrine world builder.
 *
 * The rip (.origin) ships the sim side (shared/maps/katana.ts), the sky rig
 * (client/src/katana-sky.ts) and the data (assets/maps/katana.json +
 * katana-radar.png), but NOT the katana-world.ts source — only a built chunk
 * reference. So this builder is local: it draws the shipped colliders
 * directly (one merged mesh per material bin, palette by visual tag) under
 * the katana sky rig. The rig is procedural (dome + mountains + mist), not a
 * 1:1 port of the source scene — its baked lightmaps were removed, not
 * ported (see katana-sky.ts).
 *
 * Contract with game.ts (same as the other builders):
 *   const { buildKatanaWorld } = await import("./katana-world");
 *   this.world = await buildKatanaWorld(renderer);
 *
 * BACKENDS: the solid/ground materials are plain MeshStandardMaterial (both
 * backends). The sky dome, mountain rings, drizzle and height mist are GLSL
 * (ShaderMaterial / onBeforeCompile) — WebGL only. On WebGPU the builder
 * falls back to a flat background + the same fog and sun, so the map stays
 * playable; the WebGL path is the authored look.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { activeMap } from "@shared/maps";
import type { ClassicWorld } from "./world";
import { isWebGpuRenderer, type AnyRenderer } from "./gpu-backend";
import { isSoftwareGL } from "./textures";
import { buildKatanaSky, makeKatanaHemisphere, makeKatanaSun, KATANA_BG_HEX, KATANA_FOG_DENSITY, KATANA_FOG_HEX, type KatanaSkyRig } from "./katana-sky";

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

export async function buildKatanaWorld(renderer: AnyRenderer): Promise<ClassicWorld> {
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
  const solidMaterials: THREE.MeshStandardMaterial[] = [];
  for (const [color, geos] of bins) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02 });
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
    mesh.name = "katana/solids";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    solidMaterials.push(mat);
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

  // ---- sky + sun ------------------------------------------------------------
  let sun: THREE.DirectionalLight;
  let rig: KatanaSkyRig | null = null;
  if (!isWebGpuRenderer(renderer)) {
    rig = buildKatanaSky(scene, renderer, low);
    sun = rig.sun;
    for (const mat of solidMaterials) rig.atmosphere(mat);
    rig.atmosphere(ground.material as THREE.Material);
  } else {
    // WebGPU: no GLSL sky — flat background + the same fog and key light
    // (shared constants/helpers from katana-sky.ts, so the two paths cannot
    // drift); the WebGL path is the authored look.
    scene.background = new THREE.Color(KATANA_BG_HEX);
    scene.fog = new THREE.FogExp2(new THREE.Color(KATANA_FOG_HEX), KATANA_FOG_DENSITY);
    sun = makeKatanaSun(low);
    scene.add(sun, sun.target);
    scene.add(makeKatanaHemisphere(low));
  }

  return {
    scene,
    sun,
    update: (dt, cam) => {
      rig?.update(dt, cam as THREE.Camera);
    },
  };
}
