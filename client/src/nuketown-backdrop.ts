import * as THREE from "three";
import { SPECS, makeMaterial, type TexSet } from "./nuketown-specs";

/**
 * NUKETOWN far world (OWNER: LIGHT, P1): the desert floor, the road out, the
 * sage scrub and boulders, and two mountain ranges, inside the 420 m camera
 * far plane. Distance is COMPRESSED (ranges at 200-380 m, heights scaled to
 * read as 1-3 km away) and the haze (nuketown-sky.ts installHeightFog, with a
 * per-material NT_FOG_SCALE here) supplies the aerial perspective.
 *
 *  1. Desert floor: a polar grid around the map whose inner rings carry the
 *     map's own `nt_sand` material and UV mapping (MAT's set, world (x, 1+z)
 *     like the glTF terrain), so the lightmapped sand plate continues with no
 *     seam; farther out rolling swells (2-6 m) and two macro layers (wind
 *     streaks, pebble / crust patches) that fade in with distance, and a
 *     packed-dirt track past the street-out gate. Flat (y -0.1) wherever the
 *     map or the street-out (PROPS P1) sits on it.
 *  2. The road out is the PROPS street-out (asphalt, ranches, gate at z 80);
 *     the floor stays flat under its footprint and under the shot tower /
 *     test rig pads, and the dirt track starts at the gate.
 *  3. Sage scrub + boulders: instanced lumpy meshes (no alpha cutouts: nothing
 *     to shimmer), dense near the fence, thinning to the horizon.
 *  4. Mountains: a static mid ridge ring and a far range that follows the
 *     camera (km away: no parallax over the map, never past the far plane);
 *     ridged-noise silhouettes (peaks and saddles, no terraces), erosion gully
 *     relief and strata in the geometry, colours in vertex colours (nothing
 *     is UV-mapped, so nothing stretches), hazed harder with distance.
 */

/** Library sets the backdrop samples: the loader loads them with the SPECS sets. */
export const BACKDROP_SETS = ["desert_ground", "asphalt_street"];

// ------------------------------------------------------------------ noise
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, z: number, oct = 4): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * f, z * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}
/** Ridged multifractal: sharp crests, rounded valleys (mountain silhouettes). */
function ridged(x: number, z: number, oct = 5): number {
  let s = 0, a = 0.55, f = 1, w = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(2 * vnoise(x * f + i * 17.3, z * f - i * 9.1) - 1);
    n *= n * w;
    w = Math.min(1, n * 1.6);
    s += a * n;
    norm += a;
    f *= 2.07;
    a *= 0.5;
  }
  return s / norm;
}
const smooth = THREE.MathUtils.smoothstep;
const rnd = (i: number, k: number) => hash2(i * 1.618 + k * 7.31, k * 3.77 - i * 0.41);

// ------------------------------------------------------------------ the floor's shape
/** The map plate the floor tucks under (an ellipse around the playable footprint). */
const EX = 46, EZ = 21, CZ = -4.5;
/** Map bounds (static/assets/maps/nuketown.json) + margin: no scrub in here. */
const MAP_BOX = { x0: -51, x1: 49, z0: -28, z1: 19 };
/** PROPS street-out footprint (static/assets/nuketown/props/street_out.footprint.json:
 *  floor below y 0.12 inside x +-36.5, z 3-80.5 + the gate strip to z 84.2): flat, no scrub. */
const STREET = { x0: -37.5, x1: 37.5, z0: 2, z1: 85.5 };
/** The street-out gate (z 80.05); the dirt track starts here. */
const GATE_Z = 81;
/** PROPS skyline pieces (assets-3d/nuketown/placements.json): flat pads at their
 *  placed base height level the ground under legs, anchors and the shack. */
const PADS = [
  { x: -95, z: -140, r: 24, y: 0.34 }, // shot_tower (+ guy anchors, shack): placements.json y
  { x: -75, z: 38, r: 16, y: 0.05 }, // test_rig
];
const inBox = (b: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number, m = 0) => x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m;

