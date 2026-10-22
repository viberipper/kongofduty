/**
 * client/src/ui/flow.ts — getting from "I pressed a button" to "I am in a
 * match", across the one reload a map change costs.
 * ===========================================================================
 *
 * ONE PAGE LOAD IS ONE MAP (shared/maps). Choosing a map the page has not
 * built therefore reloads the page. That reload used to be where the start
 * flow died: the host gate did `location.replace(?map=)`, the page came back
 * on the plain menu, the callsign typed a moment ago was not saved yet, and
 * the player had to make the lobby a second time. Leftover `?join=` / `?play`
 * parameters then rode every later reload.
 *
 * Now every map-changing navigation goes through `goToMap()`, which
 *   1. stores an INTENT (what the player was doing: quick play, host a
 *      private match, join public, join an invite) in sessionStorage, and
 *   2. navigates to a CLEAN url — this deployment's base path, `?map=`, and
 *      only the diagnostic params worth keeping (never join/play/test).
 * `boot()` in main.ts takes the intent and resumes it on the first frame, so
 * the player sees one loading screen and lands where they were going.
 *
 * Also: the map card art + display name helpers (data-driven from
 * shared/maps MAP_OPTIONS; adding a map is one entry there).
 */
import { DEFAULT_MAP_ID, MAP_OPTIONS, isMapId } from "@shared/maps";
import type { ModeId } from "@shared/modes";

export type Intent =
  | { kind: "bots"; map: string; mode: ModeId }
  /** `room`: re-open THIS code (a lobby the host moved to another map). */
  | { kind: "host"; map: string; mode: ModeId; room?: string }
  | { kind: "yard"; map: string }
  /** `wait`: the room is moving here — wait for its host to re-open it rather than calling it dead. */
  | { kind: "invite"; map: string; room: string; mode?: ModeId; wait?: boolean };

const INTENT_KEY = "shipment.intent";
/** Params that survive a map change (diagnostics and pins a tester set on purpose). */
const KEEP_PARAMS = ["quality", "diagnostics", "pack", "aresqa", "debug"];

export function saveIntent(i: Intent): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ ...i, at: Date.now() }));
  } catch {
    /* storage off — the reload still lands on the right map, just on the menu */
  }
}

/**
 * Read AND clear the pending intent. Stale ones (> 2 min, or for a map this
 * page did not load) are dropped: an intent is a promise about the very next
 * page load, never a standing order.
 */
export function takeIntent(pageMap: string): Intent | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Intent & { at?: number };
    if (!o || typeof o !== "object" || !o.kind || o.map !== pageMap) return null;
    if (!o.at || Date.now() - o.at > 120_000) return null;
    return o;
  } catch {
    return null;
  }
}

/** This deployment's clean URL for a map (base path, ?map=, kept diagnostics). */
export function cleanUrl(map?: string): string {
  const u = new URL(location.href);
  const keep = new URLSearchParams();
  for (const k of KEEP_PARAMS) {
    const v = u.searchParams.get(k);
    if (v !== null) keep.set(k, v);
  }
  if (map && isMapId(map)) keep.set("map", map);
  u.search = keep.toString();
  u.hash = "";
  return u.toString();
}

/** Reload onto `map`, carrying `intent` across. Returns false if no reload was needed. */
export function goToMap(map: string, intent: Intent | null, current: string): boolean {
  if (!isMapId(map)) return false;
  if (map === current && !intent) return false;
  if (intent) saveIntent(intent);
  location.replace(cleanUrl(map));
  return true;
}

/** Drop ?join / ?play / #play from the address bar without reloading (back to menu, etc.). */
export function stripTransientParams(map: string): void {
  try {
    const next = cleanUrl(map);
    if (next !== location.href) history.replaceState(history.state, "", next);
  } catch {
    /* sandboxed history */
  }
}

// ---------------------------------------------------------------- map cards

const base = (): string => {
  const b = (import.meta.env?.BASE_URL as string | undefined) || "/";
  return b.endsWith("/") ? b : b + "/";
};

export function mapLabel(id: string): string {
  return MAP_OPTIONS.find((o) => o.key === id)?.label ?? id.toUpperCase();
}

export function mapBlurb(id: string): string {
  return MAP_OPTIONS.find((o) => o.key === id)?.blurb ?? "";
}

/** CSS url() for the map's 16:9 still. Unknown ids fall back to the default
 * map's still (no throw — callers paint optimistically, e.g. from a server
 * snapshot that may name a map this build does not know). The id/card are
 * quote-escaped so the url("...") context cannot be broken out of. */
export function mapCardUrl(id: string): string {
  const safe = isMapId(id) ? id : DEFAULT_MAP_ID;
  const rel = MAP_OPTIONS.find((o) => o.key === safe)?.card ?? `assets/ui/maps/${safe}.jpg`;
  const esc = rel.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/^\//, "");
  return `url("${base()}${esc}")`;
}

export function mapIds(): string[] {
  return MAP_OPTIONS.map((o) => o.key);
}
