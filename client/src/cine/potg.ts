/**
 * client/src/cine/potg.ts — PLAY OF THE GAME (and the MATCH MVP card).
 * ===========================================================================
 *
 * The window was chosen by the authority (shared/highlights.ts: every kill in
 * it reads in first person, and it clears the quality floor). This replays it
 * from this client's whole-match tape (match-tape.ts):
 *
 *   MATCH OVER (0.8 s)  VICTORY / DEFEAT over the last live frame, then a dip
 *   THE CARD            the player's monkey in a hero pose in an isolated studio
 *                       (vignette.ts: no world, nothing can clip it), name, what
 *                       they did, the line; the sting on it, the music from its top
 *   THE ROLL            their eyes. The clock RAMPS into slow motion on every kill;
 *                       a pop + hitmarker + counter step per victim, staggered;
 *                       aim smoothed between kills. A scoped player is shown through
 *                       the glass only around a kill; between kills a wider view.
 *   THE FREEZE          on the final kill: the frame holds, the lens punches in on
 *                       the victim (big in frame however far), then everything
 *                       fades with the picture to the endcard
 *
 * Below the quality floor (no play) a match with kills gets the MATCH MVP card:
 * the same studio vignette with the top player's line. A client whose tape does
 * not hold the window still gets the card with the play's name and line.
 * Skippable: hold SPACE.
 */
import * as THREE from "three";
import { WEAPON_BY_ID } from "@shared/weapons";
import { CROUCH_EYE, EYE, SLIDE_EYE } from "@shared/sim";
import { activeMap } from "@shared/maps";
import type { Highlight } from "@shared/highlights";
import type { PlayerSnap } from "@shared/protocol";
import type { TapeFrame, TapeHit, TapeShot } from "../final-killcam";
import { vfov } from "../ui/prefs";
import { SCOPE_AT } from "../weapons/hud";
import type { CineOverlay } from "./overlay";
import type { CineLens } from "./lens";
import type { CineSfx } from "./sfx";
import { HeroVignette } from "./vignette";
import { seg } from "./framing";
import { angWrap, smooth, type Emit, type Host, type HoldSkip } from "./host";

const MAP = activeMap();
const OVER_S = 0.8;
const DIP_S = 0.25;
/** The studio card (the music no longer stretches it: the cue is placed to land on the final kill). */
export const CARD_S = 2.7;
const MVP_S = 3.4;
const IN_S = 0.22;
/** The slow motion: speed at a kill, and its RAMPS (clock ms) — eased in before each kill, held, eased back out. */
export const SLOW = 0.25;
export const RAMP_IN = 300;
export const HOLD = 150;
export const RAMP_OUT = 260;
/** the replay's speed far from any kill */
export const FAST = 1.4;
/** The FREEZE is on the final kill's death frame (the killing hit has landed, the body has not begun to fall). */
const FREEZE_S = 1.05;
/** the punch-in: the last victim stands this share of the frame tall on the frozen frame */
export const FREEZE_FRAC = 0.44;
const PUNCH_S = 0.3;
const FADE_S = 0.45;
/** kills of the POV this close together (s of wall time) share ONE pop that counts up (DOUBLE KILL, TRIPLE KILL ...) */
const POP_GAP = 0.9;
/** a scoped player is shown through the glass this close to a kill (clock ms); away from it, hip (never a half-raised tube) */
const GLASS_MS = 650;
/** any body this close to the lens is not drawn (m) — a teammate's face never fills the frame */
const LENS_CLEAR_M = 1.1;
/** The whole cut never runs longer than this (s). */
export const POTG_MAX_S = 13;
/** inside a kill's slow motion, a victim smaller than this share of the frame is punched in to it */
const KILL_FRAC = 0.17;
/** a standing body, feet to crown (m) — the punch-in and its QA measure the same thing */
const BODY_M = 1.8;

type Kill = { t: number; dst: string; head: boolean };
type Phase = "over" | "dip" | "card" | "play" | "freeze" | "fade" | "hold";
type Run = {
  mode: "potg" | "mvp" | "card";
  h: Highlight;
  frames: TapeFrame[];
  shots: TapeShot[];
  hits: TapeHit[];
  kills: Kill[];
  clock: number;
  t0: number;
  t1: number;
  lastKill: number;
  age: number;
  shotIdx: number;
  hitIdx: number;
  phase: Phase;
  phaseT: number;
  cardS: number;
  slowRate: number;
  inSlow: boolean;
  killsShown: number;
  pop: { text: string; at: number } | null;
  lastPopAt: number;
  feedBorn: number[];
  aim: { yaw: number; pitch: number; init: boolean };
  ads?: number;
  freeze: { fov0: number; yaw0: number; pitch0: number; yaw1: number; pitch1: number; fov1: number } | null;
  /** the victim of the final kill, as they stood on the death frame (posed upright through the freeze) */
  freezeVictim: PlayerSnap | null;
  freezeSpan?: [number, number];
  /** ctx time the music's hit is scheduled for, and ctx time the final kill landed on screen (QA) */
  hitCtx: number;
  killCtx: number;
  multi: number;
  lastPovKillAge: number;
  end: () => void;
  ended: boolean;
  skipped: boolean;
  dur: number;
  result: string;
  musicHit: number;
  rate?: number;
  /** wall seconds since the card opened (-1 before it) */
  cardWall: number;
  cardCtx: number;
  cardPerf: number;
};

const MULTI_POP = ["", "", "DOUBLE KILL", "TRIPLE KILL", "QUAD KILL", "PENTA KILL", "HEXA KILL"];

