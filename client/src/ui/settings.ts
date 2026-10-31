/**
 * client/src/ui/settings.ts — THE settings modal. One, for every map, opened
 * from the main menu AND from the in-match pause menu.
 *
 * Tabbed (GAMEPLAY · AUDIO · GRAPHICS · CONTROLS), dense rows on the left, the
 * focused row explained on the right — CoD's settings anatomy. Every control
 * writes through ui/prefs.ts, which persists and live-applies (the game reads
 * sensitivity / FOV / ADS mode per frame; main.ts applies audio, HUD size,
 * FPS and render scale on change). Q / E switch tabs, ESC closes.
 */
import { DEFAULT_PREFS, RANGES, prefs, resetPrefs, setPrefs, type Prefs } from "./prefs";
import { QUALITY_PRESETS } from "../graphics-presets";
import { uiSfx, wireSfx } from "./sfx";
// feel stream: CONTROLS rebinds the live keybinding table every game input reads.
import { ACTIONS, DEFAULT_BINDS, binds, bindable, keyLabel, resetBinds, setBind, wheelCodes, type Action } from "./keybinds";
// gamepad stream: CONTROLS owns the controller block too (status, sticks, rumble, aim assist, layout).
import { gamepadSupported, padDisplayName, padGlyph, padMapping, padPromptsActive, rumbleShot } from "./gamepad";

export type PackOption = { key: string; label: string };
export interface SettingsDeps {
  packs: PackOption[];
  readPack: () => string;
  /** Persist + load a sound pack; resolves with a status line for the note. */
  setPack: (key: string) => Promise<string>;
  packNote: () => string;
  /** Live match in progress — a renderer switch must not reload it away. */
  inMatch: () => boolean;
}

type Tab = "gameplay" | "audio" | "graphics" | "controls";
const TABS: { id: Tab; label: string }[] = [
  { id: "gameplay", label: "GAMEPLAY" },
  { id: "audio", label: "AUDIO" },
  { id: "graphics", label: "GRAPHICS" },
  { id: "controls", label: "CONTROLS" },
];

type Row =
  | { group: string }
  | {
      key: keyof Prefs | "pack";
      label: string;
      desc: string;
      kind: "slider";
      min: number;
      max: number;
      step: number;
      fmt: (v: number) => string;
    }
  | { key: keyof Prefs | "pack"; label: string; desc: string; kind: "seg"; opts: { v: string | boolean | number; label: string }[] }
  | { key: keyof Prefs | "pack"; label: string; desc: string; kind: "select" }
  | { key: keyof Prefs; label: string; desc: string; kind: "text"; placeholder: string };

const pct = (v: number): string => `${Math.round(v * 100)}`;
const ON_OFF = [
  { v: false, label: "OFF" },
  { v: true, label: "ON" },
];

