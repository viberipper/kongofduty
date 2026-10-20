/**
 * client/src/medal-stings.ts — the medal stings (feel stream).
 * ===========================================================================
 *
 * One quiet sting per KILL (never one per medal): the medal row (ui/medals.ts)
 * may pop three emblems, but the ear gets the single most important cue. Built
 * to be pleasant the five-hundredth time, not exciting the first:
 *
 *   tier 1  every medal its own small figure (FIGURES below): HEADSHOT a soft
 *           glass "ting" (E6 + B6 over a faint E5, 4 ms attack, ~100 ms decay),
 *           LONGSHOT the ting with a far echo, a frag a low tok, PAYBACK and
 *           REVENGE a rising pair, FIRST BLOOD a warm fifth, LAST STAND a low
 *           swell — all low-passed at 4.5 kHz: no transient spike, no ring.
 *   multi   (double / triple / quad)  2-4 rising mallet notes on the same
 *           E-major pentatonic the countdown and the old medals use, 65 ms
 *           apart, each ~150 ms.
 *   big     (rampage, killstreaks)  a slow-attack A-major swell with one
 *           shimmer partial, 0.7 s — warm, not a fanfare.
 *
 * Peaks are normalised to ≈ −14 dBFS before the INTERFACE bus, ~10 dB under the
 * kill-confirm thwack it follows, and it lands 140 ms after it (KR's rule: the
 * confirm is the impact, the medal is the fanfare).
 *
 * NO EAR-BLEED WITH TWELVE PEOPLE FIGHTING. Only the local player's kills sting
 * at all; a sting inside 220 ms of the last is dropped; past four in five
 * seconds only the big ones get through; and the level DUCKS under gunfire —
 * every shot heard in the last 0.8 s takes it down (to −6 dB at most), so in a
 * firefight the sting sits under the guns instead of on top of them.
 *
 * Buffers are synthesised once on the rig's own AudioContext and routed into
 * its INTERFACE bus, so MASTER × INTERFACE (SETTINGS → AUDIO) applies.
 */
import type { AudioRig2 } from "./audio2";

/**
 * Every medal its own small figure, all on one E-major pentatonic (the
 * countdown's and the old medals' scale), all soft-attack sines: [freq Hz,
 * start s, amplitude, decay τ s, attack s, pan]. The ear learns them like CoD's:
 * HEADSHOT is the crisp high ting, LONGSHOT the ting with a far echo, a frag the
 * low tok, the multi-kills climb one note per kill.
 */
type Note = [number, number, number, number, number?, number?];
const E5 = 659.25, FS5 = 739.99, GS5 = 830.61, B5 = 987.77, CS6 = 1108.73, E6 = 1318.51, B6 = 1975.53, A4 = 440, E4 = 329.63, A3 = 220;
const FIGURES: Record<string, { len: number; notes: Note[] }> = {
  headshot: { len: 0.4, notes: [[E6, 0, 0.55, 0.1], [B6, 0.004, 0.28, 0.065, 0.004, 0.25], [E5, 0, 0.22, 0.14, 0.006, -0.2]] },
  longshot: { len: 0.55, notes: [[B5, 0, 0.5, 0.11], [FS5 * 2, 0.004, 0.18, 0.06], [B5, 0.13, 0.2, 0.12, 0.004, 0.45], [FS5 * 2, 0.134, 0.07, 0.06, 0.004, 0.45]] },
  frag: { len: 0.4, notes: [[A4, 0, 0.5, 0.07, 0.002], [E5, 0.004, 0.3, 0.09], [B5, 0.06, 0.25, 0.12]] },
  cooked: { len: 0.5, notes: [[A4, 0, 0.45, 0.07, 0.002], [E5, 0.004, 0.28, 0.09], [B5, 0.06, 0.25, 0.12], [E6, 0.12, 0.14, 0.12, 0.004, 0.3]] },
  payback: { len: 0.5, notes: [[E5, 0, 0.42, 0.12], [B5, 0.075, 0.42, 0.16, 0.004, 0.2]] },
  revenge: { len: 0.5, notes: [[GS5, 0, 0.4, 0.12, 0.004, -0.2], [CS6, 0.075, 0.4, 0.16, 0.004, 0.2]] },
  buzzkill: { len: 0.4, notes: [[B5, 0, 0.42, 0.06], [B5, 0.085, 0.36, 0.08, 0.004, 0.2]] },
  firstblood: { len: 0.7, notes: [[A4, 0, 0.42, 0.18, 0.008], [E5, 0.09, 0.42, 0.26, 0.008], [A4 * 2, 0.09, 0.1, 0.2, 0.008]] },
  laststand: { len: 0.8, notes: [[A3, 0, 0.38, 0.3, 0.06], [E4, 0.02, 0.32, 0.3, 0.06], [A4, 0.05, 0.16, 0.28, 0.05]] },
};
const NOTES = [E5, FS5, GS5, B5, CS6, E6];

