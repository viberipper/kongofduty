/**
 * client/src/nuketown-glass.ts — BREAKABLE GLASS (feel stream R2; Nuketown only).
 * ===========================================================================
 *
 * Shoot a window: the first round CRACKS the pane (a spider-web of fractures
 * round the impact, drawn into the pane's own glass shader), the next one —
 * or a frag going off within 3 m — SHATTERS it: the pane is gone and a shower
 * of glints falls to the floor, with the glass bank's crash. Houses (the map's
 * nt_window_glass) and every vehicle (the bus's, the cars', the trucks' *_glass).
 *
 * DETERMINISTIC: driven only by the server's SHOT / BOOM events
 * (Game.worldEvents — the same authoritative rays on every client), panes are
 * found by the same geometry everywhere, and the shards' scatter is hashed off
 * the shot. Glass does not stop a round (CoD): every pane along it, up to the
 * first collider, takes the hit. Panes go back in at the next match.
 *
 * NO FLICKER, BY CONSTRUCTION:
 *  - nothing in the scene changes until a pane is first hit (the panes are
 *    found on the CPU at load; the flicker gate's viewpoints see the shipped
 *    glass untouched);
 *  - a hit pane moves into its own mesh that SHARES the source's vertex
 *    attributes (same vertices, same depth, nothing coplanar added) and the
 *    source's index entries for it become degenerate — the crack lives in that
 *    pane's own material, never in an overlay;
 *  - pane meshes keep the source's blend family with a FIXED renderOrder
 *    offset each, so no two blended surfaces can swap order frame to frame;
 *  - shards are small OPAQUE glints (no blending to sort).
 */
import * as THREE from "three";
import { groundHeight, traceWorld } from "@shared/map";
import { activeMap } from "@shared/maps";
import type { NetEvent } from "@shared/protocol";
import type { Game } from "./game";

const MAX_SHARDS = 480;
const SHARDS_PER_PANE = 42;
const MAX_CRACKS = 3;

type Pane = {
  src: THREE.Mesh;
  /** index-buffer offsets of this pane's triangles in the source (multiples of 3). */
  tris: number[];
  /** the source index values, for the reset. */
  orig: Uint32Array;
  /** world-space triangles, 9 floats each, and bounds. */
  wt: Float32Array;
  box: THREE.Box3;
  n: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  c: THREE.Vector3;
  area: number;
  hits: number;
  mesh: THREE.Mesh | null;
  mat: THREE.Material | null;
  cracks: THREE.Vector3[];
  gone: boolean;
};

type Shard = { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3; s: number; age: number; rest: boolean };

function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const isGlass = (m: THREE.Material | undefined): boolean =>
  !!m && (m as THREE.MeshStandardMaterial).transparent && /glass/i.test(m.name) && !/shade|broken|lamp|bulb/i.test(m.name);

export class BreakableGlass {
  private panes: Pane[] = [];
  private touched = new Map<THREE.Mesh, { geo: THREE.BufferGeometry; orig: THREE.BufferGeometry }>();
  private shards: Shard[] = [];
  private shardMesh: THREE.InstancedMesh | null = null;
  private wasEnded = false;
  private order = 0;
  private readonly solids = activeMap().solids;
  private m4 = new THREE.Matrix4();
  private sv = new THREE.Vector3();

  constructor(private game: Game) {}

