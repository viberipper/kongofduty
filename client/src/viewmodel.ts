/**
 * FIRST-PERSON VIEWMODEL — the operator's gloved hands holding the tactical
 * guns (client/src/weapons/guns/*, the same models third person draws at "tp"
 * LOD), driven by a spring-based animation system ported in spirit from Kong
 * Royale's viewmodel (springs, hand frames, reload keyframes as fractions of the
 * sim's reload time) and the HELIOS rig's feel (look inertia, figure-eight bob,
 * recoil springs).
 *
 * Scene graph (camera space, -Z forward):
 *   root   depth/FOV scale only: a uniform squeeze about the eye (same image,
 *          half the depth — far less wall clipping) and an x/y scale that draws
 *          the viewmodel at its own vertical FOV (hold.vmFov) whatever the world
 *          FOV is doing (sprint / ADS zoom)
 *   └ pose      THE gun transform (hip/ADS/sprint blend + every offset + recoil);
 *               pose space == gun space (origin = trigger-hand grip, -Z = bore)
 *       ├ gun models (one per weapon, only the held one visible)
 *       ├ hands (KR skinned glove rig; frames in gun space, sleeves aimed at
 *       │        camera-space elbows)
 *       ├ flashMesh (camera-facing star) + flame cards along the bore
 *   └ nadeArm   the throwing hand + frag (camera space), the pin-pull hand
 *   └ drop      the spent magazine falling free on an empty reload
 *
 * game.ts contract (unchanged): root, pose, flash, flashMesh, setWeapon,
 * setSwap, fire, update, look, setAmmo, muzzleWorld, initBanana, initNade,
 * setNade, nadeHandWorld, nadeApparentScale + the NADE_* timings. New: ejectWorld,
 * ejectDirWorld, onEject (casing hook for the FX stream), buildFragMesh re-export.
 */
import * as THREE from "three";
import { PRIMARY_WEAPON_ID } from "@shared/weapons";
import { buildGun } from "./weapons/guns/index";
import "./weapons/guns/register";
import type { GunModelX } from "./weapons/guns/common";
import { createHand, createUpperArm, type Hand } from "./weapons/hands";
import { buildFragParts, FRAG_R, type FragParts } from "./weapons/guns/frag";
import { holdOf, type GripCfg, type Hold, type ReloadKind, type V3 } from "./weapons/holds";

export { buildFragMesh } from "./weapons/guns/frag";

// ------------------------------------------------------------------ the throw (timings: game.ts owns the input)
export const NADE_READY_T = 0.3;
export const NADE_THROW_T = 0.24;
export const NADE_RECOVER_T = 0.34;
/** Seconds into the THROW phase at which the frag actually leaves the hand. */
export const NADE_RELEASE_AT = 0.07;
/** Auto-throw after this long holding the wind-up. */
export const NADE_HOLD_MAX = 2;
/** 0 idle, 1 ready/hold (cooking), 2 throwing, 3 recovering. */
export type NadePhase = 0 | 1 | 2 | 3;

/** uniform depth squeeze of the whole viewmodel about the eye (same image, half the depth) */
const VM_DEPTH = 0.5;

// ------------------------------------------------------------------ math helpers
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth01 = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const bump = (x: number, a: number, b: number) => (x <= a || x >= b ? 0 : Math.sin(((x - a) / (b - a)) * Math.PI));
const win = (x: number, a: number, b: number) => smooth01((x - a) / (b - a));
const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;

/** a damped spring channel, sub-stepped (stable for any frame dt, incl. the test harness's multi-tick draws) */
class Spring {
  x = 0;
  v = 0;
  constructor(public k: number, public z: number) {}
  step(target: number, dt: number): number {
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n, c = 2 * Math.sqrt(this.k) * this.z;
    for (let i = 0; i < n; i++) {
      this.v += ((target - this.x) * this.k - this.v * c) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(x = 0): void { this.x = x; this.v = 0; }
}

// ------------------------------------------------------------------ hand frames
/** a hand pose in gun space: frame + grip section + finger state */
class Frame {
  p = new THREE.Vector3();
  q = new THREE.Quaternion();
  a = 0.02; b = 0.02; curl = 1; thumb = 1; index = 0;
  copy(f: Frame) { this.p.copy(f.p); this.q.copy(f.q); this.a = f.a; this.b = f.b; this.curl = f.curl; this.thumb = f.thumb; this.index = f.index; return this; }
  lerp(f0: Frame, f1: Frame, t: number) {
    this.p.lerpVectors(f0.p, f1.p, t);
    this.q.slerpQuaternions(f0.q, f1.q, t);
    this.a = f0.a + (f1.a - f0.a) * t; this.b = f0.b + (f1.b - f0.b) * t;
    this.curl = f0.curl + (f1.curl - f0.curl) * t; this.thumb = f0.thumb + (f1.thumb - f0.thumb) * t; this.index = f0.index + (f1.index - f0.index) * t;
    return this;
  }
  matrix(out: THREE.Matrix4) { return out.compose(this.p, this.q, ONE); }
}
const ONE = new THREE.Vector3(1, 1, 1);
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _mb = new THREE.Matrix4();
/** grip config -> frame (right hand: palm = +X_h; left hand: palm = -X_h) */
function gripFrame(g: GripCfg, side: "R" | "L", out = new Frame()): Frame {
  _y.set(...g.up).normalize();
  _x.set(...g.palm);
  _x.addScaledVector(_y, -_x.dot(_y)).normalize();
  if (side === "L") _x.negate();
  _z.crossVectors(_x, _y);
  _mb.makeBasis(_x, _y, _z);
  out.q.setFromRotationMatrix(_mb);
  out.p.set(...g.at);
  out.a = g.a; out.b = g.b; out.curl = g.curl ?? 1; out.thumb = g.thumb ?? out.curl; out.index = g.index ?? 0;
  return out;
}
/** a frame whose grip axis (+Y_h) is `up` and whose heel (+Z_h, the forearm) points as near `heel` as the axis allows */
function frameLook(up: THREE.Vector3, heel: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _y.copy(up).normalize();
  _z.copy(heel).addScaledVector(_y, -heel.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
  _z.normalize();
  _x.crossVectors(_y, _z);
  _mb.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_mb);
}

// ------------------------------------------------------------------ muzzle flash
let flashTex: { star: THREE.Texture; flame: THREE.Texture } | null = null;
function flashTextures() {
  if (flashTex) return flashTex;
  const mk = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    draw(c.getContext("2d")!);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const star = mk(256, 256, (g) => {
    g.translate(128, 128);
    for (let i = 0; i < 5; i++) {
      g.save();
      g.rotate((i / 5) * Math.PI * 2 + (i % 2 ? 0.2 : 0));
      const L = i % 2 ? 84 : 118, gr = g.createLinearGradient(0, 0, 0, -L);
      gr.addColorStop(0, "rgba(255,248,225,1)"); gr.addColorStop(0.3, "rgba(255,206,110,0.9)"); gr.addColorStop(0.75, "rgba(255,128,40,0.45)"); gr.addColorStop(1, "rgba(255,90,20,0)");
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(-16, 0); g.quadraticCurveTo(-12, -L * 0.55, 0, -L); g.quadraticCurveTo(12, -L * 0.55, 16, 0); g.closePath(); g.fill();
      g.restore();
    }
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 52);
    rg.addColorStop(0, "rgba(255,255,250,1)"); rg.addColorStop(0.4, "rgba(255,240,200,0.95)"); rg.addColorStop(1, "rgba(255,190,90,0)");
    g.fillStyle = rg; g.beginPath(); g.arc(0, 0, 52, 0, Math.PI * 2); g.fill();
  });
  const flame = mk(128, 256, (g) => {
    const gr = g.createLinearGradient(0, 256, 0, 0);
    gr.addColorStop(0, "rgba(255,252,235,1)"); gr.addColorStop(0.25, "rgba(255,214,110,0.95)"); gr.addColorStop(0.7, "rgba(255,136,46,0.55)"); gr.addColorStop(1, "rgba(255,90,20,0)");
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(40, 256); g.quadraticCurveTo(10, 140, 64, 0); g.quadraticCurveTo(118, 140, 88, 256); g.closePath(); g.fill();
  });
  flashTex = { star, flame };
  return flashTex;
}
function flashMat(t: THREE.Texture, k: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(k, k * 0.94, k * 0.82), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, fog: false });
}

