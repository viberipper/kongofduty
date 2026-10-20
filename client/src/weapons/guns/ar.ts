/**
 * KR-4 CAVENDISH — a 14.5" M4 / MCX-class carbine. Billet upper with side
 * pockets, free-float 13" M-LOK rail, 3-prong flash hider, folded BUIS, an
 * EXPS-style holographic sight (68 MOA ring + dot), FDE polymer magazine,
 * pistol grip and a collapsible stock. One yellow witness mark on the
 * selector, a crescent engraved on the magwell — the only banana on it.
 *
 * Design space: bore along -Z at y = 0, z = 0 at the upper receiver's rear face.
 */
import * as THREE from "three";
import { PartBuilder } from "../lib/builder";
import { cylZ, latheZ, rbox, roundPoly, rrect, section, side, tf, top, type V2 } from "../lib/geo";
import { PAL } from "../lib/mats";
import { bananaOutline, cartridge, flashHider3, insetPoly, instance, lensPane, mlokHandguard, picatinny, pin, Q, reticleObject, type GunDesign, type Lod } from "./common";
import { registerGun } from "./index";

/** optical axis of the holo, above the bore */
export const AR_SIGHT_Y = 0.074;

function buildAR(lod: Lod): GunDesign {
  const q = Q(lod);
  const b = new PartBuilder();
  const BLK = PAL.anodBlack, GRY = 0x2b2e31;

  // ------------------------------------------------------------ upper receiver
  const upper: V2[] = roundPoly([[0.0, -0.016], [-0.178, -0.016], [-0.178, 0.0215], [-0.003, 0.0215], [0.0, 0.0185]], [0.0015, 0.002, 0.002, 0.003, 0.0015], q.rnd);
  if (q.fp) {
    // billet pockets: a thinner core + a frame with the pocket cut through
    b.add(side(insetPoly(upper, 0.0004), 0.0215, { bevel: 0.001, bevelSeg: 2 }), BLK, "anod");
    const pocket = rrect(-0.122, 0.0015, 0.08, 0.021, 0.004, 3);
    const pocket2 = rrect(-0.028, -0.004, 0.026, 0.012, 0.003, 3);
    b.add(side(upper, 0.0237, { bevel: 0.0011, bevelSeg: 2, holes: [pocket, pocket2] }), BLK, "anod");
  } else b.add(side(upper, 0.0235, { bevel: 0.001, bevelSeg: 1 }), BLK, "anod");
  picatinny(b, lod, 0.0, -0.178, 0.0211);
  // barrel nut collar between upper and handguard
  b.add(cylZ(0.0165, -0.175, -0.186, 0.001, q.cyl), PAL.steelDark, "steel");
  // ejection port (right): dark recess, bolt face visible, dust cover hanging open
  if (q.fp) {
    b.add(rbox(0.0012, 0.0155, 0.056, 0.0006, 1), 0x0d0e0f, "steel", tf([0.0116, 0.0035, -0.06]));
    b.add(rbox(0.0011, 0.016, 0.058, 0.0005, 1), BLK, "anod", tf([0.0135, -0.012, -0.06], [0, 0, -1.35]));
    // forward assist housing + button
    b.add(cylZ(0.0062, -0.034, -0.0015, 0.0012, q.cylS), BLK, "anod", tf([0.0125, 0.0105, 0]));
    b.add(cylZ(0.0048, -0.003, 0.007, 0.0012, q.cylS), GRY, "anod", tf([0.0125, 0.0105, 0]));
    // brass deflector
    b.add(rbox(0.006, 0.009, 0.01, 0.0015, 1), BLK, "anod", tf([0.0135, 0.0105, -0.025]));
  }
  // charging handle (pulled on the empty reload): the T-latch behind the rail
  {
    const ch = b.sub("charge", [0, 0.0165, 0.0]);
    if (q.fp) ch.add(rbox(0.012, 0.0065, 0.166, 0.002, 1), GRY, "anod", tf([0, 0.0165, -0.081]));
    const latch: V2[] = roundPoly([[-0.023, -0.003], [0.019, -0.003], [0.019, 0.003], [0.008, 0.004], [-0.019, 0.006], [-0.023, 0.004]], 0.0022, q.rnd);
    ch.add(top(latch.map(([x, z]) => [x, z + 0.006] as V2), 0.0085, { bevel: 0.0012, bevelSeg: q.bevelSeg }, 0.0165), GRY, "anod");
    if (q.fp) ch.add(rbox(0.006, 0.0058, 0.006, 0.0018, 1), PAL.anodBlack, "anod", tf([-0.021, 0.0165, 0.009]));
  }
  // bolt carrier behind the port (cycles on fire)
  if (q.fp) {
    const bc = b.sub("bolt", [0, 0.004, -0.06]);
    bc.add(cylZ(0.0076, -0.088, -0.03, 0.001, q.cylS), PAL.bright, "bright", tf([0.003, 0.004, 0]));
    bc.add(rbox(0.004, 0.006, 0.012, 0.001, 1), PAL.steel, "steel", tf([0.0091, 0.0055, -0.07]));
  }

  // ------------------------------------------------------------ lower receiver
  const lower: V2[] = roundPoly(
    [[0.016, 0.009], [0.001, 0.009], [0.001, -0.016], [-0.142, -0.016], [-0.142, -0.058], [-0.1475, -0.066], [-0.1475, -0.0745], [-0.0735, -0.0745], [-0.0705, -0.067], [-0.0705, -0.037], [0.016, -0.037]],
    [0.004, 0.001, 0.0005, 0.0008, 0.002, 0.002, 0.0015, 0.0015, 0.002, 0.002, 0.004],
    q.rnd,
  );
  b.add(side(lower, 0.026, { bevel: 0.0013, bevelSeg: q.bevelSeg }), BLK, "anod");
  if (q.fp) {
    // magwell flare lip
    const lip = rrect(0, -0.11, 0.031, 0.079, 0.004, 3);
    const hole = rrect(0, -0.109, 0.0235, 0.064, 0.002, 3);
    b.add(top(lip, 0.006, { bevel: 0.0012, bevelSeg: 2, holes: [hole] }, -0.0705), BLK, "anod");
    // bolt-catch fence + mag-release fence (raised ribs)
    b.add(rbox(0.0026, 0.026, 0.004, 0.0009, 1), BLK, "anod", tf([0.0135, -0.033, -0.078]));
    b.add(rbox(0.0026, 0.02, 0.004, 0.0009, 1), BLK, "anod", tf([-0.0135, -0.024, -0.058]));
    // the engraved crescent on the left of the magwell: a hair lighter than the anodize
    const ban = bananaOutline(0.026).map(([u, v]) => [u - 0.108, v - 0.046] as V2);
    b.add(side(ban, 0.0004, { bevel: 0 }, -0.01315), 0x3a3d40, "anod", undefined, { wear: 0 });
  }
  // trigger guard (a loop) + trigger
  {
    const outer: V2[] = [[-0.0725, -0.033], [-0.0725, -0.05], [-0.062, -0.0565], [-0.009, -0.0565], [0.002, -0.047], [0.002, -0.033]];
    const inner: V2[] = [[-0.0665, -0.0395], [-0.0665, -0.049], [-0.0585, -0.0525], [-0.011, -0.0525], [-0.004, -0.045], [-0.004, -0.0395]];
    b.add(side(roundPoly(outer, 0.002, q.rnd), 0.0125, { bevel: 0.0012, bevelSeg: q.bevelSeg, holes: q.fp ? [roundPoly(inner, 0.0025, q.rnd)] : [] }), BLK, "anod");
    const trg: V2[] = [[-0.0335, -0.037], [-0.0305, -0.037], [-0.0322, -0.045], [-0.0372, -0.0505], [-0.0402, -0.0498], [-0.0362, -0.0448]];
    if (q.fp) b.add(side(roundPoly(trg, 0.001, 2), 0.0055, { bevel: 0.0008, bevelSeg: 1 }), PAL.steel, "steel");
  }
  // selector (left, ambi): lever pointing forward at FIRE, the yellow witness dot on its tip
  if (q.fp) {
    for (const sx of [-1, 1]) {
      b.add(cylZ(0.0058, -0.0012, 0.0012, 0.0005, 18), GRY, "steel", tf([sx * 0.0137, -0.0225, -0.004], [0, Math.PI / 2, 0]));
      const lever: V2[] = roundPoly([[0.0, -0.0028], [-0.019, -0.0018], [-0.019, 0.0028], [0.0, 0.003]], 0.0016, 2);
      b.add(side(lever.map(([z, y]) => [z - 0.004, y - 0.0225] as V2), 0.0018, { bevel: 0.0005, bevelSeg: 1 }, sx * 0.0152), GRY, "steel");
    }
    b.add(cylZ(0.0013, -0.0004, 0.0004, 0, 10), PAL.banana, "glow", tf([-0.0162, -0.0225, -0.0205], [0, Math.PI / 2, 0]));
    // bolt catch (left): a paddle the support hand slaps on the empty reload
    const ct = b.sub("catch", [-0.0138, -0.019, -0.066]);
    const paddle: V2[] = roundPoly([[-0.058, -0.026], [-0.072, -0.026], [-0.076, -0.014], [-0.06, -0.012]], 0.0018, 2);
    ct.add(side(paddle, 0.003, { bevel: 0.0008, bevelSeg: 1 }, -0.0149), GRY, "steel");
    // mag release (right)
    b.add(cylZ(0.0045, -0.0015, 0.0015, 0.0006, 16), GRY, "steel", tf([0.0142, -0.028, -0.067], [0, Math.PI / 2, 0]));
    // pins
    for (const [z, y] of [[-0.137, -0.009], [0.009, -0.009], [-0.035, -0.027], [-0.017, -0.027]] as const) {
      pin(b, lod, -0.0133, y, z, 0.0024, GRY);
      pin(b, lod, 0.0133, y, z, 0.0024, GRY);
    }
  }

  // ------------------------------------------------------------ pistol grip
  {
    const g: V2[] = roundPoly(
      [[-0.012, -0.0355], [-0.005, -0.056], [0.003, -0.072], [0.0035, -0.08], [0.011, -0.096], [0.0175, -0.118], [0.0195, -0.128], [0.057, -0.133], [0.052, -0.1], [0.043, -0.07], [0.036, -0.05], [0.041, -0.041], [0.036, -0.0355]],
      [0.002, 0.006, 0.004, 0.004, 0.012, 0.01, 0.004, 0.006, 0.02, 0.012, 0.004, 0.003, 0.002],
      q.rnd + 1,
    );
    b.add(side(g, 0.0272, { bevel: 0.0055, bevelSeg: q.fp ? 3 : 1 }), PAL.polyBlack, "poly");
    if (q.fp) {
      // grip-cap floor plate
      const cap: V2[] = roundPoly([[0.018, -0.127], [0.0575, -0.1325], [0.0585, -0.137], [0.019, -0.1325]], 0.0018, 2);
      b.add(side(cap, 0.026, { bevel: 0.0015, bevelSeg: 1 }), PAL.polyGrey, "poly");
    }
  }

  // ------------------------------------------------------------ magazine (FDE polymer, 30)
  {
    const mg = b.sub("mag", [0, -0.03, -0.108]);
    const front = (t: number): V2 => [-0.1395 - 0.034 * t * t - 0.012 * t, -0.0178 - 0.1662 * t];
    const back = (t: number): V2 => [-0.0765 - 0.03 * t * t - 0.01 * t, -0.0178 - 0.1602 * t];
    const pts: V2[] = [];
    for (let i = 0; i <= 8; i++) pts.push(front(i / 8));
    for (let i = 8; i >= 0; i--) pts.push(back(i / 8));
    const body = roundPoly(pts, pts.map((_, i) => (i === 0 || i === pts.length - 1 ? 0.001 : i === 8 || i === 9 ? 0.004 : 0)), 2);
    mg.add(side(body, 0.0228, { bevel: 0.0022, bevelSeg: q.bevelSeg }), PAL.fde, "poly");
    if (q.fp) {
      // the "sideline" panel + grip ribs near the base (raised)
      for (let k = 0; k < 4; k++) {
        const t = 0.66 + k * 0.07;
        const f = front(t), bk = back(t);
        const rib: V2[] = roundPoly([[f[0] + 0.003, f[1] + 0.0016], [bk[0] - 0.003, bk[1] + 0.0016], [bk[0] - 0.003, bk[1] - 0.0016], [f[0] + 0.003, f[1] - 0.0016]], 0.0012, 2);
        mg.add(side(rib, 0.0246, { bevel: 0.0007, bevelSeg: 1 }), PAL.fdeDark, "poly");
      }
      // dot-matrix panel (a flat, slightly raised pad)
      const f1 = front(0.3), b1 = back(0.3), f2 = front(0.52), b2 = back(0.52);
      const pad: V2[] = roundPoly([[f1[0] + 0.007, f1[1]], [b1[0] - 0.007, b1[1]], [b2[0] - 0.007, b2[1]], [f2[0] + 0.007, f2[1]]], 0.003, 2);
      mg.add(side(pad, 0.0238, { bevel: 0.0005, bevelSeg: 1 }), 0x9a8566, "poly");
      // the top round at the feed lips
      cartridge(mg, lod, tf([0.0, -0.0125, -0.08], [0, 0, 0]), { len: 0.057 });
    }
    // floor plate
    const fb = front(1), bb = back(1);
    const plate: V2[] = roundPoly([[fb[0] - 0.004, fb[1] + 0.004], [fb[0] - 0.004, fb[1] - 0.006], [bb[0] + 0.003, bb[1] - 0.006], [bb[0] + 0.003, bb[1] + 0.004]], [0.002, 0.004, 0.003, 0.002], 2);
    mg.add(side(plate, 0.0252, { bevel: 0.0018, bevelSeg: q.bevelSeg }), PAL.fdeDark, "poly");
  }

  // ------------------------------------------------------------ barrel + handguard + muzzle
  b.add(cylZ(0.0098, -0.17, -0.535, 0.0005, q.cyl), PAL.steelDark, "steel");
  if (q.fp) b.add(cylZ(0.0145, -0.37, -0.392, 0.001, q.cylS), PAL.steelDark, "steel"); // gas block
  mlokHandguard(b, lod, -0.506, -0.183, { hw: 0.0218, yT: 0.0213, yB: -0.0245, slots: 6, color: BLK });
  if (q.fp) {
    // handguard front bevel ring + its two cross bolts (left side)
    for (const z of [-0.2, -0.214]) b.add(cylZ(0.0026, -0.0006, 0.0006, 0.0003, 12), GRY, "steel", tf([-0.0222, -0.0165, z], [0, Math.PI / 2, 0]));
  }
  flashHider3(b, lod, -0.535, 0.058);

  // ------------------------------------------------------------ folded BUIS
  if (q.fp) {
    b.add(rbox(0.024, 0.009, 0.016, 0.002, 1), BLK, "anod", tf([0, 0.033, -0.006]));
    b.add(rbox(0.006, 0.006, 0.012, 0.0015, 1), GRY, "anod", tf([0, 0.0395, -0.006]));
    b.add(rbox(0.022, 0.009, 0.018, 0.002, 1), BLK, "anod", tf([0, 0.033, -0.492]));
    b.add(rbox(0.004, 0.005, 0.014, 0.0012, 1), GRY, "anod", tf([0, 0.039, -0.492]));
  }

  // ------------------------------------------------------------ holographic sight (EXPS-style)
  // a short thin-walled hood round ONE big front window, the battery body forward and below it.
  // (Game-oversized ~1.4x so the aimed sight picture reads at CoD scale.)
  {
    const zR = -0.034, zH = -0.07, zN = -0.122, yA = AR_SIGHT_Y;
    const wx = 0.022, wb = yA - 0.0175, wt = yA + 0.0185, t = 0.0028;
    const yBody = wb - 0.002;
    // rail clamp base
    b.add(section(roundPoly([[-0.0185, 0.0285], [0.0185, 0.0285], [0.0185, 0.036], [-0.0185, 0.036]], [0.001, 0.001, 0.002, 0.002], 2), -0.018, -0.128, { bevel: 0.0012, bevelSeg: q.bevelSeg }), BLK, "anod");
    // electronics body under the window, running forward into the battery nose
    b.add(section(roundPoly([[-0.017, 0.035], [0.017, 0.035], [0.017, yBody], [-0.017, yBody]], [0.003, 0.003, 0.002, 0.002], q.rnd), zR - 0.008, zN, { bevel: 0.002, bevelSeg: q.bevelSeg }), BLK, "anod");
    const nose: V2[] = roundPoly([[zH + 0.002, yBody - 0.002], [zN, yBody - 0.002], [zN + 0.012, yBody + 0.004], [zH + 0.002, yBody + 0.005]], [0, 0.004, 0.006, 0.001], q.rnd + 1);
    b.add(side(nose, 0.039, { bevel: 0.002, bevelSeg: q.bevelSeg }), BLK, "anod");
    // the hood: thin walls round the window
    const outer = roundPoly([[-(wx + t), wb - t], [wx + t, wb - t], [wx + t, wt + t], [-(wx + t), wt + t]], [0.002, 0.002, 0.0075, 0.0075], q.rnd + 1);
    const win = roundPoly([[-wx, wb], [wx, wb], [wx, wt], [-wx, wt]], [0.0015, 0.0015, 0.005, 0.005], q.rnd + 1);
    b.add(section(outer, zR, zH, { bevel: 0.0011, bevelSeg: q.bevelSeg, holes: [win] }), BLK, "anod", undefined, { wear: 0.25 });
    if (q.fp) {
      // matte liner inside the hood (no shiny tunnel)
      const winIn = roundPoly([[-wx + 0.0007, wb + 0.0007], [wx - 0.0007, wb + 0.0007], [wx - 0.0007, wt - 0.0007], [-wx + 0.0007, wt - 0.0007]], [0.001, 0.001, 0.0045, 0.0045], q.rnd + 1);
      b.add(section(win, zR - 0.0004, zH + 0.0004, { bevel: 0, holes: [winIn] }), 0x0b0c0d, "anod", undefined, { wear: 0 });
      lensPane(b, 0, (wb + wt) / 2, wx * 2, wt - wb, zH + 0.0035, 0.004, 0x86b8ae);
      // buttons (left, on the nose), battery cap (right), QD levers (left)
      for (const z of [-0.088, -0.104]) b.add(rbox(0.004, 0.0072, 0.011, 0.0018, 2), PAL.rubber, "rubber", tf([-0.0202, 0.046, z]));
      b.add(cylZ(0.0075, -0.002, 0.004, 0.0012, 20), BLK, "anod", tf([0.0205, 0.046, -0.098], [0, Math.PI / 2, 0]));
      for (const z of [-0.05, -0.098]) {
        const lever: V2[] = roundPoly([[0.006, -0.003], [-0.014, -0.002], [-0.014, 0.003], [0.006, 0.003]], 0.0015, 2);
        b.add(side(lever.map(([zz, y]) => [zz + z, y + 0.032] as V2), 0.0026, { bevel: 0.0006, bevelSeg: 1 }, -0.0205), GRY, "anod");
        b.add(cylZ(0.004, -0.0012, 0.0012, 0.0005, 14), GRY, "anod", tf([-0.0214, 0.032, z + 0.006], [0, Math.PI / 2, 0]));
      }
      // the reticle: 68 MOA ring + dot, collimated (drawn on the window plane, on the sight axis)
      const ret = reticleObject(0.0022, 0.00026, PAL.reticle, true);
      ret.position.set(0, yA, zH + 0.003);
      b.object(ret);
    }
  }

  // ------------------------------------------------------------ buffer tube + stock
  b.add(cylZ(0.0147, 0.0165, 0.255, 0.001, q.cyl), BLK, "anod", tf([0, -0.0015, 0]));
  b.add(cylZ(0.0178, 0.012, 0.022, 0.0012, q.fp ? 12 : 8), GRY, "steel", tf([0, -0.0015, 0]));
  {
    const st: V2[] = roundPoly([[0.128, 0.0215], [0.268, 0.0215], [0.279, 0.016], [0.279, -0.098], [0.262, -0.106], [0.214, -0.054], [0.152, -0.03], [0.128, -0.024]], [0.006, 0.006, 0.004, 0.004, 0.01, 0.03, 0.01, 0.005], q.rnd + 1);
    b.add(side(st, 0.035, { bevel: 0.006, bevelSeg: q.fp ? 3 : 1 }), PAL.polyBlack, "poly");
    const pad: V2[] = roundPoly([[0.276, 0.023], [0.29, 0.023], [0.29, -0.107], [0.276, -0.104]], 0.004, 2);
    b.add(side(pad, 0.038, { bevel: 0.004, bevelSeg: q.bevelSeg }), PAL.rubber, "rubber");
    if (q.fp) b.add(rbox(0.008, 0.007, 0.03, 0.002, 1), PAL.polyGrey, "poly", tf([0, -0.03, 0.175], [0.35, 0, 0]));
  }

  const built = b.build("ar");
  return {
    built,
    grip: new THREE.Vector3(0, -0.081, 0.0245),
    muzzle: new THREE.Vector3(0, 0, -0.593),
    fore: new THREE.Vector3(0, -0.024, -0.36),
    sight: { front: new THREE.Vector3(0, AR_SIGHT_Y, -0.07), rear: new THREE.Vector3(0, AR_SIGHT_Y, -0.034) },
    eject: new THREE.Vector3(0.0125, 0.0035, -0.058),
    length: 0.883,
    anchors: {
      magwell: new THREE.Vector3(0, -0.0745, -0.111),
      chargeKnob: new THREE.Vector3(-0.021, 0.0165, 0.009),
      catch: new THREE.Vector3(-0.0152, -0.02, -0.067),
    },
  };
}

registerGun("ar", (lod) => instance("ar", lod, buildAR));
void latheZ;
