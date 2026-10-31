# Changelog

All notable changes to this project are documented in this file.

This file tracks exclusively our own bugfixes and enhancements. It exists
so that later upstream updates can be differentiated: anything already
fixed by us is listed here with commit evidence. Upstream ports are
intentionally NOT tracked here (see `docs/upstream-sync.md`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
as closely as possible. Every entry below is backed by a commit in this
repository (short hash in parentheses); nothing is listed without commit
evidence. Commit range covered: `39093f4` (initial snapshot) through
`fe7a0c5` (HEAD at time of writing); upstream sync/port commits in that
range (e.g. `09486bd`, `d4111b4`) are intentionally excluded — upstream
ports are NOT tracked here (see `docs/upstream-sync.md`).

## Unreleased

### Fixed

- `fix(maps): hard reload crashes on a remembered JSON map` — selecting
  Nuketown (or dust2) in the menu and hard-reloading at a bare URL died with
  `map "nuketown" has no data loaded` before the menu appeared. The module-level
  preload in `shared/maps/index.ts` resolved the map through
  `readMapPref()` → `readMenuMap()` → `MENU_LS_KEY`, but both localStorage keys
  were declared ~120 lines *below* the `await`: the first, preloading
  resolution read them inside their temporal dead zone, the `ReferenceError`
  was swallowed by the private-mode `try`, and the preload fell back to the
  default (code-only) map. `activeMap()` then resolved the map a second time —
  constants initialised by now — picked up the remembered card and found no
  data for it. The preload now sits at the foot of the module and the keys are
  declared above it, so the module body is order-independent; verified A/B on
  the built client at a URL without `?map=` (pre-fix throws, post-fix boots
  Nuketown and dust2 with an empty console) (`fb087ae`).

- `fix(lobby): keep showing the last ping while a seat re-measures` — a seat's
  ping resets to 0 whenever the server builds a new seat for that player
  (reconnect, host move to the other team or the bench, promotion), so the
  badge blinked from "42 MS" to "—" mid-session; the roster now remembers the
  last measured value per player for the current room and keeps showing it
  until the new measurement lands, with "—" only before a player's first
  measurement ever (Pending commit — hash follows on commit.).

- `fix(lobby): real ping badges before a match` — only the in-match loop ever
  reported an RTT, so a fresh lobby left every seat at 0 and the roster's 1 ms
  clamp made everyone look like a 1 ms connection until a match had run on that
  socket; the lobby now measures the pong and reports it once a second (seats
  without a measurement show "—", the server re-pushes the roster every 2 s
  instead of 5 s) (Pending commit — hash follows on commit.).
- `fix(lobby): footer pinned to the window bottom` — `.nana-wrap`'s middle row
  kept its auto minimum, so switching the mode to GUN GAME (the extra "kills per
  gun" row) made the row taller than the viewport and pushed the keyline footer
  off screen; the frame is now a flex column where only the middle band gives
  (header and footer keep their height, the columns scroll inside), verified in
  headless Chrome at 1999x877 and 1366x768 with the real fonts (Pending
  commit — hash follows on commit.).

- `fix(lobby): invite box under the teams, scrollable columns` — on a
  1080p-class viewport the right rail (map card, rules, mode/map setup, the
  invite box and the actions) was taller than the grid row, so SETTINGS and
  LEAVE fell off the bottom with no way to scroll to them; the invite box now
  sits in the left column between the teams and the spectator bench, and both
  columns own their scroll area (Pending commit — hash follows on commit.).

- `fix(spawns): spread FFA and Gun Game spawns over the whole map` — Ares
  Relay let its eight authored mid-lane points be the entire FFA pool, so both
  teamless modes spawned every body inside a 34 x 27 m band (25 % of the
  walkable area, six of sixteen map cells); authored points are now seeds and
  the validated nav lattice joins them on every map, which takes Ares to 210
  points covering 100 % of the map and a simulated twelve-man fill from
  51 x 50 % to the full footprint. Pool assembly also dedupes to 1.5 m, which
  removes same-floor pairs as close as 0.11 m (dust2) and 0.43 m (Shipment);
  Nuketown's 0.00 m pairs are real stacked floors and stay (Pending commit —
  hash follows on commit.).

- `fix(guns): no false override warnings at boot` — the dev override guard
  fired for the intended placeholder-to-real hand-off (four warnings every
  load); placeholders now register through their own path, so only a real
  builder collision warns — and a placeholder imported last is dropped with a
  warning instead of turning the first-person guns into grey boxes (Pending
  commit — hash follows on commit.).

- `fix(lean): tracer leaves the leaned muzzle` — the local shot tracer
  started from a camera pose re-set to the un-leaned standing eye, so the
  trace lines left the middle of the screen at visor height instead of the
  leaned weapon; the muzzle is now read from the live camera pose the frame
  actually drew (Pending commit — hash follows on commit.).
- `fix(report): private room code redacted` — the bug report embeds the
  private lobby code, which leaked the join code when pasted publicly; the
  text now masks anything shaped like a room code, collapses line breaks and
  strips bidi/zero-width controls so a field cannot forge report lines
  (Pending commit — hash follows on commit.).

- `fix(shaders): Nuketown plant clumps compile under three r187` — the
  `color_pars_fragment` chunk is still guarded by `USE_COLOR` /
  `USE_COLOR_ALPHA`, but it declares a `vec4` whenever it exists, and the
  r187 fragment prefix synthesises `USE_COLOR` from the instancing colour,
  so the material in question gets a vec4 `vColor` (the `nt_plant_clump_fx`
  `onBeforeCompile` in `client/src/nuketown-foliage.ts` still fed it whole
  into `vec3` `mix`/multiply, so the program failed validation with `'mix' :
  no matching overloaded function found` and every draw logged
  `useProgram: program not valid`); the line now swizzles `vColor.rgb`,
  which is valid for both `vec3` and `vec4`, with a comment so it is not
  "simplified" back — audited every other `vColor` use in `client/src`
  (foliage flowers, `nuketown-specs.ts` ground/decal tints) and all of them
  already swizzle `.r/.g/.b/.rgb`, so no other site needed a change
  (d62fcfe).

- `fix(shadows): PCFSoft gone on the WebGL2 path too` — `gpu-backend.ts`
  still set `THREE.PCFSoftShadowMap` on WebGL2, which r187 removed for both
  backends (the WebGPU path already used `PCFShadowMap`); it now names `PCF`
  directly, which is what the old type silently fell back to (a 5-tap
  Vogel-disk `sampler2DShadow` sample with `radius = shadowRadius *
  texelSize`, per the vendored chunk's PCF `getShadow` in
  `shadowmap_pars_fragment`) — only now without
  the `PCFSoftShadowMap has been removed` warning (d62fcfe).

- `fix(shadows): penumbra clamp on both backends` — the directional-light
  `shadow.radius <= 1.6` clamp in `game.ts` only ran on WebGPU, but both
  backends run the same PCF kernel since r187 removed PCFSoft, while every
  map's radius was tuned against the old wider kernel (ares 1.5, nuketown
  2.0, jungle 3.1, dust2 from its env data); the clamp now applies
  unconditionally (still cheap and idempotent via `Math.min`), and no map's
  authored radius was changed at its source (d62fcfe).

