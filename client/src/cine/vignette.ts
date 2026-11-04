/**
 * client/src/cine/vignette.ts — THE HERO CARD (Overwatch's POTG / MVP card), a studio set.
 * ===========================================================================
 *
 * The player's monkey in the authored HERO POSE (cine/pose.ts), rendered in an ISOLATED scene with its
 * own renderer (no world geometry: nothing can clip it, no wall, no lift), on a small SET in the map's
 * palette:
 *
 *   FLOOR   wet slate: a planar mirror under a semi-opaque slate skin whose puddles thin out, so the
 *           reflection reads as water on stone; a soft contact shadow (shadow map + a blob at the feet)
 *   SET     Katana: charred-cedar (yakisugi) slats behind, ONE red neon diamond (the brand mark) that
 *           bleeds red into the wall, the floor and a rim on the monkey, rain falling through the light.
 *           Every other map: a neutral graphite set — concrete panels, one cool white strip light, haze.
 *   LIGHT   cool moon key from the front-left, red (or white) rim from the neon, cool back rim, a face fill
 *   CAMERA  a real move: an 18° arc round the front three-quarter, pushing in and craning up, eased out
 *   POST    bloom on the neon, ACES, a film vignette
 *
 * QA (qa): the subject's height in frame, facing the lens, the face clear of the gun, the gun on screen.
 * Only alive while a card is up (built on show(), torn down on dispose()).
 */
import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { PlayerSnap } from "@shared/protocol";
import { BruiserActor, type BruiserTemplate } from "../bruiser";
import { heroPose } from "./pose";

/** Far above every map: the actor's wall-lift probe finds no solids up here. */
const STAGE_Y = 400;
/** Subject height for the frame measure (m, feet to crown). */
const BODY_M = 1.85;
/** The camera's arc (rad round the subject, 0 = straight on) and the body's turn into the pose. */
const CAM_A0 = 0.62;
const CAM_A1 = 0.3;
const HERO_YAW0 = -0.95;
const HERO_YAW1 = -0.7;
const HERO_LOOK = 0.7;

export type SetStyle = {
  /** CSS behind the canvas while it spins up */
  bg: string;
  fog: number;
  wall: "cedar" | "graphite";
  /** the one accent light: colour and HDR strength */
  neon: number;
  neonHdr: number;
  rain: boolean;
  key: number;
  rimBack: number;
};
export const SETS: Record<string, SetStyle> = {
  katana: { bg: "#05070c", fog: 0x070b13, wall: "cedar", neon: 0xe8141f, neonHdr: 9, rain: true, key: 0xcdd8ff, rimBack: 0x9fc0ff },
  default: { bg: "#0b0c0e", fog: 0x0c0d10, wall: "graphite", neon: 0xe9f1ff, neonHdr: 5, rain: false, key: 0xfff1e2, rimBack: 0xbcd2ff },
};

