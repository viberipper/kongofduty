/**
 * shared/modes.ts — WHAT EACH PLAYABLE CONFIGURATION ACTUALLY IS.
 * ===========================================================================
 *
 * THE single source of truth for every mode label, team size, limit and rules
 * line the player reads — menu tiles, the private-match card, the lobby
 * header, the loading screen, the HUD scorebug, the scoreboard and the
 * endcard all read from here. Nothing in the UI may spell a mode, a team size
 * or a limit on its own: that is how the game ended up with "ORBITAL 6v6" on
 * an FFA lobby, "3v3" lobbies next to 5v5 bot matches, and one-life rounds
 * labelled plain TEAM DEATHMATCH.
 *
 * The numbers are not restated, they are IMPORTED from the constants the sim
 * and the server run on (shared/protocol.ts, shared/matchphase.ts). The seat
 * table below is the one place seats live: server/game-server.ts getRoom()
 * and the offline bot fill in client/src/game.ts both read `seatsFor()`, so a
 * lobby, a public match and a bot match on the same map/mode are always the
 * same size.
 *
 * ADDING A MAP: one entry in MAP_SEATS (and one in client/src/ui/map-cards.ts
 * for its card art). A map with no entry gets DEFAULT_SEATS (6v6 / 12 FFA).
 */
import { MAX_PLAYABLE } from "./matchphase";
import {
  DUST2_FFA_SEATS,
  DUST2_TDM_SEATS,
  FFA_KILL_LIMIT,
  TDM_MATCH_TIME,
  FFA_MATCH_TIME,
  matchTimeFor,
  ROUND_MAPS,
  ROUND_TIME,
  ROUNDS_TO_WIN,
  ROUNDS_TOTAL,
  scoreLimit,
} from "./protocol";

import { GUN_GOAL, GUN_KILLS_PER_TIER, GUN_LADDER } from "./gungame";

/** `gun` is GUN GAME: an FFA room whose guns come off the ladder (shared/gungame.ts). */
export type ModeId = "tdm" | "ffa" | "gun";

/** The sim's own mode for a menu mode: GUN GAME plays as FFA with the ladder switched on. */
export function simMode(mode: ModeId): "tdm" | "ffa" {
  return mode === "tdm" ? "tdm" : "ffa";
}

/** Whatever the transport says, as a ModeId (unknown -> TDM). */
export function asModeId(x: unknown): ModeId {
  return x === "ffa" || x === "gun" ? x : "tdm";
}

/** Playable seats (humans + bot fill) per mode on one map. TDM seats split evenly. */
export interface MapSeats {
  tdm: number;
  ffa: number;
}

/**
 * SEATS PER MAP — every room, lobby or offline match on that map uses these.
 *
 * Shipment: 5v5 / 10 FFA. It used to seat 3v3 in a created team lobby, 5v5 in
 * an offline bot match and 4v4 + humans on the public yard — three different
 * games under one label. 10 is the yard's MAX_PLAYABLE, so every Shipment
 * room is now the same ten bodies.
 */
export const MAP_SEATS: Record<string, MapSeats> = {
  shipment: { tdm: MAX_PLAYABLE, ffa: MAX_PLAYABLE },
  dust2: { tdm: DUST2_TDM_SEATS, ffa: DUST2_FFA_SEATS },
  ares: { tdm: 12, ffa: 12 },
  nuketown: { tdm: 12, ffa: 12 },
};

/** A map with no entry (a new map before its row lands) plays CoD-standard 6v6. */
export const DEFAULT_SEATS: MapSeats = { tdm: 12, ffa: 12 };

export function seatsFor(map: string, mode: ModeId): number {
  const s = MAP_SEATS[map] ?? DEFAULT_SEATS;
  return mode === "tdm" ? s.tdm : s.ffa;
}

/** The most bodies any mode on this map can field — renderer pre-warm budgets. */
export function maxSeats(map: string): number {
  const s = MAP_SEATS[map] ?? DEFAULT_SEATS;
  return Math.max(s.tdm, s.ffa);
}

/** One-life rounds? Mirrors shared/protocol.ts isRoundBased (same ROUND_MAPS). */
export function roundBased(map: string, mode: ModeId): boolean {
  return mode === "tdm" && ROUND_MAPS.includes(map);
}

