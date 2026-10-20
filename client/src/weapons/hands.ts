/**
 * FIRST-PERSON HANDS — tactical gloves on a skinned rig, ported from Kong
 * Royale's weapons/hands.ts (the bones, the bind pose and the grip solver that
 * wraps every finger segment AROUND a grip's cross-section, never through it)
 * and restyled from bare kong fingers + banana peel into a modern shooting
 * glove: a black synthetic back, a molded TPR knuckle guard, padded finger
 * segments, a coyote synthetic-leather palm, a velcro wrist strap, and the
 * operator's combat-shirt sleeve (ranger green) with a hint of brown fur where
 * the cuff meets the glove.
 *
 * HAND FRAME (canonical right hand): the grip axis is +Y (index finger at +Y,
 * pinky at -Y); the palm lies on the +X side of the grip (its inner face
 * touches the grip at x = a); the fingers wrap +X -> -Z -> -X; the thumb wraps
 * the other way round the back (+Z). The wrist / forearm leave the heel of the
 * palm toward +Z. The left hand is the mirror image (x -> -x).
 *
 * Posing: setGrip(a, b, curl, thumb) -> finger / thumb bone angles (curl 0 =
 * relaxed open hand, 1 = wrapped tight round an a x b ellipse);
 * aimForearmLocal(p) -> the wrist bone turns the sleeve toward an elbow point
 * given in the hand mesh's own space. Zero allocation per frame.
 *
 * One SkinnedMesh per hand, three material groups (glove, armour, sleeve).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { rbox } from "./lib/geo";
import { rng } from "./lib/mats";

// ------------------------------------------------------------------ dimensions (m)
/** palm: thickness (x), width along the grip (y), length heel -> knuckles (z) */
const PT = 0.029, PW = 0.084, PL = 0.09;
/** finger rows along the grip axis (index -> pinky) */
const FY = [0.0295, 0.0098, -0.0098, -0.0285];
/** finger radius (gloved) */
const FR = [0.0087, 0.0091, 0.0088, 0.0078];
/** finger segment lengths (proximal, middle, distal) */
const FL: number[][] = [
  [0.043, 0.026, 0.022],
  [0.047, 0.029, 0.023],
  [0.045, 0.027, 0.022],
  [0.035, 0.021, 0.019],
];
const TR = [0.0112, 0.0099, 0.009];
const TL = [0.036, 0.03, 0.026];
/** thumb base (palm space): heel end, index side, grip face */
const T0 = new THREE.Vector3(-PT / 2 + 0.011, PW / 2 - 0.006, PL / 2 - 0.026);
/** wrist (bone origin) to elbow centre: the forearm sleeve ends in a closed elbow here */
export const FORE_LEN = 0.28;

// ------------------------------------------------------------------ materials
export interface HandMats { glove: THREE.Material; armour: THREE.Material; sleeve: THREE.Material }
let mats: HandMats | null = null;

function canvas(n: number) {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  return c;
}

/** tileable height field -> normal map */
function normalTex(n: number, h: Float32Array, k: number): THREE.CanvasTexture {
  const c = canvas(n), x = c.getContext("2d")!, img = x.createImageData(n, n);
  const H = (i: number, j: number) => h[((j + n) % n) * n + ((i + n) % n)]!;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const dx = (H(i + 1, j) - H(i - 1, j)) * k, dy = (H(i, j + 1) - H(i, j - 1)) * k;
      const l = Math.hypot(dx, dy, 1), o = (j * n + i) * 4;
      img.data[o] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[o + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[o + 2] = (1 / l) * 255;
      img.data[o + 3] = 255;
    }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** a plain weave (sleeve fabric) */
function weave(): THREE.CanvasTexture {
  const n = 128, h = new Float32Array(n * n), r = rng(5);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = (i / n) * 32 * Math.PI, v = (j / n) * 32 * Math.PI;
      const over = Math.sin(u) * Math.sin(v) > 0 ? 1 : 0;
      h[j * n + i] = over * (0.5 + 0.5 * Math.abs(Math.cos(v))) + (1 - over) * (0.5 + 0.5 * Math.abs(Math.cos(u))) + r() * 0.25;
    }
  return normalTex(n, h, 0.9);
}

