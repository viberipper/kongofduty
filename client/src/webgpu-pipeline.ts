/**
 * client/src/webgpu-pipeline.ts — TSL POST CHAIN FOR THE WEBGPU PATH.
 * ============================================================================
 *
 * Mirrors the WebGL chain order exactly (game.ts/buildComposer):
 *
 *   scene (pass) → AO (GTAO, hardware tier) → selective HDR bloom →
 *   [afterimage (opt-in)] → CINEMATIC grade as a custom Fn node (maths 1:1
 *   from cinematic.ts, tonemapping+sRGB included, NO RenderOutput around it —
 *   a RenderOutputNode would convert working→sRGB a second time) →
 *   [FXAA (both tiers, needs sRGB input)].
 *
 * BUNDLE DISCIPLINE: this file is loaded ONLY via dynamic import() from game.ts
 * (init()'s WebGPU branch). Every three/webgpu, three/tsl and
 * three/addons/tsl import in here is dynamic — the WebGL boot pays
 * not a single byte of it (separate three.webgpu chunk, see build output).
 * Only "three" (main graph) is static here, for types/constants.
 *
 * TONEMAPPING DECISION (no double tonemapping): the grade node does
 * tonemapping (ACES approximation) AND sRGB encoding itself, 1:1 from cinematic.ts.
 * The renderer runs on NoToneMapping, and there is NO RenderOutputNode
 * around the grade — it would convert working→sRGB again
 * (double encoding). Only the ?nograde debug path uses renderOutput
 * (there it is the only sRGB conversion).
 *
 * REBUILD RULE (WebGL m2 analogue): the scene pass survives structural changes
 * — only an MRT change (AO on/off) rebuilds it (fresh pass with an
 * MRT that is correct from the start instead of half-allocated targets). Bloom/afterimage
 * nodes are relinked on structural changes — sliders (strength, exposure,
 * chroma …) only write uniforms and recompile nothing.
 *
 * OPEN (no crash, wrong look — TSL port pending): custom
 * ShaderMaterials have NO equivalent in three's StandardNodeLibrary and
 * fall back to an empty NodeMaterial ("not compatible" warning per
 * material). Affected: weapon FX (tracers/muzzle/smoke/decals), nade/boom/
 * nuke FX, Ares reactor core (+ sky extras), Nuketown sky shader. The post passes
 * (bloom/motion/ssao) are NOT affected — they only run on WebGL,
 * TSL nodes take over here.
 *
 * DELIBERATE NUANCES (not bugs, documented):
 *  - Nuketown height fog: the WebGL ContactAO excludes Nuketown's height fog
 *    from the AO (setHeightFog). GTAO does not know the custom fog — on the
 *    WebGPU path AO occludes across the fog. A subtle difference in dense fog,
 *    no flicker.
 *  - TSL bloom has no soft knee (smoothWidth 0.01 instead of knee 0.25, but an
 *    internal mip chain) — threshold (1.0) and default strength (0.35) are
 *    identical to bloom.ts.
 *  - Afterimage instead of blend+clamp: the WebGL MotionBlurPass mixes exponentially
 *    with a 3x3 neighbourhood clamp (no ghost blocks); AfterImageNode holds
 *    bright pixels via max-hold (damp 0.7 ≈ 3–4 frames). Opt-in, default OFF.
 *  - MSAA: the scene pass renders single-sample (PassNode RTs carry no
 *    samples); renderer antialias only applies on the default framebuffer.
 *    True MSAA would need samples on the pass RTs — which the GTAO centre tap
 *    (textureGather on a multisampled depth texture) does not support, see
 *    gpu-backend.ts. Edges are therefore resolved by the FXAA tail after the
 *    grade, on the software AND the hardware tier (?fxaa=0 drops it).
 *    8x CINEMATIC stays WebGL-only (see game.ts/resize).
 *  - AO resolution: GTAO runs full-res (resolutionScale 1), the WebGL
 *    ContactAO half-res with bilateral denoise blur — a different
 *    cost/quality point, same classification (hardware tier only).
 */

