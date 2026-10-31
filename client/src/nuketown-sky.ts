import * as THREE from "three";
import { assetUrl } from "./asset-base";
import { makeBackdrop } from "./nuketown-backdrop";
import type { TexSet } from "./nuketown-specs";
import { softwareSky } from "./software-sky";
import { pmremEnv, gpuCapabilities, type AnyRenderer } from "./gpu-backend";

/** TSL module (WebGPU only): handed in before the sky is built. */
type SkyTslMod = typeof import("./tsl-materials");
let skyTsl: SkyTslMod | null = null;
export function setSkyTsl(m: SkyTslMod | null): void {
  skyTsl = m;
}

/**
 * NUKETOWN sky, atmosphere and light (OWNER: LIGHT, P1): the sun direction
 * (shared with the bake: SUN_DIR in nt_build.py), the exposure target, the
 * hand-built desert sky, haze, the sun / hemisphere / PMREM environment rig,
 * and the baked AO / GI lightmaps (lightmaps.json from nt_bake.py) applied to
 * the map's materials. Split out of nuketown-world.ts by WO-0
 * (behaviour-identical move); the loader (nuketown-world.ts, frozen) calls
 * loadLightmaps, applyLightmap per material and buildSkyRig once.
 */

const A = (p: string) => assetUrl(`/assets/nuketown/${p}`);

/** Sun: low afternoon from the south-west (~34 deg up): long shadows, both front yards lit, rainbow crown NE. */
export const NUKETOWN_SUN_DIR = new THREE.Vector3(-0.5, 0.56, 0.66).normalize();

/**
 * Nuketown's exposure: the value game.ts hands the GRADE pass (one map-gated
 * line). GRADE multiplies by uExposure / 0.6 before ACES, so the shared 1.12
 * was x1.87 on a frame whose fill light was also counted twice (X1 / X2 in
 * docs/nuketown/reviews/r1/WORK-ORDERS.md). With the fill fixed (sunlit open
 * ground E ~ 2.3: sun 1.74 + sky/bounce ~0.6), 0.85 lands the library's
 * albedos on the LOOK BIBLE targets: sidewalk #aca893 -> ~#ada68e, desert
 * #aa977b -> ~#a7926f in sun.
 */
export const NUKETOWN_EXPOSURE = 0.63;

// ------------------------------------------------------------------ the grade, mirrored
/**
 * game.ts GRADE, mirrored on the CPU (centre of frame, no hurt/grain): warm
 * multiply, 3% desaturation, ACES (three's fitted RRT+ODT) at exposure/0.6,
 * sRGB encode, the luma-only mid-band depth curve. Used ONLY to turn LOOK BIBLE
 * display hexes (sky, haze, fog) into the scene-linear radiance that lands on
 * them, so the sky stays on target whatever NUKETOWN_EXPOSURE is. If GRADE
 * changes, change this with it.
 */