/** the glove's synthetic: a fine grain with a faint diamond quilting */
function grain(): THREE.CanvasTexture {
  const n = 128, h = new Float32Array(n * n), r = rng(17);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = (i / n) * Math.PI * 16, v = (j / n) * Math.PI * 16;
      h[j * n + i] = r() * 0.5 + 0.18 * Math.abs(Math.sin((u + v) * 0.5)) + 0.18 * Math.abs(Math.sin((u - v) * 0.5));
    }
  return normalTex(n, h, 0.7);
}

export function handMaterials(): HandMats {
  if (mats) return mats;
  const g = grain(), w = weave();
  const glove = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.86, metalness: 0,
    normalMap: g, normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: 0.32,
  });
  // molded TPR: a satin sheen that picks out the knuckle ribs
  const armour = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.58, metalness: 0,
    normalMap: g, normalScale: new THREE.Vector2(0.15, 0.15), envMapIntensity: 0.5,
  });
  const sleeve = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.93, metalness: 0,
    normalMap: w, normalScale: new THREE.Vector2(0.7, 0.7), envMapIntensity: 0.35,
  });
  glove.name = "vm-glove";
  armour.name = "vm-glove-armour";
  sleeve.name = "vm-sleeve";
  mats = { glove, armour, sleeve };
  return mats;
}

// ------------------------------------------------------------------ palette
const BACK = new THREE.Color("#222326");
const BACK_SH = new THREE.Color("#18191b");
const PALM = new THREE.Color("#3b3c3f");
const PALM_SH = new THREE.Color("#2e2f32");
const SEAM = new THREE.Color("#0f1011");
const TPR = new THREE.Color("#2f3135");
const TPR_HI = new THREE.Color("#45484d");
const STRAP = new THREE.Color("#2a2b2e");
const SLEEVE = new THREE.Color("#4a5040");
const SLEEVE_SH = new THREE.Color("#353a2e");

// ------------------------------------------------------------------ helpers
function colorize(g: THREE.BufferGeometry, c: THREE.Color) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}
function paint(g: THREE.BufferGeometry, f: (p: THREE.Vector3, out: THREE.Color) => void) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3), p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(g.attributes.position as THREE.BufferAttribute, i);
    f(p, c);
    a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}
function skin(g: THREE.BufferGeometry, bone: number, bone2 = bone, w2: (p: THREE.Vector3) => number = () => 0) {
  const n = g.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(g.attributes.position as THREE.BufferAttribute, i);
    const k = bone2 === bone ? 0 : Math.min(1, Math.max(0, w2(p)));
    si[i * 4] = bone; si[i * 4 + 1] = bone2; sw[i * 4] = 1 - k; sw[i * 4 + 1] = k;
  }
  g.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  return g;
}
/** a ring-strip surface: rows i = 0..N along t, columns j = 0..AN round a */
function tube(N: number, AN: number, f: (t: number, a: number, pos: THREE.Vector3, col: THREE.Color) => void, flip = false): THREE.BufferGeometry {
  const pos: number[] = [], cols: number[] = [], idx: number[] = [], p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= AN; j++) {
      f(i / N, (j / AN) * Math.PI * 2, p, c);
      pos.push(p.x, p.y, p.z);
      cols.push(c.r, c.g, c.b);
    }
  for (let i = 0; i < N; i++)
    for (let j = 0; j < AN; j++) {
      const a = i * (AN + 1) + j, b = a + AN + 1;
      if (flip) idx.push(a, b, a + 1, a + 1, b, b + 1);
      else idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  return g;
}
const sm = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ geometry
const B_PALM = 1, B_WRIST = 2, B_F = 3 /* 3 + finger*3 + seg */, B_T = 15;
interface HandGeo { geo: THREE.BufferGeometry; bones: THREE.Bone[] }

