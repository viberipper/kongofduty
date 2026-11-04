import * as THREE from "three";
import type { WetnessRig } from "./wetness";

/**
 * Three candidate real-time reflection techniques for KATANA v3's wet floors, all wired to
 * the wetness patch (client/src/katana-v3/wetness.ts) so they can be A/B'd on the same
 * materials and timed (lookdev.ts `kvBench`).
 *
 *  1. ProbeReflections  — box-projected (parallax-corrected) cubemap probe, captured once,
 *                         PMREM-filtered so roughness picks the right blur. Static.
 *  2. PlanarReflection  — mirrored camera re-renders the scene into a half-res mip-mapped
 *                         target for ONE plane height. Exact, dynamic, costs a scene render.
 *  3. SsrPass           — one fullscreen screen-space trace over pixels flagged in the HDR
 *                         alpha by the wetness patch (smooth + up-facing). Dynamic, only
 *                         reflects what is on screen.
 */

// ---------------------------------------------------------------- 1. probe
export class ProbeReflections {
  envMap: THREE.Texture | null = null;
  private cubeRT: THREE.WebGLCubeRenderTarget;
  constructor(res = 256) {
    this.cubeRT = new THREE.WebGLCubeRenderTarget(res, { type: THREE.HalfFloatType, generateMipmaps: false });
  }
  /** Capture the scene (emissive signs, lanterns, lit walls) from `pos`; box = the zone's volume. */
  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, pos: THREE.Vector3, box: THREE.Box3, rig: WetnessRig): number {
    const t0 = performance.now();
    const cam = new THREE.CubeCamera(0.05, 400, this.cubeRT);
    cam.position.copy(pos);
    const env = scene.environment;
    rig.uniforms.uKvBoxOn.value = 0;
    cam.update(renderer, scene);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromCubemap(this.cubeRT.texture);
    pmrem.dispose();
    this.envMap?.dispose();
    this.envMap = rt.texture;
    scene.environment = env;
    rig.uniforms.uKvBoxMin.value.copy(box.min);
    rig.uniforms.uKvBoxMax.value.copy(box.max);
    rig.uniforms.uKvBoxPos.value.copy(pos);
    renderer.getContext().finish();
    return performance.now() - t0;
  }
  /** on: these materials use the probe (scaled like scene.environment); off: back to scene.environment. */
  enable(rig: WetnessRig, materials: THREE.MeshStandardMaterial[], on: boolean, fallback: THREE.Texture | null, intensity = 1): void {
    rig.uniforms.uKvBoxOn.value = on ? 1 : 0;
    for (const m of materials) { m.envMap = on ? this.envMap : fallback; m.envMapIntensity = on ? intensity : 1; m.needsUpdate = true; }
  }
}

