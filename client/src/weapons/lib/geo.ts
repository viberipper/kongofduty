/**
 * HARD-SURFACE GEOMETRY for the tactical guns (ported from Kong Royale's
 * weapons/lib/geo.ts — the lathes, fillets, extrusions and the 4x4 helpers —
 * and extended with what a real firearm is made of: side PROFILES extruded
 * across the gun with a rolled bevel, cross-SECTIONS swept along the bore,
 * rounded outlines, plates with cut-outs, and an area-weighted auto-smooth
 * that turns a 2-segment bevel into a soft fillet while every big flat face
 * stays dead flat (Blender's "weighted normals" — the AAA hard-surface read).
 *
 * GUN SPACE: metres, -Z forward (the bore), +Y up, +X right.
 * 2-D coordinates are named for the plane they live in:
 *   side profile  (z, y)  — the gun seen from its right side
 *   section       (x, y)  — the gun seen down the bore
 *   top outline   (x, z)  — the gun seen from above
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type V2 = [number, number];
export type V3 = [number, number, number];
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ outlines

/**
 * A closed polygon with every corner filleted. `r` is one radius or one per
 * corner (0 = sharp). The fillet is clamped to the shorter adjacent edge so a
 * tight outline never folds over itself.
 */
export function roundPoly(pts: V2[], r: number | number[], seg = 4): V2[] {
  const n = pts.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const a = pts[(i - 1 + n) % n]!;
    const b = pts[(i + 1) % n]!;
    let rr = Array.isArray(r) ? (r[i] ?? 0) : r;
    if (rr <= 1e-6) {
      out.push([p[0], p[1]]);
      continue;
    }
    const ax = a[0] - p[0], ay = a[1] - p[1];
    const bx = b[0] - p[0], by = b[1] - p[1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    const ux = ax / la, uy = ay / la, vx = bx / lb, vy = by / lb;
    const cos = Math.max(-0.9999, Math.min(0.9999, ux * vx + uy * vy));
    const ang = Math.acos(cos);
    // distance from the corner to the tangent points
    let t = rr / Math.tan(ang / 2);
    const tmax = Math.min(la, lb) * 0.48;
    if (t > tmax) {
      t = tmax;
      rr = t * Math.tan(ang / 2);
    }
    const p0: V2 = [p[0] + ux * t, p[1] + uy * t];
    const p1: V2 = [p[0] + vx * t, p[1] + vy * t];
    // centre along the bisector
    const bxs = ux + vx, bys = uy + vy;
    const bl = Math.hypot(bxs, bys) || 1;
    const d = rr / Math.sin(ang / 2);
    const c: V2 = [p[0] + (bxs / bl) * d, p[1] + (bys / bl) * d];
    let a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    let a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    let da = a1 - a0;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    for (let k = 0; k <= seg; k++) {
      const aa = a0 + (da * k) / seg;
      out.push([c[0] + Math.cos(aa) * rr, c[1] + Math.sin(aa) * rr]);
    }
    void a1;
  }
  return out;
}

/** a rounded rectangle centred on (cx, cy), w x h, corner radius r */
export function rrect(cx: number, cy: number, w: number, h: number, r: number, seg = 4): V2[] {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return roundPoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], Math.min(r, w / 2 - 1e-5, h / 2 - 1e-5), seg);
}

/** a circle as an outline (for holes) */
export function circle(cx: number, cy: number, r: number, seg = 16): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** make a polygon counter-clockwise (shapes) or clockwise (holes) */
function wind(pts: V2[], ccw: boolean): V2[] {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    s += (b[0] - a[0]) * (b[1] + a[1]);
  }
  const isCcw = s < 0;
  return isCcw === ccw ? pts : pts.slice().reverse();
}

// ------------------------------------------------------------------ extrusion

export type ExOpts = {
  /** bevel width (m); the outline keeps its size (bevelOffset = -bevel) */
  bevel?: number;
  bevelSeg?: number;
  /** cut-outs, same 2-D plane as the outline */
  holes?: V2[][];
  curveSeg?: number;
};

/**
 * Extrude a 2-D outline (u, v) along +W, centred on w = 0, total thickness
 * `depth` INCLUDING the bevel. Returns geometry in the shape's own frame
 * (u -> x, v -> y, w -> z); the public helpers below orient it.
 */
