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
  "alt","altAmmo","altRes","swap","cook","gun","bot","lean",
];
function decodeMsg(m) {
  if (m?.t === "snap" && Array.isArray(m.players)) {
    if (m.packed === 1) {
      m.players = m.players.map((row) => {
        const p = {};
        PACK_FIELDS.forEach((k, i) => (p[k] = row[i]));
        // Strict bot-flag read (shared/snapshot-wire.ts asBotFlag): only
        // `true`/`1` is a bot — absent, null, 0 or "false" is human.
        p.bot = p.bot === true || p.bot === 1;
        return p;
      });
      delete m.packed;
    } else {
      for (const p of m.players)
        if (p && typeof p === "object") p.bot = p.bot === true || p.bot === 1;
    }
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

  // ---------- 1a0) LEAN round-trip (Q/E, additive protocol field) ----------
  // The server accepts `lean` on input and echoes it on the snapshot's own
  // body; then back to neutral (no stickiness). After this the client idles,
  // so a slow keepalive keeps the AFK kick (60 s warn / 90 s kick) off it.
  let lseq = seq;
  const lrun = setInterval(() => {
    a.send({ t: "in", cmd: cmd(lseq++, { lean: 1 }) });
  }, 15);
  await sleep(700);
  clearInterval(lrun);
  const lSnap = a.snaps[a.snaps.length - 1];
  const meL = lSnap.players.find((p) => p.id === snap.you);
  console.log(`[pub] lean round-trip lean=${meL.lean}`);
  if (meL.lean !== 1) throw new Error(`lean round-trip=${meL.lean}, expected 1`);
  const nrun = setInterval(() => {
    a.send({ t: "in", cmd: cmd(lseq++, { lean: 0 }) });
  }, 15);
  await sleep(700);
  clearInterval(nrun);
  const nSnap = a.snaps[a.snaps.length - 1];
  const meN = nSnap.players.find((p) => p.id === snap.you);
  if (meN.lean !== 0) throw new Error(`lean release=${meN.lean}, expected 0`);
  console.log("[pub] lean release ok");
  const keep = setInterval(() => {
    a.send({ t: "in", cmd: cmd(lseq++) });
  }, 5000);

  // ---------- 1a2) PUBLIC TDM — second human joins the RUNNING yard ----------
  // No new room per join, no private lobby: the same "" room, an immediate
  // seat (no bench), exactly one bot evicted (total stays at seatCount), and
  // the first human still plays beside the newcomer.
  // The codeless checkname (the yard gate's exact message) answers with the
  // running yard — not a bare ok — so the gate sees the live match.
  const ychk = new Fake("pub-check");
  await ychk.connect(url());
  ychk.send({ t: "checkname", name: "LOOKER", room: "", mode: "tdm" });
  const ync = await ychk.waitFor((m) => m.find((x) => x.t === "namecheck"));
  console.log(`[pub-check] room=${JSON.stringify(ync.room)}`);
  if (!ync.room || ync.room.exists !== true) throw new Error("yard checkname carries no running room");
  if (ync.room.phase !== "live") throw new Error(`yard checkname phase=${ync.room.phase}, expected live`);
  if (ync.room.mode !== "tdm") throw new Error(`yard checkname mode=${ync.room.mode}, expected tdm`);
  ychk.ws.close();
  const tdmSnapBefore = a.snaps.length ? a.snaps[a.snaps.length - 1] : snap;
  const tdmTickB = tdmSnapBefore.tick ?? -1;
  const tdmBotsB = tdmSnapBefore.players.filter((p) => p.bot).length;
  const tdmTotalB = tdmSnapBefore.players.length;
  const b = new Fake("pub-2");
  await b.connect(url());
  b.send({ t: "join", name: "BRAVO", team: -1, mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1" });
  const wel2 = await b.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[pub-2] welcome ok room=${wel2.room} name=${wel2.name} spectator=${wel2.spectator} (first room=${wel.room})`);
  if (wel2.room !== wel.room) throw new Error(`TDM room split: first=${wel.room} second=${wel2.room}`);
  if (wel2.room !== "") throw new Error(`Second TDM join welcome.room=${wel2.room}, expected "" (the running yard)`);
  if (wel2.spectator) throw new Error("second TDM human parked as spectator, expected immediate seat");
  const snap2 = await b.waitFor((m) => m.find((x) => x.t === "snap" && x.mode === "tdm" && (x.tick ?? 0) > tdmTickB));
  const meB = snap2.players.find((p) => p.id === snap2.you);
  console.log(`[pub-2] snap mode=${snap2.mode} players=${snap2.players.length} me=${meB ? "found" : "MISSING"} tick=${snap2.tick} (was ${tdmTickB})`);
  if (!meB) throw new Error("second TDM body missing from snapshot");
  if (meB.bot) throw new Error("second TDM body flagged as bot");
  if (snap2.players.length !== tdmTotalB) throw new Error(`TDM yard total=${snap2.players.length}, expected ${tdmTotalB} (seatCount)`);
  const tdmBotsA = snap2.players.filter((p) => p.bot).length;
  console.log(`[pub-2] bots before=${tdmBotsB} after=${tdmBotsA} total=${snap2.players.length}`);
  if (tdmBotsA !== tdmBotsB - 1) throw new Error(`TDM bots went ${tdmBotsB}→${tdmBotsA}, expected exactly one fewer`);
  const fresh1 = await a.waitFor((m) =>
    m.find((x) => x.t === "snap" && x.mode === "tdm" && (x.tick ?? 0) > tdmTickB && x.players?.some((p) => p.name === wel2.name)),
  );
  console.log(`[pub-2] first seat still live tick=${fresh1.tick} players=${fresh1.players.length}`);
  if (!fresh1.players.some((p) => p.name === wel.name)) throw new Error(`first TDM human ${wel.name} missing after second join`);

  // ---------- 1b) PUBLIC GUN GAME — the picked mode's yard, not the TDM one ----------
  // A modeless join lands in TDM (""); a join with mode gun must land in a
  // separate always-live yard running the gun sim (snap.mode gun + ladder).
  const tdmTickBefore = a.snaps.length ? a.snaps[a.snaps.length - 1].tick ?? -1 : -1;
  const pgun = new Fake("pub-gun");
  await pgun.connect(url());
  pgun.send({ t: "join", name: "GUNNER", team: -1, mode: "gun", map: "nuketown", snapshotFormat: "compact-v1" });
  const gwel = await pgun.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[pub-gun] welcome ok room=${gwel.room} name=${gwel.name} (tdm room=${wel.room})`);
  if (gwel.room !== "yard:gun") throw new Error(`Gun yard welcome.room=${gwel.room}, expected yard:gun`);
  if (wel.room !== "") throw new Error(`TDM yard welcome.room=${wel.room}, expected ""`);
  const gsnap = await pgun.waitFor((m) => m.find((x) => x.t === "snap" && x.mode === "gun"));
  console.log(`[pub-gun] snap mode=${gsnap.mode} players=${gsnap.players.length} gun0=${gsnap.players[0]?.gun}`);
  if (gsnap.players.length !== 12) throw new Error(`Gun yard has ${gsnap.players.length} bodies, expected 12`);
  if (gsnap.players[0]?.gun !== 0) throw new Error(`gun start value=${gsnap.players[0]?.gun}, expected 0`);
  // The TDM yard next door is untouched: wait for a FRESH post-gun-join snap
  // (tick beyond the pre-join one — a.snaps[last] could predate the gun join)
  // and assert it is still TDM.
  const tsnap = await a.waitFor((m) =>
    m.find((x) => x.t === "snap" && x.mode === "tdm" && (x.tick ?? 0) > tdmTickBefore),
  );
  console.log(`[pub-gun] tdm fresh ok tick=${tsnap.tick} (was ${tdmTickBefore}) mode=${tsnap.mode} players=${tsnap.players.length}`);
  if (tsnap.mode !== "tdm") throw new Error(`TDM yard mode=${tsnap.mode}, expected tdm`);
  if (tsnap.players.length !== 12) throw new Error(`TDM yard has ${tsnap.players.length} bodies, expected 12`);
  // Roster-level cross-talk: neither yard lists the other's human.
  const tdmNames = tsnap.players.map((p) => p.name);
  const gunNames = gsnap.players.map((p) => p.name);
  if (tdmNames.includes(gwel.name)) throw new Error(`cross-talk: ${gwel.name} leaked into the TDM yard`);
  if (gunNames.includes(wel.name)) throw new Error(`cross-talk: ${wel.name} leaked into the gun yard`);

  // ---------- 1b2) PUBLIC GUN GAME — second human joins while the first is inside ----------
  // Same yard:gun room, second seat plays immediately (no spectator bench),
  // exactly one bot makes room (total stays at seatCount), and neither gun
  // name leaks into the TDM yard next door.
  const gunSnapBefore = pgun.snaps.length ? pgun.snaps[pgun.snaps.length - 1] : gsnap;
  const gunTickBefore = gunSnapBefore.tick ?? -1;
  const botsBefore = gunSnapBefore.players.filter((p) => p.bot).length;
  const totalBefore = gunSnapBefore.players.length;
  const pgun2 = new Fake("pub-gun2");
  await pgun2.connect(url());
  pgun2.send({ t: "join", name: "GUNNER2", team: -1, mode: "gun", map: "nuketown", snapshotFormat: "compact-v1" });
  const gwel2 = await pgun2.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[pub-gun2] welcome ok room=${gwel2.room} name=${gwel2.name} spectator=${gwel2.spectator} (first room=${gwel.room})`);
  if (gwel2.room !== "yard:gun") throw new Error(`Second gun join welcome.room=${gwel2.room}, expected yard:gun`);
  if (gwel2.room !== gwel.room) throw new Error(`Gun room split: first=${gwel.room} second=${gwel2.room}`);
  if (gwel2.spectator) throw new Error("second gun human parked as spectator, expected immediate seat");
  const gsnap2 = await pgun2.waitFor((m) => m.find((x) => x.t === "snap" && x.mode === "gun" && (x.tick ?? 0) > gunTickBefore));
  const meGun2 = gsnap2.players.find((p) => p.id === gsnap2.you);
  console.log(`[pub-gun2] snap mode=${gsnap2.mode} players=${gsnap2.players.length} me=${meGun2 ? "found" : "MISSING"} tick=${gsnap2.tick} (was ${gunTickBefore})`);
  if (!meGun2) throw new Error("second gun body missing from snapshot");
  if (meGun2.bot) throw new Error("second gun body flagged as bot");
  if (gsnap2.players.length !== totalBefore) throw new Error(`Gun yard total=${gsnap2.players.length}, expected ${totalBefore} (seatCount)`);
  const botsAfter = gsnap2.players.filter((p) => p.bot).length;
  console.log(`[pub-gun2] bots before=${botsBefore} after=${botsAfter} total=${gsnap2.players.length}`);
  if (botsAfter !== botsBefore - 1) throw new Error(`Gun bots went ${botsBefore}→${botsAfter}, expected exactly one fewer`);
  // First seat still plays in the same yard post-join.
  const gFresh1 = await pgun.waitFor((m) =>
    m.find((x) => x.t === "snap" && x.mode === "gun" && (x.tick ?? 0) > gunTickBefore && x.players?.some((p) => p.name === gwel2.name)),
  );
  console.log(`[pub-gun2] first seat still live tick=${gFresh1.tick} players=${gFresh1.players.length}`);
  if (!gFresh1.players.some((p) => p.name === gwel.name)) throw new Error(`first gun human ${gwel.name} missing after second join`);
  // Cross-room isolation holds for BOTH gun humans.
  const tdmTickBefore2 = a.snaps.length ? a.snaps[a.snaps.length - 1].tick ?? -1 : -1;
  const tsnap2 = await a.waitFor((m) =>
    m.find((x) => x.t === "snap" && x.mode === "tdm" && (x.tick ?? 0) > tdmTickBefore2),
  );
  const tdmNames2 = tsnap2.players.map((p) => p.name);
  console.log(`[pub-gun2] tdm fresh ok tick=${tsnap2.tick} players=${tsnap2.players.length}`);
  if (tdmNames2.includes(gwel.name)) throw new Error(`cross-talk: ${gwel.name} leaked into the TDM yard`);
  if (tdmNames2.includes(gwel2.name)) throw new Error(`cross-talk: ${gwel2.name} leaked into the TDM yard`);

  // ---------- 1c) PUBLIC FFA — the yard:ffa branch (yardKey/getOrCreateYard) ----------
  const pffa = new Fake("pub-ffa");
  await pffa.connect(url());
  pffa.send({ t: "join", name: "FFAER", team: -1, mode: "ffa", map: "nuketown", snapshotFormat: "compact-v1" });
  const fwel = await pffa.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[pub-ffa] welcome ok room=${fwel.room} name=${fwel.name}`);
  if (fwel.room !== "yard:ffa") throw new Error(`FFA yard welcome.room=${fwel.room}, expected yard:ffa`);
  const fsnap = await pffa.waitFor((m) => m.find((x) => x.t === "snap" && x.mode === "ffa"));
  console.log(`[pub-ffa] snap mode=${fsnap.mode} players=${fsnap.players.length}`);
  if (fsnap.mode !== "ffa") throw new Error(`FFA yard mode=${fsnap.mode}, expected ffa`);
  if (fsnap.players.length !== 12) throw new Error(`FFA yard has ${fsnap.players.length} bodies, expected 12`);
  pffa.ws.close();

  // ---------- 1d) MODELLESS JOIN — old clients land in the TDM yard ("") ----------
  const pold = new Fake("pub-old");
  await pold.connect(url());
  pold.send({ t: "join", name: "OLDCLIENT", team: -1, map: "nuketown", snapshotFormat: "compact-v1" });
  const owel = await pold.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[pub-old] welcome ok room=${owel.room} name=${owel.name}`);
  if (owel.room !== "") throw new Error(`Modeless join welcome.room=${owel.room}, expected "" (TDM yard)`);
  const osnap = await pold.waitFor((m) => m.find((x) => x.t === "snap" && x.mode === "tdm"));
  console.log(`[pub-old] snap mode=${osnap.mode} players=${osnap.players.length}`);
  if (osnap.players.length !== 12) throw new Error(`TDM yard has ${osnap.players.length} bodies, expected 12`);
  pold.ws.close();
  b.ws.close();
  pgun.ws.close();
  pgun2.ws.close();

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

  // ---------- 2b) TEXT CHAT: relay, server-side name, filter, private notice ----------
  // The room above is live with host+guest seated: a clean line from the host
  // must reach BOTH clients' snapshot event lists carrying the SERVER's seat
  // name (hw.name — the client sends no name, spoofing is impossible), while
  // a blocked word must reach NOBODY as chat and only the sender as `notice`.
  h.msgs.length = 0;
  g.msgs.length = 0;
  h.send({ t: "chat", text: "hello chat" });
  const chatH = await h.waitFor((m) => m.find((x) => x.t === "snap" && x.ev?.some((e) => e.t === "chat" && e.text === "hello chat")));
  const chatG = await g.waitFor((m) => m.find((x) => x.t === "snap" && x.ev?.some((e) => e.t === "chat" && e.text === "hello chat")));
  const chatEv = chatH.ev.find((e) => e.t === "chat" && e.text === "hello chat");
  console.log(`[chat] broadcast ok from=${chatEv.name} (both seats got it: ${!!chatG})`);
  if (chatEv.name !== hw.name) throw new Error(`chat carried name=${chatEv.name}, expected server-side ${hw.name}`);
  await sleep(1200); // past the ~1 msg/s cooldown before the next line
  h.msgs.length = 0;
  g.msgs.length = 0;
  h.send({ t: "chat", text: "this is shit" });
  const notice = await h.waitFor((m) => m.find((x) => x.t === "notice"));
  console.log(`[chat] blocked ok, sender-only notice=${JSON.stringify(notice.text)}`);
  if (!/blocked/i.test(notice.text ?? "")) throw new Error("notice text does not say blocked");
  await sleep(1500); // a full snapshot cycle: a leak would have landed by now
  const leaked = [...h.msgs, ...g.msgs].some((x) => x.t === "snap" && x.ev?.some((e) => e.t === "chat" && e.text === "this is shit"));
  if (leaked) throw new Error("blocked chat was broadcast");
  console.log("[chat] no broadcast of the blocked line on either seat");

  // ---------- 2c) Reserved callsign: "SERVER" must never be assigned ----------
  // System notices render as "SERVER:" lines, so joining with that name has to
  // come back as something else (cleanName falls back, dedupe uniquifies).
  const srv = new Fake("srv-name");
  await srv.connect(url());
  srv.send({ t: "join", name: "SERVER", team: -1, mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1" });
  const srvWel = await srv.waitFor((m) => m.find((x) => x.t === "welcome"));
  console.log(`[name] reserved SERVER join got name=${srvWel.name}`);
  if (srvWel.name.toLowerCase() === "server") throw new Error("reserved name SERVER was assigned");
  srv.ws.close();

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

  // ---------- 5) PRIVATE LOBBY: host move + host handover ----------
  // Room MV-TEST: pregame move/bench/promote/team-toggle are host-only (a
  // guest move is ignored with no broadcast), then the chair moves to the
  // guest and the NEW host starts the match.
  const mh = new Fake("mv-host");
  const mg = new Fake("mv-guest");
  await mh.connect(url());
  await mg.connect(url());
  mh.send({ t: "join", name: "MV-HOST", room: "MV-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  mg.send({ t: "join", name: "MV-GUEST", room: "MV-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  const mhw = await mh.waitFor((m) => m.find((x) => x.t === "welcome"));
  const mgw = await mg.waitFor((m) => m.find((x) => x.t === "welcome"));
  await mh.waitFor((m) => m.find((x) => x.t === "lobby" && x.players?.length === 2));
  console.log(`[mv] lobby host=${mhw.id} guest=${mgw.id}`);
  // 5a) guest start is refused
  mg.msgs.length = 0;
  mg.send({ t: "startmatch" });
  const deny = await mg.waitFor((m) => m.find((x) => x.t === "err"));
  if (!/ONLY THE LOBBY HOST/.test(deny.msg)) throw new Error(`guest start err=${deny.msg}, expected host-only refusal`);
  console.log("[mv] guest start refused ok");
  // 5b) host benches the guest
  mh.msgs.length = 0; mg.msgs.length = 0;
  mh.send({ t: "lobbymove", id: mgw.id, spectator: true });
  const benched = await mh.waitFor((m) => m.find((x) => x.t === "lobby" && x.players?.length === 1 && x.spectators?.length === 1));
  if (benched.spectators[0]?.id !== mgw.id) throw new Error("benched spectator is not the guest");
  console.log("[mv] host bench ok");
  // 5c) guest move is ignored (no broadcast anywhere)
  await sleep(650); // past the host's 500 ms lobby-write gate before the next host write below
  mh.msgs.length = 0; mg.msgs.length = 0;
  mg.send({ t: "lobbymove", id: mhw.id, spectator: true });
  await sleep(700);
  if (mh.msgs.some((x) => x.t === "lobby") || mg.msgs.some((x) => x.t === "lobby")) throw new Error("guest lobbymove broadcast, expected ignore");
  console.log("[mv] guest move ignored ok");
  // 5d) host promotes back
  mh.send({ t: "lobbymove", id: mgw.id, spectator: false });
  await mh.waitFor((m) => m.find((x) => x.t === "lobby" && x.players?.length === 2));
  await mg.waitFor((m) => m.find((x) => x.t === "promoted"));
  console.log("[mv] host promote ok");
  // 5e) bare move = team toggle, roster intact
  await sleep(650);
  mh.msgs.length = 0;
  mh.send({ t: "lobbymove", id: mgw.id });
  const toggled = await mh.waitFor((m) => m.find((x) => x.t === "lobby" && x.players?.length === 2));
  if (toggled.players.some((p) => p.id === mgw.id) !== true) throw new Error("guest missing after team toggle");
  console.log("[mv] host team-toggle ok");
  // 5f) host hands the chair over
  await sleep(650);
  mh.msgs.length = 0; mg.msgs.length = 0;
  mh.send({ t: "lobbyhost", id: mgw.id });
  const handed = await mh.waitFor((m) => m.find((x) => x.t === "lobby" && x.host === mgw.id));
  if (handed.host !== mgw.id) throw new Error("host handover did not land");
  console.log("[mv] host handover ok");
  // 5g) the NEW host starts
  await sleep(650);
  mg.msgs.length = 0;
  mg.send({ t: "startmatch" });
  await mg.waitFor((m) => m.find((x) => x.t === "start"));
  await sleep(3600);
  const mvlive = mg.snaps.find((s) => s.phase === "live");
  if (!mvlive) throw new Error("mv: no live snapshot after handover start");
  console.log(`[mv] new-host start live ok players=${mvlive.players.length}`);

  // ---------- 6) LATE-JOIN into the live private match ----------
  // Full room (2 humans + bot fill = 12): joiner benches; the gate says so too.
  const lateFull = new Fake("mv-late-full");
  await lateFull.connect(url());
  lateFull.send({ t: "join", name: "MV-LATE", room: "MV-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  const lateFullWel = await lateFull.waitFor((m) => m.find((x) => x.t === "welcome"));
  if (!lateFullWel.spectator) throw new Error("late join to a full live room got a playable seat, expected bench");
  console.log("[mv-late] full-room join benched ok");
  const lk = new Fake("mv-check");
  await lk.connect(url());
  lk.send({ t: "checkname", name: "LOOKER2", room: "MV-TEST" });
  const lkNc = await lk.waitFor((m) => m.find((x) => x.t === "namecheck"));
  if (!lkNc.room || lkNc.room.phase !== "live") throw new Error(`late namecheck phase=${lkNc.room?.phase}, expected live`);
  if (!lkNc.room.spectate) throw new Error("late namecheck spectate=false on a full live room, expected true");
  console.log("[mv-late] namecheck spectate ok");
  lk.ws.close();
  // Free exactly one body with an empty bench: benched late joiner leaves,
  // then the old host leaves (no bot refill in private rooms).
  lateFull.ws.close();
  await sleep(600);
  const tickBeforeLate = mg.snaps.length ? (mg.snaps[mg.snaps.length - 1].tick ?? -1) : -1;
  mh.ws.close();
  await sleep(800);
  // A freed seat joins straight into the RUNNING match — no reset: the tick
  // keeps climbing and the seated host is still listed beside the newcomer.
  const late2 = new Fake("mv-late2");
  await late2.connect(url());
  late2.send({ t: "join", name: "MV-LATE2", room: "MV-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  const late2Wel = await late2.waitFor((m) => m.find((x) => x.t === "welcome"));
  if (late2Wel.spectator) throw new Error("late join to a freed live seat benched, expected direct seat");
  const late2Snap = await late2.waitFor((m) =>
    m.find((x) => x.t === "snap" && x.phase === "live" && (x.tick ?? 0) > tickBeforeLate && x.players?.some((p) => p.id === late2Wel.id)),
  );
  if (!late2Snap.players.some((p) => p.name === mgw.name)) throw new Error(`seated host ${mgw.name} missing after late join (match reset?)`);
  if (late2Snap.players.length !== 12) throw new Error(`live total=${late2Snap.players.length} after late join, expected 12`);
  console.log(`[mv-late] freed-seat join live ok tick=${late2Snap.tick} (was ${tickBeforeLate}) players=${late2Snap.players.length}`);

  // ---------- 7) HOST-LEAVE transfers by join order (NOT ping) ----------
  // Seat.ping rides the client's self-reported rtt and is spoofable
  // (rtt:1 would steal the chair), so the succession ignores ping entirely:
  // the oldest remaining seat wins even though the YOUNGEST seat reports the
  // lowest ping.
  const ph = new Fake("ping-host");
  const p1 = new Fake("ping-1");
  const p2 = new Fake("ping-2");
  await ph.connect(url());
  await p1.connect(url());
  await p2.connect(url());
  ph.send({ t: "join", name: "PING-HOST", room: "PING-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  const phw = await ph.waitFor((m) => m.find((x) => x.t === "welcome"));
  // Sequential joins (each welcome awaited) so the server seats PING-TWO
  // strictly before PING-ONE — arrival order, not timestamp luck, decides.
  p2.send({ t: "join", name: "PING-TWO", room: "PING-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  const p2w = await p2.waitFor((m) => m.find((x) => x.t === "welcome"));
  p1.send({ t: "join", name: "PING-ONE", room: "PING-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  const p1w = await p1.waitFor((m) => m.find((x) => x.t === "welcome"));
  await ph.waitFor((m) => m.find((x) => x.t === "lobby" && x.players?.length === 3));
  if (phw.id === undefined || p1w.id === undefined || p2w.id === undefined) throw new Error("ping room welcomes missing ids");
  // Host 120 ms, p2 60 ms, p1 20 ms (lowest — but youngest, must NOT win).
  ph.send({ t: "ping", t0: Date.now(), rtt: 120 });
  await sleep(300);
  p2.send({ t: "ping", t0: Date.now(), rtt: 60 });
  await sleep(300);
  p1.send({ t: "ping", t0: Date.now(), rtt: 20 });
  await sleep(500);
  p1.msgs.length = 0; p2.msgs.length = 0;
  ph.ws.close();
  const pingHost = await p2.waitFor((m) => m.find((x) => x.t === "lobby" && x.host === p2w.id));
  console.log(`[ping] host-leave transfer host=${pingHost.host} (oldest remaining ${p2w.name}; lowest ping ${p1w.name} ignored)`);
  if (pingHost.host !== p2w.id) throw new Error(`host went to ${pingHost.host}, expected oldest-remaining ${p2w.id}`);
  const pingHost2 = await p1.waitFor((m) => m.find((x) => x.t === "lobby" && x.host === p2w.id));
  if (pingHost2.host !== p2w.id) throw new Error("remaining seats disagree on the new host");
  p1.ws.close(); p2.ws.close();
  // Fallback with no ping numbers at all: join order (oldest seat) wins.
  const fh = new Fake("fb-host");
  const fg = new Fake("fb-guest");
  await fh.connect(url());
  await fg.connect(url());
  fh.send({ t: "join", name: "FB-HOST", room: "FB-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  fg.send({ t: "join", name: "FB-GUEST", room: "FB-TEST", mode: "tdm", map: "nuketown", snapshotFormat: "compact-v1", lobby: true });
  await fh.waitFor((m) => m.find((x) => x.t === "welcome"));
  const fgw = await fg.waitFor((m) => m.find((x) => x.t === "welcome"));
  await fg.waitFor((m) => m.find((x) => x.t === "lobby" && x.players?.length === 2));
  fg.msgs.length = 0;
  fh.ws.close();
  const fbHost = await fg.waitFor((m) => m.find((x) => x.t === "lobby" && x.host === fgw.id));
  if (fbHost.host !== fgw.id) throw new Error("no-ping fallback did not hand the chair to the oldest seat");
  console.log("[ping] no-ping fallback (join order) ok");
  fg.ws.close();
  mg.ws.close();
  late2.ws.close();

  // shut the hub worker back down (spawned case)
  clearInterval(keep);
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
