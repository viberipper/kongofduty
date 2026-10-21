/**
 * client/src/graphics-presets.ts — QUALITY-PRESETS LOW→CINEMATIC.
 * ============================================================================
 *
 * Ein Preset ist ein Partial<Prefs>: Es setzt die einzelnen Grafik-Schalter
 * (Bloom, AO, Chroma, Grain, Schärfe, Schatten, Exposure), die der Spieler
 * danach weiter einzeln verstellen kann — das Preset ist ein Startpunkt,
 * kein Modus. M1: HIGH entspricht EXAKT dem alten Look (alles Neue aus,
 * Grain/Vignette an wie im alten GRADE, Exposure neutral, Shadow = HIGH =
 * map-authored). Migrierte Alt-Saves (ohne diese Keys) sehen dadurch aus wie
 * zuvor. Bloom/AO/Chroma/Schärfe sind erst ab ULTRA default-an.
 * Der Software-Tier (SwiftShader/llvmpipe) ignoriert Bloom/AO/Chroma/DOF/
 * Schärfe grundsätzlich (siehe Game.setGraphicsOptions), egal welches Preset
 * gewählt ist.
 *
 * Performance-Leitplanken (gemessen am bisherigen Build):
 *  - LOW:    2x MSAA, Schatten 1024, keine Post-Effekte außer Grade.
 *  - MEDIUM: MSAA wie gehabt, Schatten 2048, AO aus (erst ab ULTRA).
 *  - HIGH:   der bisherige signierte Look, Schatten = map-authored.
 *  - ULTRA:  HIGH + Schatten 4096 + Bloom/AO/Chroma/Schärfe + Env-Boost.
 *  - CINEMATIC: ULTRA + bis zu 8x MSAA (nur fähige GPUs, DPR-Gate) + DOF +
 *    Motion Blur.
 */

import type { Prefs, QualityPreset, ShadowQuality } from "./ui/prefs";

/**
 * Schattenauflösung pro Stufe. HIGH = -1 = map-authored: game.ts löst das
 * gegen die beim Weltaufbau gemessene Größe auf (Shipment/Nuketown/Ares/
 * Dust2: 4096, ?classic: 512) und überschreibt die Map-Autorisierung NIE.
 * Nur LOW/MEDIUM reduzieren, ULTRA erzwingt 4096.
 */
export const SHADOW_SIZES: Record<ShadowQuality, number> = {
  off: 0,
  low: 1024,
  medium: 2048,
  high: -1, // map-authored (kein Overwrite) — siehe Game.applyShadowQuality
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
  // M1: exakt der alte Look — kein Bloom/AO/Chroma/Schärfe, Grain+Vignette
  // wie im alten GRADE, Shadow = map-authored.
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

/** Max. interne Render-Skala pro Preset (adaptQuality + Software-Kalibrierung). */
export const QUALITY_MAX_SCALE: Record<QualityPreset, number> = {
  low: 0.75,
  medium: 0.85,
  high: 1,
  ultra: 1,
  cinematic: 1,
};

/** Env-Boost pro Preset, reversibel um die beim Weltaufbau gemessene Basis (m8).
 * NUR per-Material (kein scene.environmentIntensity — Viewmodel-Freeze, siehe Game.applyEnvBoost). */
export const QUALITY_ENV_BOOST: Record<QualityPreset, number> = {
  low: 1,
  medium: 1,
  high: 1,
  ultra: 1.3,
  cinematic: 1.35,
};
