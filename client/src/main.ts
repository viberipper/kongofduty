/**
 * client/src/main.ts — boot, the start-a-game flow, and the wiring between the
 * game and the UI design system (client/src/ui/*). ONE menu, ONE settings,
 * ONE lobby for every map: nothing here branches on which map is loaded.
 *
 * THE FLOW (docs/nuketown/DESIGN-SYSTEM.md "Flow"):
 *   menu: pick map + mode → QUICK PLAY | PRIVATE MATCH | PUBLIC MATCH
 *     · a map the page has not built → one reload, carrying the INTENT
 *       (ui/flow.ts); boot() resumes it, so the first press always lands
 *     · a remembered callsign is not asked again (the gate runs in "auto")
 *   loading screen (map art, mode, real stage progress) → lobby or match
 *   ESC in a match → pause menu (resume / loadout / settings / leave)
 *   endcard → play again (bots) · back to the same lobby (private) · next
 *   match (public)
 */
import { Game, type EndRow, type HudState } from "./game";
import { detachSpectate, attachSpectate } from "./spectate";
import { PACK_OPTIONS, readPackPref, writePackPref } from "./audio-packs";
import { lockActiveMap, preloadMapData, readMapPref } from "@shared/maps";
import {
  attachLobby,
  closeGate,
  defaultWs,
  detachLobby,
  freshRoomCode,
  inviteLink,
  lobbyOnScreen,
  openCallsignGate,
  rememberedCallsign,
  showFull,
  type GateKind,
  type GateResult,
} from "./lobby";
import type { MatchPhase } from "@shared/matchphase";
import { bootStage, hookBootErrors, resetBootProgress } from "./bootstage";
import { LOBBY_RETURN_S, PUBLIC_ROLLOVER_S, asModeId, modeInfo, simMode, type ModeId } from "@shared/modes";
import { TEAM_COLORS, onPrefs, prefs, reducedMotion } from "./ui/prefs";
import { initMenu, menuBusy, menuSelection, setCallsignChip, setMenuSelection, type MenuPadAction } from "./ui/menu";
import { openSettings, closeSettings, settingsOpen, type SettingsDeps } from "./ui/settings";
import { closeLoadout, loadoutOpen, openLoadout } from "./ui/loadout";
import { closePause, openPause, pauseOpen } from "./ui/pause";
// gamepad stream: START toggles pause mid-match, D-pad + A/B drive modals (no pointer lock needed).
import { startPadUiNav } from "./ui/gamepad";
import { hudState, markBenchAttached, paintHud, resetHud } from "./ui/hud";
import { hideEndcard, showEndcard, type EndKind } from "./ui/endcard";
import { goToMap, mapCardUrl, mapIds, mapLabel, stripTransientParams, takeIntent } from "./ui/flow";
import { uiSfx, wireSfx } from "./ui/sfx";
import { initMenuMusic, selectMenuMusic, startMenuMusic, stopMenuMusic } from "./menu-music";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * THE MAP'S DATA, BEFORE THE SIM'S MODULE BODY. shared/sim.ts derives its
 * collider grid, nade fence and nav graph at import; shared/maps self-preloads
 * with a top-level await. This call is idempotent — it states the boot order
 * where a reader of main.ts will look for it.
 */
await preloadMapData(readMapPref());
/** The map this page built. One page load is one map. */
const PAGE_MAP = readMapPref();

const canvas = $<HTMLCanvasElement>("c");
const game = new Game(canvas);
(window as unknown as { __game: Game }).__game = game;
if (game.diagnostics) {
  (window as unknown as { kongDiagnostics: typeof game.diagnostics }).kongDiagnostics = game.diagnostics;
  const button = document.createElement("button");
  button.textContent = "DOWNLOAD PERFORMANCE REPORT";
  button.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:10000;padding:8px;font:11px monospace";
  button.addEventListener("click", () => game.diagnostics!.download());
  document.body.appendChild(button);
}

type Kind = "bots" | "host" | "invite" | "yard";
const state = {
  name: "RECRUIT",
  room: "",
  mode: "tdm" as ModeId,
  /** Which door the current/last match came through. */
  kind: "bots" as Kind,
  online: false,
};

function show(id: string, on: boolean): void {
  $(id)?.classList.toggle("hidden", !on);
}

function sfx(key: string): void {
  uiSfx(key === "ui-go" ? "confirm" : "select");
}

function wsUrl(): string {
  // S2: strictly validate the custom server — only ws:/wss: with a host, else default.
  // (Pre-existing gap: startsWith("ws") used to be enough for a connect.)
  const raw = prefs().server.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if ((u.protocol === "ws:" || u.protocol === "wss:") && u.host) return raw;
    } catch {
      /* not a URL — fall through to the default */
    }
    console.warn("[net] custom server rejected (only ws:// or wss:// URLs allowed), using default");
  }
  return defaultWs();
}

// ---------------------------------------------------------------- settings

