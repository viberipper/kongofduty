/**
 * WHAT DID THE ROUND HIT? — surface material + face normal from the collider set.
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
import type { OBB } from "@shared/map";

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

/**
 * dust2's `dfloor` boxes are the stairs, terraces and paved yards: struck on
 * their TOP they are sand-strewn stone, struck on a riser they are masonry.
 */
export function refineByNormal(s: Surface, hit: OBB | null, ny: number, mapId: string): Surface {
  if (mapId === "dust2" && hit?.visual === "dfloor" && ny > 0.7) return "sand";
  return s;
}

/**
 * Face normal and the decal-safe centre on that face.
 *
 * The face is the slab nearest the hit point in the box's own frame (yaw-only
 * OBB, so y is world y). The centre is pulled in from the face's edges by
 * `margin` so a hole near a container's corner sits on the steel instead of
 * hanging half off it; on a face narrower than 2 x margin it just centres on
 * that axis. Writes into `out` = [nx, ny, nz, cx, cy, cz, edge], where `edge`
 * is how far the UNCLAMPED hit point sits from the face's nearest edge — the
 * largest radius a decal centred exactly on the hit can have without hanging
 * off the box into the air behind it.
 */
export function faceOf(o: OBB, x: number, y: number, z: number, margin: number, out: Float64Array): void {
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  // world -> local: shared/map.ts worldToLocal convention (local +x -> (c, s), +z -> (-s, c))
  const dx = x - o.x, dz = z - o.z;
  let lx = dx * c + dz * s;
  let lz = -dx * s + dz * c;
  let ly = y - o.y;
  const hx = o.sx * 0.5, hy = o.sy * 0.5, hz = o.sz * 0.5;
  const ex = hx - Math.abs(lx), ey = hy - Math.abs(ly), ez = hz - Math.abs(lz);
  let nlx = 0, nly = 0, nlz = 0;
  let edge = 0;
  if (ex <= ey && ex <= ez) {
    nlx = lx >= 0 ? 1 : -1;
    lx = nlx * hx;
    edge = Math.min(ey, ez);
    ly = clampIn(ly, hy, margin);
    lz = clampIn(lz, hz, margin);
  } else if (ey <= ez) {
    nly = ly >= 0 ? 1 : -1;
    ly = nly * hy;
    edge = Math.min(ex, ez);
    lx = clampIn(lx, hx, margin);
    lz = clampIn(lz, hz, margin);
  } else {
    nlz = lz >= 0 ? 1 : -1;
    lz = nlz * hz;
    edge = Math.min(ex, ey);
    lx = clampIn(lx, hx, margin);
    ly = clampIn(ly, hy, margin);
  }
  // local -> world
  out[0] = nlx * c - nlz * s;
  out[1] = nly;
  out[2] = nlx * s + nlz * c;
  out[3] = o.x + lx * c - lz * s;
  out[4] = o.y + ly;
  out[5] = o.z + lx * s + lz * c;
  out[6] = Math.max(0, edge);
}

function clampIn(v: number, half: number, margin: number): number {
  const lim = half - margin;
  if (lim <= 0) return 0;
  return v > lim ? lim : v < -lim ? -lim : v;
}
