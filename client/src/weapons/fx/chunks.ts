/**
 * WEAPON FX — LIT 3D DEBRIS AND BRASS.
 *
 * Ported from Kong Royale's fx-chunks.ts and made real: rifle and pistol brass
 * (bottlenecked 5.56-ish and straight 9 mm-ish, metallic, catching the sky
 * reflection), wood splinters, stone chips, dirt clods and glass shards. ONE
 * InstancedMesh draw for all of it: every shape lives in one geometry tagged per
 * vertex (aShape) and the vertex shader collapses the shapes an instance does
 * not use. The pool is dense (swap-remove on death), so update() and the matrix
 * upload are O(live), and nothing allocates per shot.
 *
 * Physics-lite: gravity, drag, spin, a floor found by a short downward ray into
 * the collider set (crate lids and container roofs included, refreshed as the
 * piece travels), a bounce or two with a scrub of the spin, then it lies FLAT
 * (a casing on its side, never standing on its base), waits, and shrinks away.
 * Walls: every 20 cm of travel the piece traces the path it just flew, and a
 * wall in the way bounces it off that box face (brass thrown into a container
 * you are hugging rattles off it instead of passing through and hanging inside
 * the steel). A piece whose floor ray starts INSIDE a box is retired.
 */
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { traceWorld } from "@shared/map";
import { faceOf } from "./surface";

export const K = { CASING: 0, PCASING: 1, SPLINTER: 2, CHIP: 3, CLOD: 4, SHARD: 5 } as const;

const col = (hex: string) => new THREE.Color(hex);
const BRASS = col("#c9a046"), BRASS_D = col("#8d6a26"), PRIMER = col("#b8b2a6"), WHITE = col("#ffffff");

type Paint = (x: number, y: number, z: number, out: THREE.Color) => number | void;

/** Vertex colour + a per-vertex PBR pair (metalness, roughness). */
function paint(g: THREE.BufferGeometry, f: Paint, metal = 0, rough = 0.85): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  const pbr = new Float32Array(p.count * 2);
  const t = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    t.set(1, 1, 1);
    f(p.getX(i), p.getY(i), p.getZ(i), t);
    c[i * 3] = t.r; c[i * 3 + 1] = t.g; c[i * 3 + 2] = t.b;
    pbr[i * 2] = metal; pbr[i * 2 + 1] = rough;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.setAttribute("aPbr", new THREE.BufferAttribute(pbr, 2));
  return g;
}

function tidy(g: THREE.BufferGeometry, flat = false): THREE.BufferGeometry {
  let o = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(o.attributes)) if (k !== "position" && k !== "normal") o.deleteAttribute(k);
  if (flat) {
    o.computeVertexNormals();
    return o;
  }
  o = mergeVertices(o, 1e-6);
  o.computeVertexNormals();
  return o;
}

/** Long axis +Z, centred. Profile is [radius, z] pairs from the base. */
function latheZ(prof: Array<[number, number]>, seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  return g;
}

