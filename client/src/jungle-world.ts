import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CH, HALF, RENDER_YAW, VISUAL_CONTAINERS, SOLIDS, YARD, type VisualContainer } from "@shared/map";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { softwareSky } from "./software-sky";
import { assetUrl } from "./asset-base";
import { pmremEnv, type AnyRenderer } from "./gpu-backend";
import { aaSamples, isSoftwareGL, metalMat, polyMat } from "./textures";
import {
  jungleDirtTex,
  jungleFloorTex,
  containerSideTex,
  containerEndTex,
  containerEndAltTex,
  containerInteriorTex,
  plankTex,
  ceilingTex,
  fenceTex,
  leafTex,
  vineTex,
  barkTex,
  crateTex,
  crateLidTex,
  trimTex,
  forkliftDecalTex,
  canopySkyTex,
  treeCardTex,
  yardOverlayTex,
  billboardFaceTex,
} from "./jungle-textures";
import type { WorldApi } from "./world";

/** Jungle Shipment: same layout/collision as world.ts, tropical cargo-yard art. */

const PAINT: Record<string, string> = {
  red: "#a04434",
  blue: "#3a7a80",
  orange: "#c8a030",
  green: "#4a7040",
};

type Sway = { obj: THREE.Object3D; base: number; amp: number; speed: number; phase: number; axis: "x" | "z" };

export async function buildJungleWorld(renderer: AnyRenderer): Promise<WorldApi> {
  statementLowDetail = isSoftwareGL(renderer);
  castingSpots.length = 0;
  // What this renderer can afford, asked once (see textures.ts): `cutoutAA` is
  // the composer's MSAA level, which is also the only thing that makes
  // `alphaToCoverage` on the foliage mean anything, and a software rasteriser
  // pays for the sun's shadow map by the texel on the CPU. Losing
  // alphaToCoverage does NOT leave that tier with jagged foliage: Game.init()
  // gives it an FXAA pass instead, which smooths the cutout silhouettes in the
  // finished image (measured on the SwiftShader palm crop).
  //
  // THREAD THIS TO EVERY alphaTest MATERIAL, no exceptions. MSAA antialiases
  // geometry edges; a cutout silhouette is a per-fragment discard it cannot
  // see. The six sites are buildContainerMats (vines), addPalms, addUnderstory,
  // addCanopyCards (near + far), addHedgeRing. The canopy and hedge are the
  // horizon of nearly every outdoor frame, so they matter most, not least —
  // they once shipped without the flag and staircased the entire skyline.
  const cutoutAA = aaSamples(renderer) > 0;
  const softGL = isSoftwareGL(renderer);
  const scene = new THREE.Scene();
  // Pale CANOPY green, not near-white: gaps between backdrop layers must read
  // as leafy haze rather than torn white cards (review r5).
  scene.fog = new THREE.Fog(0xb6c6a0, 24, 78);
  const sky = canopySkyTex();
  scene.background = sky;

  if (softGL) softwareSky(scene);
  else try {
    scene.environment = await pmremEnv(renderer, scene, 0.04);
  } catch {
    scene.environment = null;
  }

  // Lower fill so the sun actually reads (shadows were washed out before).
  const hemi = new THREE.HemisphereLight(0xf2ecd8, 0x66754f, 1.08);
  scene.add(hemi);
  const bounce = new THREE.DirectionalLight(0xcfe0b0, 0.35);
  bounce.position.set(-14, 8, -10);
  scene.add(bounce);
  const sun = new THREE.DirectionalLight(0xfff2d0, 2.0);
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(132));
  sun.position.copy(sunPos).multiplyScalar(42);
  sun.castShadow = true;
  // 4096 over the same 56 m shadow frustum halves the texel to 13.7 mm, which is
  // what turns a container's cast edge and a frond's shadow from a soft ramp
  // into a drawn line. The frustum stays at +/-28 m: it has to hold the outer
  // palm ring whose shadows fall INTO the yard, and cropping it would pop
  // shadows in and out at the fence. MEASURED cost at DPR 1: within noise
  // (2048 -> 4096 moved p50 by +0.10 ms and p95 by -0.10 ms across 3 reps) —
  // the sun pass is bound by the geometry it re-draws, not by map area. On a
  // software rasteriser it is bound by texels instead (+180 ms/frame measured),
  // so those clients keep 2048.
  sun.shadow.mapSize.set(softGL ? 2048 : 4096, softGL ? 2048 : 4096);
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 90;
  sun.shadow.camera.left = -28;
  sun.shadow.camera.right = 28;
  sun.shadow.camera.top = 28;
  sun.shadow.camera.bottom = -28;
  sun.shadow.bias = -0.00022;
  sun.shadow.normalBias = 0.035;
  // authored 3.1, effective 1.6 at runtime via Game.clampShadowRadii
  // (r187's 5-tap PCF disk reads wider as grain).
  sun.shadow.radius = 3.1;
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xc8c4a8, 0.52));

  const root = new THREE.Group();
  scene.add(root);
  const sways: Sway[] = [];

  // ---- ground: dirt yard over a darker jungle floor that runs to the fog ----
  const floorTex = jungleFloorTex();
  floorTex.repeat.set(18, 18);
  const jungleFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(150, 150),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1, metalness: 0, color: 0xc4cdaa, emissive: 0x121608, emissiveIntensity: 0.5 }),
  );
  jungleFloor.rotation.x = -Math.PI / 2;
  jungleFloor.position.y = -0.02;
  jungleFloor.receiveShadow = true;
  root.add(jungleFloor);

  const dirt = jungleDirtTex();
  dirt.repeat.set(9, 9);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(YARD + 7, YARD + 7),
    new THREE.MeshStandardMaterial({ map: dirt, roughness: 0.95, metalness: 0.02, color: 0xcfc4a8 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  // single decal overlay: paths + ruts + stains + litter (one draw call)
  const overlay = new THREE.Mesh(
    new THREE.PlaneGeometry(41, 41),
    new THREE.MeshStandardMaterial({
      map: yardOverlayTex(),
      transparent: true,
      roughness: 1,
      metalness: 0,
      depthWrite: false,
    }),
  );
  overlay.rotation.x = -Math.PI / 2;
  overlay.position.y = 0.015;
  overlay.receiveShadow = true;
  // ZERO-FLICKER: blended ground layers draw in a FIXED order (overlay first,
  // then the contact discs at 1) — distance sorting flips them as you walk.
  overlay.renderOrder = -1;
  root.add(overlay);

  // ---- containers (same layout as world.ts, mossy skins) ----
  const mats = buildContainerMats(cutoutAA);
  const castingGeos: THREE.BufferGeometry[] = [];
  const usedSerials = new Set<number>();
  let unit = 0;
  for (const c of VISUAL_CONTAINERS) {
    unit++;
    // The two angled walkthrough shells overlap their straight partners in the
    // source layout. Render them as same-color, mud-sunken derelicts (slight
    // drop + tilt) so the contact reads as one crashed structure, and their
    // roofs pass below the partner roof plane (no coplanar wedge fighting).
    const isWreck = c.open && Math.abs(c.yaw) > 0.3;
    const cc = isWreck ? { ...c, color: c.x > 0 ? "red" : "green" } : c;
    const g = buildContainer(cc, mats, sways, unit, castingGeos, usedSerials);
    if (isWreck) {
      // Sink is now only a z-fight break against the partner roof (1.2 cm). At
      // -0.24 the top 24 cm of the wall collider stood over empty air, and the
      // 0.04 rad lean pushed the wall 8 cm out of its own collider band and
      // through the perimeter-fence probe (collider-audit VIS>COL 1-3, COL>VIS 1-4).
      g.position.y = -0.012;
    }
    root.add(g);
  }
  // all ISO corner castings merged into one mesh
  if (castingGeos.length) {
    const castings = new THREE.Mesh(mergeGeometries(castingGeos), mats.frame);
    castings.castShadow = true;
    root.add(castings);
    for (const g of castingGeos) g.dispose();
  }

  // Props whose visual is an authored statement mesh are placed once by
  // addStatementProps, never per-box (the pickup owns three colliders).
  for (const o of SOLIDS) {
    if (o.glb) continue;
    if (o.visual === "crate") root.add(makeBananaCrate(o.x, o.y, o.z, o.sx, o.sy, o.sz, o.yaw));
    if (o.visual === "barrel") root.add(makeBarrel(o.x, o.z));
    if (o.visual === "dumpster") root.add(makeDumpster(o.x, o.z, o.yaw));
    if (o.visual === "forklift" && o.sy > 1) root.add(makeForklift(o.x, o.z, o.yaw));
    if (o.visual === "wall") {
      const fence = fenceTex();
      // ZERO-FLICKER: the four perimeter walls overlap at the corners with equal
      // tops; the z-running pair stands 6 mm lower so the corner caps never fight.
      const drop = o.sx < o.sz ? 0.006 : 0;
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(o.sx, o.sy - drop, o.sz),
        new THREE.MeshStandardMaterial({ map: fence, roughness: 0.85, metalness: 0.12 }),
      );
      wall.position.set(o.x, o.y - drop / 2, o.z);
      wall.castShadow = wall.receiveShadow = true;
      root.add(wall);
    }
  }

  addLandmarks(root, sways);
  // after addLandmarks: the two shard groups must claim the wreck-junk landmark
  // anchors first, so these packs fall through to their own colliders.
  addSeamPacks(root);

  // ---- statement meshes (authored, meshopt-compressed) ----
  const statementProps = addStatementProps(root);

  // ---- jungle perimeter ----
  const leafT = leafTex();
  addPalms(root, leafT, cutoutAA);
  addUnderstory(root, leafT, sways, cutoutAA);
  await Promise.all([statementProps, addHeroPalms(root), addBillboard(root), addBamboo(root)]);
  addCanopyCards(root, cutoutAA);
  addHedgeRing(root, cutoutAA);
  addGodRays(root);

  // ---- drifting leaves ----
  const drift = addDriftingLeaves(root);

  // ---- static prop merge ----
  // Bake repeated single-color primitive props (palm trunk capsules, bananas,
  // coconuts, bunch stems) into one mesh per material. Anything under a sway
  // pivot animates and must stay live.
  const swayObjs = new Set<THREE.Object3D>(sways.map((s) => s.obj));
  root.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const mergeBins = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (Array.isArray(m.material) || mat.map || mat.transparent) return;
    const gt = m.geometry.type;
    if (gt !== "CapsuleGeometry" && gt !== "TubeGeometry" && gt !== "SphereGeometry" && gt !== "CylinderGeometry") return;
    for (let a: THREE.Object3D | null = m; a; a = a.parent) if (swayObjs.has(a)) return;
    let bin = mergeBins.get(mat);
    if (!bin) mergeBins.set(mat, (bin = { geos: [], meshes: [] }));
    bin.geos.push(m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld)));
    bin.meshes.push(m);
  });
  for (const [mat, bin] of mergeBins) {
    if (bin.meshes.length < 6) {
      for (const geo of bin.geos) geo.dispose();
      continue;
    }
    const merged = new THREE.Mesh(mergeGeometries(bin.geos), mat);
    merged.castShadow = merged.receiveShadow = true;
    root.add(merged);
    for (const m of bin.meshes) m.removeFromParent();
    for (const geo of bin.geos) geo.dispose();
  }

  let t = 0;
  return {
    scene,
    sun,
    root,
    update: (dt) => {
      t += dt;
      for (const s of sways) {
        s.obj.rotation[s.axis] = s.base + Math.sin(t * s.speed + s.phase) * s.amp;
      }
      const pos = drift.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) - dt * (0.14 + (i % 4) * 0.05);
        if (y < 3.1) y = 5.4 + (i % 3);
        pos.setY(i, y);
        pos.setX(i, pos.getX(i) + Math.sin(t * 0.6 + i * 1.7) * dt * 0.35);
      }
      pos.needsUpdate = true;
    },
  };
}

