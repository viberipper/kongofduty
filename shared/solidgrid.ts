/**
 * UNIFORM-GRID BROADPHASE over a solid list.
 *
 * WHY IT EXISTS. Every collision query in this game used to be a linear scan
 * over the whole solid array: `resolveCircle` alone runs 3 relaxation passes x 3
 * substeps = 9 full sweeps per player per tick, so 12 bodies against a 700-box
 * dust2 set at 64 Hz is ~5.5 M OBB tests a second before a single bot has
 * thought. Shipment's 60 boxes hid that; dust2 cannot.
 *
 * THE ONE RULE THIS FILE OBEYS: **a grid query must be indistinguishable from
 * the linear scan it replaces, bit for bit.** Two properties buy that:
 *
 *  1. CONSERVATIVE. A solid is inserted into every cell its world-space AABB
 *     touches (the AABB of the ROTATED box, so yaw is respected), and every
 *     query is widened by the same margin the underlying predicate uses. A
 *     solid the query drops therefore cannot have passed the predicate.
 *  2. ORDER-PRESERVING. Candidates come back sorted by their index in the solid
 *     array — the exact order the linear scan visited them in. This is not
 *     cosmetic: `resolveCircle` and `resolveNadeSolids` mutate position as they
 *     go, `botWallPush` SUMS floats, and `traceWorld` breaks ties with a strict
 *     `<`. Any other order is a different answer.
 *
 * Runtime mutation of the solid array (the qa trick of pushing synthetic boxes
 * onto the exported SOLIDS) is caught by the `builtLength` check in `gridFor` —
 * a mutated array falls back to the linear scan rather than reading a stale index.
 */

import type { OBB } from "./map";

/** Cell size, metres. ~4 m: two container widths, one lattice step of nav. */
export const GRID_CELL = 4;

export type SolidGrid = {
  readonly solids: OBB[];
  /** Length of `solids` when the index was built — a mismatch invalidates it. */
  readonly builtLength: number;
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly nx: number;
  readonly nz: number;
  /** CSR row starts, length nx*nz + 1. */
  readonly starts: Int32Array;
  /** CSR payload: solid indices, ascending within every cell. */
  readonly items: Int32Array;
  /** Per-solid visit stamp for dedupe across cells. */
  readonly mark: Int32Array;
  /** Monotonic stamp counter (mutable — the only mutable field). */
  stamp: number;
};

/** World-space AABB half-extents of a yaw-rotated box. */
function halfExtents(o: OBB): { hx: number; hz: number } {
  const c = Math.abs(Math.cos(o.yaw));
  const s = Math.abs(Math.sin(o.yaw));
  return {
    hx: o.sx * 0.5 * c + o.sz * 0.5 * s,
    hz: o.sx * 0.5 * s + o.sz * 0.5 * c,
  };
}

export function buildSolidGrid(solids: OBB[], cell = GRID_CELL): SolidGrid {
  const n = solids.length;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = solids[i]!;
    const h = halfExtents(o);
    if (o.x - h.hx < minX) minX = o.x - h.hx;
    if (o.x + h.hx > maxX) maxX = o.x + h.hx;
    if (o.z - h.hz < minZ) minZ = o.z - h.hz;
    if (o.z + h.hz > maxZ) maxZ = o.z + h.hz;
  }
  if (!isFinite(minX)) {
    minX = 0;
    minZ = 0;
    maxX = 0;
    maxZ = 0;
  }
  // One cell of slack on each side keeps a query that starts just outside the
  // set from having to special-case the clamp.
  minX -= cell;
  minZ -= cell;
  maxX += cell;
  maxZ += cell;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const counts = new Int32Array(nx * nz);
  const range = (o: OBB): [number, number, number, number] => {
    const h = halfExtents(o);
    const ix0 = Math.max(0, Math.min(nx - 1, Math.floor((o.x - h.hx - minX) / cell)));
    const ix1 = Math.max(0, Math.min(nx - 1, Math.floor((o.x + h.hx - minX) / cell)));
    const iz0 = Math.max(0, Math.min(nz - 1, Math.floor((o.z - h.hz - minZ) / cell)));
    const iz1 = Math.max(0, Math.min(nz - 1, Math.floor((o.z + h.hz - minZ) / cell)));
    return [ix0, ix1, iz0, iz1];
  };
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [ix0, ix1, iz0, iz1] = range(solids[i]!);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) counts[iz * nx + ix] = counts[iz * nx + ix]! + 1;
    }
    total += (ix1 - ix0 + 1) * (iz1 - iz0 + 1);
  }
  const starts = new Int32Array(nx * nz + 1);
  for (let c = 0; c < nx * nz; c++) starts[c + 1] = starts[c]! + counts[c]!;
  const items = new Int32Array(total);
  const cursor = new Int32Array(nx * nz);
  // Ascending i => ascending indices inside every cell row, for free.
  for (let i = 0; i < n; i++) {
    const [ix0, ix1, iz0, iz1] = range(solids[i]!);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = iz * nx + ix;
        items[starts[c]! + cursor[c]!] = i;
        cursor[c] = cursor[c]! + 1;
      }
    }
  }
  return {
    solids,
    builtLength: n,
    cell,
    minX,
    minZ,
    nx,
    nz,
    starts,
    items,
    mark: new Int32Array(n).fill(-1),
    stamp: 0,
  };
}

