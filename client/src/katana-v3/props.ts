import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { safeAssetPath, sameOriginManager } from "../asset-base";
import type { V3Library } from "./library";
import { patchWetness, type WetnessRig } from "./wetness";

/**
 * KATANA v3 props kit — runtime side (public/assets/katana/v3/props/{built,nature}).
 *
 * Material names in the kit GLBs are resolved here, so a prop (or the lookdev / grey-build GLB
 * that embeds props) needs no textures of its own:
 *   kv3_<set>             library set (world-metre UVs)              -> lib.material(set)
 *   kv3_lantern_paper     chochin wrap, map + emissiveMap
 *   kv3_toro_paper        flat emissive red paper
 *   kv3n_<sign>_board     neon sign housing face (board_c.png, alpha-test)
 *   kv3n_<sign>_tube      neon tubes: SDF core + glow, additive, unlit (bloom does the halo)
 *   kv3n_<asset>_<part>   nature kit unique textures (nature.json unique_textures)
 *   kv3p_<name>           built kit unique textures (built/tex/<name>_c.webp)
 * `instance(id)` builds a THREE.LOD from <id>_LOD0/1/2 (distances from the kit conventions) and
 * adds a point light at every `light*` socket.
 */
type Spec = { id: string; file: string; sockets?: Record<string, unknown>; unique_textures?: Record<string, Record<string, unknown>>; notes?: string };

export type KatanaProps = {
  material: (name: string) => THREE.Material | null;
  instance: (id: string) => Promise<THREE.Object3D>;
  /** resolves when every texture requested so far has loaded */
  ready: () => Promise<void>;
  built: Record<string, Spec>;
  nature: Record<string, Spec>;
};

const RED = new THREE.Color("#E8141F");

