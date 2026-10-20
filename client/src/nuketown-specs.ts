import * as THREE from "three";
import { assetUrl } from "./asset-base";
import { specularAA } from "./specular-aa";

/**
 * NUKETOWN surface materials (OWNER: MAT, P2): every `nt_*` material name the
 * Blender build emits -> a set of the CC0 PBR library
 * (public/assets/nuketown/tex/<set>_{c,n,orm}.webp + manifest.json), the
 * surface shader patch, and the MeshStandardMaterial built from a spec. The
 * loader (nuketown-world.ts, frozen) calls loadSets + makeMaterial.
 *
 * The Blender half of the palette is scripts/nuketown/blender/nt_materials.py.
 *
 * Review round 1 (WORK-ORDERS §3 P2) added, all per Spec and map-local:
 *  - `cavity`: the set's crevice occlusion (_orm.R: lap/batten shadow lines,
 *    mortar, grooves) multiplied into the albedo. The baked lightmap AO takes
 *    three's aoMap slot, so without this the detail occlusion was lost.
 *  - `grime`: world-space wear, no decals — darker/browner toward the ground
 *    (gradient over `grimeH` m above `grimeY`), broken up by the macro map.
 *  - `facing`: detail weight [down, side, up] by world facing (beadboard grooves
 *    only on soffits, plain paint on the fascia it shares a material with).
 *  - `flat`: colour for near-horizontal faces (a vertical wallpaper motif must
 *    not lie on a header underside or a sill: YI03 "smeared" reveals).
 *  - `macro2` / `hue`: a second macro scale and a hue drift (lawn, stone).
 *  - `rot`: UV rotated 90° (grain up a post, YE14); `alphaTest` / `doubleSided`
 *    (cutout lattice); `vcol` (per-board tint from COLOR_0 when present).
 *  - glass: Fresnel env reflection kept at full strength over a 15–20 % body
 *    (premultiplied), a grime/crack overlay set, double-sided broken glass.
 *  - every set is sampled with a negative V repeat: the build's UV0 is
 *    v = 1 - y, which put every map upside down on the walls.
 */

const A = (p: string) => assetUrl(`/assets/nuketown/${p}`);

export type SetInfo = {
  tile_m: number;
  macro_tile_m?: number;
  macro_strength?: number;
  files: Record<string, string>;
  tintable?: boolean;
  alpha?: string | null;
};
export type Manifest = Record<string, SetInfo>;
export type Spec = {
  set?: string;
  /** Paint tint (applied where the colour map's alpha = 1). */
  tint?: number;
  /** Flat colour multiplier (whole surface). */
  color?: number;
  /** Scalar on the tint (> 1 allowed: calibrated albedo above the set's base). */
  gain?: number;
  rough?: number;
  metal?: number;
  normal?: number;
  env?: number;
  emissive?: number;
  emissiveIntensity?: number;
  glass?: boolean;
  /** Glass: overlay set (RGBA: rgb = dirt/crack colour, a = amount) and its weight. */
  glassSet?: string;
  glassAmount?: number;
  /** Glass body opacity (0..1) and tint. */
  opacity?: number;
  /** Override the manifest tile size (metres per repeat). */
  tile?: number;
  macro?: boolean;
  /** Override the manifest macro strength. */
  macroStrength?: number;
  /** Second macro scale: [tile metres, strength]. */
  macro2?: [number, number];
  /** Hue drift on the second macro scale: [tint hex, strength]. */
  hue?: [number, number];
  /** Constant roughness instead of the set's ORM roughness (specular-aliasing guard). */
  flatRough?: number;
  /** Mip LOD bias for the colour map (thin high-contrast features). */
  mipBias?: number;
  /** 0..1: multiply the set's crevice occlusion (_orm.R) into the albedo. */
  cavity?: number;
  /** 0..1: world-space base grime strength. */
  grime?: number;
  /** Base grime gradient height (m) and the ground level it starts at (m). */
  grimeH?: number;
  grimeY?: number;
  /** Detail (normal + cavity) weight for [down, side, up] facing surfaces. */
  facing?: [number, number, number];
  /** Albedo for near-horizontal faces (hex), replacing the pattern there. */
  flat?: number;
  /** Rotate every map: true = 90° (grain along V), or an angle in degrees (45 = diagonal planks). */
  rot?: boolean | number;
  /** Cutout: alpha from the colour map, alpha-to-coverage. */
  alphaTest?: number;
  doubleSided?: boolean;
  /** Per-board tint from COLOR_0.r (0.25..0.75 -> x0.92..x1.08; 0 or 1 = none). */
  vcol?: boolean;
  /**
   * Decal underlay: the SPECS name of the surface the decal lies on. Where the
   * decal's alpha is 0 the shader shows that spec's set with its tint/gain and
   * macro (sampled at the same world UV), so a soft decal stays an opaque,
   * shadow-receiving, depth-sorted surface (no blending, no visible quad).
   */
  under?: string;
  /**
   * Decal coverage from the vertex colour (review round 2, GROUND's thin tar polylines and
   * irregular patch polygons). A face whose COLOR_0 is (c, 0, 1) - green 0, blue 1, the
   * "coverage" marker - is covered by c (0 = feathered outer edge, 1 = full decal):
   * `solid` sets ignore their texture alpha there (a tar line is tar across its width);
   * `seam` darkens the 0.3..0.75 coverage band into a tar-seam outline. Any other vertex
   * colour (none, or the default white) keeps today's texture-alpha decal.
   */
  dfade?: { solid?: boolean; seam?: number };
  /** Grey silvering of raw wood up from the ground: [strength, height m, grey lightness x] (fence base, r2 M8). */
  weather?: [number, number, number];
  /**
   * Board seam groove (r2 M8, GROUND's zero-gap boards): a face whose COLOR_0 is (tint, across, 1)
   * - green = the across-board coordinate 0..1, blue 1 - is darkened within `seam[1]` (across units)
   * of both long edges by `seam[0]`; antialiased by the screen derivative (fades when sub-pixel).
   */
  seam?: [number, number];
  /** Albedo multiplier by world facing [down, side, up] (stair risers darker than treads). */
  faceTint?: [number, number, number];
  /** Glass index of refraction (Fresnel F0); default 1.5. */
  ior?: number;
};

