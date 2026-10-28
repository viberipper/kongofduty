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
 *           routes every /ws connection to a LAZILY spawned
 *           worker process for exactly that map (TCP upgrade proxy).
 *
 *   WORKER  node dist/server.mjs --map=<id> --port=<n> [--worker]
 *           One map, all rooms (yard + private lobbies) of that map.
 *           Started by the hub; also usable standalone.
 *
 * Endpoints (hub and worker):
 *   http://host:port/...                 built game files (root-mounted)
 *   ws://host:port/ws?map=<id>           protocol socket (= defaultWs())
 *   http://host:port/healthz             liveness check
 *
 * Compat: old /kong/* page/asset/invite URLs 301 to the same path at root
 * (query preserved); /kong/ws upgrades keep working — the upgrade path
 * check is endsWith("/ws"), so the prefix is irrelevant there.
 *
 * Rooms (worker):
 *   ""      PUBLIC MATCH — always live, bot backfill up to seatsFor(map, mode),
 *           rollover on score limit or clock, then a fresh match.
 *   "CODE"  PRIVATE MATCH — pre-game lobby; the host starts via
 *           t:"startmatch", 3200 ms countdown, then live.
 */
import http from "node:http";
import crypto from "node:crypto";
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
// M6: default-bind loopback; LAN play is opt-in via --host=0.0.0.0 (or an
// explicit IP). Prevents accidentally exposing the game + static root to a
// hostile LAN (combined with CSWSH, malicious pages could otherwise reach it).
const HOST = argVal("--host=") ?? process.env.KONG_HOST ?? "127.0.0.1";

// ---------------------------------------------------------------------------
// Abuse limits (H2/H3/H4). All fail-closed: over-limit sockets get err+close,
// never silent drops that a client would retry in a hot loop.
// ---------------------------------------------------------------------------
/** Max private rooms per worker process (H2: room exhaustion). */
const MAX_PRIVATE_ROOMS = 50;
/** Max concurrent WS connections per worker (H3: global flood). */
const MAX_CONNECTIONS = 220;
/** Max concurrent WS connections from one IP (H3). */
const MAX_CONN_PER_IP = 20;
/** Per-socket message budget: 120 msgs / 1 s sliding window (H3).
 * Honest clients send `in` at 64 Hz + ping/chat — 120 gives ~2x headroom
 * for jitter/TCP-burst catch-up without killing legit play. */
const MSG_WINDOW_MS = 1000;
const MSG_MAX_PER_WINDOW = 120;
/** ping ≤ 4/s per socket; lobbyq/lobbyset/shuffle ≤ 2/s per socket (H3 fan-out). */
const PING_MIN_GAP_MS = 250;
const LOBBYQ_MIN_GAP_MS = 500;
/** Spray paint: ≥1.2 s between accepted tags per seat (the client gates 1.5 s). */
const SPRAY_MIN_GAP_MS = 1200;
/** Spray paint: server-side reach envelope (the client's own ray is 4 m). */
const SPRAY_REACH_OK = 6;
/** Spray paint: room-wide cap (the client's per-src replace is the tight rule). */
const MAX_SPRAYS = 24;
/** Text chat: at most one accepted line per seat per second (the client's
 *  send path has no throttle; this is the backstop against chat floods). */
const CHAT_MIN_GAP_MS = 1000;
/** Text chat: server-side length cap, mirroring the client's maxlength=80. */
const CHAT_MAX_LEN = 80;
/**
 * Text chat: blocked words (English core profanities + slurs). Matched
 * case-insensitively on whole words (\\b boundaries) AFTER folding the common
 * leet substitutions (4/@→a, 3→e, 1/!/∣→i, 0→o, 5/$→s, 7→t), so "SH1T" and
 * "$@slut" trip the same as the plain forms. Deliberately NOT covered (and
 * documented as such): interspersed separators ("f.u.c.k"), masked letters
 * ("f*ck"), doubled letters ("fuuuck"), non-Latin homoglyphs, and anything
 * outside this list. A hit is never broadcast — only the sender gets a
 * private `notice` (see the "chat" case below).
 */
const CHAT_BLOCKED = [
  "fuck", "motherfucker", "fucker", "shit", "bullshit", "bitch", "asshole",
  "bastard", "dick", "dickhead", "cock", "cunt", "pussy", "whore", "slut",
  "twat", "wanker", "douche", "prick", "fag", "faggot", "nigga", "nigger",
  "retard",
];
const CHAT_LEET: Record<string, string> = {
  "4": "a", "@": "a", "3": "e", "1": "i", "!": "i", "|": "i", "∣": "i", "0": "o",
  "5": "s", "$": "s", "7": "t",
};
function chatFold(s: string): string {
  return s.toLowerCase().replace(/[43!1|∣05$7@]/g, (c) => CHAT_LEET[c] ?? c);
}
const CHAT_BLOCKED_RE = CHAT_BLOCKED.map((w) => new RegExp(`\\b${w}\\b`));
/** TRUE when the (already sanitised) line contains a blocked word. */
function chatBlocked(text: string): boolean {
  const folded = chatFold(text);
  return CHAT_BLOCKED_RE.some((re) => re.test(folded));
}
/** Pre-auth upgrade socket idle timeout (H4 Slowloris). */
const UPGRADE_TIMEOUT_MS = 5000;
/** WS payload cap (H1): protocol messages are < 4 KB; 64 KB has 16x headroom. */
const WS_MAX_PAYLOAD = 64 * 1024;
/** Per-tick input drain cap (H1 speed-hack backstop): at most this many queued
 *  commands are integrated per seat per 64 Hz tick. Honest 64 Hz play drains 1;
 *  the headroom to 2 lets a TCP stall catch up out of the movement bank without
 *  ever letting a 960 cmds/s flood (120 msgs/s x 8/bundle) integrate 15x travel.
 *  Leftover stays queued for the next ticks (queue cap 32 still shifts oldest). */
const MAX_CMDS_PER_TICK = 2;
/** Movement-time bank ceiling, seconds — mirrors CMD_BANK (sim): half a second
 *  of real time, so a stall banks catch-up travel and a flood cannot mint it. */
