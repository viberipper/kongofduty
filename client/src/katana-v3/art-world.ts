/**
 * KATANA v3 — the ART world: the headless-Blender art kit (scripts/katana-v3/art/kva_build.py, generated
 * from layout.json + the collider solids + dress.json) skinned with the v3 library at runtime.
 *
 *   katana-art.glb   one object per spatial chunk (+ "bd" backdrop, "kvk_*" merged kit props); material
 *                    slots named kv3a_<key> (public/assets/katana/v3/art/materials.json), kv3_water, or kit
 *                    names (kv3_<set>, kv3n_*, kv3p_*, kv3_lantern_paper ...) resolved by props.ts
 *   art.json         chunk bounds, light sources (lanterns, toro, neon, shoji spill), rake circles, drip
 *                    lines, probe zones
 *
 * Lighting: moon key (shadowed), sky fill + PMREM night HDRI, every lantern on the static light grid (lights.ts:
 * baked diffuse pools + runtime specular / streaks, no camera-following lights), box-projected zone
 * probes for the wet floors (captured once, after everything emissive exists), SSR in the post stack.
 * Weather: rain / splashes / eave drips / mist (weather.ts) with the readability cone on every actor.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { assetUrl, safeAssetPath, sameOriginManager } from "../asset-base";
import type { WorldApi } from "../world";
import { isSoftwareGL } from "../textures";
import { buildKatanaSky } from "../katana-sky";
import { createWetnessRig, type WetnessRig, type WetSpec } from "./wetness";
import { loadV3Library } from "./library";
import { loadKatanaProps, waterMaterial } from "./props";
import { createKatanaWeather, type KatanaWeather } from "./weather";
import { ProbeReflections, MoatMirror } from "./reflections";
import { buildKatanaNight } from "./night";
import { loadLightGrid, patchGridLights, activeLightGrid, type LightGrid } from "./lights";
import { buildKatanaNature, type KatanaNature } from "./nature";

/** GRADE exposure for the art world (game.ts passes it to the katana post stack). */
export const KATANA_EXPOSURE = 0.92;

