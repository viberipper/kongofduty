/**
 * THIRD-PERSON GUNS — what every operator actually holds.
 *
 * Three pieces the Bruiser actor (bruiser.ts) builds its weapon hold from:
 *
 *   stripLauncher()  bruiser.glb ships with its banana launcher FUSED into the
 *                    right fist (one watertight Tripo mesh). The launcher is cut
 *                    out once, at template load, on every map; the holes it
 *                    leaves in the paw are capped so the fist stays a closed,
 *                    gripping fist around whatever grip is put through it.
 *   tpGun()          one light model per weapon id from the shared gun API
 *                    (weapons/guns: buildGun(id, "tp")), flattened and merged
 *                    per material — two or three draws a gun, geometry shared
 *                    by every operator holding it.
 *   solveTwoBone()   analytic two-bone IK in world space, allocation-free: the
 *                    gun is placed first and the arms are solved onto it, so
 *                    the hands are ON the grip and the handguard by construction.
 */
import * as THREE from "three";
import { buildGun } from "./weapons/guns";
import "./weapons/guns/register";
import { WEAPON_BY_ID } from "@shared/weapons";
import { specularAA } from "./specular-aa";

// ------------------------------------------------------------ LAUNCHER STRIP --

/**
 * Classification, in R_Hand's own frame at bind (the hand bone carries no
 * animation, so this frame is pose-invariant), in FOREARM LENGTHS (0.384 m on
 * the shipped rig) measured from the wrist along the forearm -> hand axis.
 */
export const STRIP = {
  /** min skin weight on R_Hand for a vertex to be considered at all */
  minW: 0.35,
  /** everything on the hand past this is launcher (the fist ends well short of it) */
  far: 0.62,
  /** past this, launcher-coloured vertices (yellow / black / white) go too */
  near: 0.1,
  /**
   * "mirror": the right paw is REBUILT from the left one (see mirrorPaw) — a
   * clean sculpted fist, no cut edges anywhere on it. "cap": the old way, the
   * launcher cut out of the right paw and the holes capped.
   */
  paw: "mirror" as "mirror" | "cap",
  /** with paw "cap": keep the launcher's grip as a repainted stub inside the fist */
  stub: false,
  /** with `stub`: launcher past this (and not touching the paw's skin) is deleted; short of it, kept */
  cut: 0.45,
  /** split-off islands smaller than this many triangles are launcher shards */
  shardTris: 1500,
};

export type StripResult = { removed: number; collapsed: number; shards: number; open: number; capped: number; mirrored: number };

function launcherColour(r: number, g: number, b: number): boolean {
  // the Bunch Cylinder's banana yellow (the paw is tan: its blue channel sits well above this)
  if (r > 0.55 && g > 0.42 && b < 0.2 && r - b > 0.45) return true;
  // the trigger guard / receiver whites and the bore blacks
  if (r > 0.82 && g > 0.82 && b > 0.72) return true;
  if (r < 0.1 && g < 0.1 && b < 0.1) return true;
  return false;
}

/**
 * Cut the fused launcher out of the shared skinned geometry, in place, without
 * opening the paw.
 *
 * Tripo welded the launcher INTO the fist — one watertight surface, the grip
 * running through the curled fingers — so deleting it outright leaves the paw
 * with ragged holes where the two met (and fan-capping those reads as shredded
 * texture). Instead:
 *
 *   past the knuckles  the launcher is deleted, triangle by triangle;
 *   at the fist        what is left of it (the grip, the receiver's heel, the
 *                      trigger guard) is SHRUNK into the fist's own volume,
 *                      fully skinned to the hand and repainted palm-coloured —
 *                      so the cut edge is inside the paw where nobody can see
 *                      it, and the tunnel the grip ran through is a dark palm,
 *                      which the new gun's grip then fills.
 *
 * Idempotent per geometry (the result is cached on geometry.userData).
 */
