/**
 * WEAPON AUDIO ENGINE — plays the recorded weapon set (public/assets/audio/weapons/,
 * Kong Royale's library + CC0 frag/knife foley) through AudioRig2's context and
 * master stage. The mix itself — every level, band, delay, keyframe — lives in
 * audio-bank.ts; this file loads the samples and executes it:
 *
 *   loader  — manifest + fetch/decode with a bounded pool, priority-ordered
 *             (your gun layers + confirms first, then reports / foley, then
 *             impacts). Opus/Ogg where the browser has it, AAC/M4A otherwise
 *             (per file: a failed decode retries the other codec); the 1P
 *             shots are FLAC everywhere (Chrome / Firefox / Safari 11+).
 *   voices  — one VOICE per event (a shot = its layers sharing one gain, one
 *             air/occlusion low-pass and ONE panner), admitted against the
 *             group caps and the per-emitter cap; a full group steals its
 *             quietest/oldest unprotected voice (never yours, never the four
 *             nearest shooters) or drops the newcomer.
 *   buses   — p1 (your gun + foley) / p3 (everyone else) / world (blasts) /
 *             ui (confirms), with the own-fire duck, the confirm duck and the
 *             shell-shock low-pass, all into the rig's master stage.
 *
 * Every public method returns false when the samples it needs are not decoded
 * (yet, or ever): AudioRig2 then falls back to its synth voice for that call.
 * Nothing here fetches until load() is called (boot), so the offline QA
 * harnesses that build AudioRig2 without a context never touch the network.
 */
import { traceWorld } from "@shared/map";
import { WEAPON_BY_ID } from "@shared/weapons";
import {
  AIR_M,
  BOOM_FAR,
  BOOM_NEAR,
  BUS_DB,
  CASING_DB,
  CONFIRM,
  DRY_DB,
  DRY_RATE,
  EQUIP,
  EQUIP_DB,
  FAR_BAND,
  FOLEY,
  FTAIL_BAND,
  GUN_IDS,
  GUN_MIX,
  IMPACT_DB,
  REF_M,
  RELOAD_DB,
  RELOAD_KEYS,
  SHOCK_M,
  SNIPER_BOLT,
  SPOT,
  TAIL_BAND,
  WEAPON_TRIM_DB,
  gunOf,
  type GunId,
  type Spot,
} from "./audio-bank";

type ManFile = { dur: number; ch: number; g: number; p: number | null; fmt: string[]; src: string };
type Manifest = {
  version: number;
  sr: number;
  bytes?: Record<string, number>;
  groups: Record<string, { desc: string; files: string[] }>;
  files: Record<string, ManFile>;
};
type Clip = { id: string; buf: AudioBuffer; g: number; p: number };

const HALF_PI = Math.PI / 2;
const dbg = (db: number): number => Math.pow(10, db / 20);
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** designed loudness-vs-distance (dB): -a per doubling from `ref` to `knee`, -b per doubling beyond */
export function curveDb(d: number, ref: number, a: number, knee: number, b: number): number {
  const dd = Math.max(d, ref);
  const k = Math.max(knee, ref);
  if (dd <= k) return -a * Math.log2(dd / ref);
  return -a * Math.log2(k / ref) - b * Math.log2(dd / k);
}

// ---------------------------------------------------------------------------
// LIBRARY
// ---------------------------------------------------------------------------

