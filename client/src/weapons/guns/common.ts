/**
 * Shared pieces of the four tactical guns: the Picatinny rail, cartridges,
 * the reticle, and the cache that turns one built master per (gun, LOD) into
 * a fresh scene graph per buildGun() call (geometry + materials shared).
 *
 * Every builder authors in DESIGN SPACE — bore along -Z at y = 0, x = 0 —
 * and declares where the trigger hand's palm closes (`grip`); the cache wraps
 * the model so that point lands on the GunModel origin, as index.ts requires.
 */
import * as THREE from "three";
import { PartBuilder, type Built } from "../lib/builder";
import { cylZ, latheZ, roundPoly, rrect, section, side, spread, tf, type V2 } from "../lib/geo";
import { PAL } from "../lib/mats";
import type { GunId, GunModel } from "./index";

export type Lod = "fp" | "tp";

/** what a gun builder returns (design space) */
export type GunDesign = {
  built: Built;
  /** trigger-hand palm point (design space) — becomes the origin */
  grip: THREE.Vector3;
  muzzle: THREE.Vector3;
  fore: THREE.Vector3 | null;
  sight: { front: THREE.Vector3; rear: THREE.Vector3 } | null;
  eject: THREE.Vector3;
  length: number;
  /** extra named anchors (design space): magwell, charging handle knob, bolt knob, slide serrations, port… */
  anchors?: Record<string, THREE.Vector3>;
};

/** the GunModel plus the viewmodel's extras */
export type GunModelX = GunModel & {
  /** every named moving part (mag, bolt, charge, slide, trigger, cover, …) */
  parts: Record<string, THREE.Object3D>;
  /** extra anchors in gun space */
  anchors: Record<string, THREE.Vector3>;
};

const masters = new Map<string, GunDesign>();

/** QA only (qa/x/gun-coplanar.mjs): drop the cached masters so the next buildGun() rebuilds from source. */
export function clearGunCache(): void {
  masters.clear();
}

/** cache a master per (id, lod) and hand out a fresh instance that satisfies the GunModel contract */
export function instance(id: GunId, lod: Lod, make: (lod: Lod) => GunDesign): GunModelX {
  const key = `${id}:${lod}`;
  let d = masters.get(key);
  if (!d) {
    d = make(lod);
    masters.set(key, d);
  }
  const root = new THREE.Group();
  root.name = `gun-${id}-${lod}`;
  const inner = d.built.root.clone(true);
  inner.position.copy(d.grip).negate();
  root.add(inner);
  const parts: Record<string, THREE.Object3D> = {};
  inner.traverse((o) => {
    if ((o as THREE.Group).isGroup && o !== inner && d!.built.pivots[o.name]) {
      parts[o.name] = o;
      o.userData.home = { p: o.position.clone(), q: o.quaternion.clone() };
    }
  });
  const g = d.grip;
  const rel = (v: THREE.Vector3) => v.clone().sub(g);
  const anchors: Record<string, THREE.Vector3> = {};
  for (const [k, v] of Object.entries(d.anchors ?? {})) anchors[k] = rel(v);
  return {
    id,
    lod,
    root,
    muzzle: rel(d.muzzle),
    grip: new THREE.Vector3(),
    fore: d.fore ? rel(d.fore) : null,
    sight: d.sight ? { front: rel(d.sight.front), rear: rel(d.sight.rear) } : null,
    eject: rel(d.eject),
    mag: parts["mag"] ?? null,
    bolt: parts["bolt"] ?? parts["slide"] ?? null,
    length: d.length,
    parts,
    anchors,
  };
}

/** segment counts per LOD */
export function Q(lod: Lod) {
  const fp = lod === "fp";
  return {
    fp,
    cyl: fp ? 24 : 10,
    cylS: fp ? 14 : 6,
    bevelSeg: fp ? 2 : 1,
    curve: fp ? 6 : 2,
    rnd: fp ? 3 : 1,
  };
}

/**
 * MIL-STD-1913 rail along -Z from z0 to z1 (z1 < z0), base at y0, width w.
 * fp: the real cross slots (0.394" pitch); tp: the plain dovetail bar.
 */
