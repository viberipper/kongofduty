import * as THREE from "three";
import { ANISO } from "./textures";
import { assetUrl } from "./asset-base";

/**
 * KONG-DESERT canvas texture library for the de_dust2 reskin.
 *
 * Ported from the look-dev prototype scripts/dustmap/lookdev/kong-dust-textures.mjs
 * (docs/dustmap/spec-art.md §7.1 lists the three changes made on the way in:
 * memoisation, DETAIL on the hard-edged recipes, and ANISO imported from
 * ./textures instead of redeclared). Every recipe, seed, hex and count below is
 * the one that produced the round-8 look-dev frames — changing one changes the
 * art, so change it in the look-dev rig first and re-shoot.
 *
 * Albedo only. Value variation, never baked directional light — the house rule
 * from client/src/jungle-textures.ts:5, and the one qa/darkgate.mjs and the map
 * reviewer enforce. Every routine here is either lifted verbatim from
 * jungle-textures.ts or is a documented derivative of one; the palette is the
 * kong container/crate/trim palette pushed to a sun-bleached desert grade, and
 * every hex is written down in docs/dustmap/spec-art.md §2.2.
 *
 * TILING CONTRACT (the thing that makes this read as intentional):
 *   The source dust2 UVs are world-projected — uv = worldDistance / L, where L
 *   is a per-material constant measured in lookdev/uv-density.json. A kong
 *   canvas therefore has a WORLD SIZE, not a pixel size: one 0..1 tile of the
 *   canvas must cover the same L metres the source tile covered, or the map
 *   reads as the wrong scale. Every recipe below is authored for a specific
 *   `worldM` and its detail sizes are computed from it (px = worldM_feature *
 *   canvasPx / worldM), so a wall course is 0.556 m whatever the canvas size is.
 *
 * WRAPPING: every tile canvas is RepeatWrapping, and so is every FITTED one.
 *   The source's fitted UVs are 0..1 per instance PLUS INTEGER OFFSETS (the
 *   circled-B door is u 12.5..13), so ClampToEdge smears the canvas's edge
 *   column across the whole face — that bug rendered every door in the map as a
 *   flat peach rectangle (spec-art §8 flaw 7). The only two ClampToEdge
 *   textures are the horizon container skins, drawn on our own 0..1 box UVs.
 */

/** 2D context alias — the canvas helper hands one back on every call. */
type Ctx = CanvasRenderingContext2D;

/**
 * jungle-textures.ts:20. Supersample the HARD-EDGED recipes only: a 2x canvas
 * drawn through a 2x ctx transform is the same picture at twice the resolution,
 * which is what keeps a door stile, a coping arris or a stencilled letter from
 * crawling under anisotropic minification. NOT applied to sand / plaster /
 * cobble / cliff / sky / dune: their content is low-contrast blotch and grain
 * with nothing above the current texel frequency, so DETAIL there buys VRAM and
 * no pixels (spec-art §7.1).
 */
const DETAIL = 2;

/**
 * textures.ts:143 pattern. The look-dev rig rebuilt every canvas on page load;
 * the game builds each exactly once. Keyed on every argument that changes the
 * picture, because several recipes are called at more than one world size
 * (sandFloorTex is both the 3.251 m floor bin and the 6.5 m backdrop plane).
 */
const cache = new Map<string, THREE.CanvasTexture>();
type Recipe = Pick<THREE.Texture, "wrapS" | "wrapT" | "colorSpace" | "mapping" | "flipY" | "anisotropy" | "minFilter" | "magFilter"> & { key: string; file: string; fileLow?: string; repeat: [number, number] };
let preloaded: Promise<void> | undefined;

/** Load lossless exports of the deterministic recipes; missing files fall back
 * to the original canvas recipe. Art, UVs and native resolution stay identical. */
export function preloadTextures(lowDetail = false): Promise<void> {
  if (new URLSearchParams(location.search).has("proceduralTextures")) return Promise.resolve();
  return preloaded ??= (async () => {
    try {
      const res = await fetch(assetUrl("/assets/textures/dust2/manifest.json"));
      if (!res.ok) return;
      const recipes = await res.json() as Recipe[];
      await Promise.all(recipes.map(async ({key, file, fileLow, repeat, ...settings}) => {
        try {
          const loaded = await new THREE.TextureLoader().loadAsync(assetUrl(`/assets/textures/dust2/${lowDetail && fileLow ? fileLow : file}`));
          const texture = new THREE.CanvasTexture(loaded.image);
          Object.assign(texture, settings);
          texture.repeat.set(...repeat);
          cache.set(key, texture);
        } catch { /* The recipe remains available on demand. */ }
      }));
    } catch { /* Offline or older asset deployment: use the recipes. */ }
  })();
}

/** Asset build input; never called by gameplay. */
export function exportRecipes() {
  return [...cache].map(([key, t]) => ({ key, png: (t.image as HTMLCanvasElement).toDataURL("image/png"), repeat: [t.repeat.x, t.repeat.y], wrapS: t.wrapS, wrapT: t.wrapT, colorSpace: t.colorSpace, mapping: t.mapping, flipY: t.flipY, anisotropy: t.anisotropy, minFilter: t.minFilter, magFilter: t.magFilter }));
}
function memo(key: string, build: () => THREE.CanvasTexture): THREE.CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const t = build();
  cache.set(key, t);
  return t;
}

/** Number of canvases built so far — reported by the world builder's stats. */
export function texturesBuilt(): number {
  return cache.size;
}

// ---------------------------------------------------------------- palette ---
// Derivation is documented in spec-art.md; nothing here is a free invention.
export const P = {
  // sand / stone family (from crateTex #c8a86a + crate lid #b3925a + bone #f5eeda)
  SAND_LIGHT: "#d8c49a",
  SAND: "#c8a86a",
  SAND_MID: "#bb9a62",
  SAND_DEEP: "#a8894f",
  SANDSTONE: "#c2a274",
  SANDSTONE_HI: "#d2b58a",
  SANDSTONE_LO: "#a8875c",
  MORTAR: "#a08a63",
  ADOBE: "#c3a97e",
  ADOBE_SHADE: "#ad9166",
  COBBLE: "#a98c5f",
  COBBLE_HI: "#bd9f70",
  COBBLE_LO: "#8d7550",
  COBBLE_JOINT: "#8a7350",
  DUST_FLOOR: "#c2a473",
  DUST_FINE: "#cbb182",
  // wood family (from plankTex #57422a / crateTex #c8a86a)
  WOOD_PLANK: "#57422a",
  WOOD_SUN: "#7d6038",
  WOOD_SUN_ALT: "#6b5230",
  WOOD_DOOR: "#7a5836",
  WOOD_DOOR_ALT: "#6b4c2e",
  CRATE: "#c8a86a",
  CRATE_A: "#c0a062",
  CRATE_B: "#cfb075",
  CRATE_POST: "rgba(112,88,50,0.85)",
  // metal family (trimTex #847d6a, trim mat 0x8f8874, kong green #4a7040)
  TRIM: "#847d6a",
  TRIM_TINT: 0x8f8874,
  METAL_GREEN: "#4a7040",
  METAL_GREEN_SUN: "#5d7448",
  METAL_RUST: "#7a5636",
  TUBE: "#e4dcc6",
  // rock
  CLIFF: "#a8845c",
  CLIFF_HI: "#b8976e",
  CLIFF_LO: "#8d6c48",
  // brand (verbatim from report-render 2.5 / 2.7)
  AMBER: "#ffd24a",
  AMBER_DEEP: "#e8bc34",
  BANANA_ARC: "rgba(240,214,100,0.65)",
  KONG_RED: "#a04434",
  KONG_RED_HOT: "#c4523a",
  KONG_TEAL: "#3a7a80",
  BONE: "#f5eeda",
  // Toned down from the look-dev #ded7c2 (spec-art §8, remaining flaw 2): the
  // memorial-plaque box is 84.6 m2 of flat plate floating 10 m outside the north
  // wall, and at #ded7c2 it was the BRIGHTEST object in the map, visible over
  // the crest from B site. -9 % puts it under the coping highlight and inside
  // the sandstone family instead of above it.
  BONE_PLATE: "#cdc4ab",
  INK: "#2e2e2e", // darkgate albedo floor — never paint darker than this
  MOSS: "rgba(74,106,52,",
};

export const FONT_COND = "'Barlow Condensed', 'Arial Narrow', sans-serif";
export const FONT_BLACK = "'Archivo Black', 'Anton', sans-serif";
export const FONT_MONO = "'Share Tech Mono', monospace";

// ------------------------------------------------------------- primitives ---
export function canvas(w: number, h: number, detail = 1): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w * detail;
  c.height = h * detail;
  const ctx = c.getContext("2d")!;
  if (detail !== 1) ctx.scale(detail, detail);
  return [c, ctx];
}

/** jungle-textures.ts:40 — deterministic LCG so weathering is stable run to run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function tex(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  else t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = ANISO;
  return t;
}

/** jungle-textures.ts:162, verbatim maths; pitch is passed so a rib can be given
 *  a real world size instead of the container's fixed 34 px / 1024. */
