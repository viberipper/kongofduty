/**
 * SR-7 BLUE JAVA — a modern bolt-action precision rifle: round nitrided action
 * on a 20 MOA rail, 22" fluted heavy barrel, a flat-sided muzzle brake, an
 * FDE fibreglass tactical stock (vertical grip, adjustable cheek riser,
 * rubber pad), steel bottom metal with a 5-round box, and a 34 mm 5-25x56
 * scope with exposed turrets in ring mounts. The bolt is its own part (lift +
 * pull for the cycle and the top-loading reload).
 *
 * Design space: bore along -Z at y = 0, z = 0 at the rear of the action.
 */
import * as THREE from "three";
import { PartBuilder } from "../lib/builder";
import { ball, cylX, cylY, cylZ, latheZ, rbox, roundPoly, rrect, section, side, tf, tubeZ, type V2 } from "../lib/geo";
import { PAL } from "../lib/mats";
import { cartridge, instance, lensDisc, picatinny, pin, Q, type GunDesign, type Lod } from "./common";
import { registerGun } from "./index";

/** scope axis above the bore */
export const SR_SIGHT_Y = 0.064;

/** a fluted barrel cross-section: a circle with n shallow scallops */
function fluted(r: number, n: number, depth: number, seg: number): V2[] {
  const pts: V2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const k = Math.cos(a * n);
    const rr = r - depth * Math.max(0, k) ** 2;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return pts;
}

