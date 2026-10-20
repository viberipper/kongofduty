import * as THREE from "three";
import * as MapModule from "@shared/map";
import * as MapsModule from "@shared/maps";
import {
  SOLIDS,
  VISUAL_CONTAINERS,
  HALF,
  YARD,
  groundHeight,
  circleHitsOBB,
  worldToLocal,
  type OBB,
} from "@shared/map";
import { RADIUS, STAND_H, CROUCH_H, SLIDE_H, aimDir, type SimPlayer } from "@shared/sim";
import { HULL_FIST_R } from "./bruiser";
import type { Game } from "./game";

/** Horizontal reach (m) within which a solid can hold any of this ape's drawn mesh. */
const MESH_PEN_REACH = 1.4;
/** Drawn vertices tested per actor per sweep (the mesh carries ~74k). */
const MESH_PEN_SAMPLES = 1500;
/** Slack (m) added around the collider AABB when the grid extent is auto-fitted. */
const AUTOFIT_MARGIN = 1;

/**
 * Element kinds that back a SOLID sim collider, i.e. the meshes a collider-vs-visual
 * audit is allowed to raycast against. `InspectElement.solid` defaults to membership
 * here; a world builder can override per element with `userData.solid`.
 *
 * Shipment kinds come first (frozen — qa/collider-audit.mjs mirrors this list); map
 * builders add their own tags via the userData contract documented on buildRegistry().
 */
export const QA_SOLID_KINDS = [
  // Shipment (jungle/classic)
  "container", "walkthrough", "wreck", "wall", "crate", "barrel", "dumpster",
  "car", "forklift", "crate-spill", "tire-stack", "pallet", "wreck-junk",
  // generic map-shell kinds for tag-driven builders (dust2 and later maps)
  "shell", "floor", "ramp", "stairs", "tunnel", "platform", "cover", "door", "sign", "prop",
] as const;
const SOLID_KIND_SET: ReadonlySet<string> = new Set<string>(QA_SOLID_KINDS as readonly string[]);

/** Rectangular XZ extent used by clearanceGrid(). */
export type GridBounds = {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Where the numbers came from — recorded by instruments, never guessed. */
  source: "world" | "shared" | "yard" | "auto" | "explicit";
};

/**
 * window.__inspect — QA inspection rig (installed only in ?test mode by test.ts).
 *
 * Everything here is defensive: no method throws on odd input; bad ids return
 * null/[]/no-ops. All scene mutations (isolate/xray/capsule) are reversible and
 * leak no materials (clones are disposed on restore).
 */

export type InspectElement = {
  id: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  z: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  meshCount: number;
  /** True when this element's meshes back a sim collider (raycast target for audits). */
  solid: boolean;
  /** How the kind was decided — "tag" means the world builder declared it. */
  source: "tag" | "container" | "landmark" | "prop" | "loose";
};

export type ColliderInfo = {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
  yaw: number;
  size: [number, number, number];
  center: [number, number, number];
  visual: string | null;
  climb: boolean;
};

export type PenetrationRow = {
  id: string;
  feetY: number;
  /** Deepest BONE JOINT inside a solid (m). The historical CLIP statistic. */
  worstInsideDepth: number;
  insideColliderId: string | null;
  worstSample: string | null;
  samples: number;
  /**
   * Deepest DRAWN VERTEX inside a solid (m) — the skinned mesh, not the
   * skeleton. See meshPenetration() for why the joint number alone is not the
   * thing the user reported.
   */
  meshInsideDepth: number;
  meshColliderId: string | null;
  /** Dominant skinning bone of the deepest drawn vertex. */
  meshSample: string | null;
  /** Same, but excluding the gun geometry the barrel budget deliberately allows. */
  bodyInsideDepth: number;
  bodyColliderId: string | null;
  bodySample: string | null;
  /** Vertices actually tested this sweep (0 when nothing was near a solid). */
  meshSamples: number;
};

type Rec = { el: InspectElement; obj: THREE.Object3D };

type DimPreset = "gray" | "black";

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The collider set every inspection reads.
 *
 * shared/map.ts exports `SOLIDS` (Shipment) and, once the map-pluggability work
 * lands, `activeSolids()` — the collider array of the map that actually booted.
 * Prefer the accessor when it exists so the whole qa fleet follows the active map
 * with no per-instrument edit; on Shipment the accessor returns SOLIDS itself, so
 * this is a no-op today.
 */
function solids(): OBB[] {
  const f = (MapModule as unknown as { activeSolids?: () => OBB[] }).activeSolids;
  if (typeof f === "function") {
    try {
      const a = f();
      if (Array.isArray(a) && a.length) return a;
    } catch {
      /* fall back */
    }
  }
  return SOLIDS;
}

/**
 * THE WORLD FLOOR PLANE OF THE MAP THAT ACTUALLY BOOTED — not y = 0.
 *
 * `penetration()` scores a body against a pseudo-collider called `"floor"`: the
 * implicit infinite plane the sim clamps players to. That plane was a literal 0
 * for as long as Shipment was the only map, and hard-coding it made every dust2
 * deck read as a clip — dust2's `floorY` is −4.95 and its real standable decks
 * sit at −3.251, −2.032, −0.813 and −0.406, so a bot standing on the mid-north
 * floor scored **3.204 m inside "floor"**, and six of ten CLIP episodes in a
 * 300 s botwatch were this arithmetic rather than any geometry
 * (`docs/dustmap/build-i2-colliders3.md` §9.2 + handoff 1).
 *
 * Resolution order mirrors `solids()` above: the MapDef first (the value the
 * MapDef itself declares), then `shared/map.ts`'s active-world mirror, then 0 —
 * so the accessor is correct on a tree where either half of the map-pluggability
 * work is absent, and is a no-op on Shipment, whose `floorY` is 0.
 */
function floorY(): number {
  const m = (MapsModule as unknown as { activeMap?: () => { floorY?: number } }).activeMap;
  if (typeof m === "function") {
    try {
      const y = m().floorY;
      if (typeof y === "number" && Number.isFinite(y)) return y;
    } catch {
      /* fall back */
    }
  }
  const f = (MapModule as unknown as { activeFloorY?: () => number }).activeFloorY;
  if (typeof f === "function") {
    try {
      const y = f();
      if (Number.isFinite(y)) return y;
    } catch {
      /* fall back */
    }
  }
  return 0;
}

function stanceH(p: Pick<SimPlayer, "crouch" | "slide">): number {
  return p.slide > 0 ? SLIDE_H : p.crouch ? CROUCH_H : STAND_H;
}

/** Depth (m) a point sits inside an oriented collider box; 0 when outside. */
function insideDepth(x: number, y: number, z: number, o: OBB): number {
  const loc = worldToLocal(o, x, z);
  const dx = o.sx * 0.5 - Math.abs(loc.x);
  const dz = o.sz * 0.5 - Math.abs(loc.z);
  const dyT = o.y + o.sy * 0.5 - y;
  const dyB = y - (o.y - o.sy * 0.5);
  if (dx <= 0 || dz <= 0 || dyT <= 0 || dyB <= 0) return 0;
  return Math.min(dx, dz, dyT, dyB);
}

export class Inspector {
  /** three.js module namespace, so page.evaluate code can build overlay objects. */
  THREE = THREE;

