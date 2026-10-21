/**
 * Type-only declarations (re-implemented).
 *
 * The original `shared/maps/types.ts` never shipped in any bundle sourcemap
 * (pure type re-exports leave no trace). Call sites import these names from
 * `"./types"`:
 *
 *   shared/maps/index.ts     -> MapDef, Rect, FenceRect, MinimapRect, NavLattice
 *   shared/maps/{dust2,ares,shipment,nuketown}.ts -> the same set
 *
 * Vite/esbuild strips types at build time, so these only matter for the
 * editor/typecheck. Shapes follow the usage documented in the map modules
 * (e.g. dust2.ts: fence rects arrive as bare footprints or full OBBs with
 * y/sy, the lattice owns nav seeds and links).
 */

export type Rect = {
  x: number;
  z: number;
  /** full width (x extent). `hw` (half width) is accepted by the generator. */
  w: number;
  /** full depth (z extent). `hd` (half depth) is accepted by the generator. */
  d: number;
};

/** Fence rect: footprint or full OBB (top via y/sy), plus optional metadata. */
export type FenceRect = Rect & {
  /** footprint corners format | OBB format */
  y?: number;
  sy?: number;
  /** top height above floorY, when the generator emits it explicit */
  top?: number;
  /** bot MAP-geometry fence flag */
  nadeFence?: boolean;
};

export type MinimapRect = Rect & {
  color?: string;
  label?: string;
  /** alpha 0..1 */
  a?: number;
};

/** Nav lattice: cells + seed/link metadata (behavior obtained from map data). */
export type NavLattice = {
  xmin: number;
  zmin: number;
  cell: number;
  nx: number;
  nz: number;
  blocked?: Array<number>;
  links?: Array<number>;
  seeds?: Array<number>;
  [key: string]: unknown;
};

/** Map definition contract used by seeds/hosts/modes. */
export type MapDef = {
  id: string;
  name: string;
  /** optional friendly display name for the menu */
  label?: string;
  /** bot MAP-geometry distance multiplier */
  botScale?: number;
  /** seat/team layout for 5v5 / FFA */
  seats?: unknown;
  /** everything else comes from the runtime map json (setMapData) */
  [key: string]: unknown;
};