export function paintCorrugationShading(ctx: Ctx, w: number, h: number, alpha = 0.1, pitch = 34): void {
  for (let x = 0; x < w; x += pitch) {
    const g = ctx.createLinearGradient(x, 0, x + pitch, 0);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.45, "rgba(0,0,0,0)");
    g.addColorStop(0.75, `rgba(20,16,10,${alpha})`);
    g.addColorStop(1, `rgba(255,255,255,${alpha * 0.6})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, pitch, h);
  }
}

/** jungle-textures.ts:174, verbatim — for FITTED panels (doors, plates, boxes)
 *  where the top seam and the bottom edge are real edges of a real object. */
export function paintWeathering(ctx: Ctx, w: number, h: number, seed: number, mossAmount: number): void {
  const R = rng(seed);
  for (let i = 0; i < 160; i++) {
    const x = R() * w, y = R() * h, r = 6 + R() * 26;
    const light = R() > 0.5;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, light ? "rgba(255,255,255,0.05)" : "rgba(20,16,10,0.07)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
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
  for (let i = 0; i < 26; i++) {
    const x = R() * w, y = R() * h, r = 5 + R() * 16;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, `rgba(${100 + R() * 30},${52 + R() * 18},24,${0.3 + R() * 0.2})`);
    g.addColorStop(1, "rgba(90,48,22,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const mossH = h * (0.14 + mossAmount * 0.2);
  const clumps = Math.floor(60 * (0.5 + mossAmount));
  for (let i = 0; i < clumps; i++) {
    const cx = R() * w;
    const t = Math.pow(R(), 2.1);
    const cy = h - t * mossH - R() * 8;
    const alpha = Math.max(0.06, 0.4 * (1 - (h - cy) / (mossH + 12)));
    const n = 7 + Math.floor(R() * 9);
    for (let d = 0; d < n; d++) {
      ctx.fillStyle = `rgba(${52 + R() * 34},${88 + R() * 42},${40 + R() * 18},${alpha * (0.7 + R() * 0.5)})`;
      ctx.beginPath();
      ctx.ellipse(cx + (R() - 0.5) * 18, cy + (R() - 0.5) * 12, 1.2 + R() * 2.6, 1 + R() * 1.8, R() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, "rgba(30,24,16,0.24)");
  edge.addColorStop(0.1, "rgba(30,24,16,0)");
  edge.addColorStop(0.85, "rgba(30,24,16,0)");
  edge.addColorStop(1, "rgba(22,18,11,0.45)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
}

/**
 * WRAP-SAFE weathering — the one real deviation from jungle-textures.ts, and it
 * is forced by the geometry: a container face is a FITTED quad (its texture is
 * ClampToEdge), so paintWeathering can legally paint a top rust seam and a
 * bottom grime gradient. dust2's walls are world-projected and REPEAT, so those
 * two layers would stripe the map every L metres and fail the reviewer's
 * "no visible tiling" gate.
 * Kept: the blotch/streak/bloom/moss language, alphas and colours, and the LCG.
 * Changed: every mark is drawn at the 9 wrap offsets (the jungleDirtTex trick,
 * jt:56-64), streaks start anywhere instead of at the top seam, and the edge
 * grime gradient is dropped.
 */
export function paintWeatheringTiled(
  ctx: Ctx,
  w: number,
  h: number,
  seed: number,
  mossAmount: number,
  opts: { blotches?: number; streaks?: number; blooms?: number } = {},
): void {
  const R = rng(seed);
  const blotches = opts.blotches ?? 40;
  const streaks = opts.streaks ?? 12;
  const blooms = opts.blooms ?? 22;
  const nine = (fn: (ox: number, oy: number) => void) => {
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) fn(ox, oy);
  };
  for (let i = 0; i < blotches; i++) {
    // MACRO variation only: 0.17..1.05 m on a 4.45 m tile. Round-1 used the
    // jungle radii (6..32 px) and they read as soap bubbles at 2 m.
    const x = R() * w, y = R() * h, r = (0.04 + R() * 0.20) * Math.max(w, h);
    const light = R() > 0.5;
    nine((ox, oy) => {
      const g = ctx.createRadialGradient(x + ox, y + oy, 1, x + ox, y + oy, r);
      // alpha halved vs the fitted routine: these are LARGER and land on a pale
      // sun-bleached surface, where 0.05/0.07 read as soap bubbles at 2 m
      g.addColorStop(0, light ? "rgba(255,255,255,0.016)" : "rgba(20,16,10,0.022)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  for (let i = 0; i < streaks; i++) {
    const x = R() * w, y0 = R() * h;
    const len = h * (0.10 + R() * 0.30);
    const sw = 3 + R() * 9;
    nine((ox, oy) => {
      const g = ctx.createLinearGradient(0, y0 + oy, 0, y0 + oy + len);
      g.addColorStop(0, "rgba(112,58,26,0.20)");
      g.addColorStop(0.35, "rgba(96,50,24,0.11)");
      g.addColorStop(1, "rgba(80,44,22,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + ox - sw / 2, y0 + oy, sw, len);
    });
  }
  for (let i = 0; i < blooms; i++) {
    const x = R() * w, y = R() * h, r = 5 + R() * 16;
    const cr = 100 + R() * 30, cg = 52 + R() * 18, ca = 0.22 + R() * 0.16;
    nine((ox, oy) => {
      const g = ctx.createRadialGradient(x + ox, y + oy, 1, x + ox, y + oy, r);
      g.addColorStop(0, `rgba(${cr},${cg},24,${ca})`);
      g.addColorStop(1, "rgba(90,48,22,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  // moss, dry-climate dose: clumps sit in random shaded pockets, not a bottom
  // band, and the COUNT is 46*moss (7 clumps at moss 0.15) instead of the
  // jungle's 60*(0.5+moss) (39 clumps) - a desert wall is not a wet one.
  const clumps = Math.floor(46 * mossAmount);
  for (let i = 0; i < clumps; i++) {
    const cx = R() * w, cy = R() * h;
    const alpha = 0.06 + R() * 0.09;
    const n = 5 + Math.floor(R() * 7);
    for (let d = 0; d < n; d++) {
      const dx = (R() - 0.5) * 16, dy = (R() - 0.5) * 12;
      const col = `rgba(${52 + R() * 34},${88 + R() * 42},${40 + R() * 18},${alpha * (0.7 + R() * 0.5)})`;
      const rx = 1.2 + R() * 2.4, ry = 1 + R() * 1.6, rot = R() * Math.PI;
      nine((ox, oy) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.ellipse(cx + dx + ox, cy + dy + oy, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
}

/** Wrap-safe fine grain: the jungleDirtTex speckle pass at a chosen density. */
function grain(
  ctx: Ctx,
  w: number,
  h: number,
  R: () => number,
  n: number,
  lightHex: string,
  darkHex: string,
  aLo = 0.04,
  aHi = 0.1,
): void {
  for (let i = 0; i < n; i++) {
    const v = R();
    ctx.fillStyle = v > 0.5 ? `${lightHex}${(aLo + v * aHi).toFixed(3)})` : `${darkHex}${(aLo + v * aHi).toFixed(3)})`;
    const x = R() * w, y = R() * h;
    ctx.fillRect(x, y, 1 + R() * 2.2, 1 + R() * 1.8);
  }
}

/** The kong banana arc (report-render 2.7), stroked. */
export function bananaArc(ctx: Ctx, cx: number, cy: number, r: number, lw: number, style: string = P.BANANA_ARC): void {
  ctx.save();
  ctx.strokeStyle = style;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();
  ctx.restore();
}

// ============================================================== BIN RECIPES ==
// Each takes the bin's world size (metres per 0..1 tile) so feature sizes are
// authored in METRES and the canvas resolution is a free parameter.

/** BIN 1 — sandstone ashlar wall. worldM 4.452, canvas 512 -> 115 texels/m.
 *  Course 0.556 m (= worldM/8), blocks 0.60..1.05 m, running bond. Every joint
 *  is drawn INSIDE the block loop so the perpends land on real block edges —
 *  drawing them from a second RNG produced a mismatched grid that read as flat
 *  1.4 m panels (round-1 flaw #2). */
export function paintSandstone(ctx: Ctx, N: number, worldM: number, seed: number): void {
  const px = N / worldM;
  const R = rng(seed);
  // The background IS the joint: perpends are the 3 px gaps left between
  // blocks, so they must be the same value as the bed joints or the wall reads
  // as continuous horizontal cables with no vertical structure (round-1 flaw).
  ctx.fillStyle = shade(P.SANDSTONE, -0.30);
  ctx.fillRect(0, 0, N, N);
  const rows = 8;
  const chPx = (worldM / rows) * px;
  const JOINT = 3.0;
  for (let r = 0; r < rows; r++) {
    const y = r * chPx;
    let x = -((r * 0.37) % 1) * 1.05 * px;
    while (x < N) {
      const bw = (0.60 + R() * 0.45) * px;
      const bx = x + JOINT * 0.5, by = y + JOINT * 0.5;
      const bwi = bw - JOINT, bhi = chPx - JOINT;
      // Block base value. Round-1 used +/-0.26 and the memorable light/dark
      // stones became a landmark that repeated every 4.45 m — the reviewer's
      // "no visible tiling" gate — so look-dev cut it to +/-0.13.
      //
      // PHASE 3 RAISES IT TO +/-0.20, and the reason it is safe now is that the
      // repeat this was hiding from no longer exists: dust-world.ts multiplies
      // this bin by a world-space macro modulation at 18 m and 6.4 m, neither
      // of which is commensurate with 4.452 m, so a bright stone is no longer
      // the same brightness the next tile along. Measured cost of the old
      // value: a roofed corridor is 60 % sandstone by area and its ONLY value
      // structure is albedo (no sun reaches it), which is why the look-dev
      // interiors came out at luma sd 17-18 against the source's 29-42.
      const v = (R() - 0.5) * 0.20;
      const face = shade(P.SANDSTONE, v);
      for (const ox of [-N, 0, N]) {
        ctx.fillStyle = face;
        ctx.fillRect(bx + ox, by, bwi, bhi);
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx + ox, by, bwi, bhi);
        ctx.clip();
        // diagonal tonal sweep so no stone is one flat value
        const g = ctx.createLinearGradient(bx + ox, by, bx + ox + bwi, by + bhi);
        g.addColorStop(0, `rgba(255,250,236,${0.03 + R() * 0.06})`);
        g.addColorStop(1, `rgba(66,48,28,${0.04 + R() * 0.08})`);
        ctx.fillStyle = g;
        ctx.fillRect(bx + ox, by, bwi, bhi);
        // pitting: without it a 0.8 x 0.56 m stone is a flat panel at 2 m,
        // which is exactly the "flat untextured face" the reviewer fails
        for (let k = 0; k < 40; k++) {
          const pxx = bx + ox + R() * bwi, pyy = by + R() * bhi;
          const pr = 1.0 + R() * 4.5;
          ctx.fillStyle = R() > 0.5 ? `rgba(232,214,180,${0.08 + R() * 0.14})` : `rgba(98,74,46,${0.08 + R() * 0.16})`;
          ctx.beginPath();
          ctx.ellipse(pxx, pyy, pr, pr * (0.5 + R() * 0.6), R() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }
        // bedding striations across the stone
        for (let k = 0; k < 4; k++) {
          const byy = by + (k + 0.5) * (bhi / 4) + (R() - 0.5) * 4;
          ctx.strokeStyle = `rgba(112,88,56,${0.06 + R() * 0.09})`;
          ctx.lineWidth = 0.9 + R() * 1.2;
          ctx.beginPath();
          ctx.moveTo(bx + ox, byy);
          ctx.bezierCurveTo(bx + ox + bwi * 0.3, byy + (R() - 0.5) * 6, bx + ox + bwi * 0.7, byy + (R() - 0.5) * 6, bx + ox + bwi, byy);
          ctx.stroke();
        }
        // chipped arris: a bright bare-stone nick on one corner of some stones
        if (R() > 0.55) {
          ctx.fillStyle = `rgba(236,220,188,${0.18 + R() * 0.2})`;
          const cw = 4 + R() * 14;
          ctx.fillRect(R() > 0.5 ? bx + ox : bx + ox + bwi - cw, R() > 0.5 ? by : by + bhi - 4, cw, 3 + R() * 3);
        }
        ctx.restore();
      }
      x += bw;
    }
    // recessed bed joint: dark core + a thin lit arris just below it. 0.30 ->
    // 0.42 for the same reason as the block spread: in a corridor the joint
    // grid is the only edge structure the eye gets.
    ctx.fillStyle = "rgba(94,74,48,0.42)";
    ctx.fillRect(0, y - JOINT * 0.5, N, JOINT);
    ctx.fillStyle = "rgba(236,220,186,0.14)";
    ctx.fillRect(0, y + JOINT * 0.5, N, 1.2);
  }
  grain(ctx, N, N, R, 3200, "rgba(228,208,170,", "rgba(96,74,48,", 0.05, 0.12);
  paintWeatheringTiled(ctx, N, N, seed, 0.15, { blotches: 16, streaks: 6, blooms: 10 });
}

export function sandstoneWallTex(worldM = 4.452, N = 512, seed = 7001): THREE.CanvasTexture {
  return memo(`sandstoneWallTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N);
    paintSandstone(ctx, N, worldM, seed);
    return tex(c);
  });
}

/** BIN 2 — arch brick: fired brick, distinctly finer and warmer than the ashlar
 *  so a doorway surround reads as a different build from the wall it sits in.
 *  Course 0.371 m (worldM/12), stretcher 0.46 m, every 4th course laid soldier
 *  (on end) as a voussoir band. Round-6 drew this at +/-0.12 with no mortar and
 *  it came out a pale wash with random vertical strips. */
