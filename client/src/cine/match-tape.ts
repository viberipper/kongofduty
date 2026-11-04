/**
 * client/src/cine/match-tape.ts — THE WHOLE MATCH, ON TAPE, ON A BUDGET.
 * ===========================================================================
 *
 * The killcam tape (Game.recordFrame) keeps ~4.5 s of drawn frames as full
 * PlayerSnap copies; the final killcam pins a few seconds around each kill.
 * The play of the game can be ANY window of the match, so this keeps the
 * whole match — fed by the very same recordFrame call (one recording point,
 * same frames, same ~33 Hz renderT clock), but packed:
 *
 *   one Float32Array per frame, STRIDE floats per body:
 *     roster index, x, y, z, vx, vy, vz, yaw, pitch, hp, ads, slide, reload,
 *     swap, cook, flags (alive|sprint|crouch|firing|nadeUp), weapon*4096+ammo
 *
 *   12 bodies x 17 floats x 4 B = 816 B per frame; 33 Hz x 10 min ≈ 16 MB.
 *   Everything else a replay needs (name, team, op, holstered weapon …) is the
 *   body's latest full snapshot, kept once per id.
 *
 * BUDGET_BYTES caps it; past that the oldest frames go first (a 25-minute
 * match would start forgetting its first minutes). Shots and hits are small
 * records in capped arrays. clip(t0, t1) decodes only the window asked for.
 */
import type { PlayerSnap } from "@shared/protocol";
import type { TapeFrame, TapeHit, TapeShot } from "../final-killcam";

const STRIDE = 17;
export const BUDGET_BYTES = 40 * 1024 * 1024;
const MAX_SHOTS = 60000;
const MAX_HITS = 40000;

type Packed = { t: number; d: Float32Array };

export class MatchTape {
  private frames: Packed[] = [];
  private bytes = 0;
  private ids: string[] = [];
  private index = new Map<string, number>();
  private latest = new Map<string, PlayerSnap>();
  private weapons: string[] = [];
  private weaponIdx = new Map<string, number>();
  shots: TapeShot[] = [];
  hits: TapeHit[] = [];

  reset(): void {
    this.frames = [];
    this.bytes = 0;
    this.shots = [];
    this.hits = [];
    // ids / weapons tables survive: they are tiny and indices stay valid
  }

  get length(): number {
    return this.frames.length;
  }
  get span(): [number, number] {
    return this.frames.length ? [this.frames[0]!.t, this.frames[this.frames.length - 1]!.t] : [0, 0];
  }
  get usedBytes(): number {
    return this.bytes;
  }

  private wIdx(w: string): number {
    let i = this.weaponIdx.get(w);
    if (i === undefined) {
      i = this.weapons.length;
      this.weapons.push(w);
      this.weaponIdx.set(w, i);
    }
    return i;
  }

  /** One drawn frame (renderT ms, the players as drawn). */
  frame(t: number, players: readonly PlayerSnap[]): void {
    const last = this.frames[this.frames.length - 1];
    if (last && t < last.t) {
      // The render clock stepped back: drop what is now "in the future".
      while (this.frames.length && this.frames[this.frames.length - 1]!.t >= t) this.bytes -= this.frames.pop()!.d.byteLength;
    }
    const d = new Float32Array(players.length * STRIDE);
    let o = 0;
    for (const p of players) {
      let ri = this.index.get(p.id);
      if (ri === undefined) {
        ri = this.ids.length;
        this.ids.push(p.id);
        this.index.set(p.id, ri);
      }
      this.latest.set(p.id, p);
      d[o] = ri;
      d[o + 1] = p.x;
      d[o + 2] = p.y;
      d[o + 3] = p.z;
      d[o + 4] = p.vx;
      d[o + 5] = p.vy;
      d[o + 6] = p.vz;
      d[o + 7] = p.yaw;
      d[o + 8] = p.pitch;
      d[o + 9] = p.hp;
      d[o + 10] = p.ads;
      d[o + 11] = p.slide;
      d[o + 12] = p.reload;
      d[o + 13] = p.swap ?? 0;
      d[o + 14] = p.cook ?? 0;
      d[o + 15] = (p.alive ? 1 : 0) | (p.sprint ? 2 : 0) | (p.crouch ? 4 : 0) | (p.firing ? 8 : 0) | (p.nadeUp ? 16 : 0);
      d[o + 16] = this.wIdx(p.weapon) * 4096 + Math.max(0, Math.min(4095, p.ammo ?? 0));
      o += STRIDE;
    }
    this.frames.push({ t, d });
    this.bytes += d.byteLength + 64;
    while (this.bytes > BUDGET_BYTES && this.frames.length > 2) this.bytes -= this.frames.shift()!.d.byteLength + 64;
  }

