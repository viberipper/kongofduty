import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import type { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { SsrPass } from "./reflections";
import type { WetnessRig } from "./wetness";

/**
 * KATANA post stack (map-specific; every other map keeps game.ts GRADE untouched).
 *
 *   RenderPass -> [KatanaSsrPass]? -> KatanaBloomPass -> KATANA_GRADE (ShaderPass)
 *
 * - KATANA_GRADE: the game GRADE's ACES + sRGB + mid-band depth curve VERBATIM, minus the warm
 *   (1.14, 1.08, 1.0) multiply. Instead a moonlit split-tone: shadows lean cool, highlights stay
 *   neutral, and saturated pixels (the lacquer / neon red) are exempt so #E8141F stays pure.
 *   Keeps GRADE's uniform names (uTime/uHurt/uAds/uExposure) so game.ts drives it unchanged.
 * - KatanaBloomPass: soft-threshold prefilter + 5-level 13-tap downsample / tent upsample chain
 *   at half resolution and below (Jimenez 2014). Neon, chochin and the katana habaki bloom; the
 *   moonlit world (HDR < ~1) does not.
 * - KatanaSsrPass: the wet-floor SSR (reflections.ts) on the composer's depth texture,
 *   reversed-Z aware. Quality-flagged: high tier only.
 */

const VS_EXP = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export const KATANA_GRADE = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tBloom: { value: null as THREE.Texture | null },
    tAdapt: { value: null as THREE.Texture | null },
    uBloom: { value: 0.0 },
    uTime: { value: 0 },
    uHurt: { value: 0 },
    uAds: { value: 0 },
    uExposure: { value: 1 },
    uCool: { value: new THREE.Vector3(0.95, 0.98, 1.05) },
    uCoolAmt: { value: 1.0 },
    /** 0 = ACES (Hill fit, the game's GRADE curve), 1 = AgX (Blender/Filament) with a punchy look */
    uTone: { value: 1 },
    /** auto exposure: 0 off, else the adaptation strength (1 = full Reinhard key, 0.5 = halfway in log) */
    uAutoAmt: { value: 0.6 },
    /** log2 average scene luminance the fixed exposure was tuned on (an exterior court) */
    uAutoRef: { value: -4.45 },
    uAutoMin: { value: -0.6 },
    uAutoMax: { value: 1.25 },
    /** display-space black floor (moonlit blue-grey): shadows lift to readable instead of crushing */
    uLift: { value: new THREE.Vector3(0.014, 0.019, 0.028) },
    uAgxSat: { value: 1.35 },
    uAgxPow: { value: 1.4 },
    uAgxScale: { value: 1.2 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tBloom, tAdapt; uniform float uBloom; uniform float uTime; uniform float uHurt; uniform float uAds;
    uniform float uExposure; uniform vec3 uCool; uniform float uCoolAmt; uniform float uTone;
    uniform float uAutoAmt, uAutoRef, uAutoMin, uAutoMax; uniform vec3 uLift; uniform float uAgxSat, uAgxPow, uAgxScale;
    varying vec2 vUv;
    float n(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    vec3 rrtODT(vec3 v){
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 col){
      const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
      const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
      col /= 0.6;
      col = OUT * rrtODT(IN * col);
      return clamp(col, 0.0, 1.0);
    }
    // AgX (Sobotka; Filament / three r170 constants) + a "punchy" look (Blender: power > 1, saturation > 1)
    vec3 agxContrast(vec3 x){
      vec3 x2 = x * x; vec3 x4 = x2 * x2;
      return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }
    vec3 agx(vec3 col){
      const mat3 S2R = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956);
      const mat3 R2S = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
      const mat3 INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
      const mat3 OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
      const float lo = -12.47393, hi = 4.026069;
      col = INSET * (S2R * col);
      col = clamp((log2(max(col, 1e-10)) - lo) / (hi - lo), 0.0, 1.0);
      col = agxContrast(col);
      // look: power + saturation in the AgX display domain
      col = pow(max(col, 0.0), vec3(uAgxPow));
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = l + uAgxSat * (col - l);
      col = OUTSET * col;
      col = pow(max(vec3(0.0), col), vec3(2.2));
      return clamp(R2S * col, 0.0, 1.0);
    }
    vec3 encodeSRGB(vec3 c){
      return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
    }
    vec3 depth(vec3 c){
      float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (y < 0.18) return c;
      float w = smoothstep(0.18, 0.52, y) * (1.0 - smoothstep(0.60, 1.0, y));
      float s = y * y * (3.0 - 2.0 * y);
      return c * (1.0 + (s - y) * 0.55 * w / max(y, 1e-4));
    }
    void main(){
      vec2 uv = vUv;
      vec2 c = uv-0.5;
      float v = 1.0 - dot(c,c)* (0.07 + uAds*0.16);
      vec3 col = texture2D(tDiffuse, uv).rgb;
      col += texture2D(tBloom, uv).rgb * uBloom;
      // moonlit split-tone (replaces GRADE's warm 1.14/1.08/1.0): cool shadows, neutral highlights,
      // saturated colour (the one red) exempt
      float y = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b));
      float sat = (mx - mn) / max(mx, 1e-4);
      float shadow = 1.0 - smoothstep(0.02, 0.35, y);
      col *= mix(vec3(1.0), uCool, shadow * (1.0 - smoothstep(0.35, 0.75, sat)) * uCoolAmt);
      col = mix(col, vec3(dot(col, vec3(0.3,0.5,0.2))), 0.03);
      col *= v;
      col += uHurt * vec3(0.25, 0.02, 0.02);
      // exposure: the fixed map exposure x an adapted, clamped auto term (interiors open up, bright courts settle)
      float ev = uExposure;
      if (uAutoAmt > 0.0) ev *= exp2(clamp((uAutoRef - texture2D(tAdapt, vec2(0.5)).r) * uAutoAmt, uAutoMin, uAutoMax));
      col *= ev;
      vec3 o;
      if (uTone > 0.5) {
        o = agx(col * uAgxScale);
        // the one red stays red: AgX walks a very bright saturated red toward salmon/orange (an amber wash on the
        // lanterns' reflections). For red-dominant pixels tone-map the max channel and keep the input's hue.
        float m = max(col.r, max(col.g, col.b));
        float red = smoothstep(0.5, 0.8, (col.r - max(col.g, col.b)) / max(col.r, 1e-4));
        if (red > 0.0) o = mix(o, col / max(m, 1e-5) * agx(vec3(m * uAgxScale)).g, red);
      } else o = aces(col);
      o = encodeSRGB(o);
      if (uTone < 0.5) o = depth(o);
      o = uLift + (1.0 - uLift) * o;
      o += (n(uv*vec2(1100.0,800.0)+uTime*40.0)-0.5)*0.008;
      gl_FragColor = vec4(o, 1.0);
    }`,
};

/**
 * Eye adaptation for the katana grade: the HDR frame is metered into a 64x36 log-luminance grid (centre-weighted,
 * lanterns clamped so a lamp in frame does not darken the room), averaged in one fragment and blended into a 1x1
 * adapted value (ping-pong). A camera jump (spawn, kill-cam, station capture) snaps it so no frame is ever exposed
 * for the previous place.
 */
export class KatanaExposurePass extends Pass {
  private meter = new THREE.WebGLRenderTarget(64, 36, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private adapt = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }));
  private cur = 0;
  private meterMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: VS_EXP,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc; varying vec2 vUv;
      void main(){
        vec2 px = vec2(1.0 / 64.0, 1.0 / 36.0);
        float s = 0.0;
        for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) {
          vec3 c = texture2D(tSrc, vUv + (vec2(float(i), float(j)) - 1.0) * px * 0.33).rgb;
          s += log2(clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4, 4.0));
        }
        gl_FragColor = vec4(s / 9.0, 0.0, 0.0, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  private avgMat = new THREE.ShaderMaterial({
    uniforms: { tMeter: { value: null }, tPrev: { value: null }, uK: { value: 1 } },
    vertexShader: VS_EXP,
    fragmentShader: /* glsl */ `
      uniform sampler2D tMeter, tPrev; uniform float uK;
      void main(){
        float s = 0.0, w = 0.0;
        for (int y = 0; y < 36; y++) for (int x = 0; x < 64; x++) {
          vec2 p = (vec2(float(x), float(y)) + 0.5) / vec2(64.0, 36.0) - 0.5;
          float k = exp(-dot(p * vec2(1.6, 2.0), p * vec2(1.6, 2.0)) * 4.0) + 0.15;
          s += texelFetch(tMeter, ivec2(x, y), 0).r * k; w += k;
        }
        float cur = s / w;
        float prev = texelFetch(tPrev, ivec2(0), 0).r;
        gl_FragColor = vec4(mix(prev, cur, uK), 0.0, 0.0, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  private quad = new FullScreenQuad(this.meterMat);
  private last = new THREE.Vector3(1e9, 0, 0);
  private camPos = new THREE.Vector3();
  /** adaptation speed (1/s): eyes open into a dark interior over ~0.7 s */
  speed = 3.0;
  /** QA: keep the current adapted value untouched (A/B captures that must share one exposure) */
  hold = false;
  constructor(private grade: ShaderPass, private camera: THREE.Camera) {
    super();
    this.needsSwap = false;
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget, deltaTime?: number): void {
    if (!this.enabled || this.hold) return;
    this.camera.getWorldPosition(this.camPos);
    const jump = this.camPos.distanceTo(this.last) > 3;
    this.last.copy(this.camPos);
    const dt = Math.min(Math.max(deltaTime ?? 1 / 60, 0), 0.25);
    this.meterMat.uniforms.tSrc!.value = read.texture;
    this.quad.material = this.meterMat;
    renderer.setRenderTarget(this.meter);
    this.quad.render(renderer);
    const prev = this.adapt[this.cur]!, next = this.adapt[1 - this.cur]!;
    this.avgMat.uniforms.tMeter!.value = this.meter.texture;
    this.avgMat.uniforms.tPrev!.value = prev.texture;
    this.avgMat.uniforms.uK!.value = jump ? 1 : 1 - Math.exp(-dt * this.speed);
    this.quad.material = this.avgMat;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);
    this.cur = 1 - this.cur;
    this.grade.uniforms.tAdapt!.value = next.texture;
  }
  /** debug / tuning: the adapted log2 luminance (GPU readback, do not call per frame) */
  read(renderer: THREE.WebGLRenderer): number {
    const b = new Float32Array(4);
    renderer.readRenderTargetPixels(this.adapt[this.cur]!, 0, 0, 1, 1, b);
    return b[0]!;
  }
  dispose(): void { this.meter.dispose(); for (const a of this.adapt) a.dispose(); this.meterMat.dispose(); this.avgMat.dispose(); this.quad.dispose(); }
}

