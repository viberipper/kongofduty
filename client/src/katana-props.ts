import * as THREE from "three";

type V3 = [number, number, number];
type Segment = { a: V3; b: V3; r: number };

const GEOMETRIES = new Map<string, THREE.BufferGeometry>();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function geometry<T extends THREE.BufferGeometry>(key: string, build: () => T): T {
  const cached = GEOMETRIES.get(key);
  if (cached) return cached as T;
  const value = build();
  GEOMETRIES.set(key, value);
  return value;
}

function standard(
  name: string,
  parameters: Omit<THREE.MeshStandardMaterialParameters, "name">,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ name, ...parameters });
}

const M = {
  stone: standard("kt_stone_graphite", { color: 0x3b4347, roughness: 0.62, metalness: 0.08 }),
  paleStone: standard("kt_stone_pale", { color: 0xb8c0bd, roughness: 0.67, metalness: 0.04 }),
  rock: standard("kt_rock_wet_granite", { color: 0x465154, roughness: 0.58, metalness: 0.1 }),
  contact: standard("kt_gravel", { color: 0xa4aaa8, roughness: 0.96 }),
  moss: standard("kt_moss_deep", { color: 0x304737, roughness: 0.96 }),
  cedar: standard("kt_cedar_charred", { color: 0x171c1d, roughness: 0.62, metalness: 0.05 }),
  cedarCut: standard("kt_cedar_cut", { color: 0x403c34, roughness: 0.74 }),
  lacquer: standard("kt_lacquer_blade_red", { color: 0xe8141f, roughness: 0.25, metalness: 0.12 }),
  darkLacquer: standard("kt_lacquer_deep_red", { color: 0x781018, roughness: 0.38, metalness: 0.1 }),
  paper: standard("kt_paper_red_glow", {
    color: 0xa82b31,
    emissive: 0xe8141f,
    emissiveIntensity: 0.45,
    roughness: 0.82,
    side: THREE.DoubleSide,
  }),
  paperDiffuser: standard("kt_cloth_red", { color: 0x8e2028, roughness: 0.88, side: THREE.DoubleSide }),
  cloth: standard("kt_cloth_lacquer_red", { color: 0x9d141d, roughness: 0.94, side: THREE.DoubleSide }),
  clothDark: standard("kt_cloth_graphite", { color: 0x171c1e, roughness: 0.95, side: THREE.DoubleSide }),
  iron: standard("kt_iron_black", { color: 0x151b1e, roughness: 0.3, metalness: 0.76 }),
  blade: standard("kt_blade_steel", { color: 0xaebfc3, roughness: 0.22, metalness: 0.95 }),
  edge: standard("kt_blade_cutting_edge", { color: 0xe2eceb, roughness: 0.12, metalness: 0.9 }),
  hamon: standard("kt_underwrap", { color: 0xc2d0d0, roughness: 0.42, metalness: 0.45 }),
  bladeReflection: standard("kt_blade_red_reflection", {
    color: 0x471016,
    emissive: 0xe8141f,
    emissiveIntensity: 0.08,
    roughness: 0.32,
    metalness: 0.75,
  }),
  cord: standard("kt_tsuka_black_cord", { color: 0x0b0f11, roughness: 0.92 }),
  underWrap: standard("kt_tsuka_diamond_underwrap", { color: 0x858c86, roughness: 0.8 }),
  rope: standard("kt_rope_neutral", { color: 0x777768, roughness: 0.95 }),
  bamboo: standard("kt_bamboo_black_stem", { color: 0x182a24, roughness: 0.67 }),
  bambooNode: standard("kt_bamboo_node", { color: 0x405449, roughness: 0.8 }),
  leaf: standard("kt_foliage_pine_green", { color: 0x254233, roughness: 0.92, side: THREE.DoubleSide }),
  maple: standard("kt_foliage_maple_red", { color: 0xa7131d, roughness: 0.88, side: THREE.DoubleSide }),
  mapleDark: standard("kt_foliage_maple_shadow", { color: 0x5d1018, roughness: 0.92, side: THREE.DoubleSide }),
  bronze: standard("kt_bell_oxidized_bronze", { color: 0x354640, roughness: 0.41, metalness: 0.78 }),
  water: standard("kt_water_dark", {
    color: 0x102a32,
    roughness: 0.16,
    metalness: 0.18,
    transparent: true,
    opacity: 0.84,
    depthWrite: false,
  }),
  straw: standard("kt_barrel_straw", { color: 0x898b79, roughness: 0.93 }),
  koiWhite: standard("kt_koi_pearl", { color: 0xa5b3af, roughness: 0.52 }),
  koiRed: standard("kt_koi_kohaku_red", { color: 0xa8242c, roughness: 0.48 }),
  koiFin: standard("kt_koi_fin", { color: 0x879994, roughness: 0.55, side: THREE.DoubleSide }),
  eye: standard("kt_eye_obsidian", { color: 0x050809, roughness: 0.24 }),
};

function root(asset: string): THREE.Group {
  const group = new THREE.Group();
  group.name = `kt_${asset}`;
  group.userData = {
    asset,
    units: "metres",
    materialPrefix: "kt_",
    sculptRuntime: { units: "metres", pivotNames: [] },
  };
  return group;
}

function animated(group: THREE.Group, pivots: Record<string, THREE.Group>): THREE.Group {
  group.userData.pivots = Object.fromEntries(Object.entries(pivots).map(([key, pivot]) => [key, pivot.name]));
  group.userData.sculptRuntime.pivotNames = Object.keys(pivots);
  return group;
}

function makePivot(parent: THREE.Object3D, name: string, position: V3): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...position);
  parent.add(group);
  return group;
}

function part(
  parent: THREE.Object3D,
  name: string,
  geo: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  position: V3 = [0, 0, 0],
  scale: V3 = [1, 1, 1],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function box(
  parent: THREE.Object3D,
  name: string,
  size: V3,
  material: THREE.Material,
  position: V3 = [0, 0, 0],
): THREE.Mesh {
  return part(parent, name, geometry("unit-box", () => new THREE.BoxGeometry(1, 1, 1)), material, position, size);
}

function beveledBoxGeometry(size: V3, radius: number): THREE.ExtrudeGeometry {
  const [width, height, depth] = size;
  const bevel = Math.min(radius, width * 0.2, height * 0.2, depth * 0.2);
  const w = width * 0.5 - bevel;
  const h = height * 0.5 - bevel;
  const shape = new THREE.Shape();
  shape.moveTo(-w, -h);
  shape.lineTo(w, -h);
  shape.lineTo(w, h);
  shape.lineTo(-w, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    steps: 1,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -depth * 0.5 + bevel);
  return geo;
}

function beveledBox(
  parent: THREE.Object3D,
  name: string,
  size: V3,
  radius: number,
  material: THREE.Material,
  position: V3 = [0, 0, 0],
): THREE.Mesh {
  return part(
    parent,
    name,
    geometry(`beveled-box:${size.join(":")}:${radius}`, () => beveledBoxGeometry(size, radius)),
    material,
    position,
  );
}

function unitBeveledBox(): THREE.BufferGeometry {
  return geometry("unit-beveled-box", () => beveledBoxGeometry([1, 1, 1], 0.065));
}

function cylinder(
  parent: THREE.Object3D,
  name: string,
  top: number,
  bottom: number,
  height: number,
  material: THREE.Material,
  position: V3 = [0, 0, 0],
  segments = 12,
  open = false,
): THREE.Mesh {
  const key = `cylinder:${top}:${bottom}:${height}:${segments}:${open}`;
  return part(
    parent,
    name,
    geometry(key, () => new THREE.CylinderGeometry(top, bottom, height, segments, 1, open)),
    material,
    position,
  );
}

function sphere(
  parent: THREE.Object3D,
  name: string,
  scale: V3,
  material: THREE.Material,
  position: V3 = [0, 0, 0],
  detail: "low" | "round" | "sculpt" = "low",
): THREE.Mesh {
  const segments = detail === "low" ? 8 : detail === "round" ? 12 : 18;
  const rings = detail === "low" ? 6 : detail === "round" ? 8 : 12;
  const geo = geometry(`unit-sphere:${detail}`, () => new THREE.SphereGeometry(1, segments, rings));
  return part(parent, name, geo, material, position, scale);
}

function torus(
  parent: THREE.Object3D,
  name: string,
  radius: number,
  tube: number,
  material: THREE.Material,
  position: V3 = [0, 0, 0],
  segments = 20,
): THREE.Mesh {
  return part(
    parent,
    name,
    geometry(`torus:${radius}:${tube}:${segments}`, () => new THREE.TorusGeometry(radius, tube, 5, segments)),
    material,
    position,
  );
}

function segmentMatrix(a: V3, b: V3, radius: number): THREE.Matrix4 {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const direction = end.clone().sub(start);
  const length = direction.length();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, direction.normalize());
  return new THREE.Matrix4().compose(
    start.add(end).multiplyScalar(0.5),
    quaternion,
    new THREE.Vector3(radius, length, radius),
  );
}

function segment(
  parent: THREE.Object3D,
  name: string,
  a: V3,
  b: V3,
  radius: number,
  material: THREE.Material,
  sides = 8,
): THREE.Mesh {
  const matrix = segmentMatrix(a, b, radius);
  const mesh = part(
    parent,
    name,
    geometry(`unit-cylinder:${sides}`, () => new THREE.CylinderGeometry(1, 1, 1, sides)),
    material,
  );
  mesh.applyMatrix4(matrix);
  return mesh;
}

