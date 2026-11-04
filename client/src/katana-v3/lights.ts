import * as THREE from "three";
import { traceWorld } from "@shared/map";

/**
 * KATANA v3 LIGHTS — every lantern lights its surroundings, all the time, with no camera-following lights.
 *
 * The static light grid (scripts/katana-v3/art/lightgrid.mts -> art/lightgrid.{json,bin}) cuts the map into 2 m
 * cells; each cell lists up to 12 sources that can SEE it (collider line-of-sight), ranked by i / d^2. Every lit
 * material gets one loop over its cell's list (patchGridLights):
 *
 *  - "baked" (lightmapped shells, vertex-baked kit): the bake already holds the lantern's diffuse pool with real
 *    shadows and bounce, so the grid adds the SPECULAR only — the wet glint of every lantern on stone and wood.
 *  - "full" (operators, unbaked props, foliage): diffuse + specular.
 *  - wet floors (materials patched by wetness.ts): + the long vertical REFLECTION STREAK of each source (a light
 *    reflected in rain-soaked stone smears into a column toward the viewer). Its radiance does not fall off with
 *    distance (it is the mirror image of an emitter), so streaks use the grid's long listing radius (12 m).
 *
 * Lanterns also get the parts that make them read as lights: a soft halo card per source (one instanced draw,
 * depth-faded), and a cord from the lantern up to whatever it hangs from (one instanced draw).
 */

export type KvLightSrc = { id?: string; p: [number, number, number]; c: string; i: number; d: number; kind?: string };
type GridMeta = { cell: number; slots: number; min: [number, number, number]; dim: [number, number, number]; file: string; lights: KvLightSrc[] };

/** Per-kind look. `gain` scales the bake intensity for the runtime light (diffuse/spec), `paper` is the displayed
 * radiance of the source for its reflection streak, `streak` its colour in wet stone (a chochin is white paper
 * with red bands: its reflection reads red-white). */
const KIND: Record<string, { gain: number; pool: number; tint?: string; paper: number; streak: string; rim: string; radius: number; halo: string; haloSize: number }> = {
  // pool: extra runtime diffuse on BAKED surfaces (x the bake's own pool), so every lantern throws a readable pool
  // on wet stone, gravel and wood without a re-bake; the bake keeps the soft shadows, this adds the punch.
  chochin: { gain: 1.0, pool: 1.6, paper: 2.4, streak: "#ffd6da", rim: "#ff2a35", radius: 0.2, halo: "#ffe4e6", haloSize: 0.95 },
  // a toro's fire box glows red through its windows but throws a pale pool on the gravel (as the paintings do)
  toro: { gain: 4.0, pool: 1.6, tint: "#ffb3b8", paper: 1.8, streak: "#ff3a44", rim: "#E8141F", radius: 0.12, halo: "#ff3a44", haloSize: 0.7 },
  sword: { gain: 1.0, pool: 1.0, paper: 1.4, streak: "#ff2a35", rim: "#E8141F", radius: 0.1, halo: "#ff2a35", haloSize: 0 },
  andon: { gain: 1.0, pool: 1.4, paper: 1.6, streak: "#f2f6ff", rim: "#dfe9ff", radius: 0.25, halo: "#eef3ff", haloSize: 0 },
};
const KIND_DEFAULT = { gain: 1.0, pool: 1.0, paper: 1.5, streak: "#ffffff", rim: "#ffffff", radius: 0.15, halo: "#ffffff", haloSize: 0 };

export type LightGrid = {
  sources: { p: THREE.Vector3; c: THREE.Color; i: number; d: number; kind: string }[];
  uniforms: Record<string, { value: unknown }>;
  /** scene objects: halos + cords */
  group: THREE.Group;
  update: (cam: THREE.Camera) => void;
};

let ACTIVE: LightGrid | null = null;
/** The grid of the running map (operators patch against it through kvRimMaterial). */
export const activeLightGrid = (): LightGrid | null => ACTIVE;

