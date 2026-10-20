/**
 * Re-implemented glue.
 *
 * The original world module is not part of any shipped bundle sourcemap (its
 * only call site `game.ts` uses it behind `import.meta.env.DEV && ?classic`,
 * so the shipped production build tree-shakes the import away entirely), and
 * it never made it into a `.js.map` `sources` list we could recover. This
 * file restores the contract the call site expects:
 *
 *   buildWorld(renderer) -> Promise<{ scene: THREE.Scene; sun: THREE.DirectionalLight }>
 *
 * It dispatches to the same per-map world builders `game.ts` uses for the
 * live path, and falls back to a minimal lit scene.
 */
import * as THREE from "three";
import { activeMap } from "@shared/maps";

export type ClassicWorld = {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  [key: string]: unknown;
};

function minimalWorld(): ClassicWorld {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(1, 2, 1);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  scene.add(sun);
  return { scene, sun };
}

export function buildWorld(renderer: THREE.WebGLRenderer): Promise<ClassicWorld> {
  const id = activeMap().id;
  void renderer;
  switch (id) {
    case "nuketown":
      return import("./nuketown-world").then((m) => m.buildNuketownWorld(renderer) as unknown as ClassicWorld);
    case "dust2":
      return import("./dust-world").then((m) => m.buildDustWorld(renderer) as unknown as ClassicWorld);
    case "ares":
      return import("./ares-world").then((m) => m.buildAresWorld(renderer) as unknown as ClassicWorld);
    case "jungle":
      return import("./jungle-world").then((m) => m.buildJungleWorld(renderer) as unknown as ClassicWorld);
    default:
      return Promise.resolve(minimalWorld());
  }
}
