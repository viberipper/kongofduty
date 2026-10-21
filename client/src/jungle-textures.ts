import * as THREE from "three";
import { ANISO } from "./textures";

/** Canvas-authored textures for the Jungle Shipment art pass.
 *  Albedo only — value variation, never baked directional light. */

/**
 * Rasterisation multiplier for the surfaces whose CONTENT is hard-edged.
 *
 * Not a redraw and not a new look: the canvas is allocated `DETAIL`x larger and
 * the 2D context is pre-scaled by the same factor, so every coordinate, radius,
 * line width and RNG draw below still means exactly what it meant at 1x — the
 * identical picture, rasterised with twice the precision. It is applied ONLY to
 * textures whose detail is edges (slat lines, plank seams, alpha cutouts, worn
 * path borders, stencil corners), because those are what a bigger canvas
 * actually buys. The soft, low-contrast surfaces (dirt, jungle floor, painted
 * container steel) get nothing from it — their content has no frequency up
 * there — so they stay at their authored size and the VRAM with them.
 */
const DETAIL = 2;

function canvas(w: number, h: number, detail = 1): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w * detail;
  c.height = h * detail;
  // These surfaces are read back for texture uploads. CPU canvases avoid a
  // long GPU readback of queued paint commands on software renderers.
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  if (detail !== 1) ctx.scale(detail, detail);
  return [c, ctx];
}

function tex(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = ANISO;
  return t;
}

/** Deterministic PRNG so weathering variants are stable run to run. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Packed tropical dirt with grass patches and fallen-leaf specks. */
export function jungleDirtTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  const R = rng(4111);
  ctx.fillStyle = "#6b5233";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 110; i++) {
    const x = R() * 512;
    const y = R() * 512;
    const r = 14 + R() * 44;
    const dark = R() > 0.5;
    ctx.fillStyle = dark ? "rgba(74,55,32,0.15)" : "rgba(133,106,66,0.13)";
    for (const ox of [-512, 0, 512]) {
      for (const oy of [-512, 0, 512]) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, r, r * (0.5 + R() * 0.5), R() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  for (let i = 0; i < 2600; i++) {
    const v = R();
    ctx.fillStyle = v > 0.5 ? `rgba(48,36,22,${0.05 + v * 0.06})` : `rgba(150,122,80,${0.04 + v * 0.05})`;
    ctx.fillRect(R() * 512, R() * 512, 1 + R() * 2.5, 1 + R() * 2);
  }
  for (let i = 0; i < 40; i++) {
    const x = R() * 512;
    const y = R() * 512;
    ctx.strokeStyle = `rgba(${70 + R() * 30},${100 + R() * 34},${40 + R() * 18},0.45)`;
    ctx.lineWidth = 1.4;
    for (let b = 0; b < 6; b++) {
      const a = -Math.PI / 2 + (R() - 0.5) * 1.1;
      ctx.beginPath();
      ctx.moveTo(x + (R() - 0.5) * 8, y + (R() - 0.5) * 5);
      ctx.lineTo(x + Math.cos(a) * (5 + R() * 7), y + Math.sin(a) * (5 + R() * 7));
      ctx.stroke();
    }
  }
  for (let i = 0; i < 110; i++) {
    const x = R() * 512;
    const y = R() * 512;
    const a = R() * Math.PI;
    const g = R() > 0.55;
    ctx.fillStyle = g ? "rgba(88,98,54,0.38)" : "rgba(120,92,44,0.45)";
    ctx.beginPath();
    ctx.ellipse(x, y, 2.6 + R() * 3.4, 1 + R() * 1.4, a, 0, Math.PI * 2);
    ctx.fill();
  }
  // fine pebbles + cracks: near-field detail so the ground holds up at 1-3m
  for (let i = 0; i < 900; i++) {
    const x = R() * 512;
    const y = R() * 512;
    const lit = R() > 0.5;
    ctx.fillStyle = lit ? `rgba(158,132,92,${0.12 + R() * 0.14})` : `rgba(52,40,26,${0.12 + R() * 0.14})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.7 + R() * 1.6, 0, Math.PI * 2);
    ctx.fill();
    if (lit) {
      ctx.fillStyle = `rgba(40,30,20,${0.1 + R() * 0.1})`;
      ctx.beginPath();
      ctx.arc(x + 1, y + 1.4, 0.6 + R() * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let i = 0; i < 26; i++) {
    ctx.strokeStyle = `rgba(46,36,24,${0.1 + R() * 0.12})`;
    ctx.lineWidth = 0.8 + R();
    ctx.beginPath();
    let x = R() * 512;
    let y = R() * 512;
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (R() - 0.5) * 40;
      y += (R() - 0.5) * 40;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return tex(c);
}

/** Darker jungle-floor litter for the ground beyond the yard walls. */
export function jungleFloorTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  const R = rng(9021);
  ctx.fillStyle = "#3f4428";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 140; i++) {
    const x = R() * 512;
    const y = R() * 512;
    const r = 12 + R() * 42;
    ctx.fillStyle = R() > 0.5 ? "rgba(40,48,26,0.25)" : "rgba(78,86,44,0.2)";
    for (const ox of [-512, 0, 512]) {
      for (const oy of [-512, 0, 512]) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, r, r * (0.5 + R() * 0.5), R() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  for (let i = 0; i < 240; i++) {
    const x = R() * 512;
    const y = R() * 512;
    const g = R() > 0.4;
    ctx.fillStyle = g ? "rgba(96,116,52,0.4)" : "rgba(88,70,38,0.4)";
    ctx.beginPath();
    ctx.ellipse(x, y, 2.4 + R() * 4, 1 + R() * 1.6, R() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return tex(c);
}

const CORR_PITCH = 34; // px between corrugation ridges on a 1024 face

function paintCorrugationShading(ctx: CanvasRenderingContext2D, w: number, h: number, alpha = 0.10): void {
  for (let x = 0; x < w; x += CORR_PITCH) {
    const g = ctx.createLinearGradient(x, 0, x + CORR_PITCH, 0);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.45, `rgba(0,0,0,0)`);
    g.addColorStop(0.75, `rgba(20,16,10,${alpha})`);
    g.addColorStop(1, `rgba(255,255,255,${alpha * 0.6})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, CORR_PITCH, h);
  }
}

