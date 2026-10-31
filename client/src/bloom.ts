import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/**
 * client/src/bloom.ts — SELECTIVE GLOW (UnrealBloom replacement, vendor-free).
 * ============================================================================
 *
 * Deliberately no UnrealBloomPass (fullscreen wash, three passes): bloom here is
 * one pass with an internal mip chain instead of a download:
 *
 *  1. Bright pass at half resolution (only pixels above the threshold, with a
 *     soft knee),
 *  2. separable 9-tap Gaussian H+V, two iterations (half + quarter
 *     resolution for a wide halo at a small tap radius),
 *  3. additive composite back into the HDR buffer.
 *
 * One pass slot in the composer, four internal fullscreen draws — cheaper than
 * three entangled passes and with no further RT switches in the chain.
 * Subtle by default: threshold 1.0 (only HDR highlights: sun, muzzle
 * flash), strength 0.35. `strength = 0` or `enabled = false` costs
 * a single fullscreen copy.
 */

const BRIGHT = /* glsl */ `precision highp float;
  varying vec2 vUv; uniform sampler2D tSrc; uniform float uThreshold; uniform float uKnee;
  void main(){
    vec3 c = texture2D(tSrc, vUv).rgb;
    // NaN / Inf / negative firewall — WITHOUT isnan(), because ANGLE's D3D11 HLSL
    // compiler optimises isnan() away by default (warning X3577: "value cannot
    // be NaN, isnan() may not be necessary")! A single NaN or Inf
    // pixel (0/0 in the shader, HalfFloat overflow >65504 on additively stacked
    // muzzle/impact flashes) would smear through the 4-pass blur chain into a
    // sharp-edged ~50px BLACK BOX — and motion blur would hold
    // that box in histRT for ~1s (and its min/max clamp would propagate
    // NaN just the same).
    // !(x >= 0.0 && x <= 60000.0) catches NaN, +Inf, -Inf AND negative values
    // in one expression and survives HLSL optimisation because it is an
    // ordinary range comparison; afterwards we clamp to [0,64]
    // (Karis firefly clamp) so no sum in the blur reaches HalfFloat Inf.
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
    // 9-tap Gaussian, sigma ~2.2 in units of uDir
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
  /** Additive share of the halo. 0 = the pass is a no-op copy. */
  strength = 0.35;
  /** Only pixels brighter than this bloom (HDR, before tonemapping). */
  threshold = 1.0;
  /** Soft edge of the threshold. */
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
      // No-op: leave the chain untouched (no swap needed).
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
    // 2a. downsample-blur H+V @ quarter res (wide halo, small taps)
    this.blurMat.uniforms.tSrc.value = this.halfRT.texture;
    this.blurMat.uniforms.uDir.value.set(1 / this.halfRT.width, 0);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.blurA);
    this.quad.render(renderer);
    this.blurMat.uniforms.tSrc.value = this.blurA.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this.blurA.height);
    renderer.setRenderTarget(this.blurB);
    this.quad.render(renderer);
    // 2b. second iteration for round, soft halos
    this.blurMat.uniforms.tSrc.value = this.blurB.texture;
    this.blurMat.uniforms.uDir.value.set(1 / this.blurB.width, 0);
    renderer.setRenderTarget(this.blurA);
    this.quad.render(renderer);
    this.blurMat.uniforms.tSrc.value = this.blurA.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this.blurA.height);
    renderer.setRenderTarget(this.blurB);
    this.quad.render(renderer);
    // 3. additive composite (linear onto linear — the cinematic pass maps afterwards)
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
