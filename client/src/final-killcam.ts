/**
 * client/src/final-killcam.ts — THE FINAL KILLCAM (CoD), feel stream.
 * ===========================================================================
 *
 * When a match ends, the match-winning kill is replayed from the KILLER's eyes
 * before the endcard: a "FINAL KILLCAM" title card, the lead-up at full speed,
 * a slow-motion beat through the killing shot, a short hold, then the endcard.
 *
 * It rides the personal killcam's tape (game.ts recordFrame: every drawn frame
 * on the renderT clock, ~33 Hz) — so what plays back is exactly what was on
 * screens, prediction and interpolation included. The live tape only keeps
 * ~4.5 s, and a time-limit ending can come minutes after the last kill, so
 * every kill opens a CLIP here that holds its own references to the tape
 * frames (they are immutable copies, so nothing is duplicated) from a little
 * before the kill to a little after it. The last few clips are kept; finish()
 * picks the match-winning one.
 *
 * WHICH KILL. The last kill by the winning side — the winning team in TDM
 * (round wins in round-based rooms), the winner in FFA — falling back to the
 * last kill of the match. Every client receives the same kill events in the
 * same order, so every client (players and spectators, online and offline)
 * picks the same kill. Suicides never qualify.
 *
 * This file owns the clip bookkeeping, the pick rule and the title/plate DOM;
 * game.ts owns the playback (it already owns the camera, the actors and the
 * tape) — see Game.startFinalKillcam / tickFinalKillcam / finalCam.
 */
import type { PlayerSnap } from "@shared/protocol";

export type TapeFrame = { t: number; players: PlayerSnap[] };
export type TapeShot = { t: number; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; src: string; weapon?: string };
export type TapeHit = { t: number; src: string; dst: string; head: boolean; kill: boolean; x: number; y: number; z: number };
export type FinalKill = { t: number; src: string; dst: string; weapon: string; head: boolean; srcTeam: number; killer: string; victim: string };
export type Clip = { kill: FinalKill; frames: TapeFrame[]; shots: TapeShot[]; hits: TapeHit[]; until: number };

/** Lead-up shown before the killing shot (ms of tape), and the tail after it. */
export const FKC_PRE_MS = 2200;
export const FKC_TAIL_MS = 900;
/** Slow motion through the kill: from SLOW_IN before it to SLOW_OUT after, at SLOW_RATE. */
export const FKC_SLOW_IN = 260;
export const FKC_SLOW_OUT = 340;
export const FKC_SLOW_RATE = 0.45;
/** Seconds the freeze frame holds before the endcard. */
export const FKC_HOLD_S = 0.45;
/** The title card's life, seconds (in 0.32, hold, out 0.4). */
export const FKC_TITLE_S = 1.45;

const KEEP = 6;
const MARGIN = 120;

export class FinalKillTape {
  readonly clips: Clip[] = [];

  reset(): void {
    this.clips.length = 0;
  }

  /** A kill landed at tape time `k.t`: open its clip from what the live tape already holds. */
  kill(k: FinalKill, tape: readonly TapeFrame[], shots: readonly TapeShot[], hits: readonly TapeHit[]): void {
    if (k.src === k.dst || !k.src) return;
    const from = k.t - FKC_PRE_MS - MARGIN;
    const clip: Clip = {
      kill: k,
      frames: tape.filter((f) => f.t >= from),
      shots: shots.filter((s) => s.t >= from),
      hits: hits.filter((h) => h.t >= from),
      until: k.t + FKC_TAIL_MS + MARGIN,
    };
    this.clips.push(clip);
    while (this.clips.length > KEEP) this.clips.shift();
  }

  /** Every recorded frame: open clips keep collecting until their tail is on tape. */
  frame(f: TapeFrame): void {
    for (const c of this.clips) {
      if (f.t > c.until) continue;
      const last = c.frames[c.frames.length - 1];
      if (!last || f.t > last.t) c.frames.push(f);
    }
  }

  shot(s: TapeShot): void {
    for (const c of this.clips) if (s.t <= c.until && s.t >= c.kill.t - FKC_PRE_MS - MARGIN) c.shots.push(s);
  }

  hit(h: TapeHit): void {
    for (const c of this.clips) if (h.t <= c.until && h.t >= c.kill.t - FKC_PRE_MS - MARGIN) c.hits.push(h);
  }

  /**
   * The match-winning kill: the newest clip whose kill satisfies `winner`, else
   * the newest clip at all. A clip qualifies only if its tape actually shows the
   * killer (they may have joined the instant before).
   */
  pick(winner: (k: FinalKill) => boolean): Clip | null {
    const ok = (c: Clip): boolean => c.frames.length >= 2 && c.frames.some((f) => f.players.some((p) => p.id === c.kill.src));
    for (let i = this.clips.length - 1; i >= 0; i--) if (winner(this.clips[i]!.kill) && ok(this.clips[i]!)) return this.clips[i]!;
    for (let i = this.clips.length - 1; i >= 0; i--) if (ok(this.clips[i]!)) return this.clips[i]!;
    return null;
  }
}

