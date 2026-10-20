/**
 * WEAPON FEEL — the parts of shooting that live in the shooter's own camera.
 * Ported from Kong Royale (client/src/game/render.ts: localFire's recoil
 * PATTERN, the punch springs, trauma shake, scope sway + hold breath) and
 * retuned for a CoD arena: crisp, readable, never Fortnite-bouncy.
 *
 * TWO KINDS OF OUTPUT, and the difference matters:
 *   AIM     kick() and the scope sway move where the next bullet goes. They are
 *           summed into InputCmd.yaw/pitch by game.ts and the server fires down
 *           exactly that, so they are advanced on the fixed 64 Hz tick only
 *           (frame rate never changes a recoil pattern).
 *   VISUAL  punch (springs) and trauma shake rotate the camera and nothing
 *           else; they spring back fully and never touch the aim.
 */
import type { WeaponDef } from "@shared/weapons";

const DEG = Math.PI / 180;

/** Share of each kick that springs back by itself (game.ts decays it at w.recoilRec). */
export const RECOVER = 0.42;

/** KR SCOPE_SWAY, retuned: a sniper scope breathes; hold Shift to steady it. */
export const SCOPE_SWAY = {
  /** Degrees of world angle at rest, and the extra right after scoping in / each bolt. */
  steady: 0.55,
  enter: 1.4,
  tau: 0.7,
  /** Hold breath: sway x breathMul for up to breathS; refills in refillS; spent lungs shake x outMul. */
  breathMul: 0.18,
  breathS: 3.2,
  refillS: 4,
  outMul: 1.4,
};

export type Kick = { pitch: number; yaw: number; recP: number; recY: number };

export class WeaponFeel {
  /** Shot index inside the current burst (drives the pattern). */
  burstN = 0;
  private lastShotMs = -1e9;
  // camera punch: critically-damped-ish springs, radians
  punchP = 0;
  punchY = 0;
  punchR = 0;
  private punchPV = 0;
  private punchYV = 0;
  private punchRV = 0;
  /** 0..1, squared into the shake amplitude. */
  trauma = 0;
  private shakeT = 0;
  // scope sway (AIM offsets, radians) and the breath
  swayY = 0;
  swayP = 0;
  private swayT0 = -1;
  breath = 1;
  breathOut = false;
  breathHold = false;
  private breathK = 1;
  private readonly kickOut: Kick = { pitch: 0, yaw: 0, recP: 0, recY: 0 };

  /**
   * One round's recoil. Returns aim deltas (radians, game.ts sign convention:
   * +pitch looks DOWN, +yaw turns LEFT): `pitch`/`yaw` are the permanent climb
   * the player pulls against, `recP`/`recY` the share that springs back.
   */
  kick(w: WeaponDef, ads: number, crouch: boolean, nowMs: number): Kick {
    if (nowMs - this.lastShotMs > 60000 / w.rpm + 140) this.burstN = 0;
    const pat = w.pattern;
    const loop = Math.min(4, pat.length);
    const idx = this.burstN < pat.length ? this.burstN : pat.length - loop + (this.burstN % loop);
    const k = pat[idx] ?? pat[0]!;
    this.burstN++;
    this.lastShotMs = nowMs;
    const scale = (1 + (w.adsKick - 1) * Math.min(1, Math.max(0, ads))) * (crouch ? 0.85 : 1);
    const v = w.kick * DEG * k[0] * scale;
    // pattern + a little zero-mean grain so no two sprays are pixel-identical
    const h = w.kickYaw * DEG * (k[1] + (Math.random() - 0.5) * 0.35) * scale;
    const out = this.kickOut;
    out.pitch = -v * (1 - RECOVER);
    out.recP = -v * RECOVER;
    // pattern +h is RIGHT; turning right is yaw DECREASING in game.ts
    out.yaw = -h * (1 - RECOVER);
    out.recY = -h * RECOVER;
    // Visual punch: a clean kick on automatics, a firm one on the bolt gun,
    // gentler again through the sights (KR's stream-tuned "less visual recoil").
    const heavy = w.fire === "bolt";
    const ak = 1 - 0.4 * Math.min(1, ads);
    this.punchPV -= w.punch * DEG * (heavy ? 16 : 11) * ak * (0.92 + Math.random() * 0.16);
    this.punchYV += (Math.random() - 0.5) * w.punch * DEG * (heavy ? 7 : 4) * ak;
    this.punchRV += (Math.random() - 0.5) * w.punch * DEG * (heavy ? 6 : 2.5) * ak;
    if (heavy) this.addTrauma(0.12);
    // the scope re-settles after every bolt
    if (w.scope && this.swayT0 >= 0) this.swayT0 = nowMs / 1000 + 60 / w.rpm;
    return out;
  }

