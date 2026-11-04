/**
 * shared/cine.ts — THE MATCH-START CINEMATIC'S CLOCK (cine stream).
 * ===========================================================================
 *
 * The intro is NOT a timer that runs before the match. It is a drawing of the
 * countdown the server (or, offline, the local GameSession) already owns:
 *
 *     host presses START
 *       -> phase "countdown", startAt = now + MATCH_START_MS     (server)
 *       -> every client plays the intro as a pure function of
 *          msRemaining = startAt - svNow()                        (client)
 *       -> phase "live" at startAt, exactly as before
 *
 * so the four properties that matter hold BY CONSTRUCTION, not by care:
 *
 *   1. IT NEVER EATS LIVE MATCH TIME. The match clock is frozen for the whole
 *      countdown (server/game-server.ts resets `remain` every tick while the
 *      room is not live; GameSession.step only bleeds `remain` when live), and
 *      the intro lives entirely inside the countdown. A match is exactly
 *      matchTime() of live play whether the intro played, was skipped, or was
 *      switched off.
 *   2. NOBODY CAN BE SHOT DURING ANYONE'S INTRO. Movement and the trigger are
 *      gated on the phase (server gateCmd + sim inputLocked), every client's
 *      intro ends at or before GO (INTRO_LAND_MS > 0), and every playable body
 *      gets SPAWN_PROTECT at GO on top.
 *   3. EVERY CLIENT IS ON THE SAME FRAME OF THE SAME SHOT, because the
 *      timeline is a function of the shared startAt, not of when a page
 *      happened to start drawing. A late joiner picks the reel up mid-shot.
 *   4. SKIPPING IS LOCAL. A skip only swoops your own camera into your eyes
 *      early; it cannot move the start line.
 *
 * Round starts (round 2+ of S&D / elimination) re-arm the plain 3.2 s
 * countdown (GameSession.startRound) and play the SHORT variant inside it, so
 * round timing is untouched.
 */
import { COUNTDOWN_MS } from "./matchphase";

/** The cinematic part of a match-start countdown, before the 3-2-1 numerals. */
export const INTRO_LEAD_MS = 6800;
/** A whole match-start countdown with the intro: lead + 3-2-1 (10 s). */
export const MATCH_START_MS = INTRO_LEAD_MS + COUNTDOWN_MS;
/**
 * The push lands in your eyes ON GO (round 6: no dead letterboxed hand-over): the last intro frame is
 * the push's end, the first frame at GO is your own view with the bars snapping open on the hit.
 */
export const INTRO_LAND_MS = 0;
/** THE HERO SHOT: you, in the hero pose, on a real arc (full intro / round start). */
export const HERO_MS = 2900;
export const ROUND_HERO_MS = 2620;
/** THE PUSH from the hero shot into your eyes (a crash push on the face, cut on GO). */
export const SWOOP_MS = 560;
/** The push when a player skips: from wherever the camera is, then your own view with the count to GO. */
export const SKIP_SWOOP_MS = 450;
/** The round-start variant's push. */
export const ROUND_SWOOP_MS = 520;

/**
 * The countdown a match start arms. `intro` false gives the plain 3-2-1 (the
 * server's KONG_INTRO=0, qa harnesses that time the old card).
 */
export function matchStartMs(intro = true): number {
  return intro ? MATCH_START_MS : COUNTDOWN_MS;
}

/**
 * The client's sanity window for a StartMsg's remaining time. A countdown that
 * claims more than this is a clock disagreement, not a countdown, and falls
 * back to a plain COUNTDOWN_MS (Game.armCountdown).
 */
export function plausibleStartLeft(leftMs: number): boolean {
  return leftMs > -2000 && leftMs < MATCH_START_MS + 5000;
}

/**
 * The 3-2-1 card only exists for the last COUNTDOWN_MS. Before that the intro
 * owns the screen and the card must read "no countdown" (0), or beatAt() would
 * show a "3" for the whole flythrough.
 */
export function numeralLeft(leftMs: number): number {
  return leftMs > COUNTDOWN_MS ? 0 : leftMs;
}

export type IntroKind = "match" | "round";

export type IntroSample = {
  /** shots: the authored reel; hero: the hero shot; swoop: the push into the eyes; eyes: handed over (after a skip); off: nothing. */
  phase: "shots" | "hero" | "swoop" | "eyes" | "off";
  /** 0..1 through the hero shot (0 before it, 1 after). */
  hero: number;
  /** Seconds into the authored reel (shots phase; at the swoop it is the reel's last pose). */
  reelT: number;
  /** 0..1 progress of the swoop (1 from the eyes phase on). */
  swoop: number;
  /** Title-card envelope 0..1 (map name). */
  title: number;
  /** Mode + objective line envelope 0..1. */
  mode: number;
  /** Teams line envelope 0..1. */
  teams: number;
  /** Letterbox 0..1 (bars in, bars out with the swoop). */
  bars: number;
  /** ms since the countdown armed (the timeline's own clock). */
  elapsed: number;
};

