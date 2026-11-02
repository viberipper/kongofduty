import * as THREE from "three";
import { assetUrl } from "./asset-base";
import { specularAA } from "./specular-aa";

const A = (p: string) => assetUrl(`/assets/katana/${p}`);

export type KatanaSetName = "cedar" | "deck" | "soffit" | "wet_slate" | "gravel" | "stone" | "roof" | "moss";

export type KatanaSetInfo = {
  tile_m: number;
  files: Record<string, string>;
};

export type KatanaManifest = Record<string, KatanaSetInfo>;

export type KatanaTextureSet = {
  info: KatanaSetInfo;
  c?: THREE.Texture;
  n?: THREE.Texture;
  orm?: THREE.Texture;
};

export type KatanaSpec = {
  set?: KatanaSetName;
  color?: number;
  gain?: number;
  tile?: number;
  roughness?: number;
  metalness?: number;
  normal?: number;
  env?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  puddle?: boolean;
  water?: boolean;
  wet?: boolean;
  wood?: boolean;
  paper?: "shoji" | "lantern";
  lantern?: boolean;
  doubleSided?: boolean;
  alphaTest?: number;
};

const C = (hex: string) => parseInt(hex.slice(1), 16);

export const KATANA_SPECS: Record<string, KatanaSpec> = {
  kt_default: { set: "stone", color: C("#aab2bd"), env: 0.65, wet: true },
  kt_cedar: { set: "cedar", color: C("#cbd2da"), normal: 0.42, env: 0.85, clearcoat: 0.2, clearcoatRoughness: 0.32, wood: true, wet: true },
  kt_dark_cedar: { set: "cedar", color: C("#aeb8c2"), normal: 0.44, env: 0.65, clearcoat: 0.16, clearcoatRoughness: 0.36, wood: true, wet: true },
  kt_yakisugi: { set: "cedar", color: C("#c2cbd5"), normal: 0.46, env: 0.75, clearcoat: 0.18, clearcoatRoughness: 0.36, wood: true, wet: true },
  kt_wood: { set: "cedar", color: C("#cbd2da"), normal: 0.42, env: 0.75, clearcoat: 0.18, clearcoatRoughness: 0.36, wood: true, wet: true },
  kt_deck: { set: "deck", color: C("#cbd2da"), normal: 0.44, env: 0.9, clearcoat: 0.34, clearcoatRoughness: 0.28, wet: true },
  kt_soffit: { set: "soffit", color: C("#c0c6ce"), normal: 0.3, env: 0.45, roughness: 1 },
  kt_slate: { set: "wet_slate", color: C("#d9e1ec"), normal: 0.38, env: 1.05, clearcoat: 0.52, clearcoatRoughness: 0.25, puddle: true, wet: true },
  kt_wet_slate: { set: "wet_slate", color: C("#d9e1ec"), normal: 0.38, env: 1.05, clearcoat: 0.52, clearcoatRoughness: 0.25, puddle: true, wet: true },
  kt_gravel: { set: "gravel", color: C("#cbd3dc"), gain: 0.82, normal: 0.3, env: 0.35, roughness: 1 },
  kt_stone: { set: "stone", color: C("#d4dce6"), normal: 0.46, env: 0.7, clearcoat: 0.12, clearcoatRoughness: 0.4, wet: true },
  kt_granite: { set: "stone", color: C("#d4dce6"), normal: 0.46, env: 0.7, clearcoat: 0.12, clearcoatRoughness: 0.4, wet: true },
  kt_stone_graphite: { set: "stone", color: C("#98a3af"), normal: 0.46, env: 0.65, clearcoat: 0.12, clearcoatRoughness: 0.4, wet: true },
  kt_stone_dark: { set: "stone", color: C("#98a3af"), normal: 0.46, env: 0.65, clearcoat: 0.12, clearcoatRoughness: 0.4, wet: true },
  kt_stone_pale: { set: "stone", color: C("#ffffff"), gain: 1.65, normal: 0.3, env: 0.55, clearcoat: 0.08, clearcoatRoughness: 0.44 },
  kt_roof: { set: "roof", color: C("#d5ddea"), normal: 0.34, env: 1.05, clearcoat: 0.5, clearcoatRoughness: 0.24, wet: true },
  kt_roof_tile: { set: "roof", color: C("#d5ddea"), normal: 0.34, env: 1.05, clearcoat: 0.5, clearcoatRoughness: 0.24, wet: true },
  kt_moss: { set: "moss", color: C("#c4d0bd"), normal: 0.5, env: 0.25, roughness: 1 },
  kt_earth: { set: "stone", color: C("#666a70"), normal: 0.25, env: 0.3, roughness: 1 },
  kt_plaster: { set: "stone", color: C("#a7abb1"), normal: 0.2, env: 0.35, roughness: 1 },
  kt_lacquer: { color: C("#e8141f"), roughness: 0.3, metalness: 0.04, env: 1.05, clearcoat: 0.62, clearcoatRoughness: 0.22, wet: true },
  kt_lacquer_blade_red: { color: C("#e8141f"), roughness: 0.3, metalness: 0.04, env: 1.05, clearcoat: 0.62, clearcoatRoughness: 0.22, wet: true },
  kt_lacquer_deep_red: { color: C("#781018"), roughness: 0.38, metalness: 0.1, env: 0.65, clearcoat: 0.4, clearcoatRoughness: 0.3, wet: true },
  kt_blade_reflection: { color: C("#6d1119"), emissive: C("#e8141f"), emissiveIntensity: 0.18, roughness: 0.36, metalness: 0.75, env: 0.85 },
  kt_lantern: { color: C("#9f2028"), emissive: C("#ff3340"), emissiveIntensity: 0.85, roughness: 0.72, env: 0.2, paper: "lantern", lantern: true },
  kt_lantern_paper: { color: C("#9f2028"), emissive: C("#ff3340"), emissiveIntensity: 0.85, roughness: 0.72, env: 0.2, paper: "lantern", lantern: true },
  kt_paper_red_glow: { color: C("#9f2028"), emissive: C("#ff3340"), emissiveIntensity: 0.85, roughness: 0.72, env: 0.2, paper: "lantern", lantern: true, doubleSided: true },
  kt_shoji: { color: C("#8b98a5"), emissive: C("#b9cadb"), emissiveIntensity: 0.1, roughness: 0.94, env: 0.12, paper: "shoji", doubleSided: true },
  kt_paper: { color: C("#8a96a1"), emissive: C("#b9cadb"), emissiveIntensity: 0.05, roughness: 0.96, env: 0.1, paper: "shoji", doubleSided: true },
  kt_cloth_red: { color: C("#a7131d"), roughness: 0.94, env: 0.18, doubleSided: true },
  kt_cloth: { color: C("#171c1e"), roughness: 0.95, env: 0.15, doubleSided: true },
  kt_maple: { color: C("#a7131d"), roughness: 0.9, env: 0.2, doubleSided: true },
  kt_foliage_maple_shadow: { color: C("#5d1018"), roughness: 0.92, env: 0.16, doubleSided: true },
  kt_water: { color: C("#0e1a24"), roughness: 0.3, metalness: 0.08, env: 1.25, clearcoat: 0.42, clearcoatRoughness: 0.26, water: true },
  kt_steel: { color: C("#aeb9c7"), roughness: 0.36, metalness: 0.88, env: 1.1 },
  kt_metal: { color: C("#303844"), roughness: 0.48, metalness: 0.72, env: 0.8 },
  kt_bronze: { color: C("#354640"), roughness: 0.46, metalness: 0.78, env: 0.8 },
  kt_cord: { color: C("#0b0f11"), roughness: 0.92, env: 0.2 },
  kt_underwrap: { color: C("#d4d9df"), roughness: 0.8, env: 0.35 },
  kt_rope: { color: C("#777b76"), roughness: 0.95, env: 0.2 },
  kt_straw: { color: C("#92968b"), roughness: 0.93, env: 0.25 },
  kt_koi: { color: C("#d8dfe4"), roughness: 0.42, env: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.32 },
  kt_koi_red: { color: C("#e8141f"), roughness: 0.42, env: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.32 },
  kt_eye: { color: C("#050809"), roughness: 0.32, env: 0.45 },
  kt_bamboo: { set: "cedar", color: C("#647066"), normal: 0.25, env: 0.5, clearcoat: 0.18, clearcoatRoughness: 0.4 },
  kt_foliage: { set: "moss", color: C("#7d8f7b"), normal: 0.25, env: 0.25, roughness: 1, doubleSided: true },
};

