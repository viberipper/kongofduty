/**
 * DUST2 as a MapDef — a validated adapter over the generated collider set.
 *
 * THERE IS NO GEOMETRY IN THIS FILE ON PURPOSE, and the division of labour is
 * the point: the JSON owns GEOMETRY (colliders, spawns, nav seeds and links,
 * fence footprints, minimap rects) because it is generated from the source mesh
 * by a separate pass, and this module owns SIM POLICY (fence height, audio
 * scale, nav lattice and link range, the height gates) because those are tuned
 * against how the simulation behaves, not against what the mesh looks like.
 * Every policy value here is overridable by the JSON, so the generator can take
 * one over the moment it has a better answer, and dropping a new data file in is
 * live with no code change either way.
 *
 * THE DATA IS NOT IMPORTED HERE — THAT IS THE WHOLE POINT OF `buildDust2`.
 * A static `import RAW from "../../docs/dustmap/colliders.json"` put the entire
 * collider set in the main bundle for every client, including the ones loading
 * Shipment: measured at +266.6 kB raw / +39.3 kB gzip on a page whose budget is
 * ~1.1 MB (docs/dustmap/spec-sim-implemented.md §9 P0). The set now ships as
 * `static/assets/maps/dust2.json` and is handed to this factory by
 * `preloadMapData()` in ./index.ts, which runs BEFORE anything imports
 * shared/sim.ts. Shipment never fetches it at all.
 *
 * FRAME (locked, docs/dustmap/CONSTRAINTS.md): raw GLB game-space,
 * `gx = lx*0.0254, gy = -ly*0.0254, gz = -lz*0.0254`. No recentring, no y-lift —
 * so the map's lowest floor sits at -4.877 m (the roofed sunken hall at the
 * south end of Long A) and `floorY` is -4.95, which is exactly why the sim's
 * implicit y = 0 plane had to become per-map data.
 *
 * WHAT THIS FILE REFUSES TO DO: silently repair bad data. Non-finite numbers
 * throw (a NaN collider is a body teleported to nowhere three frames into a
 * match). Everything else that violates the authoring rules in CONSTRAINTS.md —
 * colliders under 0.10 m thick, a nade fence that does not clear the crest — is
 * COUNTED into `DUST2_AUDIT` and reported, so the qa pass has numbers to gate on
 * rather than a boot that either works or does not.
 */

import type { OBB, Spawn, VisualContainer, Waypoint } from "../map";
import type { FenceRect, MapDef, MinimapRect, NavLattice, Rect } from "./types";
// Bounds-span pin reads the body radius from shared/movement.ts (leaf — NOT
// from shared/sim.ts: a maps->sim value import is a module cycle that breaks
// the esbuild server bundle; sim.ts re-exports the same binding).
import { RADIUS as SIM_RADIUS } from "../movement";

/** Menu label, needed before the data exists (MAP_OPTIONS is built at import). */
export const DUST2_NAME = "DUST2";

/**
 * The on-disk shape. `solids`, `bounds`, `floorY` and `spawns` are required;
 * everything else has a policy default below. Fence rects may arrive as bare
 * footprints or as full OBBs (the generator emits `y`/`sy` too) — both are
 * accepted and the top is taken from whichever is present.
 */
export type ColliderFile = {
  stub?: boolean;
  floorY: number;
  bounds: Rect;
  solids: OBB[];
  spawns: Spawn[];
  /** Authored teamless FFA points (mid-map, teamless); validated + hashed like Nuketown's. */
  ffaSpawns?: Spawn[];
  nadeFenceRects?: (FenceRect & { y?: number; sy?: number })[];
  nadeFenceTop?: number;
  audioScale?: number;
  /** Bot MAP-GEOMETRY distance multiplier (MapDef.botScale). Defaults to 2.2. */
  botScale?: number;
  navLattice?: Partial<NavLattice>;
  navSeeds?: { x: number; z: number; y?: number; cover?: boolean }[];
  navLinks?: [number, number][];
  navPockets?: [number, number][];
  navHeightGate?: number | null;
  navLinkPad?: number;
  stackedFloors?: boolean;
  stepSmoothMax?: number;
  climbablesAreFloors?: boolean;
  visualContainers?: VisualContainer[];
  minimap?: MinimapRect[] | { rects: MinimapRect[] };
  /** Pre-rendered radar for the HUD (MapDef.minimapImage). Policy default below. */
  minimapImage?: string;
  stats?: Record<string, unknown>;
};

