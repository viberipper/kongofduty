/**
 * client/src/gpu-backend.ts — WEBGPU + RENDERER ABSTRACTION.
 * ============================================================================
 *
 * STATUS (Oct 2026, three r187 vendored under client/vendor/three):
 *  - build/three.webgpu.js provides the WebGPURenderer (import "three/webgpu"),
 *    build/three.tsl.js the TSL node system (import "three/tsl"),
 *    examples/jsm/tsl/* the TSL display/pass nodes (BloomNode, GTAONode, …).
 *  - ACTIVE: 'auto'/'webgpu' create a WebGPURenderer (async init), 'webgl'
 *    the previous WebGL2 path (WebGLRenderer + EffectComposer). If the
 *    WebGPU initialisation fails, createRenderer() falls back to WebGL2 —
 *    with a console warning, never with a black canvas.
 *
 * DONE: the post chain runs on both paths (WebGL: EffectComposer/
 * RenderPass/ContactAO/BloomPass/MotionBlurPass/CINEMATIC; WebGPU:
 * TSL render pipeline in webgpu-pipeline.ts, same order and same
 * switches). The WebGPU path uses the backend's native float depth
 * (reversedDepthBuffer, see createRenderer) — the split viewmodel pass from
 * depth-precision.ts is obsolete there.
 */

import * as THREE from "three";
import { depthRendererOptions } from "./depth-precision";

export type GpuBackendPref = "auto" | "webgpu" | "webgl";
export type GpuBackendActive = "webgpu" | "webgl";

export interface GpuCapability {
  /** navigator.gpu exists (WebGPU API present in the browser). */
  webgpuApi: boolean;
  /** The vendored three build provides a WebGPURenderer (r187: yes). */
  threeWebgpuRenderer: boolean;
  /** The renderer actually used by this build. */
  active: GpuBackendActive;
  /** One-liner for console/QA. */
  reason: string;
}

/**
 * Minimal surface of the WebGPURenderer that game.ts uses on the union type.
 * Structural (no static three/webgpu import): the 2.3 MB
 * WebGPU build is only loaded via dynamic import when the
 * WebGPU path is actually chosen — the WebGL boot pays nothing.
 */
export interface WebGpuRenderer {
  readonly isWebGPURenderer: true;
  readonly domElement: HTMLCanvasElement;
  shadowMap: { enabled: boolean; type: number };
  toneMapping: number;
  toneMappingExposure: number;
  outputColorSpace: unknown;
  init(): Promise<void>;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setPixelRatio(pr: number): void;
  setSize(w: number, h: number): void;
  getPixelRatio(): number;
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
  getMaxAnisotropy(): number;
}

export type AnyRenderer = THREE.WebGLRenderer | WebGpuRenderer;

/** Type guard for the WebGPU branch (renderer + PMREM + aniso). */
export function isWebGpuRenderer(r: AnyRenderer): r is WebGpuRenderer {
  return (r as { isWebGPURenderer?: unknown }).isWebGPURenderer === true;
}

let cached: GpuCapability | null = null;
// Result of the one-off WebGPURenderer probe import (null = never probed).
let probed: { found: boolean; reason: string } | null = null;

/** Whether a WebGPU API exists in the browser (says nothing about three support). */
export function hasWebGpuApi(): boolean {
  // NIT 4 (3rd review): typeof guard BEFORE any dereference (tests/SSR
  // without a navigator environment); the typed cast (m5) stays for the
  // untyped gpu property.
  try {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as unknown as { gpu?: unknown };
    return !!nav.gpu;
  } catch {
    return false;
  }
}

/**
 * Loads the vendored WebGPURenderer via dynamic import (Vite alias
 * three/webgpu → vendor/three/build/three.webgpu.js). Result cached:
 * one import, one 2.3 MB chunk, then the module cache.
 */
export async function probeThreeWebGpu(): Promise<{ found: boolean; reason: string }> {
  if (probed) return probed;
  try {
    const m = (await import("three/webgpu")) as unknown as { WebGPURenderer?: unknown };
    probed = m.WebGPURenderer
      ? { found: true, reason: "WebGPURenderer vendored (three r187)" }
      : { found: false, reason: "three/webgpu without WebGPURenderer export" };
  } catch (e) {
    probed = { found: false, reason: `WebGPURenderer import failed (${String(e instanceof Error ? e.message : e)})` };
  }
  return probed;
}

