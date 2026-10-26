import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { teamColors } from "./ui/prefs";

/**
 * ARES EVA equipment is attached to the actual, skinned Kong. The face, fur,
 * gait and calibrated hand/bore remain the shipped character. All equipment
 * is baked once per source geometry and shared between actors; no update loop,
 * skin shader, transparency layer stack or added lights.
 */
const ivory = new THREE.MeshStandardMaterial({ color: 0xd8ded8, roughness: 0.43, metalness: 0.4 });
const seam = new THREE.MeshStandardMaterial({ color: 0x14222b, roughness: 0.58, metalness: 0.38 });
const titanium = new THREE.MeshStandardMaterial({ color: 0x637a86, roughness: 0.31, metalness: 0.8 });
const copper = new THREE.MeshStandardMaterial({ color: 0xe49b43, roughness: 0.34, metalness: 0.64 });
const glow = new THREE.MeshStandardMaterial({ color: 0x9ceff3, emissive: 0x46d9e7, emissiveIntensity: 1.5, roughness: 0.3 });
/**
 * TEAM HARDWARE. Slot 0 dresses allies, slot 1 enemies — the same ally/enemy
 * pair the chevrons and nameplates use (ui/prefs teamColors, so the
 * colour-vision modes repaint these too). Refreshed from teamColors() on every
 * attach/relation change; the materials are shared, so one refresh repaints
 * every suited actor at once.
 */
const teams = [
  new THREE.MeshStandardMaterial({ color: 0x3ea6ff, roughness: 0.5, metalness: 0.1 }),
  new THREE.MeshStandardMaterial({ color: 0xff4a3d, roughness: 0.5, metalness: 0.1 }),
];
function refreshTeamMats(): void {
  const tc = teamColors();
  teams[0]!.color.set(tc.ally);
  teams[1]!.color.set(tc.enemy);
}
const visor = new THREE.MeshStandardMaterial({
  color: 0x8fc8d0, roughness: 0.18, metalness: 0.35, transparent: true,
  opacity: 0.14, depthWrite: false, side: THREE.FrontSide,
});
// One opaque draw per animated bone. Tiny status lights stay luminous via the
// shared glow material, without another light affecting the whole scene.
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitRound = new RoundedBoxGeometry(1, 1, 1, 2, 0.13);
const unitSphere = new THREE.SphereGeometry(1, 18, 12);
const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
const unitRing = new THREE.TorusGeometry(1, 0.055, 6, 20);
const yAxis = new THREE.Vector3(0, 1, 0);

function part(g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material,
  x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = mat !== visor && mat !== glow;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function box(g: THREE.Group, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh {
  return part(g, unitBox, mat, x, y, z, sx, sy, sz);
}
function round(g: THREE.Group, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh {
  return part(g, unitRound, mat, x, y, z, sx, sy, sz);
}
function ball(g: THREE.Group, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh {
  return part(g, unitSphere, mat, x, y, z, sx, sy, sz);
}

/** Merge rigid hardware by material: dozens of authored details, a few draws. */
function bake(g: THREE.Group): THREE.Group {
  const bins = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const o of [...g.children]) {
    const m = o as THREE.Mesh;
    if (!m.isMesh) continue;
    m.updateMatrix();
    const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
    const mat = m.material as THREE.Material;
    const bin = bins.get(mat) ?? [];
    bin.push(geo);
    bins.set(mat, bin);
    g.remove(m);
  }
  for (const [mat, geos] of bins) {
    const geo = mergeGeometries(geos, false)!;
    for (const item of geos) item.dispose();
    const m = new THREE.Mesh(geo, mat);
    // The original skinned body already casts the complete silhouette.
    m.castShadow = mat !== visor && mat !== glow;
    m.receiveShadow = true;
    if (mat === teams[0]) m.userData.evaTeam = true;
    g.add(m);
  }
  return g;
}

type GearPiece = { bone: string; group: THREE.Group };
const gearCache = new Map<string, GearPiece[]>();

/** Measure RENDERED bind vertices, including the rig's bind-matrix correction. */
function region(root: THREE.Object3D, names: string[]): THREE.Box3 {
  const result = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton || !m.geometry.attributes.skinIndex) return;
    m.skeleton.update();
    const indices = new Set<number>();
    m.skeleton.bones.forEach((b, i) => { if (names.includes(b.name)) indices.add(i); });
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const si = m.geometry.attributes.skinIndex as THREE.BufferAttribute;
    const sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 2) {
      let weight = 0;
      for (let k = 0; k < 4; k++) if (indices.has(si.getComponent(i, k))) weight += sw.getComponent(i, k);
      if (weight < 0.48) continue;
      v.fromBufferAttribute(pos, i);
      m.applyBoneTransform(i, v).applyMatrix4(m.matrixWorld);
      result.expandByPoint(v);
    }
  });
  return result;
}

