import * as THREE from "three";
import type { Game } from "./game";
import { simMap, BOT_NAV, EYE } from "@shared/sim";
import { traceWorld } from "@shared/map";
import { stableShadowRegistry } from "./shadow-stability";

/**
 * ZERO-FLICKER, LAYER 3 — the in-page half of the flicker detector.
 *
 * Loaded only by the ?test harness (client/src/test.ts) and driven by
 * scripts/qa/flicker-gate.mjs and scripts/qa/depth-probe.mjs on a REAL GPU.
 * It works on any map id: every viewpoint comes from the map's own data
 * (spawns, bot-nav nodes, traceWorld for sightlines and ceilings).
 *
 * Per viewpoint it renders an OBJECT-ID G-buffer (RGBA32F: key = object*64 +
 * material group, instance id, linear view depth, packed FACE normal from
 * screen derivatives) with every material's depth state copied verbatim —
 * side, depthTest/Write/Func, polygonOffset, alphaTest cutouts, transparency —
 * so the ID pass z-fights exactly where the real frame does. Then:
 *
 *  - PEEL: a second ID pass discards each pixel's front object, exposing the
 *    nearest DIFFERENT surface. Two parallel surfaces closer than the depth
 *    buffer's resolving power at that distance (tolerance per depth mode) =
 *    a z-fight hazard, deterministic, no luck involved.
 *  - JITTER: the ID pass re-rendered with sub-millimetre camera jitter and a
 *    tiny rotation; a pixel whose id flips while the depth and face normal
 *    under it do not (and that the peel saw as a hazard) is OBSERVED z-fight.
 *    This is what decides polygonOffset decals: offset geometry is a hazard on
 *    paper and only fails if it actually flips.
 *  - TRANSPARENT: blended surfaces drawn last with depthWrite off, as in the
 *    real frame: one coplanar with an opaque surface is a depth-test flicker;
 *    two whose draw order flips under jitter is an alpha-sort pop.
 *  - LIT, STATIC: the graded final frame, camera still, world clock stepped:
 *    every non-animated pixel must be bit-stable.
 *  - LIT, MOTION: the camera moved 7 / 23 mm (sub-texel and multi-texel for
 *    every shadow map we ship) and the new frame REPROJECTED into the old one
 *    through the ID depth. A shadow frustum that is not texel-snapped, acne
 *    that crawls, a z-fight: all change world-locked shading, which a
 *    reprojection exposes and plain sub-pixel aliasing does not.
 *  - SHADOW FRUSTA: analytically, every shadow-casting directional light whose
 *    shadow camera moves with the view must move by whole texels.
 */

type V3 = [number, number, number];
export type Pose = { name: string; kind: string; pos: V3; dir: V3; fov: number; vm?: boolean };

export type FlickerFinding = {
  kind: "zfight" | "zfight-observed" | "zfight-transparent" | "alpha-sort" | "temporal" | "shimmer" | "shadow-unsnapped" | "mitigated";
  view: string;
  a: string;
  b?: string;
  pixels: number;
  world: V3;
  dist: number;
  gapMm?: number;
  maxDelta?: number;
  bbox: [number, number, number, number];
  crop?: string;
  detail?: string;
  /** World-space corners of one fighting triangle on each side: where to fix it. */
  tris?: (number[][] | null)[];
};

type ObjInfo = { obj: THREE.Object3D; name: string; polygonOffset: boolean[]; transparent: boolean[]; animated: boolean };

// --------------------------------------------------------------- ID shading

