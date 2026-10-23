/**
 * VIEWMODEL HOLDS — per-weapon framing, hand grips, recoil and reload style.
 * Every number here is a tuning knob for client/src/viewmodel.ts.
 *
 * Spaces:
 *   camera space  metres, -Z forward, +Y up, +X right (the viewmodel root,
 *                 BEFORE its depth/FOV scale — i.e. true metres from the eye)
 *   gun space     GunModel space: origin = trigger-hand grip, -Z = bore
 *
 * Rotations are [pitch, yaw, roll] (Euler YXZ): +pitch muzzle up, +yaw muzzle
 * left (toward the crosshair at the hip), +roll top of the gun leans left.
 */
export type V3 = [number, number, number];

/** a hand on a grip, gun space: section centre, grip axis (toward the index finger), axis->palm direction, semi-axes */
export interface GripCfg {
  at: V3;
  up: V3;
  palm: V3;
  a: number;
  b: number;
  curl?: number;
  thumb?: number;
  /** trigger finger extension 0..1 (0 = wrapped) */
  index?: number;
}

export type ReloadKind = "mag" | "pistol" | "bolt";

export interface Hold {
  /** camera-space position of the gun origin + rotation at the hip */
  hip: { p: V3; r: V3 };
  /** tac-sprint: pulled in, canted, muzzle down-left */
  sprint: { p: V3; r: V3 };
  /** ADS: eye-to-rear-sight distance (m) */
  eye: number;
  /** ADS cant about the sight line (rad, + = top left); the sight picture stays centred */
  adsRoll?: number;
  r: GripCfg;
  l: GripCfg | null;
  /** camera-space elbow targets (hip, ADS) for the sleeves */
  elbowR: V3;
  elbowL: V3;
  elbowRAds: V3;
  elbowLAds: V3;
  /**
   * recoil impulse per shot (velocities into the springs):
   * back m/s, up m/s, pitch rad/s, yaw rad/s (random +-), roll rad/s (random +-);
   * stiffness / damping ratio of the position and rotation springs; ADS scale.
   */
  recoil: { back: number; up: number; pitch: number; yaw: number; roll: number; kP: number; zP: number; kR: number; zR: number; ads: number };
  reload: ReloadKind;
  /** support hand on the mag (gun space) — where it grabs the mag when seated */
  magGrip?: GripCfg;
  /** muzzle flash: card size (m), light intensity */
  flash: { size: number; light: number };
  /** per-shot bolt / slide travel (m) */
  cycle: number;
  /** viewmodel vertical FOV at the hip / fully aimed (deg) */
  vmFov: number;
  vmFovAds: number;
}