- `fix(boot): no more toNonIndexed warnings on Nuketown` — `sageGeometry`
  and `boulderGeometry` in `client/src/nuketown-backdrop.ts` called
  `toNonIndexed()` on `IcosahedronGeometry`, which is already non-indexed
  (~32 warnings per boot); all three sites now guard with `geo.index ?
  geo.toNonIndexed() : geo` like the rest of the repo, passing the freshly
  created original through `paint()` safely — the indexed `CylinderGeometry`
  stems still convert (d62fcfe).

- `fix(boot): paint one frame before the bring-up` — `deploy()` in
  `client/src/main.ts` ran the whole audio-rig plus renderer construction
  synchronously inside the PLAY / QUICK PLAY click task (~0.7 s), so the
  loading card never painted and Chrome flagged `'click' handler took
  696ms`; it now awaits one painted frame (`nextPaint`: rAF first, a 100 ms
  timer fallback so a hidden tab never stalls boot) after the card is up and
  before `bootStage("AUDIO")` — the deferred-audio path is untouched
  (audio2 keeps its `onFirstGesture` fallback, pointer lock comes from
  separate canvas clicks, not `deploy`) (d62fcfe).

- `fix(shadows): remove the dead Nuketown PCFSoft tent patch` — the
  WORK-ORDERS L3 `installSoftShadows()` in `client/src/nuketown-sky.ts`
  patched the `SHADOWMAP_TYPE_PCF_SOFT` branch into a 3x3 tent of bilinear
  taps at 1.5-texel spacing (~14 cm penumbra), but r187 removed that branch
  entirely (zero occurrences in the vendored `ShaderChunk`, and
  `WebGLShadowMap` logs the type as removed), so its guard could never match
  and the call silently no-opped since the upgrade. The function, its
  `PCF_STEP` constant and the call are deleted, with a history note kept in
  place — a dead-code removal with no visual delta. The replacement 5-tap
  Vogel-disk PCF kernel cannot reproduce the old ~14 cm width without reading
  as speckle, so the nuketown/dust2/shipment penumbrae run narrower than
  authored (2.0 and 3.1 → 1.6) by deliberate clamp, not by this removal
  (2916dda).