const ID_VERT = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
attribute float idTri;
uniform float uTriMul;
flat varying float vInst;
varying vec3 vViewPos;
#ifdef ID_UV
uniform mat3 uUvXform;
varying vec2 vIdUv;
#endif
void main() {
#ifdef ID_UV
  vIdUv = (uUvXform * vec3(uv, 1.0)).xy;
#endif
  #include <morphinstance_vertex>
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vViewPos = mvPosition.xyz;
  // surface id = instance and TRIANGLE, so two coplanar triangles of one
  // merged mesh are told apart too (uTriMul = 0 when it would not fit 2^24)
#ifdef USE_INSTANCING
  vInst = float(gl_InstanceID) * uTriMul + (uTriMul > 0.0 ? idTri : 0.0);
#else
  vInst = uTriMul > 0.0 ? idTri : 0.0;
#endif
}`;

const ID_FRAG = /* glsl */ `
uniform float uKey;
uniform float uOpacity;
uniform float uAlphaTest;
uniform float uPeel;
uniform highp sampler2D uPrev;
#ifdef ID_MAP
uniform sampler2D uMap;
#endif
#ifdef ID_ALPHAMAP
uniform sampler2D uAlphaMap;
#endif
flat varying float vInst;
varying vec3 vViewPos;
#ifdef ID_UV
varying vec2 vIdUv;
#endif
float packN(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 o = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  vec2 q = floor(clamp(o * 0.5 + 0.5, 0.0, 1.0) * 2047.0 + 0.5);
  return q.x * 2048.0 + q.y;
}
void main() {
  float a = uOpacity;
#ifdef ID_MAP
  a *= texture2D(uMap, vIdUv).a;
#endif
#ifdef ID_ALPHAMAP
  a *= texture2D(uAlphaMap, vIdUv).g;
#endif
#ifdef ID_CUTOUT
  if (a < uAlphaTest) discard;
#endif
#ifdef ID_BLEND
  if (a < 0.02) discard;
#endif
  if (uPeel > 0.5) {
    vec4 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0);
    if (prev.x == uKey && prev.y == vInst) discard;
  }
  vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  gl_FragColor = vec4(uKey, vInst, -vViewPos.z, packN(n));
}`;

function unpackN(p: number, out: Float32Array, o: number): void {
  const qx = Math.floor(p / 2048);
  const qy = p - qx * 2048;
  let x = (qx / 2047) * 2 - 1;
  let y = (qy / 2047) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z) || 1;
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A name a human can act on. Many procedural meshes are unnamed, so the
 * parent chain is followed by the geometry type, its world-space size and the
 * material (name or type + colour + map) — enough to grep the builder for it.
 */
function pathName(o: THREE.Object3D): string {
  const parts: string[] = [];
  for (let n: THREE.Object3D | null = o; n && !(n as THREE.Scene).isScene; n = n.parent) {
    const label = n.userData?.qaId || n.name;
    if (label) parts.push(String(label));
  }
  const mesh = o as THREE.Mesh;
  const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
  const desc = (x: THREE.Material) => {
    const c = (x as THREE.MeshStandardMaterial).color;
    const map = (x as THREE.MeshStandardMaterial).map;
    return `${x.name || x.type.replace("Material", "")}${c ? ` #${c.getHexString()}` : ""}${map ? ` map:${map.name || map.image?.width + "x" + map.image?.height || "tex"}` : ""}${x.polygonOffset ? " pOff" : ""}${x.transparent ? " blend" : ""}${x.alphaTest ? ` cut${x.alphaTest}` : ""}`;
  };
  const mat = Array.isArray(m) ? m.map(desc).join("|") : m ? desc(m) : "";
  let size = "";
  if (mesh.geometry) {
    mesh.geometry.computeBoundingBox?.();
    const bb = mesh.geometry.boundingBox;
    if (bb) {
      const v = bb.getSize(new THREE.Vector3()).multiply(o.getWorldScale(new THREE.Vector3()));
      size = ` ${v.x.toFixed(2)}x${v.y.toFixed(2)}x${v.z.toFixed(2)}`;
    }
  }
  const inst = (o as THREE.InstancedMesh).isInstancedMesh ? ` inst${(o as THREE.InstancedMesh).count}` : "";
  const geo = mesh.geometry ? mesh.geometry.type.replace("Geometry", "") : o.type;
  return `${parts.reverse().join("/") || `${o.type}#${o.id}`} <${geo}${size}${inst}> [${mat}]`;
}

function qaIgnored(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (n.userData?.qaIgnore) return true;
  return false;
}

// ------------------------------------------------------------- the module

export class FlickerQA {
  readonly THREE = THREE;
  private objs: ObjInfo[] = [{ obj: new THREE.Object3D(), name: "(background)", polygonOffset: [], transparent: [], animated: false }];
  private index = new WeakMap<THREE.Object3D, number>();
  private idCache = new Map<number, (THREE.ShaderMaterial | null)[]>();
  private shared = { uPeel: { value: 0 }, uPrev: { value: null as THREE.Texture | null } };
  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtP: THREE.WebGLRenderTarget | null = null;
  private w = 0;
  private h = 0;
  private frozenDraw: ((dt: number) => void) | null = null;

  constructor(private game: Game) {}

  /**
   * The frame's depth configuration. A build without depth-precision.ts (the
   * pre-overhaul baseline the gate measures "before" on) is the standard path.
   */
  private get depth(): Pick<Game["depth"], "mode" | "reason" | "floatDepth" | "viewmodelPass"> {
    return (this.game as Partial<Game>).depth ?? { mode: "standard", reason: "no depth-precision layer (baseline build)", floatDepth: false, viewmodelPass: null };
  }

  // ---------------------------------------------------------------- info
  info(): Record<string, unknown> {
    const g = this.game;
    const size = g.renderer.getDrawingBufferSize(new THREE.Vector2());
    const gl = g.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      map: simMap().id,
      depthMode: this.depth.mode,
      depthReason: this.depth.reason,
      floatDepth: this.depth.floatDepth,
      near: g.camera.near,
      far: g.camera.far,
      size: [size.x, size.y],
      samples: g.composer.renderTarget1.samples,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      clipControl: !!gl.getExtension("EXT_clip_control"),
    };
  }

  /** Stop the game's own frames from moving the camera between captures. */
  freeze(on: boolean): void {
    const g = this.game as unknown as { draw: (dt: number) => void };
    if (on && !this.frozenDraw) {
      this.frozenDraw = g.draw;
      g.draw = () => {};
    } else if (!on && this.frozenDraw) {
      g.draw = this.frozenDraw;
      this.frozenDraw = null;
    }
    for (const id of ["hud", "hint", "boot", "menu"]) document.getElementById(id)?.classList.toggle("hidden", on);
  }

  // ------------------------------------------------------------ viewpoints
  viewpoints(n = 48, seed = 1): Pose[] {
    const MAP = simMap();
    const rnd = mulberry32(seed);
    const out: Pose[] = [];
    const dirYaw = (yaw: number, pitch = 0): V3 => [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const push = (p: Pose) => { p.pos = p.pos.map(r3) as V3; p.dir = p.dir.map((v) => Math.round(v * 1e5) / 1e5) as V3; out.push(p); };
    const trace = (x: number, y: number, z: number, d: V3, max = 400) => traceWorld(x, y, z, d[0], d[1], d[2], max).t;
    // spawns, four headings each — what every player sees first
    MAP.spawns.forEach((s, i) => {
      if (i % Math.max(1, Math.ceil(MAP.spawns.length / 6)) !== 0) return;
      for (let k = 0; k < 2; k++) push({ name: `spawn${i}-h${k}`, kind: "spawn", pos: [s.x, s.y + EYE, s.z], dir: dirYaw(s.yaw + Math.PI + k * Math.PI, 0), fov: 68 });
    });
    // first-person with the viewmodel (the gun can z-fight with itself)
    push(this.fpPose());
    const nav = BOT_NAV.length ? BOT_NAV : MAP.spawns.map((s) => ({ x: s.x, y: s.y, z: s.z }));
    const pick = () => nav[Math.floor(rnd() * nav.length)]!;
    const budget = Math.max(8, n - out.length - 2);
    for (let i = 0; i < budget; i++) {
      const p = pick();
      const eye = p.y + (rnd() < 0.2 ? 1.12 : EYE);
      const kind = ["random", "grazing", "long", "interior"][i % 4]!;
      if (kind === "random") {
        push({ name: `nav${i}-rand`, kind, pos: [p.x, eye, p.z], dir: dirYaw(rnd() * Math.PI * 2, (rnd() - 0.6) * 0.7), fov: 68 });
      } else if (kind === "grazing") {
        // Find the nearest wall and look ALONG it, nose to the floor: the two
        // grazing planes where a depth slope is steepest.
        let best = Infinity, bestYaw = 0;
        for (let k = 0; k < 16; k++) {
          const yaw = (k / 16) * Math.PI * 2;
          const t = trace(p.x, eye, p.z, dirYaw(yaw), 30);
          if (t < best) { best = t; bestYaw = yaw; }
        }
        const along = bestYaw + Math.PI / 2 + (rnd() - 0.5) * 0.25;
        push({ name: `nav${i}-graze`, kind, pos: [p.x, eye, p.z], dir: dirYaw(along, -0.06 - rnd() * 0.12), fov: 68 });
      } else if (kind === "long") {
        let best = 0, bestYaw = 0;
        for (let k = 0; k < 32; k++) {
          const yaw = (k / 32) * Math.PI * 2;
          const t = trace(p.x, eye, p.z, dirYaw(yaw), 400);
          if (t > best) { best = t; bestYaw = yaw; }
        }
        // zoomed like a scope: z-fight at range fills more pixels
        push({ name: `nav${i}-long${Math.round(best)}m`, kind, pos: [p.x, eye, p.z], dir: dirYaw(bestYaw, -0.02), fov: rnd() < 0.5 ? 30 : 68 });
      } else {
        const up = trace(p.x, eye, p.z, [0, 1, 0], 12);
        const pitch = up < 12 ? 0.35 + rnd() * 0.5 : (rnd() - 0.5) * 0.3;
        push({ name: `nav${i}-${up < 12 ? "ceiling" : "open"}`, kind: up < 12 ? "interior" : "random", pos: [p.x, eye, p.z], dir: dirYaw(rnd() * Math.PI * 2, pitch), fov: 68 });
      }
    }
    // two overviews: roofs, tops of walls, the far field
    const b = MAP.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    push({ name: "overview-ne", kind: "overview", pos: [cx + span * 0.45, span * 0.42, cz + span * 0.45], dir: norm([-0.6, -0.5, -0.6]), fov: 55 });
    push({ name: "overview-sw", kind: "overview", pos: [cx - span * 0.45, span * 0.3, cz - span * 0.4], dir: norm([0.6, -0.42, 0.55]), fov: 55 });
    // map-authored coverage (rooms / stairs / roofs on every storey): always added
    const extra = (MAP.qaViews ?? []).map((v) => ({ ...v, pos: [...v.pos] as V3, dir: [...v.dir] as V3 }));
    return [...out.slice(0, Math.max(n, 12)), ...extra];
  }

  /**
   * The real first-person pose: the game draws a few frames from the first
   * spawn (sim stepped through the ?test rig), so the viewmodel carries its
   * genuine idle pose, then the camera is read back as a Pose.
   */
  fpPose(): Pose {
    const g = this.game;
    const rig = (window as unknown as { __test?: { step(t: number): void; place(x: number, z: number, yaw?: number, pitch?: number): void } }).__test;
    const frozen = !!this.frozenDraw;
    if (frozen) this.freeze(false);
    const s = simMap().spawns[0]!;
    rig?.place(s.x, s.z, s.yaw, -0.05);
    rig?.step(30);
    if (frozen) this.freeze(true);
    const cam = g.camera;
    cam.updateMatrixWorld(true);
    const d = cam.getWorldDirection(new THREE.Vector3());
    return { name: "fp-vm", kind: "fp", pos: cam.position.toArray() as V3, dir: d.toArray() as V3, fov: cam.fov, vm: true };
  }

  // ------------------------------------------------------------ camera
  private place(p: Pose, dpos: V3 = [0, 0, 0], drot = 0): void {
    const cam = this.game.camera;
    cam.position.set(p.pos[0] + dpos[0], p.pos[1] + dpos[1], p.pos[2] + dpos[2]);
    const t = new THREE.Vector3(p.pos[0] + p.dir[0], p.pos[1] + p.dir[1], p.pos[2] + p.dir[2]).add(new THREE.Vector3(...dpos));
    cam.up.set(0, 1, 0);
    cam.lookAt(t);
    if (drot) cam.rotateY(drot), cam.rotateX(drot * 0.7);
    cam.fov = p.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.game.vm.root.visible = !!p.vm;
  }

  // ------------------------------------------------------------ ID pass
  private ensureTargets(): void {
    const size = this.game.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.rtA && this.w === size.x && this.h === size.y) return;
    this.rtA?.dispose();
    this.rtP?.dispose();
    this.w = size.x;
    this.h = size.y;
    const mk = () => {
      const rt = new THREE.WebGLRenderTarget(this.w, this.h, {
        type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: true, samples: 0,
      });
      // Same depth format as the frame under test, so the ID pass fights
      // exactly where the real frame would.
      if (this.depth.floatDepth) rt.depthTexture = new THREE.DepthTexture(this.w, this.h, THREE.FloatType);
      return rt;
    };
    this.rtA = mk();
    this.rtP = mk();
  }

  private objIndex(o: THREE.Object3D): number {
    let i = this.index.get(o);
    if (i === undefined) {
      const mats = ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? []);
      i = this.objs.length;
      let attached = false;
      for (let a: THREE.Object3D | null = o; a; a = a.parent) if (a === this.game.camera) attached = true;
      // camera-attached (the viewmodel) moves WITH the camera: never world-locked
      const animated = attached || mats.some((m) => !!(m as THREE.ShaderMaterial).uniforms?.uTime) || !!o.userData?.animated || (o as THREE.SkinnedMesh).isSkinnedMesh === true;
      this.objs.push({
        obj: o,
        name: pathName(o),
        polygonOffset: mats.map((m) => m.polygonOffset && (m.polygonOffsetFactor < 0 || m.polygonOffsetUnits < 0)),
        transparent: mats.map((m) => m.transparent),
        animated,
      });
      this.index.set(o, i);
    }
    return i;
  }

  private idGeos = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  /** Non-indexed copy with a per-triangle id attribute (cached per geometry). */
  private idGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
    if (g.getAttribute("idTri")) return g;
    let ng = this.idGeos.get(g);
    if (!ng) {
      ng = g.index ? g.toNonIndexed() : g.clone();
      const n = ng.getAttribute("position").count;
      const tri = new Float32Array(n);
      for (let i = 0; i < n; i++) tri[i] = Math.floor(i / 3);
      ng.setAttribute("idTri", new THREE.BufferAttribute(tri, 1));
      this.idGeos.set(g, ng);
    }
    return ng;
  }

  private triMul(o: THREE.Mesh): number {
    const g = o.geometry;
    const tris = Math.ceil((g.index ? g.index.count : g.getAttribute("position").count) / 3);
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    return tris * inst < 2 ** 24 ? tris : 0;
  }

  private idMaterial(o: THREE.Mesh, src: THREE.Material, group: number): THREE.ShaderMaterial {
    const idx = this.objIndex(o);
    let list = this.idCache.get(idx);
    if (!list) this.idCache.set(idx, (list = []));
    const cached = list[group];
    if (cached && cached.userData.src === src) return cached;
    const s = src as THREE.MeshStandardMaterial;
    const defines: Record<string, string> = {};
    const cut = s.alphaTest > 0;
    const blend = s.transparent;
    const map = (cut || blend) && s.map ? s.map : null;
    const amap = (cut || blend) && s.alphaMap ? s.alphaMap : null;
    if (map) defines.ID_MAP = "";
    if (amap) defines.ID_ALPHAMAP = "";
    if (map || amap) defines.ID_UV = "";
    if (cut) defines.ID_CUTOUT = "";
    if (blend) defines.ID_BLEND = "";
    const tex = map ?? amap;
    if (tex?.matrixAutoUpdate) tex.updateMatrix();
    const m = new THREE.ShaderMaterial({
      vertexShader: ID_VERT,
      fragmentShader: ID_FRAG,
      defines,
      uniforms: {
        uKey: { value: idx * 64 + Math.min(group, 63) },
        uTriMul: { value: this.triMul(o) },
        uOpacity: { value: blend ? s.opacity : 1 },
        uAlphaTest: { value: s.alphaTest },
        uMap: { value: map },
        uAlphaMap: { value: amap },
        uUvXform: { value: tex ? tex.matrix : new THREE.Matrix3() },
        uPeel: this.shared.uPeel,
        uPrev: this.shared.uPrev,
      },
      side: s.side,
      depthTest: s.depthTest,
      depthWrite: s.depthWrite,
      depthFunc: s.depthFunc,
      colorWrite: s.colorWrite,
      polygonOffset: s.polygonOffset,
      polygonOffsetFactor: s.polygonOffsetFactor,
      polygonOffsetUnits: s.polygonOffsetUnits,
      transparent: blend,
      blending: THREE.NoBlending,
      wireframe: (s as unknown as { wireframe?: boolean }).wireframe ?? false,
      visible: s.visible,
    });
    m.userData.src = src;
    m.userData.blend = blend;
    list[group] = m;
    return m;
  }

  /**
   * Swap every mesh to its ID material, hide what is not a surface (sprites,
   * points, lines, qaIgnore FX). Returns the undo.
   */
  /** Objects the fx mask must also cover (whatever moved across a clock step). */
  private extraFx = new Set<THREE.Object3D>();

  private swap(mode: "opaque" | "all" | "fxmask"): () => void {
    const scene = this.game.world!.scene;
    const undo: (() => void)[] = [];
    const bg = scene.background, fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    undo.push(() => { scene.background = bg; scene.fog = fog; });
    scene.traverse((o) => {
      if (!o.visible) return;
      const mesh = o as THREE.Mesh;
      const isSurface = mesh.isMesh && !(o as THREE.Sprite).isSprite && !(o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh;
      const fx = !isSurface || qaIgnored(o) || (mode === "fxmask" && this.extraFx.has(o));
      if (mode === "fxmask") {
        // depth from the surfaces (colour masked), colour only from the FX
        if (!fx && mesh.isMesh) {
          const orig = mesh.material;
          const mats = ([] as THREE.Material[]).concat(orig).map((m, gi) => this.idMaterial(mesh, m, gi));
          const prevCW = mats.map((m) => m.colorWrite);
          mats.forEach((m) => { m.colorWrite = false; });
          mesh.material = Array.isArray(orig) ? mats : mats[0]!;
          undo.push(() => { mesh.material = orig; mats.forEach((m, i) => { m.colorWrite = prevCW[i]!; }); });
        } else if (fx) {
          const mats = ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? []);
          if (mats.some((m) => m.depthTest === false)) {
            // depthTest:false backdrops (sky domes) would mask the whole frame
            o.visible = false;
            undo.push(() => { o.visible = true; });
          }
        }
        return;
      }
      if (fx) {
        // weapons stream: a Bone is a container too — hiding it hid everything an
        // operator carries (gun, frag, EVA helmet) from every ID pass while the lit
        // frame still drew it, so those were never checked and read as shimmer.
        if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera || (o as THREE.Bone).isBone || o.type === "Group" || o.type === "Object3D" || (o as THREE.Scene).isScene) return;
        o.visible = false;
        undo.push(() => { o.visible = true; });
        return;
      }
      const orig = mesh.material;
      const origGeo = mesh.geometry;
      this.objIndex(mesh); // named while it still carries its own geometry
      mesh.geometry = this.idGeometry(origGeo);
      undo.push(() => { mesh.geometry = origGeo; });
      const list = ([] as THREE.Material[]).concat(orig);
      const mats = list.map((m, gi) => {
        const id = this.idMaterial(mesh, m, gi);
        const want = m.visible && (mode === "all" || !id.userData.blend);
        if (id.visible !== want) id.visible = want;
        return id;
      });
      mesh.material = Array.isArray(orig) ? mats : mats[0]!;
      undo.push(() => { mesh.material = orig; });
    });
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i]!(); };
  }

  private renderTo(rt: THREE.WebGLRenderTarget, mode: "opaque" | "all" | "fxmask", peel: THREE.Texture | null): Float32Array {
    const g = this.game;
    const r = g.renderer;
    const restore = this.swap(mode);
    const cc = r.getClearColor(new THREE.Color());
    const ca = r.getClearAlpha();
    const sAuto = r.shadowMap.autoUpdate, sNeeds = r.shadowMap.needsUpdate;
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = false;
    this.shared.uPeel.value = peel ? 1 : 0;
    this.shared.uPrev.value = peel;
    try {
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(rt);
      r.clear(true, true, true);
      const vmPass = this.depth.viewmodelPass;
      if (vmPass) vmPass.tagLayers();
      r.render(g.world!.scene, g.camera);
      if (vmPass && g.vm.root.visible) vmPass.render(r, rt, rt);
      const buf = new Float32Array(this.w * this.h * 4);
      r.readRenderTargetPixels(rt, 0, 0, this.w, this.h, buf);
      return buf;
    } finally {
      this.shared.uPeel.value = 0;
      this.shared.uPrev.value = null;
      r.setRenderTarget(null);
      r.setClearColor(cc, ca);
      r.shadowMap.autoUpdate = sAuto;
      r.shadowMap.needsUpdate = sNeeds;
      restore();
    }
  }

  private lit(): Uint8Array {
    const g = this.game;
    g.grade.uniforms.uTime!.value = 1.0; // film grain frozen: the gate measures the WORLD
    g.composer.render(0);
    const gl = g.renderer.getContext();
    g.renderer.setRenderTarget(null);
    const buf = new Uint8Array(this.w * this.h * 4);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  // -------------------------------------------------------- tolerances
  /** Smallest depth separation this frame's depth buffer reliably resolves at view depth z. */
  private resolve(z: number, camDist: number): number {
    const d = this.depth;
    const near = this.game.camera.near;
    if (d.floatDepth) return Math.max(z * 2.4e-7, 1e-6) + camDist * 6e-8;
    return (z * z) / (near * 16777216);
  }

  // ----------------------------------------------------------- analysis
  /**
   * Capture and analyse one viewpoint. Everything heavy stays in the page;
   * the gate receives findings with crops.
   */
  inspect(p: Pose, opts: { crops?: boolean; lit?: boolean; jitter?: number; minPx?: number; shadow?: boolean } = {}): { view: string; findings: FlickerFinding[]; stats: Record<string, number> } {
    const g = this.game;
    this.ensureTargets();
    const W = this.w, H = this.h, N = W * H;
    const minPx = opts.minPx ?? 6;
    const t0 = performance.now();
    this.place(p);
    const camPos = g.camera.position.clone();
    const camDist = camPos.length();
    const A0 = this.renderTo(this.rtA!, "opaque", null);
    const P0 = this.renderTo(this.rtP!, "opaque", this.rtA!.texture);
    const B0 = this.renderTo(this.rtP!, "all", null);
    const nA = new Float32Array(3), nB = new Float32Array(3);
    const parallel = (pa: number, pb: number, cos: number) => {
      unpackN(pa, nA, 0);
      unpackN(pb, nB, 0);
      return Math.abs(nA[0]! * nB[0]! + nA[1]! * nB[1]! + nA[2]! * nB[2]!) >= cos;
    };
    const COS3 = Math.cos((3 * Math.PI) / 180);
    // px keeps a bounded sample for centroid/crop; n is the true count
    type Acc = { kind: FlickerFinding["kind"]; a: number; b: number; ai: number; bi: number; px: number[]; n: number; gap: number; maxDelta: number };
    const acc = new Map<string, Acc>();
    const add = (kind: FlickerFinding["kind"], a: number, ai: number, b: number, bi: number, i: number, gap = 0, delta = 0) => {
      // one finding per OBJECT pair (or object, or object-with-itself); the
      // triangle ids only decide whether two surfaces are distinct
      const k = `${kind}#${b < 0 ? a : a === b ? `${a}|self` : a < b ? `${a}|${b}` : `${b}|${a}`}`;
      let r = acc.get(k);
      if (!r) acc.set(k, (r = { kind, a, b, ai, bi, px: [], n: 0, gap: Infinity, maxDelta: 0 }));
      if (r.px.length < 4096) r.px.push(i);
      r.n++;
      r.gap = Math.min(r.gap, gap);
      r.maxDelta = Math.max(r.maxDelta, delta);
    };
    const objOf = (key: number) => Math.floor(key / 64);
    const grpOf = (key: number) => key - objOf(key) * 64;
    const offsetOf = (key: number) => this.objs[objOf(key)]?.polygonOffset[grpOf(key)] ?? false;

    // ---- PEEL hazard (opaque vs opaque) ------------------------------
    const hazard = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const ka = A0[o]!, kb = P0[o]!;
      if (ka === 0 || kb === 0) continue;
      const za = A0[o + 2]!, zb = P0[o + 2]!;
      const gap = zb - za;
      const tol = 2 * this.resolve(za, camDist) + 2e-5;
      if (Math.abs(gap) > tol) continue;
      if (!parallel(A0[o + 3]!, P0[o + 3]!, COS3)) continue;
      hazard[i] = 1;
    }
    // A fight is an AREA. Two faces crossing at a degree or two are within
    // tolerance only along a band ~tol/tan(angle) wide around their
    // intersection line — a stable crease, not flicker — so the hazard is
    // eroded by one pixel before it counts: lines vanish, overlaps stay.
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!(hazard[i] && hazard[i - 1] && hazard[i + 1] && hazard[i - W] && hazard[i + W] && hazard[i - W - 1] && hazard[i - W + 1] && hazard[i + W - 1] && hazard[i + W + 1])) continue;
      const o = i * 4;
      const ka = A0[o]!, kb = P0[o]!;
      const mitigated = offsetOf(ka) !== offsetOf(kb);
      add(mitigated ? "mitigated" : "zfight", ka, A0[o + 1]!, kb, P0[o + 1]!, i, Math.abs(P0[o + 2]! - A0[o + 2]!));
    }
    // ERODE the hazard mask by one pixel for the jitter test: inside a
    // coplanar overlap every pixel is hazard whichever surface wins, while the
    // rim of a decal (hazard inside, plain wall outside) is a legitimate edge
    // that moves under jitter and must not count as an observed fight.
    const hazardD = new Uint8Array(N);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (hazard[i] && hazard[i - 1] && hazard[i + 1] && hazard[i - W] && hazard[i + W] && hazard[i - W - 1] && hazard[i - W + 1] && hazard[i + W - 1] && hazard[i + W + 1]) hazardD[i] = 1;
    }

    // ---- transparent coplanar with opaque (depth-test flicker) --------
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const kb = B0[o]!, ka = A0[o]!;
      if (kb === 0 || ka === 0 || kb === ka) continue;
      const tb = this.objs[objOf(kb)]?.transparent[grpOf(kb)];
      if (!tb) continue;
      const zb = B0[o + 2]!, za = A0[o + 2]!;
      const gap = za - zb;
      const tol = 2 * this.resolve(za, camDist) + 2e-5;
      if (Math.abs(gap) > tol || !parallel(A0[o + 3]!, B0[o + 3]!, COS3)) continue;
      if (offsetOf(kb)) add("mitigated", kb, B0[o + 1]!, ka, A0[o + 1]!, i, Math.abs(gap));
      else add("zfight-transparent", kb, B0[o + 1]!, ka, A0[o + 1]!, i, Math.abs(gap));
    }

    // ---- JITTER flips -------------------------------------------------
    const J = opts.jitter ?? 3;
    const jit: [V3, number][] = [
      [[0.00031, -0.00017, 0.00023], 0],
      [[-0.00019, 0.00027, -0.00011], 4e-5],
      [[0, 0, 0], 1.1e-4],
    ];
    const flipMask = new Uint8Array(N);
    for (let j = 0; j < Math.min(J, jit.length); j++) {
      this.place(p, jit[j]![0], jit[j]![1]);
      const Aj = this.renderTo(this.rtA!, "opaque", null);
      const Bj = this.renderTo(this.rtA!, "all", null);
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        // opaque flips inside the (eroded) hazard area
        const k0 = A0[o]!, kj = Aj[o]!;
        // ...and only a flip onto the very surface the peel found behind this
        // pixel: a seam between two triangles of one flat face also "flips"
        // under jitter, and is not a fight.
        if (k0 !== 0 && kj !== 0 && (k0 !== kj || A0[o + 1] !== Aj[o + 1]) && hazardD[i] && kj === P0[o] && Aj[o + 1] === P0[o + 1]) {
          const z = A0[o + 2]!;
          const tol = Math.max(4 * this.resolve(z, camDist) + 2e-5, 0.0005);
          if (Math.abs(Aj[o + 2]! - z) <= tol && parallel(A0[o + 3]!, Aj[o + 3]!, COS3)) {
            flipMask[i] = 1;
            add("zfight-observed", k0, A0[o + 1]!, kj, Aj[o + 1]!, i, Math.abs(Aj[o + 2]! - z));
          }
        }
        // blended surfaces: draw-order pops between two transparents
        const b0 = B0[o]!, bj = Bj[o]!;
        if (b0 !== 0 && bj !== 0 && b0 !== bj) {
          const t0b = this.objs[objOf(b0)]?.transparent[grpOf(b0)];
          const tjb = this.objs[objOf(bj)]?.transparent[grpOf(bj)];
          if (t0b && tjb && Math.abs(Bj[o + 2]! - B0[o + 2]!) < 0.02 * B0[o + 2]! && !this.isEdge(B0, i, W, H)) add("alpha-sort", b0, B0[o + 1]!, bj, Bj[o + 1]!, i);
        }
      }
    }
    this.place(p);

    // ---- LIT tests ----------------------------------------------------
    let litStats = { staticPx: 0, shimmerPx: 0 };
    let F0: Uint8Array | null = null;
    if (opts.lit !== false) {
      // What moves on its own (swaying fronds, a rotating planet, a pulsing
      // beacon, uTime shaders) is found by diffing transforms and material
      // state across a 1 ms clock step — not by a hand-kept list — and joins
      // the FX mask, so a planet turning BEHIND a window masks those pixels too.
      const update = g.world!.update;
      const before = this.animationState();
      update(0.001, g.camera);
      g.world!.scene.updateMatrixWorld(true);
      const moved = this.animatedSince(before);
      this.extraFx = new Set([...moved].map((i) => this.objs[i]!.obj));
      for (const info of this.objs) if (info.animated) this.extraFx.add(info.obj);
      const fx = this.renderTo(this.rtP!, "fxmask", null);
      this.extraFx = new Set();
      const fxMask = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        if (fx[o]! > 0.002 || fx[o + 1]! > 0.002 || fx[o + 2]! > 0.002) fxMask[i] = 1;
      }
      const edge = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (this.isEdge(A0, i, W, H) || this.isEdge(B0, i, W, H)) edge[i] = 1;
      const edgeD = dilate(edge, W, H, 1);
      const fxD = dilate(fxMask, W, H, 2);
      F0 = this.lit();
      // (1) static camera. Frame A re-renders with NO clock step (catches
      // nondeterminism: ping-pong targets that disagree, unstable sorting,
      // uninitialised buffers). Frame B steps the world clock 1 ms: anything
      // time-driven on a static surface shows, legitimate motion stays
      // sub-pixel. What the step moved (a swaying frond, a pulsing beacon, a
      // uTime shader) is found by diffing transforms and material state — not
      // by a hand-kept list — and pixels whose surface changed are skipped.
      // Shadow maps are held for B: with a still camera and a still sun a
      // correct shadow map cannot change by itself.
      const Fsame = this.lit();
      update(0.001, g.camera);
      g.world!.scene.updateMatrixWorld(true);
      const isAnimated = (k: number) => this.objs[objOf(k)]?.animated || moved.has(objOf(k));
      const Bt = this.renderTo(this.rtA!, "all", null);
      const shadowAuto = g.renderer.shadowMap.autoUpdate;
      g.renderer.shadowMap.autoUpdate = false;
      const Fstep = this.lit();
      g.renderer.shadowMap.autoUpdate = shadowAuto;
      for (const F of [Fsame, Fstep]) {
        for (let i = 0; i < N; i++) {
          if (fxD[i]) continue;
          const k = B0[i * 4]!;
          if (k === 0 || isAnimated(k) || Bt[i * 4] !== k) continue;
          const o = i * 4;
          const d = Math.max(Math.abs(F[o]! - F0[o]!), Math.abs(F[o + 1]! - F0[o + 1]!), Math.abs(F[o + 2]! - F0[o + 2]!));
          if (d > 6) { add("temporal", k, B0[o + 1]!, -1, 0, i, 0, d); litStats.staticPx++; }
        }
      }
      // re-render the base after the clock steps so the motion test compares like with like
      F0 = this.lit();
      // (2) camera moved, new frame reprojected into the old one
      const right = new THREE.Vector3().setFromMatrixColumn(g.camera.matrixWorld, 0);
      const fwd = g.camera.getWorldDirection(new THREE.Vector3());
      const moves: V3[] = [
        right.clone().multiplyScalar(0.007).addScaledVector(fwd, 0.003).toArray() as V3,
        right.clone().multiplyScalar(-0.016).addScaledVector(fwd, 0.017).toArray() as V3,
      ];
      const P = new THREE.Vector3();
      const view0 = g.camera.matrixWorld.clone();
      const tanY = Math.tan(THREE.MathUtils.degToRad(g.camera.fov) / 2), tanX = tanY * g.camera.aspect;
      for (const mv of moves) {
        this.place(p, mv);
        const A1 = this.renderTo(this.rtA!, "all", null);
        const F1 = this.lit();
        const vp = new THREE.Matrix4().multiplyMatrices(g.camera.projectionMatrix, g.camera.matrixWorldInverse);
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * W + x, o = i * 4;
          if (edgeD[i] || fxD[i]) continue;
          const k = B0[o]!;
          if (k === 0 || isAnimated(k)) continue;
          // a blended surface's pixel mixes in whatever lies behind it at
          // another depth (stars at infinity through a window): not reprojectable
          if (this.objs[objOf(k)]?.transparent[grpOf(k)]) continue;
          const z = B0[o + 2]!;
          // pixel -> camera space -> world
          const nx = ((x + 0.5) / W) * 2 - 1, ny = ((y + 0.5) / H) * 2 - 1;
          P.set(nx * tanX * z, ny * tanY * z, -z).applyMatrix4(view0);
          const cz = P.clone().applyMatrix4(g.camera.matrixWorldInverse).z;
          P.applyMatrix4(vp);
          const sx = (P.x * 0.5 + 0.5) * W - 0.5, sy = (P.y * 0.5 + 0.5) * H - 0.5;
          const x0 = Math.floor(sx), y0 = Math.floor(sy);
          if (x0 < 1 || y0 < 1 || x0 >= W - 2 || y0 >= H - 2) continue;
          // occluded or not the same surface after the move: not comparable
          const j0 = (y0 * W + x0) * 4;
          if (A1[j0] !== k || Math.abs(A1[j0 + 2]! + cz) > 0.01 * z + 0.002) continue;
          // Neighbourhood clamp (the TAA test): a static, world-locked pixel's
          // colour must still exist somewhere in the 4x4 footprint around its
          // reprojected position. Resampling and sub-pixel aliasing stay inside
          // that range; a surface swap (z-fight), a sort pop, a crawling shadow
          // texel or acne flip does not.
          // A feature one pixel thin (a texture groove, a painted line) cannot
          // be reconstructed at another sub-pixel phase — that is texture
          // aliasing, bounded by its own local contrast — so the allowance
          // grows with the base frame's 3x3 contrast.
          let worst = 0;
          for (let c = 0; c < 3; c++) {
            let lo = 255, hi = 0, lo0 = 255, hi0 = 0;
            for (let yy = y0 - 1; yy <= y0 + 2; yy++) for (let xx = x0 - 1; xx <= x0 + 2; xx++) {
              const q = F1[(yy * W + xx) * 4 + c]!;
              if (q < lo) lo = q;
              if (q > hi) hi = q;
            }
            for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
              const q = F0[(yy * W + xx) * 4 + c]!;
              if (q < lo0) lo0 = q;
              if (q > hi0) hi0 = q;
            }
            const v = F0[o + c]!;
            worst = Math.max(worst, lo - v - 0.5 * (hi0 - lo0), v - hi - 0.5 * (hi0 - lo0));
          }
          if (worst > 12) { add("shimmer", k, B0[o + 1]!, -1, 0, i, 0, worst); litStats.shimmerPx++; }
        }
      }
      this.place(p);
    }

    // ---- shadow frusta that follow the view -----------------------------
    const findings: FlickerFinding[] = [];
    if (opts.shadow) for (const f of this.shadowFrustumCheck(p)) findings.push(f);

    // ---- collect --------------------------------------------------------
    const crop = (pxs: number[], kind: string) => (opts.crops !== false && F0 ? this.crop(F0, pxs, kind) : undefined);
    const thresholds: Partial<Record<FlickerFinding["kind"], number>> = {
      zfight: minPx, "zfight-observed": 3, "zfight-transparent": minPx, "alpha-sort": minPx, temporal: minPx, shimmer: 24, mitigated: minPx,
    };
    for (const r of acc.values()) {
      if (r.n < (thresholds[r.kind] ?? minPx)) continue;
      // A fight is one contiguous area, not the same two (merged) meshes
      // touching in scattered single pixels across the frame: keep the largest
      // cluster (pixels within 2 px of each other) and judge that.
      r.px = largestCluster(r.px, W);
      const n = r.kind === "shimmer" || r.kind === "temporal" ? r.n : Math.min(r.n, r.px.length);
      if (r.px.length < (thresholds[r.kind] ?? minPx)) continue;
      // centroid + bbox in GL pixel space (y up)
      let sx = 0, sy = 0, sz = 0, minx = W, miny = H, maxx = 0, maxy = 0;
      for (const i of r.px) {
        const x = i % W, y = (i - x) / W;
        sx += x; sy += y; sz += (B0[i * 4 + 2] || A0[i * 4 + 2])!;
        minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      }
      const cnt = r.px.length;
      const cx = sx / cnt, cy = sy / cnt, cz = sz / cnt;
      const world = this.unproject(cx, cy, cz);
      findings.push({
        kind: r.kind,
        view: p.name,
        a: this.objs[objOf(r.a)]?.name ?? `#${r.a}`,
        b: r.b >= 0 ? this.objs[objOf(r.b)]?.name ?? `#${r.b}` : undefined,
        pixels: n,
        world: world.map((v) => Math.round(v * 1000) / 1000) as V3,
        dist: Math.round(cz * 100) / 100,
        gapMm: Number.isFinite(r.gap) && r.kind !== "temporal" && r.kind !== "shimmer" ? Math.round(r.gap * 1e6) / 1e3 : undefined,
        maxDelta: r.maxDelta || undefined,
        bbox: [minx, H - 1 - maxy, maxx, H - 1 - miny],
        crop: r.kind === "mitigated" ? undefined : crop(r.px, r.kind),
        tris: r.b >= 0 ? [this.triangleWorld(r.a, r.ai), this.triangleWorld(r.b, r.bi)] : undefined,
      });
    }
    this.place(p);
    return {
      view: p.name,
      findings,
      stats: { ms: Math.round(performance.now() - t0), hazardPx: hazard.reduce((s, v) => s + v, 0), flipPx: flipMask.reduce((s, v) => s + v, 0), ...litStats },
    };
  }

  /** World corners of triangle `surface` (instance*triMul + tri) of the object behind `key`. */
  private triangleWorld(key: number, surface: number): number[][] | null {
    const info = this.objs[Math.floor(key / 64)];
    const mesh = info?.obj as THREE.Mesh | undefined;
    if (!mesh?.isMesh) return null;
    const mul = this.triMul(mesh);
    if (!mul) return null;
    const inst = Math.floor(surface / mul), tri = surface - inst * mul;
    const g = mesh.geometry, pos = g.getAttribute("position"), idx = g.getIndex();
    const m = mesh.matrixWorld.clone();
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const im = new THREE.Matrix4();
      (mesh as THREE.InstancedMesh).getMatrixAt(inst, im);
      m.multiply(im);
    }
    const out: number[][] = [];
    for (let c = 0; c < 3; c++) {
      const vi = idx ? idx.getX(tri * 3 + c) : tri * 3 + c;
      if (vi === undefined || vi >= pos.count) return null;
      out.push(new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(m).toArray().map((v) => Math.round(v * 1e4) / 1e4));
    }
    return out;
  }

  /** Transform + material fingerprint of every mesh, for animatedSince(). */
  private animationState(): Map<THREE.Object3D, string> {
    const st = new Map<THREE.Object3D, string>();
    this.game.world!.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
      const mats = ([] as THREE.Material[]).concat(mesh.material ?? []);
      const mf = mats.map((m) => {
        const x = m as THREE.MeshStandardMaterial & THREE.ShaderMaterial;
        const u = x.uniforms ? Object.values(x.uniforms).map((v) => (typeof v.value === "number" ? v.value : "")).join(",") : "";
        return `${x.color?.getHexString() ?? ""}${x.emissive?.getHexString() ?? ""}${x.opacity}${x.emissiveIntensity ?? ""}${u}${x.map?.offset?.x ?? ""}${x.map?.offset?.y ?? ""}`;
      });
      const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).instanceMatrix.version : 0;
      st.set(o, `${o.matrixWorld.elements.join(",")}|${inst}|${mf.join("|")}|${o.visible}`);
    });
    return st;
  }

  private animatedSince(before: Map<THREE.Object3D, string>): Set<number> {
    const now = this.animationState();
    const out = new Set<number>();
    for (const [o, v] of now) if (before.get(o) !== v) out.add(this.objIndex(o));
    return out;
  }

  /** A pixel on a real geometric edge: a neighbour is another surface at another depth or angle. */
  private isEdge(B: Float32Array, i: number, W: number, H: number): boolean {
    const x = i % W, y = (i - x) / W;
    const o = i * 4;
    const k = B[o]!, z = B[o + 2]!, n = B[o + 3]!;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) return true;
      const q = (yy * W + xx) * 4;
      if (B[q] !== k) return true; // another object (triangle seams inside one are not edges)
      if (Math.abs(B[q + 2]! - z) > 0.004 * z + 0.002) return true;
      if (B[q + 3] !== n) return true; // a crease: lighting is discontinuous there
    }
    return false;
  }

  private unproject(x: number, y: number, z: number): V3 {
    const cam = this.game.camera;
    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const nx = ((x + 0.5) / this.w) * 2 - 1, ny = ((y + 0.5) / this.h) * 2 - 1;
    const v = new THREE.Vector3(nx * tanY * cam.aspect * z, ny * tanY * z, -z).applyMatrix4(cam.matrixWorld);
    return [v.x, v.y, v.z];
  }

  private crop(F: Uint8Array, pxs: number[], kind: string): string {
    const W = this.w, H = this.h;
    let minx = W, miny = H, maxx = 0, maxy = 0;
    for (const i of pxs) {
      const x = i % W, y = (i - x) / W;
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
    }
    const pad = 28;
    let w = Math.max(96, maxx - minx + 1 + pad * 2), h = Math.max(96, maxy - miny + 1 + pad * 2);
    w = Math.min(w, 480); h = Math.min(h, 360);
    const x0 = Math.max(0, Math.min(W - w, Math.round((minx + maxx) / 2 - w / 2)));
    const y0 = Math.max(0, Math.min(H - h, Math.round((miny + maxy) / 2 - h / 2)));
    const scale = w < 200 ? 2 : 1;
    const c = document.createElement("canvas");
    c.width = w * 2 * scale + 4;
    c.height = h * scale;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    const mark = new Set(pxs);
    const over = ctx.createImageData(w, h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const sx = x0 + xx, sy = y0 + (h - 1 - yy); // GL rows are bottom-up
      const s = (sy * W + sx) * 4, d = (yy * w + xx) * 4;
      for (let k = 0; k < 3; k++) img.data[d + k] = F[s + k]!;
      img.data[d + 3] = 255;
      const hit = mark.has(sy * W + sx);
      over.data[d] = hit ? 255 : F[s]! * 0.45;
      over.data[d + 1] = hit ? 30 : F[s + 1]! * 0.45;
      over.data[d + 2] = hit ? 200 : F[s + 2]! * 0.45;
      over.data[d + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    tctx.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, w * scale, h * scale);
    tctx.putImageData(over, 0, 0);
    ctx.drawImage(tmp, w * scale + 4, 0, w * scale, h * scale);
    ctx.fillStyle = "#fff";
    ctx.font = "11px monospace";
    ctx.fillText(kind, 4, 12);
    return c.toDataURL("image/jpeg", 0.85);
  }

  /** Full graded frame for before/after documentation (JPEG data URL). */
  screenshot(p: Pose, quality = 0.82): string {
    this.ensureTargets();
    this.place(p);
    const F = this.lit();
    const c = document.createElement("canvas");
    c.width = this.w; c.height = this.h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(this.w, this.h);
    for (let y = 0; y < this.h; y++) img.data.set(F.subarray((this.h - 1 - y) * this.w * 4, (this.h - y) * this.w * 4), y * this.w * 4);
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/jpeg", quality);
  }

  // ----------------------------------------------------- shadow frusta
  /**
   * Every shadow-casting directional light: render from the pose and from the
   * pose moved by an awkward non-texel distance; a shadow camera that moved
   * must have moved by whole texels in its own plane, and must not rotate.
   */
  shadowFrustumCheck(p: Pose): FlickerFinding[] {
    const g = this.game;
    const out: FlickerFinding[] = [];
    if (!g.renderer.shadowMap.enabled) return out;
    const lights: THREE.DirectionalLight[] = [];
    g.world!.scene.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight && o.castShadow) lights.push(o as THREE.DirectionalLight); });
    if (!lights.length) return out;
    const snap = (): THREE.Matrix4[] => lights.map((l) => l.shadow.camera.matrixWorld.clone());
    this.place(p);
    this.lit();
    const m0 = snap();
    for (const mv of [[0.137, 0.021, -0.311], [-1.913, 0.07, 2.471]] as V3[]) {
      this.place(p, mv);
      this.lit();
      const m1 = snap();
      lights.forEach((l, li) => {
        const a = m0[li]!, b = m1[li]!;
        if (a.equals(b)) return;
        const cam = l.shadow.camera;
        const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), ta = new THREE.Vector3(), tb = new THREE.Vector3(), s = new THREE.Vector3();
        a.decompose(ta, qa, s);
        b.decompose(tb, qb, s);
        const rot = qa.angleTo(qb);
        const d = tb.sub(ta).applyQuaternion(qa.clone().invert());
        const tx = (cam.right - cam.left) / cam.zoom / l.shadow.mapSize.x;
        const ty = (cam.top - cam.bottom) / cam.zoom / l.shadow.mapSize.y;
        const fx = Math.abs(d.x / tx - Math.round(d.x / tx)), fy = Math.abs(d.y / ty - Math.round(d.y / ty));
        if (rot > 1e-6 || fx > 0.01 || fy > 0.01) {
          out.push({
            kind: "shadow-unsnapped", view: p.name, a: pathName(l), pixels: 0, world: p.pos, dist: 0, bbox: [0, 0, 0, 0],
            detail: `shadow camera moved ${d.x.toFixed(4)},${d.y.toFixed(4)} m in light space = ${(d.x / tx).toFixed(3)},${(d.y / ty).toFixed(3)} texels (texel ${(tx * 1000).toFixed(2)} mm), rotated ${rot.toExponential(2)} rad`,
          });
        }
      });
    }
    this.place(p);
    this.lit();
    return out.slice(0, 1);
  }

  /** Stable-shadow lights registered by world builders (shadow-stability.ts). */
  stableShadows(): { name: string; texelMm: number; snapped: boolean }[] {
    return stableShadowRegistry().map((s) => ({ name: s.name, texelMm: s.texel() * 1000, snapped: s.snap }));
  }

  // ------------------------------------------------- live-scene export
  /**
   * World-space triangles of every visible surface, in the dump format that
   * scripts/qa/zfight-scan.mjs reads: { meta, bin } (bin base64).
   */
  exportTriangles(): { meta: unknown; bin: string } {
    const scene = this.game.world!.scene;
    scene.updateMatrixWorld(true);
    const meshes: Record<string, unknown>[] = [];
    const pos: number[] = [];
    const meshIndex: number[] = [];
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const inst = new THREE.Matrix4(), world = new THREE.Matrix4();
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.Sprite).isSprite || qaIgnored(o)) return;
      for (let a: THREE.Object3D | null = o; a; a = a.parent) if (a === this.game.camera) return; // the viewmodel is not the map
      const geo = mesh.geometry;
      const P = geo.getAttribute("position");
      if (!P) return;
      const idx = geo.getIndex();
      const mats = ([] as THREE.Material[]).concat(mesh.material);
      const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx ? idx.count : P.count, materialIndex: 0 }];
      const count = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
      for (const gr of groups) {
        const m = mats[gr.materialIndex ?? 0] ?? mats[0]!;
        if (!m.visible) continue;
        const mi = meshes.length;
        meshes.push({
          name: `${pathName(o)}${groups.length > 1 ? `#g${gr.materialIndex}` : ""}`,
          doubleSided: m.side === THREE.DoubleSide,
          transparent: m.transparent,
          depthWrite: m.depthWrite,
          depthTest: m.depthTest,
          polygonOffset: m.polygonOffset ? [m.polygonOffsetFactor, m.polygonOffsetUnits] : null,
          alphaTest: m.alphaTest,
          renderOrder: o.renderOrder,
          qaIgnore: false,
          material: m.name || m.type,
        });
        for (let k = 0; k < count; k++) {
          world.copy(mesh.matrixWorld);
          if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
            (mesh as THREE.InstancedMesh).getMatrixAt(k, inst);
            world.multiply(inst);
          }
          const mirrored = world.determinant() < 0;
          const end = Math.min(gr.start + gr.count, idx ? idx.count : P.count);
          for (let t = gr.start; t + 2 < end; t += 3) {
            for (let c = 0; c < 3; c++) v[c]!.fromBufferAttribute(P, idx ? idx.getX(t + c) : t + c).applyMatrix4(world);
            // a mirrored transform flips winding; keep the dump's front faces honest
            const [p0, p1, p2] = mirrored ? [v[0]!, v[2]!, v[1]!] : [v[0]!, v[1]!, v[2]!];
            pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
            meshIndex.push(mi);
          }
        }
      }
    });
    const n = meshIndex.length;
    const bytes = new Uint8Array(n * 9 * 4 + n * 4);
    new Float32Array(bytes.buffer, 0, n * 9).set(pos);
    new Uint32Array(bytes.buffer, n * 9 * 4, n).set(meshIndex);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { meta: { meshes, triangles: n, hasUvs: false, map: simMap().id }, bin: btoa(bin) };
  }

  // ------------------------------------------------------ perf probe
  /**
   * GPU-inclusive frame cost of the full composer path at a pose: each frame
   * is followed by a 1-pixel readback, so the timer covers the GPU work, not
   * just command submission. Median of `frames`, after a warm-up.
   */
  perfProbe(p: Pose, frames = 60): { median: number; p90: number } {
    const g = this.game;
    this.ensureTargets();
    this.place(p);
    const gl = g.renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => {
      g.renderer.setRenderTarget(null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    for (let i = 0; i < 8; i++) g.composer.render(1 / 60);
    sync();
    // batches of back-to-back frames, synced once: throughput, immune to the
    // 0.1 ms timer quantum a per-frame timer drowns in
    const batches: number[] = [];
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) g.composer.render(1 / 60);
      sync();
      batches.push((performance.now() - t0) / frames);
    }
    batches.sort((a, b) => a - b);
    return { median: batches[2]!, p90: batches[4]! };
  }

  // -------------------------------------------------- transparency audit
  /**
   * Blended surfaces are where sorting pops live. Lists every blended mesh,
   * flags hard-edged alpha that should be a cutout (alphaTest +
   * alphaToCoverage: no sorting, MSAA-smooth edges), and pairs of blended
   * meshes that overlap in space with the SAME renderOrder — their draw order
   * is decided by camera distance and flips as the player walks.
   */
  transparencyAudit(): { blended: Record<string, unknown>[]; cutoutCandidates: string[]; ambiguous: string[][] } {
    const list: { o: THREE.Mesh; box: THREE.Box3; name: string; order: number }[] = [];
    const cutout: string[] = [];
    const blended: Record<string, unknown>[] = [];
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    this.game.world!.scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || qaIgnored(o)) return;
      for (let a: THREE.Object3D | null = o; a; a = a.parent) if (a === this.game.camera) return;
      const mats = ([] as THREE.Material[]).concat(mesh.material);
      const m = mats.find((x) => x.transparent && x.visible) as THREE.MeshStandardMaterial | undefined;
      if (!m) return;
      const name = pathName(o);
      const box = new THREE.Box3().setFromObject(o);
      list.push({ o: mesh, box, name, order: o.renderOrder });
      blended.push({ name, renderOrder: o.renderOrder, depthWrite: m.depthWrite, opacity: m.opacity, blending: m.blending, alphaTest: m.alphaTest });
      const img = m.map?.image as CanvasImageSource | undefined;
      if (img && m.blending === THREE.NormalBlending) {
        try {
          ctx.clearRect(0, 0, 64, 64);
          ctx.drawImage(img, 0, 0, 64, 64);
          const d = ctx.getImageData(0, 0, 64, 64).data;
          let mid = 0, clear = 0;
          for (let i = 3; i < d.length; i += 4) {
            if (d[i]! < 20) clear++;
            else if (d[i]! < 235) mid++;
          }
          if (clear > 64 && mid < 0.03 * 4096 && m.opacity > 0.95) cutout.push(name);
        } catch { /* tainted or not drawable: skip */ }
      }
    });
    const ambiguous: string[][] = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!, b = list[j]!;
      if (a.order !== b.order || a.o === b.o) continue;
      if (a.box.clone().expandByScalar(0.25).intersectsBox(b.box)) ambiguous.push([a.name, b.name]);
    }
    return { blended, cutoutCandidates: cutout, ambiguous: ambiguous.slice(0, 50) };
  }

  // ------------------------------------------------------ self-test
  /**
   * POSITIVE CONTROLS. Builds known faults floating in front of spawn 0 (or
   * removes them) and returns one pose per fault plus what the gate must say:
   * a detector that has never been shown a z-fight proves nothing by passing.
   */
  selftestFaults(on: boolean): { pose: Pose; expect: string[]; forbid: string[]; objects: string }[] {
    const g = this.game;
    const scene = g.world!.scene;
    const old = scene.getObjectByName("flicker-selftest");
    if (old) {
      old.removeFromParent();
      const l = old.userData.light as THREE.DirectionalLight | undefined;
      if (l) { l.removeFromParent(); l.target.removeFromParent(); }
      scene.onBeforeRender = old.userData.prevBefore ?? scene.onBeforeRender;
    }
    if (!on) return [];
    const s = simMap().spawns[0]!;
    const yaw = s.yaw + Math.PI;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const eye = new THREE.Vector3(s.x, s.y + EYE + 6, s.z); // above the yard: nothing of the map behind the faults
    const root = new THREE.Group();
    root.name = "flicker-selftest";
    scene.add(root);
    const quad = (name: string, color: number, at: THREE.Vector3, opts: Partial<THREE.MeshStandardMaterialParameters> = {}, size = 1.2) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 3, 3), new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts }));
      m.name = name;
      m.position.copy(at);
      m.lookAt(at.clone().addScaledVector(fwd, -3.2)); // faces its own pose camera
      m.rotateY(0.5); // a depth slope across the quad, like a wall seen at an angle
      root.add(m);
      return m;
    };
    const out: { pose: Pose; expect: string[]; forbid: string[]; objects: string }[] = [];
    const slot = (i: number) => eye.clone().addScaledVector(fwd, 4).addScaledVector(right, (i - 2) * 8).add(new THREE.Vector3(0, -0.5, 0));
    const poseFor = (i: number, name: string): Pose => {
      const c = slot(i);
      const pos = c.clone().addScaledVector(fwd, -3.2);
      const d = c.clone().sub(pos).normalize();
      return { name, kind: "selftest", pos: pos.toArray() as V3, dir: d.toArray() as V3, fov: 50 };
    };
    const nrm = (m: THREE.Mesh) => new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion);
    // 0: two meshes, one plane
    { const a = quad("st-zfight-a", 0xd02020, slot(0)); const b = quad("st-zfight-b", 0x20d020, slot(0), {}, 0.9); b.quaternion.copy(a.quaternion); }
    out.push({ pose: poseFor(0, "selftest-zfight"), expect: ["zfight"], forbid: [], objects: "st-zfight" });
    // 1: the same, mitigated by polygonOffset on the decal
    { const a = quad("st-offset-wall", 0xd02020, slot(1)); const b = quad("st-offset-decal", 0x20d020, slot(1), { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }, 0.9); b.quaternion.copy(a.quaternion); }
    out.push({ pose: poseFor(1, "selftest-offset"), expect: ["mitigated"], forbid: ["zfight", "zfight-observed"], objects: "st-offset" });
    // 2: a decal lifted 5 mm — the shipped rule
    { const a = quad("st-lift-wall", 0xd0d020, slot(2)); const b = quad("st-lift-decal", 0x2020d0, slot(2), {}, 0.9); b.quaternion.copy(a.quaternion); b.position.addScaledVector(nrm(a), 0.005); }
    out.push({ pose: poseFor(2, "selftest-lift5mm"), expect: [], forbid: ["zfight", "zfight-observed", "zfight-transparent", "shimmer", "temporal", "mitigated"], objects: "st-lift" });
    // 3: a blended decal coplanar with its wall, no offset
    { const a = quad("st-blend-wall", 0x808080, slot(3)); const b = quad("st-blend-decal", 0xff40ff, slot(3), { transparent: true, opacity: 0.7, depthWrite: false }, 0.9); b.quaternion.copy(a.quaternion); }
    out.push({ pose: poseFor(3, "selftest-blend"), expect: ["zfight-transparent"], forbid: [], objects: "st-blend" });
    // 4: ONE merged mesh whose two halves overlap in one plane (merged-geometry z-fight)
    {
      const a = new THREE.PlaneGeometry(1.2, 1.2, 2, 2), b = new THREE.PlaneGeometry(1.0, 1.0, 3, 3);
      b.translate(0.1, 0.05, 0);
      const uv = b.getAttribute("uv") as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3.7 + 0.3, uv.getY(i) * 2.9);
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const x = c.getContext("2d")!; for (let i = 0; i < 64; i += 8) for (let j = 0; j < 64; j += 8) { x.fillStyle = (i + j) % 16 ? "#fff" : "#222"; x.fillRect(i, j, 8, 8); }
      const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const geo = new THREE.BufferGeometry();
      const merged = [a, b].map((q) => q.toNonIndexed());
      for (const attr of ["position", "normal", "uv"]) {
        const arr = merged.flatMap((q) => Array.from((q.getAttribute(attr) as THREE.BufferAttribute).array as Float32Array));
        geo.setAttribute(attr, new THREE.Float32BufferAttribute(arr, attr === "uv" ? 2 : 3));
      }
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
      m.name = "st-merged-self";
      m.position.copy(slot(4)); m.lookAt(slot(4).addScaledVector(fwd, -3.2)); m.rotateY(0.5);
      root.add(m);
    }
    out.push({ pose: poseFor(4, "selftest-self"), expect: ["zfight"], forbid: [], objects: "st-merged" });
    // 5: a camera-following shadow that is NOT texel-snapped
    {
      const l = new THREE.DirectionalLight(0xffffff, 0.01);
      l.name = "st-unsnapped-sun";
      l.castShadow = true;
      l.shadow.mapSize.set(1024, 1024);
      Object.assign(l.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 80 });
      l.shadow.camera.updateProjectionMatrix();
      scene.add(l, l.target);
      root.userData.light = l;
      root.userData.prevBefore = scene.onBeforeRender;
      const prev = scene.onBeforeRender;
      scene.onBeforeRender = function (this: THREE.Scene, ...a: Parameters<THREE.Object3D["onBeforeRender"]>) {
        prev.apply(this, a);
        const cam = a[2] as THREE.Camera;
        l.target.position.copy(cam.position);
        l.position.copy(cam.position).add(new THREE.Vector3(20, 30, 10));
        l.target.updateMatrixWorld(); l.updateMatrixWorld();
      };
    }
    out.push({ pose: poseFor(2, "selftest-unsnapped-shadow"), expect: ["shadow-unsnapped"], forbid: [], objects: "st-unsnapped" });
    scene.updateMatrixWorld(true);
    return out;
  }

  // ------------------------------------------------------ depth probe
  /**
   * Smallest separation at which a red plane in front of a green one wins on
   * every pixel, at a given distance, through the game's own composer and
   * depth configuration. Facing the camera and at a grazing 78 degrees.
   */
  depthProbe(distances = [10, 25, 50, 100, 200]): { mode: string; near: number; floatDepth: boolean; rows: { dist: number; facingMm: number; grazingMm: number }[] } {
    const g = this.game;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const cam = new THREE.PerspectiveCamera(68, g.camera.aspect, g.camera.near, g.camera.far);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    const back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    scene.add(front, back, cam);
    const passes = g.composer.passes as unknown as { scene?: THREE.Scene; camera?: THREE.Camera; enabled: boolean }[];
    const rp = passes.find((x) => x.scene === g.world!.scene && x.camera === g.camera)!;
    const vmVisible = g.vm.root.visible;
    g.vm.root.visible = false;
    rp.scene = scene;
    rp.camera = cam;
    this.ensureTargets();
    const gl = g.renderer.getContext();
    const buf = new Uint8Array(this.w * this.h * 4);
    const greenFraction = (dist: number, sep: number, tilt: number): number => {
      let worst = 0;
      for (const j of [0, 1, 2]) {
        cam.position.set(j * 0.00037, 1.7 + j * 0.00021, 0);
        cam.lookAt(0, 1.7, -dist);
        cam.updateMatrixWorld(true);
        for (const [m, d] of [[front, dist], [back, dist + sep / Math.cos(tilt)]] as [THREE.Mesh, number][]) {
          m.position.set(0, 1.7, -d);
          m.rotation.set(-tilt, 0, 0);
          m.scale.set(dist * 3, dist * (tilt ? 4 : 3), 1);
          m.updateMatrixWorld(true);
        }
        g.composer.render(0);
        g.renderer.setRenderTarget(null);
        gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        // middle band only: the tilted plane's far edge is not the subject
        let green = 0, total = 0;
        for (let y = Math.floor(this.h * 0.4); y < Math.floor(this.h * 0.6); y++) for (let x = Math.floor(this.w * 0.2); x < Math.floor(this.w * 0.8); x++) {
          const o = (y * this.w + x) * 4;
          if (buf[o]! < 8 && buf[o + 1]! < 8) continue; // background
          total++;
          if (buf[o + 1]! > buf[o]!) green++;
        }
        worst = Math.max(worst, total ? green / total : 1);
      }
      return worst;
    };
    const search = (dist: number, tilt: number): number => {
      // log-space bisection on separation: 1 µm .. 4 m
      let lo = Math.log(1e-6), hi = Math.log(4);
      if (greenFraction(dist, Math.exp(lo), tilt) === 0) return Math.exp(lo);
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (greenFraction(dist, Math.exp(mid), tilt) === 0) hi = mid;
        else lo = mid;
      }
      return Math.exp(hi);
    };
    const rows = distances.map((dist) => ({
      dist,
      facingMm: Math.round(search(dist, 0) * 1e6) / 1e3,
      grazingMm: Math.round(search(dist, THREE.MathUtils.degToRad(78)) * 1e6) / 1e3,
    }));
    rp.scene = g.world!.scene;
    rp.camera = g.camera;
    g.vm.root.visible = vmVisible;
    return { mode: this.depth.mode, near: g.camera.near, floatDepth: this.depth.floatDepth, rows };
  }
}

