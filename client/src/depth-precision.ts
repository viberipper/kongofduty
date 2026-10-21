import * as THREE from "three";
import { Pass } from "three/addons/postprocessing/Pass.js";
import type { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";

/**
 * ZERO-FLICKER, LAYER 1 — DEPTH PRECISION (docs/nuketown/ZERO-FLICKER.md).
 *
 * The camera's near plane is 0.03 m because the first-person viewmodel shares
 * the world camera. With a classic 24-bit depth buffer that spends almost all
 * of its precision in front of the gun: ~0.8 mm resolvable at 20 m, 5 mm at
 * 50 m, 2 cm at 100 m — exactly the distances where two surfaces a few mm apart
 * (a decal on a wall, a sunk container, a skirting board) start to shimmer.
 *
 * Three modes, picked once per page load (`?depth=` pins one for QA):
 *
 *  - "reversed" (default when EXT_clip_control exists — every desktop Chrome /
 *    Edge / Firefox): reversed-Z into a 32-bit FLOAT depth buffer. Float
 *    exponents put their precision near 0, reversed-Z puts the FAR field near
 *    0, so the two cancel the 1/z curve and the resolvable step becomes a
 *    near-constant fraction of distance (~10 µm at 100 m on the probe). The
 *    near plane stops mattering, so the viewmodel keeps sharing the camera.
 *  - "split" (automatic fallback without EXT_clip_control): the world camera's
 *    near plane moves out to WORLD_NEAR_SPLIT and the viewmodel is drawn in its
 *    own pass after a depth clear with its own 0.01 m near plane. No shader
 *    changes (unlike a logarithmic depth buffer, which would need every custom
 *    ShaderMaterial in every stream patched and kills early-Z), 5x the
 *    standard precision everywhere in the world.
 *  - "standard": the old pipeline, bit-for-bit. Only for before/after QA.
 *
 * THREE r170's reversed-depth support is BROKEN and is repaired here, not
 * worked around by luck. Measured on this repo's three before the repair
 * (qa: scripts/qa/depth-probe.mjs): `reverseDepthBuffer: true` renders NOTHING
 * but the background, because
 *   1. DepthBuffer.setReversed() tests the OLD flag, so turning reversal on
 *      selects NEGATIVE_ONE_TO_ONE clip control (a no-op) instead of ZERO_TO_ONE;
 *   2. it re-applies the clear depth BEFORE flipping the flag, so the GL clear
 *      value stays 1.0 — which, under the reversed GEQUAL test, is "nearest";
 *   3. its reversed depth-func table maps NEVER<->ALWAYS and EQUAL<->NOTEQUAL;
 *   4. polygonOffset is passed through unsigned: a decal's "pull toward the
 *      camera" becomes "push into the wall" once near is 1 and far is 0;
 *   5. shadow maps are rendered with the reversed projection but compared
 *      against a standard-depth shadow matrix (every surface self-shadows).
 * (1)-(4) are corrected on the state object (all calls reach it through
 * property lookups, so the wrappers see every call); (5) is handled by
 * rendering the shadow pass in standard depth — a directional shadow is an
 * orthographic, linear-depth projection that gains nothing from reversal.
 */

export type DepthMode = "reversed" | "split" | "standard";

/**
 * The world camera's near plane when the viewmodel gets its own pass. 0.15 m:
 * the near rectangle's farthest corner then reaches 0.15 * 1.69 = 0.25 m from
 * the eye at FOV 74 / 16:9, inside the 0.30 m player radius, so it can never
 * cut into a wall the player is pressed against — and 24-bit depth resolves
 * 5x finer than at 0.03 (2 mm at 72 m, where Ares' longest sightlines end).
 */
export const WORLD_NEAR_SPLIT = 0.15;
/** The viewmodel pass's near plane (the gun's closest vertex is ~0.06 m out). */
export const VM_NEAR = 0.01;
/** Layer the viewmodel moves to in split mode. 0 stays the world's. */
export const VM_LAYER = 30;

type Wanted = DepthMode | "auto";

function wantedMode(): Wanted {
  try {
    const q = new URLSearchParams(location.search).get("depth");
    if (q === "reversed" || q === "split" || q === "standard") return q;
  } catch { /* no location (tests) */ }
  return "auto";
}

/** Spread into the WebGLRenderer constructor (game.ts). */
export function depthRendererOptions(): { reverseDepthBuffer: boolean } {
  const w = wantedMode();
  return { reverseDepthBuffer: w === "auto" || w === "reversed" };
}

type DepthBufferState = {
  setReversed(v: boolean): void;
  getReversed(): boolean;
  setFunc(f: THREE.DepthModes): void;
  setClear(d: number): void;
  reset(): void;
};

type ClipControl = {
  clipControlEXT(origin: number, depth: number): void;
  LOWER_LEFT_EXT: number;
  ZERO_TO_ONE_EXT: number;
  NEGATIVE_ONE_TO_ONE_EXT: number;
};

/** Pre-image under r170's (wrong) reversed table of the CORRECT reversed func. */
const R170_FUNC_FIX: Partial<Record<number, THREE.DepthModes>> = {
  [THREE.NeverDepth]: THREE.AlwaysDepth,
  [THREE.AlwaysDepth]: THREE.NeverDepth,
  [THREE.EqualDepth]: THREE.NotEqualDepth,
  [THREE.NotEqualDepth]: THREE.EqualDepth,
};

export class DepthPrecision {
  readonly mode: DepthMode;
  /** True when the composer targets carry a 32-bit float depth attachment. */
  floatDepth = false;
  /** Why this mode was chosen — logged once, shown in QA reports. */
  readonly reason: string;
  private vmPass: ViewmodelPass | null = null;

  constructor(private renderer: THREE.WebGLRenderer) {
    const want = wantedMode();
    const canReverse = renderer.capabilities.reverseDepthBuffer === true;
    if (want === "standard") {
      this.mode = "standard";
      this.reason = "?depth=standard (QA baseline)";
    } else if (want === "split" || !canReverse) {
      this.mode = "split";
      this.reason = want === "split" ? "?depth=split" : "EXT_clip_control unavailable";
    } else {
      this.mode = "reversed";
      this.reason = "EXT_clip_control available";
    }
    // depthRendererOptions() only asks three for reversal in "auto"/"reversed",
    // and three only grants it with EXT_clip_control, so outside "reversed" the
    // state was never flipped and needs no repair.
    if (this.mode === "reversed") this.repairReversedDepth();
    console.info(`[depth] ${this.mode} — ${this.reason}`);
  }

  /** Camera planes for this mode. Call once on the world camera. */
  configureCamera(camera: THREE.PerspectiveCamera): void {
    if (this.mode !== "split") return;
    camera.near = WORLD_NEAR_SPLIT;
    camera.updateProjectionMatrix();
  }

  /**
   * Composer hook: float depth on both ping-pong targets (RenderPass alternates
   * between them, because the final pass still swaps), no per-frame depth
   * resolve, and in split mode the viewmodel pass right after the world pass.
   */
  attachComposer(composer: EffectComposer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, vmRoots: THREE.Object3D[]): void {
    if (this.mode === "standard") return;
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      // m2: Solange kein Pass die Szenentiefe liest, wird sie nie geblittet
      // (three hatte sie jeden Frame resolved) und nach dem Colour-Resolve
      // invalidiert — weniger Bandbreite, nicht mehr. ContactAO (ssao.ts)
      // schaltet resolveDepthBuffer ZURÜCK auf true, sobald AO wirklich läuft
      // (alle Maps, Hardware-Tier, Pref an); bei ?ssao=0 oder AO-aus bleibt es
      // hier bei false und kein Resolve wird bezahlt (Lazy-Nachreichung in
      // setGraphicsOptions via ensureDepthResolved).
      rt.resolveDepthBuffer = false;
      if (this.mode === "reversed") {
        // FloatType -> DEPTH_COMPONENT32F, for the multisampled renderbuffer
        // too (three picks the MSAA depth format from the depth texture).
        rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, THREE.FloatType);
        rt.depthTexture.name = "zero-flicker/depth32f";
      }
      rt.dispose();
    }
    this.floatDepth = this.mode === "reversed";
    if (this.mode === "split") {
      this.vmPass = new ViewmodelPass(scene, camera, vmRoots);
      // Layers are tagged BEFORE the world pass (a mesh a weapon swap just
      // built must not draw once in the world with the 0.1 m near plane), and
      // the gun is drawn directly after it, before grading.
      composer.insertPass(new ViewmodelTagPass(this.vmPass), 0);
      composer.insertPass(this.vmPass, 2);
    }
  }

  /** Split mode's viewmodel pass (null otherwise) — the flicker gate mirrors it. */
  get viewmodelPass(): ViewmodelPass | null {
    return this.vmPass;
  }

  private repairReversedDepth(): void {
    const renderer = this.renderer;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = renderer.extensions.get("EXT_clip_control") as ClipControl;
    const state = renderer.state as unknown as {
      buffers: { depth: DepthBufferState };
      setMaterial(material: THREE.Material, frontFaceCW: boolean): void;
    };
    const depth = state.buffers.depth;
    let reversed = depth.getReversed();
    let clearLogical = 1;
    let clearRaw = Number.NaN;
    const origSetReversed = depth.setReversed;
    const origSetFunc = depth.setFunc;
    const origReset = depth.reset;
    // (2) the clear value is tracked in LOGICAL depth and converted at the GL call.
    depth.setClear = function (d: number): void {
      if (d === null || d === undefined) return;
      clearLogical = d;
      const raw = reversed ? 1 - d : d;
      if (raw !== clearRaw) {
        gl.clearDepth(raw);
        clearRaw = raw;
      }
    };
    // (1) flip three's private flag through the original, then set the clip
    // control it should have set, then re-apply the clear value under the new flag.
    depth.setReversed = function (this: DepthBufferState, v: boolean): void {
      if (v === reversed) return;
      const keep = clearLogical;
      origSetReversed.call(this, v);
      ext.clipControlEXT(ext.LOWER_LEFT_EXT, v ? ext.ZERO_TO_ONE_EXT : ext.NEGATIVE_ONE_TO_ONE_EXT);
      reversed = v;
      clearRaw = Number.NaN;
      depth.setClear(keep);
    };
    // (3)
    depth.setFunc = function (this: DepthBufferState, f: THREE.DepthModes): void {
      origSetFunc.call(this, reversed ? (R170_FUNC_FIX[f] ?? f) : f);
    };
    depth.reset = function (this: DepthBufferState): void {
      origReset.call(this);
      clearRaw = Number.NaN;
    };
    // (4) state.setMaterial applies polygonOffset through a closure, so the sign
    // is fixed after it. Always re-issued for offset materials: three's own
    // cache holds the unsigned pair and would otherwise skip a needed call.
    const origSetMaterial = state.setMaterial;
    state.setMaterial = function (this: unknown, material: THREE.Material, frontFaceCW: boolean): void {
      origSetMaterial.call(this, material, frontFaceCW);
      if (material.polygonOffset) {
        const s = reversed ? -1 : 1;
        gl.polygonOffset(s * material.polygonOffsetFactor, s * material.polygonOffsetUnits);
      }
    };
    // (5) shadow maps in standard depth; the main pass gets reversal back.
    const sm = renderer.shadowMap as THREE.WebGLShadowMap & { render: (l: THREE.Light[], s: THREE.Object3D, c: THREE.Camera) => void };
    const origShadowRender = sm.render;
    sm.render = function (lights: THREE.Light[], scene: THREE.Object3D, camera: THREE.Camera): void {
      // Re-assert every frame: renderer.resetState() turns reversal off.
      if (!reversed) depth.setReversed(true);
      const busy = sm.enabled && lights.length > 0 && (sm.autoUpdate || sm.needsUpdate);
      if (!busy) return origShadowRender.call(this, lights, scene, camera);
      depth.setReversed(false);
      try {
        origShadowRender.call(this, lights, scene, camera);
      } finally {
        depth.setReversed(true);
      }
    };
    // (6) WebGL lazily initialises a new depth attachment to 1.0 — "far" in
    // standard depth, NEAREST once reversed. Anything that renders into a fresh
    // target without clearing first then draws nothing at all. three does that
    // itself: an equirect scene.background is converted to a cube map by a
    // nested render inside the composer's RenderPass, where autoClear is off —
    // measured: the dust2 and Shipment skies came out black. So the first bind
    // of every (target, face, mip) clears its depth to reversed-far.
    const seen = new WeakMap<THREE.WebGLRenderTarget, Set<number>>();
    const origSetRenderTarget = renderer.setRenderTarget;
    renderer.setRenderTarget = function (this: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget | null, face = 0, mip = 0): void {
      origSetRenderTarget.call(this, rt, face, mip);
      if (!rt || !rt.depthBuffer || !reversed) return;
      let faces = seen.get(rt);
      if (!faces) {
        seen.set(rt, (faces = new Set()));
        rt.addEventListener("dispose", () => seen.delete(rt));
      }
      const k = face * 64 + mip;
      if (faces.has(k)) return;
      faces.add(k);
      renderer.state.buffers.depth.setMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    };
    // Apply the corrected state now (the constructor ran the broken path).
    if (!reversed) depth.setReversed(true);
    else {
      ext.clipControlEXT(ext.LOWER_LEFT_EXT, ext.ZERO_TO_ONE_EXT);
      clearRaw = Number.NaN;
      depth.setClear(1);
    }
  }
}

