import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";

/**
 * client/src/ssao.ts — MAP-UNABHÄNGIGE Screen-Space Kontakt-AO (OWNER: LIGHT).
 * ============================================================================
 *
 * Verallgemeinerung von client/src/nuketown-ao.ts (dessen ZERO-FLICKER-
 * Begründung gilt unverändert: keine Temporal-Anteile, eine feste
 * Tap-Rotation, Mean statt Horizon-Max). Unterschiede zum Nuketown-Original:
 *
 *  - FOG JE MAP (m1), kein Nuketown-Hardcode: uFogMode 0 = kein/unbekannter
 *    Fog, 1 = FogExp2 (Standard-exp2), 2 = lineares THREE.Fog (dust2/jungle —
 *    exakt threes smoothstep(near, far, d)), 3 = Nuketown-Height-Fog. Für
 *    Modus 3 ruft game.ts setHeightFog() mit den Konstanten aus
 *    nuketown-sky.ts auf (kein statischer Import hier — sonst stünde der
 *    Nuketown-Sky in jedem Map-Bundle). Unbekannter Fog: AO blendet ab 25 m
 *    auf 1.0, damit nie in vernebelte Farbe hinein-okkludiert wird.
 *  - Läuft auf ALLEN Maps (vor dem Cinematic-Pass, Hardware-Tier only) —
 *    AUSSER im Split-Depth-Modus (MINOR 1, 3. Review): Ohne EXT_clip_control
 *    löscht der ViewmodelPass (depth-precision.ts) die Szenentiefe nach dem
 *    Welt-Pass, sodass AO überall die Far-Ebene lesen würde (stiller No-op).
 *    game.ts baut den Pass dort gar nicht (mit console.info-Grund); der
 *    AO-Schalter im Menü bleibt wirkungslos — siehe Settings-Desc.
 *  - QA-Killswitch: `?ssao=0` (alias `?ntao=0`) — dann wird auch kein
 *    Depth-Resolve bezahlt (m2): Der Konstruktor fasst die Composer-Targets
 *    nur an, wenn der Pass jemals laufen kann.
 *  - QA-BASELINES (m7): HIGH-Defaults lassen den Pass aus (ao:false) — und
 *    wenn an, ist er deterministisch: kein Temporal, fixe Taps, keine
 *    Historie. flicker-qa/depthProbe messen die signierte Pipeline.
 */
export class ContactAO extends Pass {
  /** 0 = off, 1 = full (the composite strength). */
  strength = 0.7;
  /** QA: 1 = AO, 2 = linear depth bands, 3 = raw half-res AO (x0.5). */
  debug = 0;
  /** QA-Killswitch (?ssao=0): enabled bleibt aus — setGraphicsOptions() kann ihn
   *  nicht einschalten (nur ein Reload ohne Flag hilft). NIT 4: präzise so,
   *  nicht "wird nie eingeschaltet" (der Pass kann per Pref/Reload laufen). */
  readonly qaOff: boolean;
  /** m2: true sobald die Composer-Targets einen resolveten Depth-Texture tragen. */
  depthResolved = false;
  private heightFog: { density: number; ground: number; h: number; veil: number } | null = null;
  private aoRT: THREE.WebGLRenderTarget;
  private blurRT: THREE.WebGLRenderTarget;
  private aoQuad: FullScreenQuad;
  private blurQuad: FullScreenQuad;
  private compQuad: FullScreenQuad;
  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;