export class PotgDirector {
  run: Run | null = null;
  /** The dedicated cool rim light (cine/index.ts owns it). */
  rim: THREE.PointLight | null = null;
  private vig: HeroVignette | null = null;
  /** QA: per-frame facts. */
  qa = {
    phase: "",
    mode: "",
    povVisible: false,
    gunVisible: false,
    kills: 0,
    pitch: 0,
    popVisible: false,
    slowAfterLast: 0,
    freezeFrac: 0,
    freezeOn: false,
    skipped: false,
    cardOnly: false,
    nearLens: 0,
    vigFrac: 0,
    vigFacing: false,
    vigFaceClear: true,
    vigGunOn: false,
    glassOutside: 0,
    killShots: [] as { name: string; on: boolean; frac: number }[],
    /** |music hit - final kill on screen| (ms); worst |pop/counter clock - kill clock| (ms) */
    hitErrMs: -1,
    hitClock: "",
    popLag: 0,
    freezeRagdoll: false,
    /** share of the final victim's body visible from the killer's eyes on the freeze */
    freezeVisible: 1,
    /** the smallest a victim stood on screen at a kill, after the kill punch-in */
    killMin: 9,
  };

  constructor(
    private g: Host,
    private overlay: () => CineOverlay | null,
    private lens: () => CineLens | null,
    private sfx: CineSfx,
    private emit: Emit,
    private hold: HoldSkip,
  ) {}

  get on(): boolean {
    return !!this.run;
  }

  busy(): boolean {
    return !!this.run && this.run.phase !== "hold";
  }

  /** Whose eyes the camera is in (game.ts hides that body). */
  povId(): string {
    const r = this.run;
    if (!r || r.mode !== "potg") return "";
    return r.phase === "card" || r.phase === "play" || r.phase === "freeze" || r.phase === "fade" ? r.h.id : "";
  }

  /** The replay speed at clock c: eased into each kill, held, eased back out (never a flat step). */
  private rateAt(r: Run, c: number): number {
    // between kills the roll runs a touch FAST (a turn between two fights is not the play); it eases back
    // to real time well before each kill's ramp
    let gap = Infinity;
    for (const k of r.kills) gap = Math.min(gap, Math.abs(c - k.t));
    let rate = 1 + (FAST - 1) * smooth(RAMP_IN + 250, RAMP_IN + 650, gap);
    const S = r.slowRate;
    for (const k of r.kills) {
      let v = Infinity;
      if (c >= k.t - RAMP_IN && c < k.t) v = 1 + (S - 1) * smooth(0, 1, (c - (k.t - RAMP_IN)) / RAMP_IN);
      else if (c >= k.t && c < k.t + HOLD) v = S;
      else if (c >= k.t + HOLD && c < k.t + HOLD + RAMP_OUT) v = S + (1 - S) * smooth(0, 1, (c - k.t - HOLD) / RAMP_OUT);
      rate = Math.min(rate, v);
    }
    return rate;
  }

  /** The replay clock `w` seconds of wall time into the roll (the inverse of wallTo, on the same 10 ms steps). */
  private clockAt(r: Run, w: number): number {
    if (w <= 0) return r.t0;
    let acc = 0;
    for (let x = r.t0; x < r.t1 + 400; x += 10) {
      const step = 0.01 / this.rateAt(r, x);
      if (acc + step >= w) return x + (10 * (w - acc)) / step;
      acc += step;
    }
    return r.t1 + 400;
  }

  private wallTo(r: Run, c: number): number {
    let w = 0;
    for (let x = r.t0; x < c; x += 10) w += 0.01 / this.rateAt(r, x);
    return w;
  }

  private result(): string {
    const g = this.g as Host & { netScore0?: number; netScore1?: number };
    const me = g.me();
    if (g.opts?.mode === "ffa") {
      const top = Math.max(0, ...[...g.players.values()].map((p) => p.kills));
      return me && me.kills >= top && top > 0 ? "VICTORY" : "DEFEAT";
    }
    const s0 = (g.session as { score0?: number } | null)?.score0 ?? g.netScore0 ?? 0;
    const s1 = (g.session as { score1?: number } | null)?.score1 ?? g.netScore1 ?? 0;
    if (s0 === s1) return "DRAW";
    const mine = me?.team === 1 ? s1 : s0;
    const theirs = me?.team === 1 ? s0 : s1;
    return mine > theirs ? "VICTORY" : "DEFEAT";
  }

  private vignette(): HeroVignette | null {
    const ov = this.overlay();
    if (!ov) return null;
    if (!this.vig) this.vig = new HeroVignette(ov.potgRoot(), () => (this.g as unknown as { bruiserTpl: import("../bruiser").BruiserTemplate | null }).bruiserTpl, MAP.id);
    return this.vig;
  }

  private rel(id: string, team?: number): "you" | "ally" | "enemy" {
    const g = this.g;
    const me = g.me();
    const t = team ?? g.players.get(id)?.team ?? this.run?.frames.at(-1)?.players.find((x) => x.id === id)?.team;
    return id === g.you ? "you" : g.opts?.mode !== "ffa" && me && t === me.team ? "ally" : "enemy";
  }

  private nameOf(id: string): string {
    const p = this.g.players.get(id) ?? this.run?.frames.find((f) => f.players.some((x) => x.id === id))?.players.find((x) => x.id === id);
    return p?.name ?? "OPERATOR";
  }

  /** The hero's body for the card (their live snap, else their last taped pose). */
  private heroSnap(id: string): PlayerSnap | null {
    const g = this.g;
    return g.players.get(id) ?? this.run?.frames.at(-1)?.players.find((x) => x.id === id) ?? null;
  }

