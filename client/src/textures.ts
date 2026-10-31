import * as THREE from "three";
import { isWebGpuRenderer, type AnyRenderer } from "./gpu-backend";
import { assetUrl } from "./asset-base";

const cache = new Map<string, THREE.CanvasTexture>();

/**
 * Anisotropic filtering level for EVERY sampled texture in the game.
 *
 * 16 is the hardware maximum on every desktop GPU that reports the extension
 * (and three clamps the request down to `capabilities.getMaxAnisotropy()` before
 * it reaches GL, so asking for 16 always resolves to the renderer's real max —
 * never an unsupported value). It was 8 on the procedural surfaces and 1 on
 * every hand-built CanvasTexture, which is why dirt, the yard's worn-path
 * overlay and the leaf cards turned to mush the moment the camera looked ALONG
 * a surface instead of at it — the single loudest "low resolution" cue in the
 * frame. Measured cost of 8 -> 16 across the whole scene: within noise
 * (qa/out/4k/measurements.json).
 */
export const ANISO = 16;

let softwareGL: boolean | null = null;

/**
 * needsUpdate for a texture clone whose image is still loading (or never
 * arrives on 404). Bumping right after `clone()` is harmless on WebGL but
 * fatal on WebGPU: `version > 0` + `image === null` crashes the backend
 * upload with a TypeError (`image.complete` of null — upstream
 * only checks `undefined`, see three.webgpu.js updateTexture). With no
 * bump at all the clone would instead sit on the default texture forever
 * (version 0 never uploads). So: bump immediately if the image is already
 * there — otherwise backfill on arrival (a shared source carries the image
 * into the clone). 404s stay on the default texture instead of crashing.
 */
export function armTextureClone(c: THREE.Texture): void {
  const img = c.image as { complete?: boolean } | null | undefined;
  if (img && img.complete !== false) {
    c.needsUpdate = true;
    return;
  }
  // Image in flight (or 404): wait for arrival. Poll instead of events — no
  // loader rebuild needed, headless-safe (no rAF), ~200 null checks at 50 ms
  // cost nothing; give up after ~10 s (permanent failure = default texture).
  let tries = 0;
  const tick = (): void => {
    const cur = c.image as { complete?: boolean } | null | undefined;
    if (cur && cur.complete !== false) {
      c.needsUpdate = true;
      return;
    }
    if (++tries < 200) setTimeout(tick, 50);
  };
  tick();
}

/**
 * True when this WebGL context is a SOFTWARE rasteriser (SwiftShader, llvmpipe,
 * Microsoft Basic Render) rather than a GPU.
 *
 * It is not a test-only concern: a browser with no usable GPU — a VM, a
 * blocklisted driver, a locked-down laptop — silently falls back to one, and on
 * a CPU every MSAA sample is a real fragment shaded again. MEASURED on this
 * scene at 1600x900: 4x MSAA costs +0.15 ms on the GPU and +890 ms per frame on
 * SwiftShader, and a 4096 shadow map +180 ms. The whole headless instrument
 * suite runs on SwiftShader, so shipping MSAA unconditionally does not just make
 * those clients unplayable — it starves the fixed-step sim clock behind every
 * qa/ journey (qa/e2e.mjs' death -> killcam -> respawn beat stops fitting in its
 * 60 s budget). Both users get the frame they can afford instead.
 */
export function isSoftwareGL(renderer: AnyRenderer): boolean {
  // WebGPU needs a real GPU device — there is no software tier there.
  if (isWebGpuRenderer(renderer)) return false;
  if (softwareGL !== null) return softwareGL;
  // QA captures: `?gpu=force` renders the real-GPU path on a software
  // rasteriser so headless review frames show what players see.
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("gpu") === "force") return (softwareGL = false);
  const gl = (renderer as THREE.WebGLRenderer).getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  // Privacy settings can withhold the string; an unknown GPU is assumed real,
  // which is the right default for a machine that is probably a real machine.
  const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "") : "";
  softwareGL = /swiftshader|softwarerast|llvmpipe|basic render/i.test(name);
  return softwareGL;
}

/**
 * MSAA samples for the composer's HDR buffer — the game's real anti-aliasing,
 * and the single knob that decides whether the foliage cutouts get
 * `alphaToCoverage` (which is meaningless without a multisampled target).
 * MEASURED per level on the real GPU (qa/out/4k/measurements.json): 4x is
 * +0.15 ms p50 at DPR 1 while 8x is +1.6 ms; at DPR >= 1.5 a pixel is already
 * half the size, so 2x holds the fill budget on retina.
 *
 * 0 here means "no MULTISAMPLING", NOT "no anti-aliasing": Game.init() adds an
 * FXAA pass (ShaderPass(FXAAShader)) after the grade whenever this returns 0
 * (unless ?fxaa=0 drops it for bisection), because a software client (and every
 * headless qa/ contact sheet, which is judged by eye) must still get smooth
 * edges. Never treat this returning 0 as permission to ship a raw staircase.
 */
