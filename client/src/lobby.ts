/**
 * client/src/lobby.ts — THE PRE-GAME LOBBY, the callsign gate, and the
 * spectator state.
 * ===========================================================================
 *
 * WHAT THIS OWNS
 *
 *   1. The CALLSIGN GATE: the screen anybody arriving at ?join=CODE (and the
 *      host, from CREATE FFA LOBBY) passes through before they enter a lobby.
 *      The name is checked SERVER-SIDE (server/moderation.ts) over a throwaway
 *      WebSocket before a single byte of game is booted, so a refused name costs
 *      one round trip and gets a sentence explaining itself, never a dead end
 *      and never a silent rewrite.
 *   2. The PRE-GAME LOBBY screen: room code, the invite link for THIS deployment,
 *      the live roster with slot numbers / HOST / YOU / SPECTATOR, the bench, and
 *      the host's START GAME button.
 *   3. The in-match SPECTATOR plate and the YOU'RE IN promotion card.
 *
 * WHY IT IS BUILT LIKE THIS
 *
 * The DOM is created in JS and the CSS is a separate file imported here, because
 * index.html and style.css are being edited by other workers in this same tree
 * and a shared-file conflict would take the whole game down rather than one
 * screen. Nothing here reaches into game.ts either: the only contract with the
 * game is three fields (`net`, `you`, `keys`), declared below as GameLike, so
 * this file cannot be broken by (or break) whatever the renderer is doing.
 *
 * HOW IT HEARS THE SERVER — and the one performance rule that matters
 *
 * The lobby listens on the SAME socket the match runs on, via
 * `addEventListener("message")` alongside game.ts's own `onmessage`. That means
 * every server message is offered to this module too, and blindly JSON.parse-ing
 * all of them would double the decode cost of every snapshot on the main thread
 * for the whole match — 32 parses a second of the biggest payload the game has,
 * to read a field this file never uses. So snapshots and pongs are rejected by a
 * string prefix compare before any parse happens (the server writes `t` first);
 * what is left is the handful of lobby messages, which arrive only when something
 * actually changed. Phase truth also rides every snapshot (Snapshot.phase) for
 * whoever needs it there; this module gets it from the change messages.
 */

// Styles: client/src/ui/screens.css (the design system) — no private palette here.
import type { LobbyMember, LobbyState, NameCheck, ServerMsg } from "@shared/protocol";
import { MAX_PLAYABLE, MAX_SPECTATORS, type MatchPhase } from "@shared/matchphase";
import { MAP_IDS, activeMap, isMapId, readMapPref, withMapQuery } from "@shared/maps";
import { asModeId, modeInfo, modesFor, type ModeId } from "@shared/modes";
import { GUN_KILL_OPTIONS, asGunKills, gunGoal } from "@shared/gungame";
import { goToMap, mapCardUrl, mapLabel, type Intent } from "./ui/flow";
import { uiSfx, wireSfx } from "./ui/sfx";
import { selectMenuMusic } from "./menu-music";
import { renderKeyline } from "./ui/keys";
import { actionOf } from "./ui/keybinds";
import { closeSettings, settingsOpen } from "./ui/settings";

/**
 * The whole of this module's dependency on the game object. Three fields, so the
 * lobby and the renderer can be worked on at the same time without touching each
 * other's files.
 */
export type GameLike = {
  net: WebSocket | null;
  you: string;
  keys: { fire: boolean; melee: boolean };
  /** The live roster off the snapshots — read only for team columns in the lobby. */
  players?: Map<string, { team: number }>;
  /** The room's GUN GAME kills per gun, for the HUD. */
  gunKills?: number;
};

export type GateResult = {
  /** The name the SERVER accepted. Not necessarily what was typed. */
  name: string;
  /** The room to join — may differ from the requested one on a code collision. */
  room: string;
  /** Playable seats were already full at check time. */
  spectate: boolean;
  /** The room's phase at check time: "live" means skip the lobby screen. */
  phase: MatchPhase;
  /**
   * The mode this seat is walking into: the host's toggle pick on the host
   * door, the room's real mode (namecheck) on an invite. Absent on the yard
   * and bot doors, which own their modes.
   */
  mode?: ModeId;
  /**
   * The map this seat is walking into — the host's pick on the host door, the
   * room's real map (name check) on an invite. Always equal to the map this
   * page has locked by the time the gate resolves: a disagreement reloads the
   * page instead of returning, so this field can never contradict `activeMap()`.
   */
  map?: string;
};

/**
 * WHICH DOOR THIS IS — and it is the only thing that differs between them.
 *
 * Every way into the game passes through this one screen, because a name that
 * only some entrances ask for is a roster full of RECRUIT, RECRUIT 2, RECRUIT 3.
 * The four doors need four sentences and two rules, and one field carries all of
 * them (see GATE_DOOR) rather than four booleans that can contradict each other:
 *
 *   host    CREATE FFA LOBBY — this player picks the code and takes the chair.
 *   invite  ?join=CODE — somebody's lobby, which may have closed. A code that
 *           names no room is a broken invite and gets the LOBBY NOT FOUND card.
 *   yard    JOIN SERVER — the public 24/7 match. There is no invite and no code,
 *           so "not found" is meaningless here and must never fire.
 *   bots    DEPLOY · VS BOTS — a match that runs entirely on this machine. It is
 *           the one door that must still open with the server unreachable, so a
 *           check that cannot reach it takes the typed name (nobody else will
 *           ever see it) instead of dead-ending the offline player.
 */
export type GateKind = "host" | "invite" | "yard" | "bots" | "rename";

/**
 * One row per door: its button, its eyebrow, its title, and the two rules
 * (does a dead room code matter; may it open with the server unreachable).
 * `rename` is the callsign chip on the menu — a name check and nothing else.
 */
const GATE_DOOR: Record<GateKind, { cta: string; title: string; busy: string; eyebrow: (room: string) => string; needsRoom: boolean; offlineOk: boolean }> = {
  host: { cta: "CREATE LOBBY", title: "PRIVATE MATCH", busy: "CREATING LOBBY", eyebrow: () => "NEW LOBBY", needsRoom: false, offlineOk: false },
  invite: { cta: "JOIN LOBBY", title: "JOIN LOBBY", busy: "JOINING", eyebrow: (r) => `PRIVATE MATCH · ${r}`, needsRoom: true, offlineOk: false },
  yard: { cta: "JOIN MATCH", title: "PUBLIC MATCH", busy: "JOINING", eyebrow: () => "PUBLIC MATCH", needsRoom: false, offlineOk: false },
  bots: { cta: "PLAY", title: "QUICK PLAY", busy: "CHECKING", eyebrow: () => "QUICK PLAY · OFFLINE", needsRoom: false, offlineOk: true },
  rename: { cta: "SAVE CALLSIGN", title: "CALLSIGN", busy: "CHECKING", eyebrow: () => "PROFILE", needsRoom: false, offlineOk: true },
};

export type GateOpts = {
  room: string;
  kind: GateKind;
  suggested: string;
  wsUrl: string;
  /** A fresh room code, for the rare case the generated one is already live. */
  newCode?: () => string;
  /** Host door: the map + mode picked in the menu (the page is already on the map). */
  map?: string;
  mode?: ModeId;
  /**
   * Invite door, following a lobby its host moved to this map: the room may not
   * be open here YET (the host's page is still loading). Wait for it instead of
   * calling the code dead; if the host never arrives, open it ourselves.
   */
  waitForHost?: boolean;
  /** "TEAM DEATHMATCH 5v5 · SHIPMENT" — the eyebrow line under the door's title. */
  headline?: string;
  /**
   * Submit immediately with the remembered callsign instead of waiting on the
   * field (a returning player pressing PRIVATE MATCH / PUBLIC MATCH). The card
   * shows progress; a refusal reveals the field with the reason.
   */
  auto?: boolean;
  sfx?: (key: string) => void;
  onCancel: () => void;
  onEnter: (r: GateResult) => void;
};

export type LobbyHooks = {
  /** The countdown has begun: close the lobby, bring the HUD up. */
  onStart: (startAt: number) => void;
  /** The server refused this seat (LOBBY FULL, or any other `err`). */
  onRefused: (msg: string) => void;
  /** The player pressed LEAVE LOBBY. */
  onLeave: () => void;
  /** Open the settings modal while waiting in the lobby. */
  onSettings?: () => void;
  /** The match ended and the room dropped back to its pre-game lobby. */
  onReturn?: () => void;
  /** The host changed the lobby's mode (the room's mode, from the roster). */
  onMode?: (mode: ModeId) => void;
  sfx?: (key: string) => void;
};

// ---------------------------------------------------------------------------
// URLs — the two places a subpath deploy gets broken
// ---------------------------------------------------------------------------

/**
 * The deployed client uses our Hetzner game server by default. The dev client
 * on :5173 proxies sockets through its own origin to the local hub on :8787.
 */
export function defaultWs(): string {
  if (location.port === "5173") return withMapQuery(`ws://${location.host}/ws`, activeMap().id);
  // `?map=<id>`: the server is a hub of one process per map (server/hub.ts)
  // and this is how the socket lands on the process simulating the map THIS
  // page locked. Without it a dust2 page was handed a Shipment room — drawn
  // dust2, resolved against containers: walk-through walls, invisible floors.
  return withMapQuery("wss://kong.netsplit.in/ws", activeMap().id);
}

/**
 * THE INVITE LINK, and why it is not `location.origin + "?join="`.
 *
 * An invite built from the origin alone (https://host/?join=NANA-7K2Q)
 * drops the path the page is actually served from; carrying the whole
 * served path over keeps the link working wherever the game is mounted:
 *
 *   http://localhost:5173/            -> http://localhost:5173/?join=CODE
 *   http://localhost:8765/?map=x      -> http://localhost:8765/?join=CODE
 *   https://cnvs.dev/kong/            -> https://cnvs.dev/kong/?join=CODE
 *   https://cnvs.dev/kong/index.html  -> https://cnvs.dev/kong/?join=CODE
 *
 * A trailing document name is dropped and a missing trailing slash is added, so
 * the link is always the clean directory URL of this deployment — the same form
 * the player typed to get here, which is the only form the server is guaranteed
 * to serve. Existing query and hash are dropped: `?join` is the only parameter an
 * invite may carry, and forwarding a stale one (`?test`, `?classic`) would hand a
 * friend a different build of the game.
 */
