import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { specularAA } from "./specular-aa";
import { assetUrl } from "./asset-base";
import { pmremEnv, rendererMaxAnisotropy, gpuCapabilities, type AnyRenderer } from "./gpu-backend";
import { armTextureClone } from "./textures";
import type { WorldApi } from "./world";

/**
 * ARES RELAY — "Mars-lit orbital".
 *
 * The station is built offline (scripts/ares/blender/build_station.py) from the
 * authoritative collision set, so every visible face that a body or a bullet
 * can touch sits on its collider. That build bakes ambient occlusion into a
 * second UV set; this module owns all shading: CC0 PBR sets tiled in world
 * metres (UV0), the baked AO (UV1), a hard sun with real shadows, and an
 * image-based fill rendered from the actual sky — so the faces that look at
 * Mars pick up its rust light and the faces that look at space go cold.
 *
 * Restraint is the brief: no bloom, no fog glow, emissives sized like real
 * practical fixtures. The spectacle is the planet and the light.
 */

const A = (p: string) => assetUrl(`/assets/ares/${p}`);

/** Sun: from the south, 40 degrees up — neither team stares into it. */
export const ARES_SUN_DIR = new THREE.Vector3(0.18, 0.64, 0.75).normalize();
/** Mars: huge and low in the north-west, seen through the observatory glass. */
const MARS_DIR = new THREE.Vector3(-0.32, 0.05, -0.95).normalize();
const SKY_R = 380;
/** Artistic trim on the baked bounce (1 = physically matched to the sun). */
const GI_GAIN = 1.0;
const MARS_R = 230;

type Kind = "c" | "n" | "rm";
const texCache = new Map<string, THREE.Texture>();

function loadTex(loader: THREE.TextureLoader, set: string, kind: Kind, aniso: number): THREE.Texture {
  const key = `${set}_${kind}`;
  let t = texCache.get(key);
  if (!t) {
    t = loader.load(A(`tex/${key}.webp`));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    if (kind === "c") t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(key, t);
  }
  return t;
}

type MatSpec = {
  set?: string;
  /** World metres covered by one texture repeat. */
  tile?: number;
  color: number;
  /** Multiply the set's colour map (true) or use flat colour with its normal/roughness only. */
  useColor?: boolean;
  rough?: number;
  metal?: number;
  normal?: number;
  emissive?: number;
  emissiveIntensity?: number;
  env?: number;
  paint?: boolean;
};

/** Materials whose normal map is fine enough to alias into crawling glints. */
const FINE_NORMALS = new Set(["grate", "tread", "foil"]);

/** The palette. Warm ceramic, graphite, gold foil, aerospace orange, muted team livery. */
const SPECS: Record<string, MatSpec> = {
  hull: { set: "hull", tile: 1.6, color: 0xcbc6bc, rough: 1, metal: 0, normal: 0.6 },
  hullAlt: { set: "hull", tile: 1.6, color: 0xaeaaa3, rough: 1, metal: 0, normal: 0.6 },
  graphite: { set: "graphite", tile: 1.4, color: 0x9aa1a8, useColor: true, rough: 1, metal: 0.35, normal: 0.8 },
  steel: { set: "steel", tile: 0.9, color: 0xc9cdd1, useColor: true, rough: 0.8, metal: 1, normal: 0.6 },
  foil: { set: "foil", tile: 0.8, color: 0xd9a54a, rough: 0.9, metal: 1, normal: 1.4, env: 1.3 },
  orange: { set: "paint", tile: 1.2, color: 0xc85a26, rough: 1, metal: 0, normal: 0.5, paint: true },
  teal: { set: "paint", tile: 1.2, color: 0x2c8c88, rough: 1, metal: 0, normal: 0.5, paint: true },
  coral: { set: "paint", tile: 1.2, color: 0xc0563f, rough: 1, metal: 0, normal: 0.5, paint: true },
  floor: { set: "floor", tile: 2.0, color: 0x646a71, useColor: true, rough: 1, metal: 0.15, normal: 0.7 },
  floorAlt: { set: "floor", tile: 2.0, color: 0x4a5057, useColor: true, rough: 1, metal: 0.15, normal: 0.7 },
  tread: { set: "tread", tile: 0.9, color: 0xa6acb2, useColor: true, rough: 1, metal: 0.45, normal: 1.0 },
  grate: { set: "grate", tile: 0.45, color: 0x7d858c, useColor: true, rough: 1, metal: 0.4, normal: 1.2 },
  seam: { color: 0x101316, rough: 0.9, metal: 0.2 },
  solar: { set: "solar", tile: 1.6, color: 0xffffff, useColor: true, rough: 0.35, metal: 0.6, normal: 0.8, env: 1.4 },
  rubber: { set: "rubber", tile: 0.6, color: 0x1d1f21, rough: 1, metal: 0, normal: 0.6 },
  copper: { set: "steel", tile: 0.6, color: 0xc4774a, rough: 0.55, metal: 1, normal: 0.6 },
  lightCool: { color: 0x0b0d0f, emissive: 0xcfe8ef, emissiveIntensity: 2.2, rough: 0.4, metal: 0 },
  lightWarm: { color: 0x0b0d0f, emissive: 0xffd6a3, emissiveIntensity: 2.4, rough: 0.4, metal: 0 },
};

