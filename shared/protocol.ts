import type { MatchPhase } from "./matchphase";
import type { Loadout } from "./loadout";

export const TICK_HZ = 64;
export const TICK_DT = 1 / TICK_HZ;
export const SNAP_HZ = 32;
export const INPUT_HZ = 64;
/**
 * Hard ceiling on lag compensation: how far into the past the server will ever
 * rewind a body to resolve a shot, and therefore the entire favour-the-shooter
 * budget. Applied in GameSession.hitscan, against the server's own clock.
 *
 * It has to cover the envelope an HONEST shot needs, which is the round trip
 * (the command's own age when the server drains it) plus the interpolation
 * delay the shooter's screen sits behind that:
 *
 *     RTT + INTERP_MS + jitter  =  200 + 80 + 40  =  320 ms
 *
 * on the meanest connection this game is measured on — qa/netlab's 200 ms +-40
 * profile, whose report prints exactly that as `envelopeNeededMs: 320`, with
 * `withinCap: false` against the old 250. The per-shot solve on that profile
 * agrees: the rewind needed to intersect the pose the shooter actually saw came
 * out at a median 286 ms (qa/out/baseline/netlab-SHIPPED.json) and 306 ms
 * (netlab-FINAL.json), both past a 250 ms cap. A shot clipped by the cap is a
 * miss on a body the shooter had dead centre.
 *
 * 350 clears the envelope with one tick of margin and stops there. The cost is
 * bounded and is only ever drawn by the shooter's own latency: a 60 ms player's
 * commands are ~60 ms old when they land, so they can pull ~60 + MAX_RENDER_LAG
 * and no more. Nobody is shot round a corner they left half a second ago.
 */
export const REWIND_MS = 350;
export const INTERP_MS = 80;
/**
 * Hard ceiling on bodies in one GameSession (humans + bots). dust2 FFA seats 15
 * (DUST2_FFA_SEATS) and a room can carry a promoted spectator's body for a tick
 * while a bot is trimmed, so this sits one above the largest seat count.
 */
export const MAX_PLAYERS = 16;
/** Team modes end at this many TEAM kills — same 25 the FFA limit uses, so
 *  every mode is "first to 25 or the clock", whichever lands first. */
export const SCORE_LIMIT = 25;
/**
 * TEAM KILL LIMIT PER MAP. Nuketown's team deathmatch runs to 100 — a
 * twelve-body cul-de-sac is a meat grinder, and 25 was over in minutes. Every
 * other map keeps SCORE_LIMIT.
 */
export const MAP_SCORE_LIMIT: Readonly<Record<string, number>> = { nuketown: 100 };
export function scoreLimit(mapId: string): number {
  return MAP_SCORE_LIMIT[mapId] ?? SCORE_LIMIT;
}
/** FFA ends the moment any single player reaches this many kills. */
export const FFA_KILL_LIMIT = 25;
/** Team deathmatch match clock, seconds: 8 min. */
export const TDM_MATCH_TIME = 8 * 60;
/** Free-for-all match clock, seconds: 10 min. */
export const FFA_MATCH_TIME = 10 * 60;
/**
 * Legacy alias for the team match clock, kept for backwards compat.
 * @deprecated Use TDM_MATCH_TIME / FFA_MATCH_TIME / matchTimeFor(mode) instead.
 */
export const MATCH_TIME = TDM_MATCH_TIME;
/** Match clock for a mode: FFA gets the 10 min clock, everything else 8 min. */
export function matchTimeFor(mode: string): number {
  return mode === "ffa" ? FFA_MATCH_TIME : TDM_MATCH_TIME;
}
/**
 * ROUND-BASED TDM (dust2 only). A team match on a map listed here plays
 * ROUNDS_TOTAL one-life rounds instead of a 25-kill race: a round ends when a
 * team is wiped (or ROUND_TIME runs out — more survivors wins, a tie scores
 * nobody), ROUND_INTERMISSION_S of result card, then everyone respawns behind a
 * fresh 3-2-1. First to ROUNDS_TO_WIN round wins ends the match early; the
 * lead is unreachable, so nothing is gained by playing the rest out.
 *
 * In this mode Snapshot.score0/score1 (and the "match" event's score0/score1)
 * ARE the round wins — the HUD scorebug and the endcard read round wins with
 * no client special case, and SCORE_LIMIT can never trip on them.
 */
