/**
 * WEAPON FX — GPU PARTICLE FAMILIES.
 *
 * Ported from Kong Royale's fx-gpu.ts (client/src/weapons/fx-gpu.ts there) and
 * restyled from its toon look to a CoD/Warzone read: no petals, no cartoon
 * stars, no cel-shaded puffs — hot sparks, thin streaked tracers, lit dust,
 * dark blood mist and bullet holes that take the lighting of the wall they sit on.
 *
 * One instanced quad draw per family. Each particle is simulated STATELESSLY on
 * the GPU from its spawn record (position, velocity, drag, gravity, size curve,
 * birth time), so the per-frame CPU cost is O(1): advance a time uniform and
 * upload only the records written this frame. Spawning writes 24 floats into a
 * fixed-size ring buffer — zero allocation per shot, the oldest record is
 * simply overwritten when the ring wraps (that IS the decal cap).
 *
 * BIRTH TIMES ARE STAMPED AT FLUSH, not at emit. Events arrive inside the fixed
 * ticks, before draw() advances the FX clock; stamping at emit would make every
 * particle's first rendered frame `dt` old, which on a 50 ms muzzle flash is a
 * third of its life gone before it is ever seen. emit() stores the requested
 * delay, flush() adds the clock it is about to render with, so every particle
 * is drawn at age 0 on its first frame (and `delay` still schedules impacts for
 * when the round actually arrives).
 *
 * Blending:
 *   glow  — premultiplied (ONE, ONE_MINUS_SRC_ALPHA): alpha 0 is purely additive
 *           (sparks, tracers), alpha > 0 lets a flame body occlude a little.
 *   smoke — premultiplied, lit by an approximation of the map's sun + sky.
 *   decal — MODULATE 2x (dst * src * 2): a bullet hole never has its own
 *           lighting, it darkens (or lifts) whatever the wall's own shading is,
 *           so a hole in container shadow is in shadow and one in sun is in sun.
 *           src 0.5 = no change, so a fading decal just eases toward 0.5.
 */
import * as THREE from "three";
import type { AnyRenderer } from "../../gpu-backend";

/** How a quad is oriented (vertex shader). */
export const M = { BILL: 0, STRETCH: 1, AXIS: 2, SEG: 3, TRACER: 4, PLANE: 5 } as const;
/** Glow family shapes (hot / emissive). */
export const G = { GLOW: 0, SPARK: 1, TRACER: 2, FLASH: 3, FLAME: 4, GLINT: 5 } as const;
/** Smoke family shapes (lit, alpha). */
export const S = { DUST: 0, GRIT: 1, MIST: 2, TRAIL: 3, DROP: 4 } as const;
/** Decal family shapes (modulate 2x, lying on a surface). */
export const D = { METAL: 0, STONE: 1, WOOD: 2, DIRT: 3, GLASS: 4, BLOOD: 5 } as const;

/** Shared uniforms (one object for all families; refreshed per render with the camera actually drawing). */
export interface FxUniforms {
  uTime: { value: number };
  /** World metres per pixel at 1 m (2 tan(fov/2) / drawing-buffer height). */
  uPx: { value: number };
  /** Smoothed frame time — tracer motion-streak length. */
  uDt: { value: number };
  uSunV: { value: THREE.Vector3 };
  uSunW: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Color };
  uAmb: { value: THREE.Color };
  uFogCol: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  /** Camera right/up in world (for TSL billboards; GLSL reads viewMatrix). */
  uCamR: { value: THREE.Vector3 };
  uCamU: { value: THREE.Vector3 };
}

export function makeUniforms(): FxUniforms {
  return {
    uTime: { value: 0 },
    uPx: { value: 0.0015 },
    uDt: { value: 1 / 60 },
    uSunV: { value: new THREE.Vector3(0, 1, 0) },
    uSunW: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
    uSunCol: { value: new THREE.Color(0.9, 0.85, 0.75) },
    uAmb: { value: new THREE.Color(0.45, 0.47, 0.5) },
    uFogCol: { value: new THREE.Color(0.7, 0.72, 0.7) },
    uFogNear: { value: 1e6 },
    uFogFar: { value: 2e6 },
    uCamR: { value: new THREE.Vector3(1, 0, 0) },
    uCamU: { value: new THREE.Vector3(0, 1, 0) },
  };
}

