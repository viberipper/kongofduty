import * as THREE from "three";

/**
 * KATANA v3 wetness system: ONE material reads dry under the eaves and soaked in the open.
 *
 * Inputs (all shared through WetnessRig.uniforms, so a whole map updates with one write):
 *  - rain exposure: a top-down "rain shadow map" (orthographic depth from above, tilted a few
 *    degrees for wind) captured ONCE at load by `captureRain()`. A fragment is exposed when it
 *    is the top-most surface along the rain direction — eaves, engawa roofs, bridges and trees
 *    keep what is under them dry, with no bake step and no per-object authoring.
 *  - per-material porosity / wet roughness (manifest `wet`): porous stone and wood darken a
 *    lot, lacquer and tile hardly at all; the soaked surface film sets a roughness ceiling.
 *  - puddles (floors only, `puddle: true`): a 12 m world-space water-table field is compared
 *    against the material's own height (ormh.A) so water fills grout, joints and gravel
 *    furrows first, then spreads as uKvPuddleLevel rises. Puddles go mirror-smooth
 *    (roughness 0.03), lose the texture normal, gain animated rain ripples.
 *  - walls (`streaks: true`): world-space vertical rain-run streaks modulate the wetness.
 *
 * Reflection hooks (pick ONE per map, see docs/katana-map/v3/MATERIALS.md "Reflections"):
 *  - box-projected probe: uKvBoxOn + box min/max/pos re-aim the env lookup (parallax-corrected
 *    cubemap). Zero per-frame cost once captured.
 *  - planar: uKvPlanarOn blends a mirrored-camera render into the indirect specular of
 *    smooth up-facing fragments near uKvPlanarY.
 *  - SSR mask: uKvSsrOn writes (1 - reflectivity) into the HDR alpha so a single fullscreen
 *    SSR pass knows which pixels to trace (no G-buffer, no second geometry pass).
 */
export type WetSpec = { porosity: number; wetRough: number; puddle?: boolean; streaks?: boolean;
  /** wet glint: how hard the soaked surface's normal map is pushed (0..1.5) and how much 1.4 cm micro-facet
   * sparkle breaks moon / lantern speculars into glints. Default from porosity + wetRough (stone and slate glint). */
  glint?: number };

export type WetnessRig = {
  uniforms: {
    uKvWetness: { value: number };
    uKvPuddleLevel: { value: number };
    uKvTime: { value: number };
    uKvPuddleField: { value: THREE.Texture | null };
    uKvStreaks: { value: THREE.Texture | null };
    uKvRainOcc: { value: THREE.Texture | null };
    uKvRainMat: { value: THREE.Matrix4 };
    uKvRainOn: { value: number };
    uKvRainTexel: { value: number };
    uKvPlanar: { value: THREE.Texture | null };
    uKvPlanarMat: { value: THREE.Matrix4 };
    uKvPlanarOn: { value: number };
    uKvPlanarY: { value: number };
    uKvBoxOn: { value: number };
    uKvBoxMin: { value: THREE.Vector3 };
    uKvBoxMax: { value: THREE.Vector3 };
    uKvBoxPos: { value: THREE.Vector3 };
    uKvSsrOn: { value: number };
    /** rain intensity 0..1 (weather.ts setIntensity): scales the puddle ripples */
    uKvRainRate: { value: number };
    /** wall rain-run streak strength (KV_STREAKS materials) */
    uKvStreakGain: { value: number };
    /** global wet look: albedo darkening multiplier (x porosity), micro-sparkle amplitude, wet env-reflection boost */
    uKvDarken: { value: number };
    uKvSparkle: { value: number };
    uKvWetEnv: { value: number };
  };
  captureRain: (renderer: THREE.WebGLRenderer, scene: THREE.Scene, bounds: THREE.Box3, res?: number) => void;
  update: (dt: number) => void;
};

