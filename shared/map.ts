import { gridFor, gridQueryCircle, visitGridRay, indexSolids, type GridRayVisitor } from "./solidgrid";

/** Classic Shipment layout: 33m yard, 2x2 inner pairs, wall pairs, angled walkthroughs. */
export const YARD = 33;
export const HALF = YARD * 0.5;
export const CL = 6.06;
export const CW = 2.44;
export const CH = 2.59;

export type OBB = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  climb?: boolean;
  /**
   * A waist-high rail you can JUMP over but never walk through (Nuketown's
   * balcony railings): bodies pass it only while their feet are within
   * VAULT_REACH of its top, which a standing body never is and a jump is.
   */
  vault?: boolean;
  visual?: string;
  open?: boolean;
  color?: string;
  /** Statement prop: the visual is an authored mesh, not a procedural build. */
  glb?: string;
};

/** How close (m) the feet must come to a `vault` rail's top to clear it: a jump, never a step. */
export const VAULT_REACH = 0.6;

/**
 * Is this body (feet at `feet`, vertical speed `vy`) passing over a `vault`
 * rail? Yes while it is still RISING from a jump, or once its feet are within
 * VAULT_REACH of the top; a body standing or walking is neither.
 */
export function vaulting(o: OBB, feet: number, vy: number): boolean {
  if (!o.vault) return false;
  const top = o.y + o.sy * 0.5;
  return (vy > 0.5 || top - feet < VAULT_REACH) && top - feet < 1.05;
}

/** OBB yaw convention (worldToLocal/localToWorld below): local +x maps to world
 *  (cos y, sin y) and local +z to world (-sin y, cos y). three.js `rotation.y`
 *  is the MIRROR of that (local +x -> (cos y, -sin y)), so every renderer that
 *  draws an OBB-backed prop must use `-o.yaw`. Getting this wrong is invisible
 *  at yaw 0 and catastrophic for the angled wrecks/car/forklift/dumpsters. */
export const RENDER_YAW = (yaw: number): number => -yaw;

export type Spawn = { x: number; y: number; z: number; yaw: number; team: 0 | 1 };

/** A nav seed. `y` (optional) pins it to ONE storey of a stacked-floors map:
 *  buildBotNav resolves its floor from that height instead of the topmost
 *  surface above (x, z). Maps that leave it out behave exactly as before. */
export type Waypoint = { x: number; z: number; cover: boolean; y?: number };

const PAIR_GAP = 0.07;
const LANE = 3.55;
const PAIR_W = CW * 2 + PAIR_GAP;
const OX = (PAIR_W + LANE) * 0.5;
const OZ = (CL + LANE) * 0.5;

function box(
  x: number,
  z: number,
  sx: number,
  sz: number,
  yaw = 0,
  extra: Partial<OBB> = {},
): OBB {
  return { x, y: CH * 0.5, z, sx, sy: CH, sz, yaw, ...extra };
}

function openShell(
  x: number,
  z: number,
  sx: number,
  sz: number,
  yaw: number,
  color: string,
): OBB[] {
  // The wall collider wraps the visible wall mass instead of just its outer
  // skin: the corrugated skin peaks at sx/2 + 0.03 and the interior lining plane
  // sits at sx/2 - 0.19. A 0.09 slab pinned on the outer face left that lining
  // 0.145 m inside the collider, so players stopped 14 cm short of the wall they
  // could see (collider-audit VIS>COL ranks 14-15 + 18-24, one per open shell).
  // 0.18 rather than the full 0.22: it keeps the residual at 0.04 m (well inside
  // the 0.12 m truth threshold) while leaving the walkthrough corridor 8 cm
  // wider, which is what a swinging arm needs to clear the lining.
  const t = 0.18;
  const off = sx * 0.5 - 0.06;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const left = { x: x + -off * c, z: z + -off * s };
  const right = { x: x + off * c, z: z + off * s };
  return [
    {
      x: left.x,
      y: CH * 0.5,
      z: left.z,
      sx: t,
      sy: CH,
      sz,
      yaw,
      color,
      visual: "cwall",
    },
    {
      x: right.x,
      y: CH * 0.5,
      z: right.z,
      sx: t,
      sy: CH,
      sz,
      yaw,
      color,
      visual: "cwall",
    },
    {
      // 0.16 deep, matching the rendered roof slab exactly: a 0.1 collider left
      // the roof's lower 6 cm uncovered, and the perimeter wall's top probe read
      // that overhang as protruding mesh (VIS>COL on wall-w / wall-e).
      x,
      y: CH - 0.05,
      z,
      sx,
      sy: 0.16,
      sz,
      yaw,
      color,
      visual: "roof",
    },
  ];
}

