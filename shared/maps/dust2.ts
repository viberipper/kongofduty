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
 * `public/assets/maps/dust2.json` and is handed to this factory by
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
  if (!Array.isArray(solids) || solids.length === 0) throw new Error("dust2 map data: solids is empty");
  if (!Array.isArray(spawns) || spawns.length === 0) throw new Error("dust2 map data: spawns is empty");

  const A = DUST2_AUDIT;
  A.built = true;
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
  // own top; a bare footprint list gets the policy default.
  const rawFence = file.nadeFenceRects ?? [];
  const nadeFenceRects: FenceRect[] = rawFence.map((r) => ({ x: r.x, z: r.z, sx: r.sx, sz: r.sz, yaw: r.yaw }));
  const fenceTopFromFile = rawFence.reduce(
    (top, r) => (r.y !== undefined && r.sy !== undefined ? Math.max(top, r.y + r.sy * 0.5) : top),
    -Infinity,
  );
  /**
   * The frag fence has to top out above the map crest (10.566 m) plus the height
   * a lob adds, or a frag thrown at the boundary sails over an invisible wall the
   * player cannot see and detonates outside the world. 24 m is the floor.
   */
  const nadeFenceTop = file.nadeFenceTop ?? (Number.isFinite(fenceTopFromFile) ? fenceTopFromFile : 26);
  A.nadeFenceTop = nadeFenceTop;
  if (!(nadeFenceTop >= 24)) {
    A.warnings.push(`nadeFenceTop ${nadeFenceTop} m is under the 24 m minimum (crest 10.6 + lob)`);
  }
  if (nadeFenceRects.length === 0) {
    A.warnings.push("no nadeFenceRects: a lobbed frag can leave the map wherever the boundary is low");
  }

  // --- nav ------------------------------------------------------------------
  const navSeeds: Waypoint[] = (file.navSeeds ?? []).map((w) => ({ x: w.x, z: w.z, cover: w.cover ?? false }));
  A.navSeeds = navSeeds.length;
  A.navLinks = file.navLinks?.length ?? 0;

  /**
   * THE LATTICE, or the deliberate absence of one.
   *
   * `buildBotNav` fills leftover standing room with a coarse lattice because
   * Shipment ships 19 authored lane seeds for a 33 m yard. The dust2 generator
   * emits its OWN sampled nav set — 388 seeds grown along the walkable graph so
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
    // the DATA that needs headroom over the shipped 381 seeds — 99 nodes of it.
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
    navSeeds,
    navPockets: file.navPockets ?? [],
    navLattice,
    stackedFloors: file.stackedFloors ?? true,
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