const ROWS: Record<Exclude<Tab, "controls">, Row[]> = {
  gameplay: [
    { group: "AIM" },
    {
      key: "sens",
      label: "Look Sensitivity",
      desc: "How far the view turns for a given mouse movement. 1.00 is the default feel.",
      kind: "slider",
      min: RANGES.sens[0],
      max: RANGES.sens[1],
      step: RANGES.sens[2],
      fmt: (v) => v.toFixed(2),
    },
    {
      key: "adsSens",
      label: "ADS Sensitivity Multiplier",
      desc: "Scales look sensitivity while aiming down sights, on top of the built-in ADS slowdown. Below 1.00 steadies long-range aim.",
      kind: "slider",
      min: RANGES.adsSens[0],
      max: RANGES.adsSens[1],
      step: RANGES.adsSens[2],
      fmt: (v) => v.toFixed(2),
    },
    { key: "invertY", label: "Invert Vertical Look", desc: "Moving the mouse forward looks down.", kind: "seg", opts: ON_OFF },
    {
      key: "adsMode",
      label: "Aim Down Sights",
      desc: "HOLD: aim while right mouse is held. TOGGLE: click once to aim, again to lower.",
      kind: "seg",
      opts: [
        { v: "hold", label: "HOLD" },
        { v: "toggle", label: "TOGGLE" },
      ],
    },
    { group: "VIEW" },
    {
      key: "fov",
      label: "Field of View",
      desc: "Horizontal field of view at 16:9, in degrees. Higher shows more of the world at the edges; lower makes targets larger. Default 100.",
      kind: "slider",
      min: RANGES.fov[0],
      max: RANGES.fov[1],
      step: RANGES.fov[2],
      fmt: (v) => `${Math.round(v)}`,
    },
    { group: "MOVEMENT" },
    {
      key: "tacSprint",
      label: "Tactical Sprint",
      desc: "Double-tap SHIFT while sprinting for a faster sprint. Your weapon takes longer to come up out of it.",
      kind: "seg",
      opts: ON_OFF,
    },
    { group: "SPRAY PAINT" },
    {
      key: "spray",
      label: "Spray Tag",
      desc: "The tag you spray with the SPRAY key (B by default; D-pad right on a controller). Everyone in the match sees it, until you spray again or the match ends.",
      kind: "seg",
      opts: [
        { v: 0, label: "BANANA" },
        { v: 1, label: "KONG" },
        { v: 2, label: "GG" },
        { v: 3, label: "EZ" },
      ],
    },
    { group: "GUN GAME" },
    {
      key: "gunKills",
      label: "Kills Per Gun",
      desc: "How many kills it takes to move up to the next gun in Gun Game bot matches, like CS2's Arms Race. 1 is a sprint through the ladder, 5 a long climb. In a private lobby the host picks it on the lobby screen.",
      kind: "seg",
      opts: [
        { v: 1, label: "1" },
        { v: 2, label: "2" },
        { v: 3, label: "3" },
        { v: 5, label: "5" },
      ],
    },
    { group: "INTERFACE" },
    {
      key: "colorMode",
      label: "Colour Vision",
      desc: "Recolours team identity — nameplates, markers, minimap, scorebug and killfeed — for protanopia (red-weak), deuteranopia (green-weak) or tritanopia (blue-yellow).",
      kind: "seg",
      opts: [
        { v: "default", label: "DEFAULT" },
        { v: "protanopia", label: "PROTAN" },
        { v: "deuteranopia", label: "DEUTAN" },
        { v: "tritanopia", label: "TRITAN" },
      ],
    },
    { key: "damageNumbers", label: "Damage Numbers", desc: "Show the damage each hit deals, floating over the target.", kind: "seg", opts: ON_OFF },
    {
      key: "hudScale",
      label: "HUD Size",
      desc: "Scales every in-match readout — minimap, score, ammo, killfeed.",
      kind: "slider",
      min: RANGES.hudScale[0],
      max: RANGES.hudScale[1],
      step: RANGES.hudScale[2],
      fmt: (v) => `${Math.round(v * 100)}%`,
    },
    { group: "NETWORK" },
    {
      key: "server",
      label: "Custom Server",
      desc: "Advanced. A ws:// or wss:// game server to use instead of this site's own. Leave blank to play on the official servers.",
      kind: "text",
      placeholder: "OFFICIAL SERVER",
    },
  ],
  audio: [
    { group: "VOLUME" },
    { key: "master", label: "Master Volume", desc: "Everything the game plays.", kind: "slider", min: 0, max: 1, step: 0.01, fmt: pct },
    { key: "effects", label: "Effects Volume", desc: "Gunfire, footsteps, grenades, impacts.", kind: "slider", min: 0, max: 1, step: 0.01, fmt: pct },
    { key: "ui", label: "Interface Volume", desc: "Menu sounds, hitmarkers, medals and the countdown.", kind: "slider", min: 0, max: 1, step: 0.01, fmt: pct },
    { key: "ambience", label: "Ambience Volume", desc: "The map's background bed.", kind: "slider", min: 0, max: 1, step: 0.01, fmt: pct },
    { key: "music", label: "Menu Music Volume", desc: "Passive background music over the main menu and the private lobby — one 60-second theme per map, switching with a crossfade when the picked map changes. 0 (or near 0) mutes it, as does the music button in the topbar.", kind: "slider", min: 0, max: 1, step: 0.01, fmt: pct },
    {
      key: "announcer",
      label: "Announcer",
      desc: "A game-show caller for the match: the mode at the start, one minute / thirty / ten seconds left, taking or losing the lead, first blood, streaks and multi-kills by name, and the result. Lines also show as subtitles. Uses a voice built into your computer; plays at the Interface volume.",
      kind: "seg",
      opts: ON_OFF,
    },
    {
      key: "kongVoice",
      label: "Kong Voice",
      desc: "Your Kong talks like a Halo Brute: \"Kong smash!\" on a kill, \"Head go pop!\" on a headshot, \"Catch banana!\" when you throw a frag, a grumble on reloads, respawns and big hits. Only you hear it; lines also show as subtitles.",
      kind: "seg",
      opts: ON_OFF,
    },
    {
      key: "killstreaks",
      label: "Killstreaks",
      desc: "Double Kill, Triple Kill, Quad, Mega Kill and streak calls (Rampage, Unstoppable, Living Legend) by name. On by default; everything else the announcer says — mode, countdowns, lead, first blood, shutdowns, result — stays, and so does the Kong.",
      kind: "seg",
      opts: ON_OFF,
    },
    { group: "MIX" },
    {
      key: "pack",
      label: "Sound Pack",
      desc: "Which recorded weapon and impact set the game uses. Loads on the next match if you are in the menu.",
      kind: "select",
    },
  ],
  graphics: [
    { group: "DISPLAY" },
    {
      key: "quality",
      label: "Quality Preset",
      desc: "One switch for the whole look: LOW (fast, internal resolution capped at 0.75x) to CINEMATIC (everything on, up to 8x MSAA on capable GPUs, depth of field, motion blur). MEDIUM caps at 0.85x. NATIVE render scale bypasses the cap. Applies instantly and sets every switch below — they stay individually adjustable afterwards. Weapons/viewmodel unaffected.",
      kind: "seg",
      opts: [
        { v: "low", label: "LOW" },
        { v: "medium", label: "MEDIUM" },
        { v: "high", label: "HIGH" },
        { v: "ultra", label: "ULTRA" },
        { v: "cinematic", label: "CINEMA" },
      ],
    },
    {
      key: "renderScale",
      label: "Render Resolution",
      desc: "ADAPTIVE lowers the internal resolution when the frame gets expensive and restores it when it is cheap — the smoothest option. NATIVE always renders at your display's full resolution.",
      kind: "seg",
      opts: [
        { v: "auto", label: "ADAPTIVE" },
        { v: "native", label: "NATIVE" },
      ],
    },
    {
      key: "renderer",
      label: "Renderer",
      desc: "Which graphics backend the game boots on. AUTO prefers WebGPU where the browser has it and otherwise stays on WebGL2; WEBGPU forces it (a refused device still falls back, with a console warning); WEBGL2 is the mature path. The WebGPU path is still missing the node-material ports for some weapon and explosion effects, so expect gaps there. Needs a reload: a canvas binds one context type.",
      kind: "seg",
      opts: [
        { v: "auto", label: "AUTO" },
        { v: "webgpu", label: "WEBGPU" },
        { v: "webgl", label: "WEBGL2" },
      ],
    },
    {
      key: "shadowQuality",
      label: "Shadow Quality",
      desc: "Shadow map resolution. HIGH keeps the map's own resolution, OFF disables shadows entirely (fastest). Applies live, no reload.",
      kind: "seg",
      opts: [
        { v: "off", label: "OFF" },
        { v: "low", label: "LOW" },
        { v: "medium", label: "MED" },
        { v: "high", label: "HIGH" },
        { v: "ultra", label: "ULTRA" },
      ],
    },
    { key: "showFps", label: "FPS Counter", desc: "Show frames per second in the top-right corner.", kind: "seg", opts: ON_OFF },
    {
      key: "netStats",
      label: "Network Stats",
      desc: "Show FPS, frame time, ping, jitter and packet loss in the top-right corner. Loss counts snapshots that never arrived from the server.",
      kind: "seg",
      opts: ON_OFF,
    },
    { group: "CINEMATIC" },
    { key: "bloom", label: "Bloom", desc: "Selective glow on HDR highlights only — sun, muzzle flash, explosions. Never a fullscreen wash.", kind: "seg", opts: ON_OFF },
    {
      key: "bloomStrength",
      label: "Bloom Strength",
      desc: "How strongly highlights glow. 0 is the same as Bloom OFF.",
      kind: "slider",
      min: RANGES.bloomStrength[0],
      max: RANGES.bloomStrength[1],
      step: RANGES.bloomStrength[2],
      fmt: (v) => v.toFixed(2),
    },
    { key: "ao", label: "Ambient Occlusion", desc: "Screen-space contact shadows under props, feet and furniture, on every map. Hardware GPUs only; not available in split-depth mode (automatic fallback without EXT_clip_control).", kind: "seg", opts: ON_OFF },
    {
      key: "aoStrength",
      label: "AO Strength",
      desc: "How deep the contact shadows go. Subtle by default — walls never turn black.",
      kind: "slider",
      min: RANGES.aoStrength[0],
      max: RANGES.aoStrength[1],
      step: RANGES.aoStrength[2],
      fmt: (v) => v.toFixed(2),
    },
    { key: "chromatic", label: "Chromatic Aberration", desc: "Slight radial color fringing toward the frame edges. Lens character, not a filter.", kind: "seg", opts: ON_OFF },
    { key: "grain", label: "Film Grain", desc: "Animated fine grain over the finished frame. Costs nothing measurable.", kind: "seg", opts: ON_OFF },
    { key: "vignette", label: "Vignette", desc: "Darkens the frame corners, stronger while aiming down sights.", kind: "seg", opts: ON_OFF },
    { key: "motionBlur", label: "Motion Blur", desc: "Subtle afterimage smoothing while turning fast. Off by default — it smears aim feedback.", kind: "seg", opts: ON_OFF },
    { key: "dof", label: "Depth of Field", desc: "Softens the far frame edges (cheap center-focus look, no depth buffer). Off by default.", kind: "seg", opts: ON_OFF },
    {
      key: "sharpen",
      label: "Sharpness",
      desc: "Recovers texture detail lost to upscaling and post blur. 0 is off.",
      kind: "slider",
      min: RANGES.sharpen[0],
      max: RANGES.sharpen[1],
      step: RANGES.sharpen[2],
      fmt: (v) => v.toFixed(2),
    },
    { group: "LIGHT" },
    {
      key: "exposure",
      label: "Exposure",
      desc: "Overall brightness on top of each map's signed exposure. 1.12 is neutral.",
      kind: "slider",
      min: RANGES.exposure[0],
      max: RANGES.exposure[1],
      step: RANGES.exposure[2],
      fmt: (v) => v.toFixed(2),
    },
    { group: "ACCESSIBILITY" },
    {
      key: "motion",
      label: "Reduced Motion",
      desc: "Cuts interface animation — fades, slides, pulses. SYSTEM follows your operating system's setting.",
      kind: "seg",
      opts: [
        { v: "system", label: "SYSTEM" },
        { v: "reduce", label: "ON" },
        { v: "full", label: "OFF" },
      ],
    },
  ],
};

