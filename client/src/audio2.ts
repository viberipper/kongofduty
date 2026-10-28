/**
 * AudioRig2 — the game's one audio engine. Warm, cartoon-jungle, zero ear-bleed.
 *
 * TWO SOURCES, ONE CHAIN.
 *   SYNTH  — everything is baked at boot from a SEEDED rng (deterministic).
 *   PACKS  — one of the four measured sample packs (audio-packs.ts) supplies the
 *            buffer for any event it carries; anything it does not carry falls
 *            through to the synth family of the same name.
 * Both go through the SAME play(): HRTF panner + distance lowpass, category
 * buses, a shared small-yard convolver, a gentle compressor, and a hard -1dBFS
 * ceiling. Swapping packs can never change the spatialisation or the mix rules,
 * only the timbre — which is the whole point of the A/B.
 *
 * WEAPONS (weapons stream). Every gun, reload, raise, dry click, casing, knife,
 * frag, explosion, hit confirm, damage thud and bullet impact is the RECORDED
 * set (static/assets/audio/weapons/, Kong Royale's library) played by
 * weapons/audio-engine.ts with the mix in weapons/audio-bank.ts — its own
 * layered voices, distance bands and voice limits, into this rig's master
 * stage. The synth guns below are only the fallback while (or if) the samples
 * fail to decode. The master stage itself is KR's glue + true-peak limiter
 * worklet (weapons/audio-master.ts) once it loads; the DynamicsCompressor
 * chain buildGraph() wires is its fallback.
 *
 * SR is the BAKE rate for the synth buffers. It is NOT the context rate: real
 * devices report 44.1 kHz as often as 48 kHz. BufferSources resample themselves,
 * but a ConvolverNode legally refuses an IR whose rate differs from the context,
 * so the reverb IR is built at ctx.sampleRate in buildGraph() — see irBuffer().
 */

import { SamplePack, readPackPref, loudness, SYNTH_ONLY, PACK_OPTIONS } from "./audio-packs";
import { activeMap } from "@shared/maps";
import { hasUserGesture, onFirstGesture, GESTURE_EVENTS } from "./audio-unlock";
import { bootStage } from "./bootstage";
import { PRIMARY_WEAPON_ID } from "@shared/weapons";
import { footstepMix, STEP_VOICES, type FootSurface, type FootstepStyle } from "./footsteps";
import { WeaponAudio, WeaponLibrary, type WeaponAudioStats } from "./weapons/audio-engine";
import { upgradeMaster } from "./weapons/audio-master";
import { GUN_IDS } from "./weapons/audio-bank";
import { surfaceOf } from "./weapons/fx/surface";
import { groundHeight, type OBB } from "@shared/map";
import { assetUrl } from "./asset-base";

/** Gunfire and ambience reach scale with the world; footstep reach does not. */
const MAP_SCALE = activeMap().audioScale;
const ORBITAL = activeMap().id === "ares";

const SR = 48000;
const CEIL = 0.891; // -1 dBFS ceiling for the final soft clipper

/**
 * Beyond this, another player's gunfire swaps to the DISTANT variant: a
 * lowpassed report with a long tail instead of a near-field crack. This is the
 * anti-"same noise x25" lever — in a 10-bot firefight most shots are far, and
 * far shots are a different, softer, more diffuse sound that sits behind the
 * ones that matter instead of stacking 25 identical transients on the bus.
 *
 * 20 m on a 33 m yard: a fight inside a container row is still in your face,
 * a shot from the far corner is a report. Set this too low (14 m was measured
 * at 21 distant to 2 near in a 9-bot match) and nothing in the yard ever
 * sounds close, which is the same flattening in the other direction.
 */
const FAR_M = 20 * MAP_SCALE;

/**
 * ONE panner configuration for every emitter in the game. Direction and
 * distance are the panner's job and nothing else's — a second panner profile
 * would mean two different worlds coexisting, and qa/sound-spatial verifies
 * this uniformity (panner-config).
 */
// REF_M is the near-field reference the inverse law is anchored at — how loud a
// thing is when it is CLOSE, which does not change with the size of the map, so
// it does not scale. MAX_M and CULL_M are reach, and they do.
const REF_M = 5;
const MAX_M = 46 * MAP_SCALE;
const ROLLOFF = 1.2;
/** Past this, play() drops the voice entirely. */
const CULL_M = 42 * MAP_SCALE;

/** inverse distance model, exactly as the PannerNode computes it. */
function inverseGain(d: number, ref: number, rolloff: number, max: number): number {
  const dd = Math.min(Math.max(d, ref), max);
  return ref / (ref + rolloff * (dd - ref));
}

/** Per-event voice ceilings (checked before the per-bus ceilings). */
const EVENT_CAP: Record<string, number> = {
  "gun-m4a1": 5,
  "gun-m4a1-far": 6,
  "nade-bounce": 3,
  hurt: 2,
};

/**
 * Minimum gap between two plays of the SAME event from the SAME emitter, ms.
 * Keyed per emitter, so ten bots firing on one tick are ten voices (a firefight
 * should sound like ten guns) while one gun cannot double-trigger itself.
 */
const GUARD_MS: Record<string, number> = {
  step: 150,
  "step-metal": 150,
  land: 150,
  hit: 40,
};

type Rng = () => number;

function lcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// ---------------------------------------------------------------------------
// DSP toolbox (operates on mono Float32Array sample buffers)
// ---------------------------------------------------------------------------

function ramp(t: number, atk: number): number {
  return t >= atk ? 1 : t / atk;
}

function lowpass(x: Float32Array, fc: number, passes = 1): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let out = x;
  for (let p = 0; p < passes; p++) {
    const y = new Float32Array(out.length);
    let acc = 0;
    for (let i = 0; i < out.length; i++) {
      acc += a * (out[i]! - acc);
      y[i] = acc;
    }
    out = y;
  }
  return out;
}

function highpass(x: Float32Array, fc: number): Float32Array {
  const lp = lowpass(x, fc);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i]! - lp[i]!;
  return y;
}

function bandpass(x: Float32Array, fc: number, q: number): Float32Array {
  const w0 = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = (b0 / a0) * xi + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

function softClip(x: Float32Array, drive: number): Float32Array {
  const y = new Float32Array(x.length);
  const norm = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) y[i] = Math.tanh(x[i]! * drive) / norm;
  return y;
}

function normalize(x: Float32Array, peak: number): Float32Array {
  let m = 1e-9;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  const g = peak / m;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i]! * g;
  return y;
}

function mix(into: Float32Array, from: Float32Array, gain = 1, offset = 0): void {
  const o = Math.floor(offset * SR);
  for (let i = 0; i < from.length && i + o < into.length; i++) into[i + o]! += from[i]! * gain;
}

function noise(n: number, rng: Rng): Float32Array {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = rng() * 2 - 1;
  return y;
}

/** Raised-cosine fade to exactly zero over the final `sec` — kills truncation clicks. */
function fadeTail(x: Float32Array, sec = 0.025): Float32Array {
  const n = x.length;
  const m = Math.min(n, Math.floor(sec * SR));
  for (let i = 0; i < m; i++) {
    const a = 0.5 + 0.5 * Math.cos((Math.PI * i) / m); // 1 → 0
    x[n - m + i] = x[n - m + i]! * a;
  }
  return x;
}

type F32 = Float32Array<ArrayBuffer>;

function monoBuffer(data: Float32Array): AudioBuffer {
  const b = new AudioBuffer({ numberOfChannels: 1, length: data.length, sampleRate: SR });
  b.copyToChannel(data as F32, 0);
  return b;
}

function stereoBuffer(l: Float32Array, r: Float32Array): AudioBuffer {
  const b = new AudioBuffer({ numberOfChannels: 2, length: Math.max(l.length, r.length), sampleRate: SR });
  b.copyToChannel(l as F32, 0);
  b.copyToChannel(r as F32, 1);
  return b;
}

/** Linear resample of a mono track baked at SR onto `rate`. Only the reverb IR
 *  needs this (BufferSources resample themselves); a reverb tail has no
 *  transient worth a windowed-sinc, so linear is honest and cheap. */
function resampleTo(x: Float32Array, rate: number): Float32Array {
  if (rate === SR) return x;
  const n = Math.max(1, Math.round((x.length * rate) / SR));
  const y = new Float32Array(n);
  const step = (x.length - 1) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const s = i * step;
    const i0 = Math.floor(s);
    const i1 = Math.min(x.length - 1, i0 + 1);
    const f = s - i0;
    y[i] = x[i0]! * (1 - f) + x[i1]! * f;
  }
  return y;
}

/**
 * A stereo IR built AT THE CONTEXT'S RATE. Handing a ConvolverNode a buffer of
 * a different rate throws ("buffer sample rate ... does not match the context
 * rate"), which used to reject boot() — and therefore game.start() — on every
 * 44.1 kHz output device. Measured by qa/sound-spatial (samplerate-portability).
 */
function irBuffer(ctx: BaseAudioContext, l: Float32Array, r: Float32Array): AudioBuffer {
  const rate = ctx.sampleRate;
  const ll = resampleTo(l, rate);
  const rr = resampleTo(r, rate);
  const b = ctx.createBuffer(2, Math.max(ll.length, rr.length), rate);
  b.copyToChannel(ll as F32, 0);
  b.copyToChannel(rr as F32, 1);
  return b;
}

// ---------------------------------------------------------------------------
// Instrument synthesis
// ---------------------------------------------------------------------------

type GunParams = {
  f0: number; // body fundamental
  bodyTau: number;
  crackFc: number;
  crackAmt: number;
  tailTau: number;
  tailAmt: number;
  dur: number;
  punch: number;
  /** 725: second staggered impulse ~30ms later */
  double?: boolean;
  /** m590: pump-action foley baked into the tail */
  pump?: boolean;
  /** high-pass the body (thin SMG voice) */
  thinBody?: boolean;
  /** scale on the 3.1kHz presence layer (class-separation lever) */
  thwipMul?: number;
  /** quiet 2.5-3.5kHz mechanical attack tick (<15ms, ~-20dB rel) */
  tick?: boolean;
  /** +2dB 250Hz thump layer */
  thump?: boolean;
  /** m40a3: two-part bolt-cycle clack-clack after the boom decays */
  bolt?: boolean;
  /** scale on the 1.9kHz mech layer */
  mechMul?: number;
  /** crack bandpass Q (narrow = darker, fewer skirts) */
  crackQ?: number;
};

// Class-distinct recipes: same-class weapons differ ≥15% in duration and
// ≥300Hz in measured centroid (review r1 requirement).
const GUNS: Record<string, GunParams> = {
  "gun-m4a1": { f0: 96, bodyTau: 0.1, crackFc: 880, crackAmt: 0.75, tailTau: 0.085, tailAmt: 0.5, dur: 0.42, punch: 0.92, tick: true, thwipMul: 1.6 },
  "gun-ak47": { f0: 76, bodyTau: 0.14, crackFc: 330, crackAmt: 0.6, crackQ: 3.2, thwipMul: 0.15, mechMul: 0.25, tailTau: 0.13, tailAmt: 0.7, dur: 0.64, punch: 1.75, thump: true },
  "gun-mp5": { f0: 118, bodyTau: 0.085, crackFc: 460, crackAmt: 0.55, tailTau: 0.075, tailAmt: 0.5, dur: 0.48, punch: 1.55, thwipMul: 0.45 },
  "gun-mp7": { f0: 186, bodyTau: 0.05, crackFc: 560, crackAmt: 0.74, tailTau: 0.038, tailAmt: 0.3, dur: 0.27, punch: 1.05, thinBody: true, thwipMul: 0.65 },
  "gun-m590": { f0: 70, bodyTau: 0.13, crackFc: 1700, crackAmt: 1.42, tailTau: 0.09, tailAmt: 0.62, dur: 0.5, punch: 1.12, pump: true, thwipMul: 1.5 },
  "gun-725": { f0: 54, bodyTau: 0.2, crackFc: 260, crackAmt: 0.4, thwipMul: 0.35, tailTau: 0.24, tailAmt: 0.85, dur: 0.95, punch: 1.72, double: true },
  "gun-m40a3": { f0: 56, bodyTau: 0.22, crackFc: 380, crackAmt: 0.62, crackQ: 2.6, thwipMul: 0.35, mechMul: 0.3, tailTau: 0.3, tailAmt: 0.95, dur: 1.0, punch: 1.9, thump: true, bolt: true },
  "gun-m1911": { f0: 112, bodyTau: 0.045, crackFc: 660, crackAmt: 0.72, tailTau: 0.06, tailAmt: 0.36, dur: 0.3, punch: 1.12 },
};

/** Per-(gun,variant) round-robin signature. Each gun permutes and jitters the
 *  same base pitch/length offset magnitudes differently, so no two guns share
 *  a soft/LOUD/mid variant ordering (one global table reads as a repeating
 *  4-shot pulse in full-auto). Slot 0 stays the neutral calibration reference. */