export function aaSamples(renderer: AnyRenderer): number {
  // WebGPU path: TSL pipeline (no composer target) — the scene runs through
  // the render pipeline; the 0 here only means "no composer", not "no AA".
  if (isWebGpuRenderer(renderer)) return 0;
  if (isSoftwareGL(renderer)) return 0;
  return renderer.getPixelRatio() <= 1.25 ? 4 : 2;
}

/**
 * Raise every texture reachable from `root` to ANISO, mipmaps included.
 *
 * The canvas-authored surfaces set their own filtering, but textures that
 * arrive INSIDE a .glb do not: GLTFLoader leaves anisotropy at three's default
 * of 1, so the authored statement props, the operator and the viewmodel — the
 * three things the player's eye is closest to — were the blurriest things in
 * the frame at any oblique angle. Called once per load, on graphs that are
 * already built, so it costs one traversal and never touches the actors' or the
 * viewmodel's own code.
 */
export function maxAnisotropy(root: THREE.Object3D): number {
  const seen = new Set<THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mat of mats) {
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "bumpMap"] as const) {
        const t = (mat as unknown as Record<string, THREE.Texture | null>)[key];
        if (!t || seen.has(t) || t.anisotropy >= ANISO) continue;
        seen.add(t);
        t.anisotropy = ANISO;
        t.needsUpdate = true;
      }
    }
  });
  return seen.size;
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d", { willReadFrequently: true })! };
}

function wrap(c: HTMLCanvasElement, repeat = 1, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = ANISO;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function hash(x: number, y: number, s: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, s: number, oct = 5): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    v += vnoise(x * f, y * f, s + i * 19.1) * a;
    a *= 0.5;
    f *= 2.05;
  }
  return v;
}

function memo(key: string, build: () => THREE.CanvasTexture): THREE.CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const t = build();
  cache.set(key, t);
  return t;
}

export function texMetal(): THREE.CanvasTexture {
  return memo("metal", () => {
    const { c, ctx } = canvas(512, 512);
    const img = ctx.createImageData(512, 512);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const brush = vnoise(x * 0.9, y * 0.04, 2.2);
        const pit = fbm(x * 0.08, y * 0.08, 8, 4);
        const v = 28 + brush * 22 + pit * 18;
        const i = (y * 512 + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v + 1;
        img.data[i + 2] = v + 3;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 2);
  });
}

export function texPolymer(hex = "#3a3834"): THREE.CanvasTexture {
  return memo("poly-" + hex, () => {
    const { c, ctx } = canvas(512, 512);
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 512, 512);
    const img = ctx.getImageData(0, 0, 512, 512);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const n = fbm(x * 0.12, y * 0.12, 3.4, 4);
        const speckle = hash(x, y, 1) > 0.94 ? 18 : 0;
        const i = (y * 512 + x) * 4;
        const d = (n - 0.5) * 28 + speckle;
        img.data[i] = Math.max(0, Math.min(255, img.data[i]! + d));
        img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + d));
        img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + d * 0.8));
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 2);
  });
}

export function texWood(): THREE.CanvasTexture {
  return memo("wood", () => {
    const { c, ctx } = canvas(512, 512);
    const img = ctx.createImageData(512, 512);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const g = fbm(x * 0.015, y * 0.18, 1.1, 5);
        const ring = Math.sin((x * 0.04 + g * 6) * Math.PI) * 0.5 + 0.5;
        const r = 92 + ring * 48 + g * 20;
        const gv = 52 + ring * 22;
        const b = 24 + ring * 10;
        const i = (y * 512 + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = gv;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 1);
  });
}

export function texPaint(hex: string): THREE.CanvasTexture {
  return memo("paint-" + hex, () => {
    const { c, ctx } = canvas(512, 512);
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 512, 512);
    const img = ctx.getImageData(0, 0, 512, 512);
    const rust = hex.startsWith("#8") || hex.startsWith("#a") || hex.startsWith("#6");
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const dirt = fbm(x * 0.05, y * 0.05, 4.2, 4);
        const streak = vnoise(x * 0.14, y * 0.012, 9);
        const flake = hash(x * 0.5, y * 0.5, 2);
        const i = (y * 512 + x) * 4;
        let r = img.data[i]!;
        let g = img.data[i + 1]!;
        let b = img.data[i + 2]!;
        const d = (dirt - 0.5) * 14;
        r += d;
        g += d;
        b += d;
        if (streak > 0.72) {
          r += 18;
          g += 8;
          b -= 6;
        }
        if (rust && flake > 0.97) {
          r = 110 + flake * 40;
          g = 48;
          b = 22;
        }
        img.data[i] = Math.max(0, Math.min(255, r));
        img.data[i + 1] = Math.max(0, Math.min(255, g));
        img.data[i + 2] = Math.max(0, Math.min(255, b));
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 1);
  });
}