/** Inputs that are not rebindable, listed under the rebindable rows for completeness. */
const FIXED: [string, string[], string][] = [
  ["Pause Menu (Keyboard)", ["ESC"], "Releases the mouse and opens the pause menu. Reserved by the browser's pointer lock."],
  ["Pause Menu (Controller)", ["START"], "Opens the pause menu mid-match, same as ESC. Works without pointer lock."],
  ["Skip Killcam", ["ENTER", "LMB", "A"], "Also skips a killcam, alongside the JUMP key / pad A."],
  ["Spectate · Switch Player", ["LMB", "RMB"], "Next / previous player while spectating."],
];

/** CONTROLLER prefs edited on the CONTROLS tab (buildRow renders them; the key union already covers `pad*`). */
type PadRow = Exclude<Row, { group: string }>;
const PAD_ROWS: PadRow[] = [
  {
    key: "padEnabled",
    label: "Controller Enabled",
    desc: "Master switch for all gamepad input. When ON, a connected pad moves, looks and fires without pointer lock — keyboard + mouse keep working in parallel.",
    kind: "seg",
    opts: ON_OFF,
  },
  {
    key: "padSens",
    label: "Controller Look Sensitivity",
    desc: "Turn rate of the right stick at full deflection. Independent of the mouse sensitivity above.",
    kind: "slider",
    min: RANGES.padSens[0],
    max: RANGES.padSens[1],
    step: RANGES.padSens[2],
    fmt: (v) => v.toFixed(2),
  },
  {
    key: "padAdsSens",
    label: "Controller ADS Sensitivity",
    desc: "Extra look multiplier while aiming down sights (stick only). Below 1.00 steadies long-range aim; independent of the mouse ADS multiplier.",
    kind: "slider",
    min: RANGES.padAdsSens[0],
    max: RANGES.padAdsSens[1],
    step: RANGES.padAdsSens[2],
    fmt: (v) => v.toFixed(2),
  },
  {
    key: "padDeadzone",
    label: "Stick Deadzone",
    desc: "How far a stick must leave centre before it counts. Raise it if your pad drifts; lower it for finer micro-aim.",
    kind: "slider",
    min: RANGES.padDeadzone[0],
    max: RANGES.padDeadzone[1],
    step: RANGES.padDeadzone[2],
    fmt: (v) => v.toFixed(2),
  },
  {
    key: "padCurve",
    label: "Stick Response Curve",
    desc: "STANDARD: gentle expo (CoD feel). LINEAR: 1:1. PRECISE: extra-fine centre for long-range sticks, full speed at the rim.",
    kind: "seg",
    opts: [
      { v: "standard", label: "STANDARD" },
      { v: "linear", label: "LINEAR" },
      { v: "precise", label: "PRECISE" },
    ],
  },
  {
    key: "padInvertY",
    label: "Invert Controller Look",
    desc: "Stick-up looks down. Independent of the mouse invert above.",
    kind: "seg",
    opts: ON_OFF,
  },
  {
    key: "padLayout",
    label: "Button Layout",
    desc: "DEFAULT: B crouches, R3 knifes. TACTICAL: crouch moves to R3, knife to B (drop-shot friendly). LB is always the frag, RB always the knife backup.",
    kind: "seg",
    opts: [
      { v: "default", label: "DEFAULT" },
      { v: "tactical", label: "TACTICAL" },
    ],
  },
  {
    key: "padStick",
    label: "Stick Layout",
    desc: "DEFAULT: left stick moves, right stick looks. SOUTHPAW: swapped.",
    kind: "seg",
    opts: [
      { v: "default", label: "DEFAULT" },
      { v: "southpaw", label: "SOUTHPAW" },
    ],
  },
  {
    key: "padAimAssist",
    label: "Aim Assist",
    desc: "Slows the stick near a visible enemy and pulls gently toward them. Never aims through walls; mouse is unaffected.",
    kind: "seg",
    opts: ON_OFF,
  },
  {
    key: "padAimStrength",
    label: "Aim Assist Strength",
    desc: "How strong the slowdown + magnet pull. 0 is barely there, 1 is full CoD-style stickiness.",
    kind: "slider",
    min: RANGES.padAimStrength[0],
    max: RANGES.padAimStrength[1],
    step: RANGES.padAimStrength[2],
    fmt: (v) => `${Math.round(v * 100)}`,
  },
  {
    key: "padVibrate",
    label: "Vibration",
    desc: "Rumble on trigger pulls, hits, damage taken and nearby explosions (dual-rumble actuators only).",
    kind: "seg",
    opts: ON_OFF,
  },
];
const PAD_KEYS = PAD_ROWS.map((r) => r.key as keyof Prefs);

