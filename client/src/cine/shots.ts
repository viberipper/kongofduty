/**
 * client/src/cine/shots.ts — THE INTRO'S SHOTS ARE DATA, PER MAP.
 * ===========================================================================
 *
 * public/assets/cine/<map id>.json holds the authored reel for that map:
 *
 *   {
 *     "map": "nuketown",
 *     "eyebrow": "SUBURBAN TEST SITE · 1962",      // micro line over the title
 *     "title": "NUKETOWN",                          // optional; default MAP.name
 *     "brand": { "style": "katana", "wordmark": "›katana" },   // optional
 *     "shots": [
 *       {
 *         "name": "cul-de-sac crane",               // free text, for the author
 *         "dur": 2.2,                               // seconds (relative: the reel is fitted to the countdown)
 *         "pos":  [[x,y,z], [x,y,z], ...],          // camera path, Catmull-Rom through the points
 *         "look": [[x,y,z], ...],                   // look-at path (1 point = locked target)
 *         "fov":  [44, 38],                         // vertical fov, start -> end
 *         "roll": [0, -2],                          // degrees, start -> end (optional)
 *         "ease": "inout" | "in" | "out" | "linear",
 *         "shake": 0.35,                            // handheld, degrees (optional, default 0.3)
 *         "focus": 18,                              // DOF focus distance m (optional: auto = look target)
 *         "aperture": 4                             // DOF strength, 0 = sharp (optional, default 4)
 *       },
 *       { "squad": true, "dur": 2.4 }               // your team at spawn, framed live (see Shot.squad)
 *       }
 *     ]
 *   }
 *
 * Coordinates are world metres, the same frame as shared/maps (y up). Author
 * with `__cine.pose()` in the browser console (prints the current camera as a
 * keyframe) and `__cine.play()` / `__cine.preview(i, u)` to watch the result.
 *
 * A map with no file (or "auto": true) gets a reel GENERATED from its MapDef —
 * bounds, team spawns, objectives and the collider soup — so a brand-new map
 * (katana v3's grey box, before its level designer authors the real reel) has
 * a working intro the day it boots.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/maps";
import { traceWorld, worldToLocal } from "@shared/map";
import { assetUrl } from "../asset-base";
import { air, openFrame } from "./framing";

export type V3 = [number, number, number];
export type ShotEase = "inout" | "in" | "out" | "linear";
export type Shot = {
  name?: string;
  dur: number;
  pos: V3[];
  look: V3[];
  fov?: [number, number];
  roll?: [number, number];
  ease?: ShotEase;
  shake?: number;
  focus?: number;
  /** DOF strength (CoC px at 1080p, 0 = sharp; default 4). */
  aperture?: number;
  /**
   * THE SQUAD SHOT: { "squad": true, "dur": 2.4 } — no pos/look; the camera is
   * framed at intro start on where YOUR team actually spawned this match (a low
   * dolly across them, names called out). Spawns move every match, so this is
   * the one shot that cannot be a fixed keyframe.
   */
  squad?: boolean;
};
export type CineBrand = { style?: "katana" | "default"; wordmark?: string; accent?: string };
export type CineFile = {
  map: string;
  title?: string;
  eyebrow?: string;
  brand?: CineBrand;
  auto?: boolean;
  shots: Shot[];
};

export type CamPose = { pos: THREE.Vector3; look: THREE.Vector3; fov: number; roll: number; focus: number; shot: number; u: number };

// ---------------------------------------------------------------- load

export async function loadCine(map: MapDef): Promise<CineFile> {
  let file: CineFile | null = null;
  try {
    const r = await fetch(assetUrl(`/assets/cine/${map.id}.json`), { cache: "no-cache" });
    if (r.ok) file = (await r.json()) as CineFile;
  } catch {
    file = null;
  }
  const valid = !!file && Array.isArray(file.shots) && file.shots.length > 0 && file.shots.every(okShot);
  if (file && valid && !file.auto) {
    const bad = shotProblems(map, file.shots);
    if (bad.length) console.warn(`[cine] ${map.id}: ` + bad.join("; "));
    return file;
  }
  return { ...(file ?? { map: map.id }), map: map.id, shots: autoShots(map) };
}