- `fix(shadows): penumbra clamp is explicit, total and re-applied` — the
  `shadow.radius <= 1.6` clamp in `game.ts` ran once at `init()` with a bare
  `Math.min`, so lights added later escaped it and a `NaN`/negative radius
  (dust2's comes from its `ENVV` env data) passed straight into the shadow
  sampler. It is now `Game.clampShadowRadii()` behind a module-level
  `SHADOW_RADIUS_MAX = 1.6`, clamping totally (`NaN` → the cap, negatives →
  0), and it runs both at `init()` and in `applyShadowQuality()` so late
  lights and a quality re-arm are clamped too — cheap, idempotent, no shadow
  map source touched. Plainly: nuketown/dust2/shipment penumbrae get narrower
  than authored (2.0 and 3.1 → 1.6) because the removed PCFSoft kernel cannot
  be reproduced by the 5-tap replacement without speckle (2916dda).

- `fix(boot): deploy() re-entrancy guard plus a non-browser paint fallback` —
  `deploy()` in `client/src/main.ts` had no in-flight guard, and the awaited
  painted frame widened the window where a double click / double pad-press /
  Enter x2 interleaves two runs (two `createRenderer()` on one canvas and two
  AudioContext builds racing; the inner `game.init()` / `Game.start()` guards
  contain the worst case but not that race). A module-level `deploying` flag
  now serialises it — `deploy()` is a thin door that awaits the unchanged
  bring-up (`deployRun()`) in a `try`/`finally`, so a second deploy while one
  is in flight returns immediately and every exit path (early returns, error
  cards, throws) re-arms the door. `nextPaint()`
  also guards its `requestAnimationFrame` call with a `typeof` check (falling
  back to a zero-delay timer) so a non-browser harness no longer throws a
  `ReferenceError` (2916dda).

### Added

- `feat(bots): tactical corner lean` — bots lean around cover with Q/E
  like players: only on proven cover verified against the map geometry
  (solids/walls/containers/props) where the body eye is blocked and only
  the leaned eye clears the target (a true peek), never in the open
  field, pausing briefly out of sprint for the peek (no lean in sprint,
  no permanent lean), held 0.4–1.1 s without mid-hold flips and followed
  by a cooldown, taken only about three times in four so it stays
  situational; same view-only 0.30 m eye shift with no damage, accuracy,
  or hitbox bonus (Pending commit — hash follows on commit.).

- `feat(post): FXAA tail on hardware WebGPU` — the WebGPU path renders its
  scene pass into single-sample pass targets with `antialias:false` (a GTAO
  precondition: the centre tap needs a single-sample depth texture), so edges
  reached the screen stair-stepped while the WebGL path pays 4x/2x MSAA on the
  composer targets; the FXAA tail the software tier already ran now runs on
  hardware too, after the grade (`?fxaa=0` drops it for bisection) (Pending
  commit — hash follows on commit.).

- `feat(settings): renderer switch (AUTO / WEBGPU / WEBGL2)` — GRAPHICS gained
  a Renderer row and `?renderer=` pins the backend again for one page load;
  the pref had been nailed to `webgl`, which is why the WebGPU path could not
  be reached at all (every "WebGPU" test so far booted WebGL2). Default stays
  WEBGL2 on purpose: the TSL port for the custom FX ShaderMaterials is still
  open, so the WebGPU look has gaps. A switch reloads from the menu and only
  banners "applies after the next load" mid-match, because a canvas binds one
  context type and the renderer is chosen in `init()` (Pending commit — hash
  follows on commit.).
  **Withdrawn again for players**: see `fix(settings): WebGPU off the GRAPHICS
  tab` below — the row is gone, the pref is pinned, the code stays behind
  `?renderer=webgpu`.

### Fixed

- `fix(settings): WebGPU off the GRAPHICS tab` — the renderer row is gone and
  the pref sanitises back to `webgl`, so a player cannot land on the WebGPU
  backend (nor can a stale or hand-edited save bring it back). Nothing is
  deleted: `gpu-backend.ts`, `webgpu-pipeline.ts`, `tsl-materials.ts` and the
  TSL ports of the Ares shaders, the astronaut suit and the weapon FX all stay,
  and `?renderer=webgpu|auto` still forces the backend for development and QA
  without ever being persisted. The remaining world-shader gaps (Nuketown sky,
  the `onBeforeCompile` patches) are why it is out of the menu again (Pending
  commit - hash follows on commit.).
- `fix(lean): shots follow the lean eye` — shots use the same 0.30 m eye
  offset as the camera with a parallel ray, clamped at walls, and the
  preview matches the server (Pending commit — hash follows on commit.).
- `fix(lean): Blender-authored lean pose on the model` — lean was only a
  rigid root tilt on the model so the feet slid; now it layers the
  Blender-authored pose, including its baked crouch variant blended by
  crouchW with the feet near-planted (measured foot drift ≤ 1.2 cm in model
  units), and latch/overlay gaps
  (`Hip`/`Waist`/`NeckTwist02`, `hip.position.x`) plus the aim-slerp order
  are fixed too (Pending commit — hash follows on commit.).
- `fix(lean): camera lean offset wall-clamped` — the leaned camera eye is
  clamped against walls so it can never see through them (Pending commit
  — hash follows on commit.).
- `fix(bots): lean hold breaks on flee/reposition/swap/slide/reload/low HP` — the tactical lean
  hold aborts correctly on fleeing, repositioning, swapping, sliding,
  reloading, low HP, or when a squadmate already holds that target (Pending commit
  — hash follows on commit.).
- `perf(fx): no instanced uploads for effects that draw nothing` — the
  BoomFx flash/ring/frags/puffs/scorch pools flagged ten instance buffers
  for upload every frame even with all four counts at 0, the ThrowMarker aim
  marker uploaded while every dot sat behind the camera, and the NadeFx
  ribbon sampled its trail ring, wrote ribbons and flagged rPos/rAlpha
  uploads for an invisible mesh; each family now uploads only while it draws
  (the frag instances always draw)
  (Pending commit — hash follows on commit.).
- `fix(post): WebGPU grade no longer blows out the frame` — the TSL grade
  carried a hand port of cinematic.ts' RRT/ODT matrices, sRGB knee and
  mid-band depth S-curve; on three r187 it rendered every lit surface clipped
  white (walls pure 255) with exposure having no effect, while the same frame
  through `?pipeline=nograde` was correct. The tone map and the working→sRGB
  encode now come from three's own `renderOutput(ACESFilmic, sRGB)` node, the
  filmic extras stay in linear HDR in front of it and the map exposure is
  pre-divided by the renderer's 1.12 so nothing multiplies twice (Pending
  commit — hash follows on commit.).