function pairNS(x: number, z: number, color: string, open = false): OBB[] {
  const off = (CW + PAIR_GAP) * 0.5;
  const a = open
    ? openShell(x - off, z, CW, CL, 0, color)
    : [box(x - off, z, CW, CL, 0, { color, visual: "container" })];
  return [...a, box(x + off, z, CW, CL, 0, { color, visual: "container" })];
}

function pairEW(x: number, z: number, color: string, open = false): OBB[] {
  const off = (CW + PAIR_GAP) * 0.5;
  const a = open
    ? openShell(x, z - off, CL, CW, 0, color)
    : [box(x, z - off, CL, CW, 0, { color, visual: "container" })];
  return [...a, box(x, z + off, CL, CW, 0, { color, visual: "container" })];
}

export function buildSolids(): OBB[] {
  const solids: OBB[] = [];

  solids.push(...pairNS(-OX, -OZ, "red", true));
  solids.push(...pairNS(OX, -OZ, "blue"));
  solids.push(...pairNS(-OX, OZ, "orange"));
  solids.push(...pairNS(OX, OZ, "green", true));

  const wallZ = HALF - CW - 0.55;
  solids.push(...pairEW(0, -wallZ, "blue"));
  solids.push(...pairEW(0, wallZ, "red", true));

  const wallX = HALF - CW - 0.7;
  solids.push(...openShell(-wallX, -1.1, CW, CL, 0, "green"));
  solids.push(...openShell(-wallX - 1.55, 2.35, CW, CL, 0.42, "orange"));
  solids.push(...openShell(wallX, 1.1, CW, CL, 0, "red"));
  solids.push(...openShell(wallX + 1.55, -2.35, CW, CL, -0.42, "blue"));

  const wallH = 2.15;
  const t = 0.55;
  const ext = HALF + 0.2;
  solids.push({ x: 0, y: wallH * 0.5, z: -ext, sx: YARD + 2, sy: wallH, sz: t, yaw: 0, visual: "wall" });
  solids.push({ x: 0, y: wallH * 0.5, z: ext, sx: YARD + 2, sy: wallH, sz: t, yaw: 0, visual: "wall" });
  solids.push({ x: -ext, y: wallH * 0.5, z: 0, sx: t, sy: wallH, sz: YARD + 2, yaw: 0, visual: "wall" });
  solids.push({ x: ext, y: wallH * 0.5, z: 0, sx: t, sy: wallH, sz: YARD + 2, yaw: 0, visual: "wall" });

  const crate = (x: number, z: number, s = 0.92, h = 0.86): OBB => ({
    x,
    y: h * 0.5,
    z,
    sx: s,
    sy: h,
    sz: s,
    yaw: 0.15,
    climb: true,
    visual: "crate",
  });
  solids.push(crate(-13.4, -13.2), crate(-12.3, -13.6, 0.8, 0.7));
  solids.push(crate(13.2, 13.1), crate(12.2, 13.5, 0.75, 0.62));
  solids.push(crate(-13.6, 13.0, 0.85, 0.8));
  solids.push(crate(13.4, -13.3, 0.88, 0.78));
  solids.push(crate(-2.4, -2.2, 0.7, 0.55));
  solids.push(crate(2.5, 2.15, 0.7, 0.55));

  const barrel = (x: number, z: number): OBB => ({
    x,
    y: 0.45,
    z,
    sx: 0.62,
    sy: 0.9,
    sz: 0.62,
    yaw: 0,
    climb: true,
    visual: "barrel",
  });
  solids.push(barrel(12.4, -12.2), barrel(13.1, -12.0), barrel(-12.6, 12.4));
  solids.push(barrel(-1.1, 13.6), barrel(1.3, -13.7));

  // Banana shipping chests. HEIGHT is the load-bearing number here, not width:
  // a climbable box is mantle-passable, so clearanceGrid (and the sim) marks the
  // whole 0.30 m player-radius ring around it walkable while groundHeight only
  // lifts you once you are within 0.12 m of the footprint. Anything the chest
  // shows inside that 0.18 m band at standing chest height (ground + 0.90 m)
  // therefore passes straight through a walking player's torso — which is
  // exactly what the 16 dumpster ghost cells were (probe hits on the LID at
  // y=0.90, never on the body). Top is now 0.84 m: the whole chest sits below
  // chest height, so the mantle ring is honest and you simply step up.
  // Footprint matches the LID (1.74 x 1.08 in the prop's own frame — the audit's
  // 1.88 x 1.33 is that slab's yaw-rotated world AABB, not its real size), so
  // there is no overhang left to clip and the inset under the lid is 0.02 m.
  solids.push({
    x: 6.8,
    y: 0.42,
    z: 13.4,
    sx: 1.74,
    sy: 0.84,
    sz: 1.08,
    yaw: 0.2,
    climb: true,
    visual: "dumpster",
  });
  solids.push({
    x: -7.1,
    y: 0.42,
    z: -13.4,
    sx: 1.74,
    sy: 0.84,
    sz: 1.08,
    yaw: -0.15,
    climb: true,
    visual: "dumpster",
  });

  // --- BANANA CO pickup (statement mesh) — replaces the old rusted wreck car.
  // Nose points at the yard centre so the 1.36 m hood is what mid sees and the
  // 2.30 m loaded bed backs into the corner. Three boxes fitted to the measured
  // mesh silhouette (hood / cab / bed+load), all sharing the truck's frame.
  const PICKUP_YAW = -1.2208; // long axis kept on the old car's world heading
  // Boxes start at the sill, not the ground: below 0.30 m a pickup is wheels and
  // air, so a box that reached the dirt probed 1.2 m of nothing on every face.
  // Players are 1.78 m tall, so a 0.32 m sill still blocks them at ground level.
  const SILL = 0.32;
  const truckBox = (
    zLo: number,
    zHi: number,
    halfX: number,
    top: number,
    climb = false,
    base = SILL,
    xMid = 0,
  ): OBB => {
    const cz = (zLo + zHi) * 0.5;
    const c = Math.cos(PICKUP_YAW);
    const s = Math.sin(PICKUP_YAW);
    return {
      x: -11.2 + xMid * c - cz * s,
      y: (top + base) * 0.5,
      z: -11.6 + xMid * s + cz * c,
      sx: halfX * 2,
      sy: top - base,
      sz: zHi - zLo,
      yaw: PICKUP_YAW,
      climb,
      visual: "car",
      glb: "pickup",
    };
  };
  // Fitted to a measured sweep of the authored mesh (down-rays every 0.1 m of
  // truck-local z x 0.095 m of local x). What that sweep shows: the bed is NOT
  // a uniform load. Along local x -0.88..0.00 the cargo tops out at 1.56 m; the
  // stamped crate stack stands on the +x half only (local x -0.02..0.82) and
  // peaks at 2.36 m. The old single bed box (0.78 half-width, 1.05 -> 2.32 over
  // the whole bed) therefore carried up to 1.17 m of pure air above the visible
  // bed floor at the tailgate end — launcher rounds lobbed over the tailgate
  // burst mid-air a metre above visible metal.
  // So: the chassis box takes the low bed cargo (top 1.40 -> 1.58, which also
  // closes the 0.16 m of sack tops that would otherwise stand outside every
  // collider), and the bed box shrinks to the crate stack alone — envelope down
  // from 1.56 x 1.27 x 1.28 to 0.84 x 0.80 x 1.36. Residual: the truck keeps
  // its 3 COL>VIS entries (cab window voids, wheel arches, the open bed well)
  // — an OBB over an open cab or an open bed always probes air somewhere.
  // 1.72 at the nose, not 1.58: the sculpted grille runs out to local z 1.70,
  // and raising the box top moved the face-sample rows just far enough to catch
  // it (VIS>COL 0.123 m on the +z face).
  // climb:true — THE TRUCK IS A JUMP SPOT. The 1.58 m bed is
  // out of a walking mantle's reach (top - y < 1.05) but inside a JUMP's: the
  // apex is 0.755 m, so a body that jumps into the tailgate rises through the
  // mantle band and lands on the bed, and from the bed the cab roof (+0.46 m)
  // and the stamped crate stack (+0.80 m) are ordinary steps up. They were
  // climb:false, so the crates on the bed read as a perch nobody could reach.
  // Bots still treat the truck as a wall (botBlocked's mantle test is from the
  // ground), and no spawn point or nav seed lies inside its footprint, so
  // neither moves (measured: groundHeight at all 31 is unchanged).
  solids.push(truckBox(-1.7, 1.72, 0.88, 1.58, true)); // chassis, fenders, bed sides, low bed cargo
  solids.push(truckBox(-0.42, 0.7, 0.74, 2.04, true, 1.58)); // cab shell
  solids.push(truckBox(-1.78, -0.42, 0.42, 2.38, true, 1.58, 0.4)); // stamped crate stack only

  // Forklift: chassis/overhead-guard envelope (the old 1.4 m box left the guard
  // roof and mast standing 0.53 m outside it) + a low box for the forks.
  // Upstream (.origin 28.10.): sy 0.21, not the 0.16 of the forks themselves.
  // The walker only steps onto a climbable whose top is MORE than 0.2 m above
  // its feet (sim resolveCircle), so a 0.16 box was a shin-high invisible wall
  // in front of the forklift. Now you walk over the forks, 5 cm above the steel.
  solids.push({
    x: 10.6,
    y: 0.95,
    z: 10.8,
    sx: 1.16,
    sy: 1.9,
    sz: 1.8,
    yaw: -0.4,
    climb: true,
    visual: "forklift",
  });
  solids.push({
    x: 10.6 + 1.36 * Math.sin(-0.4),
    y: 0.105,
    z: 10.8 - 1.36 * Math.cos(-0.4),
    sx: 0.72,
    sy: 0.21,
    sz: 1.04,
    yaw: -0.4,
    climb: true,
    visual: "forklift",
  });

  // Tire stack (NW dressing) had no collider at all — 10 ghost cells of players
  // standing inside it. Nudged clear of the squeeze lane it used to sit in.
  // Same mantle-ring rule as the chests above: the top tyre used to crown at
  // 0.905 m and grazed the chest probe of the ring cell at (-12.1, 11.9). The
  // stack now tops out at 0.83 m.
  // Footprint 0.82, NOT the 0.94 that would wrap the 0.93 m tyre diameter: a
  // box around a cylinder can only trade one mismatch for the other, and the
  // trade is not symmetric here. At 0.94 the face grid samples the box corners,
  // which sit outside the rubber — measured COL>VIS 0.336 m on the top face and
  // 0.22 m on the sides, a real invisible-wall band. At 0.82 the worst corner
  // inset is 0.04 m and the tyre crowns 0.07 m outside the box: both far under
  // the 0.12 m truth threshold, which is the tightest a round stack goes.
  solids.push({
    x: -12.0,
    y: 0.42,
    z: 11.3,
    sx: 0.82,
    sy: 0.84,
    sz: 0.82,
    yaw: 0,
    climb: true,
    visual: "tire-stack",
  });

  // SE banana-crate spill: the standing crate is now solid (8 ghost cells).
  // POSITION IS SPAWN-CRITICAL. Making it solid turned it into a pedestal, and
  // at the round-1 spot (12.05, -10.35) its footprint SWALLOWED spawn point 10
  // at (12.2, -10.4) — worldToLocal offset (0.152, 0.043) against a 0.43 m
  // half-size. spawn() sets p.y = groundHeight(p.x, p.z), groundHeight lifts
  // inside footprint+0.12 of a climb box, so every pick of that point stood the
  // player on the 0.70 m crate top: spawnlab measured 42.1% dead-in-2s and a
  // clearMean of 31.4 m (an eye height only a pedestal produces) against 17.6%
  // / 6.3 m for its mirror point 4. Moved 2.9 m NE into the open east yard.
  // Clearance budget for the new spot: spawn jitter is +-0.2 per axis and the
  // anti-crowd shove is 1.6 - nearD + 0.2 (up to 1.8 m at coincident bodies),
  // plus the 0.30 m player radius, so the footprint edge must stay > ~2.4 m
  // from any spawn point to be unreachable even in the worst shove. Measured
  // edge distance to point 10 is 2.76 m — and the observed worst spawn offset in
  // 2179 spawnlab spawns is 0.35 m, so the margin is ~8x the real displacement.
  // It still reads as SE yard dressing, filling the empty pocket between the
  // blue wreck's south mouth and the corner cluster, with 1.63 m of walkable
  // channel to the east wall and 1.83 m to the wreck. It is deliberately NOT
  // spawn cover: at 0.70 m it never touches the spawn scorer's y=1.5 LOS ray
  // (so point 10 earns no phantom safety from it) and it sits 122 deg off that
  // point's fixed yaw. Proven inert by A/B: spawnlab with this collider deleted
  // reproduces point 10's line to the digit — 35.1% dead-in-2s, clearMean 9.41,
  // ttdP50 2.61 — so the point's residual rate is its own open-corner geometry,
  // not this prop.
  solids.push({
    x: 14.2,
    y: 0.35,
    z: -7.9,
    sx: 0.86,
    sy: 0.7,
    sz: 0.86,
    yaw: -0.6,
    climb: true,
    visual: "crate-spill",
  });

  // Hero export crate (statement mesh): NE quadrant landmark, off every lane.
  solids.push({
    x: 13.612,
    y: 0.689,
    z: 7.433,
    sx: 1.102,
    sy: 1.378,
    sz: 1.426,
    yaw: -0.35,
    climb: true,
    visual: "crate",
    glb: "export-crate",
  });

  // --- Wreck-seam packs. The two tilted derelicts cross their straight
  // partners, and each crossing leaves a tapering slot that the eye reads as a
  // way through while the sim seals it (collider-audit sealed-gap regions at
  // (15.5,-4.3) 0.95 m, (-14.9,0.3) 0.57 m, (-13.3,1.9) 1.09 m). None of the
  // three can be opened honestly: they are dead ends behind the wrecks, and
  // widening one would move a classic Shipment wall. So they are packed with
  // banana-crate cargo instead — solid and 1.8-1.9 m tall, i.e. over a standing
  // player's eyeline, so the slot reads shut rather than shootable-over (a
  // knee-high crate would clear the audit's column test while the slot still
  // read open at head height), and sized so the leftover gap on each side drops
  // under 0.45 m. Boxes only: the render side draws exactly these
  // extents, so every face has cargo behind it.
  // 1) east: between the blue wreck's outer wall and the east perimeter.
  solids.push({
    x: 16.07,
    y: 0.95,
    z: -4.155,
    sx: 1.05,
    sy: 1.9,
    sz: 1.65,
    yaw: -0.42,
    visual: "wreck-junk",
  });
  // 2) west: the orange wreck's interior pinch, west of the green shell wall.
  solids.push({
    // z starts at 0.14, not -0.10: nothing solid should cross the z=0 plane of
    // the mid lane, even out here behind the shells. South of 0.14 the slot is
    // already under 0.38 m wide, so it needs no help to read shut.
    x: -14.88,
    y: 0.9,
    z: 0.67,
    sx: 0.56,
    sy: 1.8,
    sz: 1.06,
    yaw: 0,
    visual: "wreck-junk",
  });
  // 3) the green walkthrough's north end, already a documented dead-end pocket
  // (qa/traverse wt-green-west): the orange wreck wall splits it into two
  // teasing slivers. This closes the wide one so the pocket reads shut.
  solids.push({
    x: -12.75,
    y: 0.95,
    z: 1.665,
    sx: 0.7,
    sy: 1.9,
    sz: 0.53,
    yaw: 0,
    visual: "wreck-junk",
  });

  return solids;
}

