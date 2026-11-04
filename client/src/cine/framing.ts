/**
 * client/src/cine/framing.ts — where a cinematic camera may go, and what it sees.
 *
 * Every question is answered with the bullets' own colliders (traceWorld), so
 * "clear" means clear for a camera exactly where it is clear for a round. Maps
 * whose visual geometry has no collider (a decorative eave, a car door) can
 * still occlude; the collider audit is what closes that gap.
 */
import * as THREE from "three";
import { traceWorld } from "@shared/map";
import { activeMap } from "@shared/maps";
import { inSolid } from "./shots";

const MAP = activeMap();
const tmp = new THREE.Vector3();

/** Distance (m) a ray travels from `o` along `d` (unit) before a collider, capped at `max`. */
export function rayDist(o: THREE.Vector3, d: THREE.Vector3, max = 60): number {
  return Math.min(max, traceWorld(o.x, o.y, o.z, d.x, d.y, d.z, max).t);
}

/** Nothing between a and b (bullet colliders). */
export function seg(a: THREE.Vector3, b: THREE.Vector3): boolean {
  const L = a.distanceTo(b);
  if (L < 1e-3) return true;
  tmp.subVectors(b, a).divideScalar(L);
  return traceWorld(a.x, a.y, a.z, tmp.x, tmp.y, tmp.z, L).t >= L - 0.05;
}

/** At least `r` m of air around p in the six axis directions, and not inside a box. */
export function air(p: THREE.Vector3, r = 1.2): boolean {
  if (inSolid(MAP, p, 0)) return false;
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
  ];
  for (const [x, y, z] of dirs) {
    tmp.set(x!, y!, z!);
    if (rayDist(p, tmp, r) < r - 0.02) return false;
  }
  return true;
}

/** Every segment of a sampled path is clear and no sample is inside geometry. */
export function pathClear(pts: THREE.Vector3[], skipTail = 0): boolean {
  const n = pts.length - skipTail;
  for (let i = 0; i < n; i++) {
    if (inSolid(MAP, pts[i]!, 0)) return false;
    if (i > 0 && !seg(pts[i - 1]!, pts[i]!)) return false;
  }
  return true;
}

/** How open a view is: mean free distance (0..1 of `max`) of a 3x3 grid of rays through the frustum. */
export function openFrame(cam: THREE.Vector3, look: THREE.Vector3, vfovDeg = 40, aspect = 16 / 9, max = 18): number {
  const fwd = new THREE.Vector3().subVectors(look, cam).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const th = Math.tan((vfovDeg * Math.PI) / 360) * 0.75;
  let sum = 0;
  const d = new THREE.Vector3();
  for (const sy of [-1, 0, 1])
    for (const sx of [-1, 0, 1]) {
      d.copy(fwd).addScaledVector(right, sx * th * aspect).addScaledVector(up, sy * th).normalize();
      sum += rayDist(cam, d, max) / max;
    }
  return sum / 9;
}

/** How many of head / chest / feet of a body standing at (x, y, z) the camera can see. */
export function bodySeen(cam: THREE.Vector3, x: number, y: number, z: number): number {
  let n = 0;
  for (const h of [1.7, 1.15, 0.25]) if (seg(cam, tmp.set(x, y + h, z).clone())) n++;
  return n;
}

/** Distance from p along d (horizontal) to the edge of the map's playable rect. */
export function toBounds(p: THREE.Vector3, d: THREE.Vector3): number {
  const b = MAP.bounds;
  let t = Infinity;
  if (d.x > 1e-6) t = Math.min(t, (b.maxX - p.x) / d.x);
  if (d.x < -1e-6) t = Math.min(t, (b.minX - p.x) / d.x);
  if (d.z > 1e-6) t = Math.min(t, (b.maxZ - p.z) / d.z);
  if (d.z < -1e-6) t = Math.min(t, (b.minZ - p.z) / d.z);
  return Math.max(0.5, t);
}

/**
 * THE LANDING YAW. The direction a fresh spawn should face when the camera
 * lands in its eyes: the longest open sightline (a 3-ray cone, so a slot
 * between two posts does not win), biased toward the enemy / objective and a
 * little toward the spawn's own authored facing.
 */
/**
 * HOW OPEN A VIEW IS from `eye` facing `yaw`, measured the same way by the chooser and by QA:
 *   min   the centre lane (three eye rays ±0.14 rad, clipped at the map's edge)
 *   low   a ray 1 m lower (a chest-high fence the eye clears is still a fence)
 *   open  the FRAME: a fan of 5 yaws × 2 pitches (level and 7° down), each capped at 30 m, averaged —
 *         a roof slope or a wall filling the lower frame scores low however long the centre lane is
 */
export function viewOpen(eye: THREE.Vector3, yaw: number): { min: number; low: number; open: number } {
  const d = new THREE.Vector3();
  let min = Infinity;
  for (const off of [-0.14, 0, 0.14]) {
    d.set(Math.sin(yaw + off), 0, Math.cos(yaw + off));
    min = Math.min(min, rayDist(eye, d, Math.min(45, toBounds(eye, d))));
  }
  const lowP = eye.clone().setY(eye.y - 1.0);
  d.set(Math.sin(yaw), 0, Math.cos(yaw));
  const low = rayDist(lowP, d, Math.min(45, toBounds(lowP, d)));
  let sum = 0;
  let n = 0;
  for (const off of [-0.4, -0.2, 0, 0.2, 0.4]) {
    for (const pitch of [0, -0.12]) {
      d.set(Math.sin(yaw + off) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw + off) * Math.cos(pitch));
      sum += Math.min(30, rayDist(eye, d, Math.min(30, toBounds(eye, d) + 0.01)));
      n++;
    }
  }
  return { min, low, open: sum / n };
}