export async function loadLightGrid(url: (u: string) => string, base: string, fallback: KvLightSrc[]): Promise<LightGrid> {
  let meta: GridMeta | null = null, bin: Int16Array | null = null;
  try {
    meta = await (await fetch(url(`${base}/lightgrid.json`))).json() as GridMeta;
    bin = new Int16Array(await (await fetch(url(`${base}/${meta.file}`))).arrayBuffer());
  } catch { meta = null; }
  const srcs = (meta?.lights ?? fallback).filter((l) => l.kind !== "fill");
  const N = Math.max(1, srcs.length);
  // light table: row 0 pos + near radius, row 1 colour * intensity + source radius, row 2 streak core colour * paper
  // radiance + pool gain, row 3 streak rim colour * paper radiance
  const lt = new Float32Array(N * 4 * 4);
  const sources = srcs.map((l, k) => {
    const K = KIND[l.kind ?? ""] ?? KIND_DEFAULT;
    const c = new THREE.Color(K.tint ?? l.c), sc = new THREE.Color(K.streak), rc = new THREE.Color(K.rim);
    lt.set([l.p[0], l.p[1], l.p[2], l.d], (0 * N + k) * 4);
    lt.set([c.r * l.i * K.gain, c.g * l.i * K.gain, c.b * l.i * K.gain, K.radius], (1 * N + k) * 4);
    lt.set([sc.r * K.paper, sc.g * K.paper, sc.b * K.paper, K.pool], (2 * N + k) * 4);
    lt.set([rc.r * K.paper, rc.g * K.paper, rc.b * K.paper, 0], (3 * N + k) * 4);
    return { p: new THREE.Vector3(...l.p), c, i: l.i, d: l.d, kind: l.kind ?? "" };
  });
  const lightTex = new THREE.DataTexture(lt, N, 4, THREE.RGBAFormat, THREE.FloatType);
  lightTex.needsUpdate = true;
  let gridTex: THREE.Data3DTexture;
  let gmin = new THREE.Vector3(), cell = 2, dim = new THREE.Vector3(1, 1, 1), on = 0;
  if (meta && bin) {
    const [NX, NY, NZ] = meta.dim, S = meta.slots, T = Math.ceil(S / 4);
    const g = new Float32Array(NX * T * NY * NZ * 4).fill(-1);
    for (let y = 0; y < NY; y++) for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
      const src = ((y * NZ + z) * NX + x) * S, dst = ((y * NZ + z) * NX * T + x * T) * 4;
      for (let s = 0; s < S; s++) g[dst + s] = bin[src + s]!;
    }
    gridTex = new THREE.Data3DTexture(g, NX * T, NZ, NY);
    gmin = new THREE.Vector3(...meta.min); cell = meta.cell; dim = new THREE.Vector3(NX, NY, NZ); on = 1;
  } else {
    gridTex = new THREE.Data3DTexture(new Float32Array([-1, -1, -1, -1]), 1, 1, 1);
    console.warn("katana lights: no lightgrid.json, lanterns light nothing at runtime (run scripts/katana-v3/art/lightgrid.mts)");
  }
  gridTex.format = THREE.RGBAFormat; gridTex.type = THREE.FloatType;
  gridTex.minFilter = gridTex.magFilter = THREE.NearestFilter; gridTex.unpackAlignment = 1; gridTex.needsUpdate = true;
  const uniforms = {
    uKgGrid: { value: gridTex }, uKgLights: { value: lightTex },
    uKgMin: { value: gmin }, uKgCell: { value: cell }, uKgDim: { value: dim }, uKgOn: { value: on },
    uKgDiffuse: { value: 1 }, uKgSpec: { value: 1 }, uKgStreak: { value: 1 }, uKgPool: { value: 1 },
  };
  const group = new THREE.Group();
  group.name = "katana/lanterns";
  const halos = makeHalos(sources);
  if (halos) group.add(halos);
  const cords = makeCords(sources);
  if (cords) group.add(cords);
  const camPos = new THREE.Vector3();
  let tamed = false;
  ACTIVE = {
    sources, uniforms, group,
    update: (cam) => {
      if (halos) { cam.getWorldPosition(camPos); (halos.material as THREE.ShaderMaterial).uniforms.uCam!.value.copy(camPos); }
      // game.ts hangs a WARM directional "gun key" (0xffd2b0, 0.48) on the camera for the viewmodel. Lights cannot be
      // layer-limited in three, so it also lights the world: on wet stone it paints an amber headlamp highlight in
      // front of the player wherever they look. On Katana it becomes a dim moonlit key (the gun still reads).
      if (!tamed) {
        tamed = true;
        cam.traverse((o) => {
          const d = o as THREE.DirectionalLight;
          if (d.isDirectionalLight && d.color.getHex() === 0xffd2b0) { d.color.set(0xc4d4ee); d.intensity = 0.22; }
        });
      }
    },
  };
  return ACTIVE;
}

const GLSL_PARS = /* glsl */ `
  uniform highp sampler3D uKgGrid; uniform highp sampler2D uKgLights;
  uniform vec3 uKgMin, uKgDim; uniform float uKgCell, uKgOn, uKgDiffuse, uKgSpec, uKgStreak, uKgPool;
  varying vec3 vKgWorld;`;

/**
 * mode "baked": specular only (the lightmap holds the diffuse pool); "full": diffuse + specular.
 * Wet materials (wetness.ts, KV_POROSITY defined) also get the reflection streaks.
 */