export function archBrickTex(worldM = 4.452, N = 512, seed = 7102): THREE.CanvasTexture {
  return memo(`archBrickTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N);
    const px = N / worldM;
    const R = rng(seed);
    const BRICK = "#b98d5e";
    const BRICK_HI = "#c89c68";
    const BRICK_LO = "#a67a4e";
    ctx.fillStyle = "#8e7048"; // mortar
    ctx.fillRect(0, 0, N, N);
    const rows = 12;
    const chPx = N / rows;
    const J = 2.6;
    for (let r = 0; r < rows; r++) {
      const y = r * chPx;
      const soldier = r % 4 === 2;
      let x = -((r * 0.5) % 1) * 0.46 * px;
      while (x < N) {
        const bw = (soldier ? 0.185 : 0.46 + R() * 0.10) * px;
        const base = R() > 0.72 ? BRICK_LO : R() > 0.36 ? BRICK : BRICK_HI;
        ctx.fillStyle = shade(base, (R() - 0.5) * 0.12);
        ctx.fillRect(x + J * 0.5, y + J * 0.5, bw - J, chPx - J);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + J * 0.5, y + J * 0.5, bw - J, chPx - J);
        ctx.clip();
        for (let k = 0; k < 14; k++) {
          ctx.fillStyle = R() > 0.5 ? `rgba(238,214,176,${0.05 + R() * 0.1})` : `rgba(96,66,38,${0.05 + R() * 0.12})`;
          ctx.beginPath();
          ctx.arc(x + R() * bw, y + R() * chPx, 0.8 + R() * 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        x += bw;
      }
      // bed joint shadow, thinner than the ashlar's
      ctx.fillStyle = "rgba(86,64,40,0.34)";
      ctx.fillRect(0, y - J * 0.5, N, J);
    }
    grain(ctx, N, N, R, 2600, "rgba(240,216,176,", "rgba(92,64,38,", 0.04, 0.10);
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { blotches: 20, streaks: 8, blooms: 14 });
    return tex(c);
  });
}

/** BIN 3 — coping / dado band. worldM 1.408, canvas 256x128 -> 181.8 texels/m.
 *  It caps every wall, runs as a dado at the wall base and covers 702 m2 of
 *  sloped roof strip, so it has to read as CUT STONE from both 1 m and 30 m.
 *  Round-6 drew four soft chamfer gradients and it read as vertical planking. */
export function copingTrimTex(worldM = 1.408, W = 256, H = 128, seed = 7203): THREE.CanvasTexture {
  return memo(`copingTrimTex|${worldM}|${W}|${H}|${seed}`, () => {
    const [c, ctx] = canvas(W, H, DETAIL);
    const px = W / worldM;
    const R = rng(seed);
    ctx.fillStyle = "#8d7550"; // joint
    ctx.fillRect(0, 0, W, H);
    // The tile is 1.408 m wide x 0.704 m tall (256x128 at 181.8 texels/m), so 4
    // blocks across gave 0.352 x 0.704 m stones - taller than wide, which is why
    // round-6 read as vertical planking. Two courses of 0.704 x 0.352 m lying
    // blocks in a running bond is the real coping proportion.
    const cols = 2, rowsN = 2;
    const bw = W / cols, bh = H / rowsN;
    const J = 3.2;
    for (let rIdx = 0; rIdx < rowsN; rIdx++)
    for (let i = -1; i <= cols; i++) {
      const x = i * bw + (rIdx % 2 ? bw * 0.5 : 0);
      const yb = rIdx * bh;
      ctx.fillStyle = shade(P.SANDSTONE_HI, (R() - 0.5) * 0.14);
      ctx.fillRect(x + J * 0.5, yb + J * 0.5, bw - J, bh - J);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + J * 0.5, yb + J * 0.5, bw - J, bh - J);
      ctx.clip();
      // pitting + tool marks on the cut face
      for (let k = 0; k < 34; k++) {
        const pr = 1 + R() * 3.2;
        ctx.fillStyle = R() > 0.5 ? `rgba(240,226,196,${0.08 + R() * 0.14})` : `rgba(104,82,54,${0.08 + R() * 0.16})`;
        ctx.beginPath();
        ctx.ellipse(x + R() * bw, yb + R() * bh, pr, pr * (0.5 + R() * 0.6), R() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let k = 0; k < 4; k++) {
        ctx.strokeStyle = `rgba(120,96,62,${0.06 + R() * 0.09})`;
        ctx.lineWidth = 0.8 + R();
        const yy = yb + R() * bh;
        ctx.beginPath();
        ctx.moveTo(x, yy);
        ctx.lineTo(x + bw, yy + (R() - 0.5) * 5);
        ctx.stroke();
      }
      ctx.restore();
      // chipped top arris on some blocks
      if (R() > 0.45) {
        ctx.fillStyle = `rgba(238,222,190,${0.2 + R() * 0.22})`;
        const cw = 5 + R() * 14;
        ctx.fillRect(x + J + R() * Math.max(1, bw - cw - J * 2), yb, cw, 2.5 + R() * 3);
      }
    }
    // top chamfer (lit arris) and bottom drip reveal — a real bevel, painted as
    // VALUE variation, not as a baked light
    const top = ctx.createLinearGradient(0, 0, 0, H * 0.13);
    top.addColorStop(0, "rgba(242,230,202,0.34)");
    top.addColorStop(1, "rgba(242,230,202,0)");
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, H * 0.13);
    const bot = ctx.createLinearGradient(0, H * 0.74, 0, H);
    bot.addColorStop(0, "rgba(72,56,34,0)");
    bot.addColorStop(1, "rgba(72,56,34,0.40)");
    ctx.fillStyle = bot;
    ctx.fillRect(0, H * 0.74, W, H * 0.26);
    grain(ctx, W, H, R, 900, "rgba(240,226,196,", "rgba(104,82,54,", 0.05, 0.11);
    paintWeatheringTiled(ctx, W, H, seed, 0.15, { blotches: 18, streaks: 5, blooms: 6 });
    return tex(c);
  });
}

/** BIN 4 — lime-washed flagstone deck + soffit. worldM 5.631, 512 -> 90.9 tx/m. */
export function adobePlasterTex(worldM = 5.631, N = 512, seed = 7304): THREE.CanvasTexture {
  return memo(`adobePlasterTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N);
    const px = N / worldM;
    const R = rng(seed);
    ctx.fillStyle = P.ADOBE;
    ctx.fillRect(0, 0, N, N);
    // 1.4 m flags in a running bond
    const fs = 1.4076 * px; // 5.631/4
    for (let r = 0; r < 4; r++)
      for (let cIdx = -1; cIdx < 5; cIdx++) {
        const x = cIdx * fs + (r % 2 ? fs * 0.5 : 0);
        const y = r * fs;
        // +/-0.09 -> +/-0.16: this bin is 1472 m2 of interior floor and 742 m2
        // of roofed soffit, i.e. most of what a player sees indoors, and at
        // +/-0.09 the deck rendered as one flat grey slab (spec-art §8 flaw 11
        // was only half-fixed).
        ctx.fillStyle = shade(P.ADOBE, (R() - 0.5) * 0.16);
        ctx.fillRect(x + 2, y + 2, fs - 4, fs - 4);
        const g = ctx.createRadialGradient(x + fs * 0.4, y + fs * 0.4, 2, x + fs * 0.5, y + fs * 0.5, fs * 0.8);
        g.addColorStop(0, `rgba(255,250,236,${0.03 + R() * 0.05})`);
        g.addColorStop(1, `rgba(120,96,62,${0.03 + R() * 0.06})`);
        ctx.fillStyle = g;
        ctx.fillRect(x + 2, y + 2, fs - 4, fs - 4);
      }
    // flag joints: a dark recess with a lit arris beside it. Round-1 drew them at
    // 0.40 alpha and 3 px and the deck read as one grey smear at 4 m.
    for (let r = 0; r <= 4; r++) {
      ctx.fillStyle = "rgba(104,84,54,0.72)";
      ctx.fillRect(0, r * fs - 2, N, 4);
      ctx.fillStyle = "rgba(244,234,212,0.20)";
      ctx.fillRect(0, r * fs + 2, N, 1.6);
    }
    for (let r = 0; r < 4; r++)
      for (let cIdx = -1; cIdx < 5; cIdx++) {
        const jx = cIdx * fs + (r % 2 ? fs * 0.5 : 0);
        ctx.fillStyle = "rgba(104,84,54,0.72)";
        ctx.fillRect(jx - 2, r * fs, 4, fs);
        ctx.fillStyle = "rgba(244,234,212,0.18)";
        ctx.fillRect(jx + 2, r * fs, 1.6, fs);
      }
    // trowel skim: long low-contrast strokes so the plaster reads at 2 m
    for (let i = 0; i < 120; i++) {
      const x = R() * N, y = R() * N;
      const a = R() * Math.PI;
      ctx.strokeStyle = R() > 0.5 ? "rgba(255,248,230,0.05)" : "rgba(120,98,64,0.06)";
      ctx.lineWidth = 2 + R() * 8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + Math.cos(a) * 40, y + Math.sin(a) * 26, x + Math.cos(a) * 90, y + Math.sin(a) * 40);
      ctx.stroke();
    }
    // hairline cracks + spalled patches showing the adobe beneath
    for (let i = 0; i < 12; i++) {
      ctx.strokeStyle = `rgba(122,98,64,${0.07 + R() * 0.07})`;
      ctx.lineWidth = 0.8 + R();
      ctx.beginPath();
      let x = R() * N, y = R() * N;
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (R() - 0.5) * 34;
        y += (R() - 0.5) * 34;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 16; i++) {
      const x = R() * N, y = R() * N, r = 6 + R() * 22;
      ctx.fillStyle = `rgba(168,138,92,${0.14 + R() * 0.14})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.5 + R() * 0.5), R() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // exposed aggregate + foot polish: round-3 rendered this deck as blank
    // grey-blue concrete because nothing above the joint scale existed on it
    for (let i = 0; i < 1500; i++) {
      const x = R() * N, y = R() * N;
      const lit = R() > 0.5;
      ctx.fillStyle = lit ? `rgba(246,236,214,${0.07 + R() * 0.10})` : `rgba(122,98,64,${0.07 + R() * 0.11})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.7 + R() * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 150; i++) {
      const x = R() * N, y = R() * N, r = 8 + R() * 40;
      for (const ox of [-N, 0, N])
        for (const oy of [-N, 0, N]) {
          const g2 = ctx.createRadialGradient(x + ox, y + oy, 1, x + ox, y + oy, r);
          g2.addColorStop(0, R() > 0.5 ? "rgba(240,228,202,0.06)" : "rgba(126,102,66,0.07)");
          g2.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = g2;
          ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
        }
    }
    grain(ctx, N, N, R, 3000, "rgba(250,242,222,", "rgba(112,90,58,", 0.05, 0.12);
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { streaks: 8, blooms: 10 });
    return tex(c);
  });
}

/** BIN 5 — cobble setts. worldM 6.502, 512 -> 78.7 texels/m, sett 0.295 m in a
 *  running bond with a 8 %-of-sett joint. Round-1 drew jittered discs at 0.22
 *  jitter and they read as coins on tarmac; a real sett road is a REGULAR grid
 *  whose regularity is what tells the eye the scale. */
export function cobbleFloorTex(worldM = 6.502, N = 512, seed = 7405): THREE.CanvasTexture {
  return memo(`cobbleFloorTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N);
    const R = rng(seed);
    ctx.fillStyle = P.COBBLE_JOINT;
    ctx.fillRect(0, 0, N, N);
    const n = 22;
    const sett = N / n;                 // 0.2955 m
    const JOINT = sett * 0.10;
    const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
    };
    for (let r = 0; r < n; r++) {
      const off = r % 2 ? sett * 0.5 : 0;
      for (let k = -1; k <= n; k++) {
        const jx = (R() - 0.5) * sett * 0.06;
        const jy = (R() - 0.5) * sett * 0.06;
        const x = k * sett + off + JOINT * 0.5 + jx;
        const y = r * sett + JOINT * 0.5 + jy;
        const w = sett - JOINT, h = sett - JOINT;
        const base = R() > 0.80 ? P.COBBLE_LO : R() > 0.45 ? P.COBBLE_HI : P.COBBLE;
        ctx.fillStyle = shade(base, (R() - 0.5) * 0.14);
        roundRect(x, y, w, h, sett * 0.26);
        // one soft tonal sweep per sett so it is not a flat chip
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        const g = ctx.createRadialGradient(x + w * 0.38, y + h * 0.34, 1, x + w * 0.5, y + h * 0.5, w * 0.9);
        g.addColorStop(0, `rgba(240,224,192,${0.06 + R() * 0.09})`);
        g.addColorStop(1, `rgba(74,58,36,${0.06 + R() * 0.10})`);
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
        for (let q = 0; q < 8; q++) {
          ctx.fillStyle = R() > 0.5 ? `rgba(232,214,180,${0.05 + R() * 0.08})` : `rgba(88,68,44,${0.05 + R() * 0.09})`;
          ctx.beginPath();
          ctx.arc(x + R() * w, y + R() * h, 0.7 + R() * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
    // sand blown into the joints: wrap-safe, low contrast, keeps the setts readable
    for (let i = 0; i < 220; i++) {
      const x = R() * N, y = R() * N, r = 6 + R() * 26;
      for (const ox of [-N, 0, N])
        for (const oy of [-N, 0, N]) {
          const g = ctx.createRadialGradient(x + ox, y + oy, 1, x + ox, y + oy, r);
          g.addColorStop(0, `rgba(214,187,140,${0.07 + R() * 0.10})`);
          g.addColorStop(1, "rgba(214,187,140,0)");
          ctx.fillStyle = g;
          ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
        }
    }
    grain(ctx, N, N, R, 2600, "rgba(226,204,164,", "rgba(88,70,46,");
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { streaks: 8, blooms: 10 });
    return tex(c);
  });
}

/** BIN 6 — sand floor. worldM 3.251, 512 -> 157.5 texels/m. jungleDirtTex mould. */
export function sandFloorTex(worldM = 3.251, N = 512, seed = 4111, fine = false): THREE.CanvasTexture {
  return memo(`sandFloorTex|${worldM}|${N}|${seed}|${fine}`, () => {
    const [c, ctx] = canvas(N, N);
    const R = rng(seed);
    ctx.fillStyle = fine ? P.DUST_FINE : P.DUST_FLOOR;
    ctx.fillRect(0, 0, N, N);
    // jt:53-66 blotch pass, wrap-safe by construction
    for (let i = 0; i < 110; i++) {
      const x = R() * N, y = R() * N, r = (14 + R() * 44) * (N / 512);
      const dark = R() > 0.5;
      ctx.fillStyle = dark ? "rgba(138,110,68,0.22)" : "rgba(232,210,170,0.18)";
      for (const ox of [-N, 0, N])
        for (const oy of [-N, 0, N]) {
          ctx.beginPath();
          ctx.ellipse(x + ox, y + oy, r, r * (0.5 + R() * 0.5), R() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }
    }
    // wind ripples: long, very low contrast, one dominant direction
    const dir = 0.42;
    for (let i = 0; i < 70; i++) {
      const y = R() * N;
      ctx.strokeStyle = R() > 0.5 ? "rgba(242,224,190,0.09)" : "rgba(138,112,70,0.09)";
      ctx.lineWidth = 2 + R() * 7;
      ctx.beginPath();
      for (let x = -20; x < N + 20; x += 16) {
        const yy = y + Math.sin((x / N) * Math.PI * 2 + i) * 9 + x * dir * 0.06;
        if (x === -20) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    grain(ctx, N, N, R, 3400, "rgba(244,226,190,", "rgba(120,94,60,", 0.05, 0.13);
    // pebbles (jt:141-158) — near-field detail so the ground holds at 1-3 m
    for (let i = 0; i < 1400; i++) {
      const x = R() * N, y = R() * N;
      const lit = R() > 0.5;
      ctx.fillStyle = lit ? `rgba(238,218,182,${0.16 + R() * 0.18})` : `rgba(112,88,56,${0.16 + R() * 0.18})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + R() * 2.0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = `rgba(126,102,68,${0.1 + R() * 0.12})`;
      ctx.lineWidth = 0.8 + R();
      ctx.beginPath();
      let x = R() * N, y = R() * N;
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (R() - 0.5) * 40;
        y += (R() - 0.5) * 40;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // dry scrub specks: the desert dose of the jungle's grass tufts
    for (let i = 0; i < 26; i++) {
      const x = R() * N, y = R() * N;
      ctx.strokeStyle = `${P.MOSS}${(0.14 + R() * 0.12).toFixed(2)})`;
      ctx.lineWidth = 1.2;
      for (let b = 0; b < 5; b++) {
        const a = -Math.PI / 2 + (R() - 0.5) * 1.2;
        ctx.beginPath();
        ctx.moveTo(x + (R() - 0.5) * 7, y + (R() - 0.5) * 5);
        ctx.lineTo(x + Math.cos(a) * (4 + R() * 6), y + Math.sin(a) * (4 + R() * 6));
        ctx.stroke();
      }
    }
    return tex(c);
  });
}

