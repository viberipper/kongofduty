import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { stableSunFollow } from "./shadow-stability";
import { activeMap } from "@shared/maps";
import type { MapDef } from "@shared/maps";
import { aaSamples, ANISO, isSoftwareGL } from "./textures";
import { softwareSky } from "./software-sky";
export { exportRecipes } from "./dust-textures";
import { assetUrl } from "./asset-base";
import { pmremEnv, type AnyRenderer } from "./gpu-backend";
import * as DT from "./dust-textures";
import type { WorldApi } from "./world";

/**
 * dust2 — THE KONG-DESERT WORLD BUILDER.
 *
 * Implements docs/dustmap/spec-art.md end to end against the shipped geometry
 * asset (static/assets/models/dust2/dust2-game.glb, built by
 * scripts/dustmap/build-dust2-glb.mjs). Read CONSTRAINTS.md first; the four
 * things that file locks and this one obeys are:
 *
 *  1. ONE FRAME. Raw GLB game-space: `gx = lx*0.0254, gy = -ly*0.0254,
 *     gz = -lz*0.0254`. Negating Y *and* Z is determinant +1 — a rotation, not
 *     a mirror. Negating only Y mirrors the map A<->B and every collider,
 *     report coordinate and heightgrid cell would be wrong. The Sketchfab
 *     wrapper node's own transform is DROPPED (its 0.013333 scale is not ours);
 *     the transform is taken relative to the `de_dust2`-prefixed child, which
 *     GLTFLoader renames (dots are sanitised) — so it is matched by PREFIX.
 *  2. DRAW CALLS ARE THE CURRENCY. The 34 source primitives bin into 14 kong
 *     materials and are MERGED, one draw per bin. `uvScale` is baked into the
 *     merged UV attribute (spec-art §7.2) instead of riding on
 *     `texture.repeat`, because a second repeat value would mean a second
 *     material and a second draw.
 *  3. TILED SURFACES ARE NEVER ATLASED. The source UVs are world-projected and
 *     run to +/-157; RepeatWrapping is the whole tiling contract. Only the
 *     FITTED families (doors, signage, bomb-X) are atlased, and only after
 *     their per-instance integer UV offsets are rebaked away — see `fitToCell`.
 *  4. 33 of 34 SOURCE MATERIALS NEED DoubleSide. Material 25 (the hazard band)
 *     is the single-sided one. Backface culling punches holes in every tunnel
 *     ceiling and shell interior.
 *
 * Contract with game.ts (owned elsewhere):
 *   const { buildDustWorld } = await import("./dust-world");
 *   this.world = await buildDustWorld(renderer);
 */

// ============================================================== the frame ===
/** Inches to metres. The source is a 2018 decompile of a Quake-family BSP. */
const U = 0.0254;
/** Map bbox centre in xz (CONSTRAINTS bounds), the backdrop's origin. */
const CX = -8.128;
const CZ = -28.448;
/** The world floor plane. Matches MapDef.floorY for dust2. */
const FLOOR_Y = -4.95;
/**
 * Everything at z greater than this is the detached north wall stub, which
 * CONSTRAINTS excludes from bounds / minimap / collider generation. It is still
 * DRAWN (it closes the skyline over T spawn) but it is split into its own
 * `qaIgnore` meshes so the collider audit does not read 27 triangles of
 * unbacked geometry as protruding visual.
 */
const STUB_Z = 31;

// ================================================== the 34 -> 14 bin plan ===
// Ported from scripts/dustmap/lookdev/bins.mjs; the table in spec-art.md §2 is
// the same data with prose. `mat` is the glTF DOCUMENT material index, which is
// what the build script stamps into the material name as `dustmat_<n>`.

type BinId =
  | "sandstone-wall"
  | "arch-brick"
  | "coping-trim"
  | "adobe-plaster"
  | "cobble-floor"
  | "sand-floor"
  | "plank-wood"
  | "crate-wood"
  | "rock-cliff"
  | "wooden-door"
  | "metal-frame"
  | "signage"
  | "bomb-x";

type SrcMat = {
  /** glTF document material index — the binning key. */
  mat: number;
  /** Source mesh index, for the z-fight / lift / exclusion rules. */
  mesh: number;
  bin: BinId;
  /** Sub-material inside a bin (door mark, metal finish, sign plate). */
  variant?: string;
  /**
   * MEASURED metres per source UV tile (lookdev/uv-density.json, the
   * area-weighted median of sqrt(worldArea/uvArea) over every triangle). On a
   * tiled bin the baked UV multiplier is `srcM / BIN_WORLD_M[bin]`, which is
   * spec-art §1's formula rather than a copied constant.
   */
  srcM?: number;
  /**
   * Explicit UV multiplier, for the FITTED families where there is no tile
   * size to divide by — it is whatever brings ONE instance's UV span inside
   * one canvas. Wins over `srcM` when both are present.
   */
  uvScale?: number;
  what: string;
};

const SRC: SrcMat[] = [
  // --- tiled bins ---------------------------------------------------------
  { mat: 1, mesh: 27, bin: "sandstone-wall", srcM: 4.452, what: "primary sandstone wall — 34 % of all map area" },
  { mat: 28, mesh: 22, bin: "arch-brick", srcM: 4.452, what: "every doorway / arch surround" },
  { mat: 0, mesh: 0, bin: "coping-trim", srcM: 1.408, what: "wall caps, dado band, sloped roof strips" },
  { mat: 2, mesh: 1, bin: "adobe-plaster", srcM: 5.631, what: "interior floors + roofed soffits" },
  { mat: 29, mesh: 23, bin: "cobble-floor", srcM: 6.502, what: "cobble paving: mid, long, the streets" },
  { mat: 15, mesh: 12, bin: "sand-floor", srcM: 3.251, what: "orange sand floor (A site, open yards)" },
  { mat: 30, mesh: 24, bin: "sand-floor", srcM: 3.251, what: "fine orange sand (B site, tunnels approach)" },
  { mat: 33, mesh: 33, bin: "plank-wood", srcM: 1.626, what: "vertical plank boards used as walkable deck" },
  { mat: 12, mesh: 28, bin: "plank-wood", srcM: 1.626, what: "boarded panels (source tiled a WINDOW image — fixed here)" },
  // The one non-unity tiled scale in the whole map: 2.438 / 1.626 = 1.4994.
  { mat: 9, mesh: 8, bin: "plank-wood", srcM: 2.438, what: "weathered plank floor" },
  { mat: 4, mesh: 3, bin: "crate-wood", srcM: 2.438, what: "wooden crates; 2.438 m = exactly one crate face" },
  { mat: 3, mesh: 2, bin: "rock-cliff", srcM: 7.075, what: "NW cliff face behind B + the sloped rock skirts" },
  // --- metal: TILED, so four materials and four draws, never an atlas ------
  { mat: 13, mesh: 11, bin: "metal-frame", variant: "panel", what: "green supply-box steel, sides" },
  { mat: 14, mesh: 29, bin: "metal-frame", variant: "panel", what: "green supply-box steel, lids" },
  { mat: 25, mesh: 30, bin: "metal-frame", variant: "hazard", what: "ammo box + hazard band — the ONLY single-sided source material" },
  { mat: 26, mesh: 31, bin: "metal-frame", variant: "rust", what: "lamp bracket / rusted fixture steel" },
  { mat: 27, mesh: 32, bin: "metal-frame", variant: "tube", what: "fluorescent tube — the map's one emissive surface" },
  // --- fitted: doors ------------------------------------------------------
  { mat: 31, mesh: 25, bin: "wooden-door", variant: "plain", what: "plain double doors (the bulk of the map's doors)" },
  { mat: 16, mesh: 13, bin: "wooden-door", variant: "plain", what: "dark double door" },
  { mat: 21, mesh: 18, bin: "wooden-door", variant: "plain", what: "graffitied door" },
  { mat: 24, mesh: 21, bin: "wooden-door", variant: "EXIT", what: "EXIT-tagged door" },
  { mat: 22, mesh: 19, bin: "wooden-door", variant: "A", what: "circled-A door — gameplay wayfinding, kept loud" },
  { mat: 19, mesh: 16, bin: "wooden-door", variant: "B", what: "circled-B door — gameplay wayfinding, kept loud" },
  // --- fitted: signage ----------------------------------------------------
  { mat: 11, mesh: 10, bin: "signage", variant: "cnvs-credit", what: "replaces the source credit plate; CARRIES THE CC-BY-4.0 LINE" },
  // Materials 10 and 23 are the two flat backing BOXES, and their UVs tile 4x
  // and 7x per face — they are not fitted at all. Their canvas is a uniform
  // brushed plate with no structure to lose, so 1/8 scale drops the worst
  // per-triangle span to 0.875 and lets them share the fitted atlas. Measured
  // spans: mesh 9 -> 4.000, mesh 20 -> 7.000 (scripts/dustmap uv audit).
  { mat: 10, mesh: 9, bin: "signage", variant: "plate-dark", uvScale: 0.125, what: "the credit plate's backing box" },
  { mat: 17, mesh: 14, bin: "signage", variant: "cnvs-neutral", what: "replaces the memorial plate — NEUTRAL, no memorial text, no parody" },
  { mat: 23, mesh: 20, bin: "signage", variant: "plate-bone", uvScale: 0.125, what: "the memorial plaque box (kept, outside playable bounds)" },
  // Both billboards' source UV spans 2x2 tiles: without 0.5 the face shows
  // FOUR copies of the wordmark (spec-art §8 flaw 8).
  { mat: 5, mesh: 4, bin: "signage", variant: "billboard-0", uvScale: 0.5, what: "street billboard -> cnvs.dev wordmark board" },
  { mat: 6, mesh: 5, bin: "signage", variant: "billboard-1", uvScale: 0.5, what: "'NEWERSEY.COM' -> BANANA SHIPMENT freight board" },
  { mat: 8, mesh: 7, bin: "signage", variant: "wayfind-A", what: "'A ->' wall arrow, restyled in kong red" },
  { mat: 20, mesh: 17, bin: "signage", variant: "wayfind-B", what: "'B ->' wall arrow, restyled in kong red" },
  { mat: 32, mesh: 26, bin: "signage", variant: "tag", what: "graffitied wall -> CNVS spray tag" },
  // --- fitted: the bomb sites --------------------------------------------
  { mat: 7, mesh: 6, bin: "bomb-x", variant: "A", what: "A-site bomb X (coplanar with mesh 29 at y +2.438)" },
  { mat: 18, mesh: 15, bin: "bomb-x", variant: "B", what: "B-site bomb X (coplanar with mesh 29 at y 0)" },
];

/** Bins whose detail half is coplanar with a bigger neighbour (glb-zfight.json). */
const ZFIGHT_BINS = new Set<BinId>(["coping-trim", "rock-cliff", "plank-wood", "metal-frame", "bomb-x"]);
/** The two bomb-X quads get a 5 mm world lift ON TOP of the polygon offset. */
const BOMB_LIFT = 0.005;
/** Meshes CONSTRAINTS excludes from bounds/minimap/colliders: the plaque pair. */
const PLAQUE_MESHES = new Set([14, 20]);

/** Per-bin world tile size (metres per 0..1 canvas tile) — spec-art §1/§2. */
const BIN_WORLD_M: Partial<Record<BinId, number>> = {
  "sandstone-wall": 4.452,
  "arch-brick": 4.452,
  "coping-trim": 1.408,
  "adobe-plaster": 5.631,
  "cobble-floor": 6.502,
  "sand-floor": 3.251,
  "plank-wood": 1.626,
  "crate-wood": 2.438,
  "rock-cliff": 7.075,
  "metal-frame": 1.626,
};

