/**
 * PLACEHOLDER GUNS — plain boxes with the right proportions and anchors so the
 * third-person mount and the FX can be built and measured before the real
 * tactical models land. The real builders call registerGun() for the same ids
 * after this module and win. Import order: placeholder first, models second.
 */
import * as THREE from "three";
import { registerGun, type GunId, type GunModel } from "./index";

const MAT = new THREE.MeshStandardMaterial({ color: 0x1d1f21, roughness: 0.55, metalness: 0.6 });

function boxGun(id: GunId, len: number, h: number, barrel: number, fore: number | null): (lod: "fp" | "tp") => GunModel {
  return (lod) => {
    const root = new THREE.Group();
    root.name = `gun-${id}-${lod}`;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.035, h, len), MAT);
    body.position.set(0, 0.04, -len * 0.35);
    root.add(body);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.035), MAT);
    grip.position.set(0, -0.03, 0.01);
    grip.rotation.x = 0.25;
    root.add(grip);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, barrel, 8).rotateX(Math.PI / 2), MAT);
    const z0 = -len * 0.85;
    b.position.set(0, 0.05, z0 - barrel / 2);
    root.add(b);
    const muzzle = new THREE.Vector3(0, 0.05, z0 - barrel);
    return {
      id,
      lod,
      root,
      muzzle,
      grip: new THREE.Vector3(0, 0, 0),
      fore: fore === null ? null : new THREE.Vector3(0, 0.02, -fore),
      sight: { front: new THREE.Vector3(0, 0.04 + h / 2 + 0.02, z0), rear: new THREE.Vector3(0, 0.04 + h / 2 + 0.02, 0.02) },
      eject: new THREE.Vector3(0.02, 0.05, -0.06),
      mag: null,
      bolt: null,
      length: len + barrel,
    };
  };
}

registerGun("ar", boxGun("ar", 0.52, 0.06, 0.22, 0.26));
registerGun("smg", boxGun("smg", 0.38, 0.06, 0.08, 0.18));
registerGun("sniper", boxGun("sniper", 0.72, 0.055, 0.42, 0.34));
registerGun("pistol", boxGun("pistol", 0.17, 0.035, 0.02, 0.04));