export function createWetnessRig(): WetnessRig {
  const uniforms: WetnessRig["uniforms"] = {
    uKvWetness: { value: 1 },
    uKvPuddleLevel: { value: 0.6 },
    uKvTime: { value: 0 },
    uKvPuddleField: { value: null },
    uKvStreaks: { value: null },
    uKvRainOcc: { value: null },
    uKvRainMat: { value: new THREE.Matrix4() },
    uKvRainOn: { value: 0 },
    uKvRainTexel: { value: 1 / 2048 },
    uKvPlanar: { value: null },
    uKvPlanarMat: { value: new THREE.Matrix4() },
    uKvPlanarOn: { value: 0 },
    uKvPlanarY: { value: 0 },
    uKvBoxOn: { value: 0 },
    uKvBoxMin: { value: new THREE.Vector3(-1, -1, -1) },
    uKvBoxMax: { value: new THREE.Vector3(1, 1, 1) },
    uKvBoxPos: { value: new THREE.Vector3() },
    uKvSsrOn: { value: 0 },
    uKvRainRate: { value: 1 },
    uKvStreakGain: { value: 1 },
    uKvDarken: { value: 1.25 },
    uKvSparkle: { value: 0.16 },
    uKvWetEnv: { value: 1.6 },
  };
  let rainRT: THREE.WebGLRenderTarget | null = null;
  const captureRain = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, bounds: THREE.Box3, res = 2048) => {
    const size = bounds.getSize(new THREE.Vector3());
    const centre = bounds.getCenter(new THREE.Vector3());
    const half = Math.max(size.x, size.z) / 2 + 2;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.5, size.y + 80);
    // rain falls with a little wind: ~5 degrees off vertical
    const dir = new THREE.Vector3(0.06, -1, 0.05).normalize();
    cam.position.copy(centre).addScaledVector(dir, -(size.y / 2 + 40));
    cam.up.set(0, 0, -1);
    cam.lookAt(centre);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    rainRT?.dispose();
    // The occlusion map stores STANDARD [0,1] depth of the rain camera as a float COLOUR (written by the
    // shader below), not the depth attachment: under the game's reversed-Z float depth (depth-precision.ts)
    // a depth texture holds 1 - d, which silently made every surface read as sheltered (dry). The depth
    // test still keeps the top-most surface whichever convention the renderer uses.
    rainRT = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true, type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const rainMat = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const occMat = new THREE.ShaderMaterial({
      uniforms: { uM: { value: rainMat } },
      vertexShader: "uniform mat4 uM; varying float vZ; void main(){ vec4 w = modelMatrix * vec4( position, 1.0 ); vec4 c = uM * w; vZ = c.z / c.w * 0.5 + 0.5; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader: "varying float vZ; void main(){ gl_FragColor = vec4( vZ, 0.0, 0.0, 1.0 ); }",
      side: THREE.DoubleSide,
    });
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (o.visible && (o.userData.kvNoRainOcc || (o as THREE.Points).isPoints || (m && m.transparent))) { hidden.push(o); o.visible = false; }
    });
    const bg = scene.background, fog = scene.fog, ov = scene.overrideMaterial;
    scene.background = null; scene.fog = null;
    scene.overrideMaterial = occMat;
    const prev = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rainRT);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(prev);
    scene.overrideMaterial = ov; scene.background = bg; scene.fog = fog;
    occMat.dispose();
    for (const o of hidden) o.visible = true;
    uniforms.uKvRainOcc.value = rainRT.texture;
    uniforms.uKvRainMat.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    uniforms.uKvRainTexel.value = 1 / res;
    uniforms.uKvRainOn.value = 1;
  };
  return {
    uniforms,
    captureRain,
    update: (dt) => { uniforms.uKvTime.value = (uniforms.uKvTime.value + dt) % 1000; },
  };
}

const f = (v: number) => v.toFixed(4);