/** BIN 7 — sun-bleached plank boards (floors, catwalks, shuttered panels).
 *  worldM 1.626, 512 -> 315 texels/m; board 0.203 m = 1.626/8. */
export function plankWoodTex(worldM = 1.626, N = 512, seed = 5150): THREE.CanvasTexture {
  return memo(`plankWoodTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, DETAIL);
    const px = N / worldM;
    const R = rng(seed);
    ctx.fillStyle = P.WOOD_SUN;
    ctx.fillRect(0, 0, N, N);
    const bw = (worldM / 8) * px;
    for (let i = 0; i < 8; i++) {
      const x = i * bw;
      ctx.fillStyle = shade(i % 2 ? P.WOOD_SUN_ALT : P.WOOD_SUN, (R() - 0.5) * 0.26);
      ctx.fillRect(x, 0, bw - 2, N);
      ctx.fillStyle = "rgba(38,26,14,0.72)";
      ctx.fillRect(x + bw - 2.6, 0, 3.4, N);
      ctx.fillStyle = "rgba(224,204,166,0.14)";
      ctx.fillRect(x + bw + 0.8, 0, 1.4, N);
      // grain
      ctx.strokeStyle = "rgba(58,42,24,0.34)";
      ctx.lineWidth = 1.3;
      for (let g = 0; g < 9; g++) {
        const gx = x + 3 + R() * (bw - 8);
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.bezierCurveTo(gx + (R() - 0.5) * 8, N * 0.3, gx + (R() - 0.5) * 8, N * 0.7, gx, N);
        ctx.stroke();
      }
      // knots
      if (R() > 0.55) {
        const ky = R() * N;
        ctx.strokeStyle = "rgba(84,60,32,0.5)";
        ctx.lineWidth = 2;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.ellipse(x + bw * 0.5, ky, 3 + k * 3, 2 + k * 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    // iron cross-straps once per tile + nail heads (galvanised trim palette)
    for (const ty of [0.18, 0.78]) {
      const y = ty * N;
      ctx.fillStyle = "rgba(132,125,106,0.72)";
      ctx.fillRect(0, y, N, 0.055 * px);
      ctx.fillStyle = "rgba(232,226,206,0.20)";
      ctx.fillRect(0, y, N, 2);
      ctx.fillStyle = "rgba(46,40,30,0.45)";
      ctx.fillRect(0, y + 0.055 * px - 2, N, 2);
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = "rgba(52,44,32,0.7)";
        ctx.beginPath();
        ctx.arc((i + 0.5) * (N / 8), y + 0.027 * px, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    grain(ctx, N, N, R, 1600, "rgba(226,206,168,", "rgba(72,54,32,");
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { blotches: 110, streaks: 12, blooms: 14 });
    return tex(c);
  });
}

/** BIN 9 — crate boards. worldM 2.438 (exactly one source crate face).
 *  NO wordmark: text in a TILING material is the review-r3 failure. The kong
 *  stencil goes on decal quads in Phase 3. */
export function crateWoodTex(worldM = 2.438, N = 512, seed = 2210): THREE.CanvasTexture {
  return memo(`crateWoodTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, DETAIL);
    const px = N / worldM;
    const R = rng(seed);
    ctx.fillStyle = P.CRATE;
    ctx.fillRect(0, 0, N, N);
    const rows = 5;
    const bh = N / rows;
    for (let i = 0; i < rows; i++) {
      const y = i * bh;
      ctx.fillStyle = i % 2 ? P.CRATE_A : P.CRATE_B;
      ctx.fillRect(0, y, N, bh - 4);
      ctx.fillStyle = "rgba(60,44,24,0.55)";
      ctx.fillRect(0, y + bh - 4, N, 4);
      ctx.strokeStyle = "rgba(120,92,50,0.35)";
      ctx.lineWidth = 1.6;
      for (let g = 0; g < 6; g++) {
        const gy = y + 10 + R() * (bh - 20);
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.bezierCurveTo(N * 0.3, gy + (R() - 0.5) * 10, N * 0.7, gy + (R() - 0.5) * 10, N, gy);
        ctx.stroke();
      }
    }
    // corner posts at both tile edges: one crate face = one tile, so the posts
    // land on the crate's real corners
    ctx.fillStyle = P.CRATE_POST;
    ctx.fillRect(0, 0, 0.14 * px, N);
    ctx.fillRect(N - 0.14 * px, 0, 0.14 * px, N);
    // diagonal brace (the source crate's X), painted as boards not as shading
    ctx.save();
    ctx.strokeStyle = "rgba(150,118,66,0.55)";
    ctx.lineWidth = 0.12 * px;
    ctx.beginPath();
    ctx.moveTo(0.16 * px, 0.16 * px);
    ctx.lineTo(N - 0.16 * px, N - 0.16 * px);
    ctx.moveTo(N - 0.16 * px, 0.16 * px);
    ctx.lineTo(0.16 * px, N - 0.16 * px);
    ctx.stroke();
    ctx.restore();
    grain(ctx, N, N, R, 1400, "rgba(232,212,170,", "rgba(84,62,34,");
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { blotches: 100, streaks: 10, blooms: 12 });
    return tex(c);
  });
}

/** BIN 11 — stratified sandstone cliff. worldM 7.075, 512 -> 72.4 texels/m.
 *  Round-6 drew 9 continuous strata at +/-0.10 value and the NW cliff behind B
 *  rendered as a giant plank ramp. Strata are now broken by vertical jointing
 *  into blocky spalls, the band contrast is halved, and the hue is pulled toward
 *  the wall sandstone so the cliff belongs to the same rock as the town. */
export function rockCliffTex(worldM = 7.075, N = 512, seed = 8811): THREE.CanvasTexture {
  return memo(`rockCliffTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N);
    const R = rng(seed);
    ctx.fillStyle = P.CLIFF;
    ctx.fillRect(0, 0, N, N);
    // strata bands, wobbling, low contrast
    let y = 0;
    const bandY = [];
    for (let i = 0; y < N; i++) {
      const h = N * (0.05 + R() * 0.07);
      bandY.push(y);
      ctx.fillStyle = shade(i % 3 === 0 ? P.CLIFF_HI : i % 3 === 1 ? P.CLIFF : P.CLIFF_LO, (R() - 0.5) * 0.07);
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= N; x += N / 10) ctx.lineTo(x, y + Math.sin((x / N) * Math.PI * 2 + i) * (N * 0.010));
      ctx.lineTo(N, y + h);
      for (let x = N; x >= 0; x -= N / 10) ctx.lineTo(x, y + h + Math.sin((x / N) * Math.PI * 2 + i + 1) * (N * 0.010));
      ctx.closePath();
      ctx.fill();
      y += h;
    }
    /**
     * STRATA-FORWARD JOINTING (fix-round-3 order 8b).
     *
     * The round-2 version chopped every band into opaque blocks with a +-0.24
     * value spread and drew each joint as a 2.5-5 px dark bar running the full
     * band height, then laid 18 fractures of 1.5-5 px across the whole tile.
     * From an aerial camera that reads as rock; from the ground at B site it
     * reads as what the judge photographed — "stacked boxes with dark wandering
     * streaks" (public/dustmap/shots/judge-r2/offender-sand-bsite.png) — because
     * every block is a rectangle of its own value and every joint is a hard
     * vertical line at the same weight, so the eye assembles a masonry grid.
     *
     * A rock face is BEDDING first and jointing second. So:
     *  - each block now varies around ITS OWN BAND's value (+-0.09) instead of
     *    picking freely from the three-colour ramp: the horizontal layer stays
     *    a layer and the blocks are texture inside it, not tiles of it;
     *  - joints are thinner, lighter and STOP SHORT of the band edges, so they
     *    read as fissures in a layer rather than mortar between bricks;
     *  - a bedding line is drawn along each band boundary, which is the feature
     *    the eye should be finding;
     *  - the through-tile fractures drop 18 -> 9, run at half the old weight and
     *    terminate inside the tile, so no single streak crosses the whole face.
     */
    for (let bi = 0; bi < bandY.length; bi++) {
      const y0 = bandY[bi];
      const h = (bandY[bi + 1] ?? N) - y0;
      const bandBase = bi % 3 === 0 ? P.CLIFF_HI : bi % 3 === 1 ? P.CLIFF : P.CLIFF_LO;
      let x = -R() * N * 0.2;
      while (x < N) {
        const w = N * (0.06 + R() * 0.14);
        ctx.fillStyle = shade(bandBase, (R() - 0.5) * 0.09);
        ctx.fillRect(x + 1.5, y0 + 1.5, w - 3, h - 3);
        // spalled step: knock the top corner off some blocks, gently
        if (R() > 0.65) {
          ctx.fillStyle = shade(bandBase, -0.05 - R() * 0.07);
          ctx.fillRect(x + 1.5, y0 + 1.5, (w - 3) * (0.3 + R() * 0.5), (h - 3) * (0.25 + R() * 0.4));
        }
        // fissure, not mortar: thin, low alpha, inset from both band edges
        const inset = h * (0.10 + R() * 0.16);
        ctx.fillStyle = `rgba(66,48,30,${0.12 + R() * 0.10})`;
        ctx.fillRect(x, y0 + inset, 1 + R() * 1.4, h - inset * 2);
        x += w;
      }
      // bedding line along the band's own top edge — the feature that should read
      ctx.strokeStyle = `rgba(96,74,50,${0.16 + R() * 0.10})`;
      ctx.lineWidth = 1 + R() * 1.2;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      for (let xx = 0; xx <= N; xx += N / 10) ctx.lineTo(xx, y0 + Math.sin((xx / N) * Math.PI * 2 + bi) * (N * 0.010));
      ctx.stroke();
    }
    // deep fractures: half as many, half the weight, and none crosses the tile
    for (let i = 0; i < 9; i++) {
      ctx.strokeStyle = `rgba(74,54,34,${0.10 + R() * 0.10})`;
      ctx.lineWidth = 1 + R() * 1.8;
      let x = R() * N;
      let yy = R() * N * 0.45;
      const end = yy + N * (0.25 + R() * 0.35);
      ctx.beginPath();
      ctx.moveTo(x, yy);
      while (yy < end) {
        yy += N * 0.1;
        x += (R() - 0.5) * 16;
        ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // spalled faces + talus speckle
    for (let i = 0; i < 46; i++) {
      const x = R() * N, yy = R() * N, r = 8 + R() * 30;
      ctx.fillStyle = R() > 0.5 ? `rgba(206,178,132,${0.09 + R() * 0.11})` : `rgba(92,70,46,${0.09 + R() * 0.11})`;
      ctx.beginPath();
      ctx.ellipse(x, yy, r, r * (0.35 + R() * 0.4), R() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    grain(ctx, N, N, R, 3000, "rgba(220,196,152,", "rgba(84,64,42,", 0.05, 0.13);
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { blotches: 24, streaks: 8, blooms: 12 });
    return tex(c);
  });
}

/** BIN 12 — green supply-box steel. worldM 1.626, 256 -> 157.5 texels/m. */
export function metalPanelTex(worldM = 1.626, N = 256, seed = 6120, hazard = false): THREE.CanvasTexture {
  return memo(`metalPanelTex|${worldM}|${N}|${seed}|${hazard}`, () => {
    const [c, ctx] = canvas(N, N, 2);
    const px = N / worldM;
    const R = rng(seed);
    ctx.fillStyle = P.METAL_GREEN_SUN;
    ctx.fillRect(0, 0, N, N);
    // ribs at 0.203 m pitch (jt paintCorrugationShading, pitch converted to metres)
    paintCorrugationShading(ctx, N, N, 0.07, (worldM / 8) * px);
    // welded seams + rivets
    ctx.fillStyle = "rgba(28,38,22,0.45)";
    ctx.fillRect(0, N * 0.5 - 1.5, N, 3);
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = "rgba(226,226,206,0.16)";
      ctx.beginPath();
      ctx.arc((i + 0.5) * (N / 10), N * 0.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (hazard) {
      // jt:318-332 hazard band, chevrons at 0.09 m pitch
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, N * 0.70, N, N * 0.16);
      ctx.clip();
      ctx.fillStyle = "rgba(214,178,60,0.55)";
      const pitch = 0.088 * px;
      for (let x = -N; x < N * 2; x += pitch * 2) {
        ctx.beginPath();
        ctx.moveTo(x, N * 0.86);
        ctx.lineTo(x + pitch, N * 0.86);
        ctx.lineTo(x + pitch + N * 0.16, N * 0.70);
        ctx.lineTo(x + N * 0.16, N * 0.70);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = "rgba(30,36,22,0.5)";
      ctx.fillRect(0, N * 0.695, N, 2);
      ctx.fillRect(0, N * 0.858, N, 2);
    }
    grain(ctx, N, N, R, 900, "rgba(216,222,190,", "rgba(38,50,28,");
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { blotches: 90, streaks: 14, blooms: 16 });
    return tex(c);
  });
}

/** BIN 12b — rusted steel fixture (lamp brackets, jambs). */
export function rustSteelTex(worldM = 1.626, N = 128, seed = 6231): THREE.CanvasTexture {
  return memo(`rustSteelTex|${worldM}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, 2);
    const R = rng(seed);
    ctx.fillStyle = P.METAL_RUST;
    ctx.fillRect(0, 0, N, N);
    grain(ctx, N, N, R, 700, "rgba(196,150,104,", "rgba(52,36,22,", 0.05, 0.14);
    paintWeatheringTiled(ctx, N, N, seed, 0.15, { blotches: 60, streaks: 18, blooms: 26 });
    return tex(c);
  });
}