export const SOLIDS = buildSolids();

// ---------------------------------------------------------------------------
// THE ACTIVE WORLD
//
// `groundHeight` and `traceWorld` are the only two map-agnostic query functions
// in the game, and both used to default to `SOLIDS` — this module's Shipment
// array — which is what made "one process, one map" a fact of the architecture
// rather than a choice. They now default to whatever shared/maps/index.ts
// resolved at boot, so five client modules and fourteen qa harnesses that call
// them with two arguments follow the active map for free.
//
// The floor plane travels with the solids for the same reason: three systems
// hard-coded an infinite y = 0 (player clamp, bullet stop, grenade bounce), and
// dust2's lowest walkable floor is 3.25 m BELOW that plane.
//
// Set exactly once, from shared/maps/index.ts `activeMap()`, before anything
// derived exists. Shipment's values are the defaults, so a process that never
// calls it behaves exactly as it did before this block was written.
// ---------------------------------------------------------------------------

let ACTIVE_SOLIDS: OBB[] = SOLIDS;
let ACTIVE_FLOOR_Y = 0;

export function setActiveWorld(solids: OBB[], floorY: number): void {
  ACTIVE_SOLIDS = solids;
  ACTIVE_FLOOR_Y = floorY;
  indexSolids(solids);
}

/** The collider set every unqualified query runs against. */
export function activeSolids(): OBB[] {
  return ACTIVE_SOLIDS;
}