// ================================================= environment (spec §3) ===
const ENVV = {
  fog: { hex: 0xd9c49b, near: 40, far: 195 },
  sun: { hex: 0xffeec2, intensity: 2.05, elevationDeg: 46, azimuthDeg: 118, radius: 140 },
  // Look-dev shipped hemi 0.50 / ambient 0.22 / bounce 0.30 with no interior
  // key at all. Phase 3 moves fill energy OUT of the two directionless terms
  // and INTO the two shadowless axis keys below, at roughly constant exterior
  // exposure. Hemi and ambient light every surface the same, so they are pure
  // flatteners: indoors, where they were most of the light, they were the
  // reason a corridor had no value structure to read.
  hemi: { sky: 0xe2d9c2, ground: 0xc09a5e, intensity: 0.34 },
  bounce: { hex: 0xe8d3a4, intensity: 0.26, pos: [-70, 34, 62] as const },
  ambient: { hex: 0xc4b490, intensity: 0.15 },
  shadow: { size: 4096, half: 38, near: 40, far: 340, bias: -0.00022, normalBias: 0.06, radius: 3.1 },
  /**
   * spec-art §8, remaining flaw 1. The two roofed axes (T tunnels -> B, and the
   * mid/CT corridor) get no sun at all, so their only value structure was
   * albedo and the look-dev frames measured luma sd 17.1 / 18.4 against the
   * source's 29.1 / 42.4. These two shadowless warm keys are aimed DOWN those
   * axes, which is what puts a bright end wall against a dim side wall instead
   * of lighting every interior surface identically from everywhere.
   */
  // `from` is the direction the light COMES FROM, same convention as the sun.
  // Fill A is a low, warm "sun spill": the same azimuth family as the 118 deg
  // sun but at 20 deg elevation instead of 46, so it reaches down a corridor
  // instead of over it. That direction is the ONE that produces value structure
  // in a roofed passage — it lights the +x-facing wall of a z-corridor and
  // leaves the -x-facing wall in shade, which is the light/dark pair the
  // look-dev interiors were missing entirely. Fill B is a weak counter so the
  // shade side keeps its own gradient rather than flattening to ambient.
  axisFills: [
    { hex: 0xffe4b6, intensity: 0.62, from: [0.86, 0.36, -0.36] as const },
    { hex: 0xe8d8bc, intensity: 0.2, from: [-0.62, 0.3, 0.55] as const },
  ],
};

// ================================================ backdrop + prop placement ==
// From scripts/dustmap/lookdev/props.json, which derived every position from
// docs/dustmap/heightgrid.json. Class A (rooftop) columns are provably
// unreachable: >= 1.9 m above any standable floor within 3 m, against a 0.80 m
// jump apex and a 1.05 m mantle. Class B is beyond the map's 88.25 m
// circumradius. NEITHER carries a collider, a nav seed, or a minimap footprint.
const GROUND = { size: 460, y: FLOOR_Y, worldM: 6.5 };
const HAZE = { r: 210, h: 60, centreY: -6 };
/**
 * DUNE / MESA RING TINT (fix-round-3 order 7).
 *
 * These were 0x9c8a6c and 0xb3a184 — desaturated khakis chosen to read as
 * "far away". They do not: the ring cards are `MeshBasicMaterial`, so they take
 * no light at all, and against a warm sandstone skyline an unlit desaturated
 * card is the flat GREY WEDGE the round-2 judge photographed above the B-site
 * wall (`public/dustmap/shots/judge-r2/crop-grey-band.png`) and again on the
 * horizon of `r2/cliff-glancing.png`. Depth here comes from the FOG, which the
 * ring already opts into (`fog: true`), so the tint's job is to match the
 * palette rather than to fake distance — and matching it means the fog colour,
 * not a grey.
 *
 * Both tints are now warm sand pulled toward `ENVV.fog.hex` (0xd9c49b): the
 * dune ring sits at 96-118 m where linear fog (40..195) is ~40 % of the way to
 * the fog colour, the mesa ring at 132-158 m where it is ~65 %. Measured
 * against the same two horizon cameras the judge used.
 */
const DUNE_TINT = 0xc7ad84;
const MESA_TINT = 0xd0b892;
const DUNE_RING = { rMin: 96, rMax: 118, count: 20, baseY: -5, hMin: 16, hMax: 28 };
const MESA_RING = { rMin: 132, rMax: 158, count: 13, baseY: -5, hMin: 30, hMax: 48 };
const BILLBOARD = { x: 112.15, z: 15.33, y: -5, h: 15, aimAt: [CX, 6, CZ] as const };

/** [x, y, z, yawDeg, paint, unit] */
const CONTAINER_YARD: [number, number, number, number, string, number][] = [
  [-0.85, -2.41, 105.98, 0, "#a04434", 12], [1.39, -5, 123.02, 67.5, "#c8a030", 21],
  [6.03, 0.18, 90.41, 22.5, "#3a7a80", 15], [28.92, -5, 80.3, 22.5, "#3a7a80", 4],
  [35.2, 0.18, 95.27, 45, "#c8a030", 25], [22.99, -5, 88.46, 0, "#3a7a80", 4],
  [35.48, -2.41, 84.49, 67.5, "#c8a030", 25], [8.05, -2.41, 110.14, 22.5, "#4a7040", 8],
  [20.94, -2.41, 110.5, 45, "#4a7040", 40], [5.44, -2.41, 79.14, 0, "#c8a030", 31],
  [29.02, 0.18, 110.65, 67.5, "#c8a030", 34], [-115.39, -5, -65.96, 45, "#4a7040", 38],
  [-115.87, -2.41, -94.51, 67.5, "#a04434", 12], [-119.01, -2.41, -79.01, 22.5, "#3a7a80", 16],
  [-154.66, 0.18, -88.16, 90, "#a04434", 38], [-125, 0.18, -86.77, 22.5, "#c8a030", 5],
  [-118.64, -5, -89.22, 67.5, "#4a7040", 22], [-151.91, -5, -104.06, 0, "#3a7a80", 6],
  [-114.13, 0.18, -82.35, 45, "#3a7a80", 38], [-120.5, 0.18, -67.93, 67.5, "#c8a030", 22],
  [109.41, -5, -135.17, 67.5, "#3a7a80", 24], [106.22, -5, -117.3, 67.5, "#4a7040", 4],
  [95.29, -2.41, -145.69, 90, "#a04434", 18], [93.11, 0.18, -107.88, 45, "#a04434", 32],
  [100.14, 0.18, -120.08, 0, "#c8a030", 24], [79.08, 0.18, -118.15, 45, "#3a7a80", 40],
  [92.05, 0.18, -143.86, 45, "#4a7040", 26],
];

/** [x, y, z, yawDeg, kind] — the 11 class-A rooftop props. */
const ROOF_PROPS: [number, number, number, number, string][] = [
  [-55.02, 8.941, 28.09, 0, "crate-stack"], [-64.02, 6.502, -94.91, 37, "tarp-bundle"],
  [-56.02, 6.502, -53.91, 74, "barrel-pair"], [-26.02, 6.502, 14.09, 111, "banana-crate"],
  [-43.02, 6.502, -77.91, 148, "sat-dish"], [-60.02, 6.502, -74.91, 185, "cnvs-crate"],
  [-38.02, 8.941, 28.09, 222, "awning-frame"], [-47.02, 6.502, -94.91, 259, "water-tank"],
  [-25.02, 8.941, 28.09, 296, "crate-stack"], [-57.02, 6.502, -85.91, 333, "tarp-bundle"],
  [-56.02, 6.502, -64.91, 10, "barrel-pair"],
];

/**
 * God-ray anchors, in the two roofed sections a player actually walks through
 * (T tunnels, and the roofed mouth of mid). `w`/`h` are the card size; `yaw` is
 * the card's facing. Kept narrow so the card never intersects a wall — an
 * additive quad that clips through masonry reads as a bug, not a shaft.
 */
const GOD_RAYS: { x: number; y: number; z: number; w: number; h: number; yaw: number }[] = [
  { x: -49.3, y: 2.6, z: -36.5, w: 2.4, h: 4.4, yaw: 0.25 },
  { x: -50.1, y: 2.6, z: -43.0, w: 2.2, h: 4.4, yaw: -0.2 },
  { x: -10.2, y: 1.6, z: -20.5, w: 2.6, h: 4.0, yaw: 0.1 },
];

// ================================================================ helpers ===
const PAINTS = ["#a04434", "#3a7a80", "#c8a030", "#4a7040"];

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

/**
 * KHR_mesh_quantization stores POSITION (and NORMAL) as NORMALISED integers and
 * pushes the dequantisation into the node transform. `applyMatrix4` on such an
 * attribute writes the result straight back into the Int16 buffer and clamps
 * every vertex to the unit cube. Bake a Float32 copy FIRST — the exact trap
 * jungle-world.ts:806-816 documents for the statement meshes.
 */
function bakeFloat(geo: THREE.BufferGeometry, name: string, itemSize: number): void {
  const a = geo.getAttribute(name);
  if (!a || a.array instanceof Float32Array) return;
  const flat = new Float32Array(a.count * itemSize);
  for (let i = 0; i < a.count; i++) {
    flat[i * itemSize] = a.getX(i);
    if (itemSize > 1) flat[i * itemSize + 1] = a.getY(i);
    if (itemSize > 2) flat[i * itemSize + 2] = a.getZ(i);
  }
  geo.setAttribute(name, new THREE.BufferAttribute(flat, itemSize));
}

/** Keep only POSITION / NORMAL / TEXCOORD_0 so every bin merges cleanly. */
function stripToCore(geo: THREE.BufferGeometry): void {
  for (const k of Object.keys(geo.attributes)) {
    if (k !== "position" && k !== "normal" && k !== "uv") geo.deleteAttribute(k);
  }
  geo.morphAttributes = {};
}

type Cell = { x: number; y: number; w: number; h: number };

/**
 * ATLAS REBAKE — the only legal way to atlas a dust2 surface.
 *
 * A FITTED source UV is `0..1 per instance PLUS AN INTEGER OFFSET` (the
 * circled-B door is u 12.5..13, the 'A ->' panel is u -12..-11). Two
 * consequences:
 *   * ClampToEdge smears the canvas's edge column across the whole face — that
 *     is the bug that rendered every door in the map as a flat peach rectangle
 *     (spec-art §8 flaw 7). Tiled OR fitted, the source texture must Repeat.
 *   * `fract(u)` cannot be used to normalise, because a triangle spanning
 *     u 12.5..13.0 fracts to 0.5..0.0 and turns inside out.
 * So the offset is removed PER TRIANGLE from the triangle's own floor(min(u)),
 * which is exact for every fitted primitive in this map (measured worst
 * per-triangle span after uvScale: u 1.000, v 1.000). The geometry is
 * un-indexed first so each triangle owns its three UVs.
 *
 * The cell is INSET by a gutter and the gutter is filled with replicated edge
 * pixels by `drawCell`, so bilinear filtering at u = 0 or u = 1 never samples
 * the neighbouring cell.
 */
