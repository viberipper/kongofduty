/**
 * client/src/foot-surface.ts — WHAT IS UNDER THIS FOOT? Picks the footstep and
 * landing voice (client/src/footsteps.ts FootSurface) from the collider the
 * body stands on, through the same material table the bullet impacts use
 * (shared/surface.ts), plus each map's own floor:
 *
 *   Shipment   yard dirt; container lids, wrecks and the truck ring as metal,
 *              crates knock as wood
 *   dust2      sand-strewn stone floors and stairs
 *   Nuketown   lawns are grass, the street is asphalt, decks and house floors
 *              are wood (client/src/nuketown-surface.ts)
 *   Ares       a steel station
 */
import { activeSolids, worldToLocal, type OBB } from "@shared/map";
import { gridFor, gridQueryCircle } from "@shared/solidgrid";
import { surfaceOf } from "@shared/surface";
import type { FootSurface } from "./footsteps";

const SCRATCH: number[] = [];

/** The climbable solid whose top is the floor under (x, z) at height y, if any. */
function floorSolid(x: number, z: number, y: number): OBB | null {
  const solids = activeSolids();
  const g = gridFor(solids);
  const cand = g ? gridQueryCircle(g, x, z, 0.2, SCRATCH) : solids.map((_, i) => i);
  let best: OBB | null = null;
  let bestTop = -Infinity;
  for (const i of cand) {
    const o = solids[i]!;
    if (!o.climb) continue;
    const top = o.y + o.sy * 0.5;
    if (top < y - 0.15 || top > y + 0.12 || top <= bestTop) continue;
    const l = worldToLocal(o, x, z);
    if (Math.abs(l.x) > o.sx * 0.5 + 0.12 || Math.abs(l.z) > o.sz * 0.5 + 0.12) continue;
    best = o;
    bestTop = top;
  }
  return best;
}

/**
 * @param mapId    the active map
 * @param fallback what the bare floor plane is made of when no solid is under
 *                 the foot (Game.isMetalAt keeps Shipment's walk-through
 *                 container floors; Nuketown's own rule splits street and house)
 */
export function footSurface(mapId: string, x: number, y: number, z: number, fallback: () => FootSurface): FootSurface {
  if (mapId === "ares") return "metal";
  const o = floorSolid(x, z, y);
  if (!o) return fallback();
  // dust2's walkable boxes are its floors: sand over stone, same as its impacts.
  if (mapId === "dust2" && o.visual === "dfloor") return "sand";
  const tag = `${o.visual ?? ""} ${o.glb ?? ""}`;
  switch (surfaceOf(o, mapId)) {
    case "metal":
      return "metal";
    case "wood":
      return "wood";
    case "sand":
      return "sand";
    case "stone":
    case "concrete":
    case "glass":
      return "hard";
    case "dirt":
      return /lawn|grass|hedge|bush/.test(tag) ? "grass" : "dirt";
    default:
      return "dirt";
  }
}
