// Headless protocol test against the local HUB server:
// 1) PUBLIC MATCH join → welcome → 32 Hz snaps → movement via 'in' → ping/pong
//    (Nuketown-Yard = 12 seats = 6v6)
// 2) PRIVATE MATCH 2 clients → lobby → host startmatch → countdown → live
// 3) PRIVATE MATCH on ARES routed through the hub (12 seats = 6v6) + namecheck
// Default port 8771: node ..\..\node_modules\.bin\... or change the port above.
import WebSocket from "ws";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Default: the test spawns its own hub on 8771 and shuts it down afterwards.
// KONG_PORT=<n>  different port   |  KONG_EXTERNAL_SERVER=1  use a running server
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.KONG_PORT) || 8771;
const url = (map = "nuketown") => `ws://localhost:${PORT}/ws?map=${map}`;

function portFree(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(300);
    s.on("connect", () => { s.destroy(); res(false); });
    s.on("error", () => { s.destroy(); res(true); });
    s.on("timeout", () => { s.destroy(); res(true); });
  });
}

// compact-v1 field order (shared/snapshot-wire.ts) — same as decodeServerMessage
const PACK_FIELDS = [
  "id","seq","name","op","team","x","y","z","vx","vy","vz","yaw","pitch",
  "hp","armor","weapon","ads","sprint","crouch","slide","reload","firing","alive",
  "protect","kills","deaths","streak","ping","ammo","reserve","nades","nadeUp",
  "alt","altAmmo","altRes","swap","cook","gun",
];
function decodeMsg(m) {
  if (m?.t === "snap" && m.packed === 1 && Array.isArray(m.players)) {
    m.players = m.players.map((row) => {
      const p = {};
      PACK_FIELDS.forEach((k, i) => (p[k] = row[i]));
      return p;
    });
    delete m.packed;
  }
  return m;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Fake {
  constructor(label) {
    this.label = label;
    this.ws = null;
    this.msgs = [];
    this.snaps = [];
    const resolve = (v) => {};
    this.waitFor = (pred, ms = 6000) =>
      new Promise((res, rej) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          const hit = pred(this.msgs);
          if (hit) {
            clearInterval(iv);
            res(hit);
          } else if (Date.now() - t0 > ms) {
            clearInterval(iv);
            rej(new Error(`${this.label}: timeout waiting`));
          }
        }, 20);
      });
    this.jobs = [];
  }
  connect(u) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(u);
      this.ws = ws;
      ws.on("open", res);
      ws.on("error", rej);
      ws.on("close", (c) => console.log(`[${this.label}] closed`, c));
      ws.on("message", (raw) => {
        const m = decodeMsg(JSON.parse(String(raw)));
        this.msgs.push(m);
        if (m.t === "snap") this.snaps.push(m);
      });
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
}

let ticks = 0;
// build a generic InputCmd
function cmd(seq, opts = {}) {
  return {
    seq,
    dt: 1 / 64,
    ax: 0,
    az: -1,
    jump: false,
    crouch: false,
    sprint: false,
    tac: false,
    ads: false,
    yaw: 0,
    pitch: 0,
    fire: false,
    reload: false,
    melee: false,
    weapon: "ar",
    clientTime: Date.now() / 1000,
    ...opts,
  };
}