/** The slot waiting for a key ("PRESS A KEY"), or null. */
let capture: { a: Action; slot: 0 | 1; at: number } | null = null;
/** The last rebind's consequence, shown in the description panel. */
let bindNote = "";

let root: HTMLElement | null = null;
let closeCb: (() => void) | null = null;
let tab: Tab = "gameplay";
let deps: SettingsDeps | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function settingsOpen(): boolean {
  return !!root;
}

export function openSettings(d: SettingsDeps, opts: { onClose?: () => void; tab?: Tab } = {}): void {
  deps = d;
  closeCb = opts.onClose ?? null;
  if (opts.tab) tab = opts.tab;
  if (root) {
    render();
    return;
  }
  root = h("div", "modal");
  root.id = "settings";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Settings");
  (document.getElementById("app") ?? document.body).append(root);
  wireSfx(root);
  window.addEventListener("keydown", onKey, true);
  render();
}

export function closeSettings(): void {
  if (!root) return;
  stopCapture();
  renderedTab = null;
  bindNote = "";
  root.remove();
  root = null;
  window.removeEventListener("keydown", onKey, true);
  const cb = closeCb;
  closeCb = null;
  cb?.();
}

function onKey(e: KeyboardEvent): void {
  if (!root) return;
  // REBINDING: the next key is the binding. ESC cancels, BACKSPACE / DELETE clears the slot.
  if (capture) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === "Escape") endCapture(null);
    else if (e.code === "Backspace" || e.code === "Delete") endCapture("");
    else if (bindable(e.code)) endCapture(e.code);
    return;
  }
  const typing = (e.target as HTMLElement | null)?.closest?.("input[type=text], input:not([type])");
  if (e.code === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    uiSfx("back");
    closeSettings();
    return;
  }
  if (typing) return;
  if (e.code === "KeyQ" || e.code === "KeyE") {
    e.preventDefault();
    e.stopImmediatePropagation();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.code === "KeyE" ? 1 : TABS.length - 1)) % TABS.length]!;
    tab = next.id;
    uiSfx("select");
    render();
    return;
  }
  // Nothing typed in here may drive the game behind the modal.
  e.stopPropagation();
}

