/**
 * client/src/ui/loadout.ts — LOADOUT: pick the primary (AR / SMG / SNIPER);
 * the pistol and the frag are the fixed secondary and lethal.
 *
 * Renders shared/loadout.ts WEAPON_CARDS (the weapons stream owns the numbers;
 * this screen never restates them) and persists with saveLoadout(). Reachable
 * from the main menu and from the in-match pause menu; a change made mid-match
 * applies at the player's next spawn (CoD rule) — the screen says so, and a
 * `loadout` CustomEvent on window carries the new loadout to whoever applies
 * it (game code listens; the UI does not reach into the sim).
 */
import { PRIMARY_IDS, WEAPON_CARDS, readLoadout, saveLoadout, type Loadout, type LoadoutWeaponId, type PrimaryId, type WeaponBars } from "@shared/loadout";
import { uiSfx, wireSfx } from "./sfx";
import { WEAPON_BY_ID, reloadTime, shotsToKill, ttkMs } from "@shared/weapons";

const BAR_ORDER: [keyof WeaponBars, string][] = [
  ["damage", "DAMAGE"],
  ["fireRate", "FIRE RATE"],
  ["range", "RANGE"],
  ["accuracy", "ACCURACY"],
  ["mobility", "MOBILITY"],
  ["handling", "HANDLING"],
];

let root: HTMLElement | null = null;
let closeCb: (() => void) | null = null;
let inMatch = false;
let focusId: LoadoutWeaponId = "ar";
let draft: Loadout = readLoadout();

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function loadoutOpen(): boolean {
  return !!root;
}

export function openLoadout(opts: { inMatch?: boolean; onClose?: () => void } = {}): void {
  inMatch = !!opts.inMatch;
  closeCb = opts.onClose ?? null;
  draft = readLoadout();
  focusId = draft.primary;
  if (!root) {
    root = h("div", "modal");
    root.id = "loadout";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Loadout");
    (document.getElementById("app") ?? document.body).append(root);
    wireSfx(root);
    window.addEventListener("keydown", onKey, true);
  }
  render();
}

export function closeLoadout(): void {
  if (!root) return;
  root.remove();
  root = null;
  window.removeEventListener("keydown", onKey, true);
  const cb = closeCb;
  closeCb = null;
  cb?.();
}

function onKey(e: KeyboardEvent): void {
  if (!root) return;
  if (e.code === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    uiSfx("back");
    closeLoadout();
    return;
  }
  if (e.code === "ArrowDown" || e.code === "ArrowUp") {
    e.preventDefault();
    const i = PRIMARY_IDS.indexOf(focusId as PrimaryId);
    const next = PRIMARY_IDS[(Math.max(0, i) + (e.code === "ArrowDown" ? 1 : PRIMARY_IDS.length - 1)) % PRIMARY_IDS.length]!;
    focusId = next;
    uiSfx("hover");
    render();
  } else if (e.code === "Enter" || e.code === "Space") {
    if (PRIMARY_IDS.includes(focusId as PrimaryId)) {
      e.preventDefault();
      equip(focusId as PrimaryId);
    }
  }
  e.stopPropagation();
}

function equip(id: PrimaryId): void {
  if (draft.primary === id) return;
  draft = { ...draft, primary: id };
  saveLoadout(draft);
  uiSfx("confirm");
  window.dispatchEvent(new CustomEvent("loadout", { detail: { ...draft } }));
  render();
}

