/**
 * THE MOVEMENT MODEL (single source of truth) — LEAF MODULE, NO IMPORTS.
 *
 * Lives here (not in shared/sim.ts) because shared/maps/*.ts pins its build
 * envelopes against these bindings (nuketown staged-drop / egress-lift /
 * reach, dust2/nuketown bounds-span and door-corridor audits) while
 * shared/sim.ts imports the active map from shared/maps/*. A value import in
 * either direction between sim.ts and maps/* is a module cycle, and with the
 * top-level await in shared/maps/index.ts in the graph esbuild wraps the
 * back-edge in `await init_sim()` INSIDE the `__esm` closure — a SyntaxError
 * that makes the server bundle unloadable (client Vite builds tolerate the
 * cycle; the esbuild server bundle does not). Both sides import from here and
 * the cycle never forms. shared/sim.ts re-exports every binding, so existing
 * `from ".../sim"` importers keep working.
 */
export const EYE = 1.62;
export const CROUCH_EYE = 1.12;
export const SLIDE_EYE = 0.72;
export const RADIUS = 0.3;
export const STAND_H = 1.74;
export const CROUCH_H = 1.18;
export const SLIDE_H = 0.82;

export const WALK = 2.65;
export const RUN = 4.35;
export const SPRINT = 5.92;
export const TAC = 6.45;
export const TAC_FUEL = 2.0;
export const CROUCH_SPD = 2.05;
export const ADS_MUL = 0.68;
export const SLIDE_TIME = 0.58;
export const GRAVITY = 20.4;
export const JUMP_V = 5.55;
export const ACCEL = 18;
export const AIR_ACCEL = 3.2;
export const FRICTION = 13;
export const SLIDE_FRIC = 2.1;
/**
 * THE MANTLE WINDOW, metres: a climbable top less than this above the feet is
 * stepped onto, never collided with (resolveCircle, groundHeight's fromY limit,
 * botBlocked, botWallPush). One binding so shared/maps/nuketown.ts pins its
 * staged-climb envelopes against the value the sim actually runs.
 */
export const MANTLE = 1.05;
/**
 * Radius the navigator validates GOALS with: the body plus a shoulder.
 * Declared up here so shared/maps/nuketown.ts pins its door-corridor audit
 * (LINK_R) against the radius the sim actually plans with.
 */
export const BOT_CLEAR_R = RADIUS + 0.14;