/** Playback rate of the tape at `rel` ms from the kill: real time, slow through the shot. */
export function fkcRate(rel: number): number {
  return rel > -FKC_SLOW_IN && rel < FKC_SLOW_OUT ? FKC_SLOW_RATE : 1;
}

/** Wall-clock seconds a cut from `from` to the kill's freeze takes (slow motion included), plus the hold. */
export function fkcDuration(from: number, killT: number): number {
  const freeze = killT + FKC_TAIL_MS;
  let ms = 0;
  const seg = (a: number, b: number, r: number): void => {
    const lo = Math.max(a, from);
    const hi = Math.min(b, freeze);
    if (hi > lo) ms += (hi - lo) / r;
  };
  seg(-Infinity, killT - FKC_SLOW_IN, 1);
  seg(killT - FKC_SLOW_IN, killT + FKC_SLOW_OUT, FKC_SLOW_RATE);
  seg(killT + FKC_SLOW_OUT, Infinity, 1);
  return ms / 1000 + FKC_HOLD_S;
}

// ---------------------------------------------------------------- the DOM

/**
 * The cut reuses the killcam's chrome (#killcam: letterbox, notch, plate, SKIP
 * ring) in a FINAL variant: the notch reads FINAL KILLCAM, the plate names the
 * killer in their relation colour, how, and who went down, and a big title card
 * opens the cut. `restore()` hands the chrome back to the personal killcam.
 */
export type FinalPlate = { killer: string; victim: string; how: string; rel: "you" | "ally" | "enemy"; victimRel: "you" | "ally" | "enemy" };

export class FinalKillcamUi {
  private title: HTMLElement | null = null;
  private victim: HTMLElement | null = null;
  private shownAt = 0;

  show(p: FinalPlate, now: number): void {
    const kc = document.getElementById("killcam");
    if (!kc) return;
    kc.classList.add("final");
    kc.dataset.rel = p.rel;
    const tag = kc.querySelector(".kc-tag");
    if (tag) tag.textContent = "FINAL KILLCAM";
    const label = kc.querySelector(".kc-label");
    if (label) label.textContent = "FINAL KILL";
    const plate = kc.querySelector(".kc-plate");
    if (plate && !this.victim) {
      this.victim = document.createElement("span");
      this.victim.className = "kc-victim";
      plate.insertBefore(this.victim, plate.querySelector(".kc-hp"));
    }
    if (this.victim) {
      this.victim.replaceChildren();
      const b = document.createElement("b");
      b.className = `rel-${p.victimRel}`;
      b.textContent = p.victim;
      this.victim.append(document.createTextNode("ELIMINATED  "), b);
    }
    const killer = document.getElementById("killer");
    if (killer) killer.textContent = p.killer;
    const how = document.getElementById("kc-tag");
    if (how) how.textContent = p.how;
    if (!this.title) {
      this.title = document.createElement("div");
      this.title.id = "fkc-title";
      this.title.innerHTML = `<i></i><b>FINAL KILLCAM</b><span></span>`;
      kc.append(this.title);
    }
    const sub = this.title.querySelector("span");
    if (sub) sub.textContent = `${p.killer}  ·  ${p.how}`;
    this.shownAt = now;
    this.title.style.opacity = "0";
  }

  /** Per frame while the cut plays: the title card envelope (driven off the game clock). */
  tick(now: number): void {
    const t = this.title;
    if (!t) return;
    const age = (now - this.shownAt) / 1000;
    const inK = Math.min(1, age / 0.32);
    const ease = 1 - (1 - inK) ** 3;
    const out = age > FKC_TITLE_S - 0.4 ? Math.max(0, (FKC_TITLE_S - age) / 0.4) : 1;
    const o = (ease * out).toFixed(3);
    if (t.style.opacity !== o) t.style.opacity = o;
    t.style.setProperty("--fkc-k", ease.toFixed(3));
  }

  /** The cut is over: hide the title (the chrome itself is hidden by game.ts). */
  done(): void {
    if (this.title) this.title.style.opacity = "0";
  }

  /** Hand #killcam back to the personal killcam. */
  restore(): void {
    const kc = document.getElementById("killcam");
    if (!kc) return;
    kc.classList.remove("final");
    delete kc.dataset.rel;
    const tag = kc.querySelector(".kc-tag");
    if (tag) tag.textContent = "KILLCAM";
    const label = kc.querySelector(".kc-label");
    if (label) label.textContent = "KILLED BY";
    this.victim?.remove();
    this.victim = null;
    this.title?.remove();
    this.title = null;
  }
}
