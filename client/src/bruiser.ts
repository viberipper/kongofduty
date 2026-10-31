import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import type { PlayerSnap } from "@shared/protocol";
import { activeSolids, type OBB } from "@shared/map";
import { activeMap } from "@shared/maps";
import { attachAstronaut, type AstronautRig } from "./astronaut";
import { fistCentroidLocal, leanToward, setBoneWorldQ, solveTwoBone, stripLauncher, swivelElbowIn, tpGun, tpGunProto, type TpGunProto } from "./tp-gun";
import { LEAN_LEFT, LEAN_LEFT_CROUCH, LEAN_RIGHT, LEAN_RIGHT_CROUCH, type LeanBone } from "./lean-pose";
import { WEAPON_BY_ID } from "@shared/weapons";
import { prefs, teamColors } from "./ui/prefs";
import { gridFor, gridQueryCircle } from "@shared/solidgrid";
import { RADIUS } from "@shared/sim";
import { loadNadeAsset } from "./fx";
import { assetUrl } from "./asset-base";

/**
 * The SEED pose for both arms: the bench-tuned firing pose of the old one-handed
 * launcher. It no longer decides where a hand ends up — the weapon hold below
 * solves both arms onto the gun every frame — but the IK takes the smallest arc
 * from it, so it still decides how each limb is ROLLED (elbow out, paw upright).
 */
const REST_AIM = {
  uy: 0, ux: 1.15, uz: 0.32, fx: -0.18,
  ly: -0.6, lx: -0.4, lz: -1.6, lfx: 0.2, lfz: -0.8,
};

const HEIGHT = 1.78; // world meters, matches STAND_H-ish hitbox

// --------------------------------------------------------- THE WEAPON HOLD --
//
// THE GUN IS PLACED FIRST AND THE ARMS ARE SOLVED ONTO IT. Every operator holds
// the real model of the weapon in their snapshot (tp-gun.ts, one per id), and
// where that gun sits is authored HERE, in metres, relative to the body: the
// trigger hand is two-bone IK'd onto the grip with the paw turned so the fist
// closes around it, and the support hand onto the handguard (or, for the
// pistol, cupped under the firing hand). Nothing is eyeballed bone radians.
//
// Poses live in the BODY frame: origin at the neck base (NeckTwist01), x to the
// operator's LEFT, y up, z forward — the actor root's own axes, optionally
// riding `follow` of the chest's live rotation relative to idle (the ape run
// pitches the torso far forward and a carried gun goes with it).
//
//   p      grip (trigger-hand palm) position, metres from the neck base
//   yaw    bore turned toward the operator's left (rad)
//   elev   bore raised (rad, + up)
//   roll   bore rolled (rad, + = top of the gun toward the operator's right)
//   rPole  / lPole  where each elbow bends toward, offset from its shoulder
//   sup    support hand on the gun (0..1)
//   blade  body yaw (rad, - = left shoulder forward): a rifleman stands bladed
//
// The AIM pose is different in kind: the bore is the player's actual aim ray
// (yaw and pitch), so a 3P flash and tracer leave a barrel pointing where the
// round goes. The stock's butt sits in the shoulder pocket (`pocket`, body
// frame, rotated about the shoulder by the aim pitch); the pistol has no stock
// and is pushed out to `pocket` on straightened arms instead.
//
// THE SILHOUETTE RULES STILL HOLD (see the limb budget below): carried guns sit
// up across the chest (forward reach is what the hit capsule cannot cover), and
// the budget gets the last word on every frame.
type V3 = [number, number, number];
type HoldPose = { p: V3; yaw: number; elev: number; roll: number; follow: number; rPole: V3; lPole: V3; sup: number; blade: number; fk?: boolean };
type HoldFrame = { p: THREE.Vector3; q: THREE.Quaternion; r: THREE.Vector3; l: THREE.Vector3; sup: number; blade: number };
type AimHold = { pocket: V3; drop: number; rPole: V3; lPole: V3; sup: number; blade: number };
type HoldSet = { ready: HoldPose; sprint: HoldPose; low: HoldPose; one: HoldPose; reload: HoldPose; lift: HoldPose; aim: AimHold };

const HOLD: Record<"long" | "pistol", HoldSet> = {
  long: {
    // chest ready: stock in the shoulder, muzzle down the lane and a little low
    ready: { p: [-0.17, -0.1, 0.34], yaw: 0.22, elev: -0.12, roll: 0, follow: 0.5, rPole: [-0.35, -0.4, -0.15], lPole: [0.2, -0.55, 0], sup: 1, blade: -0.28 },
    // sprint: the tac-sprint flip — one paw, gun up beside the head, muzzle to
    // the sky; the off arm runs free (the ape gait needs it). The grip rides
    // HIGH on purpose: the run hunches the shoulders down to 1.1 m, and a gun
    // held lower hangs its stock through the hip band qa/planted.mjs gates
    // (crosshair-row p95 0.321 m with the grip 0.2 m lower; 0.255 m here vs the
    // old launcher carry's 0.274 m; a forward-canted carry failed the chest band).
    // KNOWN: the arm is tightly folded here, so on some strides the limb budget
    // still swings the elbow in (mean 0.19 rad of gun turn over a run).
    sprint: { p: [-0.21, 0.04, 0.1], yaw: 0.1, elev: 1.2, roll: -0.4, follow: 0.3, rPole: [-0.45, -0.25, -0.3], lPole: [0.25, -0.5, 0], sup: 0, blade: 0 },
    // swap: the gun drops to the right hip, muzzle down
    low: { p: [-0.26, -0.5, 0.2], yaw: -0.2, elev: -1.05, roll: 0, follow: 0.5, rPole: [-0.3, -0.3, -0.2], lPole: [0.25, -0.5, 0], sup: 0, blade: -0.1 },
    // frag out: the trigger hand alone, gun canted down to the right
    one: { p: [-0.26, -0.4, 0.26], yaw: -0.15, elev: -0.6, roll: 0, follow: 0.5, rPole: [-0.3, -0.35, -0.2], lPole: [0.25, -0.5, 0], sup: 0, blade: -0.1 },
    reload: { p: [-0.12, -0.26, 0.32], yaw: 0.35, elev: 0.12, roll: 0.75, follow: 0.6, rPole: [-0.3, -0.45, -0.15], lPole: [0.25, -0.5, 0], sup: 1, blade: -0.28 },
    // wall lift: up across the chest, muzzle past the left ear, both paws on
    lift: { p: [-0.14, -0.16, 0.22], yaw: 0.55, elev: 1.15, roll: -0.35, follow: 0.6, rPole: [0.0, -0.5, -0.2], lPole: [0.2, -0.55, 0], sup: 1, blade: -0.1 },
    aim: { pocket: [-0.16, -0.02, 0.16], drop: 0.02, rPole: [-0.45, -0.25, -0.1], lPole: [0.15, -0.55, 0.1], sup: 1, blade: -0.45 },
  },
  pistol: {
    // two-hand low ready, muzzle down the lane
    ready: { p: [-0.07, -0.19, 0.42], yaw: 0, elev: -0.38, roll: 0, follow: 0.5, rPole: [-0.3, -0.5, -0.15], lPole: [0.3, -0.5, -0.15], sup: 1, blade: -0.1 },
    // sprint: one hand, pistol up by the shoulder
    // sprint: the old run key in FK (see SPRINT_CARRY) — a pistol is short
    // enough to ride it inside the gun's own budget
    sprint: { p: [-0.2, 0.02, 0.12], yaw: 0.1, elev: 1.15, roll: -0.3, follow: 0.3, rPole: [-0.45, -0.25, -0.3], lPole: [0.25, -0.5, 0], sup: 0, blade: 0, fk: true },
    low: { p: [-0.24, -0.5, 0.2], yaw: -0.1, elev: -1.2, roll: 0, follow: 0.5, rPole: [-0.3, -0.3, -0.2], lPole: [0.25, -0.5, 0], sup: 0, blade: 0 },
    one: { p: [-0.24, -0.4, 0.28], yaw: 0, elev: -0.6, roll: 0, follow: 0.5, rPole: [-0.3, -0.35, -0.2], lPole: [0.25, -0.5, 0], sup: 0, blade: 0 },
    reload: { p: [-0.08, -0.24, 0.38], yaw: 0.2, elev: 0.25, roll: 0.5, follow: 0.5, rPole: [-0.25, -0.5, -0.15], lPole: [0.25, -0.5, -0.1], sup: 1, blade: -0.1 },
    // wall lift: pistol tucked up at the chest, muzzle to the sky ("high compressed ready")
    lift: { p: [-0.1, -0.2, 0.2], yaw: 0, elev: 1.2, roll: 0, follow: 0.6, rPole: [0.0, -0.5, -0.2], lPole: [0.25, -0.5, -0.1], sup: 1, blade: 0 },
    // isosceles: both arms out, the gun on the centre line under the eyes
    aim: { pocket: [-0.06, 0.04, 0.6], drop: 0, rPole: [-0.3, -0.5, -0.1], lPole: [0.3, -0.5, -0.1], sup: 1, blade: -0.12 },
  },
};
/** Where the support fist closes, in gun space, relative to the model's `fore` anchor. */
const SUPPORT_OFF: Record<"long" | "pistol", V3> = { long: [-0.012, -0.04, 0], pistol: [-0.03, -0.035, 0.02] };
/** Fractions along the barrel the wall lift tests (the crown last). */
const LIFT_SAMPLES = [0.35, 0.7, 1];
/** Per-shot gun kick: metres back along the bore, radians of muzzle climb. */
const KICK: Record<string, [number, number]> = { ar: [0.035, 0.07], smg: [0.025, 0.05], sniper: [0.07, 0.17], pistol: [0.03, 0.22] };
// Live-tunable from the capture harness (qa/tp-weapons.mjs): the tables are read every frame.
(globalThis as unknown as { __tpHold?: unknown }).__tpHold = { HOLD, SUPPORT_OFF, KICK };

// --------------------------------------------------------------- THE THROW, 3P
//
// A procedural overhand on the LEFT arm — the right paw never lets go of the
// Bunch Cylinder, which is what the carry pose already sells. One phase value
// (`throwP`, 0..1) drives the whole swing:
//
//   0.00 → 0.55  wind-up: the frag comes up and cocks behind the ear.
//                Driven by the replicated `nadeUp` flag, so the swing has
//                already started before the throw command exists.
//   0.55         COCKED. Held here for as long as the thrower holds.
//   0.55 → 1.00  release + follow-through, run at a fixed rate the moment the
//                "nade" event lands.
//
// The frag mesh is a child of L_Hand and is hidden on the release frame, which
// is the same frame the sim spawns the world grenade — the handoff is exact by
// construction, not by tuning.
/** Phase at which the arm is fully cocked (and where a hold parks). */
const THROW_COCK = 0.55;
/** Phase at which the frag leaves the paw (peak extension). */
const THROW_RELEASE = 0.66;
/** Seconds for the wind-up half. */
const THROW_WIND_T = 0.3;
/**
 * Seconds for the release + follow-through half of the phase range. Only 0.45
 * of the range is left after the cock, so the whip itself runs in 0.45 * this —
 * 0.19 s, which is a real overhand's follow-through and long enough for an
 * observer at 12 m to actually see the arm come over.
 */
const THROW_SWING_T = 0.42;

/**
 * Left-arm keyframes, in raw additive bone radians.
 *
 * MEASURED, not guessed. The Bruiser's bind pose faces +X and its arms are
 * mirrored, so the left arm does NOT share the right arm's axes (REST_AIM lifts
 * the right arm on X and the left on Z). Sweeping each bone axis and reading
 * L_Hand back in holder space gives, for the LEFT upper arm:
 *
 *   rotateZ(+)  pure LIFT          (+1.0 rad raises the hand 0.51 m)
 *   rotateX(+)  FORWARD and up     (+1.0 rad: 0.39 m forward, 0.18 m up)
 *   rotateY(-)  BACKWARD           (-1.0 rad: 0.20 m back)
 * and for the forearm, rotateZ(+) lifts the hand while rotateX(+) sends it out.
 *
 * The overhand is therefore: lift on Z, cock back on -Y, and unload on +X.
 */
type ThrowPose = { ux: number; uy: number; uz: number; fx: number; fz: number; sp: number };
const THROW_KEYS: { at: number; p: ThrowPose }[] = [
  // arm down at the side (blend-in point)
  { at: 0, p: { ux: 0, uy: 0, uz: 0, fx: 0, fz: 0, sp: 0 } },
  // frag comes up past the chest
  { at: 0.3, p: { ux: -0.05, uy: -0.15, uz: 0.9, fx: 0, fz: 0.7, sp: 0.12 } },
  // COCKED: hand high and behind the ear, shoulders wound up
  { at: THROW_COCK, p: { ux: -0.15, uy: -0.7, uz: 1.45, fx: 0, fz: 1.35, sp: 0.34 } },
  // peak extension, arm out over the head — the frag is gone from here on
  { at: THROW_RELEASE, p: { ux: 1.5, uy: 0.15, uz: 1.15, fx: 0.15, fz: 0.25, sp: -0.18 } },
  // follow-through, sweeping down and across the CHEST. It used to carry
  // uy 0.45 / uz 0.35, which swept the paw across the Bruiser's own chin — and
  // the head is the thing an opponent is reading at 12 m. Lower and shorter
  // keeps the whip and gives the face back.
  { at: 0.85, p: { ux: 1, uy: 0.3, uz: 0.18, fx: 0.1, fz: 0.1, sp: -0.32 } },
  { at: 1, p: { ux: 0.1, uy: 0.05, uz: 0.05, fx: 0, fz: 0, sp: -0.04 } },
];

function throwPoseAt(t: number, out: ThrowPose): ThrowPose {
  let a = THROW_KEYS[0]!;
  let b = THROW_KEYS[THROW_KEYS.length - 1]!;
  for (let i = 0; i < THROW_KEYS.length - 1; i++) {
    if (t >= THROW_KEYS[i]!.at && t <= THROW_KEYS[i + 1]!.at) {
      a = THROW_KEYS[i]!;
      b = THROW_KEYS[i + 1]!;
      break;
    }
  }
  const span = Math.max(1e-4, b.at - a.at);
  const k = THREE.MathUtils.clamp((t - a.at) / span, 0, 1);
  // Smoothstep between keys: the whip must not read as linear interpolation.
  const s = k * k * (3 - 2 * k);
  out.ux = a.p.ux + (b.p.ux - a.p.ux) * s;
  out.uy = a.p.uy + (b.p.uy - a.p.uy) * s;
  out.uz = a.p.uz + (b.p.uz - a.p.uz) * s;
  out.fx = a.p.fx + (b.p.fx - a.p.fx) * s;
  out.fz = a.p.fz + (b.p.fz - a.p.fz) * s;
  out.sp = a.p.sp + (b.p.sp - a.p.sp) * s;
  return out;
}

/**
 * How the frag sits in the calibrated grip frame.
 *
 * The prop is the tactical M67 (fx.ts loadNadeAsset — WeaponFx's frag, pin and
 * spoon on: origin at the body centre, +Y the fuze, the spoon down +X). The paw
 * is a CLOSED fist with no open grip to nestle it into, so the frag is held AT
 * the fingers: pushed `GRIP_OUT_M` past the fist centre along the measured
 * out-of-wrist axis with its fuze pointing out of the knuckles — the body half
 * in the curl, the fuze, spoon and pull ring clear of it, which is what reads as
 * a grenade in a fist rather than a dot on a knuckle. `GRIP_TILT` leans it
 * across the fist so the spoon side faces out of the throwing arc.
 *
 * Drawn `NADE_TP_SCALE` x true size, like the third-person guns (tp-gun.ts
 * TP_SCALE): a 9 cm frag in an ape's paw is invisible at 12 m. game.ts hands
 * that apparent size to NadeFx as the thrown frag's birth scale, so the world
 * frag leaves the paw at the size it was drawn.
 */
const GRIP_OUT_M = 0.092;
/** Lean of the fuze axis off the out-of-fist axis, toward the fist's cross axis (rad). */
const GRIP_TILT = 0.45;
/** Third-person frag draw scale (see the guns' TP_SCALE). */
export const NADE_TP_SCALE = 1.45;

let nadePropGeo: THREE.BufferGeometry | null = null;
let nadePropMat: THREE.Material | null = null;
void loadNadeAsset().then(({ geo, mat }) => {
  nadePropGeo = geo;
  nadePropMat = mat;
});

/**
 * THE RUN CARRY IS FK, NOT IK. The ape run hunches the torso ~70 deg forward
 * and drops the shoulders to 1.1 m, and every IK'd carry tried there either hung
 * the gun's stock through the hip band qa/planted.mjs gates or swung the elbow
 * past the limb budget mid-stride. The old launcher's run key had already been
 * searched against exactly those gates (fist at the sternum, muzzle up past the
 * left shoulder — see git history for the search), and the gun rides the fist
 * on the launcher's own bore axis, so the arm keeps that key and the gun simply
 * follows it: one-handed port arms, the off arm free for the gait.
 */
const SPRINT_CARRY = { ux: 2.2, uy: -0.6, uz: 2, fx: -0.9, fz: -2, hz: 0.06 };

function applyCarryStatic(bones: Record<string, THREE.Object3D>, bind: Record<string, THREE.Quaternion>, c: typeof SPRINT_CARRY): void {
  for (const n of CARRY_BONES) if (bind[n] && bones[n]) bones[n]!.quaternion.copy(bind[n]!);
  bones.R_Clavicle?.rotateZ(0.05);
  // ORDER IS THE POSE: intrinsic rotations composed onto bind, Y then X then Z.
  bones.R_Upperarm?.rotateY(c.uy);
  bones.R_Upperarm?.rotateX(c.ux);
  bones.R_Upperarm?.rotateZ(c.uz);
  bones.R_Forearm?.rotateX(c.fx);
  bones.R_Forearm?.rotateZ(c.fz);
  (bones.R_Hand as THREE.Bone | undefined)?.rotateZ(c.hz);
}

/** The trigger arm: re-seeded and solved onto the grip every frame. */
const CARRY_BONES = ["R_Clavicle", "R_Upperarm", "R_Forearm", "R_Hand"];
/** The support arm, solved onto the handguard (blended by the hold's `sup`). */
const SUPPORT_BONES = ["L_Clavicle", "L_Upperarm", "L_Forearm", "L_Hand"];

/** feel stream: marker sizes as a fraction of the view height (≈ 13 px chevron / 24 px tag at 1080p), and the enemy fade. */
const MARK_CHEV = 0.012;
const MARK_TAG = 0.024;
const MARK_FADE_MS = 300;

/** One chevron per colour (the colour-vision mode can change the pair mid-match). */
const chevTex = new Map<string, THREE.Texture>();

function chevronTexture(ally: boolean): THREE.Texture {
  const tc = teamColors();
  const col = ally ? tc.ally : tc.enemy;
  const cached = chevTex.get(col);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.translate(32, 30);
  ctx.beginPath();
  ctx.moveTo(-20, -14);
  ctx.lineTo(20, -14);
  ctx.lineTo(0, 18);
  ctx.closePath();
  ctx.fillStyle = col; // UI stream: CoD relative colours (ui/tokens.css --c-ally / --c-enemy; per colour-vision mode)
  ctx.strokeStyle = "rgba(10,10,12,0.9)";
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  chevTex.set(col, t);
  return t;
}

/**
 * TEAM SHORTS. The authored Kong wears red trunks, baked into the GLB's single
 * base-colour texture (there is no shorts mesh or material — the red islands in
 * the texture ARE the garment, belt loops and cargo pockets included). Allies
 * wear the ally colour instead: a per-ally-colour texture variant built once
 * from the template map — red texels hue-shifted to the team colour, shading
 * kept — and swapped per actor in setRelation. Enemies keep the authored map.
 * One variant per (source texture, ally hex), cached; actors only swap the map
 * reference, so no actor ever repaints another. FFA needs no special case: the
 * only ally there is the local player, who has no 3P actor in live play
 * (game.ts), so every visible body stays red.
 */
const shortsVariants = new WeakMap<THREE.Texture, Map<string, THREE.Texture>>();

/** sRGB 0..255 test for "authored shorts red". Tuned off the shipped texture:
 * shorts texels sit at r 70..115, g 16..42, b 0..8; yellow fur always carries
 * far more green, brown fur and skin fail the dominance gaps. */