export function landingYaw(eye: THREE.Vector3, spawnYaw: number, toward: THREE.Vector3 | null): { yaw: number; dist: number; low: number; open: number; anyGood: boolean; maxOpen: number; alts: { yaw: number; dist: number; score: number }[] } {
  let best = { yaw: spawnYaw, dist: 0, low: 0, open: 0, score: -1e9 };
  let anyGood = false;
  let maxOpen = 0;
  const all: { yaw: number; dist: number; score: number; open: number; low: number; enemy: number }[] = [];
  const towardYaw = toward ? Math.atan2(toward.x - eye.x, toward.z - eye.z) : null;
  for (let i = 0; i < 48; i++) {
    const yaw = spawnYaw + (i / 48) * Math.PI * 2;
    const v = viewOpen(eye, yaw);
    const enemy = towardYaw !== null ? Math.cos(yaw - towardYaw) : 0;
    const good = v.min >= 20 && v.low >= 8 && v.open >= 14 && enemy > 0;
    if (good) anyGood = true;
    all.push({ yaw, dist: v.min, score: 0, open: v.open, low: v.low, enemy });
  }
  // the best frame this spawn has that is not over a fence (the low ray clear 6 m); every lane if none is
  const clear = all.filter((a) => a.low >= 6);
  for (const a of clear.length ? clear : all) maxOpen = Math.max(maxOpen, a.open);
  for (const a of all) {
    // the open FRAME first, then the lane, then the enemy side, then a nudge toward the spawn's own facing
    a.score = (a.dist >= 20 && a.low >= 8 && a.open >= 14 && a.enemy > 0 ? 40 : 0) + 1.4 * a.open + 0.35 * Math.min(a.dist, 35) + 0.3 * Math.min(a.low, 20) - (a.low < 6 ? 70 : 0) - (a.open < 0.8 * maxOpen ? 30 : 0) + 6 * a.enemy + 2 * Math.cos(a.yaw - spawnYaw);
    if (a.score > best.score) best = { yaw: a.yaw, dist: a.dist, low: a.low, open: a.open, score: a.score };
  }
  all.sort((p, q) => q.score - p.score);
  return { yaw: best.yaw, dist: best.dist, low: best.low, open: best.open, anyGood, maxOpen, alts: all.filter((x) => x.dist >= 8).slice(0, 10) };
}

/**
 * THE OVER-THE-SHOULDER the intro lands from: behind and above your shoulder, looking down your lane
 * (the way you will face at GO). The first clear of a short list; the last resort sits just above your head.
 * `mid` is the push's control point: above and just behind the head, so your head slides out of the
 * bottom of the frame before the lens drops into your eyes (no pop, no clip).
 */
export function otsPose(head: THREE.Vector3, yaw: number): { pos: THREE.Vector3; look: THREE.Vector3; mid: THREE.Vector3 } {
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  const look = head.clone().addScaledVector(fwd, 14).setY(head.y - 0.12);
  const mid = head.clone().setY(head.y + 1.8);
  let best: { pos: THREE.Vector3; look: THREE.Vector3; mid: THREE.Vector3; score: number } | null = null;
  for (const [back, up, side] of [
    // your head and shoulder on the lower-left (or right) third, the lane open past them
    [1.7, 0.3, 0.6],
    [1.7, 0.3, -0.6],
    [1.3, 0.32, 0.5],
    [1.3, 0.32, -0.5],
    [0.9, 0.42, 0.32],
    [0.9, 0.42, -0.32],
  ] as const) {
    const pos = head.clone().addScaledVector(fwd, -back).addScaledVector(right, side).setY(head.y + up);
    if (!(air(pos, 0.25) && seg(pos, mid) && seg(pos, look))) continue;
    // nothing standing in the frame's edges (a porch post a metre off the lens): side rays must run free
    let free = 0;
    const d = new THREE.Vector3();
    const yaw0 = Math.atan2(look.x - pos.x, look.z - pos.z);
    for (const off of [-0.5, -0.25, 0.25, 0.5]) {
      d.set(Math.sin(yaw0 + off), -0.04, Math.cos(yaw0 + off)).normalize();
      free += Math.min(6, rayDist(pos, d, 6));
    }
    const score = free - (back < 1.5 ? 1.5 : 0);
    if (!best || score > best.score) best = { pos, look, mid, score };
  }
  if (best) return { pos: best.pos, look, mid };
  return { pos: head.clone().addScaledVector(fwd, -0.45).setY(head.y + 0.45), look, mid };
}

/**
 * THE ORBIT / OVER-THE-SHOULDER FINISHER. Scores start angles around a body by
 * how much of it stays visible (head, chest, feet) through the whole sweep,
 * how open the frame behind it is, and whether the camera keeps `airR` m of
 * air; prefers a three-quarter FRONT start. Returns null when nowhere works.
 */
export type OrbitPlan = { a0: number; sweep: number; r: number; h: number; kind: "orbit" | "shoulder"; score: number; victim: boolean; faces: number; yaw: number };

/** The finisher's camera travel (planned AND flown with these): the radius pushes in by PUSH_R, the height drops by DROP_H. */
export const FIN_PUSH_R = 0.6;
export const FIN_DROP_H = 0.15;
/** camera height over the shooter's feet at the finisher's start: a touch over the eyes, so a head bowed to the sights still shows its face */
export const FIN_H = 1.72;

/**
 * THE FINISHER: front three-quarter on the shooter, the face and the gun in
 * frame and turned to the lens (the camera stays 0.45–1.25 rad off the aim:
 * never down the barrel, never the back of the head), sweeping 0.8 rad with a
 * push-in so it MOVES, the last victim (death pose) beyond the shooter where a
 * line can be had. Every sample on the path is air-checked and sees the face.
 */
