/**
 * client/src/ui/gamepad.ts — THE GAMEPAD. Standard mapping, sticks, rumble.
 * ===========================================================================
 *
 * Every controller input goes through here; game.ts polls it once per frame
 * (pollGamepad) and SETTINGS → CONTROLS edits its prefs (ui/prefs.ts `pad*`).
 * DOM-free except for navigator.getGamepads + vibrationActuator + the optional
 * menu-nav loop at the bottom (which main.ts starts once).
 *
 * Mapping follows the W3C standard layout (Xbox/PlayStation via browser):
 *   axes[0,1] left stick · axes[2,3] right stick
 *   0 A/Cross · 1 B/Circle · 2 X/Square · 3 Y/Triangle ·
 *   4 LB · 5 RB · 6 LT (analog) · 7 RT (analog) ·
 *   8 Back/Select · 9 Start · 10 L3 · 11 R3 ·
 *   12 DUp · 13 DDown · 14 DLeft · 15 DRight
 *
 * CoD-style DEFAULT layout (padLayout "default"):
 *   left stick MOVE · right stick LOOK · LT ADS · RT FIRE ·
 *   A JUMP · B CROUCH/SLIDE (hold) · X RELOAD · Y SWAP ·
 *   LB FRAG (hold to cook) · RB MELEE · L3 SPRINT (hold) · R3 MELEE ·
 *   DUp PRIMARY · DDown SECONDARY · Back SCOREBOARD (hold) · Start PAUSE
 * TACTICAL swaps B ↔ R3 (crouch on the stick, knife on B).
 * SOUTHPAW (padStick) swaps the two sticks.
 *
 * Aim assist (optional, default ON): right-stick LOOK slows near a visible
 * enemy (game.ts measures the angle) and pulls slightly toward them. The
 * helpers here are pure math; target search + line-of-sight stay in game.ts
 * where the world (drawn poses, traceWorld) already lives.
 */

import { prefs } from "./prefs";
import type { PadButtonLayout } from "./prefs";

/** Standard button indices (W3C "standard" mapping). */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DUP: 12,
  DDOWN: 13,
  DLEFT: 14,
  DRIGHT: 15,
} as const;

/** Analog trigger threshold: above this the trigger counts as held. */
export const TRIGGER_HELD = 0.18;

export interface PadSticks {
  /** Strafe right (+) / left (−), −1..1. */
  moveX: number;
  /** Forward (+) / back (−), −1..1. */
  moveZ: number;
  /** Look right (+) / left (−), −1..1 after deadzone + curve. */
  lookX: number;
  /** Look down (+) / up (−), −1..1 after deadzone + curve. */
  lookY: number;
}

export function gamepadSupported(): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.getGamepads === "function";
  } catch {
    return false;
  }
}

