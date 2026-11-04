/**
 * client/src/cine/intro.ts — THE MATCH-START INTRO (and the short round-start variant).
 * ===========================================================================
 *
 * A drawing of the countdown the authority already owns (shared/cine.ts): every
 * frame is a pure function of `msRemaining`, so all clients are on the same
 * frame of the same shot and the match goes live on the server's clock whether
 * or not anybody watched.
 *
 * MATCH (10 s), round 6:
 *   THE REEL     authored per-map shots that move and get shorter toward GO, under the title card
 *   THE HERO     YOU, in the authored hero pose (cine/pose.ts), three-quarter to the lens on a real
 *                20° arc with a slow push, 61 → 68% of the frame tall, feet in, lit (key + cool rim);
 *                planned on the spot (framing.heroShot): no plan where more than 20% of you is covered
 *   THE PUSH     a crash push from the hero shot into your eyes (the lens narrows as it closes, never
 *                nearer than 1.15 m), ending ON the GO frame
 *   GO           the cut to your own view, the bars SNAP open, GO punches in big over the middle with
 *                an exposure kick, and ONE hit (the music's own on GO — or, with no music, one cue on
 *                the audio clock at GO); the HUD comes back group by group
 * ROUND (3.2 s): the hero shot and the push, planned on frame 1.
 *
 * The 3-2-1 is big, in the left third (off you — you stand on the right third), while the letterbox is up.
 *
 * SKIP: hold SPACE for SKIP_HOLD_MS: the cards fade, a 0.45 s dip to black into your own view, the bars
 * gone at once, the HUD back, free look, a count to GO. Never a frozen letterboxed wait.
 */
import * as THREE from "three";
import { activeMap } from "@shared/maps";
import { modeInfo, type ModeId } from "@shared/modes";
import type { PlayerSnap } from "@shared/protocol";
import { COUNTDOWN_MS, GO_MS } from "@shared/matchphase";
import { BEATS, MATCH_START_MS, SKIP_SWOOP_MS, introKindFor, introSample, reelMs, type IntroKind } from "@shared/cine";
import { EYE } from "@shared/sim";
import { WEAPON_BY_ID } from "@shared/weapons";
import { type CineOverlay, type TeamRow, type Callout } from "./overlay";
import type { CineLens } from "./lens";
import type { CineSfx } from "./sfx";
import { freshPose, handheld, sampleReel, type CamPose, type CineFile, type Shot } from "./shots";
import { HERO_BODY_M, HERO_FOV, bodyOccluded, heroShot, heroShotCam, heroShotStats, landingYaw, seg, viewOpen, type HeroShot } from "./framing";
import { heroPose } from "./pose";
import { smooth, type Emit, type Host, type HoldSkip } from "./host";

const MAP = activeMap();
const UP = new THREE.Vector3(0, 1, 0);
/** Positions are trusted this long after a MATCH countdown arms (online respawns arrive late). */
const SETTLE_MS = 1200;
/** HUD groups fade back in one after another over ~300 ms at GO. */
const HUD_STAGGER = [0, 70, 140, 210];
const HUD_FADE_MS = 180;
/** GO: the bars snap open on the hit. */
const BARS_OPEN_MS = 90;
/** The push never brings the lens nearer your eyes than this (m): no body within 1 m of the lens, ever. */
const PUSH_STOP_M = 1.15;
/** The push's lens: from the hero shot's FOV down to this (deg) — your face fills the frame on the last frame. */
const PUSH_FOV = 13;
/** A turn faster than this between two frames (deg in < 50 ms) that is not an authored cut is a snap. */
const SNAP_DEG = 25;
/** The GO exposure kick (ms) and the lens kept on for it. */
const GO_KICK_MS = 240;

type Run = {
  kind: IntroKind;
  total: number;
  lastLeft: number;
  started: boolean;
  titleRung: boolean;
  swoopRung: boolean;
  musicOn: boolean;
  /** the music carries the GO hit (the generic cue or the Katana score) */
  goByMusic: boolean;
  goCueSet: boolean;
  skip: { at: number; t: number } | null;
  /** a late joiner on a match start: the minimal match card, not the round card */
  late: boolean;
  lastShot: number;
  reel: Shot[];
  landing: { yaw: number; dist: number; low: number } | null;
  turned?: boolean;
  shot: HeroShot | null;
  shotTried: boolean;
  /** the push's end, fixed when it starts */
  push: { from: THREE.Vector3; to: THREE.Vector3; look0: THREE.Vector3; eye: THREE.Vector3 } | null;
  wasHero: boolean;
  eyesAt: number;
  rosterN?: number;
  prevOwn: { on: boolean; frac: number };
  skipHud?: boolean;
};

