/**
 * MX9 LADYFINGER — a compact 9mm PDW in the MPX / APC9 mould: flat-top
 * aluminium upper, short M-LOK handguard, a non-reciprocating side charger on
 * the left (the empty reload's slap), polymer lower and grip, a slightly
 * curved 9mm stick magazine, a two-rod PDW stock, a micro red dot (T2-class)
 * on a tall mount. The yellow witness mark on the selector, nothing louder.
 *
 * Design space: bore along -Z at y = 0, z = 0 at the upper receiver's rear face.
 */
import * as THREE from "three";
import { PartBuilder } from "../lib/builder";
import { cylX, cylZ, rbox, roundPoly, rrect, section, side, tf, top, tubeZ, type V2 } from "../lib/geo";
import { PAL } from "../lib/mats";
import { cartridge, insetPoly, instance, lensDisc, mlokHandguard, picatinny, pin, Q, reticleObject, sector, type GunDesign, type Lod } from "./common";
import { registerGun } from "./index";

/** optical axis of the micro dot above the bore */
export const SMG_SIGHT_Y = 0.072;

function buildSMG(lod: Lod): GunDesign {
  const q = Q(lod);
  const b = new PartBuilder();
  const BLK = PAL.anodBlack, GRY = 0x2b2e31, POLY = PAL.polyBlack;

  // ------------------------------------------------------------ upper receiver (with the side-charger slot)
  const upper: V2[] = roundPoly([[0.0, -0.014], [-0.196, -0.014], [-0.196, 0.0195], [-0.003, 0.0195], [0.0, 0.0165]], [0.0015, 0.002, 0.002, 0.003, 0.0015], q.rnd);
  if (q.fp) {
    b.add(side(insetPoly(upper, 0.0004), 0.0215, { bevel: 0.001, bevelSeg: 2 }), BLK, "anod");
    // the charger channel on the left (cut through the outer skin) + a lightening pocket
    const slot = rrect(-0.118, 0.006, 0.09, 0.0065, 0.003, 3);
    const pocket = rrect(-0.04, -0.003, 0.05, 0.014, 0.004, 3);
    b.add(side(upper, 0.0235, { bevel: 0.0011, bevelSeg: 2, holes: [slot, pocket] }), BLK, "anod");
  } else b.add(side(upper, 0.0235, { bevel: 0.001, bevelSeg: 1 }), BLK, "anod");
  picatinny(b, lod, 0.0, -0.196, 0.0191);
  // side charger (left): rides the channel, pulled back on the empty reload
  {
    const ch = b.sub("charge", [-0.0125, 0.006, -0.158]);
    ch.add(rbox(0.004, 0.005, 0.02, 0.0015, 1), GRY, "anod", tf([-0.0118, 0.006, -0.158]));
    const knob: V2[] = roundPoly([[-0.152, -0.004], [-0.166, -0.004], [-0.168, 0.004], [-0.152, 0.005]], 0.002, 2);
    ch.add(side(knob, 0.016, { bevel: 0.002, bevelSeg: q.bevelSeg }, -0.021).applyMatrix4(tf([0, 0.006, 0])), POLY, "poly");
  }
  // ejection port (right) + bolt behind it
  if (q.fp) {
    b.add(rbox(0.0012, 0.013, 0.04, 0.0006, 1), 0x0d0e0f, "steel", tf([0.0118, 0.003, -0.075]));
    const bc = b.sub("bolt", [0, 0.003, -0.075]);
    bc.add(cylZ(0.0068, -0.095, -0.055, 0.001, q.cylS), PAL.bright, "bright", tf([0.003, 0.003, 0]));
  }

  // ------------------------------------------------------------ lower (polymer) + 9mm magwell
  const lower: V2[] = roundPoly(
    [[0.012, 0.006], [0.001, 0.006], [0.001, -0.014], [-0.128, -0.014], [-0.128, -0.054], [-0.132, -0.062], [-0.132, -0.07], [-0.088, -0.07], [-0.086, -0.062], [-0.086, -0.036], [0.012, -0.036]],
    [0.004, 0.001, 0.0005, 0.002, 0.002, 0.002, 0.0015, 0.0015, 0.002, 0.002, 0.004],
    q.rnd,
  );
  b.add(side(lower, 0.025, { bevel: 0.0018, bevelSeg: q.bevelSeg }), POLY, "poly");
  if (q.fp) {
    const lip = rrect(0, -0.11, 0.0265, 0.05, 0.004, 3);
    const hole = rrect(0, -0.11, 0.0205, 0.038, 0.002, 3);
    b.add(top(lip, 0.006, { bevel: 0.0012, bevelSeg: 2, holes: [hole] }, -0.0675), POLY, "poly");
    // ambi mag release paddles behind the magwell
    for (const sx of [-1, 1]) b.add(rbox(0.003, 0.012, 0.008, 0.0012, 1), GRY, "steel", tf([sx * 0.0135, -0.045, -0.083]));
  }
  // trigger guard + trigger
  {
    const outer: V2[] = [[-0.0845, -0.032], [-0.0845, -0.049], [-0.074, -0.055], [-0.009, -0.055], [0.002, -0.046], [0.002, -0.032]];
    const inner: V2[] = [[-0.0785, -0.0385], [-0.0785, -0.048], [-0.0705, -0.0515], [-0.011, -0.0515], [-0.004, -0.044], [-0.004, -0.0385]];
    b.add(side(roundPoly(outer, 0.002, q.rnd), 0.0125, { bevel: 0.0012, bevelSeg: q.bevelSeg, holes: q.fp ? [roundPoly(inner, 0.0025, q.rnd)] : [] }), POLY, "poly");
    const trg: V2[] = [[-0.0335, -0.036], [-0.0305, -0.036], [-0.0322, -0.044], [-0.0372, -0.0495], [-0.0402, -0.0488], [-0.0362, -0.0438]];
    if (q.fp) b.add(side(roundPoly(trg, 0.001, 2), 0.0055, { bevel: 0.0008, bevelSeg: 1 }), PAL.steel, "steel");
  }
  if (q.fp) {
    for (const sx of [-1, 1]) {
      b.add(cylZ(0.0055, -0.0012, 0.0012, 0.0005, 18), GRY, "steel", tf([sx * 0.0132, -0.021, -0.004], [0, Math.PI / 2, 0]));
      const lever: V2[] = roundPoly([[0.0, -0.0026], [-0.017, -0.0017], [-0.017, 0.0026], [0.0, 0.0028]], 0.0015, 2);
      b.add(side(lever.map(([z, y]) => [z - 0.004, y - 0.021] as V2), 0.0018, { bevel: 0.0005, bevelSeg: 1 }, sx * 0.0146), GRY, "steel");
    }
    b.add(cylZ(0.0012, -0.0004, 0.0004, 0, 10), PAL.banana, "glow", tf([-0.0156, -0.021, -0.0185], [0, Math.PI / 2, 0]));
    for (const [z, y] of [[-0.12, -0.008], [0.006, -0.008], [-0.035, -0.026], [-0.018, -0.026]] as const) {
      pin(b, lod, -0.0128, y, z, 0.0022, GRY);
      pin(b, lod, 0.0128, y, z, 0.0022, GRY);
    }
  }
  // pistol grip (same ergonomics as the carbine)
  {
    const g: V2[] = roundPoly(
      [[-0.012, -0.0345], [-0.005, -0.055], [0.003, -0.071], [0.0035, -0.079], [0.011, -0.095], [0.0175, -0.117], [0.0195, -0.127], [0.056, -0.132], [0.051, -0.099], [0.042, -0.069], [0.035, -0.049], [0.04, -0.04], [0.035, -0.0345]],
      [0.002, 0.006, 0.004, 0.004, 0.012, 0.01, 0.004, 0.006, 0.02, 0.012, 0.004, 0.003, 0.002],
      q.rnd + 1,
    );
    b.add(side(g, 0.027, { bevel: 0.0055, bevelSeg: q.fp ? 3 : 1 }), POLY, "poly");
  }

  // ------------------------------------------------------------ 9mm stick magazine (slight forward curve)
  {
    const mg = b.sub("mag", [0, -0.03, -0.108]);
    const front = (t: number): V2 => [-0.1268 - 0.012 * t * t, -0.0158 - 0.1782 * t];
    const back = (t: number): V2 => [-0.0928 - 0.01 * t * t, -0.0158 - 0.1742 * t];
    const pts: V2[] = [];
    for (let i = 0; i <= 6; i++) pts.push(front(i / 6));
    for (let i = 6; i >= 0; i--) pts.push(back(i / 6));
    mg.add(side(roundPoly(pts, pts.map((_, i) => (i === 6 || i === 7 ? 0.003 : 0.0008)), 2), 0.0196, { bevel: 0.0018, bevelSeg: q.bevelSeg }), 0x26282b, "poly");
    if (q.fp) {
      // witness holes down the spine (dark pads) and the base grip ribs
      for (let k = 0; k < 5; k++) {
        const t = 0.25 + k * 0.1;
        const f = front(t), bk = back(t);
        mg.add(side(rrect((f[0] + bk[0]) / 2 + 0.006, f[1], 0.0035, 0.0035, 0.0017, 2), 0.0204, { bevel: 0.0003, bevelSeg: 1 }), 0x101112, "poly");
      }
      cartridge(mg, lod, tf([0, -0.011, -0.098]), { len: 0.03, r: 0.0049, neck: 0.0048, tip: 0.012 });
    }
    const fb = front(1), bb = back(1);
    const plate: V2[] = roundPoly([[fb[0] - 0.003, fb[1] + 0.004], [fb[0] - 0.003, fb[1] - 0.007], [bb[0] + 0.003, bb[1] - 0.007], [bb[0] + 0.003, bb[1] + 0.004]], [0.002, 0.004, 0.003, 0.002], 2);
    mg.add(side(plate, 0.0222, { bevel: 0.0018, bevelSeg: q.bevelSeg }), POLY, "poly");
  }

  // ------------------------------------------------------------ barrel, handguard, muzzle
  b.add(cylZ(0.0088, -0.19, -0.352, 0.0005, q.cyl), PAL.steelDark, "steel");
  mlokHandguard(b, lod, -0.335, -0.199, { hw: 0.0195, yT: 0.0191, yB: -0.0225, slots: 3, color: BLK });
  // 3-lug mount + a short linear-style flash cone
  {
    const z0 = -0.352;
    b.add(cylZ(0.0105, z0 + 0.004, z0 - 0.012, 0.0008, q.cyl), PAL.steelDark, "steel");
    if (q.fp) for (let i = 0; i < 3; i++) b.add(section(sector(0.0102, 0.0122, Math.PI / 2 + (i * Math.PI * 2) / 3, 0.5, 4), z0 - 0.002, z0 - 0.01, { bevel: 0.0004, bevelSeg: 1 }), PAL.steelDark, "steel");
    b.add(tubeZ(0.0118, 0.0066, z0 - 0.012, z0 - 0.042, 0.001, q.cyl), PAL.steelDark, "steel");
  }

  // ------------------------------------------------------------ PDW stock: two rods + a butt plate (collapsed)
  {
    for (const sx of [-1, 1]) b.add(cylZ(0.0052, 0.004, 0.172, 0.0008, q.cylS), PAL.steel, "steel", tf([sx * 0.0115, -0.004, 0]));
    const plate: V2[] = roundPoly([[0.165, 0.012], [0.18, 0.012], [0.18, -0.09], [0.167, -0.086]], [0.004, 0.004, 0.006, 0.006], 2);
    b.add(side(plate, 0.036, { bevel: 0.004, bevelSeg: q.bevelSeg }), POLY, "poly");
    b.add(side(roundPoly([[0.178, 0.013], [0.188, 0.013], [0.188, -0.091], [0.178, -0.088]], 0.003, 2), 0.038, { bevel: 0.003, bevelSeg: 1 }), PAL.rubber, "rubber");
    // the stock's receiver block
    b.add(rbox(0.0226, 0.022, 0.018, 0.004, 2), POLY, "poly", tf([0, -0.004, 0.011]));
  }

  // ------------------------------------------------------------ micro red dot on a tall mount
  {
    const yA = SMG_SIGHT_Y, R = 0.0185, zR = -0.05, zF = -0.1;
    // mount: rail clamp + riser
    b.add(section(roundPoly([[-0.012, 0.0265], [0.012, 0.0265], [0.012, 0.034], [-0.012, 0.034]], 0.001, 2), -0.058, -0.094, { bevel: 0.001, bevelSeg: 1 }), BLK, "anod");
    b.add(side(roundPoly([[-0.06, 0.033], [-0.092, 0.033], [-0.088, yA - R + 0.004], [-0.064, yA - R + 0.004]], 0.003, 2), 0.016, { bevel: 0.0015, bevelSeg: q.bevelSeg }), BLK, "anod");
    if (q.fp) b.add(cylX(0.0045, 0.006, 0.0012, 14), GRY, "steel", tf([-0.012, 0.03, -0.076]));
    // the tube: thin walls, flared hoods both ends
    // (tubeZ is centred on the bore axis: lift it onto the sight axis)
    b.add(tubeZ(R + 0.0022, R - 0.0004, zR, zF, 0.0011, q.cyl + 8), BLK, "anod", tf([0, yA, 0]), { wear: 0.3 });
    b.add(tubeZ(R + 0.0036, R + 0.001, zF + 0.006, zF - 0.002, 0.001, q.cyl + 8), BLK, "anod", tf([0, yA, 0]), { wear: 0.3 });
    // turrets: elevation on top, windage right
    b.add(cylZ(0.0072, -0.0078, 0.0, 0.0015, 18), BLK, "anod", tf([0, yA + R + 0.009, -0.075], [-Math.PI / 2, 0, 0]));
    b.add(cylZ(0.0072, -0.0078, 0.0, 0.0015, 18), BLK, "anod", tf([R + 0.009, yA, -0.075], [0, Math.PI / 2, 0]));
    if (q.fp) {
      // brightness dial on the left
      b.add(cylZ(0.0085, -0.0058, 0.0, 0.0015, 20), GRY, "anod", tf([-R - 0.007, yA, -0.075], [0, -Math.PI / 2, 0]));
      lensDisc(b, 0, yA, R - 0.0004, zF + 0.002, 0x8bb4c2);
      const ret = reticleObject(0, 0.00055, PAL.reticle);
      ret.position.set(0, yA, zF + 0.0025);
      b.object(ret);
    }
  }

  const built = b.build("smg");
  return {
    built,
    grip: new THREE.Vector3(0, -0.081, 0.0245),
    muzzle: new THREE.Vector3(0, 0, -0.394),
    fore: new THREE.Vector3(0, -0.022, -0.27),
    sight: { front: new THREE.Vector3(0, SMG_SIGHT_Y, -0.1), rear: new THREE.Vector3(0, SMG_SIGHT_Y, -0.05) },
    eject: new THREE.Vector3(0.0125, 0.003, -0.075),
    length: 0.582,
    anchors: {
      magwell: new THREE.Vector3(0, -0.07, -0.11),
      chargeKnob: new THREE.Vector3(-0.028, 0.006, -0.16),
    },
  };
}

registerGun("smg", (lod) => instance("smg", lod, buildSMG));