/** Offset R (m) of (x, z) beyond the map ellipse (the polar grid's ring parameter). */
function ringR(x: number, z: number): number {
  const f = (R: number) => (x / (EX + R)) ** 2 + ((z - CZ) / (EZ + 0.85 * R)) ** 2;
  if (f(0) <= 1) return 0;
  let lo = 0, hi = 2000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 1) lo = mid;
    else hi = mid;
  }
  return lo;
}
/** Dirt track centre line past the gate (meanders a little). */
const trackX = (z: number) => 2.5 * Math.sin((z - GATE_Z) * 0.021) + 1.2 * Math.sin((z - GATE_Z) * 0.057 + 1.3);
/** Floor height: flat under the map, the street-out and the PROPS pads, rolling swells beyond. */
export function floorY(x: number, z: number): number {
  let y = floorRaw(x, z);
  for (const p of PAD_Y) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r * 1.6) y = THREE.MathUtils.lerp(p.y, y, smooth(d, p.r, p.r * 1.6));
  }
  return y;
}
function floorRaw(x: number, z: number): number {
  const R = ringR(x, z);
  let swell = smooth(R, 18, 90) * (0.35 + 0.65 * smooth(R, 60, 240));
  // keep the street-out zone flat (its props sit at y 0), easing out over 25 m
  const dx = Math.max(STREET.x0 - x, 0, x - STREET.x1), dz = Math.max(STREET.z0 - z, 0, z - STREET.z1);
  swell *= smooth(Math.hypot(dx, dz), 0, 25);
  let y = -0.1 + swell * (6.0 * fbm(x * 0.009 + 3, z * 0.009 + 7) - 2.6 + 1.6 * fbm(x * 0.03 - 2, z * 0.03 + 5, 3));
  // the dirt track is graded: pull the swells toward a gentle profile under it
  if (z > GATE_Z - 10) {
    const t = 1 - smooth(Math.abs(x - trackX(z)), 3, 14);
    y = THREE.MathUtils.lerp(y, -0.1 + swell * (1.2 * fbm(z * 0.01, 3.1) - 0.5), t * 0.85);
  }
  return y;
}

const PAD_Y = PADS;
const onPad = (x: number, z: number, m = 0) => PADS.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + m);

// ------------------------------------------------------------------ build
export function makeBackdrop(sets: Map<string, TexSet>, soft = false): THREE.Group & { follow: (cam: THREE.Vector3) => void } {
  const g = new THREE.Group() as THREE.Group & { follow: (cam: THREE.Vector3) => void };
  g.name = "nuketown/backdrop";
  g.userData.qaIgnore = true;

  // 1. desert floor ----------------------------------------------------------
  {
    // the map's own sand look (MAT's set, tint, macro, ORM) + LIGHT's far-field layers
    const floorMat = makeMaterial("nt_sand", SPECS.nt_sand ?? SPECS.nt_default!, sets) as THREE.MeshStandardMaterial;
    floorMat.name = "nuketown/desert-floor";
    if (!floorMat.map) floorMat.color.set("#b29b7b");
    farFieldLayers(floorMat);
    // inner rings (scale < 1) close the floor under the map: the sand plate sits
    // at y 0.22 and its edge overhangs the ellipse, so an open hole showed the
    // sky's ground haze through the gap (the "pale ellipse" from the air)
    const IN = [0.02, 0.35, 0.65, 0.88];
    const RS = [0, 0.15, 0.4, 0.8, 1.5, 3, 5, 8, 12, 17, 23, 30, 40, 52, 66, 82, 100, 125, 155, 190, 230, 275, 320, 370];
    const NA = soft ? 120 : 220;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let ri = 0; ri < IN.length + RS.length; ri++) {
      for (let ai = 0; ai <= NA; ai++) {
        const a = (ai / NA) * Math.PI * 2;
        const k = ri < IN.length ? IN[ri]! : 1;
        const R = ri < IN.length ? 0 : RS[ri - IN.length]!;
        const x = Math.cos(a) * (EX * k + R), z = CZ + Math.sin(a) * (EZ * k + R * 0.85);
        pos.push(x, floorY(x, z), z);
        uv.push(x, 1 + z); // = the glTF terrain's world box projection (Blender (x, -z), V flipped)
      }
    }
    const row = NA + 1;
    for (let ri = 0; ri < IN.length + RS.length - 1; ri++)
      for (let ai = 0; ai < NA; ai++) {
        const a = ri * row + ai, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, floorMat);
    m.receiveShadow = true;
    m.name = "nuketown/desert-floor";
    g.add(m);
  }

  // 2. the road out is the PROPS street-out (asphalt to the gate at z 80); past
  //    the gate the floor shader's dirt track takes over (farFieldLayers)

  // 3. sage scrub + boulders ---------------------------------------------------
  g.add(scatter(soft));

  // 4. mountains -------------------------------------------------------------
  // mid ridge ring: static, 190-285 m from the map centre (always < 350 m from any eye)
  const mid = mountainRing({ r0: 190, r1: 285, na: soft ? 360 : 900, nr: soft ? 14 : 30, hMin: 6, hMax: 26, seed: 1, fog: 1.35, crest: 0.55 });
  mid.name = "nuketown/ridge-mid";
  g.add(mid);
  // far range: follows the eye in x/z (km away), 300-385 m from it
  const far = mountainRing({ r0: 300, r1: 385, na: soft ? 360 : 1100, nr: soft ? 12 : 26, hMin: 20, hMax: 62, seed: 2, fog: 1.8, crest: 0.45 });
  far.name = "nuketown/range-far";
  g.add(far);
  g.follow = (cam: THREE.Vector3) => {
    far.position.set(cam.x, 0, cam.z);
  };
  return g;
}

