/**
 * Corner-lean poses for the bruiser rig, authored in Blender (bpy) against
 * `client/static/assets/models/bruiser.glb` and baked here as additive
 * bone-local deltas.
 *
 * Each pose was built the way an animator poses a lean:
 *   - the pelvis slides toward the lean side and rolls about the forward axis,
 *   - both legs are solved with a two-bone IK so the feet stay near-planted
 *     (measured foot drift ≤ 1.2 cm in model units),
 *   - waist/spine roll into the lean, neck and head counter-roll to keep the
 *     eye line level,
 * and it is calibrated so the head lands at `LEAN_SHIFT` (0.30 m in
 * world units) to the side — the same offset the camera and the shot eye take.
 *
 * `loc` is in the parent bone's rest axes (what `Bone.position` uses), `rot`
 * is a bone-local XYZ euler (post-multiplied, like `matrix_basis` in Blender).
 * Values are for a FULL lean and get scaled by the eased lean weight at runtime.
 *
 * Crouch poses (LEAN_RIGHT_CROUCH / LEAN_LEFT_CROUCH) are the lean CORRECTION
 * relative to the crouched base only — not the crouch itself. The game crouch
 * (bruiser.ts: hip drop 0.05, thighs -0.45, calves +0.76, foot level fix
 * -(thigh+calf)*0.85, Spine01 hunch +0.28) is still posed separately BEFORE the
 * lean; at runtime applyLeanPose interpolates per bone between the standing
 * and the crouch table by crouchW (0..1) and applies the blend once. The
 * crouch tables were authored the same way (crouch base first, then the same
 * slide/roll/counter logic, legs re-solved onto the near-planted feet with an
 * analytic 3D two-bone IK), with the slide re-calibrated to 0.0485 so the head
 * still lands at `LEAN_SHIFT` while foot drift stays ≤ 1.2 cm model units.
 *
 * Not hand-edited: regenerate from the Blender script if the rig changes.
 */

export type LeanBone = { loc: readonly [number, number, number]; rot: readonly [number, number, number] };

/** sim lean = +1 (E, operator's right), standing. */
export const LEAN_RIGHT: Record<string, LeanBone> = {
  Hip: { loc: [-0.047, 0, 0], rot: [0.03445, -0.04501, 0.03106] },
  L_Thigh: { loc: [0, 0, 0], rot: [0.00092, 0.00815, 0.22464] },
  L_Calf: { loc: [0, 0, 0], rot: [-0.00067, 0.01038, -0.17153] },
  L_Foot: { loc: [0, 0, 0], rot: [-0.00405, -0.01801, -0.00691] },
  R_Thigh: { loc: [0, 0, 0], rot: [0.00304, 0.02715, 0.34222] },
  R_Calf: { loc: [0, 0, 0], rot: [-0.00331, 0.01483, -0.39391] },
  R_Foot: { loc: [0, 0, 0], rot: [-0.0036, -0.00539, -0.00577] },
  Waist: { loc: [0, 0, 0], rot: [-0.00002, 0.00191, -0.07197] },
  Spine01: { loc: [0, 0, 0], rot: [-0.00004, 0.00225, -0.08497] },
  Spine02: { loc: [0, 0, 0], rot: [-0.00002, 0.00191, -0.07197] },
  NeckTwist01: { loc: [0, 0, 0], rot: [-0.00011, -0.0018, 0.06798] },
  NeckTwist02: { loc: [0, 0, 0], rot: [-0.00011, -0.0018, 0.06798] },
  Head: { loc: [0, 0, 0], rot: [-0.00007, -0.00138, 0.05198] },
};