const ACES_IN = [0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];
function gradeForward(c: number[], exposure: number): number[] {
  const m3 = (m: number[], v: number[]) => [0, 1, 2].map((r) => m[r * 3]! * v[0]! + m[r * 3 + 1]! * v[1]! + m[r * 3 + 2]! * v[2]!);
  const rrt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  let x = [c[0]! * 1.14, c[1]! * 1.08, c[2]!];
  const g = 0.3 * x[0]! + 0.5 * x[1]! + 0.2 * x[2]!;
  x = x.map((v) => v * 0.97 + g * 0.03).map((v) => (v * exposure) / 0.6);
  x = m3(ACES_OUT, m3(ACES_IN, x).map(rrt)).map((v) => Math.min(1, Math.max(0, v)));
  x = x.map((v) => (v <= 0.0031308 ? v * 12.92 : Math.pow(v, 0.41666) * 1.055 - 0.055));
  const y = 0.2126 * x[0]! + 0.7152 * x[1]! + 0.0722 * x[2]!;
  if (y < 0.18) return x;
  const ss = (a: number, b: number, t: number) => { const u = Math.min(1, Math.max(0, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
  const w = ss(0.18, 0.52, y) * (1 - ss(0.6, 1, y));
  const k = 1 + ((y * y * (3 - 2 * y) - y) * 0.55 * w) / Math.max(y, 1e-4);
  return x.map((v) => v * k);
}
/** LOOK BIBLE display hex -> the scene-linear radiance GRADE turns into it. */
export function displayToScene(hex: string, exposure = NUKETOWN_EXPOSURE): THREE.Color {
  const t = new THREE.Color(hex);
  const want = [t.r, t.g, t.b].map((v) => (v <= 0.0031308 ? v * 12.92 : Math.pow(v, 0.41666) * 1.055 - 0.055)); // display sRGB 0..1
  let x = [0.2, 0.2, 0.2];
  for (let i = 0; i < 80; i++) {
    const got = gradeForward(x, exposure);
    x = x.map((v, c) => v * Math.pow((want[c]! + 0.002) / (got[c]! + 0.002), 0.6));
  }
  return new THREE.Color(x[0], x[1], x[2]);
}

// ------------------------------------------------------------------ sky
/** Everything in the backdrop lives inside the camera far plane (420 m, game.ts):
 *  distance is COMPRESSED (mesas at 300-400 m with heights scaled to read as
 *  1-2 km away) and the fog supplies the aerial perspective. */
const SKY_R = 380;
/** LOOK BIBLE display targets (measured lit, in capture): pale cyan zenith,
 *  sepia dust band over the lower 8-12 deg, darker dust at the horizon line.
 *  The shader gets their scene-linear radiance (displayToScene), so nothing
 *  double-gains them. */
const ZENITH_HEX = "#8fafb8";
const HORIZON_HEX = "#c1bba7";
const GROUND_HAZE_HEX = "#b3a288";
/** Haze colour = the sky a few degrees over the horizon, so distant geometry dissolves INTO the band. */
const FOG_HEX = "#bdb6a1";
/** Cumulus: sunlit tops / grey-blue undersides; the brown dust mass behind the rainbow. */
const CLOUD_LIT_HEX = "#ece8de";
const CLOUD_SHADE_HEX = "#98a2a6";
const DUST_HEX = "#9a8d78";
/**
 * Where the BO1 sky signatures sit (game frame: x east, z south; azimuth from
 * north toward east). BO1 places its pale double rainbow for the picture, not
 * at the anti-solar point (the panoramas show it ~100 deg round from the
 * sun); ours is centred north-east just under the horizon so its arc stands
 * over the north and east backdrops (sky-mesas-north, edge-desert-east) with
 * the brown dust plume behind its east foot, clear of the street's view north.
 */
const RAINBOW_AZ = 34, RAINBOW_EL = -9;
const DUST_AZ = 50, DUST_EL = 9;

const dirAzEl = (azDeg: number, elDeg: number) => {
  const a = THREE.MathUtils.degToRad(azDeg), e = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
};

/**
 * Hand-built desert sky, scene-referred linear (GRADE tone-maps it with
 * everything else). Static: nothing in it depends on time, so it can never
 * fail the flicker gate's temporal check.
 *  - gradient: horizon band -> pale cyan zenith colour by ~25 deg, a touch
 *    deeper overhead; the last couple of degrees darken to the ground dust;
 *  - cumulus: two-scale fbm on a sky plane (clustered, sun-side lit, grey
 *    undersides), fading into the band toward the horizon;
 *  - one large soft brown dust mass low in the north;
 *  - faint double rainbow (primary 41 deg, secondary 51 deg, Alexander's
 *    dark band between) at ~15% of the local sky;
 *  - a bloomed sun: hot disc, tight halo, wide warm forward-scatter.
 * `sunAmt` 0 / `rainbow` 0 / `gain` < 1 build the sun-free PMREM fill sky.
 */
export function makeSky(sunDir: THREE.Vector3, gain = 1, rainbow = 1, sunAmt = 1, tint: THREE.Color = new THREE.Color(1, 1, 1)): THREE.Mesh {
  // WebGPU: custom GLSL has no node mapping. The TSL port (tsl-materials) is the
  // real sky now — clouds, rainbow and the sun disc included. The vertex-colour
  // gradient below survives only as the fallback for a build that never handed
  // the module over.
  if (gpuCapabilities().active === "webgpu" && skyTsl) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_R, 96, 48),
      skyTsl.tslNuketownSky({
        sun: sunDir,
        zenith: displayToScene(ZENITH_HEX),
        horizon: displayToScene(HORIZON_HEX),
        ground: displayToScene(GROUND_HAZE_HEX),
        cloudLit: displayToScene(CLOUD_LIT_HEX),
        cloudShade: displayToScene(CLOUD_SHADE_HEX),
        dust: displayToScene(DUST_HEX),
        bowC: dirAzEl(RAINBOW_AZ, RAINBOW_EL),
        dustC: dirAzEl(DUST_AZ, DUST_EL),
        gain,
        rainbow,
        sunAmt,
        tint,
      }).material,
    );
    m.renderOrder = -100;
    m.frustumCulled = false;
    m.name = "nuketown/sky";
    m.userData.qaIgnore = true;
    return m;
  }
  if (gpuCapabilities().active === "webgpu") {
    void rainbow;
    void sunAmt;
    const geo = new THREE.SphereGeometry(900, 32, 16);
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const zen = displayToScene(ZENITH_HEX).multiplyScalar(gain);
    const hor = displayToScene(HORIZON_HEX).multiplyScalar(gain);
    const gnd = displayToScene(GROUND_HAZE_HEX).multiplyScalar(gain);
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      if (v.y >= 0.42) c.copy(zen);
      else if (v.y >= 0.07) c.copy(hor).lerp(zen, (v.y - 0.07) / 0.35);
      else if (v.y >= 0) c.copy(hor);
      else c.copy(gnd);
      c.multiply(tint);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }));
    m.renderOrder = -100;
    m.frustumCulled = false;
    m.name = "nuketown/sky";
    return m;
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: sunDir.clone().normalize() },
      uZenith: { value: displayToScene(ZENITH_HEX) },
      uHorizon: { value: displayToScene(HORIZON_HEX) },
      uGround: { value: displayToScene(GROUND_HAZE_HEX) },
      uCloudLit: { value: displayToScene(CLOUD_LIT_HEX) },
      uCloudShade: { value: displayToScene(CLOUD_SHADE_HEX) },
      uDust: { value: displayToScene(DUST_HEX) },
      uBowC: { value: dirAzEl(RAINBOW_AZ, RAINBOW_EL) },
      uDustC: { value: dirAzEl(DUST_AZ, DUST_EL) },
      uGain: { value: gain },
      uRainbow: { value: rainbow },
      uSunAmt: { value: sunAmt },
      uTint: { value: tint },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `precision highp float;
      uniform vec3 uSun, uZenith, uHorizon, uGround, uCloudLit, uCloudShade, uDust, uBowC, uDustC;
      uniform float uGain, uRainbow, uSunAmt; uniform vec3 uTint; varying vec3 vDir;
      float hash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
      float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
      vec3 spectral(float t){ // t in [0,1] red -> violet
        return clamp(vec3(1.5 - abs(t * 4.0 - 0.5), 1.4 - abs(t * 4.0 - 2.0), 1.3 - abs(t * 4.0 - 3.3)), 0.0, 1.0);
      }
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        float cs = dot(d, uSun);
        // ---- gradient: band (lower ~10 deg) -> zenith colour by ~25 deg, deeper overhead
        float band = 1.0 - smoothstep(0.07, 0.42, h);
        vec3 col = mix(uZenith * mix(1.0, 0.9, smoothstep(0.5, 1.0, h)), uHorizon, band * band * (3.0 - 2.0 * band));
        // warmer, brighter band toward the sun (forward scatter in the dust)
        float sunSide = 0.5 + 0.5 * dot(normalize(vec2(d.x, d.z) + 1e-5), normalize(vec2(uSun.x, uSun.z)));
        col *= 1.0 + band * (sunSide - 0.5) * 0.16 * vec3(1.06, 1.0, 0.9);
        // the last couple of degrees: dust hugging the ground
        col = mix(col, uGround, 1.0 - smoothstep(-0.005, 0.06, h));
        // ---- brown dust mass, low in the north (soft, lumpy edge)
        vec3 dm = d - uDustC;
        float dmr = length(vec2(dm.x, dm.z)) * 0.95 + max(dm.y, 0.0) * 1.6 + max(-dm.y, 0.0) * 0.6;
        float dn = fbm(d.xz / (h + 0.35) * 2.6 + 3.0);
        float dust = (1.0 - smoothstep(0.2, 0.85, dmr + (dn - 0.5) * 0.7)) * smoothstep(-0.02, 0.08, h);
        col = mix(col, uDust * (0.82 + 0.36 * fbm(d.xz / (h + 0.3) * 5.0 + 7.0)), dust * 0.78);
        // ---- rainbow: primary (violet inside), Alexander's dark band, secondary (reversed, fainter)
        if (uRainbow > 0.0) {
          float ang = degrees(acos(clamp(dot(d, uBowC), -1.0, 1.0)));
          float above = smoothstep(0.015, 0.16, h);
          float p1 = smoothstep(39.4, 40.4, ang) * (1.0 - smoothstep(42.2, 43.2, ang));
          float p2 = smoothstep(49.6, 50.8, ang) * (1.0 - smoothstep(53.4, 54.6, ang));
          vec3 bow = mix(vec3(0.55), spectral(1.0 - (ang - 39.6) / 3.2), 0.8) * p1 + mix(vec3(0.55), spectral((ang - 50.0) / 4.0), 0.7) * p2 * 0.5;
          float l = lum(col);
          col *= 1.0 + above * uRainbow * (0.04 * (1.0 - smoothstep(38.0, 41.0, ang)) - 0.035 * smoothstep(42.2, 43.5, ang) * (1.0 - smoothstep(49.0, 50.5, ang)));
          col += bow * l * 0.2 * above * uRainbow * (0.65 + 0.35 * dust);
        }
        // ---- cumulus on a sky plane: scattered puffs in loose groups, lit toward the sun
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.1) * 1.6;
          vec2 w = vec2(vnoise(uv * 1.3 + 5.2), vnoise(uv * 1.3 + 1.7)) - 0.5;
          vec2 q = uv * 2.4 + w * 0.55;
          float n = fbm(q);
          float cluster = smoothstep(0.42, 0.66, fbm(uv * 0.42 + 11.0));
          float base = n * (0.72 + 0.5 * cluster);
          float cov = smoothstep(0.56, 0.7, base);
          vec2 toSun = normalize(uSun.xz + 1e-5) * 0.09;
          float n2 = fbm(q + toSun) * (0.72 + 0.5 * cluster);
          float lit = clamp(0.62 + (base - n2) * 6.0, 0.0, 1.0);
          // thick cores read darker underneath (flat grey bases), thin edges glow
          float core = smoothstep(0.66, 0.84, base);
          vec3 cc = mix(uCloudShade, uCloudLit, lit * (1.0 - 0.45 * core) + 0.12 * (1.0 - core));
          cc *= 1.0 + 0.3 * pow(max(cs, 0.0), 8.0);
          // far clouds sink into the dust band
          cc = mix(cc, col, 1.0 - smoothstep(0.05, 0.4, h));
          col = mix(col, cc, cov * smoothstep(0.02, 0.22, h) * 0.95);
        }
        // ---- the sun: hot disc, tight halo, wide warm forward-scatter (bloomed BO1 sun)
        float c0 = max(cs, 0.0);
        vec3 glow = vec3(1.0, 0.9, 0.74) * (pow(c0, 5.0) * 0.16 + pow(c0, 30.0) * 0.38 + pow(c0, 220.0) * 1.3 + pow(c0, 1600.0) * 7.0);
        col += uSunAmt * glow * lum(uZenith) * 2.2;
        col += uSunAmt * vec3(1.0, 0.97, 0.92) * smoothstep(0.99975, 0.9999, cs) * 30.0;
        gl_FragColor = vec4(col * uGain * uTint, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 96, 48), mat);
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  sky.name = "nuketown/sky";
  sky.userData.qaIgnore = true;
  return sky;
}

// ------------------------------------------------------------------ haze
/**
 * Aerial perspective: exponential fog with a ground-hugging dust layer and a
 * camera veil, evaluated per fragment along the eye ray (three only ships
 * linear and exp2 fog). Nuketown's page owns these chunks: other maps never
 * load this module, so their fog is untouched. Density b0 = scene.fog.density;
 *   tau = b0 * L * (1 + FOG_GROUND * e^(-y_cam/FOG_H) * (1 - e^(-dy/FOG_H)) / (dy/FOG_H))
 * ~ -30% contrast at 300 m along the ground, ~5% at 40 m (across the map).
 * FOG_VEIL is the haze between the eye and anything (lifts the deepest shade
 * a few percent toward the band, as the BO1 frames do). Toward the sun the
 * haze glows warmer. A material can scale its optical depth with
 * `#define NT_FOG_SCALE k` (the compressed backdrop reads as km away).
 */