export class IntroDirector {
  file: CineFile | null = null;
  run: Run | null = null;
  phase: "shots" | "hero" | "swoop" | "eyes" | "off" = "off";
  /** Your own body is drawn (third person) — game.ts's actor loop reads this. */
  selfBody = false;
  hideOverlays = false;
  forced: { at: number; total: number; kind: IntroKind } | null = null;
  disabled: boolean;
  /** A dedicated cool rim light (cine/index.ts owns it; null before init). */
  rim: THREE.PointLight | null = null;
  /** A soft warm key for the hero shot (cine/index.ts owns it). */
  key: THREE.PointLight | null = null;
  /** The cine owns GO's sound until shortly after GO (matchfeel's own GO cue stands down). */
  goOwnedUntil = 0;
  private prevQ = new THREE.Quaternion();
  private hasPrevQ = false;
  private cutNow = false;
  private pose: CamPose = freshPose();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler();
  private t = 0;
  private goAt = 0;
  private goHit = false;
  private hudIn = 0;
  /** QA: last measured values. */
  qa = {
    camToHead: 99,
    ownVisible: false,
    ownInFrame: false,
    ownFrac: 0,
    pops: 0,
    sightAhead: 0,
    sightLow: 0,
    landingBest: 0,
    landingYaw: 0,
    landingDist: 0,
    landingOpen: 0,
    snaps: 0,
    maxTurn: 0,
    enemyFacing: true,
    cut: false,
    skipCut: false,
    dip: false,
    pitch: 0,
    roll: 0,
    shot: -1,
    hero: false,
    /** the hero shot: you share of the frame tall (min / max over the shot), worst share of you covered (live),
     *  the face toward the lens, the arc flown (deg), the push's nearest approach to your eyes (m) */
    heroFracMin: 9,
    heroFracMax: 0,
    heroOccl: 0,
    heroFace: true,
    heroArcDeg: 0,
    pushNear: 99,
    heroPlanned: false,
    heroTried: 0,
    eyesBy: 0,
    skipAt: 0,
    /** GO: ms of letterbox still up after GO (dead hand-over), the GO cue's source */
    goBarsMs: 0,
    goCue: "",
    /** the letterbox this frame (0..1) */
    barsNow: 0,
  };
  private heroAz: number | null = null;
  private goLensOff = true;

  constructor(
    private g: Host,
    private overlay: () => CineOverlay | null,
    private lens: () => CineLens | null,
    private sfx: CineSfx,
    private emit: Emit,
    private hold: HoldSkip,
  ) {
    this.disabled = new URLSearchParams(location.search).get("intro") === "0";
  }

  matchStartMs(): number {
    return this.disabled ? COUNTDOWN_MS : MATCH_START_MS;
  }

  busy(): boolean {
    return !!this.run && this.run.started && this.phase !== "eyes";
  }

  preview(kind: IntroKind): void {
    this.forced = { at: performance.now(), total: kind === "match" ? MATCH_START_MS : COUNTDOWN_MS, kind };
    this.run = null;
  }

  private leftNow(): { phase: string; left: number } {
    if (this.forced) {
      const left = this.forced.total - (performance.now() - this.forced.at);
      if (left <= -1200) {
        this.forced = null;
        return { phase: this.g.matchPhase(), left: this.g.countdownLeftMs() };
      }
      return { phase: left > 0 ? "countdown" : "live", left };
    }
    return { phase: this.g.matchPhase(), left: this.g.countdownLeftMs() };
  }

  private begin(left: number): void {
    const kind = this.forced?.kind ?? introKindFor(left);
    // a countdown too short for the match intro is a ROUND start only from round 2 on; before that it is
    // a late joiner on a match start (the minimal match card, never "NEXT ROUND")
    const late = !this.forced && kind === "round" && !((this.g.roundInfo()?.n ?? 0) >= 2);
    const total = kind === "match" ? Math.max(MATCH_START_MS, left) : Math.max(COUNTDOWN_MS, left);
    this.run = {
      kind,
      total,
      lastLeft: left,
      started: false,
      titleRung: false,
      swoopRung: false,
      musicOn: false,
      goByMusic: false,
      goCueSet: false,
      skip: null,
      late,
      lastShot: -1,
      reel: [],
      landing: null,
      shot: null,
      shotTried: false,
      push: null,
      wasHero: false,
      eyesAt: 0,
      prevOwn: { on: false, frac: 0 },
    };
    this.hasPrevQ = false;
    this.heroAz = null;
    Object.assign(this.qa, { snaps: 0, maxTurn: 0, dip: false, cut: false, skipCut: false, eyesBy: 0, skipAt: 0, pops: 0, pitch: 0, roll: 0, heroFracMin: 9, heroFracMax: 0, heroOccl: 0, heroFace: true, heroArcDeg: 0, pushNear: 99, heroPlanned: false, goBarsMs: 0, goCue: "" });
  }