const KATANA_TIME = { value: 0 };

export function setKatanaTime(seconds: number): void {
  KATANA_TIME.value = seconds;
}

export function katanaSpec(rawName: string): KatanaSpec {
  const direct = KATANA_SPECS[rawName];
  if (direct) return direct;
  const n = rawName.toLowerCase();
  if (/paper.*(?:red|glow)|lantern|chochin/.test(n)) return KATANA_SPECS.kt_lantern!;
  if (/maple/.test(n)) return KATANA_SPECS.kt_maple!;
  if (/cloth|noren|banner/.test(n)) return KATANA_SPECS[/red|lacquer/.test(n) ? "kt_cloth_red" : "kt_cloth"]!;
  if (/koi|kohaku/.test(n)) return KATANA_SPECS[/red|kohaku/.test(n) ? "kt_koi_red" : "kt_koi"]!;
  if (/underwrap/.test(n)) return KATANA_SPECS.kt_underwrap!;
  if (/tsuka|cord/.test(n)) return KATANA_SPECS.kt_cord!;
  if (/rope/.test(n)) return KATANA_SPECS.kt_rope!;
  if (/straw/.test(n)) return KATANA_SPECS.kt_straw!;
  if (/eye|obsidian/.test(n)) return KATANA_SPECS.kt_eye!;
  if (/blade.*red/.test(n)) return KATANA_SPECS.kt_blade_reflection!;
  if (/bell|bronze/.test(n)) return KATANA_SPECS.kt_bronze!;
  if (/water|moat|river_water|cascade/.test(n)) return KATANA_SPECS.kt_water!;
  if (/lacquer|urushi|torii|red/.test(n)) return KATANA_SPECS.kt_lacquer!;
  if (/shoji/.test(n)) return KATANA_SPECS.kt_shoji!;
  if (/paper/.test(n)) return KATANA_SPECS.kt_paper!;
  if (/roof|kawara|tile/.test(n)) return KATANA_SPECS.kt_roof!;
  if (/gravel|shirakawa|raked/.test(n)) return KATANA_SPECS.kt_gravel!;
  if (/slate|paving|flagstone/.test(n)) return KATANA_SPECS.kt_slate!;
  if (/moss/.test(n)) return KATANA_SPECS.kt_moss!;
  if (/bamboo/.test(n)) return KATANA_SPECS.kt_bamboo!;
  if (/leaf|foliage|pine/.test(n)) return KATANA_SPECS.kt_foliage!;
  if (/cedar|yakisugi|wood|timber|deck|lattice/.test(n)) return KATANA_SPECS.kt_cedar!;
  if (/steel|blade/.test(n)) return KATANA_SPECS.kt_steel!;
  if (/metal|iron/.test(n)) return KATANA_SPECS.kt_metal!;
  if (/plaster|earth|tsuijibei/.test(n)) return KATANA_SPECS.kt_earth!;
  if (/stone|rock|granite/.test(n)) return KATANA_SPECS.kt_stone!;
  return KATANA_SPECS.kt_default!;
}

