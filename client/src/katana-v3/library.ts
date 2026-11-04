import * as THREE from "three";
import { safeAssetPath, sameOriginManager } from "../asset-base";
import { patchWetness, type WetSpec, type WetnessRig } from "./wetness";
import { patchRadialRake, type RakeCircle } from "./rake";

/**
 * KATANA v3 material library — runtime side.
 *
 * Loads public/assets/katana/v3/tex/manifest.json (written by
 * scripts/katana-v3/fetch-textures.mjs) and turns a set name into a lit
 * MeshStandardMaterial with the shared wetness patch. Map convention:
 *   _c    sRGB base colour            -> map
 *   _n    OpenGL tangent normal       -> normalMap (flipY=false like every katana set)
 *   _ormh linear AO/rough/metal/height -> aoMap (R), roughnessMap (G), metalnessMap (B);
 *         A = height, read by the wetness patch so puddles flood joints first.
 * UVs are expected in world metres (1 UV unit = 1 m); the material repeats every
 * `tile_m` metres. Textures are cloned per repeat, which shares the GPU upload
 * (one THREE.Source per file).
 */
export type V3Set = {
  family: string;
  size: [number, number];
  tile_m: number;
  files: Record<string, string>;
  wet: WetSpec;
  panel_m?: [number, number];
  /** "ormh.B": paper transmission lives in the metal channel (shoji) */
  transmission?: string;
  /** foliage cards: c.A is a cutout */
  cutout?: string;
};
export type V3Manifest = { sets: Record<string, V3Set>; hdri: Record<string, { file: string; role: string }>; util: Record<string, { file: string }> };

export type V3Library = {
  manifest: V3Manifest;
  base: string;
  textures: Map<string, THREE.Texture>;
  util: { puddle: THREE.Texture; streaks: THREE.Texture };
  material: (set: string, opts?: MaterialOpts) => THREE.MeshStandardMaterial;
};

export type MaterialOpts = {
  tint?: THREE.ColorRepresentation;
  /** override metres per repeat (0 = UVs are already 0..1, e.g. a shoji panel) */
  tile?: number;
  normalScale?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  name?: string;
  /** wetness overrides (e.g. a sheltered interior floor: { porosity: 0 }) */
  wet?: Partial<WetSpec>;
  /** gravel_raked only: ring-rake circles (world x/z, radius m) + straight rake direction (deg) */
  rake?: { circles: RakeCircle[]; angleDeg?: number };
};

export async function loadV3Library(renderer: THREE.WebGLRenderer, base: string, rig: WetnessRig, low = false): Promise<V3Library> {
  const manifest = (await (await fetch(`${base}/manifest.json`)).json()) as V3Manifest;
  // Defense-in-depth: manifest key paths are plain filenames inside `base` —
  // fail fast instead of fetching a tampered manifest's `..` / `:` / URLs.
  for (const set of Object.values(manifest.sets)) {
    for (const f of Object.values(set.files)) {
      if (!safeAssetPath(f)) throw new Error(`v3 library: rejected manifest path ${JSON.stringify(f)}`);
    }
  }
  for (const u of Object.values(manifest.util)) {
    if (!safeAssetPath(u.file)) throw new Error(`v3 library: rejected manifest path ${JSON.stringify(u.file)}`);
  }
  const loader = new THREE.TextureLoader(sameOriginManager());
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), low ? 4 : 16);
  const textures = new Map<string, THREE.Texture>();
  const get = async (file: string, srgb: boolean): Promise<THREE.Texture> => {
    const t = await loader.loadAsync(`${base}/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    textures.set(file, t);
    return t;
  };
  const jobs: Promise<unknown>[] = [];
  for (const set of Object.values(manifest.sets)) {
    for (const kind of ["c", "n", "ormh"] as const) {
      const f = set.files[low ? `${kind}-low` : kind] ?? set.files[kind]!;
      jobs.push(get(f, kind === "c"));
    }
  }
  if (manifest.util.chochin) jobs.push(get(manifest.util.chochin.file, true).then((t) => { t.wrapT = THREE.ClampToEdgeWrapping; textures.set("chochin", t); }));
  const puddleP = get(manifest.util.puddle_field!.file, false);
  const streakP = get(manifest.util.rain_streaks!.file, false);
  await Promise.all(jobs);
  const util = { puddle: await puddleP, streaks: await streakP };
  rig.uniforms.uKvPuddleField.value = util.puddle;
  rig.uniforms.uKvStreaks.value = util.streaks;

  const material = (key: string, opts: MaterialOpts = {}): THREE.MeshStandardMaterial => {
    const set = manifest.sets[key];
    if (!set) throw new Error(`v3 library: no set ${key}`);
    const file = (k: string) => textures.get(set.files[low ? `${k}-low` : k] ?? set.files[k]!)!;
    const tile = opts.tile ?? (set.panel_m ? 0 : set.tile_m);
    const rep = (t: THREE.Texture) => {
      const c = t.clone();
      if (tile > 0) c.repeat.setScalar(1 / tile);
      c.needsUpdate = true;
      return c;
    };
    const orm = rep(file("ormh"));
    const m = new THREE.MeshStandardMaterial({
      name: opts.name ?? `kv3_${key}`,
      map: rep(file("c")),
      normalMap: rep(file("n")),
      aoMap: orm,
      aoMapIntensity: 1,
      roughnessMap: orm,
      metalnessMap: orm,
      roughness: 1,
      metalness: 1,
      color: new THREE.Color(opts.tint ?? 0xffffff),
    });
    m.normalScale.setScalar(opts.normalScale ?? 1);
    if (opts.emissive !== undefined) {
      m.emissive.set(opts.emissive);
      m.emissiveIntensity = opts.emissiveIntensity ?? 1;
    }
    if (set.transmission) { m.side = THREE.DoubleSide; m.metalness = 0; }
    if (set.family === "cloth") m.side = THREE.DoubleSide;
    if (set.cutout) { m.side = THREE.DoubleSide; m.alphaTest = 0.5; m.alphaToCoverage = true; m.metalness = 0; }
    patchWetness(m, { ...set.wet, ...opts.wet }, rig, { transmission: !!set.transmission, cutout: !!set.cutout });
    if (opts.rake) patchRadialRake(m, opts.rake.circles, tile || 1, opts.rake.angleDeg ?? 0);
    return m;
  };

  return { manifest, base, textures, util, material };
}