const C = (h: string) => parseInt(h.replace("#", ""), 16);

// world grime presets: houses sit at ~0.25 m (lawn 0.22); fences/sheds at ~0.2
const G_WALL = { grime: 0.32, grimeH: 0.9, grimeY: 0.2 };
const G_LOW = { grime: 0.25, grimeH: 0.5, grimeY: 0.15 };
// walnut stain (trim, stair wood, wainscot, panelling): one wood map-wide; the cooler,
// less saturated tint keeps it reading walnut (#5a3c28) under the 2700 K practicals
const WALNUT = { tint: C("#acd1ff"), gain: 2.155 };

/**
 * nt_* material name -> look. Tints calibrated in capture (WORK-ORDERS §3.0 table) on the
 * shipping bake under LIGHT's final rig (exposure 0.63, GTAO, fixture lights): exterior targets
 * on SUNLIT probes, the effective mean albedo (set x tint x gain x cavity) held inside sRGB
 * 30..240; interior ones on their usual practical/window light with the albedo kept within
 * dE00 8 of the bible colour (the warm 2700 K interior cast is LIGHT's, not compensated past that).
 */
export const SPECS: Record<string, Spec> = {
  // ---------------------------------------------------------------- houses, exterior
  // painted clapboard (green house) / board-and-batten (yellow house, ranches)
  nt_siding_green: { set: "siding_lap", tint: C("#42c99c"), cavity: 0.9, env: 0.5, ...G_WALL },
  nt_siding_white: { set: "siding_lap", tint: C("#fafaff"), gain: 1.166, cavity: 0.9, env: 0.5, ...G_WALL },
  nt_siding_yellow: { set: "siding_board", tint: C("#fff670"), gain: 1.089, cavity: 0.85, env: 0.5, ...G_WALL },
  nt_siding_olive: { set: "siding_board", tint: C("#6e7b50"), cavity: 0.85, env: 0.5, ...G_WALL },
  nt_siding_plum: { set: "siding_board", tint: C("#cfa6bf"), cavity: 0.85, env: 0.5, ...G_WALL },
  nt_siding_pink: { set: "siding_lap", tint: C("#e8b4b4"), cavity: 0.9, env: 0.5, ...G_WALL },
  nt_siding_blue: { set: "siding_lap", tint: C("#a9c3d6"), cavity: 0.9, env: 0.5, ...G_WALL },
  // one clean semi-gloss white for every fascia, corner board, casing and gutter
  nt_trim_white: { set: "trim_paint", tile: 0.8, tint: C("#fbfbff"), gain: 1.104, env: 0.6, grime: 0.15, grimeH: 0.6, grimeY: 0.2 },
  nt_soffit_white: { set: "soffit_beadboard", tint: C("#fbfbff"), gain: 1.104, cavity: 0.9, facing: [1, 0, 0.3], env: 0.5 },
  nt_gutter_white: { set: "trim_paint", tint: C("#fbfbff"), gain: 1.104, rough: 0.45, flatRough: 0.4, env: 0.7 },
  // one exterior timber (r2 M3): honey pine framing + deck boards, no walnut outdoors
  nt_trim_wood: { set: "pine_timber", ...G_LOW },
  nt_post_wood: { set: "pine_timber", rot: true, ...G_LOW },
  // warm cream-tan ledge / fieldstone (r2 M4); the dark ledge keeps its r1 effective albedo
  nt_stone_field: { set: "stone_ledge", gain: 1.2, cavity: 0.85, macro2: [3.1, 0.1], ...G_LOW },
  nt_stone_dark: { set: "stone_ledge", tint: C("#a6c1ff"), gain: 1.332, cavity: 0.9, macro2: [3.1, 0.1] },
  nt_screen_wood: { set: "fence_privacy" },
  nt_deck_wood: { set: "deck_pine", ...G_LOW },
  nt_deck_wood_diag: { set: "deck_pine", rot: 45, ...G_LOW },
  nt_door_wood: { set: "door_paint", tint: C("#f2ead6") },
  nt_door_panel: { set: "door_paint", tint: C("#efe9da") },
  nt_garage_door: { set: "garage_door", tint: C("#f4f2ea"), cavity: 0.9, env: 0.6, ...G_LOW },
  nt_garage_door_red: { set: "garage_door", tint: C("#fc4d46"), cavity: 0.9, env: 0.6, ...G_LOW },
  nt_garage_door_teal: { set: "garage_door", tint: C("#4f9a94"), cavity: 0.9, env: 0.6, ...G_LOW },
  // r2 M6: Fresnel sky reflection (F0 4 %, ~60 % near grazing) over an 8 % #d8e4dc body and a light uniform dust film
  nt_window_glass: { glass: true, glassSet: "glass_dust", glassAmount: 1, opacity: 0.08, color: C("#d8e4dc"), ior: 1.5, env: 2.0 },
  nt_glass_broken: { glass: true, glassSet: "glass_cracks", glassAmount: 1, opacity: 0.2, color: 0xa7b8b6, doubleSided: true },
  nt_glass_dark: { glass: true, opacity: 0.32, color: 0x55616a },
  // weathered grey (r2 M5): macro staining at two scales, no visible tile
  nt_roof_shingle: { set: "roof_shingle_grey", tint: C("#d7e0ff"), gain: 1.263, cavity: 0.5, macro2: [4.6, 0.08] },
  nt_roof_roll: { set: "roof_roll", tint: C("#d7e0ff"), gain: 1.263, normal: 0.7, macro2: [3.3, 0.08] },
  nt_brick: { set: "brick_dark", cavity: 0.6 },
  nt_lattice: { set: "lattice_diamond", tint: C("#f6f5ef"), alphaTest: 0.5, doubleSided: true, cavity: 0.8 },
  nt_lattice_cut: { set: "lattice_diamond", tint: C("#f6f5ef"), alphaTest: 0.5, doubleSided: true, cavity: 0.8 },
  // ---------------------------------------------------------------- interiors (one finish per room, WORK-ORDERS G12 / Y10)
  nt_wall_cream: { set: "plaster_wall", tile: 1.0, tint: C("#eee3c8"), flat: C("#e9dfc6") },
  nt_wall_mint: { set: "plaster_wall", tile: 1.0, tint: C("#9cc9bf"), flat: C("#a5cbc2") },
  nt_wall_yellow: { set: "plaster_wall", tile: 1.0, tint: C("#e9d58e"), flat: C("#e6d494") },
  // garage walls: raw OSB sheathing (GI11); the yellow garage takes nt_cmu_white (Y12)
  nt_wall_garage: { set: "osb", normal: 0.8 }, // OSB regraded pale tan-grey (r2 GI04)
  nt_osb: { set: "osb", normal: 0.8 },
  nt_cmu_white: { set: "cmu_white", cavity: 0.7, flat: C("#dcd8cd") },
  // r2 M2: grey interior fieldstone, pale mortar (yellow accent walls / passage)
  nt_stone_field_grey: { set: "stone_field_grey", cavity: 0.6 },
  // papers: a vertical motif never lies on a header, sill or reveal (flat ground colour there, YI03)
  // r2 M2: desaturated cream / sage papers, the mustard oval chain, the yellow kitchen's sage band
  nt_wallpaper_floral: { set: "wallpaper_floral", flat: C("#cfc8a8"), macroStrength: 0.1 },
  nt_wallpaper_vine: { set: "wallpaper_vine", flat: C("#d0caaa"), mipBias: 0.3 },
  nt_wallpaper_oval: { set: "wallpaper_oval", flat: C("#b8963a"), mipBias: 0.25 },
  nt_wallpaper_star: { set: "wallpaper_star", flat: C("#d8cc9a") },
  nt_wallpaper_geo_sage: { set: "wallpaper_geo_sage", flat: C("#a6ae86"), mipBias: 0.25 },
  // walnut: vertical-board wainscot + moulding trim (LOOK BIBLE walnut ≈ #5a3c28)
  nt_wainscot_walnut: { set: "wainscot_walnut", ...WALNUT, normal: 0.6, mipBias: 0.4, flat: C("#584c46") },
  // normal 0.3 (the wood-paneling fix f69e762): at 0.6 a groove highlight crawled at 0.8 m in the green
  // stair-head view (flicker gate shimmer, nt-stair-head-back, all three runs)
  nt_wall_panel: { set: "wainscot_walnut", ...WALNUT, normal: 0.3, mipBias: 0.4, flat: C("#584c46") },
  nt_trim_walnut: { set: "trim_walnut", ...WALNUT },
  nt_stair_wood: { set: "oak_tread" }, // honey-oak treads (r2 YI06 / YI07)
  nt_ceiling: { set: "ceiling_plaster", tint: C("#f3efe6") },
  // r2 M2: the yellow garage (pale grey plaster walls, raw pine joists + plywood)
  nt_plaster_grey: { set: "plaster_wall", tile: 1.0, tint: C("#c2bba4"), flat: C("#bdb6a0") },
  nt_joist_pine: { set: "joist_pine" },
  // floors: period wide oak strip (no laminate), carpets with pile, the praised checker
  nt_floor_wood: { set: "floor_oak" },
  nt_floor_oak: { set: "floor_oak" },
  // r2 M2: green kitchen navy / cream vinyl (nt_floor_checker stays the green set), yellow cream / caramel
  nt_floor_checker: { set: "vinyl_checker_navy" },
  nt_vinyl_checker_navy: { set: "vinyl_checker_navy" },
  nt_floor_checker_caramel: { set: "floor_checker_caramel" },
  nt_carpet: { set: "carpet", tint: C("#f2da6e") },
  nt_carpet_ochre: { set: "carpet", tint: C("#f2da6e") },
  // carpets (r2 table): green living greige, bedrooms blue-grey, back rooms grey-green low pile
  nt_carpet_grey: { set: "carpet", tint: C("#a7a08a") },
  nt_carpet_greige: { set: "carpet", tint: C("#a7a08a") },
  nt_carpet_blue: { set: "carpet", tint: C("#7c8496") },
  nt_carpet_greygreen: { set: "carpet_lowpile", tint: C("#a6aa94") },
  // plum-burgundy runner, risers darker than the treads (GI12)
  nt_stair_carpet: { set: "carpet", tint: C("#7a3a48"), faceTint: [0.8, 0.74, 1] },
  nt_runner_burgundy: { set: "carpet", tint: C("#7a3a48"), faceTint: [0.8, 0.74, 1] },
  nt_runner_maroon: { set: "carpet", tint: C("#722b41") },
  nt_fabric_navy: { set: "fabric_weave", tint: C("#2b49ad"), doubleSided: true },
  nt_fabric_gold: { set: "fabric_weave", tint: C("#e0b13c"), doubleSided: true },
  nt_brass: { set: "brass" },
  // milk-glass shades: frosted, glowing warm (the light itself is LIGHT's practicals)
  nt_shade_glass: { color: C("#f4ead8"), emissive: 0xffd9a0, emissiveIntensity: 1.6, rough: 0.35 },
  nt_concrete_garage: { set: "driveway_concrete" },
  nt_lamp_warm: { color: 0x111111, emissive: 0xffd9a0, emissiveIntensity: 3.2, rough: 0.4 },
  // furniture blockout (props-in replaces these by placement)
  nt_furn_wood: { set: "wood_cabinet" },
  nt_furn_fabric_red: { set: "vinyl_seat", tint: C("#a03029") },
  nt_furn_fabric_green: { set: "vinyl_seat", tint: C("#4fa5a1") },
  nt_furn_counter: { set: "wood_cabinet" },
  nt_furn_countertop: { set: "counter_laminate" },
  nt_furn_appliance: { set: "car_paint", tint: C("#f1efe8"), rough: 0.35 },
  nt_furn_stove: { set: "car_paint", tint: C("#efede6"), rough: 0.4 },
  nt_furn_tv: { set: "wood_cabinet", color: 0x806048 },
  nt_furn_bed: { set: "wood_cabinet" },
  nt_furn_bedding: { set: "vinyl_seat", tint: C("#eadfc6"), rough: 0.9 },
  // ---------------------------------------------------------------- yard / street (source materials, renamed in Blender)
  // r2 M9: low-contrast macro (12 m set + 30 m here), a faint dry-yellow hue drift
  nt_grass: { set: "grass_lawn", tint: C("#eff6ff"), gain: 1.8, macro2: [30, 0.06], hue: [C("#d6cc86"), 0.14] },
  nt_grass_card: { set: "grass_cards", alphaTest: 0.5, doubleSided: true },
  nt_sand: { set: "desert_ground" },
  nt_mulch: { set: "soil_bed" },
  nt_soil_bed: { set: "soil_bed" },
  nt_dirt_packed: { set: "dirt_packed", tint: C("#e5eaff"), gain: 1.609 },
  nt_paver: { set: "paver_concrete", ...G_LOW },
  nt_asphalt: { set: "asphalt_street", tint: C("#dee7ff"), gain: 1.141 },
  nt_asphalt_old: { set: "asphalt_street", tint: C("#dee7ff"), gain: 1.141 },
  nt_sidewalk: { set: "sidewalk_concrete", tint: C("#e5e8f7") },
  nt_curb: { set: "curb_concrete" }, // clean fine aggregate, no debris (r2 M7)
  nt_gutter_pan: { set: "gutter_concrete" },
  nt_concrete: { set: "driveway_concrete", tint: C("#efefff"), gain: 0.975 }, // broom finish (r2 M11)
  // decals (3 mm proud, `_decal` = polygonOffset): opaque; the soft ones blend over
  // the asphalt they sit on in the shader (`under`), so they stay shadowed and sorted
  // r2 M7: flat satin tar (no relief, no glint); GROUND's polylines / patch rings carry COLOR_0 coverage
  nt_decal_tar_decal: { set: "decal_tar", under: "nt_asphalt", flatRough: 0.55, dfade: { solid: true } },
  nt_decal_patch_decal: { set: "decal_patch", under: "nt_asphalt", dfade: { seam: 0.45 } },
  nt_decal_oil_decal: { set: "decal_oil_tile", under: "nt_asphalt" },
  nt_decal_manhole_decal: { set: "manhole_iron", metal: 0.6 },
  // r2 M10: no blotch macro, no pale top sheen (env 0, roughness >= 0.85)
  nt_hedge: { set: "hedge_leaves", normal: 1.4, macro: false, env: 0, flatRough: 0.88 },
  nt_hedge_card: { set: "hedge_cards", alphaTest: 0.45, doubleSided: true },
  // shared foliage (review round 2, M10): sapling trunks / branches and LIGHT's backdrop sage cards
  nt_bark: { set: "bark" },
  nt_scrub_card: { set: "scrub_sage", alphaTest: 0.5, doubleSided: true },
  nt_shrub_card: { set: "shrub_cards", alphaTest: 0.5, doubleSided: true },
  nt_sapling_leaf: { set: "sapling_leaves", alphaTest: 0.5, doubleSided: true },
  // privacy fence (one weathered-board material map-wide): SketchUp slabs + GROUND's modelled boards
  // r2 M8: raw cedar calibrated to the SUNLIT reference (#c09a70; shade ~#5a483c), per-board tint
  // (COLOR_0.r), zero-gap seam groove (COLOR_0.g), grey silvering + soil splash on the bottom 20 cm
  nt_fence_wood: { set: "fence_privacy", gain: 1.22, normal: 0.8, mipBias: 0.3, weather: [0.6, 0.22, 0.95], grime: 0.4, grimeH: 0.1, grimeY: 0.15 },
  nt_fence_board: { set: "fence_board", normal: 0.8, mipBias: 0.3, vcol: true, seam: [0.55, 0.028], weather: [0.6, 0.22, 0.95], grime: 0.4, grimeH: 0.1, grimeY: 0.15 },
  nt_picket_white: { set: "picket_paint", tint: C("#f4f2ea"), grime: 0.45, grimeH: 0.14, grimeY: 0.15 },
  // the street-mouth sheet fence (z 15.885): the set's ~0.60 roughness on full metal let the sun
  // highlight slide across the sheet under the flicker gate's mm camera moves at 0.25-0.45 m (shimmer);
  // a constant 0.74 keeps the galvanized read without the crawl
  nt_metal_fence: { set: "metal_galvanized", flatRough: 0.74 },
  nt_wood_painted: { set: "timber" },
  nt_paint_white: { set: "trim_paint", tint: C("#f1efe9") },
  nt_paint_mint: { set: "siding_lap", tint: C("#42c99c"), cavity: 0.9 },
  nt_metal: { set: "metal_galvanized" },
  nt_metal_rust: { set: "rust_metal" },
  nt_paint_red: { set: "car_paint", tint: C("#a8322c") },
  nt_paint_yellow_bus: { set: "car_paint", tint: C("#e2b33a") },
  // remap fallbacks: clean paint, never the chipped/rusted metal set (grid rust, CUL11/YD07/WD12)
  nt_paint_dark: { set: "trim_paint", tint: C("#4a4a4c"), rough: 0.6 },
  nt_paint_grey: { set: "trim_paint", tint: C("#b8bab8"), rough: 0.6 },
  nt_paint_olive: { set: "car_paint", tint: C("#5f6343") },
  nt_blinds: { set: "trim_paint", tint: C("#e8dcc0") },
  nt_swing_red: { set: "car_paint", tint: C("#b03a30"), rough: 0.6 },
  // stand-in vehicles (the vehicles stream replaces them by placement)
  nt_car_bus: { set: "car_paint", tint: C("#e2b33a") },
  nt_car_red: { set: "car_paint", tint: C("#a8322c") },
  nt_car_olive: { set: "car_paint", tint: C("#5f6343") },
  nt_car_black: { set: "car_paint", tint: C("#2a2a2c") },
  nt_car_grey: { set: "car_paint", tint: C("#b8bcbf") },
  nt_car_cream: { set: "car_paint", tint: C("#efe6cf") },
  nt_car_sedan: { set: "car_paint", tint: C("#a9c7a6") },
  // stand-in chrome trim: a few px wide and mirror-smooth = crawling env glints;
  // a constant satin roughness keeps the read without the shimmer
  nt_chrome: { set: "chrome", flatRough: 0.42 },
  nt_default: { set: "concrete_cast" },
};