function fitToCell(geo: THREE.BufferGeometry, cell: Cell, atlasW: number, atlasH: number, uvScale: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const arr = uv.array as Float32Array;
  const sx = cell.w / atlasW;
  const sy = cell.h / atlasH;
  const ox = cell.x / atlasW;
  // Canvas y grows downward, texture v grows upward: the cell's v origin is
  // measured from the BOTTOM of the atlas.
  const oy = (atlasH - cell.y - cell.h) / atlasH;
  for (let t = 0; t < uv.count; t += 3) {
    let uMin = Infinity;
    let vMin = Infinity;
    for (let k = 0; k < 3; k++) {
      const u = arr[(t + k) * 2] * uvScale;
      const v = arr[(t + k) * 2 + 1] * uvScale;
      arr[(t + k) * 2] = u;
      arr[(t + k) * 2 + 1] = v;
      if (u < uMin) uMin = u;
      if (v < vMin) vMin = v;
    }
    // +1e-5 guards a min that sits a float epsilon under an integer.
    const du = Math.floor(uMin + 1e-5);
    const dv = Math.floor(vMin + 1e-5);
    for (let k = 0; k < 3; k++) {
      arr[(t + k) * 2] = ox + (arr[(t + k) * 2] - du) * sx;
      arr[(t + k) * 2 + 1] = oy + (arr[(t + k) * 2 + 1] - dv) * sy;
    }
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * WORLD-SPACE BOX PROJECTION — the fix for the cliff reading as a plank ramp.
 *
 * The NW cliff over B (source mesh 2, bin `rock-cliff`) carries the 2018
 * decompile's own UVs, and those UVs were authored for a face-on view: on the
 * SLOPED skirts they stretch along the slope, so a rock texture whose blocks are
 * 0.4 m square in plan draws them 1.5 m long on the incline. Stretched blocks
 * with parallel joints are what a plank IS, which is why the round-1 renders read
 * the cliff as wood no matter how rocky the canvas got
 * (`public/dustmap/shots/judge-r1/protrude-cliff.png`).
 *
 * So the cliff stops using the source UVs. Each triangle is projected on the
 * world axis its own normal points down — plan (x, z) for a roughly-horizontal
 * face, side (z, y) or (x, y) for a roughly-vertical one — and divided by the
 * bin's world tile size. Texel density is then a constant metres-per-tile over
 * every face in the bin, and the worst stretch anywhere is the sqrt(2) a 45
 * degree face costs any box mapping, against the 3-4x the source UVs had on the
 * skirts. It is per triangle, so no seam runs through a face; the seams land on
 * the silhouette edges where the dominant axis changes, which on a fractured
 * rock face is where a seam belongs.
 *
 * This is deliberately NOT a triplanar shader: a shader would cost an
 * onBeforeCompile, a third texture fetch per fragment and a material that no
 * longer merges with the bin, and the whole shell budget is ~20 colour draws
 * (CONSTRAINTS). Baking the UVs keeps it one geometry, one material, one draw.
 */
function boxProjectUV(geo: THREE.BufferGeometry, worldM: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nrm = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!pos || !nrm) return g;
  const uv = new Float32Array(pos.count * 2);
  for (let t = 0; t + 2 < pos.count; t += 3) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) {
      nx += nrm.getX(t + k);
      ny += nrm.getY(t + k);
      nz += nrm.getZ(t + k);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(t + k), y = pos.getY(t + k), z = pos.getZ(t + k);
      let u: number, v: number;
      if (ay >= ax && ay >= az) {
        u = x;
        v = z;
      } else if (ax >= az) {
        u = z;
        v = y;
      } else {
        u = x;
        v = y;
      }
      uv[(t + k) * 2] = u / worldM;
      uv[(t + k) * 2 + 1] = v / worldM;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Draw one source canvas into an atlas cell, with an edge-replicated gutter. */
function drawCell(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, cell: Cell, pad: number): Cell {
  const inner = { x: cell.x + pad, y: cell.y + pad, w: cell.w - pad * 2, h: cell.h - pad * 2 };
  ctx.drawImage(src, 0, 0, src.width, src.height, inner.x, inner.y, inner.w, inner.h);
  // gutter: stretch the 1 px border outward on all four sides + the corners
  ctx.drawImage(src, 0, 0, 1, src.height, inner.x - pad, inner.y, pad, inner.h);
  ctx.drawImage(src, src.width - 1, 0, 1, src.height, inner.x + inner.w, inner.y, pad, inner.h);
  ctx.drawImage(src, 0, 0, src.width, 1, inner.x, inner.y - pad, inner.w, pad);
  ctx.drawImage(src, 0, src.height - 1, src.width, 1, inner.x, inner.y + inner.h, inner.w, pad);
  ctx.drawImage(src, 0, 0, 1, 1, inner.x - pad, inner.y - pad, pad, pad);
  ctx.drawImage(src, src.width - 1, 0, 1, 1, inner.x + inner.w, inner.y - pad, pad, pad);
  ctx.drawImage(src, 0, src.height - 1, 1, 1, inner.x - pad, inner.y + inner.h, pad, pad);
  ctx.drawImage(src, src.width - 1, src.height - 1, 1, 1, inner.x + inner.w, inner.y + inner.h, pad, pad);
  return inner;
}

/**
 * MACRO VARIATION — spec-art §8, remaining flaw 3.
 *
 * The hero sandstone tile is 4.452 m; on long A's east wall and B site's west
 * wall that repeat sits inside one field of view and the eye finds it. The two
 * fixes spec-art offers are a vertex-colour channel written at merge time or a
 * decal plane on the two worst walls. This is the third and strictly better
 * one: a world-space, low-frequency VALUE modulation injected into the
 * material's own fragment shader.
 *
 *   * zero extra draw calls, zero extra texture memory, zero extra vertices
 *     (the vertex-colour route would need the shell subdivided, and the source
 *     walls are 30 m quads with four corners between them);
 *   * its wavelengths (18 m and 6.4 m) are irrational multiples of every bin's
 *     tile size, so it cannot beat with the repeat it is hiding;
 *   * it is VALUE ONLY — a multiply on albedo, exactly what every canvas recipe
 *     in dust-textures.ts already does, and it has no direction, so it cannot
 *     smuggle baked lighting into the albedo (the reviewer's gate).
 *
 * If three ever renames the chunks this hooks, the replace is a no-op and the
 * material renders unmodified: the guard below checks BOTH hooks landed before
 * declaring the varying, so a partial patch can never ship a linked shader that
 * reads an unwritten varying.
 */
/** The occlusion field built by `buildOcclusionField`, shared by every bin. */
export type OcclusionField = {
  tex: THREE.Data3DTexture;
  /** World position of voxel (0,0,0)'s corner. */
  origin: THREE.Vector3;
  /** 1 / (cell * dim) per axis — turns a world position into a 0..1 lookup. */
  inv: THREE.Vector3;
  /** How much of the DIRECTIONLESS fill a fully enclosed voxel keeps. */
  min: number;
  /** How much the DIRECTIONAL keys are multiplied by when fully enclosed. */
  fill: number;
  cells: number;
};

/**
 * The one shader patch every shell material gets: macro variation on albedo,
 * and (when a field is supplied) the AMBIENT OCCLUSION term.
 *
 * WHY AN OCCLUSION FIELD AND NOT A THIRD LIGHT — spec-art §8, remaining flaw 1.
 * The look-dev interiors measured luma sd 17.1 (t spawn) and 18.4 (tunnels)
 * against the source frames' 29.1 / 42.4, because a roofed corridor on this map
 * receives NO SUN AT ALL: every photon in there is hemi + ambient + env, all of
 * which are directionless, so every surface came out the same value and the
 * frame had no structure to read. Adding more directional fill does not fix
 * that — it lights every interior surface identically too, and it washes the
 * exteriors that are already correct.
 *
 * What actually separates an alcove from an open yard is VISIBILITY OF THE SKY,
 * which is exactly what ambient occlusion measures. This applies it where three
 * itself applies an aoMap — to `reflectedLight.indirectDiffuse`, AFTER
 * `<aomap_fragment>` — so it attenuates the ambient/hemi/env terms and NEVER
 * the sun. Two consequences worth stating plainly:
 *   * outdoors, where the sun carries the frame, it is nearly invisible;
 *     indoors, where indirect light IS the frame, it is the whole structure.
 *   * it is not "baked lighting in albedo" (the reviewer's gate, spec-art §7.3):
 *     albedo is untouched, the term has no direction, and it cannot encode a
 *     sun position — the same field renders identically at any time of day.
 *
 * The lookup is a 3D texture of the map's own geometry, sampled 0.6 m along the
 * world normal so a surface never occludes itself. `gl_FrontFacing` flips the
 * normal because 33 of 34 bins are DoubleSide and a corridor is seen from the
 * INSIDE of the shell.
 */
function applyShellShader(mat: THREE.MeshStandardMaterial, amount: number, seed: number, ao: OcclusionField | null): void {
  mat.userData.softwareCompatible = amount === 0;
  mat.onBeforeCompile = (shader) => {
    const wantMacro = amount > 0;
    if (!shader.vertexShader.includes("#include <fog_vertex>")) return;
    if (wantMacro && !shader.fragmentShader.includes("#include <map_fragment>")) return;
    if (ao && !shader.fragmentShader.includes("#include <aomap_fragment>")) return;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDustW;\nvarying vec3 vDustN;")
      .replace(
        "#include <fog_vertex>",
        "#include <fog_vertex>\n\tvDustW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n\tvDustN = normalize( mat3( modelMatrix ) * normal );",
      );
    if (ao) {
      shader.uniforms.uDustAO = { value: ao.tex };
      shader.uniforms.uDustAOOrigin = { value: ao.origin };
      shader.uniforms.uDustAOInv = { value: ao.inv };
      shader.uniforms.uDustAOMin = { value: ao.min };
      shader.uniforms.uDustFill = { value: ao.fill };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
precision highp sampler3D;
uniform sampler3D uDustAO;
uniform vec3 uDustAOOrigin;
uniform vec3 uDustAOInv;
uniform float uDustAOMin;
uniform float uDustFill;`,
        )
        .replace(
          "#include <aomap_fragment>",
          `#include <aomap_fragment>
{
  vec3 wn = gl_FrontFacing ? vDustN : -vDustN;
  vec3 ap = ( vDustW + wn * 0.6 - uDustAOOrigin ) * uDustAOInv;
  float openness = texture( uDustAO, clamp( ap, vec3( 0.001 ), vec3( 0.999 ) ) ).r;
  reflectedLight.indirectDiffuse *= mix( uDustAOMin, 1.0, openness );
  // Enclosure gate: nothing above 0.75 openness is touched, so every open
  // exterior surface keeps the sun exactly as the look-dev rig lit it. Below
  // it, the two shadowless axis keys come up to stand in for the many warm
  // bounces a real sandstone corridor makes and this renderer does not.
  reflectedLight.directDiffuse *= mix( uDustFill, 1.0, smoothstep( 0.28, 0.84, openness ) );
}`,
        );
    }
    if (!wantMacro) {
      // still need the varyings declared on BOTH stages or the program fails
      if (!shader.fragmentShader.includes("varying vec3 vDustW;")) {
        shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vDustW;\nvarying vec3 vDustN;");
      }
      return;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vDustW;
varying vec3 vDustN;
float dustHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float dustNoise( vec3 p ) {
  vec3 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( dustHash( i ), dustHash( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( dustHash( i + vec3( 0, 1, 0 ) ), dustHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( dustHash( i + vec3( 0, 0, 1 ) ), dustHash( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( dustHash( i + vec3( 0, 1, 1 ) ), dustHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
{
  vec3 mp = vDustW + vec3( ${seed.toFixed(1)} );
  // 18 m macro sweep + a 6.4 m break-up, both irrational against every bin
  // tile size (4.452 / 1.408 / 5.631 / 6.502 / 3.251 / 1.626 / 2.438 / 7.075).
  float m = dustNoise( mp * 0.05556 ) * 0.68 + dustNoise( mp * 0.15625 ) * 0.32;
  diffuseColor.rgb *= 1.0 + ( m - 0.5 ) * ${(amount * 2).toFixed(3)};
}`,
      );
  };
  mat.customProgramCacheKey = () => `dust-shell-${amount}-${seed}-${ao ? 1 : 0}`;
  mat.needsUpdate = true;
}

/**
 * Build the map's own sky-visibility field: a 3D texture where 1 = wide open
 * and 0 = fully enclosed, sampled by every shell material (see
 * `applyShellShader`).
 *
 * Method, and why it is cheap enough to run at boot:
 *  1. RASTERISE. Every shell triangle is sampled on a barycentric lattice at
 *     `SAMPLE_M` spacing and each sample marks one voxel occupied. That is
 *     O(surface area), not O(voxels x triangles) — 17.7k m2 of shell at 0.45 m
 *     spacing is ~90k samples, a couple of milliseconds. An exact
 *     triangle-versus-box test would be 30x the work for a field that is about
 *     to be blurred by 2 m anyway.
 *  2. BLUR, separably, with a tent kernel of radius R. Three 1D passes over
 *     the grid instead of one (2R+1)^3 gather: 246k voxels x 5 taps x 3 axes.
 *     The result at a voxel is "what fraction of the 2 m neighbourhood is
 *     solid", which is a serviceable ambient visibility term.
 *  3. INVERT and encode to a byte. Outside the grid the sampler clamps, and the
 *     grid is padded 3 m past the map bounds with empty cells, so anything out
 *     of bounds reads fully open and the backdrop is never darkened.
 *
 * The floor is deliberately part of the occluder set: a corner where a wall
 * meets a floor SHOULD sit darker than the middle of the same wall, and that
 * contact is most of what "value structure" means in an untextured corridor.
 */
function buildOcclusionField(geos: THREE.BufferGeometry[]): OcclusionField | null {
  // Tuned by measurement, not taste. CELL 1.0 + RADIUS 2 (a 4 m gather) makes
  // the field ROOM-scale: every voxel inside a corridor reads the same
  // enclosure, so the whole passage dimmed by the same amount and the frame's
  // luma sd went DOWN (measured: tunnels 17.8 -> 13.7). The term has to vary
  // ACROSS the frame to be structure, so the gather is now 1.5 m: a wall-floor
  // junction darkens and the middle of the same wall does not.
  const CELL = 0.75;
  const PAD = 3;
  const SAMPLE_M = 0.4;
  const RADIUS = 1;
  const AO_MIN = 0.30;
  /**
   * INTERREFLECTION STAND-IN. See `applyShellShader`: an enclosed voxel keeps
   * only AO_MIN of the directionless fill but multiplies the two shadowless
   * axis keys by this, so a corridor is lit by a DIRECTION instead of by
   * everything at once. Measured on the two interior POVs by turning the same
   * trade-off on globally (axis key 3.0 / hemi 0.12 / ambient 0.04):
   * t-spawn luma sd 18.5 -> 30.7, tunnels 17.7 -> 28.6. Doing it globally
   * would have flattened every exterior shadow, hence the enclosure gate.
   */
  const FILL_BOOST = 5.8;
  // CONSTRAINTS bounds, padded. Hard-coded rather than measured off the merged
  // geometry so the field is identical whatever the backdrop does.
  const minX = -65.024 - PAD;
  const maxX = 48.768 + PAD;
  const minY = -4.877 - PAD;
  const maxY = 10.566 + PAD;
  const minZ = -95.91 - PAD;
  const maxZ = 39.014 + PAD;
  const nx = Math.ceil((maxX - minX) / CELL);
  const ny = Math.ceil((maxY - minY) / CELL);
  const nz = Math.ceil((maxZ - minZ) / CELL);
  const n = nx * ny * nz;
  if (!n || n > 4_000_000) return null;

  let solid = new Float32Array(n);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const p = new THREE.Vector3();
  const mark = (x: number, y: number, z: number): void => {
    const ix = ((x - minX) / CELL) | 0;
    const iy = ((y - minY) / CELL) | 0;
    const iz = ((z - minZ) / CELL) | 0;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
    solid[(iz * ny + iy) * nx + ix] = 1;
  };
  let samples = 0;
  for (const g of geos) {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const idx = g.index;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < tris; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      const steps = Math.min(64, Math.max(1, Math.ceil(Math.max(e1.length(), e2.length()) / SAMPLE_M)));
      const inv = 1 / steps;
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; i + j <= steps; j++) {
          p.copy(a).addScaledVector(e1, i * inv).addScaledVector(e2, j * inv);
          mark(p.x, p.y, p.z);
          samples++;
        }
      }
    }
  }
  if (!samples) return null;

  // separable tent blur
  const tmp = new Float32Array(n);
  const kernel: number[] = [];
  let ksum = 0;
  for (let k = -RADIUS; k <= RADIUS; k++) {
    const w = RADIUS + 1 - Math.abs(k);
    kernel.push(w);
    ksum += w;
  }
  const blurAxis = (src: Float32Array, dst: Float32Array, axis: 0 | 1 | 2): void => {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let acc = 0;
          for (let k = -RADIUS; k <= RADIUS; k++) {
            let sx = x;
            let sy = y;
            let sz = z;
            if (axis === 0) sx += k;
            else if (axis === 1) sy += k;
            else sz += k;
            if (sx < 0 || sy < 0 || sz < 0 || sx >= nx || sy >= ny || sz >= nz) continue;
            acc += src[(sz * ny + sy) * nx + sx] * kernel[k + RADIUS];
          }
          dst[(z * ny + y) * nx + x] = acc / ksum;
        }
      }
    }
  };
  blurAxis(solid, tmp, 0);
  blurAxis(tmp, solid, 1);
  blurAxis(solid, tmp, 2);
  solid = tmp;

  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // Normalise: a fully solid neighbourhood reads 1, and empirically a roofed
    // corridor sits near 0.45, so 1.6x maps "corridor" onto "dark" without
    // clipping the open sites to 1.
    const occ = Math.min(1, solid[i] * 1.7);
    data[i] = Math.round((1 - occ) * 255);
  }
  const tex = new THREE.Data3DTexture(data, nx, ny, nz);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return {
    tex,
    origin: new THREE.Vector3(minX, minY, minZ),
    inv: new THREE.Vector3(1 / (nx * CELL), 1 / (ny * CELL), 1 / (nz * CELL)),
    min: AO_MIN,
    fill: FILL_BOOST,
    cells: n,
  };
}