  constructor(private camera: THREE.PerspectiveCamera, composer: EffectComposer, reversed: boolean, private scene?: THREE.Scene, prefOn = true) {
    super();
    this.needsSwap = true;
    // QA A/B only (perf, before/after captures): ?ssao=0 (alias ?ntao=0) skips the pass
    let qaOff = false;
    try {
      const q = new URLSearchParams(location.search);
      qaOff = q.get("ssao") === "0" || q.get("ntao") === "0";
    } catch {
      /* no location */
    }
    this.qaOff = qaOff;
    if (qaOff) this.enabled = false;
    // m2: Depth-Resolve nur, wenn der Pass laufen kann UND die Pref an ist.
    // Bei Default-aus (HIGH) zahlt kein Frame den Resolve; wer AO live
    // einschaltet, bekommt ihn einmalig via ensureDepthResolved() nachgereicht.
    else if (prefOn) this.ensureDepthResolved(composer);
    else this.enabled = false;
    const half = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.aoRT = half();
    this.blurRT = half();
    const depthFns = /* glsl */ `
      uniform sampler2D tDepth; uniform float uNear, uFar; uniform vec2 uProj, uFull;
      float viewZ(float d){
        ${reversed ? "return -uNear * uFar / (d * (uFar - uNear) + uNear);" : "return (uNear * uFar) / ((uFar - uNear) * d - uFar);"}
      }
      // reconstruct at the exact centre of the depth texel actually read (a half-res
      // pixel sits between four of them: unsnapped, flat planes become staircases)
      // integer texel addressing throughout: a half-res pixel centre lands exactly on
      // a full-res texel boundary, and float rounding there flips texels in stripes
      vec3 viewPosI(ivec2 ip){
        ip = clamp(ip, ivec2(0), ivec2(uFull) - 1);
        vec2 s = (vec2(ip) + 0.5) / uFull;
        float z = viewZ(texelFetch(tDepth, ip, 0).r);
        return vec3((s * 2.0 - 1.0) * (-z) / uProj, z);
      }`;
    this.aoMat = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 400 }, uProj: { value: new THREE.Vector2(1, 1) }, uFull: { value: new THREE.Vector2(1, 1) }, uRes: { value: new THREE.Vector2() }, uRadius: { value: 0.9 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `precision highp float;
        varying vec2 vUv; uniform vec2 uRes; uniform float uRadius;
        ${depthFns}
        void main(){
          ivec2 ic = ivec2(gl_FragCoord.xy) * 2;
          vec3 P = viewPosI(ic);
          float dist = -P.z;
          if (dist < 0.6 || dist > 78.0) { gl_FragColor = vec4(1.0, dist, 0.0, 1.0); return; }
          // normal from depth: the smaller step on each axis (no smearing across silhouettes)
          vec3 px = viewPosI(ic + ivec2(1, 0)) - P, nx = P - viewPosI(ic - ivec2(1, 0));
          vec3 py = viewPosI(ic + ivec2(0, 1)) - P, ny = P - viewPosI(ic - ivec2(0, 1));
          vec3 dx = abs(px.z) < abs(nx.z) ? px : nx, dy = abs(py.z) < abs(ny.z) ? py : ny;
          vec3 N = normalize(cross(dx, dy));
          // ONE fixed set of directions and step offsets for every pixel: no
          // screen-space pattern at all, so the AO is a pure function of the
          // geometry and cannot crawl against it when the camera moves.
          float rot = 0.3926991;  // 22.5 deg: the 8 directions sit between the axes
          float jit = 0.5;
          // near the eye a few mm of camera motion re-reveals parts of an overhang
          // (screen-space parallax): smaller radius there, and the strength fades in
          // from 1.5 m to 4.5 m; contact at play distances is untouched
          float rad = min(uRadius, 0.2 + 0.25 * dist);
          float rPx = min(rad * uProj.y * 0.5 * uRes.y / dist, 64.0);
          float r2 = rad * rad;
          // falloff-weighted MEAN over 6 steps per direction (not the horizon max: a
          // max switches wholesale when one step slides onto an edge, which crawls
          // under millimetre camera moves; a mean moves by 1/48 per step)
          float occ = 0.0;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.7853982 + rot;
            vec2 dir = vec2(cos(a), sin(a));
            float h = 0.0;
            for (int j = 0; j < 6; j++) {
              float t = (float(j) + jit) / 6.0;
              vec2 o = dir * max(t * t * rPx, 1.0 + float(j));
              vec3 v = viewPosI(ic + ivec2(floor(o * 2.0 + 0.5))) - P;
              float vv = dot(v, v);
              float w = 1.0 - smoothstep(r2 * 0.35, r2, vv);
              h += max(dot(v, N) * inversesqrt(vv + 1e-6) - 0.08, 0.0) * w;
            }
            occ += h / 6.0;
          }
          float ao = 1.0 - clamp(occ / 8.0, 0.0, 1.0) * 2.6;
          // surfaces seen edge-on (board ends, thin trim): the depth-derived normal is
          // ill-conditioned there and flips with millimetre camera moves; no AO on them
          ao = mix(1.0, ao, smoothstep(0.12, 0.35, abs(dot(N, normalize(-P)))));
          ao = clamp(ao, 0.0, 1.0);
          ao = mix(ao, 1.0, smoothstep(45.0, 78.0, dist) + 1.0 - smoothstep(1.5, 4.5, dist));
          gl_FragColor = vec4(ao, dist, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tAO: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `precision highp float;
        varying vec2 vUv; uniform sampler2D tAO; uniform vec2 uDir;
        void main(){
          vec2 c = texture2D(tAO, vUv).rg;
          float s = 0.0, w = 0.0;
          for (int i = -2; i <= 1; i++) {
            vec2 t = texture2D(tAO, vUv + uDir * float(i)).rg;
            float k = exp(-abs(t.g - c.g) / max(0.05 * c.g, 0.03)) + 1e-4;
            s += t.r * k;
            w += k;
          }
          gl_FragColor = vec4(s / w, c.g, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tAO: { value: null }, tDepth: { value: null },
        uNear: { value: 0.1 }, uFar: { value: 400 }, uProj: { value: new THREE.Vector2(1, 1) },
        uFull: { value: new THREE.Vector2(1, 1) }, uHalf: { value: new THREE.Vector2() },
        uStrength: { value: 0.85 }, uDebug: { value: 0 },
        uFogColor: { value: new THREE.Color(0, 0, 0) },
        uFogMode: { value: 0 }, uFogDensity: { value: 0 },
        uFogNear: { value: 0 }, uFogFar: { value: 1 },
        uFogGround: { value: 0 }, uFogH: { value: 1 }, uFogVeil: { value: 0 },
        uFogUnknown: { value: 0 }, uCamY: { value: 0 },
      },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `precision highp float;
        varying vec2 vUv; uniform sampler2D tDiffuse, tAO; uniform vec2 uHalf;
        uniform float uStrength; uniform int uDebug; uniform vec3 uFogColor;
        uniform int uFogMode; uniform float uFogDensity; uniform float uFogNear, uFogFar;
        uniform float uFogGround, uFogH, uFogVeil, uFogUnknown, uCamY;
        ${depthFns}
        void main(){
          vec4 col = texture2D(tDiffuse, vUv);
          float d = -viewZ(texture2D(tDepth, vUv).r);
          // joint-bilateral upsample from the 4 nearest half-res texels
          vec2 p = vUv / uHalf - 0.5, f = fract(p), b = (floor(p) + 0.5) * uHalf;
          float s = 0.0, w = 0.0;
          for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
            vec2 t = texture2D(tAO, b + vec2(float(i), float(j)) * uHalf).rg;
            float k = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) + 1e-3;
            k *= exp(-abs(t.g - d) / max(0.03 * d, 0.02));
            s += t.r * k;
            w += k;
          }
          float ao = w > 1e-4 ? s / w : 1.0;
          if (!(ao >= 0.0 && ao <= 1.0)) ao = 1.0;
          // Review-Runde 2: uStrength bis 1.5 darf nie invertieren — klemmen
          // (schützt Slider wie Presets).
          ao = clamp(mix(1.0, ao, uStrength), 0.0, 1.0);
          // MAP-AGNOSTIC FOG (m1): occlude the SURFACE, not the haze in front
          // of it (col = surf (1 - f) + fog f  ->  surf (1 - f) ao + fog f (1 - ao)).
          float fogF = 0.0;
          if (uFogMode == 1) fogF = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
          else if (uFogMode == 2) fogF = smoothstep(uFogNear, uFogFar, d);
          else if (uFogMode == 3) fogF = 1.0 - (1.0 - uFogVeil) * exp(-uFogDensity * d * (1.0 + uFogGround * exp(-max(uCamY, 0.0) / uFogH)));
          col.rgb = col.rgb * ao + uFogColor * fogF * (1.0 - ao);
          // Unbekannter Fog-Typ: AO ab 25 m ausblenden, damit nie in bereits
          // vernebelte Farbe hinein-okkludiert wird.
          if (uFogMode == 0 && uFogUnknown > 0.5) {
            float fade = smoothstep(25.0, 78.0, d);
            col.rgb = mix(col.rgb, texture2D(tDiffuse, vUv).rgb, fade);
          }
          if (uDebug == 1) col.rgb = vec3(ao) * 0.5;
          if (uDebug == 2) col.rgb = vec3(fract(d * 0.5)) * 0.5;
          if (uDebug == 3) col.rgb = vec3(texture2D(tAO, vUv).r) * 0.5;
          gl_FragColor = col;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.aoQuad = new FullScreenQuad(this.aoMat);
    this.blurQuad = new FullScreenQuad(this.blurMat);
    this.compQuad = new FullScreenQuad(this.compMat);
  }

  /**
   * Nuketown-Height-Fog einkoppeln (m1): game.ts übergibt die Konstanten aus
   * nuketown-sky.ts NACH dem dynamischen Sky-Import — dieser Import bleibt
   * map-agnostisch und zieht den Sky in kein anderes Map-Bundle.
   *
   * NIT 3 (3. Review, bewusste Näherung statt K-Faktor): Der shipped
   * Height-Fog (nuketown-sky.ts) gewichtet zusätzlich mit
   * K = (1 - e^(-dY/H)) / (dY/H) über die Höhendifferenz dY. Hier steht die
   * Formel OHNE K — exakt wie im zuvor shipped NuketownAO (nuketown-ao.ts):
   * K → 1 für dY → 0 (der Contact-Radius ≤ 0.9 m, dY klein) und der Fog-Term
   * wirkt erst jenseits ~10 m, wo die AO längst auf 1.0 verblasst (45–78 m).
   * Angleichen würde World-Y pro Pixel brauchen (teurer Reconstruct) für
   * einen Term, der im AO-Fenster ≈ 1 ist — dokumentiert statt gerechnet.
   */
  setHeightFog(p: { density: number; ground: number; h: number; veil: number } | null): void {
    this.heightFog = p;
  }

  /**
   * m2: Depth-Resolve nachreichen (einmalig). Die Composer-Targets werden
   * disposed, damit three sie mit Depth-Texture neu anlegt — ein Re-Alloc
   * beim expliziten Einschalten, nie pro Frame.
   */
  ensureDepthResolved(composer: EffectComposer): void {
    if (this.depthResolved) return;
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      if (!rt.depthTexture) rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, THREE.UnsignedIntType);
      rt.resolveDepthBuffer = true;
      rt.dispose();
    }
    this.depthResolved = true;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 2));
    this.aoRT.setSize(w, h);
    this.blurRT.setSize(w, h);
    this.aoMat.uniforms.uRes.value.set(w, h);
    this.compMat.uniforms.uHalf.value.set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const cam = this.camera;
    const P = cam.projectionMatrix.elements;
    for (const m of [this.aoMat, this.compMat]) {
      m.uniforms.tDepth.value = readBuffer.depthTexture;
      m.uniforms.uNear.value = cam.near;
      m.uniforms.uFar.value = cam.far;
      m.uniforms.uProj.value.set(P[0]!, P[5]!);
      m.uniforms.uFull.value.set(readBuffer.width, readBuffer.height);
    }
    if (this.aoRT.width !== Math.max(1, Math.round(readBuffer.width / 2))) this.setSize(readBuffer.width, readBuffer.height);
    renderer.setRenderTarget(this.aoRT);
    this.aoQuad.render(renderer);
    this.blurMat.uniforms.tAO.value = this.aoRT.texture;
    this.blurMat.uniforms.uDir.value.set(1 / this.aoRT.width, 0);
    renderer.setRenderTarget(this.blurRT);
    this.blurQuad.render(renderer);
    this.blurMat.uniforms.tAO.value = this.blurRT.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this.aoRT.height);
    renderer.setRenderTarget(this.aoRT);
    this.blurQuad.render(renderer);
    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.tAO.value = this.aoRT.texture;
    this.compMat.uniforms.uStrength.value = this.strength;
    this.compMat.uniforms.uDebug.value = this.debug;
    // m1: Fog je Map auflösen.
    const u = this.compMat.uniforms;
    const fog = this.scene?.fog as THREE.FogExp2 | THREE.Fog | null | undefined;
    u.uFogUnknown.value = 0;
    if (this.heightFog && fog && (fog as THREE.FogExp2).isFogExp2) {
      u.uFogMode.value = 3;
      u.uFogColor.value.copy((fog as THREE.FogExp2).color);
      u.uFogDensity.value = this.heightFog.density;
      u.uFogGround.value = this.heightFog.ground;
      u.uFogH.value = this.heightFog.h;
      u.uFogVeil.value = this.heightFog.veil;
    } else if (fog && (fog as THREE.FogExp2).isFogExp2) {
      u.uFogMode.value = 1;
      u.uFogColor.value.copy((fog as THREE.FogExp2).color);
      u.uFogDensity.value = (fog as THREE.FogExp2).density;
    } else if (fog && (fog as THREE.Fog).isFog) {
      u.uFogMode.value = 2;
      u.uFogColor.value.copy((fog as THREE.Fog).color);
      u.uFogNear.value = (fog as THREE.Fog).near;
      u.uFogFar.value = (fog as THREE.Fog).far;
    } else {
      u.uFogMode.value = 0;
      if (fog) u.uFogUnknown.value = 1;
    }
    this.compMat.uniforms.uCamY.value = cam.position.y;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compQuad.render(renderer);
  }

  dispose(): void {
    this.aoRT.dispose();
    this.blurRT.dispose();
    for (const m of [this.aoMat, this.blurMat, this.compMat]) m.dispose();
    for (const q of [this.aoQuad, this.blurQuad, this.compQuad]) q.dispose();
  }
}