import * as THREE from "three";

/** Minimal surface the pipeline needs from the renderer (duck-typed — the
 *  WebGPURenderer is not a THREE.WebGLRenderer, see gpu-backend.ts). */
export interface WebgpuCanvasRenderer {
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
}
/** Live switches of the pipeline — one snapshot per setGraphicsOptions(). */
export interface WebgpuPrefsSnapshot {
  bloom: boolean;
  bloomStrength: number;
  ao: boolean;
  aoStrength: number;
  chromatic: boolean;
  grain: boolean;
  vignette: boolean;
  motionBlur: boolean;
  dof: boolean;
  sharpen: number;
  /** Effective value (map basis × slider), as game.ts also hands to the grade. */
  exposure: number;
  hurt?: number;
}

/**
 * Minimal structural type for TSL nodes (methods the grade chain uses).
 * Deliberately local — no static three/webgpu type import (bundle discipline).
 */
export interface TslNode {
  add(v: unknown): TslNode;
  sub(v: unknown): TslNode;
  mul(v: unknown): TslNode;
  div(v: unknown): TslNode;
  greaterThan(v: unknown): TslNode;
  lessThan(v: unknown): TslNode;
  sample(uv: unknown): TslNode;
  assign(v: unknown): void;
  toVar(): TslNode;
  readonly rgb: TslNode;
  readonly r: TslNode;
  readonly g: TslNode;
  readonly b: TslNode;
  readonly x: TslNode;
  readonly y: TslNode;
  readonly z: TslNode;
}

interface TslUniform {
  value: number;
}

interface TslApi {
  Fn(fn: () => unknown): () => unknown;
  uniform(v: number): TslUniform;
  vec2(x: unknown, y: unknown): TslNode;
  vec3(x: unknown, y: unknown, z: unknown): TslNode;
  vec4(rgb: unknown, a: unknown): TslNode;
  float(v: number): TslNode;
  If(cond: unknown, then: () => void): unknown;
  and(a: unknown, b: unknown): unknown;
  or(a: unknown, b: unknown): unknown;
  dot(a: unknown, b: unknown): TslNode;
  mix(a: unknown, b: unknown, t: unknown): TslNode;
  min(a: unknown, b: unknown): TslNode;
  max(a: unknown, b: unknown): TslNode;
  pow(a: unknown, b: unknown): TslNode;
  fract(v: unknown): TslNode;
  sin(v: unknown): TslNode;
  smoothstep(e0: number, e1: number, x: unknown): TslNode;
  uv(): TslNode;
  convertToTexture(node: unknown): TslNode;
  pass(scene: THREE.Scene, camera: THREE.Camera): PassApi;
  mrt(targets: Record<string, unknown>): unknown;
  output: unknown;
  normalView: unknown;
  renderOutput(color: unknown, toneMapping: unknown, colorSpace: unknown): TslNode;
}

interface PassApi {
  setMRT(mrt: unknown): PassApi;
  getTextureNode(name?: string): TslNode;
  /** Internal RT (size follows the renderer on its own, see updateBefore). */
  renderTarget: {
    depthTexture?: { renderTarget?: unknown } | null;
    samples?: number;
  } | null;
}

/** QA bypass (?pipeline=nograde): chain without the grade fn (scene → render output)
 * for bisection (picture here, black otherwise = grade node). */
function qaNoGrade(): boolean {
  try {
    return new URLSearchParams(location.search).get("pipeline") === "nograde";
  } catch {
    return false;
  }
}

/** QA diagnosis (?ldr=1): scene pass with UnsignedByte instead of HalfFloat — shows
 * whether black comes from the backend's float RTs (e.g. SwiftShader) or from the
 * chain itself. Not a look path (HDR is lost), debugging only. */
function qaLdr(): boolean {
  try {
    return new URLSearchParams(location.search).get("ldr") === "1";
  } catch {
    return false;
  }
}