// ================================================================ builder ===

export type DustWorldApi = WorldApi & {
  /** The MapDef the sim is running — QA reads bounds/floorY off this. */
  map: MapDef;
  /** Build receipts, for the report and for qa. */
  stats: Record<string, number | string>;
};

export async function buildDustWorld(renderer: AnyRenderer): Promise<DustWorldApi> {
  await DT.preloadTextures(isSoftwareGL(renderer));
  // MSAA level decides whether alphaToCoverage means anything (textures.ts).
  // Thread it to EVERY alphaTest material: MSAA antialiases geometry edges, and
  // a cutout silhouette is a per-fragment discard it cannot see. On dust2 that
  // is the bomb-X decals, the two backdrop card rings and the crate stencils.
  const cutoutAA = aaSamples(renderer) > 0;
  const map = activeMap();

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(ENVV.fog.hex, ENVV.fog.near, ENVV.fog.far);
  scene.background = DT.desertSkyTex();

  // PMREM from the SKY ALONE, built before a single light is added, so
  // scene.environment is sky irradiance and not a bake of the sun
  // (jungle-world.ts:62-70).
  if (isSoftwareGL(renderer)) softwareSky(scene);
  else try {
    scene.environment = await pmremEnv(renderer, scene, 0.04);
  } catch {
    scene.environment = null;
  }

  // ------------------------------------------------------------- lights ---
  const hemi = new THREE.HemisphereLight(ENVV.hemi.sky, ENVV.hemi.ground, ENVV.hemi.intensity);
  scene.add(hemi);
  const bounce = new THREE.DirectionalLight(ENVV.bounce.hex, ENVV.bounce.intensity);
  bounce.position.set(ENVV.bounce.pos[0], ENVV.bounce.pos[1], ENVV.bounce.pos[2]);
  scene.add(bounce);
  scene.add(new THREE.AmbientLight(ENVV.ambient.hex, ENVV.ambient.intensity));
  for (const f of ENVV.axisFills) {
    const l = new THREE.DirectionalLight(f.hex, f.intensity);
    l.position.set(f.from[0] * 60, f.from[1] * 60, f.from[2] * 60);
    scene.add(l);
  }

  const sun = new THREE.DirectionalLight(ENVV.sun.hex, ENVV.sun.intensity);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - ENVV.sun.elevationDeg),
    THREE.MathUtils.degToRad(ENVV.sun.azimuthDeg),
  );
  sun.position.copy(sunDir).multiplyScalar(ENVV.sun.radius);
  sun.castShadow = true;
  sun.shadow.mapSize.set(ENVV.shadow.size, ENVV.shadow.size);
  sun.shadow.camera.near = ENVV.shadow.near;
  sun.shadow.camera.far = ENVV.shadow.far;
  sun.shadow.camera.left = -ENVV.shadow.half;
  sun.shadow.camera.right = ENVV.shadow.half;
  sun.shadow.camera.top = ENVV.shadow.half;
  sun.shadow.camera.bottom = -ENVV.shadow.half;
  sun.shadow.bias = ENVV.shadow.bias;
  sun.shadow.normalBias = ENVV.shadow.normalBias;
  sun.shadow.radius = ENVV.shadow.radius;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  const root = new THREE.Group();
  root.name = "dust2";
  scene.add(root);

  // ---------------------------------------------------------------- GLB ---
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(assetUrl("/assets/models/dust2/dust2-game.glb"));
  gltf.scene.updateMatrixWorld(true);

  // The LOCKED frame is measured from the `de_dust2`-prefixed child, NOT from
  // the file root: the Sketchfab wrapper carries a 0.013333 scale and a flip of
  // its own, and inheriting it would put the whole map at 52 % scale.
  // GLTFLoader sanitises dotted node names, so match by prefix, never equality.
  let inner: THREE.Object3D | null = null;
  gltf.scene.traverse((o) => {
    if (!inner && /^de_dust2/.test(o.name)) inner = o;
  });
  const innerNode: THREE.Object3D = inner ?? gltf.scene;
  const frame = new THREE.Matrix4().makeScale(U, -U, -U);
  const toGame = new THREE.Matrix4();
  const invInner = new THREE.Matrix4().copy(innerNode.matrixWorld).invert();

  const srcByMat = new Map<number, SrcMat>(SRC.map((s) => [s.mat, s]));
  /** Every source primitive, keyed by its document material index. */
  const prims = new Map<number, { geo: THREE.BufferGeometry; src: SrcMat }>();
  const unmapped: string[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const matName = (Array.isArray(m.material) ? m.material[0] : m.material)?.name ?? "";
    const tag = /^dustmat_(\d+)$/.exec(matName);
    const idx = tag ? Number(tag[1]) : SRC_MAT_NAME_ORDER.indexOf(matName);
    const src = idx >= 0 ? srcByMat.get(idx) : undefined;
    if (!src) {
      unmapped.push(`${m.name}:${matName}`);
      return;
    }
    const geo = m.geometry.clone();
    bakeFloat(geo, "position", 3);
    bakeFloat(geo, "normal", 3);
    bakeFloat(geo, "uv", 2);
    stripToCore(geo);
    toGame.multiplyMatrices(frame, toGame.multiplyMatrices(invInner, m.matrixWorld));
    geo.applyMatrix4(toGame);
    // 5 mm lift on the two bomb-X quads: they are EXACTLY coplanar with the
    // floor under them (42 m2 of decal at y 0 and y +2.438) and they are the
    // z-fight pair a player's eye is closest to. polygonOffset alone leaves a
    // shimmer at grazing angles; the lift is applied here because the meshes
    // are about to be merged away and there is no `mesh.position` left to move.
    if (src.bin === "bomb-x") geo.translate(0, BOMB_LIFT, 0);
    prims.set(src.mat, { geo, src });
  });
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });

  // ------------------------------------------------------------- atlases ---
  const doorAtlas = buildDoorAtlas();
  const signAtlas = buildSignAtlas();
  const bombAtlas = buildBombAtlas();

  // -------------------------------------------------------------- merge ---
  // One geometry list per DRAW. Tiled bins keep their own repeating texture and
  // their own list; the fitted families all land in the atlas list of their
  // bin. The plaque pair and the north stub get their own lists so they can be
  // tagged qaIgnore without pulling the rest of the bin out of QA.
  const lists = new Map<string, THREE.BufferGeometry[]>();
  const push = (key: string, g: THREE.BufferGeometry): void => {
    let l = lists.get(key);
    if (!l) lists.set(key, (l = []));
    l.push(g);
  };

  for (const [, { geo, src }] of prims) {
    const binM = BIN_WORLD_M[src.bin];
    const cell = src.bin === "wooden-door" ? doorAtlas.cells[src.variant!] : src.bin === "signage" ? signAtlas.cells[src.variant!] : src.bin === "bomb-x" ? bombAtlas.cells[src.variant!] : null;
    let g: THREE.BufferGeometry;
    if (cell) {
      const atlas = src.bin === "wooden-door" ? doorAtlas : src.bin === "signage" ? signAtlas : bombAtlas;
      g = fitToCell(geo, cell, atlas.w, atlas.h, src.uvScale ?? 1);
    } else {
      // TILED: bake uvScale straight into the merged UV attribute, so one bin
      // stays one material and one draw (spec-art §7.2). texture.repeat would
      // have cost a clone and a draw per distinct scale.
      g = geo;
      const s = src.uvScale ?? (src.srcM && binM ? src.srcM / binM : 1);
      if (s !== 1) {
        const uv = g.getAttribute("uv") as THREE.BufferAttribute;
        const a = uv.array as Float32Array;
        for (let i = 0; i < a.length; i++) a[i] *= s;
        uv.needsUpdate = true;
      }
    }
    const key = src.bin === "metal-frame" ? `metal-${src.variant}` : src.bin;
    if (PLAQUE_MESHES.has(src.mesh)) push("plaque", g);
    else if (src.mesh === 0 || src.mesh === 27) {
      // Split the detached north wall stub (27 triangles past z = +31) out of
      // the two bins that reach it. CONSTRAINTS excludes it from bounds,
      // minimap and colliders; leaving it inside the tagged shell element would
      // hand collider-audit 27 triangles of visual with no collider behind it.
      const [keep, stub] = splitByZ(g, STUB_Z);
      if (keep) push(key, keep);
      if (stub) push(`stub-${key}`, stub);
    } else push(key, g);
  }

  // ---------------------------------------------------- crate CNVS decals ---
  // spec-art §8 flaw 7: the crate canvas is deliberately wordmark-free because
  // text in a TILING material prints twice on one face and is cut at thirds on
  // the next. The stencil goes on decal quads, one per qualifying face, which
  // is what a stencil physically is. Built BEFORE the merge, off the crate
  // bin's own world-space triangles, so a stencil can only land ON a crate.
  const decals = buildCrateDecals(lists.get("crate-wood") ?? null, cutoutAA);

  // Merge every list to one geometry, THEN build the occlusion field from the
  // result, THEN build the materials that sample it: the field is a function of
  // the finished shell, so the order is forced.
  const mergedGeos = new Map<string, THREE.BufferGeometry>();
  for (const [key, l] of lists) {
    if (!l.length) continue;
    const merged = mergeGeometries(l, false);
    for (const g of l) g.dispose();
    if (!merged) continue;
    // The cliff's source UVs stretch on every sloped face — see boxProjectUV.
    const finalGeo = key === "rock-cliff" ? boxProjectUV(merged, BIN_WORLD_M["rock-cliff"] ?? 7.075) : merged;
    finalGeo.computeBoundingSphere();
    mergedGeos.set(key, finalGeo);
  }
  // The plaque and the north stub are out-of-bounds dressing; a floating plate
  // must not print a dark patch on the ground under it.
  const occluders: THREE.BufferGeometry[] = [];
  for (const [key, g] of mergedGeos) if (key !== "plaque" && !key.startsWith("stub-")) occluders.push(g);
  const aoT0 = performance.now();
  const aoField = buildOcclusionField(occluders);
  const aoMs = +(performance.now() - aoT0).toFixed(1);

  const mats = buildBinMaterials(doorAtlas.tex, signAtlas.tex, bombAtlas.tex, cutoutAA, aoField, isSoftwareGL(renderer));

  const shellMeshes: THREE.Mesh[] = [];
  const addMerged = (key: string, mat: THREE.Material, kind: string, qaId: string, solid: boolean, ignore = false): THREE.Mesh | null => {
    const merged = mergedGeos.get(key);
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = qaId;
    mesh.userData.kind = kind;
    mesh.userData.qaId = qaId;
    mesh.userData.solid = solid;
    if (ignore) mesh.userData.qaIgnore = true;
    root.add(mesh);
    shellMeshes.push(mesh);
    return mesh;
  };

  addMerged("sandstone-wall", mats.sandstone, "shell", "shell-sandstone-wall", true);
  addMerged("arch-brick", mats.archBrick, "shell", "shell-arch-brick", true);
  addMerged("coping-trim", mats.coping, "shell", "shell-coping-trim", true);
  addMerged("adobe-plaster", mats.adobe, "floor", "floor-adobe-deck", true);
  addMerged("cobble-floor", mats.cobble, "floor", "floor-cobble", true);
  addMerged("sand-floor", mats.sand, "floor", "floor-sand", true);
  addMerged("plank-wood", mats.plank, "floor", "floor-plank", true);
  addMerged("crate-wood", mats.crate, "cover", "cover-crates", true);
  addMerged("rock-cliff", mats.cliff, "shell", "shell-rock-cliff", true);
  addMerged("wooden-door", mats.door, "door", "door-atlas", true);
  addMerged("metal-panel", mats.metalPanel, "cover", "cover-metal-panel", true);
  addMerged("metal-hazard", mats.metalHazard, "cover", "cover-metal-hazard", true);
  addMerged("metal-rust", mats.metalRust, "prop", "prop-metal-rust", true);
  addMerged("metal-tube", mats.metalTube, "prop", "prop-metal-tube", false);
  addMerged("signage", mats.signage, "sign", "sign-cnvs", false);
  addMerged("bomb-x", mats.bombX, "sign", "sign-bomb-x", false);
  // Out-of-bounds dressing: rendered, never audited (CONSTRAINTS).
  addMerged("plaque", mats.signage, "sign", "sign-plaque-oob", false, true);
  addMerged("stub-coping-trim", mats.coping, "shell", "shell-stub-coping", false, true);
  addMerged("stub-sandstone-wall", mats.sandstone, "shell", "shell-stub-sandstone", false, true);

  const shellDraws = shellMeshes.length;

  if (decals) {
    decals.userData.kind = "decal";
    decals.userData.qaId = "decal-crate-stencils";
    decals.userData.solid = false;
    root.add(decals);
  }

  const windows = buildArchWindows(cutoutAA);
  if (windows) {
    windows.userData.kind = "decal";
    windows.userData.qaId = "decal-arch-windows";
    windows.userData.solid = false;
    root.add(windows);
  }

  // ------------------------------------------------------------ backdrop ---
  const backdrop = buildBackdrop(cutoutAA);
  backdrop.userData.kind = "backdrop";
  backdrop.userData.qaId = "backdrop-desert";
  backdrop.userData.solid = false;
  backdrop.userData.qaIgnore = true;
  root.add(backdrop);

  // --------------------------------------------------------------- props ---
  const props = buildRoofProps();
  props.userData.kind = "prop";
  props.userData.qaId = "prop-rooftop-dressing";
  props.userData.solid = false;
  props.userData.qaIgnore = true;
  root.add(props);

  // ------------------------------------------------------------------ fx ---
  const motes = buildDustMotes();
  motes.userData.kind = "fx";
  motes.userData.qaId = "fx-dust-motes";
  motes.userData.solid = false;
  motes.userData.qaIgnore = true;
  root.add(motes);

  const rays = buildGodRays();
  rays.userData.kind = "fx";
  rays.userData.qaId = "fx-god-rays";
  rays.userData.solid = false;
  rays.userData.qaIgnore = true;
  root.add(rays);

  // ------------------------------------- camera-following shadow frustum ---
  // +/-38 m over a 4096 map is 18.6 mm/texel. The jungle map's fixed +/-28 box
  // would crop every shadow outside one building on a 114 x 135 m map, so the
  // box follows the camera.
  //
  // It is driven from `scene.onBeforeRender`, NOT from update(dt, cam), because
  // the shadow must track the camera that is ACTUALLY BEING RENDERED. game.ts
  // reuses one camera object for first person, the killcam and the spectate
  // orbit, and `__test.renderWith()` moves that camera and renders WITHOUT
  // running a sim tick — so an update()-driven frustum would light the killcam
  // from wherever the player was standing. three calls scene.onBeforeRender
  // before projectObject() and before shadowMap.render(), so a target written
  // here lands in the same frame's shadow pass.
  const shadowFocus = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const followSun = stableSunFollow(sun, sunDir, ENVV.sun.radius, "dust2/sun");
  const prevOnBefore = scene.onBeforeRender;
  // three calls this as `scene.onBeforeRender(renderer, scene, camera, target)`
  // but types it with the full Object3D arity — forward whatever arrives.
  type BeforeArgs = Parameters<THREE.Object3D["onBeforeRender"]>;
  scene.onBeforeRender = function (this: THREE.Scene, ...args: BeforeArgs): void {
    prevOnBefore.apply(this, args);
    const camera = args[2];
    if (!camera) return;
    camera.getWorldDirection(camDir);
    // Aim the box a little AHEAD of the eye: a player looks down a 70 m lane
    // and the shadows that matter are in front, not behind.
    shadowFocus.copy(camera.position).addScaledVector(camDir, 16);
    if (shadowFocus.y < FLOOR_Y) shadowFocus.y = FLOOR_Y;
    // ZERO-FLICKER: whole-texel moves only, or every shadow edge crawls as you walk.
    followSun(shadowFocus);
  };

  // ----------------------------------------------------------- animation ---
  const motePos = (motes.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const moteSeed = new Float32Array(motePos.length / 3);
  for (let i = 0; i < moteSeed.length; i++) moteSeed[i] = (i % 97) * 0.0647;
  let t = 0;

  const stats: Record<string, number | string> = {
    shellDraws,
    sourcePrimitives: prims.size,
    unmapped: unmapped.length,
    binMaterials: Object.keys(mats).length,
    canvases: DT.texturesBuilt(),
    occlusionMs: aoMs,
    occlusionCells: aoField?.cells ?? 0,
    props: ROOF_PROPS.length,
    containers: CONTAINER_YARD.length,
    crateDecals: decals ? decals.userData.count ?? 0 : 0,
    frame: "scale(0.0254, -0.0254, -0.0254) det +1",
  };
  if (unmapped.length) console.warn("[dust2] unmapped source materials:", unmapped.join(", "));

  return {
    scene,
    sun,
    root,
    map,
    stats,
    // ALLOCATION-FREE. Runs every frame at 128 Hz worst case; a Vector3 per
    // mote per frame is 2000 objects a second into the nursery.
    update: (dt: number): void => {
      t += dt;
      for (let i = 0; i < moteSeed.length; i++) {
        const j = i * 3;
        let y = motePos[j + 1] - dt * (0.09 + (i % 5) * 0.018);
        if (y < FLOOR_Y) y = FLOOR_Y + 11 + (i % 4);
        motePos[j + 1] = y;
        motePos[j] += Math.sin(t * 0.42 + moteSeed[i] * 11) * dt * 0.22;
        motePos[j + 2] += Math.cos(t * 0.37 + moteSeed[i] * 7) * dt * 0.22;
      }
      (motes.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    },
  };
}

// =========================================================== sub-builders ===

/**
 * Material name -> glTF document material index for the UNTOUCHED source file.
 * The shipped asset stamps `dustmat_<index>` into the name so this table is
 * never needed, but it is the documented fallback if anyone points the world
 * builder at `dust/de_dust2_-_cs_map.glb`: the source's material names are
 * sorted LEXICALLY against their indices, so "material_10" is index 2 and
 * parsing the number out of the name silently mis-bins 32 of 34 materials.
 */
const SRC_MAT_NAME_ORDER = [
  "material_0", "material_1", "material_10", "material_11", "material_12", "material_13",
  "material_14", "material_15", "material_16", "material_17", "material_18", "material_19",
  "material_2", "material_20", "material_21", "material_22", "material_23", "material_24",
  "material_25", "material_26", "material_27", "material_28", "material_29", "material_3",
  "material_30", "material_31", "material_32", "material_33", "material_4", "material_5",
  "material_6", "material_7", "material_8", "material_9",
];

/** Split a merged geometry into (z <= zCut, z > zCut) by triangle centroid. */
function splitByZ(geo: THREE.BufferGeometry, zCut: number): [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const keep: number[] = [];
  const out: number[] = [];
  for (let t = 0; t < pos.count; t += 3) {
    const zc = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    (zc > zCut ? out : keep).push(t);
  }
  if (!out.length) return [g, null];
  if (!keep.length) return [null, g];
  const take = (tris: number[]): THREE.BufferGeometry => {
    const sub = new THREE.BufferGeometry();
    for (const name of ["position", "normal", "uv"]) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (!a) continue;
      const n = a.itemSize;
      const dst = new Float32Array(tris.length * 3 * n);
      let w = 0;
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          for (let c = 0; c < n; c++) dst[w++] = (a.array as ArrayLike<number>)[(t + k) * n + c];
        }
      }
      sub.setAttribute(name, new THREE.BufferAttribute(dst, n));
    }
    return sub;
  };
  const a = take(keep);
  const b = take(out);
  g.dispose();
  return [a, b];
}