export function patchGridLights(m: THREE.Material, grid: LightGrid, mode: "baked" | "full"): void {
  if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial || m.userData.kgPatched) return;
  m.userData.kgPatched = mode;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    Object.assign(shader.uniforms, grid.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKgWorld;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        {
          vec4 kgW = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            kgW = instanceMatrix * kgW;
          #endif
          vKgWorld = ( modelMatrix * kgW ).xyz;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GLSL_PARS}`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
        if ( uKgOn > 0.5 ) {
          vec3 kgP = vKgWorld;
          ivec3 kc = ivec3( floor( ( kgP - uKgMin ) / uKgCell ) );
          ivec3 kd = ivec3( uKgDim );
          if ( all( greaterThanEqual( kc, ivec3( 0 ) ) ) && all( lessThan( kc, kd ) ) ) {
            vec3 kgN = normalize( inverseTransformDirection( normal, viewMatrix ) );
            vec3 kgV = normalize( cameraPosition - kgP );
            #ifdef KV_POROSITY
              // wet-floor streak frame: mirrored view ray about a mostly-up normal (the ripple/stone normal breaks it
              // into glints), across = horizontal perpendicular to the view, along = the view's ground axis + up
              vec3 kgSN = normalize( mix( vec3( 0.0, 1.0, 0.0 ), kgN, 0.35 ) );
              vec3 kgR = reflect( -kgV, kgSN );
              vec3 kgT = normalize( vec3( kgV.x, 0.0, kgV.z ) + 1e-4 );
              vec3 kgB = vec3( -kgT.z, 0.0, kgT.x );
              float kgSw = smoothstep( 0.8, 0.97, kvUp ) * kvWet * ( 0.4 + 0.6 * kvPud ) * smoothstep( 0.55, 0.04, material.roughness ) * uKgStreak;
              float kgFres = 0.06 + 0.94 * pow( 1.0 - clamp( kgV.y, 0.0, 1.0 ), 5.0 );
            #endif
            bool kgDone = false;
            for ( int s = 0; s < 3; s ++ ) {
              if ( kgDone ) break;
              vec4 ids = texelFetch( uKgGrid, ivec3( kc.x * 3 + s, kc.z, kc.y ), 0 );
              for ( int k = 0; k < 4; k ++ ) {
                float fi = ids[ k ];
                if ( fi < 0.0 ) { kgDone = true; break; }
                int li = int( fi + 0.5 );
                vec4 la = texelFetch( uKgLights, ivec2( li, 0 ), 0 );
                vec4 lb = texelFetch( uKgLights, ivec2( li, 1 ), 0 );
                vec3 L = la.xyz - kgP; float d2 = max( dot( L, L ), 1e-4 ); float dist = sqrt( d2 );
                vec3 l = L / dist;
                // near radius: UE4-style windowed inverse square
                float q = d2 / ( la.w * la.w ); float win = clamp( 1.0 - q * q, 0.0, 1.0 ); win *= win;
                if ( win > 0.0 ) {
                  float ndl = dot( kgN, l );
                  if ( ndl > 0.0 ) {
                    vec3 E = lb.rgb * ( win * ndl / max( d2, 0.16 ) );
                    vec3 lV = normalize( ( viewMatrix * vec4( l, 0.0 ) ).xyz );
                    // diffuse: a lantern is a 30-50 cm glowing body, not a point: soften the near field (no hot spot on
                    // the plaster it hangs against) and cap what one lantern can add
                    vec3 Ed = min( lb.rgb * ( win * ndl / max( d2, 0.8 ) ), vec3( 2.2 ) );
                    ${mode === "full" ? "reflectedLight.directDiffuse += Ed * BRDF_Lambert( material.diffuseColor ) * uKgDiffuse;"
                      : "reflectedLight.directDiffuse += Ed * BRDF_Lambert( material.diffuseColor ) * ( texelFetch( uKgLights, ivec2( li, 2 ), 0 ).w * uKgPool );"}
                    reflectedLight.directSpecular += E * BRDF_GGX( lV, geometryViewDir, normal, material ) * uKgSpec;
                  }
                }
                #ifdef KV_POROSITY
                if ( kgSw > 0.001 ) {
                  vec4 lc = texelFetch( uKgLights, ivec2( li, 2 ), 0 );
                  vec4 lr = texelFetch( uKgLights, ivec2( li, 3 ), 0 );
                  vec3 e = l - kgR;
                  float a = dot( e, kgB ), b = dot( e, kgT ), c = e.y;
                  // across: the source's own angular size + roughness; along: long (the stretched column). Two lobes:
                  // a narrow pale core (the paper) inside a wider red rim (the bands / lacquer), as in the paintings
                  float wA = lb.w / dist * 0.7 + 0.006 + material.roughness * 0.07;
                  float wB = 0.2 + material.roughness * 1.3;
                  float al = ( b * b + c * c ) / ( wB * wB );
                  float g1 = exp( - a * a / ( wA * wA ) - al );
                  float g2 = exp( - a * a / ( 6.0 * wA * wA ) - al * 0.7 );
                  // the mirror image fades out where the cell list ends (12 m) so it never cuts at a cell edge
                  float far = 1.0 - smoothstep( 7.0, 11.5, dist );
                  reflectedLight.directSpecular += ( lc.rgb * g1 + lr.rgb * g2 * 0.45 ) * ( kgFres * kgSw * far );
                }
                #endif
              }
            }
          }
        }`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kg-${mode}`;
  m.needsUpdate = true;
}

/** Soft halo card per chochin / toro: additive, depth-faded against nothing (it sits in air), distance-scaled so a
 * far lantern keeps a readable glow without a sprite wall up close. One instanced draw. */
function makeHalos(sources: LightGrid["sources"]): THREE.Mesh | null {
  const list = sources.filter((s) => (KIND[s.kind]?.haloSize ?? 0) > 0);
  if (!list.length) return null;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const pos = new Float32Array(list.length * 4), col = new Float32Array(list.length * 3);
  list.forEach((s, i) => {
    const K = KIND[s.kind]!;
    pos.set([s.p.x, s.p.y, s.p.z, K.haloSize], i * 4);
    const c = new THREE.Color(K.halo);
    col.set([c.r, c.g, c.b], i * 3);
  });
  g.setAttribute("aPos", new THREE.InstancedBufferAttribute(pos, 4));
  g.setAttribute("aCol", new THREE.InstancedBufferAttribute(col, 3));
  g.instanceCount = list.length;
  const m = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uGain: { value: 0.22 } },
    vertexShader: /* glsl */ `
      attribute vec4 aPos; attribute vec3 aCol; uniform vec3 uCam;
      varying vec2 vQ; varying vec3 vCol; varying float vFade;
      void main(){
        vec3 toCam = uCam - aPos.xyz; float d = length( toCam );
        // keep the halo in front of the paper (pushed 0.35 m toward the camera) so it never clips into the lantern
        vec3 c = aPos.xyz + toCam / max( d, 1e-3 ) * 0.35;
        float size = aPos.w * ( 1.0 + clamp( ( d - 8.0 ) / 40.0, 0.0, 1.0 ) * 0.8 );
        vec4 mv = modelViewMatrix * vec4( c, 1.0 );
        mv.xy += position.xy * size;
        vQ = position.xy; vCol = aCol;
        vFade = smoothstep( 1.2, 3.5, d ) * ( 1.0 - smoothstep( 70.0, 110.0, d ) );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uGain; varying vec2 vQ; varying vec3 vCol; varying float vFade;
      void main(){
        float r = length( vQ );
        float h = exp( - r * r * 9.0 ) * 0.55 + exp( - r * 3.4 ) * 0.45;
        h *= 1.0 - smoothstep( 0.75, 1.0, r );
        gl_FragColor = vec4( vCol * h * uGain * vFade, 1.0 );
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = "katana/lantern-halos";
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.userData.kvNoRainOcc = true;
  return mesh;
}

/** A cord from each chochin up to what it hangs from (collision OBBs above, within 2.2 m); lanterns with nothing
 * above stay free (they stand on brackets/poles). One instanced draw of thin dark boxes. */
function makeCords(sources: LightGrid["sources"]): THREE.InstancedMesh | null {
  const list: { x: number; y0: number; y1: number; z: number }[] = [];
  for (const s of sources) {
    if (s.kind !== "chochin") continue;
    const y0 = s.p.y + 0.18;
    const hit = traceWorld(s.p.x, y0, s.p.z, 0, 1, 0, 2.2);
    if (!hit.hit || hit.t < 0.08) continue;
    list.push({ x: s.p.x, y0, y1: y0 + hit.t + 0.02, z: s.p.z });
  }
  if (!list.length) return null;
  const geo = new THREE.BoxGeometry(0.014, 1, 0.014);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ name: "kv3_lantern_cord", color: 0x0b0a0a, roughness: 0.55 });
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const M = new THREE.Matrix4();
  list.forEach((c, i) => { M.makeScale(1, c.y1 - c.y0, 1).setPosition(c.x, c.y0, c.z); im.setMatrixAt(i, M); });
  im.instanceMatrix.needsUpdate = true;
  im.name = "katana/lantern-cords";
  im.castShadow = false; im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}
