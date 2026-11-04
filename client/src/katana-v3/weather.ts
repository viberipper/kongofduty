import * as THREE from "three";
import type { WetnessRig } from "./wetness";

/**
 * KATANA v3 weather: light rain at night, built to never cost readability.
 *
 *   const weather = createKatanaWeather(scene, camera, renderer, rig, { quality: "high" });
 *   weather.addDripLine([a, b, ...]);          // eave edges (world space, metres)
 *   weather.addGutterStream([a, b, ...], 0.22); // a ribbon of running water on the ground
 *   weather.addMistZone(new THREE.Box3(min, max), 0.7);
 *   weather.update(dt, camera);                 // every frame, after the camera moved
 *
 * Effects (each is ONE draw call; all additive / alpha, depth-tested, no depth write):
 *  - rain: camera-local wrapped volume of stretched streaks (world-anchored, so strafing does
 *    not drag the rain), ~1 px wide, lit by the nearest point lights (lantern-red streaks next
 *    to lanterns, moon-blue elsewhere), hidden under shelter via the wetness rig's rain shadow.
 *  - splashes: camera-local ring + crown sprites placed ON the top-most surface found by the
 *    rain shadow map (roofs, copings, ground) — no CPU raycasts, nothing under eaves.
 *  - drip lines: authored eave polylines; drops fall under gravity to a CPU-raycast ground
 *    height (once, at add time) and splash there.
 *  - gutter streams: authored ribbons of running water (PBR, scrolling flow normal + foam).
 *  - ground mist: per-zone soft puffs that stay under ~1.2 m, fade out within 4 m of the
 *    camera and with distance, and pick up lantern colour.
 * Readability rules baked in: streaks are 1 px and low alpha, rain only exists within the
 * camera-local box (nothing piles up in the distance), mist alpha is capped and fades both
 * near and far (see assets-3d/katana-v3/weather/ for the 10/25/45 m gate).
 */

export type WeatherQuality = "low" | "high";
export type WeatherOpts = {
  quality?: WeatherQuality;
  /** rain amount 0..1 (scales streak count and alpha, splash rate) */
  intensity?: number;
  /** half-size of the camera-local rain box, metres */
  rainRadius?: number;
  /** ambient tint of unlit rain / mist (linear) */
  ambient?: THREE.ColorRepresentation;
  /** skip deriving mist from the scene's water / raked-gravel surfaces at creation */
  noAutoMist?: boolean;
};
export type KatanaWeather = {
  update: (dt: number, camera: THREE.Camera) => void;
  setQuality: (q: WeatherQuality) => void;
  setIntensity: (v: number) => void;
  addDripLine: (points: THREE.Vector3[], opts?: { spacing?: number; ground?: number }) => void;
  addGutterStream: (points: THREE.Vector3[], width?: number) => THREE.Mesh;
  addMistZone: (box: THREE.Box3, density?: number) => void;
  /** player positions (feet), up to 12: ground mist clears around them so bodies always read */
  setActors: (positions: THREE.Vector3[]) => void;
  refreshLights: () => void;
  /** static light sources (lanterns, toro, neon) that light the rain, splashes and mist; the nearest 8 to the
   *  camera are picked every update. Without a list the scene's PointLights are used (refreshLights). */
  setLightSources: (list: { p: THREE.Vector3; c: THREE.Color; i: number }[]) => void;
  /** derive low mist zones from the scene: puffs placed ON the up-facing surfaces of the water and raked-gravel
   *  meshes (called automatically by createKatanaWeather; call again after the map changes) */
  mistFromScene: (root?: THREE.Object3D) => number;
  /** per-effect objects, for profiling / toggling */
  parts: Record<"rain" | "sheets" | "splash" | "drips" | "gutter" | "mist", THREE.Object3D>;
  dispose: () => void;
};

const MAX_LIGHTS = 8;
const MAX_ACTORS = 12;
const RAIN_HIGH = 7000, RAIN_LOW = 2200;
const SPLASH_HIGH = 900, SPLASH_LOW = 300;

// ---------------------------------------------------------------- shared GLSL
const LIGHTS_GLSL = /* glsl */ `
  uniform vec3 uLightPos[${MAX_LIGHTS}];
  uniform vec3 uLightCol[${MAX_LIGHTS}];
  uniform vec3 uAmbient;
  vec3 kwLight( vec3 p ) {
    vec3 c = uAmbient;
    for ( int i = 0; i < ${MAX_LIGHTS}; i ++ ) {
      vec3 d = uLightPos[i] - p;
      c += uLightCol[i] / max( dot( d, d ), 0.35 );
    }
    return c;
  }`;
const RAINMAP_GLSL = /* glsl */ `
  uniform sampler2D uRainOcc; uniform mat4 uRainMat; uniform mat4 uRainInv; uniform float uRainOn;
  // 1 when p is above the top-most surface along the rain direction (i.e. rain reaches it)
  float kwExposed( vec3 p ) {
    if ( uRainOn < 0.5 ) return 1.0;
    vec4 c = uRainMat * vec4( p, 1.0 ); vec3 q = c.xyz / c.w * 0.5 + 0.5;
    if ( q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0 ) return 1.0;
    return step( q.z - 0.0015, texture( uRainOcc, q.xy ).r );
  }
  // top-most surface under (x, z) along the rain direction
  vec3 kwTopSurface( vec2 xz ) {
    if ( uRainOn < 0.5 ) return vec3( xz.x, 0.0, xz.y );
    vec4 c = uRainMat * vec4( xz.x, 0.0, xz.y, 1.0 ); vec3 q = c.xyz / c.w * 0.5 + 0.5;
    float d = texture( uRainOcc, q.xy ).r;
    vec4 w = uRainInv * vec4( q.xy * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    return w.xyz / w.w;
  }`;