type Atlas = { tex: THREE.CanvasTexture; w: number; h: number; cells: Record<string, Cell> };

/** 4 door variants at 512 in a 1024 atlas. The DETAIL-2 source canvases are
 *  1024 each, so drawing them into a 512 cell is a free 2x supersample AND a
 *  4x VRAM saving over shipping four 1024 textures. */
function buildDoorAtlas(): Atlas {
  const W = 1024;
  const PAD = 6;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = W;
  const ctx = c.getContext("2d")!;
  const layout: Record<string, Cell> = {
    plain: { x: 0, y: 0, w: 512, h: 512 },
    A: { x: 512, y: 0, w: 512, h: 512 },
    B: { x: 0, y: 512, w: 512, h: 512 },
    EXIT: { x: 512, y: 512, w: 512, h: 512 },
  };
  const cells: Record<string, Cell> = {};
  for (const [k, cell] of Object.entries(layout)) {
    const src = DT.woodDoorTex(k === "plain" ? null : k).image as HTMLCanvasElement;
    cells[k] = drawCell(ctx, src, cell, PAD);
  }
  return { tex: atlasTex(c), w: W, h: W, cells };
}

/**
 * Nine fitted signage plates in ONE 1024 atlas.
 *
 * Cell sizes are chosen by what has to stay legible, not by symmetry:
 *  - `cnvs-credit` is 512 over a 3.251 m plate (157 texels/m) because it is the
 *    plate that CARRIES THE CC-BY-4.0 ATTRIBUTION and a player must be able to
 *    walk up and read it;
 *  - `wayfind-A` is 512 over 4.452 m (115 texels/m), matching the sandstone bin
 *    exactly so the panel reads as the wall with a mark on it;
 *  - the two billboards get 512 x 128, which at their 2-tile UV span is 64
 *    texels/m — parity with the 256 x 64 source they replace;
 *  - the two flat backing boxes are uniform brushed plate and get 128.
 * Not atlasing this family would cost 8 extra draws AND ~37 MB of VRAM (the
 * DETAIL-2 canvases are 1024-2048 px each); the atlas is 5.6 MB.
 */