export function stripLauncher(mesh: THREE.SkinnedMesh, opts = STRIP): StripResult {
  const geo = mesh.geometry;
  const done = geo.userData.launcherStrip as StripResult | undefined;
  if (done) return done;
  const res: StripResult = { removed: 0, collapsed: 0, shards: 0, open: 0, capped: 0, mirrored: 0 };
  const bones = mesh.skeleton.bones;
  const hi = bones.findIndex((b) => b.name === "R_Hand");
  const fi = bones.findIndex((b) => b.name === "R_Forearm");
  const idx = geo.index;
  if (hi < 0 || fi < 0 || !idx) return res;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const si = geo.attributes.skinIndex as THREE.BufferAttribute;
  const sw = geo.attributes.skinWeight as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  const n = pos.count;

  // hand-local = boneInverse(hand) * bindMatrix * v
  const toHand = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.boneInverses[hi]!, mesh.bindMatrix);
  const foreL = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(mesh.skeleton.boneInverses[fi]!).invert()).applyMatrix4(mesh.skeleton.boneInverses[hi]!);
  const F = foreL.length() || 1;
  const axis = foreL.clone().multiplyScalar(-1 / F);

  // albedo for the colour test
  let px: Uint8ClampedArray | null = null;
  let W = 0;
  let H = 0;
  const img = (mesh.material as THREE.MeshStandardMaterial).map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (img && img.width) {
    W = Math.min(1024, img.width);
    H = Math.min(1024, img.height);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, W, H);
    px = g.getImageData(0, 0, W, H).data;
  }

  // Weld by position: Tripo splits vertices along UV seams; classification and
  // connectivity both have to see one point as one point.
  const rep = new Int32Array(n);
  {
    const key = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
      const r = key.get(k);
      if (r === undefined) {
        key.set(k, i);
        rep[i] = i;
      } else rep[i] = r;
    }
  }

  const gunR = new Uint8Array(n); // by welded rep
  const handW = new Float32Array(n);
  const alongA = new Float32Array(n);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === hi) w += sw.getComponent(i, k);
    handW[i] = w;
    v.fromBufferAttribute(pos, i).applyMatrix4(toHand);
    const along = v.dot(axis) / F;
    alongA[i] = along;
    if (w < opts.minW) continue;
    if (along > opts.far) {
      gunR[rep[i]!] = 1;
      continue;
    }
    if (along > opts.near && px && uv) {
      const x = Math.min(W - 1, Math.max(0, Math.floor(uv.getX(i) * W)));
      const y = Math.min(H - 1, Math.max(0, Math.floor(uv.getY(i) * H)));
      const j = (y * W + x) * 4;
      if (launcherColour(px[j]! / 255, px[j + 1]! / 255, px[j + 2]! / 255)) gunR[rep[i]!] = 1;
    }
  }
  const isGun = (i: number): boolean => gunR[rep[i]!] === 1;

  // Launcher points that touch the paw's own skin (an edge to a non-launcher
  // vertex) are never deleted — deleting them would open the paw. They join
  // the shrunk set instead.
  const tris = idx.count / 3;
  const touchesSkin = new Uint8Array(n); // by rep
  for (let t = 0; t < tris; t++) {
    const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
    const ga = isGun(a), gb = isGun(b), gc = isGun(c);
    if (ga && (!gb || !gc)) touchesSkin[rep[a]!] = 1;
    if (gb && (!ga || !gc)) touchesSkin[rep[b]!] = 1;
    if (gc && (!ga || !gb)) touchesSkin[rep[c]!] = 1;
  }
  // 0 = body, 1 = the stub left in the fist (repainted), 2 = delete
  const zone = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!isGun(i)) continue;
    zone[i] = opts.stub && alongA[i]! <= opts.cut ? 1 : touchesSkin[rep[i]!] && opts.stub ? 1 : 2;
  }

  // The fist: centroid of the paw's own skin, in geometry space, and the
  // palm-coloured UV nearest it.
  const c = new THREE.Vector3();
  let cn = 0;
  for (let i = 0; i < n; i++) {
    if (zone[i] || handW[i]! < 0.6) continue;
    const along = alongA[i]!;
    if (along < 0.05 || along > opts.far) continue;
    c.add(v.fromBufferAttribute(pos, i));
    cn++;
  }
  if (cn) c.divideScalar(cn);
  // The paw's own colour: the fist-skin texel nearest the fist's MEDIAN colour
  // (a mean drifts into the dark creases; the median stays on the tan).
  let palm = -1;
  if (px && uv && cn) {
    const texel = (i: number): number => {
      const x = Math.min(W - 1, Math.max(0, Math.floor(uv.getX(i) * W)));
      const y = Math.min(H - 1, Math.max(0, Math.floor(uv.getY(i) * H)));
      return (y * W + x) * 4;
    };
    const rs: number[] = [], gs: number[] = [], bs: number[] = [], ids: number[] = [];
    for (let i = 0; i < n; i++) {
      if (zone[i] || handW[i]! < 0.6) continue;
      const along = alongA[i]!;
      if (along < 0.05 || along > opts.far) continue;
      const j = texel(i);
      rs.push(px[j]!), gs.push(px[j + 1]!), bs.push(px[j + 2]!), ids.push(i);
    }
    const med = (a: number[]): number => a.slice().sort((x, y) => x - y)[a.length >> 1] ?? 0;
    const mr = med(rs), mg = med(gs), mb = med(bs);
    let best = Infinity;
    for (let k = 0; k < ids.length; k++) {
      const d = (rs[k]! - mr) ** 2 + (gs[k]! - mg) ** 2 + (bs[k]! - mb) ** 2;
      if (d < best) ((best = d), (palm = ids[k]!));
    }
  }

  // A triangle goes when two of its corners are launcher: one launcher corner
  // on a paw triangle is the seam, and cutting there would open the paw.
  const keep = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), cc = idx.getX(t * 3 + 2);
    if ((zone[a] === 2 ? 1 : 0) + (zone[b] === 2 ? 1 : 0) + (zone[cc] === 2 ? 1 : 0) >= 2) res.removed++;
    else keep[t] = 1;
  }

  // Shards: any island the cut split off the body.
  {
    const par = new Int32Array(n);
    for (let i = 0; i < n; i++) par[i] = i;
    const find = (x: number): number => {
      while (par[x] !== x) {
        par[x] = par[par[x]!]!;
        x = par[x]!;
      }
      return x;
    };
    const join = (a: number, b: number): void => {
      a = find(a);
      b = find(b);
      if (a !== b) par[a] = b;
    };
    for (let t = 0; t < tris; t++) {
      if (!keep[t]) continue;
      const a = rep[idx.getX(t * 3)]!, b = rep[idx.getX(t * 3 + 1)]!, cc = rep[idx.getX(t * 3 + 2)]!;
      join(a, b);
      join(b, cc);
    }
    const size = new Map<number, number>();
    const handy = new Map<number, number>();
    for (let t = 0; t < tris; t++) {
      if (!keep[t]) continue;
      const a = idx.getX(t * 3);
      const r = find(rep[a]!);
      size.set(r, (size.get(r) ?? 0) + 1);
      if (handW[a]! > 0.2) handy.set(r, (handy.get(r) ?? 0) + 1);
    }
    let big = -1;
    let bigN = 0;
    for (const [r, sz] of size) if (sz > bigN) ((bigN = sz), (big = r));
    for (let t = 0; t < tris; t++) {
      if (!keep[t]) continue;
      const r = find(rep[idx.getX(t * 3)]!);
      if (r === big) continue;
      const sz = size.get(r) ?? 0;
      if (sz < opts.shardTris && (handy.get(r) ?? 0) > sz * 0.5) {
        keep[t] = 0;
        res.shards++;
      }
    }
  }

  if (opts.paw === "mirror") {
    mirrorPaw(mesh, keep, handW, res);
    geo.userData.launcherStrip = res;
    return res;
  }

  // The stub the fist still closes on is repainted gun-black: it IS the grip
  // now (the new gun's grip goes through the same tunnel), and black polymer is
  // what all four guns are made of there. Repainted on DUPLICATED vertices,
  // triangle by triangle, so no triangle ever interpolates its UVs from the
  // black texel across the atlas to the paw's (that smear reads as shredding).
  let black = -1;
  if (px && uv) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!zone[i]) continue;
      const x = Math.min(W - 1, Math.max(0, Math.floor(uv.getX(i) * W)));
      const y = Math.min(H - 1, Math.max(0, Math.floor(uv.getY(i) * H)));
      const j = (y * W + x) * 4;
      const l = px[j]! + px[j + 1]! + px[j + 2]!;
      if (l < best) ((best = l), (black = i));
    }
  }
  const stub = new Uint8Array(tris);
  const dup = new Int32Array(n).fill(-1);
  let nDup = 0;
  for (let t = 0; t < tris; t++) {
    if (!keep[t]) continue;
    let z = 0;
    for (let e = 0; e < 3; e++) if (zone[idx.getX(t * 3 + e)] === 1) z++;
    if (z < 2) continue;
    stub[t] = 1;
    for (let e = 0; e < 3; e++) {
      const q = idx.getX(t * 3 + e);
      if (dup[q]! < 0) dup[q] = n + nDup++;
    }
  }
  res.collapsed = nDup;
  const vid = (t: number, e: number): number => {
    const q = idx.getX(t * 3 + e);
    return stub[t] ? dup[q]! : q;
  };

  // CAP the cut: every boundary edge the deletion left (on the black stub, by
  // construction) gets a fan to its loop's centroid. Winding follows the kept
  // triangle owning the edge, so the caps face out.
  const keepIdx: number[] = [];
  for (let t = 0; t < tris; t++) if (keep[t]) keepIdx.push(vid(t, 0), vid(t, 1), vid(t, 2));
  type BEdge = { a: number; b: number; oa: number; ob: number };
  const loops = new Map<number, BEdge[]>();
  {
    const edge = new Set<number>();
    const ek = (a: number, b: number): number => a * 4194304 + b;
    for (let t = 0; t < tris; t++) {
      if (!keep[t]) continue;
      for (let e = 0; e < 3; e++) edge.add(ek(rep[idx.getX(t * 3 + e)]!, rep[idx.getX(t * 3 + ((e + 1) % 3))]!));
    }
    const bedges: BEdge[] = [];
    for (let t = 0; t < tris; t++) {
      if (!keep[t]) continue;
      for (let e = 0; e < 3; e++) {
        const oa = idx.getX(t * 3 + e), ob = idx.getX(t * 3 + ((e + 1) % 3));
        if (edge.has(ek(rep[ob]!, rep[oa]!))) continue;
        if (handW[oa]! < 0.2 && handW[ob]! < 0.2 && !zone[oa] && !zone[ob]) continue;
        if (!zone[oa] && !zone[ob]) res.open++;
        bedges.push({ a: vid(t, e), b: vid(t, (e + 1) % 3), oa, ob });
      }
    }
    const lpar = new Map<number, number>();
    const lf = (x: number): number => {
      while ((lpar.get(x) ?? x) !== x) x = lpar.get(x)!;
      return x;
    };
    for (const e of bedges) {
      const ra = lf(rep[e.oa]!), rb = lf(rep[e.ob]!);
      if (ra !== rb) lpar.set(ra, rb);
    }
    for (const e of bedges) {
      const r = lf(rep[e.oa]!);
      const l = loops.get(r);
      if (l) l.push(e);
      else loops.set(r, [e]);
    }
  }
  // Every ring vertex of a cap gets its own copy carrying the cap's UV, for the
  // same reason the stub does: one uniform texel per cap, no atlas smear.
  const ring = new Map<number, number>();
  let nRing = 0;
  for (const list of loops.values()) for (const e of list) for (const q of [e.a, e.b]) if (!ring.has(q)) ring.set(q, n + nDup + nRing++);
  const extra = nDup + nRing + loops.size;
  if (extra) {
    const grown: Record<string, THREE.BufferAttribute> = {};
    for (const [name, attr] of Object.entries(geo.attributes)) {
      const a = attr as THREE.BufferAttribute;
      const Ctor = (a.array as unknown as { constructor: new (n: number) => THREE.TypedArray }).constructor;
      const out = new THREE.BufferAttribute(new Ctor((n + extra) * a.itemSize), a.itemSize, a.normalized);
      for (let i = 0; i < n; i++) for (let k = 0; k < a.itemSize; k++) out.setComponent(i, k, a.getComponent(i, k));
      for (let i = 0; i < n; i++) {
        const d = dup[i]!;
        if (d < 0) continue;
        for (let k = 0; k < a.itemSize; k++) out.setComponent(d, k, a.getComponent(i, k));
      }
      grown[name] = out;
    }
    const bu = uv && black >= 0 ? uv.getX(black) : 0;
    const bv = uv && black >= 0 ? uv.getY(black) : 0;
    if (grown.uv && black >= 0) for (let i = 0; i < n; i++) if (dup[i]! >= 0) grown.uv.setXY(dup[i]!, bu, bv);
    // the cap colour: the stub's black when there is a stub, else the palm
    const capSrc = opts.stub ? black : palm;
    const cu = uv && capSrc >= 0 ? uv.getX(capSrc) : 0;
    const cv = uv && capSrc >= 0 ? uv.getY(capSrc) : 0;
    for (const [q, d] of ring) {
      for (const [name, a] of Object.entries(grown)) for (let k = 0; k < a.itemSize; k++) a.setComponent(d, k, a.getComponent(q, k));
      if (grown.uv && capSrc >= 0) grown.uv.setXY(d, cu, cv);
    }
    let vi = n + nDup + nRing;
    const cen = new THREE.Vector3();
    const nn = new THREE.Vector3();
    const pa = new THREE.Vector3();
    const pb = new THREE.Vector3();
    for (const list of loops.values()) {
      cen.set(0, 0, 0);
      const seen = new Set<number>();
      for (const e of list) {
        for (const q of [e.oa, e.ob]) {
          if (seen.has(rep[q]!)) continue;
          seen.add(rep[q]!);
          cen.add(v.fromBufferAttribute(pos, q));
        }
      }
      cen.divideScalar(seen.size);
      nn.set(0, 0, 0);
      for (const e of list) {
        pa.fromBufferAttribute(pos, e.oa).sub(cen);
        pb.fromBufferAttribute(pos, e.ob).sub(cen);
        nn.add(v.crossVectors(pb, pa));
      }
      if (nn.lengthSq() > 1e-12) nn.normalize();
      const src = list[0]!.oa;
      for (const [name, a] of Object.entries(grown)) {
        const sa = geo.attributes[name] as THREE.BufferAttribute;
        for (let k = 0; k < a.itemSize; k++) a.setComponent(vi, k, sa.getComponent(src, k));
      }
      grown.position!.setXYZ(vi, cen.x, cen.y, cen.z);
      if (grown.normal) grown.normal.setXYZ(vi, nn.x, nn.y, nn.z);
      if (grown.uv && capSrc >= 0) grown.uv.setXY(vi, cu, cv);
      if (grown.skinIndex && grown.skinWeight) {
        grown.skinIndex.setXYZW(vi, hi, 0, 0, 0);
        grown.skinWeight.setXYZW(vi, 1, 0, 0, 0);
      }
      for (const e of list) keepIdx.push(ring.get(e.b)!, ring.get(e.a)!, vi);
      res.capped++;
      vi++;
    }
    for (const [name, a] of Object.entries(grown)) geo.setAttribute(name, a);
  }
  geo.setIndex(keepIdx);
  geo.userData.launcherStrip = res;
  return res;
}