export function picatinny(b: PartBuilder, lod: Lod, z0: number, z1: number, y0: number, w = 0.0212, color: number = PAL.anodBlack): void {
  const q = Q(lod);
  const hRail = 0.0075; // base to top
  // dovetail section: narrow neck, wide top with 45° flanks
  const sec = (h: number): V2[] => [
    [-w * 0.36, y0],
    [w * 0.36, y0],
    [w * 0.36, y0 + h * 0.25],
    [w / 2, y0 + h * 0.55],
    [w / 2, y0 + h * 0.8],
    [w * 0.42, y0 + h],
    [-w * 0.42, y0 + h],
    [-w / 2, y0 + h * 0.8],
    [-w / 2, y0 + h * 0.55],
    [-w * 0.36, y0 + h * 0.25],
  ];
  if (!q.fp) {
    b.add(section(sec(hRail), z0, z1, { bevel: 0.0006, bevelSeg: 1 }), color, "anod");
    return;
  }
  // the slot floor (the whole rail at slot depth) + raised teeth between the slots.
  // ZERO-FLICKER: a tooth is only the CROWN (from inside the floor up), so no tooth
  // face shares a plane with the floor's bottom or neck faces.
  const floor: V2[] = sec(hRail * 0.55);
  b.add(section(floor, z0, z1, { bevel: 0.0005, bevelSeg: 1 }), color, "anod");
  const crown = (h: number): V2[] => [
    [-w / 2 + 0.0004, y0 + h * 0.42],
    [w / 2 - 0.0004, y0 + h * 0.42],
    [w / 2, y0 + h * 0.8],
    [w * 0.42, y0 + h],
    [-w * 0.42, y0 + h],
    [-w / 2, y0 + h * 0.8],
  ];
  const pitch = 0.01;
  const slot = 0.0053;
  const len = Math.abs(z1 - z0);
  const n = Math.max(1, Math.floor((len - 0.002) / pitch));
  const start = Math.max(z0, z1) - (len - n * pitch) / 2;
  for (let i = 0; i < n; i++) {
    const za = start - i * pitch;
    const zb = za - (pitch - slot);
    b.add(section(crown(hRail), za, zb, { bevel: 0.0006, bevelSeg: 1 }), color, "anod", undefined, { wear: 0.8 });
  }
}

/** a cartridge along -Z (bullet forward), base at z = 0, 5.56-ish by default */
export function cartridge(b: PartBuilder, lod: Lod, m: THREE.Matrix4, opts: { len?: number; r?: number; neck?: number; tip?: number } = {}): void {
  const q = Q(lod);
  const L = opts.len ?? 0.057, r = opts.r ?? 0.0048, rn = opts.neck ?? 0.0029, tl = opts.tip ?? 0.019;
  const body = L - tl;
  const caseP: V2[] = [
    [0, 0],
    [r * 1.0, 0],
    [r * 1.0, -0.0012],
    [r * 0.82, -0.0016],
    [r * 0.82, -0.0028],
    [r * 0.98, -0.0034],
    [r * 0.94, -body * 0.78],
    [rn, -body * 0.86],
    [rn, -body],
    [0, -body],
  ];
  b.add(latheZ(caseP, q.cylS).applyMatrix4(m), PAL.brass, "brass");
  const tipP: V2[] = [
    [0, -body + 0.0012],
    [rn * 0.86, -body + 0.0012],
    [rn * 0.86, -body - 0.0006],
    [rn * 0.97, -body - 0.0012],
    [rn * 0.97, -body - tl * 0.35],
    [rn * 0.6, -body - tl * 0.8],
    [0, -L],
  ];
  b.add(latheZ(tipP, q.cylS).applyMatrix4(m), 0xb8743e, "brass");
}

/** holographic / red-dot reticle: a ring + a centre dot, in the XY plane at the origin, facing +Z */
export function reticle(b: PartBuilder, m: THREE.Matrix4, ring: number, dot: number, color: number = PAL.reticle): void {
  const seg = 40;
  const pts: V2[] = [];
  const hole: V2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([Math.cos(a) * ring, Math.sin(a) * ring]);
    hole.push([Math.cos(a) * ring * 0.86, Math.sin(a) * ring * 0.86]);
  }
  const ringShape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  ringShape.holes.push(new THREE.Path(hole.slice().reverse().map(([x, y]) => new THREE.Vector2(x, y))));
  const g1 = new THREE.ShapeGeometry(ringShape, 1);
  const g2 = new THREE.CircleGeometry(dot, 16);
  b.add(g1.applyMatrix4(m), color, "glow", undefined, { smooth: 0 });
  b.add(g2.applyMatrix4(m), color, "glow", undefined, { smooth: 0 });
}

/** a tiny banana crescent emblem (engraved look), an outline in a local (u, v) plane */
export function bananaOutline(len: number): V2[] {
  const pts: V2[] = [];
  const n = 14;
  // outer arc then inner arc: a crescent bulging down, stem at the left end
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = (t - 0.5) * len;
    pts.push([x, -Math.sin(t * Math.PI) * len * 0.22 + (t > 0.92 ? (t - 0.92) * len * 0.5 : 0)]);
  }
  for (let i = n; i >= 0; i--) {
    const t = i / n;
    const x = (t - 0.5) * len * 0.94;
    pts.push([x, -Math.sin(t * Math.PI) * len * 0.1 + len * 0.02]);
  }
  return pts;
}