export const HOLDS: Record<string, Hold> = {
  ar: {
    hip: { p: [0.2, -0.21, -0.38], r: [0.08, 0.13, 0.06] },
    sprint: { p: [0.2, -0.27, -0.36], r: [-0.25, 0.35, 0.5] },
    eye: 0.2,
    r: { at: [0, 0, 0], up: [0, 0.928, -0.372], palm: [1, 0, 0], a: 0.0138, b: 0.0205, curl: 1, thumb: 0.9, index: 0.12 },
    // gun space = design - grip (AR grip at design (0, -0.081, 0.0245)): the handguard axis is at y = +0.079
    l: { at: [-0.003, 0.0785, -0.35], up: [0.0, 0.0, -1], palm: [-0.45, -0.89, 0], a: 0.0225, b: 0.024, curl: 0.9, thumb: 0.7 },
    elbowR: [0.3, -0.36, -0.12],
    elbowL: [-0.12, -0.36, -0.42],
    elbowRAds: [0.16, -0.55, -0.02],
    elbowLAds: [-0.14, -0.6, -0.4],
    recoil: { back: 0.85, up: 0.1, pitch: 2.1, yaw: 0.45, roll: 0.9, kP: 900, zP: 0.6, kR: 800, zR: 0.55, ads: 0.45 },
    reload: "mag",
    magGrip: { at: [0, -0.03, -0.142], up: [0, 0.99, 0.15], palm: [-1, 0, 0], a: 0.0118, b: 0.031, curl: 1, thumb: 1 },
    flash: { size: 0.17, light: 9 },
    cycle: 0.028,
    vmFov: 62,
    vmFovAds: 22,
  },
  smg: {
    hip: { p: [0.19, -0.2, -0.35], r: [0.08, 0.13, 0.07] },
    sprint: { p: [0.19, -0.26, -0.34], r: [-0.25, 0.35, 0.5] },
    eye: 0.19,
    r: { at: [0, 0, 0], up: [0, 0.928, -0.372], palm: [1, 0, 0], a: 0.0135, b: 0.02, curl: 1, thumb: 0.9, index: 0.12 },
    // gun space = design - grip (grip at design (0, -0.081, 0.0245))
    l: { at: [-0.003, 0.0793, -0.29], up: [0, 0, -1], palm: [-0.45, -0.89, 0], a: 0.0205, b: 0.022, curl: 0.9, thumb: 0.7 },
    elbowR: [0.3, -0.36, -0.12],
    elbowL: [-0.12, -0.36, -0.4],
    elbowRAds: [0.16, -0.55, -0.02],
    elbowLAds: [-0.14, -0.6, -0.4],
    recoil: { back: 0.6, up: 0.08, pitch: 1.4, yaw: 0.7, roll: 1.4, kP: 1250, zP: 0.45, kR: 1100, zR: 0.4, ads: 0.45 },
    reload: "mag",
    magGrip: { at: [0, -0.024, -0.1345], up: [0, 0.99, 0.07], palm: [-1, 0, 0], a: 0.0098, b: 0.017, curl: 1, thumb: 1 },
    flash: { size: 0.13, light: 7 },
    cycle: 0.022,
    vmFov: 62,
    vmFovAds: 24,
  },
  sniper: {
    hip: { p: [0.215, -0.255, -0.48], r: [0.11, 0.125, 0.065] },
    sprint: { p: [0.2, -0.28, -0.38], r: [-0.22, 0.32, 0.5] },
    eye: 0.1,
    // gun space = design - grip (grip at design (0, -0.098, 0.024)): the bore is at y = +0.098
    r: { at: [0, 0, 0], up: [0, 0.96, -0.28], palm: [1, 0, 0], a: 0.0158, b: 0.022, curl: 1, thumb: 0.9, index: 0.12 },
    l: { at: [-0.003, 0.063, -0.4], up: [0, 0, -1], palm: [-0.45, -0.89, 0], a: 0.023, b: 0.024, curl: 0.9, thumb: 0.7 },
    elbowR: [0.3, -0.36, -0.12],
    elbowL: [-0.12, -0.36, -0.44],
    elbowRAds: [0.16, -0.55, -0.02],
    elbowLAds: [-0.14, -0.6, -0.4],
    recoil: { back: 1.5, up: 0.25, pitch: 3.6, yaw: 0.4, roll: 1.2, kP: 300, zP: 0.6, kR: 260, zR: 0.55, ads: 0.6 },
    reload: "bolt",
    flash: { size: 0.24, light: 12 },
    cycle: 0,
    vmFov: 62,
    vmFovAds: 40,
  },
  pistol: {
    hip: { p: [0.12, -0.165, -0.42], r: [0.05, 0.1, 0.06] },
    sprint: { p: [0.12, -0.25, -0.34], r: [-0.55, 0.35, 0.3] },
    eye: 0.48,
    // a slight cant about the sight line: the back of the trigger hand turns toward the eye (3/4, not end-on)
    adsRoll: 0.14,
    // gun space = design - grip (grip at design (0, -0.064, -0.009)): the bore is at y = +0.064
    // high grip: the web up on the beavertail, the thumb over the back and forward along the left of the frame
    r: { at: [0, 0, 0], up: [0, 0.93, -0.36], palm: [0.92, 0, 0.38], a: 0.0148, b: 0.022, curl: 1, thumb: 0.75, index: 0.15 },
    // support hand low and forward: fingers round the front strap under the guard, thumb straight forward
    l: { at: [-0.006, -0.016, -0.014], up: [0, 0.93, -0.36], palm: [-0.85, -0.2, -0.5], a: 0.018, b: 0.024, curl: 0.75, thumb: 0.05 },
    elbowR: [0.24, -0.42, -0.14],
    elbowL: [-0.12, -0.45, -0.16],
    elbowRAds: [0.24, -0.5, -0.2],
    elbowLAds: [-0.24, -0.5, -0.24],
    recoil: { back: 0.9, up: 0.2, pitch: 4.6, yaw: 0.5, roll: 1.0, kP: 700, zP: 0.55, kR: 520, zR: 0.5, ads: 0.6 },
    reload: "pistol",
    magGrip: { at: [0, -0.036, 0.009], up: [0, 0.95, -0.31], palm: [-1, 0, 0], a: 0.011, b: 0.016, curl: 1, thumb: 1 },
    flash: { size: 0.11, light: 7 },
    cycle: 0.03,
    vmFov: 60,
    vmFovAds: 46,
  },
};

export function holdOf(id: string): Hold {
  return HOLDS[id] ?? HOLDS.ar!;
}