const settingsDeps: SettingsDeps = {
  packs: PACK_OPTIONS.map((p) => ({ key: p.key, label: p.label })),
  readPack: readPackPref,
  setPack: async (key) => {
    writePackPref(key);
    if (key === "synth") {
      await game.audio.loadPack(key);
      return "PROCEDURAL — NO DOWNLOAD";
    }
    await game.audio.loadPack(key);
    return packNote();
  },
  packNote: () => packNote(),
  inMatch,
};

function packNote(): string {
  const s = game.audio.packStatus;
  if (!s) return "";
  if (s.pending) return "LOADS WITH THE NEXT MATCH";
  if (s.key === "synth") return "PROCEDURAL — NO DOWNLOAD";
  if (!s.ok) return `FAILED (${s.error ?? "unknown"}) — PLAYING SYNTH`;
  return `${(s.bytes / 1048576).toFixed(2)} MB · ${s.events} SOUNDS`;
}

/** Live-apply every setting the game does not read per frame itself. */
function applyPrefs(): void {
  // AAA graphics keys: anything the post chain, shadows or resolution own.
  // The renderer backend itself needs a reload (note in the settings desc).
  // renderScale is in here so setGraphicsOptions() can reset the adaptive
  // shadow cap on a switch to NATIVE (review round 2).
  const GFX: (keyof ReturnType<typeof prefs>)[] = [
    "quality",
    "renderScale",
    "bloom",
    "bloomStrength",
    "ao",
    "aoStrength",
    "chromatic",
    "grain",
    "vignette",
    "motionBlur",
    "dof",
    "sharpen",
    "exposure",
    "shadowQuality",
  ];
  onPrefs((p, changed) => {
    game.audio.setVol(p.master);
    game.audio.setMix?.(p.effects, p.ui, p.ambience);
    $("hud")?.style.setProperty("--hud-scale", String(p.hudScale));
    document.body.classList.toggle("no-dmgnums", !p.damageNumbers);
    document.documentElement.classList.toggle("reduce-motion", reducedMotion());
    document.documentElement.classList.toggle("full-motion", p.motion === "full");
    // Colour-vision mode — the team pair every stylesheet reads (default = tokens.css)
    const tc = TEAM_COLORS[p.colorMode];
    const vars: [string, string][] = [
      ["--c-ally", tc.ally],
      ["--c-ally-lo", `rgba(${tc.miniAlly},0.18)`],
      ["--c-enemy", tc.enemy],
      ["--c-enemy-lo", `rgba(${tc.miniEnemy},0.18)`],
    ];
    for (const [k, v] of vars) {
      if (p.colorMode === "default") document.documentElement.style.removeProperty(k);
      else document.documentElement.style.setProperty(k, v);
    }
    fpsOn(p.showFps, p.netStats);
    if (changed.includes("renderScale") || changed.includes("quality")) game.resize();
    if (changed.some((k) => (GFX as string[]).includes(k))) game.setGraphicsOptions();
    if (game.opts) {
      game.opts.sens = p.sens;
      game.opts.tac = p.tacSprint;
      game.opts.vol = p.master;
    }
  });
}

// ---------------------------------------------------------------- FPS counter