/**
 * THE RIGHT PAW, REBUILT FROM THE LEFT. The left paw never held anything: it
 * is a clean, closed, sculpted fist. So the right paw (every triangle the
 * right hand bone dominates — the fist AND the launcher fused into it) is
 * deleted, and the left paw is copied in its place: mirrored across the
 * body's sagittal plane in bind space, carried onto the right wrist (the
 * mirrored left wrist moved onto the right one, the mirrored forearm axis
 * turned onto the right one), re-skinned bone-for-bone L_* -> R_*, winding
 * flipped. Same texels, same sculpt — a fist that matches its twin exactly,
 * with no cut edge anywhere on it. The gun's grip then simply goes into it.
 */
function mirrorPaw(mesh: THREE.SkinnedMesh, keep: Uint8Array, handW: Float32Array, res: StripResult): void {
  const geo = mesh.geometry;
  const idx = geo.index!;
  const sk = mesh.skeleton;
  const bones = sk.bones;
  const bi = (name: string): number => bones.findIndex((b) => b.name === name);
  const rH = bi("R_Hand"), rF = bi("R_Forearm"), lH = bi("L_Hand"), lF = bi("L_Forearm");
  if (rH < 0 || rF < 0 || lH < 0 || lF < 0) return;
  const si = geo.attributes.skinIndex as THREE.BufferAttribute;
  const sw = geo.attributes.skinWeight as THREE.BufferAttribute;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const n = pos.count;
  const tris = idx.count / 3;
  const weightOn = (i: number, b: number): number => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === b) w += sw.getComponent(i, k);
    return w;
  };
  // the right paw goes, whatever the launcher test said about it
  for (let t = 0; t < tris; t++) {
    if (!keep[t]) continue;
    let c = 0;
    for (let e = 0; e < 3; e++) if (handW[idx.getX(t * 3 + e)]! >= 0.5) c++;
    if (c >= 2) {
      keep[t] = 0;
      res.removed++;
    }
  }
  // the left paw's triangles
  const paw: number[] = [];
  const map = new Int32Array(n).fill(-1);
  let added = 0;
  for (let t = 0; t < tris; t++) {
    let c = 0;
    for (let e = 0; e < 3; e++) if (weightOn(idx.getX(t * 3 + e), lH) >= 0.5) c++;
    if (c < 2) continue;
    paw.push(t);
    for (let e = 0; e < 3; e++) {
      const q = idx.getX(t * 3 + e);
      if (map[q]! < 0) map[q] = n + added++;
    }
  }
  if (!added) return;
  // bind-space joints (bind space = bindMatrix * geometry space)
  const joint = (b: number): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(sk.boneInverses[b]!).invert());
  const pL = joint(lH), pR = joint(rH);
  const dL = pL.clone().sub(joint(lF));
  const dR = pR.clone().sub(joint(rF));
  const mirror = (v: THREE.Vector3): THREE.Vector3 => v.set(v.x, v.y, -v.z);
  // which bind axis is the body's LEFT-RIGHT one: the axis the two wrists differ most on
  const span = pR.clone().sub(pL);
  const lat = Math.abs(span.x) > Math.abs(span.z) ? (Math.abs(span.x) > Math.abs(span.y) ? 0 : 1) : Math.abs(span.z) > Math.abs(span.y) ? 2 : 1;
  const mir = (v: THREE.Vector3): THREE.Vector3 => (lat === 2 ? mirror(v) : (v.setComponent(lat, -v.getComponent(lat)), v));
  void mirror;
  const rot = new THREE.Quaternion().setFromUnitVectors(mir(dL.clone()).normalize(), dR.clone().normalize());
  const bindInv = new THREE.Matrix4().copy(mesh.bindMatrix).invert();
  const nrmBind = new THREE.Matrix3().getNormalMatrix(mesh.bindMatrix);
  const nrmInv = new THREE.Matrix3().getNormalMatrix(bindInv);
  const pLm = mir(pL.clone());
  // bone remap L_* -> R_*
  const remap = bones.map((b, i) => {
    if (!b.name.startsWith("L_")) return i;
    const j = bi("R_" + b.name.slice(2));
    return j >= 0 ? j : i;
  });
  const grown: Record<string, THREE.BufferAttribute> = {};
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const Ctor = (a.array as unknown as { constructor: new (n: number) => THREE.TypedArray }).constructor;
    const out = new THREE.BufferAttribute(new Ctor((n + added) * a.itemSize), a.itemSize, a.normalized);
    for (let i = 0; i < n; i++) for (let k = 0; k < a.itemSize; k++) out.setComponent(i, k, a.getComponent(i, k));
    for (let i = 0; i < n; i++) {
      const d = map[i]!;
      if (d < 0) continue;
      for (let k = 0; k < a.itemSize; k++) out.setComponent(d, k, a.getComponent(i, k));
    }
    grown[name] = out;
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const d = map[i]!;
    if (d < 0) continue;
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
    mir(v).sub(pLm).applyQuaternion(rot).add(pR).applyMatrix4(bindInv);
    grown.position!.setXYZ(d, v.x, v.y, v.z);
    if (nrm && grown.normal) {
      v.fromBufferAttribute(nrm, i).applyMatrix3(nrmBind);
      mir(v).applyQuaternion(rot).applyMatrix3(nrmInv).normalize();
      grown.normal.setXYZ(d, v.x, v.y, v.z);
    }
    if (grown.skinIndex) for (let k = 0; k < 4; k++) grown.skinIndex.setComponent(d, k, remap[si.getComponent(i, k)] ?? si.getComponent(i, k));
  }
  const keepIdx: number[] = [];
  for (let t = 0; t < tris; t++) if (keep[t]) keepIdx.push(idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2));
  const bodyEnd = keepIdx.length;
  // mirrored: flip the winding so the copy faces out
  for (const t of paw) keepIdx.push(map[idx.getX(t * 3)]!, map[idx.getX(t * 3 + 2)]!, map[idx.getX(t * 3 + 1)]!);

  // STITCH THE WRIST. The two sculpts are not perfectly symmetric, so the
  // copy's open rim and the arm's open rim do not quite meet. Every rim vertex
  // of the copy is moved onto the nearest rim vertex of the arm — position AND
  // skinning, so the two stay together through every pose — and any arm rim
  // vertex nobody landed on is pulled onto the nearest copy rim vertex.
  const P = grown.position!;
  const key = (x: number, y: number, z: number): string => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const rims = (from: number, to: number): number[] => {
    const weld = new Map<string, number>();
    const rep = (i: number): number => {
      const k = key(P.getX(i), P.getY(i), P.getZ(i));
      const r = weld.get(k);
      if (r !== undefined) return r;
      weld.set(k, i);
      return i;
    };
    const dir = new Set<string>();
    for (let t = from; t < to; t += 3) for (let e = 0; e < 3; e++) dir.add(rep(keepIdx[t + e]!) + ":" + rep(keepIdx[t + ((e + 1) % 3)]!));
    const out = new Set<number>();
    for (let t = from; t < to; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = keepIdx[t + e]!, b = keepIdx[t + ((e + 1) % 3)]!;
        if (!dir.has(rep(b) + ":" + rep(a))) (out.add(a), out.add(b));
      }
    }
    return [...out];
  };
  const wristR = pR.clone().applyMatrix4(bindInv);
  const reach = dR.length() * 0.75;
  const near = (i: number): boolean => v.fromBufferAttribute(P, i).distanceTo(wristR) < reach;
  const armRim = rims(0, bodyEnd).filter(near);
  const pawRim = rims(bodyEnd, keepIdx.length).filter(near);
  const SI = grown.skinIndex!, SW = grown.skinWeight!;
  const copyVert = (dst: number, src: number): void => {
    P.setXYZ(dst, P.getX(src), P.getY(src), P.getZ(src));
    for (let k = 0; k < 4; k++) {
      SI.setComponent(dst, k, SI.getComponent(src, k));
      SW.setComponent(dst, k, SW.getComponent(src, k));
    }
  };
  const closest = (i: number, set: number[]): number => {
    let best = -1;
    let bd = Infinity;
    v.fromBufferAttribute(P, i);
    for (const j of set) {
      const d = (P.getX(j) - v.x) ** 2 + (P.getY(j) - v.y) ** 2 + (P.getZ(j) - v.z) ** 2;
      if (d < bd) ((bd = d), (best = j));
    }
    return best;
  };
  if (armRim.length && pawRim.length) {
    const hit = new Set<number>();
    const target = pawRim.map((i) => closest(i, armRim));
    pawRim.forEach((i, k) => {
      const j = target[k]!;
      if (j < 0) return;
      copyVert(i, j);
      hit.add(j);
    });
    for (const j of armRim) {
      if (hit.has(j)) continue;
      const i = closest(j, pawRim);
      if (i >= 0) P.setXYZ(j, P.getX(i), P.getY(i), P.getZ(i));
    }
    res.capped = pawRim.length;
  }
  for (const [name, a] of Object.entries(grown)) geo.setAttribute(name, a);
  geo.setIndex(keepIdx);
  res.mirrored = added;
}