// readability: suppress an effect inside the view cone from the eye to each player (and a little
// behind them). From the player's own camera that cone projects onto the enemy's silhouette and a
// thin ring around it, so it never shows as a hole -- it just keeps bodies clean.
const ACTORS_GLSL = /* glsl */ `
  uniform vec3 uActors[${MAX_ACTORS}];
  float kwActorClear( vec3 p, vec3 eye, float behind ) {
    float clear = 1.0;
    for ( int i = 0; i < ${MAX_ACTORS}; i ++ ) {
      vec3 ab = uActors[i] + vec3( 0.0, 0.9, 0.0 ) - eye;
      float t = clamp( dot( p - eye, ab ) / max( dot( ab, ab ), 1e-3 ), 0.0, behind );
      float r = 1.25 * t + 0.1;
      clear = min( clear, smoothstep( r * 0.55, r, length( p - ( eye + ab * t ) ) ) );
    }
    return clear;
  }`;
const HASH_GLSL = /* glsl */ `
  float kwH( float n ) { return fract( sin( n * 12.9898 ) * 43758.5453 ); }
  vec2 kwH2( vec2 p ) { return fract( sin( vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 ); }`;

function sharedUniforms(rig: WetnessRig, ambient: THREE.Color) {
  return {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3(0, -999, 0)) },
    uLightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    uAmbient: { value: new THREE.Vector3(ambient.r, ambient.g, ambient.b) },
    uRainOcc: rig.uniforms.uKvRainOcc,
    uRainMat: rig.uniforms.uKvRainMat,
    uRainOn: rig.uniforms.uKvRainOn,
    uRainInv: { value: new THREE.Matrix4() },
    uIntensity: { value: 1 },
    uActors: { value: Array.from({ length: MAX_ACTORS }, () => new THREE.Vector3(0, -999, 1e4)) },
  };
}
type Shared = ReturnType<typeof sharedUniforms>;

