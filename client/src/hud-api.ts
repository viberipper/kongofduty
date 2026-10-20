/**
 * HUD FEED CONTRACT — weapons/game code WRITES these each frame, the UI READS them in
 * its paint pass and decides how they look. Neither side imports the other's internals.
 * See docs/nuketown/MISSION.md. Keep the exported names and shapes stable; extend by
 * adding optional fields.
 */
import type { LoadoutWeaponId } from "../../shared/loadout";

export interface WeaponHud {
  /** 0 = primary, 1 = secondary. */
  slot: 0 | 1;
  id: LoadoutWeaponId;
  name: string;
  cls: string;
  ammo: number;
  mag: number;
  reserve: number;
  /** -1 when not reloading, else reload progress 0..1. */
  reloadFrac: number;
  /** The holstered weapon, for the two-slot readout. */
  other: { id: LoadoutWeaponId; name: string; ammo: number; reserve: number } | null;
  /** Current spread as a crosshair gap in CSS px (bloom/move/ADS already applied). */
  spreadPx: number;
  /** 0..1 aim-down-sights blend. */
  ads: number;
  /** Sniper scope overlay is up: hide the crosshair, show the scope. */
  scoped: boolean;
}

export interface LethalHud {
  count: number;
  max: number;
  /** True while the pin is pulled and the fuse is burning in hand. */
  cooking: boolean;
  /** Seconds left on the fuse while cooking (fuseMax when not cooking). */
  fuseLeft: number;
  fuseMax: number;
}

export interface HudFeed {
  weapon: WeaponHud | null;
  lethal: LethalHud | null;
}

const feed: HudFeed = { weapon: null, lethal: null };

export function setWeaponHud(w: WeaponHud | null): void {
  feed.weapon = w;
}

export function setLethalHud(l: LethalHud | null): void {
  feed.lethal = l;
}

export function readHudFeed(): Readonly<HudFeed> {
  return feed;
}
