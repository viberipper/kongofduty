import type { OBB, Spawn, Waypoint } from "../map";
import type { MapDef } from "./types";

/** ARES RELAY: original 6v6 orbital-station arena. Units are metres.
 * One authoritative list drives collision, the renderer, radar and workbench.
 * Three lanes meet around the reactor; every end bay has three independent
 * exits, and staggered blast shields prevent a spawn-to-spawn opening shot.
 */
export const ARES_BOUNDS = { minX: -37, maxX: 37, minZ: -30, maxZ: 30 };
const solids: OBB[] = [];
function box(x: number, z: number, sx: number, sz: number, sy: number, visual: string, extra: Partial<OBB> = {}): void {
  solids.push({ x, y: sy / 2, z, sx, sy, sz, yaw: 0, visual, ...extra });
}
// Visible pressure glass is a real wall. A 1.1 m titanium plinth is embedded
// in the same envelope; the full collider is visibly represented by glazing.
box(0, -30, 75.2, 0.6, 4.8, "aglass");
box(0, 30, 75.2, 0.6, 4.8, "aglass");
box(-37, 0, 0.6, 60, 5.4, "ahull");
box(37, 0, 0.6, 60, 5.4, "ahull");

for (const sign of [-1, 1]) {
  // End bay blast shields. Centre + north/south bypasses stay wide enough
  // for two sprinting players. The shallow return stops a centre opening ray.
  for (const z of [-16, 16]) box(sign * 27, z, 1.2, 18, 4.7, "abulkhead", { color: sign < 0 ? "teal" : "coral" });
  box(sign * 22, 0, 7, 7, 3.5, "ashield", { color: sign < 0 ? "teal" : "coral" });
  // Four solid service modules divide the lanes, but leave 11 m transverse
  // connectors through the middle and >5 m connectors by each end bay.
  for (const z of [-10, 10]) box(sign * 14.5, z, 12, 5, 5.2, "amodule", { color: z < 0 ? "ivory" : "copper" });
}
// The reactor is readable cover all the way to the surface of its glass.
box(0, 0, 8, 8, 1.05, "areactor-base");
box(0, 0, 5.1, 5.1, 8.8, "areactor");
// Mid court corner cover opens four circulation paths around the hero.
box(-9, -1, 2.4, 4.2, 1.25, "aconsole");
box(9, 1, 2.4, 4.2, 1.25, "aconsole");
box(-13, 4.9, 2.4, 3, 2.25, "anavtower");
box(13, -4.9, 2.4, 3, 2.25, "anavtower");
// Observatory: shallow elevation, never a one-way or inaccessible perch.
box(0, -21.5, 40, 9, 0.6, "adeck", { climb: true });
box(0, -16.65, 40, 0.7, 0.4, "astep", { climb: true });
box(0, -15.95, 40, 0.7, 0.2, "astep", { climb: true });
for (const sign of [-1, 1]) {
  box(sign * 9.5, -21.5, 3.2, 3.6, 3.05, "anavtower", { y: 0.6 + 3.05 / 2 });
  box(sign * 17, -25, 3.6, 2, 1.15, "aconsole", { y: 0.6 + 1.15 / 2 });
}
box(0, -22.7, 6, 2, 1.15, "aconsole", { y: 0.6 + 1.15 / 2 });
box(0, -28.5, 4, 3, 4.2, "anavtower");
// VERTICALITY, KEPT SHALLOW. The telescope gallery is a balcony at the back of
// the observatory, 0.6 m above the deck (1.2 m absolute), walkable along its
// whole front through a 0.3 m tread. It gives the north lane something to
// look UP at and a short downward read across the deck, without a stacked
// floor or a new sightline over the blast shields.
box(0, -26.15, 15, 1.7, 1.2, "agallery", { climb: true });
box(0, -25.05, 15, 0.5, 0.9, "astep", { climb: true });
// Cargo is the close-range flank; offset tall freight breaks the long ray.
for (const sign of [-1, 1]) {
  box(sign * 12, 22, 5.2, 4, 3.2, "acargo", { color: sign < 0 ? "teal" : "coral" });
  box(sign * 20, 18, 2.5, 2.5, 1.2, "acrate");
  // Freight perches: the inner crates are jump-up boxes (1.2 m), with a 0.6 m
  // step crate on their outboard side to walk up. Short downward angles into
  // cargo; the tall freight still blocks every long ray.
  box(sign * 4.5, 18.5, 3, 4.4, 1.2, "acrate", { climb: true });
  box(sign * 6.5, 19.6, 1, 1.6, 0.6, "astep-crate", { climb: true });
}
box(0, 26.5, 4.6, 7, 3.4, "acargo", { color: "copper" });

const spawns: Spawn[] = [];
for (const team of [0, 1] as const) {
  for (const z of [-21, -12, -3, 3, 12, 21]) {
    spawns.push({ x: team === 0 ? -33 : 33, y: 0, z, yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2, team });
  }
}
const seeds: Waypoint[] = [];
for (const z of [-27, -20, -5.4, 5.4, 16, 27]) {
  for (const x of [-33, -24, -17, -6, 0, 6, 17, 24, 33]) seeds.push({ x, z, cover: Math.abs(z) < 6 });
}
for (const x of [-24, -5.8, 5.8, 24]) {
  for (const z of [-13.5, 0, 13.5]) seeds.push({ x, z, cover: true });
}

export const ARES: MapDef = {
  id: "ares", name: "ARES RELAY", solids, floorY: 0, bounds: ARES_BOUNDS,
  nadeFenceRects: [
    { x: 0, z: -30, sx: 75.2, sz: 0.6, yaw: 0 },
    { x: 0, z: 30, sx: 75.2, sz: 0.6, yaw: 0 },
    { x: -37, z: 0, sx: 0.6, sz: 60, yaw: 0 },
    { x: 37, z: 0, sx: 0.6, sz: 60, yaw: 0 },
  ],
  nadeFenceTop: 24, spawns, navSeeds: seeds, navPockets: [],
  navLattice: { x0: -34, x1: 34, z0: -27.5, z1: 27.5, step: 3.6, linkMax: 6.5, maxNodes: 460 },
  stackedFloors: false, navHeightGate: 0.75, stepSmoothMax: 0.7, climbablesAreFloors: true,
  visualContainers: [],
  minimap: solids.filter(o => !["adeck", "astep", "agallery", "astep-crate"].includes(o.visual ?? "")).map(o => ({
    x: o.x, z: o.z, sx: o.sx, sz: o.sz, yaw: o.yaw,
    color: o.color === "teal" ? "#417f83" : o.color === "coral" ? "#ad6354" : o.visual === "areactor" ? "#8adce5" : "#748087",
  })),
  audioScale: 1.8, botScale: 1.35,
};