function variantSig(gunSeed: number, vIdx: number): { sc: number; sd: number } {
  const v = vIdx % 4;
  if (v === 0) return { sc: 0, sd: 0 };
  const r = lcg((gunSeed ^ 0x51ed270b) >>> 0);
  const order = [0, 1, 2];
  for (let i = 2; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const jit = [0.78 + r() * 0.44, 0.78 + r() * 0.44, 0.78 + r() * 0.44];
  const k = order[v - 1]!;
  const SC = [-1.5, 1.5, -0.8];
  const SD = [-0.08, 0.08, -0.04];
  return { sc: SC[k]! * jit[v - 1]!, sd: SD[k]! * jit[v - 1]! };
}

function gunWave(rng: Rng, p: GunParams, vIdx = 0, gunSeed = 0): Float32Array {
  // Round-robin identity: ±40-cent pitch and decay jitter, permuted per gun.
  const { sc, sd } = variantSig(gunSeed, vIdx);
  const n = Math.floor(p.dur * (1 + sd * (p.dur < 0.3 ? 2 : 1)) * SR);
  const out = new Float32Array(n);
  const cents = sc * 26.7; // -40..+40
  const pMul = Math.pow(2, cents / 1200);
  const tMul = 1 + sc * (p.dur < 0.3 ? 0.12 : 0.09);
  const tailAmtV = p.tailAmt * (1 + sc * (p.dur < 0.3 ? 0.35 : 0.1));
  const f0 = p.f0 * pMul * (0.98 + rng() * 0.04);
  const bodyTau = p.bodyTau * tMul;
  const tailTau = p.tailTau * tMul;

  const gaps = [0.03, 0.022, 0.04, 0.026];
  const impulses: [number, number][] = p.double ? [[0, 1], [gaps[vIdx % 4]!, 0.85]] : [[0, 1]];

  for (const [at, gAmp] of impulses) {
    // body: soft-attack "POMP" — pitched drop thump (continuous exponential decay)
    let phase = 0;
    const body = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = f0 * (1 + 1.15 * Math.exp(-t / 0.03));
      phase += (2 * Math.PI * f) / SR;
      const s2 = Math.sin(phase) + (p.double ? 0.3 : 0.16) * (1 + sc * 0.75) * Math.sin(2 * phase);
      body[i] = s2 * ramp(t, 0.0045) * Math.exp(-t / bodyTau) * p.punch;
    }
    const bodyOut = p.thinBody ? highpass(body, 100) : body;
    mix(out, bodyOut, (p.double ? 1.15 : 0.9) * gAmp, at);

    // puff-crack: band-passed noise with a gentle attack ramp (no click)
    let crack = bandpass(noise(n, rng), p.crackFc * pMul * (1 + sc * 0.14) * (0.96 + rng() * 0.08), p.crackQ ?? 1.1);
    const ck = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ck[i] = crack[i]! * ramp(t, 0.005) * Math.exp(-t / (0.048 * tMul));
    }
    crack = ck;
    mix(out, normalize(crack, 1), p.crackAmt * 0.55 * gAmp, at);
  }

  // tail: lowpassed noise wash, equal-power crossfaded in as the body decays
  // (fades in over ~80ms so there is no butt-joint seam)
  let tail = lowpass(noise(n, rng), 950 * (1 + sc * 0.3), 3);
  const tl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const fadeIn = Math.sin(Math.min(1, t / 0.08) * Math.PI * 0.5);
    tl[i] = tail[i]! * fadeIn * Math.exp(-t / tailTau);
  }
  tail = tl;
  mix(out, normalize(tail, 1), tailAmtV * 0.4);

  // upper-mid "thwip" so shots keep presence at distance (target hf 1-3%)
  let thw = bandpass(noise(Math.floor(0.04 * SR), rng), 3100 * pMul, 1.4);
  thw = normalize(thw, 1);
  const tw = new Float32Array(thw.length);
  for (let i = 0; i < thw.length; i++) {
    const t = i / SR;
    tw[i] = thw[i]! * ramp(t, 0.004) * Math.exp(-t / 0.014);
  }
  mix(out, tw, 0.085 * (p.thwipMul ?? 1) * (1 + sc * 0.45) * Math.min(1, p.dur / 0.5), 0.002);

  // mechanical attack tick (m4a1 identity): 3kHz, <15ms, quiet
  if (p.tick) {
    let tk = bandpass(noise(Math.floor(0.014 * SR), rng), 2900, 1.8);
    tk = normalize(tk, 1);
    const tko = new Float32Array(tk.length);
    for (let i = 0; i < tk.length; i++) {
      const t = i / SR;
      tko[i] = tk[i]! * ramp(t, 0.0015) * Math.exp(-t / 0.005);
    }
    mix(out, tko, 0.26, 0.001);
  }
  // 250Hz thump layer (ak47 identity)
  if (p.thump) {
    const th = new Float32Array(Math.floor(0.12 * SR));
    for (let i = 0; i < th.length; i++) {
      const t = i / SR;
      th[i] = Math.sin(2 * Math.PI * 250 * t) * ramp(t, 0.004) * Math.exp(-t / 0.045);
    }
    mix(out, th, 0.5);
  }

  // soft mech layer
  let mech = bandpass(noise(Math.floor(0.03 * SR), rng), 1900, 2.2);
  mech = normalize(mech, 1);
  const mk = new Float32Array(mech.length);
  for (let i = 0; i < mech.length; i++) {
    const t = i / SR;
    mk[i] = mech[i]! * ramp(t, 0.003) * Math.exp(-t / 0.012);
  }
  mix(out, mk, 0.1 * (p.mechMul ?? 1), 0.013);

  // m590 pump-action foley in the tail
  if (p.pump) {
    for (const [at, fc] of [[0.3, 820], [0.38, 1150]] as [number, number][]) {
      let ck2 = bandpass(noise(Math.floor(0.05 * SR), rng), fc, 2.2);
      ck2 = normalize(ck2, 1);
      const c2 = new Float32Array(ck2.length);
      for (let i = 0; i < ck2.length; i++) {
        const t = i / SR;
        c2[i] = ck2[i]! * ramp(t, 0.004) * Math.exp(-t / 0.018);
      }
      mix(out, lowpass(c2, 3600), 0.16, at);
    }
  }

  // m40a3 bolt-cycle: two metallic clack transients riding the tail, each a
  // noise burst plus a short ring so they read as worked steel, not clicks.
  if (p.bolt) {
    for (const [at, fc, amp] of [[0.34, 980, 0.26], [0.45, 1320, 0.2]] as [number, number, number][]) {
      let ck3 = bandpass(noise(Math.floor(0.06 * SR), rng), fc, 2.6);
      ck3 = normalize(ck3, 1);
      const c3 = new Float32Array(ck3.length);
      const ringF = fc * 0.55;
      for (let i = 0; i < ck3.length; i++) {
        const t = i / SR;
        c3[i] = (ck3[i]! * Math.exp(-t / 0.014) + 0.5 * Math.sin(2 * Math.PI * ringF * t) * Math.exp(-t / 0.03)) * ramp(t, 0.003);
      }
      mix(out, lowpass(c3, 3800), amp, at);
    }
  }

  return fadeTail(normalize(lowpass(softClip(normalize(out, 1), 1.1), 6800, 2), 0.7), 0.02);
}

/** Marimba-ish pluck: warm partials + tiny mallet tick. */
function marimba(rng: Rng, f: number, dur = 0.45, bright = 0.22): Float32Array {
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = ramp(t, 0.002) * Math.exp(-t / 0.16);
    out[i] =
      (Math.sin(2 * Math.PI * f * t) +
        bright * Math.sin(2 * Math.PI * f * 3.92 * t) * Math.exp(-t / 0.05) +
        0.06 * Math.sin(2 * Math.PI * f * 9.1 * t) * Math.exp(-t / 0.02)) *
      env;
  }
  let tick = bandpass(noise(Math.floor(0.012 * SR), rng), 1700, 2);
  tick = normalize(tick, 1);
  const tk = new Float32Array(tick.length);
  for (let i = 0; i < tick.length; i++) tk[i] = tick[i]! * Math.exp(-(i / SR) / 0.004);
  mix(out, tk, 0.08);
  return fadeTail(normalize(lowpass(out, 7000), 0.62), 0.03);
}

/** A-major pentatonic ladder. */
const PENTA = [440, 493.88, 554.37, 659.25, 739.99, 880, 1108.73, 1318.51];

function sequence(notes: { f: number; at: number; amp?: number; dur?: number }[], total: number, rng: Rng, peak = 0.55): [Float32Array, Float32Array] {
  const n = Math.floor(total * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (const nt of notes) {
    const w = marimba(rng, nt.f, nt.dur ?? 0.45);
    const pan = (rng() - 0.5) * 0.35;
    mix(l, w, (nt.amp ?? 1) * (0.5 - pan), nt.at);
    mix(r, w, (nt.amp ?? 1) * (0.5 + pan), nt.at);
  }
  return [fadeTail(normalize(l, peak), 0.03), fadeTail(normalize(r, peak), 0.03)];
}

function sparkle(rng: Rng, at: number, l: Float32Array, r: Float32Array): void {
  for (let k = 0; k < 3; k++) {
    const f = PENTA[5 + k]!;
    const w = marimba(rng, f, 0.5, 0.12);
    mix(l, w, 0.16, at + k * 0.045);
    mix(r, w, 0.16, at + k * 0.055);
  }
}

/** Bird chirp: 2-4 gentle FM notes. */
function birdChirp(rng: Rng): Float32Array {
  const notes = 2 + Math.floor(rng() * 3);
  const total = 0.12 * notes + 0.15;
  const n = Math.floor(total * SR);
  const out = new Float32Array(n);
  let at = 0;
  for (let k = 0; k < notes; k++) {
    const dur = 0.06 + rng() * 0.07;
    const f0 = 1900 + rng() * 900;
    const f1 = f0 * (0.85 + rng() * 0.4);
    const m = Math.floor(dur * SR);
    const w = new Float32Array(m);
    let ph = 0;
    for (let i = 0; i < m; i++) {
      const t = i / SR;
      const prog = i / m;
      const f = f0 + (f1 - f0) * prog + Math.sin(2 * Math.PI * 38 * t) * 60;
      ph += (2 * Math.PI * f) / SR;
      w[i] = Math.sin(ph) * Math.sin(Math.PI * prog) * 0.9;
    }
    mix(out, w, 1, at);
    at += dur + 0.04 + rng() * 0.05;
  }
  return normalize(lowpass(out, 4200), 0.34);
}

function windBed(rng: Rng): [Float32Array, Float32Array] {
  const dur = 8;
  const n = dur * SR;
  const mk = (seedOff: number): Float32Array => {
    const r2 = lcg(1234 + seedOff);
    let x = lowpass(noise(n, r2), 480, 2);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const lfo = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.06 * t + seedOff * 2.1);
      const lfo2 = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.017 * t + seedOff);
      y[i] = x[i]! * lfo * lfo2;
    }
    // make it loop-clean
    const fade = Math.floor(0.5 * SR);
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      y[i] = y[i]! * a + y[n - fade + i]! * (1 - a);
    }
    return normalize(y.subarray(0, n - fade) as Float32Array, 0.16);
  };
  void rng;
  return [mk(0), mk(7)];
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

type PlayOpts = {
  vol?: number;
  rate?: number;
  x?: number;
  y?: number;
  z?: number;
  /** Emitter identity (player id, frag id...). Scopes the same-event cooldown
   *  so distinct sources never mute each other. */
  src?: string;
  step?: FootstepStyle;
};
type BusName = "guns" | "steps" | "ui" | "amb" | "vfx";

type Family = { variants: AudioBuffer[]; bus: BusName; baseVol: number; send: number };

export class AudioRig2 {
  ctx: AudioContext | null = null;
  master!: GainNode;
  buses!: Record<BusName, GainNode>;
  comp!: DynamicsCompressorNode;
  shaper!: WaveShaperNode;
  verb!: ConvolverNode;
  verbGain!: GainNode;
  ready = false;
  baked = false;
  families = new Map<string, Family>();
  lastVariant = new Map<string, number>();
  lastPlayAt = new Map<string, number>();
  listenerX = 0;
  listenerY = 0;
  listenerZ = 0;
  yaw = 0;
  vol = 0.62;
  ambStarted = false;
  /**
   * matchStart() arrived while !ready (deep-link deploy before the first
   * gesture): replayed at the end of the deferred boot so the sting is queued,
   * not dropped, when play() still early-returns.
   */
  private wantMatchStart = false;
  nextBird = 5;
  nextInsect = 9;
  activeGuns: { src: AudioBufferSourceNode; dist: number }[] = [];
  activeSteps: { src: AudioBufferSourceNode; gain: GainNode; priority: number; emitter: string }[] = [];
  activeTotal = 0;
  irL!: Float32Array;
  irR!: Float32Array;

  // ---------------- baking ----------------

  ensureBaked(): void {
    if (this.baked) return;
    this.baked = true;
    const rng = lcg(20260815);
    const fam = (name: string, bus: BusName, baseVol: number, send: number, variants: Float32Array[] | [Float32Array, Float32Array][]): void => {
      const bufs = variants.map((v) =>
        Array.isArray(v) ? stereoBuffer(fadeTail(v[0]), fadeTail(v[1])) : monoBuffer(fadeTail(v)),
      );
      this.families.set(name, { variants: bufs, bus, baseVol, send });
    };

    // guns — 4 variants each
    const rmsOf = (x: Float32Array): number => {
      let e = 0;
      for (let i = 0; i < x.length; i++) e += x[i]! * x[i]!;
      return Math.sqrt(e / Math.max(1, x.length));
    };
    for (const [name, p] of Object.entries(GUNS)) {
      const send = name === "gun-m1911" || name === "gun-mp7" ? 0.07 : name === "gun-ak47" ? 0.08 : name === "gun-mp5" ? 0.09 : 0.16;
      // Per-gun seeded stream: retuning one weapon can never reshuffle another's noise.
      let h = 0;
      for (let ci = 0; ci < name.length; ci++) h = (h * 31 + name.charCodeAt(ci)) >>> 0;
      const grng = lcg(h ^ 0x9e3779b9);
      const vs = [gunWave(grng, p, 0, h), gunWave(grng, p, 1, h), gunWave(grng, p, 2, h), gunWave(grng, p, 3, h)];
      // Equalize variant loudness (RMS) so round-robin never reads as a
      // crescendo; identity comes from pitch/length/timbre, not level.
      // Equalize variant loudness (RMS, referenced to slot 0) so round-robin
      // never reads as a crescendo; identity comes from pitch/length/timbre.
      const ref = rmsOf(vs[0]!);
      const peakOf = (x: Float32Array): number => {
        let m = 1e-6;
        for (let k = 0; k < x.length; k++) m = Math.max(m, Math.abs(x[k]!));
        return m;
      };
      const refPeak = peakOf(vs[0]!);
      const eq = vs.map((v, i) => {
        // Short guns render below the compressor threshold, so exact buffer-peak
        // equality gives render-peak equality; longer guns equalize by RMS.
        const g =
          i === 0
            ? 1
            : p.dur < 0.3
              ? refPeak / peakOf(v)
              : Math.min(1.35, Math.max(0.75, ref / Math.max(1e-6, rmsOf(v))));
        const gc = Math.min(g, 0.92 / peakOf(v));
        const y = new Float32Array(v.length);
        for (let k = 0; k < v.length; k++) y[k] = v[k]! * gc;
        return y;
      });
      // Sniper sits ~1.5dB over the ARs — the class that should own the mix.
      fam(name, "guns", name === "gun-m40a3" ? 1.18 : 1, send, eq);

      // DISTANT report. Past FAR_M another player's shot stops being a crack in
      // your face and becomes a dull thump with a long air-absorbed tail. This
      // is what stops a 10-bot firefight reading as the same transient x25:
      // most of those shots are far, and far is a genuinely different sound.
      const farOf = (v: Float32Array): Float32Array => {
        const tailN = Math.floor(0.55 * SR);
        const n = Math.max(v.length, tailN);
        const y = new Float32Array(n);
        // body: two lowpass passes + a high-pass to hollow out the crack
        const body = lowpass(highpass(v, 55), 780, 2);
        mix(y, body, 1);
        // tail: the yard answering, arriving a few ms late and decaying slowly
        const nz = lowpass(noise(tailN, rng), 620, 2);
        const tl = new Float32Array(tailN);
        for (let i = 0; i < tailN; i++) {
          const t = i / SR;
          tl[i] = nz[i]! * (1 - Math.exp(-t / 0.012)) * Math.exp(-t / 0.16);
        }
        mix(y, normalize(tl, 1), 0.34, 0.008);
        return fadeTail(normalize(lowpass(y, 1500), 0.55), 0.05);
      };
      fam(name + "-far", "guns", 1.3, Math.min(0.3, send * 1.8), [farOf(eq[0]!), farOf(eq[1]!), farOf(eq[2]!), farOf(eq[3]!)]);
    }
    if (ORBITAL) {
      const hum = new Float32Array(SR * 4);
      for (let i = 0; i < hum.length; i++) { const t=i/SR; hum[i]=(Math.sin(t*Math.PI*2*55)*0.034+Math.sin(t*Math.PI*2*110)*0.014+Math.sin(t*Math.PI*2*83)*0.006)*(0.88+0.12*Math.cos(t*Math.PI/2)); }
      fam("orbital-room", "amb", 1, 0, [hum]);
    }
    // knife whoosh as its gun sound
    const kn = (): Float32Array => {
      const n = Math.floor(0.22 * SR);
      let x = bandpass(noise(n, rng), 380 + rng() * 120, 0.9);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = x[i]! * Math.sin(Math.PI * (i / n)) * ramp(t, 0.02);
      }
      return normalize(lowpass(y, 1200, 3), 0.3);
    };
    fam("gun-knife", "guns", 0.8, 0.05, [kn(), kn(), kn()]);

