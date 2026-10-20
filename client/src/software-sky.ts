import * as THREE from "three";

/** Avoid cubemap conversion and reflection shaders on a CPU rasterizer. */
export function softwareSky(scene: THREE.Scene): void {
  if (!(scene.background instanceof THREE.Texture)) return;
  const map = scene.background.clone();
  map.mapping = THREE.UVMapping;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(200, 24, 12),
    new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false }),
  );
  sky.name = "software-sky";
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.onBeforeRender = (_renderer, _scene, camera) => { sky.matrixWorld.copyPosition(camera.matrixWorld); };
  scene.background = null;
  scene.environment = null;
  scene.add(sky);
}
