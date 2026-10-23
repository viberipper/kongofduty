/**
 * WHAT DID THE ROUND HIT? — surface material + face normal from the collider set.
 *
 * The material table itself lives in shared/surface.ts (the sim's bullet
 * penetration reads it too); this file adds what only the FX needs.
 */
import type { OBB } from "@shared/map";

export { registerSurface, surfaceOf, type Surface } from "@shared/surface";
import type { Surface } from "@shared/surface";

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