/** sim lean = -1 (Q, operator's left), standing. */
export const LEAN_LEFT: Record<string, LeanBone> = {
  Hip: { loc: [0.047, 0, 0], rot: [-0.03587, 0.04389, -0.03262] },
  L_Thigh: { loc: [0, 0, 0], rot: [0.00148, -0.01029, -0.28515] },
  L_Calf: { loc: [0, 0, 0], rot: [-0.00258, -0.01626, 0.27204] },
  L_Foot: { loc: [0, 0, 0], rot: [0.00274, 0.01188, 0.0046] },
  R_Thigh: { loc: [0, 0, 0], rot: [0.00304, -0.01759, -0.22298] },
  R_Calf: { loc: [0, 0, 0], rot: [-0.00043, -0.00673, 0.17403] },
  R_Foot: { loc: [0, 0, 0], rot: [0.03044, 0.04301, 0.04764] },
  Waist: { loc: [0, 0, 0], rot: [-0.00012, -0.0019, 0.07197] },
  Spine01: { loc: [0, 0, 0], rot: [-0.00015, -0.00225, 0.08497] },
  Spine02: { loc: [0, 0, 0], rot: [-0.00012, -0.0019, 0.07197] },
  NeckTwist01: { loc: [0, 0, 0], rot: [-0.00001, 0.0018, -0.06798] },
  NeckTwist02: { loc: [0, 0, 0], rot: [-0.00001, 0.0018, -0.06798] },
  Head: { loc: [0, 0, 0], rot: [0, 0.00138, -0.05198] },
};

/** sim lean = +1 (E, operator's right): lean correction on top of the crouch base. */
export const LEAN_RIGHT_CROUCH: Record<string, LeanBone> = {
  Hip: { loc: [-0.0485, 0, 0], rot: [0.03445, -0.04501, 0.03106] },
  L_Thigh: { loc: [0, 0, 0], rot: [-0.18423, -0.0089, -0.09622] },
  L_Calf: { loc: [0, 0, 0], rot: [0.41188, -0.09279, 0.43739] },
  L_Foot: { loc: [0, 0, 0], rot: [-0.32363, -0.04092, -0.24942] },
  R_Thigh: { loc: [0, 0, 0], rot: [-0.22159, -0.01358, -0.12191] },
  R_Calf: { loc: [0, 0, 0], rot: [0.57749, -0.14667, 0.4849] },
  R_Foot: { loc: [0, 0, 0], rot: [-0.49493, -0.07429, -0.29215] },
  Waist: { loc: [0, 0, 0], rot: [-0.00002, 0.00191, -0.07197] },
  Spine01: { loc: [0, 0, 0], rot: [0.00093, -0.02129, -0.0823] },
  Spine02: { loc: [0, 0, 0], rot: [0.00068, -0.01804, -0.06971] },
  NeckTwist01: { loc: [0, 0, 0], rot: [0.00051, 0.01704, 0.06583] },
  NeckTwist02: { loc: [0, 0, 0], rot: [0.00051, 0.01704, 0.06583] },
  Head: { loc: [0, 0, 0], rot: [0.00029, 0.01304, 0.05034] },
};

/** sim lean = -1 (Q, operator's left): lean correction on top of the crouch base. */
export const LEAN_LEFT_CROUCH: Record<string, LeanBone> = {
  Hip: { loc: [0.0485, 0, 0], rot: [-0.03587, 0.04389, -0.03262] },
  L_Thigh: { loc: [0, 0, 0], rot: [-0.27184, 0.0177, 0.12924] },
  L_Calf: { loc: [0, 0, 0], rot: [0.58203, 0.13404, -0.44089] },
  L_Foot: { loc: [0, 0, 0], rot: [-0.17172, 0.03058, 0.35162] },
  R_Thigh: { loc: [0, 0, 0], rot: [-0.14728, 0.00501, 0.06794] },
  R_Calf: { loc: [0, 0, 0], rot: [0.43765, 0.09313, -0.4131] },
  R_Foot: { loc: [0, 0, 0], rot: [0.03267, -0.00684, 0.41216] },
  Waist: { loc: [0, 0, 0], rot: [-0.00012, -0.0019, 0.07197] },
  Spine01: { loc: [0, 0, 0], rot: [0.00082, 0.0213, 0.08229] },
  Spine02: { loc: [0, 0, 0], rot: [0.00058, 0.01805, 0.06971] },
  NeckTwist01: { loc: [0, 0, 0], rot: [0.00061, -0.01704, -0.06583] },
  NeckTwist02: { loc: [0, 0, 0], rot: [0.00061, -0.01704, -0.06583] },
  Head: { loc: [0, 0, 0], rot: [0.00036, -0.01304, -0.05034] },
};
