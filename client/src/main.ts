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
import { LOBBY_RETURN_S, PUBLIC_MODE, PUBLIC_ROLLOVER_S, modeInfo, type ModeId } from "@shared/modes";
import { onPrefs, prefs, reducedMotion } from "./ui/prefs";
import { initMenu, menuBusy, menuSelection, setCallsignChip } from "./ui/menu";
import { openSettings, settingsOpen, type SettingsDeps } from "./ui/settings";
import { loadoutOpen, openLoadout } from "./ui/loadout";
import { closePause, openPause, pauseOpen } from "./ui/pause";
import { hudState, markBenchAttached, paintHud, resetHud } from "./ui/hud";
import { hideEndcard, showEndcard, type EndKind } from "./ui/endcard";
import { goToMap, mapCardUrl, mapLabel, stripTransientParams, takeIntent } from "./ui/flow";
import { uiSfx, wireSfx } from "./ui/sfx";

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
  return prefs().server.trim() || defaultWs();
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
  onPrefs((p, changed) => {
    game.audio.setVol(p.master);
    game.audio.setMix?.(p.effects, p.ui, p.ambience);
    $("hud")?.style.setProperty("--hud-scale", String(p.hudScale));
    document.body.classList.toggle("no-dmgnums", !p.damageNumbers);
    document.documentElement.classList.toggle("reduce-motion", reducedMotion());
    document.documentElement.classList.toggle("full-motion", p.motion === "full");
    fpsOn(p.showFps);
    if (changed.includes("renderScale")) game.resize();
    if (game.opts) {
      game.opts.sens = p.sens;
      game.opts.tac = p.tacSprint;
      game.opts.vol = p.master;
    }
  });
}

// ---------------------------------------------------------------- FPS counter