  private reg: Rec[] | null = null;
  private dimmed: { obj: THREE.Mesh | THREE.Points | THREE.Line; mat: THREE.Material | THREE.Material[] }[] = [];
  private dimCache = new Map<string, THREE.Material>();
  private dimOwner: "none" | "isolate" | "xray" = "none";
  private xrayGroup: THREE.Group | null = null;
  private xrayMode: "off" | "overlay" | "only" = "off";
  private savedBg: THREE.Color | THREE.Texture | null = null;
  private savedFog: THREE.Fog | THREE.FogExp2 | null = null;
  private sceneDressed = false;
  private capsuleGroup: THREE.Group | null = null;
  private capsules = new Map<string, { mesh: THREE.Mesh; h: number }>();
  private capsuleGeos = new Map<number, THREE.CylinderGeometry>();
  private capsuleMat: THREE.MeshBasicMaterial | null = null;
  private capsuleOn = false;
  /** Scratch for meshPenetration — no allocation inside the vertex sweep. */
  private penV = new THREE.Vector3();
  private penWrist = new THREE.Vector3();

  constructor(private game: Game) {
    // Sync overlay objects every draw (stepped-sim safe; ~free when unused).
    const g = game as Game & { draw: (dt: number) => void };
    const orig = g.draw.bind(g);
    g.draw = (dt: number) => {
      try {
        if (this.capsuleOn) this.syncCapsules();
      } catch {
        /* never break the frame */
      }
      orig(dt);
    };
  }

  // ------------------------------------------------------------- registry --

  /** Every distinct map element instance harvested from the world scene graph. */
  elements(): InspectElement[] {
    try {
      return this.registry().map((r) => ({ ...r.el, bbox: { min: [...r.el.bbox.min], max: [...r.el.bbox.max] } })) as InspectElement[];
    } catch {
      return [];
    }
  }

  /** Raw collider list (world AABB enclosure of each sim OBB, + oriented data). */
  colliders(): ColliderInfo[] {
    try {
      const SOL = solids();
      return SOL.map((o, i) => {
        const c = Math.abs(Math.cos(o.yaw));
        const s = Math.abs(Math.sin(o.yaw));
        const hx = o.sx * 0.5 * c + o.sz * 0.5 * s;
        const hz = o.sx * 0.5 * s + o.sz * 0.5 * c;
        const hy = o.sy * 0.5;
        return {
          id: "col-" + i,
          min: [r3(o.x - hx), r3(o.y - hy), r3(o.z - hz)] as [number, number, number],
          max: [r3(o.x + hx), r3(o.y + hy), r3(o.z + hz)] as [number, number, number],
          yaw: r3(o.yaw),
          size: [o.sx, o.sy, o.sz] as [number, number, number],
          center: [o.x, o.y, o.z] as [number, number, number],
          visual: o.visual ?? null,
          climb: !!o.climb,
        };
      });
    } catch {
      return [];
    }
  }

  /** Orbit-camera params fitted to an element bbox (for turntables). */
  frame(id: string, pad = 1.4): { cx: number; cy: number; cz: number; dist: number; height: number } {
    const fallback = { cx: 0, cy: 1.2, cz: 0, dist: 10, height: 4 };
    try {
      const rec = this.byId(id);
      if (!rec) return fallback;
      const b = rec.el.bbox;
      const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      const cx = (b.min[0] + b.max[0]) / 2;
      const cy = (b.min[1] + b.max[1]) / 2;
      const cz = (b.min[2] + b.max[2]) / 2;
      const radius = 0.5 * Math.hypot(size[0]!, size[1]!, size[2]!);
      const p = Number.isFinite(pad) && pad > 0 ? pad : 1.4;
      // fit for the test rig's default 46° orbit fov
      const dist = Math.min(70, Math.max(1.6, (radius * p) / Math.tan((46 * Math.PI) / 360)));
      const height = cy + size[1]! * 0.5 + dist * 0.22;
      return { cx: r3(cx), cy: r3(cy), cz: r3(cz), dist: r3(dist), height: r3(height) };
    } catch {
      return fallback;
    }
  }

  // -------------------------------------------------------------- isolate --

