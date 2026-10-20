/**
 * P-9 BURRO — a polymer-frame striker pistol (Glock / P320 class): black
 * nitrided slide with front and rear cocking serrations, an optic-cut cover
 * plate, steel sights with tritium (3-dot), an accessory rail on the dust
 * cover, a stippled grip with a beavertail, a flush magazine, the slide stop
 * and the mag release on the left. The slide is its own part (blowback, lock,
 * rack). A small crescent stamped on the cover plate.
 *
 * Design space: bore along -Z at y = 0, z = 0 at the slide's rear face.
 */
import * as THREE from "three";
import { PartBuilder } from "../lib/builder";
import { cylX, cylZ, rbox, roundPoly, rrect, section, side, tf, top, tubeZ, type V2 } from "../lib/geo";
import { PAL } from "../lib/mats";
import { bananaOutline, cartridge, insetPoly, instance, pin, Q, type GunDesign, type Lod } from "./common";
import { registerGun } from "./index";

/** the 3-dot sight line above the bore */
export const P_SIGHT_Y = 0.0215;

function buildPistol(lod: Lod): GunDesign {
  const q = Q(lod);
  const b = new PartBuilder();
  const SLIDE = 0x1e1f21, FRAME = 0x1b1c1e, STL = PAL.steel;
  const L = 0.186, yB = -0.0118, yT = 0.0168, W = 0.0255;

  // ------------------------------------------------------------ slide (moves): serrations, port, sights, cover plate
  {
    const sl = b.sub("slide", [0, 0, 0]);
    const prof: V2[] = roundPoly([[0, yB], [-L, yB], [-L, yT - 0.004], [-L + 0.006, yT], [-0.004, yT], [0, yT - 0.004]], [0.0015, 0.002, 0.002, 0.003, 0.003, 0.0015], q.rnd);
    if (q.fp) {
      // a core + a skin with the serrations cut through (1 mm deep grooves) and the ejection port (right)
      sl.add(side(insetPoly(prof, 0.0004), W - 0.002, { bevel: 0.0014, bevelSeg: 2 }), SLIDE, "steel");
      const holes: V2[][] = [];
      for (let i = 0; i < 8; i++) holes.push(rrect(-0.008 - i * 0.0042, -0.0005, 0.0018, 0.019, 0.0008, 2));
      for (let i = 0; i < 6; i++) holes.push(rrect(-0.148 - i * 0.0042, -0.0005, 0.0018, 0.017, 0.0008, 2));
      sl.add(side(prof, W, { bevel: 0.0015, bevelSeg: 2, holes }), SLIDE, "steel");
      // top: the chamfered flat with the optic cover plate
      sl.add(rbox(0.017, 0.0024, 0.034, 0.0009, 1), 0x26282b, "steel", tf([0, yT + 0.0006, -0.03]));
      const ban = bananaOutline(0.011).map(([u, v]) => [v, u - 0.03] as V2);
      sl.add(top(ban, 0.0004, { bevel: 0 }, yT + 0.0019), 0x45484d, "steel", undefined, { wear: 0 });
      // ejection port (right): dark cut + the barrel hood showing
      sl.add(rbox(0.009, 0.0035, 0.034, 0.001, 1), 0x0b0c0d, "steel", tf([0.006, yT - 0.00135, -0.06]));
      sl.add(rbox(0.006, 0.0022, 0.03, 0.0008, 1), PAL.bright, "bright", tf([0.002, yT, -0.06]));
    } else sl.add(side(prof, W, { bevel: 0.0014, bevelSeg: 1 }), SLIDE, "steel");
    // sights: rear (wide notch), front post — steel, tritium dots
    const rear: V2[] = roundPoly([[-0.003, yT], [-0.015, yT], [-0.015, yT + 0.0055], [-0.004, yT + 0.0062]], 0.001, 2);
    for (const sx of [-1, 1]) sl.add(side(rear, 0.0062, { bevel: 0.0007, bevelSeg: 1 }, sx * 0.0063), 0x151617, "steel");
    sl.add(side(roundPoly([[-0.004, yT - 0.0012], [-0.014, yT - 0.0012], [-0.014, yT + 0.0022], [-0.004, yT + 0.0022]], 0.0008, 1), 0.016, { bevel: 0.0006, bevelSeg: 1 }), 0x151617, "steel");
    const front: V2[] = roundPoly([[-0.171, yT], [-0.18, yT], [-0.179, yT + 0.0062], [-0.173, yT + 0.0062]], 0.0008, 2);
    sl.add(side(front, 0.0034, { bevel: 0.0006, bevelSeg: 1 }), 0x151617, "steel");
    if (q.fp) {
      const dot = (x: number, y: number, z: number) => sl.add(cylZ(0.00085, 0.0004, -0.0004, 0, 10), PAL.tritium, "glow", tf([x, y, z]));
      dot(-0.0062, P_SIGHT_Y, -0.0029);
      dot(0.0062, P_SIGHT_Y, -0.0029);
      dot(0, P_SIGHT_Y, -0.1708);
    }
  }
  // barrel crown + guide rod at the muzzle end (fixed)
  b.add(tubeZ(0.0062, 0.0046, -0.175, -0.1872, 0.0005, q.cylS), PAL.bright, "bright");
  if (q.fp) b.add(cylZ(0.004, -0.17, -0.1868, 0.0006, 12), STL, "steel", tf([0, -0.0145, 0]));

  // ------------------------------------------------------------ frame (polymer): dust cover + rail, guard, grip
  {
    const fr: V2[] = roundPoly(
      [
        [0.006, -0.0118], [0.012, -0.016], [0.011, -0.022], [0.004, -0.028], [0.009, -0.06], [0.016, -0.094], [0.02, -0.111],
        [-0.019, -0.113], [-0.026, -0.086], [-0.031, -0.06], [-0.036, -0.038], [-0.044, -0.036], [-0.046, -0.0345],
        [-0.074, -0.036], [-0.077, -0.024], [-0.177, -0.024], [-0.178, -0.0118],
      ],
      [0.002, 0.004, 0.003, 0.006, 0.02, 0.012, 0.004, 0.004, 0.012, 0.02, 0.004, 0.002, 0.002, 0.004, 0.002, 0.002, 0.001],
      q.rnd + 1,
    );
    b.add(side(fr, 0.0285, { bevel: 0.004, bevelSeg: q.fp ? 3 : 1 }), FRAME, "poly");
    // trigger guard loop (square front)
    const outer: V2[] = [[-0.0745, -0.035], [-0.0745, -0.052], [-0.066, -0.0565], [-0.034, -0.0565], [-0.029, -0.05], [-0.032, -0.036]];
    const inner: V2[] = [[-0.0695, -0.036], [-0.0695, -0.0505], [-0.064, -0.0525], [-0.037, -0.0525], [-0.034, -0.048], [-0.036, -0.036]];
    b.add(side(roundPoly(outer, 0.002, q.rnd), 0.012, { bevel: 0.0014, bevelSeg: q.bevelSeg, holes: q.fp ? [roundPoly(inner, 0.002, q.rnd)] : [] }), FRAME, "poly");
    if (q.fp) {
      // accessory rail slots under the dust cover
      for (let i = 0; i < 3; i++) b.add(rbox(0.02, 0.003, 0.004, 0.0008, 1), 0x141516, "poly", tf([0, -0.0245, -0.105 - i * 0.012]));
      // trigger with the safety blade
      b.add(side(roundPoly([[-0.046, -0.024], [-0.042, -0.024], [-0.043, -0.033], [-0.048, -0.042], [-0.052, -0.041], [-0.048, -0.033]], 0.001, 2), 0.0068, { bevel: 0.0008, bevelSeg: 1 }), 0x161718, "poly");
      // slide stop (left), mag release (left), takedown lever
      b.add(side(roundPoly([[-0.052, -0.0105], [-0.078, -0.0105], [-0.08, -0.0145], [-0.054, -0.0158]], 0.001, 2), 0.0018, { bevel: 0.0004, bevelSeg: 1 }, -0.0151), STL, "steel");
      b.add(rbox(0.0034, 0.009, 0.007, 0.0014, 1), 0x141516, "poly", tf([-0.0148, -0.034, -0.03]));
      b.add(rbox(0.0024, 0.004, 0.012, 0.0008, 1), STL, "steel", tf([-0.0148, -0.0185, -0.088]));
      for (const [z, y] of [[-0.02, -0.017], [-0.05, -0.02]] as const) pin(b, lod, -0.0144, y, z, 0.0014, STL);
      // stipple panel on the grip (darker, slightly proud)
      const panel: V2[] = roundPoly([[0.005, -0.04], [0.013, -0.088], [-0.02, -0.09], [-0.027, -0.05]], 0.006, 3);
      b.add(side(panel, 0.0293, { bevel: 0.0008, bevelSeg: 1 }), 0x161718, "poly", undefined, { uv: 60 });
    }
  }
  // ------------------------------------------------------------ magazine: flush floor plate (the body hides in the grip)
  {
    const mg = b.sub("mag", [0, -0.06, -0.005]);
    const body: V2[] = roundPoly([[0.0005, -0.02], [0.0125, -0.106], [-0.015, -0.108], [-0.0245, -0.024]], 0.002, 2);
    mg.add(side(body, 0.0215, { bevel: 0.0012, bevelSeg: 1 }), 0x2a2c2f, "steel");
    mg.add(side(roundPoly([[0.019, -0.108], [0.021, -0.116], [-0.021, -0.118], [-0.02, -0.11]], 0.002, 2), 0.0262, { bevel: 0.0018, bevelSeg: q.bevelSeg }), FRAME, "poly");
    if (q.fp) cartridge(mg, lod, tf([0, -0.016, -0.002]), { len: 0.029, r: 0.0049, neck: 0.0048, tip: 0.012 });
  }

  const built = b.build("pistol");
  return {
    built,
    grip: new THREE.Vector3(0, -0.064, -0.009),
    muzzle: new THREE.Vector3(0, 0, -0.188),
    fore: new THREE.Vector3(-0.02, -0.07, -0.02),
    sight: { front: new THREE.Vector3(0, P_SIGHT_Y, -0.171), rear: new THREE.Vector3(0, P_SIGHT_Y, -0.003) },
    eject: new THREE.Vector3(0.008, 0.016, -0.06),
    length: 0.19,
    anchors: {
      slideRear: new THREE.Vector3(0, 0.003, -0.02),
      magwell: new THREE.Vector3(0, -0.114, 0.0),
    },
  };
}

registerGun("pistol", (lod) => instance("pistol", lod, buildPistol));
void cylX;
void section;
