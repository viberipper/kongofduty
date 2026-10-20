/**
 * client/src/feel-extras.ts — the small things that make a death and a near-
 * death READ (feel stream). Found by playing; each one is a few lines and none
 * of them touches the sim.
 *
 *  1. LOW-HEALTH HEARTBEAT. Under 35 hp a soft lub-dub (two low sine thumps,
 *     ~55 / 48 Hz, 9 ms attack) at a rate that climbs as health falls (64 →
 *     112 bpm), with a faint vignette pulse on the beat. Quiet (≈ −20 dBFS
 *     before the INTERFACE bus), ducked under gunfire, gone the moment health
 *     recovers past 40 or you die. No pulse under reduced motion.
 *  2. DEATH RECAP on the killcam plate: how far away they were, whether it was
 *     a headshot, and how fast it went — "KR-4 CAVENDISH · 23 M · HEADSHOT" and
 *     "4 HITS · 112 DMG IN 0.6 S" (the killer's hits on you since your last
 *     clean second). The killer's remaining health was already on the plate.
 *  3. SPAWN PROTECTION, READABLE. The crosshair over an enemy who is still
 *     spawn-protected turns into a struck-through ring — those shots will not
 *     count (the server drops them, and the hitmarker is already suppressed),
 *     and now the player can see why.
 */
import type { AudioRig2 } from "./audio2";
import { reducedMotion } from "./ui/prefs";

type HitIn = { at: number; src: string; dmg: number };

export class FeelExtras {
  private hits: HitIn[] = [];
  private beatAt = 0;
  private beating = false;
  private shots: number[] = [];
  private pulse: HTMLElement | null = null;
  private pulseT = 1;
  private bufs: { lub?: AudioBuffer; dub?: AudioBuffer } = {};

  constructor(private audio: AudioRig2) {}

  // ---------------------------------------------------------------- 2. recap

  /** A hit on YOU (game.ts handleEvents). */
  hitOnMe(src: string, dmg: number, nowS: number): void {
    this.hits.push({ at: nowS, src, dmg });
    if (this.hits.length > 64) this.hits.splice(0, this.hits.length - 64);
  }

  /** "KR-4 CAVENDISH · 23 M · HEADSHOT" — the how line of the killcam plate. */
  how(base: string, dist: number, head: boolean): string {
    const parts = [base];
    if (Number.isFinite(dist) && dist >= 1) parts.push(`${Math.round(dist)} M`);
    if (head) parts.push("HEADSHOT");
    return parts.join("  ·  ");
  }

  /** "4 HITS · 112 DMG IN 0.6 S": the killer's run of hits on you that ended in this death. */
  recap(killer: string, nowS: number): string {
    // The run: hits by the killer, walking back from the death until a gap over 1.5 s.
    const mine = this.hits.filter((h) => h.src === killer && nowS - h.at < 8).sort((a, b) => b.at - a.at);
    const run: HitIn[] = [];
    let last = nowS;
    for (const h of mine) {
      if (last - h.at > 1.5) break;
      run.push(h);
      last = h.at;
    }
    this.hits.length = 0;
    if (!run.length) return "";
    const dmg = Math.round(run.reduce((s, h) => s + h.dmg, 0));
    const span = Math.max(0, run[0]!.at - run[run.length - 1]!.at);
    return `${run.length} HIT${run.length === 1 ? "" : "S"}  ·  ${dmg} DMG${run.length > 1 ? ` IN ${span.toFixed(1)} S` : ""}`;
  }

  /** Put the recap line on the killcam plate (created on demand, emptied when there is none). */
  paintRecap(text: string): void {
    const plate = document.querySelector("#killcam .kc-plate");
    if (!plate) return;
    let el = document.getElementById("kc-recap");
    if (!el) {
      el = document.createElement("span");
      el.id = "kc-recap";
      plate.insertBefore(el, plate.querySelector(".kc-hp"));
    }
    el.textContent = text;
  }

  // ---------------------------------------------------------------- 1. heartbeat

  noteShot(nowS: number): void {
    this.shots.push(nowS);
    if (this.shots.length > 48) this.shots.splice(0, this.shots.length - 48);
  }

  /** Per frame: `hp` of the body you are playing, `on` false whenever the heartbeat must stop (dead, killcam, spectating, menus). */
  heartbeat(hp: number, on: boolean, nowS: number, dt: number): void {
    const low = on && hp > 0 && (this.beating ? hp < 40 : hp < 35);
    this.beating = low;
    this.tickPulse(dt);
    if (!low) return;
    const bpm = 64 + Math.min(1, (35 - Math.min(35, hp)) / 30) * 48;
    const period = 60 / bpm;
    if (nowS - this.beatAt < period) return;
    this.beatAt = nowS;
    this.beat(hp, nowS);
  }

  private beat(hp: number, nowS: number): void {
    const ctx = this.audio.ctx;
    const bus = (this.audio as unknown as { buses?: Record<string, GainNode> }).buses?.ui;
    if (ctx && bus && this.audio.ready) {
      const heard = this.shots.filter((t) => nowS - t < 0.8).length;
      const duck = Math.max(0.45, 1 - heard * 0.08);
      const k = (0.55 + 0.45 * Math.min(1, (35 - hp) / 30)) * duck;
      this.play(ctx, bus, "lub", 0.42 * k, 0);
      this.play(ctx, bus, "dub", 0.3 * k, 0.15);
    }
    if (!reducedMotion()) this.pulseT = 0;
  }

  private play(ctx: AudioContext, bus: AudioNode, kind: "lub" | "dub", gain: number, delay: number): void {
    let b = this.bufs[kind];
    if (!b) {
      const sr = ctx.sampleRate;
      const n = Math.floor(sr * 0.22);
      const d = new Float32Array(n);
      const f = kind === "lub" ? 55 : 48;
      let peak = 1e-6;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.009) * Math.exp(-t / (kind === "lub" ? 0.055 : 0.045));
        d[i] = (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.02 * t)) * env;
        peak = Math.max(peak, Math.abs(d[i]!));
      }
      for (let i = 0; i < n; i++) d[i] = (d[i]! / peak) * 0.25;
      b = ctx.createBuffer(1, n, sr);
      b.copyToChannel(d, 0);
      this.bufs[kind] = b;
    }
    const src = ctx.createBufferSource();
    src.buffer = b;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(bus);
    src.start(ctx.currentTime + delay);
  }

  private tickPulse(dt: number): void {
    if (!this.pulse || !this.pulse.isConnected) {
      const hud = document.getElementById("hud");
      if (!hud) return;
      this.pulse = document.getElementById("hb-pulse") ?? document.createElement("div");
      this.pulse.id = "hb-pulse";
      if (!this.pulse.isConnected) hud.insertBefore(this.pulse, hud.firstChild);
    }
    this.pulseT = Math.min(1, this.pulseT + dt / 0.45);
    const o = this.beating ? (1 - this.pulseT) * (1 - this.pulseT) * 0.55 : 0;
    const v = o.toFixed(3);
    if (this.pulse.style.opacity !== v) this.pulse.style.opacity = v;
  }

  /** New life / new match. */
  reset(): void {
    this.hits.length = 0;
    this.beating = false;
    this.pulseT = 1;
  }
}