function buildSniper(lod: Lod): GunDesign {
  const q = Q(lod);
  const b = new PartBuilder();
  const STL = 0x232527, FDE = 0x74624a, FDE_D = 0x5c4d3a;

  // ------------------------------------------------------------ action + rail
  b.add(cylZ(0.0172, 0.0, -0.212, 0.0018, q.cyl), STL, "steel");
  // recoil lug ring + the front receiver ring
  b.add(cylZ(0.0184, -0.198, -0.2135, 0.001, q.cyl), STL, "steel");
  picatinny(b, lod, 0.004, -0.205, 0.0158, 0.0212, PAL.anodBlack);
  b.add(section(roundPoly([[-0.009, 0.012], [0.009, 0.012], [0.009, 0.0165], [-0.009, 0.0165]], 0.001, 1), 0.004, -0.205, { bevel: 0.0006, bevelSeg: 1 }), PAL.anodBlack, "anod");
  if (q.fp) {
    // ejection port (right, top): dark cut + the bolt face visible through it
    b.add(rbox(0.006, 0.012, 0.06, 0.002, 1), 0x0c0d0e, "steel", tf([0.0128, 0.006, -0.105], [0, 0, 0.6]));
    // bolt release on the left rear
    b.add(rbox(0.003, 0.006, 0.014, 0.001, 1), PAL.steel, "steel", tf([-0.0172, 0.004, -0.012]));
  }
  // ------------------------------------------------------------ bolt (lift + pull): body, shroud, handle, knob
  {
    const bo = b.sub("bolt", [0, 0, -0.03]);
    bo.add(cylZ(0.0098, 0.03, -0.14, 0.0015, q.cylS), PAL.bright, "bright");
    if (q.fp) for (const z of [-0.06, -0.075, -0.09]) bo.add(cylZ(0.0104, z, z - 0.008, 0.0008, q.cylS), 0x6b6f73, "bright");
    // shroud at the rear
    bo.add(latheZ([[0, 0.034], [0.0125, 0.034], [0.0135, 0.026], [0.0135, 0.004], [0.0118, 0.0], [0, 0.0]], q.cylS), STL, "steel");
    // handle: an arm out to the right and down, a big tactical knob
    const arm = cylY(0.0042, 0.05, 0.001, q.fp ? 12 : 6);
    bo.add(arm, STL, "steel", tf([0.029, -0.008, 0.012], [0, 0, -(Math.PI / 2 + 0.37)]));
    bo.add(ball(0.0115, q.fp ? 16 : 8), 0x1d1e20, "poly", tf([0.05, -0.016, 0.013], [0, 0, 0], [1, 1.12, 1]));
    if (q.fp) bo.add(cylX(0.0057, 0.012, 0.001, 12), STL, "steel", tf([0.041, -0.0134, 0.013], [0, 0, -0.38]));
  }

  // ------------------------------------------------------------ fluted barrel + brake
  b.add(latheZ([[0, -0.21], [0.0158, -0.21], [0.0158, -0.24], [0.0128, -0.3], [0, -0.3]], q.cyl), STL, "steel");
  b.add(section(fluted(0.0122, 6, q.fp ? 0.0022 : 0, q.fp ? 72 : 12), -0.298, -0.722, { bevel: 0.0006, bevelSeg: 1 }), STL, "steel");
  b.add(cylZ(0.0108, -0.72, -0.732, 0.0005, q.cylS), PAL.steelDark, "steel");
  {
    // flat-sided brake with three ports per side (cut through)
    const prof: V2[] = roundPoly([[-0.73, -0.0145], [-0.808, -0.0145], [-0.808, 0.0145], [-0.73, 0.0145]], 0.003, 2);
    const ports = q.fp ? [rrect(-0.752, 0, 0.009, 0.019, 0.002, 2), rrect(-0.768, 0, 0.009, 0.019, 0.002, 2), rrect(-0.784, 0, 0.009, 0.019, 0.002, 2)] : [];
    b.add(side(prof, 0.031, { bevel: 0.002, bevelSeg: q.bevelSeg, holes: ports }), PAL.steelDark, "steel");
  }

  // ------------------------------------------------------------ the stock (FDE), vertical grip, cheek riser, pad
  {
    const st: V2[] = roundPoly(
      [
        [-0.52, -0.013], [-0.53, -0.024], [-0.522, -0.05], [-0.2, -0.058], [-0.115, -0.06], [-0.075, -0.058],
        [-0.02, -0.06], [-0.004, -0.08], [0.004, -0.13], [0.012, -0.14], [0.05, -0.14], [0.058, -0.125], [0.056, -0.085],
        [0.07, -0.066], [0.2, -0.074], [0.33, -0.112], [0.352, -0.114], [0.352, 0.03], [0.33, 0.032], [0.2, 0.0],
        [0.06, -0.004], [0.03, 0.0], [0.004, 0.0], [-0.21, -0.009],
      ],
      [0.004, 0.006, 0.01, 0.02, 0.01, 0.01, 0.012, 0.02, 0.012, 0.006, 0.006, 0.01, 0.02, 0.02, 0.03, 0.01, 0.004, 0.004, 0.01, 0.03, 0.02, 0.01, 0.005, 0.003],
      q.rnd + 1,
    );
    // the grip opening between the vertical grip and the buttstock is open (the outline already wraps it)
    b.add(side(st, 0.044, { bevel: 0.009, bevelSeg: q.fp ? 3 : 1 }), FDE, "poly");
    // cheek riser (adjustable comb) on its posts
    b.add(side(roundPoly([[0.15, 0.003], [0.31, 0.003], [0.31, 0.034], [0.17, 0.03]], [0.004, 0.004, 0.01, 0.008], q.rnd + 1), 0.04, { bevel: 0.007, bevelSeg: q.fp ? 3 : 1 }), FDE_D, "poly");
    if (q.fp) for (const z of [0.18, 0.27]) b.add(cylY(0.003, 0.012, 0.0006, 10), PAL.steel, "steel", tf([0, -0.002, z]));
    // rubber pad
    b.add(side(roundPoly([[0.348, 0.035], [0.366, 0.035], [0.366, -0.118], [0.348, -0.118]], 0.005, 2), 0.047, { bevel: 0.006, bevelSeg: q.bevelSeg }), PAL.rubber, "rubber");
    // sling QD cup + bipod stud under the forend
    if (q.fp) {
      b.add(cylZ(0.006, -0.002, 0.002, 0.001, 14), PAL.steel, "steel", tf([-0.0225, -0.03, -0.45], [0, Math.PI / 2, 0]));
      b.add(cylY(0.005, 0.01, 0.001, 12), PAL.steel, "steel", tf([0, -0.053, -0.47]));
    }
  }
  // bottom metal: trigger guard, trigger, the box magazine
  {
    const outer: V2[] = [[-0.07, -0.056], [-0.07, -0.068], [-0.06, -0.078], [-0.012, -0.078], [-0.004, -0.07], [-0.004, -0.058]];
    const inner: V2[] = [[-0.064, -0.059], [-0.064, -0.067], [-0.057, -0.074], [-0.015, -0.074], [-0.009, -0.068], [-0.009, -0.059]];
    b.add(side(roundPoly(outer, 0.002, q.rnd), 0.013, { bevel: 0.0012, bevelSeg: q.bevelSeg, holes: q.fp ? [roundPoly(inner, 0.0025, q.rnd)] : [] }), STL, "steel");
    if (q.fp) b.add(side(roundPoly([[-0.035, -0.057], [-0.032, -0.057], [-0.033, -0.065], [-0.038, -0.071], [-0.041, -0.07], [-0.037, -0.064]], 0.001, 2), 0.0055, { bevel: 0.0008, bevelSeg: 1 }), PAL.steel, "steel");
    const mg = b.sub("mag", [0, -0.06, -0.105]);
    mg.add(side(roundPoly([[-0.08, -0.05], [-0.132, -0.05], [-0.132, -0.082], [-0.08, -0.082]], [0.002, 0.002, 0.003, 0.003], 2), 0.024, { bevel: 0.0018, bevelSeg: q.bevelSeg }), 0x1b1c1e, "steel");
    if (q.fp) cartridge(mg, lod, tf([0, -0.047, -0.083]), { len: 0.072, r: 0.0063, neck: 0.0038, tip: 0.024 });
  }

  // ------------------------------------------------------------ the scope: 34 mm tube, 56 mm objective, turrets
  {
    // a compact eyepiece (W3: the old 47 mm bell read as a tube at the hip)
    const yA = SR_SIGHT_Y, R = 0.0175, zO = 0.072, zF = -0.268;
    const prof: V2[] = [
      [0, zO + 0.002], [0.0202, zO + 0.002], [0.0212, zO - 0.005], [0.0212, zO - 0.026], [0.0186, zO - 0.038], [R, zO - 0.048],
      [R, zF + 0.096], [0.024, zF + 0.068], [0.0305, zF + 0.04], [0.0315, zF + 0.012], [0.0315, zF], [0, zF],
    ];
    b.add(latheZ(prof, q.cyl + 8).applyMatrix4(tf([0, yA, 0])), 0x17181a, "anod", undefined, { wear: 0.25 });
    if (q.fp) {
      // the eyepiece's rubber ring + the objective's knurled ring
      b.add(tubeZ(0.0218, 0.0174, zO + 0.004, zO - 0.005, 0.0015, q.cyl + 8), PAL.rubber, "rubber", tf([0, yA, 0]));
      for (const z of [zF + 0.03, zF + 0.024, zF + 0.018]) b.add(tubeZ(0.0322, 0.028, z, z - 0.003, 0.0006, q.cyl + 8), 0x232528, "anod", tf([0, yA, 0]));
      lensDisc(b, 0, yA, 0.0298, zF - 0.0004, 0x5d7f93, 40);
      lensDisc(b, 0, yA, 0.0172, zO + 0.0024, 0x6b8899, 32);
    }
    // turret saddle + elevation (top), windage (right), parallax / illum (left)
    b.add(rbox(0.04, 0.038, 0.052, 0.009, q.fp ? 3 : 1), 0x17181a, "anod", tf([0, yA, -0.08]));
    const turret = (len: number, r: number, m: THREE.Matrix4) => {
      b.add(cylZ(r * 0.8, 0, -len * 0.35, 0.0008, q.cylS), 0x17181a, "anod", m);
      if (q.fp) {
        // knurled cap: alternating ridges
        const pts: V2[] = [];
        const n = 28;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const rr = r * (i % 2 ? 1 : 0.93);
          pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
        }
        b.add(section(pts, -len * 0.35, -len, { bevel: 0.0012, bevelSeg: 1 }), 0x1f2023, "anod", m);
        b.add(cylZ(r * 0.62, -len + 0.0005, -len - 0.002, 0.0008, q.cylS), 0x2a2c2f, "anod", m);
      } else b.add(cylZ(r, -len * 0.35, -len, 0.001, q.cylS), 0x1f2023, "anod", m);
    };
    turret(0.024, 0.0125, tf([0, yA + 0.012, -0.08], [Math.PI / 2, 0, 0]));
    turret(0.022, 0.0115, tf([0.0145, yA, -0.08], [0, -Math.PI / 2, 0]));
    turret(0.02, 0.0135, tf([-0.0145, yA, -0.08], [0, Math.PI / 2, 0]));
    // two rings on a one-piece base
    for (const z of [-0.02, -0.13]) {
      b.add(tubeZ(R + 0.004, R - 0.0002, z + 0.009, z - 0.009, 0.0012, q.cyl), PAL.anodBlack, "anod", tf([0, yA, 0]));
      b.add(side(roundPoly([[z + 0.009, 0.0198], [z - 0.009, 0.0198], [z - 0.008, yA - R], [z + 0.008, yA - R]], 0.002, 2), 0.018, { bevel: 0.0015, bevelSeg: 1 }), PAL.anodBlack, "anod");
      if (q.fp) for (const sx of [-1, 1]) b.add(cylX(0.0028, 0.004, 0.0006, 10), PAL.steel, "steel", tf([sx * (R + 0.004), yA + 0.006, z]));
    }
  }
  if (q.fp) for (const z of [-0.03, -0.18]) { pin(b, lod, -0.022, -0.02, z, 0.004, PAL.steel); pin(b, lod, 0.022, -0.02, z, 0.004, PAL.steel); }

  const built = b.build("sniper");
  return {
    built,
    grip: new THREE.Vector3(0, -0.098, 0.024),
    muzzle: new THREE.Vector3(0, 0, -0.808),
    fore: new THREE.Vector3(0, -0.04, -0.38),
    sight: { front: new THREE.Vector3(0, SR_SIGHT_Y, -0.268), rear: new THREE.Vector3(0, SR_SIGHT_Y, 0.072) },
    eject: new THREE.Vector3(0.016, 0.01, -0.105),
    length: 1.17,
    anchors: {
      boltKnob: new THREE.Vector3(0.05, -0.016, 0.013),
      port: new THREE.Vector3(0, 0.016, -0.1),
      magwell: new THREE.Vector3(0, -0.06, -0.105),
    },
  };
}

registerGun("sniper", (lod) => instance("sniper", lod, buildSniper));