function buildSignAtlas(): Atlas {
  const W = 1024;
  const PAD = 6;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = W;
  const ctx = c.getContext("2d")!;
  const src: Record<string, HTMLCanvasElement> = {
    "cnvs-credit": DT.cnvsCreditPlateTex().image,
    "wayfind-A": DT.wayfindPanelTex("A").image,
    tag: DT.wayfindPanelTex("TAG", 512, 5566, 6.296).image,
    "billboard-0": DT.cnvsBillboardTex(0).image,
    "billboard-1": DT.cnvsBillboardTex(1).image,
    "wayfind-B": DT.wayfindPanelTex("B").image,
    "cnvs-neutral": DT.cnvsNeutralPlateTex().image,
    "plate-dark": DT.plateTex("dark").image,
    "plate-bone": DT.plateTex("bone").image,
  };
  const layout: Record<string, Cell> = {
    "cnvs-credit": { x: 0, y: 0, w: 512, h: 512 },
    "wayfind-A": { x: 512, y: 0, w: 512, h: 512 },
    tag: { x: 0, y: 512, w: 512, h: 512 },
    "billboard-0": { x: 512, y: 512, w: 512, h: 128 },
    "billboard-1": { x: 512, y: 640, w: 512, h: 128 },
    "wayfind-B": { x: 512, y: 768, w: 256, h: 256 },
    "cnvs-neutral": { x: 768, y: 768, w: 256, h: 128 },
    "plate-dark": { x: 768, y: 896, w: 128, h: 128 },
    "plate-bone": { x: 896, y: 896, w: 128, h: 128 },
  };
  const cells: Record<string, Cell> = {};
  for (const [k, cell] of Object.entries(layout)) cells[k] = drawCell(ctx, src[k], cell, PAD);
  return { tex: atlasTex(c), w: W, h: W, cells };
}

/** The two bomb-X decals, 512 each, in one 1024 x 512 alphaTest atlas. */
function buildBombAtlas(): Atlas {
  const W = 1024;
  const H = 512;
  const PAD = 6;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  const cells: Record<string, Cell> = {
    A: drawCell(ctx, DT.bombXTex("A").image, { x: 0, y: 0, w: 512, h: 512 }, PAD),
    B: drawCell(ctx, DT.bombXTex("B").image, { x: 512, y: 0, w: 512, h: 512 }, PAD),
  };
  return { tex: atlasTex(c), w: W, h: H, cells };
}

/** Atlas textures are still RepeatWrapping — the UVs are rebaked into [0,1] so
 *  wrapping never fires, and Repeat is the mode the rest of the file uses. */
function atlasTex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = ANISO;
  return t;
}

type BinMats = {
  sandstone: THREE.MeshStandardMaterial;
  archBrick: THREE.MeshStandardMaterial;
  coping: THREE.MeshStandardMaterial;
  adobe: THREE.MeshStandardMaterial;
  cobble: THREE.MeshStandardMaterial;
  sand: THREE.MeshStandardMaterial;
  plank: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
  cliff: THREE.MeshStandardMaterial;
  door: THREE.MeshStandardMaterial;
  metalPanel: THREE.MeshStandardMaterial;
  metalHazard: THREE.MeshStandardMaterial;
  metalRust: THREE.MeshStandardMaterial;
  metalTube: THREE.MeshStandardMaterial;
  signage: THREE.MeshStandardMaterial;
  bombX: THREE.MeshStandardMaterial;
};

function buildBinMaterials(door: THREE.Texture, sign: THREE.Texture, bomb: THREE.Texture, cutoutAA: boolean, ao: OcclusionField | null, lowDetail = false): BinMats {
  const zfight = (m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial => {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1.2;
    m.polygonOffsetUnits = -1.4;
    return m;
  };
  const std = (p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...p });

  const sandstone = std({ map: DT.sandstoneWallTex(4.452, 512), color: 0xb3aa96, roughness: 0.93, metalness: 0.02, envMapIntensity: 0.85 });
  const archBrick = std({ map: DT.archBrickTex(4.452, 512), color: 0xb6ad98, roughness: 0.9, metalness: 0.02, envMapIntensity: 0.85 });
  const coping = zfight(std({ map: DT.copingTrimTex(1.408, 256, 128), color: 0xc0b8a2, roughness: 0.88, metalness: 0.02, envMapIntensity: 0.9 }));
  const adobe = std({
    map: DT.adobePlasterTex(5.631, 512),
    color: 0xb4a684,
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.8,
    // 742 m2 of this is roofed soffit the sun never reaches: the same interior
    // lift the jungle map gives its container ceilings (report-render 2.9).
    // An emissive lift is ADDITIVE: it raises a frame's mean without raising
    // its spread, so at look-dev's 0.40 it was actively flattening the roofed
    // sections it was meant to rescue. 0.26 keeps the soffits off the darkgate
    // floor and lets the axis keys do the shaping.
    emissive: 0x2a2015,
    emissiveIntensity: 0.26,
  });
  const cobble = std({ map: DT.cobbleFloorTex(6.502, 512), color: 0xa89c86, roughness: 0.96, metalness: 0, envMapIntensity: 0.8 });
  const sand = std({ map: DT.sandFloorTex(3.251, 512), color: 0xbfb298, roughness: 0.97, metalness: 0, envMapIntensity: 0.8 });
  const plank = zfight(std({ map: DT.plankWoodTex(1.626, 512), color: 0xa89878, roughness: 0.92, metalness: 0, envMapIntensity: 0.8 }));
  const crate = std({ map: DT.crateWoodTex(2.438, 512), color: 0xb4a68a, roughness: 0.9, metalness: 0, envMapIntensity: 0.8 });
  const cliff = zfight(std({ map: DT.rockCliffTex(7.075, 512), color: 0xa89a82, roughness: 0.98, metalness: 0, envMapIntensity: 0.8 }));

  const metalBase = { color: 0xb0b498, roughness: 0.7, metalness: 0.2, envMapIntensity: 0.9 };
  const out: BinMats = {
    sandstone,
    archBrick,
    coping,
    adobe,
    cobble,
    sand,
    plank,
    crate,
    cliff,
    door: std({ map: door, color: 0xbdb096, roughness: 0.86, metalness: 0.03, envMapIntensity: 0.75 }),
    metalPanel: zfight(std({ map: DT.metalPanelTex(1.626, 256, 6120, false), ...metalBase })),
    // Material 25 is the ONE single-sided source material in the whole map.
    metalHazard: zfight(new THREE.MeshStandardMaterial({ map: DT.metalPanelTex(1.626, 256, 6121, true), side: THREE.FrontSide, ...metalBase })),
    metalRust: zfight(std({ map: DT.rustSteelTex(1.626, 128), ...metalBase })),
    metalTube: zfight(std({ map: DT.tubeTex(64), color: 0x9c9484, roughness: 0.7, metalness: 0.2, emissive: 0xe8d8b4, emissiveIntensity: 0.34 })),
    signage: std({ map: sign, color: 0xc0b8a6, roughness: 0.8, metalness: 0.05, envMapIntensity: 0.85 }),
    bombX: (() => {
      const m = zfight(std({ map: bomb, color: 0xffffff, roughness: 0.95, metalness: 0, alphaTest: 0.5, transparent: false }));
      // alphaToCoverage is mandatory on every alphaTest material (CONSTRAINTS):
      // MSAA cannot see a per-fragment discard, so without it the paint edge
      // staircases at exactly the range a planted bomb is looked at.
      m.alphaToCoverage = cutoutAA;
      return m;
    })(),
  };

  // MACRO VARIATION (spec-art §8 flaw 3) goes on the five surfaces whose tile
  // lands inside a player's field of view on the map's longest uninterrupted
  // walls and floors; seeds differ so two adjacent bins never share a blotch.
  // The OCCLUSION FIELD goes on EVERY bin — a door standing in a dark tunnel
  // has to sit in the same light as the wall beside it, or the seam shows.
  const MACRO: Partial<Record<keyof BinMats, [number, number]>> = {
    sandstone: [0.1, 0],
    archBrick: [0.08, 130],
    cliff: [0.1, 260],
    cobble: [0.07, 390],
    sand: [0.07, 520],
  };
  for (const key of Object.keys(out) as (keyof BinMats)[]) {
    const m = MACRO[key];
    applyShellShader(out[key], lowDetail ? 0 : m ? m[0] : 0, lowDetail ? 0 : m ? m[1] : 0, ao);
  }
  return out;
}

