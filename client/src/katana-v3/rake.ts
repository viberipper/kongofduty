import * as THREE from "three";

/**
 * Radial raked gravel without UV authoring (MATERIALS.md "gravel_raked").
 *
 * The `gravel_raked` set has its furrows running along U. This patch recomputes the material's
 * UV per FRAGMENT from world XZ: straight rake (u = x, v = z) everywhere, and inside each ring
 * circle (centre x/z, radius r: a rock, a lantern, the katana dais) polar coordinates
 * (u = angle * d, v = d) so the furrows become concentric rings, ending against the straight rake
 * with a hard edge like a real karesansui. Sampling uses textureGrad with the derivatives of the
 * straight world UV so the angle wrap does not open a mip seam. Call AFTER patchWetness (it
 * reuses its vKvWorld varying). Up to RAKE_MAX (32) circles per material (the katana art world puts every bed in one material).
 */
export type RakeCircle = { x: number; z: number; r: number };
const RAKE_MAX = 32;

export function patchRadialRake(m: THREE.MeshStandardMaterial, circles: RakeCircle[], tile_m: number, angleDeg = 0): void {
  const list = circles.slice(0, RAKE_MAX);
  const data = Array.from({ length: RAKE_MAX }, (_, i) => new THREE.Vector4(list[i]?.x ?? 0, list[i]?.z ?? 0, list[i]?.r ?? 0, 0));
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uKvRake = { value: data };
    shader.uniforms.uKvRakeN = { value: list.length };
    shader.uniforms.uKvRakeTile = { value: 1 / tile_m };
    shader.uniforms.uKvRakeRot = { value: new THREE.Vector2(Math.cos((angleDeg * Math.PI) / 180), Math.sin((angleDeg * Math.PI) / 180)) };
    let fs = shader.fragmentShader;
    // the sampling lives in chunks that are only expanded after onBeforeCompile: inline them first
    for (const name of ["map_fragment", "normal_fragment_begin", "normal_fragment_maps", "roughnessmap_fragment", "metalnessmap_fragment", "aomap_fragment"]) {
      fs = fs.replace(`#include <${name}>`, (THREE.ShaderChunk as Record<string, string>)[name]!);
    }
    fs = fs.replace("void main() {", `uniform vec4 uKvRake[ ${RAKE_MAX} ]; uniform int uKvRakeN; uniform float uKvRakeTile; uniform vec2 uKvRakeRot;
      void main() {
        vec2 kvXZ = vKvWorld.xz;
        vec2 kvStraight = vec2( dot( kvXZ, uKvRakeRot ), dot( kvXZ, vec2( - uKvRakeRot.y, uKvRakeRot.x ) ) );
        vec2 kvRakeUv = kvStraight;
        float kvBest = 1e9;
        for ( int i = 0; i < ${RAKE_MAX}; i ++ ) {
          if ( i >= uKvRakeN ) break;
          vec2 dv = kvXZ - uKvRake[ i ].xy; float d = length( dv );
          if ( d < uKvRake[ i ].z && d < kvBest ) { kvBest = d; kvRakeUv = vec2( atan( dv.y, dv.x ) * d, d ); }
        }
        kvRakeUv *= uKvRakeTile;
        vec2 kvRakeDx = dFdx( kvStraight ) * uKvRakeTile, kvRakeDy = dFdy( kvStraight ) * uKvRakeTile;`);
    fs = fs.replace(/texture2D\(\s*(map|normalMap|roughnessMap|metalnessMap|aoMap),\s*v\w+Uv\s*\)/g, "textureGrad( $1, kvRakeUv, kvRakeDx, kvRakeDy )");
    // tangent frame from the rake UV (the chunk passes vNormalMapUv on its own line)
    fs = fs.replace(/(getTangentFrame\( - vViewPosition, normal,\s*#if defined\( USE_NORMALMAP \)\s*)vNormalMapUv/, "$1kvRakeUv");
    shader.fragmentShader = fs;
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kvrake`;
}
