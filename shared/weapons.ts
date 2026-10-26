/**
 * THE ARSENAL — four guns and a knife, ported from Kong Royale and retuned for a
 * Call of Duty 6v6 arena (100 hp, health regen, no armour).
 *
 * Every number the sim, the client prediction, the HUD crosshair, the loadout
 * bars (shared/loadout.ts) and the TTK report (scripts/ttk-check.mjs ->
 * docs/nuketown/WEAPONS.md) use is in this file. Change a number here and every
 * one of those follows; nothing downstream restates a stat.
 *
 * DAMAGE MODEL (CoD): a damage STEP table by range (not a lerp — a gun has a
 * 4-shot range and a 5-shot range, and you can learn where the line is), times a
 * zone multiplier: head (top 0.22 m of the capsule) x headMul, upper body (the
 * next 0.63 m — chest, shoulders, arms) x1, lower body + legs x lowerMul. Damage
 * is rounded to whole hit points per bullet.
 *
 * SPREAD (degrees, cone RADIUS): hip-fire cone by stance [still, moving, air],
 * an aimed cone [still, moving, air] it eases to as ADS comes in, and bloom —
 * `heat` climbs per shot and multiplies the cone, draining once the trigger is
 * off. The direction inside the cone is a deterministic hash of (player, command
 * seq), so the shooter's client draws the tracer, and predicts the hitmarker, on
 * the exact ray the server traces (shared/sim.ts shotCone / spreadDir).
 *
 * RECOIL is client-side AIM (game.ts / weapon-feel.ts): the kick moves the
 * crosshair and therefore where the next bullet goes; the server simply fires
 * down the aim it is sent. `pattern` is the per-shot [vertical, horizontal]
 * multiplier, KR's pattern tables retuned so the first 4-5 rounds of an AR stay
 * tight and the climb is learnable.
 */

export type FireMode = "auto" | "semi" | "bolt" | "melee";
export type WeaponClass = "AR" | "SMG" | "SR" | "PISTOL" | "MELEE";

export type WeaponDef = {
  id: string;
  /** Full display name, e.g. "KR-4 CAVENDISH". */
  name: string;
  /** Model designation only, for tight HUD space. */
  short: string;
  class: WeaponClass;
  /** Class label as the loadout card prints it. */
  cls: string;
  fire: FireMode;
  /** Cyclic rate; for semi/bolt the cap on how fast a trigger pull is honoured. */
  rpm: number;
  /** [upToMetres, damage] ascending. The last row applies beyond its range too. */
  dmg: readonly (readonly [number, number])[];
  headMul: number;
  /** Lower torso and legs. Arms ride the upper-body band (x1). */
  lowerMul: number;
  pellets: number;
  /** Melee only: reach in metres. */
  reach: number;
  mag: number;
  /** Spec reserve (a floor — the match economy in sim.ts sizes the real one). */
  reserves: number;
  /** Tactical reload (rounds left in the mag), seconds. */
  reload: number;
  /** Empty reload (bolt / slide locked back), seconds. */
  emptyReload: number;
  /** Seconds to full ADS. */
  adsTime: number;
  /** Seconds after sprint before the trigger is live. */
  sprintOut: number;
  /** Raise time when swapping TO this weapon, seconds. */
  swap: number;
  /** Movement speed multiplier while holding it (hip). */
  move: number;
  /** Extra multiplier while fully aimed (replaces the old global ADS_MUL). */
  adsMove: number;
  /** Hip cone radius, degrees: [still, moving, airborne]. */
  hip: readonly [number, number, number];
  /** Aimed cone radius, degrees: [still, moving, airborne]. */
  ads: readonly [number, number, number];
  /**
   * Sniper rule: below this ADS fraction a shot uses the HIP cone outright (no
   * free no-scopes; a quick-scope that reaches the gate is a real shot). 0 =
   * the cone eases continuously with ADS.
   */
  adsGate: number;
  /** Bloom: [heat per shot, heat cap, drain per second]. Cone x (1 + heat). */
  bloom: readonly [number, number, number];
  /** Recoil, client-side aim. Degrees per shot vertical / horizontal scale. */
  kick: number;
  kickYaw: number;
  /** Springback rate (1/s) of the recoverable share of each kick. */
  recoilRec: number;
  /** Multiplier on kick while fully aimed. */
  adsKick: number;
  /** [vertical, horizontal] multiplier per shot index; the tail loops. */
  pattern: readonly (readonly [number, number])[];
  /** Camera punch (visual only), degrees. */
  punch: number;
  /** Vertical camera FOV, degrees, at full ADS (hip is 68). */
  adsFov: number;
  /** Sniper: the scope overlay replaces the sights at full ADS. */
  scope: boolean;
  /** Tracer speed for the drawn round, m/s (hitscan is still instant). */
  tracer: number;
};

