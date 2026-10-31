/**
 * client/src/ui/labels.ts — player-facing words for things the sim names.
 *
 * The sim emits medal ids and weapon ids (shared/sim.ts, shared/weapons.ts —
 * the weapons stream's files). How they READ is the UI's business, so the
 * mapping lives here and the sim strings stay untouched. Tactical, plain,
 * CoD-register copy: no "MASHED", no "NANA".
 *
 * DOM-free: game.ts imports this on the kill path.
 */
import { WEAPON_BY_ID } from "@shared/weapons";
import { WEAPON_CARDS, type LoadoutWeaponId } from "@shared/loadout";

const MEDALS: Record<string, string> = {
  "MASHED BY NANA": "GRENADE KILL",
  KILL: "KILL",
  HEADSHOT: "HEADSHOT",
  COLLATERAL: "COLLATERAL",
  "FIRST BLOOD": "FIRST BLOOD",
  "TRIPLE KILL": "KILLSTREAK ×3",
  "FURY KILL": "KILLSTREAK ×5",
  RELENTLESS: "RELENTLESS",
  UNSTOPPABLE: "UNSTOPPABLE",
};

/** The medal callout for a sim medal id ("" stays ""). */
export function medalLabel(id: string): string {
  if (!id) return "";
  return MEDALS[id] ?? id.toUpperCase();
}

/** Display name for a weapon id, from the loadout cards first, then the weapon table. */
export function weaponName(id: string): string {
  const card = WEAPON_CARDS[id as LoadoutWeaponId];
  if (card) return card.name;
  const w = (WEAPON_BY_ID as Record<string, { name: string } | undefined>)[id];
  return w?.name ?? id.toUpperCase();
}

/**
 * HOW a kill happened. Full names for the killcam plate ("KILLED WITH
 * KR-4 CAVENDISH"); `short` gives the model designation ("KR-4") for the
 * killfeed, where CoD would draw an icon.
 */
export function killHow(weapon: string, self: boolean, short = false): string {
  if (self) return short ? "SELF" : "OWN GRENADE";
  if (weapon === "nade") return short ? "FRAG" : "FRAG GRENADE";
  if (weapon === "strike") return "ARTILLERY";
  // No kill is ever credited "nuke" any more (the blast is gone — the streak
  // grants a frag instead). The mapping stays so an old feed still renders;
  // same for weapon-icons.ts, accolades.ts and score-pops.ts, which keep
  // their "nuke" exclusions for the same reason.
  if (weapon === "nuke") return "TACTICAL NUKE";
  if (weapon === "melee" || weapon === "knife") return "MELEE";
  if (short) {
    const w = (WEAPON_BY_ID as Record<string, { short?: string } | undefined>)[weapon];
    if (w?.short) return w.short;
  }
  return weaponName(weapon);
}