type ColorMats = {
  side: THREE.MeshStandardMaterial[];
  interior: THREE.MeshStandardMaterial;
};

type MatBag = {
  colors: Record<string, ColorMats>;
  frame: THREE.MeshStandardMaterial;
  plank: THREE.MeshStandardMaterial;
  ceiling: THREE.MeshStandardMaterial;
  vine: THREE.MeshStandardMaterial[];
};

function buildContainerMats(cutoutAA: boolean): MatBag {
  const colors: Record<string, ColorMats> = {};
  for (const [k, hex] of Object.entries(PAINT)) {
    const side: THREE.MeshStandardMaterial[] = [];
    for (let v = 0; v < 3; v++) {
      side.push(
        new THREE.MeshStandardMaterial({
          map: containerSideTex(hex, 101 + v * 37 + k.length * 7, 0.25 + v * 0.28),
          roughness: 0.74,
          metalness: 0.16,
        }),
      );
    }
    colors[k] = {
      side,
      interior: new THREE.MeshStandardMaterial({
        map: containerInteriorTex(hex),
        roughness: 0.92,
        metalness: 0.06,
        emissive: 0x6a5a44,
        emissiveIntensity: 0.34,
      }),
    };
  }
  const vine = [0, 1, 2].map(
    (v) =>
      new THREE.MeshStandardMaterial({
        map: vineTex(v),
        alphaTest: 0.4,
        // Vines hang over container lips at duel range — cutout AA (see palms).
        alphaToCoverage: cutoutAA,
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
      }),
  );
  return {
    colors,
    frame: sharedTrimMat(),
    plank: new THREE.MeshStandardMaterial({ map: plankTex(), roughness: 0.95, metalness: 0, emissive: 0x2c2418, emissiveIntensity: 0.3 }),
    ceiling: new THREE.MeshStandardMaterial({
      map: ceilingTex(),
      roughness: 0.95,
      metalness: 0.04,
      emissive: 0x342a1e,
      emissiveIntensity: 0.42,
    }),
    vine,
  };
}

function addVine(parent: THREE.Object3D, mats: MatBag, x: number, y: number, z: number, len: number, variant: number, sways: Sway[]): void {
  const geo = new THREE.PlaneGeometry(0.42, len);
  geo.translate(0, -len / 2, 0); // pivot at the top anchor
  const v = new THREE.Mesh(geo, mats.vine[variant % mats.vine.length]!);
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  pivot.add(v);
  parent.add(pivot);
  sways.push({ obj: pivot, base: 0, amp: 0.03 + Math.random() * 0.035, speed: 0.7 + Math.random() * 0.5, phase: Math.random() * 6.3, axis: "z" });
}

function seededOf(c: VisualContainer): number {
  return Math.abs(Math.sin(c.x * 12.9 + c.z * 7.1));
}

/** Position-hashed serial, linear-probed unique across the yard so no two
 *  containers can ever share an ID (review r5: verbatim "Y-17" repeats). */
function serialFor(c: VisualContainer, used: Set<number>): number {
  let s = (Math.abs(Math.round(c.x * 7.3) * 31 + Math.round(c.z * 5.1) * 47) % 88) + 11;
  while (used.has(s)) s = ((s + 13) % 88) + 11;
  used.add(s);
  return s;
}

/** World positions of the ISO corner castings already placed (one per spot). */
const castingSpots: THREE.Vector3[] = [];

