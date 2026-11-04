import * as THREE from "three";

/**
 * KATANA v3 night sky layer, drawn over the katana-sky dome: the moon (disc + soft halo, the bloom
 * threshold catches the disc) and a slow cloud deck lit from the moon side (two-octave fbm in a dome
 * shader, silver-lined near the moon, thinning at the horizon so the backdrop ridge silhouettes stay
 * clean). Real geometry just inside the camera far plane (420 m) so the map occludes it under any depth
 * convention (xyww lands on the NEAR plane under the game's reversed-Z); no depth write, no fog.
 */
export function buildKatanaNight(scene: THREE.Scene, moonDir: THREE.Vector3, low: boolean): { update: (dt: number, cam: THREE.Camera) => void } {
  const group = new THREE.Group();
  group.name = "katana/night";
  group.renderOrder = -5;
  scene.add(group);

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(395, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.ShaderMaterial({
      uniforms: { uMoon: { value: moonDir.clone().normalize() }, uTime: { value: 0 } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `precision highp float;
        uniform vec3 uMoon; uniform float uTime; varying vec3 vDir;
        float h(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++){ s += a * n(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.1; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          if (d.y < 0.0) discard;
          // planar cloud layer projection; domain-warped fbm = broken, lumpy rain cumulus (the paintings' sky is a
          // dense mottled deck with gaps, not smooth blobs)
          vec2 uv = d.xz / (d.y + 0.2) * 4.2 + vec2(uTime * 0.008, uTime * 0.003);
          vec2 w = vec2(fbm(uv * 0.5 + 3.1), fbm(uv * 0.5 + 8.7));
          float c = fbm(uv + (w - 0.5) * 1.1);
          float fine = n(uv * 7.0 + w * 3.0) * 0.5 + n(uv * 17.0) * 0.3 + n(uv * 37.0) * 0.2;
          float m = max(dot(d, normalize(uMoon)), 0.0);
          float cov = smoothstep(0.34, 0.6, c + (fine - 0.5) * 0.3);
          float thick = smoothstep(0.5, 0.85, c);
          // moonlight scatters through thin cloud edges (silver lining) and the cloud field near the moon
          float nearMoon = pow(m, 26.0), moonGlow = pow(m, 70.0), aureole = pow(m, 6.0);
          float low = 1.0 - smoothstep(0.04, 0.3, d.y); // the deck darkens and thins toward the ridgeline
          float edge = clamp(cov - thick * 1.15, 0.0, 1.0) * (0.55 + 0.9 * fine);
          vec3 belly = vec3(0.014, 0.021, 0.034);
          vec3 lit = vec3(0.03, 0.04, 0.06) * (0.55 + 0.9 * fine);
          vec3 col = mix(lit, belly, thick) * (1.0 - 0.45 * low);
          col += vec3(0.22, 0.27, 0.35) * edge * (nearMoon * 2.2 + aureole * 0.12);
          col += vec3(0.12, 0.15, 0.2) * moonGlow * (1.0 - thick * 0.6);
          col += vec3(0.02, 0.026, 0.036) * aureole * (1.0 - thick);
          float a = clamp(cov * 0.94, 0.0, 0.94) * smoothstep(0.015, 0.18, d.y);
          // the moon shows through thin cloud: only the thick deck may veil it
          a *= 1.0 - 0.75 * smoothstep(0.9990, 0.99985, m) * (1.0 - thick);
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true, depthWrite: false, depthTest: true, fog: false, side: THREE.BackSide,
    }),
  );
  clouds.renderOrder = -4;
  clouds.frustumCulled = false;

  // moon: emissive disc with a faint mare texture + halo card
  const moonMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
      void main(){
        vec2 c = vUv * 2.0 - 1.0; float r = length(c);
        float disc = 1.0 - smoothstep(0.235, 0.25, r);
        float halo = exp(-r * 6.5) * 0.32 + exp(-r * 16.0) * 0.55;
        float mare = n(c * 9.0) * 0.5 + n(c * 23.0) * 0.25;
        vec3 moon = vec3(0.93, 0.96, 1.0) * (3.4 - mare * 1.0);
        vec3 col = moon * disc + vec3(0.55, 0.65, 0.85) * halo * (1.0 - disc);
        gl_FragColor = vec4(col, max(disc, halo));
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), moonMat);
  moon.renderOrder = -6;
  moon.frustumCulled = false;
  group.add(moon);
  if (!low) group.add(clouds);

  let t = 0;
  const camPos = new THREE.Vector3();
  return {
    update: (dt, cam) => {
      t += dt;
      (clouds.material as THREE.ShaderMaterial).uniforms.uTime!.value = t;
      cam.getWorldPosition(camPos);
      group.position.copy(camPos);
      const R = 388;
      moon.position.copy(moonDir).multiplyScalar(R);
      moon.scale.setScalar(R * 0.15);
      moon.quaternion.copy(cam.quaternion);
    },
  };
}
