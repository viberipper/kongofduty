/**
 * client/src/nuketown-live.ts — NUKETOWN, ALIVE (feel stream).
 * ===========================================================================
 *
 * Three things the town does on its own, for map id "nuketown" only. Hooked by
 * ONE line where game.ts builds the world (Game.init: attachNuketownLive), and
 * it wraps that world's update — so it runs every frame after the map's own
 * animation (nuketown-world.ts's swing seats / sweep hand) and before the
 * frame is rendered. It reads the game, it never writes the sim.
 *
 *  (a) THE CLOCK TOWER IS THE MATCH CLOCK. Its dial is a countdown (badges 0,
 *      1, 2, 3 running anticlockwise from the top): the long hand points at the
 *      minutes left and winds back to 0 as the clock runs out, the red sweep
 *      winds the seconds back — gliding until the final two minutes, then
 *      TICKING (a stepped second with a damped overshoot) — and the tower is
 *      heard ticking in the final minute. The short hand sits on 0: the target.
 *      Pivots: clock_hand_hour / _minute / _sweep (props-out PLACEMENT-NOTES
 *      "runtime hooks": rotate about local +Z, 0 = 12 o'clock, clockwise < 0).
 *  (b) THE WELCOME SIGN COUNTS THE LIVING. POPULATION shows how many players
 *      are alive right now (welcome_digit_tens / _ones: shift the 0-9 strip's
 *      u by 0.1 per digit; the tens digit goes dark under ten).
 *  (c) THE NUKE, AT MATCH END. Once the endcard is up (after the final
 *      killcam) the camera cuts to the cul-de-sac looking past the clock tower,
 *      the hands run to midnight, and a white flash lights the horizon behind
 *      the town; a mushroom cloud climbs out of the far desert (nuke-fx.ts);
 *      the shockwave arrives seconds later — the boom, a rumble, a camera shake
 *      and a whiteout — and the town is left in dusty light behind the endcard.
 *      Cosmetic only: it starts on Game.endcardUp (never in live play) and
 *      everything it touched (camera far plane, exposure, the canvas filter,
 *      the endcard class) is handed back on a rematch.
 *
 * Audio: Kong Royale's explosion bank (the weapon engine's exp/near + exp/far
 * takes, pitched down) under a synthesised sub thump, debris rush and rumble.
 */
import * as THREE from "three";
import type { Game } from "./game";
import { MATCH_TIME } from "@shared/protocol";
import { NukeFx } from "./nuke-fx";
import { reducedMotion, prefs } from "./ui/prefs";
import { isSoftwareGL } from "./textures";
import { MannequinEgg } from "./nuketown-egg";
import { BreakableGlass } from "./nuketown-glass";

/** The cinematic: from the yellow-house roofline, past the welcome sign and the clock tower, NW over the desert. */
const CAM_FROM = new THREE.Vector3(16, 7.5, 6);
const CAM_TO = new THREE.Vector3(15, 7.9, 4.4);
const LOOK = new THREE.Vector3(-20, 33, -30);
const GZ_DIST = 800;
/** Ground zero sits this far right of the look line (radians), so the tower frames it and the endcard does not hide it. */
const GZ_RIGHT = 0.3;
const CAM_FOV = 64;
const CAM_FAR = 2600;
/** Seconds after the endcard: hands to midnight, then the flash. */
const DETONATE_AT = 0.6;
/** Detonation → the shockwave reaching the town (s). */
const SHOCK_S = 4.4;
/** The endcard's content holds back until the whiteout peaks: the detonation plays full-screen, the scoreboard comes up out of the white. */
const INTRO_S = DETONATE_AT + SHOCK_S + 0.18;
/** Sun direction for the cloud's shading (nuketown-world.ts NUKETOWN_SUN_DIR). */
const SUN = new THREE.Vector3(-0.5, 0.56, 0.66).normalize();

type Hand = { o: THREE.Object3D; shown: number };

export class NuketownLive {
  private hour: Hand | null = null;
  private minute: Hand | null = null;
  private sweep: Hand | null = null;
  private clockAt = new THREE.Vector3();
  private lastSec = -1;
  private tickT = 1;
  private digits: { mesh: THREE.Mesh; base: Float32Array; d0: number }[] = [];
  private pop = -1;
  // ---- the nuke
  private t = -1;
  private fx: NukeFx | null = null;
  private overlay: HTMLElement | null = null;
  private saved: { far: number; exposure: number; slider: number; filter: string } | null = null;
  private boomed = false;
  private rumbled = false;
  private midnightFrom = { h: 0, m: 0, s: 0 };
  private shake = 0;