/**
 * Data-quality readout. Instruments and the qa gate read this; nothing in the
 * sim branches on it. Populated by `buildDust2`, so it reads zeroes until the
 * map is actually built — `built` says which.
 */
export const DUST2_AUDIT = {
  built: false,
  solids: 0,
  climb: 0,
  /** Colliders under 0.10 m on their thinnest axis — the no-CCD tunnelling limit. */
  thin: 0,
  thinnest: Infinity,
  /** Highest and lowest collider surface, for the fence and the camera. */
  minY: Infinity,
  maxY: -Infinity,
  spawns: 0,
  navSeeds: 0,
  navLinks: 0,
  nadeFenceTop: 0,
  floorY: 0,
  warnings: [] as string[],
};

/** True while the shipped data is still the placeholder arena. */
export let DUST2_IS_STUB = false;

/**
 * Geometry hash of the raw dust2 file (security M1): FNV-1a over count +
 * per-box (x,y,z,sx,sy,sz,yaw,climb,visual,open,color), quantised to
 * millimetres, plus the bounds rect, the fence footprints + top, floorY +
 * storey policy, the nav lattice (x0/x1/z0/z1/step/linkMax/maxNodes) +
 * seeds + pockets, team spawns, and the bot/audio scales. Mirrors
 * nuketownGeoHash's coverage (null navHeightGate distinct from undefined via
 * a sentinel no finite gate collides with) so a one-side regen retune is a
 * hash desync, never a silent prediction-vs-authority divergence. Compare in
 * CI (`npm run check:dust2` builds BOTH copies and fails when
 * clientGeo !== serverGeo).
 */
