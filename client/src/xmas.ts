/**
 * client/src/xmas.ts — NOVEMBER AND DECEMBER: A GIANT TREE AND STRING LIGHTS.
 * ===========================================================================
 *
 * Seasonal set dressing, drawn and never collided with:
 *
 *   THE TREE   a 22 m fir just OUTSIDE one corner of the map's bounds,
 *              tall enough to read over every wall: stacked tiers, a gold
 *              star, baubles, a spiral of twinkling bulbs and a pile of
 *              presents at its foot.
 *   THE LIGHTS strings of bulbs sagging along the top of every perimeter
 *              `wall` solid (Shipment's yard fence), so the yard itself is
 *              decorated without a single new collider.
 *
 * game.ts loads this module only from Nov 1 to Dec 31 (or with ?xmas=1;
 * ?xmas=0 turns it off). Everything here is instanced: the whole set is a
 * handful of draw calls, and the twinkle is three material colours updated
 * once a frame from the bulbs' onBeforeRender — no per-frame allocation.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/maps/types";

const TAU = Math.PI * 2;
const TREE_H = 22;
const TREE_R = 6.4;

/** Deterministic scatter so every client decorates the same tree. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Three twinkle groups of bulbs, sharing one sphere and three unlit materials. */
class Bulbs {
  readonly group = new THREE.Group();
  private readonly mats: THREE.MeshBasicMaterial[];
  private readonly base: THREE.Color[];
  private readonly lists: THREE.Matrix4[][] = [[], [], []];
  private frame = -1;

  constructor(colors: number[]) {
    this.base = colors.map((c) => new THREE.Color(c));
    this.mats = colors.map((c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false, fog: true }));
  }

  add(x: number, y: number, z: number, i: number, r = 0.09): void {
    this.lists[i % 3]!.push(new THREE.Matrix4().makeScale(r, r, r).setPosition(x, y, z));
  }

  build(): THREE.Group {
    const geo = new THREE.SphereGeometry(1, 8, 6);
    this.lists.forEach((list, k) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, this.mats[k]!, list.length);
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.frustumCulled = false;
      mesh.name = `xmas/bulbs-${k}`;
      mesh.onBeforeRender = () => this.twinkle();
      this.group.add(mesh);
    });
    return this.group;
  }

  /** Once per frame (the first bulb mesh drawn pays it): three slow, offset pulses. */
  private twinkle(): void {
    const now = performance.now();
    const f = Math.floor(now / 16);
    if (f === this.frame) return;
    this.frame = f;
    const t = now / 1000;
    for (let k = 0; k < 3; k++) {
      const p = 0.55 + 0.45 * Math.max(0, Math.sin(t * 1.7 + k * 2.1));
      this.mats[k]!.color.copy(this.base[k]!).multiplyScalar(0.35 + 1.25 * p);
    }
  }
}