function buildContainer(
  c: VisualContainer,
  mats: MatBag,
  sways: Sway[],
  unit: number,
  castingGeos: THREE.BufferGeometry[],
  usedSerials: Set<number>,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(c.x, 0, c.z);
  g.rotation.y = RENDER_YAW(c.yaw);
  const sx = c.sx;
  const sz = c.sz;
  const h = CH;
  const seed = seededOf(c);
  const cm = mats.colors[c.color]!;
  const side = cm.side[unit % cm.side.length]!;
  const thick = 0.14;
  const longAxisX = sx > sz; // ends sit on the short faces

  if (!c.open) {
    const hull = new THREE.Mesh(new THREE.BoxGeometry(sx, h, sz), side);
    hull.position.y = h * 0.5;
    hull.castShadow = hull.receiveShadow = true;
    g.add(hull);
  } else {
    const left = new THREE.Mesh(new THREE.BoxGeometry(thick, h, sz), side);
    left.position.set(-sx * 0.5 + thick * 0.5, h * 0.5, 0);
    left.castShadow = left.receiveShadow = true;
    g.add(left);
    const right = left.clone();
    right.position.x = sx * 0.5 - thick * 0.5;
    g.add(right);
    // interior lining
    const linL = new THREE.Mesh(new THREE.PlaneGeometry(sz - 0.24, h - 0.22), cm.interior);
    linL.rotation.y = Math.PI / 2;
    // lining sits 1 cm proud of the wall skin, not 5: at +0.05 the surface the
    // player can see stood 4 cm inside the wall collider, so the collider could
    // never cover it and every neighbouring probe read it as loose mesh.
    linL.position.set(-sx * 0.5 + thick + 0.01, h * 0.5 - 0.02, 0);
    g.add(linL);
    const linR = linL.clone();
    linR.rotation.y = -Math.PI / 2;
    linR.position.x = sx * 0.5 - thick - 0.01;
    g.add(linR);
    // ZERO-FLICKER: the floor ends 2.5 cm in from the shell, not 2 — at 2 its
    // end faces lay exactly in the door jambs' front faces and z-fought them.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(sx - 0.04, 0.14, sz - 0.05), mats.plank);
    floor.position.y = 0.07;
    floor.receiveShadow = true;
    g.add(floor);
    // Upright shells bake their door frames into the global frame merge (one
    // draw call). Wrecks get post-hoc group sink/tilt, so they keep live meshes.
    const mergeFrame = Math.abs(c.yaw) <= 0.3;
    const fq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, RENDER_YAW(c.yaw), 0));
    const fm4 = new THREE.Matrix4();
    const frameBox = (bw: number, bh: number, bd: number, lx: number, ly: number, lz: number) => {
      if (mergeFrame) {
        const geo = new THREE.BoxGeometry(bw, bh, bd);
        const local = new THREE.Vector3(lx, ly, lz).applyQuaternion(fq);
        fm4.compose(new THREE.Vector3(c.x + local.x, local.y, c.z + local.z), fq, new THREE.Vector3(1, 1, 1));
        geo.applyMatrix4(fm4);
        castingGeos.push(geo);
      } else {
        const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mats.frame);
        m.position.set(lx, ly, lz);
        m.castShadow = true;
        g.add(m);
      }
    };
    for (const sign of [-1, 1]) {
      // jambs pulled 12 cm in from the shell end: at 0.05 the 0.2-deep post
      // overhung the wall collider by 5 cm and read as loose mesh to its neighbour
      for (const x of [-sx * 0.5 + 0.07, sx * 0.5 - 0.07]) frameBox(0.2, h - 0.1, 0.2, x, (h - 0.1) * 0.5, sign * (sz * 0.5 - 0.12));
      // header lifted to h-0.18 so its top face lands inside the roof collider;
      // at h-0.24 it peaked 3 cm below it and read as loose mesh from outside
      // ZERO-FLICKER: 1 cm shallower than the 0.2 jambs, so where they overlap
      // the jamb's faces are in front instead of coplanar with the header's.
      frameBox(sx, 0.16, 0.19, 0, h - 0.18, sign * (sz * 0.5 - 0.12));
    }
  }

  // roof: caps the wall/skin tops with real overlap — no edge-butt gaps.
  // Open shells get a dark ceiling underside so the roof never reads as a
  // floating bright slab when seen from below.
  const roofMats = c.open ? [side, side, side, mats.ceiling, side, side] : side;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.05, 0.16, sz + 0.05), roofMats);
  roof.position.set(0, h - 0.05, 0);
  roof.castShadow = roof.receiveShadow = true;
  g.add(roof);

  // corrugated skins on the two LONG faces
  // 0.022 amplitude at a 6mm standoff: the old 0.045/0.012 pair pushed the rib
  // crests 5.7 cm outside the hull collider, which read as protruding mesh.
  const skin = (w: number, hh: number, ribs: number) => corrugated(w, hh, ribs, 0.022);
  if (longAxisX) {
    const pz = new THREE.Mesh(skin(sx, h - 0.06, Math.max(10, Math.round(sx * 3))), side);
    pz.position.set(0, (h - 0.06) * 0.5, sz * 0.5 + 0.006);
    pz.castShadow = true;
    g.add(pz);
    const nz = pz.clone();
    nz.rotation.y = Math.PI;
    nz.position.z = -sz * 0.5 - 0.006;
    g.add(nz);
  } else {
    const px = new THREE.Mesh(skin(sz, h - 0.06, Math.max(10, Math.round(sz * 3))), side);
    px.rotation.y = Math.PI / 2;
    px.position.set(sx * 0.5 + 0.006, (h - 0.06) * 0.5, 0);
    px.castShadow = true;
    g.add(px);
    const nx = px.clone();
    nx.rotation.y = -Math.PI / 2;
    nx.position.x = -sx * 0.5 - 0.006;
    g.add(nx);
  }

  // fitted end decals with the stencil — closed containers only (open ends are
  // doors). Each container gets its OWN texture with a yard-unique serial;
  // stencil jitter rides the position seed inside the paint functions.
  if (!c.open) {
    const hex = PAINT[c.color]!;
    const serial = serialFor(c, usedSerials);
    const prefix = seed > 0.72 ? "B" : "Y";
    const endM = new THREE.MeshStandardMaterial({
      map:
        unit % 2
          ? containerEndTex(hex, 501 + Math.round(seed * 997), serial, prefix)
          : containerEndAltTex(hex, 731 + Math.round(seed * 883), serial, prefix),
      roughness: 0.76,
      metalness: 0.14,
    });
    const endW = longAxisX ? sz : sx;
    if (longAxisX) {
      const eP = new THREE.Mesh(new THREE.PlaneGeometry(endW - 0.06, h - 0.1), endM);
      eP.rotation.y = Math.PI / 2;
      eP.position.set(sx * 0.5 + 0.014, h * 0.5, 0);
      g.add(eP);
      const eN = eP.clone();
      eN.rotation.y = -Math.PI / 2;
      eN.position.x = -sx * 0.5 - 0.014;
      g.add(eN);
    } else {
      const eP = new THREE.Mesh(new THREE.PlaneGeometry(endW - 0.06, h - 0.1), endM);
      eP.position.set(0, h * 0.5, sz * 0.5 + 0.014);
      g.add(eP);
      const eN = eP.clone();
      eN.rotation.y = Math.PI;
      eN.position.z = -sz * 0.5 - 0.014;
      g.add(eN);
    }
  }

  // ISO corner castings (merged globally; skipped inside open walkthroughs)
  if (!c.open) {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, RENDER_YAW(c.yaw), 0));
    for (const ix of [-1, 1])
      for (const iz of [-1, 1])
        for (const y of [0.1, h - 0.1]) {
          const local = new THREE.Vector3(ix * (sx * 0.5 - 0.04), y, iz * (sz * 0.5 - 0.04));
          local.applyQuaternion(q);
          // ZERO-FLICKER: containers parked shoulder to shoulder put two castings
          // in one spot, overlapping with coplanar faces; one casting serves both.
          const wx = c.x + local.x, wz = c.z + local.z;
          if (castingSpots.some((p) => Math.abs(p.x - wx) < 0.17 && Math.abs(p.z - wz) < 0.17 && Math.abs(p.y - local.y) < 0.17)) continue;
          castingSpots.push(new THREE.Vector3(wx, local.y, wz));
          const geo = new THREE.BoxGeometry(0.17, 0.17, 0.17);
          m4.compose(new THREE.Vector3(c.x + local.x, local.y, c.z + local.z), q, new THREE.Vector3(1, 1, 1));
          geo.applyMatrix4(m4);
          castingGeos.push(geo);
        }
  }

  // hanging vines over the roof lip — long faces only, never across end decals
  if (seed > 0.3) {
    const n = 1 + Math.floor(seed * 3);
    const face = seed > 0.65 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const along = (((i + 0.5) / n) - 0.5) * ((longAxisX ? sx : sz) - 0.8) + (seed - 0.5) * 0.6;
      const len = Math.min(h - 0.7, 0.7 + seed * 1.1 + i * 0.2);
      if (longAxisX) addVine(g, matsRef(mats), along, h - 0.02, face * (sz * 0.5 + 0.05), len, unit + i, sways);
      else addVine(g, matsRef(mats), face * (sx * 0.5 + 0.05), h - 0.02, along, len, unit + i, sways);
    }
  }
  return g;
}

function matsRef(m: MatBag): MatBag {
  return m;
}

function corrugated(w: number, h: number, ribs: number, amp = 0.032): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(w, h, Math.max(10, ribs * 2), 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, Math.sin(((x / w) * 0.5 + 0.5) * Math.PI * ribs * 2) * amp);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------- props ----------

const BANANA_MAT = new THREE.MeshStandardMaterial({ color: 0xe8c445, roughness: 0.55, metalness: 0.04 });
let bananaGeoShared: THREE.BufferGeometry | null = null;
let crateTexShared: THREE.CanvasTexture | null = null;

let crateSideMatShared: THREE.MeshStandardMaterial | null = null;