let renderedTab: Tab | null = null;

function render(): void {
  if (!root) return;
  // A re-render of the SAME tab (a rebind, a reset) keeps the list where it was.
  const keepScroll = renderedTab === tab ? (root.querySelector(".set-rows")?.scrollTop ?? 0) : 0;
  renderedTab = tab;
  root.replaceChildren();
  const frame = h("div", "modal-frame");
  const head = h("header", "modal-head");
  head.append(h("h2", "modal-title", "SETTINGS"));
  const tabs = h("nav", "tabs");
  tabs.setAttribute("role", "tablist");
  for (const t of TABS) {
    const b = h("button", "tab" + (t.id === tab ? " is-on" : ""), t.label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.dataset.tab = t.id;
    b.addEventListener("click", () => {
      tab = t.id;
      render();
    });
    tabs.append(b);
  }
  head.append(tabs);

  const body = h("div", "set-body");
  const rows = h("div", "set-rows");
  const desc = h("aside", "set-desc");
  const descTitle = h("h3");
  const descText = h("p");
  const descNote = h("p", "set-note");
  desc.append(descTitle, descText, descNote);
  const describe = (title: string, text: string, note = ""): void => {
    descTitle.textContent = title;
    descText.textContent = text;
    descNote.textContent = note;
  };

  if (tab === "controls") {
    renderControls(rows, describe);
  } else {
    let first: { label: string; desc: string; note: string } | null = null;
    for (const row of ROWS[tab]) {
      if ("group" in row) {
        rows.append(h("p", "set-group", row.group));
        continue;
      }
      const el = buildRow(row, describe);
      rows.append(el);
      if (!first) first = { label: row.label, desc: descOf(row), note: defaultNote(row) };
    }
    if (first) describe(first.label, first.desc, first.note);
  }
  body.append(rows, desc);

  const foot = h("footer", "modal-foot");
  const hints = h("div", "hintbar");
  const hint = (k: string | HTMLElement, t: string): HTMLElement => {
    const s = h("span");
    s.append(typeof k === "string" ? h("i", "key", k) : k, document.createTextNode(t));
    return s;
  };
  // Pad prompts when the pad was touched most recently (B backs out, LB/RB
  // page the tabs — the nav loop handles both).
  if (padPromptsActive()) hints.append(hint(padGlyph("B"), "BACK"), hint(padGlyph("LB"), "PREV TAB"), hint(padGlyph("RB"), "NEXT TAB"));
  else hints.append(hint("ESC", "BACK"), hint("Q", "PREV TAB"), hint("E", "NEXT TAB"));
  const actions = h("div", "hintbar");
  {
    const reset = h("button", "btn btn--ghost btn--sm", "RESET TO DEFAULTS");
    reset.type = "button";
    reset.addEventListener("click", () => {
      if (tab === "controls") {
        stopCapture();
        resetBinds();
        resetPrefs(PAD_KEYS);
        bindNote = "Every binding and every controller setting is back to default.";
      } else {
        const keys = ROWS[tab as Exclude<Tab, "controls">].flatMap((r) => ("key" in r && r.key !== "pack" ? [r.key as keyof Prefs] : []));
        if (tab === "audio") keys.push("musicMuted");
        resetPrefs(keys);
      }
      render();
    });
    actions.append(reset);
  }
  const done = h("button", "btn btn--primary btn--sm", "DONE");
  done.type = "button";
  done.dataset.sfx = "back";
  done.addEventListener("click", () => closeSettings());
  actions.append(done);
  foot.append(hints, actions);

  frame.append(head, body, foot);
  root.append(frame);
  if (keepScroll) rows.scrollTop = keepScroll;
}

/** Description for a row (the backend-finding suffix is gone: the Renderer row
 *  is a plain pref again). */
function descOf(row: Exclude<Row, { group: string }>): string {
  return row.desc;
}

function defaultNote(row: Exclude<Row, { group: string }>): string {
  if (row.key === "pack") return "";
  const d = DEFAULT_PREFS[row.key as keyof Prefs];
  if (row.kind === "slider") return `Default: ${row.fmt(d as number)}`;
  if (row.kind === "seg") return `Default: ${row.opts.find((o) => o.v === d)?.label ?? String(d)}`;
  return "";
}

function buildRow(row: Exclude<Row, { group: string }>, describe: (t: string, d: string, n?: string) => void): HTMLElement {
  const el = h("div", "set-row");
  const id = `set-${String(row.key)}`;
  const label = h("label", undefined, row.label);
  label.htmlFor = id;
  el.append(label);
  const focus = (): void => {
    root?.querySelectorAll(".set-row.is-focus").forEach((n) => n.classList.remove("is-focus"));
    el.classList.add("is-focus");
    describe(row.label, descOf(row), defaultNote(row));
  };
  el.addEventListener("pointerenter", focus);
  el.addEventListener("focusin", focus);

  const p = prefs();
  if (row.kind === "slider") {
    const wrap = h("div", "slider");
    const input = h("input");
    input.type = "range";
    input.id = id;
    input.min = String(row.min);
    input.max = String(row.max);
    input.step = String(row.step);
    const v0 = p[row.key as keyof Prefs] as number;
    input.value = String(v0);
    const out = h("output", undefined, row.fmt(v0));
    const fill = (v: number): void => input.style.setProperty("--fill", `${((v - row.min) / (row.max - row.min)) * 100}%`);
    fill(v0);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = row.fmt(v);
      fill(v);
      setPrefs({ [row.key]: v } as Partial<Prefs>);
    });
    input.addEventListener("change", () => uiSfx("tick"));
    wrap.append(input, out);
    el.append(wrap);
  } else if (row.kind === "seg") {
    const seg = h("div", "seg seg--sm");
    seg.setAttribute("role", "radiogroup");
    seg.id = id;
    let note: HTMLElement | null = null;
    const cur = p[row.key as keyof Prefs];
    for (const o of row.opts) {
      const b = h("button", o.v === cur ? "is-on" : "", o.label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(o.v === cur));
      b.addEventListener("click", () => {
        if (row.key === "quality") {
          // AAA: a preset fans out onto every graphics switch, then the whole
          // tab re-renders so every slider shows the preset's values.
          setPrefs({ ...QUALITY_PRESETS[o.v as keyof typeof QUALITY_PRESETS], quality: o.v } as Partial<Prefs>);
          uiSfx("select");
          render();
          return;
        }
        const changed = o.v !== (prefs()[row.key as keyof Prefs] as unknown);
        setPrefs({ [row.key]: o.v } as Partial<Prefs>);
        seg.querySelectorAll("button").forEach((n) => {
          const on = n === b;
          n.classList.toggle("is-on", on);
          n.setAttribute("aria-checked", String(on));
        });
        // The backend is picked in init() and a canvas binds one context type,
        // so a switch only lands on a fresh page: reload from the menu right
        // away, but never pull the rug out of a live match.
        if (row.key === "renderer" && changed) {
          uiSfx("select");
          // Fail closed: only reload when we positively know no match is live.
          // An unknown state (deps gone, probe throwing) keeps the match and
          // asks for a manual reload.
          let live = true;
          try {
            live = deps?.inMatch?.() !== false;
          } catch {
            live = true;
          }
          if (!live) {
            location.reload();
          } else {
            if (!note) {
              note = h("small", "set-note");
              note.style.fontSize = "var(--fs-micro)";
              note.style.color = "var(--c-text-3)";
              el.append(note);
            }
            note.textContent = "APPLIES AFTER THE NEXT LOAD";
          }
          return;
        }
        // gamepad stream: the button table below depends on the layout.
        if (row.key === "padLayout") {
          uiSfx("select");
          render();
        }
      });
      seg.append(b);
    }
    el.append(seg);
  } else if (row.kind === "select") {
    // The one select: the sound pack.
    const wrap = h("div");
    wrap.style.display = "grid";
    wrap.style.gap = "4px";
    const sel = h("select");
    sel.id = "soundpack";
    for (const o of deps?.packs ?? []) {
      const opt = h("option", undefined, o.label);
      opt.value = o.key;
      sel.append(opt);
    }
    sel.value = deps?.readPack() ?? "";
    const note = h("small", "set-note", deps?.packNote() ?? "");
    note.id = "packnote";
    note.style.fontSize = "var(--fs-micro)";
    note.style.color = "var(--c-text-3)";
    sel.addEventListener("change", async () => {
      note.textContent = "LOADING…";
      note.textContent = (await deps?.setPack(sel.value)) ?? "";
    });
    wrap.append(sel, note);
    el.append(wrap);
  } else if (row.kind === "text") {
    const input = h("input", "field");
    input.id = id;
    input.value = String(p[row.key] ?? "");
    input.placeholder = row.placeholder;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.addEventListener("change", () => setPrefs({ [row.key]: input.value } as Partial<Prefs>));
    for (const t of ["keydown", "keyup"] as const) input.addEventListener(t, (e) => e.stopPropagation());
    el.append(input);
  }
  return el;
}