/** The world floor plane of the active map. */
export function activeFloorY(): number {
  return ACTIVE_FLOOR_Y;
}

export type VisualContainer = {
  x: number;
  z: number;
  sx: number;
  sz: number;
  yaw: number;
  color: string;
  open: boolean;
  stacked?: number;
};

export const VISUAL_CONTAINERS: VisualContainer[] = [
  { x: -OX - (CW + PAIR_GAP) * 0.5, z: -OZ, sx: CW, sz: CL, yaw: 0, color: "red", open: true },
  { x: -OX + (CW + PAIR_GAP) * 0.5, z: -OZ, sx: CW, sz: CL, yaw: 0, color: "red", open: false },
  { x: OX - (CW + PAIR_GAP) * 0.5, z: -OZ, sx: CW, sz: CL, yaw: 0, color: "blue", open: false },
  { x: OX + (CW + PAIR_GAP) * 0.5, z: -OZ, sx: CW, sz: CL, yaw: 0, color: "blue", open: false },
  { x: -OX - (CW + PAIR_GAP) * 0.5, z: OZ, sx: CW, sz: CL, yaw: 0, color: "orange", open: false },
  { x: -OX + (CW + PAIR_GAP) * 0.5, z: OZ, sx: CW, sz: CL, yaw: 0, color: "orange", open: false },
  { x: OX - (CW + PAIR_GAP) * 0.5, z: OZ, sx: CW, sz: CL, yaw: 0, color: "green", open: true },
  { x: OX + (CW + PAIR_GAP) * 0.5, z: OZ, sx: CW, sz: CL, yaw: 0, color: "green", open: false },
  { x: 0, z: -(HALF - CW - 0.55) - (CW + PAIR_GAP) * 0.5, sx: CL, sz: CW, yaw: 0, color: "blue", open: false },
  { x: 0, z: -(HALF - CW - 0.55) + (CW + PAIR_GAP) * 0.5, sx: CL, sz: CW, yaw: 0, color: "blue", open: false },
  { x: 0, z: HALF - CW - 0.55 - (CW + PAIR_GAP) * 0.5, sx: CL, sz: CW, yaw: 0, color: "red", open: true },
  { x: 0, z: HALF - CW - 0.55 + (CW + PAIR_GAP) * 0.5, sx: CL, sz: CW, yaw: 0, color: "red", open: false },
  { x: -(HALF - CW - 0.7), z: -1.1, sx: CW, sz: CL, yaw: 0, color: "green", open: true },
  { x: -(HALF - CW - 0.7) - 1.55, z: 2.35, sx: CW, sz: CL, yaw: 0.42, color: "orange", open: true },
  { x: HALF - CW - 0.7, z: 1.1, sx: CW, sz: CL, yaw: 0, color: "red", open: true },
  { x: HALF - CW - 0.7 + 1.55, z: -2.35, sx: CW, sz: CL, yaw: -0.42, color: "blue", open: true },
];

