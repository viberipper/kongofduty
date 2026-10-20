import * as THREE from "three";
import { activeSolids, type OBB } from "@shared/map";
import { NUKETOWN_SUN_DIR } from "./nuketown-sky";
import type { TexSet } from "./nuketown-specs";
import { aaSamples } from "./textures";

/**
 * NUKETOWN foliage (OWNER: GROUND, P5; WORKING-ORDERS D1 / D6 / D7 / D9):
 *
 *  - near-camera GRASS TUFTS (MAT's `grass_cards` atlas) on a toroidal grid that
 *    follows the camera: world-locked tufts, mask from the built lawn triangles
 *    minus every collider footprint, a taller darker FRINGE along walls, fences,
 *    hedges, posts and lawn edges, the lawn's own tint + macro breakup, gentle
 *    wind, shrinking to nothing between 8 and 13 m;
 *  - the HEDGES: leaf texture mapped triplanar (the build's world-metre box UVs
 *    would seam on a curved shell), leaf translucency against the sun, the
 *    build's vertex colour (dark leggy base, hollows), and alpha-tested leaf-
 *    cluster CARDS (MAT's `hedge_cards`) scattered over the shell, normals
 *    bent outward, fading out by 30 m;
 *  - FLOWERS in the beds the build stamped into the terrain node's glTF extras
 *    (`ntFoliage`), white daisies over the lawn, and leafy fillers on every
 *    planter top (`nt_soil_bed` / `nt_mulch` faces above 0.35 m);
 *  - the build's vertex colour (`COLOR_1`: Blender exports a placeholder
 *    COLOR_0 once its bake wipes the node trees) becomes `color` on the fences
 *    and hedges: the fence-board tint contract (MAT NT_VCOL), picket splash.
 *
 * Rules: software tier (`soft`) adds nothing but the vertex colours (and skips
 * the triplanar patch); alpha-to-coverage cutouts, never blended; 3 draw calls,
 * none of them in the shadow pass; wind only on what is flagged animated.
 * Called once by the frozen loader (nuketown-world.ts) after the map, props
 * and sky rig are in the scene.
 */
export type FoliageCtx = {
  scene: THREE.Scene;
  /** Parent for anything that belongs to the map (QA tags walk it). */
  root: THREE.Group;
  /** The built map (nuketown.glb scene: terrain / houses / fences / hedges / structures / stand-ins). */
  map: THREE.Object3D;
  renderer: THREE.WebGLRenderer;
  soft: boolean;
  /** The PBR library sets the loader already loaded (SPECS + backdrop sets). */
  sets: Map<string, TexSet>;
  /** URL of a file under public/assets/nuketown/. */
  asset: (path: string) => string;
};

export type Foliage = { update?: (dt: number, cam: THREE.Camera) => void };

type Bed = { name: string; poly: [number, number][]; y: number; flowers: string[]; sparse?: boolean };
type Track = { name: string; w: number; pts: [number, number][] };
type Stamp = { v: number; beds: Bed[]; tracks?: Track[] };

const LAWN_Y = 0.22;

// ------------------------------------------------------------------ small helpers
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inPoly(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function meshesUnder(o: THREE.Object3D | undefined): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o?.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
  });
  return out;
}

function matsOf(m: THREE.Mesh): THREE.MeshStandardMaterial[] {
  return ([] as THREE.Material[]).concat(m.material) as THREE.MeshStandardMaterial[];
}

/** World-space triangles of a mesh's primitive (positions transformed). */
function triangles(m: THREE.Mesh): Float32Array {
  const g = m.geometry;
  const pos = g.getAttribute("position");
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  m.updateWorldMatrix(true, false);
  for (let k = 0; k < n; k++) {
    v.fromBufferAttribute(pos, idx ? idx.getX(k) : k).applyMatrix4(m.matrixWorld);
    out[k * 3] = v.x;
    out[k * 3 + 1] = v.y;
    out[k * 3 + 2] = v.z;
  }
  return out;
}

function wrapCompile(mat: THREE.Material, key: string, fn: (sh: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    fn(sh);
  };
  mat.customProgramCacheKey = () => `${prevKey()}|${key}`;
  mat.needsUpdate = true;
}

// ------------------------------------------------------------------ vertex colour (fences, hedges)
function wireVertexColours(map: THREE.Object3D): void {
  for (const role of ["fences", "hedges"]) {
    for (const m of meshesUnder(map.getObjectByName(role))) {
      const g = m.geometry;
      const c1 = g.getAttribute("color_1");
      if (!c1) continue;
      g.setAttribute("color", c1);
      g.deleteAttribute("color_1");
      for (const mat of matsOf(m)) {
        // nt_fence_board reads COLOR.r as its per-board tint (MAT `vcol`); the
        // hedge (base, hollows) and the pickets (splash) multiply it in
        if ((mat.name === "nt_hedge" || mat.name === "nt_picket_white") && !mat.vertexColors) {
          mat.vertexColors = true;
          mat.needsUpdate = true;
        }
      }
    }
  }
}

// ------------------------------------------------------------------ fences: a smooth fill, not the bake's islands
/**
 * The fence kit is thousands of 14 cm boards: the bake's UV1 islands are a few
 * texels each (AO coverage ~7 %, undilated; GI bleeds between islands), so
 * the baked AO / GI read per board and the fence goes piebald (black and
 * bleached boards side by side). The kit materials instead take
 *  - their set's ORM occlusion (UV0) in the aoMap slot, and
 *  - the fence bake's MEDIAN irradiance (sky visibility in alpha, as the
 *    bake stores it) with a contact falloff toward the ground in place of the
 *    per-texel GI; the splash zone stays in the vertex colour. Sun and its
 *    shadows are real time, so the fence still reads its house's shadow.
 */
const FENCE_KIT = new Set(["nt_fence_board", "nt_picket_white"]);

function medianGI(tex: THREE.Texture | null): THREE.Vector4 | null {
  const img = tex?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img?.width || typeof document === "undefined") return null;
  const n = 256;
  const c = document.createElement("canvas");
  c.width = n;
  c.height = n;
  const x = c.getContext("2d", { willReadFrequently: true });
  if (!x) return null;
  try {
    x.drawImage(img, 0, 0, n, n);
    const d = x.getImageData(0, 0, n, n).data;
    const ch: number[][] = [[], [], [], []];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! + d[i + 1]! + d[i + 2]! < 3 * 13) continue; // unbaked texel
      for (let k = 0; k < 4; k++) ch[k]!.push(d[i + k]!);
    }
    if (ch[0]!.length < 64) return null;
    const med = ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]! / 255);
    const lin = new THREE.Color().setRGB(med[0]!, med[1]!, med[2]!, THREE.SRGBColorSpace); // -> working (linear)
    return new THREE.Vector4(lin.r, lin.g, lin.b, med[3]!);
  } catch {
    return null;
  }
}

// r2 D1: the zero-gap boards' seam groove is MAT's (nuketown-specs Spec.seam, COLOR_0 =
// (tint, across 0..1, 1) written by nt_fences.py); nothing to add here.

function fenceFill(map: THREE.Object3D): void {
  const gi = new Map<THREE.Texture, THREE.Vector4 | null>();
  for (const m of meshesUnder(map.getObjectByName("fences"))) {
    for (const mat of matsOf(m)) {
      if (!FENCE_KIT.has(mat.name) || !(mat instanceof THREE.MeshStandardMaterial) || mat.userData.ntFenceFill) continue;
      mat.userData.ntFenceFill = true;
      if (mat.aoMap && mat.aoMap.channel === 1) {
        mat.aoMap = mat.roughnessMap && mat.roughnessMap.channel === 0 ? mat.roughnessMap : null;
        mat.aoMapIntensity = 0.85;
      }
      const lmTex = mat.lightMap;
      if (!lmTex) continue;
      if (!gi.has(lmTex)) gi.set(lmTex, medianGI(lmTex));
      const v = gi.get(lmTex);
      if (!v) continue;
      // the median sits ~mid-height: normalise the contact ramp's mean (~0.9) out
      const uni = { uNtFenceGi: { value: new THREE.Vector4(v.x / 0.9, v.y / 0.9, v.z / 0.9, v.w) } };
      wrapCompile(mat, "nt-fence-gi", (sh) => {
        if (!sh.fragmentShader.includes("texture2D( lightMap, vLightMapUv )")) return;
        Object.assign(sh.uniforms, uni);
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nvarying float vNtFenceY;")
          .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvNtFenceY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;");
        sh.fragmentShader = sh.fragmentShader
          .replace("void main() {", "varying float vNtFenceY;\nuniform vec4 uNtFenceGi;\nvoid main() {")
          .replace(/texture2D\( lightMap, vLightMapUv \)/g, "vec4( uNtFenceGi.rgb * mix( 0.62, 1.0, smoothstep( 0.25, 1.2, vNtFenceY ) ), uNtFenceGi.a )");
      });
    }
  }
}

// ------------------------------------------------------------------ street: tar crack seals (r2 D4)
/**
 * The build's tar-line strips (`nt_decal_tarline_decal`, nt_ground.py tar_strip)
 * carry the distance to the line centre in their height: y = 0.008 + 0.03 * (w - |d|).
 * The line is drawn from that, box-filtered and resolved by alpha-to-coverage
 * (no blending, no sorting, no sub-pixel crawl): dark tar #2c2c28-#34342e,
 * roughness ~0.5, no normal relief, no glint (MAT M7 calibration). The strips
 * never cast shadows. The baked light of the asphalt under them (lightMap /
 * aoMap) is kept.
 */
