/**
 * LOCAL GAME SERVER — Custom implementation of the protocol from
 * shared/protocol.ts. The authoritative simulation (GameSession from
 * shared/sim.ts) is the same engine the client runs locally in
 * offline Quick Play — per the protocol comments, exactly this sim also
 * runs on the original server ("GameSession IS the server").
 *
 * TWO OPERATING MODES (original architecture: "the server is a hub of one
 * process per map" — shared/maps/index.ts PLAN A forbids runtime map switching,
 * because the sim singletons are derived from the map at import time):
 *
 *   HUB     node dist/server.mjs [--port=8765] [--root=...]
 *           No --map → the client picks the map (?map=<id> in the
 *           WS URL or in the menu). The hub serves static + healthz and
 *           routes every /kong/ws connection to a LAZILY spawned
 *           worker process for exactly that map (TCP upgrade proxy).
 *
 *   WORKER  node dist/server.mjs --map=<id> --port=<n> [--worker]
 *           One map, all rooms (yard + private lobbies) of that map.
 *           Started by the hub; also usable standalone.
 *
 * Endpoints (hub and worker):
 *   http://host:port/kong/...            mirrored game files
 *   ws://host:port/kong/ws?map=<id>      protocol socket (= defaultWs())
 *   http://host:port/healthz             liveness check
 *
 * Rooms (worker):
 *   ""      PUBLIC MATCH — always live, bot backfill up to seatsFor(map, mode),
 *           rollover on score limit or clock, then a fresh match.
 *   "CODE"  PRIVATE MATCH — pre-game lobby; the host starts via
 *           t:"startmatch", 3200 ms countdown, then live.
 */
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket as WsConn } from "ws";

// ---------------------------------------------------------------------------
// CLI / ENV
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argVal(name: string): string | undefined {
  for (const a of argv) if (a.startsWith(name)) return a.slice(name.length) || undefined;
  return undefined;
}

const VALID_MAPS = new Set(["shipment", "dust2", "ares", "nuketown"]);

const MAP_ARG = argVal("--map=");
const SERVER_MAP = (() => {
  let m = process.env.SHIPMENT_MAP ?? "";
  if (MAP_ARG) m = MAP_ARG;
  return VALID_MAPS.has(m) ? m : "nuketown";
})();
const IS_WORKER = !!MAP_ARG || !!process.env.SHIPMENT_MAP;

const PORT = Number(argVal("--port=") ?? process.env.KONG_PORT ?? 8765) || 8765;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Web root: client/public is the 1:1 mirror of the original client (path
// relative to the repo root, i.e. two levels up from server/dist):
//   <kong= exists ?  serve under /kong/*  :  ROOT itself is the kong prefix
//   (strip branch) — client/public and client/dist (npm-built client) are
//   both mirror contents without a kong/ folder.
const ROOT = path.resolve(HERE, "..", "..", argVal("--root=") ?? path.join("client", "public"));

// ---------------------------------------------------------------------------
// Map geometry. shared/sim.ts builds world singletons at import time from
// the active map; shared/maps/index.ts reloads JSON maps itself via
// top-level await. On the Node side it resolves `../../public/<rel>` relative
// to the running module — server/build.mjs (plugin "maps-public-path") rewrites
// that at bundle time to `../<rel>`, so the server reads its data
// server-local from server/assets/maps (standalone package, shared/
// stays byte-identical original source).
// ---------------------------------------------------------------------------
// The dynamic import triggers the top-level-await preload in shared/maps
// (afterwards the sim singletons in shared/sim.ts are validly built).
await import("../../shared/maps");

// Engine chain from here on (sim builds on activeMap()).
import { GameSession, type SimPlayer } from "../../shared/sim";
import { MAX_PLAYABLE, MAX_SPECTATORS, COUNTDOWN_MS, inputLocked } from "../../shared/matchphase";
import type { ClientMsg, InputCmd, LobbyMember, NameCheck, NetEvent, PredictionState, ServerMsg, Snapshot, Team, MatchPhase } from "../../shared/protocol";
import { BOT_NAMES, MATCH_TIME } from "../../shared/protocol";
import { packPlayers } from "../../shared/snapshot-wire";
import { sanitizeLoadout, type Loadout } from "../../shared/loadout";
import { seatsFor, type ModeId } from "../../shared/modes";

// Seats per room: seatsFor(map, mode) — shipment 5v5/10 FFA, dust2/ares/
// nuketown 6v6/12 (shared/modes.ts MAP_SEATS). No global cap anymore: the
// client lobby UI computes with the same numbers.
const YARD_ROLLOVER_MS = 19_000; // PUBLIC_ROLLOVER_S
const LOBBY_RETURN_MS = 18_000; // LOBBY_RETURN_S
const IDLE_MS = 21_000;
const SNAP_EVERY = 2; // TICK_HZ / SNAP_HZ
const TICK_MS = 1000 / 64;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------------------------
// Static: 1:1 mirror (client/public) or built client (client/dist)
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".cur": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".hdr": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
  try {
    serveStatic(req, res);
  } catch {
    try {
      res.writeHead(500).end();
    } catch {
      /* already closed */
    }
  }
});

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let url = (req.url ?? "/").split("?")[0] ?? "/";
  url = decodeURIComponent(url);
  if (url === "/") {
    res.writeHead(302, { Location: `/kong/?map=${REDIRECT_MAP}` });
    res.end();
    return;
  }
  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(describeStatus());
    return;
  }
  // URL /kong/<path>  →  file <ROOT>/<path> (mirror layout).
  // client/public AND client/dist are mirror contents without a kong/ folder —
  // so the /kong prefix is stripped: /kong/<path> → <ROOT>/<path>.
  let rel = url.replace(/^\//, "");
  if (fs.existsSync(path.join(ROOT, "kong"))) {
    // Classic layout <ROOT>/kong/: URL stays 1:1 with the mirror structure
    if (rel === "kong" || rel === "kong/") rel = "kong/index.html";
  } else if (rel === "kong" || rel === "kong/") {
    // Build layout: page lives at dist/index.html
    rel = "index.html";
  } else if (rel.startsWith("kong/")) {
    rel = rel.slice("kong/".length);
  }
  if (rel === "" ) rel = "index.html";
  if (rel.endsWith("/")) rel += "index.html";
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><h1>404</h1>");
    return;
  }
  const isAsset = rel.includes("/assets/");
  const stat = fs.statSync(abs);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": isAsset ? "public, max-age=86400, immutable" : "no-cache",
  });
  fs.createReadStream(abs).pipe(res);
}