const VERT = /* glsl */ `
attribute vec4 iP; // pos, birth
attribute vec4 iV; // velocity | axis | segment | normal, life
attribute vec4 iS; // size0, size1, drag, gravity
attribute vec4 iC; // rgb (linear, HDR ok), alpha
attribute vec4 iM; // shape, mode, rot0, spin
attribute vec4 iX; // mode extras, ease
uniform float uTime;
uniform float uPx;
uniform float uDt;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying vec2 vN;
varying vec4 vC;
varying vec3 vA;
varying vec4 vX;
varying float vW;
varying float vFog;
float hash11(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
// smoothstep with REVERSED edges is undefined in GLSL (Metal returns garbage): ss() is defined for both orders
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec3 sideOf(vec3 ax, vec3 toC, vec3 fallback) { vec3 c = cross(ax, toC); float l = length(c); return l > 1e-6 ? c / l : fallback; }
void main() {
  float age = uTime - iP.w;
  float life = iV.w;
  if (age < 0.0 || age >= life) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float k = age / life;
  int mode = int(iM.y + 0.5);
  float kk = iX.w > 0.0 ? 1.0 - pow(1.0 - k, iX.w) : k;
  float size = mix(iS.x, iS.y, kk);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec2 c = position.xy;
  vec3 wp;
  vW = 1.0;
  // BILL / STRETCH carry the emitter's SHADE in iX.z (0 = in sun, 1 = in shadow):
  // a particle cannot sample the shadow map, so the CPU traced one ray to the sun
  vX = vec4(0.0, 0.0, iX.z, 0.0);
  if (mode <= 1) {
    float drag = iS.z;
    float e = exp(-drag * age);
    float f = drag > 1e-4 ? (1.0 - e) / drag : age;
    vec3 p = iP.xyz + iV.xyz * f;
    p.y -= 0.5 * iS.w * age * age;
    if (mode == 0) {
      float a = iM.z + iM.w * age;
      float ca = cos(a), sa = sin(a);
      vec2 r = vec2(c.x * ca - c.y * sa, c.x * sa + c.y * ca);
      wp = p + (camR * r.x + camU * r.y) * size * 0.5;
      vUv = c; vN = r;
    } else {
      vec3 vel = iV.xyz * e;
      vel.y -= iS.w * age;
      float sp = length(vel);
      vec3 ax = sp > 1e-4 ? vel / sp : camU;
      vec3 toC = cameraPosition - p;
      vec3 sd = sideOf(ax, toC, camR);
      float w = size;
      float wmin = length(toC) * uPx * 1.3;
      if (w < wmin) { vW = w / wmin; w = wmin; }
      float len = w + sp * iX.x;
      wp = p + ax * (c.x * 0.5 - 0.5) * len + sd * c.y * w * 0.5;
      vUv = vec2(c.x * 0.5 + 0.5, c.y); vN = c;
      vX.x = len / w;
    }
  } else if (mode == 2) {
    // anchored at its base, extending size along the axis (flame tongues)
    vec3 ax = normalize(iV.xyz);
    vec3 toC = cameraPosition - iP.xyz;
    vec3 sd = sideOf(ax, toC, camR);
    float w = size * iX.y;
    wp = iP.xyz + ax * (c.x * 0.5 + 0.5) * size + sd * c.y * w * 0.5;
    vUv = vec2(c.x * 0.5 + 0.5, c.y); vN = c;
  } else if (mode <= 4) {
    // SEG: the whole segment iP -> iP + iV. TRACER: a streak whose head runs
    // down that segment at iX.x m/s, iX.y metres long at rest and stretched to
    // the distance covered in one frame (a motion streak), tail catching up
    // into the impact after arrival.
    vec3 dir = iV.xyz;
    float dist = length(dir);
    dir /= max(dist, 1e-5);
    float h = dist, t = 0.0;
    if (mode == 4) {
      float L = clamp(iX.x * uDt * 1.1, iX.y, iX.y * 3.5);
      float run = age * iX.x;
      h = min(run, dist);
      t = clamp(run - L, 0.0, dist);
    }
    vec3 mid = iP.xyz + dir * mix(t, h, c.x * 0.5 + 0.5);
    vec3 toC = cameraPosition - mid;
    vec3 sd = sideOf(dir, toC, camR);
    float w = size;
    float dc = length(toC);
    float wmin = dc * uPx * 2.0;
    if (w < wmin) { vW = w / wmin; w = wmin; }
    wp = mid + sd * c.y * w * 0.5;
    vUv = vec2(c.x * 0.5 + 0.5, c.y); vN = c;
    vX = vec4(h - t, w, iX.z, dc);
  } else {
    // PLANE: lying on a surface, normal in iV, pushed off it by iX.z plus a
    // distance-scaled margin so a far wall's 24-bit depth cannot swallow it
    vec3 n = normalize(iV.xyz);
    vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(n, t1);
    float a = iM.z + iM.w * age;
    float ca = cos(a), sa = sin(a);
    vec2 r = vec2(c.x * ca - c.y * sa, c.x * sa + c.y * ca);
    float dc = length(cameraPosition - iP.xyz);
    wp = iP.xyz + n * (iX.z + dc * 0.00045) + (t1 * r.x + t2 * r.y) * size * 0.5;
    // DEPTH PULL along the view ray (iX.x m + 2 mm per metre): the decal keeps
    // its exact screen footprint but wins the depth test over a visual surface
    // that sits a few cm proud of the collider face it was placed on (measured:
    // container skins up to ~7 cm in front of their OBB).
    vec3 tv = wp - cameraPosition;
    float tl = length(tv);
    wp = cameraPosition + tv * max(0.05, 1.0 - (iX.x + dc * 0.002) / max(tl, 1e-3));
    vUv = c; vN = r;
    vX = vec4(n, 0.0);
  }
  // BILL / STRETCH: optional DEPTH PULL (iX.y m) along the view ray — same
  // screen footprint, but drawn over the surface it was born on (a blood puff
  // born on a hit capsule inside a bulkier drawn body; dust off a wall skin).
  if (mode <= 1 && iX.y > 0.0) {
    vec3 tv = wp - cameraPosition;
    float tl = length(tv);
    wp = cameraPosition + tv * max(0.1, 1.0 - iX.y / max(tl, 1e-3));
  }
  vC = iC;
  vA = vec3(k, hash11(iP.w * 7.31 + float(gl_InstanceID) * 1.618), iM.x);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vFog = ss(uFogNear, uFogFar, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunV;
uniform vec3 uSunW;
uniform vec3 uSunCol;
uniform vec3 uAmb;
uniform vec3 uFogCol;
varying vec2 vUv;
varying vec2 vN;
varying vec4 vC;
varying vec3 vA;
varying vec4 vX;
varying float vW;
varying float vFog;
float h11(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.6 + vnoise(p * 2.13 + 3.7) * 0.28 + vnoise(p * 4.31 + 9.1) * 0.12; }
float ringNoise(vec2 q, float freq, float seed) { vec2 d = q / max(length(q), 1e-4); return vnoise(d * freq + seed); }
float capsule(vec2 uv, float aspect) {
  vec2 p = vec2(uv.x * aspect, uv.y * 0.5);
  float x = clamp(p.x, 0.5, max(aspect - 0.5, 0.5));
  return length(p - vec2(x, 0.0)) - 0.5;
}
`;