  shot(s: TapeShot): void {
    this.shots.push(s);
    if (this.shots.length > MAX_SHOTS) this.shots.splice(0, this.shots.length - MAX_SHOTS);
  }

  hit(h: TapeHit): void {
    this.hits.push(h);
    if (this.hits.length > MAX_HITS) this.hits.splice(0, this.hits.length - MAX_HITS);
  }

  /** Does the tape cover [t0, t1] (ms) with frames showing `id`? */
  covers(t0: number, t1: number, id: string): boolean {
    const [a, b] = this.span;
    if (!this.frames.length || b < t0 || a > t1) return false;
    const ri = this.index.get(id);
    if (ri === undefined) return false;
    for (const f of this.frames) {
      if (f.t < t0 || f.t > t1) continue;
      for (let o = 0; o < f.d.length; o += STRIDE) if (f.d[o] === ri) return true;
    }
    return false;
  }

  private decode(f: Packed): TapeFrame {
    const players: PlayerSnap[] = [];
    for (let o = 0; o < f.d.length; o += STRIDE) {
      const d = f.d;
      const id = this.ids[d[o]!]!;
      const base = this.latest.get(id)!;
      const flags = d[o + 15]!;
      const wa = d[o + 16]!;
      players.push({
        ...base,
        x: d[o + 1]!,
        y: d[o + 2]!,
        z: d[o + 3]!,
        vx: d[o + 4]!,
        vy: d[o + 5]!,
        vz: d[o + 6]!,
        yaw: d[o + 7]!,
        pitch: d[o + 8]!,
        hp: d[o + 9]!,
        ads: d[o + 10]!,
        slide: d[o + 11]!,
        reload: d[o + 12]!,
        swap: d[o + 13]!,
        cook: d[o + 14]!,
        alive: (flags & 1) !== 0,
        sprint: (flags & 2) !== 0,
        crouch: (flags & 4) !== 0,
        firing: (flags & 8) !== 0,
        nadeUp: (flags & 16) !== 0,
        weapon: this.weapons[Math.floor(wa / 4096)] ?? base.weapon,
        ammo: wa % 4096,
      });
    }
    return { t: f.t, players };
  }

  /** Decode the window [t0, t1] (ms), with one frame of margin either side. */
  clip(t0: number, t1: number): { frames: TapeFrame[]; shots: TapeShot[]; hits: TapeHit[] } {
    const frames: TapeFrame[] = [];
    const fr = this.frames;
    let lo = 0;
    let hi = fr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (fr[m]!.t < t0) lo = m + 1;
      else hi = m;
    }
    for (let i = Math.max(0, lo - 1); i < fr.length; i++) {
      frames.push(this.decode(fr[i]!));
      if (fr[i]!.t > t1) break;
    }
    return {
      frames,
      shots: this.shots.filter((s) => s.t >= t0 - 50 && s.t <= t1 + 50),
      hits: this.hits.filter((h) => h.t >= t0 - 50 && h.t <= t1 + 50),
    };
  }
}