/** knurled / serrated block: n thin raised ridges across a face (side profile ridges along Y) */
export function serrations(b: PartBuilder, kind: "anod" | "steel" | "cera" | "poly", color: number, zs: number[], y0: number, y1: number, x: number, w: number, depth = 0.0012): void {
  for (const z of zs) {
    b.add(side(rrect(z, (y0 + y1) / 2, depth * 1.1, y1 - y0, depth * 0.45, 1), w, { bevel: 0.0003, bevelSeg: 1 }, x), color, kind);
  }
}

/** a simple screw / pin head on the +X or -X face */
export function pin(b: PartBuilder, lod: Lod, x: number, y: number, z: number, r: number, color: number = PAL.steel): void {
  if (lod === "tp") return;
  // ZERO-FLICKER: x is the host's face; the head stands 0.6 mm proud, its back buried 2 mm deep
  const sgn = Math.sign(x) || 1;
  const g = cylZ(r, -0.002, 0.0006, 0.0003, 12);
  b.add(g, color, "steel", tf([x, y, z], [0, (sgn * Math.PI) / 2, 0]));
}

export { spread };

// ------------------------------------------------------------------ shared assemblies

/**
 * A closed outline moved inward by d along its vertex normals (the miter of the
 * two adjacent edge normals, clamped). For the CORE of a two-layer part (pocket
 * skins): the core's perimeter walls then sit d inside the skin's — never in
 * the same plane.
 */
export function insetPoly(pts: V2[], d: number): V2[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i]!, b = pts[(i + 1) % n]!; area += a[0] * b[1] - b[0] * a[1]; }
  const s = area > 0 ? 1 : -1; // CCW: inward normal = left of the edge
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n]!, b = pts[(i + 1) % n]!;
    const e0x = p[0] - a[0], e0y = p[1] - a[1], e1x = b[0] - p[0], e1y = b[1] - p[1];
    const l0 = Math.hypot(e0x, e0y) || 1, l1 = Math.hypot(e1x, e1y) || 1;
    const n0x = (-e0y / l0) * s, n0y = (e0x / l0) * s, n1x = (-e1y / l1) * s, n1y = (e1x / l1) * s;
    let mx = n0x + n1x, my = n0y + n1y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const k = Math.min(3, 1 / Math.max(0.33, mx * n0x + my * n0y));
    return [p[0] + mx * d * k, p[1] + my * d * k] as V2;
  });
}

/** an annular sector (x, y) outline: radii ri..ro, centred on angle a0, width da (rad) */
export function sector(ri: number, ro: number, a0: number, da: number, seg = 6): V2[] {
  const pts: V2[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 - da / 2 + (da * i) / seg;
    pts.push([Math.cos(a) * ro, Math.sin(a) * ro]);
  }
  for (let i = seg; i >= 0; i--) {
    const a = a0 - da / 2 + (da * i) / seg;
    pts.push([Math.cos(a) * ri, Math.sin(a) * ri]);
  }
  return pts;
}

/**
 * Free-float M-LOK handguard: a rounded-square tube from z0 back to z1 (z0 < z1),
 * outer half-width hw, top yT, bottom yB, wall t. The two side walls are real
 * plates with the slots cut through (the barrel shows through them); the top
 * and bottom are rounded strips. A picatinny rail runs the full top.
 */
export function mlokHandguard(
  b: PartBuilder,
  lod: Lod,
  z0: number,
  z1: number,
  o: { hw: number; yT: number; yB: number; t?: number; r?: number; slots?: number; color?: number; kind?: "anod" | "cera"; rail?: boolean },
): void {
  const q = Q(lod);
  const t = o.t ?? 0.0026, r = o.r ?? 0.008, hw = o.hw, yT = o.yT, yB = o.yB;
  const color = o.color ?? PAL.anodBlack, kind = o.kind ?? "anod";
  const ySplitT = yT - r - 0.001, ySplitB = yB + r + 0.001;
  const strip = (top: boolean): V2[] => {
    const s = top ? 1 : -1;
    const yE = top ? yT : yB, yS = top ? ySplitT : ySplitB;
    const outer: V2[] = [[-hw, yS], [-hw, yE], [hw, yE], [hw, yS]];
    const inner: V2[] = [[hw - t, yS], [hw - t, yE - s * t], [-hw + t, yE - s * t], [-hw + t, yS]];
    const ro = roundPoly(outer, [0, r, r, 0], q.rnd + 2);
    const ri = roundPoly(inner, [0, Math.max(0.001, r - t), Math.max(0.001, r - t), 0], q.rnd + 2);
    return [...ro, ...ri];
  };
  b.add(section(strip(true), z0, z1, { bevel: 0.0007, bevelSeg: 1 }), color, kind);
  b.add(section(strip(false), z0, z1, { bevel: 0.0007, bevelSeg: 1 }), color, kind);
  // side walls with the slots
  const n = o.slots ?? 0;
  const holes: V2[][] = [];
  if (q.fp && n > 0) {
    const len = z1 - z0, pitch = len / (n + 0.6);
    for (let i = 0; i < n; i++) {
      const zc = z0 + pitch * (i + 0.8);
      holes.push(rrect(zc, (ySplitT + ySplitB) / 2, 0.031, 0.0072, 0.0035, 3));
    }
  }
  // ZERO-FLICKER: the walls stop 0.6 mm short of the strips' end planes and sit 0.4 mm
  // inside their outer / inner faces (a panel line, never a shared plane)
  const e = q.fp ? 0.0006 : 0.001;
  const wall: V2[] = [[z0 + e, ySplitB - 0.0005], [z1 - e, ySplitB - 0.0005], [z1 - e, ySplitT + 0.0005], [z0 + e, ySplitT + 0.0005]];
  for (const sx of [-1, 1]) b.add(side(wall, t, { bevel: 0.0006, bevelSeg: 1, holes }, sx * (hw - t / 2 - (q.fp ? 0.0004 : 0.001))), color, kind);
  if (o.rail !== false) picatinny(b, lod, z1, z0, yT - 0.0004);
}