export const FOG_DENSITY = 0.0009;
export const FOG_GROUND = 0.55;
export const FOG_H = 10;
export const FOG_VEIL = 0.035;
const FOG_SUN = 0.35;
function installHeightFog(sunDir: THREE.Vector3): void {
  const C = THREE.ShaderChunk as unknown as Record<string, string> & { __ntHeightFog?: boolean };
  if (C.__ntHeightFog) return;
  C.__ntHeightFog = true;
  const f = (n: number) => n.toFixed(5);
  C.fog_pars_vertex = `#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
#endif`;
  C.fog_vertex = `#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;
  C.fog_fragment = `#ifdef USE_FOG
	{
		vec3 ntRay = vFogWorld - cameraPosition;
		float ntL = length( ntRay );
		#ifdef FOG_EXP2
			float ntDy = ntRay.y / ${f(FOG_H)};
			float ntK = abs( ntDy ) > 1e-3 ? ( 1.0 - exp( - ntDy ) ) / ntDy : 1.0;
			float ntTau = fogDensity * ntL * ( 1.0 + ${f(FOG_GROUND)} * exp( - max( cameraPosition.y, 0.0 ) / ${f(FOG_H)} ) * ntK );
			#ifdef NT_FOG_SCALE
				ntTau *= NT_FOG_SCALE;
			#endif
			float fogFactor = min( 1.0 - ( 1.0 - ${f(FOG_VEIL)} ) * exp( - ntTau ), 0.985 );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		float ntSun = pow( max( dot( ntRay / max( ntL, 1e-3 ), vec3( ${f(sunDir.x)}, ${f(sunDir.y)}, ${f(sunDir.z)} ) ), 0.0 ), 6.0 );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * ( 1.0 + ${f(FOG_SUN)} * ntSun * vec3( 1.0, 0.95, 0.85 ) ), fogFactor );
	}
