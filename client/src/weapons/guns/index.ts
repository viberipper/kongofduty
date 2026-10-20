/**
 * GUN MODELS — one entry point for every weapon mesh in the game, first person
 * AND third person, so a gun looks like the same gun in your hands and in
 * everyone else's.
 *
 * CONVENTION (all metres, gun space):
 *   -Z forward (the bore points down -Z), +Y up, +X right,
 *   origin = the trigger hand's grip point (where the palm closes).
 *
 * `lod`: "fp" is the hero model the viewmodel draws a few cm from the eye;
 * "tp" is the light one mounted on every operator's hand (fewer segments, no
 * interior detail, merged per material).
 *
 * The anchors are what the rest of the game hangs off the model: hands
 * (grip/fore), the ADS sight line, muzzle flash + tracer origin (muzzle),
 * shell casings (eject), and the moving parts the reload/fire animations drive
 * (mag, bolt). Anything absent is null.
 *
 * NOTE: this file starts as a thin adapter over the W1 procedural builders in
 * client/src/viewmodel.ts; the viewmodel workstream replaces the internals with
 * the real tactical models. The exported API is the contract — keep it.
 */
import * as THREE from "three";

export type GunId = "ar" | "smg" | "sniper" | "pistol";

export type GunModel = {
  id: GunId;
  lod: "fp" | "tp";
  /** The whole gun, in gun space (see the convention above). */
  root: THREE.Group;
  /** Bore exit: flash, tracer origin. */
  muzzle: THREE.Vector3;
  /** Trigger-hand palm (normally the origin). */
  grip: THREE.Vector3;
  /** Support-hand anchor (handguard / foregrip / the pistol's off-hand cup). */
  fore: THREE.Vector3 | null;
  /** ADS sight line: the eye looks from `rear` through `front`. Optic: both on the optic axis. */
  sight: { front: THREE.Vector3; rear: THREE.Vector3 } | null;
  /** Ejection port: casings leave here, to +X. */
  eject: THREE.Vector3;
  /** Detachable magazine (reload). Its rest transform is userData.home. */
  mag: THREE.Object3D | null;
  /** Bolt / charging handle / slide (fire + reload). Rest transform in userData.home. */
  bolt: THREE.Object3D | null;
  /** Overall length, metres. */
  length: number;
};

const builders = new Map<string, (lod: "fp" | "tp") => GunModel>();

/** The viewmodel workstream registers the real builders here. */
export function registerGun(id: GunId, fn: (lod: "fp" | "tp") => GunModel): void {
  builders.set(id, fn);
}

/** A fresh model of `id` (each call is its own scene graph; geometry may be shared). */
export function buildGun(id: string, lod: "fp" | "tp"): GunModel {
  const fn = builders.get(id) ?? builders.get("ar");
  if (!fn) throw new Error(`no gun builder registered for "${id}"`);
  return fn(lod);
}

export function hasGun(id: string): boolean {
  return builders.has(id);
}