function isShortsTexel(r: number, g: number, b: number): boolean {
  return r >= 60 && g <= 60 && b <= 25 && r - g >= 40 && r - b >= 50;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

function shortsTextureFor(map: THREE.Texture, allyHex: string): THREE.Texture {
  let perMap = shortsVariants.get(map);
  if (!perMap) {
    perMap = new Map();
    shortsVariants.set(map, perMap);
  }
  const hit = perMap.get(allyHex);
  if (hit) return hit;
  // The variant starts as an exact copy; only classified texels change.
  const src = map.image as unknown as { width: number; height: number } | null;
  if (!src || !src.width || !src.height) return map;
  const w = src.width;
  const h = src.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(map.image as unknown as CanvasImageSource, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // Pass 1: classify. Pass 2 drops speckle components (< 25 px): painted seam
  // strokes on the fur classify too, and a 1 px blue scratch on yellow fur is
  // the only visible artefact this whole feature can produce. The flood fill
  // uses 8-neighbourhood so diagonally bridged shorts islands (belt loops,
  // pocket edges) stay one component instead of shattering into speckle.
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (isShortsTexel(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!)) mask[i] = 1;
  }
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    const comp: number[] = [];
    while (stack.length) {
      const j = stack.pop()!;
      comp.push(j);
      const x = j % w;
      const y = (j / w) | 0;
      const hasL = x > 0;
      const hasR = x < w - 1;
      const hasU = y > 0;
      const hasD = y < h - 1;
      if (hasL && mask[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
      if (hasR && mask[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
      if (hasU && mask[j - w] && !seen[j - w]) { seen[j - w] = 1; stack.push(j - w); }
      if (hasD && mask[j + w] && !seen[j + w]) { seen[j + w] = 1; stack.push(j + w); }
      if (hasL && hasU && mask[j - w - 1] && !seen[j - w - 1]) { seen[j - w - 1] = 1; stack.push(j - w - 1); }
      if (hasR && hasU && mask[j - w + 1] && !seen[j - w + 1]) { seen[j - w + 1] = 1; stack.push(j - w + 1); }
      if (hasL && hasD && mask[j + w - 1] && !seen[j + w - 1]) { seen[j + w - 1] = 1; stack.push(j + w - 1); }
      if (hasR && hasD && mask[j + w + 1] && !seen[j + w + 1]) { seen[j + w + 1] = 1; stack.push(j + w + 1); }
    }
    if (comp.length < 25) for (const j of comp) mask[j] = 0;
  }
  // Target hue/saturation off the ally hex; per-texel VALUE keeps the folds.
  // Guarded: an unexpected format keeps the authored red instead of NaN-black.
  let th = 0;
  let ts = 1;
  try {
    const parsed = new THREE.Color(allyHex);
    if (/^#[0-9a-fA-F]{6}$/.test(allyHex) && Number.isFinite(parsed.r) && Number.isFinite(parsed.g) && Number.isFinite(parsed.b)) {
      [th, ts] = rgbToHsv(parsed.r, parsed.g, parsed.b);
    }
  } catch {
    /* keep default red */
  }
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const [, , v] = rgbToHsv(d[i * 4]! / 255, d[i * 4 + 1]! / 255, d[i * 4 + 2]! / 255);
    const [nr, ng, nb] = hsvToRgb(th, ts, v);
    d[i * 4] = Math.round(nr * 255);
    d[i * 4 + 1] = Math.round(ng * 255);
    d[i * 4 + 2] = Math.round(nb * 255);
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = map.colorSpace;
  t.wrapS = map.wrapS;
  t.wrapT = map.wrapT;
  t.repeat.copy(map.repeat);
  t.offset.copy(map.offset);
  t.anisotropy = map.anisotropy;
  t.minFilter = map.minFilter;
  t.magFilter = map.magFilter;
  t.generateMipmaps = map.generateMipmaps;
  t.flipY = map.flipY;
  t.mapping = map.mapping;
  perMap.set(allyHex, t);
  return t;
}

/**
 * Per-actor name tag (allies only). One canvas per actor — names differ — but
 * built once at construction, never per frame.
 */
function nameTexture(name: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 56;
  paintName(c, name);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.userData.actorName = true;
  return t;
}

function paintName(c: HTMLCanvasElement, name: string, ally = true): void {
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = '700 38px "Barlow Condensed", Arial, sans-serif'; // UI stream: the HUD display face
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(6,8,10,0.75)";
  // UI stream: allies are blue, enemies red (ui/tokens.css --c-ally / --c-enemy) — feel stream: enemy names exist now
  ctx.fillStyle = ally ? teamColors().ally : teamColors().enemy;
  const txt = (name || "").slice(0, 14).toUpperCase();
  ctx.strokeText(txt, 128, 30);
  ctx.fillText(txt, 128, 30);
}

export type BruiserTemplate = {
  scene: THREE.Group;
  clips: Map<string, THREE.AnimationClip>;
  scale: number;
  yOff: number;
  xOff: number;
  zOff: number;
  muzzleLocal: THREE.Vector3; // in R_Hand space
  fireDirLocal: THREE.Vector3; // in R_Hand space
  exitLocal: THREE.Vector3; // bench-corrected barrel exit, in R_Hand space
  flashLocal: THREE.Vector3; // bore-centered flash anchor, in R_Hand space
  /** L_Hand-child matrix that lands on the RENDERED fist (see calibrateGrip). */
  gripLocal: THREE.Matrix4;
  /** Unit "out of the wrist, past the knuckles" direction, in grip space. */
  gripOut: THREE.Vector3;
  /** Per-gait-clip cycle-mean bone pose — the pivot the stride amplifier swings about. */
  gaitMid: Record<string, Record<string, THREE.Quaternion>>;
  /** Drawn-surface samples the joint budget cannot see (see calibrateHull). */
  hull: HullPoint[];
  /**
   * THE GUN MOUNT, in R_Hand's local frame: gun space (metres, -Z bore, +Y up,
   * origin = the trigger-hand palm) lands with its origin in the measured fist
   * and its bore on the axis the asset's own launcher grip was sculpted around.
   * `unit` is hand-local units per metre.
   */
  gunMount: { fist: THREE.Vector3; basis: THREE.Quaternion; unit: number };
};

/**
 * The average pose a cyclic clip holds over its whole cycle, per bone.
 *
 * Read straight off the quaternion tracks: sign-align every key to the first
 * (q and -q are the same rotation, and a raw sum of mixed signs collapses),
 * sum, normalise. Uniform-in-key rather than uniform-in-time, which is the same
 * thing for these baked clips.
 */
function clipMidPose(clip: THREE.AnimationClip, names: string[]): Record<string, THREE.Quaternion> {
  const out: Record<string, THREE.Quaternion> = {};
  for (const t of clip.tracks) {
    if (!t.name.endsWith(".quaternion")) continue;
    const bone = t.name.slice(0, -".quaternion".length);
    if (!names.includes(bone)) continue;
    const v = t.values;
    const n = Math.floor(v.length / 4);
    if (!n) continue;
    let ax = 0, ay = 0, az = 0, aw = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const s = v[o]! * v[0]! + v[o + 1]! * v[1]! + v[o + 2]! * v[2]! + v[o + 3]! * v[3]! < 0 ? -1 : 1;
      ax += v[o]! * s;
      ay += v[o + 1]! * s;
      az += v[o + 2]! * s;
      aw += v[o + 3]! * s;
    }
    out[bone] = new THREE.Quaternion(ax, ay, az, aw).normalize();
  }
  return out;
}

/** No NaN/Infinity may reach the scene graph — one bad frame poisons every child. */
function qFinite(q: THREE.Quaternion): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);
}

/**
 * Ceiling on how far from its cycle mean the amplifier may push a bone, as a
 * quaternion HALF-angle: 1.5 rad of half-angle is 171.9 deg of real rotation.
 *
 * slerp past t = 1 keeps walking the same great circle, which is exactly what
 * "swing the same way, further" means for a rotation — but only while the result
 * stays inside a half turn. Past 180 deg the shortest arc REVERSES (q and -q are
 * the same rotation), so the next frame reads the deviation as pointing the other
 * way and amplifies it back out through the pole: the leg stops striding and
 * starts spinning. Bounding the factor keeps every extrapolation on the near side
 * of that pole. It is inert in normal play — no gait clip takes a leg bone more
 * than ~90 deg off its own cycle mean, and the bound only engages past that.
 */
const AMP_HALF_MAX = 1.5;

/** Re-scale a bone's deviation from its cycle mean (amp > 1 exaggerates, < 1 tames). */
function amplifyFromMid(b: THREE.Object3D, mid: THREE.Quaternion, amp: number, tmp: THREE.Quaternion): void {
  if (!Number.isFinite(amp) || Math.abs(amp - 1) < 1e-3) return;
  tmp.copy(b.quaternion);
  if (!qFinite(tmp)) return;
  // Shortest-arc half-angle from the cycle mean to the live pose. |dot| folds q
  // and -q onto the same rotation, which is the branch slerp() itself takes.
  const half = Math.acos(THREE.MathUtils.clamp(Math.abs(mid.dot(tmp)), 0, 1));
  const k = half > 1e-4 ? Math.min(amp, AMP_HALF_MAX / half) : amp;
  if (Math.abs(k - 1) < 1e-3) return;
  b.quaternion.copy(mid).slerp(tmp, k);
  if (!qFinite(b.quaternion)) b.quaternion.copy(tmp);
}

let template: BruiserTemplate | null = null;

function collectBones(root: THREE.Object3D): Record<string, THREE.Object3D> {
  const map: Record<string, THREE.Object3D> = {};
  root.traverse((o) => {
    const skinned = o as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) for (const b of skinned.skeleton.bones) map[b.name] = b;
    if ((o as THREE.Bone).isBone) map[o.name] = o;
  });
  return map;
}

function posedBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    const pos = m.geometry.attributes.position;
    if (m.isSkinnedMesh && typeof m.applyBoneTransform === "function") {
      m.skeleton?.update();
      for (let i = 0; i < pos.count; i += 7) {
        v.fromBufferAttribute(pos as THREE.BufferAttribute, i);
        m.applyBoneTransform(i, v);
        v.applyMatrix4(m.matrixWorld);
        box.expandByPoint(v);
      }
    } else {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
    }
  });
  return box;
}

function applyAimStatic(bones: Record<string, THREE.Object3D>, bind: Record<string, THREE.Quaternion>): void {
  for (const [name, b] of Object.entries(bones)) if (bind[name]) b.quaternion.copy(bind[name]!);
  const A = REST_AIM;
  bones.R_Clavicle?.rotateZ(0.08);
  bones.R_Upperarm?.rotateY(A.uy + tune().armYawFix);
  bones.R_Upperarm?.rotateX(A.ux);
  bones.R_Upperarm?.rotateZ(A.uz);
  bones.R_Forearm?.rotateX(A.fx);
  bones.L_Upperarm?.rotateY(A.ly);
  bones.L_Upperarm?.rotateX(A.lx);
  bones.L_Upperarm?.rotateZ(A.lz);
  bones.L_Forearm?.rotateX(A.lfx);
  bones.L_Forearm?.rotateZ(A.lfz);
  (bones.L_Hand as THREE.Bone | undefined)?.rotateZ(-0.06);
  (bones.R_Hand as THREE.Bone | undefined)?.rotateZ(0.08);
  bones.Spine02?.rotateY(-0.06);
  bones.Head?.rotateY(-0.04);
}

const LEAN_EULER = new THREE.Euler();
const LEAN_TMP_Q = new THREE.Quaternion();
/** Deduped bone names of the lean tables, built once (the tables are static). */
const LEAN_NAMES_RIGHT: readonly string[] = [...new Set([...Object.keys(LEAN_RIGHT), ...Object.keys(LEAN_RIGHT_CROUCH)])];
const LEAN_NAMES_LEFT: readonly string[] = [...new Set([...Object.keys(LEAN_LEFT), ...Object.keys(LEAN_LEFT_CROUCH)])];

/**
 * Layer the authored corner-lean pose onto the pose the mixer just wrote.
 *
 * The table comes from Blender (see lean-pose.ts): pelvis slide, legs solved by
 * a two-bone IK so the feet stay planted, spine rolled into the lean and the
 * head counter-rolled level. Rotations post-multiply, which is bone-local — the
 * same space Blender's `matrix_basis` lives in — and the slide is in the
 * parent bone's rest axes (what `Bone.position` uses).
 *
 * `w` is the eased lean weight, negative for the operator's left. `crouch`
 * (0..1) blends per bone between the standing table and the crouch correction
 * table, which is authored relative to the crouched base — the game's own
 * crouch pose (hip drop, bent knees, hunch) is still applied separately BEFORE
 * this runs, so it is never double-applied. At crouch = 0/1 the blend is
 * bit-identical to the respective table.
 */
function applyLeanPose(bones: Record<string, THREE.Object3D>, w: number, crouch: number): void {
  const s = Math.abs(w);
  if (!(s > 0.004)) return;
  const c = THREE.MathUtils.clamp(crouch, 0, 1);
  const stand: Record<string, LeanBone> = w > 0 ? LEAN_RIGHT : LEAN_LEFT;
  const crouched: Record<string, LeanBone> = w > 0 ? LEAN_RIGHT_CROUCH : LEAN_LEFT_CROUCH;
  const names = w > 0 ? LEAN_NAMES_RIGHT : LEAN_NAMES_LEFT;
  for (const name of names) {
    const a = stand[name];
    const b = crouched[name];
    const bObj = bones[name];
    if (!bObj) continue;
    let bx: number;
    let by: number;
    let bz: number;
    let lx: number;
    let ly: number;
    let lz: number;
    if (c <= 0) {
      bx = a?.rot[0] ?? 0;
      by = a?.rot[1] ?? 0;
      bz = a?.rot[2] ?? 0;
      lx = a?.loc[0] ?? 0;
      ly = a?.loc[1] ?? 0;
      lz = a?.loc[2] ?? 0;
    } else if (c >= 1) {
      bx = b?.rot[0] ?? 0;
      by = b?.rot[1] ?? 0;
      bz = b?.rot[2] ?? 0;
      lx = b?.loc[0] ?? 0;
      ly = b?.loc[1] ?? 0;
      lz = b?.loc[2] ?? 0;
    } else {
      bx = (a?.rot[0] ?? 0) + ((b?.rot[0] ?? 0) - (a?.rot[0] ?? 0)) * c;
      by = (a?.rot[1] ?? 0) + ((b?.rot[1] ?? 0) - (a?.rot[1] ?? 0)) * c;
      bz = (a?.rot[2] ?? 0) + ((b?.rot[2] ?? 0) - (a?.rot[2] ?? 0)) * c;
      lx = (a?.loc[0] ?? 0) + ((b?.loc[0] ?? 0) - (a?.loc[0] ?? 0)) * c;
      ly = (a?.loc[1] ?? 0) + ((b?.loc[1] ?? 0) - (a?.loc[1] ?? 0)) * c;
      lz = (a?.loc[2] ?? 0) + ((b?.loc[2] ?? 0) - (a?.loc[2] ?? 0)) * c;
    }
    const rx = bx * s;
    const ry = by * s;
    const rz = bz * s;
    LEAN_EULER.set(rx, ry, rz, "XYZ");
    bObj.quaternion.multiply(LEAN_TMP_Q.setFromEuler(LEAN_EULER));
    const ox = lx * s;
    const oy = ly * s;
    const oz = lz * s;
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      bObj.position.x += ox;
      bObj.position.y += oy;
      bObj.position.z += oz;
    }
  }
}

function isYellowMat(mat: THREE.Material | null | undefined): boolean {  const c = (mat as THREE.MeshStandardMaterial | undefined)?.color;
  if (!c) return false;
  return c.r > 0.62 && c.g > 0.42 && c.b < 0.48;
}

function calibrateMuzzle(root: THREE.Object3D, bones: Record<string, THREE.Object3D>): { muzzle: THREE.Vector3; dir: THREE.Vector3; exit: THREE.Vector3; flash: THREE.Vector3 } | null {
  const hand = bones.R_Hand;
  const fore = bones.R_Forearm;
  if (!hand) return null;
  root.updateMatrixWorld(true);
  const handW = new THREE.Vector3();
  hand.getWorldPosition(handW);
  const axis = new THREE.Vector3(0, 0, 1);
  if (fore) {
    const foreW = new THREE.Vector3();
    fore.getWorldPosition(foreW);
    axis.copy(handW).sub(foreW);
  }
  if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
  axis.normalize();
  // Collect every qualifying gun vertex, then centroid the far tip cluster —
  // a single max vertex sits on the barrel RIM and shifts when the mesh is
  // simplified; the ring centroid stays on the bore axis regardless.
  const pts: { p: THREE.Vector3; along: number }[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    const pos = m.geometry.attributes.position;
    const skinned = m.isSkinnedMesh && typeof m.applyBoneTransform === "function";
    if (skinned) m.skeleton?.update();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i);
      if (skinned) m.applyBoneTransform(i, v);
      v.applyMatrix4(m.matrixWorld);
      const along = v.clone().sub(handW).dot(axis);
      if (along < 0.08) continue;
      const radial = v.clone().sub(handW).addScaledVector(axis, -along).length();
      if (radial > 0.32) continue;
      pts.push({ p: v.clone(), along });
    }
  });
  const best = handW.clone().addScaledVector(axis, 0.34);
  if (pts.length) {
    const maxAlong = Math.max(...pts.map((q) => q.along));
    const centroidOf = (lo: number, hi: number): THREE.Vector3 | null => {
      const c = new THREE.Vector3();
      let n = 0;
      for (const q of pts) {
        if (q.along < lo || q.along > hi) continue;
        c.add(q.p);
        n++;
      }
      return n ? c.divideScalar(n) : null;
    };
    // The far cluster is the muzzle rim ring; its centroid is the bore center.
    // Fit the true barrel axis from a second ring further back (the forearm
    // axis is NOT the bore axis — the barrel rides above the fist).
    let far = centroidOf(maxAlong - 0.06, maxAlong)!;
    // Trim outliers (e.g. drooping peel under the barrel) and re-average so the
    // centroid converges on the rim ring itself.
    {
      const ring = pts.filter((q) => q.along >= maxAlong - 0.06);
      const dists = ring.map((q) => q.p.distanceTo(far)).sort((a, b) => a - b);
      const med = dists[Math.floor(dists.length / 2)] ?? 0;
      const keep = ring.filter((q) => q.p.distanceTo(far) <= med * 1.5 + 1e-6);
      if (keep.length >= 3) {
        const c = new THREE.Vector3();
        for (const q of keep) c.add(q.p);
        far = c.divideScalar(keep.length);
      }
    }
    const near = centroidOf(maxAlong - 0.34, maxAlong - 0.16);
    best.copy(far);
    if (near && far.distanceToSquared(near) > 1e-4) {
      axis.copy(far).sub(near).normalize();
    }
  }
  hand.updateWorldMatrix(true, false);
  const muzzle = hand.worldToLocal(best.clone());
  const inv = hand.matrixWorld.clone().invert();
  const dir = axis.clone().transformDirection(inv).normalize();
  // With a ring-centroid anchor the bore center IS the muzzle: tracer exit sits
  // just ahead of it and the flash sprite right on it (old SHOT offsets
  // compensated for a rim-vertex anchor that no longer exists).
  const exitW = best.clone().addScaledVector(axis, 0.05);
  const exit = hand.worldToLocal(exitW);
  const flashW = best.clone().addScaledVector(axis, 0.03);
  const flash = hand.worldToLocal(flashW);
  return { muzzle, dir, exit, flash };
}

/**
 * THE GRIP MATRIX — where the frag has to sit so it is in the fist you can SEE.
 *
 * Round 1 parented the banana straight to the L_Hand bone and measured the gap
 * against that same bone. The review caught it: from every other player's eye
 * the raised fist was EMPTY and the banana was a yellow smear at the wristband,
 * because a skinned vertex does not live where its bone does. three.js renders
 * a hand vertex `p` (given in geometry space) at
 *
 *     world = mesh.matrixWorld * bindMatrixInverse
 *           * (bone.matrixWorld * boneInverse) * bindMatrix * p
 *
 * and in the default ATTACHED bind mode `mesh.matrixWorld * bindMatrixInverse`
 * is identity every frame, which collapses to
 *
 *     world = bone.matrixWorld * (boneInverse * bindMatrix * p)
 *
 * The bracket is a CONSTANT matrix. Hang a child off L_Hand carrying it and the
 * child rides the rendered fist in every pose, not just the calibration one.
 *
 * `p` here is the centroid of every vertex the mesh weights >= 0.6 to L_Hand —
 * the middle of the closed paw, measured off the asset, so a re-export of the
 * Bruiser re-calibrates itself.
 */
function calibrateGrip(
  root: THREE.Object3D,
  hand: THREE.Object3D | undefined,
  // The Tripo rig carries the forearm's skin on its TWIST bones — L_Forearm
  // itself owns no vertices — so the wrist end is measured off whichever of
  // these the mesh actually weights.
  arm: (THREE.Object3D | undefined)[],
): { matrix: THREE.Matrix4; out: THREE.Vector3 } | null {
  if (!hand) return null;
  let res: { matrix: THREE.Matrix4; out: THREE.Vector3 } | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (res || !m.isSkinnedMesh || !m.skeleton || !m.geometry?.attributes?.skinIndex) return;
    const hi = m.skeleton.bones.indexOf(hand as THREE.Bone);
    if (hi < 0) return;
    const fis = arm
      .map((b) => (b ? m.skeleton.bones.indexOf(b as THREE.Bone) : -1))
      .filter((i) => i >= 0);
    const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute;
    const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute;
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const weightOn = (i: number, idx: number): number =>
      (si.getX(i) === idx ? sw.getX(i) : 0) +
      (si.getY(i) === idx ? sw.getY(i) : 0) +
      (si.getZ(i) === idx ? sw.getZ(i) : 0) +
      (si.getW(i) === idx ? sw.getW(i) : 0);
    const c = new THREE.Vector3();
    const f = new THREE.Vector3();
    const v = new THREE.Vector3();
    let n = 0;
    let fw = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (weightOn(i, hi) >= 0.6) {
        c.add(v);
        n++;
      }
      // The forearm is soft-skinned (nothing reaches 0.6), so its centre is the
      // weighted one — it only has to give a direction, not a point.
      for (const fi of fis) {
        const w = weightOn(i, fi);
        if (w > 0.05) {
          f.addScaledVector(v, w);
          fw += w;
        }
      }
    }
    if (!n) return;
    c.divideScalar(n);
    if (fw > 0) f.divideScalar(fw);
    // Forearm centroid -> fist centroid is "out of the wrist" in bind space, and
    // the hand bone carries no animation, so that direction is a constant of the
    // grip frame: the frag can be pushed out past the knuckles in any pose.
    const out = fw > 0 ? c.clone().sub(f).normalize() : new THREE.Vector3(0, 1, 0);
    const matrix = new THREE.Matrix4()
      .multiplyMatrices(m.skeleton.boneInverses[hi]!, m.bindMatrix)
      .multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
    // Grip-space axes ARE the geometry's own axes: at bind the grip frame is
    // bindMatrix * T(centroid), the same rotation every bind vertex renders
    // through, so `out` needs no further change of basis.
    res = { matrix, out };
  });
  return res;
}

