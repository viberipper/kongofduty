# BANANA SHIPMENT (local ripoff)

Local copy of the browser game at https://cnvs.dev/kong/ — **including a custom multiplayer game server** (the original only ships the client; the server code is not published). The server in `server/` is a clean-room rebuild based on the official network protocol (`shared/protocol.ts`) and uses the same authoritative simulation engine (`shared/sim.ts`) that the client's offline Quick Play runs.

**Important: always start the game via the HTTP server, never by double-clicking `index.html`.** Under `file://`, Chromium blocks all of the client's `fetch()` calls — menu 3D backgrounds go missing and Quick Play fails with "FAILED TO FETCH".

## Quick start

```bat
npm run install:all   (one-time: installs client/ + server/ dependencies)
npm run build         (one-time: builds server/dist + client/dist)
npm run server        (hub on :8765 with the mirrored client — then open the URL below)
```

http://localhost:8765/kong/ — pick the map in the menu (Shipment, Dust2, Ares Relay, Nuketown).

## Screenshots

| ARES RELAY (ADS) | NUKETOWN (TDM triple kill) |
|---|---|
| ![Aiming down sights on Ares Relay](docs/screenshots/ares-ads.png) | ![Triple kill on Nuketown](docs/screenshots/nuketown-tdm.png) |
| NUKETOWN (ADS vs Jungle Jim) | SHIPMENT (pause menu, 5v5) |
| ![Aiming at Jungle Jim on Nuketown](docs/screenshots/nuketown-ads.png) | ![Paused 5v5 match on Shipment](docs/screenshots/shipment-pause.png) |

## Scripts

```bat
npm run dev            Dev setup: Vite :5173 + game-server hub :8787
npm run play           Server with SELF-BUILT client (client/dist, port 8765)
npm run server         Server with mirrored original client (client/public, port 8765)
npm start              Same as npm run server (npm convention)
npm run test:protocol  Headless protocol test (uses server/dist, spawns its own hub :8771)
```

Each package stands alone with its own `package.json`:

```bat
cd client && npm install && npm run build     (Vite build -> client/dist)
cd server && npm install && npm run build     (esbuild bundle -> server/dist)
cd server && npm run test:protocol            (protocol test)
```

## Playing

The server provides all of these at once:
- the game files (web root `client/public` or `client/dist`)
- the multiplayer protocol (`ws://host:8765/kong/ws` — the client appends the selected map itself)
- `/healthz` for health checks

The menu offers **QUICK PLAY** (offline vs bots), **PUBLIC MATCH** (multiplayer) and **PRIVATE MATCH** (code lobby, joinable via `?join=<CODE>` link — also across LAN PCs using the server IP).

## Multiplayer

The server is a **HUB**: the client picks the map in the menu, and the hub routes each connection to a lazily spawned worker process for exactly that map (worker ports: hub port + 101..104). One live match per map, bot fill up to the map's seat count, rollover after match end, spectator bench with promotion, chat, loadout, ping.

Seat counts per map (from the original `shared/modes.ts`): Shipment 5v5 / 10 FFA, Dust2/Ares/Nuketown 6v6 / 12 FFA.

Protocol: 64 Hz sim / 32 Hz `compact-v1` snaps, input credits, prediction reset — see `server/src/index.ts`.

## Directories

```
client/           Client package (own package.json: install/dev/build/preview)
client/src/       Original client TypeScript (extracted from sourcemaps)
client/public/    1:1 mirror of the original client
client/vendor/    three.js r170 + used addons (local)
client/dist/      Built client (build artifact, git-ignored)
shared/           Original shared engine/protocol sources (client+server)
server/           Server package (own package.json: install/build/start/test)
server/src/      Clean-room game server (esbuild bundle in server/dist)
server/dist/      Server bundle (build artifact, git-ignored)
server/assets/maps/{nuketown,dust2}.json  Map data (server-owned, standalone)
server/test-client.mjs   Headless protocol test
```

A few modules required for the build exist in no shipped bundle sourcemap and were rebuilt as custom implementations (marked in their file headers): `client/src/world.ts`, `client/src/weapons/guns/register.ts`, `shared/maps/types.ts`, plus 5 css stubs.

Build differences vs the original: chunks land with new hashes (our build); three.js is vendored locally; `client/dist/`, `server/dist/` and `node_modules/` are git-ignored — after cloning, run `npm run install:all && npm run build`.

## Graphics (AAA pass, branch `feature/aaa-graphics`)

Post chain: `RenderPass` (HDR + MSAA) → `ContactAO` (`client/src/ssao.ts`, all maps, hardware tier) → `BloomPass` (`client/src/bloom.ts`, HDR highlights only) → optional `MotionBlurPass` (`client/src/motion-blur.ts`, default OFF) → `CINEMATIC` (`client/src/cinematic.ts`: tone map + sRGB encode plus vignette, chromatic aberration, film grain, color grade, CAS-lite sharpen, DOF-lite in one fused pass) → `FXAA` (software tier only). Quality presets LOW/MEDIUM/HIGH/ULTRA/CINEMATIC plus every switch individually, in SETTINGS → GRAPHICS (only the GPU backend wants a reload).

**Why WebGL2 is active:** the vendored three r170 (`client/vendor/three/examples/jsm/`) ships no `WebGPURenderer` and no TSL nodes, so there is no WebGPU post-chain to drive yet. `client/src/gpu-backend.ts` detects the WebGPU API, resolves the `renderer` pref (`auto`/`webgpu`/`webgl`) and falls back to the fully supported WebGL2 path with a console note. After a three upgrade that vendors `WebGPURenderer`, only `createRenderer()` there needs the async TSL path — prefs, menu and fallback already exist.

## Asset ownership

All game files (models, textures, audio, code bundles) belong to the original author and must **not** be redistributed. This copy exists solely for personal offline use.