export function inviteLink(code: string, map?: string): string {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/[^/]*\.[a-z0-9]+$/i, "/");
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.searchParams.set("join", code);
  // The room's MAP rides the link: `readMapPref` honours `?map=` above the
  // saved preference, so the guest's page locks the room's map before it dials
  // (server/hub.ts owns one process per map; the room lives in one of them).
  const m = map ?? activeMap().id;
  if (isMapId(m)) u.searchParams.set("map", m);
  return u.toString();
}

/** NANA-XXXX. The code a player reads out loud, so no ambiguous glyphs. */
export function freshRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return `NANA-${s}`;
}

// ---------------------------------------------------------------------------
// The name check — one throwaway socket, before anything is booted
// ---------------------------------------------------------------------------

/**
 * THE CHECK WAITS FOR A COLD SERVER — the "make the lobby twice" bug.
 *
 * The first lobby on a map after a deploy (or after a child restart) lands on
 * a hub whose map process is still importing the sim and warming it up. The
 * hub holds the upgrade for up to 30 s (server/hub.ts); this used to give up
 * after 9 s and print an error, so the FIRST press always failed and the
 * second always worked. Now: one attempt may take as long as the hub holds,
 * failed transports retry with backoff inside a 60 s budget, and the card
 * says "STARTING SERVER" instead of an error while it waits. A server VERDICT
 * (including a refused name) is never retried.
 */
const CHECK_BUDGET_MS = 60000;
const CHECK_ATTEMPT_MS = 35000;

/**
 * `offline` separates THE SERVER DID NOT ANSWER from THE SERVER SAID NO, which
 * are the same `ok: false` on the wire and must not be the same outcome: a
 * refused name has to be retyped, and an unreachable server must still let the
 * offline bot match (GATE_DOOR.bots) through on the name as typed.
 */
type CheckResult = NameCheck & { offline?: boolean };

/** Progress line on the gate card while a check is in flight. */
let checkStatus: ((text: string) => void) | null = null;

/**
 * Ask the server what this callsign will be. Never rejects: every failure path
 * comes back as a refusal with a sentence the gate can print.
 *
 * `quick`: the offline bot door. It only wants the server's opinion if the
 * server is already there — it must never sit on a cold start to play a
 * match that runs entirely in this tab.
 */
function checkCallsign(wsUrl: string, name: string, room: string, mapHint?: string, quick = false, mode?: ModeId): Promise<CheckResult> {
  return checkCallsignWithRetry(wsUrl, name, room, mapHint, quick, mode);
}

async function checkCallsignWithRetry(wsUrl: string, name: string, room: string, mapHint?: string, quick = false, mode?: ModeId): Promise<CheckResult> {
  const started = Date.now();
  const deadline = started + (quick ? 4000 : CHECK_BUDGET_MS);
  // "Connecting…" at once; "starting server…" if it is taking a while.
  checkStatus?.("CONNECTING TO SERVER");
  const slow = window.setTimeout(() => checkStatus?.("STARTING SERVER — THE FIRST MATCH ON A MAP TAKES A FEW SECONDS"), 2500);
  try {
    let attempt = 0;
    for (;;) {
      const left = deadline - Date.now();
      const result = await checkCallsignOnce(wsUrl, name, room, mapHint, Math.min(quick ? 4000 : CHECK_ATTEMPT_MS, Math.max(500, left)), mode);
      if (!result.offline || quick) return result;
      attempt++;
      const wait = Math.min(4000, 600 * attempt);
      if (Date.now() + wait + 500 > deadline) return result;
      checkStatus?.(`SERVER NOT READY — RETRYING (${attempt})`);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  } finally {
    clearTimeout(slow);
  }
}

function checkCallsignOnce(wsUrl: string, name: string, room: string, mapHint: string | undefined, timeoutMs: number, mode?: ModeId): Promise<CheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const finish = (r: CheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ t: "namecheck", ok: false, name: "", reason: "THE GAME SERVER DID NOT ANSWER", offline: true }),
      timeoutMs,
    );
    try {
      // A hint FORCES the map (the cross-map room lookup asks a process other
      // than this page's); otherwise the URL's own pin, if any, stands.
      ws = new WebSocket(mapHint ? withMapQuery(wsUrl, mapHint, true) : withMapQuery(wsUrl, activeMap().id));
    } catch {
      finish({ t: "namecheck", ok: false, name: "", reason: "CANNOT REACH THE GAME SERVER", offline: true });
      return;
    }
    // The yard names no room: the picked mode selects which always-live yard
    // this check (and the join after it) is about (server/index.ts yardKey).
    ws.onopen = () => ws?.send(JSON.stringify(mode ? { t: "checkname", name, room, mode } : { t: "checkname", name, room }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        if (msg.t === "namecheck") finish(msg);
      } catch {
        /* not for us */
      }
    };
    ws.onerror = () => finish({ t: "namecheck", ok: false, name: "", reason: "CANNOT REACH THE GAME SERVER", offline: true });
    ws.onclose = () => finish({ t: "namecheck", ok: false, name: "", reason: "THE CONNECTION CLOSED", offline: true });
  });
}

// ---------------------------------------------------------------------------
// DOM — built once, on demand
// ---------------------------------------------------------------------------

const NAME_KEY = "banana.callsign";

/** Persist the callsign the server accepted. */
function rememberName(name: string): void {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
}