/** QA killswitch as on WebGL (?ssao=0, alias ?ntao=0): never build AO. */
function qaAoOff(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    return q.get("ssao") === "0" || q.get("ntao") === "0";
  } catch {
    return false;
  }
}

/** QA killswitch (?nobloom=1): never build bloom (bisection white: bloom vs. grade). */
function qaBloomOff(): boolean {
  try {
    return new URLSearchParams(location.search).get("nobloom") === "1";
  } catch {
    return false;
  }
}

/** QA killswitch (?fxaa=0): drop the FXAA tail (bisection edges vs. grade). */
function qaFxaaOff(): boolean {
  try {
    return new URLSearchParams(location.search).get("fxaa") === "0";
  } catch {
    return false;
  }
}

export class WebgpuPipeline {
  private renderer: WebgpuCanvasRenderer;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private pipe: {
    outputNode: unknown;
    outputColorTransform: boolean;
    needsUpdate: boolean;
    render(): void;
  };
  private api!: TslApi;
  private lib!: {
    NoToneMapping: unknown;
    SRGBColorSpace: unknown;
  };
  private fx!: {
    bloom(node: unknown, strength: unknown, radius: number, threshold: number): TslNode;
    ao(depth: unknown, normal: unknown, camera: THREE.Camera): TslNode & { dispose?: () => void };
    afterImage(node: unknown, damp: unknown): TslNode & { dispose?: () => void };
    fxaa(node: unknown): TslNode;
  };

  private scenePass: PassApi | null = null;
  private aoNode: (TslNode & { dispose?: () => void }) | null = null;
  private bloomNode: (TslNode & { dispose?: () => void }) | null = null;
  private afterNode: (TslNode & { dispose?: () => void }) | null = null;
  /** Whether the living scene pass carries MRT normals (change = pass rebuild). */
  private mrtOn = false;

  private uTime!: TslUniform;
  private uHurt!: TslUniform;
  private uAds!: TslUniform;
  private uExposure!: TslUniform;
  private uChroma!: TslUniform;
  private uGrain!: TslUniform;
  private uVignette!: TslUniform;
  private uSharpen!: TslUniform;
  private uDof!: TslUniform;
  private uDofStrength!: TslUniform;
  private uTexelX!: TslUniform;
  private uTexelY!: TslUniform;
  private uAoStrength!: TslUniform;
  private uBloomStrength!: TslUniform;
  private uDamp!: TslUniform;
  private uSaturation!: TslUniform;
  private uContrast!: TslUniform;
  private uWarmth!: TslUniform;

  private useFxaa: boolean;
  private aoForceOff = false;
  /** Structural key (ao/bloom/motion on-off) — rebuild only then. */
  private builtKey = "";

  private constructor(
    renderer: WebgpuCanvasRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    pipe: WebgpuPipeline["pipe"],
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.pipe = pipe;
    // Hardware WebGPU had NO edge AA at all: antialias:false is a GTAO
    // precondition and the pass RTs are single-sample (see the header), so the
    // fullscreen quad presented stair-stepped edges while the WebGL path pays
    // 4x/2x MSAA on the composer targets. The FXAA tail — sRGB input, one
    // fullscreen pass — is the cheap hardware answer and now runs on both
    // tiers. ?fxaa=0 drops it for bisection; the flag is read once here, so it
    // needs a page reload to take effect.
    this.useFxaa = !qaFxaaOff();
    this.aoForceOff = qaAoOff();
  }

