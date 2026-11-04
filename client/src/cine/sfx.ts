/**
 * client/src/cine/sfx.ts — the cinematics' sound.
 *
 * Generic, every map: five short cues generated with ElevenLabs Sound Effects
 * and loudness-matched to the game's own match-start sting (-18 LUFS
 * integrated, ≤ -3 dBTP; public/assets/cine/sfx/*.ogg), played on the rig's UI
 * bus at the sting's own level so MASTER / INTERFACE apply:
 *   title-hit   the map name slams in        swoop     into the eyes
 *   potg-sting  the play of the game opens   finisher  the third-person beat
 *   slowmo      under each slow-motion kill
 *
 * Katana: the audio stream's score owns the music (branch katana-v3-audio,
 * window.__katanaAudio). It is a SOFT dependency — feature-detected per call:
 *   intro start  __katanaAudio.playIntro(ctxTimeOfGO)   its title hit lands on GO,
 *                and its own offset logic seeks for a late joiner
 *   potg start   __katanaAudio.playPotg()
 * On Katana with the score present the generic title hit and stinger stand
 * down (the score carries them); the whoosh, finisher and slow-mo stay.
 */
import { assetUrl } from "../asset-base";

type Rig = { ctx: AudioContext | null; buses?: Record<string, GainNode> };
type KatanaAudio = { playIntro?: (hitAt: number) => number; playPotg?: () => void; externalIntro?: boolean };

const NAMES = ["title-hit", "swoop", "potg-sting", "finisher", "slowmo", "intro-music", "potg-music"] as const;
/** Where the hit sits inside each music cue (s) — public/assets/cine/sfx/cues.json. */
export const MUSIC_HIT: Record<string, number> = { "intro-music": 10.0, "potg-music": 6.25 };
export type CineCue = (typeof NAMES)[number];

/** The match-start sting plays at 0.42 on the UI bus; these sit on the same footing. */
const LEVEL: Record<CineCue, number> = { "title-hit": 0.5, swoop: 0.32, "potg-sting": 0.5, finisher: 0.46, slowmo: 0.3, "intro-music": 0.68, "potg-music": 0.62 };

export class CineSfx {
  private bufs = new Map<CineCue, AudioBuffer>();
  private loading: Promise<void> | null = null;
  /** For QA: every cue asked for, with the context time. */
  readonly log: { cue: string; at: number }[] = [];

  constructor(private rig: () => Rig | null) {}

  private katana(): KatanaAudio | null {
    return ((window as unknown as { __katanaAudio?: KatanaAudio }).__katanaAudio ?? null) as KatanaAudio | null;
  }