export type AstronautRig = { setAlly(ally: boolean): void };

// ---------------------------------------------------------------- suit skin
/**
 * THE SUIT IS THE SKIN. Hard shells bolted to bones read as floating blobs on a
 * furry, cartoon-proportioned ape. Instead every vertex below the neck is
 * re-dressed by its bone weights: white EVA fabric on the body and limbs, grey
 * gloves, dark boots, a belt line, and team-colour bands on the upper arms and
 * thighs. The head keeps Kong's own paint inside a clear helmet. The original
 * albedo's light/dark pattern is kept as fabric folds so the silhouette and
 * muscle read survive. Attributes are computed once per geometry and shared.
 */
const SUIT = {
  base: new THREE.Color(0xe9e6df), glove: new THREE.Color(0xa9aeb4), boot: new THREE.Color(0x4a4f56),
  belt: new THREE.Color(0x6c7178), cuff: new THREE.Color(0xc9ccd0),
};
/**
 * THE SUIT'S TEAM BANDS (upper-arm / thigh stripes, see suitAttributes).
 * Slot 0 = ally, slot 1 = enemy — read live off teamColors() so a
 * colour-vision change repaints them with everything else team-coloured.
 */
export function suitTeamColors(): [THREE.Color, THREE.Color] {
  const tc = teamColors();
  return [new THREE.Color(tc.ally), new THREE.Color(tc.enemy)];
}
const suitAttrCache = new WeakMap<THREE.BufferGeometry, true>();

function suitAttributes(mesh: THREE.SkinnedMesh): void {
  const geo = mesh.geometry;
  if (suitAttrCache.has(geo)) return;
  const si = geo.attributes.skinIndex as THREE.BufferAttribute;
  const sw = geo.attributes.skinWeight as THREE.BufferAttribute;
  const names = mesh.skeleton.bones.map((b) => b.name);
  const n = geo.attributes.position!.count;
  const col = new Float32Array(n * 3);
  const mask = new Float32Array(n);
  const team = new Float32Array(n);
  const w: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    for (const k in w) w[k] = 0;
    let top = "", topW = 0;
    for (let k = 0; k < 4; k++) {
      const name = names[si.getComponent(i, k)] ?? "";
      const v = sw.getComponent(i, k);
      w[name] = (w[name] ?? 0) + v;
      if (w[name]! > topW) { topW = w[name]!; top = name; }
    }
    const head = (w.Head ?? 0) + (w.NeckTwist02 ?? 0) + (w.NeckTwist01 ?? 0) * 0.6;
    const hand = (w.L_Hand ?? 0) + (w.R_Hand ?? 0);
    const foot = (w.L_Foot ?? 0) + (w.R_Foot ?? 0) + (w.L_ToeBase ?? 0) + (w.R_ToeBase ?? 0);
    let c = SUIT.base;
    let t = 0;
    if (hand > 0.5) c = SUIT.glove;
    else if (foot > 0.45) c = SUIT.boot;
    else if (/_ForearmTwist02$/.test(top)) c = SUIT.cuff;
    else if (top === "Waist" || top === "Pelvis") c = (w.Pelvis ?? 0) > 0.55 ? SUIT.base : SUIT.belt;
    if (/_UpperarmTwist01$/.test(top) || /_ThighTwist02$/.test(top)) t = 1;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    team[i] = t;
    // smooth hand-over at the neck: the helmet ring hides the seam
    mask[i] = 1 - THREE.MathUtils.smoothstep(head, 0.38, 0.62);
  }
  geo.setAttribute("suitCol", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("suitMask", new THREE.BufferAttribute(mask, 1));
  geo.setAttribute("suitTeam", new THREE.BufferAttribute(team, 1));
  suitAttrCache.set(geo, true);
}

