/**
 * client/src/katana-audio.ts — KATANA v3: the score and the rain (Katana map only).
 * ===========================================================================
 *
 * One module, attached by game.ts exactly like nuketown-live.ts (it wraps
 * world.update for its per-frame tick and listens on game.worldEvents for
 * shots and blasts). Everything it plays goes through the game's own rig
 * (audio2.ts): the music into the master stage (`rig.master`, so MASTER
 * applies; MUSIC is applied by the module itself via musicBus — see the
 * constructor note) under SETTINGS → AUDIO → MUSIC, the ambience into the rig's
 * AMBIENCE bus (so its slider and the weapons' own-fire duck apply). Nothing
 * here touches another map: game.ts only imports it when MAP.id === "katana".
 *
 * ASSETS (public/assets/audio/katana/, built by scripts/katana-audio/): every
 * file is loudness-normalised (manifest.json: lufs_i ≈ −23), Ogg Opus with an
 * AAC .m4a fallback, lazy-loaded after the world is up. MIX below is the only
 * place levels live.
 *
 * THE SCORE. 80 BPM everywhere, D minor, a bar is 3 s.
 *   intro     12 s, its title hit (manifest hits[0], ≈9 s) lands on GO when a
 *             countdown is running, or wherever the cinematic intro asks
 *             (window.__katanaAudio.intro(atCtxTime)).
 *   bed       four 48 s loops cut on one grid (calm / tension / combat / final)
 *             that always play in sync; only their gains move. Intensity
 *             (shots heard near you, your own fire, damage taken, enemies
 *             close) drives calm → tension → combat with hysteresis and a dwell
 *             time, so it never flaps. The final minute (or match point)
 *             swaps the stack for the final layer.
 *   S&D       snd_round on every round start; the bomb cue is EXACTLY the
 *             45 s fuse, started at (45 − fuse) so its climax is the
 *             detonation, cut on defuse.
 *   end       win / lose stinger on the endcard; the potg cue under a final
 *             killcam / play of the game.
 *   menu      katanaMenuMusic(true|false) for the lobby (its own context until
 *             the rig exists).
 *
 * DUCKING. Shots heard in the last ~1.2 s (yours count full, others by
 * distance) pull the music down up to 6 dB and the ambience up to 3 dB; the
 * announcer's voice pulls the music 6 dB. Attack 60 ms, release ~0.9 s.
 *
 * THE RAIN. A global open-air rain bed, plus roof drumming that takes over
 * under a roof: every 0.2 s one ray straight up (traceWorld, the bullets' own
 * colliders, plus any authored shelter boxes in emitters.json) says "roof",
 * and eight 6 m horizontal rays say how enclosed you are (7 of 8 blocked = indoors). Under an eave the
 * open rain drops and the roof drums; indoors both go through a low-pass and
 * every outdoor emitter is muffled. Emitters (koi pond, gutters, neon hum,
 * bamboo, shishi-odoshi, temple bell…) are DATA: emitters.json, positions in
 * world metres, edited by the level designer without touching code.
 */
import type { Game } from "./game";
import type { AudioRig2 } from "./audio2";
import { traceWorld } from "@shared/map";
import { modeInfo } from "@shared/modes";
import { activeMap } from "@shared/maps";
import { assetUrl } from "./asset-base";
import { onPrefs, prefs } from "./ui/prefs";

const BASE = "/assets/audio/katana/";
const FUSE_S = 45;

// ------------------------------------------------------------------ the mix

/**
 * Every level, in dB on top of the loudness-normalised file (manifest lufs_i). Calibrated against the rig's own
 * 12-player firefight render (audio2.renderWeaponStress, MASTER 0.85: −19 LUFS integrated, measured in the game by
 * scripts/katana-audio/ingame.mjs) at the default MUSIC 0.7 / AMBIENCE 0.8. What a player hears (LUFS):
 *   firefight −19 · intro −24 · potg/win −25 · combat bed −28.5 (−33 while the guns duck it) · final −28 ·
 *   tension −31 · calm −33 · rain bed −35 · roof drumming −34 · a koi pond at arm's length −34 · menu −21.5.
 * So the score sits ~10 LU under a firefight and is pulled 4.5 dB further under heavy fire: it is felt, never
 * fought; and the explore bed sits at the rain's level, a texture rather than a song.
 */
export const MIX = {
  /** music master into rig.master (× MUSIC here on musicBus, × MASTER on the rig) */
  music: 3,
  layer: { calm: -5.5, tension: -3.5, combat: -1, final: -0.5 },
  intro: 0,
  sndRound: 0,
  bomb: -1,
  win: 0,
  lose: -1,
  potg: 0,
  /** the menu loop plays alone on its own context (no rig, no limiter): × MASTER × MUSIC */
  menu: 6,
  /** ambience into the rig's amb bus (bus 0.5 × SETTINGS AMBIENCE) */
  rainOpen: 3,
  rainRoof: 4,
  thunder: 2,
  /** emitter types: asset + level; an emitter's own `gain` (dB) adds on top */
  types: {
    rain_slate: { asset: "rain_slate", db: 3, loop: true },
    rain_water: { asset: "rain_water", db: 4, loop: true },
    gutter: { asset: "gutter", db: 4, loop: true },
    bamboo_wind: { asset: "bamboo_wind", db: 2, loop: true },
    koi_pond: { asset: "koi_pond", db: 4, loop: true },
    neon_hum: { asset: "neon_hum", db: -4, loop: true },
    far_town: { asset: "far_town", db: 6, loop: true },
    river: { asset: "river", db: 3, loop: true },
    wind: { asset: "wind", db: 0, loop: true },
    shishi_odoshi: { asset: "shishi_odoshi", db: 2, loop: false, every: [16, 30] as [number, number] },
    temple_bell: { asset: "temple_bell", db: 0, loop: false, every: [55, 110] as [number, number] },
  } as Record<string, { asset: string; db: number; loop: boolean; every?: [number, number] }>,
  duck: { gunMusicDb: -4.5, gunAmbDb: -3, voiceMusicDb: -6, voiceAmbDb: -1.5 },
  /**
   * Footsteps: dB against the rig's own synth stone step (each recorded voice is RMS-matched to it first, so the
   * game's footstep mix rules (footsteps.ts) keep working unchanged). Gravel sits 2 dB under stone: it is the
   * most-walked floor on the map and a crunch tires the ear fastest.
   */
  steps: { gravel: -2, water: 0, wood: 0, hard: 0, tile: -1 } as Record<string, number>,
};

