/**
 * WHAT IS THIS COLLIDER MADE OF? — the surface material of a solid, shared by
 * the impact FX (client/src/weapons/fx/surface.ts) and the sim's bullet
 * penetration (shared/penetration.ts), so a wall that sounds like wood is a
 * wall a round can go through as wood.
 *
 * The sim is hitscan against yaw-only OBBs plus a floor plane (shared/map.ts
 * traceWorld). That is all the FX needs: the OBB that stopped the round carries
 * a `visual` tag (container, cwall, crate, dwall, dfloor, dprop, a...), the map
 * id says what the floor plane is made of, and the face the ray entered is the
 * one whose slab is nearest the hit point in the box's own frame.
 *
 * Unknown tags (a new map, e.g. Nuketown's) fall back on keyword heuristics and
 * then on the map's default. A map stream can pin exact answers with
 * registerSurface("my-tag", "wood") without touching this file's logic.
 */
import type { OBB } from "./map";

export type Surface = "metal" | "concrete" | "stone" | "wood" | "dirt" | "sand" | "glass" | "rubber" | "flesh";

/** Exact visual-tag answers, per the maps that exist today. */
const TAGS: Record<string, Surface> = {
  // Shipment (jungle yard)
  container: "metal", cwall: "metal", roof: "metal", wall: "metal", barrel: "metal", dumpster: "metal",
  car: "metal", forklift: "metal", "wreck-junk": "metal", seam: "metal", crate: "wood", "crate-spill": "wood", "tire-stack": "rubber",
  // dust2: sandstone masonry, stone/sand floors and stairs, wooden crates
  dwall: "stone", dceil: "stone", dfloor: "stone", dprop: "wood",
  // Ares relay: a steel station, two glass panes
  aglass: "glass",
};

/** Per-map default for any solid whose tag says nothing, and the floor plane. */
const MAP_DEFAULT: Record<string, { solid: Surface; floor: Surface }> = {
  shipment: { solid: "metal", floor: "dirt" },
  dust2: { solid: "stone", floor: "sand" },
  ares: { solid: "metal", floor: "metal" },
  nuketown: { solid: "concrete", floor: "dirt" },
};

const KEYWORDS: [RegExp, Surface][] = [
  [/glass|window|pane/, "glass"],
  [/tire|tyre|rubber/, "rubber"],
  [/wood|crate|plank|door|deck|porch|table|cabinet|shed|fence-w|pallet|log|tree|trunk/, "wood"],
  [/metal|steel|iron|container|car|truck|bus|van|dumpster|barrel|rail|pole|sign|pipe|tank|forklift|wreck|vent|ac-unit|grill|mailbox/, "metal"],
  [/dirt|grass|lawn|ground|yard|soil|mud|bush|hedge/, "dirt"],
  [/sand/, "sand"],
  [/stone|rock|masonry|brick/, "stone"],
  [/concrete|cement|curb|street|road|asphalt|sidewalk|block|wall|floor|stair|step|slab|ceil/, "concrete"],
];

/** Pin a visual tag to a surface (map streams: call once at import). */
export function registerSurface(tag: string, s: Surface): void {
  TAGS[tag] = s;
}

export function surfaceOf(hit: OBB | null, mapId: string): Surface {
  const def = MAP_DEFAULT[mapId] ?? { solid: "concrete", floor: "dirt" };
  if (!hit) return def.floor;
  const tag = hit.visual;
  if (mapId === "ares") return tag === "aglass" ? "glass" : "metal";
  if (tag) {
    const exact = TAGS[tag];
    if (exact) return exact;
    for (const [re, s] of KEYWORDS) if (re.test(tag)) return s;
  }
  if (hit.glb) {
    for (const [re, s] of KEYWORDS) if (re.test(hit.glb)) return s;
  }
  return def.solid;
}