  constructor(private game: Game) {
    const scene = game.world!.scene;
    const hand = (n: string): Hand | null => {
      const o = scene.getObjectByName(n);
      return o ? { o, shown: 0 } : null;
    };
    this.hour = hand("clock_hand_hour");
    this.minute = hand("clock_hand_minute");
    this.sweep = hand("clock_hand_sweep");
    const center = scene.getObjectByName("socket_clock_center") ?? this.hour?.o ?? null;
    if (center) {
      center.updateWorldMatrix(true, false);
      center.getWorldPosition(this.clockAt);
    }
    for (const n of ["welcome_digit_tens", "welcome_digit_ones"]) {
      const m = scene.getObjectByName(n) as THREE.Mesh | undefined;
      const uv = m?.geometry?.getAttribute("uv") as THREE.BufferAttribute | undefined;
      if (!m || !uv) continue;
      // Own the geometry: the template's copy stays the shipped "14".
      m.geometry = m.geometry.clone();
      const a = m.geometry.getAttribute("uv") as THREE.BufferAttribute;
      const base = new Float32Array(a.count);
      let minU = Infinity;
      for (let i = 0; i < a.count; i++) {
        base[i] = a.getX(i);
        minU = Math.min(minU, base[i]!);
      }
      this.digits.push({ mesh: m, base, d0: Math.round(minU * 10) });
    }
  }

  /** Everything this module does, once per rendered frame (after the map's own update). */
  update(dt: number, cam: THREE.Camera): void {
    const g = this.game;
    this.updateSign();
    // Never in ?test: the harness poses exact frames and its endings are not a show.
    if (g.ended && g.endcardUp && !g.testMode) {
      if (this.t < 0) this.startNuke();
      this.t += dt;
      this.updateNuke(dt, cam as THREE.PerspectiveCamera);
    } else {
      if (this.t >= 0) this.stopNuke();
      this.updateClock(dt);
    }
  }

  // ---------------------------------------------------------------- (a) clock

  private remain(): number {
    const g = this.game;
    const r = g.session ? g.session.remain : g.netRemain;
    return Number.isFinite(r) ? Math.max(0, Math.min(MATCH_TIME, r)) : MATCH_TIME;
  }

  /**
   * THE DIAL IS A COUNTDOWN. Its badges run 0 (twelve o'clock), 1, 2, 3 ANTI-
   * clockwise, one per hour mark: the long hand points at the MINUTES LEFT and
   * winds back toward 0; the red sweep winds the seconds back the same way (a
   * full turn per minute, 0 on top at every whole minute); the short hand stays
   * parked on 0 — the target. Angles are anticlockwise radians (the pivots'
   * +Z: clockwise is negative, so these go in as-is).
   */
  private angles(left: number, tick: boolean): { h: number; m: number; s: number } {
    const m = (left / 60) * (Math.PI / 6);
    let s: number;
    if (tick) {
      const sec = Math.ceil(left - 1e-6);
      const at = ((sec % 60) / 60) * Math.PI * 2;
      // a stepped second: snaps over ~70 ms with a damped overshoot, like a station clock
      const k = Math.min(1, this.tickT / 0.07);
      const settle = k < 1 ? k * k * (3 - 2 * k) : 1 + Math.exp(-(this.tickT - 0.07) * 28) * Math.sin((this.tickT - 0.07) * 70) * 0.18;
      s = at + ((Math.PI * 2) / 60) * (1 - Math.min(1.2, settle));
    } else {
      s = ((left % 60) / 60) * Math.PI * 2;
    }
    return { h: 0, m, s };
  }

  private setHands(a: { h: number; m: number; s: number }): void {
    if (this.hour) this.hour.o.rotation.z = a.h;
    if (this.minute) this.minute.o.rotation.z = a.m;
    if (this.sweep) this.sweep.o.rotation.z = a.s;
  }

  private updateClock(dt: number): void {
    if (!this.hour && !this.minute && !this.sweep) return;
    const left = this.remain();
    const live = this.game.matchLive();
    const final = live && left <= 120;
    const sec = Math.ceil(left - 1e-6);
    if (sec !== this.lastSec) {
      if (this.lastSec >= 0 && sec < this.lastSec && final) {
        this.tickT = 0;
        if (left <= 60) this.towerTick(left <= 10);
      }
      this.lastSec = sec;
    }
    this.tickT += dt;
    this.setHands(this.angles(left, final));
  }