/** BIN 12c — fluorescent tube (the one emissive surface in the map). */
export function tubeTex(N = 64, seed = 6332): THREE.CanvasTexture {
  return memo(`tubeTex|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N / 4, N, 2);
    const w = N / 4;
    ctx.fillStyle = P.TUBE;
    ctx.fillRect(0, 0, w, N);
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, "rgba(180,176,160,0.5)");
    g.addColorStop(0.5, "rgba(255,252,240,0)");
    g.addColorStop(1, "rgba(180,176,160,0.5)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, N);
    ctx.fillStyle = "rgba(90,86,74,0.7)";
    ctx.fillRect(0, 0, w, N * 0.06);
    ctx.fillRect(0, N * 0.94, w, N * 0.06);
    return tex(c);
  });
}

// ------------------------------------------------------------- BIN 8: doors --
/**
 * TWO self-contained leaves per 0..1 tile.
 *
 * Why not one arch-topped double door filling the tile (round 2): the source
 * meshes crop this texture at HALF-tile boundaries — the circled-B door quad is
 * u 12.5..13, the circled-A door is u -3.5..-3 — so a single centred door image
 * gets sliced down the middle and the mark is cut in half. Mirroring a complete
 * leaf into each half makes every legal crop (0..1, 0..0.5, 0.5..1, or N tiles
 * of any of them) read as whole doors. The wayfinding mark goes on the RIGHT
 * leaf so a half-tile crop still shows exactly one of it.
 *
 * mark: null | "A" | "B" | "EXIT"
 */
export function woodDoorTex(mark: string | null = null, N = 512, seed = 3311): THREE.CanvasTexture {
  return memo(`woodDoorTex|${mark}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, DETAIL);
    const R = rng(seed);
    // stone reveal behind the leaves
    ctx.fillStyle = shade(P.SANDSTONE, -0.16);
    ctx.fillRect(0, 0, N, N);
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = R() > 0.5 ? `rgba(226,206,168,${0.05 + R() * 0.09})` : `rgba(112,88,56,${0.05 + R() * 0.1})`;
      ctx.fillRect(R() * N, R() * N, 2 + R() * 9, 2 + R() * 5);
    }
    const leaf = (x0: number, w: number, withMark: boolean) => {
      const y0 = N * 0.03, hh = N * 0.97;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, w, hh);
      ctx.clip();
      ctx.fillStyle = P.WOOD_DOOR;
      ctx.fillRect(x0, y0, w, hh);
      const nb = 6;
      for (let i = 0; i < nb; i++) {
        const x = x0 + (i * w) / nb;
        ctx.fillStyle = shade(i % 2 ? P.WOOD_DOOR : P.WOOD_DOOR_ALT, (R() - 0.5) * 0.14);
        ctx.fillRect(x, y0, w / nb - 2, hh);
        ctx.fillStyle = "rgba(24,16,8,0.55)";
        ctx.fillRect(x + w / nb - 2, y0, 2.6, hh);
        ctx.strokeStyle = "rgba(38,26,14,0.32)";
        ctx.lineWidth = 1.2;
        for (let g = 0; g < 5; g++) {
          const gx = x + 3 + R() * (w / nb - 8);
          ctx.beginPath();
          ctx.moveTo(gx, y0);
          ctx.bezierCurveTo(gx + (R() - 0.5) * 6, N * 0.35, gx + (R() - 0.5) * 6, N * 0.7, gx, y0 + hh);
          ctx.stroke();
        }
      }
      // iron straps + studs
      for (const ty of [0.18, 0.52, 0.86]) {
        const y = y0 + hh * ty;
        ctx.fillStyle = "rgba(118,110,92,0.88)";
        ctx.fillRect(x0, y, w, N * 0.035);
        ctx.fillStyle = "rgba(226,220,200,0.20)";
        ctx.fillRect(x0, y, w, 2);
        ctx.fillStyle = "rgba(30,24,16,0.55)";
        ctx.fillRect(x0, y + N * 0.035 - 2, w, 2);
        for (let i = 0; i < 5; i++) {
          ctx.fillStyle = "rgba(38,32,22,0.8)";
          ctx.beginPath();
          ctx.arc(x0 + (i + 0.5) * (w / 5), y + N * 0.0175, 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // ring handle on the inner edge
      ctx.strokeStyle = "rgba(132,125,106,0.92)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(x0 + w * (withMark ? 0.14 : 0.86), y0 + hh * 0.52, N * 0.032, 0, Math.PI * 2);
      ctx.stroke();
      paintWeathering(ctx, N, N, seed + (withMark ? 7 : 0), 0.15);
      // stone lintel over the leaf
      ctx.fillStyle = shade(P.SANDSTONE, 0.02);
      ctx.fillRect(x0, 0, w, y0);
      if (withMark && mark) {
        ctx.save();
        ctx.translate(x0 + w * 0.5, y0 + hh * 0.5);
        if (mark === "EXIT") {
          ctx.font = `700 ${Math.round(N * 0.11)}px ${FONT_COND}`;
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(245,238,218,0.88)";
          ctx.fillText("EXIT", 0, N * 0.04);
          bananaArc(ctx, 0, -N * 0.07, N * 0.075, N * 0.022, "rgba(240,214,100,0.55)");
        } else {
          ctx.strokeStyle = "rgba(168,72,54,0.95)";
          ctx.lineWidth = N * 0.022;
          ctx.beginPath();
          ctx.ellipse(0, 0, N * 0.12, N * 0.155, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.font = `700 ${Math.round(N * 0.22)}px ${FONT_BLACK}`;
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(168,72,54,0.96)";
          ctx.fillText(mark, 0, N * 0.08);
        }
        ctx.restore();
      }
      ctx.restore();
    };
    const gap = N * 0.018;
    leaf(gap, N * 0.5 - gap * 1.5, false);
    leaf(N * 0.5 + gap * 0.5, N * 0.5 - gap * 1.5, true);
    // centre seam + outer jambs
    ctx.fillStyle = "rgba(30,22,12,0.55)";
    ctx.fillRect(N * 0.5 - gap * 0.5, 0, gap, N);
    return tex(c);
  });
}

/**
 * ------------------------------------- ARCHED WINDOW DECAL (long A) ---------
 * fix-ship-polish order 5. The source's long-A east building carries a row of
 * THREE arched windows and its centre pillar one more, and every one of them
 * lives in the CS 1.6 diffuse map, not in the geometry
 * (`public/dustmap/shots/judge-r3/long-a-before.png` against `-after.png`;
 * `docs/dustmap/spec-art.md` §8 recorded the loss and deferred the fix). The
 * reskin is albedo-only procedural canvas, the wall bins tile, and a tiling
 * texture cannot hold a one-off landmark — so the openings come back the way
 * the crate stencils already do: one alpha-tested decal quad per opening,
 * `solid:false` so neither the collider audit nor the traverse render-truth set
 * has to explain it, placed at positions unprojected from the source frame
 * (`qa/x/r4/unproject.mjs`).
 *
 * The card is an OPENING, not a picture of one: a splayed sandstone reveal, an
 * eleven-stone voussoir ring over five jamb stones a side, a projecting sill,
 * and inside them a
 * shuttered dark that is deliberately kept ABOVE `P.INK` — the darkgate albedo
 * floor — with a warm bounce along the sill, because a window painted at true
 * black is exactly the "region goes black" signature that gate exists to catch.
 */