/** The last callsign the SERVER accepted from this browser, or "". */
export function rememberedCallsign(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

type Ui = {
  gate: HTMLElement;
  gateEyebrow: HTMLElement;
  gateTitle: HTMLElement;
  gateField: HTMLElement;
  gateInput: HTMLInputElement;
  gateWho: HTMLElement;
  gateNote: HTMLElement;
  gateStatus: HTMLElement;
  gateStatusText: HTMLElement;
  gateErr: HTMLElement;
  gateEnter: HTMLButtonElement;
  gateBack: HTMLButtonElement;
  lobbyEyebrow: HTMLElement;
  full: HTMLElement;
  fullEyebrow: HTMLElement;
  fullNote: HTMLElement;
  fullTitle: HTMLElement;
  fullRetry: HTMLButtonElement;
  fullBack: HTMLButtonElement;
  lobby: HTMLElement;
  mapCard: HTMLElement;
  mapName: HTMLElement;
  rules: HTMLElement;
  code: HTMLElement;
  link: HTMLInputElement;
  copy: HTMLButtonElement;
  count: HTMLElement;
  roster: HTMLElement;
  botnote: HTMLElement;
  benchPanel: HTMLElement;
  speccount: HTMLElement;
  specs: HTMLElement;
  start: HTMLButtonElement;
  wait: HTMLButtonElement;
  hostnote: HTMLElement;
  settings: HTMLButtonElement;
  leave: HTMLButtonElement;
  setup: HTMLElement;
  modeSeg: HTMLElement;
  gunLabel: HTMLElement;
  gunSeg: HTMLElement;
  mapRow: HTMLElement;
  shuffle: HTMLButtonElement;
};

let ui: Ui | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The three screens, on the design system (ui/tokens.css + ui/screens.css).
 * Ids are the contract the QA probes read (#nana-gate, #nana-name,
 * #nana-enter, #nana-full, #nana-retry, #nana-lobby, #nana-code, #nana-link,
 * #nana-copy, #nana-roster .nana-row .nana-name, #nana-start, #nana-wait,
 * #nana-settings, #nana-in…);
 * classes are free to change.
 */
function buildUi(): Ui {
  const root = document.getElementById("app") ?? document.body;

  // ---- callsign gate: one card for every door
  const gate = el("div", "nana-screen hidden");
  gate.id = "nana-gate";
  gate.append(el("div", "nana-veil"));
  const card = el("div", "nana-card");
  const gateEyebrow = el("p", "eyebrow nana-eyebrow", "");
  const gateTitle = el("h2", "nana-h2", "CALLSIGN");
  const gateWho = el("p", "nana-who hidden");
  const gateField = el("label", "nana-field");
  gateField.append(el("span", "nana-label", "CALLSIGN"));
  const gateInput = el("input", "field");
  gateInput.id = "nana-name";
  gateInput.maxLength = 16;
  gateInput.autocomplete = "off";
  gateInput.spellcheck = false;
  gateInput.setAttribute("aria-label", "callsign");
  gateField.append(gateInput);
  const gateNote = el("p", "nana-note", GATE_NOTE);
  const gateStatus = el("div", "nana-status hidden");
  const gateStatusText = el("span");
  gateStatus.append(el("i", "spin"), gateStatusText);
  const gateErr = el("p", "nana-err hidden");
  gateErr.id = "nana-gate-err";
  const actions = el("div", "nana-card-actions");
  const gateEnter = el("button", "btn btn--primary nana-cta", "CONTINUE");
  gateEnter.id = "nana-enter";
  gateEnter.type = "button";
  gateEnter.dataset.sfx = "confirm";
  const gateBack = el("button", "btn btn--ghost nana-quiet", "BACK");
  gateBack.type = "button";
  gateBack.dataset.sfx = "back";
  actions.append(gateEnter, gateBack);
  card.append(gateEyebrow, gateTitle, gateWho, gateField, gateNote, gateStatus, gateErr, actions);
  gate.append(card);

  // ---- notice card: lobby full / not found / can't connect / watch offer
  const full = el("div", "nana-screen hidden");
  full.id = "nana-full";
  full.append(el("div", "nana-veil"));
  const fullCard = el("div", "nana-card");
  const fullEyebrow = el("p", "eyebrow nana-eyebrow", "NO SEATS LEFT");
  const fullTitle = el("h2", "nana-h2", "LOBBY FULL");
  const fullNote = el("p", "nana-note");
  const fullActions = el("div", "nana-card-actions");
  const fullRetry = el("button", "btn btn--primary nana-cta", "TRY AGAIN");
  fullRetry.id = "nana-retry";
  fullRetry.type = "button";
  fullRetry.dataset.sfx = "confirm";
  const fullBack = el("button", "btn btn--ghost nana-quiet", "MAIN MENU");
  fullBack.type = "button";
  fullBack.dataset.sfx = "back";
  fullActions.append(fullRetry, fullBack);
  fullCard.append(fullEyebrow, fullTitle, fullNote, fullActions);
  full.append(fullCard);

  // ---- the private match lobby (CoD private-match anatomy: roster by team,
  // the map/mode card, the invite, the host's START)
  const lobby = el("div", "nana-screen hidden");
  lobby.id = "nana-lobby";
  lobby.append(el("div", "nana-veil"));
  const wrap = el("div", "nana-wrap");

  const top = el("header", "nana-top");
  const topL = el("div", "nana-top-l");
  topL.append(el("h1", "nana-title", "PRIVATE MATCH"));
  const lobbyEyebrow = el("p", "eyebrow nana-eyebrow", "");
  topL.append(lobbyEyebrow);
  const topR = el("div", "nana-top-l");
  const count = el("span", "eyebrow");
  count.id = "nana-count";
  count.textContent = `0 / ${MAX_PLAYABLE} PLAYERS`;
  topR.append(count);
  top.append(topL, topR);

  const grid = el("div", "nana-grid");
  const left = el("section", "nana-col");
  const roster = el("div", "nana-teams");
  roster.id = "nana-roster";
  const botnote = el("p", "nana-botnote");
  botnote.id = "nana-botnote";
  const benchPanel = el("div", "nana-team nana-bench hidden");
  const benchHead = el("header");
  benchHead.append(el("b", undefined, "SPECTATORS"));
  const speccount = el("i");
  speccount.id = "nana-speccount";
  speccount.textContent = `0 / ${MAX_SPECTATORS}`;
  benchHead.append(speccount);
  const specs = el("ol", "nana-list");
  specs.id = "nana-specs";
  benchPanel.append(benchHead, specs);

  // THE INVITE BOX lives in the roster column, between the teams and the
  // spectator bench: the right rail (map card + mode/map + actions) is already
  // the tallest thing on the screen and pushed its own buttons out of view on a
  // 1080p-class viewport, while the left column has room to spare.
  const inviteBox = el("div", "nana-box");
  const codeRow = el("div", "nana-code-row");
  codeRow.append(el("span", "nana-label", "LOBBY CODE"));
  const code = el("b", "nana-code");
  code.id = "nana-code";
  code.textContent = "—";
  codeRow.append(code);
  const inviteRow = el("div", "nana-invite-row");
  const link = el("input", "field");
  link.id = "nana-link";
  link.readOnly = true;
  link.setAttribute("aria-label", "invite link");
  const copy = el("button", "btn btn--sm nana-copy", "COPY INVITE");
  copy.id = "nana-copy";
  copy.type = "button";
  copy.dataset.sfx = "off";
  inviteRow.append(link, copy);
  inviteBox.append(codeRow, el("span", "nana-label", "INVITE LINK — ANYONE WITH IT JOINS THIS LOBBY"), inviteRow);
  left.append(roster, botnote, inviteBox, benchPanel);

  const right = el("aside", "nana-side");
  const mapCard = el("div", "nana-mapcard");
  const mapEyebrow = el("p", "eyebrow nana-eyebrow", "");
  const mapName = el("b", undefined, "");
  mapCard.append(mapEyebrow, mapName);
  const rules = el("p", "nana-rules");
  // HOST SETUP: mode and map change from right here (lobbyset), no new lobby.
  const setup = el("div", "nana-box nana-setup hidden");
  const modeSeg = el("div", "seg seg--wide seg--sm");
  modeSeg.setAttribute("role", "radiogroup");
  modeSeg.setAttribute("aria-label", "Mode");
  const mapRow = el("div", "nana-maps");
  mapRow.setAttribute("role", "radiogroup");
  mapRow.setAttribute("aria-label", "Map");
  // GUN GAME kills per gun (shown while the mode is GUN GAME).
  const gunLabel = el("span", "nana-label", "KILLS PER GUN");
  const gunSeg = el("div", "seg seg--wide seg--sm");
  gunSeg.setAttribute("role", "radiogroup");
  gunSeg.setAttribute("aria-label", "Kills per gun");
  setup.append(el("span", "nana-label", "MODE"), modeSeg, gunLabel, gunSeg, el("span", "nana-label", "MAP — EVERYONE MOVES WITH THE LOBBY"), mapRow);
  const acts = el("div", "nana-actions");
  const shuffle = el("button", "btn btn--sm nana-shuffle hidden", "SHUFFLE SEATS & TEAMS");
  shuffle.id = "nana-shuffle";
  shuffle.type = "button";
  shuffle.dataset.sfx = "confirm";
  shuffle.title = "Re-deal every seat but yours: who plays, who watches, and the teams";
  const start = el("button", "btn btn--primary nana-cta hidden", "START MATCH");
  start.id = "nana-start";
  start.type = "button";
  start.dataset.sfx = "confirm";
  const wait = el("button", "nana-wait hidden", "<i></i> WAITING FOR THE HOST");
  wait.id = "nana-wait";
  wait.type = "button";
  wait.disabled = true;
  wait.dataset.sfx = "off";
  const hostnote = el("p", "nana-hostnote hidden");
  hostnote.id = "nana-hostnote";
  const leave = el("button", "btn btn--ghost nana-quiet", "LEAVE LOBBY");
  leave.type = "button";
  leave.dataset.sfx = "back";
  const settings = el("button", "btn", "SETTINGS");
  settings.id = "nana-settings";
  settings.type = "button";
  acts.append(start, shuffle, wait, hostnote, settings, leave);
  right.append(mapCard, rules, setup, acts);
  grid.append(left, right);

  const foot = el("footer", "nana-foot");
  const keys = el("div", "keyline");
  renderKeyline(keys);
  foot.append(keys, el("span", "eyebrow", "EMPTY SEATS FILL WITH BOTS WHEN THE HOST STARTS"));
  wrap.append(top, grid, foot);
  lobby.append(wrap);

  root.append(gate, full, lobby);
  for (const n of [gate, full, lobby]) wireSfx(n);

  return {
    gate,
    gateEyebrow,
    gateTitle,
    gateField,
    gateInput,
    gateWho,
    gateNote,
    gateStatus,
    gateStatusText,
    gateErr,
    gateEnter,
    gateBack,
    lobbyEyebrow,
    full,
    fullEyebrow,
    fullNote,
    fullTitle,
    fullRetry,
    fullBack,
    lobby,
    mapCard,
    mapName,
    rules,
    code,
    link,
    copy,
    count,
    roster,
    botnote,
    benchPanel,
    speccount,
    specs,
    start,
    wait,
    hostnote,
    settings,
    leave,
    setup,
    modeSeg,
    gunLabel,
    gunSeg,
    mapRow,
    shuffle,
  };
}

function dom(): Ui {
  if (!ui) ui = buildUi();
  return ui;
}

// ---------------------------------------------------------------------------
// Diagnostics — what the QA probes read instead of guessing from pixels
// ---------------------------------------------------------------------------

type Diag = {
  screen: "none" | "gate" | "lobby" | "full";
  phase: MatchPhase;
  startAt: number;
  spectator: boolean;
  you: string;
  room: string;
  /** The map the SERVER says this room runs — what a QA probe asserts on so a
   *  two-browser map test reads a fact instead of guessing from pixels. */
  map: string;
  /**
   * The map THIS PAGE actually built its sim out of. Deliberately a separate
   * field from `map` above: the whole class of bug the map-on-the-wire exists
   * to kill is these two disagreeing, and a diagnostic that reported one number
   * for both could not see it. They are equal on every healthy client.
   *
   * READ LAZILY (a getter on `diag`) — see the note there.
   */
  readonly clientMap: string;
  host: string;
  players: LobbyMember[];
  spectators: LobbyMember[];
  link: string;
  lastError: string;
  /** Which door the gate is standing in — see GateKind. */
  kind: GateKind;
  /** What the card is offering, when one is up: retry, create, or watch. */
  fullAction: "retry" | "create" | "watch";
  /**
   * THE PROMOTION MOMENT, stamped when the YOU'RE IN card is actually built.
   *
   * A card that lives 2.7 s and then removes itself is not something a probe can
   * reliably catch by polling the DOM — a page drawing at 1-2 fps under a
   * software rasteriser can sleep through the whole window. This is the fact the
   * card is made of, recorded where it cannot be missed: how many promotions this
   * client has had, the slot it was given, and the sub-line that was printed.
   */
  promotions: number;
  youreIn: { at: number; slot: number; sub: string } | null;
  /** The gate's progress line while a check is in flight ("STARTING SERVER…"). */
  status: string;
};

const diag: Diag = {
  screen: "none",
  map: "",
  /**
   * A GETTER, AND THE MODULE BODY IS EXACTLY WHY.
   *
   * This used to be `clientMap: activeMap().id` — evaluated when lobby.ts was
   * LINKED. `activeMap()` is not a read: the first call resolves the map id,
   * builds the whole MapDef (on dust2 that is 3,144 colliders parsed out of the
   * preloaded JSON), points the broadphase at it and freezes the answer for the
   * life of the process. Doing that from a diagnostic's initialiser meant the
   * map was locked by whichever module the bundler happened to link first, in
   * service of a field a QA probe reads a few seconds later — and it put
   * lobby.ts in the set of modules `shared/maps/index.ts` has to keep its
   * top-level-await ahead of, for no gameplay reason at all.
   *
   * As a getter it answers at READ time, when `boot()` has long since called
   * `lockActiveMap` and the answer is the one the renderer is drawing.
   * `page.evaluate(() => window.__lobby)` serialises own enumerable
   * properties, so the probes see it exactly as before.
   */
  get clientMap(): string {
    return activeMap().id;
  },
  phase: "pregame",
  startAt: 0,
  spectator: false,
  you: "",
  room: "",
  host: "",
  players: [],
  spectators: [],
  link: "",
  lastError: "",
  kind: "invite",
  fullAction: "retry",
  promotions: 0,
  youreIn: null,
  status: "",
};

(window as unknown as { __lobby: Diag }).__lobby = diag;

// ---------------------------------------------------------------------------
// The callsign gate
// ---------------------------------------------------------------------------

let gateOpts: GateOpts | null = null;

const GATE_NOTE = "2–16 CHARACTERS. THIS IS THE NAME EVERYONE IN THE MATCH SEES.";

/**
 * MAKE THIS PAGE BE ON `want`, RELOADING IF IT HAS TO. Returns true when it
 * started a reload, in which case the caller must stop doing anything else.
 *
 * ONE PROCESS IS ONE MAP: the sim built its colliders, nade fence and nav
 * graph from this page's map before this screen existed, so a room on another
 * map means this page has to BECOME that map. The navigation now carries an
 * INTENT (ui/flow.ts) instead of leaning on `?join=` surviving the reload:
 * the new page resumes the same door on its first frame, the callsign is
 * already saved, and the URL is clean (no stale ?join / ?play riding along).
 */
function applyGateMap(want: string, intent: Intent | null): boolean {
  if (!isMapId(want) || want === readMapPref()) return false;
  return goToMap(want, intent, activeMap().id);
}

/** What the refusal card's primary button will do — see showFull. */
let fullAction: "retry" | "create" | "watch" = "retry";
/** How long a lobby's guests wait for its host to re-open it on the new map. */
const HOST_WAIT_MS = 40_000;
/** Set by OPEN IT ANYWAY; consumed by the submit it authorises. */
let forceCreate = false;

export function openCallsignGate(opts: GateOpts): void {
  const d = dom();
  gateOpts = opts;
  entered = false;
  pendingEnter = null;
  wireButtons();
  diag.screen = "gate";
  diag.room = opts.room;
  diag.kind = opts.kind;
  diag.status = "";
  const door = GATE_DOOR[opts.kind];
  d.gateEyebrow.textContent = opts.headline ? `${door.eyebrow(opts.room)} · ${opts.headline}` : door.eyebrow(opts.room);
  d.gateTitle.textContent = door.title;
  d.gateNote.textContent = GATE_NOTE;
  d.gateErr.classList.add("hidden");
  d.gateEnter.disabled = false;
  d.gateEnter.textContent = door.cta;
  const remembered = rememberedCallsign();
  d.gateInput.value = remembered || (opts.suggested === "RECRUIT" ? "" : opts.suggested);
  d.gateInput.placeholder = "YOUR CALLSIGN";
  show(d.gate, true);
  show(d.lobby, false);
  show(d.full, false);
  // AUTO: a returning player who pressed PRIVATE MATCH / PUBLIC MATCH is not
  // asked for a name they set last time — the card shows who they are and
  // what is happening, and the field only appears if the server refuses it.
  const auto = !!opts.auto && !!remembered && opts.kind !== "rename";
  setAutoMode(auto, remembered);
  if (auto) {
    void submitGate();
    return;
  }
  // A frame later: an input focused in the same turn as the class change does not
  // always take the caret in Chromium.
  requestAnimationFrame(() => {
    d.gateInput.focus();
    d.gateInput.select();
  });
}

/** Auto mode: "PLAYING AS <name>" instead of the field, until a refusal. */
function setAutoMode(on: boolean, name = ""): void {
  const d = dom();
  show(d.gateField, !on);
  show(d.gateNote, !on);
  show(d.gateWho, on);
  if (on) {
    d.gateWho.replaceChildren(el("span", undefined, "PLAYING AS"), el("b"));
    (d.gateWho.lastChild as HTMLElement).textContent = name;
  }
}

function setStatus(text: string): void {
  const d = dom();
  diag.status = text;
  d.gateStatusText.textContent = text;
  show(d.gateStatus, !!text);
}

function gateBusy(on: boolean): void {
  const d = dom();
  d.gateEnter.disabled = on;
  d.gateEnter.textContent = on ? `${gateOpts ? GATE_DOOR[gateOpts.kind].busy : "CHECKING"}…` : gateOpts ? GATE_DOOR[gateOpts.kind].cta : "CONTINUE";
  checkStatus = on ? setStatus : null;
  if (!on) setStatus("");
}

function gateError(text: string): void {
  const d = dom();
  d.gateErr.textContent = text;
  d.gateErr.classList.remove("hidden");
  d.gateInput.focus();
  d.gateInput.select();
}

/**
 * ONE PRESS IS ONE ATTEMPT — the guard, and the bug it exists for.
 *
 * The ENTER key is bound straight to this and Chrome auto-repeats a held Enter at
 * ~30 Hz. `gateBusy(true)` only disables the BUTTON, which the keyboard path never
 * consults, so two taps 60 ms apart ran two whole joins: two `checkname`s, two
 * sockets, two `join`s, and therefore TWO SEATS in the room for one browser tab —
 * measured as roster ["DoubleTap", "DoubleTap 2"], the creator of the lobby
 * demoted to a guest of their own room with no START GAME anywhere. Worse, each
 * one booted a client, and game.start()'s render loop is a self-perpetuating rAF
 * chain: draws per displayed frame went 1 -> 2 and stayed there for the life of
 * the page. That is the 240fps feeling spent on a duplicate.
 *
 * Both ends are now guarded — this flag here, and a `running` early-return in
 * game.ts start(). One flag, cleared in a `finally` so a throw anywhere in the
 * await chain can never wedge the gate shut.
 */
let submitting = false;

/**
 * A GATE IS WALKED THROUGH ONCE. `submitting` only serialises presses that
 * OVERLAP; against a local server a check comes back in under the 60 ms between
 * two taps, so eight taps still bought eight complete attempts — seven of them
 * after this client already had its seat, each one a round trip and a re-entered
 * deploy() flashing the boot screen over a live lobby. Set the moment the seat is
 * handed over, cleared only by openCallsignGate opening the screen again.
 */
let entered = false;

/**
 * The last accepted check, held between the "you will be watching" card and the
 * WATCH button that consumes it. Cleared by whichever way the card is answered.
 */
let pendingEnter: (() => void) | null = null;

async function submitGate(): Promise<void> {
  const opts = gateOpts;
  if (!opts || submitting || entered) return;
  submitting = true;
  try {
    await runGate(opts);
  } finally {
    submitting = false;
  }
}

async function runGate(opts: GateOpts): Promise<void> {
  const d = dom();
  const door = GATE_DOOR[opts.kind];
  const typed = d.gateInput.value.trim();
  // Consumed by THIS attempt, whatever it decides. A permission that outlived
  // the press that granted it would silently disarm the LOBBY NOT FOUND card for
  // the rest of the session.
  let create = forceCreate;
  forceCreate = false;
  pendingEnter = null;
  d.gateErr.classList.add("hidden");
  if (!typed) {
    gateError("ENTER A CALLSIGN FIRST");
    return;
  }
  gateBusy(true);
  let room = opts.room;
  // The offline doors (bots, rename) only take the server's opinion if it is
  // already up — a cold server must never hold a match that runs in this tab.
  const quick = door.offlineOk;
  // The yard names no room: hand the picked mode over so the check answers
  // with that always-live yard (other doors name a code; the mode rides only
  // where no code selects the room).
  let res = await checkCallsign(opts.wsUrl, typed, room, undefined, quick, opts.kind === "yard" ? opts.mode : undefined);
  // A generated code that is somehow already live would make this player a
  // JOINER of a stranger's lobby instead of the host of their own. Take another.
  if (opts.kind === "host" && opts.newCode) {
    for (let i = 0; i < 4 && res.ok && res.room?.exists; i++) {
      room = opts.newCode();
      res = await checkCallsign(opts.wsUrl, typed, room);
    }
  }
  // FOLLOWING THE HOST TO A NEW MAP: their page is loading too. Poll until the
  // room re-opens here; past the deadline, open it ourselves under the same
  // code and mode rather than strand the player on LOBBY NOT FOUND.
  if (opts.waitForHost && res.ok && res.room && !res.room.exists) {
    setStatus("WAITING FOR THE HOST TO OPEN THE LOBBY…");
    const until = performance.now() + HOST_WAIT_MS;
    while (performance.now() < until && res.ok && res.room && !res.room.exists) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!gateOpts || gateOpts !== opts) return;
      res = await checkCallsign(opts.wsUrl, typed, room);
      setStatus("WAITING FOR THE HOST TO OPEN THE LOBBY…");
    }
    if (res.ok && res.room && !res.room.exists) create = true;
  }
  gateBusy(false);
  if (!res.ok) {
    // AN UNREACHABLE SERVER IS NOT A REFUSED NAME. The bot match runs entirely on
    // this machine and no one else will ever read this callsign, so a check that
    // could not be made must not be the thing that stops an offline player from
    // playing. Every OTHER door still needs the answer and still says so.
    if (res.offline && door.offlineOk) {
      enter(opts, { name: typed, room, spectate: false, phase: "live" });
      return;
    }
    // The field comes back (auto mode hid it) so the player can act on this.
    setAutoMode(false);
    uiSfx("error");
    gateError(
      res.offline
        ? "THE GAME SERVER ISN'T RESPONDING. IT MAY BE RESTARTING — TRY AGAIN IN A MOMENT."
        : (res.reason || "THAT CALLSIGN WAS REFUSED — TRY ANOTHER").toUpperCase(),
    );
    return;
  }
  // THE NAME IS SAVED THE MOMENT THE SERVER ACCEPTS IT — before any reload a
  // map change may cost, so the next page never asks for it again.
  rememberName(res.name || typed);
  if (res.room?.full) {
    showFull(`ALL ${res.room.maxPlayable} SEATS AND ALL ${res.room.maxSpectators} SPECTATOR SLOTS IN ${room} ARE TAKEN. SOMEBODY ALWAYS DROPS.`);
    return;
  }
  // A CODE THAT NAMES NO LOBBY IS NOT A LOBBY. Without this, following a stale or
  // mistyped invite made you the HOST of a brand-new empty room with the broken
  // code printed in 46px Bungee — the server already answers `exists`, and the
  // client read the reply and looked only at `.full`. That behaviour is still
  // reachable, on purpose, through the card's own button. Only an INVITE can be
  // stale: the public yard and the bot match name no room at all.
  // THE LOBBY JUST MOVED MAP. Arriving mid-move used to seat this guest in
  // the room everyone was leaving; follow it like the seated players do, and wait
  // there for the host. A follower (waitForHost) is already on its way and never
  // bounces, so a host who moves straight back cannot ping-pong anybody.
  const moved = res.room?.relocated;
  if (opts.kind === "invite" && !opts.waitForHost && moved && isMapId(moved) && moved !== activeMap().id) {
    if (applyGateMap(moved, { kind: "invite", map: moved, room, mode: asModeId(res.room?.mode), wait: true })) return;
  }
  if (door.needsRoom && !create && res.room && !res.room.exists) {
    // THE ROOM MAY LIVE ON ANOTHER MAP. Rooms are owned by the process that
    // simulates their map (server/hub.ts), and an invite link normally carries
    // `&map=` so this page is already on the right one — but a link with the
    // map stripped, or a code read out loud, lands here. Before calling the
    // code dead, ask each other map's process; a hit reloads this page onto
    // that map with `?join=` preserved, and the name gate comes straight back.
    for (const other of MAP_IDS) {
      if (other === activeMap().id) continue;
      const alt = await checkCallsign(opts.wsUrl, typed, room, other);
      if (alt.ok && alt.room?.exists && isMapId(alt.room.map) && applyGateMap(alt.room.map, { kind: "invite", map: alt.room.map, room })) return;
    }
    showFull(
      `NOBODY IS IN ${room}. THE LOBBY HAS CLOSED, OR THE CODE IS WRONG — ASK FOR A FRESH LINK, OR OPEN THIS ONE YOURSELF AND SHARE IT.`,
      "LOBBY NOT FOUND",
      "NO SUCH ROOM",
      "create",
    );
    return;
  }
  // THE MAP, BEFORE ANYTHING ELSE IN THIS FUNCTION MATTERS.
  //
  //   host    this player's own pick.
  //   invite  the map the SERVER says is behind this room code. `res.room.map`
  //           is present whether or not the room exists yet, because one
  //           process is one map (NameCheck.room.map / server SERVER_MAP).
  //   yard    the same — the public yard is that server's match.
  //   bots    NOTHING. This is the one door that never touches the server: the
  //           match runs entirely in this tab on its own GameSession, so the
  //           map a remote server happens to be simulating is none of its
  //           business. Taking it anyway is not cosmetic — measured, a client
  //           on Shipment that pressed DEPLOY · VS BOTS while the dev server ran
  //           dust2 reloaded ITSELF onto dust2 and played a bot match on a map
  //           the player never chose. `offlineOk` is exactly the flag that
  //           marks the door that can open with no server at all.
  //
  // If the answer is not the map this page locked, the page reloads onto it and
  // this whole submit is abandoned — there is nothing to hand `enter()` that
  // would survive the navigation. `?join=CODE` rides along, so a guest comes
  // straight back to this screen pointed at the same room.
  const wantMap = opts.kind === "host" ? opts.map ?? activeMap().id : door.offlineOk ? undefined : res.room?.map;
  if (wantMap) {
    const intent: Intent | null =
      opts.kind === "host"
        ? { kind: "host", map: wantMap, mode: opts.mode ?? "tdm" }
        : opts.kind === "invite"
          ? { kind: "invite", map: wantMap, room }
          : opts.kind === "yard"
            ? { kind: "yard", map: wantMap, mode: asModeId(opts.mode) }
            : null;
    if (applyGateMap(wantMap, intent)) return;
  }
  const result: GateResult = {
    name: res.name || typed,
    room,
    spectate: !!res.room?.spectate,
    phase: res.room?.phase ?? "pregame",
    map: wantMap ?? readMapPref(),
    // Host door: the menu's pick. Invite door: whatever the room actually runs
    // (res.room.mode). A force-created stale invite opens a team lobby.
    mode: opts.kind === "host" ? opts.mode ?? "tdm" : (res.room?.exists ? res.room.mode : undefined) ?? opts.mode ?? "tdm",
  };
  // YOU ARE ABOUT TO BE A SPECTATOR, AND THIS IS WHERE YOU FIND OUT.
  //
  // The check already knows: `spectate` means the ten playable seats are gone and
  // this player joins the bench. The gate used to read that field, pass it
  // straight through and print nothing, so the screen was byte-identical to an
  // ordinary join — you pressed a button labelled ENTER LOBBY and landed on the
  // bench. It is not a refusal and it is not a dead end, so it is the same card
  // with the WATCH button: the offer, the queue depth, and a way out.
  if (result.spectate && res.room) {
    const ahead = res.room.spectators + 1;
    pendingEnter = () => enter(opts, result);
    showFull(
      `ALL ${res.room.maxPlayable} SEATS IN ${room} ARE TAKEN. YOU WILL WATCH THROUGH A PLAYER'S EYES — LEFT AND RIGHT CLICK CHANGE WHO — AND TAKE THE FIRST SEAT THAT FREES. YOU ARE #${ahead} IN LINE.`,
      "WATCH FROM THE BENCH",
      "THE SEATS ARE FULL",
      "watch",
    );
    return;
  }
  enter(opts, result);
}

