/**
 * KATANA v3 — the GREY world: the headless-Blender blockout (scripts/katana-v3/blender/kv3_build.py),
 * meshed 1:1 from the same boxes the sim collides with, lit as a clean clay model under a cool
 * moonlight key. No textures except a faint 1 m grid (world-space UVs from the build) so scale and
 * distance read in screenshots. This is the playable layout stage, not art: the art pass replaces
 * this module (Kimi's art modules, katana-world.ts & co., are no longer wired in).
 *
 * Deliberately no `kvRig` (cf. art-world's WetnessRig): the blockout has no wetness
 * rig, so game.ts installs the katana post stack with `rig: undefined` — grade runs,
 * SSR stays off. WebGL-only (?kvgrey=1, see game.ts); WebGPU keeps the v2 fallback.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { assetUrl, sameOriginManager } from "./asset-base";
import type { WorldApi } from "./world";

/** GRADE pass exposure for the grey (game.ts reads it for map "katana"). */
export const KATANA_EXPOSURE = 0.7;

/** Moonlight direction (TO the moon), game frame: azimuth 215 deg from north, 38 deg up. Same as the Blender stations. */
export const KATANA_MOON_DIR = (() => {
  const el = THREE.MathUtils.degToRad(38), az = THREE.MathUtils.degToRad(215);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
})();

function gridTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#d9d9d9";
  g.fillRect(0, 0, 128, 2);
  g.fillRect(0, 0, 2, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export async function buildKatanaWorld(renderer: THREE.WebGLRenderer): Promise<WorldApi> {
  const scene = new THREE.Scene();
  scene.name = "KATANA-GREY";
  const sky = new THREE.Color(0x2b3442);
  scene.background = sky;
  scene.fog = new THREE.Fog(0x2f3846, 70, 190);
  const root = new THREE.Group();
  root.name = "katana/grey";
  scene.add(root);

  const gltf = await new GLTFLoader(sameOriginManager()).loadAsync(assetUrl("/assets/katana/katana-grey.glb"));
  const grid = gridTexture();
  const mats = new Map<string, THREE.Material>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const key = src.name;
    let m = mats.get(key);
    if (!m) {
      const water = /water/.test(key);
      m = new THREE.MeshStandardMaterial({
        name: key,
        // GRADE warms every frame; a slight cool counter-tint keeps the clay neutral grey on screen
        color: water ? src.color.clone() : src.color.clone().multiply(new THREE.Color(0.86, 0.93, 1.08)),
        roughness: water ? 0.12 : 0.92,
        metalness: /sword/.test(key) ? 0.6 : 0,
        map: water ? null : grid,
        side: THREE.DoubleSide,
      });
      mats.set(key, m);
    }
    mesh.material = m;
    mesh.castShadow = !/water/.test(key);
    mesh.receiveShadow = true;
    mesh.layers.enable(1); // game.ts renders katana shadows from layer 1
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  });
  root.add(gltf.scene);
  root.updateMatrixWorld(true);

  const hemi = new THREE.HemisphereLight(0x8fa3c4, 0x23272e, 0.95);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x6a7894, 0.25));
  const sun = new THREE.DirectionalLight(0xd2ddff, 2.1);
  sun.name = "katana/moon";
  sun.position.copy(KATANA_MOON_DIR).multiplyScalar(90);
  sun.target.position.set(0, 0, 0);
  scene.add(sun, sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -72; sc.right = 72; sc.top = 72; sc.bottom = -72; sc.near = 10; sc.far = 220;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sc.layers.enable(1);
  renderer.shadowMap.enabled = true;

  return { scene, sun, root, update: () => {} };
}