export const ROUND_MAPS: readonly string[] = ["dust2"];
export const ROUNDS_TOTAL = 5;
export const ROUNDS_TO_WIN = 3;
/** Per-round clock, seconds. Rides Snapshot.remain while a round is live. */
export const ROUND_TIME = 120;
/** Result-card beat between a round ending and the next countdown, seconds. */
export const ROUND_INTERMISSION_S = 5;
/** Team deathmatch on a listed map plays rounds; every other mode/map is unchanged. */
export function isRoundBased(mode: string, mapId: string): boolean {
  return mode === "tdm" && ROUND_MAPS.includes(mapId);
}
/**
 * Round state on every snapshot (Snapshot.round) in round-based rooms; absent
 * everywhere else. `n` is 1-based; `state` is "live" while the round plays and
 * "end" during the intermission; `winner` is the team that took the round just
 * ended (-1 = tie / none). Per-player alive/team/name ride Snapshot.players.
 */
export type RoundState = {
  n: number;
  total: number;
  state: "live" | "end";
  winner: -1 | Team;
  wins0: number;
  wins1: number;
  /** Alive playable bodies per team right now (spectators excluded). */
  alive0: number;
  alive1: number;
};
/** Playable seats in a 3v3 team lobby — the rest of the room spectates. */
export const TDM_LOBBY_SEATS = 6;
/**
 * dust2 seat counts. The map is ~110 x 130 m against Shipment's 33 m yard, so
 * a 6-body FFA is a ghost town there: 15 bodies (humans + bot fill) in FFA and
 * 6v6 in team modes. Shipment keeps MAX_PLAYABLE / TDM_LOBBY_SEATS untouched —
 * the room picks by SERVER_MAP in game-server.ts getRoom().
 */
export const DUST2_FFA_SEATS = 15;
export const DUST2_TDM_SEATS = 12;
/**
 * The bot roster. One list, shared by the server's fill and the offline
 * DEPLOY-AGAINST-BOTS session, long enough for a 14-bot dust2 FFA. A human may
 * type any of these, so callers still uniquify against the live roster.
 */
export const BOT_NAMES: readonly string[] = [
  "Stem Scout", "Bunch Cap", "Pulp Punk", "Nana Kai", "Coco Loco", "Big Peel", "Mango Mike", "Jungle Jim", "Kong Jr", "Peel Petty",
  "Split Sid", "Plantain Pat", "Ripe Rita", "Bruise Lee", "Fibre Fay", "Bunch Bo",
];
export const SPAWN_PROTECT = 1.15;
export const RESPITE = 2.35;

export type Team = 0 | 1;

/** Half a second of honest input, including TCP stalls delivered in a burst. */
export const MAX_INPUT_QUEUE = 32;

export type InputCmd = {
  // SEQ CONTRACT: monotonically increasing per seat. The server drops any
  // command with seq <= the seat's last accepted seq on BOTH the single-input
  // path (`in`) and the bundle path (`inb`), so replays/duplicates never
  // integrate twice.
  seq: number;
  dt: number;
  ax: number;
  az: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  tac: boolean;
  ads: boolean;
  yaw: number;
  pitch: number;
  fire: boolean;
  reload: boolean;
  melee: boolean;
  /**
   * The weapon the player WANTS in hand (a weapon id). Equal to the held weapon:
   * nothing happens. Equal to the holstered one: a swap starts (shared/sim.ts
   * trySwap). Anything else is ignored — the server only ever swaps between the
   * two guns the player spawned with. Validated in server/input.ts.
   */
  weapon: string;
  clientTime: number;
  /**
   * HIT REGISTRATION — the instant this client's SCREEN was showing when the
   * command was made, on the server clock, in seconds.
   *
   * clientTime is "now" as this client estimates it; but a client never draws
   * "now". Other players are drawn from the snapshot buffer INTERP_MS behind
   * that, so the monkey you put your crosshair on is a monkey that existed at
   * clientTime - INTERP_MS (or wherever the buffer actually resolved, which is
   * why this is measured and stamped rather than assumed). The server rewinds
   * every other body to THIS timestamp, so the pose it tests is the pose you
   * shot at. Optional: bots and the offline sim never set it, and the server
   * falls back to clientTime - INTERP_MS when it is absent.
   */
  rt?: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  /** FRAG: the throw itself — true on exactly the release tick. */
  nade?: boolean;
  /**
   * FRAG: the pin is pulled and the fuse is COOKING. The sim starts the fuse on
   * the first command that carries it and burns it one tick per command; the
   * frag leaves with whatever is left when `nade` (or a dropped hold) arrives,
   * and goes off in the hand if the hold outlasts the fuse.
   */
  nadeHold?: boolean;
};