function sharedCrateMat(): THREE.MeshStandardMaterial {
  if (!crateTexShared) crateTexShared = crateTex();
  if (!crateSideMatShared)
    crateSideMatShared = new THREE.MeshStandardMaterial({ map: crateTexShared, roughness: 0.85, metalness: 0.02, color: 0xc2b294 });
  return crateSideMatShared;
}

let crateTopMatShared: THREE.MeshStandardMaterial | null = null;

function crateTopMat(): THREE.MeshStandardMaterial {
  if (!crateTopMatShared)
    crateTopMatShared = new THREE.MeshStandardMaterial({ map: crateLidTex(), color: 0xc2b294, roughness: 0.9, metalness: 0.02 });
  return crateTopMatShared;
}

let trimMatShared: THREE.MeshStandardMaterial | null = null;

/** One galvanized trim material for jambs, castings, caps, lids, guards. */
function sharedTrimMat(): THREE.MeshStandardMaterial {
  if (!trimMatShared)
    trimMatShared = new THREE.MeshStandardMaterial({ map: trimTex(), color: 0x8f8874, roughness: 0.64, metalness: 0.22 });
  return trimMatShared;
}

function crateBox(sx: number, sy: number, sz: number): THREE.Mesh {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  // collapse the 6 per-face groups into 3 draw groups: sides / lit top / rest
  geo.clearGroups();
  geo.addGroup(0, 12, 0);
  geo.addGroup(12, 6, 1);
  geo.addGroup(18, 18, 0);
  return new THREE.Mesh(geo, [sharedCrateMat(), crateTopMat()]);
}

function bananaGeo(): THREE.BufferGeometry {
  if (bananaGeoShared) return bananaGeoShared;
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.09, 0, 0),
    new THREE.Vector3(0, 0.07, 0),
    new THREE.Vector3(0.09, 0, 0),
  );
  bananaGeoShared = new THREE.TubeGeometry(curve, 6, 0.022, 6, false);
  return bananaGeoShared;
}

function makeBananaCrate(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = RENDER_YAW(yaw);
  const box = crateBox(sx, sy, sz);
  box.position.y = y;
  box.castShadow = box.receiveShadow = true;
  g.add(box);
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(bananaGeo(), BANANA_MAT);
    b.position.set((i - 1.5) * 0.07, y + sy * 0.5 + 0.03, (i % 2) * 0.05 - 0.02);
    b.rotation.y = i * 0.7;
    b.castShadow = true;
    g.add(b);
  }
  return g;
}

function makeBarrel(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a6234, roughness: 0.66, metalness: 0.22 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.88, 18), mat);
  body.position.set(x, 0.44, z);
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.025, 8, 18), new THREE.MeshStandardMaterial({ color: 0x50442e, roughness: 0.6, metalness: 0.25 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(x, 0.82, z);
  g.add(rim);
  const moss = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0x4a6a34, roughness: 1 }),
  );
  // Kept inside the 0.62 m barrel collider: at +0.12 the moss cap poked past it.
  moss.scale.set(1.2, 0.4, 1.1);
  moss.position.set(x + 0.06, 0.9, z - 0.04);
  g.add(moss);
  return g;
}

function makeDumpster(x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = RENDER_YAW(yaw);
  // banana shipping chest: crate wood body (stencilled) + galvanized lid.
  // Total height 0.84 m, deliberately BELOW standing chest height (0.90 m): the
  // chest is climbable, so the sim lets you walk into the 0.18 m band between
  // its footprint and the mantle lift — anything it shows at 0.90 m there goes
  // through your torso. See the matching note in shared/map.ts.
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.78, 1.05), sharedCrateMat());
  body.position.y = 0.39;
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  // lid sits flush on the body (no dark gap band)
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.06, 1.08), sharedTrimMat());
  lid.position.y = 0.81;
  lid.castShadow = lid.receiveShadow = true;
  g.add(lid);
  // Contact disc kept inside the chest's own footprint: at r=1.25 it reached
  // 0.85 m past the collider and every cell it touched read as a ghost cell.
  const ao = new THREE.Mesh(
    new THREE.CircleGeometry(0.78, 20),
    new THREE.MeshBasicMaterial({ color: 0x241c12, transparent: true, opacity: 0.26, depthWrite: false }),
  );
  ao.rotation.x = -Math.PI / 2;
  ao.renderOrder = 1; // after the yard overlay (ZERO-FLICKER)
  ao.position.y = 0.02;
  g.add(ao);
  return g;
}

let forkliftPaintShared: THREE.MeshStandardMaterial | null = null;

/** Finished yard forklift: weathered banana-yellow paint, wheels on the ground,
 *  mast joined to the chassis, forks on a carriage, brand decal, moss tuft. */
function makeForklift(x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = RENDER_YAW(yaw);
  if (!forkliftPaintShared)
    forkliftPaintShared = new THREE.MeshStandardMaterial({
      map: containerSideTex("#b08c2c", 4402, 0.2),
      roughness: 0.6,
      metalness: 0.2,
    });
  const yel = forkliftPaintShared;
  // one merged mesh per material so the whole vehicle costs ~6 draws
  const yelGeos: THREE.BufferGeometry[] = [];
  const trimGeos: THREE.BufferGeometry[] = [];
  const tireGeos: THREE.BufferGeometry[] = [];
  const hubGeos: THREE.BufferGeometry[] = [];
  const box = (into: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (rx) geo.rotateX(rx);
    geo.translate(x, y, z);
    into.push(geo);
  };
  // Chassis + a full-height rear counterweight + dash. Every solid here is
  // sized so the 1.16 x 1.90 x 1.80 collider box actually has mesh behind each
  // of its faces — the old open-lattice build left five faces probing air.
  // ZERO-FLICKER: chassis 1 cm narrower than the 1.06 rear block — equal widths
  // put both side faces in one plane where the boxes overlap.
  box(yelGeos, 1.05, 0.65, 1.6, 0, 0.425, -0.02);
  box(yelGeos, 1.06, 1.05, 0.52, 0, 0.525, 0.68);
  box(yelGeos, 0.7, 0.3, 0.16, 0, 0.9, -0.32);
  // seat (dark)
  box(tireGeos, 0.42, 0.3, 0.36, 0, 0.9, 0.28);
  // overhead guard: 4 posts + a roof that spans the whole cab, + rear screen
  for (const [px, pz] of [
    [-0.5, -0.42],
    [0.5, -0.42],
    [-0.5, 0.52],
    [0.5, 0.52],
  ] as [number, number][])
    box(trimGeos, 0.07, 1.06, 0.07, px, 1.28, pz);
  box(trimGeos, 1.14, 0.06, 1.52, 0, 1.84, 0.02);
  // ZERO-FLICKER: rear screen and side panels top out 5 mm under the roof's top
  // face (coplanar before), and the panels sit 6 mm inside the yellow body's
  // side faces where they overlap it (coplanar before).
  box(trimGeos, 1.0, 0.89, 0.06, 0, 1.415, 0.85);
  // side weather panels: without them the cab is an open lattice and half the
  // collider box faces probe straight through it
  for (const sx2 of [-0.494, 0.494]) box(trimGeos, 0.06, 0.96, 1.53, sx2, 1.38, 0.02);
  // mast: two uprights JOINED to the chassis nose, two wide crossbars
  for (const mx of [-0.34, 0.34]) box(trimGeos, 0.1, 1.92, 0.12, mx, 0.96, -0.8, -0.05);
  for (const my of [1.3, 1.75]) box(trimGeos, 0.86, 0.12, 0.09, 0, my, -0.8 + (0.96 - my) * 0.05);
  // load backrest + forks skimming the ground
  box(trimGeos, 0.86, 0.9, 0.07, 0, 0.6, -0.865);
  for (const fx of [-0.2, 0.2]) box(trimGeos, 0.16, 0.05, 1.0, fx, 0.065, -1.36);
  // wheels flat on the ground plane + pale hub caps
  for (const [wx, wz, r] of [
    [-0.56, -0.42, 0.27],
    [0.56, -0.42, 0.27],
    [-0.56, 0.6, 0.22],
    [0.56, 0.6, 0.22],
  ] as [number, number, number][]) {
    const t = new THREE.CylinderGeometry(r, r, 0.17, 14);
    t.rotateZ(Math.PI / 2);
    t.translate(wx, r, wz);
    tireGeos.push(t);
    const hub = new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.18, 10);
    hub.rotateZ(Math.PI / 2);
    hub.translate(wx, r, wz);
    hubGeos.push(hub);
  }
  const parts: [THREE.BufferGeometry[], THREE.Material][] = [
    [yelGeos, yel],
    [trimGeos, sharedTrimMat()],
    [tireGeos, new THREE.MeshStandardMaterial({ color: 0x3d3a32, roughness: 0.94, metalness: 0.02 })],
    [hubGeos, new THREE.MeshStandardMaterial({ color: 0x9a9078, roughness: 0.55, metalness: 0.3 })],
  ];
  for (const [geos, mat] of parts) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    for (const geo of geos) geo.dispose();
  }
  // brand decal on the counterweight tail
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.31),
    new THREE.MeshStandardMaterial({ map: forkliftDecalTex(), transparent: true, roughness: 0.7, metalness: 0.1 }),
  );
  decal.rotation.y = Math.PI;
  decal.position.set(0, 0.62, 0.947);
  g.add(decal);
  // jungle wear: moss tuft on the roof
  const moss = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0x4a6a34, roughness: 1 }),
  );
  moss.scale.set(1.5, 0.4, 1.1);
  moss.position.set(0.3, 1.9, 0.3);
  g.add(moss);
  return g;
}

