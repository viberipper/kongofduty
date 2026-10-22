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

/** The gun a body holds at ladder progress `level` (0..GUN_GOAL). */
export function gunFor(level: number): string {
  const tier = Math.floor(Math.max(0, level) / GUN_KILLS_PER_TIER);
  return GUN_LADDER[Math.min(GUN_LADDER.length - 1, tier)]!;
}