export function planFinisher(x: number, y: number, z: number, yaw: number, victims: THREE.Vector3[] = []): OrbitPlan | null {
  // roomy first; a corridor (Dust2's tunnels) gets a tighter orbit with less air rather than no finisher
  return planFinisherAt(x, y, z, yaw, victims, 0.7, [3.4, 2.9, 2.5]) ?? planFinisherAt(x, y, z, yaw, victims, 0.42, [2.3, 1.9]);
}

function planFinisherAt(x: number, y: number, z: number, yaw: number, victims: THREE.Vector3[], airR: number, radii: number[]): OrbitPlan | null {
  const centre = new THREE.Vector3(x, y + 1.25, z);
  const face = new THREE.Vector3(x + Math.sin(yaw) * 0.25, y + 1.6, z + Math.cos(yaw) * 0.25);
  const muzzle = new THREE.Vector3(x + Math.sin(yaw) * 0.9, y + 1.35, z + Math.cos(yaw) * 0.9);
  const v = victims[victims.length - 1] ?? null;
  let best: OrbitPlan | null = null;
  for (const sweepAbs of [0.8, 0.5]) {
    for (const r of radii) {
      for (const side of [1, -1]) {
        for (const start of [1.24, 0.46, 1.05, 0.62, 0.94]) {
          // inner starts sweep outward, outer starts sweep in toward the face
          const dir = start > 0.7 ? -1 : 1;
          const a0 = yaw + side * start;
          const sweep = side * dir * sweepAbs;
          let ok = true;
          let faces = 0;
          let vic = 0;
          let open = 0;
          for (let k = 0; k <= 5 && ok; k++) {
            const u = k / 5;
            const a = a0 + sweep * u;
            const rel = Math.abs(Math.atan2(Math.sin(a - yaw), Math.cos(a - yaw)));
            // the support-arm side (+1, the shooter's left) closes over the face past ~0.95 rad
            if (rel < 0.44 || rel > (side > 0 ? 0.96 : 1.26)) { ok = false; break; }
            const p = new THREE.Vector3(x + Math.sin(a) * (r - FIN_PUSH_R * u), y + FIN_H - FIN_DROP_H * u, z + Math.cos(a) * (r - FIN_PUSH_R * u));
            if (!air(p, airR) || !seg(p, face) || !seg(p, centre)) { ok = false; break; }
            const toFace = face.clone().sub(p);
            const toGun = muzzle.clone().sub(p);
            if (toFace.angleTo(toGun) < 0.14 && toGun.length() < toFace.length()) { ok = false; break; }
            faces += Math.cos(rel) > 0.35 ? 1 : 0;
            if (v && seg(p, v) && toFace.angleTo(v.clone().sub(p)) < 0.5) vic++;
            if (k === 3) open = openFrame(p, centre, 44);
          }
          if (!ok) continue;
          // side -1 is the shooter's right (the gun side): the support arm never crosses the face
          const score = faces * 12 + vic * 9 + open * 20 + r * 2 - (sweepAbs < 0.8 ? 8 : 0) + (side < 0 ? 12 : 0);
          if (!best || score > best.score) best = { a0, sweep, r, h: FIN_H, kind: "orbit", score, victim: vic >= 3, faces, yaw };
        }
      }
    }
    if (best) break;
  }
  return best;
}

/**
 * THE SQUAD SHOT + THE SWOOP, planned together, on where your team actually
 * stands this match. The camera rides BEHIND you and your squad, looking down
 * the landing line (the way you will face at GO), so:
 *   - the frame holds you and as many squadmates as it can see (≥ 3 bodies is
 *     the target; candidates: 4 distances × 4 heights × 5 offsets × 3 swivels,
 *     scored by bodies in frame with a clear line, you in frame required);
 *   - the pitch is shallow (the look point is 14 m down the lane);
 *   - the shot's last pose IS the swoop's first, and the swoop's whole curve
 *     (shot end → over the shoulder → your eyes) is clearance-checked before a
 *     candidate is accepted. No cut, no flash.
 */
export type SquadMember = { id: string; name: string; x: number; y: number; z: number; yaw: number; you: boolean };
export type SquadPlan = {
  shot: import("./shots").Shot;
  framed: SquadMember[];
  /** bodies (you included) in frame with a clear line at the shot's start */
  seen: number;
  swoopA: THREE.Vector3;
  swoopC: THREE.Vector3;
  startPitch: number;
};

export function bez3(a: THREE.Vector3, c: THREE.Vector3, e: THREE.Vector3, u: number, out = new THREE.Vector3()): THREE.Vector3 {
  const k = 1 - u;
  return out.set(k * k * a.x + 2 * k * u * c.x + u * u * e.x, k * k * a.y + 2 * k * u * c.y + u * u * e.y, k * k * a.z + 2 * k * u * c.z + u * u * e.z);
}

/** The over-the-shoulder approach point and a clearance-checked curve into the eye. */
export function swoopVia(eye: THREE.Vector3, yaw: number, from: THREE.Vector3): THREE.Vector3 | null {
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  for (const [b, sd, h] of [
    [2.4, 0.4, 0.6],
    [2.4, -0.4, 0.6],
    [1.5, 0.35, 0.45],
    [1.5, -0.35, 0.45],
    [1.1, 0, 0.6],
    [0.6, 0, 0.9],
    [2.2, 0.3, 1.8],
    [1.2, 0, 2.4],
    [0.4, 0, 2.8],
  ] as const) {
    const c = eye.clone().addScaledVector(fwd, -b).addScaledVector(side, sd).addScaledVector(new THREE.Vector3(0, 1, 0), h);
    if (!air(c, 0.3) || !seg(c, eye)) continue;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) pts.push(bez3(from, c, eye, i / 16));
    if (pathClear(pts, 2)) return c;
  }
  return null;
}

/** QA: why the last squad plan came out as it did. */
export const squadStats = { members: 0, allies: 0, tried: 0, air: 0, inFrame: 0, cands: 0, endFail: 0, viaFail: 0, picked: -1 };