// ---------- statement meshes (authored, EXT_meshopt_compression) ----------

let statementLoader: GLTFLoader | null = null;
let statementLowDetail = false;
const statementCache = new Map<string, Promise<THREE.Mesh>>();

/** Load one statement GLB and hand back a single mesh whose geometry is baked
 *  into world units: horizontally centred on its bbox, sitting on y=0, scaled
 *  so `axis` measures `target` metres. Cached — instancing reuses the geometry. */
function loadStatement(name: string, axis: "y" | "z", target: number, tint = 0xffffff): Promise<THREE.Mesh> {
  const file = statementLowDetail ? `${name}-low` : name;
  const key = `${file}|${axis}|${target}`;
  const hit = statementCache.get(key);
  if (hit) return hit;
  if (!statementLoader) {
    statementLoader = new GLTFLoader();
    statementLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  const p = statementLoader.loadAsync(assetUrl(`/assets/models/statement/${file}.glb`)).then((gltf) => {
    gltf.scene.updateMatrixWorld(true);
    let src: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !src) src = m;
    });
    const mesh = src as unknown as THREE.Mesh;
    const geo = mesh.geometry.clone();
    // KHR_mesh_quantization stores positions as NORMALISED int16: scaling the
    // buffer in place clamps every vertex to the unit cube. Bake a float copy
    // first, then it is safe to transform into world metres.
    const q = geo.getAttribute("position");
    const flat = new Float32Array(q.count * 3);
    for (let i = 0; i < q.count; i++) {
      flat[i * 3] = q.getX(i);
      flat[i * 3 + 1] = q.getY(i);
      flat[i * 3 + 2] = q.getZ(i);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));
    geo.applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingBox();
    const b0 = geo.boundingBox!;
    const k = target / (axis === "y" ? b0.max.y - b0.min.y : b0.max.z - b0.min.z);
    geo.scale(k, k, k);
    geo.computeBoundingBox();
    const b = geo.boundingBox!;
    geo.translate(-(b.min.x + b.max.x) * 0.5, -b.min.y, -(b.min.z + b.max.z) * 0.5);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    // Sit the authored PBR inside the yard's palette: no chrome, no gloss, a
    // touch of the same warm bounce the procedural props carry.
    mat.metalness = Math.min(mat.metalness ?? 0, 0.06);
    mat.roughness = Math.max(Math.min(mat.roughness ?? 0.8, 0.92), 0.62);
    mat.envMapIntensity = 0.5;
    mat.emissive = new THREE.Color(0x191a12);
    mat.emissiveIntensity = tint === 0xffffff ? 0.34 : 0.2;
    if (tint !== 0xffffff) mat.color = new THREE.Color(tint);
    const out = new THREE.Mesh(geo, mat);
    out.castShadow = out.receiveShadow = true;
    return out;
  });
  p.catch(() => { statementCache.delete(key); });
  statementCache.set(key, p);
  return p;
}

/** The two in-yard statement props: BANANA CO pickup (replaces the rust car)
 *  and the stamped hero export crate. Both are anchored on their colliders. */
async function addStatementProps(root: THREE.Group): Promise<void> {
  const anchors = SOLIDS.filter((o) => o.glb);
  const truck = anchors.find((o) => o.glb === "pickup");
  const crate = anchors.find((o) => o.glb === "export-crate");
  if (truck) {
    // Collider frame: the three truck boxes were fitted to this exact mesh at
    // 3.55 m nose-to-tail, so the mesh must land on the shared box centre.
    const tpl = await loadStatement("pickup", "z", 3.55);
    const m = tpl.clone();
    m.position.set(-11.2, 0, -11.6);
    m.rotation.y = RENDER_YAW(truck.yaw);
    root.add(m);
  }
  if (crate) {
    const tpl = await loadStatement("export-crate", "y", 1.42);
    const m = tpl.clone();
    // 6.6 cm nudge: the sculpted crate body is not centred between its two rope
    // handles, and the collider is fitted to the BODY.
    m.position.set(crate.x - 0.0313 * Math.sin(crate.yaw), 0, crate.z + 0.0313 * Math.cos(crate.yaw));
    m.rotation.y = RENDER_YAW(crate.yaw);
    root.add(m);
  }
}

/** Place a backdrop prop on the ring at `deg`, pushed out until it clears the
 *  yard fence — which is a SQUARE, not a circle. A plain polar radius is the
 *  trap: at 19.4 m on the 133 deg diagonal you land at (-13.2, 14.2), i.e.
 *  3.3 m INSIDE a fence whose outer face is at 16.975 m, and a 7 m collider-less
 *  trunk in the NW corner is something a player walks straight through. */
const RING_CLEAR = 17.7;
function ringXZ(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const rr = Math.max(r, RING_CLEAR / Math.max(Math.abs(c), Math.abs(s)));
  return [c * rr, s * rr];
}

/** Hero S-curve palms in the near jungle ring — instanced, always OUTSIDE the
 *  yard fence, so they read as scale/silhouette without touching a lane. */