/** Hip-fire vertical FOV, degrees — the camera's resting value (game.ts). */
export const HIP_FOV = 68;

const AR: WeaponDef = {
  id: "ar",
  name: "KR-4 CAVENDISH",
  short: "KR-4",
  class: "AR",
  cls: "ASSAULT RIFLE",
  fire: "auto",
  rpm: 780,
  // The 4-shot reach goes 25 -> 30 m so the rifle owns the long lanes.
  dmg: [
    [30, 28],
    [45, 23],
    [Infinity, 20],
  ],
  headMul: 1.35,
  lowerMul: 0.9,
  pellets: 1,
  reach: 0,
  mag: 30,
  reserves: 90,
  reload: 1.55,
  emptyReload: 1.95,
  adsTime: 0.24,
  sprintOut: 0.2,
  swap: 0.5,
  move: 1.0,
  adsMove: 0.68,
  hip: [2.0, 2.9, 5.5],
  ads: [0.07, 0.4, 2.6],
  adsGate: 0,
  bloom: [0.11, 0.9, 3.4],
  kick: 0.5,
  kickYaw: 0.24,
  recoilRec: 11,
  adsKick: 0.78,
  // KR's AR S-curve retuned for CoD: the opening five rounds climb straight and
  // gentle (a 4-shot kill lands inside them), then the muzzle drifts right,
  // swings back left and settles into a loop the player learns to pull against.
  pattern: [
    [0.74, 0.0],
    [0.8, 0.05],
    [0.86, -0.04],
    [0.92, 0.08],
    [0.98, 0.14],
    [1.08, 0.36],
    [1.12, 0.55],
    [1.06, 0.38],
    [1.0, -0.12],
    [0.98, -0.5],
    [0.96, -0.66],
    [0.95, -0.36],
    [0.95, 0.14],
    [0.95, 0.5],
    [0.95, 0.32],
    [0.95, -0.24],
  ],
  punch: 0.32,
  adsFov: 55,
  scope: false,
  tracer: 520,
};

const SMG: WeaponDef = {
  id: "smg",
  name: "MX9 LADYFINGER",
  short: "MX9",
  class: "SMG",
  cls: "SUBMACHINE GUN",
  fire: "auto",
  // SMG rebalance — 900 -> 850 rpm (close TTK 200 -> 212 ms) and the 4- and
  // 5-shot ranges pulled in (10/20 m -> 8/16 m), so it rules the doorways but
  // no longer out-trades the rifle across the yard.
  rpm: 850,
  dmg: [
    [8, 25],
    [16, 20],
    [Infinity, 15],
  ],
  headMul: 1.25,
  lowerMul: 0.9,
  pellets: 1,
  reach: 0,
  mag: 32,
  reserves: 96,
  reload: 1.45,
  emptyReload: 1.8,
  adsTime: 0.18,
  sprintOut: 0.13,
  swap: 0.42,
  move: 1.05,
  adsMove: 0.8,
  hip: [1.35, 1.8, 3.6],
  ads: [0.12, 0.35, 2.0],
  adsGate: 0,
  bloom: [0.07, 0.75, 4.2],
  kick: 0.36,
  kickYaw: 0.3,
  recoilRec: 15,
  adsKick: 0.75,
  // KR's SMG zigzag, flattened: a fast, small left-right chatter over a shallow
  // climb — the gun dances, it does not run away.
  pattern: [
    [0.8, 0.15],
    [0.85, -0.3],
    [0.9, 0.4],
    [0.95, -0.45],
    [1.0, 0.55],
    [1.0, -0.45],
    [0.95, 0.6],
    [0.95, -0.65],
    [0.9, 0.5],
    [0.9, -0.55],
  ],
  punch: 0.24,
  adsFov: 59,
  scope: false,
  tracer: 480,
};

const SNIPER: WeaponDef = {
  id: "sniper",
  name: "SR-7 BLUE JAVA",
  short: "SR-7",
  class: "SR",
  cls: "SNIPER RIFLE",
  fire: "bolt",
  rpm: 48,
  dmg: [[Infinity, 120]],
  headMul: 1.5,
  // 120 x 0.75 = 90: a leg or a hip is two shots. Head and upper body kill.
  lowerMul: 0.75,
  pellets: 1,
  reach: 0,
  mag: 5,
  reserves: 20,
  reload: 2.3,
  emptyReload: 2.8,
  adsTime: 0.38,
  sprintOut: 0.3,
  swap: 0.62,
  move: 0.92,
  adsMove: 0.55,
  // A hip shot is a coin toss past arm's length; a moving scope is no laser.
  hip: [7.5, 9.5, 13],
  ads: [0.0, 1.3, 4.5],
  adsGate: 0.85,
  bloom: [0, 0, 1],
  kick: 3.4,
  kickYaw: 0.5,
  recoilRec: 6,
  adsKick: 0.8,
  pattern: [[1, 0.15], [1, -0.15]],
  punch: 1.6,
  // ~4.3x: tan(34) / tan(8.85).
  adsFov: 17.7,
  scope: true,
  tracer: 900,
};