/**
 * One 1.2 m CNVS stencil quad per big horizontal-normal crate face, at +6 mm.
 * The candidate faces are read straight off the crate bin's own merged
 * geometry, so a stencil can only ever land ON a crate, never in the air.
 */
function buildCrateDecals(crateGeos: THREE.BufferGeometry[] | null, cutoutAA: boolean): THREE.Mesh | null {
  if (!crateGeos || !crateGeos.length) return null;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();
  const mat4 = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, 1, 1);
  const placed: THREE.Vector3[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const R = lcg(7717);
  const SIZE = 1.2;
  const MIN_AREA = 3;
  const MIN_SPACING = 3.4;

  const src = crateGeos[0];
  const pos = src.getAttribute("position") as THREE.BufferAttribute;
  const idx = src.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < triCount && geos.length < 22; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const area = n.length() * 0.5;
    if (area < MIN_AREA) continue;
    n.normalize();
    // "normal within 30 deg of horizontal" = a VERTICAL face, the only kind a
    // stencil is ever printed on.
    if (Math.abs(n.y) > 0.5) continue;
    centre.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    let tooClose = false;
    for (const p of placed) {
      if (p.distanceTo(centre) < MIN_SPACING) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    placed.push(centre.clone());
    const q = new THREE.PlaneGeometry(SIZE, SIZE);
    quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    // 6 mm proud of the face, plus the material's own polygon offset.
    mat4.compose(centre.clone().addScaledVector(n, 0.006), quat, scale);
    q.applyMatrix4(mat4);
    geos.push(q);
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  const mat = new THREE.MeshStandardMaterial({
    map: DT.crateStencilTex(0),
    transparent: false,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    roughness: 0.92,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2.0,
    polygonOffsetUnits: -2.0,
  });
  mat.alphaToCoverage = cutoutAA;
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = "decal-crate-stencils";
  mesh.userData.count = geos.length;
  return mesh;
}

/**
 * ------------------------------------- LONG-A ARCHED WINDOWS ----------------
 * fix-ship-polish order 5. The source's long-A east building carries a row of
 * three arched windows and its centre pillar one more; all four are PAINTED
 * INTO the CS 1.6 diffuse map, so an albedo-only procedural reskin lost them
 * and the two most-looked-at facades in the map read blank. `spec-art.md` §8
 * recorded that as a deliberate deferral with a named cost — "every decal quad
 * is geometry the collider audit then has to explain" — and that cost is not
 * real: `decal-crate-stencils` already ships as `solid: false`, which keeps a
 * decal out of `__inspect.elements()`'s solid set and therefore out of BOTH the
 * collider audit's raycast targets and `qa/traverse.mjs`'s render-truth soup.
 * These quads ship the same way.
 *
 * WHERE THEY GO IS MEASURED, NOT DESIGNED. The before/after pair is rendered
 * from one camera (`scripts/dustmap/lookdev/povs.json` `long-a`), so a pixel in
 * `judge-r3/long-a-before.png` is a ray, and `qa/x/r4/unproject.mjs` casts it at
 * the shipped shell and reports the hit. Measured centres, then snapped to the
 * source's own 0.8128 m unit where the snap is inside the measurement error
 * (~0.023 m/px at 25 m, and the blob edges are +/-5 px):
 *
 *   row, wall plane x = 40.640 facing -x, arch-brick bin
 *     z = -30.886, -34.138, -40.640   (a 4-unit and an 8-unit pitch: the source
 *                                      row is on 128-unit centres with one slot
 *                                      skipped, which is what the frame shows)
 *     y = 6.502 (8 units)             measured 6.475 / 6.558 / 6.660
 *   centre pillar, plane z = -30.074 facing +z
 *     x = 31.682, y = 4.700           measured opening 30.505..32.871 x 3.578..5.651
 *
 * The quad is bigger than the opening because the card paints its own reveal,
 * arch ring and sill around it (`DT.archWindowTex`); the opening lands at the
 * measured size inside it.
 */
const ARCH_WINDOWS: { x: number; y: number; z: number; nx: number; nz: number; w: number; h: number }[] = [
  { x: 40.64, y: 6.502, z: -30.886, nx: -1, nz: 0, w: 3.05, h: 3.25 },
  { x: 40.64, y: 6.502, z: -34.138, nx: -1, nz: 0, w: 3.05, h: 3.25 },
  { x: 40.64, y: 6.502, z: -40.64, nx: -1, nz: 0, w: 3.05, h: 3.25 },
  { x: 31.682, y: 4.7, z: -30.074, nx: 0, nz: 1, w: 2.44, h: 2.85 },
];

function buildArchWindows(cutoutAA: boolean): THREE.Mesh | null {
  const geos: THREE.BufferGeometry[] = [];
  const quat = new THREE.Quaternion();
  const mat4 = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const fwd = new THREE.Vector3(0, 0, 1);
  const n = new THREE.Vector3();
  for (const w of ARCH_WINDOWS) {
    const q = new THREE.PlaneGeometry(w.w, w.h);
    n.set(w.nx, 0, w.nz).normalize();
    quat.setFromUnitVectors(fwd, n);
    // 8 mm proud of the wall face, plus the material's own polygon offset —
    // the shell bins carry 5 mm z-fight lifts of their own (glb-zfight.json).
    mat4.compose(new THREE.Vector3(w.x + n.x * 0.008, w.y, w.z + n.z * 0.008), quat, one);
    q.applyMatrix4(mat4);
    geos.push(q);
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  const mat = new THREE.MeshStandardMaterial({
    map: DT.archWindowTex(),
    transparent: false,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    roughness: 0.94,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2.0,
    polygonOffsetUnits: -2.0,
  });
  mat.alphaToCoverage = cutoutAA;
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = "decal-arch-windows";
  mesh.userData.count = ARCH_WINDOWS.length;
  return mesh;
}

/**
 * The out-of-bounds desert. report-glb gotcha #10: the source has NO ground and
 * NO sky outside the walls — round 1 of look-dev measured 58 % crushed pixels
 * on the overhead because every gap in the shell was void.
 *
 * Aerial-perspective rule (report-render 2.8): farther = lighter, so the mesa
 * tint is lighter than the dune tint. But BOTH are darker than the fog colour:
 * at 96-158 m the linear fog is already 36-76 %, and a card tinted lighter than
 * the sky dissolves completely and the horizon reads empty (round-2 flaw). Fog
 * does the lightening; the albedo only sets the order.
 */
function buildBackdrop(cutoutAA: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = "backdrop";

  // --- ground plane -------------------------------------------------------
  const gt = DT.sandFloorTex(GROUND.worldM, 512, 4111, false);
  const groundMat = new THREE.MeshStandardMaterial({ map: gt.clone(), color: 0xb2a68c, roughness: 0.98, metalness: 0 });
  groundMat.map!.needsUpdate = true;
  groundMat.map!.repeat.set(GROUND.size / GROUND.worldM, GROUND.size / GROUND.worldM);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND.size, GROUND.size), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(CX, GROUND.y, CZ);
  ground.receiveShadow = true;
  // Named so `qa/x/r3/pov.mjs --hide=<name>` can isolate one backdrop layer at a
  // time against a fixed camera (fix-round-3 order 7 was diagnosed that way).
  ground.name = "backdrop-ground";
  g.add(ground);

  // --- haze cylinder ------------------------------------------------------
  // Guarantees no raw sky below the skyline (the hedge-ring role on Shipment).
  // Top lands 6.0 deg above the horizon from a 2 m eye; at 210 m linear fog is
  // 100 %, so it resolves to exactly the fog colour and cannot be seen as a
  // wall.
  //
  // FEATHERED TOP EDGE (fix-ship-polish order 4). The cylinder was OPAQUE, so
  // its rim was a geometry silhouette: a hard horizontal cut across the sky at
  // exactly 6 degrees, one pixel wide, wherever a camera framed it. That is the
  // second of the two suspects the round-3 judge named for the mid->B band, and
  // although the band there turned out to be the sky texture's own wrap seam
  // (see `desertSkyTex`), the rim is a real edge and a card whose job is to
  // dissolve should not end in a line. The top 22 % of the map now ramps its
  // ALPHA to zero, so the haze fades into the sky instead of stopping against
  // it. `depthWrite` was already false and `renderOrder -2` still draws it
  // before the world, so nothing else in the frame changes.
  const hc = document.createElement("canvas");
  hc.width = 4;
  hc.height = 256;
  const hctx = hc.getContext("2d")!;
  const hg = hctx.createLinearGradient(0, 0, 0, 256);
  hg.addColorStop(0, "#e3cda4");
  hg.addColorStop(0.45, "#dcc8a0");
  hg.addColorStop(1, "#d3bd93");
  hctx.fillStyle = hg;
  hctx.fillRect(0, 0, 4, 256);
  hctx.globalCompositeOperation = "destination-in";
  const hf = hctx.createLinearGradient(0, 0, 0, 256 * 0.22);
  hf.addColorStop(0, "rgba(0,0,0,0)");
  hf.addColorStop(0.55, "rgba(0,0,0,0.55)");
  hf.addColorStop(1, "rgba(0,0,0,1)");
  hctx.fillStyle = hf;
  hctx.fillRect(0, 0, 4, 256 * 0.22);
  hctx.globalCompositeOperation = "source-over";
  const hazeTex = new THREE.CanvasTexture(hc);
  hazeTex.colorSpace = THREE.SRGBColorSpace;
  const haze = new THREE.Mesh(
    new THREE.CylinderGeometry(HAZE.r, HAZE.r, HAZE.h, 64, 1, true),
    new THREE.MeshBasicMaterial({ map: hazeTex, side: THREE.BackSide, fog: false, depthWrite: false, transparent: true }),
  );
  haze.position.set(CX, HAZE.centreY, CZ);
  haze.renderOrder = -2;
  haze.name = "backdrop-haze";
  g.add(haze);

  // --- dune + mesa rings, one merged draw each ----------------------------
  const ring = (cfg: typeof DUNE_RING, variants: number[], kind: "dune" | "mesa", tint: number, seed: number): THREE.Mesh => {
    const R = lcg(seed);
    const geos: THREE.BufferGeometry[] = [];
    // All variants of a ring share ONE canvas atlas so the ring is ONE draw.
    const W = 256 * variants.length;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, 256);
    variants.forEach((v, i) => {
      ctx.drawImage(DT.duneCardTex(v, kind).image as HTMLCanvasElement, i * 256, 0, 256, 256);
    });
    const tex = atlasTex(c);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < cfg.count; i++) {
      const deg = (i / cfg.count) * 360 + R() * 12;
      const r = cfg.rMin + R() * (cfg.rMax - cfg.rMin);
      const h = cfg.hMin + R() * (cfg.hMax - cfg.hMin);
      const w = h * (2.6 + R() * 1.8);
      const plane = new THREE.PlaneGeometry(w, h);
      // rebake the card's UV into its atlas column
      const uv = plane.getAttribute("uv") as THREE.BufferAttribute;
      const col = i % variants.length;
      const ua = uv.array as Float32Array;
      for (let k = 0; k < uv.count; k++) ua[k * 2] = (col + ua[k * 2]) / variants.length;
      uv.needsUpdate = true;
      const ang = (deg * Math.PI) / 180;
      const x = CX + Math.cos(ang) * r;
      const z = CZ + Math.sin(ang) * r;
      eul.set(0, Math.atan2(CX - x, CZ - z), 0);
      q.setFromEuler(eul);
      m4.compose(new THREE.Vector3(x, cfg.baseY + h / 2, z), q, one);
      plane.applyMatrix4(m4);
      geos.push(plane);
    }
    const merged = mergeGeometries(geos, false)!;
    for (const gg of geos) gg.dispose();
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: false,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      color: tint,
      fog: true,
      depthWrite: true,
    });
    mat.alphaToCoverage = cutoutAA;
    return new THREE.Mesh(merged, mat);
  };
  const duneRing = ring(DUNE_RING, [0, 1, 2, 3], "dune", DUNE_TINT, 4242);
  duneRing.name = "backdrop-dune-ring";
  g.add(duneRing);
  const mesaRing = ring(MESA_RING, [4, 5, 6], "mesa", MESA_TINT, 8484);
  mesaRing.name = "backdrop-mesa-ring";
  g.add(mesaRing);

  // --- CNVS container yard: 27 boxes, ONE draw ----------------------------
  // Four paints x (side, end) = 8 cells in one 1024 x 512 atlas. The box UVs
  // are our own 0..1, so the rebake is a plain remap with no offset removal.
  {
    const AW = 1024;
    const AH = 512;
    const c = document.createElement("canvas");
    c.width = AW;
    c.height = AH;
    const ctx = c.getContext("2d")!;
    const cells: Record<string, { side: Cell; end: Cell }> = {};
    PAINTS.forEach((p, i) => {
      const side = drawCell(ctx, DT.containerSideTex(p, 4402, 0.18).image as HTMLCanvasElement, { x: i * 256, y: 0, w: 256, h: 256 }, 4);
      const end = drawCell(ctx, DT.containerEndTex(p, 5501, 12 + i * 7, "Y").image as HTMLCanvasElement, { x: i * 256, y: 256, w: 256, h: 256 }, 4);
      cells[p] = { side, end };
    });
    const tex = atlasTex(c);
    const geos: THREE.BufferGeometry[] = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    for (const [x, y, z, yaw, paint] of CONTAINER_YARD) {
      const box = new THREE.BoxGeometry(6.06, 2.59, 2.44);
      // BoxGeometry groups: +x, -x, +y, -y, +z, -z. The two x faces are the
      // container ENDS (it is 6.06 m long on x), the rest take the side skin.
      const uv = box.getAttribute("uv") as THREE.BufferAttribute;
      const ua = uv.array as Float32Array;
      const cell = cells[paint] ?? cells[PAINTS[0]];
      for (const grp of box.groups) {
        const c2 = grp.materialIndex! < 2 ? cell.end : cell.side;
        const sx = c2.w / AW;
        const sy = c2.h / AH;
        const ox = c2.x / AW;
        const oy = (AH - c2.y - c2.h) / AH;
        // BoxGeometry is indexed; every group owns a disjoint index range, and
        // no vertex is shared between faces, so the index range maps 1:1.
        const start = grp.start;
        const end = grp.start + grp.count;
        const index = box.index!;
        for (let i = start; i < end; i++) {
          const v = index.getX(i);
          ua[v * 2] = ox + ua[v * 2] * sx;
          ua[v * 2 + 1] = oy + ua[v * 2 + 1] * sy;
        }
      }
      uv.needsUpdate = true;
      box.clearGroups();
      eul.set(0, (yaw * Math.PI) / 180, 0);
      q.setFromEuler(eul);
      m4.compose(new THREE.Vector3(x, y + 1.295, z), q, one);
      box.applyMatrix4(m4);
      geos.push(box);
    }
    const merged = mergeGeometries(geos, false)!;
    for (const gg of geos) gg.dispose();
    g.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.74, metalness: 0.16 })));
  }

  // --- the CNVS billboard on the horizon ----------------------------------
  {
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(BILLBOARD.h * 2.6, BILLBOARD.h * 0.65),
      new THREE.MeshStandardMaterial({ map: DT.cnvsBillboardTex(0), roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide }),
    );
    face.position.set(BILLBOARD.x, BILLBOARD.y + BILLBOARD.h, BILLBOARD.z);
    face.lookAt(BILLBOARD.aimAt[0], BILLBOARD.aimAt[1], BILLBOARD.aimAt[2]);
    g.add(face);
    const dir = new THREE.Vector3(BILLBOARD.aimAt[0] - BILLBOARD.x, 0, BILLBOARD.aimAt[2] - BILLBOARD.z).normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const postGeos: THREE.BufferGeometry[] = [];
    for (const dx of [-BILLBOARD.h * 0.9, BILLBOARD.h * 0.9]) {
      const p = new THREE.BoxGeometry(0.7, BILLBOARD.h, 0.7);
      p.translate(BILLBOARD.x + perp.x * dx, BILLBOARD.y + BILLBOARD.h / 2, BILLBOARD.z + perp.z * dx);
      postGeos.push(p);
    }
    const posts = mergeGeometries(postGeos, false)!;
    for (const gg of postGeos) gg.dispose();
    g.add(new THREE.Mesh(posts, new THREE.MeshStandardMaterial({ map: DT.rustSteelTex(1.626, 128), roughness: 0.8, metalness: 0.2 })));
  }
  return g;
}