async function addHeroPalms(root: THREE.Group): Promise<void> {
  const tpl = await loadStatement("palm", "y", 7.4, 0xd8dcc8);
  // Six, not a picket fence: each authored palm is 18k tris, and six spaced
  // hero silhouettes plus the procedural filler ring reads fuller than eight.
  const spots: [number, number, number][] = [
    // angle(deg), radius, scale
    [24, 19.6, 1.0],
    [78, 20.8, 0.86],
    [133, 19.4, 1.08],
    [196, 20.4, 0.98],
    [252, 19.8, 0.9],
    [312, 21.0, 1.04],
  ];
  const inst = new THREE.InstancedMesh(tpl.geometry, tpl.material, spots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  spots.forEach(([deg, r, sc], i) => {
    const a = THREE.MathUtils.degToRad(deg);
    e.set(0, a + Math.PI * 0.5, 0);
    q.setFromEuler(e);
    s.set(sc, sc, sc);
    const [px, pz] = ringXZ(deg, r);
    m4.compose(new THREE.Vector3(px, -0.05, pz), q, s);
    inst.setMatrixAt(i, m4);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = true;
  root.add(inst);
}

/** CNVS billboard: Tripo statement mesh for the structure (legs, frame, 3D
 *  vines), a fitted decal quad for the words — Tripo bakes text into mush, so
 *  the face follows the container rule: fillText, never generated. Lives OUTSIDE
 *  the fence on the backdrop ring (no collider), angled at the yard centre. */
async function addBillboard(root: THREE.Group): Promise<void> {
  const tpl = await loadStatement("cnvs-billboard", "y", 8);
  const g = new THREE.Group();
  const m = tpl.clone();
  // Tripo's garbled painted face ends up on -Z after this flip; the decal owns
  // +Z, which is the side the group aims at the arena.
  m.rotation.y = Math.PI;
  m.updateMatrix();
  g.add(m);

  // Fit the decal to the panel slab: sample the mesh's upper-band vertices,
  // least-squares the front face's yaw (z = a·x + b), then push the quad out
  // along its own normal until it clears every panel vertex — the slab pitches
  // a hair too, so a mid-plane fit would sink in at one end.
  const pos = tpl.geometry.getAttribute("position");
  const pt = new THREE.Vector3();
  const panel = new THREE.Box3();
  const front: [number, number][] = [];
  for (let i = 0; i < pos.count; i++) {
    pt.fromBufferAttribute(pos, i).applyMatrix4(m.matrix);
    if (pt.y > 4) {
      panel.expandByPoint(pt);
      front.push([pt.x, pt.z]);
    }
  }
  const zMid = (panel.min.z + panel.max.z) / 2;
  let sx = 0,
    sz = 0,
    sxx = 0,
    sxz = 0,
    n = 0;
  for (const [x, z] of front) {
    if (z < zMid) continue;
    sx += x;
    sz += z;
    sxx += x * x;
    sxz += x * z;
    n++;
  }
  const a = (n * sxz - sx * sz) / (n * sxx - sx * sx);
  const ry = -Math.atan(a);
  const nx = Math.sin(ry);
  const nz = Math.cos(ry);
  let dMax = -Infinity;
  for (const [x, z] of front) dMax = Math.max(dMax, x * nx + z * nz);
  const pw = ((panel.max.x - panel.min.x) / Math.cos(ry)) * 0.97;
  const ph = (panel.max.y - panel.min.y) * 0.88;
  const cx = (panel.min.x + panel.max.x) / 2;
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(pw, ph),
    new THREE.MeshStandardMaterial({ map: billboardFaceTex(), roughness: 0.9 }),
  );
  decal.rotation.y = ry;
  const d = dMax + 0.04;
  decal.position.set(cx, (panel.min.y + panel.max.y) / 2 - ph * 0.02, (d - cx * nx) / nz);
  g.add(decal);

  // Backdrop ring, in the hero-palm gap between 78 and 133 deg, aimed at 0,0.
  const [px, pz] = ringXZ(105, 20.8);
  g.position.set(px, 0, pz);
  g.rotation.y = Math.atan2(-px, -pz);
  root.add(g);
}

/** Per-quadrant landmark dressing. Every piece that stands at body height now
 *  has a collider behind it in shared/map.ts — dressing that a player could
 *  walk through was the single biggest source of ghost cells. */
function addLandmarks(root: THREE.Group, sways: Sway[]): void {
  void sways;
  // SE: banana-crate spill. Two moves, both forced by the collider it now has:
  // off the squeeze lane (it used to sit at 11.4, -11.1, straight in the route),
  // and then off spawn point 10 — see the spawn-critical note on the crate-spill
  // solid in shared/map.ts. This position must stay in lockstep with that
  // collider; the group's own rotation.y is RENDER_YAW of the collider yaw.
  const spill = new THREE.Group();
  spill.position.set(14.2, 0, -7.9);
  spill.rotation.y = 0.6;
  const crateM = sharedCrateMat();
  const c1 = crateBox(0.8, 0.7, 0.8);
  c1.position.y = 0.35;
  c1.castShadow = c1.receiveShadow = true;
  spill.add(c1);
  // The second crate lies BROKEN and flat: as a standing box it was 0.65 m of
  // body-height mass with nothing solid behind it.
  const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.13, 0.66), crateM);
  c2.position.set(0.86, 0.07, 0.34);
  c2.rotation.set(0, 0.42, 0.06);
  c2.castShadow = true;
  spill.add(c2);
  for (let i = 0; i < 9; i++) {
    const b = new THREE.Mesh(bananaGeo(), BANANA_MAT);
    b.position.set(0.5 + Math.sin(i * 2.3) * 0.55, 0.035, 0.4 + Math.cos(i * 1.7) * 0.5);
    b.rotation.set(0, i * 1.3, (i % 3) * 0.2 - 0.2);
    b.castShadow = true;
    spill.add(b);
  }
  root.add(spill);

  // contact dressing at the two tilted-shell junctions (wreck landmarks)
  for (const [jx, jz, jyaw] of [
    [-14.1, 1.7, 0.42],
    [14.1, -1.7, -0.42],
  ] as [number, number, number][]) {
    const junk = new THREE.Group();
    junk.position.set(jx, 0, jz);
    // Mirrored with the wrecks: these anchors sit on the wreck floor plank, so
    // they follow the same OBB->render yaw flip everything else now uses.
    junk.rotation.y = -jyaw;
    const shardM = new THREE.MeshStandardMaterial({ color: 0x6e4a30, roughness: 0.8, metalness: 0.3 });
    for (let i = 0; i < 3; i++) {
      const shard = new THREE.Mesh(new THREE.BoxGeometry(0.4 - i * 0.08, 0.05, 0.24), shardM);
      // Flat, not propped: tilted on edge these shards reached 0.18 m and were
      // the only visual the wreck wall's lowest probe ring could see.
      shard.position.set((i - 1) * 0.4, 0.085 + i * 0.012, (i % 2) * 0.3 - 0.15);
      shard.rotation.set(0.04 * i, i * 1.2, 0.1 * (i - 1));
      shard.castShadow = true;
      junk.add(shard);
    }
    // soft + small: at 0.3 alpha these discs read as body shadows in the lane
    const ao = new THREE.Mesh(
      new THREE.CircleGeometry(0.85, 20),
      new THREE.MeshBasicMaterial({ color: 0x241c12, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    ao.rotation.x = -Math.PI / 2;
    ao.renderOrder = 1; // after the yard overlay (ZERO-FLICKER)
    ao.position.y = 0.075;
    junk.add(ao);
    root.add(junk);
  }

  // NW: tire stack on a post — nudged 1.1 m off the squeeze waypoint so the new
  // collider can make it solid without sealing the corner route. The post fills
  // the hole down the middle of the tyres (a bare stack is a ring of air).
  const nw = new THREE.Group();
  nw.position.set(-12.0, 0, 11.3);
  const tireM = new THREE.MeshStandardMaterial({ color: 0x474138, roughness: 0.92, metalness: 0.04 });
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.26, 0.8, 10),
    new THREE.MeshStandardMaterial({ color: 0x6b6250, roughness: 0.8, metalness: 0.18 }),
  );
  post.position.y = 0.4;
  post.castShadow = post.receiveShadow = true;
  nw.add(post);
  for (let i = 0; i < 4; i++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.145, 8, 16), tireM);
    t.rotation.x = Math.PI / 2;
    // 0.195 pitch from 0.10: the tyres still overlap by more than half a tube
    // (no seam for a side ray to slip through) and the stack now crowns at
    // 0.83 m — under the 0.90 m chest probe that its old 0.905 m top grazed.
    // Scatter cut 0.04 -> 0.015: at 0.04 a tyre could swing 8 cm of rubber past
    // its neighbour, which is what forced the collider wide enough to put its
    // own corners in air.
    t.position.set(Math.sin(i) * 0.015, 0.1 + i * 0.195, Math.cos(i * 2) * 0.015);
    t.castShadow = true;
    nw.add(t);
  }
  root.add(nw);
  void crateM;
  // NE pallet+crate dressing removed: the stamped hero export crate replaces it
  // (see addStatementProps) instead of doubling up on yard clutter.
}

/** Cargo packed into the three wreck-seam dead slots. Each pack is drawn at
 *  EXACTLY its collider extents — the whole point of the prop is that a slot the
 *  eye reads as a way through becomes solid, so a face that fell short of the
 *  box would hand the slot straight back. Two stacked crates (both full width
 *  and depth, so top and sides stay flush) plus a strap band that stands 1 cm
 *  proud — inside the audit's 3 cm mesh-ownership window, so the band is still
 *  attributed to this pack instead of reading as protruding wall. A 4 cm band
 *  is what the first cut shipped and it produced a 0.416 m VIS>COL offender
 *  against the perimeter wall; see the inline note at the BoxGeometry below. */
function addSeamPacks(root: THREE.Group): void {
  for (const o of SOLIDS) {
    if (o.visual !== "wreck-junk") continue;
    const g = new THREE.Group();
    g.position.set(o.x, 0, o.z);
    g.rotation.y = RENDER_YAW(o.yaw);
    const hLo = o.sy * 0.58;
    const lo = crateBox(o.sx, hLo, o.sz);
    lo.position.y = hLo * 0.5;
    lo.castShadow = lo.receiveShadow = true;
    g.add(lo);
    const hHi = o.sy - hLo;
    const hi = crateBox(o.sx, hHi, o.sz);
    hi.position.y = hLo + hHi * 0.5;
    hi.castShadow = hi.receiveShadow = true;
    g.add(hi);
    // 1 cm proud, not 4: the audit treats a hit more than 3 cm outside its own
    // OBB as unowned mesh, so a 4 cm strap read as the perimeter wall having
    // 0.42 m of visual standing outside its collider.
    for (const [by, bh] of [[hLo, 0.07], [hLo * 0.34, 0.05]] as [number, number][]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(o.sx + 0.02, bh, o.sz + 0.02), sharedTrimMat());
      band.position.y = by;
      band.castShadow = true;
      g.add(band);
    }
    root.add(g);
  }
}