// ------------------------------------------------------------------ per-weapon loadout
type Loadout = {
  id: string;
  gun: GunModelX;
  hold: Hold;
  restR: Frame;
  restL: Frame | null;
  /** ADS pose: gun origin in camera space when aimed */
  adsP: THREE.Vector3;
  hipQ: THREE.Quaternion;
  sprQ: THREE.Quaternion;
  mag: THREE.Object3D | null;
  magParent: THREE.Matrix4;
  magParentInv: THREE.Matrix4;
  magRest: THREE.Matrix4;
  /** the support hand's frame expressed in mag space (and its inverse) */
  magGripLocal: THREE.Matrix4;
  magGripLocalInv: THREE.Matrix4;
  magFrame: Frame;
  drop: THREE.Object3D | null;
  bolt: THREE.Object3D | null;
  boltParent: THREE.Matrix4;
  boltParentInv: THREE.Matrix4;
  slide: THREE.Object3D | null;
  charge: THREE.Object3D | null;
  catchP: THREE.Object3D | null;
  reticle: THREE.MeshBasicMaterial | null;
  lens: THREE.Mesh[];
  lensMat: THREE.MeshPhysicalMaterial | null;
};

const POUCH = new THREE.Vector3(-0.08, -0.46, -0.32);
/** the trigger hand on a bolt knob: palm over it from above-behind, index toward the action, forearm back and down */
const BOLT_GRIP: GripCfg = { at: [0, 0, 0], up: [-1, 0.1, -0.15], palm: [0.15, 0.62, 0.77], a: 0.0122, b: 0.0122, curl: 0.82, thumb: 0.7, index: 0 };
/** camera-space shoulders the upper arms hang toward (off-screen, behind the lens) */
const SHOULDER_R = new THREE.Vector3(0.19, -0.26, 0.14);
const SHOULDER_L = new THREE.Vector3(-0.22, -0.26, 0.12);
const Y_UP = new THREE.Vector3(0, 1, 0);
const Z_FWD = new THREE.Vector3(0, 0, 1);
const _M = new THREE.Matrix4(), _M2 = new THREE.Matrix4(), _M3 = new THREE.Matrix4();
const _p = new THREE.Vector3(), _p2 = new THREE.Vector3(), _d = new THREE.Vector3(), _s = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const IDQ = new THREE.Quaternion();

function eulerQ(r: V3, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(_e.set(r[0], r[1], r[2], "YXZ"));
}

export class Viewmodel {
  root = new THREE.Group();
  pose = new THREE.Group();
  flash: THREE.PointLight;
  flashMesh: THREE.Mesh;
  private flame = new THREE.Group();
  current = PRIMARY_WEAPON_ID;
  private loadouts = new Map<string, Loadout>();
  private handR: Hand;
  private handL: Hand;
  private upR = createUpperArm("R");
  private upL = createUpperArm("L");
  private upT = createUpperArm("R");
  private upP = createUpperArm("L");
  /** Optional close-up reflection environment (game.ts sets it on Ares). */
  envMap: THREE.Texture | null = null;
  /** Casing hook (FX stream): world position + direction of a casing leaving the port, the weapon, and the viewmodel's world scale. */
  onEject?: (pos: THREE.Vector3, dir: THREE.Vector3, weaponId: string, scale?: number) => void;

  // state
  private adsE = 0;
  private bob = 0;
  private idle = 0;
  private swapK = 0;
  private lastSwapK = 0;
  private ammo = 30;
  private magSize = 30;
  private reloadU = 0;
  private reloadEmpty = false;
  private lastReload = 0;
  private sinceShot = 9;
  private boltT = 9;
  private boltEjected = true;
  private dropT = -1;
  private dropV = new THREE.Vector3();
  private dropW = new THREE.Vector3();
  private dropObj: THREE.Object3D | null = null;
  private lookYaw = 0;
  private lookPitch = 0;
  private lastYaw: number | null = null;
  private lastPitch = 0;
  private flashT = 9;
  private flashHold = 0;
  private recoilSeq = 0;
  // springs
  private sMove = new Spring(40, 1);
  private sSprint = new Spring(70, 0.9);
  private sCrouch = new Spring(60, 0.9);
  private sSlide = new Spring(80, 0.8);
  private sSwap = new Spring(220, 0.75);
  private sNade = new Spring(90, 0.9);
  private swayX = new Spring(140, 0.72);
  private swayY = new Spring(140, 0.72);
  private rp = [new Spring(900, 0.6), new Spring(900, 0.6), new Spring(900, 0.6)];
  private rr = [new Spring(800, 0.55), new Spring(800, 0.55), new Spring(800, 0.55)];
  // frames (scratch)
  private fR = new Frame();
  private fL = new Frame();
  private F = { pouch: new Frame(), mag: new Frame(), magOut: new Frame(), below: new Frame(), rack: new Frame(), rackBack: new Frame(), catchF: new Frame(), bolt: new Frame(), port: new Frame(), portIn: new Frame(), chargeF: new Frame() };
  private off = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  private poseM = new THREE.Matrix4();
  private baseP = new THREE.Vector3();
  private baseQ = new THREE.Quaternion();
  private adsQ = new THREE.Quaternion();
  private flashRoll = 0;
  private poseInv = new THREE.Matrix4();
  private elR = new THREE.Vector3();
  private elL = new THREE.Vector3();
  private lVis = true;