/**
 * THE OUTER SURFACE OF THE ARM — the points the joint budget cannot see.
 *
 * The limb budget below solves on BONE JOINTS (plus two points on the bore
 * axis), and a joint is not the drawn body. A review probe that sampled the
 * SKINNED MESH instead of the skeleton measured the gap: over 19,823 live bot
 * samples the worst JOINT sat 0.038 m inside a solid — under the 0.08 m the
 * CLIP gate fires at, hence "0 CLIP" — while the drawn MESH on the same frames
 * reached 0.182 m inside a container wall (`R_ForearmTwist02`) and 0.17 m off
 * the wrist inside a walkthrough wall (`R_Hand`). The class the gate called gone
 * was simply below the gate's resolution. (Reproduced here at 17,979 samples:
 * worst joint 0.047 m, worst body mesh 0.162 m, same bone, same wall.)
 *
 * So the solve gets the surface too, in the ONE way this file has already proved
 * safe: CONSTANT offsets in a bone's own local frame, which ride that bone
 * through every pose exactly as `template.muzzleLocal` rides `R_Hand`. Nothing
 * is measured per frame and nothing accumulates.
 *
 * A COVER, NOT A GUESS — and the first attempt at this failed for exactly that
 * reason. One "worst-covered vertex" per arm section landed on
 * `R_ForearmTwist01`; the vertex that was actually 0.16 m inside col-31 lived on
 * `R_ForearmTwist02`, 4 cm away and untouched, and 100 s of live bots measured
 * the body-clip rate UNCHANGED (0.83 vs 0.61 per 1000 samples — noise). A tube
 * of flesh is not covered by one point.
 *
 * So each section is covered PROPERLY: farthest-point sampling — take the vertex
 * farthest from everything chosen so far, `n` times. What comes out is a set
 * whose COVERING RADIUS is measured, not assumed: `cover` is the largest
 * distance from any drawn vertex of that section to its nearest sample.
 * `tuckArm` then inflates every solid by that radius when it tests these points,
 * so when the solve converges the whole drawn section is outside the box — not
 * just the samples. That is the difference between budgeting the surface and
 * budgeting six points on it.
 *
 * THE GUN IS NOT FLESH. The Bunch Cylinder is part of the same single skinned
 * mesh and is weighted to `R_Hand`, so the hand section is restricted to the
 * fist — vertices within `HULL_FIST_R` of the wrist. The barrel past that has
 * its own budget and its own deliberate wall allowance (`GUN_WALL_ALLOW`):
 * a player who walks up to a container and fires at it is putting the muzzle
 * there on purpose. Measured on this asset, R_Hand's 9,801 vertices run out to
 * 0.741 m from the wrist in an unbroken ramp — there is no geometric seam to
 * find, so the split is stated, not guessed.
 *
 * WHAT IS DELIBERATELY NOT HERE: the legs — and with the arms budgeted they are
 * now the worst of what is left, so this is a choice, not an oversight. Measured
 * on the finished build, the deepest drawn body in a solid is a CALF or a FOOT
 * (R_CalfTwist02 0.133 m, L_Foot 0.120 m, both in a perimeter wall), thrown
 * there by the P5 stride amplifier. The only joint that could pull one out is
 * the thigh, and swinging thighs to rescue a foot spends the anti-skating win
 * qa/motion.mjs gates. Two frames in 9,049 against an arm class that was seven
 * times as common and is now gone. Measured and named in
 * qa/HANDOFF-LIMB-EXTENT.md, not fixed.
 */
export const HULL_FIST_R = 0.22;
/**
 * Arm sections, the bones whose skin owns each, and how many surface samples to
 * spend covering it.
 *
 * `n` is where cost meets coverage, and the curve is the shallow one a 3-D cover
 * always has — MEASURED on this asset, worst section:
 *
 *     n = 1   cover 0.40 m      n = 6   cover 0.21 m
 *     n = 3   cover 0.26 m      n = 10  cover 0.18 m      n = 24  cover 0.12 m
 *
 * Every sample costs one clamp plus up to SOLID_MAX box tests per relaxation
 * pass, on every actor, every frame. n = 6 (4 for the compact fist) buys the
 * knee of that curve — the covering radii it yields are 0.167-0.212 m — and
 * taking it to 24 would triple the runtime cost of the solve to halve a margin
 * that is already smaller than the flesh it stands for. The radii are measured
 * at load and ride on each HullPoint as `cover`; nothing here is a tuned number.
 */
const HULL_SECTIONS: { key: string; bones: string[]; n: number }[] = [
  { key: "L_upper", bones: ["L_Upperarm", "L_UpperarmTwist01", "L_UpperarmTwist02"], n: 6 },
  { key: "R_upper", bones: ["R_Upperarm", "R_UpperarmTwist01", "R_UpperarmTwist02"], n: 6 },
  { key: "L_fore", bones: ["L_Forearm", "L_ForearmTwist01", "L_ForearmTwist02"], n: 6 },
  { key: "R_fore", bones: ["R_Forearm", "R_ForearmTwist01", "R_ForearmTwist02"], n: 6 },
  { key: "L_hand", bones: ["L_Hand"], n: 4 },
  { key: "R_hand", bones: ["R_Hand"], n: 4 },
];

export type HullPoint = {
  /** Section key (see HULL_SECTIONS). */
  key: string;
  /** The bone this surface point rides. */
  bone: string;
  /** Its position in that bone's LOCAL frame — constant, measured once at bind. */
  local: THREE.Vector3;
  /**
   * The section's measured COVERING RADIUS (m): no drawn vertex of this section
   * is farther than this from one of its samples. tuckArm inflates solids by it.
   */
  cover: number;
};

function calibrateHull(root: THREE.Object3D, bones: Record<string, THREE.Object3D>): HullPoint[] {
  const out: HullPoint[] = [];
  let mesh: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!mesh && m.isSkinnedMesh && m.skeleton && m.geometry?.attributes?.skinIndex) mesh = m;
  });
  const m = mesh as THREE.SkinnedMesh | null;
  if (!m) return out;
  m.skeleton.update();
  const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute;
  const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute;
  const pos = m.geometry.attributes.position as THREE.BufferAttribute;
  const sk = m.skeleton.bones;
  // Only the wrists are needed, and only to tell fist from barrel.
  const jointW = new Map<string, THREE.Vector3>();
  for (const n of ["L_Hand", "R_Hand"]) {
    const b = bones[n];
    if (b) jointW.set(n, b.getWorldPosition(new THREE.Vector3()));
  }
  // One pass over the mesh bins every arm vertex into its section by DOMINANT
  // SKINNING BONE — what the GPU actually moves it with.
  const owner = new Map<string, string>();
  for (const s of HULL_SECTIONS) for (const b of s.bones) owner.set(b, s.key);
  const binned = new Map<string, { world: THREE.Vector3; bone: string }[]>();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let w = -1;
    let bi = 0;
    for (let c = 0; c < 4; c++) {
      const wc = sw.getComponent(i, c);
      if (wc > w) {
        w = wc;
        bi = si.getComponent(i, c);
      }
    }
    const b = sk[bi];
    const key = b ? owner.get(b.name) : undefined;
    if (!b || !key) continue;
    v.fromBufferAttribute(pos, i);
    if (typeof m.applyBoneTransform === "function") m.applyBoneTransform(i, v);
    v.applyMatrix4(m.matrixWorld);
    // The gun rides the gun hand: past the fist it is the barrel's budget, not
    // the body's.
    if (b.name.endsWith("_Hand")) {
      const wrist = jointW.get(b.name);
      if (wrist && v.distanceTo(wrist) > HULL_FIST_R) continue;
    }
    let arr = binned.get(key);
    if (!arr) binned.set(key, (arr = []));
    arr.push({ world: v.clone(), bone: b.name });
  }
  for (const s of HULL_SECTIONS) {
    const verts = binned.get(s.key);
    if (!verts?.length) continue;
    // Greedy farthest-point cover, over the SAMPLES THEMSELVES and nothing else.
    //
    // The obvious shortcut is to seed this with the joints the budget already
    // pins, which gives a smaller radius for the same `n`. It also breaks the
    // guarantee: those joints are tested with a margin of ZERO (they are the
    // thing being kept out, not a stand-in for flesh around them), so a vertex
    // whose nearest sample is a joint is not held `cover` clear of anything.
    // The radius has to be measured against the points that actually carry it.
    //
    // First pick is the vertex farthest from the section centroid — an arbitrary
    // but deterministic start, which is all farthest-point sampling needs.
    const c0 = new THREE.Vector3();
    for (const q of verts) c0.add(q.world);
    c0.divideScalar(verts.length);
    let first = 0;
    let fd = -1;
    for (let i = 0; i < verts.length; i++) {
      const d = verts[i]!.world.distanceToSquared(c0);
      if (d > fd) {
        fd = d;
        first = i;
      }
    }
    const picked: { world: THREE.Vector3; bone: string }[] = [verts[first]!];
    const near = verts.map((q) => q.world.distanceTo(verts[first]!.world));
    for (let k = 1; k < s.n; k++) {
      let bi = -1;
      let bd = -1;
      for (let i = 0; i < verts.length; i++) {
        if (near[i]! > bd) {
          bd = near[i]!;
          bi = i;
        }
      }
      if (bi < 0 || !(bd > 1e-4)) break;
      const q = verts[bi]!;
      picked.push(q);
      for (let i = 0; i < verts.length; i++) near[i] = Math.min(near[i]!, verts[i]!.world.distanceTo(q.world));
    }
    // What is left uncovered — the radius tuckArm inflates every solid by when
    // it tests these points, and therefore the whole of the guarantee.
    const cover = near.length ? Math.max(...near) : 0;
    for (const q of picked) {
      const bone = bones[q.bone];
      if (!bone) continue;
      out.push({ key: s.key, bone: q.bone, local: bone.worldToLocal(q.world.clone()), cover });
    }
  }
  return out;
}

/**
 * THE GUN MOUNT. Measured once, in the calibrated aim pose, off the asset:
 *
 *   fist   the centroid of the paw that is left once the launcher is cut out
 *          (tp-gun.ts stripLauncher) — the point the new grip goes through;
 *   basis  the bore on the launcher's own calibrated fire axis (calibrateMuzzle,
 *          run BEFORE the strip), up toward world up in that pose — so every gun
 *          sits in the fist the way the sculpted launcher grip did;
 *   unit   hand-local units per metre (the gun is authored in metres).
 *
 * MOUNT_TILT pitches the gun about its own cross axis inside the fist: a rifle's
 * pistol grip rakes back, and the launcher's grip axis is not a rifle's.
 */
const MOUNT_TILT = 0;

function measureGunMount(
  scene: THREE.Object3D,
  bones: Record<string, THREE.Object3D>,
  dirLocal: THREE.Vector3,
  fistLocal: THREE.Vector3,
): BruiserTemplate["gunMount"] {
  const hand = bones.R_Hand!;
  scene.updateMatrixWorld(true);
  const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
  const upL = new THREE.Vector3(0, 1, 0).applyQuaternion(handQ.clone().invert());
  // gun +Z (the stock end) is AGAINST the fire direction
  const zc = dirLocal.clone().normalize().negate();
  const x = new THREE.Vector3().crossVectors(upL, zc).normalize();
  const y = new THREE.Vector3().crossVectors(zc, x).normalize();
  const basis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, zc));
  if (MOUNT_TILT) basis.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), MOUNT_TILT));
  const s = new THREE.Vector3().setFromMatrixScale(hand.matrixWorld).x || 1;
  return { fist: fistLocal.clone(), basis, unit: 1 / s };
}

/** Gun-space point -> R_Hand-local point, through a mount. */
function mountPoint(m: BruiserTemplate["gunMount"], p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(p).multiplyScalar(m.unit).applyQuaternion(m.basis).add(m.fist);
}

function defaultBore(m: BruiserTemplate["gunMount"]): Pick<BruiserTemplate, "muzzleLocal" | "fireDirLocal" | "exitLocal" | "flashLocal"> {
  const g = tpGunProto("ar");
  const fwd = new THREE.Vector3(0, 0, -1);
  return {
    muzzleLocal: mountPoint(m, g.muzzle, new THREE.Vector3()),
    fireDirLocal: fwd.clone().applyQuaternion(m.basis).normalize(),
    exitLocal: mountPoint(m, g.muzzle.clone().addScaledVector(fwd, 0.03), new THREE.Vector3()),
    flashLocal: mountPoint(m, g.muzzle.clone().addScaledVector(fwd, 0.02), new THREE.Vector3()),
  };
}

export async function loadBruiserTemplate(lowDetail = false): Promise<BruiserTemplate> {
  if (template) return template;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(assetUrl(lowDetail ? "/assets/models/bruiser-low.glb" : "/assets/models/bruiser.glb"));
  const scene = gltf.scene as THREE.Group;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std) continue;
        std.metalness = Math.min(std.metalness ?? 0, 0.08);
        std.roughness = Math.min(std.roughness ?? 0.7, 0.62);
      }
    }
  });
  const clips = new Map<string, THREE.AnimationClip>();
  for (const c of gltf.animations) clips.set(c.name, c);

  // Size + feet/center snap measured with idle applied at t=0.
  const mixer = new THREE.AnimationMixer(scene);
  const idle = clips.get("idle");
  if (idle) {
    mixer.clipAction(idle).play();
    mixer.update(0);
  }
  let box = posedBox(scene);
  if (box.isEmpty()) box = new THREE.Box3().setFromObject(scene);
  const scale = HEIGHT / Math.max(box.max.y - box.min.y, 0.001);
  // Re-measure in scaled space for the ground/center offsets, and keep the scene
  // scaled for muzzle calibration so the bench-tuned search thresholds (meters) hold.
  scene.scale.setScalar(scale);
  scene.updateMatrixWorld(true);
  let box2 = posedBox(scene);
  if (box2.isEmpty()) box2 = new THREE.Box3().setFromObject(scene);
  const yOff = -box2.min.y;
  const xOff = -(box2.min.x + box2.max.x) / 2;
  const zOff = -(box2.min.z + box2.max.z) / 2;
  mixer.stopAllAction();

  // Muzzle calibration with the tuned aim pose applied (scene still scaled).
  const bones = collectBones(scene);
  const bind: Record<string, THREE.Quaternion> = {};
  for (const [n, b] of Object.entries(bones)) bind[n] = b.quaternion.clone();
  applyAimStatic(bones, bind);
  scene.updateMatrixWorld(true);
  const cal = calibrateMuzzle(scene, bones);
  // EVERY MAP: cut the fused banana launcher out of the mesh (the launcher's
  // bore was measured just above, and that is all it is still needed for) and
  // measure the fist the real guns are mounted in. Once per template.
  let skinned: THREE.SkinnedMesh | null = null;
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!skinned && m.isSkinnedMesh && m.skeleton?.bones.some((b) => b.name === "R_Hand")) skinned = m;
  });
  let fistLocal = new THREE.Vector3();
  if (skinned) {
    const sk = skinned as THREE.SkinnedMesh;
    const res = stripLauncher(sk);
    fistLocal = fistCentroidLocal(sk);
    console.info(`[bruiser] 3P: launcher stripped (${res.removed} tris cut, ${res.shards} shard tris, ${res.mirrored} paw verts mirrored from the left, ${res.capped} cuts capped)`);
  }
  const gunMount = measureGunMount(scene, bones, cal?.dir ?? new THREE.Vector3(0, 0, 1), fistLocal);
  const grip = calibrateGrip(scene, bones.L_Hand, [
    bones.L_Forearm,
    bones.L_ForearmTwist01,
    bones.L_ForearmTwist02,
  ]);
  for (const [n, b] of Object.entries(bones)) if (bind[n]) b.quaternion.copy(bind[n]!);
  // The drawn arm surface, measured at BIND (aim pose undone above) and while
  // the scene still carries the game's scale, so the offsets come out in metres.
  scene.updateMatrixWorld(true);
  const hull = calibrateHull(scene, bones);
  scene.scale.setScalar(1);
  scene.updateMatrixWorld(true);
  // Pre-warm the ally-shorts texture for the current colour-vision mode while
  // the loading screen is up, so the first ally sighting never hitches on the
  // one-time 1 MPixel recolour (a later mode change rebuilds once, in the
  // settings menu, via setRelation).
  try {
    const allyHex = teamColors().ally;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (std?.isMeshStandardMaterial && std.map) shortsTextureFor(std.map, allyHex);
      }
    });
  } catch {
    /* variant builds lazily on first ally instead */
  }

  template = {
    scene,
    clips,
    scale,
    yOff,
    xOff,
    zOff,
    // The default gun's (AR) bore in hand space — for anything that reads the
    // template before an actor has a gun in its fist.
    ...defaultBore(gunMount),
    gripLocal: grip?.matrix ?? new THREE.Matrix4(),
    gripOut: grip?.out ?? new THREE.Vector3(0, 1, 0),
    gaitMid: {
      walk: clips.get("walk") ? clipMidPose(clips.get("walk")!, MID_BONES) : {},
      run: clips.get("run") ? clipMidPose(clips.get("run")!, MID_BONES) : {},
    },
    hull,
    gunMount,
  };
  // Hand the measured surface points to the limb budget. Once, at load: they are
  // constants of the asset, and re-running this assigns the same list.
  for (const arm of EXTENT_ARMS) arm.hullPts = hull.filter((h) => arm.hullOf.includes(h.key));
  return template;
}

type Loco = "idle" | "walk" | "run" | "crouch" | "crouchwalk";

/** Seconds of fall clip to play before freezing (ground contact; tail has baked slide). */
const FALL_FREEZE_T = 0.62;
/** Additive crouch pose parameters (raw bone units / radians, tuned via capture). */
const CROUCH_HIP_DROP = 0.05;
const CROUCH_THIGH = -0.45;
const CROUCH_CALF = 0.76;
const CROUCH_HUNCH = 0.28;

// ------------------------------------------------------------ GROUND TRUTH --
//
// MEASURED gait of the two locomotion clips at timeScale 1, world scale.
//
//   mps   mean BACKWARD world speed of the ankle bone while it is in ground
//         contact, on a stationary actor playing the raw clip (forceClip +
//         step probe). This is exactly the quantity qa/motion.mjs calls
//         "planted-foot drift", so matching it is what drives that metric to
//         zero — the clip's honest ground speed, not an impression of one.
//   steps ground contacts per second over the same window.
//
// The previous numbers here were eyeballed (walk 2.0 / run 5.5) and 2.6x too
// HIGH. That is the whole glide: at a 4.35 m/s run the anti-skate divide asked
// for timeScale 0.79, so the legs carried 2.01 * 0.79 = 1.6 m/s of the 4.35 the
// root travelled — a third of it — and the Bruiser skated the rest. Firing did
// not cause it (the aim overlay never touches a leg bone); firing just parks
// the camera on the defect.
const CLIP_GAIT = {
  walk: { mps: 0.76, steps: 1.33 },
  run: { mps: 2.01, steps: 3.1 },
};

// --------------------------------------------------------- SPEED MATCHING --
//
// Covering the sim's ground speed needs a playback ratio of speed/mps — 2.16x
// for the 4.35 m/s run. There are two knobs and it takes both:
//
//   timeScale  cadence. Cheap, but 2.16x alone runs the legs at 6.7 steps/s,
//              which is a cartoon.
//   stride     how far the legs swing, applied per-bone to thigh/calf/foot as
//              an amplification of the clip's own deviation from its CYCLE MEAN
//              pose. Pivoting on the mean (not on bind) is what makes this safe:
//              mid-stance IS the mean pose, so the planted foot barely moves
//              while heel-strike and toe-off reach further — the stride grows
//              and the foot does not lift off the floor.
//
// Cadence is driven to a speed-appropriate target and whatever ratio is left
// over goes into stride. At 4.35 m/s that lands on 1.19x cadence / 1.81x stride
// (0.65 m -> 1.18 m per step), both inside the band where the gait still reads.
const CADENCE_TARGET = (v: number): number => 1.3 + 0.55 * v; // steps/s wanted at ground speed v
const TS_BAND = { lo: 0.55, hi: 1.75 };
const STRIDE_MAX = 1.9;
/** How far cadence may climb past TS_BAND.hi when the stride is maxed (anti-skate catch-up). */
const TS_CATCHUP_MAX = 2.4;
/** Lower-body bones the stride amplifier drives, and how much of it each takes. */
const STRIDE_BONES: [string, number][] = [
  ["L_Thigh", 1], ["R_Thigh", 1],
  ["L_Calf", 1], ["R_Calf", 1],
  ["L_Foot", 0.8], ["R_Foot", 0.8],
];

