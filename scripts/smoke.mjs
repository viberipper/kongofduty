#!/usr/bin/env node
/**
 * Bundles scripts/smoke-entry.ts with the server's esbuild and runs it in the
 * default (Shipment) process. Exit code = result.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromServer = createRequire(path.join(ROOT, "server", "package.json"));
const esbuild = requireFromServer("esbuild");

const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
// NOTE: the bundle must live INSIDE the repo: shared/maps/index.ts resolves
// client/static/... relative to import.meta.url.
const outFile = path.join(ROOT, "scripts", ".smoke.out.mjs");
try {
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, "scripts", "smoke-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "warning",
  });
  execFileSync(process.execPath, [outFile, path.join(ROOT, "client", "static", "assets", "maps", "dust2.json")], {
    stdio: "inherit",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outFile, { force: true });
}
