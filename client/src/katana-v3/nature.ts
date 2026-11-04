/**
 * KATANA v3 — NATURE r2 (runtime): scanned rocks, kasuga toro, black pines, sacred cedars, koi, the layered
 * mountain + cedar-forest backdrop. Everything here is INSTANCED (one draw per mesh part per LOD bucket) and
 * placed from public/assets/katana/v3/nature2/place.json (scripts/katana-v3/nature2/place.py, regenerated from
 * layout.json + the collider solids), so the art kit (kva_build.py) no longer draws its own stand-ins for these.
 *
 *   rocks.glb   Poly Haven CC0 scans (rock_moss_set_01/02), rock_<v>_LOD0/1/2, kv3r_<set> materials
 *   toro.glb    kasuga toro, chamfered granite, lit hibukuro (red paper windows)
 *   trees.glb   kuromatsu niwaki (tapered trunk, branches, needle-clump cards) + goshinboku sugi
 *   koi.glb     (props/nature) swimming under the water surface on their own layer, see `koi`
 *
 * Shading: library-style PBR + the shared wetness patch (wetness.ts), moss grown on up-facing stone in the shader,
 * wind sway on foliage in the vertex shader (weights in COLOR_0.r, per-instance phase from the instance origin).
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { assetUrl, sameOriginManager } from "../asset-base";
import type { V3Library } from "./library";
import { patchWetness, type WetnessRig } from "./wetness";

const BASE = "/assets/katana/v3/nature2";

type Xform = { pos: number[]; yaw: number; scale: number[] | number };
type Place = {
  rocks: (Xform & { id: string; v: string; hero?: boolean })[];
  toro: { id: string; pos: number[]; yaw: number; h: number; foot: number[] }[];
  pines: { id: string; pos: number[]; h: number }[];
  sacred: { id: string; pos: number[]; r: number; h: number }[];
  koi: { id: string; water_y: number; ring?: number[]; rect?: number[]; n: number }[];
  toro_inst: (Xform & { asset: string; id: string })[];
  stones: (Xform & { asset: string; id: string })[];
  tree_inst: (Xform & { asset: string; id: string })[];
  /** mountain cedars: [x, y, z, yaw, scale] */
  forest: number[][];
  backdrop: { centre: number[]; rings: { r: number; h: number[]; amp: number; col: string; fog: number; forest: number; follow: number }[] };
  edge?: (Xform & { kind: string })[];
};

export type KatanaNature = {
  root: THREE.Group;
  materials: THREE.Material[];
  update: (dt: number, cam: THREE.Camera) => void;
  stats: () => Record<string, number>;
};

// ------------------------------------------------------------------------------------------------ instancer
type Part = { geo: THREE.BufferGeometry; mat: THREE.Material };
/** One asset with LOD levels; every (LOD, part) is an InstancedMesh, instances re-bucketed by camera distance. */
class Instanced {
  readonly meshes: THREE.InstancedMesh[][] = [];
  private mats: THREE.Matrix4[] = [];
  private centres: THREE.Vector3[] = [];
  private radius: number[] = [];
  constructor(readonly name: string, lods: Part[][], private dists: number[], cap: number, parent: THREE.Object3D, shadow = true) {
    lods.forEach((parts, li) => {
      this.meshes[li] = parts.map((p, pi) => {
        const m = new THREE.InstancedMesh(p.geo, p.mat, cap);
        m.name = `nature/${name}/L${li}/${pi}`;
        m.count = 0;
        m.visible = false;
        m.castShadow = shadow && li < 2 && !(p.mat as THREE.MeshStandardMaterial).alphaTest;
        m.receiveShadow = true;
        m.layers.enable(1);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // culling uses the bucket's own sphere (set in update() from the instance centres + radii), never the
        // geometry's origin sphere (that culled whole buckets: the integrator saw the sword rock vanish)
        m.frustumCulled = true;
        m.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
        parent.add(m);
        return m;
      });
    });
  }
  add(m: THREE.Matrix4, r = 2, centre?: THREE.Vector3): void {
    this.mats.push(m.clone());
    this.centres.push(centre ? centre.clone() : new THREE.Vector3().setFromMatrixPosition(m));
    this.radius.push(r);
  }
  get size(): number { return this.mats.length; }
  /** forced: every instance at LOD `lod` (rain-occlusion / probe captures) */
  update(cam: THREE.Vector3, bias = 1, forced = -1): void {
    const n = this.meshes.length;
    const buckets: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < this.mats.length; i++) {
      let l = 0;
      if (forced >= 0) l = Math.min(forced, n - 1);
      else {
        const d = (this.centres[i]!.distanceTo(cam) - this.radius[i]!) * bias;
        while (l < n - 1 && d > this.dists[l]!) l++;
      }
      buckets[l]!.push(i);
    }
    for (let l = 0; l < n; l++) {
      const b = buckets[l]!;
      for (const mesh of this.meshes[l]!) {
        mesh.count = b.length;
        mesh.visible = b.length > 0;
        for (let k = 0; k < b.length; k++) mesh.setMatrixAt(k, this.mats[b[k]!]!);
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (b.length) {
        const box = new THREE.Box3();
        for (const i of b) box.expandByPoint(this.centres[i]!);
        const sph = box.getBoundingSphere(new THREE.Sphere());
        let r = 0;
        for (const i of b) r = Math.max(r, sph.center.distanceTo(this.centres[i]!) + this.radius[i]!);
        sph.radius = r;
        for (const mesh of this.meshes[l]!) mesh.boundingSphere!.copy(sph);
      }
    }
  }
}

