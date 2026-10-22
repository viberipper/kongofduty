# BANANA SHIPMENT (ripoff)

Local copy of the browser game at https://cnvs.dev/kong/ — **including a custom multiplayer game server** (the original only ships the client; the server code is not published). The server in `server/` is a clean-room rebuild based on the official network protocol (`shared/protocol.ts`) and runs the same authoritative simulation (`shared/sim.ts`) as the client's offline Quick Play.

**Important: always start the game via the HTTP server, never by double-clicking `index.html`.** Under `file://`, Chromium blocks all of the client's `fetch()` calls — menu 3D backgrounds go missing and Quick Play fails with "FAILED TO FETCH".

## Enhancements over the original

- **Better graphics (AAA pass):** post chain `RenderPass` → `ContactAO` → `Bloom` → `CINEMATIC` grade (tone map, vignette, chromatic aberration, film grain, color grade, sharpen, DOF-lite) → `FXAA`, with quality presets LOW–CINEMATIC plus individual switches in SETTINGS → GRAPHICS.
- **Controller / gamepad support:** standard Xbox/PlayStation mapping with sticks, rumble, and aim assist; layouts DEFAULT / TACTICAL / SOUTHPAW, sensitivity / deadzone / vibration options, button table, and menu navigation in SETTINGS → CONTROLS.
- **Many bug fixes**, e.g. around ADS, HUD, and gameplay details.

## Quick start

```bat
npm run install:all   (one-time: installs client/ + server/ dependencies)
npm run build         (one-time: builds server/dist + client/dist)
npm run server        (hub on :8765 serving the self-built client — then open the URL below)
```

http://localhost:8765/ — pick the map in the menu (Shipment, Dust2, Ares Relay, Nuketown).
(Old `/kong/...` links keep working: the server 301-redirects them to root.)

## Screenshots

| ARES RELAY (ADS) | NUKETOWN (TDM triple kill) |
|---|---|
| ![Aiming down sights on Ares Relay](docs/screenshots/ares-ads.png) | ![Triple kill on Nuketown](docs/screenshots/nuketown-tdm.png) |
| NUKETOWN (ADS vs Jungle Jim) | SHIPMENT (pause menu, 5v5) |
| ![Aiming at Jungle Jim on Nuketown](docs/screenshots/nuketown-ads.png) | ![Paused 5v5 match on Shipment](docs/screenshots/shipment-pause.png) |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev setup: Vite :5173 + game-server hub :8787 |
| `npm run play` | Server with SELF-BUILT client (`client/dist`, port 8765) |
| `npm run server` | Same as `play` |
| `npm start` | Same as `play` (npm convention) |
| `npm run test:protocol` | Headless protocol test (uses `server/dist`, spawns its own hub :8771) |

## Playing

The server provides the game files (web root `client/dist` — built from `client/src/` + `client/static/`), the multiplayer protocol (`ws://host:8765/ws` — the client appends the selected map itself), and `/healthz` for health checks. It binds to loopback by default; use `--host=0.0.0.0` only when you intentionally want direct LAN access.

The menu offers **QUICK PLAY** (offline vs bots), **PUBLIC MATCH** (multiplayer), and **PRIVATE MATCH** (code lobby, joinable via `?join=<CODE>` link). LAN access requires starting the server with `--host=0.0.0.0`. Seat counts follow the original modes (Shipment 5v5, other maps 6v6, FFA variants).

## Own server with Docker

Prerequisites: Docker + Compose plugin installed.

```sh
docker compose up -d --build        # hub on :8765 (KONG_PORT=... overrides the port)
docker compose logs -f              # watch logs
docker compose down                 # stop
```

The image is server-only: hub + map workers (container-internal `KONG_PORT+101..104`, no extra ports needed) serving `ws://host:8765/ws?map=<id>` and `/healthz` (also the Docker/Compose healthcheck). Compose binds the host port to `127.0.0.1` only; put it behind a reverse proxy for remote clients. It ships no client (static files answer 404) — host the client (`client/dist`) elsewhere and point it at the server WS URL.

## Directories

```
client/           Client package (own package.json: install/dev/build/preview)
client/src/       Client TypeScript source (Vite build)
client/static/    Raw game assets (models, textures, audio, maps — copied verbatim into dist by Vite)
client/vendor/    three.js r186 + used addons + TSL nodes (local, see VERSION.txt)
client/dist/      Built client (build artifact, git-ignored)
shared/           Original shared engine/protocol sources (client+server)
server/           Server package (own package.json: install/build/start/test)
server/src/      Clean-room game server (esbuild bundle in server/dist)
server/dist/      Server bundle (build artifact, git-ignored)
server/test-client.mjs   Headless protocol test
```

After cloning, run `npm run install:all && npm run build` (`client/dist/`, `server/dist/`, and `node_modules/` are git-ignored).

## Asset ownership

All game files (models, textures, audio, code) belong to the original author and must **not** be redistributed. This copy exists solely for personal offline use.
