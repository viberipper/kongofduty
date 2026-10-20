import esbuild from "esbuild";
import fs from "node:fs/promises";

/**
 * Build adapter: shared/maps/index.ts (original source, unmodified) resolves
 * JSON map data on the Node side from `../../public/<rel>` relative to the
 * running module (contract "repo root -> public/<rel>"). Inside the bundle
 * (server/dist/server.mjs) that would be <repo>/public/... — but the server
 * carries its data server-locally under server/assets/maps (standalone package).
 * This onLoad adapter rewrites EXACTLY that one template literal:
 *   `../../public/${rel}`  ->  `../${rel}`
 * (rel = "assets/maps/<id>.json", bundle lives in server/dist/ → `../` =
 * server/). If the anchor is missing, the build fails LOUDLY instead of
 * silently producing a wrong bundle.
 */
const mapsPublicPath = {
  name: "maps-public-path",
  setup(build) {
    build.onLoad({ filter: /shared[\\/]maps[\\/]index\.ts$/ }, async (args) => {
      const src = await fs.readFile(args.path, "utf8");
      const from = "`../../public/${rel}`";
      const occurrences = src.split(from).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `[maps-public-path] anchor ${from} found ${occurrences}x (expected 1x) in ${args.path}`,
        );
      }
      return { contents: src.replace(from, "`../${rel}`"), loader: "ts" };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server.mjs",
  external: ["ws", "node:*"],
  sourcemap: false,
  logLevel: "info",
  plugins: [mapsPublicPath],
});
