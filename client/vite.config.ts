import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Standalone client package (cd client && npm install && npm run build)
 *
 * Dev (`vite` or npm run dev):   base "/" — ASSET_BASE is "/" as in the
 *   original dev setup, assets come from public/ under /assets/...,
 *   WebSocket via the defaultWs() port-5173 rule on :8787.
 *
 * Build (`npm run build`):         base "/kong/"
 *   The server (`npm run play`, --root=client/dist) maps /kong/* onto
 *   dist/*, i.e. ASSET_BASE="/kong/" applies (asset-base.ts).
 */
export default defineConfig(({ mode }) => ({
  base: mode === "development" ? "/" : "/kong/",
  publicDir: path.join(HERE, "public"),
  resolve: {
    alias: [
      // Order matters: addons prefix before the exact three match.
      { find: "three/addons/", replacement: path.resolve(HERE, "vendor/three/examples/jsm/") + "/" },
      { find: /^three$/, replacement: path.resolve(HERE, "vendor/three/build/three.module.js") },
      { find: "@shared", replacement: path.resolve(HERE, "../shared") },
    ],
  },
  build: {
    outDir: path.join(HERE, "dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    target: "chrome110",
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