  init(): void {
    const scene = this.game.world!.scene;
    scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material) || !isGlass(m.material) || !m.geometry.index) return;
      if (m.name.startsWith("nuke") || m.userData.qaIgnore) return;
      meshes.push(m);
    });
    for (const m of meshes) this.extract(m);
    // a stable order on every client (props finish loading in any order): by where the pane is
    this.panes.sort((a, b) => a.c.x - b.c.x || a.c.z - b.c.z || a.c.y - b.c.y);
    this.game.worldEvents.push((e) => this.onEvent(e));
    // the shard draw exists from the start (count 0 draws nothing), and the cracked-glass
    // programs are compiled now — neither the first crack nor the first shatter hitches
    this.makeShardMesh();
    const warm = new THREE.Group();
    const seen = new Set<THREE.Material>();
    for (const p of this.panes) {
      const mat = p.src.material as THREE.Material;
      if (seen.has(mat)) continue;
      seen.add(mat);
      warm.add(new THREE.Mesh(p.src.geometry, crackedMaterial(mat, p)));
    }
    warm.add(this.shardMesh!.clone());
    const r = this.game.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    void r.compileAsync?.(warm, this.game.camera, scene).catch(() => {});
    (window as unknown as { __glass?: BreakableGlass }).__glass = this;
  }

  /** Split one glass mesh into panes: connected triangle sets (vertices welded at 1 mm). */
  private extract(mesh: THREE.Mesh): void {
    const g = mesh.geometry;
    const idx = g.index!;
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const nTri = Math.floor(idx.count / 3);
    if (!nTri || nTri > 60000) return;
    // weld by position, then union-find over triangles sharing a welded vertex
    const key = new Map<string, number>();
    const weld = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const k = `${Math.round(pos.getX(i) * 1000)}|${Math.round(pos.getY(i) * 1000)}|${Math.round(pos.getZ(i) * 1000)}`;
      let w = key.get(k);
      if (w === undefined) key.set(k, (w = key.size));
      weld[i] = w;
    }
    const parent = new Int32Array(key.size).map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
      return x;
    };
    for (let t = 0; t < nTri; t++) {
      const a = find(weld[idx.getX(t * 3)]!), b = find(weld[idx.getX(t * 3 + 1)]!), c = find(weld[idx.getX(t * 3 + 2)]!);
      parent[b] = a;
      parent[find(c)] = find(a);
    }
    const groups = new Map<number, number[]>();
    for (let t = 0; t < nTri; t++) {
      const r = find(weld[idx.getX(t * 3)]!);
      let arr = groups.get(r);
      if (!arr) groups.set(r, (arr = []));
      arr.push(t * 3);
    }
    mesh.updateWorldMatrix(true, false);
    const mw = mesh.matrixWorld;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
    for (const tris of groups.values()) {
      const wt = new Float32Array(tris.length * 9);
      const box = new THREE.Box3();
      const n = new THREE.Vector3();
      const cen = new THREE.Vector3();
      let area = 0;
      tris.forEach((o, k) => {
        a.fromBufferAttribute(pos, idx.getX(o)).applyMatrix4(mw);
        b.fromBufferAttribute(pos, idx.getX(o + 1)).applyMatrix4(mw);
        c.fromBufferAttribute(pos, idx.getX(o + 2)).applyMatrix4(mw);
        a.toArray(wt, k * 9);
        b.toArray(wt, k * 9 + 3);
        c.toArray(wt, k * 9 + 6);
        box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
        cr.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
        const ar = cr.length() * 0.5;
        // orient every triangle's normal the same way before averaging (two-faced slabs cancel otherwise)
        if (n.lengthSq() > 0 && cr.dot(n) < 0) cr.negate();
        n.add(cr);
        cen.addScaledVector(a.add(b).add(c).multiplyScalar(1 / 3), ar);
        area += ar;
      });
      if (area < 0.01) continue; // slivers, edges: not a pane
      n.normalize();
      cen.multiplyScalar(1 / area);
      const u = new THREE.Vector3(0, 1, 0).cross(n);
      if (u.lengthSq() < 1e-4) u.set(1, 0, 0).cross(n);
      u.normalize();
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      const orig = new Uint32Array(tris.length * 3);
      tris.forEach((o, k) => {
        orig[k * 3] = idx.getX(o);
        orig[k * 3 + 1] = idx.getX(o + 1);
        orig[k * 3 + 2] = idx.getX(o + 2);
      });
      box.expandByScalar(0.02);
      this.panes.push({ src: mesh, tris, orig, wt, box, n, u, v, c: cen, area, hits: 0, mesh: null, mat: null, cracks: [], gone: false });
    }
  }

  /** Panes found / cracked / shattered (QA). */
  count(): { panes: number; cracked: number; gone: number } {
    let cracked = 0, gone = 0;
    for (const p of this.panes) {
      if (p.gone) gone++;
      else if (p.hits) cracked++;
    }
    return { panes: this.panes.length, cracked, gone };
  }

  // ---------------------------------------------------------------- events

  private ray = new THREE.Ray();
  private hit = new THREE.Vector3();
  private ta = new THREE.Vector3();
  private tb = new THREE.Vector3();
  private tc = new THREE.Vector3();

  private onEvent(e: NetEvent): void {
    if (e.t === "shot") {
      const far = traceWorld(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, 200).t + 0.08;
      this.ray.origin.set(e.ox, e.oy, e.oz);
      this.ray.direction.set(e.dx, e.dy, e.dz);
      const hits: { p: Pane; t: number; at: THREE.Vector3 }[] = [];
      for (const p of this.panes) {
        if (p.gone) continue;
        if (!this.ray.intersectBox(p.box, this.hit)) continue;
        if (this.hit.distanceTo(this.ray.origin) > far) continue;
        let best = Infinity;
        for (let k = 0; k < p.wt.length; k += 9) {
          this.ta.fromArray(p.wt, k);
          this.tb.fromArray(p.wt, k + 3);
          this.tc.fromArray(p.wt, k + 6);
          if (this.ray.intersectTriangle(this.ta, this.tb, this.tc, false, this.hit)) {
            const t = this.hit.distanceTo(this.ray.origin);
            if (t < best) best = t;
          }
        }
        if (best <= far) hits.push({ p, t: best, at: this.ray.at(best, new THREE.Vector3()) });
      }
      hits.sort((x, y) => x.t - y.t);
      for (const h of hits) this.strike(h.p, h.at, this.ray.direction, hash(e.ox * 7.3 + e.oz, e.dx * 91.7 + e.dy));
    } else if (e.t === "boom") {
      const at = new THREE.Vector3(e.x, e.y, e.z);
      for (const p of this.panes) {
        if (p.gone) continue;
        const d = p.box.distanceToPoint(at);
        if (d < 3) this.shatter(p, p.box.clampPoint(at, new THREE.Vector3()), this.sv.subVectors(p.c, at).normalize().clone(), hash(e.x, e.z + p.area));
      }
    }
  }

  /** One round through a pane: the first cracks it, the next shatters it. */
  private strike(p: Pane, at: THREE.Vector3, dir: THREE.Vector3, r: number): void {
    p.hits++;
    if (p.hits >= 2 || p.area < 0.08) {
      this.shatter(p, at, dir, r);
      return;
    }
    this.detach(p);
    p.cracks.push(at.clone());
    const u = (p.mat as THREE.Material & { userData: { crack?: { value: THREE.Vector3[] }; crackN?: { value: number }; seed?: { value: number } } }).userData;
    if (u.crack) {
      u.crack.value[p.cracks.length - 1]!.copy(at);
      u.crackN!.value = Math.min(MAX_CRACKS, p.cracks.length);
      u.seed!.value = r * 100;
    }
    this.game.audio.impact(at.x, at.y, at.z, "glass");
  }

  /** Move the pane into its own mesh (shared vertices, its own index and cracked material). */
  private detach(p: Pane): void {
    if (p.mesh) return;
    const src = p.src;
    // the source gets its own index on first touch (a template's geometry may be shared)
    let t = this.touched.get(src);
    if (!t) {
      const geo = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(src.geometry.attributes)) geo.setAttribute(k, a);
      geo.setIndex(src.geometry.index!.clone());
      geo.boundingBox = src.geometry.boundingBox;
      geo.boundingSphere = src.geometry.boundingSphere;
      t = { geo, orig: src.geometry };
      this.touched.set(src, t);
      src.geometry = geo;
    }
    const idx = src.geometry.index!;
    const arr = idx.array as Uint16Array | Uint32Array;
    let lo = Infinity, hi = -1;
    for (const o of p.tris) {
      arr[o + 1] = arr[o]!;
      arr[o + 2] = arr[o]!;
      lo = Math.min(lo, o);
      hi = Math.max(hi, o + 2);
    }
    idx.addUpdateRange(lo, hi - lo + 1);
    idx.needsUpdate = true;
    // the pane: the same vertices, its own triangles
    const pg = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(src.geometry.attributes)) pg.setAttribute(k, a);
    pg.setIndex(new THREE.BufferAttribute(p.orig.slice(), 1));
    pg.boundingBox = p.box.clone().applyMatrix4(this.m4.copy(src.matrixWorld).invert());
    pg.boundingSphere = pg.boundingBox.getBoundingSphere(new THREE.Sphere());
    p.mat = crackedMaterial(src.material as THREE.Material, p);
    p.mesh = new THREE.Mesh(pg, p.mat);
    p.mesh.name = "glass-pane";
    p.mesh.matrixAutoUpdate = false;
    p.mesh.matrix.copy(src.matrixWorld);
    p.mesh.matrixWorldNeedsUpdate = true;
    p.mesh.renderOrder = src.renderOrder + 0.002 + (this.order++ % 400) * 0.00001;
    p.mesh.castShadow = false;
    p.mesh.receiveShadow = src.receiveShadow;
    p.mesh.userData.kind = src.userData.kind;
    this.game.world!.scene.add(p.mesh);
  }

  private shatter(p: Pane, at: THREE.Vector3, dir: THREE.Vector3, r: number): void {
    if (p.gone) return;
    this.detach(p);
    p.gone = true;
    if (p.mesh) p.mesh.visible = false;
    // the shower: shards from across the pane, thrown along the round
    const n = Math.min(SHARDS_PER_PANE, Math.max(8, Math.round(p.area * 24)));
    const half = Math.sqrt(p.area) * 0.5;
    for (let i = 0; i < n; i++) {
      if (this.shards.length >= MAX_SHARDS) this.shards.shift();
      const su = (hash(r, i) - 0.5) * 2 * half, sv = (hash(i, r) - 0.5) * 2 * half;
      const pos = p.c.clone().addScaledVector(p.u, su).addScaledVector(p.v, sv);
      const away = Math.sign(dir.dot(p.n)) || 1;
      const vel = p.n.clone().multiplyScalar(away * (1.2 + hash(r + i, 3) * 2.4)).addScaledVector(dir, 1.5);
      vel.y += 0.6 + hash(i, r * 3) * 1.2;
      this.shards.push({
        p: pos,
        v: vel,
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(hash(i, 1) * 6, hash(i, 2) * 6, hash(i, 3) * 6)),
        w: new THREE.Vector3(hash(i, 4) - 0.5, hash(i, 5) - 0.5, hash(i, 6) - 0.5).multiplyScalar(26),
        s: 0.45 + hash(i, r) * 1.0,
        age: 0,
        rest: false,
      });
    }
    this.game.audio.impact(at.x, at.y, at.z, "glass");
    const a = this.game.audio;
    setTimeout(() => a.impact(at.x, at.y - 0.4, at.z, "glass"), 70);
    setTimeout(() => a.impact(p.c.x, Math.max(0, p.box.min.y), p.c.z, "glass"), 260);
  }

  // ---------------------------------------------------------------- per frame

  private dq = new THREE.Quaternion();
  private sc = new THREE.Vector3();

  update(dt: number): void {
    const g = this.game;
    if (this.wasEnded && !g.ended) this.reset();
    this.wasEnded = g.ended;
    const m = this.shardMesh;
    if (!m) return;
    if (!this.shards.length) {
      if (m.count) m.count = 0;
      return;
    }
    const step = Math.min(0.05, dt);
    let k = 0;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.age += step;
      if (!s.rest) {
        s.v.y -= 9.8 * step;
        s.p.addScaledVector(s.v, step);
        this.dq.setFromAxisAngle(this.sv.copy(s.w).normalize(), s.w.length() * step);
        s.q.premultiply(this.dq);
        const floor = groundHeight(s.p.x, s.p.z, this.solids, s.p.y + 0.2) + 0.01;
        if (s.p.y < floor) {
          s.p.y = floor;
          if (Math.abs(s.v.y) > 1.2) {
            s.v.y = -s.v.y * 0.25;
            s.v.x *= 0.4;
            s.v.z *= 0.4;
            s.w.multiplyScalar(0.4);
          } else s.rest = true;
        }
      }
      const life = s.age < 5 ? 1 : Math.max(0, 1 - (s.age - 5) / 1.5);
      if (life <= 0) {
        this.shards.splice(i, 1);
        continue;
      }
      this.sc.setScalar(0.075 * s.s * life);
      this.m4.compose(s.p, s.q, this.sc);
      m.setMatrixAt(k++, this.m4);
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
  }

  private makeShardMesh(): void {
    const geo = new THREE.BufferGeometry();
    // a thin sliver of a triangle
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0.9, 0, -0.55, -0.5, 0.04, 0.6, -0.4, -0.04], 3));
    geo.computeVertexNormals();
    // opaque glints: bright enough to catch the eye in a shaded room (a faint self-light), no blending to sort
    const mat = new THREE.MeshStandardMaterial({ color: 0xdcecee, roughness: 0.05, metalness: 0.2, envMapIntensity: 2.4, emissive: 0x9fb4b8, emissiveIntensity: 0.22, side: THREE.DoubleSide });
    this.shardMesh = new THREE.InstancedMesh(geo, mat, MAX_SHARDS);
    this.shardMesh.name = "glass-shards";
    this.shardMesh.frustumCulled = false;
    this.shardMesh.count = 0;
    this.game.world!.scene.add(this.shardMesh);
  }

  /** Every pane back in (next match). */
  private reset(): void {
    for (const p of this.panes) {
      if (!p.mesh) continue;
      // (its geometry SHARES the source's vertex buffers: never disposed, only dropped)
      p.mesh.removeFromParent();
      p.mat?.dispose();
      p.mesh = null;
      p.mat = null;
      p.hits = 0;
      p.cracks.length = 0;
      p.gone = false;
    }
    for (const [src, t] of this.touched) src.geometry = t.orig;
    this.touched.clear();
    this.shards.length = 0;
  }
}