function instances(
  parent: THREE.Object3D,
  name: string,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, material, matrices.length);
  mesh.name = name;
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  parent.add(mesh);
  return mesh;
}

function segmentInstances(parent: THREE.Object3D, name: string, segments: Segment[], material: THREE.Material, sides = 7): void {
  instances(
    parent,
    name,
    geometry(`unit-cylinder:${sides}`, () => new THREE.CylinderGeometry(1, 1, 1, sides)),
    material,
    segments.map(({ a, b, r }) => segmentMatrix(a, b, r)),
  );
}

function diamondGeometry(width: number, height: number): THREE.ShapeGeometry {
  return geometry(`diamond:${width}:${height}`, () => {
    const shape = new THREE.Shape();
    shape.moveTo(0, height * 0.5);
    shape.lineTo(width * 0.5, 0);
    shape.lineTo(0, -height * 0.5);
    shape.lineTo(-width * 0.5, 0);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  });
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createKatana(): THREE.Group {
  const group = root("katana");
  const widthAt = (y: number): number => {
    if (y < 0.45) return THREE.MathUtils.lerp(0.018, 0.19, y / 0.45);
    return THREE.MathUtils.lerp(0.19, 0.42, Math.min(1, (y - 0.45) / 2.2));
  };
  const curveAt = (y: number): number => 0.24 * Math.sin((y / 7.9) * Math.PI * 0.55);
  const thicknessAt = (y: number): number => 0.045 + 0.025 * Math.min(1, y / 2.2);
  const ring = (y: number): V3[] => {
    const center = curveAt(y);
    const width = widthAt(y);
    const thickness = thicknessAt(y);
    return [
      [center - width, y, 0],
      [center - width * 0.55, y, thickness * 0.68],
      [center + width * 0.25, y, thickness],
      [center + width, y, thickness * 0.18],
      [center + width * 0.25, y, -thickness],
      [center - width * 0.55, y, -thickness * 0.68],
    ];
  };
  part(group, "blade-steel-regions", geometry("katana-blade-v2", () => {
    const buckets: number[][] = [[], [], []];
    const triangle = (bucket: number, a: V3, b: V3, c: V3) => buckets[bucket].push(...a, ...b, ...c);
    const rings = Array.from({ length: 37 }, (_, index) => ring((index / 36) * 7.9));
    for (let i = 0; i < rings.length - 1; i++) {
      for (let side = 0; side < 6; side++) {
        const next = (side + 1) % 6;
        const bucket = side === 0 || side === 5 ? 0 : side === 2 || side === 3 ? 2 : 1;
        triangle(bucket, rings[i][side], rings[i + 1][next], rings[i + 1][side]);
        triangle(bucket, rings[i][side], rings[i][next], rings[i + 1][next]);
      }
    }
    const positions: number[] = [];
    const geo = new THREE.BufferGeometry();
    buckets.forEach((bucket, materialIndex) => {
      const start = positions.length / 3;
      positions.push(...bucket);
      geo.addGroup(start, bucket.length / 3, materialIndex);
    });
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }), [M.edge, M.blade, M.iron]);

  part(group, "blade-hamon-ribbons", geometry("katana-hamon-v2", () => {
    const positions: number[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 48; i++) {
        const y0 = 0.52 + (i / 48) * 7.08;
        const y1 = 0.52 + ((i + 1) / 48) * 7.08;
        const point = (y: number, rail: number): V3 => {
          const width = widthAt(y);
          const centerOffset = width * 0.21 + Math.sin(y * 3.4 + Math.sin(y * 1.3)) * 0.022;
          const offset = THREE.MathUtils.clamp(centerOffset + rail * 0.035, 0.01, width * 0.42);
          const z = side * (thicknessAt(y) * 0.68 * (offset / (width * 0.45)) + 0.002);
          return [curveAt(y) - width + offset, y, z];
        };
        const a = point(y0, -1);
        const b = point(y0, 1);
        const c = point(y1, 1);
        const d = point(y1, -1);
        if (side > 0) positions.push(...a, ...b, ...c, ...a, ...c, ...d);
        else positions.push(...a, ...c, ...b, ...a, ...d, ...c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }), M.hamon);

  const scratchRandom = seeded(991);
  const scratches: THREE.Matrix4[] = [];
  for (let i = 0; i < 22; i++) {
    const y = 1.1 + scratchRandom() * 6.35;
    const x = curveAt(y) + widthAt(y) * (0.05 + scratchRandom() * 0.14);
    scratches.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, thicknessAt(y) + 0.002),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.08 + scratchRandom() * 0.16)),
      new THREE.Vector3(0.0025, 0.06 + scratchRandom() * 0.14, 0.002),
    ));
  }
  instances(group, "blade-polish-lines", geometry("unit-box", () => new THREE.BoxGeometry(1, 1, 1)), M.hamon, scratches);

  beveledBox(group, "habaki-sleeve", [0.57, 0.28, 0.22], 0.025, M.iron, [curveAt(7.9), 7.78, 0]);
  beveledBox(group, "habaki-red-gasket", [0.5, 0.035, 0.19], 0.008, M.bladeReflection, [curveAt(7.9), 7.94, 0]);
  cylinder(group, "seppa-lower", 0.25, 0.25, 0.035, M.edge, [0, 7.985, 0], 24);
  cylinder(group, "seppa-upper", 0.25, 0.25, 0.035, M.edge, [0, 8.135, 0], 24);
  const tsuba = torus(group, "tsuba-openwork-ring", 0.43, 0.105, M.iron, [0, 8.06, 0], 32);
  tsuba.rotation.x = Math.PI * 0.5;
  const tsubaRim = torus(group, "tsuba-red-rim", 0.55, 0.022, M.bladeReflection, [0, 8.06, 0], 32);
  tsubaRim.rotation.x = Math.PI * 0.5;
  cylinder(group, "tsuba-hub", 0.21, 0.21, 0.1, M.iron, [0, 8.06, 0], 24);
  const spokes: Segment[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    spokes.push({
      a: [Math.cos(angle) * 0.17, 8.06, Math.sin(angle) * 0.17],
      b: [Math.cos(angle) * 0.47, 8.06, Math.sin(angle) * 0.47],
      r: 0.025,
    });
  }
  segmentInstances(group, "tsuba-openwork-spokes", spokes, M.iron, 6);
  cylinder(group, "fuchi", 0.35, 0.35, 0.16, M.iron, [0, 8.23, 0], 20);
  const fuchiInlay = torus(group, "fuchi-red-inlay", 0.352, 0.012, M.bladeReflection, [0, 8.19, 0], 24);
  fuchiInlay.rotation.x = Math.PI * 0.5;
  cylinder(group, "tsuka-core", 0.3, 0.34, 3.42, M.cord, [0, 9.96, 0], 16);

  for (const direction of [-1, 1]) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 168; i++) {
      const t = i / 168;
      const angle = direction * t * Math.PI * 14 + (direction < 0 ? Math.PI : 0);
      const radius = 0.327 + Math.sin(t * Math.PI) * 0.008;
      points.push(new THREE.Vector3(Math.cos(angle) * radius, 8.28 + t * 3.34, Math.sin(angle) * radius));
    }
    part(group, direction < 0 ? "tsuka-ito-left" : "tsuka-ito-right", geometry(`katana-wrap-v2:${direction}`, () =>
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 168, 0.047, 6, false),
    ), M.cord);
  }

  const wrapDiamonds: THREE.Matrix4[] = [];
  for (let i = 0; i < 8; i++) {
    const y = 8.55 + i * 0.4;
    wrapDiamonds.push(new THREE.Matrix4().makeTranslation(0, y, 0.367));
    wrapDiamonds.push(new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, -0.367),
      new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI),
      new THREE.Vector3(1, 1, 1),
    ));
  }
  instances(group, "tsuka-diamond-openings", diamondGeometry(0.11, 0.17), M.underWrap, wrapDiamonds);
  const menuki = part(group, "menuki", diamondGeometry(0.1, 0.28), M.darkLacquer, [0.17, 9.92, 0.36]);
  menuki.rotation.z = 0.42;
  cylinder(group, "kashira", 0.35, 0.33, 0.22, M.iron, [0, 11.77, 0], 16);
  sphere(group, "pommel-cap", [0.31, 0.11, 0.31], M.cord, [0, 11.89, 0], "round");
  const kashiraInlay = torus(group, "kashira-red-inlay", 0.3, 0.01, M.bladeReflection, [0, 11.86, 0], 20);
  kashiraInlay.rotation.x = Math.PI * 0.5;
  const embers = makePivot(group, "ember-socket", [0, 8.18, 0]);
  group.userData.emberSocket = [0, 8.18, 0];
  animated(group, { embers });

  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  const size = bounds.getSize(new THREE.Vector3());
  const scaleY = 12 / size.y;
  group.scale.y = scaleY;
  group.position.y = -bounds.min.y * scaleY;
  return group;
}

