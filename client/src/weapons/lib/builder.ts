/**
 * PART BUILDER (ported from Kong Royale's weapons/lib/builder.ts): collect
 * coloured geometry per material KIND and merge it into one mesh per kind —
 * one draw call per kind per gun, however many parts a gun is made of.
 * Sub-builders become named pivot groups (mag, bolt, slide, charging handle…)
 * that the viewmodel animates; their parts are authored in the PARENT frame
 * and re-centred on the pivot at build time.
 *
 * Every part is auto-smoothed (area-weighted, angle-limited: flat faces stay
 * flat, bevels roll into fillets), box-UV'd at a constant texel size for the
 * micro textures, and its bevel faces are lightened by `wear` (edge wear —
 * worn anodize / cerakote catching the light along every edge).
 */
import * as THREE from "three";
import { autoSmooth, boxUV, merge } from "./geo";
import { weaponMats, type Kind } from "./mats";

export type Built = { root: THREE.Group; meshes: THREE.Mesh[]; tris: number; pivots: Record<string, THREE.Group> };

type Part = { g: THREE.BufferGeometry; kind: Kind };

export type AddOpts = {
  /** edge-wear lightening on bevels, 0..1 (default per kind) */
  wear?: number;
  /** auto-smooth angle (deg); 0 = keep the source normals */
  smooth?: number;
  /** micro-texture tiles per metre */
  uv?: number;
};

const WEAR: Record<Kind, number> = { anod: 0.55, steel: 0.4, bright: 0.15, poly: 0.18, cera: 0.5, rubber: 0.05, glass: 0, glow: 0, brass: 0.2 };

export class PartBuilder {
  private parts: Part[] = [];
  private subs: Array<{ name: string; pivot: THREE.Vector3; b: PartBuilder }> = [];
  private extras: THREE.Object3D[] = [];
  private col = new THREE.Color();
  private wearC = new THREE.Color();

  /** add geometry with a flat colour (sRGB hex), a material kind and an optional transform */
  add(src: THREE.BufferGeometry, color: number, kind: Kind, m?: THREE.Matrix4, o: AddOpts = {}): this {
    let g = src.index ? src.toNonIndexed() : src.clone();
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
    if (m) g.applyMatrix4(m);
    const ang = o.smooth ?? 40;
    if (ang > 0) g = autoSmooth(g, ang);
    else if (!g.attributes.normal) g.computeVertexNormals();
    boxUV(g, o.uv ?? 24);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    this.col.set(color);
    const wear = o.wear ?? WEAR[kind];
    // worn edges: toward a lighter, slightly desaturated tone of the base
    this.wearC.copy(this.col).lerp(new THREE.Color(0x9a9ea3), 0.35).multiplyScalar(1.55);
    const edge = g.attributes.aEdge as THREE.BufferAttribute | undefined;
    for (let i = 0; i < n; i++) {
      const e = edge ? edge.getX(i) * wear : 0;
      colors[i * 3] = this.col.r + (this.wearC.r - this.col.r) * e;
      colors[i * 3 + 1] = this.col.g + (this.wearC.g - this.col.g) * e;
      colors[i * 3 + 2] = this.col.b + (this.wearC.b - this.col.b) * e;
    }
    if (edge) g.deleteAttribute("aEdge");
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.parts.push({ g, kind });
    return this;
  }

  /** a ready-made object (decal, reticle) kept as-is under the root */
  object(o: THREE.Object3D): this {
    this.extras.push(o);
    return this;
  }

  /** a child builder whose parts become a Group pivoting at `pivot` (author its geometry in the PARENT frame) */
  sub(name: string, pivot: [number, number, number] = [0, 0, 0]): PartBuilder {
    const b = new PartBuilder();
    this.subs.push({ name, pivot: new THREE.Vector3(...pivot), b });
    return b;
  }

  get size(): number {
    return this.parts.length;
  }

  build(name = "part", shadows = false): Built {
    const M = weaponMats();
    const root = new THREE.Group();
    root.name = name;
    const meshes: THREE.Mesh[] = [];
    const pivots: Record<string, THREE.Group> = {};
    let tris = 0;
    const byKind = new Map<Kind, THREE.BufferGeometry[]>();
    for (const p of this.parts) {
      if (!byKind.has(p.kind)) byKind.set(p.kind, []);
      byKind.get(p.kind)!.push(p.g);
    }
    for (const [kind, list] of byKind) {
      const g = merge(list);
      if (!g) continue;
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, M[kind]);
      mesh.name = `${name}:${kind}`;
      mesh.castShadow = shadows && kind !== "glow" && kind !== "glass";
      mesh.receiveShadow = kind !== "glow" && kind !== "glass";
      if (kind === "glass") mesh.renderOrder = 2;
      if (kind === "glow") mesh.renderOrder = 3;
      root.add(mesh);
      meshes.push(mesh);
      tris += g.attributes.position.count / 3;
    }
    for (const o of this.extras) root.add(o);
    for (const s of this.subs) {
      const built = s.b.build(`${name}/${s.name}`, shadows);
      const grp = built.root;
      grp.name = s.name;
      grp.position.copy(s.pivot);
      for (const m of built.meshes) if (m.parent === grp) m.geometry.translate(-s.pivot.x, -s.pivot.y, -s.pivot.z);
      for (const o of grp.children) if (!(o as THREE.Mesh).isMesh || !built.meshes.includes(o as THREE.Mesh)) o.position.sub(s.pivot);
      grp.userData.home = { p: grp.position.clone(), q: grp.quaternion.clone() };
      root.add(grp);
      meshes.push(...built.meshes);
      tris += built.tris;
      pivots[s.name] = grp;
      for (const [k, v] of Object.entries(built.pivots)) pivots[k] = v;
    }
    return { root, meshes, tris, pivots };
  }
}