let fpsRaf = 0;
function fpsOn(on: boolean): void {
  show("fps", on);
  if (!on) {
    cancelAnimationFrame(fpsRaf);
    fpsRaf = 0;
    return;
  }
  if (fpsRaf) return;
  let frames = 0;
  let since = performance.now();
  const tick = (now: number): void => {
    frames++;
    if (now - since >= 500) {
      const el = $("fps");
      if (el) el.textContent = `${Math.round((frames * 1000) / (now - since))} FPS`;
      frames = 0;
      since = now;
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
  hideEndcard();
  detachSpectate(game);
  detachLobby();
  closeGate();
  resetHud();
  show("hud", false);
  show("boot", false);
  show("menu", true);
  menuBusy(false);
  setCallsignChip(rememberedCallsign());
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
function openGate(kind: GateKind, room: string, extra: { mode?: ModeId; auto?: boolean; headline?: string }, onEnter: (r: GateResult) => void): void {
  hideMenus();
  openCallsignGate({
    room,
    kind,
    suggested: state.name,
    wsUrl: wsUrl(),
    newCode: kind === "host" ? freshRoomCode : undefined,
    map: PAGE_MAP,
    mode: extra.mode,
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

/** PRIVATE MATCH: create a lobby on this page's map with the picked mode. */
function enterHost(mode: ModeId): void {
  state.kind = "host";
  openGate("host", freshRoomCode(), { mode, auto: true, headline: headline(mode) }, (r) => {
    state.name = r.name;
    state.room = r.room;
    state.mode = (r.mode ?? mode) as ModeId;
    void deploy(true, r.phase, r.spectate);
  });
}

/** An invite link (?join=CODE), or an invite resumed after a map reload. */
function enterInvite(room: string, auto: boolean): void {
  state.kind = "invite";
  state.room = room;
  openGate("invite", room, { auto }, (r) => {
    state.name = r.name;
    state.room = r.room;
    state.mode = (r.mode ?? "tdm") as ModeId;
    void deploy(true, r.phase, r.spectate);
  });
}

/** PUBLIC MATCH: the always-on room of this map (pinned to its team mode). */
function enterYard(): void {
  state.kind = "yard";
  state.room = "";
  state.mode = PUBLIC_MODE;
  openGate("yard", "", { auto: true, headline: headline(PUBLIC_MODE) }, (r) => {
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
  const mode = kind === "yard" ? PUBLIC_MODE : sel.mode;
  if (sel.map !== PAGE_MAP) {
    menuBusy(true);
    uiSfx("confirm");
    const intent = kind === "bots" ? { kind, map: sel.map, mode } : kind === "host" ? { kind, map: sel.map, mode } : { kind, map: sel.map };
    showLoading(sel.map, mode, kind);
    goToMap(sel.map, intent as Parameters<typeof goToMap>[1], PAGE_MAP);
    return;
  }
  if (kind === "bots") enterBots(mode);
  else if (kind === "host") enterHost(mode);
  else enterYard();
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
      hudState.everLocked = false;
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
      mode: state.mode,
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
            show("hud", true);
            hideEndcard();
          },
          onRefused: (msg) => console.warn("lobby refused:", msg),
          onLeave: toMenu,
          // The match ended and the room dropped back to its pre-game lobby.
          onReturn: () => {
            hideEndcard();
            closePause();
            show("hud", false);
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
  if (document.pointerLockElement) document.exitPointerLock();
  const kind: EndKind = !state.online ? "bots" : state.room ? "lobby" : "yard";
  showEndcard({
    mode: state.mode,
    map: PAGE_MAP,
    s0,
    s1,
    board,
    kind,
    // feel stream: the server's clock started at the match end, before the final killcam played.
    nextIn: Math.max(1, (kind === "lobby" ? LOBBY_RETURN_S : PUBLIC_ROLLOVER_S) - game.sinceEndS()),
    onPlayAgain: () => {
      game.stop();
      hideEndcard();
      void deploy(false);
    },
    onMenu: toMenu,
  });
}

// ---------------------------------------------------------------- pause

function inMatch(): boolean {
  return game.running && !$("hud").classList.contains("hidden") && $("endcard").classList.contains("hidden") && !lobbyOnScreen() && !game.fkc; // feel stream: not over the final killcam
}

function openPauseMenu(): void {
  const info = modeInfo(PAGE_MAP, state.mode);
  hudState.paused = true;
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
      ffa: state.mode === "ffa",
    },
    invite: state.online && state.room ? inviteLink(state.room, PAGE_MAP) : undefined,
    online: state.online,
    onResume: resume,
    onLoadout: () => openLoadout({ inMatch: true }),
    onSettings: () => openSettings(settingsDeps),
    onLeave: () => {
      uiSfx("back");
      toMenu();
    },
  });
}

function resume(): void {
  const r = canvas.requestPointerLock() as unknown;
  if (r && typeof (r as Promise<void>).catch === "function") {
    (r as Promise<void>).catch(() => {
      // Chrome refuses a re-lock for ~1 s after ESC; the next click works.
      uiSfx("error");
    });
  }
}

function wirePause(): void {
  document.addEventListener("pointerlockchange", () => {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      hudState.everLocked = true;
      hudState.paused = false;
      closePause();
      return;
    }
    // Lost the lock mid-match (ESC, alt-tab): the pause menu, not a bare hint.
    if (inMatch() && hudState.everLocked && !settingsOpen() && !loadoutOpen()) openPauseMenu();
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
  initMenu(PAGE_MAP, () => undefined);
  setCallsignChip(rememberedCallsign());
  show("boot", false);
  show("menu", true);

  // RESUME WHAT THE PLAYER WAS DOING across a map-change reload.
  const intent = takeIntent(PAGE_MAP);
  const joinCode = params.get("join");
  if (intent) {
    if (intent.kind === "bots") enterBots(intent.mode);
    else if (intent.kind === "host") enterHost(intent.mode);
    else if (intent.kind === "yard") enterYard();
    else enterInvite(intent.room, true);
  } else if (joinCode) {
    // AN INVITE LINK LANDS ON THE GATE (confirm the callsign, see the lobby
    // you are joining), then the host's lobby — or the live match.
    enterInvite(joinCode.toUpperCase().slice(0, 16), false);
  } else if (location.hash === "#play" || params.has("play")) {
    // THE DEEP LINK STAYS A DEEP LINK: qa harnesses boot the bot match here.
    state.kind = "bots";
    state.mode = (params.get("mode") === "ffa" ? "ffa" : "tdm") as ModeId;
    void deploy(false);
  }
}

/**
 * QA HANDLES (read-only use by qa/ui/*.mjs capture scripts): open the screens
 * that need a real pointer-lock loss or a finished match to reach otherwise.
 */
(window as unknown as { __ui: unknown }).__ui = {
  pause: () => openPauseMenu(),
  resume: () => closePause(),
  endcard: (s0: number, s1: number, board: EndRow[]) => onMatchEnd(s0, s1, board),
  settings: (tab?: "gameplay" | "audio" | "graphics" | "controls") => openSettings(settingsDeps, { tab }),
  loadout: (inMatchFlag = false) => openLoadout({ inMatch: inMatchFlag }),
  state,
};

void boot();