let fpsRaf = 0;
let netStatsOn = false;
function fpsOn(on: boolean, net = false): void {
  netStatsOn = net;
  on ||= net;
  show("fps", on);
  $("fps")?.classList.toggle("netstats", net);
  if (!on) {
    cancelAnimationFrame(fpsRaf);
    fpsRaf = 0;
    return;
  }
  if (fpsRaf) return;
  let frames = 0;
  let since = performance.now();
  let worst = 0;
  let last = since;
  const tick = (now: number): void => {
    frames++;
    worst = Math.max(worst, now - last);
    last = now;
    if (now - since >= 500) {
      const el = $("fps");
      const fps = Math.round((frames * 1000) / (now - since));
      // Read the backend live: it is only decided inside game.init().
      const backend = game.backend === "webgpu" ? "WEBGPU" : "WEBGL2";
      if (el && !netStatsOn) el.textContent = `${fps} FPS · ${backend}`;
      else if (el) {
        // Upstream (.origin 28.10.): NETWORK STATS — one row per number,
        // coloured by how it feels to play on.
        const n = game.netStats();
        const tone = (v: number, ok: number, bad: number): string => (v <= ok ? "good" : v <= bad ? "warn" : "bad");
        const rows: [string, string, string][] = [
          ["FPS", `${fps} ${backend}`, tone(-fps, -55, -30)],
          ["FRAME", `${((now - since) / frames).toFixed(1)} / ${worst.toFixed(0)} MS`, tone(worst, 34, 70)],
        ];
        if (n) {
          rows.push(
            ["PING", `${Math.round(n.ping)} MS`, tone(n.ping, 80, 150)],
            ["JITTER", `${n.jitter.toFixed(1)} MS`, tone(n.jitter, 10, 30)],
            ["LOSS", `${(n.loss * 100).toFixed(1)}%`, tone(n.loss, 0.01, 0.05)],
            ["TICK", `${Math.round(n.snapHz)} HZ ${n.lane}`, tone(-n.snapHz, -28, -20)],
          );
        } else rows.push(["NET", "LOCAL · BOTS", "good"]);
        el.innerHTML = rows.map(([k, v, c]) => `<div class="ns-row"><span>${k}</span><b class="ns-${c}">${v}</b></div>`).join("");
      }
      frames = 0;
      since = now;
      worst = 0;
    }
    fpsRaf = requestAnimationFrame(tick);
  };
  fpsRaf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- loading screen

const TIPS = [
  "Double-tap SHIFT for tactical sprint — faster, but your weapon is down longer coming out of it.",
  "Sprint, then press C to slide into cover.",
  "Hold G to cook a frag, release to throw. Cook too long and it goes off in your hand.",
  "Three kills without dying calls in a UAV. Five calls in an artillery strike.",
  "Change your loadout from the pause menu — it is issued on your next spawn.",
  "Hold TAB for the scoreboard.",
  "Private matches fill empty seats with bots when the host starts.",
  "Aim down sights before you peek. Hip fire is for point-blank only.",
  "Reload behind cover. The reload is longer when the magazine is empty.",
];

function showLoading(map: string, mode: ModeId, kind: Kind | "menu"): void {
  const info = modeInfo(map, mode);
  $("boot-art").style.backgroundImage = mapCardUrl(map);
  $("boot-map").textContent = mapLabel(map);
  const door = kind === "bots" ? "QUICK PLAY" : kind === "yard" ? "PUBLIC MATCH" : kind === "menu" ? "" : "PRIVATE MATCH";
  $("boot-mode").textContent = kind === "menu" ? "LOADING" : `${door} · ${info.label} · ${info.size}`;
  $("boot-rules").textContent = kind === "menu" ? "" : `${info.rules}`;
  const tip = $("boottip");
  tip.replaceChildren();
  const b = document.createElement("b");
  b.textContent = "TIP";
  tip.append(b, document.createTextNode(TIPS[(Math.random() * TIPS.length) | 0]!));
  resetBootProgress();
  show("boot", true);
}

// ---------------------------------------------------------------- doors

/** Everything the game can send us back to: the menu, with nothing running. */
function toMenu(): void {
  game.stop();
  closePause();
  pauseFullscreenLost = false;
  hideEndcard();
  detachSpectate(game);
  detachLobby();
  closeGate();
  // Explicit defense-in-depth: detachLobby already closes settings, but toMenu
  // must never show the menu with a modal stacked on it even if that changes.
  if (settingsOpen()) closeSettings();
  resetHud();
  show("hud", false);
  show("boot", false);
  show("menu", true);
  menuBusy(false);
  setCallsignChip(rememberedCallsign());
  startMenuMusic(menuSelection().map);
  stripTransientParams(PAGE_MAP);
  if (document.pointerLockElement) document.exitPointerLock();
}

function hideMenus(): void {
  show("menu", false);
  hideEndcard();
  show("boot", false);
  show("hud", false);
}

/**
 * THE ONE DOOR INTO A NAMED GAME. The gate has the SERVER check the callsign
 * (and the room) before any of the game boots. A returning player's name is
 * not asked again (`auto`): the card shows progress, and the field only
 * appears if the server refuses it.
 */
function openGate(kind: GateKind, room: string, extra: { mode?: ModeId; auto?: boolean; headline?: string; waitForHost?: boolean }, onEnter: (r: GateResult) => void): void {
  if (settingsOpen()) closeSettings();
  hideMenus();
  openCallsignGate({
    room,
    kind,
    suggested: state.name,
    wsUrl: wsUrl(),
    newCode: kind === "host" ? freshRoomCode : undefined,
    map: PAGE_MAP,
    mode: extra.mode,
    waitForHost: extra.waitForHost,
    auto: extra.auto,
    headline: extra.headline,
    sfx,
    onCancel: toMenu,
    onEnter,
  });
}

/** QUICK PLAY: an offline match against bots on this page's map. */
function enterBots(mode: ModeId): void {
  state.mode = mode;
  state.kind = "bots";
  if (rememberedCallsign()) {
    state.name = rememberedCallsign();
    void deploy(false);
    return;
  }
  openGate("bots", "", { headline: headline(mode) }, (r) => {
    state.name = r.name;
    void deploy(false);
  });
}

/** PRIVATE MATCH: create a lobby on this page's map with the picked mode (or re-open `room`, moved here by its host). */
function enterHost(mode: ModeId, room?: string): void {
  state.kind = "host";
  openGate("host", room ?? freshRoomCode(), { mode, auto: true, headline: headline(mode) }, (r) => {
    state.name = r.name;
    state.room = r.room;
    state.mode = (r.mode ?? mode) as ModeId;
    void deploy(true, r.phase, r.spectate);
  });
}

/** An invite link (?join=CODE), an invite resumed after a map reload, or a lobby following its host to another map (`wait`). */
function enterInvite(room: string, auto: boolean, follow?: { mode?: ModeId; wait?: boolean }): void {
  state.kind = "invite";
  state.room = room;
  openGate("invite", room, { auto, mode: follow?.mode, waitForHost: follow?.wait }, (r) => {
    state.name = r.name;
    state.room = r.room;
    state.mode = (r.mode ?? "tdm") as ModeId;
    void deploy(true, r.phase, r.spectate);
  });
}

/** PUBLIC MATCH: the always-on yard of this map for the picked mode. */
function enterYard(mode: ModeId): void {
  state.kind = "yard";
  state.room = "";
  state.mode = mode;
  openGate("yard", "", { mode, auto: true, headline: headline(mode) }, (r) => {
    state.name = r.name;
    // The yard has no lobby by construction (always live), but deploying with a
    // phase wires attachLobby, which is what hears a bench seat (welcome.spectator).
    void deploy(true, "live", r.spectate);
  });
}

function headline(mode: ModeId): string {
  const info = modeInfo(PAGE_MAP, mode);
  return `${info.label} ${info.size} · ${mapLabel(PAGE_MAP)}`;
}

/**
 * A MENU TILE. The selection decides map + mode; a map this page has not
 * built costs one reload, and the intent rides across it.
 */
function launch(kind: "bots" | "host" | "yard"): void {
  const sel = menuSelection();
  const mode = sel.mode;
  if (sel.map !== PAGE_MAP) {
    menuBusy(true);
    uiSfx("confirm");
    const intent = kind === "bots" ? { kind, map: sel.map, mode } : kind === "host" ? { kind, map: sel.map, mode } : { kind, map: sel.map, mode };
    showLoading(sel.map, mode, kind);
    goToMap(sel.map, intent as Parameters<typeof goToMap>[1], PAGE_MAP);
    return;
  }
  if (kind === "bots") enterBots(mode);
  else if (kind === "host") enterHost(mode);
  else enterYard(mode);
}

/** The callsign chip: a name check and nothing else. */
function renameCallsign(): void {
  openGate("rename", "", {}, (r) => {
    state.name = r.name;
    setCallsignChip(r.name);
    show("menu", true);
  });
}

// ---------------------------------------------------------------- deploy

async function deploy(online: boolean, phase: MatchPhase | null = null, spectate = false): Promise<void> {
  state.online = online;
  showLoading(PAGE_MAP, state.mode, state.kind);
  show("menu", false);
  hideEndcard();
  resetHud();
  // The bed plays over menus and the pre-game lobby, never over a live match:
  // a bot match or a phaseless deploy goes quiet now, a pre-game lobby keeps
  // its map's theme until the host starts (attachLobby onStart parks it).
  // The lobby runs the room's map (PAGE_MAP), not the menu card's.
  if (phase === "pregame") selectMenuMusic(PAGE_MAP);
  else stopMenuMusic();
  try {
    bootStage("AUDIO");
    await Promise.all([game.init(), game.audio.boot()]);
    game.audio.setMix?.(prefs().effects, prefs().ui, prefs().ambience);
    bootStage("READY");
    // The card is hidden by game.onFirstFrame — a hidden card over a frame that
    // has not been drawn yet is a frozen screenshot of this card.
    game.onFirstFrame = () => show("boot", false);
    // A PRE-GAME LOBBY IS NOT A MATCH: no HUD, no pointer lock. The map is
    // already loaded behind the lobby, which is what makes START instant.
    const pregame = phase === "pregame";
    show("hud", !pregame);
    game.onHud = (s: HudState) => paintHud(game, s, PAGE_MAP);
    game.onRematch = () => {
      hideEndcard();
      // ROLLOVER WITH THE LOCK STILL HELD (yard auto-rollover): keep
      // everLocked so the CLICK-TO-PLAY hint stays down and play resumes
      // without another click. Lock lost (ESC during the endcard): re-arm
      // the hint exactly as before.
      if (!document.pointerLockElement) hudState.everLocked = false;
    };
    game.onEnd = (_win, s0, s1, board) => onMatchEnd(s0, s1, board ?? []);
    // BENCHED BEFORE THE FIRST FRAME: hook the spectator camera before start()
    // so this seat never builds an input command for a body it will not drive.
    if (spectate) {
      markBenchAttached();
      attachSpectate(game);
    }
    if (online) bootStage("JOINING MATCH");
    await game.start({
      name: state.name,
      mode: simMode(state.mode),
      gun: state.mode === "gun",
      room: state.room || undefined,
      host: online ? wsUrl() : "",
      sens: prefs().sens,
      vol: prefs().master,
      tac: prefs().tacSprint,
    });
    if (phase) {
      attachLobby(
        game,
        {
          // The host pressed START: the lobby closes and the match HUD comes up.
          // The 3-2-1 is drawn over the live map by the countdown layer.
          onStart: () => {
            if (settingsOpen()) closeSettings();
            stopMenuMusic();
            show("hud", true);
            hideEndcard();
          },
          onRefused: (msg) => console.warn("lobby refused:", msg),
          // The host switched the lobby's mode: labels, pause card and endcard follow.
          onMode: (mode) => {
            state.mode = mode;
          },
          onLeave: () => {
            if (settingsOpen()) closeSettings();
            toMenu();
          },
          onSettings: () => openSettings(settingsDeps),
          // The match ended and the room dropped back to its pre-game lobby.
          onReturn: () => {
            if (settingsOpen()) closeSettings();
            hideEndcard();
            closePause();
            pauseFullscreenLost = false;
            // The server scrubbed its tags at the rollover: scrub the meshes
            // too (the match/live event the old path relied on is not what a
            // pre-game lobby should depend on).
            game.sprays?.clear();
            show("hud", false);
            startMenuMusic(PAGE_MAP);
            if (document.pointerLockElement) document.exitPointerLock();
          },
          sfx,
        },
        phase,
        spectate,
      );
    }
  } catch (err) {
    game.stop();
    console.error(err);
    show("boot", false);
    // ERROR CARDS THAT TELL THE TRUTH: who you are (host / guest / public /
    // offline) and what actually failed. TRY AGAIN re-runs the same door.
    const reason = String((err as Error)?.message ?? err);
    if (state.kind === "host") {
      showFull("THE GAME SERVER ACCEPTED YOUR LOBBY BUT THE MATCH CONNECTION FAILED. IT MAY BE RESTARTING — TRY AGAIN.", "COULDN'T START YOUR LOBBY", "PRIVATE MATCH");
    } else if (state.kind === "invite") {
      showFull(`THE LOBBY ${state.room} IS THERE, BUT THE CONNECTION TO ITS SERVER FAILED. CHECK YOUR CONNECTION AND TRY AGAIN.`, "COULDN'T JOIN", `PRIVATE MATCH · ${state.room}`);
    } else if (state.kind === "yard") {
      showFull("THE PUBLIC MATCH SERVER DIDN'T ACCEPT THE CONNECTION. TRY AGAIN IN A MOMENT.", "COULDN'T CONNECT", "PUBLIC MATCH");
    } else {
      showFull(`THE MATCH COULDN'T START ON THIS DEVICE (${reason.slice(0, 120).toUpperCase()}).`, "COULDN'T START", "QUICK PLAY");
    }
  }
}

function onMatchEnd(s0: number, s1: number, board: EndRow[]): void {
  closePause();
  pauseFullscreenLost = false;
  const kind: EndKind = !state.online ? "bots" : state.room ? "lobby" : "yard";
  // YARD ROLLOVER KEEPS THE LOCK: the public match rolls straight into the
  // next one (no cursor needed — LEAVE is one ESC away), so play resumes
  // without another CLICK-TO-PLAY. Bots/lobby endcards need the cursor for
  // their buttons, so they still release it.
  if (kind !== "yard" && document.pointerLockElement) document.exitPointerLock();
  // PLAY-AGAIN REENTRANCY GUARD: one card, one rematch — a fast double
  // click / double activation must not run two deploy()/game.start() in
  // parallel. Per-card closure flag (plus the disabled button in endcard.ts).
  let playAgainBusy = false;
  showEndcard({
    mode: state.mode,
    map: PAGE_MAP,
    s0,
    s1,
    board,
    kind,
    gunKills: game.gunKills,
    combat: { ...game.combat }, // combat stats panel
    // feel stream: the server's clock started at the match end, before the final killcam played.
    nextIn: Math.max(1, (kind === "lobby" ? LOBBY_RETURN_S : PUBLIC_ROLLOVER_S) - game.sinceEndS()),
    onPlayAgain: () => {
      if (playAgainBusy) return;
      playAgainBusy = true;
      // IN-PLACE REMATCH: this click IS the gesture — keep fullscreen across
      // the teardown and re-take the endcard-released lock synchronously, so
      // no fullscreen/pointerlock event fires over the new match and opens
      // the pause menu, and no CLICK-TO-PLAY is needed (everLocked preserved
      // like the yard rollover in onRematch above). Lock/fullscreen already
      // lost (ESC on the endcard): the request below is still this gesture,
      // so the normal resume path just works; if the re-lock hits the ~1 s
      // ESC cooldown, the hint comes back and the next canvas click takes it.
      const wantLock = !!document.fullscreenElement || hudState.everLocked;
      game.stop({ keepLock: true, keepFullscreen: true });
      hideEndcard();
      void deploy(false);
      if (wantLock) {
        hudState.everLocked = true;
        // Chrome throws SYNCHRONOUSLY on a re-lock inside the ~1 s ESC
        // cooldown (not just a rejected promise) — without this try/catch
        // that is an uncaught exception and everLocked stays wrongly true.
        try {
          const r = canvas.requestPointerLock() as unknown;
          if (r && typeof (r as Promise<void>).catch === "function") {
            (r as Promise<void>).catch(() => {
              hudState.everLocked = false;
            });
          }
        } catch {
          hudState.everLocked = false;
        }
      }
    },
    onMenu: toMenu,
    // COUNTDOWN-EXPIRY FALLBACK (yard rollover): the card is still up ~2 s
    // past zero, so the rollover event never landed. Only act when the wire
    // is provably a live match — fresh snapshots, live phase, clock running —
    // otherwise leave the card alone (a slow server must never be preempted).
    // forceRollover() runs the same reset as the match/live event path and
    // starts/rejoins nothing, so a double match start is impossible; if the
    // server is actually still over, the next remain<=0 snapshot re-raises
    // the card via finish().
    onExpired: () => {
      const card = document.getElementById("endcard");
      if (!card || card.classList.contains("hidden")) return;
      if (!game.ended) {
        hideEndcard();
        return;
      }
      if (game.matchLive() && performance.now() - game.snapRecv < 4000 && game.netRemain > 0) game.forceRollover();
    },
  });
}

// ---------------------------------------------------------------- pause

function inMatch(): boolean {
  return game.running && !$("hud").classList.contains("hidden") && $("endcard").classList.contains("hidden") && !lobbyOnScreen() && !game.fkc; // feel stream: not over the final killcam
}

/** Menu home up, no modal stacked on it — the pad shortcut layer (MENU_PAD) may fire. */
function menuHomeVisible(): boolean {
  const m = document.getElementById("menu");
  return !!m && !m.classList.contains("hidden") && !settingsOpen() && !loadoutOpen() && !lobbyOnScreen();
}

/** Pause up, no modal stacked on it — Y/X may jump straight to loadout/settings. */
function pauseAlone(): boolean {
  return pauseOpen() && !settingsOpen() && !loadoutOpen();
}

/** LB/RB on menu home: step the map cards (same table the badge bar renders). */
function cycleMap(dir: 1 | -1): void {
  const ids = mapIds();
  if (!ids.length) return;
  const cur = menuSelection().map;
  const i = Math.max(0, ids.indexOf(cur));
  setMenuSelection({ map: ids[(i + dir + ids.length) % ids.length]! });
  uiSfx("select");
}

/** Fire one MENU_PAD shortcut (badges in menu.ts render this same table). */
function fireMenuPad(a: MenuPadAction): void {
  if (a === "quick") launch("bots");
  else if (a === "callsign") renameCallsign();
  else cycleMap(a === "map-next" ? 1 : -1);
}

/** TRUE seit einem Fullscreen-Exit mitten im Match (ESC) — Pause bietet 1-Klick-Rückkehr. */
let pauseFullscreenLost = false;

function openPauseMenu(opts?: { fullscreenLost?: boolean }): void {
  const info = modeInfo(PAGE_MAP, state.mode);
  hudState.paused = true;
  // Nur wenn der Fullscreen wirklich weg ist (ESC im Fullscreen beendet ihn
  // zusammen mit dem Pointer-Lock — der Browser reserviert ESC dafür, das lässt
  // sich nicht abfangen). Fenster-Modus: Flag bleibt aus, Verhalten unverändert.
  if (opts?.fullscreenLost) pauseFullscreenLost = true;
  if (document.fullscreenElement) pauseFullscreenLost = false;
  openPause({
    mode: `${info.label} · ${info.size}`,
    map: mapLabel(PAGE_MAP),
    mapArt: mapCardUrl(PAGE_MAP),
    rules: info.rules,
    score: {
      a: $("s0")?.textContent ?? "0",
      b: $("s1")?.textContent ?? "0",
      la: $("s0lbl")?.textContent ?? "",
      lb: $("s1lbl")?.textContent ?? "",
      clock: $("clock")?.textContent ?? "",
      ffa: state.mode !== "tdm",
    },
    invite: state.online && state.room ? inviteLink(state.room, PAGE_MAP) : undefined,
    online: state.online,
    fullscreenLost: pauseFullscreenLost,
    onFullscreenResume: resumeFullscreen,
    onResume: resume,
    onLoadout: () => openLoadout({ inMatch: true }),
    // CLOSING SETTINGS RETURNS YOU TO THE GAME: DONE / ESC is a user
    // gesture, so it can take the pointer back — otherwise the player landed
    // on the pause menu and had to press RESUME as well.
    onSettings: () => openSettings(settingsDeps, { onClose: () => { if (inMatch()) resume(); } }),
    onLeave: () => {
      uiSfx("back");
      toMenu();
    },
  });
}

function resume(): void {
  // A gamepad "click" on RESUME is synthetic: it carries no user gesture, so
  // requestPointerLock below always rejects — and the pad needs no lock
  // anyway. Skip straight to playing; real mouse/keyboard gestures (which
  // always carry activation) take the lock path as before.
  const gestureless =
    (navigator as unknown as { userActivation?: { isActive?: boolean } }).userActivation?.isActive === false;
  if (gestureless) {
    hudState.paused = false;
    pauseFullscreenLost = false;
    closePause();
    return;
  }
  // ESC-COOLDOWN: Chrome verweigert ein Re-Lock ~1 s nach dem ESC-Exit, der
  // die Pause geöffnet hat — ein sofortiges ESC auf der Pause (und jeder
  // schnelle RESUME-Klick) würde sonst scheinbar wirkungslos verpuffen, weil
  // die Pause bis zum pointerlockchange offen bleibt, das nie kommt. Darum:
  // Pause bei Fehlschlag trotzdem schließen und den CLICK-TO-PLAY-Hint
  // wieder scharf schalten (everLocked=false) — der nächste Canvas-Klick
  // nimmt den Lock (gleicher Pfad wie der Play-again-Cooldown in onMatchEnd).
  const cooldownFallback = (): void => {
    hudState.paused = false;
    pauseFullscreenLost = false;
    closePause();
    hudState.everLocked = false;
  };
  // Chrome wirft SYNCHRON synchron im Cooldown (nicht nur per Promise) —
  // ohne try/catch wäre das eine unbehandelte Exception (wie in onPlayAgain).
  try {
    const r = canvas.requestPointerLock() as unknown;
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch(cooldownFallback);
    }
  } catch {
    cooldownFallback();
  }
}