// ---------------------------------------------------------------- 2. planar
export class PlanarReflection {
  rt: THREE.WebGLRenderTarget;
  /** the mirrored camera (its layers pick what the mirror renders) */
  cam = new THREE.PerspectiveCamera();
  scale: number;
  constructor(public y: number, scale = 0.5) {
    this.scale = scale;
    this.cam.userData.kvMirror = true; // [integrator] art-world's render-time PVS ignores the mirrored camera
    this.rt = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, samples: 0,
    });
  }
  setSize(w: number, h: number): void { this.rt.setSize(Math.max(16, Math.round(w * this.scale)), Math.max(16, Math.round(h * this.scale))); }
  /** Reflector-style virtual camera (proper rotation, oblique near plane = the water plane). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, rig: WetnessRig): void {
    const c = this.cam, n = new THREE.Vector3(0, 1, 0);
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const refl = new THREE.Vector3(camPos.x, this.y, camPos.z);
    const view = new THREE.Vector3().subVectors(refl, camPos);
    if (view.dot(n) > 0) return;
    view.reflect(n).negate().add(refl);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    const target = new THREE.Vector3().subVectors(refl, look).reflect(n).negate().add(refl);
    c.position.copy(view);
    c.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    c.lookAt(target);
    c.far = camera.far; c.near = camera.near;
    c.updateMatrixWorld();
    c.projectionMatrix.copy(camera.projectionMatrix);
    rig.uniforms.uKvPlanarMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);
    rig.uniforms.uKvPlanarY.value = this.y;
    // oblique near plane (Lengyel): clip everything below the water
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(0, this.y - 0.03, 0)).applyMatrix4(c.matrixWorldInverse);
    const cp = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = c.projectionMatrix.elements;
    const q = new THREE.Vector4((Math.sign(cp.x) + pm[8]!) / pm[0]!, (Math.sign(cp.y) + pm[9]!) / pm[5]!, -1, (1 + pm[10]!) / pm[14]!);
    cp.multiplyScalar(2 / cp.dot(q));
    pm[2] = cp.x; pm[6] = cp.y; pm[10] = cp.z + 1; pm[14] = cp.w;
    const prevRT = renderer.getRenderTarget(), shadowAuto = renderer.shadowMap.autoUpdate;
    const on = rig.uniforms.uKvPlanarOn.value;
    rig.uniforms.uKvPlanarOn.value = 0; // no recursion
    rig.uniforms.uKvPlanar.value = null; // never sample the target we are drawing into (feedback loop)
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, c);
    renderer.setRenderTarget(prevRT);
    renderer.shadowMap.autoUpdate = shadowAuto;
    rig.uniforms.uKvPlanarOn.value = on;
    rig.uniforms.uKvPlanar.value = this.rt.texture;
  }
}

// ---------------------------------------------------------------- 3. SSR
export class SsrPass {
  material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  constructor(public steps = 40) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tDepth: { value: null },
        uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix4() },
        uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.03 }, uFar: { value: 420 }, uReversed: { value: 0 }, uDebug: { value: 0 },
      },
      defines: { STEPS: steps },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor, tDepth; uniform mat4 uProj, uInvProj, uView; uniform vec2 uRes; uniform float uReversed, uDebug;
        varying vec2 vUv;
        // reversed-Z (client/src/depth-precision.ts): three uploads a [0,1]-normalised, reversed
        // projection while camera.projectionMatrix stays standard, so stored d = 1 - (z_ndc * 0.5 + 0.5)
        vec3 viewPos( vec2 uv, float d ) { d = uReversed > 0.5 ? 1.0 - d : d; vec4 p = uInvProj * vec4( vec3( uv, d ) * 2.0 - 1.0, 1.0 ); return p.xyz / p.w; }
        float h12( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
        void main() {
          vec4 base = texture2D( tColor, vUv );
          float mask = 1.0 - base.a;
          if ( mask < 0.02 ) { gl_FragColor = vec4( base.rgb, 1.0 ); return; }
          float d = texture2D( tDepth, vUv ).r;
          if ( uReversed > 0.5 ? d <= 0.0 : d >= 1.0 ) { gl_FragColor = vec4( base.rgb, 1.0 ); return; }
          vec3 P = viewPos( vUv, d );
          vec3 N = normalize( ( uView * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
          vec3 V = normalize( P );
          vec3 R = normalize( reflect( V, N ) );
          // step length grows with distance; jitter hides banding
          float stepLen = 0.06 + 0.02 * length( P );
          vec3 Q = P + R * stepLen * h12( gl_FragCoord.xy );
          vec2 hitUv = vec2( -1.0 ); float hit = 0.0;
          for ( int i = 0; i < STEPS; i ++ ) {
            Q += R * stepLen; stepLen *= 1.07;
            vec4 c = uProj * vec4( Q, 1.0 ); vec2 uv = c.xy / c.w * 0.5 + 0.5;
            if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 || Q.z > -0.03 ) break;
            float sd = texture2D( tDepth, uv ).r;
            float sz = viewPos( uv, sd ).z;
            float dz = sz - Q.z;
            if ( dz > 0.0 && dz < stepLen * 2.5 ) {
              // binary refine
              vec3 a = Q - R * stepLen, b = Q;
              for ( int k = 0; k < 5; k ++ ) {
                vec3 m = 0.5 * ( a + b ); vec4 mc = uProj * vec4( m, 1.0 ); vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
                float mz = viewPos( muv, texture2D( tDepth, muv ).r ).z;
                if ( mz > m.z ) b = m; else a = m;
              }
              vec4 bc = uProj * vec4( b, 1.0 ); hitUv = bc.xy / bc.w * 0.5 + 0.5; hit = 1.0; break;
            }
          }
          vec3 col = base.rgb;
          if ( hit > 0.5 ) {
            vec2 e = smoothstep( 0.0, 0.08, hitUv ) * smoothstep( 1.0, 0.92, hitUv );
            float fade = e.x * e.y;
            // Schlick for water/wet film (F0 = 0.02); the mask already carries smoothness
            float F = 0.07 + 0.93 * pow( 1.0 - max( dot( -V, N ), 0.0 ), 5.0 ); // art-directed: rain-soaked stone reads glassy (F0 0.02 read damp)
            // wet-street streak: a light reflected in rain-soaked stone smears into a vertical column (micro-ripples
            // + water film = a lobe stretched along the view's ground axis, which is screen-vertical). Gather the hit
            // along screen-Y, length growing with roughness (puddles stay near-mirror), 8 jittered taps, weighted to
            // the hit; a little horizontal noise from the ripples.
            float rough = 1.0 - mask;
            float L = 0.006 + rough * 0.11;
            float j = h12( gl_FragCoord.xy + 7.3 );
            float jx = ( h12( floor( gl_FragCoord.xy * 0.5 ) + 1.9 ) - 0.5 ) * ( 0.002 + rough * 0.006 );
            vec3 hc = vec3( 0.0 ); float ws = 0.0;
            for ( int k = 0; k < 8; k ++ ) {
              float o = ( ( float( k ) + j ) / 8.0 ) * 2.0 - 1.0;
              float w = exp( - o * o * 2.2 );
              hc += texture2D( tColor, clamp( hitUv + vec2( jx, o * L ), 0.001, 0.999 ) ).rgb * w; ws += w;
            }
            hc /= ws;
            col += hc * mask * fade * F * 1.4;
          }
          if ( uDebug > 0.5 ) col = vec3( hitUv, hit );
          gl_FragColor = vec4( col, 1.0 );
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
  }
  render(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget | null, camera: THREE.PerspectiveCamera): void {
    const u = this.material.uniforms;
    u.tColor!.value = src.texture; u.tDepth!.value = src.depthTexture;
    u.uProj!.value.copy(camera.projectionMatrix); u.uInvProj!.value.copy(camera.projectionMatrixInverse); u.uView!.value.copy(camera.matrixWorldInverse);
    u.uRes!.value.set(src.width, src.height);
    renderer.setRenderTarget(dst);
    renderer.render(this.quad, this.cam);
  }
}

// ---------------------------------------------------------------- the moat mirror (planar, layer-limited)
/**
 * KATANA's koi moat is the one water body the paintings show as a MIRROR (the sword, the hall's chochin and the red
 * lacquer smeared into red columns by the rain rings). SSR cannot do it (the lanterns are usually above the top of
 * the frame) and the box probe is too blurry, so the moat gets a planar reflection — affordable because it is
 * LIMITED: half resolution, only while the moat is on screen and within 70 m, and only the objects that can appear in
 * it (layer 3: everything within 30 m of the moat that stands above the water, every lantern / halo within 50 m,
 * and the sky). Everything else in the map is never re-rendered.
 */