export function squadPlan(members: SquadMember[], landing: number, vfov = 38, aspect = 16 / 9): SquadPlan | null {
  const me = members.find((m) => m.you);
  Object.assign(squadStats, { members: members.length, allies: 0, tried: 0, air: 0, inFrame: 0, cands: 0, endFail: 0, viaFail: 0, picked: -1 });
  if (!me) return null;
  const eye = new THREE.Vector3(me.x, me.y + 1.62, me.z);
  const fwd = new THREE.Vector3(Math.sin(landing), 0, Math.cos(landing));
  const UPV = new THREE.Vector3(0, 1, 0);
  const allies = members.filter((m) => !m.you && Math.hypot(m.x - me.x, m.z - me.z) <= 35);
  const cam = new THREE.PerspectiveCamera(vfov, aspect, 0.1, 400);
  const inFrame = (p: THREE.Vector3): boolean => {
    const v = p.clone().project(cam);
    return v.z < 1 && Math.abs(v.x) < 0.88 && v.y > -0.7 && v.y < 0.66;
  };
  type Cand = { pos: THREE.Vector3; look: THREE.Vector3; seen: number; framed: SquadMember[]; score: number };
  const cands: Cand[] = [];
  for (const swivel of [0, 0.5, -0.5]) {
    const back = fwd.clone().applyAxisAngle(UPV, swivel);
    const side = new THREE.Vector3(back.z, 0, -back.x);
    for (const b of [3.2, 5.2, 7.6, 11]) {
      for (const h of [1.1, 2.6, 4.6, 7.5]) {
        for (const sd of [0, 1.6, -1.6]) {
          const pos = eye.clone().addScaledVector(back, -b).addScaledVector(side, sd).addScaledVector(UPV, h);
          squadStats.tried++;
          if (!air(pos, 0.6) || !seg(pos, eye)) continue;
          squadStats.air++;
          // you in the lower third, the lane ahead above you
          const look = eye.clone().addScaledVector(fwd, 7).addScaledVector(UPV, -0.6);
          cam.position.copy(pos);
          cam.lookAt(look);
          cam.updateMatrixWorld();
          if (!inFrame(eye.clone().addScaledVector(UPV, -0.4))) continue;
          squadStats.inFrame++;
          const framed: SquadMember[] = [me];
          for (const a of allies) {
            const chest = new THREE.Vector3(a.x, a.y + 1.2, a.z);
            if (pos.distanceTo(chest) > 30 || !inFrame(chest) || !seg(pos, chest)) continue;
            framed.push(a);
          }
          const pitch = Math.atan2(look.y - pos.y, Math.hypot(look.x - pos.x, look.z - pos.z));
          const score = Math.min(framed.length, 5) * 25 - h * 2.2 - b * 1.2 - Math.abs(sd) * 1.5 - Math.abs(swivel) * 6 + (pitch < -0.45 ? -40 : 0) + openFrame(pos, look, vfov) * 10;
          cands.push({ pos, look, seen: framed.length, framed, score });
        }
      }
    }
  }
  cands.sort((x, y) => y.score - x.score);
  squadStats.cands = cands.length;
  (squadStats as Record<string, number>).maxSeen = cands.reduce((m, c) => Math.max(m, c.seen), 0);
  (squadStats as Record<string, unknown>).top = cands.slice(0, 3).map((c) => [c.seen, +c.pos.y.toFixed(1), +c.score.toFixed(0)]) as never;
  squadStats.allies = allies.length;
  for (const c of cands.slice(0, 24)) {
    // the dolly: a third of the way toward the shoulder, and the swoop must fly clean from there
    const shoulder = eye.clone().addScaledVector(fwd, -2.4).addScaledVector(UPV, 0.8);
    const end = c.pos.clone().lerp(shoulder, 0.35);
    if (!air(end, 0.5) || !seg(c.pos, end)) {
      squadStats.endFail++;
      continue;
    }
    const via = swoopVia(eye, landing, end);
    if (!via) {
      squadStats.viaFail++;
      continue;
    }
    squadStats.picked = c.seen;
    const pitch = Math.atan2(c.look.y - end.y, Math.hypot(c.look.x - end.x, c.look.z - end.z));
    return {
      shot: {
        name: "squad",
        dur: 2.4,
        pos: [
          [c.pos.x, c.pos.y, c.pos.z],
          [end.x, end.y, end.z],
        ],
        look: [
          [c.look.x, c.look.y, c.look.z],
          [c.look.x, c.look.y + 0.2, c.look.z],
        ],
        fov: [vfov, vfov - 2],
        ease: "inout",
        shake: 0.3,
        focus: c.pos.distanceTo(eye),
        aperture: 1.8,
      },
      framed: c.framed,
      seen: c.seen,
      swoopA: end,
      swoopC: via,
      startPitch: pitch,
    };
  }
  return null;
}

/**
 * THE SQUAD WHERE IT STANDS. Spawns are spread (shared/sim.ts spawn scoring),
 * so your squad is often 15–30 m from you. This frames the biggest group of
 * your squadmates (≥ 2 bodies, 3/4 front, cowboy framing in the safe area) and
 * plans a single flight from that shot's last pose to your eyes:
 * shot end → high over the roofs between → over your shoulder → the eye,
 * every segment clearance-checked. Null when no group or no clean flight.
 */
export type GroupPlan = SquadPlan & { via: THREE.Vector3[] };