export async function loadKatanaProps(lib: V3Library, rig: WetnessRig, base = "/assets/katana/v3"): Promise<KatanaProps> {
  const j = async (u: string) => (await fetch(u)).json();
  const built = (await j(`${base}/props/built/built.json`)).props as Record<string, Spec>;
  const nature = (await j(`${base}/props/nature/nature.json`)).assets as Record<string, Spec>;
  const neon = (await j(`${base}/neon/neon.json`)) as { signs: { id: string; tube_colors: string[]; emissive_intensity: number; files: Record<string, string> }[] };
  const tl = new THREE.TextureLoader(sameOriginManager());
  const texCache = new Map<string, THREE.Texture>();
  const pending: Promise<unknown>[] = [];
  const tex = (url: string, srgb: boolean, repeat = false) => {
    const k = `${url}|${srgb}`; let t = texCache.get(k);
    if (!t) {
      let done: () => void = () => {};
      pending.push(new Promise<void>((r) => { done = r; }));
      t = tl.load(url, () => done(), undefined, () => { console.warn(`props: missing ${url}`); done(); }); t.flipY = false; t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      texCache.set(k, t);
    }
    return t;
  };
  const unique: Record<string, Record<string, unknown>> = {};
  for (const a of Object.values(nature)) Object.assign(unique, a.unique_textures ?? {});

  const cache = new Map<string, THREE.Material | null>();
  const neonTube = (sid: string) => {
    const sg = neon.signs.find((s) => s.id === sid)!;
    const c0 = new THREE.Color(sg.tube_colors[0]), c1 = new THREE.Color(sg.tube_colors[1] ?? sg.tube_colors[0]);
    return new THREE.ShaderMaterial({
      name: `kv3n_${sid}_tube`,
      uniforms: { tSdf: { value: tex(`${base}/neon/${sg.files.sdf}`, false) }, tGlow: { value: tex(`${base}/neon/${sg.files.glow}`, false) }, c0: { value: c0 }, c1: { value: c1 }, uI: { value: sg.emissive_intensity } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform sampler2D tSdf, tGlow; uniform vec3 c0, c1; uniform float uI; varying vec2 vUv;
        void main(){
          vec2 s = texture2D(tSdf, vUv).rg; vec2 aa = max(fwidth(s), vec2(1e-3));
          vec2 core = smoothstep(0.5 - aa, 0.5 + aa, s); vec2 hot = smoothstep(0.5, 0.62, s);
          vec2 g = texture2D(tGlow, vUv).rg;
          vec3 rgb = (c0 * (core.r * (1.0 + 1.5 * hot.r) + g.r * 0.12) + c1 * (core.g * (1.0 + 1.5 * hot.g) + g.g * 0.12)) * uI;
          gl_FragColor = vec4(rgb, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
  };
  // Defense-in-depth: kit/unique-texture key paths are plain relative paths —
  // rejected entries warn and fall back instead of fetching `..` / `:` / URLs.
  const okPath = (p: unknown): p is string => {
    if (typeof p !== "string") return false; // no path at all — caller falls back silently
    if (safeAssetPath(p)) return true;
    console.warn(`props: rejected manifest path ${JSON.stringify(p)}`);
    return false;
  };
  const uniquePbr = (name: string, t: Record<string, unknown>, dir: string) => {
    const cut = /needles|leaves|spray|inner/.test(name);
    const m = new THREE.MeshStandardMaterial({ name });
    if (okPath(t.c)) m.map = tex(`${dir}/${t.c}`, true, true);
    else m.color.set((t.color as string) ?? "#808080");
    if (okPath(t.n)) m.normalMap = tex(`${dir}/${t.n}`, false, true);
    if (okPath(t.ormh)) { const o = tex(`${dir}/${t.ormh}`, false, true); m.roughnessMap = o; m.aoMap = o; if (!cut) m.metalnessMap = o; m.roughness = 1; m.metalness = cut ? 0 : 1; }
    else { m.roughness = (t.roughness as number) ?? 0.6; m.metalness = (t.metalness as number) ?? 0; }
    if (typeof t.emissive === "string") {
      if (t.emissive.endsWith(".webp")) { if (okPath(t.emissive)) { m.emissiveMap = tex(`${dir}/${t.emissive}`, true, true); m.emissive = new THREE.Color((t.emissive_color as string) ?? "#E8141F"); } }
      else m.emissive = new THREE.Color(t.emissive);
      m.emissiveIntensity = (t.emissive_intensity as number) ?? 1;
    }
    if (cut) { m.alphaTest = 0.5; m.alphaToCoverage = true; m.side = THREE.DoubleSide; }
    if (typeof t.tile_m === "number") {
      for (const k of ["map", "normalMap", "roughnessMap"] as const) { const tx = m[k]; if (tx) { const c = tx.clone(); c.repeat.setScalar(1 / t.tile_m); c.needsUpdate = true; m[k] = c; } }
      m.aoMap = m.roughnessMap; if (m.metalnessMap) m.metalnessMap = m.roughnessMap;
    }
    patchWetness(m, { porosity: cut ? 0.1 : 0.3, wetRough: cut ? 0.3 : 0.2 }, rig, { cutout: cut });
    return m;
  };

  const material = (raw: string): THREE.Material | null => {
    const name = raw.replace(/\.\d+$/, "").replace(/_u$/, "");
    if (cache.has(name)) return cache.get(name)!;
    let m: THREE.Material | null = null;
    if (name === "kv3_lantern_paper") {
      const t = lib.textures.get("chochin") ?? null;
      m = new THREE.MeshStandardMaterial({ name, map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 1.3, roughness: 0.7, side: THREE.DoubleSide });
    } else if (name.startsWith("kv3_toro_paper")) {
      m = new THREE.MeshStandardMaterial({ name, color: 0x4a0a10, emissive: RED, emissiveIntensity: 1.6, roughness: 0.7 });
    } else if (name.startsWith("kv3_") && lib.manifest.sets[name.slice(4)]) {
      m = lib.material(name.slice(4));
    } else if (unique[name]) {
      m = uniquePbr(name, unique[name]!, `${base}/props/nature`);
    } else if (/^kv3n_.+_(board|tube)$/.test(name)) {
      const sid = name.slice(5).replace(/_(board|tube)$/, "");
      const sg = neon.signs.find((s) => s.id === sid);
      // neon.json file entries are manifest key paths too — validate before use.
      if (sg && (name.endsWith("_tube") ? okPath(sg.files.sdf) && okPath(sg.files.glow) : okPath(sg.files.board_c))) m = name.endsWith("_tube") ? neonTube(sid) : new THREE.MeshStandardMaterial({ name, map: tex(`${base}/neon/${sg.files.board_c}`, true), alphaTest: 0.5, roughness: 0.45, side: THREE.DoubleSide });
    } else if (name.startsWith("kv3p_")) {
      const k = name.slice(5);
      if (k === "interior") m = new THREE.MeshStandardMaterial({ name, color: 0x050607, emissive: 0x1a1e24, emissiveIntensity: 0.6 });
      else if (k === "water") m = waterMaterial(rig);
      else if (k === "vending_body") m = new THREE.MeshStandardMaterial({ name, color: 0x22262b, roughness: 0.35, metalness: 0.2 });
      // `k` comes from the GLB's material name and becomes a filename — validate it.
      else if (!okPath(`${k}_c.webp`)) m = null;
      else {
        const t = tex(`${base}/props/built/tex/${k}_c.webp`, true);
        const mm = new THREE.MeshStandardMaterial({ name, map: t, roughness: 0.5 });
        if (k === "vending_front") { mm.emissiveMap = t; mm.emissive.set(0xffffff); mm.emissiveIntensity = 0.5; }
        else patchWetness(mm, { porosity: 0.5, wetRough: 0.4 }, rig);
        m = mm;
      }
    } else if (name === "kv3_water_lookdev") {
      m = waterMaterial(rig);
    }
    cache.set(name, m);
    return m;
  };

  const loader = new GLTFLoader(sameOriginManager());
  const glbs = new Map<string, Promise<THREE.Group>>();
  const instance = async (id: string): Promise<THREE.Object3D> => {
    const kit = built[id] ? "built" : "nature";
    const spec = built[id] ?? nature[id];
    if (!spec) throw new Error(`props: unknown ${id}`);
    if (!safeAssetPath(spec.file)) throw new Error(`props: rejected kit path ${JSON.stringify(spec.file)}`);
    if (!glbs.has(id)) glbs.set(id, loader.loadAsync(`${base}/props/${kit}/${spec.file}`).then((g) => g.scene));
    const src = (await glbs.get(id)!).clone(true);
    const lod = new THREE.LOD(); lod.name = `prop:${id}`;
    const dists = [0, 18, 45];
    for (let i = 0; i < 3; i++) {
      const node = src.getObjectByName(`${id}_LOD${i}`);
      if (!node) continue;
      node.traverse((o) => applyMaterials(o as THREE.Mesh, material));
      node.position.set(0, 0, 0);
      lod.addLevel(node, dists[i]!);
    }
    const root = new THREE.Group(); root.name = id; root.add(lod);
    for (const [k, v] of Object.entries(spec.sockets ?? {})) {
      if (!k.startsWith("light")) continue;
      const pos = Array.isArray(v) ? (v as number[]) : (v as { pos: number[] }).pos;
      // built sockets are Blender Z-up, nature sockets are game Y-up
      const p = kit === "built" ? new THREE.Vector3(pos[0], pos[2], -pos[1]) : new THREE.Vector3(pos[0], pos[1], pos[2]);
      const colr = (v as { color?: string }).color ?? (id === "vending" ? "#DCEBFF" : "#ff4a52");
      const l = new THREE.PointLight(colr, id.startsWith("sign_") ? 1.0 : 1.6, 5.5, 2); l.position.copy(p); root.add(l);
    }
    return root;
  };

  return { material, instance, built, nature, ready: async () => { await Promise.all(pending); } };
}

export function applyMaterials(mesh: THREE.Mesh, resolve: (name: string) => THREE.Material | null): void {
  if (!mesh.isMesh) return;
  const swap = (m: THREE.Material) => resolve(m.name) ?? m;
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  const m = mesh.material as THREE.Material;
  const emissive = (m as THREE.ShaderMaterial).isShaderMaterial || /lantern|toro|neon|interior/.test(m.name);
  mesh.castShadow = !emissive; mesh.receiveShadow = true;
}

/**
 * Moat / gutter / basin water: dark, mirror-smooth, OPAQUE so it can write the SSR reflectivity
 * mask (a transparent surface's alpha is its blend factor, not free for the mask). Koi swim with
 * their backs at the surface; reflections come from the zone probe + SSR.
 */
export function waterMaterial(rig: WetnessRig): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ name: "kv3_water", color: 0x0a1418, roughness: 0.04, metalness: 0 });
  patchWetness(m, { porosity: 0, wetRough: 0.04, puddle: true }, rig);
  m.userData.kvNoRainOcc = true;
  return m;
}
