// shared/matchphase.ts — match-start handshake shared by server, client and sim.
// OWNED BY WORKER C. Worker A (netcode/lobby) imports these; do not duplicate the
// constants anywhere else — import them from here.
//
// Handshake:
//   host presses START
//     -> server sets phase "countdown" and broadcasts StartMsg { startAt: now + COUNTDOWN_MS }
//     -> every client renders the animated 3 - 2 - 1 - GO until startAt
//     -> phase "live", input unlocks.
// Movement/fire are ignored during "pregame" and "countdown"; look/aim stays free so
// players can settle their crosshair before the gun goes hot.

export type MatchPhase = "pregame" | "countdown" | "live";

/** Total countdown duration: 3 - 2 - 1 - GO. */
export const COUNTDOWN_MS = 3200;

/** Playable seats in an FFA lobby. */
export const MAX_PLAYABLE = 10;

/** Extra connections allowed as spectators once MAX_PLAYABLE is full. */
export const MAX_SPECTATORS = 6;

/**
 * Server -> client: the match goes live at this server-clock timestamp, ms.
 *
 * WHICH CLOCK. The only server clock a client can track is the one the
 * snapshots carry — Snapshot.time, seconds, which client-side is
 * Game.svNow() (an EMA-smoothed estimate of it). So `startAt` is
 * `session.time * 1000 + COUNTDOWN_MS` on the server and
 * `startAt - svNow() * 1000` on the client. It is NOT Date.now(): the two
 * machines' wall clocks are unrelated and nothing in this protocol ever
 * reconciles them. (The client normalises an obviously-wall-clock value rather
 * than counting to a date in 1970 — see Game.armCountdown — but the contract is
 * the snapshot clock.)
 */
export type StartMsg = { t: "start"; startAt: number };

// ---------------------------------------------------------------------------
// Beat layout — shared so the visuals, the audio and the tests all agree about
// what "beat 2" means and when it starts.
// ---------------------------------------------------------------------------

/** Numeral beats before GO: 3, 2, 1. */
export const COUNTDOWN_BEATS = 3;

/**
 * One numeral beat, ms. The three numerals fill the WHOLE countdown
 * (3 x 1066.67 = 3200), which is why this divides by the numeral count and not
 * by numerals+1: "GO" is not one of the beats you wait through, it is the card
 * that lands ON the instant the yard goes live and lingers GO_MS past it while
 * you are already moving.
 */
export const BEAT_MS = COUNTDOWN_MS / COUNTDOWN_BEATS;

/** How long the GO card stays up AFTER the match is live, ms. */
export const GO_MS = 900;

/**
 * Which beat is on screen `msRemaining` ms before startAt.
 *   3 / 2 / 1  the numerals
 *   0          the GO card (msRemaining is negative here: it plays after start)
 *  -1          nothing, the card is done
 */
export function beatAt(msRemaining: number): number {
  if (msRemaining > 0) return Math.min(COUNTDOWN_BEATS, Math.ceil(msRemaining / BEAT_MS));
  if (msRemaining > -GO_MS) return 0;
  return -1;
}

/** Milliseconds this beat has been on screen, given the same `msRemaining`. */
export function beatElapsed(msRemaining: number): number {
  const b = beatAt(msRemaining);
  if (b <= 0) return -msRemaining;
  return b * BEAT_MS - msRemaining;
}

/** How long the current beat lasts, ms (the GO card is its own length). */
export function beatDuration(msRemaining: number): number {
  return beatAt(msRemaining) > 0 ? BEAT_MS : GO_MS;
}

/** True while the countdown card (numerals or GO) should be on screen. */
export function countdownVisible(msRemaining: number): boolean {
  return beatAt(msRemaining) >= 0;
}

/** True when movement + firing are locked. Look/aim is never locked. */
export function inputLocked(phase: MatchPhase): boolean {
  return phase !== "live";
}