  // ---------------------------------------------------------------- (b) population

  private updateSign(): void {
    if (!this.digits.length) return;
    let n = 0;
    for (const p of this.game.players.values()) if (p.alive && p.hp < 200) n++; // a benched seat is pinned at 999 hp
    n = Math.max(0, Math.min(99, n));
    if (n === this.pop) return;
    this.pop = n;
    for (const dg of this.digits) {
      const tens = dg.mesh.name.endsWith("tens");
      const digit = tens ? Math.floor(n / 10) : n % 10;
      dg.mesh.visible = !(tens && n < 10);
      const a = dg.mesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
      const du = 0.1 * (digit - dg.d0);
      for (let k = 0; k < a.count; k++) a.setX(k, dg.base[k]! + du);
      a.needsUpdate = true;
    }
  }

  /** The population the sign is showing (QA). */
  population(): number {
    return this.pop;
  }

  // ---------------------------------------------------------------- (c) the nuke

  private startNuke(): void {
    const g = this.game;
    this.t = 0;
    this.boomed = false;
    this.rumbled = false;
    this.shake = 0;
    const left = this.remain();
    this.midnightFrom = this.angles(left, false);
    const look = LOOK.clone().sub(CAM_FROM).setY(0).normalize();
    // screen-right of a camera looking along `look` (up = +Y) is (-look.z, 0, look.x)
    const dir = new THREE.Vector3(look.x - look.z * Math.tan(GZ_RIGHT), 0, look.z + look.x * Math.tan(GZ_RIGHT)).normalize();
    const gz = new THREE.Vector3(CAM_FROM.x + dir.x * GZ_DIST, 0, CAM_FROM.z + dir.z * GZ_DIST);
    const haze = (g.world!.scene.fog as THREE.Fog | null)?.color ?? new THREE.Color(0xc1bba7);
    this.fx = new NukeFx(gz, CAM_FROM, SUN, haze, isSoftwareGL(g.renderer));
    this.fx.shockAt = SHOCK_S;
    g.world!.scene.add(this.fx.group);
    this.saved = { far: g.camera.far, exposure: Number(g.grade?.uniforms.uExposure?.value ?? 1), slider: prefs().exposure, filter: g.renderer.domElement.style.filter };
    this.overlay = document.getElementById("nuke-fx") ?? document.createElement("div");
    this.overlay.id = "nuke-fx";
    if (!this.overlay.isConnected) (document.getElementById("app") ?? document.body).append(this.overlay);
    this.overlay.style.opacity = "0";
    document.getElementById("endcard")?.classList.add("nuke", "nuke-intro");
    document.body.classList.add("nuke-on");
  }

