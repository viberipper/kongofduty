/**
 * shared/gungame.ts — GUN GAME: every operator for themselves, one gun at a
 * time. Every kill counts toward the next gun on the ladder; the first operator
 * to finish the last rung wins. A knife kill also knocks the victim back one
 * kill (humiliation). The sim (shared/sim.ts) owns the rules; the HUD, menu and
 * endcard read the numbers from here.
 */
export const GUN_LADDER = ["smg", "ar", "sniper", "pistol"] as const;
export const GUN_KILLS_PER_TIER = 3;
/** Kills that finish the ladder and win the match. */
export const GUN_GOAL = GUN_LADDER.length * GUN_KILLS_PER_TIER;
/** KILLS PER GUN is a setting (CS2's Arms Race knob) — the host's in a lobby, yours vs bots. */
export const GUN_KILL_OPTIONS = [1, 2, 3, 5] as const;

/** Whatever the wire or storage says, as a legal kills-per-gun (default 3). */
export function asGunKills(x: unknown): number {
  return (GUN_KILL_OPTIONS as readonly number[]).includes(x as number) ? (x as number) : GUN_KILLS_PER_TIER;
}

/** Ladder progress that wins, for `per` kills per gun. */
export function gunGoal(per = GUN_KILLS_PER_TIER): number {
  return GUN_LADDER.length * per;
}

/** The gun a body holds at ladder progress `level` (0..gunGoal(per)). */
export function gunFor(level: number, per = GUN_KILLS_PER_TIER): string {
  const tier = Math.floor(Math.max(0, level) / per);
  return GUN_LADDER[Math.min(GUN_LADDER.length - 1, tier)]!;
}
