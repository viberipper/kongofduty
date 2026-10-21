/**
 * client/src/graphics-presets.ts — QUALITY-PRESETS LOW→CINEMATIC.
 * ============================================================================
 *
 * A preset is a Partial<Prefs>: it sets the individual graphics switches
 * (bloom, AO, chroma, grain, sharpness, shadows, exposure) that the player
 * can then keep adjusting individually — the preset is a starting point,
 * not a mode. M1: HIGH matches EXACTLY the old look (everything new off,
 * grain/vignette on as in the old GRADE, exposure neutral, shadow = HIGH =
 * map-authored). Migrated old saves (without these keys) look the same as
 * before. Bloom/AO/chroma/sharpness are default-on only from ULTRA up.
 * The software tier (SwiftShader/llvmpipe) ignores bloom/AO/chroma/DOF/
 * sharpness entirely (see Game.setGraphicsOptions), no matter which preset
 * is chosen.
 *
 * Performance guardrails (measured on the previous build):
 *  - LOW:    2x MSAA, 1024 shadows, no post effects except grade.
 *  - MEDIUM: MSAA as before, 2048 shadows, AO off (only from ULTRA).
 *  - HIGH:   the previous signed look, shadows = map-authored.
 *  - ULTRA:  HIGH + 4096 shadows + bloom/AO/chroma/sharpness + env boost.
 *  - CINEMATIC: ULTRA + up to 8x MSAA (capable GPUs only, DPR gate) + DOF +
 *    motion blur.
 */

import type { Prefs, QualityPreset, ShadowQuality } from "./ui/prefs";

/**
 * Shadow resolution per tier. HIGH = -1 = map-authored: game.ts resolves it
 * against the size measured at world build (Shipment/Nuketown/Ares/
 * Dust2: 4096, ?classic: 512) and NEVER overrides the map authoring.
 * Only LOW/MEDIUM reduce, ULTRA forces 4096.
 */
export const SHADOW_SIZES: Record<ShadowQuality, number> = {
  off: 0,
  low: 1024,
  medium: 2048,
  high: -1, // map-authored (no overwrite) — see Game.applyShadowQuality
  ultra: 4096,
};

export const QUALITY_PRESETS: Record<QualityPreset, Partial<Prefs>> = {
  low: {
    bloom: false,
    bloomStrength: 0,
    ao: false,
    aoStrength: 0.5,
    chromatic: false,
    grain: false,
    vignette: true,
    motionBlur: false,
    dof: false,
    sharpen: 0,
    exposure: 1.1,
    shadowQuality: "low",
  },
  medium: {
    bloom: false,
    bloomStrength: 0.25,
    ao: false,
    aoStrength: 0.6,
    chromatic: false,
    grain: true,
    vignette: true,
    motionBlur: false,
    dof: false,
    sharpen: 0,
    exposure: 1.12,
    shadowQuality: "medium",
  },
  // M1: exactly the old look — no bloom/AO/chroma/sharpness, grain+vignette
  // as in the old GRADE, shadow = map-authored.
  high: {
    bloom: false,
    bloomStrength: 0.35,
    ao: false,
    aoStrength: 0.7,
    chromatic: false,
    grain: true,
    vignette: true,
    motionBlur: false,
    dof: false,
    sharpen: 0,
    exposure: 1.12,
    shadowQuality: "high",
  },
  ultra: {
    bloom: true,
    bloomStrength: 0.45,
    ao: true,
    aoStrength: 0.85,
    chromatic: true,
    grain: true,
    vignette: true,
    motionBlur: false,
    dof: false,
    sharpen: 0.5,
    exposure: 1.14,
    shadowQuality: "ultra",
  },
  cinematic: {
    bloom: true,
    bloomStrength: 0.55,
    ao: true,
    aoStrength: 1.0,
    chromatic: true,
    grain: true,
    vignette: true,
    motionBlur: true,
    dof: true,
    sharpen: 0.6,
    exposure: 1.16,
    shadowQuality: "ultra",
  },
};

/** Max. internal render scale per preset (adaptQuality + software calibration). */
export const QUALITY_MAX_SCALE: Record<QualityPreset, number> = {
  low: 0.75,
  medium: 0.85,
  high: 1,
  ultra: 1,
  cinematic: 1,
};

/** Env boost per preset, reversible around the basis measured at world build (m8).
 * Per-material ONLY (no scene.environmentIntensity — viewmodel freeze, see Game.applyEnvBoost). */
export const QUALITY_ENV_BOOST: Record<QualityPreset, number> = {
  low: 1,
  medium: 1,
  high: 1,
  ultra: 1.3,
  cinematic: 1.35,
};
