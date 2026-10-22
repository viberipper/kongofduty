#!/usr/bin/env node
/**
 * Dual-JSON desync gate (security A): client/static and server/assets each
 * carry a copy of nuketown.json, and the sim is built from whichever copy the
 * process loads. The two copies must hash EQUAL under nuketownGeoHash —
 * which covers geometry + climb + visual/open/color + bounds + fence
 * footprints + floorY/storey policy + nav lattice/seeds/pockets +
 * team + FFA spawns + bot/audio scales (null navHeightGate distinct from
 * undefined) — or prediction and authority build different worlds and diverge.
 *
 * Runs buildNuketown on BOTH copies (so every audit pin — 11 rails, thin,
 * tall-wall, staged/egress, family, door corridor, fence, bounds, span — is
 * enforced on both), then fails the run when clientGeo !== serverGeo.
 * Enforced in CI (.github/workflows/nuketown.yml); exit nonzero fails the run.
 *
 * Usage: node scripts/nuketown/check-geo.mjs   (exit 0 = in sync)
 * Root package.json wires it as `npm run check:nuketown`.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromServer = createRequire(path.join(ROOT, "server", "package.json"));
const esbuild = requireFromServer("esbuild");

const CLIENT_JSON = path.join(ROOT, "client", "static", "assets", "maps", "nuketown.json");
const SERVER_JSON = path.join(ROOT, "server", "assets", "maps", "nuketown.json");

const ENTRY = `
import { readFileSync } from "node:fs";
import { buildNuketown, nuketownGeoHash, NUKETOWN_AUDIT } from ${JSON.stringify(path.join(ROOT, "shared", "maps", "nuketown.ts"))};
const [clientPath, serverPath] = process.argv.slice(2);
const snap = () => ({ geo: NUKETOWN_AUDIT.geo, railings: NUKETOWN_AUDIT.railings, warnings: [...NUKETOWN_AUDIT.warnings] });
let clientRaw, serverRaw;
try {
  clientRaw = JSON.parse(readFileSync(clientPath, "utf8"));
  serverRaw = JSON.parse(readFileSync(serverPath, "utf8"));
} catch (e) {
  console.error("check-geo: failed to read a nuketown.json copy:", e.message);
  process.exit(2);
}
const clientGeo = nuketownGeoHash(clientRaw);
const serverGeo = nuketownGeoHash(serverRaw);
let clientAudit, serverAudit;
try {
  buildNuketown(clientRaw);
  clientAudit = snap();
} catch (e) {
  console.error("check-geo: CLIENT copy failed its audit pins:", e.message);
  process.exit(2);
}
try {
  buildNuketown(serverRaw);
  serverAudit = snap();
} catch (e) {
  console.error("check-geo: SERVER copy failed its audit pins:", e.message);
  process.exit(2);
}
console.log("check-geo: client geo=" + clientGeo + " rails=" + clientAudit.railings + " warnings=" + clientAudit.warnings.length);
console.log("check-geo: server geo=" + serverGeo + " rails=" + serverAudit.railings + " warnings=" + serverAudit.warnings.length);
if (clientGeo !== serverGeo) {
  console.error("check-geo: FAIL clientGeo !== serverGeo — the two nuketown.json copies desynced (see nuketownGeoHash: visual/open/bounds/fence/floor/storey/lattice/seeds/pockets/spawns/scales included)");
  process.exit(1);
}
if (clientAudit.railings !== serverAudit.railings) {
  console.error("check-geo: FAIL promoted rail counts differ between copies");
  process.exit(1);
}
console.log("check-geo: OK copies in sync");
`;

const dir = mkdtempSync(path.join(tmpdir(), "nuketown-check-geo-"));
const entryFile = path.join(dir, "entry.ts");
// NOTE: the bundle must live INSIDE the repo: shared/maps/index.ts resolves
// client/static/... relative to import.meta.url, and a tmpdir bundle breaks
// that. (Default map needs no file; Nuketown preload does.)
const outFile = path.join(ROOT, "scripts", "nuketown", ".check-geo.out.mjs");
try {
  writeFileSync(entryFile, ENTRY, "utf8");
  esbuild.buildSync({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "warning",
  });
  execFileSync(process.execPath, [outFile, CLIENT_JSON, SERVER_JSON], { stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outFile, { force: true });
}