function quadGeometry(count: number, attrs: Record<string, { size: number; fill: (i: number, out: number[]) => void }>, quadsPerInstance = 1): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const corner: number[] = [], quad: number[] = [], index: number[] = [];
  for (let k = 0; k < quadsPerInstance; k++) {
    corner.push(-1, 0, 1, 0, 1, 1, -1, 1);
    quad.push(k, k, k, k);
    const b = k * 4; index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Array(quadsPerInstance * 12).fill(0), 3));
  g.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute("aQuad", new THREE.Float32BufferAttribute(quad, 1));
  g.setIndex(index);
  for (const [name, a] of Object.entries(attrs)) {
    const arr = new Float32Array(count * a.size); const tmp: number[] = [];
    for (let i = 0; i < count; i++) { tmp.length = 0; a.fill(i, tmp); for (let k = 0; k < a.size; k++) arr[i * a.size + k] = tmp[k] ?? 0; }
    g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, a.size));
  }
  g.instanceCount = count;
  return g;
}

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- rain streaks
function makeRain(u: Shared, radius: number): THREE.Mesh {
  const R = rng(11);
  const g = quadGeometry(RAIN_HIGH, { aSeed: { size: 4, fill: (_i, o) => o.push(R(), R(), R(), R()) } });
  const m = new THREE.ShaderMaterial({
    uniforms: { ...u, uBox: { value: new THREE.Vector3(radius * 2, 14, radius * 2) }, uVel: { value: new THREE.Vector3(0.6, -8.5, 0.45) }, uStreak: { value: 0.048 }, uAlpha: { value: 0.4 } },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner; attribute vec4 aSeed;
      uniform float uTime, uStreak, uAlpha, uIntensity; uniform vec3 uCam, uBox, uVel;
      varying vec3 vCol; varying vec2 vC;
      ${LIGHTS_GLSL}
      ${RAINMAP_GLSL}
      ${ACTORS_GLSL}
      void main() {
        vec3 vel = uVel * ( 0.85 + 0.3 * aSeed.w );
        vec3 base = uCam - uBox * 0.5;
        vec3 p = base + mod( aSeed.xyz * uBox + vel * uTime - base, uBox );
        vec3 tail = p - vel * uStreak;
        vec4 vh = viewMatrix * vec4( p, 1.0 ), vt = viewMatrix * vec4( tail, 1.0 );
        vec3 axis = vt.xyz - vh.xyz;
        vec3 side = normalize( cross( axis, vh.xyz ) );
        float w = max( 0.0012, 0.00125 * - vh.z );
        vec3 pos = mix( vh.xyz, vt.xyz, aCorner.y ) + side * aCorner.x * w;
        gl_Position = projectionMatrix * vec4( pos, 1.0 );
        float d = length( p - uCam );
        float fade = smoothstep( 0.6, 2.0, d ) * ( 1.0 - smoothstep( uBox.x * 0.32, uBox.x * 0.5, d ) );
        fade *= kwExposed( p ) * step( aSeed.w, uIntensity ) * ( 0.35 + 0.65 * kwActorClear( p, uCam, 1.8 ) );
        vCol = kwLight( p ) * fade * uAlpha;
        vC = aCorner;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying vec2 vC;
      void main() {
        float a = ( 1.0 - vC.x * vC.x ) * ( 1.0 - vC.y * 0.7 );
        gl_FragColor = vec4( vCol * a, 1.0 );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.name = "katana/weather-rain"; mesh.renderOrder = 10;
  mesh.userData.kvNoRainOcc = true;
  return mesh;
}

// ---------------------------------------------------------------- distant rain sheets
// Three camera-centred cylinder shells (16 / 34 / 70 m) carrying a procedural streak field in world arc-length x
// world height, so the rain keeps reading beyond the 12 m particle box: against the dark backdrop ridges and in the
// sky band between the town and the hills. Depth-tested (geometry in front hides them; where a shell cuts a wall the
// sparse streaks simply stop), hidden under shelter by the rain shadow, and cleared along the view cone to every
// player like the particles. One draw call.
const SHEET_R = [16, 34, 70];
function makeSheets(u: Shared): THREE.Mesh {
  const seg = 72, rows = 8;
  const pos: number[] = [], lay: number[] = [], arc: number[] = [], idx: number[] = [];
  SHEET_R.forEach((r, L) => {
    const base = pos.length / 3;
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      pos.push(Math.cos(th) * r, j / rows, Math.sin(th) * r); lay.push(L); arc.push(th * r);
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * (seg + 1) + i, b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aLayer", new THREE.Float32BufferAttribute(lay, 1));
  g.setAttribute("aArc", new THREE.Float32BufferAttribute(arc, 1));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: { ...u, uAlpha: { value: 0.5 } },
    vertexShader: /* glsl */ `
      attribute float aLayer; attribute float aArc;
      uniform vec3 uCam; uniform float uTime;
      varying vec3 vW; varying float vLayer; varying vec3 vL; varying float vArc;
      ${LIGHTS_GLSL}
      void main() {
        // shell spans from below the camera's floor to well above the roofs; the far shell reaches higher
        float lo = uCam.y - ( 8.0 + aLayer * 6.0 ), hi = uCam.y + ( 16.0 + aLayer * 14.0 );
        vec3 w = vec3( uCam.x + position.x, mix( lo, hi, position.y ), uCam.z + position.z );
        vW = w; vLayer = aLayer;
        // arc length in metres, world-anchored in angle (rotating the view does not drag the rain)
        vArc = aArc; // per-vertex from the generator angle: no atan seam
        vL = kwLight( w );
        gl_Position = projectionMatrix * viewMatrix * vec4( w, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCam; uniform float uTime, uAlpha, uIntensity;
      varying vec3 vW; varying float vLayer; varying vec3 vL; varying float vArc;
      ${RAINMAP_GLSL}
      ${ACTORS_GLSL}
      float sh( float n ) { return fract( sin( n * 91.3458 ) * 47453.5453 ); }
      float streaks( float x, float y, float spacing, float len, float speed, float seed ) {
        float cx = x / spacing;
        float col = floor( cx ), f = fract( cx );
        float r1 = sh( col + seed ), r2 = sh( col * 1.37 + seed + 4.1 );
        float off = 0.2 + 0.6 * r1;
        float fw = fwidth( cx );
        // thin line, never thinner than ~1 px (fwidth-based AA), dimmer as it would go sub-pixel
        float line = 1.0 - smoothstep( 0.0, max( fw * 0.9, 0.006 ), abs( f - off ) );
        line *= min( 1.0, 0.02 / max( fw, 1e-4 ) ) * 0.5 + 0.5;
        float ph = ( y + uTime * speed * ( 0.85 + 0.3 * r2 ) ) / len + r2 * 17.0;
        float seg = fract( ph );
        float drop = smoothstep( 0.0, 0.08, seg ) * ( 1.0 - smoothstep( 0.18, 0.42, seg ) ) * step( 0.35, sh( floor( ph ) + col * 3.1 ) );
        return line * drop;
      }
      void main() {
        // wind tilt matches the particle velocity (0.6, -8.5) -> x shifts with height
        float y = vW.y;
        float x = vArc + y * 0.07;
        float sp = vLayer < 0.5 ? 0.11 : ( vLayer < 1.5 ? 0.16 : 0.24 );
        float len = vLayer < 0.5 ? 1.3 : ( vLayer < 1.5 ? 2.2 : 3.6 );
        float s = streaks( x, y, sp, len, 8.5, vLayer * 11.0 ) + streaks( x * 1.618 + 3.3, y, sp * 1.618, len * 1.3, 8.0, vLayer * 11.0 + 5.0 ) * 0.6;
        if ( s < 0.002 ) discard;
        float d = length( vW.xz - uCam.xz );
        // vertical fade: no hard shell bottom / top
        float rel = vW.y - uCam.y;
        float vf = smoothstep( -8.0 - vLayer * 6.0, -3.0, rel ) * ( 1.0 - smoothstep( 8.0 + vLayer * 8.0, 16.0 + vLayer * 14.0, rel ) );
        float k = s * vf * kwExposed( vW ) * uIntensity;
        k *= 0.15 + 0.85 * kwActorClear( vW, uCam, 1.4 );
        float lay = vLayer < 0.5 ? 1.0 : ( vLayer < 1.5 ? 0.7 : 0.5 );
        gl_FragColor = vec4( vL * k * uAlpha * lay, 1.0 );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.name = "katana/weather-sheets"; mesh.renderOrder = 10;
  mesh.userData.kvNoRainOcc = true;
  return mesh;
}

// ---------------------------------------------------------------- splashes (ring on the surface + crown sprite)
function makeSplash(u: Shared, radius: number): THREE.Mesh {
  const R = rng(23);
  const g = quadGeometry(SPLASH_HIGH, { aSeed: { size: 4, fill: (_i, o) => o.push(R(), R(), R(), R()) } }, 2);
  const m = new THREE.ShaderMaterial({
    uniforms: { ...u, uRadius: { value: radius }, uAlpha: { value: 0.38 } },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner; attribute vec4 aSeed; attribute float aQuad;
      uniform float uTime, uRadius, uAlpha, uIntensity; uniform vec3 uCam;
      varying vec3 vCol; varying vec2 vUv; varying float vLife; varying float vQuad;
      ${LIGHTS_GLSL}
      ${RAINMAP_GLSL}
      ${HASH_GLSL}
      void main() {
        float period = 0.45 + 0.6 * aSeed.z;
        float t = uTime / period + aSeed.w * 7.0;
        float cyc = floor( t ); float life = fract( t ) * period;   // seconds since this splash
        vec2 jit = kwH2( aSeed.xy * 97.0 + cyc );
        float cell = uRadius * 2.0;
        vec2 base = uCam.xz - cell * 0.5;
        vec2 xz = base + mod( ( aSeed.xy + jit ) * cell - base, cell );
        vec3 s = kwTopSurface( xz ) + vec3( 0.0, 0.01, 0.0 );
        float d = length( s - uCam );
        float fade = smoothstep( 1.0, 2.5, d ) * ( 1.0 - smoothstep( uRadius * 0.55, uRadius, d ) ) * step( aSeed.z, uIntensity + 0.05 );
        vec3 pos;
        vec2 c = vec2( aCorner.x, aCorner.y * 2.0 - 1.0 );
        if ( aQuad < 0.5 ) {
          // flat expanding ring on the surface
          float r = 0.012 + life * 0.17;
          pos = s + vec3( c.x * r, 0.0, c.y * r );
          vLife = clamp( life / 0.35, 0.0, 1.0 );
        } else {
          // crown: short upright billboard, first 0.12 s only
          vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
          float k = clamp( life / 0.12, 0.0, 1.0 );
          pos = s + right * c.x * 0.045 * ( 0.6 + k ) + vec3( 0.0, ( c.y * 0.5 + 0.5 ) * 0.07 * ( 0.4 + k ), 0.0 );
          vLife = k;
        }
        gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
        vCol = kwLight( s ) * fade * uAlpha;
        vUv = c; vQuad = aQuad;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying vec2 vUv; varying float vLife; varying float vQuad;
      void main() {
        float a;
        if ( vQuad < 0.5 ) { float r = length( vUv ); a = smoothstep( 0.84, 0.94, r ) * smoothstep( 1.0, 0.94, r ) * ( 1.0 - vLife ) * ( 1.0 - vLife ) * 0.45; }
        else { float r = length( vec2( vUv.x, vUv.y * 0.6 + 0.4 ) ); a = smoothstep( 1.0, 0.35, r ) * ( 1.0 - vLife ) * step( vLife, 0.999 ) * 0.5; }
        gl_FragColor = vec4( vCol * a, 1.0 );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.name = "katana/weather-splash"; mesh.renderOrder = 9;
  mesh.userData.kvNoRainOcc = true;
  return mesh;
}

// ---------------------------------------------------------------- eave drip lines
function makeDrips(u: Shared): { mesh: THREE.Mesh; add: (pts: THREE.Vector3[], grounds: number[]) => void } {
  const emitters: number[] = [];
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, uAlpha: { value: 0.45 } },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner; attribute float aQuad; attribute vec4 aEmit; attribute vec2 aSeed;
      uniform float uTime, uAlpha, uIntensity; uniform vec3 uCam;
      varying vec3 vCol; varying vec2 vUv; varying float vQuad; varying float vLife;
      ${LIGHTS_GLSL}
      ${ACTORS_GLSL}
      void main() {
        const float G = 9.81;
        float h = max( aEmit.y - aEmit.w, 0.05 );
        float tf = sqrt( 2.0 * h / G );
        float period = tf + 0.35 + 1.1 * aSeed.x * ( 1.2 - uIntensity );
        float t = mod( uTime + aSeed.y * period * 3.0 + aQuad * period * 0.5, period );
        vec3 top = aEmit.xyz;
        vec3 pos; float vis = 1.0;
        vec2 c = vec2( aCorner.x, aCorner.y );
        if ( aQuad < 1.5 ) {
          // falling drop (two per emitter, half a period apart): stretched by its speed
          float tt = min( t, tf );
          float y = top.y - 0.5 * G * tt * tt;
          float v = G * tt;
          vis = step( t, tf );
          vec3 hd = vec3( top.x, y, top.z ), tl = hd + vec3( 0.0, v * 0.045 + 0.03, 0.0 );
          vec4 vh = viewMatrix * vec4( hd, 1.0 ), vt = viewMatrix * vec4( tl, 1.0 );
          vec3 side = normalize( cross( vt.xyz - vh.xyz, vh.xyz ) );
          float w = max( 0.0025, 0.0012 * - vh.z );
          gl_Position = projectionMatrix * vec4( mix( vh.xyz, vt.xyz, c.y ) + side * c.x * w, 1.0 );
          vCol = kwLight( hd ) * uAlpha * vis;
          vLife = c.y;
        } else {
          // splash ring where it lands
          float life = t - tf;
          vis = step( 0.0, life ) * step( life, 0.4 );
          float r = 0.03 + life * 0.45;
          vec3 g = vec3( top.x, aEmit.w + 0.012, top.z );
          vec2 cc = vec2( c.x, c.y * 2.0 - 1.0 );
          gl_Position = projectionMatrix * viewMatrix * vec4( g + vec3( cc.x * r, 0.0, cc.y * r ), 1.0 );
          vCol = kwLight( g ) * uAlpha * vis * ( 1.0 - life / 0.4 );
          vUv = cc; vLife = 0.0;
        }
        // drips are a close-range detail: gone by 16 m, so a far eave never turns into a speckled
        // curtain behind someone
        float dd = length( top - uCam );
        vCol *= smoothstep( 0.5, 1.5, dd ) * ( 1.0 - smoothstep( 9.0, 16.0, dd ) ) * kwActorClear( vec3( top.x, mix( top.y, aEmit.w, 0.5 ), top.z ), uCam, 2.5 );
        vQuad = aQuad;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol; varying vec2 vUv; varying float vQuad; varying float vLife;
      void main() {
        float a = vQuad < 1.5 ? 1.0 - vLife * 0.6 : smoothstep( 0.7, 0.88, length( vUv ) ) * smoothstep( 1.0, 0.88, length( vUv ) );
        gl_FragColor = vec4( vCol * a, 1.0 );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), mat);
  mesh.frustumCulled = false; mesh.name = "katana/weather-drips"; mesh.renderOrder = 9;
  mesh.userData.kvNoRainOcc = true;
  mesh.visible = false;
  const R = rng(37);
  const add = (pts: THREE.Vector3[], grounds: number[]) => {
    pts.forEach((p, i) => emitters.push(p.x, p.y, p.z, grounds[i]!));
    const n = emitters.length / 4;
    const seeds: number[] = []; for (let i = 0; i < n; i++) seeds.push(R(), R());
    // quads: 0,1 = two drops, 2 = splash  (aQuad 0,1,2)
    const g = quadGeometry(n, {
      aEmit: { size: 4, fill: (i, o) => o.push(emitters[i * 4]!, emitters[i * 4 + 1]!, emitters[i * 4 + 2]!, emitters[i * 4 + 3]!) },
      aSeed: { size: 2, fill: (i, o) => o.push(seeds[i * 2]!, seeds[i * 2 + 1]!) },
    }, 3);
    mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.visible = n > 0;
  };
  return { mesh, add };
}

// ---------------------------------------------------------------- gutter streams
function makeGutter(points: THREE.Vector3[], width: number, u: Shared): THREE.Mesh {
  // ribbon along the polyline: u = metres along, v = 0..1 across
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, a = points[Math.max(0, i - 1)]!, b = points[Math.min(points.length - 1, i + 1)]!;
    const dir = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
    if (i > 0) along += p.distanceTo(points[i - 1]!);
    pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z);
    uv.push(along, 0, along, 1);
    if (i > 0) { const k = i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  const m = new THREE.MeshStandardMaterial({ color: 0x0b0e11, roughness: 0.06, metalness: 0, side: THREE.DoubleSide, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vGu;").replace("#include <uv_vertex>", "#include <uv_vertex>\nvGu = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec2 vGu; uniform float uTime;
        float gh( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
        float gn( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( gh( i ), gh( i + vec2( 1, 0 ) ), f.x ), mix( gh( i + vec2( 0, 1 ) ), gh( i + vec2( 1, 1 ) ), f.x ), f.y ); }
        float flow( vec2 p ) { return gn( p * vec2( 3.0, 9.0 ) - vec2( uTime * 1.6, 0.0 ) ) * 0.6 + gn( p * vec2( 7.0, 17.0 ) - vec2( uTime * 2.3, 0.0 ) ) * 0.4; }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        float gEdge = smoothstep( 0.0, 0.22, vGu.y ) * smoothstep( 1.0, 0.78, vGu.y );
        float gFoam = smoothstep( 0.72, 0.9, gn( vGu * vec2( 5.0, 14.0 ) - vec2( uTime * 1.9, 0.0 ) ) ) * 0.35;
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.32, 0.34, 0.36 ), gFoam );
        diffuseColor.a = gEdge * 0.92;`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        {
          float e = 0.02; vec2 p = vGu;
          float h0 = flow( p ), hx = flow( p + vec2( e, 0.0 ) ), hy = flow( p + vec2( 0.0, e ) );
          vec3 nW = normalize( vec3( -( hx - h0 ) / e * 0.06, 1.0, -( hy - h0 ) / e * 0.06 ) );
          normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
        }`);
  };
  const mesh = new THREE.Mesh(g, m);
  mesh.name = "katana/weather-gutter"; mesh.renderOrder = 2; mesh.receiveShadow = false;
  mesh.userData.kvNoRainOcc = true;
  return mesh;
}

// ---------------------------------------------------------------- ground mist
function makeMist(u: Shared): { mesh: THREE.Mesh; add: (box: THREE.Box3, density: number) => void; addPoints: (pts: number[], sizeMin: number, sizeVar: number) => void; setLow: (low: boolean) => void; setActors: (ps: THREE.Vector3[]) => void } {
  const puffs: number[] = [];
  const R = rng(51);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, uTop: { value: 1.25 }, uAlpha: { value: Number(new URLSearchParams(globalThis.location?.search ?? "").get("kvmist") ?? 0.36) }, uMistCol: { value: new THREE.Vector3(0.11, 0.14, 0.19) }, uCamRight: { value: new THREE.Vector3(1, 0, 0) }, uCamUp: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner; attribute vec4 aPuff; attribute vec2 aSeed;
      uniform vec3 uCam, uCamRight, uCamUp; uniform float uTime;
      varying vec3 vW; varying vec2 vUv; varying vec2 vSeed; varying vec3 vC; varying float vBase;
      ${LIGHTS_GLSL}
      void main() {
        vec2 c = vec2( aCorner.x, aCorner.y * 2.0 - 1.0 );
        // aPuff.y is the SURFACE height under the puff: the puff floats ~0.45 m above it
        vBase = aPuff.y;
        vec3 ctr = aPuff.xyz + vec3( sin( uTime * 0.05 + aSeed.x * 6.28 ) * 0.6, 0.42 + aSeed.y * 0.2, cos( uTime * 0.04 + aSeed.y * 6.28 ) * 0.6 );
        // flattened puffs: wide, low
        vec3 w = ctr + uCamRight * c.x * aPuff.w + vec3( 0.0, c.y * aPuff.w * 0.32, 0.0 );
        vW = w; vUv = c; vSeed = aSeed;
        vC = kwLight( ctr );
        gl_Position = projectionMatrix * viewMatrix * vec4( w, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCam, uMistCol, uAmbient; uniform float uTop, uAlpha, uTime, uIntensity;
      uniform vec3 uActors[${MAX_ACTORS}];
      varying vec3 vW; varying vec2 vUv; varying vec2 vSeed; varying vec3 vC; varying float vBase;
      float mh( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
      float mn( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( mh( i ), mh( i + vec2( 1, 0 ) ), f.x ), mix( mh( i + vec2( 0, 1 ) ), mh( i + vec2( 1, 1 ) ), f.x ), f.y ); }
      void main() {
        float r = length( vUv );
        float blob = smoothstep( 1.0, 0.15, r );
        vec2 np = vW.xz * 0.35 + vSeed * 13.0 + vec2( uTime * 0.03, uTime * 0.017 );
        float n = mn( np ) * 0.65 + mn( np * 2.7 ) * 0.35;
        float hy = vW.y - vBase;
        float hgt = smoothstep( 0.0, 0.25, hy ) * ( 1.0 - smoothstep( uTop * 0.55, uTop, hy ) );
        float d = length( vW - uCam );
        float near = smoothstep( 3.0, 7.0, d );            // never in the player's face
        float far = 1.0 - smoothstep( 40.0, 70.0, d );
        // readability: mist parts around players (soft clearing, like bodies stirring it) AND along
        // the view cone to each of them -- a cone from the eye to the body projects onto the
        // body's own silhouette, so from the player's camera it only ever un-fogs the enemy
        float clear = 1.0;
        for ( int i = 0; i < ${MAX_ACTORS}; i ++ ) {
          vec3 b = uActors[i] + vec3( 0.0, 0.9, 0.0 );
          clear = min( clear, smoothstep( 0.7, 2.0, length( vW.xz - uActors[i].xz ) ) );
          vec3 ab = b - uCam; float t = clamp( dot( vW - uCam, ab ) / max( dot( ab, ab ), 1e-3 ), 0.0, 1.0 );
          float r = 1.2 * t + 0.1;
          clear = min( clear, smoothstep( r * 0.55, r, length( vW - ( uCam + ab * t ) ) ) );
        }
        float a = blob * ( 0.35 + 0.65 * n ) * hgt * near * far * clear * uAlpha;
        gl_FragColor = vec4( uMistCol + max( vC - uAmbient, vec3( 0.0 ) ) * 0.35, a );
      }`,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), mat);
  mesh.frustumCulled = false; mesh.name = "katana/weather-mist"; mesh.renderOrder = 8; mesh.visible = false;
  mesh.userData.kvNoRainOcc = true;
  let low = false;
  const rebuild = () => {
    const n = puffs.length / 6;
    const g = quadGeometry(n, {
      aPuff: { size: 4, fill: (i, o) => o.push(puffs[i * 6]!, puffs[i * 6 + 1]!, puffs[i * 6 + 2]!, puffs[i * 6 + 3]!) },
      aSeed: { size: 2, fill: (i, o) => o.push(puffs[i * 6 + 4]!, puffs[i * 6 + 5]!) },
    });
    mesh.geometry.dispose(); mesh.geometry = g; mesh.visible = n > 0;
    g.instanceCount = low ? Math.ceil(n / 2) : n;
  };
  const add = (box: THREE.Box3, density: number) => {
    const s = box.getSize(new THREE.Vector3());
    const n = Math.max(2, Math.round(s.x * s.z * 0.11 * density));
    for (let i = 0; i < n; i++) {
      const size = 2.2 + R() * 2.4;
      puffs.push(box.min.x + R() * s.x, box.min.y, box.min.z + R() * s.z, size, R(), R());
    }
    // sort far-to-near is per-frame work; puffs are low alpha and similar colour, so a fixed
    // shuffle is visually stable enough and keeps this at zero CPU per frame
    rebuild();
  };
  const setActors = (ps: THREE.Vector3[]) => {
    const arr = u.uActors.value;
    for (let i = 0; i < MAX_ACTORS; i++) { const p = ps[i]; if (p) arr[i]!.copy(p); else arr[i]!.set(0, -999, 1e4); }
  };
  const addPoints = (pts: number[], sizeMin: number, sizeVar: number) => {
    for (let i = 0; i < pts.length; i += 3) puffs.push(pts[i]!, pts[i + 1]!, pts[i + 2]!, sizeMin + R() * sizeVar, R(), R());
    rebuild();
  };
  return { mesh, add, addPoints, setActors, setLow: (l) => { low = l; if (puffs.length) rebuild(); } };
}

/** Random points on the up-facing surfaces of `meshes` (world space), `perM2` points per square metre, at most
 *  `max`. Used to sit mist on the moat water and the raked gravel without any authored zones. */
function sampleUpSurfaces(meshes: THREE.Mesh[], perM2: number, max: number, seed: number): number[] {
  const R = rng(seed);
  const tris: number[] = []; const cdf: number[] = []; let total = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry; const P = g.getAttribute("position"); if (!P) continue;
    const I = g.getIndex(); const cnt = I ? I.count : P.count;
    m.updateWorldMatrix(true, false);
    for (let k = 0; k + 2 < cnt; k += 3) {
      const ia = I ? I.getX(k) : k, ib = I ? I.getX(k + 1) : k + 1, ic = I ? I.getX(k + 2) : k + 2;
      a.fromBufferAttribute(P, ia).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(P, ib).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(P, ic).applyMatrix4(m.matrixWorld);
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
      const area2 = n.length(); if (area2 < 1e-6 || n.y / area2 < 0.85) continue;
      total += area2 / 2; cdf.push(total); tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
  const count = Math.min(max, Math.round(total * perM2));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = R() * total; let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid]! < r) lo = mid + 1; else hi = mid; }
    const t = lo * 9; let u1 = R(), u2 = R(); if (u1 + u2 > 1) { u1 = 1 - u1; u2 = 1 - u2; }
    for (let k = 0; k < 3; k++) out.push(tris[t + k]! + (tris[t + 3 + k]! - tris[t + k]!) * u1 + (tris[t + 6 + k]! - tris[t + k]!) * u2);
  }
  return out;
}

// ---------------------------------------------------------------- character wet sheen
/** Lower roughness, darken a touch, add a cool fresnel rim: wet fur/cloth that still pops. */
export function applyWetSheen(material: THREE.MeshStandardMaterial, amount = 0.7, rim: THREE.ColorRepresentation = 0x8fb2d8): void {
  if (material.userData.kwWet) return;
  material.userData.kwWet = true;
  const uWet = { value: amount }, uRim = { value: new THREE.Color(rim) };
  material.userData.kwWetUniform = uWet;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    prev.call(material, shader, r);
    shader.uniforms.uKwWet = uWet; shader.uniforms.uKwRim = uRim;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uKwWet; uniform vec3 uKwRim;")
      .replace("#include <map_fragment>", "#include <map_fragment>")
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, roughnessFactor * 0.5, uKwWet );")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        { float f = 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) ); totalEmissiveRadiance += uKwRim * pow( f, 4.0 ) * 0.02 * uKwWet; }`);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|kwwet`;
  material.needsUpdate = true;
}