/** The 11 class-A rooftop props, merged to one draw per material. */
function buildRoofProps(): THREE.Group {
  const g = new THREE.Group();
  g.name = "rooftop-props";
  const crateMat = new THREE.MeshStandardMaterial({ map: DT.crateWoodTex(2.438, 512), color: 0xd6c8a6, roughness: 0.9, metalness: 0 });
  const trimMat = new THREE.MeshStandardMaterial({ map: DT.rustSteelTex(1.626, 128), color: 0x8f8874, roughness: 0.64, metalness: 0.22 });
  const tarpMat = new THREE.MeshStandardMaterial({ color: 0x8a6f3c, roughness: 0.95, metalness: 0.02 });
  const banMat = new THREE.MeshStandardMaterial({ color: 0xe8c445, roughness: 0.55, metalness: 0.04 });
  const bins: Record<string, THREE.BufferGeometry[]> = { crate: [], trim: [], tarp: [], banana: [] };
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);

  for (const [x, y, z, yawDeg, kind] of ROOF_PROPS) {
    const yaw = (yawDeg * Math.PI) / 180;
    const put = (geo: THREE.BufferGeometry, bin: string, ox: number, oy: number, oz: number, ry = 0, rx = 0, rz = 0): void => {
      eul.set(rx, ry, rz);
      q.setFromEuler(eul);
      m4.compose(new THREE.Vector3(ox, oy, oz), q, one);
      geo.applyMatrix4(m4);
      // then the prop's own yaw + world placement
      eul.set(0, yaw, 0);
      q.setFromEuler(eul);
      m4.compose(new THREE.Vector3(x, y, z), q, one);
      geo.applyMatrix4(m4);
      bins[bin].push(geo);
    };
    if (kind === "crate-stack" || kind === "cnvs-crate" || kind === "banana-crate") {
      put(new THREE.BoxGeometry(1.2, 1.2, 1.2), "crate", 0, 0.6, 0);
      put(new THREE.BoxGeometry(1, 1, 1), "crate", 0.25, 1.7, -0.15, 0.4);
      if (kind === "banana-crate") put(new THREE.SphereGeometry(0.22, 10, 8), "banana", -0.4, 1.35, 0.3);
    } else if (kind === "tarp-bundle") {
      put(new THREE.BoxGeometry(2.2, 0.8, 1.4), "tarp", 0, 0.4, 0, 0, 0, 0.05);
      put(new THREE.CylinderGeometry(0.07, 0.07, 2.4, 8), "trim", 0, 0.85, 0);
    } else if (kind === "barrel-pair") {
      put(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 14), "trim", -0.4, 0.45, 0);
      put(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 14), "trim", 0.4, 0.45, 0.3);
    } else if (kind === "sat-dish") {
      put(new THREE.CylinderGeometry(0.09, 0.09, 1.6, 8), "trim", 0, 0.8, 0);
      put(new THREE.SphereGeometry(0.7, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), "trim", 0, 1.6, 0, 0.4, -1);
    } else if (kind === "awning-frame") {
      for (const dx of [-1.1, 1.1]) put(new THREE.BoxGeometry(0.12, 2, 0.12), "trim", dx, 1, 0);
      put(new THREE.BoxGeometry(2.4, 0.08, 1.6), "tarp", 0, 2, 0.4, 0, 0.16);
    } else {
      put(new THREE.CylinderGeometry(0.85, 0.85, 1.3, 16), "trim", 0, 0.65, 0);
      put(new THREE.CylinderGeometry(0.9, 0.9, 0.12, 16), "trim", 0, 1.32, 0);
    }
  }
  const mats: Record<string, THREE.Material> = { crate: crateMat, trim: trimMat, tarp: tarpMat, banana: banMat };
  for (const [k, geos] of Object.entries(bins)) {
    if (!geos.length) continue;
    // BoxGeometry/CylinderGeometry/SphereGeometry disagree on attribute sets
    // only in `uv`, which they all have — but Box carries groups, so drop them.
    for (const gg of geos) gg.clearGroups();
    const merged = mergeGeometries(geos, false);
    for (const gg of geos) gg.dispose();
    if (!merged) continue;
    const m = new THREE.Mesh(merged, mats[k]);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

/** A drifting sand band over the open sites — one Points draw. */
function buildDustMotes(): THREE.Points {
  const N = 420;
  const R = lcg(9091);
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = CX + (R() - 0.5) * 120;
    pos[i * 3 + 1] = FLOOR_Y + 1 + R() * 11;
    pos[i * 3 + 2] = CZ + (R() - 0.5) * 140;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    map: DT.dustMoteTex(),
    size: 0.09,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    opacity: 0.5,
    color: 0xe4d0aa,
    fog: true,
  });
  const p = new THREE.Points(geo, mat);
  p.frustumCulled = false;
  p.renderOrder = 2;
  return p;
}

/** 3 additive shafts in the roofed sections — one merged draw. */
function buildGodRays(): THREE.Mesh {
  const geos: THREE.BufferGeometry[] = [];
  for (const r of GOD_RAYS) {
    const q = new THREE.PlaneGeometry(r.w, r.h);
    q.rotateY(r.yaw);
    q.translate(r.x, r.y, r.z);
    geos.push(q);
    const q2 = new THREE.PlaneGeometry(r.w, r.h);
    q2.rotateY(r.yaw + Math.PI / 2);
    q2.translate(r.x, r.y, r.z);
    geos.push(q2);
  }
  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshBasicMaterial({
      map: DT.godRayTex(),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // The jungle map's shafts run at alpha 0.055; a desert shaft is dustier
      // but the map is brighter, so the same order of magnitude.
      opacity: 0.07,
      fog: true,
    }),
  );
  mesh.renderOrder = 3;
  return mesh;
}
