/**
 * CEILINGS — the one contact `resolveCircle` (shared/sim.ts) cannot resolve.
 *
 * resolveCircle is a 2D pushout gated by a vertical band: any solid the body's
 * height overlaps (`feet <= top - 0.02 && head >= bot + 0.05`) and whose
 * footprint the 0.30 m circle overlaps is resolved by pushing the body
 * SIDEWAYS along the footprint's shortest exit. That is right for every solid
 * the body walks into — walls, crates, a head-height overhang it bumps — and
 * badly wrong for a solid the body rose into from BELOW: a ceiling slab over a
 * room has its shortest exit at the slab's nearest edge, metres away and
 * usually on the far side of a partition, so a jump in the yellow house's old
 * 2.24 m back room (head 1.74 + 0.755 m apex) landed the jumper 2.2 m away in
 * the bedroom.
 *
 * THE RULE. Contact is classified by HOW the head entered the band, not by
 * where the solid is:
 *
 *  - The head CROSSED the solid's underside going up — it was clear of the
 *    band before the move (`head0 < bot + 0.05`: no contact yet, so any
 *    pushout would be new) and has now risen past the underside
 *    (`head1 > bot - CEIL_EPS`) while the circle overlaps the footprint — so
 *    the solid is OVERHEAD and the contact is VERTICAL, with no lateral
 *    displacement at all. Two things carry a head up, and the sim (integrate /
 *    movePlayer in shared/sim.ts) answers each vertically:
 *      rising (vy > 0, a jump): the head parks at `bot - CEIL_EPS` (or stays
 *        where it was if it started inside the 5 cm grace) and vy -> 0;
 *      the stance growing (crouch released, slide ended — CROUCH_H/SLIDE_H ->
 *        STAND_H): mid-air with room under it, the feet drop so the head stays
 *        under the underside; with no room (on the floor, or the feet would go
 *        through it) the body STAYS CROUCHED — `roomToStand`, which asks this
 *        function with `contact`, so standing is refused exactly when
 *        resolveCircle would have pushed.
 *
 *  - The head was ALREADY level with the solid (inside the band before this
 *    move) — the body walked into its side, at any height, including a
 *    head-height overhang whose underside sits 1.1-1.7 m up — so it is a WALL
 *    and resolveCircle pushes exactly as it always has. A static height
 *    threshold ("underside more than a step above the feet") cannot tell these
 *    apart: a 1.5 m overhang is "overhead" by height yet must still stop a
 *    standing body walking into it. The crossing test can, and needs no
 *    threshold: a crossing puts the underside at least the body's own height
 *    minus 5 cm above the feet (1.13 m crouched, 1.69 m standing) — above the
 *    1.05 m mantle ceiling, so steps, stairs and mantles are never overhead.
 *    (A sliding body never rises: no jump, no gravity during a slide.) The
 *    mantle exemption is still mirrored, so a solid resolveCircle would walk
 *    the body over is never a ceiling either.
 *
 * What is deliberately NOT here: a head that enters a solid by a ground-snap
 * step-up (walking up a tread or onto a box with less headroom than the body
 * is tall). That is neither a rise nor a stance change; it keeps the old
 * lateral pushout. So does a slide ending under something lower than a crouch.
 *
 * Deterministic in its arguments. The server's applyInput and the client's
 * predictMovement both run the same movePlayer -> integrate, so prediction and
 * authority can never disagree about a ceiling.
 */

import { circleHitsOBB, vaulting, type OBB } from "./map";
import { gridQueryCircle, type SolidGrid } from "./solidgrid";

/** How far under the underside a stopped head is parked (well inside resolveCircle's 5 cm grace). */
export const CEIL_EPS = 0.001;

const NEAR: number[] = [];

/**
 * The lowest underside the head rose past going from `head0` to `head1` with
 * the body's circle (x, z, r) overlapping that solid's footprint — or Infinity.
 * `feet` and `vy` are the body's current values, for resolveCircle's band and
 * mantle exemption, which this mirrors verbatim.
 *
 * `contact`: count only a head that would actually be IN the band
 * (`head1 >= bot + 0.05`) — the "may I stand up here?" question, which must
 * allow exactly what resolveCircle allows. Without it, a head that merely
 * reaches the parking line (`bot - CEIL_EPS`) counts — the "where does this
 * rise stop?" question.
 */
export function ceilingCrossed(
  solids: OBB[],
  grid: SolidGrid,
  x: number,
  z: number,
  r: number,
  feet: number,
  vy: number,
  head0: number,
  head1: number,
  contact = false,
): number {
  if (!(head1 > head0)) return Infinity;
  // circleHitsOBB tests the footprint grown by r along the box's own axes,
  // which reaches r*sqrt2 past its world AABB at 45 degrees.
  const cand = gridQueryCircle(grid, x, z, r * Math.SQRT2, NEAR);
  let best = Infinity;
  for (let i = 0; i < cand.length; i++) {
    const o = solids[cand[i]!]!;
    if (o.visual === "roof") continue; // players never collide with roofs
    const bot = o.y - o.sy * 0.5;
    if (bot >= best) continue;
    // Clear of resolveCircle's band before the move; above the parking line
    // (or, for `contact`, inside the band) after it.
    if (head0 >= bot + 0.05 || (contact ? head1 < bot + 0.05 : head1 <= bot - CEIL_EPS)) continue;
    const top = o.y + o.sy * 0.5;
    if (feet > top - 0.02) continue;
    if (o.climb && top - feet < 1.05 && feet + 0.2 < top && vy >= -0.5) continue;
    if (vaulting(o, feet, vy)) continue;
    const hit = circleHitsOBB(x, z, r, o);
    if (hit.hit && hit.pen > 0) best = bot;
  }
  return best;
}