function buildHandGeo(mirror: boolean): HandGeo {
  const sx = mirror ? -1 : 1;
  const glove: THREE.BufferGeometry[] = [], armour: THREE.BufferGeometry[] = [], sleeve: THREE.BufferGeometry[] = [];
  // ---- bones (bind pose: open flat hand, palm at x = PX0)
  const PX0 = 0.03 + PT / 2;
  const root = new THREE.Bone(); root.name = "root";
  const palm = new THREE.Bone(); palm.name = "palm"; palm.position.set(sx * PX0, 0, 0); root.add(palm);
  const wrist = new THREE.Bone(); wrist.name = "wrist"; wrist.position.set(sx * 0.003, 0, PL / 2 - 0.008); palm.add(wrist);
  const bones: THREE.Bone[] = [root, palm, wrist];
  const fingerBones: THREE.Bone[][] = [];
  for (let f = 0; f < 4; f++) {
    const row: THREE.Bone[] = [];
    let parent: THREE.Bone = palm;
    for (let s = 0; s < 3; s++) {
      const b = new THREE.Bone(); b.name = `f${f}${s}`;
      if (s === 0) b.position.set(sx * (-PT / 2 + FR[f]! + 0.002), FY[f]!, -PL / 2 + 0.006);
      else b.position.set(0, 0, -FL[f]![s - 1]!);
      parent.add(b); parent = b; row.push(b); bones.push(b);
    }
    fingerBones.push(row);
  }
  {
    let parent: THREE.Bone = palm;
    for (let s = 0; s < 3; s++) {
      const b = new THREE.Bone(); b.name = `t${s}`;
      if (s === 0) b.position.set(sx * T0.x, T0.y, T0.z); else b.position.set(0, 0, -TL[s - 1]!);
      parent.add(b); parent = b; bones.push(b);
    }
  }
  root.updateMatrixWorld(true);
  const world = (b: THREE.Bone) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const pc = world(palm);

  // ---- palm block: the coyote palm on the grip face, black synthetic on the back
  {
    const g = rbox(PT, PW, PL, 0.012, 3);
    g.translate(pc.x, pc.y, pc.z);
    glove.push(skin(paint(g, (p, c) => {
      const side = ((p.x - pc.x) * sx) / (PT / 2); // -1 grip face .. +1 back
      if (side < -0.25) c.copy(PALM).lerp(PALM_SH, sm((p.z - pc.z) / PL + 0.3) * 0.4);
      else c.copy(BACK).lerp(BACK_SH, 0.3);
      // a stitched seam where palm meets back
      if (Math.abs(side + 0.25) < 0.1) c.lerp(SEAM, 0.7);
    }), B_PALM));
    // the back of the hand: a low dome (tendons under the synthetic), up to the knuckle guard
    const dome = new THREE.SphereGeometry(1, 24, 14);
    dome.scale(PT * 0.3, PW * 0.46, PL * 0.42);
    const dc = new THREE.Vector3(pc.x + sx * PT * 0.22, pc.y, pc.z + 0.006);
    dome.translate(dc.x, dc.y, dc.z);
    glove.push(skin(paint(dome, (p, c) => {
      c.copy(BACK);
      const w = (p.z - dc.z) / (PL * 0.5);
      if (w > 0.4) c.lerp(BACK_SH, (w - 0.4) * 0.8);
      // panel seams running down the back of the hand
      for (const y of [FY[0]! * 0.5 + FY[1]! * 0.5, FY[2]! * 0.5 + FY[3]! * 0.5]) if (Math.abs(p.y - y) < 0.0012 && w > -0.2) c.lerp(SEAM, 0.55);
    }), B_PALM));
    // KNUCKLE GUARD: a molded TPR plate across the knuckle row with four raised domes and a rib behind them
    {
      const kz = pc.z - PL / 2 + 0.014;
      const plate = rbox(0.0055, PW * 0.9, 0.026, 0.0026, 2);
      plate.translate(pc.x + sx * (PT / 2 + 0.0005), pc.y - 0.001, kz + 0.004);
      armour.push(skin(paint(plate, (p, c) => { c.copy(TPR); if (Math.abs(p.z - kz - 0.004) > 0.012) c.lerp(SEAM, 0.3); }), B_PALM));
      // two low ribs across the plate instead of four domes (domes read as brass knuckles)
      for (const dz of [-0.006, 0.004]) {
        const r = rbox(0.0024, PW * 0.84, 0.004, 0.0011, 2);
        r.translate(pc.x + sx * (PT / 2 + 0.003), pc.y - 0.001, kz + dz);
        armour.push(skin(paint(r, (_p, c) => c.copy(TPR_HI).lerp(TPR, 0.4)), B_PALM));
      }
      // the rib over the back of the hand (a second, smaller bar)
      const rib = rbox(0.004, PW * 0.55, 0.01, 0.0018, 2);
      rib.translate(pc.x + sx * (PT / 2 + 0.0008), pc.y + 0.004, kz + 0.03);
      armour.push(skin(colorize(rib, TPR), B_PALM));
    }
    // thumb-index webbing
    {
      const a = new THREE.Vector3(pc.x + sx * (T0.x - 0.004), T0.y - 0.004, T0.z);
      const bk = new THREE.Vector3(pc.x + sx * (-PT / 2 + FR[0]! + 0.004), FY[0]!, -PL / 2 + 0.012);
      const d = bk.clone().sub(a), L = d.length();
      const w = new THREE.CapsuleGeometry(0.0095, L, 4, 10);
      w.scale(1, 1, 0.75);
      w.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
      w.translate((a.x + bk.x) / 2, (a.y + bk.y) / 2, (a.z + bk.z) / 2);
      glove.push(skin(colorize(w, BACK), B_PALM, B_T, (q) => Math.max(0, Math.min(1, 1 - q.clone().sub(a).dot(d) / (L * L)))));
    }
  }

  // ---- fingers + thumb: one continuous tube along 3 bones, smooth-skinned across each joint
  const chain = (base: THREE.Vector3, lens: number[], r0: number, taper: number, b0: number, swell: number, flat: number, ys: number, b1 = -1, pads = true): THREE.BufferGeometry => {
    const total = lens.reduce((a, c) => a + c, 0) + r0 * 0.8, j1 = lens[0]!, j2 = lens[0]! + lens[1]!;
    const radial = 16, rows = 34;
    const g = new THREE.CylinderGeometry(1, 1, 1, radial, rows, false);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -0.5);
    const pos = g.attributes.position as THREE.BufferAttribute, n = pos.count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), col = new Float32Array(n * 3), c = new THREE.Color();
    // rows bunch up toward the tip (u -> 1): the rounded fingertip gets ~8 rows, not 2 (it read as a spike)
    const warp = (v: number) => (v < 0.7 ? v * (0.55 / 0.7) : 0.55 + ((v - 0.7) / 0.3) * 0.45);
    for (let i = 0; i < n; i++) {
      const u = warp(-pos.getZ(i)), d = u * total;
      let ax = pos.getX(i), ay = pos.getY(i);
      // a gently squared section: a gloved finger, not a sausage
      const k = Math.pow(Math.pow(Math.abs(ax), 2.5) + Math.pow(Math.abs(ay), 2.5), -1 / 2.5);
      if (Number.isFinite(k)) { ax *= k; ay *= k; }
      let r = r0 * (1 - taper * u);
      for (const jz of [0, j1, j2]) r *= 1 + swell * Math.exp(-Math.pow((d - jz) / (r0 * 0.7), 2));
      const tipU = (d - (total - r0 * 1.1)) / (r0 * 1.1);
      if (tipU > 0) r *= Math.sqrt(Math.max(0, 1 - Math.min(1, tipU) ** 2)) * 0.98 + 0.02;
      const rootU = d / (r0 * 0.5);
      if (rootU < 1) r *= 0.8 + 0.2 * rootU;
      const back = ax * sx; // outboard (+1) = back of the finger
      // padded segment on the back of the proximal and middle phalanx
      let pad = 0;
      if (pads && back > 0.35) {
        const inSeg = (a0: number, a1: number) => sm((d - a0) / 0.004) * (1 - sm((d - a1) / 0.004));
        pad = Math.max(inSeg(r0 * 0.6, j1 - r0 * 0.55), inSeg(j1 + r0 * 0.5, j2 - r0 * 0.5) * 0.7) * (back - 0.35) / 0.65;
      }
      const fx = back > 0 ? flat : 1;
      pos.setXYZ(i, base.x + ax * r * fx * (1 + 0.12 * pad), base.y + ay * r * ys, base.z - Math.min(d, total));
      const bw = r0 * 0.9;
      let bA = 0, bB = 0, kk = 0;
      if (d < j1 - bw) { bA = 0; bB = 0; }
      else if (d < j1 + bw) { bA = 0; bB = 1; kk = (d - (j1 - bw)) / (2 * bw); }
      else if (d < j2 - bw) { bA = 1; bB = 1; }
      else if (d < j2 + bw) { bA = 1; bB = 2; kk = (d - (j2 - bw)) / (2 * bw); }
      else { bA = 2; bB = 2; }
      kk = kk * kk * (3 - 2 * kk);
      si[i * 4] = b0 + bA; si[i * 4 + 1] = b0 + bB; sw[i * 4] = 1 - kk; sw[i * 4 + 1] = kk;
      if (b1 >= 0) {
        si[i * 4 + 2] = b1 + bA; si[i * 4 + 3] = b1 + bB;
        sw[i * 4] *= 0.5; sw[i * 4 + 1] *= 0.5; sw[i * 4 + 2] = (1 - kk) * 0.5; sw[i * 4 + 3] = kk * 0.5;
      }
      // paint: black back, coyote palm side, darker seams across the back of the joints, a reinforced fingertip
      if (back < -0.15) c.copy(PALM).lerp(PALM_SH, 0.25);
      else if (back < 0.15) c.copy(BACK).lerp(PALM, 0.25);
      else c.copy(BACK);
      if (pad > 0.3) c.lerp(TPR, 0.8 * pad);
      if (back > 0.1) for (const jz of [j1, j2]) { const q = Math.abs(d - jz) / (r0 * 0.28); if (q < 1) c.lerp(SEAM, 0.6 * (1 - q * q)); }
      if (d > total - r0 * 2.0) c.lerp(PALM_SH, back < 0.3 ? 0.5 : 0.15);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.computeVertexNormals();
    g.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
    g.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  };
  for (let f = 0; f < 4; f++) {
    const p = world(fingerBones[f]![0]!);
    glove.push(chain(p, FL[f]!, FR[f]!, 0.12, B_F + f * 3, 0.07, 0.86, 0.94));
    if (f < 3) {
      // (ZERO-FLICKER) the webbing starts 2.5 mm ahead of the finger roots: no root cap shares their plane
      const q = world(fingerBones[f + 1]![0]!), mid = p.clone().lerp(q, 0.5).add(new THREE.Vector3(0, 0, -0.0025));
      glove.push(chain(mid, [FL[f]![0]! * 0.5, 0.0005, 0.0005], (FR[f]! + FR[f + 1]!) * 0.42, 0.1, B_F + f * 3, 0, 0.85, 1.0, B_F + (f + 1) * 3, false));
    }
  }
  {
    const tb = bones.slice(B_T, B_T + 3), p = world(tb[0]!);
    glove.push(chain(p, TL, TR[0]! * 0.9, 0.22, B_T, 0.06, 0.86, 1.04));
    const m = new THREE.SphereGeometry(1, 18, 12);
    m.scale(PT * 0.5, TR[0]! * 1.8, TL[0]! * 0.95);
    m.translate(p.x + sx * PT * 0.1, p.y - TR[0]! * 0.6, p.z + TL[0]! * 0.15);
    glove.push(skin(paint(m, (q, c) => { c.copy(((q.x - p.x) * sx) < 0 ? PALM : BACK); }), B_PALM, B_T, (q) => Math.max(0, Math.min(0.6, (p.z - q.z) / (TL[0]! * 1.2)))));
  }

  // ---- the cuff: glove gauntlet + velcro strap, the sleeve over the forearm, a fringe of fur between them
  const wc = world(wrist);
  const blendC = (p: THREE.Vector3) => (p.z - wc.z) / 0.03;
  // gauntlet: the hand end hugs the heel of the palm, flaring a touch to the cuff
  glove.push(skin(tube(14, 32, (t, a, p, c) => {
    const z = -0.022 + t * 0.07;
    let r = 0.028 + 0.003 * sm(t * 1.4);
    if (t > 0.94) r -= 0.002 * ((t - 0.94) / 0.06);
    const ex = 0.82, ey = 1.12;
    p.set(wc.x + Math.cos(a) * r * ex, wc.y + Math.sin(a) * r * ey, wc.z + z);
    c.copy(BACK);
    if (Math.cos(a) * sx < -0.3 && t < 0.4) c.copy(PALM_SH);
  }), B_PALM, B_WRIST, blendC));
  // the velcro strap: a raised band with a pull tab on the back of the wrist
  armour.push(skin(tube(6, 32, (t, a, p, c) => {
    const z = 0.006 + t * 0.022;
    const r = 0.0318 + 0.0014 * Math.sin(Math.PI * t);
    p.set(wc.x + Math.cos(a) * r * 0.84, wc.y + Math.sin(a) * r * 1.12, wc.z + z);
    c.copy(STRAP);
    if (t < 0.12 || t > 0.88) c.lerp(SEAM, 0.5);
  }), B_PALM, B_WRIST, blendC));
  {
    const tab = rbox(0.006, 0.022, 0.026, 0.003, 2);
    tab.translate(wc.x + sx * 0.0275, wc.y - 0.006, wc.z + 0.016);
    armour.push(skin(paint(tab, (_p, c) => c.copy(TPR)), B_PALM, B_WRIST, blendC));
  }
  // (a fur fringe at the cuff was tried and read as claws: the sleeve hem meets the glove cuff cleanly)
  // the sleeve: a combat-shirt cuff (a rolled hem), the forearm with soft folds, closed round the elbow
  const S_END = FORE_LEN + 0.045;
  sleeve.push(skin(tube(40, 36, (t, a, p, c) => {
    const z = 0.044 + t * (S_END - 0.044);
    const zz = z - 0.044;
    let r = 0.04 + 0.009 * sm(zz / 0.2) - 0.003 * sm((zz - 0.18) / 0.06);
    // the elbow end closes into a dome round the joint
    const e = (z - (S_END - 0.05)) / 0.05;
    if (e > 0) r *= Math.sqrt(Math.max(0, 1 - Math.min(1, e) ** 2)) * 0.97 + 0.03;
    // the hem: a rolled lip
    if (zz < 0.012) r += 0.002 * Math.sin((zz / 0.012) * Math.PI);
    // folds: gathered rings near the wrist, a long crease down the side
    const fold = Math.sin(zz * 95 + Math.sin(a * 2) * 1.4) * 0.0018 * (1 - sm((zz - 0.12) / 0.2));
    const crease = 0.0014 * Math.sin(a * 5 + zz * 9);
    r += fold + crease;
    p.set(wc.x + Math.cos(a) * r * 0.9, wc.y + Math.sin(a) * r * 1.06, wc.z + z);
    c.copy(SLEEVE);
    if (fold < -0.0008) c.lerp(SLEEVE_SH, 0.5);
    if (zz < 0.004) c.lerp(SLEEVE_SH, 0.6);
    if (Math.cos(a) * sx < -0.5) c.lerp(SLEEVE_SH, 0.25);
  }), B_PALM, B_WRIST, (p) => (p.z - wc.z) / 0.03));
  // close the hem's inside so the sleeve never reads as a hollow pipe
  sleeve.push(skin(tube(2, 36, (t, a, p, c) => {
    const r = 0.04 - t * 0.007;
    p.set(wc.x + Math.cos(a) * r * 0.9, wc.y + Math.sin(a) * r * 1.06, wc.z + 0.044 + t * 0.004);
    c.copy(SLEEVE_SH).multiplyScalar(0.5);
  }, true), B_WRIST));

  // ---- merge: group 0 glove, 1 armour, 2 sleeve
  const flat = (gs: THREE.BufferGeometry[]) => gs.map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(x.attributes)) if (!["position", "normal", "uv", "color", "skinIndex", "skinWeight"].includes(k)) x.deleteAttribute(k);
    if (!x.attributes.uv) x.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    if (!x.attributes.color) colorize(x, BACK);
    return x;
  });
  const gl = mergeGeometries(flat(glove))!, ar = mergeGeometries(flat(armour))!, sl = mergeGeometries(flat(sleeve))!;
  for (const [g, k] of [[gl, 60], [ar, 60], [sl, 34]] as Array<[THREE.BufferGeometry, number]>) {
    const pos = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
      const x = pos.getX(i) * k, y = pos.getY(i) * k, z = pos.getZ(i) * k;
      if (ax >= ay && ax >= az) uv.setXY(i, y, z); else if (ay >= az) uv.setXY(i, x, z); else uv.setXY(i, x, y);
    }
  }
  const geo = mergeGeometries([gl, ar, sl], true)!;
  geo.computeBoundingSphere();
  return { geo, bones };
}

