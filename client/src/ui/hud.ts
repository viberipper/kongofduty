/**
 * client/src/ui/hud.ts — the per-frame HUD paint (Game.onHud → paintHud).
 *
 * Reads the game's HudState for the match (score, clock, roster, own body)
 * and client/src/hud-api.ts readHudFeed() for the weapon/lethal readout the
 * weapons code publishes (two-slot weapon, reload progress, spread, scope,
 * frag count + cook). When the feed is empty (a build where the weapons code
 * has not wired it yet) it falls back to the body's own ammo fields, so the
 * HUD is never blank.
 *
 * Team identity is RELATIVE everywhere: your team blue, the enemy red. Labels
 * come from shared/modes.ts. Every DOM write is change-gated: this runs at the
 * display rate.
 */
import { WEAPON_BY_ID } from "@shared/weapons";
import { WEAPON_CARDS, type LoadoutWeaponId } from "@shared/loadout";
import { modeInfo, type ModeId } from "@shared/modes";
import type { Game, HudState } from "../game";
import { readHudFeed } from "../hud-api";
import { attachSpectate, detachSpectate } from "../spectate";
import { paintRoundStrip } from "../roundstrip";
import { lobbyOnScreen, spectating } from "../lobby";
import { activePad } from "./gamepad";
import { prefs } from "./prefs";
import { mapLabel } from "./flow";
import { uiSfx } from "./sfx";

const $ = (id: string): HTMLElement | null => document.getElementById(id);
const cache = new Map<string, string>();

function text(id: string, v: string): void {
  if (cache.get("t:" + id) === v) return;
  cache.set("t:" + id, v);
  const el = $(id);
  if (el) el.textContent = v;
}
function style(id: string, prop: string, v: string): void {
  const k = `s:${id}:${prop}`;
  if (cache.get(k) === v) return;
  cache.set(k, v);
  const el = $(id);
  if (el) el.style.setProperty(prop, v);
}
function cls(id: string, c: string, on: boolean): void {
  const k = `c:${id}:${c}`;
  const v = on ? "1" : "0";
  if (cache.get(k) === v) return;
  cache.set(k, v);
  $(id)?.classList.toggle(c, on);
}
function show(id: string, on: boolean): void {
  cls(id, "hidden", !on);
}

/** Edge state for the bench POV and the dead-for-the-round team POV. */
let povWas = false;
let deadPovWas = false;
/** Has this match ever had the pointer? (first-click hint vs pause menu) */
export const hudState = { everLocked: false, paused: false };

export function resetHud(): void {
  lastAlive = "";
  lastTick = -1;
  povWas = false;
  deadPovWas = false;
  hudState.everLocked = false;
  cache.clear();
}

/** The bench seat attaches before the first frame (main.ts deploy). */
export function markBenchAttached(): void {
  povWas = true;
}