const TAR = { y: 0.008, hs: 0.03 };
function tarLines(map: THREE.Object3D, cutoutAA: boolean): number {
  let n = 0;
  for (const m of meshesUnder(map.getObjectByName("terrain"))) {
    const mats = matsOf(m);
    const i = mats.findIndex((x) => x.name === "nt_decal_tarline_decal");
    if (i < 0) continue;
    const old = mats[i]!;
    const mat = new THREE.MeshStandardMaterial({
      name: "nt_decal_tarline_decal",
      color: new THREE.Color("#2f2f2a"),
      roughness: 0.5,
      metalness: 0,
      alphaToCoverage: cutoutAA,
      // no MSAA (software tier): a plain cutout at half coverage
      alphaTest: cutoutAA ? 0 : 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      lightMap: old.lightMap,
      lightMapIntensity: old.lightMapIntensity,
      aoMap: old.aoMap,
      aoMapIntensity: old.aoMapIntensity,
    });
    mat.envMapIntensity = 0.15;
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vNtTarY;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvNtTarY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;");
      sh.fragmentShader = sh.fragmentShader
        .replace("void main() {", "varying float vNtTarY;\nvoid main() {")
        .replace(
          "#include <alphatest_fragment>",
          `{
            float ntS = ( vNtTarY - ${TAR.y.toFixed(4)} ) / ${TAR.hs.toFixed(4)};   // metres inside the line edge (w - |d|)
            float ntFw = max( fwidth( ntS ), 1e-5 );
            diffuseColor.a = clamp( ntS / ntFw + 0.5, 0.0, 1.0 );
            // a thinner-than-a-pixel line fades instead of crawling
            diffuseColor.a *= clamp( 0.025 / ntFw, 0.25, 1.0 );
            if ( diffuseColor.a < 0.004 ) discard;
          }
          #include <alphatest_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => "nt-tarline";
    if (Array.isArray(m.material)) {
      const arr = m.material.slice();
      arr[i] = mat;
      m.material = arr;
    } else m.material = mat;
    m.castShadow = false;
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ hedges: triplanar leaves + translucency
const TRI_PARS = `
varying vec3 vNtTriP;
varying vec3 vNtTriN;
uniform float uNtTri;
uniform vec3 uNtSunDir;
uniform vec3 uNtSunCol;
vec3 ntTriW() { vec3 w = pow( abs( normalize( vNtTriN ) ), vec3( 4.0 ) ); return w / dot( w, vec3( 1.0 ) ); }
vec4 ntTri( sampler2D t ) {
  vec3 w = ntTriW();
  return texture2D( t, vNtTriP.zy * uNtTri ) * w.x + texture2D( t, vNtTriP.xz * uNtTri ) * w.y + texture2D( t, vNtTriP.xy * uNtTri + 0.37 ) * w.z;
}
`;

function patchHedge(mat: THREE.MeshStandardMaterial, sun: { dir: THREE.Vector3; col: THREE.Color }): void {
  // leaves at real scale: the set is authored for 0.6 m; clipped boxwood reads
  // right at about half that (WORK-ORDERS X7: "used at 2x scale")
  const rep = mat.map ? Math.abs(mat.map.repeat.x) : 1 / 0.6;
  const tile = 1 / rep;
  const triRep = 1 / (tile >= 0.55 ? tile * 0.5 : tile);
  const uni = { uNtTri: { value: triRep }, uNtSunDir: { value: sun.dir }, uNtSunCol: { value: sun.col } };
  // r2 D2 / CUL14: no blotch macro (it samples the box UVs: square patches) and
  // no pale top sheen on a clipped hedge (leaves are matte at this scale)
  const nu = mat.userData.ntUniforms as Record<string, { value: unknown }> | undefined;
  if (nu?.uMacroStrength) nu.uMacroStrength.value = 0;
  if (nu?.uMacro2) (nu.uMacro2.value as THREE.Vector2).y = 0;
  mat.roughness = Math.max(mat.roughness, 0.88);
  wrapCompile(mat, "nt-hedge-tri", (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vNtTriP;\nvarying vec3 vNtTriN;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvNtTriP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvNtTriN = normalize( mat3( modelMatrix ) * objectNormal );");
    let f = sh.fragmentShader.replace("void main() {", `${TRI_PARS}\nvoid main() {`);
    f = f.replace(/texture2D\( map, vMapUv \)/g, "ntTri( map )");
    f = f.replace(/texture2D\( metalnessMap, vMetalnessMapUv \)/g, "ntTri( metalnessMap )");
    // the set's ORM AO (UV0) seams like the colour would; a baked AO (UV1) stays
    if (mat.aoMap && mat.aoMap.channel === 0) f = f.replace(/texture2D\( aoMap, vAoMapUv \)/g, "ntTri( aoMap )");
    f = f.replace(
      "#include <roughnessmap_fragment>",
      `float roughnessFactor = roughness;
      #ifdef USE_ROUGHNESSMAP
        roughnessFactor *= ntTri( roughnessMap ).g;
      #endif
      roughnessFactor = max( roughnessFactor, 0.85 );`,
    );
    f = f.replace("#include <aomap_fragment>", "reflectedLight.directSpecular *= 0.35;\nreflectedLight.indirectSpecular *= 0.25;\n#include <aomap_fragment>");
    f = f.replace(
      "#include <normal_fragment_maps>",
      `#ifdef USE_NORMALMAP
      {
        vec3 wn = normalize( vNtTriN );
        vec3 bw = ntTriW();
        vec3 tx = texture2D( normalMap, vNtTriP.zy * uNtTri ).xyz * 2.0 - 1.0;
        vec3 ty = texture2D( normalMap, vNtTriP.xz * uNtTri ).xyz * 2.0 - 1.0;
        vec3 tz = texture2D( normalMap, vNtTriP.xy * uNtTri + 0.37 ).xyz * 2.0 - 1.0;
        tx.xy *= normalScale; ty.xy *= normalScale; tz.xy *= normalScale;
        // whiteout blend (Golus): each projection's tangent normal swizzled to world
        tx = vec3( tx.xy + wn.zy, abs( tx.z ) * wn.x );
        ty = vec3( ty.xy + wn.xz, abs( ty.z ) * wn.y );
        tz = vec3( tz.xy + wn.xy, abs( tz.z ) * wn.z );
        vec3 nw = normalize( tx.zyx * bw.x + ty.xzy * bw.y + tz.xyz * bw.z );
        normal = normalize( ( viewMatrix * vec4( nw, 0.0 ) ).xyz );
      }
      #endif`,
    );
    // leaf translucency: sun light that comes THROUGH the hedge toward the eye,
    // strongest on the faces turned away from the sun (thin transmission look)
    f = f.replace(
      "#include <opaque_fragment>",
      `{
        vec3 ntLv = normalize( ( viewMatrix * vec4( uNtSunDir, 0.0 ) ).xyz );
        vec3 ntV = normalize( vViewPosition );
        float ntBack = pow( clamp( dot( ntV, -ntLv ), 0.0, 1.0 ), 3.0 );
        float ntThin = clamp( -dot( normal, ntLv ), 0.0, 1.0 );
        outgoingLight += diffuseColor.rgb * uNtSunCol * ( ntBack * ( 0.3 + 0.7 * ntThin ) * 0.32 + ntThin * 0.04 );
      }
      #include <opaque_fragment>`,
    );
    sh.fragmentShader = f;
  });
}

// ------------------------------------------------------------------ hedge leaf cards
/**
 * The card shell of the SHARED FOLIAGE KIT (scripts/nuketown/foliage/foliage_kit.py
 * `pack_cards`): the build stamps it into the hedges node's extras (`ntCards`), 17
 * bytes a card: pos u16x3 over the box | facing oct s8x2 | up-angle u8 in
 * card_basis(facing) | bent normal oct s8x2 | width u8 (cm) | height/width u8
 * (/100) | cell (2 bits) + set (2 bits) | rgb u8x3. One InstancedMesh per set.
 */
type CardRec = { v: number; n: number; o: [number, number, number]; s: [number, number, number]; b64: string };
type Cards = { M: Float32Array; N: Float32Array; C: Float32Array; cell: Float32Array; set: Uint8Array; n: number };

function octDecode(a: number, b: number, out: THREE.Vector3): THREE.Vector3 {
  let x = a / 127, y = b / 127;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  return out.set(x, y, z).normalize();
}

function decodeCards(rec: CardRec): Cards | null {
  if (rec?.v !== 1 || !rec.n || typeof atob === "undefined") return null;
  const bin = atob(rec.b64);
  if (bin.length !== rec.n * 17) return null;
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const dv = new DataView(u8.buffer);
  const n = rec.n;
  const M = new Float32Array(n * 16), N = new Float32Array(n * 3), C = new Float32Array(n * 3), cell = new Float32Array(n * 2), set = new Uint8Array(n);
  const f = new THREE.Vector3(), up = new THREE.Vector3(), r = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), nn = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const o = i * 17;
    const px = rec.o[0] + (dv.getUint16(o, true) / 65535) * rec.s[0];
    const py = rec.o[1] + (dv.getUint16(o + 2, true) / 65535) * rec.s[1];
    const pz = rec.o[2] + (dv.getUint16(o + 4, true) / 65535) * rec.s[2];
    octDecode(dv.getInt8(o + 6), dv.getInt8(o + 7), f);
    // card_basis(f): the same canonical frame the build used for the up-angle
    t1.crossVectors(Math.abs(f.y) < 0.99 ? Y : X, f).normalize();
    t2.crossVectors(f, t1);
    const ang = (dv.getUint8(o + 8) / 256) * Math.PI * 2;
    up.copy(t1).multiplyScalar(Math.sin(ang)).addScaledVector(t2, Math.cos(ang)).normalize();
    octDecode(dv.getInt8(o + 9), dv.getInt8(o + 10), nn);
    const w = dv.getUint8(o + 11) / 100, h = w * (dv.getUint8(o + 12) / 100);
    const cs = dv.getUint8(o + 13);
    r.crossVectors(up, f);
    m.set(r.x * w, up.x * h, f.x, px, r.y * w, up.y * h, f.y, py, r.z * w, up.z * h, f.z, pz, 0, 0, 0, 1);
    m.toArray(M, i * 16);
    N[i * 3] = nn.x; N[i * 3 + 1] = nn.y; N[i * 3 + 2] = nn.z;
    // the build's colours are linear multipliers (as its vertex colours)
    C[i * 3] = u8[o + 14]! / 255; C[i * 3 + 1] = u8[o + 15]! / 255; C[i * 3 + 2] = u8[o + 16]! / 255;
    cell[i * 2] = cs & 1; cell[i * 2 + 1] = (cs >> 1) & 1;
    set[i] = (cs >> 2) & 3;
  }
  return { M, N, C, cell, set, n };
}

/** Alpha that keeps its coverage down the mip chain (A2C cutouts thin out to nothing at range otherwise). */
const MIP_ALPHA = `
  #if defined( USE_MAP ) && __VERSION__ >= 300
  {
    vec2 ntTs = vec2( textureSize( map, 0 ) );
    vec2 ntDx = dFdx( vMapUv * ntTs ), ntDy = dFdy( vMapUv * ntTs );
    float ntMip = max( 0.0, 0.5 * log2( max( dot( ntDx, ntDx ), dot( ntDy, ntDy ) ) ) );
    diffuseColor.a *= 1.0 + ntMip * 0.22;
  }
  #endif`;

