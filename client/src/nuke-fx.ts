/**
 * client/src/nuke-fx.ts — THE NUKE, the picture (feel stream; driven by nuketown-live.ts).
 * ===========================================================================
 *
 * A mushroom cloud on the far desert, beyond the mountain skyline, at a scale
 * that reads as kilometres (the backdrop compresses its ranges to 300-385 m;
 * ground zero sits 800 m out and the cap climbs to ~650 m — about 40° over
 * the horizon from the town). Built from camera-facing PUFFS in one instanced
 * draw: each a crisp-edged cauliflower billow (bumped silhouette, a lit sphere
 * normal broken up by noise) shaded by the sun, the sky and a warm ground
 * bounce, plus a black-body EMISSIVE term for the fire. The puffs are laid out
 * STRUCTURALLY, not at random, so the silhouette is a mushroom and not a heap:
 *
 *   fireball   0-2.6 s  a white-hot ball that swells on the ground and lifts
 *   cap        an oblate dome shell (golden-spiral puffs) whose puffs ROLL from
 *              the crown over the rim and under (a toroidal vortex), with a
 *              dark rolled lip that keeps the last of the fire glowing in it
 *   stem       a twisting column rising into the cap's underside
 *   skirt      the base surge spreading over the desert floor
 *   collar     the condensation ring (Wilson cloud): a thin white annulus
 *              round the stem, 1.6-7 s
 *   shockwave  a ground-hugging dust wall rolling across the desert toward the
 *              town — the near half of the ring, bright crest, darker body —
 *              gone before it reaches the playable footprint (the whiteout
 *              lands instead)
 *
 * plus the FLASH (an additive horizon flare) and the FIREBALL CORE (an additive
 * glow inside the rising ball, hotter and longer-lived than the flash).
 *
 * NEVER INTERSECTS THE MAP and NEVER POPS: nothing it draws comes within 120 m
 * of the playable footprint; depth-tested against the mountains, never depth-
 * written; drawn back-to-front in a STATIC structural order (each puff's slot
 * seen from the fixed camera), never re-sorted by live distance, so two
 * overlapping puffs can never swap. It is built lazily after a match has ended
 * (nuketown-live.ts), so no live frame — and no flicker-gate viewpoint — ever
 * contains it.
 */
import * as THREE from "three";

/** TSL module (WebGPU path) — loaded as a value only via dynamic import(); here just the type. */
type TslMod = typeof import("./tsl-materials");