/**
 * The pane's own glass: a clone of its source material (the same look, the same
 * blend family) with the fractures drawn in — radial spokes and broken rings
 * round each impact, in the pane's plane, whitening and thickening the glass
 * along the cracks. Program shared by every cracked pane of a source material.
 */
function crackedMaterial(base: THREE.Material, p: Pane): THREE.Material {
  const m = base.clone();
  const crack = { value: Array.from({ length: MAX_CRACKS }, () => new THREE.Vector3()) };
  const crackN = { value: 0 };
  const seed = { value: 0 };
  const U = { value: p.u.clone() };
  const V = { value: p.v.clone() };
  m.userData = { ...m.userData, crack, crackN, seed };
  const baseCompile = base.onBeforeCompile.bind(base);
  m.onBeforeCompile = (sh, r) => {
    baseCompile(sh, r);
    Object.assign(sh.uniforms, { uCrack: crack, uCrackN: crackN, uCrackSeed: seed, uCrackU: U, uCrackV: V });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCrackW;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCrackW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vCrackW;
        uniform vec3 uCrack[${MAX_CRACKS}]; uniform int uCrackN; uniform float uCrackSeed; uniform vec3 uCrackU, uCrackV;
        float crH(float x){ return fract(sin(x * 91.3 + uCrackSeed) * 43758.5453); }
        // a spider-web round one impact: jittered radial spokes, broken concentric rings, a frosted heart
        float crackAt(vec3 c){
          vec3 d = vCrackW - c; vec2 q = vec2(dot(d, uCrackU), dot(d, uCrackV));
          float r = length(q); float a = atan(q.y, q.x);
          float k = 0.0;
          for (int i = 0; i < 11; i++){
            float ang = (float(i) + crH(float(i)) * 0.7) * 6.2831 / 11.0 + sin(r * 9.0 + float(i)) * 0.06;
            float da = abs(mod(a - ang + 3.14159, 6.2831) - 3.14159);
            float len = 0.25 + crH(float(i) + 7.0) * 0.55;
            k = max(k, (1.0 - smoothstep(0.0, 0.0028 / max(r, 0.004) + 0.006, da * r)) * (1.0 - smoothstep(len * 0.6, len, r)));
          }
          for (int j = 1; j < 4; j++){
            float rr = 0.035 * float(j * j) + crH(float(j) + 3.0) * 0.02;
            float seg = step(0.32, crH(floor(a * 2.6 + float(j) * 5.0)));
            k = max(k, (1.0 - smoothstep(0.0, 0.0035, abs(r - rr - sin(a * 5.0) * 0.006))) * seg);
          }
          k = max(k, 1.0 - smoothstep(0.012, 0.03, r));
          return k;
        }`,
      )
      .replace(
        "#include <alphamap_fragment>",
        `#include <alphamap_fragment>
        float crK = 0.0;
        for (int i = 0; i < ${MAX_CRACKS}; i++){ if (i < uCrackN) crK = max(crK, crackAt(uCrack[i])); }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.96, 0.97), crK);
        diffuseColor.a = mix(diffuseColor.a, 0.88, crK);`,
      );
  };
  const baseKey = base.customProgramCacheKey.bind(base);
  m.customProgramCacheKey = () => `crack|${baseKey()}`;
  return m;
}