function buildTree(x: number, z: number, y0: number, bulbs: Bulbs): THREE.Group {
  const g = new THREE.Group();
  g.name = "xmas/tree";
  g.position.set(x, y0, z);
  const R = rng(1225);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.8, 2.6, 12),
    new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.95 }),
  );
  trunk.position.y = 1.3;
  g.add(trunk);

  // five overlapping tiers, each a little darker toward the top
  const tiers = 5;
  const leaf = new THREE.MeshStandardMaterial({ color: 0x1f5a2c, roughness: 0.9, flatShading: true });
  const tierInfo: { y: number; h: number; r: number }[] = [];
  for (let i = 0; i < tiers; i++) {
    const f = i / (tiers - 1);
    const r = TREE_R * (1 - f * 0.78);
    const h = 4.4 - f * 1.3;
    const y = 2.2 + i * ((TREE_H - 2.2 - 3.2) / (tiers - 1));
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 18, 1), leaf);
    cone.position.y = y + h / 2;
    cone.rotation.y = i * 0.7;
    g.add(cone);
    tierInfo.push({ y, h, r });
  }

  // the star: two flat five-point stars crossed, unlit gold
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU + Math.PI / 2;
    const rr = i % 2 ? 0.45 : 1.1;
    if (i) star.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else star.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  const starGeo = new THREE.ExtrudeGeometry(star, { depth: 0.25, bevelEnabled: false });
  starGeo.translate(0, 0, -0.125);
  const starMat = new THREE.MeshBasicMaterial({ color: 0xffd34a, toneMapped: false });
  const top = tierInfo[tiers - 1]!;
  for (const ry of [0, Math.PI / 2]) {
    const s = new THREE.Mesh(starGeo, starMat);
    s.position.y = top.y + top.h + 0.9;
    s.rotation.y = ry;
    g.add(s);
  }

  // baubles on each tier's skirt
  const baubleGeo = new THREE.SphereGeometry(1, 12, 8);
  const baubleCols = [0xd61f2c, 0xf2c230, 0x2a6fd6, 0xe8e8f0];
  baubleCols.forEach((col, k) => {
    const mats: THREE.Matrix4[] = [];
    for (const t of tierInfo) {
      const n = Math.round(t.r * 2.2);
      for (let i = 0; i < n; i++) {
        if (i % baubleCols.length !== k) continue;
        const a = (i / n) * TAU + t.y;
        const along = 0.15 + R() * 0.25; // fraction up the tier
        const rr = t.r * (1 - along) + 0.12;
        const s = 0.22 + R() * 0.1;
        mats.push(new THREE.Matrix4().makeScale(s, s, s).setPosition(Math.cos(a) * rr, t.y + t.h * along, Math.sin(a) * rr));
      }
    }
    const mesh = new THREE.InstancedMesh(baubleGeo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.25, metalness: 0.5 }), mats.length);
    mats.forEach((m, i) => mesh.setMatrixAt(i, m));
    g.add(mesh);
  });

  // a spiral of bulbs wound up the tree
  const turns = 6;
  const n = 150;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    const y = 2.4 + f * (TREE_H - 3.6);
    // the silhouette radius at this height: the tier whose span covers it
    let r = 0.3;
    for (const t of tierInfo) if (y >= t.y && y <= t.y + t.h) r = Math.max(r, t.r * (1 - (y - t.y) / t.h));
    const a = f * turns * TAU;
    bulbs.add(x + Math.cos(a) * (r + 0.12), y0 + y, z + Math.sin(a) * (r + 0.12), i, 0.13);
  }

  // presents round the foot
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const wrap = [0xc81d25, 0x1f7a3a, 0x2b59c3, 0xf0c419, 0x8e2fbf];
  const ribbon = new THREE.MeshStandardMaterial({ color: 0xf6f0e0, roughness: 0.5 });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + 0.3;
    const d = TREE_R * 0.75 + R() * 1.4;
    const w = 0.8 + R() * 0.9, h = 0.6 + R() * 0.9, dd = 0.8 + R() * 0.9;
    const box = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ color: wrap[i % wrap.length], roughness: 0.6 }));
    box.scale.set(w, h, dd);
    box.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
    box.rotation.y = R() * TAU;
    const rib = new THREE.Mesh(boxGeo, ribbon);
    rib.scale.set(1.02, 1.02, 0.16);
    box.add(rib);
    const rib2 = new THREE.Mesh(boxGeo, ribbon);
    rib2.scale.set(0.16, 1.02, 1.02);
    box.add(rib2);
    g.add(box);
  }
  return g;
}

/** Sagging bulb strings along the top of every perimeter `wall` solid. */
function wallLights(map: MapDef, bulbs: Bulbs): void {
  let k = 0;
  for (const o of map.solids) {
    if (o.visual !== "wall") continue;
    const long = o.sx >= o.sz;
    const L = long ? o.sx : o.sz;
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    // along the wall's long axis (shared/map.ts OBB yaw convention: local +x -> (c, s), +z -> (-s, c))
    const ux = long ? c : -s, uz = long ? s : c;
    const top = o.y + o.sy / 2;
    // hung on the YARD face: across the wall, toward the map's centre, just off the boards
    const cx = (map.bounds.minX + map.bounds.maxX) / 2, cz = (map.bounds.minZ + map.bounds.maxZ) / 2;
    let nx = -uz, nz = ux;
    if (nx * (cx - o.x) + nz * (cz - o.z) < 0) (nx = -nx), (nz = -nz);
    const off = (long ? o.sz : o.sx) / 2 + 0.07;
    const span = 2.4;
    const bays = Math.max(1, Math.round(L / span));
    const per = 7;
    for (let b = 0; b < bays; b++) {
      for (let i = 0; i < per; i++) {
        const f = (b + (i + 0.5) / per) / bays;
        const sag = Math.sin(((i + 0.5) / per) * Math.PI) * 0.32;
        const t = (f - 0.5) * L;
        bulbs.add(o.x + ux * t + nx * off, top - 0.04 - sag, o.z + uz * t + nz * off, k++, 0.07);
      }
    }
  }
}

export function buildXmas(map: MapDef): THREE.Group {
  const root = new THREE.Group();
  root.name = "xmas";
  const bulbs = new Bulbs([0xff3b30, 0xffd24a, 0x4ab3ff]);
  const b = map.bounds;
  // off the map's (+x, +z) corner, clear of the bounds on both axes: a corner
  // reads from two sides of the yard and keeps it out from behind a centred
  // landmark (Shipment's billboard stands dead centre on the +z side)
  const x = b.maxX + TREE_R * 0.6 + 3;
  const z = b.maxZ + TREE_R * 0.6 + 3;
  root.add(buildTree(x, z, map.floorY, bulbs));
  wallLights(map, bulbs);
  root.add(bulbs.build());
  root.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });
  return root;
}