/**
 * FULLSCREEN + FORTSETZEN — ein Klick aus dem Pause-Menü nach ESC im
 * Fullscreen: requestFullscreen + Pointer-Lock + Resume, alles aus dieser
 * einen User-Geste (daher erlaubt). Kein Auto-Re-Enter ohne Geste — der
 * schlägt fehl und wird nicht versucht. Klappt der Fullscreen nicht, läuft
 * trotzdem der normale Resume-Pfad (Fenster-Modus).
 */
function resumeFullscreen(): void {
  pauseFullscreenLost = false;
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    void el.requestFullscreen().then(() => resume(), () => resume());
  } else {
    resume();
  }
}

function wirePause(): void {
  // Firefox returns undefined from requestPointerLock (no promise to catch);
  // a refused re-lock surfaces ONLY via this event. Re-arm the CLICK-TO-PLAY
  // hint exactly like the promise-reject path in onPlayAgain above.
  document.addEventListener("pointerlockerror", () => {
    if (document.pointerLockElement !== canvas) {
      hudState.paused = false;
      pauseFullscreenLost = false;
      closePause();
      hudState.everLocked = false;
    }
  });
  document.addEventListener("pointerlockchange", () => {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      hudState.everLocked = true;
      hudState.paused = false;
      pauseFullscreenLost = false;
      closePause();
      return;
    }
    // Lost the lock mid-match (ESC, alt-tab): the pause menu, not a bare hint.
    if (inMatch() && hudState.everLocked && !settingsOpen() && !loadoutOpen()) openPauseMenu();
  });
  // FULLSCREEN-EXIT mitten im Match (ESC im Fullscreen beendet Lock UND
  // Fullscreen — Browser-reserviert, nicht abfangbar): Pause-Menü öffnen, falls
  // nicht schon, mit 1-Klick-Rückkehr. Kein Auto-Re-Enter (braucht eine Geste).
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) return;
    // F11-/programmatischer Exit bei gehaltenem Lock: Spiel läuft weiter —
    // keine Pause darüber öffnen. Nur bei verlorenem Lock pausieren.
    if (document.pointerLockElement) return;
    if (inMatch() && !settingsOpen() && !loadoutOpen()) {
      // ESC-Doppel-Event (pointerlockchange + fullscreenchange): Pause ist
      // schon offen, dann nur auf die Fullscreen-Rückkehr-Variante hochstufen.
      if (pauseOpen()) {
        if (!pauseFullscreenLost) openPauseMenu({ fullscreenLost: true });
        return;
      }
      openPauseMenu({ fullscreenLost: true });
    }
  });
}