const mmss = (s: number): string => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function paintHud(game: Game, s: HudState, mapId: string): void {
  // A SPECTATOR'S HUD MUST NOT LIE: no gun, no mag, no frags on the bench.
  const bench = spectating();
  show("weapon-hud", !bench);
  show("hpbar", !bench);
  show("cross", !bench);
  if (bench !== povWas) {
    povWas = bench;
    if (bench) attachSpectate(game);
    else detachSpectate(game);
  }
  // DEAD FOR THE ROUND (one-life rounds): team-only spectate until respawn.
  if (!bench) {
    const dead = game.deadSpectate;
    if (dead !== deadPovWas) {
      deadPovWas = dead;
      const me = s.players.find((p) => p.id === game.you);
      if (dead && me) attachSpectate(game, { team: me.team });
      else detachSpectate(game);
    }
  }

  const mode = (s.mode === "ffa" ? "ffa" : "tdm") as ModeId;
  const info = modeInfo(mapId, mode);
  if (s.locked) hudState.everLocked = true;

  // ---- scorebug -----------------------------------------------------------
  cls("scorebug", "ffa", mode === "ffa");
  let a = 0;
  let b = 0;
  let la = "YOUR TEAM";
  let lb = "ENEMY";
  if (mode === "ffa") {
    const others = s.players.filter((p) => p.id !== s.you).sort((x, y) => y.kills - x.kills);
    if (bench) {
      const board = [...s.players].sort((x, y) => y.kills - x.kills);
      a = board[0]?.kills ?? 0;
      b = board[1]?.kills ?? 0;
      la = `1ST · ${board[0]?.name ?? "—"}`;
      lb = `2ND · ${board[1]?.name ?? "—"}`;
    } else {
      a = s.me.kills;
      b = others[0]?.kills ?? 0;
      la = "YOU";
      lb = others[0] ? `LEADER · ${others[0].name}` : "LEADER";
    }
  } else {
    const mine = s.me.team === 1 ? 1 : 0;
    a = mine === 0 ? s.score0 : s.score1;
    b = mine === 0 ? s.score1 : s.score0;
  }
  // WINNING / LOSING / TIED — the word CoD puts beside the clock.
  const st = a > b ? "win" : a < b ? "lose" : "tie";
  // FFA: your PLACE (CoD prints 1ST / 2ND…); teams: WINNING / LOSING / TIED.
  const place = 1 + s.players.filter((p) => p.id !== s.you && p.kills > s.me.kills).length;
  const ord = (n: number): string => n + (["TH", "ST", "ND", "RD"][n % 100 >= 11 && n % 100 <= 13 ? 0 : Math.min(n % 10, 4) % 4] ?? "TH");
  text("sb-state", bench && mode === "ffa" ? "" : mode === "ffa" ? ord(place) : st === "win" ? "WINNING" : st === "lose" ? "LOSING" : "TIED");
  cls("sb-state", "win", mode === "ffa" ? place === 1 : st === "win");
  cls("sb-state", "lose", mode !== "ffa" && st === "lose");
  cls("sb-state", "tie", mode === "ffa" ? place > 1 : st === "tie");
  text("s0", String(a));
  text("s1", String(b));
  text("s0lbl", la.toUpperCase());
  text("s1lbl", lb.toUpperCase());
  style("s0bar", "width", `${Math.min(100, (a / info.limit) * 100).toFixed(1)}%`);
  style("s1bar", "width", `${Math.min(100, (b / info.limit) * 100).toFixed(1)}%`);
  text("sb-mode", info.rounds && s.round ? `ROUND ${s.round.n}/${s.round.total}` : `${info.short} · ${info.limit}`);
  text("clock", mmss(s.remain));
  cls("clock", "low", s.remain <= 30 && s.remain > 0);
  paintRoundStrip(s);
  callouts(game, s, info.rounds);

  // ---- weapon / lethal -----------------------------------------------------
  const feed = readHudFeed();
  const w = feed.weapon;
  const meW = WEAPON_BY_ID[s.me.weapon];
  const ammo = w ? w.ammo : s.me.ammo ?? 0;
  const mag = w ? w.mag : meW?.mag ?? 30;
  const reserve = w ? w.reserve : s.me.reserve ?? 0;
  const name = w ? w.name : WEAPON_CARDS[s.me.weapon as LoadoutWeaponId]?.name ?? meW?.name ?? s.me.weapon.toUpperCase();
  const wcls = w ? w.cls : WEAPON_CARDS[s.me.weapon as LoadoutWeaponId]?.cls ?? "";
  text("ammo", String(ammo));
  text("res", String(reserve));
  text("wname", name.toUpperCase());
  text("wclass", wcls.toUpperCase());
  const reloadFrac = w ? w.reloadFrac : s.me.reload > 0 && meW ? Math.min(1, Math.max(0, 1 - s.me.reload / ((s.me.ammo ?? 0) <= 0 ? meW.emptyReload : meW.reload))) : -1;
  const reloading = reloadFrac >= 0;
  cls("weapon-hud", "low", !reloading && ammo > 0 && ammo <= Math.max(1, Math.ceil(mag * 0.25)));
  cls("weapon-hud", "empty", !reloading && ammo <= 0);
  cls("weapon-hud", "reloading", reloading);
  // Mag bar: what is left of the magazine (reload progress while reloading).
  const magEl = $("wmag");
  if (magEl) {
    if (!magEl.firstChild) magEl.append(document.createElement("i"));
    const f = reloading ? reloadFrac : mag > 0 ? ammo / mag : 0;
    const i = magEl.firstChild as HTMLElement;
    const v = `${(Math.max(0, Math.min(1, f)) * 100).toFixed(1)}%`;
    if (i.style.width !== v) i.style.width = v;
  }
  const alt = w?.other;
  text("walt", alt ? `${alt.name.toUpperCase()} ${alt.ammo}/${alt.reserve}` : "");
  // Lethal: the feed when wired, the body's frag count otherwise.
  const lethal = feed.lethal;
  const nades = lethal ? lethal.count : s.me.nades ?? 0;
  const cooking = !!lethal?.cooking;
  cls("wlethal", "cooking", cooking);
  cls("wlethal", "empty", nades <= 0);
  if (lethal) {
    // One pip per frag the kit can carry (weapons stream: NADE_AMMO).
    const box = $("nades");
    if (box && box.childElementCount !== lethal.max) {
      box.replaceChildren(...Array.from({ length: Math.max(1, lethal.max) }, () => document.createElement("i")));
    }
    const pips = box?.querySelectorAll("i");
    pips?.forEach((p, i) => p.classList.toggle("spent", i >= nades));
    if (cooking) style("wfuse", "--fuse", (lethal.fuseLeft / Math.max(0.01, lethal.fuseMax)).toFixed(3));
  }

  // ---- reload bar ------------------------------------------------------------
  show("reloadbar", reloading && !bench);
  if (reloading) {
    const i = $("reloadbar")?.querySelector("i") as HTMLElement | null;
    if (i) i.style.width = `${(reloadFrac * 100).toFixed(1)}%`;
  }

  // ---- crosshair -------------------------------------------------------------
  // Bloom from the weapons feed (spread already includes move/ADS/fire);
  // the fallback approximates it from speed so the reticle still breathes.
  const speed = Math.hypot(s.me.vx ?? 0, s.me.vz ?? 0);
  const gap = w ? w.spreadPx : 6 + Math.min(14, speed * 2.2) + (s.me.sprint ? 6 : 0);
  style("cross", "--gap", `${Math.max(3, gap).toFixed(1)}px`);
  const ads = w ? w.ads : s.me.ads;
  cls("cross", "ads", ads > 0.6);
  cls("cross", "scoped", !!w?.scoped);

  // ---- health ----------------------------------------------------------------
  const hp = Math.max(0, s.me.hp);
  style("hp", "width", `${Math.min(100, hp).toFixed(1)}%`);
  cls("hp", "low", hp < 35);
  text("hpnum", String(Math.round(hp)));
  style("lowhp", "opacity", hp < 35 && s.me.alive && !bench ? String(Math.min(1, 0.45 + (35 - hp) / 50).toFixed(2)) : "0");

  // ---- hint ------------------------------------------------------------
  // CLICK TO PLAY is a pointer-lock prompt: with an enabled controller
  // connected the pad needs no lock, so the hint is skipped outright — no
  // first input required. Unplug mid-match and it comes back; a disabled pad
  // (SETTINGS → CONTROLS) keeps the mouse prompt.
  const padOn = prefs().padEnabled && activePad() !== null;
  show("hint", !s.locked && !padOn && !lobbyOnScreen() && !hudState.paused && !bench && !hudState.everLocked);
  text("streaks", s.me.streak >= 2 ? `KILLSTREAK ${s.me.streak}` : "");

  // ---- scoreboard (only while it is open, 4 Hz) ------------------------------
  const sb = $("scoreboard");
  if (sb && !sb.classList.contains("hidden")) paintScoreboard(sb, s, info, mapId);
}