const DOWN = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uPrefilter; uniform vec4 uThreshold; // x thr, y thr-knee, z 2knee, w 0.25/knee
  varying vec2 vUv;
  vec3 tap(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
  vec3 prefilter(vec3 c){
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - uThreshold.y, 0.0, uThreshold.z); rq = uThreshold.w * rq * rq;
    return c * max(rq, br - uThreshold.x) / max(br, 1e-4);
  }
  float karis(vec3 c){ return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
  void main(){
    vec3 a = tap(vec2(-2.,2.)), b = tap(vec2(0.,2.)), c = tap(vec2(2.,2.));
    vec3 d = tap(vec2(-2.,0.)), e = tap(vec2(0.,0.)), f = tap(vec2(2.,0.));
    vec3 g = tap(vec2(-2.,-2.)), h = tap(vec2(0.,-2.)), i = tap(vec2(2.,-2.));
    vec3 j = tap(vec2(-1.,1.)), k = tap(vec2(1.,1.)), l = tap(vec2(-1.,-1.)), m = tap(vec2(1.,-1.));
    vec3 o;
    if (uPrefilter > 0.5) {
      // Karis-weighted groups kill fireflies (single hot texels from wet speculars)
      vec3 g0 = (j+k+l+m)*0.25, g1 = (a+b+d+e)*0.25, g2 = (b+c+e+f)*0.25, g3 = (d+e+g+h)*0.25, g4 = (e+f+h+i)*0.25;
      float w0 = karis(g0)*0.5, w1 = karis(g1)*0.125, w2 = karis(g2)*0.125, w3 = karis(g3)*0.125, w4 = karis(g4)*0.125;
      o = (g0*w0 + g1*w1 + g2*w2 + g3*w3 + g4*w4) / (w0+w1+w2+w3+w4);
      o = prefilter(o);
    } else {
      o = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
    }
    gl_FragColor = vec4(o, 1.0);
  }`;
const UP = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uRadius; varying vec2 vUv;
  vec3 tap(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
  void main(){
    vec3 s = tap(vec2(0.)) * 4.0 + (tap(vec2(-1.,0.)) + tap(vec2(1.,0.)) + tap(vec2(0.,-1.)) + tap(vec2(0.,1.))) * 2.0
      + tap(vec2(-1.,-1.)) + tap(vec2(1.,-1.)) + tap(vec2(-1.,1.)) + tap(vec2(1.,1.));
    gl_FragColor = vec4(s / 16.0, 1.0);
  }`;
const VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export class KatanaBloomPass extends Pass {
  levels: THREE.WebGLRenderTarget[] = [];
  private down: THREE.ShaderMaterial;
  private up: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  threshold = 1.3;
  knee = 0.6;
  constructor(private grade: ShaderPass, public count = 5, public strength = 0.4) {
    super();
    this.needsSwap = false;
    this.down = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 }, uThreshold: { value: new THREE.Vector4() } }, vertexShader: VS, fragmentShader: DOWN, depthTest: false, depthWrite: false });
    this.up = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } }, vertexShader: VS, fragmentShader: UP, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true });
    this.quad = new FullScreenQuad(this.down);
    for (let i = 0; i < count; i++) this.levels.push(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    grade.uniforms.tBloom!.value = this.levels[0]!.texture;
    grade.uniforms.uBloom!.value = strength;
  }
  setSize(w: number, h: number): void {
    this.levels.forEach((rt, i) => rt.setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    if (!this.enabled) return;
    const k = this.threshold * this.knee;
    this.down.uniforms.uThreshold!.value.set(this.threshold, this.threshold - k, 2 * k, 0.25 / Math.max(k, 1e-4));
    let src: THREE.Texture = read.texture; let sw = read.width, sh = read.height;
    this.quad.material = this.down;
    for (let i = 0; i < this.levels.length; i++) {
      this.down.uniforms.tSrc!.value = src;
      this.down.uniforms.uTexel!.value.set(1 / sw, 1 / sh);
      this.down.uniforms.uPrefilter!.value = i === 0 ? 1 : 0;
      renderer.setRenderTarget(this.levels[i]!);
      this.quad.render(renderer);
      src = this.levels[i]!.texture; sw = this.levels[i]!.width; sh = this.levels[i]!.height;
    }
    this.quad.material = this.up;
    const ac = renderer.autoClear; renderer.autoClear = false;
    for (let i = this.levels.length - 1; i > 0; i--) {
      this.up.uniforms.tSrc!.value = this.levels[i]!.texture;
      this.up.uniforms.uTexel!.value.set(1 / this.levels[i]!.width, 1 / this.levels[i]!.height);
      renderer.setRenderTarget(this.levels[i - 1]!);
      this.quad.render(renderer);
    }
    renderer.autoClear = ac;
    this.grade.uniforms.uBloom!.value = this.strength;
  }
  dispose(): void { for (const l of this.levels) l.dispose(); this.down.dispose(); this.up.dispose(); this.quad.dispose(); }
}

