/**
 * THE ACTIVE MAP — chosen ONCE, before anything derived from it is built.
 *
 * PLAN A (docs/dustmap/report-integration.md §17, LOCKED). One process / one page
 * load = one map. No runtime switching, no world teardown, no map id on the
 * wire. That is not a shortcut: six singletons in shared/sim.ts (the nade fence,
 * the seam plugs, NADE_SOLIDS, the broadphase, BOT_NAV and the Floyd-Warshall
 * hop table) are derived from the collider set before the first tick, and
 * rebuilding them mid-match would cost a visible stall and leave every live
 * grenade and every bot route pointing at a world that no longer exists.
 *
 * SELECTION, in order:
 *   browser  `?map=<id>`  ->  localStorage  ->  default
 *   node     `--map=<id>` ->  SHIPMENT_MAP env  ->  default
 *
 * The browser half copies audio-packs.ts `readPackPref` exactly — the shipped,
 * proven pattern for a URL-pinned option with a saved preference behind it — so
 * a qa instrument can pin a map on a link and a returning player keeps theirs.
 *
 * WHEN IS IT READ? Lazily, on the first `activeMap()` call — which is
 * shared/sim.ts's module body, i.e. before any client code runs at all. Module
 * imports are hoisted above `boot()`, so main.ts cannot set this "first"; what
 * main.ts does instead is CONFIRM the choice (and persist it), which is why
 * `lockActiveMap()` is a no-op when the answer already matches and throws when
 * it does not. A mismatch there would mean the sim built one map and the
 * renderer drew another.
 *
 * WHERE THE GEOMETRY COMES FROM. Shipment's is code. dust2's is 3,144 generated
 * colliders and it must NOT be in the bundle — a Shipment player paid +266.6 kB
 * raw / +39.3 kB gzip for a map they never load (spec-sim-implemented.md §9 P0).
 * So dust2's data is a static asset, `preloadMapData()` fetches it, and
 * `activeMap()` builds the MapDef from what was fetched. That makes ORDER load
 * bearing: `preloadMapData()` must complete before ANY module that imports
 * shared/sim.ts is evaluated, which is why client/src/main.ts reaches game.ts
 * through a dynamic import after a top-level await. Ask for a map whose data was
 * never preloaded and you get an error naming the fix, not a silent fallback to
 * the wrong world.
 */

import { setActiveWorld } from "../map";
import type { MapDef } from "./types";
import { SHIPMENT } from "./shipment";
import { ARES } from "./ares";
import { buildDust2, DUST2_NAME } from "./dust2";
import { buildNuketown, NUKETOWN_NAME } from "./nuketown"; // nuketown: JSON-backed like dust2

export type { MapDef, Rect, FenceRect, MinimapRect, NavLattice } from "./types";
export { DUST2_AUDIT, DUST2_IS_STUB, buildDust2 } from "./dust2";
export { NUKETOWN_AUDIT, buildNuketown } from "./nuketown";

export const MAP_IDS = ["shipment", "dust2", "ares", "nuketown"] as const;

export const DEFAULT_MAP_ID = "shipment";

/**
 * Menu/lobby options, in display order — THE map list every screen renders
 * (menu cards, lobby card, loading screen). Adding a map is one entry here.
 *
 *  - `label` is the ONE display name (Shipment used to be called three things).
 *    It names the map only — never a mode or a team size; those come from
 *    shared/modes.ts so they cannot disagree with what the room runs.
 *  - `card` is the 16:9 card / loading-screen still, relative to the site base
 *    (static/…). Omitted → `assets/ui/maps/<key>.jpg`.
 *  - `blurb` is one line for the card.
 */
export interface MapOption {
  key: string;
  label: string;
  card?: string;
  blurb?: string;
}
export const MAP_OPTIONS: MapOption[] = [
  { key: "shipment", label: "SHIPMENT", blurb: "Tight container yard. Constant contact." },
  { key: "dust2", label: DUST2_NAME, blurb: "Long lanes, two sites, a middle to fight over." },
  { key: "ares", label: "ARES RELAY", blurb: "Orbital station. Corridors and a glass core." },
  { key: "nuketown", label: NUKETOWN_NAME, blurb: "Two houses, one cul-de-sac. Every window is a lane." },
];

// ---------------------------------------------------------------- map data
/**
 * Generated data, per map, keyed by id. Only maps with a `MAP_DATA_URL` entry
 * need it; Shipment is code and never appears here.
 *
 * NEVER `/dustmap/...`: client/src/asset-base.ts only rewrites paths that start
 * with `/assets/`, so any other absolute path 404s at root.
 */