function rockGeometry(variant: number): THREE.BufferGeometry {
  return geometry(`rock-sculpt-v2:${variant}`, () => {
    const dimensions: Record<number, V3> = {
      1: [3.05, 2.2, 2.1],
      2: [2.8, 2.2, 2.3],
      3: [3.2, 2.05, 2.15],
      4: [2.8, 2.2, 2.4],
    };
    const [width, height, depth] = dimensions[variant];
    const geo = new THREE.SphereGeometry(1, 22, 14);
    const position = geo.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const t = (y + 1) * 0.5;
      const shapedY = t < 0.16 ? t * 0.45 : 0.072 + ((t - 0.16) / 0.84) * 0.928;
      const swell = 1 + 0.075 * Math.sin(x * 3.7 + variant) + 0.065 * Math.sin(z * 4.3 - y * 2.1 + variant);
      const sx = Math.sign(x) * Math.pow(Math.abs(x), 0.84);
      const sz = Math.sign(z) * Math.pow(Math.abs(z), 0.86);
      const lean = (variant - 2.5) * 0.045 * shapedY;
      position.setXYZ(
        i,
        sx * width * 0.5 * swell + lean,
        shapedY * height - 0.045 + Math.sin(x * 3.1 + z * 2.7 + variant) * 0.045 * shapedY + sx * 0.065 * shapedY,
        sz * depth * 0.5 * (swell + 0.035 * Math.cos(y * 4.6 + variant)),
      );
    }
    const index = geo.getIndex();
    if (!index) throw new Error("Rock sculpt requires indexed geometry");
    const stone: number[] = [];
    const moss: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      const cx = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
      const cy = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
      const cz = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
      const mask = Math.sin(cx * 2.2 + cz * 1.3 + variant) + Math.sin(cz * 4.1 - cy * 1.7);
      const target = (cy > height * 0.55 && mask > 0.3) || (cy > height * 0.88 && mask > -0.45) ? moss : stone;
      target.push(a, b, c);
    }
    geo.setIndex([...stone, ...moss]);
    geo.clearGroups();
    geo.addGroup(0, stone.length, 0);
    geo.addGroup(stone.length, moss.length, 1);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  });
}

function rockContactGeometry(variant: number): THREE.BufferGeometry {
  return geometry(`rock-contact-v2:${variant}`, () => {
    const segments = 28;
    const radii = [0.24, 0.58, 0.86, 1];
    const heights = [0.29, 0.32, 0.19, 0.015];
    const positions: number[] = [];
    const indices: number[] = [];
    for (let ring = 0; ring < radii.length; ring++) {
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const irregular = 1 + 0.045 * Math.sin(angle * 5 + variant) + 0.025 * Math.sin(angle * 9 - variant);
        const radius = radii[ring] * irregular;
        positions.push(
          Math.sign(c) * Math.sqrt(Math.abs(c)) * 2.75 * radius,
          heights[ring] + Math.sin(angle * 4 + ring + variant) * 0.018 * radius,
          Math.sign(s) * Math.sqrt(Math.abs(s)) * 2.4 * radius,
        );
      }
    }
    for (let ring = 0; ring < radii.length - 1; ring++) {
      for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments;
        const a = ring * segments + i;
        const b = ring * segments + next;
        const c = (ring + 1) * segments + next;
        const d = (ring + 1) * segments + i;
        indices.push(a, c, d, a, b, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  });
}

function createRock(variant: number): THREE.Group {
  const group = root(`rock-${variant}`);
  part(group, `rock-sculpt-${variant}`, rockGeometry(variant), [M.rock, M.moss]);
  const contact = part(group, "organic-earth-contact", rockContactGeometry(variant), M.contact);
  contact.castShadow = false;
  group.userData.coverHeight = 2.2;
  return group;
}

function createStoneLantern(): THREE.Group {
  const group = root("lantern-stone");
  beveledBox(group, "lantern-foot", [0.86, 0.18, 0.86], 0.045, M.stone, [0, 0.09, 0]);
  cylinder(group, "lantern-base", 0.34, 0.42, 0.2, M.stone, [0, 0.28, 0], 12);
  cylinder(group, "lantern-pedestal", 0.17, 0.24, 0.74, M.stone, [0, 0.75, 0], 12);
  beveledBox(group, "lantern-platform", [0.7, 0.14, 0.7], 0.035, M.stone, [0, 1.17, 0]);
  beveledBox(group, "lantern-chamber-sill", [0.56, 0.08, 0.56], 0.02, M.stone, [0, 1.27, 0]);
  box(group, "lantern-paper-chamber", [0.45, 0.44, 0.45], M.paperDiffuser, [0, 1.49, 0]);
  const chamberLights: THREE.Matrix4[] = [];
  for (let i = 0; i < 4; i++) {
    chamberLights.push(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.sin(i * Math.PI * 0.5) * 0.229, 1.49, Math.cos(i * Math.PI * 0.5) * 0.229),
      new THREE.Quaternion().setFromAxisAngle(Y_AXIS, i * Math.PI * 0.5),
      new THREE.Vector3(1, 1, 1),
    ));
  }
  instances(group, "lantern-paper-light-slits", geometry("stone-lantern-light-slit", () => new THREE.PlaneGeometry(0.1, 0.34)), M.paper, chamberLights);
  const posts: THREE.Matrix4[] = [];
  for (const x of [-0.255, 0.255]) {
    for (const z of [-0.255, 0.255]) {
      posts.push(new THREE.Matrix4().compose(
        new THREE.Vector3(x, 1.49, z),
        new THREE.Quaternion(),
        new THREE.Vector3(0.07, 0.56, 0.07),
      ));
    }
  }
  instances(group, "lantern-chamber-posts", unitBeveledBox(), M.stone, posts);
  beveledBox(group, "lantern-chamber-lintel", [0.6, 0.08, 0.6], 0.02, M.stone, [0, 1.74, 0]);
  beveledBox(group, "lantern-roof-slab", [0.82, 0.1, 0.82], 0.03, M.stone, [0, 1.82, 0]);
  const roof = part(group, "lantern-hip-roof", geometry("stone-lantern-roof-v2", () => new THREE.ConeGeometry(0.62, 0.28, 4)), M.stone, [0, 1.97, 0]);
  roof.rotation.y = Math.PI * 0.25;
  const hips: Segment[] = [];
  for (const x of [-0.46, 0.46]) for (const z of [-0.46, 0.46]) hips.push({ a: [0, 2.105, 0], b: [x, 1.84, z], r: 0.022 });
  segmentInstances(group, "lantern-roof-hips", hips, M.stone, 6);
  cylinder(group, "lantern-finial-neck", 0.055, 0.08, 0.1, M.stone, [0, 2.12, 0], 10);
  sphere(group, "lantern-finial", [0.09, 0.09, 0.09], M.stone, [0, 2.19, 0], "round");
  group.userData.lightSocket = [0, 1.49, 0];
  group.userData.glowMaterial = "kt_paper_red_glow";
  return group;
}

function paperLanternRadius(y: number): number {
  const profile = [[-0.52, 0.24], [-0.44, 0.31], [-0.22, 0.36], [0, 0.37], [0.22, 0.36], [0.44, 0.31], [0.52, 0.24]];
  for (let i = 0; i < profile.length - 1; i++) {
    const [y0, r0] = profile[i];
    const [y1, r1] = profile[i + 1];
    if (y >= y0 && y <= y1) return THREE.MathUtils.lerp(r0, r1, (y - y0) / (y1 - y0));
  }
  return 0.24;
}

function createPaperLantern(): THREE.Group {
  const group = root("lantern-paper");
  const swing = makePivot(group, "lantern-swing", [0, 0, 0]);
  segment(swing, "suspension-cord", [0, 0, 0], [0, -0.26, 0], 0.016, M.rope, 6);
  torus(swing, "suspension-loop", 0.085, 0.014, M.iron, [0, -0.09, 0], 14);
  cylinder(swing, "upper-cap", 0.25, 0.25, 0.1, M.iron, [0, -0.3, 0], 20);
  const profile = [
    new THREE.Vector2(0.24, -0.52), new THREE.Vector2(0.31, -0.44),
    new THREE.Vector2(0.36, -0.22), new THREE.Vector2(0.37, 0),
    new THREE.Vector2(0.36, 0.22), new THREE.Vector2(0.31, 0.44), new THREE.Vector2(0.24, 0.52),
  ];
  part(swing, "paper-shell", geometry("paper-lantern-shell-v2", () => new THREE.LatheGeometry(profile, 24)), M.paperDiffuser, [0, -0.86, 0]);
  const lightStrip = geometry("paper-lantern-light-strip-v2", () => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= 14; i++) {
      const y = -0.5 + i / 14;
      const radius = paperLanternRadius(y) + 0.005;
      for (const angle of [-0.11, 0.11]) positions.push(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
      if (i < 14) {
        const a = i * 2;
        indices.push(a, a + 3, a + 2, a, a + 1, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  });
  const lightStrips = Array.from({ length: 8 }, (_, i) => new THREE.Matrix4().compose(
    new THREE.Vector3(0, -0.86, 0),
    new THREE.Quaternion().setFromAxisAngle(Y_AXIS, (i / 8) * Math.PI * 2),
    new THREE.Vector3(1, 1, 1),
  ));
  instances(swing, "paper-light-strips", lightStrip, M.paper, lightStrips);
  cylinder(swing, "lower-cap", 0.25, 0.25, 0.1, M.iron, [0, -1.41, 0], 20);
  const ribs: THREE.Matrix4[] = [];
  const ribRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.5);
  for (let i = 0; i < 14; i++) {
    const localY = -0.475 + (i / 13) * 0.95;
    const radius = paperLanternRadius(localY) + 0.005;
    ribs.push(new THREE.Matrix4().compose(
      new THREE.Vector3(0, -0.86 + localY, 0),
      ribRotation,
      new THREE.Vector3(radius, radius, radius),
    ));
  }
  instances(swing, "bamboo-ribs", geometry("paper-lantern-rib-v2", () => new THREE.TorusGeometry(1, 0.026, 4, 16)), M.iron, ribs);
  const seam = geometry("paper-lantern-seam-v2", () => {
    const points = Array.from({ length: 15 }, (_, i) => {
      const y = -0.5 + i / 14;
      return new THREE.Vector3(0, y - 0.86, paperLanternRadius(y) + 0.012);
    });
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 28, 0.009, 4, false);
  });
  const seams = Array.from({ length: 4 }, (_, i) => new THREE.Matrix4().makeRotationY(Math.PI * 0.25 + i * Math.PI * 0.5));
  instances(swing, "vertical-frame-seams", seam, M.iron, seams);
  const marks = [
    new THREE.Matrix4().makeTranslation(0, -0.86, 0.39),
    new THREE.Matrix4().compose(new THREE.Vector3(0, -0.86, -0.39), new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI), new THREE.Vector3(1, 1, 1)),
  ];
  instances(swing, "diamond-crests", diamondGeometry(0.3, 0.3), M.clothDark, marks);
  group.userData.lightSocket = [0, -0.86, 0];
  group.userData.glowMaterial = "kt_paper_red_glow";
  return animated(group, { swing });
}