/** Beat sheet of the full intro, ms after the countdown armed (total MATCH_START_MS). */
export const BEATS = {
  titleIn: 1000,
  /** the cards leave TOGETHER, the map name last: mode/roster finish at cardsOut, the title 250 ms later */
  titleOut: 5250,
  modeIn: 1500,
  teamsIn: 2500,
  cardsOut: 5000,
} as const;

/** Hold SPACE this long to skip (a tap, a W or the pointer-lock click never does). */
export const SKIP_HOLD_MS = 500;

/** The hero shot's length in a countdown of `totalMs` (a round start is all hero, then the push). */
export function heroMs(kind: IntroKind, totalMs: number): number {
  if (kind === "round") return Math.max(0, totalMs - INTRO_LAND_MS - ROUND_SWOOP_MS);
  return Math.min(HERO_MS, Math.max(0, totalMs - INTRO_LAND_MS - SWOOP_MS));
}

/** Reel length available for authored shots in a countdown of `totalMs` (before the hero shot). */
export function reelMs(kind: IntroKind, totalMs: number): number {
  if (kind === "round") return 0;
  return Math.max(0, totalMs - INTRO_LAND_MS - SWOOP_MS - HERO_MS);
}

const env = (e: number, a: number, b: number, fadeIn: number, fadeOut: number): number => {
  if (e < a || e > b) return 0;
  const i = Math.min(1, (e - a) / fadeIn);
  const o = Math.min(1, (b - e) / fadeOut);
  return Math.max(0, Math.min(i, o));
};

/**
 * Where the intro is, `leftMs` before GO, in a countdown that was armed for
 * `totalMs`. Pure, total, and the ONLY timeline: the client draws it, the
 * tests assert on it.
 *
 * `skippedAt` (ms remaining when the player skipped, or null) turns the rest
 * into a SKIP_SWOOP_MS swoop.
 */
export function introSample(kind: IntroKind, totalMs: number, leftMs: number, skippedAt: number | null = null): IntroSample {
  const off: IntroSample = { phase: "off", hero: 0, reelT: 0, swoop: 1, title: 0, mode: 0, teams: 0, bars: 0, elapsed: 0 };
  if (!(totalMs > 0) || leftMs <= 0 || leftMs > totalMs + 50) return off;
  const elapsed = totalMs - leftMs;
  const reel = reelMs(kind, totalMs);
  const hero = heroMs(kind, totalMs);
  const swoopMs = kind === "round" ? ROUND_SWOOP_MS : SWOOP_MS;
  const cards = kind === "match";
  const s: IntroSample = {
    phase: "shots",
    hero: 0,
    reelT: Math.min(elapsed, reel) / 1000,
    swoop: 0,
    title: cards ? env(elapsed, BEATS.titleIn, BEATS.titleOut, 380, 520) : 0,
    mode: cards ? env(elapsed, BEATS.modeIn, BEATS.cardsOut, 420, 520) : 0,
    teams: cards ? env(elapsed, BEATS.teamsIn, BEATS.cardsOut, 420, 520) : 0,
    bars: 1,
    elapsed,
  };
  // A skip: the swoop starts from wherever the camera was, and is short.
  if (skippedAt !== null && leftMs <= skippedAt) {
    const u = Math.min(1, (skippedAt - leftMs) / SKIP_SWOOP_MS);
    // never land later than the authored land beat would have
    s.reelT = Math.min(totalMs - skippedAt, reel) / 1000;
    s.title = s.mode = s.teams = 0;
    s.swoop = u;
    s.phase = u >= 1 ? "eyes" : "swoop";
    s.bars = 1 - u;
    return s;
  }
  if (elapsed >= reel + hero) {
    // THE PUSH: ends ON GO (the bars stay: they snap open on the GO frame itself)
    const u = Math.min(1, (elapsed - reel - hero) / swoopMs);
    s.hero = 1;
    s.swoop = u;
    s.phase = u >= 1 ? "eyes" : "swoop";
    if (s.phase === "eyes") s.bars = 0;
  } else if (elapsed >= reel) {
    s.phase = "hero";
    s.hero = hero > 0 ? (elapsed - reel) / hero : 1;
  }
  if (elapsed < 450 && kind === "match") s.bars = elapsed / 450;
  else if (kind === "round" && elapsed < 250) s.bars = elapsed / 250;
  return s;
}

/** ms remaining at which the camera is back in the player's eyes (for tests and QA): GO itself. */
export function landsAtLeft(kind: IntroKind, totalMs: number): number {
  const swoopMs = kind === "round" ? ROUND_SWOOP_MS : SWOOP_MS;
  return totalMs - reelMs(kind, totalMs) - heroMs(kind, totalMs) - swoopMs;
}

/**
 * Which variant a fresh countdown gets. A countdown long enough to carry the
 * lead is a match start; a plain one is a round start in a round-based room,
 * or (an old server) a plain match start that still gets the short swoop.
 */
export function introKindFor(totalMs: number): IntroKind {
  return totalMs > COUNTDOWN_MS + 600 ? "match" : "round";
}