  addTrauma(t: number): void {
    this.trauma = Math.min(1, this.trauma + t);
  }

  /** Render-rate: springs + trauma decay. */
  update(dt: number): void {
    const K = 260;
    const D = 2 * Math.sqrt(K) * 0.9;
    // Fixed sub-steps so the punch has the same shape at 30 fps and 240 fps.
    const n = Math.min(12, Math.max(1, Math.ceil(Math.min(dt, 0.05) / (1 / 240))));
    const sdt = Math.min(dt, 0.05) / n;
    for (let i = 0; i < n; i++) {
      this.punchPV += (-K * this.punchP - D * this.punchPV) * sdt;
      this.punchP += this.punchPV * sdt;
      this.punchYV += (-K * this.punchY - D * this.punchYV) * sdt;
      this.punchY += this.punchYV * sdt;
      this.punchRV += (-K * this.punchR - D * this.punchRV) * sdt;
      this.punchR += this.punchRV * sdt;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    this.shakeT += dt;
  }

  /** Camera rotation offsets (pitch, yaw, roll) from punch + trauma shake. */
  offsets(out: [number, number, number]): [number, number, number] {
    const s = this.trauma * this.trauma;
    const t = this.shakeT;
    out[0] = this.punchP + s * 0.03 * (Math.sin(t * 37.1) + 0.5 * Math.sin(t * 71.3));
    out[1] = this.punchY + s * 0.03 * (Math.sin(t * 41.7 + 1.3) + 0.5 * Math.sin(t * 63.9));
    out[2] = this.punchR + s * 0.04 * Math.sin(t * 29.3 + 2.1);
    return out;
  }

  /**
   * Fixed-tick: the scope's aim sway and the breath. `scoped` is a settled
   * sniper scope; `holdKey` the sprint key (hold breath). Updates swayY/swayP,
   * which game.ts adds to the aim it sends.
   */
  tickScope(dt: number, scoped: boolean, holdKey: boolean, tSec: number): void {
    const S = SCOPE_SWAY;
    this.breathHold = scoped && holdKey && !this.breathOut && this.breath > 0;
    if (this.breathHold) {
      this.breath -= dt / S.breathS;
      if (this.breath <= 0) {
        this.breath = 0;
        this.breathOut = true;
        this.breathHold = false;
      }
    } else {
      this.breath = Math.min(1, this.breath + dt / S.refillS);
      if (this.breathOut && this.breath >= 0.5) this.breathOut = false;
    }
    const want = this.breathHold ? S.breathMul : this.breathOut ? S.outMul : 1;
    this.breathK += (want - this.breathK) * Math.min(1, dt * 6);
    if (!scoped) {
      this.swayT0 = -1;
      // ease the offset out rather than snapping the aim
      this.swayY *= Math.exp(-dt * 14);
      this.swayP *= Math.exp(-dt * 14);
      return;
    }
    if (this.swayT0 < 0) this.swayT0 = tSec;
    const a = S.steady + S.enter * Math.exp(-Math.max(0, tSec - this.swayT0) / S.tau);
    // two incommensurate sines per axis: reads as breathing, never a pattern
    const y = a * (0.75 * Math.sin(tSec * 2.17) + 0.25 * Math.sin(tSec * 4.9 + 1.3));
    const p = a * 0.7 * (0.8 * Math.sin(tSec * 2.71 + 0.6) + 0.2 * Math.sin(tSec * 5.3 + 2.1));
    this.swayY = y * this.breathK * DEG;
    this.swayP = p * this.breathK * DEG;
  }

  reset(): void {
    this.burstN = 0;
    this.punchP = this.punchY = this.punchR = 0;
    this.punchPV = this.punchYV = this.punchRV = 0;
    this.trauma = 0;
    this.swayY = this.swayP = 0;
    this.swayT0 = -1;
    this.breath = 1;
    this.breathOut = false;
    this.breathHold = false;
    this.breathK = 1;
  }
}
