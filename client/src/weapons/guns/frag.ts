/**
 * THE FRAG — an M67-style fragmentation grenade at true size (64 mm body,
 * ~90 mm with the fuze): olive-drab steel sphere with its equator seam, the
 * yellow HE marking band (the regulation one — also the only banana nod), the
 * M213-style fuze, the spoon (safety lever) hugging the body, the cotter pin
 * and its pull ring.
 *
 * Frame: metres, origin = the body's centre (the centre of mass, so a thrown
 * frag spins about it), +Y = toward the fuze, the spoon on +X, the pull ring on -X.
 *
 * buildFragMesh(): ONE mesh, one geometry, one material (vertex colours) —
 * instancing-friendly, for the thrown frag (NadeFx) and third-person hands.
 * buildFragParts(): body / spoon / pin as separate meshes (same material) for
 * the first-person hand, which pulls the pin and lets the spoon fly.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { autoSmooth, cylY, latheZ, ring, section, type V2 } from "../lib/geo";

const OD = new THREE.Color(0x3e4430);
const OD_DARK = new THREE.Color(0x2f3324);
const YELLOW = new THREE.Color(0xd9b13a);
const FUZE = new THREE.Color(0x5b5e57);
const SPOON = new THREE.Color(0x6a6d64);
const STEEL = new THREE.Color(0x9a9d9f);

/** body radius (m) */
export const FRAG_R = 0.032;

let mat: THREE.MeshStandardMaterial | null = null;
/** the frag's one material: painted / bare steel told apart by vertex colour */
export function fragMaterial(): THREE.MeshStandardMaterial {
  if (mat) return mat;
  mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.58, metalness: 0.42, envMapIntensity: 0.9 });
  mat.name = "frag";
  return mat;
}

function colorize(g: THREE.BufferGeometry, f: (p: THREE.Vector3, out: THREE.Color) => void): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const a = new Float32Array(pos.count * 3), p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    f(p, c);
    a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

function prep(g: THREE.BufferGeometry, smooth = 40): THREE.BufferGeometry {
  let x = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(x.attributes)) if (k !== "position" && k !== "normal") x.deleteAttribute(k);
  x = autoSmooth(x, smooth);
  x.deleteAttribute("aEdge");
  return x;
}

/** lathe around +Y: profile [radius, y] */
function latheY(profile: V2[], seg: number): THREE.BufferGeometry {
  // latheZ revolves about Z with -z forward; map y -> -z, then rotate -Z onto +Y
  const g = latheZ(profile.map(([r, y]) => [r, -y] as V2), seg);
  g.rotateX(Math.PI / 2);
  return g;
}

function bodyGeo(seg: number): THREE.BufferGeometry {
  const R = FRAG_R;
  const prof: V2[] = [[0, -R]];
  // the sphere, a hair flattened at the base, necking into the fuze well at the top
  for (let i = 1; i <= 14; i++) {
    const a = -Math.PI / 2 + (i / 16) * Math.PI;
    let r = Math.cos(a) * R, y = Math.sin(a) * R * 0.985;
    // the equator weld seam: a tiny raised lip
    if (Math.abs(y) < 0.0012) r += 0.0007;
    prof.push([r, y]);
  }
  prof.push([0.0128, R * 0.94], [0.0118, R * 0.98], [0, R * 0.98]);
  const g = latheY(prof, seg);
  return colorize(prep(g, 35), (p, c) => {
    c.copy(OD);
    if (p.y > 0.019 && p.y < 0.0232) c.copy(YELLOW);
    if (Math.abs(p.y) < 0.0011) c.copy(OD_DARK);
  });
}

function fuzeGeo(seg: number): THREE.BufferGeometry {
  const prof: V2[] = [[0, 0.028], [0.0118, 0.028], [0.0121, 0.034], [0.0106, 0.0355], [0.0106, 0.045], [0.0098, 0.048], [0.0066, 0.0505], [0, 0.0508]];
  const g = latheY(prof, seg);
  const parts = [prep(g, 35)];
  // the lever lugs either side of the spoon hinge (+X)
  for (const z of [-0.0072, 0.0072]) {
    const lug = new THREE.BoxGeometry(0.008, 0.009, 0.0022);
    lug.translate(0.0122, 0.0425, z);
    parts.push(prep(lug, 30));
  }
  return colorize(mergeGeometries(parts, false)!, (_p, c) => c.copy(FUZE));
}