/** load order: what the first trigger pull / first hit needs, then the rest */
function priorityOf(group: string): number {
  if (/^(ar|smg|sniper|pistol)\/(p1|mech|tail|body)$/.test(group) || group.startsWith("hit/") || group === "dry" || group === "equip") return 0;
  if (/\/(far|dist)$/.test(group) || /\/rl-|\/bolt-/.test(group) || group.startsWith("exp/") || group.startsWith("nade/")) return 1;
  return 2;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      await fn(items[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class WeaponLibrary {
  man: Manifest | null = null;
  readonly clips = new Map<string, Clip[]>();
  private meanP = new Map<string, number>();
  private bags = new Map<string, number[]>();
  private last = new Map<string, number>();
  bytes = 0;
  files = 0;
  failed: string[] = [];
  codec = "";
  /** resolves when the priority-0 groups are decoded (or failed) */
  first: Promise<void> | null = null;
  /** resolves when everything is decoded (or failed) */
  all: Promise<void> | null = null;

  constructor(readonly base: string) {}

  has(group: string): boolean {
    return (this.clips.get(group)?.length ?? 0) > 0;
  }

  /** mean 100 ms loudness of a group as played (manifest p = P + g), dB */
  groupP(group: string): number {
    const c = this.meanP.get(group);
    if (c !== undefined) return c;
    const g = this.man?.groups[group];
    if (!g) return -18;
    let s = 0;
    let n = 0;
    for (const id of g.files) {
      const f = this.man!.files[id];
      if (f?.p != null) {
        s += f.p;
        n++;
      }
    }
    const v = n ? s / n : -18;
    this.meanP.set(group, v);
    return v;
  }

  /** forget the round-robin state (offline renders: identical variant picks per scene) */
  resetBags(): void {
    this.bags.clear();
    this.last.clear();
  }

  /** shuffle-bag round robin: every variant once per bag, never the same one twice in a row */
  pick(group: string, rnd: () => number): Clip | null {
    const cs = this.clips.get(group);
    if (!cs || cs.length === 0) return null;
    if (cs.length === 1) return cs[0]!;
    let bag = this.bags.get(group);
    const last = this.last.get(group) ?? -1;
    if (!bag || bag.length === 0) {
      bag = cs.map((_, i) => i);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [bag[i], bag[j]] = [bag[j]!, bag[i]!];
      }
      if (bag[bag.length - 1] === last) {
        const j = Math.floor(rnd() * (bag.length - 1));
        [bag[bag.length - 1], bag[j]] = [bag[j]!, bag[bag.length - 1]!];
      }
      this.bags.set(group, bag);
    }
    const i = bag.pop()!;
    this.last.set(group, i);
    return cs[i] ?? cs[0]!;
  }

  load(ctx: BaseAudioContext): Promise<void> {
    if (this.all) return this.all;
    let resolveFirst!: () => void;
    this.first = new Promise<void>((r) => (resolveFirst = r));
    this.all = (async () => {
      try {
        const res = await fetch(this.base + "manifest.json");
        if (!res.ok) throw new Error(`manifest ${res.status}`);
        this.man = (await res.json()) as Manifest;
      } catch (e) {
        console.warn("[audio] weapon samples unavailable — synth weapons stay in charge", e);
        resolveFirst();
        return;
      }
      const probe = typeof Audio !== "undefined" ? new Audio() : null;
      const opus = !!probe && probe.canPlayType('audio/ogg; codecs="opus"') !== "";
      this.codec = opus ? "ogg" : "m4a";
      const groups = Object.keys(this.man.groups);
      for (const tier of [0, 1, 2]) {
        const ids: [string, string][] = [];
        for (const g of groups) if (priorityOf(g) === tier) for (const f of this.man.groups[g]!.files) ids.push([g, f]);
        await pool(ids, 6, ([g, id]) => this.decodeOne(ctx, g, id));
        if (tier === 0) resolveFirst();
      }
    })();
    return this.all;
  }

  private async decodeOne(ctx: BaseAudioContext, group: string, id: string): Promise<void> {
    const f = this.man!.files[id];
    if (!f) return;
    // per file: the preferred codec first, the other one if that decode fails (a "maybe" from canPlayType lies)
    const order = f.fmt.includes("flac") ? ["flac"] : this.codec === "ogg" ? ["ogg", "m4a"] : ["m4a", "ogg"];
    for (const ext of order) {
      if (!f.fmt.includes(ext)) continue;
      try {
        const res = await fetch(`${this.base}${id}.${ext}`);
        if (!res.ok) continue;
        const ab = await res.arrayBuffer();
        const size = ab.byteLength; // (decodeAudioData detaches the buffer)
        const buf = await ctx.decodeAudioData(ab);
        this.bytes += size;
        this.files++;
        // variants keep the manifest's order whatever order the decodes finish in (the round robin is reproducible)
        const list = this.clips.get(group) ?? [];
        list.push({ id, buf, g: f.g, p: f.p ?? -18 });
        list.sort((x, y) => (x.id < y.id ? -1 : 1));
        this.clips.set(group, list);
        return;
      } catch {
        /* next codec */
      }
    }
    this.failed.push(id);
  }
}

// ---------------------------------------------------------------------------
// ENGINE
// ---------------------------------------------------------------------------

type VGroup = "gun" | "impact" | "bounce" | "boom" | "confirm" | "foley" | "whizz" | "casing" | "flesh";
const CAP: Record<VGroup, number> = { gun: 18, impact: 8, bounce: 4, boom: 4, confirm: 4, foley: 10, whizz: 2, casing: 4, flesh: 6 };
/** how many of one shooter's shots may ring at once (the older ones are choked under the new transient) */
const EMITTER_CAP_LOCAL = 5;
const EMITTER_CAP_REMOTE = 3;

type BusKey = "p1" | "p3" | "world" | "ui" | "hurt";

interface Voice {
  group: VGroup;
  emitter: string;
  local: boolean;
  start: number;
  end: number;
  /** loudness estimate at the listener, dB (the steal score) */
  db: number;
  prio: number;
  dist: number;
  /** when its first layer actually sounds (a reload key is scheduled ahead) */
  at: number;
  out: GainNode;
  srcs: AudioBufferSourceNode[];
  nodes: AudioNode[];
  ended: number;
  dead: boolean;
  tag?: string;
}

export type AttachOpts = {
  /** where every weapon bus ends up: the rig's master stage input */
  into: AudioNode;
  /** the yard reverb input (null = dry) */
  verb: AudioNode | null;
  /** the rig's ambience bus (ducked by your own fire) */
  amb?: GainNode | null;
  /** THE panner (one config for every emitter in the game) */
  panner: (ctx: BaseAudioContext, x: number, y: number, z: number) => PannerNode;
  /** that panner's own inverse-distance gain at d, which a designed curve cancels */
  panLaw: (d: number) => number;
};

export type WeaponAudioStats = {
  codec: string;
  groups: number;
  buffers: number;
  bytes: number;
  failed: number;
  voices: number;
  peakVoices: number;
  peakGun: number;
  started: number;
  stolen: number;
  dropped: number;
};

export class WeaponAudio {
  readonly lib: WeaponLibrary;
  ctx: BaseAudioContext | null = null;
  private opts: AttachOpts | null = null;
  private bus: Record<BusKey, GainNode> | null = null;
  private duck3p: GainNode | null = null;
  private duckW: GainNode | null = null;
  private duckOwn: GainNode | null = null;
  private conf3p: GainNode | null = null;
  private shock: BiquadFilterNode | null = null;
  private ambBase = 0.5;
  private voices: Voice[] = [];
  private reloadVoices: Voice[] = [];
  private lastTrig = new Map<string, number>();
  private heldId = "";
  private heldAlive = false;
  private casingExtAt = -1e9;
  private knifeAt = -1e9;
  /** the active map (impact surface defaults) and its floor plane height */
  mapId = "";
  floorY = 0;
  lx = 0;
  ly = 0;
  lz = 0;
  yaw = 0;
  /** offline QA: pin "now" to a scheduled time (null = ctx.currentTime) */
  clock: number | null = null;
  /** occlusion test (listener -> point); null disables. Default: the collider ray. */
  occluder: ((x: number, y: number, z: number, d: number) => boolean) | null = (x, y, z, d) => {
    if (d < 1.5) return false;
    const dx = (x - this.lx) / d;
    const dy = (y - this.ly) / d;
    const dz = (z - this.lz) / d;
    return traceWorld(this.lx, this.ly, this.lz, dx, dy, dz, d).t < d - 0.4;
  };
  rnd: () => number = Math.random;
  /** QA: the distance-band weights of the last remote shot (qa/sound-spatial phase C3) */
  lastBands: { d: number; near: number; far: number; dist: number; tail: number; ftail: number } | null = null;
  readonly counters = { started: 0, stolen: 0, dropped: 0, peakVoices: 0, peakGun: 0 };

  constructor(
    readonly scale: number,
    lib?: WeaponLibrary,
    base = "/assets/audio/weapons/",
  ) {
    this.lib = lib ?? new WeaponLibrary(base);
  }

  get loaded(): boolean {
    return this.lib.files > 0;
  }

  /** Build the weapon buses inside `ctx` (call once per context). */
  attach(ctx: BaseAudioContext, opts: AttachOpts): void {
    this.ctx = ctx;
    this.opts = opts;
    const g = (db = 0): GainNode => {
      const n = ctx.createGain();
      n.gain.value = dbg(db);
      return n;
    };
    this.shock = ctx.createBiquadFilter();
    this.shock.type = "lowpass";
    this.shock.frequency.value = ctx.sampleRate / 2;
    this.shock.Q.value = 0.5;
    this.shock.connect(opts.into);
    this.duck3p = g();
    this.duckW = g();
    this.duckOwn = g();
    this.conf3p = g();
    const p1 = g(BUS_DB.p1);
    const p3 = g(BUS_DB.p3);
    const world = g(BUS_DB.world);
    const ui = g(BUS_DB.ui);
    const hurt = g();
    p1.connect(this.duckOwn).connect(this.shock);
    hurt.connect(p1);
    p3.connect(this.duck3p).connect(this.conf3p).connect(this.shock);
    world.connect(this.duckW).connect(this.shock);
    // confirms: never ducked, never filtered
    ui.connect(opts.into);
    this.bus = { p1, p3, world, ui, hurt };
    if (opts.amb) this.ambBase = opts.amb.gain.value;
  }

  /** Start fetching + decoding (resolves when everything is in; `lib.first` when the first-shot set is). */
  load(ctx: BaseAudioContext): Promise<void> {
    return this.lib.load(ctx);
  }

  listen(x: number, y: number, z: number, yaw: number): void {
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.yaw = yaw;
  }

  stats(): WeaponAudioStats {
    let buffers = 0;
    for (const c of this.lib.clips.values()) buffers += c.length;
    return {
      codec: this.lib.codec,
      groups: this.lib.clips.size,
      buffers,
      bytes: this.lib.bytes,
      failed: this.lib.failed.length,
      voices: this.live().length,
      ...this.counters,
    };
  }

  private now(): number {
    return this.clock ?? this.ctx?.currentTime ?? 0;
  }

  private live(): Voice[] {
    const t = this.now();
    if (this.voices.some((v) => v.dead || v.end <= t)) this.voices = this.voices.filter((v) => !v.dead && v.end > t);
    return this.voices;
  }

  private lastShot = new Map<string, number>();

  /**
   * CADENCE, not a duplicate gate: two shots from one gun on the same audio clock (a frame catch-up running several
   * sim ticks, a snapshot carrying two of a remote's rounds) are spread at the gun's fire interval instead of the
   * second being dropped. Returns the lead (s) to schedule this shot at, or -1 when it is a true duplicate / too late.
   */
  private cadence(key: string, weapon: string): number {
    const t = this.now();
    const rpm = WEAPON_BY_ID[weapon]?.rpm ?? 600;
    const iv = 60 / rpm;
    const last = this.lastShot.get(key) ?? -1e9;
    const at = Math.max(t, last + iv * 0.92);
    if (at - t > 0.25) return -1;
    this.lastShot.set(key, at);
    return at - t;
  }

  /** same event from the same emitter inside `gap` s is one event */
  private gate(key: string, gap: number): boolean {
    const t = this.now();
    const last = this.lastTrig.get(key) ?? -1e9;
    if (t - last < gap && t >= last) return false;
    this.lastTrig.set(key, t);
    return true;
  }

  private dist(x: number, y: number, z: number): number {
    return Math.hypot(x - this.lx, y - this.ly, z - this.lz);
  }

  // ---------------------------------------------------------------- voices

  private kill(v: Voice, at = this.now()): void {
    if (v.dead) return;
    v.dead = true;
    const t = Math.max(at, this.ctx!.currentTime);
    const p = v.out.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(0, t, 0.007);
    for (const s of v.srcs) {
      try {
        s.stop(t + 0.04);
      } catch {
        /* never started / already stopped */
      }
    }
    // a source stopped before its scheduled start (a cancelled reload key) may never fire `ended`: free its nodes
    if (typeof AudioContext !== "undefined" && this.ctx instanceof AudioContext) {
      setTimeout(() => {
        for (const n of v.nodes) {
          try {
            n.disconnect();
          } catch {
            /* gone */
          }
        }
      }, (t - this.ctx.currentTime + 0.15) * 1000);
    }
  }

  /**
   * VOICE CAP with priority (KR allocate): never stolen — your own voices and the four nearest remote emitters.
   * Otherwise the quietest, oldest voice goes (a far tail); if everything playing matters more than the newcomer,
   * the newcomer is dropped.
   */
  private admit(group: VGroup, local: boolean, db: number, prio: number, dist: number, emitter: string): boolean {
    const vs = this.live();
    let n = 0;
    for (const v of vs) if (v.group === group) n++;
    if (n < CAP[group]) return true;
    const now = this.now();
    // the 4 nearest remote emitters are protected
    const near: { k: string; d: number }[] = [];
    for (const v of vs) {
      if (v.group !== group || v.local) continue;
      const e = near.find((q) => q.k === v.emitter);
      if (e) e.d = Math.min(e.d, v.dist);
      else near.push({ k: v.emitter, d: v.dist });
    }
    near.sort((a, b) => a.d - b.d);
    const prot = new Set(near.slice(0, 4).map((q) => q.k));
    const far4 = near.length >= 4 ? near[3]!.d : Infinity;
    let victim: Voice | null = null;
    let best = Infinity;
    for (const v of vs) {
      if (v.group !== group || v.local || prot.has(v.emitter)) continue;
      const s = v.db + 6 * v.prio - 18 * Math.max(0, now - v.start - 0.1);
      if (s < best) {
        best = s;
        victim = v;
      }
    }
    const newcomerNear = !local && (dist < far4 || prot.has(emitter));
    if (!victim) {
      if (!local && !newcomerNear) {
        this.counters.dropped++;
        return false;
      }
      let old: Voice | null = null;
      for (const v of vs) if (v.group === group && !v.local && (!old || v.start < old.start)) old = v;
      if (!old) for (const v of vs) if (v.group === group && (!old || v.start < old.start)) old = v;
      if (old) {
        this.kill(old);
        this.counters.stolen++;
      }
      return true;
    }
    if (!local && !newcomerNear && db + 6 * prio < best) {
      this.counters.dropped++;
      return false;
    }
    this.kill(victim);
    this.counters.stolen++;
    return true;
  }

  /** one shooter keeps at most `max` shots ringing: the oldest is choked when the new one lands */
  private limitEmitter(emitter: string, max: number): void {
    const mine = this.live().filter((v) => v.group === "gun" && v.emitter === emitter);
    mine.sort((a, b) => a.start - b.start);
    for (let i = 0; i < mine.length - max + 1; i++) this.kill(mine[i]!);
  }

  /**
   * Open a voice: gain (`gain`, linear) -> [EQ] -> [air / occlusion low-pass -> THE panner] -> bus (+ reverb send).
   * `pos` null = 2D (yours).
   */
  private open(
    group: VGroup,
    bus: BusKey,
    o: { emitter: string; local: boolean; db: number; prio: number; dist: number; gain: number; pos?: [number, number, number] | null; lp?: number; send?: number; lowShelf?: number; tag?: string },
  ): Voice | null {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = o.gain;
    const nodes: AudioNode[] = [out];
    let tail: AudioNode = out;
    if (o.lowShelf) {
      const ls = ctx.createBiquadFilter();
      ls.type = "lowshelf";
      ls.frequency.value = 120;
      ls.gain.value = o.lowShelf;
      tail.connect(ls);
      tail = ls;
      nodes.push(ls);
    }
    if (o.pos) {
      // a stereo take is folded to mono before the panner (HRTF pans one point source; a stereo input would be
      // equal-power panned per channel and add the near ear up to +6 dB)
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = "explicit";
      mono.channelInterpretation = "speakers";
      tail.connect(mono);
      nodes.push(mono);
      tail = mono;
      if (o.lp !== undefined && o.lp < 19000) {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = o.lp;
        lp.Q.value = 0.5;
        tail.connect(lp);
        nodes.push(lp);
        tail = lp;
      }
      const pan = this.opts!.panner(ctx, o.pos[0], o.pos[1], o.pos[2]);
      tail.connect(pan);
      nodes.push(pan);
      tail = pan;
    }
    tail.connect(this.bus![bus]);
    if (o.send !== undefined && o.send > -60 && this.opts!.verb) {
      const s = ctx.createGain();
      s.gain.value = dbg(o.send);
      tail.connect(s);
      s.connect(this.opts!.verb);
      nodes.push(s);
    }
    const t = this.now();
    const v: Voice = { group, emitter: o.emitter, local: o.local, start: t, end: t + 0.05, db: o.db, prio: o.prio, dist: o.dist, at: Infinity, out, srcs: [], nodes, ended: 0, dead: false, tag: o.tag };
    this.voices.push(v);
    this.counters.started++;
    const vs = this.live();
    if (vs.length > this.counters.peakVoices) this.counters.peakVoices = vs.length;
    if (group === "gun") {
      let n = 0;
      for (const x of vs) if (x.group === "gun") n++;
      if (n > this.counters.peakGun) this.counters.peakGun = n;
    }
    return v;
  }

  /** a layer into a voice: `w` linear weight, `db` rel. the group, `delay` s, ± `pitch` semitones, `rate` */
  private layer(v: Voice, group: string, w: number, db: number, delay = 0, pitch = 0, rate = 1, jitter = 0): boolean {
    if (w <= 0.0035) return false;
    const c = this.lib.pick(group, this.rnd);
    if (!c) return false;
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = c.buf;
    const semis = pitch ? (this.rnd() * 2 - 1) * pitch : 0;
    s.playbackRate.value = rate * Math.pow(2, semis / 12);
    const g = ctx.createGain();
    g.gain.value = w * dbg(db + c.g + (this.rnd() - 0.5) * 0.8);
    s.connect(g);
    g.connect(v.out);
    const at = Math.max(ctx.currentTime, this.now() + delay + (jitter ? this.rnd() * jitter : 0));
    s.start(at);
    v.at = Math.min(v.at, at);
    v.srcs.push(s);
    v.nodes.push(g);
    v.end = Math.max(v.end, at + c.buf.duration / s.playbackRate.value + 0.05);
    s.onended = () => {
      if (++v.ended < v.srcs.length) return;
      v.dead = true;
      for (const n of v.nodes) {
        try {
          n.disconnect();
        } catch {
          /* gone */
        }
      }
    };
    return true;
  }

  /** a voice that got no layer (all groups missing / all weights ~0) is closed again */
  private close(v: Voice): boolean {
    if (v.srcs.length) return true;
    v.dead = true;
    try {
      v.out.disconnect();
    } catch {
      /* ok */
    }
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ok */
      }
    }
    return false;
  }

  /** spatial gain of a designed curve through the uniform panner (whose own inverse law it cancels) */
  private spot(d: number, s: Spot): number {
    return s.db + curveDb(d, s.ref, s.a, s.knee * this.scale, s.b);
  }

  private airHz(d: number): number {
    return Math.max(2200, 20000 * Math.exp(-d / (AIR_M * this.scale)));
  }

  // ---------------------------------------------------------------- ducks

  private dip(node: GainNode | null, db: number, at: number, hold: number, rel: number): void {
    if (!node) return;
    const p = node.gain;
    const t = Math.max(at, this.ctx!.currentTime);
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(dbg(db), t, 0.006);
    p.setTargetAtTime(1, t + hold, rel);
  }

  /** your own fire pulls enemy guns, blasts and the ambience back so your shot cuts through */
  private ownDuck(strength: number): void {
    const t = this.now();
    this.dip(this.duck3p, -3.5 * strength, t, 0.07, 0.16);
    this.dip(this.duckW, -2.5 * strength, t, 0.07, 0.16);
    const amb = this.opts?.amb;
    if (amb) {
      const p = amb.gain;
      const tt = Math.max(t, this.ctx!.currentTime);
      p.cancelScheduledValues(tt);
      p.setValueAtTime(p.value, tt);
      p.setTargetAtTime(this.ambBase * dbg(-7 * strength), tt, 0.006);
      p.setTargetAtTime(this.ambBase, tt + 0.07, 0.16);
    }
  }

  /** a confirm's tick owns 15-110 ms after it: enemy guns -6 dB, your gun -6 dB, your hurt -9 dB (KR duckConfirm) */
  private confirmDuck(): void {
    const t = this.now() + 0.015;
    this.dip(this.conf3p, -6, t, 0.085, 0.03);
    this.dip(this.duckOwn, -6, t, 0.085, 0.03);
  }

  // ---------------------------------------------------------------- guns

  /** A shot. `local` = yours (2D, the 1P take); otherwise someone's at (x,y,z) — spatial, banded. */
  shot(weapon: string, x: number, y: number, z: number, local: boolean, src = "?"): boolean {
    if (!this.ctx || !this.bus) return false;
    const gun = gunOf(weapon);
    if (!gun) return false;
    const m = GUN_MIX[gun];
    if (local) {
      if (!this.lib.has(`${gun}/p1`) && !this.lib.has(`${gun}/body`)) return false;
      const lead = this.cadence("local", gun);
      if (lead < 0) return true;
      this.limitEmitter("local", EMITTER_CAP_LOCAL);
      if (!this.admit("gun", true, m.own, 3, 0, "local")) return true;
      const v = this.open("gun", "p1", { emitter: "local", local: true, db: m.own, prio: 3, dist: 0, gain: dbg(m.own + WEAPON_TRIM_DB) })!;
      // the 1P take: no pitch jitter (resampling flattens the 2-4 sample pressure spike); the round robin is the variation
      if (!this.layer(v, `${gun}/p1`, 1, m.p1, lead)) this.layer(v, `${gun}/body`, 1, m.p1, lead);
      this.layer(v, `${gun}/mech`, 1, m.mech, lead + m.mechT, 0.5);
      this.layer(v, `${gun}/tail`, 1, m.tail1p, lead + 0.05, 0.4, 1, 0.004);
      if (gun === "sniper") {
        for (const k of SNIPER_BOLT) this.layer(v, `sniper/bolt-${k.part}`, 1, k.db - 2.3 + 8, lead + k.t, 0.35);
      } else if (this.now() - this.casingExtAt > 5 && this.rnd() < 0.45) {
        // the spent case on the ground — only while no FX stream drives casing() itself
        this.layer(v, "casing", 1, CASING_DB - m.own, lead + m.caseT, 1.5, 1, 0.06);
      }
      this.ownDuck(m.duck);
      return this.close(v);
    }
    if (!this.lib.has(`${gun}/body`) && !this.lib.has(`${gun}/far`)) return false;
    // the body you are riding (spectating a teammate, a killcam): their gun is at your ears — the first-person take
    if (this.dist(x, y, z) < 0.8) return this.shot(weapon, x, y, z, true, src);
    const lead = this.cadence(`shot|${src}`, gun);
    if (lead < 0) return true;
    const S = this.scale;
    const d = this.dist(x, y, z);
    const level = m.hear + curveDb(d, REF_M, m.a, m.knee * S, m.b);
    // DISTANCE BANDS — equal-power crossfades between loudness-matched layers: the curve alone sets the level,
    // the bands the character
    const nearX = smooth(m.near[0] * S, m.near[1] * S, d);
    const farX = smooth(FAR_BAND[0] * S, FAR_BAND[1] * S, d);
    const wNear = Math.cos(HALF_PI * nearX);
    const wFar = Math.sin(HALF_PI * nearX) * Math.cos(HALF_PI * farX);
    const wDist = Math.sin(HALF_PI * farX);
    const wTail = Math.cos(HALF_PI * smooth(TAIL_BAND[0] * S, TAIL_BAND[1] * S, d));
    const ft = FTAIL_BAND;
    const wFt = smooth(ft[0] * S, ft[1] * S, d) * dbg(Math.min(9, ft[2] * Math.log2(Math.max(1, d / (ft[3] * S)))));
    // the rolling tail rising against the report must not add loudness: report² + tail² = curve²
    const ftLin = wFt * dbg(m.ftail);
    const norm = 1 / Math.sqrt(1 + ftLin * ftLin);
    const occl = this.occluder ? this.occluder(x, y, z, d) : false;
    const dbAt = level + (occl ? -m.occlDb : 0);
    this.limitEmitter(src, EMITTER_CAP_REMOTE);
    if (!this.admit("gun", false, dbAt, 2, d, src)) return true;
    const lp = Math.min(this.airHz(d), occl ? m.occlHz : 20000);
    const v = this.open("gun", "p3", {
      emitter: src,
      local: false,
      db: dbAt,
      prio: 2,
      dist: d,
      gain: dbg(dbAt + WEAPON_TRIM_DB) / this.opts!.panLaw(d),
      pos: [x, y, z],
      lp,
      send: m.send,
    })!;
    this.lastBands = { d, near: wNear * norm, far: wFar * norm, dist: wDist * norm, tail: wTail * norm, ftail: wFt * norm * dbg(m.ftail) };
    const body = `${gun}/body`;
    const match = (g: string): number => this.lib.groupP(body) - this.lib.groupP(g);
    this.layer(v, body, wNear * norm, 0, lead, m.pitch);
    this.layer(v, `${gun}/tail`, wTail * norm, m.tail, lead, 0.4, 1, 0.004);
    this.layer(v, `${gun}/far`, wFar * norm, m.far + match(`${gun}/far`), lead, 0.4);
    this.layer(v, `${gun}/dist`, wDist * norm, m.dist + match(`${gun}/dist`), lead, 0.3);
    this.layer(v, `${gun}/far-tail`, wFt * norm, m.ftail + match(`${gun}/far-tail`), lead, 0.3, 1, 0.01);
    if (gun === "sniper") for (const k of SNIPER_BOLT) this.layer(v, `sniper/bolt-${k.part}`, wNear, k.db - 4, lead + k.t, 0.35);
    return this.close(v);
  }

  /**
   * A bullet passing close to your head: the ray from (o) along (d) — the closest approach to the listener under
   * 2.4 m (not from right next to the shooter) whizzes past at that point.
   */
  flyby(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, src = "?"): boolean {
    if (!this.ctx || !this.bus || !this.lib.has("fx/whizz")) return false;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const t = (this.lx - ox) * ux + (this.ly - oy) * uy + (this.lz - oz) * uz;
    if (t < 3 || t > 140) return false;
    const cx = ox + ux * t;
    const cy = oy + uy * t;
    const cz = oz + uz * t;
    const miss = this.dist(cx, cy, cz);
    if (miss > 2.4 || miss < 0.25) return false;
    // stopped by a wall before it got here (the occlusion switch also covers this ray)
    if (this.occluder && traceWorld(ox, oy, oz, ux, uy, uz, t).t < t - 0.3) return false;
    if (!this.gate("whizz", 0.07)) return true;
    const db = FOLEY.whizz - 7 * Math.log2(Math.max(0.6, miss) / 0.6);
    if (!this.admit("whizz", false, db, 2, miss, src)) return true;
    // passes 1.5 m beyond the closest point, so the panner hears it go by
    const v = this.open("whizz", "p3", { emitter: src, local: false, db, prio: 2, dist: miss, gain: dbg(db + WEAPON_TRIM_DB) / this.opts!.panLaw(miss), pos: [cx + ux * 0.8, cy + uy * 0.8, cz + uz * 0.8] })!;
    this.layer(v, "fx/whizz", 1, 0, 0, 1.0);
    return this.close(v);
  }

  // ---------------------------------------------------------------- foley (yours)

  private oneShot2D(group: VGroup, bus: BusKey, g: string, db: number, o: { delay?: number; pitch?: number; rate?: number; tag?: string } = {}): Voice | null {
    if (!this.ctx || !this.bus || !this.lib.has(g)) return null;
    if (!this.admit(group, true, db, 3, 0, "local")) return null;
    const v = this.open(group, bus, { emitter: "local", local: true, db, prio: 3, dist: 0, gain: dbg(db + WEAPON_TRIM_DB), tag: o.tag })!;
    this.layer(v, g, 1, 0, o.delay ?? 0, o.pitch ?? 0, o.rate ?? 1);
    return this.close(v) ? v : null;
  }

  /** Reload foley timed to the sim's reload (`duration` s): tactical vs empty choreography from the reload time. */
  reload(weapon: string, duration: number): boolean {
    const gun = gunOf(weapon);
    if (!gun || !this.ctx || !this.bus) return false;
    const keys = RELOAD_KEYS[gun];
    if (!this.lib.has(keys.tac[0]!.g)) return false;
    this.cancelReload();
    const w = WEAPON_BY_ID[weapon];
    const empty = w ? Math.abs(duration - w.emptyReload) < Math.abs(duration - w.reload) : false;
    const set = empty ? keys.empty : keys.tac;
    // `duration` is what was LEFT when the reload was first seen (a frame / a snapshot in): the keys stay on the sim's
    // full reload timeline, the ones already past are skipped
    const full = w ? (empty ? w.emptyReload : w.reload) : duration;
    const elapsed = Math.max(0, Math.min(full, full - duration));
    for (const k of set) {
      const at = k.u * full - elapsed;
      if (at < -0.03) continue;
      const v = this.oneShot2D("foley", "p1", k.g, RELOAD_DB + (k.db ?? 0), { delay: Math.max(0, at), pitch: 0.25, tag: "reload" });
      if (v) this.reloadVoices.push(v);
    }
    return true;
  }

  /**
   * Someone else's reload, at their position (lead: the sim sends no reload event, so game.ts calls this when a remote
   * body's snapshot `reload` starts). Same keyed choreography as yours, each key a spatial one-shot on SPOT.reload —
   * audible across a room, silent past ~18 m. Placed where the reload began; a 2 s reload does not chase its owner.
   */
  reloadAt(weapon: string, duration: number, x: number, y: number, z: number, src = "?"): boolean {
    const gun = gunOf(weapon);
    if (!gun || !this.ctx || !this.bus) return false;
    if (this.dist(x, y, z) > SPOT.reload.max * this.scale) return true;
    const keys = RELOAD_KEYS[gun];
    const w = WEAPON_BY_ID[weapon];
    const empty = w ? Math.abs(duration - w.emptyReload) < Math.abs(duration - w.reload) : false;
    const set = empty ? keys.empty : keys.tac;
    const full = w ? (empty ? w.emptyReload : w.reload) : duration;
    const elapsed = Math.max(0, Math.min(full, full - duration));
    for (const k of set) {
      const at = k.u * full - elapsed;
      if (at < -0.03) continue;
      this.spatial("foley", k.g, x, y, z, SPOT.reload, `rl|${src}`, { delay: Math.max(0, at), pitch: 0.25, db: k.db ?? 0 });
    }
    return true;
  }

  /** a swap / death cuts whatever of the reload has not sounded yet */
  cancelReload(): void {
    const t = this.now();
    // only what has not sounded yet: a click already in the air finishes
    for (const v of this.reloadVoices) if (!v.dead && v.at > t + 0.005) this.kill(v);
    this.reloadVoices = [];
  }

  /** The raise when the held weapon changes (per weapon: the handling take at its pitch + its own seat click). */
  equip(weapon: string): boolean {
    if (!this.ctx || !this.bus || !this.lib.has("equip")) return false;
    this.cancelReload();
    if (!this.gate("equip", 0.08)) return true;
    const gun = gunOf(weapon);
    const e = EQUIP[gun ?? (weapon === "knife" ? "knife" : "ar")];
    this.oneShot2D("foley", "p1", "equip", EQUIP_DB, { rate: e.rate, pitch: 0.3 });
    const swap = WEAPON_BY_ID[weapon]?.swap ?? 0.5;
    if (e.seat) this.oneShot2D("foley", "p1", e.seat.g, EQUIP_DB + e.seat.db, { delay: e.seat.u * swap, pitch: 0.3 });
    return true;
  }

  /** Called every frame with the local held weapon: a change is a raise; death cancels the reload foley. */
  held(weapon: string, alive: boolean): void {
    if (this.heldAlive && !alive) this.cancelReload();
    if (alive && weapon && weapon !== this.heldId) {
      if (this.heldId) this.equip(weapon);
      this.heldId = weapon;
    }
    this.heldAlive = alive;
  }

  /** dry fire: the trigger on an empty chamber */
  dry(weapon: string): boolean {
    const gun = gunOf(weapon) ?? "ar";
    if (!this.lib.has("dry")) return false;
    if (!this.gate("dry", 0.09)) return true;
    this.oneShot2D("foley", "p1", "dry", DRY_DB, { rate: DRY_RATE[gun], pitch: 0.4 });
    return true;
  }

  /** knife: the blade cutting air (yours, 2D; or someone's at a point) */
  knife(x?: number, y?: number, z?: number, src = "?"): boolean {
    if (!this.ctx || !this.bus || !this.lib.has("knife/swing")) return false;
    if (x === undefined || y === undefined || z === undefined) {
      const t = this.now();
      if (t - this.knifeAt < 0.45) return true;
      this.knifeAt = t;
      this.oneShot2D("foley", "p1", "knife/swing", FOLEY.knife, { pitch: 0.6 });
      return true;
    }
    return this.spatial("foley", "knife/swing", x, y, z, SPOT.knife, src, { pitch: 0.6 });
  }

  /**
   * A spent case landing. No position = yours (close, 2D) — once anything calls that, the engine stops adding its own
   * casing layer to your shots for 5 s (the FX stream owns the timing then); with a position = on the ground there.
   */
  casing(x?: number, y?: number, z?: number, delay = 0): boolean {
    if (!this.ctx || !this.bus || !this.lib.has("casing")) return false;
    if (x === undefined || y === undefined || z === undefined) {
      // YOUR case: from now on the caller owns its timing (the shot stops adding its own for 5 s)
      this.casingExtAt = this.now();
      if (!this.gate("casing", 0.05)) return true;
      this.oneShot2D("casing", "p1", "casing", CASING_DB, { pitch: 1.5 });
      return true;
    }
    return this.spatial("casing", "casing", x, y, z, SPOT.casing, "casing", { pitch: 1.5, delay });
  }

  // ---------------------------------------------------------------- feedback

  /** YOUR hit confirm: body 'tk' / headshot 'dink' / kill thwack. Ducks your gun and enemy guns for its tick. */
  confirm(head: boolean, kill: boolean): boolean {
    if (!this.ctx || !this.bus || !this.lib.has("hit/tick")) return false;
    const def = kill ? CONFIRM.kill : head ? CONFIRM.head : CONFIRM.body;
    if (!this.gate(kill ? "conf-kill" : head ? "conf-head" : "conf", 0.02)) return true;
    if (!this.admit("confirm", true, def.db, 4, 0, "local")) return true;
    const v = this.open("confirm", "ui", { emitter: "local", local: true, db: def.db, prio: 4, dist: 0, gain: dbg(def.db + WEAPON_TRIM_DB) })!;
    for (const l of def.layers) this.layer(v, l.g, 1, l.db, l.delay, l.pitch);
    this.confirmDuck();
    return this.close(v);
  }

  /** YOU took damage: a body blow from the inside */
  hurt(): boolean {
    if (!this.lib.has("hit/hurt")) return false;
    if (!this.gate("hurt", 0.05)) return true;
    this.oneShot2D("confirm", "hurt", "hit/hurt", FOLEY.hurt, { pitch: 0.4 });
    return true;
  }

  /** a bullet into someone near you (flesh slap). Within 1.2 m of you it is YOU — hurt() covers it. */
  flesh(x: number, y: number, z: number, src = "?"): boolean {
    if (!this.lib.has("hit/body")) return false;
    if (this.dist(x, y, z) < 1.2) return true;
    return this.spatial("flesh", "hit/body", x, y, z, SPOT.flesh, src, { pitch: 0.5 });
  }

  /** a bullet hitting the world. `surface` = the FX surface class; unknown = the map's floor / solid default. */
  impact(x: number, y: number, z: number, surface?: string, delay = 0): boolean {
    const mapId = this.mapId;
    const s = surface ?? (y < this.floorY + 0.06 ? (mapId === "dust2" ? "sand" : mapId === "ares" ? "metal" : "dirt") : mapId === "dust2" ? "stone" : mapId === "nuketown" ? "concrete" : "metal");
    const g =
      s === "metal" ? "imp/metal" : s === "wood" ? "imp/wood" : s === "glass" ? "imp/glass" : s === "dirt" || s === "sand" || s === "rubber" || s === "grass" || s === "mud" ? "imp/sand" : s === "flesh" ? "hit/body" : "imp/concrete";
    if (!this.lib.has(g)) return false;
    return this.spatial("impact", g, x, y, z, SPOT.impact, `imp|${g}`, { pitch: 1.2, gap: 0.012, db: IMPACT_DB[g] ?? 0, delay });
  }

  /** a positional one-shot on a designed curve through the uniform panner */
  private spatial(group: VGroup, g: string, x: number, y: number, z: number, s: Spot, src: string, o: { pitch?: number; rate?: number; db?: number; gap?: number; lowShelf?: number; delay?: number } = {}): boolean {
    if (!this.ctx || !this.bus || !this.lib.has(g)) return false;
    const d = this.dist(x, y, z);
    if (d > s.max * this.scale) return true;
    if (o.gap !== undefined && !this.gate(`${group}|${src}`, o.gap)) return true;
    const occl = this.occluder ? this.occluder(x, y, z, d) : false;
    const db = this.spot(d, s) + (o.db ?? 0) + (occl ? -8 : 0);
    if (!this.admit(group, false, db, 1, d, src)) return true;
    const v = this.open(group, "p3", { emitter: src, local: false, db, prio: 1, dist: d, gain: dbg(db + WEAPON_TRIM_DB) / this.opts!.panLaw(d), pos: [x, y, z], lp: Math.min(this.airHz(d), occl ? 1600 : 20000), send: -22, lowShelf: o.lowShelf })!;
    this.layer(v, g, 1, 0, o.delay ?? 0, o.pitch ?? 0, o.rate ?? 1);
    return this.close(v);
  }

  // ---------------------------------------------------------------- frag

  /** frag foley: pin / tick / throw / bounce / empty. `vol`/`rate` keep the game's call-site meaning. */
  nade(kind: "pin" | "tick" | "throw" | "bounce" | "empty", o: { x?: number; y?: number; z?: number; vol?: number; rate?: number; src?: string } = {}): boolean {
    if (!this.ctx || !this.bus) return false;
    const pos = o.x !== undefined && o.z !== undefined;
    switch (kind) {
      case "pin":
        return !!this.oneShot2D("foley", "p1", "nade/pin", FOLEY.pin, { pitch: 0.3 });
      case "tick": {
        // the last second ticks faster and louder (game.ts passes vol 0.34 / rate 1.25 there)
        const db = FOLEY.tick + 20 * Math.log10(Math.max(0.05, o.vol ?? 0.22) / 0.22);
        return !!this.oneShot2D("foley", "p1", "nade/tick", db, { rate: o.rate ?? 1 });
      }
      case "throw":
        if (!pos) return !!this.oneShot2D("foley", "p1", "nade/throw", FOLEY.throw, { pitch: 0.4 });
        return this.spatial("foley", "nade/throw", o.x!, o.y ?? 0, o.z!, SPOT.throw, o.src ?? "nade", { pitch: 0.4 });
      case "bounce": {
        if (!pos) return false;
        // game.ts: vol = 0.1 + k·0.3 with k = impact hardness 0..1
        const k = Math.min(1, Math.max(0, ((o.vol ?? 0.25) - 0.1) / 0.3));
        const g = k > 0.35 && this.lib.has("nade/bounce-hard") ? "nade/bounce-hard" : "nade/bounce-soft";
        return this.spatial("bounce", g, o.x!, o.y ?? 0, o.z!, SPOT.bounce, o.src ?? "nade", { pitch: 0.5, rate: 0.92 + 0.16 * k, db: 20 * Math.log10(0.3 + 0.7 * k), gap: 0.05 });
      }
      case "empty":
        return !!this.oneShot2D("foley", "p1", "dry", FOLEY.empty, { rate: 1.2, pitch: 0.3 });
    }
  }

  /**
   * THE BLAST. Close: the recorded crack + sub thump + debris (with a low-shelf lift for chest), crossfading with
   * range into the far rolling boom (its distant rumble). Within SHOCK_M it shell-shocks: guns go dull for a beat.
   */
  explosion(x: number, y: number, z: number, src = "nade"): boolean {
    if (!this.ctx || !this.bus || (!this.lib.has("exp/near") && !this.lib.has("exp/far"))) return false;
    const S = this.scale;
    const d = this.dist(x, y, z);
    const s = SPOT.boom;
    const occl = this.occluder ? this.occluder(x, y, z, d) : false;
    const db = this.spot(d, s) + (occl ? -5 : 0);
    if (!this.admit("boom", false, db, 3, d, src)) return true;
    const wNear = 1 - smooth(BOOM_NEAR[0] * S, BOOM_NEAR[1] * S, d);
    const wFar = smooth(BOOM_FAR[0] * S, BOOM_FAR[1] * S, d);
    const v = this.open("boom", "world", {
      emitter: src,
      local: false,
      db,
      prio: 3,
      dist: d,
      gain: dbg(db + WEAPON_TRIM_DB) / this.opts!.panLaw(d),
      pos: [x, y, z],
      lp: Math.min(Math.max(1400, 20000 * Math.exp(-d / (160 * S))), occl ? 1500 : 20000),
      send: -12,
      lowShelf: 5 * wNear,
    })!;
    this.layer(v, "exp/near", wNear, 0, 0, 0.5);
    // the far boom: loudness-matched to the near set, +2 dB (it is the low rolling body of the same blast)
    this.layer(v, "exp/far", wFar, 2 + this.lib.groupP("exp/near") - this.lib.groupP("exp/far"), 0, 0.5);
    // the blast owns the mix while it decays
    const own = Math.max(0, 1 - d / (24 * S));
    if (own > 0.05) {
      const t = this.now();
      this.dip(this.duck3p, -6 * own, t, 0.25, 0.12);
      this.dip(this.duckOwn, -4 * own, t, 0.2, 0.12);
    }
    if (d < SHOCK_M * S && this.shock) {
      const t = Math.max(this.now(), this.ctx.currentTime);
      const f = this.shock.frequency;
      const k = 1 - d / (SHOCK_M * S);
      f.cancelScheduledValues(t);
      f.setValueAtTime(f.value, t);
      f.setTargetAtTime(700 + 2600 * (1 - k), t + 0.01, 0.02);
      f.setTargetAtTime(this.ctx.sampleRate / 2, t + 0.35 + 0.5 * k, 0.35);
    }
    return this.close(v);
  }

  /** every gun the bank can voice is decoded */
  gunsReady(): boolean {
    return GUN_IDS.every((g) => this.lib.has(`${g}/p1`) || this.lib.has(`${g}/body`));
  }
}