  /**
   * Factory (async): loads three/webgpu + three/tsl + display nodes LAZY and
   * builds the chain. May only run once the WebGPURenderer is initialised
   * (game.ts/createRenderer handles that).
   */
  static async create(
    renderer: WebgpuCanvasRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): Promise<WebgpuPipeline> {
    const [webgpu, tsl, bloomM, aoM, afterM, fxaaM] = await Promise.all([
      import("three/webgpu") as Promise<{
        RenderPipeline: new (renderer: unknown, outputNode?: unknown) => WebgpuPipeline["pipe"];
        NoToneMapping: unknown;
        SRGBColorSpace: unknown;
      }>,
      import("three/tsl") as Promise<Record<string, unknown>>,
      import("three/addons/tsl/display/BloomNode.js") as Promise<{ bloom: WebgpuPipeline["fx"]["bloom"] }>,
      import("three/addons/tsl/display/GTAONode.js") as Promise<{ ao: WebgpuPipeline["fx"]["ao"] }>,
      import("three/addons/tsl/display/AfterImageNode.js") as Promise<{ afterImage: WebgpuPipeline["fx"]["afterImage"] }>,
      import("three/addons/tsl/display/FXAANode.js") as Promise<{ fxaa: WebgpuPipeline["fx"]["fxaa"] }>,
    ]);
    const api = tsl as unknown as TslApi;
    const pipe = new webgpu.RenderPipeline(renderer as unknown, undefined);
    // Manual output control (see file header): the grade maps itself,
    // RenderOutput only contributes the sRGB conversion.
    pipe.outputColorTransform = false;
    const self = new WebgpuPipeline(renderer, scene, camera, pipe);
    self.api = api;
    self.lib = webgpu as unknown as WebgpuPipeline["lib"];
    self.fx = {
      bloom: bloomM.bloom,
      ao: aoM.ao,
      afterImage: afterM.afterImage,
      fxaa: fxaaM.fxaa,
    };
    self.buildUniforms();
    self.scenePass = api.pass(scene, camera);
    self.applyPrefs({
      bloom: false,
      bloomStrength: 0,
      ao: false,
      aoStrength: 0.7,
      chromatic: false,
      grain: true,
      vignette: true,
      motionBlur: false,
      dof: false,
      sharpen: 0,
      exposure: 1.12,
    });
    return self;
  }

  private buildUniforms(): void {
    const T = this.api;
    this.uTime = T.uniform(0);
    this.uHurt = T.uniform(0);
    this.uAds = T.uniform(0);
    this.uExposure = T.uniform(1.12);
    this.uChroma = T.uniform(0);
    this.uGrain = T.uniform(1);
    this.uVignette = T.uniform(1);
    this.uSharpen = T.uniform(0);
    this.uDof = T.uniform(0);
    // Fixed grade constants of the signed look (as in cinematic.ts —
    // no settings owner, touching = changing the look).
    this.uDofStrength = T.uniform(0.5);
    this.uSaturation = T.uniform(0.97);
    this.uContrast = T.uniform(1.0);
    this.uWarmth = T.uniform(0.5);
    this.uTexelX = T.uniform(1 / 1280);
    this.uTexelY = T.uniform(1 / 720);
    this.uAoStrength = T.uniform(0.7);
    this.uBloomStrength = T.uniform(0);
    this.uDamp = T.uniform(0.7);
  }