/** a 3-prong flash hider on the bore from z0 forward by len (z0 > z0 - len), outer radius r */
export function flashHider3(b: PartBuilder, lod: Lod, z0: number, len: number, r = 0.0112, color: number = PAL.steelDark): void {
  const q = Q(lod);
  const collar = 0.014;
  b.add(cylZ(r * 1.04, z0 + 0.003, z0 - collar, 0.0008, q.cyl), color, "steel");
  // wrench flats ring
  b.add(cylZ(r * 1.3, z0 + 0.004, z0 - 0.003, 0.0006, 6), color, "steel");
  if (!q.fp) {
    b.add(cylZ(r, z0 - collar, z0 - len, 0.0008, q.cyl), color, "steel");
    return;
  }
  for (let i = 0; i < 3; i++) {
    const a0 = Math.PI / 2 + (i * Math.PI * 2) / 3;
    b.add(section(sector(r * 0.62, r, a0, 1.25, 6), z0 - collar + 0.001, z0 - len, { bevel: 0.0005, bevelSeg: 1 }), color, "steel");
  }
}

/**
 * A reticle as its OWN object (own unlit material, so the viewmodel can fade
 * it with ADS): ring + dot (+ optional ticks) in the XY plane at the origin,
 * facing +Z (toward the eye). `ring` 0 = dot only.
 */
export function reticleObject(ring: number, dot: number, color: number = PAL.reticle, ticks = false): THREE.Group {
  const g = new THREE.Group();
  g.name = "reticle";
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide });
  mat.name = "gun-reticle";
  const parts: THREE.BufferGeometry[] = [];
  if (ring > 0) parts.push(new THREE.RingGeometry(ring * 0.9, ring, 48));
  parts.push(new THREE.CircleGeometry(dot, 16));
  if (ticks && ring > 0) {
    for (const [x, y, w, h] of [[0, ring * 1.0, dot * 0.9, ring * 0.22], [0, -ring * 1.0, dot * 0.9, ring * 0.22], [ring * 1.0, 0, ring * 0.22, dot * 0.9], [-ring * 1.0, 0, ring * 0.22, dot * 0.9]] as const) {
      const p = new THREE.PlaneGeometry(w, h);
      p.translate(x * 0.9, y * 0.9, 0);
      parts.push(p);
    }
  }
  for (const p of parts) {
    const m = new THREE.Mesh(p, mat);
    m.renderOrder = 4;
    m.frustumCulled = false;
    g.add(m);
  }
  return g;
}

/** a flat lens pane (x, y rect with rounded corners) at z, facing +/-Z */
export function lensPane(b: PartBuilder, cx: number, cy: number, w: number, h: number, z: number, r = 0.002, tint: number = PAL.lensTint): void {
  const g = new THREE.ShapeGeometry(new THREE.Shape(rrect(cx, cy, w, h, r, 3).map(([x, y]) => new THREE.Vector2(x, y))), 2);
  g.translate(0, 0, z);
  b.add(g, tint, "glass", undefined, { smooth: 0 });
}

/** a round lens (disc) at z, radius r, on the axis at (cx, cy) */
export function lensDisc(b: PartBuilder, cx: number, cy: number, r: number, z: number, tint: number = PAL.lensTint, seg = 32): void {
  const g = new THREE.CircleGeometry(r, seg);
  g.translate(cx, cy, z);
  b.add(g, tint, "glass", undefined, { smooth: 0 });
}