  constructor() {
    this.root.name = "viewmodel";
    this.pose.name = "vm-pose";
    this.root.add(this.pose);
    this.handR = createHand("R");
    this.handL = createHand("L");
    this.pose.add(this.handR.mesh, this.handL.mesh);
    this.root.add(this.upR, this.upL, this.upT, this.upP);
    this.upT.visible = this.upP.visible = false;
    // muzzle flash: a camera-facing star + two crossed flame cards along the bore
    const T = flashTextures();
    this.flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flashMat(T.star, 2.2));
    this.flashMesh.name = "vm-flash";
    this.flashMesh.renderOrder = 12;
    this.flashMesh.frustumCulled = false;
    this.pose.add(this.flashMesh);
    for (const r of [0, Math.PI / 2]) {
      const pl = new THREE.PlaneGeometry(0.55, 1.6);
      pl.translate(0, 0.8, 0);
      pl.rotateX(-Math.PI / 2);
      pl.rotateZ(r);
      const m = new THREE.Mesh(pl, flashMat(T.flame, 1.7));
      m.renderOrder = 12;
      m.frustumCulled = false;
      this.flame.add(m);
    }
    this.pose.add(this.flame);
    this.flash = new THREE.PointLight(0xffc27a, 0, 4, 2);
    this.flash.name = "vm-flash-light";
    this.buildNadeArm();
    this.root.add(this.nadeArm, this.pinHand.mesh);
    this.setLoadout(this.current);
  }

  // ------------------------------------------------------------------ guns
  private loadout(id: string): Loadout {
    let lo = this.loadouts.get(id);
    if (lo) return lo;
    const gun = buildGun(id, "fp") as GunModelX;
    if (!gun.parts) gun.parts = {};
    if (!gun.anchors) gun.anchors = {};
    gun.root.visible = false;
    gun.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; }
    });
    this.pose.add(gun.root);
    const hold = holdOf(id);
    const restR = gripFrame(hold.r, "R");
    const restL = hold.l ? gripFrame(hold.l, "L") : null;
    const sr = gun.sight?.rear ?? new THREE.Vector3(0, 0.07, 0);
    const adsP = new THREE.Vector3(-sr.x, -sr.y, -hold.eye - sr.z);
    const mag = gun.mag;
    const magParent = new THREE.Matrix4(), magRest = new THREE.Matrix4(), magGripLocal = new THREE.Matrix4();
    const magFrame = new Frame();
    let drop: THREE.Object3D | null = null;
    if (mag && mag.parent) {
      gun.root.updateMatrixWorld(true);
      // mag parent relative to the gun root (== pose space)
      magParent.copy(gun.root.matrixWorld).invert().multiply(mag.parent.matrixWorld);
      mag.updateMatrix();
      magRest.copy(mag.matrix);
      if (hold.magGrip) {
        gripFrame(hold.magGrip, "L", magFrame);
        magFrame.matrix(_M);
        magGripLocal.copy(magParent).multiply(magRest).invert().multiply(_M);
      }
      drop = mag.clone(true);
      drop.visible = false;
      drop.name = `${id}-drop`;
      this.root.add(drop);
    }
    // optic glass: a per-viewmodel clone so ADS can thin it out; reticles fade in with ADS
    const lens: THREE.Mesh[] = [];
    let lensMat: THREE.MeshPhysicalMaterial | null = null;
    let reticle: THREE.MeshBasicMaterial | null = null;
    gun.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name.endsWith(":glass")) {
        lensMat ??= (m.material as THREE.MeshPhysicalMaterial).clone();
        m.material = lensMat;
        lens.push(m);
      }
      const rm = o.name === "reticle" ? (o.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined) : undefined;
      if (rm) {
        const mat = (rm.material as THREE.MeshBasicMaterial).clone();
        o.traverse((c) => { if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).material = mat; });
        reticle = mat;
      }
    });
    const boltParent = new THREE.Matrix4();
    const boltPart = gun.parts.bolt ?? null;
    if (boltPart?.parent) {
      gun.root.updateMatrixWorld(true);
      boltParent.copy(gun.root.matrixWorld).invert().multiply(boltPart.parent.matrixWorld);
    }
    lo = {
      id, gun, hold, restR, restL, adsP,
      hipQ: eulerQ(hold.hip.r), sprQ: eulerQ(hold.sprint.r),
      mag, magParent, magParentInv: magParent.clone().invert(), magRest, magGripLocal, magGripLocalInv: magGripLocal.clone().invert(), magFrame,
      drop,
      bolt: boltPart,
      boltParent, boltParentInv: boltParent.clone().invert(),
      slide: gun.parts.slide ?? null,
      charge: gun.parts.charge ?? null,
      catchP: gun.parts.catch ?? null,
      reticle, lens, lensMat,
    };
    this.loadouts.set(id, lo);
    return lo;
  }

  private setLoadout(id: string): void {
    for (const [k, l] of this.loadouts) l.gun.root.visible = k === id;
    const lo = this.loadout(id);
    lo.gun.root.visible = true;
    this.current = id;
    this.handL.mesh.visible = !!lo.restL;
    // a fresh gun starts from its rest pose (no spring carry-over from the last one)
    for (const s of [...this.rp, ...this.rr]) s.reset();
    this.boltT = 9;
    this.sinceShot = 9;
    this.resetParts(lo);
  }

  setWeapon(id: string): void {
    if (id === this.current) return;
    this.setLoadout(id);
  }

  /** 1 = the new gun is just coming up from below the frame, 0 = ready. */
  setSwap(k: number): void {
    this.swapK = k;
  }

  setAmmo(ammo: number, mag: number): void {
    this.ammo = ammo;
    this.magSize = mag;
  }

  /** Camera aim this frame (radians): drives the look-inertia sway. */
  look(yaw: number, pitch: number): void {
    this.lookYaw = yaw;
    this.lookPitch = pitch;
  }

  /** Every gun built up front (async boot hook: yields between guns so the boot card keeps painting). */
  async initBanana(lowDetail = false): Promise<void> {
    void lowDetail;
    for (const id of ["ar", "smg", "sniper", "pistol"]) {
      this.loadout(id);
      await new Promise((r) => setTimeout(r, 0));
    }
    this.setLoadout(this.current);
    if (this.envMap) {
      // a close-up reflection environment for the viewmodel ONLY: clone the shared
      // gun / glove materials (the third-person guns keep the scene's environment)
      const clones = new Map<THREE.Material, THREE.Material>();
      const own = new Set<THREE.Material>();
      for (const l of this.loadouts.values()) if (l.lensMat) own.add(l.lensMat);
      const swap = (x: THREE.Material): THREE.Material => {
        if (!(x as THREE.MeshStandardMaterial).isMeshStandardMaterial) return x; // reticles / flash stay unlit
        if (own.has(x)) { (x as THREE.MeshStandardMaterial).envMap = this.envMap; return x; } // the lens clone the ADS fade drives
        let c = clones.get(x);
        if (!c) {
          c = x.clone();
          (c as THREE.MeshStandardMaterial).envMap = this.envMap;
          clones.set(x, c);
        }
        return c;
      };
      this.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
      });
    }
  }

  // ------------------------------------------------------------------ fire
  fire(): void {
    const lo = this.loadout(this.current);
    const R = lo.hold.recoil;
    const a = 1 - this.adsE * (1 - R.ads);
    const rnd = () => Math.random() * 2 - 1;
    this.recoilSeq++;
    this.rp[2]!.v += R.back * (1 - this.adsE * 0.35);
    this.rp[1]!.v += R.up * a;
    this.rp[0]!.v += rnd() * R.yaw * 0.02 * a;
    this.rr[0]!.v += R.pitch * a * (0.85 + Math.random() * 0.3);
    this.rr[1]!.v += rnd() * R.yaw * a;
    this.rr[2]!.v += rnd() * R.roll * a;
    this.sinceShot = 0;
    this.flashT = 0;
    this.flashHold = 1;
    this.flash.intensity = lo.hold.flash.light * 0.5 * (1 - this.adsE * 0.45);
    this.flashRoll = Math.random() * Math.PI * 2;
    if (lo.hold.reload === "bolt") {
      this.boltT = 0;
      this.boltEjected = false;
    } else this.emitEject(lo);
  }

  private emitEject(lo: Loadout): void {
    if (!this.onEject) return;
    this.onEject(this.ejectWorld().clone(), this.ejectDirWorld().clone(), lo.id, this.worldScale());
  }

  private ejW = new THREE.Vector3();
  private ejD = new THREE.Vector3();
  /** World position of the ejection port (where a casing leaves). */
  ejectWorld(out: THREE.Vector3 = this.ejW): THREE.Vector3 {
    const lo = this.loadout(this.current);
    this.pose.updateWorldMatrix(true, false);
    return out.copy(lo.gun.eject).applyMatrix4(this.pose.matrixWorld);
  }

  /** World direction a casing leaves in: out to the right, up and a little back. */
  ejectDirWorld(out: THREE.Vector3 = this.ejD): THREE.Vector3 {
    const lo = this.loadout(this.current);
    this.pose.updateWorldMatrix(true, false);
    const up = lo.hold.reload === "pistol" ? 0.75 : 0.45;
    return out.set(1, up, 0.25).normalize().transformDirection(this.pose.matrixWorld);
  }

  /**
   * Where the muzzle-flash LIGHT goes (camera space, written into `out`): half a
   * metre ahead of the muzzle along the bore, so it lights the world in front
   * and the gun gently instead of blowing the receiver out to white at 10 cm.
   */
  flashLightPos(out: THREE.Vector3): THREE.Vector3 {
    const lo = this.loadout(this.current);
    this.pose.updateMatrix();
    this.root.updateMatrix();
    return out.copy(lo.gun.muzzle).add(_d.set(0, 0, -0.8)).applyMatrix4(this.pose.matrix).applyMatrix4(this.root.matrix);
  }

  /** the viewmodel's world scale (depth squeeze): casings/props spawned at its anchors should start this size */
  worldScale(): number {
    return this.root.scale.x;
  }

  muzzleWorld(): THREE.Vector3 {
    const lo = this.loadout(this.current);
    this.pose.updateWorldMatrix(true, false);
    return lo.gun.muzzle.clone().applyMatrix4(this.pose.matrixWorld);
  }

  // ------------------------------------------------------------------ per-frame
  update(dt: number, ads: number, sprint: boolean, slide: number, moving: number, reload: number, yawSway: number, crouch = false): void {
    dt = Math.min(Math.max(dt, 0), 0.75);
    const lo = this.loadout(this.current);
    const H = lo.hold;
    this.idle += dt;
    this.sinceShot += dt;
    this.boltT += dt;
    this.flashT += dt;

    // ---- reload state (empty vs tactical latched at the start)
    const reloading = reload > 0 && reload < 1;
    if (reloading && this.lastReload <= 0) {
      this.reloadEmpty = this.ammo <= 0;
      this.dropDone = false;
    }
    this.lastReload = reloading ? reload : 0;
    this.reloadU = reloading ? reload : 0;

    // ---- smoothed state
    // ADS follows the sim exactly (no extra lag: aimed means the sight IS on the crosshair)
    this.adsE = smooth01(ads);
    const ae = this.adsE;
    const mv = this.sMove.step(Math.min(1, moving), dt);
    const spr = this.sSprint.step(sprint && ads < 0.2 && !reloading ? 1 : 0, dt);
    const cr = this.sCrouch.step(crouch ? 1 : 0, dt);
    const sl = this.sSlide.step(slide > 0 ? 1 : 0, dt);
    const nadeWant = this.nadePhase === 1 || this.nadePhase === 2 ? 1 : 0;
    const nd = this.sNade.step(nadeWant, dt);
    if (this.swapK > this.lastSwapK + 0.3) this.sSwap.reset(this.swapK);
    this.lastSwapK = this.swapK;
    const sw = Math.max(0, this.sSwap.step(this.swapK * this.swapK, dt));

    // ---- base pose: hip -> sprint -> ADS (recomputed per frame: holds are live-tunable)
    eulerQ(H.hip.r, lo.hipQ);
    eulerQ(H.sprint.r, lo.sprQ);
    // ADS: the sight line ON the view axis, optionally canted about that axis (a roll
    // about the sight line keeps the sight picture centred; the pistol uses it so the
    // hands read from a 3/4 angle instead of end-on)
    const sr = lo.gun.sight?.rear;
    const cant = H.adsRoll ?? 0;
    this.adsQ.setFromAxisAngle(Z_FWD, cant);
    if (sr) lo.adsP.copy(sr).applyQuaternion(this.adsQ).negate().add(_p2.set(0, 0, -H.eye));
    const sprW = spr * (1 - ae);
    const P = this.baseP.set(...H.hip.p).lerp(_p2.set(...H.sprint.p), sprW);
    const Q = this.baseQ.copy(lo.hipQ).slerp(lo.sprQ, sprW);
    P.lerp(lo.adsP, ae);
    Q.slerp(this.adsQ, ae);
    let px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0;
    // arc into the sights: the gun dips and rolls in mid-transition, never slides on a rail
    const mid = Math.sin(Math.PI * ae);
    py -= mid * 0.012;
    px -= mid * 0.006;
    rz += mid * 0.09;
    rx -= mid * 0.025;

    // ---- movement: figure-eight bob at footstep cadence
    this.bob += dt * (sprint ? 14.5 : crouch ? 8.2 : 11) * Math.min(1, moving + 0.0001) * (moving > 0.05 ? 1 : 0);
    const bA = mv * (1 - ae * 0.88) * (1 + spr * 0.9) * (1 - cr * 0.35);
    px += Math.sin(this.bob * 0.5) * 0.0085 * bA;
    py += (-Math.abs(Math.cos(this.bob * 0.5)) * 0.0075 + 0.0035) * bA;
    rz += Math.sin(this.bob * 0.5) * 0.022 * bA;
    rx += Math.cos(this.bob) * 0.009 * bA;
    ry += Math.sin(this.bob * 0.5) * 0.01 * bA * spr;

    // ---- idle breathing (almost nothing aimed: the reticle rests where you put it)
    const br = 1 - ae * 0.9;
    py += Math.sin(this.idle * 1.55) * 0.0016 * br;
    px += Math.cos(this.idle * 0.9) * 0.0009 * br;
    rx += Math.sin(this.idle * 1.2 + 0.4) * 0.0032 * br;
    rz += Math.sin(this.idle * 0.7) * 0.004 * br;

    // ---- look inertia: the gun trails the camera and springs back
    if (this.lastYaw === null) { this.lastYaw = this.lookYaw; this.lastPitch = this.lookPitch; }
    let dy = this.lookYaw - this.lastYaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    const dp = this.lookPitch - this.lastPitch;
    this.lastYaw = this.lookYaw;
    this.lastPitch = this.lookPitch;
    const h = Math.max(dt, 1 / 240);
    const swK = 1 - ae * 0.8;
    const sx = this.swayX.step(THREE.MathUtils.clamp((dy / h) * 0.006, -0.03, 0.03) * swK, dt);
    const sy = this.swayY.step(THREE.MathUtils.clamp((dp / h) * 0.005, -0.025, 0.025) * swK, dt);
    px += sx * 0.55;
    py += sy * 0.45;
    ry -= sx * 1.6;
    rx += sy * 1.6;
    rz += sx * 1.3;
    ry += yawSway * 0.15 * (1 - ae * 0.7);

    // ---- stance: crouch, slide
    const hipK = 1 - ae;
    py -= cr * 0.008 * hipK;
    px -= cr * 0.006 * hipK;
    rz += cr * 0.06 * hipK;
    py -= sl * 0.03;
    px -= sl * 0.02;
    rz += sl * 0.24;
    rx += sl * 0.05;

    // ---- swap: the gun comes up from below the frame, rotating into the hold
    py -= sw * 0.2;
    px += sw * 0.03;
    pz += sw * 0.06;
    rx -= sw * 0.95;
    rz -= sw * 0.4;

    // ---- frag: the gun goes fully off-screen while the throwing arm is up
    py -= nd * 0.32;
    px += nd * 0.05;
    pz += nd * 0.04;
    rx -= nd * 0.7;
    rz -= nd * 0.25;

    // ---- reload choreography (gun offsets + hand frames + parts)
    this.fR.copy(lo.restR);
    if (lo.restL) this.fL.copy(lo.restL);
    this.lVis = !!lo.restL;
    const o = this.off;
    o.px = o.py = o.pz = o.rx = o.ry = o.rz = 0;
    this.resetParts(lo);
    if (reloading) this.evalReload(lo, this.reloadU);
    else if (H.reload === "bolt" && this.boltT < 1.0) this.evalBoltCycle(lo, this.boltT);
    px += o.px; py += o.py; pz += o.pz; rx += o.rx; ry += o.ry; rz += o.rz;

    // ---- fire cycle: bolt carrier / slide blowback; slide locked back on an empty pistol
    if (lo.hold.cycle > 0) {
      const c = lo.hold.cycle * bump(this.sinceShot, 0, 0.06);
      if (lo.slide) {
        const locked = this.ammo <= 0 && (!reloading || (this.reloadEmpty && this.reloadU < 0.8));
        lo.slide.position.z += locked ? lo.hold.cycle * 0.92 : c;
      }
      if (lo.bolt && !lo.slide) lo.bolt.position.z += c;
    }

    // ---- recoil springs (impulses from fire())
    const R = H.recoil;
    for (const s of this.rp) { s.k = R.kP; s.z = R.zP; }
    for (const s of this.rr) { s.k = R.kR; s.z = R.zR; }
    px += this.rp[0]!.step(0, dt);
    py += this.rp[1]!.step(0, dt);
    pz += this.rp[2]!.step(0, dt);
    rx += this.rr[0]!.step(0, dt);
    ry += this.rr[1]!.step(0, dt);
    rz += this.rr[2]!.step(0, dt);

    // ---- write the pose
    this.pose.position.set(P.x + px, P.y + py, P.z + pz);
    eulerQ([rx, ry, rz], _q2);
    this.pose.quaternion.copy(_q2).multiply(Q);
    this.pose.updateMatrix();
    this.poseM.copy(this.pose.matrix);
    this.poseInv.copy(this.poseM).invert();

    // ---- depth squeeze + the viewmodel's own FOV
    const cam = this.root.parent as THREE.PerspectiveCamera | null;
    const camFov = cam && (cam as THREE.PerspectiveCamera).isPerspectiveCamera ? cam.fov : 68;
    // the viewmodel zooms in late in the raise (the gun arrives, then the sight fills): ae^2
    const vmFov = H.vmFov + (H.vmFovAds - H.vmFov) * ae * ae;
    const kxy = VM_DEPTH * Math.tan((camFov * Math.PI) / 360) / Math.tan((vmFov * Math.PI) / 360);
    this.root.scale.set(kxy, kxy, VM_DEPTH);

    // ---- hands
    this.elR.set(...H.elbowR).lerp(_p2.set(...H.elbowRAds), ae);
    this.elL.set(...H.elbowL).lerp(_p2.set(...H.elbowLAds), ae);
    this.placeHand(this.handR, this.fR, this.elR, this.upR, SHOULDER_R, this.poseM);
    this.handL.mesh.visible = this.lVis;
    this.upL.visible = this.lVis;
    if (this.lVis) this.placeHand(this.handL, this.fL, this.elL, this.upL, SHOULDER_L, this.poseM);

    // ---- optics: reticle in with the sights, glass thins out so the sight picture stays clean
    if (lo.reticle) lo.reticle.opacity = smooth01((ae - 0.55) / 0.35);
    if (lo.lensMat) {
      // aimed through it, the glass all but disappears: a faint coating, no mirror
      lo.lensMat.opacity = 0.24 - 0.2 * ae;
      lo.lensMat.envMapIntensity = 1.6 * (1 - 0.9 * ae);
      lo.lensMat.clearcoat = 1 - 0.9 * ae;
    }

    // ---- muzzle flash at the real muzzle: smaller and dimmer aimed
    const fs = H.flash.size * (1 - ae * 0.45);
    const fOn = this.flashHold > 0 || this.flashT < 0.045;
    const fa = fOn ? (1 - ae * 0.4) : 0;
    this.flashMesh.position.copy(lo.gun.muzzle);
    this.flame.position.copy(lo.gun.muzzle);
    // the star faces the eye: undo the pose rotation
    this.flashMesh.quaternion.copy(this.pose.quaternion).invert();
    this.flashMesh.rotateZ(this.flashRoll);
    this.flashMesh.scale.setScalar(fs * (0.85 + 0.3 * Math.random()));
    (this.flashMesh.material as THREE.MeshBasicMaterial).opacity = fa;
    this.flame.scale.setScalar(fs * 0.9);
    for (const c of this.flame.children) ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = fa * 0.9;
    this.flame.visible = fa > 0;
    this.flashMesh.visible = fa > 0;
    this.flashHold = Math.max(0, this.flashHold - 1);
    this.flash.intensity = fOn ? H.flash.light * 0.5 * (1 - ae * 0.45) * (this.flashT < 0.02 ? 1 : 0.6) : 0;

    // ---- the dropped magazine
    this.stepDrop(dt);

    // ---- the throwing arm
    this.poseNade(dt);
  }

  private _hm = new THREE.Matrix4();
  private _hp = new THREE.Vector3();
  private _he = new THREE.Vector3();
  /**
   * Put a hand at a frame (in `space`, whose matrix in camera space is
   * `spaceM`), aim its forearm at a camera-space elbow target, and hang the
   * upper-arm sleeve from the elbow it actually reached toward the shoulder.
   */
  private placeHand(hand: Hand, f: Frame, elbowCam: THREE.Vector3, upper: THREE.Mesh, shoulder: THREE.Vector3, spaceM: THREE.Matrix4): void {
    hand.mesh.position.copy(f.p);
    hand.mesh.quaternion.copy(f.q);
    hand.setGrip(f.a, f.b, f.curl, f.thumb, f.index);
    // elbow target: camera space -> frame space -> hand space
    this._hm.compose(f.p, f.q, ONE);
    _M3.multiplyMatrices(spaceM, this._hm); // hand -> camera
    _M2.copy(_M3).invert();
    this._hp.copy(elbowCam).applyMatrix4(_M2);
    hand.aimForearmLocal(this._hp);
    // the elbow it reached (camera space) -> the upper arm toward the shoulder
    hand.elbowLocal(this._he).applyMatrix4(_M3);
    upper.position.copy(this._he);
    _d.copy(shoulder).sub(this._he).normalize();
    upper.quaternion.setFromUnitVectors(Y_UP, _d);
  }

  // ------------------------------------------------------------------ parts
  private resetParts(lo: Loadout): void {
    for (const part of [lo.mag, lo.bolt, lo.slide, lo.charge, lo.catchP]) {
      if (!part) continue;
      const home = part.userData.home as { p: THREE.Vector3; q: THREE.Quaternion } | undefined;
      if (home) { part.position.copy(home.p); part.quaternion.copy(home.q); }
      part.visible = true;
    }
  }

  /** a camera-space point -> gun space (this frame's pose, before it is written: use the previous) */
  private camToGun(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).applyMatrix4(this.poseInv);
  }

  /** carry the mag in the support hand frame */
  private magToHand(lo: Loadout, f: Frame): void {
    if (!lo.mag) return;
    f.matrix(_M);
    _M2.copy(lo.magParentInv).multiply(_M).multiply(lo.magGripLocalInv);
    _M2.decompose(lo.mag.position, lo.mag.quaternion, _s);
  }

  private magFrameAt(lo: Loadout, magMatrix: THREE.Matrix4, out: Frame): Frame {
    _M.copy(lo.magParent).multiply(magMatrix).multiply(lo.magGripLocal);
    _M.decompose(out.p, out.q, _s);
    out.a = lo.magFrame.a; out.b = lo.magFrame.b; out.curl = 1; out.thumb = 1; out.index = 0;
    return out;
  }

  private dropDone = false;
  /** the spent mag leaves the gun where it is now and falls, tumbling (camera space) */
  private startDrop(lo: Loadout): void {
    if (this.dropDone || !lo.drop || !lo.mag) return;
    this.dropDone = true;
    lo.mag.updateMatrix();
    _M.copy(this.poseM).multiply(lo.magParent).multiply(lo.mag.matrix);
    _M.decompose(lo.drop.position, lo.drop.quaternion, _s);
    lo.drop.visible = true;
    this.dropObj = lo.drop;
    this.dropT = 0;
    this.dropV.set(-0.05, -0.5, 0.06);
    this.dropW.set(2.2 + Math.random(), 0.6, 1.4);
  }

  private stepDrop(dt: number): void {
    if (this.dropT < 0 || !this.dropObj) return;
    this.dropT += dt;
    this.dropV.y -= 7 * dt;
    this.dropObj.position.addScaledVector(this.dropV, dt);
    this.dropObj.rotateX(this.dropW.x * dt);
    this.dropObj.rotateZ(this.dropW.z * dt);
    if (this.dropT > 0.6) { this.dropObj.visible = false; this.dropT = -1; this.dropObj = null; }
  }

  /** set the support hand by blending two frames over [a, b] of u */
  private setL(u: number, k0: Frame, k1: Frame, a: number, b: number): void {
    this.fL.lerp(k0, k1, win(u, a, b));
  }
  private setR(u: number, k0: Frame, k1: Frame, a: number, b: number): void {
    this.fR.lerp(k0, k1, win(u, a, b));
  }

  /** the reload pose at progress u (0..1 of the sim's reload time) */
  private evalReload(lo: Loadout, u: number): void {
    const H = lo.hold, kind: ReloadKind = H.reload, F = this.F, o = this.off, empty = this.reloadEmpty;
    const restL = lo.restL ?? lo.restR;
    // shared frames: the pouch (off-screen below-left), the mag seated
    this.camToGun(POUCH, F.pouch.p);
    F.pouch.q.copy(restL.q); F.pouch.a = 0.012; F.pouch.b = 0.03; F.pouch.curl = 1; F.pouch.thumb = 1; F.pouch.index = 0;
    if (lo.mag && H.magGrip) {
      this.magFrameAt(lo, lo.magRest, F.mag);
      F.pouch.q.copy(F.mag.q);
      _d.set(0, -1, 0).applyQuaternion(F.mag.q);
      F.magOut.copy(F.mag); F.magOut.p.addScaledVector(_d, kind === "pistol" ? 0.1 : 0.14); F.magOut.p.x -= 0.03;
      F.below.copy(F.mag); F.below.p.addScaledVector(_d, 0.075);
    } else {
      F.mag.copy(restL); F.magOut.copy(F.pouch); F.below.copy(F.pouch);
    }
    if (kind === "mag") {
      // the gun rolls onto its right side (magwell toward the eye), dips and comes in
      const tilt = win(u, 0, 0.14) * (1 - win(u, 0.84, 1));
      // magwell toward the eye: roll the top right, muzzle up and in
      o.rz = -tilt * 0.48; o.rx = tilt * 0.16; o.ry = tilt * 0.14; o.px = -tilt * 0.045; o.py = tilt * 0.03; o.pz = tilt * 0.01;
      if (!empty) {
        // TACTICAL: grab, pull, stow the old mag below; fetch the fresh one, seat it, slap
        if (u < 0.12) this.setL(u, restL, F.mag, 0, 0.12);
        else if (u < 0.18) this.fL.copy(F.mag);
        else if (u < 0.3) this.setL(u, F.mag, F.magOut, 0.18, 0.3);
        else if (u < 0.42) this.setL(u, F.magOut, F.pouch, 0.3, 0.42);
        else if (u < 0.56) this.setL(u, F.pouch, F.below, 0.42, 0.56);
        else if (u < 0.64) this.setL(u, F.below, F.mag, 0.56, 0.64);
        else if (u < 0.7) this.fL.copy(F.mag);
        else this.setL(u, F.mag, restL, 0.7, 0.86);
        if (lo.mag) {
          if (u >= 0.18 && u < 0.64) this.magToHand(lo, this.fL);
        }
        o.py += 0.01 * bump(u, 0.62, 0.7); o.rx += 0.05 * bump(u, 0.62, 0.7);
      } else {
        // EMPTY: the mag drops free, the fresh one goes in, then the bolt goes home
        if (u < 0.1) this.setL(u, restL, restL, 0, 0.1);
        else if (u < 0.3) this.setL(u, restL, F.pouch, 0.1, 0.3);
        else if (u < 0.44) this.setL(u, F.pouch, F.below, 0.3, 0.44);
        else if (u < 0.52) this.setL(u, F.below, F.mag, 0.44, 0.52);
        else if (u < 0.56) this.fL.copy(F.mag);
        if (lo.mag) {
          if (u >= 0.08 && u < 0.12) { lo.mag.position.y -= 0.03 * win(u, 0.08, 0.12); }
          else if (u >= 0.12 && u < 0.3) { lo.mag.position.y -= 0.03; this.startDrop(lo); lo.mag.visible = false; }
          else if (u >= 0.3 && u < 0.52) this.magToHand(lo, this.fL);
        }
        o.py += 0.01 * bump(u, 0.5, 0.58); o.rx += 0.05 * bump(u, 0.5, 0.58);
        if (lo.catchP && lo.id === "ar") {
          // AR: palm the bolt catch on the left of the receiver
          const c = lo.gun.anchors.catch ?? new THREE.Vector3(-0.015, -0.02, -0.07);
          F.catchF.copy(restL);
          F.catchF.p.copy(c).add(_d.set(-0.022, 0.004, -0.004));
          frameLook(_d.set(0, 0.2, -1), _p2.set(-0.6, -0.8, 0.2), F.catchF.q);
          F.catchF.a = 0.012; F.catchF.b = 0.02; F.catchF.curl = 0.35; F.catchF.thumb = 0.3;
          if (u >= 0.56 && u < 0.66) this.setL(u, F.mag, F.catchF, 0.56, 0.66);
          else if (u >= 0.66 && u < 0.72) this.fL.copy(F.catchF);
          else if (u >= 0.72) this.setL(u, F.catchF, restL, 0.72, 0.88);
          if (u >= 0.66 && u < 0.72) lo.catchP.rotateZ(-0.25 * bump(u, 0.66, 0.72));
          o.pz += 0.006 * bump(u, 0.67, 0.75); o.rx += 0.03 * bump(u, 0.67, 0.76);
        } else if (lo.charge) {
          // SMG: the HK slap — pull the side charger back, let it fly home
          const k = lo.gun.anchors.chargeKnob ?? new THREE.Vector3(-0.02, 0.02, -0.15);
          F.chargeF.copy(restL);
          F.chargeF.p.copy(k).add(_d.set(-0.016, 0.0, 0.0));
          frameLook(_d.set(0, 0.95, 0.3), _p2.set(-0.7, -0.6, 0.3), F.chargeF.q);
          F.chargeF.a = 0.006; F.chargeF.b = 0.012; F.chargeF.curl = 0.9; F.chargeF.thumb = 0.8;
          F.rackBack.copy(F.chargeF); F.rackBack.p.z += 0.06;
          if (u >= 0.56 && u < 0.66) this.setL(u, F.mag, F.chargeF, 0.56, 0.66);
          else if (u >= 0.66 && u < 0.74) this.setL(u, F.chargeF, F.rackBack, 0.66, 0.74);
          else if (u >= 0.74 && u < 0.78) this.fL.copy(F.rackBack);
          else if (u >= 0.78) this.setL(u, F.rackBack, restL, 0.78, 0.92);
          const back = win(u, 0.66, 0.74) * (1 - win(u, 0.76, 0.785));
          lo.charge.position.z += 0.06 * back;
          o.pz += 0.008 * bump(u, 0.76, 0.84); o.rx += 0.04 * bump(u, 0.76, 0.86);
        } else if (u >= 0.56) this.setL(u, F.mag, restL, 0.56, 0.8);
      }
    } else if (kind === "pistol") {
      // the pistol comes in toward the centre and tips its butt toward the eye
      const tilt = win(u, 0, 0.14) * (1 - win(u, 0.86, 1));
      o.rz = -tilt * 0.36; o.rx = tilt * 0.4; o.ry = tilt * 0.16; o.px = -tilt * 0.04; o.py = tilt * 0.04; o.pz = tilt * 0.02;
      // the old mag slides out of the grip and falls; the support hand fetches the fresh one
      if (lo.mag) {
        if (u >= 0.06 && u < 0.14) lo.mag.position.y -= 0.035 * win(u, 0.06, 0.14);
        else if (u >= 0.14 && u < 0.32) { lo.mag.position.y -= 0.035; this.startDrop(lo); lo.mag.visible = false; }
      }
      if (u < 0.3) this.setL(u, restL, F.pouch, 0.0, 0.26);
      else if (u < 0.5) this.setL(u, F.pouch, F.below, 0.3, 0.5);
      else if (u < 0.6) this.setL(u, F.below, F.mag, 0.5, 0.6);
      else if (u < 0.64) this.fL.copy(F.mag);
      if (lo.mag && u >= 0.3 && u < 0.6) this.magToHand(lo, this.fL);
      o.py += 0.012 * bump(u, 0.58, 0.66); o.rx += 0.06 * bump(u, 0.58, 0.66);
      if (empty && lo.slide) {
        // overhand rack: grab the rear serrations, pull, let the slide fly home
        const sr = lo.gun.anchors.slideRear ?? new THREE.Vector3(0, 0.03, 0.02);
        F.rack.copy(restL);
        F.rack.p.copy(sr).add(_d.set(0, 0.012, 0));
        frameLook(_d.set(0, 0, 1), _p2.set(-0.8, 0.2, 0.3), F.rack.q);
        F.rack.a = 0.012; F.rack.b = 0.016; F.rack.curl = 0.95; F.rack.thumb = 0.9;
        F.rackBack.copy(F.rack); F.rackBack.p.z += 0.03;
        if (u >= 0.64 && u < 0.74) this.setL(u, F.mag, F.rack, 0.64, 0.74);
        else if (u >= 0.74 && u < 0.8) this.setL(u, F.rack, F.rackBack, 0.74, 0.8);
        else if (u >= 0.8) this.setL(u, F.rackBack, restL, 0.8, 0.94);
        o.pz += 0.006 * bump(u, 0.8, 0.88); o.rx -= 0.05 * bump(u, 0.8, 0.9);
        // the slide: held at lock until the rack, pulled the last few mm, then home
        const pull = win(u, 0.74, 0.8) * (1 - win(u, 0.8, 0.815));
        const hold = 1 - win(u, 0.8, 0.815);
        lo.slide.position.z += H.cycle * (0.92 * hold + 0.08 * pull);
      } else if (u >= 0.64) this.setL(u, F.mag, restL, 0.64, 0.84);
    } else {
      this.evalBoltReload(lo, u);
    }
  }

  /** the sniper's reload: bolt up and back, two rounds pressed into the open action, bolt home */
  private evalBoltReload(lo: Loadout, u: number): void {
    const F = this.F, o = this.off;
    const restL = lo.restL ?? lo.restR;
    const tilt = win(u, 0, 0.12) * (1 - win(u, 0.88, 1));
    // the action's right side (bolt, port) rolls up toward the eye
    // ...and the rifle goes out to arm's length so the bolt hand is not in your face
    o.rz = tilt * 0.55; o.rx = tilt * 0.12; o.ry = tilt * 0.12; o.px = -tilt * 0.02; o.py = -tilt * 0.01; o.pz = -tilt * 0.12;
    const up = win(u, 0.08, 0.13) * (1 - win(u, 0.8, 0.84));
    const back = win(u, 0.13, 0.21) * (1 - win(u, 0.72, 0.8));
    this.boltPose(lo, up, back);
    if (back > 0.9 && !this.boltEjected && u < 0.3) { this.boltEjected = true; this.emitEject(lo); }
    if (u < 0.05) this.boltEjected = false;
    this.boltHand(lo, win(u, 0.03, 0.08) * (1 - win(u, 0.84, 0.92)));
    // left hand: two rounds from the pouch into the port
    const port = lo.gun.anchors.port ?? new THREE.Vector3(0.0, 0.03, 0.0);
    F.port.copy(restL);
    F.port.p.copy(port).add(_d.set(-0.01, 0.045, 0.0));
    frameLook(_d.set(0.15, -1, 0.3), _p2.set(-0.7, -0.3, 0.5), F.port.q);
    F.port.a = 0.005; F.port.b = 0.005; F.port.curl = 0.85; F.port.thumb = 0.85;
    F.portIn.copy(F.port); F.portIn.p.y -= 0.025;
    const pouch = F.pouch;
    pouch.q.copy(F.port.q); pouch.a = pouch.b = 0.005;
    if (u < 0.2) this.fL.copy(restL);
    else if (u < 0.3) this.setL(u, restL, pouch, 0.2, 0.3);
    else if (u < 0.4) this.setL(u, pouch, F.port, 0.3, 0.4);
    else if (u < 0.45) this.setL(u, F.port, F.portIn, 0.4, 0.45);
    else if (u < 0.52) this.setL(u, F.portIn, pouch, 0.45, 0.52);
    else if (u < 0.6) this.setL(u, pouch, F.port, 0.52, 0.6);
    else if (u < 0.65) this.setL(u, F.port, F.portIn, 0.6, 0.65);
    else this.setL(u, F.portIn, restL, 0.68, 0.84);
    this.roundInHand(lo, (u > 0.28 && u < 0.45) || (u > 0.5 && u < 0.65));
  }

  /** the sniper's bolt cycle after a shot (seconds since the shot) */
  private evalBoltCycle(lo: Loadout, t: number): void {
    const o = this.off;
    const k = win(t, 0.2, 0.3) * (1 - win(t, 0.84, 0.98));
    o.rz = k * 0.24; o.ry = k * 0.05; o.py = -k * 0.02; o.px = k * 0.005; o.pz = -k * 0.11;
    const up = win(t, 0.3, 0.38) * (1 - win(t, 0.66, 0.72));
    const back = win(t, 0.38, 0.5) * (1 - win(t, 0.54, 0.66));
    this.boltPose(lo, up, back);
    if (back > 0.85 && !this.boltEjected) { this.boltEjected = true; this.emitEject(lo); }
    this.boltHand(lo, win(t, 0.2, 0.3) * (1 - win(t, 0.72, 0.86)));
    o.pz += 0.006 * bump(t, 0.5, 0.58);
  }

  private boltPose(lo: Loadout, up: number, back: number): void {
    if (!lo.bolt) return;
    lo.bolt.rotateZ(1.05 * up);
    lo.bolt.position.z += 0.085 * back;
  }

  /** the trigger hand on the bolt knob (weight w), following the knob */
  private boltHand(lo: Loadout, w: number): void {
    if (w <= 0.001 || !lo.bolt) return;
    const F = this.F;
    const knob = lo.gun.anchors.boltKnob;
    if (!knob) return;
    const home = lo.bolt.userData.home as { p: THREE.Vector3 } | undefined;
    // knob: gun space -> bolt-parent space -> offset from the pivot -> through the animated bolt -> gun space
    _p.copy(knob).applyMatrix4(lo.boltParentInv).sub(home?.p ?? lo.bolt.position);
    _p.applyQuaternion(lo.bolt.quaternion).add(lo.bolt.position).applyMatrix4(lo.boltParent);
    gripFrame(BOLT_GRIP, "R", F.bolt);
    F.bolt.p.copy(_p);
    this.fR.lerp(lo.restR, F.bolt, smooth01(w));
  }

  private roundObj: THREE.Object3D | null = null;
  private roundInHand(lo: Loadout, on: boolean): void {
    if (!this.roundObj) {
      const g = new THREE.Group();
      const brass = new THREE.MeshStandardMaterial({ color: 0xc9a050, metalness: 1, roughness: 0.3 });
      const tip = new THREE.MeshStandardMaterial({ color: 0xb8743e, metalness: 1, roughness: 0.35 });
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.05, 14), brass);
      c.position.y = 0.025;
      const t = new THREE.Mesh(new THREE.ConeGeometry(0.0042, 0.026, 14), tip);
      t.position.y = 0.063;
      g.add(c, t);
      g.name = "vm-round";
      this.roundObj = g;
      this.pose.add(g);
    }
    this.roundObj.visible = on;
    if (!on) return;
    // held between thumb and fingers, along the hand's grip axis, nose forward
    this.roundObj.position.copy(this.fL.p);
    this.roundObj.quaternion.copy(this.fL.q);
    this.roundObj.rotateX(-Math.PI / 2);
    this.roundObj.translateY(-0.03);
    void lo;
  }

  // ------------------------------------------------------------------ the frag arm
  nadeArm = new THREE.Group();
  /** the frag in the throwing hand (its centre = this object's origin) */
  nadeHold = new THREE.Group();
  private throwHand!: Hand;
  private pinHand!: Hand;
  private frag!: FragParts;
  nadePhase: NadePhase = 0;
  nadeT = 0;
  private nadeWorld = new THREE.Vector3();
  private cookT = 0;

  private buildNadeArm(): void {
    this.throwHand = createHand("R");
    this.pinHand = createHand("L");
    this.nadeArm.name = "vm-nade-arm";
    this.nadeArm.add(this.throwHand.mesh);
    this.frag = buildFragParts();
    // the spoon turned toward the thumb side so it reads along the body in the hand
    this.frag.root.rotation.y = -1.15;
    this.frag.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
    this.nadeHold.add(this.frag.root);
    this.nadeArm.add(this.nadeHold);
    this.nadeArm.visible = false;
    this.pinHand.mesh.visible = false;
    this.throwHand.setGrip(FRAG_R, FRAG_R, 1, 0.9);
  }

  /** Kept for the boot sequence (the frag is procedural now: nothing to load). */
  async initNade(): Promise<void> {}

  /** Drive the throw from game.ts (which owns the input timing). */
  setNade(phase: NadePhase, t: number): void {
    if (phase === 1 && this.nadePhase !== 1) this.resetFrag();
    this.nadePhase = phase;
    this.nadeT = t;
    const held = phase === 1 || (phase === 2 && t < NADE_RELEASE_AT);
    this.nadeArm.visible = phase !== 0;
    this.nadeHold.visible = held;
  }

  private resetFrag(): void {
    for (const m of [this.frag.spoon, this.frag.pin]) { m.position.set(0, 0, 0); m.quaternion.identity(); m.visible = true; }
    this.cookT = 0;
  }

  /** World position of the frag in the hand — the handoff anchor for fx.ts. */
  nadeHandWorld(): THREE.Vector3 {
    this.nadeHold.updateWorldMatrix(true, false);
    return this.nadeWorld.set(0, 0, 0).applyMatrix4(this.nadeHold.matrixWorld);
  }

  /** The hand frag's world scale relative to the true-size buildFragMesh() (the viewmodel's depth squeeze). */
  nadeApparentScale(): number {
    this.nadeHold.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixScale(this.nadeHold.matrixWorld).x || 1;
  }

  /** aim a root-space hand (its mesh transform = handM, already applied) and hang its upper arm */
  private placeHandIn(hand: Hand, handM: THREE.Matrix4, elbowCam: THREE.Vector3, upper: THREE.Mesh, shoulder: THREE.Vector3): void {
    _M2.copy(handM).invert();
    this._hp.copy(elbowCam).applyMatrix4(_M2);
    hand.aimForearmLocal(this._hp);
    hand.elbowLocal(this._he).applyMatrix4(handM);
    upper.position.copy(this._he);
    _d.copy(shoulder).sub(this._he).normalize();
    upper.quaternion.setFromUnitVectors(Y_UP, _d);
  }

  private nA = new THREE.Vector3();
  private nB = new THREE.Vector3();
  private nUp = new THREE.Vector3();
  private nHeel = new THREE.Vector3();
  private nF = new Frame();
  private elT = new THREE.Vector3(0.3, -0.55, 0.05);
  private ppA = new THREE.Vector3();
  private ppB = new THREE.Vector3();
  private ppC = new THREE.Vector3();
  private ppD = new THREE.Vector3();
  private ppE = new THREE.Vector3();
  private ppF = new THREE.Vector3();
  private ppG = new THREE.Vector3();
  private ppQ = new THREE.Quaternion();
  private ppQ2 = new THREE.Quaternion();

  /** camera-space keyframes of the cook and the throw (frag centre + hand orientation) */
  private poseNade(dt: number): void {
    const p = this.nadePhase, t = this.nadeT;
    this.pinHand.mesh.visible = false;
    this.upP.visible = false;
    if (p === 0) { this.upT.visible = false; return; }
    const pos = this.nA, up = this.nUp, heel = this.nHeel;
    const READY = _p2.set(0.125, -0.1, -0.35);
    if (p === 1) {
      this.cookT += dt;
      const e = easeOut(t / NADE_READY_T);
      pos.set(0.24, -0.42, -0.36).lerp(READY, e);
      up.set(-0.25, 0.92, -0.2);
      heel.set(0.45, -0.55, 0.7);
      // the hold breathes; a fine tremble creeps in the longer it cooks
      const hold = Math.max(0, t - NADE_READY_T);
      const tr = 0.0004 + 0.0011 * clamp01(hold / 3.2);
      pos.x += Math.sin(this.idle * 1.7) * 0.004 + Math.sin(this.idle * 23) * tr;
      pos.y += Math.sin(this.idle * 2.3) * 0.005 + Math.sin(this.idle * 29 + 1) * tr;
      pos.z += Math.sin(this.idle * 1.1) * 0.003;
      up.x += Math.sin(this.idle * 1.3) * 0.04;
      // cocked back a touch as the hold settles
      pos.z += 0.02 * win(hold, 0, 0.6);
      pos.y += 0.01 * win(hold, 0, 0.6);
    } else if (p === 2) {
      const k = clamp01(t / NADE_THROW_T), r = NADE_RELEASE_AT / NADE_THROW_T;
      if (k <= r) {
        const e = easeOut(k / r);
        pos.copy(READY).add(this.nB.set(0, 0.03, 0.03)).lerp(this.nB.set(0.05, 0.05, -0.56), e);
        up.set(-0.25, 0.92, -0.2).lerp(this.nB.set(-0.05, 0.4, -0.9), e);
        heel.set(0.45, -0.55, 0.7).lerp(this.nB.set(0.3, -0.25, 0.9), e);
      } else {
        const e = easeOut((k - r) / (1 - r));
        pos.set(0.05, 0.05, -0.56).lerp(this.nB.set(-0.2, -0.5, -0.42), e);
        up.set(-0.05, 0.4, -0.9).lerp(this.nB.set(0.2, -0.3, -0.9), e);
        heel.set(0.3, -0.25, 0.9).lerp(this.nB.set(0.4, 0.2, 0.9), e);
      }
    } else {
      const k = clamp01(t / (NADE_RECOVER_T * 0.5));
      pos.set(-0.2, -0.5, -0.42).lerp(this.nB.set(-0.3, -0.9, -0.4), k);
      up.set(0.2, -0.3, -0.9);
      heel.set(0.4, 0.2, 0.9);
      this.nadeArm.visible = k < 1;
    }
    if (p === 1) this.pinPull(t, pos);
    // the hand frame IS the frag centre; the arm group carries both
    const f = this.nF;
    f.p.copy(pos);
    frameLook(up, heel, f.q);
    this.nadeArm.position.copy(f.p);
    this.nadeArm.quaternion.copy(f.q);
    this.throwHand.mesh.position.set(0, 0, 0);
    this.throwHand.mesh.quaternion.identity();
    const curl = p === 2 && t >= NADE_RELEASE_AT ? 0.25 : 1;
    this.throwHand.setGrip(FRAG_R * 0.86, FRAG_R * 0.8, curl, curl * 0.9);
    // the forearm toward an elbow below-right-behind, the upper arm to the shoulder
    this.nadeArm.updateMatrix();
    this.upT.visible = this.nadeArm.visible;
    this.placeHandIn(this.throwHand, this.nadeArm.matrix, this.elT, this.upT, SHOULDER_R);
  }

  /** the support hand pulls the pin (ring on its index finger) */
  private pinPull(t: number, fragPos: THREE.Vector3): void {
    const frag = this.frag;
    // the spoon stays clamped under the fingers through the cook (it is what reads as a frag); it flies with the throw
    if (t > 0.32) { frag.pin.visible = false; return; }
    // the left hand comes up, hooks the ring at 0.14, pulls it off by 0.3
    const hand = this.pinHand;
    hand.mesh.visible = true;
    // the arm's orientation for this frame (poseNade writes it after this call: use the target)
    const armQ = frameLook(this.nUp, this.nHeel, this.ppQ);
    const ringCam = this.ppA.set(-0.0265, 0.034, 0).applyQuaternion(armQ).add(fragPos);
    const from = this.ppB.set(-0.15, -0.42, -0.3);
    const at = this.ppC.copy(ringCam).add(_d.set(-0.022, -0.01, 0.01));
    const away = this.ppD.copy(ringCam).add(_d.set(-0.16, -0.2, 0.05));
    const hp = this.ppE;
    if (t < 0.14) hp.lerpVectors(from, at, easeOut(t / 0.14));
    else hp.lerpVectors(at, away, smooth01((t - 0.14) / 0.18));
    const q = frameLook(this.ppF.set(0.3, 0.9, -0.3), this.ppG.set(-0.5, -0.6, 0.6), this.ppQ2);
    hand.mesh.position.copy(hp);
    hand.mesh.quaternion.copy(q);
    hand.setGrip(0.004, 0.004, t < 0.12 ? 0.4 : 0.95, 0.9);
    _M.compose(hp, q, ONE);
    this.upP.visible = true;
    this.placeHandIn(hand, _M, this.ppF.set(-0.3, -0.6, -0.1), this.upP, SHOULDER_L);
    // the pin rides the hand once hooked
    if (t >= 0.14) {
      _M.compose(hp, q, ONE);
      _M2.compose(fragPos, armQ, ONE).invert();
      _M3.multiplyMatrices(_M2, _M); // hand frame in frag space
      const hk = this.ppA.set(0.022, 0.01, -0.01).applyMatrix4(_M3);
      frag.pin.position.copy(hk).sub(_d.set(-0.0265, 0.034, 0));
    }
  }
}

/** A third-person gun for legacy callers (+Z forward, the old W1 convention). */
export function makeWorldGun(id: string): THREE.Group {
  const g = new THREE.Group();
  const gun = buildGun(id, "tp");
  gun.root.rotation.y = Math.PI;
  g.add(gun.root);
  g.userData.muzzle = gun.muzzle.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  return g;
}

void IDQ;
