/**
 * client/src/ui/medals.ts — MEDALS and the kill confirmation (feel stream).
 * ===========================================================================
 *
 * Kong Royale's medal row (client/src/ui/medals.ts there), in this game's CoD
 * register: no toon outlines, no rays, no springs. A kill's medals pop in a row
 * in the top-centre band (DESIGN-SYSTEM §5: medal callouts, 25 % height) — a
 * flat hexagon emblem (1 px rule, white; the ONE accent, saffron, for multi-
 * kills and killstreaks), the title in the display face, one short line — up to
 * three, staggered 140 ms, each settling 1.35× → 1× in 180 ms on an ease-out,
 * held, then faded over 300 ms (DESIGN-SYSTEM §6). The next kill's row replaces
 * the last one; nothing queues up behind it.
 *
 * Every kill of yours also gets the CoD confirmation under the crosshair:
 * ELIMINATED + the name, in the enemy colour.
 *
 * Driven off the GAME clock (`tick(nowMs)` from game.ts), so it replays under
 * ?test like the countdown and the banner do. Every write is change-gated.
 */
import type { Medal, MedalId } from "../accolades";
import { iconPath } from "./weapon-icons";

const MAX = 3;
const STAGGER = 0.14;
const SETTLE = 0.18;
const HOLD = 2.3;
const FADE = 0.3;
const CONFIRM_S = 1.35;

const HEX = "M32 2.5 58.5 17.8v28.4L32 61.5 5.5 46.2V17.8Z";
const HEX_IN = "M32 8.6 53.2 20.8v22.4L32 55.4 10.8 43.2V20.8Z";

/** Emblem glyphs, drawn in a 64-unit box centred on (32, 32). `fill`/`stroke` = currentColor. */
function glyph(id: MedalId): string {
  const icon = (k: "FRAG" | "HEAD", s: number): string => {
    const p = iconPath(k);
    return `<path fill="currentColor" fill-rule="${p.rule ?? "nonzero"}" transform="translate(${32 - (p.w * s) / 2} ${32 - 11 * s}) scale(${s})" d="${p.d}"/>`;
  };
  const num = (t: string, size = 27): string =>
    `<text x="32" y="${32 + size * 0.36}" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="${size}" fill="currentColor">${t}</text>`;
  const chev = (n: number): string =>
    Array.from({ length: n }, (_, i) => `<path fill="currentColor" d="M20 ${17 + i * 6} 32 ${11 + i * 6} 44 ${17 + i * 6}v3.2L32 ${14.2 + i * 6} 20 ${20.2 + i * 6}Z"/>`).join("");
  switch (id) {
    case "headshot":
      // a head-and-shoulders bust with the reticle on the forehead
      return `<path fill="currentColor" d="M32 14.5a8.6 8.6 0 1 1 0 17.2 8.6 8.6 0 0 1 0-17.2Z M17 49c.8-9 6.6-14.4 15-14.4S46.2 40 47 49Z"/><g fill="none" stroke="var(--md-ring, #0b0c0e)" stroke-width="1.8"><circle cx="32" cy="22.6" r="4.4"/></g><g fill="var(--md-ring, #0b0c0e)"><rect x="31.2" y="15.2" width="1.6" height="3.4"/><rect x="31.2" y="26.6" width="1.6" height="3.4"/><rect x="24.6" y="21.8" width="3.4" height="1.6"/><rect x="36" y="21.8" width="3.4" height="1.6"/></g>`;
    case "longshot":
      return `<g fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="32" cy="32" r="13"/></g><g fill="currentColor"><rect x="30.9" y="15" width="2.2" height="11"/><rect x="30.9" y="38" width="2.2" height="11"/><rect x="15" y="30.9" width="11" height="2.2"/><rect x="38" y="30.9" width="11" height="2.2"/><circle cx="32" cy="32" r="1.8"/><rect x="31" y="40.4" width="2" height="1.2"/><rect x="31" y="43.4" width="2" height="1.2"/></g>`;
    case "collateral":
      // two heads in a row, one round through both
      return `<g fill="currentColor"><circle cx="25" cy="27" r="6.4"/><circle cx="41" cy="27" r="6.4"/><path d="M14.5 45c.6-6.8 4.6-10.6 10.5-10.6S35 38.2 35.5 45Z M30.5 45c.6-6.8 4.6-10.6 10.5-10.6S51 38.2 51.5 45Z"/></g><path stroke="var(--md-ring, #0b0c0e)" stroke-width="5" d="M9 27h46"/><path stroke="currentColor" stroke-width="2.2" d="M9 27h44"/><path fill="currentColor" d="M52 23.4 58 27l-6 3.6Z"/>`;
    case "frag":
      return icon("FRAG", 1.45);
    case "cooked":
      return `${icon("FRAG", 1.2)}<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" d="M32 13.5a18.5 18.5 0 1 1-13.1 5.4"/><path fill="currentColor" d="M16.5 14.4 22.6 15l-1 6Z"/>`;
    case "payback":
      return `<path fill="none" stroke="currentColor" stroke-width="3" d="M45 25.5A14 14 0 1 0 46 36"/><path fill="currentColor" d="M39.4 21.2 49.5 19.6 47.6 30Z"/><circle cx="32" cy="32" r="3.4" fill="currentColor"/>`;
    case "revenge":
      return `<path fill="none" stroke="currentColor" stroke-width="2.4" d="M32 13.5 46 18.6v10.2c0 9.3-5.9 15.2-14 19.2-8.1-4-14-9.9-14-19.2V18.6Z"/><path fill="currentColor" d="M24.5 33.5 32 26l7.5 7.5v3.4L32 29.4l-7.5 7.5Z"/>`;
    case "firstblood":
      return `<path fill="currentColor" d="M32 12.5c5.6 8.4 11.2 14.6 11.2 21.4a11.2 11.2 0 0 1-22.4 0c0-6.8 5.6-13 11.2-21.4Z"/>`;
    case "laststand":
      return `<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="miter" d="M13 33.5h8.5l3.2-7.5 5.2 16 5.4-21 3.6 12.5H51"/>`;
    case "buzzkill":
      return `<g fill="currentColor"><rect x="18" y="35" width="6.5" height="10"/><rect x="28.75" y="28" width="6.5" height="17"/><rect x="39.5" y="21" width="6.5" height="24"/></g><path stroke="currentColor" stroke-width="3" d="M15 47 49 17"/>`;
    case "double":
      return num("2×");
    case "triple":
      return num("3×");
    case "quad":
      return num("4×");
    case "rampage":
      return `<g fill="currentColor">${Array.from({ length: 8 }, (_, i) => `<rect x="31" y="11" width="2" height="7" transform="rotate(${i * 45} 32 32)"/>`).join("")}</g>${num("5+", 20)}`;
    case "streak3":
      return chev(1) + num("3", 21).replace(`y="${32 + 21 * 0.36}"`, 'y="46"');
    case "streak5":
      return chev(2) + num("5", 21).replace(`y="${32 + 21 * 0.36}"`, 'y="49"');
    case "streak7":
      return chev(3) + num("7", 19).replace(`y="${32 + 19 * 0.36}"`, 'y="51"');
    case "streak10":
      return chev(3) + num("10", 17).replace(`y="${32 + 17 * 0.36}"`, 'y="51"');
  }
}