const xform = (t: Xform): THREE.Matrix4 => {
  const s = Array.isArray(t.scale) ? t.scale : [t.scale, t.scale, t.scale];
  // game yaw (sim / expand.mjs): local +x -> (cos, sin) in x/z  == rotation of -yaw about +Y in three
  return new THREE.Matrix4().compose(new THREE.Vector3(...(t.pos as [number, number, number])),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -t.yaw), new THREE.Vector3(s[0], s[1], s[2]));
};

// ------------------------------------------------------------------------------------------------ materials
function texLoader(base: string, low: boolean, aniso: number) {
  const tl = new THREE.TextureLoader(sameOriginManager());
  const cache = new Map<string, THREE.Texture>();
  const pending: Promise<unknown>[] = [];
  const get = (name: string, srgb: boolean, repeat = true): THREE.Texture => {
    const file = `${base}/tex/${name}${low ? "-low" : ""}.webp`;
    let t = cache.get(file);
    if (t) return t;
    let done: () => void = () => {};
    pending.push(new Promise<void>((r) => { done = r; }));
    t = tl.load(assetUrl(file), () => done(), undefined, () => { console.warn(`nature: missing ${file}`); done(); });
    t.flipY = false; t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    cache.set(file, t);
    return t;
  };
  return { get, ready: () => Promise.all(pending) };
}

/**
 * Moss on stone: up-facing, noise-broken, thicker in hollows (low ormh height), with a soft rim; the moss albedo comes
 * from the library moss scan (world-space XZ), its normal flattens the stone relief. Runs BEFORE the wetness block
 * so wet moss darkens like everything else.
 */
function patchMoss(m: THREE.MeshStandardMaterial, moss: THREE.Texture, amount: number, tint = new THREE.Color(0.55, 0.62, 0.45)): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uKvMoss = { value: moss };
    sh.uniforms.uKvMossTint = { value: tint };
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform sampler2D uKvMoss; uniform vec3 uKvMossTint;
        float kvMn( vec3 p ) { vec3 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
          float n = i.x + i.y * 57.0 + i.z * 113.0;
          vec4 h = fract( sin( vec4( n, n + 1.0, n + 57.0, n + 58.0 ) ) * 43758.5453 );
          vec4 h2 = fract( sin( vec4( n + 113.0, n + 114.0, n + 170.0, n + 171.0 ) ) * 43758.5453 );
          vec4 a = mix( h, h2, f.z ); vec2 b = mix( a.xz, a.yw, f.x ); return mix( b.x, b.y, f.y ); }
        float kvMossW = 0.0;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        {
          vec3 kvNw = normalize( vKvWorldN );
          float n = kvMn( vKvWorld * 2.3 ) * 0.6 + kvMn( vKvWorld * 7.1 ) * 0.4;
          float hgt = 0.5;
          #ifdef USE_ROUGHNESSMAP
            hgt = texture2D( roughnessMap, vRoughnessMapUv ).a;
          #endif
          float up = smoothstep( ${(0.72 - amount * 0.3).toFixed(3)}, ${(0.98 - amount * 0.15).toFixed(3)}, kvNw.y + ( n - 0.5 ) * 0.6 + ( 0.5 - hgt ) * 0.4 );
          kvMossW = clamp( up * ${amount.toFixed(3)}, 0.0, 1.0 );
          vec3 mc = texture2D( uKvMoss, vKvWorld.xz * 0.9 ).rgb * uKvMossTint;
          diffuseColor.rgb = mix( diffuseColor.rgb, mc, kvMossW );
        }`)
      // after the wetness block (it clamps roughness to the wet film): moss stays velvety when soaked
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.72, kvMossW * 0.85 );`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        normal = normalize( mix( normal, nonPerturbedNormal, kvMossW * 0.55 ) );`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kvmoss${amount.toFixed(2)}`;
}

/**
 * Wind: vertices sway by COLOR_0.r^2 (0 at the root, 1 at the pad tips), per-instance phase from the instance origin;
 * foliage (mode 1) adds a small flutter along the normal. Two slow gusts, never more than ~8 cm on a pine pad.
 */
