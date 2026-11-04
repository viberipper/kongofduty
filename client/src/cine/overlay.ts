/**
 * client/src/cine/overlay.ts — the cinematic chrome: letterbox, the map title
 * card, the mode/objective line, the team roster, the squad callouts, the
 * round lower third, the hold-to-skip ring, and the play-of-the-game banner,
 * plate, kill counter, ELIMINATED pop and mini kill feed.
 *
 * ONE OWNER PER SLOT. Each slot of the screen belongs to one element at a time:
 *   top bar        skip ring (right)                 · potg kill feed (right, under it)
 *   upper centre   the 3-2-1 (matchfeel, moved up to 12.5% while a cinematic runs)
 *   middle         squad callouts (over heads)       · potg slam (its own beat) / ELIMINATED pop
 *   lower third    title card / round title (left)   · roster (right) · potg plate (left)
 *   bottom bar     potg progress
 * qa/cine/capture.mjs measures every visible text rect against every other.
 *
 * Every animation is driven from the game clock / the shared timeline (no CSS
 * keyframes, no transitions), the same rule matchfeel.ts follows, so the
 * capture rig can pose any frame exactly. Style writes are change-gated.
 */
import "./cine.css";

export type TeamRow = { name: string; you: boolean };
export type IntroCard = {
  eyebrow: string;
  title: string;
  brand: "katana" | "default";
  wordmark?: string;
  mode: string;
  goal: string;
  allies: TeamRow[];
  enemies: TeamRow[];
  ffa: boolean;
  short: boolean;
  /** Round starts: "ROUND 2" + "ATTACK · …" + "1 – 0". */
  round?: { title: string; line: string; score: string };
};
export type PotgCard = { name: string; rel: "you" | "ally" | "enemy"; title: string; line: string; eyebrow?: string; stats?: { k: string; v: string }[] };
export type Callout = { x: number; y: number; name: string; you: boolean; a: number };

const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);
const easeOut = (u: number): number => 1 - (1 - clamp01(u)) ** 3;

