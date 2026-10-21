import * as THREE from 'three';
/** Keep textures and emissive relation cues while reducing software shader cost. */
export function softwareMaterials(...roots: THREE.Object3D[]): void {
  const cache = new Map<THREE.Material, THREE.Material>();
  const convert = (m: THREE.Material): THREE.Material => {
    if (!(m instanceof THREE.MeshStandardMaterial)) return m;
    if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile && !m.userData.softwareCompatible) return m;
    const found = cache.get(m);
    if (found) return found;
    const out = new THREE.MeshBasicMaterial({
      name: m.name, color: m.color.clone().multiplyScalar(1.2).add(m.emissive.clone().multiplyScalar(m.emissiveIntensity)), map: m.map,
      aoMap: m.aoMap, aoMapIntensity: m.aoMapIntensity,
      alphaMap: m.alphaMap, alphaTest: m.alphaTest, opacity: m.opacity,
      transparent: m.transparent, side: m.side, depthTest: m.depthTest, depthWrite: m.depthWrite,
      vertexColors: m.vertexColors, fog: m.fog, blending: m.blending,
      polygonOffset: m.polygonOffset, polygonOffsetFactor: m.polygonOffsetFactor, polygonOffsetUnits: m.polygonOffsetUnits,
    });
    cache.set(m, out);
    if (m.userData.softwareCompatible) {
      out.onBeforeCompile = m.onBeforeCompile;
      out.customProgramCacheKey = m.customProgramCacheKey;
    }
    if (out.map) out.map.anisotropy = 1;
    return out;
  };
  for (const root of roots) root.traverse(o=>{
    const mesh = o as THREE.Mesh;
    if (!mesh.material) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
}