#endif`;
}

// ------------------------------------------------------------------ soft sun shadows (removed tent, history kept)
// WORK-ORDERS L3 once patched the PCF_SOFT branch here into a 3x3 tent of
// bilinear compare taps at 1.5-texel spacing (about 4-5 texels across, i.e.
// ~11-14 cm on this 4096 map at 116 m frustum width) for a hazy desert
// penumbra. r187 removed that SHADOWMAP_TYPE_PCF_SOFT branch entirely
// (zero occurrences in the vendored ShaderChunk; WebGLShadowMap logs the type
// as removed), so the patch's guard could never match again and the installer
// silently no-opped — this is a deliberate removal of dead code, not a look
// change. Its replacement PCF kernel is a five-sample Vogel disk whose only
// width knob is shadowRadius (in shadow texels); widening that toward ~14 cm
// reads as speckle, which is why the penumbra is now a clamped ~1.6-texel disk
// (see Game.clampShadowRadii's SHADOW_RADIUS_MAX).

// ------------------------------------------------------------------ lightmaps
/** One role object's bake: AO + GI on UV1 (lightmaps.json, nt_bake.py). */
export type Lightmap = { ao?: THREE.Texture; gi?: THREE.Texture; giScale: number };
export type LightmapsFile = Record<string, { ao?: string; gi?: string; giScale?: number }>;

