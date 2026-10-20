/**
 * client/src/ui/keybinds.ts — THE KEYBINDINGS. One table, persisted, live.
 * ===========================================================================
 *
 * Every game input goes through here: game.ts bindInput resolves each key,
 * mouse button and wheel notch to an ACTION with `actionOf()`, the SETTINGS →
 * CONTROLS tab rebinds them, the menu/lobby keyline and the Keyboard Lock list
 * are derived from them. CoD's model: every action has a PRIMARY and an
 * ALTERNATE slot; binding a key that is already in use SWAPS it (the other
 * action takes the key this slot had), so a binding can never be silently lost
 * and no key ever drives two actions.
 *
 * Codes are KeyboardEvent.code strings, plus "Mouse0".."Mouse4" for buttons
 * and "Wheel" / "WheelUp" / "WheelDown" for the scroll wheel. The right-hand
 * modifiers are the same key as the left-hand ones (SHIFT is SHIFT).
 *
 * Fixed, never rebindable: ESC (pause — the browser's pointer-lock release),
 * and ENTER / a click as extra killcam skips. DOM-free: game.ts imports this.
 */

export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "jump"
  | "crouch"
  | "sprint"
  | "fire"
  | "ads"
  | "reload"
  | "melee"
  | "frag"
  | "primary"
  | "secondary"
  | "swap"
  | "scoreboard";

export type Binds = Record<Action, [string, string]>;

/** Rows of the CONTROLS tab, in CoD's order. `desc` feeds the right-hand panel. */
export const ACTIONS: { id: Action; label: string; group: string; desc: string }[] = [
  { id: "forward", label: "Move Forward", group: "MOVEMENT", desc: "Walk forward." },
  { id: "back", label: "Move Backward", group: "MOVEMENT", desc: "Walk backward." },
  { id: "left", label: "Strafe Left", group: "MOVEMENT", desc: "Step left." },
  { id: "right", label: "Strafe Right", group: "MOVEMENT", desc: "Step right." },
  { id: "jump", label: "Jump · Skip Killcam", group: "MOVEMENT", desc: "Jump and mantle. While a killcam plays, skips it (ENTER and a click also skip)." },
  { id: "crouch", label: "Crouch · Slide", group: "MOVEMENT", desc: "Crouch. Pressed while sprinting, slides." },
  { id: "sprint", label: "Sprint · Hold Breath", group: "MOVEMENT", desc: "Hold to sprint; double-tap for tactical sprint (SETTINGS → GAMEPLAY). Through a scope, hold to steady your breath." },
  { id: "fire", label: "Fire", group: "COMBAT", desc: "Fire your weapon." },
  { id: "ads", label: "Aim Down Sights", group: "COMBAT", desc: "Aim down sights. Hold or toggle is set under GAMEPLAY." },
  { id: "reload", label: "Reload", group: "COMBAT", desc: "Reload. Longer when the magazine is empty." },
  { id: "melee", label: "Melee", group: "COMBAT", desc: "Knife attack." },
  { id: "frag", label: "Frag Grenade · Hold to Cook", group: "COMBAT", desc: "Hold to pull the pin and cook, release to throw. Cooked too long it goes off in your hand." },
  { id: "primary", label: "Primary Weapon", group: "WEAPONS", desc: "Switch to your primary weapon." },
  { id: "secondary", label: "Secondary Weapon", group: "WEAPONS", desc: "Switch to your pistol." },
  { id: "swap", label: "Swap Weapon", group: "WEAPONS", desc: "Switch between your two weapons." },
  { id: "scoreboard", label: "Scoreboard", group: "INTERFACE", desc: "Hold to show the scoreboard." },
];

export const DEFAULT_BINDS: Readonly<Binds> = {
  forward: ["KeyW", ""],
  back: ["KeyS", ""],
  left: ["KeyA", ""],
  right: ["KeyD", ""],
  jump: ["Space", ""],
  crouch: ["KeyC", "ControlLeft"],
  sprint: ["ShiftLeft", ""],
  fire: ["Mouse0", ""],
  ads: ["Mouse2", ""],
  reload: ["KeyR", ""],
  melee: ["KeyF", "KeyV"],
  frag: ["KeyG", "Mouse1"],
  primary: ["Digit1", "Numpad1"],
  secondary: ["Digit2", "Numpad2"],
  swap: ["KeyY", "Wheel"],
  scoreboard: ["Tab", ""],
};

export const BINDS_KEY = "shipment.binds";

/** Keys that are never bindable (the pause menu owns ESC). */
const RESERVED = new Set(["Escape", "MetaLeft", "MetaRight", "OSLeft", "OSRight", "ContextMenu"]);

/** SHIFT is SHIFT: the right-hand modifiers resolve to the left-hand binding. */
export function normCode(code: string): string {
  if (code === "ShiftRight") return "ShiftLeft";
  if (code === "ControlRight") return "ControlLeft";
  if (code === "AltRight") return "AltLeft";
  return code;
}

export function bindable(code: string): boolean {
  return !!code && !RESERVED.has(code);
}

const isAction = (k: string): k is Action => ACTIONS.some((a) => a.id === k);

