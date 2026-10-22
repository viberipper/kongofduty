#!/usr/bin/env node
/**
 * Dual-JSON desync gate (security M1), dust2 half: client/static and
 * server/assets each carry a copy of dust2.json, and the sim is built from
 * whichever copy the process loads. The two copies must hash EQUAL under
 * dust2GeoHash — which covers geometry + climb + visual/open/color + bounds +
 * fence footprints + top + floorY/storey policy + nav lattice/seeds/pockets +
 * team (+FFA) spawns + bot/audio scales (null navHeightGate distinct from
 * undefined) — or prediction and authority build different worlds and diverge.
 *
 * Runs buildDust2 on BOTH copies (so every audit pin — bounds, span, floor,
 * fence top — is enforced on both), then fails the run when
 * clientGeo !== serverGeo. Enforced in CI (.github/workflows/nuketown.yml);
 * exit nonzero fails the run.
 *
 * Usage: node scripts/nuketown/check-dust2-geo.mjs   (exit 0 = in sync)
 * Root package.json wires it as `npm run check:dust2`.
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

const CLIENT_JSON = path.join(ROOT, "client", "static", "assets", "maps", "dust2.json");
const SERVER_JSON = path.join(ROOT, "server", "assets", "maps", "dust2.json");

const ENTRY = `
import { readFileSync } from "node:fs";
import { buildDust2, dust2GeoHash, DUST2_AUDIT } from ${JSON.stringify(path.join(ROOT, "shared", "maps", "dust2.ts"))};
const [clientPath, serverPath] = process.argv.slice(2);
let clientRaw, serverRaw;
try {
  clientRaw = JSON.parse(readFileSync(clientPath, "utf8"));
  serverRaw = JSON.parse(readFileSync(serverPath, "utf8"));
} catch (e) {
  console.error("check-dust2-geo: failed to read a dust2.json copy:", e.message);
  process.exit(2);
}
const clientGeo = dust2GeoHash(clientRaw);
const serverGeo = dust2GeoHash(serverRaw);
try {
  buildDust2(clientRaw);
} catch (e) {
  console.error("check-dust2-geo: CLIENT copy failed its audit pins:", e.message);
  process.exit(2);
}
const clientWarn = [...DUST2_AUDIT.warnings];
try {
  buildDust2(serverRaw);
} catch (e) {
  console.error("check-dust2-geo: SERVER copy failed its audit pins:", e.message);
  process.exit(2);
}
console.log("check-dust2-geo: client geo=" + clientGeo + " warnings=" + clientWarn.length);
console.log("check-dust2-geo: server geo=" + serverGeo + " warnings=" + DUST2_AUDIT.warnings.length);
if (clientGeo !== serverGeo) {
  console.error("check-dust2-geo: FAIL clientGeo !== serverGeo — the two dust2.json copies desynced");
  process.exit(1);
}
console.log("check-dust2-geo: OK copies in sync");
`;

const dir = mkdtempSync(path.join(tmpdir(), "dust2-check-geo-"));
const entryFile = path.join(dir, "entry.ts");
// NOTE: the bundle must live INSIDE the repo: shared/maps/index.ts resolves
// client/static/... relative to import.meta.url, and a tmpdir bundle breaks
// that. (Default map needs no file; dust2 preload does.)
const outFile = path.join(ROOT, "scripts", "nuketown", ".check-dust2-geo.out.mjs");
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
