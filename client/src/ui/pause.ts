/**
 * client/src/ui/pause.ts — the in-match ESC menu.
 *
 * ESC releases the pointer lock (the browser owns that key), and the moment a
 * match loses the lock this menu comes up instead of a bare "click to play"
 * line: RESUME · LOADOUT · SETTINGS · LEAVE MATCH, with the match card on the
 * right. The match keeps running behind it — online it cannot pause, and a
 * fake freeze would lie — so the eyebrow says so.
 */
import { uiSfx, wireSfx } from "./sfx";
import { padGlyph, padPromptsActive } from "./gamepad";

export interface PauseCtx {
  /** "TEAM DEATHMATCH · 5v5" etc. */
  mode: string;
  map: string;
  mapArt: string;
  rules: string;
  /** The match as it stands when the menu opened (scorebug labels + clock). */
  score?: { a: string; b: string; la: string; lb: string; clock: string; ffa: boolean };
  /** Invite link when this is a private match the player can share. */
  invite?: string;
  online: boolean;
  onResume: () => void;
  onLoadout: () => void;
  onSettings: () => void;
  onLeave: () => void;
}

let root: HTMLElement | null = null;
let ctx: PauseCtx | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function pauseOpen(): boolean {
  return !!root;
}

export function openPause(c: PauseCtx): void {
  ctx = c;
  if (!root) {
    root = h("div");
    root.id = "pause";
    (document.getElementById("app") ?? document.body).append(root);
    wireSfx(root);
    window.addEventListener("keydown", onKey, true);
    document.body.classList.add("paused");
  }
  render(false);
}

export function closePause(): void {
  if (!root) return;
  root.remove();
  root = null;
  window.removeEventListener("keydown", onKey, true);
  document.body.classList.remove("paused");
}

function onKey(e: KeyboardEvent): void {
  if (!root || !ctx) return;
  // Settings / loadout stack on top and own ESC while they are up.
  if (document.getElementById("settings") || document.getElementById("loadout")) return;
  if (e.code === "Escape") {
    // ESC on the pause menu resumes (the browser needs a user gesture to
    // re-lock the pointer, and a keypress counts).
    e.preventDefault();
    e.stopImmediatePropagation();
    ctx.onResume();
  }
}

function render(confirming: boolean): void {
  if (!root || !ctx) return;
  const c = ctx;
  root.replaceChildren();
  const col = h("section", "pause-col");
  col.append(h("p", "eyebrow", c.online ? "MATCH IN PROGRESS · THE GAME DOES NOT PAUSE" : "MATCH IN PROGRESS"));
  col.append(h("h1", "menu-title", "PAUSED"));
  // sub: keyboard keycap text, or the pad glyph + shortcut when pad prompts
  // are active (START resumes, Y jumps to loadout, X to settings — the same
  // shortcuts the pad nav hooks fire). Render-time read: the pause re-renders
  // on every open, so the device is always current.
  const pad = padPromptsActive();
  const sub = (key: string, shortcut: string): HTMLElement | null => {
    if (pad) {
      const sm = h("small");
      sm.append(padGlyph(shortcut));
      return sm;
    }
    return key ? h("small", undefined, key) : null;
  };
  const btn = (label: string, hint: HTMLElement | null, cls: string, fn: () => void, sfx = ""): HTMLButtonElement => {
    const b = h("button", `pause-btn ${cls}`);
    b.type = "button";
    b.append(document.createTextNode(label));
    if (hint) b.append(hint);
    if (sfx) b.dataset.sfx = sfx;
    b.addEventListener("click", fn);
    return b;
  };
  const resume = btn("RESUME", sub("ESC", "START"), "is-primary", () => c.onResume(), "confirm");
  col.append(resume);
  col.append(btn("LOADOUT", sub("NEXT SPAWN", "Y"), "", () => c.onLoadout()));
  col.append(btn("SETTINGS", sub("", "X"), "", () => c.onSettings()));
  if (!confirming) {
    col.append(btn("LEAVE MATCH", sub("", "A"), "is-danger", () => render(true)));
  } else {
    const box = h("div", "pause-confirm");
    box.append(h("p", undefined, c.online ? "Leave this match and return to the main menu?" : "End this match and return to the main menu?"));
    const row = h("div");
    const yes = h("button", "btn btn--danger btn--sm", "LEAVE");
    yes.type = "button";
    yes.dataset.sfx = "back";
    yes.addEventListener("click", () => c.onLeave());
    const no = h("button", "btn btn--ghost btn--sm", "CANCEL");
    no.type = "button";
    no.addEventListener("click", () => render(false));
    row.append(yes, no);
    box.append(row);
    col.append(box);
  }

  const side = h("aside", "pause-side");
  const card = h("div", "nana-mapcard");
  card.style.backgroundImage = c.mapArt;
  card.append(h("p", "eyebrow nana-eyebrow", c.mode), h("b", undefined, c.map));
  side.append(card);
  if (c.score) {
    const sc = h("div", "pause-score");
    const side1 = h("div", c.score.ffa ? "you" : "ally");
    side1.append(h("b", undefined, c.score.a), h("span", undefined, c.score.la));
    const side2 = h("div", c.score.ffa ? "lead" : "enemy");
    side2.append(h("b", undefined, c.score.b), h("span", undefined, c.score.lb));
    const clock = h("div", "clock");
    clock.append(h("b", undefined, c.score.clock), h("span", undefined, "LEFT"));
    sc.append(side1, side2, clock);
    side.append(sc);
  }
  side.append(h("p", "nana-rules", c.rules));
  if (c.invite) {
    const box = h("div", "nana-box");
    box.append(h("span", "nana-label", "INVITE LINK"));
    const row = h("div", "nana-invite-row");
    const input = h("input", "field");
    input.readOnly = true;
    input.value = c.invite;
    input.style.height = "max(32px, calc(44 * var(--tu)))";
    input.style.fontSize = "var(--fs-small)";
    const copy = h("button", "btn btn--sm", "COPY");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      let ok = false;
      try {
        await navigator.clipboard?.writeText(c.invite!);
        ok = true;
      } catch {
        input.select();
        ok = document.execCommand?.("copy") ?? false;
      }
      copy.textContent = ok ? "COPIED" : "PRESS ⌘C";
      uiSfx(ok ? "confirm" : "error");
      setTimeout(() => (copy.textContent = "COPY"), 2000);
    });
    row.append(input, copy);
    box.append(row);
    side.append(box);
  }
  const spacer = h("div");
  root.append(col, spacer, side);
  requestAnimationFrame(() => resume.focus({ preventScroll: true }));
}