/**
 * Far-field layers on the floor (world-space, fade in with distance from the
 * map so the join to the lightmapped sand stays exact): crust / pebble patches
 * (two scales), wind streaks along the prevailing south-westerly, and the
 * packed-dirt track past the gate.
 */
function farFieldLayers(m: THREE.MeshStandardMaterial): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vNtW;")
      .replace("#include <fog_vertex>", "#include <fog_vertex>\nvNtW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vNtW;
        float ntH(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        float ntN(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(ntH(i), ntH(i + vec2(1, 0)), u.x), mix(ntH(i + vec2(0, 1)), ntH(i + vec2(1, 1)), u.x), u.y); }
        float ntF(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * ntN(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          vec2 w = vNtW.xz;
          // distance beyond the map plate (ellipse ${EX}x${EZ}, centre z ${CZ}), 0 inside
          float q = length(vec2(w.x / ${EX.toFixed(1)}, (w.y - (${CZ.toFixed(1)})) / ${EZ.toFixed(1)}));
          float far = smoothstep(1.0, 2.3, q);
          // big crust / darker gravel patches, then pebble breakup at mid range
          float p1 = ntF(w * 0.011 + 3.0);
          float p2 = ntF(w * 0.05 + 11.0);
          // wind streaks: stretched along the south-westerly (x -0.6, z 0.8)
          vec2 wd = vec2(-0.6, 0.8), wp = vec2(-wd.y, wd.x);
          float st = ntF(vec2(dot(w, wd) * 0.012, dot(w, wp) * 0.16) + 5.0);
          // every layer averages ~1, so the far field keeps the plate's mean value (no pale ring)
          vec3 lay = mix(vec3(0.9, 0.86, 0.82), vec3(1.07, 1.05, 1.03), smoothstep(0.3, 0.7, p1));
          lay *= 0.93 + 0.14 * p2;
          lay *= 1.04 - 0.14 * smoothstep(0.45, 0.75, st);
          diffuseColor.rgb *= mix(vec3(1.0), lay, far);
          // packed-dirt track past the gate: darker, redder, two wheel ruts
          float tx = 2.5 * sin((w.y - ${GATE_Z.toFixed(1)}) * 0.021) + 1.2 * sin((w.y - ${GATE_Z.toFixed(1)}) * 0.057 + 1.3);
          float dx = abs(w.x - tx) + (ntN(w * 0.4) - 0.5) * 0.9;
          float track = (1.0 - smoothstep(2.6, 4.2, dx)) * smoothstep(${(GATE_Z - 1).toFixed(1)}, ${(GATE_Z + 3).toFixed(1)}, w.y);
          float ruts = smoothstep(0.6, 0.15, abs(dx - 1.05));
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.8, 0.71, 0.62) * (1.0 - 0.16 * ruts), track);
        }`,
      );
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|ntFarField1`;
  m.needsUpdate = true;
}