// ---------------------------------------------------------------------------
// Names / codes
// ---------------------------------------------------------------------------
function cleanName(raw: unknown): string {
  const n = String(raw ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14)
    .trim();
  return n || "GRUNT";
}

function dedupeName(name: string, taken: string[]): string {
  const low = taken.map((t) => t.toLowerCase());
  if (!low.includes(name.toLowerCase())) return name;
  for (let i = 2; i <= 9; i++) {
    const cand = `${name} ${i}`.slice(0, 14);
    if (!low.includes(cand.toLowerCase())) return cand;
  }
  return `${name.slice(0, 10)} ${Math.floor(Math.random() * 900) + 100}`.trim();
}

function cleanRoomCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,16}$/.test(code)) return null;
  return code;
}

// ---------------------------------------------------------------------------
// Sanitize input (finite numbers only, clamped values)
// ---------------------------------------------------------------------------
function num(v: unknown, dflt = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function sanitizeCmd(c: unknown): InputCmd | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const dt = Math.min(0.15, Math.max(0, num(o.dt, 1 / 64)));
  if (dt <= 0) return null;
  const wrapYaw = (v: number): number => {
    const wrapped = ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return wrapped;
  };
  return {
    seq: Math.max(0, Math.floor(num(o.seq))) || 0,
    dt,
    ax: Math.max(-1, Math.min(1, num(o.ax))),
    az: Math.max(-1, Math.min(1, num(o.az))),
    jump: o.jump === true,
    crouch: o.crouch === true,
    sprint: o.sprint === true,
    tac: o.tac === true,
    ads: o.ads === true,
    yaw: wrapYaw(num(o.yaw)),
    pitch: Math.max(-1.45, Math.min(1.45, num(o.pitch))),
    fire: o.fire === true,
    reload: o.reload === true,
    melee: o.melee === true,
    weapon: typeof o.weapon === "string" ? o.weapon.slice(0, 16) : "",
    clientTime: num(o.clientTime),
    rt: Number.isFinite(Number(o.rt)) ? Number(o.rt) : undefined,
    ox: num(o.ox),
    oy: num(o.oy),
    oz: num(o.oz),
    dx: num(o.dx),
    dy: num(o.dy),
    dz: num(o.dz),
    nade: o.nade === true,
    nadeHold: o.nadeHold === true,
  };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
type Seat = {
  ws: WsConn;
  id: string;
  name: string;
  joinedAt: number;
  spectator: boolean;
  packed: boolean;
  queue: InputCmd[];
  ping: number;
  lastSeen: number;
  loadout: Loadout;
  slot: number;
  team: Team;
  chatTimes: number[];
  closed: boolean;
};

function memberOf(s: Seat): LobbyMember {
  return {
    id: s.id,
    name: s.name,
    slot: s.spectator ? 0 : s.slot,
    host: false,
    spectator: s.spectator,
    since: s.joinedAt,
  };
}

let seatSeq = 0;

class Room {
  id: string; // "" = PUBLIC YARD, sonst Code
  kind: "yard" | "private";
  session: GameSession;
  host: string | null = null;
  seats = new Map<string, Seat>();
  botSeq = 0;
  overAt = 0;
  startAtWall = 0;
  emptySince = 0;
  /** Seats (humans+bots) of this room: seatsFor(map, mode). */
  seatCount: number;

  constructor(id: string, kind: "yard" | "private", mode: ModeId) {
    this.id = id;
    this.kind = kind;
    this.seatCount = seatsFor(SERVER_MAP, mode);
    this.session = new GameSession();
    this.session.mode = mode;
    if (kind === "yard") {
      this.session.remain = MATCH_TIME;
      for (let i = 0; i < this.seatCount; i++) this.addBot((i % 2) as Team);
      this.session.nextMatch();
    } else {
      // GameSession defaults to "live" (for qa/rigs/Quick Play). A private
      // room ALWAYS starts in the pre-game lobby; the host starts the match.
      this.session.phase = "pregame";
    }
  }

  get phase(): MatchPhase {
    return this.session.phase;
  }

  get mode(): ModeId {
    return this.session.mode === "ffa" ? "ffa" : "tdm";
  }

  playableHumans(): Seat[] {
    const out: Seat[] = [];
    for (const s of this.seats.values()) if (!s.spectator) out.push(s);
    return out;
  }

  spectators(): Seat[] {
    const out: Seat[] = [];
    for (const s of this.seats.values()) if (s.spectator) out.push(s);
    return out;
  }

  allNames(): string[] {
    const out: string[] = [];
    for (const s of this.seats.values()) out.push(s.name);
    return out;
  }

  addBot(team: Team): void {
    const id = `bot-${this.botSeq++}`;
    const taken = new Set([...this.session.players.values()].map((p) => p.name));
    let name = BOT_NAMES[(this.botSeq - 1) % BOT_NAMES.length] ?? "GRUNT";
    while (taken.has(name.toLowerCase())) name = dedupeName(name, [...taken]);
    const primary = ["ar", "smg", "sniper"][(this.botSeq - 1) % 3] ?? "ar";
    const p = this.session.addPlayer(id, name, "bruiser", team, primary, "", true);
    // Bots get their trigger clock from the sim tick itself (netFed=false).
    p.netFed = false;
  }

  humanTeamCounts(): [number, number] {
    const counts: [number, number] = [0, 0];
    for (const p of this.session.players.values()) {
      if (p.bot) continue;
      counts[p.team]++;
    }
    return counts;
  }

  pickTeam(): Team {
    const c = this.humanTeamCounts();
    return c[0] <= c[1] ? (0 as Team) : (1 as Team);
  }

  botCount(): number {
    let n = 0;
    for (const p of this.session.players.values()) if (p.bot) n++;
    return n;
  }

  nextSlot(): number {
    const used = new Set(this.playableHumans().map((s) => s.slot));
    for (let i = 1; i <= this.seatCount; i++) if (!used.has(i)) return i;
    return 1;
  }

  send(seat: Seat, msg: ServerMsg): void {
    if (seat.closed || seat.ws.readyState !== 1) return;
    try {
      seat.ws.send(JSON.stringify(msg));
    } catch {
      /* closes anyway right after */
    }
  }

  seatBody(seat: Seat): SimPlayer | null {
    return this.session.players.get(seat.id) ?? null;
  }

  countdownAtWall(): number {
    // sim.liveAt (sim seconds) → wall-clock ms for the clients (same machine).
    return Date.now() + Math.round((this.session.liveAt - this.session.time) * 1000);
  }

  // ------------------------------------------------------------ Join/Leave
  addSeat(ws: WsConn, name: string, packed: boolean): Seat {
    const clean = dedupeName(cleanName(name), this.allNames());
    const id = `p${++seatSeq}`;
    const playableFull = this.playableHumans().length >= this.seatCount;
    const spectFull = this.spectators().length >= MAX_SPECTATORS;
    const seat: Seat = {
      ws,
      id,
      name: clean,
      joinedAt: Date.now(),
      spectator: playableFull || spectFull,
      packed,
      queue: [],
      ping: 0,
      lastSeen: Date.now(),
      loadout: sanitizeLoadout({ primary: "ar", secondary: "pistol", lethal: "frag" }),
      slot: 0,
      team: 0,
      chatTimes: [],
      closed: false,
    };
    if (!seat.spectator) {
      seat.slot = this.nextSlot();
      seat.team = this.pickTeam();
      // Yard: human body from now on; private round only once it has
      // already started (in the pre-game lobby the body is created at START).
      if (this.kind === "yard" || this.phase !== "pregame") this.ensureBody(seat);
      // Yard always full like this: as many humans + bots as seats.
      while (this.kind === "yard" && this.session.players.size > this.seatCount) {
        const before = this.session.players.size;
        const d = [...this.session.players.values()].findLast((p) => p.bot);
        if (!d || this.session.players.size === 0) break;
        this.session.remove(d.id);
        if (this.session.players.size === before) break;
      }
    }
    this.seats.set(id, seat);
    if (this.kind === "private" && !this.host) this.host = id;
    this.welcome(seat);
    return seat;
  }

  ensureBody(seat: Seat): void {
    if (seat.spectator) return;
    const existing = this.session.players.get(seat.id);
    if (!existing) {
      const p = this.session.addPlayer(seat.id, seat.name, "bruiser", seat.team, seat.loadout.primary, "", false);
      p.netFed = true;
      p.ping = seat.ping;
      return;
    }
    // Reconnects/takeovers: refresh name/loadout, team only pre-game.
    existing.name = seat.name;
    existing.loadout = sanitizeLoadout(seat.loadout);
    if (this.session.phase !== "live") existing.team = seat.team;
  }

  dropSeat(seat: Seat): void {
    if (!this.seats.delete(seat.id)) return;
    // Body gone (no frozen corpse left in the yard).
    this.session.remove(seat.id);
    if (this.kind === "private" && this.host === seat.id) {
      const rest = this.playableHumans().sort((a, b) => a.joinedAt - b.joinedAt);
      this.host = rest[0]?.id ?? null;
    }
    if (!seat.spectator) {
      const waiting = this.spectators()[0];
      if (waiting) {
        this.promote(waiting);
      } else if (this.kind === "yard" && this.session.players.size < this.seatCount) {
        this.addBot(this.pickTeam());
      }
    }
    this.broadcastLobby();
  }

  promote(s: Seat): void {
    s.spectator = false;
    s.slot = this.nextSlot();
    s.team = this.pickTeam();
    this.ensureBody(s);
    this.send(s, { t: "promoted", slot: s.slot });
    this.broadcastLobby();
  }

  // ------------------------------------------------------------ Start
  startMatch(fromSeat: Seat): void {
    if (this.kind !== "private" || this.phase !== "pregame" || this.host !== fromSeat.id) {
      this.send(fromSeat, { t: "err", msg: "ONLY THE LOBBY HOST CAN START" });
      return;
    }
    // Clear everything (empty after lobby return from the last match) and rebuild.
    for (const id of [...this.session.players.keys()]) this.session.remove(id);
    const ffa = this.mode === "ffa";
    const half = this.seatCount / 2;
    const c: [number, number] = [0, 0];
    const humans = this.playableHumans().sort((a, b) => a.joinedAt - b.joinedAt);
    for (const s of humans) {
      let team: Team;
      if (ffa) {
        team = c[0] <= c[1] ? 0 : 1 as Team;
      } else {
        team = (c[0] < half ? 0 : 1) as Team;
      }
      s.team = team;
      const body = this.session.addPlayer(s.id, s.name, "bruiser", team, s.loadout.primary, "", false);
      body.netFed = true;
      body.ping = s.ping;
      c[team]++;
    }
    // Bot backfill: the weaker team is filled up to the seat count.
    while (this.session.players.size < this.seatCount) {
      const team = (c[0] <= c[1] ? 0 : 1) as Team;
      this.addBot(team);
      c[team]++;
    }
    // Fresh match: score 0, respawn, clock reset, countdown tick.
    this.session.nextMatch();
    this.session.beginCountdown(COUNTDOWN_MS);
    const startAt = Date.now() + COUNTDOWN_MS;
    this.startAtWall = startAt;
    for (const s of this.seats.values()) this.send(s, { t: "start", startAt });
    this.broadcastLobby();
  }

  // ------------------------------------------------------------ Lobby
  broadcastLobby(): void {
    if (this.kind !== "private") return;
    const members = this.playableHumans().map(memberOf);
    for (const m of members) m.host = m.id === this.host;
    const spec = this.spectators().map(memberOf);
    const botFill = Math.max(0, this.seatCount - members.length);
    for (const s of this.seats.values()) {
      this.send(s, {
        t: "lobby",
        room: this.id,
        mode: this.mode,
        map: SERVER_MAP,
        phase: this.phase,
        startAt: this.startAtWall,
        you: s.id,
        host: this.host ?? "",
        maxPlayable: this.seatCount,
        maxSpectators: MAX_SPECTATORS,
        players: members.map((m) => ({ ...m })),
        spectators: spec.map((m) => ({ ...m })),
        botFill,
      });
    }
  }

  welcome(seat: Seat): void {
    this.send(seat, {
      t: "welcome",
      id: seat.id,
      room: this.id,
      name: seat.name,
      spectator: seat.spectator,
      phase: this.phase,
      startAt: this.phase === "countdown" ? this.countdownAtWall() : undefined,
    });
    if (this.kind === "private") this.broadcastLobby();
  }

  // ------------------------------------------------------------ Messages
  onMessage(seat: Seat, msg: unknown): void {
    seat.lastSeen = Date.now();
    const m = msg as Partial<ClientMsg>;
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "in": {
        if (seat.spectator || !this.seatBody(seat)) return;
        const cmd = sanitizeCmd(m.cmd);
        if (!cmd) return;
        seat.queue.push(cmd);
        while (seat.queue.length > 32) seat.queue.shift();
        return;
      }
      case "inb": {
        if (seat.spectator || !Array.isArray(m.c)) return;
        for (const raw of m.c.slice(-8)) {
          const cmd = sanitizeCmd(raw);
          if (cmd) seat.queue.push(cmd);
        }
        while (seat.queue.length > 32) seat.queue.shift();
        return;
      }
      case "ping": {
        if (typeof m.rtt === "number" && m.rtt >= 0 && m.rtt < 1000) {
          seat.ping = Math.round(m.rtt);
          const p = this.seatBody(seat);
          if (p) p.ping = seat.ping;
        }
        this.send(seat, { t: "pong", t0: typeof m.t0 === "number" ? m.t0 : Date.now(), t1: Date.now() });
        return;
      }
      case "loadout": {
        seat.loadout = sanitizeLoadout(m.loadout);
        const p = this.seatBody(seat);
        if (p) this.session.setLoadout(p, seat.loadout);
        return;
      }
      case "chat": {
        const text = String(m.text ?? "")
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .trim()
          .slice(0, 80);
        if (!text) return;
        const now = Date.now();
        seat.chatTimes = seat.chatTimes.filter((t) => now - t < 3000);
        if (seat.chatTimes.length >= 8) return;
        seat.chatTimes.push(now);
        this.session.events.push({ t: "chat", name: seat.name, text });
        return;
      }
      case "startmatch":
        this.startMatch(seat);
        return;
      case "lobbyq":
        if (this.kind === "private") this.broadcastLobby();
        return;
      case "aux":
        // UDP fast path (optional): just an ack — the WebSocket keeps running.
        this.send(seat, { t: "auxok" });
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------ Tick
  tick(): void {
    const dt = 1 / 64;
    const empty = this.seats.size === 0;
    if (empty && this.overAt === 0) {
      if (!this.emptySince) this.emptySince = Date.now();
      return;
    }
    this.stepInputs();
    this.session.step(dt);
    // Match finished → roll over fresh / return to lobby after a delay.
    if (this.session.over && this.overAt === 0) this.overAt = Date.now();
    if (this.session.over && this.overAt !== 0) {
      const wait = this.kind === "yard" ? YARD_ROLLOVER_MS : LOBBY_RETURN_MS;
      if (Date.now() - this.overAt >= wait) {
        this.overAt = 0;
        this.session.nextMatch();
        if (this.kind === "private") {
          this.session.phase = "pregame";
          this.session.liveAt = 0;
          this.startAtWall = 0;
          // Spectators into free seats instead of bots (they reclaim the vacated
          // slot; if none is free they stay on the bench).
          for (const s of [...this.spectators()]) {
            if (this.session.players.size >= SEATS) break;
            this.promote(s);
          }
          this.broadcastLobby();
        } else if (this.session.players.size < this.seatCount) {
          this.addBot(this.pickTeam());
        }
      }
    }
    if (this.session.tick % SNAP_EVERY === 0) this.broadcastSnaps();
  }

  stepInputs(): void {
    for (const s of this.seats.values()) {
      if (s.spectator) continue;
      const p = this.session.players.get(s.id);
      if (!p) {
        s.queue.length = 0;
        continue;
      }
      if (!p.alive) {
        // applyInput still acks dead moves (p.seq = cmd.seq):
        while (s.queue.length) {
          const cmd = s.queue.shift()!;
          p.seq = cmd.seq;
        }
        continue;
      }
      // Trigger clock: bank on wall clock, consume per command.
      this.session.bankCommandTime(p, 1 / 64);
      p.netFed = true;
      while (s.queue.length) {
        const cmd = s.queue.shift()!;
        this.session.applyInput(p, cmd, true);
        this.session.creditCommandTime(p, cmd.dt);
      }
    }
  }

  broadcastSnaps(): void {
    const ev: NetEvent[] = this.session.drainEvents();
    const playersRaw: PlayerSnap[] = this.session.snap();
    const nades = this.session.nadeSnap();
    const round = this.session.roundSnap();
    const countWall = this.phase === "countdown" ? this.countdownAtWall() : undefined;
    const footer = {
      score0: this.session.score0,
      score1: this.session.score1,
      remain: this.session.remain,
      mode: this.mode,
      map: SERVER_MAP,
      round,
      nades,
      ph: this.phase,
    };
    void footer;
    for (const s of this.seats.values()) {
      const snap: Snapshot = {
        t: "snap",
        tick: this.session.tick,
        time: this.session.time,
        you: s.id,
        prediction: this.predictionFor(s),
        score0: this.session.score0,
        score1: this.session.score1,
        remain: this.session.remain,
        mode: this.mode,
        map: SERVER_MAP,
        round,
        players: s.packed ? (packPlayers(playersRaw) as unknown as PlayerSnap[]) : playersRaw,
        nades,
        ev,
        phase: this.phase,
        startAt: countWall,
        spectator: s.spectator,
      };
      if (s.packed) {
        // set "packed:1" for the client so decodeServerMessage responds.
        (snap as unknown as { packed?: 1 }).packed = 1;
      }
      this.send(s, snap as unknown as Snapshot);
    }
  }

  predictionFor(seat: Seat): PredictionState | undefined {
    if (seat.spectator) return undefined;
    const p = this.session.players.get(seat.id);
    if (!p || p.bot) return undefined;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      vx: p.vx,
      vy: p.vy,
      vz: p.vz,
      onGround: p.onGround,
      wantAds: p.wantAds,
      tacFuel: p.tacFuel,
      slide: p.slide,
      slideVx: p.slideVx,
      slideVz: p.slideVz,
      ads: p.ads,
      reload: p.reload,
      sprintOut: p.sprintOut,
      fireCd: p.fireCd,
      swap: p.swap,
      nadeCd: p.nadeCd,
      heat: p.heat,
      shotAgo: p.shotAgo,
      armed: p.armed,
      cook: p.cook,
    };
  }

  namecheck(msg: Partial<ClientMsg>): NameCheck {
    const clean = dedupeName(cleanName(msg.name), this.allNames());
    const playableFull = this.playableHumans().length >= this.seatCount;
    const spectFull = this.spectators().length >= MAX_SPECTATORS;
    return {
      t: "namecheck",
      ok: true,
      name: clean,
      room: {
        id: this.id,
        exists: true,
        mode: this.mode,
        map: SERVER_MAP,
        players: this.playableHumans().length,
        spectators: this.spectators().length,
        maxPlayable: this.seatCount,
        maxSpectators: MAX_SPECTATORS,
        phase: this.phase,
        spectate: playableFull,
        full: playableFull && spectFull,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------
const rooms = new Map<string, Room>();
if (!IS_WORKER && !argVal("--map=")) {
  // HUB mode: rooms live in the map workers — create nothing here.
} else {
  rooms.set("", new Room("", "yard", "tdm"));
}

function getOrCreateRoom(code: string, mode: ModeId): Room {
  const existing = rooms.get(code);
  if (existing) return existing;
  const r = new Room(code, "private", mode);
  rooms.set(code, r);
  return r;
}

function yardRoom(): Room {
  return rooms.get("") as Room;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of [...rooms]) {
    for (const s of [...r.seats.values()]) {
      if (now - s.lastSeen > IDLE_MS) {
        const ws = s.ws;
        r.dropSeat(s);
        try {
          ws.terminate();
        } catch {
          /* already closed */
        }
      }
    }
    if (code !== "" && r.seats.size === 0) {
      if (!r.emptySince) r.emptySince = now;
      if (now - r.emptySince > 5 * 60_000) rooms.delete(code);
    } else if (r.seats.size > 0) {
      r.emptySince = 0;
    }
  }
}, 1000);

// Tick loop with catch-up: Windows setInterval has ~15.6 ms granularity,
// a bare setInterval(TICK_MS) would run the 64 Hz sim at half rate.
// Hence accumulator: on each timer fire, catch up all elapsed ticks
// (capped so a stall doesn't replay the whole backlog).
if (rooms.size > 0 || IS_WORKER) {
  let tickAcc = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (tickAcc < now - 200) tickAcc = now; // Stall (sleep, GC): re-anchor
    let steps = 0;
    while (tickAcc <= now && steps < 8) {
      for (const r of rooms.values()) {
        try {
          r.tick();
        } catch (e) {
          console.error(`[room ${r.id || "yard"}] tick`, e);
        }
      }
      tickAcc += TICK_MS;
      steps++;
    }
  }, 4);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

if (IS_WORKER) {
  // WORKER: exactly one map. A ?map= mismatch stays an error (the hub
  // routes correctly; this only protects direct connections).
  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url ?? "/", "http://x");
      if (!u.pathname.endsWith("/ws")) {
        socket.destroy();
        return;
      }
      const mapQ = u.searchParams.get("map");
      if (mapQ && VALID_MAPS.has(mapQ) && mapQ !== SERVER_MAP) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.send(
            JSON.stringify({
              t: "err",
              msg: `This server runs ${SERVER_MAP.toUpperCase()}. Reload with ?map=${SERVER_MAP}`,
            }),
          );
          ws.close();
        });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });
}