function extrudeRaw(outline: V2[], depth: number, o: ExOpts = {}): THREE.BufferGeometry {
  const shape = new THREE.Shape(wind(outline, true).map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of o.holes ?? []) shape.holes.push(new THREE.Path(wind(h, false).map(([x, y]) => new THREE.Vector2(x, y))));
  // ZERO-FLICKER: a bevel inset wider than a concave fillet or a narrow slot folds the
  // cap over itself (coplanar overlapping triangles in ONE mesh — a z-fight). Halve
  // the bevel until the extrusion is clean (it ends sharp at worst, never overlapping).
  let bevel = Math.max(0, Math.min(o.bevel ?? 0, depth * 0.45));
  for (let attempt = 0; ; attempt++) {
    const core = Math.max(0.0002, depth - 2 * bevel);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: core,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: -bevel,
      bevelSegments: o.bevelSeg ?? 2,
      curveSegments: o.curveSeg ?? 6,
      steps: 1,
    });
    g.translate(0, 0, -core / 2);
    if (bevel <= 0 || attempt >= 4 || !selfOverlaps(g)) return g;
    g.dispose();
    bevel = attempt >= 3 ? 0 : bevel * 0.5;
  }
}

/**
 * True if any two same-facing triangles of `g` lie in one plane and overlap
 * (by more than 20 µm on every separating axis). Used to reject folded
 * bevels; also handy for QA.
 */
export function selfOverlaps(g: THREE.BufferGeometry): boolean {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index;
  const n = idx ? idx.count : pos.count;
  const T: { n: [number, number, number]; d: number; p: number[] }[] = [];
  const buckets = new Map<string, number[]>();
  for (let i = 0; i + 2 < n; i += 3) {
    const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
    const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia);
    const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib);
    const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l; ny /= l; nz /= l;
    const d = nx * ax + ny * ay + nz * az;
    const k = `${Math.round(nx * 500)},${Math.round(ny * 500)},${Math.round(nz * 500)},${Math.round(d * 50000)}`;
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(T.length);
    T.push({ n: [nx, ny, nz], d, p: [ax, ay, az, bx, by, bz, cx, cy, cz] });
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      const A = T[list[i]!]!;
      // a 2-D frame in A's plane
      const ref = Math.abs(A.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let u0 = A.n[1] * ref[2]! - A.n[2] * ref[1]!, u1 = A.n[2] * ref[0]! - A.n[0] * ref[2]!, u2 = A.n[0] * ref[1]! - A.n[1] * ref[0]!;
      const lu = Math.hypot(u0, u1, u2);
      u0 /= lu; u1 /= lu; u2 /= lu;
      const v0 = A.n[1] * u2 - A.n[2] * u1, v1 = A.n[2] * u0 - A.n[0] * u2, v2 = A.n[0] * u1 - A.n[1] * u0;
      const P = [0, 1, 2].map((k) => [A.p[k * 3]! * u0 + A.p[k * 3 + 1]! * u1 + A.p[k * 3 + 2]! * u2, A.p[k * 3]! * v0 + A.p[k * 3 + 1]! * v1 + A.p[k * 3 + 2]! * v2]);
      for (let j = i + 1; j < list.length; j++) {
        const B = T[list[j]!]!;
        const Q = [0, 1, 2].map((k) => [B.p[k * 3]! * u0 + B.p[k * 3 + 1]! * u1 + B.p[k * 3 + 2]! * u2, B.p[k * 3]! * v0 + B.p[k * 3 + 1]! * v1 + B.p[k * 3 + 2]! * v2]);
        let separated = false;
        for (const poly of [P, Q]) {
          for (let e = 0; e < 3 && !separated; e++) {
            const p0 = poly[e]!, p1 = poly[(e + 1) % 3]!;
            let ax = -(p1[1]! - p0[1]!), ay = p1[0]! - p0[0]!;
            const l = Math.hypot(ax, ay) || 1;
            ax /= l; ay /= l;
            let pmin = Infinity, pmax = -Infinity, qmin = Infinity, qmax = -Infinity;
            for (const q of P) { const t = q[0]! * ax + q[1]! * ay; pmin = Math.min(pmin, t); pmax = Math.max(pmax, t); }
            for (const q of Q) { const t = q[0]! * ax + q[1]! * ay; qmin = Math.min(qmin, t); qmax = Math.max(qmax, t); }
            if (Math.min(pmax, qmax) - Math.max(pmin, qmin) < 2e-5) separated = true;
          }
          if (separated) break;
        }
        if (!separated) return true;
      }
    }
  }
  return false;
}

const M_SIDE = new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
const M_TOP = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** SIDE PROFILE: outline in (z, y), extruded across the gun (X), width `w`, centred on x = cx. */
export function side(outline: V2[], w: number, o: ExOpts = {}, cx = 0): THREE.BufferGeometry {
  const g = extrudeRaw(outline, w, o).applyMatrix4(M_SIDE);
  if (cx) g.translate(cx, 0, 0);
  return g;
}