/** Capability report, built once per page load. */
export function gpuCapabilities(): GpuCapability {
  if (cached) return cached;
  const webgpuApi = hasWebGpuApi();
  cached = {
    webgpuApi,
    threeWebgpuRenderer: true,
    active: "webgl",
    reason: webgpuApi
      ? "WebGPU API present, three r187 vendored with WebGPURenderer — 'auto'/'webgpu' use WebGPU"
      : "no WebGPU API in this browser — WebGL2 active",
  };
  return cached;
}

/**
 * Resolves the renderer pref to the backend actually used.
 * 'webgl' → always WebGL2 (silently). 'auto'/'webgpu' → WebGPU once
 * the browser API is there AND the probe import finds the vendored WebGPURenderer;
 * otherwise WebGL2 with a console warning.
 */
export async function resolveBackend(pref: GpuBackendPref): Promise<{ active: GpuBackendActive; note: string }> {
  const caps = gpuCapabilities();
  if (pref === "webgl") return { active: "webgl", note: "Renderer pref: WebGL2 (forced)" };
  if (!caps.webgpuApi) {
    if (pref === "webgpu") console.warn("[gpu] Renderer pref 'webgpu', but no WebGPU API in this browser — WebGL2 fallback.");
    return { active: "webgl", note: caps.reason };
  }
  const probe = await probeThreeWebGpu();
  if (probe.found) return { active: "webgpu", note: probe.reason };
  console.warn(`[gpu] ${probe.reason} — fallback to WebGL2.`);
  return { active: "webgl", note: probe.reason };
}

/**
 * Reversed decision: ONLY on real hardware. SwiftShader & co (fallback
 * adapter, WebGL2 backend without EXT_clip_control) cannot do reversed
 * float depth — with reversedDepthBuffer:true EVERYTHING there would go black
 * (wrong clip space, broken depth tests). ?reversed=0|1 forces it.
 */
async function wantReversedDepth(): Promise<boolean> {
  try {
    const q = new URLSearchParams(location.search).get("reversed");
    if (q === "0") return false;
    if (q === "1") return true;
  } catch {
    /* no location override */
  }
  // Automation (headless/SwiftShader): requestAdapter can hang on the
  // GPU-process IPC there and would come back as a fallback adapter — straight
  // to standard depth, without blocking the boot. Real hardware (user PC)
  // has webdriver=false and runs through the normal probing below.
  try {
    if ((navigator as unknown as { webdriver?: boolean }).webdriver) return false;
  } catch {
    /* no navigator (SSR) → caught below */
  }
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter?: (o?: unknown) => Promise<{ info?: unknown }> } }).gpu;
    if (!gpu?.requestAdapter) return false;
    const probe = (async () => {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return null;
      // adapter.info is an object or a promise of one, depending on spec vintage.
      const info = (await (adapter.info as unknown)) as { isFallbackAdapter?: boolean } | undefined;
      return info ?? {};
    })();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    const info = await Promise.race([probe, timeout]);
    if (!info) return false;
    return (info as { isFallbackAdapter?: boolean }).isFallbackAdapter !== true;
  } catch {
    return false;
  }
}

