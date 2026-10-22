/**
 * Type-only declarations (re-implemented).
 *
 * These mirror the RUNTIME shapes — what the JSON files on disk and the
 * code-built maps actually carry — not the generator's authoring shorthand:
 *
 *   Rect        map bounds, always `{minX, maxX, minZ, maxZ}` (shipment.ts,
 *               ares.ts, dust2.json, nuketown.json all agree). The old
 *               `{x,z,w,d}` spelling never existed at runtime; code that read
 *               `bounds.minX` through the index signature worked while the
 *               type lied, and a regen that emitted `{x,z,w,d}` would have
 *               made every `loX` comparison false — silently disabling the
 *               Nuketown OOB clamp (buildNuketown now asserts all four
 *               finite and min < max, loudly).
 *   FenceRect   frag-fence footprint `{x, z, sx, sz, yaw}`, with the
 *               generator's alternates accepted at the boundary: `{w, d}`
 *               for `{sx, sz}` (normalised in sim.ts NADE_FENCE), and the
 *               dust2 full-OBB extras `{y, sy, top}`.
 *   NavLattice  `{x0, x1, z0, z1, step, linkMax, maxNodes}` (step <= 0 means
 *               the map brings its own nav seeds and wants no lattice).
 */

import type { OBB, Spawn, Waypoint } from "../map";

export type Rect = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

/** Frag-fence rect: footprint or full OBB (top via y/sy), plus optional metadata. */
export type FenceRect = {
  x: number;
  z: number;
  /** full x extent; the generator may emit `w` instead (normalised in sim.ts). */
  sx?: number;
  /** full z extent; the generator may emit `d` instead (normalised in sim.ts). */
  sz?: number;
  /** alternate spellings for sx/sz, accepted at the sim boundary. */
  w?: number;
  d?: number;
  yaw?: number;
  /** footprint corners format | OBB format */
  y?: number;
  sy?: number;
  /** top height above floorY, when the generator emits it explicit */
  top?: number;
  /** bot MAP-geometry fence flag */
  nadeFence?: boolean;
};

export type MinimapRect = {
  x: number;
  z: number;
  sx: number;
  sz: number;
  yaw: number;
  color?: string;
  label?: string;
  /** alpha 0..1 */
  a?: number;
};

/** Nav lattice: cells + seed/link metadata (behavior obtained from map data). */
export type NavLattice = {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  step: number;
  linkMax: number;
  maxNodes: number;
  [key: string]: unknown;
};

/** Map definition contract used by seeds/hosts/modes. */
export type MapDef = {
  id: string;
  name: string;
  /** optional friendly display name for the menu */
  label?: string;
  /** bot MAP-geometry distance multiplier */
  botScale?: number;
  /** seat/team layout for 5v5 / FFA */
  seats?: unknown;
  solids: OBB[];
  floorY: number;
  bounds: Rect;
  spawns: Spawn[];
  navSeeds: Waypoint[];
  navPockets: unknown[];
  navLattice: NavLattice;
  nadeFenceRects: FenceRect[];
  nadeFenceTop: number;
  stackedFloors?: boolean;
  navHeightGate?: number | null;
  climbablesAreFloors?: boolean;
  navLinkPad?: number;
  stepSmoothMax?: number;
  visualContainers?: unknown[];
  minimap?: MinimapRect[];
  minimapImage?: string;
  audioScale?: number;
  qaViews?: unknown[];
  /** everything else comes from the runtime map json (setMapData) */
  [key: string]: unknown;
};