/**
 * The one way through this screen: remember the name, put the screen away, then
 * hand the seat over.
 *
 * THE GATE HAS TO CLOSE ITSELF. It used to be closed for it, by attachLobby —
 * which only runs for a room that HAS a pre-game lobby. Every other door (the
 * public yard, the bot match) left the card sitting over the running game for
 * the life of the page: measured on the yard door as `#nana-gate` still visible
 * with the HUD up and the match live behind it. A screen that hands over is
 * finished, whoever it hands over to. Closing before onEnter costs no frame —
 * deploy() raises the boot screen synchronously in the same task.
 */
function enter(opts: GateOpts, r: GateResult): void {
  entered = true;
  rememberName(r.name);
  opts.sfx?.("ui-go");
  diag.spectator = r.spectate;
  diag.room = r.room;
  closeGate();
  opts.onEnter(r);
}

/**
 * The card between the gate and the game: a full lobby, a code that names no
 * lobby, an offer of the bench, or any `err` the server sends mid-join.
 *
 * THE PRIMARY BUTTON IS THE ADVICE. The card used to say "somebody always drops
 * — try again in a minute" over a single BACK TO MENU, and the menu has no
 * join-by-code field, so the only route back into that room was to go and find
 * the invite link again. Now the sentence is pressable, and it presses the thing
 * the sentence describes:
 *   full      -> TRY AGAIN, re-running the same check against the same room
 *   not found -> OPEN IT ANYWAY, which takes the code and becomes its host
 *   watch     -> WATCH THIS MATCH, taking the bench seat the note just described
 */
