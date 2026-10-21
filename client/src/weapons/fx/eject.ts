/**
 * WHERE THE LOCAL GUN THROWS ITS BRASS — the switchable eject-port adapter.
 *
 * The viewmodel stream owns the gun models and is adding a real port API:
 *   vm.ejectWorld()    — the port in world space
 *   vm.ejectDirWorld() — the throw direction in world space
 *   vm.onEject         — a callback fired on the frame the case leaves the gun
 *                        (so a bolt gun ejects when the bolt is worked, not on
 *                        the trigger pull)
 * Until that lands (and as a fallback for any gun that does not publish one)
 * the port is APPROXIMATED from what the viewmodel has always exposed: the
 * muzzle, pulled back along the camera's forward by the gun's port-to-muzzle
 * length, the throw to the right, up and a touch back — how an AR-15 pattern
 * port throws (CoD's brass arcs right and slightly toward the lens).
 *
 * Everything is duck-typed at CALL time, so the moment the viewmodel ships its
 * methods this adapter starts using them without a code change here; `kind()`
 * reports which path a sample took (QA prints it).
 */
import * as THREE from "three";

/** What the adapter needs of the viewmodel (the fields every version has). */
export interface VmLike {
  muzzleWorld(): THREE.Vector3;
  root: THREE.Object3D;
  current?: string;
}

type VmPortApi = {
  ejectWorld?: (out?: THREE.Vector3) => THREE.Vector3 | undefined | null;
  ejectDirWorld?: (out?: THREE.Vector3) => THREE.Vector3 | undefined | null;
};

export interface EjectPort {
  /**
   * World position of the port + the unit throw direction for the gun in hand.
   * False when there is no gun to eject from (viewmodel hidden).
   */
  sample(weapon: string, pos: THREE.Vector3, dir: THREE.Vector3): boolean;
  /** "vm" = the viewmodel's own port, "approx" = muzzle + camera basis. */
  kind(): "vm" | "approx";
}

/** Port-to-muzzle distance along the barrel, metres, at viewmodel scale. */
const BACK: Record<string, number> = { ar: 0.25, smg: 0.17, sniper: 0.34, pistol: 0.1 };

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();

export function viewmodelEject(vm: VmLike, camera: THREE.Camera): EjectPort {
  let last: "vm" | "approx" = "approx";
  const api = vm as unknown as VmPortApi;
  return {
    kind: () => last,
    sample(weapon, pos, dir) {
      if (!vm.root.visible) return false;
      if (typeof api.ejectWorld === "function" && typeof api.ejectDirWorld === "function") {
        const p = api.ejectWorld(pos);
        const d = api.ejectDirWorld(dir);
        if (p && d) {
          if (p !== pos) pos.copy(p);
          if (d !== dir) dir.copy(d);
          if (dir.lengthSq() > 1e-8) {
            dir.normalize();
            last = "vm";
            return true;
          }
        }
      }
      // Approximation: the camera basis stands in for the gun's (the viewmodel
      // is aligned to the view within a few degrees of sway).
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements;
      _r.set(e[0]!, e[1]!, e[2]!).normalize();
      _u.set(e[4]!, e[5]!, e[6]!).normalize();
      _f.set(-e[8]!, -e[9]!, -e[10]!).normalize();
      pos.copy(vm.muzzleWorld());
      pos.addScaledVector(_f, -(BACK[weapon] ?? 0.22)).addScaledVector(_u, 0.012).addScaledVector(_r, 0.008);
      dir.copy(_r).multiplyScalar(0.86).addScaledVector(_u, 0.46).addScaledVector(_f, -0.12).normalize();
      last = "approx";
      return true;
    },
  };
}