/**
 * WO-0 material-name contract. The geometry packages may assign these names
 * from day 1; each renders as the spec it points at until MAT gives it an
 * entry of its own in SPECS above (then the alias is deleted here). An
 * unknown name falls back to `nt_default`. The bake's bounce-albedo proxies
 * are MAT_ALIASES in scripts/nuketown/blender/nt_materials.py.
 */
export const SPEC_ALIASES: Record<string, string> = {};
for (const [name, to] of Object.entries(SPEC_ALIASES)) if (!SPECS[name] && SPECS[to]) SPECS[name] = SPECS[to]!;

// ------------------------------------------------------------------ textures
export type TexSet = { c?: THREE.Texture; n?: THREE.Texture; orm?: THREE.Texture; macro?: THREE.Texture; info: SetInfo };

export async function loadSets(names: Set<string>, manifest: Manifest, renderer: THREE.WebGLRenderer, low: boolean): Promise<Map<string, TexSet>> {
  // glass overlays and decal underlays are referenced by `glassSet` / `under`, not `set`
  for (const s of Object.values(SPECS)) {
    if (s.glassSet) names.add(s.glassSet);
    const u = s.under ? SPECS[s.under]?.set : undefined;
    if (u) names.add(u);
  }
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), 16);
  const out = new Map<string, TexSet>();
  const jobs: Promise<void>[] = [];
  for (const name of names) {
    const info = manifest[name];
    if (!info) continue;
    const set: TexSet = { info };
    out.set(name, set);
    const load = (kind: "c" | "n" | "orm" | "macro") => {
      const file = info.files[low && kind !== "macro" ? `${kind}-low` : kind] ?? info.files[kind];
      if (!file) return;
      jobs.push(
        loader.loadAsync(A(`tex/${file}`)).then((t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = aniso;
          if (kind === "c") t.colorSpace = THREE.SRGBColorSpace;
          set[kind] = t;
        }).catch(() => undefined),
      );
    };
    load("c");
    load("n");
    load("orm");
    if (info.macro_tile_m && !low) load("macro");
  }
  await Promise.all(jobs);
  return out;
}