/** First connected pad, or null. Never throws (private mode, no focus, …). */
export function activePad(): Gamepad | null {
  if (!gamepadSupported()) return null;
  try {
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected) return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Human label for the settings status line ("Xbox 360 Controller …" or null). */
export function padDisplayName(): string | null {
  const p = activePad();
  if (!p) return null;
  const id = String(p.id || "").trim();
  return id ? id.slice(0, 48) : `GAMEPAD ${p.index}`;
}

function padButton(pad: Gamepad, i: number): { pressed: boolean; value: number } {
  const b = pad.buttons[i];
  if (!b) return { pressed: false, value: 0 };
  return { pressed: !!b.pressed, value: typeof b.value === "number" ? b.value : b.pressed ? 1 : 0 };
}

/** Button held OR analog value past the trigger threshold. */
export function padHeld(pad: Gamepad, i: number, threshold = TRIGGER_HELD): boolean {
  const b = padButton(pad, i);
  return b.pressed || b.value >= threshold;
}

/** Radial deadzone: drift inside `dz` reads as zero, the rest rescales to 0..1. */
export function applyDeadzone(x: number, y: number, dz: number): { x: number; y: number; mag: number } {
  const mag = Math.hypot(x, y);
  if (!(mag > 0) || mag < dz) return { x: 0, y: 0, mag: 0 };
  const norm = Math.min(1, (mag - dz) / (1 - dz));
  const k = norm / mag;
  return { x: x * k, y: y * k, mag: norm };
}

/** Response curve on the 0..1 magnitude (sign is applied by the caller). */
export function applyCurve(mag: number, curve: string): number {
  const m = Math.max(0, Math.min(1, mag));
  if (curve === "linear") return m;
  if (curve === "precise") return m * m * (0.55 + 0.45 * m);
  return Math.pow(m, 1.6); // "standard"
}

/**
 * Both sticks, deadzoned + curved, sticks optionally swapped (SOUTHPAW).
 * Y signs are raw pad signs (stick-up = −1); the caller maps them to yaw/pitch.
 */
export function readPadSticks(pad: Gamepad, deadzone: number, curve: string, southpaw: boolean): PadSticks {
  const ax = (i: number): number => {
    const v = pad.axes[i];
    return typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  };
  const lx = ax(0);
  const ly = ax(1);
  const rx = ax(2);
  const ry = ax(3);
  const moveRaw = southpaw ? { x: rx, y: ry } : { x: lx, y: ly };
  const lookRaw = southpaw ? { x: lx, y: ly } : { x: rx, y: ry };
  const mv = applyDeadzone(moveRaw.x, moveRaw.y, deadzone);
  const lk = applyDeadzone(lookRaw.x, lookRaw.y, deadzone);
  const lookMag = applyCurve(lk.mag, curve);
  const moveMag = applyCurve(mv.mag, "linear");
  const lkK = lk.mag > 1e-6 ? lookMag / lk.mag : 0;
  const mvK = mv.mag > 1e-6 ? moveMag / mv.mag : 0;
  return {
    // Pad-up is −Y; forward is +Z in game keys.
    moveX: mv.x * mvK,
    moveZ: -mv.y * mvK,
    lookX: lk.x * lkK,
    lookY: lk.y * lkK,
  };
}

// ------------------------------------------------------------------ rumble

/** Low-level rumble; honors the padVibrate pref and missing actuators. */
export function rumblePad(weak: number, strong: number, ms: number): void {
  try {
    if (!prefs().padVibrate) return;
    const pad = activePad();
    const act = (pad as unknown as { vibrationActuator?: { playEffect(type: string, p: Record<string, unknown>): Promise<unknown> } } | null)?.vibrationActuator;
    if (!act || typeof act.playEffect !== "function") return;
    const w = Math.max(0, Math.min(1, weak));
    const s = Math.max(0, Math.min(1, strong));
    if (w <= 0 && s <= 0) return;
    void act.playEffect("dual-rumble", { duration: Math.max(20, Math.min(2000, ms)), weakMagnitude: w, strongMagnitude: s }).catch(() => {});
  } catch {
    /* rumble is cosmetic — never throw */
  }
}

/** Trigger pull echo (short, soft). */
export function rumbleShot(): void {
  rumblePad(0.12, 0.18, 60);
}
/** Confirmed hit (a beat stronger than the shot). */
export function rumbleHit(kill: boolean): void {
  rumblePad(kill ? 0.35 : 0.2, kill ? 0.5 : 0.25, kill ? 140 : 70);
}
/** Damage taken (the strong one — it must read through gunfire). */
export function rumbleHurt(): void {
  rumblePad(0.45, 0.6, 160);
}
/** Explosion nearby, scaled 0..1 by proximity. */
export function rumbleBoom(k: number): void {
  const c = Math.max(0, Math.min(1, k));
  if (c <= 0.02) return;
  rumblePad(0.3 * c, 0.7 * c, 220);
}

// ------------------------------------------------------------- mapping docs

export interface PadRow {
  button: string;
  action: string;
  desc: string;
}

/** The button table SETTINGS → CONTROLS prints (depends on the layout). */
export function padMapping(layout: PadButtonLayout): PadRow[] {
  const tactical = layout === "tactical";
  return [
    { button: "LEFT STICK", action: "Move", desc: "Run, strafe. Full deflection + L3 is no faster — L3 is the sprint." },
    { button: "RIGHT STICK", action: "Look", desc: "Turn / aim. Curve, deadzone and speed are below." },
    { button: "RT", action: "Fire", desc: "Analog trigger. Semi/bolt discipline is the sim's job, as on mouse." },
    { button: "LT", action: "Aim Down Sights", desc: "Hold or toggle follows GAMEPLAY → AIM DOWN SIGHTS." },
    { button: "A", action: "Jump · Skip Killcam", desc: "Jump and mantle. Skips the killcam, like on keyboard." },
    tactical
      ? { button: "B", action: "Melee", desc: "TACTICAL: knife on B, crouch on the stick." }
      : { button: "B", action: "Crouch · Slide", desc: "Hold to crouch; pressed while sprinting, slides." },
    { button: "X", action: "Reload", desc: "Reload. Longer when the magazine is empty." },
    { button: "Y", action: "Swap Weapon", desc: "Switch between your two weapons." },
    { button: "LB", action: "Frag Grenade", desc: "Hold to pull the pin and cook, release to throw." },
    { button: "RB", action: "Melee", desc: "Knife attack." },
    { button: "L3", action: "Sprint · Hold Breath", desc: "Hold to sprint; through a scope, hold to steady." },
    tactical
      ? { button: "R3", action: "Crouch · Slide", desc: "TACTICAL: crouch on R3, knife on B." }
      : { button: "R3", action: "Melee", desc: "Stick-click knife (CoD default)." },
    { button: "D-UP", action: "Primary Weapon", desc: "Switch to your primary weapon." },
    { button: "D-DOWN", action: "Secondary Weapon", desc: "Switch to your pistol." },
    { button: "BACK", action: "Scoreboard", desc: "Hold to show the scoreboard." },
    { button: "START", action: "Pause", desc: "Opens the pause menu (same as ESC)." },
  ];
}

// ------------------------------------------------------- active-device tracking

/**
 * Which device the footer strips (ui/keys.ts: menu + lobby) describe. LAST
 * INPUT WINS — the industry-standard rule: touch the pad and every keycap
 * becomes a button, touch keyboard/mouse and they flip back. Boot default is
 * keyboard; a merely connected (never touched) pad changes nothing.
 */
let lastPadMs = 0;
let lastKeyMs = 0;
let padTouched = false;
let keyWired = false;

/** Call on any real controller input (buttons, sticks, triggers). */
export function notePadInput(): void {
  padTouched = true;
  try {
    lastPadMs = performance.now();
  } catch {
    lastPadMs = Date.now();
  }
  emitPadPrompts();
}

function noteKeyInput(): void {
  try {
    lastKeyMs = performance.now();
  } catch {
    lastKeyMs = Date.now();
  }
  emitPadPrompts();
}

/** Footer strips show pad buttons once a connected pad was touched most recently. */
export function padPromptsActive(): boolean {
  wireKeyDevice();
  if (!padTouched) return false;
  try {
    if (!activePad()) return false;
  } catch {
    return false;
  }
  return lastPadMs >= lastKeyMs;
}

function wireKeyDevice(): void {
  if (keyWired || typeof window === "undefined") return;
  keyWired = true;
  try {
    window.addEventListener("keydown", noteKeyInput, true);
    window.addEventListener("mousedown", noteKeyInput, true);
    window.addEventListener("wheel", noteKeyInput, true);
  } catch {
    /* ignore */
  }
}

type PadPromptsListener = () => void;
const padPromptsListeners = new Set<PadPromptsListener>();
let padPromptsOn = false;

function emitPadPrompts(): void {
  let on = false;
  try {
    on = padPromptsActive();
  } catch {
    on = false;
  }
  if (on === padPromptsOn) return;
  padPromptsOn = on;
  for (const l of [...padPromptsListeners]) {
    try {
      l();
    } catch {
      /* cosmetic — never break input */
    }
  }
}

/** Repaint hook for prompt strips (ui/keys.ts); returns unsubscribe. */
export function onPadPrompts(fn: PadPromptsListener): () => void {
  wireKeyDevice();
  padPromptsListeners.add(fn);
  return () => {
    padPromptsListeners.delete(fn);
  };
}

if (typeof window !== "undefined") {
  try {
    // Unplug mid-session: fall back to keyboard prompts immediately.
    window.addEventListener("gamepaddisconnected", emitPadPrompts);
    window.addEventListener("gamepadconnected", emitPadPrompts);
  } catch {
    /* ignore */
  }
}

/** Footer-strip prompts for pad players (ui/keys.ts swaps to these). */
export function padKeyline(): [string, string][] {
  const tactical = prefs().padLayout === "tactical";
  return [
    ["L-STICK", "MOVE"],
    ["L3", "SPRINT"],
    [tactical ? "R3" : "B", "SLIDE"],
    ["X", "RELOAD"],
    ["Y", "SWAP"],
    ["LB", "FRAG"],
    ["BACK", "SCORES"],
    ["START", "MENU"],
  ];
}

// ------------------------------------------------------- pad button glyphs

/**
 * Controller brand for glyphs, sniffed off the pad id (heuristics, Xbox
 * fallback when nothing is plugged in). Decides face colors + labels
 * (A/B/X/Y vs ✕/○/□/△, LB vs L1, START vs OPTIONS …).
 */
export type PadBrand = "xbox" | "ps";
export function padBrand(): PadBrand {
  try {
    const id = (activePad()?.id ?? "").toLowerCase();
    if (/sony|dualshock|dual sense|dualsense|playstation|\bps[145]\b|054c|8bitdo|8bit do/.test(id)) return "ps";
  } catch {
    /* ignore */
  }
  return "xbox";
}

const PS_ALIAS: Record<string, string> = {
  LB: "L1",
  RB: "R1",
  LT: "L2",
  RT: "R2",
  BACK: "SHARE",
  START: "OPTIONS",
};

const FACE_NAMES: Record<PadBrand, Record<string, string>> = {
  xbox: { A: "A", B: "B", X: "X", Y: "Y" },
  ps: { A: "Cross", B: "Circle", X: "Square", Y: "Triangle" },
};

let padStylesIn = false;
/** Glyph stylesheet, injected once — src/*.css are stubs, the shipped sheet is an opaque artifact. */
function ensurePadKeyStyles(): void {
  if (padStylesIn) return;
  padStylesIn = true;
  try {
    const st = document.createElement("style");
    st.id = "padkey-styles";
    st.textContent = [
      ".padkey{display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-weight:800;line-height:1;vertical-align:middle;letter-spacing:0;white-space:nowrap}",
      ".padkey-face{width:1.7em;height:1.7em;border-radius:50%;font-size:.82em;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.55);box-shadow:inset 0 0 0 2px rgba(255,255,255,.22),0 1px 3px rgba(0,0,0,.5)}",
      ".padkey-xbox.padkey-a{background:#107c10}.padkey-xbox.padkey-b{background:#c8102e}.padkey-xbox.padkey-x{background:#0078d4}.padkey-xbox.padkey-y{background:#ffb900;color:#231a00;text-shadow:none}",
      ".padkey-ps.padkey-a{background:#0072bc}.padkey-ps.padkey-b{background:#e30613}.padkey-ps.padkey-x{background:#c93ff5}.padkey-ps.padkey-y{background:#009e4c}",
      ".padkey-pill{height:2em;padding:0 .6em;border:1px solid var(--c-line-3,rgba(255,255,255,.25));border-radius:.5em;background:rgba(255,255,255,.06);color:var(--c-text,#eef1f4);font-size:.68em;font-weight:700;letter-spacing:.08em}",
    ].join("\n");
    document.head.append(st);
  } catch {
    /* cosmetic only */
  }
}

/**
 * Brand glyph badge for a pad button. Canonical names (A/B/X/Y/LB/…, as in
 * PAD_MAP/padMapping); PlayStation pads get ✕/○/□/△ + L1/R1/OPTIONS, Xbox pads
 * the colored letters. Anything else (sticks, D-pad, BACK…) is a neutral pill.
 */
export function padGlyph(btn: string): HTMLElement {
  ensurePadKeyStyles();
  const el = document.createElement("i");
  const brand = padBrand();
  const k = String(btn ?? "").toUpperCase();
  if (k === "A" || k === "B" || k === "X" || k === "Y") {
    const glyph = FACE_NAMES[brand][k] ?? k;
    el.className = `padkey padkey-face padkey-${k.toLowerCase()} padkey-${brand}`;
    el.textContent = brand === "ps" ? { A: "✕", B: "○", X: "□", Y: "△" }[k]! : glyph;
    el.title = brand === "ps" ? `PlayStation ${glyph}` : `Xbox ${glyph}`;
  } else {
    el.className = "padkey padkey-pill";
    el.textContent = brand === "ps" ? (PS_ALIAS[k] ?? k) : k;
    el.title = el.textContent;
  }
  return el;
}

// ------------------------------------------------------- aim-assist math

/** Angular difference in degrees, wrapped. */
export function angDiffDeg(a: number, b: number): number {
  let w = (a - b) % (Math.PI * 2);
  if (w > Math.PI) w -= Math.PI * 2;
  if (w < -Math.PI) w += Math.PI * 2;
  return Math.abs((w * 180) / Math.PI);
}

/**
 * Look slowdown 0..1 for an angular miss in degrees: full effect inside ~2°,
 * fading to none past ~9°. Scaled by the player's strength pref.
 */
export function assistSlow(missDeg: number, strength: number): number {
  const s = Math.max(0, Math.min(1, strength));
  if (missDeg >= 9) return 1;
  if (missDeg <= 2) return 1 - 0.62 * s;
  const t = (missDeg - 2) / 7;
  return 1 - 0.62 * s * (1 - t);
}

// ------------------------------------------------------------ menu nav loop

export interface PadNavHooks {
  /** TRUE while a match (HUD up) runs — START may open pause. */
  isInMatch: () => boolean;
  /** TRUE while any menu-like screen needs the pad (menu, lobby, gate, pause, settings, loadout, endcard). */
  isModalOpen: () => boolean;
  /** Toggle pause (open if playing, resume if paused). */
  onPauseToggle: () => void;
  /** Close the topmost modal (settings/loadout) — B button. */
  onBack: () => void;
  /**
   * Direct shortcuts, contextual (main.ts decides by screen: menu home launch/
   * callsign/map, pause loadout/settings). Fired only while a nav scope is up;
   * in-match the poll owns every button, so these never double-fire.
   */
  onY?: () => void;
  onX?: () => void;
  onLB?: () => void;
  onRB?: () => void;
}

const NAV_REPEAT_MS = 220;

/**
 * Visible nav scope, highest priority first. Screens stay in the DOM while
 * hidden (the main menu keeps `.hidden`), so existence alone can't pick the
 * scope — the first root that actually paints wins. Transient toasts
 * (nana-in, a 2.7 s card with no buttons) are not scopes.
 */
const NAV_ROOTS = ["settings", "pause", "loadout", "nana-gate", "nana-full", "nana-lobby", "endcard", "menu"] as const;

function navScope(): HTMLElement | null {
  for (const id of NAV_ROOTS) {
    const el = document.getElementById(id);
    // offsetParent is null for position:fixed subtrees — client rects work
    // for every positioning scheme, and display:none paints no rects.
    if (el && !el.classList.contains("hidden") && el.getClientRects().length > 0) return el;
  }
  return null;
}

function navItems(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("button:not([disabled]), select, input:not([disabled])")].filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * Global pad loop for menus: START toggles pause mid-match; on any visible
 * screen (main menu, lobby, gate, pause, settings, loadout, endcard) the
 * D-pad / left stick moves focus and A activates, B goes back. Runs its own
 * rAF while the page lives; in-match look/buttons are game.ts's pollGamepad,
 * which skips while a scope is up — the two never fight.
 */
export function startPadUiNav(hooks: PadNavHooks): () => void {
  let stopped = false;
  let prev: boolean[] = [];
  let lastMoveV = 0;
  let lastMoveH = 0;
  const pressed = (pad: Gamepad, i: number): boolean => !!pad.buttons[i]?.pressed;

  const moveFocus = (scope: HTMLElement, dir: 1 | -1): void => {
    const items = navItems(scope);
    if (!items.length) return;
    const cur = document.activeElement as HTMLElement | null;
    const i = cur ? items.indexOf(cur) : -1;
    const next = items[(i + dir + items.length) % items.length]!;
    next.focus({ preventScroll: true });
  };

  const frame = (): void => {
    if (stopped) return;
    requestAnimationFrame(frame);
    let pad: Gamepad | null = null;
    try {
      pad = activePad();
    } catch {
      pad = null;
    }
    if (!pad) {
      prev = [];
      return;
    }
    const now = performance.now();
    const edge = (i: number): boolean => pressed(pad!, i) && !prev[i];
    const held = (i: number): boolean => pressed(pad!, i);
    // Device vote for the footer strips (ui/keys.ts, last input wins): any pad
    // activity counts, even where this loop drives no action. Honors the
    // padEnabled kill-switch, like pollGamepad does.
    try {
      if (
        prefs().padEnabled &&
        (pad.buttons.some((b) => !!b?.pressed) || Math.abs(pad.axes[0] ?? 0) > 0.5 || Math.abs(pad.axes[1] ?? 0) > 0.5)
      )
        notePadInput();
    } catch {
      /* ignore */
    }
    const scope = navScope();
    const nav = !!scope && hooks.isModalOpen();

    // START toggles pause (in match or on pause).
    if (edge(PAD.START) && (hooks.isInMatch() || document.getElementById("pause"))) hooks.onPauseToggle();

    if (nav && scope) {
      // A = activate (or take focus first when nothing is focused yet).
      if (edge(PAD.A)) {
        const items = navItems(scope);
        const cur = document.activeElement as HTMLElement | null;
        if (cur && items.includes(cur)) cur.click();
        else if (items.length) items[0]!.focus({ preventScroll: true });
      } else if (edge(PAD.B)) {
        hooks.onBack();
      }
      // X/Y direct shortcuts (menu home / pause — main.ts guards the screen).
      if (edge(PAD.Y)) hooks.onY?.();
      if (edge(PAD.X)) hooks.onX?.();
      // LB/RB page the settings tabs; everywhere else they are shortcuts.
      if (edge(PAD.LB) || edge(PAD.RB)) {
        if (scope.id === "settings") {
          const tabs = [...scope.querySelectorAll<HTMLButtonElement>(".tab")];
          const i = tabs.findIndex((t) => t.classList.contains("is-on"));
          const dir = edge(PAD.RB) ? 1 : -1;
          const next = tabs[(i + dir + tabs.length) % Math.max(1, tabs.length)];
          next?.click();
          scope.querySelector<HTMLButtonElement>(".tab.is-on")?.focus({ preventScroll: true });
        } else if (edge(PAD.LB)) hooks.onLB?.();
        else hooks.onRB?.();
      }
      // D-pad / left stick walk with repeat: vertical moves focus, horizontal
      // nudges sliders (settings) where sensible.
      const stickY = pad.axes[1] ?? 0;
      const stickX = pad.axes[0] ?? 0;
      const down = held(PAD.DDOWN) || stickY > 0.6;
      const up = held(PAD.DUP) || stickY < -0.6;
      if ((down || up) && now - lastMoveV > NAV_REPEAT_MS) {
        moveFocus(scope, down ? 1 : -1);
        lastMoveV = now;
      } else if (!down && !up) {
        lastMoveV = 0;
      }
      const right = held(PAD.DRIGHT) || stickX > 0.6;
      const left = held(PAD.DLEFT) || stickX < -0.6;
      if ((right || left) && now - lastMoveH > NAV_REPEAT_MS) {
        const el = document.activeElement as HTMLInputElement | null;
        if (el && el.type === "range" && navItems(scope).includes(el)) {
          const step = Number(el.step || 1);
          el.value = String(Number(el.value) + (right ? step : -step));
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        lastMoveH = now;
      } else if (!right && !left) {
        lastMoveH = 0;
      }
    }
    prev = pad.buttons.map((b) => !!b?.pressed);
  };
  requestAnimationFrame(frame);
  return () => {
    stopped = true;
  };
}