export function texConcrete(): THREE.CanvasTexture {
  return memo("concrete", () => {
    const { c, ctx } = canvas(512, 512);
    const img = ctx.createImageData(512, 512);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const n = fbm(x * 0.04, y * 0.04, 0.7, 6);
        const grit = hash(x, y, 3);
        const jointX = Math.min(x % 128, 128 - (x % 128));
        const jointY = Math.min(y % 128, 128 - (y % 128));
        const joint = jointX < 2 || jointY < 2 ? -22 : 0;
        const v = 96 + n * 38 + grit * 10 + joint;
        const i = (y * 512 + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v - 2;
        img.data[i + 2] = v - 6;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 8);
  });
}

export function texFabric(hex = "#2a2e26"): THREE.CanvasTexture {
  return memo("fab-" + hex, () => {
    const { c, ctx } = canvas(256, 256);
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 256, 256);
    const img = ctx.getImageData(0, 0, 256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const weave = ((x + y) % 3 === 0 ? 10 : 0) + ((x * 2 + y) % 5 === 0 ? -8 : 0);
        const n = vnoise(x * 0.2, y * 0.2, 5) * 16;
        const i = (y * 256 + x) * 4;
        img.data[i] = Math.max(0, Math.min(255, img.data[i]! + weave + n));
        img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + weave + n));
        img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + weave + n * 0.7));
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 3);
  });
}

export function texGlove(): THREE.CanvasTexture {
  return memo("glove", () => {
    const { c, ctx } = canvas(256, 256);
    ctx.fillStyle = "#1a1714";
    ctx.fillRect(0, 0, 256, 256);
    const img = ctx.getImageData(0, 0, 256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const n = fbm(x * 0.1, y * 0.1, 6, 4);
        const i = (y * 256 + x) * 4;
        const v = 22 + n * 18;
        img.data[i] = v + 6;
        img.data[i + 1] = v;
        img.data[i + 2] = v - 4;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 2);
  });
}

export function texCrateWood(): THREE.CanvasTexture {
  return memo("cratewood", () => {
    const { c, ctx } = canvas(256, 256);
    const img = ctx.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const plank = Math.floor(y / 42);
        const g = fbm(x * 0.08, y * 0.02 + plank * 8, 2.2, 4);
        const gap = y % 42 < 2 ? -30 : 0;
        const r = 118 + g * 30 + gap;
        const gv = 78 + g * 16 + gap;
        const b = 38 + g * 8 + gap;
        const i = (y * 256 + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = gv;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return wrap(c, 1);
  });
}

export function metalMat(color = 0x2a2c2e, rough = 0.38, metalness = 0.86): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    map: texMetal(),
    roughness: rough,
    metalness,
    envMapIntensity: 0.32,
  });
}

export function polyMat(color = 0x2c2a26, rough = 0.72): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    map: texPolymer(),
    roughness: rough,
    metalness: 0.08,
    envMapIntensity: 0.22,
  });
}

export function woodMat(color = 0x6a4020): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    map: texWood(),
    roughness: 0.78,
    metalness: 0.04,
    envMapIntensity: 0.18,
  });
}

export function glassMat(color = 0x0a1210): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.06,
    metalness: 0.05,
    transmission: 0.35,
    transparent: true,
    opacity: 0.55,
    thickness: 0.02,
    envMapIntensity: 0.55,
  });
}

export function fileTex(url: string, rx = 1, ry = 1): THREE.Texture {
  const t = new THREE.TextureLoader().load(assetUrl(url));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = ANISO;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function fabricMat(color = 0x2a2e26): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    map: fileTex("/assets/textures/nylon-plate.jpg", 4, 4),
    roughness: 0.86,
    metalness: 0.03,
    envMapIntensity: 0.18,
  });
}

export function nylonMat(color = 0x6a5c48): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    map: fileTex("/assets/textures/nylon-plate.jpg", 3, 3),
    roughness: 0.8,
    metalness: 0.05,
    envMapIntensity: 0.2,
  });
}

export function gloveMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x1c1914,
    map: texGlove(),
    roughness: 0.82,
    metalness: 0.04,
    envMapIntensity: 0.3,
  });
}

export function skinMat(hex: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: hex,
    roughness: 0.58,
    metalness: 0.02,
    envMapIntensity: 0.2,
  });
}

const PAINT_URL: Record<string, string> = {
  red: "/assets/textures/paint-red.jpg",
  blue: "/assets/textures/paint-blue.jpg",
  orange: "/assets/textures/paint-orange.jpg",
  green: "/assets/textures/paint-green.jpg",
};

export function paintMat(hex: string, color: number, key?: string): THREE.MeshStandardMaterial {
  const url = key ? PAINT_URL[key] : undefined;
  return new THREE.MeshStandardMaterial({
    color,
    map: url ? fileTex(url, 1.6, 1.6) : texPaint(hex),
    roughness: 0.56,
    metalness: 0.16,
    envMapIntensity: 0.45,
  });
}

export function concreteTex(): THREE.Texture {
  return fileTex("/assets/textures/conc-tile.jpg", 7, 7);
}