// ------------------------------------------------------------------ surface shader patch
type SurfaceOpts = {
  tint: THREE.Color;
  macro?: THREE.Texture;
  macroScale: number;
  macroStrength: number;
  macro2?: [number, number];
  hue?: [number, number];
  mipBias: number;
  cavity: number;
  orm?: THREE.Texture;
  grime: number;
  grimeH: number;
  grimeY: number;
  facing?: [number, number, number];
  flat?: number;
  cutout: boolean;
  vcol: boolean;
  /** metres per UV unit of this material (for the second macro scale) */
  tile: number;
  /** decal underlay: its maps and the UV scale from this set to it */
  under?: { c?: THREE.Texture; n?: THREE.Texture; orm?: THREE.Texture; scale: number; tint: THREE.Color };
  /** decal coverage from the COLOR_0 marker (Spec.dfade) */
  dfade?: { solid?: boolean; seam?: number };
  weather?: [number, number, number];
  seam?: [number, number];
  faceTint?: [number, number, number];
};

/**
 * Paint-mask tint + detail occlusion + macro breakup + world-space grime,
 * patched into the standard shader. The library's tintable colour maps carry
 * the paint mask in ALPHA (1 = paint, 0 = bare wood/rust): albedo =
 * mix(c.rgb, c.rgb * tint, c.a); cutout sets use alpha as coverage instead
 * (tint everywhere). The macro texture (greyscale, mean 0.5) is sampled at
 * macro_tile_m (and optionally a second scale) to break the repeat.
 */
