/**
 * TACTICAL MATERIALS — one PBR material per surface KIND, shared by every gun,
 * hand and prop (one shader program each, one draw call per kind per gun).
 * Colour lives in the vertex colours (black vs FDE polymer, gunmetal vs
 * bronze cerakote, the one yellow accent) so parts of the same kind merge.
 *
 * The micro detail is procedural and tiny (256 px canvases, box-projected at a
 * constant texel size by the PartBuilder): polymer stipple, a hard-anodize
 * grain, a fine parkerized speckle. Roughness variation is what sells metal
 * under a sun, so every metal kind carries a roughness map.
 */
import * as THREE from "three";

export type Kind =
  | "anod" // hard-anodized aluminium: receivers, rails, optic bodies, scope tube
  | "steel" // parkerized / nitrided steel: barrels, pins, muzzle devices, sights
  | "bright" // polished / bead-blasted bare steel: bolt, bolt carrier, chrome inside the port
  | "poly" // glass-filled polymer: grips, stocks, mags, the pistol frame
  | "cera" // cerakote (painted metal, satin): slides, handguards in colour
  | "rubber" // butt pads, grip panels, cheek rests, lens caps
  | "glass" // optic glass (transparent, coated)
  | "glow" // reticles, tritium dots, the fiber front sight (unlit)
  | "brass"; // cartridges

let cache: Record<Kind, THREE.Material> | null = null;

function canvas(n: number): { c: HTMLCanvasElement; x: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  return { c, x: c.getContext("2d")! };
}

/** tiny deterministic PRNG */
export function rng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function tex(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** tileable value noise on a grid of `cells` */
function vnoise(n: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells, fy = (y / n) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => g[((j % cells) + cells) % cells * cells + (((i % cells) + cells) % cells)]!;
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      out[y * n + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
  return out;
}

/** normal map (tileable) from a height field */
function normalFrom(h: Float32Array, n: number, strength: number): THREE.CanvasTexture {
  const { c, x } = canvas(n);
  const img = x.createImageData(n, n);
  const H = (i: number, j: number) => h[((j + n) % n) * n + ((i + n) % n)]!;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const dx = (H(i + 1, j) - H(i - 1, j)) * strength;
      const dy = (H(i, j + 1) - H(i, j - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const k = (j * n + i) * 4;
      img.data[k] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[k + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[k + 2] = (1 / l) * 255;
      img.data[k + 3] = 255;
    }
  x.putImageData(img, 0, 0);
  return tex(c, false);
}

/** roughness map (G channel) from a field, mapped to [lo, hi] */
function roughFrom(f: Float32Array, n: number, lo: number, hi: number): THREE.CanvasTexture {
  const { c, x } = canvas(n);
  const img = x.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = Math.round((lo + (hi - lo) * f[i]!) * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return tex(c, false);
}

/** polymer stipple: dense small bumps (normal) */
function stipple(): THREE.CanvasTexture {
  const n = 256, r = rng(31);
  const h = new Float32Array(n * n);
  for (let k = 0; k < 2600; k++) {
    const cx = r() * n, cy = r() * n, rad = 1.2 + r() * 2.2, amp = 0.5 + r() * 0.5;
    for (let j = -4; j <= 4; j++)
      for (let i = -4; i <= 4; i++) {
        const d = Math.hypot(i, j) / rad;
        if (d >= 1) continue;
        const x = ((Math.round(cx) + i) % n + n) % n, y = ((Math.round(cy) + j) % n + n) % n;
        h[y * n + x] = Math.max(h[y * n + x]!, amp * (1 - d * d));
      }
  }
  return normalFrom(h, n, 1.4);
}

/** metal grain: fine noise + a faint directional brushing */
function grainField(seed: number): Float32Array {
  const n = 256;
  const a = vnoise(n, 64, seed), b = vnoise(n, 16, seed + 7), c = vnoise(n, 4, seed + 13);
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) out[i] = a[i]! * 0.45 + b[i]! * 0.35 + c[i]! * 0.2;
  return out;
}

export function weaponMats(): Record<Kind, THREE.Material> {
  if (cache) return cache;
  const n = 256;
  const gA = grainField(3), gS = grainField(11), gP = grainField(23);
  const stip = stipple();
  const grainN = normalFrom(vnoise(n, 96, 41), n, 0.35);
  const anod = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.5,
    roughness: 1,
    roughnessMap: roughFrom(gA, n, 0.36, 0.48),
    normalMap: grainN,
    normalScale: new THREE.Vector2(0.05, 0.05),
    envMapIntensity: 0.7,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.82,
    roughness: 1,
    roughnessMap: roughFrom(gS, n, 0.34, 0.5),
    normalMap: grainN,
    normalScale: new THREE.Vector2(0.06, 0.06),
    envMapIntensity: 0.85,
  });
  const bright = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 1,
    roughness: 1,
    roughnessMap: roughFrom(gS, n, 0.2, 0.34),
    envMapIntensity: 1.1,
  });
  const poly = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0,
    roughness: 1,
    roughnessMap: roughFrom(gP, n, 0.56, 0.7),
    normalMap: stip,
    normalScale: new THREE.Vector2(0.32, 0.32),
    envMapIntensity: 0.7,
  });
  const cera = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.18,
    roughness: 1,
    roughnessMap: roughFrom(gA, n, 0.44, 0.58),
    normalMap: grainN,
    normalScale: new THREE.Vector2(0.08, 0.08),
    envMapIntensity: 0.7,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0,
    roughness: 0.9,
    normalMap: stip,
    normalScale: new THREE.Vector2(0.6, 0.6),
    envMapIntensity: 0.4,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0,
    roughness: 0.04,
    transparent: true,
    opacity: 0.22,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.6,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const glow = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 1,
    roughness: 0.3,
    envMapIntensity: 1.1,
  });
  cache = { anod, steel, bright, poly, cera, rubber, glass, glow, brass };
  for (const [k, m] of Object.entries(cache)) m.name = `gun-${k}`;
  return cache;
}

/** the shared palette (sRGB hex). Dark and grounded; ONE yellow accent per gun at most. */
export const PAL = {
  anodBlack: 0x1c1d20,
  anodGrey: 0x2d3033,
  gunmetal: 0x2a2c2f,
  steel: 0x3a3d40,
  steelDark: 0x1f2123,
  bright: 0x8d9196,
  polyBlack: 0x1d1e20,
  polyGrey: 0x2c2e30,
  fde: 0x8c7658,
  fdeDark: 0x6f5d45,
  ranger: 0x4a4f3e,
  cerakoteBronze: 0x6b5a45,
  rubber: 0x161718,
  lensTint: 0x6fa0b8,
  lensAmber: 0xd6a35a,
  reticle: 0xff3020,
  tritium: 0x66ff88,
  fiber: 0xff7a1a,
  brass: 0xc9a050,
  brassDark: 0x8e6a2c,
  banana: 0xf2c230,
  white: 0xd8d8d8,
} as const;