- `perf(lean): no per-actor Set allocation in the lean pose` — the lean bone
  name list was rebuilt from two key spreads for every actor on every leaning
  frame; it is derived once per lean direction from the static pose tables now
  (Pending commit — hash follows on commit.).

### Tests

- `test(qa): ?nolock=1 drives fire without pointer lock` — every FX/impact
  check needed a trusted click to take the pointer lock, which a headless
  harness cannot produce, so weapon FX, decals and blood were only ever
  verified by hand. The flag widens the input gate only (keyboard + mouse
  fire); nothing else about the game changes (Pending commit — hash follows
  on commit.).

## 2026-10-30

### Added

- `feat(lean): Q/E corner lean (view-only, replicated)` — leaning around
  corners with Q/E (rebindable): the eye shifts and the model rolls with
  easing while the hit capsule never moves; carried on the input command,
  the snapshot, and every renderer (`361b2eb`).
- `feat(nuke): tactical nuke on a 10-kill streak` — 10 kills without dying
  calls a heavy 12 m blast on the victim's position (150→50 falloff,
  credited TACTICAL NUKE, chains into medals and the ladder) plus banner,
  shake, and announcer call; a reward, never a match end, and quiet under
  the killstreak toggle except for the blast itself (`361b2eb`).
- `feat(server): AFK warning (60 s) and kick (90 s) with visible reason` —
  a live seat without real input gets one private warning, then removal
  through the usual drop path; the kick closes with a reason instead of
  reading as a dropped connection. Movement, buttons, ADS, lean, or a
  moved aim count — idle streaming, ping, and chat do not (`361b2eb`).