function makeStd(spec: MatSpec, loader: THREE.TextureLoader, aniso: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: spec.rough ?? 0.6,
    metalness: spec.metal ?? 0,
  });
  if (spec.set) {
    const rep = 1 / (spec.tile ?? 1);
    const set = (t: THREE.Texture) => {
      const c = t.clone();
      c.repeat.set(rep, rep);
      // needsUpdate only on image arrival (armTextureClone): an immediate bump +
      // a not-yet-loaded/404 image = TypeError on WebGPU (image.complete
      // of null); with no bump at all the clone would stay on the default texture forever.
      armTextureClone(c);
      return c;
    };
    if (spec.useColor) m.map = set(loadTex(loader, spec.set, "c", aniso));
    m.normalMap = set(loadTex(loader, spec.set, "n", aniso));
    m.normalScale.setScalar(spec.normal ?? 1);
    const rm = set(loadTex(loader, spec.set, "rm", aniso));
    m.roughnessMap = rm;
    m.metalnessMap = (spec.metal ?? 0) > 0 ? rm : null;
  }
  if (spec.emissive !== undefined) {
    m.emissive.setHex(spec.emissive);
    m.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  m.envMapIntensity = spec.env ?? 1;
  if (spec.paint) {
    // Deck paint sits millimetres proud of the plates: bias it toward the
    // camera so it can never fight the plate under it at range.
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  return m;
}

// ------------------------------------------------------------ screens

/** Abstract instrument UI, tiled in world metres. No words to cut in half. */
function screenTexture(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#081016";
  g.fillRect(0, 0, s, s);
  let seed = 7;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.strokeStyle = "rgba(120,190,200,0.16)";
  g.lineWidth = 1;
  for (let i = 0; i <= s; i += 32) {
    g.beginPath(); g.moveTo(i + 0.5, 0); g.lineTo(i + 0.5, s); g.stroke();
    g.beginPath(); g.moveTo(0, i + 0.5); g.lineTo(s, i + 0.5); g.stroke();
  }
  // traces
  for (let k = 0; k < 3; k++) {
    g.strokeStyle = k === 0 ? "rgba(236,180,110,0.9)" : "rgba(150,220,226,0.75)";
    g.lineWidth = 2;
    g.beginPath();
    const y0 = 90 + k * 140;
    for (let x = 16; x < s - 16; x += 4) {
      const y = y0 + Math.sin(x * 0.03 + k * 2) * 18 + (r() - 0.5) * 8;
      if (x === 16) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // bars and readout blocks
  for (let i = 0; i < 14; i++) {
    const h = 10 + r() * 60;
    g.fillStyle = i % 5 === 0 ? "rgba(236,170,100,0.85)" : "rgba(140,210,220,0.6)";
    g.fillRect(24 + i * 18, s - 30 - h, 10, h);
  }
  g.fillStyle = "rgba(200,230,232,0.55)";
  for (let i = 0; i < 9; i++) g.fillRect(300, 300 + i * 18, 80 + r() * 110, 5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 1.4, 1 / 1.4);
  return t;
}

// ------------------------------------------------------------ the reactor core

// WebGPU: custom GLSL has no node mapping ("not compatible" + empty
// fallback). So core/sky/Mars/shell run on built-ins there
// (plausible look, zero errors); the full procedural splendour follows step
// by step via TSL ports. WebGL: unchanged GLSL.
const useTsl = (): boolean => gpuCapabilities().active === "webgpu";

/** TSL module (WebGPU only): handed in before the world is built. */
type TslMod = typeof import("./tsl-materials");
let tslMod: TslMod | null = null;
export function setAresTsl(m: TslMod | null): void {
  tslMod = m;
}

function coreMaterial(): THREE.Material {
  if (useTsl() && tslMod) {
    const made = tslMod.tslAresCore();
    // Keep the time handle: ares-world ticks it once per frame, and a node
    // material has no `.uniforms` of its own (dropping it froze the reactor).
    (made.material as unknown as { uniforms: unknown }).uniforms = made.uniforms;
    return made.material;
  }
  if (useTsl()) {
    return new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.85, 0.42) });
  }
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main(){ vec4 w = modelMatrix*vec4(position,1.); vP = w.xyz; vN = normalize(mat3(modelMatrix)*normal);
      vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `precision highp float; uniform float uTime; varying vec3 vP; varying vec3 vN; varying vec3 vV;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){
        float a = atan(vP.z, vP.x);
        float y = vP.y;
        float flow = n(vec2(a*3.0, y*1.6 - uTime*0.9))*0.6 + n(vec2(a*7.0, y*3.2 - uTime*1.7))*0.4;
        float band = smoothstep(0.35, 1.0, flow);
        float facing = pow(max(dot(normalize(vN), normalize(vV)), 0.0), 0.6);
        vec3 hot = vec3(1.0, 0.86, 0.66);
        vec3 deep = vec3(0.95, 0.42, 0.16);
        vec3 col = mix(deep, hot, band*0.8 + facing*0.35) * (1.25 + band*0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ------------------------------------------------------------ sky

const STAR_FRAG = `precision highp float;
  uniform sampler2D uMilky; uniform float uMilkyGain;
  varying vec3 vDir;
  float hash(vec3 p){ p = fract(p*0.3183099 + vec3(0.71,0.113,0.419)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  vec3 stars(vec3 d){
    // three octaves of crisp point stars: a hashed cell, one star per lucky cell
    vec3 col = vec3(0.0);
    for (int o = 0; o < 3; o++) {
      float sc = o == 0 ? 160.0 : o == 1 ? 340.0 : 700.0;
      vec3 p = d * sc;
      vec3 c = floor(p);
      float r = hash(c);
      float th = o == 0 ? 0.993 : o == 1 ? 0.988 : 0.982;
      if (r > th) {
        vec3 sp = c + 0.5 + (vec3(hash(c+1.3), hash(c+2.7), hash(c+4.1)) - 0.5) * 0.6;
        float dist = length(p - sp);
        float b = smoothstep(0.55, 0.0, dist) * pow((r - th) / (1.0 - th), 1.6);
        float t = hash(c + 9.0);
        vec3 tint = mix(vec3(0.75,0.82,1.0), vec3(1.0,0.86,0.7), t);
        col += tint * b * (o == 0 ? 1.8 : o == 1 ? 0.8 : 0.4);
      }
    }
    return col;
  }
  void main(){
    vec3 d = normalize(vDir);
    vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y,-1.,1.)) / 3.14159265 + 0.5);
    vec3 milky = texture2D(uMilky, uv).rgb;
    milky = pow(milky, vec3(1.35)) * uMilkyGain;
    vec3 col = milky + stars(d);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function skyDome(milky: THREE.Texture, gain: number): THREE.Mesh {
  if (useTsl() && tslMod) {
    const made = tslMod.tslAresSky(milky, gain);
    const m = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 64, 32), made.material);
    // The PMREM env bake dims the dome via uniforms.uGain (see the traversal).
    (m.material as unknown as { uniforms: unknown }).uniforms = made.uniforms;
    m.renderOrder = -100;
    m.frustumCulled = false;
    m.name = "ares/sky";
    m.userData.qaIgnore = true;
    return m;
  }
  if (useTsl()) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_R, 64, 32),
      new THREE.MeshBasicMaterial({ map: milky, side: THREE.BackSide, depthWrite: false, depthTest: false }),
    );
    m.material.color.setScalar(Math.min(1, gain));
    m.renderOrder = -100;
    m.frustumCulled = false;
    m.name = "ares/sky";
    m.userData.qaIgnore = true;
    return m;
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMilky: { value: milky }, uMilkyGain: { value: gain } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position = p.xyww; }`,
    fragmentShader: STAR_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 64, 32), mat);
  m.renderOrder = -100;
  m.frustumCulled = false;
  m.name = "ares/sky";
  m.userData.qaIgnore = true;
  return m;
}

function marsMaterial(albedo: THREE.Texture, sunDir: THREE.Vector3): THREE.Material {
  if (useTsl() && tslMod) {
    return tslMod.tslAresMars(albedo, sunDir).material;
  }
  if (useTsl()) {
    return new THREE.MeshStandardMaterial({ map: albedo, roughness: 1, metalness: 0 });
  }
  return new THREE.ShaderMaterial({
    uniforms: { uAlb: { value: albedo }, uSun: { value: sunDir.clone() }, uGain: { value: 1 } },
    vertexShader: `varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      void main(){ vUv = uv; vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz;
      gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `precision highp float; uniform sampler2D uAlb; uniform vec3 uSun; uniform float uGain; varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        vec3 alb = texture2D(uAlb, vUv).rgb;
        alb = pow(alb, vec3(1.15)) * vec3(1.06, 0.95, 0.88);
        float ndl = dot(N, uSun);
        // soft terminator: Mars' thin atmosphere still scatters a little past it
        float lit = smoothstep(-0.08, 0.35, ndl);
        vec3 col = alb * (lit * 1.55 + 0.012);
        // limb haze: dusty, butterscotch on the day side, thin blue at the edge
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        vec3 haze = mix(vec3(0.86, 0.55, 0.34), vec3(0.62, 0.72, 0.86), pow(fres, 2.0));
        col = mix(col, haze * smoothstep(-0.2, 0.4, ndl) * 1.1, fres * 0.75);
        // uGain < 1 in the lighting environment: Mars warms the station's fill
        // without turning white suits peach (the visible sky keeps full colour)
        col = mix(vec3(dot(col, vec3(0.3, 0.55, 0.15))), col, mix(0.35, 1.0, uGain)) * uGain;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    depthWrite: false,
  });
}

function atmosphereShell(sunDir: THREE.Vector3): THREE.Mesh {
  if (useTsl() && tslMod) {
    return new THREE.Mesh(
      new THREE.SphereGeometry(MARS_R * 1.025, 96, 64),
      tslMod.tslAresShell(sunDir).material,
    );
  }
  if (useTsl()) {
    void sunDir;
    return new THREE.Mesh(
      new THREE.SphereGeometry(MARS_R * 1.025, 96, 64),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.55, 0.42, 0.34),
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sunDir.clone() } },
    vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `precision highp float; uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
      void main(){
        vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - abs(dot(N, V)), 5.0);
        float day = smoothstep(-0.25, 0.3, dot(N, uSun));
        vec3 c = mix(vec3(0.95, 0.62, 0.42), vec3(0.55, 0.68, 0.95), rim);
        gl_FragColor = vec4(c * rim * day * 0.9, rim * day * 0.9);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(MARS_R * 1.025, 96, 64), mat);
}