const geoCache: Partial<Record<"R" | "L", HandGeo>> = {};

// ------------------------------------------------------------------ grip solver (KR, unchanged)
const SCAN = 72;
/**
 * Planar chain around an offset ellipse (a + rr, b + rr) in the canonical XZ
 * plane; returns absolute angles (about +Y, from -Z toward -X). wrap = +1:
 * phi increasing (+X -> -Z -> -X), -1: decreasing (+X -> +Z -> -X).
 */
function wrapChain(px: number, pz: number, lens: number[], rr: number, a: number, b: number, wrap: number, out: number[]) {
  const A = a + rr, Bz = b + rr;
  const ex = (f: number) => A * Math.cos(f), ez = (f: number) => -Bz * Math.sin(f);
  let x = px, z = pz;
  let phi = Math.atan2(-z / Bz, x / A);
  for (let s = 0; s < lens.length; s++) {
    const L = lens[s]!;
    let lo = phi, hi = phi, found = false, best = phi, bestD = 1e9;
    for (let i = 1; i <= SCAN; i++) {
      const f = phi + wrap * (i / SCAN) * Math.PI * 1.2;
      const d = Math.hypot(ex(f) - x, ez(f) - z);
      if (d < bestD) { bestD = d; best = f; }
      if (d >= L) { hi = f; lo = phi + wrap * ((i - 1) / SCAN) * Math.PI * 1.2; found = true; break; }
    }
    let tx: number, tz: number;
    if (found) {
      for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (Math.hypot(ex(m) - x, ez(m) - z) >= L) hi = m; else lo = m; }
      tx = ex(hi); tz = ez(hi); phi = hi;
    } else { tx = ex(best); tz = ez(best); phi = best; }
    let dx = tx - x, dz = tz - z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    out[s] = Math.atan2(-dx, -dz);
    x += dx * L; z += dz * L;
  }
}