export const groupStats = { group: 0, cands: 0, noC: 0, flightFail: 0, ok: false };
export function squadGroupPlan(members: SquadMember[], landing: number, vfov = 36, aspect = 16 / 9): GroupPlan | null {
  Object.assign(groupStats, { group: 0, cands: 0, noC: 0, flightFail: 0, ok: false });
  const me = members.find((m) => m.you);
  if (!me) return null;
  const UPV = new THREE.Vector3(0, 1, 0);
  const eye = new THREE.Vector3(me.x, me.y + 1.62, me.z);
  const allies = members.filter((m) => !m.you && Math.hypot(m.x - me.x, m.z - me.z) <= 40);
  // the biggest cluster (10 m)
  let group: SquadMember[] = [];
  for (const a of allies) {
    const near = allies.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) <= 10);
    if (near.length > group.length) group = near;
  }
  groupStats.group = group.length;
  if (group.length < 2) return null;
  group = group.slice(0, 5);
  if (Math.hypot(me.x - group[0]!.x, me.z - group[0]!.z) <= 10) group.push(me);
  const cx = group.reduce((a, m) => a + m.x, 0) / group.length;
  const cz = group.reduce((a, m) => a + m.z, 0) / group.length;
  const cy = group.reduce((a, m) => a + m.y, 0) / group.length;
  let fx = group.reduce((a, m) => a + Math.sin(m.yaw), 0);
  let fz = group.reduce((a, m) => a + Math.cos(m.yaw), 0);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  const facing = Math.atan2(fx, fz);
  const hfov = 2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect);
  const cam = new THREE.PerspectiveCamera(vfov, aspect, 0.1, 400);
  type C = { p0: THREE.Vector3; p1: THREE.Vector3; look: THREE.Vector3; seen: number; framed: SquadMember[]; score: number };
  const cands: C[] = [];
  for (let i = 0; i < 12; i++) {
    const az = facing + (i / 12) * Math.PI * 2;
    const dx = Math.sin(az);
    const dz = Math.cos(az);
    const lx = dz;
    const lz = -dx;
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of group) {
      const sl = (m.x - cx) * lx + (m.z - cz) * lz;
      lo = Math.min(lo, sl);
      hi = Math.max(hi, sl);
    }
    const width = Math.max(1.6, hi - lo);
    for (const [dk, hh] of [[1, 1.7], [0.8, 1.7], [1, 3.4], [1.25, 3.4]] as const) {
    const d = Math.max(4, Math.min(12, ((width / 2 + 1.2) / Math.tan(hfov / 2)) * dk));
    const travel = Math.min(3.5, width * 0.35 + 1);
    const p0 = new THREE.Vector3(cx + dx * d - lx * travel * 0.5, cy + hh, cz + dz * d - lz * travel * 0.5);
    const p1 = new THREE.Vector3(cx + dx * (d - 0.8) + lx * travel * 0.5, cy + hh + 0.2, cz + dz * (d - 0.8) + lz * travel * 0.5);
    if (!air(p0, 0.4) || !air(p1, 0.4) || !seg(p0, p1)) continue;
    // heads in the safe area: aim at chest-high, a touch above
    const look = new THREE.Vector3(cx, cy + 1.35, cz);
    cam.position.copy(p0);
    cam.lookAt(look);
    cam.updateMatrixWorld();
    const framed: SquadMember[] = [];
    let hidden = 0;
    for (const m of group) {
      const headP = new THREE.Vector3(m.x, m.y + 1.75, m.z);
      const v = headP.clone().project(cam);
      const feet = new THREE.Vector3(m.x, m.y + 0.3, m.z).project(cam);
      if (v.z < 1 && Math.abs(v.x) < 0.9 && v.y < 0.66 && feet.y > -0.95 && seg(p0, headP) && seg(p1, headP)) {
        framed.push(m);
        if (!seg(p0, new THREE.Vector3(m.x, m.y + 0.5, m.z))) hidden++;
      }
    }
    if (framed.length < 2) continue;
    const b = MAP.bounds;
    const inside = p0.x > b.minX && p0.x < b.maxX && p0.z > b.minZ && p0.z < b.maxZ;
    const score = framed.length * 20 - hidden * 9 + Math.cos(az - facing) * 12 + openFrame(p0, look, vfov) * 8 - d * 0.5 - (hh > 2 ? 4 : 0) - (inside ? 0 : 30);
    cands.push({ p0, p1, look, seen: framed.length, framed, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  groupStats.cands = cands.length;
  for (const c of cands.slice(0, 6)) {
    // the flight: shot end → up over whatever is between → over your shoulder → your eye
    const fwdL = new THREE.Vector3(Math.sin(landing), 0, Math.cos(landing));
    const sideL = new THREE.Vector3(fwdL.z, 0, -fwdL.x);
    const Cs = ([
      [3.2, 0.4, 1.1],
      [3.2, -0.4, 1.1],
      [2.4, 0.4, 0.6],
      [2.4, -0.4, 0.6],
      [1.5, 0.35, 0.5],
      [1.5, -0.35, 0.5],
      [1.0, 0, 0.8],
      [2.2, 0.3, 1.8],
      [0.5, 0, 2.2],
    ] as const)
      .map(([b, sd, h]) => eye.clone().addScaledVector(fwdL, -b).addScaledVector(sideL, sd).addScaledVector(UPV, h))
      .filter((c) => air(c, 0.3) && seg(c, eye));
    if (!Cs.length) {
      groupStats.noC++;
      continue;
    }
    for (const C of Cs)
    for (const lift of [10, 13, 7, 16, 4]) {
      const mid = c.p1.clone().lerp(C, 0.5);
      const V = mid.setY(Math.max(c.p1.y, C.y) + lift);
      if (!air(V, 0.5)) continue;
      const curve = new THREE.CatmullRomCurve3([c.p1, V, C, eye], false, "centripetal");
      const pts = curve.getSpacedPoints(32);
      if (!pathClear(pts, 3) || !pts.slice(0, -6).every((p) => p.distanceTo(eye) > 1.2)) {
        groupStats.flightFail++;
        continue;
      }
      groupStats.ok = true;
      return {
        shot: {
          name: "squad",
          dur: 2.4,
          pos: [
            [c.p0.x, c.p0.y, c.p0.z],
            [c.p1.x, c.p1.y, c.p1.z],
          ],
          look: [
            [c.look.x, c.look.y, c.look.z],
            [c.look.x, c.look.y + 0.1, c.look.z],
          ],
          fov: [vfov, vfov - 2],
          ease: "inout",
          shake: 0.3,
          focus: c.p0.distanceTo(c.look),
          aperture: 2.2,
        },
        framed: c.framed,
        seen: c.seen,
        swoopA: c.p1.clone(),
        swoopC: C,
        startPitch: Math.atan2(c.look.y - c.p1.y, Math.hypot(c.look.x - c.p1.x, c.look.z - c.p1.z)),
        via: [V, C],
      };
    }
  }
  return null;
}

/**
 * THE HERO ORBIT — the intro's last beat, one continuous move built around YOU.
 *
 *   p 0.00 → 0.25   the hero / squad shot: front three-quarter on your face (and
 *                   any squadmates within 8 m you can see), low, drifting round
 *   p 0.25 → 0.75   the fast move: round the shoulder to above-and-behind you,
 *                   the look sliding from you to the lane ahead, so your own
 *                   body leaves the frame by the bottom instead of popping
 *   p 0.75 → 1.00   down into your eyes, looking down your lane
 *
 * Every sample of the path is clearance-checked (both sides and several
 * radii are tried); `framed` are the bodies in the opening frame.
 */
export type HeroPlan = {
  head: THREE.Vector3;
  yaw: number;
  side: number;
  off0: number;
  r0: number;
  h0: number;
  focus: THREE.Vector3;
  framed: SquadMember[];
  faces: number;
  /** the orbit (p 0 → 0.75): front three-quarter → round the side (or over the top) → above-behind */
  curve: THREE.CatmullRomCurve3;
};

function heroCurve(head: THREE.Vector3, yaw: number, side: number, off0: number, r0: number, h0: number, over: boolean, hEnd = 1.2, rEnd = 1.55): THREE.CatmullRomCurve3 {
  const at = (a: number, r: number, h: number): THREE.Vector3 => new THREE.Vector3(head.x + Math.sin(a) * r, head.y + h, head.z + Math.cos(a) * r);
  const a0 = yaw + side * off0;
  const aMid = yaw + side * (Math.PI / 2 + 0.25);
  const aEnd = yaw + Math.PI - side * 0.28;
  const pts = over
    ? [at(a0, r0, h0), at(a0, r0 * 0.55, h0 + Math.min(1.6, hEnd + 0.5)), head.clone().add(new THREE.Vector3(0, hEnd + 0.4, 0)), at(aEnd, rEnd, hEnd)]
    : [at(a0, r0, h0), at(aMid, (r0 + rEnd) / 2 + 0.2, (h0 + hEnd) / 2 + 0.2), at(aEnd, rEnd, hEnd)];
  return new THREE.CatmullRomCurve3(pts, false, "centripetal");
}

export function heroAt(pl: HeroPlan, p: number, out = new THREE.Vector3()): THREE.Vector3 {
  if (p <= 0.75) {
    const u = p / 0.75;
    return out.copy(pl.curve.getPointAt(u * u * (3 - 2 * u)));
  }
  const P = pl.curve.getPointAt(1);
  const u = (p - 0.75) / 0.25;
  const e = u * u * (3 - 2 * u);
  return out.copy(P).lerp(pl.head, e);
}

export const heroStats = { tried: 0, air: 0, path: 0, framed: 0, mates: 0 };
export function heroPlan(members: SquadMember[], landing: number, vfov = 38, aspect = 16 / 9): HeroPlan | null {
  Object.assign(heroStats, { tried: 0, air: 0, path: 0, framed: 0, mates: 0 });
  const me = members.find((m) => m.you);
  if (!me) return null;
  const head = new THREE.Vector3(me.x, me.y + 1.62, me.z);
  const mates = members
    .filter((m) => !m.you && Math.hypot(m.x - me.x, m.z - me.z) <= 8 && seg(head, new THREE.Vector3(m.x, m.y + 1.6, m.z)))
    .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))
    .slice(0, 3);
  const group = [me, ...mates];
  const cam = new THREE.PerspectiveCamera(vfov, aspect, 0.1, 400);
  let best: (HeroPlan & { score: number }) | null = null;
  const hfov = 2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect);
  // a back to a wall (a spawn against a house): the end closes in over the head, tried only after the roomy ends
  for (const [over, hEnd, rEnd] of [[false, 1.2, 1.55], [true, 1.2, 1.55], [false, 0.8, 1.55], [true, 0.8, 1.55], [true, 1.3, 0.8], [false, 1.3, 0.8], [true, 1.4, 0.4]] as const) {
  for (const side of [1, -1]) {
    for (const off0 of [0.7, 0.5, 0.95, 0.3, 0]) {
      // the group's width across this view, to fit it
      const a0 = landing + side * off0;
      const lx = Math.cos(a0);
      const lz = -Math.sin(a0);
      let lo = 0;
      let hi = 0;
      for (const m of group) {
        const sl = (m.x - me.x) * lx + (m.z - me.z) * lz;
        lo = Math.min(lo, sl);
        hi = Math.max(hi, sl);
      }
      const fit = ((hi - lo) / 2 + 1.0) / Math.tan(hfov / 2);
      for (const r0 of [Math.max(3.2, Math.min(7, fit)), 3.2, 4.4, 2.5]) {
        for (const h0 of [0.05, 0.4, 0.9]) {
          const pl: HeroPlan = { head, yaw: landing, side, off0, r0, h0, focus: head.clone(), framed: [], faces: 0, curve: heroCurve(head, landing, side, off0, r0, h0, over, hEnd, rEnd) };
          // the whole path, sampled
          // only the hero shot itself (p 0 → 0.25) is flown now: the landing is a cut to the over-the-shoulder
          const pts: THREE.Vector3[] = [];
          for (let i = 0; i <= 12; i++) pts.push(heroAt(pl, (i / 12) * 0.25));
          heroStats.tried++;
          // you face the lens (never the back of your head)
          {
            const toCam = Math.atan2(pts[0]!.x - me.x, pts[0]!.z - me.z);
            if (Math.cos(toCam - landing) < 0.5) continue;
          }
          if (!pts.every((p) => air(p, 0.3))) continue;
          heroStats.air++;
          if (!pathClear(pts, 2)) continue;
          heroStats.path++;
          // the opening frame: you + whoever it holds, faces toward the lens
          const p0 = pts[0]!;
          const centre = group.reduce((acc, m) => acc.add(new THREE.Vector3(m.x, m.y + 1.45, m.z)), new THREE.Vector3()).divideScalar(group.length);
          // lead room: the look sits a little toward the lane, so you are a third in
          const look = centre.clone().addScaledVector(new THREE.Vector3(Math.sin(landing), 0, Math.cos(landing)), 0.5).setY(centre.y - 0.3);
          cam.position.copy(p0);
          cam.lookAt(look);
          cam.updateMatrixWorld();
          const framed: SquadMember[] = [];
          let faces = 0;
          for (const m of group) {
            const hp = new THREE.Vector3(m.x, m.y + 1.7, m.z);
            const v = hp.clone().project(cam);
            const fp = new THREE.Vector3(m.x, m.y + 0.4, m.z).project(cam);
            if (v.z > 1 || Math.abs(v.x) > 0.72 || v.y > 0.66 || fp.y < -0.8 || !seg(p0, hp)) continue;
            framed.push(m);
            const my = m.you ? landing : m.yaw;
            const toCam = Math.atan2(p0.x - m.x, p0.z - m.z);
            if (Math.cos(toCam - my) > 0.2) faces++;
          }
          if (!framed.some((m) => m.you)) continue;
          heroStats.framed++;
          const score = framed.length * 20 + faces * 10 + openFrame(p0, look, vfov) * 10 - Math.abs(off0 - 0.7) * 6 - r0 - (over ? 8 : 0) - h0 * 14;
          if (!best || score > best.score) best = { ...pl, focus: look, framed, faces, score };
        }
      }
    }
  }
    if (best) break;
  }
  return best;
}

