import type { Team } from "../../shared/protocol";

/**
 * PUBLIC/YARD TDM ROLLOVER — re-deal N playable bodies onto two even teams.
 *
 * Called exactly once per yard-TDM rollover, BEFORE GameSession.nextMatch()
 * so the fresh match spawns everybody on their new side. Fisher-Yates over a
 * pre-split [0…0,1…1] deck (Math.random is enough — this is matchmaking, not
 * a secret), so every deal is even and no seating pattern can repeat forever.
 *
 * SCOPE: yard ("public") TDM only. Private rooms keep host control (their
 * startMatch/shuffle own the teams); FFA/GUN are teamless. Spectators have no
 * body and are never passed in. Team changes ride the regular snapshots
 * (PlayerSnap.team → applyRoster), so the client needs no change.
 */
export function shuffledYardTeams(n: number, rand: () => number = Math.random): Team[] {
  const half = Math.floor(n / 2);
  const teams: Team[] = Array.from({ length: n }, (_, i) => (i < half ? 0 : 1) as Team);
  for (let i = teams.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [teams[i], teams[j]] = [teams[j]!, teams[i]!];
  }
  return teams;
}