/**
 * The fist the gun is put through: centroid of the paw (R_Hand-dominant
 * vertices within reach of the wrist), in R_Hand's local frame.
 */
export function fistCentroidLocal(mesh: THREE.SkinnedMesh, bone = "R_Hand", reachF = 0.62): THREE.Vector3 {
  const bones = mesh.skeleton.bones;
  const hi = bones.findIndex((b) => b.name === bone);
  const fi = bones.findIndex((b) => b.name === bone.replace("Hand", "Forearm"));
  const out = new THREE.Vector3();
  if (hi < 0 || fi < 0) return out;
  const geo = mesh.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const si = geo.attributes.skinIndex as THREE.BufferAttribute;
  const sw = geo.attributes.skinWeight as THREE.BufferAttribute;
  const toHand = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.boneInverses[hi]!, mesh.bindMatrix);
  const foreL = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(mesh.skeleton.boneInverses[fi]!).invert()).applyMatrix4(mesh.skeleton.boneInverses[hi]!);
  const F = foreL.length() || 1;
  const axis = foreL.clone().multiplyScalar(-1 / F);
  const v = new THREE.Vector3();
  let cnt = 0;
  // only indexed (drawn) vertices count — the strip leaves orphans behind
  const used = new Uint8Array(pos.count);
  const idx = geo.index;
  if (idx) for (let i = 0; i < idx.count; i++) used[idx.getX(i)] = 1;
  else used.fill(1);
  for (let i = 0; i < pos.count; i++) {
    if (!used[i]) continue;
    let w = 0;
    for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === hi) w += sw.getComponent(i, k);
    if (w < 0.6) continue;
    v.fromBufferAttribute(pos, i).applyMatrix4(toHand);
    const along = v.dot(axis) / F;
    if (along < 0.05 || along > reachF) continue;
    out.add(v);
    cnt++;
  }
  return cnt ? out.divideScalar(cnt) : out;
}

