/**
 * WEAPON FX — what every round fired LOOKS like (weapons stream, W2).
 *
 * The CoD / Warzone read, replacing the banana-round tracer GLB and the
 * per-shot sprite/Points allocations game.ts used to make:
 *
 *   TRACERS   a white-hot core inside a soft orange glow, running muzzle ->
 *             impact at WeaponDef.tracer m/s, motion-streaked to the distance
 *             covered in a frame, thinning to a 2 px line (and dimming) with
 *             range. Sniper: heavier + a vapour trail that hangs for a second.
 *             SMG: every other round (a tracer-every-other belt).
 *   3P FLASH  per-weapon cards along the barrel: a ragged hot core, a forward
 *             flame body, flash-hider prongs (muzzle-brake side jets on the
 *             sniper), a puff of lit gun smoke, + the ONE shared 3P PointLight
 *             game.ts already owns (light count stays fixed).
 *   IMPACTS   per surface, from the collider that stopped the round (OBB
 *             `visual` tags + the floor plane): metal sparks + glint, stone
 *             chips + powder, wood splinters, dirt/sand kick-up, glass shards;
 *             a bullet-hole decal lying on the OBB face the ray entered,
 *             modulating the wall's own lighting, pooled and capped (ring).
 *             Flesh: a short dark-red mist + a few droplets, no decal.
 *   BRASS     rifle / pistol cases from the viewmodel's port (eject.ts adapter)
 *             and from 3P shooters within 15 m; gravity, spin, a bounce or two,
 *             lying flat, then shrinking out. The bolt gun ejects on the bolt.
 *
 * Budget: three GPU quad families (glow / smoke / decal — stateless GPU
 * simulation, one draw each, gpu.ts) + one instanced debris mesh (chunks.ts)
 * = 4 draw calls for all of it. Spawning writes into fixed ring buffers: no
 * allocation per shot, no lights, no new materials after construction.
 */
import * as THREE from "three";
import { traceWorld, type OBB } from "@shared/map";
import { WEAPON_BY_ID } from "@shared/weapons";
import { QuadFamily, makeUniforms, M, G, S, D, type FxUniforms } from "./gpu";
import type { AnyRenderer } from "../../gpu-backend";

/** TSL module (WebGPU path) — loaded as a value only via dynamic import(); here just the type. */
type TslMod = typeof import("../../tsl-materials");
import { Chunks, K } from "./chunks";
import { surfaceOf, refineByNormal, faceOf, type Surface } from "./surface";
import type { EjectPort } from "./eject";

export { viewmodelEject, type EjectPort } from "./eject";
export type { Surface } from "./surface";

const TAU = Math.PI * 2;
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
/** Farthest a drawn round is traced (matches the old tracer's 120 m + margin). */
const RANGE = 150;
/** 3P brass is only thrown by shooters this close to the camera. */
const CASE_RANGE = 15;

/** Per-weapon look. */
interface Look {
  /** Tracer glow width (m), core share of the half-width, streak length at rest (m), brightness, draw every Nth round. */
  tw: number; core: number; tl: number; tb: number; every: number;
  /** Sniper: vapour trail opacity (0 = none). */
  trail: number;
  /** 3P muzzle: flash core (m), forward flame (m), flash-hider prongs, brake jets, smoke puffs, light intensity. */
  mz: number; fl: number; prongs: number; brake: number; smoke: number; light: number;
  /** Brass: shape, scale, seconds after the shot the case leaves (bolt), throw speed (m/s), port behind the 3P muzzle (m). */
  cs: number; csc: number; bolt: number; ev: number; port: number;
  /** Impact scale (a .338 round digs a bigger hole than a 9 mm). */
  ik: number;
}
const LOOK: Record<string, Look> = {
  ar: { tw: 0.05, core: 0.22, tl: 2.6, tb: 1, every: 1, trail: 0, mz: 0.16, fl: 0.36, prongs: 3, brake: 0, smoke: 1, light: 6, cs: K.CASING, csc: 1, bolt: 0, ev: 3.1, port: 0.36, ik: 1 },
  smg: { tw: 0.042, core: 0.24, tl: 2.1, tb: 0.9, every: 2, trail: 0, mz: 0.13, fl: 0.26, prongs: 4, brake: 0, smoke: 1, light: 5, cs: K.PCASING, csc: 1, bolt: 0, ev: 2.7, port: 0.24, ik: 0.85 },
  sniper: { tw: 0.075, core: 0.2, tl: 4.6, tb: 1.35, every: 1, trail: 0.42, mz: 0.22, fl: 0.52, prongs: 0, brake: 2, smoke: 3, light: 9, cs: K.CASING, csc: 1.45, bolt: 0.55, ev: 1.7, port: 0.62, ik: 1.45 },
  pistol: { tw: 0.036, core: 0.26, tl: 1.7, tb: 0.85, every: 1, trail: 0, mz: 0.11, fl: 0.18, prongs: 2, brake: 0, smoke: 1, light: 4.5, cs: K.PCASING, csc: 1, bolt: 0, ev: 2.5, port: 0.1, ik: 0.8 },
};
const lookOf = (w: string): Look => LOOK[w] ?? LOOK.ar!;

type RGB = readonly [number, number, number];
/** Albedo-ish colours (linear) the lit smoke shader multiplies by sun + sky. */
const COL: Record<string, { dust: RGB; grit: RGB; chunk: RGB }> = {
  dirt: { dust: [0.34, 0.28, 0.2], grit: [0.1, 0.075, 0.05], chunk: [0.3, 0.23, 0.15] },
  sand: { dust: [0.6, 0.5, 0.36], grit: [0.46, 0.37, 0.25], chunk: [0.62, 0.5, 0.34] },
  stone: { dust: [0.62, 0.53, 0.41], grit: [0.5, 0.42, 0.31], chunk: [0.66, 0.57, 0.44] },
  concrete: { dust: [0.5, 0.49, 0.47], grit: [0.42, 0.41, 0.39], chunk: [0.58, 0.57, 0.55] },
  wood: { dust: [0.52, 0.4, 0.26], grit: [0.62, 0.46, 0.28], chunk: [0.8, 0.62, 0.4] },
  metal: { dust: [0.42, 0.41, 0.4], grit: [0.3, 0.3, 0.3], chunk: [0.5, 0.5, 0.5] },
  rubber: { dust: [0.16, 0.15, 0.14], grit: [0.08, 0.08, 0.08], chunk: [0.1, 0.1, 0.1] },
  glass: { dust: [0.8, 0.84, 0.86], grit: [0.75, 0.85, 0.9], chunk: [0.8, 0.9, 1] },
};