  /** a play / card ran since the last stop() */
  played = false;

  private open(r: Run, card: { name: string; rel: string; eyebrow: string; title: string; line: string; stats?: { k: string; v: string }[] }): void {
    this.run = r;
    this.played = true;
    const ov = this.overlay()!;
    ov.showPotg({ name: card.name, rel: card.rel as never, title: card.title, line: card.line, eyebrow: card.eyebrow, stats: card.stats });
    ov.overCard(r.result, "MATCH OVER");
    document.body.classList.add("cine-replay", "cine-hud-off");
    document.getElementById("hud")?.classList.add("killcam-on");
    document.getElementById("killcam")?.classList.add("hidden");
    this.qa.killShots = [];
    this.qa.slowAfterLast = 0;
    this.qa.skipped = false;
    this.qa.cardOnly = r.mode !== "potg";
    this.qa.mode = r.mode;
    this.qa.freezeFrac = 0;
    this.qa.freezeOn = false;
    this.qa.nearLens = 0;
    this.qa.glassOutside = 0;
    this.qa.hitErrMs = -1;
    this.qa.popLag = 0;
    this.qa.freezeRagdoll = false;
  }

  private blank(h: Highlight, end: () => void, mode: Run["mode"]): Run {
    return {
      mode,
      h,
      frames: [],
      shots: [],
      hits: [],
      kills: [],
      clock: 0,
      t0: 0,
      t1: 0,
      lastKill: 0,
      age: 0,
      shotIdx: 0,
      hitIdx: 0,
      phase: "over",
      phaseT: 0,
      cardS: mode === "mvp" ? MVP_S : 2.4,
      slowRate: SLOW,
      inSlow: false,
      killsShown: 0,
      pop: null,
      lastPopAt: -9,
      feedBorn: [],
      aim: { yaw: 0, pitch: 0, init: false },
      freeze: null,
      freezeVictim: null,
      hitCtx: 0,
      killCtx: 0,
      multi: 0,
      lastPovKillAge: -9,
      cardWall: -1,
      cardCtx: 0,
      cardPerf: 0,
      end,
      ended: false,
      skipped: false,
      dur: 0,
      result: this.result(),
      musicHit: 1.0,
    };
  }

  /** Whatever personal killcam was running when the match ended is over (its body would sit on the lens). */
  private clearKillcam(): void {
    const g = this.g as unknown as { killcamT: number; kcClock: number };
    g.killcamT = 0;
    g.kcClock = -1;
  }

  start(h: Highlight, clip: { frames: TapeFrame[]; shots: TapeShot[]; hits: TapeHit[] } | null, end: () => void): void {
    const g = this.g;
    g.stopFinalKillcam();
    this.clearKillcam();
    g.endcardUp = false;
    const cardOnly = !clip || clip.frames.length < 2;
    const run = this.blank(h, end, cardOnly ? "card" : "potg");
    if (!cardOnly) {
      run.frames = clip!.frames;
      run.shots = clip!.shots;
      run.hits = clip!.hits;
      // KILLS ON THE PICTURE'S CLOCK: a hit event and the snapshot that shows the death are stamped on two
      // clocks (online they disagree by up to a snapshot interval or two). Each kill — and its hit event, so the
      // sparks, pop and counter go with it — is moved to the frame where the tape shows the victim go down.
      const deathAt = (id: string, near: number): number | null => {
        let was: boolean | null = null;
        for (const f of run.frames) {
          if (f.t < near - 900) continue;
          if (f.t > near + 900) break;
          const p = f.players.find((x) => x.id === id);
          if (!p) continue;
          if (was === true && !p.alive) return f.t;
          was = p.alive;
        }
        return null;
      };
      for (const x of run.hits) {
        if (!(x.src === h.id && x.kill && x.dst !== h.id)) continue;
        const d = deathAt(x.dst, x.t);
        // a hair before the death frame: the victim still stands on the frame the hit lands on
        if (d !== null) x.t = d - 4;
      }
      run.hits.sort((a, b) => a.t - b.t);
      run.kills = run.hits.filter((x) => x.src === h.id && x.kill && x.dst !== h.id).map((x) => ({ t: x.t, dst: x.dst, head: x.head }));
      if (!run.kills.length) for (const k of h.keys) run.kills.push({ t: k * 1000, dst: "", head: false });
      run.lastKill = run.kills.length ? run.kills[run.kills.length - 1]!.t : h.t1 * 1000 - 1500;
      run.t0 = run.clock = h.t0 * 1000;
      run.t1 = Math.min(h.t1 * 1000, run.lastKill + 50);
      run.cardS = CARD_S;
      // length: the card + the roll to the freeze stay under budget — trim the lead first, then thin the slow motion
      const roll = (): number => this.wallTo(run, run.lastKill);
      const total = (): number => OVER_S + DIP_S + run.cardS + IN_S + roll() + FREEZE_S + FADE_S;
      const firstKill = run.kills[0]?.t ?? run.t0;
      // a lead with nothing in it is trimmed to 1.4 s before the first kill (no idle walking)
      if (run.t0 < firstKill - 1400) run.t0 = run.clock = firstKill - 1400;
      while (total() > POTG_MAX_S && run.t0 < firstKill - 800) run.t0 = run.clock = Math.min(firstKill - 800, run.t0 + 200);
      while (total() > POTG_MAX_S && run.slowRate < 0.6) run.slowRate += 0.05;
      run.shotIdx = Math.max(0, run.shots.findIndex((x) => x.t >= run.t0));
      if (run.shots.every((x) => x.t < run.t0)) run.shotIdx = run.shots.length;
      run.hitIdx = Math.max(0, run.hits.findIndex((x) => x.t >= run.t0));
      if (run.hits.every((x) => x.t < run.t0)) run.hitIdx = run.hits.length;
      // THE MUSIC'S HIT LANDS ON THE FINAL KILL: the wall time from the card's first frame to the
      // final kill is passed to the cue, which is placed (seeked, or its head extended) to land there
      run.musicHit = run.cardS + IN_S + this.wallTo(run, run.lastKill);
      run.dur = OVER_S + DIP_S + run.cardS + IN_S + roll() + FREEZE_S + FADE_S;
    } else {
      run.musicHit = 1.2;
      run.dur = OVER_S + DIP_S + run.cardS + FADE_S;
    }
    const rel = this.rel(h.id, h.team);
    this.open(run, { name: h.name, rel, eyebrow: "PLAY OF THE GAME", title: h.title, line: h.line });
    this.emit("potgStart", { highlight: h, durationS: Math.round(run.dur * 100) / 100, cardOnly });
  }