function okShot(s: Shot): boolean {
  const v = (p: unknown): boolean => Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n));
  if (s && s.squad) return s.dur > 0;
  return s && s.dur > 0 && Array.isArray(s.pos) && s.pos.length >= 1 && s.pos.every(v) && Array.isArray(s.look) && s.look.length >= 1 && s.look.every(v);
}

// ---------------------------------------------------------------- sample

const easeFn = (e: ShotEase | undefined, u: number): number => {
  if (e === "linear") return u;
  if (e === "in") return u * u * u;
  if (e === "out") return 1 - (1 - u) ** 3;
  // inout: a smootherstep with a long, readable middle (a dolly, not a whip)
  return u * u * u * (u * (u * 6 - 15) + 10);
};

/** Uniform Catmull-Rom through `pts` at s in [0,1], phantom ends mirrored. */
export function pathAt(pts: V3[], s: number, out: THREE.Vector3): THREE.Vector3 {
  const n = pts.length;
  if (n === 0) return out; // an unframed squad entry: hold the last pose
  if (n === 1) return out.set(pts[0]![0], pts[0]![1], pts[0]![2]);
  const f = Math.max(0, Math.min(1, s)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  const p1 = pts[i]!;
  const p2 = pts[i + 1]!;
  const p0 = i > 0 ? pts[i - 1]! : ([2 * p1[0] - p2[0], 2 * p1[1] - p2[1], 2 * p1[2] - p2[2]] as V3);
  const p3 = i + 2 < n ? pts[i + 2]! : ([2 * p2[0] - p1[0], 2 * p2[1] - p1[1], 2 * p2[2] - p1[2]] as V3);
  const t2 = t * t;
  const t3 = t2 * t;
  const c = (k: 0 | 1 | 2): number =>
    0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  return out.set(c(0), c(1), c(2));
}

/** Replace squad entries with the live-framed squad shot (or drop them when there is none). */
export function resolveReel(shots: Shot[], squad: Shot | null): Shot[] {
  const out: Shot[] = [];
  for (const s of shots) {
    if (!s.squad) out.push(s);
    else if (squad) out.push({ ...squad, dur: s.dur, squad: true });
  }
  return out.length ? out : shots.filter((s) => !s.squad);
}

/** Total authored length of a reel, seconds. */
export function reelLength(shots: Shot[]): number {
  return shots.reduce((a, s) => a + s.dur, 0);
}

/**
 * The camera at `t` seconds into a reel FITTED to `fit` seconds (every shot's
 * duration scaled by the same factor, so the cuts keep their rhythm).
 */
export function sampleReel(shots: Shot[], t: number, fit: number, out: CamPose): CamPose {
  const total = reelLength(shots);
  const k = fit > 0 && total > 0 ? total / fit : 1;
  let at = Math.max(0, t * k);
  let i = 0;
  while (i < shots.length - 1 && at >= shots[i]!.dur) {
    at -= shots[i]!.dur;
    i++;
  }
  const s = shots[i]!;
  const u = Math.max(0, Math.min(1, at / s.dur));
  const e = easeFn(s.ease, u);
  pathAt(s.pos, e, out.pos);
  pathAt(s.look, e, out.look);
  const fov = s.fov ?? [42, 40];
  out.fov = fov[0] + (fov[1] - fov[0]) * e;
  const roll = s.roll ?? [0, 0];
  out.roll = roll[0] + (roll[1] - roll[0]) * e;
  out.focus = s.focus ?? out.pos.distanceTo(out.look);
  out.shot = i;
  out.u = u;
  return out;
}

export function freshPose(): CamPose {
  return { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 42, roll: 0, focus: 20, shot: 0, u: 0 };
}

/**
 * Handheld: three incommensurate sines per axis, radians. Small and slow — a
 * camera operator breathing, not an earthquake.
 */
export function handheld(t: number, amountDeg: number, out: THREE.Euler): THREE.Euler {
  const a = (amountDeg * Math.PI) / 180;
  const n = (f1: number, f2: number, f3: number, ph: number): number =>
    Math.sin(t * f1 + ph) * 0.6 + Math.sin(t * f2 + ph * 2.1) * 0.3 + Math.sin(t * f3 + ph * 0.7) * 0.1;
  out.set(n(1.1, 2.7, 6.3, 0.4) * a, n(0.9, 2.3, 5.9, 1.9) * a, n(0.7, 1.9, 4.1, 3.1) * a * 0.6, "YXZ");
  return out;
}

// ---------------------------------------------------------------- auto reel

/** True when nothing in the collider soup sits between a and b. */
export function clear(a: THREE.Vector3 | V3, b: THREE.Vector3 | V3): boolean {
  const A = Array.isArray(a) ? a : [a.x, a.y, a.z];
  const B = Array.isArray(b) ? b : [b.x, b.y, b.z];
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const dz = B[2] - A[2];
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-3) return true;
  return traceWorld(A[0], A[1], A[2], dx / L, dy / L, dz / L, L).t >= L - 0.05;
}

