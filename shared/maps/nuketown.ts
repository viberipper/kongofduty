/**
 * NUKETOWN as a MapDef — a validated adapter over the generated map data
 * (static/assets/maps/nuketown.json, written by scripts/nuketown/build-map.mts).
 *
 * The JSON owns GEOMETRY and the sampled nav/spawn sets (all generated from the
 * Blender build of the SketchUp source, see assets-3d/nuketown/README.md);
 * this module owns SIM POLICY defaults and refuses bad data loudly:
 * non-finite numbers throw, colliders under 0.10 m throw.
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
// SINGLE SOURCE OF TRUTH (review HIGH-4): the envelope pins below read the
// movement model from shared/movement.ts (leaf, no imports) — same bindings
// the sim runs, so drift is a compile-time break, not a silent divergence.
// (NOT from shared/sim.ts: a sim<->maps value import is a module cycle that
// breaks the esbuild server bundle. shared/sim.ts re-exports these, so either
// spelling reads identically.)
import { BOT_CLEAR_R, GRAVITY as SIM_GRAVITY, JUMP_V as SIM_JUMP_V, MANTLE as SIM_MANTLE, RADIUS as SIM_RADIUS, SPRINT as SIM_SPRINT } from "../movement";

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
  navPockets?: [number, number][];
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
  /** Balcony railing panels converted to vaultable (climb) below. */
  railings: 0,
  /** Geometry hash of the raw solids this audit ran on (dual-JSON desync pin). */
  geo: "",
};

/**
 * Geometry hash of the raw map file: FNV-1a over count + per-box
 * (x,y,z,sx,sy,sz,yaw,climb,visual,open,color), quantised to millimetres, plus
 * the bounds rect, the fence footprints + top, and the nav tunables that change
 * connectivity (navLinkPad, navHeightGate — null distinct from undefined).
 * Load-bearing floor and storey policy (floorY, stackedFloors,
 * climbablesAreFloors, stepSmoothMax) plus the nav lattice (x0/x1/z0/z1, step,
 * linkMax, maxNodes), nav seeds + pockets, team + FFA spawns, and the
 * bot/audio scales are hashed too — two copies differing only there build
 * divergent sims, so they must hash different. client/static and server/assets
 * each carry a copy of nuketown.json (no JSON edits in this pass); both copies
 * are generated from the one Blender build, and the two sides must hash EQUAL.
 *
 * The OLD hash mixed geometry + climb only, so two copies differing ONLY in
 * `visual` hashed equal while building DIFFERENT climb: the "railing" tag is
 * what the geometry gate promotes on, and a retag on one side vaults there
 * while the other side holds steel — prediction vs authority diverge. Now
 * `visual` (and `open`, which gates traceWorld; and the bounds/fence rects,
 * which gate the OOB clamp and the frag fence) are IN the hash, so a visual
 * desync is a hash desync. Compare in CI —
 * `node scripts/nuketown/check-geo.mjs` builds BOTH copies and fails the run
 * when clientGeo !== serverGeo. The audit records the hash it ran on
 * (NUKETOWN_AUDIT.geo) so a mismatch names the drift instead of hiding it.
 */
export function nuketownGeoHash(raw: unknown): string {
  const f = raw as NuketownFile & {
    navPockets?: [number, number][];
    ffaSpawns?: Spawn[];
  };
  let h = 2166136261 >>> 0;
  // NON-FINITE SENTINEL (review LOW): every non-finite input mixes one word,
  // 0x7fffffff. It is distinct from every finite height OVER THE MAP DOMAIN
  // (Math.round(y * 1000) hits 0x7fffffff only at ~2147483.647 m — no map
  // spans kilometres), but the non-finite spellings alias each other here by
  // design: NaN, Infinity and -Infinity all hash to the same word. That is
  // sound because every one of them THROWS at build (see buildNuketown's
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
  mix(f.solids.length);
  for (const o of f.solids ?? []) {
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
    // NORMALISED FOOTPRINT ONLY: the builder drops y/sy/top (extrusion is
    // floorY→nadeFenceTop), so hashing them made identical builds hash
    // different (false desync). Hash exactly what the build reads.
    //
    // DELIBERATE ASYMMETRY WITH DUST2 (review MEDIUM): dust2's builder READS
    // r.y/sy and a finite r.top (fenceTopFromFile), so dust2GeoHash mixes
    // them — the same JSON field means opposite things per map. Aligning the
    // hashes would be the bug, not the fix: each file hashes exactly what its
    // own builder consumes, so a spelling its builder ignores can never move
    // its geo, and a spelling its builder reads always does.
    mix(r.x);
    mix(r.z);
    mix(r.sx ?? r.w ?? 0);
    mix(r.sz ?? r.d ?? 0);
    mix(r.yaw ?? 0);
  }
  mix(f.nadeFenceTop ?? 26);
  mix(f.navLinkPad ?? 0.15);
  // NULL ≠ UNDEFINED (review M2): the builder maps undefined→0.5 but preserves
  // explicit null (height gate OFF, the Shipment single-deck policy), so a
  // regen that flips 0.5→null builds divergent nav. Hash them distinct: null
  // mixes a sentinel that no finite gate value can collide with.
  if (f.navHeightGate === null) mix(0x7ffffffe);
  else mix(f.navHeightGate ?? 0.5);
  // LOAD-BEARING FLOOR + STOREY POLICY (security HIGH-2): floorY positions
  // every fence extrusion and floor clamp; stackedFloors flips walkFromY from
  // Infinity to the body's feet; climbablesAreFloors flips the botBlocked
  // low-prop exemption; stepSmoothMax moves the render smooth cap.
  mix(f.floorY ?? 0);
  mix((f.stackedFloors ?? true) ? 1 : 0);
  mix((f.climbablesAreFloors ?? true) ? 1 : 0);
  mix(f.stepSmoothMax ?? 0.9);
  // BOT/AUDIO SCALE (review M3): sim reads botScale (router/repath/engage
  // bands) and audioScale (cull distance) off the def — a regen that retunes
  // one side builds divergent behaviour at an equal geometry hash.
  mix(f.botScale ?? 1.5);
  mix(f.audioScale ?? 1.6);
  // NAV LATTICE (review M1): buildBotNav reads MAP.navLattice (x0/x1/z0/z1,
  // step, linkMax, maxNodes) — divergent lattices build divergent nav at an
  // equal hash. Mix every field (null/undefined step handled by the builder's
  // own defaults; hash the raw so a dropped field still desyncs loudly).
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
    // Y-ABSENT ≠ Y-ZERO (review HIGH-1): the builder maps `y === undefined`
    // to a flat seed but preserves a finite y, and NAV_Y is stackedFloors &&
    // seeds.some(w => w.y !== undefined) — so an explicit y:0 seed builds a
    // storey-aware graph while an omitted-y seed builds flat, and the old
    // `?? 0` hashed both to the same word. Absent mixes the NaN sentinel
    // (0x7fffffff, distinct from every finite height — the same convention as
    // the bounds/lattice NaNs above), so the two spellings hash different.
    // Latent on the shipped data (all 337 seeds y-bearing) — the pin is for
    // the next regen, not this one.
    mix(w.y ?? NaN);
    mix(w.cover ? 1 : 0);
  }
  // NAV POCKETS: extra standing-room points buildBotNav walks (MAP.navPockets).
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
    // MISSING-y ≠ y:0 (review MEDIUM-4, same contract as dust2GeoHash):
    // spawn() resolves the floor from walkFromY(best.y) — an absent y walks
    // from NaN while y:0 walks from the ground storey, so the spellings hash
    // different. A present-but-non-finite y throws at build.
    mix((s as { y?: number }).y ?? NaN);
    mix((s as { yaw?: number }).yaw ?? 0);
    mix((s as { team?: number }).team ?? 0);
  }
  // FFA SPAWNS: the FFA pool the room draws from — same divergence class as
  // team spawns.
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