  /** Dim every other map mesh (desaturated, ~12% where possible); null restores. */
  isolate(id: string | null): boolean {
    try {
      this.clearDim();
      this.dimOwner = "none";
      if (id === null || id === undefined) return true;
      const rec = this.byId(String(id));
      if (!rec) return false;
      const keep = new Set<THREE.Object3D>();
      rec.obj.traverse((o) => keep.add(o));
      this.applyDim((o) => !keep.has(o), "gray");
      this.dimOwner = "isolate";
      return true;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------- xray --

  /** Collider view. 'overlay': translucent green boxes + bright edges drawn on
   *  top of the normal scene. 'only': same boxes over a near-black world. */
  xray(mode: "off" | "overlay" | "only"): boolean {
    try {
      const m = mode === "overlay" || mode === "only" ? mode : "off";
      const scene = this.game.world?.scene;
      if (!scene) return false;
      // tear down previous xray dim/dressing
      if (this.dimOwner === "xray") {
        this.clearDim();
        this.dimOwner = "none";
      }
      this.undressScene();
      if (this.xrayGroup) scene.remove(this.xrayGroup);
      this.xrayMode = m;
      if (m === "off") return true;
      if (!this.xrayGroup) this.xrayGroup = this.buildXrayGroup();
      scene.add(this.xrayGroup);
      if (m === "only") {
        this.applyDim(() => true, "black");
        this.dimOwner = "xray";
        this.dressSceneDark(scene);
      }
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------- capsule --

  /** Show the sim collision volume (r=0.3 cylinder, stance height) for every
   *  alive player/dummy/bot as cyan wireframes that track the stepped sim. */
  capsule(on: boolean): boolean {
    try {
      this.capsuleOn = !!on;
      const scene = this.game.world?.scene;
      if (!scene) return false;
      if (!this.capsuleOn) {
        if (this.capsuleGroup) scene.remove(this.capsuleGroup);
        for (const [, e] of this.capsules) this.capsuleGroup?.remove(e.mesh);
        this.capsules.clear();
        return true;
      }
      if (!this.capsuleGroup) {
        this.capsuleGroup = new THREE.Group();
        this.capsuleGroup.name = "inspect-capsules";
      }
      scene.add(this.capsuleGroup);
      this.syncCapsules();
      return true;
    } catch {
      return false;
    }
  }

  private syncCapsules(): void {
    const s = this.game.session;
    const group = this.capsuleGroup;
    if (!s || !group) return;
    if (!this.capsuleMat)
      this.capsuleMat = new THREE.MeshBasicMaterial({
        color: 0x35e0ff,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false,
      });
    const seen = new Set<string>();
    for (const p of s.players.values()) {
      if (!p.alive) continue;
      seen.add(p.id);
      const h = stanceH(p);
      let e = this.capsules.get(p.id);
      if (!e) {
        const mesh = new THREE.Mesh(this.capsuleGeo(h), this.capsuleMat);
        mesh.renderOrder = 998;
        mesh.frustumCulled = false;
        group.add(mesh);
        e = { mesh, h };
        this.capsules.set(p.id, e);
      } else if (e.h !== h) {
        e.mesh.geometry = this.capsuleGeo(h);
        e.h = h;
      }
      e.mesh.position.set(p.x, p.y + h * 0.5, p.z);
    }
    for (const [id, e] of this.capsules) {
      if (!seen.has(id)) {
        group.remove(e.mesh);
        this.capsules.delete(id);
      }
    }
  }

  private capsuleGeo(h: number): THREE.CylinderGeometry {
    const key = Math.round(h * 100);
    let g = this.capsuleGeos.get(key);
    if (!g) {
      g = new THREE.CylinderGeometry(RADIUS, RADIUS, h, 10, 3, false);
      this.capsuleGeos.set(key, g);
    }
    return g;
  }

  // ---------------------------------------------------------- penetration --

  /** Per alive player: sampled bone (or capsule) world positions vs colliders
   *  and the floor — how far a body sits inside a solid. */
  penetration(): PenetrationRow[] {
    try {
      const s = this.game.session;
      if (!s) return [];
      const out: PenetrationRow[] = [];
      const v = new THREE.Vector3();
      // One resolve per sweep: the active map's floor plane (Shipment 0,
      // dust2 −4.95). See `floorY()` for why this may not be a literal 0.
      const fy = floorY();
      for (const p of s.players.values()) {
        if (!p.alive) continue;
        const samples: { name: string; x: number; y: number; z: number }[] = [];
        const actor = this.game.actors.get(p.id);
        // weapons stream: the sim says alive but the DRAWN body is still a corpse
        // (the local player's killcam replays the tape, where this bot has not
        // respawned yet; or the snapshot lag on a respawn) — its bones are
        // sinking through the floor on purpose. Judge the body once it is drawn
        // alive. (botwatch: "L_ForearmTwist01 2.75 m in floor" was this.)
        if (actor && (actor as { wasAlive?: boolean }).wasAlive === false) continue;
        if (actor && actor.bones && Object.keys(actor.bones).length) {
          try {
            actor.root.updateMatrixWorld(true);
            for (const [n, b] of Object.entries(actor.bones)) {
              b.getWorldPosition(v);
              samples.push({ name: n, x: v.x, y: v.y, z: v.z });
            }
          } catch {
            /* fall through to capsule samples */
          }
        }
        if (!samples.length) {
          const h = stanceH(p);
          for (const k of [0, 0.25, 0.5, 0.75, 1]) samples.push({ name: "capsule@" + k, x: p.x, y: p.y + h * k, z: p.z });
        }
        let feetY = Infinity;
        let feetFromFeetBones = Infinity;
        for (const sm of samples) {
          feetY = Math.min(feetY, sm.y);
          if (/foot|toe/i.test(sm.name)) feetFromFeetBones = Math.min(feetFromFeetBones, sm.y);
        }
        if (Number.isFinite(feetFromFeetBones)) feetY = feetFromFeetBones;
        let worst = 0;
        let worstId: string | null = null;
        let worstSample: string | null = null;
        for (const sm of samples) {
          const SOL = solids();
          for (let i = 0; i < SOL.length; i++) {
            const d = insideDepth(sm.x, sm.y, sm.z, SOL[i]!);
            if (d > worst) {
              worst = d;
              worstId = "col-" + i;
              worstSample = sm.name;
            }
          }
          if (fy - sm.y > worst) {
            worst = fy - sm.y;
            worstId = "floor";
            worstSample = sm.name;
          }
        }
        const mp = this.meshPenetration(actor, p.x, p.z);
        out.push({
          id: p.id,
          feetY: r3(feetY),
          worstInsideDepth: r3(worst),
          insideColliderId: worst > 1e-4 ? worstId : null,
          worstSample: worst > 1e-4 ? worstSample : null,
          samples: samples.length,
          meshInsideDepth: r3(mp.mesh),
          meshColliderId: mp.mesh > 1e-4 ? mp.meshId : null,
          meshSample: mp.mesh > 1e-4 ? mp.meshBone : null,
          bodyInsideDepth: r3(mp.body),
          bodyColliderId: mp.body > 1e-4 ? mp.bodyId : null,
          bodySample: mp.body > 1e-4 ? mp.bodyBone : null,
          meshSamples: mp.n,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * HOW FAR THE DRAWN BODY IS INSIDE A SOLID — the statistic the joint sweep
   * above cannot see, and the one the user actually reported.
   *
   * `penetration()` samples BONE JOINTS. A joint is not the body: over 19,823
   * live bot samples a review probe measured the worst joint at 0.038 m inside a
   * solid — comfortably under the 0.08 m botwatch fires CLIP at — while the
   * SKINNED MESH on the same frames reached 0.182 m inside a container wall at
   * `R_ForearmTwist02` and 0.17 m off the wrist inside a walkthrough wall. So
   * "0 CLIP" meant "no joint is inside a wall", which is not the same claim as
   * "no monkey is walking through a collider". This makes the difference
   * measurable instead of invisible.
   *
   * TWO NUMBERS, because they are two different verdicts. `mesh` is every drawn
   * vertex. `body` excludes the GUN — vertices skinned to the gun hand more than
   * `HULL_FIST_R` out from the wrist — because bruiser.ts's `GUN_WALL_ALLOW`
   * deliberately lets a player who walks up to a container and fires at it put
   * the muzzle in it. `body` is therefore the honest gate; `mesh` is context.
   *
   * COST is bounded on purpose: nothing runs unless the actor is within reach of
   * a solid, only those solids are tested, and the vertex list is strided to
   * roughly MESH_PEN_SAMPLES. QA calls this twice a second.
   */
  private meshPenetration(
    actor: { root: THREE.Object3D; bones?: Record<string, THREE.Object3D> } | undefined,
    px: number,
    pz: number,
  ): { mesh: number; meshId: string | null; meshBone: string | null; body: number; bodyId: string | null; bodyBone: string | null; n: number } {
    const nil = { mesh: 0, meshId: null as string | null, meshBone: null as string | null, body: 0, bodyId: null as string | null, bodyBone: null as string | null, n: 0 };
    if (!actor?.root) return nil;
    // Only solids an arm could possibly be inside. MESH_PEN_REACH is the drawn
    // half-span of this ape (0.74 m of gun past the wrist) plus a margin.
    const near: { o: OBB; id: string }[] = [];
    const SOL = solids();
    for (let i = 0; i < SOL.length; i++) {
      const o = SOL[i]!;
      if (o.visual === "roof") continue;
      const reach = MESH_PEN_REACH + Math.hypot(o.sx, o.sz) * 0.5;
      const dx = px - o.x;
      const dz = pz - o.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      near.push({ o, id: "col-" + i });
    }
    if (!near.length) return nil;
    const meshes: THREE.SkinnedMesh[] = [];
    actor.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh && m.skeleton && m.visible) meshes.push(m);
    });
    if (!meshes.length) return nil;
    actor.root.updateMatrixWorld(true);
    const wrist = actor.bones?.R_Hand;
    const wp = this.penWrist;
    if (wrist) wrist.getWorldPosition(wp);
    const v = this.penV;
    const res = { ...nil };
    for (const m of meshes) {
      const pos = m.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
      if (!pos || typeof m.applyBoneTransform !== "function") continue;
      m.skeleton.update();
      const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute | undefined;
      const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute | undefined;
      const step = Math.max(1, Math.floor(pos.count / MESH_PEN_SAMPLES));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i);
        m.applyBoneTransform(i, v);
        v.applyMatrix4(m.matrixWorld);
        res.n++;
        let d = 0;
        let id: string | null = null;
        for (const c of near) {
          const dd = insideDepth(v.x, v.y, v.z, c.o);
          if (dd > d) {
            d = dd;
            id = c.id;
          }
        }
        if (d <= 0) continue;
        let bone = "?";
        if (si && sw) {
          let bw = -1;
          let bi = 0;
          for (let c = 0; c < 4; c++) {
            const w = sw.getComponent(i, c);
            if (w > bw) {
              bw = w;
              bi = si.getComponent(i, c);
            }
          }
          bone = m.skeleton.bones[bi]?.name ?? "?";
        }
        if (d > res.mesh) {
          res.mesh = d;
          res.meshId = id;
          res.meshBone = bone;
        }
        const isGun = bone === "R_Hand" && !!wrist && v.distanceTo(wp) > HULL_FIST_R;
        if (!isGun && d > res.body) {
          res.body = d;
          res.bodyId = id;
          res.bodyBone = bone;
        }
      }
    }
    return res;
  }

  // ------------------------------------------------------- clearance grid --

  /**
   * Rectangular XZ extent for clearanceGrid(), resolved in this order:
   *
   *   1. "world"  — the active MapDef's `bounds` rect: `activeMap()` from
   *                 @shared/maps, else one the world builder hung on the renderer
   *                 (`game.world.map.bounds` / `game.world.mapBounds`). This is the
   *                 authoritative playable rect and every real map declares it.
   *   2. "shared" — a `BOUNDS` / `MAP_BOUNDS` export on @shared/map.
   *   3. "yard"   — the square HALF/YARD Shipment yard (bit-identical to the grid
   *                 this function produced before it went rectangular).
   *   4. "auto"   — AABB over every collider footprint + AUTOFIT_MARGIN. The
   *                 no-integration fallback: a brand-new map gets a correct grid
   *                 from its collider set alone.
   *
   * Declared bounds beat the auto-fit on purpose. On a shell-enclosed map the
   * auto-fit AABB reaches ~1 m PAST the perimeter wall, and that outside strip is
   * passable-but-unreachable — measured on Shipment it turns `islands: 0` into
   * `islands: 1` (a 300-cell ring). Auto-fit is for maps that declare nothing;
   * pass mode "auto" to measure it deliberately.
   */
  gridBounds(mode: "default" | "map" | "auto" = "default"): GridBounds {
    const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    const rect = (b: unknown, source: GridBounds["source"]): GridBounds | null => {
      const r = b as { minX?: unknown; maxX?: unknown; minZ?: unknown; maxZ?: unknown } | null | undefined;
      if (!r || !fin(r.minX) || !fin(r.maxX) || !fin(r.minZ) || !fin(r.maxZ)) return null;
      if (r.maxX - r.minX < 1 || r.maxZ - r.minZ < 1) return null;
      return { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ, source };
    };
    if (mode !== "auto") {
      // 1a. the active MapDef — the authoritative answer once shared/maps exists.
      try {
        const maps = MapsModule as unknown as { activeMap?: () => { bounds?: unknown } };
        if (typeof maps.activeMap === "function") {
          const fromDef = rect(maps.activeMap().bounds, "world");
          if (fromDef) return fromDef;
        }
      } catch {
        /* fall through */
      }
      // 1b. a MapDef the world builder hung on the renderer.
      try {
        const w = this.game.world as unknown as { map?: { bounds?: unknown }; mapBounds?: unknown } | null;
        const fromWorld = rect(w?.map?.bounds, "world") ?? rect(w?.mapBounds, "world");
        if (fromWorld) return fromWorld;
      } catch {
        /* fall through */
      }
      const mod = MapModule as unknown as Record<string, unknown>;
      const fromShared = rect(mod.BOUNDS, "shared") ?? rect(mod.MAP_BOUNDS, "shared");
      if (fromShared) return fromShared;
      if (fin(HALF) && fin(YARD) && YARD > 1) {
        // NOTE: -HALF + YARD === +HALF; kept as (-HALF, -HALF, span YARD) so the
        // cell count matches the historical `Math.floor(YARD / st) + 1` exactly.
        return { minX: -HALF, minZ: -HALF, maxX: -HALF + YARD, maxZ: -HALF + YARD, source: "yard" };
      }
    }
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const o of solids()) {
      const c = Math.abs(Math.cos(o.yaw));
      const s = Math.abs(Math.sin(o.yaw));
      const hx = o.sx * 0.5 * c + o.sz * 0.5 * s;
      const hz = o.sx * 0.5 * s + o.sz * 0.5 * c;
      if (o.x - hx < minX) minX = o.x - hx;
      if (o.x + hx > maxX) maxX = o.x + hx;
      if (o.z - hz < minZ) minZ = o.z - hz;
      if (o.z + hz > maxZ) maxZ = o.z + hz;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ) || maxX <= minX || maxZ <= minZ) {
      return { minX: -HALF, minZ: -HALF, maxX: HALF, maxZ: HALF, source: "auto" };
    }
    return {
      minX: r3(minX - AUTOFIT_MARGIN),
      minZ: r3(minZ - AUTOFIT_MARGIN),
      maxX: r3(maxX + AUTOFIT_MARGIN),
      maxZ: r3(maxZ + AUTOFIT_MARGIN),
      source: "auto",
    };
  }

  /** Grid-scan the map with the standing player circle against the sim's
   *  collision rules (roofs skipped, climbables passable from the ground).
   *
   *  Rectangular and arbitrary-origin: `w !== h` is normal. The return shape is
   *  frozen — every consumer reads {passable, origin:[x0,z0], step, w, h} and
   *  must keep working when only the extent changes.
   *
   *  `opts.bounds` overrides the extent: an explicit [minX,minZ,maxX,maxZ] (used
   *  by --quadrant runs), or "auto" / "map" to force a gridBounds() mode. */
  clearanceGrid(
    step = 0.5,
    opts?: { bounds?: [number, number, number, number] | "auto" | "map" },
  ): {
    passable: boolean[][];
    origin: [number, number];
    step: number;
    w: number;
    h: number;
    bounds: [number, number, number, number];
    source: GridBounds["source"];
  } {
    try {
      const st = Number.isFinite(step) && step >= 0.1 ? step : 0.5;
      const req = opts?.bounds;
      let b: GridBounds;
      if (Array.isArray(req) && req.length === 4 && req.every((v) => Number.isFinite(v))) {
        b = { minX: Math.min(req[0], req[2]), minZ: Math.min(req[1], req[3]), maxX: Math.max(req[0], req[2]), maxZ: Math.max(req[1], req[3]), source: "explicit" };
      } else {
        b = this.gridBounds(req === "auto" ? "auto" : req === "map" ? "map" : "default");
      }
      const x0 = b.minX;
      const z0 = b.minZ;
      const w = Math.floor((b.maxX - b.minX) / st) + 1;
      const h = Math.floor((b.maxZ - b.minZ) / st) + 1;
      const passable: boolean[][] = [];
      const SOL = solids();
      for (let iz = 0; iz < h; iz++) {
        const row: boolean[] = [];
        for (let ix = 0; ix < w; ix++) {
          const x = x0 + ix * st;
          const z = z0 + iz * st;
          const y = groundHeight(x, z);
          let ok = true;
          for (const o of SOL) {
            if (o.visual === "roof") continue;
            const top = o.y + o.sy * 0.5;
            const bot = o.y - o.sy * 0.5;
            if (y + STAND_H < bot + 0.05 || y > top - 0.02) continue;
            const hit = circleHitsOBB(x, z, RADIUS, o);
            if (hit.hit && hit.pen > 0) {
              if (o.climb && top - y < 1.05 && y + 0.2 < top) continue; // mantle rule
              ok = false;
              break;
            }
          }
          row.push(ok);
        }
        passable.push(row);
      }
      return {
        passable,
        origin: [x0, z0],
        step: st,
        w,
        h,
        bounds: [r3(b.minX), r3(b.minZ), r3(b.maxX), r3(b.maxZ)],
        source: b.source,
      };
    } catch {
      return { passable: [], origin: [-HALF, -HALF], step: 0.5, w: 0, h: 0, bounds: [-HALF, -HALF, HALF, HALF], source: "yard" };
    }
  }

  /**
   * THE 2.5-D VERSION OF clearanceGrid — one entry per STANDABLE DECK, not one
   * per column.
   *
   * `clearanceGrid()` asks `groundHeight(x, z)` for the floor and gets the
   * TOPMOST climb surface in that column, because that is what the 2-argument
   * form means. On a flat map that is the whole truth. On dust2 it is not: a
   * tunnel under a bridge, the −3.251 mid passage under the CT slab and the
   * Long-A pit under its own roof are all floors with another floor above them,
   * and a one-y-per-column grid cannot represent any of them. **Measured on the
   * shipped dust2 collider set at 0.4 m** (`qa/x/r2/deckprobe.ts`): 91,200
   * columns hold **57,038 standable decks** against the 2-D grid's 56,513 passable
   * cells — 464 columns carry a second floor and 61 carry a standable deck that is
   * not the column's `groundHeight` at all, so **525 places a body can stand are
   * invisible to the 2-D grid**. Every clearance number computed from the
   * 2-D grid on this map (ghost cells, phantom blocks, islands, openRatio) was
   * therefore measured against a world with its lower decks deleted.
   *
   * HOW THE DECKS ARE ENUMERATED. Not by re-deriving anything: by walking the
   * sim's own `groundHeight` down the column. The 4-argument form ignores climb
   * tops more than a mantle (1.05 m) above `fromY`, so
   * `groundHeight(x, z, SOL, y - 1.05 - ε)` is exactly "the highest climb top
   * strictly below y". Iterating that from `+Infinity` yields every climb
   * surface in the column, in descending order, with the map's `floorY` plane
   * last — and each one is a y the SIM would put a body at, not an approximation
   * of one.
   *
   * WHICH OF THEM A BODY CAN STAND ON is then the identical test
   * `clearanceGrid()` runs, with the deck's y substituted for the column's: a
   * `roof` box is noclip, a box the standing capsule overlaps blocks unless it
   * is a climbable within mantle reach. So `deckGrid(st).decks[k][0]` on a
   * single-deck column is the same verdict `clearanceGrid(st).passable` gives.
   *
   * SHAPE: CSR, because 74k variable-length arrays do not want to cross a CDP
   * bridge. `off[k] … off[k+1]` indexes `deckY` / `deckPlane` for cell k.
   * `deckPlane[i] === 1` marks a deck that is the abstract `floorY` plane rather
   * than a collider top — on dust2 that is the open desert OUTSIDE the shell
   * (25,928 passable cells of 56,513, measured), which is not playable space and
   * is what an instrument scoping to the playable map must drop.
   *
   * Shipment: `stackedFloors` is false there and nothing calls this. It is
   * additive — `clearanceGrid()` is untouched, so every existing number is.
   */
  deckGrid(
    step = 0.5,
    opts?: { bounds?: [number, number, number, number] | "auto" | "map"; maxDecks?: number },
  ): {
    origin: [number, number];
    step: number;
    w: number;
    h: number;
    bounds: [number, number, number, number];
    source: GridBounds["source"];
    floorY: number;
    /** CSR row offsets, length w*h+1. */
    off: number[];
    /** Candidate deck heights, ascending within each cell. */
    deckY: number[];
    /** 1 = a standing body fits on this deck (the clearanceGrid test at this y). */
    deckPass: number[];
    /** 1 = this deck is the floorY plane (no collider under it), 0 = a collider top. */
    deckPlane: number[];
    columns: number;
    decks: number;
  } {
    const fy = floorY();
    try {
      const st = Number.isFinite(step) && step >= 0.1 ? step : 0.5;
      const req = opts?.bounds;
      let b: GridBounds;
      if (Array.isArray(req) && req.length === 4 && req.every((v) => Number.isFinite(v))) {
        b = { minX: Math.min(req[0], req[2]), minZ: Math.min(req[1], req[3]), maxX: Math.max(req[0], req[2]), maxZ: Math.max(req[1], req[3]), source: "explicit" };
      } else {
        b = this.gridBounds(req === "auto" ? "auto" : req === "map" ? "map" : "default");
      }
      const x0 = b.minX;
      const z0 = b.minZ;
      const w = Math.floor((b.maxX - b.minX) / st) + 1;
      const h = Math.floor((b.maxZ - b.minZ) / st) + 1;
      const SOL = solids();
      const MAX_DECKS = Math.max(1, Math.min(16, opts?.maxDecks ?? 8));
      // Local footprint buckets. `groundHeight` has the sim's own broadphase behind
      // it, but the standability test below is a raw loop over the collider array,
      // and running that per DECK candidate (211,210 of them on dust2) against
      // 5,116 boxes is a billion inner iterations. Bucketing the footprints at BS
      // metres once turns it
      // into ~20 candidates per column and is the difference between a 20-second
      // phase and a 10-minute one. Same candidates, same verdict — a box whose
      // padded footprint misses the cell cannot be within RADIUS of it.
      const BS = 4;
      const bx0 = Math.floor(b.minX / BS) - 2;
      const bz0 = Math.floor(b.minZ / BS) - 2;
      const bw = Math.ceil((b.maxX - b.minX) / BS) + 5;
      const bh = Math.ceil((b.maxZ - b.minZ) / BS) + 5;
      const buckets: number[][] = new Array(bw * bh);
      for (let i = 0; i < bw * bh; i++) buckets[i] = [];
      for (let i = 0; i < SOL.length; i++) {
        const o = SOL[i]!;
        const ca = Math.abs(Math.cos(o.yaw));
        const sa = Math.abs(Math.sin(o.yaw));
        const hx = o.sx * 0.5 * ca + o.sz * 0.5 * sa + RADIUS + 0.1;
        const hz = o.sx * 0.5 * sa + o.sz * 0.5 * ca + RADIUS + 0.1;
        const i0 = Math.max(0, Math.floor((o.x - hx) / BS) - bx0);
        const i1 = Math.min(bw - 1, Math.floor((o.x + hx) / BS) - bx0);
        const j0 = Math.max(0, Math.floor((o.z - hz) / BS) - bz0);
        const j1 = Math.min(bh - 1, Math.floor((o.z + hz) / BS) - bz0);
        for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) buckets[j * bw + ii]!.push(i);
      }
      const nearIdx = (x: number, z: number): number[] => {
        const i = Math.floor(x / BS) - bx0;
        const j = Math.floor(z / BS) - bz0;
        return i >= 0 && j >= 0 && i < bw && j < bh ? buckets[j * bw + i]! : [];
      };
      const off: number[] = [0];
      const deckY: number[] = [];
      const deckPass: number[] = [];
      const deckPlane: number[] = [];
      for (let iz = 0; iz < h; iz++) {
        for (let ix = 0; ix < w; ix++) {
          const x = x0 + ix * st;
          const z = z0 + iz * st;
          // every climb top in this column, top-down, ending at the floor plane
          const tops: number[] = [];
          let y = groundHeight(x, z, SOL, Infinity);
          for (let n = 0; n < MAX_DECKS; n++) {
            tops.push(y);
            if (y <= fy + 1e-9) break;
            const next = groundHeight(x, z, SOL, y - 1.05 - 1e-9);
            if (!(next < y - 1e-9)) break;
            y = next;
          }
          // standability, deck by deck — the clearanceGrid test with y substituted.
          // EVERY candidate is emitted, standable or not: a deck a body cannot
          // stand on is the 2.5-D analogue of a blocked cell, and the phantom-block
          // and sealed-gap tests are defined on exactly those.
          const cand = nearIdx(x, z);
          const keep: { y: number; ok: boolean }[] = [];
          for (const dy of tops) {
            // IS THIS DECK WHERE A BODY WOULD ACTUALLY BE? `integrate()` resolves
            // the floor as `groundHeight(x, z, SOLIDS, walkFromY(p.y))` and then
            // snaps UP to it, so a candidate with a higher climb top inside the
            // mantle band is not a place: the sim would lift the body off it the
            // instant it arrived. Those candidates are real — `groundHeight`'s
            // footprint tolerance is 0.12 m and the body circle is 0.30 m, so a
            // column 0.2 m from a tread seam legitimately contains the tread below
            // as well — but a body cannot occupy them, and counting them as
            // standable is what put 1,958 "ghost cells" under the Long-A floor:
            // a deck 0.406 m under the visible floor, mantle-exempt, with that
            // floor sitting squarely in the body-height band above it.
            if (groundHeight(x, z, SOL, dy) > dy + 1e-6) {
              keep.push({ y: r3(dy), ok: false });
              continue;
            }
            let ok = true;
            for (let ci = 0; ci < cand.length; ci++) {
              const o = SOL[cand[ci]!]!;
              if (o.visual === "roof") continue;
              const top = o.y + o.sy * 0.5;
              const bot = o.y - o.sy * 0.5;
              if (dy + STAND_H < bot + 0.05 || dy > top - 0.02) continue;
              const hit = circleHitsOBB(x, z, RADIUS, o);
              if (hit.hit && hit.pen > 0) {
                if (o.climb && top - dy < 1.05 && dy + 0.2 < top) continue; // mantle rule
                ok = false;
                break;
              }
            }
            keep.push({ y: dy, ok });
          }
          keep.sort((p, q) => p.y - q.y);
          for (const d of keep) {
            deckY.push(r3(d.y));
            deckPass.push(d.ok ? 1 : 0);
            deckPlane.push(Math.abs(d.y - fy) < 1e-6 ? 1 : 0);
          }
          off.push(deckY.length);
        }
      }
      return {
        origin: [x0, z0],
        step: st,
        w,
        h,
        bounds: [r3(b.minX), r3(b.minZ), r3(b.maxX), r3(b.maxZ)],
        source: b.source,
        floorY: fy,
        off,
        deckY,
        deckPass,
        deckPlane,
        columns: w * h,
        decks: deckY.length,
      };
    } catch {
      return { origin: [-HALF, -HALF], step: 0.5, w: 0, h: 0, bounds: [-HALF, -HALF, HALF, HALF], source: "yard", floorY: fy, off: [0], deckY: [], deckPass: [], deckPlane: [], columns: 0, decks: 0 };
    }
  }

  /** The active map's world floor plane (Shipment 0, dust2 −4.95). Instruments
   *  that build their own ground model need it or they measure a world 4.95 m
   *  from the one the sim is running (see `floorY()`'s note above). */
  floorY(): number {
    return floorY();
  }

  /** Does the active map declare stacked floors? (dust2 true, Shipment false.)
   *  Instruments switch between the 2-D and 2.5-D clearance models on this, so
   *  they never guess and never hard-code a map id. */
  stackedFloors(): boolean {
    try {
      const m = (MapsModule as unknown as { activeMap?: () => { stackedFloors?: boolean } }).activeMap;
      if (typeof m === "function") return m().stackedFloors === true;
    } catch {
      /* fall through */
    }
    return false;
  }

  // -------------------------------------------------------------- eyeline --

  /** Free-cam spec at a player's true eye, looking along its yaw/pitch.
   *  Pass the result straight to __test.renderWith(). */
  eyeline(id: string): { mode: "free"; x: number; y: number; z: number; lookX: number; lookY: number; lookZ: number; fov: number } | null {
    try {
      const s = this.game.session;
      const p = s?.players.get(String(id));
      if (!s || !p) return null;
      const eye = s.eyeY(p);
      const d = aimDir(p.yaw, p.pitch);
      return {
        mode: "free",
        x: r3(p.x),
        y: r3(eye),
        z: r3(p.z),
        lookX: r3(p.x + d.dx * 4),
        lookY: r3(eye + d.dy * 4),
        lookZ: r3(p.z + d.dz * 4),
        fov: 68,
      };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- snapshot --

  /** Lightweight scene-tree dump for debugging. */
  snapshotScene(): { name: string; type: string; worldPos: [number, number, number]; visible: boolean }[] {
    try {
      const scene = this.game.world?.scene;
      if (!scene) return [];
      scene.updateMatrixWorld(true);
      const out: { name: string; type: string; worldPos: [number, number, number]; visible: boolean }[] = [];
      const v = new THREE.Vector3();
      scene.traverse((o) => {
        if (out.length >= 4000) return;
        o.getWorldPosition(v);
        out.push({ name: o.name || "", type: o.type, worldPos: [r3(v.x), r3(v.y), r3(v.z)], visible: o.visible });
      });
      return out;
    } catch {
      return [];
    }
  }

  // ========================================================== internals ==

  private byId(id: string): Rec | null {
    return this.registry().find((r) => r.el.id === id) ?? null;
  }

  private registry(): Rec[] {
    if (this.reg) return this.reg;
    this.reg = this.buildRegistry();
    return this.reg;
  }

  /**
   * WORLD-BUILDER TAG CONTRACT (read this before writing a new map's world builder)
   * ------------------------------------------------------------------------------
   * A world builder declares its QA elements by setting `userData` on the objects
   * it puts under `world.root`. Tagging is per-object and may sit at any depth:
   * buildRegistry() walks down from `world.root` until it finds a tagged object,
   * and that object becomes ONE element (its whole subtree is the element's mesh).
   *
   *   obj.userData.kind     : string  REQUIRED to be an element. The element kind.
   *                                   Use a QA_SOLID_KINDS value for anything that
   *                                   backs a sim collider — collider-audit only
   *                                   raycasts solid elements. Dressing/FX can use
   *                                   any other string ("sky", "decal", …).
   *   obj.userData.solid    : boolean OPTIONAL override of `solid`; defaults to
   *                                   QA_SOLID_KINDS.includes(kind).
   *   obj.userData.qaId     : string  OPTIONAL stable element id. Must be unique.
   *                                   Defaults to "<kind>-<n>" in traversal order —
   *                                   prefer an explicit id for anything you want to
   *                                   cite in a report (e.g. "wall-longA-north").
   *   obj.userData.qaIgnore : true    OPTIONAL — skip this object and its subtree
   *                                   entirely (sky domes, god rays, backdrop).
   *
   * Granularity rule: one element per thing a human would name. A merged 20k-tri
   * shell tagged once is legal but makes every audit offender read "shell-1"; bin
   * the merge by area (`kind:"shell", qaId:"shell-longA"`) and the evidence sheets
   * name the place instead. `elements()` also renames the tagged object to its id,
   * so instruments can find it by name in the scene graph.
   *
   * When NOTHING under world.root carries a `kind` tag, the legacy Shipment
   * positional classifier below runs unchanged (container table → landmark table →
   * nearest-collider → classifyLoose), which is why the jungle map's registry is
   * byte-identical before and after this contract existed.
   */
  private buildRegistry(): Rec[] {
    const root = this.game.world?.root;
    if (!root) return [];
    root.updateMatrixWorld(true);
    const recs: Rec[] = [];
    const counters = new Map<string, number>();
    const usedIds = new Set<string>();
    const nextId = (kind: string, tag?: string): string => {
      const key = kind + (tag ? "-" + tag : "");
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return `${key}-${n}`;
    };
    const tagOf = (o: THREE.Object3D): { kind: string; solid: boolean; qaId: string | null } | null => {
      const ud = o.userData as { kind?: unknown; solid?: unknown; qaId?: unknown };
      const k = typeof ud.kind === "string" ? ud.kind.trim() : "";
      if (!k) return null;
      return {
        kind: k,
        solid: typeof ud.solid === "boolean" ? ud.solid : SOLID_KIND_SET.has(k),
        qaId: typeof ud.qaId === "string" && ud.qaId ? ud.qaId : null,
      };
    };
    const ignored = (o: THREE.Object3D): boolean => (o.userData as { qaIgnore?: unknown }).qaIgnore === true;

    // --- tag path: any userData.kind anywhere under the root switches it on ----
    let anyTagged = false;
    root.traverse((o) => {
      if (!anyTagged && o !== root && tagOf(o)) anyTagged = true;
    });
    if (anyTagged) {
      const box0 = new THREE.Box3();
      const queue: THREE.Object3D[] = [...root.children];
      for (let qi = 0; qi < queue.length; qi++) {
        const node = queue[qi]!;
        try {
          if (ignored(node)) continue;
          const tag = tagOf(node);
          if (!tag) {
            // untagged: descend if a tag lives below, else classify it the old way
            let below = false;
            node.traverse((c) => {
              if (!below && c !== node && tagOf(c)) below = true;
            });
            if (below) {
              queue.push(...node.children);
              continue;
            }
          }
          box0.setFromObject(node);
          if (box0.isEmpty()) box0.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
          const center = box0.getCenter(new THREE.Vector3());
          const wp = node.getWorldPosition(new THREE.Vector3());
          const anchorX = wp.x !== 0 || wp.z !== 0 ? wp.x : center.x;
          const anchorZ = wp.x !== 0 || wp.z !== 0 ? wp.z : center.z;
          const kind = tag ? tag.kind : this.classifyLoose(node, box0);
          let id = tag?.qaId ?? nextId(kind);
          while (usedIds.has(id)) id = nextId(kind);
          usedIds.add(id);
          node.name = id;
          (node.userData as { __qaEl?: string }).__qaEl = id;
          let meshCount = 0;
          node.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) meshCount++;
          });
          recs.push({
            obj: node,
            el: {
              id,
              kind,
              name: id,
              x: r3(anchorX),
              y: r3(center.y),
              z: r3(anchorZ),
              bbox: {
                min: [r3(box0.min.x), r3(box0.min.y), r3(box0.min.z)],
                max: [r3(box0.max.x), r3(box0.max.y), r3(box0.max.z)],
              },
              meshCount,
              solid: tag ? tag.solid : SOLID_KIND_SET.has(kind),
              source: tag ? "tag" : "loose",
            },
          });
        } catch {
          /* skip unclassifiable node */
        }
      }
      return recs;
    }

    // known instance anchors from map data / jungle-world layout
    const wrecked = (c: (typeof VISUAL_CONTAINERS)[number]): boolean => c.open && Math.abs(c.yaw) > 0.3;
    const containerAt = (x: number, z: number) =>
      VISUAL_CONTAINERS.find((c) => Math.abs(c.x - x) < 0.02 && Math.abs(c.z - z) < 0.02) ?? null;
    const SOL = solids();
    const props = SOL.map((o, i) => ({ o, i })).filter(
      ({ o }) => o.visual && !["container", "cwall", "roof"].includes(o.visual),
    );
    const usedProps = new Set<number>();
    const landmarks = [
      { x: 11.4, z: -11.1, kind: "crate-spill" },
      { x: -14.1, z: 1.7, kind: "wreck-junk" },
      { x: 14.1, z: -1.7, kind: "wreck-junk" },
      { x: -13.0, z: 10.6, kind: "tire-stack" },
      { x: 12.6, z: 9.2, kind: "pallet" },
    ];
    const usedLm = new Set<number>();

    const box = new THREE.Box3();
    for (const child of root.children) {
      try {
        box.setFromObject(child);
        if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
        const center = box.getCenter(new THREE.Vector3());
        const anchorX = child.position.x !== 0 || child.position.z !== 0 ? child.position.x : center.x;
        const anchorZ = child.position.x !== 0 || child.position.z !== 0 ? child.position.z : center.z;

        let kind = "";
        let id = "";
        let source: InspectElement["source"] = "loose";
        // 1) container groups (exact layout positions)
        const c = containerAt(child.position.x, child.position.z);
        if (c && (child as THREE.Group).isGroup) {
          const color = wrecked(c) ? (c.x > 0 ? "red" : "green") : c.color;
          kind = wrecked(c) ? "wreck" : c.open ? "walkthrough" : "container";
          id = nextId(kind, color);
          source = "container";
        }
        // 2) landmark dressing groups
        if (!kind) {
          for (let i = 0; i < landmarks.length; i++) {
            const lm = landmarks[i]!;
            if (!usedLm.has(i) && Math.hypot(anchorX - lm.x, anchorZ - lm.z) < 1.6) {
              usedLm.add(i);
              kind = lm.kind;
              id = nextId(kind);
              source = "landmark";
              break;
            }
          }
        }
        // 3) collider-backed props (crate/barrel/dumpster/car/forklift/wall)
        if (!kind) {
          let best = -1;
          let bestD = 1.6;
          for (const { o, i } of props) {
            if (usedProps.has(i)) continue;
            const d = Math.hypot(anchorX - o.x, anchorZ - o.z);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          if (best >= 0) {
            usedProps.add(best);
            const o = SOL[best]!;
            kind = o.visual!;
            source = "prop";
            if (kind === "wall") {
              const side = Math.abs(o.x) > Math.abs(o.z) ? (o.x > 0 ? "e" : "w") : o.z > 0 ? "s" : "n";
              id = `wall-${side}`;
            } else id = nextId(kind);
          }
        }
        // 4) everything else by shape/material heuristics
        if (!kind) {
          const h = this.classifyLoose(child, box);
          kind = h;
          id = nextId(kind);
        }

        child.name = child.name || id;
        let meshCount = 0;
        child.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) meshCount++;
        });
        recs.push({
          obj: child,
          el: {
            id,
            kind,
            name: child.name,
            x: r3(anchorX),
            y: r3(center.y),
            z: r3(anchorZ),
            bbox: {
              min: [r3(box.min.x), r3(box.min.y), r3(box.min.z)],
              max: [r3(box.max.x), r3(box.max.y), r3(box.max.z)],
            },
            meshCount,
            solid: SOLID_KIND_SET.has(kind),
            source,
          },
        });
      } catch {
        /* skip unclassifiable child */
      }
    }
    return recs;
  }

  /** Heuristic classification for the unnamed merged/perimeter meshes. */
  private classifyLoose(child: THREE.Object3D, box: THREE.Box3): string {
    const mesh = child as THREE.Mesh;
    if ((child as THREE.Points).isPoints) return "drifting-leaves";
    if (!mesh.isMesh) return "misc";
    const geo = mesh.geometry as THREE.BufferGeometry & { parameters?: Record<string, number> };
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z);
    if (geo.type === "PlaneGeometry" && geo.parameters) {
      const w = geo.parameters.width ?? 0;
      if (w > 100) return "jungle-floor";
      if (Math.abs(w - (YARD + 7)) < 0.5) return "yard-ground";
      if (Math.abs(w - 41) < 0.5) return "ground-decals";
    }
    if (geo.type === "CylinderGeometry" && (geo.parameters?.radiusTop ?? 0) > 40) return "hedge-ring";
    if (mat && (mat as THREE.Material as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
      if (mat.blending === THREE.AdditiveBlending) return "god-rays";
      if (mat.map && mat.alphaTest > 0.4 && span > 40) return "canopy-cards";
    }
    if (mat && mat.isMeshStandardMaterial) {
      const alphaCut = mat.alphaTest > 0.3;
      if (alphaCut && span < 4) return "understory-leaf";
      if (alphaCut && box.min.y > 1.5) return "palm-crowns";
      if (alphaCut) return "understory";
      if (!mat.map && mat.color.g > mat.color.r && span > 8) return "bamboo";
      if (!mat.map && mat.color.r > mat.color.g && box.max.y < 1.6 && span > 8) return "banana-litter";
      if (mat.map && span > 30 && box.max.y > 3.5) return "palm-trunks";
      if (mat.map && span > 20 && box.max.y < 3.2) return "iso-castings";
    }
    return "misc";
  }

  // ------------------------------------------------------------ dimming ---

  private applyDim(filter: (o: THREE.Object3D) => boolean, preset: DimPreset): void {
    const root = this.game.world?.root;
    if (!root) return;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
      if (!filter(o)) return;
      const target = o as THREE.Mesh;
      const orig = target.material;
      if (!orig) return;
      this.dimmed.push({ obj: target, mat: orig });
      target.material = Array.isArray(orig) ? orig.map((mm) => this.dimMaterial(mm, preset)) : this.dimMaterial(orig, preset);
    });
  }

  private dimMaterial(mat: THREE.Material, preset: DimPreset): THREE.Material {
    const key = mat.uuid + "|" + preset;
    const cached = this.dimCache.get(key);
    if (cached) return cached;
    const clone = mat.clone();
    const c = clone as THREE.MeshStandardMaterial;
    const alphaCut = (mat as THREE.MeshStandardMaterial).alphaTest > 0.01;
    if (!alphaCut && "map" in c) c.map = null;
    if ("emissiveIntensity" in c) c.emissiveIntensity = 0;
    if ("color" in c && c.color) {
      if (preset === "black") c.color.setHex(0x0d120d);
      else {
        const src = (mat as THREE.MeshStandardMaterial).color;
        const lum = src ? src.r * 0.3 + src.g * 0.59 + src.b * 0.11 : 0.5;
        // alpha-cutout foliage keeps its map (cutting needs texture alpha), so
        // darken harder to compensate for the still-textured albedo.
        c.color.setScalar(alphaCut ? 0.16 : 0.3 + lum * 0.4);
      }
    }
    if (preset === "gray" && !alphaCut) {
      clone.transparent = true;
      clone.opacity = 0.12;
      clone.depthWrite = false;
    }
    clone.needsUpdate = true;
    this.dimCache.set(key, clone);
    return clone;
  }

  private clearDim(): void {
    for (const rec of this.dimmed) (rec.obj as THREE.Mesh).material = rec.mat;
    this.dimmed.length = 0;
    for (const [, m] of this.dimCache) m.dispose();
    this.dimCache.clear();
  }

  private dressSceneDark(scene: THREE.Scene): void {
    if (this.sceneDressed) return;
    this.sceneDressed = true;
    this.savedBg = scene.background as THREE.Color | THREE.Texture | null;
    this.savedFog = scene.fog as THREE.Fog | null;
    scene.background = new THREE.Color(0x060806);
    scene.fog = null;
  }

  private undressScene(): void {
    if (!this.sceneDressed) return;
    const scene = this.game.world?.scene;
    if (scene) {
      scene.background = this.savedBg;
      scene.fog = this.savedFog;
    }
    this.sceneDressed = false;
    this.savedBg = null;
    this.savedFog = null;
  }

  private buildXrayGroup(): THREE.Group {
    const g = new THREE.Group();
    g.name = "inspect-xray";
    const fill = new THREE.MeshBasicMaterial({
      color: 0x2aff70,
      transparent: true,
      opacity: 0.16,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const edge = new THREE.LineBasicMaterial({ color: 0x9dffbc, transparent: true, opacity: 0.95, depthTest: false });
    solids().forEach((o, i) => {
      const geo = new THREE.BoxGeometry(o.sx, o.sy, o.sz);
      const mesh = new THREE.Mesh(geo, fill);
      mesh.position.set(o.x, o.y, o.z);
      mesh.rotation.y = o.yaw;
      mesh.renderOrder = 996;
      mesh.frustumCulled = false;
      g.add(mesh);
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge);
      lines.position.copy(mesh.position);
      lines.rotation.y = o.yaw;
      lines.renderOrder = 997;
      lines.frustumCulled = false;
      g.add(lines);
      const label = this.makeLabel("col-" + i);
      label.position.set(o.x, o.y + o.sy * 0.5 + 0.16, o.z);
      g.add(label);
    });
    return g;
  }

  private makeLabel(text: string): THREE.Sprite {
    const cv = document.createElement("canvas");
    cv.width = 128;
    cv.height = 40;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, 128, 40);
    ctx.fillStyle = "#b8ffd0";
    ctx.font = "bold 20px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 64, 21);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
    sp.scale.set(0.78, 0.24, 1);
    sp.renderOrder = 999;
    return sp;
  }
}

export function installInspect(game: Game): Inspector {
  const insp = new Inspector(game);
  (window as unknown as { __inspect: Inspector }).__inspect = insp;
  return insp;
}