export const SPAWNS: Spawn[] = [
  { x: -6.4, y: 0, z: 11.2, yaw: Math.PI, team: 0 },
  { x: 6.4, y: 0, z: 11.2, yaw: Math.PI, team: 0 },
  { x: -11.6, y: 0, z: 7.2, yaw: -2.4, team: 0 },
  { x: -13.0, y: 0, z: 10.8, yaw: -2.2, team: 0 },
  { x: 12.2, y: 0, z: 10.4, yaw: 2.2, team: 0 },
  { x: -10.8, y: 0, z: 13.2, yaw: Math.PI, team: 0 },
  // spawnlab P0: (0, -11.6) sat 0.58 m INSIDE the closed north wall container,
  // so every LOS ray was blocked, the scorer read it as permanently safe and
  // picked it 13.8% of the time — 50% of those lives ended inside 2 s while the
  // solver ejected the body. Moved into the NW back lane, where the BANANA CO
  // truck breaks the sightline into mid instead of a container swallowing you.
  { x: -14.6, y: 0, z: -11.8, yaw: -0.89, team: 1 },
  { x: -4.2, y: 0, z: -11.4, yaw: 0, team: 1 },
  { x: 4.2, y: 0, z: -11.4, yaw: 0, team: 1 },
  { x: -12.2, y: 0, z: -10.4, yaw: -0.9, team: 1 },
  // yaw was 0.9 (52 deg), the exact z-mirror of point 4's 126 deg. Geometrically
  // tidy, gameplay-blind: threat does not mirror, because both back corners are
  // fed by the SAME north lane. spawnlab traced every visible enemy from this
  // point's final jittered head — the nearest one sits at a median bearing of
  // -83 deg (due west, down the north lane), so at 52 deg the median threat was
  // 135.6 deg BEHIND the gun and 82.7% of live sightlines started behind you.
  // At -1.45 the median turn is 5 deg and 0% start behind, and the split holds
  // independently in tdm (n=30, 132 -> 8 deg) and ffa (n=80, 137 -> 5 deg), so
  // it is the lane's shape talking, not one bot pattern. Nothing in the spawn
  // scorer reads yaw, so this changes what the player sees, never where or how
  // often they are placed.
  { x: 12.2, y: 0, z: -10.4, yaw: -1.45, team: 1 },
  { x: 8.5, y: 0, z: -12.6, yaw: 0, team: 1 },
];