// ---------------------------------------------------------------- controls (feel stream)

/**
 * The CONTROLS tab: CONTROLLER block (status, sticks, rumble, aim assist,
 * layout) first, then one row per keyboard/mouse action with PRIMARY and
 * ALTERNATE keycaps, then the fixed pad button table. Click a keycap and
 * press the key, mouse button or wheel notch to bind; a key that is already
 * in use SWAPS with this slot (ui/keybinds.ts setBind), and the panel says
 * which action gave it up. Persisted, live: the very next keypress in the
 * match uses it.
 */
function renderControls(rows: HTMLElement, describe: (t: string, d: string, n?: string) => void): void {
  // --- status line (rebind consequence or pad hint) stays on top.
  const status = h("p", "bind-status" + (capture ? " is-capture" : ""), capture ? "PRESS A KEY, MOUSE BUTTON OR WHEEL · ESC CANCELS · BACKSPACE CLEARS" : bindNote || "CLICK A KEYCAP, THEN PRESS THE NEW KEY · A KEY IN USE SWAPS PLACES");
  rows.append(status);
  if (capture) describe("Press a key", "Press the key, mouse button or wheel direction for this action.", "ESC cancels · BACKSPACE clears the slot");

  // --- CONTROLLER
  rows.append(h("p", "set-group", "CONTROLLER"));
  renderPadStatus(rows, describe);
  let padFirst = true;
  for (const row of PAD_ROWS) {
    const el = buildRow(row, describe);
    rows.append(el);
    if (padFirst) {
      padFirst = false;
      describe(row.label, row.desc, defaultNote(row));
    }
  }

  // --- KEYBOARD + MOUSE
  rows.append(h("p", "set-group", "KEYBOARD + MOUSE"));
  const b = binds();
  let group = "";
  for (const a of ACTIONS) {
    if (a.group !== group) {
      group = a.group;
      rows.append(h("p", "set-group", group));
    }
    const el = h("div", "set-row bind-row");
    el.dataset.action = a.id;
    el.append(h("span", "set-label", a.label));
    const slots = h("div", "bind-slots");
    for (const slot of [0, 1] as const) {
      const code = b[a.id][slot];
      const live = capture && capture.a === a.id && capture.slot === slot;
      const btn = h("button", "bind-key" + (live ? " is-capture" : "") + (code ? "" : " is-empty"), live ? "PRESS A KEY" : code ? keyLabel(code) : "—");
      btn.type = "button";
      btn.dataset.slot = String(slot);
      btn.title = slot === 0 ? "Primary" : "Alternate";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // The click that opened capture must not become the binding (see startCapture).
        startCapture(a.id, slot);
      });
      slots.append(btn);
    }
    el.append(slots);
    const def = DEFAULT_BINDS[a.id].filter(Boolean).map(keyLabel).join(" / ") || "—";
    const focus = (): void => {
      root?.querySelectorAll(".set-row.is-focus").forEach((n) => n.classList.remove("is-focus"));
      el.classList.add("is-focus");
      describe(a.label, a.desc, `Default: ${def}`);
    };
    el.addEventListener("pointerenter", focus);
    el.addEventListener("focusin", focus);
    rows.append(el);
  }
  // --- pad button table (brand glyphs — Xbox letters / PlayStation shapes —
  // depends on the layout pref, re-rendered on switch).
  rows.append(h("p", "set-group", "CONTROLLER LAYOUT"));
  for (const m of padMapping(prefs().padLayout)) {
    const el = h("div", "set-row bind-row is-fixed");
    el.append(h("span", "set-label", m.action));
    const k = h("div", "bind-slots");
    k.append(padGlyph(m.button));
    el.append(k);
    el.addEventListener("pointerenter", () => describe(`${m.button} · ${m.action}`, m.desc, "Fixed controller mapping."));
    rows.append(el);
  }
  rows.append(h("p", "set-group", "FIXED"));
  for (const [name, keys, desc] of FIXED) {
    const el = h("div", "set-row bind-row is-fixed");
    el.append(h("span", "set-label", name));
    const k = h("div", "bind-slots");
    for (const key of keys) k.append(h("i", "key", key));
    el.append(k);
    el.addEventListener("pointerenter", () => describe(name, desc, "Not rebindable."));
    rows.append(el);
  }
}