// ======================================================================= round 6: THE HERO SHOT

/** A body's height for framing (m, feet to crown). */
export const HERO_BODY_M = 1.85;
/** The hero shot's lens (vertical FOV, deg) and the share of the frame you stand (start → end of the arc). */
export const HERO_FOV = 34;
export const HERO_FRAC: [number, number] = [0.61, 0.68];
/** The arc round you over the hero shot (rad). */
export const HERO_ARC = 0.36;

export type HeroShot = {
  /** your feet, your eyes */
  base: THREE.Vector3;
  eye: THREE.Vector3;
  /** camera azimuth round you at the start (rad, atan2(dx, dz) from you to the lens) and the arc's sign */
  az0: number;
  dir: 1 | -1;
  /** camera distance and height (above your feet) at the start and the end */
  d0: number;
  d1: number;
  h0: number;
  h1: number;
  /** the lens (vertical FOV, deg): wider when the camera has to stand closer, so you stay 61-68% of the frame */
  fov: number;
  /** your body's yaw for the shot (three-quarter to the lens, facing frame-left), the head turn to the lens */
  bodyYaw: number;
  look: number;
  /** QA: worst share of your body hidden over the arc, depth behind you, squadmates in frame */
  occluded: number;
  depth: number;
  score: number;
  tried: number;
};