/** relaxed (open) hand, angles relative to the parent */
const OPEN_F = [0.22, 0.28, 0.2];
const OPEN_T = [0.5, 0.15, 0.1];

/**
 * The upper-arm sleeve: elbow (origin, a closed dome) up +Y toward the
 * shoulder, 0.42 m, same fabric as the forearm. Not skinned: the viewmodel
 * places it from the elbow toward a camera-space shoulder every frame.
 */
export function createUpperArm(side: "R" | "L"): THREE.Mesh {
  const sx = side === "L" ? -1 : 1;
  const L = 0.42;
  const g = tube(30, 32, (t, a, p, c) => {
    const y = t * L;
    let r = 0.046 + 0.008 * sm(y / 0.2);
    const e = (0.045 - y) / 0.045;
    if (e > 0) r *= Math.sqrt(Math.max(0, 1 - Math.min(1, e) ** 2)) * 0.97 + 0.03;
    // creases where the sleeve bunches at the inside of the elbow
    const fold = Math.sin(y * 70 + Math.sin(a * 2) * 1.2) * 0.0016 * (1 - sm((y - 0.06) / 0.12));
    r += fold;
    p.set(Math.cos(a) * r, y, Math.sin(a) * r * 0.94);
    c.copy(SLEEVE);
    if (fold < -0.0008) c.lerp(SLEEVE_SH, 0.5);
    if (Math.cos(a) * sx < -0.4) c.lerp(SLEEVE_SH, 0.3);
  }, true);
  const x = g.toNonIndexed();
  x.computeVertexNormals();
  const pos = x.attributes.position as THREE.BufferAttribute, nrm = x.attributes.normal as THREE.BufferAttribute;
  const uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    const k = 34, px = pos.getX(i) * k, py = pos.getY(i) * k, pz = pos.getZ(i) * k;
    if (ax >= ay && ax >= az) uv.setXY(i, py, pz); else if (ay >= az) uv.setXY(i, px, pz); else uv.setXY(i, px, py);
  }
  x.setAttribute("uv", uv);
  const m = new THREE.Mesh(x, handMaterials().sleeve);
  m.name = `vm-upperarm${side}`;
  m.frustumCulled = false;
  return m;
}