function dressMaterial(mat: THREE.MeshStandardMaterial, teamU: { value: THREE.Color }): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSuitTeam = teamU;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 suitCol; attribute float suitMask; attribute float suitTeam;\nvarying vec3 vSuitCol; varying float vSuitMask; varying float vSuitTeam;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSuitCol = suitCol; vSuitMask = suitMask; vSuitTeam = suitTeam;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSuitTeam; varying vec3 vSuitCol; varying float vSuitMask; varying float vSuitTeam;")
      .replace("#include <map_fragment>", `#include <map_fragment>
        {
          // keep the paint's light/dark pattern as soft fabric folds
          float lum = dot(diffuseColor.rgb / max(diffuse, vec3(0.001)), vec3(0.3, 0.59, 0.11));
          vec3 suitC = mix(vSuitCol, uSuitTeam, vSuitTeam);
          vec3 suit = suitC * diffuse * (0.9 + 0.16 * clamp(lum * 1.6, 0.0, 1.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, suit, vSuitMask);
        }`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.82, vSuitMask);");
  };
  mat.customProgramCacheKey = () => "ares-suit-skin-v1";
  mat.needsUpdate = true;
}

// ---------------------------------------------------------------- hard parts
const helmetGlass = new THREE.MeshStandardMaterial({
  color: 0xdfeef2, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.16,
  depthWrite: false, side: THREE.FrontSide, envMapIntensity: 2.4,
});
const visorGold = new THREE.MeshStandardMaterial({ color: 0xd8a640, roughness: 0.16, metalness: 1.0 });
const ringMetal = new THREE.MeshStandardMaterial({ color: 0xb7bcc2, roughness: 0.32, metalness: 0.9 });
const shellWhite = new THREE.MeshStandardMaterial({ color: 0xe8e5de, roughness: 0.5, metalness: 0.05 });
const shellDark = new THREE.MeshStandardMaterial({ color: 0x3b4047, roughness: 0.55, metalness: 0.3 });
const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 2.0, roughness: 0.3 });

