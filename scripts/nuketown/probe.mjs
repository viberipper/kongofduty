#!/usr/bin/env node
/**
 * Bundles scripts/nuketown/probe-entry.ts (which imports the live TS sim)
 * with the server's esbuild and runs it in a Nuketown process
 * (SHIPMENT_MAP=nuketown). Exit code = probe result.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const requireFromServer = createRequire(path.join(ROOT, "server", "package.json"));
const esbuild = requireFromServer("esbuild");

const dir = mkdtempSync(path.join(tmpdir(), "nuketown-probe-"));
// NOTE: the bundle must live INSIDE the repo: shared/maps/index.ts resolves
// client/static/... relative to import.meta.url, and a tmpdir bundle breaks
// the Nuketown preload.
const outFile = path.join(ROOT, "scripts", "nuketown", ".probe.out.mjs");
try {
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, "scripts", "nuketown", "probe-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "warning",
  });
  execFileSync(
    process.execPath,
    [outFile, path.join(ROOT, "client", "static", "assets", "maps", "nuketown.json")],
    {
      stdio: "inherit",
      env: { ...process.env, SHIPMENT_MAP: "nuketown" },
    },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outFile, { force: true });
}