// ---------------------------------------------------------------- main
export function createKatanaWeather(scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer, rig: WetnessRig, opts: WeatherOpts = {}): KatanaWeather {
  void renderer;
  const radius = opts.rainRadius ?? 12;
  const u = sharedUniforms(rig, new THREE.Color(opts.ambient ?? new THREE.Color(0.3, 0.36, 0.46)));
  const group = new THREE.Group(); group.name = "katana/weather"; group.userData.kvNoRainOcc = true;
  const rain = makeRain(u, radius);
  const sheets = makeSheets(u);
  const splash = makeSplash(u, radius);
  const drips = makeDrips(u);
  const mist = makeMist(u);
  const gutters = new THREE.Group(); gutters.name = "katana/weather-gutters";
  group.add(rain, sheets, splash, drips.mesh, mist.mesh, gutters);
  scene.add(group);

  let lights: THREE.PointLight[] = [];
  const refreshLights = () => {
    lights = [];
    scene.traverse((o) => { if ((o as THREE.PointLight).isPointLight) lights.push(o as THREE.PointLight); });
  };
  refreshLights();
  const tmp = new THREE.Vector3(), camPos = new THREE.Vector3();
  const sorted: { p: THREE.Vector3; c: THREE.Color; i: number; d: number }[] = [];
  let sources: { p: THREE.Vector3; c: THREE.Color; i: number }[] | null = null;

  let quality: WeatherQuality = opts.quality ?? "high";
  let intensity = opts.intensity ?? 1;
  const applyCounts = () => {
    (rain.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.round((quality === "high" ? RAIN_HIGH : RAIN_LOW) * Math.max(0.15, intensity));
    sheets.visible = intensity > 0.05;
    (sheets.material as THREE.ShaderMaterial).uniforms.uAlpha!.value = (quality === "high" ? 0.5 : 0.42) * Math.min(1, intensity * 1.15);
    (splash.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.round((quality === "high" ? SPLASH_HIGH : SPLASH_LOW) * Math.max(0.15, intensity));
    mist.setLow(quality === "low");
    u.uIntensity.value = 1; // counts already carry the amount; keep per-drop gate open
  };
  applyCounts();

  const raycaster = new THREE.Raycaster();
  const groundBelow = (p: THREE.Vector3): number => {
    raycaster.set(new THREE.Vector3(p.x, p.y - 0.05, p.z), new THREE.Vector3(0, -1, 0));
    raycaster.far = 40;
    const targets: THREE.Object3D[] = [];
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.kvNoRainOcc && o.visible && !(o as THREE.Mesh).name.startsWith("katana/weather")) targets.push(o); });
    const hit = raycaster.intersectObjects(targets, false).find((h) => {
      const m = (h.object as THREE.Mesh).material as THREE.Material; return !m.transparent;
    });
    return hit ? hit.point.y : p.y - 3;
  };

  const mistFromScene = (root: THREE.Object3D = scene): number => {
    const water: THREE.Mesh[] = [], gravel: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh || m.name.startsWith("katana/")) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[];
      if (mats.some((x) => /water/.test(x.name) && !/waterfall/.test(x.name))) water.push(m);
      else if (mats.some((x) => /^kv3a_gravel$|gravel_raked/.test(x.name))) gravel.push(m);
    });
    // moat / ponds: denser, bigger puffs; raked gravel: a thin moonlit layer
    const pw = sampleUpSurfaces(water, 0.16, 900, 61), pg = sampleUpSurfaces(gravel, 0.035, 700, 67);
    if (pw.length) mist.addPoints(pw, 2.4, 2.6);
    if (pg.length) mist.addPoints(pg, 2.0, 2.0);
    return (pw.length + pg.length) / 3;
  };
  if (!opts.noAutoMist) mistFromScene();

  return {
    parts: { rain, sheets, splash, drips: drips.mesh, gutter: gutters, mist: mist.mesh },
    refreshLights,
    setLightSources: (list) => { sources = list; },
    mistFromScene,
    update: (dt, cam) => {
      u.uTime.value = (u.uTime.value + Math.min(Math.max(dt, 0), 0.1)) % 3600;
      cam.getWorldPosition(camPos);
      u.uCam.value.copy(camPos);
      u.uRainInv.value.copy(rig.uniforms.uKvRainMat.value).invert();
      const right = (mist.mesh.material as THREE.ShaderMaterial).uniforms.uCamRight!.value as THREE.Vector3;
      right.setFromMatrixColumn(cam.matrixWorld, 0).setY(0).normalize();
      // nearest lights feed every effect's lighting
      sorted.length = 0;
      if (sources) {
        for (const s of sources) if (s.i > 0) sorted.push({ p: s.p, c: s.c, i: s.i, d: s.p.distanceToSquared(camPos) / s.i });
      } else {
        for (const l of lights) { if (!l.visible || l.intensity <= 0) continue; l.getWorldPosition(tmp); sorted.push({ p: tmp.clone(), c: l.color, i: l.intensity, d: tmp.distanceToSquared(camPos) / l.intensity }); }
      }
      sorted.sort((a, b) => a.d - b.d);
      for (let i = 0; i < MAX_LIGHTS; i++) {
        const s = sorted[i];
        const P = u.uLightPos.value[i]!, C = u.uLightCol.value[i]!;
        if (!s) { P.set(0, -999, 0); C.set(0, 0, 0); continue; }
        P.copy(s.p);
        C.set(s.c.r, s.c.g, s.c.b).multiplyScalar(s.i * 0.35);
      }
    },
    setQuality: (q) => { quality = q; applyCounts(); },
    setIntensity: (v) => { intensity = THREE.MathUtils.clamp(v, 0, 1); applyCounts(); },
    addDripLine: (points, o = {}) => {
      const spacing = o.spacing ?? 0.16;
      const pts: THREE.Vector3[] = [], grounds: number[] = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!; const len = a.distanceTo(b); const n = Math.max(1, Math.floor(len / spacing));
        for (let k = 0; k < n; k++) {
          const p = a.clone().lerp(b, (k + Math.random() * 0.6) / n);
          pts.push(p); grounds.push(o.ground ?? groundBelow(p));
        }
      }
      drips.add(pts, grounds);
    },
    addGutterStream: (points, width = 0.22) => { const m = makeGutter(points, width, u); gutters.add(m); return m; },
    addMistZone: (box, density = 1) => mist.add(box, density),
    setActors: (ps) => mist.setActors(ps),
    dispose: () => {
      group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
      scene.remove(group);
    },
  };
}