export function attachAstronaut(root: THREE.Object3D, bones: Record<string, THREE.Object3D>, ally = false): AstronautRig {
  refreshTeamMats();
  const [allyCol, enemyCol] = suitTeamColors();
  const teamU = { value: (ally ? allyCol : enemyCol).clone() };
  // 1) the suit skin, on this actor's own (already cloned) materials
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton) return;
    suitAttributes(m);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (mat instanceof THREE.MeshStandardMaterial) dressMaterial(mat, teamU);
  });
  // 2) hard parts, built once per source geometry
  let key = "";
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) key += (o as THREE.Mesh).geometry.uuid; });
  let templates = gearCache.get(key);
  if (!templates) {
    templates = [];
    const attach = (bone: string, g: THREE.Group, merge = true) => {
      const target = bones[bone];
      if (!target || !g.children.length) return;
      if (merge) bake(g);
      // Equipment never casts: the skinned body already supplies the shadow
      // silhouette, and every extra caster is another shadow-map draw per actor.
      g.traverse((o) => { o.castShadow = false; if ((o as THREE.Mesh).material === helmetGlass) o.renderOrder = 3; });
      g.name = "ARES EVA / " + bone;
      target.updateWorldMatrix(true, false);
      g.applyMatrix4(target.matrixWorld.clone().invert());
      templates!.push({ bone, group: g });
    };
    const h = region(root, ["Head", "NeckTwist01", "NeckTwist02"]);
    if (!h.isEmpty()) {
      const c = h.getCenter(new THREE.Vector3());
      const d = h.getSize(new THREE.Vector3());
      const R = Math.max(d.x, d.y, d.z) * 0.53 + 0.015;
      const g = new THREE.Group();
      const hc = new THREE.Vector3(c.x, c.y + 0.015, c.z + 0.012);
      // bubble: one clear sphere, the ape's face fully readable inside it
      const bubble = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 28), helmetGlass);
      bubble.position.copy(hc);
      bubble.renderOrder = 3;
      g.add(bubble);
      // hard back shell (white) over the rear half — classic EVA bubble helmets
      // are opaque behind the ears
      const shell = new THREE.Mesh(new THREE.SphereGeometry(R * 1.012, 40, 24, Math.PI * 0.5 + 1.15, Math.PI * 2 - 2.3, 0, Math.PI * 0.7), shellWhite);
      shell.position.copy(hc);
      g.add(shell);
      // raised gold sun visor: a slim band across the brow, lifted clear of the face
      const visor = new THREE.Mesh(new THREE.SphereGeometry(R * 1.03, 40, 12, Math.PI * 0.5 - 1.2, 2.4, Math.PI * 0.1, Math.PI * 0.2), visorGold);
      visor.position.copy(hc);
      g.add(visor);
      // neck ring: a compact machined bearing collar on the shoulders
      const ringY = c.y - d.y * 0.5 - 0.01;
      for (const [r, t, mat, dy] of [[R * 0.74, 0.042, ringMetal, 0], [R * 0.78, 0.026, shellWhite, -0.04], [R * 0.7, 0.014, shellDark, 0.034]] as const) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 14, 48), mat);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(c.x, ringY + dy, c.z + 0.012);
        g.add(ring);
      }
      // helmet lamps, left and right of the brow
      for (const s of [-1, 1]) {
        const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.06, 16), shellWhite);
        housing.rotation.x = Math.PI / 2;
        housing.position.set(hc.x + s * R * 0.86, hc.y + R * 0.2, hc.z + R * 0.28);
        g.add(housing);
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 16), lamp);
        lens.rotation.x = Math.PI / 2;
        lens.position.set(hc.x + s * R * 0.86, hc.y + R * 0.2, hc.z + R * 0.28 + 0.032);
        g.add(lens);
      }
      attach("Head", g);
    }
    const chest = region(root, ["Spine02", "Spine01"]);
    if (!chest.isEmpty()) {
      const c = chest.getCenter(new THREE.Vector3());
      const d = chest.getSize(new THREE.Vector3());
      const w = Math.min(0.62, Math.max(0.38, d.x * 0.92));
      const g = new THREE.Group();
      // life-support pack: slim, rounded, with vents and a team stripe
      const back = chest.min.z - 0.01;
      round(g, shellWhite, c.x, c.y + 0.06, back - 0.07, w * 0.78, Math.max(0.34, d.y * 0.95), 0.15);
      round(g, shellDark, c.x, c.y + 0.06, back - 0.146, w * 0.62, Math.max(0.26, d.y * 0.72), 0.02);
      for (let i = 0; i < 4; i++) box(g, shellWhite, c.x, c.y - 0.04 + i * 0.05, back - 0.152, w * 0.5, 0.012, 0.014);
      round(g, teams[0]!, c.x, c.y + 0.06 + Math.max(0.34, d.y * 0.95) / 2 - 0.03, back - 0.07, w * 0.79, 0.035, 0.152);
      for (const s of [-1, 1]) {
        part(g, unitCylinder, ringMetal, c.x + s * w * 0.42, c.y + 0.02, back - 0.06, 0.036, 0.26, 0.036);
      }
      // chest control unit: a small display block with a status strip
      const front = chest.max.z + 0.02;
      round(g, shellWhite, c.x, c.y + 0.02, front, 0.2, 0.12, 0.07);
      box(g, shellDark, c.x, c.y + 0.035, front + 0.036, 0.15, 0.055, 0.006);
      box(g, glow, c.x - 0.03, c.y + 0.04, front + 0.04, 0.06, 0.012, 0.004);
      for (let i = 0; i < 3; i++) part(g, unitCylinder, teams[0]!, c.x - 0.05 + i * 0.05, c.y - 0.025, front + 0.035, 0.012, 0.012, 0.012).rotation.x = Math.PI / 2;
      attach("Spine02", g);
    }
    gearCache.set(key, templates);
  }
  const panels: THREE.Mesh[] = [];
  for (const { bone, group } of templates) {
    const item = group.clone(true);
    item.traverse((o) => { if (o.userData.evaTeam) panels.push(o as THREE.Mesh); });
    bones[bone]?.add(item);
  }
  const rig = { setAlly(ally: boolean) {
    // A colour-vision change repaints through here (BruiserActor.setRelation
    // re-runs on prefs().colorMode), so both the fabric uniform and the shared
    // hardware materials are refreshed off teamColors() every time.
    refreshTeamMats();
    const [allyCol, enemyCol] = suitTeamColors();
    teamU.value.copy(ally ? allyCol : enemyCol);
    for (const panel of panels) panel.material = teams[ally ? 0 : 1]!;
  } };
  rig.setAlly(ally);
  return rig;
}

