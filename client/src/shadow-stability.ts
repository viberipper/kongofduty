import * as THREE from "three";

/**
 * ZERO-FLICKER, LAYER 2 — shadow stability (docs/nuketown/ZERO-FLICKER.md).
 *
 * A directional shadow box that follows the camera re-rasterises the whole
 * shadow map every frame at a new sub-texel offset. Every shadow edge then
 * lands on a slightly different texel boundary each frame and the PCF kernel
 * re-weights it: edges crawl and shimmer while the player merely walks.
 *
 * The cure is the standard one (cascaded-shadow-map practice): keep the box's
 * orientation fixed and move it only in WHOLE TEXELS of its own plane. Then a
 * world point always falls on the same place within a texel, the map content
 * just slides by integer texels, and the shading of every static surface is
 * bit-identical from frame to frame. The texel size is read live, so the
 * adaptive-quality drop from 4096 to 2048 (game.ts adaptQuality) stays snapped.
 *
 * Fixed boxes (Shipment's +/-28 m, Ares' +/-48 x 44 m) are stable by
 * construction; scripts/qa/flicker-gate.mjs verifies BOTH kinds analytically
 * on any map: a shadow camera that moves with the view must move by integer
 * texels and must never rotate.
 */

export type StableShadow = {
  name: string;
  light: THREE.DirectionalLight;
  /** Current texel edge in metres (x axis of the shadow map). */
  texel(): number;
  snap: boolean;
};

const REGISTRY: StableShadow[] = [];

export function stableShadowRegistry(): readonly StableShadow[] {
  return REGISTRY;
}

/**
 * Returns `follow(focus)`: aims `light` at `focus` (the light sits `distance`
 * metres up `toLight`), snapped to the shadow map's texel grid. `toLight` must
 * stay constant — a rotating box can never be stable.
 */
export function stableSunFollow(
  light: THREE.DirectionalLight,
  toLight: THREE.Vector3,
  distance: number,
  name = light.name || "sun",
): (focus: THREE.Vector3) => void {
  const dir = toLight.clone().normalize();
  // The shadow camera is placed by LightShadow.updateMatrices with lookAt from
  // the light to its target and the default up; rebuild that exact basis.
  const basis = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), light.shadow.camera.up);
  const ax = new THREE.Vector3().setFromMatrixColumn(basis, 0);
  const ay = new THREE.Vector3().setFromMatrixColumn(basis, 1);
  const az = new THREE.Vector3().setFromMatrixColumn(basis, 2);
  const cam = light.shadow.camera;
  const texelX = () => (cam.right - cam.left) / cam.zoom / light.shadow.mapSize.x;
  const texelY = () => (cam.top - cam.bottom) / cam.zoom / light.shadow.mapSize.y;
  // `?shadowsnap=0` reproduces the old free-floating box (QA before/after only).
  const snap = typeof location === "undefined" || !/[?&]shadowsnap=0\b/.test(location.search);
  REGISTRY.push({ name, light, texel: texelX, snap });
  const snapped = new THREE.Vector3();
  return (focus: THREE.Vector3) => {
    const tx = snap ? texelX() : 1e-9, ty = snap ? texelY() : 1e-9;
    const u = Math.round(focus.dot(ax) / tx) * tx;
    const v = Math.round(focus.dot(ay) / ty) * ty;
    const w = focus.dot(az);
    snapped.set(0, 0, 0).addScaledVector(ax, u).addScaledVector(ay, v).addScaledVector(az, w);
    light.target.position.copy(snapped);
    light.position.copy(snapped).addScaledVector(dir, distance);
    light.target.updateMatrixWorld(true);
    light.updateMatrixWorld(true);
  };
}

/**
 * Bias that scales with the texel instead of being hand-tuned per map:
 * normalBias of ~1.5 texels (plus the PCF kernel's reach) kills acne on large
 * flat receivers at grazing sun without detaching shadows from thin casters;
 * the constant bias stays a small depth-space nudge for the remaining slope.
 */
export function texelBias(texelMeters: number, pcfRadius: number): { normalBias: number; bias: number } {
  return { normalBias: texelMeters * (1.5 + 0.35 * pcfRadius), bias: -0.00018 };
}
