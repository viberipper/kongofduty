/**
 * KATANA as a MapDef — a validated adapter over the generated map data
 * (client/static/assets/maps/katana.json, server-local mirror under
 * server/assets/maps/katana.json).
 *
 * Same division of labour as dust2/nuketown: the JSON owns GEOMETRY
 * (colliders, spawns, nav seeds, fence footprints) and this module owns SIM
 * POLICY defaults (fence height, audio/bot scale, nav lattice, height gate).
 * Non-finite numbers throw; thin colliders are counted into KATANA_AUDIT.
 *
 * SCOPE: TDM/FFA/GUN only. The file also ships authored SND/DOM objective
 * and spawn sets — they are validated softly (a regen that drops a site
 * warns into KATANA_AUDIT and rides empty, it never aborts the start — no
 * local mode reads them: this game plays tdm/ffa/gun (shared/modes.ts))
 * and ride the def for the future.
 */
import type { OBB, Spawn, Waypoint } from "../map";
import type { FenceRect, MapDef, MinimapRect, NavLattice, Rect } from "./types";

/** Menu label, needed before the data exists (MAP_OPTIONS is built at import). */
export const KATANA_NAME = "KATANA";

/** Objective pin (bomb site / domination flag), as the generator emits it. */
export type ObjectiveDef = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  r: number;
};

/** Per-mode team spawn sets, as the generator emits them. */
export type SpawnSets = {
  tdm: { west: Spawn[]; east: Spawn[] };
  dom: { west: Spawn[]; east: Spawn[] };
  snd: { attack: Spawn[]; defend: Spawn[] };
  ffa: Spawn[];
};

export type KatanaFile = {
  floorY: number;
  bounds: Rect;
  solids: OBB[];
  spawns: Spawn[];
  ffaSpawns?: Spawn[];
  spawnSets?: SpawnSets;
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
  objectives?: {
    snd?: { sites?: ObjectiveDef[] };
    dom?: { flags?: ObjectiveDef[] };
  };
  stats?: Record<string, unknown>;
  qaViews?: MapDef["qaViews"];
};

export const KATANA_AUDIT = {
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
  if (v === undefined || v === null) throw new Error(`katana map data: missing "${what}"`);
  return v;
}

function objectives(value: ObjectiveDef[] | undefined, ids: readonly string[], label: string): ObjectiveDef[] {
  if (!Array.isArray(value) || value.length !== ids.length) throw new Error(`katana map data: ${label} must contain exactly ${ids.join("/")}`);
  const found = new Set<string>();
  for (const [i, o] of value.entries()) {
    if (!o || typeof o.id !== "string" || typeof o.name !== "string" || !o.name) throw new Error(`katana map data: invalid ${label} ${i}`);
    for (const key of ["x", "y", "z", "r"] as const) if (!Number.isFinite(o[key])) throw new Error(`katana map data: ${label} ${o.id} has non-finite ${key}`);
    if (o.r <= 0) throw new Error(`katana map data: ${label} ${o.id} has non-positive radius`);
    if (found.has(o.id)) throw new Error(`katana map data: duplicate ${label} ${o.id}`);
    found.add(o.id);
  }
  for (const id of ids) if (!found.has(id)) throw new Error(`katana map data: ${label} is missing ${id}`);
  return value;
}

function spawnGroup(value: Spawn[] | undefined, label: string): Spawn[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`katana map data: spawn set ${label} is empty`);
  for (const [i, s] of value.entries()) {
    if (!s) throw new Error(`katana map data: invalid spawn ${label} ${i}`);
    for (const key of ["x", "y", "z", "yaw"] as const) if (!Number.isFinite(s[key])) throw new Error(`katana map data: spawn ${label} ${i} has non-finite ${key}`);
  }
  return value;
}