// ------------------------------------------------------- ARM-SWING CEILING --
//
// The gait clips throw the free (left) arm wide — up to 1.43 m from the capsule
// centre, which is how a bot hugging cover ends up with a hand bone inside the
// wall (botwatch CLIP episodes: arm bones only, never torso). Rather than clamp
// the whole swing and flatten the run silhouette, the deviation from the cycle
// mean is passed through untouched up to ARM_KNEE and only COMPRESSED past it:
// the middle of the swing is bit-identical, the last few degrees at each end
// give way. Note this governs the FREE arm only — the gun hand's reach comes
// from the tuned CARRY/aim pose below, not from the clip, and no amount of
// clip-side clamping moves it.
const ARM_KNEE = 0.62; // rad of deviation from the cycle mean that passes free
const ARM_SQUASH = 0.45; // how much of the excess beyond the knee survives
/** The free arm: the gun arm is already held by the CARRY override. */
const ARM_CEIL_BONES = ["L_Upperarm", "L_Forearm"];
/** Bones whose cycle-mean pose the actor needs at runtime. */
const MID_BONES = [...STRIDE_BONES.map(([n]) => n), ...ARM_CEIL_BONES];

// ------------------------------------------------------- LEG-FOLD CEILING --
//
// How far a leg bone may end up from its BIND pose, as a real rotation angle.
//
// This is a different question from the stride amplifier's AMP_HALF_MAX, which
// bounds how far a bone may be pushed from its own CYCLE MEAN and exists to keep
// the extrapolation off the quaternion pole. A bone can sit well inside that
// bound and still be folded somewhere no leg goes: the run clip's authored knee
// tuck, amplified by the 1.9x stride the 5.92 m/s sprint asks for, put R_Calf
// 157.3 deg off bind — heel jammed through the back of the thigh — on 4.2 of
// every 1000 rendered actor-frames (qa/leg-extent.mjs, 60 s, real GPU).
//
// The ceiling is a slerp TOWARD BIND by exactly the fraction that brings the
// bone back to the cap, which makes it idempotent: re-applying it to its own
// output is a no-op, so it is safe on a frame where three wrote no bone at all.
// It only ever engages at the very top of the swing phase — the planted foot is
// nowhere near it, and that is not an assertion: every one of qa/motion.mjs's 12
// scenarios comes back DIGIT-IDENTICAL to the pre-ceiling artifact, including
// shoot-while-running 0.315 and shoot-while-strafing 0.285.
//
// 130 deg, not 145. 145 was the first number tried and cleared qa/leg-extent's
// 150 deg line by five degrees; 130 clears it by twenty and costs nothing that
// any instrument can find — the drawn hip band is identical between the two to
// three decimal places in every gait (the rear reach at hip height is the THIGH's
// hip extension, not the knee fold, which is why tightening the fold does not
// shrink it), qa/motion is digit-identical, and the tp-run sheet still reads as a
// sprint. Measured after (60 s, real GPU, 10 bots): L_Calf 130.0 / R_Calf 130.0 /
// R_Thigh 119.8 max off bind, nothing over 150 anywhere, against the 157.3 deg
// the amplifier used to reach.
const LEG_FOLD_MAX = (130 * Math.PI) / 180;

// ------------------------------------------------------ LIMB EXTENT BUDGET --
//
// THE SILHOUETTE A PLAYER SHOOTS AT SHOULD BE THE VOLUME THE SERVER HITS, AND
// NO PAW MAY BE INSIDE A SOLID THE CAPSULE IS LEGALLY CLEAR OF.
//
// Everything above shapes a limb by re-scaling a rotation. This is the one rule
// stated in the units that actually matter — metres, in the actor ROOT's frame,
// where the sim's 0.60 m collision capsule and the server's 0.64 m hit capsule
// both live. It has TWO terms, and they are not the same constraint:
//
//   THE ENVELOPE (below) is about the SILHOUETTE. A joint outside it is a piece
//   of body a player can put a crosshair on that the server's capsule does not
//   cover — the whole of qa/netlab's limb-shot deficit (100 % of body shots
//   registered, 71 % of shots aimed at a limb).
//
//   THE SOLIDS (tuckArm's second term) are about WALLS, and they are measured,
//   not inferred: the same box test client/src/inspect.ts runs, against the same
//   shared/map.ts SOLIDS, so a bone this term keeps out of a box is a botwatch
//   CLIP episode that cannot happen. An envelope alone cannot promise that — see
//   WHAT THE ENVELOPE DOES NOT BUY, below.
//
// LATERAL is the axis both instruments complain about, and it is pinned at the
// only number that means anything: RADIUS (0.30, shared/sim) + inspect.ts's
// 0.08 m CLIP tolerance. FORWARD is looser because forward reach is the
// character doing its job — an ape pointing a banana cannon down a lane — and
// 0.56 is what the bench-tuned FIRING pose needs (its gun hand sits 0.510 m
// ahead of the capsule axis, measured, unchanged by this rule).
//
// ARMS ONLY, deliberately. The legs are inside the lateral budget already
// (feet peak at 0.24 m off the centreline) and their FORWARD/BACK reach is the
// stride — the thing P5 measured, amplified and proved. Budgeting that would
// buy a few centimetres of silhouette by handing back the anti-skating win.
//
// WHAT THE ENVELOPE DOES NOT BUY. The envelope pins JOINTS, and a joint is not
// the drawn body: the Bunch Cylinder carries 0.42 m of barrel past R_Hand, and a
// fist is ~0.06 m across. A round-1 attempt at this file budgeted joints only,
// pointed the carried barrel straight down +Z, and qa/planted.mjs caught it —
// hip half-depth 0.714 m against 0.561 m of half-width, 0.661 m of drawn body
// ahead of a 0.32 m capsule, far edge R_Hand on 100 % of frames. Nor does a
// lateral cap make a wall clip impossible: with the capsule pinned at its legal
// 0.30 m off a real container face (col-3, 2.44 x 2.59 x 6.06 m) that build
// still had L_Hand 0.511 m inside on the throw, R_Hand 0.274 m inside on the
// nade hold and 0.202 m inside while firing — all of it FORWARD reach, which a
// lateral budget never sees. Hence: the gun's own geometry is budgeted (below),
// and the wall term is absolute (tuckArm).
//
// AND THE SAME IS TRUE OF THE FLESH, which took a second review to see. A joint
// budget is invisible to the mesh AROUND the joint: measured on 17,979 live bot
// samples, the worst JOINT sat 0.047 m inside a solid — green on every gate —
// while the drawn mesh on those frames was 0.162 m inside a container wall at
// R_ForearmTwist02.
// So the arm's SURFACE is budgeted too, as a measured cover of samples that ride
// the bones (calibrateHull). It feeds the WALL term only, never the envelope:
// the envelope is what qa/planted and qa/netlab measure, and a surface term on
// it would narrow the ape into exactly the timid silhouette this file forbids.
const EXTENT = { lat: RADIUS + 0.08, fwd: 0.56 };
/**
 * The GUN's own geometry, budgeted where the drawn silhouette is measured.
 *
 * template.muzzleLocal is the calibrated bore centre in R_Hand space, ~0.42 m
 * out; it and a mid-barrel sample ride in the right arm's tip list, so the
 * barrel is inside the budget rather than the joint that holds it. The carried
 * pose is authored to sit inside it (CARRY/SPRINT_CARRY put the muzzle up across
 * the chest: 0.24 m lateral walking, 0.44-0.46 m at run, i.e. walking is inside
 * by construction and the run rides the boundary), so what this term mostly does
 * is catch the transitions, the aim-pitch and the recoil.
 *
 * AIM SLACK is the honest exception. Aiming IS pointing the barrel at something,
 * and a budget that fought it would swing the gun off the target the player is
 * shooting at. So the gun's box grows with aimW — and it never buys more than
 * the hand's own budget plus the barrel's length, which is the real bound on
 * where the muzzle can be: 0.38 + 0.42 = 0.80 m lateral, 0.56 + 0.42 = 0.98 m
 * forward, measured 0.099 / 0.859 in the firing pose.
 */
const GUN_EXTENT = { lat: 0.44, fwd: 0.66 };
const GUN_AIM_SLACK = { lat: 0.36, fwd: 0.52 };
/**
 * How far the BARREL may be inside a solid at full aim (m). Bones get zero — a
 * paw in a container is the bug — but a player who walks up to a container and
 * fires at it is deliberately putting the muzzle there, and rotating the arm to
 * rescue the barrel would point the gun somewhere the player is not shooting.
 * At carry weight the allowance is 0, which is what keeps the muzzle out of the
 * wall in the presentation the user actually complained about.
 */
const GUN_WALL_ALLOW = 0.6;
/** Ceiling on how far one solve may swing a shoulder (rad) — see tuckArm(). */
const EXTENT_MAX_TURN = 0.42;
/**
 * Relaxation passes per arm. FOUR, measured, and the measurement is why: at TWO
 * the solve was advisory at speed — round 1's free hand sat 0.466 m out at sprint,
 * 2.6 cm past that build's 0.44 m budget, on 9 of 18 sampled frames. At four, on
 * this build's tighter 0.38 m budget, 11 of 14 gait/aim states have no joint more
 * than 2 % outside on any of 18 sampled frames; sprint and aim-strafe have one
 * frame each; the nade hold sits on its own (widened) boundary by design. Each
 * pass is monotone or it is reverted (see tuckArm), so a pass that cannot help
 * costs one distance test.
 */
const EXTENT_ITERS = 4;
/** How much wider the envelope gets for the throwing arm at full wind-up. */
const THROW_WIDEN = 0.6;
/** Horizontal reach (m) from the body centre within which a solid is budgeted. */
const SOLID_REACH = 1.1;
/** Cap on solids considered per frame (Shipment's worst spot touches three). */
const SOLID_MAX = 6;
/**
 * WHAT PIVOTS, AND WHAT IT IS ASKED TO KEEP CLEAR — in order, coarse to fine.
 *
 * The two ARM entries are the budget proper: the envelope is convex and the tips
 * are the two ENDS of the forearm, so pinning both pins every twist bone between
 * them (L_ForearmTwist02 — the bone in botwatch's surviving episode — included)
 * without measuring any of them. `gun` adds the barrel samples.
 *
 * The two CLAVICLE entries exist for one measured reason, and they get the wall
 * term ONLY (`lat`/`fwd` infinite). With the capsule pinned at its legal 0.30 m
 * off a container face and the shoulder square to it, the deepest bone inside was
 * L_UpperarmTwist01 at 0.097-0.119 m — the SHOULDER JOINT itself, which sits
 * 0.40-0.46 m off the centreline as an asset fact. No rotation of the arm hanging
 * off it can move it, and no lateral envelope can budget it away; the only joint
 * upstream that can is the clavicle, whose own reach is ~0.18 m. So the shoulder
 * rolls away from a solid it is inside, a few degrees, exactly as far as it takes
 * to leave — which is what a body does when it brushes a wall — and gets a much
 * smaller per-pass turn cap than an arm because it carries the deltoid mesh.
 *
 * `hullOf` names the DRAWN SURFACE samples this arm carries (calibrateHull). They
 * are WALL-TERM ONLY — `lat`/`fwd` are infinite for them, by construction — so
 * they can never narrow the silhouette a player shoots at, only keep the flesh
 * out of a container. That split is deliberate: the envelope is what qa/planted
 * and qa/netlab measure, and the arms-pinned, timid ape this file forbids is
 * exactly what an envelope term on the surface would produce.
 */
type ExtentArm = {
  shoulder: string;
  tips: string[];
  /** Surface-sample sections this arm owns (see calibrateHull / HULL_SECTIONS). */
  hullOf: string[];
  /** Filled in once at template load — the measured points for `hullOf`. */
  hullPts: HullPoint[];
  gun: boolean;
  lat: number;
  fwd: number;
  turn: number;
};

const EXTENT_ARMS: ExtentArm[] = [
  { shoulder: "L_Clavicle", tips: ["L_Upperarm"], hullOf: ["L_upper"], hullPts: [], gun: false, lat: Infinity, fwd: Infinity, turn: 0.3 },
  { shoulder: "R_Clavicle", tips: ["R_Upperarm"], hullOf: ["R_upper"], hullPts: [], gun: false, lat: Infinity, fwd: Infinity, turn: 0.3 },
  { shoulder: "L_Upperarm", tips: ["L_Forearm", "L_Hand"], hullOf: ["L_fore", "L_hand"], hullPts: [], gun: false, lat: EXTENT.lat, fwd: EXTENT.fwd, turn: EXTENT_MAX_TURN },
  { shoulder: "R_Upperarm", tips: ["R_Forearm", "R_Hand"], hullOf: ["R_fore", "R_hand"], hullPts: [], gun: true, lat: EXTENT.lat, fwd: EXTENT.fwd, turn: EXTENT_MAX_TURN },
];

/** Bind pose faces +X; rotate to the game's +Z-forward convention. */
const BASE_YAW = -Math.PI / 2;
/** Post-mixer head-up corrective for the hunched ape gait (rad, sign checked via capture). */
const HEAD_UP = { walk: 0.3, run: 0.5 };

type BruiserTune = { aimYawOff: number; armYawFix: number };

function tune(): BruiserTune {
  const w = window as unknown as { __bruiserTune?: BruiserTune };
  if (!w.__bruiserTune) w.__bruiserTune = { aimYawOff: 0.18, armYawFix: 0 };
  return w.__bruiserTune;
}

/** The clip each locomotion state rides (crouch is idle/walk plus an additive pose). */
const LOCO_CLIP: Record<Loco, string> = {
  idle: "idle", crouch: "idle", walk: "walk", crouchwalk: "walk", run: "run",
};

/**
 * The weight the mixer is ACTUALLY blending this action at.
 *
 * Not the same as getEffectiveWeight(): three initialises _effectiveWeight to 1
 * in the AnimationAction constructor and only ever recomputes it for actions the
 * mixer has in its active list, so a clip that has never been played reports full
 * weight. Reading that as a live weight silently mixes a clip nobody is playing
 * into anything weight-driven.
 */
function liveWeight(a: THREE.AnimationAction | undefined): number {
  return a && a.isRunning() ? a.getEffectiveWeight() : 0;
}

/**
 * Ramp an action's weight from where it ACTUALLY is to `to`, over `duration`.
 *
 * three's fadeIn/fadeOut always schedule the ramp from a fixed 0 / 1, so
 * interrupting one part way pops the weight to the new ramp's start value. These
 * cross-fades get interrupted all the time — a bot re-crossing a speed threshold
 * inside a 0.16 s blend — so they have to pick up from the live weight instead.
 *
 * EVERY RAMP FROM ONE play() CALL MUST SHARE `duration`. That is what keeps the
 * blend weights summing to 1, and the sum is not cosmetic: three's
 * PropertyMixer.apply() mixes the asset BIND pose in at (1 - cumulativeWeight),
 * so a sum of 0.54 drags every bone 46 % of the way back to bind — measured at
 * up to 27.6 deg on an upper arm. With a shared d and linear ramps the sum at
 * u in [0, d] is S + (u/d)(1 - S) where S is the sum at the call: a sum of 1 is
 * held exactly for the whole ramp, and any deficit recovers to 1 by the end.
 * Scaling d by each action's own gap (the obvious "constant rate" move) breaks
 * that the moment a THIRD action joins — two ramps of different lengths, and the
 * sum sags mid-fade. Slower ramps for small gaps are the price, and they are
 * invisible; a bind-pose bleed is not.
 *
 * An uninterrupted fade (from == 1 out, from == 0 in) schedules bit-identically
 * to three's own call, so every steady state is untouched.
 */
function fadeWeight(a: THREE.AnimationAction, to: number, duration: number): void {
  const from = a.getEffectiveWeight();
  // setEffectiveWeight also stopFading()s: it drops any in-flight ramp and sets
  // the base weight the new ramp multiplies.
  a.setEffectiveWeight(1);
  if (duration <= 0 || Math.abs(to - from) < 1e-4) {
    a.setEffectiveWeight(to);
    if (to <= 0) a.enabled = false;
    return;
  }
  const sched = (a as unknown as {
    _scheduleFading?: (d: number, x: number, y: number) => THREE.AnimationAction;
  })._scheduleFading;
  if (typeof sched === "function") sched.call(a, duration, from, to);
  else if (to > 0) a.fadeIn(duration);
  else a.fadeOut(duration);
}

export class BruiserActor {
  root = new THREE.Group();
  holder = new THREE.Group();
  body: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions = new Map<string, THREE.AnimationAction>();
  bones: Record<string, THREE.Object3D>;
  bind: Record<string, THREE.Quaternion> = {};
  aimQuat: Record<string, THREE.Quaternion> = {};
  id: string;
  /** Claim a freshly prepared actor; never used to recycle a played skeleton. */
  claim(p: PlayerSnap): void {
    this.id = p.id;
    // Team dressing (shorts, EVA bands) follows the relation, re-asserted every
    // frame by setRelation — no team-number paint here to go stale.
    this.yawVis = p.yaw;
    const texture = (this.nameTag.material as THREE.SpriteMaterial).map!;
    this.tagName = p.name;
    paintName(texture.image as HTMLCanvasElement, p.name, this.ally);
    texture.needsUpdate = true;
    this.markUntil = -1e9;
  }
  /** Only for a virgin actor's pre-seat graphics warmup. */
  prepareVisibleEffects(visible: boolean): void {
    this.nameTag.visible = visible;
  }
  private eva: AstronautRig | null = null;
  weapon = "";
  loco: Loco = "idle";
  aimW = 0;
  kick = 0;
  shootHold = 0;
  deadT = 0;
  wasAlive = true;
  yawVis = 0;
  /**
   * CORNER LEAN (Q/E, view-only): eased toward the snapshot's `lean`
   * (-1 | 0 | 1, absent on old servers = 0). Layers the Blender-authored
   * model pose (pelvis slide, re-solved legs, spine roll, level head — see
   * lean-pose.ts / applyLeanPose) onto the drawn body only; the hit capsule
   * never moves.
   */
  leanVis = 0;
  tmpQ = new THREE.Quaternion();
  chevron!: THREE.Sprite;
  forced: string | null = null;
  deadRoll = 0;
  bobT = 0;
  bindPos: Record<string, THREE.Vector3> = {};
  /** Fixed seed pose both arms are solved from (see REST_AIM). */
  seedQuat: Record<string, THREE.Quaternion> = {};
  /** The run carry's trigger arm (FK, see SPRINT_CARRY). */
  sprintQuat: Record<string, THREE.Quaternion> = {};
  /** Damped 0..1 blend between the walk carry key and the run carry key. */
  private sprintCarryW = 0;
  hitT = 0;
  hitSide = 1;
  aimYawW = 0;
  crouchW = 0;
  tplScale = 1;
  gaitMid: Record<string, Record<string, THREE.Quaternion>> = {};
  /** Live lower-body yaw off the rendered facing (rad) — see the Pelvis split. */
  legYaw = 0;
  /** True while the gait clip is being played backwards for rearward travel. */
  legRev = false;
  private tmpQ2 = new THREE.Quaternion();
  /** Scratch for the cross-fade-blended gait cycle mean (see midAt). */
  private midBlend = new THREE.Quaternion();
  private upLocal = new THREE.Vector3();
  /** Owned joint spliced in above Pelvis — carries legYaw and nothing else. */
  private legJoint: THREE.Object3D | null = null;
  /** Per-bone {last mixer output, what we left it at} — see latchPose(). */
  private latch: { b: THREE.Object3D; mix: THREE.Quaternion; out: THREE.Quaternion }[] = [];
  private hipMixX = 0;
  private hipMixY = 0;
  private hipMixZ = 0;
  private hipOutX = 0;
  private hipOutY = 0;
  private hipOutZ = 0;
  /** False until the latch holds a real pair of samples (construction, respawn). */
  private latchOn = false;
  /** Scratch for the extent budget — root-space inverse, points, rotations. */
  private extInv = new THREE.Matrix4();
  private extS = new THREE.Vector3();
  private extP = new THREE.Vector3();
  private extW = new THREE.Vector3();
  private extT = new THREE.Vector3();
  private extWorst = new THREE.Vector3();
  private extGoal = new THREE.Vector3();
  private extA = new THREE.Vector3();
  private extB = new THREE.Vector3();
  private extQ = new THREE.Quaternion();
  private extQP = new THREE.Quaternion();
  private extQC = new THREE.Quaternion();
  private extQ0 = new THREE.Quaternion();
  /** Solids within arm's reach this frame (see gatherSolids), and how many. */
  private solids: OBB[] = [];
  private solidCandidates: number[] = [];
  private solidN = 0;
  static cameraPos: THREE.Vector3 | null = null;
  /**
   * feel stream: CoD MARKER inputs, written by game.ts every frame. `viewTan` is
   * tan(vertical fov / 2) of the camera the markers are sized for (markers keep
   * a constant on-screen size); `overlays` is false while the endcard is up, so
   * no name tag or chevron draws through its scrim.
   */
  static viewTan = Math.tan((34 * Math.PI) / 180);
  static overlays = true;
  /** BruiserActor.nowMs until which this ENEMY's marker shows (aimed at / just hit). */
  markUntil = -1e9;
  private tagName = "";

  // ------------------------------------------------------------ banana frag
  /** 0 = arm down, THROW_COCK = cocked, 1 = follow-through done. */
  throwP = 0;
  /** True once the throw event fired: the phase now runs on its own. */
  throwing = false;
  /** Latched at release so the frag cannot reappear while the arm returns. */
  thrown = false;
  /** Live weight of the throw overlay (fades in/out of the carry pose). */
  throwW = 0;
  nadeProp: THREE.Mesh | null = null;
  /** L_Hand child that sits on the RENDERED fist (see calibrateGrip). */
  gripNode: THREE.Object3D | null = null;
  gripLocal = new THREE.Matrix4();
  gripOut = new THREE.Vector3(0, 1, 0);
  private throwPose: ThrowPose = { ux: 0, uy: 0, uz: 0, fx: 0, fz: 0, sp: 0 };
  private nadeWorld = new THREE.Vector3();