function createKomainu(): THREE.Group {
  const group = root("komainu");
  beveledBox(group, "guardian-plinth", [1.14, 0.4, 1.3], 0.055, M.stone, [0, 0.2, 0]);
  beveledBox(group, "guardian-plinth-cap", [1.24, 0.1, 1.4], 0.025, M.stone, [0, 0.45, 0]);
  sphere(group, "seated-body", [0.44, 0.61, 0.41], M.stone, [0, 1.18, -0.08], "sculpt");
  sphere(group, "upright-chest", [0.37, 0.52, 0.32], M.stone, [0, 1.52, 0.19], "sculpt");
  const haunches: THREE.Matrix4[] = [];
  const shoulders: THREE.Matrix4[] = [];
  for (const x of [-0.32, 0.32]) {
    haunches.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.87, -0.16), new THREE.Quaternion(), new THREE.Vector3(0.34, 0.38, 0.4)));
    shoulders.push(new THREE.Matrix4().compose(new THREE.Vector3(x * 0.78, 1.45, 0.27), new THREE.Quaternion(), new THREE.Vector3(0.19, 0.27, 0.22)));
  }
  const sculptSphere = geometry("unit-sphere:sculpt", () => new THREE.SphereGeometry(1, 18, 12));
  instances(group, "seated-haunches", sculptSphere, M.stone, haunches);
  instances(group, "shoulder-muscles", sculptSphere, M.stone, shoulders);
  const toes: THREE.Matrix4[] = [];
  for (const x of [-0.23, 0.23]) {
    cylinder(group, `foreleg:${x}`, 0.09, 0.125, 0.62, M.stone, [x, 0.91, 0.4], 12);
    sphere(group, `forepaw:${x}`, [0.18, 0.1, 0.25], M.stone, [x, 0.56, 0.55], "sculpt");
    for (const offset of [-0.085, 0, 0.085]) toes.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x + offset, 0.59, 0.735),
      new THREE.Quaternion(),
      new THREE.Vector3(0.052, 0.035, 0.075),
    ));
  }
  instances(group, "carved-toes", geometry("unit-sphere:round", () => new THREE.SphereGeometry(1, 12, 8)), M.stone, toes);
  sphere(group, "mane-volume", [0.49, 0.51, 0.3], M.stone, [0, 1.99, 0.12], "sculpt");
  sphere(group, "head", [0.4, 0.39, 0.36], M.stone, [0, 2.03, 0.3], "sculpt");
  const curls: THREE.Matrix4[] = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const radius = i % 2 ? 0.44 : 0.47;
    curls.push(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(angle) * radius, 1.98 + Math.sin(angle) * 0.47, 0.32 + (i % 2) * 0.035),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, angle * 0.5)),
      new THREE.Vector3(1, 1, 1),
    ));
  }
  instances(group, "carved-mane-curls", geometry("komainu-curl-v2", () => new THREE.TorusGeometry(0.073, 0.024, 5, 10)), M.stone, curls);
  const cheeks: THREE.Matrix4[] = [];
  const jowls: THREE.Matrix4[] = [];
  const eyes: THREE.Matrix4[] = [];
  for (const x of [-0.18, 0.18]) {
    cheeks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 1.96, 0.49), new THREE.Quaternion(), new THREE.Vector3(0.21, 0.22, 0.2)));
    jowls.push(new THREE.Matrix4().compose(new THREE.Vector3(x * 0.62, 1.9, 0.64), new THREE.Quaternion(), new THREE.Vector3(0.17, 0.13, 0.18)));
    eyes.push(new THREE.Matrix4().compose(new THREE.Vector3(x * 0.9, 2.105, 0.596), new THREE.Quaternion(), new THREE.Vector3(0.045, 0.038, 0.03)));
  }
  instances(group, "lion-cheeks", sculptSphere, M.stone, cheeks);
  instances(group, "paired-muzzle", sculptSphere, M.stone, jowls);
  instances(group, "recessed-eyes", geometry("unit-sphere:round", () => new THREE.SphereGeometry(1, 12, 8)), M.eye, eyes);
  const brows: Segment[] = [
    { a: [-0.29, 2.16, 0.56], b: [-0.06, 2.13, 0.62], r: 0.045 },
    { a: [0.06, 2.13, 0.62], b: [0.29, 2.16, 0.56], r: 0.045 },
  ];
  segmentInstances(group, "carved-brows", brows, M.stone, 8);
  sphere(group, "nose", [0.125, 0.08, 0.09], M.iron, [0, 1.99, 0.795], "round");
  beveledBox(group, "open-mouth-cavity", [0.3, 0.12, 0.055], 0.018, M.iron, [0, 1.79, 0.74]);
  sphere(group, "lower-jaw", [0.23, 0.09, 0.19], M.stone, [0, 1.7, 0.62], "sculpt");
  for (const x of [-0.27, 0.27]) {
    const ear = part(group, `ear:${x}`, geometry("komainu-ear-v2", () => new THREE.ConeGeometry(0.13, 0.28, 7)), M.stone, [x, 2.36, 0.25]);
    ear.rotation.z = -Math.sign(x) * 0.28;
    sphere(group, `ear-inner:${x}`, [0.055, 0.09, 0.035], M.iron, [x, 2.35, 0.34]);
  }
  const tailPoints = [
    new THREE.Vector3(0, 0.95, -0.38), new THREE.Vector3(0.18, 1.12, -0.65),
    new THREE.Vector3(0.27, 1.5, -0.62), new THREE.Vector3(0.1, 1.73, -0.43),
    new THREE.Vector3(-0.02, 1.58, -0.3),
  ];
  part(group, "curled-tail", geometry("komainu-tail-v2", () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tailPoints), 32, 0.085, 8, false)), M.stone);
  sphere(group, "tail-tuft", [0.13, 0.16, 0.13], M.stone, [-0.02, 1.57, -0.3], "sculpt");
  return group;
}

function createSakeBarrel(): THREE.Group {
  const group = root("sake-barrel");
  const profile = [
    new THREE.Vector2(0.34, 0), new THREE.Vector2(0.39, 0.08),
    new THREE.Vector2(0.43, 0.4), new THREE.Vector2(0.41, 0.72), new THREE.Vector2(0.34, 0.9),
  ];
  part(group, "barrel-staves", geometry("sake-barrel-body-v2", () => new THREE.LatheGeometry(profile, 18)), M.straw);
  const seam = geometry("sake-barrel-stave-seam-v2", () => {
    const points = Array.from({ length: 11 }, (_, i) => {
      const y = 0.025 + (i / 10) * 0.85;
      return new THREE.Vector3(0, y, 0.345 + 0.09 * Math.sin((y / 0.9) * Math.PI));
    });
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 20, 0.005, 4, false);
  });
  instances(group, "barrel-stave-seams", seam, M.cedarCut, Array.from({ length: 14 }, (_, i) => new THREE.Matrix4().makeRotationY((i / 14) * Math.PI * 2)));
  cylinder(group, "barrel-lid", 0.345, 0.345, 0.045, M.cedarCut, [0, 0.9, 0], 18);
  cylinder(group, "barrel-bottom", 0.34, 0.34, 0.035, M.cedarCut, [0, 0.018, 0], 18);
  const lidBoards = [-0.22, -0.075, 0.075, 0.22].map((x) => new THREE.Matrix4().compose(
    new THREE.Vector3(x, 0.925, 0), new THREE.Quaternion(), new THREE.Vector3(0.012, 0.006, 0.54),
  ));
  instances(group, "barrel-lid-board-seams", geometry("unit-box", () => new THREE.BoxGeometry(1, 1, 1)), M.cedar, lidBoards);
  const hoops: THREE.Matrix4[] = [];
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.5);
  for (const y of [0.08, 0.23, 0.43, 0.63, 0.77, 0.86]) {
    const radius = 0.35 + 0.09 * Math.sin((y / 0.9) * Math.PI);
    hoops.push(new THREE.Matrix4().compose(new THREE.Vector3(0, y, 0), rotation, new THREE.Vector3(radius, radius, radius)));
  }
  instances(group, "barrel-hoops", geometry("barrel-hoop-v2", () => new THREE.TorusGeometry(1, 0.028, 4, 18)), M.rope, hoops);
  torus(group, "barrel-tie-knot", 0.052, 0.016, M.rope, [0, 0.43, 0.452], 12);
  segmentInstances(group, "barrel-knot-tails", [
    { a: [-0.025, 0.41, 0.455], b: [-0.055, 0.31, 0.45], r: 0.012 },
    { a: [0.025, 0.41, 0.455], b: [0.06, 0.33, 0.45], r: 0.012 },
  ], M.rope, 5);
  part(group, "barrel-label", geometry("barrel-label-v2", () => new THREE.PlaneGeometry(0.24, 0.3)), M.underWrap, [0, 0.49, 0.438]);
  part(group, "barrel-diamond", diamondGeometry(0.14, 0.14), M.darkLacquer, [0, 0.49, 0.441]);
  return group;
}

