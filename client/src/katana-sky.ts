/**
 * KATANA sky rig — the authored look for the WebGL path (gradient dome,
 * mountain rings, drizzle, height mist, PMREM environment). This is NOT a
 * 1:1 port of the source scene: its baked-lightmap path (lightmaps.json plus
 * ao/gi textures, never shipped) was removed rather than stubbed, so all
 * lighting here is procedural (sun + hemisphere + a PMREM of the sky).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const KATANA_EXPOSURE = 0.72;
export const KATANA_KEY_DIR = new THREE.Vector3(-0.46, 0.78, 0.42).normalize();

/**
 * Shared by the WebGL rig below and the WebGPU flat fallback in
 * katana-world.ts, so the two paths cannot drift apart.
 */
export const KATANA_BG_HEX = "#202c3a";
export const KATANA_FOG_HEX = "#34465c";
export const KATANA_FOG_DENSITY = 0.0042;
export const KATANA_SUN_COLOR = 0xb9ccef;
export const KATANA_SUN_INTENSITY = 1.3;
export const KATANA_HEMI_SKY = 0xb8cbe4;
export const KATANA_HEMI_GROUND = 0x354039;
export const katanaHemiIntensity = (low: boolean): number => (low ? 1.85 : 0.72);

/** Key light incl. shadow frustum — one authoring for both backends. */
export function makeKatanaSun(low: boolean): THREE.DirectionalLight {
  const sun = new THREE.DirectionalLight(KATANA_SUN_COLOR, KATANA_SUN_INTENSITY);
  sun.name = "katana/cool-key";
  sun.position.copy(KATANA_KEY_DIR).multiplyScalar(155);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = !low;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -96;
  sun.shadow.camera.right = 96;
  sun.shadow.camera.top = 88;
  sun.shadow.camera.bottom = -88;
  sun.shadow.camera.near = 24;
  sun.shadow.camera.far = 320;
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.055;
  sun.shadow.radius = 2;
  return sun;
}

/** Sky fill — one authoring for both backends. */
export function makeKatanaHemisphere(low: boolean): THREE.HemisphereLight {
  const hemisphere = new THREE.HemisphereLight(KATANA_HEMI_SKY, KATANA_HEMI_GROUND, katanaHemiIntensity(low));
  hemisphere.name = "katana/sky-fill";
  return hemisphere;
}

const SKY_ZENITH = new THREE.Color("#172231");
const SKY_HORIZON = new THREE.Color("#43566f");
const SKY_LOWER = new THREE.Color(KATANA_BG_HEX);
const FOG_COLOR = new THREE.Color(KATANA_FOG_HEX);
const MIST_COLOR = new THREE.Color("#465a6c");

export type KatanaSkyRig = {
  sun: THREE.DirectionalLight;
  update: (dt: number, cam: THREE.Camera) => void;
  atmosphere: (material: THREE.Material) => void;
};

type MistUniforms = {
  uKtMistColor: { value: THREE.Color };
  uKtMistParams: { value: THREE.Vector3 };
};

function makeSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: SKY_ZENITH },
      uHorizon: { value: SKY_HORIZON },
      uLower: { value: SKY_LOWER },
    },
    vertexShader: `varying vec3 vKtDir;
      void main() {
        vKtDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        gl_Position = p.xyww;
      }`,
    fragmentShader: `precision highp float;
      uniform vec3 uZenith, uHorizon, uLower;
      varying vec3 vKtDir;
      float hash( vec2 p ) {
        vec3 q = fract( vec3( p.xyx ) * 0.1031 );
        q += dot( q, q.yzx + 33.33 );
        return fract( ( q.x + q.y ) * q.z );
      }
      float noise( vec2 p ) {
        vec2 i = floor( p ), f = fract( p );
        vec2 u = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), u.x ),
          mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
      }
      void main() {
        vec3 d = normalize( vKtDir );
        float h = d.y;
        float horizon = 1.0 - smoothstep( 0.02, 0.52, h );
        vec3 color = mix( uZenith, uHorizon, horizon * horizon * ( 3.0 - 2.0 * horizon ) );
        color = mix( color, uLower, 1.0 - smoothstep( -0.09, 0.035, h ) );
        if ( h > 0.015 ) {
          vec2 uv = d.xz / ( h + 0.22 );
          float cloud = noise( uv * 1.35 ) * 0.62 + noise( uv * 2.83 + 13.7 ) * 0.27 + noise( uv * 5.91 + 3.2 ) * 0.11;
          float cover = smoothstep( 0.43, 0.72, cloud ) * smoothstep( 0.015, 0.18, h );
          color *= 1.0 - cover * 0.16;
          color += uHorizon * smoothstep( 0.61, 0.78, cloud ) * 0.055;
        }
        gl_FragColor = vec4( color, 1.0 );
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(390, 48, 24), material);
  sky.name = "katana/sky";
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  sky.userData.qaIgnore = true;
  return sky;
}

function ridge(i: number, seed: number): number {
  const x = i * 0.037 + seed * 11.17;
  const broad = Math.sin(x * 0.73 + seed) * 0.5 + Math.sin(x * 1.61 + seed * 2.3) * 0.28 + Math.sin(x * 3.17 + 1.4) * 0.14;
  const tree = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return broad + (tree - Math.floor(tree) - 0.5) * 0.085;
}

function makeMountainMaterial(color: THREE.Color, seed: number): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: true });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKtForestWorld;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vKtForestWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vKtForestWorld;
        float ktForestHash( vec2 p ) {
          vec3 q = fract( vec3( p.xyx ) * 0.1031 );
          q += dot( q, q.yzx + 33.33 );
          return fract( ( q.x + q.y ) * q.z );
        }
        float ktForestNoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          vec2 u = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( ktForestHash( i ), ktForestHash( i + vec2( 1.0, 0.0 ) ), u.x ),
            mix( ktForestHash( i + vec2( 0.0, 1.0 ) ), ktForestHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        vec2 ktForestUv = vKtForestWorld.xz + vec2( ${seed.toFixed(1)} * 17.0 );
        float ktCanopy = ktForestNoise( ktForestUv * 0.17 ) * 0.3 + ktForestNoise( ktForestUv * 0.43 + vKtForestWorld.y * 0.08 ) * 0.12;
        float ktTrunks = ktForestNoise( vec2( ( vKtForestWorld.x + vKtForestWorld.z ) * 0.71, vKtForestWorld.y * 0.1 ) );
        diffuseColor.rgb *= 0.76 + ktCanopy + ktTrunks * 0.1;`);
  };
  material.customProgramCacheKey = () => `kt-forest-${seed}`;
  return material;
}

function makeMountainRing(radius: number, base: number, height: number, seed: number, color: THREE.Color): THREE.Mesh {
  const segments = 512;
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const r = radius + Math.sin(a * 3 + seed) * 8 + Math.sin(a * 7 - seed) * 3;
    const crest = base + height * (0.83 + ridge(i, seed));
    const j = i * 6;
    positions[j] = Math.cos(a) * r;
    positions[j + 1] = -32;
    positions[j + 2] = Math.sin(a) * r;
    positions[j + 3] = Math.cos(a) * r;
    positions[j + 4] = crest;
    positions[j + 5] = Math.sin(a) * r;
    if (i < segments) {
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  const mountain = new THREE.Mesh(geometry, makeMountainMaterial(color, seed));
  mountain.name = `katana/mountains-${seed}`;
  mountain.userData.qaIgnore = true;
  return mountain;
}

function mergeMountainRings(mountains: THREE.Mesh[], seeds: number[]): THREE.Mesh {
  const material = makeMountainMaterial(new THREE.Color(0xffffff), 0);
  material.vertexColors = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float ktForestSeed;\nvarying float vKtForestSeed;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvKtForestSeed = ktForestSeed;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vKtForestSeed;")
      .replace("vec2( 0.0 * 17.0 )", "vec2( vKtForestSeed * 17.0 )");
  };
  material.customProgramCacheKey = () => "kt-forest-merged1";
  const geometries = mountains.map((mountain, index) => {
    const geometry = mountain.geometry;
    const count = geometry.getAttribute("position").count;
    const color = (mountain.material as THREE.MeshBasicMaterial).color;
    const colors = new Float32Array(count * 3);
    const seedValues = new Float32Array(count).fill(seeds[index]);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("ktForestSeed", new THREE.BufferAttribute(seedValues, 1));
    return geometry;
  });
  const geometry = mergeGeometries(geometries, false);
  geometry.computeBoundingSphere();
  const merged = new THREE.Mesh(geometry, material);
  merged.name = "katana/mountains";
  merged.userData.qaIgnore = true;
  for (const mountain of mountains) {
    mountain.geometry.dispose();
    (mountain.material as THREE.Material).dispose();
  }
  return merged;
}