const MAP_DATA_URL: Record<string, string> = {
  dust2: "assets/maps/dust2.json",
  nuketown: "assets/maps/nuketown.json",
};
const MAP_DATA: Record<string, unknown> = {};

/** Has this map's generated data been loaded yet? (Shipment: always true.) */
export function mapDataReady(id: string): boolean {
  return !MAP_DATA_URL[id] || MAP_DATA[id] !== undefined;
}

/** Hand data in directly — harnesses, the server's own loader, tests. */
export function setMapData(id: string, raw: unknown): void {
  MAP_DATA[id] = raw;
}

/**
 * Load the generated data for one map (default: the map this process resolved).
 * Idempotent, and a no-op for maps that carry their geometry in code.
 *
 * Browser: `fetch`, resolved against `document.baseURI` so the root-mounted
 * page and the dev server both land on the right URL without importing
 * Vite's `import.meta.env` into a module the server also runs.
 * Node: `fs`, via a computed specifier so the bundler never tries to resolve
 * `node:fs` for the browser build.
 */
export async function preloadMapData(id?: string): Promise<void> {
  const want = id ?? resolveMapId();
  const rel = MAP_DATA_URL[want];
  if (!rel || MAP_DATA[want] !== undefined) return;
  const hasDom = typeof document !== "undefined" && typeof fetch === "function";
  if (hasDom) {
    const url = new URL(rel, document.baseURI).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`map "${want}": ${url} -> HTTP ${res.status}`);
    MAP_DATA[want] = await res.json();
    return;
  }
  const fsMod = "node:fs/promises";
  const urlMod = "node:url";
  const fs = (await import(/* @vite-ignore */ fsMod)) as typeof import("node:fs/promises");
  const nodeUrl = (await import(/* @vite-ignore */ urlMod)) as typeof import("node:url");
  // shared/maps/index.ts -> repo root -> client/static/<rel>
  const file = nodeUrl.fileURLToPath(new URL(`../../client/static/${rel}`, import.meta.url));
  MAP_DATA[want] = JSON.parse(await fs.readFile(file, "utf8"));
}

/**
 * SELF-PRELOAD, AT MODULE EVALUATION. This top-level await is the mechanism.
 *
 * There is no entry point early enough to do it from. `activeMap()` is called in
 * MODULE BODIES — shared/sim.ts:80 builds six singletons out of it — and those
 * run when the module graph is linked, long before `boot()` or any server code.
 * A preload in an entry file only covers the modules that entry imports LAZILY;
 * one static import anywhere else walks straight past it and throws.
 *
 * client/src/lobby.ts used to be exactly that second case: `diag.clientMap` was
 * an initialiser, so linking lobby.ts resolved the map. It is a GETTER now
 * (lobby.ts `const diag: Diag`, `get clientMap()`), which answers at read time
 * instead — but the top-level await is still what makes THAT safe, and it is
 * still what shared/sim.ts requires, so nothing here changes on its account.
 *
 * A top-level await here covers all of them at once: ES modules with TLA
 * suspend every importer until the promise settles, so by the time ANY module
 * that imports this one runs a line, the data is in memory and `activeMap()` is
 * synchronous — which is what shared/sim.ts requires.
 *
 * It costs a Shipment page load nothing: `preloadMapData` returns immediately
 * for a map whose geometry is code, so this is an already-resolved promise and
 * the `node:fs` / `fetch` branches are never reached.
 */
await preloadMapData();

function mapDataOrThrow(id: string): unknown {
  const raw = MAP_DATA[id];
  if (raw === undefined) {
    throw new Error(
      `map "${id}" has no data loaded. Call \`await preloadMapData("${id}")\` from shared/maps BEFORE anything imports shared/sim.ts ` +
        `(client/src/main.ts does this at top level, then reaches game.ts through a dynamic import).`,
    );
  }
  return raw;
}

function buildMap(id: string): MapDef {
  if (id === "shipment") return SHIPMENT;
  if (id === "ares") return ARES;
  if (id === "dust2") return buildDust2(mapDataOrThrow("dust2"));
  if (id === "nuketown") return buildNuketown(mapDataOrThrow("nuketown"));
  throw new Error(`unknown map "${id}"`);
}

/**
 * The known maps, BUILT ON ACCESS. Kept as a plain-looking record because that
 * is the shape every call site expects, but each value is a getter: touching
 * `MAPS.dust2` constructs the MapDef from preloaded data, and never touching it
 * costs a Shipment client nothing at all.
 */