/** Everything a screen needs to describe one map + mode, all derived. */
export interface ModeInfo {
  map: string;
  mode: ModeId;
  /** "TEAM DEATHMATCH" | "FREE-FOR-ALL" | "ELIMINATION" | "GUN GAME" */
  label: string;
  /** Short tag for tight spaces: "TDM" | "FFA" | "ELIM" | "GUN" */
  short: string;
  /** "5v5", "6v6", or "10 PLAYERS" */
  size: string;
  seats: number;
  teamSize: number;
  teams: boolean;
  rounds: boolean;
  /** One-line rules, true to the sim. */
  rules: string;
  /** Win condition line for the lobby card / loading screen. */
  goal: string;
  /** Score limit (team kills, FFA kills, or rounds to win). */
  limit: number;
  /** Seconds on the clock: the match clock, or the per-round clock. */
  clock: number;
  /** What the two scorebug numbers count. */
  unit: "KILLS" | "ROUNDS";
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function modeInfo(map: string, mode: ModeId): ModeInfo {
  const seats = seatsFor(map, mode);
  const rounds = roundBased(map, mode);
  if (mode === "gun") {
    return {
      map,
      mode,
      label: "GUN GAME",
      short: "GUN",
      size: `${seats} PLAYERS`,
      seats,
      teamSize: 1,
      teams: false,
      rounds: false,
      rules: `Every kill hands you the next gun: ${GUN_LADDER.map((g) => g.toUpperCase()).join(" → ")}, ${GUN_KILLS_PER_TIER} kills each. Finish the ladder to win. A knife kill knocks your victim back one.`,
      goal: `FINISH THE LADDER · ${GUN_GOAL} KILLS · ${mmss(matchTimeFor("ffa"))}`,
      limit: GUN_GOAL,
      clock: matchTimeFor("ffa"),
      unit: "KILLS",
    };
  }
  if (mode === "ffa") {
    return {
      map,
      mode,
      label: "FREE-FOR-ALL",
      short: "FFA",
      size: `${seats} PLAYERS`,
      seats,
      teamSize: 1,
      teams: false,
      rounds: false,
      rules: `Every operator for themselves. First to ${FFA_KILL_LIMIT} kills, or the most kills when ${mmss(FFA_MATCH_TIME)} runs out.`,
      goal: `FIRST TO ${FFA_KILL_LIMIT} KILLS · ${mmss(FFA_MATCH_TIME)}`,
      limit: FFA_KILL_LIMIT,
      clock: FFA_MATCH_TIME,
      unit: "KILLS",
    };
  }
  const teamSize = Math.floor(seats / 2);
  if (rounds) {
    return {
      map,
      mode,
      label: "ELIMINATION",
      short: "ELIM",
      size: `${teamSize}v${teamSize}`,
      seats,
      teamSize,
      teams: true,
      rounds: true,
      rules: `One life per round. Wipe the enemy team, or have more operators standing when the ${mmss(ROUND_TIME)} round clock ends. Best of ${ROUNDS_TOTAL}.`,
      goal: `FIRST TO ${ROUNDS_TO_WIN} ROUNDS · ONE LIFE`,
      limit: ROUNDS_TO_WIN,
      clock: ROUND_TIME,
      unit: "ROUNDS",
    };
  }
  return {
    map,
    mode,
    label: "TEAM DEATHMATCH",
    short: "TDM",
    size: `${teamSize}v${teamSize}`,
    seats,
    teamSize,
    teams: true,
    rounds: false,
    rules: `Two teams, instant respawns. First team to ${scoreLimit(map)} kills, or the most kills when ${mmss(TDM_MATCH_TIME)} runs out.`,
    goal: `FIRST TO ${scoreLimit(map)} KILLS · ${mmss(TDM_MATCH_TIME)}`,
    limit: scoreLimit(map),
    clock: TDM_MATCH_TIME,
    unit: "KILLS",
  };
}

/** "TEAM DEATHMATCH · 5v5" — the one-line headline every screen uses. */
export function modeHeadline(map: string, mode: ModeId): string {
  const m = modeInfo(map, mode);
  return `${m.label} · ${m.size}`;
}

/** The modes offered on a map, in menu order. Every map runs all three today. */
export function modesFor(map: string): ModeInfo[] {
  return (["tdm", "ffa", "gun"] as const).map((m) => modeInfo(map, m));
}

/**
 * THE PUBLIC MATCH (the server's always-on room on each map) is always the
 * map's TEAM mode — the server pins it (game-server.ts getRoom), so the label
 * on the JOIN PUBLIC tile can never disagree with the room it lands in.
 */
export const PUBLIC_MODE: ModeId = "tdm";

/** Match result from this player's point of view. */
export type MatchResult = "victory" | "defeat" | "draw";

export const RESULT_LABEL: Record<MatchResult, string> = {
  victory: "VICTORY",
  defeat: "DEFEAT",
  draw: "DRAW",
};

/**
 * WHAT HAPPENS AFTER THE ENDCARD — shared so the countdown the endcard shows
 * is the delay the server actually waits (server/game-server.ts reads these).
 *   private match  the room drops back to its pre-game lobby
 *   public match   the always-on room rolls into a fresh match
 */
// feel stream: +7 s each — the final killcam (≈4.5 s) now plays before the
// endcard (and on Nuketown the nuke opens it, ≈4 s), so the endcard keeps at
// least the read time it had before either existed.
export const LOBBY_RETURN_S = 18;
export const PUBLIC_ROLLOVER_S = 19;