function createSakeBarrelStack(): THREE.Group {
  const group = root("sake-barrels");
  const prototype = createSakeBarrel();
  prototype.updateMatrixWorld(true);
  const batches = new Map<string, { name: string; geo: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }>();
  const poses: V3[] = [
    [-0.47, 0, -0.44], [0.47, 0, -0.44], [-0.47, 0, 0.44], [0.47, 0, 0.44], [0, 0.93, 0],
  ];
  for (const position of poses) {
    const pose = new THREE.Matrix4().makeTranslation(...position);
    prototype.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      const key = `${object.geometry.uuid}:${object.material.uuid}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { name: object.name, geo: object.geometry, material: object.material, matrices: [] };
        batches.set(key, batch);
      }
      const base = pose.clone().multiply(object.matrix);
      if (object instanceof THREE.InstancedMesh) {
        const instance = new THREE.Matrix4();
        for (let i = 0; i < object.count; i++) {
          object.getMatrixAt(i, instance);
          batch.matrices.push(base.clone().multiply(instance));
        }
      } else {
        batch.matrices.push(base);
      }
    });
  }
  for (const batch of batches.values()) instances(group, `stack-${batch.name}`, batch.geo, batch.material, batch.matrices);
  return group;
}

function createCart(): THREE.Group {
  const group = root("cart");
  const bedPlanks = Array.from({ length: 5 }, (_, i) => new THREE.Matrix4().compose(
    new THREE.Vector3(-0.56 + i * 0.28, 0.7, 0), new THREE.Quaternion(), new THREE.Vector3(0.265, 0.13, 1.85),
  ));
  instances(group, "cart-bed-planks", unitBeveledBox(), M.cedar, bedPlanks);
  const slats: THREE.Matrix4[] = [];
  const posts: THREE.Matrix4[] = [];
  const brackets: THREE.Matrix4[] = [];
  for (const x of [-0.69, 0.69]) {
    for (const y of [0.91, 1.13, 1.35]) slats.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, 0), new THREE.Quaternion(), new THREE.Vector3(0.09, 0.16, 1.9),
    ));
    for (const z of [-0.88, 0.88]) {
      posts.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 1.05, z), new THREE.Quaternion(), new THREE.Vector3(0.13, 0.82, 0.13)));
      for (const y of [0.91, 1.35]) brackets.push(new THREE.Matrix4().compose(
        new THREE.Vector3(x * 1.025, y, z), new THREE.Quaternion(), new THREE.Vector3(0.025, 0.1, 0.18),
      ));
    }
  }
  for (const z of [-0.9, 0.9]) for (const y of [0.91, 1.13, 1.35]) slats.push(new THREE.Matrix4().compose(
    new THREE.Vector3(0, y, z), new THREE.Quaternion(), new THREE.Vector3(1.4, 0.16, 0.08),
  ));
  instances(group, "cart-side-slats", unitBeveledBox(), M.cedarCut, slats);
  instances(group, "cart-corner-posts", unitBeveledBox(), M.cedar, posts);
  instances(group, "cart-iron-brackets", unitBeveledBox(), M.iron, brackets);
  segmentInstances(group, "cart-diagonal-braces", [
    { a: [-0.72, 0.8, -0.8], b: [-0.72, 1.42, 0.8], r: 0.035 },
    { a: [0.72, 0.8, -0.8], b: [0.72, 1.42, 0.8], r: 0.035 },
  ], M.cedarCut, 6);
  segment(group, "axle", [-1.02, 0.59, -0.15], [1.02, 0.59, -0.15], 0.07, M.iron, 10);
  segmentInstances(group, "cart-handles", [
    { a: [-0.56, 0.72, 0.65], b: [-0.56, 0.87, 2.45], r: 0.055 },
    { a: [0.56, 0.72, 0.65], b: [0.56, 0.87, 2.45], r: 0.055 },
  ], M.cedarCut, 8);

  const makeWheel = (name: string, x: number): THREE.Group => {
    const wheel = makePivot(group, name, [x, 0.59, -0.15]);
    const rim = torus(wheel, "wheel-rim", 0.52, 0.05, M.cedarCut, [0, 0, 0], 24);
    rim.rotation.y = Math.PI * 0.5;
    const tire = torus(wheel, "wheel-iron-tire", 0.565, 0.018, M.iron, [0, 0, 0], 24);
    tire.rotation.y = Math.PI * 0.5;
    const spokes: THREE.Matrix4[] = [];
    const bolts: THREE.Matrix4[] = [];
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      const direction = new THREE.Vector3(0, Math.sin(angle), Math.cos(angle));
      spokes.push(new THREE.Matrix4().compose(
        direction.clone().multiplyScalar(0.25), new THREE.Quaternion().setFromUnitVectors(Z_AXIS, direction), new THREE.Vector3(0.035, 0.035, 0.5),
      ));
      bolts.push(new THREE.Matrix4().compose(
        new THREE.Vector3(Math.sign(x) * 0.11, Math.sin(angle) * 0.075, Math.cos(angle) * 0.075),
        new THREE.Quaternion(), new THREE.Vector3(0.018, 0.018, 0.018),
      ));
    }
    instances(wheel, "wheel-spokes", unitBeveledBox(), M.cedarCut, spokes);
    const hub = cylinder(wheel, "wheel-hub", 0.1, 0.1, 0.2, M.iron, [0, 0, 0], 12);
    hub.rotation.z = Math.PI * 0.5;
    instances(wheel, "wheel-hub-bolts", geometry("unit-sphere:low", () => new THREE.SphereGeometry(1, 8, 6)), M.iron, bolts);
    return wheel;
  };
  const wheelLeft = makeWheel("wheel-left", -0.9);
  const wheelRight = makeWheel("wheel-right", 0.9);
  return animated(group, { wheelLeft, wheelRight });
}

function bambooLeafGeometry(): THREE.ShapeGeometry {
  return geometry("bamboo-leaf", () => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(0.12, 0.36, 0, 1);
    shape.quadraticCurveTo(-0.12, 0.36, 0, 0);
    return new THREE.ShapeGeometry(shape, 2);
  });
}

function createBamboo(): THREE.Group {
  const group = root("bamboo");
  const wind = makePivot(group, "bamboo-wind", [0, 0, 0]);
  const bases: Array<[number, number, number, number, number]> = [
    [-0.5, -0.25, 4.5, -0.22, 0.1],
    [-0.2, 0.25, 5.0, 0.12, -0.18],
    [0.1, -0.35, 4.1, 0.28, 0.08],
    [0.38, 0.12, 4.8, -0.08, 0.24],
    [0.55, -0.28, 3.9, 0.2, -0.12],
    [-0.42, 0.42, 4.25, -0.25, 0.18],
    [0.18, 0.48, 4.6, 0.16, 0.2],
  ];
  const stems: Segment[] = [];
  const nodes: THREE.Matrix4[] = [];
  const leaves: THREE.Matrix4[] = [];
  bases.forEach(([x, z, height, dx, dz], stemIndex) => {
    const top: V3 = [x + dx, height, z + dz];
    stems.push({ a: [x, 0, z], b: top, r: 0.047 + (stemIndex % 3) * 0.005 });
    const direction = new THREE.Vector3(...top).sub(new THREE.Vector3(x, 0, z)).normalize();
    const nodeRotation = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, direction);
    for (let node = 1; node <= 7; node++) {
      const t = node / 8;
      const position = new THREE.Vector3(x + dx * t, height * t, z + dz * t);
      nodes.push(new THREE.Matrix4().compose(position, nodeRotation, new THREE.Vector3(1, 1, 1)));
      if (node < 4) continue;
      for (let side = 0; side < 2; side++) {
        const yaw = stemIndex * 1.71 + node * 2.2 + side * Math.PI;
        const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.65, yaw, 0.35 * (side ? 1 : -1)));
        leaves.push(new THREE.Matrix4().compose(
          position.clone(),
          quaternion,
          new THREE.Vector3(0.8, 0.48 + (stemIndex % 2) * 0.1, 0.8),
        ));
      }
    }
  });
  segmentInstances(wind, "bamboo-stems", stems, M.bamboo, 7);
  instances(
    wind,
    "bamboo-nodes",
    geometry("bamboo-node-ring", () => new THREE.TorusGeometry(0.055, 0.009, 4, 7)),
    M.bambooNode,
    nodes,
  );
  instances(wind, "bamboo-leaves", bambooLeafGeometry(), M.leaf, leaves);
  return animated(group, { wind });
}

function mapleLeafGeometry(): THREE.ShapeGeometry {
  return geometry("maple-leaf", () => {
    const shape = new THREE.Shape();
    const points = [
      [0, 0.55], [0.09, 0.18], [0.34, 0.35], [0.22, 0.05], [0.48, 0.02],
      [0.17, -0.12], [0.22, -0.38], [0, -0.22], [-0.22, -0.38], [-0.17, -0.12],
      [-0.48, 0.02], [-0.22, 0.05], [-0.34, 0.35], [-0.09, 0.18],
    ];
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  });
}

function createMaple(): THREE.Group {
  const group = root("maple");
  const branches: Segment[] = [
    { a: [0, 0, 0], b: [-0.18, 2.4, 0.08], r: 0.17 },
    { a: [-0.18, 2.1, 0.08], b: [-1.25, 3.25, 0.15], r: 0.1 },
    { a: [-0.18, 2.25, 0.08], b: [1.25, 3.5, -0.15], r: 0.09 },
    { a: [-0.15, 2.35, 0.08], b: [0.1, 4.25, -0.25], r: 0.085 },
    { a: [-0.9, 2.9, 0.13], b: [-1.8, 3.35, 0.45], r: 0.05 },
    { a: [0.85, 3.15, -0.08], b: [1.8, 3.55, 0.35], r: 0.05 },
    { a: [0.05, 3.6, -0.15], b: [-0.65, 4.35, -0.6], r: 0.045 },
    { a: [0.15, 3.4, -0.1], b: [0.9, 4.25, 0.1], r: 0.045 },
  ];
  segmentInstances(group, "maple-trunk-and-boughs", branches, M.cedar, 8);
  const wind = makePivot(group, "maple-crown-wind", [0, 3, 0]);
  const random = seeded(8417);
  const clusters: Array<[number, number, number, number]> = [
    [-1.3, 3.45, 0.2, 0.9], [1.25, 3.65, 0.1, 0.95], [0, 4.35, -0.25, 0.85],
    [-0.55, 4.15, -0.65, 0.72], [1.65, 3.45, 0.4, 0.65], [-1.75, 3.3, 0.45, 0.62],
  ];
  const red: THREE.Matrix4[] = [];
  const dark: THREE.Matrix4[] = [];
  for (let i = 0; i < 180; i++) {
    const cluster = clusters[i % clusters.length];
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * cluster[3];
    const position = new THREE.Vector3(
      cluster[0] + Math.cos(angle) * radius,
      cluster[1] - 3 + (random() - 0.5) * 0.55,
      cluster[2] + Math.sin(angle) * radius * 0.7,
    );
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(random() * Math.PI, random() * Math.PI * 2, random() * Math.PI),
    );
    const size = 0.2 + random() * 0.16;
    const matrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(size, size, size));
    (i % 3 === 0 ? dark : red).push(matrix);
  }
  const leafGeo = mapleLeafGeometry();
  instances(wind, "maple-leaves-red", leafGeo, M.maple, red);
  instances(wind, "maple-leaves-shadow", leafGeo, M.mapleDark, dark);
  return animated(group, { wind });
}

function createPine(): THREE.Group {
  const group = root("pine");
  const branches: Segment[] = [
    { a: [0, 0, 0], b: [0.18, 2.6, 0], r: 0.2 },
    { a: [0.18, 2.2, 0], b: [-0.25, 4.25, 0.1], r: 0.12 },
    { a: [0.1, 1.9, 0], b: [-1.55, 2.55, 0.15], r: 0.1 },
    { a: [0.15, 2.4, 0], b: [1.65, 2.95, -0.2], r: 0.09 },
    { a: [0, 3.05, 0.05], b: [-1.15, 3.55, -0.35], r: 0.07 },
    { a: [-0.1, 3.55, 0.08], b: [1.05, 4.0, 0.25], r: 0.06 },
    { a: [-1.0, 2.35, 0.1], b: [-1.95, 2.55, 0.45], r: 0.045 },
    { a: [1.1, 2.75, -0.15], b: [1.95, 2.9, 0.2], r: 0.04 },
  ];
  segmentInstances(group, "pine-trunk-and-boughs", branches, M.cedar, 8);
  const wind = makePivot(group, "pine-crown-wind", [0, 2.8, 0]);
  const pads: Array<[V3, V3]> = [
    [[-1.65, 2.65, 0.25], [1.0, 0.22, 0.72]],
    [[-0.85, 2.75, -0.1], [0.85, 0.2, 0.62]],
    [[1.55, 3.0, 0], [1.05, 0.24, 0.7]],
    [[0.75, 3.15, -0.3], [0.8, 0.2, 0.58]],
    [[-1.05, 3.65, -0.3], [0.9, 0.22, 0.65]],
    [[0.95, 4.05, 0.2], [0.82, 0.21, 0.6]],
    [[-0.25, 4.4, 0.1], [0.75, 0.25, 0.58]],
    [[-1.95, 2.6, 0.45], [0.62, 0.17, 0.5]],
    [[1.95, 2.95, 0.2], [0.62, 0.17, 0.5]],
  ];
  const matrices = pads.map(([position, scale], index) => new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1] - 2.8, position[2]),
    new THREE.Quaternion().setFromAxisAngle(Y_AXIS, index * 0.73),
    new THREE.Vector3(...scale),
  ));
  instances(
    wind,
    "pine-needle-pads",
    geometry("pine-pad", () => new THREE.IcosahedronGeometry(1, 1)),
    M.leaf,
    matrices,
  );
  return animated(group, { wind });
}

function createBell(): THREE.Group {
  const group = root("bell");
  const swing = makePivot(group, "bell-swing", [0, 3.25, 0]);
  segment(swing, "bell-suspension", [0, 0, 0], [0, -0.4, 0], 0.045, M.iron, 10);
  const loop = torus(swing, "bell-loop", 0.17, 0.04, M.bronze, [0, -0.52, 0], 20);
  loop.scale.y = 1.25;
  sphere(swing, "bell-crown", [0.13, 0.1, 0.13], M.bronze, [0, -0.72, 0], "round");
  const profile = [
    [0.65, 0], [0.67, 0.08], [0.58, 0.18], [0.52, 0.4], [0.46, 1.15],
    [0.32, 1.45], [0.16, 1.55], [0.12, 1.55], [0.12, 1.42], [0.28, 1.32],
    [0.4, 1.1], [0.46, 0.35], [0.54, 0.12], [0.58, 0.05], [0.65, 0],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  part(swing, "bronze-bell", geometry("shrine-bell-shell-v2", () => new THREE.LatheGeometry(profile, 28)), M.bronze, [0, -2.25, 0]);
  for (const [y, radius] of [[-2.12, 0.63], [-1.3, 0.46], [-0.93, 0.39]]) {
    const band = torus(swing, `bell-band:${y}`, radius, 0.028, M.bronze, [0, y, 0], 24);
    band.rotation.x = Math.PI * 0.5;
  }
  const bosses: THREE.Matrix4[] = [];
  const reliefs: THREE.Matrix4[] = [];
  for (let row = 0; row < 2; row++) for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const radius = 0.43 - row * 0.04;
    bosses.push(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(angle) * radius, -1.18 + row * 0.22, Math.sin(angle) * radius),
      new THREE.Quaternion(), new THREE.Vector3(0.045, 0.045, 0.045),
    ));
    if (row === 0) reliefs.push(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.sin(angle) * 0.455, -1.48, Math.cos(angle) * 0.455),
      new THREE.Quaternion().setFromAxisAngle(Y_AXIS, angle), new THREE.Vector3(1, 1, 1),
    ));
  }
  instances(swing, "bell-bosses", geometry("unit-sphere:low", () => new THREE.SphereGeometry(1, 8, 6)), M.bronze, bosses);
  instances(swing, "bell-diamond-reliefs", diamondGeometry(0.09, 0.13), M.bronze, reliefs);
  const rib = geometry("bell-vertical-rib-v2", () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -2.18, 0.64), new THREE.Vector3(0, -2.04, 0.56),
    new THREE.Vector3(0, -1.82, 0.5), new THREE.Vector3(0, -1.12, 0.44), new THREE.Vector3(0, -0.86, 0.33),
  ]), 20, 0.012, 5, false));
  instances(swing, "bell-vertical-ribs", rib, M.bronze, Array.from({ length: 12 }, (_, i) => new THREE.Matrix4().makeRotationY((i / 12) * Math.PI * 2)));
  const clapper = makePivot(swing, "bell-clapper-pivot", [0, -0.72, 0]);
  segment(clapper, "clapper-stem", [0, 0, 0], [0, -1.25, 0], 0.035, M.iron, 8);
  sphere(clapper, "clapper-weight", [0.14, 0.18, 0.14], M.iron, [0, -1.33, 0], "round");
  return animated(group, { swing, clapper });
}

function createTsukubai(): THREE.Group {
  const group = root("tsukubai");
  sphere(group, "basin-foot-left", [0.4, 0.18, 0.34], M.rock, [-0.28, 0.16, 0.05]);
  sphere(group, "basin-foot-right", [0.35, 0.15, 0.32], M.rock, [0.3, 0.13, -0.08]);
  const profile = [
    [0.4, 0], [0.52, 0.15], [0.59, 0.43], [0.56, 0.58], [0.47, 0.63],
    [0.4, 0.56], [0.36, 0.2], [0.4, 0],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  part(group, "hollow-stone-basin", geometry("tsukubai-basin", () => new THREE.LatheGeometry(profile, 18)), M.stone, [0, 0.18, 0]);
  const water = part(
    group,
    "basin-water",
    geometry("tsukubai-water", () => new THREE.CircleGeometry(0.4, 20)),
    M.water,
    [0, 0.665, 0],
  );
  water.rotation.x = -Math.PI * 0.5;
  water.castShadow = false;
  segment(group, "spout-upright", [0.68, 0, -0.22], [0.68, 1.35, -0.22], 0.055, M.bamboo, 8);
  segment(group, "spout-horizontal", [0.68, 1.25, -0.22], [0.08, 1.08, 0], 0.065, M.bamboo, 8);
  const drip = makePivot(group, "tsukubai-drip", [0.08, 0.98, 0]);
  sphere(drip, "water-drop", [0.025, 0.055, 0.025], M.water, [0, -0.06, 0], "round");
  segment(group, "ladle-handle", [-0.65, 0.86, 0.25], [0.55, 0.86, -0.25], 0.025, M.bambooNode, 7);
  cylinder(group, "ladle-cup", 0.1, 0.08, 0.09, M.bambooNode, [-0.58, 0.87, 0.22], 10);
  return animated(group, { drip });
}

function createShishiOdoshi(): THREE.Group {
  const group = root("shishi-odoshi");
  box(group, "shishi-base", [0.85, 0.12, 0.75], M.stone, [0, 0.06, 0]);
  for (const x of [-0.3, 0.3]) {
    segment(group, `rocker-support:${x}`, [x, 0.1, 0], [x, 1.05, 0], 0.055, M.bamboo, 8);
  }
  segment(group, "rocker-axle", [-0.4, 0.9, 0], [0.4, 0.9, 0], 0.035, M.iron, 8);
  const rocker = makePivot(group, "shishi-rocker", [0, 0.9, 0]);
  rocker.rotation.x = -0.18;
  const tube = cylinder(rocker, "hollow-bamboo-tube", 0.105, 0.105, 1.55, M.bamboo, [0, 0, 0], 10, true);
  tube.rotation.x = Math.PI * 0.5;
  for (const z of [-0.58, 0, 0.58]) {
    torus(rocker, `tube-node:${z}`, 0.108, 0.012, M.bambooNode, [0, 0, z], 10);
  }
  part(rocker, "open-tube-mouth", geometry("shishi-mouth", () => new THREE.CircleGeometry(0.088, 10)), M.eye, [0, 0, 0.781]);
  segment(group, "water-spout-upright", [0, 0, -1.0], [0, 1.35, -1.0], 0.045, M.bamboo, 8);
  segment(group, "water-spout", [0, 1.3, -1.0], [0, 1.22, -0.55], 0.05, M.bamboo, 8);
  const drip = makePivot(group, "shishi-drip", [0, 1.15, -0.55]);
  sphere(drip, "water-drop", [0.022, 0.05, 0.022], M.water, [0, -0.05, 0]);
  sphere(group, "catch-stone", [0.42, 0.16, 0.35], M.stone, [0, 0.15, 0.88]);
  return animated(group, { rocker, drip });
}

function clothPanelGeometry(key: string, width: number, height: number, segmentsX: number, segmentsY: number): THREE.BufferGeometry {
  return geometry(`cloth-panel-v2:${key}`, () => {
    const geo = new THREE.PlaneGeometry(width, height, segmentsX, segmentsY);
    const position = geo.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const looseness = THREE.MathUtils.clamp((height * 0.5 - y) / height, 0, 1);
      const fold = Math.sin((x / width) * Math.PI * 6 + y * 2.4) * 0.022 * looseness;
      const crossFold = Math.sin(y * 8 + x * 11) * 0.007 * looseness;
      const hem = y < -height * 0.42 ? Math.sin(x * 17) * 0.018 * looseness : 0;
      position.setXYZ(i, x * (1 - 0.055 * (1 - looseness)), y + hem, fold + crossFold);
    }
    geo.computeVertexNormals();
    return geo;
  });
}

function createNoren(): THREE.Group {
  const group = root("noren");
  segment(group, "noren-rod", [-0.92, 2.2, 0], [0.92, 2.2, 0], 0.035, M.cedarCut, 10);
  const loops: THREE.Matrix4[] = [];
  const loopRotation = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI * 0.5);
  const pivots: Record<string, THREE.Group> = {};
  [-0.56, 0, 0.56].forEach((x, index) => {
    const key = ["left", "center", "right"][index];
    const cloth = makePivot(group, `noren-${key}`, [x, 2.12, 0]);
    part(cloth, `noren-panel-${key}`, clothPanelGeometry("noren", 0.53, 1.08, 6, 10), M.cloth, [0, -0.54, 0]);
    beveledBox(cloth, `noren-hem-${key}`, [0.5, 0.025, 0.018], 0.005, M.darkLacquer, [0, -1.05, 0.008]);
    if (index === 1) part(cloth, "noren-central-crest", diamondGeometry(0.22, 0.22), M.clothDark, [0, -0.4, 0.035]);
    for (const offset of [-0.18, -0.06, 0.06, 0.18]) loops.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x + offset, 2.18, 0), loopRotation, new THREE.Vector3(1, 1, 1),
    ));
    pivots[key] = cloth;
  });
  instances(group, "noren-gathered-loops", geometry("noren-loop-v2", () => new THREE.TorusGeometry(0.04, 0.008, 4, 10)), M.clothDark, loops);
  return animated(group, pivots);
}

function createBanner(): THREE.Group {
  const group = root("banner");
  segment(group, "banner-pole", [-0.58, 0, 0], [-0.58, 3.45, 0], 0.045, M.cedar, 10);
  segment(group, "banner-crossbar", [-0.62, 3.2, 0], [0.6, 3.2, 0], 0.032, M.cedarCut, 10);
  const cloth = makePivot(group, "banner-cloth", [0, 3.15, 0]);
  part(cloth, "banner-fabric", clothPanelGeometry("banner", 1.05, 1.9, 6, 12), M.cloth, [0, -0.95, 0]);
  beveledBox(cloth, "banner-weighted-hem", [1.0, 0.03, 0.02], 0.006, M.darkLacquer, [0, -1.87, 0.01]);
  part(cloth, "banner-diamond", diamondGeometry(0.32, 0.32), M.clothDark, [0, -0.68, 0.04]);
  return animated(group, { cloth });
}

function koiBodyGeometry(): THREE.BufferGeometry {
  return geometry("koi-body-v2", () => {
    const rings = [
      [-0.48, 0.035, 0.03], [-0.36, 0.09, 0.065], [-0.2, 0.155, 0.095],
      [0, 0.18, 0.11], [0.18, 0.155, 0.1], [0.34, 0.115, 0.082],
      [0.45, 0.07, 0.055], [0.51, 0.025, 0.025],
    ];
    const sides = 16;
    const positions: number[] = [];
    for (const [z, rx, ry] of rings) for (let j = 0; j < sides; j++) {
      const angle = (j / sides) * Math.PI * 2;
      positions.push(Math.cos(angle) * rx, Math.sin(angle) * ry, z);
    }
    const white: number[] = [];
    const red: number[] = [];
    for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < sides; j++) {
      const next = (j + 1) % sides;
      const a = i * sides + j;
      const b = i * sides + next;
      const c = (i + 1) * sides + next;
      const d = (i + 1) * sides + j;
      const z = (rings[i][0] + rings[i + 1][0]) * 0.5;
      const angle = ((j + 0.5) / sides) * Math.PI * 2;
      const dorsal = Math.sin(angle) > 0.05;
      const headPatch = z > 0.25 && z < 0.43 && Math.cos(angle) > -0.5;
      const bodyPatch = z > -0.27 && z < 0.04 && Math.cos(angle) > -0.75;
      (dorsal && (headPatch || bodyPatch) ? red : white).push(a, c, d, a, b, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex([...white, ...red]);
    geo.addGroup(0, white.length, 0);
    geo.addGroup(white.length, red.length, 1);
    geo.computeVertexNormals();
    return geo;
  });
}

function koiFinGeometry(kind: "pectoral" | "dorsal" | "tail"): THREE.BufferGeometry {
  return geometry(`koi-fin-v2:${kind}`, () => {
    let triangles: number[];
    if (kind === "tail") {
      triangles = [
        0, 0, 0, -0.25, 0, -0.3, 0, 0.025, -0.16,
        -0.25, 0, -0.3, 0, 0, -0.2, 0, 0.025, -0.16,
        0, 0, -0.2, 0.25, 0, -0.3, 0, 0.025, -0.16,
        0.25, 0, -0.3, 0, 0, 0, 0, 0.025, -0.16,
      ];
    } else if (kind === "dorsal") {
      triangles = [
        0, 0, 0.2, 0, 0, -0.28, 0, 0.06, -0.08,
        0, 0, -0.28, 0, 0, -0.08, 0, 0.06, -0.08,
      ];
    } else {
      triangles = [
        0, 0, 0, 0.27, 0, -0.14, 0.12, 0.025, 0,
        0.27, 0, -0.14, 0.19, 0, 0.18, 0.12, 0.025, 0,
        0.19, 0, 0.18, 0, 0, 0.12, 0.12, 0.025, 0,
      ];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(triangles, 3));
    geo.computeVertexNormals();
    return geo;
  });
}

function createKoi(): THREE.Group {
  const group = root("koi");
  const swim = makePivot(group, "koi-swim", [0, 0, 0]);
  part(swim, "continuous-kohaku-body", koiBodyGeometry(), [M.koiWhite, M.koiRed]);
  const pectorals: THREE.Matrix4[] = [];
  for (const side of [-1, 1]) pectorals.push(new THREE.Matrix4().compose(
    new THREE.Vector3(side * 0.14, -0.025, 0.06),
    new THREE.Quaternion().setFromAxisAngle(Y_AXIS, side * 0.35),
    new THREE.Vector3(side, 1, 1),
  ));
  instances(swim, "koi-pectoral-fins", koiFinGeometry("pectoral"), M.koiFin, pectorals);
  part(swim, "koi-dorsal-fin", koiFinGeometry("dorsal"), M.koiFin, [0, 0.095, -0.02]);
  const eyes: THREE.Matrix4[] = [];
  for (const side of [-1, 1]) eyes.push(new THREE.Matrix4().compose(
    new THREE.Vector3(side * 0.072, 0.045, 0.435), new THREE.Quaternion(), new THREE.Vector3(0.022, 0.022, 0.018),
  ));
  instances(swim, "koi-eyes", geometry("unit-sphere:round", () => new THREE.SphereGeometry(1, 12, 8)), M.eye, eyes);
  const mouth = torus(swim, "koi-mouth", 0.026, 0.005, M.eye, [0, -0.006, 0.515], 12);
  mouth.scale.y = 0.55;
  segmentInstances(swim, "koi-barbels", [
    { a: [-0.035, -0.025, 0.48], b: [-0.09, -0.04, 0.57], r: 0.005 },
    { a: [0.035, -0.025, 0.48], b: [0.09, -0.04, 0.57], r: 0.005 },
  ], M.koiFin, 5);
  const tail = makePivot(swim, "koi-tail", [0, 0, -0.45]);
  part(tail, "koi-forked-tail", koiFinGeometry("tail"), M.koiFin);
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = false;
      object.receiveShadow = false;
    }
  });
  return animated(group, { swim, tail });
}

type Glyph = { shape: THREE.Shape; width: number };

function polygon(points: number[][]): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  return shape;
}

function glyph(letter: string): Glyph {
  let shape: THREE.Shape;
  let width = 0.72;
  switch (letter) {
    case "U":
      shape = polygon([[0, 0], [0, 1], [0.2, 1], [0.2, 0.2], [0.52, 0.2], [0.52, 1], [0.72, 1], [0.72, 0]]);
      break;
    case "P":
      shape = polygon([[0, 0], [0, 1], [0.68, 1], [0.68, 0.46], [0.2, 0.46], [0.2, 0]]);
      shape.holes.push(polygon([[0.2, 0.64], [0.48, 0.64], [0.48, 0.82], [0.2, 0.82]]));
      width = 0.68;
      break;
    case "M":
      shape = polygon([[0, 0], [0, 1], [0.2, 1], [0.4, 0.58], [0.6, 1], [0.8, 1], [0.8, 0], [0.6, 0], [0.6, 0.62], [0.45, 0.25], [0.35, 0.25], [0.2, 0.62], [0.2, 0]]);
      width = 0.8;
      break;
    case "I":
      shape = polygon([[0, 0], [0, 0.16], [0.2, 0.16], [0.2, 0.84], [0, 0.84], [0, 1], [0.6, 1], [0.6, 0.84], [0.4, 0.84], [0.4, 0.16], [0.6, 0.16], [0.6, 0]]);
      width = 0.6;
      break;
    case "D":
      shape = polygon([[0, 0], [0, 1], [0.72, 1], [0.72, 0], [0, 0]]);
      shape.holes.push(polygon([[0.2, 0.2], [0.2, 0.8], [0.5, 0.8], [0.5, 0.2], [0.2, 0.2]]));
      break;
    case "L":
      shape = polygon([[0, 0], [0, 1], [0.2, 1], [0.2, 0.2], [0.65, 0.2], [0.65, 0]]);
      width = 0.65;
      break;
    case "O":
      shape = polygon([[0, 0], [0, 1], [0.72, 1], [0.72, 0], [0, 0]]);
      shape.holes.push(polygon([[0.2, 0.2], [0.2, 0.8], [0.52, 0.8], [0.52, 0.2], [0.2, 0.2]]));
      break;
    case "W":
      shape = polygon([[0, 1], [0.2, 1], [0.3, 0.28], [0.4, 0.65], [0.5, 0.28], [0.6, 1], [0.8, 1], [0.65, 0], [0.48, 0], [0.4, 0.3], [0.32, 0], [0.15, 0]]);
      width = 0.8;
      break;
    default:
      throw new Error(`Unsupported lane glyph: ${letter}`);
  }
  return { shape, width };
}

function createMonument(word: "UP" | "MID" | "LOW"): THREE.Group {
  const group = root(`monument-${word.toLowerCase()}`);
  const height = 2.4;
  const spacing = 0.18;
  const glyphs = [...word].map(glyph);
  const totalWidth = glyphs.reduce((sum, item) => sum + item.width * height, 0) + spacing * (glyphs.length - 1);
  let cursor = -totalWidth * 0.5;
  glyphs.forEach((item, index) => {
    const letter = word[index];
    const geo = geometry(`lane-glyph:${letter}`, () => {
      const result = new THREE.ExtrudeGeometry(item.shape, {
        depth: 0.6,
        steps: 1,
        bevelEnabled: true,
        bevelThickness: 0.022,
        bevelSize: 0.018,
        bevelSegments: 1,
        curveSegments: 1,
      });
      result.scale(height, height, 1);
      result.translate(0, 0, -0.3);
      return result;
    });
    part(group, `letter-${letter}`, geo, M.paleStone, [cursor, 0.32, 0]);
    cursor += item.width * height + spacing;
  });
  box(group, "monument-plinth", [totalWidth + 0.55, 0.3, 0.86], M.stone, [0, 0.15, 0]);
  part(group, "plinth-red-diamond", diamondGeometry(0.17, 0.17), M.lacquer, [0, 0.15, 0.438]);
  group.userData.capHeight = 2.4;
  return group;
}

export const KATANA_PROP_ASSETS = [
  "katana",
  "rock-1",
  "rock-2",
  "rock-3",
  "rock-4",
  "lantern-stone",
  "lantern-paper",
  "komainu",
  "sake-barrels",
  "cart",
  "bamboo",
  "maple",
  "pine",
  "bell",
  "tsukubai",
  "shishi-odoshi",
  "noren",
  "banner",
  "koi",
  "monument-up",
  "monument-mid",
  "monument-low",
] as const;

const FACTORIES: Record<string, () => THREE.Group> = {
  katana: createKatana,
  "rock-1": () => createRock(1),
  "rock-2": () => createRock(2),
  "rock-3": () => createRock(3),
  "rock-4": () => createRock(4),
  "lantern-stone": createStoneLantern,
  "lantern-paper": createPaperLantern,
  komainu: createKomainu,
  "sake-barrels": createSakeBarrelStack,
  cart: createCart,
  bamboo: createBamboo,
  maple: createMaple,
  pine: createPine,
  bell: createBell,
  tsukubai: createTsukubai,
  "shishi-odoshi": createShishiOdoshi,
  noren: createNoren,
  banner: createBanner,
  koi: createKoi,
  "monument-up": () => createMonument("UP"),
  "monument-mid": () => createMonument("MID"),
  "monument-low": () => createMonument("LOW"),
};

const ALIASES: Record<string, string> = {
  sword: "katana",
  "katana-monument": "katana",
  rock: "rock-1",
  "rock-a": "rock-1",
  "rock-b": "rock-2",
  "rock-c": "rock-3",
  "rock-d": "rock-4",
  rock1: "rock-1",
  rock2: "rock-2",
  rock3: "rock-3",
  rock4: "rock-4",
  "rock-sculpt-1": "rock-1",
  "rock-sculpt-2": "rock-2",
  "rock-sculpt-3": "rock-3",
  "rock-sculpt-4": "rock-4",
  lantern: "lantern-stone",
  "stone-lantern": "lantern-stone",
  ishidoro: "lantern-stone",
  "paper-lantern": "lantern-paper",
  "red-paper-lantern": "lantern-paper",
  "lantern-red": "lantern-paper",
  guardian: "komainu",
  "komainu-guardian": "komainu",
  "barrel-stack": "sake-barrels",
  "sake-barrel-stack": "sake-barrels",
  "bamboo-clump": "bamboo",
  "maple-foliage": "maple",
  "pine-foliage": "pine",
  "shrine-bell": "bell",
  "water-basin": "tsukubai",
  banners: "banner",
  kohaku: "koi",
  up: "monument-up",
  mid: "monument-mid",
  low: "monument-low",
  "lane-up": "monument-up",
  "lane-mid": "monument-mid",
  "lane-low": "monument-low",
};

export function createKatanaProp(asset: string): THREE.Group | null {
  const normalized = asset?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "sake-barrel") return createSakeBarrel();
  const id = ALIASES[normalized] ?? normalized;
  const factory = FACTORIES[id];
  return factory ? factory() : null;
}
