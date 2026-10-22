/**
 * client/src/ui/endcard.ts — END OF MATCH. VICTORY / DEFEAT / DRAW, the
 * leaderboard, the player's own line and the match accolades.
 *
 * The result is computed HERE from the final scores and the board, from this
 * player's side — a draw is a DRAW (it used to print as a win: `s0 >= s1`).
 *
 * What happens next depends on where the match was played, and the card says
 * so instead of offering one RETURN that abandoned everything:
 *   bots   PLAY AGAIN / MAIN MENU
 *   lobby  the server puts the room back in its lobby after LOBBY_RETURN_MS —
 *          a countdown says "RETURNING TO LOBBY", LEAVE is the way out
 *   yard   the public match rolls into the next one — "NEXT MATCH IN", LEAVE
 */
import type { EndRow } from "../game";
import { RESULT_LABEL, modeInfo, type MatchResult, type ModeId } from "@shared/modes";
import { mapLabel } from "./flow";
import { uiSfx, wireSfx } from "./sfx";

export type EndKind = "bots" | "lobby" | "yard";

export interface EndParams {
  mode: ModeId;
  map: string;
  s0: number;
  s1: number;
  board: EndRow[];
  kind: EndKind;
  /** Seconds until the server moves on (lobby return / next public match). */
  nextIn?: number;
  onPlayAgain?: () => void;
  onMenu: () => void;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
let timer = 0;

/**
 * ENDCARD FIT (F11-fullscreen fix). The card's intrinsic height (168tu title +
 * podium + capped board + side + actions ≈ 1140tu) exceeds the 1080tu a 16:9
 * viewport offers, so at large viewports the buttons clip — and with
 * place-items:center and no overflow even the top is unreachable. Small
 * (windowed) viewports fit thanks to the px floors, which is why windowed
 * looked fine. Shrink-only zoom on .ec-inner keeps the whole card visible at
 * any viewport; it never grows and never touches anything else (HUD scale
 * etc. are unaffected).
 */
function fitEndcard(): void {
  const card = $("endcard");
  if (card.classList.contains("hidden")) return;
  const inner = card.querySelector(".ec-inner") as HTMLElement | null;
  if (!inner) return;
  inner.style.removeProperty("zoom");
  const avail = card.clientHeight - 16;
  const need = inner.offsetHeight;
  if (need > 0 && avail > 0 && need > avail) inner.style.setProperty("zoom", String(avail / need));
}
window.addEventListener("resize", fitEndcard);
// Webfonts (Barlow/Inter, display:swap) can swap in AFTER the rAF-measured
// fit in showEndcard, leaving it measured with fallback metrics — re-fit once
// they settle. Guarded (no Document.fonts in old browsers): the optional
// chain no-ops there. One-shot promise, no listener, no loop.
if (document.fonts?.ready) document.fonts.ready.then(() => fitEndcard(), () => {});

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const ord = (n: number): string => {
  const s = ["TH", "ST", "ND", "RD"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0])!;
};
const kdOf = (k: number, d: number): string => (d === 0 ? k.toFixed(2) : (k / d).toFixed(2));

/** What ranks a teamless board: GUN GAME's ladder, otherwise kills. */
const ptsOf = (mode: ModeId, r: EndRow): number => (mode === "gun" ? (r.gun ?? 0) : r.kills);

export function computeResult(p: Pick<EndParams, "mode" | "s0" | "s1" | "board">): { result: MatchResult; mine: number; theirs: number; place: number; of: number } {
  const me = p.board.find((r) => r.you);
  if (p.mode !== "tdm") {
    const sorted = [...p.board].sort((a, b) => ptsOf(p.mode, b) - ptsOf(p.mode, a));
    const top = sorted[0] ? ptsOf(p.mode, sorted[0]) : 0;
    const myK = me ? ptsOf(p.mode, me) : 0;
    const atTop = sorted.filter((r) => ptsOf(p.mode, r) === top).length;
    const place = 1 + p.board.filter((r) => ptsOf(p.mode, r) > myK).length;
    const result: MatchResult = myK === top && (atTop > 1 || top === 0) ? "draw" : myK === top ? "victory" : "defeat";
    return { result, mine: myK, theirs: top, place, of: p.board.length };
  }
  const team = me?.team ?? 0;
  const mine = team === 0 ? p.s0 : p.s1;
  const theirs = team === 0 ? p.s1 : p.s0;
  const result: MatchResult = mine > theirs ? "victory" : mine < theirs ? "defeat" : "draw";
  return { result, mine, theirs, place: 0, of: p.board.length };
}

export function hideEndcard(): void {
  if (timer) clearInterval(timer);
  timer = 0;
  const card = $("endcard");
  card.classList.add("hidden");
  (card.querySelector(".ec-inner") as HTMLElement | null)?.style.removeProperty("zoom");
  document.body.classList.remove("match-over");
}