// ---------------------------------------------------------------------------
// HUB: one process per map, spawned lazily; the WS upgrade is passed
// through via TCP (the worker performs its own upgrade handshake).
// ---------------------------------------------------------------------------
const WORKER_ORDER = ["shipment", "dust2", "ares", "nuketown"] as const;
const workerPorts = new Map<string, number>();
const workers = new Map<string, { port: number; child: ChildProcess | null }>();
const spawning = new Map<string, Promise<number>>();

for (let i = 0; i < WORKER_ORDER.length; i++) {
  workerPorts.set(WORKER_ORDER[i], PORT + 101 + i);
}

function workerPortFor(map: string): number | undefined {
  return workerPorts.get(map) ?? PORT + 101 + WORKER_ORDER.length;
}

function tcpAlive(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

/** Start the worker for a map (or reuse it) and wait until it listens. */
async function ensureWorker(map: string): Promise<number | null> {
  const port = workerPortFor(map);
  if (!port) return null;
  const existing = workers.get(map);
  if (existing) {
    if (await tcpAlive(port)) return port;
    if (existing.child) {
      try {
        existing.child.kill();
      } catch {
        /* already dead */
      }
    }
    workers.delete(map);
  }
  // Multiple simultaneous upgrades: only ONE spawn per map.
  let inflight = spawning.get(map);
  if (!inflight) {
    inflight = (async () => {
      // If something from an EARLIER run is still listening on the port:
      // reuse it instead of crashing.
      if (await tcpAlive(port)) return port;
      const args = [
        path.join(HERE, "server.mjs"),
        "--worker",
        `--map=${map}`,
        `--port=${port}`,
      ];
      const child = spawn(process.execPath, args, {
        stdio: "ignore",
        detached: false,
        env: { ...process.env, KONG_WORKER_FOR: map },
      });
      workers.set(map, { port, child });
      console.log(`[kong-hub] worker ${map} -> :${port} (pid ${child.pid})`);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await tcpAlive(port)) return port;
        await new Promise((r) => setTimeout(r, 150));
      }
      console.error(`[kong-hub] worker ${map} not responding`);
      return null;
    })();
    spawning.set(map, inflight);
    try {
      return await inflight;
    } finally {
      spawning.delete(map);
    }
  }
  return inflight;
}