function cardMaterial(name: string, map: THREE.Texture, cutoutAA: boolean, alphaTest: number, sun: { dir: THREE.Vector3; col: THREE.Color }, fade: THREE.Vector2, transl: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ name, map, roughness: 0.92, metalness: 0, alphaTest, alphaToCoverage: cutoutAA, side: THREE.DoubleSide });
  const uni = { uNtSunDir: { value: sun.dir }, uNtSunCol: { value: sun.col }, uNtFade: { value: fade } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aCell;\nattribute vec3 aNrm;\nvarying vec3 vNtCardN;\nvarying float vNtDist;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = uv * 0.5 + aCell * 0.5;\n#endif")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        // lighting normal = the plant volume's bent normal, not the card's facing
        vNtCardN = normalize( ( viewMatrix * vec4( mat3( modelMatrix ) * aNrm, 0.0 ) ).xyz );
        vNtDist = length( ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz - cameraPosition );`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "varying vec3 vNtCardN;\nvarying float vNtDist;\nuniform vec3 uNtSunDir;\nuniform vec3 uNtSunCol;\nuniform vec2 uNtFade;\nvoid main() {")
      .replace("#include <alphatest_fragment>", `${MIP_ALPHA}\ndiffuseColor.a *= 1.0 - smoothstep( uNtFade.x, uNtFade.y, vNtDist );\n#include <alphatest_fragment>`)
      .replace("#include <normal_fragment_maps>", "normal = normalize( vNtCardN );")
      .replace(
        "#include <aomap_fragment>",
        // a leaf has no clear-coat gloss: keep the sheen off the clipped tops
        "reflectedLight.directSpecular *= 0.35;\nreflectedLight.indirectSpecular *= 0.25;\n#include <aomap_fragment>",
      )
      .replace(
        "#include <opaque_fragment>",
        `{
          vec3 ntLv = normalize( ( viewMatrix * vec4( uNtSunDir, 0.0 ) ).xyz );
          float ntBack = pow( clamp( dot( normalize( vViewPosition ), -ntLv ), 0.0, 1.0 ), 3.0 );
          outgoingLight += diffuseColor.rgb * uNtSunCol * ntBack * ${transl.toFixed(3)};
        }
        #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `nt-card-${name}`;
  return mat;
}

function cardInstances(cards: Cards, which: number, mat: THREE.MeshStandardMaterial, name: string, qaId: string): THREE.InstancedMesh | null {
  const idx: number[] = [];
  for (let i = 0; i < cards.n; i++) if (cards.set[i] === which) idx.push(i);
  if (!idx.length) return null;
  const geo = new THREE.PlaneGeometry(1, 1);
  const nrm = new Float32Array(idx.length * 3), cell = new Float32Array(idx.length * 2);
  const inst = new THREE.InstancedMesh(geo, mat, idx.length);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  idx.forEach((k, i) => {
    m.fromArray(cards.M, k * 16);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, c.setRGB(cards.C[k * 3]!, cards.C[k * 3 + 1]!, cards.C[k * 3 + 2]!));
    nrm.set(cards.N.subarray(k * 3, k * 3 + 3), i * 3);
    cell.set(cards.cell.subarray(k * 2, k * 2 + 2), i * 2);
  });
  geo.setAttribute("aNrm", new THREE.InstancedBufferAttribute(nrm, 3));
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(cell, 2));
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = false;
  inst.receiveShadow = true;
  inst.name = name;
  inst.userData.qaId = qaId;
  inst.matrixAutoUpdate = false;
  return inst;
}

/** Fallback for a build without `ntCards` (an older nuketown.glb): ~5 cards/m2 sampled over the hedge shell. */
function sampledHedgeCards(hedges: THREE.Mesh[]): Cards | null {
  const Nn: number[] = [], Cc: number[] = [];
  let total = 0;
  const pool: { p: THREE.Vector3; n: THREE.Vector3; c: THREE.Color; a: number }[] = [];
  for (const m of hedges) {
    const g = m.geometry;
    const pos = g.getAttribute("position"), nrm = g.getAttribute("normal"), col = g.getAttribute("color");
    const idx = g.getIndex();
    if (!pos || !nrm) continue;
    const n = idx ? idx.count : pos.count;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let k = 0; k + 2 < n; k += 3) {
      const ia = idx ? idx.getX(k) : k, ib = idx ? idx.getX(k + 1) : k + 1, ic = idx ? idx.getX(k + 2) : k + 2;
      A.fromBufferAttribute(pos, ia); B.fromBufferAttribute(pos, ib); C.fromBufferAttribute(pos, ic);
      const area = B.clone().sub(A).cross(C.clone().sub(A)).length() / 2;
      if (Math.min(A.y, B.y, C.y) < LAWN_Y + 0.12) continue;
      pool.push({ p: A.clone().add(B).add(C).multiplyScalar(1 / 3), n: new THREE.Vector3(nrm.getX(ia), nrm.getY(ia), nrm.getZ(ia)).normalize(), c: col ? new THREE.Color(col.getX(ia), col.getY(ia), col.getZ(ia)) : new THREE.Color(1, 1, 1), a: area });
      total += area;
    }
  }
  if (!pool.length) return null;
  const count = Math.min(6000, Math.round(total * 5));
  const R = rng(4242);
  const M = new Float32Array(count * 16), cell = new Float32Array(count * 2), set = new Uint8Array(count);
  const mm = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), Pv = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < count; i++) {
    const s = pool[Math.floor(R() * pool.length)]!;
    Pv.copy(s.p).addScaledVector(s.n, 0.03);
    Q.setFromUnitVectors(Z, s.n);
    const sz = 0.2 + R() * 0.1;
    S.set(sz, sz, 1);
    mm.compose(Pv, Q, S).toArray(M, i * 16);
    Nn.push(s.n.x, s.n.y, s.n.z); Cc.push(s.c.r, s.c.g, s.c.b);
    cell[i * 2] = R() < 0.5 ? 0 : 1; cell[i * 2 + 1] = R() < 0.5 ? 0 : 1;
  }
  return { M, N: new Float32Array(Nn), C: new Float32Array(Cc), cell, set, n: count };
}

// ------------------------------------------------------------------ grass mask (lawn minus footprints, fringe)
type Mask = { tex: THREE.DataTexture; min: THREE.Vector2; size: THREE.Vector2 };

async function grassMask(terrain: THREE.Mesh[], covers: THREE.Mesh[], solids: OBB[]): Promise<Mask | null> {
  const lawn = terrain.filter((m) => matsOf(m).some((x) => x.name === "nt_grass"));
  if (!lawn.length) return null;
  const tris = lawn.map(triangles);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const T of tris) for (let i = 0; i < T.length; i += 3) {
    x0 = Math.min(x0, T[i]!); x1 = Math.max(x1, T[i]!); z0 = Math.min(z0, T[i + 2]!); z1 = Math.max(z1, T[i + 2]!);
  }
  x0 -= 1; z0 -= 1; x1 += 1; z1 += 1;
  const PPM = 8;
  const W = Math.ceil((x1 - x0) * PPM), H = Math.ceil((z1 - z0) * PPM);
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d", { willReadFrequently: true })!;
  c.fillStyle = "#000";
  c.fillRect(0, 0, W, H);
  const X = (x: number) => (x - x0) * PPM, Z = (z: number) => (z - z0) * PPM;
  // lawn triangles: R = lawn, B = its height (y 0.1..0.4)
  for (const T of tris) for (let i = 0; i + 8 < T.length; i += 9) {
    const y = (T[i + 1]! + T[i + 4]! + T[i + 7]!) / 3;
    const b = Math.max(0, Math.min(255, Math.round(((y - 0.1) / 0.3) * 255)));
    c.fillStyle = `rgb(255,0,${b})`;
    c.beginPath();
    c.moveTo(X(T[i]!), Z(T[i + 2]!));
    c.lineTo(X(T[i + 3]!), Z(T[i + 5]!));
    c.lineTo(X(T[i + 6]!), Z(T[i + 8]!));
    c.closePath();
    c.fill();
    c.strokeStyle = c.fillStyle;
    c.lineWidth = 0.6;
    c.stroke(); // close the hairline seams between lawn triangles
  }
  // flat surfaces over the lawn (pads, drives, pavers, decks, floors, sidewalks):
  // the SketchUp lawn often runs on under them, the tufts must not poke through
  c.fillStyle = "#000";
  for (const m of covers) {
    if (matsOf(m).some((x) => x.name === "nt_grass")) continue;
    const T = triangles(m);
    for (let i = 0; i + 8 < T.length; i += 9) {
      const ya = T[i + 1]!, yb = T[i + 4]!, yc = T[i + 7]!;
      const y = (ya + yb + yc) / 3;
      if (y < 0.215 || y > 0.9) continue;
      const ux = T[i + 3]! - T[i]!, uy = yb - ya, uz = T[i + 5]! - T[i + 2]!;
      const vx = T[i + 6]! - T[i]!, vy = yc - ya, vz = T[i + 8]! - T[i + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (Math.abs(ny) < 0.7 * Math.hypot(nx, ny, nz)) continue;
      c.beginPath();
      c.moveTo(X(T[i]!), Z(T[i + 2]!));
      c.lineTo(X(T[i + 3]!), Z(T[i + 5]!));
      c.lineTo(X(T[i + 6]!), Z(T[i + 8]!));
      c.closePath();
      c.fill();
    }
  }
  // everything standing on the lawn: walls, fences, posts, hedges, sheds, decks, props
  for (const o of solids) {
    const v = (o as OBB & { visual?: string }).visual;
    if (v === "lawn" || v === "boundary") continue;
    const bot = o.y - o.sy / 2, top = o.y + o.sy / 2;
    if (bot > 0.5 || top < 0.26) continue;
    const ca = Math.cos(o.yaw), sa = Math.sin(o.yaw);
    const hx = o.sx / 2 + 0.03, hz = o.sz / 2 + 0.03;
    c.beginPath();
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([u, w], k) => {
      const lx = u! * hx, lz = w! * hz;
      const px = X(o.x + lx * ca - lz * sa), pz = Z(o.z + lx * sa + lz * ca);
      if (k) c.lineTo(px, pz); else c.moveTo(px, pz);
    });
    c.closePath();
    c.fill();
  }
  const base = c.getImageData(0, 0, W, H).data;
  // fringe: how close the nearest non-lawn edge is (a ~0.35 m blur of the lawn mask)
  const cv2 = document.createElement("canvas");
  cv2.width = W; cv2.height = H;
  const c2 = cv2.getContext("2d", { willReadFrequently: true })!;
  c2.filter = "blur(3px)";
  c2.drawImage(cv, 0, 0);
  const blur = c2.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const lawnPx = base[i * 4]! > 127;
    out[i * 4] = lawnPx ? 255 : 0;
    const near = 1 - blur[i * 4]! / 255; // 0 deep in the lawn, ~0.5 at an edge
    out[i * 4 + 1] = lawnPx ? Math.min(255, Math.round(Math.max(0, near - 0.02) * 2.4 * 255)) : 0;
    out[i * 4 + 2] = base[i * 4 + 2]!;
    out[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { tex, min: new THREE.Vector2(x0, z0), size: new THREE.Vector2(x1 - x0, z1 - z0) };
}

// ------------------------------------------------------------------ lawn: worn tracks + damp strips (r2 D5)
/**
 * A world-space LAWN MASK over the grass mask's frame (8 px/m): R = wear (the
 * spawn-exit tracks the build stamps into `ntFoliage.tracks`, patchy and
 * feathered over ~0.5 m), G = damp (a 0.5 m band along every fence / hedge
 * base and under decks / stoops / porches, feathered). MAT's nt_grass and the
 * tufts read it: worn = drier, paler, shorter; damp = darker. No geometry, no
 * hard edge, nothing coplanar.
 */
type LawnMaskT = { tex: THREE.DataTexture; min: THREE.Vector2; size: THREE.Vector2 };

function lawnMask(stamp: Stamp | null, solids: OBB[], frame: Mask): LawnMaskT | null {
  if (typeof document === "undefined") return null;
  const PPM = 8;
  const min = frame.min, size = frame.size;
  const W = Math.ceil(size.x * PPM), H = Math.ceil(size.y * PPM);
  const X = (x: number) => (x - min.x) * PPM, Z = (z: number) => (z - min.y) * PPM;
  const layer = (draw: (c: CanvasRenderingContext2D) => void, blurPx: number) => {
    const a = document.createElement("canvas");
    a.width = W; a.height = H;
    const c = a.getContext("2d", { willReadFrequently: true })!;
    c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
    draw(c);
    const b = document.createElement("canvas");
    b.width = W; b.height = H;
    const cb = b.getContext("2d", { willReadFrequently: true })!;
    cb.filter = `blur(${blurPx}px)`;
    cb.drawImage(a, 0, 0);
    return cb.getImageData(0, 0, W, H).data;
  };
  const R = rng(515);
  const wear = layer((c) => {
    c.lineCap = "round"; c.lineJoin = "round";
    for (const t of stamp?.tracks ?? []) {
      // a few jittered, thinner strokes: a trampled path, not a painted stripe
      for (let k = 0; k < 4; k++) {
        c.strokeStyle = `rgba(255,255,255,${(0.32 + R() * 0.2).toFixed(2)})`;
        c.lineWidth = t.w * PPM * (0.45 + R() * 0.5);
        c.beginPath();
        t.pts.forEach(([x, z], i) => {
          const jx = (R() - 0.5) * 0.35, jz = (R() - 0.5) * 0.35;
          if (i) c.lineTo(X(x + jx), Z(z + jz)); else c.moveTo(X(x + jx), Z(z + jz));
        });
        c.stroke();
      }
    }
  }, 3);
  const damp = layer((c) => {
    for (const o of solids) {
      const v = (o as OBB & { visual?: string }).visual ?? "";
      const bot = o.y - o.sy / 2;
      if (bot > 0.6) continue;
      const fence = v === "fence" || v === "hedge";
      const under = v === "deck" || v === "stoop" || v === "porch" || v === "paving" || v.startsWith("structure");
      if (!fence && !under) continue;
      const ca = Math.cos(o.yaw), sa = Math.sin(o.yaw);
      const pad = fence ? 0.38 : 0.22;
      const hx = o.sx / 2 + pad, hz = o.sz / 2 + pad;
      c.fillStyle = fence ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.9)";
      c.beginPath();
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([u, w], k) => {
        const lx = u! * hx, lz = w! * hz;
        const px = X(o.x + lx * ca - lz * sa), pz = Z(o.z + lx * sa + lz * ca);
        if (k) c.lineTo(px, pz); else c.moveTo(px, pz);
      });
      c.closePath();
      c.fill();
    }
  }, 2.5);
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = wear[i * 4]!;
    out[i * 4 + 1] = damp[i * 4]!;
    out[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { tex, min: min.clone(), size: size.clone() };
}

const LAWN_MASK_GLSL = `
  vec4 ntLawnM( vec2 xz ) { return texture2D( uNtLawnMask, ( xz - uNtLawnMin ) / uNtLawnSize ); }
  vec3 ntLawnTone( vec3 c, vec4 m ) {
    // worn: trampled, drier and paler; damp: darker and a little bluer
    c = mix( c, c * vec3( 1.3, 1.17, 0.72 ), smoothstep( 0.0, 0.7, m.r ) * 0.85 );
    return c * ( 1.0 - 0.26 * clamp( m.g, 0.0, 1.0 ) ) * vec3( 1.0, 1.0, 1.0 + 0.04 * m.g );
  }`;

function patchLawn(mat: THREE.MeshStandardMaterial, lm: LawnMaskT): void {
  const uni = { uNtLawnMask: { value: lm.tex }, uNtLawnMin: { value: lm.min }, uNtLawnSize: { value: lm.size } };
  wrapCompile(mat, "nt-lawn-mask", (sh) => {
    if (!sh.fragmentShader.includes("#include <roughnessmap_fragment>")) return;
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vNtLawnXZ;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvNtLawnXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", `varying vec2 vNtLawnXZ;\nuniform sampler2D uNtLawnMask; uniform vec2 uNtLawnMin; uniform vec2 uNtLawnSize;\n${LAWN_MASK_GLSL}\nvoid main() {`)
      .replace("#include <roughnessmap_fragment>", "diffuseColor.rgb = ntLawnTone( diffuseColor.rgb, ntLawnM( vNtLawnXZ ) );\n#include <roughnessmap_fragment>");
  });
}

// ------------------------------------------------------------------ lawn border fringe (r2 D5, SO13)
/**
 * Grass blades spilling 5-10 cm over EVERY lawn border (sidewalks, curbs,
 * drives, beds, dirt; the street-out lawns too): the boundary edges of every
 * nt_grass mesh (an edge is a border when the point 6 cm beyond it is on no
 * lawn triangle, so internal seams / T-junctions never sprout blades), a
 * grass_cards blade card every ~9 cm leaning out over the edge, coloured from
 * the turf under its root, gentle wind (flagged animated), faded out by 30 m.
 */
function lawnBorders(meshes: THREE.Mesh[]): { p: number[]; n: number[] } {
  const tris: number[] = [];
  for (const m of meshes) {
    const T = triangles(m);
    for (let i = 0; i + 8 < T.length; i += 9) {
      const ny = (T[i + 5]! - T[i + 2]!) * (T[i + 6]! - T[i]!) - (T[i + 3]! - T[i]!) * (T[i + 8]! - T[i + 2]!);
      if (Math.abs(ny) < 1e-9) continue;
      for (let k = 0; k < 9; k++) tris.push(T[i + k]!);
    }
  }
  const nt = tris.length / 9;
  // 2D grid of triangles for the inside test
  const cell = 1.0;
  const grid = new Map<string, number[]>();
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const x0 = Math.min(tris[o]!, tris[o + 3]!, tris[o + 6]!), x1 = Math.max(tris[o]!, tris[o + 3]!, tris[o + 6]!);
    const z0 = Math.min(tris[o + 2]!, tris[o + 5]!, tris[o + 8]!), z1 = Math.max(tris[o + 2]!, tris[o + 5]!, tris[o + 8]!);
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
      const k = `${i},${j}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(t);
    }
  }
  const onLawn = (x: number, z: number) => {
    for (const t of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      const o = t * 9;
      const ax = tris[o]!, az = tris[o + 2]!, bx = tris[o + 3]!, bz = tris[o + 5]!, cx = tris[o + 6]!, cz = tris[o + 8]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const w = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (u >= -1e-4 && w >= -1e-4 && u + w <= 1 + 1e-4) return true;
    }
    return false;
  };
  // edges used once (positions welded at 1 mm)
  const key = (x: number, z: number) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
  const count = new Map<string, number>();
  const edges: [number, number, number, number, number, number, number][] = [];
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    for (let e = 0; e < 3; e++) {
      const a = o + e * 3, b = o + ((e + 1) % 3) * 3, c = o + ((e + 2) % 3) * 3;
      const ka = key(tris[a]!, tris[a + 2]!), kb = key(tris[b]!, tris[b + 2]!);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      count.set(k, (count.get(k) ?? 0) + 1);
      edges.push([tris[a]!, tris[a + 1]!, tris[a + 2]!, tris[b]!, tris[b + 1]!, tris[b + 2]!, c]);
    }
  }
  const P: number[] = [], N: number[] = [];
  for (const [ax, ay, az, bx, by, bz, c] of edges) {
    const ka = key(ax, az), kb = key(bx, bz);
    if (count.get(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`) !== 1) continue;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.02) continue;
    // outward = away from the triangle's third corner
    let nx = -(bz - az) / L, nz = (bx - ax) / L;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (nx * (tris[c]! - mx) + nz * (tris[c + 2]! - mz) > 0) { nx = -nx; nz = -nz; }
    if (onLawn(mx + nx * 0.06, mz + nz * 0.06)) continue; // an internal seam, not a border
    const k = Math.max(1, Math.round(L / 0.09));
    for (let i = 0; i < k; i++) {
      const t = (i + 0.5) / k;
      P.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
      N.push(nx, nz);
    }
  }
  return { p: P, n: N };
}

function fringeInstances(meshes: THREE.Mesh[], cards: TexSet | undefined, lawnMat: THREE.MeshStandardMaterial | undefined, lm: LawnMaskT | null, cutoutAA: boolean) {
  if (!cards?.c || !meshes.length) return null;
  const { p, n } = lawnBorders(meshes);
  const count = Math.min(40000, p.length / 3);
  if (!count) return null;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0); // base on y = 0
  const cell = new Float32Array(count * 2);
  const lu = lawnMat?.userData.ntUniforms as Record<string, { value: unknown }> | undefined;
  const tile = lawnMat?.map ? 1 / Math.abs(lawnMat.map.repeat.x) : 1.6;
  const uni = {
    uNtTime: { value: 0 },
    uNtTile: { value: tile },
    uNtTint: lu?.uTint ?? { value: new THREE.Color(1, 1, 1) },
    uNtLawn: { value: lawnMat?.map ?? null },
    uNtLawnMask: { value: lm?.tex ?? null },
    uNtLawnMin: { value: lm?.min ?? new THREE.Vector2(0, 0) },
    uNtLawnSize: { value: lm?.size ?? new THREE.Vector2(1, 1) },
  };
  const mat = new THREE.MeshStandardMaterial({ name: "nt_grass_fringe_fx", map: cards.c, roughness: 0.92, metalness: 0, alphaTest: 0.5, alphaToCoverage: cutoutAA, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec2 aCell;
        uniform float uNtTime; uniform float uNtTile; uniform vec3 uNtTint; uniform sampler2D uNtLawn;
        uniform sampler2D uNtLawnMask; uniform vec2 uNtLawnMin; uniform vec2 uNtLawnSize;
        varying vec3 vNtCol; varying float vNtDist;
        ${LAWN_MASK_GLSL}`,
      )
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = uv * 0.5 + aCell * 0.5;\n#endif")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec3 ntRoot = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        float ntSw = sin( uNtTime * 1.6 + dot( ntRoot.xz, vec2( 0.45, 0.31 ) ) * 2.0 );
        transformed.x += ntSw * 0.25 * position.y * position.y;
        vec3 ntC = textureLod( uNtLawn, ntRoot.xz * vec2( 1.0, -1.0 ) / uNtTile, 5.0 ).rgb * uNtTint;
        vNtCol = ntLawnTone( ntC, ntLawnM( ntRoot.xz ) );
        vNtDist = length( ntRoot - cameraPosition );`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "varying vec3 vNtCol;\nvarying float vNtDist;\nvoid main() {")
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );")
      .replace("#include <color_fragment>", "float ntL = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );\ndiffuseColor.rgb = vNtCol * ( 0.7 + 1.1 * ntL );")
      .replace("#include <alphatest_fragment>", `${MIP_ALPHA}\ndiffuseColor.a *= 1.0 - smoothstep( 20.0, 30.0, vNtDist );\n#include <alphatest_fragment>`)
      .replace("#include <aomap_fragment>", "reflectedLight.directSpecular *= 0.3;\nreflectedLight.indirectSpecular *= 0.3;\n#include <aomap_fragment>");
  };
  mat.customProgramCacheKey = () => "nt-grass-fringe";
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), S = new THREE.Vector3(), Pv = new THREE.Vector3();
  const R = rng(909);
  const Y = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const nx = n[i * 2]!, nz = n[i * 2 + 1]!;
    // root 1-3 cm inside the lawn, the card roughly along the edge, leaning OUT 25-40 deg
    Pv.set(p[i * 3]! - nx * (0.01 + R() * 0.02), p[i * 3 + 1]! - 0.006, p[i * 3 + 2]! - nz * (0.01 + R() * 0.02));
    const yaw = Math.atan2(nx, nz) + (R() - 0.5) * 0.9;
    Q.setFromAxisAngle(Y, yaw);
    ax.set(1, 0, 0).applyQuaternion(Q); // the card's own x: lean about it so the tips go outward
    Q2.setFromAxisAngle(ax, 0.45 + R() * 0.25);
    Q.premultiply(Q2);
    const w = 0.13 + R() * 0.09, h = 0.08 + R() * 0.07;
    S.set(w, h, 1);
    M.compose(Pv, Q, S);
    inst.setMatrixAt(i, M);
    cell[i * 2] = R() < 0.5 ? 0 : 1; cell[i * 2 + 1] = R() < 0.5 ? 0 : 1;
  }
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(cell, 2));
  inst.instanceMatrix.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = false;
  inst.receiveShadow = true;
  inst.name = "nt-grass-fringe";
  inst.userData.qaId = "foliage-grass-fringe";
  inst.userData.animated = true; // wind-swayed blades: FX for the flicker gate, like the tufts
  (mat as unknown as { uniforms: Record<string, unknown> }).uniforms = { uTime: uni.uNtTime };
  inst.matrixAutoUpdate = false;
  return { inst, uni };
}