export function showEndcard(p: EndParams): MatchResult {
  const card = $("endcard");
  wireSfx(card);
  const info = modeInfo(p.map, p.mode);
  const r = computeResult(p);
  card.classList.remove("hidden", "is-victory", "is-defeat", "is-draw");
  card.classList.add(`is-${r.result}`);
  document.body.classList.add("match-over");
  $("ec-eyebrow").textContent = `${info.label} · ${mapLabel(p.map)}`;
  $("endtitle").textContent = RESULT_LABEL[r.result];
  // WHY it ended — the line CoD prints under the result.
  const hitLimit = Math.max(r.mine, r.theirs) >= info.limit;
  $("ec-reason").textContent = info.rounds ? (hitLimit ? "ROUND LIMIT REACHED" : "FINAL ROUND PLAYED") : hitLimit ? "SCORE LIMIT REACHED" : "TIME LIMIT REACHED";

  // Score line: your side first, in your colour.
  const score = $("endscore");
  score.replaceChildren();
  if (p.mode !== "tdm") {
    score.append(h("span", undefined, `${ord(r.place)}`), h("small", undefined, p.mode === "gun" ? `OF ${r.of} · LADDER ${r.mine}/${info.limit}` : `OF ${r.of} · ${r.mine} KILLS`));
  } else {
    const mid = h("small", undefined, info.rounds ? "ROUNDS" : "VS");
    score.append(h("span", "ally", String(r.mine)), mid, h("span", "enemy", String(r.theirs)));
  }

  paintPodium(p, info.mode === "gun" ? `/${info.limit}` : "");

  // Leaderboard.
  const board = $("endboard");
  board.replaceChildren();
  board.classList.remove("teams");
  const head = (): HTMLElement => {
    const row = h("div", "eb-row eb-head");
    row.append(h("span", "eb-rank", "#"), h("span", "eb-name", "PLAYER"), h("span", undefined, "K"), h("span", undefined, "D"), h("span", undefined, "K/D"));
    return row;
  };
  const line = (x: EndRow, i: number): HTMLElement => {
    const row = h("div", `eb-row${x.you ? " you" : ""}`);
    row.append(h("span", "eb-rank", String(i + 1)), h("span", "eb-name", x.name), h("span", undefined, String(x.kills)), h("span", undefined, String(x.deaths)), h("span", undefined, kdOf(x.kills, x.deaths)));
    return row;
  };
  const sorted = (rows: EndRow[]): EndRow[] => [...rows].sort((a, b) => ptsOf(p.mode, b) - ptsOf(p.mode, a) || b.kills - a.kills || a.deaths - b.deaths);
  // EVERY PLAYER IS ON THE BOARD (feel stream). It used to cap at 12 FFA rows and
  // clip the panel, so 15-player dust2 FFA hid three people — usually including
  // the one reading it. A long board goes COMPACT (shorter rows) and, past what
  // even that fits, scrolls inside the panel; nobody is ever cut.
  const biggest = p.mode !== "tdm" ? p.board.length : Math.max(p.board.filter((x) => x.team === 0).length, p.board.filter((x) => x.team === 1).length);
  board.classList.toggle("dense", biggest > (p.mode !== "tdm" ? 10 : 8));
  if (p.mode !== "tdm") {
    const block = h("div", "eb-block");
    block.append(head(), ...sorted(p.board).map(line));
    board.append(block);
  } else {
    board.classList.add("teams");
    const myTeam = p.board.find((x) => x.you)?.team ?? 0;
    for (const [team, side, label, sc] of [
      [myTeam, "ally", "YOUR TEAM", r.mine],
      [myTeam === 0 ? 1 : 0, "enemy", "ENEMY TEAM", r.theirs],
    ] as const) {
      const block = h("div", "eb-block");
      const t = h("div", `eb-team ${side}`);
      t.append(h("span", undefined, label), h("span", undefined, String(sc)));
      block.append(t, head(), ...sorted(p.board.filter((x) => x.team === team)).map(line));
      board.append(block);
    }
  }

  // Your line + accolades.
  const side = $("ec-side");
  side.replaceChildren();
  const me = p.board.find((x) => x.you);
  if (me) {
    side.append(h("p", "eyebrow", "YOUR MATCH"));
    const st = h("div", "ec-stat");
    for (const [k, v] of [
      ["KILLS", String(me.kills)],
      ["DEATHS", String(me.deaths)],
      ["K/D", kdOf(me.kills, me.deaths)],
    ]) {
      const c = h("div");
      c.append(h("span", "eyebrow", k), h("b", undefined, v));
      st.append(c);
    }
    side.append(st);
  }
  const acc = accolades(p.board);
  if (acc.length) {
    side.append(h("p", "eyebrow", "ACCOLADES"));
    for (const a of acc) {
      const row = h("div", "ec-acc");
      const ico = h("i");
      ico.append(h("em", undefined, a.glyph));
      row.append(ico, h("b", undefined, `${a.title}${a.you ? " · YOU" : ""}`), h("span", undefined, `${a.name} · ${a.stat}`));
      side.append(row);
    }
  }

  // What happens next.
  const actions = $("ec-actions");
  actions.replaceChildren();
  if (timer) clearInterval(timer);
  timer = 0;
  if (p.kind === "bots") {
    const again = h("button", "btn btn--primary", "PLAY AGAIN");
    again.type = "button";
    again.dataset.sfx = "confirm";
    again.addEventListener("click", () => p.onPlayAgain?.());
    const menu = h("button", "btn", "MAIN MENU");
    menu.type = "button";
    menu.dataset.sfx = "back";
    menu.addEventListener("click", () => p.onMenu());
    actions.append(again, menu);
    requestAnimationFrame(() => again.focus({ preventScroll: true }));
  } else {
    const count = h("div", "ec-count");
    const lbl = p.kind === "lobby" ? "RETURNING TO LOBBY" : "NEXT MATCH IN";
    const num = h("b");
    count.append(h("span", "dot dot--pulse"), document.createTextNode(lbl + " "), num);
    const leave = h("button", "btn", p.kind === "lobby" ? "LEAVE LOBBY" : "LEAVE");
    leave.type = "button";
    leave.dataset.sfx = "back";
    leave.addEventListener("click", () => p.onMenu());
    actions.append(count, leave);
    const until = Date.now() + Math.max(1, p.nextIn ?? 11) * 1000;
    let last = -1;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (left !== last) {
        last = left;
        num.textContent = left > 0 ? `0:${String(left).padStart(2, "0")}` : "…";
        if (left > 0 && left <= 3) uiSfx("tick");
      }
    };
    tick();
    timer = window.setInterval(tick, 200);
  }
  uiSfx(r.result === "victory" ? "confirm" : "back");
  fitEndcard();
  requestAnimationFrame(fitEndcard);
  return r.result;
}