export const MAPS: Record<string, MapDef> = {};
for (const id of MAP_IDS) {
  Object.defineProperty(MAPS, id, { enumerable: true, configurable: false, get: () => buildMap(id) });
}

/**
 * Pin a game-socket URL to a map: `ws://host/ws` -> `ws://host/ws?map=<id>`.
 * The server hub (server/hub.ts) routes the upgrade to the process that
 * simulates that map, so the page's locked map and the authority's map are the
 * same map by construction. An existing `map=` (a hand-typed host, a QA pin) is
 * left alone. A string that is not a URL is returned untouched.
 */
export function withMapQuery(url: string, id: string, force = false): string {
  if (!isMapId(id)) return url;
  try {
    const u = new URL(url);
    if (force || !u.searchParams.has("map")) u.searchParams.set("map", id);
    return u.toString();
  } catch {
    return url;
  }
}

const LS_KEY = "shipment.map";

export function isMapId(id: string | null | undefined): id is string {
  return !!id && (MAP_IDS as readonly string[]).includes(id);
}

/**
 * `?map=<id>` wins (qa + shareable links), then the saved choice, then the
 * default. Untrusted input is whitelisted, never trusted — same shape as
 * server/index.ts `roomCode()`.
 */
export function readMapPref(search?: string): string {
  const s = search ?? (typeof location !== "undefined" ? location.search : "");
  try {
    const q = new URLSearchParams(s).get("map");
    if (isMapId(q)) return q;
  } catch {
    /* no URL API / malformed query */
  }
  try {
    if (typeof localStorage !== "undefined") {
      const v = localStorage.getItem(LS_KEY);
      if (isMapId(v)) return v;
    }
  } catch {
    /* private mode */
  }
  return DEFAULT_MAP_ID;
}

export function writeMapPref(id: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, id);
  } catch {
    /* private mode */
  }
}

/** Node: `--map=<id>` on argv, then SHIPMENT_MAP in the environment. */
function readMapArg(): string {
  const g = globalThis as { process?: { argv?: string[]; env?: Record<string, string | undefined> } };
  const argv = g.process?.argv ?? [];
  for (const a of argv) {
    if (a.startsWith("--map=")) {
      const v = a.slice(6);
      if (isMapId(v)) return v;
      throw new Error(`--map=${v} is not a known map (${MAP_IDS.join(", ")})`);
    }
  }
  const env = g.process?.env?.SHIPMENT_MAP;
  if (env) {
    if (isMapId(env)) return env;
    throw new Error(`SHIPMENT_MAP=${env} is not a known map (${MAP_IDS.join(", ")})`);
  }
  return DEFAULT_MAP_ID;
}

function resolveMapId(): string {
  const hasDom = typeof location !== "undefined" && typeof location.search === "string";
  return hasDom ? readMapPref(location.search) : readMapArg();
}

let ACTIVE: MapDef | null = null;

/** The map this process is running. Resolved on first call, then frozen. */
export function activeMap(): MapDef {
  if (!ACTIVE) {
    const id = resolveMapId();
    ACTIVE = isMapId(id) ? buildMap(id) : SHIPMENT;
    // Point the two unqualified query functions (and their broadphase index) at
    // this map BEFORE anything derived from it is built.
    setActiveWorld(ACTIVE.solids, ACTIVE.floorY);
  }
  return ACTIVE;
}

/** Has the choice been made yet? (Instruments and tests; never gameplay.) */
export function activeMapResolved(): boolean {
  return ACTIVE !== null;
}

/**
 * Confirm the boot-time choice — main.ts calls this after the DOM exists.
 * Agreeing is a no-op; disagreeing is fatal, because by the time anyone can
 * disagree the sim has already built a nade fence, a nav graph and a hop table
 * out of the OTHER map.
 */
export function lockActiveMap(id: string): MapDef {
  const want = isMapId(id) ? id : DEFAULT_MAP_ID;
  const got = activeMap();
  if (got.id !== want) {
    throw new Error(
      `map already locked to "${got.id}" but "${want}" was requested — the map must be chosen before shared/sim.ts is imported`,
    );
  }
  return got;
}

/**
 * TEST-ONLY. Force the active map before anything reads it. Throws once
 * anything has, because every derived singleton would already be stale.
 */
export function setActiveMapForTests(id: string): MapDef {
  if (ACTIVE) throw new Error(`map already resolved to "${ACTIVE.id}"`);
  if (!isMapId(id)) throw new Error(`unknown map "${id}"`);
  const m = buildMap(id);
  ACTIVE = m;
  setActiveWorld(m.solids, m.floorY);
  return m;
}