/** The bright first frame of a burst: the same dust, lifted (fresh powder catches the light). */
const _pop: [number, number, number] = [0, 0, 0];
const POP = (c: RGB): RGB => {
  _pop[0] = Math.min(1, c[0] * 1.35); _pop[1] = Math.min(1, c[1] * 1.35); _pop[2] = Math.min(1, c[2] * 1.35);
  return _pop;
};

/** Collider tags whose visual skin is too far off the OBB for a flat hole (measured, qa probe). */
const NO_DECAL = new Set(["car", "barrel", "forklift", "tire-stack"]);
/** Collider tags whose visual face sits BEHIND the OBB face by a known amount (m): the hole is set back onto it. */
const INSET: Record<string, number> = { dprop: 0.08 };

// scratch (module-level: one WeaponFx per page)
const _c = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v2 = new THREE.Vector2();
const FACE = new Float64Array(7);
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(1, 0, 0);

/** A unit vector within `spread` (0 = exactly `ax`, 1 ~ a hemisphere-ish fan) of `ax`, into `out`. */
function cone(ax: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
  let x = 0, y = 0, z = 0, l = 2;
  while (l > 1 || l < 1e-4) {
    x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1;
    l = x * x + y * y + z * z;
  }
  l = Math.sqrt(l);
  out.set(ax.x + (x / l) * spread, ax.y + (y / l) * spread, ax.z + (z / l) * spread);
  return out.lengthSq() > 1e-8 ? out.normalize() : out.copy(ax);
}

/** Two unit vectors perpendicular to `d` (and to each other). */
function perp(d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): void {
  if (Math.abs(d.y) < 0.95) a.set(d.z, 0, -d.x);
  else a.set(1, 0, 0);
  a.normalize();
  b.crossVectors(d, a).normalize();
}

export interface WeaponFxOpts {
  mapId: string;
  sun?: THREE.DirectionalLight | null;
  /** Software-GL tier: fewer particles per event. */
  low?: boolean;
  /** The local gun's eject port (eject.ts). */
  eject?: EjectPort | null;
}

export class WeaponFx {
  readonly group = new THREE.Group();
  readonly glow: QuadFamily;
  readonly smoke: QuadFamily;
  readonly decal: QuadFamily;
  readonly chunks: Chunks;
  /** QA: `game.tracers.length` reads this (live tracer streaks). */
  readonly tracerStat = { length: 0 };
  /** The single shared 3P muzzle light (game.ts owns it; never more than one). */
  light: THREE.PointLight | null = null;
  eject: EjectPort | null;
  /** Viewmodel publishes onEject: it decides WHEN the local case leaves the gun. */
  vmDrivesEject = false;

  private readonly u: FxUniforms = makeUniforms();
  private now = 0;
  private readonly mapId: string;
  private readonly sun: THREE.DirectionalLight | null;
  private readonly k: number;
  private readonly cam = new THREE.Vector3();
  private readonly rounds = new Map<string, number>();
  private readonly tracerEnd = new Float64Array(96);
  private tracerCur = 0;
  /** Local bolt gun: the clock time its case leaves the port (-1 = none pending). */
  private boltAt = -1;
  private boltWeapon = "sniper";
  /** Shade of the event being emitted (0 = sunlit, 1 = in a collider's shadow) — smoke/grit read it. */
  private shade = 0;
  /** Depth pull (m) of the event being emitted — billboards drawn over the surface they were born on. */
  private pull = 0;
  /** Smoke puffs emitted this frame / smoothed per second — the overdraw budget (12 guns at once must stay smooth). */
  private puffs = 0;
  private puffRate = 0;