let sbKey = "";
let sbAt = 0;

function paintScoreboard(sb: HTMLElement, s: HudState, info: ReturnType<typeof modeInfo>, mapId: string): void {
  const now = performance.now();
  if (now - sbAt < 250 && sb.childElementCount) return;
  sbAt = now;
  const cols = `<tr><th></th><th>PLAYER</th><th>KILLS</th><th>DEATHS</th><th>K/D</th><th>STREAK</th><th>PING</th></tr>`;
  const kd = (k: number, d: number): string => (d === 0 ? k.toFixed(2) : (k / d).toFixed(2));
  const row = (p: HudState["players"][number], i: number): string =>
    `<tr class="${p.id === s.you ? "you" : ""}${p.alive ? "" : " dead"}"><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${kd(p.kills, p.deaths)}</td><td>${p.streak ?? 0}</td><td class="${(p.ping ?? 0) > 150 ? "ping-bad" : ""}">${p.ping || "—"}</td></tr>`;
  const sort = (arr: HudState["players"]): HudState["players"] => [...arr].sort((x, y) => y.kills - x.kills || x.deaths - y.deaths);
  let html = `<header class="sbd-head"><b>${info.label} · ${esc(mapLabel(mapId))}</b><span>${info.goal}</span></header>`;
  if (s.mode === "ffa") {
    html += `<div class="sbd-team"><table>${cols}${sort(s.players).map(row).join("")}</table></div>`;
  } else {
    const mine = s.me.team === 1 ? 1 : 0;
    const scoreOf = (t: number): number => (t === 0 ? s.score0 : s.score1);
    const block = (team: number, label: string, side: string): string =>
      `<div class="sbd-team ${side}"><header><span>${label}</span><i>${scoreOf(team)}${info.rounds ? " ROUNDS" : ""}</i></header><table>${cols}${sort(
        s.players.filter((p) => p.team === team),
      )
        .map(row)
        .join("")}</table></div>`;
    html += block(mine, "YOUR TEAM", "ally") + block(mine === 0 ? 1 : 0, "ENEMY TEAM", "enemy");
  }
  if (html === sbKey) return;
  sbKey = html;
  sb.innerHTML = html;
}