function sunDisc(): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, "rgba(255,252,244,1)");
  gr.addColorStop(0.07, "rgba(255,248,236,1)");
  gr.addColorStop(0.1, "rgba(255,236,210,0.35)");
  gr.addColorStop(0.3, "rgba(255,220,180,0.06)");
  gr.addColorStop(1, "rgba(255,220,180,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(70);
  s.position.copy(ARES_SUN_DIR).multiplyScalar(SKY_R * 0.92);
  s.name = "ares/sun";
  s.renderOrder = -90;
  return s;
}

function buildSky(milky: THREE.Texture, mars: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  g.name = "ares/sky-group";
  g.userData.qaIgnore = true;
  g.add(skyDome(milky, 0.75));
  const planet = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(MARS_R, 128, 96), marsMaterial(mars, ARES_SUN_DIR));
  body.rotation.set(0.35, 2.4, 0.12); // a pleasing face: Valles Marineris across the day side
  planet.add(body, atmosphereShell(ARES_SUN_DIR));
  // Centre 370 m out and 23 degrees below the horizon: asin(230/370) puts the
  // limb ~15 degrees up, so the planet fills the north sky above the glass.
  const D = 370, el = THREE.MathUtils.degToRad(-23);
  const h = new THREE.Vector3(MARS_DIR.x, 0, MARS_DIR.z).normalize();
  planet.position.copy(h).multiplyScalar(Math.cos(el) * D).setY(Math.sin(el) * D);
  // Order the MESHES, never the group: a Group's renderOrder outranks its
  // children's, which drew the planet before the star dome painted over it.
  for (const o of planet.children) o.renderOrder = -80;
  g.add(planet);
  g.add(sunDisc());
  return g;
}