function makeDrizzle(renderer: THREE.WebGLRenderer, low: boolean): THREE.Points {
  const count = low ? 128 : 384;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  let state = 0x4b415441;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() - 0.5) * 34;
    positions[i * 3 + 1] = random() * 14;
    positions[i * 3 + 2] = (random() - 0.5) * 34;
    seeds[i] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: `attribute float aSeed;
      uniform float uTime, uPixelRatio;
      varying float vFade;
      void main() {
        vec3 p = position;
        p.y = mod( position.y - uTime * ( 5.2 + aSeed * 1.7 ), 14.0 ) - 3.0;
        p.x += ( 11.0 - p.y ) * 0.035;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        float depth = -mv.z;
        gl_PointSize = clamp( 72.0 / max( depth, 1.0 ), 2.0, 10.0 ) * uPixelRatio;
        vFade = ( 1.0 - smoothstep( 10.0, 29.0, depth ) ) * smoothstep( 0.4, 1.8, depth );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `precision mediump float;
      varying float vFade;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        q.x += q.y * 0.14;
        float line = 1.0 - smoothstep( 0.035, 0.105, abs( q.x ) );
        float ends = 1.0 - smoothstep( 0.31, 0.5, abs( q.y ) );
        float alpha = line * ends * vFade * 0.19;
        if ( alpha < 0.004 ) discard;
        gl_FragColor = vec4( vec3( 0.58, 0.68, 0.79 ), alpha );
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    fog: false,
    toneMapped: false,
  });
  const rain = new THREE.Points(geometry, material);
  rain.name = "katana/drizzle";
  rain.frustumCulled = false;
  rain.renderOrder = 30;
  rain.userData.qaIgnore = true;
  return rain;
}

function applyMist(material: THREE.Material, uniforms: MistUniforms): void {
  if (material.userData.ktMist || (material as THREE.Material & { fog?: boolean }).fog === false) return;
  material.userData.ktMist = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKtMistWorld;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 ktMistPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          ktMistPosition = instanceMatrix * ktMistPosition;
        #endif
        vKtMistWorld = ( modelMatrix * ktMistPosition ).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vKtMistWorld;
        uniform vec3 uKtMistColor;
        uniform vec3 uKtMistParams;`)
      .replace("#include <fog_fragment>", `#include <fog_fragment>
        #ifdef USE_FOG
        {
          vec3 ray = vKtMistWorld - cameraPosition;
          float lengthToFragment = length( ray );
          float h = uKtMistParams.z;
          float dy = ray.y / h;
          float integral = abs( dy ) > 0.001 ? ( 1.0 - exp( -dy ) ) / dy : 1.0;
          float cameraDensity = exp( -max( cameraPosition.y - uKtMistParams.y, 0.0 ) / h );
          float tau = uKtMistParams.x * lengthToFragment * cameraDensity * integral;
          float mist = min( 1.0 - exp( -tau ), 0.46 );
          gl_FragColor.rgb = mix( gl_FragColor.rgb, uKtMistColor, mist );
        }
        #endif`);
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|kt-height-mist1`;
  material.needsUpdate = true;
}

export function buildKatanaSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer, low: boolean): KatanaSkyRig {
  const sky = makeSky();
  scene.add(sky);
  scene.background = SKY_LOWER.clone();
  scene.fog = new THREE.FogExp2(FOG_COLOR, KATANA_FOG_DENSITY);

  const mountains = [mergeMountainRings([
    makeMountainRing(326, 16, 56, 3, new THREE.Color("#28384b")),
    makeMountainRing(246, 8, 43, 2, new THREE.Color("#202e3e")),
    makeMountainRing(176, 1, 31, 1, new THREE.Color("#18252f")),
  ], [3, 2, 1])];
  scene.add(...mountains);

  const sun = makeKatanaSun(low);
  scene.add(sun, sun.target);

  const hemisphere = makeKatanaHemisphere(low);
  scene.add(hemisphere);

  if (!low) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const environment = new THREE.Scene();
      environment.add(makeSky());
      const ground = new THREE.Mesh(
        new THREE.SphereGeometry(300, 24, 12, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0.18, 0.205, 0.22), side: THREE.BackSide }),
      );
      environment.add(ground);
      scene.environment = pmrem.fromScene(environment, 0.035, 0.1, 600).texture;
      scene.environmentIntensity = 0.85;
      // The bake reads the temp scene once — free its geometries/materials.
      environment.traverse((o) => {
        const mesh = o as unknown as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) for (const m of material) m.dispose();
        else material?.dispose();
      });
      pmrem.dispose();
    } catch {
      scene.environment = null;
      hemisphere.intensity = 1.4;
    }
  }

  const rain = makeDrizzle(renderer, low);
  scene.add(rain);
  const mistUniforms: MistUniforms = {
    uKtMistColor: { value: MIST_COLOR },
    uKtMistParams: { value: new THREE.Vector3(0.022, -6, 4) },
  };
  for (const mountain of mountains) applyMist(mountain.material as THREE.Material, mistUniforms);

  let time = 0;
  return {
    sun,
    atmosphere: (material) => applyMist(material, mistUniforms),
    update: (dt, cam) => {
      time = (time + Math.max(0, Math.min(dt, 0.1))) % 10000;
      sky.position.copy(cam.position);
      rain.position.set(cam.position.x, cam.position.y, cam.position.z);
      (rain.material as THREE.ShaderMaterial).uniforms.uTime!.value = time;
    },
  };
}