const db = (d: number): number => Math.pow(10, d / 20);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ------------------------------------------------------------------ data

export type AssetInfo = { id: string; kind: string; secs: number; samples48k: number; loop: boolean; hits?: number[]; slices?: [number, number][] };
type Manifest = { assets: Record<string, AssetInfo> };
export type EmitterDef = {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  /** audible radius, metres: full level inside radius × 0.2, silent at radius */
  radius: number;
  /** dB on top of the type's level */
  gain?: number;
  /** one-shots: seconds between plays [min, max] (overrides the type's) */
  every?: [number, number];
  area?: string;
  placeholder?: boolean;
};
export type ShelterDef = { id: string; x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw?: number; kind: "eave" | "indoor" };
type EmitterFile = { emitters: EmitterDef[]; shelters?: ShelterDef[] };

// ------------------------------------------------------------------ loading

class Loader {
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  private ext: ("ogg" | "m4a")[];
  constructor(private ctx: BaseAudioContext, private manifest: Manifest) {
    const probe = typeof Audio !== "undefined" ? new Audio() : null;
    const opus = !!probe && probe.canPlayType('audio/ogg; codecs="opus"') !== "";
    this.ext = opus ? ["ogg", "m4a"] : ["m4a", "ogg"];
  }
  info(id: string): AssetInfo | undefined {
    return this.manifest.assets[id];
  }
  get(id: string): Promise<AudioBuffer | null> {
    let p = this.cache.get(id);
    if (!p) {
      p = this.load(id);
      this.cache.set(id, p);
    }
    return p;
  }
  private async load(id: string): Promise<AudioBuffer | null> {
    const info = this.manifest.assets[id];
    if (!info) return null;
    for (const ext of this.ext) {
      try {
        const r = await fetch(assetUrl(`${BASE}${id}.${ext}`));
        if (!r.ok) continue;
        const buf = this.trimPriming(await this.ctx.decodeAudioData(await r.arrayBuffer()), info);
        if (info.loop) smoothWrap(buf);
        return buf;
      } catch {
        /* try the other codec */
      }
    }
    console.warn(`[katana-audio] could not load ${id}`);
    return null;
  }
  /**
   * A decoder that ignores the AAC edit list hands back the encoder's priming at the head: the buffer is longer
   * than the manifest's exact length. Drop the difference from the front so loops wrap on the sample and hits
   * land where the manifest says.
   */
  private trimPriming(buf: AudioBuffer, info: AssetInfo): AudioBuffer {
    const want = Math.round((info.samples48k * buf.sampleRate) / 48000);
    const extra = buf.length - want;
    if (extra <= 16 || extra > buf.sampleRate * 0.2) return buf;
    const out = new AudioBuffer({ length: want, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(extra, extra + want), c);
    return out;
  }
}

/**
 * The loop's wrap, made continuous on the sample: the first 4 ms ramp in from the buffer's last sample. The files'
 * seams are measured clean (qc.py), but an AAC decode leaves a codec-edge step at the wrap (jump up to 4.5x the
 * file's own p95 sample step); this removes it inaudibly, and is a no-op on an already continuous Opus wrap.
 */
function smoothWrap(buf: AudioBuffer): void {
  const n = Math.min(Math.round(buf.sampleRate * 0.004), buf.length >> 2);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const last = d[d.length - 1]!;
    for (let i = 0; i < n; i++) {
      const w = i / n;
      d[i] = d[i]! * w + last * (1 - w);
    }
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(assetUrl(path));
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** One playing cue: a source and its own gain, stoppable with a fade. */
class Voice {
  constructor(private ctx: BaseAudioContext, public src: AudioBufferSourceNode, public gain: GainNode) {}
  stop(fade = 0.4): void {
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + fade);
    try {
      this.src.stop(t + fade + 0.05);
    } catch {
      /* not started / already stopped */
    }
  }
}

function playBuffer(ctx: BaseAudioContext, buf: AudioBuffer, dest: AudioNode, opts: { at?: number; offset?: number; gain?: number; loop?: boolean; fadeIn?: number } = {}): Voice {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = !!opts.loop;
  const g = ctx.createGain();
  const at = Math.max(ctx.currentTime, opts.at ?? ctx.currentTime);
  const level = opts.gain ?? 1;
  if (opts.fadeIn) {
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + opts.fadeIn);
  } else g.gain.value = level;
  src.connect(g).connect(dest);
  const offset = opts.offset ?? 0;
  src.start(at, opts.loop ? offset % buf.duration : Math.min(offset, buf.duration - 0.01));
  src.onended = () => {
    try {
      src.disconnect();
      g.disconnect();
    } catch {
      /* gone */
    }
  };
  return new Voice(ctx, src, g);
}

// ------------------------------------------------------------------ the score

type Layer = "calm" | "tension" | "combat" | "final";
const LAYERS: Layer[] = ["calm", "tension", "combat", "final"];