  constructor(scene: THREE.Scene, opts: WeaponFxOpts, tsl: TslMod | null = null) {
    this.mapId = opts.mapId;
    this.sun = opts.sun ?? null;
    this.k = opts.low ? 0.5 : 1;
    this.eject = opts.eject ?? null;
    this.group.name = "weapon-fx";
    // The GPU-simulated families cannot be re-drawn by the flicker detector's
    // ID pass (their vertices come from per-instance spawn records), so they
    // are FX to it; qaProxy() stands real geometry in for the holes and brass.
    this.group.userData.qaIgnore = true;
    const u = this.u;
    const onRender = (cam: THREE.Camera, r: AnyRenderer): void => {
      const pc = cam as THREE.PerspectiveCamera;
      const h = r.getDrawingBufferSize(_v2).y || 1080;
      u.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad((pc.fov ?? 68) / 2))) / h;
      u.uSunV.value.copy(u.uSunW.value).transformDirection(cam.matrixWorldInverse);
      // TSL billboards (no viewMatrix access needed in TSL): right/up axes.
      u.uCamR.value.setFromMatrixColumn(cam.matrixWorld, 0);
      u.uCamU.value.setFromMatrixColumn(cam.matrixWorld, 1);
    };
    // UNIQUE renderOrders (ZERO-FLICKER §4): a blended layer sharing an order with
    // another stream's (dust2's light shafts sit at 3, the frag scorch at 9) is
    // depth-sorted against it per frame and can swap. 7 / 8 / 16 are ours alone.
    this.decal = new QuadFamily("decal", opts.low ? 96 : 200, "decal", 7, u, onRender, tsl);
    this.smoke = new QuadFamily("smoke", opts.low ? 768 : 1536, "smoke", 8, u, onRender, tsl);
    this.glow = new QuadFamily("glow", opts.low ? 768 : 1536, "glow", 16, u, onRender, tsl);
    this.chunks = new Chunks(opts.low ? 128 : 320);
    this.group.add(this.decal.mesh, this.smoke.mesh, this.glow.mesh, this.chunks.mesh);
    scene.add(this.group);
    this.refreshLight(scene);
    // Built into the boot-time shader compile (game.prepareGraphics), not the first shot.
    this.glow.warm();
    this.smoke.warm();
    this.decal.warm();
    this.chunks.mesh.visible = true;
  }

  private refreshLight(scene: THREE.Scene): void {
    // The particles' sun + sky terms come from the scene's OWN lights (same
    // units as three's physical lights, x K), so a puff in shade sits in the
    // same ambient:sun ratio as the wall behind it — dust2's bright bounce-lit
    // shade and Shipment's deep container shadow both read right.
    const K = 0.5;
    const u = this.u;
    const sun = this.sun;
    const amb = u.uAmb.value.setRGB(0, 0, 0);
    const c = new THREE.Color();
    scene.traverse((o) => {
      const l = o as THREE.Light;
      if (!l.isLight || l === sun) return;
      for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) if ((p as THREE.Camera).isCamera) return;
      if ((l as THREE.AmbientLight).isAmbientLight) amb.add(c.copy(l.color).multiplyScalar(l.intensity));
      else if ((l as THREE.HemisphereLight).isHemisphereLight) {
        const h = l as THREE.HemisphereLight;
        amb.add(c.copy(h.color).add(h.groundColor).multiplyScalar(0.5 * h.intensity));
      } else if ((l as THREE.DirectionalLight).isDirectionalLight) amb.add(c.copy(l.color).multiplyScalar(0.5 * l.intensity));
    });
    amb.multiplyScalar(K);
    if (amb.r + amb.g + amb.b < 0.05) amb.setRGB(0.22, 0.2, 0.18);
    if (sun) {
      u.uSunW.value.copy(sun.position).sub(sun.target.position);
      if (u.uSunW.value.lengthSq() < 1e-6) u.uSunW.value.set(0.4, 0.8, 0.4);
      u.uSunW.value.normalize();
      u.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity * K);
    }
    const f = scene.fog;
    if (f && (f as THREE.Fog).isFog) {
      const fog = f as THREE.Fog;
      u.uFogCol.value.copy(fog.color);
      u.uFogNear.value = fog.near;
      u.uFogFar.value = fog.far;
    } else if (f && (f as THREE.FogExp2).isFogExp2) {
      const fog = f as THREE.FogExp2;
      u.uFogCol.value.copy(fog.color);
      u.uFogNear.value = 0;
      u.uFogFar.value = 2.2 / Math.max(1e-4, fog.density);
    }
  }

  /**
   * Is (x, y, z) in a collider's shadow? Particles cannot sample the shadow
   * map, so one ray toward the sun per EVENT (not per particle) decides
   * whether its dust is lit by the sun or only by the sky — the difference
   * between a tan puff and a glowing cream ball in container shade.
   */
  private shadeAt(x: number, y: number, z: number): number {
    const w = this.u.uSunW.value;
    return traceWorld(x, y, z, w.x, w.y, w.z, 90).t < 90 ? 0.88 : 0;
  }

  /** Camera position the LOD + near-miss logic reads (call before emitting, once a frame is enough). */
  setCamera(cam: THREE.Camera): void {
    cam.getWorldPosition(this.cam);
  }

  // ------------------------------------------------------------------ emitters
  private sparks(x: number, y: number, z: number, ax: THREE.Vector3, n: number, v0: number, v1: number, spread: number, l0: number, l1: number, size: number, heat: number, delay: number): void {
    const g = this.glow.p;
    n = Math.round(n * this.k);
    for (let i = 0; i < n; i++) {
      cone(ax, spread, _c);
      const s = rnd(v0, v1);
      g.delay = delay;
      g.x = x; g.y = y; g.z = z; g.vx = _c.x * s; g.vy = _c.y * s; g.vz = _c.z * s;
      g.life = rnd(l0, l1); g.s0 = size; g.s1 = size * 0.6; g.drag = 3.2; g.grav = 9.8;
      g.r = heat; g.g = heat * 0.95; g.b = heat * 0.9; g.a = 1; g.shape = G.SPARK; g.mode = M.STRETCH; g.e0 = 0.02; g.e1 = this.pull;
      this.glow.emit();
    }
  }

  private puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, col: RGB, a: number, s0: number, s1: number, life: number, drag: number, rise: number, ease: number, shape: number, delay: number): void {
    const s = this.smoke.p;
    s.delay = delay;
    s.x = x; s.y = y; s.z = z; s.vx = vx; s.vy = vy + rise; s.vz = vz;
    s.life = life; s.s0 = s0; s.s1 = s1; s.drag = drag; s.grav = -rise * 0.3;
    s.r = col[0]; s.g = col[1]; s.b = col[2]; s.a = a; s.shape = shape; s.mode = M.BILL;
    s.rot = Math.random() * TAU; s.spin = rnd(-0.7, 0.7); s.ease = ease; s.e2 = this.shade; s.e1 = this.pull;
    this.smoke.emit();
    this.puffs++;
  }

  private grit(x: number, y: number, z: number, ax: THREE.Vector3, n: number, v0: number, v1: number, spread: number, l0: number, l1: number, size: number, col: RGB, shape: number, delay: number): void {
    const s = this.smoke.p;
    n = Math.round(n * this.k);
    for (let i = 0; i < n; i++) {
      cone(ax, spread, _c);
      const sp = rnd(v0, v1);
      s.delay = delay;
      s.x = x; s.y = y; s.z = z; s.vx = _c.x * sp; s.vy = _c.y * sp; s.vz = _c.z * sp;
      s.life = rnd(l0, l1); s.s0 = size * rnd(0.7, 1.3); s.s1 = s.s0 * 0.85; s.drag = 1.4; s.grav = 9.8;
      const j = rnd(0.8, 1.15);
      s.r = col[0] * j; s.g = col[1] * j; s.b = col[2] * j; s.a = 1; s.shape = shape; s.mode = M.STRETCH; s.e0 = 0.012; s.e2 = this.shade; s.e1 = this.pull;
      this.smoke.emit();
    }
  }

  private debris(shape: number, x: number, y: number, z: number, ax: THREE.Vector3, n: number, v0: number, v1: number, spread: number, sc0: number, sc1: number, col: RGB, delay: number): void {
    const c = this.chunks.p;
    n = Math.round(n * this.k);
    if (this.chunks.load > 0.8) n = Math.min(n, 1);
    for (let i = 0; i < n; i++) {
      cone(ax, spread, _c);
      const s = rnd(v0, v1);
      c.shape = shape; c.x = x + ax.x * 0.02; c.y = y + ax.y * 0.02; c.z = z + ax.z * 0.02;
      c.vx = _c.x * s; c.vy = _c.y * s + 0.6; c.vz = _c.z * s;
      c.life = rnd(1.4, 2.4); c.scale = rnd(sc0, sc1); c.delay = delay;
      const j = rnd(0.85, 1.12);
      c.r = col[0] * j; c.g = col[1] * j; c.b = col[2] * j;
      c.rest = 0.28; c.spin = 18; c.grav = 1;
      this.chunks.emit();
    }
  }

  private flash(x: number, y: number, z: number, size: number, life: number, heat: number, delay: number): void {
    const g = this.glow.p;
    g.delay = delay; g.x = x; g.y = y; g.z = z; g.life = life; g.s0 = size; g.s1 = size * 1.2; g.rot = Math.random() * TAU;
    g.r = heat; g.g = heat * 0.95; g.b = heat * 0.85; g.a = 1; g.shape = G.FLASH; g.mode = M.BILL; g.e1 = this.pull;
    this.glow.emit();
  }

  // ------------------------------------------------------------------- rounds
  /**
   * One round, as drawn: a tracer from the muzzle (sx..) down the authoritative
   * ray (ox.. dx..) to where it stops — the world, or a body at `bodyT` — and
   * the surface impact timed for when the tracer arrives. Returns the flight
   * time (s). `local` = the shooter is the camera (first person);
   * `drawTracer` false = the round still lands, but no streak (a 3P barrel
   * that is not on the fire line yet).
   */
  round(sx: number, sy: number, sz: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, weapon: string, src: string, local: boolean, bodyT = Infinity, drawTracer = true): number {
    const L = lookOf(weapon);
    const speed = WEAPON_BY_ID[weapon]?.tracer || 500;
    const tr = traceWorld(ox, oy, oz, dx, dy, dz, RANGE);
    const endT = Math.min(tr.t, bodyT);
    const ex = ox + dx * endT, ey = oy + dy * endT, ez = oz + dz * endT;
    const vx = ex - sx, vy = ey - sy, vz = ez - sz;
    const dist = Math.hypot(vx, vy, vz);
    const flight = dist / speed;
    const nth = (this.rounds.get(src) ?? 0) + 1;
    this.rounds.set(src, nth);
    if (drawTracer && dist > 0.4 && nth % L.every === 1 % L.every) {
      const g = this.glow.p;
      g.x = sx; g.y = sy; g.z = sz; g.vx = vx; g.vy = vy; g.vz = vz;
      g.life = (dist + L.tl * 3.5) / speed;
      g.s0 = g.s1 = L.tw * (local ? 0.85 : 1);
      const b = L.tb * (local ? 0.8 : 1);
      g.r = b; g.g = b; g.b = b; g.a = 1;
      g.shape = G.TRACER; g.mode = M.TRACER; g.e0 = speed; g.e1 = Math.min(L.tl, dist * 0.6); g.e2 = L.core;
      this.glow.emit();
      this.tracerEnd[this.tracerCur] = this.now + g.life;
      this.tracerCur = (this.tracerCur + 1) % this.tracerEnd.length;
      if (L.trail > 0) {
        // the .338's vapour trail: a thin wisp down the whole path that widens and fades
        const s = this.smoke.p;
        s.x = sx; s.y = sy; s.z = sz; s.vx = vx; s.vy = vy; s.vz = vz;
        s.life = 1.5; s.s0 = 0.03; s.s1 = 0.2; s.ease = 1.6;
        s.r = 0.86; s.g = 0.87; s.b = 0.88; s.a = L.trail; s.shape = S.TRAIL; s.mode = M.SEG;
        this.smoke.emit();
      }
    }
    if (tr.t < RANGE && tr.t <= bodyT) this.impact(ex, ey, ez, dx, dy, dz, tr.hit, weapon, flight);
    return flight;
  }

  /**
   * A round landed on the world at (x, y, z) travelling (dx, dy, dz): the burst
   * for whatever stopped it, plus the hole, `delay` seconds from now.
   */
  impact(x: number, y: number, z: number, dx: number, dy: number, dz: number, hit: OBB | null, weapon: string, delay = 0): void {
    const L = lookOf(weapon);
    let edge = Infinity;
    if (hit) {
      faceOf(hit, x, y, z, 0, FACE);
      _n.set(FACE[0]!, FACE[1]!, FACE[2]!);
      edge = FACE[6]!;
    } else _n.set(0, 1, 0);
    // a ray grazing in from behind the face it "entered" (inside a box) — face the shooter
    if (_n.x * dx + _n.y * dy + _n.z * dz > 0) _n.set(-dx, -dy, -dz);
    const surf: Surface = refineByNormal(surfaceOf(hit, this.mapId), hit, _n.y, this.mapId);
    const dc = Math.hypot(x - this.cam.x, y - this.cam.y, z - this.cam.z);
    // Far impacts: still read (sizes grow ~ with range up to 2.4x), but cost less.
    const dk = Math.pow(Math.min(3.2, Math.max(1, dc / 10)), 0.75);
    // range LOD x the overdraw budget: past ~350 puffs/s (a dozen guns hosing
    // one wall) the lingering clouds go first, then the extra grit
    const busy = Math.min(1, Math.max(0, (this.puffRate - 350) / 450));
    const lod = (dc > 70 ? 0.25 : dc > 35 ? 0.55 : 1) * (1 - 0.6 * busy);
    const ik = L.ik;
    const n = _n;
    // ricochet axis: the mirror of the ray about the face, leaned toward the normal
    const dn = dx * n.x + dy * n.y + dz * n.z;
    _d.set(dx - 2 * dn * n.x, dy - 2 * dn * n.y, dz - 2 * dn * n.z).multiplyScalar(0.55).addScaledVector(n, 0.75).normalize();
    // 4 cm off the face: clear of a visual skin that sits proud of the collider
    const px = x + n.x * 0.04, py = y + n.y * 0.04, pz = z + n.z * 0.04;
    this.shade = this.shadeAt(px, py, pz);
    this.pull = 0.06;
    const col = COL[surf] ?? COL.concrete!;

    switch (surf) {
      case "metal": {
        this.flash(px, py, pz, 0.1 * dk * ik, 0.05, 1.3, delay);
        const g = this.glow.p;
        g.delay = delay; g.x = px; g.y = py; g.z = pz; g.life = 0.07; g.s0 = 0.34 * dk * ik; g.s1 = 0.42 * dk * ik;
        g.r = 1.6; g.g = 0.9; g.b = 0.35; g.a = 1; g.shape = G.GLOW; g.mode = M.BILL; this.glow.emit();
        this.sparks(px, py, pz, _d, 14 * lod * ik + 3, 5, 14, 0.6, 0.08, 0.3, 0.013 * Math.sqrt(dk), 1.15, delay);
        g.delay = delay; g.x = px; g.y = py; g.z = pz; g.life = 0.16; g.s0 = 0.16 * dk; g.s1 = 0.08 * dk;
        g.r = 2.2; g.g = 2.0; g.b = 1.7; g.a = 1; g.shape = G.GLINT; g.mode = M.BILL; g.rot = rnd(-0.3, 0.3); this.glow.emit();
        // a whiff of paint dust
        this.puff(px, py, pz, n.x * 1.6, n.y * 1.6, n.z * 1.6, col.dust, 0.55, 0.12 * dk * ik, 0.4 * dk * ik, rnd(0.5, 0.75), 5, 0.1, 2.4, S.DUST, delay);
        break;
      }
      case "stone":
      case "concrete": {
        this.flash(px, py, pz, 0.06 * dk, 0.035, 0.9, delay);
        if (Math.random() < 0.5) this.sparks(px, py, pz, _d, 2, 3, 8, 0.7, 0.08, 0.2, 0.008 * Math.sqrt(dk), 1.3, delay);
        this.grit(px, py, pz, _d, 18 * lod * ik, 3, 9, 0.6, 0.3, 0.7, 0.026 * Math.sqrt(dk), col.grit, S.GRIT, delay);
        if (dc < 30) this.debris(K.CHIP, px, py, pz, n, 5 * ik, 1.8, 4.5, 0.8, 0.7, 1.3, col.chunk, delay);
        // a hard powder POP the instant it lands (the read at range), the jet
        // straight off the face, then a soft cloud that hangs
        this.puff(px, py, pz, n.x * 1.5, n.y * 1.5, n.z * 1.5, POP(col.dust), 0.95, 0.36 * dk * ik, 0.8 * dk * ik, 0.3, 7, 0, 3, S.DUST, delay);
        for (let i = 0, nj = lod < 0.6 ? 1 : 3; i < nj; i++) {
          cone(n, 0.38, _c);
          const v = rnd(2.6, 4.6);
          this.puff(px, py, pz, _c.x * v, _c.y * v, _c.z * v, col.dust, 0.86, 0.24 * dk * ik, rnd(0.7, 0.9) * dk * ik, rnd(0.7, 1.0), 5.5, 0.05, 2.6, S.DUST, delay);
        }
        if (lod > 0.5) this.puff(px + n.x * 0.15, py + n.y * 0.15, pz + n.z * 0.15, n.x * 0.45, n.y * 0.45, n.z * 0.45, col.dust, 0.45, 0.25 * dk, rnd(1.2, 1.5) * dk * ik, rnd(2.0, 2.6), 1.8, 0.12, 1.6, S.DUST, delay);
        break;
      }
      case "wood": {
        this.grit(px, py, pz, _d, 10 * lod * ik, 2, 6, 0.7, 0.3, 0.6, 0.014 * Math.sqrt(dk), col.grit, S.GRIT, delay);
        if (dc < 30) this.debris(K.SPLINTER, px, py, pz, n, 4 * ik, 1.8, 4.5, 0.8, 0.8, 1.35, col.chunk, delay);
        this.puff(px, py, pz, n.x * 1.5, n.y * 1.5, n.z * 1.5, POP(col.dust), 0.9, 0.24 * dk * ik, 0.5 * dk * ik, 0.24, 7, 0, 3, S.DUST, delay);
        this.puff(px, py, pz, n.x * 2.2, n.y * 2.2, n.z * 2.2, col.dust, 0.7, 0.14 * dk * ik, 0.48 * dk * ik, rnd(0.5, 0.7), 6, 0.05, 2.4, S.DUST, delay);
        if (lod > 0.5) this.puff(px + n.x * 0.08, py + n.y * 0.08, pz + n.z * 0.08, n.x * 0.3, n.y * 0.3, n.z * 0.3, col.dust, 0.26, 0.1 * dk, 0.6 * dk * ik, rnd(1.2, 1.6), 1.8, 0.1, 1.6, S.DUST, delay);
        break;
      }
      case "glass": {
        const g = this.glow.p;
        g.delay = delay; g.x = px; g.y = py; g.z = pz; g.life = 0.2; g.s0 = 0.2 * dk; g.s1 = 0.1 * dk;
        g.r = 2.2; g.g = 2.3; g.b = 2.5; g.a = 1; g.shape = G.GLINT; g.mode = M.BILL; this.glow.emit();
        if (dc < 30) this.debris(K.SHARD, px, py, pz, _d, 6, 1.5, 4, 0.9, 0.7, 1.2, col.chunk, delay);
        this.grit(px, py, pz, _d, 8 * lod, 2, 5, 0.8, 0.3, 0.6, 0.008, col.grit, S.GRIT, delay);
        break;
      }
      case "rubber": {
        this.grit(px, py, pz, _d, 6 * lod, 1.5, 4, 0.7, 0.2, 0.45, 0.012, col.grit, S.GRIT, delay);
        this.puff(px, py, pz, n.x * 1.5, n.y * 1.5, n.z * 1.5, col.dust, 0.45, 0.04 * dk, 0.26 * dk, 0.5, 6, 0.05, 2.2, S.DUST, delay);
        break;
      }
      default: {
        // dirt / sand: a kicked-up column of grains + clods, a plume, a lingering haze
        cone(n, 0.18, _a);
        _a.addScaledVector(_d, 0.35).normalize();
        // CoD read: a dark spray of soil rising ~a metre, a tan plume punched up
        // through it, and a haze that hangs for a couple of seconds
        this.grit(px, py, pz, _a, 26 * lod * ik, 4, 10, 0.3, 0.4, 0.9, 0.034 * Math.sqrt(dk), col.grit, S.GRIT, delay);
        if (dc < 30) this.debris(K.CLOD, px, py, pz, _a, 5 * ik, 2.5, 5, 0.45, 0.8, 1.4, col.chunk, delay);
        this.puff(px, py + 0.05, pz, _a.x * 2, _a.y * 2, _a.z * 2, POP(col.dust), 0.9, 0.32 * dk * ik, 0.7 * dk * ik, 0.28, 7, 0, 3, S.DUST, delay);
        for (let i = 0, nj = lod < 0.6 ? 1 : 3; i < nj; i++) {
          cone(_a, 0.28, _c);
          const v = rnd(2.6, 4.6);
          this.puff(px, py, pz, _c.x * v, _c.y * v, _c.z * v, col.dust, 0.86, 0.26 * dk * ik, rnd(0.85, 1.1) * dk * ik, rnd(1.0, 1.4), 4, 0.12, 2.2, S.DUST, delay);
        }
        if (lod > 0.5) this.puff(px, py + 0.2, pz, 0, 0.35, 0, col.dust, 0.45, 0.3 * dk, rnd(1.3, 1.6) * dk * ik, rnd(2.2, 2.8), 1.6, 0.1, 1.5, S.DUST, delay);
        break;
      }
    }

    // The hole, lying on the face the ray entered, modulating that wall's own shading.
    // Curved / loosely-boxed props (cars, barrels, the forklift, tyres) get no
    // flat hole: their skins sit 15-35 cm off the collider box (measured), so a
    // decal would hang in the air in front of them.
    const tag = hit?.visual ?? "";
    if (NO_DECAL.has(tag)) {
      this.pull = 0;
      return;
    }
    const shape = surf === "metal" ? D.METAL : surf === "wood" ? D.WOOD : surf === "glass" ? D.GLASS : surf === "stone" || surf === "concrete" ? D.STONE : D.DIRT;
    const base = surf === "metal" ? 0.17 : surf === "wood" ? 0.17 : surf === "glass" ? 0.24 : surf === "stone" || surf === "concrete" ? 0.22 : surf === "rubber" ? 0.12 : 0.26;
    let size = base * ik * rnd(0.85, 1.15);
    // never hang off the box into the air: shrink to the room the face has, or skip
    if (size * 0.5 > edge) size = edge * 2;
    if (size >= 0.05) {
      const inset = INSET[tag] ?? 0;
      const p = this.decal.p;
      p.delay = delay; p.x = x - n.x * inset; p.y = y - n.y * inset; p.z = z - n.z * inset; p.vx = n.x; p.vy = n.y; p.vz = n.z;
      p.life = 30; p.s0 = p.s1 = size; p.r = p.g = p.b = 1; p.a = surf === "rubber" ? 0.7 : 1;
      p.shape = surf === "rubber" ? D.DIRT : shape; p.mode = M.PLANE; p.rot = Math.random() * TAU;
      p.e0 = 0.05; p.e2 = 0.004;
      this.decal.emit();
    }
    this.pull = 0;
  }

  /**
   * A round into a body (the `hit` event): a short dark-red mist blown out
   * along the round's path, a little blowback, a few droplets. No decal.
   */
  flesh(x: number, y: number, z: number, dx: number, dy: number, dz: number, head: boolean, kill: boolean): void {
    _d.set(dx, dy, dz);
    if (_d.lengthSq() < 1e-6) _d.set(0, 0.2, 1);
    _d.normalize();
    const k = head ? 1.3 : kill ? 1.12 : 1;
    const dc = Math.hypot(x - this.cam.x, y - this.cam.y, z - this.cam.z);
    const dk = Math.pow(Math.min(3, Math.max(1, dc / 12)), 0.6);
    // a saturated arterial red: a dark maroon mist vanishes against the operators' dark-red fur
    const MIST: RGB = [0.66, 0.05, 0.04];
    this.shade = this.shadeAt(x, y, z);
    // The hit point is on the hit CAPSULE; the drawn body is bulkier and
    // would swallow a puff born there — so the mist is DEPTH-PULLED toward
    // the viewer (same screen spot, drawn over the body), blown back + out.
    this.pull = 0.85;
    const n = (head ? 3 : 2) + (kill ? 1 : 0);
    for (let i = 0; i < n; i++) {
      _a.set(-_d.x, -_d.y + 0.25, -_d.z);
      cone(_a, 0.7, _c);
      const v = rnd(0.5, 1.3);
      // CoD's hit puff POPS at full size and dissipates in a quarter second
      this.puff(x, y, z, _c.x * v, _c.y * v, _c.z * v, MIST, 0.85, rnd(0.2, 0.26) * k * dk, rnd(0.46, 0.6) * k * dk, rnd(0.24, 0.34), 6, 0, 3, S.MIST, 0);
    }
    // the exit spray, read from the side
    this.puff(x + _d.x * 0.2, y + _d.y * 0.2, z + _d.z * 0.2, _d.x * 1.8, _d.y * 1.8 + 0.1, _d.z * 1.8, MIST, 0.6, 0.14 * k * dk, 0.45 * k * dk, 0.3, 5, 0, 3, S.MIST, 0);
    _a.set(-_d.x, 0.4, -_d.z).normalize();
    this.grit(x, y, z, _a, (head ? 9 : 6) * k, 1.5, 3.8, 0.75, 0.25, 0.45, 0.014, [0.42, 0.03, 0.025], S.DROP, 0);
    this.pull = 0;
  }

  /**
   * A third-person muzzle flash: per-weapon cards along the barrel at `pos`
   * pointing `dir` (unit), plus the shared 3P light.
   */
  muzzle3P(px: number, py: number, pz: number, dx: number, dy: number, dz: number, weapon: string): void {
    const L = lookOf(weapon);
    _d.set(dx, dy, dz).normalize();
    perp(_d, _a, _b);
    const g = this.glow.p;
    const life = 0.05;
    const dc = Math.hypot(px - this.cam.x, py - this.cam.y, pz - this.cam.z);
    // a far flash grows a little so a muzzle at 40 m still pops (CoD's 3P flash reads across the map)
    const dk = Math.pow(Math.min(2.6, Math.max(1, dc / 12)), 0.6);
    const sz = L.mz * dk;
    this.shade = this.shadeAt(px, py, pz);
    // 1) ragged white-hot core just ahead of the muzzle
    this.flash(px + _d.x * sz * 0.3, py + _d.y * sz * 0.3, pz + _d.z * sz * 0.3, sz, life, 0.72, 0);
    // 2) forward flame body: a long thin hot tongue + a short fat one
    for (let j = 0; j < 2; j++) {
      g.x = px; g.y = py; g.z = pz; g.vx = _d.x; g.vy = _d.y; g.vz = _d.z; g.life = life * (j ? 0.8 : 1);
      g.s0 = L.fl * dk * (j ? 0.55 : 1); g.s1 = g.s0 * 1.15; g.e1 = j ? 0.62 : 0.3;
      g.r = 0.7; g.g = 0.62; g.b = 0.5; g.a = 1; g.shape = G.FLAME; g.mode = M.AXIS;
      this.glow.emit();
    }
    // 3) flash-hider prongs: short side tongues leaning forward (the star you see head-on)
    const ph = Math.random() * TAU;
    for (let i = 0; i < L.prongs; i++) {
      const an = ph + (i / L.prongs) * TAU;
      _c.copy(_d).multiplyScalar(0.55).addScaledVector(_a, Math.cos(an)).addScaledVector(_b, Math.sin(an)).normalize();
      g.x = px + _d.x * sz * 0.1; g.y = py + _d.y * sz * 0.1; g.z = pz + _d.z * sz * 0.1; g.vx = _c.x; g.vy = _c.y; g.vz = _c.z;
      g.life = life * 0.8; g.s0 = sz * 0.62; g.s1 = sz * 0.78; g.e1 = 0.42;
      g.r = 0.55; g.g = 0.5; g.b = 0.42; g.a = 1; g.shape = G.FLAME; g.mode = M.AXIS;
      this.glow.emit();
    }
    // 4) muzzle brake: two hard side jets, square to the bore (sniper)
    for (let i = 0; i < L.brake; i++) {
      const s = i ? -1 : 1;
      _c.copy(_a).multiplyScalar(s).addScaledVector(_d, 0.12).normalize();
      g.x = px - _d.x * 0.03; g.y = py - _d.y * 0.03; g.z = pz - _d.z * 0.03; g.vx = _c.x; g.vy = _c.y; g.vz = _c.z;
      g.life = life; g.s0 = sz * 1.5; g.s1 = sz * 1.8; g.e1 = 0.36;
      g.r = 0.75; g.g = 0.66; g.b = 0.52; g.a = 1; g.shape = G.FLAME; g.mode = M.AXIS;
      this.glow.emit();
      // the brake also throws a flat sheet of dust/smoke sideways
      this.puff(px, py, pz, _c.x * 2.6, _c.y * 2.6 + 0.2, _c.z * 2.6, [0.7, 0.69, 0.67], 0.42, 0.08, 0.6, rnd(0.8, 1.2), 3.2, 0.2, 2, S.DUST, 0.02);
    }
    // 5) lit gun smoke that drifts up and hangs
    for (let i = 0; i < L.smoke; i++) {
      _c.copy(_d).multiplyScalar(rnd(0.5, 1.2));
      this.puff(px + _d.x * sz * rnd(0.3, 0.8), py + _d.y * sz * 0.5, pz + _d.z * sz * rnd(0.3, 0.8), _c.x, _c.y + rnd(0.1, 0.3), _c.z,
        [0.72, 0.71, 0.69], 0.26, sz * 0.4, sz * rnd(2.2, 3.2), rnd(0.7, 1.1), 3, 0.25, 2.2, S.DUST, 0.02);
    }
    // 6) a few hot sparks
    this.sparks(px, py, pz, _d, 3, 6, 14, 0.35, 0.06, 0.16, 0.009, 1.4, 0);
    // the ONE 3P light, moved to this muzzle
    const l = this.light;
    if (l && dc < 40) {
      l.position.set(px + _d.x * 0.1, py + _d.y * 0.1, pz + _d.z * 0.1);
      l.intensity = Math.max(l.intensity, L.light);
    }
  }

  // -------------------------------------------------------------------- brass
  /** A case thrown from (px..) at velocity (vx..). `born` < 1 = starts viewmodel-small and grows. */
  private brass(px: number, py: number, pz: number, vx: number, vy: number, vz: number, weapon: string, born: number, delay: number): void {
    const L = lookOf(weapon);
    const c = this.chunks.p;
    const load = this.chunks.load;
    c.shape = L.cs; c.x = px; c.y = py; c.z = pz; c.vx = vx; c.vy = vy; c.vz = vz;
    c.life = load > 0.6 ? 2 : 4.5; c.scale = L.csc; c.delay = delay;
    c.r = c.g = c.b = 1; c.rest = 0.42; c.spin = 28; c.grav = 1;
    if (born > 0 && born < 1) { c.born = born; c.growT = 0.22; }
    this.chunks.emit();
  }

  /** The local gun's case leaves the port NOW (the viewmodel's onEject, or the trigger pull). */
  ejectLocal(weapon: string): void {
    const e = this.eject;
    if (!e || !e.sample(weapon, _p, _c)) return;
    const L = lookOf(weapon);
    const v = L.ev * rnd(0.85, 1.15);
    _c.multiplyScalar(v);
    this.brass(_p.x, _p.y, _p.z, _c.x + rnd(-0.25, 0.25), _c.y + rnd(-0.2, 0.3), _c.z + rnd(-0.25, 0.25), weapon, 0.55, 0);
    // a wisp from the port
    this.shade = this.shadeAt(_p.x, _p.y, _p.z);
    this.puff(_p.x, _p.y, _p.z, 0, 0.25, 0, [0.8, 0.8, 0.8], 0.1, 0.012, 0.06, 0.4, 3, 0.15, 2, S.DUST, 0);
  }

  /**
   * The viewmodel's own eject hook (vm.onEject): a case leaves the port at
   * `pos` along `dir` NOW — on the trigger pull, or on the bolt stroke for a
   * bolt gun. `scale` is the viewmodel's depth squeeze: the case is born at
   * that apparent size and grows to world size as it clears the lens.
   */
  ejectAt(pos: THREE.Vector3, dir: THREE.Vector3, weapon: string, scale = 1): void {
    const L = lookOf(weapon);
    const v = L.ev * rnd(0.85, 1.15);
    _c.copy(dir).normalize().multiplyScalar(v);
    this.brass(pos.x, pos.y, pos.z, _c.x + rnd(-0.25, 0.25), _c.y + rnd(-0.2, 0.3), _c.z + rnd(-0.25, 0.25), weapon, scale < 0.98 ? scale : 1, 0);
    this.shade = this.shadeAt(pos.x, pos.y, pos.z);
    this.puff(pos.x, pos.y, pos.z, 0, 0.25, 0, [0.8, 0.8, 0.8], 0.1, 0.012, 0.06, 0.4, 3, 0.15, 2, S.DUST, 0);
  }

  /** The local player fired: brass on this shot, or when the bolt is worked. */
  localShot(weapon: string): void {
    if (this.vmDrivesEject) return;
    const L = lookOf(weapon);
    if (L.bolt > 0) {
      this.boltAt = this.now + L.bolt;
      this.boltWeapon = weapon;
    } else this.ejectLocal(weapon);
  }

  /** A third-person shooter's case: off the right side of a gun at `exit` pointing `dir`. */
  casing3P(ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, weapon: string): void {
    const dc = Math.hypot(ex - this.cam.x, ey - this.cam.y, ez - this.cam.z);
    if (dc > CASE_RANGE || this.chunks.load > 0.75) return;
    const L = lookOf(weapon);
    _d.set(dx, dy, dz).normalize();
    // right of the bore (dir x up), with a lift
    _a.set(-_d.z, 0, _d.x);
    if (_a.lengthSq() < 1e-6) _a.set(1, 0, 0);
    _a.normalize();
    const px = ex - _d.x * L.port, py = ey - _d.y * L.port + 0.02, pz = ez - _d.z * L.port;
    const v = L.ev * rnd(0.85, 1.15);
    this.brass(px, py, pz, _a.x * v - _d.x * 0.4 + rnd(-0.3, 0.3), v * 0.55 + rnd(0, 0.5), _a.z * v - _d.z * 0.4 + rnd(-0.3, 0.3), weapon, 1, L.bolt);
  }

  // ------------------------------------------------------------------- frame
  update(dt: number): void {
    const d = Math.min(Math.max(dt, 0), 0.25);
    this.now += d;
    if (this.now > 600) {
      // clock rebase: keeps the shader's float time small
      const off = this.now - 1;
      this.glow.rebase(off); this.smoke.rebase(off); this.decal.rebase(off);
      for (let i = 0; i < this.tracerEnd.length; i++) this.tracerEnd[i]! -= off;
      if (this.boltAt >= 0) this.boltAt -= off;
      this.now -= off;
    }
    if (this.boltAt >= 0 && this.now >= this.boltAt) {
      this.boltAt = -1;
      this.ejectLocal(this.boltWeapon);
    }
    if (d > 0) {
      this.puffRate += (this.puffs / d - this.puffRate) * (1 - Math.exp(-d * 3));
      this.puffs = 0;
    }
    const u = this.u;
    u.uTime.value = this.now;
    u.uDt.value += (Math.min(d, 1 / 30) - u.uDt.value) * 0.3;
    this.glow.flush(this.now);
    this.smoke.flush(this.now);
    this.decal.flush(this.now);
    this.chunks.update(Math.min(d, 0.05));
    let live = 0;
    for (let i = 0; i < this.tracerEnd.length; i++) if (this.tracerEnd[i]! > this.now) live++;
    this.tracerStat.length = live;
  }

  private qaGroup: THREE.Group | null = null;

  /** QA: drop every live particle, hole and piece of brass (captures start from a clean slate). */
  qaClear(): void {
    this.glow.clear();
    this.smoke.clear();
    this.decal.clear();
    this.chunks.count = 0;
    this.chunks.mesh.count = 0;
  }

  /**
   * ZERO-FLICKER QA: stand REAL geometry in for the persistent FX — every live
   * bullet hole (built with the decal shader's exact lift + view-ray pull for a
   * camera at `cam`, same blend/depth/polygonOffset state) and every live
   * casing / debris piece (its own shape at its own matrix) — so the flicker
   * detector's ID passes test them where the frame draws them. Rebuild per
   * viewpoint (the pull depends on the camera). qaProxy(null) removes it.
   */
  qaProxy(cam: THREE.Vector3 | null, control: "" | "coplanar" | "offset-only" = ""): THREE.Group | null {
    const scene = this.group.parent;
    if (this.qaGroup) {
      this.qaGroup.removeFromParent();
      this.qaGroup.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.qaGroup = null;
    }
    if (!cam || !scene) return null;
    const g = new THREE.Group();
    g.name = "wfx-qa";
    const dm = this.decal.mesh.material as THREE.ShaderMaterial;
    // POSITIVE CONTROLS (QA self-test): the same holes laid exactly ON their
    // collider face with no lift and no pull — "coplanar" without, "offset-only"
    // with the polygonOffset — must be reported (zfight / mitigated), or the
    // check proves nothing by passing.
    const ctl = control !== "";
    const holes = ctl ? this.qaControlHoles(scene, cam) : this.decal.qaPlanes(this.now, cam);
    if (holes.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(holes, 3));
      const m = new THREE.MeshBasicMaterial({
        color: 0x202020, transparent: true, opacity: 1, depthWrite: dm.depthWrite, depthTest: dm.depthTest, side: dm.side,
        polygonOffset: control === "coplanar" ? false : dm.polygonOffset, polygonOffsetFactor: dm.polygonOffsetFactor, polygonOffsetUnits: dm.polygonOffsetUnits,
      });
      const mesh = new THREE.Mesh(geo, m);
      mesh.name = "wfx-qa-bullet-holes";
      mesh.renderOrder = this.decal.mesh.renderOrder;
      mesh.frustumCulled = false;
      g.add(mesh);
    }
    const tris = this.chunks.qaTriangles();
    if (tris.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(tris, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xc9a046, side: THREE.DoubleSide }));
      mesh.name = "wfx-qa-brass-debris";
      mesh.frustumCulled = false;
      g.add(mesh);
    }
    scene.add(g);
    this.qaGroup = g;
    return g;
  }

  /**
   * QA positive control: each live hole re-laid EXACTLY on the drawn surface
   * (a raycast against the visible map meshes from `cam` through the hole, the
   * hit triangle's own plane), no lift, no pull — a decal that would truly
   * z-fight. Collider faces and drawn skins differ by up to 7 cm, so laying
   * the control on the collider would only bury it.
   */
  private qaControlHoles(scene: THREE.Object3D, cam: THREE.Vector3): Float32Array {
    const meshes: THREE.Object3D[] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !o.visible || (o as THREE.SkinnedMesh).isSkinnedMesh) return;
      for (let a: THREE.Object3D | null = o; a; a = a.parent) if (a.userData?.qaIgnore || a.name === "wfx-qa" || (a as THREE.Camera).isCamera) return;
      const mats = ([] as THREE.Material[]).concat(m.material);
      if (mats.every((x) => x.transparent || !x.visible)) return;
      meshes.push(o);
    });
    const rc = new THREE.Raycaster();
    const P = new THREE.Vector3(), n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), w = new THREE.Vector3();
    const out: number[] = [];
    const d = (this.decal as unknown as { data: Float32Array }).data;
    for (let i = 0, hi = (this.decal.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount; i < hi; i++) {
      const o = i * 24;
      if (Math.round(d[o + 17]!) !== M.PLANE) continue;
      const age = this.now - d[o + 3]!;
      if (age < 0 || age >= d[o + 7]!) continue;
      P.set(d[o]!, d[o + 1]!, d[o + 2]!);
      rc.set(cam, w.subVectors(P, cam).normalize());
      rc.far = P.distanceTo(cam) + 0.5;
      const hit = rc.intersectObjects(meshes, false)[0];
      if (!hit?.face) continue;
      n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (n.dot(w) > 0) n.negate();
      t1.crossVectors(n, Math.abs(n.y) < 0.99 ? _up : _right).normalize();
      t2.crossVectors(n, t1);
      const r = d[o + 8]! * 0.5 * 0.95;
      for (let s = 0; s < 12; s++) {
        for (const j of [s, s + 1]) {
          const th = (j / 12) * TAU;
          w.copy(hit.point).addScaledVector(t1, Math.cos(th) * r).addScaledVector(t2, Math.sin(th) * r);
          out.push(w.x, w.y, w.z);
        }
        out.push(hit.point.x, hit.point.y, hit.point.z);
      }
    }
    return new Float32Array(out);
  }

  /** Diagnostics for QA / perf probes. */
  stats(): { glow: number; smoke: number; decal: number; chunks: number; tracers: number; eject: string } {
    return {
      glow: this.glow.alive(this.now), smoke: this.smoke.alive(this.now), decal: this.decal.alive(this.now),
      chunks: this.chunks.count, tracers: this.tracerStat.length, eject: this.vmDrivesEject ? "vm.onEject" : this.eject?.kind() ?? "none",
    };
  }
}