// ---------- perimeter jungle ----------

let leafGeoShared: THREE.BufferGeometry | null = null;

function bentLeafGeo(): THREE.BufferGeometry {
  if (leafGeoShared) return leafGeoShared;
  const g = new THREE.PlaneGeometry(0.62, 2.2, 1, 6);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + 1.1) / 2.2;
    pos.setZ(i, Math.sin(t * Math.PI) * 0.35 - t * 0.5);
  }
  g.computeVertexNormals();
  g.translate(0, 1.1, 0);
  leafGeoShared = g;
  return g;
}

function addPalms(root: THREE.Group, leafT: THREE.Texture, cutoutAA: boolean): void {
  const bark = new THREE.MeshStandardMaterial({ map: barkTex(), roughness: 0.9, metalness: 0, emissive: 0x191410, emissiveIntensity: 0.5 });
  const leafMat = new THREE.MeshStandardMaterial({
    map: leafT,
    alphaTest: 0.45,
    // Frond edges against the sky were the loudest jaggy in the frame: a hard
    // alpha cutout ignores MSAA, which only smooths the polygon outline. With
    // alphaToCoverage the cutout resolves through the MSAA sample mask instead
    // (three widens the test to a one-texel smoothstep), so the leaf silhouette
    // gets the same 4x AA the container corners do. Costs nothing — no extra
    // pass, no blending, no sorting, so the r5 "pale contour" defect that
    // killed transparent+alphaTest on the canopy cards cannot come back here.
    alphaToCoverage: cutoutAA,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0,
    color: 0xd9decc,
    emissive: 0x18200f,
    emissiveIntensity: 0.55,
  });
  const trunkGeos: THREE.BufferGeometry[] = [];
  const leafGeos: THREE.BufferGeometry[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  let rs = 42;
  const rand = () => {
    rs = (rs * 1664525 + 1013904223) >>> 0;
    return rs / 0xffffffff;
  };

  // Thinned from 34: eight authored S-curve palms now carry the near ring, so
  // the procedural trunks sit further back as filler and the skyline stays read-
  // able rather than becoming a picket fence.
  const N = 24;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2 + Math.sin(i * 3.7) * 0.1;
    const r = 21 + (i % 5) * 1.7 + rand() * 1.6;
    const height = 4.2 + rand() * 2.8;
    const lean = 0.5 + rand() * 0.9; // total horizontal drift in meters
    const leanDir = rand() * Math.PI * 2;
    // connected polyline: base → gently curved top; each cylinder spans its two
    // joint points exactly, so trunks can never break apart.
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      const bow = t * t; // curve accelerates toward the top
      pts.push(
        new THREE.Vector3(
          Math.cos(ang) * r + Math.cos(leanDir) * lean * bow,
          t * height,
          Math.sin(ang) * r + Math.sin(leanDir) * lean * bow,
        ),
      );
    }
    for (let k = 0; k < 3; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      dir.copy(b).sub(a);
      const len = dir.length();
      dir.normalize();
      const rBot = 0.24 - k * 0.045;
      const rTop = 0.2 - k * 0.045;
      const geo = new THREE.CylinderGeometry(rTop, rBot, len + 0.08, 7);
      q.setFromUnitVectors(up, dir);
      mid.copy(a).add(b).multiplyScalar(0.5);
      s.set(1, 1, 1);
      m4.compose(mid, q, s);
      geo.applyMatrix4(m4);
      trunkGeos.push(geo);
    }
    // crown welded to the exact trunk top joint
    const top = pts[3]!;
    const leaves = 8 + (i % 3);
    for (let L = 0; L < leaves; L++) {
      const la = (L / leaves) * Math.PI * 2 + rand() * 0.4;
      const pitch = -(0.5 + rand() * 0.55);
      const geo = bentLeafGeo().clone();
      e.set(pitch, la, 0, "YXZ");
      q.setFromEuler(e);
      const sc = 0.85 + rand() * 0.5;
      s.set(sc, sc, sc);
      m4.compose(new THREE.Vector3(top.x, top.y - 0.12, top.z), q, s);
      geo.applyMatrix4(m4);
      leafGeos.push(geo);
    }
  }
  const trunks = new THREE.Mesh(mergeGeometries(trunkGeos), bark);
  trunks.castShadow = true;
  root.add(trunks);
  for (const g of trunkGeos) g.dispose();
  const leaves = new THREE.Mesh(mergeGeometries(leafGeos), leafMat);
  leaves.castShadow = true;
  root.add(leaves);
  for (const g of leafGeos) g.dispose();
}

function addUnderstory(root: THREE.Group, leafT: THREE.Texture, sways: Sway[], cutoutAA: boolean): void {
  const mat = new THREE.MeshStandardMaterial({
    map: leafT,
    color: 0xb2c493,
    alphaTest: 0.45,
    // Same cutout AA as the palm fronds — understory sits at eye level, where a
    // stair-stepped leaf edge is a foot from the crosshair.
    alphaToCoverage: cutoutAA,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
    emissive: 0x18200f,
    emissiveIntensity: 0.55,
  });
  const geos: THREE.BufferGeometry[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < 64; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = 17.8 + Math.random() * 9;
    const bx = Math.cos(ang) * r;
    const bz = Math.sin(ang) * r;
    const blades = 2 + Math.floor(Math.random() * 3);
    for (let b = 0; b < blades; b++) {
      const geo = bentLeafGeo().clone();
      e.set(-(0.9 + Math.random() * 0.5), Math.random() * Math.PI * 2, 0, "YXZ");
      q.setFromEuler(e);
      const sc = 0.45 + Math.random() * 0.3;
      s.set(sc, sc, sc);
      p.set(bx, 0, bz);
      m4.compose(p, q, s);
      geo.applyMatrix4(m4);
      geos.push(geo);
    }
  }
  const bush = new THREE.Mesh(mergeGeometries(geos), mat);
  bush.receiveShadow = true;
  root.add(bush);
  for (const g of geos) g.dispose();

  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 + 0.3;
    const r = 17.4 + Math.random() * 1.2;
    const leaf = new THREE.Mesh(bentLeafGeo(), mat);
    const sc = 0.38 + Math.random() * 0.16;
    leaf.scale.setScalar(sc);
    leaf.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    leaf.rotation.set(-(1 + Math.random() * 0.4), Math.random() * Math.PI * 2, 0, "YXZ");
    root.add(leaf);
    sways.push({
      obj: leaf,
      base: leaf.rotation.x,
      amp: 0.04 + Math.random() * 0.04,
      speed: 0.9 + Math.random() * 0.7,
      phase: Math.random() * 6.3,
      axis: "x",
    });
  }
}

/** Hero bamboo clusters — one InstancedMesh, all beyond the yard fence. This
 *  replaces the 20 procedural cylinder clumps that used to stand in for them.
 *
 *  ELEMENT-BOOK NOTE (read before hunting for a "bamboo" kind): there isn't
 *  one, and that is a classifier limitation, not missing coverage. These six
 *  clusters ARE shot — they are the single root child that the element book
 *  files as `palm-trunks-3`: probed via window.__inspect.elements(), that entry
 *  is 1 mesh with a 42.8 x 5.7 x 44.1 m bbox, i.e. this ring at its 5.4 m
 *  template height times the 1.06 top scale below. inspect.ts's loose
 *  classifier only reaches its `bamboo` branch for UNTEXTURED green materials
 *  (`!mat.map && color.g > color.r`), and every authored statement GLB carries
 *  a baked webp base-colour texture, so this mesh falls through to the
 *  textured-and-tall branch that owns the palm trunks. Fixing the label would
 *  mean either stripping the authored texture (throwing away the mesh's whole
 *  reason to exist) or editing inspect.ts, which this worker does not own.
 *  Coverage risk is nil: the ring sits at r 19.4-20.9 m, outside the 16.975 m
 *  fence, so it is backdrop with no collider to mismatch and nothing to stand
 *  inside — the collider-audit has nothing to say about it by construction. */
