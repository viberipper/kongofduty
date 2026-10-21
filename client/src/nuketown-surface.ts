import { activeSolids, groundHeight } from "@shared/map";

/**
 * Nuketown footstep surface: is the floor under a body a HARD surface (wood
 * floors, decks, stairs, porch roof, pergola, garage concrete — the footstep
 * bank's "metal/hard" voice) or SOFT (lawn, street asphalt, yard dirt — the
 * dirt voice)? Read straight off the sim colliders the body is standing on:
 * the 0.22 m lawn slabs and the street are soft; any other climbable top is
 * hard. Interiors stand on lawn-height slabs too, so a house footprint test
 * (the ground floors) is folded in via the `dfloor`-free rule below: a body
 * inside a house at lawn height is over a ground-floor finish -> hard.
 */
const HOUSES: { cx: number; cz: number; yaw: number; a0: number; a1: number; b0: number; b1: number }[] = [
  // green main block + garage, yellow block + garage (house-local frames, see nt_houses.py)
  { cx: 0, cz: 0, yaw: (18.3 * Math.PI) / 180, a0: -25.5, a1: -13.2, b0: -7.3, b1: 1.7 },
  { cx: 0, cz: 0, yaw: (18.3 * Math.PI) / 180, a0: -20.2, a1: -15.3, b0: 1.7, b1: 9.35 },
  { cx: 0, cz: 0, yaw: (-8 * Math.PI) / 180, a0: 13.75, a1: 21.55, b0: -3.75, b1: 7.85 },
  { cx: 0, cz: 0, yaw: (-8 * Math.PI) / 180, a0: 16.3, a1: 20.5, b0: -14.05, b1: -5.25 },
];

function insideHouse(x: number, z: number): boolean {
  for (const h of HOUSES) {
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
    const a = x * c + z * s, b = -x * s + z * c;
    if (a > h.a0 && a < h.a1 && b > h.b0 && b < h.b1) return true;
  }
  return false;
}

export function nuketownHardFloor(x: number, y: number, z: number): boolean {
  const gh = groundHeight(x, z, activeSolids(), y + 0.1);
  if (gh > 0.5) return true; // decks, stairs, upper floors, porch roof, pergola, furniture
  if (gh < 0.1) return false; // street
  return insideHouse(x, z);
}
