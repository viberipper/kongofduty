/**
 * Import smoke + dust2 pin check (not shipped; runs bundled).
 *
 * 1. Imports the live sim in the DEFAULT (Shipment) process — the circular
 *    import shared/sim.ts <-> shared/maps/nuketown.ts must settle with the
 *    movement constants initialized before activeMap() runs.
 * 2. Runs buildDust2 on the shipped dust2.json (bounds finite/ordered pin,
 *    fence normalisation) — throws on regen drift.
 */
import { readFileSync } from "node:fs";
import { simMap } from "../shared/sim";
import { buildDust2 } from "../shared/maps/dust2";

console.log(`SMOKE active map: ${simMap().id}`);
if (simMap().id !== "shipment") throw new Error(`expected default Shipment process, got ${simMap().id}`);

const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const def = buildDust2(raw);
console.log(
  `SMOKE dust2: solids=${def.solids.length} fence=${def.nadeFenceRects.length} top=${def.nadeFenceTop} spawns=${def.spawns.length}`,
);
if (!def.solids.length) throw new Error("dust2 built zero solids");
if (!def.nadeFenceRects.length) throw new Error("dust2 built zero fence rects");
console.log("SMOKE OK");
