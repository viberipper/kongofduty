/**
 * client/src/ui/prefs.ts — THE SETTINGS MODEL. One object, persisted, live.
 * ===========================================================================
 *
 * Every player setting lives here: what the SETTINGS modal edits (menu and
 * in-match pause alike), what game.ts reads per frame (look sensitivity, ADS
 * multiplier, invert, FOV, ADS hold/toggle), and what the audio rig and the
 * HUD apply. It used to be four `state` fields in main.ts that reset on every
 * reload — sensitivity, volume, tac sprint and mode all came back to default
 * each time the page loaded.
 *
 * DOM-free and dependency-free on purpose: game.ts imports it on its hot path,
 * so it must never pull a screen module (or a stylesheet) along with it.
 *
 * Persisted under one key, sanitised on read (a stale or hand-edited value can
 * only ever come back as a legal one), and broadcast to subscribers on every
 * change so a slider moved in the pause menu applies on the very next frame.
 */

export type AdsMode = "hold" | "toggle";
export type RenderScaleMode = "auto" | "native";
export type MotionPref = "system" | "reduce" | "full";

export interface Prefs {
  // GAMEPLAY
  /** Look sensitivity multiplier (1 = the shipped feel). */
  sens: number;
  /** Extra multiplier while aiming down sights (on top of the built-in ADS slowdown). */
  adsSens: number;
  /** Horizontal field of view at 16:9, degrees (CoD convention). 100 = the shipped 68° vertical. */
  fov: number;
  invertY: boolean;
  adsMode: AdsMode;
  /** Double-tap SHIFT for tactical sprint. */
  tacSprint: boolean;
  /** Floating damage numbers over hit targets. */
  damageNumbers: boolean;
  // AUDIO (0..1)
  master: number;
  effects: number;
  ui: number;
  ambience: number;
  // GRAPHICS
  renderScale: RenderScaleMode;
  showFps: boolean;
  /** HUD size multiplier. */
  hudScale: number;
  motion: MotionPref;
  // NETWORK (advanced)
  /** A custom game server URL. Empty = this deployment's own server. */
  server: string;
}

export const DEFAULT_PREFS: Readonly<Prefs> = {
  sens: 1,
  adsSens: 1,
  fov: 100,
  invertY: false,
  adsMode: "hold",
  tacSprint: true,
  damageNumbers: true,
  master: 0.85,
  effects: 1,
  ui: 0.8,
  ambience: 0.8,
  renderScale: "auto",
  showFps: false,
  hudScale: 1,
  motion: "system",
  server: "",
};

export const PREFS_KEY = "shipment.prefs";

const clamp = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

export const RANGES = {
  sens: [0.2, 3, 0.05],
  adsSens: [0.5, 1.5, 0.05],
  fov: [60, 110, 1],
  hudScale: [0.85, 1.15, 0.05],
} as const;

export function sanitizePrefs(x: unknown): Prefs {
  const o = (x && typeof x === "object" ? x : {}) as Partial<Record<keyof Prefs, unknown>>;
  const d = DEFAULT_PREFS;
  return {
    sens: clamp(o.sens, RANGES.sens[0], RANGES.sens[1], d.sens),
    adsSens: clamp(o.adsSens, RANGES.adsSens[0], RANGES.adsSens[1], d.adsSens),
    fov: Math.round(clamp(o.fov, RANGES.fov[0], RANGES.fov[1], d.fov)),
    invertY: bool(o.invertY, d.invertY),
    adsMode: pick(o.adsMode, ["hold", "toggle"] as const, d.adsMode),
    tacSprint: bool(o.tacSprint, d.tacSprint),
    damageNumbers: bool(o.damageNumbers, d.damageNumbers),
    master: clamp(o.master, 0, 1, d.master),
    effects: clamp(o.effects, 0, 1, d.effects),
    ui: clamp(o.ui, 0, 1, d.ui),
    ambience: clamp(o.ambience, 0, 1, d.ambience),
    renderScale: pick(o.renderScale, ["auto", "native"] as const, d.renderScale),
    showFps: bool(o.showFps, d.showFps),
    hudScale: clamp(o.hudScale, RANGES.hudScale[0], RANGES.hudScale[1], d.hudScale),
    motion: pick(o.motion, ["system", "reduce", "full"] as const, d.motion),
    server: typeof o.server === "string" ? o.server.trim().slice(0, 200) : d.server,
  };
}

function load(): Prefs {
  try {
    return sanitizePrefs(JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let current: Prefs = load();
// `?quality=native` (the old Ares-only control, and what QA links pin) still
// wins for this page load without overwriting the saved choice.
try {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("quality") === "native") {
    current = { ...current, renderScale: "native" };
  }
} catch {
  /* no location */
}

type Listener = (p: Readonly<Prefs>, changed: (keyof Prefs)[]) => void;
const listeners = new Set<Listener>();

/** The live settings. Cheap: a module-level object read, safe per frame. */
export function prefs(): Readonly<Prefs> {
  return current;
}

/** Change one or more settings: sanitised, persisted, broadcast. */
export function setPrefs(patch: Partial<Prefs>): void {
  const next = sanitizePrefs({ ...current, ...patch });
  const changed = (Object.keys(next) as (keyof Prefs)[]).filter((k) => next[k] !== current[k]);
  if (!changed.length) return;
  current = next;
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(current));
  } catch {
    /* private mode — still applies for this session */
  }
  for (const l of listeners) l(current, changed);
}

export function resetPrefs(keys: (keyof Prefs)[]): void {
  const patch: Partial<Prefs> = {};
  for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULT_PREFS[k];
  setPrefs(patch);
}

/** Subscribe; called immediately once with the current values. Returns unsubscribe. */
export function onPrefs(fn: Listener): () => void {
  listeners.add(fn);
  fn(current, Object.keys(current) as (keyof Prefs)[]);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- game hooks

/** Vertical FOV (three.js camera.fov) for the player's horizontal 16:9 FOV setting. */
export function vfov(h = current.fov): number {
  const r = Math.tan((h * Math.PI) / 360) / (16 / 9);
  return (Math.atan(r) * 360) / Math.PI;
}

/** Horizontal 16:9 FOV for a vertical one (the inverse of vfov). */
export function hfov(v: number): number {
  return (Math.atan(Math.tan((v * Math.PI) / 360) * (16 / 9)) * 360) / Math.PI;
}

/** Reduced motion, resolved against the OS preference. */
export function reducedMotion(): boolean {
  if (current.motion === "reduce") return true;
  if (current.motion === "full") return false;
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}