  /** Every drawn frame, after the first-person camera is placed. */
  frame(dt: number, blocked: boolean): void {
    this.t += dt;
    const g = this.g;
    const { phase, left } = this.leftNow();
    const eligible = !this.disabled && !g.testMode && !g.spectateCam && !blocked && !!this.file && !!this.overlay();
    if (eligible && phase === "countdown" && left > 0) {
      if (!this.run || left > this.run.lastLeft + 400) this.begin(left);
    }
    this.tickHud();
    const r = this.run;
    if (!r) {
      this.selfBody = false;
      this.hideOverlays = false;
      this.tickGo();
      return;
    }
    if (!eligible || phase === "pregame" || left <= 0) {
      this.end(left);
      return;
    }
    r.lastLeft = left;
    const s = introSample(r.kind, r.total, left, r.skip ? r.skip.at : null);
    if (s.phase === "off") {
      this.end(left);
      return;
    }
    if (!r.started) this.start(r, left);
    if (!r.musicOn) {
      r.musicOn = this.sfx.introMusic(r.kind, left, r.total);
      r.goByMusic = r.musicOn && this.sfx.goByMusic(r.kind);
    }
    const cam = g.camera;
    const qEye = cam.quaternion.clone();
    const me = g.me();
    const meOk = !!me && me.alive;
    const head = me ? new THREE.Vector3(me.x, me.y + EYE, me.z) : null;
    // ---- plan once positions are trusted (a round start: at once; its respawn is in the same tick)
    const settled = r.kind === "round" || s.elapsed >= SETTLE_MS || r.skip !== null;
    if (settled) {
      this.ensureLanding(r);
      if (r.landing && !r.turned && me) {
        r.turned = true;
        g.yaw = r.landing.yaw;
        g.pitch = 0;
      }
    }
    // the hero shot is planned on its first frame (online, the squad has long landed by then)
    if ((s.phase === "hero" || s.phase === "swoop") && !r.skip) this.ensureShot(r);
    // ---- ONE GO SOUND: the music's hit on GO; with no music carrying it, one cue on the audio clock at GO
    if (!r.goCueSet && !r.skip && left < 1500 && r.kind === "match") {
      r.goCueSet = true;
      if (r.goByMusic) this.qa.goCue = "music";
      else {
        this.sfx.play("title-hit", { gain: 0.9, delay: Math.max(0, left / 1000) });
        this.qa.goCue = "title-hit";
      }
      this.goOwnedUntil = performance.now() + left + 1500;
    }
    // ---- skip (hold SPACE)
    const canSkip = r.kind === "match" && (s.phase === "shots" || s.phase === "hero") && !r.skip && s.elapsed > 300 && left > 1200;
    if (canSkip && this.hold.take()) this.doSkip(r, left, s.elapsed);
    if (!r.titleRung && r.kind === "match" && !r.skip && s.elapsed >= BEATS.titleIn) {
      r.titleRung = true;
      this.emit("titleBeat", { atMs: BEATS.titleIn });
      this.sfx.titleHit();
    }
    // the roster card follows the room until it shows (online, the bots arrive a few snapshots after START)
    if (r.kind === "match" && s.elapsed < BEATS.teamsIn + 300) {
      const ro = this.roster();
      const n = ro.allies.length * 100 + ro.enemies.length;
      if (n !== r.rosterN) {
        r.rosterN = n;
        this.overlay()!.setTeams(ro.allies, ro.enemies);
      }
    }
    let radial = 0;
    let aperture = 0;
    let focus = 20;
    let veil = 0;
    let callouts: Callout[] = [];
    let heroOn = false;
    // ---------------------------------------------------------------- the camera
    this.cutNow = false;
    const reel = reelMs(r.kind, r.total);
    if (s.phase === "eyes") {
      if (this.phase !== "eyes") {
        r.eyesAt = this.t;
        this.qa.eyesBy = s.elapsed;
        this.cutNow = true;
      }
      this.phase = "eyes";
      // after a skip the dip comes back up on your own view
      if (r.skip) veil = Math.max(0, 1 - (performance.now() - r.skip.t - SKIP_SWOOP_MS / 2) / (SKIP_SWOOP_MS / 2));
      this.rimOn(null, null, false);
    } else if (r.skip) {
      // THE SKIP: a dip to black, then your own view (the eyes phase) — never a flight, never a frozen wait
      this.phase = "swoop";
      veil = Math.min(1, s.swoop * 2);
      if (s.swoop >= 0.5) {
        this.restoreEye(qEye);
        this.cutNow = true; // the cut under the black
      }
      this.qa.dip = true;
    } else if ((s.phase === "hero" || s.phase === "swoop") && r.shot && head) {
      // ---- THE HERO SHOT, then THE PUSH into your eyes
      heroOn = true;
      const sh = r.shot;
      if (!r.wasHero) {
        r.wasHero = true;
        this.cutNow = true;
      }
      const base = sh.base;
      const camP = heroShotCam(sh, s.hero);
      const comp = this.composeLook(camP, base, sh.fov);
      if (s.phase === "hero") {
        this.phase = "hero";
        cam.position.copy(camP);
        cam.up.set(0, 1, 0);
        cam.lookAt(comp);
        // a breath of handheld on the hero (alive, never a locked-off frame)
        handheld(s.elapsed / 1000, 0.12, this.tmpE);
        this.tmpQ.setFromEuler(this.tmpE);
        cam.quaternion.multiply(this.tmpQ);
        cam.fov = sh.fov;
        aperture = 1.6;
        focus = camP.distanceTo(head);
        const hb = (g.actors.get(g.you) as unknown as { bones?: Record<string, THREE.Object3D> } | undefined)?.bones?.Head;
        const hw = hb ? hb.getWorldPosition(new THREE.Vector3()) : head;
        callouts = this.youCallout(hw, s.hero);
        const az = Math.atan2(camP.x - base.x, camP.z - base.z);
        if (this.heroAz === null) this.heroAz = az;
        this.qa.heroArcDeg = Math.max(this.qa.heroArcDeg, (Math.abs(Math.atan2(Math.sin(az - this.heroAz), Math.cos(az - this.heroAz))) * 180) / Math.PI);
      } else {
        // THE PUSH: from the end of the arc straight at your eyes, accelerating, the lens narrowing
        this.phase = "swoop";
        if (!r.swoopRung) {
          r.swoopRung = true;
          this.emit("introSwoop", { skipped: false });
          this.sfx.play("swoop", { gain: 1.1 });
        }
        if (!r.push) {
          const from = heroShotCam(sh, 1);
          // the eyes as DRAWN (the hero pose leans and turns the head off the body's axis)
          const hb = (g.actors.get(g.you) as unknown as { bones?: Record<string, THREE.Object3D> } | undefined)?.bones?.Head;
          const hw = hb ? hb.getWorldPosition(new THREE.Vector3()) : head;
          const eye = hw.clone().add(new THREE.Vector3(Math.sin(sh.bodyYaw + sh.look * 0.85), 0, Math.cos(sh.bodyYaw + sh.look * 0.85)).multiplyScalar(0.14)).setY(hw.y + 0.1);
          const away = from.clone().sub(eye).normalize();
          const to = eye.clone().addScaledVector(away, PUSH_STOP_M);
          r.push = { from, to: seg(from, to) ? to : from.clone().lerp(to, 0.5), look0: comp.clone(), eye };
        }
        const P = r.push;
        const v = s.swoop;
        const e = v * v * (3 - 2 * v) * 0.35 + v * v * v * 0.65;
        cam.position.copy(P.from).lerp(P.to, e);
        cam.up.set(0, 1, 0);
        cam.lookAt(P.look0.clone().lerp(P.eye, smooth(0, 0.7, v)));
        cam.fov = sh.fov + (PUSH_FOV * (sh.fov / HERO_FOV) - sh.fov) * e;
        radial = 0.7 * v * v;
        aperture = 1.6;
        focus = cam.position.distanceTo(P.eye);
        this.qa.pushNear = Math.min(this.qa.pushNear, cam.position.distanceTo(head));
      }
      cam.updateProjectionMatrix();
      this.rimOn(head, cam.position, true);
      // anybody else near the lens is not drawn (a squadmate stepping in mid-shot)
      for (const [id, a] of g.actors) {
        if (id === g.you) continue;
        const q = a.root.position;
        if (Math.hypot(q.x - cam.position.x, Math.max(q.y, Math.min(q.y + 1.8, cam.position.y)) - cam.position.y, q.z - cam.position.z) < 1.3) a.root.visible = false;
      }
    } else if (s.phase === "shots" || s.phase === "hero" || s.phase === "swoop") {
      // THE REEL (and, with no hero shot possible, the reel's last shot held, then a dip into your eyes on GO)
      this.phase = s.phase === "shots" ? "shots" : s.phase;
      const reelT = s.phase === "shots" ? s.reelT : (reel + (s.elapsed - reel) * 0.35) / 1000;
      if (r.reel.length) {
        sampleReel(r.reel, Math.min(reelT, reel / 1000), Math.max(0.001, reel / 1000), this.pose);
        if (this.pose.shot !== r.lastShot) {
          r.lastShot = this.pose.shot;
          this.cutNow = true;
        }
        const sh = r.reel[this.pose.shot];
        this.applyPose(this.pose, s.elapsed / 1000, sh?.shake ?? 0.3);
        aperture = sh?.aperture ?? 2.4;
        focus = this.pose.focus;
        this.qa.shot = this.pose.shot;
      }
      if (s.phase === "swoop") {
        veil = smooth(0.3, 1, s.swoop);
        this.qa.cut = true;
      }
      this.rimOn(null, null, false);
    }
    // ---------------------------------------------------------------- your own body (the hero shot and the push only)
    const camToHead = head ? cam.position.distanceTo(head) : 99;
    this.selfBody = heroOn && meOk && camToHead > 1.0;
    const own = g.actors.get(g.you);
    if (own) {
      own.root.visible = this.selfBody;
      heroPose(own as never, this.selfBody ? 1 : 0, r.shot?.look ?? 0.55, this.t);
    }
    if (heroOn && head && me) this.measureHero(r, me);
    const inEyes = s.phase === "eyes" || (r.skip !== null && s.swoop >= 0.5);
    if (!(inEyes && meOk)) g.vm.root.visible = false;
    this.hideOverlays = !inEyes;
    // after a skip the HUD comes back once the dip has cleared, group by group (never over the black)
    const hudBack = s.phase === "eyes";
    if (hudBack && r.skip && !r.skipHud) {
      r.skipHud = true;
      this.hudIn = performance.now();
      document.body.classList.add("cine-stagger");
    }
    document.body.classList.toggle("cine-hud-off", !hudBack);
    // after a skip, your own view is a normal pre-GO view: no bars, the HUD's own count
    document.body.classList.toggle("cine-count", !inEyes);
    // ---------------------------------------------------------------- lens + chrome
    const lens = this.lens();
    if (lens) {
      lens.setOn(!inEyes);
      lens.aperture = aperture;
      lens.focus = focus;
      lens.radial = radial;
      lens.vignette = 0.42;
      lens.flash = 0;
      lens.lift = 0;
    }
    const ov = this.overlay()!;
    // cards: a skip FADES them (300 ms), never cuts them
    const skipFade = r.skip ? Math.max(0, 1 - (performance.now() - r.skip.t) / 300) : 1;
    const roundEnv = r.kind === "round" ? Math.min(1, s.elapsed / 250) * (s.phase === "swoop" ? 1 - smooth(0.2, 0.7, s.swoop) : 1) : 0;
    ov.intro({
      bars: inEyes ? 0 : s.bars,
      title: s.title * skipFade,
      mode: s.mode * skipFade,
      teams: s.teams * skipFade,
      flash: 0,
      round: roundEnv,
      // after a skip, count to GO (the HUD's own 3-2-1 takes over for the last 3.2 s)
      waitS: r.skip && inEyes && left > COUNTDOWN_MS + 100 ? left / 1000 : 0,
    });
    ov.setVeil(veil);
    ov.callouts(callouts);
    this.qa.barsNow = inEyes ? 0 : s.bars;
    const ringA = r.kind === "match" && (s.phase === "shots" || s.phase === "hero") && !r.skip ? Math.min(0.85, s.elapsed / 500) : 0;
    ov.skipRing(this.hold.fill(), ringA);
    // ---------------------------------------------------------------- QA
    this.qa.camToHead = camToHead;
    this.qa.ownVisible = !!own?.root.visible;
    this.qa.ownInFrame = heroOn;
    const f = new THREE.Vector3();
    cam.getWorldDirection(f);
    if (inEyes && head) {
      const v = viewOpen(head, Math.atan2(f.x, f.z));
      this.qa.sightAhead = v.min;
      this.qa.sightLow = v.low;
      this.qa.landingOpen = v.open;
    }
    // SNAPS: a turn faster than SNAP_DEG between two frames < 50 ms apart that is not an authored cut
    if (this.hasPrevQ && !inEyes && !this.cutNow && dt > 0 && dt < 0.05) {
      const deg = (this.prevQ.angleTo(cam.quaternion) * 180) / Math.PI;
      this.qa.maxTurn = Math.max(this.qa.maxTurn, deg);
      if (deg > SNAP_DEG) this.qa.snaps++;
    }
    this.prevQ.copy(cam.quaternion);
    this.hasPrevQ = !inEyes;
    this.qa.pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
    this.tmpE.setFromQuaternion(cam.quaternion, "YXZ");
    this.qa.roll = inEyes ? 0 : this.tmpE.z;
  }