const PISTOL: WeaponDef = {
  id: "pistol",
  name: "P-9 BURRO",
  short: "P-9",
  class: "PISTOL",
  cls: "PISTOL",
  fire: "semi",
  rpm: 450,
  // The 3-shot reach goes 12 -> 14 m, a real sidearm swap.
  dmg: [
    [14, 34],
    [25, 26],
    [Infinity, 20],
  ],
  headMul: 1.4,
  lowerMul: 0.9,
  pellets: 1,
  reach: 0,
  mag: 12,
  reserves: 48,
  reload: 1.15,
  emptyReload: 1.4,
  adsTime: 0.14,
  sprintOut: 0.1,
  swap: 0.25,
  move: 1.05,
  adsMove: 0.85,
  hip: [1.45, 1.95, 3.6],
  ads: [0.14, 0.38, 2.0],
  adsGate: 0,
  bloom: [0.22, 0.9, 5],
  kick: 1.05,
  kickYaw: 0.28,
  recoilRec: 10,
  adsKick: 0.8,
  pattern: [[1, 0.2], [1, -0.3], [1.05, 0.35], [1, -0.2]],
  punch: 0.55,
  adsFov: 61,
  scope: false,
  tracer: 420,
};

/** Melee (F / V). Not a slot weapon: the sim reads it directly for the swing. */
const KNIFE: WeaponDef = {
  id: "knife",
  name: "COMBAT KNIFE",
  short: "KNIFE",
  class: "MELEE",
  cls: "MELEE",
  fire: "melee",
  rpm: 110,
  dmg: [[Infinity, 135]],
  headMul: 1,
  lowerMul: 1,
  pellets: 1,
  reach: 1.9,
  mag: 0,
  reserves: 0,
  reload: 0,
  emptyReload: 0,
  adsTime: 0.1,
  sprintOut: 0.08,
  swap: 0.22,
  move: 1.05,
  adsMove: 1,
  hip: [0, 0, 0],
  ads: [0, 0, 0],
  adsGate: 0,
  bloom: [0, 0, 1],
  kick: 0,
  kickYaw: 0,
  recoilRec: 10,
  adsKick: 1,
  pattern: [[0, 0]],
  punch: 0,
  adsFov: HIP_FOV,
  scope: false,
  tracer: 0,
};

/** Slot weapons, primaries first. Order is the loadout screen's order. */
export const WEAPONS: WeaponDef[] = [AR, SMG, SNIPER, PISTOL, KNIFE];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w])) as Record<string, WeaponDef>;

/** The default primary — every caller that does not choose gets the AR. */
export const PRIMARY_WEAPON_ID = "ar";
export const SECONDARY_WEAPON_ID = "pistol";
export const PRIMARY_WEAPON: WeaponDef = AR;

/** Ids a player may carry in the primary slot. */
export const PRIMARY_WEAPON_IDS: readonly string[] = ["ar", "smg", "sniper"];

/** Base damage (before the zone multiplier) at `dist` metres. */
export function damageAt(w: WeaponDef, dist: number): number {
  for (const [r, d] of w.dmg) if (dist <= r) return d;
  return w.dmg[w.dmg.length - 1]![1];
}

/** The damage ONE bullet does, rounded, exactly as the sim applies it. */
export function bulletDamage(w: WeaponDef, dist: number, zone: "head" | "upper" | "lower"): number {
  const k = zone === "head" ? w.headMul : zone === "lower" ? w.lowerMul : 1;
  return Math.round(damageAt(w, dist) * k);
}

/** Shots to kill a 100 hp body at `dist` in `zone`. */
export function shotsToKill(w: WeaponDef, dist: number, zone: "head" | "upper" | "lower" = "upper"): number {
  const d = bulletDamage(w, dist, zone);
  return d > 0 ? Math.ceil(100 / d) : Infinity;
}

/** Trigger-time-to-kill, ms: (STK - 1) shot intervals. */
export function ttkMs(w: WeaponDef, dist = 0, zone: "head" | "upper" | "lower" = "upper"): number {
  const stk = shotsToKill(w, dist, zone);
  if (!Number.isFinite(stk)) return Infinity;
  return ((stk - 1) * 60000) / w.rpm;
}

/** Legacy: the range multiplier relative to the gun's close-range damage. */
export function rangeMul(w: WeaponDef, dist: number): number {
  return damageAt(w, dist) / w.dmg[0]![1];
}

export function shotInterval(w: WeaponDef): number {
  return 60 / w.rpm;
}

/** Reload duration the sim started for this magazine state. */
export function reloadTime(w: WeaponDef, ammoInMag: number): number {
  return ammoInMag <= 0 ? w.emptyReload : w.reload;
}
