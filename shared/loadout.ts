/**
 * LOADOUT CONTRACT — shared by the weapons stream (owns the numbers) and the UI
 * stream (renders the loadout screen from WEAPON_CARDS). See docs/nuketown/MISSION.md.
 *
 * A player carries one primary (AR / SMG / SNIPER), the pistol as secondary, and a
 * cookable frag. The chosen loadout is saved locally, sent with `join`, and a change
 * made mid-match applies at the player's next spawn (CoD rule).
 */
import { WEAPON_BY_ID, damageAt, type WeaponDef } from "./weapons";

export type PrimaryId = "ar" | "smg" | "sniper";
export type SecondaryId = "pistol";
export type LethalId = "frag";
export type LoadoutWeaponId = PrimaryId | SecondaryId;

export interface Loadout {
  primary: PrimaryId;
  secondary: SecondaryId;
  lethal: LethalId;
}

export const PRIMARY_IDS: readonly PrimaryId[] = ["ar", "smg", "sniper"];
export const DEFAULT_LOADOUT: Loadout = { primary: "ar", secondary: "pistol", lethal: "frag" };
export const LOADOUT_KEY = "shipment.loadout";

/** 0..100 bars for the loadout screen. Derived from the real stats by the weapons stream. */
export interface WeaponBars {
  damage: number;
  fireRate: number;
  range: number;
  accuracy: number;
  mobility: number;
  handling: number;
}

export interface WeaponCard {
  id: LoadoutWeaponId;
  slot: "primary" | "secondary";
  /** Display name, e.g. "KR-4 CAVENDISH". */
  name: string;
  /** Class label: "ASSAULT RIFLE" | "SUBMACHINE GUN" | "SNIPER RIFLE" | "PISTOL". */
  cls: string;
  /** One line, what it is for. */
  blurb: string;
  bars: WeaponBars;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const pct = (v: number): number => Math.round(100 * clamp01(v));

/**
 * THE BARS ARE ARITHMETIC ON shared/weapons.ts, never typed in. Each one is a
 * fixed formula over the sim's own stats, so a balance change moves the bar on
 * the next build and the screen can never disagree with the gun.
 *
 *   damage    body damage per bullet at close range, 40 = full bar
 *   fireRate  cyclic rpm / 1000
 *   range     where the close-range damage step ends (40 m = full) blended
 *             with how much of it survives at long range
 *   accuracy  aimed: the still ADS cone plus sustained recoil (deg/s of kick a
 *             held trigger puts into the aim)
 *   mobility  move speed multiplier (0.85..1.10) and aimed walk speed
 *   handling  ADS time, raise (swap) time and sprint-to-fire
 */
export function deriveBars(w: WeaponDef): WeaponBars {
  const close = damageAt(w, 0);
  const far = damageAt(w, 60);
  const step1 = w.dmg[0]![0];
  const auto = w.fire === "auto";
  // A semi/bolt gun's kick recovers between pulls: count it at the rate a
  // player can actually keep the sights on (half the cap for the pistol, one
  // per bolt for the sniper).
  const pullRate = auto ? w.rpm / 60 : w.fire === "semi" ? w.rpm / 120 : w.rpm / 60;
  const recoilPerSec = w.kick * w.adsKick * pullRate;
  return {
    damage: pct(close / 40),
    fireRate: pct(w.rpm / 1000),
    range: pct(0.6 * Math.min(1, step1 / 40) + 0.4 * (far / close)),
    accuracy: pct(1 - (w.ads[0] / 0.5) * 0.4 - (recoilPerSec / 12) * 0.6),
    mobility: pct(((w.move - 0.85) / 0.25) * 0.7 + ((w.adsMove - 0.5) / 0.4) * 0.3),
    handling: pct(1 - ((w.adsTime - 0.12) / 0.3) * 0.5 - ((w.swap - 0.2) / 0.5) * 0.25 - ((w.sprintOut - 0.08) / 0.25) * 0.25),
  };
}

function card(id: LoadoutWeaponId, slot: WeaponCard["slot"], blurb: string): WeaponCard {
  const w = WEAPON_BY_ID[id]!;
  return { id, slot, name: w.name, cls: w.cls, blurb, bars: deriveBars(w) };
}

export const WEAPON_CARDS: Record<LoadoutWeaponId, WeaponCard> = {
  ar: card("ar", "primary", "Versatile full-auto. Four to the chest out to 25 m — wins at every range if you hold the pull."),
  smg: card("smg", "primary", "Fastest kill inside 10 m and the quickest on its feet. Falls off past mid range."),
  sniper: card("sniper", "primary", "One shot to the upper body or head. Slow to aim, no free no-scopes — deadly once it settles."),
  pistol: card("pistol", "secondary", "Fast draw, three to the chest up close. Finish the fight when the mag runs dry."),
};

export function sanitizeLoadout(x: unknown): Loadout {
  const o = (x && typeof x === "object" ? x : {}) as Partial<Record<keyof Loadout, unknown>>;
  const primary = PRIMARY_IDS.includes(o.primary as PrimaryId) ? (o.primary as PrimaryId) : DEFAULT_LOADOUT.primary;
  return { primary, secondary: "pistol", lethal: "frag" };
}

export function readLoadout(): Loadout {
  try {
    return sanitizeLoadout(JSON.parse(globalThis.localStorage?.getItem(LOADOUT_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_LOADOUT };
  }
}

export function saveLoadout(l: Loadout): void {
  try {
    globalThis.localStorage?.setItem(LOADOUT_KEY, JSON.stringify(sanitizeLoadout(l)));
  } catch {
    /* private mode — the loadout still applies for this session via the join message */
  }
}