export type PlayerSnap = {
  id: string;
  seq: number;
  name: string;
  op: string;
  team: Team;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  hp: number;
  armor: number;
  weapon: string;
  ads: number;
  sprint: boolean;
  crouch: boolean;
  slide: number;
  reload: number;
  firing: boolean;
  alive: boolean;
  protect: number;
  kills: number;
  deaths: number;
  streak: number;
  ping: number;
  ammo: number;
  reserve: number;
  /** Banana frags left this life (HUD pips). */
  nades: number;
  /** Pin pulled (cooking) — drives the 3P overhand pre-swing. */
  nadeUp: boolean;
  /* ── APPENDED (weapons stream): snapshot-wire.ts field order is append-only ── */
  /** The holstered weapon's id (pistol, or the primary while the pistol is out). */
  alt: string;
  /** Rounds in the holstered weapon's magazine / its reserve. */
  altAmmo: number;
  altRes: number;
  /** Seconds left on the raise of the weapon in hand (0 = ready). */
  swap: number;
  /** Seconds the held frag has cooked (0 = no pin pulled). */
  cook: number;
  /** GUN GAME ladder progress (shared/gungame.ts); 0 in every other mode. */
  gun: number;
  /* ── APPENDED (bot flag): true for AI bodies (server addBot / offline bot fill) ── */
  /**
   * TRUE when this body is driven by the bot AI — the scoreboards badge it.
   * OPTIONAL: absent (or null) means human. Old snapshots, replays and old
   * servers predate the flag, so every decoder normalises `== null` to false
   * and every reader must treat only `=== true` (packed: `=== 1`) as a bot —
   * never truthiness, so a stray `"false"` string can never badge a human.
   */
  bot?: boolean;
};

/** One live banana frag. Replicated every snapshot; interpolated like players. */
export type NadeSnap = {
  id: number;
  src: string;
  x: number;
  y: number;
  z: number;
  /** Tumble phase (radians) — the sim owns the spin so every POV agrees. */
  spin: number;
  /** Seconds of fuse left — the danger indicator and the tick cadence read it. */
  fuse?: number;
  /**
   * What the body is DOING: 0 in the air, 1 on a surface, 2 asleep.
   *
   * One number, because the drawn frag needs three different reads (tumble,
   * log-roll, lie down flat) and deriving them from the position history alone
   * is a guess that gets the apex of a lob wrong — there, for a few frames, a
   * falling frag looks exactly like a rolling one.
   */
  st: 0 | 1 | 2;
};