async function addBamboo(root: THREE.Group): Promise<void> {
  const tpl = await loadStatement("bamboo", "y", 5.4, 0xcfd6be);
  const spots: [number, number, number][] = [
    [6, 19.4, 1.0],
    [52, 20.4, 0.84],
    [104, 20.9, 0.96],
    [166, 19.6, 1.06],
    [224, 20.6, 0.9],
    [284, 19.8, 1.02],
  ];
  const inst = new THREE.InstancedMesh(tpl.geometry, tpl.material, spots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  spots.forEach(([deg, r, sc], i) => {
    const a = THREE.MathUtils.degToRad(deg);
    e.set(0, a * 1.7, 0);
    q.setFromEuler(e);
    s.set(sc, sc, sc);
    const [px, pz] = ringXZ(deg, r);
    m4.compose(new THREE.Vector3(px, -0.06, pz), q, s);
    inst.setMatrixAt(i, m4);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = true;
  root.add(inst);
}

function addCanopyCards(root: THREE.Group, cutoutAA: boolean): void {
  const texVars = [treeCardTex(0), treeCardTex(1), treeCardTex(2), treeCardTex(3)];
  // Far ring: crowns only — trunk/ground rectangles fog into pale slabs above the hedge.
  const texVarsFar = [treeCardTex(0, false), treeCardTex(1, false), treeCardTex(2, false), treeCardTex(3, false)];
  // Opaque alpha-cutout, NOT blended: transparent+alphaTest smeared a pale
  // contour line along the canopy ridge against the bright sky (review r5).
  // `alphaToCoverage` is what antialiases that ridge: MSAA resolves geometry
  // edges only, and a cutout silhouette is a per-fragment kill it never sees.
  // This is the largest cutout silhouette in the game — it is the horizon of
  // essentially every outdoor frame — so omitting it staircases the whole sky.
  const nearMats = texVars.map(
    (t) =>
      new THREE.MeshBasicMaterial({
        map: t,
        alphaTest: 0.5,
        alphaToCoverage: cutoutAA,
        side: THREE.DoubleSide,
        color: 0xc9d4bc,
        fog: true,
      }),
  );
  const farMats = texVarsFar.map(
    (t) =>
      new THREE.MeshBasicMaterial({
        map: t,
        alphaTest: 0.5,
        alphaToCoverage: cutoutAA,
        side: THREE.DoubleSide,
        color: 0xbcc9ae,
        fog: true,
      }),
  );
  const geosByMat: THREE.BufferGeometry[][] = texVars.map(() => []);
  const geosByMatFar: THREE.BufferGeometry[][] = texVars.map(() => []);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  for (let ring = 0; ring < 2; ring++) {
    const count = ring === 0 ? 24 : 18;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + ring * 0.19;
      const r = ring === 0 ? 29 + Math.random() * 3 : 37 + Math.random() * 4;
      // ~10% wider + sunk deeper so adjacent crowns overlap and never open a gap
      const w = (ring === 0 ? 16.5 + Math.random() * 5.5 : 23 + Math.random() * 6.5) * (0.9 + Math.random() * 0.4);
      const h = (ring === 0 ? 10 + Math.random() * 3.5 : 13 + Math.random() * 4) * (0.85 + Math.random() * 0.4);
      const geo = new THREE.PlaneGeometry(w, h);
      // random mirror for variety
      if (Math.random() > 0.5) geo.scale(-1, 1, 1);
      e.set(0, -ang + Math.PI / 2, 0);
      q.setFromEuler(e);
      p.set(Math.cos(ang) * r, h * 0.5 - (ring === 0 ? 1.6 : 1.1), Math.sin(ang) * r);
      m4.compose(p, q, s);
      geo.applyMatrix4(m4);
      const v = Math.floor(Math.random() * texVars.length);
      (ring === 0 ? geosByMat : geosByMatFar)[v]!.push(geo);
    }
  }
  for (let v = 0; v < texVars.length; v++) {
    if (geosByMat[v]!.length) {
      const mesh = new THREE.Mesh(mergeGeometries(geosByMat[v]!), nearMats[v]!);
      root.add(mesh);
      for (const g of geosByMat[v]!) g.dispose();
    }
    if (geosByMatFar[v]!.length) {
      const mesh = new THREE.Mesh(mergeGeometries(geosByMatFar[v]!), farMats[v]!);
      root.add(mesh);
      for (const g of geosByMatFar[v]!) g.dispose();
    }
  }
}

/** Solid dark-green ring behind everything: guarantees no raw sky below canopy
 *  height. Tall enough (≈21m of solid fill) to back the whole card layer, with
 *  an irregular canopy-bump ridge so it reads as distant treetops, not a wall. */
function addHedgeRing(root: THREE.Group, cutoutAA: boolean): void {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#5a7156");
  g.addColorStop(0.4, "#41573c");
  g.addColorStop(1, "#324430");
  // draw as a solid wave-topped polygon: no compositing seams, no dot artifacts
  ctx.beginPath();
  ctx.moveTo(0, 256);
  for (let x = 0; x <= 128; x += 2) {
    const y =
      26 +
      Math.sin((x / 128) * Math.PI * 2) * 11 +
      Math.sin((x / 128) * Math.PI * 6) * 6 +
      Math.sin((x / 128) * Math.PI * 14 + 1.3) * 3;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(128, 256);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  // rounded crown bumps riding the ridge line
  ctx.fillStyle = "#55704f";
  for (let i = 0; i < 9; i++) {
    const x = 8 + i * 14 + Math.sin(i * 3.1) * 5;
    const y = 26 + Math.sin((x / 128) * Math.PI * 2) * 11 + Math.sin((x / 128) * Math.PI * 6) * 6;
    ctx.beginPath();
    ctx.arc(x, y + 3, 7 + (i % 3) * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.clearRect(0, 0, 128, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(26, 1);
  // opaque cutout (no blending): blended edges drew a pale seam along the ridge.
  // `alphaToCoverage` antialiases the bump ridge where it meets the sky — MSAA
  // cannot, because the ridge is an alphaTest kill, not a geometry edge.
  const mat = new THREE.MeshBasicMaterial({
    map: t,
    side: THREE.BackSide,
    fog: true,
    alphaTest: 0.5,
    alphaToCoverage: cutoutAA,
  });
  const cyl = new THREE.CylinderGeometry(44, 44, 24, 48, 1, true);
  const mesh = new THREE.Mesh(cyl, mat);
  mesh.position.y = 10.6;
  root.add(mesh);
}

/** Subtle god-ray cards angled with the sun over the main lanes. */
function addGodRays(root: THREE.Group): void {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  // soft streaks: feathered laterally, faded at BOTH ends
  for (const [x, w] of [
    [14, 26],
    [56, 34],
    [98, 20],
  ] as [number, number][]) {
    const lat = ctx.createLinearGradient(x, 0, x + w, 0);
    lat.addColorStop(0, "rgba(255,242,196,0)");
    lat.addColorStop(0.5, "rgba(255,242,196,0.5)");
    lat.addColorStop(1, "rgba(255,242,196,0)");
    ctx.fillStyle = lat;
    ctx.fillRect(x, 0, w, 256);
  }
  ctx.globalCompositeOperation = "destination-in";
  const lon = ctx.createLinearGradient(0, 0, 0, 256);
  lon.addColorStop(0, "rgba(0,0,0,0)");
  lon.addColorStop(0.22, "rgba(0,0,0,1)");
  lon.addColorStop(0.72, "rgba(0,0,0,0.55)");
  lon.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = lon;
  ctx.fillRect(0, 0, 128, 256);
  ctx.globalCompositeOperation = "source-over";
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: t,
    transparent: true,
    opacity: 0.055,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const spots: [number, number, number][] = [
    [-3.5, 0, 8],
    [6, 0, -5],
  ];
  for (const [x, , z] of spots) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(5, 9), mat);
    plane.position.set(x, 4.6, z);
    // lean toward the sun azimuth (132°) so rays read as coming from it
    plane.rotation.set(0.5, THREE.MathUtils.degToRad(132), 0.12, "YXZ");
    root.add(plane);
  }
}

function addDriftingLeaves(root: THREE.Group): THREE.Points {
  const n = 120;
  const g = new THREE.BufferGeometry();
  const arr = new Float32Array(n * 3);
  // Drift band stays ABOVE the container roofline: at ground level the point
  // sprites float through walkthrough interiors and read as stray green quads.
  for (let i = 0; i < n; i++) {
    arr[i * 3] = (Math.random() - 0.5) * 34;
    arr[i * 3 + 1] = 3.2 + Math.random() * 3.4;
    arr[i * 3 + 2] = (Math.random() - 0.5) * 34;
  }
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const pts = new THREE.Points(
    g,
    new THREE.PointsMaterial({ color: 0x8aa054, size: 0.05, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  root.add(pts);
  return pts;
}

void HALF;
