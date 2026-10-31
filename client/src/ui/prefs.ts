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
/**
 * GPU backend wish, resolved by gpu-backend.ts (a refused WebGPU device falls
 * back to WebGL2 with a console warning — never a black canvas).
 *
 * SHIPPING STATE: WebGL2 only. The WebGPU path is fully kept in the tree
 * (gpu-backend, webgpu-pipeline, tsl-materials and the TSL ports of the Ares
 * shaders, the astronaut suit and the weapon FX), but it is not selectable: the
 * pref is pinned to "webgl" by sanitizePrefs below and the GRAPHICS tab has no
 * renderer row. `?renderer=webgpu` still forces it for development and QA (the
 * query is read at boot, never persisted), which is how the port keeps being
 * verified while it is out of the UI.
 *
 * The WebGPU path still misses node equivalents for several world shaders
 * (Nuketown sky, the onBeforeCompile patches), so a player must not land on it
 * by accident.
 */
export type RendererPref = "auto" | "webgpu" | "webgl";
/** Quality preset (graphics-presets.ts): starting point, freely adjustable afterwards. */
export type QualityPreset = "low" | "medium" | "high" | "ultra" | "cinematic";
/**
 * Anti-aliasing mode.
 * AUTO keeps the shipped behaviour: MSAA on the WebGL composer (4x at DPR<=1.25,
 * else 2x) and FXAA where MSAA cannot run. MSAA levels are geometric AA (the
 * cleanest edges, but they need multisampled targets); FXAA/SMAA are post
 * filters (one fullscreen pass, work everywhere).
 * On WebGPU the geometry path is single-sample by necessity (GTAO's centre tap
 * cannot read a multisampled depth texture), so an MSAA choice there resolves to
 * SMAA — the best post filter three ships — instead of silently doing nothing.
 */
export type AAMode = "auto" | "off" | "fxaa" | "smaa" | "msaa2" | "msaa4" | "msaa8";
/** Shadow map resolution. HIGH = map-authored (no overwrite), MEDIUM = 2048. */
export type ShadowQuality = "off" | "low" | "medium" | "high" | "ultra";
/** Gamepad: response curve of the right stick (LOOK). */
export type PadCurve = "standard" | "linear" | "precise";
/** Gamepad: button layout — DEFAULT (R3 = melee, B = crouch) or TACTICAL (swapped). */
export type PadButtonLayout = "default" | "tactical";
/** Gamepad: stick layout — DEFAULT (left move, right look) or SOUTHPAW (swapped). */
export type PadStickLayout = "default" | "southpaw";
/** Colour-vision mode — repaints the ally / enemy pair everywhere team identity shows. */
export type ColorMode = "default" | "protanopia" | "deuteranopia" | "tritanopia";

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
  /** GUN GAME kills per gun in bot matches (and a new lobby's default). */
  gunKills: number;
  /** Which spray tag (client/src/sprays.ts SPRAY_NAMES). */
  spray: number;
  // AUDIO (0..1)
  master: number;
  effects: number;
  ui: number;
  ambience: number;
  /** Passive per-map menu/lobby background music (client/src/menu-music.ts). 0 mutes it. */
  music: number;
  /** Menu music mute switch (main-menu topbar toggle). Persists; the AUDIO slider keeps driving the level. */
  musicMuted: boolean;
  /** The match announcer (client/src/announcer.ts) — voice + subtitles. */
  announcer: boolean;
  /** Your Kong's own gruff voice lines (announcer.ts kong()). */
  kongVoice: boolean;
  /** Double/Multi/Triple/Quad/Mega-Kill and streak calls (Rampage/Unstoppable/Legend) — voice + subtitles. On by default. Cosmetic only: the sim's artillery still lands with it off, and the 10-kill frag reward is a sim grant the toggle never gates — only the banner and the voice go quiet. */
  killstreaks: boolean;
  // GRAPHICS
  renderScale: RenderScaleMode;
  showFps: boolean;
  /** Upstream (.origin 28.10.): NETWORK STATS overlay — FPS, ping, jitter, snapshot loss under the FPS corner. */
  netStats: boolean;
  /** HUD size multiplier. */
  hudScale: number;
  motion: MotionPref;
  /** Colour-vision mode for the team colours (TEAM_COLORS below). */
  colorMode: ColorMode;
  // GRAPHICS · AAA (needs reload: renderer only; everything else is live)
  /** GPU backend preference. AUTO = WebGPU when available, else WebGL2. Takes effect after reload. */
  renderer: RendererPref;
  /** Quality preset LOW→CINEMATIC. Sets the switches below; they stay individually adjustable. */
  quality: QualityPreset;
  /** Anti-aliasing mode (AUTO = shipped: MSAA on WebGL, FXAA elsewhere). */
  aa: AAMode;
  /** Selective HDR bloom (sun, muzzle flash, explosions). */
  bloom: boolean;
  /** Additive halo strength (0 = the pass is a no-op). */
  bloomStrength: number;
  /** Screen-space contact AO on every map (hardware tier only). */
  ao: boolean;
  /** AO composite strength. */
  aoStrength: number;
  /** Radial chromatic aberration (grows toward the edges). */
  chromatic: boolean;
  /** Animated film grain. */
  grain: boolean;
  /** Vignette (grows while aiming). */
  vignette: boolean;
  /** Subtle afterimage motion blur. Off by default. */
  motionBlur: boolean;
  /** Cheap edge-softening depth-of-field fake. Off by default. */
  dof: boolean;
  /** CAS-lite sharpness (0 = off). */
  sharpen: number;
  /** Exposure multiplier on top of the map's signed exposure. */
  exposure: number;
  /** Shadow map resolution (OFF disables shadows). Live, no reload. */
  shadowQuality: ShadowQuality;
  // NETWORK (advanced)
  /** A custom game server URL. Empty = this deployment's own server. */
  server: string;
  // GAMEPAD (controller — ui/gamepad.ts reads them per frame, SETTINGS → CONTROLS edits them)
  /** Evaluate gamepad input at all. */
  padEnabled: boolean;
  /** Look speed of the right stick (1 = shipped feel). */
  padSens: number;
  /** Extra multiplier when aiming (ADS) for the stick. Independent of adsSens (mouse). */
  padAdsSens: number;
  /** Dead zone of both sticks (drift protection). */
  padDeadzone: number;
  /** Response curve of the right stick. */
  padCurve: PadCurve;
  /** Invert the vertical stick axis. Independent of invertY (mouse). */
  padInvertY: boolean;
  /** Controller vibration (trigger, hits, damage). */
  padVibrate: boolean;
  /** Aim assist: look slows near enemies + a slight magnet toward the target. */
  padAimAssist: boolean;
  /** Aim-assist strength (0 = minimal only, 1 = full slowdown + magnet). */
  padAimStrength: number;
  /** Button layout: DEFAULT (R3 = melee) or TACTICAL (R3 = crouch). */
  padLayout: PadButtonLayout;
  /** Stick layout: DEFAULT (left move) or SOUTHPAW (sticks swapped). */
  padStick: PadStickLayout;
}