/** the spoon: a strip from over the fuze top, round the lugs, down the +X flank of the body */
function spoonGeo(): THREE.BufferGeometry {
  const t = 0.0015, pts: V2[] = [];
  const path: V2[] = [];
  // over the fuze top (a short flat), the hinge bend, then down round the body
  path.push([0.002, 0.0505], [0.0095, 0.0505], [0.0145, 0.047]);
  for (let i = 0; i <= 10; i++) {
    const a = 1.08 - (i / 10) * 1.42;
    const r = FRAG_R + 0.0028;
    path.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  // offset the path into a closed band of thickness t
  const n = path.length, outer: V2[] = [], inner: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)]!, b = path[Math.min(n - 1, i + 1)]!;
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    const nx = dy, ny = -dx; // right of the path = outward
    outer.push([path[i]![0] + nx * t * 0.5, path[i]![1] + ny * t * 0.5]);
    inner.push([path[i]![0] - nx * t * 0.5, path[i]![1] - ny * t * 0.5]);
  }
  pts.push(...outer, ...inner.reverse());
  const g = section(pts, -0.0068, 0.0068, { bevel: 0.0004, bevelSeg: 1 });
  return colorize(prep(g, 30), (_p, c) => c.copy(SPOON));
}

/** the cotter pin through the fuze + the pull ring hanging on -X */
function pinGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const shaft = cylY(0.0011, 0.03, 0, 8);
  shaft.rotateZ(Math.PI / 2);
  shaft.translate(-0.002, 0.041, 0);
  parts.push(prep(shaft, 50));
  const r = ring(0.0115, 0.00125, 28, 6);
  // ring plane: XY, hanging down-left of the fuze
  r.rotateZ(0.35);
  r.translate(-0.0265, 0.034, 0);
  parts.push(prep(r, 60));
  return colorize(mergeGeometries(parts, false)!, (_p, c) => c.copy(STEEL));
}

export type FragParts = { root: THREE.Group; body: THREE.Mesh; spoon: THREE.Mesh; pin: THREE.Mesh };

/** separate meshes for the first-person hand (pin pulled, spoon released) */
export function buildFragParts(): FragParts {
  const m = fragMaterial();
  const root = new THREE.Group();
  root.name = "frag";
  const body = new THREE.Mesh(mergeGeometries([bodyGeo(28), fuzeGeo(20)], false)!, m);
  body.name = "frag-body";
  const spoon = new THREE.Mesh(spoonGeo(), m);
  spoon.name = "frag-spoon";
  const pin = new THREE.Mesh(pinGeo(), m);
  pin.name = "frag-pin";
  root.add(body, spoon, pin);
  return { root, body, spoon, pin };
}

const cache = new Map<string, THREE.BufferGeometry>();
/**
 * The frag as ONE mesh (true size, centred on the body). `armed`: pin pulled
 * and spoon gone — the frag in flight. Geometry is cached and shared.
 */
export function buildFragMesh(opts: { armed?: boolean; lowDetail?: boolean } = {}): THREE.Mesh {
  const key = `${opts.armed ? "a" : "s"}${opts.lowDetail ? "l" : "h"}`;
  let g = cache.get(key);
  if (!g) {
    const seg = opts.lowDetail ? 14 : 28;
    const list = [bodyGeo(seg), fuzeGeo(opts.lowDetail ? 10 : 20)];
    if (!opts.armed) list.push(spoonGeo(), pinGeo());
    g = mergeGeometries(list, false)!;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    cache.set(key, g);
  }
  const mesh = new THREE.Mesh(g, fragMaterial());
  mesh.name = "frag";
  return mesh;
}