/** Pass upgrade bytes 1:1 to the worker, then pipe bidirectionally. */
function proxyUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, port: number): void {
  const upstream = net.connect({ port, host: "127.0.0.1" });
  let sent = false;
  upstream.on("connect", () => {
    // Request line + original headers (the worker knows none of the header
    // details in the strict sense, but the ws upgrade wants the Sec-WebSocket keys).
    const lines = [`GET ${req.url ?? "/"} HTTP/1.1`];
    for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1] ?? "";
      if (k.toLowerCase() === "connection") lines.push("Connection: Upgrade");
      else lines.push(`${k}: ${v}`);
    }
    if (!req.rawHeaders.some((h, i) => i % 2 === 0 && h.toLowerCase() === "connection")) {
      lines.push("Connection: Upgrade", "Upgrade: websocket");
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    sent = true;
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const kill = () => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  };
  upstream.on("error", kill);
  socket.on("error", kill);
  socket.on("close", () => {
    if (sent) {
      try {
        upstream.destroy();
      } catch {
        /* ignore */
      }
    } else kill();
  });
}

if (!IS_WORKER) {
  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url ?? "/", "http://x");
      if (!u.pathname.endsWith("/ws")) {
        socket.destroy();
        return;
      }
      const mapQ = u.searchParams.get("map");
      const map = mapQ && VALID_MAPS.has(mapQ) ? mapQ : "nuketown";
      ensureWorker(map)
        .then((port) => {
          if (port) proxyUpgrade(req, socket, head, port);
          else {
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        });
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });
  process.on("exit", () => {
    for (const w of workers.values()) {
      try {
        w.child?.kill();
      } catch {
        /* ignore */
      }
    }
  });
}