export function patchSurface(mat: THREE.MeshStandardMaterial, o: SurfaceOpts): void {
  // a positive mip bias pre-filters 1-px texture features (panel grooves) that
  // otherwise crawl under a scope at a few metres (flicker gate "shimmer")
  const bias = o.mipBias > 0 ? `, ${o.mipBias.toFixed(2)}` : "";
  const defs: string[] = [];
  if (o.macro) defs.push("NT_MACRO");
  if (o.macro && o.macro2) defs.push("NT_MACRO2");
  if (o.macro && o.macro2 && o.hue) defs.push("NT_HUE");
  if (o.cavity > 0 && o.orm) defs.push("NT_CAVITY");
  if (o.grime > 0) defs.push("NT_GRIME");
  if (o.facing) defs.push("NT_FACING");
  if (o.flat !== undefined) defs.push("NT_FLAT");
  if (o.cutout) defs.push("NT_CUTOUT");
  if (o.vcol) defs.push("NT_VCOL");
  if (o.under?.c) defs.push("NT_UNDER");
  if (o.under?.n) defs.push("NT_UNDER_N");
  if (o.under?.orm) defs.push("NT_UNDER_ORM");
  if (o.under?.c && o.dfade) defs.push("NT_DFADE");
  if (o.weather) defs.push("NT_WEATHER");
  if (o.seam) defs.push("NT_SEAM");
  if (o.faceTint) defs.push("NT_FTINT");
  const needWorld = o.grime > 0 || !!o.facing || o.flat !== undefined || !!o.weather || !!o.faceTint;
  if (needWorld) defs.push("NT_WORLD");
  const uniforms = {
    uTint: { value: o.tint },
    uMacro: { value: o.macro ?? null },
    uMacroScale: { value: o.macroScale },
    uMacroStrength: { value: o.macro ? o.macroStrength : 0 },
    uMacro2: { value: new THREE.Vector2(o.macro2 ? o.tile / o.macro2[0] : 1, o.macro2 ? o.macro2[1] : 0) },
    uHue: { value: new THREE.Vector4(...(o.hue ? new THREE.Color(o.hue[0]).toArray() : [1, 1, 1]), o.hue ? o.hue[1] : 0) },
    uCavity: { value: o.cavity },
    uOrm: { value: o.orm ?? null },
    uGrime: { value: new THREE.Vector3(o.grime, o.grimeY, o.grimeH) },
    uFacing: { value: new THREE.Vector3(...(o.facing ?? [1, 1, 1])) },
    uFlat: { value: new THREE.Color(o.flat ?? 0xffffff) },
    uUnderMap: { value: o.under?.c ?? null },
    uUnderN: { value: o.under?.n ?? null },
    uUnderOrm: { value: o.under?.orm ?? null },
    uUnderScale: { value: o.under?.scale ?? 1 },
    uUnderTint: { value: o.under?.tint ?? new THREE.Color(1, 1, 1) },
    uDFade: { value: new THREE.Vector2(o.dfade?.solid ? 1 : 0, o.dfade?.seam ?? 0) },
    uWeather: { value: new THREE.Vector3(...(o.weather ?? [0, 1, 1])) },
    uSeam: { value: new THREE.Vector2(...(o.seam ?? [0, 0])) },
    uFTint: { value: new THREE.Vector3(...(o.faceTint ?? [1, 1, 1])) },
  };
  mat.userData.ntUniforms = uniforms;
  const head = defs.map((d) => `#define ${d}`).join("\n");
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    if (needWorld) {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vNtWorld;\nvarying vec3 vNtWN;`)
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
          vNtWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          vNtWN = normalize( mat3( modelMatrix ) * objectNormal );`,
        );
    }
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `${head}\n#include <common>\n#ifdef NT_WORLD\nvarying vec3 vNtWorld;\nvarying vec3 vNtWN;\n#endif`,
      )
      .replace(
        "#include <map_pars_fragment>",
        `#include <map_pars_fragment>
        uniform vec3 uTint; uniform sampler2D uMacro; uniform float uMacroScale; uniform float uMacroStrength;
        uniform vec2 uMacro2; uniform vec4 uHue; uniform float uCavity; uniform sampler2D uOrm;
        uniform vec3 uGrime; uniform vec3 uFacing; uniform vec3 uFlat;
        uniform sampler2D uUnderMap; uniform sampler2D uUnderN; uniform sampler2D uUnderOrm; uniform float uUnderScale; uniform vec3 uUnderTint;
        uniform vec2 uDFade; uniform vec3 uWeather; uniform vec2 uSeam; uniform vec3 uFTint;
        float ntUA = 1.0;`,
      )
      .replace(
        "#include <map_fragment>",
        `float ntFace = 1.0;
        #ifdef NT_FACING
          // [down, side, up] by the geometry's world facing
          float ntWy = vNtWN.y;
          ntFace = mix( uFacing.y, uFacing.x, smoothstep( -0.45, -0.75, ntWy ) );
          ntFace = mix( ntFace, uFacing.z, smoothstep( 0.45, 0.75, ntWy ) );
        #endif
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv${bias} );
          #if defined( NT_UNDER )
            // decal over its underlay: opaque, alpha only mixes the two looks
            ntUA = sampledDiffuseColor.a;
            #ifdef NT_DFADE
              // COLOR_0 = (coverage, 0, 1): GROUND's feathered polylines / patch rings
              float ntCov = -1.0;
              if ( vColor.b > 0.5 && vColor.g < 0.5 ) {
                ntCov = clamp( vColor.r, 0.0, 1.0 );
                ntUA = smoothstep( 0.0, 1.0, ntCov ) * ( uDFade.x > 0.5 ? 1.0 : ntUA );
              }
            #endif
            vec3 paint = mix( texture2D( uUnderMap, vMapUv * uUnderScale ).rgb * uUnderTint, sampledDiffuseColor.rgb * uTint, ntUA );
            #ifdef NT_DFADE
              // tar-seam outline in the middle of the feather
              if ( ntCov >= 0.0 ) paint *= 1.0 - uDFade.y * smoothstep( 0.22, 0.42, ntCov ) * ( 1.0 - smoothstep( 0.55, 0.78, ntCov ) );
            #endif
          #elif defined( NT_CUTOUT )
            vec3 paint = sampledDiffuseColor.rgb * uTint;
            diffuseColor.a *= sampledDiffuseColor.a;
          #else
            vec3 paint = mix( sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * uTint, sampledDiffuseColor.a );
          #endif
          #ifdef NT_FLAT
            // near-horizontal faces: the plain ground colour, no motif (reveals, sills, headers)
            float ntHz = smoothstep( 0.6, 0.85, abs( vNtWN.y ) );
            paint = mix( paint, uFlat * ( 0.94 + 0.06 * dot( sampledDiffuseColor.rgb, vec3( 0.333 ) ) ), ntHz );
          #endif
          float ntM1 = 0.5;
          #ifdef NT_MACRO
            ntM1 = texture2D( uMacro, vMapUv * uMacroScale ).r;
            paint *= 1.0 + ( ntM1 - 0.5 ) * 2.0 * uMacroStrength;
            #ifdef NT_MACRO2
              float ntM2 = texture2D( uMacro, vMapUv * uMacro2.x + vec2( 0.37, 0.61 ) ).r;
              paint *= 1.0 + ( ntM2 - 0.5 ) * 2.0 * uMacro2.y;
              #ifdef NT_HUE
                paint = mix( paint, paint * uHue.rgb, smoothstep( 0.42, 0.78, ntM2 ) * uHue.a );
              #endif
            #endif
          #endif
          #ifdef NT_CAVITY
            float ntCav = texture2D( uOrm, vMapUv ).r;
            paint *= mix( 1.0, ntCav, uCavity * ntFace );
          #endif
          #ifdef NT_GRIME
            // world-space splash-back grime: a gradient up from the ground, macro-modulated
            float ntG = 1.0 - clamp( ( vNtWorld.y - uGrime.y ) / uGrime.z, 0.0, 1.0 );
            ntG = ntG * ntG * uGrime.x * ( 0.55 + 0.9 * ntM1 );
            paint = mix( paint, paint * vec3( 0.74, 0.70, 0.62 ), clamp( ntG, 0.0, 1.0 ) );
          #endif
          #ifdef NT_WEATHER
            // raw wood silvers grey toward the ground (r2 M8): desaturate + shift to the weathered grey
            float ntWe = 1.0 - clamp( ( vNtWorld.y - uGrime.y ) / uWeather.y, 0.0, 1.0 );
            ntWe = clamp( ntWe * uWeather.x * ( 0.6 + 0.8 * ntM1 ), 0.0, 1.0 );
            float ntLu = dot( paint, vec3( 0.2126, 0.7152, 0.0722 ) );
            paint = mix( paint, vec3( ntLu ) * vec3( 1.02, 1.02, 1.0 ) * uWeather.z, ntWe );
          #endif
          #ifdef NT_FTINT
            float ntFt = mix( uFTint.y, uFTint.x, smoothstep( -0.45, -0.75, vNtWN.y ) );
            paint *= mix( ntFt, uFTint.z, smoothstep( 0.45, 0.75, vNtWN.y ) );
          #endif
          #ifdef NT_VCOL
            // per-board tint: COLOR_0.r 0.25..0.75 -> x0.92..x1.08; a missing attribute reads 0 or 1
            float ntV = vColor.r;
            paint *= ( ntV < 0.02 || ntV > 0.98 ) ? 1.0 : 1.0 + ( ntV - 0.5 ) * 0.32;
          #endif
          #if defined( NT_SEAM ) && defined( USE_COLOR )
            // zero-gap board seam: COLOR_0 = (tint, across 0..1, 1); groove AA'd by its derivative
            if ( vColor.b > 0.9 ) {
              float ntAc = clamp( vColor.g, 0.0, 1.0 ), ntE = min( ntAc, 1.0 - ntAc );
              float ntFw = max( fwidth( ntAc ), 1e-4 );
              float ntSg = ( 1.0 - smoothstep( uSeam.y - ntFw, uSeam.y + ntFw, ntE ) ) * clamp( 2.0 * uSeam.y / ntFw, 0.0, 1.0 );
              paint *= 1.0 - uSeam.x * ntSg;
            }
          #endif
          diffuseColor.rgb *= paint;
        #endif`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        #ifdef NT_UNDER_ORM
          roughnessFactor = mix( texture2D( uUnderOrm, vMapUv * uUnderScale ).g, roughnessFactor, ntUA );
        #endif`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        #if defined( NT_UNDER_N ) && defined( USE_NORMALMAP_TANGENTSPACE )
          {
            vec3 ntUN = texture2D( uUnderN, vMapUv * uUnderScale ).xyz * 2.0 - 1.0;
            vec3 ntDN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            ntDN.xy *= normalScale;
            normal = normalize( tbn * normalize( mix( ntUN, ntDN, ntUA ) ) );
          }
        #endif
        #if defined( NT_FACING ) && defined( USE_NORMALMAP_TANGENTSPACE )
          // facing weight on the detail normal (soffit beads only on soffits)
          if ( ntFace < 0.999 ) {
            vec3 ntMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            ntMapN.xy *= normalScale * ntFace;
            normal = normalize( tbn * ntMapN );
          }
        #endif`,
      );
    // vertex colours carry data (board tint / decal coverage), never an albedo multiply
    if (o.vcol || o.seam || (o.under?.c && o.dfade)) sh.fragmentShader = sh.fragmentShader.replace("#include <color_fragment>", "");
  };
  mat.customProgramCacheKey = () => `nt-surface2|${defs.join(",")}|${bias}`;
}

