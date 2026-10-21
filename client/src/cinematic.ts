/**
 * client/src/cinematic.ts — DER EINE FINALE PASS. Grade + AAA-Finish, fused.
 * ============================================================================
 *
 * Ersetzt das alte GRADE-Objekt aus game.ts (dessen Tonemap-/Encode-Math und
 * Mid-Band-Depth hier VERBATIM weiterleben — bei Defaults ändert sich am
 * signierten Look NICHTS: Chroma/Schärfe/DOF sind default-aus, Bloom/AO erst
 * ab ULTRA an). Dazu kommen, alle in EINEM Fullscreen-Draw (keine
 * zusätzlichen RT-Swaps):
 *
 *  - Chromatic Aberration (radial, 3-Tap): wächst zum Rand hin, ~1.4px an der
 *    Ecke, in ECHTEN Pixeln über uTexel gerechnet — DPR- und
 *    auflösungsunabhängig (M2). Subtil — kein Retro-Filter.
 *  - Film Grain (animiert): Hash-Korn ±0.8%, abschaltbar (uGrain).
 *  - Vignette: die alte (0.07 + ADS*0.16), abschaltbar (uVignette).
 *  - Color Grade: Sättigung / Kontrast / Wärme als Uniforms (Defaults = der
 *    alte Look: Sättigung 0.97, Kontrast 1.0, Wärme neutral).
 *  - Schärfe (CAS-lite): Luma-Highpass aus 4 Nachbarn, 0..1 (Default 0 = aus,
 *    M1). Tap-Abstand = uTexel, kein festes 1280x720 (M4).
 *  - DOF-lite (Bokeh-Fake ohne Depth-Buffer): die Ränder werden mit 4
 *    Diagonal-Taps weichgezeichnet, Maske = Radius². DEFAULT AUS.
 *
 * Motion Blur und Bloom sind EIGENE Pässe (bloom.ts, motion-blur.ts): Bloom
 * braucht eine Mip-Kette, Motion Blur eine Historie — beides passt nicht in
 * einen Single-Tap-Pass. AO ist ssao.ts. Alles andere ist hier drin, damit
 * die Chain bei Render → AO → Bloom → [Motion] → CINEMATIC → [FXAA] bleibt.
 *
 * QA-BASELINES (flicker-qa/depthProbe, m7): Bei HIGH-Defaults ist jeder Effekt
 * hier deterministisch — kein Temporal (AO statisch, Bloom statisch, Grain
 * zeitbasiert aber bit-identisch zum alten GRADE-Korn, Motion aus). Chroma/
 * Schärfe/Bloom sind default-aus, damit gegradete-Pixel-Proben die signierte
 * Pipeline messen.
 */

import * as THREE from "three";

export const CINEMATIC = {
  // NIT (Review-Runde 2, dokumentiert statt verdrahtet): uSaturation /
  // uContrast / uWarmth / uDofStrength haben KEINEN Settings-Eigentümer — sie
  // sind fixierte Grade-Konstanten des signierten Looks (Sättigung 0.97,
  // Kontrast 1.0, Wärme neutral, DOF-Maske 0.5). uWarmth wäre der natürliche
  // nächste Slider-Kandidat; bis dahin: anfassen = Look ändern.
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
    /** 1/RT-Größe in Pixeln — game.ts setzt es aus der Drawing-Buffer-Größe (M4). */
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
      // Letztes Sicherheitsnetz vor dem Tonemapper: rrtODT hat einen
      // quadratischen Term (v*v), der bei HalfFloat-Werten >~250 in Inf/NaN
      // überläuft -> 0/0 = schwarz. Bereichsvergleich (OHNE isnan() — ANGLE/
      // HLSL optimiert isnan() weg, warning X3577!) + Clamp auf [0,64].
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
     * MID-BAND DEPTH (aus GRADE übernommen, unverändert): filmische S-Kurve
     * auf LUMA, Fenster 0.18..1.0, alles darunter unangetastet (Darkgate),
     * ein Verhältnis pro Pixel (kein Hue-/Sättigungsdrift).
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
      // --- CHROMATIC ABERRATION: radial, 3-Tap (R raus, B rein).
      // M2: in ECHTEN Pixeln (uTexel), Koeffizient 4.0 -> an der Ecke
      // |c|*r2*4 = 0.707*0.5*4 ≈ 1.4px — egal bei welcher Auflösung/DPR.
      // Zuvor stand hier 0.045 in UV (bis ~32px @1080p), 20x zu stark.
      vec3 col;
      if (uChroma > 0.5) {
        vec2 dir = c * (r2 * 4.0) * uTexel;
        col.r = texture2D(tDiffuse, uv + dir).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - dir).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }
      // --- DOF-LITE: weiche Ränder (4 Diagonal-Taps), Maske = Radius hoch 2.
      if (uDof > 0.5 && uDofStrength > 0.001) {
        float m = smoothstep(0.02, 0.42, r2) * uDofStrength;
        vec2 px = uTexel * (1.0 + r2 * 6.0);
        vec3 b = texture2D(tDiffuse, uv + px * vec2(1.0, 1.0)).rgb
               + texture2D(tDiffuse, uv + px * vec2(-1.0, 1.0)).rgb
               + texture2D(tDiffuse, uv + px * vec2(1.0, -1.0)).rgb
               + texture2D(tDiffuse, uv + px * vec2(-1.0, -1.0)).rgb;
        col = mix(col, b * 0.25, m * 0.85);
      }
      // --- SCHÄRFE (CAS-lite): Luma-Highpass aus 4 Nachbarn (uTexel, M4).
      // WICHTIG: Taps werden auf [0, 2] geclampet — auf rohen HDR-Pixeln (z.B.
      // Mündungs-/Impact-Blitz + Bloom = 10..60) würde ein negativer Highpass
      // neben dem Blitz sonst l0 - 15*0.45 < 0 ergeben -> nach ACES ein
      // SCHWARZER RING / KASTEN um jeden Blitz auf ULTRA/CINEMATIC!
      // Schärfe gehört nur in den Display-Bereich; HDR-Spitzen brauchen sie nicht.
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
      // --- COLOR GRADE: Wärme (WB-lite, symmetrisch um Weiß: warmth=0.5 ist exakt neutral), Kontrast, Sättigung.
      // Review-Runde 2: Tint-Paar (0.93,1,1.07)/(1.07,1,0.93) mittelt zu (1,1,1) — kein Rot-Lift im Default.
      vec3 warmTint = mix(vec3(0.93, 1.0, 1.07), vec3(1.07, 1.0, 0.93), uWarmth);
      col *= mix(vec3(1.0), warmTint, 0.5);
      col = (col - 0.18) * uContrast + 0.18;
      // Der alte Look: warmer Slope + 3% Entsättigung (jetzt parametrisiert).
      col *= vec3(1.14, 1.08, 1.0);
      col = mix(vec3(dot(col, vec3(0.3, 0.5, 0.2))), col, uSaturation);
      // --- VIGNETTE (die alte, abschaltbar) + Hurt-Overlay.
      float v = 1.0 - r2 * (0.07 + uAds * 0.16) * uVignette;
      col *= v;
      col += uHurt * vec3(0.25, 0.02, 0.02);
      // --- FILM GRAIN (animiert), abschaltbar.
      col += (n(uv * vec2(1100.0, 800.0) + uTime * 40.0) - 0.5) * 0.008 * uGrain;
      gl_FragColor = vec4(depth(encodeSRGB(aces(col))), 1.0);
    }
  `,
};
