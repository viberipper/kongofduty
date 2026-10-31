/**
 * client/src/webgpu-gaps.ts — the honest inventory of WebGPU look gaps.
 * ============================================================================
 *
 * three maps built-in materials to node materials on the WebGPU backend and in
 * doing so IGNORES `onBeforeCompile` entirely. Every scene patch written that way
 * therefore still compiles and still renders — it just renders WITHOUT its tweak,
 * so the loss is invisible unless someone compares screenshots.
 *
 * The materials that DID need porting (they would have lost geometry or their
 * whole look) now have TSL equivalents: the Ares reactor core, star dome, Mars
 * and atmosphere shell (tsl-materials.ts), the Nuketown sky, the astronaut suit
 * skin and the weapon FX quad families. What is left are colour/detail patches.
 *
 * This module names them once per page load on the WebGPU path, so the real
 * inventory sits in the console instead of in someone's head. Nothing here runs
 * on WebGL — that backend still gets every patch.
 */

/** One line per patch that does not exist as a node graph yet. */
const INACTIVE_ON_WEBGPU = [
  "dust2 wall shell (macro variation + 3D AO field)",
  "Nuketown backdrop shells",
  "Nuketown glass tint",
  "Nuketown foliage wind + tint",
  "Nuketown PBR spec tweaks (trim, siding)",
  "weapon chunk PBR (bullet debris)",
  "specular AA (glint crawl on fine normal maps)",
  "EVA ally shorts map swap (the node suit bakes its map into colorNode)",
];

let reported = false;

/** Call once, after the backend is known to be WebGPU. */
export function reportGpuGaps(): void {
  if (reported) return;
  reported = true;
  if (INACTIVE_ON_WEBGPU.length === 0) return;
  console.info(
    `[webgpu] ${INACTIVE_ON_WEBGPU.length} GLSL material patches stay WebGL-only (onBeforeCompile has no node equivalent):\n` +
      INACTIVE_ON_WEBGPU.map((g) => `  - ${g}`).join("\n"),
  );
}