// ------------------------------------------------------------------ glass
/**
 * Window glass: Fresnel env reflection at full strength over a thin tinted
 * body, premultiplied so the reflection is not scaled down by the low opacity
 * (`rgb = diffuse * a + specular`, `a = body + reflectance`). An RGBA overlay
 * set adds dust/streaks (more opaque, rougher) or the fracture lines of
 * broken glass. Never writes depth (blended at the loader's renderOrder 10/11).
 */
function makeGlass(name: string, spec: Spec, sets: Map<string, TexSet>): THREE.Material {
  const g = new THREE.MeshPhysicalMaterial({
    name, color: spec.color ?? 0x9fb3b8, roughness: 0.04, metalness: 0, ior: spec.ior ?? 1.5,
    transparent: true, opacity: spec.opacity ?? 0.18, depthWrite: false,
    envMapIntensity: spec.env ?? 1.4, premultipliedAlpha: true,
  });
  if (spec.doubleSided) g.side = THREE.DoubleSide;
  const ov = spec.glassSet ? sets.get(spec.glassSet) : undefined;
  if (ov?.c) {
    const t = ov.c.clone();
    const rep = 1 / (ov.info.tile_m || 1);
    t.repeat.set(rep, -rep);
    t.needsUpdate = true;
    g.map = t;
  }
  const amount = spec.glassAmount ?? 0.5;
  g.onBeforeCompile = (sh) => {
    sh.uniforms.uGlassAmt = { value: amount };
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <map_pars_fragment>", "#include <map_pars_fragment>\nuniform float uGlassAmt;")
      .replace(
        "#include <map_fragment>",
        `float ntGA = 0.0;
        #ifdef USE_MAP
          vec4 ntGl = texture2D( map, vMapUv );
          ntGA = clamp( ntGl.a * uGlassAmt, 0.0, 1.0 );
          // dust on glass reads as a pale film in daylight (the overlay rgb is the dirt itself)
          diffuseColor.rgb = mix( diffuseColor.rgb, min( ntGl.rgb * 1.55, vec3( 1.0 ) ), ntGA );
          diffuseColor.a = mix( diffuseColor.a, 0.9, ntGA * 0.75 );
        #endif`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.55, ntGA );",
      )
      .replace(
        "#include <opaque_fragment>",
        `vec3 ntGD = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
        vec3 ntGS = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
        float ntGR = clamp( max( max( ntGS.r, ntGS.g ), ntGS.b ), 0.0, 1.0 );
        float ntA = diffuseColor.a;
        gl_FragColor = vec4( ntGD * ntA + ntGS, clamp( ntA + ntGR * ( 1.0 - ntA ), 0.0, 1.0 ) );`,
      )
      // fog on a premultiplied colour: scale the fog's change by the coverage
      .replace("#include <fog_fragment>", "vec4 ntPre = gl_FragColor;\n#include <fog_fragment>\ngl_FragColor.rgb = ntPre.rgb + ( gl_FragColor.rgb - ntPre.rgb ) * ntPre.a;")
      .replace("#include <premultiplied_alpha_fragment>", "");
  };
  g.customProgramCacheKey = () => `nt-glass2|${g.map ? 1 : 0}|${g.side}`;
  return g;
}