class Bed {
  voices: Partial<Record<Layer, Voice>> = {};
  running = false;
  constructor(private ctx: BaseAudioContext, private out: AudioNode, private load: Loader) {}
  async start(at: number, initial: Partial<Record<Layer, number>>, fadeIn = 2): Promise<void> {
    if (this.running) return;
    this.running = true;
    const bufs = await Promise.all(LAYERS.map((l) => this.load.get(`bed_${l}`)));
    if (!this.running) return;
    const t = Math.max(at, this.ctx.currentTime + 0.05);
    LAYERS.forEach((l, i) => {
      const b = bufs[i];
      if (!b) return;
      // every layer starts on the same sample: one grid, one loop length
      this.voices[l] = playBuffer(this.ctx, b, this.out, { at: t, loop: true, gain: (initial[l] ?? 0) * db(MIX.layer[l]), fadeIn });
    });
  }
  /** Move each layer toward its target (0..1) with a time constant: fast up, slow down. */
  steer(target: Record<Layer, number>, up = 0.5, down = 1.6): void {
    const t = this.ctx.currentTime;
    for (const l of LAYERS) {
      const v = this.voices[l];
      if (!v) continue;
      const g = target[l] * db(MIX.layer[l]);
      const p = v.gain.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.setTargetAtTime(g, t, g > p.value ? up : down);
    }
  }
  stop(fade = 1.5): void {
    this.running = false;
    for (const l of LAYERS) this.voices[l]?.stop(fade);
    this.voices = {};
  }
}

export type MusicState = "idle" | "intro" | "bed" | "bomb" | "round-end" | "end" | "potg";

// ------------------------------------------------------------------ ambience

type LiveEmitter = { def: EmitterDef; voice: Voice | null; pan: PannerNode | null; lp: BiquadFilterNode | null; next: number; loading: boolean };

function inShelter(s: ShelterDef, x: number, y: number, z: number): boolean {
  const c = Math.cos(-(s.yaw ?? 0));
  const n = Math.sin(-(s.yaw ?? 0));
  const dx = x - s.x;
  const dz = z - s.z;
  const lx = dx * c - dz * n;
  const lz = dx * n + dz * c;
  return Math.abs(lx) <= s.sx / 2 && Math.abs(lz) <= s.sz / 2 && y >= s.y - s.sy / 2 && y <= s.y + s.sy / 2;
}

// ------------------------------------------------------------------ the module

export class KatanaAudio {
  ctx: AudioContext;
  load!: Loader;
  musicBus: GainNode;
  musicDuck: GainNode;
  ambBus: GainNode;
  ambDuck: GainNode;
  bed: Bed | null = null;
  state: MusicState = "idle";
  emitters: LiveEmitter[] = [];
  shelters: ShelterDef[] = [];
  /** 0 open sky, 1 fully: under a roof (eave) / enclosed (indoor) — smoothed */
  shelter = { roof: 0, indoor: 0 };
  intensity = 0;
  layerState: "calm" | "tension" | "combat" = "calm";
  private layerSince = 0;
  finalOn = false;
  /** QA / other segments: force intensity (0..1) or null */
  override: number | null = null;
  /** set by the cinematic-intro segment when it drives the intro itself */
  externalIntro = false;
  /** the last cue started (QA reads it) */
  lastCue = "";

  private shots: { t: number; w: number }[] = [];
  private lastHp = 100;
  private hurtAt = -1e9;
  private myShotAt = -1e9;
  private rainOpen: { v: Voice; lp: BiquadFilterNode } | null = null;
  private rainRoof: { v: Voice; lp: BiquadFilterNode } | null = null;
  private lp: BiquadFilterNode;
  private shelterT = 0;
  private nextThunder = 0;
  private wasEnded = false;
  private wasEndcard = false;
  private wasFkc = false;
  private wasLive = false;
  private sawCountdown = false;
  private introVoice: Voice | null = null;
  private bombVoice: Voice | null = null;
  private bombSite: string | null = null;
  private roundN = -1;
  private roundState = "";
  private oneShots: Voice[] = [];
  private unPrefs: (() => void) | null = null;
  private ready = false;

  constructor(private game: Game, private rig: AudioRig2) {
    const ctx = rig.ctx!;
    this.ctx = ctx;
    this.musicBus = ctx.createGain();
    this.musicDuck = ctx.createGain();
    this.lp = ctx.createBiquadFilter(); // the whole score's "muffle" (spectating the dead / pause): unused = open
    this.lp.type = "lowpass";
    this.lp.frequency.value = 20000;
    // Port-Anpassung: unsere AudioRig2 stellt `pre` nicht als Feld bereit (nur intern in buildGraph);
    // `master` ist die gleiche Stufe (MASTER wirkt, MUSIC regelt das Modul selbst ueber musicBus).
    this.musicBus.connect(this.lp).connect(this.musicDuck).connect(rig.master ?? rig.buses.ui);
    this.ambBus = ctx.createGain();
    this.ambDuck = ctx.createGain();
    this.ambBus.connect(this.ambDuck).connect(rig.buses.amb);
    this.unPrefs = onPrefs((p) => {
      this.musicBus.gain.value = db(MIX.music) * (p.music ?? 0.7);
    });
    this.nextThunder = ctx.currentTime + 40 + Math.random() * 60;
  }

