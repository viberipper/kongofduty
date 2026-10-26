# BANANA SHIPMENT (ripoff)

Local copy of the browser game at https://cnvs.dev/kong/ — **including a custom multiplayer game server** (the original only ships the client; the server code is not published). The server in `server/` is a clean-room rebuild based on the official network protocol (`shared/protocol.ts`) and runs the same authoritative simulation (`shared/sim.ts`) as the client's offline Quick Play.

**Important: always start the game via the HTTP server, never by double-clicking `index.html`.** Under `file://`, Chromium blocks all of the client's `fetch()` calls — menu 3D backgrounds go missing and Quick Play fails with "FAILED TO FETCH".

## Enhancements over the original

- **Better graphics (AAA pass):** post chain `RenderPass` → `ContactAO` → `Bloom` → `CINEMATIC` grade (tone map, vignette, chromatic aberration, film grain, color grade, sharpen, DOF-lite) → `FXAA`, with quality presets LOW–CINEMATIC plus individual switches in SETTINGS → GRAPHICS.
- **Controller / gamepad support:** standard Xbox/PlayStation mapping with sticks, rumble, and aim assist; layouts DEFAULT / TACTICAL / SOUTHPAW, sensitivity / deadzone / vibration options, button table, and menu navigation in SETTINGS → CONTROLS.
- **Many bug fixes**, e.g. around ADS, HUD, and gameplay details.
- **Lobby settings:** private-match lobby has a SETTINGS button (host, guests, spectators) that opens the settings modal over the lobby.
- **Nuketown balcony vault:** deck rail panels block like steel — Jump required to vault them, no automatic walk-over.
- **Endcard always fits (fullscreen fix):** the end-of-match screen shrink-fits its content to any viewport (shrink-only zoom, re-measured after webfont swap) with safe-centering and scroll fallback, so title, podium, both scoreboards, stats, accolades and PLAY AGAIN / MAIN MENU stay visible and reachable even in F11 fullscreen — the original can overflow and clip the buttons there.
- **Bot badge in scoreboards:** bots show a dedicated badge icon (`bot-badge.svg`) in its own column before the name in the HUD scoreboard (all modes incl. Gun Game) and the end-of-match board, and under the name on the podium, so humans and bots are instantly distinguishable in offline Quick Play and multiplayer; the flag is server-authoritative with subpath-safe asset resolution and hardened numeric parsing.
- **Audio autoplay fix:** no more "AudioContext was not allowed to start" warnings — audio unlocks on the first click/key/touch, so deep-links (`?play`) and menu hovers stay muted until then, after which the full mix (weapons, packs, ambience) fades in plus the match-start sting; pack loading is hardened with timeouts, size caps, and synth fallback.
- **Generated voice clips:** 49 doom-like announcer/Kong lines generated locally with audio.cpp/Qwen3-TTS in a deep Hartmann-style voice with warm mastering, played as audio files with `speechSynthesis` fallback when a clip is missing.
- **Restrained announcer direction:** anti-spam gating with cooldowns, priorities, and no repeats; killstreak announcements toggleable (default off); ascending killstreak callouts never repeat what was already heard; lead callout only once a team leads by 3; multikill callout in a fixed window instead of sliding; Kong and announcer never talk over each other.
- **Per-map menu music:** the main menu and the private lobby play a passive 60-second background loop per map (Shipment: industrial taikos; Dust2: desert-ops duduk; Ares Relay: cold synth pads; Nuketown: ironic surf twang with a dark turn), switching with a 1.5 s equal-power crossfade when the picked map changes. The bed sits at MASTER × MUSIC × 0.25 under everything, starts only after the first click/keypress (autoplay policy), goes quiet over live matches, and has its own slider in SETTINGS → AUDIO. Tracks live in `client/static/assets/audio/music/` (Opus primary, MP3 fallback); `docs/menu-music-prompts.md` holds the audio.cpp (`ace_step` / `stable_audio`) prompts + mastering chain to re-render them in AI quality as drop-in replacements.
- **Secure in-game text chat:** server-side badword filter with leet-folding, rate-limited, sender taken from the session (no spoofing, "server" name reserved), text-only rendering (no XSS); T key, Enter/Escape like in-game.
- **Team-colored clothing:** Kong on your own team wear blue shorts (enemies red), astronaut armbands/panels in team colors — all colorMode-aware (Protan/Deutan/Tritan), swapped per actor, FFA unchanged.

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
