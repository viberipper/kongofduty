/**
 * client/src/cinematic.ts — THE ONE FINAL PASS. Grade + AAA finish, fused.
 * ============================================================================
 *
 * Replaces the old GRADE object from game.ts (whose tonemap/encode maths and
 * mid-band depth live on here VERBATIM — at defaults NOTHING changes in the
 * signed look: chroma/sharpness/DOF are default-off, bloom/AO only on from
 * ULTRA up). On top of that, all in ONE fullscreen draw (no
 * extra RT swaps):
 *
 *  - Chromatic aberration (radial, 3-tap): grows toward the edges, ~1.4px at
 *    the corner, computed in REAL pixels via uTexel — DPR- and
 *    resolution-independent (M2). Subtle — no retro filter.
 *  - Film grain (animated): hash grain ±0.8%, switchable (uGrain).
 *  - Vignette: the old one (0.07 + ADS*0.16), switchable (uVignette).
 *  - Colour grade: saturation / contrast / warmth as uniforms (defaults = the
 *    old look: saturation 0.97, contrast 1.0, warmth neutral).
 *  - Sharpness (CAS-lite): luma highpass from 4 neighbours, 0..1 (default 0 = off,
 *    M1). Tap spacing = uTexel, no fixed 1280x720 (M4).
 *  - DOF-lite (bokeh fake without a depth buffer): the edges are softened with 4
 *    diagonal taps, mask = radius². DEFAULT OFF.
 *
 * Motion blur and bloom are their OWN passes (bloom.ts, motion-blur.ts): bloom
 * needs a mip chain, motion blur a history — neither fits into a
 * single-tap pass. AO is ssao.ts. Everything else is in here so
 * the chain stays render → AO → bloom → [motion] → CINEMATIC → [FXAA].
 *
 * QA BASELINES (flicker-qa/depthProbe, m7): at HIGH defaults every effect
 * here is deterministic — no temporal (AO static, bloom static, grain
 * time-based but bit-identical to the old GRADE grain, motion off). Chroma/
 * sharpness/bloom are default-off so graded-pixel probes measure the signed
 * pipeline.
 */

import * as THREE from "three";