  /** No play cleared the floor: the MATCH MVP card (the top player in the studio, their numbers). */
  startMvp(end: () => void): boolean {
    const g = this.g;
    const src: PlayerSnap[] = g.players.size ? [...g.players.values()] : g.session ? [...g.session.players.values()] : [];
    const all = src.filter((p) => !(p as { bench?: boolean }).bench);
    if (!all.some((p) => p.kills > 0)) return false;
    const top = all.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || (a.id < b.id ? -1 : 1))[0]!;
    g.stopFinalKillcam();
    this.clearKillcam();
    g.endcardUp = false;
    const h: Highlight = { id: top.id, name: top.name, team: top.team, t0: 0, t1: 0, keys: [], score: 0, title: "MATCH MVP", line: "", tags: ["mvp"] };
    const run = this.blank(h, end, "mvp");
    run.dur = OVER_S + DIP_S + run.cardS + FADE_S;
    const kd = top.deaths ? (top.kills / top.deaths).toFixed(2) : top.kills.toFixed(2);
    this.open(run, {
      name: top.name,
      rel: this.rel(top.id, top.team),
      eyebrow: "MATCH MVP",
      title: `${top.kills} ELIMINATIONS`,
      line: "",
      stats: [
        { k: "KILLS", v: String(top.kills) },
        { k: "DEATHS", v: String(top.deaths) },
        { k: "K/D", v: kd },
      ],
    });
    this.emit("potgStart", { highlight: h, durationS: Math.round(run.dur * 100) / 100, cardOnly: true, mvp: true });
    return true;
  }

  /** Dev / QA: the studio card on the local player, held `holdS` seconds (qa/cine/card.mjs). */
  previewCard(holdS = 4, title = "TRIPLE KILL", line = "3 KILLS IN 2.1 S · HEADSHOT"): boolean {
    const g = this.g;
    const me = g.me() ?? (g.session ? [...g.session.players.values()].find((p) => p.id === g.you) : undefined);
    if (!me) return false;
    const h: Highlight = { id: me.id, name: me.name, team: me.team, t0: 0, t1: 0, keys: [], score: 0, title, line, tags: [] };
    const run = this.blank(h, () => this.stop(), "mvp");
    run.cardS = holdS;
    run.dur = holdS;
    this.open(run, { name: me.name, rel: "you", eyebrow: "PLAY OF THE GAME", title, line });
    this.setPhase(run, "card");
    const hs = this.heroSnap(me.id);
    if (hs) this.vignette()?.show(hs);
    this.sfx.potgMusic(1.2);
    return true;
  }

  stop(): void {
    this.played = false;
    if (!this.run) return;
    this.run = null;
    this.vig?.hide();
    this.overlay()?.hide();
    this.lens()?.setOn(false);
    document.body.classList.remove("cine-replay", "cine-hud-off");
    document.getElementById("hud")?.classList.remove("killcam-on");
    if (this.rim) this.rim.intensity = 0;
  }

  private setPhase(r: Run, p: Phase): void {
    r.phase = p;
    r.phaseT = 0;
  }

  /** draw(): advance the replay one frame, return the bodies to pose. */
  tick(dt: number): PlayerSnap[] {
    const r = this.run!;
    const g = this.g;
    r.age += dt;
    r.phaseT += dt;
    // the card clock is WALL time (the page clock), never the summed frame dt: a hitch clamps dt, and a
    // replay that loses those milliseconds lands its final kill after the music's hit (round 6: 215 ms online)
    if (r.cardWall >= 0) r.cardWall = (performance.now() - r.cardPerf) / 1000;
    if (this.hold.take() && (r.phase === "card" || r.phase === "play" || r.phase === "freeze")) {
      r.skipped = true;
      this.qa.skipped = true;
      this.setPhase(r, "fade");
      this.emit("potgEnd", { skipped: true });
    }
    // the live frame under MATCH OVER: your own body is never posed at your own lens
    const live = (): PlayerSnap[] => [...g.players.values()].filter((p) => p.id !== g.you || r.phase === "card");
    if (r.phase === "over") {
      if (r.phaseT >= OVER_S) this.setPhase(r, "dip");
      return live();
    }
    if (r.phase === "dip") {
      if (r.phaseT >= DIP_S) {
        this.setPhase(r, "card");
        r.cardWall = 0;
        const hs = this.heroSnap(r.h.id);
        if (hs) this.vignette()?.show(hs);
        // the sting on the card; the cue placed so its hit lands on the final kill (wall time from now)
        r.cardCtx = g.audio.ctx?.currentTime ?? 0;
        r.cardPerf = performance.now();
        r.hitCtx = this.sfx.potgMusic(r.musicHit);
      }
      return live();
    }
    if (r.phase === "card") {
      if (r.phaseT >= r.cardS) {
        if (r.mode === "potg") {
          this.setPhase(r, "play");
          this.vig?.hide();
        } else this.setPhase(r, "fade");
      }
      return r.mode === "potg" ? g.replayAt(r.clock, r.frames) : live();
    }
    if (r.mode !== "potg") {
      if (r.phase === "fade" && r.phaseT >= FADE_S) this.finish(r);
      return live();
    }
    let rate = 0;
    let target = r.clock;
    if (r.phase === "play") {
      // THE PLAYHEAD IS A FUNCTION OF WALL TIME since the card opened (the same table the music was placed
      // with), so the final kill lands on the music's hit to the frame — no per-phase overshoot adds up
      const w = r.cardWall - r.cardS - IN_S;
      target = this.clockAt(r, w);
      rate = w <= 0 ? 0 : this.rateAt(r, target);
      const slow = rate > 0 && rate < 0.95;
      if (slow && !r.inSlow) this.sfx.play("slowmo", { gain: 0.8 });
      r.inSlow = slow;
      // THE FREEZE: the playhead stops ON the final kill (its hit event fires this frame, the body has not fallen)
      if (target >= r.lastKill) {
        rate = 0;
        r.clock = r.lastKill;
        this.setPhase(r, "freeze");
        r.freeze = null;
        this.sfx.play("finisher", { gain: 0.9 });
        this.emit("potgFinisher", { kind: "freeze" });
        r.killCtx = g.audio.ctx?.currentTime ?? 0;
        // HIT vs KILL, on the audio clock (what is heard against what is seen). Under the capture rig's virtual
        // clock the audio clock runs on real time, so there the same check is made on the page clock instead.
        const perfIn = (performance.now() - r.cardPerf) / 1000;
        const ctxIn = r.killCtx - r.cardCtx;
        const virtual = Math.abs(perfIn - ctxIn) > 0.1;
        this.qa.hitClock = virtual ? "page" : "audio";
        this.qa.hitErrMs = r.hitCtx > 0 ? Math.round(Math.abs(virtual ? perfIn - r.musicHit : r.killCtx - r.hitCtx) * 1000) : -1;
        // the victim as they stood a beat before the hit (alive, upright): held through the freeze
        const last = r.kills[r.kills.length - 1];
        if (last?.dst) {
          // the victim's last standing pose (searched back from the kill: never a body already going down)
          r.freezeVictim = null;
          for (let back = 12; back <= 600 && !r.freezeVictim; back += 12) {
            const pre = g.replayAt(r.lastKill - back, r.frames).find((p) => p.id === last.dst);
            if (pre?.alive) r.freezeVictim = pre;
          }
        }
      }
    } else if (r.phase === "freeze") {
      rate = 0;
      if (r.phaseT >= FREEZE_S) this.setPhase(r, "fade");
    } else if (r.phase === "fade") {
      if (r.phaseT >= FADE_S) this.finish(r);
    }
    r.rate = rate;
    if (r.phase === "play") r.clock = Math.min(r.t1 + 400, Math.max(r.clock, target));
    // replay the shots and hits the playhead passed
    const pov = r.h.id;
    while (r.shotIdx < r.shots.length && r.shots[r.shotIdx]!.t <= r.clock) {
      const sh = r.shots[r.shotIdx++]!;
      g.spawnTracer(sh.ox, sh.oy, sh.oz, sh.dx, sh.dy, sh.dz, sh.src, true);
      const w = sh.weapon ?? "ar";
      if (sh.src === pov) {
        if (g.vm.root.visible) g.vm.fire();
        g.audio.gun(w, sh.ox, sh.oy, sh.oz, true);
      } else g.audio.gun(w, sh.ox, sh.oy, sh.oz, false, sh.src);
    }
    while (r.hitIdx < r.hits.length && r.hits[r.hitIdx]!.t <= r.clock) {
      const h = r.hits[r.hitIdx++]!;
      g.sparks(h.x, h.y, h.z, h.kill, h.src, h.head);
      if (h.src === pov) {
        g.hitmarker(h.head, h.kill);
        g.audio.hitmarker(h.head, h.kill);
      }
      if (h.kill && h.dst !== h.src) {
        this.overlay()!.feed(this.nameOf(h.src), this.nameOf(h.dst), this.rel(h.src), this.rel(h.dst));
        r.feedBorn.push(r.age);
        if (r.feedBorn.length > 4) r.feedBorn.shift();
        if (h.src === pov) {
          this.measureKill(r, h);
          // IN LOCKSTEP WITH THE PICTURE: the counter steps and the pop shows on the kill's own frame.
          // Kills close together share ONE pop that counts up (DOUBLE KILL, TRIPLE KILL ...) — never a queue.
          r.killsShown++;
          r.multi = r.age - r.lastPovKillAge <= POP_GAP ? r.multi + 1 : 1;
          r.lastPovKillAge = r.age;
          const name = this.nameOf(h.dst).toUpperCase();
          const text = r.multi >= 2 ? `${MULTI_POP[Math.min(r.multi, MULTI_POP.length - 1)]}  ·  ${name}` : `${h.head ? "HEADSHOT" : "ELIMINATED"}  ${name}`;
          r.pop = { text, at: r.age };
          this.qa.popLag = Math.max(this.qa.popLag, Math.abs(r.clock - h.t));
        }
      }
    }
    this.qa.kills = r.killsShown;
    const list = g.replayAt(r.clock, r.frames);
    // the freeze: the final victim stands as they did on the death frame (never a body already falling)
    if ((r.phase === "freeze" || r.phase === "fade") && r.freezeVictim) {
      const v = r.freezeVictim;
      const i = list.findIndex((p) => p.id === v.id);
      if (i >= 0) list[i] = { ...v, firing: false };
    }
    return list;
  }

  /** Animation time for the bodies this frame (the replay's own speed: slow motion slows the bodies, the freeze stops them). */
  actorDt(dt: number): number {
    const r = this.run;
    if (!r || r.mode !== "potg") return dt;
    if (r.phase === "play") return dt * (r.rate ?? 1);
    if (r.phase === "freeze" || (r.phase === "fade" && r.freeze)) return 0;
    return dt;
  }

  /** QA: the victim on screen, and big enough to read, from the replay camera. */
  private measureKill(r: Run, h: TapeHit): void {
    const g = this.g;
    const v = g.replayAt(r.clock, r.frames).find((p) => p.id === h.dst);
    if (!v) return;
    g.camera.updateMatrixWorld();
    const a = new THREE.Vector3(v.x, v.y + 0.1, v.z).project(g.camera);
    const b = new THREE.Vector3(v.x, v.y + 1.8, v.z).project(g.camera);
    const on = a.z < 1 && b.z < 1 && Math.abs((a.x + b.x) / 2) < 1 && Math.max(a.y, b.y) > -1 && Math.min(a.y, b.y) < 1;
    this.qa.killShots.push({ name: this.nameOf(h.dst), on, frac: Math.abs(b.y - a.y) / 2 });
  }

  private finish(r: Run): void {
    if (r.ended) return;
    r.ended = true;
    this.setPhase(r, "hold");
    this.vig?.hide();
    this.lens()?.setOn(false);
    document.body.classList.remove("cine-hud-off");
    this.g.vm.root.visible = false;
    this.g.whud.spectScoped = false;
    this.g.endcardUp = true;
    if (this.rim) this.rim.intensity = 0;
    if (!r.skipped) this.emit("potgEnd", { skipped: false });
    r.end();
  }

  /** draw(): the camera and the chrome for this replay frame. */
  camera(alist: PlayerSnap[], dt: number): void {
    const r = this.run!;
    const g = this.g;
    const ov = this.overlay()!;
    const lens = this.lens();
    const k = alist.find((x) => x.id === r.h.id);
    const before = r.phase === "over" || r.phase === "dip";
    const inEyes = r.mode === "potg" && (r.phase === "play" || r.phase === "freeze" || (r.phase === "fade" && !r.skipped) || r.phase === "card");
    if (inEyes && k) this.eyes(r, k, alist, dt);
    else {
      // the MATCH OVER beat and the cards sit over the last live (or killcam) frame: nothing on its lens either
      const cp = g.camera.position;
      for (const a of g.actors.values()) {
        const q = a.root.position;
        if (Math.hypot(q.x - cp.x, Math.max(q.y, Math.min(q.y + 1.8, cp.y)) - cp.y, q.z - cp.z) < 1.2) a.root.visible = false;
      }
      if (!before) {
        g.vm.root.visible = false;
        g.whud.spectScoped = false;
      }
    }
    if (lens) {
      lens.setOn(true);
      lens.aperture = before ? 2 : 0;
      lens.focus = 10;
      lens.radial = 0;
      lens.vignette = before ? 0.7 : r.phase === "freeze" ? 0.55 : 0.36;
      lens.flash = 0;
    }
    // ---- the card (the studio vignette over its own backdrop)
    // the studio is up at full strength from the card's first frame (the veil does the fade in, so the
    // replay's first frame never ghosts through it), and leaves with the fade
    const cardA = r.phase === "card" ? 1 : r.phase === "fade" && r.mode !== "potg" ? 1 - Math.min(1, r.phaseT / FADE_S) : 0;
    if (this.vig?.on) {
      this.vig.frame(dt, cardA);
      this.qa.vigFrac = this.vig.qa.frac;
      this.qa.vigFacing = this.vig.qa.facing;
      this.qa.vigFaceClear = this.vig.qa.faceClear;
      this.qa.vigGunOn = this.vig.qa.gunOn;
    }
    // ---- chrome: everything fades WITH the picture
    const out = r.phase === "fade" ? Math.min(1, r.phaseT / FADE_S) : r.phase === "hold" ? 1 : 0;
    const keep = 1 - out;
    // the card's words leave with the dip into the roll (they never hang on black)
    const slam = r.phase === "card" ? (r.mode === "potg" ? 1 - smooth(r.cardS - 0.16, r.cardS, r.phaseT) : 1) : r.phase === "fade" && r.mode !== "potg" ? keep : 0;
    const roll = r.mode === "potg" && (r.phase === "play" || r.phase === "freeze" || r.phase === "fade");
    ov.potgFrame({
      slam,
      plate: roll ? keep * (r.phase === "play" ? Math.min(1, r.phaseT / 0.3) : 1) : 0,
      progress: (r.clock - r.t0) / Math.max(1, r.t1 - r.t0),
      bars: r.phase === "hold" ? 0 : before ? Math.min(1, r.phaseT / 0.3) : 1,
      kills: r.killsShown,
      total: r.kills.filter((kk) => kk.dst).length,
      pop: r.pop && roll && r.phase !== "fade" ? { text: r.pop.text, age: r.age - r.pop.at } : null,
      feedAge: r.feedBorn.map((b) => r.age - b),
      fade: keep,
      vig: r.phase === "card" || (r.phase === "fade" && r.mode !== "potg"),
      cardT: r.phase === "card" ? r.phaseT : r.phase === "fade" && r.mode !== "potg" ? 9 : undefined,
    });
    ov.overFrame(r.phase === "over" ? Math.min(1, r.phaseT / 0.18) : r.phase === "dip" ? Math.max(0, 1 - r.phaseT / DIP_S) : 0);
    // the dip into the card, the cut in from it, the fade out
    const veil =
      r.phase === "dip" ? Math.min(1, r.phaseT / DIP_S)
      : r.phase === "card" ? Math.max(0, 1 - r.phaseT / 0.2, r.mode === "potg" ? smooth(r.cardS - 0.16, r.cardS, r.phaseT) : 0)
      : r.phase === "play" ? Math.max(0, 1 - r.phaseT / IN_S)
      : r.phase === "fade" ? out
      : r.phase === "hold" ? Math.max(0, 1 - r.phaseT / 0.5)
      : 0;
    ov.setVeil(veil);
    ov.flashA(r.phase === "freeze" ? Math.max(0, 0.14 - r.phaseT * 0.9) : 0);
    ov.skipRing(this.hold.fill(), r.phase === "fade" || r.phase === "hold" || before ? 0 : 0.85 * keep, "HOLD TO SKIP");
    if (r.phase === "hold" && r.phaseT > 0.6) ov.hide();
    // ---- QA
    this.qa.phase = r.phase;
    this.qa.povVisible = !!g.actors.get(r.h.id)?.root.visible;
    this.qa.gunVisible = g.vm.root.visible || g.whud.spectScoped;
    const f = new THREE.Vector3();
    g.camera.getWorldDirection(f);
    this.qa.pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
    this.qa.popVisible = !!r.pop && !roll && r.age - r.pop.at < 1.3;
  }

  /** THE EYES (the roll and the freeze). */
  private eyes(r: Run, k: PlayerSnap, alist: PlayerSnap[], dt: number): void {
    const g = this.g;
    const eye = k.slide > 0 ? SLIDE_EYE : k.crouch ? CROUCH_EYE : EYE;
    if (!r.aim.init) r.aim = { yaw: k.yaw, pitch: k.pitch, init: true };
    const nearKill = r.kills.some((kk) => Math.abs(r.clock - kk.t) < 280);
    const w = WEAPON_BY_ID[k.weapon];
    // THROUGH THE GLASS only around a kill: between kills a scoped player is shown wider (off the scope)
    const nearGlass = r.kills.some((kk) => r.clock > kk.t - GLASS_MS && r.clock < kk.t + GLASS_MS) || r.phase === "freeze";
    // a scoped rifle is either THROUGH THE REAL SCOPE (its painted optic, its magnification) or at the hip —
    // never the half-raised tube that reads as a hollow ring over an unmagnified view
    if (w?.scope) r.ads = nearGlass && k.ads > 0.3 ? 1 : 0;
    else {
      // a sight is shown around a kill (where the aim matters); between kills the view stays wide (hip)
      const want = nearGlass ? k.ads : Math.min(k.ads, 0.2);
      r.ads = (r.ads ?? want) + (want - (r.ads ?? want)) * (1 - Math.exp(-dt * (want > (r.ads ?? 0) ? 10 : 7)));
    }
    const ads = r.ads;
    const s = 1 - Math.exp(-dt * (nearKill ? 40 : 9));
    if (r.phase !== "freeze") {
      r.aim.yaw += angWrap(k.yaw - r.aim.yaw) * s;
      r.aim.pitch += (k.pitch - r.aim.pitch) * s;
      // the replay never stares at the sky: the look is held under 25° up
      r.aim.pitch = Math.max(-0.44, r.aim.pitch);
    }
    g.camera.position.set(k.x, k.y + eye, k.z);
    g.camera.up.set(0, 1, 0);
    g.camera.rotation.order = "YXZ";
    const scoped = !!(w?.scope && ads >= SCOPE_AT);
    let fov = scoped && w ? w.adsFov : w ? vfov() + (w.adsFov * (vfov() / 68) - vfov()) * ads : vfov();
    let yaw = r.aim.yaw;
    let pitch = r.aim.pitch;
    if (r.phase === "freeze" || (r.phase === "fade" && r.freeze)) {
      // THE PUNCH-IN: the frame holds; the lens turns a little toward the last victim and narrows until
      // they stand a quarter of the frame tall (however far they were)
      if (!r.freeze) {
        const last = r.kills[r.kills.length - 1];
        const v = r.freezeVictim ?? (last ? alist.find((p) => p.id === last.dst) : undefined);
        let yaw1 = r.aim.yaw;
        let pitch1 = r.aim.pitch;
        let fov1 = g.camera.fov;
        if (v) {
          // the victim AS SEEN from these eyes (a parapet can hide the legs): the visible span of the body is
          // FREEZE_FRAC of the frame, centred; never less than head-and-shoulders, never the whole body over 95%
          const E = new THREE.Vector3(k.x, k.y + eye, k.z);
          let lo = Infinity;
          let hi = -Infinity;
          for (let h = 0.05; h <= BODY_M + 1e-6; h += 0.125) {
            if (seg(E, new THREE.Vector3(v.x, v.y + h, v.z))) {
              lo = Math.min(lo, h);
              hi = Math.max(hi, h);
            }
          }
          if (!(hi > lo)) {
            lo = 0;
            hi = BODY_M;
          }
          if (hi - lo < 0.6) lo = Math.max(0, hi - 0.6);
          r.freezeSpan = [lo, hi];
          const dx = v.x - k.x;
          const dz = v.z - k.z;
          const dy = v.y + (lo + hi) / 2 - (k.y + eye);
          const flat = Math.hypot(dx, dz);
          const d = Math.max(0.8, Math.hypot(dx, dy, dz));
          const vy = Math.atan2(dx, dz);
          const vp = -Math.atan2(dy, flat);
          yaw1 = r.aim.yaw + angWrap(vy - r.aim.yaw);
          pitch1 = vp;
          const minFov = (2 * Math.atan(BODY_M / (2 * 0.95 * d)) * 180) / Math.PI;
          fov1 = Math.max(4, minFov, Math.min(100, (2 * Math.atan((hi - lo) / (2 * FREEZE_FRAC * d)) * 180) / Math.PI));
        }
        r.freeze = { fov0: g.camera.fov, yaw0: r.aim.yaw, pitch0: r.aim.pitch, yaw1, pitch1, fov1 };
      }
      const z = r.freeze;
      const e = 1 - Math.pow(1 - Math.min(1, (r.phase === "freeze" ? r.phaseT : FREEZE_S) / PUNCH_S), 3);
      yaw = z.yaw0 + angWrap(z.yaw1 - z.yaw0) * e;
      pitch = z.pitch0 + (z.pitch1 - z.pitch0) * e;
      fov = z.fov0 + (z.fov1 - z.fov0) * e;
      g.fov = fov;
      g.camera.fov = fov;
    } else {
      // a scoped rifle snaps between its scope's magnification and the hip (a cut, like the optic coming up)
      if (w?.scope) g.fov = fov;
      else g.fov += (fov - g.fov) * (1 - Math.exp(-14 * dt));
      g.camera.fov = g.fov;
      // THE KILL PUNCH-IN: inside each kill's slow motion the lens narrows until the victim stands at least
      // KILL_FRAC of the frame (a far kill reads; a near one is left alone), riding the slow-motion ramp
      const S = r.slowRate;
      const wk = Math.max(0, Math.min(1, (1 - this.rateAt(r, r.clock)) / Math.max(1e-3, 1 - S)));
      if (wk > 0.001) {
        let near: Kill | null = null;
        for (const kk of r.kills) if (kk.dst && (!near || Math.abs(kk.t - r.clock) < Math.abs(near.t - r.clock))) near = kk;
        const v = near ? alist.find((p) => p.id === near!.dst) : undefined;
        if (v) {
          const d = Math.max(0.8, Math.hypot(v.x - k.x, v.y + 0.9 - (k.y + eye), v.z - k.z));
          const want = (2 * Math.atan(BODY_M / (2 * KILL_FRAC * d)) * 180) / Math.PI;
          if (want < g.camera.fov) g.camera.fov = g.camera.fov + (want - g.camera.fov) * wk;
        }
      }
    }
    g.camera.rotation.set(-pitch, yaw + Math.PI, 0, "YXZ");
    g.camera.updateProjectionMatrix();
    if (!w?.scope || nearGlass) {
      if (!nearGlass && w?.scope && ads >= SCOPE_AT) this.qa.glassOutside++;
    }
    // the freeze is a picture: no gun, no scope ring (the punch-in is the lens, not the sight)
    const frozen = r.phase === "freeze" || (r.phase === "fade" && !!r.freeze);
    g.killerGun({ ...k, yaw, pitch, ads: frozen ? 0 : ads }, dt, !frozen && r.phase !== "hold");
    if (frozen) {
      g.vm.root.visible = false;
      g.whud.spectScoped = false;
    }
    // the POV's own body is the camera (game.ts reads povId before this frame's phase change)
    const self = g.actors.get(r.h.id);
    if (self) self.root.visible = false;
    // NOTHING PRESSED AGAINST THE LENS: any body inside LENS_CLEAR_M of the eye is not drawn
    let near = 0;
    for (const [id, a] of g.actors) {
      if (id === r.h.id) continue;
      const p = a.root.position;
      if (Math.hypot(p.x - k.x, p.z - k.z) < LENS_CLEAR_M && Math.abs(p.y - k.y) < 1.6) {
        a.root.visible = false;
        near++;
      }
    }
    // the freeze's victim: measured on the punched-in frame
    if (r.phase === "freeze" && r.phaseT > PUNCH_S + 0.05 && !this.qa.freezeOn) {
      const last = r.kills[r.kills.length - 1];
      const v = last ? alist.find((p) => p.id === last.dst) : undefined;
      this.qa.freezeRagdoll = !!v && !v.alive;
      if (v) {
        g.camera.updateMatrixWorld();
        const [lo, hi] = r.freezeSpan ?? [0, BODY_M];
        this.qa.freezeVisible = (hi - lo) / BODY_M;
        const a = new THREE.Vector3(v.x, v.y + lo, v.z).project(g.camera);
        const b = new THREE.Vector3(v.x, v.y + hi, v.z).project(g.camera);
        this.qa.freezeOn = a.z < 1 && Math.abs(a.x) < 1 && Math.abs(b.x) < 1;
        this.qa.freezeFrac = Math.abs(b.y - a.y) / 2;
      }
    }
    this.qa.nearLens = Math.max(this.qa.nearLens, near);
  }
}