const FULL_CTA: Record<"retry" | "create" | "watch", string> = {
  retry: "TRY AGAIN",
  create: "OPEN IT ANYWAY",
  watch: "WATCH THIS MATCH",
};

export function showFull(
  note: string,
  title = "LOBBY FULL",
  eyebrow = "NO SEATS LEFT",
  action: "retry" | "create" | "watch" = "retry",
): void {
  // A FULL refusal can arrive while SETTINGS is open in the lobby — close it
  // first so the modal never sits orphaned over the FULL card. Covers all
  // showFull callers (FULL, LOBBY NOT FOUND, WATCH, capacity).
  if (settingsOpen()) closeSettings();
  const d = dom();
  diag.screen = "full";
  diag.fullAction = action;
  d.fullEyebrow.textContent = eyebrow;
  d.fullTitle.textContent = title;
  d.fullNote.textContent = note;
  fullAction = action;
  // PRE-BOOT ONLY. Every refusal this button answers happens before a single byte
  // of game is started; a refusal that arrives AFTER this client already has a
  // seat and a running client (the server's `err`) has a teardown to do, and
  // BACK TO MENU is the button that does it. Re-running the gate from there
  // would boot a second client over a live one.
  show(d.fullRetry, !!gateOpts && !bound);
  d.fullRetry.disabled = false;
  d.fullRetry.textContent = FULL_CTA[action];
  show(d.gate, false);
  show(d.lobby, false);
  show(d.full, true);
}

export function closeGate(): void {
  const d = dom();
  show(d.gate, false);
  show(d.full, false);
  if (diag.screen !== "lobby") diag.screen = "none";
}

// ---------------------------------------------------------------------------
// The lobby screen
// ---------------------------------------------------------------------------

let hooks: LobbyHooks | null = null;
let bound: GameLike | null = null;
let state: LobbyState | null = null;
/** Sockets already carrying our listener — a reconnect makes a NEW one. */
const listening = new WeakSet<WebSocket>();
let watchdog = 0;

function show(node: HTMLElement, on: boolean): void {
  node.classList.toggle("hidden", !on);
}

/**
 * Start listening on the seat's socket and paint the lobby.
 *
 * `phase` is what the pre-boot name check reported, and it is the reason a player
 * who joins a match that has ALREADY STARTED never sees a pre-game screen flash:
 * the lobby is only shown if the room was actually in pre-game when they asked.
 */
export function attachLobby(game: GameLike, h: LobbyHooks, phase: MatchPhase, spectating: boolean): void {
  const d = dom();
  hooks = h;
  bound = game;
  diag.phase = phase;
  diag.spectator = spectating;
  diag.you = game.you;
  wireButtons();
  // The SETTINGS button is always built, but it only does something when a
  // handler exists — hide it for hook sets without onSettings. Inline
  // classList (not the show() helper below it) so this stays above show()'s
  // definition. paint() deliberately never touches it.
  d.settings.classList.toggle("hidden", !h.onSettings);
  wireSocket();
  // A NEW SOCKET IS A NEW SEAT. game.ts reconnects with backoff on a drop, and
  // the listener installed above belongs to the socket that died; without this the
  // lobby would go deaf exactly when a player most needs to see the roster again.
  // 1 s, and it does nothing at all unless the socket identity changed.
  if (!watchdog)
    watchdog = window.setInterval(() => {
      wireSocket();
      // Team columns come from the snapshot roster, which settles a beat after
      // the lobby message — repaint while the screen is up (cheap, 2 Hz).
      // Shelf the paint at 2 Hz, and keep the lobby's ping clock running while
      // the roster is on screen (see lobbyPingTick: the in-match loop is what
      // used to be the only RTT source).
      lobbyPingTick();
      if (diag.screen === "lobby") paint();
    }, 500);
  if (phase === "pregame") {
    show(d.gate, false);
    show(d.full, false);
    show(d.lobby, true);
    diag.screen = "lobby";
  } else {
    closeGate();
  }
  applySpectator(spectating);
}

/** Stop listening and tear every screen down (RETURN TO MENU / game over). */
export function detachLobby(): void {
  const d = dom();
  // An open settings modal outlives the lobby screen — close it first so it
  // never sits orphaned over the HUD, countdown, or menu.
  if (settingsOpen()) closeSettings();
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = 0;
  }
  state = null;
  startPressedAt = 0;
  playedHere = false;
  // Before `bound` goes: the trigger getters live on the game's own keys object
  // and have to be handed back before we forget where they are.
  applySpectator(false);
  bound = null;
  show(d.lobby, false);
  show(d.gate, false);
  show(d.full, false);
  diag.screen = "none";
  diag.players = [];
  diag.spectators = [];
}

export function lobbyOnScreen(): boolean {
  return diag.screen !== "none";
}