function patchWind(m: THREE.MeshStandardMaterial, uTime: { value: number }, mode: 0 | 1): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uKvWind = uTime;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uKvWind;
        #ifndef USE_COLOR
        attribute vec3 color;
        #endif`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        {
          vec3 kvO = vec3( 0.0 );
          float kvS = 1.0;
          #ifdef USE_INSTANCING
            kvO = instanceMatrix[ 3 ].xyz;
            kvS = length( instanceMatrix[ 1 ].xyz );
          #endif
          float w = color.r * color.r;
          float ph = dot( kvO, vec3( 0.13, 0.0, 0.17 ) );
          float g = sin( uKvWind * 0.55 + ph ) * 0.6 + sin( uKvWind * 1.37 + ph * 1.7 ) * 0.4;
          vec3 sway = vec3( g, 0.0, cos( uKvWind * 0.71 + ph * 1.3 ) * 0.5 ) * 0.07 * w * ( 0.6 + 0.4 * kvS );
          ${mode === 1 ? "sway += objectNormal * sin( uKvWind * 6.3 + ph * 9.0 + position.x * 3.0 + position.z * 2.0 ) * 0.025 * color.g * w;" : ""}
          transformed += sway / max( kvS, 0.001 );
        }`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kvwind${mode}`;
}

/**
 * Foliage cards: alpha-to-coverage with the mip fix (alpha is rescaled by the texel footprint so thin needles do not
 * dissolve at distance), a moonlit back-scatter term, and alpha 1 written for the SSR mask (foliage never reflects).
 */
function patchFoliage(m: THREE.MeshStandardMaterial): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <alphatest_fragment>", `{
          #ifdef USE_MAP
          vec2 kvTs = vec2( textureSize( map, 0 ) );
          vec2 kvD = max( abs( dFdx( vMapUv * kvTs ) ), abs( dFdy( vMapUv * kvTs ) ) );
          float kvMip = max( 0.0, 0.5 * log2( max( dot( kvD, kvD ), 1e-6 ) ) );
          diffuseColor.a *= 1.0 + kvMip * 0.28;
          #endif
          diffuseColor.a = ( diffuseColor.a - alphaTest ) / max( fwidth( diffuseColor.a ), 1e-4 ) + 0.5;
        }
        #include <alphatest_fragment>`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kvfol`;
}

/**
 * Koi swim UNDER the moat / pond surface as their own mesh layer (the render lane owns the water shader, which is opaque
 * so it can write the SSR mask). Each fish is drawn after the water with its DEPTH moved onto the water plane (the
 * point where the eye ray to the fish crosses the surface, 2 cm toward the camera), so the opaque water does not hide
 * it while anything in front of the water (rims, bridges, rocks, players) still does; colour and opacity fade with
 * depth toward the water tint, and the body undulates (COLOR_0.r = spine weight). Paths: loops round the moat ring,
 * ellipses in the pond, 0.25-0.5 m/s, 0.18-0.42 m deep. If the water ever becomes truly transparent, ?kvkoidepth=0
 * draws them with ordinary depth.
 */