export function dust2GeoHash(raw: unknown): string {
  const f = raw as ColliderFile;
  let h = 2166136261 >>> 0;
  // NON-FINITE SENTINEL (review LOW): every non-finite input mixes one word,
  // 0x7fffffff. It is distinct from every finite height OVER THE MAP DOMAIN
  // (Math.round(y * 1000) hits 0x7fffffff only at ~2147483.647 m — no map
  // spans kilometres), but the non-finite spellings alias each other here by
  // design: NaN, Infinity and -Infinity all hash to the same word. That is
  // sound because every one of them THROWS at build (see buildDust2's
  // finite-checks) — no two different builds can share this word, since no
  // build with a non-finite coordinate exists.
  const mix = (n: number): void => {
    const v = Number.isFinite(n) ? Math.round(n * 1000) : 0x7fffffff;
    h ^= v & 0xffffffff;
    h = Math.imul(h, 16777619);
  };
  const mixStr = (s: string | undefined): void => {
    const t = s ?? "";
    for (let k = 0; k < t.length; k++) {
      h ^= t.charCodeAt(k);
      h = Math.imul(h, 16777619);
    }
  };
  const solids = (f as { solids?: OBB[] }).solids ?? [];
  mix(solids.length);
  for (const o of solids) {
    mix(o.x);
    mix(o.y);
    mix(o.z);
    mix(o.sx);
    mix(o.sy);
    mix(o.sz);
    mix(o.yaw);
    mix(o.climb ? 1 : 0);
    mixStr(o.visual);
    mix(o.open ? 1 : 0);
    mixStr(o.color);
  }
  const b = f.bounds as { minX: number; maxX: number; minZ: number; maxZ: number } | undefined;
  mix(b?.minX ?? NaN);
  mix(b?.maxX ?? NaN);
  mix(b?.minZ ?? NaN);
  mix(b?.maxZ ?? NaN);
  for (const r of f.nadeFenceRects ?? []) {
    mix(r.x);
    mix(r.z);
    mix(r.sx ?? r.w ?? 0);
    mix(r.sz ?? r.d ?? 0);
    mix(r.yaw ?? 0);
    // FENCE-TOP INPUT PIN (review HIGH): buildDust2 derives nadeFenceTop from
    // r.y/sy when the file omits nadeFenceTop, so footprints alone do not
    // determine the build — two files with equal footprints but different y/sy
    // extrude different fences. Mix them too (absent mixes the NaN sentinel,
    // distinct from any finite height, exactly like the lattice NaNs below).
    mix((r as { y?: number }).y ?? NaN);
    mix((r as { sy?: number }).sy ?? NaN);
    // EXPLICIT TOP (review LOW-1 / MEDIUM): the builder honours a finite r.top
    // over the y/sy derivation (see fenceTopFromFile), so a top-bearing file
    // must hash different from the same footprints without one. Mixed
    // CONDITIONALLY on finiteness: absent on every shipped file, where an
    // unconditional sentinel round would move the pinned geo without changing
    // the build — while any finite top still perturbs the hash, so a generator
    // that starts emitting tops can never collide with the bare-footprint file
    // it refines. A PRESENT-BUT-NON-FINITE top (NaN/Infinity) is ignored by
    // the builder (Number.isFinite gate in fenceTopFromFile) and therefore
    // ignored here too: the old `!== undefined` mixed an extra sentinel word
    // for a file that builds identically — a false desync.
    const rTop = (r as { top?: number }).top;
    if (Number.isFinite(rTop)) mix(rTop);
  }
  mix(f.nadeFenceTop ?? 26);
  mix(f.navLinkPad ?? 0.15);
  if (f.navHeightGate === null) mix(0x7ffffffe);
  else mix(f.navHeightGate ?? 0.5);
  mix(f.floorY ?? 0);
  mix((f.stackedFloors ?? true) ? 1 : 0);
  mix((f.climbablesAreFloors ?? true) ? 1 : 0);
  mix(f.stepSmoothMax ?? 0.9);
  mix(f.botScale ?? 2.2);
  mix(f.audioScale ?? 2.2);
  const L = f.navLattice ?? {};
  mix(L.x0 ?? NaN);
  mix(L.x1 ?? NaN);
  mix(L.z0 ?? NaN);
  mix(L.z1 ?? NaN);
  mix(L.step ?? 0);
  mix(L.linkMax ?? 0);
  mix(L.maxNodes ?? 0);
  const seeds = f.navSeeds ?? [];
  mix(seeds.length);
  for (const w of seeds) {
    mix(w.x);
    mix(w.z);
    // Y-ABSENT ≠ Y-ZERO (review HIGH-1): buildDust2 maps `y === undefined` to
    // a flat seed but preserves a finite y, and NAV_Y is stackedFloors &&
    // seeds.some(w => w.y !== undefined) — so an explicit y:0 seed builds a
    // storey-aware graph while an omitted-y seed builds flat, and the old
    // `?? 0` hashed both to the same word. Absent mixes the NaN sentinel
    // (0x7fffffff, distinct from every finite height — the same convention as
    // the fence/lattice NaNs above), so the two spellings hash different.
    mix(w.y ?? NaN);
    mix(w.cover ? 1 : 0);
  }
  const pockets = f.navPockets ?? [];
  mix(pockets.length);
  for (const pk of pockets) {
    mix(pk[0]);
    mix(pk[1]);
  }
  const spawns = f.spawns ?? [];
  mix(spawns.length);
  for (const s of spawns) {
    mix(s.x);
    mix(s.z);
    // MISSING-y ≠ y:0 (review MEDIUM-4): spawn() resolves the floor from
    // walkFromY(best.y) — an absent y walks from NaN (no floor, the storey
    // fallback refuses the point) while y:0 walks from the ground storey. The
    // old `?? 0` hashed both spellings to the same word while the runtime
    // built different spawns. Absent now mixes the NaN sentinel (distinct
    // from y:0, like the seed y's above); a present-but-non-finite y throws
    // at build, so no silent collision hides behind the shared sentinel.
    mix((s as { y?: number }).y ?? NaN);
    mix((s as { yaw?: number }).yaw ?? 0);
    mix((s as { team?: number }).team ?? 0);
  }
  const ffa = f.ffaSpawns ?? [];
  mix(ffa.length);
  for (const s of ffa) {
    mix(s.x);
    mix(s.z);
    mix((s as { y?: number }).y ?? NaN);
    mix((s as { yaw?: number }).yaw ?? 0);
    mix((s as { team?: number }).team ?? 0);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function required<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) {
    throw new Error(`dust2 map data: missing "${what}" — see the ColliderFile type in shared/maps/dust2.ts`);
  }
  return v;
}