function rngf(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** Half-length (m) of each shape along +Z at scale 1 — the rest height of a piece lying flat. */
const REST_R: number[] = [];
/** [first vertex, vertex count] of each shape in the merged (non-indexed) geometry — the QA proxy reads it. */
const RANGE: [number, number][] = [];

function buildShapes(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tag = (g: THREE.BufferGeometry, shape: number, restR: number): void => {
    g.setAttribute("aShape", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(shape), 1));
    parts.push(g);
    REST_R[shape] = restR;
  };

  // RIFLE brass (~5.56x45): extractor groove, body taper, shoulder, neck, open mouth.
  {
    const L = 0.045;
    const g = tidy(latheZ([
      [0, 0], [0.0047, 0], [0.0048, 0.0008], [0.0048, 0.0013], [0.0040, 0.0017], [0.0040, 0.0030],
      [0.0048, 0.0036], [0.0047, 0.0360], [0.0040, 0.0375], [0.0031, 0.0386], [0.0031, L],
      [0.0026, L], [0.0026, L - 0.004],
    ], 14));
    paint(g, (x, y, z, o) => {
      const u = z / L + 0.5;
      if (u < 0.02 && Math.hypot(x, y) < 0.0018) o.copy(PRIMER);
      else if (u > 0.985) o.copy(BRASS_D);
      else o.copy(BRASS).lerp(BRASS_D, u < 0.06 ? 0.35 : 0);
    }, 1, 0.3);
    tag(g, K.CASING, 0.0048);
  }
  // PISTOL brass (~9x19): straight-walled, slightly tapered.
  {
    const L = 0.019;
    const g = tidy(latheZ([
      [0, 0], [0.0050, 0], [0.0050, 0.0008], [0.0043, 0.0013], [0.0043, 0.0022], [0.0050, 0.0026],
      [0.0048, L], [0.0043, L], [0.0043, L - 0.003],
    ], 14));
    paint(g, (x, y, z, o) => {
      const u = z / L + 0.5;
      if (u < 0.03 && Math.hypot(x, y) < 0.0019) o.copy(PRIMER);
      else o.copy(BRASS).lerp(BRASS_D, u > 0.96 ? 0.6 : 0);
    }, 1, 0.32);
    tag(g, K.PCASING, 0.005);
  }
  // wood splinter: tapered, slightly bent sliver with a jagged broken end
  {
    const r = rngf(7), n = 7, pos: number[] = [];
    const ring: THREE.Vector3[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, z = -0.035 + t * 0.07, w = 0.0055 * (1 - t * 0.85) * (i === 0 ? 1.15 : 1), h = 0.0028 * (1 - t * 0.7), bend = 0.004 * Math.sin(t * Math.PI);
      const jag = i === 0 ? 0.004 : 0;
      ring.push([[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y], j) => new THREE.Vector3(x!, y! + bend, z - (j % 2 ? jag * r() : 0))));
    }
    const q = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) {
      const a = ring[i]![j]!, b = ring[i]![(j + 1) % 4]!, c = ring[i + 1]![(j + 1) % 4]!, d = ring[i + 1]![j]!;
      q(a, b, c, d);
    }
    const e = ring[0]!;
    q(e[3]!, e[2]!, e[1]!, e[0]!);
    const tip = ring[n]!;
    q(tip[0]!, tip[1]!, tip[2]!, tip[3]!);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    paint(g, (_x, y, z, o) => { o.setScalar(0.8 + 0.2 * Math.sin(z * 900 + y * 300)); }, 0, 0.9);
    tag(g, K.SPLINTER, 0.003);
  }
  // stone chip: jittered icosahedron, faceted
  {
    const r = rngf(3);
    const ico = new THREE.IcosahedronGeometry(0.011, 0);
    const p = ico.attributes.position as THREE.BufferAttribute;
    const moved = new Map<string, [number, number, number]>();
    for (let i = 0; i < p.count; i++) {
      const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
      if (!moved.has(key)) moved.set(key, [0.7 + r() * 0.55, 0.5 + r() * 0.35, 0.8 + r() * 0.5]);
      const [a, b, c] = moved.get(key)!;
      p.setXYZ(i, p.getX(i) * a, p.getY(i) * b, p.getZ(i) * c);
    }
    const g = tidy(ico, true);
    paint(g, (_x, y, _z, o) => { o.setScalar(0.85 + 0.15 * Math.sign(y)); }, 0, 0.95);
    tag(g, K.CHIP, 0.005);
  }
  // dirt clod: lumpy smooth rock
  {
    const r = rngf(11);
    const ico = new THREE.IcosahedronGeometry(0.014, 1);
    const merged = mergeVertices(ico, 1e-5);
    const p = merged.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const f = 0.75 + r() * 0.4;
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.8, p.getZ(i) * f);
    }
    const g = tidy(merged);
    paint(g, (_x, y, _z, o) => { o.setScalar(0.8 + 0.2 * (y > 0 ? 1 : 0)); }, 0, 1);
    tag(g, K.CLOD, 0.008);
  }
  // glass shard: thin sharp sliver
  {
    const a = new THREE.Vector2(0, 0.02), b = new THREE.Vector2(-0.008, -0.011), c = new THREE.Vector2(0.01, -0.007), d = new THREE.Vector2(0.0015, -0.016);
    let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(new THREE.Shape([a, b, d, c]), { depth: 0.0018, bevelEnabled: false });
    g.translate(0, 0, -0.0009);
    g.rotateX(Math.PI / 2);
    g = tidy(g, true);
    paint(g, (_x, y, _z, o) => { o.setScalar(y > 0 ? 1 : 0.85); }, 0.2, 0.08);
    tag(g, K.SHARD, 0.001);
  }

  const list = parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    if (!q.attributes.color) paint(q, (_x, _y, _z, o) => { o.copy(WHITE); });
    for (const k of Object.keys(q.attributes)) if (!["position", "normal", "color", "aShape", "aPbr"].includes(k)) q.deleteAttribute(k);
    return q;
  });
  let v0 = 0;
  list.forEach((q) => {
    const shape = (q.attributes.aShape as THREE.BufferAttribute).getX(0);
    RANGE[shape] = [v0, q.attributes.position!.count];
    v0 += q.attributes.position!.count;
  });
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "color", "aShape", "aPbr"]) {
    const size = list[0]!.attributes[name]!.itemSize;
    const total = list.reduce((s, x) => s + x.attributes[name]!.count, 0);
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const x of list) {
      arr.set((x.attributes[name] as THREE.BufferAttribute).array as Float32Array, off);
      off += x.attributes[name]!.count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

export interface ChunkParams {
  shape: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds alive after birth (including time at rest). */
  life: number;
  scale: number;
  r: number; g: number; b: number;
  /** Bounce restitution. */
  rest: number;
  spin: number;
  grav: number;
  /** Seconds before it appears (impact debris waits for its round). */
  delay: number;
  /**
   * First-person brass: the scale the piece is BORN at (the viewmodel is a
   * scale model near the lens), easing to `scale` over `growT` seconds.
   */
  born: number;
  growT: number;
}
const DEF: ChunkParams = {
  shape: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 2, scale: 1, r: 1, g: 1, b: 1,
  rest: 0.35, spin: 12, grav: 1, delay: 0, born: -1, growT: 0.12,
};

/** Floats per live piece. */
const F_N = 24;
// layout
const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5, RX = 6, RY = 7, RZ = 8, WX = 9, WY = 10, WZ = 11;
const SCL = 12, AGE = 13, LIFE = 14, FLOOR = 15, REST = 16, GRAV = 17, STATE = 18, FX = 19, FZ = 20, BORN = 21, GROW = 22, SHAPE = 23;

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const _face = new Float64Array(7);

export class Chunks {
  readonly mesh: THREE.InstancedMesh;
  readonly p: ChunkParams = { ...DEF };
  count = 0;
  private readonly F: Float32Array;
  private readonly shapeAttr: THREE.InstancedBufferAttribute;
  private colorDirty = false;
  private rnd = rngf(99);

  constructor(readonly cap: number) {
    const geo = buildShapes();
    this.shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.shapeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iShape", this.shapeAttr);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, envMapIntensity: 1, side: THREE.DoubleSide });
    mat.name = "wfx-chunks";
    mat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aShape;\nattribute float iShape;\nattribute vec2 aPbr;\nvarying vec2 vPbr;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPbr = aPbr;\nif (abs(aShape - iShape) > 0.5) transformed = vec3(0.0);");
      s.fragmentShader = s.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vPbr;")
        .replace("#include <roughnessmap_fragment>", "float roughnessFactor = vPbr.y;")
        .replace("#include <metalnessmap_fragment>", "float metalnessFactor = vPbr.x;");
    };
    mat.customProgramCacheKey = () => "gs-wfx-chunks-1";
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.name = "wfx-chunks";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.F = new Float32Array(cap * F_N);
  }

  /**
   * QA only: the live pieces as ONE real triangle soup in world space (each
   * piece's own shape, not the collapsed union the GPU draws), so the flicker
   * detector's ID pass sees exactly the surfaces the frame shows.
   */
  qaTriangles(): Float32Array {
    const pos = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const mats = this.mesh.instanceMatrix.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.F[i * F_N + AGE]! < 0) continue;
      n += RANGE[this.F[i * F_N + SHAPE]!]?.[1] ?? 0;
    }
    const out = new Float32Array(n * 3);
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.F[i * F_N + AGE]! < 0) continue;
      const r = RANGE[this.F[i * F_N + SHAPE]!];
      if (!r) continue;
      _m.fromArray(mats, i * 16);
      for (let v = r[0]; v < r[0] + r[1]; v++) {
        _p.fromBufferAttribute(pos, v).applyMatrix4(_m);
        out[k++] = _p.x; out[k++] = _p.y; out[k++] = _p.z;
      }
    }
    return out;
  }

  /** Live share of the pool, 0..1 — callers shorten brass life under load. */
  get load(): number {
    return this.count / this.cap;
  }

  emit(): void {
    const p = this.p;
    if (this.count >= this.cap) {
      Object.assign(p, DEF);
      return;
    }
    const i = this.count++;
    const o = i * F_N;
    const F = this.F;
    const R = this.rnd;
    F[o + PX] = p.x; F[o + PY] = p.y; F[o + PZ] = p.z;
    F[o + VX] = p.vx; F[o + VY] = p.vy; F[o + VZ] = p.vz;
    F[o + RX] = R() * 6.28; F[o + RY] = R() * 6.28; F[o + RZ] = R() * 6.28;
    F[o + WX] = (R() - 0.5) * 2 * p.spin; F[o + WY] = (R() - 0.5) * 2 * p.spin; F[o + WZ] = (R() - 0.5) * 2 * p.spin;
    F[o + SCL] = p.scale;
    F[o + AGE] = -p.delay;
    F[o + LIFE] = p.life;
    F[o + FLOOR] = NaN; // sampled on the first live frame
    F[o + REST] = p.rest;
    F[o + GRAV] = p.grav;
    F[o + STATE] = 0;
    F[o + FX] = p.x; F[o + FZ] = p.z;
    F[o + BORN] = p.born;
    F[o + GROW] = p.growT;
    F[o + SHAPE] = p.shape;
    this.shapeAttr.array[i] = p.shape;
    const c = this.mesh.instanceColor!.array as Float32Array;
    c[i * 3] = p.r; c[i * 3 + 1] = p.g; c[i * 3 + 2] = p.b;
    this.colorDirty = true;
    Object.assign(p, DEF);
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.F.copyWithin(i * F_N, last * F_N, last * F_N + F_N);
      const s = this.shapeAttr.array as Float32Array;
      s[i] = s[last]!;
      const c = this.mesh.instanceColor!.array as Float32Array;
      c[i * 3] = c[last * 3]!; c[i * 3 + 1] = c[last * 3 + 1]!; c[i * 3 + 2] = c[last * 3 + 2]!;
      this.colorDirty = true;
    }
  }

  /** The surface under a point: a short ray down into the colliders (lids, roofs, the floor plane). */
  private floorAt(x: number, y: number, z: number): number {
    const t = traceWorld(x, y + 0.05, z, 0, -1, 0, 30).t;
    // t == 0: the ray starts inside a box — NaN tells the caller
    return t <= 1e-6 ? NaN : y + 0.05 - t;
  }

  update(dt: number): void {
    const F = this.F;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const o = i * F_N;
      const age = (F[o + AGE]! += dt);
      const life = F[o + LIFE]!;
      if (age >= life) {
        this.kill(i);
        i--;
        continue;
      }
      if (age < 0) {
        // not born yet: park it at zero scale
        _m.makeScale(0, 0, 0);
        _m.toArray(arr, i * 16);
        continue;
      }
      const shape = F[o + SHAPE]!;
      const restR = (REST_R[shape] ?? 0.005) * F[o + SCL]!;
      if (F[o + STATE] === 0) {
        let vx = F[o + VX]!, vy = F[o + VY]!, vz = F[o + VZ]!;
        vy -= 9.8 * F[o + GRAV]! * dt;
        const d = Math.exp(-0.35 * dt);
        vx *= d; vz *= d;
        F[o + PX]! += vx * dt; F[o + PY]! += vy * dt; F[o + PZ]! += vz * dt;
        F[o + RX]! += F[o + WX]! * dt; F[o + RY]! += F[o + WY]! * dt; F[o + RZ]! += F[o + WZ]! * dt;
        // re-sample the floor once the piece has travelled off its last sample
        const fdx = F[o + PX]! - F[o + FX]!, fdz = F[o + PZ]! - F[o + FZ]!;
        const fresh = F[o + FLOOR] !== F[o + FLOOR];
        if (fresh || fdx * fdx + fdz * fdz > 0.04) {
          if (!fresh) {
            // the 20 cm just flown: did it cross a wall?
            const d = Math.sqrt(fdx * fdx + fdz * fdz);
            const ux = fdx / d, uz = fdz / d;
            const hit = traceWorld(F[o + FX]!, F[o + PY]!, F[o + FZ]!, ux, 0, uz, d + 0.02);
            if (hit.hit && hit.t <= d) {
              const hx = F[o + FX]! + ux * hit.t, hz = F[o + FZ]! + uz * hit.t;
              faceOf(hit.hit, hx, F[o + PY]!, hz, 0, _face);
              const nx = _face[0]!, nz = _face[2]!;
              F[o + PX] = hx + nx * 0.02 - ux * 0.01; F[o + PZ] = hz + nz * 0.02 - uz * 0.01;
              const vn = vx * nx + vz * nz;
              if (vn < 0) { vx -= (1 + F[o + REST]!) * vn * nx; vz -= (1 + F[o + REST]!) * vn * nz; vx *= 0.7; vz *= 0.7; }
            }
          }
          // Sample from no lower than the last floor: one fast frame can carry the
          // piece a few cm UNDER it before the snap below runs, and a ray cast
          // from under the floor plane finds nothing (the old `FLOOR || -1e9`
          // also treated a floor at exactly 0 as "none" — brass fell forever).
          const prev = F[o + FLOOR]!;
          const fy = this.floorAt(F[o + PX]!, prev === prev ? Math.max(F[o + PY]!, prev + restR) : F[o + PY]!, F[o + PZ]!);
          if (fy !== fy) {
            // born or pushed inside a solid: retire it rather than hang it in the steel
            this.kill(i);
            i--;
            continue;
          }
          F[o + FLOOR] = fy;
          F[o + FX] = F[o + PX]!; F[o + FZ] = F[o + PZ]!;
        }
        const floor = F[o + FLOOR]! + restR;
        if (F[o + PY]! < floor) {
          F[o + PY] = floor;
          if (vy < -0.9) {
            vy = -vy * F[o + REST]!;
            vx *= 0.55; vz *= 0.55;
            F[o + WX]! *= 0.45; F[o + WY]! *= 0.6; F[o + WZ]! *= 0.45;
          } else {
            vx = vy = vz = 0;
            F[o + STATE] = 1;
            // lie FLAT: long axis (+Z) horizontal — Euler XYZ with x in {0, pi}
            F[o + RX] = Math.abs(Math.cos(F[o + RX]!)) > 0.5 ? (Math.cos(F[o + RX]!) > 0 ? 0 : Math.PI) : 0;
          }
        }
        F[o + VX] = vx; F[o + VY] = vy; F[o + VZ] = vz;
      }
      // pop in, hold, shrink out over the last 0.3 s (opaque: no ghosting through walls)
      const fin = Math.min(1, (life - age) / 0.3);
      let s = F[o + SCL]! * fin * fin * Math.min(1, age / 0.02 + 0.35);
      const born = F[o + BORN]!;
      if (born > 0) {
        const g = Math.min(1, age / Math.max(1e-3, F[o + GROW]!));
        const k = g * g * (3 - 2 * g);
        s *= born + (1 - born) * k;
      }
      _e.set(F[o + RX]!, F[o + RY]!, F[o + RZ]!);
      _q.setFromEuler(_e);
      _p.set(F[o + PX]!, F[o + PY]!, F[o + PZ]!);
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      _m.toArray(arr, i * 16);
    }
    const n = this.count;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.colorDirty) {
        const c = this.mesh.instanceColor!;
        c.clearUpdateRanges();
        c.addUpdateRange(0, n * 3);
        c.needsUpdate = true;
        this.shapeAttr.clearUpdateRanges();
        this.shapeAttr.addUpdateRange(0, n);
        this.shapeAttr.needsUpdate = true;
        this.colorDirty = false;
      }
    }
  }
}
