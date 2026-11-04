/**
 * client/src/cine/index.ts — CINE: the match-start intro and the play of the game.
 * ===========================================================================
 *
 * One object on the Game (`game.cine`), hooked in with a handful of lines:
 *
 *   draw()          cine.frame(dt) right after the first-person camera is placed
 *                   (the intro overrides that camera and lands back on it);
 *                   cine.potgTick / potgCamera beside the final killcam's branch;
 *                   bodies the replay uses are never reaped
 *   recordFrame()   cine.tape.frame(...) — the whole-match tape, same frames
 *   handleEvents()  cine.events(ev) — tape shots/hits, the offline highlight
 *                   recorder, rematch resets
 *   finish()        cine.wrapEnd(end) — the play of the game runs before the
 *                   endcard and REPLACES the final killcam (willPlay())
 *   connect()       cine.announce(msg) for the server's { t: "potg" }
 *   paintHud()      numeralLeft() keeps the 3-2-1 card off the flythrough; the
 *                   weapon HUD stays in spectator mode under the replay (scope)
 *
 * MUSIC / AUDIO HOOKS. `cine.on(name, fn)` and a window CustomEvent "kod:cine"
 * (detail.type = name) for every beat:
 *   introStart { kind: "match"|"round", totalMs, offsetMs }   offsetMs > 0 = joined mid-intro
 *   titleBeat  { atMs }        introSwoop { skipped }        introSkip { mode }
 *   introEnd   {}              potgStart { highlight, durationS, cardOnly }
 *   potgFinisher { kind: "freeze" }  potgEnd { skipped }   (potgStart { mvp: true } = the MATCH MVP card)
 * The sound itself is cine/sfx.ts (generic cues on every map; the Katana score
 * via window.__katanaAudio when present).
 */
import * as THREE from "three";
import { activeMap } from "@shared/maps";
import { INTERP_MS, type NetEvent, type PlayerSnap } from "@shared/protocol";
import { SKIP_HOLD_MS, numeralLeft, type IntroKind } from "@shared/cine";
import { HighlightRecorder, losFromTrace, type Highlight } from "@shared/highlights";
import { traceWorld } from "@shared/map";
import { MatchTape } from "./match-tape";
import { CineOverlay } from "./overlay";
import { CineLens } from "./lens";
import { CineSfx } from "./sfx";
import { IntroDirector } from "./intro";
import { PotgDirector } from "./potg";
import { HoldSkip, type Host } from "./host";
import { loadCine, shotProblems } from "./shots";
import { heroShotStats, rayDist, toBounds } from "./framing";

const MAP = activeMap();
type Listener = (detail: Record<string, unknown>) => void;

export class Cine {
  readonly tape = new MatchTape();
  readonly recorder = new HighlightRecorder(losFromTrace(traceWorld));
  readonly sfx: CineSfx;
  readonly intro: IntroDirector;
  readonly potg: PotgDirector;
  private overlay: CineOverlay | null = null;
  private lens: CineLens | null = null;
  private hold = new HoldSkip(SKIP_HOLD_MS);
  private rim: THREE.PointLight | null = null;
  /** The announced (or locally picked) play, waiting for the match to end. */
  private announced: Highlight | null = null;
  private waitEnd: { end: () => void; until: number } | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(private g: Host) {
    this.sfx = new CineSfx(() => this.g.audio);
    const emit = (t: string, d: Record<string, unknown> = {}): void => this.emit(t, d);
    this.intro = new IntroDirector(g, () => this.overlay, () => this.lens, this.sfx, emit, this.hold);
    this.potg = new PotgDirector(g, () => this.overlay, () => this.lens, this.sfx, emit, this.hold);
    (window as unknown as { __cine: unknown }).__cine = {
      cine: this,
      /** The current camera as a keyframe: pos, a look point 20 m ahead, fov. */
      pose: () => {
        const c = this.g.camera;
        const f = c.getWorldDirection(new THREE.Vector3()).multiplyScalar(20).add(c.position);
        const r = (n: number): number => Math.round(n * 100) / 100;
        return { pos: [r(c.position.x), r(c.position.y), r(c.position.z)], look: [r(f.x), r(f.y), r(f.z)], fov: r(c.fov) };
      },
      /** Preview the intro on the spot without a countdown (dev / capture). */
      play: (kind: IntroKind = "match") => this.intro.preview(kind),
      reload: async () => (this.intro.file = await loadCine(MAP)),
      file: () => this.intro.file,
      problems: () => (this.intro.file ? shotProblems(MAP, this.intro.file.shots) : []),
      potg: () => this.announced,
      tape: () => ({ frames: this.tape.length, bytes: this.tape.usedBytes, span: this.tape.span }),
      potgRun: () => {
        const r = this.potg.run;
        return r ? { phase: r.phase, mode: r.mode, clock: r.clock, t0: r.t0, t1: r.t1, id: r.h.id, cardOnly: r.mode !== "potg", dur: r.dur } : null;
      },
      introRun: () => {
        const r = this.intro.run;
        return r ? { kind: r.kind, total: r.total, left: r.lastLeft, skip: r.skip ? r.skip.at : null, phase: this.intro.phase, hero: !!r.shot } : null;
      },
      /** Sightlines from your eye every 10° (yaw, metres to a collider / the map edge). */
      scan: () => {
        const me = this.g.me();
        if (!me) return [];
        const eye = new THREE.Vector3(me.x, me.y + 1.62, me.z);
        const out: [number, number, number][] = [];
        for (let i = 0; i < 36; i++) {
          const y = (i / 36) * Math.PI * 2;
          const d = new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
          out.push([+y.toFixed(2), +rayDist(eye, d, 60).toFixed(1), +toBounds(eye, d).toFixed(1)]);
        }
        return out;
      },
      /** Dev / QA: the studio card on you, held (qa/cine/card.mjs). */
      card: (holdS = 4) => this.potg.previewCard(holdS),
      /** Hold-to-skip, programmatically (QA). */
      holdSkip: () => this.hold.press(),
      qa: () => ({ heroStats: { ...heroShotStats }, intro: { ...this.intro.qa, phase: this.intro.phase }, potg: { ...this.potg.qa }, sfx: this.sfx.log.slice(-80) }),
    };
  }

