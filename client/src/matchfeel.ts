/**
 * MATCH FEEL — the 3-2-1 card, the resupply flash and the recovered flash.
 * ===========================================================================
 * One class, one CSS file, zero lines in index.html: every element is created
 * here on mount() and parented into #hud, so it inherits the HUD's z-order, its
 * hide-on-menu behaviour and the `.killcam-on` contract for free.
 *
 * WHY EVERY ANIMATION IS JS-DRIVEN OFF THE GAME CLOCK
 * ---------------------------------------------------
 * The countdown is drawn from a TIMESTAMP DIFFERENCE — how long until the match
 * goes live — and never from a per-frame decrement, for two independent reasons:
 *
 *   1. EVERY CLIENT COUNTS TOGETHER. The number is derived from the server's
 *      startAt on the server's own clock, so ten players on ten different frame
 *      rates and pings see "1" appear at the same instant, and the instant the
 *      gun goes hot is the instant the numerals ran out. A local decrement would
 *      drift per client and be wrong by exactly the accumulated frame error.
 *
 *   2. CSS/WALL-CLOCK ANIMATION IS UNTESTABLE IN THIS REPO. The capture harness
 *      steps the sim and can draw one frame per 40 ticks; the hitmarker, the
 *      medal banner and the damage numbers were all converted away from CSS
 *      keyframes and per-draw-dt decay for that reason (qa/STATE.md). Given the
 *      clock, every beat of this card can be posed and photographed exactly.
 *
 * PERFORMANCE. Per frame this writes `transform` and `opacity` on at most four
 * small elements — composited properties, no layout, no paint, nothing
 * full-screen, no allocation beyond the style strings the browser requires
 * (the same thing tickHitmarker/tickBanner already do). Text and class writes
 * happen ONLY on a beat change, not per frame. Idle, the card is display:none
 * and out of the compositor entirely.
 */
import "./matchfeel.css";
import { BEAT_MS, GO_MS, beatAt, type MatchPhase } from "@shared/matchphase";

/** The cues matchfeel asks for. AudioRig2 satisfies this; QA can stub it. */
export type MatchFeelAudio = {
  countBeat(beat: number): void;
  countGo(): void;
  resupply(): void;
  recovered(): void;
};

/** A JS-driven, timestamp-based one-shot. `born <= 0` means idle. */
type Shot = { el: HTMLElement | null; born: number; dur: number };

/** A flash is a NOTIFICATION, not an event: long enough to read at a glance,
 *  short enough that it is gone before you need the screen back. */
const FLASH_MS = 1100;
/** How long the numeric readout beside a flash stays lit. */
const PULSE_MS = 620;

const easeOut3 = (u: number): number => 1 - (1 - u) ** 3;
const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);

export class MatchFeel {
  private card: HTMLElement | null = null;
  private num: HTMLElement | null = null;
  private ring: HTMLElement | null = null;
  private eyebrow: HTMLElement | null = null;

  private ammoFlash: Shot = { el: null, born: 0, dur: FLASH_MS };
  private hpFlash: Shot = { el: null, born: 0, dur: FLASH_MS };
  /** The HUD readouts themselves, lit for a beat so the eye lands on them. */
  private resPulse: Shot = { el: null, born: 0, dur: PULSE_MS };
  private hpNumPulse: Shot = { el: null, born: 0, dur: PULSE_MS };
  private hpBarPulse: Shot = { el: null, born: 0, dur: PULSE_MS };

  /** The beat currently on screen: 3/2/1, 0 for GO, -1 for none. Read by QA. */
  beat = -1;
  /** Beats whose audio has already fired this countdown (never twice). */
  private rung = new Set<number>();
  private lastPhase: MatchPhase = "live";
  private mounted = false;