/** A canvas texture painted once. */
function paint(w: number, h: number, fn: (c: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  fn(cv.getContext("2d")!);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Deterministic noise for the painted textures (a set must look the same every match). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class HeroVignette {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 60);
  private actor: BruiserActor | null = null;
  private snap: PlayerSnap | null = null;
  private set: SetStyle;
  private rain: THREE.LineSegments | null = null;
  private rainV: Float32Array | null = null;
  private neonLight: THREE.PointLight | null = null;
  private built = false;
  private t = 0;
  private w = 0;
  private h = 0;
  /** QA: the subject on screen (fraction of the frame tall), facing the lens, the face clear of the gun. */
  qa = { on: false, frac: 0, facing: false, faceClear: true, gunOn: false, subjectX: 0 };

  constructor(parent: HTMLElement, private tpl: () => BruiserTemplate | null, mapId: string) {
    this.set = SETS[mapId] ?? SETS.default!;
    this.el = document.createElement("div");
    this.el.className = "cine-vig";
    this.el.style.background = this.set.bg;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cine-vig-canvas";
    this.el.append(this.canvas);
    parent.prepend(this.el);
    this.el.style.display = "none";
  }

  get on(): boolean {
    return !!this.actor;
  }

  // ------------------------------------------------------------------ the set

  private build(): void {
    if (this.built) return;
    this.built = true;
    const S = this.set;
    const sc = this.scene;
    sc.background = new THREE.Color(S.fog);
    sc.fog = new THREE.Fog(S.fog, 7, 17);
    const Y = STAGE_Y;
    // ---- FLOOR: mirror + wet slate skin with puddles
    const mirror = new Reflector(new THREE.PlaneGeometry(40, 40), { textureWidth: 1024, textureHeight: 1024, color: new THREE.Color(0xa4adbd), clipBias: 0.003 });
    mirror.rotation.x = -Math.PI / 2;
    mirror.position.y = Y;
    sc.add(mirror);
    const slate = paint(512, 512, (c) => {
      const r = rng(7);
      c.fillStyle = S.wall === "cedar" ? "#1b1f26" : "#222428";
      c.fillRect(0, 0, 512, 512);
      // stone tiles (staggered), each its own tone, a dark joint between
      const tw = 128;
      const th = 96;
      for (let y = 0; y < 512 + th; y += th)
        for (let x = -tw; x < 512 + tw; x += tw) {
          const ox = (y / th) % 2 ? tw / 2 : 0;
          const v = 22 + Math.floor(r() * 16);
          c.fillStyle = S.wall === "cedar" ? `rgb(${v},${v + 3},${v + 9})` : `rgb(${v + 4},${v + 5},${v + 7})`;
          c.fillRect(x + ox + 2, y + 2, tw - 4, th - 4);
        }
      // grain
      for (let i = 0; i < 2500; i++) {
        c.fillStyle = `rgba(255,255,255,${(r() * 0.035).toFixed(3)})`;
        c.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1);
      }
    });
    slate.repeat.set(6, 6);
    // puddles: alpha low = the mirror shows through (standing water), high = dry-ish stone
    const puddle = paint(
      512,
      512,
      (c) => {
        const r = rng(19);
        c.fillStyle = "#bdbdbd";
        c.fillRect(0, 0, 512, 512);
        for (let i = 0; i < 26; i++) {
          const x = r() * 512;
          const y = r() * 512;
          const rad = 30 + r() * 90;
          const g = c.createRadialGradient(x, y, rad * 0.2, x, y, rad);
          g.addColorStop(0, "rgba(40,40,40,0.95)");
          g.addColorStop(1, "rgba(40,40,40,0)");
          c.fillStyle = g;
          c.beginPath();
          c.ellipse(x, y, rad * (1 + r()), rad, r() * 3, 0, Math.PI * 2);
          c.fill();
        }
      },
      false,
    );
    puddle.repeat.set(2, 2);
    const skin = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ map: slate, alphaMap: puddle, transparent: true, opacity: 0.6, roughness: 0.5, metalness: 0.0, depthWrite: false }),
    );
    skin.rotation.x = -Math.PI / 2;
    skin.position.y = Y + 0.002;
    skin.receiveShadow = true;
    skin.renderOrder = 1;
    sc.add(skin);
    // contact shadow blob under the feet (always, whatever the shadow map resolves)
    const blob = paint(256, 256, (c) => {
      const g = c.createRadialGradient(128, 128, 8, 128, 128, 126);
      g.addColorStop(0, "rgba(0,0,0,0.85)");
      g.addColorStop(0.45, "rgba(0,0,0,0.45)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 256, 256);
    });
    const shadowBlob = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2), new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false }));
    shadowBlob.rotation.x = -Math.PI / 2;
    shadowBlob.position.set(0.02, Y + 0.006, 0.02);
    shadowBlob.renderOrder = 2;
    sc.add(shadowBlob);
    // the mirror's own pass must not see the skin lying on it (it would cover the whole reflection)
    const mob = mirror.onBeforeRender.bind(mirror);
    mirror.onBeforeRender = (...args: Parameters<THREE.Object3D["onBeforeRender"]>) => {
      skin.visible = false;
      shadowBlob.visible = false;
      mob(...args);
      skin.visible = true;
      shadowBlob.visible = true;
    };
    // ---- THE WALL behind
    const wallTex =
      S.wall === "cedar"
        ? paint(1024, 512, (c) => {
            // yakisugi: vertical charred boards, alligatored char, a faint sheen
            const r = rng(3);
            c.fillStyle = "#0c0d10";
            c.fillRect(0, 0, 1024, 512);
            let x = 0;
            while (x < 1024) {
              const w = 46 + r() * 22;
              const v = 12 + Math.floor(r() * 10);
              c.fillStyle = `rgb(${v},${v},${v + 3})`;
              c.fillRect(x + 1, 0, w - 2, 512);
              for (let i = 0; i < 90; i++) {
                c.fillStyle = `rgba(${r() < 0.5 ? "0,0,0" : "60,64,72"},${(r() * 0.35).toFixed(2)})`;
                c.fillRect(x + r() * w, r() * 512, 2 + r() * (w * 0.6), 1 + r() * 2);
              }
              x += w;
            }
          })
        : paint(1024, 512, (c) => {
            // graphite concrete panels with seams and form-tie holes
            const r = rng(5);
            c.fillStyle = "#24262a";
            c.fillRect(0, 0, 1024, 512);
            for (let px = 0; px < 1024; px += 256)
              for (let py = 0; py < 512; py += 256) {
                const v = 32 + Math.floor(r() * 8);
                c.fillStyle = `rgb(${v},${v + 1},${v + 4})`;
                c.fillRect(px + 2, py + 2, 252, 252);
                c.fillStyle = "rgba(0,0,0,0.5)";
                for (const [hx, hy] of [[60, 60], [196, 60], [60, 196], [196, 196]] as const) c.fillRect(px + hx, py + hy, 5, 5);
              }
            for (let i = 0; i < 4000; i++) {
              c.fillStyle = `rgba(255,255,255,${(r() * 0.03).toFixed(3)})`;
              c.fillRect(r() * 1024, r() * 512, 1 + r() * 3, 1 + r() * 3);
            }
          });
    wallTex.repeat.set(2, 1);
    wallTex.repeat.set(4, 1);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(34, 8), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.82, metalness: 0 }));
    wall.position.set(0, Y + 4, -3.6);
    wall.receiveShadow = true;
    sc.add(wall);
    // ---- THE ONE ACCENT: Katana's red neon diamond (the brand mark), elsewhere a cool white strip
    const neonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(S.neon).multiplyScalar(S.neonHdr), toneMapped: false, fog: false });
    const neon = new THREE.Group();
    if (S.wall === "cedar") {
      // the diamond: four tubes corner to corner (top, right, bottom, left), with a small gap at each
      // corner like real bent-glass neon
      const hR = 0.62;
      const V = [new THREE.Vector2(0, hR), new THREE.Vector2(hR, 0), new THREE.Vector2(0, -hR), new THREE.Vector2(-hR, 0)];
      for (let i = 0; i < 4; i++) {
        const a = V[i]!;
        const b = V[(i + 1) % 4]!;
        const len = a.distanceTo(b) - 0.07;
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, len, 10), neonMat);
        m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
        m.rotation.z = Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2;
        neon.add(m);
      }
      neon.position.set(-1.95, Y + 2.0, -3.5);
    } else {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.6, 0.05), neonMat);
      neon.add(bar);
      neon.position.set(-3.1, Y + 1.9, -3.5);
    }
    sc.add(neon);
    // the neon's spill: up close on the wall (a halo round the mark), only a breath of it on the floor
    const glow = new THREE.PointLight(S.neon, S.wall === "cedar" ? 6 : 4, 3.6, 2);
    glow.position.copy(neon.position).add(new THREE.Vector3(0, 0.1, 0.22));
    sc.add(glow);
    this.neonLight = glow;
    // ---- LIGHT
    const key = new THREE.DirectionalLight(S.key, 2.4);
    key.position.set(-2.6, Y + 3.6, 3.4);
    key.target.position.set(0, Y + 0.9, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc2 = key.shadow.camera as THREE.OrthographicCamera;
    sc2.left = -1.6;
    sc2.right = 1.6;
    sc2.top = 2.4;
    sc2.bottom = -0.6;
    sc2.near = 0.5;
    sc2.far = 12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    sc.add(key, key.target);
    const back = new THREE.DirectionalLight(S.rimBack, 3.6);
    back.position.set(2.2, Y + 2.6, -2.8);
    back.target.position.set(0, Y + 1.0, 0);
    sc.add(back, back.target);
    // the accent's rim on the monkey: a narrow spot from the neon's side (never a wash over the floor)
    const accentRim = new THREE.SpotLight(S.neon, S.wall === "cedar" ? 26 : 12, 7, 0.32, 0.7, 2);
    accentRim.position.set(-1.9, Y + 2.0, -2.6);
    accentRim.target.position.set(0, Y + 1.15, 0);
    sc.add(accentRim, accentRim.target);
    const face = new THREE.PointLight(0xffe9d6, 1.4, 6, 2);
    face.position.set(-0.6, Y + 1.9, 2.4);
    sc.add(face);
    sc.add(new THREE.HemisphereLight(0x6b7a92, 0x0d0f14, 0.55));
    // ---- RAIN (Katana): streaks falling through the light, slanted, never between the lens and the face
    if (S.rain) {
      const N = 1400;
      const pos = new Float32Array(N * 6);
      const v = new Float32Array(N * 3);
      const r = rng(11);
      for (let i = 0; i < N; i++) {
        const x = (r() - 0.5) * 12;
        const z = -3.4 + r() * 6.5;
        const y = r() * 6;
        v[i * 3] = x;
        v[i * 3 + 1] = y;
        v[i * 3 + 2] = z;
      }
      this.rainV = v;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xaec4e6, transparent: true, opacity: 0.32, depthWrite: false, fog: true });
      this.rain = new THREE.LineSegments(geo, mat);
      this.rain.frustumCulled = false;
      this.rain.position.y = Y;
      sc.add(this.rain);
      this.tickRain(0);
    }
  }

  private tickRain(dt: number, camX = 0, camZ = 6): void {
    const v = this.rainV;
    const L = this.rain;
    if (!v || !L) return;
    const a = L.geometry.getAttribute("position") as THREE.BufferAttribute;
    const p = a.array as Float32Array;
    const fall = 8.5;
    const drift = 1.2;
    for (let i = 0; i < v.length / 3; i++) {
      let y = v[i * 3 + 1]! - fall * dt;
      let x = v[i * 3]! + drift * dt;
      if (y < 0) {
        y += 6;
        x -= drift * (6 / fall);
      }
      v[i * 3] = x;
      v[i * 3 + 1] = y;
      const z = v[i * 3 + 2]!;
      // keep a clear column between the subject and the lens (rain never veils the face)
      const L2 = camX * camX + camZ * camZ;
      const k = (x * camX + z * camZ) / L2;
      const hide = k > 0.04 && k < 1 && Math.abs(x * camZ - z * camX) / Math.sqrt(L2) < 0.6;
      p[i * 6] = x;
      p[i * 6 + 1] = hide ? -50 : y;
      p[i * 6 + 2] = z;
      p[i * 6 + 3] = x - drift * 0.03;
      p[i * 6 + 4] = hide ? -50 : y + fall * 0.03;
      p[i * 6 + 5] = z;
    }
    a.needsUpdate = true;
  }

  // ------------------------------------------------------------------ lifecycle

  show(p: PlayerSnap): boolean {
    const tpl = this.tpl();
    if (!tpl) return false;
    this.hideActor();
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
      } catch {
        return false;
      }
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.build();
    this.snap = { ...p, x: 0, y: STAGE_Y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0.9, pitch: 0, ads: 0, sprint: false, crouch: false, slide: 0, reload: 0, firing: false, alive: true, protect: 0, swap: 0, cook: 0, nadeUp: false };
    this.actor = new BruiserActor(this.snap, tpl);
    this.actor.setRelation(true);
    this.actor.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    this.scene.add(this.actor.root);
    this.t = 0;
    this.el.style.display = "";
    return true;
  }

  private hideActor(): void {
    if (this.actor) {
      this.scene.remove(this.actor.root);
      this.actor.dispose();
      this.actor = null;
    }
  }

  hide(): void {
    this.hideActor();
    this.el.style.display = "none";
    this.el.style.opacity = "0";
    this.qa.on = false;
  }

  /** a: card opacity (0..1). */
  frame(dt: number, a: number): void {
    const act = this.actor;
    const r = this.renderer;
    if (!act || !r || !this.snap) return;
    this.t += dt;
    const t = this.t;
    this.el.style.opacity = a.toFixed(3);
    // ---- THE POSE: a step into the hero pose (the body squares a little toward the lens and settles)
    // (yaw: the body three-quarter to the lens, facing frame-left into the card's lead room; the head turns to the lens)
    const settle = 1 - Math.pow(1 - Math.min(1, t / 0.55), 3);
    const s = this.snap;
    const dev = (globalThis as unknown as { __heroPose?: { bodyYaw?: number; camA?: number } }).__heroPose;
    const yaw1 = dev?.bodyYaw ?? HERO_YAW1;
    s.yaw = yaw1 + (HERO_YAW0 - HERO_YAW1) * (1 - settle) + 0.015 * Math.sin(t * 1.1);
    s.ads = 0;
    s.pitch = 0.05;
    heroPose(act, 0.85 + 0.15 * settle, HERO_LOOK * (0.6 + 0.4 * settle), t);
    BruiserActor.overlays = false;
    act.apply(s, dt);
    // ---- size
    const W = Math.max(1, innerWidth);
    const H = Math.max(1, innerHeight);
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    if (W !== this.w || H !== this.h) {
      this.w = W;
      this.h = H;
      r.setPixelRatio(dpr);
      r.setSize(W, H, false);
      if (!this.composer) {
        this.composer = new EffectComposer(r);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.42, 0.32, 0.95);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
      }
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(W, H);
    }
    this.camera.aspect = W / H;
    // ---- THE CAMERA: an 18° arc round the front three-quarter, pushing in, craning up; eased out (fast, settles)
    const u = Math.min(1, t / 2.7);
    const e = 1 - Math.pow(1 - u, 2.2);
    const camA1 = (globalThis as unknown as { __heroPose?: { camA?: number } }).__heroPose?.camA ?? CAM_A1;
    const ang = CAM_A0 + (camA1 - CAM_A0) * e; // around the subject (rad, 0 = straight on along +z)
    const dist = 6.6 - 1.1 * e;
    const camY = STAGE_Y + 0.7 + 0.3 * e;
    this.camera.position.set(Math.sin(ang) * dist, camY, Math.cos(ang) * dist);
    // the subject on the RIGHT third of the frame (the card's words own the left): aim left of them
    const toSub = new THREE.Vector3(-this.camera.position.x, 0, -this.camera.position.z).normalize();
    const right = new THREE.Vector3(-toSub.z, 0, toSub.x);
    const hfov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    const lateral = Math.tan(hfov / 2) * dist * 0.36;
    const look = new THREE.Vector3(0, STAGE_Y + 0.9, 0).addScaledVector(right, -lateral);
    this.camera.lookAt(look);
    this.camera.updateProjectionMatrix();
    // the set breathes: rain, a neon flicker on a slow cycle (never a strobe)
    this.tickRain(dt, this.camera.position.x, this.camera.position.z);
    if (this.neonLight) this.neonLight.intensity = (this.set.wall === "cedar" ? 6 : 4) * (0.94 + 0.06 * Math.sin(t * 7.3) * Math.sin(t * 2.1));
    if (this.composer) this.composer.render(dt);
    else r.render(this.scene, this.camera);
    this.measure();
  }

  /** QA: the subject's size, facing, the face clear of the gun, the gun on screen. */
  private measure(): void {
    const act = this.actor!;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const top = new THREE.Vector3(0, STAGE_Y + BODY_M, 0).project(cam);
    const bot = new THREE.Vector3(0, STAGE_Y, 0).project(cam);
    this.qa.on = true;
    this.qa.frac = Math.abs(top.y - bot.y) / 2;
    this.qa.subjectX = (top.x + bot.x) / 2;
    // facing: the head's forward against the direction to the lens
    const head = act.bones.Head;
    const hp = new THREE.Vector3();
    if (head) {
      head.updateWorldMatrix(true, false);
      hp.setFromMatrixPosition(head.matrixWorld);
    } else hp.set(0, STAGE_Y + 1.6, 0);
    // the FACE's facing: the body's yaw turned by the head (pose.ts look, ~85% of it reaches the face)
    const fy = this.snap!.yaw + 0.85 * (this.actor?.hero?.look ?? 0) * (this.actor?.hero?.w ?? 0);
    const faceFwd = new THREE.Vector3(Math.sin(fy), 0, Math.cos(fy));
    const toCam = new THREE.Vector3().subVectors(cam.position, hp).setY(0).normalize();
    this.qa.facing = faceFwd.dot(toCam) > Math.cos((60 * Math.PI) / 180);
    // the face clear of the gun: the gun spans the hands, so the hand-to-hand
    // line (as drawn) must not cross the face on screen while nearer the lens
    // than the face (local actor: no gunMount Object3D to measure off)
    const rh = act.bones.R_Hand;
    const lh = act.bones.L_Hand;
    if (rh && lh) {
      const w0 = rh.getWorldPosition(new THREE.Vector3());
      const w1 = lh.getWorldPosition(new THREE.Vector3());
      const p0 = w0.clone().project(cam);
      const p1 = w1.clone().project(cam);
      const ph = hp.clone().setY(hp.y + 0.12).project(cam);
      const rad = Math.abs(hp.clone().setY(hp.y + 0.3).project(cam).y - hp.clone().setY(hp.y - 0.06).project(cam).y) / 2;
      // screen distance from the face centre to the gun's line (aspect-corrected)
      const asp = cam.aspect;
      const ax2 = (p1.x - p0.x) * asp;
      const ay2 = p1.y - p0.y;
      const L2 = ax2 * ax2 + ay2 * ay2;
      const tt = L2 > 1e-9 ? Math.max(0, Math.min(1, ((ph.x - p0.x) * asp * ax2 + (ph.y - p0.y) * ay2) / L2)) : 0;
      const dx = (p0.x + (p1.x - p0.x) * tt - ph.x) * asp;
      const dy = p0.y + (p1.y - p0.y) * tt - ph.y;
      const near = Math.min(w0.distanceTo(cam.position), w1.distanceTo(cam.position)) < hp.distanceTo(cam.position);
      let clear = !(Math.hypot(dx, dy) < rad * 0.8 && near);
      // the paws and forearms too (a fist across the face is as bad as a gun): forearm -> hand, fist radius 0.13 m
      const fd = hp.distanceTo(cam.position);
      for (const [fa, ha] of [["L_Forearm", "L_Hand"], ["R_Forearm", "R_Hand"]] as const) {
        const A = act.bones[fa];
        const B = act.bones[ha];
        if (!A || !B) continue;
        const wa = A.getWorldPosition(new THREE.Vector3());
        const wb = B.getWorldPosition(new THREE.Vector3());
        if (Math.min(wa.distanceTo(cam.position), wb.distanceTo(cam.position)) > fd - 0.05) continue;
        for (let k = 0; k <= 4; k++) {
          const q = wa.clone().lerp(wb, k / 4).project(cam);
          const fr = Math.abs(wb.clone().setY(wb.y + 0.13).project(cam).y - q.y);
          if (Math.hypot((q.x - ph.x) * asp, q.y - ph.y) < rad * 0.7 + fr) clear = false;
        }
      }
      this.qa.faceClear = clear;
      this.qa.gunOn = Math.max(p0.x, p1.x) > -1 && Math.min(p0.x, p1.x) < 1 && Math.max(p0.y, p1.y) > -1 && Math.min(p0.y, p1.y) < 1;
    }
  }

  dispose(): void {
    this.hide();
    this.composer?.dispose();
    this.composer = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
