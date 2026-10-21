import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/**
 * client/src/motion-blur.ts — SUBTILER Afterimage-Blur (velocity-frei).
 * ============================================================================
 *
 * Echte Velocity-Motion-Blur bräuchte Bewegungsvektoren pro Pixel (zusätzlicher
 * G-Buffer + Mehrpass-Kette) — overkill für einen Shooter, in dem das Bild
 * ständig woandershin schaut. Stattdessen: exponentielles Blending mit dem
 * vorherigen Frame (klassischer Afterimage-Ansatz), Stärke 0..0.5, DEFAULT AUS.
 *
 * needsSwap=true (kein Read/Write-Feedback auf demselben Target): Der gemixte
 * Frame geht ins writeBuffer und wird danach in die Historie kopiert. Beim
 * Deaktivieren wird die Historie invalidiert, damit ein Re-Aktivieren keinen
 * Geister-Frame einkopiert.
 */

const VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export class MotionBlurPass extends Pass {
  /** 0 = aus. Sinnvoll: 0.15..0.35. Alles darüber schmiert. */
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
          // Neighborhood-Clamp gegen Geisterbilder: Die Historie darf nur
          // Farben beitragen, die in der 3x3-Nachbarschaft des aktuellen
          // Frames vorkommen. Sonst schmiert dunkles Objekt (Optik-Gehäuse bei
          // Kamerabewegung!) als eckiger "hängender Block" nach — mit Clamp
          // bleibt das Motion-Feeling, ohne die Blöcke.
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

  /** Historie verwerfen (nach enable/disable/resize). */
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
      // Vom Canvas kann nicht zurückgelesen werden — Kette neu starten.
      this.hasHistory = false;
      return;
    }
    // Der gemixte Frame wird die Historie für den nächsten (reiner Copy).
    // Dabei MUSS tHist umgebogen werden: Es zeigt noch auf histRT.texture,
    // und ein Draw, der sein eigenes Target als Textur gebunden hat, ist eine
    // Feedback-Schleife (GL_INVALID_OPERATION, Draw wird geskippt → Historie
    // bliebe schwarz → jedes Frame 25 % abgedunkelt). writeBuffer ist als Copy-
    // Quelle garantiert nicht das Target und an uAmount = 0 ohnehin ungenutzt.
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
