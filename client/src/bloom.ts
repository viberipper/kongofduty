import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/**
 * client/src/bloom.ts — SELEKTIVES GLOW (UnrealBloom-Ersatz, vendored-frei).
 * ============================================================================
 *
 * Der vendored three-Build enthält KEINEN UnrealBloomPass
 * (examples/jsm/postprocessing hat nur EffectComposer/MaskPass/Pass/
 * RenderPass/ShaderPass), also ist Bloom hier als ein Pass mit interner
 * Mip-Kette implementiert statt als Download:
 *
 *  1. Bright-Pass auf halber Auflösung (nur Pixel über der Schwelle, mit
 *     weichem Knie),
 *  2. separabler 9-Tap-Gauss H+V, zwei Iterationen (halbe + viertel
 *     Auflösung für weiten Halo bei kleinem Tap-Radius),
 *  3. additives Composite zurück in den HDR-Buffer.
 *
 * Ein Pass-Slot im Composer, vier interne Fullscreen-Draws — billiger als
 * drei Entangled-Pässe und ohne weitere RT-Umschaltungen in der Chain.
 * Subtil per Default: Schwelle 1.0 (nur HDR-Highlights: Sonne, Mündungs-
 * feuer, Nuke), Stärke 0.35. `strength = 0` oder `enabled = false` kostet
 * einen einzigen Fullscreen-Copy.
 */

const BRIGHT = /* glsl */ `precision highp float;
  varying vec2 vUv; uniform sampler2D tSrc; uniform float uThreshold; uniform float uKnee;
  void main(){
    vec3 c = texture2D(tSrc, vUv).rgb;
    // NaN / Inf / Negative Firewall — OHNE isnan(), weil ANGLEs D3D11-HLSL-
    // Compiler isnan() per Default WEGOPTIMIERT (warning X3577: "value cannot
    // be NaN, isnan() may not be necessary")! Ein einzelnes NaN- oder Inf-
    // Pixel (0/0 im Shader, HalfFloat-Overflow >65504 bei additiv gestapelten
    // Mündungs-/Impact-Blitzen) würde durch die 4-Pass-Blur-Chain zu einer
    // scharfkantigen ~50px SCHWARZEN BOX verschmiert — und Motion-Blur hielte
    // diese Box in histRT ~1s lang fest (und dessen min/max-Clamp pflanzte
    // NaN ebenfalls fort).
    // !(x >= 0.0 && x <= 60000.0) fängt NaN, +Inf, -Inf UND negative Werte
    // in einem Ausdruck und überlebt die HLSL-Optimierung, weil es ein
    // gewöhnlicher Bereichsvergleich ist; anschließend clampen wir auf [0,64]
    // (Karis-Firefly-Clamp), damit keine Summe im Blur HalfFloat-Inf erreicht.
    if (!(c.r >= 0.0 && c.r <= 60000.0)) c.r = 0.0;
    if (!(c.g >= 0.0 && c.g <= 60000.0)) c.g = 0.0;
    if (!(c.b >= 0.0 && c.b <= 60000.0)) c.b = 0.0;
    c = min(c, vec3(64.0));
    float l = max(max(c.r, c.g), c.b);
    float w = smoothstep(uThreshold - uKnee, uThreshold + uKnee, max(l, 0.0));
    gl_FragColor = vec4(c * w, 1.0);
  }`;

const BLUR = /* glsl */ `precision highp float;
  varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir;
  vec3 safeTap(sampler2D t, vec2 uv){
    vec3 s = texture2D(t, uv).rgb;
    if (!(s.r >= 0.0 && s.r <= 60000.0)) s.r = 0.0;
    if (!(s.g >= 0.0 && s.g <= 60000.0)) s.g = 0.0;
    if (!(s.b >= 0.0 && s.b <= 60000.0)) s.b = 0.0;
    return min(s, vec3(64.0));
  }
  void main(){
    // 9-tap Gauss, sigma ~2.2 in Einheiten von uDir
    vec3 c = safeTap(tSrc, vUv) * 0.227027;
    vec2 o1 = uDir * 1.3846153846, o2 = uDir * 3.2307692308;
    c += safeTap(tSrc, vUv + o1) * 0.3162162162;
    c += safeTap(tSrc, vUv - o1) * 0.3162162162;
    c += safeTap(tSrc, vUv + o2) * 0.0702702703;
    c += safeTap(tSrc, vUv - o2) * 0.0702702703;
    gl_FragColor = vec4(c, 1.0);
  }`;