/** SECTION: outline in (x, y), swept along Z from z0 to z1. */
export function section(outline: V2[], z0: number, z1: number, o: ExOpts = {}): THREE.BufferGeometry {
  const g = extrudeRaw(outline, Math.abs(z1 - z0), o);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** TOP OUTLINE: outline in (x, z), extruded up (Y), height `h`, centred on y = cy. */
export function top(outline: V2[], h: number, o: ExOpts = {}, cy = 0): THREE.BufferGeometry {
  // M_TOP maps shape v -> -z, so feed -z
  const flip = (pts: V2[]) => pts.map(([x, z]) => [x, -z] as V2);
  const g = extrudeRaw(flip(outline), h, { ...o, holes: o.holes?.map(flip) }).applyMatrix4(M_TOP);
  if (cy) g.translate(0, cy, 0);
  return g;
}

// ------------------------------------------------------------------ revolve

/**
 * Lathe around the Z axis (the bore): profile points are [radius, z]. Any
 * order; closed ends need radius 0 points.
 */
export function latheZ(profile: V2[], seg = 24, phi0 = 0, phiLen = TAU): THREE.BufferGeometry {
  // LatheGeometry revolves (r, y) around +Y and wants y ascending (outward faces)
  let pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-5), -z));
  if (pts[0]!.y > pts[pts.length - 1]!.y) pts = pts.reverse();
  const g = new THREE.LatheGeometry(pts, seg, phi0, phiLen);
  // +Y -> -Z  (rotate -90 deg about X maps y -> -z ... see header)
  g.rotateX(-Math.PI / 2);
  return g;
}

/** a filleted cylinder along Z from z0 to z1, radius r (optional end radii), fillet f */
export function cylZ(r: number, z0: number, z1: number, f = 0, seg = 20, rFront = r, rBack = r): THREE.BufferGeometry {
  const zf = Math.min(z0, z1), zb = Math.max(z0, z1);
  const p: V2[] = [];
  const fs = 3;
  const ff = Math.min(f, (zb - zf) / 2, rFront * 0.9, rBack * 0.9);
  p.push([0, zf]);
  if (ff > 0) {
    for (let k = 0; k <= fs; k++) {
      const a = (k / fs) * (Math.PI / 2);
      p.push([rFront - ff + Math.sin(a) * ff, zf + ff - Math.cos(a) * ff]);
    }
    for (let k = 0; k <= fs; k++) {
      const a = (k / fs) * (Math.PI / 2);
      p.push([rBack - ff + Math.cos(a) * ff, zb - ff + Math.sin(a) * ff]);
    }
  } else {
    p.push([rFront, zf]);
    p.push([rBack, zb]);
  }
  p.push([0, zb]);
  return latheZ(p, seg);
}

/** a cylinder along X (pins, knobs, turret caps), centred on (x, y, z) */
export function cylX(r: number, len: number, f = 0, seg = 16): THREE.BufferGeometry {
  const g = cylZ(r, -len / 2, len / 2, f, seg);
  g.rotateY(Math.PI / 2);
  return g;
}

/** a cylinder along Y, centred on the origin */
export function cylY(r: number, len: number, f = 0, seg = 16, rTop = r, rBot = r): THREE.BufferGeometry {
  // cylZ front (-z) end becomes +y after rotateX(+90)? rotateX(+90): z -> y ... (y' = -z)
  const g = cylZ(r, -len / 2, len / 2, f, seg, rTop, rBot);
  g.rotateX(Math.PI / 2);
  return g;
}

/** a hollow tube along Z (flash hider, scope rings): outer r, inner ri */
export function tubeZ(r: number, ri: number, z0: number, z1: number, f = 0.0006, seg = 24): THREE.BufferGeometry {
  const zf = Math.min(z0, z1), zb = Math.max(z0, z1);
  const ff = Math.max(1e-5, Math.min(f, (r - ri) * 0.45, (zb - zf) * 0.45));
  // closed loop, oriented so every face points out of the solid wall:
  // back face outward -> outer wall forward -> front face inward -> inner wall back
  const p: V2[] = [[ri, zb]];
  for (let k = 0; k <= 2; k++) {
    const a = (k / 2) * (Math.PI / 2);
    p.push([r - ff + Math.sin(a) * ff, zb - ff + Math.cos(a) * ff]);
  }
  for (let k = 0; k <= 2; k++) {
    const a = (k / 2) * (Math.PI / 2);
    p.push([r - ff + Math.cos(a) * ff, zf + ff - Math.sin(a) * ff]);
  }
  p.push([ri, zf]);
  p.push([ri, zb]);
  const pts = p.map(([rr, z]) => new THREE.Vector2(rr, -z));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** a torus ring in the XY plane (pin ring, sling loop), centred on the origin */
export function ring(R: number, r: number, seg = 24, tube = 8, arc = TAU): THREE.BufferGeometry {
  return new THREE.TorusGeometry(R, r, tube, seg, arc);
}

/** rounded box with real fillets (three's RoundedBox, but keep it light) */
export function rbox(w: number, h: number, d: number, r: number, seg = 2): THREE.BufferGeometry {
  // side-profile extrusion: the w face is the bevel, the (d, h) outline is filleted
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  return side(rrect(0, 0, d, h, rr, seg), w, { bevel: Math.min(rr, w * 0.4), bevelSeg: seg });
}

/** a sphere (squashable) — knobs, the bolt ball */
export function ball(r: number, seg = 14): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.7)));
}