// ------------------------------------------------------------------ material
export function makeMaterial(name: string, spec: Spec, sets: Map<string, TexSet>): THREE.Material {
  if (spec.glass) return makeGlass(name, spec, sets);
  const set = spec.set ? sets.get(spec.set) : undefined;
  const m = new THREE.MeshStandardMaterial({
    name,
    color: spec.color ?? 0xffffff,
    roughness: spec.rough ?? 1,
    metalness: spec.metal ?? (set?.orm ? 1 : 0),
  });
  if (set) {
    const tile = spec.tile ?? set.info.tile_m ?? 1;
    const rep = 1 / tile;
    const prep = (t: THREE.Texture | undefined) => {
      if (!t) return undefined;
      const c = t.clone();
      // negative V: image-up = world-up on walls (the build's UV0 is v = 1 - y)
      c.repeat.set(rep, -rep);
      if (spec.rot) c.rotation = ((spec.rot === true ? 90 : spec.rot) * Math.PI) / 180;
      c.needsUpdate = true;
      return c;
    };
    if (set.c) m.map = prep(set.c)!;
    if (set.n) {
      m.normalMap = prep(set.n)!;
      m.normalScale.setScalar(spec.normal ?? 1);
    }
    let orm: THREE.Texture | undefined;
    if (set.orm) {
      orm = prep(set.orm)!;
      m.roughnessMap = orm;
      m.metalnessMap = orm;
      m.aoMap = orm;
      m.aoMapIntensity = 0.85;
    } else {
      m.metalness = spec.metal ?? 0;
    }
    if (m.map) {
      // a decal with an underlay takes the underlay's macro so the two match exactly
      const uSpec = spec.under ? SPECS[spec.under] : undefined;
      const und = uSpec?.set ? sets.get(uSpec.set) : undefined;
      const macroSet = und ?? set;
      const macroScale = macroSet.info.macro_tile_m ? tile / macroSet.info.macro_tile_m : 1;
      const uTile = und?.info.tile_m ?? 1;
      patchSurface(m, {
        tint: new THREE.Color(spec.tint ?? 0xffffff).multiplyScalar(spec.gain ?? 1),
        macro: spec.macro === false ? undefined : macroSet.macro,
        macroScale,
        macroStrength: spec.macroStrength ?? macroSet.info.macro_strength ?? 0.15,
        under: und ? { c: und.c, n: und.n, orm: und.orm, scale: tile / uTile, tint: new THREE.Color(uSpec!.tint ?? 0xffffff).multiplyScalar(uSpec!.gain ?? 1) } : undefined,
        macro2: spec.macro2,
        hue: spec.hue,
        mipBias: spec.mipBias ?? 0,
        cavity: spec.cavity ?? 0,
        orm,
        grime: spec.grime ?? 0,
        grimeH: spec.grimeH ?? 0.8,
        grimeY: spec.grimeY ?? 0.2,
        facing: spec.facing,
        flat: spec.flat,
        cutout: spec.alphaTest !== undefined,
        vcol: !!spec.vcol,
        dfade: spec.dfade,
        weather: spec.weather,
        seam: spec.seam,
        faceTint: spec.faceTint,
        tile,
      });
      if (spec.vcol || spec.seam || (spec.dfade && und?.c)) m.vertexColors = true;
    }
  } else if (spec.tint !== undefined) {
    m.color.setHex(spec.tint);
  }
  if (spec.alphaTest !== undefined) {
    m.alphaTest = spec.alphaTest;
    m.alphaToCoverage = true;
  }
  if (spec.doubleSided) m.side = THREE.DoubleSide;
  if (spec.emissive !== undefined) {
    m.emissive.setHex(spec.emissive);
    m.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  if (spec.flatRough !== undefined) {
    m.roughnessMap = null;
    m.roughness = spec.flatRough;
  }
  m.envMapIntensity = spec.env ?? 1;
  // ZERO-FLICKER layer 4: every opaque surface widens its specular lobe where the
  // normals under one pixel disagree (chrome trim, normal-mapped siding at range)
  specularAA(m);
  if (name.endsWith("_decal")) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  return m;
}