const MOVE_BANK_MAX = 0.5;
const MOVE_TICK = 1 / 64;
/** checkname/join rate limit per socket: 10 per 10 s (M3 enumeration). */
const JOIN_WINDOW_MS = 10_000;
const JOIN_MAX_PER_WINDOW = 10;
const IP_JOIN_MAX_PER_WINDOW = 40;
const MAX_TRACKED_JOIN_IPS = 4096;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Web root: the built client (client/dist); the raw assets source is
// client/static (copied verbatim into dist by Vite's publicDir), path
// relative to the repo root, i.e. two levels up from server/dist).
// Served ROOT-MOUNTED: URL /<path> maps to file <ROOT>/<path> — there is no
// subpath (Vite base "/" — page, socket and assets share the origin root).
const ROOT = path.resolve(HERE, "..", "..", argVal("--root=") ?? path.join("client", "dist"));
// Fail-closed: --root outside the repo would serve arbitrary disk content,
// so startup aborts unless the operator documents intent explicitly via
// --allow-outside-root. In-repo roots (default client/dist, Docker
// server/empty-root) never trigger this gate.
const REPO_ROOT = path.resolve(HERE, "..", "..");
const ALLOW_OUTSIDE_ROOT = argv.some((a) => a === "--allow-outside-root");
function isOutsideRoot(relToBase: string): boolean {
  return relToBase === ".." || relToBase.startsWith(`..${path.sep}`) || path.isAbsolute(relToBase);
}
{
  // Lexical check first (covers cross-drive on win32: path.relative("C:\\repo",
  // "D:\\x") returns the absolute "D:\\x" with no ".." prefix, hence the
  // path.isAbsolute branch). Symlinked --root that is lexically inside but
  // resolves outside is caught by the realpath re-check below; per-request
  // the REAL_ROOT containment gate re-validates every file anyway.
  const relToRepo = path.relative(REPO_ROOT, ROOT);
  let outside = isOutsideRoot(relToRepo);
  if (!outside) {
    try {
      const realRoot = fs.realpathSync(ROOT);
      const realRepo = fs.realpathSync(REPO_ROOT);
      outside = isOutsideRoot(path.relative(realRepo, realRoot));
    } catch {
      /* ROOT missing (yet): lexical verdict stands */
    }
  }
  // K: fail-closed — serving arbitrary disk content outside the repo aborts,
  // unless the operator documents intent via --allow-outside-root. In-repo
  // roots (default client/dist, Docker server/empty-root) never trigger this.
  if (outside) {
    if (!ALLOW_OUTSIDE_ROOT) {
      console.error(
        `[kong] ERROR: --root ${ROOT} lies outside the repo root ${REPO_ROOT} ` +
          `(refusing to serve arbitrary disk content; pass --allow-outside-root to override).`,
      );
      process.exit(1);
    }
    console.warn(
      `[kong] WARNING: --root ${ROOT} lies outside the repo root ${REPO_ROOT} ` +
        `(--allow-outside-root given, serving anyway).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Map geometry. shared/sim.ts builds world singletons at import time from
// the active map; shared/maps/index.ts reloads JSON maps itself via
// top-level await. On the Node side it resolves `../../client/static/<rel>`
// relative to the running module — server/build.mjs (plugin "maps-static-path") rewrites
// that at bundle time to `../<rel>`, so the server reads its data
// server-local from server/assets/maps (standalone package, shared/
// stays byte-identical original source).
// ---------------------------------------------------------------------------
// The dynamic import triggers the top-level-await preload in shared/maps
// (afterwards the sim singletons in shared/sim.ts are validly built).
await import("../../shared/maps");

// Engine chain from here on (sim builds on activeMap()).
import { GameSession, type SimPlayer } from "../../shared/sim";
import { MAX_SPECTATORS, COUNTDOWN_MS } from "../../shared/matchphase";
import type { ClientMsg, InputCmd, LobbyMember, NameCheck, NetEvent, PredictionState, ServerMsg, Snapshot, Team, MatchPhase } from "../../shared/protocol";
import { BOT_NAMES, matchTimeFor, MAX_INPUT_QUEUE } from "../../shared/protocol";
import { packPlayers } from "../../shared/snapshot-wire";
import { sanitizeLoadout, type Loadout } from "../../shared/loadout";
import { seatsFor, simMode, type ModeId } from "../../shared/modes";
import { GUN_KILLS_PER_TIER, asGunKills } from "../../shared/gungame";

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
// Static: built client (client/dist)
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
      res.writeHead(500, { "X-Content-Type-Options": "nosniff" }).end();
    } catch {
      /* already closed */
    }
  }
});

// REAL_ROOT: symlink-resolved web root for the containment re-check (H).
// Falls back to ROOT when it does not exist (yet).
const REAL_ROOT: string = (() => {
  try {
    return fs.realpathSync(ROOT);
  } catch {
    return ROOT;
  }
})();

function deny(res: http.ServerResponse, status: 400 | 404 | 405, extra?: Record<string, string>): void {
  const label = status === 400 ? "Bad Request" : status === 405 ? "Method Not Allowed" : "Not Found";
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    // L3: clickjacking/referrer hardening on error pages too.
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(`<!doctype html><meta charset=utf-8><h1>${status} ${label}</h1>`);
}

function setStaticHeaders(res: http.ServerResponse): void {
  // D: nosniff on EVERY response — set centrally before any writeHead.
  // L3: SAMEORIGIN framing + no-referrer on every static response.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  // D: nosniff on EVERY response — set centrally before any writeHead,
  // so 200/302/400/404/405/healthz all carry it (writeHead merges).
  setStaticHeaders(res);
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }
  const raw = req.url ?? "/";
  const qmark = raw.indexOf("?");
  const query = qmark >= 0 ? raw.slice(qmark) : "";
  let url = qmark >= 0 ? raw.slice(0, qmark) : raw;
  try {
    url = decodeURIComponent(url);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
  // Reject null bytes (%00) up front: existsSync/stat throw on them (=> 500),
  // and a null byte can never mean a legitimate file. CR/LF + remaining
  // C0 control chars (decoded %0D%0A etc.): writeHead would throw ERR_INVALID_CHAR
  // (=> 500 via catch) — fail-closed 400 before all redirect writeHeads.
  // The query stays opaque (never decoded; encoded %0D stays opaque and safe);
  // raw literal controls in it would throw the same ERR_INVALID_CHAR —
  // hence also 400 before all redirect writeHeads.
  if (/[\r\n\x00-\x1f\x7f]/.test(url)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
  if (/[\r\n\x00-\x1f\x7f]/.test(query)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }
  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(describeStatus());
    return;
  }
  // Back-compat: the local server used to live under /kong/* (the upstream
  // original still does). Old page/asset/invite URLs 301 to the same path at
  // root, query preserved. (WS upgrades never reach here — they arrive on the
  // 'upgrade' event, where endsWith("/ws") matches /ws and /kong/ws alike.)
  if (url === "/kong" || url === "/kong/") {
    res.writeHead(301, { Location: `/${query}` });
    res.end();
    return;
  }
  if (url.startsWith("/kong/")) {
    // Open-redirect guard: "/kong//evil.com/..." would yield after naive stripping
    // "//evil.com/..." (protocol-relative, host change). Leading slashes
    // collapse → always same-origin "/...". Only the /kong/* branch affected
    // (/kong and / are constant); no absolute/network-path locations.
    const stripped = "/" + url.slice("/kong".length).replace(/^\/+/, "");
    res.writeHead(301, { Location: `${stripped}${query}` });
    res.end();
    return;
  }
  if (url === "/") {
    // No map pinned → bounce to the default map, keeping every other param
    // (?join= on invites). With ?map= the page itself is served below.
    try {
      const q = new URL(raw, "http://x").searchParams;
      if (!q.get("map")) {
        q.set("map", REDIRECT_MAP);
        res.writeHead(302, { Location: `/?${q.toString()}` });
        res.end();
        return;
      }
    } catch {
      res.writeHead(302, { Location: `/?map=${REDIRECT_MAP}` });
      res.end();
      return;
    }
  }
  // URL /<path>  →  file <ROOT>/<path> (root-mounted: no prefix to strip).
  let rel = url === "/" ? "index.html" : url.replace(/^\//, "");
  if (rel === "" ) rel = "index.html";
  if (rel.endsWith("/")) rel += "index.html";
  // Dotfile guard: Vite copies client/static/* verbatim into dist/ — a future
  // .env or other dotfile under static/ must never be served under /*.
  // NOTE: names like `..foo` are deliberately blocked here as dotfiles
  // (defence-in-depth, fail-closed — no legitimate file in dist/ starts with
  // a dot). This is NOT a traversal verdict — traversal is decided by
  // isOutsideRoot below (path.relative containment).
  // G: split on / AND \ — on win32 `\` is the separator, so a request such as
  // /assets%5c..%5c.env decodes to `assets\..\.env` and must trip the
  // guard before path.join normalizes it back to ROOT\.env.
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..")) {
    deny(res, 404);
    return;
  }
  const abs = path.join(ROOT, rel);
  // path.relative containment (no String-prefix): ROOT="/" would make
  // ROOT + sep === "//" which never matches, serving everything as 404.
  if (isOutsideRoot(path.relative(ROOT, abs)) || !fs.existsSync(abs)) {
    deny(res, 404);
    return;
  }
  // G+H: re-check AFTER normalization — the lexical check above runs on the
  // raw rel, path.join may have collapsed `..`/mixed separators. H: resolve
  // symlinks (local server, only on file-exists path) and re-check containment
  // against the resolved root; a symlink inside ROOT pointing at /etc/passwd
  // (or C:\Windows\...) must 404, never serve. Missing file -> 404, no crash.
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    deny(res, 404);
    return;
  }
  if (isOutsideRoot(path.relative(REAL_ROOT, real))) {
    deny(res, 404);
    return;
  }
  // Dotfile re-check on the normalized+resolved path (defence in depth).
  const realRel = real === REAL_ROOT ? "" : path.relative(REAL_ROOT, real);
  if (realRel.split(path.sep).some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..")) {
    deny(res, 404);
    return;
  }
  // Guarded stat (race/delete between existsSync and stat => 404, not 500).
  // The stat result is reused below for Content-Length (no double stat).
  let realStat: fs.Stats;
  try {
    realStat = fs.statSync(real);
  } catch {
    deny(res, 404);
    return;
  }
  if (!realStat.isFile()) {
    deny(res, 404);
    return;
  }
  // Cache policy on the NORMALIZED path (abs is already normalized by
  // path.join): only the hashed Vite outputs under assets/ are immutable;
  // unhashed assets get a short max-age, everything else no-cache. A raw
  // `includes("/assets/")` pre-normalization check would misclassify
  // `x/assets/../../index.html` as immutable.
  // B: the hash is the tail after the LAST dash before the extension, ≥5
  // chars, and must carry a letter AND (an uppercase letter or a digit) —
  // real Vite hashes (e.g. gi_station-B5-oVo3D.webp → tail "oVo3D"). A plain
  // length check such as /-[A-Za-z0-9_-]{6,}\./ would over-cache unhashed
  // names: "barlow-condensed-600" matches via "-condensed-600" (13), and
  // "-orange" (6) / "-billboard" (9) clear {6,} too — all would go stale for
  // 24 h. The letter+(upper|digit) rule keeps paint-red, nylon-plate,
  // paint-orange, dust2-game, dust2-radar, cnvs-billboard, export-crate and
  // barlow-condensed-600 on the short max-age. A (vanishingly rare) all-
  // lowercase hash only loses the immutable bit (safe: 3600 s, never stale).
  const normRel = path.relative(ROOT, abs);
  const slash = normRel.split(path.sep).join("/");
  const inAssets = slash === "assets" || slash.startsWith("assets/");
  const base = path.basename(abs);
  const hashTail = /-([A-Za-z0-9_]{5,})\.([A-Za-z0-9]+)$/.exec(base)?.[1] ?? "";
  const hashed = hashTail.length > 0 && /[A-Za-z]/.test(hashTail) && /[A-Z0-9]/.test(hashTail);
  // C: manifests / maps / any JSON under assets/ are content-addressed by
  // name, not by hash — a stale 3600 s copy desyncs client vs. data. Serve
  // them no-cache; the rest of unhashed assets keeps the short max-age.
  const lowerBase = base.toLowerCase();
  const staleSensitive = slash.startsWith("assets/maps/") || lowerBase.endsWith("manifest.json") || (inAssets && slash.endsWith(".json"));
  const cacheControl = staleSensitive
    ? "no-cache"
    : inAssets && hashed
      ? "public, max-age=86400, immutable"
      : inAssets
        ? "public, max-age=3600"
        : "no-cache";
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": realStat.size,
    "Cache-Control": cacheControl,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  // TOCTOU: stream the checked path (real), not the pre-resolution abs.
  // Stream errors (race/delete mid-send) must not hang the socket: destroy
  // it so the connection closes instead of stalling. Headers (incl.
  // Content-Length from statSync above) are already sent at this point.
  const stream = fs.createReadStream(real);
  stream.on("error", () => {
    try {
      res.destroy();
    } catch {
      /* already closed */
    }
  });
  // Client abort mid-send must not leave the file stream reading: destroy
  // it when the response closes (harmless on normal completion).
  res.on("close", () => {
    try {
      stream.destroy();
    } catch {
      /* already closed */
    }
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Names / codes
// ---------------------------------------------------------------------------
function cleanName(raw: unknown): string {
  // L2+M2: normalize compatibility forms and strip bidi/zero-width controls.
  // This reduces invisible formatting tricks; it does not fold homoglyphs.
  // Controls collapse to space.
  // STORED-XSS DEFENCE IN DEPTH (review LOW): <>&"' used to ride the wire raw
  // with escaping as the CLIENT's contract (lobby.ts, hud.ts, roundstrip.ts
  // esc(), game.ts escHtml) — every shipped sink escapes, but one missed sink
  // (or any third-party client) turned a callsign into whole-yard stored XSS.
  // Angle brackets are never legitimate in a callsign, so they are stripped
  // HERE, at ingress: the wire can no longer carry a tag even to a client
  // that forgets esc(). `&` and quotes still ride (double-escaping them here
  // would corrupt every correct sink), so clients MUST keep using esc().
  const n = String(raw ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/<|>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14)
    .trim();
  // "server" (any case) is reserved for system lines: a callsign with that
  // name would render next to "SERVER:" notices — as would "server 2" and
  // friends (dedupe's "name N" fallback shape). Fall back like an empty name.
  // Plain prefixes ("Serverus", "server2") stay legal: only bare "server"
  // followed by end-of-name or a space is reserved.
  if (!n || /^server( |$)/i.test(n)) return "GRUNT";
  return n;
}

function dedupeName(name: string, taken: string[]): string {
  // Defence in depth mirroring cleanName (callers pass cleaned names, but
  // dedupe is also the collision fallback): the reserved "server"/"server N"
  // pattern never assigns as-is — fall back like an empty name, then uniquify
  // below ("Serverus" etc. pass through: end-of-name/space only).
  if (/^server( |$)/i.test(name)) name = "GRUNT";
  const low = taken.map((t) => t.toLowerCase());
  // Defence in depth for the reserved name (callers pass cleaned names, but
  // dedupe is also the collision fallback): "server" is never assignable —
  // it uniquifies exactly like a taken name.
  if (!low.includes("server")) low.push("server");
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

function sanitizeCmd(c: unknown, serverNowSec: number): InputCmd | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const dt = Math.min(0.15, Math.max(0, num(o.dt, 1 / 64)));
  if (dt <= 0) return null;
  const wrapYaw = (v: number): number => {
    const wrapped = ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return wrapped;
  };
  // M4: bound aim/origin hints without clipping the full Dust2 play area.
  const clampHint = (v: unknown, lo = -128, hi = 128): number =>
    Math.max(lo, Math.min(hi, num(v)));
  const clampDirection = (v: unknown): number => Math.max(-1, Math.min(1, num(v)));
  // Input timestamps are seconds on the simulation clock, not wall-clock time.
  const ct = num(o.clientTime, serverNowSec);
  const clientTime = Math.abs(ct - serverNowSec) > 60 ? serverNowSec : ct;
  const rt = typeof o.rt === "number" && Number.isFinite(o.rt) ? o.rt : undefined;
  // weapon is inert server-side (trySwap only swaps to the holstered gun),
  // but allowlist it anyway so per-tick strings can't probe sim handling.
  const wRaw = typeof o.weapon === "string" ? o.weapon.slice(0, 16) : "";
  const weapon = wRaw === "ar" || wRaw === "smg" || wRaw === "sniper" || wRaw === "pistol" ? wRaw : "";
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
    weapon,
    clientTime,
    rt,
    ox: clampHint(o.ox),
    oy: clampHint(o.oy),
    oz: clampHint(o.oz),
    dx: clampDirection(o.dx),
    dy: clampDirection(o.dy),
    dz: clampDirection(o.dz),
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
  /** Text chat: wall-clock ms of this seat's last accepted line (rate limit). */
  lastChat: number;
  closed: boolean;
  /** H3 sliding-window message timestamps (ms). */
  msgTimes: number[];
  /** H3 per-type last-seen for ping/lobbyq/lobbyset+shuffle fan-out gates. */
  lastPing: number;
  lastLobbyQ: number;
  lastLobbySet: number;
  /** Spray paint: wall-clock ms of this seat's last accepted spray (rate limit). */
  lastSpray: number;
  /** M3 checkname/join attempts window. */
  /** H1 repeated oversize/invalid-frame violations. */
  violations: number;
  /** H1 seq-monotonic dedupe: highest input seq accepted from this seat.
   *  The protocol documents dedupe on seq; without it a replayed bundle
   *  integrates twice. Initialised to -1 so seq 0 (first command) passes. */
  lastSeq: number;
  /** H1 movement-time bank, seconds: topped up on the wall clock (1/64 per
   *  server tick, capped at MOVE_BANK_MAX) and spent TICK_DT per drained
   *  command. Parallel to SimPlayer.cmdBank (which meters only the gun
   *  clocks), so a 960 cmds/s flood cannot mint travel — sustained drain is
   *  at most 1.0 s of travel per wall-second; an idle seat that banked the
   *  full 0.5 s ceiling integrates up to ~1.5 s over its first flood second
   *  (banked burst + that second's income), then 1.0 s/s. Honest TCP-stall
   *  bursts still catch up out of what the stall banked. */
  moveBank: number;
};

function memberOf(s: Seat): LobbyMember {
  return {
    id: s.id,
    name: s.name,
    slot: s.spectator ? 0 : s.slot,
    host: false,
    spectator: s.spectator,
    since: s.joinedAt,
    ping: s.ping,
  };
}

let seatSeq = 0;
function nextSeatId(): string {
  // L1: sequential p1/p2/... leaks total-join count/uptime. Random 64-bit
  // suffix — unguessable, still log-friendly. seatSeq kept for logs only.
  seatSeq++;
  return `p-${crypto.randomBytes(8).toString("hex")}`;
}

class Room {
  id: string; // "" = PUBLIC YARD, else code
  kind: "yard" | "private";
  session: GameSession;
  host: string | null = null;
  seats = new Map<string, Seat>();
  botSeq = 0;
  overAt = 0;
  // END-OF-MATCH RETRANSMIT (match-end robustness, all modes/kinds): the last
  // match-end scores, repeated on over-window snapshots until the rollover.
  // The end tick freezes (GameSession.step returns when over), so without a
  // repeat a single lost flush frame leaves clients waiting for the rollover.
  overMatchEnd: { score0: number; score1: number } | null = null;
  // Wall time of the last over-window snapshot (retransmit throttle, tick()).
  overLastSnap = 0;
  startAtWall = 0;
  emptySince = 0;
  /** Seats (humans+bots) of this room: seatsFor(map, mode). */
  seatCount: number;
  /** GUN GAME kills per gun (host's lobbyset choice, default 3). */
  gunKills = GUN_KILLS_PER_TIER;
  /** Spray tags by seat: one per player, replaced on re-spray (CS rule). */
  sprays = new Map<string, { tag: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }>();
  /** Last lobby push that carried ping numbers (dirty-push throttle, below). */
  lastPingPush = 0;
  /** Ping numbers last pushed, by seat (dirty-push throttle, below). */
  pushedPing = new Map<string, number>();

  constructor(id: string, kind: "yard" | "private", mode: ModeId) {
    this.id = id;
    this.kind = kind;
    this.seatCount = seatsFor(SERVER_MAP, mode);
    this.session = new GameSession();
    this.session.mode = simMode(mode);
    this.session.gunGame = mode === "gun";
    this.session.remain = matchTimeFor(simMode(mode));
    if (kind === "yard") {
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
    return this.session.gunGame ? "gun" : this.session.mode === "ffa" ? "ffa" : "tdm";
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
    // Case-insensitive taken set (fix: previously raw names stored but
    // lowercased on lookup, so "stem scout" never blocked "Stem Scout").
    const taken = new Set([...this.session.players.values()].map((p) => p.name.toLowerCase()));
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
    const id = nextSeatId();
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
      lastChat: 0,
      closed: false,
      msgTimes: [],
      lastPing: 0,
      lastLobbyQ: 0,
      lastLobbySet: 0,
      lastSpray: 0,
      violations: 0,
      lastSeq: -1,
      moveBank: 0,
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
    // Their tag leaves with them.
    this.sprays.delete(seat.id);
    this.pushedPing.delete(seat.id);
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
    s.moveBank = 0;
    s.queue.length = 0;
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
    const ffa = this.mode !== "tdm";
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
      s.moveBank = 0;
      s.queue.length = 0;
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
    this.session.setGunKills(this.gunKills);
    this.sprays.clear();
    this.session.beginCountdown(COUNTDOWN_MS);
    const startAt = Date.now() + COUNTDOWN_MS;
    this.startAtWall = startAt;
    for (const s of this.seats.values()) this.send(s, { t: "start", startAt });
    this.broadcastLobby();
  }

  /**
   * HOST, PRE-GAME ONLY: change the lobby's mode (same room, at once), its
   * kills-per-gun (gun game), or its map (the room moves: every seat is sent
   * `relocate`). Anyone else, or a room that is counting down or live, is
   * ignored.
   */
  lobbySet(fromSeat: Seat, mode: unknown, map: unknown, gunKills: unknown): void {
    if (this.kind !== "private" || this.phase !== "pregame" || this.host !== fromSeat.id) return;
    if (typeof map === "string" && map !== SERVER_MAP) {
      if (!VALID_MAPS.has(map)) return;
      const roomMode = this.mode;
      movedRooms.set(this.id, { map, at: Date.now() });
      for (const s of this.seats.values()) {
        this.send(s, { t: "relocate", map, room: this.id, mode: roomMode, host: s.id === this.host });
      }
      return;
    }
    if (gunKills !== undefined) {
      const per = asGunKills(gunKills);
      if (per !== this.gunKills) {
        this.gunKills = per;
        this.session.setGunKills(per);
        this.broadcastLobby();
      }
    }
    if (mode !== "tdm" && mode !== "ffa" && mode !== "gun") return;
    if (mode === this.mode) return;
    this.session.setMode(simMode(mode), mode === "gun");
    if (!this.session.roundBased) this.session.remain = matchTimeFor(simMode(mode));
    this.seatCount = seatsFor(SERVER_MAP, mode);
    this.broadcastLobby();
  }

  /**
   * HOST, PRE-GAME ONLY, and only with every seat taken and someone on the
   * bench: re-deal every seat but the host's at random — who plays, who
   * watches, and the teams.
   */
  shuffle(fromSeat: Seat): void {
    if (this.kind !== "private" || this.phase !== "pregame" || this.host !== fromSeat.id) return;
    if (this.playableHumans().length < this.seatCount || this.spectators().length === 0) return;
    const others = [...this.seats.values()].filter((s) => s.id !== this.host);
    // Fisher-Yates over the non-host seats, then re-deal: first seatCount are
    // playable (host keeps theirs), the rest watch.
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [others[i], others[j]] = [others[j]!, others[i]!];
    }
    const hostSeat = this.seats.get(this.host ?? "");
    const playable: Seat[] = hostSeat && !hostSeat.spectator ? [hostSeat] : [];
    const bench: Seat[] = hostSeat && hostSeat.spectator ? [hostSeat] : [];
    for (const s of others) (playable.length < this.seatCount ? playable : bench).push(s);
    for (const s of playable) {
      if (s.spectator) {
        s.spectator = false;
        s.slot = this.nextSlot();
        s.team = this.pickTeam();
        s.moveBank = 0;
        s.queue.length = 0;
        this.send(s, { t: "promoted", slot: s.slot });
      }
    }
    for (const s of bench) {
      if (!s.spectator) {
        s.spectator = true;
        s.slot = 0;
      }
    }
    // Re-deal the teams of the playable seats (host keeps theirs).
    const teams = playable.filter((s) => s.id !== this.host);
    for (let i = teams.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [teams[i], teams[j]] = [teams[j]!, teams[i]!];
    }
    const half = Math.ceil(teams.length / 2);
    teams.forEach((s, i) => {
      s.team = (i < half ? 0 : 1) as Team;
    });
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
        gunKills: this.gunKills,
      });
      this.pushedPing.set(s.id, s.ping);
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
    // A seat that arrives mid-match missed every spray so far: re-deal the
    // room's tags through the event stream (they land on the next snapshot).
    // One per player — place() replaces by src, so this is idempotent for
    // everyone already looking at them.
    for (const [src, sp] of this.sprays) {
      this.session.events.push({ t: "spray", src, ...sp });
    }
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
        // The sim applies the pre-live gate while still accepting aim/sequence.
        const cmd = sanitizeCmd(m.cmd, this.session.time);
        if (!cmd) return;
        // H1 seq-monotonic dedupe: drop replays/out-of-order (protocol claims
        // dedupe on seq; the server did not enforce it — a replayed bundle
        // integrated twice).
        if (cmd.seq <= seat.lastSeq) return;
        seat.lastSeq = cmd.seq;
        seat.queue.push(cmd);
        while (seat.queue.length > MAX_INPUT_QUEUE) seat.queue.shift();
        return;
      }
      case "inb": {
        if (seat.spectator || !this.seatBody(seat) || !Array.isArray(m.c)) return;
        for (const raw of m.c.slice(-8)) {
          const cmd = sanitizeCmd(raw, this.session.time);
          if (!cmd) continue;
          if (cmd.seq <= seat.lastSeq) continue;
          seat.lastSeq = cmd.seq;
          seat.queue.push(cmd);
        }
        while (seat.queue.length > MAX_INPUT_QUEUE) seat.queue.shift();
        return;
      }
      case "ping": {
        // H3: ping is a pong-amplification oracle — gate per-socket.
        const now = Date.now();
        if (now - seat.lastPing < PING_MIN_GAP_MS) return;
        seat.lastPing = now;
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
        // TEXT CHAT relay: sanitise, rate-limit, filter, then broadcast to the
        // room with the SERVER's seat name — the client sends no name at all,
        // so callsign spoofing is impossible by construction.
        const text = String(m.text ?? "")
          .normalize("NFKC")
          .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .replace(/<|>/g, "")
          .trim()
          .slice(0, CHAT_MAX_LEN);
        if (!text) return;
        const now = Date.now();
        if (now - seat.lastChat < CHAT_MIN_GAP_MS) return;
        seat.lastChat = now;
        // Blocked word: never broadcast — only the sender gets the private
        // system notice (a `notice` ServerMsg, rendered as a "SERVER:" line).
        if (chatBlocked(text)) {
          this.send(seat, { t: "notice", text: "Blocked: message contains a blocked word." });
          return;
        }
        this.session.events.push({ t: "chat", name: seat.name, text });
        return;
      }
      case "startmatch":
        this.startMatch(seat);
        return;
      case "spray": {
        // SPRAY PAINT: one tag per player on a nearby surface, broadcast to
        // the room like any other event. Validated: a live body, a legal tag,
        // finite coords in the map's envelope, within reach of the body, and
        // a per-seat cooldown so a compromised client cannot paint storms.
        const now = Date.now();
        if (now - seat.lastSpray < SPRAY_MIN_GAP_MS) return;
        const body = this.seatBody(seat);
        if (!body || !body.alive || this.phase !== "live") return;
        const tag = Math.floor(num(m.tag, -1));
        if (tag < 0 || tag > 3) return;
        const x = num(m.x, NaN);
        const y = num(m.y, NaN);
        const z = num(m.z, NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        if (Math.abs(x) > 256 || Math.abs(y) > 128 || Math.abs(z) > 256) return;
        let nx = num(m.nx, 0);
        let ny = num(m.ny, 1);
        let nz = num(m.nz, 0);
        const nl = Math.hypot(nx, ny, nz);
        if (!(nl > 0.5)) return;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        // Reach: the tag must sit near the body that sprayed it (eye height
        // ~1.6 m; generous slack for interpolation between server and client
        // poses — the client's own 4 m ray is the tight check).
        const dx = x - body.x;
        const dy = y - (body.y + 1.6);
        const dz = z - body.z;
        if (Math.hypot(dx, dy, dz) > SPRAY_REACH_OK) return;
        seat.lastSpray = now;
        const spray = { tag, x, y, z, nx, ny, nz };
        this.sprays.delete(seat.id);
        this.sprays.set(seat.id, spray);
        while (this.sprays.size > MAX_SPRAYS) {
          const first = this.sprays.keys().next();
          if (first.done) break;
          this.sprays.delete(first.value);
        }
        this.session.events.push({ t: "spray", src: seat.id, ...spray });
        return;
      }
      case "lobbyset": {
        // H3: a map change relocates every seat, a mode change re-arms the
        // room — same per-socket gate as lobbyq so a compromised host cannot
        // fire relocate-reload storms through the 120/s global window.
        const now = Date.now();
        if (now - seat.lastLobbySet < LOBBYQ_MIN_GAP_MS) return;
        seat.lastLobbySet = now;
        this.lobbySet(seat, m.mode, m.map, m.gunKills);
        return;
      }
      case "shuffle": {
        // H3: re-deal + broadcasts fan out like lobbyset — same gate.
        const now = Date.now();
        if (now - seat.lastLobbySet < LOBBYQ_MIN_GAP_MS) return;
        seat.lastLobbySet = now;
        this.shuffle(seat);
        return;
      }
      case "lobbyq": {
        // H3: each lobbyq fans out to the whole room — gate per-socket.
        const now = Date.now();
        if (now - seat.lastLobbyQ < LOBBYQ_MIN_GAP_MS) return;
        seat.lastLobbyQ = now;
        if (this.kind === "private") this.broadcastLobby();
        return;
      }
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
    // END-OF-MATCH FLUSH. step() opens with `if (this.over) return`, so the
    // tick freezes the instant the match ends — and snapshots below only go
    // out on even ticks (SNAP_EVERY). Without this flush, a match that ends
    // on an odd tick publishes NOTHING for the whole rollover wait: the
    // match-end event sits undrained in session.events, the clients never see
    // remain<=0, finish() never runs, no endcard appears and neither the next
    // match nor the lobby return visibly starts. Flush once, on the exact tick
    // the end lands, so delivery no longer depends on tick parity. Flushed
    // this tick means the regular even-tick snapshot below is skipped once —
    // on an even tick it would otherwise snap a second time with drained
    // (empty) events.
    const flushed = this.session.over && this.overAt === 0;
    if (flushed) {
      this.overAt = Date.now();
      this.overMatchEnd = { score0: this.session.score0, score1: this.session.score1 };
      this.overLastSnap = Date.now();
      this.broadcastSnaps();
    }
    if (this.session.over && this.overAt !== 0) {
      const wait = this.kind === "yard" ? YARD_ROLLOVER_MS : LOBBY_RETURN_MS;
      if (Date.now() - this.overAt >= wait) {
        this.overAt = 0;
        this.overMatchEnd = null;
        this.session.nextMatch();
        // A new match starts on clean walls (the clients scrub theirs too).
        this.sprays.clear();
        // MATCH-ROLLOVER BANK RESET (review LOW): nextMatch() respawns every
        // body (which zeroes each sim-side cmdBank), but the seat-side
        // moveBank banked ~0.5 s of travel during the 18-19 s rollover wait —
        // the same idle-full burst the death reset (stepInputs) closes. Zero it
        // here so the fresh match opens unfunded, like startMatch() does.
        for (const s of this.seats.values()) {
          s.moveBank = 0;
          // ROLLOVER QUEUE DRAIN (review LOW-2): the bank alone is half the
          // reset — a leftover queue (up to MAX_INPUT_QUEUE stale intermission
          // intents) would still integrate at up to MAX_CMDS_PER_TICK per tick
          // against the fresh spawns. startMatch()/promote() already drain
          // both; the rollover path now matches them.
          s.queue.length = 0;
        }
        if (this.kind === "private") {
          this.session.phase = "pregame";
          this.session.liveAt = 0;
          this.startAtWall = 0;
          // Spectators into free seats instead of bots (they reclaim the vacated
          // slot; if none is free they stay on the bench).
          for (const s of [...this.spectators()]) {
            if (this.session.players.size >= this.seatCount) break;
            this.promote(s);
          }
          this.broadcastLobby();
        } else if (this.session.players.size < this.seatCount) {
          this.addBot(this.pickTeam());
        }
      } else if (Date.now() - this.overLastSnap >= 1000) {
        // END-OF-MATCH RETRANSMIT. The end tick is frozen, so the flush above
        // was a single shot: re-send the end state ~1 Hz until the rollover so
        // a lost flush frame (jitter, throttled tab, UDP/WS gap) still lands.
        // broadcastSnaps() re-attaches match/end and pins remain to 0 (below);
        // 1 Hz is ~18 small snapshots per over window, not spam. Throttled on
        // the wall clock (not the frozen session tick) so delivery no longer
        // depends on tick parity either way: a frozen even tick previously
        // re-snapped at the full 64 Hz tick rate, a frozen odd tick never again.
        this.overLastSnap = Date.now();
        this.broadcastSnaps();
      }
    }
    // No regular snapshot while over: the over window sends only the throttled
    // retransmit above (a frozen `session.tick % SNAP_EVERY === 0` is either
    // always or never true — 64 Hz spam or permanent silence by parity).
    if (!flushed && !this.session.over && this.session.tick % SNAP_EVERY === 0) this.broadcastSnaps();
    // LOBBY PING, LIVE: seats report rtt ~1/s (the ping handler stores it on
    // the seat), but the lobby only broadcasts on roster changes — so the
    // ms badges would freeze at 0. Re-push at most every 5 s, and only when
    // some seat's number actually moved (broadcastLobby records what it sent).
    if (this.kind === "private" && this.phase === "pregame") {
      const now = Date.now();
      if (now - this.lastPingPush >= 5000) {
        let dirty = false;
        for (const s of this.seats.values()) {
          if (this.pushedPing.get(s.id) !== s.ping) {
            dirty = true;
            break;
          }
        }
        if (dirty) {
          this.lastPingPush = now;
          this.broadcastLobby();
        }
      }
    }
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
        // Seat-level bank must not survive the corpse: without a reset a dead
        // seat banks 0.5 s while waiting and respawns with a full burst (same
        // class as cmdBank, which the sim resets on spawn).
        s.moveBank = 0;
        // applyInput still acks dead moves (p.seq = cmd.seq):
        while (s.queue.length) {
          const cmd = s.queue.shift()!;
          p.seq = cmd.seq;
        }
        continue;
      }
      // Trigger clock: bank on wall clock, consume per command. Movement is
      // metered on the same wall clock (s.moveBank): each drained command
      // spends MOVE_TICK of banked real time, and the per-tick drain is capped
      // at MAX_CMDS_PER_TICK — so a 960 cmds/s flood (120 msgs/s x 8/bundle,
      // the MSG_MAX x inb-slice product) can never sustain more than 1.0 s of
      // travel per wall-second (up to ~1.5 s on the first flood second from a
      // full 0.5 s bank, then 1.0 s/s), and honest TCP-stall bursts still catch
      // up out of what the stall banked. cmdBank (sim) meters the gun clocks on
      // the same arrival pattern; moveBank meters the travel.
      this.session.bankCommandTime(p, 1 / 64);
      s.moveBank = Math.min(MOVE_BANK_MAX, s.moveBank + 1 / 64);
      p.netFed = true;
      let drained = 0;
      while (s.queue.length && drained < MAX_CMDS_PER_TICK) {
        if (s.moveBank < MOVE_TICK - 1e-9) break;
        const cmd = s.queue.shift()!;
        s.moveBank -= MOVE_TICK;
        this.session.applyInput(p, cmd, true);
        this.session.creditCommandTime(p, cmd.dt);
        drained += 1;
      }
    }
  }

  broadcastSnaps(): void {
    // NO INTEREST MANAGEMENT (security INFO, documented): every snapshot
    // carries every body to every seat, so a sniffer (or a radar overlay
    // reading the client's own snapshots) sees the whole yard. That is
    // inherent to the current wire protocol, not a leak to close in a hardening
    // pass: culling by PVS would change bot-inclusive replays, the packed
    // snapshot wire order, and every probe that asserts on full rosters.
    // Player names/chat ride the same snapshots raw; every shipped sink escapes
    // (lobby.ts, hud.ts, roundstrip.ts esc(), game.ts escHtml for the killfeed),
    // and cleanName additionally strips `<>` at ingress so no tag survives onto
    // the wire even for a third-party client that forgets esc() — defence in
    // depth (server-side reject on control characters) stays a
    // third-party-client concern and is out of scope here.
    const ev: NetEvent[] = this.session.drainEvents();
    // END-OF-MATCH RETRANSMIT (tick(), over window): the sim is frozen, so the
    // drain above is empty after the flush — re-attach the match/end event on
    // every over-window snapshot until the rollover clears overMatchEnd.
    // finish() is idempotent client-side, so repeats are safe; the rollover's
    // match/live event is NOT repeated (it drains once, normally).
    if (this.session.over && this.overMatchEnd) {
      ev.push({ t: "match", state: "end", score0: this.overMatchEnd.score0, score1: this.overMatchEnd.score1 });
    }
    const playersRaw: PlayerSnap[] = this.session.snap();
    const nades = this.session.nadeSnap();
    const round = this.session.roundSnap();
    const countWall = this.phase === "countdown" ? this.countdownAtWall() : undefined;
    for (const s of this.seats.values()) {
      const snap: Snapshot = {
        t: "snap",
        tick: this.session.tick,
        time: this.session.time,
        you: s.id,
        prediction: this.predictionFor(s),
        score0: this.session.score0,
        score1: this.session.score1,
        // remain is pinned to 0 while over: the clock path already publishes 0,
        // the kill-limit path leaves the clock parked above 0 — pinning aligns
        // both (and round-based rooms, whose remain parks on ROUND_TIME) so the
        // client's remain<=0 trigger fires on every over-window snapshot.
        remain: this.session.over ? 0 : this.session.remain,
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

  predictionFor(s: Seat): PredictionState | undefined {
    if (s.spectator) return undefined;
    const p = this.session.players.get(s.id);
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
      // Earned-time banks, exact (review HIGH-1/HIGH-2): the ghost seeds both
      // from here and preserves them across reconciles (ghostFrom), so an idle
      // second banks identically on both sides instead of resetting the replay
      // to 0 + dt. Travel comes from the SEAT's live bank — the authority's
      // meter — not the body's (SimPlayer.moveBank is the ghost-side copy).
      cmdBank: p.cmdBank,
      moveBank: s.moveBank,
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
        relocated: freshRelocated(this.id),
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
/**
 * LOBBY MOVES, remembered for a minute: room code → the map the host moved it
 * to. A guest arriving at the old map's process after a host's map change is
 * told where the lobby went (NameCheck.room.relocated) instead of being
 * seated alone in the room everyone is leaving.
 */
const movedRooms = new Map<string, { map: string; at: number }>();
const RELOCATED_TTL_MS = 60_000;
if (!IS_WORKER && !argVal("--map=")) {
  // HUB mode: rooms live in the map workers — create nothing here.
} else {
  rooms.set("", new Room("", "yard", "tdm"));
}

function getOrCreateRoom(code: string, mode: ModeId): Room | null {
  const existing = rooms.get(code);
  if (existing) return existing;
  // H2: unbounded room creation = memory + tick exhaustion. Cap private
  // rooms per worker; over-limit joins get err+close (fail-closed).
  let privateCount = 0;
  for (const [k] of rooms) if (k !== "") privateCount++;
  if (privateCount >= MAX_PRIVATE_ROOMS) return null;
  const r = new Room(code, "private", mode);
  rooms.set(code, r);
  return r;
}

function yardRoom(): Room {
  return rooms.get("") as Room;
}

/** The map a room code moved to, if it moved within the last minute. */
function freshRelocated(code: string): string | undefined {
  const rec = movedRooms.get(code);
  if (!rec) return undefined;
  if (Date.now() - rec.at > RELOCATED_TTL_MS) {
    movedRooms.delete(code);
    return undefined;
  }
  return rec.map;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, rec] of [...movedRooms]) {
    if (now - rec.at > RELOCATED_TTL_MS) movedRooms.delete(code);
  }
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
// H1: ws default maxPayload is ~100 MB — one unauthenticated 50 MB frame OOMs
// the worker. Protocol messages are < 4 KB; 64 KB has 16x headroom.
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

// H3: per-IP / global connection accounting (hub + worker share this module
// per process; hub counts proxied sockets, worker counts real WS sockets).
const ipConns = new Map<string, number>();
let totalConns = 0;
function clientIp(req: http.IncomingMessage): string {
  // Use Cloudflare's visitor-IP header ONLY when the socket arrived via the
  // loopback hub→worker proxy (which stamps it: proxyUpgrade writes a single
  // CF-Connecting-IP for the validated hub-side IP). A directly-connected
  // socket can forge any CF-Connecting-IP and shed its budget/throttle onto a
  // victim, so off-loopback it is ignored. X-Forwarded-For can contain an
  // attacker-supplied first entry, so it is never used for quotas.
  // LOOPBACK IS 127.0.0.0/8 (review LOW), not just 127.0.0.1: the whole /8 is
  // loopback by RFC 1122 and a local stack may source any of it. Mapped
  // (::ffff:127.x) and ::1 included. ACCEPTABLE RESIDUAL (security INFO): a
  // forged header requires local execution — and a local attacker is already
  // past every quota this header feeds. If the hub ever listens off-loopback,
  // a remote socket is never loopback here, so the header stays ignored.
  const remote = req.socket.remoteAddress ?? "";
  const loopback =
    remote === "::1" || remote === "127.0.0.1" || remote.startsWith("127.") || remote.startsWith("::ffff:127.");
  const cfIp = req.headers["cf-connecting-ip"];
  if (loopback && typeof cfIp === "string" && net.isIP(cfIp.trim())) return cfIp.trim();
  return (req.socket.remoteAddress ?? "unknown").slice(0, 64);
}

const ipJoinTimes = new Map<string, number[]>();
const ipJoinCleanup = setInterval(() => {
  const cutoff = Date.now() - JOIN_WINDOW_MS;
  for (const [ip, times] of ipJoinTimes) {
    const fresh = times.filter((t) => t >= cutoff);
    if (fresh.length) ipJoinTimes.set(ip, fresh);
    else ipJoinTimes.delete(ip);
  }
}, JOIN_WINDOW_MS);
ipJoinCleanup.unref();

function allowIpJoin(ip: string, now: number): boolean {
  const existing = ipJoinTimes.get(ip);
  const fresh = (existing ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
  if (fresh.length >= IP_JOIN_MAX_PER_WINDOW) {
    ipJoinTimes.set(ip, fresh);
    return false;
  }
  if (!existing && ipJoinTimes.size >= MAX_TRACKED_JOIN_IPS) return false;
  fresh.push(now);
  ipJoinTimes.set(ip, fresh);
  return true;
}
function connAcquire(ip: string): boolean {
  if (totalConns >= MAX_CONNECTIONS) return false;
  if ((ipConns.get(ip) ?? 0) >= MAX_CONN_PER_IP) return false;
  ipConns.set(ip, (ipConns.get(ip) ?? 0) + 1);
  totalConns++;
  return true;
}
function connRelease(ip: string): void {
  const n = (ipConns.get(ip) ?? 1) - 1;
  if (n <= 0) ipConns.delete(ip);
  else ipConns.set(ip, n);
  totalConns = Math.max(0, totalConns - 1);
}

// M1: CSWSH — any website can open ws:// to a LAN server. Allow non-browser
// clients (no Origin) and same-origin pages (Origin host === Host header).
// Evil origin https://evil.com vs Host 192.168.1.10:8765 → reject.
// DEV LOOPBACK EXCEPTION: when the Origin hostname AND the Host-header
// hostname are BOTH loopback (localhost / 127.0.0.0/8 / ::1), the port is
// ignored — dev serves the page on :5173 (Vite) while the hub listens on
// :8787. CSWSH protection is preserved: only a page already served from
// loopback qualifies, a foreign site (evil.com) never does, and any
// non-loopback host keeps the strict full-host comparison (LAN host with a
// foreign port stays rejected).
function isLoopbackHostname(h: string): boolean {
  const n = h.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (n === "localhost" || n === "127.0.0.1" || n === "::1") return true;
  // Whole 127.0.0.0/8 is loopback (RFC 1122); a local stack may source any.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n)) return true;
  return false;
}
function checkOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = req.headers.host ?? "";
    if (!host) return false;
    // Compare full host (hostname:port) — same-origin pages match exactly.
    if (o.host.toLowerCase() === host.toLowerCase()) return true;
    // Loopback exception: same loopback family, any port.
    let hostName = "";
    try {
      hostName = new URL(`http://${host}`).hostname;
    } catch {
      return false;
    }
    if (isLoopbackHostname(o.hostname) && isLoopbackHostname(hostName)) return true;
    return false;
  } catch {
    return false;
  }
}