// ------------------------------------------------------------------ TP GUNS --

export type TpGunProto = {
  id: string;
  /** "long" = shouldered (ar/smg/sniper); "pistol" = handgun */
  cls: "long" | "pistol";
  parts: { geo: THREE.BufferGeometry; mat: THREE.Material }[];
  /** gun-space anchors (metres; -Z bore, +Y up, origin = trigger-hand palm) */
  muzzle: THREE.Vector3;
  fore: THREE.Vector3;
  /** rear end of the stock (gun-space z, >= 0) */
  butt: number;
  /** bore height above the grip (gun-space y of the muzzle) */
  bore: number;
  length: number;
  /** seconds of the raise (WeaponDef.swap) */
  swap: number;
};

let tpMats: { metal: THREE.MeshStandardMaterial; poly: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial } | null = null;

function mats(): NonNullable<typeof tpMats> {
  if (tpMats) return tpMats;
  // ZERO-FLICKER: a 3P gun is a few dozen pixels of tightly bevelled metal, and
  // a sharp highlight on a 1-px bevel crawls as the camera moves (the motion
  // test measured it on every rifle at 2 m). specularAA widens the lobe where
  // the normal turns faster than a pixel; the base roughness is kept satin.
  tpMats = {
    metal: specularAA(new THREE.MeshStandardMaterial({ name: "tp-gun-metal", color: 0xffffff, vertexColors: true, metalness: 0.5, roughness: 0.5, envMapIntensity: 0.9 })),
    poly: specularAA(new THREE.MeshStandardMaterial({ name: "tp-gun-poly", color: 0xffffff, vertexColors: true, metalness: 0.05, roughness: 0.7, envMapIntensity: 0.7 })),
    // optic glass: opaque-ish tinted, drawn after the gun in a fixed order
    glass: new THREE.MeshStandardMaterial({ name: "tp-gun-glass", color: 0xffffff, vertexColors: true, metalness: 0.3, roughness: 0.2, transparent: true, opacity: 0.45, depthWrite: false }),
  };
  return tpMats;
}