/**
 * Validate one generated collider file into a MapDef. Called once, by
 * `activeMap()`, after `preloadMapData()` has put the file in memory.
 */
export function buildDust2(raw: unknown): MapDef {
  const file = raw as ColliderFile;
  const solids = required(file.solids, "solids");
  const bounds = required(file.bounds, "bounds");
  const floorY = required(file.floorY, "floorY");
  const spawns = required(file.spawns, "spawns");
  // BOUNDS ARE LOAD-BEARING (security B): a regen that emits the old
  // {x,z,w,d} spelling (or any NaN) makes every minX/maxX comparison false,
  // which silently disables every bounds-clamped system. Existence is not
  // enough — assert all four finite and ordered, like buildNuketown.
  for (const k of ["minX", "maxX", "minZ", "maxZ"] as const) {
    if (!Number.isFinite(bounds[k]))
      throw new Error(`dust2 map data: bounds.${k} is not finite (got ${bounds[k]})`);
  }
  if (!(bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ))
    throw new Error(
      `dust2 map data: bounds inverted (minX ${bounds.minX} maxX ${bounds.maxX} minZ ${bounds.minZ} maxZ ${bounds.maxZ})`,
    );
  // DEGENERATE SPAN PIN (same contract as buildNuketown): finite + ordered is
  // not enough — a sub-body span insets to an empty clamp that teleports every
  // tick. Both axes must fit a body (2*RADIUS).
  if (!(bounds.maxX - bounds.minX > 2 * SIM_RADIUS && bounds.maxZ - bounds.minZ > 2 * SIM_RADIUS))
    throw new Error(
      `dust2 map data: bounds span too small for a body (dx ${bounds.maxX - bounds.minX} dz ${bounds.maxZ - bounds.minZ}, need > ${2 * SIM_RADIUS})`,
    );
  if (!Array.isArray(solids) || solids.length === 0) throw new Error("dust2 map data: solids is empty");
  if (!Array.isArray(spawns) || spawns.length === 0) throw new Error("dust2 map data: spawns is empty");
  // PER-TEAM POOL PIN (security LOW-2 / review MEDIUM-3): spawn() team-filters
  // this pool before scoring, and on a flat map an empty side throws on
  // pool[0] — a regen that drops a whole side should fail here, not at the
  // first team spawn. Scoped to team-mode data: FFA ignores teams entirely
  // (sim spawnPool draws the whole pool for "ffa"), so a future FFA-only file
  // that ships ffaSpawns instead of per-side spawns is not failed for lacking
  // sides it never fields. Shipped data carries both sides, so this only fires
  // on drift.
  if (!Array.isArray(file.ffaSpawns) || file.ffaSpawns.length === 0) {
    for (const t of [0, 1] as const) {
      if (!spawns.some((s) => (s as { team?: number }).team === t))
        throw new Error(`dust2 map data: no spawns for team ${t}`);
    }
  }
  // SEED/SPAWN NUMERICS (review HIGH-3 / MEDIUM-3): solids are strictly
  // checked below, but a non-finite seed y used to hash like an absent y while
  // BUILDING differently (w.y === undefined → flat seed, y: NaN → fy NaN → a
  // groundHeight limit of NaN that filters every edge — same hash, different
  // graph), and a non-finite spawn coordinate hashed a sentinel while the
  // runtime integrated it. Throw here instead: no silent divergence either way.
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i]! as Spawn & { yaw?: number; team?: number };
    for (const k of ["x", "y", "z"] as const) {
      if (!Number.isFinite(s[k])) throw new Error(`dust2 map data: spawn ${i} has non-finite ${k}`);
    }
    if (s.yaw !== undefined && !Number.isFinite(s.yaw)) throw new Error(`dust2 map data: spawn ${i} has non-finite yaw`);
    if (s.team !== undefined && s.team !== 0 && s.team !== 1)
      throw new Error(`dust2 map data: spawn ${i} has bad team ${s.team}`);
  }
  for (let i = 0; i < (file.ffaSpawns ?? []).length; i++) {
    const s = file.ffaSpawns![i]! as Spawn & { yaw?: number; team?: number };
    for (const k of ["x", "y", "z"] as const) {
      if (!Number.isFinite(s[k])) throw new Error(`dust2 map data: ffaSpawn ${i} has non-finite ${k}`);
    }
    if (s.yaw !== undefined && !Number.isFinite(s.yaw)) throw new Error(`dust2 map data: ffaSpawn ${i} has non-finite yaw`);
  }
  for (let i = 0; i < (file.navSeeds ?? []).length; i++) {
    const w = file.navSeeds![i]!;
    if (!Number.isFinite(w.x) || !Number.isFinite(w.z))
      throw new Error(`dust2 map data: navSeed ${i} has non-finite x/z`);
    if (w.y !== undefined && !Number.isFinite(w.y))
      throw new Error(`dust2 map data: navSeed ${i} has non-finite y`);
  }
  for (let i = 0; i < (file.navPockets ?? []).length; i++) {
    const pk = file.navPockets![i]!;
    if (!Number.isFinite(pk[0]) || !Number.isFinite(pk[1]))
      throw new Error(`dust2 map data: navPocket ${i} is non-finite`);
  }

  const A = DUST2_AUDIT;
  A.built = true;
  // FLOOR IS LOAD-BEARING (security HIGH-2/M1): the sim clamps bodies and
  // extrudes the frag fence from it. Existence is not enough — a NaN floor
  // silently ungrounds every system that reads it.
  if (!Number.isFinite(floorY)) throw new Error(`dust2 map data: floorY is not finite (got ${floorY})`);
  A.solids = solids.length;
  A.climb = 0;
  A.thin = 0;
  A.thinnest = Infinity;
  A.minY = Infinity;
  A.maxY = -Infinity;
  A.warnings.length = 0;
  A.floorY = floorY;
  A.spawns = spawns.length;

  for (let i = 0; i < solids.length; i++) {
    const o = solids[i]!;
    for (const k of ["x", "y", "z", "sx", "sy", "sz", "yaw"] as const) {
      if (!Number.isFinite(o[k])) throw new Error(`dust2 map data: solid ${i} has non-finite ${k}`);
    }
    if (o.sx <= 0 || o.sy <= 0 || o.sz <= 0) throw new Error(`dust2 map data: solid ${i} has a non-positive size`);
    const t = Math.min(o.sx, o.sy, o.sz);
    if (t < A.thinnest) A.thinnest = t;
    if (t < 0.1) A.thin += 1;
    if (o.climb) A.climb += 1;
    A.minY = Math.min(A.minY, o.y - o.sy * 0.5);
    A.maxY = Math.max(A.maxY, o.y + o.sy * 0.5);
  }
  if (A.thin > 0) {
    A.warnings.push(
      `${A.thin} collider(s) under 0.10 m thick (thinnest ${A.thinnest.toFixed(3)} m) — movement substeps are 0.023-0.034 m and there is no CCD, so bodies tunnel these`,
    );
  }
  // The world floor plane must sit INSIDE the walls, i.e. at or above the bottom
  // of the lowest box. If the boxes stopped above it, a body that walked off a
  // ledge would land on the plane BELOW every wall and stroll out of the map.
  if (!(A.minY <= floorY + 1e-6)) {
    A.warnings.push(
      `floorY ${floorY} is BELOW the lowest collider bottom ${A.minY.toFixed(3)} — a body that falls to the floor plane is under every wall box and can leave the map`,
    );
  }

  // --- fence ----------------------------------------------------------------
  // Accept both shapes. A generator that already extruded the rects tells us its
  // own top; a bare footprint list gets the policy default. Footprints accept
  // the generator's alternates in ONE place (sx/sz vs w/d, normalised here —
  // review LOW): sim.ts reads r.sx/sz with no fallback, so a dropped spelling
  // would be a NaN collider there.
  const rawFence = file.nadeFenceRects ?? [];
  const nadeFenceRects: FenceRect[] = rawFence.map((r, i) => {
    const sx = r.sx ?? r.w;
    const sz = r.sz ?? r.d;
    for (const [k, v] of [["x", r.x], ["z", r.z], ["sx", sx], ["sz", sz]] as const) {
      if (!Number.isFinite(v)) throw new Error(`dust2 map data: nadeFenceRect ${i} has non-finite ${k}`);
    }
    if (!(sx! > 0 && sz! > 0)) throw new Error(`dust2 map data: nadeFenceRect ${i} has non-positive size`);
    return { x: r.x, z: r.z, sx: sx!, sz: sz!, yaw: r.yaw ?? 0 };
  });
  const fenceTopFromFile = rawFence.reduce((top, r) => {
    // An explicit per-rect `top` (FenceRect.top) is honoured when finite and
    // beats the y/sy derivation for that rect (review LOW-1: the old code
    // silently fell back to 26 m on a generator that emits tops); otherwise
    // y/sy, otherwise the 26 m policy default. All three spellings are hashed
    // (see dust2GeoHash), so switching spellings desyncs loudly instead of
    // silently rebuilding the same default.
    const explicit = (r as { top?: number }).top;
    if (Number.isFinite(explicit)) return Math.max(top, explicit as number);
    return r.y !== undefined && r.sy !== undefined ? Math.max(top, r.y + r.sy * 0.5) : top;
  }, -Infinity);
  /**
   * The frag fence has to top out above the map crest (10.566 m) plus the height
   * a lob adds, or a frag thrown at the boundary sails over an invisible wall the
   * player cannot see and detonates outside the world. 24 m is the floor.
   */
  const nadeFenceTop = file.nadeFenceTop ?? (Number.isFinite(fenceTopFromFile) ? fenceTopFromFile : 26);
  A.nadeFenceTop = nadeFenceTop;
  // FENCE TOP IS LOAD-BEARING (security HIGH-2/M2, MEDIUM-4): the frag fence
  // has to top out above the map crest (10.566 m) plus the height a lob adds,
  // or a frag sails over an invisible wall the player cannot see and
  // detonates outside the world. 24 m is the floor — finite-checked and
  // THROWN here (data layer) and in sim.ts NADE_FENCE (import layer), both.
  // Warning-only used to let a bad top build green; it now fails loudly.
  if (!Number.isFinite(nadeFenceTop) || !(nadeFenceTop >= 24)) {
    throw new Error(`dust2 map data: nadeFenceTop must be a finite number >= 24 (got ${nadeFenceTop}; crest 10.6 + lob)`);
  }
  if (!(nadeFenceTop - floorY > 0)) {
    throw new Error(`dust2 map data: nadeFenceTop ${nadeFenceTop} does not clear floorY ${floorY}`);
  }
  if (nadeFenceRects.length === 0) {
    // EMPTY FENCE THROWS (security M1, same pin as buildNuketown): an empty
    // list builds green while lobs sail over every low boundary into the void.
    // Warning-only used to let that hole through; it now fails loudly.
    throw new Error("dust2 map data: no nadeFenceRects — a lobbed frag can leave the map wherever the boundary is low");
  }

  // --- nav ------------------------------------------------------------------
  // Storey height is preserved exactly like buildNuketown (review HIGH): the
  // seeded `y` is what lets bots tell one deck from the one above it
  // (shared/sim.ts NAV_Y on a stacked-floors map). Dropping it hashed y but
  // never built it — NAV_Y always false on dust2 while the hash claimed
  // coverage. `y === undefined` keeps the old flat-seed spelling (Shipment
  // behaviour); a finite y rides the seed into the planner.
  const navSeeds: Waypoint[] = (file.navSeeds ?? []).map((w) =>
    w.y === undefined ? { x: w.x, z: w.z, cover: w.cover ?? false } : { x: w.x, z: w.z, y: w.y, cover: w.cover ?? false },
  );
  A.navSeeds = navSeeds.length;
  A.navLinks = file.navLinks?.length ?? 0;

  /**
   * THE LATTICE, or the deliberate absence of one.
   *
   * `buildBotNav` fills leftover standing room with a coarse lattice because
   * Shipment ships 19 authored lane seeds for a 33 m yard. The dust2 generator
   * emits its OWN sampled nav set — 380 seeds grown along the walkable graph so
   * that the `botLinkClear` graph is ONE connected component (measured in
   * docs/dustmap/audit-colliders.json `D_rules.nav`) — which IS the lattice, so
   * `step: 0` turns the built-in one off rather than doubling up and blowing the
   * node cap.
   *
   * `linkMax` is NOT a rule of thumb here: it is the range the generator
   * validated the seed set at, shipped in the file. Shrink it and the graph
   * fragments; the seeds were chosen for this number.
   */
  const seedSpacing = Number((file.stats as { navSpacing?: number } | undefined)?.navSpacing ?? 5.55);
  const latticeIn = file.navLattice ?? {};
  // LINK-PAD PIN (review LOW, symmetric with buildNuketown's door-corridor
  // pin): botLinkClear plans at BOT_CLEAR_R + (navLinkPad ?? 0.15), so a regen
  // that drops the field widens the validation corridor and rebuilds a
  // different edge set — but the geo hash mixes navLinkPad, so that drift
  // desyncs loudly in CI. What the hash cannot catch is a present-but-
  // non-finite pad (mix maps every non-finite to one sentinel word while the
  // planner reads NaN), so that throws here, like Nuketown's NaN pad. The
  // corridor width itself is validated by the edge audit downstream, not by a
  // door literal: dust2's openings are not one width.
  if (file.navLinkPad !== undefined && (!Number.isFinite(file.navLinkPad) || file.navLinkPad < 0))
    throw new Error(`dust2 map data: navLinkPad is not a finite non-negative number (got ${file.navLinkPad})`);
  const navLattice: NavLattice = {
    x0: latticeIn.x0 ?? bounds.minX,
    x1: latticeIn.x1 ?? bounds.maxX,
    z0: latticeIn.z0 ?? bounds.minZ,
    z1: latticeIn.z1 ?? bounds.maxZ,
    step: latticeIn.step ?? (navSeeds.length >= 120 ? 0 : 9),
    linkMax: latticeIn.linkMax ?? +(seedSpacing * 1.45).toFixed(3),
    // 480 — A FLOOR, NOT A DEFAULT, and the file cannot set it lower.
    //
    // The cap was written to guard BOT_HOP's dense Floyd-Warshall table, O(n^3)
    // at module import in the browser. Above HOP_DENSE_MAX (128) nodes that
    // table no longer exists: the router runs one lazy Dijkstra from the goal
    // and caches the column (400 nodes = 1.13 ms edge scan at import, 0.308 ms
    // worst cold query, 0.019 us warm — build-w3-gameplay.md §3). So the O(n^3)
    // fear this number encoded is gone, and what is left is a sanity ceiling on
    // the DATA that needs headroom over the shipped 380 seeds — 100 nodes of it.
    //
    // The floor matters because exceeding the cap is a MODULE-SCOPE THROW that
    // takes ?map=dust2 down completely, and it has already happened once for
    // real: a generator iteration produced 356 seeds against a cap of 300 and
    // the map stopped booting mid-build (build-w3-gameplay.md §6.3). The cap
    // living in the generated JSON meant a regenerated file could re-introduce
    // its own tight number; `Math.max` makes that impossible from here while
    // still letting a file ASK for more.
    maxNodes: Math.max(latticeIn.maxNodes ?? 0, 480),
  };
  if (navSeeds.length > navLattice.maxNodes) {
    A.warnings.push(`${navSeeds.length} nav seeds exceeds navLattice.maxNodes ${navLattice.maxNodes} — BOT_NAV will throw at import`);
  }

  // --- minimap --------------------------------------------------------------
  const rawMinimap = file.minimap;
  const minimapRects: MinimapRect[] = Array.isArray(rawMinimap)
    ? rawMinimap
    : ((rawMinimap?.rects ?? []) as MinimapRect[]);

  DUST2_IS_STUB = file.stub === true;

  return {
    id: "dust2",
    name: DUST2_IS_STUB ? "DUST2 (STUB ARENA)" : DUST2_NAME,

    solids,
    floorY,
    bounds,

    nadeFenceRects,
    nadeFenceTop,

    spawns,
    // Authored FFA points ride the def when the file ships them (none in the
    // shipped data — FFA draws the neutral pool in shared/sim.ts instead).
    // Validated + hashed above, normalised here like buildNuketown — and
    // neutral throughout: a future file that tags a side still yields
    // teamless FFA points (team: 0), never a side pool.
    ffaSpawns: (file.ffaSpawns ?? []).map((s) => ({
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw ?? 0,
      team: 0 as const,
    })),
    navSeeds,
    navPockets: file.navPockets ?? [],
    navLattice,
    stackedFloors: file.stackedFloors ?? true,
    // NULL ≠ UNDEFINED (same contract as nuketownGeoHash): undefined takes the
    // 0.5 default, explicit null keeps the height gate OFF. A hash over this
    // field must mix them distinct (null sentinel), never `?? 0.5`.
    navHeightGate: file.navHeightGate === undefined ? 0.5 : file.navHeightGate,
    // MEASURED on the shipped collider set: every one of the 724 `climb: true`
    // solids carries `visual: "dfloor"`, and not one of the 119 `dprop` boxes is
    // climbable. dust2's height is stairs and terraces, not crates — so the
    // planner's "a low climbable box is steel" rule (MapDef.climbablesAreFloors)
    // has no prop to protect here and costs it every staircase.
    climbablesAreFloors: file.climbablesAreFloors ?? true,
    /**
     * RENDER-ONLY step-ease cap (MapDef.stepSmoothMax). dust2's vertical
     * quantum is 0.8128 m and the auto-mantle up a ramp shoulder is one of
     * them: the judge's eyetrace measured an 0.84 m single-frame camera pop at
     * (32.6, -68.3), which the 0.45 m default REFUSED to smooth at all — a rise
     * over the cap zeroes the lag by design. 0.90 covers the quantum plus the
     * 1 mm weld slack and stays under the sim's 1.05 m mantle ceiling, so a
     * genuine fall is still felt as one.
     */
    stepSmoothMax: file.stepSmoothMax ?? 0.9,

    visualContainers: file.visualContainers ?? [],
    minimap: minimapRects.map((r) => ({ ...r, color: r.color ?? "sand" })),
    // The HUD draws this radar (walkable floor + boundary lines, built by
    // scripts/dustmap/build-radar.mts from this same collider set) instead of
    // the 452 filled rects above, which read as a grey wash at 2 px/m.
    minimapImage: file.minimapImage ?? "assets/maps/dust2-radar.png",
    // audio2.ts culls a voice entirely past 42 m on a 33 m yard. dust2's long-A
    // duel is ~50 m and its diagonal is 176 m; 2.2x is the measured multiplier
    // that puts the whole playable footprint back inside earshot.
    audioScale: file.audioScale ?? 2.2,
    // THE SAME NUMBER, STATED SEPARATELY — see MapDef.botScale. It is 2.2 for a
    // different reason than the audio is (BOT_RANGE's sprint gate, repath radii
    // and engage bands were all measured on a 33 m yard), and the sim reads this
    // field FIRST so the two can diverge the day one of them needs to. Measured
    // worth on dust2: watchdog windows 341 -> 240, frozen bots 1 -> 0
    // (build-w3-gameplay.md §5.1).
    botScale: file.botScale ?? 2.2,
  };
}