/**
 * THE MVP PODIUM: the match's top three on stepped plinths, 2nd · 1st · 3rd,
 * each in their own fur colour, the winner crowned MVP. Teamless modes rank
 * the way the board does (GUN GAME by the ladder); team modes rank everyone
 * on one list by kills, then fewest deaths — the MVP can come off the losing
 * side, as in CoD.
 */
function paintPodium(p: EndParams, outOf: string): void {
  const pod = $("ec-podium");
  pod.replaceChildren();
  const ranked = [...p.board]
    .sort((a, b) => ptsOf(p.mode, b) - ptsOf(p.mode, a) || b.kills - a.kills || a.deaths - b.deaths)
    .slice(0, 3);
  pod.classList.toggle("hidden", !ranked.length || ptsOf(p.mode, ranked[0]!) <= 0);
  const myTeam = p.board.find((x) => x.you)?.team ?? 0;
  for (const place of [2, 1, 3]) {
    const r = ranked[place - 1];
    if (!r) continue;
    const side = p.mode === "tdm" ? (r.team === myTeam ? " ally" : " enemy") : "";
    const col = h("div", `pod pod-${place}${r.you ? " you" : ""}${side}`);
    col.style.animationDelay = `${(3 - place) * 140 + 200}ms`;
    const fur = h("i", "pod-fur");
    fur.style.background = "#3b2218";   // the Kong fur colour
    const name = h("b", "pod-name", r.name);
    const stat =
      p.mode === "gun" ? `LADDER ${r.gun ?? 0}${outOf} · ${r.kills} K` : `${r.kills} KILL${r.kills === 1 ? "" : "S"} · ${kdOf(r.kills, r.deaths)} K/D`;
    const step = h("div", "pod-step");
    step.append(h("span", "pod-rank", ord(place)));
    if (place === 1) col.append(h("em", "pod-mvp", "MVP"));
    col.append(fur, name, h("span", "pod-stat", stat), step);
    pod.append(col);
  }
}

function accolades(board: EndRow[]): { title: string; glyph: string; name: string; stat: string; you: boolean }[] {
  if (!board.length) return [];
  const out: { title: string; glyph: string; name: string; stat: string; you: boolean }[] = [];
  const byK = [...board].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0]!;
  if (byK.kills > 0) out.push({ title: "MOST KILLS", glyph: "K", name: byK.name, stat: `${byK.kills} KILL${byK.kills === 1 ? "" : "S"}`, you: byK.you });
  const played = board.filter((r) => r.kills + r.deaths > 0);
  const byKd = [...played].sort((a, b) => b.kills / Math.max(1, b.deaths) - a.kills / Math.max(1, a.deaths))[0];
  if (byKd && byKd.kills > 0 && byKd !== byK) out.push({ title: "BEST K/D", glyph: "%", name: byKd.name, stat: `${kdOf(byKd.kills, byKd.deaths)} K/D`, you: byKd.you });
  const byD = [...played].filter((r) => r.kills > 0).sort((a, b) => a.deaths - b.deaths || b.kills - a.kills)[0];
  if (byD && !out.some((o) => o.name === byD.name)) out.push({ title: "FEWEST DEATHS", glyph: "D", name: byD.name, stat: `${byD.deaths} DEATH${byD.deaths === 1 ? "" : "S"}`, you: byD.you });
  return out.slice(0, 3);
}