/** TRUE while this client is on the bench. main.ts reads it to keep the match HUD honest. */
export function spectating(): boolean {
  return spectatingNow;
}

/**
 * WHERE THIS CLIENT SITS IN THE PROMOTION QUEUE — 1-based, 0 when not benched.
 *
 * The server promotes the longest-waiting spectator (server/index.ts specSeats),
 * and the roster it broadcasts is already in that order, so this is a read of a
 * fact the client has rather than a new message. The pre-game bench row shows it
 * as "#3"; the in-match spectator plate (client/src/spectate.ts) shows it as the
 * second half of its eyebrow, because during a live match that roster is not on
 * screen and a benched player still has to be able to answer "how long?".
 */
export function benchPosition(): number {
  if (!spectatingNow) return 0;
  const i = diag.spectators.findIndex((m) => m.id === diag.you);
  return i < 0 ? 0 : i + 1;
}

function wireSocket(): void {
  const ws = bound?.net;
  if (!ws || listening.has(ws)) return;
  listening.add(ws);
  ws.addEventListener("message", onServerMessage);
  const ask = (): void => {
    try {
      ws.send(JSON.stringify({ t: "lobbyq" }));
    } catch {
      /* closed under us */
    }
  };
  // The roster may have been broadcast before this listener existed (the socket
  // opens inside game.start()), so ask for it once rather than waiting for the
  // next person to join.
  if (ws.readyState === 1) ask();
  else ws.addEventListener("open", ask, { once: true });
}

/**
 * LOBBY PING. The in-match loop (game.ts keepAlive) is the only thing that ever
 * reported an RTT, so a fresh lobby showed every seat at 0 — the roster clamps
 * that to "1 MS", i.e. everybody appeared to have a 1 ms connection until a
 * match had run on that socket. The lobby therefore pings the same way it
 * reports: measure the pong, hand the last measurement to the server, once a
 * second, only while the lobby screen is up (a match has its own loop).
 */
let lobbyPingAt = 0;
let lobbyRttMs = 0;

function lobbyPingTick(): void {
  if (diag.screen !== "lobby") return;
  const ws = bound?.net;
  if (!ws || ws.readyState !== 1) return;
  const now = Date.now();
  if (now - lobbyPingAt < 1000) return;
  lobbyPingAt = now;
  try {
    // >= 1, so the server's 0 keeps meaning "no measurement yet" (the roster
    // renders that as "—" rather than inventing a 1 ms line for everyone).
    ws.send(JSON.stringify({ t: "ping", t0: now, rtt: lobbyRttMs }));
  } catch {
    /* closed under us */
  }
}

/** A pong closes the loop: now - t0 is this client's round trip to the server. */
function notePong(t0: number): void {
  if (!Number.isFinite(t0)) return;
  const rtt = Date.now() - t0;
  if (!Number.isFinite(rtt) || rtt < 0 || rtt >= 1000) return;
  lobbyRttMs = Math.max(1, Math.round(rtt));
}

function onServerMessage(ev: MessageEvent): void {
  const raw = typeof ev.data === "string" ? ev.data : "";
  // Pongs are the lobby's ping clock: cheap prefix match, decoded only for the
  // timestamp (they are 1/s, not part of the 32/s snapshot stream below).
  if (raw.startsWith('{"t":"pong"')) {
    try {
      const pong = JSON.parse(raw) as { t0?: number };
      if (typeof pong.t0 === "number") notePong(pong.t0);
    } catch {
      /* malformed pong: ignore, the next one comes in a second */
    }
    return;
  }
  // THE HOT PATH IS THE ONE WE REFUSE TO PARSE. See the file header: snapshots
  // are 32/s of the largest payload in the game and this module needs nothing
  // from them, so they are rejected on a prefix compare, never decoded twice.
  if (!raw || raw.startsWith('{"t":"snap"')) return;
  let msg: ServerMsg;
  try {
    msg = JSON.parse(raw) as ServerMsg;
  } catch {
    return;
  }
  if (msg.t === "lobby") {
    // THE SERVER NAMES THE MAP IT SIMULATES, EVERY TIME. If it is not the map
    // this page built its sim and its world out of, nothing drawn here is the
    // truth — reload onto the server's map (the hub makes this unreachable;
    // a single-map server with `SHIPMENT_MAP=` pinned is the case it guards).
    if (isMapId(msg.map) && msg.map !== diag.clientMap && applyGateMap(msg.map, msg.room ? { kind: "invite", map: msg.map, room: msg.room } : null)) return;
    // BACK TO THE LOBBY. The room was counting down or live and the server
    // has reset it to pre-game after the endcard: same code, same link, the
    // host can START again. Re-raise the roster screen over the yard.
    const returned = msg.phase === "pregame" && diag.phase !== "pregame";
    if (state && state.mode !== msg.mode) hooks?.onMode?.(asModeId(msg.mode));
    state = msg;
    if (bound) bound.gunKills = asGunKills(msg.gunKills); // the room's kills per gun, for the HUD
    diag.phase = msg.phase;
    if (returned) {
      startPressedAt = 0;
      playedHere = true;
      if (settingsOpen()) closeSettings();
      const d = dom();
      show(d.gate, false);
      show(d.full, false);
      show(d.lobby, true);
      diag.screen = "lobby";
      hooks?.onReturn?.();
    }
    diag.startAt = msg.startAt;
    diag.you = msg.you;
    diag.room = msg.room;
    diag.map = msg.map;
    diag.host = msg.host;
    diag.players = msg.players;
    diag.spectators = msg.spectators;
    applySpectator(msg.spectators.some((s) => s.id === msg.you));
    paint();
  } else if (msg.t === "start") {
    startPressedAt = 0;
    diag.phase = "countdown";
    diag.startAt = msg.startAt;
    // The lobby goes away on START — take an open settings modal with it so
    // it never overlays the HUD/countdown.
    if (settingsOpen()) closeSettings();
    const d = dom();
    show(d.lobby, false);
    diag.screen = "none";
    hooks?.onStart(msg.startAt);
  } else if (msg.t === "relocate") {
    // THE HOST MOVED THE LOBBY TO ANOTHER MAP. This page has to become that
    // map (one page load is one map), so it reloads: the host re-opens the room
    // under the same code, everyone else follows a beat later and waits at the
    // door until it is open (runGate, waitForHost).
    if (!isMapId(msg.map)) return;
    const d = dom();
    d.hostnote.textContent = `MOVING THE LOBBY TO ${mapLabel(msg.map).toUpperCase()}…`;
    show(d.hostnote, true);
    const mode = asModeId(msg.mode);
    const intent: Intent = msg.host
      ? { kind: "host", map: msg.map, mode, room: msg.room }
      : { kind: "invite", map: msg.map, room: msg.room, mode, wait: true };
    window.setTimeout(() => goToMap(msg.map, intent, activeMap().id), msg.host ? 0 : 600);
  } else if (msg.t === "promoted") {
    applySpectator(false);
    youreIn(msg.slot, msg.waitForRound);
  } else if (msg.t === "welcome") {
    diag.you = msg.id;
    diag.room = msg.room;
    applySpectator(msg.spectator);
  } else if (msg.t === "err") {
    diag.lastError = String(msg.msg || "");
    const text = String(msg.msg || "").toUpperCase();
    if (text.includes("FULL")) {
      // No "try again in a minute" here: this refusal arrives on a client that is
      // already up, so the card offers BACK TO MENU and nothing else (showFull
      // hides the retry once a seat exists). The advice and the buttons agree.
      // The room's own seat count when a roster has arrived (dust2 rooms seat
      // 15 / 12, not MAX_PLAYABLE); the Shipment default before one has.
      showFull(`THIS LOBBY IS AT CAPACITY — ${state?.maxPlayable ?? MAX_PLAYABLE} PLAYING AND ${MAX_SPECTATORS} WATCHING.`);
    }
    hooks?.onRefused(text);
  }
}

function wireButtons(): void {
  const d = dom();
  if (d.gate.dataset.wired === "1") return;
  d.gate.dataset.wired = "1";

  d.gateEnter.addEventListener("click", () => void submitGate());
  d.gateInput.addEventListener("keydown", (e) => {
    // A HELD ENTER IS ONE PRESS. Chrome auto-repeats at ~30 Hz and every repeat
    // arrived here as a fresh submit; `e.repeat` is the browser telling us which
    // ones are the same press, and it costs one condition to believe it.
    if (e.key === "Enter" && !e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      void submitGate();
    }
  });
  // Typing a callsign must not also drive the monkey: game.ts binds movement,
  // melee and the scoreboard to bare window keydowns.
  for (const type of ["keydown", "keyup"] as const) {
    d.gateInput.addEventListener(type, (e) => e.stopPropagation());
    d.link.addEventListener(type, (e) => e.stopPropagation());
  }
  d.gateBack.addEventListener("click", () => {
    closeGate();
    gateOpts?.onCancel();
  });
  d.fullRetry.addEventListener("click", () => {
    if (!gateOpts) return;
    // WATCH THIS MATCH: the check has already passed and the seat is already
    // decided — this button is the player agreeing to the bench, so it spends the
    // answer we are holding instead of asking the server the same question twice.
    if (fullAction === "watch") {
      const go = pendingEnter;
      pendingEnter = null;
      d.fullRetry.disabled = true;
      if (go) go();
      return;
    }
    // OPEN IT ANYWAY: the player has been told the lobby is not there and has
    // decided to be its host. One flag, cleared by the attempt it authorises, so
    // it can never make the "not found" card unreachable for the next arrival.
    if (fullAction === "create") forceCreate = true;
    // A RETRY IS A NEW ATTEMPT, so the one-shot guard is spent here too. There is
    // a reachable card that arrives AFTER the gate has already handed over — the
    // SERVER UNREACHABLE one that main.ts raises when the boot it triggered could
    // not connect — and without this line its TRY AGAIN would put the gate back
    // on screen, print CHECKING…, and then be refused by `entered` for ever. A
    // dead end is the one outcome this screen may not have.
    entered = false;
    d.fullRetry.disabled = true;
    d.fullRetry.textContent = "CHECKING…";
    // Back to the gate first: the name is already typed and already accepted, so
    // the retry is one round trip and the player watches it happen on the screen
    // they came from rather than on a card that cannot show progress.
    show(d.full, false);
    show(d.gate, true);
    diag.screen = "gate";
    void submitGate();
  });
  d.fullBack.addEventListener("click", () => {
    pendingEnter = null;
    closeGate();
    // Two ways to land on this screen: refused before anything booted (nothing to
    // tear down, go back to the menu), or refused by the server after the client
    // had already connected (the seat has to be dropped as well).
    if (bound) {
      detachLobby();
      hooks?.onLeave();
    } else {
      gateOpts?.onCancel();
    }
  });
  d.copy.addEventListener("click", () => void copyLink());
  d.link.addEventListener("focus", () => d.link.select());
  d.start.addEventListener("click", () => {
    const ws = bound?.net;
    if (!ws || ws.readyState !== 1) return;
    if (settingsOpen()) closeSettings();
    d.start.disabled = true;
    d.start.textContent = "STARTING…";
    startPressedAt = performance.now();
    // No answer at all (a restarting server): give the button back.
    window.setTimeout(paintStart, START_PENDING_MS + 50);
    hooks?.sfx?.("ui-go");
    ws.send(JSON.stringify({ t: "startmatch" }));
  });
  d.leave.addEventListener("click", () => {
    detachLobby();
    hooks?.onLeave();
  });
  d.settings.addEventListener("click", () => hooks?.onSettings?.());
  d.shuffle.addEventListener("click", () => {
    const ws = bound?.net;
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "shuffle" }));
  });
  // Host roster controls: delegated (rows re-render on every paint).
  d.roster.addEventListener("click", onRosterClick);
  d.specs.addEventListener("click", onRosterClick);
}