function onSocket(ws: WsConn): void {
  let seat: Seat | null = null;
  let room: Room | null = null;

  ws.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const m = msg as Partial<ClientMsg>;
    if (!m || typeof m !== "object" || typeof m.t !== "string") return;

    if (m.t === "checkname") {
      const asked = cleanRoomCode(m.room);
      if (!asked) {
        ws.send(JSON.stringify({ t: "namecheck", ok: true, name: dedupeName(cleanName(m.name), []) }));
        return;
      }
      const r = rooms.get(asked);
      if (!r) {
        // NoSuchRoom case: created on join of this code.
        const md: ModeId = m.mode === "ffa" ? "ffa" : "tdm";
        ws.send(
          JSON.stringify({
            t: "namecheck",
            ok: true,
            name: dedupeName(cleanName(m.name), []),
            room: {
              id: asked,
              exists: false,
              mode: md,
              map: SERVER_MAP,
              players: 0,
              spectators: 0,
              maxPlayable: seatsFor(SERVER_MAP, md),
              maxSpectators: MAX_SPECTATORS,
              phase: "pregame",
              spectate: false,
              full: false,
            },
          }),
        );
        return;
      }
      r.seats.size; // touch
      ws.send(JSON.stringify(r.namecheck(m)));
      return;
    }

    if (m.t === "join") {
      if (room && seat) return;
      const mode: ModeId = m.mode === "ffa" ? "ffa" : "tdm";
      const code = cleanRoomCode(m.room);
      const target = code ? getOrCreateRoom(code, mode) : yardRoom();
      if (target.seats.size >= target.seatCount + MAX_SPECTATORS) {
        ws.send(JSON.stringify({ t: "err", msg: "server full" }));
        ws.close();
        return;
      }
      room = target;
      seat = target.addSeat(ws, cleanName(m.name), m.snapshotFormat === "compact-v1");
      if (m.loadout && typeof m.loadout === "object") {
        seat.loadout = sanitizeLoadout(m.loadout);
        const p = target.seatBody(seat);
        if (p) target.session.setLoadout(p, seat.loadout);
      }
      return;
    }

    if (seat && room) room.onMessage(seat, msg);
  });

  ws.on("close", () => {
    if (seat) {
      seat.closed = true;
      room?.dropSeat(seat);
    }
    seat = null;
    room = null;
  });
  ws.on("error", () => {
    /* onclose handles it */
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const REDIRECT_MAP = IS_WORKER ? SERVER_MAP : "nuketown";

function describeStatus(): string {
  if (IS_WORKER) return `ok map=${SERVER_MAP}`;
  const parts: string[] = [];
  for (const [map, w] of workers) parts.push(`${map}:${w.child?.pid ?? 0}`);
  return `ok hub workers=${parts.join(",") || "-"}`;
}

server.listen(PORT, () => {
  if (IS_WORKER) {
    console.log(`[kong-worker] map=${SERVER_MAP} seats=${seatsFor(SERVER_MAP, "tdm")}`);
    console.log(`[kong-worker] http://localhost:${PORT}/kong/?map=${SERVER_MAP}`);
    console.log(`[kong-worker] ws:      ws://localhost:${PORT}/kong/ws`);
  } else {
    console.log(`[kong-hub] mode: HUB — client picks the map (?map=), workers start lazily`);
    console.log(`[kong-hub] web root: ${ROOT}`);
    console.log(`[kong-hub] http://localhost:${PORT}/kong/`);
    console.log(`[kong-hub] ws:      ws://localhost:${PORT}/kong/ws?map=<${[...VALID_MAPS].join("|")}>`);
    console.log(`[kong-hub] worker-ports: ${WORKER_ORDER.map((m) => `${m}:${workerPortFor(m)}`).join("  ")}`);
  }
});

process.on("SIGINT", () => {
  console.log("[kong-server] SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[kong-server] SIGTERM");
  process.exit(0);
});