    // soft mech layers
    const mechTick = (fc: number, dur: number, tau: number): Float32Array => {
      const n = Math.floor(dur * SR);
      let x = bandpass(noise(n, rng), fc, 2);
      x = normalize(x, 1);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = x[i]! * ramp(t, 0.004) * Math.exp(-t / tau);
      }
      return normalize(lowpass(y, 5200), 0.28);
    };
    fam("mech-rifle", "guns", 0.5, 0, [mechTick(1500, 0.05, 0.014), mechTick(1650, 0.05, 0.013)]);
    fam("mech-shot", "guns", 0.6, 0, [mechTick(700, 0.16, 0.05), mechTick(760, 0.16, 0.05)]);
    fam("mech-bolt", "guns", 0.6, 0, [mechTick(900, 0.18, 0.06), mechTick(860, 0.18, 0.06)]);
    fam("mech-knife", "guns", 0.5, 0, [mechTick(2100, 0.05, 0.015)]);

    // feedback: woodblock family (consonant, warm)
    const woodblock = (f: number, bright: number): Float32Array => {
      const n = Math.floor(0.1 * SR);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] =
          (Math.sin(2 * Math.PI * f * t) + bright * Math.sin(2 * Math.PI * f * 2.76 * t)) *
          ramp(t, 0.0015) *
          Math.exp(-t / 0.022);
      }
      // band-passed noise click under the partials so it never reads as a raw sine
      let tick = normalize(bandpass(noise(Math.floor(0.01 * SR), rng), 2800, 1.6), 1);
      const tk = new Float32Array(tick.length);
      for (let i = 0; i < tick.length; i++) tk[i] = tick[i]! * ramp(i / SR, 0.001) * Math.exp(-(i / SR) / 0.0045);
      mix(y, tk, 0.32);
      return fadeTail(normalize(lowpass(y, 6800), 0.95), 0.02);
    };
    fam("hit", "ui", 6, 0, [woodblock(820, 0.3), woodblock(790, 0.32), woodblock(850, 0.28), woodblock(805, 0.3)]);
    fam("headshot", "ui", 6.2, 0, [woodblock(1220, 0.42), woodblock(1180, 0.44), woodblock(1260, 0.4)]);
    const killPluck = (): [Float32Array, Float32Array] => {
      return sequence(
        [
          { f: PENTA[7]!, at: 0, dur: 0.22 },
          { f: PENTA[5]! * 2, at: 0.085, dur: 0.42, amp: 1.1 },
        ],
        0.62,
        rng,
      );
    };
    fam("kill", "ui", 1.1, 0, [killPluck(), killPluck(), killPluck()]);

    // body feedback
    const thud = (f: number, dur: number, noiseAmt: number, noiseFc: number): Float32Array => {
      const n = Math.floor(dur * SR);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const fr = f * (1 + 0.5 * Math.exp(-t / 0.02));
        y[i] = Math.sin(2 * Math.PI * fr * t) * ramp(t, 0.004) * Math.exp(-t / (dur * 0.3));
      }
      let ns = lowpass(noise(n, rng), noiseFc);
      const nz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        nz[i] = ns[i]! * ramp(t, 0.006) * Math.exp(-t / (dur * 0.25));
      }
      mix(y, normalize(nz, 1), noiseAmt);
      return normalize(lowpass(y, 5000), 0.5);
    };
    // Player damage-taken: LF thump + mid knock, mixed HOT — a survival-critical
    // cue that must read through a firefight, not sit 15dB under the guns.
    const hurtWave = (f: number, knockF: number): Float32Array => {
      const n = Math.floor(0.24 * SR);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const fr = f * (1 + 0.6 * Math.exp(-t / 0.02));
        y[i] = Math.sin(2 * Math.PI * fr * t) * ramp(t, 0.003) * Math.exp(-t / 0.07);
      }
      const kn2 = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        kn2[i] = Math.sin(2 * Math.PI * knockF * t) * ramp(t, 0.002) * Math.exp(-t / 0.025);
      }
      mix(y, kn2, 0.4);
      const nz = new Float32Array(n);
      const ns2 = lowpass(noise(n, rng), 700);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        nz[i] = ns2[i]! * ramp(t, 0.004) * Math.exp(-t / 0.05);
      }
      mix(y, normalize(nz, 1), 0.3);
      return fadeTail(normalize(lowpass(y, 3800), 0.7), 0.02);
    };
    fam("hurt", "vfx", 1.3, 0, [hurtWave(105, 290), hurtWave(96, 320), hurtWave(112, 270)]);
    fam("flesh", "vfx", 0.45, 0.06, [thud(95, 0.14, 0.4, 420), thud(88, 0.15, 0.42, 400), thud(100, 0.13, 0.38, 440), thud(92, 0.14, 0.4, 410)]);
    fam("impact", "vfx", 0.42, 0.1, [thud(160, 0.1, 0.6, 900), thud(150, 0.1, 0.62, 860), thud(172, 0.09, 0.58, 940), thud(155, 0.1, 0.6, 880)]);
    fam("land", "steps", 0.5, 0.01, [thud(70, 0.16, 0.35, 600), thud(66, 0.17, 0.36, 580), thud(74, 0.15, 0.34, 620)]);

    // footsteps: heel thud + dirt scuff
    const step = (): Float32Array => {
      const n = Math.floor(0.14 * SR);
      const y = new Float32Array(n);
      const f = 62 + rng() * 16;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = Math.sin(2 * Math.PI * f * (1 + Math.exp(-t / 0.014)) * t) * ramp(t, 0.004) * Math.exp(-t / 0.03) * 0.9;
      }
      let scuff = bandpass(noise(n, rng), 480 + rng() * 220, 0.9);
      scuff = normalize(scuff, 1);
      const sc = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        sc[i] = scuff[i]! * ramp(t, 0.008) * Math.exp(-t / 0.045);
      }
      mix(y, sc, 0.36, 0.012);
      return fadeTail(normalize(lowpass(y, 2700, 2), 0.4), 0.02);
    };
    // Dry footsteps preserve direction instead of spreading through yard reverb.
    fam("step", "steps", 1, 0, [step(), step(), step(), step(), step()]);
    // Container lids: the same heel, a ringing shell instead of a scuff.
    const stepMetal = (): Float32Array => {
      const n = Math.floor(0.2 * SR);
      const y = new Float32Array(n);
      const f = 96 + rng() * 22;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = Math.sin(2 * Math.PI * f * (1 + Math.exp(-t / 0.01)) * t) * ramp(t, 0.002) * Math.exp(-t / 0.022) * 0.8;
      }
      // two detuned shell partials — a hollow steel box, not a bell
      for (const [pf, amp, tau] of [
        [730, 0.3, 0.075],
        [1180, 0.19, 0.055],
        [2360, 0.1, 0.03],
      ] as [number, number, number][]) {
        const r = new Float32Array(n);
        const det = pf * (1 + (rng() - 0.5) * 0.05);
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          r[i] = Math.sin(2 * Math.PI * det * t) * ramp(t, 0.001) * Math.exp(-t / tau);
        }
        mix(y, r, amp, 0.002);
      }
      const gr = bandpass(noise(n, rng), 3100 + rng() * 700, 1.4);
      const gn = new Float32Array(n);
      for (let i = 0; i < n; i++) gn[i] = gr[i]! * Math.exp(-(i / SR) / 0.012);
      mix(y, normalize(gn, 1), 0.22);
      return fadeTail(normalize(lowpass(y, 6200), 0.4), 0.02);
    };
    fam("step-metal", "steps", 0.98, 0, [stepMetal(), stepMetal(), stepMetal(), stepMetal()]);
    // SURFACE STEPS (client/src/footsteps.ts footSurface): each surface keeps
    // the same heel under a different contact. One envelope helper per layer.
    const env = (x: Float32Array, atk: number, tau: number): Float32Array => {
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) {
        const t = i / SR;
        y[i] = x[i]! * ramp(t, atk) * Math.exp(-t / tau);
      }
      return y;
    };
    const heel = (n: number, f: number, sweep: number, tau: number, amp: number): Float32Array => {
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = Math.sin(2 * Math.PI * f * (1 + Math.exp(-t / sweep)) * t) * ramp(t, 0.003) * Math.exp(-t / tau) * amp;
      }
      return y;
    };
    // Grass: a soft, low heel and a slow leafy swish — the quietest surface.
    const stepGrass = (): Float32Array => {
      const n = Math.floor(0.2 * SR);
      const y = heel(n, 52 + rng() * 12, 0.018, 0.034, 0.55);
      mix(y, normalize(env(bandpass(noise(n, rng), 2400 + rng() * 1200, 0.55), 0.022, 0.06), 1), 0.3, 0.008);
      return fadeTail(normalize(lowpass(y, 4300, 2), 0.32), 0.02);
    };
    // Hard ground (concrete, stone, asphalt): a crisp heel click, little body.
    const stepHard = (): Float32Array => {
      const n = Math.floor(0.13 * SR);
      const y = heel(n, 120 + rng() * 30, 0.006, 0.014, 0.6);
      mix(y, normalize(env(bandpass(noise(n, rng), 3400 + rng() * 900, 1.1), 0.001, 0.006), 1), 0.5);
      mix(y, normalize(env(bandpass(noise(n, rng), 900 + rng() * 300, 0.8), 0.006, 0.03), 1), 0.18, 0.02);
      return fadeTail(normalize(lowpass(y, 7000), 0.42), 0.015);
    };
    // Wood (decks, floors, crates): a hollow knock with two body resonances.
    const stepWood = (): Float32Array => {
      const n = Math.floor(0.2 * SR);
      const y = heel(n, 88 + rng() * 18, 0.012, 0.03, 0.75);
      for (const [pf, amp, tau] of [
        [310, 0.32, 0.05],
        [540, 0.18, 0.035],
      ] as [number, number, number][]) {
        const det = pf * (1 + (rng() - 0.5) * 0.08);
        const r = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          r[i] = Math.sin(2 * Math.PI * det * t) * ramp(t, 0.002) * Math.exp(-t / tau);
        }
        mix(y, r, amp, 0.002);
      }
      mix(y, normalize(env(bandpass(noise(n, rng), 1800, 1), 0.002, 0.01), 1), 0.14);
      return fadeTail(normalize(lowpass(y, 5200), 0.42), 0.02);
    };
    // Sand: a heel that sinks, under a spray of fine grains.
    const stepSand = (): Float32Array => {
      const n = Math.floor(0.2 * SR);
      const y = heel(n, 58 + rng() * 10, 0.02, 0.03, 0.5);
      const grains = new Float32Array(n);
      for (let g = 0; g < 26; g++) {
        const at = Math.floor((0.004 + rng() * rng() * 0.11) * SR);
        const len = Math.floor((0.002 + rng() * 0.004) * SR);
        const amp = 0.4 + rng() * 0.6;
        for (let i = 0; i < len && at + i < n; i++) grains[at + i]! += (rng() * 2 - 1) * amp * (1 - i / len);
      }
      mix(y, normalize(bandpass(grains, 2600 + rng() * 800, 0.7), 1), 0.38);
      return fadeTail(normalize(lowpass(y, 6000), 0.36), 0.02);
    };
    fam("step-grass", "steps", 0.85, 0, [stepGrass(), stepGrass(), stepGrass(), stepGrass()]);
    fam("step-hard", "steps", 1, 0, [stepHard(), stepHard(), stepHard(), stepHard()]);
    fam("step-wood", "steps", 1, 0, [stepWood(), stepWood(), stepWood(), stepWood()]);
    fam("step-sand", "steps", 0.95, 0, [stepSand(), stepSand(), stepSand(), stepSand()]);
    // Landings: the body thud, with that surface's contact on top, louder.
    const landOn = (contact: () => Float32Array, f: number): Float32Array => {
      const y = thud(f, 0.16, 0.25, 600);
      mix(y, contact(), 0.7);
      return fadeTail(normalize(y, 0.5), 0.02);
    };
    fam("land-grass", "steps", 0.45, 0.01, [landOn(stepGrass, 62), landOn(stepGrass, 58), landOn(stepGrass, 66)]);
    fam("land-hard", "steps", 0.5, 0.01, [landOn(stepHard, 78), landOn(stepHard, 74), landOn(stepHard, 82)]);
    fam("land-wood", "steps", 0.5, 0.01, [landOn(stepWood, 72), landOn(stepWood, 68), landOn(stepWood, 76)]);
    fam("land-sand", "steps", 0.48, 0.01, [landOn(stepSand, 64), landOn(stepSand, 60), landOn(stepSand, 68)]);
    fam("land-metal", "steps", 0.5, 0.01, [landOn(stepMetal, 82), landOn(stepMetal, 78), landOn(stepMetal, 86)]);
    const slide = (): Float32Array => {
      const n = Math.floor(0.32 * SR);
      let x = bandpass(noise(n, rng), 650, 0.7);
      x = normalize(x, 1);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = x[i]! * ramp(t, 0.03) * Math.exp(-t / 0.14);
      }
      return normalize(lowpass(y, 2600), 0.3);
    };
    fam("slide", "steps", 0.45, 0.03, [slide(), slide()]);
    fam("whoosh", "vfx", 0.4, 0, [kn(), kn()]);

    // UI
    fam("ui", "ui", 0.4, 0, [marimba(rng, PENTA[5]!, 0.18, 0.15), marimba(rng, PENTA[5]! * 1.002, 0.18, 0.15)]);
    fam("ui-go", "ui", 0.5, 0, [sequence([{ f: PENTA[0]!, at: 0 }, { f: PENTA[3]!, at: 0.09 }], 0.7, rng)]);

    // reload staged clicks
    const rlClick = (fc: number): Float32Array => {
      const base = mechTick(fc * 0.5, 0.09, 0.022);
      const n2 = base.length;
      const knock = new Float32Array(n2);
      const kf = 380 + rng() * 120;
      for (let i = 0; i < n2; i++) {
        const t = i / SR;
        knock[i] = Math.sin(2 * Math.PI * kf * t) * ramp(t, 0.002) * Math.exp(-t / 0.018);
      }
      mix(base, knock, 0.8);
      return fadeTail(normalize(lowpass(base, 2600, 3), 0.32), 0.015);
    };
    fam("rl-click", "guns", 0.5, 0, [rlClick(1050), rlClick(1250), rlClick(950), rlClick(1150)]);
    fam("rl-snap", "guns", 0.55, 0, [rlClick(1600), rlClick(1500)]);
    fam("reload", "guns", 0.5, 0, [rlClick(1100), rlClick(1000), rlClick(1200)]);
    // Three named reload stages so the packs' 3-stage reloads (mag out, mag in,
    // charging handle) have a synth twin and the timing is one code path.
    fam("rl-magout", "guns", 0.5, 0, [rlClick(780), rlClick(840), rlClick(720)]);
    fam("rl-magin", "guns", 0.55, 0, [rlClick(1050), rlClick(1150), rlClick(980)]);
    fam("rl-rack", "guns", 0.6, 0, [rlClick(1650), rlClick(1520)]);

    // ---------------------------------------------------------- banana frag
    // Pin click: a tight brass tick with a spring twang under it. Deliberately
    // small — it fires on every wind-up and must never nag.
    const pin = (f: number): Float32Array => {
      const n = Math.floor(0.16 * SR);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] =
          (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 3.11 * t)) *
          ramp(t, 0.0012) *
          Math.exp(-t / 0.017);
      }
      const spring = new Float32Array(n);
      const sf = f * 0.42;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        spring[i] = Math.sin(2 * Math.PI * sf * (1 + t * 1.6) * t) * ramp(t, 0.004) * Math.exp(-t / 0.05);
      }
      mix(y, spring, 0.26, 0.006);
      let tick = normalize(bandpass(noise(Math.floor(0.008 * SR), rng), 4200, 1.4), 1);
      const tk = new Float32Array(tick.length);
      for (let i = 0; i < tick.length; i++) tk[i] = tick[i]! * Math.exp(-(i / SR) / 0.003);
      mix(y, tk, 0.3);
      return fadeTail(normalize(lowpass(y, 7200), 0.4), 0.015);
    };
    fam("nade-pin", "guns", 0.62, 0.05, [pin(2350), pin(2180), pin(2500)]);
    // Dry click when the pouch is empty — no pitch, no promise.
    fam("nade-empty", "guns", 0.4, 0, [mechTick(2600, 0.04, 0.008), mechTick(2450, 0.04, 0.008)]);

    // Throw whoosh: a band of air sweeping down as the arm comes over.
    const whoosh = (fc: number, dur: number): Float32Array => {
      const n = Math.floor(dur * SR);
      const src = noise(n, rng);
      const y = new Float32Array(n);
      // Sweep a resonant band from high to low = the arc of the swing.
      for (let pass = 0; pass < 3; pass++) {
        const f = fc * (1 - pass * 0.22);
        const band = bandpass(src, f, 1.1 + pass * 0.5);
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          const prog = i / n;
          const win = Math.sin(Math.PI * Math.pow(prog, 0.72));
          const sweep = pass === 0 ? 1 - prog : pass === 1 ? 1 - Math.abs(prog - 0.5) * 2 : prog;
          y[i] = y[i]! + band[i]! * win * sweep * ramp(t, 0.012);
        }
      }
      return fadeTail(normalize(lowpass(y, 3400, 2), 0.34), 0.03);
    };
    fam("nade-throw", "vfx", 0.7, 0.08, [whoosh(1250, 0.28), whoosh(1080, 0.3), whoosh(1400, 0.26)]);

    // Bounce: a soft pulpy knock with just enough metal to carry outdoors.
    const thunk = (f: number, bright: number): Float32Array => {
      const n = Math.floor(0.15 * SR);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const fr = f * (1 + 0.85 * Math.exp(-t / 0.008));
        y[i] = Math.sin(2 * Math.PI * fr * t) * ramp(t, 0.0018) * Math.exp(-t / 0.026);
      }
      let nz = normalize(bandpass(noise(n, rng), 900 + bright * 1400, 1.1), 1);
      const nn = new Float32Array(n);
      for (let i = 0; i < n; i++) nn[i] = nz[i]! * ramp(i / SR, 0.0015) * Math.exp(-(i / SR) / 0.012);
      mix(y, nn, 0.34 + bright * 0.2);
      return fadeTail(normalize(lowpass(y, 4200, 2), 0.42), 0.02);
    };
    fam("nade-bounce", "vfx", 0.66, 0.14, [thunk(184, 0.2), thunk(212, 0.5), thunk(163, 0.35), thunk(238, 0.7)]);

    // THE BURST. Four layers, in the order the ear resolves them:
    //   crack   — the 2 ms transient that says "this happened to YOU"
    //   body    — a pitched-down sine thump, the weight
    //   spray   — band-limited noise, the peel going everywhere
    //   tail    — a long, dark, reverberant decay off the containers
    // Normalized to 0.72 so the master ceiling never has to work: the -1 dBFS
    // limit is a safety net here, not the mix.
    const burst = (base: number, dur: number, spread: number): [Float32Array, Float32Array] => {
      const n = Math.floor(dur * SR);
      const mono = new Float32Array(n);
      // crack
      const cn = Math.floor(0.035 * SR);
      const crack = normalize(highpass(noise(cn, rng), 1600), 1);
      for (let i = 0; i < cn; i++) crack[i] = crack[i]! * Math.exp(-(i / SR) / 0.0035);
      mix(mono, crack, 0.85);
      // body: sine swept base -> base*0.55
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const f = base * (0.55 + 0.45 * Math.exp(-t / 0.09));
        mono[i] = mono[i]! + Math.sin(2 * Math.PI * f * t) * ramp(t, 0.0022) * Math.exp(-t / 0.16) * 0.95;
      }
      // spray
      let sp = normalize(bandpass(noise(n, rng), 720 * spread, 0.75), 1);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        mono[i] = mono[i]! + sp[i]! * ramp(t, 0.004) * Math.exp(-t / 0.085) * 0.7;
      }
      // tail
      let tail = normalize(lowpass(noise(n, rng), 620, 2), 1);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        mono[i] = mono[i]! + tail[i]! * (1 - Math.exp(-t / 0.05)) * Math.exp(-t / 0.42) * 0.3;
      }
      const shaped = softClip(normalize(mono, 0.95), 1.6);
      // Slight L/R decorrelation on the tail only: width without phase weirdness.
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      const d = Math.floor(0.0009 * SR);
      for (let i = 0; i < n; i++) {
        l[i] = shaped[i]!;
        r[i] = shaped[i]! * 0.86 + (i > d ? shaped[i - d]! * 0.2 : 0);
      }
      return [fadeTail(normalize(l, 0.72), 0.05), fadeTail(normalize(r, 0.72), 0.05)];
    };
    fam("nade-boom", "vfx", 1.15, 0.34, [burst(74, 1.5, 1), burst(66, 1.6, 1.2), burst(82, 1.45, 0.85)]);
    // Distant report: the same event heard across the yard, all low end.
    const farBoom = (base: number): Float32Array => {
      const n = Math.floor(1.5 * SR);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = Math.sin(2 * Math.PI * base * (0.6 + 0.4 * Math.exp(-t / 0.12)) * t) * ramp(t, 0.006) * Math.exp(-t / 0.22);
      }
      let rumble = normalize(lowpass(noise(n, rng), 340, 3), 1);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] = y[i]! + rumble[i]! * (1 - Math.exp(-t / 0.04)) * Math.exp(-t / 0.5) * 0.55;
      }
      return fadeTail(normalize(lowpass(y, 1100, 2), 0.6), 0.06);
    };
    fam("nade-boom-far", "vfx", 0.9, 0.4, [farBoom(58), farBoom(64)]);

    // metal-far ambience clank (soft, muffled)
    const clank = (): Float32Array => {
      const n = Math.floor(0.5 * SR);
      const y = new Float32Array(n);
      const f = 180 + rng() * 60;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        y[i] =
          (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2.41 * t)) *
          ramp(t, 0.01) *
          Math.exp(-t / 0.16);
      }
      return normalize(lowpass(y, 900), 0.2);
    };
    fam("metal-far", "amb", 0.4, 0.2, [clank(), clank()]);

    // medals — ascending euphoria
    fam("medal-kill", "ui", 0.64, 0, [sequence([{ f: PENTA[3]!, at: 0 }, { f: PENTA[5]!, at: 0.08 }], 0.8, rng, 0.424)]);
    fam("medal-double", "ui", 0.64, 0, [
      sequence([{ f: PENTA[5]!, at: 0 }, { f: PENTA[6]!, at: 0.09 }, { f: PENTA[7]!, at: 0.18 }], 1, rng, 0.475),
    ]);
    fam("medal-triple", "ui", 0.64, 0, [
      sequence([{ f: PENTA[5]!, at: 0 }, { f: PENTA[6]!, at: 0.085 }, { f: PENTA[7]!, at: 0.17 }, { f: PENTA[5]! * 2, at: 0.255 }], 1.2, rng, 0.565),
    ]);
    const fury = sequence(
      [
        { f: PENTA[5]!, at: 0 },
        { f: PENTA[6]!, at: 0.08 },
        { f: PENTA[7]!, at: 0.16 },
        { f: PENTA[5]! * 2, at: 0.24 },
        { f: PENTA[6]! * 2, at: 0.32, dur: 0.6 },
      ],
      1.5,
      rng,
      0.598,
    );
    sparkle(rng, 0.42, fury[0], fury[1]);
    fam("medal-fury", "ui", 0.64, 0, [fury]);
    const streak = sequence(
      PENTA.map((f, i) => ({ f: f * 2, at: i * 0.07, dur: i === PENTA.length - 1 ? 0.7 : 0.4 })),
      1.8,
      rng,
      0.671,
    );
    sparkle(rng, 0.62, streak[0], streak[1]);
    fam("medal-streak", "ui", 0.64, 0, [streak]);

    // match stings — the two moments the whole yard hears at once
    const start = sequence(
      [
        { f: PENTA[0]!, at: 0, dur: 0.5 },
        { f: PENTA[2]!, at: 0.13, dur: 0.5 },
        { f: PENTA[4]!, at: 0.26, dur: 0.9 },
      ],
      1.5,
      rng,
      0.5,
    );
    sparkle(rng, 0.3, start[0], start[1]);
    fam("match-start", "ui", 0.7, 0, [start]);
    const end = sequence(
      [
        { f: PENTA[5]!, at: 0, dur: 0.6 },
        { f: PENTA[3]!, at: 0.16, dur: 0.6 },
        { f: PENTA[0]!, at: 0.32, dur: 1.2 },
      ],
      1.9,
      rng,
      0.52,
    );
    fam("match-end", "ui", 0.72, 0, [end]);

    /* ── MATCH FEEL: the 3-2-1, the resupply, the heal ───────────────────────
     * NO SAMPLE PACK CARRIES ANY OF THESE. audio-packs.ts resolves a canonical
     * event through its ALIASES table and, when a pack declares no candidate
     * for it, play() finds `pev === null` and uses the synth family of the same
     * name — the documented fallback path. So a family defined here IS the
     * sound under all four packs as well as under SYNTH, mixed by the identical
     * code (same bus, same level formula, same limiter). They are listed in
     * audio-packs SYNTH_ONLY so the gap is on the record instead of being
     * discovered by a player.
     *
     * They are also all on the `ui` bus, which is the non-positional one: a
     * countdown and your own heal happen in your head, not somewhere in the
     * yard, so nothing here ever creates a PannerNode.
     */

    // ONE countdown beat, played at three ascending rates by matchfeel.ts so the
    // 3-2-1 is a single instrument climbing the A-major pentatonic (554 -> 659 ->
    // 740 Hz at rates 1 / 1.189 / 1.335) rather than three unrelated noises. A
    // hollow gourd knock over a short marimba tone: the same mallet voice the
    // medals are built from, which is why it lands as this game's countdown and
    // not a generic beep.
    const countTick = (): [Float32Array, Float32Array] => {
      const n = Math.floor(0.46 * SR);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      // TONAL CONTENT GOES IN AT THE SAME INSTANT IN BOTH CHANNELS. Offsetting a
      // pitched layer by a fraction of a millisecond to "widen" it is a comb
      // filter, and half a period of the note is a NULL: measured, a 0.5 ms
      // offset on a 1108 Hz chime cost 15 dB the moment the two channels were
      // summed (qa/sound-report analyses the mono downmix, and so does any
      // mono fold-down a player might actually listen through). Only the
      // broadband noise layers below are decorrelated, where there is no
      // fundamental to cancel.
      const tone = marimba(rng, PENTA[2]!, 0.34, 0.34);
      mix(l, tone, 0.6);
      mix(r, tone, 0.6);
      const knockN = Math.floor(0.06 * SR);
      const knock = normalize(bandpass(noise(knockN, rng), 940, 3.2), 1);
      const kn = new Float32Array(knockN);
      for (let i = 0; i < knockN; i++) kn[i] = knock[i]! * Math.exp(-(i / SR) / 0.013);
      mix(l, kn, 0.34);
      mix(r, kn, 0.31, 0.0007);
      return [fadeTail(normalize(l, 0.62), 0.03), fadeTail(normalize(r, 0.62), 0.03)];
    };
    fam("count-tick", "ui", 0.68, 0.05, [countTick()]);

    // "MASH!" — the beat the yard goes live on. Deliberately an OCTAVE above the
    // ticks and wider than the match-start sting so the release reads as a
    // release: three mallets up the top of the ladder, a sparkle over them, and
    // one soft air whoosh underneath.
    const go = sequence(
      [
        { f: PENTA[5]!, at: 0, dur: 0.5 },
        { f: PENTA[6]!, at: 0.055, dur: 0.55 },
        { f: PENTA[7]!, at: 0.105, dur: 0.75 },
      ],
      1.1,
      rng,
      0.58,
    );
    sparkle(rng, 0.14, go[0], go[1]);
    {
      const wn = Math.floor(0.34 * SR);
      const air = normalize(bandpass(noise(wn, rng), 2100, 1.1), 1);
      const sw = new Float32Array(wn);
      for (let i = 0; i < wn; i++) {
        const t = i / SR;
        sw[i] = air[i]! * ramp(t, 0.01) * Math.exp(-t / 0.1);
      }
      mix(go[0], sw, 0.16);
      mix(go[1], sw, 0.15, 0.0009);
    }
    fam("count-go", "ui", 0.7, 0.1, [go]);

    // RESUPPLY: a mag-shaped metal clack with a confirm chime on top — close
    // cousin of the reload mech family so a kill's ammunition sounds like
    // ammunition, one note (PENTA[6]) so it can never be mistaken for a medal.
    //
    // THE CLACK IS RAMPED AND LOWPASSED, and both are measured requirements, not
    // taste. The first version opened a 2.6 kHz bandpassed noise burst at full
    // amplitude on sample zero: qa/sound-report's truncation-click detector
    // (a frame with >5% of its energy above 10 kHz) flagged it —
    // `resupply FAIL click`, centroid 3430 Hz, peak -33.9 dBFS. A 2.5 ms attack
    // and a 7 kHz lowpass kill the click; centering the noise lower and
    // normalising higher put it back in the same loudness family as the medals.
    {
      const n = Math.floor(0.5 * SR);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      const clackN = Math.floor(0.1 * SR);
      const cl = normalize(bandpass(noise(clackN, rng), 1900, 3), 1);
      const clk = new Float32Array(clackN);
      for (let i = 0; i < clackN; i++) {
        const t = i / SR;
        clk[i] = cl[i]! * ramp(t, 0.0025) * Math.exp(-t / 0.013);
      }
      mix(l, clk, 0.62);
      mix(r, clk, 0.58, 0.0008);
      // Same instant in both channels — see the note on count-tick's tone.
      const chime = marimba(rng, PENTA[6]!, 0.4, 0.34);
      mix(l, chime, 0.72, 0.035);
      mix(r, chime, 0.72, 0.035);
      fam("resupply", "ui", 0.66, 0.06, [
        [fadeTail(normalize(lowpass(l, 7000, 2), 0.56), 0.03), fadeTail(normalize(lowpass(r, 7000, 2), 0.56), 0.03)] as [
          Float32Array,
          Float32Array,
        ],
      ]);
    }

    // RECOVERED: the warm one. Two low mallets rising a fifth, long and soft,
    // no sparkle and no transient — this fires when you are ALONE and healed,
    // and anything sharper would read as a threat cue.
    const heal = sequence(
      [
        { f: PENTA[0]! * 0.5, at: 0, dur: 0.62 },
        { f: PENTA[3]! * 0.5, at: 0.12, dur: 0.9 },
        { f: PENTA[5]! * 0.5, at: 0.24, dur: 1.0 },
      ],
      1.35,
      rng,
      0.44,
    );
    fam("recover", "ui", 0.6, 0.12, [heal]);

    // ambience
    fam("room", "amb", 1, 0, [windBed(rng)]);
    fam("bird", "amb", 0.5, 0, [birdChirp(rng), birdChirp(rng), birdChirp(rng), birdChirp(rng), birdChirp(rng), birdChirp(rng)]);
    const insect = (): Float32Array => {
      const n = Math.floor(1.4 * SR);
      let x = bandpass(noise(n, rng), 4300, 6);
      x = normalize(x, 1);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * (11 + 3 * Math.sin(t * 2)) * t);
        y[i] = x[i]! * am * Math.sin(Math.PI * (i / n));
      }
      return normalize(lowpass(y, 5600), 0.1);
    };
    fam("insect", "amb", 0.4, 0, [insect(), insect()]);
    // Distant howler. One pack ships a real monkey hoot as an accent; this is
    // its synth twin so the accent scheduler has one code path.
    const hoot = (f0: number): Float32Array => {
      const n = Math.floor(0.75 * SR);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = Math.min(1, t / 0.06) * Math.exp(-t / 0.34);
        const f = f0 * (1 + 0.22 * Math.sin(Math.PI * Math.min(1, t / 0.5)));
        y[i] = (Math.sin(2 * Math.PI * f * t) + 0.34 * Math.sin(2 * Math.PI * f * 2 * t) + 0.12 * Math.sin(2 * Math.PI * f * 3 * t)) * env;
      }
      return fadeTail(normalize(lowpass(y, 2200), 0.24), 0.05);
    };
    fam("monkey", "amb", 0.45, 0.12, [hoot(305), hoot(268)]);

    // SPRAY PAINT hiss (client/src/sprays.ts): the synth twin of the recorded
    // can-hiss (static/assets/audio/weapons/spray-01). A soft nozzle click over
    // a ~0.8 s band of air. The recorded clip replaces these variants at boot
    // (loadSpraySample), so this only speaks when the file is missing or
    // undecodable — same bus/level as the nade foley below either way.
    {
      const hiss = (): Float32Array => {
        const n = Math.floor(0.85 * SR);
        let x = bandpass(noise(n, rng), 4200, 0.8);
        x = normalize(x, 1);
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          y[i] = x[i]! * ramp(t, 0.012) * Math.exp(-t / 0.28);
        }
        // nozzle click: short, ramped attack, lowpassed — never a truncation click
        const ck = normalize(bandpass(noise(Math.floor(0.02 * SR), rng), 2400, 1.6), 1);
        const c = new Float32Array(ck.length);
        for (let i = 0; i < ck.length; i++) c[i] = ck[i]! * ramp(i / SR, 0.002) * Math.exp(-(i / SR) / 0.006);
        mix(y, lowpass(c, 6000), 0.5);
        return fadeTail(normalize(lowpass(y, 7500), 0.5), 0.03);
      };
      fam("spray", "vfx", 0.7, 0.08, [hiss(), hiss()]);
    }

    // baked reload sequence (QA reference)
    {
      const total = 1.8;
      const n = Math.floor(total * SR);
      const l = new Float32Array(n);
      const rr = new Float32Array(n);
      const clicks = [0.15, 0.45, 0.75, 0.95];
      for (const [i, frac] of clicks.entries()) {
        const v = this.families.get(i === clicks.length - 1 ? "rl-snap" : "rl-click")!;
        const buf = v.variants[i % v.variants.length]!;
        const d = buf.getChannelData(0);
        mix(l, d as Float32Array, 0.6, frac * total);
        mix(rr, d as Float32Array, 0.6, frac * total + 0.001);
      }
      fam("reload-seq", "guns", 0.6, 0, [[normalize(l, 0.4), normalize(rr, 0.4)] as [Float32Array, Float32Array]]);
    }

    // shared small-yard impulse response
    const irLen = Math.floor(0.55 * SR);
    const mkIr = (seed: number): Float32Array => {
      const r2 = lcg(seed);
      const y = new Float32Array(irLen);
      // early reflections
      for (const [at, g] of [
        [0.011, 0.5],
        [0.023, 0.36],
        [0.037, 0.3],
        [0.052, 0.22],
      ] as [number, number][]) {
        const idx = Math.floor(at * SR);
        y[idx] = (r2() * 2 - 1) * g;
      }
      for (let i = 0; i < irLen; i++) {
        const t = i / SR;
        y[i] = y[i]! + (r2() * 2 - 1) * Math.exp(-t / 0.14) * 0.35;
      }
      return normalize(lowpass(y, 3400), 0.5);
    };
    this.irL = mkIr(77);
    this.irR = mkIr(78);
  }

  // ---------------- graph ----------------

  private buildGraph(ctx: BaseAudioContext): {
    buses: Record<BusName, GainNode>;
    verbIn: GainNode;
    out: GainNode;
    /** everything that reaches the master dynamics (upgradeMaster() re-routes it into the limiter worklet) */
    pre: GainNode;
  } {
    // The master stage: `pre` -> bus compressor -> limiter -> soft clip -> `out`. This DynamicsCompressor chain is the
    // FALLBACK; boot() swaps `pre` onto KR's glue + true-peak limiter worklet (weapons/audio-master.ts) once it loads.
    const pre = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 2.6;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -5;
    limiter.knee.value = 1;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.0015;
    limiter.release.value = 0.12;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = CEIL * Math.tanh(x / CEIL);
    }
    shaper.curve = curve;
    shaper.oversample = "2x";
    const out = ctx.createGain();
    pre.connect(comp);
    comp.connect(limiter);
    limiter.connect(shaper);
    shaper.connect(out);

    const verb = ctx.createConvolver();
    // Rate-matched IR. If a browser still refuses it, the yard goes dry rather
    // than the whole rig failing to boot — no reverb is a taste regression,
    // no audio at all is a dead game.
    try {
      verb.buffer = irBuffer(ctx, this.irL, this.irR);
    } catch (e) {
      console.warn("[audio] convolver IR rejected at", ctx.sampleRate, "Hz — running dry", e);
    }
    const verbIn = ctx.createGain();
    verbIn.gain.value = 1;
    const verbWet = ctx.createGain();
    verbWet.gain.value = 0.5;
    verbIn.connect(verb);
    verb.connect(verbWet);
    verbWet.connect(pre);

    const mkBus = (g: number): GainNode => {
      const b = ctx.createGain();
      b.gain.value = g;
      b.connect(pre);
      return b;
    };
    // Keep movement below weapons/UI; individual threats retain directional cues.
    const buses: Record<BusName, GainNode> = {
      guns: mkBus(0.8),
      steps: mkBus(0.5),
      ui: mkBus(0.95),
      amb: mkBus(0.5),
      vfx: mkBus(0.7),
    };
    return { buses, verbIn, out, pre };
  }

  /** THE panner: one configuration for every emitter in the game (weapons included — see the note at REF_M). */
  makePanner(ctx: BaseAudioContext, x: number, y: number, z: number): PannerNode {
    const pan = ctx.createPanner();
    pan.panningModel = "HRTF";
    pan.distanceModel = "inverse";
    pan.refDistance = REF_M;
    pan.maxDistance = MAX_M;
    pan.rolloffFactor = ROLLOFF;
    if (pan.positionX) {
      pan.positionX.value = x;
      pan.positionY.value = y;
      pan.positionZ.value = z;
    } else {
      (pan as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
    return pan;
  }

  // ---------------- recorded weapons ----------------

  /** The recorded weapon set (weapons/audio-engine.ts). Loads at boot; until it has, the synth guns speak. */
  weapons = new WeaponAudio(MAP_SCALE, new WeaponLibrary(assetUrl("/assets/audio/weapons/")));
  /** master limiter gain reduction (dB, the worklet's report; 0 = untouched, null = fallback chain) */
  limiterGr: number | null = null;
  limiterGrMin = 0;

  private attachWeapons(ctx: BaseAudioContext, pre: AudioNode, verbIn: AudioNode, amb: GainNode | null, engine = this.weapons): void {
    engine.mapId = activeMap().id;
    engine.attach(ctx, {
      into: pre,
      verb: verbIn,
      amb,
      panner: (c, x, y, z) => this.makePanner(c, x, y, z),
      panLaw: (d) => inverseGain(d, REF_M, ROLLOFF, MAX_M),
    });
  }

  /** decoded-buffer counts etc. for QA / the smoke */
  weaponStats(): WeaponAudioStats & { limiterGr: number | null; limiterGrMin: number } {
    return { ...this.weapons.stats(), limiterGr: this.limiterGr, limiterGrMin: this.limiterGrMin };
  }

  async boot(): Promise<void> {
    if (this.ready) return;
    this.ensureBaked();
    // Only the carried weapon plays in a match. Audio auditions can request
    // all families explicitly; baking their offline convolvers at game boot
    // competes with shader compilation for seconds on slower machines.
    void this.calibrateGuns([`gun-${PRIMARY_WEAPON_ID}`]);
    // No gesture (a ?play deep link, an intent auto-deploy) means no audible
    // audio is possible yet — and creating/resuming a context now only buys
    // the autoplay warning. Park a hook and return promptly so deploy and the
    // loading screen are never blocked; the game runs muted until it (play()
    // early-returns while !ready). The hook completes boot inside the gesture.
    if (!hasUserGesture()) {
      if (!this.bootHooked) {
        this.bootHooked = true;
        onFirstGesture(() => {
          this.bootHooked = false;
          void this.boot();
        });
      }
      return;
    }
    this.bootHooked = false;
    // A previous context may have been closed (device lost): drop its parked
    // gesture hook so the new context gets a fresh one instead of inheriting
    // listeners bound to the discarded context.
    this.unhookGesture();
    // No forced sampleRate: whatever the device reports is the truth, and every
    // rate-sensitive node downstream (only the convolver IR) is built from
    // ctx.sampleRate. Forcing 48 kHz here would throw on hardware that cannot
    // do it, which is the same dead-audio failure by a different route. And a
    // constructor that throws at all (no device, blocked build) must never
    // reject deploy — park the gesture hook and return muted instead.
    try {
      const AC = (globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
      if (!AC) throw new Error("no AudioContext");
      this.ctx = new AC({ latencyHint: "interactive" });
    } catch (e) {
      console.warn("[audio] AudioContext unavailable — running muted", e);
      this.ctx = null;
      this.ready = false;
      if (!this.bootHooked) {
        this.bootHooked = true;
        onFirstGesture(() => {
          this.bootHooked = false;
          void this.boot();
        });
      }
      return;
    }
    const { buses, verbIn, out, pre } = this.buildGraph(this.ctx);
    this.buses = buses;
    this.verbGain = verbIn;
    this.master = out;
    this.master.gain.value = this.vol;
    this.applyMix(); // UI stream: SETTINGS → AUDIO category levels
    this.master.connect(this.ctx.destination);
    this.ready = true;
    bootStage("AUDIO CONTEXT");
    // weapons stream: the recorded weapon set decodes while the pack loads; the master stage becomes the limiter
    // worklet as soon as it compiles (the fallback chain plays until then).
    this.attachWeapons(this.ctx, pre, verbIn, buses.amb);
    const ctx = this.ctx;
    void upgradeMaster(ctx, pre, out, (gr) => {
      this.limiterGr = gr;
      if (gr < this.limiterGrMin) this.limiterGrMin = gr;
    }).then((n) => {
      if (n) this.limiterGr = 0;
    });
    const weaponsAll = this.weapons.load(ctx);
    await this.kickResume();
    bootStage("AUDIO PACK");
    // Before the first trigger pull: your gun's layers + the confirms (lib.first). Bounded — a slow network must never
    // park the loading screen; anything not decoded yet falls back to the synth for that call. The pack leg gets its
    // own timeout so a hung manifest/fetch cannot park boot either — on timeout the synth bed covers the game.
    await Promise.all([
      Promise.race([this.loadPack(this.packKey), new Promise<void>((r) => setTimeout(r, 9000))]),
      Promise.race([this.weapons.lib.first ?? weaponsAll, new Promise<void>((r) => setTimeout(r, 2500))]),
      // The spray hiss decodes next to the pack: bounded like the rest, so a
      // hung fetch cannot park boot — the synth twin covers the game meanwhile.
      Promise.race([(this.sprayLoading = this.loadSpraySample()), new Promise<void>((r) => setTimeout(r, 9000))]),
    ]);
    // A deferred boot (no gesture at deploy) lands here inside the unlock
    // gesture, after game.boot()'s loopAmb() already no-opped — start the bed.
    // In the immediate path this is a no-op via the ambStarted guard.
    this.loopAmb();
    // A matchStart() that arrived while !ready (deep-link deploy: game.boot()
    // calls it right after loopAmb(), when play() still early-returns) left
    // wantMatchStart set instead of dropping the sting — replay it now that
    // the rig is live, so the deep link still gets its entrance.
    if (this.wantMatchStart) {
      this.wantMatchStart = false;
      this.matchStart();
    }
  }

  /** Deferred-boot hook installed while waiting for the first gesture. */
  private bootHooked = false;

  async resume(): Promise<void> {
    // No ctx and no gesture: boot() parks a gesture hook and returns promptly
    // (no context is created until the first real press) — never blocking.
    if (!this.ctx) await this.boot();
    else await this.kickResume();
  }

  /** One-shot gesture listeners installed by kickResume, removed once running. */
  private gestureHooked = false;
  /** Removes the parked window hook installed by hookGesture (null once unhooked). */
  private gestureCleanup: (() => void) | null = null;

  /**
   * Drop the parked gesture hook, if any. Called when the hook fires (via the
   * context statechange) and when a re-boot discards the context the hook was
   * bound to — a closed context never reaches "running", so without this the
   * listeners would leak, pointing at a dead context, and block a fresh hook.
   */
  private unhookGesture(): void {
    try {
      this.gestureCleanup?.();
    } catch {
      /* already gone */
    }
    this.gestureCleanup = null;
    this.gestureHooked = false;
  }

  /**
   * Ask a suspended context to start — WITHOUT trusting the promise to come
   * back. When the browser refuses to start audio (autoplay blocked with no
   * gesture on the ?play deep link, Firefox's "Block Audio and Video" setting
   * even WITH a gesture, a machine with no audio output at all), resume() does
   * not reject: it stays pending forever. This used to be awaited bare in
   * boot(), which parked deploy() — and the whole loading screen — on a promise
   * the platform is allowed to never settle.
   *
   * So: fire the resume, give the allowed case a beat to land (the race keeps
   * the happy path's ordering — sounds scheduled after boot() play on time),
   * and move on either way. Everything downstream is suspended-safe: decoding,
   * graph building and loadPack() all work on a suspended context, the game
   * just runs muted. The gesture hooks then re-ask on every real press until
   * the context comes alive, at which point they unhook themselves via
   * statechange. Registered once per context, on `window` with capture so no
   * stopPropagation() in a menu handler can starve them.
   *
   * GATED: with no gesture yet, resume() is never called — not even once —
   * because that speculative call is exactly what logs the autoplay warning.
   * The gesture hooks are installed instead, and the resume happens inside
   * the next real press handler, where it is allowed.
   */
  private kickResume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "suspended") return Promise.resolve();
    this.hookGesture(ctx);
    if (!hasUserGesture()) return Promise.resolve();
    const attempt = ctx.resume().then(
      () => {},
      () => {},
    );
    return Promise.race([attempt, new Promise<void>((r) => setTimeout(r, 350))]);
  }

  /** One-shot gesture listeners that resume ctx from inside a real press. Shared
   *  gesture set with audio-unlock.ts so both gates fire on the same presses. */
  private hookGesture(ctx: AudioContext): void {
    if (this.gestureHooked) return;
    // SSR/Node QA harnesses have no window to hook — kickResume's direct
    // resume() attempt is the only path there.
    if (typeof window === "undefined") return;
    this.gestureHooked = true;
    // Runs synchronously inside a real-press handler, where resume() is
    // allowed — never speculatively, never a warning. capture:true so no
    // stopPropagation() in a menu handler can starve the hook; passive:true
    // (the hook never calls preventDefault()); isTrusted so a synthetic
    // dispatchEvent() cannot spoof activation.
    const kick = (e: Event): void => {
      if (!e.isTrusted) return;
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    };
    const cleanup = (): void => {
      for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, kick, true);
    };
    this.gestureCleanup = cleanup;
    const unhook = (): void => {
      // While suspended the hook intentionally stays parked for the page
      // lifetime — a few passive capture listeners waiting for the unlock
      // press that may come minutes after deploy. A closed context never
      // reaches "running", so drop the hook to let a later boot() park a
      // fresh one instead of leaking listeners on a dead context.
      if (ctx.state !== "running" && ctx.state !== "closed") return;
      ctx.removeEventListener("statechange", unhook);
      this.unhookGesture();
    };
    for (const ev of GESTURE_EVENTS) window.addEventListener(ev, kick, { capture: true, passive: true });
    ctx.addEventListener("statechange", unhook);
  }

  // ---------------- sample packs ----------------

  /** Active pack key ("synth" = procedural only). Reads ?pack= then localStorage. */
  packKey = readPackPref();
  pack: SamplePack | null = null;
  packLoading: Promise<void> | null = null;
  /** Last load outcome, for the options UI and QA. */
  packStatus: { key: string; ok: boolean; bytes: number; events: number; missing: string[]; synthOnly?: readonly string[]; error?: string; pending?: boolean } | null = null;

  /** Spray-paint hiss (static/assets/audio/weapons/spray-01): decoded at boot
   *  over the synth "spray" fallback above. Opus/Ogg where the browser has it,
   *  AAC/M4A otherwise (same pair convention as the recorded weapon set) — a
   *  failed fetch/decode keeps the synth twin, never mutes the event. The
   *  weapons manifest is deliberately untouched: this clip is fetched directly,
   *  so no pack schema has to learn a new group. */
  sprayFile = "";
  private sprayLoading: Promise<void> | null = null;

  private async loadSpraySample(): Promise<void> {
    const ctx = this.ctx;
    const fam = this.families.get("spray");
    if (!ctx || !fam) return;
    const probe = typeof Audio !== "undefined" ? new Audio() : null;
    const opus = !!probe && probe.canPlayType('audio/ogg; codecs="opus"') !== "";
    const order = opus ? ["spray-01.ogg", "spray-01.m4a"] : ["spray-01.m4a", "spray-01.ogg"];
    for (const f of order) {
      try {
        const res = await fetch(assetUrl(`/assets/audio/weapons/${f}`));
        if (!res.ok) continue;
        const ab = await res.arrayBuffer();
        if (!ab.byteLength || ab.byteLength > 4 * 1024 * 1024) continue;
        const buf = await ctx.decodeAudioData(ab);
        // One raised-cosine fade (0.03 s, like the synth twin) so a non-zero
        // endpoint never clicks when the hiss is truncated.
        for (let c = 0; c < buf.numberOfChannels; c++) fadeTail(buf.getChannelData(c) as Float32Array, 0.03);
        fam.variants = [buf];
        this.sprayFile = f;
        return;
      } catch {
        /* next codec */
      }
    }
    console.warn("[audio] spray sample unavailable — synth hiss stays in charge");
  }

  /**
   * Swap the sample pack live. The synth stays baked underneath the whole time,
   * so a failed fetch/decode degrades to SYNTH instead of muting the game.
   */
  async loadPack(key: string): Promise<void> {
    // Allowlist: only the four measured packs and synth are loadable. A stale
    // ?pack= value or a tampered localStorage entry degrades to SYNTH instead
    // of fetching an attacker-influenced path.
    if (key !== "synth" && !PACK_OPTIONS.some((p) => p.key === key)) {
      console.warn(`[audio] unknown pack "${key}" — falling back to SYNTH`);
      key = "synth";
    }
    this.packKey = key;
    if (key === "synth") {
      this.pack = null;
      this.packStatus = { key: "synth", ok: true, bytes: 0, events: 0, missing: [] };
      this.restartAmb();
      return;
    }
    if (!this.ctx) {
      // Picked in OPTIONS before the first deploy: remember it and say so.
      // boot() calls loadPack(this.packKey) once the context exists.
      this.pack = null;
      this.packStatus = { key, ok: true, bytes: 0, events: 0, missing: [], pending: true };
      return;
    }
    const job = (async () => {
      try {
        const p = await SamplePack.load(key, this.ctx!);
        if (this.packKey !== key) return; // a newer swap won
        this.matchPackLevels(p);
        this.pack = p;
        this.packStatus = { key, ok: true, bytes: p.bytes, events: p.events.size, missing: p.missing, synthOnly: SYNTH_ONLY };
      } catch (e) {
        if (this.packKey !== key) return;
        this.pack = null;
        this.packStatus = { key, ok: false, bytes: 0, events: 0, missing: [], error: String((e as Error)?.message ?? e) };
        console.warn(`[audio] pack "${key}" failed to load — falling back to SYNTH`, e);
      }
      this.restartAmb();
    })();
    this.packLoading = job;
    await job;
  }

  private synthLoud = new Map<string, { rms: number; peak: number }>();

  /**
   * LEVEL-MATCH A PACK ONTO THE SYNTH, EVENT BY EVENT.
   *
   * Match each pack to the same reference, then apply the game's movement,
   * distance, team and occlusion mix. Pack choice changes timbre without
   * bypassing the tactical footstep limits.
   *
   * So each pack event is scaled to sit at the level its synth twin sits at,
   * using the RMS of the loudest 200 ms window as the loudness proxy. What
   * survives from the manifest is what the manifest is actually FOR: which
   * files, the round-robin, and the pitch variance. What survives from the game
   * is the mix. Two consequences worth having: a pack swap is a pure timbre
   * swap, and the four packs are loudness-matched against each other — which is
   * the only way a by-ear shootout picks the best sound instead of the loudest.
   */
  private matchPackLevels(p: SamplePack): void {
    const mean = (bufs: AudioBuffer[]): { rms: number; peak: number } => {
      const l = bufs.map((b) => loudness(b));
      return {
        rms: l.reduce((a, x) => a + x.rms, 0) / l.length,
        peak: l.reduce((a, x) => a + x.peak, 0) / l.length,
      };
    };
    for (const [name, ev] of p.events) {
      const fam = this.families.get(name);
      if (!fam || !ev.buffers.length) continue;
      let ref = this.synthLoud.get(name);
      if (ref === undefined) {
        ref = mean(fam.variants);
        this.synthLoud.set(name, ref);
      }
      const mine = mean(ev.buffers);
      if (!(mine.rms > 1e-6 && ref.rms > 1e-6)) {
        ev.match = 1;
        continue;
      }
      // Match the loudest 60 ms window, but never let a transient-heavy clip
      // land more than 2 dB above the synth's peak: the peak bound is what
      // keeps the whole game out of the compressor.
      const byRms = ref.rms / mine.rms;
      const byPeak = mine.peak > 1e-6 ? (ref.peak / mine.peak) * 1.26 : byRms;
      // The clamp is a guard against a pathological clip (near-silent or
      // clipped master), not a tuning knob: +/-18 dB is far outside anything
      // the four measured packs need.
      ev.match = Math.min(8, Math.max(0.125, Math.min(byRms, byPeak)));
    }
  }

  /** UI stream hook (SETTINGS → AUDIO): per-category levels, 0..1, on top of the bus bases. */
  mixFx = 1;
  mixUi = 1;
  mixAmb = 1;
  setMix(effects: number, ui: number, amb: number): void {
    this.mixFx = effects;
    this.mixUi = ui;
    this.mixAmb = amb;
    this.applyMix();
  }
  private applyMix(): void {
    if (!this.buses) return;
    this.buses.guns.gain.value = 0.8 * this.mixFx;
    this.buses.steps.gain.value = 0.5 * this.mixFx;
    this.buses.vfx.gain.value = 0.7 * this.mixFx;
    this.buses.ui.gain.value = 0.95 * this.mixUi;
    this.buses.amb.gain.value = 0.5 * this.mixAmb;
  }

  setVol(v: number): void {
    this.vol = v * 0.72;
    if (this.master) this.master.gain.value = this.vol;
  }

  listen(x: number, y: number, z: number, yaw: number): void {
    this.listenerX = x;
    this.listenerY = y;
    this.listenerZ = z;
    this.yaw = yaw;
    this.weapons.listen(x, y, z, yaw);
    const l = this.ctx?.listener;
    if (!l) return;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    if (l.positionX) {
      l.positionX.value = x;
      l.positionY.value = y;
      l.positionZ.value = z;
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
  }

  // ---------------- playback ----------------

  bags = new Map<string, number[]>();

  private pickVariant(name: string, fam: Family): AudioBuffer {
    // Shuffle-bag round robin: every variant plays once per bag, never the same
    // variant twice in a row across bag boundaries.
    const nVar = fam.variants.length;
    if (nVar === 1) return fam.variants[0]!;
    let bag = this.bags.get(name);
    const last = this.lastVariant.get(name) ?? -1;
    if (!bag || bag.length === 0) {
      bag = Array.from({ length: nVar }, (_, i) => i);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j]!, bag[i]!];
      }
      if (bag[bag.length - 1] === last) {
        const j = Math.floor(Math.random() * (bag.length - 1));
        [bag[bag.length - 1], bag[j]] = [bag[j]!, bag[bag.length - 1]!];
      }
      this.bags.set(name, bag);
    }
    const idx = bag.pop()!;
    this.lastVariant.set(name, idx);
    return fam.variants[idx]!;
  }

  /** Live per-event voice count, for EVENT_CAP. */
  private eventVoices = new Map<string, number>();

  play(name: string, opts: PlayOpts = {}): void {
    if (!this.ctx || !this.ready) return;
    // weapons stream: the frag / impact / damage events game.ts plays by name go to the recorded set when it has them
    if (this.weapons.loaded && this.weaponEvent(name, opts)) return;
    // A pack supplies the BUFFER; the family (bus, base volume, reverb send)
    // still comes from the synth definition so the mix rules are identical
    // whichever source is active. Bus routing needs a family either way.
    const pev = this.pack?.get(name) ?? null;
    const fam = this.families.get(name);
    if (!fam) return;
    const nowMs = this.ctx.currentTime * 1000;
    // Per-EMITTER cooldown: two shooters on the same tick are two voices; one
    // shooter double-triggering inside 30 ms is still one.
    const guardName = fam.bus === "steps" ? "steps" : name;
    const guardKey = opts.src ? `${guardName}|${opts.src}` : guardName;
    const guard = fam.bus === "steps" ? 150 : GUARD_MS[name] ?? 30;
    const lastAt = this.lastPlayAt.get(guardKey) ?? -1e9;
    if (nowMs - lastAt < guard) return;
    this.lastPlayAt.set(guardKey, nowMs);

    const cap = EVENT_CAP[name];
    if (cap !== undefined && (this.eventVoices.get(name) ?? 0) >= cap) return;

    // Damage-taken sidechain: dip the guns bus ~2.5dB for ~120ms so incoming
    // hits always land through the player's own fire (mirrors the hitmarker duck).
    if (name === "hurt" && this.buses) {
      const gg = this.buses.guns.gain;
      const t = this.ctx.currentTime;
      gg.cancelScheduledValues(t);
      gg.setTargetAtTime(0.6 * this.mixFx, t, 0.006);
      gg.setTargetAtTime(0.8 * this.mixFx, t + 0.12, 0.05);
    }

    let dist = 0;
    let law = 1;
    const positional = opts.x !== undefined && opts.z !== undefined;
    if (positional) {
      dist = Math.hypot(opts.x! - this.listenerX, (opts.y ?? 0) - this.listenerY, opts.z! - this.listenerZ);
      if (dist > CULL_M) return;
    }
    const step = fam.bus === "steps" ? footstepMix(dist, { local: !positional, land: name.startsWith("land"), ...opts.step }) : null;
    if (this.activeTotal >= 24) return;
    if (step) {
      if (step.gain <= 0.002) return;
      // Cancel only the panner's inverse attenuation, then apply the physical
      // footstep curve. HRTF positioning itself stays the same as other sounds.
      law = step.gain / (positional ? inverseGain(dist, REF_M, ROLLOFF, MAX_M) : 1);
      if (this.activeSteps.length >= STEP_VOICES) {
        let weakest = 0;
        for (let i = 1; i < this.activeSteps.length; i++) {
          if (this.activeSteps[i]!.priority < this.activeSteps[weakest]!.priority) weakest = i;
        }
        const old = this.activeSteps[weakest]!;
        if (step.priority <= old.priority) return;
        this.activeSteps.splice(weakest, 1);
        const t = this.ctx.currentTime;
        old.gain.gain.cancelScheduledValues(t);
        old.gain.gain.setTargetAtTime(0, t, 0.003);
        try { old.src.stop(t + 0.012); } catch { /* already ended */ }
      }
    }

    const src = this.ctx.createBufferSource();
    // Pack buffer if this pack carries the event, synth buffer otherwise —
    // everything below this line is identical for both.
    src.buffer = pev ? this.pack!.pick(name, pev) : this.pickVariant(name, fam);
    const jitter = pev ? this.pack!.rate(pev) : 0.985 + Math.random() * 0.03;
    src.playbackRate.value = (opts.rate ?? 1) * jitter;
    const g = this.ctx.createGain();
    // ONE level formula for both sources: the call-site volume (which encodes
    // GAME meaning — local vs remote, distance crossfades, ducking), the step
    // law, and the synth family's mix level. A pack contributes its clip, its
    // round-robin and its pitch variance; matchPackLevels() has already scaled
    // it onto the synth's level so it contributes no loudness of its own.
    const vol = Math.min(2.2, (opts.vol ?? 0.4) * law * fam.baseVol * 1.6 * (pev ? pev.match : 1));
    const t0 = this.ctx.currentTime;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.004);
    src.connect(g);
    const nodes: AudioNode[] = [src, g];

    let tail: AudioNode = g;
    if (opts.x !== undefined && opts.z !== undefined) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      // Air absorption is a reach curve too: at 2.2x scale a 40 m shot on
      // dust2 must read as far-away as an 18 m shot in the yard does.
      lp.frequency.value = step?.cutoff ?? Math.max(1200, 9500 - (dist / MAP_SCALE) * 240);
      lp.Q.value = 0.6;
      const pan = this.makePanner(this.ctx, opts.x, opts.y ?? 0, opts.z);
      g.connect(lp);
      lp.connect(pan);
      nodes.push(lp, pan);
      tail = pan;
    }
    tail.connect(this.buses[fam.bus]);
    if (fam.send > 0 && this.verbGain) {
      const sendG = this.ctx.createGain();
      sendG.gain.value = fam.send;
      tail.connect(sendG);
      sendG.connect(this.verbGain);
      nodes.push(sendG);
    }

    // Guns steal the farthest voice. Steps already admitted the most useful
    // cues above, with one shared limit across dirt, metal and landings.
    if (fam.bus === "guns") {
      this.activeGuns.push({ src, dist });
      if (this.activeGuns.length > 10) {
        let far = 0;
        for (let i = 1; i < this.activeGuns.length; i++) if (this.activeGuns[i]!.dist > this.activeGuns[far]!.dist) far = i;
        try {
          this.activeGuns[far]!.src.stop();
        } catch {
          /* ok */
        }
        this.activeGuns.splice(far, 1);
      }
    } else if (step) {
      this.activeSteps.push({ src, gain: g, priority: step.priority, emitter: opts.src ?? "local" });
    }
    this.activeTotal++;
    this.eventVoices.set(name, (this.eventVoices.get(name) ?? 0) + 1);
    src.onended = () => {
      this.activeTotal = Math.max(0, this.activeTotal - 1);
      this.eventVoices.set(name, Math.max(0, (this.eventVoices.get(name) ?? 1) - 1));
      const gi = this.activeGuns.findIndex((a) => a.src === src);
      if (gi >= 0) this.activeGuns.splice(gi, 1);
      const si = this.activeSteps.findIndex(a => a.src === src);
      if (si >= 0) this.activeSteps.splice(si, 1);
      try {
        for (const node of nodes) node.disconnect();
      } catch {
        /* gone */
      }
    };
    src.start();
  }

  /** game.ts event names -> the recorded set (true = handled, synth stays silent) */
  private weaponEvent(name: string, o: PlayOpts): boolean {
    const w = this.weapons;
    const pos = o.x !== undefined && o.z !== undefined;
    switch (name) {
      case "nade-pin":
        return w.nade("pin", o);
      case "nade-tick":
        return w.nade("tick", o);
      case "nade-throw":
        return w.nade("throw", o);
      case "nade-bounce":
        return w.nade("bounce", o);
      case "nade-empty":
        return w.nade("empty", o);
      case "hurt":
        return w.hurt();
      // a bullet into a player (game.ts plays "flesh" on head/kill hits, "impact" on the rest): a flesh slap there
      case "impact":
      case "flesh":
        return pos ? w.flesh(o.x!, o.y ?? 0, o.z!, o.src) : false;
      default:
        return false;
    }
  }

  hitmarker(head: boolean, kill: boolean): void {
    if (this.weapons.confirm(head, kill)) return;
    // Sidechain duck: pull the guns bus down ~5dB for ~80ms so the confirm
    // tick always reads through the player's own gunfire.
    if (this.ctx && this.buses) {
      const g = this.buses.guns.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0.45 * this.mixFx, t, 0.008);
      g.setTargetAtTime(0.8 * this.mixFx, t + 0.08, 0.05);
    }
    this.play(kill ? "kill" : head ? "headshot" : "hit", { vol: kill ? 0.5 : 0.42 });
  }

  /**
   * A shot. `src` is the SHOOTER's id: two players firing on the same tick are
   * two voices, one player double-triggering inside 30 ms is still one.
   *
   * Beyond FAR_M the remote shot swaps to the distant report. This is the whole
   * anti-"same noise x25" mechanism — in a full lobby most shots are far, and a
   * far shot is a softer, duller, longer sound that layers instead of stacking.
   */
  gun(id: string, x: number, y: number, z: number, local = false, src?: string): void {
    // weapons stream: the recorded gun (layers, bands, voice limits — weapons/audio-engine.ts); the synth below is only
    // the fallback while the samples decode, or if they never do.
    if (id === "knife") {
      if (this.weapons.knife(local ? undefined : x, local ? undefined : y, local ? undefined : z, src)) return;
    } else if (this.weapons.shot(id, x, y, z, local, src)) return;
    const base = this.families.has("gun-" + id) ? "gun-" + id : "gun-m4a1";
    if (local) {
      this.play(base, { vol: 0.42, rate: 0.98 + Math.random() * 0.04, src: "local" });
      const mech = id === "m590" || id === "725" ? "mech-shot" : id === "m40a3" ? "mech-bolt" : id === "knife" ? "mech-knife" : "mech-rifle";
      this.play(mech, { vol: 0.14, rate: 0.97 + Math.random() * 0.05, src: "local" });
      return;
    }
    const dist = Math.hypot(x - this.listenerX, y - this.listenerY, z - this.listenerZ);
    const far = dist > FAR_M && this.families.has(base + "-far");
    this.play(far ? base + "-far" : base, {
      vol: far ? 0.45 : 0.3,
      rate: 0.98 + Math.random() * 0.04,
      x,
      y,
      z,
      src,
    });
  }

  /** Quiet own/friendly movement, short physical reach, and dry directional cues. */
  footstep(opts: { x?: number; y?: number; z?: number; metal?: boolean; surface?: FootSurface; src?: string } & FootstepStyle): void {
    // The surface picks the family (dirt is the original "step" / "land");
    // a bank without that surface falls back to the dirt voice.
    const surface = opts.surface ?? (opts.metal ? "metal" : "dirt");
    const base = opts.land ? "land" : "step";
    const want = surface === "dirt" ? base : `${base}-${surface}`;
    const name = this.families.has(want) ? want : opts.metal && !opts.land ? "step-metal" : base;
    const local = opts.x === undefined;
    const vol = local ? (opts.land ? 0.065 : opts.sprint ? 0.045 : 0.035) : (opts.land ? 0.18 : opts.sprint ? 0.17 : 0.12);
    this.play(name, {
      vol,
      rate: 0.97 + Math.random() * 0.06,
      x: opts.x,
      y: opts.y,
      z: opts.z,
      src: opts.src ?? "local",
      step: { ...opts, local },
    });
  }

  /**
   * A banana frag going off. Two layers crossfaded on distance: the close burst
   * (crack + body + spray) and the far report (all low end), so the yard reads
   * the same event at every range without one loud sample being panned around.
   */
  boom(x: number, y: number, z: number, dist: number, src?: string): void {
    if (this.weapons.explosion(x, y, z, src)) return;
    // Near/far crossfade distances are reach, like everything else here.
    const near = Math.max(0, 1 - dist / (22 * MAP_SCALE));
    if (near > 0.02) {
      this.play("nade-boom", { x, y, z, vol: 0.34 + near * 0.5, rate: 0.95 + Math.random() * 0.1, src });
    }
    if (dist > 9 * MAP_SCALE) {
      this.play("nade-boom-far", { x, y, z, vol: 0.22 + Math.max(0, 1 - dist / (45 * MAP_SCALE)) * 0.3, src });
    }
    // Duck the guns for a beat: an explosion owns the mix while it decays.
    if (this.buses && this.ctx && near > 0.15) {
      const gg = this.buses.guns.gain;
      const t = this.ctx.currentTime;
      gg.cancelScheduledValues(t);
      gg.setTargetAtTime(0.45 * this.mixFx, t, 0.008);
      gg.setTargetAtTime(0.8 * this.mixFx, t + 0.24, 0.09);
    }
  }

  medal(kind: string): void {
    const name = this.families.has("medal-" + kind) ? "medal-" + kind : "medal-kill";
    this.play(name, { vol: 0.5 });
  }

  /**
   * Three-stage reload: mag out, mag in, charging handle. Every pack authors
   * exactly these three, and the synth has named twins, so the timing lives in
   * one place and a pack swap changes only the timbre.
   */
  reloadStart(id: string, duration: number): void {
    if (!this.ctx || !this.ready) return;
    if (this.weapons.reload(id, duration)) return;
    const stages: [number, string, number][] = [
      [0.14, "rl-magout", 0.26],
      [0.56, "rl-magin", 0.28],
      [0.86, "rl-rack", 0.3],
    ];
    for (const [frac, name, vol] of stages) {
      const delay = frac * duration * 1000;
      setTimeout(() => this.play(name, { vol, src: "local" }), delay);
    }
  }

  // ---- weapons stream: recorded weapon foley (no synth twin: silent until the samples are in) ----

  /** Every frame with the LOCAL held weapon: a change is a raise (per-weapon equip foley); death cancels a reload. */
  held(weaponId: string, alive: boolean): void {
    this.weapons.held(weaponId, alive);
  }

  /**
   * game.ts's per-frame weapons hook: the held weapon (held()) and, once it exists, the FX stream's WeaponFx
   * (`host.wfx`) so the rounds it lands and the brass it throws make their sounds — bound by duck type, so this file
   * has no compile-time dependency on the FX module's class.
   */
  frame(host: object, weaponId: string, alive: boolean): void {
    this.weapons.held(weaponId, alive);
    if (!this.fxBound) this.bindFx((host as { wfx?: unknown }).wfx);
  }

  private fxBound = false;

  /**
   * Hang the bullet-impact and 3P-brass sounds on WeaponFx: `impact(x,y,z, dx,dy,dz, hit, weapon, delay)` is where a
   * round lands (the collider it hit -> the surface class, `delay` = the tracer's flight), `casing3P(ex,ey,ez,...)`
   * is a remote shooter's case leaving the port (it lands ~0.45 s later at their feet).
   */
  bindFx(fx: unknown): void {
    type Impact = (x: number, y: number, z: number, dx: number, dy: number, dz: number, hit: OBB | null, weapon: string, delay?: number) => void;
    type Brass = (ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, weapon: string) => void;
    const f = fx as { impact?: Impact; casing3P?: Brass } | null | undefined;
    if (!f || typeof f.impact !== "function") return;
    this.fxBound = true;
    const mapId = activeMap().id;
    const impact = f.impact.bind(f);
    f.impact = (x, y, z, dx, dy, dz, hit, weapon, delay = 0) => {
      impact(x, y, z, dx, dy, dz, hit, weapon, delay);
      this.weapons.impact(x, y, z, surfaceOf(hit, mapId), delay);
    };
    if (typeof f.casing3P === "function") {
      const brass = f.casing3P.bind(f);
      f.casing3P = (ex, ey, ez, dx, dy, dz, weapon) => {
        brass(ex, ey, ez, dx, dy, dz, weapon);
        // the bolt gun's case leaves on the bolt stroke, not the shot
        if (weapon === "sniper" || weapon === "knife") return;
        const l = Math.hypot(dx, dz) || 1;
        const cx = ex - (dz / l) * 0.6;
        const cz = ez + (dx / l) * 0.6;
        this.weapons.casing(cx, groundHeight(cx, cz, undefined, ey) + 0.02, cz, 0.42 + Math.random() * 0.1);
      };
    }
  }

  /** The raise of `weaponId`, explicitly (held() already calls this on a change). */
  /** Someone else's reload at their position (game.ts detects it off the snapshot). */
  reloadRemote(weaponId: string, seconds: number, x: number, y: number, z: number, src?: string): void {
    this.weapons.reloadAt(weaponId, seconds, x, y, z, src);
  }

  equip(weaponId: string): void {
    this.weapons.equip(weaponId);
  }

  /** Trigger pulled on an empty gun with nothing left to reload. */
  dry(weaponId: string): void {
    if (!this.weapons.dry(weaponId) && this.ready) this.play("nade-empty", { vol: 0.3 });
  }

  /** Your knife swing (2D). */
  knife(): void {
    this.weapons.knife();
  }

  /** A spent case landing: no position = yours. Calling it hands casing timing to the caller (FX) for 5 s. */
  casing(x?: number, y?: number, z?: number): void {
    this.weapons.casing(x, y, z);
  }

  /** A bullet hitting the world at (x,y,z). `surface` = the FX surface class (metal / concrete / stone / wood / dirt / sand / glass / rubber). */
  impact(x: number, y: number, z: number, surface?: string): void {
    this.weapons.impact(x, y, z, surface);
  }

  /** Someone else's round along (o + t·d): a whizz if it passes within ~2.4 m of your head. */
  flyby(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, src?: string): void {
    this.weapons.flyby(ox, oy, oz, dx, dy, dz, src);
  }

  /** The whole yard hears these: deploy, and the final whistle. */
  matchStart(): void {
    // game.boot() calls this right after loopAmb(), possibly while the rig is
    // still !ready (no gesture yet on a deep-link deploy): play() would
    // early-return and drop the sting. Remember it instead — boot() replays it
    // once the deferred boot completes inside the unlock gesture. A later call
    // that does play clears the flag so the deferred replay cannot double-play.
    if (!this.ctx || !this.ready) {
      this.wantMatchStart = true;
      return;
    }
    this.wantMatchStart = false;
    this.play("match-start", { vol: 0.42 });
  }

  matchEnd(): void {
    this.play("match-end", { vol: 0.46 });
  }

  uiClick(): void {
    this.play("ui", { vol: 0.22 });
  }

  uiGo(): void {
    this.play("ui-go", { vol: 0.3 });
  }

  /**
   * MATCH FEEL cues. All four are non-positional (`ui` bus) and all four exist
   * under every sound pack: no pack authors a countdown, so play() falls through
   * to the synth family — see the note beside their fam() definitions.
   */

  /** One 3-2-1 beat. `beat` is 3, 2 or 1 and the pitch climbs with it. */
  countBeat(beat: number): void {
    // 554 -> 659 -> 740 Hz: three rungs of the same A-major pentatonic every
    // medal in this game is built on, so the count belongs to the same music.
    const rate = beat >= 3 ? 1 : beat === 2 ? 1.189 : 1.335;
    this.play("count-tick", { vol: 0.42, rate, src: "local" });
  }

  /** The GO beat — an octave over the ticks, the loudest thing in the block. */
  countGo(): void {
    this.play("count-go", { vol: 0.5, src: "local" });
  }

  /** Rounds landed in the reserve: a kill's resupply, or a scavenged clip. */
  resupply(): void {
    this.play("resupply", { vol: 0.4, src: "local" });
  }

  /** Health back to full after breaking contact. Warm, quiet, once. */
  recovered(): void {
    this.play("recover", { vol: 0.34, src: "local" });
  }

  nextMonkey = 26;

  /** Sparse positional jungle accents over the bed. Never two of a kind close
   *  together, never dense enough to become texture the ear stops hearing. */
  tickAmb(dt: number): void {
    if (ORBITAL) return;
    if (!this.ready) return;
    this.nextBird -= dt;
    if (this.nextBird <= 0) {
      const a = Math.random() * Math.PI * 2;
      const r = 14 + Math.random() * 12;
      this.play("bird", {
        vol: 0.16 + Math.random() * 0.08,
        rate: 0.92 + Math.random() * 0.18,
        x: this.listenerX + Math.cos(a) * r,
        y: 4 + Math.random() * 4,
        z: this.listenerZ + Math.sin(a) * r,
        src: "amb",
      });
      this.nextBird = 8 + Math.random() * 17;
    }
    this.nextInsect -= dt;
    if (this.nextInsect <= 0) {
      const a = Math.random() * Math.PI * 2;
      this.play("insect", {
        vol: 0.1,
        x: this.listenerX + Math.cos(a) * 18,
        y: 1,
        z: this.listenerZ + Math.sin(a) * 18,
        src: "amb",
      });
      this.nextInsect = 9 + Math.random() * 8;
    }
    this.nextMonkey -= dt;
    if (this.nextMonkey <= 0) {
      const a = Math.random() * Math.PI * 2;
      const r = 22 + Math.random() * 10;
      this.play("monkey", {
        vol: 0.12,
        rate: 0.9 + Math.random() * 0.2,
        x: this.listenerX + Math.cos(a) * r,
        y: 6 + Math.random() * 3,
        z: this.listenerZ + Math.sin(a) * r,
        src: "amb",
      });
      this.nextMonkey = 34 + Math.random() * 40;
    }
  }

  private ambSrc: AudioBufferSourceNode | null = null;

  /**
   * The jungle bed. Pack or synth, looped, non-positional (a bed has no
   * bearing), and deliberately low so nearby movement and combat remain clear.
   */
  loopAmb(): void {
    if (!this.ctx || !this.ready || this.ambStarted) return;
    const pev = ORBITAL ? null : this.pack?.get("room") ?? null;
    const buf = pev ? pev.buffers[0] : this.families.get(ORBITAL ? "orbital-room" : "room")?.variants[0];
    if (!buf) return;
    this.ambStarted = true;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    // Keep the steady bed behind the action. Positional accents have separate
    // gains and keep their authored level.
    g.gain.value = 0.25 * (pev ? pev.match : 1);
    src.connect(g);
    g.connect(this.buses.amb);
    src.start();
    this.ambSrc = src;
  }

  /** Re-cue the bed with the newly selected pack's loop (or the synth's). */
  restartAmb(): void {
    if (!this.ambStarted) return;
    try {
      this.ambSrc?.stop();
    } catch {
      /* already gone */
    }
    this.ambSrc = null;
    this.ambStarted = false;
    this.loopAmb();
  }

  // ---------------- offline QA renders ----------------

  private offlineGraph(ctx: OfflineAudioContext): { buses: Record<BusName, GainNode>; verbIn: GainNode } {
    const { buses, verbIn, out } = this.buildGraph(ctx);
    out.gain.value = this.vol;
    out.connect(ctx.destination);
    return { buses, verbIn };
  }

  private combine(rendered: AudioBuffer): Float32Array {
    // Equal downmix — max-picking between (time-offset) channels injects
    // broadband switching hash that corrupts spectral analysis.
    const l = rendered.getChannelData(0);
    const r = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : l;
    const out = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) out[i] = (l[i]! + r[i]!) * 0.5;
    return out;
  }

  private gunsCalibrated = new Set<string>();

  /** Render each gun variant through the real graph once and apply makeup so
   *  round-robin render peaks sit within ±0.3dB of slot 0 (the compressor's
   *  attack-shape sensitivity makes buffer-domain equalization insufficient). */
  async calibrateGuns(names = Object.keys(GUNS)): Promise<void> {
    this.ensureBaked();
    for (const name of names) {
      if (this.gunsCalibrated.has(name)) continue;
      this.gunsCalibrated.add(name);
      const fam = this.families.get(name);
      if (!fam) continue;
      const peaks: number[] = [];
      for (const buf of fam.variants) {
        const ctx = new OfflineAudioContext(2, Math.floor((buf.duration + 0.8) * SR), SR);
        const { buses } = this.offlineGraph(ctx);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = Math.min(2.2, 0.4 * fam.baseVol * 1.6);
        src.connect(g);
        g.connect(buses[fam.bus]);
        src.start();
        const r = await ctx.startRendering();
        const d = r.getChannelData(0);
        let m = 1e-9;
        for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]!));
        peaks.push(m);
      }
      // Same offset magnitudes for every gun, but permuted+jittered per gun so
      // no two guns share a loudness ordering across their round-robin slots.
      let h2 = 0;
      for (let ci = 0; ci < name.length; ci++) h2 = (h2 * 31 + name.charCodeAt(ci)) >>> 0;
      const pr = lcg((h2 ^ 0x00c0ffee) >>> 0);
      const mags = [-0.7, 0.6, -0.4];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(pr() * (i + 1));
        [mags[i], mags[j]] = [mags[j]!, mags[i]!];
      }
      const OFF_DB = [0, mags[0]! * (0.85 + pr() * 0.3), mags[1]! * (0.85 + pr() * 0.3), mags[2]! * (0.85 + pr() * 0.3)];
      for (let v = 1; v < fam.variants.length; v++) {
        const mk = Math.min(2, Math.max(0.5, (peaks[0]! / peaks[v]!) * Math.pow(10, OFF_DB[v % 4]! / 20)));
        const ch = fam.variants[v]!.getChannelData(0);
        let bp = 1e-9;
        for (let i = 0; i < ch.length; i++) bp = Math.max(bp, Math.abs(ch[i]!));
        const gc = Math.min(mk, 0.95 / bp);
        for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * gc;
      }
    }
  }

  // ---------------- offline QA renders: the recorded weapon set ----------------

  /** decode the weapon library without booting a live context (QA harnesses) */
  async loadWeaponsOffline(): Promise<boolean> {
    if (!this.weapons.loaded) await this.weapons.lib.load(this.ctx ?? new OfflineAudioContext(2, 128, SR));
    return this.weapons.loaded;
  }

  /**
   * Render a scripted weapon scene through the REAL master stage (graph + limiter worklet) and a fresh engine that
   * shares the decoded library. `script(eng, at)` schedules calls: `at(t)` pins the engine's clock to t seconds.
   * Listener at the origin, facing +Z, ear height 1.6 m; occlusion off (a pure mix measurement).
   */
  async renderWeaponScene(seconds: number, script: (eng: WeaponAudio, at: (t: number) => void) => void, raw = false): Promise<{ l: Float32Array; r: Float32Array; stats: WeaponAudioStats; worklet: boolean }> {
    this.ensureBaked();
    await this.loadWeaponsOffline();
    const ctx = new OfflineAudioContext(2, Math.floor(seconds * SR), SR);
    const { buses, verbIn, out, pre } = this.buildGraph(ctx);
    out.gain.value = 1;
    out.connect(ctx.destination);
    // raw = no master dynamics at all (what the limiter would have had to catch)
    if (raw) {
      pre.disconnect();
      pre.connect(out);
    }
    const worklet = raw ? false : !!(await upgradeMaster(ctx, pre, out));
    const eng = new WeaponAudio(MAP_SCALE, this.weapons.lib);
    this.weapons.lib.resetBags();
    this.attachWeapons(ctx, pre, verbIn, buses.amb, eng);
    eng.occluder = null;
    let seed = 20261019;
    eng.rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    eng.listen(0, 1.6, 0, 0);
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = 0;
      l.positionY.value = 1.6;
      l.positionZ.value = 0;
      l.forwardX.value = 0;
      l.forwardY.value = 0;
      l.forwardZ.value = 1;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
    script(eng, (t) => (eng.clock = t));
    const rendered = await ctx.startRendering();
    return { l: rendered.getChannelData(0), r: rendered.getChannelData(1), stats: eng.stats(), worklet };
  }

  /**
   * Weapon render names (sound-report / qa/weapon-audio-mix):
   *   w:<gun>            your shot            w:<gun>@<m>       someone's shot <m> metres to your right
   *   w:burst:<gun>      your 10-round burst  w:reload:<gun>:tac|empty     w:equip:<gun>
   *   w:hit | w:head | w:kill | w:hurt | w:dry | w:knife | w:nade | w:boom@<m> | w:impact:<surface>@<m>
   */
  async renderWeapon(name: string, seconds = 2, raw = false): Promise<{ l: Float32Array; r: Float32Array; stats: WeaponAudioStats; worklet: boolean }> {
    const [head, at] = name.slice(2).split("@");
    const d = at !== undefined ? Number(at) : 0;
    const parts = head!.split(":");
    return this.renderWeaponScene(seconds, (eng, clock) => {
      clock(0.05);
      const k = parts[0]!;
      if ((GUN_IDS as readonly string[]).includes(k)) {
        // someone else: 30° to your front-right (a fair ear: neither the HRTF's near-ear boost nor its head shadow)
        if (at !== undefined) eng.shot(k, -d * 0.5, 1.6, d * 0.866, false, "probe");
        else eng.shot(k, 0, 1.6, 0, true, "local");
      } else if (k === "burst") {
        const id = parts[1] ?? "ar";
        const iv = 60 / (id === "smg" ? 900 : id === "pistol" ? 450 : id === "sniper" ? 48 : 780);
        for (let i = 0; i < 10; i++) {
          clock(0.05 + i * iv);
          eng.shot(id, 0, 1.6, 0, true, "local");
        }
      } else if (k === "reload") {
        const id = parts[1] ?? "ar";
        const w = { ar: [1.55, 1.95], smg: [1.45, 1.8], sniper: [2.3, 2.8], pistol: [1.15, 1.4] }[id] ?? [1.5, 1.9];
        eng.reload(id, parts[2] === "empty" ? w[1]! : w[0]!);
      } else if (k === "equip") eng.equip(parts[1] ?? "ar");
      else if (k === "hit") eng.confirm(false, false);
      else if (k === "head") eng.confirm(true, false);
      else if (k === "kill") eng.confirm(false, true);
      else if (k === "hurt") eng.hurt();
      else if (k === "dry") eng.dry("ar");
      else if (k === "knife") eng.knife();
      else if (k === "flesh") eng.flesh(-(d || 5) * 0.5, 1.4, (d || 5) * 0.866);
      else if (k === "whizz") eng.flyby(-30, 1.6, 20, 30, 0, -19, "probe");
      else if (k === "casing") eng.casing();
      else if (k === "bounce") eng.nade("bounce", { x: -(d || 4) * 0.5, y: 0.2, z: (d || 4) * 0.866, vol: 0.4 });
      else if (k === "nade-pin") eng.nade("pin");
      else if (k === "nade-tick") eng.nade("tick", { vol: 0.34, rate: 1.25 });
      else if (k === "nade-throw") eng.nade("throw");
      else if (k === "boom") eng.explosion(-(d || 8) * 0.5, 1.6, (d || 8) * 0.866);
      else if (k === "impact") eng.impact(-Math.max(1, d) * 0.5, 1.2, Math.max(1, d) * 0.866, parts[1]);
      else if (k === "nade") {
        eng.nade("pin");
        for (let i = 1; i <= 3; i++) {
          clock(0.05 + i * 0.5);
          eng.nade("tick", { vol: i === 3 ? 0.34 : 0.22, rate: i === 3 ? 1.25 : 1 });
        }
        clock(1.75);
        eng.nade("throw");
      }
    }, raw);
  }

  /**
   * THE 12-PLAYER STRESS SCENE: you on full-auto AR bursts + 11 shooters (every class) at 4-40 m all around, firing at
   * their real cadence, their rounds hitting the walls near you, two whizzing past, your hit confirms, and a frag 9 m
   * away at 1.6 s. The voice limits, ducks and master limiter are all live.
   */
  async renderWeaponStress(seconds = 4, raw = false): Promise<{ l: Float32Array; r: Float32Array; stats: WeaponAudioStats; worklet: boolean }> {
    const R = lcg(4242);
    const guns = ["ar", "smg", "pistol", "sniper", "ar", "smg", "ar", "pistol", "smg", "ar", "sniper"];
    const dists = [4, 6, 9, 12, 15, 18, 22, 26, 30, 35, 40];
    const rpm: Record<string, number> = { ar: 780, smg: 900, pistol: 300, sniper: 48 };
    type Ev = { t: number; f: (eng: WeaponAudio) => void };
    const evs: Ev[] = [];
    // you: 6-round AR bursts every 0.9 s, a confirm on every third round, a kill at the end
    for (let b = 0; b * 0.9 < seconds - 0.6; b++) {
      for (let i = 0; i < 6; i++) {
        const t = 0.05 + b * 0.9 + i * (60 / 780);
        evs.push({ t, f: (e) => e.shot("ar", 0, 1.6, 0, true, "local") });
        if (i % 3 === 2) evs.push({ t: t + 0.01, f: (e) => e.confirm(i === 5 && b % 2 === 1, false) });
      }
    }
    evs.push({ t: seconds * 0.7, f: (e) => e.confirm(false, true) });
    guns.forEach((g, k) => {
      const a = R() * Math.PI * 2;
      const x = Math.sin(a) * dists[k]! * MAP_SCALE;
      const z = Math.cos(a) * dists[k]! * MAP_SCALE;
      const iv = 60 / rpm[g]!;
      let t = R() * 0.3;
      while (t < seconds - 0.3) {
        const n = g === "sniper" ? 1 : 3 + Math.floor(R() * 6);
        for (let i = 0; i < n && t < seconds - 0.3; i++, t += iv) {
          const tt = t;
          evs.push({ t: tt, f: (e) => e.shot(g, x, 1.5, z, false, "p" + k) });
          if (R() < 0.25) {
            const ix = (R() - 0.5) * 8;
            const iz = (R() - 0.5) * 8;
            evs.push({ t: tt + 0.03, f: (e) => e.impact(ix, R() < 0.5 ? 0 : 1 + R(), iz) });
          }
        }
        t += 0.25 + R() * 0.5;
      }
      if (k < 2) evs.push({ t: 0.8 + k * 0.9, f: (e) => e.flyby(x, 1.5, z, -x, 0.1, -z + 0.8, "p" + k) });
    });
    evs.push({ t: 1.6, f: (e) => e.explosion(6, 0.3, 7, "nade") });
    evs.sort((a, b) => a.t - b.t);
    return this.renderWeaponScene(seconds, (eng, clock) => {
      for (const ev of evs) {
        clock(ev.t);
        ev.f(eng);
      }
    }, raw);
  }

  async renderOffline(name: string, seconds = 2, variant = 0): Promise<Float32Array> {
    if (name.startsWith("w:")) {
      const r = await this.renderWeapon(name, seconds);
      const out = new Float32Array(r.l.length);
      for (let i = 0; i < out.length; i++) out[i] = (r.l[i]! + r.r[i]!) * 0.5;
      return out;
    }
    this.ensureBaked();
    await this.calibrateGuns();
    if (name === "ambience") {
      const ctx = new OfflineAudioContext(2, Math.floor(3 * SR), SR);
      const { buses } = this.offlineGraph(ctx);
      const bed = ctx.createBufferSource();
      bed.buffer = this.families.get("room")!.variants[0]!;
      bed.loop = true;
      const bg = ctx.createGain();
      bg.gain.value = 0.9;
      bed.connect(bg);
      bg.connect(buses.amb);
      bed.start();
      return this.combine(await ctx.startRendering());
    }
    const fam = this.families.get(name);
    if (!fam) return new Float32Array(0);
    const buf = fam.variants[Math.min(variant, fam.variants.length - 1)]!;
    const dur = Math.max(seconds, buf.duration + 0.7);
    const ctx = new OfflineAudioContext(2, Math.floor(dur * SR), SR);
    const { buses, verbIn } = this.offlineGraph(ctx);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.min(2.2, 0.4 * fam.baseVol * 1.6);
    src.connect(g);
    g.connect(buses[fam.bus]);
    if (fam.send > 0) {
      const sg = ctx.createGain();
      sg.gain.value = fam.send;
      g.connect(sg);
      sg.connect(verbIn);
    }
    src.start();
    return this.combine(await ctx.startRendering());
  }

  async renderStress(shots: number, seconds: number): Promise<Float32Array> {
    // weapons stream: with the recorded set available the stress render IS the 12-player scene (the synth one below
    // stays as the fallback when the samples cannot be fetched)
    if (await this.loadWeaponsOffline().catch(() => false)) {
      const r = await this.renderWeaponStress(seconds);
      const out = new Float32Array(r.l.length);
      for (let i = 0; i < out.length; i++) out[i] = (r.l[i]! + r.r[i]!) * 0.5;
      void shots;
      return out;
    }
    this.ensureBaked();
    await this.calibrateGuns();
    const ctx = new OfflineAudioContext(2, Math.floor(seconds * SR), SR);
    const { buses, verbIn } = this.offlineGraph(ctx);
    const rng = lcg(4242);
    const ids = Object.keys(GUNS);
    for (let i = 0; i < shots; i++) {
      const fam = this.families.get(ids[i % ids.length]!)!;
      const src = ctx.createBufferSource();
      src.buffer = fam.variants[i % fam.variants.length]!;
      src.playbackRate.value = 0.98 + rng() * 0.04;
      const g = ctx.createGain();
      g.gain.value = Math.min(2.2, 0.42 * fam.baseVol * 1.6);
      src.connect(g);
      const pan = ctx.createPanner();
      pan.panningModel = "HRTF";
      pan.distanceModel = "inverse";
      pan.refDistance = 5;
      pan.maxDistance = 46;
      pan.rolloffFactor = 1.2;
      const a = rng() * Math.PI * 2;
      const r = 2 + rng() * 26;
      if (pan.positionX) {
        pan.positionX.value = Math.cos(a) * r;
        pan.positionY.value = 1.5;
        pan.positionZ.value = Math.sin(a) * r;
      }
      g.connect(pan);
      pan.connect(buses.guns);
      const sg = ctx.createGain();
      sg.gain.value = fam.send;
      pan.connect(sg);
      sg.connect(verbIn);
      src.start(rng() * (seconds - 0.7));
    }
    return this.combine(await ctx.startRendering());
  }
}