export type NetEvent =
  | {
      t: "hit";
      src: string;
      dst: string;
      dmg: number;
      head: boolean;
      x: number;
      y: number;
      z: number;
      kill: boolean;
      /**
       * The shooter's command seq that landed this (hitscan only; blasts have
       * none). The shooter's client keys hitmarker dedupe on it: the old
       * 180 ms wall-clock window double-marked one bullet past 180 ms RTT and
       * swallowed confirmations outright during sustained fire.
       */
      seq?: number;
      /** The round went through a wall first (shared/penetration.ts): a wallbang. */
      wall?: boolean;
    }
  | { t: "kill"; src: string; dst: string; weapon: string; head: boolean; medal: string }
  | { t: "spawn"; id: string; x: number; y: number; z: number }
  | { t: "shot"; src: string; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; weapon: string }
  | { t: "foot"; id: string; x: number; z: number; kind: "run" | "land" | "slide" }
  | {
      t: "nade";
      id: number;
      src: string;
      x: number;
      y: number;
      z: number;
      vx: number;
      vy: number;
      vz: number;
    }
  | { t: "bounce"; id: number; x: number; y: number; z: number; hard: number }
  | { t: "boom"; id: number; src: string; x: number; y: number; z: number }
  | { t: "uav"; team: Team }
  | { t: "strike"; x: number; z: number; team: Team }
  | { t: "chat"; name: string; text: string }
  /** A spray tag on a surface (client/src/sprays.ts). */
  | { t: "spray"; src: string; tag: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }
  | { t: "match"; state: "live" | "end"; score0: number; score1: number }
  /**
   * Round-based TDM only. "end": round `round` just finished, `winner` took it
   * (-1 = timer tie, no point). "start": round `round` is beginning — the 3-2-1
   * is armed on the phase machinery, this only names the round. wins0/wins1 are
   * the round tally AFTER the event.
   */
  | { t: "round"; state: "start" | "end"; round: number; winner: -1 | Team; wins0: number; wins1: number };

export type Snapshot = {
  t: "snap";
  tick: number;
  time: number;
  you: string;
  /** Exact acknowledged state, sent only to its owner for deterministic replay. */
  prediction?: PredictionState;
  score0: number;
  score1: number;
  remain: number;
  mode: string;
  /**
   * THE MAP THIS ROOM IS SIMULATING, on every snapshot, for exactly the reason
   * `phase` rides one (see the note below): a client that joined late, or
   * reconnected, or followed an invite link that deliberately carries no map
   * must converge on the truth without having to ask.
   *
   * It is not a request and the client cannot act on it by switching — one
   * process is one map, here and in the browser (shared/maps/index.ts). What a
   * client does with a disagreement is RELOAD onto the right map, once, before
   * the world is built; what it must never do is render one map while the
   * server resolves hits against another.
   */
  map?: string;
  /** Round-based TDM only (see RoundState); absent on every other room. */
  round?: RoundState;
  players: PlayerSnap[];
  /** Live banana frags. Omitted (undefined) on frames with none. */
  nades?: NadeSnap[];
  ev: NetEvent[];
  /**
   * MATCH PHASE, on every snapshot — the cheapest possible way for any client
   * subsystem to know whether the gun is hot without subscribing to a message.
   *
   * The server owns it (shared/matchphase.ts); a client only renders it. It
   * rides the snapshot rather than being asked for because a client that
   * reconnects, or joins late, or misses the one-shot `start` broadcast must
   * still converge on the truth within one snapshot (31 ms) — a client stuck on
   * a stale phase is either a frozen player in a live match or a player shooting
   * during a countdown, and both are unrecoverable from inside the client.
   *
   * Two extra fields on a payload that already carries a dozen bodies; the
   * countdown timestamp is dropped entirely outside the countdown.
   */
  phase?: MatchPhase;
  /** Server-clock ms the match goes live. Present only during "countdown". */
  startAt?: number;
  /**
   * TRUE if the receiving seat is a spectator: no gun, no body anyone else can
   * see, and first in line for the next playable seat that frees.
   */
  spectator?: boolean;
};

export type PredictionState = {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean; wantAds: boolean;
  tacFuel: number; slide: number; slideVx: number; slideVz: number;
  ads: number; reload: number; sprintOut: number;
  fireCd: number; swap: number; nadeCd: number;
  /** Bloom heat and seconds since the last shot (the spread cone). */
  heat: number; shotAgo: number;
  /** Semi/bolt trigger re-armed (released since the last shot). */
  armed: boolean;
  /** Seconds the held frag has cooked, exact (PlayerSnap.cook is quantised). */
  cook: number;
  /**
   * Earned-time banks, exact (review HIGH-1/HIGH-2): the ghost funds both per
   * predicted command exactly like the authority funds per tick, so a snapshot
   * taken after an idle second does not reset the replay to an empty account.
   * cmdBank meters the gun clocks (server credits creditCommandTime out of
   * SimPlayer.cmdBank); moveBank meters travel (the server drains at most
   * MAX_CMDS_PER_TICK per tick out of seat.moveBank). Absent on pre-bank
   * servers — the client preserves its own ghost's values then (see ghostFrom).
   */
  cmdBank: number;
  moveBank: number;
};

