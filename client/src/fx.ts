import * as THREE from "three";
import { NADE_DMG_R, NADE_RADIUS } from "@shared/sim";
import "./asset-base"; // installs the asset-path hook (side effect)
// weapons stream: the thrown / held frag is the viewmodel stream's true-size M67 (one geometry + one material)
import { buildFragMesh, FRAG_R } from "./weapons/guns/frag";

// weapons stream: the banana-round TracerFx (and its HELIOS ion-capsule variant)
// is gone — tracers, impacts and brass are client/src/weapons/fx (WeaponFx).

/** Centre on origin, put the longest axis on +Z, scale to `len` metres long. */
export function normalizeRound(geo: THREE.BufferGeometry, len: number): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);
  const size = bb.getSize(new THREE.Vector3());
  if (size.x >= size.y && size.x >= size.z) geo.rotateY(Math.PI / 2);
  else if (size.y > size.x && size.y >= size.z) geo.rotateX(Math.PI / 2);
  const long = Math.max(size.x, size.y, size.z, 1e-4);
  geo.scale(len / long, len / long, len / long);
  geo.computeBoundingBox();
  return geo;
}

// ===========================================================================
// THE BANANA FRAG — flight, trail, landing marker, detonation
//
// Everything below is pooled and preallocated: instance counts are fixed at
// construction, every per-frame write goes into a buffer that already exists,
// and nothing here allocates in update(). The 240 fps rule is not negotiable,
// and a grenade going off is exactly the moment a frame drop would be felt.
// ===========================================================================

/** Live frags a client will ever draw at once. */
const NADE_SLOTS = 10;
/** Ribbon samples behind each frag. */
const TRAIL_N = 18;
/** Seconds of history the ribbon spans. */
const TRAIL_TIME = 0.15;
const TRAIL_W = 0.055;

let nadeAsset: Promise<{ geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }> | null = null;

/**
 * The frag a HAND holds (the third-person paw copy): one shared geometry +
 * material, built once. The thrown frag (NadeFx) is the armed variant.
 */
export function loadNadeAsset(): Promise<{ geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }> {
  // weapons stream: the banana GLB is retired — every frag in a hand is the
  // procedural M67 (pin + spoon still on), true size, origin at the body
  // centre, +Y toward the fuze. Kept async for the callers' shape.
  if (nadeAsset) return nadeAsset;
  const m = buildFragMesh({ armed: false });
  nadeAsset = Promise.resolve({ geo: m.geometry, mat: m.material as THREE.MeshStandardMaterial });
  return nadeAsset;
}

// --------------------------------------------------------------- canvas art
//
// MASK TEXTURES, NEVER COLOURED ONES.
//
// Every sprite texture here is drawn on a FULLY OPAQUE canvas and carries its
// shape in the colour channels: R = coverage, G = a second-colour mix. The
// actual colours come from shader uniforms.
//
// Why: a canvas stores its pixels premultiplied, and the canvas -> WebGL upload
// path has to undo that. On a texture whose alpha varies (every soft-edged
// sprite) the recovered RGB is washed toward white — measured here on the ground
// scorch, which is authored at rgb(8,5,2) and sampled in the shader at roughly
// rgb(140,120,60), i.e. INVISIBLE against yard sand. Painting masks at alpha 1
// removes the premultiply step from the pipeline entirely, and tinting in the
// shader is both exact and cheaper to retune.