  /** True when the Katana score is present and carries the music. */
  scored(): boolean {
    return !!this.katana();
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    const ctx = this.rig()?.ctx;
    if (!ctx) return Promise.resolve();
    // the hit times: ONE source of truth, public/assets/cine/sfx/cues.json
    void fetch(assetUrl("/assets/cine/sfx/cues.json"))
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Record<string, { hit?: number }> | null) => {
        for (const k of Object.keys(MUSIC_HIT)) if (j?.[k]?.hit !== undefined) MUSIC_HIT[k] = j[k]!.hit!;
      })
      .catch(() => {});
    this.loading = Promise.all(
      NAMES.map(async (n) => {
        try {
          const r = await fetch(assetUrl(`/assets/cine/sfx/${n}.ogg`));
          if (!r.ok) return;
          this.bufs.set(n, await ctx.decodeAudioData(await r.arrayBuffer()));
        } catch {
          /* a missing cue is silence, never an error */
        }
      }),
    ).then(() => undefined);
    return this.loading;
  }

  play(cue: CineCue, opts: { gain?: number; delay?: number; rate?: number } = {}): void {
    const rig = this.rig();
    const ctx = rig?.ctx;
    this.log.push({ cue, at: ctx?.currentTime ?? 0 });
    if (!ctx) return;
    const buf = this.bufs.get(cue);
    if (!buf) {
      void this.load();
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (opts.rate) src.playbackRate.value = opts.rate;
    const g = ctx.createGain();
    g.gain.value = LEVEL[cue] * (opts.gain ?? 1);
    src.connect(g);
    g.connect(rig!.buses?.ui ?? ctx.destination);
    src.start(ctx.currentTime + (opts.delay ?? 0));
  }

  /**
   * The Katana score drives its own intro cue unless told the cinematic does
   * (its `externalIntro`): called every frame so the flag is up before the
   * score's first tick and the cue never starts twice.
   */
  claimKatana(): void {
    const ka = this.katana();
    if (ka && !ka.externalIntro) ka.externalIntro = true;
  }

  /**
   * Intro music, its hit landing on GO (`msToGo` from now). A late joiner seeks
   * into the cue. Returns true once something is playing (or nothing should).
   */
  introMusic(kind: "match" | "round", msToGo: number, totalMs: number): boolean {
    const ctx = this.rig()?.ctx;
    if (!ctx) return false;
    const ka = this.katana();
    if (kind === "round") return true; // round starts: the Katana score plays its own snd_round; elsewhere the beats
    if (ka?.playIntro) {
      ka.externalIntro = true;
      this.log.push({ cue: "katana:intro", at: ctx.currentTime });
      try {
        ka.playIntro(ctx.currentTime + msToGo / 1000);
      } catch (e) {
        console.warn("[cine] katana intro cue failed", e);
      }
      return true;
    }
    if (this.onKatanaMap && totalMs - msToGo < 1500) return false; // give the score module a moment to attach
    return this.playMusic("intro-music", msToGo / 1000);
  }

  /** The intro's music carries the GO hit (the generic cue's hit is on GO; the Katana score's title hit is on GO). */
  goByMusic(kind: "match" | "round"): boolean {
    if (kind === "round") return false;
    if (this.katana()?.playIntro) return true;
    return this.musicPlaying;
  }

  /** Set by Cine: on Katana the score is expected (the capture fails a Katana run that logs no-score). */
  onKatanaMap = false;

  /**
   * POTG music, its hit landing EXACTLY `hitInS` from now (the final kill's frame). Returns the ctx time
   * of the hit (0 when nothing could be scheduled). Any distance works: a short play seeks into the cue,
   * a long one EXTENDS the cue's steady head (crossfaded repeats of its opening bed) so the build and
   * the hit still land where the kill is — never a late or early hit, never a dead start.
   */
  potgMusic(hitInS: number, _replay = true): number {
    // the card's reveal always gets its sting
    this.play("potg-sting", { gain: 0.8 });
    const rig = this.rig();
    const ctx = rig?.ctx;
    const buf = this.bufs.get("potg-music");
    if (!ctx || !buf) {
      void this.load();
      return 0;
    }
    const HIT = MUSIC_HIT["potg-music"]!;
    // the hit is placed against the audio clock NOW; every voice starts a 20 ms scheduling lead later
    const now0 = ctx.currentTime;
    const hitAt = now0 + hitInS;
    const now = now0 + 0.02;
    const out = rig!.buses?.ui ?? ctx.destination;
    const level = LEVEL["potg-music"];
    const voice = (at: number, offset: number, dur: number | null, fadeIn: number, fadeOut: number): void => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.setValueAtTime(fadeIn > 0 ? 0 : level, at);
      if (fadeIn > 0) g.gain.linearRampToValueAtTime(level, at + fadeIn);
      if (dur !== null && fadeOut > 0) {
        g.gain.setValueAtTime(level, at + dur - fadeOut);
        g.gain.linearRampToValueAtTime(0, at + dur);
      }
      src.connect(g);
      g.connect(out);
      src.start(at, Math.max(0, offset));
      if (dur !== null) src.stop(at + dur + 0.01);
    };
    if (hitInS <= HIT - 0.02) {
      // seek in: the hit lands hitInS from now
      const off = HIT - hitInS + 0.02;
      voice(now, off, null, off > 0.05 ? 0.25 : 0, 0);
      this.log.push({ cue: `music:potg-music@${off.toFixed(2)}`, at: ctx.currentTime });
    } else {
      // extend the head: the cue's opening bed [HEAD_A, HEAD_B] repeated (equal-gain crossfades), then the
      // cue from HEAD_A runs through its build into the hit
      const HEAD_A = 0.6;
      const HEAD_B = 2.8;
      const XF = 0.35;
      const tail = HIT - HEAD_A; // seconds the last voice needs before the hit
      const lastAt = hitAt - tail;
      let t = now;
      let off = 0;
      let n = 0;
      while (t < lastAt - 0.05 && n < 12) {
        const len = Math.min(HEAD_B - off, lastAt - t + XF);
        voice(t, off, len, n === 0 ? 0 : XF, XF);
        t += len - XF;
        off = HEAD_A;
        n++;
      }
      voice(lastAt, HEAD_A, null, n ? XF : 0, 0);
      this.log.push({ cue: `music:potg-music@ext${(hitInS - HIT).toFixed(2)}`, at: ctx.currentTime });
    }
    this.log.push({ cue: `potg-hit@${hitAt.toFixed(3)}`, at: ctx.currentTime });
    return hitAt;
  }

  private playMusic(cue: "intro-music" | "potg-music", hitInS: number): boolean {
    const rig = this.rig();
    const ctx = rig?.ctx;
    const buf = this.bufs.get(cue);
    if (!ctx || !buf) {
      void this.load();
      return false;
    }
    const offset = MUSIC_HIT[cue]! - hitInS;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = LEVEL[cue];
    src.connect(g);
    g.connect(rig!.buses?.ui ?? ctx.destination);
    if (offset >= 0) {
      if (offset > 0.05) {
        // a late joiner: in at the right bar, with a short fade
        g.gain.setValueAtTime(0, ctx.currentTime);
        g.gain.linearRampToValueAtTime(LEVEL[cue], ctx.currentTime + 0.3);
      }
      src.start(ctx.currentTime, Math.min(offset, buf.duration - 0.05));
    } else src.start(ctx.currentTime - offset);
    this.log.push({ cue: `music:${cue}@${offset.toFixed(2)}`, at: ctx.currentTime });
    if (cue === "intro-music") this.musicPlaying = true;
    src.onended = () => {
      if (cue === "intro-music") this.musicPlaying = false;
    };
    return true;
  }

  /** The title card's hit — only when no music carries the accent (it doubled the cue's own). */
  titleHit(): void {
    if (!this.scored() && !this.musicPlaying) this.play("title-hit");
  }
  musicPlaying = false;
}