/** Load the baked lightmaps (hardware tier only: the software tier skips them). */
export async function loadLightmaps(lightmaps: LightmapsFile | null, soft: boolean): Promise<Record<string, Lightmap>> {
  const tl = new THREE.TextureLoader();
  const lm: Record<string, Lightmap> = {};
  if (lightmaps && !soft) {
    await Promise.all(Object.entries(lightmaps).map(async ([obj, e]) => {
      const rec: Lightmap = { giScale: e.giScale ?? 1 };
      if (e.ao) rec.ao = await tl.loadAsync(A(e.ao)).catch(() => undefined);
      if (e.gi) rec.gi = await tl.loadAsync(A(e.gi)).catch(() => undefined);
      for (const t of [rec.ao, rec.gi]) {
        if (!t) continue;
        t.channel = 1;
        t.flipY = false;
      }
      if (rec.gi) rec.gi.colorSpace = THREE.SRGBColorSpace;
      lm[obj] = rec;
    }));
  }
  return lm;
}

/**
 * FILL BUDGET (X2 + the orchestrator's shade calibration on MAT's sets).
 * BO1 is a hazy, ambient-heavy look: open ground in shade sits ~1 stop under
 * sun (fill ~1.8 vs the sun's 1.74 at 34 deg), walls a little brighter still
 * (V_FILL), interiors dimmer and warm (INT_GAIN); NUKETOWN_EXPOSURE 0.63
 * keeps the sunlit LOOK BIBLE values. Every fill source is counted ONCE:
 *  - lightmapped role objects (houses, terrain, structures, fences, hedges):
 *    the baked GI only (sky + bounce + practicals, already occluded) x
 *    GI_GAIN, tinted warm. No env diffuse, no hemisphere. Env SPECULAR
 *    stays, scaled by the baked sky visibility (the GI map's alpha,
 *    nt_bake.py) so a floor indoors does not mirror the open sky.
 *  - everything else (hero props, vehicles, backdrop): the PMREM sky (no sun
 *    in it: the sun is the directional light) at ENV_FILL over a sunlit-
 *    ground bounce hemisphere, the same fill on an up-facing surface.
 * Contact stays: the GI and AO bakes keep their occlusion, and the screen-
 * space AO (ssao.ts — formerly nuketown-ao.ts, now map-agnostic) adds it
 * under props.
 */