function norm(v: V3): V3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Largest group of pixels (8-connected through gaps of up to 2 px). */
function largestCluster(px: number[], W: number): number[] {
  if (px.length < 2) return px;
  const at = new Map<number, number>();
  px.forEach((p, k) => at.set(p, k));
  const parent = px.map((_, k) => k);
  const find = (k: number): number => { while (parent[k] !== k) { parent[k] = parent[parent[k]!]!; k = parent[k]!; } return k; };
  px.forEach((p, k) => {
    const x = p % W;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      if (x + dx < 0 || x + dx >= W) continue;
      const q = at.get(p + dy * W + dx);
      if (q !== undefined) { const a = find(k), b = find(q); if (a !== b) parent[a] = b; }
    }
  });
  const size = new Map<number, number[]>();
  px.forEach((p, k) => { const r = find(k); if (!size.has(r)) size.set(r, []); size.get(r)!.push(p); });
  let best: number[] = [];
  for (const c of size.values()) if (c.length > best.length) best = c;
  return best;
}

function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) out[yy * W + xx] = 1;
    }
  }
  return out;
}

export function installFlickerQA(game: Game): FlickerQA {
  const qa = new FlickerQA(game);
  (window as unknown as { __flicker: FlickerQA }).__flicker = qa;
  return qa;
}