export const CINEMATIC = {
  // NIT (review round 2, documented instead of wired): uSaturation /
  // uContrast / uWarmth / uDofStrength have NO settings owner — they
  // are fixed grade constants of the signed look (saturation 0.97,
  // contrast 1.0, warmth neutral, DOF mask 0.5). uWarmth would be the natural
  // next slider candidate; until then: touching = changing the look.
  uniforms: {
    tDiffuse: { value: null as unknown },
    uTime: { value: 0 },
    uHurt: { value: 0 },
    uAds: { value: 0 },
    uExposure: { value: 1.12 },
    uChroma: { value: 0 },
    uGrain: { value: 1 },
    uVignette: { value: 1 },
    uSaturation: { value: 0.97 },
    uContrast: { value: 1.0 },
    uWarmth: { value: 0.5 },
    uSharpen: { value: 0 },
    uDof: { value: 0 },
    uDofStrength: { value: 0.5 },
    /** 1/RT size in pixels — game.ts sets it from the drawing-buffer size (M4). */
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime; uniform float uHurt; uniform float uAds;
    uniform float uExposure;
    uniform float uChroma; uniform float uGrain; uniform float uVignette;
    uniform float uSaturation; uniform float uContrast; uniform float uWarmth;
    uniform float uSharpen; uniform float uDof; uniform float uDofStrength;
    uniform vec2 uTexel;
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
      // Last safety net before the tonemapper: rrtODT has a
      // quadratic term (v*v) that overflows to Inf/NaN on HalfFloat values >~250
      // -> 0/0 = black. Range comparison (WITHOUT isnan() — ANGLE/
      // HLSL optimises isnan() away, warning X3577!) + clamp to [0,64].
      if (!(col.r >= 0.0 && col.r <= 60000.0)) col.r = 0.0;
      if (!(col.g >= 0.0 && col.g <= 60000.0)) col.g = 0.0;
      if (!(col.b >= 0.0 && col.b <= 60000.0)) col.b = 0.0;
      col = min(col, vec3(64.0));
      col *= uExposure / 0.6;
      col = OUT * rrtODT(IN * col);
      return clamp(col, 0.0, 1.0);
    }
    vec3 encodeSRGB(vec3 c){
      return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
    }
    /**
     * MID-BAND DEPTH (taken from GRADE, unchanged): filmic S-curve
     * on LUMA, window 0.18..1.0, everything below untouched (dark gate),
     * one ratio per pixel (no hue/saturation drift).
     */
    vec3 depth(vec3 c){
      float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (y < 0.18) return c;
      float w = smoothstep(0.18, 0.52, y) * (1.0 - smoothstep(0.60, 1.0, y));
      float s = y * y * (3.0 - 2.0 * y);
      return c * (1.0 + (s - y) * 0.55 * w / max(y, 1e-4));
    }
    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      // --- CHROMATIC ABERRATION: radial, 3-tap (R out, B in).
      // M2: in REAL pixels (uTexel), coefficient 4.0 -> at the corner
      // |c|*r2*4 = 0.707*0.5*4 ≈ 1.4px — regardless of resolution/DPR.
      // Previously 0.045 in UV here (up to ~32px @1080p), 20x too strong.
      vec3 col;
      if (uChroma > 0.5) {
        vec2 dir = c * (r2 * 4.0) * uTexel;
        col.r = texture2D(tDiffuse, uv + dir).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - dir).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }
      // --- DOF-LITE: soft edges (4 diagonal taps), mask = radius squared.
      if (uDof > 0.5 && uDofStrength > 0.001) {
        float m = smoothstep(0.02, 0.42, r2) * uDofStrength;
        vec2 px = uTexel * (1.0 + r2 * 6.0);
        vec3 b = texture2D(tDiffuse, uv + px * vec2(1.0, 1.0)).rgb
               + texture2D(tDiffuse, uv + px * vec2(-1.0, 1.0)).rgb
               + texture2D(tDiffuse, uv + px * vec2(1.0, -1.0)).rgb
               + texture2D(tDiffuse, uv + px * vec2(-1.0, -1.0)).rgb;
        col = mix(col, b * 0.25, m * 0.85);
      }
      // --- SHARPNESS (CAS-lite): luma highpass from 4 neighbours (uTexel, M4).
      // IMPORTANT: taps are clamped to [0, 2] — on raw HDR pixels (e.g.
      // muzzle/impact flash + bloom = 10..60) a negative highpass next
      // to the flash would otherwise yield l0 - 15*0.45 < 0 -> after ACES a
      // BLACK RING / BOX around every flash on ULTRA/CINEMATIC!
      // Sharpness belongs only in the display range; HDR peaks do not need it.
      if (uSharpen > 0.001) {
        vec3 c0 = clamp(col, 0.0, 2.0);
        float l0 = dot(c0, vec3(0.2126, 0.7152, 0.0722));
        vec3 cx1 = clamp(texture2D(tDiffuse, uv + vec2(uTexel.x, 0.0)).rgb, 0.0, 2.0);
        vec3 cx2 = clamp(texture2D(tDiffuse, uv - vec2(uTexel.x, 0.0)).rgb, 0.0, 2.0);
        vec3 cy1 = clamp(texture2D(tDiffuse, uv + vec2(0.0, uTexel.y)).rgb, 0.0, 2.0);
        vec3 cy2 = clamp(texture2D(tDiffuse, uv - vec2(0.0, uTexel.y)).rgb, 0.0, 2.0);
        float lx = (dot(cx1, vec3(0.2126, 0.7152, 0.0722)) + dot(cx2, vec3(0.2126, 0.7152, 0.0722))) * 0.5;
        float ly = (dot(cy1, vec3(0.2126, 0.7152, 0.0722)) + dot(cy2, vec3(0.2126, 0.7152, 0.0722))) * 0.5;
        float hp = clamp(l0 - (lx + ly) * 0.5, -0.25, 0.25);
        col = max(vec3(0.0), col + vec3(hp) * uSharpen * 0.9);
      }
      // --- COLOUR GRADE: warmth (WB-lite, symmetric around white: warmth=0.5 is exactly neutral), contrast, saturation.
      // Review round 2: the tint pair (0.93,1,1.07)/(1.07,1,0.93) averages to (1,1,1) — no red lift in the default.
      vec3 warmTint = mix(vec3(0.93, 1.0, 1.07), vec3(1.07, 1.0, 0.93), uWarmth);
      col *= mix(vec3(1.0), warmTint, 0.5);
      col = (col - 0.18) * uContrast + 0.18;
      // The old look: warm slope + 3% desaturation (now parametrised).
      col *= vec3(1.14, 1.08, 1.0);
      col = mix(vec3(dot(col, vec3(0.3, 0.5, 0.2))), col, uSaturation);
      // --- VIGNETTE (the old one, switchable) + hurt overlay.
      float v = 1.0 - r2 * (0.07 + uAds * 0.16) * uVignette;
      col *= v;
      col += uHurt * vec3(0.25, 0.02, 0.02);
      // --- FILM GRAIN (animated), switchable.
      col += (n(uv * vec2(1100.0, 800.0) + uTime * 40.0) - 0.5) * 0.008 * uGrain;
      gl_FragColor = vec4(depth(encodeSRGB(aces(col))), 1.0);
    }
  `,
};