function paintWeathering(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, mossAmount: number): void {
  const R = rng(seed);
  // soft tonal wear (small soft blotches, not blocky rects)
  for (let i = 0; i < 160; i++) {
    const x = R() * w;
    const y = R() * h;
    const r = 6 + R() * 26;
    const light = R() > 0.5;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, light ? "rgba(255,255,255,0.05)" : "rgba(20,16,10,0.07)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // rust streaks from the top seam
  for (let i = 0; i < 30; i++) {
    const x = R() * w;
    const y0 = R() < 0.65 ? 0 : R() * h * 0.4;
    const len = h * (0.12 + R() * 0.45);
    const sw = 3 + R() * 10;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, "rgba(112,58,26,0.5)");
    g.addColorStop(0.35, "rgba(96,50,24,0.26)");
    g.addColorStop(1, "rgba(80,44,22,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - sw / 2, y0, sw, len);
  }
  // rust blooms
  for (let i = 0; i < 26; i++) {
    const x = R() * w;
    const y = R() * h;
    const r = 5 + R() * 16;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, `rgba(${100 + R() * 30},${52 + R() * 18},24,${0.3 + R() * 0.2})`);
    g.addColorStop(1, "rgba(90,48,22,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // moss creeping from the bottom: clump anchors + fine leaf-dot detail
  const mossH = h * (0.14 + mossAmount * 0.2);
  const clumps = Math.floor(60 * (0.5 + mossAmount));
  for (let i = 0; i < clumps; i++) {
    const cx = R() * w;
    const t = Math.pow(R(), 2.1);
    const cy = h - t * mossH - R() * 8;
    const alpha = Math.max(0.06, 0.4 * (1 - (h - cy) / (mossH + 12)));
    const n = 7 + Math.floor(R() * 9);
    for (let d = 0; d < n; d++) {
      const dx = (R() - 0.5) * 18;
      const dy = (R() - 0.5) * 12;
      ctx.fillStyle = `rgba(${52 + R() * 34},${88 + R() * 42},${40 + R() * 18},${alpha * (0.7 + R() * 0.5)})`;
      ctx.beginPath();
      ctx.ellipse(cx + dx, cy + dy, 1.2 + R() * 2.6, 1 + R() * 1.8, R() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // edge grime top/bottom
  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, "rgba(30,24,16,0.24)");
  edge.addColorStop(0.1, "rgba(30,24,16,0)");
  edge.addColorStop(0.85, "rgba(30,24,16,0)");
  edge.addColorStop(1, "rgba(22,18,11,0.45)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
}

/** Weathered painted steel side — NO stencil (signage is a separate fitted decal). */
export function containerSideTex(baseHex: string, seed: number, mossAmount = 0.5): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 512);
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 1024, 512);
  paintCorrugationShading(ctx, 1024, 512, 0.08);
  paintWeathering(ctx, 1024, 512, seed, mossAmount);
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Container end with a single crisp fitted CNVS.DEV stencil, upright. */
export function containerEndTex(baseHex: string, seed: number, unit: number, prefix = "Y"): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 512, 512);
  paintCorrugationShading(ctx, 512, 512, 0.06);
  // door seams + locking bars
  ctx.fillStyle = "rgba(20,16,10,0.4)";
  ctx.fillRect(252, 20, 8, 472);
  for (const x of [150, 210, 300, 360]) {
    ctx.fillStyle = "rgba(52,48,38,0.5)";
    ctx.fillRect(x, 30, 10, 452);
    ctx.fillStyle = "rgba(255,255,240,0.14)";
    ctx.fillRect(x + 2, 30, 3, 452);
    ctx.fillStyle = "rgba(20,18,12,0.35)";
    ctx.fillRect(x + 8, 30, 2, 452);
  }
  // fitted stencil block (once, upright, clear of edges)
  ctx.save();
  ctx.translate(256, 200);
  ctx.font = "700 64px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(242,234,212,0.62)";
  ctx.fillText("CNVS.DEV", 0, 0);
  ctx.font = "700 20px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.fillStyle = "rgba(242,234,212,0.45)";
  ctx.fillText("THE FUTURE OF VIBE CODING", 0, 42);
  // banana glyph
  ctx.strokeStyle = "rgba(240,214,100,0.65)";
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, -92, 40, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();
  ctx.restore();
  // unit id (nameable noun per unit)
  ctx.font = "700 44px 'Share Tech Mono', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(240,234,214,0.5)";
  ctx.fillText(`${prefix}-${String(unit).padStart(2, "0")}`, 34, 470);
  paintWeathering(ctx, 512, 512, seed + 77, 0.45);
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Alternate end livery: no wordmark — big unit ID + hazard band + small glyph.
 *  Used on the second container of each pair so flush paired ends never read as
 *  one face with a doubled logo. */
export function containerEndAltTex(baseHex: string, seed: number, unit: number, prefix = "Y"): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 512, 512);
  paintCorrugationShading(ctx, 512, 512, 0.06);
  // door seams + locking bars
  ctx.fillStyle = "rgba(20,16,10,0.4)";
  ctx.fillRect(252, 20, 8, 472);
  for (const x of [150, 210, 300, 360]) {
    ctx.fillStyle = "rgba(52,48,38,0.5)";
    ctx.fillRect(x, 30, 10, 452);
    ctx.fillStyle = "rgba(255,255,240,0.14)";
    ctx.fillRect(x + 2, 30, 3, 452);
    ctx.fillStyle = "rgba(20,18,12,0.35)";
    ctx.fillRect(x + 8, 30, 2, 452);
  }
  // hazard band
  ctx.save();
  ctx.beginPath();
  ctx.rect(60, 356, 392, 40);
  ctx.clip();
  for (let x = 40; x < 512; x += 44) {
    ctx.fillStyle = "rgba(214,178,60,0.55)";
    ctx.beginPath();
    ctx.moveTo(x, 396);
    ctx.lineTo(x + 22, 356);
    ctx.lineTo(x + 44, 356);
    ctx.lineTo(x + 22, 396);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // large unit ID
  ctx.font = "700 96px 'Share Tech Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(240,234,214,0.55)";
  ctx.fillText(`${prefix}-${String(unit).padStart(2, "0")}`, 256, 220);
  // small banana glyph
  ctx.strokeStyle = "rgba(240,214,100,0.55)";
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(256, 96, 26, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();
  paintWeathering(ctx, 512, 512, seed + 191, 0.4);
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Interior lining: ribbed steel at low value with AO toward ceiling + floor edges. */
export function containerInteriorTex(baseHex: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 256);
  const col = new THREE.Color(baseHex).multiplyScalar(0.66);
  ctx.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
  ctx.fillRect(0, 0, 512, 256);
  // ribs
  for (let x = 0; x < 512; x += 26) {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x, 0, 7, 256);
    ctx.fillStyle = "rgba(255,255,240,0.06)";
    ctx.fillRect(x + 9, 0, 4, 256);
  }
  // vertical AO: darker at top (ceiling shadow), slightly darker at floor line
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "rgba(0,0,0,0.3)");
  g.addColorStop(0.35, "rgba(0,0,0,0.08)");
  g.addColorStop(0.85, "rgba(0,0,0,0.06)");
  g.addColorStop(1, "rgba(0,0,0,0.24)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Roof underside for walkthrough interiors: ribbed with corner AO so the
 * ceiling shades toward the edges instead of reading as one flat plane. */
export function ceilingTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 256, DETAIL);
  ctx.fillStyle = "#4a3d2c";
  ctx.fillRect(0, 0, 512, 256);
  // cross ribs (roof frame members seen from below)
  for (let x = 18; x < 512; x += 62) {
    ctx.fillStyle = "rgba(0,0,0,0.26)";
    ctx.fillRect(x, 0, 9, 256);
    ctx.fillStyle = "rgba(255,244,220,0.05)";
    ctx.fillRect(x + 11, 0, 4, 256);
  }
  // grime streaks along the ribs
  const R = rng(4242);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(20,14,8,${0.05 + R() * 0.08})`;
    ctx.fillRect(R() * 512, R() * 256, 3 + R() * 26, 2 + R() * 5);
  }
  // corner/edge AO vignette
  const g1 = ctx.createLinearGradient(0, 0, 0, 256);
  g1.addColorStop(0, "rgba(0,0,0,0.34)");
  g1.addColorStop(0.3, "rgba(0,0,0,0.05)");
  g1.addColorStop(0.7, "rgba(0,0,0,0.05)");
  g1.addColorStop(1, "rgba(0,0,0,0.34)");
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, 512, 256);
  const g2 = ctx.createLinearGradient(0, 0, 512, 0);
  g2.addColorStop(0, "rgba(0,0,0,0.3)");
  g2.addColorStop(0.25, "rgba(0,0,0,0.04)");
  g2.addColorStop(0.75, "rgba(0,0,0,0.04)");
  g2.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, 512, 256);
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Worn plank floor for walkthrough interiors. */
export function plankTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 256, DETAIL);
  const R = rng(5150);
  ctx.fillStyle = "#57422a";
  ctx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 6; i++) {
    const y = i * 43;
    ctx.fillStyle = i % 2 ? "#4f3c26" : "#5d472e";
    ctx.fillRect(0, y, 512, 41);
    ctx.fillStyle = "rgba(20,14,8,0.6)";
    ctx.fillRect(0, y + 41, 512, 3);
    ctx.strokeStyle = "rgba(30,22,12,0.35)";
    ctx.lineWidth = 1.4;
    for (let gLine = 0; gLine < 4; gLine++) {
      const gy = y + 6 + R() * 32;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.bezierCurveTo(150, gy + (R() - 0.5) * 8, 380, gy + (R() - 0.5) * 8, 512, gy);
      ctx.stroke();
    }
  }
  const edge = ctx.createLinearGradient(0, 0, 512, 0);
  edge.addColorStop(0, "rgba(0,0,0,0.3)");
  edge.addColorStop(0.15, "rgba(0,0,0,0)");
  edge.addColorStop(0.85, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, 512, 256);
  return tex(c, false);
}

/** Mossy corrugated sheeting for the perimeter fence walls, AO gradient at base. */
export function fenceTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 256, DETAIL);
  ctx.fillStyle = "#5d6647";
  ctx.fillRect(0, 0, 1024, 256);
  paintCorrugationShading(ctx, 1024, 256, 0.12);
  paintWeathering(ctx, 1024, 256, 3301, 0.85);
  // extra base AO so the wall sits into the ground
  const g = ctx.createLinearGradient(0, 130, 0, 256);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(14,16,8,0.5)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 130, 1024, 126);
  const t = tex(c);
  t.repeat.set(6, 1);
  return t;
}

/** Banana leaf with alpha: center rib, side veins, ragged edges. */
export function leafTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 512, DETAIL);
  ctx.clearRect(0, 0, 256, 512);
  ctx.beginPath();
  ctx.moveTo(128, 6);
  const notches = 9;
  for (let i = 0; i <= notches; i++) {
    const t = i / notches;
    const y = 6 + t * 496;
    const w = Math.sin(Math.min(1, t * 1.25) * Math.PI) * (86 - t * 12) + 6;
    const notch = i % 2 === 1 ? 0.72 : 1;
    ctx.lineTo(128 + w * notch, y);
  }
  for (let i = notches; i >= 0; i--) {
    const t = i / notches;
    const y = 6 + t * 496;
    const w = Math.sin(Math.min(1, t * 1.25) * Math.PI) * (86 - t * 12) + 6;
    const notch = i % 2 === 0 ? 0.78 : 1;
    ctx.lineTo(128 - w * notch, y);
  }
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#47793a");
  grad.addColorStop(0.5, "#3b6e33");
  grad.addColorStop(1, "#2e5528");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.save();
  ctx.clip();
  const side = ctx.createLinearGradient(0, 0, 256, 0);
  side.addColorStop(0, "rgba(20,40,16,0.28)");
  side.addColorStop(0.5, "rgba(255,255,240,0.10)");
  side.addColorStop(1, "rgba(20,40,16,0.28)");
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, 256, 512);
  ctx.strokeStyle = "rgba(215,235,165,0.32)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 16; i++) {
    const y = 20 + i * 30;
    ctx.beginPath();
    ctx.moveTo(128, y);
    ctx.lineTo(240, y + 42);
    ctx.moveTo(128, y);
    ctx.lineTo(16, y + 42);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(206,218,142,0.75)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(128, 4);
  ctx.lineTo(128, 508);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}

/** Vine card: hanging stem with leaflet clusters (two greens), alpha edges. */
export function vineTex(variant: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 512, DETAIL);
  const R = rng(700 + variant * 131);
  ctx.clearRect(0, 0, 128, 512);
  const stems = 2 + (variant % 2);
  for (let s = 0; s < stems; s++) {
    const x0 = 34 + s * (56 / stems) + R() * 18;
    ctx.strokeStyle = s % 2 ? "#3c5e2c" : "#2f5426";
    ctx.lineWidth = 4 - s;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    let x = x0;
    for (let y = 0; y <= 512; y += 32) {
      x += (R() - 0.5) * 16;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    // leaflets along the stem
    let lx = x0;
    for (let y = 10; y < 480 - s * 60; y += 22 + R() * 18) {
      lx += (R() - 0.5) * 14;
      const la = R() * Math.PI * 2;
      const lr = 7 + R() * 9;
      const g = R() > 0.5;
      ctx.fillStyle = g ? "rgba(74,116,52,0.95)" : "rgba(52,92,42,0.95)";
      ctx.beginPath();
      ctx.ellipse(lx + Math.cos(la) * 5, y, lr, lr * 0.45, la, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(150,190,110,0.3)";
      ctx.beginPath();
      ctx.ellipse(lx + Math.cos(la) * 5 - 1, y - 1, lr * 0.5, lr * 0.2, la, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}

/** Palm trunk bark: stacked ring segments. */
export function barkTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 512, DETAIL);
  const R = rng(881);
  ctx.fillStyle = "#6e5f49";
  ctx.fillRect(0, 0, 256, 512);
  for (let y = 0; y < 512; y += 34) {
    ctx.fillStyle = `rgba(${52 + R() * 20},${44 + R() * 16},30,0.45)`;
    ctx.fillRect(0, y, 256, 7 + R() * 4);
    ctx.fillStyle = "rgba(255,244,220,0.06)";
    ctx.fillRect(0, y + 11, 256, 5);
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = "rgba(60,50,34,0.25)";
      ctx.fillRect(R() * 256, y + 12 + R() * 16, 8 + R() * 18, 3);
    }
  }
  return tex(c);
}

/** Light wooden banana-crate boards with stencil. */
export function crateTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512, DETAIL);
  const R = rng(2210);
  ctx.fillStyle = "#c8a86a";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5; i++) {
    const y = i * 102;
    ctx.fillStyle = i % 2 ? "#c0a062" : "#cfb075";
    ctx.fillRect(0, y, 512, 98);
    ctx.fillStyle = "rgba(60,44,24,0.55)";
    ctx.fillRect(0, y + 98, 512, 5);
    ctx.strokeStyle = "rgba(120,92,50,0.35)";
    ctx.lineWidth = 1.6;
    for (let g = 0; g < 6; g++) {
      const gy = y + 10 + R() * 80;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.bezierCurveTo(150, gy + (R() - 0.5) * 10, 360, gy + (R() - 0.5) * 10, 512, gy);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "rgba(112,88,50,0.85)";
  ctx.fillRect(0, 0, 34, 512);
  ctx.fillRect(478, 0, 34, 512);
  ctx.save();
  ctx.translate(256, 260);
  ctx.strokeStyle = "rgba(200,150,30,0.9)";
  ctx.lineWidth = 16;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, -30, 58, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();
  ctx.font = "700 44px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(90,62,26,0.8)";
  ctx.fillText("CNVS.DEV", 0, 86);
  ctx.restore();
  return tex(c);
}

/** Crate lid: cross slats + perimeter banding, ~12% darker than the sides. */
export function crateLidTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512, DETAIL);
  const R = rng(3310);
  ctx.fillStyle = "#b3925a";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5; i++) {
    const x = i * 102;
    ctx.fillStyle = i % 2 ? "#ab8b53" : "#ba9a63";
    ctx.fillRect(x, 0, 98, 512);
    ctx.fillStyle = "rgba(58,42,22,0.55)";
    ctx.fillRect(x + 98, 0, 5, 512);
    ctx.strokeStyle = "rgba(112,86,46,0.35)";
    ctx.lineWidth = 1.6;
    for (let g = 0; g < 6; g++) {
      const gx = x + 10 + R() * 80;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.bezierCurveTo(gx + (R() - 0.5) * 10, 150, gx + (R() - 0.5) * 10, 360, gx, 512);
      ctx.stroke();
    }
  }
  // wood knots
  for (let i = 0; i < 8; i++) {
    const x = R() * 512;
    const y = R() * 512;
    ctx.strokeStyle = "rgba(96,70,38,0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y, 3 + R() * 4, 2 + R() * 3, R() * Math.PI, 0, Math.PI * 2);
    ctx.stroke();
  }
  // perimeter edge banding + nail heads
  ctx.fillStyle = "rgba(104,80,44,0.85)";
  ctx.fillRect(0, 0, 512, 30);
  ctx.fillRect(0, 482, 512, 30);
  ctx.fillRect(0, 0, 30, 512);
  ctx.fillRect(482, 0, 30, 512);
  ctx.fillStyle = "rgba(58,44,26,0.75)";
  for (let i = 0; i < 8; i++) {
    const p = 44 + i * 60;
    for (const [nx, ny] of [
      [p, 15],
      [p, 497],
      [15, p],
      [497, p],
    ] as [number, number][]) {
      ctx.beginPath();
      ctx.arc(nx, ny, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // stencil: banana arc + freight line
  ctx.save();
  ctx.translate(256, 250);
  ctx.strokeStyle = "rgba(196,146,30,0.8)";
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, -26, 50, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();
  ctx.font = "700 22px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(88,60,26,0.75)";
  ctx.fillText("THE FUTURE OF VIBE CODING", 0, 78);
  ctx.restore();
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Galvanized-steel trim for jambs/castings/caps: vertical streaking, spangle
 *  mottle, edge chips — ~10% value variation on the container palette. */
export function trimTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256, DETAIL);
  const R = rng(9182);
  ctx.fillStyle = "#847d6a";
  ctx.fillRect(0, 0, 256, 256);
  // vertical weather streaking
  for (let i = 0; i < 64; i++) {
    const x = R() * 256;
    const w = 2 + R() * 7;
    const light = R() > 0.5;
    const a = 0.05 + R() * 0.07;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, light ? `rgba(236,232,214,${a})` : `rgba(52,46,34,${a})`);
    g.addColorStop(1, light ? `rgba(236,232,214,${a * 0.3})` : `rgba(52,46,34,${a * 0.55})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, 256);
  }
  // galvanized spangle mottle
  for (let i = 0; i < 260; i++) {
    const v = R();
    ctx.fillStyle = v > 0.5 ? `rgba(226,220,200,${0.04 + v * 0.05})` : `rgba(58,52,40,${0.04 + v * 0.05})`;
    ctx.beginPath();
    ctx.arc(R() * 256, R() * 256, 1.4 + R() * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // edge chips: dark nick + bright bare-metal fleck beside it
  for (let i = 0; i < 34; i++) {
    const x = R() * 256;
    const y = R() * 256;
    ctx.fillStyle = "rgba(46,40,30,0.5)";
    ctx.fillRect(x, y, 2 + R() * 4, 1.4 + R() * 2.4);
    ctx.fillStyle = "rgba(222,216,196,0.4)";
    ctx.fillRect(x + 1, y - 1.6, 1.4 + R() * 2.4, 1.2);
  }
  // faint rust kisses
  for (let i = 0; i < 14; i++) {
    const x = R() * 256;
    const y = R() * 256;
    const r = 3 + R() * 8;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, "rgba(112,60,28,0.28)");
    g.addColorStop(1, "rgba(112,60,28,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return tex(c);
}

/** Small rear-plate decal for the forklift: banana arc + wordmark. */
export function forkliftDecalTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 128, DETAIL);
  ctx.clearRect(0, 0, 256, 128);
  ctx.fillStyle = "rgba(34,30,20,0.55)";
  ctx.fillRect(4, 4, 248, 120);
  ctx.strokeStyle = "rgba(240,214,100,0.85)";
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(128, 46, 26, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();
  ctx.font = "700 30px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(242,234,212,0.9)";
  ctx.fillText("CNVS.DEV", 128, 106);
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Warm tropical sky gradient with soft cumulus — no blown whites anywhere. */
export function canopySkyTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  const R = rng(6060);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, "#5f8cb4");
  g.addColorStop(0.4, "#93b0ac");
  g.addColorStop(0.58, "#b3bd97");
  g.addColorStop(0.72, "#c3c194");
  g.addColorStop(1, "#b7ae85");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 12; i++) {
    const x = R() * 512;
    const y = 60 + R() * 160;
    const r = 24 + R() * 40;
    const cg = ctx.createRadialGradient(x, y, 2, x, y, r);
    cg.addColorStop(0, "rgba(244,242,228,0.4)");
    cg.addColorStop(0.7, "rgba(240,238,224,0.16)");
    cg.addColorStop(1, "rgba(240,238,224,0)");
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.6, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

/** Canopy silhouette card, 4 variants — edge colors dilated so no light fringe. */
export function treeCardTex(variant: number, withTrunks = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const R = rng(300 + variant * 97);
  ctx.clearRect(0, 0, 256, 256);
  const fill = "#33482c";
  // soft dilation halo in the same green so alpha-test edges never fringe pale
  ctx.shadowColor = "#2c3f27";
  ctx.shadowBlur = 4;
  // crown blobs — irregular per variant
  const blobs = 16 + variant * 5;
  const cx = 128;
  const spread = 70 + variant * 12;
  ctx.fillStyle = fill;
  // solid crown hull beneath the blobs so gaps between them can never punch a
  // sky hole through the middle of the card
  ctx.beginPath();
  ctx.ellipse(cx, 118, Math.min(126, spread + 36), 72, 0, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < blobs; i++) {
    const x = cx + (R() - 0.5) * spread * 2;
    const y = 46 + R() * (108 + variant * 12);
    const r = 20 + R() * (40 - variant * 4);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // droopy palm-ish fronds on some variants
  if (variant % 2 === 1) {
    ctx.strokeStyle = fill;
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i - 2.5) * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, 70);
      ctx.quadraticCurveTo(cx + Math.cos(a) * 70, 40 + Math.sin(a) * 30, cx + Math.cos(a) * 110, 90 + Math.abs(Math.sin(a)) * 60);
      ctx.stroke();
    }
  }
  if (withTrunks) {
    // trunks to the ground so cards never float
    for (let i = 0; i < 2 + (variant % 2); i++) {
      const x = 90 + i * 40 + R() * 20;
      ctx.fillRect(x, 130, 12 + R() * 8, 126);
    }
    // ground blend strip
    ctx.fillRect(0, 236, 256, 20);
  }
  ctx.shadowBlur = 0;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}