const protos = new Map<string, TpGunProto>();

/**
 * Third-person guns are drawn 1.3x real size. The operators are 1.78 m apes
 * with forearms like a man's thigh: a true-scale carbine in that fist reads as
 * a toy at 20 m. Every anchor scales with the mesh, so the hands, the flash and
 * the tracer origin stay exactly on the drawn gun.
 */
export const TP_SCALE = 1.3;

/**
 * One prototype per weapon id: the tp LOD from the shared gun API, every node
 * transform baked in, colour moved into vertex colours, and the whole thing
 * folded onto THREE materials (metal / polymer / glass). Moving parts (mag,
 * bolt) are flattened in: nobody reads a 3P bolt at 20 m, and every pivot kept
 * would be another draw per operator.
 */
export function tpGunProto(id: string): TpGunProto {
  const hit = protos.get(id);
  if (hit) return hit;
  const model = buildGun(id, "tp");
  const root = model.root;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const bins = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const M = mats();
  const col = new THREE.Color();
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || !m.geometry?.attributes?.position) return;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    const src0 = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    // groups (multi-material) are rare on these builders; take the first material
    const mat = list[0] as THREE.MeshStandardMaterial & { vertexColors?: boolean; isMeshBasicMaterial?: boolean };
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", src0.attributes.position!.clone());
    if (src0.attributes.normal) g.setAttribute("normal", src0.attributes.normal.clone());
    const cnt = g.attributes.position!.count;
    const colors = new Float32Array(cnt * 3);
    const base = mat?.color ?? col.set(0x222222);
    const vc = mat?.vertexColors ? (src0.attributes.color as THREE.BufferAttribute | undefined) : undefined;
    for (let i = 0; i < cnt; i++) {
      const r = vc ? vc.getX(i) : 1, gg = vc ? vc.getY(i) : 1, b = vc ? vc.getZ(i) : 1;
      colors[i * 3] = r * base.r;
      colors[i * 3 + 1] = gg * base.g;
      colors[i * 3 + 2] = b * base.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    g.scale(TP_SCALE, TP_SCALE, TP_SCALE);
    if (!g.attributes.normal) g.computeVertexNormals();
    const name = (mat?.name ?? "").toLowerCase();
    let target: THREE.Material = M.poly;
    let key = "poly";
    if (mat?.transparent || name.includes("glass")) ((target = M.glass), (key = "glass"));
    else if (name.includes("glow") || mat?.isMeshBasicMaterial) ((target = M.poly), (key = "poly"));
    else if ((mat?.metalness ?? 0) >= 0.3 || /anod|steel|bright|brass/.test(name)) ((target = M.metal), (key = "metal"));
    const bin = bins.get(key) ?? { mat: target, geos: [] };
    bin.geos.push(g);
    bins.set(key, bin);
    if (key !== "glass") {
      g.computeBoundingBox();
      box.union(g.boundingBox!);
    }
  });
  const parts: TpGunProto["parts"] = [];
  for (const { mat, geos } of bins.values()) {
    const merged = mergeSimple(geos);
    merged.computeBoundingSphere();
    parts.push({ geo: merged, mat });
  }
  const def = WEAPON_BY_ID[id];
  const pistol = id === "pistol" || def?.class === "PISTOL";
  void tmp;
  const proto: TpGunProto = {
    id,
    cls: pistol ? "pistol" : "long",
    parts,
    muzzle: model.muzzle.clone().multiplyScalar(TP_SCALE),
    fore: (model.fore ?? new THREE.Vector3(0, 0, -model.length * 0.35)).clone().multiplyScalar(TP_SCALE),
    butt: box.isEmpty() ? 0.05 : Math.max(0, box.max.z),
    bore: model.muzzle.y * TP_SCALE,
    length: model.length * TP_SCALE,
    swap: def?.swap ?? 0.4,
  };
  protos.set(id, proto);
  return proto;
}

