/**
 * shared/penetration.ts — BULLET PENETRATION by wall material.
 *
 * A round that meets a thin enough wall of a soft enough material goes
 * through it and carries on with less damage: a crate, a door, a hedge, a
 * container's sheet-steel side. Masonry, concrete, sand and a whole solid
 * container still stop it dead. The material is the same one the impact FX
 * shows (shared/surface.ts), and the thickness is the length of the ray
 * inside the box, so a round through a crate's corner keeps more than one
 * through its middle.
 *
 * One function, `bulletPath`, used by BOTH the sim's hitscan and the client's
 * hitmarker prediction, so a wallbang marker and a wallbang hit stand or fall
 * together.
 */
import { traceWorld, type OBB } from "./map";
import { surfaceOf, type Surface } from "./surface";
import type { WeaponDef } from "./weapons";

/**
 * Per material: `max` metres a round can get through (at power 1), and the
 * damage left after it — `keep` at zero thickness, minus `perM` per metre.
 */
export const PEN_RULES: Partial<Record<Surface, { max: number; keep: number; perM: number }>> = {
  // Upstream (.origin 28.10.): wood max 1.5 m, so every Shipment crate
  // (0.70-1.10 m) is a wallbang for SMG and AR as well as the sniper; the
  // pistol still only gets through the thinner ones, with little left.
  // Damage still falls off per metre of wood.
  wood: { max: 1.5, keep: 0.8, perM: 0.4 },
  glass: { max: 0.3, keep: 0.95, perM: 0.3 },
  rubber: { max: 0.9, keep: 0.6, perM: 0.3 },
  dirt: { max: 1.5, keep: 0.8, perM: 0.2 },
  metal: { max: 0.25, keep: 0.6, perM: 1.2 },
};

/** How hard each gun punches through: max thickness x power, loss / power. */
export const PEN_POWER: Record<string, number> = { sniper: 1.6, ar: 1, smg: 0.75, pistol: 0.6 };

/** At most this many walls per round. */
export const PEN_WALLS = 2;

export type BulletPath = {
  /** Where the round finally stops (the world's last hit, or maxT). */
  t: number;
  /** Walls passed through: the distance of each entry and the damage share kept after it. */
  walls: { at: number; keep: number }[];
};

const NO_WALLS: BulletPath["walls"] = [];

/** Distance along the ray at which it leaves box `o` (Infinity if it never was inside). */
export function rayExitOBB(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: OBB): number {
  let tmin = -Infinity;
  let tmax = Infinity;
  const c = Math.cos(-o.yaw);
  const s = Math.sin(-o.yaw);
  const px = ox - o.x;
  const pz = oz - o.z;
  const p = [px * c - pz * s, oy - o.y, px * s + pz * c];
  const d = [dx * c - dz * s, dy, dx * s + dz * c];
  const h = [o.sx * 0.5, o.sy * 0.5, o.sz * 0.5];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-9) {
      if (Math.abs(p[i]!) > h[i]!) return Infinity;
      continue;
    }
    let t1 = (-h[i]! - p[i]!) / d[i]!;
    let t2 = (h[i]! - p[i]!) / d[i]!;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) return Infinity;
  }
  return tmax;
}

/**
 * Trace a round through the world, through every wall it can penetrate.
 * Melee and unknown guns never penetrate; the floor plane always stops.
 */
export function bulletPath(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  w: WeaponDef | undefined,
  mapId: string,
): BulletPath {
  let tr = traceWorld(ox, oy, oz, dx, dy, dz, maxT);
  const power = w && w.fire !== "melee" ? (PEN_POWER[w.id] ?? 0) : 0;
  if (!power || !tr.hit) return { t: tr.t, walls: NO_WALLS };
  const walls: BulletPath["walls"] = [];
  let at = tr.t;
  let hit: OBB | null = tr.hit;
  let keep = 1;
  while (hit && walls.length < PEN_WALLS) {
    const rule = PEN_RULES[surfaceOf(hit, mapId)];
    if (!rule) break;
    const exit = rayExitOBB(ox, oy, oz, dx, dy, dz, hit);
    const thick = exit - at;
    if (!Number.isFinite(exit) || thick > rule.max * power) break;
    keep *= Math.min(1, rule.keep - (rule.perM * Math.max(0, thick)) / power);
    if (keep < 0.15) break;
    walls.push({ at, keep });
    const from = exit + 0.01;
    if (from >= maxT) return { t: maxT, walls };
    tr = traceWorld(ox + dx * from, oy + dy * from, oz + dz * from, dx, dy, dz, maxT - from);
    at = from + tr.t;
    hit = tr.hit;
  }
  return { t: at, walls };
}

/** The damage share a round still carries at distance `t` along its path. */
export function keepAt(path: BulletPath, t: number): number {
  let k = 1;
  for (const wall of path.walls) if (wall.at < t) k = wall.keep;
  return k;
}
