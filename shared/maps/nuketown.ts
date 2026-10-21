/**
 * NUKETOWN as a MapDef — a validated adapter over the generated map data
 * (static/assets/maps/nuketown.json, written by scripts/nuketown/build-map.mts).
 *
 * The JSON owns GEOMETRY and the sampled nav/spawn sets (all generated from the
 * Blender build of the SketchUp source, see assets-3d/nuketown/README.md);
 * this module owns SIM POLICY defaults and refuses bad data loudly:
 * non-finite numbers throw, colliders under 0.10 m are counted into the audit.
 *
 * FRAME (assets-3d/nuketown/FRAME.md): metres, y up; origin = centre of the
 * cul-de-sac on the street asphalt (y = 0); lawns / sidewalks / house ground
 * floors are 0.22 m climbable slabs, so the street is the one place a body
 * stands on the floor plane. Green house west (-x), yellow house east (+x),
 * the road leaves the map to the south (+z).
 *
 * Two storeys per house: `stackedFloors` is on and every nav seed carries the
 * height of its storey (Waypoint.y), which is what lets bots tell the kitchen
 * from the bedroom above it (shared/sim.ts NAV_Y).
 */
import type { OBB, Spawn, Waypoint } from "../map";
import type { FenceRect, MapDef, MinimapRect, NavLattice, Rect } from "./types";

export const NUKETOWN_NAME = "NUKETOWN";

export type NuketownFile = {
  floorY: number;
  bounds: Rect;
  solids: OBB[];
  spawns: Spawn[];
  ffaSpawns?: Spawn[];
  nadeFenceRects?: FenceRect[];
  nadeFenceTop?: number;
  navSeeds?: { x: number; z: number; y?: number; cover?: boolean }[];
  navLattice?: Partial<NavLattice>;
  navHeightGate?: number | null;
  navLinkPad?: number;
  stackedFloors?: boolean;
  climbablesAreFloors?: boolean;
  stepSmoothMax?: number;
  audioScale?: number;
  botScale?: number;
  minimapImage?: string;
  minimap?: MinimapRect[];
  placements?: unknown[];
  hiddenStandins?: string[];
  stats?: Record<string, unknown>;
  qaViews?: MapDef["qaViews"];
};

export const NUKETOWN_AUDIT = {
  built: false,
  solids: 0,
  climb: 0,
  thin: 0,
  spawns: 0,
  navSeeds: 0,
  maxY: -Infinity,
  warnings: [] as string[],
};

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`nuketown map data: missing "${what}" (run scripts/nuketown/build-map.mts)`);
  return v;
}

export function buildNuketown(raw: unknown): MapDef {
  const f = raw as NuketownFile;
  const solids = need(f.solids, "solids");
  const bounds = need(f.bounds, "bounds");
  const spawns = need(f.spawns, "spawns");
  const floorY = f.floorY ?? 0;
  if (!solids.length) throw new Error("nuketown map data: solids is empty");
  if (!spawns.length) throw new Error("nuketown map data: spawns is empty");
  const A = NUKETOWN_AUDIT;
  A.built = true;
  A.solids = solids.length;
  A.spawns = spawns.length;
  A.warnings.length = 0;
  A.climb = 0;
  A.thin = 0;
  for (let i = 0; i < solids.length; i++) {
    const o = solids[i]!;
    for (const k of ["x", "y", "z", "sx", "sy", "sz", "yaw"] as const) {
      if (!Number.isFinite(o[k])) throw new Error(`nuketown map data: solid ${i} has non-finite ${k}`);
    }
    if (Math.min(o.sx, o.sy, o.sz) < 0.1 - 1e-6) A.thin += 1;
    if (o.climb) A.climb += 1;
    A.maxY = Math.max(A.maxY, o.y + o.sy / 2);
  }
  if (A.thin) A.warnings.push(`${A.thin} collider(s) thinner than 0.10 m`);
  const navSeeds: Waypoint[] = (f.navSeeds ?? []).map((w) =>
    w.y === undefined ? { x: w.x, z: w.z, cover: w.cover ?? false } : { x: w.x, z: w.z, y: w.y, cover: w.cover ?? false },
  );
  A.navSeeds = navSeeds.length;
  const L = f.navLattice ?? {};
  const navLattice: NavLattice = {
    x0: L.x0 ?? bounds.minX,
    x1: L.x1 ?? bounds.maxX,
    z0: L.z0 ?? bounds.minZ,
    z1: L.z1 ?? bounds.maxZ,
    // the generator samples the whole reachable floor of every storey; a
    // top-surface lattice on top of it would only re-add upstairs points
    step: L.step ?? 0,
    linkMax: L.linkMax ?? 4.8,
    maxNodes: Math.max(L.maxNodes ?? 0, navSeeds.length + 60, 480),
  };
  const nadeFenceTop = f.nadeFenceTop ?? 26;
  if (nadeFenceTop < 24) A.warnings.push(`nadeFenceTop ${nadeFenceTop} < 24`);
  return {
    id: "nuketown",
    name: NUKETOWN_NAME,
    solids,
    floorY,
    bounds,
    nadeFenceRects: f.nadeFenceRects ?? [],
    nadeFenceTop,
    spawns,
    navSeeds,
    navPockets: [],
    navLattice,
    stackedFloors: f.stackedFloors ?? true,
    navHeightGate: f.navHeightGate === undefined ? 0.5 : f.navHeightGate,
    climbablesAreFloors: f.climbablesAreFloors ?? true,
    navLinkPad: f.navLinkPad,
    stepSmoothMax: f.stepSmoothMax ?? 0.9,
    visualContainers: [],
    minimap: f.minimap ?? [],
    minimapImage: f.minimapImage ?? "assets/maps/nuketown-radar.png",
    audioScale: f.audioScale ?? 1.6,
    botScale: f.botScale ?? 1.5,
    qaViews: f.qaViews ?? [],
  };
}
