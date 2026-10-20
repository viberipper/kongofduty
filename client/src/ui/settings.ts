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
import { uiSfx, wireSfx } from "./sfx";
// feel stream: CONTROLS rebinds the live keybinding table every game input reads.
import { ACTIONS, DEFAULT_BINDS, binds, bindable, keyLabel, resetBinds, setBind, wheelCodes, type Action } from "./keybinds";

export type PackOption = { key: string; label: string };
export interface SettingsDeps {
  packs: PackOption[];
  readPack: () => string;
  /** Persist + load a sound pack; resolves with a status line for the note. */
  setPack: (key: string) => Promise<string>;
  packNote: () => string;
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
  | { key: keyof Prefs | "pack"; label: string; desc: string; kind: "seg"; opts: { v: string | boolean; label: string }[] }
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
    { group: "INTERFACE" },
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
      key: "renderScale",
      label: "Render Resolution",
      desc: "ADAPTIVE lowers the internal resolution when the frame gets expensive and restores it when it is cheap — the smoothest option. NATIVE always renders at your display's full resolution.",
      kind: "seg",
      opts: [
        { v: "auto", label: "ADAPTIVE" },
        { v: "native", label: "NATIVE" },
      ],
    },
    { key: "showFps", label: "FPS Counter", desc: "Show frames per second in the top-right corner.", kind: "seg", opts: ON_OFF },
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
  ["Pause Menu", ["ESC"], "Releases the mouse and opens the pause menu. Reserved by the browser's pointer lock."],
  ["Skip Killcam", ["ENTER", "LMB"], "Also skips a killcam, alongside the JUMP key."],
  ["Spectate · Switch Player", ["LMB", "RMB"], "Next / previous player while spectating."],
];

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
      if (!first) first = { label: row.label, desc: row.desc, note: defaultNote(row) };
    }
    if (first) describe(first.label, first.desc, first.note);
  }
  body.append(rows, desc);

  const foot = h("footer", "modal-foot");
  const hints = h("div", "hintbar");
  const hint = (k: string, t: string): HTMLElement => {
    const s = h("span");
    s.append(h("i", "key", k), document.createTextNode(t));
    return s;
  };
  hints.append(hint("ESC", "BACK"), hint("Q", "PREV TAB"), hint("E", "NEXT TAB"));
  const actions = h("div", "hintbar");
  {
    const reset = h("button", "btn btn--ghost btn--sm", "RESET TO DEFAULTS");
    reset.type = "button";
    reset.addEventListener("click", () => {
      if (tab === "controls") {
        stopCapture();
        resetBinds();
        bindNote = "Every binding is back to its default.";
      } else {
        const keys = ROWS[tab as Exclude<Tab, "controls">].flatMap((r) => ("key" in r && r.key !== "pack" ? [r.key as keyof Prefs] : []));
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
    describe(row.label, row.desc, defaultNote(row));
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
    const cur = p[row.key as keyof Prefs];
    for (const o of row.opts) {
      const b = h("button", o.v === cur ? "is-on" : "", o.label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(o.v === cur));
      b.addEventListener("click", () => {
        setPrefs({ [row.key]: o.v } as Partial<Prefs>);
        seg.querySelectorAll("button").forEach((n) => {
          const on = n === b;
          n.classList.toggle("is-on", on);
          n.setAttribute("aria-checked", String(on));
        });
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
 * The CONTROLS tab: one row per action, a PRIMARY and an ALTERNATE keycap. Click
 * a keycap and press the key, mouse button or wheel notch to bind; a key that is
 * already in use SWAPS with this slot (ui/keybinds.ts setBind), and the panel
 * says which action gave it up. Persisted, live: the very next keypress in the
 * match uses it.
 */
function renderControls(rows: HTMLElement, describe: (t: string, d: string, n?: string) => void): void {
  const b = binds();
  let group = "";
  let first = true;
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
    if (first) {
      first = false;
      describe(a.label, a.desc, `Default: ${def}`);
    }
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
  // The last rebind's consequence stays on screen (a swap must never be silent).
  const status = h("p", "bind-status" + (capture ? " is-capture" : ""), capture ? "PRESS A KEY, MOUSE BUTTON OR WHEEL · ESC CANCELS · BACKSPACE CLEARS" : bindNote || "CLICK A KEYCAP, THEN PRESS THE NEW KEY · A KEY IN USE SWAPS PLACES");
  rows.prepend(status);
  if (capture) describe("Press a key", "Press the key, mouse button or wheel direction for this action.", "ESC cancels · BACKSPACE clears the slot");
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