/** Inside a collider (by more than `margin` m)? Open (walk-through) boxes do not count. */
export function inSolid(map: MapDef, p: V3 | THREE.Vector3, margin = 0.05): boolean {
  const x = Array.isArray(p) ? p[0] : p.x;
  const y = Array.isArray(p) ? p[1] : p.y;
  const z = Array.isArray(p) ? p[2] : p.z;
  for (const o of map.solids) {
    if (o.open) continue;
    if (Math.abs(o.y - y) > o.sy * 0.5 - margin) continue;
    const l = worldToLocal(o, x, z);
    if (Math.abs(l.x) < o.sx * 0.5 - margin && Math.abs(l.z) < o.sz * 0.5 - margin) return true;
  }
  return false;
}

/** Authoring + safety: every keyframe of a shot that sits inside geometry. */
export function shotProblems(map: MapDef, shots: Shot[]): string[] {
  const out: string[] = [];
  shots.forEach((s, i) => {
    if (s.squad) return;
    s.pos.forEach((p, k) => {
      if (inSolid(map, p)) out.push(`shot ${i} (${s.name ?? ""}) pos[${k}] ${p.join(",")} is inside a collider`);
    });
  });
  return out;
}

const avg = (pts: { x: number; y?: number; z: number }[]): V3 => {
  const n = Math.max(1, pts.length);
  return [pts.reduce((a, p) => a + p.x, 0) / n, pts.reduce((a, p) => a + (p.y ?? 0), 0) / n, pts.reduce((a, p) => a + p.z, 0) / n];
};

/**
 * A generic reel from the map's own data, built around SUBJECTS — every shot
 * looks at something (an objective, the tallest landmark, a team's spawn) from
 * a three-quarter angle with lead room, never straight down at empty floor:
 *   1. establishing: high 3/4 over the whole map, slow arc
 *   2. landmark: a push toward the tallest structure (the hero landmark)
 *   3. objective: a crane toward the objectives (or the middle of the lanes)
 *   4. the squad: your team at spawn, framed live (Shot.squad)
 * Angles are chosen by line of sight to the subject and how open the frame is.
 */
