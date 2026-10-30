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
`b48671e` (HEAD at time of writing); upstream sync/port commits in that
range (e.g. `09486bd`, `d4111b4`) are intentionally excluded — upstream
ports are NOT tracked here (see `docs/upstream-sync.md`).

## [Unreleased]

No unreleased changes beyond the sections below.

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