### Fixed

- `fix(spawns): dust2 CT spawns onto the deck` — two CT-side spawns sat at
  y=0 below the CT deck and now stand on it (y=3.251 at verified deck
  positions) in both JSON copies (`361b2eb`).
- `fix(ads): eased ADS sensitivity tracking the FOV lerp` — aim sensitivity
  follows an eased ADS value on the same ~18/s the FOV lerps at instead of
  stepping on the late snapshot flip, plus pointer-spike clamps and
  sensitivity pins at the use site (`361b2eb`).
- `fix(spawns): authored FFA points on Ares Relay` — eight teamless mid
  lanes replace the two end-bay team sides as the FFA pool there; other
  maps untouched (`361b2eb`).
- `fix(spawns): neutral FFA pools on every map` — FFA draws teamless
  points everywhere: the authored set on Nuketown (six mid-street points,
  wired through instead of dropped, plus validated nav nodes map-wide so
  twelve seats never double up) and a generic neutral pool (interleaved
  sides with neutral tags plus validated nav nodes map-wide) on Shipment
  and Dust2; Ares Relay keeps its exact eight, team modes untouched
  (`fe7a0c5`).
- `fix(chat): focus/draft-safe chat line` — while the line is open no key
  drives the game, re-pressing T never clears the draft, blur/ESC keep the
  unsent text (only a sent line clears it), and clicks refocus instead of
  firing (`361b2eb`).
- `fix(spawn): 5 s protection that breaks on outgoing damage` — fresh-body
  immunity raised to 5 s, ended at once by firing, knifing, or
  throwing/cooking a frag (incoming cover stays soaked); artillery and the
  streak blast respect it, and a cooked-to-zero frag kills its protected
  holder (`361b2eb`).
- `fix(input): cap single-frame look spikes, lock-gap guard, NaN heal` —
  mouse look is bounded per single frame by a token bucket (honest flicks
  spread over frames pass, impossible one-frame jumps are clipped), look
  is dropped for ~50 ms after a pointer-lock re-acquire, and poisoned
  values heal instead of sticking yaw/pitch (finite clamps plus yaw wrap)
  on mouse and pad (`5a5710d`).
