/**
 * Deck-rail shared constants (CYCLE BREAKER).
 *
 * shared/sim.ts (botLinkClear's deck-level rail-mantle re-allow) and
 * shared/maps/nuketown.ts (the balcony-vault geometry gate) must read the
 * SAME decks/tolerance/allow-height — but sim.ts <-> nuketown.ts is a module
 * cycle (nuketown pins its jump/mantle envelopes against the sim's movement
 * consts), and with the top-level await in shared/maps/index.ts in the graph
 * esbuild wraps the back-edge in `await init_sim()` INSIDE the `__esm`
 * closure — a SyntaxError that makes the server bundle unloadable. This leaf
 * module imports nothing, so both sides import from here and the cycle never
 * forms. If the gate's decks ever move, both follow together.
 */

/**
 * Deck heights the balcony rails sit on: 3.05 m west (green), 3.09 m east
 * (yellow). A promoted panel's underside must be within DECK_RAIL_TOL of one
 * of these — the gate that keeps the tall side walls and any porch/step rail
 * steel.
 */
export const DECK_RAIL_DECKS = [3.05, 3.09];
export const DECK_RAIL_TOL = 0.3;
/**
 * Deck-level gate shared with the sim (review HIGH-3): the lowest foot height
 * that still counts as "standing on a deck". shared/sim.ts botLinkClear reads
 * this binding (no magic 2.75 literal) — min deck minus the same tolerance the
 * geometry gate promotes on, so decks 3.05/3.09 pass while the top stair
 * treads at 2.65/2.68 m do not.
 */
export const DECK_RAIL_ALLOW_Y = Math.min(...DECK_RAIL_DECKS) - DECK_RAIL_TOL;