/**
 * Deck heights the balcony rails sit on — moved to shared/deckrail.ts (leaf,
 * no imports): shared/sim.ts reads the same bindings and a sim<->nuketown
 * value import is a module cycle that breaks the server bundle (esbuild emits
 * `await init_sim()` inside the `__esm` closure — a load-time SyntaxError).
 * Re-exported here so existing importers keep working.
 */
export { DECK_RAIL_ALLOW_Y, DECK_RAIL_DECKS, DECK_RAIL_TOL } from "../deckrail";
import { DECK_RAIL_DECKS, DECK_RAIL_TOL } from "../deckrail";
/** Deck rail panel height band: every panel is 0.95 m tall (tops ~4.0/4.04 m). */
const DECK_PANEL_MIN_H = 0.8;
const DECK_PANEL_MAX_H = 1.1;
/**
 * Plan-size band for a rail panel: thin face + panel length. All 11 promoted
 * panels are 0.12 m thick and 0.34–3.8 m long; the tall side walls share the
 * 0.12 m thickness, so this band alone never promotes one (height still gates
 * them out) — but a chunky 0.9 m porch rail or furniture edge with
 * visual==="railing" near a deck can no longer sneak in on height alone.
 */
const DECK_RAIL_MIN_THICK = 0.08;
const DECK_RAIL_MAX_THICK = 0.2;
const DECK_RAIL_MIN_LEN = 0.3;
const DECK_RAIL_MAX_LEN = 4.5;
/** Panels promoted below: 5 west + 6 east. Loud if the data ever says else. */
const EXPECTED_DECK_RAILS = 11;
/**
 * CLOSED-WORLD PIN (review HIGH-5): the interior family — both houses' deck
 * slabs + both stair chains + ground porch decks — is exactly these 43
 * DECK_KINDS boxes (the two decks sit 0.04 m apart, inside DECK_BAND, so both
 * houses seed every rail's family together). Any regen-added DECK_KINDS box
 * that touches the family — e.g. an exterior dstair leaning on the foundation
 * within FURN_PAD — changes this count INSTEAD of joining silently, so the
 * audit throws for a human to bless or reject instead of exempting a bypass.
 */
const EXPECTED_INTERIOR_FAMILY = 43;
/**
 * Staged-climb reach (STANDING): groundHeight samples a footprint grown by
 * GH_TOL 0.12 m while a body is a RADIUS 0.30 m circle, so a perch whose face
 * is within 0.42 m of a rail panel is one standing mantle step away from it.
 */
const RAIL_STAGE_REACH = 0.12 + 0.3;
/**
 * Deck-furniture truth threshold (FURN_PAD): footprintsOverlap grows EACH box
 * by `pad`, so pad 0.05 closes a 0.10 m gap — the 1–2 cm yaw slivers between a
 * dresser and the deck slab it stands on, with margin, while a genuinely
 * detached perch (gap >> 0.1 m) still throws. Pad 0 (exact touch) false-threw
 * on those slivers and checked the underside only; see the staging audit.
 */
const FURN_PAD = 0.05;
/**
 * Staged-climb reach (JUMP-ASSISTED): the standing audit models only
 * ct >= railTop-1.05. A jumping perch reaches apex JUMP_V^2/2/GRAVITY =
 * 5.55^2/40.8 ≈ 0.76 m with vy ≈ 0 (mantle allows vy >= -0.5, i.e. falling
 * 0.5 m/s still mantles), so a perch top in [railTop-1.81, railTop-1.05) can
 * jump-mantle: feet at perch+0.76, railTop-feet < 1.05. Air drift at sprint
 * 5.92 m/s over ~0.54 s of air exceeds 3 m, far past the 0.42 m standing
 * envelope. The audit below therefore sweeps a second, wider band:
 * vertical RAIL_STAGE_JUMP_DROP = 1.9 m (≈1.81 + 0.09 margin) and horizontal
 * RAIL_STAGE_JUMP_REACH = 3.6 m (≈3.22 m analytic drift + margin: the reach is
 * pinned strictly past drift, so a 2 cm analytic shortfall can never reopen).
 */