export function autoShots(map: MapDef): Shot[] {
  const b = map.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const team0 = map.spawnSets?.tdm?.west ?? map.spawns.filter((s) => s.team === 0);
  const team1 = map.spawnSets?.tdm?.east ?? map.spawns.filter((s) => s.team === 1);
  const s0 = avg(team0.length ? team0 : map.spawns);
  const s1 = avg(team1.length ? team1 : map.spawns);
  const objs = [...(map.objectives?.flags ?? []), ...(map.objectives?.bombsites ?? [])];
  const floor = map.floorY;
  // the landmark: the tallest collider top inside the playable rect
  let lm: V3 = [cx, floor + 2, cz];
  let lmTop = -Infinity;
  for (const o of map.solids) {
    if (o.x < b.minX || o.x > b.maxX || o.z < b.minZ || o.z > b.maxZ) continue;
    const top = o.y + o.sy * 0.5;
    if (top > lmTop && o.sx * o.sz < 400) {
      lmTop = top;
      lm = [o.x, o.y, o.z];
    }
  }
  const heart: V3 = objs.length ? avg(objs) : [(s0[0] + s1[0]) / 2, floor + 1, (s0[2] + s1[2]) / 2];
  const subjectShot = (name: string, subj: V3, dist: number, height: number, push: number, dur: number, fov: [number, number]): Shot => {
    const target = new THREE.Vector3(subj[0], subj[1] + 1.4, subj[2]);
    let best: { a: number; score: number } = { a: Math.atan2(cx - subj[0], cz - subj[2]), score: -1e9 };
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const cam = new THREE.Vector3(subj[0] + Math.sin(a) * dist, subj[1] + height, subj[2] + Math.cos(a) * dist);
      const end = new THREE.Vector3(subj[0] + Math.sin(a) * (dist - push), subj[1] + height * 0.8, subj[2] + Math.cos(a) * (dist - push));
      if (!air(cam, 1.0) || !air(end, 1.0)) continue;
      const sees = (clear(cam, target) ? 1 : 0) + (clear(end, target) ? 1 : 0);
      // an open frame (nothing parked in front of the lens), toward the map's middle
      const open = openFrame(cam, target, 40) + openFrame(end, target, 40);
      const toMid = Math.atan2(cx - subj[0], cz - subj[2]);
      const score = sees * 100 + open * 60 + (clear(cam, [cam.x, cam.y + 6, cam.z]) ? 10 : 0) - Math.abs(Math.atan2(Math.sin(a - toMid), Math.cos(a - toMid))) * 4;
      if (score > best.score) best = { a, score };
    }
    const a = best.a;
    const side: V3 = [Math.cos(a), 0, -Math.sin(a)];
    const p0: V3 = [subj[0] + Math.sin(a) * dist, subj[1] + height, subj[2] + Math.cos(a) * dist];
    const p1: V3 = [subj[0] + Math.sin(a) * (dist - push) + side[0] * push * 0.4, subj[1] + height * 0.8, subj[2] + Math.cos(a) * (dist - push) + side[2] * push * 0.4];
    // lead room: the subject sits a third in, the frame opens toward the move
    const lead = dist * 0.16;
    const look: V3[] = [
      [target.x - side[0] * lead, target.y, target.z - side[2] * lead],
      [target.x - side[0] * lead * 0.6, target.y - 0.2, target.z - side[2] * lead * 0.6],
    ];
    return { name, dur, pos: [p0, p1], look, fov, ease: "inout", shake: 0.25, focus: dist - push * 0.5 };
  };
  const est = subjectShot("auto: establishing", [cx, floor, cz], size * 0.42, Math.max(14, size * 0.2), size * 0.06, 2.4, [44, 40]);
  est.shake = 0.12;
  est.aperture = 0;
  est.ease = "linear";
  const shots: Shot[] = [est];
  // subjects: the objectives themselves (named places people fight over); without any, the tallest landmark and the middle
  if (objs.length) {
    const named = [...objs].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 2);
    for (const o of named) shots.push(subjectShot(`auto: ${o.name ?? o.id}`, [o.x, o.y, o.z], 11, 4, 3, 1.8, [40, 36]));
  } else {
    if (lmTop > floor + 4) shots.push(subjectShot("auto: landmark", [lm[0], Math.max(floor, lmTop - 6), lm[2]], 16, 4, 4, 1.9, [40, 36]));
    shots.push(subjectShot("auto: the middle", heart, 12, 5, 3, 1.8, [40, 36]));
  }
  shots.push({ name: "auto: squad", dur: 2.3, squad: true, pos: [], look: [] });
  return shots;
}
