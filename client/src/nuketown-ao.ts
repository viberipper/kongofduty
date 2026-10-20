import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { FOG_DENSITY, FOG_GROUND, FOG_H, FOG_VEIL } from "./nuketown-sky";

/**
 * NUKETOWN contact AO (OWNER: LIGHT, P1; WORK-ORDERS L5, orchestrator
 * decision 5a.5: hardware tier only, must pass every flicker-gate run).
 *
 * The bake (nt_bake.py) owns large-scale occlusion: sky visibility in the GI
 * lightmap, 1.6 m AO, the placed props as occluders. What a bake cannot give
 * is contact: a bus's tyres on the asphalt, a BBQ on the lawn, a mannequin's
 * feet, furniture in a corner, the props themselves (not lightmapped). This
 * pass adds that in screen space, before GRADE, in one cheap stack:
 *
 *  1. half-res AO from the resolved scene depth (normals from depth),
 *     SAO-style hemisphere estimator, 12 taps on a spiral, ~0.9 m world
 *     radius, faded out by 70 m (the bake covers distance);
 *  2. a 5 + 5 tap separable, depth-aware blur;
 *  3. full-res joint-bilateral upsample, multiplied into the HDR colour.
 *
 * ZERO-FLICKER: nothing is temporal. The per-pixel spiral rotation is a fixed
 * 4x4 interleaved pattern the blur integrates out, so a still camera renders
 * the identical frame every time (gate `temporal`) and a 7 mm move changes
 * the AO only as much as the geometry moved (gate `shimmer`).
 *
 * Depth: the composer targets' depth is resolved for this pass (the flicker
 * stream's depth-precision.ts leaves it unresolved because nothing else reads
 * it); reversed-Z (float32) and standard (24-bit) are both decoded. Pixels
 * nearer than 0.6 m (the viewmodel) take no AO.
 */
export class NuketownAO extends Pass {
  /** 0 = off, 1 = full (the composite strength). */
  strength = 0.7;
  /** QA: 1 = AO, 2 = linear depth bands, 3 = raw half-res AO (x0.5, pre-grade). */
  debug = 0;
  private aoRT: THREE.WebGLRenderTarget;
  private blurRT: THREE.WebGLRenderTarget;
  private aoQuad: FullScreenQuad;
  private blurQuad: FullScreenQuad;
  private compQuad: FullScreenQuad;
  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;

  constructor(private camera: THREE.PerspectiveCamera, composer: EffectComposer, reversed: boolean, private scene?: THREE.Scene) {
    super();
    this.needsSwap = true;
    // QA A/B only (perf, before/after captures): ?ntao=0 skips the pass
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("ntao") === "0") this.enabled = false;
    // the scene depth, resolved out of the MSAA buffer into a texture this pass can read
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      if (!rt.depthTexture) rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, THREE.UnsignedIntType);
      rt.resolveDepthBuffer = true;
      rt.dispose();
    }
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
      uniforms: { tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 400 }, uProj: { value: new THREE.Vector2(1, 1) }, uFull: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() }, uRadius: { value: 0.9 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `precision highp float;
        varying vec2 vUv; uniform vec2 uTexel, uRes; uniform float uRadius;
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
          // geometry and cannot crawl against it when the camera moves (a 4x4
          // interleaved pattern left a residue at depth edges that did)
          float rot = 0.3926991;  // 22.5 deg: the 8 directions sit between the axes
          float jit = 0.5;
          // near the eye a few mm of camera motion re-reveals parts of an overhang
          // (screen-space parallax): smaller radius there, and the strength fades in
          // from 1.5 m to 4.5 m (gate "shimmer"); contact at play distances is untouched
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
      uniforms: { tDiffuse: { value: null }, tAO: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 400 }, uProj: { value: new THREE.Vector2(1, 1) }, uFull: { value: new THREE.Vector2(1, 1) }, uHalf: { value: new THREE.Vector2() }, uStrength: { value: 0.85 }, uDebug: { value: 0 }, uFogColor: { value: new THREE.Color(0, 0, 0) }, uCamY: { value: 0 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `precision highp float;
        varying vec2 vUv; uniform sampler2D tDiffuse, tAO; uniform vec2 uHalf; uniform float uStrength; uniform int uDebug; uniform vec3 uFogColor; uniform float uCamY;
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
          ao = mix(1.0, ao, uStrength);
          // occlude the SURFACE, not the haze in front of it (nuketown-sky.ts installHeightFog,
          // level-ray approximation): col = surf (1 - f) + fog f  ->  surf (1 - f) ao + fog f
          float fogF = 1.0 - (1.0 - ${FOG_VEIL.toFixed(4)}) * exp(-${FOG_DENSITY.toFixed(6)} * d * (1.0 + ${FOG_GROUND.toFixed(3)} * exp(-max(uCamY, 0.0) / ${FOG_H.toFixed(2)})));
          col.rgb = col.rgb * ao + uFogColor * fogF * (1.0 - ao);
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

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 2));
    this.aoRT.setSize(w, h);
    this.blurRT.setSize(w, h);
    this.aoMat.uniforms.uTexel.value.set(1 / width, 1 / height);
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
    const fog = this.scene?.fog as THREE.FogExp2 | null | undefined;
    if (fog) this.compMat.uniforms.uFogColor.value.copy(fog.color);
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