function emblem(m: Medal): string {
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><path class="md-hex" d="${HEX}"/><path class="md-hex-in" d="${HEX_IN}"/>${glyph(m.id)}</svg>`;
}

type Shown = { el: HTMLElement; at: number; settled: boolean };

export class Medals {
  private row: HTMLElement | null = null;
  private confirm: HTMLElement | null = null;
  private shown: Shown[] = [];
  private lastPop = -1e9;
  private confirmAt = -1e9;
  private st = { rowOp: "", confirmOp: "" };

  private mount(): boolean {
    if (this.row?.isConnected && this.confirm?.isConnected) return true;
    const hud = document.getElementById("hud");
    if (!hud) return false;
    this.row = document.getElementById("medals") ?? document.createElement("div");
    this.row.id = "medals";
    this.confirm = document.getElementById("kill-confirm") ?? document.createElement("div");
    this.confirm.id = "kill-confirm";
    if (!this.row.isConnected) hud.append(this.row);
    if (!this.confirm.isConnected) hud.append(this.confirm);
    return true;
  }

  /** A kill of yours: its medals (highest first) and the victim for the confirmation. */
  kill(medals: Medal[], victim: string, nowMs: number): void {
    if (!this.mount()) return;
    const now = nowMs / 1000;
    // The confirmation under the crosshair, every kill.
    const c = this.confirm!;
    c.replaceChildren();
    const lbl = document.createElement("span");
    lbl.textContent = "ELIMINATED";
    const b = document.createElement("b");
    b.textContent = victim;
    c.append(lbl, b);
    this.confirmAt = now;
    if (!medals.length) return;
    // A new kill's medals replace whatever is up.
    for (const s of this.shown) s.el.remove();
    this.shown.length = 0;
    const batch = medals.slice(0, MAX);
    batch.forEach((m, i) => {
      const el = document.createElement("div");
      el.className = `medal tier${m.tier}`;
      el.dataset.medal = m.id;
      el.innerHTML = `<div class="md-em">${emblem(m)}</div><b></b><span></span>`;
      (el.querySelector("b") as HTMLElement).textContent = m.title;
      (el.querySelector("span") as HTMLElement).textContent = m.sub;
      el.style.opacity = "0";
      this.row!.append(el);
      this.shown.push({ el, at: now + i * STAGGER, settled: false });
    });
    this.lastPop = now + (batch.length - 1) * STAGGER;
  }

  /** Per frame: the settle / hold / fade envelope, off the game clock. */
  tick(nowMs: number): void {
    if (!this.row) return;
    const now = nowMs / 1000;
    if (this.shown.length) {
      const age = now - this.lastPop;
      const fade = age > HOLD ? Math.max(0, 1 - (age - HOLD) / FADE) : 1;
      for (const s of this.shown) {
        const t = now - s.at;
        if (t < 0) continue;
        const k = Math.min(1, t / SETTLE);
        const e = 1 - (1 - k) ** 3;
        if (!s.settled || fade < 1) {
          s.el.style.opacity = (e * fade).toFixed(3);
          s.el.style.transform = `scale(${(1.35 - 0.35 * e).toFixed(3)})`;
          if (k >= 1) s.settled = true;
        }
      }
      if (fade <= 0) {
        for (const s of this.shown) s.el.remove();
        this.shown.length = 0;
      }
    }
    if (this.confirm) {
      const age = now - this.confirmAt;
      const o = age < 0 || age > CONFIRM_S ? 0 : Math.min(1, age / 0.08) * (age > CONFIRM_S - 0.3 ? (CONFIRM_S - age) / 0.3 : 1);
      const v = o.toFixed(2);
      if (v !== this.st.confirmOp) {
        this.st.confirmOp = v;
        this.confirm.style.opacity = v;
      }
    }
  }

  /** Drop everything (new match, killcam). */
  clear(): void {
    for (const s of this.shown) s.el.remove();
    this.shown.length = 0;
    this.confirmAt = -1e9;
    if (this.confirm) this.confirm.style.opacity = "0";
    this.st.confirmOp = "0";
  }
}