function render(): void {
  if (!root) return;
  root.replaceChildren();
  const frame = h("div", "modal-frame");
  const head = h("header", "modal-head");
  head.append(h("h2", "modal-title", "LOADOUT"));
  const sub = h("p", "eyebrow", inMatch ? "CHANGES APPLY ON YOUR NEXT SPAWN" : "PRIMARY · SECONDARY · LETHAL");
  sub.style.paddingBottom = "var(--s5)";
  head.append(sub);

  const body = h("div", "lo-body");
  const slots = h("div", "lo-slots");
  slots.append(h("p", "lo-slot-label", "PRIMARY"));
  for (const id of PRIMARY_IDS) slots.append(card(id, false));
  slots.append(h("p", "lo-slot-label", "SECONDARY"));
  slots.append(card("pistol", true));
  slots.append(h("p", "lo-slot-label", "LETHAL"));
  const frag = h("div", "lo-card is-locked");
  frag.append(h("b", undefined, "FRAG GRENADE"), h("span", undefined, "HOLD G TO COOK · RELEASE TO THROW"), h("i", "badge", "EQUIPPED"));
  slots.append(frag);

  const c = WEAPON_CARDS[focusId];
  const eq = WEAPON_CARDS[draft.primary];
  const detail = h("section", "lo-detail");
  const wdef = WEAPON_BY_ID[focusId];
  detail.append(h("div", "lo-ghost", wdef?.short ?? c.name.split(" ")[0]!));
  detail.append(h("p", "eyebrow", c.cls));
  detail.append(h("h3", "lo-name", c.name));
  detail.append(h("p", "lo-blurb", c.blurb));
  const stats = h("div", "lo-stats");
  for (const [k, label] of BAR_ORDER) {
    const v = Math.max(0, Math.min(100, Math.round(c.bars[k])));
    const base = c.slot === "primary" && focusId !== draft.primary ? Math.round(eq.bars[k]) : v;
    const row = h("div", "stat");
    row.append(h("span", undefined, label));
    const track = h("div", "stat-track");
    // Compare against what is EQUIPPED: the shared part in white, the gain
    // in green, the loss in red — the gunsmith convention.
    const lo = Math.min(v, base);
    const main = h("i");
    main.style.width = `${lo}%`;
    track.append(main);
    if (v !== base) {
      const delta = h("i", v > base ? "cmp-up" : "cmp-down");
      delta.style.left = `${lo}%`;
      delta.style.width = `${Math.abs(v - base)}%`;
      track.append(delta);
    }
    row.append(track, h("b", undefined, String(v)));
    stats.append(row);
  }
  detail.append(stats);
  // THE NUMBERS BEHIND THE BARS (gunsmith convention), straight from
  // shared/weapons.ts — the same table the sim fires with.
  if (wdef) {
    const spec = h("div", "lo-spec");
    const cell = (k: string, v: string): void => {
      const d = h("div");
      d.append(h("span", undefined, k), h("b", undefined, v));
      spec.append(d);
    };
    cell("FIRE RATE", `${Math.round(wdef.rpm)} RPM`);
    cell("MAGAZINE", `${wdef.mag}`);
    cell("RELOAD", `${reloadTime(wdef, 1).toFixed(1)} S`);
    cell("SHOTS TO KILL · 10 M", `${shotsToKill(wdef, 10)}`);
    cell("TIME TO KILL · 10 M", `${Math.round(ttkMs(wdef, 10))} MS`);
    detail.append(spec);
  }
  if (c.slot === "primary") {
    const act = h("div");
    act.style.display = "flex";
    act.style.gap = "var(--s3)";
    act.style.marginTop = "var(--s6)";
    if (focusId === draft.primary) {
      const b = h("button", "btn", "EQUIPPED");
      b.type = "button";
      b.disabled = true;
      act.append(b);
    } else {
      const b = h("button", "btn btn--primary", `EQUIP ${c.name}`);
      b.type = "button";
      b.dataset.sfx = "off";
      b.addEventListener("click", () => equip(focusId as PrimaryId));
      act.append(b);
    }
    detail.append(act);
  }
  if (inMatch) detail.append(h("p", "lo-note", "YOUR CURRENT LIFE KEEPS ITS WEAPON. THE NEW LOADOUT IS ISSUED ON RESPAWN."));

  body.append(slots, detail);

  const foot = h("footer", "modal-foot");
  const hints = h("div", "hintbar");
  const hint = (k: string, t: string): HTMLElement => {
    const s = h("span");
    s.append(h("i", "key", k), document.createTextNode(t));
    return s;
  };
  hints.append(hint("ESC", "BACK"), hint("↑↓", "BROWSE"), hint("ENTER", "EQUIP"));
  const done = h("button", "btn btn--primary btn--sm", "DONE");
  done.type = "button";
  done.dataset.sfx = "back";
  done.addEventListener("click", () => closeLoadout());
  foot.append(hints, done);

  frame.append(head, body, foot);
  root.append(frame);
}

function card(id: LoadoutWeaponId, locked: boolean): HTMLElement {
  const c = WEAPON_CARDS[id];
  const on = locked || draft.primary === id;
  const b = h("button", `lo-card${on ? " is-on" : ""}${focusId === id ? " is-focus" : ""}${locked ? " is-locked" : ""}`);
  b.type = "button";
  b.append(h("b", undefined, c.name), h("span", undefined, c.cls));
  if (on) b.append(h("i", "badge badge--accent", "EQUIPPED"));
  b.addEventListener("pointerenter", () => {
    if (focusId === id) return;
    focusId = id;
    render();
  });
  b.addEventListener("click", () => {
    focusId = id;
    if (!locked && c.slot === "primary") equip(id as PrimaryId);
    else render();
  });
  return b;
}