export const WAYPOINTS: Waypoint[] = [
  { x: 0, z: 0, cover: false },
  { x: -OX, z: 0, cover: true },
  { x: OX, z: 0, cover: true },
  { x: 0, z: -OZ, cover: true },
  { x: 0, z: OZ, cover: true },
  { x: -OX, z: -OZ - 3.6, cover: true },
  { x: OX, z: -OZ - 3.6, cover: true },
  { x: -OX, z: OZ + 3.6, cover: true },
  { x: OX, z: OZ + 3.6, cover: true },
  { x: -12.5, z: 0, cover: true },
  { x: 12.5, z: 0, cover: true },
  { x: 0, z: -12.8, cover: true },
  { x: 0, z: 12.8, cover: true },
  { x: -13.9, z: -11.5, cover: true }, // behind the pickup, not inside it
  { x: 12, z: 12, cover: true },
  { x: -12, z: 12, cover: true },
  { x: 12, z: -12, cover: true },
  { x: -6.2, z: -6.4, cover: true },
  { x: 6.2, z: 6.4, cover: true },
];

export const DOM_FLAGS = [
  { id: "A", x: 0, z: -11.4 },
  { id: "B", x: 0, z: 0 },
  { id: "C", x: 0, z: 11.4 },
];

export function localToWorld(
  o: OBB,
  lx: number,
  lz: number,
): { x: number; z: number } {
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  return { x: o.x + lx * c - lz * s, z: o.z + lx * s + lz * c };
}