/**
 * CONTROLLER status line: which pad (if any) the game sees, plus a rumble
 * self-test. Re-rendered with the tab, and live-refreshed on
 * gamepadconnected/disconnected while the tab is open (see below).
 */
function renderPadStatus(rows: HTMLElement, describe: (t: string, d: string, n?: string) => void): void {
  const el = h("div", "set-row bind-row is-fixed");
  const name = gamepadSupported() ? padDisplayName() : null;
  el.append(h("span", "set-label", "Controller Status"));
  const box = h("div", "bind-slots");
  const badge = h("i", "key", name ? "CONNECTED" : gamepadSupported() ? "NO PAD" : "UNSUPPORTED");
  badge.title = name ?? "No gamepad detected";
  box.append(badge);
  el.append(box);
  const line = name ?? (gamepadSupported() ? "No gamepad detected — press any button on the pad." : "This browser exposes no Gamepad API.");
  el.addEventListener("pointerenter", () => describe("Controller Status", line, "Standard mapping (Xbox/PlayStation via browser). RT fire, LT ADS, A jump."));
  rows.append(el);

  const test = h("div", "set-row");
  test.append(h("span", "set-label", "Vibration Test"));
  const btn = h("button", "btn btn--ghost btn--sm", "RUMBLE");
  btn.type = "button";
  btn.addEventListener("click", () => {
    rumbleShot();
    setTimeout(() => rumbleShot(), 180);
    describe("Vibration Test", "Two short pulses on the active pad.", prefs().padVibrate ? "No pulse felt? Check the pad's batteries / cable." : "Vibration is OFF (see above) — enable it to feel the test.");
  });
  test.append(btn);
  rows.append(test);
}

