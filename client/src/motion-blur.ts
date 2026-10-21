import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/**
 * client/src/motion-blur.ts — SUBTLE afterimage blur (velocity-free).
 * ============================================================================
 *
 * Real velocity motion blur would need per-pixel motion vectors (an extra
 * G-buffer + multi-pass chain) — overkill for a shooter where the picture
 * is constantly looking elsewhere. Instead: exponential blending with the
 * previous frame (classic afterimage approach), strength 0..0.5, DEFAULT OFF.
 *
 * needsSwap=true (no read/write feedback on the same target): the mixed
 * frame goes into writeBuffer and is then copied into the history. On
 * deactivation the history is invalidated so re-activating does not
 * copy in a ghost frame.
 */

const VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export class MotionBlurPass extends Pass {
  /** 0 = off. Sensible: 0.15..0.35. Anything above smears. */
  amount = 0;
  private histRT: THREE.WebGLRenderTarget | null = null;
  private mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private hasHistory = false;

  constructor() {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, tHist: { value: null }, uAmount: { value: 0 }, uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) } },
      vertexShader: VS,
      fragmentShader: /* glsl */ `precision highp float;
        varying vec2 vUv; uniform sampler2D tSrc, tHist; uniform float uAmount; uniform vec2 uTexel;
        vec3 safeHdr(vec3 s){
          if (!(s.r >= 0.0 && s.r <= 60000.0)) s.r = 0.0;
          if (!(s.g >= 0.0 && s.g <= 60000.0)) s.g = 0.0;
          if (!(s.b >= 0.0 && s.b <= 60000.0)) s.b = 0.0;
          return min(s, vec3(64.0));
        }
        void main(){
          vec3 cur = safeHdr(texture2D(tSrc, vUv).rgb);
          vec3 prv = safeHdr(texture2D(tHist, vUv).rgb);
          // Neighbourhood clamp against ghosting: the history may only
          // contribute colours that occur in the 3x3 neighbourhood of the
          // current frame. Otherwise a dark object (scope housing under
          // camera motion!) smears behind as an angular "hanging block" — with the clamp
          // the motion feeling stays, without the blocks.
          vec3 nmin = cur, nmax = cur;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec3 s = safeHdr(texture2D(tSrc, vUv + uTexel * vec2(float(i), float(j))).rgb);
            nmin = min(nmin, s);
            nmax = max(nmax, s);
          }
          prv = clamp(prv, nmin, nmax);
          gl_FragColor = vec4(mix(cur, prv, uAmount), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  /** Drop the history (after enable/disable/resize). */
  reset(): void {
    this.hasHistory = false;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    if (!this.histRT || this.histRT.width !== readBuffer.width || this.histRT.height !== readBuffer.height) {
      this.histRT?.dispose();
      this.histRT = new THREE.WebGLRenderTarget(readBuffer.width, readBuffer.height, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.hasHistory = false;
    }
    const amt = this.hasHistory ? Math.min(0.5, Math.max(0, this.amount)) : 0;
    this.mat.uniforms.tSrc.value = readBuffer.texture;
    this.mat.uniforms.tHist.value = this.histRT.texture;
    this.mat.uniforms.uAmount.value = amt;
    this.mat.uniforms.uTexel.value.set(1 / Math.max(1, readBuffer.width), 1 / Math.max(1, readBuffer.height));
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    if (this.renderToScreen) {
      // The canvas cannot be read back from — restart the chain.
      this.hasHistory = false;
      return;
    }
    // The mixed frame becomes the history for the next one (pure copy).
    // tHist MUST be rewired here: it still points at histRT.texture,
    // and a draw with its own target bound as a texture is a
    // feedback loop (GL_INVALID_OPERATION, draw is skipped → history
    // would stay black → every frame darkened 25%). writeBuffer as the copy
    // source is guaranteed not to be the target, and unused anyway at uAmount = 0.
    this.mat.uniforms.tSrc.value = writeBuffer.texture;
    this.mat.uniforms.tHist.value = writeBuffer.texture;
    this.mat.uniforms.uAmount.value = 0;
    renderer.setRenderTarget(this.histRT);
    this.quad.render(renderer);
    this.hasHistory = true;
  }

  dispose(): void {
    this.histRT?.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}