/** Push this material's optical depth (the backdrop reads farther than it is). */
function fogScale(m: THREE.Material, k: number): void {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = `#define NT_FOG_SCALE ${k.toFixed(2)}\n${sh.fragmentShader}`;
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|ntFog${k.toFixed(2)}`;
}

/** Direction of the PROPS shot tower from the map centre (in mountainRing's angle). */
const TOWER_A = Math.atan2(-140, -95);

/** One range: polar heightfield ring, ridged silhouettes, gully relief, strata colours. */
function mountainRing(o: { r0: number; r1: number; na: number; nr: number; hMin: number; hMax: number; seed: number; fog: number; crest: number }): THREE.Mesh {
  const { r0, r1, na, nr, hMin, hMax, seed } = o;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const lit = new THREE.Color("#86664f"), dark = new THREE.Color("#3f2f27"), band = new THREE.Color("#977a60"), sand = new THREE.Color("#a08a6c");
  const c = new THREE.Color();
  const S = seed * 37.7;
  for (let ri = 0; ri <= nr; ri++) {
    const t = ri / nr;
    const r = r0 + (r1 - r0) * t;
    for (let ai = 0; ai <= na; ai++) {
      const a = (ai / na) * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // where the range stands tall: low in the south-west (keeps the low sun's sky open)
      const sw = 0.5 + 0.5 * (Math.cos(a) * 0.6 - Math.sin(a) * 0.8); // 1 toward north-east
      let amp = hMin + (hMax - hMin) * (0.35 + 0.65 * smooth(fbm(Math.cos(a) * 2.2 + S, Math.sin(a) * 2.2 - S, 3) * 0.7 + sw * 0.45, 0.25, 0.85));
      // a saddle behind the PROPS shot tower (az from the map centre) so it reads on the skyline
      const dTower = Math.atan2(Math.sin(a - TOWER_A), Math.cos(a - TOWER_A));
      amp *= 1 - 0.6 * Math.exp(-((dTower / 0.2) ** 2));
      // ridged silhouettes on the circle (seamless), sampled in angle * radius space:
      // broad massifs (low frequency) carrying rugged crests (ridged detail)
      const k = 0.009;
      const massif = fbm(Math.cos(a) * r1 * k * 0.5 + S, Math.sin(a) * r1 * k * 0.5 - S, 3);
      const ridge = ridged(Math.cos(a) * r1 * k + S, Math.sin(a) * r1 * k - S, 5);
      // radial profile: foothills -> crest -> back slope
      const prof = smooth(t, 0, o.crest) * (1 - 0.55 * smooth(t, o.crest + 0.15, 1));
      // erosion gullies: 2D (angle x height-ish), irregular, not a comb of streaks
      const gx = Math.cos(a) * r * 0.06, gz = Math.sin(a) * r * 0.06;
      const gully = 1 - Math.abs(2 * fbm(gx + S + t * 1.7, gz - S - t * 2.3, 3) - 1);
      // crags: mid-frequency ridged relief on the faces (rock ribs between gullies)
      const crag = ridged(gx * 0.55 - S, gz * 0.55 + S + t * 1.3, 3);
      let h = amp * (0.2 + 0.55 * massif + 0.6 * ridge) * prof;
      h += amp * 0.11 * (crag - 0.5) * prof;
      h -= h * 0.16 * gully * gully * smooth(t, 0.08, 0.5);
      const y = -2.5 + h;
      pos.push(x, y, z);
      // colours: rock by height, darker gullies, sandy fans at the foot, strata bands
      const strata = 0.5 + 0.5 * Math.sin(y * 0.55 + fbm(x * 0.02 + S, z * 0.02, 2) * 4.0);
      const fan = 1 - smooth(h, 0.5, amp * 0.22);
      c.copy(lit).lerp(band, strata * 0.4).lerp(dark, (gully * gully * 0.7 + (1 - crag) * 0.35) * smooth(t, 0.06, 0.45)).lerp(sand, fan * 0.75);
      c.multiplyScalar(0.92 + 0.16 * hash2(ai * 0.37 + S, ri * 1.3));
      col.push(c.r, c.g, c.b);
    }
  }
  const row = na + 1;
  for (let ri = 0; ri < nr; ri++)
    for (let ai = 0; ai < na; ai++) {
      const a = ri * row + ai, b = a + 1, cc = a + row, d = cc + 1;
      idx.push(a, b, cc, b, d, cc);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  fogScale(mat, o.fog);
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

/** A sagebrush: brown stems fanning up into 5-7 faceted grey-olive crown lumps (vase-shaped). */
function sageGeometry(seed: number, lumps: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stemC = new THREE.Color("#5c4e3f"), leafC = new THREE.Color("#868572");
  const paint = (geo: THREE.BufferGeometry, c: THREE.Color, dark: number) => {
    const p = geo.attributes.position!;
    const cols: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const k = (1 - dark) + dark * smooth(p.getY(i), 0.1, 1.0); // darker inside / low
      cols.push(c.r * k, c.g * k, c.b * k);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return geo;
  };
  for (let k = 0; k < 5; k++) {
    const a = seed * 2.1 + k * 1.257;
    const stem = new THREE.CylinderGeometry(0.02, 0.045, 0.42, 3, 1, true);
    stem.translate(0, 0.21, 0);
    stem.rotateZ(Math.cos(a) * 0.55);
    stem.rotateX(Math.sin(a) * 0.55);
    parts.push(paint(stem.index ? stem.toNonIndexed() : stem, stemC, 0.25));
  }
  for (let k = 0; k < lumps; k++) {
    const r = 0.2 + 0.14 * rnd(k, seed);
    const lump = new THREE.IcosahedronGeometry(r, 0);
    const p = lump.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const j = 0.7 + 0.6 * rnd(i + k * 31, seed * 3.1);
      p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 0.8, p.getZ(i) * j);
    }
    const ang = (k / lumps) * Math.PI * 2 + rnd(k, seed + 1) * 0.9;
    const rad = k === 0 ? 0.05 : 0.2 + 0.24 * rnd(k, seed + 2);
    lump.translate(Math.cos(ang) * rad, 0.3 + 0.32 * rnd(k, seed + 3) + (k === 0 ? 0.14 : 0) - rad * 0.25, Math.sin(ang) * rad);
    const c = leafC.clone().multiplyScalar(0.84 + 0.28 * rnd(k, seed + 4));
    parts.push(paint(lump.index ? lump.toNonIndexed() : lump, c, 0.45));
  }
  const n = parts.reduce((s, g) => s + g.attributes.position!.count, 0);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position!.array as Float32Array, o * 3);
    col.set(g.attributes.color!.array as Float32Array, o * 3);
    o += g.attributes.position!.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A pale desert boulder: a flattened, faceted lump. */
function boulderGeometry(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    v.multiplyScalar(0.7 + 0.45 * vnoise(v.x * 1.9 + seed, v.z * 1.9 + v.y * 1.3 - seed));
    p.setXYZ(i, v.x, v.y * 0.62 + 0.3, v.z);
  }
  const g2 = geo.index ? geo.toNonIndexed() : geo;
  const q = g2.attributes.position!;
  const cols: number[] = [];
  for (let i = 0; i < q.count; i++) {
    const k = 0.72 + 0.28 * smooth(q.getY(i), 0.0, 0.8);
    cols.push(k, k, k);
  }
  g2.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  g2.computeVertexNormals();
  return g2;
}

/** Sage scrub (grey-olive, 0.6-1.5 m) + pale boulders, instanced, on the floor. */
function scatter(soft: boolean): THREE.Group {
  const grp = new THREE.Group();
  grp.name = "nuketown/scrub";
  const bushGeo = [sageGeometry(1.3, 8), sageGeometry(4.7, 9), sageGeometry(8.1, 7)];
  const farGeo = sageGeometry(2.2, 4);
  const rockGeo = [boulderGeometry(3.3), boulderGeometry(6.6)];
  const bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true, name: "nuketown/scrub" });
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, name: "nuketown/boulders" });
  // candidates on a jittered lattice; density falls with distance, bare patches between stands
  type P = { x: number; z: number; s: number; yaw: number; c: THREE.Color; R: number };
  const near: P[][] = [[], [], []], farB: P[] = [], rocks: P[][] = [[], []];
  const sage = [new THREE.Color("#ffffff"), new THREE.Color("#e6e9dc"), new THREE.Color("#f3eadb"), new THREE.Color("#d9d6c8")];
  const pale = [new THREE.Color("#c8b89a"), new THREE.Color("#b9a587"), new THREE.Color("#d2c3a6")];
  const cell = soft ? 6.5 : 4.0;
  let i = 0;
  for (let gx = -380; gx <= 380; gx += cell) {
    for (let gz = -380; gz <= 380; gz += cell) {
      i++;
      const x = gx + (rnd(i, 1) - 0.5) * cell * 1.1, z = gz + (rnd(i, 2) - 0.5) * cell * 1.1;
      if (inBox(MAP_BOX, x, z) || inBox(STREET, x, z, 2) || onPad(x, z, 3)) continue;
      const R = ringR(x, z);
      if (R < 2.5 || R > 330 || Math.hypot(x, z) > 360) continue;
      if (z > GATE_Z - 2 && Math.abs(x - trackX(z)) < 5.5) continue;
      // ~1 per 16 m2 in a stand at the fence, ~1 per 60 m2 at 120 m, sparse to the horizon
      const dens = (cell * cell) / (16 + R * 0.4 + R * R * 0.0015);
      const stand = smooth(fbm(x * 0.035 + 5, z * 0.035 - 2, 3), 0.32, 0.62) * 1.6;
      const roll = rnd(i, 3);
      if (roll < dens * stand) {
        const s = (0.75 + 0.85 * rnd(i, 4) ** 1.3) * (R > 110 ? 1.2 : 1);
        const p: P = { x, z, s, yaw: rnd(i, 5) * 6.283, c: sage[Math.floor(rnd(i, 6) * sage.length)]!.clone().multiplyScalar(0.86 + 0.26 * rnd(i, 7)), R };
        if (R < 110) near[Math.floor(rnd(i, 8) * 3)]!.push(p);
        else farB.push(p);
      } else if (roll > 1 - dens * 0.035) {
        rocks[Math.floor(rnd(i, 9) * 2)]!.push({ x, z, s: 0.45 + 1.6 * rnd(i, 10) ** 2.4, yaw: rnd(i, 11) * 6.283, c: pale[Math.floor(rnd(i, 12) * pale.length)]!.clone().multiplyScalar(0.92 + 0.16 * rnd(i, 13)), R });
      }
    }
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const emit = (geo: THREE.BufferGeometry, mat: THREE.Material, list: P[], name: string, rock: boolean) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.name = name;
    list.forEach((p, k) => {
      const y = floorY(p.x, p.z) - (rock ? 0.22 * p.s : 0.05);
      e.set(rock ? (rnd(k, 14) - 0.5) * 0.35 : (rnd(k, 14) - 0.5) * 0.12, p.yaw, rock ? (rnd(k, 15) - 0.5) * 0.35 : (rnd(k, 15) - 0.5) * 0.12);
      q.setFromEuler(e);
      const w = rock ? p.s * (0.9 + 0.5 * rnd(k, 16)) : p.s * (0.9 + 0.35 * rnd(k, 17));
      sc.set(w, p.s * (rock ? 0.8 : 0.9 + 0.25 * rnd(k, 19)), rock ? p.s : w * (0.85 + 0.3 * rnd(k, 18)));
      m4.compose(v.set(p.x, y, p.z), q, sc);
      im.setMatrixAt(k, m4);
      im.setColorAt(k, p.c);
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.receiveShadow = true;
    im.castShadow = false;
    im.frustumCulled = false;
    grp.add(im);
  };
  near.forEach((l, k) => emit(bushGeo[k]!, bushMat, l, `nuketown/scrub-${k}`, false));
  emit(farGeo, bushMat, farB, "nuketown/scrub-far", false);
  rocks.forEach((l, k) => emit(rockGeo[k]!, rockMat, l, `nuketown/boulders-${k}`, true));
  return grp;
}