/** The points of a standing body the occlusion test looks for (relative to the feet; lateral is to the lens's right). */
const BODY_PTS: [number, number][] = [
  [0, 1.72],
  [0, 1.5],
  [-0.32, 1.32],
  [0.32, 1.32],
  [-0.55, 1.1],
  [0.55, 1.1],
  [0, 1.12],
  [0, 0.86],
  [-0.14, 0.5],
  [0.14, 0.5],
  [-0.14, 0.12],
  [0.14, 0.12],
];

/** Distance from point p to the segment a-b (3D). */
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(p, a).dot(ab) / Math.max(1e-9, ab.lengthSq())));
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

/** Share (0..1) of a body's points hidden from `cam` — by colliders, or by another body's capsule. */
export function bodyOccluded(cam: THREE.Vector3, base: THREE.Vector3, others: { x: number; y: number; z: number }[]): number {
  const to = new THREE.Vector3(base.x - cam.x, 0, base.z - cam.z).normalize();
  const right = new THREE.Vector3(-to.z, 0, to.x);
  let hid = 0;
  for (const [lat, h] of BODY_PTS) {
    const p = base.clone().addScaledVector(right, lat).setY(base.y + h);
    let blocked = !seg(cam, p);
    if (!blocked) {
      for (const o of others) {
        // a capsule (r 0.42) from the feet to the crown of the other body, sampled along the sight line
        for (let k = 1; k < 8 && !blocked; k++) {
          const q = cam.clone().lerp(p, k / 8);
          if (q.y < o.y - 0.1 || q.y > o.y + 1.9) continue;
          if (Math.hypot(q.x - o.x, q.z - o.z) < 0.42) blocked = true;
        }
      }
    }
    if (blocked) hid++;
  }
  return hid / BODY_PTS.length;
}

/** The camera of a hero shot at progress u (0..1 of the arc). */
export function heroShotCam(s: HeroShot, u: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = u * u * (3 - 2 * u);
  const az = s.az0 + s.dir * HERO_ARC * e;
  const d = s.d0 + (s.d1 - s.d0) * e;
  const h = s.h0 + (s.h1 - s.h0) * e;
  return out.set(s.base.x + Math.sin(az) * d, s.base.y + h, s.base.z + Math.cos(az) * d);
}

