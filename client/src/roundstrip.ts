/**
 * ROUND STRIP — the "who is still standing" readout for round-based TDM.
 * ===========================================================================
 * dust2 6v6 plays one-life rounds (shared/protocol.ts RoundState), and in a
 * one-life round the number that matters is not the score, it is how many of
 * each side are still breathing. This is that number, top-centre, with the two
 * rosters under it (dead names dimmed and struck) and the round tally between:
 *
 *        4        R3 · 1–1        6
 *   YOUR TEAM names          ENEMY names   (relative: ally blue, enemy red)
 *
 * ONLY in round-based rooms. HudState.round is null everywhere else, and then
 * this element is display:none — Shipment's HUD does not gain a pixel.
 *
 * CHEAP BY CONSTRUCTION. paintHud runs every frame, so this is a string key
 * compare per frame: the roster (id/name/team/alive per body) and the round
 * numbers are folded into one key, and the DOM is only rebuilt when the key
 * changes — a death, a join, a round flip. Positions, hp and everything else
 * that changes every tick are deliberately NOT in the key.
 *
 * Created at runtime and parented into #hud like matchfeel.ts does, so it
 * inherits the HUD's z-order and hide/show, and index.html needs no line.
 */
import "./roundstrip.css";
import type { HudState } from "./game";

let root: HTMLElement | null = null;
let lastKey = "";

/** Escape a callsign for innerHTML — names come off the wire. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Wire numbers are untrusted: coerce so a hostile string can never land raw in innerHTML. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Create the DOM once, inside the HUD. Safe to call repeatedly. */
export function mountRoundStrip(hud: HTMLElement): HTMLElement {
  if (root) return root;
  root = document.getElementById("roundstrip");
  if (!root) {
    root = document.createElement("div");
    root.id = "roundstrip";
    root.className = "hidden";
    hud.appendChild(root);
  }
  return root;
}

/** Per-frame paint. Rebuilds the DOM only when the roster/alive set or the round numbers change. */
export function paintRoundStrip(s: HudState): void {
  const el = root ?? mountRoundStrip(document.getElementById("hud") as HTMLElement);
  const r = s.round;
  if (!r) {
    if (lastKey !== "") {
      lastKey = "";
      el.classList.add("hidden");
    }
    return;
  }
  // Roster sorted by name within a team so the rows do not shuffle on every
  // snapshot (server order is join order, which is stable, but a reconnect or
  // a bot refill would otherwise reorder the strip under the player's eye).
  const teams: HudState["players"][] = [[], []];
  for (const p of s.players) {
    // A spectator's own camera body rides its own snapshot (nobody else's) and
    // is not on either roster.
    if (s.spectating && p.id === s.you) continue;
    if (p.team === 0 || p.team === 1) teams[p.team].push(p);
  }
  for (const t of teams) t.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // RELATIVE, like CoD: your side on the left in blue, the enemy on the right
  // in red — never a fixed team-0/team-1 colour.
  const mine: 0 | 1 = s.me?.team === 1 ? 1 : 0;
  const theirs: 0 | 1 = mine === 0 ? 1 : 0;
  const alive = [num(r.alive0), num(r.alive1)];
  const wins = [num(r.wins0), num(r.wins1)];
  const rn = num(r.n);
  const rtotal = num(r.total);
  const key =
    `${mine}|${rn}/${rtotal}|${wins[0]}-${wins[1]}|${alive[0]}-${alive[1]}|${s.you}|` +
    teams.map((t) => t.map((p) => `${p.id}:${p.name}:${p.alive ? 1 : 0}`).join(",")).join("|");
  if (key === lastKey) return;
  lastKey = key;
  el.classList.remove("hidden");

  const names = (t: HudState["players"]) =>
    t
      .map((p) => `<i class="${p.alive ? "" : "dead"}${p.id === s.you ? " you" : ""}">${esc(p.name)}</i>`)
      .join("");
  el.innerHTML =
    `<div class="rs-side a ally"><div class="rs-head"><em>YOUR TEAM</em><b>${alive[mine]}</b></div><div class="rs-names">${names(teams[mine])}</div></div>` +
    `<div class="rs-mid"><b>ROUND ${rn}<small> / ${rtotal}</small></b><span><u class="ally">${wins[mine]}</u> – <u class="enemy">${wins[theirs]}</u></span></div>` +
    `<div class="rs-side b enemy"><div class="rs-head"><b>${alive[theirs]}</b><em>ENEMY</em></div><div class="rs-names">${names(teams[theirs])}</div></div>`;
}