/**
 * One row of the pre-game lobby roster, exactly as the panel renders it.
 * Spectators carry slot 0 — they hold no playable seat.
 */
export type LobbyMember = {
  id: string;
  name: string;
  /** 1-based playable slot number, or 0 for a spectator. */
  slot: number;
  host: boolean;
  spectator: boolean;
  /** Server-clock ms the seat joined. Orders the promotion + host queues. */
  since: number;
  /** The seat's round-trip time in ms (its own measurement), 0 = not yet known. */
  ping?: number;
};

/**
 * THE PRE-GAME LOBBY, pushed on every change (join, leave, host hand-over,
 * spectator promotion, phase change) and on request (`lobbyq`). Never per tick:
 * a lobby that nobody is joining costs nothing.
 */
export type LobbyState = {
  t: "lobby";
  room: string;
  mode: "tdm" | "ffa" | "gun";
  /** The map this room runs. Rendered on the lobby card so everyone in the
   *  room can see they are about to load the same world. */
  map: string;
  phase: MatchPhase;
  /** Server-clock ms the match goes live; 0 outside the countdown. */
  startAt: number;
  /** The receiving seat's own id, so the client can find itself in the lists. */
  you: string;
  /** Seat id of the host — the only seat whose START button does anything. */
  host: string;
  maxPlayable: number;
  maxSpectators: number;
  players: LobbyMember[];
  spectators: LobbyMember[];
  /** Bots that will fill the empty playable seats when the host starts. */
  botFill: number;
  /** GUN GAME kills per gun (host's choice). */
  gunKills?: number;
};

/**
 * Answer to `checkname`, on a throwaway connection made before the game boots.
 * `name` is the name the server WILL use — moderated and deduped inside the
 * room — so the gate can show it to the player instead of surprising them with
 * it later. A rejection carries a reason to print, never a silent rewrite.
 */
export type NameCheck = {
  t: "namecheck";
  ok: boolean;
  name: string;
  reason?: string;
  room?: {
    id: string;
    /** FALSE means this code is free — the asker would be the host. */
    exists: boolean;
    /** The room's real mode, when it exists — an invited guest's client must
     *  render the mode the HOST picked, not the one it would have picked. */
    mode?: "tdm" | "ffa" | "gun";
    /**
     * THE MAP THIS ROOM RUNS — and the whole reason the map is on the wire.
     *
     * `inviteLink()` strips every parameter except `?join=CODE` on purpose: an
     * invite may not hand a friend a different build of the game. So a guest
     * following a link has NO idea which world the host is in, and the only
     * moment it can still find out cheaply is here — the pre-boot name gate,
     * on a throwaway socket, before a single texture is loaded.
     *
     * Unlike `mode` this is present even when `exists` is false, because it is
     * really a property of the SERVER, not of the room: one process simulates
     * one map, so a room that does not exist yet will run this map the instant
     * somebody creates it. A host whose pick disagrees is told, rather than
     * being allowed to create a lobby that silently runs something else.
     */
    map?: string;
    /**
     * THE HOST JUST MOVED THIS LOBBY to another map (within the last
     * minute). A guest arriving at the old address follows it there instead of
     * being seated alone in the room everyone is leaving.
     */
    relocated?: string;
    players: number;
    spectators: number;
    maxPlayable: number;
    maxSpectators: number;
    phase: MatchPhase;
    /** Playable seats are gone: the asker joins as a spectator. */
    spectate: boolean;
    /** Nothing left at all — refuse before booting a whole game client. */
    full: boolean;
  };
};