  /** The look point that puts you on the RIGHT third (the 3-2-1 owns the left), whole, a touch low. */
  private composeLook(camP: THREE.Vector3, base: THREE.Vector3, vfov: number): THREE.Vector3 {
    const c = new THREE.Vector3(base.x, base.y + 0.96, base.z);
    const to = new THREE.Vector3(c.x - camP.x, 0, c.z - camP.z);
    const d = to.length();
    to.normalize();
    const right = new THREE.Vector3(-to.z, 0, to.x);
    const aspect = innerWidth / Math.max(1, innerHeight);
    const hfov = 2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect);
    return c.addScaledVector(right, -Math.tan(hfov / 2) * d * 0.34);
  }

  /** Back to the first-person camera game.ts placed this frame. */
  private restoreEye(q: THREE.Quaternion): void {
    this.g.camera.quaternion.copy(q);
  }

  /** QA, per hero frame: how tall you stand, how much of you is covered, the face to the lens. */
  private measureHero(r: Run, me: PlayerSnap): void {
    const cam = this.g.camera;
    cam.updateMatrixWorld();
    const a = new THREE.Vector3(me.x, me.y, me.z).project(cam);
    const b = new THREE.Vector3(me.x, me.y + HERO_BODY_M, me.z).project(cam);
    const frac = Math.abs(b.y - a.y) / 2;
    if (this.phase === "hero") {
      this.qa.heroFracMin = Math.min(this.qa.heroFracMin, frac);
      this.qa.heroFracMax = Math.max(this.qa.heroFracMax, frac);
      // every 4th frame: the occlusion test the planner used, live (colliders + other bodies)
      if ((Math.round(this.t * 60) & 3) === 0) {
        const others = [...this.g.players.values()].filter((p) => p.id !== me.id && p.alive);
        this.qa.heroOccl = Math.max(this.qa.heroOccl, bodyOccluded(cam.position.clone(), new THREE.Vector3(me.x, me.y, me.z), others));
      }
      const sh = r.shot!;
      const fy = sh.bodyYaw + 0.85 * sh.look;
      const toCam = Math.atan2(cam.position.x - me.x, cam.position.z - me.z);
      if (Math.cos(toCam - fy) < Math.cos((65 * Math.PI) / 180)) this.qa.heroFace = false;
    }
  }

  /** "YOU" pinned 0.25 m over your head through the hero shot. */
  private youCallout(head: THREE.Vector3, u: number): Callout[] {
    const cam = this.g.camera;
    cam.updateMatrixWorld();
    const v = head.clone().setY(head.y + 0.36).project(cam);
    const a = smooth(0.06, 0.2, u) * (1 - smooth(0.78, 0.95, u));
    if (v.z > 1 || Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.75 || a <= 0) return [];
    return [{ x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, name: "YOU", you: true, a }];
  }

  private doSkip(r: Run, left: number, elapsed: number): void {
    r.skip = { at: left, t: performance.now() };
    this.qa.skipAt = elapsed;
    this.emit("introSkip", { mode: "dip" });
  }

  /** At GO: the letterbox snaps open, GO punches in, the exposure kicks, the HUD comes back. */
  private tickGo(): void {
    if (!this.goAt) return;
    const age = performance.now() - this.goAt;
    const ov = this.overlay();
    if (age < 0) return;
    if (!this.goHit) {
      this.goHit = true;
      this.goLensOff = false;
      document.body.classList.add("cine-go");
    }
    const lens = this.lens();
    if (age < GO_KICK_MS) {
      // the exposure kick: a lift in the lens (additive light, never a grey alpha veil)
      if (lens) {
        lens.setOn(true);
        lens.aperture = 0;
        lens.radial = 0.25 * Math.max(0, 1 - age / 140);
        lens.vignette = 0.3 * (1 - age / GO_KICK_MS);
        lens.lift = 0.55 * Math.max(0, 1 - age / 200) ** 2;
      }
    } else if (lens && !this.goLensOff) {
      this.goLensOff = true;
      lens.lift = 0;
      lens.radial = 0;
      lens.setOn(false);
    }
    if (ov && age < 200) ov.intro({ bars: Math.max(0, 1 - age / BARS_OPEN_MS), title: 0, mode: 0, teams: 0, flash: 0, round: 0 });
    // GO punches in: 1.35x -> 1.0 in 130 ms (ease-out), then a slow 4% breathe out
    const k = Math.min(1, age / 130);
    const sc = age < 130 ? 1.35 - 0.35 * (1 - (1 - k) ** 3) : 1 + 0.04 * Math.min(1, (age - 130) / 700);
    document.body.style.setProperty("--go-s", sc.toFixed(4));
    // QA: how long the letterbox stayed up after GO
    if (age < 400 && this.qa.goBarsMs === 0 && age >= BARS_OPEN_MS) this.qa.goBarsMs = Math.round(age);
    if (age > 200) {
      if (!this.g.fkc) ov?.hide();
    }
    if (age > GO_MS + 200) {
      this.goAt = 0;
      this.goHit = false;
      document.body.classList.remove("cine-count", "cine-count-low", "cine-go");
      document.body.style.removeProperty("--go-s");
    }
  }

  /** The HUD groups come back one after another (CSS vars over the inline styles the HUD writes). */
  private tickHud(): void {
    if (!this.hudIn) return;
    const age = performance.now() - this.hudIn;
    const st = document.body.style;
    HUD_STAGGER.forEach((d, i) => st.setProperty(`--cs${i}`, Math.max(0, Math.min(1, (age - d) / HUD_FADE_MS)).toFixed(3)));
    if (age > HUD_STAGGER[HUD_STAGGER.length - 1]! + HUD_FADE_MS + 20) {
      this.hudIn = 0;
      document.body.classList.remove("cine-stagger");
      HUD_STAGGER.forEach((_, i) => st.removeProperty(`--cs${i}`));
    }
  }

  private start(r: Run, left: number): void {
    r.started = true;
    this.phase = "shots";
    const g = this.g;
    const modeId = (g.opts?.gun ? "gun" : (g.opts?.mode ?? "tdm")) as ModeId;
    const info = modeInfo(MAP.id, modeId);
    const me = g.me();
    const myTeam = me?.team ?? 0;
    const roster = this.roster();
    if (r.kind === "match") r.reel = this.file!.shots.filter((s) => !s.squad).map((s) => ({ ...s }));
    let goal = info.goal;
    if (modeId === "snd") goal = `${myTeam === 0 ? "ATTACK · PLANT THE BOMB AT A OR B" : "DEFEND · PROTECT A AND B"} · ${info.goal}`;
    else if (modeId === "dom") goal = `CAPTURE AND HOLD A · B · C · ${info.goal}`;
    let round: { title: string; line: string; score: string } | undefined;
    if (r.kind === "round" && r.late) {
      // joined a match start too late for the intro: the minimal match card (map, mode), no round talk
      round = { title: (this.file!.title ?? MAP.name).toUpperCase(), line: `${info.label} · ${info.size}`, score: "" };
    } else if (r.kind === "round") {
      const ri = g.roundInfo();
      const ours = ri ? (myTeam === 1 ? ri.wins1 : ri.wins0) : 0;
      const theirs = ri ? (myTeam === 1 ? ri.wins0 : ri.wins1) : 0;
      round = {
        title: ri ? `ROUND ${ri.n}` : "NEXT ROUND",
        line: modeId === "snd" ? (myTeam === 0 ? "ATTACK · PLANT AT A OR B" : "DEFEND · PROTECT A AND B") : "ELIMINATE THE ENEMY TEAM",
        score: ri ? `ROUNDS  ${ours} – ${theirs}` : "",
      };
    }
    const f = this.file!;
    this.overlay()!.showIntro({
      eyebrow: f.eyebrow ?? "LOCATION",
      title: (f.title ?? MAP.name).toUpperCase(),
      brand: f.brand?.style === "katana" ? "katana" : "default",
      wordmark: f.brand?.wordmark,
      mode: `${info.label} · ${info.size}`,
      goal,
      allies: roster.allies,
      enemies: roster.enemies,
      ffa: !info.teams,
      short: r.kind === "round",
      round,
    });
    document.body.classList.add("cine-on", "cine-count", "cine-hud-off");
    document.body.classList.toggle("cine-count-low", r.kind === "round");
    this.goAt = 0;
    const offsetMs = Math.max(0, Math.round(r.total - left));
    this.emit("introStart", { kind: r.kind, totalMs: r.total, offsetMs });
  }

  /**
   * THE SQUAD BREATHES. During the intro (the sim holds every body still) each squadmate gets its own
   * idle off its id: a slow sway, and one of four rests — half-raised, low ready, a reload, at ease.
   * YOU stand in the hero pose, turned three-quarter to the lens. Render only (hitboxes and the sim never see it).
   */
  posed(list: PlayerSnap[]): PlayerSnap[] {
    if (!this.run || this.phase === "eyes" || this.phase === "off") return list;
    const t = this.t;
    const me = this.g.you;
    const shot = this.run.shot;
    return list.map((p) => {
      if (!p.alive) return p;
      if (p.id === me) return shot ? { ...p, yaw: shot.bodyYaw + 0.02 * Math.sin(t * 0.9), pitch: 0.06, ads: 0, firing: false, reload: 0, sprint: false, vx: 0, vz: 0 } : p;
      let h = 7;
      for (let i = 0; i < p.id.length; i++) h = (h * 31 + p.id.charCodeAt(i)) >>> 0;
      const u = (h % 1000) / 1000;
      const ph = u * Math.PI * 2;
      const v: PlayerSnap = { ...p, yaw: p.yaw + 0.16 * Math.sin(t * 0.55 + ph), pitch: p.pitch + 0.05 * Math.sin(t * 0.8 + ph * 1.7) };
      const kind = h % 4;
      if (kind === 0) v.ads = 0.3 + 0.15 * Math.sin(t * 0.7 + ph);
      else if (kind === 1) v.swap = (WEAPON_BY_ID[p.weapon]?.swap ?? 0.4) * 0.3;
      else if (kind === 2) v.reload = (t + u * 4) % 4.5 < 1.6 ? 0.25 : 0;
      else v.ads = 0;
      return v;
    });
  }

  /** THE HERO SHOT on where you stand now (once, on its first frame). */
  private ensureShot(r: Run): void {
    if (r.shotTried) return;
    const g = this.g;
    const me = g.me();
    if (!me) return;
    r.shotTried = true;
    const others = [...g.players.values()].filter((p) => p.id !== g.you && p.alive && !(p as { bench?: boolean }).bench);
    r.shot = heroShot(me, others, innerWidth / Math.max(1, innerHeight));
    this.qa.heroPlanned = !!r.shot;
    this.qa.hero = !!r.shot;
    this.qa.heroTried = heroShotStats.tried;
    if (!r.shot) this.qa.cut = true;
  }

  /** THE LANDING VIEW: ≥ 20 m open down the middle, the lower ray clear too, toward the enemy. */
  private ensureLanding(r: Run): void {
    if (r.landing) return;
    const g = this.g;
    const me = g.me() ?? g.session?.players.get(g.you);
    if (!me) return;
    const roster = this.roster();
    const teams = g.opts?.mode !== "ffa";
    const eye = new THREE.Vector3(me.x, me.y + EYE, me.z);
    const foes = roster.all.filter((p) => p.id !== g.you && (!teams || p.team !== me.team));
    const toward = foes.length ? new THREE.Vector3(foes.reduce((a, p) => a + p.x, 0) / foes.length, eye.y, foes.reduce((a, p) => a + p.z, 0) / foes.length) : null;
    const L = landingYaw(eye, me.yaw, toward);
    r.landing = L;
    this.qa.landingYaw = L.yaw;
    this.qa.landingDist = L.dist;
    this.qa.sightLow = L.low;
    this.qa.landingBest = L.maxOpen;
    this.qa.landingOpen = L.open;
    // enemy-facing is required only where an open lane toward them exists at all
    this.qa.enemyFacing = !toward || !L.anyGood || Math.cos(L.yaw - Math.atan2(toward.x - eye.x, toward.z - eye.z)) > 0;
  }

  roster(): { all: PlayerSnap[]; allies: TeamRow[]; enemies: TeamRow[] } {
    const g = this.g;
    const src: PlayerSnap[] = g.players.size ? [...g.players.values()] : g.session ? [...g.session.players.values()] : [];
    const live = src.filter((p) => !(p as { bench?: boolean }).bench);
    const myTeam = g.me()?.team ?? live.find((p) => p.id === g.you)?.team ?? 0;
    const row = (p: PlayerSnap): TeamRow => ({ name: p.name, you: p.id === g.you });
    const allies = live.filter((p) => p.team === myTeam).sort((a, b) => (a.id === g.you ? -1 : b.id === g.you ? 1 : 0)).map(row);
    const enemies = live.filter((p) => p.team !== myTeam).map(row);
    return { all: live, allies, enemies };
  }

  end(left = 0): void {
    const r = this.run;
    this.run = null;
    this.phase = "off";
    this.selfBody = false;
    this.hideOverlays = false;
    document.body.classList.remove("cine-on", "cine-hud-off");
    if (r?.started) {
      // GO: the letterbox snaps open (tickGo) and the HUD comes back group by group
      this.goAt = performance.now() + Math.max(0, left);
      this.goHit = false;
      this.hudIn = performance.now() + Math.max(0, left);
      document.body.classList.add("cine-stagger");
      // the GO numeral is big and centred on your own view
      document.body.classList.add("cine-count");
    } else {
      document.body.classList.remove("cine-count", "cine-count-low");
      this.overlay()?.hide();
      this.lens()?.setOn(false);
    }
    this.overlay()?.callouts([]);
    this.overlay()?.setVeil(0);
    this.rimOn(null, null, false);
    const own = this.g.actors.get(this.g.you);
    if (own) {
      own.root.visible = false;
      heroPose(own as never, 0);
    }
    if (r?.started) this.emit("introEnd", {});
  }

  // ------------------------------------------------------------ camera work

  private applyPose(p: CamPose, t: number, shake: number): void {
    const cam = this.g.camera;
    cam.position.copy(p.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(p.look);
    handheld(t, shake, this.tmpE);
    this.tmpE.z += (p.roll * Math.PI) / 180;
    this.tmpQ.setFromEuler(this.tmpE);
    cam.quaternion.multiply(this.tmpQ);
    cam.fov = p.fov;
    cam.updateProjectionMatrix();
  }

  /** The cool rim behind and above the head; a soft warm key from the lens's side. */
  private rimOn(head: THREE.Vector3 | null, cam: THREE.Vector3 | null, on: boolean): void {
    const L = this.rim;
    const K = this.key;
    if (!L) return;
    if (!on || !head || !cam) {
      L.intensity = 0;
      if (K) K.intensity = 0;
      return;
    }
    const away = new THREE.Vector3().subVectors(head, cam).setY(0).normalize();
    L.position.copy(head).addScaledVector(away, 1.0).addScaledVector(UP, 0.55);
    L.intensity = 12;
    if (K) {
      const right = new THREE.Vector3().crossVectors(away, UP).normalize();
      K.position.copy(cam).addScaledVector(UP, 0.9).addScaledVector(right, -1.1).addScaledVector(away, 0.8);
      K.intensity = 5;
    }
  }
}