  /** Make sure the frag prop exists in the left paw (lazily, once loaded). */
  private ensureNadeProp(): void {
    if (this.nadeProp || !nadePropGeo || !nadePropMat) return;
    const hand = this.bones.L_Hand;
    if (!hand) return;
    // The grip frame: L_Hand's child that lands on the rendered paw, with the
    // model's own bind axes (+X the way the Bruiser faces, +Y up).
    const grip = new THREE.Object3D();
    grip.matrixAutoUpdate = false;
    grip.matrix.copy(this.gripLocal);
    hand.add(grip);
    hand.updateWorldMatrix(true, false);
    grip.updateMatrixWorld(true);
    // Grip space is the asset's bind space; this is its metres-per-unit.
    const s = new THREE.Vector3().setFromMatrixScale(grip.matrixWorld).x || 1;
    const m = new THREE.Mesh(nadePropGeo, nadePropMat);
    m.scale.setScalar(NADE_TP_SCALE / s);
    m.position.copy(this.gripOut).multiplyScalar(GRIP_OUT_M / s);
    // Fuze out of the knuckles, leaned GRIP_TILT across the fist (bind-up
    // orthogonalised against the out axis).
    const across = new THREE.Vector3(0, 1, 0)
      .addScaledVector(this.gripOut, -this.gripOut.y)
      .normalize();
    const axis = this.gripOut
      .clone()
      .multiplyScalar(Math.cos(GRIP_TILT))
      .addScaledVector(across, Math.sin(GRIP_TILT))
      .normalize();
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    m.castShadow = true;
    m.visible = false;
    m.name = "tp-frag";
    grip.add(m);
    this.gripNode = grip;
    this.nadeProp = m;
  }

  /** Apparent size of the frag in the paw (1 = true size): NadeFx's birth scale for this thrower. */
  readonly nadeScale = NADE_TP_SCALE;

  /** World position of the frag in the paw — fx.ts blends the throw off it. */
  nadeHandWorld(): THREE.Vector3 {
    const hand = this.bones.L_Hand;
    if (!hand) return this.nadeWorld.copy(this.root.position).setY(this.root.position.y + 1.3);
    hand.updateWorldMatrix(true, false);
    if (this.nadeProp) {
      this.nadeProp.updateWorldMatrix(true, false);
      return this.nadeWorld.set(0, 0, 0).applyMatrix4(this.nadeProp.matrixWorld);
    }
    return this.nadeWorld.setFromMatrixPosition(hand.matrixWorld);
  }

  /** The frag left this actor's paw on this frame. */
  onThrow(): void {
    // Jump to the release key even if the wind-up never arrived (a fast tap on
    // a lossy connection): the arm is forward, and the follow-through sells it.
    this.throwP = Math.max(this.throwP, THROW_RELEASE);
    this.throwing = true;
    this.thrown = true;
    this.throwW = 1;
    // Hidden HERE, not next tick: game.ts calls this after apply() has already
    // set visibility for the frame, and one frame with the frag in the paw AND
    // in the world is one frame of two bananas.
    if (this.nadeProp) this.nadeProp.visible = false;
  }

  /** Tripo clips carry root motion; pin the root horizontally so the mesh stays on the sim position. */
  pinRoot(): void {
    const b = this.bones.Root;
    const bp = this.bindPos.Root;
    if (b && bp) {
      b.position.x = bp.x;
      b.position.z = bp.z;
    }
  }

  /** Test hook: play one raw clip, bypassing locomotion/aim overlays. */
  forceClip(clip: string | null, timeScale = 1): void {
    this.forced = clip;
    // A forced clip is the raw clip: the leg-yaw joint has no say in it.
    this.legYaw = 0;
    this.legRev = false;
    this.legJoint?.quaternion.identity();
    if (clip) {
      const a = this.actions.get(clip);
      if (a) {
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.clampWhenFinished = false;
        a.timeScale = timeScale;
      }
      this.play(clip, 0.1);
    }
  }

  ally = false;
  private relationSet = false;
  private relationMode = "";
  /** Per-actor material clones (body) — owned by this actor, disposed with it. */
  private actorMats: THREE.Material[] = [];

  /**
   * Friend-or-foe, the whole package: chevron colour, whether it reads through
   * walls (allies yes — you must never lose your squad; enemies no — a red
   * marker through a container is a wallhack), the ally name tag, and a faint
   * team emissive on the body itself. Called every frame from game.ts (the
   * old construct-time-only call latched a wrong relation forever when the
   * actor was built before me()/the server's mode correction resolved), so it
   * no-ops unless the relation actually changed.
   */
  setRelation(ally: boolean): void {
    // A colour-vision change repaints the chevron and tag too
    const mode = prefs().colorMode;
    if (this.relationSet && this.ally === ally && this.relationMode === mode) return;
    this.relationSet = true;
    this.relationMode = mode;
    this.ally = ally;
    const cm = this.chevron.material as THREE.SpriteMaterial;
    cm.map = chevronTexture(ally);
    cm.depthTest = !ally;
    cm.needsUpdate = true;
    // feel stream: the name tag follows the relation — blue through walls for a
    // squadmate, red and depth-tested for an enemy (shown only while relevant).
    const nm = this.nameTag.material as THREE.SpriteMaterial;
    nm.depthTest = !ally;
    nm.needsUpdate = true;
    if (nm.map) {
      paintName(nm.map.image as HTMLCanvasElement, this.tagName, ally);
      nm.map.needsUpdate = true;
    }
    // Resolve the body materials AT APPLY TIME instead of through a snapshot
    // list: the EVA suit replaces body materials during construction, and any
    // later swap left a list pointing at orphans (the relation tint and the ally
    // shorts never reached the player). setRelation only runs on a real change
    // (the early return above), so this traverse is not a per-frame cost.
    const tintHex = ally ? 0xffb830 : 0xff2a18;
    const suitK = activeMap().id === "ares" ? 0.3 : 1;
    const tc = teamColors();
    // Iterate the OWNED materials (body clones + the suit materials adopted after
    // dressing). A traverse would also reach the EVA gear, whose materials are
    // module singletons shared by every actor — tinting those repaints all of them.
    for (const mat of this.actorMats) {
      {
        const m = mat as THREE.Material & {
          color?: THREE.Color;
          map?: THREE.Texture | null;
          colorNode?: unknown;
          emissive?: THREE.Color;
          emissiveIntensity?: number;
          userData: Record<string, unknown>;
        };
        if (m.emissive && m.color) {
          m.emissive.setHex(tintHex);
          // ARES suits carry team bands; an additive glow on white fabric reads
          // as a pink astronaut, so the relation cue is kept faint there.
          m.emissiveIntensity = (ally ? 0.05 : 0.1) * suitK;
        } else if (m.color) {
          // Absolute, from the stored base: lerping the live colour in place
          // compounded on every flip (ally -> enemy -> ally drifted darker).
          const base = (m.userData.__baseColor as THREE.Color | undefined) ?? m.color.clone();
          m.userData.__baseColor = base;
          m.color.copy(base).lerp(new THREE.Color(tintHex), ally ? 0.05 : 0.1);
        }
        // TEAM DRESSING: blue shorts for the own team (enemies keep the authored
        // red map). Only where the map is sampled directly — the node suit bakes
        // its texture into colorNode, so swapping `.map` there would no-op.
        if (m.map && !m.colorNode) {
          const orig = (m.userData.__origMap as THREE.Texture | undefined) ?? m.map;
          m.userData.__origMap = orig;
          m.map = ally ? shortsTextureFor(orig, tc.ally) : orig;
          m.needsUpdate = true;
        }
      }
    }
    this.eva?.setAlly(ally);
  }

  /** Brief flinch when this character takes a hit. */
  onHit(): void {
    this.hitT = 1;
    this.hitSide = Math.random() > 0.5 ? 1 : -1;
  }