// ---------------------------------------------------------------- menu wiring

function bindUi(): void {
  document.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => {
    el.addEventListener("click", () => {
      const act = el.dataset.act;
      if (act === "play") launch("bots");
      else if (act === "lobby") launch("host");
      else if (act === "multi") launch("yard");
      else if (act === "settings") openSettings(settingsDeps);
      else if (act === "loadout") openLoadout({ inMatch: false });
    });
  });
  $("callsign-chip")?.addEventListener("click", renameCallsign);
  wireSfx($("menu"));
  // LOADOUT → the game (weapons stream's Game.setLoadout: saved, sent to the
  // server, applied at the next spawn mid-match / at once before it starts).
  window.addEventListener("loadout", (e) => game.setLoadout((e as CustomEvent).detail));
  // The private-match lobby's SETTINGS button (lobby.ts): change settings while you wait.
  window.addEventListener("open-settings", () => openSettings(settingsDeps));
}

async function boot(): Promise<void> {
  hookBootErrors();
  // THE MAP, CONFIRMED: shared/maps resolved it before the sim's module body
  // ran; disagreeing here would mean the sim and the renderer are on two maps.
  lockActiveMap(PAGE_MAP);
  applyPrefs();
  const params = new URLSearchParams(location.search);
  if (params.has("aresqa")) {
    const { installAresQA } = await import("./ares-qa");
    installAresQA(game);
  }
  state.name = rememberedCallsign() || "RECRUIT";
  if (params.has("test")) {
    show("boot", false);
    show("menu", false);
    show("hud", true);
    game.onHud = (s: HudState) => paintHud(game, s, PAGE_MAP);
    game.onRematch = () => hideEndcard();
    const { installTestMode } = await import("./test");
    await installTestMode(game, params);
    return;
  }
  bindUi();
  wirePause();
  // GAMEPAD menus: START pauses/resumes mid-match; with a modal open the D-pad
  // + left stick walk focus and A activates, B goes back. In-match look/move
  // is game.pollGamepad (needs no pointer lock); this loop never fires a gun.
  startPadUiNav({
    isInMatch: () => inMatch(),
    isModalOpen: () => {
      // Every menu-like screen wants the pad (main menu included — it is no
      // modal, but D-pad + A is its only controller path). game.ts's
      // pollGamepad independently skips in-match input while a scope is up.
      if (settingsOpen() || pauseOpen() || loadoutOpen()) return true;
      if (!(document.getElementById("endcard")?.classList.contains("hidden") ?? true)) return true;
      if (lobbyOnScreen()) return true;
      if (document.getElementById("nana-gate") || document.getElementById("nana-full")) return true;
      const menu = document.getElementById("menu");
      return !!menu && !menu.classList.contains("hidden");
    },
    onPauseToggle: () => {
      if (pauseOpen()) resume();
      else if (settingsOpen()) closeSettings();
      else if (loadoutOpen()) closeLoadout();
      else if (inMatch()) openPauseMenu();
    },
    onBack: () => {
      if (settingsOpen()) closeSettings();
      else if (loadoutOpen()) closeLoadout();
      else if (pauseOpen()) resume(); // CoD rule: B backs out of pause = resume.
    },
    // Direct pad shortcuts, contextual: menu home launch/callsign/map, pause
    // loadout/settings. Guarded to exactly one screen each, so the in-match
    // poll (which owns X/Y/LB/RB live) can never double-fire.
    onY: () => {
      if (menuHomeVisible()) fireMenuPad("quick");
      else if (pauseAlone()) openLoadout({ inMatch: true });
    },
    onX: () => {
      if (menuHomeVisible()) fireMenuPad("callsign");
      else if (pauseAlone()) openSettings(settingsDeps);
    },
    onLB: () => {
      if (menuHomeVisible()) fireMenuPad("map-prev");
    },
    onRB: () => {
      if (menuHomeVisible()) fireMenuPad("map-next");
    },
  });
  initMenu(PAGE_MAP, (s) => selectMenuMusic(s.map));
  initMenuMusic(menuSelection().map);
  setCallsignChip(rememberedCallsign());
  show("boot", false);
  show("menu", true);
  // Re-evaluate now the menu is actually visible: the init-time sync above
  // ran while #menu still had `hidden` and parked. Pre-gesture this only
  // arms the track; the first real press starts it.
  startMenuMusic();

  // RESUME WHAT THE PLAYER WAS DOING across a map-change reload.
  const intent = takeIntent(PAGE_MAP);
  const joinCode = params.get("join");
  if (intent) {
    if (intent.kind === "bots") enterBots(intent.mode);
    else if (intent.kind === "host") enterHost(intent.mode, intent.room);
    else if (intent.kind === "yard") enterYard(asModeId(intent.mode));
    else enterInvite(intent.room, true, { mode: intent.mode, wait: intent.wait });
  } else if (joinCode) {
    // AN INVITE LINK LANDS ON THE GATE (confirm the callsign, see the lobby
    // you are joining), then the host's lobby — or the live match.
    enterInvite(joinCode.toUpperCase().slice(0, 16), false);
  } else if (location.hash === "#play" || params.has("play")) {
    // THE DEEP LINK STAYS A DEEP LINK: qa harnesses boot the bot match here.
    state.kind = "bots";
    state.mode = asModeId(params.get("mode"));
    void deploy(false);
  }
}

/**
 * QA HANDLES (read-only use by qa/ui/*.mjs capture scripts): open the screens
 * that need a real pointer-lock loss or a finished match to reach otherwise.
 */
(window as unknown as { __ui: unknown }).__ui = {
  pause: () => openPauseMenu(),
  resume: () => {
    hudState.paused = false;
    pauseFullscreenLost = false;
    closePause();
  },
  endcard: (s0: number, s1: number, board: EndRow[]) => onMatchEnd(s0, s1, board),
  settings: (tab?: "gameplay" | "audio" | "graphics" | "controls") => openSettings(settingsDeps, { tab }),
  loadout: (inMatchFlag = false) => openLoadout({ inMatch: inMatchFlag }),
  state,
};

void boot();