/**
 * Next visit stamp, with a wrap that cannot go wrong.
 *
 * `mark` is an Int32Array, so a stamp past 2^31-1 wraps on store and stops
 * matching the unwrapped counter — every solid would then read as unvisited and
 * a multi-cell query would return DUPLICATES. That is not cosmetic: `botWallPush`
 * sums a push per candidate, so a duplicate is a doubled standoff force. The
 * 24/7 room reaches that count in about two days of uptime, which is exactly the
 * kind of bug that only ever happens in production. Clearing the marks costs one
 * fill every 2 billion queries.
 */
function nextStamp(g: SolidGrid): number {
  if (g.stamp >= 0x7ffffffe) {
    g.mark.fill(-1);
    g.stamp = 0;
  }
  g.stamp += 1;
  return g.stamp;
}

/** Small local queries favor insertion sort; long Dust2 rays can gather
 * thousands of candidates and need an O(n log n) sort. Both preserve order. */
function sortAsc(out: number[]): void {
  if (out.length > 64) { out.sort(compareIndices); return; }
  for (let i = 1; i < out.length; i++) {
    const v = out[i]!;
    let j = i - 1;
    while (j >= 0 && out[j]! > v) {
      out[j + 1] = out[j]!;
      j -= 1;
    }
    out[j + 1] = v;
  }
}
const compareIndices = (a: number, b: number): number => a - b;

/**
 * Every solid whose AABB touches the world rect, ascending by solid index.
 * `out` is reused by the caller — this never allocates in the steady state.
 */
export function gridQueryRect(
  g: SolidGrid,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: number[],
): number[] {
  out.length = 0;
  const ix0 = Math.max(0, Math.floor((minX - g.minX) / g.cell));
  const ix1 = Math.min(g.nx - 1, Math.floor((maxX - g.minX) / g.cell));
  const iz0 = Math.max(0, Math.floor((minZ - g.minZ) / g.cell));
  const iz1 = Math.min(g.nz - 1, Math.floor((maxZ - g.minZ) / g.cell));
  if (ix1 < ix0 || iz1 < iz0) return out;
  // Single cell is the overwhelmingly common case (a 0.3 m body in a 4 m cell):
  // the row is already sorted and cannot contain duplicates, so it is copied out
  // with no stamping and no sort at all.
  if (ix0 === ix1 && iz0 === iz1) {
    const c = iz0 * g.nx + ix0;
    for (let k = g.starts[c]!, e = g.starts[c + 1]!; k < e; k++) out.push(g.items[k]!);
    return out;
  }
  const stamp = nextStamp(g);
  const mark = g.mark;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const c = iz * g.nx + ix;
      for (let k = g.starts[c]!, e = g.starts[c + 1]!; k < e; k++) {
        const idx = g.items[k]!;
        if (mark[idx] === stamp) continue;
        mark[idx] = stamp;
        out.push(idx);
      }
    }
  }
  sortAsc(out);
  return out;
}

/** Circle query: the rect that bounds a disc of radius `r` about (x,z). */
export function gridQueryCircle(g: SolidGrid, x: number, z: number, r: number, out: number[]): number[] {
  return gridQueryRect(g, x - r, z - r, x + r, z + r, out);
}

/**
 * Amanatides-Woo DDA down the xz projection of a ray, gathering every solid in
 * every cell the segment crosses. Ascending by solid index, same as the rect
 * query — `traceWorld` breaks ties with a strict `<` and must see the same order
 * the linear scan did.
 *
 * A ray with no horizontal component (the client's straight-down surface probe)
 * degenerates to a single-cell query, which is exactly right.
 */
export function gridQueryRay(
  g: SolidGrid,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxT: number,
  out: number[],
): number[] {
  return walkGridRay(g, ox, oz, dx, dz, maxT, out);
}

export type GridRayVisitor = { maxT: number; visit(index: number): void };
const RAY_VISIT_SCRATCH: number[] = [];

/** Visit ray cells from near to far. The caller shrinks maxT after a hit;
 * a cell beyond that hit cannot contain a nearer box. Equal-distance cells
 * still run so the caller can preserve source-index tie breaking. */
