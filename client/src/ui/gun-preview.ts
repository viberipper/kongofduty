/**
 * client/src/ui/gun-preview.ts — the LOADOUT's turntable: the real gun model
 * (the same procedural build the viewmodel draws, client/src/weapons/guns)
 * slowly turning on a small canvas of its own.
 *
 * One renderer while the loadout is open, released on close. Geometry and
 * materials belong to the gun builders and are shared with the viewmodel, so
 * nothing here disposes them — only this renderer's GPU copies go away.
 */
import * as THREE from "three";
import { buildGun, hasGun } from "../weapons/guns";
import "../weapons/guns/register";

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let pivot: THREE.Group | null = null;
let shown = "";
/** The shown gun's largest extent, metres — what the camera frames. */
let span = 1;
let raf = 0;
let last = 0;

function setup(): THREE.WebGLRenderer | null {
  if (renderer) return renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null; // no second GL context to spare: the panel just goes without
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.className = "lo-model";
  scene = new THREE.Scene();
  // Local stub for three's RoomEnvironment (not in vendor/): a small studio
  // of emissive cards so the PBR gun metals have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(makePreviewEnv(), 0.04).texture;
  pmrem.dispose();
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2, 3, 2);
  const rim = new THREE.DirectionalLight(0xf2c230, 1.4);
  rim.position.set(-3, 1, -2);
  scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.35));
  camera = new THREE.PerspectiveCamera(28, 2, 0.01, 20);
  pivot = new THREE.Group();
  scene.add(pivot);
  return renderer;
}

/** Minimal studio environment for the PMREM pass (see setup). */
function makePreviewEnv(): THREE.Scene {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x0b0d10);
  const card = (w: number, h: number, r: number, g: number, b: number, x: number, y: number, z: number): void => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial());
    m.material.color.setRGB(r, g, b);
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  card(6, 3, 5, 5, 5, 0, 4, 0); // cool overhead softbox
  card(4, 2, 4.5, 3.2, 1.6, -4, 1.5, 2); // warm key, left
  card(4, 2, 1.2, 1.8, 3.2, 4, 1, -2); // cool rim, right-back
  return env;
}

/** Frame `id` in the preview canvas (built once per id shown), and return the canvas. */
export function gunPreview(id: string): HTMLCanvasElement | null {
  if (!hasGun(id)) return null;
  const r = setup();
  if (!r || !pivot || !camera) return null;
  if (shown !== id) {
    shown = id;
    pivot.clear();
    const model = buildGun(id, "fp");
    const gun = model.root;
    // Centre the gun on its bounding box and turn it side-on (bore along +X).
    const box = new THREE.Box3().setFromObject(gun);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    gun.position.sub(mid);
    const holder = new THREE.Group();
    holder.add(gun);
    holder.rotation.y = Math.PI / 2;
    pivot.add(holder);
    pivot.rotation.set(0.12, -0.5, 0);
    span = Math.max(size.x, size.y, size.z);
    frame();
  }
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
  return r.domElement;
}

/** Back the camera off until the whole gun fits the canvas, at any aspect. */
function frame(): void {
  if (!camera) return;
  const tv = Math.tan((camera.fov * Math.PI) / 360);
  const d = Math.max((span * 0.62) / (tv * camera.aspect), (span * 0.19) / tv);
  camera.position.set(0, d * 0.06, d);
  camera.lookAt(0, 0, 0);
}

function tick(now: number): void {
  raf = 0;
  if (!renderer || !scene || !camera || !pivot || !renderer.domElement.isConnected) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  pivot.rotation.y += dt * 0.45;
  const c = renderer.domElement;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w > 0 && h > 0) {
    const pr = renderer.getPixelRatio();
    if (c.width !== Math.round(w * pr) || c.height !== Math.round(h * pr)) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      frame();
    }
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);
}

/** The loadout closed: stop turning and give the GL context back. */
export function releaseGunPreview(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  scene?.environment?.dispose();
  renderer?.dispose();
  renderer?.forceContextLoss();
  renderer = null;
  scene = null;
  camera = null;
  pivot = null;
  shown = "";
}