  /**
   * CINEMATIC grade as a TSL fn node. Ports the maths from
   * cinematic.ts 1:1 (order + constants): chroma → DOF-lite →
   * CAS-lite → warmth/contrast/slope/saturation → vignette/hurt → grain →
   * RRT/ACES + exposure → sRGB → mid-band depth.
   *
   * Two deliberate micro-deviations (WGSL idioms instead of GLSL idioms):
   *  - sRGB knee via max(power, linear) instead of a bool mask — deviation < 2e-4
   *    in deep black, far below the ±0.004 grain.
   *  - ACES matrices multiplied out (no mat3 API) — exactly the same
   *    coefficients in column-major order as the GLSL constructor.
   */
  private buildGrade(input: TslNode): TslNode {
    const T = this.api;
    const src = input;
    const uTime = this.uTime as unknown as TslNode;
    const uHurt = this.uHurt as unknown as TslNode;
    const uAds = this.uAds as unknown as TslNode;
    const uExposure = this.uExposure as unknown as TslNode;
    const uChroma = this.uChroma as unknown as TslNode;
    const uGrain = this.uGrain as unknown as TslNode;
    const uVignette = this.uVignette as unknown as TslNode;
    const uSharpen = this.uSharpen as unknown as TslNode;
    const uDof = this.uDof as unknown as TslNode;
    const uDofStrength = this.uDofStrength as unknown as TslNode;
    const uSaturation = this.uSaturation as unknown as TslNode;
    const uContrast = this.uContrast as unknown as TslNode;
    const uWarmth = this.uWarmth as unknown as TslNode;

    const grade = T.Fn(() => {
      const uvN = T.uv();
      const tx = T.vec2(this.uTexelX, this.uTexelY);
      const c = uvN.sub(T.vec2(0.5, 0.5));
      const r2 = T.dot(c, c);

      // --- BASIS: linear HDR frame from the scene pass.
      const col = src.sample(uvN).rgb.toVar();

      // --- CHROMATIC ABERRATION: radial, 3-tap (R out, B in), in real
      // pixels (coefficient 4.0 as in cinematic.ts: ~1.4px at the corner).
      T.If(uChroma.greaterThan(0.5), () => {
        const dir = c.mul(r2.mul(4.0)).mul(tx);
        col.assign(
          T.vec3(
            src.sample(uvN.add(dir)).r,
            src.sample(uvN).g,
            src.sample(uvN.sub(dir)).b,
          ),
        );
      });

      // --- DOF-LITE: soft edges (4 diagonal taps), mask = radius squared.
      // px = uTexel * (1 + r2*6) as in cinematic.ts (M4: tap spacing in
      // real pixels) — the +1.0 belongs INSIDE the texel scaling, not in UV.
      T.If(T.and(uDof.greaterThan(0.5), uDofStrength.greaterThan(0.001)), () => {
        const m = T.smoothstep(0.02, 0.42, r2).mul(uDofStrength);
        const px = tx.mul(r2.mul(6.0).add(1.0));
        const tap = (off: TslNode): TslNode => src.sample(uvN.add(off)).rgb;
        const b = tap(px)
          .add(tap(T.vec2(-1, 1).mul(px)))
          .add(tap(T.vec2(1, -1).mul(px)))
          .add(tap(px.mul(-1)))
          .mul(0.25);
        col.assign(T.mix(col, b, m.mul(0.85)));
      });

      // --- SHARPNESS (CAS-lite): luma highpass, taps clamped to [0,2]
      // (no black rings around HDR flashes — see cinematic.ts).
      T.If(uSharpen.greaterThan(0.001), () => {
        const luma = (v: TslNode): TslNode => T.dot(v, T.vec3(0.2126, 0.7152, 0.0722));
        const c0 = T.min(T.max(col, T.vec3(0, 0, 0)), T.vec3(2, 2, 2));
        const l0 = luma(c0);
        const tX = T.vec2(this.uTexelX, 0);
        const tY = T.vec2(0, this.uTexelY);
        const cx = (v: TslNode): TslNode => T.min(T.max(v, T.vec3(0, 0, 0)), T.vec3(2, 2, 2));
        const lx = luma(cx(src.sample(uvN.add(tX)).rgb)).add(luma(cx(src.sample(uvN.sub(tX)).rgb))).mul(0.5);
        const ly = luma(cx(src.sample(uvN.add(tY)).rgb)).add(luma(cx(src.sample(uvN.sub(tY)).rgb))).mul(0.5);
        const hp = T.min(T.max(l0.sub(lx.add(ly).mul(0.5)), -0.25), 0.25);
        col.assign(T.max(T.vec3(0, 0, 0), col.add(T.vec3(hp, hp, hp).mul(uSharpen).mul(0.9))));
      });

      // --- COLOUR GRADE: warmth (warmth 0.5 = neutral), contrast, slope, saturation.
      const warmTint = T.mix(T.vec3(0.93, 1.0, 1.07), T.vec3(1.07, 1.0, 0.93), uWarmth);
      col.assign(col.mul(T.mix(T.vec3(1, 1, 1), warmTint, 0.5)));
      col.assign(col.sub(0.18).mul(uContrast).add(0.18));
      col.assign(col.mul(T.vec3(1.14, 1.08, 1.0)));
      const lum = T.dot(col, T.vec3(0.3, 0.5, 0.2));
      col.assign(T.mix(T.vec3(lum, lum, lum), col, uSaturation));

      // --- VIGNETTE (the old one, switchable) + hurt overlay.
      const vig = T.float(1).sub(r2.mul(uAds.mul(0.16).add(0.07)).mul(uVignette));
      col.assign(col.mul(vig).add(T.vec3(0.25, 0.02, 0.02).mul(uHurt)));

      // --- FILM GRAIN (animated), switchable.
      const seed = uvN.mul(T.vec2(1100, 800)).add(uTime.mul(40));
      const gr = T.fract(T.sin(T.dot(seed, T.vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(0.008).mul(uGrain);
      col.assign(col.add(T.vec3(gr, gr, gr)));

      // --- NaN/Inf firewall + Karis clamp (as in cinematic.ts, per channel).
      const guard = (v: TslNode): TslNode => {
        const s = v.toVar();
        T.If(T.or(s.lessThan(0), s.greaterThan(60000)), () => {
          s.assign(0);
        });
        return s;
      };
      const hdr = T.vec3(guard(col.x), guard(col.y), guard(col.z));
      const clamped = T.min(hdr, T.vec3(64, 64, 64));
      // --- RRT/ACES with exposure (col *= uExposure / 0.6).
      const ex = clamped.mul(uExposure.div(0.6));
      const exx = ex.x;
      const exy = ex.y;
      const exz = ex.z;
      const inR = T.float(0.59719).mul(exx).add(T.float(0.35458).mul(exy)).add(T.float(0.04823).mul(exz));
      const inG = T.float(0.076).mul(exx).add(T.float(0.90834).mul(exy)).add(T.float(0.01566).mul(exz));
      const inB = T.float(0.0284).mul(exx).add(T.float(0.13383).mul(exy)).add(T.float(0.83777).mul(exz));
      const rrt = (v: TslNode): TslNode =>
        v.mul(v.add(0.0245786)).sub(0.000090537).div(v.mul(v.mul(0.983729).add(0.432951)).add(0.238081));
      const wR = rrt(inR);
      const wG = rrt(inG);
      const wB = rrt(inB);
      const mapped = T.vec3(
        T.float(1.60475).mul(wR).sub(T.float(0.53108).mul(wG)).sub(T.float(0.07367).mul(wB)),
        T.float(-0.10208).mul(wR).add(T.float(1.10813).mul(wG)).sub(T.float(0.00605).mul(wB)),
        T.float(-0.00327).mul(wR).sub(T.float(0.07276).mul(wG)).add(T.float(1.07602).mul(wB)),
      );
      const clamped01 = T.min(T.max(mapped, T.vec3(0, 0, 0)), T.vec3(1, 1, 1));
      // --- sRGB encoding (knee via max instead of bool mask, < 2e-4 deviation).
      const srgb = T.max(
        T.pow(T.max(clamped01, T.vec3(0, 0, 0)), T.vec3(0.41666)).mul(1.055).sub(0.055),
        clamped01.mul(12.92),
      );

      // --- MID-BAND DEPTH: filmic S-curve on LUMA, window 0.18..1.0.
      const y = T.dot(srgb, T.vec3(0.2126, 0.7152, 0.0722));
      const out = srgb.toVar();
      T.If(y.greaterThan(0.18), () => {
        const w = T.smoothstep(0.18, 0.52, y).mul(T.float(1).sub(T.smoothstep(0.6, 1.0, y)));
        const s = y.mul(y).mul(T.float(3).sub(y.mul(2)));
        out.assign(srgb.mul(T.float(1).add(s.sub(y).mul(0.55).mul(w).div(T.max(y, 0.0001)))));
      });
      return T.vec4(out, 1);
    });
    return grade() as TslNode;
  }

  private disposePass(): void {
    // Dispose the scene pass (RT realloc like WebGL ensureDepthResolved).
    try {
      (this.scenePass as unknown as { renderTarget?: { dispose(): void } })?.renderTarget?.dispose();
    } catch {
      /* already disposed — chain is being relinked */
    }
    this.scenePass = null;
  }

  private disposeNode(n: (TslNode & { dispose?: () => void }) | null): void {
    try {
      n?.dispose?.();
    } catch {
      /* already disposed or passive — chain is being relinked */
    }
  }

  /**
   * Relink the chain (only on structural changes). The scene pass is only
   * rebuilt when MRT membership changes (AO on/off):
   * attaching an MRT to an already-rendered pass after the fact would leave
   * the backend with half-allocated targets — so a fresh pass with an
   * MRT that is correct from the start (RT realloc like WebGL ensureDepthResolved).
   * Bloom/afterimage/grade are rebuilt with the current predecessor
   * (afterimage history starts fresh — like MotionBlurPass.reset).
   */
  private rebuild(struct: { ao: boolean; bloom: boolean; motionBlur: boolean }): void {
    const T = this.api;
    // MRT change → fresh scene pass (AO inputs hang off the pass and are
    // rebuilt with it); otherwise the pass lives on.
    if (!this.scenePass || struct.ao !== this.mrtOn) {
      this.disposePass();
      this.disposeNode(this.aoNode);
      this.aoNode = null;
      // ?ldr=1: UnsignedByte instead of HalfFloat (diagnosis only, see qaLdr).
      // (The three import above is deliberately NOT a pure type import here:
      // UnsignedByteType is read at runtime.)
      const pass = qaLdr() ? T.pass(this.scene, this.camera, { type: THREE.UnsignedByteType }) : T.pass(this.scene, this.camera);
      if (struct.ao) pass.setMRT(T.mrt({ output: T.output, normal: T.normalView }));
      // UPSTREAM FIX (three r186, PassNode): the explicit depth texture carries
      // no .renderTarget back-reference — without it WebGPUBackend sizes its
      // samples from renderer.currentSamples (4 here via antialias:true) instead
      // of the RT (0) → texture_depth_multisampled_2d, on which textureGather
      // (GTAO centre) has no WGSL overload → invalid pipeline, AO dead,
      // error spam per frame. With the back-reference: RT.samples = 0 → single-sample.
      const rt = pass.renderTarget;
      if (rt?.depthTexture) rt.depthTexture.renderTarget = rt;
      this.scenePass = pass;
      this.mrtOn = struct.ao;
    }
    const pass = this.scenePass;

    // AO (GTAO): strength comes live from uAoStrength (mix, no rebuild).
    if (struct.ao) {
      if (!this.aoNode) {
        this.aoNode = this.fx.ao(
          pass.getTextureNode("depth"),
          pass.getTextureNode("normal"),
          this.camera,
        );
      }
    } else {
      this.disposeNode(this.aoNode);
      this.aoNode = null;
    }

    let color: TslNode = pass.getTextureNode("output");
    if (this.aoNode) {
      color = color.mul(T.mix(T.float(1), this.aoNode, this.uAoStrength));
    }

    // Selective HDR bloom (threshold 1.0 like BloomPass, strength live).
    if (struct.bloom) {
      this.disposeNode(this.bloomNode);
      this.bloomNode = this.fx.bloom(color, this.uBloomStrength, 0, 1.0);
      color = color.add(this.bloomNode);
    } else if (this.bloomNode) {
      this.disposeNode(this.bloomNode);
      this.bloomNode = null;
    }

    // Opt-in afterimage (history starts fresh — like MotionBlurPass.reset).
    if (struct.motionBlur) {
      this.disposeNode(this.afterNode);
      this.afterNode = this.fx.afterImage(color, this.uDamp);
      color = this.afterNode;
    } else if (this.afterNode) {
      this.disposeNode(this.afterNode);
      this.afterNode = null;
    }

    // Grade (does tonemapping+sRGB itself — 1:1 from cinematic.ts, like the
    // WebGL grade pass, which also writes its sRGB directly) → [FXAA].
    // IMPORTANT: NO renderOutput() around the grade — RenderOutputNode would
    // convert working→sRGB AGAIN (double encoding = washed out/bright,
    // measured). The grade is display-ready; FXAA gets sRGB input, as
    // it needs it. Only the ?nograde debug path uses renderOutput (there
    // it is the only sRGB conversion).
    // convertToTexture: the grade taps its predecessor at 9+ places — an
    // operator result (mul/add) is not a texture and cannot be sampled with
    // free UVs, so the chain is materialised once here
    // (one fullscreen copy, like the composer chain's RT swaps used to be).
    // ?nograde: skip the grade (bisection scene vs. grade).
    let out: TslNode;
    if (qaNoGrade()) {
      out = T.renderOutput(color, this.lib.NoToneMapping, this.lib.SRGBColorSpace);
    } else {
      out = this.buildGrade(T.convertToTexture(color));
    }
    if (this.useFxaa) out = this.fx.fxaa(out);
    this.pipe.outputNode = out;
    this.pipe.needsUpdate = true;
  }

  /** Live switches + uniforms (game.ts/setGraphicsOptions, no reload). */
  applyPrefs(s: WebgpuPrefsSnapshot): void {
    this.uBloomStrength.value = s.bloom ? s.bloomStrength : 0;
    this.uAoStrength.value = s.aoStrength;
    this.uChroma.value = s.chromatic ? 1 : 0;
    this.uGrain.value = s.grain ? 1 : 0;
    this.uVignette.value = s.vignette ? 1 : 0;
    this.uSharpen.value = s.sharpen;
    this.uDof.value = s.dof ? 1 : 0;
    this.uExposure.value = s.exposure;
    if (s.hurt !== undefined) this.uHurt.value = s.hurt;
    const wantAo = s.ao && !this.aoForceOff;
    const wantBloom = s.bloom && s.bloomStrength > 0 && !qaBloomOff();
    const wantMotion = s.motionBlur;
    const key = `${wantAo}|${wantBloom}|${wantMotion}`;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.rebuild({ ao: wantAo, bloom: wantBloom, motionBlur: wantMotion });
    }
  }

  /** Damage flash (game.ts hurt event, when no grade is running). */
  setHurt(v: number): void {
    this.uHurt.value = v;
  }

  /** ADS state for the vignette (draw, per frame). */
  setAds(v: number): void {
    this.uAds.value = v;
  }

  /** uTime progress + hurt decay (once per frame, see render). */
  tick(dt: number): void {
    this.uTime.value += dt;
    this.uHurt.value = Math.max(0, this.uHurt.value - dt * 2.4);
  }

  /** One presented frame: advance time + render the pipeline. */
  render(dt = 0): void {
    if (dt > 0) this.tick(dt);
    this.pipe.render();
  }

  /** Effective exposure (map basis × slider) — reads/writes uExposure. */
  get exposure(): number {
    return this.uExposure.value;
  }

  set exposure(v: number) {
    this.uExposure.value = v;
  }

  /** game.ts/resize: pull the texel uniforms up from the drawing buffer. */
  setSize(w: number, h: number, pixelRatio: number): void {
    void w;
    void h;
    void pixelRatio;
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.uTexelX.value = 1 / Math.max(1, db.x);
    this.uTexelY.value = 1 / Math.max(1, db.y);
  }
}

/** Factory alias for game.ts (dynamic import, see file header). */
export async function createWebgpuPipeline(
  renderer: WebgpuCanvasRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<WebgpuPipeline> {
  return WebgpuPipeline.create(renderer, scene, camera);
}