export class KatanaSsrPass extends Pass {
  ssr: SsrPass;
  constructor(private camera: THREE.PerspectiveCamera, composer: EffectComposer, reversed: boolean, private rig?: WetnessRig, steps = 40) {
    super();
    this.ssr = new SsrPass(steps);
    this.ssr.material.uniforms.uReversed!.value = reversed ? 1 : 0;
    // the world pass must leave a resolved depth texture behind (depth-precision.ts turns the
    // resolve off when nothing samples depth; SSR does)
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      if (!rt.depthTexture) rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, reversed ? THREE.FloatType : THREE.UnsignedIntType);
      rt.resolveDepthBuffer = true;
      rt.dispose();
    }
  }
  set on(v: boolean) { this.enabled = v; if (this.rig) this.rig.uniforms.uKvSsrOn.value = v ? 1 : 0; }
  render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    this.ssr.render(renderer, read, this.renderToScreen ? null : write, this.camera);
  }
}

export type KatanaPost = { grade: ShaderPass; bloom: KatanaBloomPass; ssr: KatanaSsrPass | null; exposure: KatanaExposurePass; setQuality: (q: "low" | "high") => void };

/**
 * Append the katana stack after the composer's RenderPass (and any depth/viewmodel passes).
 * game.ts: `if (MAP.id === "katana") { const post = installKatanaPost(...); this.grade = post.grade; }`
 * in place of `new ShaderPass(GRADE)`. `quality` high = SSR + 5-level bloom; low = no SSR,
 * 3-level bloom (software tier: pass `bloom: false`).
 */