export function patchWetness(m: THREE.MeshStandardMaterial, wet: WetSpec, rig: WetnessRig, o: { transmission?: boolean; cutout?: boolean } = {}): void {
  const glint = wet.glint ?? (wet.porosity >= 0.2 && wet.wetRough <= 0.36 ? 1.0 : wet.porosity >= 0.1 && wet.wetRough <= 0.25 ? 0.45 : 0);
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    Object.assign(shader.uniforms, rig.uniforms);
    shader.defines = {
      ...shader.defines,
      KV_POROSITY: f(wet.porosity),
      KV_WETROUGH: f(wet.wetRough),
      KV_PUDDLE: wet.puddle ? 1 : 0,
      KV_STREAKS: wet.streaks ? 1 : 0,
      KV_TRANSMISSION: o.transmission ? 1 : 0,
      KV_GLINT: f(glint),
      KV_GLINT_ON: glint > 0 ? 1 : 0,
      KV_WATER: m.userData.kvWater ? 1 : 0,
    };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKvWorld;\nvarying vec3 vKvWorldN;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        {
          vec4 kvW = vec4( transformed, 1.0 );
          vec3 kvN = objectNormal;
          #ifdef USE_INSTANCING
            kvW = instanceMatrix * kvW;
            kvN = mat3( instanceMatrix ) * kvN;
          #endif
          vKvWorld = ( modelMatrix * kvW ).xyz;
          vKvWorldN = normalize( mat3( modelMatrix ) * kvN );
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vKvWorld;
        varying vec3 vKvWorldN;
        uniform float uKvWetness, uKvPuddleLevel, uKvTime, uKvRainOn, uKvRainTexel, uKvPlanarOn, uKvPlanarY, uKvBoxOn, uKvSsrOn, uKvRainRate, uKvStreakGain, uKvDarken, uKvSparkle, uKvWetEnv;
        uniform sampler2D uKvPuddleField, uKvStreaks, uKvRainOcc, uKvPlanar;
        uniform mat4 uKvRainMat, uKvPlanarMat;
        uniform vec3 uKvBoxMin, uKvBoxMax, uKvBoxPos;
        float kvHash( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
        float kvExposure() {
          if ( uKvRainOn < 0.5 ) return 1.0;
          vec4 p = uKvRainMat * vec4( vKvWorld + vKvWorldN * 0.04, 1.0 );
          vec3 c = p.xyz / p.w * 0.5 + 0.5;
          if ( c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 ) return 1.0;
          float e = 0.0;
          for ( int i = 0; i < 4; i ++ ) {
            vec2 o = vec2( float( i & 1 ) - 0.5, float( i >> 1 ) - 0.5 ) * uKvRainTexel * 3.0;
            e += step( c.z - 0.0025, texture2D( uKvRainOcc, c.xy + o ).r ); // ~0.3 m: a stair tread is not sheltered by the next riser
          }
          return e * 0.25;
        }
        // rain ripples on standing water: two layers of expanding rings, world XZ
        vec2 kvRipples( vec2 p, float t ) {
          vec2 acc = vec2( 0.0 );
          for ( int l = 0; l < 2; l ++ ) {
            vec2 q = p * ( 3.1 + float( l ) * 1.7 ) + float( l ) * 7.31;
            vec2 cell = floor( q ); vec2 fr = fract( q ) - 0.5;
            float h = kvHash( cell );
            vec2 c = ( vec2( kvHash( cell + 1.7 ), kvHash( cell + 3.1 ) ) - 0.5 ) * 0.5;
            float ph = fract( t * ( 0.8 + 0.3 * h ) + h );
            vec2 d = fr - c; float r = length( d ) + 1e-4;
            float g = r - ph * 0.42;
            float w = exp( - g * g * 1400.0 ) * ( 1.0 - ph ) * ( 1.0 - ph );
            acc += d / r * sin( g * 110.0 ) * w;
          }
          return acc;
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        float kvUp = normalize( vKvWorldN ).y;
        float kvExp = kvExposure();
        float kvWet = uKvWetness * kvExp;
        float kvRun = 0.0;
        #if KV_STREAKS
        {
          float wall = 1.0 - smoothstep( 0.35, 0.75, abs( kvUp ) );
          float streak = texture2D( uKvStreaks, vec2( ( vKvWorld.x + vKvWorld.z ) / 1.5, - vKvWorld.y / 3.0 ) ).r;
          kvWet = mix( kvWet, kvWet * ( 0.35 + 0.65 * streak ), wall );
          // rain runs read as dark glossy vertical streaks (water sheeting down plaster, wood and stone)
          kvRun = wall * smoothstep( 0.45, 0.9, streak ) * uKvWetness * kvExp * clamp( uKvStreakGain * 0.5, 0.0, 1.0 );
        }
        #endif
        float kvH = 0.5;
        #ifdef USE_ROUGHNESSMAP
          kvH = texture2D( roughnessMap, vRoughnessMapUv ).a;
        #endif
        float kvPud = 0.0;
        float kvPw = 0.0; // planar-mirror weight (moat): SSR stays off where the mirror already reflects
        #if KV_PUDDLE
        {
          vec2 fld = texture2D( uKvPuddleField, vKvWorld.xz / 12.0 ).rg;
          kvPud = smoothstep( 0.0, 0.06, ( uKvPuddleLevel - fld.r ) * 1.4 - kvH * 0.35 ) * smoothstep( 0.9, 0.98, kvUp ) * kvWet;
        }
        #endif
        #if KV_WATER
          kvPud = smoothstep( 0.9, 0.98, kvUp ); // open water: all of it ripples in the rain
        #endif
        float kvGrout = smoothstep( 0.35, 0.05, kvH ) * kvWet * step( 0.5, kvUp );
        diffuseColor.rgb *= 1.0 - min( KV_POROSITY * 0.95 * uKvDarken, 0.9 ) * kvWet; // soaked stone and wood darken hard (was 0.6: read as damp, not wet)
        diffuseColor.rgb *= 1.0 - 0.25 * kvPud;
        diffuseColor.rgb *= 1.0 - 0.3 * kvRun;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, min( roughnessFactor, KV_WETROUGH ), kvWet );
        roughnessFactor = mix( roughnessFactor, min( roughnessFactor, KV_WETROUGH * 0.6 ), kvGrout * 0.6 );
        roughnessFactor = mix( roughnessFactor, 0.03, kvPud );
        roughnessFactor = mix( roughnessFactor, min( roughnessFactor, KV_WETROUGH * 0.5 ), kvRun );`)
      .replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps.replace("mapN.xy *= normalScale;",
        "mapN.xy *= normalScale * ( 1.0 + KV_GLINT * 0.7 * kvWet * ( 1.0 - kvPud ) );") + `
        #if KV_GLINT_ON
        {
          // micro-facet sparkle: 6 mm world cells each tilt the normal at random, so the moon and every lantern
          // break into glints on soaked stone; fades out where a cell gets smaller than a pixel (no shimmer soup)
          float kvPx = length( fwidth( vKvWorld ) );
          float kvSp = KV_GLINT * kvWet * ( 1.0 - kvPud ) * ( 1.0 - smoothstep( 0.003, 0.014, kvPx ) );
          if ( kvSp > 0.001 ) {
            vec3 kq = floor( vKvWorld * 160.0 );
            vec3 kh = vec3( kvHash( kq.xy + kq.z * 17.13 ), kvHash( kq.yz + kq.x * 3.71 ), kvHash( kq.zx + kq.y * 9.37 ) ) - 0.5;
            vec3 kn = inverseTransformDirection( normal, viewMatrix );
            kn = normalize( kn + kh * uKvSparkle * kvSp );
            normal = normalize( ( viewMatrix * vec4( kn, 0.0 ) ).xyz );
          }
        }
        #endif
        if ( kvPud > 0.001 ) {
          vec2 rp = kvRipples( vKvWorld.xz, uKvTime ) * 0.55 * uKvRainRate;
          vec3 nW = normalize( vec3( - rp.x, 1.0, - rp.y ) );
          vec3 nV = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
          normal = normalize( mix( normal, nV, kvPud ) );
        }`)
      .replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>
        #if defined( RE_IndirectSpecular )
        // a soaked floor is a mirror of the night sky: lift the env / probe reflection on wet up-facing surfaces
        radiance *= mix( 1.0, uKvWetEnv, kvWet * smoothstep( 0.6, 0.9, kvUp ) );
        // palette lock in reflections: the night HDRI / probes carry warm (orange-yellow) light near the horizon; a
        // reflection may be white, blue or THE red, never amber. Warm = both R and G above B (red keeps G low).
        {
          float kvWarm = clamp( ( min( radiance.r, radiance.g ) - radiance.b ) / max( max( radiance.r, radiance.g ), 1e-4 ) * 2.5, 0.0, 1.0 );
          radiance = mix( radiance, vec3( dot( radiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * vec3( 0.86, 0.95, 1.12 ), kvWarm );
        }
        #endif
        #if defined( RE_IndirectSpecular )
        if ( uKvPlanarOn > 0.5 && abs( vKvWorld.y - uKvPlanarY ) < 0.2 ) {
          float pw = smoothstep( 0.45, 0.04, material.roughness ) * smoothstep( 0.85, 0.97, kvUp );
          kvPw = pw;
          if ( pw > 0.001 ) {
            vec4 pc = uKvPlanarMat * vec4( vKvWorld, 1.0 );
            vec2 puv = pc.xy / pc.w;
            vec3 nW = inverseTransformDirection( normal, viewMatrix );
            puv += nW.xz * 0.045;
            float lod = material.roughness * 7.0;
            vec3 pl = textureLod( uKvPlanar, puv, lod ).rgb;
            radiance = mix( radiance, pl, pw );
          }
        }
        #endif`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>
        if ( uKvSsrOn > 0.5 ) {
          // reflectivity for the SSR pass: puddles ~1, wet slate ~0.5, dry stone 0
          float refl = smoothstep( 0.45, 0.03, material.roughness ) * smoothstep( 0.85, 0.97, kvUp ) * ( 1.0 - kvPw );
          gl_FragColor.a = 1.0 - refl;
        }`);
    // box-projected (parallax-corrected) probe: re-aim the reflection vector at the probe box
    shader.fragmentShader = shader.fragmentShader.replace(
      "reflectVec = inverseTransformDirection( reflectVec, viewMatrix );",
      `reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
        if ( uKvBoxOn > 0.5 ) {
          vec3 rmax = ( uKvBoxMax - vKvWorld ) / reflectVec;
          vec3 rmin = ( uKvBoxMin - vKvWorld ) / reflectVec;
          vec3 rf = max( rmax, rmin );
          float dist = min( min( rf.x, rf.y ), rf.z );
          reflectVec = normalize( vKvWorld + reflectVec * dist - uKvBoxPos );
        }`,
    );
    if (o.cutout) {
      // foliage cards: the cutout mask lives in ormh.B (see fetch-textures.mjs bamboo_leaves)
      shader.fragmentShader = shader.fragmentShader.replace("#include <alphatest_fragment>", `
        #ifdef USE_ROUGHNESSMAP
          diffuseColor.a = texture2D( roughnessMap, vRoughnessMapUv ).b;
        #endif
        #include <alphatest_fragment>`);
    }
    if (o.transmission) {
      // shoji: paper glows with what is behind it (interior light) where ormh.B says paper
      shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        #ifdef USE_ROUGHNESSMAP
          totalEmissiveRadiance *= texture2D( roughnessMap, vRoughnessMapUv ).b;
        #endif`);
    }
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${key()}|kv3wet|${m.userData.kvWater ? 1 : 0}|${wet.porosity}|${wet.wetRough}|${glint}|${wet.puddle ? 1 : 0}|${wet.streaks ? 1 : 0}|${o.transmission ? 1 : 0}|${o.cutout ? 1 : 0}`;
}