  async init(): Promise<void> {
    const manifest = await fetchJson<Manifest>(`${BASE}manifest.json`);
    if (!manifest) {
      console.warn("[katana-audio] no manifest — the map plays without its score");
      return;
    }
    this.load = new Loader(this.ctx, manifest);
    const em = await fetchJson<EmitterFile>(`${BASE}emitters.json`);
    this.shelters = em?.shelters ?? [];
    this.emitters = (em?.emitters ?? []).map((def) => ({ def, voice: null, pan: null, lp: null, next: 0, loading: false }));
    this.bed = new Bed(this.ctx, this.musicBus, this.load);
    this.ready = true;
    this.watchRunning();
    // the rain first (it is the map's room tone), then the footsteps, then the score's first minute, then the rest
    void this.startRain();
    void this.installFootsteps();
    void Promise.all(["intro", "bed_calm", "bed_tension", "bed_combat", "bed_final"].map((id) => this.load.get(id)));
    const mode = this.mode();
    setTimeout(() => {
      const later = ["win", "lose", "potg", ...(mode === "snd" ? ["snd_round", "bomb"] : [])];
      for (const id of later) void this.load.get(id);
    }, 6000);
  }

  /**
   * Katana's recorded footsteps into the rig's step families (the rig picks `step-<surface>` / `land-<surface>`,
   * foot-surface.ts says which surface). Each slice is RMS-matched to the rig's synth stone step, then trimmed by
   * MIX.steps; a landing is the slice over the rig's own landing thud.
   */
  private async installFootsteps(): Promise<void> {
    const rig = this.rig as unknown as { families: Map<string, { variants: AudioBuffer[]; bus: string; baseVol: number; send: number }> };
    const fams = rig.families;
    const rms = (b: AudioBuffer): number => {
      const d = b.getChannelData(0);
      const n = Math.min(d.length, Math.round(b.sampleRate * 0.12));
      let s = 0;
      for (let i = 0; i < n; i++) s += d[i]! * d[i]!;
      return Math.sqrt(s / Math.max(1, n));
    };
    const ref = fams.get("step-hard")?.variants ?? [];
    const target = ref.length ? ref.reduce((a, b) => a + rms(b), 0) / ref.length : 0.05;
    const thuds = fams.get("land")?.variants ?? [];
    const map: [string, string][] = [["gravel", "steps_gravel"], ["water", "steps_water"], ["wood", "steps_wood"], ["hard", "steps_stone"], ["tile", "steps_tile"]];
    await Promise.all(
      map.map(async ([surface, id]) => {
        const buf = await this.load.get(id);
        const info = this.load.info(id);
        if (!buf || !info?.slices?.length) return;
        const sr = buf.sampleRate;
        const steps: AudioBuffer[] = [];
        const lands: AudioBuffer[] = [];
        info.slices.forEach(([a, b], k) => {
          const i0 = Math.round(a * sr);
          const n = Math.round((b - a) * sr);
          const src = buf.getChannelData(0).subarray(i0, i0 + n);
          const one = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr });
          one.copyToChannel(src, 0);
          const g = (target / Math.max(1e-6, rms(one))) * db(MIX.steps[surface] ?? 0);
          const d = one.getChannelData(0);
          for (let i = 0; i < n; i++) d[i]! *= g;
          steps.push(one);
          const th = thuds[k % Math.max(1, thuds.length)];
          // the thud is baked at the rig's bake rate, the slice decoded at the context's: index by time
          const ratio = th ? th.sampleRate / sr : 1;
          const L = Math.max(n, th ? Math.floor(th.length / ratio) : 0);
          const land = new AudioBuffer({ length: L, numberOfChannels: 1, sampleRate: sr });
          const ld = land.getChannelData(0);
          ld.set(d);
          if (th) {
            const td = th.getChannelData(0);
            for (let i = 0; i < L; i++) {
              const j = Math.floor(i * ratio);
              if (j >= td.length) break;
              ld[i]! += td[j]! * 0.7;
            }
          }
          lands.push(land);
        });
        fams.set(`step-${surface}`, { variants: steps, bus: "steps", baseVol: 1, send: 0 });
        fams.set(`land-${surface}`, { variants: lands, bus: "steps", baseVol: 0.5, send: 0.01 });
      }),
    );
  }

  dispose(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.bed?.stop(0.3);
    this.introVoice?.stop(0.3);
    this.bombVoice?.stop(0.3);
    this.rainOpen?.v.stop(0.5);
    this.rainRoof?.v.stop(0.5);
    for (const e of this.emitters) e.voice?.stop(0.3);
    for (const v of this.oneShots) v.stop(0.3);
    this.unPrefs?.();
  }

  private mode(): string {
    const o = (this.game as unknown as { opts?: { mode?: string; gun?: boolean } }).opts;
    return o?.gun ? "gun" : (o?.mode ?? "tdm");
  }

  // ---------------------------------------------------------------- events

  /** game.worldEvents: every server shot and blast. */
  onEvent(e: { t: string; src?: string; ox?: number; oz?: number; x?: number; z?: number }): void {
    const now = this.ctx.currentTime;
    const you = (this.game as unknown as { you: string }).you;
    if (e.t === "shot") {
      if (e.src === you) {
        this.myShotAt = now;
        this.shots.push({ t: now, w: 1 });
        return;
      }
      const L = this.listener();
      const d = Math.hypot((e.ox ?? 0) - L.x, (e.oz ?? 0) - L.z);
      const w = clamp01(1 - d / 60);
      if (w > 0.02) this.shots.push({ t: now, w });
    } else if (e.t === "boom") {
      const L = this.listener();
      const d = Math.hypot((e.x ?? 0) - L.x, (e.z ?? 0) - L.z);
      this.shots.push({ t: now, w: 2 * clamp01(1 - d / 50) });
    }
    if (this.shots.length > 200) this.shots.splice(0, this.shots.length - 200);
  }

  private listener(): { x: number; y: number; z: number } {
    return { x: this.rig.listenerX, y: this.rig.listenerY, z: this.rig.listenerZ };
  }

  // ---------------------------------------------------------------- per frame

  /** The game stopped (back to the menu) or started again: the world, and this module, live for the whole page. */
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchRunning(): void {
    if (this.watchTimer) return;
    const g = this.game as unknown as { running: boolean };
    this.watchTimer = setInterval(() => {
      if (!this.ready) return;
      if (!g.running && this.awake) this.sleep();
      else if (g.running && !this.awake) this.wake();
    }, 400);
  }
  private awake = true;

  private sleep(): void {
    this.awake = false;
    this.bed?.stop(0.8);
    this.introVoice?.stop(0.5);
    this.bombVoice?.stop(0.3);
    for (const v of this.oneShots) v.stop(1.2);
    this.oneShots = [];
    this.introVoice = this.bombVoice = null;
    for (const e of this.emitters) {
      e.voice?.stop(0.6);
      e.voice = null;
    }
    this.rainOpen?.v.stop(0.8);
    this.rainRoof?.v.stop(0.8);
    this.rainOpen = this.rainRoof = null;
  }

  private wake(): void {
    this.awake = true;
    this.state = "idle";
    this.layerState = "calm";
    this.intensity = 0;
    this.finalOn = false;
    this.shots.length = 0;
    this.wasEnded = this.wasEndcard = this.wasFkc = this.wasLive = false;
    this.roundN = -1;
    this.roundState = "";
    this.bombSite = null;
    void this.startRain();
  }

  update(dt: number): void {
    if (!this.ready || !this.ctx || !this.awake) return;
    const now = this.ctx.currentTime;
    this.tickShelter(dt, now);
    this.tickEmitters(now);
    this.tickThunder(now);
    this.tickDuck(now);
    this.tickMatch(now);
    if (this.state === "bed") this.tickIntensity(dt, now);
  }

  // ---- shelter: "is there a roof above me?"

  private tickShelter(dt: number, now: number): void {
    this.shelterT -= dt;
    if (this.shelterT <= 0) {
      this.shelterT = 0.2;
      const L = this.listener();
      let roof = false;
      let indoor = false;
      for (const s of this.shelters) {
        if (inShelter(s, L.x, L.y, L.z)) {
          roof = true;
          if (s.kind === "indoor") indoor = true;
        }
      }
      if (!roof) roof = traceWorld(L.x, L.y + 0.1, L.z, 0, 1, 0, 24).t < 24;
      if (roof && !indoor) {
        let hits = 0;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          if (traceWorld(L.x, L.y, L.z, Math.cos(a), 0, Math.sin(a), 6).t < 6) hits++;
        }
        indoor = hits >= 7;
      }
      this.shelterTarget = { roof: roof ? 1 : 0, indoor: indoor ? 1 : 0 };
    }
    const k = 1 - Math.exp(-dt / 0.35);
    this.shelter.roof += (this.shelterTarget.roof - this.shelter.roof) * k;
    this.shelter.indoor += (this.shelterTarget.indoor - this.shelter.indoor) * k;
    this.applyRain(now);
  }
  private shelterTarget = { roof: 0, indoor: 0 };

  private async startRain(): Promise<void> {
    const [open, roof] = await Promise.all([this.load.get("rain_open"), this.load.get("rain_roof")]);
    const mk = (b: AudioBuffer, g: number): { v: Voice; lp: BiquadFilterNode } => {
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 18000;
      lp.Q.value = 0.5;
      lp.connect(this.ambBus);
      // a random start point: two players never hear the same bar of rain
      return { v: playBuffer(this.ctx, b, lp, { loop: true, gain: g, fadeIn: 3, offset: Math.random() * b.duration }), lp };
    };
    if (open) this.rainOpen = mk(open, db(MIX.rainOpen));
    if (roof) this.rainRoof = mk(roof, 0);
  }

  private applyRain(now: number): void {
    const { roof, indoor } = this.shelter;
    const eave = roof * (1 - indoor);
    if (this.rainOpen) {
      this.rainOpen.v.gain.gain.setTargetAtTime(db(MIX.rainOpen) * (1 - 0.6 * eave) * (1 - 0.7 * indoor), now, 0.1);
      this.rainOpen.lp.frequency.setTargetAtTime(18000 * (1 - 0.55 * eave) * (1 - 0.96 * indoor) + 300, now, 0.1);
    }
    if (this.rainRoof) {
      this.rainRoof.v.gain.gain.setTargetAtTime(db(MIX.rainRoof) * (eave + 0.55 * indoor), now, 0.1);
      this.rainRoof.lp.frequency.setTargetAtTime(indoor > 0.5 ? 1100 : 16000, now, 0.15);
    }
  }

  // ---- positional emitters (data: emitters.json)

  private tickEmitters(now: number): void {
    const L = this.listener();
    const muffle = 20000 - 18500 * this.shelter.indoor;
    for (const e of this.emitters) {
      const d = Math.hypot(e.def.x - L.x, e.def.y - L.y, e.def.z - L.z);
      const type = MIX.types[e.def.type];
      if (!type) continue;
      const near = d < e.def.radius * 1.1;
      if (type.loop) {
        if (near && !e.voice && !e.loading) void this.startEmitter(e, type);
        else if (!near && e.voice && d > e.def.radius * 1.25) {
          e.voice.stop(1.0);
          e.voice = null;
        }
      } else if (near && now >= e.next && !e.loading) {
        const every = e.def.every ?? type.every ?? [20, 40];
        if (e.next > 0) void this.fireEmitter(e, type);
        e.next = now + every[0] + Math.random() * (every[1] - every[0]);
      }
      if (e.lp) e.lp.frequency.setTargetAtTime(muffle, now, 0.2);
    }
  }

  private makeChain(e: LiveEmitter): AudioNode {
    const pan = this.ctx.createPanner();
    pan.panningModel = "equalpower";
    pan.distanceModel = "linear";
    pan.refDistance = Math.max(1, e.def.radius * 0.2);
    pan.maxDistance = e.def.radius;
    pan.rolloffFactor = 1;
    pan.positionX.value = e.def.x;
    pan.positionY.value = e.def.y;
    pan.positionZ.value = e.def.z;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 20000;
    pan.connect(lp).connect(this.ambBus);
    e.pan = pan;
    e.lp = lp;
    return pan;
  }

  private async startEmitter(e: LiveEmitter, type: { asset: string; db: number }): Promise<void> {
    e.loading = true;
    const b = await this.load.get(type.asset);
    e.loading = false;
    if (!b) return;
    const into = e.pan ?? this.makeChain(e);
    e.voice = playBuffer(this.ctx, b, into, { loop: true, gain: db(type.db + (e.def.gain ?? 0)), fadeIn: 1.5, offset: Math.random() * b.duration });
  }

  private async fireEmitter(e: LiveEmitter, type: { asset: string; db: number }): Promise<void> {
    const b = await this.load.get(type.asset);
    if (!b) return;
    const into = e.pan ?? this.makeChain(e);
    playBuffer(this.ctx, b, into, { gain: db(type.db + (e.def.gain ?? 0)) * (0.8 + Math.random() * 0.2) });
  }

  // ---- distant thunder: rare, global, never in a fight

  /** the art segment can flash the sky: called ~0.1-2 s BEFORE the rumble arrives (light is faster) */
  onThunder: ((delayS: number) => void) | null = null;

  private tickThunder(now: number): void {
    if (now < this.nextThunder) return;
    this.nextThunder = now + 90 + Math.random() * 120;
    if (this.intensity > 0.5 || this.state === "bomb") return;
    const id = Math.random() < 0.5 ? "thunder_1" : "thunder_2";
    const delay = 0.6 + Math.random() * 2.2;
    this.onThunder?.(delay);
    void this.load.get(id).then((b) => {
      if (!b) return;
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.2 - 0.6;
      pan.connect(this.ambBus);
      playBuffer(this.ctx, b, pan, { at: this.ctx.currentTime + delay, gain: db(MIX.thunder - Math.random() * 4) });
    });
  }

  // ---- ducking under gunfire and voice

  private tickDuck(now: number): void {
    while (this.shots.length && now - this.shots[0]!.t > 6) this.shots.shift();
    let heard = 0;
    for (const s of this.shots) if (now - s.t < 1.2) heard += s.w;
    const g = clamp01(heard / 4);
    const speaking = !!(this.game as unknown as { announcer?: { speaking?: boolean } }).announcer?.speaking;
    const mDb = MIX.duck.gunMusicDb * g + (speaking ? MIX.duck.voiceMusicDb : 0);
    const aDb = MIX.duck.gunAmbDb * g + (speaking ? MIX.duck.voiceAmbDb : 0);
    const mt = db(Math.max(-12, mDb));
    const at = db(Math.max(-8, aDb));
    const pm = this.musicDuck.gain;
    const pa = this.ambDuck.gain;
    pm.setTargetAtTime(mt, now, mt < pm.value ? 0.06 : 0.9);
    pa.setTargetAtTime(at, now, at < pa.value ? 0.08 : 1.2);
  }

  // ---- adaptive bed: intensity → calm / tension / combat (+ final)

  private tickIntensity(dt: number, now: number): void {
    const g = this.game as unknown as { me(): { hp: number; alive: boolean; team: number; x: number; y: number; z: number } | undefined; players: Map<string, { id: string; team: number; alive: boolean; x: number; z: number }>; you: string };
    const me = g.me();
    if (me) {
      if (me.alive && me.hp < this.lastHp - 0.5) this.hurtAt = now;
      this.lastHp = me.hp;
    }
    let near = 0;
    for (const s of this.shots) if (now - s.t < 4) near += s.w;
    let enemies = 0;
    if (me) {
      const ffa = this.mode() === "ffa" || this.mode() === "gun";
      for (const p of g.players.values()) {
        if (p.id === g.you || !p.alive || (!ffa && p.team === me.team)) continue;
        if (Math.hypot(p.x - me.x, p.z - me.z) < 22) enemies++;
      }
    }
    const raw =
      this.override ??
      clamp01(0.07 * near + (now - this.myShotAt < 3 ? 0.45 : 0) + (now - this.hurtAt < 5 ? 0.5 : 0) + Math.min(0.3, 0.12 * enemies));
    const k = 1 - Math.exp(-dt / (raw > this.intensity ? 0.5 : 4));
    this.intensity += (raw - this.intensity) * k;
    const I = this.intensity;
    const dwell = now - this.layerSince;
    const prev = this.layerState;
    if (prev === "calm" && I > 0.2) this.layerState = "tension";
    else if (prev === "tension" && I > 0.55) this.layerState = "combat";
    else if (prev === "tension" && I < 0.08 && dwell > 12) this.layerState = "calm";
    else if (prev === "combat" && I < 0.3 && dwell > 7) this.layerState = "tension";
    if (this.layerState !== prev) this.layerSince = now;
    const final = this.isFinal();
    if (final !== this.finalOn || this.layerState !== prev || this.steerAt < now) {
      this.finalOn = final;
      this.steerAt = now + 1;
      this.steer();
    }
  }
  private steerAt = 0;

  private steer(): void {
    if (!this.bed) return;
    const s = this.layerState;
    const t: Record<Layer, number> = this.finalOn
      ? { calm: 0, tension: s === "calm" ? 0.5 : 0, combat: 0, final: s === "calm" ? 0.6 : 1 }
      : s === "calm"
        ? { calm: 1, tension: 0, combat: 0, final: 0 }
        : s === "tension"
          ? { calm: 0.35, tension: 1, combat: 0, final: 0 }
          : { calm: 0, tension: 0.4, combat: 1, final: 0 };
    this.bed.steer(t);
  }

  /** Final minute of a timed mode, or match point. */
  private isFinal(): boolean {
    const g = this.game as unknown as { session: { remain: number; score0: number; score1: number } | null; netRemain: number; netScore0: number; netScore1: number; roundInfo(): { n: number; total: number; wins0: number; wins1: number } | null; players: Map<string, { kills: number }> };
    const mode = this.mode();
    const r = g.roundInfo();
    if (r) {
      const need = Math.ceil(r.total / 2);
      return Math.max(r.wins0, r.wins1) >= need - 1 && r.n > 1;
    }
    const remain = g.session ? g.session.remain : g.netRemain;
    if (remain > 0 && remain <= 60) return true;
    let limit = 0;
    try {
      limit = (modeInfo(activeMap().id, mode as never) as { limit?: number }).limit ?? 0;
    } catch {
      limit = 0;
    }
    if (!limit) return false;
    const s0 = g.session ? g.session.score0 : g.netScore0;
    const s1 = g.session ? g.session.score1 : g.netScore1;
    let top = Math.max(s0, s1);
    if (mode === "ffa") for (const p of g.players.values()) top = Math.max(top, p.kills);
    const margin = mode === "dom" ? Math.round(limit * 0.1) : 3;
    return top >= limit - margin;
  }

  // ---- the match: intro, rounds, bomb, end

  private tickMatch(now: number): void {
    const g = this.game as unknown as {
      matchLive(): boolean;
      countdownLeftMs(): number;
      ended: boolean;
      endcardUp: boolean;
      fkc: unknown;
      roundInfo(): { n: number; state: string } | null;
      objectiveInfo(): { mode: string; bomb?: { site: string; fuse: number } | null } | null;
    };
    const live = g.matchLive();
    const cd = g.countdownLeftMs();
    // INTRO: its title hit lands on GO
    if (this.state === "idle" && !this.externalIntro) {
      if (cd > 0) {
        this.sawCountdown = true;
        this.playIntro(now + cd / 1000);
      } else if (live && !this.wasLive) {
        // joined a match already running (no countdown seen): no intro, straight into the bed
        this.introHitAt = now;
        this.state = "intro";
      }
    }
    if (this.state === "intro" && live && !this.introStarting) this.startBedAfterIntro(now);
    // S&D / round modes
    const r = g.roundInfo();
    if (r) {
      if (r.n !== this.roundN || (r.state === "live" && this.roundState === "end")) {
        if (this.roundN >= 0 && r.state === "live") this.roundStart(now);
        this.roundN = r.n;
      }
      if (r.state === "end" && this.roundState === "live") this.roundEnd(now);
      this.roundState = r.state;
    }
    const obj = g.objectiveInfo();
    const bomb = obj && obj.mode === "snd" ? (obj.bomb ?? null) : null;
    if (bomb && !this.bombSite) this.bombPlanted(now, bomb.fuse);
    else if (!bomb && this.bombSite) this.bombGone();
    this.bombSite = bomb?.site ?? null;
    // END: the bed stops on the final whistle; potg under the final killcam; the stinger on the endcard
    if (g.ended && !this.wasEnded) this.matchEnded();
    const fkc = !!g.fkc;
    if (fkc && !this.wasFkc && g.ended) this.playPotg();
    if (g.endcardUp && !this.wasEndcard) this.playStinger();
    this.wasEnded = g.ended;
    this.wasEndcard = g.endcardUp;
    this.wasFkc = fkc;
    this.wasLive = live;
  }
  private introStarting = false;

  /** Public: play the intro so its title hit lands at ctx time `hitAt`. Returns the hit time. */
  playIntro(hitAt: number): number {
    const info = this.load?.info("intro");
    const hit = info?.hits?.[0] ?? 9;
    this.state = "intro";
    this.introStarting = true;
    void this.load.get("intro").then((b) => {
      this.introStarting = false;
      if (!b) return;
      const start = hitAt - hit;
      const now = this.ctx.currentTime;
      this.lastCue = "intro";
      this.introVoice = playBuffer(this.ctx, b, this.musicBus, { at: Math.max(now, start), offset: Math.max(0, now - start), gain: db(MIX.intro), fadeIn: start < now ? 0.3 : 0 });
      this.introHitAt = hitAt;
    });
    return hitAt;
  }
  introHitAt = 0;

  private startBedAfterIntro(now: number): void {
    this.state = "bed";
    this.layerState = "calm";
    this.layerSince = now;
    // under the intro's ring-out: the bed fades in from the hit
    const at = Math.max(now, this.introHitAt + 0.5);
    void this.bed?.start(at, { calm: 1 }, 3);
  }

  private roundStart(now: number): void {
    this.bombVoice?.stop(0.2);
    this.bombVoice = null;
    void this.load.get("snd_round").then((b) => {
      if (!b) return;
      this.lastCue = "snd_round";
      this.oneShots.push(playBuffer(this.ctx, b, this.musicBus, { gain: db(MIX.sndRound) }));
    });
    this.bed?.stop(0.4);
    this.state = "bed";
    this.layerState = "calm";
    this.layerSince = now;
    this.intensity = 0;
    void this.bed?.start(now + 2.5, { calm: 1 }, 3);
  }

  private roundEnd(_now: number): void {
    this.bed?.steer({ calm: 0.6, tension: 0, combat: 0, final: 0 }, 0.3, 0.8);
    this.state = "round-end";
  }

  private bombPlanted(_now: number, fuse: number): void {
    this.state = "bomb";
    this.bed?.stop(1.2);
    const offset = Math.max(0, Math.min(FUSE_S - 1, FUSE_S - fuse));
    void this.load.get("bomb").then((b) => {
      if (!b || this.state !== "bomb") return;
      this.lastCue = `bomb@${offset.toFixed(1)}`;
      this.bombVoice = playBuffer(this.ctx, b, this.musicBus, { offset, gain: db(MIX.bomb), fadeIn: 0.15 });
    });
  }

  private bombGone(): void {
    this.bombVoice?.stop(0.35);
    this.bombVoice = null;
    if (this.state === "bomb") this.state = "round-end";
  }

  private matchEnded(): void {
    this.state = "end";
    this.bed?.stop(1.0);
    this.bombVoice?.stop(0.3);
    this.introVoice?.stop(0.5);
  }

  /** Public: the play-of-the-game / final-killcam cue. */
  playPotg(): void {
    this.state = "potg";
    void this.load.get("potg").then((b) => {
      if (!b) return;
      this.lastCue = "potg";
      this.oneShots.push(playBuffer(this.ctx, b, this.musicBus, { gain: db(MIX.potg) }));
    });
  }

  /** Public: the win / lose stinger (the endcard). */
  playStinger(win = this.didWin()): void {
    for (const v of this.oneShots) v.stop(0.6);
    this.oneShots = [];
    void this.load.get(win ? "win" : "lose").then((b) => {
      if (!b) return;
      this.lastCue = win ? "win" : "lose";
      this.oneShots.push(playBuffer(this.ctx, b, this.musicBus, { gain: db(win ? MIX.win : MIX.lose) }));
    });
  }

  private didWin(): boolean {
    const g = this.game as unknown as { me(): { team: number; kills: number } | undefined; session: { score0: number; score1: number } | null; netScore0: number; netScore1: number; players: Map<string, { kills: number }> };
    const me = g.me();
    if (this.mode() === "ffa" || this.mode() === "gun") {
      let top = 0;
      for (const p of g.players.values()) top = Math.max(top, p.kills);
      return (me?.kills ?? 0) >= top;
    }
    const s0 = g.session ? g.session.score0 : g.netScore0;
    const s1 = g.session ? g.session.score1 : g.netScore1;
    if (s0 === s1) return false;
    return me ? (me.team === 0 ? s0 > s1 : s1 > s0) : s0 > s1;
  }
}