// Live-refresh the status badge while SETTINGS → CONTROLS is open.
if (typeof window !== "undefined") {
  const refreshPadTab = (): void => {
    if (settingsOpen() && tab === "controls") render();
  };
  window.addEventListener("gamepadconnected", refreshPadTab);
  window.addEventListener("gamepaddisconnected", refreshPadTab);
}

function startCapture(a: Action, slot: 0 | 1): void {
  stopCapture();
  capture = { a, slot, at: performance.now() };
  uiSfx("select");
  window.addEventListener("mousedown", onCaptureMouse, true);
  window.addEventListener("wheel", onCaptureWheel, { capture: true, passive: false });
  window.addEventListener("contextmenu", onCaptureMenu, true);
  render();
}

function stopCapture(): void {
  if (!capture) return;
  capture = null;
  window.removeEventListener("mousedown", onCaptureMouse, true);
  window.removeEventListener("wheel", onCaptureWheel, true);
  window.removeEventListener("contextmenu", onCaptureMenu, true);
}

function endCapture(code: string | null): void {
  const c = capture;
  stopCapture();
  if (!c) return;
  if (code === null) {
    bindNote = "";
    uiSfx("back");
  } else {
    const label = ACTIONS.find((x) => x.id === c.a)?.label ?? c.a;
    const prev = binds()[c.a][c.slot];
    const lost = setBind(c.a, c.slot, code);
    const lostLabel = lost ? ACTIONS.find((x) => x.id === lost)?.label : "";
    bindNote = !code
      ? `${label.toUpperCase()} · ${c.slot === 0 ? "PRIMARY" : "ALTERNATE"} CLEARED`
      : lostLabel
        ? `${label.toUpperCase()} → ${keyLabel(code)} · SWAPPED: ${lostLabel.toUpperCase()} → ${prev ? keyLabel(prev) : "UNBOUND"}`
        : `${label.toUpperCase()} → ${keyLabel(code)}`;
    uiSfx("confirm");
  }
  render();
}

function onCaptureMouse(e: MouseEvent): void {
  if (!capture) return;
  // A press that started on the keycap that opened capture is that click, not the binding.
  if (performance.now() - capture.at < 150) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  endCapture(`Mouse${e.button}`);
}

function onCaptureWheel(e: WheelEvent): void {
  if (!capture || Math.abs(e.deltaY) < 1) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  endCapture(wheelCodes(e.deltaY)[0]);
}

function onCaptureMenu(e: Event): void {
  if (capture) e.preventDefault();
}