export const DEFAULT_PREFS: Readonly<Prefs> = {
  sens: 1,
  adsSens: 1,
  fov: 100,
  invertY: false,
  adsMode: "hold",
  tacSprint: true,
  damageNumbers: true,
  gunKills: 3,
  spray: 0,
  master: 0.85,
  effects: 1,
  ui: 0.8,
  ambience: 0.8,
  music: 0.35,
  musicMuted: false,
  announcer: true,
  kongVoice: true,
  killstreaks: true,
  renderScale: "auto",
  showFps: false,
  netStats: false,
  hudScale: 1,
  motion: "system",
  colorMode: "default",
  renderer: "webgl",
  quality: "high",
  aa: "auto",
  // M1: HIGH == the old look — everything new is default-off (migrated saves
  // look exactly as before). bloom-/aoStrength are only slider presets
  // for manual enabling.
  bloom: false,
  bloomStrength: 0.35,
  ao: false,
  aoStrength: 0.7,
  chromatic: false,
  grain: true,
  vignette: true,
  motionBlur: false,
  dof: false,
  sharpen: 0,
  exposure: 1.12,
  shadowQuality: "high",
  server: "",
  padEnabled: true,
  padSens: 1.4,
  padAdsSens: 0.7,
  padDeadzone: 0.12,
  padCurve: "standard",
  padInvertY: false,
  padVibrate: true,
  padAimAssist: true,
  padAimStrength: 0.6,
  padLayout: "default",
  padStick: "default",
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
  bloomStrength: [0, 1.5, 0.05],
  aoStrength: [0, 1.5, 0.05],
  sharpen: [0, 1, 0.05],
  exposure: [0.5, 1.6, 0.01],
  padSens: [0.2, 4, 0.05],
  padAdsSens: [0.3, 1.5, 0.05],
  padDeadzone: [0.05, 0.4, 0.01],
  padAimStrength: [0, 1, 0.05],
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
    gunKills: [1, 2, 3, 5].includes(o.gunKills as number) ? (o.gunKills as number) : d.gunKills,
    spray: [0, 1, 2, 3].includes(o.spray as number) ? (o.spray as number) : d.spray,
    master: clamp(o.master, 0, 1, d.master),
    effects: clamp(o.effects, 0, 1, d.effects),
    ui: clamp(o.ui, 0, 1, d.ui),
    ambience: clamp(o.ambience, 0, 1, d.ambience),
    music: clamp(o.music, 0, 1, d.music),
    musicMuted: bool(o.musicMuted, d.musicMuted),
    announcer: bool(o.announcer, d.announcer),
    kongVoice: bool(o.kongVoice, d.kongVoice),
    killstreaks: bool(o.killstreaks, d.killstreaks),
    renderScale: pick(o.renderScale, ["auto", "native"] as const, d.renderScale),
    showFps: bool(o.showFps, d.showFps),
    netStats: bool(o.netStats, d.netStats),
    hudScale: clamp(o.hudScale, RANGES.hudScale[0], RANGES.hudScale[1], d.hudScale),
    motion: pick(o.motion, ["system", "reduce", "full"] as const, d.motion),
    colorMode: pick(o.colorMode, ["default", "protanopia", "deuteranopia", "tritanopia"] as const, d.colorMode),
    // PINNED: WebGL2 only for players (see the RendererPref comment). The WebGPU
    // path is developed behind ?renderer=webgpu; a stored or hand-edited
    // "webgpu"/"auto" sanitises back to "webgl" so nobody boots into a backend
    // that still has world-shader gaps.
    renderer: "webgl",
    quality: pick(o.quality, ["low", "medium", "high", "ultra", "cinematic"] as const, d.quality),
    aa: pick(o.aa, ["auto", "off", "fxaa", "smaa", "msaa2", "msaa4", "msaa8"] as const, d.aa),
    bloom: bool(o.bloom, d.bloom),
    bloomStrength: clamp(o.bloomStrength, RANGES.bloomStrength[0], RANGES.bloomStrength[1], d.bloomStrength),
    ao: bool(o.ao, d.ao),
    aoStrength: clamp(o.aoStrength, RANGES.aoStrength[0], RANGES.aoStrength[1], d.aoStrength),
    chromatic: bool(o.chromatic, d.chromatic),
    grain: bool(o.grain, d.grain),
    vignette: bool(o.vignette, d.vignette),
    motionBlur: bool(o.motionBlur, d.motionBlur),
    dof: bool(o.dof, d.dof),
    sharpen: clamp(o.sharpen, RANGES.sharpen[0], RANGES.sharpen[1], d.sharpen),
    exposure: clamp(o.exposure, RANGES.exposure[0], RANGES.exposure[1], d.exposure),
    shadowQuality: pick(o.shadowQuality, ["off", "low", "medium", "high", "ultra"] as const, d.shadowQuality),
    server: typeof o.server === "string" ? o.server.trim().slice(0, 200) : d.server,
    padEnabled: bool(o.padEnabled, d.padEnabled),
    padSens: clamp(o.padSens, RANGES.padSens[0], RANGES.padSens[1], d.padSens),
    padAdsSens: clamp(o.padAdsSens, RANGES.padAdsSens[0], RANGES.padAdsSens[1], d.padAdsSens),
    padDeadzone: clamp(o.padDeadzone, RANGES.padDeadzone[0], RANGES.padDeadzone[1], d.padDeadzone),
    padCurve: pick(o.padCurve, ["standard", "linear", "precise"] as const, d.padCurve),
    padInvertY: bool(o.padInvertY, d.padInvertY),
    padVibrate: bool(o.padVibrate, d.padVibrate),
    padAimAssist: bool(o.padAimAssist, d.padAimAssist),
    padAimStrength: clamp(o.padAimStrength, RANGES.padAimStrength[0], RANGES.padAimStrength[1], d.padAimStrength),
    padLayout: pick(o.padLayout, ["default", "tactical"] as const, d.padLayout),
    padStick: pick(o.padStick, ["default", "southpaw"] as const, d.padStick),
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
// `?renderer=webgl|webgpu|auto` also pins the backend for this page load
// without overwriting the saved choice (same contract as `?quality`).
try {
  if (typeof location !== "undefined") {
    const q = new URLSearchParams(location.search);
    if (q.get("quality") === "native") current = { ...current, renderScale: "native" };
    const r = q.get("renderer");
    if (r === "auto" || r === "webgpu" || r === "webgl") current = { ...current, renderer: r };
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

// ---------------------------------------------------------------- team colours

/**
 * TEAM COLOURS PER COLOUR-VISION MODE. `ally` / `enemy` are the
 * ui/tokens.css --c-ally / --c-enemy pair (nameplates, chevrons, scorebug,
 * killfeed); `mini*` are the minimap's squad arrow and enemy blip, as r,g,b.
 * Default is the shipped CoD blue / red, byte for byte. The others keep blue
 * for your side wherever it survives the deficiency and move the enemy to a
 * hue that does: amber for red-weak (protan) and orange for green-weak
 * (deutan) eyes; for blue-yellow (tritan) eyes, teal vs magenta-red.
 */
export const TEAM_COLORS: Record<ColorMode, { ally: string; enemy: string; miniAlly: string; miniEnemy: string }> = {
  default: { ally: "#3ea6ff", enemy: "#ff4a3d", miniAlly: "74,168,255", miniEnemy: "255,80,64" },
  protanopia: { ally: "#3ea6ff", enemy: "#ffc21a", miniAlly: "74,168,255", miniEnemy: "255,194,26" },
  deuteranopia: { ally: "#3ea6ff", enemy: "#ff8a1f", miniAlly: "74,168,255", miniEnemy: "255,138,31" },
  tritanopia: { ally: "#21d4c8", enemy: "#ff3d8b", miniAlly: "33,212,200", miniEnemy: "255,61,139" },
};

export function teamColors(): (typeof TEAM_COLORS)[ColorMode] {
  return TEAM_COLORS[current.colorMode];
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