  /** Create the DOM once, inside the HUD. Safe to call repeatedly. */
  mount(hud: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    const mk = (id: string, cls?: string): HTMLElement => {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        if (cls) el.className = cls;
        hud.appendChild(el);
      }
      return el;
    };
    // One card: an eyebrow row over a stacked (ring + numeral) row, so the two
    // animated elements share a grid cell and therefore a centre.
    this.card = mk("mf-count");
    this.card.classList.add("mf-off");
    this.eyebrow = document.createElement("div");
    this.eyebrow.id = "mf-eyebrow";
    const stack = document.createElement("div");
    stack.id = "mf-stack";
    this.ring = document.createElement("div");
    this.ring.id = "mf-ring";
    this.num = document.createElement("div");
    this.num.id = "mf-num";
    stack.append(this.ring, this.num);
    this.card.append(this.eyebrow, stack);
    this.ammoFlash.el = mk("mf-ammo", "mf-flash");
    this.hpFlash.el = mk("mf-hp", "mf-flash");
    this.resPulse.el = document.getElementById("res");
    this.hpNumPulse.el = document.getElementById("hpnum");
    this.hpBarPulse.el = document.getElementById("hp");
  }

  /** New match: forget which beats have rung and clear anything on screen. */
  reset(): void {
    this.rung.clear();
    this.beat = -1;
    this.lastPhase = "live";
    this.hide();
    for (const s of [this.ammoFlash, this.hpFlash]) {
      s.born = 0;
      if (s.el) s.el.style.opacity = "0";
    }
    for (const s of [this.resPulse, this.hpNumPulse, this.hpBarPulse]) this.endPulse(s);
  }

  /**
   * ONE call per rendered frame, from Game.draw().
   *
   * @param nowMs  the game clock (Game.nowMs() — the stepped clock under ?test)
   * @param phase  the authoritative phase (server's, or the local session's)
   * @param leftMs ms until the match goes live, NEGATIVE once it is (the GO card
   *               plays out after the gun is already hot), and EXACTLY ZERO for
   *               "there is no countdown" — never armed, or already forgotten.
   */
  update(nowMs: number, phase: MatchPhase, leftMs: number, audio: MatchFeelAudio | null): void {
    if (!this.card || !this.num || !this.ring || !this.eyebrow) return;
    if (phase !== this.lastPhase) {
      // A fresh countdown re-arms the bells; going live never does (the GO beat
      // fires as the numerals run out, while the phase is already "live").
      if (phase === "countdown") this.rung.clear();
      this.lastPhase = phase;
    }

    if (phase === "pregame") {
      // Nothing is counting yet — the lobby is waiting on its host. One quiet
      // line so a locked input is never a mystery; no numeral, no ring.
      this.beat = -1;
      this.card.classList.remove("mf-off");
      this.num.style.opacity = "0";
      this.ring.style.opacity = "0";
      this.eyebrow.textContent = "WAITING FOR HOST";
      this.eyebrow.style.opacity = "0.72";
      this.tickShots(nowMs);
      return;
    }

    const beat = leftMs === 0 ? -1 : beatAt(leftMs);
    if (beat < 0) {
      if (this.beat >= 0) this.hide();
      this.beat = -1;
      this.tickShots(nowMs);
      return;
    }

    // ── beat change: the only frame that writes text or a class ──────────────
    if (beat !== this.beat) {
      this.beat = beat;
      this.card.classList.remove("mf-off");
      this.num.classList.toggle("mf-go", beat === 0);
      this.num.textContent = beat === 0 ? "GO" : String(beat);
      // EVERY BEAT RINGS AT MOST ONCE, GO included. The card can legitimately be
      // re-entered — a second StartMsg, a re-arm from a late-joiner snapshot —
      // and a doubled "GO" over the top of live play is the one mistake this
      // cue cannot make.
      if (!this.rung.has(beat)) {
        this.rung.add(beat);
        if (beat === 0) audio?.countGo();
        else audio?.countBeat(beat);
      }
    }

    const dur = beat > 0 ? BEAT_MS : GO_MS;
    // Elapsed inside this beat, from the timestamp difference alone.
    const el = beat > 0 ? beat * BEAT_MS - leftMs : -leftMs;
    const u = clamp01(el / dur);

    // NUMERAL (UI stream, tactical): settle in from a hair over size in the
    // first 12% of the beat — no overshoot, no rotation — hold, fade out.
    let scale: number;
    let alpha: number;
    const inU = beat === 0 ? 0.12 : 0.12;
    const outU = beat === 0 ? 0.6 : 0.72;
    if (u < inU) {
      const p = easeOut3(u / inU);
      scale = 1.12 - 0.12 * p;
      alpha = p;
    } else if (u < outU) {
      scale = 1;
      alpha = 1;
    } else {
      const q = (u - outU) / (1 - outU);
      scale = 1 + 0.04 * q;
      alpha = clamp01(1 - q);
    }
    this.num.style.transform = `scale(${scale.toFixed(3)})`;
    this.num.style.opacity = alpha.toFixed(3);

    // RING: one shockwave per beat. TIGHT and SHORT — the first build ran it out
    // to 2.5x over half the beat, which stopped reading as an impact and started
    // reading as a lens artefact: a 570px circle at 8% opacity drifting across the
    // whole upper frame. It now hugs the glyph (max 1.5x = ~315px), is brighter at
    // the strike, and is gone a quarter of the way into the beat.
    // The GO ring is the exception: it is FASTER and reaches the width of the
    // word (2.45 x 210 = 515px against a ~496px "GO"), so the release reads as
    // a shockwave leaving the text instead of a halo sitting behind it.
    const rq = u / (beat === 0 ? 0.18 : 0.28);
    if (rq < 1) {
      const span = beat === 0 ? 1.85 : 1;
      this.ring.style.transform = `scale(${((beat === 0 ? 0.6 : 0.5) + span * easeOut3(rq)).toFixed(3)})`;
      this.ring.style.opacity = (0.95 * (1 - rq) ** (beat === 0 ? 1.6 : 1.2)).toFixed(3);
    } else if (this.ring.style.opacity !== "0") {
      this.ring.style.opacity = "0";
    }

    // EYEBROW: fades in on the first beat and is GONE on the GO beat, not faded
    // through it — "GO" is scaled up out of its own grid row and printed over
    // the top of a lingering "MATCH BEGINS", which looked like a mistake.
    if (beat > 0) {
      if (this.eyebrow.textContent !== "STARTING IN") this.eyebrow.textContent = "STARTING IN";
      this.eyebrow.style.opacity = (0.95 * clamp01((3 * BEAT_MS - leftMs) / 280)).toFixed(3);
    } else if (this.eyebrow.style.opacity !== "0") {
      this.eyebrow.style.opacity = "0";
    }

    this.tickShots(nowMs);
  }

  private hide(): void {
    this.card?.classList.add("mf-off");
    if (this.eyebrow) this.eyebrow.style.opacity = "0";
  }

  // ── the two flashes ───────────────────────────────────────────────────────

  /**
   * Rounds landed in the reserve. `n` is the actual delta, so the line never
   * claims a magazine the sim did not hand over (a capped resupply, or a
   * 5-round scavenge clip, says what it really was).
   */
  ammo(n: number, nowMs: number, audio: MatchFeelAudio | null): void {
    if (!this.ammoFlash.el) return;
    this.ammoFlash.el.textContent = `+${n} ROUNDS`;
    this.ammoFlash.born = nowMs;
    this.resPulse.born = nowMs;
    audio?.resupply();
  }

  /** Health back to full. One warm line and a lit HP readout, nothing more. */
  health(nowMs: number, audio: MatchFeelAudio | null): void {
    if (!this.hpFlash.el) return;
    this.hpFlash.el.textContent = "RECOVERED";
    this.hpFlash.born = nowMs;
    this.hpNumPulse.born = nowMs;
    this.hpBarPulse.born = nowMs;
    audio?.recovered();
  }

  private tickShots(nowMs: number): void {
    this.tickFlash(this.ammoFlash, nowMs);
    this.tickFlash(this.hpFlash, nowMs);
    this.tickPulse(this.resPulse, nowMs, "color");
    this.tickPulse(this.hpNumPulse, nowMs, "color");
    this.tickPulse(this.hpBarPulse, nowMs, "background");
  }

  /** Rise-and-fade on the game clock. */
  private tickFlash(s: Shot, nowMs: number): void {
    if (!s.el || s.born <= 0) return;
    const u = (nowMs - s.born) / s.dur;
    if (u >= 1 || u < 0) {
      s.born = 0;
      s.el.style.opacity = "0";
      return;
    }
    let alpha: number;
    let dy: number;
    let sc = 1;
    if (u < 0.12) {
      const p = easeOut3(u / 0.12);
      alpha = p;
      dy = 11 * (1 - p);
      sc = 1.22 - 0.22 * p;
    } else if (u < 0.62) {
      alpha = 1;
      dy = -3 * ((u - 0.12) / 0.5);
    } else {
      const q = (u - 0.62) / 0.38;
      // Steeper than linear so the line clears the corner it is parked in
      // rather than ghosting there for the back half of its life.
      alpha = (1 - q) ** 1.6;
      dy = -3 - 10 * q;
    }
    s.el.style.opacity = alpha.toFixed(3);
    s.el.style.transform = `translateY(${dy.toFixed(2)}px) scale(${sc.toFixed(3)})`;
  }

  /**
   * Light one of the HUD's OWN readouts (the reserve count, the HP number, the
   * HP fill) so the eye lands on the number that changed, then hand it straight
   * back. The lit property is REMOVED rather than set to a literal at the end,
   * because main.ts's paintHud owns these elements — it writes their text every
   * frame and toggles #hp.low — and an inline value left behind would silently
   * outrank that class for the rest of the match.
   */
  private tickPulse(s: Shot, nowMs: number, prop: "color" | "background"): void {
    if (!s.el || s.born <= 0) return;
    const u = (nowMs - s.born) / s.dur;
    if (u >= 1 || u < 0) {
      this.endPulse(s);
      return;
    }
    // COLOUR ONLY, no scale. #res and #hpnum are an inline <span> and <b> in
    // index.html, and a transform on an inline box is ignored outright — the
    // "pop" this used to write was doing nothing at all (visible in
    // qa/out/matchfeel/zoom-resupply.png: the number went amber and never moved).
    // The honest fix is to drop it rather than to change the HUD's box model from
    // a file that does not own that markup; the flash line beside the readout
    // carries the movement, and it is an absolutely-positioned block.
    s.el.style.setProperty(prop, "var(--amber, #ffd24a)");
  }

  private endPulse(s: Shot): void {
    s.born = 0;
    if (!s.el) return;
    s.el.style.removeProperty("color");
    s.el.style.removeProperty("background");
    s.el.style.removeProperty("transform");
  }
}