/** HOST: move a seat between teams / bench (lobbymove). */
function lobbyMove(id: string, extra?: { team?: 0 | 1; spectator?: boolean }): void {
  const ws = bound?.net;
  if (!ws || ws.readyState !== 1 || state?.phase !== "pregame") return;
  hooks?.sfx?.("ui");
  ws.send(JSON.stringify({ t: "lobbymove", id, ...extra }));
}

/** HOST: hand the chair to another seat (lobbyhost). */
function lobbyHost(id: string): void {
  const ws = bound?.net;
  if (!ws || ws.readyState !== 1) return;
  hooks?.sfx?.("ui");
  ws.send(JSON.stringify({ t: "lobbyhost", id }));
}

/**
 * HOST ROSTER CLICKS — one delegated listener per list (rows are re-rendered
 * as innerHTML on every paint, so per-button wiring would die with the paint).
 */
function onRosterClick(e: Event): void {
  const btn = (e.target as HTMLElement | null)?.closest?.("button[data-act]") as HTMLElement | null;
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;
  switch (btn.dataset.act) {
    case "team":
      lobbyMove(id);
      break;
    case "bench":
      lobbyMove(id, { spectator: true });
      break;
    case "play":
      lobbyMove(id, { spectator: false });
      break;
    case "host":
      lobbyHost(id);
      break;
  }
}
/** HOST: ask the server for a new mode or map (lobbyset). */
function lobbySet(change: { mode?: ModeId; map?: string; gunKills?: number }): void {
  const ws = bound?.net;
  if (!ws || ws.readyState !== 1 || state?.phase !== "pregame") return;
  hooks?.sfx?.("ui");
  ws.send(JSON.stringify({ t: "lobbyset", ...change }));
}

/** The host's mode + map pickers; everyone else just reads the map card. */
function paintSetup(s: LobbyState, iAmHost: boolean): void {
  const d = dom();
  show(d.setup, iAmHost && s.phase === "pregame");
  if (!iAmHost) return;
  const mode = asModeId(s.mode);
  d.modeSeg.replaceChildren();
  for (const m of modesFor(s.map)) {
    const b = el("button", m.mode === mode ? "is-on" : "", m.label);
    b.type = "button";
    b.dataset.sfx = "off";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(m.mode === mode));
    b.title = `${m.label} · ${m.size}`;
    b.addEventListener("click", () => m.mode !== mode && lobbySet({ mode: m.mode }));
    d.modeSeg.append(b);
  }
  // Kills per gun, the host's GUN GAME knob.
  const gk = asGunKills(s.gunKills);
  show(d.gunLabel, mode === "gun");
  show(d.gunSeg, mode === "gun");
  d.gunSeg.replaceChildren();
  for (const n of GUN_KILL_OPTIONS) {
    const b = el("button", n === gk ? "is-on" : "", String(n));
    b.type = "button";
    b.dataset.sfx = "off";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(n === gk));
    b.title = `${n} kill${n === 1 ? "" : "s"} per gun · ${gunGoal(n)} to win`;
    b.addEventListener("click", () => n !== gk && lobbySet({ gunKills: n }));
    d.gunSeg.append(b);
  }
  d.mapRow.replaceChildren();
  for (const id of MAP_IDS) {
    const b = el("button", `nana-map${id === s.map ? " is-on" : ""}`);
    b.type = "button";
    b.dataset.sfx = "off";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(id === s.map));
    b.style.backgroundImage = mapCardUrl(id);
    b.append(el("b", undefined, esc(mapLabel(id))));
    b.addEventListener("click", () => {
      if (id === s.map) return;
      b.classList.add("is-busy");
      lobbySet({ map: id });
    });
    d.mapRow.append(b);
  }
}

/**
 * COPY, with a fallback that actually works. `navigator.clipboard` needs a secure
 * context — it is there on https://cnvs.dev/kong and on localhost, and missing on
 * a plain-http LAN address, which is exactly how somebody tests an invite link
 * with a friend on the same wifi. The visible confirmation matters as much as the
 * copy: a button that does nothing observable gets pressed five times.
 */
async function copyLink(): Promise<void> {
  const d = dom();
  const text = d.link.value;
  let ok = false;
  try {
    await navigator.clipboard?.writeText(text);
    ok = true;
  } catch {
    ok = false;
  }
  if (!ok) {
    try {
      d.link.removeAttribute("readonly");
      d.link.focus();
      d.link.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
      d.link.setAttribute("readonly", "");
    } catch {
      ok = false;
    }
  }
  hooks?.sfx?.("ui");
  uiSfx(ok ? "confirm" : "error");
  d.copy.textContent = ok ? "COPIED" : "PRESS ⌘C";
  d.copy.classList.toggle("done", ok);
  if (!ok) d.link.select();
  // Long enough to be read by somebody whose eyes were on the link, not the
  // button: 1.6 s was gone before a player looked up.
  window.setTimeout(() => {
    d.copy.textContent = "COPY INVITE";
    d.copy.classList.remove("done");
  }, 2400);
}

/**
 * LAST GOOD PING, per player in the current room.
 *
 * A seat's `ping` is reset to 0 whenever the server builds a new seat for that
 * player — a reconnect, a host move (team/bench), a promotion — so the roster
 * blinked from "42 MS" to "—" for a beat even though the connection had been
 * measured a second earlier. The number is remembered here and used while the
 * new measurement is in flight; only a room change throws it away, because
 * callsigns are unique per room and stale numbers must never leak across rooms.
 */
const pingMemo = new Map<string, number>();
let pingMemoScope = "";

function rememberPing(scope: string, name: string, ms: number): void {
  if (scope !== pingMemoScope) {
    pingMemo.clear();
    pingMemoScope = scope;
  }
  pingMemo.set(name.toLowerCase(), ms);
}

function lastPing(scope: string, name: string): number {
  return scope === pingMemoScope ? (pingMemo.get(name.toLowerCase()) ?? 0) : 0;
}

/** One roster line. A bench row numbers the queue (#3), not a seat. */
function rowHtml(m: LobbyMember | null, slot: number, you: string, openLabel: string, iAmHost = false, teamGame = true): string {
  if (!m) {
    return `<li class="nana-row open"><span class="nana-slot">${String(slot).padStart(2, "0")}</span><span class="nana-name">${openLabel}</span></li>`;
  }
  const badges =
    (m.host ? '<i class="badge badge--accent">HOST</i>' : "") + (m.id === you ? '<i class="badge">YOU</i>' : "");
  // The seat's ping, coloured like the scoreboard's (green / amber / red).
  // A seat that has not answered a pong yet reports 0 — never a real 1 ms — so
  // the last measured number for that player is shown instead, and "—" only
  // appears before the first measurement of the session. The self row falls
  // back to the client's own measurement, which exists before the server's
  // roster broadcast picks it up.
  const scope = diag.room ?? "";
  const wirePing = typeof m.ping === "number" && m.ping > 0 ? Math.round(m.ping) : 0;
  if (wirePing > 0) rememberPing(scope, m.name, wirePing);
  const selfPing = m.id === you ? lobbyRttMs : 0;
  const ms = wirePing > 0 ? wirePing : Math.max(selfPing, lastPing(scope, m.name));
  const known = ms > 0;
  const ping = known
    ? `<i class="nana-ping ${ms > 150 ? "is-bad" : ms > 80 ? "is-ok" : "is-good"}" title="Ping">${ms} MS</i>`
    : `<i class="nana-ping is-unknown" title="Ping not measured yet">—</i>`;
  // The row's place in ITS column (a team list reads 01, 02, 03…); a bench
  // row numbers the promotion queue.
  const num = m.spectator ? `#${slot}` : String(slot).padStart(2, "0");
  // HOST CONTROLS (pre-game lobby only — the server enforces host + pregame):
  // move a seat to the other team / bench / back into play, or hand the chair
  // over. Rendered as data-act buttons; one delegated listener (wireButtons)
  // sends lobbymove/lobbyhost. Probes keep reading .nana-name; self rows and
  // guests get no buttons.
  let ctl = "";
  if (iAmHost && m.id !== you) {
    const id = esc(m.id);
    ctl = m.spectator
      ? `<span class="nana-ctl"><button type="button" class="btn btn--sm" data-act="play" data-id="${id}" title="Move into a free seat">PLAY</button><button type="button" class="btn btn--sm" data-act="host" data-id="${id}" title="Make this player the host">HOST</button></span>`
      : `<span class="nana-ctl">${teamGame ? `<button type="button" class="btn btn--sm" data-act="team" data-id="${id}" title="Move to the other team">TEAM</button>` : ""}<button type="button" class="btn btn--sm" data-act="bench" data-id="${id}" title="Move to spectators">BENCH</button><button type="button" class="btn btn--sm" data-act="host" data-id="${id}" title="Make this player the host">HOST</button></span>`;
  }
  return `<li class="nana-row taken${m.id === you ? " you" : ""}" data-taken="1"><span class="nana-slot">${num}</span><span class="nana-name">${esc(m.name)}</span><span class="nana-badges">${ping}${badges}</span>${ctl}</li>`;
}

