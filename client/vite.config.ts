import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Standalone client package (cd client && npm install && npm run build)
 *
 * Dev (`vite` or npm run dev) and build (`npm run build`) both use base "/":
 * page, socket and assets all share the origin root — the server
 * (`npm run play`, --root=client/dist) maps /* onto dist/*, i.e.
 * ASSET_BASE="/" applies (asset-base.ts: identity, no URL rewriting).
 * (The upstream original is served at https://cnvs.dev/kong/, but the local
 * server is root-mounted; old /kong/* URLs only survive as 301s, see
 * server/src/index.ts.)
 */
export default defineConfig({
  base: "/",
  publicDir: path.join(HERE, "static"),
  resolve: {
    alias: [
      // Order matters: addons prefix before the exact three match.
      { find: "three/addons/", replacement: path.resolve(HERE, "vendor/three/examples/jsm/") + "/" },
      // WebGPU renderer + TSL (r186: build/three.webgpu.js, build/three.tsl.js).
      // three/tsl.js imports bare "three/webgpu", so both need aliases.
      { find: /^three\/webgpu$/, replacement: path.resolve(HERE, "vendor/three/build/three.webgpu.js") },
      { find: /^three\/tsl$/, replacement: path.resolve(HERE, "vendor/three/build/three.tsl.js") },
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
});