export async function loadKatanaSets(renderer: THREE.WebGLRenderer, low: boolean): Promise<Map<string, KatanaTextureSet>> {
  const out = new Map<string, KatanaTextureSet>();
  const manifest = await fetch(A("tex/manifest.json"))
    .then((r) => (r.ok ? r.json() as Promise<KatanaManifest> : null))
    .catch(() => null);
  if (!manifest) return out;

  const loader = new THREE.TextureLoader();
  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), low ? 4 : 8);
  const jobs: Promise<void>[] = [];
  for (const spec of Object.values(KATANA_SPECS)) {
    if (!spec.set || out.has(spec.set)) continue;
    const info = manifest[spec.set];
    if (!info) continue;
    const set: KatanaTextureSet = { info };
    out.set(spec.set, set);
    const load = (kind: "c" | "n" | "orm") => {
      const file = info.files[low ? `${kind}-low` : kind] ?? info.files[kind];
      if (!file) return;
      jobs.push(loader.loadAsync(A(`tex/${file}`)).then((texture) => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = anisotropy;
        texture.flipY = false;
        if (kind === "c") texture.colorSpace = THREE.SRGBColorSpace;
        set[kind] = texture;
      }).catch(() => undefined));
    };
    load("c");
    load("n");
    load("orm");
  }
  await Promise.all(jobs);
  return out;
}