// ---------------------------------------------------------------- callouts

let lastAlive = "";
let lastTick = -1;

/**
 * The small things CoD says out loud, derived from state the HUD already has:
 *   ELIMINATION   "LAST ONE STANDING" when you are your team's last body,
 *                 "1 ENEMY REMAINING" when theirs is down to one.
 *   ANY MODE      the clock ticks (quietly) through the final ten seconds.
 * Edge-triggered: each fires once per change, never per frame.
 */
function callouts(game: Game, s: HudState, rounds: boolean): void {
  const r = s.round;
  if (rounds && r && r.state === "live" && !spectating()) {
    const mine = s.me.team === 1 ? 1 : 0;
    const ours = mine === 0 ? r.alive0 : r.alive1;
    const theirs = mine === 0 ? r.alive1 : r.alive0;
    const key = `${r.n}:${ours}:${theirs}`;
    if (key !== lastAlive) {
      const prev = lastAlive.split(":");
      lastAlive = key;
      const sameRound = prev[0] === String(r.n);
      if (sameRound && s.me.alive && ours === 1 && Number(prev[1]) > 1 && theirs > 0) game.banner("LAST ONE STANDING", 2.2, `${theirs} ENEMY REMAINING`);
      else if (sameRound && theirs === 1 && Number(prev[2]) > 1 && ours > 0) game.banner("1 ENEMY REMAINING", 1.8);
    }
  }
  const sec = Math.ceil(s.remain);
  if (sec !== lastTick) {
    const prev = lastTick;
    lastTick = sec;
    if (prev !== -1 && sec < prev && sec <= 10 && sec > 0 && game.matchLive?.() !== false && !(r && r.state !== "live")) uiSfx("tick");
  }
}