export class MoatMirror {
  planar: PlanarReflection;
  /** uniforms switched off for the mirror pass (the light grid's per-pixel loop: the mirror is soft and small) */
  cheap: { value: number }[] = [];
  box = new THREE.Box3();
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private camPos = new THREE.Vector3();
  layered = 0;
  active = false;
  constructor(private rig: WetnessRig, water: THREE.Mesh[], scene: THREE.Scene, public scale = 0.4) {
    for (const w of water) { w.updateWorldMatrix(true, false); w.geometry.computeBoundingBox(); this.box.union(w.geometry.boundingBox!.clone().applyMatrix4(w.matrixWorld)); }
    const y = (this.box.min.y + this.box.max.y) / 2;
    this.planar = new PlanarReflection(y, scale);
    this.planar.cam.layers.set(3);
    const near = this.box.clone().expandByVector(new THREE.Vector3(30, 0, 30));
    near.min.y = y - 0.5; near.max.y = 1e4;
    const near18 = this.box.clone().expandByVector(new THREE.Vector3(12, 0, 12));
    near18.min.y = y - 0.5; near18.max.y = 1e4;
    const lanterns = this.box.clone().expandByVector(new THREE.Vector3(50, 0, 50));
    lanterns.min.y = y - 0.5; lanterns.max.y = 1e4;
    const bb = new THREE.Box3();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const name = (mesh.material as THREE.Material | undefined)?.name ?? "";
      if (o.name === "katana/sky" || o.parent?.name === "katana/night" || o.name === "katana/lantern-halos") { o.layers.enable(3); this.layered++; return; }
      if (!mesh.isMesh || o.userData.kvNoRainOcc && !/lantern|toro/.test(name)) return;
      if (/water/.test(name)) return;
      // a mirror seen from above never shows up-facing floors (they face away from the mirrored camera) or the
      // insides of halls: those are the bulk of the draws, skip them
      if (/^kva_i/.test(o.name) || /^kva_i/.test(o.parent?.name ?? "") || /deck|gravel|flag|street|stair|floor|tatami|cobble|slate|moss|rake|tread/.test(name)) return;
      mesh.geometry.computeBoundingBox?.();
      if (!mesh.geometry.boundingBox) return;
      bb.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      const lit = /lantern_paper|toro_paper|katana_glow|neon/.test(name);
      const small = bb.getSize(new THREE.Vector3()).length() < 6;
      if ((lit && bb.intersectsBox(lanterns)) || (bb.intersectsBox(small ? near18 : near))) { o.layers.enable(3); this.layered++; }
    });
  }
  setSize(w: number, h: number): void { this.planar.setSize(w, h); }
  /** call once per frame before the main render */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    camera.getWorldPosition(this.camPos);
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    const on = this.camPos.y > this.planar.y + 0.05 && this.box.distanceToPoint(this.camPos) < 70 && this.frustum.intersectsBox(this.box);
    this.active = on;
    this.rig.uniforms.uKvPlanarOn.value = on ? 1 : 0;
    if (!on) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.planar.rt.width !== Math.round(size.x * this.scale)) this.planar.setSize(size.x, size.y);
    this.planar.cam.layers.set(3);
    const prev = this.cheap.map((u) => u.value);
    for (const u of this.cheap) u.value = 0;
    this.planar.render(renderer, scene, camera, this.rig);
    this.cheap.forEach((u, i) => { u.value = prev[i]!; });
  }
}