const azEl = (azDeg: number, elDeg: number) => {
  const el = THREE.MathUtils.degToRad(elDeg), az = THREE.MathUtils.degToRad(azDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
};
/**
 * Moonlight direction (TO the moon): azimuth 200 deg from north (-Z), 32 deg up. Swung from 215/38 so the moon
 * sits in the hero sightlines as in the paintings (kaidan-top looks 180, market-wall 221, suimon 264): those
 * views are BACKLIT, so the wet floors carry the moon's glint toward the player.
 */
export const KATANA_MOON_DIR = azEl(200, 32);
/** Where the moon DISC is drawn (night.ts): same azimuth, lower so it lands inside the hero frames (kaidan-top
 * looks 13 deg down with a 60 deg fov: the top edge is +17 deg). The light keeps 32 deg so floors stay moonlit. */
export const KATANA_MOON_DISC = azEl(195, 14);

type MatSpec = {
  tex?: string; cutout?: boolean; unlit?: boolean; transparent?: boolean; opacity?: number;
  set?: string; tint?: string; tile?: number; wet?: Partial<WetSpec>; emissive?: [string, number];
  flat?: string; rough?: number; water?: boolean; rake?: boolean;
};
type ArtLight = { p: [number, number, number]; c: string; i: number; d?: number; kind?: string };
type ArtMeta = {
  tris: number;
  chunks: Record<string, { tris: number; min: number[]; max: number[] }>;
  lights: ArtLight[];
  rake: { x: number; z: number; r: number }[];
  drips: [number, number, number][][];
  probes: { id: string; p: [number, number, number]; min: [number, number, number]; max: [number, number, number] }[];
  mist?: { min: [number, number, number]; max: [number, number, number]; d: number }[];
  lightmaps?: Record<string, { file?: string; scale: number; size?: number; vertex?: boolean }> | null;
};

/**
 * Baked irradiance replaces the sky fill on the map: a lightmapped material drops the hemisphere light and the
 * IBL diffuse term (the bake already holds the occluded sky + every lantern + bounce) and keeps the moon,
 * the pool lights and the env/probe SPECULAR. mode "tex": three's lightMap on uv1 (texel = E/pi / scale);
 * mode "vert": COLOR_0 (= E/pi / scale) for detail pieces and kit props.
 */
function patchLightmap(m: THREE.Material, mode: "tex" | "vert", gain: number): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    if (mode === "vert") {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\n#ifndef USE_COLOR\nattribute vec3 color;\n#endif\nvarying vec3 vKvLm;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKvLm = color.rgb;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vKvLm;");
    }
    let fs = shader.fragmentShader;
    fs = fs.replace("#include <lights_fragment_begin>", THREE.ShaderChunk.lights_fragment_begin.replace(
      "irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );", "/* kv lightmap: sky fill is baked */"));
    fs = fs.replace("#include <lights_fragment_maps>", THREE.ShaderChunk.lights_fragment_maps
      .replace("iblIrradiance += getIBLIrradiance( geometryNormal );", "/* kv lightmap: sky irradiance is baked */")
      + (mode === "vert" ? `\nirradiance += vKvLm * ${(Math.PI * gain).toFixed(5)};` : ""));
    shader.fragmentShader = fs;
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kvlm-${mode}-${gain.toFixed(4)}`;
  m.needsUpdate = true;
}

type Pvs = { cell: number; x0: number; z0: number; nx: number; nz: number; bands: number[]; chunks: string[]; sets: Record<string, number[]> };

export type KatanaArtWorld = WorldApi & {
  kvRig: WetnessRig;
  kvGrid: LightGrid | null;
  kvActors: (feet: THREE.Vector3[]) => void;
  kvStats: () => Record<string, number>;
};

const BASE = "/assets/katana/v3";

export async function buildKatanaWorld(renderer: THREE.WebGLRenderer): Promise<KatanaArtWorld> {
  const q = new URLSearchParams(location.search);
  const low = isSoftwareGL(renderer) || q.get("kvlow") === "1";
  const scene = new THREE.Scene();
  scene.name = "KATANA-ART";
  const root = new THREE.Group();
  root.name = "katana/art";
  scene.add(root);

  const rig = createWetnessRig();
  rig.uniforms.uKvWetness.value = Number(q.get("kvwet") ?? 1);
  rig.uniforms.uKvPuddleLevel.value = Number(q.get("kvpuddle") ?? 0.76);
  rig.uniforms.uKvStreakGain.value = Number(q.get("kvstreak") ?? 1.6);

  const json = async <T,>(u: string): Promise<T> => (await fetch(assetUrl(u))).json() as Promise<T>;
  const pvsP = fetch(assetUrl(`${BASE}/art/pvs.json`)).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<Pvs | null>;
  const [hdr, lib, meta, mats, gltf] = await Promise.all([
    low ? Promise.resolve(null) : new RGBELoader(sameOriginManager()).loadAsync(assetUrl(`${BASE}/hdri/kloppenheim_07_puresky_1k.hdr`)).catch(() => null),
    loadV3Library(renderer, assetUrl(`${BASE}/tex`), rig, low),
    json<ArtMeta>(`${BASE}/art/art.json`),
    json<{ materials: Record<string, MatSpec> }>(`${BASE}/art/materials.json`),
    new GLTFLoader(sameOriginManager()).setMeshoptDecoder(MeshoptDecoder).loadAsync(assetUrl(`${BASE}/art/katana-art.glb`)),
  ]);
  if (hdr) hdr.mapping = THREE.EquirectangularReflectionMapping;
  const kit = await loadKatanaProps(lib, rig, assetUrl(BASE));
  const grid: LightGrid | null = low || q.get("kvgrid") === "0" ? null : await loadLightGrid(assetUrl, `${BASE}/art`, (meta.lights ?? []).map((l) => ({ ...l, d: l.d ?? 6 })));

  // ------------------------------------------------------------------ sky, moon, fill
  const sky = buildKatanaSky(scene, renderer, low, hdr);
  // weather.ts owns the rain; drop the sky rig's drizzle points
  const drizzle: THREE.Object3D[] = [];
  scene.traverse((o) => { if ((o as THREE.Points).isPoints) drizzle.push(o); });
  for (const d of drizzle) d.parent?.remove(d);
  const night = buildKatanaNight(scene, KATANA_MOON_DISC, low);
  // moonlit blue night (brighter than the grey's sky: the cloud deck and the moon carry the top of frame)
  const skyMesh = scene.getObjectByName("katana/sky") as THREE.Mesh | undefined;
  if (skyMesh) {
    const u = (skyMesh.material as THREE.ShaderMaterial).uniforms;
    u.uZenith!.value = new THREE.Color("#18263f"); u.uHorizon!.value = new THREE.Color("#4a6283"); u.uLower!.value = new THREE.Color("#1f2c40");
  }
  if (scene.fog instanceof THREE.FogExp2) { scene.fog.color.set("#2c3c54"); scene.fog.density = 0.0034; }
  const sun = sky.sun;
  sun.name = "katana/moon";
  sun.color.set(0xc6d3ec); // moonlight: cool, not cyan (the grade adds the blue in the shadows)
  sun.intensity = Number(q.get("kvmoon") ?? 2.8);
  sun.position.copy(KATANA_MOON_DIR).multiplyScalar(150);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = !low;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -78; sc.right = 78; sc.top = 78; sc.bottom = -78; sc.near = 20; sc.far = 320;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.045;
  sc.layers.enable(1);
  renderer.shadowMap.enabled = true;
  scene.traverse((o) => { if ((o as THREE.HemisphereLight).isHemisphereLight) { const h = o as THREE.HemisphereLight; h.color.set(0x9fb4d6); h.groundColor.set(0x2a2f36); h.intensity = low ? 1.6 : 0.62; } });

  // ------------------------------------------------------------------ materials
  const made = new Map<string, THREE.Material>();
  const wetMats: THREE.MeshStandardMaterial[] = [];
  const RED = new THREE.Color("#E8141F");
  const artMat = (key: string): THREE.Material => {
    const spec = mats.materials[key];
    if (!spec) { console.warn(`katana art: no material ${key}`); return new THREE.MeshStandardMaterial({ color: 0xff00ff }); }
    if (spec.water) return waterMaterial(rig);
    if (spec.tex) {
      // unique 0..1-UV art texture (kagami-ita painting ...): dry, interior.
      // materials.json `tex` is a manifest key path — validate before use.
      if (!safeAssetPath(spec.tex)) {
        console.warn(`katana art: rejected texture path ${JSON.stringify(spec.tex)}`);
        return new THREE.MeshStandardMaterial({ color: 0xff00ff });
      }
      const t = new THREE.TextureLoader(sameOriginManager()).load(assetUrl(`${BASE}/${spec.tex}`));
      t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.anisotropy = 8;
      const common = { name: `kv3a_${key}`, map: t, side: spec.cutout || spec.transparent ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: spec.cutout ? 0.5 : 0, transparent: !!spec.transparent, depthWrite: !spec.transparent, opacity: spec.opacity ?? 1 };
      const m = spec.unlit ? new THREE.MeshBasicMaterial(common) : new THREE.MeshStandardMaterial({ ...common, roughness: spec.rough ?? 0.8, metalness: 0 });
      if (spec.cutout) m.alphaToCoverage = true;
      return m;
    }
    if (spec.flat) {
      const m = new THREE.MeshStandardMaterial({ name: `kv3a_${key}`, color: new THREE.Color(spec.flat), roughness: spec.rough ?? 0.8, metalness: 0 });
      if (spec.emissive) { m.emissive.set(spec.emissive[0]); m.emissiveIntensity = spec.emissive[1]; }
      return m;
    }
    const m = lib.material(spec.set!, {
      name: `kv3a_${key}`,
      tint: spec.tint,
      tile: spec.tile,
      wet: spec.wet,
      emissive: spec.emissive?.[0],
      emissiveIntensity: spec.emissive?.[1],
      rake: spec.rake ? { circles: meta.rake ?? [] } : undefined,
    });
    if (spec.emissive && spec.set === "shoji") { m.emissiveMap = m.map; }
    wetMats.push(m);
    return m;
  };
  const LM_GAIN = Number(q.get("kvlm") ?? 1);
  const lmTex = new Map<string, THREE.Texture>();
  const texLoader = new THREE.TextureLoader(sameOriginManager());
  const lmFor = (obj: THREE.Object3D): [string, { file?: string; scale: number; vertex?: boolean }] | null => {
    if (q.get("kvlm") === "0") return null;
    if (obj.name.startsWith("kvx_") || obj.parent?.name.startsWith("kvx_")) return null;
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
      const e = meta.lightmaps?.[o.name];
      if (e) {
        // art.json lightmap files are manifest key paths — validate before use.
        if (e.file && !safeAssetPath(e.file)) {
          console.warn(`katana art: rejected lightmap path ${JSON.stringify(e.file)}`);
          return null;
        }
        return [o.name, e];
      }
    }
    return null;
  };
  const fresh = (name: string): THREE.Material => {
    if (name.startsWith("kv3a_")) return artMat(name.slice(5));
    if (name === "kv3_water") return waterMaterial(rig);
    if (/^kv3_toro_paper/.test(name)) return new THREE.MeshStandardMaterial({ name, color: 0x4a0a10, emissive: RED, emissiveIntensity: 1.6, roughness: 0.7 });
    return kit.material(name) ?? new THREE.MeshStandardMaterial({ name, color: 0x777777, roughness: 0.8 });
  };
  const isEmissiveName = (n: string) => /lantern_paper|toro_paper|neon|_tube|_glow|interior|shoji_glow|window_dark/.test(n);
  const resolve = (raw: string, obj: THREE.Object3D): THREE.Material => {
    const name = raw.replace(/\.\d+$/, "");
    const lm = isEmissiveName(name) ? null : lmFor(obj);
    const variant = !lm ? "plain" : lm[1].vertex ? "vert" : `tex:${lm[0]}`;
    const key = `${name}|${variant}`;
    let m = made.get(key);
    if (m) return m;
    m = variant === "vert" && !name.startsWith("kv3a_") && name !== "kv3_water" ? fresh(name) : fresh(name);
    if (lm && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(m as THREE.MeshStandardMaterial).alphaTest) {
      const sm = m as THREE.MeshStandardMaterial;
      if (lm[1].vertex) patchLightmap(sm, "vert", lm[1].scale * LM_GAIN);
      else if (lm[1].file) {
        let t = lmTex.get(lm[1].file);
        if (!t) {
          t = texLoader.load(assetUrl(`${BASE}/art/lm/${lm[1].file}`));
          t.channel = 1; t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
          lmTex.set(lm[1].file, t);
        }
        sm.lightMap = t;
        sm.lightMapIntensity = Math.PI * lm[1].scale * LM_GAIN;
        patchLightmap(sm, "tex", 1);
      }
    }
    // hero sword: the habaki band glows, it does not flare
    if (name === "kv3n_katana_glow") (m as THREE.MeshStandardMaterial).emissiveIntensity = 1.6; // AD r2: under the bloom clip
    // AD r2: the blade read as a wooden pole: polished steel (the probe gives it the moonlit court to mirror)
    if (name === "kv3n_katana_blade") {
      const b = m as THREE.MeshStandardMaterial;
      b.metalness = 1; b.roughness = 0.16; b.roughnessMap = null; b.metalnessMap = null; b.color.setRGB(0.86, 0.88, 0.92); b.envMapIntensity = 1.6;
      b.needsUpdate = true;
    }
    // water mirrors the zone probe (box-projected: the court, its lanterns and the moonlit sky), like the wet floors
    if (name === "kv3_water") { const w = m as THREE.MeshStandardMaterial; w.envMapIntensity = 0.32; w.color.set(0x020406); w.userData.kvWater = true; wetMats.push(w); }
    // chochin paper: the washi scan is cream (linear 0.83/0.73/0.69); emitted as-is every lantern and its reflections
    // read amber. Neutralise to a cool white (the red bands stay red: the multiply is near-neutral on red).
    if (name === "kv3_lantern_paper") (m as THREE.MeshStandardMaterial).emissive.setRGB(0.95, 1.08, 1.2);
    // every lantern on the light grid: lightmapped = specular + streaks over the baked pool, unbaked = diffuse too
    if (grid && !isEmissiveName(name)) patchGridLights(m, grid, lm ? "baked" : "full");
    made.set(key, m);
    return m;
  };

  const art = gltf.scene;
  art.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.Material;
    const m = resolve(src.name, mesh);
    mesh.material = m;
    const n = m.name;
    const emissive = /lantern_paper|toro_paper|neon|_tube|interior|shoji_glow|window_dark|forest_band|kv3a_mist/.test(n) || (m as THREE.ShaderMaterial).isShaderMaterial;
    const isWater = n === "kv3_water";
    const back = /^kv[akx]_bd/.test(mesh.name) || /^kv[akx]_bd/.test(mesh.parent?.name ?? "") || /forest|riverbank/.test(n);
    mesh.castShadow = !emissive && !isWater && !/forest_floor|riverbank/.test(n);
    mesh.receiveShadow = !emissive;
    if (isWater) mesh.userData.kvNoRainOcc = true;
    if (back) mesh.userData.kvBackdrop = true;
    mesh.layers.enable(1);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  });
  root.add(art);
  await kit.ready();
  // nature r2 (nature.ts, lane katana-v3-art-nature): instanced scanned rocks, toro, trees, koi, backdrop (?kvnature=0 = off)
  const nature: KatanaNature | null = q.get("kvnature") === "0" ? null : await buildKatanaNature({ scene, renderer, lib, rig, low });
  for (const m of nature?.materials ?? []) sky.atmosphere(m);
  root.updateMatrixWorld(true);
  for (const m of made.values()) if (m.name !== "kv3_water") sky.atmosphere(m);
  // aerial perspective on the backdrop only (terrain, forest, edge trees): 2.6x fog density so the ridges layer
  // into the moonlit haze instead of reading as a dark wall; the playable map keeps the light game fog
  const hazed = new Set<THREE.Material>();
  art.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.userData.kvBackdrop) return;
    const m = mesh.material as THREE.Material;
    if (/forest_band|kv3a_mist/.test(m.name)) return; // ridge cards carry their own painted value: normal fog only
    if (hazed.has(m)) return;
    hazed.add(m);
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev.call(m, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace("#include <fog_fragment>", THREE.ShaderChunk.fog_fragment.replace("fogDensity * fogDensity", "fogDensity * fogDensity * 6.8"));
    };
    const k = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${k()}|kvhaze`;
    m.needsUpdate = true;
  });

  // ------------------------------------------------------------------ lanterns: halos + cords (lights.ts)
  if (grid) scene.add(grid.group);
  const sources = grid?.sources ?? [];
  const camPos = new THREE.Vector3();
  let probeT = 1;

  // ------------------------------------------------------------------ weather (created on the first update: it wants the camera)
  let weather: KatanaWeather | null = null;
  const actors: THREE.Vector3[] = [];
  const startWeather = (cam: THREE.Camera) => {
    if (q.get("kvweather") === "0") return;
    weather = createKatanaWeather(scene, cam, renderer, rig, { quality: low ? "low" : "high", intensity: Number(q.get("kvrain") ?? 0.45) });
    if (grid) weather.setLightSources(grid.sources.map((s) => ({ p: s.p, c: s.c, i: s.i })));
    for (const d of meta.drips ?? []) weather.addDripLine(d.map((p) => new THREE.Vector3(...p)));
    for (const m of meta.mist ?? []) weather.addMistZone(new THREE.Box3(new THREE.Vector3(...m.min), new THREE.Vector3(...m.max)), m.d);
    weather.refreshLights();
  };

  // ------------------------------------------------------------------ rain shadow + zone probes (after everything exists)
  const bounds = new THREE.Box3(new THREE.Vector3(-62, -9, -50), new THREE.Vector3(62, 32, 92));
  // only the map occludes rain: the sky dome, clouds, moon and mountain rings follow the camera / sit at infinity
  for (const ch of scene.children) if (ch !== root) ch.traverse((o) => { o.userData.kvNoRainOcc = true; });
  if (q.get("kvrainocc") !== "0") rig.captureRain(renderer, scene, bounds, low ? 1024 : 2048);
  const probes: { p: ProbeReflections; box: THREE.Box3; pos: THREE.Vector3 }[] = [];
  if (!low && q.get("kvprobe") !== "0") {
    // warm-up render so every emissive material is compiled into the capture
    for (const z of meta.probes ?? []) {
      const pr = new ProbeReflections(128);
      const box = new THREE.Box3(new THREE.Vector3(...z.min), new THREE.Vector3(...z.max));
      const pos = new THREE.Vector3(...z.p);
      pr.capture(renderer, scene, pos, box, rig);
      probes.push({ p: pr, box, pos });
    }
  }
  // the koi moat mirror (planar, layer-limited; reflections.ts MoatMirror). The court moat = water meshes near y -0.35.
  let moat: MoatMirror | null = null;
  // OFF by default: measured +4 ms at 1440p on an M5 Ultra even layer-limited (the court chunks are big merged meshes),
  // over the Nuketown budget. ?kvmoat=1 turns it on (high-end QA / cinematics); the moat otherwise reflects through the
  // zone probe + SSR + the light-grid streaks.
  if (!low && q.get("kvmoat") === "1") {
    const water: THREE.Mesh[] = [];
    art.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh.material as THREE.Material).name !== "kv3_water") return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
      if (bb.max.y > -1 && bb.max.y < 0.2 && Math.abs(bb.getCenter(new THREE.Vector3()).x) < 12) water.push(mesh);
    });
    if (water.length) {
      moat = new MoatMirror(rig, water, scene);
      if (grid) moat.cheap.push(grid.uniforms.uKgOn as { value: number });
      moat.cheap.push(rig.uniforms.uKvSparkle);
    }
  }
  let activeProbe = -1;
  const pickProbe = (cam: THREE.Camera) => {
    if (!probes.length) return;
    cam.getWorldPosition(camPos);
    let best = -1, bd = Infinity;
    for (let i = 0; i < probes.length; i++) {
      const pr = probes[i]!;
      const d = pr.box.containsPoint(camPos) ? 0 : pr.box.distanceToPoint(camPos) + 1;
      const score = d * 100 + camPos.distanceTo(pr.pos);
      if (score < bd) { bd = score; best = i; }
    }
    if (best === activeProbe) return;
    activeProbe = best;
    const pr = probes[best]!;
    rig.uniforms.uKvBoxMin.value.copy(pr.box.min);
    rig.uniforms.uKvBoxMax.value.copy(pr.box.max);
    rig.uniforms.uKvBoxPos.value.copy(pr.pos);
    pr.p.enable(rig, wetMats, true, scene.environment, scene.environmentIntensity);
  };

  // ------------------------------------------------------------------ PVS chunk culling (scripts/katana-v3/art/pvs.mts)
  const pvs = q.get("kvpvs") === "0" ? null : await pvsP;
  // culling = drop layer 0 (the main camera) but keep layer 1, which game.ts renders the moon shadow from: a culled
  // roof or wall still shades the room you stand in
  const chunkRoots = new Map<string, THREE.Object3D[]>();
  for (const o of art.children) {
    const key = o.name.includes("_") ? o.name.split("_").slice(1).join("_").replace(/d$/, "") : "";
    if (!key) continue;
    const list = chunkRoots.get(key) ?? chunkRoots.set(key, []).get(key)!;
    o.traverse((m) => { if ((m as THREE.Mesh).isMesh) list.push(m); });
  }
  // [art r3] distant detail: the vertex-lit detail chunks (kva_*d: trims, posts, ropes, panels) and plain kit props
  // (kvk_*) drop out past FAR_DETAIL m (closest point of each mesh's box); their silhouettes are a few pixels there and
  // each is one draw per material. Lit kit (kvx_*: lanterns) always stays.
  const FAR_DETAIL = Number(q.get("kvfar") ?? 42);
  const farMeshes: { m: THREE.Object3D; box: THREE.Box3 }[] = [];
  for (const o of art.children) {
    if (!(/^kva_.*d$/.test(o.name) || /^kvk_/.test(o.name))) continue;
    o.traverse((m) => { if ((m as THREE.Mesh).isMesh) farMeshes.push({ m, box: new THREE.Box3().setFromObject(m) }); });
  }
  const pvsOff = new Set<THREE.Object3D>();
  let farAt = new THREE.Vector3(1e9, 0, 0);
  let farHidden = 0;
  const applyFar = () => {
    if (!(FAR_DETAIL > 0) || camPos.distanceToSquared(farAt) < 4) return;
    farAt.copy(camPos);
    farHidden = 0;
    for (const f of farMeshes) {
      const far = f.box.distanceToPoint(camPos) > FAR_DETAIL;
      if (far) farHidden++;
      if (far || pvsOff.has(f.m)) f.m.layers.disable(0); else f.m.layers.enable(0);
      // far detail casts no moon shadow either (layer 1 = the shadow pass): a trim's shadow 42 m away is sub-pixel
      if (far) f.m.layers.disable(1); else f.m.layers.enable(1);
    }
  };
  let pvsKey = "";
  let pvsHidden = 0;
  const applyPvs = (cam: THREE.Camera) => {
    if (!pvs) return;
    cam.getWorldPosition(camPos);
    const i = Math.floor((camPos.x - pvs.x0) / pvs.cell), j = Math.floor((camPos.z - pvs.z0) / pvs.cell);
    const feet = camPos.y - 1.62;
    const b = feet < pvs.bands[0]! ? 0 : feet < pvs.bands[1]! ? 1 : feet < pvs.bands[2]! ? 2 : 3;
    let set = pvs.sets[`${i},${j},${b}`];
    // flying / out-of-bounds cameras (cinematics, overviews) or a cell nobody stands in: draw everything
    if (!set && b > 0) set = pvs.sets[`${i},${j},${b - 1}`];
    if (!set && b < 3) set = pvs.sets[`${i},${j},${b + 1}`];
    const key = set && camPos.y < 14 ? `${i},${j},${b}` : "all";
    if (key === pvsKey) { applyFar(); return; }
    pvsKey = key;
    const vis = new Set(key === "all" ? pvs.chunks : set!.map((k) => pvs.chunks[k]!));
    pvsHidden = 0;
    for (const [k, roots] of chunkRoots) {
      const v = key === "all" || vis.has(k) || !pvs.chunks.includes(k);
      for (const r of roots) { if (v) { r.layers.enable(0); pvsOff.delete(r); } else { r.layers.disable(0); pvsOff.add(r); pvsHidden++; } }
    }
    farAt.set(1e9, 0, 0);
    applyFar();
  };

  // [art r3] culling follows WHATEVER camera renders the scene, not only the one world.update saw: the station harness,
  // __test.renderWith, the intro flythrough, POTG and the kill-cam move a camera and render without an update (the AD
  // caught the Kagura hall missing with its lanterns floating). Cube/probe cameras (fov 90, parented to a CubeCamera)
  // and orthographic shadow cameras never drive it.
  const prevBefore = scene.onBeforeRender;
  scene.onBeforeRender = (r, sc2, cam, ...rest) => {
    const pc = cam as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera && !pc.userData.kvMirror && !(pc.parent && (pc.parent as THREE.Object3D).type === "CubeCamera") && pc.fov !== 90) applyPvs(pc);
    (prevBefore as (...a: unknown[]) => void).call(scene, r, sc2, cam, ...rest);
  };
  let t = 0;
  return {
    scene,
    sun,
    root,
    kvRig: rig,
    kvGrid: grid,
    kvActors: (feet) => { actors.length = 0; actors.push(...feet); weather?.setActors(actors); },
    kvStats: () => ({ moatLayered: moat?.layered ?? 0, moatOn: moat?.active ? 1 : 0, tris: meta.tris, sources: sources.length, probes: probes.length, materials: made.size, pvsHidden, farHidden, pvsCell: pvsKey as unknown as number }),
    update: (dt: number, cam: THREE.Camera) => {
      t += dt;
      rig.update(dt);
      sky.update(dt, cam);
      night.update(dt, cam);
      nature?.update(dt, cam);
      if (!weather) startWeather(cam);
      weather?.update(dt, cam);
      grid?.update(cam);
      if (moat && (cam as THREE.PerspectiveCamera).isPerspectiveCamera) moat.update(renderer, scene, cam as THREE.PerspectiveCamera);
      probeT += dt;
      if (probeT > 0.2) { probeT = 0; pickProbe(cam); }
      applyPvs(cam);
    },
  };
}

/**
 * Readability: a cool moonlit rim on every operator (the actor template's materials, shared by all clones) so a
 * silhouette separates from wet dark stone, black cedar and night sky at 10 / 25 / 45 m in rain. Fresnel-shaped
 * emissive (no extra light, no shadow cost); strongest at grazing angles, i.e. on the outline.
 */
const RIM_Q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
export function kvRimMaterial(m: THREE.Material, color = 0xb4d2ff, strength = Number(RIM_Q.get("kvrimk") ?? 1.35), power = Number(RIM_Q.get("kvrimp") ?? 2.5)): void {
  if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial || m.userData.kvRim) return;
  m.userData.kvRim = true;
  // operators are lit by every lantern they stand near (diffuse + specular from the light grid)
  const grid = activeLightGrid();
  if (grid) patchGridLights(m, grid, "full");
  const prev = m.onBeforeCompile;
  const c = new THREE.Color(color);
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uKvRim = { value: new THREE.Vector3(c.r * strength, c.g * strength, c.b * strength) };
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uKvRim;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        { float kvF = 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
          totalEmissiveRadiance += uKvRim * pow( kvF, ${power.toFixed(2)} ); }`);
  };
  const k = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${k()}|kvrim`;
  m.needsUpdate = true;
}