export function installKatanaPost(composer: EffectComposer, camera: THREE.PerspectiveCamera, o: { reversed: boolean; exposure: number; rig?: WetnessRig; quality?: "low" | "high"; bloom?: boolean }): KatanaPost {
  const ssr = o.rig ? new KatanaSsrPass(camera, composer, o.reversed, o.rig) : null;
  if (ssr) composer.addPass(ssr);
  const grade = new ShaderPass(KATANA_GRADE);
  grade.uniforms.uExposure!.value = o.exposure;
  const qs = new URLSearchParams(location.search);
  if (qs.get("kvtone") === "aces") grade.uniforms.uTone!.value = 0;
  const exposure = new KatanaExposurePass(grade, camera);
  exposure.enabled = qs.get("kvauto") !== "0";
  if (!exposure.enabled) grade.uniforms.uAutoAmt!.value = 0;
  composer.addPass(exposure);
  (window as unknown as { __kvPost?: unknown }).__kvPost = { grade, exposure, ssr };
  const bloom = new KatanaBloomPass(grade, 5);
  bloom.enabled = o.bloom !== false;
  if (!bloom.enabled) grade.uniforms.uBloom!.value = 0;
  composer.addPass(bloom);
  composer.addPass(grade);
  const setQuality = (q: "low" | "high") => {
    if (ssr) ssr.on = q === "high";
  };
  setQuality(o.quality ?? "high");
  return { grade, bloom, ssr, exposure, setQuality };
}