export function sanitizeBinds(x: unknown): Binds {
  const out = Object.fromEntries(Object.entries(DEFAULT_BINDS).map(([k, v]) => [k, [...v]])) as Binds;
  if (!x || typeof x !== "object") return out;
  const seen = new Set<string>();
  // Saved table first, slot by slot; a key claimed twice keeps its FIRST owner.
  for (const a of ACTIONS) {
    const row = (x as Record<string, unknown>)[a.id];
    if (!Array.isArray(row)) continue;
    for (let s = 0; s < 2; s++) {
      const c = typeof row[s] === "string" ? normCode(String(row[s]).slice(0, 32)) : "";
      out[a.id][s] = c && bindable(c) && !seen.has(c) ? c : "";
      if (out[a.id][s]) seen.add(out[a.id][s]);
    }
  }
  return out;
}

function load(): Binds {
  try {
    return sanitizeBinds(JSON.parse(globalThis.localStorage?.getItem(BINDS_KEY) ?? "null"));
  } catch {
    return sanitizeBinds(null);
  }
}

let current: Binds = load();
/** code → action, rebuilt on every change (the hot-path read). */
let lookup = new Map<string, Action>();
function reindex(): void {
  lookup = new Map();
  for (const a of ACTIONS) for (const c of current[a.id]) if (c) lookup.set(c, a.id);
}
reindex();

const listeners = new Set<() => void>();
function commit(): void {
  reindex();
  try {
    globalThis.localStorage?.setItem(BINDS_KEY, JSON.stringify(current));
  } catch {
    /* private mode — applies for this session */
  }
  for (const l of listeners) l();
}

/** The live table (read-only view). */
export function binds(): Readonly<Binds> {
  return current;
}

/** Which action a key / button / wheel code drives, or null. Allocation-free. */
export function actionOf(code: string): Action | null {
  return lookup.get(normCode(code)) ?? null;
}

/**
 * Bind `code` to action `a`, slot `slot`. When the code already drives another
 * action (or the other slot of this one), the two SWAP: that slot takes the
 * key this slot had. Returns the action that gave the key up, if any.
 */
export function setBind(a: Action, slot: 0 | 1, code: string): Action | null {
  const c = normCode(code);
  if (c && !bindable(c)) return null;
  const old = current[a][slot];
  let lost: Action | null = null;
  if (c) {
    for (const b of ACTIONS) {
      for (let s = 0; s < 2; s++) {
        if ((b.id !== a || s !== slot) && current[b.id][s] === c) {
          current[b.id][s] = old;
          if (b.id !== a) lost = b.id;
        }
      }
    }
  }
  current[a][slot] = c;
  commit();
  return lost;
}

export function resetBinds(): void {
  current = sanitizeBinds(null);
  commit();
}

export function onBinds(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every KEYBOARD code currently bound (the Keyboard Lock list in fullscreen). */
export function keyboardCodes(): string[] {
  const out: string[] = [];
  for (const a of ACTIONS) for (const c of current[a.id]) if (c && !c.startsWith("Mouse") && !c.startsWith("Wheel")) out.push(c);
  if (out.includes("ShiftLeft")) out.push("ShiftRight");
  if (out.includes("ControlLeft")) out.push("ControlRight");
  if (out.includes("AltLeft")) out.push("AltRight");
  return out;
}

const NAMED: Record<string, string> = {
  Space: "SPACE",
  ShiftLeft: "SHIFT",
  ControlLeft: "CTRL",
  AltLeft: "ALT",
  Tab: "TAB",
  Enter: "ENTER",
  NumpadEnter: "ENTER",
  Backspace: "BKSP",
  CapsLock: "CAPS",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Mouse0: "LMB",
  Mouse1: "MMB",
  Mouse2: "RMB",
  Mouse3: "MB4",
  Mouse4: "MB5",
  Wheel: "WHEEL",
  WheelUp: "WHEEL ↑",
  WheelDown: "WHEEL ↓",
  Insert: "INS",
  Delete: "DEL",
  Home: "HOME",
  End: "END",
  PageUp: "PGUP",
  PageDown: "PGDN",
};

/** The keycap label for a code ("KeyW" → "W", "Mouse2" → "RMB", "" → "—"). */
export function keyLabel(code: string): string {
  if (!code) return "—";
  if (NAMED[code]) return NAMED[code]!;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "NUM " + code.slice(6).toUpperCase();
  if (/^F\d+$/.test(code)) return code;
  return code.toUpperCase().slice(0, 6);
}

/** The primary keycap of an action, for hints ("G FRAG"). */
export function keyFor(a: Action): string {
  const [p, s] = current[a];
  return keyLabel(p || s);
}

/** The movement cluster as one keycap ("WASD" for the default layout). */
export function moveLabel(): string {
  const k = (["forward", "left", "back", "right"] as const).map((a) => keyLabel(current[a][0] || current[a][1]));
  return k.every((x) => x.length === 1) ? k.join("") : k.join(" ");
}

/** The wheel event's codes, most specific first. */
export function wheelCodes(deltaY: number): [string, string] {
  return [deltaY < 0 ? "WheelUp" : "WheelDown", "Wheel"];
}

export function isAnAction(k: string): k is Action {
  return isAction(k);
}