/**
 * Creates the renderer for the chosen pref (ASYNC: WebGPU needs init).
 * Must only be called while the canvas has NO context yet —
 * a canvas binds exactly one context type (webgl2 vs. webgpu).
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  pref: GpuBackendPref,
): Promise<{ renderer: AnyRenderer; backend: GpuBackendActive; note: string }> {
  const { active, note } = await resolveBackend(pref);
  // Keep the capability report current: from here on the backend is decided.
  gpuCapabilities().active = active;
  if (active === "webgpu") {
    try {
      const { WebGPURenderer } = (await import("three/webgpu")) as unknown as {
        WebGPURenderer: new (opts: Record<string, unknown>) => WebGpuRenderer;
      };
      // antialias:false is NOT a downgrade but the GTAO precondition: the
      // scene pass renders single-sample (PassNode RTs carry no samples),
      // and the TSL pipeline presents via a fullscreen quad — MSAA on
      // the default framebuffer would only smooth its edges (useless).
      // Crucial: with antialias:true, renderer.currentSamples would be 4,
      // and the pass depth texture would (despite the renderTarget back-reference, see
      // webgpu-pipeline.ts) be allocated as texture_depth_multisampled_2d — on
      // which WGSL textureGather (GTAO centre tap) has NO overload →
      // invalid GTAO pipeline + error spam per frame (measured on hardware).
      // With antialias:false every depth is single-sample, whichever path
      // the backend takes to determine samples. 8x CINEMATIC stays
      // WebGL-only (see game.ts/resize).
      // reversedDepthBuffer (real GPUs only, see wantReversedDepth):
      // the backend's native reversed float depth = depth-precision replacement;
      // the split viewmodel pass (WebGL workaround for 24-bit Z without
      // EXT_clip_control) is obsolete on WebGPU.
      // NoToneMapping here: the TSL chain ends in its own renderOutput node,
      // which applies ACES-Filmic + sRGB exactly once. Leaving the renderer on
      // a tone map as well would map twice.
      const reversed = await wantReversedDepth();
      if (!reversed) console.info("[gpu] WebGPU without reversed depth (software adapter or ?reversed=0) — standard depth.");
      const renderer = new WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: reversed, powerPreference: "high-performance" });
      await renderer.init();
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.shadowMap.enabled = true;
      // r185+: PCFSoft is removed on the WebGPU side — PCF is soft there too.
      renderer.shadowMap.type = THREE.PCFShadowMap;
      return { renderer, backend: "webgpu", note: `WebGPU active (${note})` };
    } catch (e) {
      console.warn(`[gpu] WebGPURenderer init failed (${String(e instanceof Error ? e.message : e)}) — WebGL2 fallback.`);
    }
  }
  // WebGL2 path (previous constructor path from game.ts, unchanged):
  // antialias:false is no downgrade — the frame runs through the
  // EffectComposer, MSAA sits on its target (aaSamples).
  // ZERO-FLICKER hook: reversed-Z request + depth-precision repairs.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", ...depthRendererOptions() });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  // Hardware default; game.init() switches off per software tier if needed.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return { renderer, backend: "webgl", note: `WebGL2 active (${note})` };
}

/**
 * PMREM environment from a scene — build-exact: the WebGL build's
 * PMREMGenerator uses WebGLCubeRenderTargets and breaks on a
 * WebGPURenderer; the WebGPU path takes the generator from three/webgpu
 * (needs init(), which createRenderer() has already done).
 */
export async function pmremEnv(
  renderer: AnyRenderer,
  scene: THREE.Scene,
  sigma = 0.04,
  near = 0.1,
  far = 100,
): Promise<THREE.Texture> {
  if (isWebGpuRenderer(renderer)) {
    const { PMREMGenerator } = (await import("three/webgpu")) as unknown as {
      PMREMGenerator: new (r: WebGpuRenderer) => {
        fromScene(s: THREE.Scene, sigma?: number, near?: number, far?: number): { texture: THREE.Texture };
        dispose(): void;
      };
    };
    const pmrem = new PMREMGenerator(renderer);
    try {
      return pmrem.fromScene(scene, sigma, near, far).texture;
    } finally {
      pmrem.dispose();
    }
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    return pmrem.fromScene(scene, sigma, near, far).texture;
  } finally {
    pmrem.dispose();
  }
}

/**
 * Max anisotropy across both renderers: WebGLRenderer carries
 * capabilities.getMaxAnisotropy(), WebGPURenderer getMaxAnisotropy().
 */
export function rendererMaxAnisotropy(renderer: AnyRenderer): number {
  const max = isWebGpuRenderer(renderer) ? renderer.getMaxAnisotropy() : renderer.capabilities.getMaxAnisotropy();
  return Math.min(max, 16);
}

/** Short info for the settings menu / the boot console. */
export function gpuBackendNote(): string {
  return gpuCapabilities().reason;
}