function patchWood(material: THREE.MeshStandardMaterial, spec: KatanaSpec, sets: Map<string, KatanaTextureSet>): void {
  if (!spec.wood) return;
  const deck = sets.get("deck");
  const soffit = sets.get("soffit");
  if (!deck?.c || !deck.n || !deck.orm || !soffit?.c || !soffit.n || !soffit.orm) return;
  const prep = (texture: THREE.Texture) => {
    const clone = texture.clone();
    clone.repeat.setScalar(1 / 2.4);
    clone.needsUpdate = true;
    return clone;
  };
  const uniforms = {
    uKtDeckC: { value: prep(deck.c) },
    uKtDeckN: { value: prep(deck.n) },
    uKtDeckO: { value: prep(deck.orm) },
    uKtSoffitC: { value: prep(soffit.c) },
    uKtSoffitN: { value: prep(soffit.n) },
    uKtSoffitO: { value: prep(soffit.orm) },
  };
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vKtWoodNormalY;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec3 ktWoodNormal = objectNormal;
        #ifdef USE_INSTANCING
          ktWoodNormal = mat3( instanceMatrix ) * ktWoodNormal;
        #endif
        vKtWoodNormalY = normalize( mat3( modelMatrix ) * ktWoodNormal ).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying float vKtWoodNormalY;
        uniform sampler2D uKtDeckC, uKtDeckN, uKtDeckO, uKtSoffitC, uKtSoffitN, uKtSoffitO;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        float ktDeckWeight = smoothstep( 0.52, 0.82, vKtWoodNormalY );
        float ktSoffitWeight = smoothstep( 0.52, 0.82, -vKtWoodNormalY );
        #ifdef USE_MAP
          vec3 ktWoodBase = texture2D( map, vMapUv ).rgb;
          vec3 ktWoodSurface = ktWoodBase;
          if ( ktDeckWeight > 0.001 ) ktWoodSurface = mix( ktWoodSurface, texture2D( uKtDeckC, vMapUv ).rgb, ktDeckWeight );
          if ( ktSoffitWeight > 0.001 ) ktWoodSurface = mix( ktWoodSurface, texture2D( uKtSoffitC, vMapUv ).rgb, ktSoffitWeight );
          if ( ktDeckWeight + ktSoffitWeight > 0.001 ) diffuseColor.rgb *= ktWoodSurface / max( ktWoodBase, vec3( 0.001 ) );
        #endif`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        #if defined( USE_ROUGHNESSMAP ) && defined( USE_MAP )
          if ( ktDeckWeight + ktSoffitWeight > 0.001 ) {
            float ktWoodRoughness = texture2D( roughnessMap, vRoughnessMapUv ).g;
            if ( ktDeckWeight > 0.001 ) ktWoodRoughness = mix( ktWoodRoughness, texture2D( uKtDeckO, vMapUv ).g, ktDeckWeight );
            if ( ktSoffitWeight > 0.001 ) ktWoodRoughness = mix( ktWoodRoughness, texture2D( uKtSoffitO, vMapUv ).g, ktSoffitWeight );
            roughnessFactor = ktWoodRoughness;
          }
        #endif`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        #if defined( USE_NORMALMAP_TANGENTSPACE ) && defined( USE_MAP )
          if ( ktDeckWeight + ktSoffitWeight > 0.001 ) {
            vec3 ktWoodN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            if ( ktDeckWeight > 0.001 ) ktWoodN = mix( ktWoodN, texture2D( uKtDeckN, vMapUv ).xyz * 2.0 - 1.0, ktDeckWeight );
            if ( ktSoffitWeight > 0.001 ) ktWoodN = mix( ktWoodN, texture2D( uKtSoffitN, vMapUv ).xyz * 2.0 - 1.0, ktSoffitWeight );
            ktWoodN.xy *= normalScale;
            normal = normalize( tbn * normalize( ktWoodN ) );
          }
        #endif`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= 1.0 - ktSoffitWeight * 0.85;
          material.clearcoatRoughness = max( material.clearcoatRoughness, ktSoffitWeight * 0.65 );
        #endif`);
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|kt-wood2`;
}

function patchSurface(material: THREE.MeshStandardMaterial, spec: KatanaSpec): void {
  if (!spec.puddle && !spec.water && !spec.wet && !spec.paper) return;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uKtTime = KATANA_TIME;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec3 vKtSurfaceWorld;
        varying vec3 vKtSurfaceNormal;
        ${spec.paper ? "varying vec2 vKtPaperUv;" : ""}`)
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 ktSurfacePosition = vec4( transformed, 1.0 );
        vec3 ktSurfaceObjectNormal = objectNormal;
        #ifdef USE_INSTANCING
          ktSurfacePosition = instanceMatrix * ktSurfacePosition;
          ktSurfaceObjectNormal = mat3( instanceMatrix ) * ktSurfaceObjectNormal;
        #endif
        vKtSurfaceWorld = ( modelMatrix * ktSurfacePosition ).xyz;
        vKtSurfaceNormal = normalize( mat3( modelMatrix ) * ktSurfaceObjectNormal );
        ${spec.paper ? "vKtPaperUv = uv;" : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vKtSurfaceWorld;
        varying vec3 vKtSurfaceNormal;
        ${spec.paper ? "varying vec2 vKtPaperUv;" : ""}
        uniform float uKtTime;
        float ktHash( vec2 p ) {
          vec3 q = fract( vec3( p.xyx ) * 0.1031 );
          q += dot( q, q.yzx + 33.33 );
          return fract( ( q.x + q.y ) * q.z );
        }
        float ktNoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( ktHash( i ), ktHash( i + vec2( 1.0, 0.0 ) ), u.x ),
            mix( ktHash( i + vec2( 0.0, 1.0 ) ), ktHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        float ktPuddle = 0.0;
        float ktWetNoise = 0.5;
        float ktStreak = 0.0;
        float ktEmissiveMask = 1.0;
        ${spec.wet ? `
        ktWetNoise = ktNoise( vKtSurfaceWorld.xz * 0.47 + vec2( vKtSurfaceWorld.y * 0.19, -vKtSurfaceWorld.y * 0.11 ) );
        ktStreak = ktNoise( vec2( ( vKtSurfaceWorld.x + vKtSurfaceWorld.z ) * 1.7, vKtSurfaceWorld.y * 0.22 ) );
        diffuseColor.rgb *= 0.92 + ktWetNoise * 0.13;
        ` : ""}
        ${spec.puddle ? `
        float ktPuddleNoise = ktNoise( vKtSurfaceWorld.xz * 0.31 ) * 0.72 + ktNoise( vKtSurfaceWorld.xz * 0.83 + 7.1 ) * 0.28;
        ktPuddle = smoothstep( 0.55, 0.72, ktPuddleNoise ) * smoothstep( 0.64, 0.9, vKtSurfaceNormal.y );
        diffuseColor.rgb *= 1.0 - ktPuddle * 0.2;
        ` : ""}
        ${spec.paper === "shoji" ? `
        float ktPaperAA = 1.0 - smoothstep( 0.5, 2.0, max( fwidth( vKtPaperUv.x * 48.0 ), fwidth( vKtPaperUv.y * 96.0 ) ) );
        float ktFiber = ( ktNoise( vKtPaperUv * vec2( 48.0, 96.0 ) ) - 0.5 ) * 0.055 * ktPaperAA;
        float ktEdge = smoothstep( 0.0, 0.075, vKtPaperUv.x ) * smoothstep( 0.0, 0.075, 1.0 - vKtPaperUv.x )
          * smoothstep( 0.0, 0.075, vKtPaperUv.y ) * smoothstep( 0.0, 0.075, 1.0 - vKtPaperUv.y );
        float ktCentre = sin( vKtPaperUv.x * 3.14159265 ) * sin( vKtPaperUv.y * 3.14159265 );
        diffuseColor.rgb *= 0.74 + ktEdge * 0.18 + ktCentre * 0.08 + ktFiber;
        ktEmissiveMask = ( 0.32 + ktEdge * 0.45 + ktCentre * 0.23 ) * ( 1.0 + ktFiber * 0.5 );
        ` : ""}
        ${spec.paper === "lantern" ? `
        float ktPaperAA = 1.0 - smoothstep( 0.5, 2.0, max( fwidth( vKtPaperUv.x * 48.0 ), fwidth( vKtPaperUv.y * 96.0 ) ) );
        float ktFiber = ( ktNoise( vKtPaperUv * vec2( 48.0, 96.0 ) ) - 0.5 ) * 0.07 * ktPaperAA;
        float ktRib = pow( 0.5 + 0.5 * cos( vKtPaperUv.y * 75.3982237 ), 16.0 );
        float ktCap = smoothstep( 0.0, 0.12, vKtPaperUv.y ) * smoothstep( 0.0, 0.12, 1.0 - vKtPaperUv.y );
        float ktCentre = sin( vKtPaperUv.y * 3.14159265 );
        diffuseColor.rgb *= ktCap * ( 1.0 - ktRib * 0.06 ) * ( 1.0 + ktFiber );
        ktEmissiveMask = ktCap * ( 1.0 - ktRib * 0.18 ) * ( 0.75 + ktCentre * 0.25 ) * ( 1.0 + ktFiber * 0.5 );
        ` : ""}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        ${spec.wet ? "roughnessFactor = clamp( roughnessFactor * ( 0.82 + ktWetNoise * 0.32 + ktStreak * 0.06 ), 0.19, 0.84 );" : ""}
        ${spec.puddle ? "roughnessFactor = max( 0.24, mix( roughnessFactor, 0.24, ktPuddle * 0.82 ) );" : ""}
        ${spec.water ? "roughnessFactor = max( roughnessFactor, 0.3 );" : ""}`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        ${spec.wet ? `
        #ifdef USE_CLEARCOAT
          material.clearcoatRoughness = clamp( material.clearcoatRoughness * ( 0.82 + ktWetNoise * 0.36 ), 0.18, 0.58 );
        #endif
        ` : ""}`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      totalEmissiveRadiance *= ktEmissiveMask;
      ${spec.water ? `
      {
        float phaseA = ( vKtSurfaceWorld.x - vKtSurfaceWorld.z ) * 4.2 - uKtTime * 4.4879895;
        phaseA += sin( vKtSurfaceWorld.z * 1.37 + uKtTime * 0.43 ) * 1.1;
        float phaseB = ( vKtSurfaceWorld.x + vKtSurfaceWorld.z * 0.63 ) * 3.4 - uKtTime * 2.91;
        phaseB += sin( vKtSurfaceWorld.x * 1.13 - uKtTime * 0.31 ) * 0.9;
        float aa = 1.0 - smoothstep( 0.8, 3.2, max( fwidth( phaseA ), fwidth( phaseB ) ) );
        float caustic = pow( 0.5 + 0.5 * sin( phaseA ), 18.0 ) * pow( 0.5 + 0.5 * sin( phaseB ), 12.0 );
        totalEmissiveRadiance += vec3( 0.018, 0.032, 0.044 ) * caustic * aa;
      }` : ""}`);
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|kt-surface-${spec.water ? "water" : spec.paper ?? spec.puddle ? "wet" : spec.wet ? "rain" : "base"}2`;
}

export function makeKatanaMaterial(rawName: string, sets: Map<string, KatanaTextureSet>): THREE.MeshStandardMaterial {
  const spec = katanaSpec(rawName);
  const set = spec.set ? sets.get(spec.set) : undefined;
  const material = new THREE.MeshPhysicalMaterial({
    name: rawName,
    color: new THREE.Color(spec.color ?? 0xffffff).multiplyScalar(spec.gain ?? 1),
    roughness: spec.roughness ?? (set?.orm ? 1 : 0.62),
    metalness: spec.metalness ?? (set?.orm ? 1 : 0),
    envMapIntensity: spec.env ?? 0.7,
    clearcoat: spec.clearcoat ?? 0,
    clearcoatRoughness: spec.clearcoatRoughness ?? 0.3,
  });
  if (spec.water) {
    material.transparent = true;
    material.opacity = 0.86;
    material.depthWrite = false;
  }
  if (set) {
    const repeat = 1 / (spec.tile ?? set.info.tile_m ?? 1);
    const prep = (texture: THREE.Texture | undefined) => {
      if (!texture) return undefined;
      const clone = texture.clone();
      clone.repeat.setScalar(repeat);
      clone.needsUpdate = true;
      return clone;
    };
    material.map = prep(set.c) ?? null;
    material.normalMap = prep(set.n) ?? null;
    material.normalScale.setScalar(spec.normal ?? 0.4);
    const orm = prep(set.orm);
    if (orm) {
      material.roughnessMap = orm;
      material.metalnessMap = orm;
      material.aoMap = orm;
      material.aoMapIntensity = 0.72;
    } else {
      material.metalness = spec.metalness ?? 0;
    }
  }
  if (spec.emissive !== undefined) {
    material.emissive.setHex(spec.emissive);
    material.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  if (spec.doubleSided) material.side = THREE.DoubleSide;
  if (spec.alphaTest !== undefined) {
    material.alphaTest = spec.alphaTest;
    material.alphaToCoverage = true;
  }
  if (rawName.endsWith("_decal")) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
  }
  material.userData.ktWater = !!spec.water;
  material.userData.ktLantern = !!spec.lantern;
  patchWood(material, spec, sets);
  patchSurface(material, spec);
  specularAA(material);
  return material;
}