/** Concatenate non-indexed geometries that share position/normal/color. */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const g of geos) total += g.attributes.position!.count;
  const P = new Float32Array(total * 3);
  const N = new Float32Array(total * 3);
  const C = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const c = g.attributes.position!.count;
    P.set(g.attributes.position!.array as Float32Array, o * 3);
    N.set(g.attributes.normal!.array as Float32Array, o * 3);
    C.set(g.attributes.color!.array as Float32Array, o * 3);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(P, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(N, 3));
  out.setAttribute("color", new THREE.BufferAttribute(C, 3));
  return out;
}

/** A fresh scene graph for one operator: meshes share the prototype's geometry and materials. */
export function tpGun(id: string): { root: THREE.Group; proto: TpGunProto } {
  const proto = tpGunProto(id);
  const root = new THREE.Group();
  root.name = `tp-gun-${id}`;
  for (const p of proto.parts) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.name = `tp-gun-${id}:${p.mat.name.replace("tp-gun-", "")}`;
    m.castShadow = p.mat !== mats().glass;
    m.receiveShadow = false;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    root.add(m);
  }
  return { root, proto };
}

/** Drop every cached prototype (the gun builders were re-registered, e.g. on HMR). */
export function resetTpGuns(): void {
  protos.clear();
}

// ---------------------------------------------------------------- TWO-BONE IK --

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();

/** World quaternion of `o` (matrixWorld must be current). */
function worldQ(o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  o.matrixWorld.decompose(_p, out, _e);
  return out;
}

/** Rotate bone `o` by the WORLD-space rotation `r` (premultiplied), written into its local quaternion. */
export function rotateBoneWorld(o: THREE.Object3D, r: THREE.Quaternion): void {
  const par = o.parent;
  if (!par) {
    o.quaternion.premultiply(r);
    return;
  }
  worldQ(par, _qp);
  worldQ(o, _qw);
  _qw.premultiply(r);
  o.quaternion.copy(_qp.invert().multiply(_qw));
}

/** Set bone `o`'s WORLD orientation to `q`. */
export function setBoneWorldQ(o: THREE.Object3D, q: THREE.Quaternion): void {
  const par = o.parent;
  if (!par) {
    o.quaternion.copy(q);
    return;
  }
  worldQ(par, _qp);
  o.quaternion.copy(_qp.invert().multiply(q));
}

/**
 * Put `end`'s joint on `target` by rotating `upper` and `lower` (world space).
 * `pole` is a world point the elbow bends toward. The rotations are the
 * smallest arcs from the CURRENT pose, so whatever roll the seed pose gave the
 * limb is kept — seed the chain with a fixed pose for a stable result.
 * Returns the residual distance (0 when reachable).
 */