export function worldToLocal(o: OBB, x: number, z: number): { x: number; z: number } {
  const dx = x - o.x;
  const dz = z - o.z;
  const c = o.yaw === 0 ? 1 : Math.cos(-o.yaw);
  const s = o.yaw === 0 ? -o.yaw : Math.sin(-o.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

export function circleHitsOBB(
  px: number,
  pz: number,
  r: number,
  o: OBB,
): { hit: boolean; nx: number; nz: number; pen: number } {
  const loc = worldToLocal(o, px, pz);
  const hx = o.sx * 0.5 + r;
  const hz = o.sz * 0.5 + r;
  if (Math.abs(loc.x) > hx || Math.abs(loc.z) > hz) {
    return { hit: false, nx: 0, nz: 0, pen: 0 };
  }
  const dx = hx - Math.abs(loc.x);
  const dz = hz - Math.abs(loc.z);
  if (dx < dz) {
    const nlocX = loc.x > 0 ? 1 : -1;
    const c = o.yaw === 0 ? 1 : Math.cos(o.yaw);
    const s = o.yaw === 0 ? o.yaw : Math.sin(o.yaw);
    return { hit: true, nx: nlocX * c, nz: nlocX * s, pen: dx };
  }
  const nlocZ = loc.z > 0 ? 1 : -1;
  const c = o.yaw === 0 ? 1 : Math.cos(o.yaw);
  const s = o.yaw === 0 ? o.yaw : Math.sin(o.yaw);
  return { hit: true, nx: -nlocZ * s, nz: nlocZ * c, pen: dz };
}

export function rayHitsOBB(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  o: OBB,
  maxT: number,
): number {
  const minY = o.y - o.sy * 0.5;
  const maxY = o.y + o.sy * 0.5;
  let tmin = 0;
  let tmax = maxT;
  // Reject floors/ceilings before transforming a horizontal visibility ray.
  if (Math.abs(dy) < 1e-8) {
    if (oy < minY || oy > maxY) return Infinity;
  } else {
    let t1 = (minY - oy) / dy;
    let t2 = (maxY - oy) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) return Infinity;
  }
  const c = o.yaw === 0 ? 1 : Math.cos(-o.yaw);
  const s = o.yaw === 0 ? -o.yaw : Math.sin(-o.yaw);
  const px = ox - o.x;
  const pz = oz - o.z;
  const lx = px * c - pz * s;
  const lz = px * s + pz * c;
  const ldx = dx * c - dz * s;
  const ldz = dx * s + dz * c;
  const hx = o.sx * 0.5;
  const hz = o.sz * 0.5;
  const minX = -hx;
  const maxX = hx;
  const minZ = -hz;
  const maxZ = hz;

  // Unroll the three slabs: visibility traces run this thousands of times a
  // tick on Dust2. Allocating nested arrays/iterators for every box dominated
  // the server's collision cost. Keep the same slab arithmetic.
  if (Math.abs(ldx) < 1e-8) {
    if (lx < minX || lx > maxX) return Infinity;
  } else {
    let t1 = (minX - lx) / ldx;
    let t2 = (maxX - lx) / ldx;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) return Infinity;
  }
  if (Math.abs(ldz) < 1e-8) {
    if (lz < minZ || lz > maxZ) return Infinity;
  } else {
    let t1 = (minZ - lz) / ldz;
    let t2 = (maxZ - lz) / ldz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) return Infinity;
  }
  return tmin >= 0 ? tmin : tmax >= 0 ? tmax : Infinity;
}

/** Footprint tolerance, and the world-AABB pad a query needs to cover it at any yaw. */
const GH_TOL = 0.12;
const GH_PAD = GH_TOL * Math.SQRT2;
const GH_SCRATCH: number[] = [];

