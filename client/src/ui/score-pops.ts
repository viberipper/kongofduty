/**
 * client/src/ui/score-pops.ts — CoD SCORE POPUPS beside the crosshair (feel stream R2).
 * ===========================================================================
 *
 * What a kill was worth, the moment it lands, right of the crosshair: a running
 * total ("+250", in the accent — it is YOUR score) over the reasons, newest on
 * top — "+100 KILL", "+50 HEADSHOT", then each medal that pays ("+50 DOUBLE
 * KILL", "+50 LONGSHOT"…). Kills inside 2.5 s of each other add to the same
 * stack, the way MWII chains them; the stack holds ~2 s after the last line
 * and fades. ASSISTS: a player you damaged (10+ in the last 8 s) killed by
 * someone else pays "+25 ASSIST" — the sim keeps no assists, so this is
 * counted on the client from the hit events every client already receives.
 *
 * Cosmetic: the scoreboard's numbers are the sim's; these are the feedback.
 * Driven off the game clock (`tick(nowMs)`), every write change-gated.
 */
import type { Medal, MedalId } from "../accolades";

/** Points a medal adds on top of the kill (0 = a notice, not a line). */
const MEDAL_PTS: Partial<Record<MedalId, number>> = {
  double: 50,
  triple: 75,
  quad: 100,
  rampage: 150,
  longshot: 50,
  payback: 50,
  revenge: 50,
  buzzkill: 50,
  firstblood: 100,
  cooked: 50,
  laststand: 50,
};
const KILL = 100;
const HEAD = 50;
const ASSIST = 25;
const WALLBANG = 50;
const CHAIN_S = 2.5;
const HOLD_S = 2.1;
const FADE_S = 0.35;
const MAX_LINES = 5;

type Line = { pts: number; label: string; at: number; el?: HTMLElement };

export class ScorePops {
  private root: HTMLElement | null = null;
  private totalEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private lines: Line[] = [];
  private total = 0;
  private lastAt = -1e9;
  private shownTotal = "";
  private op = "";
  /** Damage you dealt per victim since their last death: [{at, dmg}]. */
  private dealt = new Map<string, { at: number; dmg: number; wall?: boolean }[]>();

  private mount(): boolean {
    if (this.root?.isConnected) return true;
    const hud = document.getElementById("hud");
    if (!hud) return false;
    this.root = document.getElementById("score-pop") ?? document.createElement("div");
    this.root.id = "score-pop";
    this.root.replaceChildren();
    this.totalEl = document.createElement("b");
    this.listEl = document.createElement("div");
    this.root.append(this.totalEl, this.listEl);
    if (!this.root.isConnected) hud.append(this.root);
    this.shownTotal = "";
    return true;
  }

  /** A hit of yours (assist bookkeeping). */
  hit(dst: string, dmg: number, nowS: number, wall = false): void {
    let a = this.dealt.get(dst);
    if (!a) this.dealt.set(dst, (a = []));
    a.push({ at: nowS, dmg, wall });
    if (a.length > 24) a.splice(0, a.length - 24);
  }

  /** Every kill in the match: yours pays a stack; someone else's kill of a player you hurt pays an assist. */
  kill(src: string, dst: string, you: string, head: boolean, weapon: string, medals: Medal[], nowMs: number): void {
    const now = nowMs / 1000;
    const hurt = (this.dealt.get(dst) ?? []).filter((h) => now - h.at < 8).reduce((s, h) => s + h.dmg, 0);
    // The finishing round went through a wall (shared/penetration.ts).
    const last = this.dealt.get(dst)?.at(-1);
    const wallbang = !!last?.wall && now - last.at < 1;
    this.dealt.delete(dst);
    if (dst === you) {
      this.dealt.clear();
      return;
    }
    if (src === you) {
      const add: Line[] = [{ pts: KILL, label: "KILL", at: now }];
      const gun = weapon !== "nade" && weapon !== "strike" && weapon !== "knife" && weapon !== "melee";
      if (head && gun) add.push({ pts: HEAD, label: "HEADSHOT", at: now });
      if (wallbang && gun) add.push({ pts: WALLBANG, label: "WALLBANG", at: now });
      for (const m of medals) {
        const p = MEDAL_PTS[m.id];
        if (p) add.push({ pts: p, label: m.title, at: now });
      }
      this.push(add, now);
    } else if (hurt >= 10) {
      this.push([{ pts: ASSIST, label: "ASSIST", at: now }], now);
    }
  }

  private push(add: Line[], now: number): void {
    if (!this.mount()) return;
    if (now - this.lastAt > CHAIN_S + HOLD_S) {
      // a fresh stack
      for (const l of this.lines) l.el?.remove();
      this.lines.length = 0;
      this.total = 0;
    }
    this.lastAt = now;
    for (const l of add) {
      this.total += l.pts;
      const el = document.createElement("div");
      el.className = "sp-line";
      const n = document.createElement("i");
      n.textContent = `+${l.pts}`;
      const t = document.createElement("span");
      t.textContent = l.label;
      el.append(n, t);
      l.el = el;
      this.listEl!.prepend(el);
      this.lines.unshift(l);
    }
    while (this.lines.length > MAX_LINES) this.lines.pop()!.el?.remove();
  }

  /** Per frame (game clock): the line pop-ins, the hold and the fade. */
  tick(nowMs: number): void {
    if (!this.root) return;
    const now = nowMs / 1000;
    const age = now - this.lastAt;
    const vis = this.lines.length ? (age < HOLD_S ? 1 : Math.max(0, 1 - (age - HOLD_S) / FADE_S)) : 0;
    const o = vis.toFixed(2);
    if (o !== this.op) {
      this.op = o;
      this.root.style.opacity = o;
    }
    const tt = this.lines.length ? `+${this.total}` : "";
    if (tt !== this.shownTotal) {
      this.shownTotal = tt;
      this.totalEl!.textContent = tt;
      this.totalEl!.classList.remove("bump");
      void this.totalEl!.offsetWidth;
      this.totalEl!.classList.add("bump");
    }
    for (const l of this.lines) {
      if (!l.el) continue;
      const k = Math.min(1, (now - l.at) / 0.16);
      const e = 1 - (1 - k) ** 3;
      const v = `${e.toFixed(3)}`;
      if (l.el.style.opacity !== v) {
        l.el.style.opacity = v;
        l.el.style.transform = `translateX(${((1 - e) * -10).toFixed(1)}px)`;
      }
    }
    if (vis <= 0 && this.lines.length) {
      for (const l of this.lines) l.el?.remove();
      this.lines.length = 0;
      this.total = 0;
    }
  }

  clear(): void {
    for (const l of this.lines) l.el?.remove();
    this.lines.length = 0;
    this.total = 0;
    this.lastAt = -1e9;
    this.dealt.clear();
    if (this.root) this.root.style.opacity = "0";
    this.op = "0";
  }
}