const RAIL_STAGE_JUMP_DROP = 1.9;
const RAIL_STAGE_JUMP_REACH = 3.6;
/**
 * Egress lift: standing on a promoted rail top (~4.0/4.04 m) + jump 0.76 m +
 * mantle 1.05 m reaches ≈5.8 m. Any CLIMBABLE neighbour within jump reach
 * whose top sits in (railTop, railTop+1.9] would be a new launch off the
 * balcony (over low perimeter, onto roofs the movement code skips). Surveyed
 * 2026-10-22: NONE exists — every above-rail neighbour within 3.6 m is steel
 * (wall caps 4.10/5.19–5.60 m, roof-volumes 5.70–5.77 m, glass 5.09–5.60 m)
 * or non-climbable props (boxes 4.07–4.40 m tops, climb:false). The audit
 * below enforces that survey: a climbable above-rail neighbour in envelope
 * throws.
 *
 * INTENDED DIRECTION (below-rail ballistics). The perimeter/boundary top
 * (3.20 m) sits BELOW every rail top, so it is never a mantle step — only a
 * ballistic clearance the sim never promised to prevent for players:
 *   - deck → lawn (INSIDE MAP.bounds): ALLOWED. The player jump-vault over
 *     the 11 panels lands on the lawn inside the bounds; resolveCircle and
 *     groundHeight vault it only while airborne, and the panels stay climbable for that airborne mantle.
 *   - lawn → deck: STAIRS ONLY. No outside perch may mount the rail top
 *     without standing on the deck first; the staged-climb audit below
 *     blocks every such perch (blocked = build throws).
 *   - deck → VOID (outside MAP.bounds): BLOCKED. integrate() in
 *     shared/sim.ts clamps Nuketown bodies into MAP.bounds (inset RADIUS) and
 *     zeroes the outward velocity, so a ballistic perimeter clear that leaves
 *     the map is teleported back to the fence. The clamp is Nuketown-only;
 *     other maps never reach it and stay bit-identical.
 */
const RAIL_EGRESS_LIFT = 1.9;
const RAIL_EGRESS_REACH = 3.6;
/** Deck-level surfaces (slabs, second-floor dfloor, top stair treads) are the legitimate stand-and-vault floor, not staging. */
const DECK_BAND = 0.35;

/** 2D SAT overlap of two yawed footprints, each grown by `pad` (metres). */
function footprintsOverlap(a: OBB, b: OBB, pad: number): boolean {
  // Per-box axes in world: local +x -> (cos, sin), local +z -> (-sin, cos).
  // NOTE on pad math: EACH box is grown by `pad`, so the total closable gap
  // is 2*pad. Callers pass RAIL_STAGE_REACH/2 (=0.21) for a 0.42 m standing
  // envelope and RAIL_STAGE_JUMP_REACH/2 (=1.8) for a 3.6 m jump envelope.
  const axes: Array<[number, number]> = [];
  for (const o of [a, b]) {
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    axes.push([c, s]);
    axes.push([-s, c]);
  }
  const extent = (o: OBB, ax: number, az: number): number => {
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    // Minkowski sum with a disc of radius `pad`: the projection of the disc
    // on ANY unit axis is exactly `pad`, so the padded extent is base + pad
    // (not (half+pad)*|..|, which over-grows diagonal axes by up to sqrt2
    // and turned a 3.5 m jump envelope into ~5 m diagonally — see #7).
    return (
      (o.sx * 0.5) * Math.abs(c * ax + s * az) +
      (o.sz * 0.5) * Math.abs(-s * ax + c * az) +
      pad
    );
  };
  for (const [ax, az] of axes) {
    const ca = a.x * ax + a.z * az;
    const cb = b.x * ax + b.z * az;
    if (Math.abs(ca - cb) > extent(a, ax, az) + extent(b, ax, az)) return false;
  }
  return true;
}

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`nuketown map data: missing "${what}" (run scripts/nuketown/build-map.mts)`);
  return v;
}

/**
 * Built-def cache: MAPS in shared/maps/index.ts is a getter that rebuilds on
 * every access (new MapDef identity, audit reset, hides JSON drift). Caching
 * by raw reference here restores identity: same raw object in → same MapDef
 * out, audit counted once. The solids are ALSO cloned below before any
 * climb/vault flag is touched, so the cached MAP_DATA JSON is never
 * mutated in place — and the geometry hash is compared on every hit, so an
 * in-place same-length mutation of the raw (flag flip, visual retag) rebuilds
 * instead of returning the stale def.
 *
 * KEYED BY RAW IDENTITY (security MEDIUM-6): a single CACHED_RAW slot meant
 * the second buildNuketown(serverRaw) in check-geo evicted the first
 * buildNuketown(clientRaw) — and a returned def mutated in place (flag flip at
 * the same length) keeps hash(raw) unchanged, so a raw-only check returns the
 * poisoned def forever. The cache is therefore per-raw (WeakMap, no leak:
 * entries die with their JSON object) AND verified both ways on every hit:
 * raw length + raw geometry hash must match, and the CACHED DEF's own hash —
 * taken at build time (promotion legitimately retags climb/vault, so the
 * def hash differs from the raw hash by design; what is compared is def-now
 * vs def-at-build) — must still match too. A def mutated after return
 * rebuilds from raw instead of masquerading as the cached world. (Freezing
 * the def would break the documented synthetic-QA push onto def.solids;
 * cloning per hit would break the `d1 === d2` identity the probe pins.
 * Verify, don't freeze or clone.)
 */