export function buildKatana(raw: unknown): MapDef {
  const f = raw as KatanaFile;
  const solids = need(f.solids, "solids").map((o) =>
    o.visual === "boundary" && !o.open ? { ...o, open: true } : o.visual === "railing" && o.sy < 1.2 ? { ...o, vault: true } : o,
  );
  const bounds = need(f.bounds, "bounds");
  const spawns = need(f.spawns, "spawns");
  if (!solids.length) throw new Error("katana map data: solids is empty");
  if (!spawns.length) throw new Error("katana map data: spawns is empty");
  const A = KATANA_AUDIT;
  A.built = true;
  A.solids = solids.length;
  A.spawns = spawns.length;
  A.warnings.length = 0;
  A.climb = 0;
  A.thin = 0;
  for (let i = 0; i < solids.length; i++) {
    const o = solids[i]!;
    for (const k of ["x", "y", "z", "sx", "sy", "sz", "yaw"] as const) {
      if (!Number.isFinite(o[k])) throw new Error(`katana map data: solid ${i} has non-finite ${k}`);
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
    step: L.step ?? 0,
    linkMax: L.linkMax ?? 4.8,
    maxNodes: Math.max(L.maxNodes ?? 0, navSeeds.length + 60, 2200),
  };
  const nadeFenceTop = f.nadeFenceTop ?? 32;
  if (nadeFenceTop < 30) A.warnings.push(`nadeFenceTop ${nadeFenceTop} < 30`);
  // SND/DOM sets ride the def for the future; no local mode reads them
  // (tdm/ffa/gun only), so a regen that drops a site warns — it never aborts
  // the start over an unplayed mode.
  let bombsites: ObjectiveDef[] = [];
  let flags: ObjectiveDef[] = [];
  let spawnSets: SpawnSets | undefined;
  try {
    const generatedObjectives = need(f.objectives, "objectives");
    bombsites = objectives(generatedObjectives.snd?.sites, ["A", "B"], "bomb sites");
    flags = objectives(generatedObjectives.dom?.flags, ["A", "B", "C"], "domination flags");
    spawnSets = need(f.spawnSets, "spawnSets");
    const tdm = need(spawnSets.tdm, "spawnSets.tdm");
    const dom = need(spawnSets.dom, "spawnSets.dom");
    const snd = need(spawnSets.snd, "spawnSets.snd");
    spawnGroup(tdm.west, "tdm.west");
    spawnGroup(tdm.east, "tdm.east");
    spawnGroup(dom.west, "dom.west");
    spawnGroup(dom.east, "dom.east");
    spawnGroup(snd.attack, "snd.attack");
    spawnGroup(snd.defend, "snd.defend");
    spawnGroup(spawnSets.ffa, "ffa");
  } catch (err) {
    A.warnings.push(`SND/DOM sets skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    id: "katana",
    name: KATANA_NAME,
    solids,
    floorY: f.floorY ?? -8,
    bounds,
    objectives: { bombsites, flags },
    spawnSets,
    nadeFenceRects: f.nadeFenceRects ?? [],
    nadeFenceTop,
    spawns,
    // Authored FFA points ride the def so shared/sim.ts seeds FFA from them
    // instead of the two team-side pools — neutral throughout like
    // dust2/nuketown: a future file that tags a side still yields teamless
    // FFA points (team: 0), never a side pool.
    ffaSpawns: (f.ffaSpawns ?? []).map((s) => ({
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw ?? 0,
      team: 0 as const,
    })),
    navSeeds,
    navPockets: [],
    navLattice,
    stackedFloors: f.stackedFloors ?? true,
    navHeightGate: f.navHeightGate === undefined ? 0.5 : f.navHeightGate,
    climbablesAreFloors: f.climbablesAreFloors ?? true,
    navLinkPad: f.navLinkPad ?? 0.05,
    stepSmoothMax: f.stepSmoothMax ?? 0.9,
    visualContainers: [],
    minimap: f.minimap ?? [],
    minimapImage: f.minimapImage ?? "assets/maps/katana-radar.png",
    audioScale: f.audioScale ?? 2,
    botScale: f.botScale ?? 1.8,
    qaViews: f.qaViews ?? [],
  };
}