// ------------------------------------------------------------------ attach

export async function attachKatanaAudio(game: Game): Promise<KatanaAudio | null> {
  const world = game.world;
  if (!world) return null;
  // main.ts bringt game.init() und audio.boot() per Promise.all parallel hoch:
  // beim Attach kann rig.ctx noch fehlen — bounded auf den Boot warten, statt
  // Score/Rain still zu verlieren.
  if (!game.audio.ctx) {
    for (let i = 0; i < 50 && !game.audio.ctx; i++) await new Promise((r) => setTimeout(r, 100));
  }
  const rig = game.audio;
  if (!game.world || !rig.ctx) return null;
  const ka = new KatanaAudio(game, rig);
  // the lobby's menu loop hands over to the match
  katanaMenuMusic(false);
  const base = world.update.bind(world);
  world.update = (dt: number, cam: Parameters<typeof base>[1]) => {
    base(dt, cam);
    ka.update(dt);
  };
  game.worldEvents.push((e) => ka.onEvent(e as never));
  (window as unknown as { __katanaAudio?: KatanaAudio }).__katanaAudio = ka;
  void ka.init();
  return ka;
}

// ------------------------------------------------------------------ the menu loop

let menu: { ctx: AudioContext; voice: Voice | null; gain: GainNode; want: boolean; hooked: boolean } | null = null;

