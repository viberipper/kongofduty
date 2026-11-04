/**
 * client/src/cine/lens.ts — the cinematic lens: depth of field, swoop motion
 * blur and a vignette, in ONE full-screen pass that only exists while a
 * cinematic is on screen (`enabled` false = zero cost in play).
 *
 * DEPTH. The scene depth comes from the render target the RenderPass drew
 * into this frame (captured by wrapping that pass), which in the default
 * "reversed" depth mode (client/src/depth-precision.ts) carries a 32-bit float
 * depth texture. Under MSAA that texture is only filled when the target
 * resolves depth, so `resolveDepthBuffer` is switched on for exactly the
 * frames the lens runs and restored after. When no usable depth exists (split
 * / standard depth modes, or the one ping-pong arrangement where the lens
 * would write into the buffer it reads depth from without MSAA), the lens
 * keeps blur + vignette and drops the focus.
 *
 * COST. 16 golden-angle taps at half the CoC, one pass, only during the intro
 * and the play of the game.
 */
import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";

const FRAG = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 uRes;
  uniform float uNear, uFar, uFocus, uAperture, uMaxBlur, uUseDepth, uRadial, uVignette, uFlash, uLift;
  uniform vec2 uCentre;
  varying vec2 vUv;

  float viewZ(float d) {
    // reversed-Z float depth: 1 = near, 0 = far
    return uNear * uFar / (uNear + d * (uFar - uNear));
  }
  float coc(vec2 uv) {
    if (uUseDepth < 0.5) return 0.0;
    float z = viewZ(texture2D(tDepth, uv).x);
    // thin-lens-ish: proportional to |1/focus - 1/z|, in pixels
    float c = uAperture * abs(1.0 / uFocus - 1.0 / max(z, 0.05)) * uFocus;
    return clamp(c, 0.0, uMaxBlur);
  }
  void main() {
    vec2 px = 1.0 / uRes;
    vec4 base = texture2D(tColor, vUv);
    float c0 = coc(vUv);
    vec3 acc = base.rgb;
    float wsum = 1.0;
    if (c0 > 0.6) {
      const float GA = 2.39996323;
      for (int i = 0; i < 16; i++) {
        float fi = float(i) + 0.5;
        float r = sqrt(fi / 16.0) * c0;
        vec2 o = vec2(cos(fi * GA), sin(fi * GA)) * r * px;
        vec2 uv = vUv + o;
        float ci = coc(uv);
        // a sharp foreground sample must not bleed into a blurred background
        float w = smoothstep(0.0, 1.0, ci / max(c0, 0.001) + 0.25);
        acc += texture2D(tColor, uv).rgb * w;
        wsum += w;
      }
    }
    vec3 col = acc / wsum;
    // RADIAL MOTION BLUR (the swoop): zoom blur toward uCentre
    if (uRadial > 0.001) {
      vec2 dir = (vUv - uCentre);
      vec3 rb = vec3(0.0);
      for (int i = 0; i < 10; i++) {
        float k = 1.0 - uRadial * 0.09 * float(i) / 9.0;
        rb += texture2D(tColor, uCentre + dir * k).rgb;
      }
      rb /= 10.0;
      float m = smoothstep(0.05, 0.55, length(dir));
      col = mix(col, rb, m * min(1.0, uRadial * 1.5));
    }
    // VIGNETTE + a touch of lift/crush, film not filter
    vec2 q = vUv - 0.5;
    float v = 1.0 - uVignette * smoothstep(0.25, 0.85, length(q * vec2(1.0, 0.82)) * 1.25);
    col *= v;
    // EXPOSURE KICK (GO, the freeze): light added in linear HDR before the grade — a punch, not a grey wash
    col = col * (1.0 + 2.2 * uLift) + uLift * 0.06;
    col = mix(col, vec3(1.0), uFlash);
    gl_FragColor = vec4(col, base.a);
  }
`;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class CineLens extends Pass {
  private quad: FullScreenQuad;
  readonly mat: THREE.ShaderMaterial;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private camera: THREE.PerspectiveCamera;
  private floatDepth: boolean;
  /** Focus distance (m), aperture (CoC px at 2x focus), radial blur 0..1, vignette 0..1, white flash 0..1. */
  focus = 20;
  aperture = 0;
  radial = 0;
  vignette = 0;
  flash = 0;
  /** exposure kick 0..1 (GO, the freeze) */
  lift = 0;
  centre = new THREE.Vector2(0.5, 0.5);

  constructor(composer: EffectComposer, camera: THREE.PerspectiveCamera, floatDepth: boolean) {
    super();
    this.camera = camera;
    this.floatDepth = floatDepth;
    this.needsSwap = true;
    this.enabled = false;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.03 },
        uFar: { value: 420 },
        uFocus: { value: 20 },
        uAperture: { value: 0 },
        uMaxBlur: { value: 14 },
        uUseDepth: { value: 0 },
        uRadial: { value: 0 },
        uVignette: { value: 0 },
        uFlash: { value: 0 },
        uLift: { value: 0 },
        uCentre: { value: new THREE.Vector2(0.5, 0.5) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
    // Which target did the world pass draw into this frame? (it alternates)
    const rp = composer.passes.find((p) => p instanceof RenderPass) as RenderPass | undefined;
    if (rp) {
      const orig = rp.render.bind(rp);
      rp.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
        this.sceneRT = readBuffer;
        orig(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      };
    }
    // Before the grade, so the blur happens in linear HDR like a lens would.
    const gradeAt = composer.passes.findIndex((p) => (p as { uniforms?: Record<string, unknown> }).uniforms?.uExposure);
    composer.insertPass(this, gradeAt >= 0 ? gradeAt : composer.passes.length);
    this.composer = composer;
  }

  private composer: EffectComposer;

  /** Switch on/off; on MSAA targets depth is resolved only while on. */
  setOn(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (this.floatDepth) {
      for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
        if (on) {
          (rt as unknown as { __cineResolve?: boolean }).__cineResolve = rt.resolveDepthBuffer;
          rt.resolveDepthBuffer = true;
        } else {
          const was = (rt as unknown as { __cineResolve?: boolean }).__cineResolve;
          if (was !== undefined) rt.resolveDepthBuffer = was;
        }
      }
    }
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const u = this.mat.uniforms;
    const scene = this.sceneRT;
    const depthOk = this.floatDepth && !!scene?.depthTexture && !(scene === writeBuffer && writeBuffer.samples === 0) && this.aperture > 0.05;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = depthOk ? scene!.depthTexture : null;
    u.uUseDepth.value = depthOk ? 1 : 0;
    u.uRes.value.set(readBuffer.width, readBuffer.height);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uFocus.value = Math.max(0.5, this.focus);
    // aperture is authored at 1080p; scale CoC with the buffer height
    const k = readBuffer.height / 1080;
    u.uAperture.value = this.aperture * k;
    u.uMaxBlur.value = 14 * k;
    u.uRadial.value = this.radial;
    u.uVignette.value = this.vignette;
    u.uFlash.value = this.flash;
    u.uLift.value = this.lift;
    u.uCentre.value.copy(this.centre);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.quad.dispose();
    this.mat.dispose();
  }
}