async function main() {
  // spawn the server (hub mode), unless KONG_EXTERNAL_SERVER=1
  let proc = null;
  if (!process.env.KONG_EXTERNAL_SERVER) {
    if (!(await portFree(PORT))) throw new Error(`Port ${PORT} is in use — stop the test server first or set KONG_PORT`);
    const bundle = path.join(HERE, "dist", "server.mjs");
    if (!fs.existsSync(bundle)) throw new Error(`${bundle} is missing — run "npm run build" first`);
    proc = spawn(process.execPath, [bundle, `--port=${PORT}`], { stdio: "ignore" });
    proc.unref();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!(await portFree(PORT))) break;
      if (i === 59) throw new Error("Test server failed to start");
    }
    console.log(`[test] started own hub on :${PORT}`);
  }

  // ---------- 1) PUBLIC MATCH ----------
  const a = new Fake("pub");
  await a.connect(url());
  a.send({ t: "join", name: "TESTER", team: -1, mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1" });
  const wel = await a.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[pub] welcome ok room=${wel.room} spectator=${wel.spectator} phase=${wel.phase}`);

  const snap = await a.waitFor((m) => m.find((x) => x.t === "snap"));
  const me = snap.players.find((p) => p.id === snap.you);
  const snapIsPacked = Array.isArray(snap.players[0]);
  console.log(`[pub] snap: players=${snap.players.length} packed=${snapIsPacked} me=${me ? "found" : "MISSING"} you=${snap.you}`);
  console.log("[pub] ids:", snap.players.map((p) => p.id).join(","));
  // Nuketown-Yard: seatsFor(nuketown, tdm) = 12 == 6v6 (MAP_SEATS, shared/modes.ts)
  if (snap.players.length !== 12) throw new Error(`Yard has ${snap.players.length} bodies, expected 12 (6v6)`);
  if (!me) throw new Error("own body missing from snapshot");
  const x0 = me.x, z0 = me.z;

  // ping/pong
  a.send({ t: "ping", t0: Date.now(), rtt: 3 });
  await a.waitFor((m) => m.find((x) => x.t === "pong"));
  console.log("[pub] pong ok");

  // run forward for 1 s
  let seq = 100;
  const run = setInterval(() => {
    a.send({ t: "in", cmd: cmd(seq++) });
  }, 15);
  await sleep(1200);
  clearInterval(run);
  const latest = a.snaps[a.snaps.length - 1];
  const me2 = latest.players.find((p) => p.id === snap.you);
  const dist = Math.hypot(me2.x - x0, me2.z - z0);
  console.log(`[pub] moved dist=${dist.toFixed(2)}m alive=${me2.alive}`);
  if (dist < 0.5) throw new Error("body did not move");

  // ---------- 2) PRIVATE MATCH ----------
  const h = new Fake("host");
  const g = new Fake("guest");
  await h.connect(url());
  await g.connect(url());
  h.send({ t: "join", name: "HOSTER", room: "TEST-1234", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  g.send({ t: "join", name: "GASTER", room: "TEST-1234", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  const hw = await h.waitFor((m) => m.find((x) => x.t === "welcome"));
  const lob = await h.waitFor((m) => m.find((x) => x.t === "lobby"));
  console.log(`[priv] host welcome ${hw.id} lobby players=${lob.players.map((p) => p.name).join("/")} botFill=${lob.botFill} host=${lob.host}`);
  let gl = await g.waitFor((m) => m.find((x) => x.t === "lobby"));
  console.log(`[priv] guest lobby players=${gl.players.map((p) => p.name).join("/")}`);
  if (!(gl.players.length === 2)) throw new Error("lobby roster wrong");
  if (gl.maxPlayable !== 12) throw new Error(`nuketown private maxPlayable=${gl.maxPlayable}, expected 12`);

  // host starts the match
  h.send({ t: "startmatch" });
  const start = await h.waitFor((m) => m.find((x) => x.t === "start"));
  console.log(`[priv] start ok startAt=${start.startAt} (in ${start.startAt - Date.now()} ms)`);
  await sleep(3600); // countdown 3.2 s + margin
  const phases = [...new Set(h.snaps.map((s) => s.phase))].join("/");
  console.log(`[priv] snap phases seen: ${phases} (n=${h.snaps.length})`);
  const live = h.snaps.find((s) => s.phase === "live");
  if (!live) throw new Error("no live snapshot after countdown");
  console.log(`[priv] phase=live tick=${live.tick} players=${live.players.length} me=${live.players.find((p) => p.id === live.you) ? "found" : "MISSING"}`);
  const teams = new Map();
  for (const p of live.players) teams.set(p.team, (teams.get(p.team) ?? 0) + 1);
  console.log(`[priv] team counts: team0=${teams.get(0)} team1=${teams.get(1)}`);

  // ---------- 3) PRIVATE MATCH on ARES — routed through the HUB ----------
  // Proves: no more map pinning — the same hub process serves nuketown
  // AND ares; the client picks the map via ?map=.
  const ah = new Fake("ares-host");
  const ag = new Fake("ares-guest");
  await ah.connect(url("ares"));
  await ag.connect(url("ares"));
  ah.send({ t: "join", name: "ARES-HOST", room: "ARES-TEST", mode: "tdm", map: "ares", snapshotFormat: "compact-v1", lobby: true });
  ag.send({ t: "join", name: "ARES-GUEST", room: "ARES-TEST", mode: "tdm", map: "ares", snapshotFormat: "compact-v1", lobby: true });
  const ahw = await ah.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[ares] host welcome ok room=${ahw.room} phase=${ahw.phase}`);
  const alob = await ah.waitFor((m) => m.find((x) => x.t === "lobby"));
  console.log(`[ares] lobby players=${alob.players.map((p) => p.name).join("/")} maxPlayable=${alob.maxPlayable} botFill=${alob.botFill}`);
  if (alob.maxPlayable !== 12) throw new Error(`ares maxPlayable=${alob.maxPlayable}, expected 12 (6v6)`);
  if (alob.map !== "ares") throw new Error(`ares lobby.map=${alob.map}, expected ares`);
  ah.send({ t: "startmatch" });
  await ah.waitFor((m) => m.find((x) => x.t === "start"));
  await sleep(3600);
  const alive = ah.snaps.find((s) => s.phase === "live");
  if (!alive) throw new Error("ares: no live snapshot after countdown");
  const ateams = new Map();
  for (const p of alive.players) ateams.set(p.team, (ateams.get(p.team) ?? 0) + 1);
  console.log(`[ares] live players=${alive.players.length} team0=${ateams.get(0)} team1=${ateams.get(1)}`);
  if (alive.players.length !== 12) throw new Error(`ares live ${alive.players.length} bodies, expected 12`);

  // checkname (existing room, ARES — seats 12)
  const nc = new Fake("check");
  await nc.connect(url("ares"));
  nc.send({ t: "checkname", name: "NEUKALE", room: "ARES-TEST" });
  const chk = await nc.waitFor((m) => m.find((x) => x.t === "namecheck"));
  console.log(`[ares] namecheck ok=${chk.ok} exists=${chk.room?.exists} map=${chk.room?.map} maxPlayable=${chk.room?.maxPlayable} players=${chk.room?.players}`);
  if (chk.room?.exists !== true) throw new Error("namecheck: room not found");
  if (chk.room?.map !== "ares") throw new Error("namecheck: wrong map");

  // ---------- 4) PRIVATE GUN GAME ----------
  const gh = new Fake("gun-host");
  const gg = new Fake("gun-guest");
  await gh.connect(url());
  await gg.connect(url());
  gh.send({ t: "join", name: "GUN-HOST", room: "GUN-TEST", mode: "gun", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  gg.send({ t: "join", name: "GUN-GUEST", room: "GUN-TEST", mode: "gun", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  await gh.waitFor((m) => m.find((x) => x.t === "welcome"));
  const glob = await gh.waitFor((m) => m.find((x) => x.t === "lobby" && x.players?.length === 2));
  console.log(`[gun] lobby mode=${glob.mode} maxPlayable=${glob.maxPlayable} players=${glob.players.map((p) => p.name).join("/")}`);
  if (glob.mode !== "gun") throw new Error(`gun lobby.mode=${glob.mode}, expected gun`);
  // nuketown gun seats == ffa seats (MAP_SEATS, shared/modes.ts seatsFor)
  if (glob.maxPlayable !== 12) throw new Error(`gun maxPlayable=${glob.maxPlayable}, expected 12`);
  gh.send({ t: "startmatch" });
  await gh.waitFor((m) => m.find((x) => x.t === "start"));
  await sleep(3600);
  const glive = gh.snaps.find((s) => s.phase === "live");
  if (!glive) throw new Error("gun: no live snapshot after countdown");
  console.log(`[gun] live players=${glive.players.length} gun0=${glive.players[0]?.gun}`);
  if (glive.players[0]?.gun !== 0) throw new Error(`gun start value=${glive.players[0]?.gun}, expected 0`);

  // shut the hub worker back down (spawned case)
  if (proc) {
    await new Promise((r) => setTimeout(r, 300));
    proc.kill();
  }
  console.log("ALL TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exit(1);
});