/** The fill's colour: BO1's shade is warm-neutral desert bounce, not the cyan
 *  sky + green lawn the bake sees (which reads teal on asphalt and mint). */
const FILL_TINT = new THREE.Color(1.08, 0.97, 0.86);
/** Extra fill on VERTICAL surfaces (1 + V_FILL * (1 - |n.y|)): the BO1 look's
 *  bright horizon haze + desert bounce lights walls more than a physical sky
 *  dome does. Ground (n up) and undersides (n down) keep the plain fill, so
 *  porch / carport / balcony undersides stay dark and contact reads. Only
 *  exterior walls (baked sky visibility, the GI map's alpha) take it. */
const V_FILL = 0.6;
/** Interiors (baked sky visibility ~0) keep BO1's dimmer, warmer level:
 *  their GI (daylight bounce + practicals) x INT_GAIN on top of GI_GAIN. */
const INT_GAIN = 0.8;
const GI_GAIN = 1.8;
/** PMREM sky gain (sun-free env) for the non-lightmapped fill. */
const ENV_FILL = 1.8;

/** Bind a role object's lightmaps to one of its materials (glass never takes them). */
export function applyLightmap(m: THREE.Material, L: Lightmap | undefined, glass: boolean): void {
  if (L && m instanceof THREE.MeshStandardMaterial && !glass) {
    if (L.ao) {
      m.aoMap = L.ao;
      m.aoMapIntensity = 1;
    }
    if (L.gi) {
      m.lightMap = L.gi;
      m.lightMapIntensity = L.giScale * GI_GAIN;
      lightmapOnlyFill(m);
    }
  }
}

/**
 * Lightmapped surfaces: the baked irradiance is the whole diffuse fill
 * (three adds the env's irradiance on top by default). Env specular is kept,
 * attenuated by the baked sky visibility.
 */