export const heroShotStats = { tried: 0, air: 0, occl: 0, near: 0, ok: 0 };

/**
 * THE HERO SHOT round YOU: a low three-quarter on a real 20° arc with a slow push, you 61 → 68% of the
 * frame tall (feet in), every sample of the arc in clear air, and NO PLAN where more than 20% of your
 * body is covered (colliders or another body) anywhere on the arc. Prefers depth behind you (a lane or
 * the sky, not a wall at your back) and an open frame. Null when no azimuth works.
 */
export function heroShot(me: { x: number; y: number; z: number }, others: { x: number; y: number; z: number }[], aspect = 16 / 9): HeroShot | null {
  Object.assign(heroShotStats, { tried: 0, air: 0, occl: 0, near: 0, ok: 0 });
  const base = new THREE.Vector3(me.x, me.y, me.z);
  const eye = new THREE.Vector3(me.x, me.y + 1.62, me.z);
  const t = Math.tan((HERO_FOV * Math.PI) / 360);
  const dAt = (frac: number): number => HERO_BODY_M / (2 * frac * t);
  const near = others.filter((o) => Math.hypot(o.x - me.x, o.z - me.z) < 12);
  let best: HeroShot | null = null;
  const cam = new THREE.Vector3();
  for (let i = 0; i < 32; i++) {
    const az0 = (i / 32) * Math.PI * 2;
    for (const dir of [1, -1] as const) {
      // the roomy lens first; where the camera has to stand closer, a wider lens keeps you the same size
      // two lens heights: low (a heroic up-angle) and chest-high (over a roof edge or a low wall in front)
      for (const [h0, h1] of [[0.78, 1.08], [1.35, 1.6]] as const)
      for (const shrink of [1, 0.85, 0.72]) {
        heroShotStats.tried++;
        const fov = (2 * Math.atan(t / shrink) * 180) / Math.PI;
        const s: HeroShot = { base, eye, az0, dir, d0: dAt(HERO_FRAC[0]) * shrink, d1: dAt(HERO_FRAC[1]) * shrink, h0, h1, fov, bodyYaw: 0, look: 0, occluded: 0, depth: 0, score: 0, tried: 0 };
        let ok = true;
        let occ = 0;
        for (let k = 0; k <= 6 && ok; k++) {
          heroShotCam(s, k / 6, cam);
          if (!air(cam, 0.45)) ok = false;
          else if (others.some((o) => Math.hypot(o.x - cam.x, o.z - cam.z) < 1.3 && cam.y > o.y - 0.3 && cam.y < o.y + 2.1)) {
            heroShotStats.near++;
            ok = false;
          } else occ = Math.max(occ, bodyOccluded(cam, base, near));
        }
        if (!ok) continue;
        heroShotStats.air++;
        if (occ > 0.2) {
          heroShotStats.occl++;
          continue;
        }
        heroShotStats.ok++;
        // depth behind you along the lens's line (beyond you, at chest height) and the frame's openness
        heroShotCam(s, 0.5, cam);
        const through = new THREE.Vector3(base.x - cam.x, 0, base.z - cam.z).normalize();
        const depth = rayDist(new THREE.Vector3(me.x, me.y + 1.2, me.z).addScaledVector(through, 0.6), through, 40);
        // the frame as composed (you on the right third): how open it is, whether the lens is under a roof
        // while you stand in the open (a camera inside a shed looking out of its door), a wall at the lens
        const sub = new THREE.Vector3(me.x, me.y + 0.95, me.z);
        const toS = new THREE.Vector3(sub.x - cam.x, 0, sub.z - cam.z);
        const dS = toS.length();
        toS.normalize();
        const hf = 2 * Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
        const look = sub.clone().addScaledVector(new THREE.Vector3(-toS.z, 0, toS.x), -Math.tan(hf / 2) * dS * 0.34);
        const open = openFrame(cam, look, fov, aspect, 14);
        const up = new THREE.Vector3(0, 1, 0);
        const roofCam = rayDist(cam, up, 25) < 8;
        const roofMe = rayDist(new THREE.Vector3(me.x, me.y + 1.8, me.z), up, 25) < 8;
        let wall = 99;
        for (let k = 0; k < 8; k++) wall = Math.min(wall, rayDist(cam, new THREE.Vector3(Math.sin((k / 8) * Math.PI * 2), 0, Math.cos((k / 8) * Math.PI * 2)), 4));
        // the LEFT of the frame (where the 3-2-1 stands): a slab of roof or wall within 4 m there is dead frame
        const fwd = look.clone().sub(cam).normalize();
        const rgt = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        const upv = new THREE.Vector3().crossVectors(rgt, fwd).normalize();
        const tv = Math.tan((fov * Math.PI) / 360);
        let slab = 0;
        for (const sx of [-0.85, -0.55, -0.25])
          for (const sy of [-0.7, -0.35, 0, 0.35]) {
            const d = fwd.clone().addScaledVector(rgt, sx * tv * aspect).addScaledVector(upv, sy * tv).normalize();
            if (rayDist(cam, d, 4) < 3.9) slab++;
          }
        s.occluded = occ;
        s.depth = depth;
        s.score = Math.min(depth, 30) * 1.0 + open * 30 - occ * 60 + (shrink === 1 ? 6 : shrink > 0.8 ? 2 : 0) - (roofCam && !roofMe ? 30 : 0) - (wall < 1.0 ? 12 : 0) - slab * 2.5 - (h0 > 1 ? 3 : 0);
        if (!best || s.score > best.score) best = s;
      }
    }
  }
  if (!best) return null;
  // you turn three-quarter to the lens (the middle of the arc), facing frame-left into the lead room; your head turns to the lens
  const azMid = best.az0 + best.dir * HERO_ARC * 0.5;
  best.bodyYaw = azMid - 0.95;
  best.look = 0.55;
  best.tried = heroShotStats.tried;
  return best;
}