const MAX = 960;

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iDat;   // size, seed, heat, alpha
  attribute float iShade; // occlusion: 0 = deep in the cloud's own shadow .. 1 = open; +2 = soft-edged dust
  attribute vec3 iNrm;    // the CLOUD's surface normal at this puff (world): lighting is continuous across puffs
  varying vec2 vUv;
  varying vec4 vDat;
  varying float vShade;
  varying vec3 vViewPos;
  varying vec3 vMN;
  void main() {
    vUv = position.xy + 0.5;
    vDat = iDat;
    vShade = iShade;
    vMN = normalize((viewMatrix * vec4(iNrm, 0.0)).xyz);
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    float a = iDat.y * 6.2831;
    float c = cos(a), s = sin(a);
    vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
    mv.xy += q * iDat.x;
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uSunV;      // sun direction in view space
  uniform vec3 uLit, uShade, uSky, uBounce, uHaze;
  uniform float uTime, uHazeK;
  varying vec2 vUv;
  varying vec4 vDat;
  varying float vShade;
  varying vec3 vViewPos;
  varying vec3 vMN;
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
  }
  // billows: rounded bumps, the cauliflower of a convective cloud (a smooth fold, no crease lines)
  float billow(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++){ float k = 2.0 * vnoise(p) - 1.0; v += a * (1.0 - k * k); p = p * 2.13 + 7.1; a *= 0.5; }
    return v;
  }
  vec3 blackbody(float h){
    vec3 c = mix(vec3(0.3, 0.04, 0.015), vec3(0.95, 0.22, 0.03) * 1.8, smoothstep(0.08, 0.4, h));
    c = mix(c, vec3(1.0, 0.5, 0.1) * 3.6, smoothstep(0.4, 0.7, h));
    return mix(c, vec3(1.0, 0.9, 0.66) * 8.0, smoothstep(0.76, 1.0, h));
  }
  void main(){
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float seed = vDat.y * 41.0;
    vec2 q = p * 1.6 + vec2(seed, seed * 0.61) + vec2(0.0, uTime * 0.02);
    float b = billow(q);
    float b2 = billow(p * 3.7 - vec2(seed * 1.7, seed) - uTime * 0.03);
    // a bumpy, CRISP silhouette: the rim of a cumulus, not a smoke smear
    // dust (the skirt, the shock wall) is soft-edged and flat; the cloud proper is crisp
    float soft = step(1.5, vShade);
    float shadeIn = vShade - 2.0 * soft;
    // density = a round falloff (exactly 0 at the quad's rim: no circle is ever cut) carved by the
    // billows; a narrow threshold makes the cloud's edge crisp and lumpy, a wide one makes dust
    float fall = 1.0 - smoothstep(0.35, 1.0, r);
    float dens = fall * (0.55 + 0.75 * b + 0.25 * b2);
    float a = smoothstep(mix(0.4, 0.02, soft), mix(0.56, 0.7, soft), dens) * vDat.w;
    if (a < 0.004) discard;
    // a lit sphere bumped by the billows
    vec2 gp = vec2(billow(q + vec2(0.07, 0.0)) - b, billow(q + vec2(0.0, 0.07)) - b) / 0.07;
    // the cloud's own surface normal, bumped a little by this puff's billows: neighbouring puffs
    // light alike, so their overlaps vanish and only the cloud's silhouette and lumps read
    vec3 nrm = normalize(vMN + vec3(p * 0.12 - gp * 0.2, 0.0));
    float sun = clamp(dot(nrm, uSunV) * 0.55 + 0.45, 0.0, 1.0);
    sun = mix(sun, 0.55 + 0.2 * b, soft * 0.7);
    float lit = clamp(sun * shadeIn * 1.05 - 0.05 + (b2 - 0.5) * 0.12, 0.0, 1.0);
    lit = lit * lit * (3.0 - 2.0 * lit);
    vec3 col = mix(uShade, uLit, lit);
    col += uSky * clamp(nrm.y * 0.5 + 0.5, 0.0, 1.0) * 0.16 * (0.3 + 0.7 * shadeIn);
    col += uBounce * clamp(-nrm.y, 0.0, 1.0) * 0.22 * (1.0 - shadeIn);
    col *= 0.94 + 0.12 * b2;
    // the fire: black-body emission, hottest in the puff's core
    float heat = vDat.z;
    float core = clamp(1.2 - r * 0.85 + (b - 0.5) * 0.5, 0.0, 1.0);
    col += blackbody(heat * (0.72 + 0.28 * core)) * pow(heat, 1.25) * core;
    // aerial perspective (the scene's height fog does not reach this far out)
    float d = length(vViewPos);
    col = mix(col, uHaze, clamp(uHazeK * (1.0 - exp(-d / 1100.0)), 0.0, 0.8));
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Additive glow billboard (flash flare, fireball core): radial falloff, a horizontal streak for the flash. */
const GLOW_VERT = /* glsl */ `uniform float uSize; varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * uSize; gl_Position = projectionMatrix * mv; }`;
const GLOW_FRAG = /* glsl */ `uniform float uK, uStreak; uniform vec3 uCol; varying vec2 vUv; void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p);
  float core = exp(-r * r * 22.0); float halo = exp(-r * 3.4) * 0.5; float streak = exp(-abs(p.y) * 40.0) * exp(-abs(p.x) * 1.5) * 0.55 * uStreak;
  gl_FragColor = vec4(uCol * (core * 12.0 + halo + streak) * uK, 0.0); }`;

/** The condensation ring: a flat annulus, soft and broken at both edges. */
const RING_VERT = /* glsl */ `varying vec2 vP; varying vec3 vView; void main(){ vP = position.xz; vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`;
const RING_FRAG = /* glsl */ `precision highp float; uniform float uK, uR0, uR1, uTime; uniform vec3 uCol, uHaze; varying vec2 vP; varying vec3 vView;
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
  void main(){ float r = length(vP); float ang = atan(vP.y, vP.x);
    float w = (r - uR0) / (uR1 - uR0);
    float n = vn(vec2(ang * 9.0, r * 0.02 + uTime * 0.05)) * 0.6 + vn(vec2(ang * 23.0, r * 0.05)) * 0.4;
    float band = smoothstep(0.0, 0.35 + 0.2 * n, w) * (1.0 - smoothstep(0.55 - 0.25 * n, 1.0, w));
    float a = band * (0.55 + 0.45 * n) * uK;
    if (a < 0.004) discard;
    vec3 col = mix(uCol, uHaze, 0.15);
    gl_FragColor = vec4(col * a, a); }`;

type Puff = { x: number; y: number; z: number; size: number; seed: number; heat: number; alpha: number; shade: number; key: number; nx: number; ny: number; nz: number };

/** A tiny deterministic hash, so the cloud is the same cloud on every client. */
function rnd(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export class NukeFx {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private aPos: THREE.InstancedBufferAttribute;
  private aDat: THREE.InstancedBufferAttribute;
  private aShade: THREE.InstancedBufferAttribute;
  private aNrm: THREE.InstancedBufferAttribute;
  private mat: THREE.Material;
  private flare: THREE.Object3D;
  private flareMat: THREE.Material;
  private core: THREE.Object3D;
  private coreMat: THREE.Material;
  private ring: THREE.Mesh;
  private ringMat: THREE.Material;
  /** TSL uniform bridge (WebGPU): uTime/uSunV/uCamR/uCamU are written per frame. */
  private tslU: Record<string, { value: number | THREE.Vector3 }> | null = null;
  private readonly isTsl: boolean;
  private puffs: Puff[] = [];
  private tmp = new THREE.Vector3();
  /** Ground zero (world, y = desert floor) and the unit vector from it toward the camera. */
  readonly gz = new THREE.Vector3();
  private toCam = new THREE.Vector3();
  private dist = 800;
  /** Seconds from detonation until the dust wall would reach the town. */
  shockAt = 4.4;
  /** Fewer puffs on a software rasteriser (fill is the whole bill there). */
  private density: number;

  constructor(gz: THREE.Vector3, cam: THREE.Vector3, sunDir: THREE.Vector3, haze: THREE.Color, low = false, tsl: TslMod | null = null) {
    this.isTsl = !!tsl;
    this.gz.copy(gz);
    this.toCam.set(cam.x - gz.x, 0, cam.z - gz.z);
    this.dist = this.toCam.length();
    this.toCam.normalize();
    this.density = low ? 0.45 : 1;
    this.sunDir = sunDir.clone().normalize();
    this.group.name = "nuke";
    this.group.userData.qaIgnore = true;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.aDat = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.aShade = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.aNrm = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    for (const a of [this.aPos, this.aDat, this.aShade, this.aNrm]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iPos", this.aPos);
    geo.setAttribute("iDat", this.aDat);
    geo.setAttribute("iShade", this.aShade);
    geo.setAttribute("iNrm", this.aNrm);
    geo.instanceCount = 0;
    // WebGPU: TSL puffs (no ShaderMaterial mapping in three). WebGL: GLSL.
    if (tsl) {
      const bridge = {
        uTime: { value: 0 },
        uSunV: { value: new THREE.Vector3() },
        uLit: { value: new THREE.Color(1.12, 0.98, 0.82) },
        uShade: { value: new THREE.Color(0.24, 0.19, 0.17) },
        uSky: { value: new THREE.Color(0.55, 0.7, 0.82) },
        uBounce: { value: new THREE.Color(0.62, 0.45, 0.3) },
        uHaze: { value: haze.clone() },
        uHazeK: { value: 0.24 },
        uCamR: { value: new THREE.Vector3(1, 0, 0) },
        uCamU: { value: new THREE.Vector3(0, 1, 0) },
      };
      const built = tsl.tslNukePuff(bridge);
      this.mat = built.material;
      this.tslU = built.U as unknown as Record<string, { value: number | THREE.Vector3 }>;
    } else {
      this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSunV: { value: new THREE.Vector3() },
        uLit: { value: new THREE.Color(1.12, 0.98, 0.82) },
        uShade: { value: new THREE.Color(0.24, 0.19, 0.17) },
        uSky: { value: new THREE.Color(0.55, 0.7, 0.82) },
        uBounce: { value: new THREE.Color(0.62, 0.45, 0.3) },
        uHaze: { value: haze.clone() },
        uTime: { value: 0 },
        uHazeK: { value: 0.24 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      fog: false,
      });
    }
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    // THE CONDENSATION RING: a flat annulus round the stem (drawn under the puffs).
    // WebGPU: MeshBasicMaterial, opacity is written per frame (uR0/uR1/uTime shape dropped interim).
    if (tsl) {
      this.ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.05, 1.03, 1.0),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    } else {
      this.ringMat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: { uK: { value: 0 }, uR0: { value: 100 }, uR1: { value: 300 }, uTime: { value: 0 }, uCol: { value: new THREE.Color(1.05, 1.03, 1.0) }, uHaze: { value: haze.clone() } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        fog: false,
      });
    }
    const rg = new THREE.RingGeometry(1, 2, 96, 1);
    rg.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(rg, this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 19;
    this.ring.visible = false;
    this.group.add(this.ring, this.mesh);
    // THE FLASH and THE FIREBALL CORE: additive billboards.
    // WebGPU: sprites (built-in billboard, radial texture) instead of custom GLSL.
    const glowTex = this.isTsl ? makeGlowTexture() : null;
    const glow = (size: number, col: THREE.Color, streak: number, order: number): [THREE.Object3D, THREE.Material] => {
      if (this.isTsl) {
        void streak;
        const m = new THREE.SpriteMaterial({
          map: glowTex,
          color: col,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Sprite(m);
        mesh.scale.set(size, size, 1);
        mesh.renderOrder = order;
        mesh.visible = false;
        return [mesh, m];
      }
      const m = new THREE.ShaderMaterial({
        uniforms: { uK: { value: 0 }, uSize: { value: size }, uCol: { value: col }, uStreak: { value: streak } },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      mesh.visible = false;
      return [mesh, m];
    };
    [this.flare, this.flareMat] = glow(2200, new THREE.Color(1, 0.96, 0.9), 1, 22);
    this.flare.position.set(gz.x, gz.y + 40, gz.z);
    [this.core, this.coreMat] = glow(600, new THREE.Color(1, 0.78, 0.45), 0, 21);
    this.group.add(this.flare, this.core);
  }

  private sunDir: THREE.Vector3;

  /** Lay the cloud out for time `t` (s since detonation) and upload it. */
  update(t: number, camera: THREE.Camera): void {
    const P = this.puffs;
    P.length = 0;
    const gz = this.gz;
    const tc = this.toCam;
    const D = this.density;
    const n = (k: number): number => Math.max(4, Math.round(k * D));
    // `key`: a STATIC structural depth (how far toward the camera this puff's slot sits, in
    // cloud units), never the live distance — so the order never re-sorts and nothing pops.
    const toward = (a: number): number => Math.cos(a) * tc.x + Math.sin(a) * tc.z;
    // nx/ny/nz: the cloud's surface normal at the puff (set by `nrm` before each group's adds)
    const N3 = { x: 0, y: 1, z: 0 };
    const nrm = (x: number, y: number, z: number): void => {
      const l = Math.hypot(x, y, z) || 1;
      N3.x = x / l;
      N3.y = y / l;
      N3.z = z / l;
    };
    const add = (x: number, y: number, z: number, size: number, seed: number, heat: number, alpha: number, shade: number, key: number): void => {
      if (alpha <= 0.004 || P.length >= MAX) return;
      P.push({ x: gz.x + x, y: gz.y + y, z: gz.z + z, size, seed, heat, alpha, shade, key, nx: N3.x, ny: N3.y, nz: N3.z });
    };
    const e = (k: number, tau: number): number => 1 - Math.exp(-Math.max(0, k) / tau);
    const cool = (age: number, tau: number): number => Math.exp(-Math.max(0, age) / tau);
    // ---- the shape over time
    const capY = 150 + 500 * e(t - 0.3, 3.4);
    const capR = 90 + 200 * e(t - 0.2, 4.0);
    const domeH = capR * 0.62;
    const ballR = 175 * e(t, 0.34);
    const heat0 = Math.min(1, cool(t, 1.9) * 1.1);
    const glow = Math.min(1, heat0 * 0.9 + 0.55 * cool(t - 2.0, 7));

    // ---- the fireball: a white-hot ball swelling on the ground, lifting into the cap
    if (t < 3.0) {
      const k = Math.max(0, 1 - t / 3.0);
      const cy = Math.max(ballR * 0.55, capY * Math.min(1, t / 2.2));
      const N = n(64);
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N;
        const th = i * GOLDEN;
        const ry = 1 - 2 * u;
        const rr = Math.sqrt(1 - ry * ry);
        const x = Math.cos(th) * rr * ballR * 0.62;
        const z = Math.sin(th) * rr * ballR * 0.62;
        nrm(x, ry * ballR * 0.5, z);
        add(x, cy + ry * ballR * 0.5, z, ballR * (0.55 + rnd(i, 4) * 0.25), rnd(i, 5), heat0 * (0.85 + 0.15 * rr), Math.min(1, k * 1.9), 1, toward(th) * rr * 0.6 - 0.05);
      }
    }
    // ---- the cap: an oblate dome shell whose puffs ROLL from the crown over the rim and under
    if (t > 0.5) {
      const fade = Math.min(1, (t - 0.5) / 0.9);
      const N = n(210);
      const roll = t * 0.045;
      for (let i = 0; i < N; i++) {
        // even coverage of the shell (golden spiral), each puff drifting crown → rim → under
        const az = i * GOLDEN;
        const v = ((i + 0.5) / N + roll) % 1; // 0 crown .. 1 tucked under the lip
        const lat = v * Math.PI * 0.62; // from the pole to ~112° (past the equator: the rolled rim)
        const s = Math.sin(lat);
        const c = Math.cos(lat);
        const rr = capR * (0.18 + 0.82 * s);
        const y = capY + c * domeH;
        // fade in at the crown, out as it tucks under
        const life = Math.min(1, v / 0.06) * Math.min(1, (1 - v) / 0.12);
        const under = Math.max(0, -c);
        const shade = 0.55 + 0.45 * Math.max(0, c);
        nrm(Math.cos(az) * s / capR, c / domeH, Math.sin(az) * s / capR);
        add(Math.cos(az) * rr, y, Math.sin(az) * rr, capR * (0.36 + rnd(i, 9) * 0.16), rnd(i, 10), glow * (0.1 + 0.9 * under * under), fade * life, shade, toward(az) * s * 1.2 + c * 0.05);
      }
      // the rolled lip: a dark, fire-lit torus under the rim
      const L = n(84);
      for (let i = 0; i < L; i++) {
        const az = (i / L) * Math.PI * 2 + rnd(i, 21) * 0.05;
        const ph = rnd(i, 22) * Math.PI;
        const rr = capR * (0.82 + 0.12 * Math.cos(ph));
        const y = capY - domeH * 0.18 - Math.sin(ph) * capR * 0.12;
        nrm(Math.cos(az) * 0.6, -0.8, Math.sin(az) * 0.6);
        add(Math.cos(az) * rr, y, Math.sin(az) * rr, capR * (0.3 + rnd(i, 23) * 0.12), rnd(i, 24), glow * (0.5 + 0.22 * Math.sin(az * 3 + 1.3) + 0.12 * Math.sin(az * 7 + 0.4)), fade, 0.45, toward(az) * 1.05 - 0.02);
      }
      // the core fill, so the dome never shows sky through it
      const F = n(26);
      for (let i = 0; i < F; i++) {
        const az = i * GOLDEN;
        const u = Math.sqrt((i + 0.5) / F);
        nrm(Math.cos(az) * u, 0.6, Math.sin(az) * u);
        add(Math.cos(az) * capR * 0.55 * u, capY + domeH * (0.1 + 0.4 * rnd(i, 26)), Math.sin(az) * capR * 0.55 * u, capR * 0.62, rnd(i, 27), glow * 0.4, fade, 0.6, toward(az) * u * 0.5 - 0.3);
      }
    }
    // ---- the stem: a twisting column rising into the cap's underside
    if (t > 0.7) {
      const fade = Math.min(1, (t - 0.7) / 1.0);
      const top = capY - domeH * 0.15;
      const N = n(150);
      const twist = t * 0.12;
      for (let i = 0; i < N; i++) {
        const f = (i + 0.5) / N;
        const y = f * top;
        const w = 34 + 60 * f * f * f + 22 * e(t, 4);
        const az = i * GOLDEN * 3 + twist * (0.5 + f);
        const rr = w * (0.35 + 0.25 * rnd(i, 17));
        // in the cap's shadow near the top, open lower down
        const shade = 0.75 - 0.4 * Math.max(0, f - 0.7) / 0.3;
        nrm(Math.cos(az), 0.15, Math.sin(az));
        const h = Math.min(1, heat0 * (1 - f) * 1.1 + 0.32 * cool(t - 1.5, 2.6) * (1 - f) * (1 - f));
        add(Math.cos(az) * rr, y, Math.sin(az) * rr, w * (1.15 + rnd(i, 18) * 0.35), rnd(i, 19), h, fade, Math.max(0.3, shade), toward(az) * 0.15 + 0.001 * i);
      }
    }
    // ---- the skirt: the base surge spreading over the desert floor
    if (t > 0.6) {
      const fade = Math.min(1, (t - 0.6) / 1.4);
      const R = 120 + 330 * e(t - 0.6, 3.2);
      const N = n(130);
      for (let i = 0; i < N; i++) {
        const az = (i / N) * Math.PI * 2 + rnd(i, 20) * 0.08;
        const rr = R * (0.55 + rnd(i, 21) * 0.5);
        nrm(Math.cos(az) * 0.5, 1, Math.sin(az) * 0.5);
        add(Math.cos(az) * rr, 18 + rnd(i, 22) * 34, Math.sin(az) * rr, 70 + rnd(i, 23) * 60, rnd(i, 24), 0, 0.85 * fade, 2.8 + 0.15 * rnd(i, 33), toward(az) * (rr / R) * 1.7);
      }
    }
    // ---- the shockwave: the near half of a dust wall rolling toward the town
    if (t > 0.25 && t < this.shockAt) {
      const R = ((t - 0.25) / (this.shockAt - 0.25)) * this.dist;
      // gone 120 m short of the camera, i.e. before the playable footprint
      const k = Math.min(1, (t - 0.25) / 0.5) * Math.min(1, Math.max(0, (this.dist - 120 - R) / 160));
      const base = Math.atan2(tc.z, tc.x);
      const N = n(90);
      const hgt = 30 + 40 * Math.min(1, R / 400);
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < N; i++) {
          const az = base + ((i + 0.5) / N - 0.5) * 1.9;
          const rr = R - row * 30 - rnd(i, 34 + row) * 12;
          const size = (row ? 62 : 46) + rnd(i, 29) * 26;
          nrm(-Math.cos(az), 0.7, -Math.sin(az));
          // the crest catches the light; the body behind it is the dust it lifts
          add(Math.cos(az) * rr, hgt * (row ? 0.55 : 0.35) + rnd(i, 28) * hgt * 0.4, Math.sin(az) * rr, size, rnd(i, 30 + row), 0, (row ? 0.75 : 0.85) * k, row ? 2.6 : 2.95, 3 + row * -0.5 + toward(az) * 0.01);
        }
      }
    }
    // ---- back to front by the static structural key (stable: no frame-to-frame swaps), upload
    P.sort((a, b) => a.key - b.key);
    const pos = this.aPos.array as Float32Array;
    const dat = this.aDat.array as Float32Array;
    const sh = this.aShade.array as Float32Array;
    const nn = this.aNrm.array as Float32Array;
    for (let i = 0; i < P.length; i++) {
      const q = P[i]!;
      pos[i * 3] = q.x;
      pos[i * 3 + 1] = q.y;
      pos[i * 3 + 2] = q.z;
      dat[i * 4] = q.size;
      dat[i * 4 + 1] = q.seed;
      dat[i * 4 + 2] = q.heat;
      dat[i * 4 + 3] = q.alpha;
      sh[i] = q.shade;
      nn[i * 3] = q.nx;
      nn[i * 3 + 1] = q.ny;
      nn[i * 3 + 2] = q.nz;
    }
    this.aPos.needsUpdate = true;
    this.aDat.needsUpdate = true;
    this.aShade.needsUpdate = true;
    this.aNrm.needsUpdate = true;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = P.length;
    this.mesh.visible = P.length > 0;
    if (this.isTsl && this.tslU) {
      (this.tslU.uTime!.value as number) = t;
      this.tmp.copy(this.sunDir).transformDirection(camera.matrixWorldInverse);
      (this.tslU.uSunV!.value as THREE.Vector3).copy(this.tmp);
      // Camera basis for the TSL billboard (object space, mesh at identity).
      (this.tslU.uCamR!.value as THREE.Vector3).setFromMatrixColumn(camera.matrixWorld, 0);
      (this.tslU.uCamU!.value as THREE.Vector3).setFromMatrixColumn(camera.matrixWorld, 1);
    } else {
      (this.mat as THREE.ShaderMaterial).uniforms.uTime!.value = t;
      this.tmp.copy(this.sunDir).transformDirection(camera.matrixWorldInverse);
      ((this.mat as THREE.ShaderMaterial).uniforms.uSunV!.value as THREE.Vector3).copy(this.tmp);
    }
    // the condensation ring round the stem, a third of the way up
    const ringK = t < 1.6 ? 0 : Math.min(1, (t - 1.6) / 0.8) * Math.max(0, Math.min(1, (7 - t) / 2.5));
    this.ring.visible = ringK > 0.003;
    if (this.ring.visible) {
      const y = capY * 0.42;
      const r1 = capR * (1.15 + 0.25 * e(t - 1.6, 2));
      this.ring.position.set(gz.x, gz.y + y, gz.z);
      this.ring.scale.set(r1, 1, r1);
      if (this.isTsl) {
        (this.ringMat as THREE.MeshBasicMaterial).opacity = ringK * 0.85;
      } else {
        const ru = (this.ringMat as THREE.ShaderMaterial).uniforms;
        ru.uK!.value = ringK * 0.85;
        ru.uR0!.value = r1 * 0.55;
        ru.uR1!.value = r1 * 2.0;
        ru.uTime!.value = t;
      }
    }
    // the flash: a spike, then a long glow while the fireball burns
    const fl = t < 0 ? 0 : t < 0.08 ? t / 0.08 : Math.exp(-(t - 0.08) / 0.3) + 0.12 * Math.exp(-t / 2.2);
    if (this.isTsl) {
      (this.flareMat as THREE.SpriteMaterial).opacity = fl;
    } else {
      ((this.flareMat as THREE.ShaderMaterial).uniforms.uK!).value = fl;
    }
    this.flare.visible = fl > 0.003;
    // the fireball core: hotter and longer-lived than the flash, riding the ball up into the cap
    const ck = t < 0 ? 0 : Math.min(1, t / 0.12) * Math.exp(-t / 1.6);
    this.core.visible = ck > 0.004;
    if (this.core.visible) {
      this.core.position.set(gz.x, gz.y + Math.max(ballR * 0.55, capY * Math.min(1, t / 2.2)), gz.z);
      if (this.isTsl) {
        const s = Math.max(120, ballR * 3.2);
        (this.core as THREE.Sprite).scale.set(s, s, 1);
        (this.coreMat as THREE.SpriteMaterial).opacity = ck * 0.9;
      } else {
        ((this.coreMat as THREE.ShaderMaterial).uniforms.uSize!).value = Math.max(120, ballR * 3.2);
        ((this.coreMat as THREE.ShaderMaterial).uniforms.uK!).value = ck * 0.9;
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of [this.mesh, this.ring]) m.geometry.dispose();
    // Sprite geometry is three-internal (shared) — do not dispose.
    for (const m of [this.mat, this.flareMat, this.coreMat, this.ringMat]) m.dispose();
  }
}

/** Radial glow texture for the nuke flash/core on WebGPU (sprite instead of GLSL falloff). */
function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.12, "rgba(255,255,255,0.85)");
  gr.addColorStop(0.35, "rgba(255,255,255,0.28)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
