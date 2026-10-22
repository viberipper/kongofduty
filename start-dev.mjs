// Dev loop: starts the game server (:8787, HUB mode — the client picks the
// map; Vite proxies same-origin /ws connections to the hub) and the Vite dev
// server (:5173, project root client/). Then open the page at
// http://localhost:5173/?map=<id>.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = 8787;
const DEV_PORT = 5173;

const procs = [];
function run(name, cmd, args, cwd = HERE) {
  const p = spawn(cmd, args, {
    cwd,
    shell: false,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  p.on("exit", () => {
    console.log(`[dev] ${name} exited — shutting everything down`);
    for (const q of procs) { try { q.kill(); } catch { /* ok */ } }
    process.exit(0);
  });
  procs.push(p);
}

// HUB: no map attached — the client picks the map (?map=).
run("gameserver", process.execPath, [
  path.join(HERE, "server", "dist", "server.mjs"),
  `--port=${SERVER_PORT}`,
]);

run("vite", process.execPath, [
  path.join(HERE, "client", "node_modules", "vite", "bin", "vite.js"),
  `--port=${DEV_PORT}`,
], path.join(HERE, "client"));