  /** After Game.init(): the composer, the camera and the scene exist. */
  async init(): Promise<void> {
    if (!this.overlay) this.overlay = new CineOverlay();
    if (!this.lens && this.g.composer) this.lens = new CineLens(this.g.composer, this.g.camera, !!this.g.depth?.floatDepth);
    // a dedicated cool rim light, in the scene from boot (a light added mid-match recompiles every lit material)
    if (!this.rim && this.g.world) {
      this.rim = new THREE.PointLight(0xcfe0ff, 0, 4.2, 2);
      this.rim.name = "cine-rim";
      this.g.world.scene.add(this.rim);
      this.intro.rim = this.rim;
      this.potg.rim = this.rim;
      const key = new THREE.PointLight(0xffe6cc, 0, 8, 2);
      key.name = "cine-key";
      this.g.world.scene.add(key);
      this.intro.key = key;
    }
    this.sfx.onKatanaMap = MAP.id === "katana";
    if (!this.intro.file) this.intro.file = await loadCine(MAP);
    void this.sfx.load();
  }

  on(name: string, fn: Listener): void {
    let l = this.listeners.get(name);
    if (!l) this.listeners.set(name, (l = []));
    l.push(fn);
  }

  private emit(type: string, detail: Record<string, unknown> = {}): void {
    for (const f of this.listeners.get(type) ?? []) {
      try {
        f(detail);
      } catch (e) {
        console.error(e);
      }
    }
    window.dispatchEvent(new CustomEvent("kod:cine", { detail: { type, ...detail } }));
  }

  // ------------------------------------------------------------ hooks game.ts reads

  get selfBody(): boolean {
    return this.intro.selfBody;
  }
  get hideOverlays(): boolean {
    return this.intro.hideOverlays;
  }
  /** True while a cinematic owns the screen (main.ts: no pause menu over it). */
  busy(): boolean {
    return this.potg.busy() || this.intro.busy();
  }
  matchStartMs(): number {
    return this.intro.matchStartMs();
  }
  numeralLeft(left: number): number {
    return numeralLeft(left);
  }
  private feelWrap: { a: unknown; w: { countBeat(b: number): void; countGo(): void; resupply(): void; recovered(): void } } | null = null;
  /**
   * The 3-2-1's audio for matchfeel: while the intro owns GO (its music's hit, or its one cue on the audio
   * clock) the HUD's own GO cue stands down — exactly ONE sound on GO, never a flam of two clocks.
   */
  feelAudio<T extends { countBeat(b: number): void; countGo(): void; resupply(): void; recovered(): void }>(a: T): T | { countBeat(b: number): void; countGo(): void; resupply(): void; recovered(): void } {
    if (performance.now() > this.intro.goOwnedUntil) return a;
    if (!this.feelWrap || this.feelWrap.a !== a) this.feelWrap = { a, w: { countBeat: (b) => a.countBeat(b), countGo: () => this.sfx.log.push({ cue: "count-go:suppressed", at: 0 }), resupply: () => a.resupply(), recovered: () => a.recovered() } };
    return this.feelWrap.w;
  }
  get potgOn(): boolean {
    return this.potg.on;
  }
  potgPovId(): string {
    return this.potg.povId();
  }
  potgTick(dt: number): PlayerSnap[] {
    return this.potg.tick(dt);
  }
  /** game.ts's actor loop: the bodies to pose this frame (the intro's squad idles; otherwise as given). */
  posed(list: PlayerSnap[]): PlayerSnap[] {
    return this.intro.posed(list);
  }
  potgCamera(alist: PlayerSnap[], dt: number): void {
    this.potg.camera(alist, dt);
  }