export function archWindowTex(N = 512, seed = 3411): THREE.CanvasTexture {
  return memo(`archWindowTex|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, 1);
    const R = rng(seed);
    ctx.clearRect(0, 0, N, N);
    // --- geometry of the opening, in canvas units
    const MX = N * 0.09;                    // outer margin: bare wall, stays transparent
    const OX0 = N * 0.22, OX1 = N * 0.78;   // opening left / right
    const OY1 = N * 0.90;                   // sill line
    const SPRING = N * 0.48;                // where the arch springs from
    const RAD = (OX1 - OX0) / 2;
    const arch = (x0: number, x1: number, yBot: number, ySpring: number): void => {
      const r = (x1 - x0) / 2;
      ctx.beginPath();
      ctx.moveTo(x0, yBot);
      ctx.lineTo(x0, ySpring);
      ctx.arc((x0 + x1) / 2, ySpring, r, Math.PI, 0);
      ctx.lineTo(x1, yBot);
      ctx.closePath();
    };
    // --- 1. the surround: a stone frame a little wider than the opening -----
    ctx.save();
    arch(OX0 - N * 0.11, OX1 + N * 0.11, OY1 + N * 0.055, SPRING + N * 0.03);
    ctx.clip();
    ctx.fillStyle = shade(P.SANDSTONE, -0.07);
    ctx.fillRect(0, 0, N, N);
    // voussoirs around the head, laid on end
    const CX2 = (OX0 + OX1) / 2;
    for (let i = 0; i < 11; i++) {
      const a0 = Math.PI + (i / 11) * Math.PI, a1 = Math.PI + ((i + 1) / 11) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(CX2 + Math.cos(a0) * RAD, SPRING + Math.sin(a0) * RAD);
      ctx.arc(CX2, SPRING, RAD + N * 0.115, a0, a1);
      ctx.lineTo(CX2 + Math.cos(a1) * RAD, SPRING + Math.sin(a1) * RAD);
      ctx.arc(CX2, SPRING, RAD, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = shade(P.SANDSTONE, -0.07 + (R() - 0.5) * 0.16);
      ctx.fill();
      ctx.strokeStyle = "rgba(94,74,48,0.42)";
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
    // jamb stones down both sides
    for (let i = 0; i < 5; i++) {
      const y = SPRING + (i / 5) * (OY1 - SPRING);
      const h = (OY1 - SPRING) / 5;
      for (const [jx0, jw] of [[OX0 - N * 0.11, N * 0.11], [OX1, N * 0.11]] as const) {
        ctx.fillStyle = shade(P.SANDSTONE, -0.08 + (R() - 0.5) * 0.16);
        ctx.fillRect(jx0, y, jw, h);
        ctx.strokeStyle = "rgba(94,74,48,0.4)";
        ctx.lineWidth = 2;
        ctx.strokeRect(jx0, y, jw, h);
      }
    }
    grain(ctx, N, N, R, 1400, "rgba(228,208,170,", "rgba(96,74,48,", 0.05, 0.16);
    paintWeathering(ctx, N, N, seed + 3, 0.12);
    // the frame is old stone in a dusty wall, not fresh limestone: warm it down
    // so it sits inside the sandstone family instead of above it
    ctx.fillStyle = "rgba(150,116,70,0.24)";
    ctx.fillRect(0, 0, N, N);
    ctx.restore();
    // --- 2. the opening itself ---------------------------------------------
    ctx.save();
    arch(OX0, OX1, OY1, SPRING);
    ctx.clip();
    // Never below P.INK: the reveal is in shade, not in the void. Top of the
    // opening is the deepest, the sill catches a warm bounce.
    const g = ctx.createLinearGradient(0, SPRING - RAD, 0, OY1);
    g.addColorStop(0, "#39322a");
    g.addColorStop(0.55, "#453a2c");
    g.addColorStop(1, "#5a4a34");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
    // shutter boards behind the reveal, the source's barred/boarded look
    const bw = (OX1 - OX0) / 6;
    for (let i = 0; i < 6; i++) {
      const x = OX0 + i * bw;
      ctx.fillStyle = shade(i % 2 ? "#4a3d2c" : "#413526", (R() - 0.5) * 0.16);
      ctx.fillRect(x + 1.5, 0, bw - 3, N);
      ctx.fillStyle = "rgba(28,22,14,0.42)";
      ctx.fillRect(x + bw - 3, 0, 2.4, N);
    }
    // two iron bars across, catching a little light
    for (const ty of [0.34, 0.72]) {
      const y = SPRING - RAD + ty * (OY1 - (SPRING - RAD));
      ctx.fillStyle = "rgba(92,84,68,0.62)";
      ctx.fillRect(0, y, N, N * 0.019);
      ctx.fillStyle = "rgba(210,200,176,0.10)";
      ctx.fillRect(0, y, N, 1.4);
    }
    // the splay: the reveal is a metre deep, so both jambs and the head carry a
    // lit edge on the sun side and a soft shadow on the other
    const sp = ctx.createLinearGradient(OX0, 0, OX1, 0);
    sp.addColorStop(0, "rgba(236,220,186,0.30)");
    sp.addColorStop(0.32, "rgba(236,220,186,0.0)");
    sp.addColorStop(1, "rgba(30,24,16,0.34)");
    ctx.fillStyle = sp;
    ctx.fillRect(0, 0, N, N);
    ctx.restore();
    // --- 3. sill ------------------------------------------------------------
    ctx.fillStyle = shade(P.SANDSTONE, -0.02);
    ctx.fillRect(OX0 - N * 0.135, OY1, OX1 - OX0 + N * 0.27, N * 0.055);
    ctx.fillStyle = "rgba(236,220,186,0.16)";
    ctx.fillRect(OX0 - N * 0.135, OY1, OX1 - OX0 + N * 0.27, 2.4);
    ctx.fillStyle = "rgba(52,40,24,0.34)";
    ctx.fillRect(OX0 - N * 0.135, OY1 + N * 0.055 - 3, OX1 - OX0 + N * 0.27, 3);
    // dust wash bleeding down from the sill onto the wall below
    const wash = ctx.createLinearGradient(0, OY1 + N * 0.055, 0, N - MX * 0.2);
    wash.addColorStop(0, "rgba(120,98,64,0.26)");
    wash.addColorStop(1, "rgba(120,98,64,0)");
    ctx.fillStyle = wash;
    ctx.fillRect(OX0 - N * 0.10, OY1 + N * 0.055, OX1 - OX0 + N * 0.20, N * 0.09);
    // The card is a cut-out: everything painted above is opaque, the rest is
    // gone. The premultiplied-canvas lesson from `crestTreatment` applies here
    // too — an alpha-0 texel reads back BLACK, so bilinear magnification at the
    // alphaTest edge would blend the sandstone surround with black and rim the
    // whole decal dark. `colourBleed` pushes the surround's own colour outward
    // at an alpha far under the 0.42 test, which is what makes the cut clean.
    colourBleed(ctx, N, N, Math.round(N * 0.05), 10);
    return tex(c, false);
  });
}

// ------------------------------------------------------- BIN 13: bomb-X decal
/**
 * Transparent spray decal on its own quad, lifted 5 mm off the floor.
 * alphaTest + alphaToCoverage (CONSTRAINTS: mandatory on every alphaTest mat).
 *
 * Round-5 drew each arm as three smooth bezier strokes and it rendered as a
 * slick red ribbon lying on the ground. This builds each arm out of ~90 short
 * jittered dabs of varying width, alpha and hue, so the edge is ragged and the
 * interior is uneven — a stencil sprayed onto rough stone.
 */
export function bombXTex(letter = "A", N = 512, seed = 9001): THREE.CanvasTexture {
  return memo(`bombXTex|${letter}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, 1);
    const R = rng(seed);
    ctx.clearRect(0, 0, N, N);
    const arm = (x0: number, y0: number, x1: number, y1: number) => {
      const steps = 90;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // taper: thin at the ends, full through the middle
        const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.45;
        const w = N * (0.020 + 0.030 * taper) * (0.75 + R() * 0.55);
        const wob = (R() - 0.5) * N * 0.020;
        const px = x0 + (x1 - x0) * t + wob;
        const py = y0 + (y1 - y0) * t + (R() - 0.5) * N * 0.020;
        const rr = 140 + R() * 46, gg = 56 + R() * 26, bb = 42 + R() * 18;
        ctx.fillStyle = `rgba(${rr | 0},${gg | 0},${bb | 0},${(0.30 + R() * 0.42) * taper})`;
        ctx.beginPath();
        ctx.ellipse(px, py, w, w * (0.7 + R() * 0.6), R() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const m = N * 0.15;
    arm(m, m, N - m, N - m);
    arm(N - m, m, m, N - m);
    // overspray halo along both diagonals
    for (let i = 0; i < 2600; i++) {
      const t = R();
      const onA = R() > 0.5;
      const bx = onA ? m + t * (N - 2 * m) : N - m - t * (N - 2 * m);
      const by = m + t * (N - 2 * m);
      const spread = N * (0.02 + Math.pow(R(), 2) * 0.10);
      const ang = R() * Math.PI * 2;
      ctx.fillStyle = `rgba(${150 + R() * 46 | 0},${62 + R() * 24 | 0},${46 + R() * 16 | 0},${0.05 + R() * 0.28})`;
      ctx.beginPath();
      ctx.arc(bx + Math.cos(ang) * spread, by + Math.sin(ang) * spread, 0.7 + R() * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // wear: punch holes back out so the stone shows through the paint
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 700; i++) {
      const x = R() * N, y = R() * N;
      ctx.fillStyle = `rgba(0,0,0,${0.12 + R() * 0.5})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 1 + R() * 6, 1 + R() * 4, R() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    // site letter, stencilled once, in the upper-left quadrant clear of the arms
    ctx.save();
    ctx.font = `700 ${Math.round(N * 0.19)}px ${FONT_BLACK}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(158,66,50,0.82)";
    ctx.fillText(letter, N * 0.5, N * 0.21);
    ctx.restore();
    // kong banana arc, small, under the crossing
    bananaArc(ctx, N * 0.5, N * 0.93, N * 0.085, N * 0.022, "rgba(226,190,80,0.45)");
    return tex(c);
  });
}

// ------------------------------------------------------------ BIN 14: signage
function platePlate(ctx: Ctx, N: number, H: number, baseHex: string, R: () => number): void {
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, N, H);
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = R() > 0.5 ? "rgba(255,250,236,0.05)" : "rgba(20,16,10,0.06)";
    ctx.fillRect(R() * N, R() * H, 2 + R() * 10, 1 + R() * 4);
  }
}

/** Replaces material 11 (the 'Dust II / Dave Johnston' credit plate). Carries
 *  the CC-BY-4.0 attribution the licence obliges us to ship. */
export function cnvsCreditPlateTex(N = 512, seed = 5511): THREE.CanvasTexture {
  return memo(`cnvsCreditPlateTex|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, DETAIL);
    const R = rng(seed);
    platePlate(ctx, N, N, "#46403a", R); // well above the darkgate floor (#2e2e2e)
    ctx.strokeStyle = "rgba(232,188,52,0.5)";
    ctx.lineWidth = 4;
    ctx.strokeRect(N * 0.06, N * 0.06, N * 0.88, N * 0.88);
    bananaArc(ctx, N * 0.5, N * 0.32, N * 0.14, N * 0.036, "rgba(240,214,100,0.8)");
    ctx.textAlign = "center";
    ctx.font = `${Math.round(N * 0.15)}px ${FONT_BLACK}`;
    ctx.fillStyle = P.AMBER_DEEP;
    ctx.fillText("cnvs.dev", N * 0.5, N * 0.5);
    ctx.font = `700 ${Math.round(N * 0.045)}px ${FONT_COND}`;
    ctx.fillStyle = "rgba(232,188,52,0.9)";
    ctx.fillText("THE FUTURE OF VIBE CODING", N * 0.5, N * 0.575);
    ctx.font = `${Math.round(N * 0.030)}px ${FONT_MONO}`;
    ctx.fillStyle = "rgba(226,218,196,0.62)";
    const lines = [
      'based on "de_dust2 - CS map" by vrchris',
      "licensed CC-BY-4.0 - see the menu footer",
      "BANANA SHIPMENT // non-commercial lab homage",
    ];
    lines.forEach((l, i) => ctx.fillText(l, N * 0.5, N * 0.70 + i * N * 0.052));
    return tex(c);
  });
}

/** Replaces material 17 (the memorial plate). Deliberately NEUTRAL: the
 *  memorial text is not ours to keep or to parody (CONSTRAINTS, Art). */
export function cnvsNeutralPlateTex(W = 512, H = 256, seed = 5522): THREE.CanvasTexture {
  return memo(`cnvsNeutralPlateTex|${W}|${H}|${seed}`, () => {
    const [c, ctx] = canvas(W, H, DETAIL);
    const R = rng(seed);
    platePlate(ctx, W, H, P.BONE_PLATE, R);
    ctx.strokeStyle = "rgba(120,104,72,0.4)";
    ctx.lineWidth = 3;
    ctx.strokeRect(W * 0.05, H * 0.09, W * 0.9, H * 0.82);
    bananaArc(ctx, W * 0.5, H * 0.40, H * 0.16, H * 0.05, "rgba(196,146,30,0.75)");
    ctx.textAlign = "center";
    ctx.font = `700 ${Math.round(H * 0.22)}px ${FONT_COND}`;
    ctx.fillStyle = "rgba(90,72,38,0.85)";
    ctx.fillText("CNVS.DEV", W * 0.5, H * 0.72);
    return tex(c);
  });
}

/** Flat backing plates (materials 10 dark, 23 bone). */
export function plateTex(kind = "dark", N = 128, seed = 5533): THREE.CanvasTexture {
  return memo(`plateTex|${kind}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, DETAIL);
    const R = rng(seed);
    platePlate(ctx, N, N, kind === "dark" ? "#47423a" : P.BONE_PLATE, R);
    return tex(c);
  });
}