  constructor(p: PlayerSnap, tpl: BruiserTemplate) {
    this.id = p.id;
    this.root.rotation.order = "YXZ";
    this.body = skeletonClone(tpl.scene) as THREE.Group;
    this.body.scale.setScalar(tpl.scale);
    this.body.position.set(tpl.xOff, 0, tpl.zOff);
    this.holder.position.y = tpl.yOff;
    // Tripo bind pose faces +X; game convention is +Z forward.
    this.holder.rotation.y = BASE_YAW;
    this.holder.add(this.body);
    this.root.add(this.holder);
    this.mixer = new THREE.AnimationMixer(this.body);
    for (const [name, clip] of tpl.clips) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      if (name === "dive" || name === "jump" || name === "sit" || name === "fall" || name === "hurt" || name === "cheer") {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.actions.set(name, a);
    }
    this.bones = collectBones(this.body);
    // THE LEG-YAW JOINT. This rig splits at Hip: both thighs hang off Pelvis and
    // the whole spine off Waist. Splicing an owned node in above Pelvis gives the
    // lower body a yaw hinge that moves nothing over the belt — and keeps it out
    // of the mixer's way. (Composing the yaw onto Pelvis.quaternion itself does
    // NOT work: these clips carry a CONSTANT Pelvis track, and three skips a
    // property write whose value has not changed, so the rotation would compound
    // frame after frame — measured, the legs spun at 90 deg per frame.) Skinning
    // reads bone.matrixWorld, which walks the extra node like any other parent.
    const pelvisB = this.bones.Pelvis;
    if (pelvisB?.parent) {
      const joint = new THREE.Group();
      joint.name = "legYawJoint";
      pelvisB.parent.add(joint);
      joint.add(pelvisB);
      this.legJoint = joint;
    }
    for (const [n, b] of Object.entries(this.bones)) this.bind[n] = b.quaternion.clone();
    for (const n of ["Root", "Armature", "Hip"]) {
      const b = this.bones[n];
      if (b) this.bindPos[n] = b.position.clone();
    }
    // Precompute the aim pose quaternions (bind ∘ tuned rotations): the spine and
    // head overlay, and the SEED both arms are solved from every frame.
    applyAimStatic(this.bones, this.bind);
    for (const n of AIM_BONES) if (this.bones[n]) this.aimQuat[n] = this.bones[n]!.quaternion.clone();
    for (const n of [...CARRY_BONES, ...SUPPORT_BONES]) {
      const b = this.bones[n];
      if (b) this.seedQuat[n] = (this.aimQuat[n] ?? this.bind[n] ?? b.quaternion).clone();
    }
    applyCarryStatic(this.bones, this.bind, SPRINT_CARRY);
    for (const n of CARRY_BONES) if (this.bones[n]) this.sprintQuat[n] = this.bones[n]!.quaternion.clone();
    for (const [n, b] of Object.entries(this.bones)) if (this.bind[n]) b.quaternion.copy(this.bind[n]!);
    for (const n of OVERLAY_BONES) {
      const b = this.bones[n];
      if (b) this.latch.push({ b, mix: b.quaternion.clone(), out: b.quaternion.clone() });
    }
    this.hipMixX = this.hipOutX = this.bones.Hip?.position.x ?? 0;
    this.hipMixY = this.hipOutY = this.bones.Hip?.position.y ?? 0;
    this.hipMixZ = this.hipOutZ = this.bones.Hip?.position.z ?? 0;
    // PER-ACTOR MATERIALS, cloned off the shared template set so setRelation
    // can tint THIS monkey without recolouring every clone on the map. Maps
    // stay shared (clone() keeps texture references); dispose() releases the
    // clones. The tint itself is a faint emissive — red for hostiles, warm
    // amber for squad — readable in a glance at spitting distance without
    // repainting the character art.
    const cloneMaterial = (m: THREE.Material): THREE.Material => {
      const c = m.clone();
      this.actorMats.push(c);
      return c;
    };
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(cloneMaterial);
      } else {
        mesh.material = cloneMaterial(mesh.material);
      }
    });
    // ARES dresses the same operator in an EVA suit; the weapons are the same
    // everywhere. Team bands follow the relation via setRelation (initially
    // the enemy default, corrected on the first per-frame call in game.ts).
    if (activeMap().id === "ares") {
      this.eva = attachAstronaut(this.body, this.bones, false);
      // The suit swaps the body materials for fresh node materials. Adopt them
      // so they are tinted and disposed like the clones they replaced — but never
      // the EVA gear: those materials are module singletons shared by every
      // actor, and tinting them would repaint all of them (last writer wins).
      const owned = new Set(this.actorMats);
      this.body.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material || mesh.userData.evaGear) return;
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (mat && !owned.has(mat)) {
            owned.add(mat);
            this.actorMats.push(mat);
          }
        }
      });
    }
    // Record the tint/shorts materials AFTER the suit has been dressed. The EVA
    // skin swap replaces body materials with fresh node materials on WebGPU, so
    // collecting them during the clone pass left these records pointing at
    // THE GUN MOUNT: a frame on R_Hand whose local space IS gun space (metres),
    // so the operator's gun — whichever it is — just sits at its origin.
    const m = tpl.gunMount;
    this.mount = m;
    this.gunMount.name = "tp-gun-mount";
    this.gunMount.matrixAutoUpdate = false;
    this.gunMount.matrix.compose(m.fist, m.basis, new THREE.Vector3(m.unit, m.unit, m.unit));
    this.bones.R_Hand?.add(this.gunMount);
    this.fistL.setFromMatrixPosition(tpl.gripLocal);
    this.fistReachL = this.fistL.length() / m.unit;
    this.tplScale = tpl.scale;
    this.gaitMid = tpl.gaitMid;
    this.gripLocal.copy(tpl.gripLocal);
    this.gripOut.copy(tpl.gripOut);
    // Relation chevron above the head (ally amber / enemy red), set via setRelation.
    this.chevron = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: chevronTexture(false), transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.chevron.scale.setScalar(0.26);
    this.chevron.position.y = 2.12;
    this.root.add(this.chevron);
    // Ally name tag above the chevron — through walls like the chevron, so a
    // monkey you can see but cannot name is by definition an enemy.
    this.nameTag = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: nameTexture(p.name),
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.nameTag.scale.set(1.18, 0.26, 1);
    this.nameTag.position.y = 2.44;
    this.nameTag.visible = false;
    this.root.add(this.nameTag);
    this.tagName = p.name;
    // (The 3P muzzle flash is WeaponFx's — game.ts fires it at exitPoint().)
    this.showGun(p.weapon || "ar");
    this.play("idle", 0);
    this.mixer.update(0);
    // The chest frame's rest orientation (see HOLD `follow`): measured in the
    // idle pose, so a carried gun rides only what the gait adds to it.
    this.root.updateMatrixWorld(true);
    const sp = this.bones.Spine02;
    if (sp) this.chestRest.copy(sp.getWorldQuaternion(this.tmpQ)).invert();
    this.yawVis = p.yaw;
  }

  /**
   * Cross-fade to one clip. THE INVARIANT: when this returns, `name` is running
   * and on its way to weight 1 — whatever state it was in on the way in.
   *
   * That used to be false, and it is what produced the "spastic back flip".
   * three's AnimationAction.isRunning() is ALSO true for an action that is
   * mid-FADE-OUT: `enabled` is only cleared once the out-ramp actually lands on
   * zero. So re-entering a gait inside its own cross-fade (a bot re-crossing the
   * 3.3 / 0.25 m/s threshold within 0.16 s) hit the `!next.isRunning()` guard,
   * skipped the restart, and left the pending fade-out in flight. The clip we had
   * just asked for decayed to weight 0 and three disabled it, while the clip we
   * were leaving had been told to fade out too — leaving NOTHING running.
   *
   * With every action at weight 0 the mixer accumulates cumulativeWeight 0, and
   * three's PropertyMixer then stops calling setValue() on the bones altogether
   * (accu0 === accu1 from the second such frame). The skeleton freezes at the
   * last value WE left on it, so every relative post-mixer edit in apply() below
   * re-applies to its own output and compounds: the aim-pitch write on Spine01
   * somersaulted the whole torso at ~2.75 deg per rendered frame and the stride
   * amplifier re-amplified the legs past 180 deg into garbage. It self-healed on
   * the next loco change (by then the action really was disabled, so this took
   * the restart branch), which is exactly why it read as a transient spasm.
   */
  play(name: string, fade = 0.16): void {
    const next = this.actions.get(name);
    if (!next) return;
    for (const [n, a] of this.actions) {
      if (n === name) continue;
      if (a.isRunning()) fadeWeight(a, 0, fade);
      // Finished clamped one-shots (fall/hurt/…) report !isRunning() but keep
      // full weight — left alone they blend into every later pose (the killcam
      // "T-pose" respawn bug). Stop them outright.
      else if (a.getEffectiveWeight() > 0) a.stop();
    }
    if (!next.isRunning()) {
      next.reset().setEffectiveWeight(1);
      // Start cyclic gaits mid-stride so short segments read as walking immediately.
      if (name === "walk" || name === "run") next.time = next.getClip().duration * 0.3;
      if (fade > 0) next.fadeIn(fade);
      next.play();
    } else {
      // Already playing — but possibly on its way OUT. Cancel that ramp and take
      // it back to full weight from wherever it is. Its clip time is untouched,
      // so re-entering a gait picks the stride up where it left off instead of
      // restarting the cycle (and if it was already at weight 1 this is a no-op,
      // which is what walk -> crouchwalk relies on).
      fadeWeight(next, 1, fade);
    }
  }

  /**
   * True while at least one action is running AND carries weight, i.e. the mixer
   * will actually write the skeleton this frame. An action that is fading always
   * has base weight 1 (see fadeWeight), and three clears `enabled` — and with it
   * isRunning() — the instant a fade-out lands, so this is exactly the "the mixer
   * is about to accumulate nothing" test.
   */
  private mixerDriven(): boolean {
    for (const a of this.actions.values()) if (a.isRunning() && a.weight > 1e-4) return true;
    return false;
  }

  /**
   * Re-base the overlay bones on what the MIXER actually produced this frame.
   *
   * Everything after mixer.update() in apply() is a RELATIVE edit — a rotateX, an
   * amplification of the live pose, a hip-drop decrement. Those are only ever safe
   * because the mixer overwrites the bone first and wipes the previous frame's
   * edit. When it does not — nothing weighted left running (the bug play() now
   * prevents), a bone no clip carries a track for, or a constant track three skips
   * because the value has not changed — the edit lands on its own output and
   * compounds. A steady couple of degrees a frame is a somersault inside a second.
   *
   * So keep both numbers per bone. If the bone comes back bit-identical to what WE
   * left on it, the mixer did not write it: restore its last real mixer output and
   * every edit below is idempotent again. (If the mixer legitimately reproduces our
   * value, writing back the identical number is a no-op.)
   *
   * This is not only a net for the dead-mixer case: it fires in ordinary play too.
   * Disabling it makes qa/capture.mjs tp-shoot, tp-crouch and tp-aim-pitch come out
   * BYTE-IDENTICAL to the pre-fix build, i.e. those poses were already drifting on
   * the bones three skips for having an unchanged track value — the 3P recoil kick
   * accumulating on the gun arm being the visible one.
   */
  private latchPose(): void {
    for (const l of this.latch) {
      const q = l.b.quaternion;
      if (!qFinite(q)) q.copy(l.mix);
      if (this.latchOn && q.x === l.out.x && q.y === l.out.y && q.z === l.out.z && q.w === l.out.w) q.copy(l.mix);
      else l.mix.copy(q);
    }
    // Hip.position carries the additive crouch drop (z) and the lean slide
    // (x, y) and has the same hazard.
    const hip = this.bones.Hip;
    if (hip) {
      if (!Number.isFinite(hip.position.x)) hip.position.x = this.hipMixX;
      if (!Number.isFinite(hip.position.y)) hip.position.y = this.hipMixY;
      if (!Number.isFinite(hip.position.z)) hip.position.z = this.hipMixZ;
      if (this.latchOn && hip.position.x === this.hipOutX && hip.position.y === this.hipOutY && hip.position.z === this.hipOutZ) {
        hip.position.x = this.hipMixX;
        hip.position.y = this.hipMixY;
        hip.position.z = this.hipMixZ;
      } else {
        this.hipMixX = hip.position.x;
        this.hipMixY = hip.position.y;
        this.hipMixZ = hip.position.z;
      }
    }
    this.latchOn = true;
  }

  /**
   * The cycle mean the mixer is ACTUALLY sitting on: walk's and run's, blended by
   * the same weights the mixer used. The mean of a blend of two cycles is the
   * blend of their means, so this is the honest pivot at any point of a
   * cross-fade — and it returns the stored quaternion untouched at either end.
   */
  private midAt(
    mw: Record<string, THREE.Quaternion>,
    mr: Record<string, THREE.Quaternion>,
    n: string,
    t: number,
  ): THREE.Quaternion | null {
    const a = mw[n];
    const b = mr[n];
    if (!a) return b ?? null;
    if (!b || t <= 0) return a;
    if (t >= 1) return b;
    return this.midBlend.copy(a).slerp(b, t);
  }

  /**
   * Fold a leg bone back under LEG_FOLD_MAX of its bind pose (see the ceiling).
   *
   * A slerp toward bind by exactly the excess fraction: the great-circle angle
   * falls linearly in t, so t = 1 - cap/angle lands the bone ON the cap. That is
   * what makes it IDEMPOTENT — run it again on its own output and `angle` is
   * already the cap, the early return fires, and nothing moves. It is therefore
   * safe on a frame where the mixer wrote no bone at all, the failure mode the
   * whole latch below exists for.
   */
  private capFold(name: string): void {
    const b = this.bones[name];
    const bind = this.bind[name];
    if (!b || !bind) return;
    const q = b.quaternion;
    if (!qFinite(q)) return;
    // |dot| folds q and -q onto the same rotation, the branch slerp itself takes.
    const ang = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(bind.dot(q)), 0, 1));
    if (!(ang > LEG_FOLD_MAX)) return;
    q.slerp(bind, 1 - LEG_FOLD_MAX / ang);
    if (!qFinite(q)) q.copy(bind);
  }

  /**
   * WHICH SOLIDS ARE WITHIN ARM'S REACH, once per frame per actor.
   *
   * Cheap because it has to be: a horizontal box-distance from the body centre
   * against the ACTIVE map's solids, keeping the few that a paw could be inside.
   * On Shipment a body in the open keeps none and the wall term below costs
   * nothing at all; in the tightest corner it keeps three.
   *
   * `activeSolids()`, not `SOLIDS` (spec-sim-implemented.md P4). The old import
   * was shared/map.ts's Shipment array by name, so on `?map=dust2` every actor
   * tucked its arms against Shipment's shipping containers — sixty boxes
   * standing invisibly at the world origin, under mid. The two arrays are the
   * same object on Shipment, so nothing about Shipment moves.
   */
  private gatherSolids(): void {
    this.solidN = 0;
    const p = this.root.position;
    const solids = activeSolids();
    // A shouldered gun reaches past an arm: the wall lift needs every solid
    // its muzzle could be in.
    const reach = Math.max(SOLID_REACH, this.gun ? -this.gun.proto.muzzle.z + 0.45 : 0);
    // The broadphase preserves source order and is conservative around rotated
    // boxes. Keep the exact narrowphase below, including the first SOLID_MAX.
    const grid = gridFor(solids);
    const candidates = grid ? gridQueryCircle(grid, p.x, p.z, reach, this.solidCandidates) : null;
    for (let i = 0; i < (candidates?.length ?? solids.length); i++) {
      const o = solids[candidates ? candidates[i]! : i]!;
      // Vertical overlap with the band an arm can occupy (knee to overhead).
      if (o.y + o.sy * 0.5 < p.y + 0.2 || o.y - o.sy * 0.5 > p.y + 2.3) continue;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const c = Math.cos(o.yaw);
      const s = Math.sin(o.yaw);
      const lx = Math.abs(dx * c + dz * s) - o.sx * 0.5;
      const lz = Math.abs(-dx * s + dz * c) - o.sz * 0.5;
      const ox = lx > 0 ? lx : 0;
      const oz = lz > 0 ? lz : 0;
      if (ox * ox + oz * oz > reach * reach) continue;
      this.solids[this.solidN++] = o;
      if (this.solidN >= SOLID_MAX) return;
    }
  }

  /**
   * Push a WORLD point out of any gathered solid it is inside by more than
   * `allow`, along the face it is nearest to leaving.
   *
   * The depth convention is inspect.ts's own — min over the six face distances —
   * so "0 left inside" here and "no CLIP episode" there are the same statement.
   * Returns true if the point moved.
   *
   * `margin` INFLATES the solid before the test, which is how a sample can stand
   * in for the flesh around it: a surface sample carrying its section's covering
   * radius leaves the box that radius clear, so every vertex it covers is out
   * too. Zero for a bare joint, where the point IS the thing being kept out.
   */
  /** How deep a WORLD point is inside the gathered solids (m; 0 = outside all). */
  private solidDepth(p: THREE.Vector3): number {
    let worst = 0;
    for (let i = 0; i < this.solidN; i++) {
      const o = this.solids[i]!;
      const c = Math.cos(o.yaw);
      const s = Math.sin(o.yaw);
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const ax = o.sx * 0.5 - Math.abs(dx * c + dz * s);
      const az = o.sz * 0.5 - Math.abs(-dx * s + dz * c);
      const aT = o.y + o.sy * 0.5 - p.y;
      const aB = p.y - (o.y - o.sy * 0.5);
      if (ax <= 0 || az <= 0 || aT <= 0 || aB <= 0) continue;
      const d = Math.min(ax, az, aT, aB);
      if (d > worst) worst = d;
    }
    return worst;
  }

  private pushOutOfSolids(p: THREE.Vector3, allow: number, margin = 0): boolean {
    let moved = false;
    for (let i = 0; i < this.solidN; i++) {
      const o = this.solids[i]!;
      const c = Math.cos(o.yaw);
      const s = Math.sin(o.yaw);
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const lx = dx * c + dz * s;
      const lz = -dx * s + dz * c;
      const ax = o.sx * 0.5 + margin - Math.abs(lx);
      const az = o.sz * 0.5 + margin - Math.abs(lz);
      const aT = o.y + o.sy * 0.5 + margin - p.y;
      const aB = p.y - (o.y - o.sy * 0.5 - margin);
      if (ax <= 0 || az <= 0 || aT <= 0 || aB <= 0) continue;
      const d = Math.min(ax, az, aT, aB);
      if (d <= allow) continue;
      const out = d - allow + 0.004; // a hair past the face, never exactly on it
      if (d === ax) {
        const sgn = lx > 0 ? out : -out;
        p.x += sgn * c;
        p.z += sgn * s;
      } else if (d === az) {
        const sgn = lz > 0 ? out : -out;
        p.x += -sgn * s;
        p.z += sgn * c;
      } else if (d === aT) {
        p.y += out;
      } else {
        p.y -= out;
      }
      moved = true;
    }
    return moved;
  }

  /**
   * THE LIMB BUDGET, SOLVED. Swing one arm at the shoulder until nothing hanging
   * off it — elbow, wrist, the flesh around them, or the barrel they carry — is
   * outside the body-relative envelope OR inside a solid the capsule is legally
   * clear of.
   *
   * Both terms reduce to the same question: WHERE SHOULD THIS POINT BE INSTEAD.
   * For each tip, clamp it into the envelope box (root space, x and z, height
   * untouched — the budget is horizontal and an arm is not raised to satisfy it),
   * then push that clamped point out of any nearby solid (world space, along the
   * face it is nearest to leaving). The tip needing the largest move wins the
   * pass, and the whole arm rotates rigidly about the shoulder to send it there —
   * the same thing a shoulder does, and the smallest rotation that does it
   * (`setFromUnitVectors` of the two directions). Because the envelope and a box
   * are both CONVEX and these are the two ends of the forearm, pinning both pins
   * every twist bone between them without measuring any of them.
   *
   * THREE KINDS OF TIP, and the difference is which term each answers:
   *   JOINTS   (`arm.tips`)    both terms — the silhouette envelope and walls.
   *   SURFACE  (`arm.hullPts`) walls ONLY, with the section's covering radius as
   *                            the solid's inflation, so the sample stands in for
   *                            the flesh around it. Infinite envelope, so it can
   *                            never narrow what a player shoots at.
   *   BARREL   (two bore samples) both terms, with the gun's own wider box and
   *                            its deliberate aim-time wall allowance.
   *
   * AND THE JOINTS GET THE LAST WORD — see the two-phase loop below. Only the
   * largest violation drives a pass, so a big surface correction can hide a
   * small joint one underneath it and leave a paw in a container. It is measured
   * behaviour, not a worry: adding the surface term took the drawn arm from
   * 0.162 m to 0.089 m inside a wall and simultaneously put the R_Hand JOINT
   * 0.089 m inside one, which is a CLIP episode the previous build did not have.
   *
   * IDEMPOTENT, which is the property that matters in this file. Every correction
   * is computed from where the tips ARE, not from how far they moved: an arm
   * already inside returns before touching a quaternion, and an arm pushed onto
   * the boundary reads back as inside on the next pass. Re-running it on its own
   * output — which is exactly what happens on a frame where three skipped a bone,
   * the dead-mix bug this file was rebuilt around — changes nothing. It needs no
   * latch to be safe, and it is inert in the common case.
   *
   * MONOTONE. The target can be unreachable (this rig's shoulder JOINT sits
   * 0.40-0.46 m off the centreline on its own, further out than the lateral
   * budget), so each pass is measured: a pass that does not shrink the worst
   * violation is rolled back and the solve stops. That, plus the per-pass turn
   * cap, is what keeps an unsatisfiable ask from wrapping a limb round the body.
   *
   * `scale` widens the envelope for a pose that has earned it (the overhand).
   */
  private tuckArm(arm: ExtentArm, scale: number): void {
    const shoulderName = arm.shoulder;
    const tipNames = arm.tips;
    const sh = this.bones[shoulderName];
    const parent = sh?.parent;
    const wrist = this.bones[tipNames[tipNames.length - 1]!];
    if (!sh || !parent || !wrist) return;
    // The support paw ON the gun is budgeted as part of the gun it holds.
    const onGun = arm.shoulder === "L_Upperarm" ? this.supW * (1 - this.throwW) * (1 - this.lowW) : 0;
    const latR = arm.lat * scale + (GUN_EXTENT.lat - arm.lat) * Math.max(0, onGun);
    const fwdR = arm.fwd * scale + Math.max(0, GUN_EXTENT.fwd - arm.fwd + GUN_AIM_SLACK.fwd * this.aimW) * onGun;
    const gun = arm.gun;
    // A shouldered rifle's muzzle is out where the gun's length puts it: the aim
    // slack grows with THIS gun's bore length (a sniper is a metre of barrel).
    // The box was measured on the launcher's 0.42 m of barrel past the fist; a
    // longer gun carried at the same angle reaches its own length further.
    const len = this.gun ? -this.gun.proto.muzzle.z : 0.42;
    const gunLat = GUN_EXTENT.lat * scale + GUN_AIM_SLACK.lat * this.aimW;
    const gunFwd = (GUN_EXTENT.fwd + Math.max(0, len - 0.42)) * scale + Math.max(GUN_AIM_SLACK.fwd, len + 0.4 - GUN_EXTENT.fwd) * this.aimW;
    const gunAllow = GUN_WALL_ALLOW * this.aimW;
    const barrel = gun ? this.barrelLocal : null;
    const hull = arm.hullPts;
    // TWO PHASES, because the two rules are not equal. Phase 0 solves the whole
    // budget, surface included. Phase 1 re-solves with the SURFACE SAMPLES
    // REMOVED, and it exists because measurement caught the surface term paying
    // for itself with the thing this file calls the bug: a rigid arm rotation
    // that pulls a deltoid out of a wall can push the wrist INTO one, and only
    // the largest violation drives a pass, so a 0.20 m surface win hid a 0.089 m
    // R_Hand joint penetration underneath it — a CLIP episode, created by the
    // fix. Flesh in a container is an objective; a PAW in a container is a
    // defect, so the paw gets the last word. Phase 1 is inert whenever phase 0
    // left no joint violating, which is the overwhelming majority of frames.
    let moved = false;
    for (let phase = 0; phase < 2; phase++) {
      // Phase 1 exists only to undo what phase 0 might have done to a joint, so
      // an arm phase 0 never touched needs no second look. That is the common
      // case — nothing near a wall, nothing outside the envelope — and skipping
      // it keeps the whole budget at one subtree refresh per arm per frame.
      if (phase === 1 && (!moved || !hull.length)) break;
      const hullN = phase === 0 ? hull.length : 0;
      const nTips = tipNames.length + hullN + (barrel ? 2 : 0);
      let prev = Infinity;
      pass: for (let it = 0; it < EXTENT_ITERS; it++) {
        // One walk over the shoulder's own subtree freshens every matrix the tips
        // read — the elbow and wrist ON the chain, and the twist bones the
        // surface samples ride, which hang OFF it and a wrist-to-root walk never
        // touches. Nothing the renderer would not touch anyway.
        sh.updateWorldMatrix(true, true);
        this.extInv.copy(this.root.matrixWorld).invert();
        this.extS.setFromMatrixPosition(sh.matrixWorld).applyMatrix4(this.extInv);
        let worst = 0;
        for (let t = 0; t < nTips; t++) {
          let lat = latR;
          let fwd = fwdR;
          let allow = 0;
          let margin = 0;
          if (t < tipNames.length) {
            const b = this.bones[tipNames[t]!];
            if (!b) continue;
            this.extW.setFromMatrixPosition(b.matrixWorld);
          } else if (t < tipNames.length + hullN) {
            // A drawn-surface point, in its own bone's frame, standing in for the
            // flesh within its section's covering radius. WALL TERM ONLY: the
            // infinite envelope makes the clamp below a no-op, so this sample can
            // only ever push flesh out of a solid, never narrow the silhouette.
            const hp = hull[t - tipNames.length]!;
            const b = this.bones[hp.bone];
            if (!b) continue;
            this.extW.copy(hp.local).applyMatrix4(b.matrixWorld);
            lat = Infinity;
            fwd = Infinity;
            margin = hp.cover;
          } else {
            // The barrel, sampled at the bore centre and half way down it, in the
            // gun hand's own frame — the drawn geometry, not the joint holding it.
            this.extW.copy(barrel!);
            if (t === tipNames.length + hullN) this.extW.multiplyScalar(0.55);
            this.extW.applyMatrix4(wrist.matrixWorld);
            lat = gunLat;
            fwd = gunFwd;
            allow = gunAllow;
          }
          this.extP.copy(this.extW).applyMatrix4(this.extInv);
          if (!Number.isFinite(this.extP.x + this.extP.y + this.extP.z)) return;
          this.extT.set(
            THREE.MathUtils.clamp(this.extP.x, -lat, lat),
            this.extP.y,
            THREE.MathUtils.clamp(this.extP.z, -fwd, fwd),
          );
          if (this.solidN > 0) {
            this.extW.copy(this.extT).applyMatrix4(this.root.matrixWorld);
            if (this.pushOutOfSolids(this.extW, allow, margin)) this.extT.copy(this.extW).applyMatrix4(this.extInv);
          }
          const d = this.extT.distanceTo(this.extP);
          if (d > worst) {
            worst = d;
            this.extWorst.copy(this.extP);
            this.extGoal.copy(this.extT);
          }
        }
        // Inside everything (or a pass that cannot improve on the last one).
        if (!(worst > 0.0005) || !(worst < prev - 0.0005)) {
          if (it > 0 && worst >= prev) sh.quaternion.copy(this.extQ0);
          break pass;
        }
        prev = worst;
        this.extQ0.copy(sh.quaternion);
        this.extA.copy(this.extWorst).sub(this.extS);
        this.extB.copy(this.extGoal).sub(this.extS);
        if (this.extA.lengthSq() < 1e-8 || this.extB.lengthSq() < 1e-8) break pass;
        this.extQ.setFromUnitVectors(this.extA.normalize(), this.extB.normalize());
        const turn = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(this.extQ.w), 0, 1));
        if (turn > arm.turn) {
          this.extQC.identity().slerp(this.extQ, arm.turn / turn);
          this.extQ.copy(this.extQC);
        }
        // The swing is derived in ROOT space; the bone is written in its PARENT's.
        // With Pr the parent frame expressed in root space, the same rotation is
        // Pr^-1 q Pr there.
        parent.getWorldQuaternion(this.extQP);
        this.root.getWorldQuaternion(this.extQC);
        this.extQC.invert().multiply(this.extQP); // Pr
        this.extQP.copy(this.extQC).invert().multiply(this.extQ).multiply(this.extQC);
        if (!qFinite(this.extQP)) return;
        sh.quaternion.premultiply(this.extQP);
        if (!qFinite(sh.quaternion)) {
          sh.quaternion.copy(this.bind[shoulderName] ?? sh.quaternion);
          return;
        }
        moved = true;
      }
    }
  }

  /** Record what the overlays left the latched bones at, for next frame's re-base. */
  private stampPose(): void {
    for (const l of this.latch) {
      const q = l.b.quaternion;
      if (!qFinite(q)) q.copy(l.mix);
      l.out.copy(q);
    }
    const hip = this.bones.Hip;
    if (hip) {
      if (!Number.isFinite(hip.position.x)) hip.position.x = this.hipMixX;
      if (!Number.isFinite(hip.position.y)) hip.position.y = this.hipMixY;
      if (!Number.isFinite(hip.position.z)) hip.position.z = this.hipMixZ;
      this.hipOutX = hip.position.x;
      this.hipOutY = hip.position.y;
      this.hipOutZ = hip.position.z;
    }
    // The leg-yaw splice is an absolute setFromAxisAngle, but it inverts Hip's
    // live world quaternion to find its axis — repair rather than ship a NaN
    // subtree, which would take the whole lower body out of the scene.
    const j = this.legJoint;
    if (j && !qFinite(j.quaternion)) j.quaternion.identity();
  }

  // ---------------------------------------------------------- the weapon hold
  /** Frame on R_Hand whose local space is gun space (see BruiserTemplate.gunMount). */
  gunMount = new THREE.Group();
  private mount!: BruiserTemplate["gunMount"];
  /** One model per weapon this operator has drawn (normally its primary + pistol). */
  private guns = new Map<string, { root: THREE.Group; proto: TpGunProto }>();
  private gun: { root: THREE.Group; proto: TpGunProto } | null = null;
  /** Id of the model actually drawn — lags the snapshot through a swap's lower. */
  shownGun = "";
  /** The muzzle in R_Hand space (the limb budget's barrel samples). */
  private barrelLocal = new THREE.Vector3(0, 0.1, 0.3);
  /** 0..1: the swap's lower-and-raise (driven by the snapshot's `swap`). */
  lowW = 0;
  /** 0..1: the reload presentation. */
  reloadW = 0;
  /** 0..1: the gun lifted off a wall its muzzle would be inside. */
  liftW = 0;
  /** Live support-hand weight the last solve used. */
  supW = 0;
  /** Body yaw the aim stance blades to (rad, by gun class). */
  bladeYaw = 0;
  /** The support paw's rendered fist centre, in L_Hand space, and its distance from the wrist (m). */
  private fistL = new THREE.Vector3();
  private fistReachL = 0.08;
  /** Inverse of Spine02's idle world rotation (actor at the origin, unrotated). */
  private chestRest = new THREE.Quaternion();
  /** Scratch for the hold solve — nothing in it allocates per frame. */
  private hN = new THREE.Vector3();
  private hP = new THREE.Vector3();
  private hP2 = new THREE.Vector3();
  private hT = new THREE.Vector3();
  private hPole = new THREE.Vector3();
  private hQ = new THREE.Quaternion();
  private hQ2 = new THREE.Quaternion();
  private hQb = new THREE.Quaternion();
  private hRoot = new THREE.Quaternion();
  private hChest = new THREE.Quaternion();
  private hInv = new THREE.Matrix4();
  private hE = new THREE.Euler();
  private poseA: HoldFrame = { p: new THREE.Vector3(), q: new THREE.Quaternion(), r: new THREE.Vector3(), l: new THREE.Vector3(), sup: 0, blade: 0 };
  private poseB: HoldFrame = { p: new THREE.Vector3(), q: new THREE.Quaternion(), r: new THREE.Vector3(), l: new THREE.Vector3(), sup: 0, blade: 0 };
  private poseC: HoldFrame = { p: new THREE.Vector3(), q: new THREE.Quaternion(), r: new THREE.Vector3(), l: new THREE.Vector3(), sup: 0, blade: 0 };
  private supPre: THREE.Quaternion[] = SUPPORT_BONES.map(() => new THREE.Quaternion());
  /** QA: the gun's turn off the hold right after the solve [0] and after the trigger arm's budget [1] (rad). */
  holdTurn: [number, number] = [0, 0];
  private gunTurn(k: 0 | 1): void {
    if (!this.gun) return;
    this.gunMount.updateWorldMatrix(true, false);
    this.gunMount.matrixWorld.decompose(this.hP, this.hQ, this.hP2);
    this.holdTurn[k] = this.hQ.angleTo(this.holdQ);
  }
  /** QA: [gun placement error (m), support fist error (m), trigger-arm reach shortfall (m), gun aim error after the budget (rad)]. */
  holdErr: [number, number, number, number] = [0, 0, 0, 0];
  private holdQ = new THREE.Quaternion();

  /** Put weapon `id` in the fist (built once per id per operator, then just shown). */
  showGun(id: string): void {
    if (id === this.shownGun && this.gun) return;
    let g = this.guns.get(id);
    if (!g) {
      g = tpGun(id);
      this.guns.set(id, g);
      this.gunMount.add(g.root);
    }
    for (const [k, o] of this.guns) o.root.visible = k === id;
    this.gun = g;
    this.shownGun = id;
    mountPoint(this.mount, g.proto.muzzle, this.barrelLocal);
  }

  /**
   * Which model is drawn, and how far through a swap the hands are.
   *
   * The snapshot flips `weapon` the instant a swap starts and counts `swap` down
   * through the RAISE. Everyone else should see the swap, so the first half of
   * that window lowers the OLD gun out of the shot, the model changes at the
   * bottom, and the second half raises the new one — all of it read off the
   * snapshot, so a killcam replay or a late joiner draws the same thing.
   */
  private updateGun(p: PlayerSnap, dt: number): void {
    const want = p.weapon || this.shownGun || "ar";
    const total = WEAPON_BY_ID[want]?.swap ?? 0.4;
    const left = Number.isFinite(p.swap) ? p.swap : 0;
    if (left > 0.004 && total > 0 && this.shownGun) {
      const k = THREE.MathUtils.clamp(left / total, 0, 1);
      let low: number;
      if (k > 0.5 && this.shownGun !== want) low = (1 - k) / 0.5; // the old gun going down
      else {
        this.showGun(want);
        low = Math.min(1, k / 0.5); // the new one coming up
      }
      this.lowW = low * low * (3 - 2 * low);
    } else {
      this.showGun(want);
      this.lowW = Math.max(0, this.lowW - dt * 6);
    }
    this.reloadW = THREE.MathUtils.damp(this.reloadW, p.reload > 0 ? 1 : 0, 10, dt);
  }

  /** A HOLD pose -> gun position + rotation in the actor root's frame. */
  private holdFrame(h: HoldPose, out: HoldFrame): void {
    // body frame: the root's axes riding `follow` of the chest's live rotation
    this.hQb.identity().slerp(this.hChest, h.follow);
    this.hE.set(-h.elev, h.yaw, h.roll, "YXZ");
    out.q.setFromEuler(this.hE).premultiply(this.hQb).multiply(GUN_FWD);
    out.p.set(h.p[0], h.p[1], h.p[2]).applyQuaternion(this.hQb).add(this.hN);
    out.r.set(h.rPole[0], h.rPole[1], h.rPole[2]);
    out.l.set(h.lPole[0], h.lPole[1], h.lPole[2]);
    out.sup = h.sup;
    out.blade = h.blade;
  }

  private mixFrame(a: HoldFrame, b: HoldFrame, t: number, tBlade = t): void {
    if (t > 0) {
      a.p.lerp(b.p, t);
      a.q.slerp(b.q, t);
      a.r.lerp(b.r, t);
      a.l.lerp(b.l, t);
      a.sup += (b.sup - a.sup) * t;
    }
    if (tBlade > 0) a.blade += (b.blade - a.blade) * tBlade;
  }

  /**
   * Place the gun for this frame and solve the TRIGGER arm onto its grip.
   * The support arm is solved separately (solveSupport) after the limb budget
   * has had its say on this arm, so the off paw lands on wherever the gun ended up.
   */
  private solveHold(p: PlayerSnap, dt: number): void {
    const g = this.gun;
    const B = this.bones;
    const up = B.R_Upperarm, fo = B.R_Forearm, ha = B.R_Hand, neck = B.NeckTwist01, sp = B.Spine02;
    if (!g || !up || !fo || !ha || !neck || !sp) return;
    for (const n of CARRY_BONES) {
      const b = B[n];
      const q = this.seedQuat[n];
      if (b && q) b.quaternion.copy(q);
    }
    this.root.updateWorldMatrix(true, true);
    this.hInv.copy(this.root.matrixWorld).invert();
    this.root.matrixWorld.decompose(this.hP, this.hRoot, this.hP2);
    this.hN.setFromMatrixPosition(neck.matrixWorld).applyMatrix4(this.hInv);
    // the chest's live rotation relative to idle, in the root's frame
    sp.matrixWorld.decompose(this.hP, this.hQ, this.hP2);
    this.hChest.copy(this.hRoot).invert().multiply(this.hQ).multiply(this.chestRest);
    if (!qFinite(this.hChest)) this.hChest.identity();
    const set = HOLD[g.proto.cls];
    const A = this.poseA, Bf = this.poseB, C = this.poseC;
    this.holdFrame(set.ready, A);
    // the run: only the support weight, the poles and the blade blend here —
    // the trigger arm itself goes to the FK run key after the solve (below)
    const runW = this.sprintCarryW * (1 - this.aimW);
    const runFk = !!set.sprint.fk;
    if (runW > 0.001) {
      this.holdFrame(set.sprint, Bf);
      if (runFk) {
        A.sup += (Bf.sup - A.sup) * runW;
        A.blade += (Bf.blade - A.blade) * runW;
      } else this.mixFrame(A, Bf, runW);
    }
    {
      // the bore on the aim ray; the butt in the shoulder pocket
      const a = set.aim;
      const pitch = THREE.MathUtils.clamp(Number.isFinite(p.pitch) ? p.pitch : 0, -1.2, 1.2);
      this.hQ2.setFromAxisAngle(XA, pitch);
      C.q.copy(this.hQ2).multiply(GUN_FWD);
      this.hT.set(0, a.drop, -g.proto.butt).applyQuaternion(C.q);
      C.p.set(a.pocket[0], a.pocket[1], a.pocket[2]).add(this.hN).add(this.hT);
      C.r.set(a.rPole[0], a.rPole[1], a.rPole[2]);
      C.l.set(a.lPole[0], a.lPole[1], a.lPole[2]);
      C.sup = a.sup;
      C.blade = a.blade;
    }
    // the stance blades on the rate-limited body turn, the gun on the damped aim
    if (this.aimW > 0.001 || this.aimYawW > 0.001) this.mixFrame(A, C, this.aimW > 0.001 ? this.aimW : 0, this.aimYawW);
    const rw = this.reloadW * (1 - this.aimW);
    if (rw > 0.001) {
      this.holdFrame(set.reload, Bf);
      this.mixFrame(A, Bf, rw);
    }
    if (this.throwW > 0.001) {
      this.holdFrame(set.one, Bf);
      this.mixFrame(A, Bf, this.throwW);
    }
    if (this.lowW > 0.001) {
      this.holdFrame(set.low, Bf);
      this.mixFrame(A, Bf, this.lowW);
    }
    // WALL LIFT. Walk the barrel (a third, two thirds, the crown) against the
    // solids within reach; a muzzle that would be inside one lifts the gun up
    // across the chest instead — what a body does, and what keeps the barrel
    // out of the wall without the limb budget wrenching the arm around. Measured
    // on the pose BEFORE the lift, so the lift cannot feed back into itself.
    let depth = 0;
    if (this.solidN > 0) {
      const len = -g.proto.muzzle.z;
      this.root.updateWorldMatrix(false, false);
      for (const f of LIFT_SAMPLES) {
        this.hT.set(0, g.proto.bore, -len * f).applyQuaternion(A.q).add(A.p).applyMatrix4(this.root.matrixWorld);
        const d = this.solidDepth(this.hT);
        // a hit nearer the grip means the wall is closer: lift harder
        if (d > 0) depth = Math.max(depth, d + (1 - f) * 0.12);
      }
    }
    const liftWant = THREE.MathUtils.clamp(depth / 0.22, 0, 1);
    this.liftW = THREE.MathUtils.damp(this.liftW, liftWant, liftWant > this.liftW ? 16 : 6, dt);
    if (this.liftW > 0.001) {
      this.holdFrame(set.lift, Bf);
      this.mixFrame(A, Bf, this.liftW, 0);
    }
    // per-shot kick: back along the bore, muzzle climbing
    if (this.kick > 0.001) {
      const kk = KICK[g.proto.id] ?? KICK.ar!;
      const k = this.kick * this.aimW;
      this.hT.set(0, 0, kk[0] * k).applyQuaternion(A.q);
      A.p.add(this.hT);
      this.hQ2.setFromAxisAngle(XA, kk[1] * k);
      A.q.multiply(this.hQ2);
    }
    this.supW = A.sup;
    // the body yaw this hold wants — applied to the holder NEXT frame (apply()
    // sets the holder and the legs' facing before anything is solved)
    this.bladeYaw = A.blade;
    // to world
    A.p.applyMatrix4(this.root.matrixWorld);
    A.q.premultiply(this.hRoot);
    // the hand that puts this gun there: H = G * M^-1
    const m = this.mount;
    this.hQ.copy(m.basis).invert().premultiply(A.q); // hand world rotation
    this.hT.copy(m.fist).divideScalar(m.unit).applyQuaternion(this.hQ);
    this.hP.copy(A.p).sub(this.hT); // wrist target
    // shoulder rolls forward when the grip is a long reach
    const cl = B.R_Clavicle;
    const reach = this.armReach(up, fo, ha);
    up.updateWorldMatrix(true, false);
    this.hP2.setFromMatrixPosition(up.matrixWorld);
    const d = this.hP2.distanceTo(this.hP);
    if (cl && d > reach * 0.86) {
      leanToward(cl, up, this.hP, (d - reach * 0.86) / (reach * 0.4), 0.3);
      this.hP2.setFromMatrixPosition(up.matrixWorld);
    }
    this.hPole.copy(A.r).applyQuaternion(this.hRoot).add(this.hP2);
    this.holdErr[2] = solveTwoBone(up, fo, ha, this.hP, this.hPole);
    // the elbow inside the limb budget by swivel, so the budget never has to
    // swing the gun to get it there
    swivelElbowIn(up, fo, ha, this.hInv, EXTENT.lat - 0.01);
    setBoneWorldQ(ha, this.hQ);
    // the run key, in FK, over whatever the solve put there
    const fk = (runFk ? runW : 0) * (1 - this.lowW) * (1 - this.throwW) * (1 - this.liftW) * (1 - this.reloadW);
    if (fk > 0.001) {
      for (const n of CARRY_BONES) {
        const b = B[n];
        const q = this.sprintQuat[n];
        if (b && q) b.quaternion.slerp(q, fk);
      }
      this.root.updateWorldMatrix(false, true);
    }
    ha.updateWorldMatrix(false, true);
    // how far the drawn gun ended up from where the hold put it (QA reads this)
    this.gunMount.updateWorldMatrix(true, false);
    this.gunMount.matrixWorld.decompose(this.hT, this.holdQ, this.hP2);
    this.holdErr[0] = fk > 0.001 ? 0 : this.hT.distanceTo(A.p);
    // keep the support pole for solveSupport (root frame)
    this.hPole.copy(A.l);
  }

  /** Shoulder-to-wrist reach of an arm (constant of the rig; measured on first use). */
  private reach: Record<string, number> = {};
  private armReach(up: THREE.Object3D, fo: THREE.Object3D, ha: THREE.Object3D): number {
    const hit = this.reach[up.name];
    if (hit) return hit;
    up.updateWorldMatrix(true, true);
    const a = new THREE.Vector3().setFromMatrixPosition(up.matrixWorld);
    const b = new THREE.Vector3().setFromMatrixPosition(fo.matrixWorld);
    const c = new THREE.Vector3().setFromMatrixPosition(ha.matrixWorld);
    return (this.reach[up.name] = a.distanceTo(b) + b.distanceTo(c));
  }

  /** Put the off paw on the handguard (or under the pistol), blended by supW. */
  private solveSupport(): void {
    const g = this.gun;
    const B = this.bones;
    const up = B.L_Upperarm, fo = B.L_Forearm, ha = B.L_Hand, cl = B.L_Clavicle;
    if (!g || !up || !fo || !ha) return;
    const w = this.supW * (1 - this.throwW) * (1 - this.lowW);
    if (w < 0.005) return;
    for (let i = 0; i < SUPPORT_BONES.length; i++) {
      const b = B[SUPPORT_BONES[i]!];
      if (!b) continue;
      this.supPre[i]!.copy(b.quaternion);
      const q = this.seedQuat[SUPPORT_BONES[i]!];
      if (q) b.quaternion.copy(q);
    }
    // where the fist closes, in world
    const off = SUPPORT_OFF[g.proto.cls];
    this.hT.set(off[0], off[1], off[2]).add(g.proto.fore);
    if (this.reloadW > 0.01 && g.proto.cls === "long") {
      // reload: the paw drops to the magazine under the receiver
      this.hP2.set(-0.01, -0.13, -0.12);
      this.hT.lerp(this.hP2, this.reloadW * (1 - this.aimW));
    }
    this.gunMount.updateWorldMatrix(true, false);
    this.hT.applyMatrix4(this.gunMount.matrixWorld); // the fist's target
    const reach = this.armReach(up, fo, ha);
    up.updateWorldMatrix(true, false);
    this.hP2.setFromMatrixPosition(up.matrixWorld);
    const d = this.hP2.distanceTo(this.hT);
    if (cl && d > reach * 0.8) {
      leanToward(cl, up, this.hT, (d - reach * 0.8) / (reach * 0.4), 0.35);
      this.hP2.setFromMatrixPosition(up.matrixWorld);
    }
    // OUT OF REACH, the paw slides back along the handguard toward the grip —
    // a shorter hold is a real hold; a paw short of the gun is not. (The ape's
    // shoulders are 0.69 m apart on 0.68 m arms: a long gun's far handguard is
    // often simply not there for the left hand.)
    {
      const R = (reach + this.fistReachL) * 0.97;
      this.hN.setFromMatrixPosition(this.gunMount.matrixWorld).sub(this.hT); // D = grip - fore
      const DD = this.hN.lengthSq();
      if (DD > 1e-6) {
        const fx = this.hT.x - this.hP2.x, fy = this.hT.y - this.hP2.y, fz = this.hT.z - this.hP2.z;
        const cc = fx * fx + fy * fy + fz * fz - R * R;
        if (cc > 0) {
          const bb = 2 * (fx * this.hN.x + fy * this.hN.y + fz * this.hN.z);
          const disc = bb * bb - 4 * DD * cc;
          let t = disc >= 0 ? (-bb - Math.sqrt(disc)) / (2 * DD) : -bb / (2 * DD);
          // never into the trigger fist
          const tMax = Math.max(0, 1 - 0.13 / Math.sqrt(DD));
          t = THREE.MathUtils.clamp(t, 0, tMax);
          this.hT.addScaledVector(this.hN, t);
        }
      }
    }
    this.hPole.applyQuaternion(this.hRoot).add(this.hP2);
    // two passes: solve the WRIST, then correct by where the drawn FIST landed
    this.hP.copy(this.hT);
    for (let it = 0; it < 3; it++) {
      solveTwoBone(up, fo, ha, this.hP, this.hPole);
      swivelElbowIn(up, fo, ha, this.hInv, EXTENT.lat - 0.01);
      this.hN.copy(this.fistL).applyMatrix4(ha.matrixWorld);
      if (it === 2) break;
      this.hP.add(this.hT).sub(this.hN);
    }
    this.holdErr[1] = this.hN.distanceTo(this.hT);
    if (w < 0.999) {
      for (let i = 0; i < SUPPORT_BONES.length; i++) {
        const b = B[SUPPORT_BONES[i]!];
        if (!b) continue;
        this.hQ.copy(b.quaternion);
        b.quaternion.copy(this.supPre[i]!).slerp(this.hQ, w);
      }
    }
  }

  muzzleWorld(): THREE.Vector3 {
    const g = this.gun;
    if (!g) {
      const p = new THREE.Vector3(0, 1.3, 0.4);
      this.root.localToWorld(p);
      return p;
    }
    this.gunMount.updateWorldMatrix(true, false);
    return g.proto.muzzle.clone().applyMatrix4(this.gunMount.matrixWorld);
  }

  /** Where a round leaves THIS operator's barrel, and the bore's direction. */
  exitPoint(): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    const g = this.gun;
    if (!g) return { pos: this.muzzleWorld(), dir: new THREE.Vector3(0, 0, 1) };
    this.gunMount.updateWorldMatrix(true, false);
    const pos = g.proto.muzzle.clone();
    pos.z -= 0.03;
    pos.applyMatrix4(this.gunMount.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(this.gunMount.matrixWorld);
    return { pos, dir };
  }

  static nowMs = 0;
  lastShotMs = -1e9;

  onShot(): void {
    this.kick = 1;
    this.lastShotMs = BruiserActor.nowMs;
  }

  apply(p: PlayerSnap, dt: number): void {
    // ---- death: authored fall clip, then sink away ----
    if (!p.alive) {
      if (this.wasAlive) {
        this.wasAlive = false;
        this.deadT = 0;
        this.aimW = 0;
        this.throwP = 0;
        this.throwW = 0;
        this.throwing = false;
        this.thrown = false;
        if (this.nadeProp) this.nadeProp.visible = false;
        // The fall clip is authored legs-forward, so the lower-body yaw dies with
        // the player. Left standing, anyone killed mid-strafe folds up with their
        // legs 90 deg off their torso — and the killcam is exactly where that
        // gets looked at.
        this.legYaw = 0;
        this.legRev = false;
        this.legJoint?.quaternion.identity();
        const fall = this.actions.get("fall");
        if (fall) {
          fall.timeScale = 1.5;
          this.play("fall", 0.14);
          fall.time = 0.55; // skip the clip's slow wind-up
        }
      }
      this.deadT += dt;
      // Freeze at ground contact — the clip tail has baked ground-slide.
      if (this.deadT < FALL_FREEZE_T) this.mixer.update(dt);
      this.root.visible = this.deadT < 2.6;
      this.chevron.visible = false;
      this.nameTag.visible = false;
      // sink away at the end
      this.holder.position.y = (template?.yOff ?? 0) - Math.max(0, this.deadT - 2.1) * 1.2;
      return;
    }
    if (!this.wasAlive) {
      // respawned — hard-reset the mixer so the frozen death pose can't bleed
      // into the fresh idle (blended poses read as a bind-pose actor).
      this.wasAlive = true;
      this.holder.position.y = template?.yOff ?? 0;
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      this.root.visible = true;
      this.mixer.stopAllAction();
      this.loco = "idle";
      this.play("idle", 0);
      this.mixer.update(0.001);
      // The pose the corpse froze in is not a mixer output this actor may fall
      // back to: re-arm the latch off the fresh idle instead.
      this.latchOn = false;
    }
    // feel stream: CoD MARKERS. Small, and a CONSTANT size on screen — a fixed
    // fraction of the view height at every range. The old chevron was a world-
    // size sprite with a distance boost: ~35 px over a body 5 m away, a sign post
    // over every head in a firefight. Squadmates always wear theirs (blue
    // chevron + name, through walls: you never lose your squad); an ENEMY's shows
    // only while it is RELEVANT — under your crosshair or just hit by you
    // (game.ts writes markUntil) — red, depth-tested (never a wallhack), and it
    // fades out. Nothing at all while the endcard is up (BruiserActor.overlays).
    const duck = p.crouch || p.slide > 0 ? 0.55 : 0;
    let markA = !BruiserActor.overlays ? 0 : this.ally ? 1 : Math.max(0, Math.min(1, (this.markUntil - BruiserActor.nowMs) / MARK_FADE_MS));
    let dist = 12;
    if (BruiserActor.cameraPos) {
      const cp = BruiserActor.cameraPos;
      dist = Math.hypot(cp.x - (Number.isFinite(p.x) ? p.x : this.root.position.x), cp.y - (Number.isFinite(p.y) ? p.y : this.root.position.y), cp.z - (Number.isFinite(p.z) ? p.z : this.root.position.z));
    }
    // A squadmate an arm's length away needs no flag over their head (and it
    // would sit high in the frame, over the scorebug): fades in from 3 to 4.5 m.
    if (this.ally) markA *= Math.max(0, Math.min(1, (dist - 3) / 1.5));
    const view = dist * 2 * BruiserActor.viewTan;
    const chev = Math.min(0.42, Math.max(0.035, view * MARK_CHEV));
    const tagH = Math.min(0.6, Math.max(0.06, view * MARK_TAG));
    const base = 2.0 - duck;
    const on = markA > 0.01;
    this.chevron.visible = on;
    this.nameTag.visible = on;
    if (on) {
      (this.chevron.material as THREE.SpriteMaterial).opacity = 0.92 * markA;
      (this.nameTag.material as THREE.SpriteMaterial).opacity = 0.9 * markA;
      this.chevron.position.y = base + chev * 0.5;
      this.chevron.scale.setScalar(chev);
      this.nameTag.position.y = base + chev * 0.92 + tagH * 0.5;
      this.nameTag.scale.set(tagH * (256 / 56), tagH, 1);
    }

    // A non-finite snapshot never reaches the scene graph: an infinite yaw would
    // spin the wrap loop below forever, and a NaN position poisons every child
    // transform for the rest of the actor's life. Hold the last good value.
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) this.root.position.set(p.x, p.y, p.z);
    // Smooth visual yaw so netted players do not snap.
    let dy = Number.isFinite(p.yaw) ? p.yaw - this.yawVis : 0;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yawVis += dy * Math.min(1, dt * 14);
    this.root.rotation.y = this.yawVis;
    this.root.rotation.x = 0;
    // CORNER LEAN (Q/E): eased toward the snapped value. The pose itself is a
    // Blender-authored weight shift (pelvis slides, legs re-solved so the feet
    // stay planted, spine rolls, head counter-rolls level) applied further down
    // once the mixer has written the frame's base pose — see applyLeanPose().
    // lean+ (E) is the operator's right: the pose table carries that sign, so
    // only the eased weight goes down. Dead bodies lean nothing.
    {
      const leanTgt = p.alive ? (p.lean === 1 ? 1 : p.lean === -1 ? -1 : 0) : 0;
      if (!Number.isFinite(this.leanVis)) this.leanVis = 0;
      this.leanVis += (leanTgt - this.leanVis) * Math.min(1, dt * 12);
      this.root.rotation.z = 0;
    }

    const spd = Math.hypot(p.vx, p.vz);
    this.kick = Math.max(0, this.kick - dt * 17);
    this.hitT = Math.max(0, this.hitT - dt * 5.5);
    if (p.firing) this.onShot();
    const sinceShot = (BruiserActor.nowMs - this.lastShotMs) / 1000;
    this.shootHold = sinceShot < 0.42 ? 0.42 - sinceShot : 0;

    if (this.forced) {
      this.mixer.update(dt);
      this.latchPose();
      this.stampPose();
      return;
    }

    // Locomotion state. Crouch reuses walk/idle legs with an additive crouch pose.
    //
    // The thresholds carry HYSTERESIS. A bot loitering on 3.3 m/s used to re-cross
    // a bare threshold several times a second, restarting a cross-fade before the
    // previous one had landed — the condition that detonated the play() bug above.
    // play() is safe against that now, but flapping between two gait clips is mush
    // on its own, so a state only gives the band back once the speed has actually
    // left it. The ENTRY speeds are unchanged; only the exits are lower.
    const crouched = p.crouch || p.slide > 0;
    const moving = this.loco === "walk" || this.loco === "run" || this.loco === "crouchwalk";
    let want: Loco = "idle";
    if (crouched) want = spd > (moving ? 0.3 : 0.4) ? "crouchwalk" : "crouch";
    else if (spd > (this.loco === "run" ? 3.05 : 3.3)) want = "run";
    else if (spd > (moving ? 0.18 : 0.25)) want = "walk";
    if (want !== this.loco) {
      this.loco = want;
      if (want === "idle" || want === "crouch") this.play("idle", 0.18);
      if (want === "walk" || want === "crouchwalk") this.play("walk", 0.16);
      if (want === "run") this.play("run", 0.18);
    }
    this.crouchW = THREE.MathUtils.damp(this.crouchW, crouched ? 1 : 0, 16, dt);

    // ---- lower-body facing: the legs run where the player actually goes ----
    //
    // Both gait clips only travel FORWARD. Strafing therefore used to walk the
    // legs straight ahead while the body slid sideways (skate ratio 1.05: the
    // planted foot outran the root) and backpedalling moonwalked at 1.31. The
    // fix is the one every shooter uses: the legs point down the velocity, the
    // torso keeps the aim. Velocity is resolved in the RENDERED facing — the
    // aim stance's 0.18 rad body yaw included — so while firing on the move the
    // legs stay square to the lane and only the upper body carries the bench pose.
    const face = this.yawVis + this.bladeYaw;
    const cf = Math.cos(face);
    const sf = Math.sin(face);
    const vFwd = p.vx * sf + p.vz * cf;
    const vSide = p.vx * cf - p.vz * sf;
    // Rearward travel plays the clip BACKWARDS with the legs still pointing
    // forward, rather than screwing the feet round behind the knees. The 0.4 m/s
    // hysteresis band means a pure strafe (vFwd ~ 0) never flip-flops.
    if (vFwd > 0.4) this.legRev = false;
    else if (vFwd < -0.4) this.legRev = true;
    const rev = this.legRev ? -1 : 1;
    const legW = THREE.MathUtils.clamp((spd - 0.35) / 0.9, 0, 1);
    // Standing, the legs stay square to where the player faces: the weapon
    // stance's blade (bladeYaw, on the holder) is an UPPER-body twist, so the
    // feet keep exactly the footprint the limb budget was measured on.
    let dLeg = Math.atan2(rev * vSide, rev * vFwd) * legW - this.bladeYaw * (1 - legW) - this.legYaw;
    while (dLeg > Math.PI) dLeg -= Math.PI * 2;
    while (dLeg < -Math.PI) dLeg += Math.PI * 2;
    this.legYaw += dLeg * Math.min(1, dt * 12);

    // ---- anti-skate: cadence x stride, both measured (see CLIP_GAIT) ----
    const gaitFor = (clip: "walk" | "run", cadScale: number): { ts: number; amp: number } => {
      const g = CLIP_GAIT[clip];
      const need = spd / g.mps; // playback ratio that covers the ground
      let ts = THREE.MathUtils.clamp((CADENCE_TARGET(spd) * cadScale) / g.steps, TS_BAND.lo, TS_BAND.hi * cadScale);
      // Slow enough that cadence alone covers it: never stride-stretch a stroll.
      if (ts > need) ts = Math.max(TS_BAND.lo, need);
      // NO GROUND LEFT OVER. With the stride already at STRIDE_MAX, cadence takes
      // the rest instead of the feet sliding it.
      if (ts * STRIDE_MAX < need) ts = Math.min(TS_CATCHUP_MAX * cadScale, need / STRIDE_MAX);
      return { ts, amp: THREE.MathUtils.clamp(need / ts, 1, STRIDE_MAX) };
    };
    const walkA = this.actions.get("walk");
    const runA = this.actions.get("run");
    // Crouching keeps its tuned 0.8 cadence, but now takes the ground back on
    // stride instead of simply cycling slower than it travels.
    const walkG = gaitFor("walk", this.loco === "crouchwalk" ? 0.8 : 1);
    const runG = gaitFor("run", 1);
    if (walkA) walkA.timeScale = walkG.ts * rev;
    if (runA) runA.timeScale = runG.ts * rev;

    // INVARIANT: something has to be driving this skeleton. An actor whose actions
    // have all run out of weight accumulates nothing, three stops writing its bones
    // entirely, and the relative overlays below compound on their own output. That
    // can no longer happen through play(), and this is the cheap proof — plus the
    // catch for any future path that strands an action mid-fade.
    if (!this.mixerDriven()) this.play(LOCO_CLIP[this.loco], 0);

    this.mixer.update(dt);
    this.latchPose();

    // ---- stride amplification (lower body only) ----
    // Applied straight after the mixer and before every upper-body overlay, so
    // the aim pose, carry pose, 3P kick and throw all see exactly what they saw
    // before. Nothing above the hips is touched.
    //
    // THE PIVOT HAS TO MATCH THE POSE. Both edits below re-scale a bone's
    // deviation from a gait clip's CYCLE MEAN, which only means anything while
    // that clip is what the mixer is playing. Mid-cross-fade it is playing BOTH:
    // one frame after a run -> walk switch the skeleton is still 97 % run pose, and
    // measuring THAT against the walk mean — then scaling it by walk's 1.9x factor,
    // which is what covering 3 m/s on the walk clip costs — threw the calf from
    // 139 to 173 deg off bind in a single frame. Measured, on every gait
    // transition: the second half of the reported "legs glitch out".
    //
    // So the pivot and the factor both follow the mixer's own live weights, and
    // the whole edit is scaled by how much of the pose came from a gait clip at
    // all (idle carries no stride to amplify). With one clip at weight 1 — every
    // steady state, which is what the anti-skate numbers were tuned on — this is
    // bit-identical to before.
    const wIdle = liveWeight(this.actions.get("idle"));
    const wWalk = liveWeight(walkA);
    const wRun = liveWeight(runA);
    const wGait = wWalk + wRun;
    const runShare = wGait > 1e-5 ? wRun / wGait : 0;
    const gaitShare = wGait > 1e-5 ? wGait / (wGait + wIdle) : 0;
    const midW = this.gaitMid.walk;
    const midR = this.gaitMid.run;
    if (gaitShare > 1e-3 && midW && midR) {
      const amp = 1 + (walkG.amp + (runG.amp - walkG.amp) * runShare - 1) * gaitShare;
      for (const [n, share] of STRIDE_BONES) {
        const b = this.bones[n];
        const m = this.midAt(midW, midR, n, runShare);
        if (b && m) amplifyFromMid(b, m, 1 + (amp - 1) * share, this.tmpQ);
      }
      // ---- arm-swing ceiling (see ARM_KNEE): keeps hands out of walls ----
      for (const n of ARM_CEIL_BONES) {
        const b = this.bones[n];
        const m = this.midAt(midW, midR, n, runShare);
        if (!b || !m) continue;
        const ang = 2 * Math.acos(Math.min(1, Math.abs(b.quaternion.dot(m))));
        if (ang > ARM_KNEE) amplifyFromMid(b, m, (ARM_KNEE + (ang - ARM_KNEE) * ARM_SQUASH) / ang, this.tmpQ);
      }
    }

    // Additive crouch: hip drop + bent knees + hunch layered over the leg cycle.
    this.holder.position.y = template?.yOff ?? 0;
    this.holder.rotation.x = 0;
    if (this.crouchW > 0.02) {
      const cw = this.crouchW;
      const hip = this.bones.Hip;
      if (hip) hip.position.z = hip.position.z - CROUCH_HIP_DROP * cw;
      (this.bones.L_Thigh as THREE.Bone | undefined)?.rotateX(CROUCH_THIGH * cw);
      (this.bones.R_Thigh as THREE.Bone | undefined)?.rotateX(CROUCH_THIGH * cw);
      (this.bones.L_Calf as THREE.Bone | undefined)?.rotateX(CROUCH_CALF * cw);
      (this.bones.R_Calf as THREE.Bone | undefined)?.rotateX(CROUCH_CALF * cw);
      // Counter-rotate the feet so soles stay level with the ground and the walk
      // clip's heel-toe roll survives the additive knee bend.
      const footFix = -(CROUCH_THIGH + CROUCH_CALF) * cw * 0.85;
      (this.bones.L_Foot as THREE.Bone | undefined)?.rotateX(footFix);
      (this.bones.R_Foot as THREE.Bone | undefined)?.rotateX(footFix);
      (this.bones.Spine01 as THREE.Bone | undefined)?.rotateX(CROUCH_HUNCH * cw);
    }

    // Tame the run clip's torso seesaw, and keep the head up in the ape gait.
    if (this.loco === "run") {
      const s1 = this.bones.Spine01;
      if (s1 && this.bind.Spine01) s1.quaternion.slerp(this.bind.Spine01, 0.45);
    }
    const headUp = this.loco === "run" ? HEAD_UP.run : this.loco === "walk" ? HEAD_UP.walk : 0;
    if (headUp) (this.bones.Head as THREE.Bone | undefined)?.rotateX(headUp);

    // The carry keys (walk / run) are DAMPED into each other rather than
    // switched: `loco` flips on a speed threshold, and switching the target pose
    // with it would snap the whole gun across the chest in one frame.
    this.sprintCarryW = THREE.MathUtils.damp(this.sprintCarryW, this.loco === "run" ? 1 : 0, 9, dt);
    this.updateGun(p, dt);

    // Aim: the gun comes up to the shoulder when firing (and shortly after).
    // Body yaw snaps in fast (quick turn) and releases slowly.
    const wantAim = (this.shootHold > 0 || p.ads > 0.5) && this.lowW < 0.5 ? 1 : 0;
    this.aimW = THREE.MathUtils.damp(this.aimW, wantAim, 12, dt);
    // Rate-limited body turn (~430 deg/s => ~0.42s for the 180) with a pivot-step
    // bob, so the turn reads as a quick step-around instead of a teleport.
    const yawRate = wantAim > this.aimYawW ? 3.2 : 1.1;
    this.aimYawW = THREE.MathUtils.clamp(this.aimYawW + Math.sign(wantAim - this.aimYawW) * yawRate * dt, 0, 1);
    // A right-handed shooter blades LEFT shoulder forward (a rifle more than a pistol).
    this.holder.rotation.y = BASE_YAW + this.bladeYaw;
    const turning = this.aimYawW > 0.03 && this.aimYawW < 0.97;
    if (turning) this.holder.position.y = (template?.yOff ?? 0) + Math.sin(this.aimYawW * Math.PI * 2) * 0.035;
    if (this.aimW > 0.01) {
      // the spine and head settle into the stance; the arms are solved below
      for (const n of AIM_BONES) {
        const b = this.bones[n];
        const q = this.aimQuat[n];
        if (!b || !q) continue;
        this.tmpQ.copy(q);
        b.quaternion.slerp(this.tmpQ, this.aimW);
      }
    }
    this.tickThrow(p, dt);
    // Hit flinch: quick spine impulse away from the shot.
    if (this.hitT > 0.01) {
      const f = this.hitT * this.hitT;
      (this.bones.Spine02 as THREE.Bone | undefined)?.rotateX(-0.32 * f);
      (this.bones.Spine02 as THREE.Bone | undefined)?.rotateZ(0.18 * f * this.hitSide);
      (this.bones.Head as THREE.Bone | undefined)?.rotateZ(-0.14 * f * this.hitSide);
      this.holder.position.y = (template?.yOff ?? 0) - 0.02 * f;
    }
    // Aim pitch distributed over the spine chain (clamped), blended by aim weight.
    const pw = 0.5 + this.aimW * 0.85;
    const pitch = THREE.MathUtils.clamp(p.pitch, -1.2, 1.2) * pw;
    (this.bones.Spine01 as THREE.Bone | undefined)?.rotateX(pitch * 0.24);
    (this.bones.Spine02 as THREE.Bone | undefined)?.rotateX(pitch * 0.3);
    (this.bones.NeckTwist01 as THREE.Bone | undefined)?.rotateX(pitch * 0.16);
    // pitch > 0 is aiming DOWN: cap the head bow so the face stays readable.
    (this.bones.Head as THREE.Bone | undefined)?.rotateX(pitch * (pitch > 0 ? 0.1 : 0.26));

    // ---- corner lean: the authored weight shift, last overlay before the split ----
    // After the aim slerp, the throw wind, the flinch and the pitch: the slerp
    // blends Spine02/Head toward an ABSOLUTE un-leaned aim pose, so a lean
    // layered before it would be aimed straight back out (firing while leaned
    // read as hips/legs leaning with a straight torso). Here the lean wins on
    // the torso while still sitting under everything that must see it — the
    // split below only reads Hip's world quaternion, and the hold/budget after
    // it write arms, never a lean bone. The fold ceiling travels with it so it
    // keeps governing the DRAWN pose; the lean asks for ~12-22° against its
    // 130° allowance and passes through untouched.
    applyLeanPose(this.bones, this.leanVis, this.crouchW);

    // ---- leg-fold ceiling: last word on the lower body, after crouch+lean ----
    // Placed here, not up with the amplifier, because it governs the pose that is
    // actually DRAWN — the crouch's additive knee bend stacks onto the amplified
    // cycle, and a ceiling that ran before it would be measuring a pose nobody
    // sees. Below the cap this costs one dot product per bone and writes nothing.
    for (const [n] of STRIDE_BONES) this.capFold(n);

    // ---- the split: yaw the legs onto the velocity, last, on ONE bone ----
    // About true world up, read off Hip's live orientation rather than a bind
    // constant — the ape gait pitches the hips far enough that a stale axis
    // would tilt the legs instead of turning them.
    const hipB = this.bones.Hip;
    if (this.legJoint && hipB) {
      hipB.getWorldQuaternion(this.tmpQ2);
      this.upLocal.set(0, 1, 0).applyQuaternion(this.tmpQ2.invert());
      this.legJoint.quaternion.setFromAxisAngle(this.upLocal, this.legYaw);
    }

    // ---- limb extent budget: the LAST word on where a paw may be ----
    //
    // Dead last on purpose. Every overlay above moves an arm — the carry, the aim
    // pose, the recoil kick, the hit flinch through the spine, the aim pitch —
    // and a budget enforced before any of them is a budget the next one breaks.
    // It reads the pose it is given and needs no memory of it, so being last is
    // free: on a frame where nothing is outside, the whole thing is four distance
    // tests and one matrix walk per arm.
    //
    // It sits AFTER the leg-yaw splice for the opposite reason: that line reads
    // Hip's world quaternion, and the budget's chain walk would refresh Hip's
    // matrix and quietly change which frame's hips the legs are yawed about.
    // Leaving the split alone keeps the P5 anti-skating result bit-for-bit.
    //
    // THE WEAPON HOLD comes first: the gun is placed and the trigger arm solved
    // onto its grip; the budget then judges that arm (and the barrel it carries);
    // only THEN is the support paw put on the handguard — wherever the budget
    // left the gun — and the overhand, which owns that paw while a frag is out,
    // layered on; and the support arm is budgeted last of all.
    this.gatherSolids();
    this.solveHold(p, dt);
    this.gunTurn(0);
    for (const arm of EXTENT_ARMS) {
      if (arm.shoulder === "L_Upperarm" || arm.shoulder === "L_Clavicle") continue;
      this.tuckArm(arm, 1);
    }
    this.gunTurn(1);
    this.solveSupport();
    this.applyThrowArm();
    // The support solve may roll the left shoulder forward to reach the
    // handguard (and the overhand winds it up): its wall term is judged AFTER
    // that, never before — a shoulder leaned into a truck bed after its tuck ran
    // is exactly the MESHCLIP qa/botwatch.mjs caught (L_Clavicle 0.22 m in car-1).
    this.tuckArm(EXTENT_ARMS[0]!, 1);
    // The overhand is a signature move, not an accident of a gait clip: while
    // it carries weight the throwing arm gets a wider ENVELOPE — the wind-up
    // still cocks behind the ear and the follow-through still whips. It gets no
    // exemption from the WALL term — which is what took the throwing paw from
    // 0.511 m inside a shipping container (round 1, capsule pinned at its legal
    // 0.30 m off col-3's face) to 0.029 m, measured the same way.
    this.tuckArm(EXTENT_ARMS[2]!, this.throwW > 0.005 ? 1 + THROW_WIDEN * this.throwW : 1);

    this.stampPose();
    this.weapon = p.weapon;
    // QA: how far the limb budget turned the gun off the hold
    if (this.gun) {
      this.gunMount.updateWorldMatrix(true, false);
      this.gunMount.matrixWorld.decompose(this.hP, this.hQ, this.hP2);
      this.holdErr[3] = this.hQ.angleTo(this.holdQ);
    }
  }

  /**
   * Advance and apply the overhand. Runs AFTER the aim overlay so the throwing
   * arm always wins over the carry pose, and adds a torso wind so the swing
   * comes from the body rather than from a detached shoulder.
   */
  private tickThrow(p: PlayerSnap, dt: number): void {
    this.ensureNadeProp();
    if (p.nadeUp && !this.throwing) {
      // Wind up toward the cocked key and park there for as long as they hold.
      // A second frag starts from scratch rather than from the last swing's
      // follow-through, which would snap the arm back up to the cocked key.
      if (this.thrown) {
        this.throwP = 0;
        this.thrown = false;
      }
      this.throwP = Math.min(THROW_COCK, this.throwP + dt / THROW_WIND_T);
      this.throwW = Math.min(1, this.throwW + dt * 9);
    } else if (this.throwing) {
      this.throwP += dt / THROW_SWING_T;
      if (this.throwP >= 1) {
        this.throwP = 1;
        this.throwing = false;
      }
    } else if (this.thrown) {
      // FOLLOW-THROUGH DONE — blend the overlay OUT, do not rewind it.
      //
      // Decaying throwP instead would run the swing BACKWARDS through its own
      // keys: the arm that just whipped down across the body would rise back
      // over the head through the release key before settling. The key at
      // phase 1 is already the arm at rest, so fading the weight is invisible.
      this.throwW = Math.max(0, this.throwW - dt * 5);
      if (this.throwW <= 0.001) {
        this.throwP = 0;
        this.thrown = false;
      }
    } else if (this.throwP > 0) {
      // Aborted before the release (died mid-wind-up, or the throw never came).
      // Here the keys DO reverse cleanly — 0 -> 0.3 -> cocked is a monotone
      // raise, so running it backwards is exactly "put the arm back down".
      this.throwP = Math.max(0, this.throwP - dt / 0.22);
    }
    if (this.throwP <= 0 && !p.nadeUp) this.throwW = Math.max(0, this.throwW - dt * 7);
    if (this.nadeProp) this.nadeProp.visible = !this.thrown && this.throwW > 0.05 && this.throwP < THROW_RELEASE;
    if (this.throwW <= 0.005) return;

    const t = throwPoseAt(this.throwP, this.throwPose);
    const w = this.throwW;
    // Torso counter-wind: shoulders load on the cock and unload through release.
    // (Here, before the weapon hold, so the gun rides the torso; the arm itself
    // is swung in applyThrowArm, after the support paw has let go of the gun.)
    (this.bones.Spine02 as THREE.Bone | undefined)?.rotateY(t.sp * 0.9 * w);
    (this.bones.Spine01 as THREE.Bone | undefined)?.rotateY(t.sp * 0.45 * w);
    (this.bones.Spine02 as THREE.Bone | undefined)?.rotateX(-t.sp * 0.35 * w);
  }

  /** The overhand's left arm, on top of whatever the hold left it at. */
  private applyThrowArm(): void {
    if (this.throwW <= 0.005) return;
    const t = this.throwPose;
    const w = this.throwW;
    (this.bones.L_Clavicle as THREE.Bone | undefined)?.rotateZ(t.uz * 0.14 * w);
    (this.bones.L_Upperarm as THREE.Bone | undefined)?.rotateZ(t.uz * w);
    (this.bones.L_Upperarm as THREE.Bone | undefined)?.rotateY(t.uy * w);
    (this.bones.L_Upperarm as THREE.Bone | undefined)?.rotateX(t.ux * w);
    (this.bones.L_Forearm as THREE.Bone | undefined)?.rotateZ(t.fz * w);
    (this.bones.L_Forearm as THREE.Bone | undefined)?.rotateX(t.fx * w);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    const skeletons = new Set<THREE.Skeleton>();
    this.body.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((o as THREE.SkinnedMesh).skeleton); });
    for (const skeleton of skeletons) skeleton.dispose();
    // The per-actor material clones (constructor) — the shared maps they
    // reference stay alive with the template.
    for (const mat of this.actorMats) mat.dispose();
    (this.nameTag.material as THREE.SpriteMaterial).map?.dispose();
    (this.nameTag.material as THREE.SpriteMaterial).dispose();
    (this.chevron.material as THREE.SpriteMaterial).dispose();
  }
}

const AIM_BONES = ["R_Clavicle", "R_Upperarm", "R_Forearm", "R_Hand", "L_Upperarm", "L_Forearm", "L_Hand", "Spine02", "Head"];
/**
 * Every bone apply() writes AFTER the mixer has run — the exact set the pose
 * latch has to re-base each frame. Keep it in step with the overlays: a bone that
 * gets a relative edit and is missing here is a bone that can compound.
 */
const OVERLAY_BONES = [
  ...new Set([
    ...STRIDE_BONES.map(([n]) => n),
    ...ARM_CEIL_BONES,
    ...CARRY_BONES,
    ...AIM_BONES,
    "Hip",
    "Waist",
    "L_Clavicle",
    "Spine01",
    "NeckTwist01",
    "NeckTwist02",
  ]),
];
const UP = new THREE.Vector3(0, 1, 0);
const XA = new THREE.Vector3(1, 0, 0);
/** Gun space -> actor root frame for a gun pointing straight ahead (-Z bore onto +Z). */
const GUN_FWD = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);