export function visitGridRay(g: SolidGrid, ox: number, oz: number, dx: number, dz: number, maxT: number, visitor: GridRayVisitor): void {
  walkGridRay(g, ox, oz, dx, dz, maxT, RAY_VISIT_SCRATCH, visitor);
}

function walkGridRay(g: SolidGrid, ox: number, oz: number, dx: number, dz: number, maxT: number, out: number[], visitor?: GridRayVisitor): number[] {
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9 && Math.hypot(dx, dz) < 1e-9) {
    const candidates = gridQueryCircle(g, ox, oz, 1e-6, out);
    if (visitor) for (const index of candidates) visitor.visit(index);
    return candidates;
  }
  out.length = 0;
  // Clip the segment to the grid AABB: nothing outside it can hold a solid.
  const gMaxX = g.minX + g.nx * g.cell;
  const gMaxZ = g.minZ + g.nz * g.cell;
  let t0 = 0;
  let t1 = maxT;
  // The two clip slabs are hot on every LOS ray; avoid a captured helper.
  if (Math.abs(dx) < 1e-12) {
    if (ox < g.minX || ox > gMaxX) return out;
  } else {
    let a = (g.minX - ox) / dx;
    let b = (gMaxX - ox) / dx;
    if (a > b) { const tmp = a; a = b; b = tmp; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t1 < t0) return out;
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < g.minZ || oz > gMaxZ) return out;
  } else {
    let a = (g.minZ - oz) / dz;
    let b = (gMaxZ - oz) / dz;
    if (a > b) { const tmp = a; a = b; b = tmp; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t1 < t0) return out;
  }
  const sx = ox + dx * t0;
  const sz = oz + dz * t0;
  let ix = Math.max(0, Math.min(g.nx - 1, Math.floor((sx - g.minX) / g.cell)));
  let iz = Math.max(0, Math.min(g.nz - 1, Math.floor((sz - g.minZ) / g.cell)));
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const invDx = dx !== 0 ? 1 / dx : 0;
  const invDz = dz !== 0 ? 1 / dz : 0;
  let tMaxX =
    stepX === 0
      ? Infinity
      : t0 + ((g.minX + (ix + (stepX > 0 ? 1 : 0)) * g.cell - sx) * invDx);
  let tMaxZ =
    stepZ === 0
      ? Infinity
      : t0 + ((g.minZ + (iz + (stepZ > 0 ? 1 : 0)) * g.cell - sz) * invDz);
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(g.cell * invDx);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(g.cell * invDz);
  const stamp = nextStamp(g);
  const mark = g.mark;
  // Hard cap: a 180 m trace over 4 m cells is ~90 steps; the guard only ever
  // fires on a degenerate direction and keeps a bad input from spinning.
  const maxSteps = g.nx + g.nz + 4;
  for (let n = 0; n < maxSteps; n++) {
    const c = iz * g.nx + ix;
    for (let k = g.starts[c]!, e = g.starts[c + 1]!; k < e; k++) {
      const idx = g.items[k]!;
      if (mark[idx] === stamp) continue;
      mark[idx] = stamp;
      if (visitor) visitor.visit(idx);
      else out.push(idx);
    }
    if (tMaxX < tMaxZ) {
      if (tMaxX > Math.min(t1, visitor?.maxT ?? t1)) break;
      ix += stepX;
      if (ix < 0 || ix >= g.nx) break;
      tMaxX += tDeltaX;
    } else {
      if (tMaxZ > Math.min(t1, visitor?.maxT ?? t1)) break;
      iz += stepZ;
      if (iz < 0 || iz >= g.nz) break;
      tMaxZ += tDeltaZ;
    }
  }
  if (!visitor) sortAsc(out);
  return out;
}

// ---------------------------------------------------------------------------
// REGISTRY. groundHeight/traceWorld take a solid ARRAY, not a grid, and both are
// called from client code that has no idea a grid exists. So arrays that are
// worth indexing register themselves here once at boot and the two functions
// look up their index by array identity.
// ---------------------------------------------------------------------------

const GRIDS = new Map<OBB[], SolidGrid>();

/** Index this array (idempotent) and return the grid. */
export function indexSolids(solids: OBB[], cell = solids.length > 1000 ? 1 : GRID_CELL): SolidGrid {
  const had = GRIDS.get(solids);
  if (had && had.builtLength === solids.length && had.cell === cell) return had;
  const g = buildSolidGrid(solids, cell);
  GRIDS.set(solids, g);
  return g;
}

/**
 * The index for this array, or null when there is none — or when the array has
 * been mutated since it was built, in which case the caller MUST fall back to
 * the linear scan rather than read stale indices.
 */
export function gridFor(solids: OBB[]): SolidGrid | null {
  const g = GRIDS.get(solids);
  if (!g || g.builtLength !== solids.length) return null;
  return g;
}

export function clearSolidGrids(): void {
  GRIDS.clear();
}