export type ClientMsg =
  /**
   * `lobby: true` asks for a PRE-GAME LOBBY on a created room. An FFA join
   * naming a non-default room has always implied one; a TDM join cannot
   * (qa/clock-guard and the netlab join custom TDM rooms and need them live),
   * so the 3v3 lobby door says so explicitly.
   */
  /**
   * `map` is the map this CLIENT has already locked in (shared/maps resolves
   * before the first line of client code runs, so by the time a join is sent it
   * is a fact, not a wish). The server whitelists it, and answers with the map
   * it is actually simulating on every snapshot — a client that guessed wrong
   * finds out on the first frame instead of after a match of ghost hits.
   */
  | { t: "join"; name: string; team: Team | -1; room?: string; mode?: "tdm" | "ffa" | "gun"; map?: string; lobby?: boolean; snapshotFormat?: "compact-v1"; loadout?: Loadout }
  /**
   * LOADOUT CHANGE. Sanitized server-side (shared/loadout.ts sanitizeLoadout);
   * in a live match it applies at this player's NEXT spawn (CoD rule), before
   * the match goes live it re-equips at once.
   */
  | { t: "loadout"; loadout: Loadout }
  /**
   * HOST, PRE-GAME ONLY: change the lobby's mode (same room, at once) or its
   * map (the room moves: every seat is sent `relocate`). Anyone else, or a
   * room that is counting down or live, is ignored.
   */
  | { t: "lobbyset"; mode?: "tdm" | "ffa" | "gun"; map?: string; gunKills?: number }
  /**
   * HOST, PRE-GAME ONLY, and only with every seat taken and someone on the
   * bench: re-deal every seat but the host's at random — who plays, who
   * watches, and the teams.
   */
  | { t: "shuffle" }
  | { t: "in"; cmd: InputCmd }
  /**
   * UDP FAST LANE (server/udp-relay.ts). `aux` is the relay attaching to a seat
   * with the token that seat was handed on `welcome`; the socket that sends it
   * is never a seat of its own. `inb` is an input BUNDLE off the DataChannel —
   * the newest command and the few before it, oldest first, so a lost packet
   * costs nothing. Every command is deduplicated on `seq` against the
   * WebSocket's copy (server/game-server.ts enqueue), whichever lands first.
   */
  | { t: "aux"; token: string }
  | { t: "inb"; c: InputCmd[] }
  | { t: "ping"; t0: number; rtt?: number }
  | { t: "chat"; text: string }
  | { t: "spray"; tag: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }
  /**
   * NAME GATE. Sent on a throwaway socket before the client boots a game, so a
   * refused callsign costs a round trip instead of a whole match load. The
   * server checks the same name again on `join` — this is a courtesy, never a
   * permission (see server/index.ts resolveName).
   */
  | { t: "checkname"; name: string; room?: string }
  /** HOST ONLY: leave pre-game and run the countdown. Ignored from anyone else. */
  | { t: "startmatch" }
  /** "Send me the lobby again" — used after a reconnect or a late listener. */
  | { t: "lobbyq" };

export type ServerMsg =
  | Snapshot
  /** `udp`: this seat's fast-lane token (server/udp-relay.ts signalling). */
  | { t: "welcome"; id: string; room: string; name: string; spectator: boolean; phase: MatchPhase; udp?: string }
  | { t: "auxok" }
  | { t: "pong"; t0: number; t1: number }
  | { t: "err"; msg: string }
  | LobbyState
  | NameCheck
  /** shared/matchphase.ts StartMsg — the match-start handshake. */
  | { t: "start"; startAt: number }
  /** A spectator has just been given a playable seat and a fresh spawn. */
  | { t: "promoted"; slot: number; waitForRound?: boolean }
  /**
   * THE LOBBY IS MOVING TO ANOTHER MAP (the host's pick). One process is one
   * map, so the room re-opens under the same code on `map`'s server: the host
   * (`host: true`) re-creates it, everyone else follows it there.
   */
  | { t: "relocate"; map: string; room: string; mode: "tdm" | "ffa" | "gun"; host: boolean };