function lightmapOnlyFill(m: THREE.MeshStandardMaterial): void {
  if (m.userData.ntLightmapFill) return;
  m.userData.ntLightmapFill = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <lights_fragment_maps>",
      `float ntSkyVis = 1.0;
      #if defined( RE_IndirectDiffuse ) && defined( USE_LIGHTMAP )
        vec4 ntLm = texture2D( lightMap, vLightMapUv );
        // alpha = 0.5 + 0.5 * baked sky visibility (nt_bake.py): vis ~1 open ground, ~0.5 open
        // wall, ~0 indoors (a lightmap without it reads 1: all exterior, as before)
        float ntSky = clamp( ( ntLm.a - 0.5 ) * 2.0, 0.0, 1.0 );
        float ntOut = smoothstep( 0.06, 0.24, ntSky );
        vec3 lightMapIrradiance = ntLm.rgb * lightMapIntensity * vec3( ${FILL_TINT.r.toFixed(3)}, ${FILL_TINT.g.toFixed(3)}, ${FILL_TINT.b.toFixed(3)} );
        lightMapIrradiance *= mix( ${INT_GAIN.toFixed(3)}, 1.0, ntOut );
        irradiance += lightMapIrradiance;
        {
          float ntUp = dot( geometryNormal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
          irradiance += lightMapIrradiance * ${V_FILL.toFixed(3)} * ( 1.0 - abs( ntUp ) ) * ntOut;
        }
        ntSkyVis = smoothstep( 0.03, 0.4, ntSky );
      #endif
      #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
        radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * ntSkyVis;
      #endif`,
    );
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|ntLmFill6`;
  m.needsUpdate = true;
}

// ------------------------------------------------------------------ the rig
export type SkyRig = { sky: THREE.Mesh; sun: THREE.DirectionalLight; update: (dt: number, cam: THREE.Camera) => void };

/**
 * Sky, backdrop, haze, sun + hemisphere fill + environment, added to the scene
 * in this order (the loader calls it once, after the map and the props).
 */
export async function buildSkyRig(scene: THREE.Scene, renderer: AnyRenderer, soft: boolean, sets: Map<string, TexSet>, lm: Record<string, Lightmap>): Promise<SkyRig> {
  // ---------------------------------------------------------- sky, haze, backdrop
  const sky = makeSky(NUKETOWN_SUN_DIR);
  scene.add(sky);
  const backdrop = makeBackdrop(sets, soft);
  scene.add(backdrop);
  // aerial perspective: exponential + ground dust + veil (installHeightFog), in
  // scene-linear so far geometry lands ON the band after the grade
  installHeightFog(NUKETOWN_SUN_DIR);
  scene.fog = new THREE.FogExp2(displayToScene(FOG_HEX), FOG_DENSITY);

  // ---------------------------------------------------------- light
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.1);
  sun.position.copy(NUKETOWN_SUN_DIR).multiplyScalar(120);
  sun.target.position.set(-1, 0, -5);
  sun.castShadow = !soft;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -58; sc.right = 58; sc.top = 40; sc.bottom = -40; sc.near = 40; sc.far = 230;
  // r187's 5-tap Vogel-disk PCF kernel: radius is in shadow texels and the
  // runtime clamps it to 1.6 via Game.clampShadowRadii (wider reads as grain).
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 2; // authored 2.0, effective 1.6 after the runtime clamp (see above)
  scene.add(sun, sun.target);
  // sky fill: pale cyan above, warm lawn/dust bounce below. Hardware: the env
  // (and the GI bake, where it exists) IS the fill, the hemisphere only keeps
  // an unbaked dev build from going black indoors; the software tier has no
  // env and no lightmaps, so it is the whole fill there.
  const baked = Object.keys(lm).length > 0;
  // (software: ~the hardware fill on an up-facing surface, GI_GAIN x the bake's ~1.0)
  const hemi = new THREE.HemisphereLight(0xc9d2d2, 0x9a8a62, soft ? 2.7 : baked ? 0 : 0.3);
  scene.add(hemi);

  // PMREM environment from the same sky + a warm ground hemisphere
  if (!soft) {
    // the sky WITHOUT the sun (the directional light is the sun) at the fill
    // gain, over the sunlit ground's radiance (lawn / sand / asphalt mix, E ~2.3)
    const env = new THREE.Scene();
    const envSky = makeSky(NUKETOWN_SUN_DIR, ENV_FILL, 0, 0, FILL_TINT);
    env.add(envSky);
    const groundBall = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 16, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.24, 0.21, 0.15), side: THREE.BackSide }),
    );
    env.add(groundBall);
    // Build-exact PMREM (gpu-backend.ts): the WebGL build generator would break on WebGPU.
    scene.environment = await pmremEnv(renderer, env, 0.02, 1, 2000);
    scene.environmentIntensity = 1;
  } else {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 128;
    const x = c.getContext("2d")!;
    const gr = x.createLinearGradient(0, 0, 0, 128);
    // the canvas is decoded sRGB -> linear and then graded like everything
    // else: store the scene-linear radiance that grades onto the bible hexes
    // (v = 0.5 is the horizon; the hardware sky reaches its zenith colour by ~30 deg)
    const zen = `#${displayToScene(ZENITH_HEX).getHexString()}`;
    gr.addColorStop(0, zen);
    gr.addColorStop(0.32, zen);
    gr.addColorStop(0.47, `#${displayToScene(HORIZON_HEX).getHexString()}`);
    gr.addColorStop(0.5, `#${displayToScene(GROUND_HAZE_HEX).getHexString()}`);
    gr.addColorStop(1, `#${displayToScene(GROUND_HAZE_HEX).getHexString()}`);
    x.fillStyle = gr;
    x.fillRect(0, 0, 4, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = t;
    sky.visible = false;
    softwareSky(scene);
  }
  return {
    sky,
    sun,
    update: (_dt: number, cam: THREE.Camera) => {
      sky.position.copy(cam.position);
      backdrop.follow(cam.position);
    },
  };
}
