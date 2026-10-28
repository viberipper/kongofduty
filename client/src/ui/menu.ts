/**
 * client/src/ui/menu.ts — the main menu's PLAY screen: launch tiles, the map
 * cards, the mode selector and the callsign chip. ONE menu for every map —
 * the map is a card you pick, never a skin.
 *
 * Every word on a tile is derived: the map list from shared/maps MAP_OPTIONS,
 * the mode label / team size / bot count / rules from shared/modes.ts. The
 * selection persists (localStorage) so a returning player's last setup is
 * already highlighted.
 */
import { asModeId, modeInfo, modesFor, PUBLIC_MODE, type ModeId } from "@shared/modes";
import { DEFAULT_MAP_ID, isMapId } from "@shared/maps";
import { mapBlurb, mapCardUrl, mapIds, mapLabel } from "./flow";
import { onPrefs, prefs, setPrefs } from "./prefs";
import { wireSfx } from "./sfx";
import { onPadPrompts, padGlyph, padPromptsActive } from "./gamepad";
import { renderKeyline } from "./keys";

const SEL_KEY = "shipment.menu";

/**
 * Controller direct shortcuts on menu home (main.ts fires them via the pad
 * nav hooks; the bar below renders the same table, so badge and behavior
 * cannot drift apart). LB/RB cycle the map cards, Y launches, X renames.
 */
export type MenuPadAction = "quick" | "callsign" | "map-prev" | "map-next";
export const MENU_PAD: { btn: string; label: string; action: MenuPadAction }[] = [
  { btn: "Y", label: "QUICK PLAY", action: "quick" },
  { btn: "X", label: "CALLSIGN", action: "callsign" },
  { btn: "LB", label: "MAP −", action: "map-prev" },
  { btn: "RB", label: "MAP +", action: "map-next" },
];

export interface MenuSelection {
  map: string;
  mode: ModeId;
}

let sel: MenuSelection = { map: DEFAULT_MAP_ID, mode: "tdm" };
let onChange: ((s: MenuSelection) => void) | null = null;

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function menuSelection(): MenuSelection {
  return { ...sel };
}

/**
 * The page's own map wins over the remembered card: an explicit `?map=` pin
 * (a shared link, a map-change reload) is what this page built, while the
 * saved card is only the highlight for a free visit. Order: `?map=` > saved
 * card > page default (ares).
 */
export function initMenu(pageMap: string, cb: (s: MenuSelection) => void): void {
  onChange = cb;
  let saved: Partial<MenuSelection> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEL_KEY) ?? "{}");
    if (raw && typeof raw === "object") saved = raw as Partial<MenuSelection>;
  } catch {
    /* ignore */
  }
  // `?map=` wins over the remembered card, the card over the page default.
  let urlMap: string | null = null;
  try {
    const q = new URLSearchParams(location.search).get("map");
    if (isMapId(q)) urlMap = q;
  } catch {
    /* no URL API */
  }
  sel = {
    map: urlMap ?? (isMapId(saved.map) ? saved.map : isMapId(pageMap) ? pageMap : DEFAULT_MAP_ID),
    mode: asModeId(saved.mode),
  };
  const menu = $("menu");
  if (menu) wireSfx(menu);
  buildCards();
  paint();
  initMusicToggle();
  const keys = $("menu-keys");
  if (keys) renderKeyline(keys);
  initPadBar();
}

/** Pad shortcut bar under the keyline — only while pad prompts are active. */
function initPadBar(): void {
  const foot = document.querySelector("#menu .menu-foot");
  if (!foot || document.getElementById("menu-padbar")) return;
  const bar = h("div", "keyline hidden");
  bar.id = "menu-padbar";
  foot.prepend(bar);
  const paint = (): void => {
    bar.replaceChildren();
    if (!padPromptsActive()) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    for (const sc of MENU_PAD) {
      const s = h("span");
      s.append(padGlyph(sc.btn), document.createTextNode(sc.label));
      bar.append(s);
    }
  };
  paint();
  onPadPrompts(paint);
}

export function setMenuSelection(patch: Partial<MenuSelection>): void {
  sel = { ...sel, ...patch };
  try {
    localStorage.setItem(SEL_KEY, JSON.stringify(sel));
  } catch {
    /* ignore */
  }
  paint();
  onChange?.(sel);
}