export class MedalStings {
  private bufs = new Map<string, AudioBuffer>();
  private lastAt = -1e9;
  private recent: number[] = [];
  private shots: number[] = [];

  constructor(private rig: AudioRig2) {}

  /** Every gunshot event the client hears (game.ts): the duck's input. */
  noteShot(nowS: number): void {
    this.shots.push(nowS);
    if (this.shots.length > 64) this.shots.splice(0, this.shots.length - 64);
  }

  /**
   * The sting for one kill: its TOP medal's figure (`id`), or for the chain
   * medals `multi` = 2..4 rising notes / 5+ (and the killstreaks) the swell.
   */
  play(id: string, tier: 1 | 2, multi: number, nowS: number): void {
    const ctx = this.rig.ctx;
    const bus = (this.rig as unknown as { buses?: Record<string, GainNode> }).buses?.ui;
    if (!ctx || !bus || !this.rig.ready) return;
    if (nowS - this.lastAt < 0.22) return;
    this.recent = this.recent.filter((t) => nowS - t < 5);
    if (this.recent.length >= 4 && tier < 2) return;
    this.lastAt = nowS;
    this.recent.push(nowS);
    const kind: string = tier === 1 ? (FIGURES[id] ? id : "headshot") : multi >= 5 || multi === 0 ? "big" : multi === 4 ? "multi4" : multi === 3 ? "multi3" : "multi2";
    const buf = this.buffer(ctx, kind);
    // Duck under gunfire: each shot in the last 0.8 s costs ~0.6 dB, floor −6 dB.
    const heard = this.shots.filter((t) => nowS - t < 0.8).length;
    const duck = Math.max(0.5, 1 - heard * 0.07);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = (kind === "big" ? 0.62 : 0.55) * duck;
    src.connect(g).connect(bus);
    src.start(ctx.currentTime + 0.14);
  }

  private buffer(ctx: BaseAudioContext, kind: string): AudioBuffer {
    let b = this.bufs.get(kind);
    if (b) return b;
    const sr = ctx.sampleRate;
    const fig = FIGURES[kind];
    const len = Math.floor(sr * (kind === "big" ? 0.95 : fig ? fig.len : 0.6));
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    const tone = (f: number, at: number, amp: number, tau: number, atk = 0.004, pan = 0): void => {
      const i0 = Math.floor(at * sr);
      const gl = Math.cos(((pan + 1) * Math.PI) / 4);
      const gr = Math.sin(((pan + 1) * Math.PI) / 4);
      for (let i = i0; i < len; i++) {
        const t = (i - i0) / sr;
        const env = Math.min(1, t / atk) * Math.exp(-t / tau);
        if (env < 1e-4 && t > atk) break;
        const v = Math.sin(2 * Math.PI * f * t) * env * amp;
        L[i]! += v * gl;
        R[i]! += v * gr;
      }
    };
    if (fig) {
      for (const [f, at, amp, tau, atk, pan] of fig.notes) tone(f, at, amp, tau, atk ?? 0.004, pan ?? 0);
    } else if (kind === "big") {
      // A-major swell (A4 C#5 E5 A5) + a shimmer partial, slow attack
      for (const [f, a, p] of [[440, 0.32, -0.3], [554.37, 0.24, 0.2], [659.25, 0.26, -0.1], [880, 0.2, 0.3]] as const) tone(f, 0, a, 0.42, 0.07, p);
      tone(1760, 0.09, 0.08, 0.3, 0.05, 0.4);
      tone(1318.51, 0.16, 0.12, 0.22, 0.01, -0.35);
    } else {
      const n = kind === "multi4" ? 4 : kind === "multi3" ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const f = NOTES[Math.min(NOTES.length - 1, k + 2)]!;
        tone(f, k * 0.065, 0.42, 0.13, 0.003, (k - (n - 1) / 2) * 0.3);
        tone(f * 2, k * 0.065, 0.1, 0.06, 0.003, (k - (n - 1) / 2) * 0.3);
      }
    }
    // Gentle one-pole low-pass (4.5 kHz): takes the glassy edge off without dulling it.
    const a = Math.exp((-2 * Math.PI * 4500) / sr);
    for (const ch of [L, R]) {
      let y = 0;
      for (let i = 0; i < len; i++) {
        y = (1 - a) * ch[i]! + a * y;
        ch[i] = y;
      }
    }
    // Normalise to ≈ −14 dBFS peak, fade the tail.
    let peak = 1e-6;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
    const k = 0.2 / peak;
    const fade = Math.floor(sr * 0.03);
    for (let i = 0; i < len; i++) {
      const f = i > len - fade ? (len - i) / fade : 1;
      L[i]! *= k * f;
      R[i]! *= k * f;
    }
    b = ctx.createBuffer(2, len, sr);
    b.copyToChannel(L, 0);
    b.copyToChannel(R, 1);
    this.bufs.set(kind, b);
    return b;
  }
}
