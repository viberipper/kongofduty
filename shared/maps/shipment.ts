/**
 * SHIPMENT as a MapDef — a 1:1 wrap of what shared/map.ts and shared/sim.ts
 * already produced, and nothing else.
 *
 * Every number in this file is either imported from shared/map.ts or lifted
 * VERBATIM out of the pre-refactor shared/sim.ts. That is the whole point: the
 * refactor is judged by whether a 5000-tick scripted bot match hashes the same
 * before and after (scripts/dustmap/sim-equivalence.mjs), so anything here that
 * is "tidier" than what it replaces is a regression.
 *
 * Three things therefore look odd and are deliberate:
 *
 *  1. `navLattice` reproduces `for (x = -14.6; x <= 14.7; x += 3.55)` as its
 *     four literal bounds and its literal step — NOT as a bounds-derived range.
 *     Repeated `+= 3.55` accumulates float error, and the nav node positions
 *     (hence BOT_NAV, hence BOT_HOP, hence every bot's route) depend on that
 *     exact sequence of doubles.
 *  2. `navPockets` is the 16 hard-coded coordinates that used to sit in
 *     `buildBotNav`, in their original order (`add()` rejects anything within
 *     1.1 m of an already-accepted point, so order is load-bearing).
 *  3. `navHeightGate` is null. See MapDef.navHeightGate — Shipment is one deck
 *     plus knee-high mantle props, and gating links on a 0.5 m height jump
 *     would delete the edges that cross a barrel top.
 */

import { HALF, SOLIDS, SPAWNS, VISUAL_CONTAINERS, WAYPOINTS, YARD } from "../map";
import type { MapDef, MinimapRect } from "./types";

/** map.ts buildSolids(): `const wallH = 2.15; const t = 0.55; const ext = HALF + 0.2;` */
const WALL_T = 0.55;
const WALL_EXT = HALF + 0.2;
const WALL_SPAN = YARD + 2;

/**
 * THE GRENADE FENCE, as data.
 *
 * These four footprints are the four perimeter wall solids map.ts pushes at
 * lines 151-154, transcribed. They used to be found by `SOLIDS.filter(o =>
 * o.visual === "wall")`, in exactly this order, and the order still matters:
 * NADE_SOLIDS is `[...solids, ...fence, ...seams]` and traceWorld resolves ties
 * with a strict `<`, so the first box in the list wins a dead heat.
 *
 * Why a fence exists at all: the container roofs (2.585-2.695 m) sit ABOVE the
 * wall colliders (2.145 m), so a frag that lands on a roof rolls off outboard,
 * clears the wall and detonates 3.2 m outside the yard where no player can be
 * (measured, qa/projectile-truth SW-lob). The fence is an invisible extrusion of
 * the wall faces the player already reads as the map edge.
 */
const FENCE_TOP = 13;

const MINIMAP: MinimapRect[] = VISUAL_CONTAINERS.map((c) => ({
  x: c.x,
  z: c.z,
  sx: c.sx,
  sz: c.sz,
  yaw: c.yaw,
  color: c.color,
}));

export const SHIPMENT: MapDef = {
  id: "shipment",
  name: "JUNGLE SHIPMENT",

  solids: SOLIDS,
  floorY: 0,
  bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },

  nadeFenceRects: [
    { x: 0, z: -WALL_EXT, sx: WALL_SPAN, sz: WALL_T, yaw: 0 },
    { x: 0, z: WALL_EXT, sx: WALL_SPAN, sz: WALL_T, yaw: 0 },
    { x: -WALL_EXT, z: 0, sx: WALL_T, sz: WALL_SPAN, yaw: 0 },
    { x: WALL_EXT, z: 0, sx: WALL_T, sz: WALL_SPAN, yaw: 0 },
  ],
  nadeFenceTop: FENCE_TOP,

  spawns: SPAWNS,
  navSeeds: WAYPOINTS,
  navPockets: [
    [-9.4, -9.6],
    [9.4, -9.6],
    [-9.4, 9.6],
    [9.4, 9.6],
    [0, -9.0],
    [0, 9.0],
    [-8.8, 0],
    [8.8, 0],
    [-14.6, 6.4],
    [14.6, -6.4],
    [-14.6, -6.6],
    [14.6, 6.6],
    [-4.4, 14.4],
    [4.4, -14.4],
    [-13.2, -4.6],
    [13.2, 4.6],
  ],
  // 6.6 m of link against a 3.55 m lattice: 5.02 m on the diagonal, so every
  // neighbour is in reach and the graph is one connected component. 87 nodes.
  navLattice: { x0: -14.6, x1: 14.7, z0: -14.6, z1: 14.7, step: 3.55, linkMax: 6.6, maxNodes: 300 },
  stackedFloors: false,
  navHeightGate: null,

  visualContainers: VISUAL_CONTAINERS,
  minimap: MINIMAP,
  audioScale: 1,
  // THE UNIT MAP, in both senses. Every BOT_TUNING distance in shared/sim.ts was
  // measured on this 33 m yard, so the scale that reproduces them is 1 — and
  // stating it explicitly is what stops the sim falling back to `audioScale` for
  // the answer. Multiplication by 1.0 is exact in IEEE-754, so BOT_RANGE holds
  // the authored literals bit for bit and the equivalence hash cannot move.
  botScale: 1,
};