- `fix(teams): initial 6v6 by total count` — team picks and balance
  count every body on the field (humans plus bots) instead of humans
  alone, so the first yard join lands on the minority side and the
  room opens 6v6 instead of stacking 7v5; tied totals fall back to
  human counts so consecutive solo joins alternate sides (`12f59c5`).
- `fix(teams): yard join evicts a majority-side bot` — the over-seat
  eviction after a human join takes the newest bot off the overfull
  side, so the seat total holds, the join re-balances instead of
  freezing the skew, and a human seat is never evicted (`12f59c5`).
- `fix(private): host-arranged sides survive match start` — seats the
  host dealt via lobby move or shuffle carry an arranged flag that
  start keeps as dealt; only auto-dealt seats fill the minority side
  in join order before bot backfill tops up the weaker team, while
  yard auto-balance is untouched (`12f59c5`).
- `fix(teams): documented bot-free overfull edge` — a pure-human
  overfull side has no bot to release, so the eviction loop stops
  instead of taking a minority-side bot; the skew then heals on the
  next leave. Rare: needs a 7-human stack on one side of a full yard
  (`12f59c5`).
- `fix(pause): ESC resume from pause via cooldown fallback` — ESC during
  the resume cooldown closes pause and the hint instead of leaving a dead
  state; fullscreen path and error path aligned to the same resume
  (`66ea4ec`).
- `fix(lean): de-inverted Q/E lean direction` — Q/E lean tilts to the
  pressed side again via a render-only sign correction; value path,
  binds, and rebinds untouched (`2d99b7a`).

## 2026-10-29

### Added

- `feat(public): per-mode yard rooms (tdm/ffa/gun) + tests` — public
  matchmaking now runs one yard room per game mode instead of a single
  shared room, with server tests (`6a9e6f0`).
- `feat(yard): reshuffle public TDM teams on rollover` — public TDM teams
  are re-shuffled when a yard match rolls over into the next one
  (`f2ac283`).
- `feat(yard): keep pointer lock across rollover, click-to-play only on
  first join` — pointer lock survives match rollover; the click-to-play
  overlay only appears on the first join (`85dfe5e`).
- `feat(pause): fullscreen+resume button after ESC in fullscreen` —
  pressing ESC in fullscreen now shows a resume button instead of leaving
  the player stranded (`26dc737`).
- `feat(maps): ares default map with consistent priority (?map > saved >
  default)` — Ares is the default map with one documented priority order:
  URL parameter beats saved preference beats default (`16c1d24`).

### Fixed

- `fix(public): gate sees running yard match` — public gate check
  carries the picked mode for the yard door and answers with the running
  yard room (exists/phase/mode plus bench/full flags) instead of blind
  defaults (`00f65a1`).
- `fix(public): second player joins live game` — a second human joins
  the same running yard room with an immediate seat and exactly one bot
  evicted to hold the seat total; a full yard parks late joiners as
  spectators with promotion when a seat frees (`00f65a1`).
- `fix(net): stale end-tick guard, rollover fallback, endcard expiry` —
  stale end-of-match ticks are ignored, rollover has a fallback path, and
  the endcard expires cleanly (`d81c30d`).
- `fix(quick): seamless play-again without lock/fullscreen loss or
  pause` — instant rematch keeps pointer lock and fullscreen and does not
  drop into pause (`b48671e`).

### Docs

- `docs(readme): enhancements catch-up (match end, yards, music, sprays,
  menu)` — README catches up with match-end, yards, music, spray, and
  menu work (`6660b92`).

### Tests

- `test(server): second human joins running public gun yard` — covers a
  second human player joining an already-running public gun-mode yard
  (`0ea0f2e`).

## 2026-10-28

### Added

- `feat(audio): spray paint sound effect (converted user clip,
  positional)` — sprays play a positional paint sound converted from a
  user-provided clip (`135c574`).