function buildCards(): void {
  const box = $("map-cards");
  if (!box) return;
  box.replaceChildren();
  for (const id of mapIds()) {
    const c = h("button", "map-card");
    c.type = "button";
    c.dataset.map = id;
    c.setAttribute("role", "radio");
    c.style.backgroundImage = mapCardUrl(id);
    c.append(h("b", undefined, mapLabel(id)));
    const tdm = modeInfo(id, "tdm");
    const ffa = modeInfo(id, "ffa");
    c.append(h("span", undefined, `${tdm.size} · ${ffa.seats} FFA`));
    c.title = mapBlurb(id);
    c.addEventListener("click", () => setMenuSelection({ map: id }));
    box.append(c);
  }
  const count = $("map-count");
  if (count) count.textContent = `${mapIds().length} MAPS`;
}

function paint(): void {
  document.querySelectorAll<HTMLElement>("#map-cards .map-card").forEach((c) => {
    const on = c.dataset.map === sel.map;
    c.classList.toggle("is-on", on);
    c.setAttribute("aria-checked", String(on));
  });
  const seg = $("mode-seg");
  if (seg) {
    seg.replaceChildren();
    for (const m of modesFor(sel.map)) {
      const b = h("button", m.mode === sel.mode ? "is-on" : "");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(m.mode === sel.mode));
      // Three modes share the row: the size lives in the summary line below.
      b.append(document.createTextNode(m.label));
      b.title = `${m.label} · ${m.size}`;
      b.addEventListener("click", () => setMenuSelection({ mode: m.mode }));
      seg.append(b);
    }
  }
  const info = modeInfo(sel.map, sel.mode);
  const goal = $("setup-goal");
  if (goal) goal.textContent = `${info.label} · ${info.size} · ${info.goal}`;
  const rules = $("setup-rules");
  if (rules) rules.textContent = info.rules;
  const map = mapLabel(sel.map);
  const bots = info.seats - 1;
  const sub = (id: string, t: string): void => {
    const el = $(id);
    if (el) el.textContent = t;
  };
  sub("tile-sub-play", `${info.label} ${info.size} · ${map}`);
  const meta = $("tile-meta-play");
  if (meta) meta.textContent = `OFFLINE · VS ${bots} BOTS`;
  sub("tile-sub-lobby", `${info.label} ${info.size} · ${map}`);
  const pub = modeInfo(sel.map, PUBLIC_MODE);
  sub("tile-sub-multi", `${pub.label} ${pub.size} · ${map}`);
  sub("hero-map", map);
  sub("hero-mode", `${info.label} · ${info.size}`);
  sub("hero-blurb", mapBlurb(sel.map));
  const art = $("menu-art");
  if (art) art.style.backgroundImage = mapCardUrl(sel.map);
}

export function setCallsignChip(name: string): void {
  const el = $("callsign-name");
  if (el) el.textContent = name || "SET CALLSIGN";
}

/**
 * The topbar menu-music toggle (left of the callsign chip): a mute switch on
 * top of the AUDIO slider — the slider keeps driving the level, this only
 * forces it to 0 via prefs.musicMuted (menu-music.ts effLevel). Persists
 * through prefs, applies live via the onPrefs sync (no reload), menu only.
 */
function paintMusicToggle(btn: HTMLButtonElement): void {
  const muted = prefs().musicMuted;
  btn.classList.toggle("is-off", muted);
  btn.setAttribute("aria-pressed", String(muted));
  btn.setAttribute("aria-label", muted ? "Turn menu music on" : "Mute menu music");
  btn.title = muted ? "Menu music: off — click to turn on" : "Menu music: on — click to mute";
}

function initMusicToggle(): void {
  const btn = document.getElementById("music-toggle") as HTMLButtonElement | null;
  if (!btn || btn.dataset.wired === "1") return;
  btn.dataset.wired = "1";
  paintMusicToggle(btn);
  btn.addEventListener("click", () => setPrefs({ musicMuted: !prefs().musicMuted }));
  onPrefs(() => paintMusicToggle(btn));
}

/** Grey the tiles out while a launch is in flight (one press, one attempt). */
export function menuBusy(on: boolean): void {
  document.querySelectorAll<HTMLElement>("#play-tiles .tile").forEach((t) => t.classList.toggle("is-busy", on));
}