  frame(dt: number): void {
    if (!this.intro.disabled) this.sfx.claimKatana();
    this.intro.frame(dt, this.potg.on);
  }

  // ------------------------------------------------------------ events

  /** Every event batch handleEvents() sees (online and offline). */
  events(ev: readonly NetEvent[]): void {
    const g = this.g;
    const t = g.renderT * 1000 + (g.session ? 0 : INTERP_MS);
    for (const e of ev) {
      if (e.t === "shot") this.tape.shot({ t, ox: e.ox, oy: e.oy, oz: e.oz, dx: e.dx, dy: e.dy, dz: e.dz, src: e.src, weapon: e.weapon });
      else if (e.t === "hit") this.tape.hit({ t, src: e.src, dst: e.dst, head: e.head, kill: e.kill, x: e.x, y: e.y, z: e.z });
      else if (e.t === "match" && e.state === "live") {
        // a new match on this page (24/7 rollover, a lobby's next START)
        this.stopPotg();
        this.tape.reset();
        this.announced = null;
      }
    }
    // OFFLINE THE LOCAL SESSION IS THE AUTHORITY: score it here, exactly as server/cine.ts does online.
    if (g.session) this.recorder.observe(g.session as never, ev);
  }

  /** The server's { t: "potg" }. */
  announce(msg: unknown): void {
    const m = msg as Highlight & { t?: string };
    if (!m || typeof m.id !== "string" || !Number.isFinite(m.t0) || !Number.isFinite(m.t1)) return;
    this.announced = { id: m.id, name: String(m.name ?? ""), team: Number(m.team ?? 0), t0: m.t0, t1: m.t1, keys: Array.isArray(m.keys) ? m.keys.map(Number) : [], score: Number(m.score ?? 0), title: String(m.title ?? ""), line: String(m.line ?? ""), tags: Array.isArray(m.tags) ? m.tags.map(String) : [] };
  }

  /** The play of the game for this match (offline: picked now from the local recorder). */
  private chosen(): Highlight | null {
    const g = this.g;
    if (g.testMode || this.intro.disabled) return null;
    if (g.session && !this.announced) {
      this.recorder.endAt = g.session.time;
      this.announced = this.recorder.pick();
    }
    return this.announced;
  }

  /** finish(): a play of the game will run, so the final killcam stands down. */
  willPlay(): boolean {
    return !!this.chosen();
  }

  /**
   * finish(): the cinematics own the END — ONE sequence: MATCH OVER → the play of the game (any match
   * with a kill) or the MATCH MVP card (a match without one) → the endcard. The old final killcam never
   * plays in front of it (round 5 stacked ~22 s of endings that way).
   */
  ownsEnd(): boolean {
    return !this.g.testMode && !this.intro.disabled;
  }

  /** game.ts's actor loop: animation time for the replayed bodies (slow motion, the freeze). */
  potgActorDt(dt: number): number {
    return this.potg.actorDt(dt);
  }

  /** finish(): the endcard waits for the play of the game. */
  wrapEnd(end: () => void): () => void {
    // Deferred to the next tick(): end() can be called from inside the final
    // killcam's own frame, which must finish drawing before the cut is replaced.
    return () => {
      if (this.g.testMode || this.intro.disabled) return end();
      // the endcard is NOT up yet (Nuketown's nuke and the Katana stinger key off it)
      this.g.endcardUp = false;
      // online the server announces the play BEFORE the finale snapshot; a short grace covers a late packet
      this.waitEnd = { end, until: performance.now() + (this.g.session ? 0 : 350) };
    };
  }

  /** A play of the game / MVP card ran for this match (Nuketown's nuke then keeps the endcard up over it). */
  get endPlayed(): boolean {
    return this.potg.played;
  }

  private startPotg(h: Highlight, end: () => void): void {
    this.intro.end();
    const covered = this.tape.covers(h.t0 * 1000, h.t1 * 1000, h.id);
    this.potg.start(h, covered ? this.tape.clip(h.t0 * 1000, h.t1 * 1000) : null, end);
  }

  stopPotg(): void {
    this.waitEnd = null;
    this.potg.stop();
  }

  /** Per frame from draw(): deferred endcards waiting on a (late) announcement. */
  tick(): void {
    const w = this.waitEnd;
    if (!w) return;
    const h = this.chosen();
    if (h) {
      this.waitEnd = null;
      this.startPotg(h, w.end);
    } else if (performance.now() > w.until) {
      // no play cleared the floor: the MATCH MVP card (when anybody scored at all), else straight to the endcard
      this.waitEnd = null;
      this.intro.end();
      if (!this.potg.startMvp(w.end)) w.end();
    }
  }

  /** New boot / leaving: drop everything. */
  reset(): void {
    this.stopPotg();
    this.intro.end();
    this.tape.reset();
    this.recorder.reset();
    this.announced = null;
    this.intro.forced = null;
  }
}