async function buildKoi(waters: Place["koi"], loader: GLTFLoader, uTime: { value: number }, low: boolean) {
  if (!waters.length) return null;
  const g = await loader.loadAsync(assetUrl("/assets/katana/v3/props/nature/koi.glb"));
  const tl = new THREE.TextureLoader(sameOriginManager());
  const ct = tl.load(assetUrl("/assets/katana/v3/props/nature/tex/koi_c.webp")); ct.flipY = false; ct.colorSpace = THREE.SRGBColorSpace;
  const depthTrick = new URLSearchParams(location.search).get("kvkoidepth") !== "0";
  const uWater = { value: new THREE.Vector3(0.05, 0.075, 0.085) };
  const mat = new THREE.MeshStandardMaterial({ name: "kv3k_koi", map: ct, roughness: 0.35, metalness: 0, transparent: true, depthWrite: false });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uKvT = uTime; sh.uniforms.uKvWaterTint = uWater;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uKvT; attribute float aWaterY; attribute float aPhase; varying float vKvDepth;
        #ifndef USE_COLOR
        attribute vec3 color;
        #endif`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        { float w = color.r; transformed.z += 0.045 * w * w * sin( uKvT * 6.0 - position.x * 12.0 + aPhase ); }`)
      .replace("#include <project_vertex>", `#include <project_vertex>
        {
          vec4 kvW = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
          vKvDepth = aWaterY - kvW.y;
          ${depthTrick ? `vec3 C = cameraPosition;
          if ( C.y > aWaterY + 0.01 ) {
            float t = clamp( ( aWaterY - C.y ) / min( kvW.y - C.y, -1e-3 ), 0.0, 1.0 );
            vec3 S = C + ( kvW.xyz - C ) * t;
            S -= normalize( kvW.xyz - C ) * 0.02;
            vec4 cs = projectionMatrix * viewMatrix * vec4( S, 1.0 );
            gl_Position.z = cs.z / cs.w * gl_Position.w;
          }` : ""}
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uKvWaterTint; varying float vKvDepth;")
      .replace("#include <opaque_fragment>", `#include <opaque_fragment>
        { // under ~0.2-0.4 m of dark moat water at night: dimmed, blue-green, softened, never a clean white toy
          float f = smoothstep( 0.05, 0.5, vKvDepth );
          // (HDR: the moon-lit white skin is > 1 here, so attenuate multiplicatively, like light through water)
          gl_FragColor.rgb = gl_FragColor.rgb * mix( vec3( 0.3, 0.38, 0.42 ), vec3( 0.1, 0.14, 0.16 ), f ) + uKvWaterTint * 0.4;
          gl_FragColor.a = 0.78 - 0.33 * f; }`);
  };
  mat.customProgramCacheKey = () => `kvkoi${depthTrick}`;
  type Fish = { m: THREE.InstancedMesh; i: number; water: Place["koi"][number]; ph: number; speed: number; depth: number; r: number; s: number; dir: number };
  const fish: Fish[] = [];
  const group = new THREE.Group(); group.name = "katana/nature/koi";
  const variants = ["a", "b", "c", "d"];
  const per = new Map<string, THREE.InstancedMesh>();
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const total = waters.reduce((a, w) => a + w.n, 0);
  for (const v of variants) {
    const node = g.scene.getObjectByName(`koi_${v}_LOD${low ? 1 : 0}`) as THREE.Mesh | undefined;
    if (!node?.isMesh) continue;
    const geo = node.geometry.clone();
    // the kit node carries the Blender->glTF axis rotation: bake it (not its translation) so +X is forward, +Y up
    node.updateMatrixWorld(true);
    const nm = node.matrixWorld.clone(); nm.setPosition(0, 0, 0);
    geo.applyMatrix4(nm);
    geo.setAttribute("aWaterY", new THREE.InstancedBufferAttribute(new Float32Array(total), 1));
    geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(new Float32Array(total), 1));
    const im = new THREE.InstancedMesh(geo, mat, total);
    im.name = `nature/koi/${v}`; im.count = 0; im.frustumCulled = false; im.renderOrder = 5;
    im.userData.kvNoRainOcc = true;
    group.add(im); per.set(v, im);
  }
  let k = 0;
  for (const w of waters) for (let j = 0; j < w.n; j++, k++) {
    const m = per.get(variants[k % variants.length]!);
    if (!m) continue;
    const i = m.count++;
    const f: Fish = { m, i, water: w, ph: rnd() * Math.PI * 2, speed: 0.25 + rnd() * 0.25, depth: 0.18 + rnd() * 0.24, r: rnd(), s: 0.6 + rnd() * 0.2, dir: rnd() < 0.7 ? 1 : -1 };
    (m.geometry.getAttribute("aWaterY") as THREE.InstancedBufferAttribute).setX(i, w.water_y);
    (m.geometry.getAttribute("aPhase") as THREE.InstancedBufferAttribute).setX(i, f.ph * 3);
    fish.push(f);
  }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const update = (t: number) => {
    for (const f of fish) {
      const w = f.water;
      let x: number, z: number, hx: number, hz: number;
      if (w.ring) {
        const [cx, cz, r0, r1] = w.ring as [number, number, number, number];
        const rr = r0 + 0.6 + (r1 - r0 - 1.2) * (0.5 + 0.45 * Math.sin(t * 0.13 + f.ph * 2 + f.r * 5) * (0.4 + f.r * 0.6));
        const om = (f.speed / rr) * f.dir;
        const a = f.ph + om * t;
        x = cx + Math.cos(a) * rr; z = cz + Math.sin(a) * rr;
        hx = -Math.sin(a) * f.dir; hz = Math.cos(a) * f.dir;
      } else {
        const [x0, z0, x1, z1] = w.rect as [number, number, number, number];
        const ax = (x1 - x0) / 2 - 0.6, az = (z1 - z0) / 2 - 0.6, ccx = (x0 + x1) / 2, ccz = (z0 + z1) / 2;
        const sc = 0.45 + 0.5 * f.r;
        const om = f.speed / (Math.max(ax, az) * sc) * f.dir;
        const a = f.ph + om * t;
        x = ccx + Math.cos(a) * ax * sc + Math.sin(t * 0.21 + f.ph) * 0.3; z = ccz + Math.sin(a) * az * sc;
        hx = -Math.sin(a) * ax * f.dir; hz = Math.cos(a) * az * f.dir;
      }
      P.set(x, w.water_y - f.depth, z);
      // the fish faces +X: yaw it onto the heading (three rotation about +Y maps +X to (cos, 0, -sin))
      Q.setFromAxisAngle(Y, Math.atan2(-hz, hx));
      S.setScalar(f.s);
      f.m.setMatrixAt(f.i, M.compose(P, Q, S));
    }
    for (const m of per.values()) m.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { group, update };
}

/** Aerial perspective on trees: the scene's exp2 fog at k^2 x density (k 2.6 = the art kit's backdrop haze), so the
 * mountain forest layers into the moonlit mist instead of reading as a crisp black wall. */
function patchHaze(m: THREE.Material, k2 = 6.8): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace("#include <fog_fragment>",
      THREE.ShaderChunk.fog_fragment.replace("fogDensity * fogDensity", `fogDensity * fogDensity * ${k2.toFixed(2)}`));
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kvhaze${k2}`;
}

/** Ridge layers: unlit curtains (crest silhouette from noise, north high / river valley low) graded from near black to
 * the horizon haze, mist pooled in the valleys, cedar-forest strips standing on the two nearest crests. Far rings follow
 * part of the camera's offset (less parallax = farther). */
function buildBackdrop(cfg: Place["backdrop"], strip: THREE.Texture, scene: THREE.Scene) {
  const group = new THREE.Group();
  group.name = "katana/nature/backdrop";
  const fogCol = new THREE.Color("#3e5070");
  const mist = new THREE.Color("#4d6282");
  const rings: { mesh: THREE.Object3D; follow: number }[] = [];
  const [cx, cz] = cfg.centre as [number, number];
  const hash = (i: number, s: number) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
  const noise1 = (x: number, s: number) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash(i, s) * (1 - u) + hash(i + 1, s) * u; };
  cfg.rings.forEach((R, ri) => {
    const n = 480;
    const crest: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const north = (1 - Math.sin(a)) / 2; // game -z = north (the mountain)
      const base = R.h[1]! + (R.h[0]! - R.h[1]!) * Math.pow(north, 1.4);
      const u = (i / n) * 40;
      const fbm = noise1(u * 0.6, ri + 1) * 0.55 + noise1(u * 1.7, ri + 7) * 0.3 + noise1(u * 4.3, ri + 13) * 0.15;
      crest.push(base + (fbm - 0.5) * 2 * R.amp);
    }
    const pos: number[] = [], cr: number[] = [], idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, x = cx + Math.cos(a) * R.r, z = cz + Math.sin(a) * R.r;
      pos.push(x, -30, z, x, crest[i]!, z);
      cr.push(crest[i]!, crest[i]!);
      if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aCrest", new THREE.Float32BufferAttribute(cr, 1));
    g.setIndex(idx);
    const col = new THREE.Color(R.col);
    const mat = new THREE.ShaderMaterial({
      name: `kv3b_ridge${ri}`,
      uniforms: { uCol: { value: col }, uFog: { value: fogCol }, uMist: { value: mist }, uF: { value: R.fog } },
      vertexShader: `attribute float aCrest; varying float vT; varying float vY;
        void main() { vT = clamp( ( aCrest - position.y ) / max( aCrest + 30.0, 1.0 ), 0.0, 1.0 ); vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: `uniform vec3 uCol, uFog, uMist; uniform float uF; varying float vT; varying float vY;
        void main() {
          vec3 c = mix( uCol, uFog, uF );
          // mist pools low in the valleys and thins toward the crest
          float m = smoothstep( 0.18, 0.95, vT ) * ( 0.35 + 0.5 * ( 1.0 - uF ) );
          c = mix( c, uMist, m );
          gl_FragColor = vec4( c, 1.0 );
          #include <colorspace_fragment>
        }`,
      depthWrite: true, fog: false,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `katana/nature/ridge-${ri}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = -10 + ri;
    mesh.userData.kvNoRainOcc = true;
    mesh.userData.qaIgnore = true;
    const holder = new THREE.Group();
    holder.add(mesh);
    if (R.forest > 0) {
      // cedar strip on the crest: 40 m x 20 m texture scaled by R.forest; its trunk line is buried 0.25 of its height
      const W = 40 * R.forest, H = 20 * R.forest;
      const fp: number[] = [], fu: number[] = [], fi: number[] = [];
      let arc = 0;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2, x = cx + Math.cos(a) * (R.r - 2), z = cz + Math.sin(a) * (R.r - 2);
        if (i) arc += (2 * Math.PI * R.r) / n;
        const y0 = crest[i]! - H * 0.42;
        fp.push(x, y0, z, x, y0 + H, z);
        fu.push(arc / W, 1, arc / W, 0);
        if (i < n) { const k = i * 2; fi.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute("position", new THREE.Float32BufferAttribute(fp, 3));
      fg.setAttribute("uv", new THREE.Float32BufferAttribute(fu, 2));
      fg.setIndex(fi);
      const fm = new THREE.ShaderMaterial({
        name: `kv3b_forest${ri}`,
        uniforms: { tMap: { value: strip }, uCol: { value: col }, uFog: { value: fogCol }, uF: { value: R.fog * 0.85 } },
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
        fragmentShader: `uniform sampler2D tMap; uniform vec3 uCol, uFog; uniform float uF; varying vec2 vUv;
          void main() {
            vec4 t = texture2D( tMap, vUv );
            if ( t.a < 0.5 ) discard;
            // unlit albedo -> moonlit night value, then into the layer's haze
            vec3 c = mix( t.rgb * vec3( 0.42, 0.5, 0.62 ), uCol, 0.35 );
            c = mix( c, uFog, uF );
            gl_FragColor = vec4( c, 1.0 );
            #include <colorspace_fragment>
          }`,
        side: THREE.DoubleSide, fog: false,
      });
      const fmesh = new THREE.Mesh(fg, fm);
      fmesh.name = `katana/nature/ridge-forest-${ri}`;
      fmesh.frustumCulled = false;
      fmesh.renderOrder = -10 + ri;
      fmesh.userData.kvNoRainOcc = true;
      holder.add(fmesh);
    }
    group.add(holder);
    rings.push({ mesh: holder, follow: R.follow });
  });
  void scene;
  const p = new THREE.Vector3();
  return {
    group,
    update: (cam: THREE.Camera) => {
      cam.getWorldPosition(p);
      for (const r of rings) r.mesh.position.set((p.x - cx) * r.follow, 0, (p.z - cz) * r.follow);
    },
  };
}

// ------------------------------------------------------------------------------------------------ build
export async function buildKatanaNature(o: {
  scene: THREE.Scene; renderer: THREE.WebGLRenderer; lib: V3Library; rig: WetnessRig; low: boolean;
}): Promise<KatanaNature> {
  const { scene, renderer, lib, rig, low } = o;
  const root = new THREE.Group();
  root.name = "katana/nature";
  scene.add(root);
  const q = new URLSearchParams(location.search);
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), low ? 4 : 8);
  const tex = texLoader(BASE, low, aniso);
  const loader = new GLTFLoader(sameOriginManager()).setMeshoptDecoder(MeshoptDecoder);
  const [place, rocksG, toroG, treesG, confG] = await Promise.all([
    fetch(assetUrl(`${BASE}/place.json`)).then((r) => r.json() as Promise<Place>),
    loader.loadAsync(assetUrl(`${BASE}/rocks.glb`)),
    loader.loadAsync(assetUrl(`${BASE}/toro.glb`)),
    loader.loadAsync(assetUrl(`${BASE}/trees.glb`)),
    // [integrator] scans conformed to their <= 5-box colliders (scripts/katana-v3/art/rock_conform.mjs), world space
    loader.loadAsync(assetUrl("/assets/katana/v3/art/rocks_conf.glb")).catch(() => null),
  ]);
  const materials: THREE.Material[] = [];
  const mossTex = lib.textures.get(lib.manifest.sets.moss!.files[low ? "c-low" : "c"]!)!;

  const rockMat = new Map<string, THREE.MeshStandardMaterial>();
  const rockMaterial = (set: string, hero: boolean): THREE.MeshStandardMaterial => {
    const k = `${set}|${hero}`;
    let m = rockMat.get(k);
    if (m) return m;
    const orm = tex.get(`${set}_ormh`, false);
    m = new THREE.MeshStandardMaterial({
      name: `kv3r_${set}`, map: tex.get(`${set}_c`, true), normalMap: tex.get(`${set}_n`, false),
      roughnessMap: orm, aoMap: orm, roughness: 1, metalness: 0,
    });
    m.normalScale.setScalar(1.35);
    // granite: wet darkens it moderately and leaves a satin film (glints on the relief), not black glass
    patchWetness(m, { porosity: 0.32, wetRough: 0.3 }, rig);
    patchMoss(m, mossTex, hero ? 0.85 : 0.75);
    rockMat.set(k, m);
    materials.push(m);
    return m;
  };
  const partsOf = (g: THREE.Object3D, node: string, matFor: (name: string) => THREE.Material): Part[] => {
    const n = g.getObjectByName(node);
    if (!n) return [];
    const out: Part[] = [];
    n.updateMatrixWorld(true);
    n.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry.clone();
      // node transforms relative to the asset origin are baked into the geometry
      if (mesh !== n) geo.applyMatrix4(new THREE.Matrix4().copy(n.matrixWorld).invert().multiply(mesh.matrixWorld));
      out.push({ geo, mat: matFor((mesh.material as THREE.Material).name) });
    });
    return out;
  };

  // ---------------------------------------------------------------- rocks
  const sets: Instanced[] = [];
  const byKey = new Map<string, Instanced>();
  for (const r of place.rocks) {
    const s = Array.isArray(r.scale) ? r.scale : [r.scale, r.scale, r.scale];
    if (confG?.scene.getObjectByName(`rockc_${r.id}_LOD0`)) {
      const lods = [0, 1, 2].map((i) => {
        const node = confG.scene.getObjectByName(`rockc_${r.id}_LOD${i}`);
        node?.updateWorldMatrix(true, false);
        // world-space geometry; the node only carries the dequantization transform (meshopt quantized): bake it in
        return partsOf(confG.scene, `rockc_${r.id}_LOD${i}`, (name) => rockMaterial(name.replace(/^kv3r_/, ""), !!r.hero)).map((p) => {
          // quantized (normalized int16) attributes cannot hold world coordinates: widen to float first
          for (const name of ["position", "normal"]) {
            const a = p.geo.getAttribute(name) as THREE.BufferAttribute | undefined;
            if (!a || a.array instanceof Float32Array) continue;
            const f = new Float32Array(a.count * a.itemSize);
            for (let k = 0; k < a.count; k++) for (let c = 0; c < a.itemSize; c++) f[k * a.itemSize + c] = a.getComponent(k, c);
            p.geo.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
          }
          if (node) p.geo.applyMatrix4(node.matrixWorld);
          return p;
        });
      });
      const inst = new Instanced(`rockc-${r.id}`, lods, [26, 60], 1, root);
      inst.add(new THREE.Matrix4(), Math.max(s[0]!, s[2]!) * 1.2, new THREE.Vector3(...(r.pos as [number, number, number])));
      sets.push(inst);
      continue;
    }
    const key = `${r.v}|${!!r.hero}`;
    let inst = byKey.get(key);
    if (!inst) {
      const lods = [0, 1, 2].map((i) => partsOf(rocksG.scene, `rock_${r.v}_LOD${i}`, (name) => rockMaterial(name.replace(/^kv3r_/, ""), !!r.hero)));
      inst = new Instanced(`rock-${r.v}`, lods, [26, 60], place.rocks.length, root);
      byKey.set(key, inst);
      sets.push(inst);
    }
    inst.add(xform(r), Math.max(s[0]!, s[2]!) * 1.2);
  }

  // ---------------------------------------------------------------- toro + cut stones (chamfered granite)
  const granite = lib.material("granite_flag", { name: "kv3t_granite", tint: "#b4b6b9", tile: 1.4, wet: { porosity: 0.25, wetRough: 0.3 } }); // [integrator r3] lighter: the cut stones read as black boxes at market-wall / moat
  granite.normalScale.setScalar(1.4);
  patchMoss(granite, mossTex, 0.55);
  const paper = new THREE.MeshStandardMaterial({ name: "kv3t_paper", color: 0x3a0508, emissive: new THREE.Color("#E8141F"), emissiveIntensity: 2.4, roughness: 0.8 });
  materials.push(granite);
  const kitMat = (name: string): THREE.Material => (/paper/.test(name) ? paper : granite);
  const kitSet = (asset: string, nLod: number, dists: number[], items: (Xform & { asset: string })[], r: number) => {
    const mine = items.filter((it) => it.asset === asset);
    if (!mine.length) return;
    const lods = Array.from({ length: nLod }, (_, i) => partsOf(toroG.scene, `${asset}_LOD${i}`, kitMat)).filter((l) => l.length);
    // [integrator r3] the paper windows sat in the granite window planes (z-fight): set them 12 % in toward the axis
    for (const l of lods) for (const p of l) if (p.mat === paper) p.geo.scale(0.88, 1, 0.88);
    const inst = new Instanced(asset, lods, dists, mine.length, root);
    for (const it of mine) inst.add(xform(it), r);
    sets.push(inst);
  };
  kitSet("toro_kasuga", 3, [22, 55], place.toro_inst ?? [], 0.6);
  kitSet("stone_cut", 2, [30], place.stones ?? [], 0.8);
  kitSet("stone_slab", 2, [35], place.stones ?? [], 1.6);

  // ---------------------------------------------------------------- trees (wind sway, needle cards with alpha-to-coverage)
  const uTime = { value: 0 };
  const bark = (set: string) => {
    const orm = tex.get(`${set}_ormh`, false);
    const rep = (t: THREE.Texture) => { const c = t.clone(); c.repeat.set(1 / 1.5, 1 / 1.5); c.needsUpdate = true; return c; };
    const m = new THREE.MeshStandardMaterial({ name: `kv3f_${set}`, map: rep(tex.get(`${set}_c`, true)), normalMap: rep(tex.get(`${set}_n`, false)),
      roughnessMap: rep(orm), aoMap: rep(orm), roughness: 1, metalness: 0 });
    m.normalScale.setScalar(1.5);
    patchWetness(m, { porosity: 0.45, wetRough: 0.32, streaks: true }, rig);
    patchWind(m, uTime, 0);
    materials.push(m);
    return m;
  };
  const barkPine = bark("bark_pine"), barkSugi = bark("bark_sugi");
  const foliage = new THREE.MeshStandardMaterial({ name: "kv3f_foliage", map: tex.get("foliage_c", true, false), roughness: 0.82, metalness: 0,
    alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
  // needles stay matte when wet (a glossy film on cards reads as snow-dusted foliage under the moon)
  patchWetness(foliage, { porosity: 0.15, wetRough: 0.8 }, rig, { cutout: true });
  foliage.envMapIntensity = 0.3;
  patchWind(foliage, uTime, 1);
  patchFoliage(foliage);
  const impostor = new THREE.MeshStandardMaterial({ name: "kv3f_impostor", map: tex.get("sugi_impostor_c", true, false), roughness: 0.9, metalness: 0,
    alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
  patchFoliage(impostor);
  impostor.envMapIntensity = 0.3;
  materials.push(foliage, impostor);
  for (const m of [barkPine, barkSugi, foliage, impostor]) patchHaze(m, 11);
  const treeMat = (name: string): THREE.Material =>
    /impostor/.test(name) ? impostor : /foliage/.test(name) ? foliage : /bark_sugi/.test(name) ? barkSugi : barkPine;
  const treeSet = (asset: string, dists: number[], items: THREE.Matrix4[], r: number, shadow = true) => {
    if (!items.length) return;
    const lods = [0, 1, 2].map((i) => partsOf(treesG.scene, `${asset}_LOD${i}`, treeMat)).filter((l) => l.length);
    const inst = new Instanced(asset, lods, dists, items.length, root, shadow);
    for (const m of items) inst.add(m, r);
    sets.push(inst);
  };
  const ti = place.tree_inst ?? [];
  const forestM = (place.forest ?? []).filter((f) => !f[5]).map(([x, y, z, yaw, sc]) => xform({ pos: [x!, y!, z!], yaw: yaw!, scale: sc! }));
  const forestPines = (place.forest ?? []).filter((f) => f[5] === 1).map(([x, y, z, yaw, sc]) => xform({ pos: [x!, y!, z!], yaw: yaw!, scale: sc! }));
  treeSet("pine_niwaki", [32, 80], ti.filter((t) => t.asset === "pine_niwaki").map(xform), 3);
  {
    const ang = (m: THREE.Matrix4) => { const v = new THREE.Vector3().setFromMatrixPosition(m); return Math.atan2(v.z - 4, v.x); };
    const sorted = [...forestPines].sort((a, b) => ang(a) - ang(b)), n = Math.ceil(sorted.length / 5);
    // 5 angular sectors; mountain trees cast no moon shadow (the shadow map covers the playable map, not the slopes)
    for (let k = 0; k < 5; k++) treeSet("pine_niwaki", [30, 70], sorted.slice(k * n, (k + 1) * n), 7, false);
  }
  treeSet("sugi_sacred", [45, 130], ti.filter((t) => t.asset === "sugi_sacred").map(xform), 6);
  // the rim + mountain cedars in 10 angular sectors: each sector's LOD buckets get a tight culling sphere
  treeSet("sugi_edge", [38, 85], ti.filter((t) => t.asset === "sugi_edge").map(xform), 4); // the rim line: shadows on
  const SECT = 10, bySect: THREE.Matrix4[][] = Array.from({ length: SECT }, () => []);
  const tp = new THREE.Vector3();
  for (const m of forestM) { tp.setFromMatrixPosition(m); const a = Math.atan2(tp.z - 4, tp.x) + Math.PI; bySect[Math.min(SECT - 1, Math.floor(a / (2 * Math.PI) * SECT))]!.push(m); }
  for (const g of bySect) treeSet("sugi_edge", [28, 60], g, 4, false);

  // ---------------------------------------------------------------- koi under the water (own layer, see buildKoi)
  const koi = q.get("kvkoi") === "0" ? null : await buildKoi(place.koi ?? [], loader, uTime, low);
  if (koi) root.add(koi.group);

  // ---------------------------------------------------------------- backdrop: fogged ridge layers + cedar strips
  const backdrop = buildBackdrop(place.backdrop, tex.get("forest_strip_c", true, true), scene);
  root.add(backdrop.group);
  const oldRings = scene.getObjectByName("katana/mountains");
  if (oldRings) oldRings.visible = false;

  await tex.ready();
  const cam = new THREE.Vector3();
  let t = 0, lodT = 1;
  for (const s of sets) s.update(cam, 1, 0);
  const lodBias = Number(q.get("kvnlod") ?? 1);
  return {
    root,
    materials,
    update: (dt, camera) => {
      t += dt;
      uTime.value = t;
      lodT += dt;
      backdrop.update(camera);
      koi?.update(t);
      if (lodT > 0.25) {
        lodT = 0;
        camera.getWorldPosition(cam);
        for (const s of sets) s.update(cam, lodBias);
      }
    },
    stats: () => ({ rocks: place.rocks.length, sets: sets.length, trees: ti.length + forestM.length + forestPines.length }),
  };
}