export interface Hand {
  mesh: THREE.SkinnedMesh;
  root: THREE.Bone;
  side: "R" | "L";
  /** wrap the hand round an a x b grip (hand-local m); curl 0..1; thumb 0..1 (thumb wrap); index: trigger-finger extension 0..1 */
  setGrip(a: number, b: number, curl: number, thumb?: number, index?: number): void;
  /** turn the sleeve toward `target`, given in the hand mesh's own space */
  aimForearmLocal(target: THREE.Vector3): void;
  /** the wrist joint in the hand mesh's own space */
  wristLocal(out: THREE.Vector3): THREE.Vector3;
  /** the elbow (end of the forearm sleeve) in the hand mesh's own space, as currently aimed */
  elbowLocal(out: THREE.Vector3): THREE.Vector3;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1), Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpF = [0, 0, 0], tmpT = [0, 0, 0];

export function createHand(side: "R" | "L"): Hand {
  const mirror = side === "L";
  const src = (geoCache[side] ??= buildHandGeo(mirror));
  const bones = src.bones.map((b) => { const n = new THREE.Bone(); n.name = b.name; n.position.copy(b.position); n.quaternion.copy(b.quaternion); return n; });
  const parentOf = (i: number) => { const p = src.bones[i]!.parent; return p ? src.bones.indexOf(p as THREE.Bone) : -1; };
  for (let i = 1; i < bones.length; i++) bones[parentOf(i)]!.add(bones[i]!);
  const m = handMaterials();
  const mesh = new THREE.SkinnedMesh(src.geo, [m.glove, m.armour, m.sleeve]);
  mesh.name = `vm-hand${side}`;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const root = bones[0]!;
  mesh.add(root);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), new THREE.Matrix4());
  const sx = mirror ? -1 : 1;
  const palm = bones[B_PALM]!, wrist = bones[B_WRIST]!;
  const knuckle = FY.map((_, f) => bones[B_F + f * 3]!.position.clone());

  const hand: Hand = {
    mesh, root, side,
    setGrip(a, b, curl, thumb = curl, index = 0) {
      palm.position.x = sx * (a + PT / 2);
      for (let f = 0; f < 4; f++) {
        const kx = a + PT / 2 + knuckle[f]!.x * sx, kz = knuckle[f]!.z;
        wrapChain(kx, kz, FL[f]!, FR[f]!, a, b, 1, tmpF);
        let prev = 0;
        // the trigger finger lies straight along the frame (index = 1) instead of wrapping
        const c = f === 0 ? curl * (1 - index) : curl;
        for (let s = 0; s < 3; s++) {
          const rel = Math.min(1.95, Math.max(-0.1, tmpF[s]! - prev));
          prev += rel;
          let ang = rel * c + OPEN_F[s]! * (1 - c) * (0.9 + f * 0.06);
          if (f === 0 && index > 0) ang += index * (s === 0 ? 0.35 : s === 1 ? 0.55 : 0.35);
          bones[B_F + f * 3 + s]!.quaternion.setFromAxisAngle(Y_AXIS, sx * ang);
        }
      }
      {
        const tx = a + PT / 2 + T0.x, tz = T0.z;
        wrapChain(tx, tz, TL, TR[0]!, a, b, -1, tmpT);
        let prev = 0;
        for (let s = 0; s < 3; s++) {
          let rel = tmpT[s]! - prev;
          if (s > 0) rel = Math.max(-1.6, Math.min(1.6, rel));
          prev += rel;
          const ang = rel * thumb + OPEN_T[s]! * (1 - thumb);
          bones[B_T + s]!.quaternion.setFromAxisAngle(Y_AXIS, sx * ang);
        }
      }
    },
    wristLocal(out) {
      return out.copy(palm.position).add(wrist.position);
    },
    elbowLocal(out) {
      return out.set(0, 0, FORE_LEN).applyQuaternion(wrist.quaternion).add(palm.position).add(wrist.position);
    },
    aimForearmLocal(target) {
      _v.copy(target).sub(palm.position).sub(wrist.position).normalize();
      const ang = _v.angleTo(Z_AXIS), lim = 1.45;
      _q.setFromUnitVectors(Z_AXIS, _v);
      // (KR's version aliased _q here and reset the wrist to identity whenever the clamp engaged)
      if (ang > lim) { _q2.identity(); _q.copy(_q2.slerp(_q, lim / ang)); }
      wrist.quaternion.copy(_q);
    },
  };
  hand.setGrip(0.03, 0.03, 1);
  return hand;
}