// H4: arm an idle timeout on a pre-auth socket; cleared on upgrade/proxy.
function armUpgradeTimeout(socket: net.Socket): () => void {
  socket.setTimeout(UPGRADE_TIMEOUT_MS);
  const onTimeout = (): void => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };
  socket.once("timeout", onTimeout);
  return () => {
    try {
      socket.setTimeout(0);
      socket.removeListener("timeout", onTimeout);
    } catch {
      /* ignore */
    }
  };
}

if (IS_WORKER) {
  // WORKER: exactly one map. A ?map= mismatch stays an error (the hub
  // routes correctly; this only protects direct connections).
  server.on("upgrade", (req, socket, head) => {
    const disarm = armUpgradeTimeout(socket);
    // H3: per-IP / global cap before handshake work.
    const ip = clientIp(req);
    if (!connAcquire(ip)) {
      disarm();
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    socket.once("close", () => connRelease(ip));
    try {
      // M1: reject cross-site upgrades before any ws state.
      if (!checkOrigin(req)) {
        disarm();
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      const u = new URL(req.url ?? "/", "http://x");
      if (!u.pathname.endsWith("/ws")) {
        disarm();
        socket.destroy();
        return;
      }
      const mapQ = u.searchParams.get("map");
      if (mapQ && VALID_MAPS.has(mapQ) && mapQ !== SERVER_MAP) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          disarm();
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
      wss.handleUpgrade(req, socket, head, (ws) => {
        disarm();
      onSocket(ws, ip);
      });
    } catch {
      disarm();
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
        // M5: workers are hub-internal — always loopback, even if the hub
        // itself was started with --host=0.0.0.0 / KONG_HOST for LAN play.
        // (Explicit flag beats the inherited KONG_HOST env.)
        "--host=127.0.0.1",
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
function proxyUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, port: number, ip: string): void {
  const upstream = net.connect({ port, host: "127.0.0.1" });
  upstream.setTimeout(UPGRADE_TIMEOUT_MS);
  let sent = false;
  upstream.on("connect", () => {
    try {
      upstream.setTimeout(0);
    } catch {
      /* ignore */
    }
    // M5: forward ONLY the WS handshake headers. Cookie/Authorization/X-*
    // from the client must not reach the worker; Host is the ORIGINAL hub
    // host so the worker's same-origin check sees the page's origin.
    const allow = new Set([
      "host",
      "upgrade",
      "connection",
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-extensions",
      "sec-websocket-protocol",
      "origin",
    ]);
    const lines = [`GET ${req.url ?? "/"} HTTP/1.1`];
    for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
      const k = req.rawHeaders[i];
      if (!k) continue;
      const lk = k.toLowerCase();
      if (!allow.has(lk)) continue;
      const v = req.rawHeaders[i + 1] ?? "";
      // Harden: strip CR/LF just in case (static layer already 400s them).
      const sv = String(v).replace(/[\r\n]/g, "");
      if (lk === "connection") lines.push("Connection: Upgrade");
      else lines.push(`${k}: ${sv}`);
    }
    // Forward the already-validated client IP from the hub to the worker.
    lines.push(`CF-Connecting-IP: ${ip}`);
    if (!lines.some((l) => l.toLowerCase().startsWith("connection:"))) {
      lines.push("Connection: Upgrade", "Upgrade: websocket");
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) {
      // H4: cap buffered head — a giant pre-handshake body must not pin RAM.
      if (head.length > WS_MAX_PAYLOAD) {
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
        return;
      }
      upstream.write(head);
    }
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
  upstream.once("timeout", kill);
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
    // H4: pre-auth sockets must not linger (Slowloris). Disarmed once the
    // proxy pipes or the socket is destroyed.
    const disarm = armUpgradeTimeout(socket);
    // H3: hub-level per-IP/global cap on half-open upgrades.
    const ip = clientIp(req);
    if (!connAcquire(ip)) {
      disarm();
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    socket.once("close", () => connRelease(ip));
    // M5: workers bind loopback only (see listen below); the hub is the
    // only ingress. Direct worker ports are not reachable off-host.
    const done = (): void => {
      // connRelease happens on socket close; disarm the idle timer now that
      // proxyUpgrade owns the socket lifecycle.
      disarm();
    };
    try {
      // M1: same-origin gate at the hub (worker re-checks after proxy).
      if (!checkOrigin(req)) {
        disarm();
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      const u = new URL(req.url ?? "/", "http://x");
      if (!u.pathname.endsWith("/ws")) {
        disarm();
        socket.destroy();
        return;
      }
      const mapQ = u.searchParams.get("map");
      const map = mapQ && VALID_MAPS.has(mapQ) ? mapQ : "nuketown";
      ensureWorker(map)
        .then((port) => {
          if (port) {
            done();
            proxyUpgrade(req, socket, head, port, ip);
          } else {
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

function onSocket(ws: WsConn, ip: string): void {
  let seat: Seat | null = null;
  let room: Room | null = null;
  // H3: separate general message and room-probe budgets for pre-join sockets.
  const preJoinTimes: number[] = [];
  const joinTimes: number[] = [];

  ws.on("message", (raw: unknown, isBinary?: boolean) => {
    // H1: ws delivers text frames as Buffer (RawData) — decode them, but
    // drop true binary frames outright (protocol is JSON text only).
    if (isBinary === true) {
      try {
        ws.close(1009, "binary not supported");
      } catch {
        /* ignore */
      }
      return;
    }
    const text: string =
      typeof raw === "string"
        ? raw
        : (() => {
            try {
              if (raw instanceof Buffer) return raw.toString("utf8");
              if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
              if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString("utf8");
              return String(raw);
            } catch {
              return "";
            }
          })();
    if (text.length > WS_MAX_PAYLOAD) {
      // SECOND LAYER RETURNS UNCONDITIONALLY (security LOW): ws maxPayload
      // pre-empts this in practice, but a first offence (violations 1-2) must
      // not fall through to JSON.parse/rate-limit below — count it and stop.
      if (seat) {
        seat.violations++;
        if (seat.violations >= 3) {
          try {
            ws.close(1009, "too large");
          } catch {
            /* ignore */
          }
        }
        return;
      }
      try {
        ws.close(1009, "too large");
      } catch {
        /* ignore */
      }
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const m = msg as Partial<ClientMsg>;
    if (!m || typeof m !== "object" || typeof m.t !== "string") return;

    // H3: per-socket sliding-window rate limit (post-join seats use
    // seat.msgTimes; pre-join sockets use preJoinTimes).
    const nowRL = Date.now();
    if (seat) {
      seat.msgTimes = seat.msgTimes.filter((t) => nowRL - t < MSG_WINDOW_MS);
      if (seat.msgTimes.length >= MSG_MAX_PER_WINDOW) {
        try {
          ws.send(JSON.stringify({ t: "err", msg: "rate limited" }));
        } catch {
          /* ignore */
        }
        try {
          ws.close(1013, "rate limited");
        } catch {
          /* ignore */
        }
        return;
      }
      seat.msgTimes.push(nowRL);
    } else {
      const fresh = preJoinTimes.filter((t) => nowRL - t < MSG_WINDOW_MS);
      preJoinTimes.length = 0;
      preJoinTimes.push(...fresh);
      if (fresh.length >= MSG_MAX_PER_WINDOW) {
        try {
          ws.close(1013, "rate limited");
        } catch {
          /* ignore */
        }
        return;
      }
      preJoinTimes.push(nowRL);
    }

    if (!seat && (m.t === "checkname" || m.t === "join")) {
      const fresh = joinTimes.filter((t) => nowRL - t < JOIN_WINDOW_MS);
      joinTimes.length = 0;
      joinTimes.push(...fresh);
      if (joinTimes.length >= JOIN_MAX_PER_WINDOW || !allowIpJoin(ip, nowRL)) {
        try {
          ws.close(1013, "rate limited");
        } catch {
          /* ignore */
        }
        return;
      }
      joinTimes.push(nowRL);
    }

    if (m.t === "checkname") {
      const asked = cleanRoomCode(m.room);
      if (!asked) {
        ws.send(JSON.stringify({ t: "namecheck", ok: true, name: dedupeName(cleanName(m.name), []) }));
        return;
      }
      const r = rooms.get(asked);
      if (!r) {
        // NoSuchRoom case: created on join of this code.
        const md: ModeId = m.mode === "gun" ? "gun" : m.mode === "ffa" ? "ffa" : "tdm";
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
              relocated: freshRelocated(asked),
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
      ws.send(JSON.stringify(r.namecheck(m)));
      return;
    }

    if (m.t === "join") {
      if (room && seat) return;
      const mode: ModeId = m.mode === "gun" ? "gun" : m.mode === "ffa" ? "ffa" : "tdm";
      const code = cleanRoomCode(m.room);
      const target = code ? getOrCreateRoom(code, mode) : yardRoom();
      if (!target) {
        // H2: private-room cap hit.
        try {
          ws.send(JSON.stringify({ t: "err", msg: "server full" }));
        } catch {
          /* ignore */
        }
        try {
          ws.close(1013, "server full");
        } catch {
          /* ignore */
        }
        return;
      }
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
  // No PIDs / no per-map detail — liveness only, no process info leak.
  return `ok hub workers=${workers.size}`;
}

server.listen(PORT, HOST, () => {
  if (IS_WORKER) {
    console.log(`[kong-worker] map=${SERVER_MAP} seats=${seatsFor(SERVER_MAP, "tdm")} host=${HOST}`);
    console.log(`[kong-worker] http://${HOST}:${PORT}/?map=${SERVER_MAP}`);
    console.log(`[kong-worker] ws:      ws://${HOST}:${PORT}/ws`);
  } else {
    console.log(`[kong-hub] mode: HUB — client picks the map (?map=), workers start lazily`);
    console.log(`[kong-hub] web root: ${ROOT}`);
    console.log(`[kong-hub] listen: ${HOST}:${PORT} (LAN play: --host=0.0.0.0)`);
    console.log(`[kong-hub] http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
    console.log(`[kong-hub] ws:      ws://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/ws?map=<${[...VALID_MAPS].join("|")}>`);
    console.log(`[kong-hub] worker-ports: ${WORKER_ORDER.map((m) => `${m}:${workerPortFor(m)}`).join("  ")} (loopback-only)`);
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