/** One transparent overlay for the whole yard: worn paths (ragged edges), tire
 *  ruts through the walkthrough lanes, stains and frond litter. Single draw. */
export function yardOverlayTex(): THREE.CanvasTexture {
  const S = 1024;
  const [c, ctx] = canvas(S, S, DETAIL);
  const R = rng(7777);
  ctx.clearRect(0, 0, S, S);
  const px = (m: number) => ((m + 20.5) / 41) * S; // world meters (-20.5..20.5) → px

  // Paths are stamped on an offscreen layer at full opacity, then composited
  // ONCE at low alpha — overlapping strokes (the center crossing) cannot stack
  // into a bright X and edges stay soft.
  const pc = document.createElement("canvas");
  pc.width = pc.height = S * DETAIL;
  const pctx = pc.getContext("2d", { willReadFrequently: true })!;
  pctx.scale(DETAIL, DETAIL);
  const raggedPath = (x0: number, z0: number, x1: number, z1: number, wMeters: number) => {
    const steps = 30;
    const wPx = (wMeters / 41) * S;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const x = px(x0 + (x1 - x0) * t) + (R() - 0.5) * 8;
      const y = px(z0 + (z1 - z0) * t) + (R() - 0.5) * 8;
      const r = wPx * (0.42 + R() * 0.22);
      const g = pctx.createRadialGradient(x, y, r * 0.15, x, y, r);
      g.addColorStop(0, "rgba(206,184,140,1)");
      g.addColorStop(0.62, "rgba(202,180,136,0.55)");
      g.addColorStop(1, "rgba(196,174,130,0)");
      pctx.fillStyle = g;
      pctx.beginPath();
      pctx.arc(x, y, r, 0, Math.PI * 2);
      pctx.fill();
    }
  };
  raggedPath(-14, 0, 14, 0, 3.2);
  raggedPath(0, -14, 0, 14, 3.2);
  raggedPath(-9, 11.2, 9, 11.2, 2.4);
  ctx.globalAlpha = 0.3;
  // Explicit destination size: the layer is DETAILx larger in device pixels but
  // covers exactly the same S x S logical square, and a bare drawImage under a
  // scaled context would blow it up by DETAIL again.
  ctx.drawImage(pc, 0, 0, S, S);
  ctx.globalAlpha = 1;

  // tire ruts through the E/W walkthrough lanes
  // Soft-edged, low-alpha, butt-capped: round-cap high-alpha strokes read as
  // paired capsule "body shadows" in the open lane sightlines (review r5).
  const rut = (x0: number, z0: number, x1: number, z1: number) => {
    ctx.strokeStyle = "rgba(72,58,38,0.12)";
    ctx.lineWidth = 7;
    ctx.lineCap = "butt";
    for (const off of [-0.35, 0.35]) {
      ctx.beginPath();
      const nx = z1 - z0;
      const nz = x0 - x1;
      const nl = Math.hypot(nx, nz) || 1;
      ctx.moveTo(px(x0 + (nx / nl) * off), px(z0 + (nz / nl) * off));
      ctx.bezierCurveTo(
        px((x0 * 2 + x1) / 3 + (nx / nl) * off + (R() - 0.5)),
        px((z0 * 2 + z1) / 3 + (nz / nl) * off),
        px((x0 + x1 * 2) / 3 + (nx / nl) * off),
        px((z0 + z1 * 2) / 3 + (nz / nl) * off + (R() - 0.5)),
        px(x1 + (nx / nl) * off),
        px(z1 + (nz / nl) * off),
      );
      ctx.stroke();
    }
  };
  // Only off the main EW sightline: mid-lane rut pairs read as fake contacts.
  rut(-4, 13.4, 5, 13.2);

  // NO oil/water stain blobs: caster-less dark ellipses in open lanes read as
  // fake body shadows (failed review r5 twice). Ground variance lives in the
  // dirt albedo instead.
  // frond litter clusters near edges
  for (let i = 0; i < 90; i++) {
    const ang = R() * Math.PI * 2;
    const rr = 10 + R() * 9;
    const x = px(Math.cos(ang) * rr);
    const y = px(Math.sin(ang) * rr);
    const g = R() > 0.4;
    ctx.fillStyle = g ? "rgba(88,110,48,0.5)" : "rgba(110,86,42,0.5)";
    ctx.beginPath();
    ctx.ellipse(x, y, 3 + R() * 5, 1.4 + R() * 2, R() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}

/** CNVS billboard face decal: the Tripo mesh keeps the structure, this quad
 *  keeps the words. Same rule as the containers — fillText, never baked. */
export function billboardFaceTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 512, DETAIL);
  const R = rng(4177);
  // olive plank base with vertical tonal streaks
  ctx.fillStyle = "#57603a";
  ctx.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 90; i++) {
    const x = R() * 1024;
    const w = 4 + R() * 20;
    ctx.fillStyle = `rgba(${40 + R() * 40},${52 + R() * 30},${26 + R() * 20},${0.1 + R() * 0.14})`;
    ctx.fillRect(x, 0, w, 512);
  }
  // yellow pinstripe border
  ctx.strokeStyle = "rgba(226,186,52,0.9)";
  ctx.lineWidth = 3.5;
  ctx.strokeRect(35, 35, 954, 442);
  // wordmark + tagline
  ctx.textAlign = "center";
  ctx.fillStyle = "#e8bc34";
  ctx.font = "170px 'Archivo Black', 'Anton', sans-serif";
  ctx.fillText("cnvs.dev", 512, 280);
  ctx.font = "700 46px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.fillStyle = "rgba(232,188,52,0.92)";
  const tagline = "T H E   F U T U R E   O F   V I B E   C O D I N G";
  ctx.fillText(tagline, 512, 365);
  // paint wear clipped INSIDE the letters: aged, never damaged
  ctx.globalCompositeOperation = "source-atop";
  for (let i = 0; i < 240; i++) {
    ctx.fillStyle = `rgba(60,66,42,${0.05 + R() * 0.1})`;
    ctx.fillRect(R() * 1024, R() * 512, 1 + R() * 3, 1 + R() * 2);
  }
  ctx.globalCompositeOperation = "source-over";
  paintWeathering(ctx, 1024, 512, 917, 0.4);
  // painted vine tips spilling past the mesh's own 3D vines at the top edge
  for (let i = 0; i < 7; i++) {
    const vx = 70 + R() * 884;
    const len = 45 + R() * 100;
    ctx.strokeStyle = "rgba(60,110,48,0.9)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(vx, 0);
    ctx.bezierCurveTo(vx + (R() - 0.5) * 8, len * 0.35, vx + (R() - 0.5) * 8, len * 0.7, vx + (R() - 0.5) * 5, len);
    ctx.stroke();
    for (let d = 0; d < len / 8; d++) {
      ctx.fillStyle = `rgba(${70 + R() * 40},${120 + R() * 40},50,0.95)`;
      ctx.beginPath();
      ctx.ellipse(vx + (R() - 0.5) * 6, 4 + d * 8, 2, 1.2, R() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const t = tex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