let paintKey = "";
/**
 * THE START BUTTON'S OWN STATE. It used to latch on its label: the click wrote
 * "STARTING…" and the roster paint only reset a button that did NOT say that —
 * so after a match, when the room dropped back to this screen, the host found
 * START still reading "STARTING…", disabled, for good. The press is now a
 * timestamp that the match starting, the room returning, or a few silent
 * seconds (the server never answered) all clear.
 */
let startPressedAt = 0;
/** This lobby has already played a match: the button says START AGAIN. */
let playedHere = false;
const START_PENDING_MS = 6000;

function paintStart(): void {
  const d = dom();
  if (startPressedAt && performance.now() - startPressedAt < START_PENDING_MS) return;
  startPressedAt = 0;
  d.start.disabled = false;
  d.start.textContent = playedHere ? "START AGAIN" : "START MATCH";
}

function paint(): void {
  const s = state;
  if (!s) return;
  paintStart();
  const d = dom();
  const link = inviteLink(s.room, isMapId(s.map) ? s.map : undefined);
  diag.link = link;
  // EVERY WORD FROM THE SOURCE OF TRUTH: the map name from MAP_OPTIONS, the
  // mode / size / rules from shared/modes.ts against the room's real map and
  // mode — never this page's guess.
  const mode = asModeId(s.mode);
  const info = modeInfo(s.map, mode);
  const mapName = mapLabel(s.map);
  const teams: (0 | 1 | -1)[] = s.players.map((m) => {
    const t = bound?.players?.get(m.id)?.team;
    return t === 0 || t === 1 ? t : -1;
  });
  const key = JSON.stringify([s, teams, link]);
  if (key === paintKey) return;
  paintKey = key;
  // The room's map owns the bed. Gated behind the paint dedupe above (plus
  // select's own same-target no-op), so the 500 ms watchdog and roster ticks
  // can never restart an in-flight crossfade; a real map change still
  // crossfades immediately, before the reload it triggers.
  selectMenuMusic(s.map);

  d.lobbyEyebrow.textContent = `${info.label} · ${info.size} · ${mapName}`;
  (d.mapCard.querySelector(".nana-eyebrow") as HTMLElement).textContent = `${info.label} · ${info.size}`;
  d.mapName.textContent = mapName;
  d.mapCard.style.backgroundImage = mapCardUrl(s.map);
  // The host's kills per gun replaces the default "3 kills each".
  d.rules.textContent = mode === "gun" ? info.rules.replace(/\d+ kills each/, `${asGunKills(s.gunKills)} kill${asGunKills(s.gunKills) === 1 ? "" : "s"} each`) : `${info.rules}`;
  d.code.textContent = s.room;
  if (d.link.value !== link) d.link.value = link;
  d.count.textContent = `${s.players.length} / ${s.maxPlayable} PLAYERS`;
  d.speccount.textContent = `${s.spectators.length} / ${s.maxSpectators}`;

  const openLabel = s.botFill > 0 ? "OPEN · BOT ON START" : "OPEN";
  // Host controls need the chair BEFORE the rows are built (rowHtml renders
  // the buttons; the paint dedupe key below already includes s.host via s).
  const iAmHost = s.host === s.you;
  if (info.teams) {
    // TWO COLUMNS, RELATIVE: your team (blue) and the enemy (red). A seat is
    // placed by the team the server gave it (snapshot roster); a player whose
    // team has not arrived yet sits in the first column with room.
    const half = Math.max(1, Math.floor(s.maxPlayable / 2));
    const meIdx = s.players.findIndex((m) => m.id === s.you);
    const mine = meIdx >= 0 && teams[meIdx] !== -1 ? (teams[meIdx] as 0 | 1) : 0;
    const cols: LobbyMember[][] = [[], []];
    s.players.forEach((m, i) => {
      const t = teams[i];
      const side = t === -1 ? (cols[0].length < half ? 0 : 1) : t === mine ? 0 : 1;
      cols[side]!.push(m);
    });
    const spectatorView = s.spectators.some((m) => m.id === s.you);
    const col = (side: 0 | 1): string => {
      const list = cols[side]!;
      let rows = "";
      for (let i = 0; i < half; i++) rows += rowHtml(list[i] ?? null, i + 1, s.you, openLabel, iAmHost, true);
      const label = spectatorView ? (side === 0 ? "TEAM 1" : "TEAM 2") : side === 0 ? "YOUR TEAM" : "ENEMY TEAM";
      return `<div class="nana-team ${side === 0 ? "ally" : "enemy"}"><header><b>${label}</b><i>${list.length} / ${half}</i></header><ol class="nana-list">${rows}</ol></div>`;
    };
    d.roster.className = "nana-teams";
    d.roster.innerHTML = col(0) + col(1);
  } else {
    // FREE-FOR-ALL: one roster, every seat drawn — the roster IS the capacity.
    const half = Math.ceil(s.maxPlayable / 2);
    let a = "";
    let b = "";
    for (let i = 0; i < s.maxPlayable; i++) {
      const r = rowHtml(s.players[i] ?? null, i + 1, s.you, openLabel, iAmHost, false);
      if (i < half) a += r;
      else b += r;
    }
    d.roster.className = "nana-teams ffa";
    d.roster.innerHTML =
      `<div class="nana-team"><header><b>PLAYERS</b><i>${s.players.length} / ${s.maxPlayable}</i></header><ol class="nana-list">${a}</ol></div>` +
      `<div class="nana-team"><header><b>&nbsp;</b><i></i></header><ol class="nana-list">${b}</ol></div>`;
  }
  show(d.benchPanel, s.spectators.length > 0);
  d.specs.innerHTML = s.spectators.map((m, i) => rowHtml(m, i + 1, s.you, "", iAmHost, info.teams)).join("");

  const queue = s.spectators.findIndex((m) => m.id === s.you);
  const iAmSpec = queue >= 0;
  paintSetup(s, iAmHost);
  // SHUFFLE only means something with every seat taken and someone waiting.
  show(d.shuffle, iAmHost && s.phase === "pregame" && s.players.length >= s.maxPlayable && s.spectators.length > 0);
  show(d.start, iAmHost);
  show(d.wait, !iAmHost);
  const hostName = s.players.find((m) => m.host)?.name ?? s.spectators.find((m) => m.host)?.name ?? "—";
  d.wait.innerHTML = iAmSpec ? "<i></i> WAITING FOR A SEAT" : `<i></i> WAITING FOR ${esc(hostName.toUpperCase())} TO START`;
  d.botnote.textContent =
    s.botFill > 0 ? `${s.botFill} OPEN SEAT${s.botFill === 1 ? "" : "S"} WILL BE FILLED BY BOTS WHEN THE MATCH STARTS.` : "EVERY SEAT IS TAKEN BY A PLAYER.";
  show(d.hostnote, iAmHost || iAmSpec);
  if (iAmSpec) {
    d.hostnote.textContent =
      queue === 0 ? "YOU ARE NEXT — YOU ARE IN THE MOMENT A SEAT FREES" : `YOU ARE #${queue + 1} IN LINE — ${queue + 1} SEATS MUST FREE`;
  } else if (iAmHost) {
    d.hostnote.textContent = "YOU ARE THE HOST — START WHEN READY";
  }
  // The screen follows the server's phase (see the onStart contract): a roster
  // that arrives after the match went live hands straight over to the match.
  if (s.phase !== "pregame" && !d.lobby.classList.contains("hidden")) {
    // Same orphan-modal guard as the "start" message: closing the lobby takes
    // an open settings modal with it.
    if (settingsOpen()) closeSettings();
    show(d.lobby, false);
    if (diag.screen === "lobby") diag.screen = "none";
    hooks?.onStart(s.startAt);
  }
}

// ---------------------------------------------------------------------------
// Spectating
// ---------------------------------------------------------------------------

let spectatingNow = false;

/**
 * THE SPECTATOR STATE. The server already refuses a spectator's trigger, so this
 * is about not LYING to them: without it a bench player's own client would keep
 * predicting muzzle flashes, tracers and a falling ammo count for shots the
 * server never fired, and the one thing a spectator screen has to be is honest.
 *
 * The trigger keys are replaced by getters rather than being watched on a timer,
 * so it costs exactly nothing per frame and reverses cleanly on promotion.
 */
function applySpectator(on: boolean): void {
  diag.spectator = on;
  if (on === spectatingNow) return;
  spectatingNow = on;
  const keys = bound?.keys as unknown as Record<string, boolean> | undefined;
  if (keys) {
    for (const k of ["fire", "melee"]) {
      if (on) Object.defineProperty(keys, k, { get: () => false, set: () => undefined, configurable: true, enumerable: true });
      else Object.defineProperty(keys, k, { value: false, writable: true, configurable: true, enumerable: true });
    }
  }
  if (on) window.addEventListener("keydown", vetoThrow, true);
  else window.removeEventListener("keydown", vetoThrow, true);
}

/** The frag key is a nana throw, and a spectator has no nanas. Vetoed before game.ts sees it. */
function vetoThrow(e: KeyboardEvent): void {
  if (actionOf(e.code) === "frag") e.stopImmediatePropagation(); // feel stream: whatever key FRAG is bound to
}

/**
 * The promotion moment: one card, one animation, then it removes itself.
 *
 * The sub-line tells the truth about WHICH promotion this is — off the bench into
 * a seat while the lobby is still waiting, or off the bench into a live firefight,
 * or into a round-based match where their first life starts next round.
 */
function youreIn(slot = 0, waitForRound = false): void {
  const old = document.getElementById("nana-in");
  old?.remove();
  const card = el("div");
  card.id = "nana-in";
  card.append(el("b", undefined, "YOU'RE IN"));
  const sub = el("span");
  sub.textContent =
    waitForRound ? "YOUR SEAT IS READY · PLAY NEXT ROUND" : diag.phase === "live" ? "SPAWNED · FULL MAG" : slot > 0 ? `SLOT ${String(slot).padStart(2, "0")} IS YOURS` : "YOU HAVE A SEAT";
  card.append(sub);
  (document.getElementById("app") ?? document.body).append(card);
  diag.promotions++;
  diag.youreIn = { at: Date.now(), slot, sub: sub.textContent };
  hooks?.sfx?.("ui-go");
  window.setTimeout(() => card.remove(), 2700);
}