// ------------------------------------------------------------------ grass tufts
const GRASS_N = 140;      // tufts per side of the camera-following grid
const GRASS_CELL = 0.17;  // m -> a 23.8 m square, 19600 tufts, 4 tris each

function grassTufts(mask: Mask, cards: TexSet | undefined, lawnMat: THREE.MeshStandardMaterial | undefined, cutoutAA: boolean, lm: LawnMaskT | null) {
  if (!cards?.c) return null;
  // two crossed cards per tuft: base at y = 0, x in [-0.5, 0.5], y in [0, 1]
  const P: number[] = [], U: number[] = [], I: number[] = [];
  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI / 2 + 0.3;
    const cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
    const b = P.length / 3;
    P.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    U.push(0, 0, 1, 0, 1, 1, 0, 1);
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(P.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(I);
  geo.instanceCount = GRASS_N * GRASS_N;
  const lu = lawnMat?.userData.ntUniforms as Record<string, { value: unknown }> | undefined;
  const tile = lawnMat?.map ? 1 / Math.abs(lawnMat.map.repeat.x) : 1.6;
  const uni = {
    uNtCam: { value: new THREE.Vector3() },
    uNtTime: { value: 0 },
    uNtMask: { value: mask.tex },
    uNtMaskMin: { value: mask.min },
    uNtMaskSize: { value: mask.size },
    uNtTile: { value: tile },
    uNtTint: lu?.uTint ?? { value: new THREE.Color(1, 1, 1) },
    uNtMacro: lu?.uMacro ?? { value: null },
    uNtMacroScale: lu?.uMacroScale ?? { value: 1 },
    uNtMacroStrength: lu?.uMacroStrength ?? { value: 0 },
    uNtMacro2: lu?.uMacro2 ?? { value: new THREE.Vector2(1, 0) },
    uNtHue: lu?.uHue ?? { value: new THREE.Vector4(1, 1, 1, 0) },
    uNtLawn: { value: lawnMat?.map ?? null },
    uNtLawnMask: { value: lm?.tex ?? null },
    uNtLawnMin: { value: lm?.min ?? new THREE.Vector2(0, 0) },
    uNtLawnSize: { value: lm?.size ?? new THREE.Vector2(1, 1) },
  };
  const mat = new THREE.MeshStandardMaterial({
    name: "nt_grass_tuft_fx",
    map: cards.c,
    roughness: 0.92,
    metalness: 0,
    alphaTest: 0.5,
    alphaToCoverage: cutoutAA,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec3 uNtCam; uniform float uNtTime; uniform sampler2D uNtMask; uniform vec2 uNtMaskMin; uniform vec2 uNtMaskSize;
        uniform float uNtTile; uniform vec3 uNtTint; uniform sampler2D uNtMacro; uniform float uNtMacroScale; uniform float uNtMacroStrength;
        uniform vec2 uNtMacro2; uniform vec4 uNtHue; uniform sampler2D uNtLawn;
        uniform sampler2D uNtLawnMask; uniform vec2 uNtLawnMin; uniform vec2 uNtLawnSize;
        ${LAWN_MASK_GLSL}
        varying vec3 vNtCol;
        float ntH( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `// toroidal grid: tuft (i, j) owns the world cell congruent to it nearest the camera
        float ntId = float( gl_InstanceID );
        vec2 ntIJ = vec2( mod( ntId, ${GRASS_N}.0 ), floor( ntId / ${GRASS_N}.0 ) );
        vec2 ntCC = floor( cameraPosition.xz / ${GRASS_CELL.toFixed(3)} );
        vec2 ntCell = ntCC + mod( ntIJ - ntCC + ${(GRASS_N / 2).toFixed(1)}, ${GRASS_N}.0 ) - ${(GRASS_N / 2).toFixed(1)};
        vec2 ntBase = ( ntCell + vec2( ntH( ntCell ), ntH( ntCell + 17.3 ) ) ) * ${GRASS_CELL.toFixed(3)};
        vec4 ntM = texture2D( uNtMask, ( ntBase - uNtMaskMin ) / uNtMaskSize );
        float ntD = length( ntBase - cameraPosition.xz );
        float ntFade = 1.0 - smoothstep( 7.0, 11.0, ntD );
        float ntEdge = ntM.g;
        vec4 ntLw = ntLawnM( ntBase );
        float ntHgt = ( 0.075 + 0.05 * ntH( ntCell + 3.1 ) ) * ( 1.0 + 1.3 * ntEdge ) * ntFade * step( 0.5, ntM.r ) * ( 1.0 - 0.5 * clamp( ntLw.r, 0.0, 1.0 ) );
        float ntWid = ntHgt * ( 1.35 + 0.4 * ntH( ntCell + 9.7 ) );
        float ntYaw = ntH( ntCell + 5.5 ) * 6.2832;
        mat2 ntR = mat2( cos( ntYaw ), sin( ntYaw ), -sin( ntYaw ), cos( ntYaw ) );
        float ntY0 = 0.1 + ntM.b * 0.3 - 0.01;
        vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );
        // the lawn's own colour at the root: tint, macro breakup, hue drift (MAT's nt_grass)
        vec2 ntUv = ntBase / uNtTile;
        // the turf's own albedo under the tuft (a coarse mip: its local average)
        vec3 ntC = textureLod( uNtLawn, ntUv, 5.0 ).rgb * uNtTint;
        float ntM1 = texture2D( uNtMacro, ntUv * uNtMacroScale ).r;
        ntC *= 1.0 + ( ntM1 - 0.5 ) * 2.0 * uNtMacroStrength;
        float ntM2 = texture2D( uNtMacro, ntUv * uNtMacro2.x + vec2( 0.37, 0.61 ) ).r;
        ntC *= 1.0 + ( ntM2 - 0.5 ) * 2.0 * uNtMacro2.y;
        ntC = mix( ntC, ntC * uNtHue.rgb, smoothstep( 0.42, 0.78, ntM2 ) * uNtHue.a );
        vNtCol = ntLawnTone( ntC, ntLw ) * ( 1.0 - 0.18 * ntEdge ) * ( 0.94 + 0.12 * ntH( ntCell + 1.9 ) );
        #ifdef USE_MAP
          // one of the atlas' four tufts (uv_vertex already ran: overwrite it)
          vMapUv = uv * 0.5 + vec2( step( 0.5, ntH( ntCell + 2.2 ) ), step( 0.5, ntH( ntCell + 4.4 ) ) ) * 0.5;
        #endif`,
      )
      .replace(
        "#include <begin_vertex>",
        `vec3 transformed;
        if ( ntHgt < 0.006 ) {
          transformed = vec3( ntBase.x, -2.0, ntBase.y ); // a collapsed tuft draws nothing
        } else {
          vec2 ntXZ = ntR * ( position.xz * ntWid );
          float ntSw = sin( uNtTime * 1.6 + dot( ntBase, vec2( 0.45, 0.31 ) ) * 2.0 ) * 0.5 + 0.5 * sin( uNtTime * 2.9 + ntBase.x * 1.7 );
          vec2 ntBend = vec2( 0.8, 0.45 ) * ntSw * 0.035 * position.y * position.y * ( 1.0 + ntEdge );
          transformed = vec3( ntBase.x + ntXZ.x + ntBend.x, ntY0 + position.y * ntHgt, ntBase.y + ntXZ.y + ntBend.y );
        }`,
      )
      .replace("#include <project_vertex>", "vec4 mvPosition = viewMatrix * vec4( transformed, 1.0 );\ngl_Position = projectionMatrix * mvPosition;")
      .replace("#include <worldpos_vertex>", "vec4 worldPosition = vec4( transformed, 1.0 );");
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "varying vec3 vNtCol;\nvoid main() {")
      // both faces of a card light like the turf under it (no flipped, dark back faces)
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize( vNormal );")
      // the tuft takes the turf's colour; the card only shapes it (mild root-to-tip ramp)
      .replace("#include <color_fragment>", "float ntL = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );\ndiffuseColor.rgb = vNtCol * ( 0.7 + 1.1 * ntL );");
  };
  mat.customProgramCacheKey = () => "nt-grass-tuft";
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = "nt-grass-tufts";
  // positions live in the vertex shader (gl_InstanceID): the flicker gate's ID
  // pass cannot see them, so the tufts are FX for QA (as wind-swayed foliage is)
  mesh.userData.qaIgnore = true;
  mesh.userData.animated = true;
  (mat as unknown as { uniforms: Record<string, unknown> }).uniforms = { uTime: uni.uNtTime };
  return { mesh, uni };
}

// ------------------------------------------------------------------ flowers, daisies, planter fillers
/** kind 0 = bed flower clump (card, palette blossoms), 1 = lawn daisy (mesh), 2 = lavender (card), 3 = boxwood filler (card). */
type Plant = { x: number; y: number; z: number; s: number; c: THREE.Color; kind: 0 | 1 | 2 | 3; h?: number };

function flowerGeometry(): THREE.BufferGeometry {
  // one clump at real size (s = 1): a leafy mound of 8 lance leaves + 4 stems
  // with an 8-petal head each; aPart 0 = leaf / stem, 1 = petal, 2 = centre
  const P: number[] = [], N: number[] = [], A: number[] = [], I: number[] = [];
  const R = rng(99);
  const add = (x: number, y: number, z: number, part: number, nx = 0, ny = 1, nz = 0) => {
    P.push(x, y, z); N.push(nx, ny, nz); A.push(part);
    return P.length / 3 - 1;
  };
  for (let l = 0; l < 8; l++) {
    const a = (l / 8) * Math.PI * 2 + R() * 0.5;
    const dx = Math.cos(a), dz = Math.sin(a);
    const len = 0.16 + R() * 0.08, up = 0.12 + R() * 0.1, w = 0.035 + R() * 0.015;
    const v0 = add(0, 0.01, 0, 0, dx * 0.3, 0.95, dz * 0.3);
    const v1 = add(dx * len * 0.5 - dz * w, up * 0.8, dz * len * 0.5 + dx * w, 0, dx * 0.3, 0.95, dz * 0.3);
    const v2 = add(dx * len, up * 0.55, dz * len, 0, dx * 0.3, 0.95, dz * 0.3);
    const v3 = add(dx * len * 0.5 + dz * w, up * 0.8, dz * len * 0.5 - dx * w, 0, dx * 0.3, 0.95, dz * 0.3);
    I.push(v0, v1, v2, v0, v2, v3);
  }
  for (let st = 0; st < 4; st++) {
    const a = (st / 4) * Math.PI * 2 + R() * 1.2;
    const r = 0.04 + R() * 0.09;
    const hx = Math.cos(a) * r, hz = Math.sin(a) * r;
    const h = 0.26 + R() * 0.2;
    const w = 0.006;
    const b0 = add(-w, 0.02, 0, 0, 0, 0.4, 1), b1 = add(w, 0.02, 0, 0, 0, 0.4, 1);
    const t1 = add(hx + w, h, hz, 0, 0, 0.4, 1), t0 = add(hx - w, h, hz, 0, 0, 0.4, 1);
    I.push(b0, b1, t1, b0, t1, t0);
    const pr = 0.045 + R() * 0.02;
    const c = add(hx, h + 0.012, hz, 2);
    const ring: number[] = [];
    for (let k = 0; k < 16; k++) {
      const pa = (k / 16) * Math.PI * 2;
      const rr = k % 2 ? pr * 0.42 : pr;
      ring.push(add(hx + Math.cos(pa) * rr, h + (k % 2 ? 0.008 : -0.006), hz + Math.sin(pa) * rr, 1));
    }
    for (let k = 0; k < 16; k++) I.push(c, ring[(k + 1) % 16]!, ring[k]!);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(A, 1));
  g.setIndex(I);
  return g;
}

function plantInstances(all: Plant[]) {
  const plants = all.filter((p) => p.kind === 1);
  if (!plants.length) return null;
  const geo = flowerGeometry();
  const mat = new THREE.MeshStandardMaterial({ name: "nt_flowers_fx", roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  const uni = { uNtTime: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aPart;\nvarying float vNtPart;\nuniform float uNtTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vNtPart = aPart;
        {
          vec3 ntO = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          float ntW = sin( uNtTime * 1.3 + ntO.x * 0.7 + ntO.z * 0.4 ) * 0.04 * position.y * position.y;
          transformed.x += ntW;
          transformed.z += ntW * 0.5;
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "varying float vNtPart;\nvoid main() {")
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize( vNormal );")
      .replace(
        "#include <color_fragment>",
        `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          vec3 ntLeaf = vec3( 0.13, 0.22, 0.07 ) * ( 0.85 + 0.3 * vColor.g );
          diffuseColor.rgb = vNtPart > 1.5 ? vec3( 0.95, 0.74, 0.12 ) : ( vNtPart > 0.5 ? vColor.rgb : ntLeaf );
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => "nt-flowers";
  const inst = new THREE.InstancedMesh(geo, mat, plants.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), Pv = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const R = rng(7);
  plants.forEach((p, i) => {
    Q.setFromAxisAngle(Y, R() * Math.PI * 2);
    S.set(p.s, p.s * (p.kind === 1 ? 0.25 : 1), p.s);
    Pv.set(p.x, p.y, p.z);
    M.compose(Pv, Q, S);
    inst.setMatrixAt(i, M);
    inst.setColorAt(i, p.c);
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = false;
  inst.receiveShadow = true;
  inst.name = "nt-flowers";
  inst.userData.qaId = "foliage-flowers";
  inst.userData.animated = true;
  (mat as unknown as { uniforms: Record<string, unknown> }).uniforms = { uTime: uni.uNtTime };
  inst.matrixAutoUpdate = false;
  return { inst, uni };
}

// ------------------------------------------------------------------ plant clump cards (r2 D6, GE04)
/**
 * Planter and bed plants are alpha-card CLUMPS (rule 7: no untextured fans or
 * paper stars): three crossed upright cards per clump, base on the soil, bent
 * normals out of the clump, a root-to-tip AO ramp, back-lit translucency,
 * alpha-to-coverage with mip-coverage alpha. Atlas = MAT's `shrub_cards` when it
 * is published (2x2: lavender, lavender, flower clump, boxwood), else this
 * procedural CC0 stand-in drawn once on a canvas (original, this repo).
 */
function clumpAtlas(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const N = 1024, H = 512;
  const cv = document.createElement("canvas");
  cv.width = N; cv.height = N;
  const c = cv.getContext("2d", { willReadFrequently: true });
  if (!c) return null;
  const R = rng(1337);
  const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  // cell c -> canvas origin; uv (0,0) is the canvas bottom-left (flipY), so cells 0/1 are the bottom row
  const org = (cell: number): [number, number] => [(cell % 2) * H, cell < 2 ? H : 0];
  const lavender = (cell: number) => {
    const [ox, oy] = org(cell);
    const base = oy + H - 6;
    // the dry grey-green mass the spikes rise out of (lower half)
    for (let i = 0; i < 520; i++) {
      const a = R() * Math.PI, r = Math.sqrt(R());
      const x = ox + H / 2 + Math.cos(a) * r * H * 0.4, y = base - Math.sin(a) * r * H * 0.48;
      c.fillStyle = hsl(78 + R() * 30, 10 + R() * 12, 30 + (1 - r) * -8 + R() * 22);
      c.save(); c.translate(x, y); c.rotate((R() - 0.5) * 1.4);
      c.beginPath(); c.ellipse(0, 0, 2.2 + R() * 1.4, 9 + R() * 6, 0, 0, Math.PI * 2); c.fill(); c.restore();
    }
    const stems = 64;
    for (let i = 0; i < stems; i++) {
      const bx = ox + H * (0.38 + 0.24 * R());
      const ang = (R() - 0.5) * 1.15 + (bx - ox - H / 2) / H * 0.6;
      const len = H * (0.62 + 0.3 * R());
      const tx = bx + Math.sin(ang) * len, ty = base - Math.cos(ang) * len;
      const cx = bx + Math.sin(ang) * len * 0.45 + (R() - 0.5) * 18, cy = base - Math.cos(ang) * len * 0.5;
      c.strokeStyle = hsl(85 + R() * 25, 14 + R() * 12, 42 + R() * 14);
      c.lineWidth = 2 + R() * 1.6;
      c.beginPath(); c.moveTo(bx, base); c.quadraticCurveTo(cx, cy, tx, ty); c.stroke();
      // a few narrow grey-green leaves low on the stem
      for (let k = 0; k < 3; k++) {
        const t = 0.08 + R() * 0.35;
        const lx = bx + (tx - bx) * t, ly = base + (ty - base) * t;
        c.fillStyle = hsl(90 + R() * 30, 12 + R() * 10, 45 + R() * 15);
        c.save(); c.translate(lx, ly); c.rotate(ang + (R() < 0.5 ? -0.7 : 0.7));
        c.beginPath(); c.ellipse(0, -12, 2.6, 13, 0, 0, Math.PI * 2); c.fill(); c.restore();
      }
      // a dusty purple spike on most stems: stacked whorls over the top 15 %
      if (R() < 0.35) continue;
      const n = 6 + Math.floor(R() * 4);
      for (let k = 0; k < n; k++) {
        const t = 1 - (k / n) * 0.15;
        const sx = bx + (tx - bx) * t + (R() - 0.5) * 3, sy = base + (ty - base) * t;
        const l = 48 + R() * 16 - k * 0.8;
        c.fillStyle = hsl(266 + R() * 16, 16 + R() * 16, l);
        c.beginPath(); c.ellipse(sx - 3, sy, 4 + R() * 1.5, 5.5 + R() * 2, ang - 0.4, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.ellipse(sx + 3, sy, 4 + R() * 1.5, 5.5 + R() * 2, ang + 0.4, 0, Math.PI * 2); c.fill();
      }
    }
  };
  const flowers = (cell: number) => {
    const [ox, oy] = org(cell);
    const base = oy + H - 6;
    for (let i = 0; i < 46; i++) {
      // lance leaves fanning from the base
      const ang = (R() - 0.5) * 2.2;
      const len = H * (0.25 + 0.25 * R());
      c.fillStyle = hsl(95 + R() * 25, 35 + R() * 20, 24 + R() * 16);
      c.save(); c.translate(ox + H * (0.4 + 0.2 * R()), base); c.rotate(ang);
      c.beginPath(); c.ellipse(0, -len / 2, 6 + R() * 5, len / 2, 0, 0, Math.PI * 2); c.fill(); c.restore();
    }
    for (let i = 0; i < 13; i++) {
      // stems with a 5-petal blossom: petals NEUTRAL white (the shader tints them per instance)
      const bx = ox + H * (0.3 + 0.4 * R());
      const ang = (R() - 0.5) * 0.9;
      const len = H * (0.45 + 0.4 * R());
      const tx = bx + Math.sin(ang) * len, ty = base - Math.cos(ang) * len;
      c.strokeStyle = hsl(100, 35, 28); c.lineWidth = 3;
      c.beginPath(); c.moveTo(bx, base); c.lineTo(tx, ty); c.stroke();
      const pr = 13 + R() * 8;
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + R();
        const g = 228 + Math.floor(R() * 24);
        c.fillStyle = `rgb(${g},${g},${g - 6})`;
        c.beginPath(); c.ellipse(tx + Math.cos(a) * pr * 0.55, ty + Math.sin(a) * pr * 0.4, pr * 0.5, pr * 0.3, a, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = hsl(44, 80, 52);
      c.beginPath(); c.arc(tx, ty, pr * 0.24, 0, Math.PI * 2); c.fill();
    }
  };
  const boxwood = (cell: number) => {
    const [ox, oy] = org(cell);
    const base = oy + H - 4;
    for (let i = 0; i < 900; i++) {
      // a dome of small oval leaves, darker inside / below
      const a = R() * Math.PI, r = Math.sqrt(R());
      const x = ox + H / 2 + Math.cos(a) * r * H * 0.46, y = base - Math.sin(a) * r * H * 0.78;
      const depth = 1 - r;
      c.fillStyle = hsl(88 + R() * 22, 30 + R() * 18, 20 + (1 - depth) * 22 + R() * 10);
      c.save(); c.translate(x, y); c.rotate(R() * Math.PI);
      c.beginPath(); c.ellipse(0, 0, 4 + R() * 3, 7 + R() * 4, 0, 0, Math.PI * 2); c.fill(); c.restore();
    }
  };
  lavender(0); lavender(1); flowers(2); boxwood(3);
  // colour bled under the alpha so the mips never fringe dark
  const img = c.getImageData(0, 0, N, N), d = img.data;
  const col = new Float32Array(N * N * 3), w = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) if (d[i * 4 + 3]! > 8) { col[i * 3] = d[i * 4]!; col[i * 3 + 1] = d[i * 4 + 1]!; col[i * 3 + 2] = d[i * 4 + 2]!; w[i] = 1; }
  for (let pass = 0; pass < 6; pass++) {
    const nw = w.slice(), nc = col.slice();
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      if (w[i]) continue;
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (const j of [i - 1, i + 1, i - N, i + N]) if (w[j]) { sr += col[j * 3]!; sg += col[j * 3 + 1]!; sb += col[j * 3 + 2]!; sw++; }
      if (sw) { nc[i * 3] = sr / sw; nc[i * 3 + 1] = sg / sw; nc[i * 3 + 2] = sb / sw; nw[i] = 1; }
    }
    w.set(nw); col.set(nc);
  }
  for (let i = 0; i < N * N; i++) if (d[i * 4 + 3]! <= 8 && w[i]) { d[i * 4] = col[i * 3]!; d[i * 4 + 1] = col[i * 3 + 1]!; d[i * 4 + 2] = col[i * 3 + 2]!; d[i * 4 + 3] = 0; }
  c.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function clumpGeometry(): THREE.BufferGeometry {
  // three crossed upright cards (60 deg apart), x in [-0.5, 0.5], y in [0, 1];
  // normals bent out of the clump (soft volume shading, no flat card faces)
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  for (let q = 0; q < 3; q++) {
    const a = (q * Math.PI) / 3 + 0.2, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
    const b = P.length / 3;
    const corners: [number, number, number, number, number][] = [[-cx, 0, -cz, 0, 0], [cx, 0, cz, 1, 0], [cx, 1, cz, 1, 1], [-cx, 1, -cz, 0, 1]];
    for (const [x, y, z, u, v] of corners) {
      P.push(x, y, z);
      const n = new THREE.Vector3(x * 1.6, 0.35 + y * 0.9, z * 1.6).normalize();
      N.push(n.x, n.y, n.z);
      U.push(u, v);
    }
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  return g;
}

/** Atlas cell (uv cell x, y; v up) of a plant kind; `mat` = MAT's shrub_cards (boxwood at (0,0), lavender elsewhere). */
type CellFn = (kind: Plant["kind"], r: number) => [number, number];
const CELL_PROC: CellFn = (k, r) => (k === 2 ? [r < 0.5 ? 0 : 1, 0] : k === 0 ? [0, 1] : [1, 1]);
const CELL_MAT: CellFn = (k, r) => (k === 3 ? [0, 0] : r < 0.34 ? [1, 0] : r < 0.67 ? [0, 1] : [1, 1]);

function clumpInstances(plants: Plant[], map: THREE.Texture, cutoutAA: boolean, sun: { dir: THREE.Vector3; col: THREE.Color }, cellOf: CellFn = CELL_PROC, name = "nt-plant-clumps") {
  const list = plants.filter((p) => p.kind !== 1);
  if (!list.length) return null;
  const geo = clumpGeometry();
  const cell = new Float32Array(list.length * 2), tintMode = new Float32Array(list.length);
  const mat = new THREE.MeshStandardMaterial({ name: "nt_plant_clump_fx", map, roughness: 0.85, metalness: 0, alphaTest: 0.42, alphaToCoverage: cutoutAA, side: THREE.DoubleSide });
  const uni = { uNtTime: { value: 0 }, uNtSunDir: { value: sun.dir }, uNtSunCol: { value: sun.col } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aCell;\nattribute float aTint;\nvarying float vNtTint;\nvarying float vNtH;\nuniform float uNtTime;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = uv * 0.5 + aCell * 0.5;\n#endif\nvNtTint = aTint;\nvNtH = uv.y;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          vec3 ntO = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          float ntW = sin( uNtTime * 1.4 + ntO.x * 0.9 + ntO.z * 0.6 ) * 0.035 * position.y * position.y;
          transformed.x += ntW;
          transformed.z += ntW * 0.6;
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "varying float vNtTint;\nvarying float vNtH;\nuniform vec3 uNtSunDir;\nuniform vec3 uNtSunCol;\nvoid main() {")
      .replace(
        "#include <color_fragment>",
        `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          // blossoms (bright, near-neutral texels) take the instance colour; leaves keep the atlas green
          float ntMx = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) ), ntMn = min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) );
          float ntPet = vNtTint * smoothstep( 0.45, 0.7, ntMx ) * ( 1.0 - smoothstep( 0.08, 0.2, ntMx - ntMn ) );
          diffuseColor.rgb = mix( diffuseColor.rgb * mix( vec3( 1.0 ), vColor, 1.0 - vNtTint ), diffuseColor.rgb * vColor * 1.15, ntPet );
        #endif
        // root-to-tip AO: the base of a clump sits in its own shade
        diffuseColor.rgb *= mix( 0.45, 1.0, smoothstep( 0.0, 0.45, vNtH ) );`,
      )
      .replace("#include <alphatest_fragment>", `${MIP_ALPHA}\n#include <alphatest_fragment>`)
      .replace("#include <aomap_fragment>", "reflectedLight.directSpecular *= 0.3;\nreflectedLight.indirectSpecular *= 0.3;\n#include <aomap_fragment>")
      .replace(
        "#include <opaque_fragment>",
        `{
          vec3 ntLv = normalize( ( viewMatrix * vec4( uNtSunDir, 0.0 ) ).xyz );
          float ntBack = pow( clamp( dot( normalize( vViewPosition ), -ntLv ), 0.0, 1.0 ), 3.0 );
          outgoingLight += diffuseColor.rgb * uNtSunCol * ntBack * 0.35 * smoothstep( 0.2, 0.9, vNtH );
        }
        #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => "nt-plant-clump";
  const inst = new THREE.InstancedMesh(geo, mat, list.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), Pv = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const R = rng(77);
  list.forEach((p, i) => {
    Q.setFromAxisAngle(Y, R() * Math.PI * 2);
    const h = p.h ?? p.s;
    S.set(p.s, h, p.s);
    Pv.set(p.x, p.y - 0.02, p.z);
    M.compose(Pv, Q, S);
    inst.setMatrixAt(i, M);
    inst.setColorAt(i, p.c);
    const [cx, cy] = cellOf(p.kind, R());
    cell[i * 2] = cx; cell[i * 2 + 1] = cy;
    tintMode[i] = p.kind === 0 ? 1 : 0;
  });
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(cell, 2));
  geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tintMode, 1));
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.castShadow = false;
  inst.receiveShadow = true;
  inst.name = name;
  inst.userData.qaId = `foliage-${name.slice(3)}`;
  inst.userData.animated = true;
  (mat as unknown as { uniforms: Record<string, unknown> }).uniforms = { uTime: uni.uNtTime };
  inst.matrixAutoUpdate = false;
  return { inst, uni };
}

function blocked(x: number, z: number, solids: OBB[], pad: number): boolean {
  for (const o of solids) {
    const v = (o as OBB & { visual?: string }).visual;
    if (v === "lawn" || v === "boundary") continue;
    if (o.y - o.sy / 2 > 0.6 || o.y + o.sy / 2 < 0.25) continue;
    const dx = x - o.x, dz = z - o.z;
    if (Math.abs(dx) > o.sx + o.sz + pad && Math.abs(dz) > o.sx + o.sz + pad) continue;
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    if (Math.abs(lx) <= o.sx / 2 + pad && Math.abs(lz) <= o.sz / 2 + pad) return true;
  }
  return false;
}

function scatterPlants(stamp: Stamp | null, map: THREE.Object3D, lawnTris: Float32Array[], solids: OBB[]): Plant[] {
  const out: Plant[] = [];
  const R = rng(2024);
  // beds: clumps on a jittered 0.3 m lattice, palette colours, a few bare spots
  for (const bed of stamp?.beds ?? []) {
    const xs = bed.poly.map((p) => p[0]), zs = bed.poly.map((p) => p[1]);
    const step = bed.sparse ? 0.42 : 0.3;
    const pal = bed.flowers.map((h) => new THREE.Color(h));
    for (let x = Math.min(...xs); x < Math.max(...xs); x += step) {
      for (let z = Math.min(...zs); z < Math.max(...zs); z += step) {
        const px = x + (R() - 0.5) * step * 0.8, pz = z + (R() - 0.5) * step * 0.8;
        if (!inPoly(px, pz, bed.poly) || R() < 0.12) continue;
        if (blocked(px, pz, solids, 0.12)) continue;
        // drifts of one colour (gardeners plant in groups)
        const k = Math.floor(((Math.sin(px * 0.9) + Math.cos(pz * 1.1)) * 0.25 + 0.5) * pal.length + R() * 1.4) % Math.max(1, pal.length);
        const sz = (bed.sparse ? 0.34 : 0.4) + R() * 0.16;
        out.push({ x: px, y: bed.y, z: pz, s: sz, h: sz * (1.05 + R() * 0.4), c: pal[k] ?? new THREE.Color(1, 1, 1), kind: 0 });
      }
    }
  }
  // planter tops (soil / mulch faces above the lawn): leafy fillers + a few blooms
  const tops: number[] = [];
  map.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!matsOf(m).some((x) => x.name === "nt_soil_bed" || x.name === "nt_mulch")) return;
    const T = triangles(m);
    for (let i = 0; i + 8 < T.length; i += 9) {
      const y = (T[i + 1]! + T[i + 4]! + T[i + 7]!) / 3;
      if (y < 0.35 || Math.abs(T[i + 1]! - T[i + 4]!) > 0.02 || Math.abs(T[i + 1]! - T[i + 7]!) > 0.02) continue;
      tops.push(...T.slice(i, i + 9));
    }
  });
  for (let i = 0; i + 8 < tops.length; i += 9) {
    const ax = tops[i]!, az = tops[i + 2]!, bx = tops[i + 3]!, bz = tops[i + 5]!, cx = tops[i + 6]!, cz = tops[i + 8]!;
    const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    // r2 D6 (GE04, BO1 bo1-materials-greenhouse-siding-stone-crop-01): dusty
    // grey-green lavender with purple spikes, a few boxwood fillers, ~9 clumps/m2
    const n = Math.round(area * 11 + R());
    for (let k = 0; k < n; k++) {
      let u = R(), v = R();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const px = ax + (bx - ax) * u + (cx - ax) * v, pz = az + (bz - az) * u + (cz - az) * v;
      const box = R() < 0.15;
      const sz = box ? 0.42 + R() * 0.14 : 0.56 + R() * 0.2;
      const g = 0.86 + R() * 0.18;
      out.push({ x: px, y: tops[i + 1]!, z: pz, s: sz, h: box ? sz * 0.85 : sz * (0.95 + R() * 0.35), c: new THREE.Color(g, g, g), kind: box ? 3 : 2 });
    }
  }
  // white daisies over the open lawn (sparse, low)
  for (const T of lawnTris) for (let i = 0; i + 8 < T.length; i += 9) {
    const ax = T[i]!, az = T[i + 2]!, bx = T[i + 3]!, bz = T[i + 5]!, cx = T[i + 6]!, cz = T[i + 8]!;
    const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    const n = Math.floor(area * 0.12 + R());
    for (let k = 0; k < n; k++) {
      let u = R(), v = R();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const px = ax + (bx - ax) * u + (cx - ax) * v, pz = az + (bz - az) * u + (cz - az) * v;
      if (blocked(px, pz, solids, 0.25)) continue;
      out.push({ x: px, y: (T[i + 1]! + T[i + 4]! + T[i + 7]!) / 3, z: pz, s: 0.32 + R() * 0.08, c: new THREE.Color(0.93, 0.92, 0.86), kind: 1 });
    }
  }
  return out;
}

// ------------------------------------------------------------------ entry
export async function buildNuketownFoliage(ctx: FoliageCtx): Promise<Foliage | null> {
  const { map, soft, sets } = ctx;
  wireVertexColours(map);
  const cutoutAA = aaSamples(ctx.renderer) > 0;
  // the tar strips need their line shader on every tier (else they draw as 12 cm bands)
  tarLines(map, cutoutAA && !soft);
  if (soft) return null; // software GL: the build's geometry, nothing more
  // QA A/B switch (perf): ?nofoliage keeps only the build's geometry + tar lines
  if (typeof location !== "undefined" && /[?&]nofoliage\b/.test(location.search)) return null;
  fenceFill(map);
  let solids = activeSolids();
  if (solids.length < 200) {
    // the sim map is normally active before the world builds; fetch it if not
    const j = await fetch(ctx.asset("../maps/nuketown.json")).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (j?.solids) solids = j.solids as OBB[];
  }
  // the sun the rig lit the map with (colour x intensity, read every frame)
  let sunLight: THREE.DirectionalLight | null = null;
  ctx.scene.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight && !sunLight) sunLight = o as THREE.DirectionalLight; });
  const sun = { dir: NUKETOWN_SUN_DIR.clone(), col: new THREE.Color(1, 1, 1) };

  // ---------------------------------------------------------- hedges
  const hedgeMeshes = meshesUnder(map.getObjectByName("hedges"));
  for (const m of hedgeMeshes) for (const mat of matsOf(m)) if (mat.name === "nt_hedge" && mat.map) patchHedge(mat, sun);
  let cardRec: Cards | null = null;
  try {
    const raw = map.getObjectByName("hedges")?.userData?.ntCards;
    cardRec = typeof raw === "string" ? decodeCards(JSON.parse(raw) as CardRec) : null;
  } catch {
    cardRec = null;
  }
  cardRec ??= sampledHedgeCards(hedgeMeshes);
  const hedgeSet = sets.get("hedge_cards");
  if (cardRec && hedgeSet?.c) {
    // the card shell IS the hedge silhouette (rule 7): it stays on to ~60 m
    const mat = cardMaterial("nt_hedge_card_fx", hedgeSet.c, cutoutAA, 0.45, sun, new THREE.Vector2(45, 70), 0.3);
    const inst = cardInstances(cardRec, 0, mat, "nt-hedge-cards", "foliage-hedge-cards");
    if (inst) ctx.root.add(inst);
  }

  // ---------------------------------------------------------- grass
  const terrain = meshesUnder(map.getObjectByName("terrain"));
  const lawnMesh = terrain.find((m) => matsOf(m).some((x) => x.name === "nt_grass"));
  const lawnMat = lawnMesh ? matsOf(lawnMesh).find((x) => x.name === "nt_grass") : undefined;
  const covers = [...terrain, ...meshesUnder(map.getObjectByName("houses")), ...meshesUnder(map.getObjectByName("structures"))];
  let stamp: Stamp | null = null;
  const tn = map.getObjectByName("terrain");
  try {
    const raw = tn?.userData?.ntFoliage;
    stamp = typeof raw === "string" ? (JSON.parse(raw) as Stamp) : null;
  } catch {
    stamp = null;
  }
  const mask = await grassMask(terrain, covers, solids);
  // r2 D5: worn spawn-lane tracks + damp fence / deck strips, read by the lawn and the tufts
  const lm = mask ? lawnMask(stamp, solids, mask) : null;
  if (lm) for (const m of terrain) for (const mat of matsOf(m)) if (mat.name === "nt_grass" && mat instanceof THREE.MeshStandardMaterial) patchLawn(mat, lm);
  const grass = mask ? grassTufts(mask, sets.get("grass_cards"), lawnMat, cutoutAA, lm) : null;
  if (grass) ctx.root.add(grass.mesh);
  // grass spilling over every lawn border: the map's lawns and PROPS' street-out lawns
  const lawnMeshes = terrain.filter((m) => matsOf(m).some((x) => x.name === "nt_grass"));
  const outLawns: THREE.Mesh[] = [];
  ctx.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || lawnMeshes.includes(m)) return;
    let p: THREE.Object3D | null = m;
    while (p && p !== map) p = p.parent;
    if (p === map) return;
    if (matsOf(m).some((x) => x?.name === "nt_grass")) outLawns.push(m);
  });
  const fringe = fringeInstances([...lawnMeshes, ...outLawns], sets.get("grass_cards"), lawnMat, lm, cutoutAA);
  if (fringe) ctx.root.add(fringe.inst);

  // ---------------------------------------------------------- flowers
  const lawnTris = lawnMeshes.map(triangles);
  const plantList = scatterPlants(stamp, map, lawnTris, solids);
  const plants = plantInstances(plantList);
  if (plants) ctx.root.add(plants.inst);
  // planters: MAT's shrub_cards (lavender x3 + boxwood) when published; bed flowers: the procedural atlas
  const shrubSet = sets.get("shrub_cards");
  const proc = clumpAtlas();
  const planterKinds = plantList.filter((p) => p.kind === 2 || p.kind === 3);
  const clumps = shrubSet?.c
    ? clumpInstances(planterKinds, shrubSet.c, cutoutAA, sun, CELL_MAT, "nt-plant-clumps")
    : proc ? clumpInstances(planterKinds, proc, cutoutAA, sun, CELL_PROC, "nt-plant-clumps") : null;
  const flowers = proc ? clumpInstances(plantList.filter((p) => p.kind === 0), proc, cutoutAA, sun, CELL_PROC, "nt-bed-flowers") : null;
  if (clumps) ctx.root.add(clumps.inst);
  if (flowers) ctx.root.add(flowers.inst);

  let t = 0;
  return {
    update: (dt, cam) => {
      t += dt;
      const sl = sunLight as THREE.DirectionalLight | null;
      if (sl) sun.col.copy(sl.color).multiplyScalar(sl.intensity);
      if (grass) {
        grass.uni.uNtTime.value = t;
        grass.uni.uNtCam.value.copy(cam.getWorldPosition(new THREE.Vector3()));
      }
      if (plants) plants.uni.uNtTime.value = t;
      if (clumps) clumps.uni.uNtTime.value = t;
      if (flowers) flowers.uni.uNtTime.value = t;
      if (fringe) fringe.uni.uNtTime.value = t;
    },
  };
}