/** Replaces materials 5 / 6 (the two street billboards). variant 0|1. */
export function cnvsBillboardTex(variant = 0, W = 1024, H = 256, seed = 5544): THREE.CanvasTexture {
  return memo(`cnvsBillboardTex|${variant}|${W}|${H}|${seed}`, () => {
    const [c, ctx] = canvas(W, H, DETAIL);
    const R = rng(seed + variant * 71);
    // Round-7 used #33302a / #2b3a3c and the in-map billboards read as black
    // rectangles punched in a sunlit wall. Weathered board, not ink.
    ctx.fillStyle = variant ? "#3c4f52" : "#46403a";
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = R() > 0.5 ? "rgba(255,250,236,0.05)" : "rgba(16,14,10,0.07)";
      ctx.fillRect(R() * W, R() * H, 3 + R() * 18, 2 + R() * 6);
    }
    // board frame + fixing bolts: value structure so the plate is never one flat fill
    ctx.fillStyle = "rgba(122,114,96,0.75)";
    ctx.fillRect(0, 0, W, H * 0.055);
    ctx.fillRect(0, H * 0.945, W, H * 0.055);
    ctx.fillRect(0, 0, W * 0.014, H);
    ctx.fillRect(W * 0.986, 0, W * 0.014, H);
    ctx.fillStyle = "rgba(40,34,24,0.7)";
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.arc((i + 0.5) * (W / 12), H * 0.028, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc((i + 0.5) * (W / 12), H * 0.972, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = variant ? "rgba(58,122,128,0.55)" : "rgba(232,188,52,0.45)";
    ctx.lineWidth = 5;
    ctx.strokeRect(W * 0.03, H * 0.11, W * 0.94, H * 0.78);
    ctx.textAlign = "left";
    if (variant === 0) {
      bananaArc(ctx, W * 0.11, H * 0.46, H * 0.24, H * 0.075, "rgba(240,214,100,0.85)");
      ctx.font = `${Math.round(H * 0.42)}px ${FONT_BLACK}`;
      ctx.fillStyle = P.AMBER_DEEP;
      ctx.fillText("cnvs.dev", W * 0.20, H * 0.60);
      ctx.font = `700 ${Math.round(H * 0.13)}px ${FONT_COND}`;
      ctx.fillStyle = "rgba(232,188,52,0.9)";
      ctx.fillText("THE FUTURE OF VIBE CODING", W * 0.205, H * 0.80);
    } else {
      ctx.font = `700 ${Math.round(H * 0.34)}px ${FONT_COND}`;
      ctx.fillStyle = "rgba(140,206,206,0.92)";
      ctx.fillText("BANANA SHIPMENT", W * 0.05, H * 0.48);
      ctx.font = `${Math.round(H * 0.16)}px ${FONT_MONO}`;
      ctx.fillStyle = "rgba(232,224,202,0.7)";
      ctx.fillText("FREIGHT // LOGISTICS // DUST", W * 0.05, H * 0.74);
      bananaArc(ctx, W * 0.90, H * 0.46, H * 0.26, H * 0.08, "rgba(240,214,100,0.8)");
    }
    return tex(c);
  });
}

/** Replaces materials 8 / 20 (the 'A ->' and 'B ->' wall arrows) and 32 (tag).
 *  The base is paintSandstone at the SAME worldM as the wall bin, so the panel
 *  is the wall with a mark painted on it rather than a poster stuck to it
 *  (round-3 flaw: the sign panels had their own brick module and read as
 *  patches). Source srcM for mats 8/20/32 is 4.452/4.452/6.296 - the first two
 *  match the wall exactly; mat 32 gets its own worldM so its blocks stay the
 *  same physical size. */
export function wayfindPanelTex(kind = "A", N = 512, seed = 5566, worldM = 4.452): THREE.CanvasTexture {
  return memo(`wayfindPanelTex|${kind}|${N}|${seed}|${worldM}`, () => {
    const [c, ctx] = canvas(N, N, DETAIL);
    paintSandstone(ctx, N, worldM, seed + kind.charCodeAt(0));
    const R = rng(seed + 9);
    ctx.save();
    ctx.translate(N * 0.5, N * 0.5);
    if (kind === "TAG") {
      ctx.rotate(-0.06);
      ctx.font = `${Math.round(N * 0.20)}px ${FONT_BLACK}`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(58,122,128,0.72)";
      ctx.fillText("CNVS", 0, -N * 0.02);
      ctx.font = `700 ${Math.round(N * 0.085)}px ${FONT_COND}`;
      ctx.fillStyle = "rgba(232,188,52,0.70)";
      ctx.fillText("SHIP IT", 0, N * 0.10);
      bananaArc(ctx, 0, N * 0.20, N * 0.11, N * 0.03, "rgba(240,214,100,0.5)");
    } else {
      ctx.strokeStyle = "rgba(168,72,54,0.9)";
      ctx.lineWidth = N * 0.024;
      ctx.beginPath();
      ctx.ellipse(-N * 0.14, 0, N * 0.15, N * 0.16, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = `700 ${Math.round(N * 0.24)}px ${FONT_BLACK}`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(168,72,54,0.92)";
      ctx.fillText(kind, -N * 0.14, N * 0.085);
      ctx.strokeStyle = "rgba(168,72,54,0.9)";
      ctx.lineWidth = N * 0.03;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(N * 0.04, 0);
      ctx.lineTo(N * 0.30, 0);
      ctx.moveTo(N * 0.30, 0);
      ctx.lineTo(N * 0.21, -N * 0.08);
      ctx.moveTo(N * 0.30, 0);
      ctx.lineTo(N * 0.21, N * 0.08);
      ctx.stroke();
    }
    // paint wear: the mark is old, so break it up with the wall's own grain
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = R() > 0.5 ? "rgba(226,206,168,0.10)" : "rgba(112,88,56,0.10)";
      ctx.fillRect(-N * 0.5 + R() * N, -N * 0.5 + R() * N, 2 + R() * 7, 1 + R() * 3);
    }
    ctx.restore();
    return tex(c);
  });
}

// ------------------------------------------------------- BIN 14b: environment
/**
 * Desert regrade of jungle-textures.ts:770 canopySkyTex. Same equirect mapping,
 * same 12 seeded cumulus, five new stops.
 *
 * THE VERTICAL BAND STEP (fix-ship-polish order 4). The round-3 judge
 * photographed a hard vertical seam in the sky at x ~ 745 of
 * `public/dustmap/shots/judge-r3/mid-bdoors-after.png`, and named two suspects:
 * the haze card's edge, or a coarse bilinear band in this canvas. It is
 * NEITHER. Measured with `qa/x/r4/skyprobe.mjs`, which reads this canvas out of
 * the running world: the worst step between any two ADJACENT columns is 10/255,
 * while the step across the WRAP — column N-1 against column 0 — is **70/255**.
 * Hiding every backdrop layer in turn leaves the seam exactly where it was
 * (`qa/x/r3/pov.mjs --hide=backdrop-haze|backdrop-dune-ring|backdrop-mesa-ring`
 * are pixel-identical there), which is the other half of the proof: the seam is
 * in the background texture itself.
 *
 * The cause is that a cumulus drawn near x = 0 or x = N was CLIPPED by the
 * canvas instead of wrapping around it, so the two ends of a 360-degree
 * panorama did not join. Every cloud is now stamped three times — at x-N, x and
 * x+N — so anything crossing the seam is continuous, and `wrapS` is
 * RepeatWrapping so the sampler interpolates across the join rather than
 * clamping to two different edge texels.
 *
 * The resolution is doubled in the same pass (512 -> 1024) for the judge's other
 * suspect: at a 68 degree fov over a 1600 px capture one texel of a 512 equirect
 * covers ~33 px, so the gradient's own 19/255 worst row step was a visible
 * 33 px band. Every pixel constant below is scaled by `S = N/512`, so the sky
 * is the SAME IMAGE at twice the sampling density, not a different sky.
 */
export function desertSkyTex(N = 1024, seed = 6060): THREE.CanvasTexture {
  return memo(`desertSkyTex|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N);
    const S = N / 512; // every literal below was authored against a 512 canvas
    const R = rng(seed);
    const g = ctx.createLinearGradient(0, 0, 0, N);
    // canvas y=0 is the ZENITH and y=N the nadir; the horizon is the midpoint, so
    // the warm dust band has to sit at 0.46..0.52, not at the bottom of the canvas
    // (round-1 put it at the nadir and the visible horizon came out grey-green).
    g.addColorStop(0.0, "#6f9fc6");
    g.addColorStop(0.28, "#8fb4cf");
    g.addColorStop(0.42, "#b3c6cd");
    g.addColorStop(0.48, "#d5cdb2");
    g.addColorStop(0.52, "#e3cda4");
    g.addColorStop(0.70, "#d3b98d");
    g.addColorStop(1.0, "#c0a377");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
    /** Stamp one cloud three times so it wraps the panorama instead of being cut. */
    const cloud = (x: number, y: number, r: number, rx: number, ry: number, stops: [number, string][]): void => {
      for (const dx of [-N, 0, N]) {
        const cg = ctx.createRadialGradient(x + dx, y, 2 * S, x + dx, y, r);
        for (const [o, col] of stops) cg.addColorStop(o, col);
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.ellipse(x + dx, y, r * rx, r * ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    for (let i = 0; i < 12; i++) {
      cloud(R() * N, (40 + R() * 150) * S, (24 + R() * 40) * S, 1.6, 0.6, [
        [0, "rgba(244,242,228,0.34)"],
        [0.7, "rgba(240,238,224,0.14)"],
        [1, "rgba(240,238,224,0)"],
      ]);
    }
    // a second, flatter cloud band nearer the horizon: with the stops remapped to
    // elevation the round-1 clouds all sat above 60 deg and never entered frame
    for (let i = 0; i < 14; i++) {
      cloud(R() * N, N * (0.30 + R() * 0.14), (20 + R() * 44) * S, 2.4, 0.34, [
        [0, "rgba(248,244,232,0.26)"],
        [0.65, "rgba(242,236,220,0.11)"],
        [1, "rgba(242,236,220,0)"],
      ]);
    }
    // dust haze band on the horizon so the backdrop dissolves into the sky
    const hz = ctx.createLinearGradient(0, N * 0.38, 0, N * 0.52);
    hz.addColorStop(0, "rgba(232,208,164,0)");
    hz.addColorStop(1, "rgba(232,208,164,0.40)");
    ctx.fillStyle = hz;
    ctx.fillRect(0, N * 0.38, N, N * 0.14);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    t.mapping = THREE.EquirectangularReflectionMapping;
    // The panorama is 360 degrees of longitude: u MUST wrap, or the sampler
    // clamps at the join and the two ends never blend. wrapT stays clamped —
    // v is latitude and there is nothing above the zenith to wrap to.
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/**
 * ------------------------------------------------- CREST TREATMENT ----------
 * fix-ship-polish order 4, second half: the DARK SERRATED FRINGE on an
 * alpha-tested silhouette, and why a "same-colour dilation halo" did not stop it.
 *
 * MEASURED (`qa/x/r4/skyprobe.mjs`, which reads the built ring atlases out of
 * the running world): `backdrop-dune-ring` is a 1024x256 atlas with mipmaps on
 * and `alphaToCoverage` FALSE — the software tier reports 0 MSAA samples, so
 * `cutoutAA` is false and the cut is a raw per-fragment discard. Of its 164,838
 * fully transparent texels, **164,838 — 100 % — carry RGB (0,0,0)**. The mesa
 * ring is the same. That is not a bug in the halo: `shadowBlur` writes a halo
 * with alpha > 0, but a 2D canvas stores premultiplied pixels, so any texel that
 * ends at alpha 0 loses its colour and reads back as black no matter what was
 * drawn there.
 *
 * The fringe then follows from plain bilinear magnification, before mipmapping
 * is even involved: halfway between an opaque sand texel (a=1, rgb=sand) and a
 * transparent one (a=0, rgb=BLACK) the sampler returns alpha 0.5 — right on the
 * `alphaTest` — with an RGB that is half black. Every second pixel along the
 * silhouette passes the test carrying a colour ~40 % darker than the dune, and
 * that alternation IS the serration.
 *
 * So this pass does three things to the finished card, in ImageData:
 *   1. DILATES colour outward from the silhouette, so no texel near the edge is
 *      black, and gives the dilated band a small NON-ZERO alpha (>= 12/255) —
 *      the only way colour survives a premultiplied canvas at all.
 *   2. Tints that band toward the scene's fog colour, because the only time
 *      those texels are ever sampled is where the card meets the sky.
 *   3. Re-anchors the crest fade to EACH COLUMN'S OWN RIDGE instead of to card
 *      y, which is what round 3 got wrong (see the note at its call site).
 * The 0.5 crossing stays exactly on the original ridge line, so the silhouette
 * does not move; only what the sampler finds on either side of it changes.
 */
function colourBleed(ctx: Ctx, W: number, H: number, rounds: number, minAlpha = 12): ImageData {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // `filled` starts as "has real colour" (alpha > 0); each sweep pushes the
  // average of filled 4-neighbours one texel outward into the void.
  //
  // FRONTIER, not a full sweep: a naive re-scan of the canvas per round is
  // O(rounds x W x H) and this runs at world build, seven cards plus the window
  // atlas. Only the ring written last round can grow the next one, so that ring
  // is all that is walked (one full pass to seed it, then ~O(perimeter)).
  const filled = new Uint8Array(W * H);
  let frontier: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (d[i * 4 + 3] > 0) { filled[i] = 1; frontier.push(i); }
  }
  const sum = new Map<number, [number, number, number, number]>();
  for (let r = 0; r < rounds && frontier.length; r++) {
    sum.clear();
    for (const k of frontier) {
      const x = k % W, y = (k / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (filled[nk]) continue;
        const a = sum.get(nk) ?? [0, 0, 0, 0];
        a[0]++; a[1] += d[k * 4]; a[2] += d[k * 4 + 1]; a[3] += d[k * 4 + 2];
        sum.set(nk, a);
      }
    }
    const next: number[] = [];
    for (const [k, a] of sum) {
      d[k * 4] = Math.round(a[1] / a[0]);
      d[k * 4 + 1] = Math.round(a[2] / a[0]);
      d[k * 4 + 2] = Math.round(a[3] / a[0]);
      // A 2D canvas stores premultiplied pixels: a texel that ends at alpha 0
      // loses the colour just written into it and reads back BLACK, which is
      // the whole defect this exists to stop. The bled band therefore has to
      // carry a small NON-ZERO alpha — far under any alphaTest, but enough to
      // survive the round trip.
      d[k * 4 + 3] = Math.max(d[k * 4 + 3], minAlpha);
      filled[k] = 1;
      next.push(k);
    }
    frontier = next;
  }
  ctx.putImageData(img, 0, 0);
  return img;
}

function crestTreatment(ctx: Ctx, W: number, H: number): void {
  const FOG: [number, number, number] = [217, 196, 155]; // ENVV.fog.hex 0xd9c49b
  const CUT = 128; // the alphaTest 0.5, in 8-bit alpha
  const FEATHER = Math.max(4, Math.round(H * 0.055)); // soft alpha ramp above the ridge
  const BLEED = Math.max(6, Math.round(H * 0.10)); // low-alpha colour bleed beyond it
  const FADE = Math.max(8, Math.round(H * 0.16)); // ridge-relative haze into the body
  const img = colourBleed(ctx, W, H, FEATHER + BLEED, 12);
  const d = img.data;
  const at = (x: number, y: number): number => (y * W + x) * 4;
  // per-column ridge: the alpha profile above it and the haze below it
  for (let x = 0; x < W; x++) {
    let ridge = -1;
    for (let y = 0; y < H; y++) {
      if (d[at(x, y) + 3] >= CUT) { ridge = y; break; }
    }
    if (ridge < 0) continue;
    for (let k = 1; k <= FEATHER + BLEED; k++) {
      const y = ridge - k;
      if (y < 0) break;
      const i = at(x, y);
      if (d[i + 3] >= CUT) continue; // another lobe of the silhouette: leave it
      // alpha: 120 (just UNDER the 0.5 cut, so the silhouette does not grow)
      // decaying across the feather, then a flat low bleed that only exists to
      // keep colour in the texels the sampler reaches for.
      const a = k <= FEATHER ? Math.round(120 * (1 - (k - 1) / FEATHER)) : 12;
      d[i + 3] = Math.max(d[i + 3], Math.max(a, 12));
      // colour: three-quarters of the way to fog, so a pixel that does squeak
      // through the test reads as sky rather than as a dark rim
      for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * 0.25 + FOG[c] * 0.75);
    }
    for (let k = 0; k < FADE; k++) {
      const y = ridge + k;
      if (y >= H) break;
      const i = at(x, y);
      if (d[i + 3] < CUT) continue;
      const t = (1 - k / FADE) * 0.55; // full at the ridge, gone by FADE below it
      for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * (1 - t) + FOG[c] * t);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Dune / mesa silhouette card, treeCardTex language: flat fill + same-colour
 *  dilation halo so alpha-test edges never fringe pale. */
export function duneCardTex(variant = 0, kind = "dune", N = 256, seed = 300): THREE.CanvasTexture {
  return memo(`duneCardTex|${variant}|${kind}|${N}|${seed}`, () => {
    const c = document.createElement("canvas");
    c.width = N;
    c.height = N;
    const ctx = c.getContext("2d")!;
    const R = rng(seed + variant * 97);
    ctx.clearRect(0, 0, N, N);
    const fill = kind === "mesa" ? "#b79b73" : "#c4a87c";
    ctx.shadowColor = fill;
    ctx.shadowBlur = 4;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(0, N);
    if (kind === "mesa") {
      // flat-topped butte with a talus skirt
      const top = N * (0.30 + R() * 0.14);
      const l = N * (0.10 + R() * 0.12), r = N * (0.72 + R() * 0.16);
      ctx.lineTo(0, N * 0.86);
      ctx.lineTo(l - N * 0.10, N * 0.80);
      ctx.lineTo(l, top + N * 0.04);
      ctx.lineTo(l + N * 0.03, top);
      ctx.lineTo(r - N * 0.03, top + N * 0.01);
      ctx.lineTo(r, top + N * 0.06);
      ctx.lineTo(r + N * 0.12, N * 0.82);
      ctx.lineTo(N, N * 0.88);
      ctx.lineTo(N, N);
    } else {
      let y = N * (0.62 + R() * 0.14);
      ctx.lineTo(0, y);
      for (let x = 0; x <= N; x += N / 8) {
        y += (R() - 0.5) * N * 0.16;
        y = Math.max(N * 0.34, Math.min(N * 0.86, y));
        ctx.quadraticCurveTo(x - N / 16, y - N * 0.05, x, y);
      }
      ctx.lineTo(N, N);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    // internal value variation so the card is not a flat silhouette at 110 m
    ctx.globalCompositeOperation = "source-atop";
    for (let i = 0; i < 40; i++) {
      const x = R() * N, y = N * 0.3 + R() * N * 0.7, rr = 10 + R() * 46;
      const g = ctx.createRadialGradient(x, y, 2, x, y, rr);
      g.addColorStop(0, R() > 0.5 ? "rgba(226,206,170,0.20)" : "rgba(126,102,70,0.18)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    /**
     * CREST FADE (fix-round-3 order 7). The ring cards are `MeshBasicMaterial`
     * with `alphaTest: 0.5`, so their silhouette against the sky is a HARD
     * edge at one constant value — which is what the round-2 judge photographed
     * as "a flat grey wedge above the wall"
     * (public/dustmap/shots/judge-r2/crop-grey-band.png). Linear fog alone
     * cannot fix it: at the dune ring's 96-118 m the fog factor is only
     * 0.36-0.50, so half the card's own colour survives, and a binary alpha
     * test cannot soften the edge either.
     *
     * So the fade is painted INTO the card, toward the scene's own fog colour
     * (ENVV.fog.hex 0xd9c49b): opaque haze at the ridge line, gone by the
     * card's lower third. The crest dissolves into the sky the way a real dune
     * at 110 m does, and the body of the dune keeps its value variation.
     *
     * ROUND 3 ANCHORED IT TO THE WRONG THING (fix-ship-polish order 4). This
     * gradient runs in CARD Y — 0.22N to 0.78N — but the silhouette does not:
     * a dune variant's ridge is drawn anywhere in 0.34N..0.86N and a mesa's top
     * anywhere in 0.30N..0.44N, so the fade was strongest well ABOVE most
     * ridges (where the card is transparent and it does nothing) and had
     * already decayed to a third by the time it reached the line it was for.
     * `crestTreatment` below re-anchors it to each COLUMN'S OWN ridge, so the
     * fade is at full strength exactly where card meets sky, whatever the
     * variant drew.
     */
    ctx.globalCompositeOperation = "source-atop";
    {
      const fade = ctx.createLinearGradient(0, N * 0.22, 0, N * 0.78);
      fade.addColorStop(0, "rgba(217,196,155,0.72)");
      fade.addColorStop(0.45, "rgba(217,196,155,0.34)");
      fade.addColorStop(1, "rgba(217,196,155,0)");
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, N, N);
    }
    ctx.globalCompositeOperation = "source-over";
    crestTreatment(ctx, N, N);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    return t;
  });
}

/** Horizon CNVS container yard: jungle containerSideTex, verbatim structure. */
export function containerSideTex(baseHex: string, seed: number, mossAmount = 0.2, W = 512, H = 256): THREE.CanvasTexture {
  return memo(`containerSideTex|${baseHex}|${seed}|${mossAmount}|${W}|${H}`, () => {
    const [c, ctx] = canvas(W, H);
    ctx.fillStyle = baseHex;
    ctx.fillRect(0, 0, W, H);
    paintCorrugationShading(ctx, W, H, 0.08, 17);
    paintWeathering(ctx, W, H, seed, mossAmount);
    return tex(c, false);
  });
}

export function containerEndTex(baseHex: string, seed: number, unit: number, prefix = "Y", N = 256): THREE.CanvasTexture {
  return memo(`containerEndTex|${baseHex}|${seed}|${unit}|${prefix}|${N}`, () => {
    const [c, ctx] = canvas(N, N);
    ctx.fillStyle = baseHex;
    ctx.fillRect(0, 0, N, N);
    paintCorrugationShading(ctx, N, N, 0.06, 17);
    ctx.fillStyle = "rgba(20,16,10,0.4)";
    ctx.fillRect(N * 0.49, N * 0.04, N * 0.016, N * 0.92);
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = `700 ${Math.round(N * 0.125)}px ${FONT_COND}`;
    ctx.fillStyle = "rgba(242,234,212,0.62)";
    ctx.fillText("CNVS.DEV", N * 0.5, N * 0.44);
    ctx.font = `700 ${Math.round(N * 0.04)}px ${FONT_COND}`;
    ctx.fillStyle = "rgba(242,234,212,0.45)";
    ctx.fillText("THE FUTURE OF VIBE CODING", N * 0.5, N * 0.52);
    bananaArc(ctx, N * 0.5, N * 0.30, N * 0.08, N * 0.024);
    ctx.font = `700 ${Math.round(N * 0.086)}px ${FONT_MONO}`;
    ctx.fillStyle = "rgba(240,234,214,0.5)";
    ctx.fillText(`${prefix}-${String(unit).padStart(2, "0")}`, N * 0.5, N * 0.74);
    ctx.restore();
    paintWeathering(ctx, N, N, seed + 1, mossFor(unit));
    return tex(c, false);
  });
}
function mossFor(unit: number): number {
  return 0.15 + (unit % 3) * 0.06;
}

// =========================================================== PHASE-3 ADDITIONS
// Three recipes the look-dev rig never needed, each closing a named flaw in
// spec-art §8 "Remaining". They are decal / FX canvases, never tiled surfaces.

/**
 * CNVS crate stencil — spec-art §8 flaw 7.
 *
 * `crateWoodTex` is deliberately WORDMARK-FREE: a tiling material that carries
 * text prints it twice on one face and cuts it in thirds on the next (the
 * round-3 map-review failure, report-render 2.7). The wordmark therefore lives
 * on a DECAL QUAD placed once per qualifying crate face, which is what a real
 * stencil is anyway. Transparent everywhere but the ink, alphaTest'd, and
 * DELIBERATELY worn: a crisp print on a sun-bleached crate reads as a sticker.
 *
 * variant 0 = `CNVS.DEV` wordmark + banana arc, 1 = a `Y-nn` unit stamp.
 */
export function crateStencilTex(variant = 0, unit = 7, N = 256, seed = 4711): THREE.CanvasTexture {
  return memo(`crateStencilTex|${variant}|${unit}|${N}|${seed}`, () => {
    const [c, ctx] = canvas(N, N, DETAIL);
    const R = rng(seed + variant * 37 + unit);
    ctx.clearRect(0, 0, N, N);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (variant === 0) {
      bananaArc(ctx, N * 0.5, N * 0.34, N * 0.16, N * 0.045, "rgba(232,214,164,0.80)");
      ctx.font = `${Math.round(N * 0.19)}px ${FONT_BLACK}`;
      ctx.fillStyle = "rgba(236,224,196,0.82)";
      ctx.fillText("CNVS.DEV", N * 0.5, N * 0.58);
      ctx.font = `700 ${Math.round(N * 0.072)}px ${FONT_COND}`;
      ctx.fillStyle = "rgba(226,210,178,0.62)";
      ctx.fillText("FRAGILE // THIS WAY UP", N * 0.5, N * 0.75);
    } else {
      ctx.font = `${Math.round(N * 0.26)}px ${FONT_MONO}`;
      ctx.fillStyle = "rgba(232,218,186,0.78)";
      ctx.fillText(`Y-${String(unit).padStart(2, "0")}`, N * 0.5, N * 0.44);
      ctx.font = `700 ${Math.round(N * 0.085)}px ${FONT_COND}`;
      ctx.fillStyle = "rgba(226,210,178,0.55)";
      ctx.fillText("BANANA SHIPMENT", N * 0.5, N * 0.66);
    }
    // Stencil wear: bite the ink back so the boards show through. Same
    // destination-out trick as the bomb-X, at a tenth of the count.
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.25 + R() * 0.6})`;
      ctx.beginPath();
      ctx.ellipse(R() * N, R() * N, 1 + R() * 5, 1 + R() * 3.4, R() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; // its own quad, UV 0..1, no offsets
    t.anisotropy = ANISO;
    return t;
  });
}

/**
 * Dust mote sprite — spec-art §8 flaw 6. One soft warm disc; the Points cloud
 * that uses it is the desert dose of the jungle's drifting-leaf band.
 */
export function dustMoteTex(N = 64): THREE.CanvasTexture {
  return memo(`dustMoteTex|${N}`, () => {
    const [c, ctx] = canvas(N, N);
    const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    g.addColorStop(0, "rgba(240,224,190,0.85)");
    g.addColorStop(0.45, "rgba(226,204,164,0.34)");
    g.addColorStop(1, "rgba(214,190,150,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, N, N);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    return t;
  });
}

/**
 * God-ray card — spec-art §8 flaw 6, the jungle map's 2-draw shaft trick at a
 * desert grade. A soft-edged vertical wedge, brightest at the top where it
 * leaves the roof opening, feathered to nothing at both sides so the card's own
 * silhouette never shows. Additive, so black = invisible.
 */
export function godRayTex(W = 128, H = 256): THREE.CanvasTexture {
  return memo(`godRayTex|${W}|${H}`, () => {
    const [c, ctx] = canvas(W, H);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);
    const v = ctx.createLinearGradient(0, 0, 0, H);
    v.addColorStop(0, "rgba(255,238,200,0.95)");
    v.addColorStop(0.55, "rgba(236,214,170,0.42)");
    v.addColorStop(1, "rgba(210,186,146,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    // feather the two vertical edges to black
    const h = ctx.createLinearGradient(0, 0, W, 0);
    h.addColorStop(0, "rgba(0,0,0,1)");
    h.addColorStop(0.5, "rgba(0,0,0,0)");
    h.addColorStop(1, "rgba(0,0,0,1)");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = h;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    return t;
  });
}

// ---------------------------------------------------------------- utilities --
/** Multiply a #rrggbb by (1+f), clamped. Value variation only — never a light. */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * (1 + f))));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * (1 + f))));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * (1 + f))));
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}