const COMP = /* glsl */ `precision highp float;
  varying vec2 vUv; uniform sampler2D tSrc; uniform sampler2D tBloom; uniform float uStrength;
  vec3 safeHdr(vec3 s){
    if (!(s.r >= 0.0 && s.r <= 60000.0)) s.r = 0.0;
    if (!(s.g >= 0.0 && s.g <= 60000.0)) s.g = 0.0;
    if (!(s.b >= 0.0 && s.b <= 60000.0)) s.b = 0.0;
    return s;
  }
  void main(){
    vec3 c = safeHdr(texture2D(tSrc, vUv).rgb);
    vec3 b = safeHdr(texture2D(tBloom, vUv).rgb);
    gl_FragColor = vec4(c + b * uStrength, 1.0);
  }`;

const VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export class BloomPass extends Pass {
  /** Additiver Anteil des Halos. 0 = Pass ist ein No-op-Copy. */
  strength = 0.35;
  /** Nur Pixel heller als das blühen (HDR, vor dem Tonemapping). */
  threshold = 1.0;
  /** Weiche Kante der Schwelle. */
  knee = 0.25;
  private halfRT: THREE.WebGLRenderTarget;
  private blurA: THREE.WebGLRenderTarget;
  private blurB: THREE.WebGLRenderTarget;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor() {
    super();
    this.needsSwap = true;
    const rt = () =>
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.halfRT = rt();
    this.blurA = rt();
    this.blurB = rt();
    this.brightMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uThreshold: { value: this.threshold }, uKnee: { value: this.knee } }, vertexShader: VS, fragmentShader: BRIGHT, depthTest: false, depthWrite: false });
    this.blurMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }, vertexShader: VS, fragmentShader: BLUR, depthTest: false, depthWrite: false });
    this.compMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, tBloom: { value: null }, uStrength: { value: this.strength } }, vertexShader: VS, fragmentShader: COMP, depthTest: false, depthWrite: false });
    this.quad = new FullScreenQuad(this.brightMat);
  }

  setSize(width: number, height: number): void {
    this.halfRT.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.blurA.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
    this.blurB.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    if (this.strength <= 0.001) {
      // No-op: Kette unverändert lassen (kein Swap nötig).
      this.needsSwap = false;
      return;
    }
    this.needsSwap = true;
    const w = readBuffer.width, h = readBuffer.height;
    if (this.halfRT.width !== Math.max(1, w >> 1)) this.setSize(w, h);
    this.brightMat.uniforms.uThreshold.value = this.threshold;
    this.brightMat.uniforms.uKnee.value = this.knee;
    // 1. bright pass @ half res
    this.brightMat.uniforms.tSrc.value = readBuffer.texture;
    this.quad.material = this.brightMat;
    renderer.setRenderTarget(this.halfRT);
    this.quad.render(renderer);
    // 2a. downsample-blur H+V @ quarter res (weiter Halo, kleine Taps)
    this.blurMat.uniforms.tSrc.value = this.halfRT.texture;
    this.blurMat.uniforms.uDir.value.set(1 / this.halfRT.width, 0);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.blurA);
    this.quad.render(renderer);
    this.blurMat.uniforms.tSrc.value = this.blurA.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this.blurA.height);
    renderer.setRenderTarget(this.blurB);
    this.quad.render(renderer);
    // 2b. zweite Iteration für runde, weiche Halos
    this.blurMat.uniforms.tSrc.value = this.blurB.texture;
    this.blurMat.uniforms.uDir.value.set(1 / this.blurB.width, 0);
    renderer.setRenderTarget(this.blurA);
    this.quad.render(renderer);
    this.blurMat.uniforms.tSrc.value = this.blurA.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this.blurA.height);
    renderer.setRenderTarget(this.blurB);
    this.quad.render(renderer);
    // 3. additives Composite (linear auflinear — der Cinematic-Pass mappt danach)
    this.compMat.uniforms.tSrc.value = readBuffer.texture;
    this.compMat.uniforms.tBloom.value = this.blurB.texture;
    this.compMat.uniforms.uStrength.value = this.strength;
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    this.quad.material = this.brightMat;
  }

  dispose(): void {
    this.halfRT.dispose();
    this.blurA.dispose();
    this.blurB.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}