/**
 * The lobby / menu loop (main.ts calls it when the page's map is Katana). It owns a small context of its own
 * (the game's rig does not exist yet in the menu) that starts on the first gesture, as browsers require.
 */
export function katanaMenuMusic(on: boolean): void {
  if (typeof window === "undefined") return;
  if (!menu) {
    if (!on) return;
    const ctx = new AudioContext({ latencyHint: "playback" });
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    menu = { ctx, voice: null, gain, want: true, hooked: false };
  }
  const m = menu;
  m.want = on;
  m.gain.gain.value = db(MIX.menu) * prefs().master * (prefs().music ?? 0.7);
  if (!on) {
    m.voice?.stop(0.8);
    m.voice = null;
    // Den Kontext parken statt leer laufen zu lassen (go() resumed bei Bedarf).
    void m.ctx.suspend().catch(() => {});
    return;
  }
  if (m.voice) return;
  const go = async (): Promise<void> => {
    if (m.ctx.state === "suspended") await m.ctx.resume().catch(() => {});
    if (m.ctx.state !== "running" || m.voice || !m.want) return;
    const mf = await fetchJson<Manifest>(`${BASE}manifest.json`);
    if (!mf || m.voice || !m.want) return;
    const b = await new Loader(m.ctx, mf).get("menu");
    if (b && !m.voice && m.want) m.voice = playBuffer(m.ctx, b, m.gain, { loop: true, fadeIn: 2.5 });
  };
  void go();
  if (!m.hooked) {
    m.hooked = true;
    const kick = (): void => void go();
    for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, kick, { capture: true });
    onPrefs((p) => {
      m.gain.gain.value = db(MIX.menu) * p.master * (p.music ?? 0.7);
    });
  }
}