function el(tag: string, cls: string, parent?: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

export class CineOverlay {
  readonly root: HTMLElement;
  private top: HTMLElement;
  private bot: HTMLElement;
  private scrim: HTMLElement;
  private flash: HTMLElement;
  private veil: HTMLElement;
  private skip: HTMLElement;
  private skipArc: SVGCircleElement;
  private title: HTMLElement;
  private eyebrow: HTMLElement;
  private name: HTMLElement;
  private rule: HTMLElement;
  private mode: HTMLElement;
  private goal: HTMLElement;
  private teams: HTMLElement;
  private wait: HTMLElement;
  private calls: HTMLElement;
  private callEls: HTMLElement[] = [];
  private round: HTMLElement;
  private potg: HTMLElement;
  private pSlam: HTMLElement;
  private pPlate: HTMLElement;
  private pCount: HTMLElement;
  private pBar: HTMLElement;
  private pPop: HTMLElement;
  private pFeed: HTMLElement;
  private pOver: HTMLElement;
  private last = new WeakMap<HTMLElement | SVGElement, Record<string, string>>();
  private ffa = false;
  private short = false;
  private waitTxt = "";
  private countTxt = "";

  constructor() {
    document.getElementById("cine")?.remove();
    const root = el("div", "cine");
    root.id = "cine";
    root.setAttribute("aria-hidden", "true");
    this.root = root;
    this.scrim = el("div", "cine-scrim", root);
    this.top = el("div", "cine-bar cine-top", root);
    this.bot = el("div", "cine-bar cine-bot", root);
    this.flash = el("div", "cine-flash", root);
    this.veil = el("div", "cine-veil", root);
    this.skip = el("div", "cine-skip", root);
    this.skip.innerHTML = `<svg viewBox="0 0 24 24" class="cine-skip-ring"><circle cx="12" cy="12" r="9.5" class="bg"/><circle cx="12" cy="12" r="9.5" class="arc"/></svg><i class="key">SPACE</i><span>HOLD TO SKIP</span>`;
    this.skipArc = this.skip.querySelector(".arc") as SVGCircleElement;
    this.title = el("div", "cine-title", root);
    const eb = el("div", "cine-eyebrow", this.title);
    el("i", "cine-mark", eb);
    this.eyebrow = el("span", "", eb);
    this.name = el("div", "cine-name", this.title);
    this.rule = el("div", "cine-rule", this.title);
    this.mode = el("div", "cine-mode", this.title);
    this.goal = el("div", "cine-goal", this.title);
    this.teams = el("div", "cine-teams", root);
    this.wait = el("div", "cine-wait", root);
    this.calls = el("div", "cine-calls", root);
    this.round = el("div", "cine-round", root);
    this.potg = el("div", "cine-potg", root);
    this.pSlam = el("div", "potg-slam", this.potg);
    this.pPlate = el("div", "potg-plate", this.potg);
    this.pCount = el("div", "potg-count", this.pPlate);
    this.pBar = el("div", "potg-bar", this.potg);
    el("i", "", this.pBar);
    this.pPop = el("div", "potg-pop", this.potg);
    this.pFeed = el("div", "potg-feed", this.potg);
    this.pOver = el("div", "potg-over", this.potg);
    document.body.append(root);
    this.hide();
  }

  private set(e: HTMLElement | SVGElement, prop: string, v: string): void {
    let r = this.last.get(e);
    if (!r) this.last.set(e, (r = {}));
    if (r[prop] === v) return;
    r[prop] = v;
    (e.style as unknown as Record<string, string>)[prop] = v;
  }

  hide(): void {
    this.root.classList.remove("on", "intro", "potg", "katana", "short");
    this.root.style.display = "none";
    for (const c of this.callEls) c.style.opacity = "0";
  }

  /** Full-screen black (0..1): the POTG hand-off to the endcard. */
  setVeil(a: number): void {
    if (a > 0) this.root.style.display = "";
    this.set(this.veil, "opacity", a.toFixed(3));
  }

  /** The hold-to-skip ring: `fill` 0..1, `a` its opacity. */
  skipRing(fill: number, a: number, label = "HOLD TO SKIP"): void {
    this.set(this.skip, "opacity", a.toFixed(3));
    this.set(this.skipArc, "strokeDashoffset", (59.69 * (1 - clamp01(fill))).toFixed(2));
    const span = this.skip.querySelector("span");
    if (span && span.textContent !== label) span.textContent = label;
  }

  // ------------------------------------------------------------- intro

  showIntro(c: IntroCard): void {
    this.root.style.display = "";
    this.root.classList.add("on", "intro");
    this.root.classList.remove("potg");
    this.root.classList.toggle("katana", c.brand === "katana");
    this.root.classList.toggle("short", c.short);
    this.eyebrow.textContent = c.eyebrow;
    this.name.replaceChildren();
    if (c.brand === "katana" && c.wordmark) {
      const wm = c.wordmark;
      const lead = wm.startsWith("›") ? "›" : "";
      if (lead) el("b", "cine-chev", this.name, lead);
      el("span", "", this.name, wm.slice(lead.length));
    } else {
      el("span", "", this.name, c.title);
    }
    this.mode.textContent = c.mode;
    this.goal.textContent = c.goal;
    this.ffa = c.ffa;
    this.short = c.short;
    this.setTeams(c.allies, c.enemies);
    this.round.replaceChildren();
    if (c.round) {
      el("div", "cine-round-t", this.round, c.round.title);
      el("div", "cine-round-l", this.round, c.round.line);
      if (c.round.score) el("div", "cine-round-s", this.round, c.round.score);
    }
    this.set(this.flash, "opacity", "0");
    this.set(this.veil, "opacity", "0");
  }

  setTeams(allies: TeamRow[], enemies: TeamRow[]): void {
    this.teams.replaceChildren();
    if (this.short) return;
    if (this.ffa) {
      el("div", "cine-ffa", this.teams, `${allies.length + enemies.length} OPERATORS · EVERY ONE FOR THEMSELVES`);
      return;
    }
    // header row (with VS between the two headers), then two name columns
    el("div", "cine-side-h ally", this.teams, `YOUR TEAM · ${allies.length}`);
    el("div", "cine-vs", this.teams, "VS");
    el("div", "cine-side-h enemy", this.teams, `ENEMY · ${enemies.length}`);
    const col = (rows: TeamRow[], side: string): void => {
      const box = el("div", `cine-col ${side}`, this.teams);
      for (const r of rows.slice(0, 8)) el("div", r.you ? "cine-row you" : "cine-row", box, r.name);
    };
    col(allies, "ally");
    el("div", "", this.teams);
    col(enemies, "enemy");
  }

  /** One frame of the intro chrome. */
  intro(s: { bars: number; title: number; mode: number; teams: number; flash: number; round: number; waitS?: number }): void {
    const b = easeOut(s.bars);
    this.set(this.top, "transform", `scaleY(${b.toFixed(4)})`);
    this.set(this.bot, "transform", `scaleY(${b.toFixed(4)})`);
    this.set(this.flash, "opacity", s.flash.toFixed(3));
    const txt = s.waitS && s.waitS > 0 ? `MATCH STARTS IN ${Math.ceil(s.waitS)}` : "";
    if (txt !== this.waitTxt) {
      this.waitTxt = txt;
      this.wait.textContent = txt;
    }
    this.set(this.wait, "opacity", txt ? "1" : "0");
    const t = s.title;
    const wipe = easeOut(t * 1.15);
    this.set(this.title, "opacity", t > 0 || s.mode > 0 ? "1" : "0");
    this.set(this.name, "clipPath", `inset(-20% ${(100 - wipe * 100).toFixed(2)}% -20% 0)`);
    this.set(this.name, "transform", `translateX(${((1 - wipe) * -24).toFixed(2)}px)`);
    this.set(this.name, "opacity", Math.min(1, t * 1.6).toFixed(3));
    this.set(this.rule, "transform", `scaleX(${easeOut((t - 0.15) * 1.4).toFixed(4)})`);
    this.set(this.eyebrow.parentElement!, "opacity", clamp01(t * 1.4).toFixed(3));
    const m = easeOut(s.mode);
    this.set(this.mode, "opacity", m.toFixed(3));
    this.set(this.goal, "opacity", m.toFixed(3));
    const tm = easeOut(s.teams);
    this.set(this.teams, "opacity", tm.toFixed(3));
    this.set(this.teams, "transform", `translateX(${((1 - tm) * 28).toFixed(2)}px)`);
    const r = easeOut(s.round);
    this.set(this.round, "opacity", r.toFixed(3));
    this.set(this.round, "transform", `translateX(${((1 - r) * -20).toFixed(2)}px)`);
    this.set(this.scrim, "opacity", Math.max(t, m, tm, r).toFixed(3));
  }

  /** Squad names over heads (screen px). Pass [] to clear. */
  callouts(list: Callout[]): void {
    while (this.callEls.length < list.length) {
      const c = el("div", "cine-call", this.calls);
      el("b", "", c);
      el("i", "", c);
      this.callEls.push(c);
    }
    this.callEls.forEach((c, i) => {
      const it = list[i];
      if (!it || it.a <= 0.01) {
        this.set(c, "opacity", "0");
        return;
      }
      const b = c.firstElementChild as HTMLElement;
      if (b.textContent !== it.name) b.textContent = it.name;
      c.classList.toggle("you", it.you);
      this.set(c, "opacity", it.a.toFixed(3));
      this.set(c, "transform", `translate(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px) translate(-50%, -100%)`);
    });
  }

  // ------------------------------------------------------------- potg

  showPotg(c: PotgCard): void {
    this.root.style.display = "";
    this.root.classList.add("on", "potg");
    this.root.classList.remove("intro", "katana", "short");
    // THE CARD (beside the studio vignette): eyebrow, the name huge, what they did, the line or the numbers
    this.pSlam.innerHTML = "";
    el("div", "potg-eyebrow", this.pSlam, c.eyebrow ?? "PLAY OF THE GAME");
    el("b", `potg-big rel-${c.rel}`, this.pSlam, c.name);
    el("div", "potg-what2", this.pSlam, c.title);
    if (c.line) el("div", "potg-sub", this.pSlam, c.line);
    if (c.stats?.length) {
      const st = el("div", "potg-stats", this.pSlam);
      for (const x of c.stats) {
        const cell = el("div", "", st);
        el("b", "", cell, x.v);
        el("span", "", cell, x.k);
      }
    }
    this.pPlate.replaceChildren(this.pCount);
    el("div", "potg-tag", this.pPlate, "PLAY OF THE GAME");
    el("b", `potg-name rel-${c.rel}`, this.pPlate, c.name);
    el("div", "potg-what", this.pPlate, c.title);
    this.pPlate.append(this.pCount); // the counter sits under the title, never over the name
    this.pFeed.replaceChildren();
    this.countTxt = "";
    this.pCount.textContent = "";
    this.set(this.pPop, "opacity", "0");
    this.set(this.veil, "opacity", "0");
    this.callouts([]);
  }

  /** The MATCH OVER beat before the slam: the result over the frozen last frame. */
  overCard(result: string, eyebrow: string): void {
    this.pOver.replaceChildren();
    el("div", "potg-eyebrow", this.pOver, eyebrow);
    el("div", `potg-result r-${result.toLowerCase()}`, this.pOver, result);
    this.set(this.pOver, "opacity", "0");
  }

  overFrame(a: number): void {
    const k = easeOut(clamp01(a));
    this.set(this.pOver, "opacity", k.toFixed(3));
    this.set(this.pOver, "transform", `translate(-50%, -50%) scale(${(1.08 - 0.08 * k).toFixed(4)})`);
  }

  /** A kill landed in the replay: the feed line. */
  feed(killer: string, victim: string, kRel: string, vRel: string): void {
    const row = el("div", "potg-feed-row", this.pFeed);
    el("b", `rel-${kRel}`, row, killer);
    el("i", "", row, "▸");
    el("b", `rel-${vRel}`, row, victim);
    row.dataset.born = String(performance.now());
    while (this.pFeed.children.length > 4) this.pFeed.firstElementChild?.remove();
  }

  /**
   * age: s since the cut opened; slam: 0..1 envelope of the opening beat;
   * progress 0..1; out 0..1 fade; kills (POV); pop: {text, age} of the last ELIMINATED.
   */
  /** The POTG layer (the studio vignette mounts under the card text). */
  potgRoot(): HTMLElement {
    return this.potg;
  }

  /** A white flash (0..1): the freeze-frame's shutter, GO's hit. */
  flashA(a: number): void {
    if (a > 0) this.root.style.display = "";
    this.set(this.flash, "opacity", clamp01(a).toFixed(3));
  }

  /**
   * THE CARD'S TYPE, animated off the card's own clock (s): the eyebrow wipes in, the NAME slams (scales
   * down from 1.4x, its tracking closes, a blur clears), the title wipes, the line rises, the stats step in.
   */
  private cardType(t: number): void {
    const kids = [...this.pSlam.children] as HTMLElement[];
    const seg = (a: number, b: number): number => easeOut((t - a) / (b - a));
    for (const k of kids) {
      const c = k.className;
      if (c.startsWith("potg-eyebrow")) {
        const u = seg(0.05, 0.32);
        this.set(k, "clipPath", `inset(0 ${(100 - u * 100).toFixed(1)}% 0 0)`);
        this.set(k, "transform", `translateX(${((1 - u) * -18).toFixed(1)}px)`);
      } else if (c.startsWith("potg-big")) {
        const u = clamp01((t - 0.12) / 0.32);
        const e = 1 - (1 - u) ** 4;
        this.set(k, "opacity", Math.min(1, u * 3).toFixed(3));
        this.set(k, "transform", `scale(${(1.4 - 0.4 * e).toFixed(4)})`);
        this.set(k, "transformOrigin", "0% 60%");
        this.set(k, "letterSpacing", `${(0.24 * (1 - e) + 0.01).toFixed(3)}em`);
        this.set(k, "filter", u < 1 ? `blur(${(6 * (1 - e)).toFixed(2)}px)` : "none");
      } else if (c.startsWith("potg-what2")) {
        const u = seg(0.38, 0.7);
        this.set(k, "clipPath", `inset(-10% ${(100 - u * 100).toFixed(1)}% -10% 0)`);
      } else if (c.startsWith("potg-sub")) {
        const u = seg(0.58, 0.9);
        this.set(k, "opacity", u.toFixed(3));
        this.set(k, "transform", `translateY(${((1 - u) * 10).toFixed(1)}px)`);
      } else if (c.startsWith("potg-stats")) {
        ([...k.children] as HTMLElement[]).forEach((cell, i) => {
          const u = seg(0.62 + i * 0.09, 0.9 + i * 0.09);
          this.set(cell, "opacity", u.toFixed(3));
          this.set(cell, "transform", `translateY(${((1 - u) * 12).toFixed(1)}px)`);
        });
      }
    }
  }

  potgFrame(s: { slam: number; plate: number; progress: number; bars: number; kills: number; total?: number; pop: { text: string; age: number } | null; feedAge: number[]; fade?: number; vig?: boolean; cardT?: number }): void {
    if (s.cardT !== undefined) this.cardType(s.cardT);
    this.potg.classList.toggle("vig", !!s.vig);
    // everything on the replay fades WITH the picture: nothing lingers over the black
    const f = clamp01(s.fade ?? 1);
    this.set(this.potg, "opacity", f.toFixed(3));
    const b = easeOut(s.bars);
    this.set(this.top, "transform", `scaleY(${b.toFixed(4)})`);
    this.set(this.bot, "transform", `scaleY(${b.toFixed(4)})`);
    const sl = clamp01(s.slam);
    this.set(this.pSlam, "opacity", sl.toFixed(3));
    this.set(this.pSlam, "transform", `translate(${((1 - easeOut(sl)) * -12).toFixed(1)}px, -50%)`);
    const p = easeOut(s.plate);
    this.set(this.pPlate, "opacity", p.toFixed(3));
    this.set(this.pPlate, "transform", `translateX(${((1 - p) * -22).toFixed(2)}px)`);
    this.set(this.scrim, "opacity", (p * 0.85 * f).toFixed(3));
    const ct = s.kills > 0 ? (s.total && s.total > 1 ? `${s.kills} / ${s.total}` : `✕ ${s.kills}`) : "";
    if (ct !== this.countTxt) {
      this.countTxt = ct;
      this.pCount.textContent = ct;
    }
    const bar = this.pBar.firstElementChild as HTMLElement;
    this.set(bar, "transform", `scaleX(${clamp01(s.progress).toFixed(4)})`);
    this.set(this.pBar, "opacity", (p * 0.9).toFixed(3));
    // ELIMINATED pop under the crosshair: in 0.12 s from 1.25x, hold, out by 1.3 s
    if (s.pop && s.pop.age < 1.3) {
      if (this.pPop.textContent !== s.pop.text) this.pPop.textContent = s.pop.text;
      const a = s.pop.age;
      const k = easeOut(a / 0.12);
      const o = a > 0.95 ? clamp01((1.3 - a) / 0.35) : 1;
      this.set(this.pPop, "opacity", (k * o).toFixed(3));
      this.set(this.pPop, "transform", `translate(-50%, 0) scale(${(1.25 - 0.25 * k).toFixed(3)})`);
    } else this.set(this.pPop, "opacity", "0");
    [...this.pFeed.children].forEach((r, i) => {
      const age = s.feedAge[i] ?? 0;
      this.set(r as HTMLElement, "opacity", (age < 3 ? Math.min(1, age / 0.15) : Math.max(0, 1 - (age - 3) / 0.4)).toFixed(3));
    });
  }

  feedRows(): number {
    return this.pFeed.children.length;
  }
}
