import { clamp, lerp, len2, norm2, angWrap } from "./math";
import {
  groundHeight,
  circleHitsOBB,
  vaulting,
  worldToLocal,
  localToWorld,
  traceWorld,
  type OBB,
  type Spawn,
} from "./map";
import { activeMap } from "./maps";
import { DECK_RAIL_ALLOW_Y } from "./deckrail";
import { gridQueryCircle, gridQueryRect, indexSolids, type SolidGrid } from "./solidgrid";
import { CEIL_EPS, ceilingCrossed } from "./ceiling"; // map stream: overhead contact is vertical
import {
  WEAPON_BY_ID,
  PRIMARY_WEAPON_ID,
  SECONDARY_WEAPON_ID,
  PRIMARY_WEAPON_IDS,
  bulletDamage,
  shotInterval,
  type WeaponDef,
} from "./weapons";
import { DEFAULT_LOADOUT, sanitizeLoadout, type Loadout } from "./loadout";
import { GUN_GOAL, gunFor } from "./gungame";
import { bulletPath, keepAt } from "./penetration";
import { COUNTDOWN_MS, inputLocked, type MatchPhase } from "./matchphase";
import {
  TICK_DT,
  TICK_HZ,
  SNAP_HZ,
  REWIND_MS,
  INTERP_MS,
  SPAWN_PROTECT,
  RESPITE,
  SCORE_LIMIT,
  FFA_KILL_LIMIT,
  TDM_MATCH_TIME,
  matchTimeFor,
  ROUNDS_TOTAL,
  ROUNDS_TO_WIN,
  ROUND_TIME,
  ROUND_INTERMISSION_S,
  isRoundBased,
  type RoundState,
  type InputCmd,
  type PlayerSnap,
  type NadeSnap,
  type NetEvent,
  type Team,
} from "./protocol";

/**
 * How far behind its own command a client's RENDER stamp (InputCmd.rt) is
 * allowed to sit, in ms. Beyond this the stamp is clamped, never taken.
 *
 * The stamp describes ONE thing: the snapshot-interpolation delay this client
 * draws other players at. Its honest size is INTERP_MS (80) plus whatever the
 * buffer is short by — a dropped snapshot pushes the drawn pose one 32 Hz frame
 * further back (31 ms), jitter another 40, the frame itself 17.
 *
 * THE NUMBER IS A MEASUREMENT, not a round figure. Every fire command of a full
 * five-profile qa/netlab run carries `renderLagMs` (the instrument records it
 * per shot precisely so this constant can cite evidence instead of a guess), and
 * across the meanest profile this game is measured on — 200 ms +-40 with 3%
 * snapshot loss — honest render lag came out at min 87.5, p50 92.0, p95 99.7,
 * p99 115.0, max 116.8 ms. 150 clears the worst honest frame ever produced by
 * 33 ms of headroom for a genuinely starved buffer, and stops there.
 *
 * The excess above p99 is not free, which is why it is not generous: whatever
 * this clamp allows past the honest maximum is lead a modified client can claim
 * for nothing. At 200 that was ~83 ms of forgeable lead = 0.36 m at a 4.35 m/s
 * run, more than one hit-capsule diameter; at 150 it is ~35 ms = 0.15 m, inside
 * the capsule's own radius. (It was never a hole — hitscan's REWIND_MS clamp
 * bounds total depth regardless, measured at 420 ms against a 424 ms ceiling by
 * qa/rewind-guard's ct-window gate — but hardening that costs an honest player
 * nothing is hardening worth taking.)
 *
 * This is a bound on a CLAIM, not a lie detector, and it is worth being precise
 * about why it is a clamp: any client can truthfully claim the largest legal
 * interpolation delay simply by buffering, so refusing a bigger claim outright
 * buys nothing a clamp does not — while a clamp keeps an honest client whose
 * buffer genuinely starved from being handed LESS rewind than it needs (the
 * failure mode the discard policy had: it fell back to clientTime - INTERP_MS,
 * which is a smaller rewind than the truth, i.e. a miss on a body the shooter
 * had dead centre). The real ceiling on lag compensation is REWIND_MS, which
 * hitscan() applies afterwards against the server's own clock.
 */
/* ─────────────────── THE MOVEMENT MODEL (single source of truth) ─────────────
 * Imported from shared/movement.ts (leaf, no imports): shared/maps/*.ts pins
 * its build envelopes against the same bindings (and `activeMap()` below
 * builds Nuketown during this module's own evaluation), so the consts cannot
 * live here — a sim<->maps value import is a module cycle that breaks the
 * esbuild server bundle (`await init_sim()` inside the `__esm` closure).
 * Re-exported below so existing `from ".../sim"` importers keep working.
 */
import {
  ACCEL,
  ADS_MUL,
  AIR_ACCEL,
  BOT_CLEAR_R,
  CROUCH_EYE,
  CROUCH_H,
  CROUCH_SPD,
  EYE,
  FRICTION,
  GRAVITY,
  JUMP_V,
  MANTLE,
  RADIUS,
  RUN,
  SLIDE_EYE,
  SLIDE_FRIC,
  SLIDE_H,
  SLIDE_TIME,
  SPRINT,
  STAND_H,
  TAC,
  TAC_FUEL,
  WALK,
} from "./movement";
export {
  ACCEL,
  ADS_MUL,
  AIR_ACCEL,
  BOT_CLEAR_R,
  CROUCH_EYE,
  CROUCH_H,
  CROUCH_SPD,
  EYE,
  FRICTION,
  GRAVITY,
  JUMP_V,
  MANTLE,
  RADIUS,
  RUN,
  SLIDE_EYE,
  SLIDE_FRIC,
  SLIDE_H,
  SLIDE_TIME,
  SPRINT,
  STAND_H,
  TAC,
  TAC_FUEL,
  WALK,
};

/* ───────────────────────────── THE ACTIVE MAP ───────────────────────────────
 * Resolved ONCE here, in this module's body, which is the earliest moment any
 * code in the game runs (every client entry point imports this file, directly or
 * through game.ts). Everything below that used to be a Shipment literal — the
 * collider set, the spawn pool, the nav seeds, the world floor — is read off it.
 *
 * The six derived singletons this file used to build at import time
 * (NADE_FENCE, NADE_SEAMS, NADE_SOLIDS, SOLID_BS, BOT_NAV, BOT_HOP) are still
 * built exactly once at import time; they are just built FROM `MAP` instead of
 * from whatever shared/map.ts happened to export. See shared/maps/index.ts for
 * why one-map-per-process is the shipped design and not a limitation.
 */
const MAP = activeMap();
const SOLIDS = MAP.solids;
const SPAWNS = MAP.spawns;
const WAYPOINTS = MAP.navSeeds;
/**
 * The world floor plane. Three systems used to hard-code an infinite y = 0 with
 * no OBB behind it: the player clamp in `integrate`, the bullet stop in
 * `traceWorld` and the grenade bounce in `stepNadeBody`. dust2's lowest walkable
 * floor is 3.25 m below y = 0, so a hard 0 would clamp every body in mid and B
 * tunnels up out of the map.
 */
const FLOOR_Y = MAP.floorY;
/** Nuketown-only movement rules (OOB exfil clamp): other maps never read this.
 * Module-init const — one-map-per-process by design (see shared/maps/index.ts
 * PLAN A). A harness that builds Nuketown via buildNuketown inside a process
 * whose active map is Shipment gets NO clamp from that def; the clamp belongs
 * to the Nuketown process (`?map=nuketown` / `--map=nuketown`), where the
 * import-time edge audit below has also run.
 *
 * PER-MAP OOB POLICY (security LOW-1, documented not unified): only Nuketown
 * bodies are hard-clamped into MAP.bounds here. dust2/shipment/ares stand on
 * their DATA walls alone — the frag fence (extruded floorY→nadeFenceTop,
 * itself throw-pinned at build), the degenerate-span pin, and the non-finite
 * nets — which is why those pins throw instead of warning. A map-agnostic
 * bounds net would move every map's unclamped-but-contained behaviour (and
 * the Shipment sim-equivalence hash) for a failure class no shipped map
 * exhibits outside the balcony vault this gate was written for. The asymmetry
 * is intentional and covered, not drift: the policy inputs (bounds, floorY,
 * nadeFenceTop, rails) are all inside the per-map geo hash, so a regen that
 * weakens a map's DATA walls desyncs its hash loudly instead of silently
 * inheriting another map's net. */
const IS_NUKETOWN = MAP.id === "nuketown";
/** Uniform-grid broadphase over MAP.solids — see shared/solidgrid.ts. */
const SOLID_GRID: SolidGrid = indexSolids(SOLIDS);

/**
 * The LIVE index for the collider set.
 *
 * `SOLIDS` is a module-level mutable array and the documented way to test this
 * simulation is to push synthetic boxes onto it and call `movePlayer`
 * (docs/dustmap/report-sim.md §16, and qa/lowprop-probe / qa/stuck-probe are
 * built on the same idea). The old code read the array directly, so a pushed box
 * was live immediately; an index built once at boot would silently ignore it,
 * which is the worst possible failure — a test that passes because the collider
 * it added was invisible.
 *
 * One integer compare on the hot path buys that back: same length, same index;
 * different length, rebuild. `indexSolids` caches, so the rebuild happens once
 * per mutation, not once per query.
 *
 * SAME-LENGTH STALENESS (accepted, documented — review MEDIUM): the guard is
 * length-only, so an in-place move/flag flip at the SAME length (a regen
 * retag, a test-harness `SOLIDS[i] = {...}` without push/splice) keeps serving
 * the stale grid until the length changes. The shipped game never mutates
 * colliders in place (promotion clones at build; the server never touches
 * SOLIDS post-import), and the only in-place writer is the server-local
 * test harness — which pushes synthetics (length changes) precisely so they
 * go live. A content version-stamp (per-box hash per query) would cost the
 * hot path for a writer that does not exist in production; length is the
 * contract, documented here.
 */
function solidGrid(): SolidGrid {
  return SOLID_GRID.builtLength === SOLIDS.length ? SOLID_GRID : indexSolids(SOLIDS);
}
/**
 * THE HEIGHT-CONTINUITY GATE, in metres, or null where the map is one deck.
 *
 * `botBlocked` re-derives y from `groundHeight(x, z)` at every sample and never
 * asks whether consecutive samples are on the SAME floor, so on a multi-level
 * map an edge that runs off a 3 m ledge and along the ground below reads as
 * perfectly clear — and the router then walks bots off it, every time, forever.
 * A link is rejected when the sampled floor jumps by more than this between
 * adjacent samples, UNLESS the jump is a legal step (a rise strictly inside the
 * (0.20, 1.05) m mantle window, in a consistent direction: a stair chain).
 *
 * Null on Shipment. Its only height changes are knee-high mantle props a bot is
 * SUPPOSED to walk over — a barrel top is a 0.90 m "jump" that would fail a
 * 0.5 m gate and delete a real edge. That is also what keeps the Shipment nav
 * graph, and therefore every bot route in the equivalence test, bit-identical.
 *
 * Declared up here rather than beside the nav code so it can never be read
 * during module init before it exists: BOT_NAV is built further down this file.
 */
const BOT_HEIGHT_GATE = MAP.navHeightGate;
/**
 * Does this map stack walkable surfaces? Drives whether the walker's own height
 * is threaded into `groundHeight` at runtime (see MapDef.stackedFloors and
 * `walkFromY`). False on Shipment, which is what makes the y-aware groundHeight
 * a provable no-op there rather than a probable one.
 */
const STACKED_FLOORS = MAP.stackedFloors;
/**
 * Is every climbable solid on this map a floor rather than a prop? See
 * MapDef.climbablesAreFloors for the measurement and the reason.
 *
 * Read once, into a `const`, so Shipment's `false` is a compile-time-constant
 * branch in `botBlocked`: the expression it joins collapses to the one that was
 * there before, which is what keeps `scripts/dustmap/sim-equivalence.mjs` at
 * hash d2b042f6f0d271b2.
 */
const CLIMB_IS_FLOOR = MAP.climbablesAreFloors === true;
/**
 * STOREY-AWARE NAV (Nuketown + dust2). True only when the map is stacked AND
 * its nav seeds carry a height: two houses whose ground rooms sit exactly
 * under their upstairs rooms (or dust2's terraces and tunnels), so "the
 * nearest node" and "the goal" need a y or a bot standing in the kitchen
 * anchors to the bedroom above it. Every use below is `NAV_Y && ...`, so
 * Shipment / Ares (single-deck, seeds without y) compile to the code that was
 * there before — sim-equivalence hash unchanged.
 *
 * DUST2 IS A NAV_Y MAP (review MEDIUM-1): stackedFloors defaults true and all
 * 380 shipped seeds are y-bearing, so its graph builds under the widened
 * branches below (LINK_R 0.44 + default pad 0.15 = 0.59 m corridor, 0.25 m
 * sample stride) at the shipped linkMax 12 with the lattice off (step 0 — the
 * 380 grown seeds ARE the lattice, no duplication). That configuration is the
 * validated one, and it is PINNED, not assumed: the geo hash covers seeds +
 * navLinkPad + linkMax + stackedFloors, so a regen that drops y's, widens the
 * pad past the doors, or retunes the range desyncs loudly in CI instead of
 * silently rebuilding a flat-validated edge set under storey-aware branches.
 */
const NAV_Y = MAP.stackedFloors && MAP.navSeeds.some((w) => w.y !== undefined);
/** Metres of horizontal distance one metre of height difference is worth when picking a node. */
const NAV_Y_W = 2.5;
/** Hop arrival radius on a NAV_Y map: tight, so the next leg starts on the doorway axis. */
const NAV_Y_ARRIVE = 0.4;
/** Scratch candidate buffers. One per query site: they must never alias. */
const RC_NEAR: number[] = [];
const BB_NEAR: number[] = [];
const BW_NEAR: number[] = [];
const NS_NEAR: number[] = [];
const SOLID_FOOT_BOUNDS = SOLIDS.map((o) => ({ sx: o.sx, sz: o.sz, r: Math.hypot(o.sx, o.sz) * 0.5 }));
function solidFootRadius(o: OBB, index: number): number {
  const b = SOLID_FOOT_BOUNDS[index];
  // Synthetic QA boxes and changed dimensions still use the exact live value.
  return b && b.sx === o.sx && b.sz === o.sz ? b.r : Math.hypot(o.sx, o.sz) * 0.5;
}

/** The active map's definition — instruments and the client renderer read it. */
export function simMap(): typeof MAP {
  return MAP;
}

export const MAX_RENDER_LAG = 150;

/**
 * Ceiling on SimPlayer.cmdBank — half a second of real time, the same span as
 * the seat's drain budget (server/index.ts MOVE_BANK_MAX). It has to cover the
 * longest honest stall, because WS is TCP and a delayed packet
 * head-of-line-blocks the ones behind it so the whole stall lands as one burst
 * that must be paid for out of the time the stall banked; and it has to stop
 * there, so a client that goes quiet for a minute cannot come back with a
 * minute of gun clock in hand.
 */
export const CMD_BANK = 0.5;

/**
 * Ticks per published snapshot — the sampling grid of the rewind buffer. Read
 * off the same two constants server/index.ts sends on, so the two can never
 * drift apart.
 */
const SNAP_EVERY = Math.max(1, Math.round(TICK_HZ / SNAP_HZ));

// (Movement-model constants live above the active-map block: shared/maps/
// nuketown.ts pins its envelopes against the same bindings.)

// ---------------------------------------------------------------------------
// BANANA FRAG — the thrown nana
//
// One physics kernel (stepNadeBody) is the ONLY place grenade motion exists. The
// authoritative sim advances live grenades with it; the first-person landing
// marker rolls a scratch copy of the same body through the same kernel at the
// same TICK_DT. There is no second "prediction" integrator to drift out of sync,
// so the Gears-style ring is not an estimate — it is the answer.
// ---------------------------------------------------------------------------

/** Collision sphere of the frag (the mesh is ~0.22 m long). */
export const NADE_RADIUS = 0.105;
/** Muzzle speed of an overhand throw, m/s. */
export const NADE_SPEED = 15.4;
/** Straight-up lob bias added on top of the aim direction, m/s. */
export const NADE_UP = 2.7;
/** Share of the thrower's own horizontal velocity that goes into the throw. */
export const NADE_INHERIT = 0.4;
export const NADE_GRAVITY = GRAVITY;
/**
 * Seconds of fuse from the moment the PIN IS PULLED. A frag cooks in the hand
 * (InputCmd.nadeHold) and leaves with whatever is left; hold it to zero and it
 * goes off in the hand. Thrown uncooked it flies the full fuse.
 */
export const NADE_FUSE = 3.2;
/**
 * Real-time slack on a cooking frag, seconds. The fuse burns one tick per
 * COMMAND so prediction replays it exactly — but a client that simply stops
 * sending commands with the pin out must not get to hold a live frag forever,
 * so the server also checks the wall clock and detonates it in the hand this far
 * past the fuse. One CMD_BANK of honest TCP stall fits inside it.
 */
export const NADE_COOK_SLACK = 0.35;
/** Normal restitution on a bounce (0.35 = dead-ish tactical bounce). */
export const NADE_REST = 0.35;
/** Tangential velocity kept through a bounce (scrub). */
export const NADE_TANGENT = 0.72;
/** Rolling friction on a flat surface, 1/s. */
export const NADE_ROLL_FRIC = 3.4;
/** Below this ground speed the frag settles dead — the ring must not wander. */
export const NADE_SLEEP = 0.42;
/**
 * Blast falloff: NADE_DMG_MAX at the seed down to NADE_DMG_MIN at NADE_DMG_R,
 * shaped by NADE_DMG_POW. CoD frag: lethal (>= 100) out to ~2.5 m, ~20 at the
 * 6 m rim, and line of sight to the body (blastSees) — a wall is real cover.
 *   d (m)   0    1    2    2.5   3    4    5    6
 *   dmg    170  143  116  103   90   65   41   20
 */
export const NADE_DMG_MAX = 170;
export const NADE_DMG_MIN = 20;
export const NADE_DMG_R = 6.0;
export const NADE_DMG_POW = 1.1;
/** Self-damage scale — a nana at your feet hurts, it does not always kill. */
export const NADE_SELF = 0.55;
/** Frags per life (CoD standard: one lethal). Restocked on respawn, never picked up. */
export const NADE_AMMO = 1;
/** Minimum seconds between throws. */
export const NADE_CD = 0.95;
/** Tumble rate, rad/s. Sim-owned so every POV sees the same spin. */
const NADE_SPIN = 13.5;

/* ─────────────────────────── MATCH FEEL: AMMO ECONOMY ───────────────────────
 * "Once you run out of ammo there's nothing you can do." — the user, and they
 * were right. This block is ECONOMY ONLY: how many rounds a life is worth and
 * where new ones come from. Nothing here touches ballistics — damage, rpm, the
 * fire-interval accumulator, spread, recoil and the recoil-recovery split all
 * stay in weapons.ts / recoil.json / shot.json exactly as tuned.
 *
 * THE ARITHMETIC IT IS SIZED AGAINST. The BUNCH CYLINDER is 28 chest at 800 rpm,
 * so the cheapest kill on the board is FOUR rounds and a headshot start is
 * three. A competent player in a yard this size lands somewhere around a third
 * of what they fire once suppression and pre-fire are counted, which puts a
 * real kill at 12-16 rounds. The shipped life was 30 + 90 = 120 rounds:
 * 7-10 kills at a hit rate nobody has, and 6-8 in practice. That is precisely
 * where the new health regen makes streaks possible, so the gun ran dry exactly
 * when the fight got good.
 */

/** Spare magazines a life opens with. 5 x 30 = 150 reserve, 180 rounds total
 *  (was 3 mags / 120). Fifty percent more life, one mag short of the cap so a
 *  kill still has somewhere to put its resupply. */
export const RESERVE_MAGS = 5;
/** Magazines granted to the KILLER on every kill: the resupply beat. At 12-16
 *  rounds spent per kill, +30 makes a streak self-funding — which is the whole
 *  point. Applied to the reserve, not the magazine: it never reloads for you. */
export const KILL_RESUPPLY_MAGS = 1;
/** Ceiling on the reserve, in magazines. Bounded so a farmer cannot bank the
 *  whole match, generous enough (180 reserve, 210 rounds) that nobody on a real
 *  streak ever meets it. */
export const RESERVE_CAP_MAGS = 6;
/**
 * THE FLOOR — you can never be permanently dry.
 *
 * While ALIVE and holding less than one magazine of total ammunition
 * (`ammo + reserve < mag`), a scavenge clip of SCAVENGE_CLIP rounds lands in the
 * reserve every SCAVENGE_S seconds, until the total is one full magazine again.
 * That is 1 round/second against a 13.3 round/second trigger clock: it cannot
 * fund a firefight, and it is not supposed to. It exists so the answer to "I am
 * out" is never "wait to be shot" — a bone-dry player has 5 rounds in 5 s and a
 * full magazine in 30 s, and melee covers the seconds in between.
 *
 * Delivered in CLIPS rather than one round at a time on purpose: a single round
 * dribbled into an empty gun costs a 1.125 s empty-reload to fire once, while a
 * 5-round clip is a kill and a spare. It is also a beat the HUD can show.
 */
export const SCAVENGE_CLIP = 5;
export const SCAVENGE_S = 5;

/* ────────────────────────── MATCH FEEL: HEALTH REGEN ────────────────────────
 * "Health should regenerate after a certain period without taking damage, so
 * you can rack up big kill streaks — but long enough that people don't feel
 * invincible."  Both halves of that are numbers, and these are the ones:
 *
 *   REGEN_DELAY 6.5 s   it must NEVER rescue anybody mid-fight. The longest gap
 *                       a bot's own fire pattern can legally contain is
 *                       BOT_TUNING.gapMax 1.05 s stretched by its 1.45x roll =
 *                       1.52 s, so the delay is 4.3x the longest pause that is
 *                       still one engagement. In player terms 6.5 s at RUN
 *                       (4.35 m/s) is 28 m of ground — the diagonal of a 33 m
 *                       yard. You do not get healed for backing off; you get
 *                       healed for LEAVING.
 *   the curve           a RAMP, not a constant rate, because the two things
 *                       being tuned pull opposite ways. Starting at
 *                       REGEN_RATE0 10 hp/s means a 1.6 s lull past the delay is
 *                       worth ~15 hp: a bandaid, never a reset. Ending at
 *                       REGEN_RATE1 36 hp/s means a player who genuinely broke
 *                       contact is whole again quickly enough to go back in.
 *   worst case          1 hp to 100 takes 1.6 s of ramp (~37 hp) plus 1.75 s at
 *                       full rate = 3.3 s of healing, 9.8 s from the last round
 *                       that touched you. In a yard this size that is a long,
 *                       deliberate absence from the fight.
 *
 * ANY damage resets both the delay and the ramp (regenT = 0), from any source:
 * bullets, melee, frags and the artillery strike all go through the same reset.
 */
export const REGEN_DELAY = 6.5;
/** Seconds of uninterrupted healing to reach the full rate. */
export const REGEN_RAMP = 1.6;
/** hp/s the moment regen opens. */
export const REGEN_RATE0 = 10;
/** hp/s once the ramp is complete. */
export const REGEN_RATE1 = 36;

/**
 * INPUT SANITIZATION (security HIGH-1): every numeric a client controls is
 * validated ONCE at ingress, here, before applyInput or predictMovement reads
 * it. A NaN in yaw/pitch/ax/az/dx/dy/dz used to flow straight through —
 * clamp(NaN) is NaN (both comparisons false, returns v), norm2(NaN) is
 * NaN/NaN, wish/vx/vy go NaN, integrate's `if (p.x < loX)` is false for NaN
 * so the Nuketown OOB clamp never fires, throwNade's `dl < 0.2` is false for
 * NaN so a NaN direction is normalised into NaN velocity, and explode's
 * `d > NADE_DMG_R` is false for NaN so a void frag poisons hp with NaN.
 * After this function every one of those fields is finite: non-finite inputs
 * coerce to the neutral value (0 = no strafe, no aim offset, no spread dir),
 * sticks clamp to [-1, 1], and pitch clamps at the use sites below.
 * ox/oy/oz/clientTime/rt keep their use-site finite fallbacks (eye anchor /
 * rewind reconstruction) so a dropped field still throws from the eye.
 */
function sanitizeCmd(cmd: InputCmd): void {
  if (!Number.isFinite(cmd.seq)) cmd.seq = 0;
  if (!Number.isFinite(cmd.ax)) cmd.ax = 0;
  else cmd.ax = clamp(cmd.ax, -1, 1);
  if (!Number.isFinite(cmd.az)) cmd.az = 0;
  else cmd.az = clamp(cmd.az, -1, 1);
  if (!Number.isFinite(cmd.yaw)) cmd.yaw = 0;
  else cmd.yaw = ((cmd.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (!Number.isFinite(cmd.pitch)) cmd.pitch = 0;
  else cmd.pitch = clamp(cmd.pitch, -1.45, 1.45);
  if (!Number.isFinite(cmd.dx)) cmd.dx = 0;
  else cmd.dx = clamp(cmd.dx, -1, 1);
  if (!Number.isFinite(cmd.dy)) cmd.dy = 0;
  else cmd.dy = clamp(cmd.dy, -1, 1);
  if (!Number.isFinite(cmd.dz)) cmd.dz = 0;
  else cmd.dz = clamp(cmd.dz, -1, 1);
  // SERVER-PARITY (review M2): the server's sanitizeCmd (server/src/index.ts)
  // additionally drops dt<=0 commands (returns null) and coerces numeric
  // strings via Number(v), while this coerces non-finite dt to TICK_DT and
  // rejects numeric strings to 0. Direction hints dx/dy/dz clamp to [-1, 1]
  // HERE exactly like the server's clampDirection (security LOW): both sides
  // normalise afterwards (fireDir/throwNade), so an unclamped |d| > 1 was
  // never a cheat — but it was an authority-vs-prediction divergence until
  // the shared normalisation. Aligned where it matters for prediction:
  // yaw wraps to [0,2π) and pitch clamps to ±1.45 here exactly like the
  // server (sin/cos agree either way, but the stored p.yaw / snapshot would
  // diverge, and ghost vs authority pitch would disagree until the use-site
  // clamp). Remaining deltas are DOCUMENTED, not holes: a dt<=0 command the
  // client predicts as one tick the server drops (transient mispredict, next
  // ack re-syncs); numeric-string fields the server coerces this zeroes (both
  // finite after sanitize, use-site eye/rewind fallbacks cover the rest).
  if (!Number.isFinite(cmd.dt) || cmd.dt <= 0) cmd.dt = TICK_DT;
  else cmd.dt = clamp(cmd.dt, 0, 0.15);
  if (!Number.isFinite(cmd.ox)) cmd.ox = 0;
  else cmd.ox = clamp(cmd.ox, -128, 128);
  if (!Number.isFinite(cmd.oy)) cmd.oy = 0;
  else cmd.oy = clamp(cmd.oy, -128, 128);
  if (!Number.isFinite(cmd.oz)) cmd.oz = 0;
  else cmd.oz = clamp(cmd.oz, -128, 128);
  if (!Number.isFinite(cmd.clientTime)) cmd.clientTime = 0;
  if (cmd.rt !== undefined && !Number.isFinite(cmd.rt)) cmd.rt = undefined;
}

/**
 * The command a body is allowed during "pregame" / "countdown": aim only.
 *
 * Module-level and mutated in place — applyInput runs once per command per tick
 * for every seat in the room, and allocating an object there to hold four
 * booleans would be a per-tick allocation on the hot path for the sake of a
 * 3-second window. `ads` is TRUE-by-command, not here: the ADS pull is part of
 * aiming, so it is applied above the gate and never zeroed.
 */
const FROZEN: InputCmd = {
  seq: 0,
  dt: TICK_DT,
  ax: 0,
  az: 0,
  jump: false,
  crouch: false,
  sprint: false,
  tac: false,
  ads: false,
  yaw: 0,
  pitch: 0,
  fire: false,
  reload: false,
  melee: false,
  weapon: PRIMARY_WEAPON_ID,
  clientTime: 0,
  ox: 0,
  oy: 0,
  oz: 0,
  dx: 0,
  dy: 0,
  dz: 1,
};

/**
 * THE FRAG FENCE — grenade-only, invisible, and the reason a lob can never end
 * up outside the yard.
 *
 * The frag is the game's first ROLLING entity, and rolling exposed a hole no
 * hitscan ever could: the perimeter wall colliders stop at 2.145 m while the
 * container roofs sit at 2.585-2.695 m. A frag that lands on a roof is already
 * ABOVE the wall — it rolls off the outboard edge, clears the fence and
 * detonates in the void where no player can ever be (qa/projectile-truth
 * SW-lob, measured 3.213 m outside). Raising the real walls would move a
 * classic Shipment sightline; instead every "wall" solid is extruded straight
 * up into a frag-only blocker that shares the wall's exact faces, so the bounce
 * happens on the plane the player already reads as the map edge.
 *
 * Only stepNadeBody sees these, so bullets, bodies and the camera are untouched.
 *
 * IT IS DATA NOW, NOT A TAG. This used to be `SOLIDS.filter(o => o.visual ===
 * "wall")`: a map whose perimeter did not carry that exact magic string got NO
 * fence and leaked frags into the void, and a map that tagged an interior box
 * grew an invisible 13 m wall through the middle of itself. dust2 has no square
 * perimeter and no "wall" solids at all, so the fence is authored per map
 * (MapDef.nadeFenceRects) and extruded from the map's floor to its own top.
 * Shipment's four rects are its four perimeter walls, in the order the filter
 * used to return them — NADE_SOLIDS ordering decides trace ties.
 */
const NADE_FENCE: OBB[] = MAP.nadeFenceRects.map((r, i) => {
  // Regen-shape tolerant: dust2's generator emits bare footprints AND full OBBs
  // ({x,z,sx,sz} vs {x,z,w,d}); accept both spellings here so a generator that
  // renames a field produces a fence, not a NaN collider. Non-finite or
  // non-positive sizes throw loudly at import — a NaN fence box is a frag that
  // sails through the map edge and detonates in the void, and a silent one is
  // worse than a boot that refuses to load. (buildNuketown AND buildDust2 throw
  // on an EMPTY fence list: Nuketown's 3.2 m boundary is below every ballistic
  // arc off the deck, so no fence means frags over the balcony sail out.)
  // TOP IS LOAD-BEARING TOO (security HIGH-2/M2): a NaN or short
  // nadeFenceTop extrudes a NaN/short fence the frag sails over — the same
  // void detonation a missing rect is. Finite-checked here (import layer) AND
  // in each map builder (data layer); both throw, so neither a regen nor a
  // stale build slips a silent hole through. The bar is map-relative: Top must
  // clear 24 m (the dust2/nuketown policy: crest 10.6 + lob) OR the map's own
  // crest + 2 m lob margin — whichever it clears first. Shipment's code-built
  // 13 m fence (crest ~2.7 m) passes the second arm; a NaN or a 3.5 m regen
  // top on Nuketown passes neither and fails the build instead of warning
  // past it.
  if (!Number.isFinite(MAP.nadeFenceTop) || !Number.isFinite(FLOOR_Y))
    throw new Error(`map "${MAP.id}": nadeFenceTop/floorY is not finite (got top ${MAP.nadeFenceTop}, floorY ${FLOOR_Y})`);
  if (!(MAP.nadeFenceTop - FLOOR_Y > 0))
    throw new Error(`map "${MAP.id}": nadeFenceTop ${MAP.nadeFenceTop} does not clear floorY ${FLOOR_Y}`);
  {
    let crest = -Infinity;
    for (const o of SOLIDS) {
      if (Number.isFinite(o.y) && Number.isFinite(o.sy)) crest = Math.max(crest, o.y + o.sy * 0.5);
    }
    if (!(MAP.nadeFenceTop >= 24 || MAP.nadeFenceTop > crest + 2))
      throw new Error(
        `map "${MAP.id}": nadeFenceTop ${MAP.nadeFenceTop} clears neither 24 m nor crest ${crest.toFixed(2)} + 2 m lob margin`,
      );
  }
  const sx = r.sx ?? r.w;
  const sz = r.sz ?? r.d;
  const yaw = r.yaw ?? 0;
  for (const [k, v] of [["x", r.x], ["z", r.z], ["sx", sx], ["sz", sz], ["yaw", yaw]] as const) {
    if (!Number.isFinite(v))
      throw new Error(`map "${MAP.id}": nadeFenceRect ${i} has non-finite ${k} (regen drift — see MapDef.nadeFenceRects)`);
  }
  if (!(sx! > 0 && sz! > 0))
    throw new Error(`map "${MAP.id}": nadeFenceRect ${i} has non-positive size ${sx}x${sz}`);
  return {
    x: r.x,
    y: (FLOOR_Y + MAP.nadeFenceTop) * 0.5,
    z: r.z,
    sx: sx!,
    sy: MAP.nadeFenceTop - FLOOR_Y,
    sz: sz!,
    yaw,
    visual: "wall",
  };
});

/**
 * SEAM PLUGS — frag-only, and the reason a 22 cm banana can never wedge itself
 * into a 7 cm crack.
 *
 * Shipment's containers are built in pairs with a PAIR_GAP of 0.07 m, and the
 * open shells leave 0.04 m between a cwall and its neighbour. A 0.21 m sphere
 * cannot fit in either, but the resolver does not know that: hit the seam fast
 * and sideways and it gets squeezed by both boxes at once, the last one
 * processed wins, and the frag ends up 6.5 cm inside the steel where it comes
 * to rest and detonates occluded from both sides — a silent dud. (569,520
 * wall-hug throws found 170 of them, all on a 0.07/0.04 m seam.)
 *
 * So every pair of solids that overlaps on two axes and is separated on the
 * third by less than a frag diameter gets an invisible plug across the slot,
 * flush with both faces. The frag now bounces off the seam it can already see
 * is closed. Player, bullet and camera collision are untouched.
 */
function buildNadeSeams(): OBB[] {
  const out: OBB[] = [];
  const dia = NADE_RADIUS * 2;
  // THE PAIR SCAN WAS O(n^2) AT MODULE IMPORT. 60 boxes is 1,770 pairs and
  // free; dust2's 3,005 is 4.5 M pairs and ~90 ms of blocking import in the
  // browser before the menu can paint. The grid narrows it to the boxes whose
  // footprints are actually within a frag diameter, and the enumeration order is
  // unchanged — `i` ascending, then `j` ascending, exactly as the double loop —
  // because a seam plug's position in NADE_SOLIDS decides trace tie-breaks.
  const near: number[] = [];
  for (let i = 0; i < SOLIDS.length; i++) {
    const a = SOLIDS[i]!;
    const ac = Math.abs(Math.cos(a.yaw));
    const as = Math.abs(Math.sin(a.yaw));
    const ahx = a.sx * 0.5 * ac + a.sz * 0.5 * as;
    const ahz = a.sx * 0.5 * as + a.sz * 0.5 * ac;
    const cand = gridQueryRect(
      solidGrid(),
      a.x - ahx - dia,
      a.z - ahz - dia,
      a.x + ahx + dia,
      a.z + ahz + dia,
      near,
    );
    for (let ci = 0; ci < cand.length; ci++) {
      const j = cand[ci]!;
      if (j <= i) continue;
      const b = SOLIDS[j]!;
      // Only axis-aligned neighbours (yaw equal, or 180° apart) form a true slot.
      const dyaw = (((a.yaw - b.yaw) % Math.PI) + Math.PI) % Math.PI;
      if (Math.min(dyaw, Math.PI - dyaw) > 1e-3) continue;
      const c = Math.cos(-a.yaw);
      const s = Math.sin(-a.yaw);
      const wx = b.x - a.x;
      const wz = b.z - a.z;
      const d = [wx * c - wz * s, b.y - a.y, wx * s + wz * c];
      const ha = [a.sx * 0.5, a.sy * 0.5, a.sz * 0.5];
      const hb = [b.sx * 0.5, b.sy * 0.5, b.sz * 0.5];
      let axis = -1;
      let ok = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]!) - (ha[k]! + hb[k]!) > 1e-6) {
          if (axis >= 0) {
            ok = false; // separated on two axes: diagonal neighbours, not a slot
            break;
          }
          axis = k;
        }
      }
      if (!ok || axis < 0) continue;
      const gap = Math.abs(d[axis]!) - (ha[axis]! + hb[axis]!);
      if (gap >= dia) continue;
      const ctr = [0, 0, 0];
      const size = [0, 0, 0];
      ctr[axis] = (d[axis]! >= 0 ? 1 : -1) * (ha[axis]! + gap * 0.5);
      size[axis] = gap;
      for (let k = 0; k < 3 && ok; k++) {
        if (k === axis) continue;
        const lo = Math.max(-ha[k]!, d[k]! - hb[k]!);
        const hi = Math.min(ha[k]!, d[k]! + hb[k]!);
        if (hi <= lo) ok = false;
        else {
          ctr[k] = (lo + hi) * 0.5;
          size[k] = hi - lo;
        }
      }
      if (!ok) continue;
      const w = localToWorld(a, ctr[0]!, ctr[2]!);
      out.push({
        x: w.x,
        y: a.y + ctr[1]!,
        z: w.z,
        sx: size[0]!,
        sy: size[1]!,
        sz: size[2]!,
        yaw: a.yaw,
        visual: "seam",
      });
    }
  }
  return out;
}
const NADE_SEAMS = buildNadeSeams();

/**
 * Everything a frag can hit: the map colliders plus the frag-only fence and
 * seam plugs. The spawn clamp traces against this exact list, so "the marker
 * can see it" and "the frag will bounce off it" are the same set by
 * construction.
 */
export const NADE_SOLIDS: OBB[] = [...SOLIDS, ...NADE_FENCE, ...NADE_SEAMS];

/** Broad-phase spheres for SOLIDS + the frag fence — built once, read every substep. */
const SOLID_BS = NADE_SOLIDS.map((o) => ({
  o,
  r: Math.hypot(o.sx, o.sy, o.sz) * 0.5,
}));

/**
 * The frag list gets its own uniform grid, on top of the bounding spheres.
 *
 * The spheres alone are useless at dust2 scale for exactly the reason they work
 * at Shipment scale: `r = hypot(sx,sy,sz)/2`, so a 60 m wall segment carries a
 * 30 m sphere and every frag in that third of the map "might" be touching it.
 * The grid answers the same question by footprint.
 *
 * Registering it here is also what lets `traceWorld(..., NADE_SOLIDS)` — the
 * throw clamp and `segmentClear` — take the accelerated path.
 */
const NADE_GRID: SolidGrid = indexSolids(NADE_SOLIDS);

/** The minimum state grenade motion needs. Both the sim and the marker use it. */
export type NadeBody = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Resting on a near-horizontal face (drives rolling friction + settling). */
  grounded: boolean;
  /** True once the frag has stopped moving — prediction can early-out. */
  asleep: boolean;
};

/** Hardest normal impact seen during the last stepNadeBody call, m/s. */
let nadeHitV = 0;
/** Where that impact happened — read via lastNadeHit() right after the step. */
const nadeHitAt = { x: 0, y: 0, z: 0 };

/** Contact point of the impact stepNadeBody just reported. */
export function lastNadeHit(): { x: number; y: number; z: number } {
  return nadeHitAt;
}

/**
 * Advance one frag by `dt` (3 substeps, matching the player integrator).
 * Returns the hardest impact speed of the step, 0 if it touched nothing —
 * the caller turns that into a bounce thunk.
 */
export function stepNadeBody(b: NadeBody, dt: number): number {
  nadeHitV = 0;
  // NUKETOWN OOB BACKSTOP, FRAG HALF (security #1/C) — ALSO FOR SLEEPING
  // FRAGS (security HIGH-3). The old code returned here when asleep, BEFORE
  // the XZ backstop below: a frag that crossed MAP.bounds on the same step
  // NADE_SLEEP settled it went asleep-OOB and was never teleported back, yet
  // still fused and exploded in the void with clear LOS (blastSees runs
  // against SOLIDS, not the fence, and the bounds are virtual). So the
  // backstop runs BEFORE the asleep early-out: an OOB frag is clamped,
  // bounced, and re-armed (asleep = false) so the substeps below re-settle it
  // inside; an in-bounds asleep frag still returns here. Gated on
  // IS_NUKETOWN like the main backstop; other maps never reach it.
  if (b.asleep && !IS_NUKETOWN) return 0;
  if (b.asleep && IS_NUKETOWN) {
    const bb0 = MAP.bounds;
    const loX0 = bb0.minX + NADE_RADIUS;
    const hiX0 = bb0.maxX - NADE_RADIUS;
    const loZ0 = bb0.minZ + NADE_RADIUS;
    const hiZ0 = bb0.maxZ - NADE_RADIUS;
    let woke = false;
    // OOB + NON-FINITE WAKE (review MEDIUM): the old gate woke on non-finite
    // X/Z only — a NaN Y (or NaN/insane velocity) slept forever, fused, and
    // exploded in the void (blast damage is guarded, replication is not). Any
    // non-finite coordinate or velocity re-arms the frag inside the map.
    if (!Number.isFinite(b.x) || !Number.isFinite(b.z) || !Number.isFinite(b.y)) {
      b.x = (bb0.minX + bb0.maxX) * 0.5;
      b.z = (bb0.minZ + bb0.maxZ) * 0.5;
      if (!Number.isFinite(b.y)) b.y = FLOOR_Y + NADE_RADIUS;
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      woke = true;
    } else if (!Number.isFinite(b.vx) || !Number.isFinite(b.vy) || !Number.isFinite(b.vz)) {
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      woke = true;
    } else {
      if (b.x < loX0) {
        b.x = loX0;
        bounceNade(b, 1, 0, 0, 0);
        woke = true;
      } else if (b.x > hiX0) {
        b.x = hiX0;
        bounceNade(b, -1, 0, 0, 0);
        woke = true;
      }
      if (b.z < loZ0) {
        b.z = loZ0;
        bounceNade(b, 0, 0, 1, 0);
        woke = true;
      } else if (b.z > hiZ0) {
        b.z = hiZ0;
        bounceNade(b, 0, 0, -1, 0);
        woke = true;
      }
    }
    if (woke) b.asleep = false;
    else return 0;
  }
  const steps = 3;
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    b.vy -= NADE_GRAVITY * sdt;
    b.x += b.vx * sdt;
    b.y += b.vy * sdt;
    b.z += b.vz * sdt;
    b.grounded = false;
    // World floor — per map (Shipment 0, dust2 -3.30).
    if (b.y - NADE_RADIUS <= FLOOR_Y) {
      b.y = FLOOR_Y + NADE_RADIUS;
      bounceNade(b, 0, 1, 0, 0);
    }
    resolveNadeSolids(b);
    if (b.grounded) {
      const k = Math.exp(-NADE_ROLL_FRIC * sdt);
      b.vx *= k;
      b.vz *= k;
      if (Math.hypot(b.vx, b.vz) < NADE_SLEEP && Math.abs(b.vy) < NADE_SLEEP) {
        b.vx = 0;
        b.vy = 0;
        b.vz = 0;
        b.asleep = true;
        return nadeHitV;
      }
    }
  }
  // NUKETOWN OOB BACKSTOP, FRAG HALF (security #1/C). The 56-rect frag fence
  // (MapDef.nadeFenceRects, extruded to nadeFenceTop 26) is the real wall a lob
  // bounces off; this is the net behind it. A frag arcing over the 3.2 m
  // boundary with deck-launch speed can cross MAP.bounds mid-step (up to
  // ~0.24 m past the line across the 3 substeps), and without this it would
  // detonate in the void where no player can ever be. Teleport back inside the
  // inset and bounce off the invisible plane (same kernel, so predictNade's
  // landing marker agrees exactly). Gated on IS_NUKETOWN: other maps never
  // reach it and stay bit-identical.
  //
  // CADENCE NOTE (accepted, documented): this runs ONCE per stepNadeBody call,
  // not once per substep — the fence above is the per-substep real wall, this
  // is the net. predictNade steps the same kernel at the same TICK_DT, so the
  // marker and the sim agree exactly despite the coarser net.
  if (IS_NUKETOWN) {
    const bb = MAP.bounds;
    const loX = bb.minX + NADE_RADIUS;
    const hiX = bb.maxX - NADE_RADIUS;
    const loZ = bb.minZ + NADE_RADIUS;
    const hiZ = bb.maxZ - NADE_RADIUS;
    let fenced = false;
    // Non-finite X/Z (L2: NaN comparisons are false, so NaN x/z fell through
    // the OOB arms below and stayed void-OOB): re-arm inside like Y/velocity
    // rather than detonate the void.
    if (!Number.isFinite(b.x)) {
      b.x = (bb.minX + bb.maxX) * 0.5;
      b.vx = 0;
      fenced = true;
    }
    if (!Number.isFinite(b.z)) {
      b.z = (bb.minZ + bb.maxZ) * 0.5;
      b.vz = 0;
      fenced = true;
    }
    if (!Number.isFinite(b.y)) {
      b.y = FLOOR_Y + NADE_RADIUS;
      b.vy = 0;
      fenced = true;
    }
    if (!Number.isFinite(b.vx) || !Number.isFinite(b.vy) || !Number.isFinite(b.vz)) {
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      fenced = true;
    }
    if (b.x < loX) {
      b.x = loX;
      bounceNade(b, 1, 0, 0, 0);
      fenced = true;
    } else if (b.x > hiX) {
      b.x = hiX;
      bounceNade(b, -1, 0, 0, 0);
      fenced = true;
    }
    if (b.z < loZ) {
      b.z = loZ;
      bounceNade(b, 0, 0, 1, 0);
      fenced = true;
    } else if (b.z > hiZ) {
      b.z = hiZ;
      bounceNade(b, 0, 0, -1, 0);
      fenced = true;
    }
    // A frag that crossed the line on the same step it settled re-arms: the
    // asleep early-out at the top would otherwise leave it asleep-OOB forever.
    // (The top-of-function OOB check already covers frags that ARRIVE asleep;
    // this covers frags that FALL asleep OOB mid-step.)
    if (fenced) b.asleep = false;
  }
  return nadeHitV;
}

/** Reflect + scrub about a unit world normal, then log the impact. */
function bounceNade(b: NadeBody, nx: number, ny: number, nz: number, pen: number): void {
  if (pen > 0) {
    b.x += nx * pen;
    b.y += ny * pen;
    b.z += nz * pen;
  }
  if (ny > 0.65) b.grounded = true;
  const vn = b.vx * nx + b.vy * ny + b.vz * nz;
  if (vn >= 0) return;
  const tx = b.vx - nx * vn;
  const ty = b.vy - ny * vn;
  const tz = b.vz - nz * vn;
  b.vx = tx * NADE_TANGENT - nx * vn * NADE_REST;
  b.vy = ty * NADE_TANGENT - ny * vn * NADE_REST;
  b.vz = tz * NADE_TANGENT - nz * vn * NADE_REST;
  if (-vn > nadeHitV) {
    nadeHitV = -vn;
    nadeHitAt.x = b.x;
    nadeHitAt.y = b.y;
    nadeHitAt.z = b.z;
  }
}

/** Drift budget for the frag's candidate list — see RC_SLACK on the player side. */
const NS_SLACK = 0.75;
const NS_PAD = NADE_RADIUS * Math.SQRT2 + NS_SLACK;

/** Sphere vs every map OBB, broad-phased on the solid's bounding sphere. */
function resolveNadeSolids(b: NadeBody): void {
  const reach = NADE_RADIUS;
  // Footprint broadphase first (a candidate list in ASCENDING NADE_SOLIDS order,
  // which is the order the flat scan visited them in — this loop moves the frag
  // as it goes, so any other order is a different bounce), bounding sphere
  // second. The sphere alone is useless at dust2 scale: r = hypot(sx,sy,sz)/2
  // gives a 60 m wall a 30 m sphere.
  //
  // The re-gather is not belt-and-braces: the "centre inside the box" branch
  // below ejects along a whole half-extent, which on a 6 m container is a 3 m
  // teleport out of the cells this list was gathered from.
  let qx = b.x;
  let qz = b.z;
  let cand = gridQueryCircle(NADE_GRID, qx, qz, NS_PAD, NS_NEAR);
  let ci = 0;
  let last = -1;
  while (ci < cand.length) {
    const i = cand[ci]!;
    ci += 1;
    if (i <= last) continue;
    last = i;
    const bs = SOLID_BS[i]!;
    const o = bs.o;
    const ddx = b.x - o.x;
    const ddy = b.y - o.y;
    const ddz = b.z - o.z;
    const far = bs.r + reach;
    if (ddx * ddx + ddy * ddy + ddz * ddz > far * far) continue;
    // Local (x,z) <-> world rotation for this solid (see localToWorld in map.ts).
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    const loc = worldToLocal(o, b.x, b.z);
    const ly = b.y - o.y;
    const hx = o.sx * 0.5;
    const hy = o.sy * 0.5;
    const hz = o.sz * 0.5;
    const cx = clamp(loc.x, -hx, hx);
    const cy = clamp(ly, -hy, hy);
    const cz = clamp(loc.z, -hz, hz);
    let nx = loc.x - cx;
    let ny = ly - cy;
    let nz = loc.z - cz;
    const d2 = nx * nx + ny * ny + nz * nz;
    let pen: number;
    if (d2 > 1e-10) {
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2);
      nx /= d;
      ny /= d;
      nz /= d;
      pen = reach - d;
    } else {
      // Centre inside the box — the frag must come back out THE WAY IT WENT IN.
      //
      // The old rule ejected along the shallowest face on whichever side of the
      // midplane the centre happened to sit. On a 0.18 m container wall that is
      // a through-wall teleporter: a body a hair past the midplane gets shoved
      // out the FAR face, and because bounceNade early-returns when the normal
      // faces away from the velocity, it leaves at full speed and detonates
      // behind cover. Backing out along the face that OPPOSES the velocity
      // makes the same situation a bounce off the near face instead, which is
      // both correct and what the player already expects to see.
      const vlx = b.vx * c + b.vz * s;
      const vlz = -b.vx * s + b.vz * c;
      nx = 0;
      ny = 0;
      nz = 0;
      pen = Infinity;
      // Depth to clear a face whose local outward normal is `sg` on this axis.
      if (Math.abs(vlx) > 1e-6) {
        const sg = vlx > 0 ? -1 : 1;
        const d = hx - sg * loc.x;
        if (d < pen) {
          pen = d;
          nx = sg;
          ny = 0;
          nz = 0;
        }
      }
      if (Math.abs(b.vy) > 1e-6) {
        const sg = b.vy > 0 ? -1 : 1;
        const d = hy - sg * ly;
        if (d < pen) {
          pen = d;
          nx = 0;
          ny = sg;
          nz = 0;
        }
      }
      if (Math.abs(vlz) > 1e-6) {
        const sg = vlz > 0 ? -1 : 1;
        const d = hz - sg * loc.z;
        if (d < pen) {
          pen = d;
          nx = 0;
          ny = 0;
          nz = sg;
        }
      }
      if (!Number.isFinite(pen)) {
        // Dead still inside a box (teleported scenery, degenerate spawn): no
        // "way it came", so fall back to the nearest face.
        const px = hx - Math.abs(loc.x);
        const py = hy - Math.abs(ly);
        const pz = hz - Math.abs(loc.z);
        if (py <= px && py <= pz) {
          ny = ly >= 0 ? 1 : -1;
          pen = py;
        } else if (px <= pz) {
          nx = loc.x >= 0 ? 1 : -1;
          pen = px;
        } else {
          nz = loc.z >= 0 ? 1 : -1;
          pen = pz;
        }
      }
      pen += reach;
    }
    bounceNade(b, nx * c - nz * s, ny, nx * s + nz * c, pen);
    if (Math.abs(b.x - qx) > NS_SLACK || Math.abs(b.z - qz) > NS_SLACK) {
      qx = b.x;
      qz = b.z;
      cand = gridQueryCircle(NADE_GRID, qx, qz, NS_PAD, NS_NEAR);
      ci = 0;
      while (ci < cand.length && cand[ci]! <= last) ci += 1;
    }
  }
}

/**
 * Roll a throw forward for the landing marker. Writes `out` (xyz triples, no
 * allocation) and returns how many points it wrote; `rest` receives the
 * detonation point. Identical kernel, identical dt — marker == reality.
 */
export function predictNade(
  start: NadeBody,
  out: Float32Array,
  rest: { x: number; y: number; z: number },
  every = 2,
  /** Fuse left when it leaves the hand — a cooked frag's marker is where it
   *  detonates, not where a fresh one would. */
  fuse = NADE_FUSE,
): number {
  SCRATCH.x = start.x;
  SCRATCH.y = start.y;
  SCRATCH.z = start.z;
  SCRATCH.vx = start.vx;
  SCRATCH.vy = start.vy;
  SCRATCH.vz = start.vz;
  SCRATCH.grounded = false;
  SCRATCH.asleep = false;
  const maxPts = (out.length / 3) | 0;
  let n = 0;
  // The sim decrements the fuse AFTER the step and detonates on the step that
  // takes it to <= 0, so a frag with `fuse` left lives exactly this many steps.
  const ticks = Math.max(1, Math.ceil(fuse / TICK_DT - 1e-9));
  for (let i = 0; i < ticks; i++) {
    stepNadeBody(SCRATCH, TICK_DT);
    if (i % every === 0 && n < maxPts) {
      out[n * 3] = SCRATCH.x;
      out[n * 3 + 1] = SCRATCH.y;
      out[n * 3 + 2] = SCRATCH.z;
      n++;
    }
    if (SCRATCH.asleep) break;
  }
  rest.x = SCRATCH.x;
  rest.y = SCRATCH.y;
  rest.z = SCRATCH.z;
  return n;
}

const SCRATCH: NadeBody = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false, asleep: false };

export type SimNade = NadeBody & {
  id: number;
  owner: string;
  team: Team;
  fuse: number;
  spin: number;
  /** Cooked to zero in the thrower's hand — the thrower does not survive it. */
  inHand?: boolean;
};

export type SimPlayer = {
  id: string;
  name: string;
  op: string;
  team: Team;
  bot: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  hp: number;
  /** The weapon in hand (a WeaponDef id). */
  weapon: string;
  /** Rounds in the held weapon's magazine, and its reserve. */
  ammo: number;
  reserve: number;
  /**
   * THE HOLSTERED WEAPON and its ammunition. A swap (trySwap) exchanges the two
   * triples, so every ammo rule in this file (reload, scavenge, resupply) keeps
   * reading `weapon`/`ammo`/`reserve` and is automatically about the gun in
   * hand. Named exactly as PlayerSnap names them so the client's ghost (a
   * PlayerSnap) replays a swap through the same code.
   */
  alt: string;
  altAmmo: number;
  altRes: number;
  /** GUN GAME (shared/gungame.ts): ladder progress, and the gun it puts in hand ("" elsewhere). */
  gun: number;
  gunWeapon: string;
  /** The kit this body spawns with, and the one it switches to at next spawn. */
  loadout: Loadout;
  nextLoadout: Loadout | null;
  /** Bloom: spread multiplier heat and seconds since the last shot. */
  heat: number;
  shotAgo: number;
  /** Semi/bolt trigger re-armed: the fire button has been up since the last shot. */
  armed: boolean;
  /** Seconds the held frag has cooked; 0 = no pin pulled. */
  cook: number;
  /** Server time the pin was pulled (the real-time safety, NADE_COOK_SLACK). */
  cookAt: number;
  ads: number;
  wantAds: boolean;
  sprint: boolean;
  tac: boolean;
  crouch: boolean;
  onGround: boolean;
  slide: number;
  slideVx: number;
  slideVz: number;
  reload: number;
  fireCd: number;
  pump: boolean;
  swap: number;
  protect: number;
  dead: number;
  alive: boolean;
  kills: number;
  deaths: number;
  streak: number;
  score: number;
  lastHit: string;
  lastHitAt: number;
  /**
   * Seconds since this body last TOOK damage — the clock health regeneration
   * runs on. Deliberately NOT `lastHitAt`: that field means "who is credited
   * with hurting me" and is read by the killcam and the assist logic, so
   * hanging a second meaning on it would tie a heal to a kill credit.
   */
  regenT: number;
  /** Fractional scavenge progress, seconds. Only moves while under one mag. */
  scavT: number;
  ping: number;
  seq: number;
  botT: number;
  botTarget: string | null;
  botWp: number;
  botReact: number;
  botAimY: number;
  botAimP: number;
  uav: number;
  sprintOut: number;
  tacFuel: number;
  firing: boolean;
  lastShotOx: number;
  lastShotOy: number;
  lastShotOz: number;
  lastShotDx: number;
  lastShotDy: number;
  lastShotDz: number;
  /** Banana frags left this life. */
  nades: number;
  /** Throw cooldown, seconds. */
  nadeCd: number;
  /** Winding up (nana in paw) — replicated so remote actors pre-swing. */
  nadeUp: boolean;
  /**
   * REAL TIME THIS PLAYER MAY STILL SPEND ON ITS TRIGGER CLOCKS, seconds.
   *
   * The fire interval, the reload, the ADS pull and the sprint-out have to
   * advance once per COMMAND, not once per server tick — a burst of three
   * commands is three client ticks of the player's life and refusing the
   * trigger pulls inside it is the "I pulled and nothing came out" P0. But
   * "once per command" on its own is a rate-of-fire cheat: a client that hands
   * its 64 commands/s over two or three at a time gets two or three ticks of
   * gun clock out of one tick of real time, and measured on the shipped server
   * that was worth 1.38x-1.63x the designed 800 rpm for free, no extra
   * bandwidth and no extra commands — with a WORSE frame rate as the trigger,
   * because game.ts's fixed-step accumulator flushes more commands per turn the
   * slower it runs.
   *
   * So the credit is METERED. Real elapsed time is paid in here
   * (bankCommandTime) and creditCommandTime may only spend what is in the
   * account. Total credit per wall-second is therefore exactly 1.0 s for ANY
   * arrival pattern, while a burst can still draw the time it genuinely
   * represents out of what the stall banked.
   */
  cmdBank: number;
  /**
   * GHOST-SIDE TRAVEL BANK (review HIGH-2): the seat-level meter the server
   * drains (seat.moveBank, one MOVE_TICK per drained command, capped at
   * MAX_CMDS_PER_TICK per tick) has no SimPlayer home, so the ghost carries
   * its own copy. predictMovement funds it per predicted command and spends
   * one TICK_DT of travel per command that moves, exactly parallel to cmdBank
   * for the gun clocks — a 960 cmds/s flood can no longer replay ~15x the
   * travel the authority integrates out of a capped bank plus a capped drain.
   *
   * Residual, documented: the server funds per TICK on the wall clock while
   * the ghost funds per COMMAND, so a multi-command drain tick still differs
   * by up to one bank. The next ack re-syncs it (predictionFor carries the
   * seat's live value), and what is left is a render-smoothing error, never a
   * hit — hits are hitscan against the authority, and the ghost's hitmarker is
   * explicitly predicted (see game.ts predMarked).
   */
  moveBank: number;
  /**
   * Fire commands this player has had REFUSED for claiming a muzzle that is not
   * on its body (GameSession.tryFire's anti-teleport guard). A healthy client
   * reads 0 forever; anything else is a client/server disagreement about where
   * the player is, and it used to be invisible because the refusal happened
   * after the round was already spent.
   */
  badOrigin: number;
  /**
   * Fire commands whose claimed muzzle was inside the distance tolerance but NOT
   * VISIBLE from the eye the server integrated — a wallbang origin — and was
   * therefore snapped back to that eye before the trace (GameSession.tryFire).
   * Like badOrigin this reads 0 forever on a healthy client; unlike it, the shot
   * is still fired, from the honest origin.
   */
  originClamped: number;
  /**
   * TRUE when a network seat owns this player (server/index.ts). Its bank is
   * then topped up by the host on the WALL clock and spent by the drain loop,
   * one client tick per command; step() must not also credit it, or the two
   * sources would add and the clocks would run faster than real time. Bots, the
   * offline sim and the ?test harness leave this false and are credited by
   * step() exactly as before.
   */
  netFed: boolean;
  /**
   * TRUE for a spectator seat's body (server/game-server.ts marks it every
   * tick). The round-based referee counts "alive per team" and a benched body
   * — alive, on a team, pinned at 999 hp — must never hold a round open or be
   * respawned into one it is not playing.
   */
  bench: boolean;
  /**
   * TRUE for a body that entered a round-based room while a round was already
   * being played (a human joining, a bot filled in, a promoted spectator) and
   * is waiting for the next one. ONE LIFE PER ROUND means no life mid-round:
   * the body lies dead until startRound respawns the yard, and — unlike a body
   * that died in the round — it does not count as "fielded", so it can neither
   * hold a round open nor hand the other side a wipe. Cleared by spawn().
   */
  sitOut: boolean;
};

/**
 * One published pose of one player — the rewind buffer's unit. Recorded on the
 * SNAPSHOT ticks only (GameSession.step), because these are exactly the poses a
 * client is ever sent and therefore the only ones it can have drawn.
 *
 * Stance rides along because it decides the capsule's height: a crouched body
 * is 1.18 m, a sliding one 0.82 m, and a shot rewound against the wrong one
 * passes over a head that was there.
 */
export type HistFrame = {
  time: number;
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  crouch: boolean;
  slide: number;
};

export type Mode = "tdm" | "ffa" | "kc";

export class GameSession {
  time = 0;
  tick = 0;
  mode: Mode = "tdm";
  /** GUN GAME: an FFA room whose guns come off the ladder (shared/gungame.ts), set before anyone joins. */
  gunGame = false;
  score0 = 0;
  score1 = 0;
  remain = TDM_MATCH_TIME;
  over = false;
  players = new Map<string, SimPlayer>();
  /** Live banana frags, authoritative. */
  nades: SimNade[] = [];
  nadeSeq = 0;
  hist: HistFrame[] = [];
  events: NetEvent[] = [];
  /**
   * Session-wide tally of fire commands refused by tryFire's anti-teleport
   * origin guard. Zero on a healthy yard; a rising number is a client whose
   * predicted position has come apart from the server's, and the shots it is
   * losing to that are now countable instead of silent.
   */
  badOrigin = 0;
  /**
   * Session-wide tally of fire commands whose origin was snapped back to the
   * shooter's own eye because the claimed one was not visible from it (see
   * tryFire). Zero on a healthy yard; a rising number is either a client
   * standing inside geometry or one forging wallbang muzzles.
   */
  originClamped = 0;
  uavUntil: [number, number] = [0, 0];
  rng = 1;

  /**
   * MATCH PHASE — see shared/matchphase.ts for the handshake this belongs to.
   *
   * Defaults to "live" so every existing caller (the qa harnesses, hitlab,
   * rangecard, the ?test rig, and any server that has not opted in) behaves
   * exactly as it did before this field existed. A countdown only happens
   * because somebody asked for one with beginCountdown().
   */
  phase: MatchPhase = "live";
  /** Sim time (seconds) the phase flips to "live". Only meaningful mid-countdown. */
  liveAt = 0;

  /**
   * Arm the 3-2-1. Server-side this is called when the host presses START and
   * the same instant is broadcast as StartMsg.startAt; client-side (local bot
   * matches) it is called on match start and the client counts off its own sim.
   * Either way the numerals are drawn from a TIMESTAMP, never from a per-frame
   * decrement, so every client in a lobby counts together.
   */
  beginCountdown(ms: number = COUNTDOWN_MS): void {
    this.phase = "countdown";
    this.liveAt = this.time + ms / 1000;
  }

  /**
   * Seconds until the match goes live, and NEGATIVE seconds since it did.
   *
   * It keeps counting past zero on purpose: the "GO" card plays out after the
   * yard is already live (shared/matchphase GO_MS), so the renderer needs the
   * signed distance from `liveAt`, not a clamp at it. EXACTLY ZERO is the
   * sentinel for "no countdown exists" — never armed, or a lobby still in
   * pregame with nothing to count to.
   */
  countdownLeft(): number {
    if (this.phase === "pregame" || this.liveAt <= 0) return 0;
    return this.liveAt - this.time;
  }

  /* ── ROUND-BASED TDM (shared/protocol.ts ROUND_*) ─────────────────────────
   * Team deathmatch on dust2 is five one-life rounds; Shipment TDM and every
   * FFA room never enter this code. Derived from mode + the map this process
   * simulates rather than stored, so a server that sets `mode` after
   * construction (getRoom) and the offline client agree without a second flag.
   */
  get roundBased(): boolean {
    return isRoundBased(this.mode, MAP.id);
  }
  /** 1-based round number; 0 until the first step of a round-based match. */
  round = 0;
  /** "live" while a round plays, "end" during the result-card intermission. */
  roundState: "live" | "end" = "live";
  /** Team that took the last round; -1 = timer tie (no point) or none yet. */
  roundWinner: -1 | Team = -1;
  /** Sim time the intermission ends and the next round's countdown is armed. */
  roundEndsAt = 0;

  /** Alive playable bodies per team right now; benched spectators excluded. */
  aliveByTeam(): [number, number] {
    const n: [number, number] = [0, 0];
    for (const p of this.players.values()) if (p.alive && !p.bench) n[p.team] += 1;
    return n;
  }

  /** Playable bodies per team, alive or not; benched spectators excluded. */
  fieldedByTeam(): [number, number] {
    const n: [number, number] = [0, 0];
    for (const p of this.players.values()) if (!p.bench && !p.sitOut) n[p.team] += 1;
    return n;
  }

  /**
   * A body that has just been added or promoted while a round is being PLAYED
   * (the round-based referee is live and past its countdown) waits for the
   * next round: it is laid down where it stands, off the fielded count. The
   * server calls this only for playable seats in a room whose own phase is
   * "live" — a lobby that has not started, a spectator's camera body and every
   * other mode/map go on spawning alive exactly as before. Returns whether the
   * body was held.
   */
  holdForRound(p: SimPlayer): boolean {
    if (!this.roundBased || this.round === 0 || this.roundState !== "live" || this.phase !== "live") return false;
    p.sitOut = true;
    p.alive = false;
    p.hp = 0;
    // Never reaches zero: the only respawn in a round-based room is startRound.
    p.dead = 1e9;
    return true;
  }

  /** The round block for the snapshot. Undefined outside round-based rooms. */
  roundSnap(): RoundState | undefined {
    if (!this.roundBased) return undefined;
    const alive = this.aliveByTeam();
    return {
      n: this.round,
      total: ROUNDS_TOTAL,
      state: this.roundState,
      winner: this.roundWinner,
      wins0: this.score0,
      wins1: this.score1,
      alive0: alive[0],
      alive1: alive[1],
    };
  }

  /**
   * Open round `round + 1`. Round 1 opens silently on the match's own start
   * (the server's lobby countdown already played); every later round respawns
   * every playable body at its team spawns with a full kit and arms the same
   * 3-2-1 the match opened with, so the client draws the numerals and locks
   * input with zero new machinery (shared/matchphase.ts).
   */
  startRound(countdown = true): void {
    this.round += 1;
    this.roundState = "live";
    this.remain = ROUND_TIME;
    this.roundEndsAt = 0;
    this.nades.length = 0;
    this.uavUntil = [0, 0];
    if (countdown) {
      for (const p of this.players.values()) {
        if (p.bench) continue;
        p.hp = 100;
        p.dead = 0;
        p.streak = 0;
        p.uav = 0;
        p.nades = NADE_AMMO;
        fillAmmo(p);
        this.spawn(p);
      }
      this.beginCountdown();
    }
    this.events.push({ t: "round", state: "start", round: this.round, winner: -1, wins0: this.score0, wins1: this.score1 });
  }

  /**
   * Close the round. The point goes to `winner` (none on a tie), the result
   * card gets ROUND_INTERMISSION_S, and the match ends here if the tally can
   * no longer change hands: ROUNDS_TO_WIN is a majority of ROUNDS_TOTAL, so a
   * 3-0 after three rounds ends it exactly as a 3-2 after five does. `remain`
   * is parked on the fresh round clock so a timer-expired round never publishes
   * a 0 that the client would read as the whole match ending.
   */
  endRound(winner: -1 | Team): void {
    if (winner === 0) this.score0 += 1;
    else if (winner === 1) this.score1 += 1;
    this.roundWinner = winner;
    this.roundState = "end";
    this.roundEndsAt = this.time + ROUND_INTERMISSION_S;
    this.remain = ROUND_TIME;
    this.events.push({ t: "round", state: "end", round: this.round, winner, wins0: this.score0, wins1: this.score1 });
    const clinched = this.score0 >= ROUNDS_TO_WIN || this.score1 >= ROUNDS_TO_WIN;
    if (clinched || this.round >= ROUNDS_TOTAL) {
      this.over = true;
      this.events.push({ t: "match", state: "end", score0: this.score0, score1: this.score1 });
    }
  }

  /**
   * The round referee, once per tick. A team that fielded somebody and
   * has nobody left loses the round; the round clock running out hands it to
   * the side with more survivors. During the intermission it only waits for
   * the card to time out and then opens the next round.
   */
  private tickRounds(dt: number): void {
    if (this.round === 0) this.startRound(false);
    if (this.roundState === "end") {
      if (this.time >= this.roundEndsAt) this.startRound(true);
      return;
    }
    if (this.phase !== "live") return;
    // "Fielded" is read live, not latched at the round's start: on the server
    // round 1 opens while the lobby is still filling, and a team that never
    // had anybody (a solo test, a half lobby) cannot be "eliminated".
    const alive = this.aliveByTeam();
    const fielded = this.fieldedByTeam();
    const wiped0 = fielded[0] > 0 && alive[0] === 0;
    const wiped1 = fielded[1] > 0 && alive[1] === 0;
    if (wiped0 || wiped1) {
      this.endRound(wiped0 && wiped1 ? -1 : wiped0 ? 1 : 0);
      return;
    }
    this.remain = Math.max(0, this.remain - dt);
    if (this.remain <= 0) this.endRound(alive[0] > alive[1] ? 0 : alive[1] > alive[0] ? 1 : -1);
  }

  nextRand(): number {
    this.rng = (this.rng * 1664525 + 1013904223) >>> 0;
    return this.rng / 0xffffffff;
  }

  /**
   * Roster add. Every body is the PEEL BRUISER operator (the `_op` argument is
   * accepted positionally for the legacy call sites and ignored).
   *
   * `primary` picks the primary slot (an id from PRIMARY_WEAPON_IDS: "ar",
   * "smg", "sniper"); anything else — the qa harnesses still pass the old
   * "m4a1" — gets the default AR. The secondary is always the pistol. A body
   * that wants a different kit later calls setLoadout (applies at next spawn).
   */
  addPlayer(
    id: string,
    name: string,
    _op: string,
    team: Team,
    primary: string,
    _legacySecondary: string,
    bot: boolean,
  ): SimPlayer {
    const loadout = sanitizeLoadout({
      primary: PRIMARY_WEAPON_IDS.includes(primary) ? primary : bot ? botPrimary(id) : DEFAULT_LOADOUT.primary,
    });
    const p: SimPlayer = {
      id,
      name,
      op: "bruiser",
      team,
      bot,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      hp: 100,
      weapon: loadout.primary,
      ammo: 0,
      reserve: 0,
      alt: loadout.secondary,
      altAmmo: 0,
      altRes: 0,
      gun: 0,
      gunWeapon: this.gunGame ? gunFor(0) : "",
      loadout,
      nextLoadout: null,
      heat: 0,
      shotAgo: 9,
      armed: true,
      cook: 0,
      cookAt: 0,
      ads: 0,
      wantAds: false,
      sprint: false,
      tac: false,
      crouch: false,
      onGround: true,
      slide: 0,
      slideVx: 0,
      slideVz: 0,
      reload: 0,
      fireCd: 0,
      pump: false,
      swap: 0,
      protect: 0,
      dead: 0,
      alive: false,
      kills: 0,
      deaths: 0,
      streak: 0,
      score: 0,
      lastHit: "",
      lastHitAt: 0,
      regenT: 0,
      scavT: 0,
      ping: bot ? 28 + (this.nextRand() * 40) | 0 : 0,
      seq: 0,
      botT: 0,
      botTarget: null,
      botWp: (this.nextRand() * WAYPOINTS.length) | 0,
      botReact: 0,
      botAimY: 0,
      botAimP: 0,
      uav: 0,
      sprintOut: 0,
      tacFuel: TAC_FUEL,
      firing: false,
      lastShotOx: 0,
      lastShotOy: 0,
      lastShotOz: 0,
      lastShotDx: 0,
      lastShotDy: 0,
      lastShotDz: 1,
      nades: NADE_AMMO,
      nadeCd: 0,
      nadeUp: false,
      // OPENS EMPTY. Trigger clock is earned, never granted.
      //
      // It used to open at CMD_BANK on the argument that the reserve absorbs
      // jitter between a 64 Hz sender and a host tick that is not exactly 64 Hz.
      // The reserve does do that — but a full one on JOIN is half a second of
      // gun clock nobody paid for, and it is spendable immediately: measured
      // against the real server over raw WebSockets, a client posting 192 cmd/s
      // took 19 shots in its first wall-second against a 13.33/s design (1.43x)
      // before settling to <=14, and CMD_BANK/shotInterval = 0.5/0.075 = 6.67 is
      // exactly the excess. Steady state was always 1.0x by construction; this
      // was a one-time opening burst, available on every fresh connection and so
      // on every reconnect.
      //
      // Nothing starves for want of it. server/index.ts banks on the WALL clock
      // BEFORE its drain loop in the same tick, so the very first command of the
      // very first tick is already funded, and the jitter reserve refills at real
      // time from there. qa/hitlab's rate-cheat block now asserts the first
      // second as well as the ten-second mean, because the mean never saw this.
      cmdBank: 0,
      // Travel opens empty for the same reason: the ghost seeds both banks
      // from PredictionState (server-funded), never from a grant.
      moveBank: 0,
      badOrigin: 0,
      originClamped: 0,
      netFed: false,
      bench: false,
      sitOut: false,
    };
    fillAmmo(p);
    this.players.set(id, p);
    this.spawn(p);
    return p;
  }

  remove(id: string): void {
    this.players.delete(id);
  }

  /**
   * THE LOBBY CHANGED MODE before the match. Every body is re-armed for it:
   * the ladder's gun in GUN GAME, its own loadout otherwise.
   */
  setMode(mode: "tdm" | "ffa", gunGame: boolean): void {
    this.mode = mode;
    this.gunGame = mode === "ffa" && gunGame;
    if (this.time === 0 && !this.roundBased) this.remain = matchTimeFor(mode);
    for (const p of this.players.values()) {
      p.gun = 0;
      p.gunWeapon = this.gunGame ? gunFor(0) : "";
      if (p.alive && p.cook <= 0) equip(p);
    }
  }

  /**
   * A player picked a new loadout. Sanitized here, whatever the caller already
   * did. In a live match it is parked until this body's next spawn (CoD rule:
   * no mid-life gun swap from a menu). Before the match goes live — the lobby,
   * the 3-2-1 — the yard has not started, so the body re-equips at once and
   * walks into the countdown carrying what it picked.
   */
  setLoadout(p: SimPlayer, l: unknown): void {
    const next = sanitizeLoadout(l);
    if (this.phase !== "live" && p.cook <= 0) {
      p.loadout = next;
      p.nextLoadout = null;
      equip(p);
      return;
    }
    p.nextLoadout = next;
  }

  /**
   * ROLL A FRESH MATCH IN THE SAME SESSION — and why a room that never gets one
   * is a room that dies.
   *
   * `step()` opens with `if (this.over) return`, so the instant a match ends the
   * session stops advancing: `tick` freezes, and server/index.ts publishes a
   * snapshot on `tick % SNAP_EVERY === 0`, which a frozen tick either satisfies
   * forever or never again. Measured on the running dev server, whose 24/7 yard
   * had been up long enough to spend its ten minutes: a fresh seat — a browser
   * and a raw WebSocket alike — got `welcome`, got the roster, and then received
   * ZERO snapshots, with players.size stuck at 0 and no body to play. The room
   * was a corpse and every arrival after the first ten minutes inherited it.
   *
   * So the room that is never supposed to close gets the next match instead
   * (server/index.ts, DEFAULT_ROOM). Same session, same seats, same sockets, same
   * bots — nobody is disconnected and nothing is re-created. `time` and `tick`
   * deliberately keep running: they are the clock the rewind buffer and the
   * interpolator are stamped against, and resetting them would hand every
   * connected client a timestamp from before the one it is drawing.
   */
  nextMatch(): void {
    this.over = false;
    this.remain = matchTimeFor(this.mode);
    this.score0 = 0;
    this.score1 = 0;
    this.phase = "live";
    this.liveAt = 0;
    this.uavUntil = [0, 0];
    this.nades.length = 0;
    // Round-based rooms reopen at round 1 on the next tick (tickRounds).
    this.round = 0;
    this.roundState = "live";
    this.roundWinner = -1;
    this.roundEndsAt = 0;
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.streak = 0;
      p.score = 0;
      p.gun = 0;
      if (p.gunWeapon) p.gunWeapon = gunFor(0);
      p.uav = 0;
      p.hp = 100;
      p.dead = 0;
      p.nades = NADE_AMMO;
      fillAmmo(p);
      this.spawn(p);
    }
    this.events.push({ t: "match", state: "live", score0: 0, score1: 0 });
  }

  spawn(p: SimPlayer): void {
    // A body that sat a round out is back in the yard the moment it is spawned.
    p.sitOut = false;
    // THE POOL. Shipment: the authored points, team-filtered, exactly as
    // shipped. On a stacked-floors map (dust2) the authored twelve are only the
    // seed: FFA draws from a map-wide pool of validated nav nodes and team modes
    // from the authored side plus the nav nodes around it — see spawnPool().
    let pool: Spawn[] = STACKED_FLOORS ? spawnPool(this.mode, p.team) : SPAWNS.filter((s) => (this.mode === "ffa" ? true : s.team === p.team));
    // Never respawn on top of your own corpse: drop points within 5m of the
    // death spot when any alternative exists.
    const farPool = pool.filter((s) => Math.hypot(p.x - s.x, p.z - s.z) >= 5);
    if (farPool.length) pool = farPool;
    // FARTHEST-POINT PREFILTER. A 300-point dust2 pool scored in full is
    // 300 x 14 traceWorld calls per spawn, 15 of them back-to-back at round
    // start. The score below is `minD` minus non-negative penalties, so no
    // point outside the top-N by minD can beat a penalty-free point inside it;
    // ranking by the cheap term first and tracing only those keeps the answer
    // and drops the cost. Pools of authored size never reach this branch.
    if (pool.length > SPAWN_TRACE_TOP) {
      const scored = pool.map((s) => {
        let minD = 1e9;
        for (const o of this.players.values()) {
          if (!o.alive || o.id === p.id) continue;
          if (this.mode !== "ffa" && o.team === p.team) continue;
          minD = Math.min(minD, Math.hypot(o.x - s.x, o.z - s.z));
        }
        return { s, minD };
      });
      scored.sort((a, b) => b.minD - a.minD);
      pool = scored.slice(0, SPAWN_TRACE_TOP).map((e) => e.s);
    }
    let best = pool[0]!;
    let bestScore = -1e9;
    for (const s of pool) {
      let minD = 1e9;
      let los = 0;
      // This candidate's own eye height, resolved once per candidate rather
      // than once per enemy (stacked-floors maps only).
      let sEye: number | null = null;
      for (const o of this.players.values()) {
        if (!o.alive || o.id === p.id) continue;
        if (this.mode !== "ffa" && o.team === p.team) continue;
        const d = Math.hypot(o.x - s.x, o.z - s.z);
        minD = Math.min(minD, d);
        // SPAWN LINE OF SIGHT (spec-sim-implemented.md P6).
        //
        // FLAT RAY, y = 1.5, dy = 0 — the shipped Shipment behaviour, and
        // correct there: one deck, 33 m across, every eye within 15 cm of that
        // height. It is kept EXACTLY as it was on any map that says it has no
        // stacked floors, because `los` feeds the spawn score and moving a
        // Shipment spawn is the one thing this build may not do.
        //
        // On a map with 15 m of relief a flat ray at a fixed world height is
        // nonsense in both directions: it starts underground where the floor is
        // above 1.5 m, sails over the roof where the floor is below it, and it
        // aims at a point that is nobody's head. So where `stackedFloors` says
        // the map is layered, the ray runs eye to eye — from this spawn point's
        // own floor (the one reachable from its authored `y`, so a B-tunnels
        // point is not traced from the platform roof) to the enemy's actual eye
        // — and "can I be seen from here" becomes the question it was always
        // meant to be.
        let vis: number;
        if (STACKED_FLOORS && d > SPAWN_LOS_RANGE) {
          // A body 40+ m away on dust2 is a silhouette, not a spawn kill, and
          // its trace is the single most expensive thing in this loop (15 bodies
          // x 24 candidates x a 100 m ray at round start). Distance already
          // pays that enemy off in `minD`; the LOS penalty is for the close ones.
          vis = 0;
        } else if (STACKED_FLOORS) {
          if (sEye === null) sEye = groundHeight(s.x, s.z, SOLIDS, walkFromY(s.y)) + EYE;
          const sy = sEye;
          const ey = this.eyeY(o);
          const dy = ey - sy;
          const L = Math.hypot(d, dy) || 1;
          const tr = traceWorld(s.x, sy, s.z, (o.x - s.x) / L, dy / L, (o.z - s.z) / L, L);
          vis = tr.t >= L - 0.4 ? 1 : 0;
        } else {
          const tr = traceWorld(s.x, 1.5, s.z, (o.x - s.x) / (d + 0.01), 0, (o.z - s.z) / (d + 0.01), d);
          vis = tr.t >= d - 0.4 ? 1 : 0;
        }
        los += vis;
      }
      // Keep first frames clean: penalize spawns crowded by ANY body (teammates too).
      let minAny = 1e9;
      for (const o of this.players.values()) {
        if (!o.alive || o.id === p.id) continue;
        minAny = Math.min(minAny, Math.hypot(o.x - s.x, o.z - s.z));
      }
      // Hard-avoid occupied points (guns in the first frame), softly spread out,
      // and bias away from where this player just died.
      const deadHere = Math.hypot(p.x - s.x, p.z - s.z);
      const score =
        minD -
        los * 6 -
        Math.max(0, 1.6 - minAny) * 60 -
        Math.max(0, 3.0 - minAny) * 8 -
        Math.max(0, 6 - deadHere) * 1.5 +
        this.nextRand();
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    p.x = best.x + (this.nextRand() - 0.5) * 0.4;
    p.z = best.z + (this.nextRand() - 0.5) * 0.4;
    // Round-start spawns resolve back-to-back on a small point pool: shove this
    // body away from the nearest occupant so nobody materializes in a face.
    let nearO: SimPlayer | null = null;
    let nearD = 1e9;
    for (const o of this.players.values()) {
      if (!o.alive || o.id === p.id) continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      if (d < nearD) {
        nearD = d;
        nearO = o;
      }
    }
    if (nearO && nearD < 1.6) {
      const push = 1.6 - nearD + 0.2;
      const nx = nearD > 0.01 ? (p.x - nearO.x) / nearD : Math.cos(p.yaw);
      const nz = nearD > 0.01 ? (p.z - nearO.z) / nearD : Math.sin(p.yaw);
      p.x += nx * push;
      p.z += nz * push;
    }
    // The authored `Spawn.y` finally does something on a map with stacked
    // floors: it is the height the body materialises AT, so `groundHeight` is
    // asked for the floor reachable from there rather than the highest climb top
    // anywhere over this footprint. On dust2 that is the difference between
    // spawning in B tunnels and spawning on the roof of them.
    //
    // `walkFromY` returns Infinity on Shipment, so this line is byte-for-byte
    // the old `groundHeight(p.x, p.z)` there. It has to be: spawn() has no
    // clearance check, the anti-crowd shove reaches 1.8 m, and one Shipment
    // spawn sits 1.65 m from the forklift — whose 1.90 m climb top is exactly a
    // cell where a real fromY would answer differently. See MapDef.stackedFloors.
    p.y = groundHeight(p.x, p.z, SOLIDS, walkFromY(best.y));
    if (STACKED_FLOORS) {
      // FEET ON THE GROUND, OR NOT AT ALL. The jitter and the shove above were
      // sized for Shipment's open yard; on dust2 1.8 m is enough to carry a body
      // off a ledge, into a wall, or over the drop into B tunnels. So the final
      // footprint is checked — in bounds, standing room clear, and still on the
      // point's own floor — and each failure steps back: to the unshoved point,
      // then to the best authored spawn that passes. A body never materialises
      // in the air or inside geometry because a shove said so.
      const y0 = spawnFootY(p.x, p.z, best.y);
      if (y0 !== null) p.y = y0;
      else {
        const y1 = spawnFootY(best.x, best.z, best.y);
        if (y1 !== null) {
          p.x = best.x;
          p.z = best.z;
          p.y = y1;
        } else {
          let fb: Spawn | null = null;
          let fbD = -1;
          let fbY = 0;
          for (const s of SPAWNS) {
            if (this.mode !== "ffa" && s.team !== p.team) continue;
            const y = spawnFootY(s.x, s.z, s.y);
            if (y === null) continue;
            let minAny = 1e9;
            for (const o of this.players.values()) {
              if (!o.alive || o.id === p.id) continue;
              minAny = Math.min(minAny, Math.hypot(o.x - s.x, o.z - s.z));
            }
            if (minAny > fbD) {
              fbD = minAny;
              fb = s;
              fbY = y;
            }
          }
          if (fb) {
            best = fb;
            p.x = fb.x;
            p.z = fb.z;
            p.y = fbY;
          }
        }
      }
    }
    p.yaw = best.yaw;
    p.pitch = 0;
    p.vx = p.vy = p.vz = 0;
    p.hp = 100;
    // A fresh body has taken no damage: the regen clock starts here, so nothing
    // carries a half-elapsed delay out of the life that just ended.
    p.regenT = 0;
    // THE COMMAND CLOCK RESTARTS HERE (review HIGH): cmdBank is earned time, and
    // a corpse banks it while dead — without a reset the next life opens with a
    // funded burst (the same class the server's moveBank reset on death closes
    // for travel). nextMatch() spawns every body, so the rollover inherits this.
    p.cmdBank = 0;
    // Travel restarts with it: the seat bank is zeroed on death server-side,
    // and the ghost re-seeds from the next snapshot's PredictionState.
    p.moveBank = 0;
    p.alive = true;
    p.dead = 0;
    p.protect = SPAWN_PROTECT;
    p.slide = 0;
    p.reload = 0;
    p.ads = 0;
    // Frags are a per-life resource: restocked on every respawn, never picked up.
    p.nades = NADE_AMMO;
    p.nadeCd = 0;
    p.nadeUp = false;
    // THE LOADOUT LANDS HERE, AND ONLY HERE (CoD rule): a change made mid-life
    // waits for the next spawn. Every life opens on the primary, fully stocked.
    equip(p);
    this.events.push({ t: "spawn", id: p.id, x: p.x, y: p.y, z: p.z });
  }

  eyeY(p: SimPlayer): number {
    if (p.slide > 0) return p.y + SLIDE_EYE;
    if (p.crouch) return p.y + CROUCH_EYE;
    return p.y + EYE;
  }

  hitbox(p: Pick<SimPlayer, "y" | "crouch" | "slide">): { y: number; h: number } {
    if (p.slide > 0) return { y: p.y + SLIDE_H * 0.5, h: SLIDE_H };
    if (p.crouch) return { y: p.y + CROUCH_H * 0.5, h: CROUCH_H };
    return { y: p.y + STAND_H * 0.5, h: STAND_H };
  }

  applyInput(p: SimPlayer, cmd: InputCmd, rewind = true): void {
    sanitizeCmd(cmd);
    p.seq = cmd.seq;
    // A consumed command is acknowledged even when its body is dead. Otherwise
    // the client replays a whole corpse's input backlog onto the next life.
    if (!p.alive) return;
    // SEMI/BOLT TRIGGER DISCIPLINE, server-side. A released button re-arms the
    // trigger; tryFire spends the arm. Holding fire is one shot, and a press that
    // lands inside the fire interval fires the moment the gun is ready (the arm
    // waits) — never a free extra round. predictMovement mirrors this line.
    if (!cmd.fire) p.armed = true;
    p.yaw = cmd.yaw;
    p.pitch = clamp(cmd.pitch, -1.45, 1.45);
    p.wantAds = cmd.ads && p.slide <= 0 && p.reload <= 0;
    // THE INPUT GATE. Before "live" the yaw and pitch above have already landed
    // — LOOK IS NEVER LOCKED, so a player spends the 3-2-1 settling their
    // crosshair and picking a lane exactly as they would in any shooter — and
    // everything else is dropped: no movement, no jump, no crouch, no slide, no
    // trigger, no melee, no frag, no reload, no weapon swap.
    //
    // The command is still ACCEPTED (p.seq advanced, the aim applied) rather
    // than refused, because the seq is the ack the client reconciles against:
    // refusing 200 commands would leave every one of them unacked in the
    // client's pending queue to be replayed at "GO" as a 3-second burst of
    // stored movement. FROZEN is a module-level scratch, mutated in place, so a
    // gated tick allocates nothing.
    if (inputLocked(this.phase)) {
      FROZEN.seq = cmd.seq;
      FROZEN.yaw = p.yaw;
      FROZEN.pitch = p.pitch;
      // A zero-input move still integrates: friction bleeds any velocity a
      // spawn shove left behind and gravity keeps the body on the ground.
      movePlayer(p, FROZEN, TICK_DT);
      p.firing = false;
      p.nadeUp = false;
      return;
    }
    // weapons stream: 1/2 / wheel / Y — the swap (validated: only ever to the holstered gun).
    trySwap(p, cmd.weapon);
    if (cmd.reload) startReload(p);
    movePlayer(p, cmd, TICK_DT);
    p.firing = false;
    // FRAG: pin, cook, throw — or the hand. One pair of paws: a pulled pin
    // locks out the gun until it has left.
    const cooking = p.cook > 0;
    const verdict = stepCook(p, cmd);
    if (!cooking && p.cook > 0) p.cookAt = this.time;
    p.nadeUp = p.cook > 0;
    if (verdict === 1) {
      this.throwNade(p, cmd, NADE_FUSE - p.cook);
      return;
    }
    if (verdict === 2) {
      this.handBoom(p);
      return;
    }
    if (p.nadeUp) return;
    if (cmd.melee) this.tryMelee(p);
    else if (cmd.fire) this.tryFire(p, cmd, rewind);
  }

  /**
   * Release a frag with `fuse` seconds left on it. Origin/direction come from
   * the command (the same validated eye-ray tryFire uses) so the frag leaves
   * where the client drew it. The pin is already out, so a bad origin does not
   * refuse the throw — it is thrown from the eye the server integrated.
   */
  throwNade(p: SimPlayer, cmd: InputCmd, fuse: number): void {
    if (!p.alive || p.nades <= 0) {
      p.cook = 0;
      p.nadeUp = false;
      return;
    }
    const ey = this.eyeY(p);
    let ox = Number.isFinite(cmd.ox) ? cmd.ox : p.x;
    let oy = Number.isFinite(cmd.oy) ? cmd.oy : ey;
    let oz = Number.isFinite(cmd.oz) ? cmd.oz : p.z;
    // Same anti-teleport guard as tryFire — and the wall test with it. 1.35 m
    // of slack is a whole wall thickness plus change, so a modified client could
    // post an origin INSIDE the steel; the eye the server integrated is the
    // anchor of record, and an origin it cannot see is not an origin.
    if (Math.hypot(ox - p.x, oz - p.z) > 1.35 || Math.abs(oy - ey) > 1.1 || !segmentClear(p.x, ey, p.z, ox, oy, oz)) {
      ox = p.x;
      oy = ey;
      oz = p.z;
    }
    let dx = cmd.dx;
    let dy = cmd.dy;
    let dz = cmd.dz;
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 0.2) {
      const a = aimDir(p.yaw, p.pitch);
      dx = a.dx;
      dy = a.dy;
      dz = a.dz;
    } else {
      dx /= dl;
      dy /= dl;
      dz /= dl;
    }
    p.nades -= 1;
    p.nadeCd = NADE_CD;
    p.nadeUp = false;
    p.cook = 0;
    p.sprint = false;
    const s = nadeSpawn(ox, oy, oz, dx, dy, dz);
    const n: SimNade = {
      id: ++this.nadeSeq,
      owner: p.id,
      team: p.team,
      fuse: Math.max(TICK_DT, fuse),
      spin: 0,
      x: s.x,
      y: s.y,
      z: s.z,
      vx: dx * NADE_SPEED + p.vx * NADE_INHERIT,
      vy: dy * NADE_SPEED + NADE_UP,
      vz: dz * NADE_SPEED + p.vz * NADE_INHERIT,
      grounded: false,
      asleep: false,
    };
    this.nades.push(n);
    this.events.push({
      t: "nade",
      id: n.id,
      src: p.id,
      x: n.x,
      y: n.y,
      z: n.z,
      vx: n.vx,
      vy: n.vy,
      vz: n.vz,
    });
  }

  /** Legacy entry point (qa harnesses): an uncooked throw, full fuse. */
  tryThrow(p: SimPlayer, cmd: InputCmd): void {
    if (!p.alive || p.nades <= 0 || p.nadeCd > 0) return;
    this.throwNade(p, cmd, NADE_FUSE);
  }

  /**
   * COOKED TO ZERO. The frag goes off in the thrower's paw: a real blast at the
   * hand (everyone around takes it, walls still cover them) and the holder does
   * not survive it — it is a suicide, scored as one.
   */
  handBoom(p: SimPlayer): void {
    p.cook = 0;
    p.nadeUp = false;
    p.nadeCd = NADE_CD;
    if (p.nades > 0) p.nades -= 1;
    const ey = this.eyeY(p);
    const a = aimDir(p.yaw, p.pitch);
    const at = nadeSpawn(p.x, ey, p.z, a.dx, a.dy, a.dz);
    this.explode({
      id: ++this.nadeSeq,
      owner: p.id,
      team: p.team,
      fuse: 0,
      spin: 0,
      x: at.x,
      y: at.y,
      z: at.z,
      vx: 0,
      vy: 0,
      vz: 0,
      grounded: false,
      asleep: true,
      inHand: true,
    });
  }

  /**
   * MARTYRDOM, CoD's rule: a body that dies with the pin out drops the live
   * frag at its feet with whatever fuse it had left. Called from every death
   * path (kill, suicide) before the body is laid down.
   */
  private dropCooked(p: SimPlayer): void {
    if (p.cook <= 0) return;
    const fuse = Math.max(TICK_DT, NADE_FUSE - p.cook);
    p.cook = 0;
    p.nadeUp = false;
    if (p.nades > 0) p.nades -= 1;
    const n: SimNade = {
      id: ++this.nadeSeq,
      owner: p.id,
      team: p.team,
      fuse,
      spin: 0,
      // Inside the dead body's own capsule, which the sim guarantees is clear of
      // every solid: it falls out of the paw and rolls where it lands.
      x: p.x,
      y: p.y + 0.62,
      z: p.z,
      vx: p.vx * 0.25,
      vy: 0.8,
      vz: p.vz * 0.25,
      grounded: false,
      asleep: false,
    };
    this.nades.push(n);
    this.events.push({ t: "nade", id: n.id, src: p.id, x: n.x, y: n.y, z: n.z, vx: n.vx, vy: n.vy, vz: n.vz });
  }

  stepNades(dt: number): void {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i]!;
      const hard = stepNadeBody(n, dt);
      if (!n.asleep) n.spin += NADE_SPIN * dt;
      // Only report bounces you could actually hear.
      if (hard > 1.6) {
        const at = lastNadeHit();
        this.events.push({ t: "bounce", id: n.id, x: at.x, y: at.y, z: at.z, hard });
      }
      n.fuse -= dt;
      if (n.fuse <= 0) {
        this.nades.splice(i, 1);
        this.explode(n);
      }
    }
  }

  /**
   * Radial damage with a shaped falloff (table on NADE_DMG_MAX): lethal out to
   * ~2.5 m, ~20 at the 6 m rim. Line of sight is checked against the same
   * colliders bullets use, so a container wall is real cover.
   */
  explode(n: SimNade): void {
    this.events.push({ t: "boom", id: n.id, src: n.owner, x: n.x, y: n.y, z: n.z });
    const src = this.players.get(n.owner) ?? null;
    for (const o of this.players.values()) {
      if (!o.alive || o.protect > 0) continue;
      const self = o.id === n.owner;
      if (!self && src && this.mode !== "ffa" && o.team === src.team) continue;
      const hb = this.hitbox(o);
      // Nearest point on the victim's vertical body segment (hb.h is full height).
      const cy = clamp(n.y, o.y + 0.12, o.y + hb.h - 0.12);
      const dx = o.x - n.x;
      const dy = cy - n.y;
      const dz = o.z - n.z;
      const d = Math.hypot(dx, dy, dz);
      // NaN-POISON GUARD (security HIGH-1): a non-finite blast distance fails
      // every comparison below (d > R is false for NaN) and would otherwise
      // flow into k/dmg as NaN, poisoning hp with NaN. Inputs are sanitized at
      // ingress so this is unreachable — it is the last net, not the fence.
      if (!Number.isFinite(d)) continue;
      if (d > NADE_DMG_R) continue;
      if (d > 0.35 && !blastSees(n, o.x, cy, o.z, d)) continue;
      const k = clamp(d / NADE_DMG_R, 0, 1);
      let dmg = NADE_DMG_MIN + (NADE_DMG_MAX - NADE_DMG_MIN) * Math.pow(1 - k, NADE_DMG_POW);
      if (self) dmg *= NADE_SELF;
      // Cooked to zero: the frag was IN this paw. Nobody survives that.
      if (self && n.inHand) dmg = Math.max(dmg, Math.ceil(o.hp) + 1);
      dmg = Math.round(dmg);
      if (dmg <= 0) continue;
      o.hp -= dmg;
      o.regenT = 0;
      if (!self) {
        o.lastHit = n.owner;
        o.lastHitAt = this.time;
      }
      const kill = o.hp <= 0;
      // Damage number sits on the victim, pulled a touch toward the blast.
      const pull = d > 0.01 ? 0.3 / d : 0;
      this.events.push({
        t: "hit",
        src: n.owner,
        dst: o.id,
        dmg,
        head: false,
        x: o.x - dx * pull,
        y: cy,
        z: o.z - dz * pull,
        kill,
      });
      if (!kill) continue;
      if (self || !src) this.suicide(o, "nade");
      else this.kill(src, o, "nade", false);
    }
  }

  /** Mashed by your own nana: a death and a score penalty, never a kill credit. */
  suicide(p: SimPlayer, weapon: string): void {
    this.dropCooked(p);
    p.alive = false;
    p.hp = 0;
    p.dead = RESPITE;
    p.deaths += 1;
    p.streak = 0;
    p.score = Math.max(0, p.score - 50);
    this.events.push({ t: "kill", src: p.id, dst: p.id, weapon, head: false, medal: "" });
  }

  tryMelee(p: SimPlayer): void {
    const w = WEAPON_BY_ID.knife;
    if (p.fireCd > 0) return;
    p.fireCd = shotInterval(w);
    const ox = p.x;
    const oy = this.eyeY(p);
    const oz = p.z;
    const { dx, dy, dz } = aimDir(p.yaw, p.pitch);
    this.castShots(p, w, ox, oy, oz, dx, dy, dz, false);
  }

  tryFire(p: SimPlayer, cmd: InputCmd, rewind: boolean): void {
    const w = WEAPON_BY_ID[p.weapon];
    if (!w || w.fire === "melee") return;
    // Semi/bolt: one round per pull, enforced here and not on trust (see the
    // arm in applyInput).
    if (w.fire !== "auto" && !p.armed) return;
    if (!canFire(p, w)) return;
    if (w.mag > 0 && p.ammo <= 0) {
      startReload(p);
      return;
    }
    // ANTI-TELEPORT: the muzzle the client claims has to be on the body the
    // server has. This runs BEFORE the round and the fire interval are spent.
    // It used to run after them, so a command with a stale or malformed origin
    // silently burned ammunition and a whole fire interval and emitted no
    // `shot` event at all — a dry fire the player could neither see nor
    // diagnose, and a probe sending 120 such commands got 0 shots and no clue
    // why. A rejected origin now costs the player nothing and is counted.
    const ey = this.eyeY(p);
    let ox = Number.isFinite(cmd.ox) ? cmd.ox : p.x;
    let oy = Number.isFinite(cmd.oy) ? cmd.oy : ey;
    let oz = Number.isFinite(cmd.oz) ? cmd.oz : p.z;
    if (Math.hypot(ox - p.x, oz - p.z) > 1.35 || Math.abs(oy - ey) > 1.1) {
      this.badOrigin++;
      p.badOrigin++;
      return;
    }
    // ...AND THE ORIGIN HAS TO BE SOMEWHERE THIS BODY CAN SEE. The distance test
    // above is not a wall test: 1.35 m of lateral slack is a whole container wall
    // plus change, so a modified client could post a muzzle on the FAR SIDE of
    // the steel it is standing flush against and take a shot down a sightline its
    // own eye does not have. Measured on the shipped sim before this line existed
    // (qa/rewind-guard `origin-through`, and a full-map sweep: 2607 blocked
    // sightlines between two legal stand lines 2.4 m apart, honest shot from the
    // integrated eye BLOCKED) — pushing the origin 1.2 m along the shooter's
    // facing turned 952 of them, 36.5%, into hits.
    //
    // tryThrow has had exactly this guard since P3 with a comment claiming "one
    // the hitscan path does not need". It needed it. Same tolerance, same
    // fallback: the eye the SERVER integrated is the anchor of record, and an
    // origin it cannot see is not an origin — the shot still fires, from that eye.
    // Falling back rather than refusing is deliberate: an honest client whose
    // predicted eye has drifted a few centimetres into a crate must not lose the
    // round, and a forged origin gains nothing by being posted, so there is no
    // incentive either way.
    if (!segmentClear(p.x, ey, p.z, ox, oy, oz)) {
      this.originClamped++;
      p.originClamped++;
      ox = p.x;
      oy = ey;
      oz = p.z;
    }
    // FIRE-INTERVAL ACCUMULATOR, not a reset. `=` quantised every RPM in the
    // game up to the 64 Hz tick (800 rpm realized as 768; qa/out/rangecard.json
    // CADENCE finding). Adding the interval to whatever negative remainder is
    // left carries the sub-tick fraction forward, so the AVERAGE interval is the
    // designed one — the tick grid still decides individual shots, but it no
    // longer rounds every one of them the same way.
    p.fireCd += shotInterval(w);
    if (w.mag > 0) p.ammo -= 1;
    p.sprint = false;
    p.firing = true;
    if (w.fire !== "auto") p.armed = false;
    // THE SPREAD, DETERMINISTICALLY. The cone is read off the state the round
    // leaves the barrel with (before this shot's bloom), and the direction
    // inside it is a hash of (this player, this command) — so the shooter's
    // client, replaying the same command through predictMovement, puts its
    // tracer and its predicted hitmarker on exactly this ray.
    const d = fireDir(p, w, cmd.seq, cmd.dx, cmd.dy, cmd.dz);
    const dx = d.dx;
    const dy = d.dy;
    const dz = d.dz;
    p.lastShotOx = ox;
    p.lastShotOy = oy;
    p.lastShotOz = oz;
    p.lastShotDx = dx;
    p.lastShotDy = dy;
    p.lastShotDz = dz;
    this.events.push({ t: "shot", src: p.id, ox, oy, oz, dx, dy, dz, weapon: w.id });
    this.castShots(p, w, ox, oy, oz, dx, dy, dz, rewind ? this.rewindTime(cmd) : this.time, cmd.seq);
  }

  /**
   * PAY REAL TIME INTO A PLAYER'S COMMAND-CLOCK ACCOUNT. The host calls this
   * once per pass with the WALL time actually elapsed (server/index.ts); the
   * offline sim calls it with its own dt from step().
   *
   * The wall clock, never the tick count. That distinction is not cosmetic: the
   * server loop is a setInterval, `setInterval(1000/64)` is rounded to whole
   * milliseconds by the platform, and under a full yard it does not land on
   * 64 Hz. A budget earned per TICK therefore drifts away from the rate an
   * honest 64 Hz client actually sends at — in one direction it starves that
   * client (measured once already on the seat's drain budget: netlab agreement
   * fell to 44%/16% at 120/200 ms, worse than the defect it was written to fix)
   * and in the other it hands out free gun clock. Real elapsed time is the only
   * rate that cannot drift away from the client's.
   */
  bankCommandTime(p: SimPlayer, seconds: number): void {
    p.cmdBank = Math.min(CMD_BANK, p.cmdBank + Math.max(0, seconds));
  }

  /**
   * ONE CLIENT TICK OF ELAPSED TIME, on the clocks a trigger pull is judged
   * against — METERED against the real time this player has banked.
   *
   * Called by the host once for EVERY command it drains (server/index.ts), and
   * once per tick from step() for everything the network does not drive.
   *
   * WHY IT IS PER COMMAND. Movement already advances per COMMAND — applyInput
   * calls movePlayer(p, cmd, TICK_DT) once per command, so three commands
   * drained together integrate three ticks of travel. (One TICK_DT each, NOT
   * cmd.dt: the field rides the wire but the server never reads it, and it is
   * worth saying so out loud because a reader who believes it is integrated will
   * also believe a client can speed-hack by inflating it. It cannot; the only
   * thing that scales a drained command's travel is TICK_DT.)
   * These clocks did not advance per command: they bled
   * once per SERVER tick. On a jittery link (WS is TCP, so a stalled packet
   * head-of-line-blocks the ones behind it and the whole stall arrives as one
   * burst) that put the two out of step, and the gap lands squarely on the
   * trigger: commands the player pulled 94 ms apart were judged against a single
   * tick of a 75 ms fire interval, and the second and third were REFUSED. The
   * shot is not delayed, it is gone — the "I pulled the trigger and nothing came
   * out" half of the P0. qa/hitlab measures it directly: 20 of 335 fire commands
   * (6.0%) dropped on the 200 ms +-40 profile, every one of them to `fireCd`,
   * and 0 with this credited.
   *
   * WHY IT IS METERED. Per-command credit ON TOP OF a per-tick one is not
   * bounded by anything the client pays for: bunching the same 64 commands/s
   * into pairs or triples bought 1.38x and 1.63x the designed 800 rpm on the
   * shipped server (measured over real WebSockets, command rate 64.0/s in every
   * row), and because game.ts's fixed-step accumulator flushes more commands per
   * turn the slower it runs, a 30 fps player got a third more rounds per second
   * than a 60 fps one on the same machine. The bank fixes it by construction:
   * credit can only ever be spent out of real time that was paid in, so the
   * total per wall-second is exactly 1.0 s SUSTAINED for EVERY arrival pattern — evenly
   * spread, bunched, or dumped 16 at a time out of a stall — plus the 0.5 s
   * banked burst on the first flood second after idle (idle-to-full integrates
   * 0.5 + 1.0 = 1.5 s that second).
   *
   * Deliberately NOT everything step() ages. Spawn protection and the UAV are
   * match-state timers on the SERVER's clock, not consequences of this player's
   * input, and shortening a player's own spawn protection because his link
   * stuttered would be a fairness regression, not a fix. What is credited is
   * exactly the set that gates a shot, plus the reload/ADS progression the
   * client is simultaneously predicting.
   */
  creditCommandTime(p: SimPlayer, dt: number): void {
    const g = Math.min(dt, p.cmdBank);
    if (!(g > 0)) return;
    p.cmdBank -= g;
    // Floors one tick BELOW zero so the fire-interval accumulator keeps its
    // remainder, and no further: an idle player can never bank a burst of free
    // shots.
    if (p.fireCd > -g) p.fireCd = Math.max(-g, p.fireCd - g);
    if (p.nadeCd > 0) p.nadeCd = Math.max(0, p.nadeCd - g);
    if (p.swap > 0) p.swap = Math.max(0, p.swap - g);
    if (p.sprintOut > 0) p.sprintOut = Math.max(0, p.sprintOut - g);
    tickAdsReload(p, g);
  }

  /**
   * LAG COMPENSATION — the instant to rewind every other body to for this shot.
   *
   * It is NOT cmd.clientTime, which is what this used to be. clientTime is the
   * shooter's estimate of the server clock NOW; the shooter's SCREEN is a
   * further INTERP_MS behind that, because remote players are drawn out of the
   * snapshot buffer (game.ts interpPlayers). Rewinding to clientTime therefore
   * tested a pose one whole interpolation delay AHEAD of the monkey the shooter
   * had under the crosshair — 0.35 m of lateral error at a 4.35 m/s run,
   * against a body whose hit capsule is 0.64 m across.
   *
   * cmd.rt is the timestamp the client measured on the frame it aimed at (the
   * interpolated snapshot time it actually drew, clamps and buffer hiccups
   * included) rather than a formula the server guesses, so a starved buffer is
   * reported instead of silently costing the shooter the shot. clientTime -
   * INTERP_MS is the reconstruction used for a command with no stamp: bots, the
   * offline sim, and any older client.
   *
   * ANTI-CHEAT: the stamp is a bounded CLAIM. It may not be ahead of its own
   * command and may not sit more than MAX_RENDER_LAG behind it; outside that it
   * is clamped to the edge, and a non-finite one falls back to the
   * reconstruction. That is the whole authority it can ever have — the rewind
   * it buys is then clamped a second time in hitscan() against the server's own
   * clock at REWIND_MS, so the deepest hole any command can dig, honest or
   * forged, is one REWIND_MS window.
   */
  rewindTime(cmd: InputCmd): number {
    const ct = Number.isFinite(cmd.clientTime) ? cmd.clientTime : this.time;
    const rt = cmd.rt as number;
    if (!Number.isFinite(rt)) return ct - INTERP_MS / 1000;
    return clamp(rt, ct - MAX_RENDER_LAG / 1000, ct);
  }

  castShots(
    p: SimPlayer,
    w: WeaponDef,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    at: number | false,
    seq = 0,
  ): void {
    // The first pellet IS the already-spread aim ray (tryFire spread it). Extra
    // pellets — none of today's guns, kept so a shotgun is one table row — fan
    // out on the same deterministic hash, pellet index k.
    this.hitscan(p, w, ox, oy, oz, dx, dy, dz, at);
    for (let k = 1; k < w.pellets; k++) {
      spreadDir(spreadSeed(p.id), seq, k, (w.hip[0] * Math.PI) / 180, dx, dy, dz, PELLET_DIR);
      this.hitscan(p, w, ox, oy, oz, PELLET_DIR.dx, PELLET_DIR.dy, PELLET_DIR.dz, at);
    }
  }

  hitscan(
    src: SimPlayer,
    w: WeaponDef,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    at: number | false,
  ): void {
    const maxT = w.fire === "melee" ? w.reach : 180;
    // PENETRATION (shared/penetration.ts): the round runs on through thin
    // soft walls, so bodies behind them are in reach at reduced damage.
    const path = bulletPath(ox, oy, oz, dx, dy, dz, maxT, w, MAP.id);
    let bestT = path.t;
    let victim: SimPlayer | null = null;
    let hitPose: HitPose | null = null;
    let head = false;

    const when = at === false ? this.time : clamp(at, this.time - REWIND_MS / 1000, this.time);

    for (const o of this.players.values()) {
      if (o.id === src.id || !o.alive) continue;
      if (this.mode !== "ffa" && o.team === src.team) continue;
      const pose = this.poseAt(o, when);
      const t = rayPlayer(ox, oy, oz, dx, dy, dz, pose);
      if (t < bestT) {
        bestT = t;
        victim = o;
        hitPose = pose;
        head = isHeadshot(oy + dy * t, pose);
      }
    }

    if (!victim) return;
    if (victim.protect > 0) return;

    const dist = bestT;
    const hx = ox + dx * bestT;
    const hy = oy + dy * bestT;
    const hz = oz + dz * bestT;
    // Damage zones read off the pose that was actually TESTED, not off the live
    // one: `head` above already came from the rewound body, and scoring a chest
    // against a different (newer) body is how a rewound headshot could land as
    // a limb hit on a victim who has crouched since.
    const zone = hitPose ?? victim;
    const top = zone.y + poseHeight(zone);
    const chest = !head && hy > top - (zone.slide > 0 ? 0.55 : 0.85);
    // THREE ZONES (CoD): head x headMul, upper body (chest, shoulders, arms) x1,
    // lower body and legs x lowerMul — over the gun's range STEP, rounded.
    const keep = keepAt(path, dist);
    const dmg = Math.max(1, Math.round(bulletDamage(w, dist, head ? "head" : chest ? "upper" : "lower") * keep));
    victim.hp -= dmg;
    victim.lastHit = src.id;
    victim.lastHitAt = this.time;
    // Every damage path in this file resets the regen clock, here and in the two
    // blast paths below. Miss one and that source of damage silently heals
    // through itself.
    victim.regenT = 0;
    const kill = victim.hp <= 0;
    this.events.push({
      t: "hit",
      src: src.id,
      dst: victim.id,
      dmg,
      head,
      x: hx,
      y: hy,
      z: hz,
      kill,
      // hitscan runs while src's command is being processed, so src.seq IS
      // that command's seq — the shooter's client dedupes its predicted
      // hitmarker against exactly this number.
      seq: src.seq,
      ...(keep < 1 ? { wall: true } : {}),
    });
    if (kill) this.kill(src, victim, w.id, head);
  }

  /**
   * REBUILD THE BODY THE SHOOTER SAW, at the instant they saw it.
   *
   * This is the server half of client interpolation and it is written to be the
   * SAME arithmetic, because any difference between the two is a shot that
   * looked like a hit and was not. game.ts interpPlayers straddles `when` with
   * the two snapshots either side of it and lerps position between them; so
   * does this. It takes stance from the NEWER of the pair, exactly as the client
   * does (its `{...pb}` spread), rather than switching over at the midpoint —
   * on the tick a body drops into a crouch the two answers differ by 0.56 m of
   * capsule height, and the crown of a head is the part that gets shot at.
   */
  poseAt(p: SimPlayer, when: number): SimPlayer {
    if (when >= this.time - 0.001) return p;
    let a: HistFrame | null = null;
    let b: HistFrame | null = null;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      const f = this.hist[i]!;
      if (f.id !== p.id) continue;
      if (f.time <= when && !a) a = f;
      if (f.time >= when) b = f;
      if (a && b) break;
    }
    // No history either side of `when` — a player who joined or respawned since.
    // The live body is the only pose there is; spawn protection (1.15 s, more
    // than three rewind windows) is what actually keeps that from being shot.
    if (!a && !b) return p;
    if (!a) a = b;
    if (!b) b = a;
    const span = Math.max(1e-4, b!.time - a!.time);
    const t = clamp((when - a!.time) / span, 0, 1);
    return {
      ...p,
      x: lerp(a!.x, b!.x, t),
      y: lerp(a!.y, b!.y, t),
      z: lerp(a!.z, b!.z, t),
      yaw: a!.yaw + angWrap(b!.yaw - a!.yaw) * t,
      crouch: b!.crouch,
      slide: b!.slide,
    };
  }

  kill(src: SimPlayer, dst: SimPlayer, weapon: string, head: boolean): void {
    this.dropCooked(dst);
    dst.alive = false;
    dst.hp = 0;
    dst.dead = RESPITE;
    dst.deaths += 1;
    dst.streak = 0;
    src.kills += 1;
    src.streak += 1;
    src.score += head ? 150 : 100;
    // RESUPPLY ON KILL — KILL_RESUPPLY_MAGS into the RESERVE, capped. The kill
    // pays roughly double what the kill cost (12-16 rounds for 30), which is what
    // makes a streak fund itself instead of ending on an empty gun. It lands in
    // the reserve and never in the magazine: it is ammunition, not a free
    // reload, so the tuned reload still has to be paid for.
    {
      const kw = WEAPON_BY_ID[src.weapon];
      if (kw && kw.mag > 0) {
        src.reserve = Math.min(reserveCap(kw), src.reserve + kw.mag * KILL_RESUPPLY_MAGS);
      }
    }
    // Round-based rooms keep score0/score1 as ROUND WINS (endRound); a kill
    // there is worth nothing on the scorebug and can never end the match.
    if (this.mode !== "ffa" && !this.roundBased) {
      if (src.team === 0) this.score0 += 1;
      else this.score1 += 1;
    } else if (this.mode === "ffa") {
      src.score += 0;
    }
    let medal = weapon === "nade" ? "MASHED BY NANA" : head ? "HEADSHOT" : "KILL";
    if (src.kills === 1 && src.deaths === 0 && this.score0 + this.score1 <= 1) medal = "FIRST BLOOD";
    else if (src.streak === 3) medal = "TRIPLE KILL";
    else if (src.streak === 5) medal = "FURY KILL";
    else if (src.streak === 7) medal = "RELENTLESS";
    else if (src.streak >= 10) medal = "UNSTOPPABLE";
    this.events.push({ t: "kill", src: src.id, dst: dst.id, weapon, head, medal });
    // GUN GAME: the kill moves the killer up the ladder; a knife kill also
    // knocks the victim back one (humiliation). A frag in your own face is not
    // progress.
    if (this.gunGame && src.id !== dst.id) {
      if (weapon === "knife") this.setGun(dst, dst.gun - 1);
      this.setGun(src, src.gun + 1);
    }

    if (src.streak === 3) {
      this.uavUntil[src.team] = this.time + 10;
      src.uav = 10;
      this.events.push({ t: "uav", team: src.team });
    }
    if (src.streak === 5) {
      this.events.push({ t: "strike", x: dst.x, z: dst.z, team: src.team });
      this.artillery(dst.x, dst.z, src);
    }

    const limitHit =
      this.mode !== "ffa"
        ? !this.roundBased && (this.score0 >= SCORE_LIMIT || this.score1 >= SCORE_LIMIT)
        : this.gunGame
          ? src.gun >= GUN_GOAL
          : src.kills >= FFA_KILL_LIMIT;
    if (limitHit) {
      this.over = true;
      this.events.push({ t: "match", state: "end", score0: this.score0, score1: this.score1 });
    }
  }

  /**
   * GUN GAME: set ladder progress. A body whose rung changes while alive gets
   * the new gun in hand at once — raised, full, nothing carried over; a dead
   * one picks it up at its next spawn (equip).
   */
  setGun(p: SimPlayer, level: number): void {
    p.gun = clamp(level, 0, GUN_GOAL);
    const next = gunFor(p.gun);
    if (next === p.gunWeapon) return;
    p.gunWeapon = next;
    if (!p.alive || p.cook > 0) return;
    equip(p);
    p.swap = WEAPON_BY_ID[next]?.swap ?? 0;
    p.fireCd = 0;
    p.ads = 0;
  }

  artillery(x: number, z: number, src: SimPlayer): void {
    for (const o of this.players.values()) {
      if (!o.alive || o.id === src.id) continue;
      if (this.mode !== "ffa" && o.team === src.team) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < 5.5) {
        o.hp -= Math.round(lerp(120, 40, d / 5.5));
        o.regenT = 0;
        if (o.hp <= 0) this.kill(src, o, "strike", false);
      }
    }
  }

  step(dt: number = TICK_DT): void {
    if (this.over) return;
    this.time += dt;
    this.tick += 1;
    // The tick this state goes out on the wire (server/index.ts sends on exactly
    // this test), and therefore the only tick any client can ever have drawn.
    const publish = this.tick % SNAP_EVERY === 0;
    // MATCH PHASE. `time` and `tick` keep running through a countdown — the
    // rewind buffer and the countdown itself are both timestamps off this clock
    // — but nothing that belongs to the MATCH does: the round clock is frozen
    // (a match that has not started has not spent any of its clock) and
    // so is spawn protection, so the 1.15 s of immunity every body is holding
    // when the numerals appear is still there at "GO" instead of having expired
    // during the wait.
    if (this.phase === "countdown" && this.time >= this.liveAt) this.phase = "live";
    const live = this.phase === "live";
    // ROUND-BASED TDM owns the clock and the ending (tickRounds): `remain` is
    // the round clock there and running it out is a round result, not the
    // endcard. Everything else is the 25-or-the-clock match it always was.
    const rounds = this.roundBased;
    if (rounds) {
      this.tickRounds(dt);
    } else if (live) {
      this.remain = Math.max(0, this.remain - dt);
      if (this.remain <= 0) {
        this.over = true;
        this.events.push({ t: "match", state: "end", score0: this.score0, score1: this.score1 });
      }
    }

    for (const p of this.players.values()) {
      if (live && p.protect > 0) p.protect = Math.max(0, p.protect - dt);
      if (p.uav > 0) p.uav = Math.max(0, p.uav - dt);
      // TRIGGER CLOCKS ARE CREDITED ONCE PER CLIENT TICK, FROM ONE PLACE ONLY.
      // A player the network drives (a seat on server/index.ts) is banked on
      // the wall clock and credited by the drain loop, once per command it
      // hands over; crediting it a second time here would add a whole tick per
      // server tick on top of the per-command one, which is exactly the
      // rate-of-fire cheat this bank exists to close — bunching input inflated
      // the total to 1.38x-1.63x the designed rpm. Everything else — bots, the
      // offline sim, the ?test harness — has no such feed and is credited here,
      // exactly as it always was.
      //
      // AND NOT "credit a seat that got no command this tick", which looks like
      // the obvious middle ground and is wrong. It is not wrong because it
      // over-credits — spending from the same bank keeps the wall-second total
      // at 1.0 s either way — it is wrong because it spends the time in the
      // WRONG PLACE. A stall's worth of clock bled while the seat was silent is
      // clock that is no longer there when the stalled commands finally land,
      // and the whole point of the per-command credit is that two trigger pulls
      // the player made 94 ms apart are judged 94 ms apart even though they
      // arrived in the same tick. Banked time waits for the commands it belongs
      // to.
      if (!p.netFed) {
        this.bankCommandTime(p, dt);
        this.creditCommandTime(p, dt);
      }
      if (!p.alive) {
        p.nadeUp = false;
        p.dead -= dt;
        // ONE LIFE PER ROUND: a body downed in a round-based room stays down
        // (bots included — thinkBot never runs on a corpse) until startRound
        // respawns the whole yard.
        if (p.dead <= 0 && !rounds) this.spawn(p);
        continue;
      }
      // THE BOT MIND DOES NOT RUN DURING A COUNTDOWN, and not only to save the
      // work. thinkBot owns a stuck watchdog that anchors on PROGRESS
      // (BOT_TUNING.stuckWin), so 3.2 s of a body that is forbidden to move
      // reads to it as a body that cannot move: it would spend the countdown
      // handing out unstick shoves and inflating BOT_HEALTH.windows, and the
      // yard would go live with ten bots already mid-escape. Its clocks are
      // frozen with it — nothing about the phase gate is a bot-AI change, only
      // whether the AI is asked to think this tick.
      if (p.bot && live) thinkBot(this, p, dt);
      // A pin pulled and then silence: the fuse is on the server's clock too
      // (NADE_COOK_SLACK). Only a client that stopped sending commands mid-cook
      // ever reaches this line.
      if (p.cook > 0 && p.alive && this.time - p.cookAt > NADE_FUSE + NADE_COOK_SLACK) this.handBoom(p);
      // MATCH FEEL: the two clocks a living body carries between fights.
      if (live) {
        this.tickRegen(p, dt);
        this.tickScavenge(p, dt);
      }
      // THE REWIND BUFFER IS THE PUBLISHED PATH, not the simulated one. A client
      // cannot draw a pose it was never sent: it interpolates between the
      // SNAPSHOTS it received (game.ts interpPlayers), which are the states of
      // every SNAP_EVERY-th tick. Recording every tick meant poseAt reconstructed
      // a body along a 64 Hz polyline while the shooter had aimed at a 32 Hz one
      // — the two agree exactly in a straight line and part company by
      // centimetres in a turn, which is the width of the disagreement that was
      // left at the capsule's edge. Sampling here on the publish tick makes the
      // path the server rewinds along the identical polyline the client drew,
      // and costs half the buffer.
      if (publish) {
        this.hist.push({
          time: this.time,
          id: p.id,
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: p.yaw,
          crouch: p.crouch,
          slide: p.slide,
        });
      }
    }
    // Frags fly after the bodies move: a nana that lands this tick sees the
    // positions the shot rays already used.
    if (this.nades.length) this.stepNades(dt);
    // Keep the whole rewind window and a healthy margin past it, DERIVED from
    // the cap rather than a constant beside it: a buffer shorter than REWIND_MS
    // does not fail loudly, it silently clamps the deepest rewinds to the oldest
    // sample it still has and hands those shots a body that was never there.
    const cutoff = this.time - (REWIND_MS / 1000 + 0.5);
    if (this.hist.length > 4000) {
      this.hist = this.hist.filter((h) => h.time >= cutoff);
    } else {
      while (this.hist.length && this.hist[0]!.time < cutoff) this.hist.shift();
    }
  }

  /**
   * HEALTH REGENERATION — the numbers and their reasoning are on REGEN_DELAY.
   *
   * Runs on the sim tick for EVERY living body, player and bot alike, because a
   * rule that only heals the human is not a rule, it is a difficulty setting.
   * The clock is `regenT`, reset to zero by every damage application in this
   * file, so "no damage taken for REGEN_DELAY" is exactly what it says. `hp`
   * stays fractional on purpose: at the opening rate of 10 hp/s a 64 Hz tick is
   * 0.156 hp, and an integer store would round every one of those to zero and
   * stall the ramp before it began. Every readout that shows it rounds.
   */
  tickRegen(p: SimPlayer, dt: number): void {
    p.regenT += dt;
    if (p.hp >= 100 || p.regenT < REGEN_DELAY) return;
    const ramp = Math.min(1, (p.regenT - REGEN_DELAY) / REGEN_RAMP);
    p.hp = Math.min(100, p.hp + lerp(REGEN_RATE0, REGEN_RATE1, ramp) * dt);
  }

  /**
   * THE AMMUNITION FLOOR — see SCAVENGE_CLIP. One clip every SCAVENGE_S while
   * the body holds less than a magazine, and not one round past that: this is a
   * floor, not an income. Nothing accrues while you are holding a full mag, so
   * a camper cannot bank it, and it stops dead at the magazine so it can never
   * substitute for the reserve a life opens with or the resupply a kill pays.
   */
  tickScavenge(p: SimPlayer, dt: number): void {
    const w = WEAPON_BY_ID[p.weapon];
    if (!w || w.mag <= 0) return;
    if (p.ammo + p.reserve >= w.mag) {
      p.scavT = 0;
      return;
    }
    p.scavT += dt;
    if (p.scavT < SCAVENGE_S) return;
    p.scavT = 0;
    p.reserve += Math.min(SCAVENGE_CLIP, w.mag - (p.ammo + p.reserve));
  }

  drainEvents(): NetEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  snap(you = ""): PlayerSnap[] {
    // QUANTISED, like the grenades below always were. Raw doubles serialised
    // 17 significant digits each — measured ~6 KB of JSON per 12-player
    // snapshot, 32 times a second, per client, over TCP: the head-of-line
    // stalls that shipped as "the game feels laggy". 3 dp on position (1 mm)
    // and yaw/pitch (0.06°), 2 dp on the rest, roughly halves the payload with
    // no change any client can render.
    const q3 = (v: number): number => Math.round(v * 1000) / 1000;
    const q2 = (v: number): number => Math.round(v * 100) / 100;
    const out: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      out.push({
        id: p.id,
        seq: p.seq,
        name: p.name,
        op: p.op,
        team: p.team,
        x: q3(p.x),
        y: q3(p.y),
        z: q3(p.z),
        vx: q2(p.vx),
        vy: q2(p.vy),
        vz: q2(p.vz),
        yaw: q3(p.yaw),
        pitch: q3(p.pitch),
        hp: Math.round(p.hp),
        armor: 0,
        weapon: p.weapon,
        ads: q2(p.ads),
        sprint: p.sprint,
        crouch: p.crouch,
        slide: q2(p.slide),
        reload: q2(p.reload),
        firing: p.firing,
        alive: p.alive,
        protect: q2(p.protect),
        kills: p.kills,
        deaths: p.deaths,
        streak: p.streak,
        ping: p.ping,
        ammo: p.ammo,
        reserve: p.reserve,
        nades: p.nades,
        nadeUp: p.nadeUp,
        alt: p.alt,
        altAmmo: p.altAmmo,
        altRes: p.altRes,
        swap: q2(p.swap),
        cook: q2(p.cook),
        gun: p.gun,
        bot: p.bot,
      });
    }
    return out;
  }

  /** Live frags for the snapshot. Undefined when the yard is nana-free. */
  nadeSnap(): NadeSnap[] | undefined {
    if (!this.nades.length) return undefined;
    const out: NadeSnap[] = [];
    for (const n of this.nades) {
      out.push({
        id: n.id,
        src: n.owner,
        x: Math.round(n.x * 1000) / 1000,
        y: Math.round(n.y * 1000) / 1000,
        z: Math.round(n.z * 1000) / 1000,
        spin: Math.round(n.spin * 100) / 100,
        fuse: Math.round(n.fuse * 100) / 100,
        st: n.asleep ? 2 : n.grounded ? 1 : 0,
      });
    }
    return out;
  }
}

function basis(dx: number, dy: number, dz: number): [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }] {
  const up = Math.abs(dy) < 0.95 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const bx = { x: dy * up.z - dz * up.y, y: dz * up.x - dx * up.z, z: dx * up.y - dy * up.x };
  const bl = Math.hypot(bx.x, bx.y, bx.z) || 1;
  bx.x /= bl;
  bx.y /= bl;
  bx.z /= bl;
  const by = { x: dy * bx.z - dz * bx.y, y: dz * bx.x - dx * bx.z, z: dx * bx.y - dy * bx.x };
  return [bx, by, { x: dx, y: dy, z: dz }];
}

/** Paw offset from the eye: forward along aim, out to the right, a touch down. */
const HAND_FWD = 0.42;
const HAND_RIGHT = 0.17;
const HAND_DOWN = 0.1;

/**
 * Where the frag is born: out along the aim ray, offset to the RIGHT paw and a
 * little below the eye, so an overhand throw does not spawn inside the thrower's
 * own face in first person or inside the torso in third.
 *
 * THE WALL CLAMP. The paw offset reaches hypot(0.42, 0.17, 0.1) = 0.464 m, but
 * a player's own collision radius is only 0.30 m — so a man hugging a container
 * wall and aiming across it used to birth the frag on the FAR side of a 0.18 m
 * steel plate, and it flew away from behind cover at full speed. The offset is
 * therefore not a free translation: it is a short TRACE from the eye (a point
 * the sim already guarantees is outside every solid), stopped a frag-radius
 * short of the first surface it meets. Worst case the nana is born right at the
 * bridge of your nose and immediately bounces off the wall you were leaning on,
 * which is exactly what the picture shows.
 *
 * The landing marker calls this same function, so the ring previews the clamped
 * throw — the preview cannot advertise a path the frag will not take.
 */
export function nadeSpawn(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): { x: number; y: number; z: number } {
  // Right vector of the aim ray, flattened (never rolls with pitch).
  let rx = dz;
  let rz = -dx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const fx = dx * HAND_FWD + rx * HAND_RIGHT;
  const fy = dy * HAND_FWD - HAND_DOWN;
  const fz = dz * HAND_FWD + rz * HAND_RIGHT;
  const reach = Math.hypot(fx, fy, fz);
  if (reach < 1e-6) return { x: ox, y: oy, z: oz };
  const ux = fx / reach;
  const uy = fy / reach;
  const uz = fz / reach;
  const probe = reach + NADE_RADIUS;
  const tr = traceWorld(ox, oy, oz, ux, uy, uz, probe, NADE_SOLIDS);
  const t = tr.t < probe ? Math.max(0, tr.t - NADE_RADIUS - 1e-3) : reach;
  return { x: ox + ux * t, y: oy + uy * t, z: oz + uz * t };
}

/**
 * Is the straight line from `a` to `b` free of solids? Used to police the
 * client-supplied throw origin: the eye the server owns is the anchor, and the
 * client only gets to nudge it somewhere that eye can actually see.
 */
function segmentClear(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-4) return true;
  const tr = traceWorld(ax, ay, az, dx / l, dy / l, dz / l, l, NADE_SOLIDS);
  return tr.t >= l - 1e-4;
}

/** Blast line of sight: a container wall between you and the nana saves you. */
function blastSees(n: SimNade, tx: number, ty: number, tz: number, d: number): boolean {
  const inv = 1 / d;
  const tr = traceWorld(n.x, n.y, n.z, (tx - n.x) * inv, (ty - n.y) * inv, (tz - n.z) * inv, d);
  return tr.t >= d - 0.35;
}

export function aimDir(yaw: number, pitch: number): { dx: number; dy: number; dz: number } {
  const cp = Math.cos(pitch);
  return { dx: Math.sin(yaw) * cp, dy: -Math.sin(pitch), dz: Math.cos(yaw) * cp };
}

/**
 * The reserve a life opens with, and the ceiling a resupply can fill to.
 *
 * The MATCH ECONOMY owns these, not weapons.ts. `WeaponDef.reserves` is the
 * weapon's own spec and is kept as a FLOOR so no weapon can ever be given less
 * than its table says; the economy on top of it is stated in magazines
 * (RESERVE_MAGS / RESERVE_CAP_MAGS), because a magazine is the unit the player
 * actually counts and the unit a resupply is paid in. That keeps ballistics
 * (damage, rpm, spread, recoil) and economy (how many rounds a life is worth) in
 * separate files, which is the reason this reads its numbers from up there.
 */
function reserveFor(w: WeaponDef): number {
  return Math.max(w.reserves, w.mag * RESERVE_MAGS);
}

function reserveCap(w: WeaponDef): number {
  return Math.max(reserveFor(w), w.mag * RESERVE_CAP_MAGS);
}

function fillAmmo(p: SimPlayer): void {
  const w = WEAPON_BY_ID[p.weapon];
  if (w) {
    p.ammo = w.mag;
    p.reserve = reserveFor(w);
  }
  const a = WEAPON_BY_ID[p.alt];
  if (a) {
    p.altAmmo = a.mag;
    p.altRes = reserveFor(a);
  }
  p.scavT = 0;
}

/**
 * Put the body's loadout in its hands: a pending loadout change lands first
 * (the CoD rule — a pick made mid-life waits for the next spawn), then the
 * primary is drawn, the pistol holstered, both stocked, every weapon clock
 * cleared.
 */
function equip(p: SimPlayer): void {
  if (p.nextLoadout) {
    p.loadout = p.nextLoadout;
    p.nextLoadout = null;
  }
  p.weapon = p.loadout.primary;
  p.alt = p.loadout.secondary ?? SECONDARY_WEAPON_ID;
  // GUN GAME: one gun, the ladder's — nothing holstered to swap to.
  if (p.gunWeapon) p.weapon = p.alt = p.gunWeapon;
  p.swap = 0;
  p.reload = 0;
  p.heat = 0;
  p.shotAgo = 9;
  p.armed = true;
  p.cook = 0;
  p.cookAt = 0;
  fillAmmo(p);
}

function startReload(p: SimPlayer): void {
  const w = WEAPON_BY_ID[p.weapon];
  if (!w || w.mag <= 0 || p.reload > 0 || p.ammo >= w.mag || p.reserve <= 0) return;
  p.reload = p.ammo <= 0 ? w.emptyReload : w.reload;
  p.wantAds = false;
}

/**
 * Replay a network command in authority order; return whether its gun fired.
 *
 * THIS IS applyInput, LINE FOR LINE, MINUS THE WORLD: the same clocks
 * (creditCommandTime), the same arm, swap, reload, move, cook and trigger in the
 * same order — and the same deterministic spread, written to lastShotD*, so the
 * caller draws the tracer and tests the hitmarker on the ray the server traces.
 */
export function predictMovement(p: SimPlayer, cmd: InputCmd, dt = TICK_DT, live = true): boolean {
  sanitizeCmd(cmd);
  p.seq = cmd.seq;
  if (!p.alive) return false;
  // PRE-LIVE MIRROR (review M2): the authority gates movement/fire/cook behind
  // inputLocked(phase) — aim lands, everything else is a FROZEN friction step
  // (GameSession.applyInput). The old ghost ignored the gate and full-walked
  // the countdown while the server bled velocity, so every client entered GO
  // metres ahead of its body and reconciled. Pass live=false (game.ts passes
  // matchLive()) to replay the same FROZEN step: gun clocks still age (the
  // server credits them per drained command even pre-live), but no
  // movement input, no cook, no trigger. Default true preserves existing
  // offline/harness callers.
  if (!live) {
    // BANKED PRE-LIVE CREDIT (review HIGH): the authority funds pre-live ticks
    // too — stepInputs banks wall time and creditCommandTime spends cmd.dt per
    // drained command even while applyInput runs the FROZEN gate — so raw-dt
    // ageing here spent time nobody banked whenever the account ran dry. The
    // ghost funds TICK_DT per predicted command out of its own cmdBank (seeded
    // 0 on a fresh ghost, exactly like a fresh body) and spends cmd.dt — the
    // same value the authority will spend for this command — through the same
    // floors. At steady 64 Hz 1:1 drain the two are bit-identical; a
    // multi-command drain tick still differs (the server funds per TICK, the
    // ghost per COMMAND), but that gap is bounded by one CMD_BANK and the next
    // ack re-syncs it — and pre-live there is no trigger, cook or movement for
    // it to land on anyway.
    p.cmdBank = Math.min(CMD_BANK, (Number.isFinite(p.cmdBank) ? p.cmdBank : 0) + dt);
    const g = Math.min(cmd.dt, p.cmdBank);
    if (g > 0) {
      p.cmdBank -= g;
      if (p.fireCd > -g) p.fireCd = Math.max(-g, p.fireCd - g);
      if (p.swap > 0) p.swap = Math.max(0, p.swap - g);
      if (p.nadeCd > 0) p.nadeCd = Math.max(0, p.nadeCd - g);
      if (p.sprintOut > 0) p.sprintOut = Math.max(0, p.sprintOut - g);
      tickAdsReload(p, g);
    }
    p.yaw = cmd.yaw;
    p.pitch = clamp(cmd.pitch, -1.45, 1.45);
    FROZEN.seq = cmd.seq;
    FROZEN.yaw = p.yaw;
    FROZEN.pitch = p.pitch;
    // TRAVEL IS METERED TOO (review HIGH-2): the FROZEN friction step still
    // integrates (bleed), so it spends one tick of the ghost travel bank like
    // the authority spends one MOVE_TICK per drained command. Unfunded, the
    // body holds position for this command — the queued command still lands on
    // the next funded tick server-side, and the next ack re-syncs the ghost.
    if (spendTravel(p, TICK_DT)) movePlayer(p, FROZEN, TICK_DT);
    p.nadeUp = false;
    return false;
  }
  // BANKED LIVE CREDIT (review MEDIUM-2): the authority does not age gun
  // clocks by raw dt — stepInputs funds 1/64 s of wall time per tick
  // (bankCommandTime) and the drain loop spends min(cmd.dt, bank) per drained
  // command (creditCommandTime), so a 3-command drain tick credits at most one
  // tick of clock, not three. The old raw-dt ageing here credited all three,
  // so the ghost predicted faster fire than the authority on any burst drain
  // or replay. The ghost now funds dt per predicted command out of its own
  // cmdBank (same floors as the authority, same as the pre-live path above;
  // sanitizeCmd already clamped cmd.dt to (0, 0.15]) and the ghost spends
  // min(cmd.dt, bank): at steady 64 Hz 1:1 drain this is bit-identical to raw dt, and a
  // burst can no longer spend time nobody banked. Residual gap is bounded by
  // one CMD_BANK (the server funds per TICK, the ghost per COMMAND) and the
  // next ack re-syncs it — movement is metered the same way below, so the
  // worst case is a bounded position + hitmarker over-prediction on a burst
  // drain, documented here, not an unbounded split.
  p.cmdBank = Math.min(CMD_BANK, (Number.isFinite(p.cmdBank) ? p.cmdBank : 0) + dt);
  const g = Math.min(cmd.dt, p.cmdBank);
  if (g > 0) {
    p.cmdBank -= g;
    if (p.fireCd > -g) p.fireCd = Math.max(-g, p.fireCd - g);
    if (p.swap > 0) p.swap = Math.max(0, p.swap - g);
    if (p.nadeCd > 0) p.nadeCd = Math.max(0, p.nadeCd - g);
    if (p.sprintOut > 0) p.sprintOut = Math.max(0, p.sprintOut - g);
    tickAdsReload(p, g);
  }
  if (!cmd.fire) p.armed = true;
  p.yaw = cmd.yaw;
  p.pitch = clamp(cmd.pitch, -1.45, 1.45);
  p.wantAds = cmd.ads && p.slide <= 0 && p.reload <= 0;
  trySwap(p, cmd.weapon);
  if (cmd.reload) startReload(p);
  // TRAVEL IS METERED (review HIGH-2): the authority gates travel behind the
  // same arrival pattern — at most MAX_CMDS_PER_TICK drained per tick, each
  // spending one MOVE_TICK of seat.moveBank. The ghost spends one TICK_DT of
  // its own moveBank (seeded from PredictionState, 0 on a fresh ghost like a
  // fresh body) per command that moves. Unfunded, the body holds position for
  // this command while aim/gun clocks still replay above — the server will
  // integrate the queued command on a later funded tick, and the next ack
  // re-syncs the ghost. Residual: the server funds per TICK, the ghost per
  // COMMAND, so a burst still leads by up to one bank — a render-smoothing
  // error (errX/errY/errZ decay it), never a hit: hits are hitscan against
  // the authority.
  if (spendTravel(p, TICK_DT)) movePlayer(p, cmd, dt);
  // Trigger state affects later movement: a spent magazine starts a reload,
  // which prevents sprinting. Replay ammunition without generating hits/FX.
  const verdict = stepCook(p, cmd);
  p.nadeUp = p.cook > 0;
  if (verdict !== 0) {
    // Thrown, or gone off in the paw: either way the frag is spent this tick.
    if (p.nades > 0) p.nades--;
    p.nadeCd = NADE_CD;
    p.cook = 0;
    p.nadeUp = false;
    p.sprint = false;
    return false;
  }
  if (p.nadeUp) return false;
  if (cmd.melee) {
    if (p.fireCd <= 0) p.fireCd = shotInterval(WEAPON_BY_ID.knife!);
  } else if (cmd.fire) {
    const w = WEAPON_BY_ID[p.weapon];
    if (!w || w.fire === "melee") return false;
    if (w.fire !== "auto" && !p.armed) return false;
    if (!canFire(p, w)) return false;
    if (w.mag > 0 && p.ammo <= 0) { startReload(p); return false; }
    p.fireCd += shotInterval(w);
    if (w.mag > 0) p.ammo--;
    p.sprint = false;
    if (w.fire !== "auto") p.armed = false;
    const d = fireDir(p, w, cmd.seq, cmd.dx, cmd.dy, cmd.dz);
    p.lastShotDx = d.dx;
    p.lastShotDy = d.dy;
    p.lastShotDz = d.dz;
    return true;
  }
  return false;
}

/**
 * Spend one tick of ghost travel. Parallel to spendTravel's gun-clock twin
 * above (creditCommandTime): funds dt per predicted command out of the
 * ghost's own moveBank (capped at CMD_BANK, the seat's MOVE_BANK_MAX twin)
 * and spends one TICK_DT per command that moves. Returns false when the
 * account is empty — the caller holds position for that command.
 */
function spendTravel(p: SimPlayer, dt: number): boolean {
  p.moveBank = Math.min(CMD_BANK, (Number.isFinite(p.moveBank) ? p.moveBank : 0) + dt);
  if (p.moveBank < TICK_DT - 1e-9) return false;
  p.moveBank -= TICK_DT;
  return true;
}

export function predictionState(p: SimPlayer) {
  return {
    x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz,
    onGround: p.onGround, wantAds: p.wantAds, tacFuel: p.tacFuel,
    slide: p.slide, slideVx: p.slideVx, slideVz: p.slideVz,
    ads: p.ads, reload: p.reload, sprintOut: p.sprintOut,
    fireCd: p.fireCd, swap: p.swap, nadeCd: p.nadeCd,
    heat: p.heat, shotAgo: p.shotAgo, armed: p.armed, cook: p.cook,
    // Earned-time banks, exact (review HIGH-1/HIGH-2): without these the
    // ghost rebuilt its account from 0 + dt on every snapshot while the
    // authority kept banking on the wall clock, so after any idle the ghost
    // predicted 1-2 ticks of drain credit differently. Seeded from the ack,
    // preserved across reconciles by ghostFrom.
    cmdBank: p.cmdBank,
    moveBank: p.moveBank,
  };
}

function tickAdsReload(p: SimPlayer, dt: number): void {
  const w = WEAPON_BY_ID[p.weapon];
  const adsT = w ? w.adsTime : 0.25;
  // No sights while the gun is still coming up (swap) — the raise owns the pose.
  const target = p.wantAds && p.slide <= 0 && !p.sprint && p.swap <= 0 ? 1 : 0;
  // Linear blend: reaches the sight in exactly adsTime (down slightly faster).
  const rate = target > p.ads ? 1 / adsT : 1 / (adsT * 0.72);
  p.ads = target > p.ads ? Math.min(target, p.ads + rate * dt) : Math.max(target, p.ads - rate * dt);
  // BLOOM drains once the trigger has been off for longer than one interval —
  // a held trigger keeps its heat between rounds, a pause sheds it.
  if (p.shotAgo < 9) p.shotAgo += dt;
  if (p.heat > 0) {
    if (!w) p.heat = 0;
    else if (p.shotAgo > shotInterval(w) + 0.04) p.heat = Math.max(0, p.heat - w.bloom[2] * dt);
  }
  if (p.reload > 0) {
    p.reload -= dt;
    if (p.reload <= 0 && w) {
      p.reload = 0;
      const need = w.mag - p.ammo;
      const take = Math.min(need, p.reserve);
      p.ammo += take;
      p.reserve -= take;
    }
  }
}

/* ─────────────────────────────── WEAPONS ─────────────────────────────────
 * The pieces applyInput and predictMovement share. Each is a pure function of
 * the body it is handed, so the server and the shooter's prediction cannot
 * disagree about a swap, a cook or a cone — only about WHEN (lag), never WHAT.
 */

/** What a swap reads and writes — present on SimPlayer and on a client ghost. */
type SwapState = Pick<
  SimPlayer,
  "weapon" | "alt" | "ammo" | "reserve" | "altAmmo" | "altRes" | "reload" | "swap" | "fireCd" | "heat" | "ads" | "cook"
>;

/**
 * WEAPON SWAP. `want` is InputCmd.weapon: the id the player wants in hand. Only
 * the HOLSTERED gun is a legal answer — the server never hands out a weapon the
 * body did not spawn with — and nothing swaps while a pin is pulled. The swap
 * is instant in the data (the snapshot shows the new gun at once, so everyone
 * else sees the draw) and timed in the hands: `swap` is the raise, and canFire
 * and the sights wait for it. A reload in progress is cancelled (its rounds were
 * never moved, so nothing is lost but the time).
 */
export function trySwap(p: SwapState, want: string): boolean {
  if (typeof want !== "string" || !want || want === p.weapon || want !== p.alt) return false;
  if (p.cook > 0) return false;
  const w = WEAPON_BY_ID[want];
  if (!w || w.fire === "melee") return false;
  const wpn = p.weapon;
  p.weapon = p.alt;
  p.alt = wpn;
  const ammo = p.ammo;
  p.ammo = p.altAmmo;
  p.altAmmo = ammo;
  const res = p.reserve;
  p.reserve = p.altRes;
  p.altRes = res;
  p.reload = 0;
  p.swap = w.swap;
  // The outgoing gun's cycle (a sniper bolt) does not follow the pistol out.
  p.fireCd = 0;
  p.heat = 0;
  p.ads = 0;
  return true;
}

/** What the frag cycle reads and writes. */
type CookState = Pick<SimPlayer, "cook" | "nades" | "nadeCd" | "reload">;

/**
 * THE FRAG CYCLE, one command at a time. Returns 0 (nothing / still cooking),
 * 1 (throw NOW with NADE_FUSE - cook left) or 2 (cooked to zero in the hand).
 *
 * The fuse starts on the first command that pulls the pin and burns TICK_DT per
 * command after that, so a replay of the same commands cooks to the same tick.
 * A release is `nade` on the release tick OR simply a command without the hold —
 * a dropped key can never leave a frag cooking.
 */
export function stepCook(p: CookState, cmd: InputCmd): 0 | 1 | 2 {
  if (p.cook > 0) {
    p.cook += TICK_DT;
    if (p.cook >= NADE_FUSE - 1e-9) return 2;
    if (cmd.nade || !cmd.nadeHold) return 1;
    return 0;
  }
  if (p.nades <= 0 || p.nadeCd > 0) return 0;
  if (cmd.nadeHold) {
    p.cook = TICK_DT;
    // Pulling a pin is a hands job: it takes over from a reload in progress.
    p.reload = 0;
    return 0;
  }
  // A throw with no wind-up at all (bots, legacy harnesses): full fuse.
  if (cmd.nade) return 1;
  return 0;
}

const DEG = Math.PI / 180;

/** What the spread cone depends on. */
export type SpreadState = Pick<SimPlayer, "ads" | "vx" | "vz" | "onGround" | "crouch" | "heat">;

/**
 * THE SPREAD CONE (radius, radians) the next round leaves the barrel with.
 * Hip cone by stance and speed, eased to the aimed cone as ADS comes in
 * (smoothstep, so the first half of the raise buys little), times bloom. The
 * sniper's adsGate makes the ease a step: below it every shot is a hip shot.
 * Read by the sim, the shooter's prediction and the HUD crosshair (spreadPx).
 */
export function shotCone(p: SpreadState, w: WeaponDef): number {
  const air = !p.onGround;
  const spd = Math.hypot(p.vx, p.vz);
  const mv = air ? 1 : clamp((spd - 0.6) / 3.0, 0, 1);
  let hip = air ? w.hip[2] : w.hip[0] + (w.hip[1] - w.hip[0]) * mv;
  let aim = air ? w.ads[2] : w.ads[0] + (w.ads[1] - w.ads[0]) * mv;
  if (p.crouch && !air) {
    hip *= 0.8;
    aim *= 0.8;
  }
  const a = w.adsGate > 0 ? (p.ads >= w.adsGate ? 1 : 0) : p.ads * p.ads * (3 - 2 * p.ads);
  const h = p.heat;
  return (hip * (1 + h) + (aim * (1 + h * 0.35) - hip * (1 + h)) * a) * DEG;
}

/** FNV-1a of a player id — the per-player half of the spread hash. */
export function spreadSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/**
 * A point in the cone, deterministic in (seed, n, k): uniform over the disc
 * (sqrt radius), about the unit aim (dx, dy, dz). Written into `out`.
 * Ported from Kong Royale's spreadOffset (shared/sim/player.ts), 32-bit clean.
 */
export function spreadDir(
  seed: number,
  n: number,
  k: number,
  cone: number,
  dx: number,
  dy: number,
  dz: number,
  out: { dx: number; dy: number; dz: number },
): { dx: number; dy: number; dz: number } {
  if (!(cone > 0)) {
    out.dx = dx;
    out.dy = dy;
    out.dz = dz;
    return out;
  }
  let h = Math.imul(seed | 0, 73856093) ^ Math.imul(n | 0, 19349663) ^ Math.imul((k | 0) + 1, 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  const a = ((h & 0xffff) / 65536) * Math.PI * 2;
  const r = Math.tan(Math.sqrt(((h >>> 16) & 0xffff) / 65536) * cone);
  const [bx, by] = basis(dx, dy, dz);
  const ca = Math.cos(a) * r;
  const sa = Math.sin(a) * r;
  let sx = dx + bx.x * ca + by.x * sa;
  let sy = dy + bx.y * ca + by.y * sa;
  let sz = dz + bx.z * ca + by.z * sa;
  const l = Math.hypot(sx, sy, sz) || 1;
  sx /= l;
  sy /= l;
  sz /= l;
  out.dx = sx;
  out.dy = sy;
  out.dz = sz;
  return out;
}

const FIRE_DIR = { dx: 0, dy: 0, dz: 1 };
const PELLET_DIR = { dx: 0, dy: 0, dz: 1 };

/**
 * The ray a round fired on command `seq` actually takes: the aim normalised
 * (or rebuilt from yaw/pitch when the command carried none), spread inside
 * this shot's cone, and the bloom booked for the next one. Shared by tryFire
 * and predictMovement — the one place a bullet's direction is decided.
 * Returns a module scratch: copy it before the next call.
 */
export function fireDir(
  p: SpreadState & Pick<SimPlayer, "id" | "yaw" | "pitch" | "shotAgo">,
  w: WeaponDef,
  seq: number,
  dx: number,
  dy: number,
  dz: number,
): { dx: number; dy: number; dz: number } {
  const dl = Math.hypot(dx, dy, dz);
  if (!(dl >= 0.2)) {
    const a = aimDir(p.yaw, p.pitch);
    dx = a.dx;
    dy = a.dy;
    dz = a.dz;
  } else {
    dx /= dl;
    dy /= dl;
    dz /= dl;
  }
  const cone = shotCone(p, w);
  p.heat = Math.min(w.bloom[1], p.heat + w.bloom[0]);
  p.shotAgo = 0;
  return spreadDir(spreadSeed(p.id), seq, 0, cone, dx, dy, dz, FIRE_DIR);
}

export function movePlayer(p: SimPlayer, cmd: InputCmd, dt: number): void {
  const ph0 = poseHeight(p); // stance height BEFORE this command: integrate() catches a stance growing into a ceiling
  const w = WEAPON_BY_ID[p.weapon];
  p.crouch = cmd.crouch && p.slide <= 0;
  // CEILINGS (shared/ceiling.ts): a crouched body with no headroom to stand up stays crouched.
  if (!p.crouch && ph0 < STAND_H && p.slide <= 0 && !roomToStand(p, ph0)) p.crouch = true;
  const moving = Math.abs(cmd.ax) + Math.abs(cmd.az) > 0.12;
  // Aiming ends a sprint (CoD): holding ADS is a request for the sights, and
  // the sprint key under it is free for the scope's hold-breath.
  const canSprint = cmd.sprint && !cmd.ads && cmd.az > 0.3 && p.ads < 0.2 && !p.crouch && p.reload <= 0;
  const wasSprint = p.sprint;
  p.sprint = canSprint;
  if (wasSprint && !p.sprint) {
    const def = WEAPON_BY_ID[p.weapon];
    p.sprintOut = def ? def.sprintOut : 0.2;
  }
  if (canSprint && cmd.tac && p.tacFuel > 0.05) {
    p.tac = true;
    p.tacFuel = Math.max(0, p.tacFuel - dt);
    if (p.tacFuel <= 0) p.tac = false;
  } else {
    p.tac = false;
    p.tacFuel = Math.min(TAC_FUEL, p.tacFuel + dt * 0.35);
  }

  if (cmd.crouch && p.sprint && p.onGround && p.slide <= 0 && len2(p.vx, p.vz) > 4.2) {
    p.slide = SLIDE_TIME;
    p.slideVx = p.vx * 1.12;
    p.slideVz = p.vz * 1.12;
    p.sprint = false;
  }

  let speed = RUN;
  if (p.slide > 0) speed = Math.hypot(p.slideVx, p.slideVz);
  else if (p.crouch) speed = CROUCH_SPD;
  else if (p.tac) speed = TAC;
  else if (p.sprint) speed = SPRINT;
  else if (Math.abs(cmd.az) < 0.2 && Math.abs(cmd.ax) > 0.2) speed = WALK + 0.4;
  else if (len2(cmd.ax, cmd.az) < 0.55) speed = WALK;
  // What you carry is how fast you move (WeaponDef.move: SMG/pistol 1.05,
  // sniper 0.92) — a slide keeps the speed it was launched with.
  if (w && p.slide <= 0) speed *= w.move;
  if (p.ads > 0.4) speed *= lerp(1, w ? w.adsMove : ADS_MUL, p.ads);

  const sy = Math.sin(p.yaw);
  const cy = Math.cos(p.yaw);
  const [axn, azn] = norm2(cmd.ax, cmd.az);
  const wishX = sy * azn + cy * axn;
  const wishZ = cy * azn - sy * axn;

  if (p.slide > 0) {
    p.slide -= dt;
    p.vx = p.slideVx;
    p.vz = p.slideVz;
    const fr = SLIDE_FRIC * dt;
    p.slideVx *= Math.max(0, 1 - fr);
    p.slideVz *= Math.max(0, 1 - fr);
    if (p.slide <= 0 || (!cmd.crouch && p.slide < 0.2)) p.slide = 0;
    // CEILINGS (shared/ceiling.ts): a slide that ends under something too low to stand ends crouched.
    if (p.slide <= 0 && !roomToStand(p, SLIDE_H)) p.crouch = true;
  } else if (p.onGround) {
    p.vx *= Math.max(0, 1 - FRICTION * dt);
    p.vz *= Math.max(0, 1 - FRICTION * dt);
    if (moving) {
      p.vx += wishX * ACCEL * speed * dt;
      p.vz += wishZ * ACCEL * speed * dt;
      const sp = Math.hypot(p.vx, p.vz);
      if (sp > speed) {
        p.vx = (p.vx / sp) * speed;
        p.vz = (p.vz / sp) * speed;
      }
    }
    if (cmd.jump) {
      p.vy = JUMP_V;
      p.onGround = false;
      p.slide = 0;
      if (moving) vaultHop(p, wishX, wishZ);
    }
  } else {
    p.vy -= GRAVITY * dt;
    if (moving) {
      p.vx += wishX * AIR_ACCEL * dt;
      p.vz += wishZ * AIR_ACCEL * dt;
      const cap = TAC * 1.05;
      const sp = Math.hypot(p.vx, p.vz);
      if (sp > cap) {
        p.vx = (p.vx / sp) * cap;
        p.vz = (p.vz / sp) * cap;
      }
    }
  }

  integrate(p, dt, ph0);
}

/** Horizontal speed a jump INTO a `vault` rail carries over it (m/s): air control alone is far too weak. */
const VAULT_HOP = 3.2;

/**
 * VAULTING. A jump pushed into a waist-high `vault` rail within a
 * quarter metre leaves with at least VAULT_HOP along the push, so a standing
 * hop from against a balcony rail clears it the way a running one does.
 * Shared by the server and the client's replay, like everything in moveBody.
 */
function vaultHop(p: SimPlayer, wx: number, wz: number): void {
  const ax = p.x + wx * 0.25;
  const az = p.z + wz * 0.25;
  const cand = gridQueryCircle(solidGrid(), ax, az, RC_PAD, RC_NEAR);
  for (let i = 0; i < cand.length; i++) {
    const o = SOLIDS[cand[i]!]!;
    if (!o.vault) continue;
    const rise = o.y + o.sy * 0.5 - p.y;
    if (rise <= 0 || rise > 1.05 || !circleHitsOBB(ax, az, RADIUS, o).hit) continue;
    const along = p.vx * wx + p.vz * wz;
    if (along < VAULT_HOP) {
      p.vx += wx * (VAULT_HOP - along);
      p.vz += wz * (VAULT_HOP - along);
    }
    return;
  }
}

function integrate(p: SimPlayer, dt: number, ph0: number): void {
  const steps = 3;
  const sdt = dt / steps;
  const ph = poseHeight(p);
  // CEILINGS (shared/ceiling.ts): standing up mid-air into an overhead solid lowers the feet, never a lateral push.
  if (ph > ph0) stopAtCeiling(p, p.y + ph0, ph, true);
  for (let i = 0; i < steps; i++) {
    p.x += p.vx * sdt;
    p.z += p.vz * sdt;
    resolveCircle(p);
    // The height this body is stepping FROM, sampled before the vertical move:
    // `groundHeight` uses it to ignore any surface it could not have stepped
    // onto (more than a mantle above the feet). Without it, walking under a
    // catwalk teleports you on top of it.
    const fromY = walkFromY(p.y);
    const y0 = p.y;
    p.y += p.vy * sdt;
    // CEILINGS (shared/ceiling.ts): a head that rises into an overhead solid stops under it, never a lateral push.
    if (p.vy > 0) stopAtCeiling(p, y0 + ph, ph, false);
    // `vault` rails are not climb, so groundHeight never lifts to a rail top:
    // a grounded walker held as steel by resolveCircle above can never be
    // snapped Deck→RailTop like a stair.
    const gh = groundHeight(p.x, p.z, SOLIDS, fromY, FLOOR_Y);
    if (p.y <= gh) {
      p.y = gh;
      if (p.vy < 0) p.vy = 0;
      p.onGround = true;
    } else {
      p.onGround = false;
    }
    if (p.y < FLOOR_Y) {
      p.y = FLOOR_Y;
      p.vy = 0;
      p.onGround = true;
    }
  }
  // NUKETOWN OOB EXFIL CLAMP (security #1). The deck rails top out at ~4.0 m
  // and a jump apex is 0.76 m, so feet at ~4.76 m ballistically clear the
  // 3.2 m perimeter (below every rail top, never a mantle step) — and
  // integrate() never had an XZ bounds check (MAP.bounds only gated spawns),
  // so a rail launch could fly out of the map and land in the void. Bodies
  // are now fenced into MAP.bounds (inset RADIUS, outward velocity zeroed):
  // the INTENDED direction is preserved — deck→lawn stays inside the bounds
  // (the player jump-vault lands on the lawn, movement code untouched) and
  // lawn→deck still needs the stairs — while anything crossing the map edge
  // mid-air is teleported back to the fence. Gated on IS_NUKETOWN, so every
  // other map compiles to the code it had before.
  //
  // RIM FLOORLESS NOTE: the clamp lands on the map's floor plane (FLOOR_Y) or
  // whatever climbable top the re-sample below finds — the floor plane is
  // infinite, so a clamped body always has ground; buildNuketown additionally
  // asserts finite bounds (a {x,z,w,d} regen rect would make every comparison
  // below false and silently disable the clamp — the OOB it exists to close).
  //
  // NO RESOLVE/CEILING RE-RUN (accepted, documented): the teleport is at most
  // SPRINT*TICK_DT ≈ 0.09 m of overshoot, so a clamped body can sit up to one
  // frame ~9 cm inside a fence-adjacent face before the next tick's
  // resolveCircle pushes it out. Re-running the full circle + ceiling sweep
  // here would cost it every teleport for no gameplay gain — one stale frame
  // inside a perimeter wall is not a stuck body, and the next tick resolves
  // it exactly as a walked-into wall.
  if (IS_NUKETOWN) {
    const b = MAP.bounds;
    const loX = b.minX + RADIUS;
    const hiX = b.maxX - RADIUS;
    const loZ = b.minZ + RADIUS;
    const hiZ = b.maxZ - RADIUS;
    let clamped = false;
    // Non-finite positions (unreachable now inputs are sanitized at ingress;
    // this is the last net, not the fence) teleport to the fence like an OOB.
    // Non-finite VELOCITY zeroes even when the position is in bounds (parity
    // with the asleep-wake + post-step frag nets below): an in-bounds body
    // with NaN vx/vz would otherwise keep the poisoned velocity into the next
    // tick's integrate.
    if (!Number.isFinite(p.vx)) p.vx = 0;
    if (!Number.isFinite(p.vz)) p.vz = 0;
    if (!Number.isFinite(p.x) || p.x < loX) {
      p.x = !Number.isFinite(p.x) ? (b.minX + b.maxX) * 0.5 : loX;
      if (p.vx < 0 || !Number.isFinite(p.vx)) p.vx = 0;
      clamped = true;
    } else if (p.x > hiX) {
      p.x = hiX;
      if (p.vx > 0 || !Number.isFinite(p.vx)) p.vx = 0;
      clamped = true;
    }
    if (!Number.isFinite(p.z) || p.z < loZ) {
      p.z = !Number.isFinite(p.z) ? (b.minZ + b.maxZ) * 0.5 : loZ;
      if (p.vz < 0 || !Number.isFinite(p.vz)) p.vz = 0;
      clamped = true;
    } else if (p.z > hiZ) {
      p.z = hiZ;
      if (p.vz > 0 || !Number.isFinite(p.vz)) p.vz = 0;
      clamped = true;
    }
    // y/vy are independent like x/vx above (review LOW): a poisoned vy zeroes
    // in place and KEEPS its finite y — gravity re-grounds the body next tick
    // — while only a poisoned y teleports to the floor plane. Zeroing-then-
    // teleporting on a vy fault alone moved a finite body for a velocity fault.
    if (!Number.isFinite(p.y)) {
      p.y = FLOOR_Y;
      p.vy = 0;
      clamped = true;
    } else if (!Number.isFinite(p.vy)) {
      p.vy = 0;
    }
    if (clamped) {
      // The teleport (up to SPRINT*TICK_DT ≈ 0.09 m of overshoot) can move the
      // body onto a different floor than the substeps above sampled — re-sample
      // instead of standing one stale tick on the void's y. Only runs on the
      // teleported path; unclamped bodies keep the exact code above.
      const gh = groundHeight(p.x, p.z, SOLIDS, walkFromY(p.y), FLOOR_Y);
      if (p.y <= gh) {
        p.y = gh;
        if (p.vy < 0) p.vy = 0;
        p.onGround = true;
      } else {
        p.onGround = false;
      }
      if (p.y < FLOOR_Y) {
        p.y = FLOOR_Y;
        p.vy = 0;
        p.onGround = true;
      }
    }
  }
}

/**
 * shared/ceiling.ts against this sim's colliders: where the feet must go so a
 * head that moved up from `head0` (stance height `ph` now, feet at p.y) stays
 * under the lowest underside it crossed — Infinity when it crossed none.
 */
function ceilingFeetY(p: SimPlayer, head0: number, ph: number, contact = false): number {
  const bot = ceilingCrossed(SOLIDS, solidGrid(), p.x, p.z, RADIUS, p.y, p.vy, head0, p.y + ph, contact);
  return bot === Infinity ? Infinity : Math.max(bot - CEIL_EPS, head0) - ph;
}

/**
 * Park the head under the ceiling it rose into and zero any upward speed. `fit`
 * (a stance change, not a rise) refuses to sink the feet below the floor under
 * them; `roomToStand` has already kept such a body crouched, so what is left
 * (a slide ending under something lower than a crouch) keeps resolveCircle's
 * lateral pushout, exactly as before.
 */
function stopAtCeiling(p: SimPlayer, head0: number, ph: number, fit: boolean): void {
  const y = ceilingFeetY(p, head0, ph);
  if (y === Infinity || (fit && y < groundHeight(p.x, p.z, SOLIDS, walkFromY(p.y)))) return;
  p.y = y;
  if (p.vy > 0) p.vy = 0;
}

/**
 * Can a body whose head is at p.y + ph0 stand up here — no overhead solid its
 * standing head would touch (by resolveCircle's own 5 cm grace), or (mid-air)
 * room to drop the feet under it without going through the floor? A body that
 * cannot is kept crouched instead of being pushed sideways out from under the
 * ceiling (CoD's "can't stand up here").
 */
function roomToStand(p: SimPlayer, ph0: number): boolean {
  const y = ceilingFeetY(p, p.y + ph0, STAND_H, true);
  return y === Infinity || y >= groundHeight(p.x, p.z, SOLIDS, walkFromY(p.y));
}

/**
 * How far the body may drift from the point a candidate list was gathered at
 * before that list has to be re-gathered. The pushes here are POSITIONAL
 * teleports (`p.x += nx*pen`) and a body that starts deep inside a container is
 * ejected metres in one step, so this cannot be assumed small: the loop below
 * checks it and re-queries, which is what makes the grid path provably identical
 * to the flat scan rather than identical-in-practice.
 */
const RC_SLACK = 0.75;
const RC_PAD = RADIUS * Math.SQRT2 + RC_SLACK;

function resolveCircle(p: SimPlayer): void {
  // BROADPHASE. Nine of these sweeps run per player per tick (3 relaxation
  // passes x 3 substeps) and every one of them used to scan the whole collider
  // set: 12 bodies against dust2's ~700 boxes at 64 Hz is 5.5 M OBB tests a
  // second (docs/dustmap/report-sim.md §12). The grid returns candidates in
  // ASCENDING SOLID INDEX — the exact order the flat loop visited them in —
  // because this loop teleports the body as it goes, so a different order
  // resolves a corner differently.
  for (let k = 0; k < 3; k++) {
    let pushed = false;
    let qx = p.x;
    let qz = p.z;
    let cand = gridQueryCircle(solidGrid(), qx, qz, RC_PAD, RC_NEAR);
    let ci = 0;
    let last = -1;
    while (ci < cand.length) {
      const idx = cand[ci]!;
      ci += 1;
      if (idx <= last) continue;
      last = idx;
      const o = SOLIDS[idx]!;
      if (o.visual === "roof") continue;
      const top = o.y + o.sy * 0.5;
      const bot = o.y - o.sy * 0.5;
      const ph = p.slide > 0 ? SLIDE_H : p.crouch ? CROUCH_H : STAND_H;
      if (p.y + ph < bot + 0.05 || p.y > top - 0.02) continue;
      const hit = circleHitsOBB(p.x, p.z, RADIUS, o);
      if (hit.hit && hit.pen > 0) {
        if (o.climb && top - p.y < 1.05 && p.y + 0.2 < top && p.vy >= -0.5) {
          continue;
        }
        // a jump clears a waist-high rail (shared/map.ts `vault`); a walk never does
        if (vaulting(o, p.y, p.vy)) continue;
        p.x += hit.nx * hit.pen;
        p.z += hit.nz * hit.pen;
        const vn = p.vx * hit.nx + p.vz * hit.nz;
        if (vn < 0) {
          p.vx -= hit.nx * vn;
          p.vz -= hit.nz * vn;
        }
        pushed = true;
        // Moved far enough that the gathered list may no longer cover the body:
        // re-gather about the new position and resume at the next solid index,
        // which is precisely where the flat scan would have been.
        if (Math.abs(p.x - qx) > RC_SLACK || Math.abs(p.z - qz) > RC_SLACK) {
          qx = p.x;
          qz = p.z;
          cand = gridQueryCircle(solidGrid(), qx, qz, RC_PAD, RC_NEAR);
          ci = 0;
          while (ci < cand.length && cand[ci]! <= last) ci += 1;
        }
      }
    }
    if (!pushed) break;
  }
}

/** Everything that can lock the trigger out, and nothing else. */
export type FireState = Pick<SimPlayer, "swap" | "reload" | "fireCd" | "sprintOut" | "sprint" | "ads">;

/**
 * IS THE TRIGGER LIVE? The one gate, called by the authoritative tryFire above
 * and by the client's command replay before predicting a hitmarker.
 *
 * It exists because the two used to disagree. An auto weapon posts fire=true on
 * all 64 ticks a second the trigger is held and the sim takes 13 of them (800
 * rpm), so a client that predicts a hit per fire COMMAND draws four markers that
 * the server never awards for every one it does — and it draws them hardest
 * mid-reload, dry, or in the 0.22 s sprint-out, which is exactly when the server
 * awards nothing at all. Ammunition is deliberately NOT part of this: running
 * dry starts a reload in the sim (a side effect a predicate must not have), so
 * the magazine is checked by each caller against its own count.
 */
export function canFire(p: FireState, w: WeaponDef): boolean {
  if (p.swap > 0 || p.reload > 0 || p.fireCd > 0 || p.sprintOut > 0) return false;
  if (p.sprint && p.ads < 0.15) return false;
  return w.fire !== "melee";
}

/** A body, exactly as much of one as a hit test needs. */
export type HitPose = { x: number; y: number; z: number; crouch: boolean; slide: number };

/** Standing height of a pose — the hitbox and the headshot line share it. */
export function poseHeight(p: HitPose): number {
  return p.slide > 0 ? SLIDE_H : p.crouch ? CROUCH_H : STAND_H;
}

/**
 * THE hit test. Distance along the ray at which it enters this body, Infinity
 * if it misses.
 *
 * Server hitscan and client hit PREDICTION both call this one function, so a
 * predicted hitmarker can only ever disagree with the server's verdict about
 * WHEN a body was (lag compensation), never about what shape it is. Before
 * this, the client tested a bare 0.32 m cylinder with 0.1 m of vertical slop
 * while the server tested the 0.64 m axis-aligned box refined to that cylinder
 * (rayCapsule below) — the two disagree along the box's corners and at the
 * crown, which is exactly where phantom hitmarkers and unmarked kills live.
 */
export function rayPlayer(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  p: HitPose,
): number {
  const h = poseHeight(p);
  return rayCapsule(ox, oy, oz, dx, dy, dz, p.x, p.y + h * 0.5, p.z, RADIUS + 0.02, h * 0.5);
}

/** Was the impact height inside this pose's head? Same line on both sides. */
export function isHeadshot(hy: number, p: HitPose): boolean {
  const h = poseHeight(p);
  return hy > p.y + h - Math.min(0.22, h * 0.22);
}

function rayCapsule(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  hh: number,
): number {
  const t = rayAABB(
    ox,
    oy,
    oz,
    dx,
    dy,
    dz,
    cx - r,
    cy - hh,
    cz - r,
    cx + r,
    cy + hh,
    cz + r,
  );
  if (!Number.isFinite(t)) return Infinity;
  const px = ox + dx * t - cx;
  const pz = oz + dz * t - cz;
  if (px * px + pz * pz > (r + 0.08) * (r + 0.08)) {
    const horiz = rayCircle(ox, oz, dx, dz, cx, cz, r);
    if (!Number.isFinite(horiz)) return Infinity;
    const y = oy + dy * horiz;
    if (y < cy - hh - 0.05 || y > cy + hh + 0.05) return Infinity;
    return horiz;
  }
  return t;
}

function rayCircle(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  cx: number,
  cz: number,
  r: number,
): number {
  const fx = ox - cx;
  const fz = oz - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a < 1e-8) return Infinity;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 ? t : Infinity;
}

function rayAABB(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  let tmin = 0;
  let tmax = 200;
  const slabs: [number, number, number, number][] = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];
  for (const [p, d, mn, mx] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (p < mn || p > mx) return Infinity;
      continue;
    }
    let t1 = (mn - p) / d;
    let t2 = (mx - p) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) return Infinity;
  }
  if (tmax < 0) return Infinity;
  return tmin >= 0 ? tmin : tmax;
}

// ===========================================================================
// THE BOT BRAIN
//
// Rebuilt against qa/out/botwatch.json (100 s, 10 bots, real GPU), which caught
// all three of the defects the player reported:
//
//   STUCK    12 episodes. Bots walked at a waypoint with `az = 1` and no notion
//            of what stood between them and it, so a container face held them
//            for as long as the goal stayed on the far side — 59.7 s for bot-7
//            against walkthrough-red-2. FOUR of the map's 19 waypoints are
//            themselves unreachable after the P2 prop pass: (0,-12.8) sits
//            0.98 m inside the north blue container, (6.2,6.4) 0.83 m inside
//            container col-11, and (+-12.5, 0) inside the east/west shell walls.
//   CLIP     97 episodes, 94 of them an arm or a hand (worst 0.94 m). A bot
//            pressed flat against steel puts its body centre exactly RADIUS
//            (0.30 m) from the face while the rig's hands reach ~0.55 m past it,
//            so every wall-grind is a clip. Bots therefore keep a standoff.
//   TTK      median 0.375 s on the player, floor 0.11 s, and the damage logs
//            read 126 = three HEAD shots: the old aim point was the skull, the
//            tracking constant converged on it exactly, and the trigger was held
//            down from the first frame of the sighting.
//
// So: NAV (validated goals + steering), UNSTICK (displacement watchdog), and a
// TRIGGER built out of reaction time, a chest-high aim point that is wrong by a
// measured amount, and burst discipline. Bots still flank, push and win fights
// they earn — they just do not laser you from full health any more.
//
// Bots never throw frags (nothing here ever sets cmd.nade): the banana grenade
// stays a player verb.
// ===========================================================================

/**
 * Every number the bot fight is shaped by, in one table so the tuning is
 * readable — and exported so an instrument can print the knobs it is measuring
 * next to the distribution they produced.
 */
export const BOT_TUNING = {
  /** First-sight reaction, seconds: rookie .. ace. */
  reactSlow: 0.7,
  reactFast: 0.36,
  /** Rounds per burst and the pause after one. THE STRUCTURAL FLOOR under TTK,
   *  and it is arithmetic rather than statistics:
   *
   *    The AR is 28 chest / 780 rpm, so a full-health kill needs FOUR body
   *    hits. At most THREE rounds leave the gun in one burst (3 x 28 = 84,
   *    never lethal), and every gap is at least `gapMin` whatever the roll says.
   *    The fourth hit therefore cannot land before 2 x 0.077 + 0.66 = 0.81 s.
   *    botBurstLen sizes the burst per gun so the same holds for all of them
   *    (SMG 3 x 25 = 75, pistol 2 x 34 = 68); the sniper's one-shot is paced by
   *    its reaction, scope settle and bolt instead (qa/x/weapons-bot-ttk.ts).
   *
   *  That is the whole reason burstMax came down from 4: at 4 the review caught
   *  clean 4/4 bursts killing from full health in 0.594 s (run 1) and 0.609 s
   *  (run 4) — inside the gate, but nowhere near the >= 1.1 s the spec asks for
   *  at mid range. Statistics shape the median; this part is the wall under it. */
  burstMin: 2,
  burstMax: 3,
  gapMin: 0.66,
  gapMax: 1.05,
  /** Aim scatter at the target plane, metres (1 sigma), before the skill scale,
   *  calibrated against the 0.32 m hit capsule.
   *
   *  These came DOWN when squad discipline went in, and that is the trade the
   *  whole model rests on: the floor under TTK is structural (3 rounds a burst,
   *  0.66 s between them, one shooter at a time), so it does not care how well a
   *  bot aims — which frees the scatter to be tuned for FEEL rather than for
   *  safety. Bots that miss two bursts out of three are not frightening, they
   *  are scenery. Headless, one bot, strafing target: median first-damage-to-
   *  death lands ~2 s at 8-12 m, floor 0.89 s, which is a fight you can lose and
   *  a fight you can win by moving. */
  errBase: 0.07,
  errPerMetre: 0.0085,
  errPerTargetSpeed: 0.058,
  errPerOwnSpeed: 0.045,
  /** TRACKING DECAY — what a held trigger costs, and the reason a burst cannot
   *  kill you on its own. Heat climbs `heatPerShot` per round and dumps between
   *  bursts. It does not merely widen the scatter (a scatter term multiplies an
   *  offset that may sit at zero, so a lucky burst still beams): it WALKS the
   *  aim point up and across, the way a real muzzle climbs. Rounds 1-2 of a
   *  burst are dangerous, rounds 4+ are over your shoulder. */
  errPerHeat: 0.45,
  heatPerShot: 0.34,
  heatBleed: 2.4,
  /** Metres of climb and of lateral walk at full heat. The walk is the big one
   *  ON PURPOSE: climb alone sweeps the aim UP THROUGH THE HEAD, and a 1.5x
   *  head multiplier turned the recoil model into a headshot machine (measured:
   *  three 42-damage rounds, 0.156 s, dead). Sideways is a clean miss. */
  heatClimb: 0.18,
  heatSway: 1.35,
  /** Wander correlation time: a burst misses AS a burst, not shot by shot. */
  errTau: 0.4,
  /** Fresh sighting: the opening burst is a ranging burst. */
  settleMul: 2.1,
  settleTau: 1.0,
  /** Aim tracking constant, 1/s: rookie .. ace. */
  trackSlow: 4.4,
  trackFast: 8.0,
  /** Seconds of target velocity a bot leads by (it is never the right amount). */
  leadMin: 0.02,
  leadMax: 0.13,
  /** How far a body tries to stay off a wall face.
   *
   *  SIZED FROM THE RIG, not from a guess. Measured on the live client (bones
   *  vs the authoritative sim x/z, 5417 samples, 10 bots; rendered root lag is
   *  exactly 0 offline, so every metre below is the rig itself):
   *
   *      Pelvis  up to 0.566 m from the capsule centre (mean 0.257)
   *      Head    up to 0.931 m                          (mean 0.354)
   *      R_Hand  up to 1.429 m                          (mean 0.849)
   *
   *  The arm itself is anatomically normal (shoulder->hand 0.62-0.68 m): what
   *  puts a hand 1.43 m out is uncancelled root motion plus lean in the locomo-
   *  tion clips. 0.95 is chosen to clear the WHOLE CORE — pelvis and head both
   *  live inside 0.94 m — so no standoff-respecting bot can ever put a torso or
   *  a skull in steel. Hands are out of reach of this knob and always will be:
   *  see `sprintNear` below, and the note on the walkthroughs.
   *
   *  1.22 is past the point where a walkthrough can satisfy it (2.14 m of
   *  interior, 1.07 m of half-width) and that is now allowed: botMove walks a
   *  LADDER of bands and takes the widest one the geometry can actually give, so
   *  asking for more than a corridor has costs a corridor nothing. An earlier
   *  pass fixed the band at 1.05 with no ladder and bots shuffled inside the
   *  green walkthrough until the watchdog fired (bot-8, stationary 8.5 s).
   *
   *  Why not more? Because 1.45 is where the arm-swing tail finally ends, and a
   *  bot that keeps a metre and a half from every container stops using the map
   *  — no corners, no peeking, no cover. That is a worse game than an occasional
   *  hand grazing steel for two frames, so this stops at the last value that
   *  still lets a bot work a container edge. The residual is a rig defect, not a
   *  steering one: see the note on `sprintNear`. */
  standoff: 1.22,
  /** The same for a mantle-height crate, dumpster or tire stack. Smaller,
   *  because it is a step rather than a wall, and the hands ride above it — the
   *  bone that reaches a knee-high prop is a FOOT. Sized off that: the calf and
   *  foot bones orbit to 0.844 m, and at 0.78 botwatch duly caught bot-3's
   *  L_Foot 0.096 m inside the tire stack, which is 0.78 + 0.096 almost exactly.
   *  0.95 puts the whole leg swing outside a low prop. */
  standoffLow: 0.95,
  /** Speed governor near geometry. Measured hand orbit BY GAIT (same run):
   *
   *      idle    mean 0.648 m,  1.1% of frames past 0.95 m
   *      walk    mean 0.705 m, 17.4%
   *      run     mean 0.835 m, 28.6%   (12.3% past 1.20 m)
   *      sprint  mean 1.119 m, 69.4%   (41.1% past 1.20 m)
   *
   *  Sprinting IS the arm-clip generator — the sprint clip throws the hands a
   *  third of a metre further out than running does. So bots do not sprint while
   *  anything solid is inside `sprintNear`; they still sprint everywhere else,
   *  which is most of a 33 m yard, so the pressure does not change. */
  sprintNear: 1.5,
  /** Unstick watchdog: displacement under `stuckDisp` over `stuckWin` repaths. */
  stuckWin: 3.0,
  stuckDisp: 0.6,
  /** How far from its anchor a body has to get before the watchdog agrees it is
   *  GOING somewhere. Sized above botwatch's own STUCK test (0.6 m of net
   *  displacement over 6 s) so that anything the instrument would call stuck
   *  keeps the clock running: a bot pacing 1.2 m up and down a container never
   *  reaches 1.5 m from where it started pacing, and is therefore never credited
   *  with progress it did not make. */
  progressM: 1.5,
  /** ESCALATION. The review caught the failure mode this exists for: a single
   *  shove along the face normal can push a bot out and let it walk straight
   *  back, and an oscillation like that keeps NET displacement under 0.6 m
   *  across botwatch's rolling 6 s window — two watchdog firings, still one
   *  STUCK (bot-8, t=64.6 s, (3.01,8.04) by walkthrough-green-1, 0.34 m / 6 s).
   *  So a second consecutive failed window stops nudging and COMMITS: a far nav
   *  point, a hard drive at it, and the standoff relaxed to RADIUS+0.1 for the
   *  duration so the corridor that cancelled the lateral wish cannot cancel the
   *  escape too. Physics still resolves the body; only the preference relaxes. */
  escapeSecs: 2.6,
  escapeStandoff: 0.1,
  /** Loiter watchdog — botwatch calls 0.6 m over 6 s a STUCK, so move sooner. */
  loiterWin: 4.2,
  loiterDisp: 1.1,
  /** Seconds a bot pressures the last place it saw someone. */
  memory: 2.4,
  /** SQUAD FIRE DISCIPLINE — the last way a player still got deleted.
   *
   *  Every knob above is per-bot, and per-bot the floor holds: three rounds is
   *  84 damage, never lethal, and the next round is >= gapMin away. But TEN bots
   *  share one player, and two of them firing at once simply halves the floor. A
   *  headless crossfire study (4 bots, 8 m, 200 trials) measured the exact shape
   *  of it: bot-1 at 0.000/0.078 s, bot-2 at 0.094/0.156 s — 106 damage in
   *  0.156 s, and not one bot in it did anything wrong. botwatch run 1 caught the
   *  same thing live: 4 hits, 106 damage, 0.125 s.
   *
   *  So the roster takes turns. A bot holds its trigger while a TEAMMATE's round
   *  has landed on the same target inside `crossHold`, which is the same number
   *  as `gapMin` on purpose: against any one target the whole roster behaves as
   *  ONE disciplined shooter, and the 0.81 s floor is a floor for the squad and
   *  not just for its members. Held bots do not stand around — they take the
   *  time to reposition, which is what makes a firing squad into a flank.
   *
   *  Inside `crossFree` the hold SHORTENS to `crossNear` — it is never removed.
   *  A man who walks into your muzzle gets answered inside one reaction time
   *  rather than a full second, which is the whole of what the close-range case
   *  ever needed; removing the hold outright instead handed the entire
   *  close-quarters roster a free trigger simultaneously and measured 0.063 s
   *  deaths from full health. `crossNear` is sized off the same arithmetic as
   *  everything else here: a 3-round burst spans ~0.15 s and is never lethal, so
   *  a fourth hit cannot arrive before 0.15 + 0.5 = 0.65 s even when a second
   *  shooter is standing on top of you. */
  crossHold: 0.66,
  crossFree: 3.5,
  crossNear: 0.5,
};

/**
 * THE MAP-SIZE LEVER — and, just as important, what it deliberately does NOT
 * touch (spec-sim-implemented.md P5).
 *
 * Every distance in `BOT_TUNING` was measured on a 33 m yard. Some of them are
 * about the MAP (how far away is "far", how wide is a flank, when is a walk
 * worth sprinting) and read wrong the instant the map is 123 m long. Others are
 * about the BODY, and they are the same on every map in the world.
 *
 * SCALED — map geometry:
 *   sprintGate    "far enough that running is worth it"
 *   repathSweet   the goal-distance the patrol scorer likes best
 *   repathMin/Far the floor under a new goal — a goal 3 m away on dust2 is a
 *                 goal in the same room, and picking one is how a bot spends a
 *                 minute crossing B site one doorway at a time
 *   flank*        the radii the fight geometry is built out of
 *   engageFar/Near/Hurt  the range bands those radii are chosen by
 *   crossFree     how close "he is on top of me" is, relative to the range
 *                 fights actually happen at on this map
 *
 * NOT SCALED, on purpose:
 *   standoff, standoffLow, sprintNear   These are RIG measurements — 0.95 is
 *     where the leg swing ends, 1.22 is where the pelvis and skull orbit ends,
 *     1.5 is where the sprint clip throws the hands. A bruiser's arms are the
 *     same length on dust2. Scaling them by 2.2 would ask every bot to keep
 *     2.7 m off every wall, which on a map made of corridors means no corners,
 *     no peeking and no cover at all.
 *   progressM, stuckWin, stuckDisp, loiterWin/Disp   The watchdog is a
 *     SPEEDOMETER, not a preference: 1.5 m in 3 s is 0.5 m/s, and a bot's top
 *     speed is 4.35 m/s on every map ever made. A bigger map does not make a
 *     body slower, so loosening the watchdog there would not fix navigation —
 *     it would stop measuring it, and the whole point of BOT_HEALTH.windows is
 *     that it is the number that catches a navigator failing. If dust2 fires
 *     more windows than Shipment, the honest fix is upstream (a connected nav
 *     graph, goals worth walking to) and the watchdog is how you know it
 *     worked. See docs/dustmap/build-w3-gameplay.md for the before/after.
 *   Every time in seconds, every damage number, every angle.
 *
 * Shipment is 1.0 and every product below is therefore the authored literal,
 * exactly (IEEE-754 multiplication by 1.0 is the identity) — which is what keeps
 * the equivalence hash matching.
 */
const BOT_SCALE = (() => {
  // `botScale` is the field this wants and MapDef now declares it (optional, so
  // Shipment's 1.0 needs no entry). `audioScale` — "this map's distance scale",
  // the only reason dust2 is not silent past 42 m — stays as the fallback for a
  // MapDef that authored one and not the other, and anything declaring neither
  // lands on 1.
  const s = MAP.botScale ?? MAP.audioScale ?? 1;
  return Number.isFinite(s) && s > 0 ? s : 1;
})();

/** `BOT_TUNING`'s map-geometry distances, in THIS map's metres. */
export const BOT_RANGE = {
  scale: BOT_SCALE,
  /** Sprint when the enemy is at least this far. */
  sprintGate: 13 * BOT_SCALE,
  /** The patrol scorer's favourite goal distance. */
  repathSweet: 11 * BOT_SCALE,
  /** Floor under a new patrol goal, ordinary and post-watchdog. */
  repathMin: 3.0 * BOT_SCALE,
  repathMinFar: 5.5 * BOT_SCALE,
  /** Range bands the fight movement is chosen by. */
  engageFar: 9 * BOT_SCALE,
  engageNear: 4.5 * BOT_SCALE,
  engageHurt: 12 * BOT_SCALE,
  /** Flank/relocate radii and the push-in/back-off offsets that go with them. */
  flankBreak: 6 * BOT_SCALE,
  flankBreakSide: 3.5 * BOT_SCALE,
  flankRelocate: 6 * BOT_SCALE,
  flankRelocateIn: 1.5 * BOT_SCALE,
  flankArc: 4 * BOT_SCALE,
  flankHold: 3.5 * BOT_SCALE,
  flankHoldIn: 0.8 * BOT_SCALE,
  flankClose: 3 * BOT_SCALE,
  flankCloseOut: 1.4 * BOT_SCALE,
  /** Below this, a teammate's shot only holds your trigger for `crossNear`. */
  crossFree: BOT_TUNING.crossFree * BOT_SCALE,
};

/**
 * FAIRNESS TELEMETRY.
 *
 * The knobs above shape a distribution, and a knob whose effect an instrument
 * cannot see is a knob nobody can review. botwatch already measures the outcome
 * (TTK on the player); this measures the two inputs that produce it and that
 * nothing else can observe from outside the sim:
 *
 *   reaction  first LOS on a NEW enemy -> that engagement's first round leaving
 *             the gun, seconds. The spec asks for 0.35-0.7 s; this is the only
 *             place that number is knowable, because a bot that sees you through
 *             a gap and is still turning has no visible tell.
 *   burst     rounds actually fired per burst — the model asks for 2-3, the
 *             weapon's cadence and reload can shorten one.
 *   gap       seconds of pause actually taken between bursts. Together with
 *             `burst` this IS the TTK floor: 3 rounds max and a >= 0.66 s pause
 *             mean a fourth hit cannot arrive before 0.81 s.
 *
 * Rings, not arrays — a long match must not grow memory. Read it from an
 * instrument with `botFairness()`; both it and BOT_TUNING are exported so a
 * report can print the knobs next to the distribution they produced.
 */
const BOT_FAIRNESS = {
  reaction: { v: new Float32Array(256), n: 0 },
  burst: { v: new Float32Array(256), n: 0 },
  gap: { v: new Float32Array(256), n: 0 },
  /** Seconds a bot spent holding its trigger for a teammate already on the
   *  target — the squad-discipline knob, visible so it can be reviewed. */
  yield: { v: new Float32Array(256), n: 0 },
};

/**
 * Who last put a round into whom, per session: `target id -> { by, t }`. This is
 * the whole of the squad fire discipline described on BOT_TUNING.crossHold, and
 * it is a WeakMap on the session so a server hosting several matches keeps them
 * apart and a finished match takes its table with it.
 */
const BOT_PRESS = new WeakMap<GameSession, Map<string, { by: string; t: number }>>();

function botPress(s: GameSession): Map<string, { by: string; t: number }> {
  let m = BOT_PRESS.get(s);
  if (!m) BOT_PRESS.set(s, (m = new Map()));
  return m;
}

function botFairnessLog(r: { v: Float32Array; n: number }, x: number): void {
  r.v[r.n % r.v.length] = x;
  r.n += 1;
}

function botFairnessStat(r: { v: Float32Array; n: number }): {
  n: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
} {
  const k = Math.min(r.n, r.v.length);
  if (!k) return { n: 0, min: 0, p50: 0, p90: 0, max: 0 };
  const a = Array.from(r.v.subarray(0, k)).sort((x, y) => x - y);
  const q = (f: number): number => a[Math.min(k - 1, Math.floor(k * f))]!;
  return { n: r.n, min: a[0]!, p50: q(0.5), p90: q(0.9), max: a[k - 1]! };
}

/** Snapshot of what the bot trigger actually did, for QA instruments. */
export function botFairness(): {
  tuning: typeof BOT_TUNING;
  reaction: ReturnType<typeof botFairnessStat>;
  burst: ReturnType<typeof botFairnessStat>;
  gap: ReturnType<typeof botFairnessStat>;
  yield: ReturnType<typeof botFairnessStat>;
} {
  return {
    tuning: BOT_TUNING,
    reaction: botFairnessStat(BOT_FAIRNESS.reaction),
    burst: botFairnessStat(BOT_FAIRNESS.burst),
    gap: botFairnessStat(BOT_FAIRNESS.gap),
    yield: botFairnessStat(BOT_FAIRNESS.yield),
  };
}

/**
 * THE INVARIANT: a bot that cannot get anywhere is a COUNTED event.
 *
 * The freeze this file's navigator was rebuilt for is rare enough (21 episodes
 * in 72,000 bot-seconds, before the fix) that it can come back and hide for a
 * whole review cycle — P4 shipped "0 STUCK across four runs" and the next
 * reviewer caught bot-8 standing in the green walkthrough for 9.5 s. A defect
 * that rare needs a counter rather than a spot check, so the sim keeps its own:
 *
 *   windows  watchdog windows failed (3 s without `progressM` of displacement)
 *   escapes  of those, the ones that had to escalate to a committed run
 *   frozen   EPISODES OF THE ACTUAL DEFECT, and the one that must stay at zero:
 *            botwatch's own STUCK test — max displacement from the body's
 *            current position over a rolling 6 s of 2 Hz samples under 0.6 m,
 *            alive and unprotected throughout — evaluated inside the sim. Same
 *            rule, same numbers, so a headless probe and a real-GPU match are
 *            measuring one thing and a regression cannot hide between them.
 *   worstFreeze  the longest such span seen, seconds
 *
 * The first two are context: a busy watchdog is a navigator doing its job in a
 * yard full of containers, not a defect. Read it with `botHealth()`;
 * qa/stuck-probe.ts fails a run on `frozen > 0`.
 */
const BOT_HEALTH = { windows: 0, escapes: 0, frozen: 0, worstFreeze: 0 };

export function botHealth(): { windows: number; escapes: number; frozen: number; worstFreeze: number } {
  return { ...BOT_HEALTH, worstFreeze: +BOT_HEALTH.worstFreeze.toFixed(2) };
}

/** Samples in the freeze ring: 6 s at 2 Hz, botwatch's window exactly. */
const BOT_FREEZE_N = 13;
const BOT_FREEZE_DT = 0.5;

/**
 * WHAT ONE BOT'S BRAIN IS DOING RIGHT NOW, for instruments (null for a body
 * that has never thought — a human seat, or a bot on its first tick).
 *
 * The freeze the player reported ("monkeys just standing there") is invisible
 * from outside the sim: a stationary body looks the same whether its navigator
 * has no goal, its standoff cancelled every direction, or its stick input fell
 * under movePlayer's 0.12 dead zone. This exports exactly the state that tells
 * those apart, and nothing in the sim reads it back.
 */
export function botProbe(p: SimPlayer): {
  goal: [number, number];
  goalAge: number;
  node: number;
  routed: boolean;
  dir: [number, number];
  wish: number;
  band: number;
  ax: number;
  az: number;
  stickSum: number;
  escape: number;
  stuckRun: number;
  plant: number;
  reposition: number;
  anchorAge: number;
  anchorDisp: number;
  stall: number;
} | null {
  const m = BOT_MINDS.get(p);
  if (!m) return null;
  return {
    goal: [+m.goalX.toFixed(2), +m.goalZ.toFixed(2)],
    goalAge: +m.goalT.toFixed(2),
    node: m.node,
    routed: m.routed,
    dir: [+m.dirX.toFixed(2), +m.dirZ.toFixed(2)],
    wish: +m.wish.toFixed(3),
    band: m.band,
    ax: +m.lastAx.toFixed(3),
    az: +m.lastAz.toFixed(3),
    stickSum: +(Math.abs(m.lastAx) + Math.abs(m.lastAz)).toFixed(3),
    escape: +m.escape.toFixed(2),
    stuckRun: m.stuckRun,
    plant: +m.plant.toFixed(2),
    reposition: +m.reposition.toFixed(2),
    anchorAge: +(m.t - m.anchorT).toFixed(2),
    anchorDisp: +Math.hypot(p.x - m.anchorX, p.z - m.anchorZ).toFixed(2),
    stall: +m.stall.toFixed(2),
  };
}

/** Radius the navigator STEERS with. Wider, and deliberately: the wall standoff
 * refuses to walk a line that ends against steel, so a route planned at body
 * width sends a bot into a squeeze the standoff then refuses to enter, and it
 * ping-pongs on the lip of it (measured: the crate at (2.5,2.15) against the
 * green shell wall, bots shuffling at (2.9,3.2) for six seconds). Planning at
 * standoff width means the route and the standoff want the same thing.
 */
const BOT_PLAN_R = RADIUS + 0.45;

/**
 * The ladder botMove walks down when the standoff it wants does not fit. 0 means
 * "whatever the face itself asks for" (`standoff` / `standoffLow`); the rest are
 * uniform fallbacks, ending just outside body width so that even a bot in a
 * pocket is steering rather than shuffling.
 */
const BOT_BANDS = [0, 0.62, 0.34, 0.16];

/**
 * The sim-side twin of inspect.ts `clearanceGrid`: is a standing body legal
 * here? Same rules resolveCircle plays by — roofs are not floors, a
 * mantle-height climbable is walked over, everything else is steel.
 *
 * `lowSolid` asks the OTHER question: is it legal here for a body that would
 * rather not wade through a dumpster? See LOW PROPS ARE NOT DOORWAYS, below.
 */
function botBlocked(x: number, z: number, r: number, lowSolid = false, fromY = Infinity, y = groundHeight(x, z, SOLIDS, fromY), allowRailVault = false): boolean {
  // Nothing here moves, so one gathered list covers the whole sweep. The
  // per-solid bounding-circle test below is kept: it is exact where the grid is
  // only conservative, and it costs two multiplies.
  const cand = gridQueryCircle(solidGrid(), x, z, r * Math.SQRT2, BB_NEAR);
  for (let ci = 0; ci < cand.length; ci++) {
    const o = SOLIDS[cand[ci]!]!;
    if (o.visual === "roof") continue;
    const top = o.y + o.sy * 0.5;
    const bot = o.y - o.sy * 0.5;
    const dx = x - o.x;
    const dz = z - o.z;
    const reach = r + solidFootRadius(o, cand[ci]!);
    if (dx * dx + dz * dz > reach * reach) continue;
    // NUKETOWN RAIL VAULTS ARE HARD STEEL to every live query: a wandering,
    // chasing or funnelled bot must feel the 3 m drop, and the band ladder
    // (1.22→0.62→0.34→0.16→crossLow) plus pre-standoff separation must never
    // narrow it away. Only the link builder opts back in (allowRailVault),
    // and only for deck-level edges — lawn→deck legs stay steel. Other maps
    // never set vault, so this branch is dead code off Nuketown.
    //
    // JUMP-VAULT NAV AGREEMENT (LOW-2): this branch sits ABOVE the y-skip on
    // purpose, with its own height gate. nav ground (botGroundY below, and
    // this function's own default y) reads deck under a rail footprint;
    // the legacy nav ground instead lifted
    // the sample to the rail top ~4.0, and the old order then skipped the
    // steel test on that lifted y (y > top - 0.02) and reported clear inside
    // body width — while live steering holds the same panel as steel. Steel
    // first keeps nav ground and nav steel in agreement by construction. A
    // body at/above the top still skips its own panel (nothing balanced on a
    // rail reads blocked), and the shipped backstops (graph reject at 5018 +
    // live botWallPush standoff) already held — this only removes the
    // by-construction disagreement.
    if (o.vault && NAV_Y && !allowRailVault) {
      if (y + STAND_H < bot + 0.05 || y > top - 0.02) continue;
      const hitRail = circleHitsOBB(x, z, r, o);
      if (hitRail.hit && hitRail.pen > 0) return true;
      continue;
    }
    if (y + STAND_H < bot + 0.05 || y > top - 0.02) continue;
    // A MANTLE-HEIGHT CLIMBABLE BOX IS NEVER STEEL — except to the two
    // preferred passes of `botSteer`'s bearing fan (`lowSolid`), which treat
    // Shipment's low PROPS as obstacles to walk around rather than over.
    //
    // On a map whose climbable set is its FLOOR set that exemption is pure loss:
    // a 0.406 m stair riser reads as a wall to the planner, both preferred
    // passes fail, and the fan takes the one bearing that is clear — sideways,
    // along the tread. `CLIMB_IS_FLOOR` (MapDef.climbablesAreFloors, measured
    // per map) turns the exemption off where there are no props to protect.
    // Shipment's flag is false, so this reads exactly as `!lowSolid && …` did.
    if ((!lowSolid || CLIMB_IS_FLOOR) && o.climb && top - y < 1.05 && y + 0.2 < top) continue;
    const hit = circleHitsOBB(x, z, r, o);
    if (hit.hit && hit.pen > 0) return true;
  }
  return false;
}

/** The floor a standing bot would be on at (x,z), stepping from `fromY`.
 *
 * JUMP-VAULT NAV AGREEMENT (LOW-2): nav ground never vaults
 * — a deck-level walker must read deck under a rail footprint, not the rail
 * top. The legacy default instead lifted
 * the sample to railTop
 * ~4.0, and the old botBlocked order then skipped the steel test on that
 * lifted y and reported clear inside body width. Standing ON a rail still
 * counts (groundHeight keeps a top at/above fromY),
 * and other maps have no vault box, so the flag is a dead branch there.
 */
function botGroundY(x: number, z: number, fromY = Infinity): number {
  return groundHeight(x, z, SOLIDS, fromY);
}

/** Instruments only (nuketown rail sweeps): the walker-height query, verbatim. */
export function botGroundYDebug(x: number, z: number, fromY: number): number {
  return botGroundY(x, z, fromY);
}

/**
 * Can a body walk the straight line a->b without touching steel?
 *
 * `fromY` carries the walker's own height down the line so `groundHeight` can
 * ignore decks it could not have stepped onto. On a single-deck map that is
 * strictly redundant, so `walkFromY` hands back Infinity there and every sample
 * asks exactly the question it asked before this parameter existed.
 */
function botPathClear(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  r: number,
  lowSolid = false,
  fromY = Infinity,
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l = Math.hypot(dx, dz);
  // NAV_Y maps sample every 0.25 m: a 0.5 m stride steps straight past a
  // window jamb's corner (the line "clears" a 2 m opening it cannot walk)
  const n = NAV_Y ? Math.max(1, Math.min(40, Math.ceil(l / 0.25))) : Math.max(1, Math.min(16, Math.ceil(l / 0.5)));
  // RAIL STRIDE HOLE (security D): the samples above are 0.25 m apart and the
  // rail panel is 0.12 m thick, so a probe aimed straight across a deck rail
  // lands a sample on either side and reads clear — while steering (which aims
  // through the "clear" line) then walks the body into steel it mantles over
  // by design (resolveCircle steps a deck body onto the rail top), and the
  // clamp only contains where it lands. botBlocked already holds every rail
  // as hard steel per sample (allowRailVault defaults false); this closes the
  // gap BETWEEN samples. Height-gated, so lawn legs under the balcony still
  // read clear; expanded by the query radius, so a centreline that merely
  // misses the panel at body width still counts as a crossing. Dead branch
  // off NAV_Y maps (RAIL_VAULT_N === 0 everywhere else) — including the height
  // tracking below, which costs the other maps nothing.
  const trackRail = NAV_Y && RAIL_VAULT_N > 0;
  let yLo = trackRail ? (Number.isFinite(fromY) ? fromY : botGroundY(x0, z0, Infinity)) : 0;
  let yHi = yLo;
  let y = fromY;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = x0 + dx * t;
    const z = z0 + dz * t;
    const ground = botGroundY(x, z, y);
    if (botBlocked(x, z, r, lowSolid, y, ground)) return false;
    if (y !== Infinity) {
      y = ground;
      if (trackRail) {
        if (ground < yLo) yLo = ground;
        if (ground > yHi) yHi = ground;
      }
    }
  }
  if (trackRail && segHitsRailVault(x0, z0, x1, z1, yLo, yHi, r)) return false;
  return true;
}

/**
 * The height to walk a probe FROM: the body's own feet on a map with stacked
 * floors, "anywhere" on a single-deck one.
 *
 * Shipment takes the second branch and that is deliberate, not laziness — see
 * MapDef.stackedFloors. Its forklift tops out at 1.90 m, 0.85 m above the mantle
 * ceiling, so threading a real `fromY` would newly BLOCK the (10.25, 10.25) nav
 * lattice point that today sits on the forklift's roof, and would move a spawn
 * that the anti-crowd shove can push into the same footprint. Both are real
 * changes to a map whose contract is that nothing about it changes.
 */
function walkFromY(y: number): number {
  return STACKED_FLOORS ? y : Infinity;
}

/**
 * The navigable goal set. WAYPOINTS is authored for the map, not for the
 * collider set, and the P2 prop pass left four of its points inside solids —
 * a bot sent at one can only lean on the wall in front of it forever. Each
 * point is therefore verified here and, when it is buried, walked out to the
 * nearest standing room (the lane it represents is still worth patrolling)
 * instead of being dropped. The extra points are the yard's open pockets and, at
 * the bottom of this function, a lattice over whatever standing room those two
 * still leave uncovered: with lane waypoints alone, bot trails only touched
 * 51.4% of the passable cells; 19 waypoints + 16 pockets come out as 34 points
 * and the lattice takes it to 87.
 */
/**
 * A nav node carries `y` now.
 *
 * It is derived (`groundHeight(x, z)`), not authored, and on a single-deck map
 * nothing reads it. It exists for dust2, where the same (x, z) is B tunnels at
 * -3.25 and the platform over them at +2.44: without a height the graph cannot
 * tell "walk to the far side of the bridge" from "walk off the bridge".
 */
type BotNavPt = { x: number; z: number; y: number };

function buildBotNav(): BotNavPt[] {
  const out: BotNavPt[] = [];
  const stacked = MAP.stackedFloors;
  // `fromY` is Infinity for every seed except a NAV_Y seed, which resolves its
  // floor from its own storey (see Waypoint.y) — default args keep the old calls.
  const add = (x: number, z: number, fromY = Infinity): void => {
    if (botBlocked(x, z, BOT_CLEAR_R, false, fromY)) return;
    const y = botGroundY(x, z, fromY);
    // Dedupe is 2D on a single-deck map, exactly as it was. Where a height gate
    // is configured the map is multi-level, and two points a metre apart in xz
    // but a storey apart in y are two different places, not a duplicate.
    for (const q of out) {
      if (Math.hypot(q.x - x, q.z - z) >= 1.1) continue;
      if (stacked && Math.abs(q.y - y) > 1.05) continue;
      return;
    }
    out.push({ x, z, y });
  };
  for (const w of WAYPOINTS) {
    const fy = NAV_Y && w.y !== undefined ? w.y + 0.05 : Infinity;
    if (!botBlocked(w.x, w.z, BOT_CLEAR_R, false, fy)) {
      add(w.x, w.z, fy);
      continue;
    }
    let done = false;
    for (let ring = 0.7; ring <= 4.2 && !done; ring += 0.7) {
      for (let a = 0; a < 16 && !done; a++) {
        const th = (a / 16) * Math.PI * 2;
        const x = w.x + Math.cos(th) * ring;
        const z = w.z + Math.sin(th) * ring;
        if (botBlocked(x, z, BOT_CLEAR_R, false, fy)) continue;
        add(x, z, fy);
        done = true;
      }
    }
  }
  for (const [x, z] of MAP.navPockets) add(x, z);
  // THE LATTICE. Lane waypoints plus hand-picked pockets are 34 points for a
  // 33 m yard, and once bots ROUTE between them (BOT_HOP) the trails collapse
  // onto the lines that join them: measured, identical seeds, coverage 62.9% ->
  // 58.9% while metres walked went UP 7%. A greedy navigator used to explore by
  // failing — fanning off blocked bearings and hugging container faces — and a
  // navigator that works has to replace that wandering with somewhere to go.
  // So the leftover standing room gets points of its own, on a coarse lattice
  // (`add` drops anything blocked or within 1.1 m of an existing point), and the
  // patrol scorer's staleness term does the rest.
  //
  // MAP-DERIVED NOW. This used to read `for (x = -14.6; x <= 14.7; x += 3.55)`
  // — the single most Shipment-specific line in the file. Shipment's MapDef
  // reproduces those four literals and that literal step deliberately: repeated
  // `+= step` accumulates float error, and every nav position (hence BOT_HOP,
  // hence every bot route) rides on that exact sequence of doubles.
  // step <= 0 means the map brings its own sampled nav set and wants no lattice
  // on top of it (dust2 ships 249 generated seeds at 5.55 m — that IS a lattice).
  const L = MAP.navLattice;
  if (L.step > 0) {
    for (let x = L.x0; x <= L.x1; x += L.step) {
      for (let z = L.z0; z <= L.z1; z += L.step) add(x, z);
    }
  }
  return out;
}

/** Exported for instruments: the patrol set is half of what a heatmap means. */
export const BOT_NAV: BotNavPt[] = buildBotNav();

/**
 * SPAWN POOLS ON A STACKED-FLOORS MAP (dust2). Shipment never comes here.
 *
 * dust2 ships twelve authored spawns — six per team, both ends of the map —
 * and the FFA room seats fifteen. Fifteen bodies on twelve points, all at the
 * two ends, is exactly the "everyone spawns on one side and stacks" the room
 * was complained about for. The nav graph is already the answer: every BOT_NAV
 * node was walked, validated against the colliders and given a floor height
 * at build. Each one that also passes spawnNodeOk (standing room at a wider
 * radius than a walking bot needs, well inside the bounds, and the floor really
 * is the floor it claims) becomes a spawn point:
 *
 *   FFA   — every valid node in the map plus the authored twelve.
 *   Teams — the authored six for the side plus every valid node within
 *           TEAM_SPAWN_REACH of one of them on the same storey, so a 6-body
 *           side has dozens of points to spread over instead of six.
 *
 * Yaw on a nav spawn faces the map centre: there is no authored facing and a
 * body that wakes looking at the wall behind its own spawn is a body that dies
 * turning round.
 */
const SPAWN_TRACE_TOP = 24;
const SPAWN_LOS_RANGE = 40;
const SPAWN_CLEAR_R = RADIUS + 0.6;
const SPAWN_BOUNDS_INSET = 1.5;
const TEAM_SPAWN_REACH = 25;
const TEAM_SPAWN_DY = 1.5;

function spawnInBounds(x: number, z: number, inset: number): boolean {
  const b = MAP.bounds;
  return x >= b.minX + inset && x <= b.maxX - inset && z >= b.minZ + inset && z <= b.maxZ - inset;
}

/**
 * The floor a body may materialise on at (x, z), reached from `fromY`, or null
 * when nothing may: out of bounds, a solid inside the standing cylinder, or the
 * floor found is not the storey the point belongs to (a shove that carried the
 * footprint over the lip of B tunnels answers 3 m lower — that is a fall, not a
 * spawn).
 */
function spawnFootY(x: number, z: number, fromY: number): number | null {
  if (!spawnInBounds(x, z, SPAWN_BOUNDS_INSET * 0.5)) return null;
  const y = groundHeight(x, z, SOLIDS, walkFromY(fromY));
  if (!Number.isFinite(y) || Math.abs(y - fromY) > 0.6) return null;
  if (spawnBlocked(x, y, z, RADIUS + 0.05)) return null;
  return y;
}

/**
 * Is any solid inside the standing cylinder (radius r, feet at y)? Stricter
 * than botBlocked on purpose: a walking bot may treat a mantle-height step as
 * floor and clip its edge, but a body that MATERIALISES four centimetres inside
 * a stair riser has spawned in geometry, however briefly the pushout lasts.
 * Nothing is exempt but roofs (never collided) and whatever the feet stand on.
 */
function spawnBlocked(x: number, y: number, z: number, r: number): boolean {
  const cand = gridQueryCircle(solidGrid(), x, z, r * Math.SQRT2, BB_NEAR);
  for (let ci = 0; ci < cand.length; ci++) {
    const o = SOLIDS[cand[ci]!]!;
    if (o.visual === "roof") continue;
    const top = o.y + o.sy * 0.5;
    const bot = o.y - o.sy * 0.5;
    if (y + STAND_H <= bot + 0.05 || y + 0.05 >= top) continue;
    if (circleHitsOBB(x, z, r, o).hit) return true;
  }
  return false;
}

function spawnNodeOk(n: BotNavPt): boolean {
  if (!spawnInBounds(n.x, n.z, SPAWN_BOUNDS_INSET)) return false;
  const y = groundHeight(n.x, n.z, SOLIDS, n.y);
  if (!Number.isFinite(y) || Math.abs(y - n.y) >= 0.05) return false;
  return !spawnBlocked(n.x, y, n.z, SPAWN_CLEAR_R);
}

function navSpawn(n: BotNavPt, team: 0 | 1): Spawn {
  const b = MAP.bounds;
  const cx = (b.minX + b.maxX) * 0.5;
  const cz = (b.minZ + b.maxZ) * 0.5;
  // Forward is (sin yaw, cos yaw) — see the wish-direction maths in movePlayer.
  return { x: n.x, y: n.y, z: n.z, yaw: Math.atan2(cx - n.x, cz - n.z), team };
}

const SPAWN_POOLS: Map<string, Spawn[]> = new Map();

function spawnPool(mode: string, team: 0 | 1): Spawn[] {
  const key = mode === "ffa" ? "ffa" : `team${team}`;
  let pool = SPAWN_POOLS.get(key);
  if (pool) return pool;
  if (mode === "ffa") {
    pool = [...SPAWNS];
    for (const n of BOT_NAV) if (spawnNodeOk(n)) pool.push(navSpawn(n, 0));
  } else {
    const side = SPAWNS.filter((s) => s.team === team);
    pool = [...side];
    for (const n of BOT_NAV) {
      if (!spawnNodeOk(n)) continue;
      const near = side.some((s) => Math.hypot(s.x - n.x, s.z - n.z) <= TEAM_SPAWN_REACH && Math.abs(s.y - n.y) <= TEAM_SPAWN_DY);
      if (near) pool.push(navSpawn(n, team));
    }
  }
  SPAWN_POOLS.set(key, pool);
  return pool;
}

/** Instruments only: the spawn pool a mode/team draws from on this map. */
export function spawnPoolFor(mode: "ffa" | "tdm", team: 0 | 1): Spawn[] {
  return STACKED_FLOORS ? spawnPool(mode, team) : SPAWNS.filter((s) => (mode === "ffa" ? true : s.team === team));
}

/**
 * THE ROUTE GRAPH — and the reason the user still saw monkeys standing in
 * containers after the P4 watchdog went in.
 *
 * `botSteer` is a greedy one-step navigator: it fans a 2.4 m probe around the
 * bearing to the goal and takes the first clear angle. That is enough in an open
 * yard and it is exactly wrong inside a walkthrough shell, because THREE of the
 * map's four walkthroughs are dead ends (measured, qa/out/stuck-probe.json):
 *
 *    east red    x 12.29..14.43, z -1.93..4.13 — the angled BLUE shell crosses
 *                the south mouth; a body 1 m south of it overlaps col-27 by
 *                0.141 m. In from the north, out only by the north.
 *    west green  the mirror of it, sealed at the north by the orange shell and
 *                the wreck-junk block at (-12.75, 1.665).
 *    green NE    the south mouth is plugged by the mantle crate at (2.5, 2.15).
 *
 * A goal on the far side of a sealed end therefore points the fan AT the seal
 * for as long as the bot is inside: it walks to the plug, the fan finds nothing,
 * the reverse fallback walks it back, the goal bearing re-asserts, and the whole
 * thing repeats. Net displacement over botwatch's 6 s window: 0.01-0.6 m. That
 * is the "standing there" the player reported, and 18 of the 21 freezes the
 * headless probe caught over 72,000 bot-seconds were one of these three rooms.
 *
 * A greedy navigator cannot fix this, because the way OUT of a dead end points
 * away from the goal — the information simply is not in a 2.4 m probe. So the
 * roster gets a map: every pair of nav points within `BOT_LINK_MAX` that a body
 * can walk in a straight line is an edge, and Floyd-Warshall over the 87 nodes
 * is collapsed into a NEXT-HOP table. Routing is then one array read per steer
 * with no allocation, and the corridor answers "to get to the far side of the
 * map, first walk north out of this room", which is the answer that was missing.
 * The table proves it: node (13.2,0), inside the east red walkthrough, has
 * exactly two edges and both of them go north.
 *
 * Built once at module load, before the first tick: 250 edges out of 3741 pairs,
 * each candidate sampled every 0.45 m by the same broad-phased test the
 * navigator already uses. The whole module's import cost goes 8 ms -> 22 ms.
 *
 * 6.6 m of link, not more: the nav lattice is 3.55 m (5.02 m on the diagonal),
 * so every neighbour is in reach, the graph comes out ONE connected component
 * with no isolated node, and the pair scan stays cheap.
 */
const BOT_LINK_MAX = MAP.navLattice.linkMax;

/**
 * How many vault panels this map has (Nuketown: 11, everywhere else: 0).
 * Lets the rail-crossing reject below compile to a single dead branch off
 * Nuketown — no scan, no behaviour change, bit-identical graphs elsewhere.
 */
const RAIL_VAULT_N = SOLIDS.reduce((n, o) => n + (o.vault ? 1 : 0), 0);

/**
 * Segment vs every vault footprint: does the line a→b run THROUGH
 * deck-rail steel at a height a body could occupy?
 *
 * HEIGHT GATE (review HIGH-1): the edge's vertical span is tested against the
 * panel's before the 2D crossing. Ground edges (feet ~0-0.22, head under 2 m)
 * pass ~3 m UNDER the 3.05 m rail bots and never touch it — the old exact-2D
 * test rejected them anyway and severed lawn routes running under the
 * balcony. Mirrors resolveCircle's own skip band (y+STAND_H < bot+0.05 ||
 * y > top-0.02), conservative on the edge's span — STANDING-ONLY, i.e. the
 * gate tests STAND_H even for a crouch/slide body, so a crouched or sliding
 * bot under the balcony can read blocked where it would physically fit. That
 * over-rejects safe low legs on purpose (documented, kept): a routed leg
 * never vaults, and a false blocked only reroutes around the house while a
 * false clear would route a body through rail steel it stalls on. A deck→deck
 * edge at 3.05 m overlaps [railBot, railTop] and is tested; a lawn→deck edge
 * spans it and is tested too (it can only cross the rail by vaulting it,
 * which routed legs never do).
 *
 * MINKOWSKI PAD (review HIGH-1, other way): pad 0 tests the CENTRELINE, but
 * the deck sampler (botBlocked at LINK_R, rails re-allowed as mantle for
 * deck-level edges) clears a centreline that misses the 0.12 m panel by
 * 0.1-0.5 m — while live steering holds the same rail as hard steel with a
 * 1.22 m standoff. So deck-height callers expand the panel by the radius they
 * planned at (LINK_R for graph edges, r for live probes): what the router
 * emits, a body at planning width can actually walk. Deck-interior legs that
 * merely run ALONGSIDE a rail stay clear of the expanded footprint (deck
 * interior nodes sit well off the rail line — measured, see the build pin
 * below) and survive; the deck stays connected via the stairs/dfloor, never
 * via a vault.
 */
function segHitsRailVault(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  yA: number,
  yB: number,
  pad: number,
): boolean {
  for (let k = 0; k < SOLIDS.length; k++) {
    const o = SOLIDS[k]!;
    if (!o.vault) continue;
    const top = o.y + o.sy / 2;
    const bot = o.y - o.sy / 2;
    if (Math.max(yA, yB) + STAND_H < bot + 0.05 || Math.min(yA, yB) > top - 0.02) continue;
    const c = Math.cos(-o.yaw);
    const s = Math.sin(-o.yaw);
    const lax = (ax - o.x) * c - (az - o.z) * s;
    const laz = (ax - o.x) * s + (az - o.z) * c;
    const lbx = (bx - o.x) * c - (bz - o.z) * s;
    const lbz = (bx - o.x) * s + (bz - o.z) * c;
    const hx = o.sx * 0.5 + pad;
    const hz = o.sz * 0.5 + pad;
    // Slab test, segment vs AABB in the panel's frame.
    let tmin = 0;
    let tmax = 1;
    const dx = lbx - lax;
    if (Math.abs(dx) < 1e-9) {
      if (lax < -hx || lax > hx) continue;
    } else {
      let t1 = (-hx - lax) / dx;
      let t2 = (hx - lax) / dx;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) continue;
    }
    const dz = lbz - laz;
    if (Math.abs(dz) < 1e-9) {
      if (laz < -hz || laz > hz) continue;
    } else {
      let t1 = (-hz - laz) / dz;
      let t2 = (hz - laz) / dz;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) continue;
    }
    return true;
  }
  return false;
}

/** Straight-line walkability for a graph edge. Same rules as botPathClear, but
 *  sampled by DISTANCE rather than capped at 16 steps — an 11 m link tested at
 *  0.69 m intervals can step straight over a 0.55 m wall slab. */
function botLinkClear(a: BotNavPt, b: BotNavPt): boolean {
  // NAV_Y maps validate links wider than the planner's body: a link that only
  // just threads a doorway from node centre to node centre is one a real
  // (off-centre) bot cannot walk, so the graph must route via the doorway
  // axis nodes instead. Shipment/Ares (flat): LINK_R === BOT_CLEAR_R.
  // Nuketown: BOT_CLEAR_R 0.44 + navLinkPad 0.05 = 0.49, a 0.98 m corridor
  // through the 1.10 m doors — pinned in buildNuketown, so a regen that drops
  // navLinkPad (default 0.15 → 1.18 m, wider than the doors) throws there
  // instead of silently fragmenting the graph here. Dust2 (NAV_Y, default pad
  // 0.15): 0.59 m — the shipped edge set (380 y-seeds, linkMax 12, lattice
  // off) was built under this radius and the 0.25 m stride, and the geo hash
  // pins seeds + pad + range, so a flat-validated set cannot slip in silent
  // (review MEDIUM-1).
  const LINK_R = NAV_Y ? BOT_CLEAR_R + (MAP.navLinkPad ?? 0.15) : BOT_CLEAR_R;
  // Nuketown rails: botLinkClear re-allows the vault-rail mantle ONLY for
  // edges whose BOTH ends are on the deck (y >= DECK_RAIL_ALLOW_Y, derived
  // from the same DECK_RAIL_DECKS/DECK_RAIL_TOL the geometry gate promotes on:
  // min deck 3.05 − 0.3 = 2.75, so decks 3.05/3.09 m pass while top stair
  // treads at 2.65/2.68 m and any tall prop at 2.5-3.0 m do not). No magic
  // literal: if the gate's decks ever move, this follows them. Every other
  // edge — lawn→deck, ground→deck, any leg with a low end — stays hard steel,
  // so no routed edge vaults the balcony from the outside. Other maps never
  // set vault, so the value of this flag is dead code off Nuketown.
  const allowRail = NAV_Y && Math.min(a.y, b.y) >= DECK_RAIL_ALLOW_Y;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const n = Math.max(2, Math.ceil(Math.hypot(dx, dz) / 0.45));
  if (BOT_HEIGHT_GATE === null) {
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (botBlocked(a.x + dx * t, a.z + dz * t, LINK_R)) return false;
    }
    return true;
  }
  let prevY = a.y;
  // A stair chain is a run of legal risers in ONE direction; a single sample that
  // reverses it is a ledge, not a step.
  let dir = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    // `fromY` is the previous sample's floor: this is a walker stepping along
    // the line, not a god-view query, so a deck 4 m overhead is invisible to it.
    if (i < n && botBlocked(x, z, LINK_R, false, prevY, botGroundY(x, z, prevY), allowRail)) return false;
    const y = i < n ? botGroundY(x, z, prevY) : b.y;
    const dy = y - prevY;
    const rise = Math.abs(dy);
    if (rise > BOT_HEIGHT_GATE) {
      // Legal step up/down? Only if it is inside the mantle window and it does
      // not contradict the direction the chain has been going.
      const step = rise > 0.2 && rise < 1.05;
      const sign = dy > 0 ? 1 : -1;
      if (!step || (dir !== 0 && sign !== dir)) return false;
      dir = sign;
    }
    prevY = y;
  }
  // RAIL-VAULT EDGES ARE UNROUTABLE (review HIGH-1, security #3). The sampler
  // above re-allows the rail mantle for deck-level edges, so without this a
  // deck→deck edge whose straight line runs THROUGH a rail panel reads clear
  // and the router emits it — while live steering (botBlocked default false +
  // botWallPush, which keeps the rail a face on EVERY rung) stalls at the
  // steel it was routed over. Any segment crossing a vault footprint is
  // therefore rejected from the routable set here: it stays steel to the
  // graph exactly as it is steel to the body, so routed and live agree by
  // construction. Deck-interior legs that merely run ALONGSIDE a rail stay
  // LINK_R clear of the expanded footprint and survive; the deck stays
  // connected via the stairs/dfloor, never via a vault. Falling off the
  // 0.12 m rail top with no balance model was never on the table — no emitted
  // hop touches a rail, and the import-time assertion below fails the build
  // if one ever does.
  if (NAV_Y && RAIL_VAULT_N > 0 && segHitsRailVault(a.x, a.z, b.x, b.z, a.y, b.y, LINK_R)) return false;
  return true;
}

/** Does this node have any straight-line neighbour at all? */
function botNavLinked(i: number): boolean {
  const a = BOT_NAV[i]!;
  for (let j = 0; j < BOT_NAV.length; j++) {
    if (j === i) continue;
    const b = BOT_NAV[j]!;
    if (Math.hypot(a.x - b.x, a.z - b.z) > BOT_LINK_MAX) continue;
    if (botLinkClear(a, b)) return true;
  }
  return false;
}

/**
 * A NAV POINT NOBODY CAN WALK TO IS A TRAP, and the patrol scorer sends bots at
 * it like any other. Two of the 87 are, every build: (-14.6,3.15) behind the
 * orange wreck and (10.25,10.25) in the forklift/crate cluster. Both are legal
 * standing room — that is why `buildBotNav` accepted them — but reachable only
 * through a gap narrower than the navigator plans for, so a bot that squeezes in
 * has no route out and paces (measured on the authored set, before the lattice:
 * bot-9 and bot-8 wedged at (12.6,11.5) for 7 s and 6 s).
 *
 * So every node must be ON the graph: an unlinked one is walked outward to the
 * nearest spot that is, exactly as a buried waypoint is, and dropped only when
 * the neighbourhood has nothing to offer. The corner still gets patrolled, from
 * a metre or two further out where the yard is open.
 */
function connectBotNav(): void {
  for (let i = BOT_NAV.length - 1; i >= 0; i--) {
    if (botNavLinked(i)) continue;
    const w = BOT_NAV[i]!;
    let fixed = false;
    for (let ring = 1.1; ring <= 4.4 && !fixed; ring += 1.1) {
      for (let a = 0; a < 12 && !fixed; a++) {
        const th = (a / 12) * Math.PI * 2;
        const x = w.x + Math.cos(th) * ring;
        const z = w.z + Math.sin(th) * ring;
        const fy = NAV_Y ? w.y + 0.05 : Infinity;
        if (botBlocked(x, z, BOT_CLEAR_R, false, fy)) continue;
        const was = { x: w.x, z: w.z, y: w.y };
        w.x = x;
        w.z = z;
        w.y = botGroundY(x, z, fy);
        if (botNavLinked(i)) fixed = true;
        else {
          w.x = was.x;
          w.z = was.z;
          w.y = was.y;
        }
      }
    }
    if (!fixed) BOT_NAV.splice(i, 1);
  }
}

/**
 * THE ROUTE TABLE — and the hard gate in front of it.
 *
 * Floyd-Warshall is O(n^3) and it runs SYNCHRONOUSLY at module import, in the
 * browser, before the first frame. 87 nodes is 658k operations and 1 ms. A naive
 * dust2 lattice at Shipment's 3.55 m step yields 600-900 nodes: 800^3 is 512 M
 * operations — five to fifteen seconds of a white screen — plus a 5.1 MB
 * Float64Array and a 1.3 MB Int16Array.
 *
 * So the node count is capped per map and BLOWING THE CAP IS FATAL, loudly, at
 * build time, with the count in the message. It does not silently coarsen the
 * lattice or truncate the list: a nav set quietly cut in half is bots stranded in
 * rooms nobody can explain three days later, which is strictly worse than a map
 * that refuses to load while somebody retunes `navLattice.step`.
 */
/**
 * THE EDGE SET, as CSR — the one thing both routers are built out of.
 *
 * This is the pair scan that used to open `buildBotHops`, lifted out unchanged:
 * same `i` ascending / `j = i+1` ascending order, same `BOT_LINK_MAX` reject,
 * same `botLinkClear` predicate, same `Math.hypot` weight. Extracting it costs
 * nothing (the scan is O(n^2) either way) and buys the two properties that make
 * the O(n^3) table optional: the graph is available WITHOUT a route table, and
 * both routers below provably read the same edges.
 */
type BotAdj = {
  /** Row offsets, length n+1. Neighbours of `i` are `to[off[i] .. off[i+1])`. */
  off: Int32Array;
  to: Int32Array;
  w: Float64Array;
  n: number;
  /** Undirected edges (each counted once) — diagnostics only. */
  edges: number;
};

export function buildBotAdj(
  n: number,
  linked: (i: number, j: number) => number,
): BotAdj {
  // Two passes so the arrays are exact: count degrees, then fill. The predicate
  // is called once per unordered pair in the same (i, j) order as the old scan.
  const deg = new Int32Array(n);
  const pi: number[] = [];
  const pj: number[] = [];
  const pw: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const l = linked(i, j);
      if (!(l >= 0)) continue;
      deg[i]!++;
      deg[j]!++;
      pi.push(i);
      pj.push(j);
      pw.push(l);
    }
  }
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i]! + deg[i]!;
  const to = new Int32Array(off[n]!);
  const w = new Float64Array(off[n]!);
  const cur = off.slice(0, n);
  for (let e = 0; e < pi.length; e++) {
    const i = pi[e]!;
    const j = pj[e]!;
    const l = pw[e]!;
    to[cur[i]!] = j;
    w[cur[i]!] = l;
    cur[i]!++;
    to[cur[j]!] = i;
    w[cur[j]!] = l;
    cur[j]!++;
  }
  return { off, to, w, n, edges: pi.length };
}

/**
 * THE DENSE ROUTE TABLE — Floyd-Warshall, byte for byte the shipped one.
 *
 * Kept, unchanged, because Shipment's contract is that nothing about Shipment
 * changes and this table IS Shipment's routing: 87 nodes, 658k operations, ~1 ms
 * at import, and every tie between two equal-length routes broken by the exact
 * order this triple loop happens to visit `k` in. No other algorithm reproduces
 * those tie-breaks, and a bot that turns left instead of right out of the east
 * walkthrough is a behaviour change even when both routes are the same length.
 *
 * What changed is WHO GETS IT: only maps small enough that it is free (see
 * `HOP_DENSE_MAX`). It is also the oracle the sparse router is measured against
 * — `navRouterReport()` runs both and counts the disagreements.
 */
export function buildHopDense(adj: BotAdj): Int16Array {
  const n = adj.n;
  const INF = 1e9;
  const d = new Float64Array(n * n).fill(INF);
  const hop = new Int16Array(n * n).fill(-1);
  for (let i = 0; i < n; i++) {
    d[i * n + i] = 0;
    hop[i * n + i] = i;
  }
  for (let i = 0; i < n; i++) {
    for (let e = adj.off[i]!; e < adj.off[i + 1]!; e++) {
      const j = adj.to[e]!;
      d[i * n + j] = adj.w[e]!;
      hop[i * n + j] = j;
    }
  }
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const dik = d[i * n + k]!;
      if (dik >= INF) continue;
      for (let j = 0; j < n; j++) {
        const v = dik + d[k * n + j]!;
        if (v < d[i * n + j]!) {
          d[i * n + j] = v;
          hop[i * n + j] = hop[i * n + k]!;
        }
      }
    }
  }
  return hop;
}

/**
 * THE SPARSE ROUTER — one Dijkstra per GOAL, cached, computed the first time a
 * bot actually asks for that goal.
 *
 * Why this exists (docs/dustmap/CONSTRAINTS.md, "BOT_HOP Floyd-Warshall is
 * O(n^3) and must move OFF the import path"): dust2 wants ~350-400 nav nodes in
 * one walk-connected component. 400^3 is 64 M operations of triple-nested
 * float compare — a fifth of a second of frozen main thread before the first
 * frame — plus a 1.28 MB Float64Array and a 320 kB Int16Array that exist purely
 * so a handful of goals can be looked up in O(1).
 *
 * The observation that kills the table: a bot does not need "the distance from
 * everywhere to everywhere". It needs "from where I am, which way to the place
 * I am going", and the set of places bots go is tiny — patrol nodes, the enemy,
 * a flank point — while the set of places bots ARE is the whole graph. Dijkstra
 * from the GOAL answers the whole column at once (the graph is undirected, so
 * the parent of `a` in a tree rooted at `g` IS a's next hop toward `g`), and one
 * column is the only column that goal will ever need. 400 nodes / ~2.4k edges
 * is ~22k operations, measured below at two orders of magnitude under the tick
 * budget, and it is paid ONCE per goal for the life of the process.
 *
 * The cache is bounded and FIFO: goals are re-asked every steer, so the working
 * set is the handful of live objectives and evictions only happen when bots have
 * genuinely moved on. A full column is 2n bytes — 64 goals x 400 nodes = 51 kB
 * against the dense table's 1.6 MB.
 */
export type HopRouter = {
  hop(a: number, g: number): number;
  /** Diagnostics for qa: how much work the cache actually saved. */
  stats(): { goals: number; runs: number; evictions: number; nodes: number };
};

/** How many goal columns to keep. Bots share objectives, so this is generous. */
const HOP_CACHE_MAX = 64;

export function makeHopRouter(adj: BotAdj): HopRouter {
  const n = adj.n;
  const cache = new Map<number, Int16Array>();
  let runs = 0;
  let evictions = 0;
  // Scratch reused across runs: no allocation on the steer path after warm-up.
  const dist = new Float64Array(n);
  // A node is pushed once per SUCCESSFUL relaxation, not once per node — this is
  // a lazy-deletion heap with no decrease-key — so the bound is the directed
  // edge count plus the root, never `n`. Sizing this `n + 1` overflows the heap
  // on any graph with a vertex of degree > 1, which is every graph we have.
  const heapNode = new Int32Array(adj.to.length + 2);
  const heapKey = new Float64Array(adj.to.length + 2);
  const done = new Uint8Array(n);

  function column(g: number): Int16Array {
    const hit = cache.get(g);
    if (hit) return hit;
    runs++;
    const next = new Int16Array(n).fill(-1);
    dist.fill(Infinity);
    done.fill(0);
    dist[g] = 0;
    next[g] = g;
    // Binary min-heap, 1-indexed. Lazy-deletion free: a node is skipped once
    // settled, so duplicate keys are harmless and no decrease-key is needed.
    let hn = 0;
    const push = (node: number, key: number): void => {
      let i = ++hn;
      heapNode[i] = node;
      heapKey[i] = key;
      while (i > 1) {
        const p = i >> 1;
        if (heapKey[p]! <= heapKey[i]!) break;
        const tn = heapNode[p]!;
        const tk = heapKey[p]!;
        heapNode[p] = heapNode[i]!;
        heapKey[p] = heapKey[i]!;
        heapNode[i] = tn;
        heapKey[i] = tk;
        i = p;
      }
    };
    push(g, 0);
    while (hn > 0) {
      const u = heapNode[1]!;
      const uk = heapKey[1]!;
      heapNode[1] = heapNode[hn]!;
      heapKey[1] = heapKey[hn]!;
      hn--;
      let i = 1;
      for (;;) {
        const l = i << 1;
        if (l > hn) break;
        const r = l + 1;
        const c = r <= hn && heapKey[r]! < heapKey[l]! ? r : l;
        if (heapKey[i]! <= heapKey[c]!) break;
        const tn = heapNode[c]!;
        const tk = heapKey[c]!;
        heapNode[c] = heapNode[i]!;
        heapKey[c] = heapKey[i]!;
        heapNode[i] = tn;
        heapKey[i] = tk;
        i = c;
      }
      if (done[u]) continue;
      if (uk > dist[u]!) continue;
      done[u] = 1;
      for (let e = adj.off[u]!; e < adj.off[u + 1]!; e++) {
        const v = adj.to[e]!;
        if (done[v]) continue;
        const nd = uk + adj.w[e]!;
        if (nd < dist[v]!) {
          dist[v] = nd;
          // Undirected graph: the way from v to g starts by walking to u.
          next[v] = u;
          push(v, nd);
        }
      }
    }
    if (cache.size >= HOP_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
        evictions++;
      }
    }
    cache.set(g, next);
    return next;
  }

  return {
    hop(a: number, g: number): number {
      if (a < 0 || g < 0 || a >= n || g >= n) return -1;
      return column(g)[a]!;
    },
    stats: () => ({ goals: cache.size, runs, evictions, nodes: n }),
  };
}

/**
 * THE THRESHOLD, and why it is a node count and not a map id.
 *
 * At or below it the dense table is built at import exactly as it always was;
 * above it, nothing is built at import at all. 128 nodes is 2.1 M operations —
 * ~2 ms, measured — which is the most main-thread time this module is willing
 * to spend before the first frame on something a lazy router can answer for
 * free. Shipment's 87 nodes sit comfortably under it, which is precisely the
 * point: Shipment keeps the dense table, keeps Floyd-Warshall's tie-breaks, and
 * keeps a bit-identical nav graph. dust2's 242 do not, and pay nothing at boot.
 */
const HOP_DENSE_MAX = 128;

function botLinkWeight(i: number, j: number): number {
  const a = BOT_NAV[i]!;
  const b = BOT_NAV[j]!;
  const l = Math.hypot(a.x - b.x, a.z - b.z);
  if (l > BOT_LINK_MAX || !botLinkClear(a, b)) return -1;
  return l;
}

connectBotNav();

/**
 * NODE-COUNT GATE, ahead of any O(n^2) work — where the old one was.
 *
 * It used to guard Floyd-Warshall's O(n^3); now that the table is optional above
 * `HOP_DENSE_MAX`, what it guards is the edge scan and the memory both routers
 * ride on. Still fatal, still loud, still with the count in the message: a nav
 * set silently truncated is bots stranded in rooms nobody can explain three days
 * later.
 */
if (BOT_NAV.length > MAP.navLattice.maxNodes) {
  throw new Error(
    `BOT_NAV built ${BOT_NAV.length} nodes for map "${MAP.id}" but the cap is ${MAP.navLattice.maxNodes}: ` +
      `the nav edge scan is O(n^2) at module import. Raise navLattice.step ` +
      `(currently ${MAP.navLattice.step} m) or raise the cap deliberately.`,
  );
}

/** The nav graph's edges. Always built at import — it is the O(n^2) scan the
 *  route table used to open with, and it is what makes the table optional. */
const BOT_ADJ = buildBotAdj(BOT_NAV.length, botLinkWeight);

/**
 * BUILD PIN (review HIGH-1, security #3): no ROUTED edge may cross a vault
 * footprint. botLinkClear's post-filter above already rejects such edges, so
 * this loop should never fire — it exists so a future edit that re-opens a
 * rail edge fails the build loudly instead of shipping bots a hop they stall
 * on (live steering treats every rail as steel on every rung). Height-gated
 * and LINK_R-expanded exactly like the filter it shadows. Runs once at
 * import, over the edge set, and is a dead branch (RAIL_VAULT_N === 0) on
 * every map but Nuketown.
 */
if (NAV_Y && RAIL_VAULT_N > 0) {
  const LINK_R = BOT_CLEAR_R + (MAP.navLinkPad ?? 0.15);
  for (let i = 0; i < BOT_ADJ.n; i++) {
    for (let e = BOT_ADJ.off[i]!; e < BOT_ADJ.off[i + 1]!; e++) {
      const j = BOT_ADJ.to[e]!;
      if (j <= i) continue;
      const a = BOT_NAV[i]!;
      const b = BOT_NAV[j]!;
      if (segHitsRailVault(a.x, a.z, b.x, b.z, a.y, b.y, LINK_R)) {
        throw new Error(
          `BOT_ADJ edge ${i}<->${j} crosses a vault panel: the router would emit an un-walkable hop (deck routes via stairs, never via a vault)`,
        );
      }
    }
  }
}
/**
 * WHICH WALK-CONNECTED COMPONENT EACH NAV NODE IS IN.
 *
 * One flood fill over the edges, once, at import — and the cheapest useful
 * question in the navigator, because it is the one the route table answers with
 * -1 after doing real work: *is there a route at all?*
 *
 * Shipment is ONE component (measured: 0 unreachable pairs out of 87^2), so
 * every comparison below is trivially true there and nothing about Shipment
 * changes. dust2 is currently EIGHT, the largest holding 88 of 219 nodes — see
 * docs/dustmap/build-w3-gameplay.md. CONSTRAINTS.md requires one, and closing
 * that is the collider/seed generator's job, not the navigator's. What the
 * navigator can do meanwhile is stop sending bots at goals they provably cannot
 * reach, which is most of what the progress watchdog was firing on.
 */
const BOT_COMP: Int32Array = (() => {
  const n = BOT_NAV.length;
  const comp = new Int32Array(n).fill(-1);
  let c = 0;
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s]! >= 0) continue;
    comp[s] = c;
    stack.length = 0;
    stack.push(s);
    while (stack.length) {
      const u = stack.pop()!;
      for (let e = BOT_ADJ.off[u]!; e < BOT_ADJ.off[u + 1]!; e++) {
        const v = BOT_ADJ.to[e]!;
        if (comp[v]! >= 0) continue;
        comp[v] = c;
        stack.push(v);
      }
    }
    c++;
  }
  return comp;
})();

/**
 * How many walk-connected components the nav graph has. 1 on a healthy map.
 *
 * Taken as `max(id) + 1`, NOT as the last node's id: the flood fill hands out
 * ids in order of the first UNVISITED node it meets, so the final node in the
 * array is usually one an earlier seed already reached and carries a low id.
 */
const BOT_COMP_N = (() => {
  let max = -1;
  for (let i = 0; i < BOT_COMP.length; i++) if (BOT_COMP[i]! > max) max = BOT_COMP[i]!;
  return max + 1;
})();

/** Dense next-hop table, or null on a map big enough to route lazily instead. */
const BOT_HOP: Int16Array | null = BOT_NAV.length <= HOP_DENSE_MAX ? buildHopDense(BOT_ADJ) : null;
/** Lazy per-goal router. Built (cheaply — it allocates scratch, nothing else)
 *  on every map; only ever CONSULTED where there is no dense table. */
const BOT_ROUTER = makeHopRouter(BOT_ADJ);

/** The routing primitive every call site uses: next node from `a` toward `g`. */
function botHop(a: number, g: number): number {
  if (BOT_HOP) return BOT_HOP[a * BOT_NAV.length + g]!;
  return BOT_ROUTER.hop(a, g);
}

/**
 * QA HOOK. Runs BOTH routers over every reachable (a, g) pair and reports the
 * disagreement count, so "the sparse router routes like the table" is a measured
 * number rather than a claim. Only callable where the dense table exists.
 */
/** Instruments only (scripts/nuketown/qa): the planner's straight-walk test, verbatim. */
export function botPathClearDebug(x0: number, z0: number, x1: number, z1: number, fromY: number): boolean {
  return botPathClear(x0, z0, x1, z1, BOT_CLEAR_R, false, walkFromY(fromY));
}

/** Instruments only (nuketown rail sweeps): the height-gated, Minkowski-padded rail-crossing test, verbatim. */
export function railSegHitsDebug(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  yA: number,
  yB: number,
  pad: number,
): boolean {
  return segHitsRailVault(ax, az, bx, bz, yA, yB, pad);
}

/** Instruments only: a bot's live mind (goal, route state). Never gameplay. */
export function botMindDebug(s: GameSession, p: SimPlayer): Record<string, unknown> {
  return botMind(s, p) as unknown as Record<string, unknown>;
}

/** Instruments only: BOT_NAV node positions (for the rail-crossing sweep). */
export function botNavNodesDebug(): Array<{ x: number; y: number; z: number }> {
  return BOT_NAV.map((q) => ({ x: q.x, y: q.y, z: q.z }));
}

/** Instruments only (qa/nuketown-map.test.ts, scripts/nuketown): the component id of every BOT_NAV node and the edge lists. */
export function navGraphDebug(): { comp: Int32Array; off: Int32Array; to: Int32Array } {
  return { comp: BOT_COMP, off: BOT_ADJ.off, to: BOT_ADJ.to };
}

export function navRouterReport(): {
  map: string;
  nodes: number;
  edges: number;
  dense: boolean;
  pairs: number;
  sameHop: number;
  diffHop: number;
  bothUnreachable: number;
  /** Walk-connected components. CONSTRAINTS.md wants dust2 to be exactly 1. */
  components: number;
  largestComponent: number;
} {
  const n = BOT_NAV.length;
  // Component sizes, off the SAME BOT_COMP the navigator routes by — a report
  // that flood-filled its own copy could agree with a broken one.
  const comps = BOT_COMP_N;
  const size = new Int32Array(comps);
  for (let i = 0; i < n; i++) size[BOT_COMP[i]!]!++;
  let largest = 0;
  for (let i = 0; i < comps; i++) if (size[i]! > largest) largest = size[i]!;
  const dense = BOT_HOP ?? buildHopDense(BOT_ADJ);
  const sparse = makeHopRouter(BOT_ADJ);
  let same = 0;
  let diff = 0;
  let none = 0;
  for (let g = 0; g < n; g++) {
    for (let a = 0; a < n; a++) {
      const x = dense[a * n + g]!;
      const y = sparse.hop(a, g);
      if (x < 0 && y < 0) none++;
      else if (x === y) same++;
      else diff++;
    }
  }
  return {
    map: MAP.id,
    nodes: n,
    edges: BOT_ADJ.edges,
    dense: BOT_HOP !== null,
    pairs: n * n,
    sameHop: same,
    diffHop: diff,
    bothUnreachable: none,
    components: comps,
    largestComponent: largest,
  };
}

/**
 * The graph node this body is standing at: the nearest one it can walk to in a
 * straight line. The common case — the nearest node is reachable — costs one
 * distance scan over 34 points and one short path probe, and only a bot standing
 * behind something pays for the second scan. Runs at the steer rate (~8 Hz), not
 * per tick.
 */
function botAnchorNode(p: SimPlayer, m: BotMind): number {
  let ni = -1;
  let nd = 1e9;
  for (let i = 0; i < BOT_NAV.length; i++) {
    const q = BOT_NAV[i]!;
    let d = (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z);
    if (NAV_Y) d += (q.y - p.y) * (q.y - p.y) * NAV_Y_W * NAV_Y_W;
    if (d < nd) {
      nd = d;
      ni = i;
    }
  }
  // The nearest node is the answer almost every time; it just has to be one the
  // body can actually walk to. NOT CACHED ACROSS POSITIONS: a stale anchor is a
  // route computed from where the bot used to be, and the last of the corridor
  // freezes was exactly that — a bot standing 0.75 m from node 28 routing as if
  // it were still at node 13, six metres away.
  if (ni >= 0 && botPathClear(p.x, p.z, BOT_NAV[ni]!.x, BOT_NAV[ni]!.z, BOT_CLEAR_R, false, walkFromY(p.y))) {
    m.node = ni;
    return ni;
  }
  let best = -1;
  let bd = 1e9;
  for (let i = 0; i < BOT_NAV.length; i++) {
    if (i === ni) continue;
    const q = BOT_NAV[i]!;
    const d = NAV_Y ? Math.hypot(q.x - p.x, q.z - p.z, (q.y - p.y) * NAV_Y_W) : Math.hypot(q.x - p.x, q.z - p.z);
    if (d >= bd) continue;
    if (!botPathClear(p.x, p.z, q.x, q.z, BOT_CLEAR_R, false, walkFromY(p.y))) continue;
    bd = d;
    best = i;
  }
  m.node = best >= 0 ? best : ni;
  return m.node;
}

/**
 * Which node to walk to NEXT to end up at (gx,gz), when the straight line there
 * is not walkable. Returns -1 when the graph has nothing to add and the local
 * fan should just do its job.
 */
function botRouteHop(p: SimPlayer, m: BotMind, gx: number, gz: number, gy = NaN): number {
  const n = BOT_NAV.length;
  let gi = -1;
  let gd = 1e9;
  const useY = NAV_Y && Number.isFinite(gy);
  for (let i = 0; i < n; i++) {
    const q = BOT_NAV[i]!;
    let d = (q.x - gx) * (q.x - gx) + (q.z - gz) * (q.z - gz);
    if (useY) d += (q.y - gy) * (q.y - gy) * NAV_Y_W * NAV_Y_W;
    if (d < gd) {
      gd = d;
      gi = i;
    }
  }
  const ai = botAnchorNode(p, m);
  if (ai < 0 || gi < 0 || ai === gi) return -1;
  let h = botHop(ai, gi);
  if (h < 0) return -1;
  let q = BOT_NAV[h]!;
  // ADVANCE THE ROUTE WHEN YOU ARE STANDING ON IT. Without this the hop a bot
  // has just arrived at stays the hop, the "am I there yet" guard in botSteer
  // drops the route, the goal bearing takes over — and in a dead-end shell the
  // goal bearing points back down the corridor. That is a ping-pong the ROUTE
  // creates rather than cures, and the probe caught it: bot-8 pacing the north
  // mouth of the east red walkthrough at 2.95 m/s, 0.1 m of net displacement.
  if (Math.hypot(q.x - p.x, q.z - p.z) < (NAV_Y ? NAV_Y_ARRIVE + 0.2 : 1.6) && (!NAV_Y || Math.abs(q.y - p.y) < 1.2)) {
    const h2 = botHop(h, gi);
    if (h2 >= 0 && h2 !== h) {
      h = h2;
      q = BOT_NAV[h]!;
    }
  }
  // The hop is reachable from the ANCHOR; a body that has drifted off it may
  // still have steel in the way. Closing on the anchor first is then the honest
  // move — unless the bot is already standing on it, in which case the local fan
  // owns the last few metres and doubling back would be the oscillation again.
  if (!botPathClear(p.x, p.z, q.x, q.z, BOT_CLEAR_R, false, walkFromY(p.y))) {
    const a = BOT_NAV[ai]!;
    if (Math.hypot(a.x - p.x, a.z - p.z) > (NAV_Y ? NAV_Y_ARRIVE : 1.6)) return ai;
  }
  return h;
}

/** Scratch for botWallPush — the bot brain allocates nothing per tick. */
const BOT_PUSH = { x: 0, z: 0 };
/** Scratch for botStandoff: face normals of the solids inside the standoff. */
const BOT_NEAR: { nx: number; nz: number; w: number }[] = [];

/** How close the nearest solid is, metres from the body centre to the face —
 *  1e9 when nothing is near. Written by botWallPush, read by the sprint
 *  governor, so the gait decision costs no extra collider sweep. */
let BOT_NEAREST = 1e9;

/**
 * Personal space against the map. Every solid within `standoff` of the body
 * contributes a face normal, weighted 0 at standoff and 1 flush.
 *
 * This is what ends the CORE clip class: 94 of botwatch's original 97 clips were
 * an arm or a hand inside the steel its owner was grinding along, and the rig
 * (measured, see BOT_TUNING.standoff) carries its pelvis up to 0.566 m and its
 * head up to 0.931 m outside the collision capsule the sim resolves. A standoff
 * of 0.95 m puts both of those in open air by construction.
 *
 * `band`, when given, overrides the standoff for every face — the unstick escape
 * passes a small one so a corridor that cancels a lateral wish cannot also
 * cancel the escape from it.
 *
 * `crossLow` drops the knee-high props out of the sweep entirely, and it is the
 * bottom rung of botMove's ladder. A mantle prop is not a wall: the collision
 * sweep walks a body straight over the crate at (2.5, 2.15), which is why the
 * navigator plans through it. The STANDOFF, however, held that crate at 0.95 m —
 * and the crate is parked in the mouth of the green walkthrough, 2.14 m wide, so
 * 0.95 m of clearance on either side of it does not exist. Planner and steering
 * therefore disagreed about the same square metre: the route said "through", the
 * band said "never", and the bot stood in the gap between the two opinions for
 * 8.5 s (qa/out/stuck-probe.json, bot-8 at (2.34,2.88), band 0.16, wish 0.10).
 * When a passage is only passable by stepping over something, a bot steps over
 * it — a foot grazing a knee-high crate for two frames is a smaller defect than
 * a monkey standing in a doorway.
 */
function botWallPush(p: SimPlayer, band = 0, crossLow = false): void {
  BOT_PUSH.x = 0;
  BOT_PUSH.z = 0;
  BOT_NEAR.length = 0;
  BOT_NEAREST = 1e9;
  // Widest query in the game: the standoff pad is RADIUS + max(band, sprintNear),
  // so the gather radius has to cover the largest band this ladder ever asks for
  // rather than the one it happens to be on. Nothing moves inside this sweep and
  // BOT_PUSH is a float SUM, so ascending index order is what keeps the total
  // bit-identical to the flat scan.
  const maxOff = Math.max(
    band > 0 ? band : Math.max(BOT_TUNING.standoff, BOT_TUNING.standoffLow),
    BOT_TUNING.sprintNear,
  );
  const cand = gridQueryCircle(solidGrid(), p.x, p.z, (RADIUS + maxOff) * Math.SQRT2, BW_NEAR);
  for (let ci = 0; ci < cand.length; ci++) {
    const o = SOLIDS[cand[ci]!]!;
    if (o.visual === "roof") continue;
    const top = o.y + o.sy * 0.5;
    const bot = o.y - o.sy * 0.5;
    if (p.y + STAND_H < bot + 0.05 || p.y > top - 0.02) continue;
    const mantle = !!o.climb && top - p.y < 1.05 && p.y + 0.2 < top;
    // NAV_Y (stacked-floor maps): a mantle-height climbable is a floor (stair
    // tread, window sill, porch roof), never a face to keep away from.
    // Nuketown deck rails (OBB.vault) are the exception on EVERY rung:
    // they stay a face even on the crossLow bottom rung (which otherwise drops
    // all mantles) and even on the funnel-narrowed ladder a routed
    // deck-to-deck leg starts on — plus separation runs BEFORE this sweep, so
    // a crowd shove that forces the ladder down to crossLow must still not
    // drop the rail. Players are untouched: resolveCircle/groundHeight never
    // read this, so the jump-vault works exactly as before (gated on
    // airborne there, on the wish running into rail steel here). Thin-epsilon and
    // rail thickness are asserted in the nuketown gate, not here; A.maxY is
    // reset per build; only this function reads vault.
    if (mantle && ((crossLow && !o.vault) || (NAV_Y && !o.vault))) continue;
    const off = band > 0 ? band : mantle ? BOT_TUNING.standoffLow : BOT_TUNING.standoff;
    const pad = RADIUS + Math.max(off, BOT_TUNING.sprintNear);
    const dx = p.x - o.x;
    const dz = p.z - o.z;
    const reach = pad + solidFootRadius(o, cand[ci]!);
    if (dx * dx + dz * dz > reach * reach) continue;
    // One sweep, two readings: the wide `pad` measures how near the geometry is
    // (for the gait governor), the narrow `off` is the band that actually steers.
    const wide = circleHitsOBB(p.x, p.z, pad, o);
    if (!wide.hit || wide.pen <= 0) continue;
    BOT_NEAREST = Math.min(BOT_NEAREST, Math.max(0, pad - wide.pen - RADIUS));
    if (wide.pen <= pad - RADIUS - off) continue;
    const pen = wide.pen - (pad - RADIUS - off);
    const w = Math.min(1, pen / Math.max(0.05, off));
    BOT_PUSH.x += wide.nx * w;
    BOT_PUSH.z += wide.nz * w;
    BOT_NEAR.push({ nx: wide.nx, nz: wide.nz, w });
  }
}

/**
 * Apply the standoff to a wish direction: push out of the band, then PROJECT
 * OUT whatever is still pointing into a face. A soft push alone loses to a goal
 * that lies through the wall (the sum only nets ~0.2 outward), and the body ends
 * up flat against the steel again with its arms through it. Projection means a
 * bot inside the band can slide along a container but never walk at one.
 */
function botStandoff(p: SimPlayer, out: { x: number; z: number }): void {
  out.x += BOT_PUSH.x * 1.2;
  out.z += BOT_PUSH.z * 1.2;
  for (const n of BOT_NEAR) {
    const vn = out.x * n.nx + out.z * n.nz;
    if (vn < 0) {
      out.x -= n.nx * vn * n.w;
      out.z -= n.nz * vn * n.w;
    }
    // ...and BRAKE. Steering alone is not enough: a body at 5.9 m/s coasts ~0.5 m
    // after its input flips (FRICTION is 13/s), which lands it flush against the
    // face the standoff was meant to hold it off. Counter-steering against the
    // closing speed is what makes the standoff a distance rather than a wish.
    const closing = p.vx * n.nx + p.vz * n.nz;
    if (closing < 0) {
      out.x -= n.nx * closing * n.w * 0.35;
      out.z -= n.nz * closing * n.w * 0.35;
    }
  }
}

/** Scratch wish vector for botSteer. */
const BOT_WISH = { x: 0, z: 0 };
/** Scratch: the full-band push, kept while the band ladder narrows below it. */
const BOT_MID = { x: 0, z: 0 };

/**
 * Per-bot brain state. Kept in a WeakMap keyed by the player object rather than
 * on SimPlayer: none of it is replicated, and a bot that leaves the roster takes
 * its mind with it.
 */
type BotMind = {
  t: number;
  skill: number;
  react: number;
  track: number;
  lead: number;
  phase: number;
  goalX: number;
  goalZ: number;
  /** Storey of the goal (NAV_Y maps only; NaN = unknown). */
  goalY: number;
  /** NAV_Y: steering straight down a clear routed leg (doorway / stairs) — the standoff ladder starts narrow. */
  funnel: boolean;
  goalT: number;
  dirX: number;
  dirZ: number;
  steerCd: number;
  side: number;
  anchorX: number;
  anchorZ: number;
  anchorT: number;
  loiterX: number;
  loiterZ: number;
  loiterT: number;
  reposition: number;
  /** Seconds left of a planted stance (feet still). */
  plant: number;
  escape: number;
  escX: number;
  escZ: number;
  /** Consecutive failed stuck windows. 1 = nudge, 2+ = committed escape. */
  stuckRun: number;
  /** While > 0 the escape drives at (escGX,escGZ) and the standoff is relaxed. */
  escGX: number;
  escGZ: number;
  /** LAST TICK'S STEERING, for `botProbe` — what the brain actually asked the
   *  body for. Written by botMove, read by instruments only; nothing in the sim
   *  branches on these. `wish` is the length of the standoff-filtered wish
   *  vector, `band` the rung of the ladder it survived at, `ax`/`az` the stick. */
  wish: number;
  band: number;
  lastAx: number;
  lastAz: number;
  /** Seconds since this body last got `progressM` from where it was standing —
   *  the no-progress clock BOT_HEALTH's invariant is built on — and the time on
   *  the mind's own clock when that last happened. */
  stall: number;
  progT: number;
  /** The freeze ring (BOT_HEALTH.frozen): 6 s of 2 Hz positions, the sample
   *  clock, how many have been taken, and whether an episode is open. */
  histX: Float32Array;
  histZ: Float32Array;
  histN: number;
  histT: number;
  froze: boolean;
  frozeT: number;
  /** Seconds before this bot is allowed to swap which way it works an angle. */
  flankT: number;
  /** The fight destination the feet are committed to, seconds left on it, and
   *  whether it was chosen as a break-contact (so a bot that gets hurt or
   *  patched re-decides instead of finishing someone else's plan). */
  moveX: number;
  moveZ: number;
  moveT: number;
  moveHurt: boolean;
  /** Route-graph anchor this body last resolved (index into BOT_NAV), -1 for
   *  none, and the hop it is committed to walking with its expiry. */
  node: number;
  hopN: number;
  hopUntil: number;
  hopLane: number;
  /** Was the last steer aimed at a route hop rather than at the goal itself? */
  routed: boolean;
  /** First-LOS -> first-shot stopwatch, for the fairness telemetry below. */
  losT: number;
  losOpen: boolean;
  burst: number;
  /** Rounds this burst has ACTUALLY put down the range — the telemetry number,
   *  counted from the sim's own ammo, never inferred from the plan. */
  burstN: number;
  gap: number;
  heat: number;
  /** Which way this burst's muzzle walks, +-1. */
  recoil: number;
  settle: number;
  errU: number;
  errV: number;
  seenX: number;
  seenZ: number;
  /** Storey of the last sighting (NAV_Y maps). */
  seenY: number;
  seenT: number;
  flank: number;
  /** Seconds this bot has held a full sight picture (sniper trigger gate). */
  scopeT: number;
  /** Last command's trigger, so a semi/bolt bot releases between pulls. */
  lastFire: boolean;
  /** Frag: seconds until the next throw may even be considered. */
  fragT: number;
  /** Frag being cooked: target cook seconds (0 = none) and the planned aim. */
  fragCook: number;
  fragYaw: number;
  fragPitch: number;
  /** Seconds since this bot last had anyone in sight (pistol -> primary). */
  calmT: number;
};

const BOT_MINDS = new WeakMap<SimPlayer, BotMind>();

function botMind(s: GameSession, p: SimPlayer): BotMind {
  const found = BOT_MINDS.get(p);
  if (found) return found;
  // Deterministic per-id competence so the roster has a spread: some bots you
  // beat, some you remember. 0 = rookie, 1 = the one that flanks you.
  let h = 2166136261;
  for (let i = 0; i < p.id.length; i++) h = Math.imul(h ^ p.id.charCodeAt(i), 16777619) >>> 0;
  const skill = ((h >>> 8) % 1000) / 999;
  const m: BotMind = {
    t: 0,
    skill,
    react: lerp(BOT_TUNING.reactSlow, BOT_TUNING.reactFast, skill),
    track: lerp(BOT_TUNING.trackSlow, BOT_TUNING.trackFast, skill),
    lead: lerp(BOT_TUNING.leadMin, BOT_TUNING.leadMax, skill),
    phase: p.botWp * 1.37,
    goalX: p.x,
    goalZ: p.z,
    goalY: p.y,
    funnel: false,
    goalT: 99,
    dirX: Math.sin(p.yaw),
    dirZ: Math.cos(p.yaw),
    steerCd: 0,
    side: skill > 0.5 ? 1 : -1,
    anchorX: p.x,
    anchorZ: p.z,
    anchorT: 0,
    loiterX: p.x,
    loiterZ: p.z,
    loiterT: 0,
    reposition: 0,
    plant: 0,
    escape: 0,
    escX: 0,
    escZ: 0,
    stuckRun: 0,
    escGX: 0,
    escGZ: 0,
    wish: 0,
    band: 0,
    lastAx: 0,
    lastAz: 0,
    stall: 0,
    progT: 0,
    histX: new Float32Array(BOT_FREEZE_N),
    histZ: new Float32Array(BOT_FREEZE_N),
    histN: 0,
    histT: 0,
    froze: false,
    frozeT: 0,
    flankT: 2.5 + s.nextRand() * 2.5,
    moveX: p.x,
    moveZ: p.z,
    moveT: 0,
    moveHurt: false,
    node: -1,
    hopN: -1,
    hopUntil: 0,
    hopLane: 0,
    routed: false,
    losT: 0,
    losOpen: false,
    burst: BOT_TUNING.burstMax,
    burstN: 0,
    gap: 0,
    heat: 0,
    recoil: 1,
    settle: 1,
    errU: 0,
    errV: 0,
    seenX: p.x,
    seenZ: p.z,
    seenY: p.y,
    seenT: -99,
    flank: s.nextRand() < 0.5 ? -1 : 1,
    scopeT: 0,
    lastFire: false,
    fragT: 22 + s.nextRand() * 30,
    fragCook: 0,
    fragYaw: 0,
    fragPitch: 0,
    calmT: 0,
  };
  BOT_MINDS.set(p, m);
  return m;
}

function botBurstLen(s: GameSession, m: BotMind, w?: WeaponDef): number {
  // THE BURST IS SIZED TO THE GUN so the structural TTK floor holds for every
  // one of them: never a lethal burst from full health. AR 3 x 28 = 84, SMG
  // 3 x 25 = 75, pistol 2 x 34 = 68, and a sniper is one pull per decision.
  const max = !w ? BOT_TUNING.burstMax : w.fire === "bolt" ? 1 : w.fire === "semi" ? 2 : BOT_TUNING.burstMax;
  const min = Math.min(max, w && w.fire !== "auto" ? 1 : BOT_TUNING.burstMin);
  const span = max - min;
  return min + Math.round(s.nextRand() * span * (0.55 + 0.45 * m.skill));
}

/**
 * THE BOT ROSTER'S ARSENAL: a CoD lobby's mix, mostly rifles and SMGs with a
 * sniper or two. Deterministic by seat number so a 6v6 always looks the same
 * shape: AR, SMG, AR, SMG, SNIPER, repeat (40 / 40 / 20).
 */
export function botPrimary(id: string): string {
  const m = /(\d+)$/.exec(id);
  let n = m ? Number(m[1]) : 0;
  if (!m) for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return (["ar", "smg", "ar", "smg", "sniper"] as const)[n % 5]!;
}

/** Range at which each class brings the sights up, metres. */
const BOT_ADS_AT: Record<string, number> = { ar: 6.5, smg: 9, pistol: 8, sniper: 3 };

/**
 * PLAN A FRAG: the pitch that lands a throw from the eye at (tx, ty, tz), off
 * the same launch the sim uses (NADE_SPEED along the aim plus NADE_UP). Flat
 * ballistics, no bounce — a bot's frag is a good guess, not a solved shot, and
 * the roll after landing is what a cooked fuse is for. Null when nothing in the
 * search lands within half a metre of the target height.
 */
function botFragPlan(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): { yaw: number; pitch: number; flight: number } | null {
  const D = Math.hypot(tx - ox, tz - oz);
  const H = ty - oy;
  if (D < 3) return null;
  let best: { yaw: number; pitch: number; flight: number } | null = null;
  let bestErr = 0.5;
  for (let i = 0; i <= 40; i++) {
    const th = -0.25 + (i / 40) * 1.15;
    const vh = NADE_SPEED * Math.cos(th);
    const vy = NADE_SPEED * Math.sin(th) + NADE_UP;
    if (vh < 1) continue;
    const t = D / vh;
    const err = Math.abs(vy * t - 0.5 * NADE_GRAVITY * t * t - H);
    if (err < bestErr) {
      bestErr = err;
      best = { yaw: Math.atan2(tx - ox, tz - oz), pitch: -th, flight: t };
    }
  }
  return best;
}

/**
 * BOT FRAGS — rare, cooked, and aimed at something worth a grenade: a man who
 * just ducked behind cover (thrown at where he was last seen) or a cluster of
 * two or more. One per life like everyone, a long personal cooldown, and a
 * per-tick chance so the roster never synchronises into a barrage. Writes the
 * frag part of the command; returns true while the bot's hands are busy.
 */
function botFrag(s: GameSession, p: SimPlayer, m: BotMind, target: SimPlayer | null, cmd: InputCmd, dt: number, eye: number): boolean {
  m.fragT -= dt;
  // A plan whose pin is no longer out (the bot died, the round reset) is void.
  if (m.fragCook > 0 && p.cook <= 0) m.fragCook = 0;
  if (m.fragCook > 0) {
    // Cooking: keep the hold, keep the aim, and let go when the fuse is right
    // — or at once if an enemy walks into arm's reach (no martyr dives).
    const close = target ? Math.hypot(target.x - p.x, target.z - p.z) < 4 : false;
    cmd.yaw = m.fragYaw;
    cmd.pitch = m.fragPitch;
    p.botAimY = m.fragYaw;
    p.botAimP = m.fragPitch;
    if (p.cook >= m.fragCook || close || p.cook >= NADE_FUSE - 0.6) {
      cmd.nade = true;
      cmd.nadeHold = false;
      m.fragCook = 0;
      m.fragT = 35 + s.nextRand() * 30;
    } else {
      cmd.nadeHold = true;
    }
    cmd.fire = false;
    cmd.melee = false;
    return true;
  }
  if (m.fragT > 0 || p.nades <= 0 || p.nadeCd > 0 || p.reload > 0 || p.swap > 0) return false;
  let tx = 0;
  let tz = 0;
  let ok = false;
  if (!target && p.botTarget) {
    // He was RIGHT THERE a moment ago and stepped behind steel: flush him out.
    const ago = m.t - m.seenT;
    if (ago > 0.4 && ago < 2.6) {
      tx = m.seenX;
      tz = m.seenZ;
      ok = true;
    }
  } else if (target) {
    let near = 0;
    for (const o of s.players.values()) {
      if (!o.alive || o.id === p.id) continue;
      if (s.mode !== "ffa" && o.team === p.team) continue;
      if (Math.hypot(o.x - target.x, o.z - target.z) < 3) near++;
    }
    if (near >= 2) {
      tx = target.x;
      tz = target.z;
      ok = true;
    }
  }
  if (!ok) return false;
  const D = Math.hypot(tx - p.x, tz - p.z);
  if (D < 6 || D > 24) return false;
  // A decision, not a reflex: ~3 s of continuous eligibility on average, so
  // most fleeting chances pass unthrown.
  if (s.nextRand() > dt * 0.33) return false;
  const ty = groundHeight(tx, tz, SOLIDS, walkFromY(p.y)) + 0.2;
  const plan = botFragPlan(p.x, eye, p.z, tx, ty, tz);
  if (!plan) {
    m.fragT = 3;
    return false;
  }
  // The first two metres of the throw have to be open air, or the frag
  // bounces off the bot's own cover and lands at its feet.
  const d0 = aimDir(plan.yaw, plan.pitch);
  if (traceWorld(p.x, eye, p.z, d0.dx, d0.dy, d0.dz, 2.2).t < 2.2) {
    m.fragT = 2.5;
    return false;
  }
  m.fragYaw = plan.yaw;
  m.fragPitch = plan.pitch;
  // Cook so it goes off ~half a second after it lands.
  m.fragCook = clamp(NADE_FUSE - plan.flight - 0.55, 0.3, 1.9);
  cmd.yaw = plan.yaw;
  cmd.pitch = plan.pitch;
  cmd.nadeHold = true;
  cmd.fire = false;
  return true;
}

/**
 * When each nav point was last stood on, by anyone, per session — the roster's
 * shared idea of where it has already been.
 *
 * COVERAGE IS A PATROL PROBLEM, NOT A SPEED PROBLEM. Bots keeping their distance
 * from steel and shouldering the weapon near it cost pace, and the first attempt
 * to buy the pace back (drop the ADS) bought 2.7 points of coverage and three
 * clips. Where the coverage actually went is that a scorer with no memory sends
 * ten bots at the same handful of interesting mid-range lanes over and over, and
 * a bot that walks the same two lanes for a hundred seconds visits few cells
 * however fast it walks. Staleness makes the roster sweep instead of circle, and
 * it is also just what a squad holding a yard does.
 */
const BOT_STALE = new WeakMap<GameSession, Float64Array>();

function botStale(s: GameSession): Float64Array {
  let a = BOT_STALE.get(s);
  if (!a) BOT_STALE.set(s, (a = new Float64Array(BOT_NAV.length)));
  return a;
}

/** Pick a fresh patrol goal from the validated set. */
function botRepath(s: GameSession, p: SimPlayer, m: BotMind, far = false): void {
  let bx = m.goalX;
  let bz = m.goalZ;
  let bs = -1e9;
  const n = BOT_NAV.length;
  const seen = botStale(s);
  // WHICH COMPONENT THIS BODY IS STANDING IN, or -1 to disable the test.
  //
  // -1 whenever the graph is a single component, which is every map that meets
  // CONSTRAINTS.md — so on Shipment this is a compile-time-constant `-1`, the
  // scan below never runs, and neither the cost nor the goal choice moves. The
  // nearest node is taken by DISTANCE ALONE, deliberately not `botAnchorNode`:
  // that function mutates `m.node` as a side effect, and calling it from here
  // would re-anchor the router at a moment it never used to.
  let anchorComp = -1;
  if (BOT_COMP_N > 1) {
    let nd = Infinity;
    for (let i = 0; i < n; i++) {
      const q = BOT_NAV[i]!;
      const dd = (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z);
      if (dd < nd) {
        nd = dd;
        anchorComp = BOT_COMP[i]!;
      }
    }
  }
  const start = (s.nextRand() * n) | 0;
  for (let i = 0; i < n; i++) {
    const j = (start + i) % n;
    const q = BOT_NAV[j]!;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < (far ? BOT_RANGE.repathMinFar : BOT_RANGE.repathMin)) continue;
    // The sweet spot and the floor are both in THIS map's metres (BOT_RANGE):
    // on a 123 m map a goal 11 m away is the far end of the room you are
    // standing in, and a patrol built out of those never leaves it.
    let sc = 6 - Math.abs(d - BOT_RANGE.repathSweet) * (0.3 / BOT_RANGE.scale) + s.nextRand() * 3.5;
    // A GOAL IN ANOTHER COMPONENT OF THE NAV GRAPH IS NOT A GOAL.
    //
    // `botRouteHop` answers -1 for it, the local greedy fan takes over, and the
    // fan's information horizon is a 2.4 m probe — so the bot grinds at the
    // nearest wall on the bearing until the progress watchdog fires, picks
    // another unreachable goal, and does it again. Measured on dust2's current
    // (fragmented, 8-component) nav graph, that is most of what the watchdog was
    // counting.
    //
    // Placed AFTER `sc` so the `nextRand()` above has already been drawn: the
    // RNG stream is part of the sim's identity, and skipping a candidate must
    // not skip a random number. Shipment's graph is a single component, so this
    // never fires there and its goal choice is untouched.
    if (anchorComp >= 0 && BOT_COMP[j]! !== anchorComp) continue;
    // Somewhere nobody has been for a while is worth walking to. Capped, so a
    // corner of the map nobody can reach does not become an obsession.
    //
    // THE CAP AND THE RATE BOTH WENT UP WITH ROUTING, and for a reason worth
    // recording: a greedy navigator explores BY FAILING — it fans off blocked
    // bearings, backtracks out of pockets, and the wandering that produced
    // covered ground. Routed bots go where they meant to, which is faster, and
    // measured 5.4 points of coverage WORSE at identical seeds and more metres
    // walked. The wandering has to be replaced by intent, so a stale corner now
    // outweighs a comfortable mid-range lane instead of merely competing with
    // it (12 vs the scorer's ~9.5 of range/roll terms).
    sc += Math.min(12, (s.time - seen[j]!) * 0.55);
    // NAV_Y: the upper floors are half the map's lanes (windows, porch roofs) but a
    // sliver of its nodes — weight them so patrols actually climb the stairs
    if (NAV_Y && q.y > 2.5) sc += 3;
    const penalty = Math.hypot(q.x - m.goalX, q.z - m.goalZ) < 1.2 ? 9 : 0;
    // A clear first leg can add at most four points. Skip pure geometry work
    // for a candidate that cannot win; its RNG draw and scoring order stay
    // unchanged, including strict ties and the failed-goal penalty.
    if (sc + 4 - penalty <= bs) continue;
    // A goal you can start walking at is worth more than one behind a container.
    if (botPathClear(p.x, p.z, p.x + ((q.x - p.x) / d) * 3, p.z + ((q.z - p.z) / d) * 3, BOT_CLEAR_R, false, walkFromY(p.y))) sc += 4;
    // Never re-pick the goal that just failed to work out.
    if (penalty) sc -= penalty;
    if (sc > bs) {
      bs = sc;
      bx = q.x;
      bz = q.z;
      if (NAV_Y) m.goalY = q.y;
    }
  }
  // PATROL A PLACE, NOT A SURVEY MARKER. The nav points are 34 fixed dots and
  // the route graph walks between them in straight lines, so a roster that aims
  // at the dots exactly re-treads 69 lines: measured, coverage fell 63.0% ->
  // 57.6% of passable cells when routing went in, on identical seeds, with
  // travel per bot UP. A metre or two of scatter on the destination costs the
  // route nothing (the graph still resolves the same node) and puts the
  // approach somewhere new every time.
  for (let i = 0; i < 3; i++) {
    const a = s.nextRand() * Math.PI * 2;
    const r = 0.7 + s.nextRand() * 1.5;
    const jx = bx + Math.cos(a) * r;
    const jz = bz + Math.sin(a) * r;
    if (NAV_Y ? botBlocked(jx, jz, BOT_CLEAR_R, false, m.goalY + 0.05) || Math.abs(botGroundY(jx, jz, m.goalY + 0.05) - m.goalY) > 0.3 : botBlocked(jx, jz, BOT_CLEAR_R)) continue;
    bx = jx;
    bz = jz;
    break;
  }
  m.goalX = bx;
  m.goalZ = bz;
  m.goalT = 0;
  m.side = s.nextRand() < 0.5 ? -1 : 1;
  m.steerCd = 0;
}

/**
 * Pick the farthest nav point this bot can start walking at, and commit to it.
 * Used by the escalated escape, where "somewhere else, definitely" beats the
 * patrol scorer's taste for interesting mid-range lanes.
 */
function botFarPoint(s: GameSession, p: SimPlayer, m: BotMind): void {
  let bx = p.x;
  let bz = p.z;
  let bs = -1e9;
  const n = BOT_NAV.length;
  const start = (s.nextRand() * n) | 0;
  for (let i = 0; i < n; i++) {
    const q = BOT_NAV[(start + i) % n]!;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < 6) continue;
    let sc = d;
    // Prefer one whose first few metres are already walkable — an escape that
    // starts by facing the same wall is not an escape.
    if (botPathClear(p.x, p.z, p.x + ((q.x - p.x) / d) * 3.5, p.z + ((q.z - p.z) / d) * 3.5, BOT_CLEAR_R, false, walkFromY(p.y))) sc += 12;
    if (sc > bs) {
      bs = sc;
      bx = q.x;
      bz = q.z;
      if (NAV_Y) m.goalY = q.y;
    }
  }
  m.escGX = bx;
  m.escGZ = bz;
  m.goalX = bx;
  m.goalZ = bz;
  m.goalT = 0;
  m.steerCd = 0;
}

/**
 * The unstick response, in two tiers. No teleports at either.
 *
 * TIER 1 (`hard` false) is the original nudge: back off whatever the bot is
 * leaning on, flip the side it fans to, take a new far-ish goal.
 *
 * TIER 2 is what the review's bot-8 needed. A nudge that shoves a bot out and
 * lets it walk straight back keeps NET displacement under 0.6 m across
 * botwatch's rolling 6 s window, so two nudges still read as one STUCK. So the
 * second consecutive failed window stops nudging: it picks the farthest
 * reachable nav point, drives at THAT for `escapeSecs` regardless of what the
 * fight wants, and relaxes the standoff to `escapeStandoff` for the duration —
 * because the trap is usually a place where two opposing faces cancel every
 * lateral wish, and a relaxed band is the one thing that cannot be cancelled.
 * The real collision sweep still owns the body; only the preference relaxes.
 */
function botUnstick(s: GameSession, p: SimPlayer, m: BotMind, hard: boolean): void {
  botWallPush(p);
  let ex = BOT_PUSH.x;
  let ez = BOT_PUSH.z;
  if (Math.hypot(ex, ez) < 0.05) {
    const a = s.nextRand() * Math.PI * 2;
    ex = Math.cos(a);
    ez = Math.sin(a);
  }
  const l = Math.hypot(ex, ez) || 1;
  m.escX = ex / l;
  m.escZ = ez / l;
  m.side = -m.side;
  if (!hard) {
    m.escape = 0.5 + s.nextRand() * 0.35;
    botRepath(s, p, m, true);
    return;
  }
  m.escape = BOT_TUNING.escapeSecs;
  botFarPoint(s, p, m);
}

/**
 * Choose the world direction to walk: the straight line first; if steel stands
 * in it, fan out to either side (preferred side first, up to 134 deg) until
 * something is clear; if nothing is, turn around. Runs at ~8 Hz — a walking
 * body does not need a new opinion every tick, and the probes are the only
 * expensive thing in here. The standoff is applied later, in botMove.
 *
 * TWO WIDTHS, and that is the whole difference between this and the version
 * botwatch caught. Planning at `BOT_PLAN_R` (0.75 m) keeps routes roomy, but a
 * walkthrough is 1.07 m of half-width, so a 0.75 m route only exists within
 * 0.32 m of the corridor's midline. A bot that drifted further out than that had
 * NO clear direction at any angle, fell through to "turn around", and thrashed
 * against the wall it was next to — deterministically, at the same place, in
 * both verification runs: bot-0 at (-12.64,-0.34), 0.35 m off col-19's inner
 * face, forearm 0.088 m inside it, t=24.8 s, twice.
 *
 * So when the roomy width finds nothing, the fan runs again at body width. A
 * tight route the bot can actually walk beats a wide one that does not exist,
 * and reversing is left where it belongs: for when there is genuinely nowhere.
 *
 * LOW PROPS ARE NOT DOORWAYS — the third pass, and the last of the user's
 * "monkeys walking halfway through mesh colliders".
 *
 * `resolveCircle` lets a standing body pass straight THROUGH a climbable prop
 * whose top is inside mantle height, and `groundHeight` only lifts that body
 * once its CENTRE is over the footprint (+0.12 m). Between those two rules is a
 * band ~RADIUS wide where a bot stands at ground level with a dumpster passing
 * through its shins, and botMove's band ladder walks all the way down to a rung
 * that drops low props from the standoff sweep entirely (`crossLow`) — which is
 * what un-plugs the green walkthrough, and also what let a bot aim at the middle
 * of a dumpster in the open yard. MEASURED, on the committed tree, headless
 * (qa/lowprop-probe.ts, 6592 bot-seconds): 107 episodes, 11.3 s of capsule
 * INSIDE a prop it was walking through, EVERY ONE of them at ladder rung 4, and
 * the two live CLIP episodes botwatch caught in the same state were a foot and a
 * toe 0.27-0.32 m inside a dumpster.
 *
 * The ladder cannot be the place to fix it: its bottom rung exists because the
 * crate parked in the mouth of the green walkthrough (col-41, 0.7 m in a 2.14 m
 * corridor) leaves 0.72 m of gap beside it and a body needs 0.88 m, so THAT prop
 * genuinely has to be crossed or the corridor is sealed and the bot freezes in
 * it. The distinction is not the prop, it is whether there is a way around — so
 * it is made HERE, where the fan already asks that exact question twice. The two
 * preferred passes treat every mantle prop as steel; only the last, tightest
 * pass walks over one. In the open yard the first pass fans around the dumpster;
 * in the walkthrough the first two find nothing and the third steps over the
 * crate, exactly as before.
 */
function botSteer(s: GameSession, p: SimPlayer, m: BotMind, gx: number, gz: number, dt: number, gy = NaN): void {
  m.steerCd -= dt;
  if (m.steerCd > 0) return;
  m.steerCd = 0.1 + s.nextRand() * 0.05;
  // ROUTE BEFORE BEARING. A goal you cannot walk at in a straight line is a goal
  // the fan will chase into whatever is in the way, and in a dead-end shell that
  // is a wall it never gets past (see BOT_HOP). So when the line is blocked, the
  // thing steered at is the next NODE on the route, not the goal itself — which
  // in a walkthrough is its open end, i.e. the opposite direction. The fan below
  // still owns the last few metres and every obstacle inside them.
  let aimX = gx;
  let aimZ = gz;
  m.routed = false;
  // A goal on another storey (NAV_Y: another LEVEL, > 0.5 m — the porch roof is
  // 0.84 m above the bedroom it is reached from) is never "a straight walk away".
  const storey = NAV_Y && Number.isFinite(gy) && Math.abs(gy - p.y) > 0.5;
  // map stream: NAV_Y only, the same test the condition below always ran, kept for the doorway funnel
  const directClear = NAV_Y && !storey && botPathClear(p.x, p.z, gx, gz, BOT_CLEAR_R, false, walkFromY(p.y));
  // NAV_Y: no 4 m grace — a goal 3 m away through a wall (the porch roof seen
  // from the bedroom behind it) is reached by the window, not by the fan.
  if (storey || ((NAV_Y || Math.hypot(gx - p.x, gz - p.z) > 4) && !(NAV_Y ? directClear : botPathClear(p.x, p.z, gx, gz, BOT_CLEAR_R, false, walkFromY(p.y))))) {
    // A HOP IS A DECISION AND IT IS KEPT. The anchor node is whichever one the
    // body is nearest, so two nodes with a shared border hand back different
    // first hops as a bot drifts across it — and a bot that re-plans twice a
    // second on a border walks a figure of eight on it (measured: bot-0 at
    // (7.9,2.22), 0.15 m of displacement over 3 s at 2.3 m/s). So the hop is
    // held until it is reached, goes stale, or stops being walkable.
    let h = m.hopN;
    if (h >= 0 && m.t < m.hopUntil) {
      const c = BOT_NAV[h];
      if (!c || (Math.hypot(c.x - p.x, c.z - p.z) < (NAV_Y ? NAV_Y_ARRIVE : 1.4) && (!NAV_Y || Math.abs(c.y - p.y) < 1.2)) || !botPathClear(p.x, p.z, c.x, c.z, BOT_CLEAR_R, false, walkFromY(p.y))) h = -1;
    } else h = -1;
    if (h < 0) {
      h = botRouteHop(p, m, gx, gz, gy);
      m.hopN = h;
      m.hopUntil = m.t + 2.5;
      m.hopLane = (s.nextRand() - 0.5) * 2.4;
      // Doorways: a NAV_Y map's hops are placed ON the doorway axis (both sides
      // of every door), and a metre of lane offset aims the walk at the jamb.
      if (NAV_Y) m.hopLane = 0;
    }
    const q = h >= 0 ? BOT_NAV[h] : null;
    if (q && (Math.hypot(q.x - p.x, q.z - p.z) > (NAV_Y ? 0.3 : 0.8) || (NAV_Y && Math.abs(q.y - p.y) > 1.2))) {
      // Walk PAST the node, not over it: a metre of lateral offset, rolled once
      // per hop, so ten bots crossing the same junction take ten lines through
      // it instead of one. The route is unaffected — the offset is smaller than
      // the 1.4 m arrival radius, so the hop still counts as reached.
      const ox = q.x - p.x;
      const oz = q.z - p.z;
      const ol = Math.hypot(ox, oz) || 1;
      aimX = q.x + (oz / ol) * m.hopLane;
      aimZ = q.z - (ox / ol) * m.hopLane;
      m.routed = true;
    }
  }
  let dx = aimX - p.x;
  let dz = aimZ - p.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return;
  dx /= l;
  dz /= l;
  // NAV_Y: a routed hop is a doorway/stair axis point — probe TO it, not 1.2 m
  // past it into the jamb, or the fan turns away a step short of every door.
  const probe = Math.min(2.4, Math.max(NAV_Y && m.routed ? 0.35 : 1.2, l));
  let ox = -dx;
  let oz = -dz;
  let found = false;
  if (NAV_Y) {
    m.funnel = false;
    // A routed leg on a NAV_Y map is a doorway/stair axis the graph already
    // walked at body width: take it straight when it is clear at body width,
    // before the wide-clearance fan turns away from the jambs.
    if (m.routed && botPathClear(p.x, p.z, p.x + dx * probe, p.z + dz * probe, BOT_CLEAR_R, false, walkFromY(p.y))) {
      ox = dx;
      oz = dz;
      found = true;
      m.funnel = true;
    } else if (
      // map stream: a goal in plain sight through a 1.10 m doorway — clear at
      // body width, not at plan width — is the same funnel; the plan-width fan
      // would turn the bot away from the jambs it has to pass between
      directClear &&
      botPathClear(p.x, p.z, p.x + dx * probe, p.z + dz * probe, BOT_CLEAR_R, false, walkFromY(p.y)) &&
      !botPathClear(p.x, p.z, p.x + dx * probe, p.z + dz * probe, BOT_PLAN_R, true, walkFromY(p.y))
    ) {
      ox = dx;
      oz = dz;
      found = true;
      m.funnel = true;
    }
  }
  for (let pass = 0; pass < 3 && !found; pass++) {
    const r = pass === 0 ? BOT_PLAN_R : BOT_CLEAR_R;
    // LOW PROPS ARE NOT DOORWAYS. The first two passes treat a mantle-height
    // crate, barrel, tyre stack or dumpster as SOLID; only the last one walks
    // through it. See the note above botSteer.
    const lowSolid = pass < 2;
    if (botPathClear(p.x, p.z, p.x + dx * probe, p.z + dz * probe, r, lowSolid, walkFromY(p.y))) {
      ox = dx;
      oz = dz;
      found = true;
      // NAV_Y: the route already proved this leg (doorway axis, stair line);
      // the wall standoff must not shove the body off it at the jamb.
      if (NAV_Y) m.funnel = m.routed;
      break;
    }
    for (let step = 1; step <= 7 && !found; step++) {
      const a = step * 0.34;
      for (let k = 0; k < 2 && !found; k++) {
        const sgn = k === 0 ? m.side : -m.side;
        const c = Math.cos(a * sgn);
        const sn = Math.sin(a * sgn);
        const tx = dx * c - dz * sn;
        const tz = dx * sn + dz * c;
        if (!botPathClear(p.x, p.z, p.x + tx * probe, p.z + tz * probe, r, lowSolid, walkFromY(p.y))) continue;
        ox = tx;
        oz = tz;
        found = true;
      }
    }
  }
  m.dirX = ox;
  m.dirZ = oz;
}

/**
 * RAIL-VAULT JUMP (Nuketown only). Live steering holds every vault panel
 * as hard steel (botBlocked default + botWallPush on every rung), and the
 * router never emits a vault edge — so a bot whose wish runs into rail steel
 * at deck height would lean on it until the watchdog fires. When the navigator
 * actually wants to go through the rail (a chase/pressure/fight leg the graph
 * has no edge for), the honest move is the same one a player makes: jump.
 * Sets cmd.jump for the tick; the airborne mantle in resolveCircle +
 * groundHeight does the rest through the same shared movement both sides run.
 *
 * Gated to: Nuketown (NAV_Y && RAIL_VAULT_N > 0 — dead branch elsewhere),
 * grounded, deck-height, unprotected, with a real wish whose 0.9 m probe
 * crosses a vault footprint at body width (the same segHitsRailVault test
 * the router uses). Crouch/slide never vault (both stay grounded), lawn legs
 * pass under the height gate, and a body balanced ON a rail top probes along
 * it (the height gate skips its own panel), so there is no hop loop.
 */
function botRailVaultJump(p: SimPlayer, cmd: InputCmd, wx: number, wz: number): void {
  if (!NAV_Y || RAIL_VAULT_N === 0) return;
  if (!p.onGround || p.slide > 0 || p.crouch || p.protect > 0) return;
  if (p.y < DECK_RAIL_ALLOW_Y) return;
  const wl = Math.hypot(wx, wz);
  if (wl < 1e-4) return;
  const nx = wx / wl;
  const nz = wz / wl;
  if (segHitsRailVault(p.x, p.z, p.x + nx * 0.9, p.z + nz * 0.9, p.y, p.y, BOT_CLEAR_R)) cmd.jump = true;
}

/**
 * ONE place where a bot's wish direction becomes stick input, so the three
 * forces compose in the right order every time: where it wants to go, the
 * shove off nearby bodies, and the wall standoff LAST. Order matters — with
 * separation applied after the standoff (as it was), a crowd could push a bot
 * flat into a container and put its arms through the wall.
 */
function botMove(s: GameSession, p: SimPlayer, m: BotMind, cmd: InputCmd, wx: number, wz: number, face = false): void {
  const hard = m.escape > 0 && m.stuckRun >= 2;
  const l = Math.hypot(wx, wz) || 1;
  BOT_WISH.x = wx / l;
  BOT_WISH.z = wz / l;
  if (hard) {
    // A COMMITTED escape ignores the caller's wish entirely: half "off the face
    // I was leaning on", half "at the far point I picked". Blending the fight's
    // wish back in is exactly how the review's bot-8 oscillated.
    const gx = m.escGX - p.x;
    const gz = m.escGZ - p.z;
    const gl = Math.hypot(gx, gz) || 1;
    BOT_WISH.x = m.escX * 0.45 + (gx / gl) * 0.55;
    BOT_WISH.z = m.escZ * 0.45 + (gz / gl) * 0.55;
  } else if (m.escape > 0) {
    BOT_WISH.x = BOT_WISH.x * 0.3 + m.escX * 0.7;
    BOT_WISH.z = BOT_WISH.z * 0.3 + m.escZ * 0.7;
  }
  // Keep bots from stacking: steer sideways/back off nearby teammates.
  for (const o of s.players.values()) {
    if (o.id === p.id || !o.alive) continue;
    const dx = p.x - o.x;
    const dz = p.z - o.z;
    const d = Math.hypot(dx, dz);
    if (d >= 1.6 || d <= 0.001) continue;
    const w = ((1.6 - d) / 1.6) * 1.1;
    BOT_WISH.x += (dx / d) * w;
    BOT_WISH.z += (dz / d) * w;
  }
  const wantX = BOT_WISH.x;
  const wantZ = BOT_WISH.z;
  const wantL = Math.hypot(wantX, wantZ) || 1;
  // THE STANDOFF IS A PREFERENCE; THE COLLISION SWEEP IS THE TRUTH — so ask for
  // as much personal space as the geometry can actually give, and no more.
  //
  // A fixed band has no good value. Wide enough to keep the rig's arms out of a
  // container (1.02 m) is wider than the inside of a walkthrough (1.07 m of
  // half-width, and there is a crate parked in the green one at (2.5,2.15)), and
  // a bot that insists on it in there has every lateral wish cancelled and
  // shuffles until the watchdog fires — botwatch caught exactly that, bot-8
  // stationary 8.5 s inside walkthrough-green-1. The earlier fixes for it were
  // both worse: backing out of the squeeze fights the goal, and releasing to the
  // raw wish points a bot at the steel it had been refusing (bot-3, 0.38 m off
  // col-3's north face, hand 0.24 m inside it).
  //
  // So: try the full band; if what survives is too weak to walk on, try a
  // narrower one, and again, and again. The first band that leaves a real
  // direction wins. In the open that is the first try and this costs one sweep;
  // in a corridor it settles on whatever fits, which is the corridor.
  //
  // WHAT "A REAL DIRECTION" MEANS — and the whole of the second freeze the probe
  // caught. The rung used to be accepted on the LENGTH of the surviving wish
  // alone, and length is not progress: two faces that cancel a wish leave a
  // sideways smear that is plenty long and goes nowhere, so the ladder stopped
  // at the first rung and the bot slid along the wall it wanted to get past.
  // The test is therefore a DOT PRODUCT against what the navigator asked for.
  // A rung is only accepted while it still points at the goal; otherwise it
  // narrows, and the last rung of all crosses the knee-high props (see
  // botWallPush `crossLow`), which is what un-plugs the green walkthrough.
  let ll = 0;
  let bandUsed = 0;
  const rungs = BOT_BANDS.length + 1;
  for (let bi = NAV_Y && m.funnel && !hard ? BOT_BANDS.length - 1 : 0; bi < rungs; bi++) {
    bandUsed = bi;
    const cross = bi === rungs - 1;
    botWallPush(p, hard ? BOT_TUNING.escapeStandoff : BOT_BANDS[Math.min(bi, BOT_BANDS.length - 1)]!, cross);
    if (bi === 0) {
      // Remember what the FULL band wanted before the ladder narrows it.
      BOT_MID.x = BOT_PUSH.x;
      BOT_MID.z = BOT_PUSH.z;
    }
    BOT_WISH.x = wantX;
    BOT_WISH.z = wantZ;
    botStandoff(p, BOT_WISH);
    if (bi > 0) {
      // MIND THE MIDDLE. Once the ladder narrows the band, neither wall of a
      // 2.14 m walkthrough is inside it any more and the bot gets no lateral
      // guidance at all — it walks the corridor hugging whichever side it came
      // in on, which is where the last clips live (bot-6, L_Hand 0.083 m in
      // col-0; bot-7, R_Hand in col-9; both inside walkthroughs). The full-band
      // push is unsatisfiable in there but it still points the right way — at
      // the midline, where the 1.07 m of half-width on offer is all on one side
      // of nothing. So it comes back as a soft bias rather than a hard steer.
      BOT_WISH.x += BOT_MID.x * 0.55;
      BOT_WISH.z += BOT_MID.z * 0.55;
    }
    ll = Math.hypot(BOT_WISH.x, BOT_WISH.z);
    // Progress, not length: the cosine between what survived and what the
    // navigator asked for, both normalised so a crowded bot (separation adds to
    // `want`) is judged on direction like everyone else.
    const gain = ll > 1e-4 ? (BOT_WISH.x * wantX + BOT_WISH.z * wantZ) / (ll * wantL) : 0;
    if ((ll >= 0.3 && gain >= 0.35) || hard || wx * wx + wz * wz <= 1e-6) break;
  }
  if (ll < 0.3 && wx * wx + wz * wz > 1e-6) {
    // Even crossing the low props there is nothing: a bot wedged in a true
    // pocket. Back straight out along whatever it is leaning on — always a
    // direction, always the one that ends the wedge — and let the watchdog
    // escalate if it lasts.
    const pl = Math.hypot(BOT_PUSH.x, BOT_PUSH.z);
    if (pl > 1e-4) {
      BOT_WISH.x = BOT_PUSH.x / pl;
      BOT_WISH.z = BOT_PUSH.z / pl;
      ll = 1;
    }
  }
  m.wish = ll;
  m.band = bandUsed;
  if (ll < 1e-4) {
    cmd.ax = 0;
    cmd.az = 0;
    m.lastAx = 0;
    m.lastAz = 0;
    return;
  }
  // NUKETOWN RAIL VAULT: the navigator's wish runs into rail steel — jump it.
  // Grounded, deck-height, unprotected only (see botRailVaultJump); the probe
  // fires at most while the wish still points through the panel, and the
  // airborne mantle carries the body over. No routed leg ever vaults (the
  // graph has no rail edge), so this only fires on greedy direct legs —
  // never on a routed doorway/stair funnel the bot is already walking.
  botRailVaultJump(p, cmd, wx, wz);
  // A DIRECTION IS A DIRECTION. What survives the standoff is a heading; its
  // LENGTH is an artefact of how much of the wish two opposing faces cancelled,
  // and feeding that length through as stick deflection is a silent way to stop
  // a bot dead: movePlayer ignores any input under 0.12 total, so a wish that
  // came out at 0.05 was a motionless bot walking at full effort. The heading is
  // therefore normalised and the length kept only as a SPEED cue, floored where
  // the body still moves — under 0.55 total the sim walks instead of running,
  // which is what tight geometry should feel like anyway.
  const mag = clamp(ll, 0.42, 1);
  const ux = (BOT_WISH.x / ll) * mag;
  const uz = (BOT_WISH.z / ll) * mag;
  if (face) {
    // Out of contact a man looks where he walks — and he must, or the deflected
    // direction lands sideways in his own input frame and he never sprints.
    cmd.yaw = Math.atan2(ux, uz);
    p.botAimY = cmd.yaw;
    cmd.ax = 0;
    cmd.az = 1;
    m.lastAx = 0;
    m.lastAz = 1;
    return;
  }
  const sy = Math.sin(cmd.yaw);
  const cy = Math.cos(cmd.yaw);
  cmd.ax = clamp(ux * cy - uz * sy, -1, 1);
  cmd.az = clamp(ux * sy + uz * cy, -1, 1);
  m.lastAx = cmd.ax;
  m.lastAz = cmd.az;
}

// Perception is synchronous and non-recursive. Reuse ordered scratch space;
// nearest-first visibility finds the same target without tracing farther bodies
// that cannot beat it. Insertion preserves roster order at equal distances.
const BOT_PERCEPTION_PLAYERS: SimPlayer[] = [];
const BOT_PERCEPTION_DISTANCES: number[] = [];

function thinkBot(s: GameSession, p: SimPlayer, dt: number): void {
  const m = botMind(s, p);
  p.botT += dt;
  m.t += dt;
  m.goalT += dt;
  if (m.gap > 0) m.gap = Math.max(0, m.gap - dt);
  if (m.escape > 0) m.escape = Math.max(0, m.escape - dt);
  if (m.reposition > 0) m.reposition = Math.max(0, m.reposition - dt);
  if (m.plant > 0) m.plant = Math.max(0, m.plant - dt);
  m.settle = 1 + (m.settle - 1) * Math.exp(-dt / BOT_TUNING.settleTau);

  // ------------------------------------------------------------ watchdogs --
  // Nothing below teleports anything: a stuck bot gets a shove along the face
  // normal it is leaning on and a goal it can actually reach, and if THAT did
  // not move it, a committed run at the far side of the yard.
  //
  // THE ANCHOR ONLY MOVES WHEN THE BODY GETS SOMEWHERE, and that one line is the
  // difference between this watchdog and the P4 one it replaces. P4 re-anchored
  // every 3 s window whatever happened and cleared the streak on 1.5 m of gross
  // motion, so the failure this file exists to kill — a bot pacing the length of
  // a dead-end walkthrough — reset it on every pass: measured, bot-8 at
  // (13.34,1.17) sat at stuckRun 0 while botwatch's 6 s window read 0.54 m of
  // NET displacement (qa/out/stuck-probe.json, runs 12 and 14). Motion is not
  // progress. Anchoring on progress means the clock keeps running through the
  // pacing, the nudge lands at 3 s, the committed escape at 6 s, and a bot that
  // is genuinely walking somewhere resets it the moment it is `progressM` away.
  if (Math.hypot(p.x - m.anchorX, p.z - m.anchorZ) >= BOT_TUNING.progressM || p.protect > 0) {
    m.anchorX = p.x;
    m.anchorZ = p.z;
    m.anchorT = m.t;
    m.progT = m.t;
    m.stuckRun = 0;
  } else if (m.t - m.anchorT >= BOT_TUNING.stuckWin) {
    m.stuckRun += 1;
    BOT_HEALTH.windows += 1;
    if (m.stuckRun >= 2) BOT_HEALTH.escapes += 1;
    botUnstick(s, p, m, m.stuckRun >= 2);
    // The anchor position STAYS: only the clock re-arms, so a nudge that moves
    // the body half a metre and lets it drift back does not buy another window.
    m.anchorT = m.t;
  }
  m.stall = m.t - m.progT;
  // THE INVARIANT, evaluated on botwatch's own terms (see BOT_HEALTH): a body
  // whose whole last 6 s fits inside a 0.6 m circle is the defect the player
  // reported, whatever it thinks it is doing. Counted once per episode.
  if (p.protect > 0) m.histN = 0;
  if (m.t - m.histT >= BOT_FREEZE_DT) {
    m.histT = m.t;
    const k = m.histN % BOT_FREEZE_N;
    m.histX[k] = p.x;
    m.histZ[k] = p.z;
    m.histN += 1;
    if (m.histN >= BOT_FREEZE_N) {
      let far = 0;
      for (let i = 0; i < BOT_FREEZE_N; i++) far = Math.max(far, Math.hypot(m.histX[i]! - p.x, m.histZ[i]! - p.z));
      if (far < BOT_TUNING.stuckDisp) {
        if (!m.froze) {
          m.froze = true;
          m.frozeT = m.t;
          BOT_HEALTH.frozen += 1;
        }
        BOT_HEALTH.worstFreeze = Math.max(BOT_HEALTH.worstFreeze, m.t - m.frozeT + BOT_FREEZE_DT * (BOT_FREEZE_N - 1));
      } else {
        m.froze = false;
      }
    }
  }
  // Holding one pocket for 4.2 s is how a firefight becomes a statue (and how
  // botwatch's 6 s / 0.6 m STUCK window trips): relocate, still fighting.
  if (m.t - m.loiterT >= BOT_TUNING.loiterWin) {
    if (Math.hypot(p.x - m.loiterX, p.z - m.loiterZ) < BOT_TUNING.loiterDisp) {
      m.reposition = 1.5 + s.nextRand() * 0.9;
      m.flank = -m.flank;
      m.moveT = 0; // a new intention needs a new destination, not the old one
      if (m.goalT > 2) botRepath(s, p, m, true);
    }
    m.loiterX = p.x;
    m.loiterZ = p.z;
    m.loiterT = m.t;
  }

  // Stamp the ground under the bot as walked: the patrol scorer reads this to
  // send the roster where the roster has not been. Cheap — BOT_NAV is a few
  // dozen points, and there are no allocations.
  {
    const seen = botStale(s);
    for (let i = 0; i < BOT_NAV.length; i++) {
      const q = BOT_NAV[i]!;
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      if (dx * dx + dz * dz < 6.25) seen[i] = s.time;
    }
  }

  // ----------------------------------------------------------- perception --
  let target: SimPlayer | null = null;
  const eye = s.eyeY(p);
  BOT_PERCEPTION_PLAYERS.length = BOT_PERCEPTION_DISTANCES.length = 0;
  for (const o of s.players.values()) {
    if (o.id === p.id || !o.alive) continue;
    if (s.mode !== "ffa" && o.team === p.team) continue;
    const dx = o.x - p.x;
    const dz = o.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d >= 1e9) continue;
    let i = BOT_PERCEPTION_DISTANCES.length;
    while (i > 0 && BOT_PERCEPTION_DISTANCES[i - 1]! > d) {
      BOT_PERCEPTION_DISTANCES[i] = BOT_PERCEPTION_DISTANCES[i - 1]!;
      BOT_PERCEPTION_PLAYERS[i] = BOT_PERCEPTION_PLAYERS[i - 1]!;
      i--;
    }
    BOT_PERCEPTION_DISTANCES[i] = d;
    BOT_PERCEPTION_PLAYERS[i] = o;
  }
  for (const o of BOT_PERCEPTION_PLAYERS) {
    const dx = o.x - p.x;
    const dy = s.eyeY(o) - eye;
    const dz = o.z - p.z;
    const dist = Math.hypot(dx, dy, dz);
    const tr = traceWorld(p.x, eye, p.z, dx / dist, dy / dist, dz / dist, dist);
    if (tr.t >= dist - 0.35) {
      target = o;
      break;
    }
  }

  const cmd: InputCmd = {
    seq: ++p.seq,
    dt,
    ax: 0,
    az: 0,
    jump: false,
    crouch: false,
    sprint: false,
    tac: false,
    ads: false,
    yaw: p.yaw,
    pitch: p.pitch,
    fire: false,
    // A third of a magazine is "low" whatever the gun (AR 10/30, SMG 11/32,
    // pistol 4/12, sniper 1/5) — the old flat 10 kept a pistol reloading forever.
    reload: p.ammo <= 0 || (!target && p.ammo < Math.ceil((WEAPON_BY_ID[p.weapon]?.mag ?? 30) * 0.34)),
    melee: false,
    weapon: p.weapon,
    clientTime: s.time,
    ox: p.x,
    oy: eye,
    oz: p.z,
    dx: 0,
    dy: 0,
    dz: 1,
  };

  if (target) {
    // Acquisition, in two tiers. A FIRST sighting (new face, or one lost for
    // longer than `memory`) costs the full reaction and opens with a ranging
    // burst. Picking a man back up mid-fight — he stepped behind a container and
    // came out the other side — costs a third of that, because you were already
    // looking there. Charging full price every time a container crossed the line
    // is what made the first pass of this rewrite harmless: bots re-paid the
    // penalty every 0.5 s and never got past their opening burst.
    const gone = m.t - m.seenT;
    if (p.botTarget !== target.id || gone > 0.4) {
      const fresh = p.botTarget !== target.id || gone > BOT_TUNING.memory;
      // CROSSFIRE STAGGER. Two bots opening on the same man in the same tick is
      // how a 0.09 s death happens, and it is not how people fight: the second
      // man is moving into the angle, not already on it. He pays extra.
      let crowd = 0;
      if (fresh) for (const o of s.players.values()) if (o.bot && o.alive && o.id !== p.id && o.botTarget === target.id) crowd++;
      p.botReact = (fresh ? m.react : m.react * 0.35) * (1 + Math.min(2, crowd) * 0.45);
      m.settle = (fresh ? BOT_TUNING.settleMul : 1.45) * (1 + Math.min(2, crowd) * 0.2);
      // A burst cut short by re-acquisition is still a burst that happened, and
      // it is the SHORT end of the distribution the telemetry is there to show —
      // so bank it before the counter is re-armed rather than losing it.
      if (m.burstN > 0) {
        botFairnessLog(BOT_FAIRNESS.burst, m.burstN);
        m.burstN = 0;
      }
      m.burst = botBurstLen(s, m, WEAPON_BY_ID[p.weapon]);
      m.gap = Math.max(m.gap, 0.06);
      m.recoil = s.nextRand() < 0.5 ? -1 : 1;
      if (fresh) m.flank = s.nextRand() < 0.5 ? -1 : 1;
      // A sniper pays for its one-shot with a slower read of a new face.
      if (fresh && p.weapon === "sniper") p.botReact += 0.3;
      // Start the first-LOS -> first-shot stopwatch on a FRESH sighting only:
      // re-acquiring a man you were already fighting is not a reaction, and
      // averaging those in is what would make the number flatter than the feel.
      if (fresh) {
        m.losT = m.t;
        m.losOpen = true;
      }
    }
    p.botTarget = target.id;
    p.botReact = Math.max(0, p.botReact - dt);
    m.seenX = target.x;
    m.seenZ = target.z;
    m.seenY = target.y;
    m.seenT = m.t;

    // --------------------------------------------------------------- aim --
    const th = target.crouch ? CROUCH_H : STAND_H;
    const tx = target.x + target.vx * m.lead;
    const tz = target.z + target.vz * m.lead;
    // Chest, never the skull — and low in the chest at that. A head hit is 1.5x,
    // so two of them plus one body round is a 0.14 s death: the last sub-0.5 s
    // kills left in the distribution were all head-heavy. Aiming at 0.48 of the
    // body puts the skull 3+ sigma above the aim point at every range.
    // A scoped sniper lays the crosshair on the chest line (it has one round to
    // spend) — straddling the upper/lower boundary, so roughly half its hits are
    // a 90-damage body shot rather than a kill: a bot sniper is a threat, never a
    // guaranteed delete. Everyone else keeps the low-chest point the TTK floor
    // is built on.
    const sniping = p.weapon === "sniper";
    const ty = target.y + th * (sniping ? 0.53 : 0.48);
    const dx = tx - p.x;
    const dz = tz - p.z;
    const dh = Math.hypot(dx, dz) || 1e-3;
    const dist = Math.hypot(dx, ty - eye, dz);
    const ownSpd = Math.hypot(p.vx, p.vz);
    const tgtSpd = Math.hypot(target.vx, target.vz);
    // How wrong this bot is allowed to be right now, in metres at the target.
    const err =
      (BOT_TUNING.errBase +
        BOT_TUNING.errPerMetre * dist +
        BOT_TUNING.errPerTargetSpeed * tgtSpd +
        BOT_TUNING.errPerOwnSpeed * ownSpd +
        BOT_TUNING.errPerHeat * m.heat) *
      m.settle *
      (1.3 - 0.5 * m.skill) *
      (sniping ? 1.45 : 1);
    // The error WANDERS (correlated over errTau) instead of resampling per tick:
    // per-tick noise averages out over a burst and reads as a laser with grain.
    // Ornstein-Uhlenbeck, scaled so the steady state is unit variance whatever
    // the tick rate is — `err` above is then a true 1-sigma in metres.
    const k = 1 - Math.exp(-dt / BOT_TUNING.errTau);
    const g = Math.sqrt(k * (2 - k)) / 0.289; // 0.289 = std of (r+r+r-1.5)
    m.errU = m.errU * (1 - k) + (s.nextRand() + s.nextRand() + s.nextRand() - 1.5) * g;
    m.errV = m.errV * (1 - k) + (s.nextRand() + s.nextRand() + s.nextRand() - 1.5) * g;
    const rx = dz / dh;
    const rz = -dx / dh;
    const ax = tx + rx * m.errU * err;
    const az = tz + rz * m.errU * err;
    // NECK CEILING. The sim calls a hit a HEADSHOT above `top - 0.22`, i.e. above
    // 0.874 of a standing body, and a headshot is 1.5x — 42 damage, which turns a
    // legal 3-round burst (84, never lethal) into a lethal one the moment two of
    // its rounds go high. That is the only remaining way a bot could kill from
    // full health inside the burst floor, so the aim point is simply not allowed
    // up there: vertical error is clamped below the neck line. Bots still hit
    // heads by accident when a target ducks or vaults into the line; they never
    // aim at one, and they cannot walk a burst up into one.
    const ay = Math.min(ty + m.errV * err * 0.55, target.y + th * 0.78);
    const wantY = Math.atan2(ax - p.x, az - p.z);
    const ah = Math.hypot(ax - p.x, ay - eye, az - p.z) || 1;
    const wantP = -Math.asin(clamp((ay - eye) / ah, -1, 1));
    const kk = 1 - Math.exp(-m.track * dt);
    p.botAimY += angWrap(wantY - p.botAimY) * kk;
    p.botAimP += (wantP - p.botAimP) * kk;
    p.botAimY += (s.nextRand() - 0.5) * 0.008;
    p.botAimP += (s.nextRand() - 0.5) * 0.005;
    // Heat is applied to the MUZZLE, past the tracking filter. Folded into the
    // aim goal instead, the filter's own lag ate it and the burst kept landing
    // on the true target — measured: four rounds, 0.218 s, dead.
    const inv = 1 / Math.max(2, dist);
    cmd.yaw = p.botAimY + m.heat * BOT_TUNING.heatSway * m.recoil * inv;
    cmd.pitch = clamp(p.botAimP - m.heat * BOT_TUNING.heatClimb * inv, -1.2, 1.2);
    cmd.ads = sniping ? dist > (BOT_ADS_AT.sniper ?? 3) : dist > (BOT_ADS_AT[p.weapon] ?? 6.5) && p.hp > 25 && m.reposition <= 0;

    // ----------------------------------------------------------- trigger --
    // The gate is against the bot's OWN aim point: it shoots where it believes,
    // and it is wrong by `err` — plus a muzzle it is not fully holding down.
    const settled = Math.abs(angWrap(wantY - p.botAimY)) < 0.05 + 0.03 * (1 - m.skill);
    // SQUAD DISCIPLINE: wait your turn. A teammate's round inside the hold below
    // keeps this bot off the trigger, so ten bots cannot stack four
    // hits into a tenth of a second the way run 1 measured (106 damage, 0.125 s,
    // two bots, neither of them cheating). The bot spends the wait taking an
    // angle instead of standing in the open with a held breath.
    const press = botPress(s).get(target.id);
    // CONTACT SHORTENS THE HOLD; IT DOES NOT REMOVE IT. `crossFree` exists so a
    // bot with a man in its muzzle is not left standing there with its finger
    // off the trigger — but written as a plain `dist > crossFree` it removed the
    // discipline outright for every bot inside 3.5 m, which is the firing squad
    // the discipline was built to kill. Measured on this sim, strafing
    // full-health target: 2 bots at 3 m, min TTK 0.125 s and 11% of trials under
    // 0.5 s; 3 bots, 0.063 s. The control says the exemption was the whole of
    // it — ONE bot at the same 3 m floors at 1.156 s.
    //
    // A "one seat, closest man" version was tried and leaks for a reason worth
    // recording: the seat is only ever contested WHILE someone else is shooting,
    // so whoever the seat is handed to fires ON TOP of a burst already in the
    // air. Measured, 4 bots at 3 m: bot-0 at 0.000/0.063 s, bot-1 at
    // 0.172/0.234 s — 112 damage in 0.234 s, and both bots obeying the rule.
    // Two shooters is two shooters however carefully the second one is chosen.
    //
    // So the hold shrinks instead of vanishing, and the size of it is arithmetic
    // rather than taste. The worst case is a full 3-round burst landing (84,
    // never lethal, spanning 2 fire intervals ~0.15 s) and the contact bot's
    // first round arriving `crossNear` after the last of them: the fourth hit
    // cannot land before ~0.15 + crossNear. At the 0.28 s the review suggested
    // that is 0.43 s and still inside the gate; at 0.5 s it is 0.65 s, which
    // clears it with a fifth of a second to spare and still lets the man in your
    // face answer inside a single reaction time rather than a full second.
    const hold = dist <= BOT_RANGE.crossFree ? BOT_TUNING.crossNear : BOT_TUNING.crossHold;
    const yielding = !!press && press.by !== p.id && s.time - press.t < hold;
    if (yielding) {
      botFairnessLog(BOT_FAIRNESS.yield, hold - (s.time - press!.t));
      if (m.reposition <= 0 && s.nextRand() < dt * 1.6) {
        m.reposition = 0.8 + s.nextRand() * 0.7;
        m.moveT = 0;
      }
    }
    // SNIPER DISCIPLINE: the bolt gun fires only from a full, settled sight
    // picture held for a beat (a rookie holds longer) — never a no-scope, never
    // a flick. SEMI/BOLT: the trigger is released between pulls, exactly what
    // the sim's arm demands of a human.
    m.scopeT = p.ads >= 0.95 ? m.scopeT + dt : 0;
    const sightReady = !sniping || m.scopeT >= 0.32 + 0.35 * (1 - m.skill);
    const wHeld = WEAPON_BY_ID[p.weapon];
    const released = !wHeld || wHeld.fire === "auto" || !m.lastFire;
    cmd.fire = p.botReact <= 0 && m.gap <= 0 && m.burst > 0 && settled && p.reload <= 0 && !yielding && sightReady && released;
    // THE KNIFE IS A FINISHER, NOT AN OPENER. It does 135 — a one-shot kill from
    // full health, which is the one death in this model with no floor under it
    // at all (the headless study at 5 m caught a 0.000 s kill: walked up, swung,
    // done). Every other route to killing the player is four hits and at least
    // 0.81 s of clock. TWO conditions gate it now, and both are load-bearing:
    //
    //  1. THE MAN IS ALREADY HURT — unconditionally. The first pass also swung
    //     when the bot's own gun was empty or mid-reload, which quietly made the
    //     knife an opener again: `tryMelee` looks at `fireCd` and nothing else,
    //     so an out-of-ammo bot at contact one-shot a 100 hp player. Measured,
    //     empty gun at 1.4 m: 20 of 64 kills at 0.000 s. An empty bot now does
    //     what a person does — gets off the X and reloads (`tryFire` starts the
    //     reload the moment it is asked for a round it does not have, and the
    //     hurt/reposition steering below takes it out of the doorway). The swing
    //     is simply not on offer at full health, from any state.
    //  2. NO ROUND HAS TOUCHED THIS TARGET INSIDE `crossHold` — its own rounds
    //     included. 135 damage ignores every burst floor above it, so the only
    //     thing that can put a floor under a swing is the clock since the last
    //     shot landed on that man. A 3-round burst ends at 0.15 s and the knife
    //     that finishes it cannot arrive before 0.81 s. Without this the bot
    //     shot a man to 16 hp and stabbed him one fire-interval later (a 0.22 s
    //     kill from full health), and a target a teammate had just chipped could
    //     be finished instantly inside the very window every other bot is
    //     holding for — which is how the review's 3-bot 0.063 s death ended.
    const pressAge = press ? s.time - press.t : 99;
    if (dist < 1.7 && p.botReact <= 0 && target.hp <= 55 && pressAge >= BOT_TUNING.crossHold) {
      cmd.melee = true;
      cmd.fire = false;
    }

    // ---------------------------------------------------------- movement --
    // A DESTINATION, NOT A BEARING — and this is the last of the four freeze
    // mechanisms the probe caught. Every branch below is written relative to
    // where the enemy is standing RIGHT NOW, and re-deriving it 64 times a
    // second turns a flank into an orbit: the enemy moves, the offset rotates
    // with it, and the bot runs a circle at constant radius with no net
    // displacement at all. Measured, and it does not look slow from outside —
    // bot-1 on 19 hp at (2.6,-9.71) held 0.59 m over 6 s while running at
    // 1.74 m/s. So the point is CHOSEN, held for a second or two, and walked to.
    // Aim, trigger and target selection still update every tick; only the feet
    // get a decision they keep, which is also what a person does.
    //
    // COMMIT TO A SIDE, too. `m.flank` used to be a coin flipped every tick at
    // 0.6/s — a mean hold of 1.7 s, so a bot reversed its circle inside every
    // 6 s window. A side now holds for a few seconds, and a hurt bot breaking
    // contact never swaps at all: which way you are getting out of a fight is
    // not a decision worth re-taking twice a second.
    m.flankT -= dt;
    if (m.flankT <= 0) {
      m.flankT = 2.5 + s.nextRand() * 2.5;
      if (p.hp >= 35) m.flank = -m.flank;
      m.moveT = 0;
    }
    m.moveT -= dt;
    const hurt = p.hp < 35 && dist < BOT_RANGE.engageHurt;
    if (m.moveT <= 0 || hurt !== m.moveHurt || Math.hypot(m.moveX - p.x, m.moveZ - p.z) < 1.3) {
      let gx: number;
      let gz: number;
      if (hurt) {
        // Hurt: break contact rather than trade to the death.
        gx = p.x - (dx / dh) * BOT_RANGE.flankBreak + rx * BOT_RANGE.flankBreakSide * m.flank;
        gz = p.z - (dz / dh) * BOT_RANGE.flankBreak + rz * BOT_RANGE.flankBreakSide * m.flank;
      } else if (m.reposition > 0) {
        // Relocate across the fight instead of standing in the same doorway.
        gx = p.x + rx * BOT_RANGE.flankRelocate * m.flank + (dx / dh) * BOT_RANGE.flankRelocateIn;
        gz = p.z + rz * BOT_RANGE.flankRelocate * m.flank + (dz / dh) * BOT_RANGE.flankRelocateIn;
      } else if (dist > BOT_RANGE.engageFar && p.weapon !== "sniper") {
        // Close, but on an angle — nobody walks up the middle. (A sniper does
        // not close: it holds its lane, below.)
        gx = tx + rx * BOT_RANGE.flankArc * m.flank;
        gz = tz + rz * BOT_RANGE.flankArc * m.flank;
      } else if (p.weapon === "smg" && dist > BOT_RANGE.engageNear) {
        // SMG: RUSH. Inside its 10 m damage step it out-kills everything, so it
        // takes the fight there — in on an angle, not straight down the lane.
        gx = tx + rx * BOT_RANGE.flankClose * m.flank - (dx / dh) * BOT_RANGE.flankCloseOut;
        gz = tz + rz * BOT_RANGE.flankClose * m.flank - (dz / dh) * BOT_RANGE.flankCloseOut;
      } else if (dist > BOT_RANGE.engageNear) {
        gx = p.x + rx * BOT_RANGE.flankHold * m.flank + (dx / dh) * BOT_RANGE.flankHoldIn;
        gz = p.z + rz * BOT_RANGE.flankHold * m.flank + (dz / dh) * BOT_RANGE.flankHoldIn;
      } else {
        gx = p.x + rx * BOT_RANGE.flankClose * m.flank - (dx / dh) * BOT_RANGE.flankCloseOut;
        gz = p.z + rz * BOT_RANGE.flankClose * m.flank - (dz / dh) * BOT_RANGE.flankCloseOut;
      }
      m.moveX = gx;
      m.moveZ = gz;
      m.moveHurt = hurt;
      m.moveT = 1.1 + s.nextRand() * 0.9;
    }
    botSteer(s, p, m, m.moveX, m.moveZ, dt);
    botMove(s, p, m, cmd, m.dirX, m.dirZ);
    cmd.sprint =
      dist > (p.weapon === "smg" ? BOT_RANGE.sprintGate * 0.7 : BOT_RANGE.sprintGate) && p.hp > 35 && m.escape <= 0 && !sniping;
    // SETTING THE FEET. A bot holding a mid-range angle stops walking to shoot.
    //
    // IT DOES NOT DUCK, AND THAT IS DELIBERATE. client/src/bruiser.ts:934
    // subtracts the crouch hip-drop from the bone's LIVE position every frame
    // while the walk clip never rewrites that track, so a body that is crouched
    // and moving integrates downwards without limit: the review measured a bot's
    // HEAD 2.977 m under the floor with the sim capsule perfectly legal. The
    // previous guard here tried to gate the duck on speed, but it sampled
    // velocity BEFORE applyInput, and the standoff/separation forces a planted
    // bot deliberately keeps obeying could push it past the client's 0.4 m/s
    // crouch-WALK threshold inside the same tick — it leaked in 2 of the
    // reviewer's 4 runs. There is no safe way to set this flag from here until
    // bruiser.ts subtracts from the BIND pose (a one-line client fix, escalated),
    // so nothing in the bot brain sets cmd.crouch at all. Planting alone still
    // reads as steadying up, and it costs the fight nothing.
    const canPlant = !cmd.sprint && dist > 5 && (dist < 16 || sniping) && m.escape <= 0 && m.reposition <= 0;
    // Roughly one plant every three seconds, held under a second — long enough
    // to read as "steadying up", never long enough to look like a statue (the
    // STUCK window is 0.6 m over 6 s and a planted bot must not approach it).
    // A SNIPER HOLDS ITS ANGLE: it plants far more often and for up to 2 s —
    // still well inside the 6 s freeze window, and the loiter watchdog moves it
    // on between holds.
    if (canPlant && m.plant <= 0 && s.nextRand() < dt * (sniping ? 1.4 : 0.34)) m.plant = sniping ? 1.1 + s.nextRand() * 0.9 : 0.55 + s.nextRand() * 0.4;
    if (m.plant > 0 && canPlant) {
      // Planted: no walk input, though the wall standoff and the shove off
      // teammates still apply — otherwise a crowd could press a motionless bot
      // into the steel it is standing next to.
      botMove(s, p, m, cmd, 0, 0);
    }
  } else if (p.botTarget && m.t - m.seenT < BOT_TUNING.memory) {
    // Lost sight: pressure the last known spot for a beat. A bot that forgets
    // you the instant a container crosses the line is furniture, not an enemy.
    const dx = m.seenX - p.x;
    const dz = m.seenZ - p.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    cmd.pitch = 0;
    p.botAimP = 0;
    botSteer(s, p, m, m.seenX - (dx / d) * 1.2, m.seenZ - (dz / d) * 1.2, dt, NAV_Y ? m.seenY : NaN);
    botMove(s, p, m, cmd, m.dirX, m.dirZ, true);
    cmd.sprint = d > 6 && m.escape <= 0;
  } else {
    // ------------------------------------------------------------ patrol --
    p.botTarget = null;
    p.botReact = Math.max(p.botReact, 0.2 + s.nextRand() * 0.2);
    const dg = Math.hypot(m.goalX - p.x, m.goalZ - p.z);
    // NAV_Y: a goal on the far storey of the far house is a 20 s walk (two doors and a stair).
    if ((dg < 1.5 && (!NAV_Y || Math.abs(m.goalY - p.y) < 1.2)) || m.goalT > (NAV_Y ? 28 : 14)) botRepath(s, p, m);
    botSteer(s, p, m, m.goalX, m.goalZ, dt, NAV_Y ? m.goalY : NaN);
    cmd.pitch = 0;
    p.botAimP = 0;
    botMove(s, p, m, cmd, m.dirX, m.dirZ, true);
    cmd.sprint = m.escape <= 0;
    cmd.tac = cmd.sprint && s.nextRand() > 0.8;
  }

  // Fresh spawn: hold position ~0.5 s (orient, don't sprint through a teammate's
  // face) — still aims and fires if a target appears.
  if (p.protect > SPAWN_PROTECT - 0.5) {
    cmd.ax = 0;
    cmd.az = 0;
    cmd.sprint = false;
    cmd.tac = false;
  }
  // WEAPON UP NEAR STEEL. Applied last because every branch above has its own
  // opinion about sprinting and aiming. `BOT_NEAREST` is the surface-to-face gap
  // left by the sweep botMove already did, so this costs nothing.
  //
  // No standoff can hold a hand out of a container — the rig throws one 1.43 m
  // from the capsule centre and a walkthrough corridor is 1.07 m of half-width —
  // but the POSE decides most of it. Hand orbit measured per gait AND per aim
  // state on the live client (8846 samples, 10 bots):
  //
  //      run, hip-fire   mean 0.982 m,  42.9% past 0.95 m,  26.3% past 1.15 m
  //      run, SHOULDERED mean 0.669 m,   7.5% past 0.95 m,   3.0% past 1.15 m
  //      sprint          mean 1.073 m,  59.8% past 0.95 m,  47.6% past 1.15 m
  //
  // A shouldered weapon tucks the hands into the chest — an eightfold cut in the
  // population of frames that can reach steel at all, and far bigger than any
  // knob in this file. So near geometry a bot stops sprinting and brings the
  // rifle up. It is also simply what a person does squeezing past a container in
  // a firefight, and a bot that comes round a corner already aiming is a better
  // fight than one that arrives at a dead run and then starts aiming.
  //
  // Shouldering costs 32% of walk speed (ADS_MUL), and scoping it to contact
  // only — which looked like the cheap version — was measured and rejected:
  // clips came straight back (3 in one run, two of them inside a walkthrough)
  // and coverage barely moved, 44.5% to 47.2%. The pace is paid back where it
  // actually comes from instead, in the patrol scorer (see BOT_STALE).
  if (BOT_NEAREST < BOT_TUNING.sprintNear) {
    cmd.sprint = false;
    cmd.ads = true;
  }
  // ------------------------------------------------------- weapon choice --
  // Everybody carries the pistol and everybody uses it the way people do: dry
  // primary with a man close -> pistol (faster than any reload); a sniper with
  // a man in its face -> pistol; a quiet moment -> back to the primary to
  // reload it. The swap is the same InputCmd.weapon a human sends.
  m.calmT = target ? 0 : m.calmT + dt;
  {
    const primary = p.loadout.primary;
    const onPistol = p.weapon !== primary;
    const tDist = target ? Math.hypot(target.x - p.x, target.z - p.z) : 99;
    if (!onPistol && target && p.altAmmo > 0) {
      if ((p.ammo <= 0 && tDist < 14) || (p.weapon === "sniper" && tDist < 5)) cmd.weapon = p.alt;
    } else if (onPistol) {
      const dry = p.ammo <= 0 && p.reserve <= 0;
      const far = primary === "sniper" ? 9 : 16;
      if ((m.calmT > 1.8 && p.altAmmo + p.altRes > 0) || (dry && p.altAmmo > 0) || (target && tDist > far && p.altAmmo > 0)) cmd.weapon = p.alt;
    }
    if (cmd.weapon !== p.weapon) cmd.reload = false;
  }
  // ---------------------------------------------------------------- frag --
  if (botFrag(s, p, m, target, cmd, dt, eye)) {
    cmd.sprint = false;
  }
  m.lastFire = cmd.fire;
  const dir = aimDir(cmd.yaw, cmd.pitch);
  cmd.dx = dir.dx;
  cmd.dy = dir.dy;
  cmd.dz = dir.dz;
  const ammoWas = p.ammo;
  const weaponWas = p.weapon;
  s.applyInput(p, cmd, false);
  // Burst bookkeeping reads what the sim actually fired, so the trigger model
  // can never drift out of step with the weapon's cadence. (Same gun only: a
  // swap exchanges the magazines and is not a shot.)
  if (p.weapon === weaponWas && p.ammo < ammoWas) {
    // Claim the target: this bot is now the one pressing it, and every teammate
    // holds until `crossHold` after this round.
    if (p.botTarget) botPress(s).set(p.botTarget, { by: p.id, t: s.time });
    if (m.losOpen) {
      botFairnessLog(BOT_FAIRNESS.reaction, m.t - m.losT);
      m.losOpen = false;
    }
    m.burst -= 1;
    m.burstN += 1;
    m.heat = Math.min(1, m.heat + BOT_TUNING.heatPerShot);
    if (m.burst <= 0) {
      // COUNT THE ROUNDS, DO NOT DERIVE THEM. This used to log
      // `burstMax - m.burst` from inside `if (m.burst <= 0)`, one line after a
      // decrement — so m.burst was always exactly 0 and the ring recorded 3.0
      // for every burst ever fired, including the 2-round ones `botBurstLen`
      // hands out. The distribution this file exists to make reviewable was a
      // constant. `burstN` is incremented off the sim's own ammo above, so what
      // comes out is what left the gun.
      botFairnessLog(BOT_FAIRNESS.burst, m.burstN);
      m.burstN = 0;
      // THE FLOOR, ENFORCED HERE. The roll can only ever lengthen the pause:
      // `gapMin` is a hard minimum, not the bottom of a range that a 0.8x roll
      // can dip under. With burstMax at 3 that is what makes a fourth hit from
      // full health impossible before 2 x 0.075 + 0.66 = 0.81 s.
      m.gap = Math.max(BOT_TUNING.gapMin, lerp(BOT_TUNING.gapMax, BOT_TUNING.gapMin, m.skill) * (1 + s.nextRand() * 0.45));
      botFairnessLog(BOT_FAIRNESS.gap, m.gap);
      m.burst = botBurstLen(s, m, WEAPON_BY_ID[p.weapon]);
      m.recoil = s.nextRand() < 0.5 ? -1 : 1;
    }
  } else {
    // Heat barely moves BETWEEN the rounds of a burst (0.075 s apart) and dumps
    // during the pause after one: the decay is a burst-length penalty, not a
    // global accuracy tax, so bots stay lethal over a fight they keep pressing.
    m.heat = Math.max(0, m.heat - dt * BOT_TUNING.heatBleed * (m.gap > 0 ? 1 : 0.22));
  }
}

export function localCmd(
  seq: number,
  dt: number,
  keys: {
    f: boolean;
    b: boolean;
    l: boolean;
    r: boolean;
    jump: boolean;
    crouch: boolean;
    sprint: boolean;
    tac: boolean;
    ads: boolean;
    fire: boolean;
    reload: boolean;
    melee: boolean;
    nade?: boolean;
    nadeHold?: boolean;
  },
  yaw: number,
  pitch: number,
  weapon: string,
  origin: { x: number; y: number; z: number },
  clientTime: number,
  /** Server-clock time of the frame this command was aimed on. See InputCmd.rt. */
  renderTime?: number,
): InputCmd {
  let ax = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
  let az = (keys.f ? 1 : 0) - (keys.b ? 1 : 0);
  const l = Math.hypot(ax, az);
  if (l > 1) {
    ax /= l;
    az /= l;
  }
  const d = aimDir(yaw, pitch);
  return {
    seq,
    dt,
    ax,
    az,
    jump: keys.jump,
    crouch: keys.crouch,
    sprint: keys.sprint,
    tac: keys.tac,
    ads: keys.ads,
    yaw,
    pitch,
    fire: keys.fire,
    reload: keys.reload,
    melee: keys.melee,
    nade: !!keys.nade,
    nadeHold: !!keys.nadeHold,
    weapon,
    clientTime,
    ...(Number.isFinite(renderTime as number) ? { rt: renderTime } : {}),
    ox: origin.x,
    oy: origin.y,
    oz: origin.z,
    dx: d.dx,
    dy: d.dy,
    dz: d.dz,
  };
}