// ------------------------------------------------------------ build

export async function buildAresWorld(renderer: AnyRenderer): Promise<WorldApi> {
  const scene = new THREE.Scene();
  scene.name = "ARES RELAY";
  scene.background = new THREE.Color(0x000000);
  const aniso = rendererMaxAnisotropy(renderer);
  const loader = new THREE.TextureLoader();
  const loadAsync = (p: string, srgb = false) =>
    loader.loadAsync(A(p)).then((t) => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = aniso;
      return t;
    });

  const gltfLoader = new GLTFLoader();
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, milky, mars, aoFloor, aoStation, aoVault, aoExterior] = await Promise.all([
    gltfLoader.loadAsync(A("station.glb")),
    loadAsync("milkyway.webp", true),
    loadAsync("mars.webp", true),
    loadAsync("ao_floor.webp"),
    loadAsync("ao_station.webp"),
    loadAsync("ao_vault.webp"),
    loadAsync("ao_exterior.webp"),
  ]);
  mars.anisotropy = aniso;
  const ao: Record<string, THREE.Texture> = { floor: aoFloor, station: aoStation, vault: aoVault, exterior: aoExterior };
  for (const t of Object.values(ao)) {
    t.channel = 1;
    t.flipY = false;
  }
  // Baked bounce light (scripts/ares/blender/build_station.py --gi): irradiance
  // stored sRGB-encoded over a per-atlas scale. Optional: without it the
  // hemisphere + IBL fill below stands in.
  const gi: Record<string, { tex: THREE.Texture; scale: number }> = {};
  try {
    const meta = (await fetch(A("gi.json")).then((r) => (r.ok ? r.json() : {}))) as Record<string, { scale: number }>;
    await Promise.all(Object.entries(meta).map(async ([obj, m]) => {
      const t = await loadAsync(`gi_${obj}.webp`, true);
      t.channel = 1;
      t.flipY = false;
      gi[obj] = { tex: t, scale: m.scale };
    }));
  } catch {
    /* no GI shipped */
  }
  const hasGi = Object.keys(gi).length > 0;

  const sky = buildSky(milky, mars);
  scene.add(sky);

  // ---------------------------------------------------------- materials
  const base: Record<string, THREE.Material> = {};
  for (const [k, spec] of Object.entries(SPECS)) base[k] = makeStd(spec, loader, aniso);
  const screen = new THREE.MeshStandardMaterial({ color: 0x050708, roughness: 0.25, metalness: 0.1, emissiveMap: screenTexture(), emissive: 0xffffff, emissiveIntensity: 1.25 });
  base.screen = screen;
  const glass = new THREE.MeshStandardMaterial({ color: 0x8fa9b3, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.1, depthWrite: false, envMapIntensity: 2.2, side: THREE.DoubleSide });
  base.glass = glass;
  const core = coreMaterial() as THREE.Material & { uniforms?: { uTime?: { value: number } } };
  base.core = core;

  const perObject = new Map<string, THREE.Material>();
  const matFor = (name: string, obj: string): THREE.Material => {
    const key = `${obj}/${name}`;
    let m = perObject.get(key);
    if (m) return m;
    const src = base[name] ?? base.hull!;
    if (src instanceof THREE.MeshStandardMaterial && name !== "glass" && ao[obj]) {
      const c = src.clone();
      c.aoMap = ao[obj]!;
      c.aoMapIntensity = obj === "floor" ? 1.0 : 0.9;
      const g = gi[obj];
      if (g) {
        c.lightMap = g.tex;
        c.lightMapIntensity = g.scale * GI_GAIN;
        // the lightmap carries the diffuse fill now; IBL stays for reflections
        c.envMapIntensity = (src.envMapIntensity ?? 1) * 0.55;
      }
      m = c;
    } else m = src;
    perObject.set(key, m);
    return m;
  };

  const root = new THREE.Group();
  root.name = "ares/station";
  scene.add(root);
  const station = gltf.scene;
  station.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let obj = "station";
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
      if (["floor", "station", "vault", "exterior"].includes(p.name)) { obj = p.name; break; }
    }
    const name = (mesh.material as THREE.Material).name || "hull";
    mesh.material = matFor(name, obj);
    // ZERO-FLICKER: fine normal maps glint-crawl at range (specular-aa.ts)
    if (FINE_NORMALS.has(name) && mesh.material instanceof THREE.MeshStandardMaterial) specularAA(mesh.material);
    const emissive = name.startsWith("light") || name === "screen" || name === "core";
    mesh.castShadow = !emissive && name !== "glass" && obj !== "floor";
    mesh.receiveShadow = name !== "glass" && !emissive;
    if (name === "glass") mesh.renderOrder = 10;
    mesh.name = `ares/${obj}/${name}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  });
  station.updateMatrixWorld(true);
  root.add(station);

  // ---------------------------------------------------------- light
  const sun = new THREE.DirectionalLight(0xfff7ef, 3.3);
  sun.position.copy(ARES_SUN_DIR).multiplyScalar(80);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -48; sc.right = 48; sc.top = 44; sc.bottom = -44; sc.near = 20; sc.far = 160;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 1.5;
  scene.add(sun, sun.target);
  // Mars bounce: a broad warm fill from the planet's direction, no shadows.
  const marsFill = new THREE.DirectionalLight(0xd9ab8f, 0.12);
  marsFill.position.copy(MARS_DIR).multiplyScalar(60).setY(8);
  scene.add(marsFill);
  // Space is black, but the station's own interior light is not: a dim cool
  // ambient keeps shadow sides readable for target acquisition.
  const hemi = new THREE.HemisphereLight(0xb4c0cc, 0x5d5a57, hasGi ? 0.5 : 0.85);
  scene.add(hemi);

  // Image-based light from the real sky: Mars, the sun, the stars, plus a
  // soft overhead station glow so metals never reflect a void.
  {
    const env = new THREE.Scene();
    const envSky = buildSky(milky, mars);
    envSky.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m?.uniforms?.uGain) m.uniforms.uGain.value = 0.45;
    });
    env.add(envSky);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.32), new THREE.MeshBasicMaterial({ color: 0x59636e, side: THREE.BackSide }));
    env.add(glow);
    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(14, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.97, 0.92).multiplyScalar(40) }));
    sunBall.position.copy(ARES_SUN_DIR).multiplyScalar(300);
    env.add(sunBall);
    // Build-exact PMREM (gpu-backend.ts): the WebGL build generator would break on WebGPU.
    scene.environment = await pmremEnv(renderer, env, 0.02, 1, 600);
    scene.environmentIntensity = 1.0;
  }

  // ---------------------------------------------------------- life
  // beacons on the exterior: one slow pulse, no point lights
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const beacons = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 10, 8), beaconMat, 3);
  beacons.name = "ares/beacons";
  beacons.userData.qaIgnore = true;
  [[26, 21.9, -38.6], [57.9, 4.6, 34], [-69, 2.6, 12]].forEach((p, i) => beacons.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p[0]!, p[1]!, p[2]!)));
  root.add(beacons);

  let t = 0;
  return {
    scene,
    sun,
    root,
    update: (dt: number, cam: THREE.Camera) => {
      t += Math.min(dt, 0.05);
      sky.position.copy(cam.position);
      if (core.uniforms?.uTime) core.uniforms.uTime.value = t;
      const pulse = Math.pow(Math.max(0, Math.cos(t * Math.PI / 2.2)), 30);
      beaconMat.color.setRGB(0.25 + pulse * 3.0, 0.22 + pulse * 2.4, 0.2 + pulse * 2.0);
    },
  };
}

let vmEnv: THREE.Texture | null = null;
/**
 * Reflection environment for things held close to the eye (the viewmodel).
 * Space is black, so a metal gun reflecting the real sky reads as a void.
 * This is a soft station-interior "studio": warm deck below, cool vault above
 * and a few long softboxes the size of the hall's light strips, so rails,
 * edges and ceramic plates catch the highlights a held object should.
 */
export async function aresViewmodelEnv(renderer: AnyRenderer): Promise<THREE.Texture> {
  if (vmEnv) return vmEnv;
  const env = new THREE.Scene();
  // Studio shell: warm deck below, cool vault above (identical
  // gradients to the old shader — as vertex colours, so the PMREM bakes
  // run on BOTH backends (custom GLSL has no node mapping, see
  // webgpu-pipeline.ts). 32x16 segments are smooth enough for an env bake.
  const shellGeo = new THREE.SphereGeometry(10, 32, 16);
  {
    const pos = shellGeo.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const up = new THREE.Color(0.16, 0.18, 0.21), hor = new THREE.Color(0.3, 0.3, 0.31), down = new THREE.Color(0.24, 0.22, 0.2);
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    const sstep = (e0: number, e1: number, x: number): number => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      if (v.y > 0) c.copy(hor).lerp(up, sstep(0, 0.8, v.y));
      else c.copy(hor).lerp(down, sstep(0, 0.6, -v.y));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    shellGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  const shell = new THREE.Mesh(
    shellGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }),
  );
  env.add(shell);
  const box = (w: number, h: number, pos: [number, number, number], col: number, k: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  box(8, 0.6, [0, 7, -3], 0xfff1e0, 3.2);   // overhead strip
  box(8, 0.6, [0, 7, 3], 0xe6f0ff, 2.4);
  box(3, 5, [8, 1.5, 0], 0xffffff, 1.4);    // side bounce
  box(3, 5, [-8, 1.5, 2], 0xffd9c2, 0.9);   // faint Mars-warm side
  box(6, 3, [0, 2, 9], 0xfff7ef, 2.0);      // key from behind the shoulder
  vmEnv = await pmremEnv(renderer, env, 0.035);
  return vmEnv;
}
