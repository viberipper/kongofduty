/**
 * client/src/cine/pose.ts — THE HERO POSE (authored, never a gameplay idle or the ADS stance).
 *
 * One pose, used by the intro's hero shot and the POTG / MVP studio card: the rifle carried at a
 * relaxed low-ready ACROSS the body (muzzle down and to the off side, both paws on it — the hands are
 * IK'd onto this hold by the actor exactly as onto any hold), the chest a touch open to the lens, the
 * head turned to the lens with the chin up. Face clear, gun clear, silhouette readable.
 *
 * The hold is in the actor's hold space (bruiser.ts HOLD): p is the grip relative to the neck in the
 * root frame (x right-negative, y up, z forward), yaw/elev/roll turn the gun (elev < 0 = muzzle down).
 */
import type { BruiserActor, HoldPose } from "../bruiser";

/** Rifle at low ready: stock under the arm, muzzle down and forward (side-on to a three-quarter lens, the whole gun reads). */
export const HERO_HOLD: HoldPose = { p: [-0.14, -0.3, 0.33], yaw: 0.35, elev: -0.7, roll: 0.2, follow: 0.55, rPole: [-0.4, -0.35, -0.2], lPole: [0.3, -0.5, 0.05], sup: 1, blade: -0.18 };
/** Pistol: two-handed, low and centred. */
export const HERO_PISTOL: HoldPose = { p: [-0.02, -0.34, 0.32], yaw: 0.25, elev: -0.7, roll: 0, follow: 0.5, rPole: [-0.3, -0.5, -0.15], lPole: [0.3, -0.5, -0.15], sup: 1, blade: -0.08 };

export type HeroAttitude = { twist: number; chest: number; look: number; chin: number; tilt: number };
export const HERO_ATTITUDE: HeroAttitude = { twist: 0.12, chest: 0.06, look: 0.55, chin: 0.1, tilt: 0.04 };

/**
 * Put `a` in the hero pose at weight w (0..1). `look` (rad) turns the head toward the lens — positive
 * to the actor's left. Call BEFORE the actor's apply() for the frame (the actor solves the hands onto it).
 */
export function heroPose(a: BruiserActor, w: number, look = HERO_ATTITUDE.look, breathT = 0): void {
  if (w <= 0.001) {
    a.hero = null;
    return;
  }
  const br = Math.sin(breathT * 1.6);
  // dev / authoring (qa/cine/card.mjs --variants): window.__heroPose overrides the hold and attitude
  const dev = (globalThis as unknown as { __heroPose?: { hold?: Partial<HoldPose>; att?: Partial<HeroAttitude> } }).__heroPose;
  const at = dev?.att ? { ...HERO_ATTITUDE, ...dev.att } : HERO_ATTITUDE;
  a.hero = {
    hold: dev?.hold ? { ...HERO_HOLD, ...dev.hold } : HERO_HOLD,
    pistol: HERO_PISTOL,
    w,
    twist: at.twist + 0.015 * br,
    chest: at.chest + 0.02 * br,
    look: dev?.att?.look ?? look,
    chin: at.chin,
    tilt: at.tilt,
  };
}