const OUT = /* glsl */ `
  gl_FragColor = o;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const GLOW_FRAG = COMMON + /* glsl */ `
void main() {
  float k = vA.x, seed = vA.y;
  int shape = int(vA.z + 0.5);
  vec4 o = vec4(0.0);
  if (shape == 0) {
    // soft hot glow (impact flash, muzzle bloom) — fades fast
    float g = max(exp(-dot(vUv, vUv) * 4.5) - 0.011, 0.0);
    float f = 1.0 - k; f *= f;
    o = vec4(vC.rgb * g * f * vC.a, 0.0);
  } else if (shape == 1) {
    // velocity-stretched spark: a white-hot head cooling to orange along a short tail,
    // and the whole spark cooling as it ages
    float dd = capsule(vUv, vX.x);
    float cov = ss(0.05, -0.3, dd);
    float along = 0.2 + 0.8 * vUv.x;
    float heat = (1.0 - k);
    // CoD steel sparks: yellow-orange heads, red-orange tails, never blue-white
    vec3 col = mix(vec3(2.4, 0.55, 0.07), vec3(5.2, 3.1, 1.05), heat * heat * along);
    float f = 1.0 - ss(0.6, 1.0, k);
    o = vec4(col * vC.rgb * cov * along * f * vW * vC.a, 0.0);
  } else if (shape == 2) {
    // TRACER: a thin white-hot core inside a soft orange glow, brightest at
    // the round, fading down the streak; capped softly at the head.
    // GUARDS: max(x,0) keeps pow(x,1.7) off negative x (edge extrapolation /
    // centroid rounding — pow(neg, non-int) is undefined per GLSL and compiles
    // to exp2(1.7*log2(neg)) = NaN on D3D11); max(coreF/W, 1e-3) keeps the
    // Gaussian denominators strictly non-zero even if a record ever carries 0.
    // A single NaN pixel here is smeared by Bloom into a ~50px black box along
    // the bullet path (and held ~1s by Motion Blur).
    float L = max(vX.x, 1e-3), W = max(vX.y, 1e-3), coreF = max(vX.z, 1e-3);
    float x = clamp(vUv.x, 0.0, 1.0), y = vUv.y;
    float hd = (1.0 - x) * L;                      // metres behind the round
    float along = pow(max(x, 0.0), 1.7) * ss(0.0, min(0.05, L * 0.3), hd + 0.004);
    float core = exp(-(y * y) / (coreF * coreF) * 1.6);
    float glow = exp(-y * y * 4.0) * 0.55 + exp(-y * y * 14.0) * 0.45;
    // a hotter bead right at the round
    float bead = exp(-hd * hd / (W * W * 1.5)) * exp(-y * y * 6.0);
    vec3 col = vec3(7.0, 5.6, 3.6) * core + vec3(2.1, 0.78, 0.16) * glow + vec3(4.0, 3.0, 1.6) * bead;
    float near = ss(0.12, 0.6, vX.w);
    o = vec4(col * vC.rgb * along * vW * vC.a * near * (1.0 - vFog * 0.85), 0.0);
  } else if (shape == 3) {
    // muzzle / impact flash core: a ragged hot disc with a few faint prongs
    // (no cartoon star) — white heart, yellow body, orange edge.
    // NOTE: +1e-5 keeps atan() off its (0,0) singularity at the quad centre
    // (undefined per GLSL spec — NaN on strict drivers; a single NaN pixel is
    // invisible raw but bloom smears it into a black box on ULTRA/CINEMATIC).
    float r = length(vUv);
    float th = atan(vUv.y, vUv.x + 1e-5);
    float n = vnoise(vec2(th * 2.2 + seed * 13.0, seed * 7.0 + k * 3.0));
    float prong = pow(abs(cos(th * 2.0 + seed * 6.283)), 10.0) * 0.32 + pow(abs(cos(th * 3.0 + seed * 3.1)), 14.0) * 0.18;
    float rad = 0.42 + 0.22 * n + prong;
    float e = r / rad;
    float a = exp(-e * e * 2.8);
    vec3 col = mix(vec3(1.7, 0.6, 0.1), vec3(4.6, 3.6, 2.0), exp(-e * e * 6.0));
    col = mix(col, vec3(8.0, 7.4, 6.2), exp(-e * e * 22.0));
    float f = 1.0 - ss(0.35, 1.0, k);
    o = vec4(col * vC.rgb * a * f * vC.a, a * f * 0.12 * vC.a);
  } else if (shape == 4) {
    // flame tongue anchored at its base (3P muzzle flash body / prongs).
    // GUARD: clamp x to [0,1] — pow(neg, 0.35/0.9) is undefined per GLSL and
    // compiles to exp2(e*log2(neg)) = NaN on D3D11 (one NaN pixel at the
    // base/tip edge is smeared by Bloom into a ~50px black box at the muzzle).
    float x = clamp(vUv.x, 0.0, 1.0), y = vUv.y;
    float n = vnoise(vec2(x * 5.0 + seed * 20.0, y * 1.7 + seed * 7.0));
    float hw = pow(max(x, 0.0), 0.35) * pow(max(1.0 - x, 0.0), 0.9) * 1.9 * (0.72 + 0.5 * n);
    float cov = ss(hw, hw * 0.35, abs(y)) * ss(0.0, 0.06, x);
    float T = (1.0 - x * 0.95) * (1.0 - 0.6 * abs(y) / max(hw, 1e-3));
    vec3 col = mix(vec3(1.3, 0.3, 0.04), vec3(3.4, 2.0, 0.55), ss(0.1, 0.45, T));
    col = mix(col, vec3(7.0, 6.2, 4.6), ss(0.6, 0.92, T));
    float f = 1.0 - ss(0.45, 1.0, k);
    o = vec4(col * vC.rgb * cov * f * vC.a, cov * f * 0.2 * vC.a);
  } else {
    // 4-point glint: the ping off bare steel
    vec2 p = abs(vUv);
    float g = exp(-p.x * 18.0) * exp(-p.y * 2.4) + exp(-p.y * 18.0) * exp(-p.x * 2.4) + exp(-dot(p, p) * 22.0) * 1.5;
    float f = sin(3.14159 * sqrt(max(k, 0.0)));
    o = vec4(vC.rgb * g * f * vC.a, 0.0);
  }
  o.rgb *= 1.0 - vFog * 0.7;
  // Last NaN/Inf guard inside the glow shader itself (before One/OneMinusSrcAlpha
  // blending contaminates the RT — NaN in the framebuffer eats even the already
  // drawn background!). WITHOUT isnan() (D3D11 X3577 optimises it away).
  if (!(o.r >= 0.0 && o.r <= 60000.0)) o.r = 0.0;
  if (!(o.g >= 0.0 && o.g <= 60000.0)) o.g = 0.0;
  if (!(o.b >= 0.0 && o.b <= 60000.0)) o.b = 0.0;
  if (!(o.a >= 0.0 && o.a <= 1.0)) o.a = 0.0;
  if (o.a <= 0.0 && dot(o.rgb, vec3(1.0)) <= 0.0004) discard;
  ${OUT}
}`;

const SMOKE_FRAG = COMMON + /* glsl */ `
void main() {
  float k = vA.x, seed = vA.y;
  float sunK = 1.0 - clamp(vX.z, 0.0, 1.0);
  int shape = int(vA.z + 0.5);
  vec4 o = vec4(0.0);
  if (shape == 0 || shape == 2) {
    // DUST (0): a soft, lit, noise-eroded puff. MIST (2): the same body, darker,
    // denser in the middle and barely sunlit (blood mist).
    vec2 q = vUv;
    float r = length(q);
    if (r > 1.0) discard;
    vec2 sp = q * 1.35 + seed * 23.0 + vec2(0.0, k * 0.6);
    float n = fbm(sp * 1.6);
    float edge = 0.74 + 0.22 * ringNoise(q, 2.6, seed * 11.0);
    float F = r / edge;
    float er = ss(0.15, 1.0, k);
    float body = ss(1.0, 0.32, F + er * (0.25 + 0.9 * (1.0 - n)));
    float cov = body * (0.55 + 0.45 * n);
    if (cov <= 0.002) discard;
    vec3 nrm = normalize(vec3(vN * 0.9 + (n - 0.5) * 0.6, sqrt(max(1.0 - dot(vN, vN) * 0.8, 0.05))));
    float dif = clamp(dot(nrm, uSunV) * 0.55 + 0.45, 0.0, 1.0);
    vec3 lit = shape == 0
      ? vC.rgb * (uAmb * (0.85 + 0.25 * nrm.y) + uSunCol * dif * sunK)
      : vC.rgb * (uAmb * 0.9 + uSunCol * dif * 0.6 * sunK);
    float a = cov * vC.a * ss(0.0, 0.04, k);
    lit = mix(lit, uFogCol, vFog);
    o = vec4(lit * a, a);
  } else if (shape == 1 || shape == 4) {
    // GRIT (1): a lit grain of dirt / stone / wood. DROP (4): a blood droplet.
    float dd = capsule(vUv, vX.x);
    float cov = ss(0.0, -0.25, dd);
    vec3 lit = shape == 1
      ? vC.rgb * (uAmb + uSunCol * 0.8 * sunK)
      : vC.rgb * (uAmb * 0.8 + uSunCol * 0.3 * sunK) + vec3(0.06, 0.03, 0.03) * ss(0.2, 0.7, vUv.y);
    float a = cov * vC.a * (1.0 - ss(0.7, 1.0, k)) * vW;
    lit = mix(lit, uFogCol, vFog);
    o = vec4(lit * a, a);
  } else {
    // TRAIL: the sniper round's vapour trail — a thin wispy line that
    // diffuses wider and fainter (SEG mode: the quad spans the whole path)
    float y = vUv.y;
    float n = fbm(vec2(vUv.x * vX.x * 0.9 + seed * 17.0, y * 0.8 + k * 1.5 + seed * 3.0));
    float body = exp(-y * y * 3.2) * (0.45 + 0.75 * n);
    float ends = ss(0.0, 0.03, vUv.x) * ss(1.0, 0.985, vUv.x);
    float a = body * ends * vC.a * pow(max(1.0 - k, 0.0), 1.6) * vW;
    vec3 lit = vC.rgb * (uAmb + uSunCol * 0.6 * sunK);
    lit = mix(lit, uFogCol, vFog);
    o = vec4(lit * a, a);
  }
  if (!(o.r >= 0.0 && o.r <= 60000.0)) o.r = 0.0;
  if (!(o.g >= 0.0 && o.g <= 60000.0)) o.g = 0.0;
  if (!(o.b >= 0.0 && o.b <= 60000.0)) o.b = 0.0;
  if (!(o.a >= 0.0 && o.a <= 1.0)) o.a = 0.0;
  if (o.a <= 0.002) discard;
  ${OUT}
}`;

const DECAL_FRAG = COMMON + /* glsl */ `
// MODULATE 2x: out 0.5 = untouched surface, < 0.5 darkens, > 0.5 lifts.
void main() {
  float k = vA.x, seed = vA.y;
  int shape = int(vA.z + 0.5);
  vec2 q = vUv;
  float r = length(q);
  if (r > 1.0) discard;
  // NOTE: +1e-5 keeps atan() off its (0,0) singularity at the disc centre
  // (undefined per GLSL spec — NaN on strict drivers; one NaN pixel is
  // invisible raw but bloom smears it into a black box on ULTRA/CINEMATIC).
  // Cracks/rays/lines are all masked to r > 0.1+, so the shift is invisible.
  float th = atan(q.y, q.x + 1e-5);
  float wob = ringNoise(q, 3.0, seed * 17.0);
  float fine = vnoise(q * 11.0 + seed * 31.0);
  float F = 1.0;      // multiplier on the surface
  float a = 0.0;      // coverage
  if (shape == 0) {
    // METAL: a punched bore, a dark dented lip, a ring of scuffed bare steel
    // where the paint flaked, and faint powder soot
    float hole = ss(0.21, 0.15, r - 0.03 * wob);
    float lip = ss(0.34, 0.24, r - 0.04 * wob);
    float bare = ss(0.5, 0.3, r + (wob - 0.5) * 0.22 + (fine - 0.5) * 0.12) * (1.0 - lip);
    float soot = ss(0.95, 0.35, r + (wob - 0.5) * 0.3) * 0.55;
    F = mix(1.0, 0.72, soot);
    F = mix(F, 1.7, bare * 0.85);
    F = mix(F, 0.42, lip);
    F = mix(F, 0.04, hole);
    a = max(max(soot, bare), lip);
  } else if (shape == 1) {
    // STONE / CONCRETE: an irregular chipped crater, a dark pit, a ring of pale
    // powdered stone and a few hairline cracks
    float crater = ss(0.42, 0.32, r - 0.14 * (wob - 0.4) - 0.05 * (fine - 0.5));
    float pit = ss(0.2, 0.13, r - 0.04 * wob);
    float powder = ss(0.92, 0.38, r + (wob - 0.5) * 0.4 + (fine - 0.5) * 0.18);
    float N = 5.0;
    float sec = 6.2831853 / N;
    float i = floor(th / sec + 0.5);
    float jit = (h11(i + seed * 50.0) - 0.5) * 0.7;
    float d = abs(th - (i + jit) * sec);
    float crackLen = 0.45 + 0.45 * h11(i * 3.1 + seed * 13.0);
    float crack = ss(0.035, 0.0, d * r) * step(0.2, r) * ss(crackLen, crackLen * 0.7, r);
    F = mix(1.0, 1.32, powder * 0.8);
    F = mix(F, 0.55, crack * 0.7);
    F = mix(F, 0.5 + 0.12 * fine, crater);
    F = mix(F, 0.06, pit);
    a = max(max(powder * 0.8, crater), max(pit, crack));
  } else if (shape == 2) {
    // WOOD: a dark bore with torn pale fibres sprayed round it
    float N = 8.0;
    float sec = 6.2831853 / N;
    float i = floor(th / sec + 0.5);
    float jit = (h11(i + seed * 50.0) - 0.5) * 0.5;
    float d = abs(th - (i + jit) * sec) / (sec * 0.5);
    float len = 0.35 + 0.5 * h11(i * 3.1 + seed * 13.0);
    float ray = ss(0.02, -0.02, r - (0.16 + (len - 0.16) * pow(max(1.0 - d, 0.0), 3.0)));
    float hole = ss(0.17, 0.12, r - 0.04 * wob);
    float soot = ss(0.7, 0.2, r) * 0.35;
    F = mix(1.0, 0.75, soot);
    F = mix(F, 1.45, ray * 0.9);
    F = mix(F, 0.05, hole);
    a = max(max(soot, ray), hole);
  } else if (shape == 3) {
    // DIRT / SAND: a soft dark divot with scattered darker crumbs
    float div = ss(0.75, 0.05, r + (wob - 0.5) * 0.35);
    float crumbs = step(0.72, vnoise(q * 9.0 + seed * 19.0)) * ss(1.0, 0.45, r);
    F = mix(1.0, 0.55, div);
    F = mix(F, 0.62, crumbs * 0.8);
    a = max(div, crumbs * 0.8);
  } else if (shape == 4) {
    // GLASS: a frosted star of hairline cracks round a small dark hole
    float N = 9.0;
    float sec = 6.2831853 / N;
    float i = floor(th / sec + 0.5);
    float jit = (h11(i + seed * 50.0) - 0.5) * 0.5;
    float d = abs(th - (i + jit) * sec);
    float len = 0.5 + 0.45 * h11(i * 3.1 + seed * 13.0);
    float line = ss(0.03, 0.0, d * r) * step(r, len);
    float ring = ss(0.02, 0.0, abs(r - 0.34 - 0.06 * wob)) * step(0.45, vnoise(vec2(th * 3.0, seed * 7.0)));
    float frost = ss(0.3, 0.1, r) * 0.6;
    float hole = ss(0.1, 0.06, r);
    F = mix(1.0, 1.8, max(max(line, ring), frost));
    F = mix(F, 0.15, hole);
    a = max(max(line, ring), max(frost, hole));
  }
  // every hole is grey (one multiplier on the surface); blood is the one TINTED
  // decal: vC.rgb is its per-channel multiplier, so it reads red on any wall
  vec3 T = vec3(F);
  if (shape == 5) {
    // BLOOD: a ragged splat with a darker wet core and a scatter of droplets
    float blob = ss(0.6, 0.44, r + (wob - 0.5) * 0.55 + (fine - 0.5) * 0.16);
    float core = ss(0.34, 0.16, r + (wob - 0.5) * 0.3);
    vec2 gq = q * 6.0 + seed * 23.0;
    vec2 cell = floor(gq);
    float hr = h11(cell.x * 7.0 + cell.y * 13.0 + seed * 41.0);
    float drop = step(0.72, hr) * ss(0.24, 0.12, length(fract(gq) - 0.5)) * ss(1.0, 0.5, r);
    a = max(max(blob, drop), core);
    T = mix(vC.rgb, vC.rgb * 0.5, core);
  }
  float fade = (1.0 - ss(0.82, 1.0, k)) * vC.a * ss(0.0, 0.002, k);
  vec3 m = mix(vec3(1.0), T, a * fade);
  m = mix(m, vec3(1.0), vFog);
  // MODULATE 2x (dst*src + src*dst = 2*src*dst): a single NaN here
  // contaminates the whole covered RT pixel to NaN -> bloom turns it into
  // a ~50px black box (and motion blur holds it ~1s).
  if (!(m.r >= 0.0 && m.r <= 4.0)) m.r = 1.0;
  if (!(m.g >= 0.0 && m.g <= 4.0)) m.g = 1.0;
  if (!(m.b >= 0.0 && m.b <= 4.0)) m.b = 1.0;
  vec3 dm = abs(m - 1.0);
  if (max(dm.r, max(dm.g, dm.b)) < 0.004) discard;
  gl_FragColor = vec4(m * 0.5, 1.0);
}`;

const STRIDE = 24;
export const PARAMS = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, s0: 0.1, s1: 0.1, drag: 0, grav: 0,
  r: 1, g: 1, b: 1, a: 1, shape: 0, mode: 0, rot: 0, spin: 0, e0: 0, e1: 0, e2: 0, ease: 0,
  /** Seconds before the particle is born (an impact waiting for its round to land). */
  delay: 0,
};
export type Params = typeof PARAMS;

export type FamilyKind = "glow" | "smoke" | "decal";

/** A pooled ring buffer of GPU-simulated quads = one draw call. */
export class QuadFamily {
  readonly mesh: THREE.Mesh;
  /** The spawn record: set fields, then emit(); emit() resets it to defaults. */
  readonly p: Params = { ...PARAMS };
  private readonly data: Float32Array;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly geo: THREE.InstancedBufferGeometry;
  private cursor = 0;
  private pendStart = 0;
  private pend = 0;
  /** Latest (delay + life) among the pending records. */
  private pendSpan = 0;
  private high = 0;
  /** Latest death time (clock seconds): the mesh hides itself when nothing is alive. */
  maxEnd = -1;

  constructor(
    name: string,
    readonly cap: number,
    kind: FamilyKind,
    renderOrder: number,
    readonly u: FxUniforms,
    onRender: (cam: THREE.Camera, r: AnyRenderer) => void,
    tsl: { tslQuadFamily(k: string, u: FxUniforms): { material: THREE.Material } } | null = null,
  ) {
    this.data = new Float32Array(cap * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    ["iP", "iV", "iS", "iC", "iM", "iX"].forEach((n, i) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4)));
    g.instanceCount = 0;
    this.geo = g;
    const frag = kind === "glow" ? GLOW_FRAG : kind === "smoke" ? SMOKE_FRAG : DECAL_FRAG;
    // WebGPU: TSL NodeMaterial instead of GLSL (three has no ShaderMaterial mapping
    // → "not compatible" error + empty fallback). WebGL: unchanged GLSL.
    const mat: THREE.Material = tsl
      ? tsl.tslQuadFamily(kind, u).material
      : new THREE.ShaderMaterial({
      name: `wfx-${name}`,
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms: u as unknown as Record<string, THREE.IUniform>,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Axis-aligned modes (STRETCH / AXIS / SEG / TRACER) build their side
      // vector from cross(axis, toCamera): its sign — and so the quad's winding —
      // flips with the direction of travel. Front-face culling silently ate
      // every other spark, flame and tracer.
      side: THREE.DoubleSide,
      toneMapped: kind !== "decal",
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      ...(kind === "decal"
        ? {
            // ZERO-FLICKER rule for decals: >= 3 mm proud (the shader lifts 4 mm
            // + 0.45 mm/m along the normal, then pulls along the view ray) AND a
            // polygonOffset toward the camera; the renderer keeps its sign right
            // in reversed, split and standard depth (docs/nuketown/ZERO-FLICKER.md).
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -2,
            // dst * src + src * dst = 2 * src * dst
            blendSrc: THREE.DstColorFactor,
            blendDst: THREE.SrcColorFactor,
            blendSrcAlpha: THREE.ZeroFactor,
            blendDstAlpha: THREE.OneFactor,
          }
        : {
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
          }),
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = `wfx-${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (r, _s, cam) => onRender(cam, r);
  }

  /**
   * Show the (empty) family so the boot-time compileAsync + warm render build
   * its program: otherwise the first shot of the match pays the shader compile.
   * Record 0 is all zeros (life 0) and the vertex shader culls it; the first
   * flush() hides the mesh again until something is alive.
   */
  warm(): void {
    if (this.high === 0) this.geo.instanceCount = 1;
    this.mesh.visible = true;
  }

  /**
   * QA only: every live PLANE record (bullet holes) as a world-space triangle
   * fan, built with EXACTLY the vertex shader's math for a camera at `cam`
   * (normal lift, then the view-ray depth pull), so the flicker detector's ID
   * pass sees the decal where the frame draws it. `seg`-gon inscribed in the
   * quad's disc (the fragment shader discards r > 1).
   */
  qaPlanes(now: number, cam: THREE.Vector3, seg = 12, liftK = 1, pullK = 1): Float32Array {
    const d = this.data;
    const out: number[] = [];
    const n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), c = new THREE.Vector3(), w = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3(1, 0, 0);
    const tv = new THREE.Vector3();
    const corner = (P: THREE.Vector3, rx: number, ry: number, size: number, lift: number, pull: number, o: THREE.Vector3): THREE.Vector3 => {
      o.copy(P).addScaledVector(n, lift).addScaledVector(t1, rx * size * 0.5).addScaledVector(t2, ry * size * 0.5);
      tv.subVectors(o, cam);
      const tl = Math.max(tv.length(), 1e-3);
      return o.copy(cam).addScaledVector(tv, Math.max(0.05, 1 - pull / tl));
    };
    const P = new THREE.Vector3();
    for (let i = 0; i < this.high; i++) {
      const o = i * STRIDE;
      if (Math.round(d[o + 17]!) !== M.PLANE) continue;
      const age = now - d[o + 3]!;
      const life = d[o + 7]!;
      if (age < 0 || age >= life) continue;
      P.set(d[o]!, d[o + 1]!, d[o + 2]!);
      n.set(d[o + 4]!, d[o + 5]!, d[o + 6]!).normalize();
      t1.crossVectors(n, Math.abs(n.y) < 0.99 ? up : right).normalize();
      t2.crossVectors(n, t1);
      const k = age / life;
      const ease = d[o + 23]!;
      const kk = ease > 0 ? 1 - Math.pow(1 - k, ease) : k;
      const size = d[o + 8]! + (d[o + 9]! - d[o + 8]!) * kk;
      const dc = P.distanceTo(cam);
      const lift = (d[o + 22]! + dc * 0.00045) * liftK;
      const pull = (d[o + 20]! + dc * 0.002) * pullK;
      const a = d[o + 18]! + d[o + 19]! * age;
      corner(P, 0, 0, size, lift, pull, c);
      for (let s = 0; s < seg; s++) {
        for (const j of [s, s + 1]) {
          const th = a + (j / seg) * Math.PI * 2;
          corner(P, Math.cos(th) * 0.95, Math.sin(th) * 0.95, size, lift, pull, w);
          out.push(w.x, w.y, w.z);
        }
        out.push(c.x, c.y, c.z);
      }
    }
    return new Float32Array(out);
  }

  /** Drop every record (QA: start a capture from a clean slate). */
  clear(): void {
    this.data.fill(0);
    this.cursor = this.pend = this.pendSpan = this.high = 0;
    this.maxEnd = -1;
    this.geo.instanceCount = 0;
    this.buf.clearUpdateRanges();
    this.buf.needsUpdate = true;
    this.mesh.visible = false;
  }

  /** Live records (birth + life still ahead of the clock), for diagnostics. */
  alive(now: number): number {
    let n = 0;
    const d = this.data;
    for (let i = 0; i < this.high; i++) {
      const o = i * STRIDE;
      if (d[o + 3]! + d[o + 7]! > now) n++;
    }
    return n;
  }

  emit(): void {
    const p = this.p;
    const d = this.data;
    const o = this.cursor * STRIDE;
    // Relative birth; flush() adds the clock the frame renders with.
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = p.delay;
    d[o + 4] = p.vx; d[o + 5] = p.vy; d[o + 6] = p.vz; d[o + 7] = p.life;
    d[o + 8] = p.s0; d[o + 9] = p.s1; d[o + 10] = p.drag; d[o + 11] = p.grav;
    d[o + 12] = p.r; d[o + 13] = p.g; d[o + 14] = p.b; d[o + 15] = p.a;
    d[o + 16] = p.shape; d[o + 17] = p.mode; d[o + 18] = p.rot; d[o + 19] = p.spin;
    d[o + 20] = p.e0; d[o + 21] = p.e1; d[o + 22] = p.e2; d[o + 23] = p.ease;
    if (this.pend === 0) this.pendStart = this.cursor;
    this.pend++;
    if (this.cursor + 1 > this.high) this.high = this.cursor + 1;
    this.cursor = (this.cursor + 1) % this.cap;
    if (p.delay + p.life > this.pendSpan) this.pendSpan = p.delay + p.life;
    Object.assign(p, PARAMS);
  }

  /** Stamp this frame's spawns with the render clock, upload them, show/hide by liveness. */
  flush(now: number): void {
    if (this.pend > 0) {
      const d = this.data;
      const b = this.buf;
      b.clearUpdateRanges();
      const stamp = (from: number, n: number): void => {
        for (let i = from; i < from + n; i++) d[i * STRIDE + 3] += now;
        b.addUpdateRange(from * STRIDE, n * STRIDE);
      };
      if (this.pend >= this.cap) stamp(0, this.cap);
      else if (this.pendStart + this.pend <= this.cap) stamp(this.pendStart, this.pend);
      else {
        stamp(this.pendStart, this.cap - this.pendStart);
        stamp(0, this.pendStart + this.pend - this.cap);
      }
      b.needsUpdate = true;
      if (now + this.pendSpan > this.maxEnd) this.maxEnd = now + this.pendSpan;
      this.pend = 0;
      this.pendSpan = 0;
      this.geo.instanceCount = this.high;
    }
    this.mesh.visible = now < this.maxEnd;
  }

  /** Shift every stored birth time (clock rebase keeps shader float time small). */
  rebase(dt: number): void {
    // Pending records are still relative — leave them alone.
    const pendSet = (i: number): boolean => {
      if (this.pend === 0) return false;
      const rel = (i - this.pendStart + this.cap) % this.cap;
      return rel < this.pend;
    };
    for (let i = 0; i < this.cap; i++) if (!pendSet(i)) this.data[i * STRIDE + 3] -= dt;
    this.maxEnd -= dt;
    this.buf.clearUpdateRanges();
    this.buf.addUpdateRange(0, this.cap * STRIDE);
    this.buf.needsUpdate = true;
  }
}