/**
 * Split-mode viewmodel pass: the gun under the camera is drawn after the world
 * with the depth buffer cleared and a 0.01 m near plane, so the world camera
 * can keep its near plane at WORLD_NEAR_SPLIT. Lights must see both layers or
 * the gun would compile a different (unlit) program set.
 */
export class ViewmodelPass extends Pass {
  readonly vmCamera = new THREE.PerspectiveCamera();
  private frame = 0;

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private roots: THREE.Object3D[]) {
    super();
    this.needsSwap = false;
    this.vmCamera.layers.set(VM_LAYER);
    this.vmCamera.matrixAutoUpdate = false;
    this.vmCamera.matrixWorldAutoUpdate = false;
  }

  /** Move the viewmodel to VM_LAYER; false when nothing of it is visible. */
  tagLayers(): boolean {
    let any = false;
    for (const r of this.roots) {
      if (!r.visible) continue;
      any = true;
      r.traverse((o) => {
        if ((o as THREE.Light).isLight) o.layers.enable(0);
        else o.layers.set(VM_LAYER);
        o.layers.enable(VM_LAYER);
      });
    }
    // Lights anywhere in the scene light the gun too. Rescanned twice a second
    // so a light added after boot (none are, by design) still reaches it.
    if ((this.frame++ & 31) === 0) {
      this.scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(VM_LAYER); });
    }
    return any;
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    if (!this.roots.some((r) => r.visible)) return;
    const cam = this.camera;
    const vm = this.vmCamera;
    vm.fov = cam.fov;
    vm.aspect = cam.aspect;
    vm.zoom = cam.zoom;
    vm.near = VM_NEAR;
    vm.far = 4;
    vm.updateProjectionMatrix();
    // Pose as well as matrices: scene.onBeforeRender hooks (dust2's shadow
    // focus) read camera.position.
    cam.matrixWorld.decompose(vm.position, vm.quaternion, vm.scale);
    vm.matrixWorld.copy(cam.matrixWorld);
    vm.matrixWorldInverse.copy(cam.matrixWorldInverse);
    const bg = this.scene.background;
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    const shadowNeeds = renderer.shadowMap.needsUpdate;
    this.scene.background = null;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    try {
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      renderer.clearDepth();
      renderer.render(this.scene, vm);
    } finally {
      this.scene.background = bg;
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadowAuto;
      renderer.shadowMap.needsUpdate = shadowNeeds;
    }
  }
}

/** Split mode: tags viewmodel layers ahead of the world pass. Draws nothing. */
class ViewmodelTagPass extends Pass {
  constructor(private vm: ViewmodelPass) {
    super();
    this.needsSwap = false;
  }

  render(): void {
    this.vm.tagLayers();
  }
}