let heliosTemplate: THREE.Group | null = null;

/** HELIOS H-6: ceramic coil carbine, authored in the existing +Z bore convention. */
export function makeHeliosGun(): THREE.Group {
  if (!heliosTemplate) {
    const g = new THREE.Group();
    g.name = "HELIOS H-6 / pulse carbine";
    round(g, seam, 0, 0.007, 0.02, 0.086, 0.082, 0.34);
    round(g, ivory, 0, 0.042, 0.015, 0.105, 0.049, 0.3);
    round(g, titanium, 0, 0.007, -0.18, 0.05, 0.045, 0.15);
    round(g, seam, 0, -0.001, -0.257, 0.082, 0.095, 0.029);
    round(g, ivory, 0, 0.028, -0.205, 0.088, 0.032, 0.09);
    const grip = box(g, seam, 0, -0.084, -0.066, 0.044, 0.105, 0.044);
    grip.rotation.x = 0.2;
    box(g, titanium, 0, -0.062, 0.004, 0.016, 0.012, 0.065);
    box(g, seam, 0, -0.037, 0.031, 0.015, 0.06, 0.015);
    // Cylindrical replaceable capacitor recalls the Kong launcher's drum.
    const drum = part(g, unitCylinder, titanium, 0, -0.055, 0.065, 0.067, 0.132, 0.067);
    drum.rotation.z = Math.PI / 2;
    const core = part(g, unitCylinder, copper, 0, -0.055, 0.065, 0.059, 0.139, 0.059);
    core.rotation.z = Math.PI / 2;
    for (const s of [-1, 1]) {
      const cap = part(g, unitCylinder, seam, s * 0.073, -0.055, 0.065, 0.044, 0.008, 0.044);
      cap.rotation.z = Math.PI / 2;
      const dot = part(g, unitCylinder, glow, s * 0.079, -0.055, 0.065, 0.016, 0.008, 0.016);
      dot.rotation.z = Math.PI / 2;
      round(g, ivory, s * 0.052, 0.016, 0.195, 0.035, 0.07, 0.24);
      round(g, seam, s * 0.071, 0.016, 0.2, 0.006, 0.039, 0.18);
      box(g, glow, s * 0.076, 0.02, 0.21, 0.006, 0.009, 0.16);
      box(g, copper, s * 0.061, 0.048, 0.155, 0.006, 0.017, 0.08);
      for (let i = 0; i < 4; i++) box(g, titanium, s * 0.074, 0.024, 0.125 + i * 0.048, 0.01, 0.063, 0.012);
    }
    const bore = part(g, unitCylinder, titanium, 0, 0.02, 0.325, 0.025, 0.12, 0.025);
    bore.rotation.x = Math.PI / 2;
    const nose = part(g, unitCylinder, seam, 0, 0.02, 0.388, 0.04, 0.06, 0.04);
    nose.rotation.x = Math.PI / 2;
    part(g, unitRing, copper, 0, 0.02, 0.416, 0.037, 0.037, 0.16);
    part(g, unitRing, glow, 0, 0.02, 0.419, 0.024, 0.024, 0.11);
    // Open collimator hood: real window space, unobstructed sight line.
    for (const s of [-1, 1]) round(g, ivory, s * 0.027, 0.093, -0.02, 0.009, 0.05, 0.032);
    round(g, seam, 0, 0.12, -0.02, 0.062, 0.009, 0.032);
    box(g, copper, 0, 0.126, -0.02, 0.035, 0.003, 0.022);
    box(g, glow, 0, 0.085, 0.005, 0.004, 0.004, 0.003);
    // Real geometry serial marks and tiny energy gauges survive close inspection.
    for (let i = 0; i < 5; i++) box(g, glow, 0.054, 0.028, -0.064 + i * 0.017, 0.004, 0.008, 0.009);
    heliosTemplate = bake(g);
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#14222b"; ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = "#f0f1df"; ctx.font = "700 74px sans-serif"; ctx.fillText("HELIOS", 30, 100);
    ctx.fillStyle = "#e6a454"; ctx.fillRect(30, 130, 280, 8);
    ctx.font = "32px monospace"; ctx.fillStyle = "#a6c2c9"; ctx.fillText("H-06 / PULSE SYSTEM", 30, 191);
    ctx.font = "20px monospace"; ctx.fillStyle = "#91a7ac"; ctx.fillText("ARES // SERIAL 006-042", 30, 229);
    const decalMap = new THREE.CanvasTexture(canvas);
    decalMap.colorSpace = THREE.SRGBColorSpace;
    decalMap.anisotropy = 4;
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.071, 0.036),
      new THREE.MeshStandardMaterial({ map: decalMap, roughness: 0.58, metalness: 0.2 }));
    decal.name = "HELIOS / laser-etched identity";
    decal.rotation.x = -Math.PI / 2;
    decal.rotation.z = Math.PI;
    decal.position.set(0, 0.067, -0.092);
    heliosTemplate.add(decal);
    heliosTemplate.userData.muzzle = new THREE.Vector3(0, 0.02, 0.424);
    heliosTemplate.userData.optic = new THREE.Vector3(0, 0.094, 0.005);
    heliosTemplate.userData.helios = true;
  }
  const out = heliosTemplate.clone(true);
  // Object3D.clone JSON-copies userData, so restore typed immutable anchors.
  out.userData.muzzle = heliosTemplate.userData.muzzle;
  out.userData.optic = heliosTemplate.userData.optic;
  out.userData.helios = true;
  return out;
}

/** Ivory gauntlet around the familiar three-knuckle Kong paw. */
export function dressSpacePaw(paw: THREE.Group): void {
  const g = new THREE.Group();
  box(g, ivory, 0, 0.022, 0.004, 0.065, 0.026, 0.057);
  for (let i = 0; i < 3; i++) box(g, ivory, (i - 1) * 0.023, 0.012, 0.039, 0.02, 0.021, 0.025);
  const cuff = part(g, unitCylinder, ivory, 0, -0.012, -0.056, 0.042, 0.046, 0.042);
  cuff.rotation.x = Math.PI / 2 - 0.25;
  box(g, copper, 0, 0.026, -0.052, 0.039, 0.014, 0.016);
  box(g, glow, -0.022, 0.027, -0.052, 0.012, 0.008, 0.012);
  paw.add(bake(g));
}