- `feat(announcer): balanced direction (killstreaks on, kong throttling,
  caps)` — announcer direction pass: killstreak lines enabled, Kong
  throttled, playback caps in place (`2b33ed5`).
- `feat(menu): music mute toggle in topbar` — background music can be
  muted directly from the topbar (`e308f85`).

### Fixed

- `fix(sprays): clear decals on match end, rematch and lobby return` —
  spray decals are wiped on match end, rematch, and lobby return
  (`7c4e12c`).
- `fix(net): reliable match end (retransmit, watchdog, event guards)` —
  match end is delivered reliably via retransmit, a watchdog, and event
  guards (`89e611e`).
- `fix(server): allow loopback across ports for local dev` — local
  development across differing loopback ports is accepted by the server
  host check (`b365a48`).

## 2026-10-27

### Added

- `feat(menu): per-map background music with crossfade` — each map gets
  its own 60 s+ menu-music loop with a 1.5 s equal-power crossfade on map
  change, gesture-gated and parked over live matches (`79f4a28`).
- `feat(menu): show spray and chat hints in keyline` — the menu keyline
  advertises the spray and chat controls (`107922c`).

### Docs

- `docs(readme): menu-music loop lengths 60-77s` — documents the
  per-map loop durations (`b7df429`).

## 2026-10-26

### Added

- `feat(audio): generated doom-like announcer/kong voice clips (49 ogg,
  synthesis fallback)` — 49 generated voice clips with a synthesis
  fallback (`af3b15b`).
- `feat(audio): warlord announcer voice + anti-spam gating` — Warlord
  announcer voice with anti-spam gating (`4c3ae2e`).
- `feat(chat): sanitized + rate-limited in-game text chat +
  announcer/kong voice exclusivity` — text-only chat with server-side
  bad-word filter (leet-folding), per-seat rate limit, and reserved
  "server" sender name; announcer and Kong voices are mutually
  exclusive (`2312f0e`).
- `feat(settings): killstreak announcer toggle (default off)` — opt-in
  setting for killstreak announcements (`22066be`).
- `feat(announcer): lead-taken announcement only from team score 3` —
  lead-change callouts start once a team reaches score 3 (`51e16dc`).
- `feat(announcer): killstreak escalation (ascending only) + mark on
  playback` — killstreak lines escalate upward only and are marked when
  played (`8b26a61`).
- `feat(chars): team-colored kong shorts + astronaut suit bands` —
  characters show team colors on Kong shorts and astronaut suit bands
  (`76e2861`).
- `feat(menu): github link in main menu footer` — footer links to the
  GitHub repository (text link first, then restyled as an icon)
  (`bafbc22`, `25e3592`).

### Fixed

- `fix(server): end-of-match snapshot flush` — the server flushes the
  end-of-match snapshot (`4c3ae2e`).
- `fix(announcer): foreign kills never voiced; fix(server): tidy end-tick
  flush path` — announcer ignores kills by uninvolved players; end-tick
  flush path cleaned up (`042f778`).
- `fix(announcer): timely multikill announcements (anchored deadline, no
  sliding window)` — multikill callouts use an anchored deadline so they
  fire on time (`e3c2f8b`).

### Docs

- `docs(readme): list own enhancements (voices, announcer direction,
  sanitized + rate-limited chat)` — README lists the voice, announcer-direction, and sanitized + rate-limited
  chat additions (`8616ac7`).
- `docs(readme): team-colored clothing; feat(menu): source-available
  github link label` — README covers team-colored clothing; footer link
  labeled as source-available (`485f1c9`).

## 2026-10-23 — Base + site setup (collective)

Upstream/base snapshot and site setup — upstream ports are NOT tracked
here (see `docs/upstream-sync.md`): `Initial repository
snapshot` (`39093f4`), branding/site-verification/gitignore setup
(`2a70e17`, `aca1150`, `f0f6fc8`, `85b9668`).