export function solveTwoBone(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
): number {
  upper.updateWorldMatrix(true, true);
  _a.setFromMatrixPosition(upper.matrixWorld);
  _b.setFromMatrixPosition(lower.matrixWorld);
  _c.setFromMatrixPosition(end.matrixWorld);
  const la = _a.distanceTo(_b);
  const lb = _b.distanceTo(_c);
  if (la < 1e-6 || lb < 1e-6) return Infinity;
  _t.copy(target).sub(_a);
  let d = _t.length();
  if (d < 1e-6) return Infinity;
  _u.copy(_t).divideScalar(d); // shoulder -> target
  const dMax = (la + lb) * 0.9995;
  const dMin = Math.abs(la - lb) * 1.0005 + 1e-5;
  const resid = Math.max(0, d - dMax);
  d = Math.min(dMax, Math.max(dMin, d));
  // bend plane: the pole's component off the shoulder->target line
  _v.copy(pole).sub(_a);
  _v.addScaledVector(_u, -_v.dot(_u));
  if (_v.lengthSq() < 1e-10) {
    _v.copy(_b).sub(_a);
    _v.addScaledVector(_u, -_v.dot(_u));
  }
  if (_v.lengthSq() < 1e-10) _v.set(0, -1, 0).addScaledVector(_u, -_u.y);
  _v.normalize();
  const cosA = THREE.MathUtils.clamp((la * la + d * d - lb * lb) / (2 * la * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // desired elbow
  _d.copy(_a).addScaledVector(_u, la * cosA).addScaledVector(_v, la * sinA);
  // swing the upper arm: (B - A) -> (D - A)
  _p.copy(_b).sub(_a).normalize();
  _e.copy(_d).sub(_a).normalize();
  _q.setFromUnitVectors(_p, _e);
  rotateBoneWorld(upper, _q);
  upper.updateWorldMatrix(false, true);
  // swing the forearm: (C' - D) -> (T' - D), T' = the clamped target
  _c.setFromMatrixPosition(end.matrixWorld);
  _b.setFromMatrixPosition(lower.matrixWorld);
  _p.copy(_c).sub(_b).normalize();
  _e.copy(_a).addScaledVector(_u, d).sub(_b).normalize();
  _q.setFromUnitVectors(_p, _e);
  rotateBoneWorld(lower, _q);
  lower.updateWorldMatrix(false, true);
  return resid;
}

const _s = new THREE.Vector3();
const _w = new THREE.Vector3();

/** |lateral| (root frame) of the elbow swung by `th` round the circle in _c/_e/_v (allocation-free). */
function elbowLat(th: number, r: number, rootInv: THREE.Matrix4): number {
  _p.copy(_c).addScaledVector(_e, r * Math.cos(th)).addScaledVector(_v, r * Math.sin(th)).applyMatrix4(rootInv);
  return Math.abs(_p.x);
}

/**
 * Swing the elbow round the shoulder->wrist axis — the one motion that moves an
 * elbow without moving the hand — until it is within `lat` of the body's
 * centre line (the limb budget's lateral rule), by the smallest turn that does
 * it. `rootInv` maps world into the actor root's frame (x = lateral).
 * The hand's world rotation is NOT preserved; the caller re-sets it.
 */
export function swivelElbowIn(upper: THREE.Object3D, lower: THREE.Object3D, end: THREE.Object3D, rootInv: THREE.Matrix4, lat: number): number {
  upper.updateWorldMatrix(true, true);
  _s.setFromMatrixPosition(upper.matrixWorld);
  _w.setFromMatrixPosition(end.matrixWorld);
  _b.setFromMatrixPosition(lower.matrixWorld);
  _u.copy(_w).sub(_s);
  const len = _u.length();
  if (len < 1e-5) return 0;
  _u.divideScalar(len);
  _c.copy(_s).addScaledVector(_u, _t.copy(_b).sub(_s).dot(_u)); // circle centre
  _e.copy(_b).sub(_c); // radius vector
  const r = _e.length();
  if (r < 1e-4) return 0;
  _e.divideScalar(r);
  _v.crossVectors(_u, _e);
  const x0 = elbowLat(0, r, rootInv);
  if (x0 <= lat) return 0;
  let best = 0;
  let bestX = x0;
  const N = 24;
  search: for (let k = 1; k <= N; k++) {
    for (let sg = 1; sg >= -1; sg -= 2) {
      const th = (sg * k * Math.PI) / N;
      const x = elbowLat(th, r, rootInv);
      if (x <= lat) {
        best = th;
        break search;
      }
      if (x < bestX - 1e-4) ((bestX = x), (best = th));
    }
  }
  if (best === 0) return 0;
  _q.setFromAxisAngle(_u, best);
  rotateBoneWorld(upper, _q);
  upper.updateWorldMatrix(false, true);
  return best;
}

/**
 * Turn `bone` (a clavicle) so the joint `child` (its upper arm) leans toward
 * `target`, by at most `maxRad` — the shoulder rolling forward to reach.
 */
export function leanToward(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3, amount: number, maxRad: number): void {
  if (amount <= 0) return;
  bone.updateWorldMatrix(true, true);
  _a.setFromMatrixPosition(bone.matrixWorld);
  _b.setFromMatrixPosition(child.matrixWorld).sub(_a);
  _c.copy(target).sub(_a);
  if (_b.lengthSq() < 1e-10 || _c.lengthSq() < 1e-10) return;
  _q0.setFromUnitVectors(_b.normalize(), _c.normalize());
  const ang = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(_q0.w), 0, 1));
  if (ang < 1e-5) return;
  const k = Math.min(amount, maxRad / ang);
  _q1.identity().slerp(_q0, k);
  rotateBoneWorld(bone, _q1);
  bone.updateWorldMatrix(false, true);
}