/**
 * THE FLOOR UNDER A POINT — the single most consequential function in the sim,
 * and until now a 2D one.
 *
 * It returns the highest `climb` top whose footprint (+0.12 m per local axis)
 * contains (x, z), or the map's floor plane. `integrate()` then snaps the body
 * to it unconditionally: `if (p.y <= gh) p.y = gh`. There is no down-ray, no
 * ledge test and no interpolation anywhere — the body teleports.
 *
 * `fromY` IS THE WHOLE DUST2 STORY. Without it, a `climb` deck spanning y
 * 2.0..2.2 over open ground teleports a player walking underneath it straight
 * to 2.2 m the instant their (x,z) enters the footprint (MEASURED,
 * docs/dustmap/report-sim.md §0): overpasses, catwalks, stacked floors and
 * tunnels-under-floors are structurally impossible. `fromY` says "I am HERE" and
 * this ignores any surface more than a mantle (1.05 m) above that — the exact
 * band `resolveCircle` already refuses to step onto, so a caller that passes its
 * real height gets the floor it could actually have reached.
 *
 * Shipment does NOT pass a real `fromY` — `MapDef.stackedFloors` is false there
 * and every call site hands this Infinity, so the function is byte-for-byte what
 * it was. That is a measurement, not a preference: two Shipment climb boxes top
 * out above the mantle ceiling (forklift 1.90 m, export crate 1.378 m) and
 * `fromY` changes the answer inside their footprints — 2,037 of 490,000 cells on
 * a 5 cm sweep of the yard, every one of them inside a collider. No WALKING body
 * can reach those cells (`resolveCircle` ejects to radius +0.30 while this
 * function reaches +0.12), but `spawn()` has no clearance check and the nav
 * lattice has a point standing on the forklift roof, so threading it would have
 * moved a spawn and deleted a nav node. Measured in
 * scripts/dustmap/sim-equivalence.mjs PART 3, which also proves the mechanism
 * works on a synthetic stacked deck.
 */
export function groundHeight(
  x: number,
  z: number,
  solids: OBB[] = ACTIVE_SOLIDS,
  fromY = Infinity,
  floorY: number = ACTIVE_FLOOR_Y,
): number {
  let h = floorY;
  const lim = fromY + 1.05;
  const g = gridFor(solids);
  if (g) {
    const cand = gridQueryCircle(g, x, z, GH_PAD, GH_SCRATCH);
    for (let i = 0; i < cand.length; i++) {
      const o = solids[cand[i]!]!;
      if (!o.climb) continue;
      const top = o.y + o.sy * 0.5;
      if (top > lim) continue;
      const loc = worldToLocal(o, x, z);
      if (Math.abs(loc.x) <= o.sx * 0.5 + GH_TOL && Math.abs(loc.z) <= o.sz * 0.5 + GH_TOL) {
        h = Math.max(h, top);
      }
    }
    return h;
  }
  for (const o of solids) {
    if (!o.climb) continue;
    const top = o.y + o.sy * 0.5;
    if (top > lim) continue;
    const loc = worldToLocal(o, x, z);
    if (Math.abs(loc.x) <= o.sx * 0.5 + GH_TOL && Math.abs(loc.z) <= o.sz * 0.5 + GH_TOL) {
      h = Math.max(h, top);
    }
  }
  return h;
}

/**
 * Hitscan, LOS and the camera's depth probe, against the world.
 *
 * Full 3D: `rayHitsOBB` is a proper slab test in each box's local frame. `open`
 * boxes are the one bullet-transparency flag; `roof` boxes are NOT skipped —
 * they stop bullets, LOS and grenades and only players walk through them.
 *
 * The grid path visits cells near to far and preserves the full scan's
 * ascending-index tie breaker explicitly: a tie
 * between two coplanar faces must resolve to the same box, or a shot that
 * splashes on a container in one build splashes on the seam plug behind it in
 * the next.
 *
 * `floorY` is the world plane that stops a downward shot. It was a literal 0.
 */
export function traceWorld(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  solids: OBB[] = ACTIVE_SOLIDS,
  floorY: number = ACTIVE_FLOOR_Y,
): { t: number; hit: OBB | null } {
  let best = maxT;
  let hit: OBB | null = null;
  const g = gridFor(solids);
  if (g) {
    let hitIndex = -1;
    const visitor: GridRayVisitor = {
      maxT,
      visit(index) {
        const o = solids[index]!;
        if (o.open) return;
        const t = rayHitsOBB(ox, oy, oz, dx, dy, dz, o, best);
        // Explicit source order keeps the full scan's coplanar tie breaker.
        if (t < best || (hitIndex >= 0 && t === best && index < hitIndex)) {
          best = visitor.maxT = t;
          hit = o;
          hitIndex = index;
        }
      },
    };
    visitGridRay(g, ox, oz, dx, dz, maxT, visitor);
  } else {
    for (const o of solids) {
      if (o.open) continue;
      const t = rayHitsOBB(ox, oy, oz, dx, dy, dz, o, best);
      if (t < best) {
        best = t;
        hit = o;
      }
    }
  }
  if (oy + dy * best < floorY) {
    const t = (floorY - oy) / dy;
    if (t >= 0 && t < best) return { t, hit: null };
  }
  return { t: best, hit };
}