  private stopNuke(): void {
    const g = this.game;
    this.t = -1;
    this.fx?.dispose();
    this.fx = null;
    if (this.saved) {
      g.camera.far = this.saved.far;
      g.camera.updateProjectionMatrix();
      // NIT (Review-Runde 2): Der Live-Slider darf während der Nuke-Sequenz
      // weiterdrehen — beim Restore wird er respektiert statt vom
      // gespeicherten (stalen) Wert überschrieben.
      if (g.grade?.uniforms.uExposure) {
        const base = this.saved.slider > 0 ? this.saved.exposure / (this.saved.slider / 1.12) : this.saved.exposure;
        g.grade.uniforms.uExposure.value = base * (prefs().exposure / 1.12);
      }
      g.renderer.domElement.style.filter = this.saved.filter;
      this.saved = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    document.getElementById("endcard")?.classList.remove("nuke", "nuke-intro");
    document.body.classList.remove("nuke-on");
    this.lastSec = -1;
  }

  private updateNuke(dt: number, cam: THREE.PerspectiveCamera): void {
    const g = this.game;
    const fx = this.fx;
    if (!fx || !this.saved) return;
    const t = this.t;
    const td = t - DETONATE_AT;
    const calm = reducedMotion();
    if (t >= INTRO_S) document.getElementById("endcard")?.classList.remove("nuke-intro");
    // ---- the hands run to midnight before the flash
    const k = Math.min(1, t / DETONATE_AT);
    const e = k * k * (3 - 2 * k);
    const to = { h: 0, m: 0, s: 0 };
    const from = this.midnightFrom;
    this.setHands({ h: from.h + (to.h - from.h) * e, m: from.m + (to.m - from.m) * e, s: from.s + (to.s - from.s) * e });
    // ---- the camera: a slow push past the clock tower toward the desert
    const drift = Math.min(1, t / 14);
    const de = 1 - (1 - drift) * (1 - drift);
    cam.position.lerpVectors(CAM_FROM, CAM_TO, de);
    cam.up.set(0, 1, 0);
    cam.lookAt(LOOK);
    if (this.shake > 0.0002 && !calm) {
      const s = this.shake;
      cam.rotation.x += Math.sin(t * 61) * s;
      cam.rotation.y += Math.sin(t * 47 + 1.3) * s * 1.2;
      cam.rotation.z += Math.sin(t * 37 + 0.6) * s * 0.8;
    }
    this.shake *= Math.exp(-dt * 1.6);
    cam.fov = CAM_FOV;
    cam.far = CAM_FAR;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    g.vm.root.visible = false;
    g.vm.flash.intensity = 0;
    // ---- the cloud
    fx.update(Math.min(td, 45), cam);
    // ---- light: the flash (exposure + a white veil), then the whiteout when the shock lands
    let veil = 0;
    let exposure = this.saved.exposure;
    if (td >= 0) {
      const flash = td < 0.06 ? td / 0.06 : Math.exp(-(td - 0.06) / 0.28);
      exposure *= 1 + 1.6 * flash;
      veil = Math.max(veil, (calm ? 0.25 : 0.62) * flash);
      if (!this.rumbled && td >= 0.15) {
        this.rumbled = true;
        this.rumble();
      }
      const ts = td - fx.shockAt;
      if (ts >= 0) {
        if (!this.boomed) {
          this.boomed = true;
          this.boom();
          this.shake = 0.045;
        }
        const w = ts < 0.12 ? ts / 0.12 : ts < 0.5 ? 1 : Math.max(0, 1 - (ts - 0.5) / 2.4);
        veil = Math.max(veil, (calm ? 0.5 : 0.93) * w);
        // the town after: dust-heavy, bleached light (the canvas only; the endcard is untouched)
        const ash = Math.min(1, ts / 1.2);
        g.renderer.domElement.style.filter = ash > 0 ? `sepia(${(0.22 * ash).toFixed(3)}) saturate(${(1 - 0.18 * ash).toFixed(3)}) brightness(${(1 - 0.06 * ash).toFixed(3)}) contrast(${(1 + 0.08 * ash).toFixed(3)})` : this.saved.filter;
      }
    }
    if (g.grade?.uniforms.uExposure) g.grade.uniforms.uExposure.value = exposure;
    if (this.overlay) {
      const v = veil.toFixed(3);
      if (this.overlay.style.opacity !== v) this.overlay.style.opacity = v;
    }
  }

  // ---------------------------------------------------------------- sound

  /** Synthesised buffers, made once on the rig's context. */
  private bufs = new Map<string, AudioBuffer>();

  private synth(name: string, sec: number, fill: (t: number, i: number, sr: number, rnd: () => number) => number): AudioBuffer | null {
    const ctx = this.game.audio.ctx;
    if (!ctx) return null;
    let b = this.bufs.get(name);
    if (b) return b;
    const sr = ctx.sampleRate;
    const n = Math.floor(sec * sr);
    const d = new Float32Array(n);
    let seed = 1234567;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let peak = 1e-6;
    for (let i = 0; i < n; i++) {
      d[i] = fill(i / sr, i, sr, rnd);
      peak = Math.max(peak, Math.abs(d[i]!));
    }
    for (let i = 0; i < n; i++) d[i] = (d[i]! / peak) * 0.5;
    b = ctx.createBuffer(1, n, sr);
    b.copyToChannel(d, 0);
    this.bufs.set(name, b);
    return b;
  }

  private out(): AudioNode | null {
    const r = this.game.audio as unknown as { buses?: Record<string, GainNode>; master?: GainNode };
    return r.buses?.vfx ?? r.master ?? null;
  }

  private play(buf: AudioBuffer | null | undefined, gain: number, rate = 1, delay = 0, node?: AudioNode): void {
    const ctx = this.game.audio.ctx;
    const out = node ?? this.out();
    if (!ctx || !buf || !out || !this.game.audio.ready) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    src.start(ctx.currentTime + delay);
  }

  /** The distant roll that starts under the flash: low brown noise swelling over seconds. */
  private rumble(): void {
    let y = 0;
    let y2 = 0;
    const buf = this.synth("rumble", 7.5, (t, _i, sr, rnd) => {
      const a = Math.exp((-2 * Math.PI * 70) / sr);
      y = (1 - a) * (rnd() * 2 - 1) + a * y;
      y2 = (1 - a) * y + a * y2;
      const env = Math.min(1, t / 2.6) ** 1.6 * Math.exp(-Math.max(0, t - 3.2) / 1.8);
      return y2 * env;
    });
    this.play(buf, 0.55);
  }

  /** THE SHOCKWAVE: KR's blast takes pitched down, a sub thump, the debris rush. */
  private boom(): void {
    const lib = (this.game.audio as unknown as { weapons?: { lib?: { clips: Map<string, { buf: AudioBuffer }[]> } } }).weapons?.lib;
    const near = lib?.clips.get("exp/near")?.[0]?.buf;
    const far = lib?.clips.get("exp/far")?.[0]?.buf;
    this.play(near, 0.75, 0.52);
    this.play(far, 0.85, 0.6, 0.03);
    this.play(far, 0.5, 0.42, 0.25);
    let ph = 0;
    const thump = this.synth("thump", 3.2, (t, _i, sr) => {
      const f = 26 + 34 * Math.exp(-t / 0.35);
      ph += (2 * Math.PI * f) / sr;
      return Math.sin(ph) * Math.min(1, t / 0.012) * Math.exp(-t / 0.9);
    });
    this.play(thump, 0.9);
    let y = 0;
    const rush = this.synth("rush", 4.5, (t, _i, sr, rnd) => {
      const fc = 300 + 1400 * Math.exp(-t / 0.8);
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      y = (1 - a) * (rnd() * 2 - 1) + a * y;
      return y * Math.min(1, t / 0.05) * Math.exp(-t / 1.4);
    });
    this.play(rush, 0.45, 1, 0.05);
    this.rumbleTail();
  }

  private rumbleTail(): void {
    let y = 0;
    let y2 = 0;
    const buf = this.synth("tail", 8, (t, _i, sr, rnd) => {
      const a = Math.exp((-2 * Math.PI * 55) / sr);
      y = (1 - a) * (rnd() * 2 - 1) + a * y;
      y2 = (1 - a) * y + a * y2;
      return y2 * Math.min(1, t / 0.3) * Math.exp(-t / 2.6);
    });
    this.play(buf, 0.7, 1, 0.2);
  }

  /** The tower's tock, heard from the clock (positional), in the final minute. */
  private towerTick(loud: boolean): void {
    const ctx = this.game.audio.ctx;
    const rig = this.game.audio as unknown as { makePanner?: (c: BaseAudioContext, x: number, y: number, z: number) => PannerNode };
    const out = this.out();
    if (!ctx || !out || !rig.makePanner) return;
    const buf = this.synth("tock", 0.16, (t, _i, _sr, rnd) => {
      const e = Math.exp(-t / 0.018);
      return (Math.sin(2 * Math.PI * 860 * t) * 0.6 + Math.sin(2 * Math.PI * 2310 * t) * 0.3 + (rnd() * 2 - 1) * 0.25 * Math.exp(-t / 0.004)) * e;
    });
    const pan = rig.makePanner(ctx, this.clockAt.x, this.clockAt.y, this.clockAt.z);
    pan.refDistance = 12;
    pan.connect(out);
    this.play(buf, loud ? 0.75 : 0.5, 1, 0, pan);
  }
}

/** ONE LINE in game.ts init(): wraps the world's update with the live town. */
export async function attachNuketownLive(game: Game): Promise<NuketownLive | null> {
  const world = game.world;
  if (!world) return null;
  const live = new NuketownLive(game);
  // feel stream R2: the mannequin heads (nuketown-egg.ts) — in the scene before the graphics warm-up compiles it
  const egg = new MannequinEgg(game);
  await egg.init();
  // feel stream R2: breakable windows — houses and every vehicle (nuketown-glass.ts)
  const glass = new BreakableGlass(game);
  glass.init();
  const base = world.update.bind(world);
  world.update = (dt: number, cam: THREE.Camera) => {
    base(dt, cam);
    live.update(dt, cam);
    egg.update(dt);
    glass.update(dt);
  };
  (window as unknown as { __nuketownLive?: NuketownLive }).__nuketownLive = live;
  return live;
}