const DEF_CACHE = new WeakMap<object, { def: MapDef; rawGeo: string; defGeo: string }>();
let CACHED_RAW: unknown = null;
let CACHED_DEF: MapDef | null = null;
/** Geometry hash the cached def was built from (security F / review HIGH-7). */
let CACHED_GEO = "";
/** The cached def's own hash at build time (def-mutation tripwire). */
let CACHED_DEF_GEO = "";

export function buildNuketown(raw: unknown): MapDef {
  const f = raw as NuketownFile;
  // need() FIRST (review LOW): the cache-hit path below hashes the raw, and
  // hashing a malformed raw ({solids: missing} → length of undefined) throws
  // a bare TypeError instead of the descriptive need() error. Validate the
  // load-bearing fields before any hash is computed.
  const rawSolids = need(f.solids, "solids");
  const boundsNeed = need(f.bounds, "bounds");
  void boundsNeed;
  need(f.spawns, "spawns");
  // Synthetic QA boxes are pushed onto the RETURNED def's solids (the documented
  // way to test the sim); that mutates the cached clone's length. A same-raw
  // hit with a different length is stale synthetics, not the same world, so
  // the cache only hits when the length still matches — otherwise rebuild from
  // raw (which drops the synthetics, they were never in MAP_DATA) rather than
  // leak one test's boxes into the next audit. Length alone is NOT the key: an
  // in-place flag flip at the same length would return stale, so the geometry
  // hash (visuals + bounds + fence + floorY/storey policy + seeds + spawns
  // included) is compared too — a same-length mutation rebuilds instead of
  // masquerading as the cached world. The DEF's own hash is compared as well,
  // so a def mutated after return (same raw hash, poisoned def) rebuilds.
  if (typeof raw === "object" && raw !== null) {
    const hit = DEF_CACHE.get(raw);
    if (
      hit &&
      hit.def.solids.length === rawSolids.length &&
      nuketownGeoHash(raw) === hit.rawGeo &&
      nuketownGeoHash(hit.def) === hit.defGeo
    ) {
      CACHED_RAW = raw;
      CACHED_DEF = hit.def;
      CACHED_GEO = hit.rawGeo;
      CACHED_DEF_GEO = hit.defGeo;
      return hit.def;
    }
    if (
      raw === CACHED_RAW &&
      CACHED_DEF &&
      CACHED_DEF.solids.length === rawSolids.length &&
      nuketownGeoHash(raw) === CACHED_GEO &&
      nuketownGeoHash(CACHED_DEF) === CACHED_DEF_GEO
    )
      return CACHED_DEF;
  }
  const bounds = need(f.bounds, "bounds");
  // BOUNDS ARE LOAD-BEARING (security B): integrate() clamps Nuketown bodies
  // into these four numbers, and a regen that emits {x,z,w,d} (or any NaN)
  // makes every comparison false — the clamp silently stops clamping and the
  // OOB it exists to close reopens. Existence is not enough.
  for (const k of ["minX", "maxX", "minZ", "maxZ"] as const) {
    if (!Number.isFinite(bounds[k]))
      throw new Error(`nuketown map data: bounds.${k} is not finite (got ${bounds[k]})`);
  }
  if (!(bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ))
    throw new Error(
      `nuketown map data: bounds inverted (minX ${bounds.minX} maxX ${bounds.maxX} minZ ${bounds.minZ} maxZ ${bounds.maxZ})`,
    );
  // DEGENERATE SPAN PIN (review MEDIUM): finite + ordered is not enough — a
  // <0.6 m span (2*RADIUS) insets to an empty/loX>hiX clamp that teleports a
  // body every tick. Both axes must fit a body.
  if (!(bounds.maxX - bounds.minX > 2 * SIM_RADIUS && bounds.maxZ - bounds.minZ > 2 * SIM_RADIUS))
    throw new Error(
      `nuketown map data: bounds span too small for a body (dx ${bounds.maxX - bounds.minX} dz ${bounds.maxZ - bounds.minZ}, need > ${2 * SIM_RADIUS})`,
    );
  const spawns = need(f.spawns, "spawns");
  const floorY = f.floorY ?? 0;
  // FLOOR IS LOAD-BEARING (security HIGH-2/M1): floorY drives integrate's
  // clamp floor, the frag-fence extrusion base, and the deck-height pins
  // below. A NaN floor silently ungrounds every system that reads it.
  if (!Number.isFinite(floorY)) throw new Error(`nuketown map data: floorY is not finite (got ${floorY})`);
  if (!rawSolids.length) throw new Error("nuketown map data: solids is empty");
  if (!spawns.length) throw new Error("nuketown map data: spawns is empty");
  // PER-TEAM POOL PIN (review MEDIUM-3, same scope as buildDust2): spawn()
  // team-filters this pool before scoring — a regen that drops a whole side
  // should fail here, not at the first team spawn on pool[0]. Scoped to
  // team-mode data: FFA ignores teams, so an FFA-only file shipping ffaSpawns
  // is not failed for sides it never fields. Shipped data carries both sides.
  if (!Array.isArray(f.ffaSpawns) || f.ffaSpawns.length === 0) {
    for (const t of [0, 1] as const) {
      if (!spawns.some((s) => (s as { team?: number }).team === t))
        throw new Error(`nuketown map data: no spawns for team ${t}`);
    }
  }
  // SEED/SPAWN NUMERICS (review HIGH-3 / MEDIUM-3, same contract as
  // buildDust2): a non-finite seed y used to hash like an absent y while
  // BUILDING differently (w.y === undefined → flat seed, y: NaN → fy NaN → a
  // NaN groundHeight limit that filters every edge — same hash, different
  // graph), and a non-finite spawn coordinate hashed a sentinel while the
  // runtime integrated it. Throw here instead.
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i]! as { x: number; y: number; z: number; yaw?: number; team?: number };
    for (const k of ["x", "y", "z"] as const) {
      if (!Number.isFinite(s[k])) throw new Error(`nuketown map data: spawn ${i} has non-finite ${k}`);
    }
    if (s.yaw !== undefined && !Number.isFinite(s.yaw)) throw new Error(`nuketown map data: spawn ${i} has non-finite yaw`);
    if (s.team !== undefined && s.team !== 0 && s.team !== 1)
      throw new Error(`nuketown map data: spawn ${i} has bad team ${s.team}`);
  }
  for (let i = 0; i < (f.ffaSpawns ?? []).length; i++) {
    const s = f.ffaSpawns![i]! as { x: number; y: number; z: number; yaw?: number };
    for (const k of ["x", "y", "z"] as const) {
      if (!Number.isFinite(s[k])) throw new Error(`nuketown map data: ffaSpawn ${i} has non-finite ${k}`);
    }
    if (s.yaw !== undefined && !Number.isFinite(s.yaw))
      throw new Error(`nuketown map data: ffaSpawn ${i} has non-finite yaw`);
  }
  for (let i = 0; i < (f.navSeeds ?? []).length; i++) {
    const w = f.navSeeds![i]!;
    if (!Number.isFinite(w.x) || !Number.isFinite(w.z))
      throw new Error(`nuketown map data: navSeed ${i} has non-finite x/z`);
    if (w.y !== undefined && !Number.isFinite(w.y))
      throw new Error(`nuketown map data: navSeed ${i} has non-finite y`);
  }
  for (let i = 0; i < (f.navPockets ?? []).length; i++) {
    const pk = f.navPockets![i]!;
    if (!Number.isFinite(pk[0]) || !Number.isFinite(pk[1]))
      throw new Error(`nuketown map data: navPocket ${i} is non-finite`);
  }
  // FRAG FENCE (security C): Nuketown's 3.2 m boundary sits below every
  // ballistic arc off the deck, so an EMPTY fence list is frags sailing over
  // the balcony into the void — throw, like the rail/thin pins. Rects are
  // normalised here (w/d → sx/sz) and finite-checked: sim.ts reads r.sx/sz
  // with no fallback, so a NaN would be a NaN collider.
  const rawFence = f.nadeFenceRects ?? [];
  if (!rawFence.length)
    throw new Error(
      "nuketown map data: no nadeFenceRects — balcony frags would sail over the 3.2 m boundary into the void",
    );
  const nadeFenceRects: FenceRect[] = rawFence.map((r, i) => {
    const sx = r.sx ?? r.w;
    const sz = r.sz ?? r.d;
    for (const [k, v] of [["x", r.x], ["z", r.z], ["sx", sx], ["sz", sz]] as const) {
      if (!Number.isFinite(v)) throw new Error(`nuketown map data: nadeFenceRect ${i} has non-finite ${k}`);
    }
    if (!(sx! > 0 && sz! > 0)) throw new Error(`nuketown map data: nadeFenceRect ${i} has non-positive size`);
    return { x: r.x, z: r.z, sx: sx!, sz: sz!, yaw: r.yaw ?? 0 };
  });
  // Clone: promotion writes climb/vault below and must not leak into MAP_DATA.
  const solids: OBB[] = rawSolids.map((o) => (o.visual === "boundary" && !o.open ? { ...o, open: true } : { ...o }));
  const A = NUKETOWN_AUDIT;
  A.built = true;

  // ENVELOPE DERIVATION (pinned, not magic numbers). SIM_JUMP_V / SIM_GRAVITY
  // / SIM_SPRINT / SIM_MANTLE are the bindings the sim itself runs, imported
  // from the shared/movement.ts leaf above (shared/sim.ts re-exports the same
  // bindings, so either spelling reads identically) — so a movement-model
  // change moves both sides together: drift is a compile break, never a
  // silent divergence. Apex =
  // V²/2G ≈ 0.755 m; a perch reaches the rail top when apex + mantle covers
  // the drop; air drift at sprint over ~2V/G ≈ 0.544 s of air is ≈3.22 m,
  // inside the 3.6 m reach.
  const JUMP_APEX = (SIM_JUMP_V * SIM_JUMP_V) / (2 * SIM_GRAVITY);
  if (!(RAIL_STAGE_JUMP_DROP >= JUMP_APEX + SIM_MANTLE))
    throw new Error(
      `nuketown map data: staged-drop envelope ${RAIL_STAGE_JUMP_DROP} m below jump+mantle ${JUMP_APEX + SIM_MANTLE} m (sim constants drifted?)`,
    );
  if (!(RAIL_EGRESS_LIFT >= JUMP_APEX + SIM_MANTLE))
    throw new Error(
      `nuketown map data: egress-lift envelope ${RAIL_EGRESS_LIFT} m below jump+mantle ${JUMP_APEX + SIM_MANTLE} m (sim constants drifted?)`,
    );
  if (
    !(
      RAIL_STAGE_JUMP_REACH >= SIM_SPRINT * ((2 * SIM_JUMP_V) / SIM_GRAVITY) &&
      RAIL_EGRESS_REACH >= SIM_SPRINT * ((2 * SIM_JUMP_V) / SIM_GRAVITY)
    )
  )
    throw new Error(
      `nuketown map data: reach envelope below sprint air drift (sim constants drifted?)`,
    );
  // DECK-FLOOR PIN (review HIGH-5): the deck is not one jump+mantle above the
  // street (min deck 3.05 − floor 0 = 3.05 m > apex 0.76 + mantle 1.05), so no
  // lawn perch can stage the rail in a single hop — which is the only reason
  // deck furniture (dressers/boxes ON the deck, mountable solely from it,
  // where the direct deck→rail vault already does everything mounting from
  // them could) is exempt from the staged-climb audit below. If a regen ever
  // lowers a deck into jump range, this throws instead of silently blessing
  // every couch on it.
  for (const d of DECK_RAIL_DECKS) {
    if (!(d - floorY > JUMP_APEX + SIM_MANTLE))
      throw new Error(
        `nuketown map data: deck ${d} m within one jump+mantle of the street (apex ${JUMP_APEX.toFixed(3)} + mantle ${SIM_MANTLE}) — furniture safety assumes it is not`,
      );
  }
  // DOOR-CORRIDOR PIN (review HIGH-6): the nav planner validates links at
  // BOT_CLEAR_R + navLinkPad (imported binding, same radius the sim plans
  // with). That corridor must fit the 1.10 m doors or the graph silently
  // fragments; navLinkPad's ABSENT default (0.15 → 1.18 m) is wider than the
  // doors, so a regen that drops the field throws HERE instead of disconnecting
  // rooms in the link scan.
  const linkPad = f.navLinkPad ?? 0.15;
  if (!Number.isFinite(linkPad) || linkPad < 0)
    throw new Error(`nuketown map data: navLinkPad is not a finite non-negative number (got ${linkPad})`);
  const linkR = BOT_CLEAR_R + linkPad;
  if (!(linkR * 2 <= 1.1))
    throw new Error(
      `nuketown map data: link corridor ${(linkR * 2).toFixed(2)} m exceeds the 1.10 m doors (BOT_CLEAR_R ${BOT_CLEAR_R} + navLinkPad ${linkPad}) — regen would fragment the nav graph`,
    );
  A.solids = solids.length;
  A.spawns = spawns.length;
  A.warnings.length = 0;
  A.climb = 0;
  A.thin = 0;
  A.railings = 0;
  A.maxY = -Infinity;
  A.geo = nuketownGeoHash(raw);
  const promoted: number[] = [];
  for (let i = 0; i < solids.length; i++) {
    const o = solids[i]!;
    for (const k of ["x", "y", "z", "sx", "sy", "sz", "yaw"] as const) {
      if (!Number.isFinite(o[k])) throw new Error(`nuketown map data: solid ${i} has non-finite ${k}`);
    }
    // BALCONY VAULTS. The second-floor deck railings (5 panels west at deck
    // 3.05 m, 6 panels east at deck 3.09 m, every top 0.95 m above its deck)
    // are authored as plain steel, so resolveCircle holds a body on the deck
    // against them at any gait — the deck might as well be walled. The jump
    // apex (JUMP_V^2/2·GRAVITY = 5.55^2/40.8 ≈ 0.76 m) can never clear 0.95 m
    // ballistically, so the vault is a JUMP-vault (shared/map.ts VAULT_REACH):
    // marking the panels `vault` lets a rising jump pass over the rail while
    // a grounded body walking, sprinting, sliding or crouching into it reads
    // hard steel and is never snapped up, exactly like a wall. This runs in
    // code, not in the generated JSON, so both shipped copies (client/static,
    // server/assets) vault without a rebuild of the Blender pipeline — and
    // the flag is what every consumer already keys off (resolveCircle,
    // ceilingCrossed, botBlocked, botWallPush, plus the bot's
    // rail-vault jump), so client prediction and the authority agree by
    // construction. Idempotent: rebuilding from the same raw re-sets the same
    // flags and re-counts the same set.
    //
    // GEOMETRY GATE, not visual alone: visual==="railing" also matches the
    // two tall side walls (#592 west, 0.62→4.00 m; #703 east, 0.82→4.04 m).
    // Promoting those would open a staged lawn→perch→side-wall-top→deck
    // bypass of the stairs, so a panel vaults only when it is panel-shaped
    // (height in [0.8, 1.1] m — which subsumes the old sy<1.2 check since
    // h==sy — AND thin-face plan within [0.08,0.2]×[0.3,4.5] m) AND its
    // underside sits on a known deck (±0.3 m of 3.05/3.09 m). The side walls
    // stay steel; side-vaulting still works off the deck panels alone.
    if (o.visual === "railing") {
      const top = o.y + o.sy / 2;
      const bot = o.y - o.sy / 2;
      const h = top - bot;
      const onDeck = DECK_RAIL_DECKS.some((d) => Math.abs(bot - d) <= DECK_RAIL_TOL);
      const thick = Math.min(o.sx, o.sz);
      const len = Math.max(o.sx, o.sz);
      const panelShape =
        thick >= DECK_RAIL_MIN_THICK &&
        thick <= DECK_RAIL_MAX_THICK &&
        len >= DECK_RAIL_MIN_LEN &&
        len <= DECK_RAIL_MAX_LEN;
      if (h >= DECK_PANEL_MIN_H && h <= DECK_PANEL_MAX_H && onDeck && panelShape) {
        o.vault = true;
        A.railings += 1;
        promoted.push(i);
      } else {
        // Gated out (the tall side walls #592/#703, any porch/step rail):
        // authored steel, kept steel. Side-vaulting still works off the deck
        // panels alone, so unless that is explicitly intended these never
        // vault. Forced, not just left alone, so a regen that marks one
        // climbable in the JSON cannot silently reopen the bypass.
        o.climb = false;
        o.vault = false;
      }
    }
    // Thin-collider audit: strict < 0.10 m like dust2 (no 1e-6 slack — a
    // 0.0999 m face is thin). Rail panels are 0.12 m thick and pass; this is
    // a separate line from the DECK_RAIL_* plan band above.
    if (Math.min(o.sx, o.sy, o.sz) < 0.1) A.thin += 1;
    if (o.climb) A.climb += 1;
    A.maxY = Math.max(A.maxY, o.y + o.sy / 2);
  }
  if (A.railings !== EXPECTED_DECK_RAILS)
    throw new Error(
      `nuketown map data: expected ${EXPECTED_DECK_RAILS} deck rail panels, promoted ${A.railings} [${promoted.join(",")}]`,
    );
  if (A.thin) throw new Error(`nuketown map data: ${A.thin} collider(s) thinner than 0.10 m`);
  // VISUAL-INDEPENDENT TALL-WALL FORCING (security #4 backstop). The gate
  // above only reads visual==="railing", so a regen that retags a tall side
  // wall (#592 west, #703 east) to visual "wall" — or drops the tag — while
  // leaving climb:true would sail through as an ordinary climbable and reopen
  // the staged lawn→perch→side-wall-top→deck bypass. Any climbable that is
  // TALL (above the panel band, h == sy for every OBB), THIN-faced, deck-LONG,
  // rising from below its deck to a rail top, and sitting inside jump reach
  // of a promoted rail IS that wall whatever it calls itself: forced back to
  // steel, loudly. No-ops on the shipped data (both walls are already steel);
  // fires only on regen drift. Legit tall climbables near a deck (wardrobes,
  // roof-volumes, glass) never match all five at once.
  let steelForced = 0;
  for (const s of solids) {
    if (!s.climb || s.vault) continue;
    const h = s.sy;
    if (h <= DECK_PANEL_MAX_H || h > 3.6) continue;
    const thick = Math.min(s.sx, s.sz);
    const len = Math.max(s.sx, s.sz);
    if (thick < DECK_RAIL_MIN_THICK || thick > DECK_RAIL_MAX_THICK) continue;
    if (len < DECK_RAIL_MIN_LEN || len > DECK_RAIL_MAX_LEN) continue;
    const top = s.y + s.sy / 2;
    const bot = top - h;
    const atRailTop =
      DECK_RAIL_DECKS.some((d) => Math.abs(top - (d + 0.95)) <= 0.35) &&
      DECK_RAIL_DECKS.some((d) => bot < d - 0.3);
    if (!atRailTop) continue;
    let nearRail = false;
    for (const i of promoted) {
      if (footprintsOverlap(s, solids[i]!, RAIL_EGRESS_REACH / 2)) {
        nearRail = true;
        break;
      }
    }
    if (!nearRail) continue;
    s.climb = false;
    s.vault = false;
    steelForced += 1;
  }
  if (steelForced) A.warnings.push(`forced ${steelForced} tall-wall retag(s) back to steel`);
  // STAGED-CLIMB AUDIT. A vault panel is only reachable from its deck when no
  // outside perch lets a body mount the rail top without standing on the deck
  // first. Two envelopes, both conservative SINGLE-HOP + 2D-only:
  //   - STANDING: any OTHER climbable with top >= railTop-1.05 within 0.42 m
  //     (footprints overlapping at +0.21 m each) is one mantle step away.
  //   - JUMP: top >= railTop-1.9 within 3.5 m (footprints at +1.75 m each) is
  //     one jump-mantle away (apex 0.76 m + mantle 1.05 m + margin, asserted
  //     against the sim constants above).
  // Both are OVER-THROWS by design (safe): they check only the perch→rail
  // step, never whether the perch is itself reachable from the lawn; they
  // ignore intervening walls (no 3D occlusion); they skip other vault
  // panels (adjacent deck rails overlap each other and must not self-throw).
  // MULTI-HOP chains (perch→perch→rail) are NOT modeled: each hop would need
  // its own audit, and the survey below shows no first hop exists, so there
  // is nothing to chain from. A throw here is therefore "needs a human look",
  // never "exploitable" — but a pass means no single perch in either
  // envelope, reachable or not.
  //
  // KIND-INDEPENDENT BACKSTOP (security #4): the subject loop below tests
  // EVERY climbable in the band — no visual gate anywhere — so a regen that
  // retags a tall wall from visual "railing" to "wall" (keeping climb:true)
  // still throws here even if the tall-wall forcing above somehow missed it,
  // and the pinned EXPECTED_DECK_RAILS count cannot mask it (promotion count
  // is orthogonal to this loop). Exemptions are INTERIOR-ASSOCIATION, never
  // kind-alone:
  //   - interior set: the legitimate arrival path as ONE XZ-connected family.
  //     Seeds are this rail's deck-level slabs (visual in {deck,dfloor,
  //     dstair}, top within DECK_BAND of the deck); any DECK_KINDS box
  //     (ANY height — the whole stair chain) overlapping the family by
  //     FURN_PAD joins it transitively. A future porch-step tagged dstair
  //     OUTSIDE the house at deck height is detached from the family, so it
  //     still throws instead of being silently exempt.
  //   - deck furniture: underside >= deck-0.5 AND XZ-overlapping a deck-level
  //     slab by FURN_PAD — a dresser/boxes ON the deck, mountable solely from
  //     the deck, where the direct deck→rail vault already does everything
  //     mounting from it could. An outside porch roof at deck height is
  //     deck-LEVEL but not deck-ASSOCIATED (no slab overlap) so it throws.
  const DECK_KINDS = new Set(["deck", "dfloor", "dstair"]);
  const loggedFurniture = new Set<number>();
  for (const i of promoted) {
    const r = solids[i]!;
    const railTop = r.y + r.sy / 2;
    const deck = DECK_RAIL_DECKS.reduce((a, b) => (Math.abs(b - (r.y - r.sy / 2)) < Math.abs(a - (r.y - r.sy / 2)) ? b : a));
    // Deck-level walk surfaces for THIS rail's deck (furniture-overlap test
    // and interior-set seeds).
    const deckSlabs: OBB[] = [];
    for (const s of solids) {
      if (s.visual === undefined || !DECK_KINDS.has(s.visual)) continue;
      const st = s.y + s.sy / 2;
      if (Math.abs(st - deck) <= DECK_BAND) deckSlabs.push(s);
    }
    // Interior-associated family, grown transitively: every DECK_KINDS box
    // touching the family joins it, so the stair chain connects tread to
    // tread even though only the top tread touches a slab.
    const interior: OBB[] = [...deckSlabs];
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of solids) {
        if (s.visual === undefined || !DECK_KINDS.has(s.visual)) continue;
        if (interior.includes(s)) continue;
        if (interior.some((m) => footprintsOverlap(s, m, FURN_PAD))) {
          interior.push(s);
          grew = true;
        }
      }
    }
    if (interior.length !== EXPECTED_INTERIOR_FAMILY)
      throw new Error(
        `nuketown map data: rail ${i} interior family is ${interior.length}, expected ${EXPECTED_INTERIOR_FAMILY} (a DECK_KINDS box joined or left — bless or reject it, see EXPECTED_INTERIOR_FAMILY)`,
      );
    for (let j = 0; j < solids.length; j++) {
      if (j === i) continue;
      const c = solids[j]!;
      if (!c.climb || c.vault) continue;
      const ct = c.y + c.sy / 2;
      const cb = c.y - c.sy / 2;
      // Staging steps UP onto the rail: perches above the rail top cannot
      // mantle DOWN onto it (mantle needs feet+0.2 < top). Above-rail
      // neighbours belong to the EGRESS audit below, not this loop.
      if (ct > railTop) continue;
      if (ct < railTop - RAIL_STAGE_JUMP_DROP) continue;
      const standing = ct >= railTop - 1.05 && footprintsOverlap(r, c, RAIL_STAGE_REACH / 2);
      const jumpStaged = !standing && footprintsOverlap(r, c, RAIL_STAGE_JUMP_REACH / 2);
      if (!standing && !jumpStaged) continue;
      // Interior-associated (walk surfaces + full stair chain, any height)
      // and deck furniture first; everything else in the band is a bypass.
      // Tested only for in-envelope candidates, so the furniture log below
      // names real near-rail matches (solid index + slab index, like the
      // promoted list), not every dresser on the deck.
      if (interior.includes(c)) continue;
      let onDeckFurniture = false;
      if (cb >= deck - 0.5) {
        for (const d of deckSlabs) {
          if (footprintsOverlap(c, d, FURN_PAD)) {
            onDeckFurniture = true;
            if (!loggedFurniture.has(j)) {
              loggedFurniture.add(j);
              A.warnings.push(`deck furniture exempt: solid ${j} on slab ${solids.indexOf(d)} for rail ${i}`);
            }
            break;
          }
        }
      }
      if (onDeckFurniture) continue;
      if (standing) {
        throw new Error(
          `nuketown map data: staged climb onto deck rail ${i} via solid ${j} (top ${ct.toFixed(2)} m, deck ${deck.toFixed(2)} m)`,
        );
      }
      if (jumpStaged) {
        throw new Error(
          `nuketown map data: jump-staged climb onto deck rail ${i} via solid ${j} (top ${ct.toFixed(2)} m, deck ${deck.toFixed(2)} m)`,
        );
      }
    }
    // EGRESS AUDIT. From the rail top a body jumps 0.76 m and mantles 1.05 m,
    // so any CLIMBABLE neighbour with top in (railTop, railTop+1.9] inside
    // jump reach is a new launch (roof hop, perimeter clear). The partition
    // is EXACT: staging takes ct <= railTop, this loop takes ct > railTop, so
    // no 1 cm sliver is skipped by both. Kind-independent like the staging
    // loop (no visual gate). Steel neighbours are fine (no mantle).
    // Surveyed: none exist — above-rail neighbours are wall caps /
    // roof-volumes / glass, all steel. A climbable here throws.
    for (let j = 0; j < solids.length; j++) {
      if (j === i) continue;
      const c = solids[j]!;
      if (!c.climb || c.vault) continue;
      const ct = c.y + c.sy / 2;
      if (ct <= railTop || ct > railTop + RAIL_EGRESS_LIFT) continue;
      if (footprintsOverlap(r, c, RAIL_EGRESS_REACH / 2)) {
        throw new Error(
          `nuketown map data: egress launch off deck rail ${i} via solid ${j} (top ${ct.toFixed(2)} m, rail ${railTop.toFixed(2)} m)`,
        );
      }
    }
  }
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
  // FENCE TOP IS LOAD-BEARING (security HIGH-2/M2, MEDIUM-4): Nuketown's
  // 3.2 m boundary sits below every ballistic arc off the deck, so a missing,
  // NaN, or sub-24 m top is frags sailing over the balcony into the void —
  // the 56-rect fence extrudes from floorY to this height and sim.ts throws on
  // the same condition at import (both layers, so neither a regen nor a stale
  // build slips a silent hole through). Warning-only used to let a 3.5 m top
  // build green and pass a geo-only CI; it now throws like the empty/thin/
  // rail-count pins.
  if (!Number.isFinite(nadeFenceTop) || !(nadeFenceTop >= 24))
    throw new Error(
      `nuketown map data: nadeFenceTop must be a finite number >= 24 (got ${nadeFenceTop}) — balcony frags would sail over the 3.2 m boundary into the void`,
    );
  if (!(nadeFenceTop - floorY > 0))
    throw new Error(`nuketown map data: nadeFenceTop ${nadeFenceTop} does not clear floorY ${floorY}`);
  const def: MapDef = {
    id: "nuketown",
    name: NUKETOWN_NAME,
    solids,
    floorY,
    bounds,
    nadeFenceRects,
    nadeFenceTop,
    spawns,
    navSeeds,
    navPockets: (f.navPockets ?? []) as [number, number][],
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
  CACHED_RAW = raw;
  CACHED_DEF = def;
  CACHED_GEO = A.geo;
  CACHED_DEF_GEO = nuketownGeoHash(def);
  if (typeof raw === "object" && raw !== null) DEF_CACHE.set(raw, { def, rawGeo: A.geo, defGeo: CACHED_DEF_GEO });
  return def;
}