/** Opaque canvas → texture. `paint` writes the mask; alpha is always 255. */
function maskTex(size: number, paint: (ctx: CanvasRenderingContext2D, n: number) => void): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  paint(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

let flashTexN: THREE.Texture | null = null;
let smokeTexN: THREE.Texture | null = null;
let scorchTexN: THREE.Texture | null = null;
let dotTexN: THREE.Texture | null = null;

/** Hot white core (G=1) inside a warm falloff (G=0). */
function boomFlashTex(): THREE.Texture {
  if (flashTexN) return flashTexN;
  flashTexN = maskTex(128, (ctx, n) => {
    const h = n / 2;
    const g = ctx.createRadialGradient(h, h, 0.5, h, h, h - 1);
    g.addColorStop(0, "rgb(255,255,0)");
    g.addColorStop(0.2, "rgb(242,200,0)");
    g.addColorStop(0.5, "rgb(128,20,0)");
    g.addColorStop(1, "rgb(0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
  });
  return flashTexN;
}

function smokeTex(): THREE.Texture {
  if (smokeTexN) return smokeTexN;
  smokeTexN = maskTex(96, (ctx, n) => {
    const h = n / 2;
    const g = ctx.createRadialGradient(h, h, 1, h, h, h - 2);
    g.addColorStop(0, "rgb(235,190,0)");
    g.addColorStop(0.5, "rgb(130,90,0)");
    g.addColorStop(1, "rgb(0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
    // Bite chunks out of the rim so the puff is not a perfect disc.
    ctx.fillStyle = "#000";
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      ctx.beginPath();
      ctx.arc(h + Math.cos(a) * 32, h + Math.sin(a) * 32, 13, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return smokeTexN;
}

/**
 * Ground scorch: a near-opaque burn PLATEAU (not a bell — the scene composites
 * in linear space and then runs ACES plus the grade pass, which flattens a soft
 * gaussian into nothing) with bright pulp flecks in the green channel, because a
 * nana bomb leaves fruit on the sand, not a crater.
 */
function scorchTex(): THREE.Texture {
  if (scorchTexN) return scorchTexN;
  scorchTexN = maskTex(128, (ctx, n) => {
    const h = n / 2;
    const g = ctx.createRadialGradient(h, h, 1, h, h, h - 2);
    g.addColorStop(0, "rgb(255,0,0)");
    g.addColorStop(0.3, "rgb(228,0,0)");
    g.addColorStop(0.62, "rgb(150,0,0)");
    g.addColorStop(0.85, "rgb(52,0,0)");
    g.addColorStop(1, "rgb(0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 12 + Math.random() * 48;
      ctx.beginPath();
      ctx.ellipse(h + Math.cos(a) * r, h + Math.sin(a) * r, 1.6 + Math.random() * 4.6, 1.2 + Math.random() * 3, a, 0, Math.PI * 2);
      const cov = Math.round((0.45 + Math.random() * 0.5) * 255);
      // Every third fleck is pulp (green channel), the rest deepen the burn.
      ctx.fillStyle = i % 3 === 0 ? `rgb(${cov},255,0)` : `rgb(${cov},0,0)`;
      ctx.fill();
    }
  });
  return scorchTexN;
}

/**
 * Marker dot: a cream core (G=1) inside a dark amber rim (G=0). The rim is the
 * whole point — a plain yellow glow disappears against the yard's bright sand
 * and against a yellow container, which is most of this map.
 */
function dotTex(): THREE.Texture {
  if (dotTexN) return dotTexN;
  dotTexN = maskTex(64, (ctx, n) => {
    const h = n / 2;
    const g = ctx.createRadialGradient(h, h, 0.5, h, h, h - 1);
    g.addColorStop(0, "rgb(255,255,0)");
    g.addColorStop(0.34, "rgb(255,180,0)");
    g.addColorStop(0.56, "rgb(240,0,0)");
    g.addColorStop(0.78, "rgb(120,0,0)");
    g.addColorStop(1, "rgb(0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
  });
  return dotTexN;
}

// ------------------------------------------------------------ frags in flight

type NadeView = {
  id: number;
  /** Where the sim says it is. */
  x: number; y: number; z: number;
  spin: number;
  /** Hand-handoff: world offset applied at birth, decayed over HANDOFF s. */
  hx: number; hy: number; hz: number;
  handT: number;
  /** Apparent size the frag is born at, 1 = world scale (see spawn()). */
  born: number;
  age: number;
  /** Replicated body state: 0 in the air, 1 on a surface, 2 asleep. */
  st: 0 | 1 | 2;
  /** Seconds the frag has been asleep — drives the at-rest settle. */
  still: number;
  /** 0..1 weight of the rolling read (log-roll) over the airborne tumble. */
  roll: number;
  /** Horizontal roll axis (unit, y = 0) — kept when the frag stops. */
  rax: number; raz: number;
  /** Last drawn sim position — the roll axis comes from its delta. */
  px: number; pz: number;
  /** Ring buffer of trail samples (x,y,z,age) — preallocated, never grows. */
  trail: Float32Array;
  trailN: number;
  trailHead: number;
  sample: number;
};

/** Seconds the frag is blended from the thrower's hand onto the sim path. */
const HANDOFF = 0.13;
/** Seconds a motionless frag takes to lie down flat. */
const SETTLE_T = 0.16;
/** Seconds to blend between the airborne tumble and the rolling log-roll. */
const ROLL_BLEND = 0.09;
/**
 * How far the drawn frag sinks toward its rest surface once it has settled.
 * The sim body is a 0.105 m SPHERE, so it comes to rest with its centre 10.5 cm
 * up; a banana lying on its side is about 6 cm thick, so without this it floats
 * a visible finger's width above the sand — right where the landing ring is
 * telling the thrower to look.
 */
const SETTLE_DROP = NADE_RADIUS - FRAG_R * 1.06; // weapons stream: the M67 lies on its side, body radius FRAG_R

/**
 * Every banana frag in the air, from both points of view. The sim owns the
 * position; this owns the read: the spinning frag, and a thin golden ribbon
 * that is deliberately fainter and narrower than a bullet tracer so a thrown
 * nana never gets mistaken for someone shooting at you.
 */
export class NadeFx {
  mesh: THREE.InstancedMesh;
  ribbon: THREE.Mesh;
  readonly live: NadeView[] = [];
  private free: NadeView[] = [];
  private rPos: THREE.BufferAttribute;
  private rAlpha: THREE.BufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qs = new THREE.Quaternion();
  /** Scratch for the at-rest lie-down rotation. */
  private qf = new THREE.Quaternion();
  private v = new THREE.Vector3();
  /** Scratch scale — the frag is uniform, so this is written every frame. */
  private scl = new THREE.Vector3(1, 1, 1);
  private cam = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private side = new THREE.Vector3();
  private Z = new THREE.Vector3(0, 0, 1);
  private X = new THREE.Vector3(1, 0, 0);
  private Y = new THREE.Vector3(0, 1, 0);
  /** weapons stream: the axis that lies flat at rest and rolls like a log — the M67's fuze axis. */
  private LONG = new THREE.Vector3(0, 1, 0);

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(geo, mat, NADE_SLOTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = 0;

    // One ribbon mesh for every frag: a strip per slot, degenerate when unused.
    const verts = NADE_SLOTS * TRAIL_N * 2;
    const g = new THREE.BufferGeometry();
    this.rPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.rPos.setUsage(THREE.DynamicDrawUsage);
    this.rAlpha = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.rAlpha.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.rPos);
    g.setAttribute("aAlpha", this.rAlpha);
    const idx: number[] = [];
    for (let s = 0; s < NADE_SLOTS; s++) {
      const base = s * TRAIL_N * 2;
      for (let i = 0; i < TRAIL_N - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setIndex(idx);
    this.ribbon = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        uniforms: {
          uHead: { value: new THREE.Color(0xffdc7a).convertSRGBToLinear() },
          uTail: { value: new THREE.Color(0xcf8a10).convertSRGBToLinear() },
        },
        vertexShader: `
          attribute float aAlpha;
          varying float vA;
          void main() {
            vA = aAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uHead;
          uniform vec3 uTail;
          varying float vA;
          void main() {
            if (vA < 0.004) discard;
            // 0.4, and warm rather than white: this must read as a thrown fruit's
            // wake, never as another ape's tracer coming at you.
            gl_FragColor = vec4(mix(uTail, uHead, vA), vA * 0.4);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 3;

    for (let i = 0; i < NADE_SLOTS; i++) {
      this.free.push({
        id: 0, x: 0, y: 0, z: 0, spin: 0, hx: 0, hy: 0, hz: 0, handT: 0, born: 1, age: 0,
        st: 0, still: 0, roll: 0, rax: 1, raz: 0, px: 0, pz: 0,
        trail: new Float32Array(TRAIL_N * 3), trailN: 0, trailHead: 0, sample: 0,
      });
    }
  }

  static async create(): Promise<NadeFx> {
    // weapons stream: the frag in flight — pin pulled, spoon gone
    const m = buildFragMesh({ armed: true });
    return new NadeFx(m.geometry, m.material as THREE.Material);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
    scene.add(this.ribbon);
  }

  get(id: number): NadeView | undefined {
    for (const v of this.live) if (v.id === id) return v;
    return undefined;
  }

  /**
   * A frag entered the world. `hand` is where the thrower's paw actually was on
   * this frame: the frag is drawn FROM the hand and blended onto the sim path
   * over HANDOFF seconds, so it never appears to leave the chest.
   *
   * `born` is the apparent size the frag starts at, 1 = its true 0.27 m. It
   * exists for ONE case: the thrower's own eyes. A first-person viewmodel is a
   * scale model held 40 cm from the lens — the frag in your paw is drawn at
   * 0.11 m so it does not eat the screen — so a world-scale banana appearing at
   * that same spot is a 2.4x size POP on the release frame. Starting the world
   * frag at the viewmodel's apparent size and growing it over the handoff makes
   * the swap continuous, and by the time it is full size it is 2 m downrange
   * where perspective has already shrunk it.
   */
  spawn(id: number, x: number, y: number, z: number, hand: THREE.Vector3 | null, born = 1): NadeView {
    const v = this.free.pop() ?? this.live.shift()!;
    v.id = id;
    v.x = x;
    v.y = y;
    v.z = z;
    v.spin = 0;
    v.age = 0;
    v.born = born;
    v.st = 0;
    v.still = 0;
    v.roll = 0;
    v.rax = 1;
    v.raz = 0;
    v.px = x;
    v.pz = z;
    v.trailN = 0;
    v.trailHead = 0;
    v.sample = 0;
    if (hand) {
      v.hx = hand.x - x;
      v.hy = hand.y - y;
      v.hz = hand.z - z;
      v.handT = HANDOFF;
    } else {
      v.hx = v.hy = v.hz = 0;
      v.handT = 0;
    }
    this.live.push(v);
    return v;
  }

  kill(id: number): void {
    for (let i = 0; i < this.live.length; i++) {
      if (this.live[i]!.id !== id) continue;
      this.free.push(this.live[i]!);
      this.live.splice(i, 1);
      return;
    }
  }

  /** Adopt the authoritative position (and body state) for this frame. */
  set(v: NadeView, x: number, y: number, z: number, spin: number, st: 0 | 1 | 2 = 0): void {
    v.x = x;
    v.y = y;
    v.z = z;
    v.spin = spin;
    v.st = st;
  }

  /** Rendered position (sim position plus the decaying hand offset). */
  posOf(v: NadeView, out: THREE.Vector3): THREE.Vector3 {
    const w = v.handT > 0 ? v.handT / HANDOFF : 0;
    // Smoothstep so the frag leaves the paw with no velocity discontinuity.
    const k = w * w * (3 - 2 * w);
    return out.set(v.x + v.hx * k, v.y + v.hy * k, v.z + v.hz * k);
  }

  update(dt: number, camera: THREE.Camera): void {
    const n = this.live.length;
    this.mesh.count = n;
    if (!n) {
      this.rPos.needsUpdate = true;
      this.ribbon.visible = false;
      return;
    }
    // weapons stream: no golden wake behind a CoD frag — the danger indicator is the HUD's job
    this.ribbon.visible = false;
    camera.getWorldPosition(this.cam);
    const pos = this.rPos.array as Float32Array;
    const alp = this.rAlpha.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const v = this.live[i]!;
      v.age += dt;
      if (v.handT > 0) v.handT = Math.max(0, v.handT - dt);
      // --- what is this frag DOING?
      //
      // Three reads, driven by the body state the sim replicates (NadeSnap.st):
      //   0 in the air   end-over-end tumble
      //   1 on a surface LOG-ROLL about the axis across its travel
      //   2 asleep       lie down flat on whatever it stopped on
      // The travel direction still comes from the path (it is the only source of
      // it), but WHICH read to use never does — at the apex of a lob a falling
      // frag moves exactly like a rolling one for a few frames, and guessing
      // there snapped the banana flat in mid-air.
      const dx = v.x - v.px;
      const dz = v.z - v.pz;
      const horiz = Math.hypot(dx, dz);
      if (horiz > 1e-5) {
        // Perpendicular to travel, in the ground plane: a banana rolls like a log.
        const inv = 1 / horiz;
        v.rax = dz * inv;
        v.raz = -dx * inv;
      }
      v.still = v.st === 2 ? v.still + dt : 0;
      const wantRoll = v.st === 0 ? 0 : 1;
      v.roll = THREE.MathUtils.clamp(v.roll + Math.sign(wantRoll - v.roll) * (dt / ROLL_BLEND), 0, 1);
      v.px = v.x;
      v.pz = v.z;
      this.posOf(v, this.v);

      // --- the frag: tumbling end over end, banked so the grooves catch light
      this.q.setFromAxisAngle(this.X, v.spin);
      this.q.multiply(this.qs.setFromAxisAngle(this.Z, v.spin * 0.43));
      this.q.premultiply(this.qs.setFromAxisAngle(this.Y, v.spin * 0.17));
      // --- rolling: a banana on the deck rolls like a LOG, not like a coin.
      // Its long axis lies along the roll axis and it turns about it, which is
      // the only read that says "this thing is on the ground and moving".
      if (v.roll > 0.001) {
        this.dir.set(v.rax, 0, v.raz);
        this.qf.setFromUnitVectors(this.LONG, this.dir);
        this.qf.premultiply(this.qs.setFromAxisAngle(this.dir, v.spin));
        this.q.slerp(this.qf, v.roll);
      }
      // --- at rest: LIE DOWN.
      //
      // The sim freezes the tumble wherever it stopped, which leaves the frag
      // standing on its tip as often as not — and it stops right under the
      // landing ring, the one spot the thrower is looking at for the last
      // second of the fuse. Rotate it by the SHORTEST arc that puts its long
      // axis flat, and sink it onto the surface as it goes.
      let sink = v.roll;
      if (v.still > 0) {
        const k = Math.min(1, v.still / SETTLE_T);
        const s = k * k * (3 - 2 * k);
        this.dir.copy(this.LONG).applyQuaternion(this.q);
        this.side.set(this.dir.x, 0, this.dir.z);
        if (this.side.lengthSq() < 1e-8) this.side.set(1, 0, 0);
        this.side.normalize();
        this.qf.setFromUnitVectors(this.dir, this.side).multiply(this.q);
        this.q.slerp(this.qf, s);
        sink = Math.max(sink, s);
      }
      // The sim body is a 0.105 m sphere; a banana on its side is ~6 cm thick,
      // so whenever it is lying on something it has to come down to meet it.
      this.v.y -= SETTLE_DROP * sink;
      const sc = v.handT > 0 ? v.born + (1 - v.born) * (1 - v.handT / HANDOFF) : 1;
      this.m.compose(this.v, this.q, this.scl.setScalar(sc));
      this.mesh.setMatrixAt(i, this.m);

      // --- trail history, sampled on a fixed clock so speed does not change it
      v.sample += dt;
      const step = TRAIL_TIME / TRAIL_N;
      if (v.sample >= step || v.trailN === 0) {
        v.sample = 0;
        const h = v.trailHead * 3;
        v.trail[h] = this.v.x;
        v.trail[h + 1] = this.v.y;
        v.trail[h + 2] = this.v.z;
        v.trailHead = (v.trailHead + 1) % TRAIL_N;
        if (v.trailN < TRAIL_N) v.trailN++;
      }
      this.writeRibbon(i, v, pos, alp);
    }
    // Collapse every unused slot so stale ribbons cannot linger.
    for (let s = n; s < NADE_SLOTS; s++) {
      const base = s * TRAIL_N * 2;
      for (let k = 0; k < TRAIL_N * 2; k++) alp[base + k] = 0;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.rPos.needsUpdate = true;
    this.rAlpha.needsUpdate = true;
  }

  /**
   * Camera-facing tapered strip from the frag's position history.
   *
   * Pair TRAIL_N-1 sits on the frag and pair 0 at the oldest sample. A frag that
   * has not filled its history yet PADS from the tail by repeating its oldest
   * point at alpha 0 — padding at the origin instead would stretch a visible
   * gradient triangle from the trail all the way to world zero.
   */
  private writeRibbon(slot: number, v: NadeView, pos: Float32Array, alp: Float32Array): void {
    const base = slot * TRAIL_N * 2;
    const count = v.trailN;
    const pad = TRAIL_N - count;
    // Chronological sample k (0 = oldest) lives at this ring index.
    const at = (k: number): number => ((v.trailHead - count + k + TRAIL_N * 2) % TRAIL_N) * 3;
    for (let i = 0; i < TRAIL_N; i++) {
      const k = Math.max(0, i - pad);
      const ri = at(k);
      this.a.set(v.trail[ri]!, v.trail[ri + 1]!, v.trail[ri + 2]!);
      // Segment direction: forward from this sample, or back from the last one.
      const rj = at(k < count - 1 ? k + 1 : Math.max(0, k - 1));
      this.b.set(v.trail[rj]!, v.trail[rj + 1]!, v.trail[rj + 2]!);
      this.dir.subVectors(k < count - 1 ? this.b : this.a, k < count - 1 ? this.a : this.b);
      if (this.dir.lengthSq() < 1e-10) this.dir.set(0, 0.001, 0);
      this.side.subVectors(this.cam, this.a).cross(this.dir);
      if (this.side.lengthSq() < 1e-12) this.side.copy(this.X);
      // Taper + fade: nothing at the tail, full width under the frag.
      const t = count > 1 ? k / (count - 1) : 0;
      const w = i < pad ? 0 : TRAIL_W * t * 0.5;
      this.side.normalize().multiplyScalar(w);
      const o = base + i * 2;
      pos[o * 3] = this.a.x + this.side.x;
      pos[o * 3 + 1] = this.a.y + this.side.y;
      pos[o * 3 + 2] = this.a.z + this.side.z;
      pos[(o + 1) * 3] = this.a.x - this.side.x;
      pos[(o + 1) * 3 + 1] = this.a.y - this.side.y;
      pos[(o + 1) * 3 + 2] = this.a.z - this.side.z;
      const fade = i < pad ? 0 : t * t;
      alp[o] = fade;
      alp[o + 1] = fade;
    }
  }
}

// ------------------------------------------------------------- the detonation

/** Concurrent explosions a client will draw. */
const BOOM_SLOTS = 5;
/** Peel shards per burst. */
const FRAG_PER = 30;
/** Smoke puffs per burst. */
const PUFF_PER = 9;
const FRAG_SLOTS = BOOM_SLOTS * FRAG_PER;
const PUFF_SLOTS = BOOM_SLOTS * PUFF_PER;
/** Ground scorches alive at once (they outlive the burst by seconds). */
const SCORCH_SLOTS = 7;

const FLASH_IN = 0.035;
const FLASH_OUT = 0.2;
const RING_LIFE = 0.27;
const FRAG_LIFE = 0.9;
const PUFF_LIFE = 1.25;
const SCORCH_LIFE = 5.5;

type Boom = { t: number; x: number; y: number; z: number; seed: number };
type Frag = {
  t: number; life: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
};
type Puff = { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; r0: number; rot: number };
type Scorch = { t: number; x: number; y: number; z: number; r: number };

/**
 * BANANA BURST. Bright core flash, a spray of peel shards, a low smoke puff, a
 * fast ground shock ring and a scorch that fades over a few seconds.
 *
 * Deliberately NOT a full-screen event: the flash quad is capped at ~2.5 m and
 * the smoke is thin, so a nana going off next to you never becomes a wall of
 * additive white. The punch comes from the shard spray and the camera shake
 * (game.ts), which cost nothing in fill rate.
 */
export class BoomFx {
  group = new THREE.Group();
  flash: THREE.InstancedMesh;
  ring: THREE.InstancedMesh;
  frags: THREE.InstancedMesh;
  puffs: THREE.InstancedMesh;
  scorch: THREE.InstancedMesh;
  light: THREE.PointLight;
  private booms: Boom[] = [];
  private fragL: Frag[] = [];
  private fragFree: Frag[] = [];
  private puffL: Puff[] = [];
  private puffFree: Puff[] = [];
  private scorchL: Scorch[] = [];
  private scorchFree: Scorch[] = [];
  private flashA: THREE.InstancedBufferAttribute;
  private ringA: THREE.InstancedBufferAttribute;
  private puffA: THREE.InstancedBufferAttribute;
  private scorchA: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private camQ = new THREE.Quaternion();
  private rand = 1;

  /** Deterministic in ?test — Math.random is seeded there, this stays cheap. */
  private rnd(): number {
    this.rand = (this.rand * 1664525 + 1013904223) >>> 0;
    return this.rand / 0xffffffff;
  }

  constructor() {
    this.group.name = "boom-fx";
    const quad = new THREE.PlaneGeometry(1, 1);

    this.flashA = fadeAttr(BOOM_SLOTS);
    const flashGeo = quad.clone();
    flashGeo.setAttribute("aFade", this.flashA);
    this.flash = new THREE.InstancedMesh(flashGeo, spriteMat(boomFlashTex(), THREE.AdditiveBlending, 1, 0xff8c14, 0xfffbe0), BOOM_SLOTS);
    prep(this.flash, 12);

    // Ground shock ring: flat, thin, expands and dies in a third of a second.
    // The band is FEATHERED across its own width in the shader (sin over the
    // radius) — a flat-alpha annulus reads as a painted target ring sitting on
    // the sand, which is exactly what the round-2 capture showed, and it fought
    // the landing marker for the same visual language. Soft at both rims it
    // reads as the pressure wave it is.
    const ringGeo = new THREE.RingGeometry(0.6, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringA = fadeAttr(BOOM_SLOTS);
    ringGeo.setAttribute("aFade", this.ringA);
    this.ring = new THREE.InstancedMesh(
      ringGeo,
      new THREE.ShaderMaterial({
        uniforms: { uCol: { value: new THREE.Color(0xffd982).convertSRGBToLinear() } },
        vertexShader: `attribute float aFade; varying float vF; varying float vR;
          void main(){ vF=aFade; vR=(length(position.xz)-0.6)/0.4;
            gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uCol; varying float vF; varying float vR;
          void main(){ float a = vF * sin(clamp(vR,0.0,1.0)*3.14159);
            if(a<0.004) discard; gl_FragColor=vec4(uCol, a); }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      BOOM_SLOTS,
    );
    prep(this.ring, 11);

    // Peel shards: thin tapered slivers that tumble and catch the sun.
    const shard = new THREE.BoxGeometry(0.046, 0.011, 0.15);
    this.frags = new THREE.InstancedMesh(
      shard,
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.58, metalness: 0.02,
        emissive: new THREE.Color(0x6b4708), emissiveIntensity: 0.5,
      }),
      FRAG_SLOTS,
    );
    this.frags.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FRAG_SLOTS * 3), 3);
    this.frags.instanceColor.setUsage(THREE.DynamicDrawUsage);
    prep(this.frags, 0);
    this.frags.castShadow = false;

    this.puffA = fadeAttr(PUFF_SLOTS);
    const puffGeo = quad.clone();
    puffGeo.setAttribute("aFade", this.puffA);
    this.puffs = new THREE.InstancedMesh(puffGeo, spriteMat(smokeTex(), THREE.NormalBlending, 0.62, 0x8d7c5e, 0xd8c6a2), PUFF_SLOTS);
    prep(this.puffs, 10);

    const disc = new THREE.PlaneGeometry(1, 1);
    disc.rotateX(-Math.PI / 2);
    this.scorchA = fadeAttr(SCORCH_SLOTS);
    disc.setAttribute("aFade", this.scorchA);
    this.scorch = new THREE.InstancedMesh(disc, spriteMat(scorchTex(), THREE.NormalBlending, 0.72, 0x1a1206, 0xe6d089), SCORCH_SLOTS);
    prep(this.scorch, 9);
    // ZERO-FLICKER decal rule: 12 mm proud (below) AND a polygonOffset toward the camera
    decalOffset(this.scorch.material as THREE.Material);

    // The burst light, deliberately SMALL. At intensity 78 over a 13 m radius
    // (round 2) a detonation clipped every surface within ~4 m to pure white:
    // the peel shards, the shock ring and the container behind them all read as
    // one flat white blob, and the burst lost its banana entirely (compare
    // b7-explode-victim-pov before/after). 40 over 8.5 m still warms the ground
    // and throws a shadow, but the brightest thing on screen stays the CORE.
    this.light = new THREE.PointLight(0xffbb52, 0, 8.5, 2.1);
    this.group.add(this.flash, this.ring, this.frags, this.puffs, this.scorch, this.light);

    for (let i = 0; i < FRAG_SLOTS; i++) {
      this.fragFree.push({ t: 0, life: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 });
    }
    for (let i = 0; i < PUFF_SLOTS; i++) {
      this.puffFree.push({ t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r0: 0.5, rot: 0 });
    }
    for (let i = 0; i < SCORCH_SLOTS; i++) this.scorchFree.push({ t: 0, x: 0, y: 0, z: 0, r: 1 });
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** Live bursts — qa perf harnesses can read this the way they read tracers. */
  get count(): number {
    return this.booms.length;
  }

  /** Detonate at a point. `groundY` is the surface the scorch is painted on. */
  boom(x: number, y: number, z: number, groundY: number): void {
    if (this.booms.length >= BOOM_SLOTS) this.booms.shift();
    this.booms.push({ t: 0, x, y, z, seed: this.rnd() });
    this.light.position.set(x, y + 0.35, z);
    this.light.intensity = 40;

    for (let i = 0; i < FRAG_PER; i++) {
      const f = this.fragFree.pop() ?? this.fragL.shift();
      if (!f) break;
      // Hemisphere-biased spray: shards go out and up, never straight down.
      const a = this.rnd() * Math.PI * 2;
      const up = 0.18 + this.rnd() * 0.85;
      const flat = Math.sqrt(Math.max(0, 1 - up * up));
      const sp = 5.5 + this.rnd() * 8.5;
      f.t = 0;
      f.life = FRAG_LIFE * (0.6 + this.rnd() * 0.7);
      f.x = x;
      f.y = y;
      f.z = z;
      f.vx = Math.cos(a) * flat * sp;
      f.vy = up * sp;
      f.vz = Math.sin(a) * flat * sp;
      f.rx = (this.rnd() - 0.5) * 26;
      f.ry = (this.rnd() - 0.5) * 26;
      f.rz = (this.rnd() - 0.5) * 26;
      f.sx = this.rnd() * Math.PI * 2;
      f.sy = this.rnd() * Math.PI * 2;
      f.sz = this.rnd() * Math.PI * 2;
      this.fragL.push(f);
    }
    for (let i = 0; i < PUFF_PER; i++) {
      const p = this.puffFree.pop() ?? this.puffL.shift();
      if (!p) break;
      const a = this.rnd() * Math.PI * 2;
      const sp = 0.7 + this.rnd() * 1.5;
      p.t = 0;
      p.x = x;
      p.y = y + 0.1;
      p.z = z;
      p.vx = Math.cos(a) * sp;
      p.vy = 0.75 + this.rnd() * 0.85;
      p.vz = Math.sin(a) * sp;
      p.r0 = 0.78 + this.rnd() * 0.5;
      p.rot = this.rnd() * Math.PI * 2;
      this.puffL.push(p);
    }
    const sc = this.scorchFree.pop() ?? this.scorchL.shift();
    if (sc) {
      sc.t = 0;
      sc.x = x;
      // 1 cm proud of the surface: no z-fighting, no visible float.
      sc.y = groundY + 0.012;
      sc.z = z;
      sc.r = 2.9 + this.rnd() * 0.5;
      this.scorchL.push(sc);
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    camera.getWorldQuaternion(this.camQ);
    const fa = this.flashA.array as Float32Array;
    const ra = this.ringA.array as Float32Array;
    const pa = this.puffA.array as Float32Array;
    const sa = this.scorchA.array as Float32Array;

    // --- core flash + shock ring (one pair per burst)
    let n = 0;
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i]!;
      b.t += dt;
      if (b.t > Math.max(FLASH_IN + FLASH_OUT, RING_LIFE)) {
        this.booms.splice(i, 1);
        continue;
      }
      const fT = b.t;
      const fa1 =
        fT < FLASH_IN ? fT / FLASH_IN
        : Math.max(0, 1 - (fT - FLASH_IN) / FLASH_OUT);
      // Grow fast, then keep growing as it dies — reads as expanding gas.
      const fs = 0.85 + 3.15 * Math.min(1, fT / (FLASH_IN + FLASH_OUT * 0.7));
      this.v.set(b.x, b.y + 0.12, b.z);
      this.m.compose(this.v, this.camQ, this.s.set(fs, fs, fs));
      this.flash.setMatrixAt(n, this.m);
      fa[n] = fa1 * fa1;

      const rT = Math.min(1, b.t / RING_LIFE);
      const rs = 0.4 + rT * 4;
      this.v.set(b.x, b.y - 0.02, b.z);
      this.m.compose(this.v, ZERO_Q, this.s.set(rs, 1, rs));
      this.ring.setMatrixAt(n, this.m);
      // Out fast and steep: a shock wave, not a marker ring sitting on the sand.
      ra[n] = Math.pow(Math.max(0, 1 - rT), 1.55) * 0.78;
      n++;
    }
    this.flash.count = n;
    this.ring.count = n;
    this.light.intensity = Math.max(0, this.light.intensity - dt * 340);

    // --- peel shards
    let fn = 0;
    const col = this.frags.instanceColor!.array as Float32Array;
    for (let i = this.fragL.length - 1; i >= 0; i--) {
      const f = this.fragL[i]!;
      f.t += dt;
      if (f.t >= f.life) {
        this.fragL.splice(i, 1);
        this.fragFree.push(f);
        continue;
      }
      f.vy -= 19 * dt;
      f.vx *= 1 - 1.6 * dt;
      f.vz *= 1 - 1.6 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      if (f.y < 0.02) {
        f.y = 0.02;
        f.vy = -f.vy * 0.24;
        f.vx *= 0.5;
        f.vz *= 0.5;
      }
      const k = 1 - f.t / f.life;
      f.sx += f.rx * dt;
      f.sy += f.ry * dt;
      f.sz += f.rz * dt;
      this.e.set(f.sx, f.sy, f.sz);
      this.q.setFromEuler(this.e);
      // Shrink out instead of fading: opaque shards never ghost through walls.
      const sc = 0.45 + k * 0.75;
      this.m.compose(this.v.set(f.x, f.y, f.z), this.q, this.s.set(sc, sc, sc));
      this.frags.setMatrixAt(fn, this.m);
      // Two thirds peel-yellow, one third pale pulp.
      const pulp = (fn % 3) === 2;
      col[fn * 3] = pulp ? 1 : 1;
      col[fn * 3 + 1] = pulp ? 0.94 : 0.76;
      col[fn * 3 + 2] = pulp ? 0.62 : 0.1;
      fn++;
    }
    this.frags.count = fn;

    // --- smoke
    let pn = 0;
    for (let i = this.puffL.length - 1; i >= 0; i--) {
      const p = this.puffL[i]!;
      p.t += dt;
      if (p.t >= PUFF_LIFE) {
        this.puffL.splice(i, 1);
        this.puffFree.push(p);
        continue;
      }
      p.vx *= 1 - 1.9 * dt;
      p.vz *= 1 - 1.9 * dt;
      p.vy *= 1 - 0.7 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const k = p.t / PUFF_LIFE;
      const size = p.r0 * (1 + k * 2.4);
      this.q.copy(this.camQ).multiply(ZQ.setFromAxisAngle(ZAX, p.rot + k * 0.6));
      this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.set(size, size, size));
      this.puffs.setMatrixAt(pn, this.m);
      // In fast, out slow, and never above 0.42 — smoke must not fog the fight.
      pa[pn] = Math.min(1, k / 0.12) * Math.max(0, 1 - k) * 0.85;
      pn++;
    }
    this.puffs.count = pn;

    // --- scorch
    let sn = 0;
    for (let i = this.scorchL.length - 1; i >= 0; i--) {
      const sc = this.scorchL[i]!;
      sc.t += dt;
      if (sc.t >= SCORCH_LIFE) {
        this.scorchL.splice(i, 1);
        this.scorchFree.push(sc);
        continue;
      }
      const k = sc.t / SCORCH_LIFE;
      const size = sc.r * Math.min(1, 0.55 + sc.t / 0.14);
      this.m.compose(this.v.set(sc.x, sc.y, sc.z), ZERO_Q, this.s.set(size, 1, size));
      this.scorch.setMatrixAt(sn, this.m);
      sa[sn] = Math.min(1, sc.t / 0.1) * (k > 0.45 ? (1 - k) / 0.55 : 1);
      sn++;
    }
    this.scorch.count = sn;

    this.flash.instanceMatrix.needsUpdate = true;
    this.ring.instanceMatrix.needsUpdate = true;
    this.frags.instanceMatrix.needsUpdate = true;
    this.frags.instanceColor!.needsUpdate = true;
    this.puffs.instanceMatrix.needsUpdate = true;
    this.scorch.instanceMatrix.needsUpdate = true;
    this.flashA.needsUpdate = true;
    this.ringA.needsUpdate = true;
    this.puffA.needsUpdate = true;
    this.scorchA.needsUpdate = true;
  }
}

const ZERO_Q = new THREE.Quaternion();
const ZQ = new THREE.Quaternion();
const ZAX = new THREE.Vector3(0, 0, 1);

function fadeAttr(n: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

/** ZERO-FLICKER: a decal-like layer also pulls toward the camera in depth (sign kept right by the renderer in every depth mode). */
function decalOffset(m: THREE.Material): void {
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
}

function prep(m: THREE.InstancedMesh, order: number): void {
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.count = 0;
  m.renderOrder = order;
}

/**
 * Instanced sprite driven by a MASK texture (see "canvas art" above):
 *   R = coverage, G = blend from colour A toward colour B.
 * Colour lives in uniforms, so nothing depends on the canvas premultiply path.
 */
function spriteMat(
  tex: THREE.Texture,
  blending: THREE.Blending,
  gain: number,
  colA: number,
  colB: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uGain: { value: gain },
      uA: { value: new THREE.Color(colA).convertSRGBToLinear() },
      uB: { value: new THREE.Color(colB).convertSRGBToLinear() },
    },
    vertexShader: `
      attribute float aFade;
      varying vec2 vUv;
      varying float vF;
      void main(){
        vUv = uv;
        vF = aFade;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uGain;
      uniform vec3 uA;
      uniform vec3 uB;
      varying vec2 vUv;
      varying float vF;
      void main(){
        if (vF < 0.004) discard;
        vec2 t = texture2D(uMap, vUv).rg;
        float a = t.r * vF * uGain;
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(uA, uB, t.g), a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending,
    side: THREE.DoubleSide,
  });
}

// ------------------------------------------------------------ landing marker

/** Arc samples drawn while readying (every 2nd sim tick of the prediction). */
const ARC_MAX = 90;

/**
 * THE THROW PREVIEW — tactical, not a toy. A thin, faint, neutral dashed arc
 * and a small landing pip, drawn only for the player holding the frag. No
 * beads, no blast-radius circle (CoD shows none: the danger indicator is the
 * HUD's job once the frag is live).
 *
 * It is not an approximation: game.ts fills `pts` straight from predictNade in
 * shared/sim.ts — the same integrator, same dt, same colliders the live grenade
 * will use. Where the pip is, the frag lands. (weapons stream: restyled from
 * the amber bead arc + blast ring — the GEOMETRY is untouched.)
 */
export class ThrowMarker {
  group = new THREE.Group();
  /** The dashes along the arc (one thin camera-facing quad per arc segment). */
  dots: THREE.InstancedMesh;
  /** The landing pip. */
  ring: THREE.Mesh;
  /** Its faint dark backing (keeps a white pip legible on bright sand). */
  ringShade!: THREE.Mesh;
  private fade: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private ax = new THREE.Vector3();
  private ay = new THREE.Vector3();
  private az = new THREE.Vector3();
  private cam = new THREE.Vector3();
  /** 0..1 reveal — the marker wipes on along the arc rather than popping. */
  private show = 0;

  constructor() {
    this.group.name = "throw-marker";
    this.group.visible = false;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.fade = fadeAttr(ARC_MAX);
    quad.setAttribute("aFade", this.fade);
    this.dots = new THREE.InstancedMesh(
      quad,
      new THREE.ShaderMaterial({
        uniforms: { uCol: { value: new THREE.Color(0xf2f0ea).convertSRGBToLinear() } },
        vertexShader: `
          attribute float aFade;
          varying vec2 vUv;
          varying float vF;
          void main(){
            vUv = uv;
            vF = aFade;
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uCol;
          varying vec2 vUv;
          varying float vF;
          void main(){
            // soft across the line, hard-ish dash ends
            float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
            float a = vF * across * across;
            if (a < 0.004) discard;
            gl_FragColor = vec4(uCol, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      ARC_MAX,
    );
    prep(this.dots, 14);

    // Landing pip: a small thin ring, white, low alpha, with a faint dark
    // backing so it survives bright sand. ~20 cm across — a pip, not a zone.
    const ringGeo = new THREE.RingGeometry(0.075, 0.095, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xf4f2ec, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.ring.renderOrder = 14;
    decalOffset(this.ring.material as THREE.Material); // 20 mm proud + offset
    const shadeGeo = new THREE.RingGeometry(0.06, 0.11, 40);
    shadeGeo.rotateX(-Math.PI / 2);
    this.ringShade = new THREE.Mesh(
      shadeGeo,
      new THREE.MeshBasicMaterial({
        color: 0x101010, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    this.ringShade.renderOrder = 13;
    decalOffset(this.ringShade.material as THREE.Material); // 15 mm proud + offset, 5 mm under the pip
    this.group.add(this.dots, this.ringShade, this.ring);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  hide(dt: number): void {
    this.show = Math.max(0, this.show - dt * 7);
    if (this.show <= 0.001) this.group.visible = false;
    else this.paint(dt);
  }

  /**
   * `pts` is the predicted path (xyz triples, `n` valid), `rest` the detonation
   * point and `surfaceY` the ground under it.
   */
  set(
    pts: Float32Array,
    n: number,
    rest: { x: number; y: number; z: number },
    surfaceY: number,
    dt: number,
    camera: THREE.Camera,
  ): void {
    this.group.visible = true;
    this.show = Math.min(1, this.show + dt * 6);
    camera.getWorldPosition(this.cam);
    this.n = Math.min(n, ARC_MAX);
    this.pts = pts;
    this.ring.position.set(rest.x, surfaceY + 0.02, rest.z);
    this.ringShade.position.set(rest.x, surfaceY + 0.015, rest.z);
    this.paint(dt);
  }

  private pts: Float32Array | null = null;
  private n = 0;

  private paint(_dt: number): void {
    const pts = this.pts;
    const fa = this.fade.array as Float32Array;
    let k = 0;
    if (pts) {
      // Skip the first samples: dashes inside the paw are noise, not guidance.
      const rev = this.show * this.n;
      for (let i = 3; i < this.n - 1; i++) {
        if (i > rev) break;
        // one dash per segment, 55% of it drawn: a fine dashed line
        this.v.set(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
        this.w.set(pts[i * 3 + 3]!, pts[i * 3 + 4]!, pts[i * 3 + 5]!);
        this.ax.subVectors(this.w, this.v);
        const len = this.ax.length();
        if (len < 1e-4) continue;
        this.ax.multiplyScalar(1 / len);
        // centre of the dash, and a width that stays ~1.5 px at any range
        this.v.addScaledVector(this.ax, len * 0.5);
        const d = this.v.distanceTo(this.cam);
        const wid = Math.max(0.007, d * 0.0028);
        this.az.subVectors(this.cam, this.v).normalize();
        this.ay.crossVectors(this.az, this.ax);
        if (this.ay.lengthSq() < 1e-8) continue;
        this.ay.normalize();
        this.az.crossVectors(this.ax, this.ay);
        this.m.makeBasis(this.ax.multiplyScalar(len * 0.55), this.ay.multiplyScalar(wid), this.az);
        this.m.setPosition(this.v);
        this.dots.setMatrixAt(k, this.m);
        // faint, and fainter with range — the eye follows it, it never shouts
        const t = i / Math.max(1, this.n - 1);
        fa[k] = (0.5 - 0.14 * t) * Math.min(1, 6 / Math.max(6, d)) * this.show;
        k++;
      }
    }
    this.dots.count = k;
    this.dots.instanceMatrix.needsUpdate = true;
    this.fade.needsUpdate = true;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * this.show;
    (this.ringShade.material as THREE.MeshBasicMaterial).opacity = 0.18 * this.show;
  }
}

/** The frag's collision radius, re-exported so the client can seat it on ground. */
export const NADE_R = NADE_RADIUS;