// ------------------------------------------------------------------ transforms

/** 4x4 from position / euler (XYZ) / scale */
export function tf(p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: number | V3 = 1): THREE.Matrix4 {
  const sc = typeof s === "number" ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), sc);
}

/** a matrix that maps +Y to `dir` at `pos` */
export function alignY(pos: V3, dir: V3, s: number | V3 = 1): THREE.Matrix4 {
  const d = new THREE.Vector3(...dir).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  const sc = typeof s === "number" ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), q, sc);
}

// ------------------------------------------------------------------ shading

/**
 * AREA-WEIGHTED AUTO-SMOOTH. Returns a non-indexed copy whose vertex normals
 * average only the faces within `angleDeg` of the face they belong to,
 * weighted by face area. Big flat faces stay flat; a narrow bevel between two
 * of them rolls smoothly from one to the other (a fillet), and a hard 90°
 * edge with no bevel stays hard.
 *
 * Also writes a per-vertex `edge` value (0..1, an attribute named `aEdge`)
 * on narrow transition faces — the PartBuilder lightens those for edge wear.
 */
export function autoSmooth(src: THREE.BufferGeometry, angleDeg = 40): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const tri = n / 3;
  const fn = new Float32Array(tri * 3);
  const fa = new Float32Array(tri);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < tri; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    e1.cross(e2);
    const l = e1.length();
    fa[t] = l * 0.5;
    if (l > 1e-12) e1.divideScalar(l);
    fn[t * 3] = e1.x;
    fn[t * 3 + 1] = e1.y;
    fn[t * 3 + 2] = e1.z;
  }
  // bucket vertices by quantised position (0.02 mm)
  const key = (i: number) => `${Math.round(pos.getX(i) * 5e4)},${Math.round(pos.getY(i) * 5e4)},${Math.round(pos.getZ(i) * 5e4)}`;
  const buckets = new Map<string, number[]>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = key(i);
    keys[i] = k;
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  }
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const nrm = new Float32Array(n * 3);
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / 3) | 0;
    const nx = fn[t * 3]!, ny = fn[t * 3 + 1]!, nz = fn[t * 3 + 2]!;
    let sx = 0, sy = 0, sz = 0;
    for (const j of buckets.get(keys[i]!)!) {
      const u = (j / 3) | 0;
      const mx = fn[u * 3]!, my = fn[u * 3 + 1]!, mz = fn[u * 3 + 2]!;
      if (nx * mx + ny * my + nz * mz < cos) continue;
      const w = fa[u]!;
      sx += mx * w;
      sy += my * w;
      sz += mz * w;
    }
    const l = Math.hypot(sx, sy, sz);
    if (l > 1e-12) {
      sx /= l; sy /= l; sz /= l;
    } else {
      sx = nx; sy = ny; sz = nz;
    }
    nrm[i * 3] = sx;
    nrm[i * 3 + 1] = sy;
    nrm[i * 3 + 2] = sz;
  }
  // edge faces: the vertex normals of the face lean away from its own normal
  for (let t = 0; t < tri; t++) {
    const nx = fn[t * 3]!, ny = fn[t * 3 + 1]!, nz = fn[t * 3 + 2]!;
    let dev = 0;
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      dev = Math.max(dev, 1 - (nrm[i * 3]! * nx + nrm[i * 3 + 1]! * ny + nrm[i * 3 + 2]! * nz));
    }
    const ed = Math.min(1, dev / 0.06);
    edge[t * 3] = edge[t * 3 + 1] = edge[t * 3 + 2] = ed;
  }
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  return g;
}

/**
 * BOX-PROJECTED UVs from the normals, `k` tiles per metre: the procedural
 * micro textures (stipple, grain) land at a constant size on every part.
 */
export function boxUV(g: THREE.BufferGeometry, k = 20): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  let uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    g.setAttribute("uv", uv);
  }
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    const x = pos.getX(i) * k, y = pos.getY(i) * k, z = pos.getZ(i) * k;
    if (ax >= ay && ax >= az) uv.setXY(i, z, y);
    else if (ay >= az) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
}

/** merge helper that tolerates empty lists */
export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const ok = list.filter((g) => g.attributes.position && g.attributes.position.count > 0);
  if (!ok.length) return null;
  return mergeGeometries(ok, false);
}

// ------------------------------------------------------------------ patterns

/** repeat a 1-D placement: n items evenly from a to b (inclusive ends) */
export function spread(n: number, a: number, b: number): number[] {
  if (n <= 1) return [(a + b) / 2];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}
