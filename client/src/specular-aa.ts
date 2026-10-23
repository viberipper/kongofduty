import * as THREE from "three";

/**
 * ZERO-FLICKER, LAYER 4 — specular anti-aliasing for fine normal maps.
 *
 * A fine normal map (a diamond tread, a riveted grate) packs many bumps into
 * one pixel at range; each throws its own glint and the glints crawl as the
 * camera moves — the flicker gate's motion test measured it on Ares' grate
 * (Δ43 over 138 px at 1.9 m). Two classic, cheap estimates of the normal
 * variance under a pixel widen the specular lobe exactly there:
 *
 *  - Toksvig: the mipmapped normal map averages bumps, so the decoded normal
 *    gets SHORTER where they disagree; (1 - |n|) / |n| is their variance.
 *  - screen-space derivatives of the PERTURBED normal (three only uses the
 *    geometric normal's), for detail the mip chain has not averaged yet.
 *
 * Flat or near surfaces keep their roughness; nothing else changes.
 */
export function specularAA(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  if (m.userData.specularAA) return m;
  m.userData.specularAA = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <normal_fragment_maps>",
        "float specAALen = 1.0;\n#include <normal_fragment_maps>\n" +
          "#ifdef USE_NORMALMAP_TANGENTSPACE\n" +
          "  specAALen = clamp( length( texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0 ), 0.05, 1.0 );\n" +
          "#endif",
      )
      .replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\n" +
          "{ vec3 sdxy = max( abs( dFdx( normal ) ), abs( dFdy( normal ) ) );\n" +
          "  float toksvig = ( 1.0 - specAALen ) / specAALen;\n" +
          "  float r2 = material.roughness * material.roughness + 0.6 * toksvig + 0.5 * dot( sdxy, sdxy );\n" +
          "  material.roughness = min( sqrt( r2 ), 1.0 ); }",
      );
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|specAA3`;
  m.needsUpdate = true;
  return m;
}
