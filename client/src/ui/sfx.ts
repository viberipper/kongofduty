/**
 * client/src/ui/sfx.ts — UI sound cues. Quiet, short, clean.
 *
 * Synthesised (no download, no decode wait) on a tiny AudioContext of its own,
 * so menus have sound before the game's audio rig has booted, and the in-game
 * rig's buses and limiter are never touched by a hover. Level = SETTINGS →
 * MASTER × UI. Every cue is under 120 ms and at least -24 dBFS: CoD menus
 * "tick", they do not chime.
 *
 *   hover    a 6 ms filtered click — felt more than heard, rate-limited
 *   select   a short high blip (tab, toggle, card)
 *   confirm  two rising partials (launch, start, save)
 *   back     one falling partial
 *   error    a low double pulse
 *   tick     a dry countdown tick (endcard / return timer)
 */
import { prefs } from "./prefs";

type Cue = "hover" | "select" | "confirm" | "back" | "error" | "tick";

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let noise: AudioBuffer | null = null;
let lastHover = 0;

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AC = (globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!AC) return null;
    ctx = new AC({ latencyHint: "interactive" });
    out = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 9000;
    out.connect(lp);
    lp.connect(ctx.destination);
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  } catch {
    ctx = null;
  }
  return ctx;
}

function level(): number {
  const p = prefs();
  return p.master * p.ui;
}

function tone(c: AudioContext, f0: number, f1: number, at: number, dur: number, vol: number, type: OscillatorType = "sine"): void {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g);
  g.connect(out!);
  o.start(at);
  o.stop(at + dur + 0.02);
}

function click(c: AudioContext, at: number, vol: number, freq: number): void {
  if (!noise) return;
  const s = c.createBufferSource();
  s.buffer = noise;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = 1.4;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.012);
  s.connect(bp);
  bp.connect(g);
  g.connect(out!);
  s.start(at);
  s.stop(at + 0.03);
}

export function uiSfx(cue: Cue): void {
  const lv = level();
  if (lv <= 0.001) return;
  const c = ensure();
  if (!c || !out) return;
  if (c.state === "suspended") void c.resume().catch(() => {});
  const now = performance.now();
  if (cue === "hover") {
    if (now - lastHover < 45) return;
    lastHover = now;
  }
  out.gain.value = lv;
  const t = c.currentTime + 0.002;
  switch (cue) {
    case "hover":
      click(c, t, 0.05, 3200);
      break;
    case "select":
      click(c, t, 0.06, 2600);
      tone(c, 1650, 1500, t, 0.05, 0.035, "triangle");
      break;
    case "confirm":
      click(c, t, 0.07, 2400);
      tone(c, 880, 880, t, 0.07, 0.04, "triangle");
      tone(c, 1320, 1320, t + 0.055, 0.1, 0.035, "triangle");
      break;
    case "back":
      tone(c, 1100, 700, t, 0.08, 0.035, "triangle");
      break;
    case "error":
      tone(c, 220, 200, t, 0.07, 0.06, "square");
      tone(c, 220, 200, t + 0.1, 0.07, 0.05, "square");
      break;
    case "tick":
      click(c, t, 0.05, 1800);
      break;
  }
}

/**
 * Wire hover/select cues to every interactive element under `root`, once.
 * Elements opt out with data-sfx="off"; data-sfx="confirm"/"back" picks the
 * click cue (default: select).
 */
export function wireSfx(root: HTMLElement): void {
  if (root.dataset.sfxWired === "1") return;
  root.dataset.sfxWired = "1";
  const pick = (e: Event): HTMLElement | null => {
    const t = (e.target as HTMLElement | null)?.closest?.("button, .tile, .map-card, [data-sfx]") as HTMLElement | null;
    if (!t || t.dataset.sfx === "off" || (t as HTMLButtonElement).disabled) return null;
    return t;
  };
  root.addEventListener("pointerover", (e) => {
    const t = pick(e);
    if (t && !t.contains((e as PointerEvent).relatedTarget as Node | null)) uiSfx("hover");
  });
  root.addEventListener("click", (e) => {
    const t = pick(e);
    if (!t) return;
    const kind = t.dataset.sfx;
    uiSfx(kind === "confirm" ? "confirm" : kind === "back" ? "back" : "select");
  });
}
