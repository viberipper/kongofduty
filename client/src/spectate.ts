/**
 * client/src/spectate.ts — SPECTATING, THROUGH ANOTHER PLAYER'S EYES.
 * ===========================================================================
 *
 * WHAT THIS IS
 *
 * A player who arrives at a lobby whose ten playable seats are gone joins the
 * bench instead of being turned away (server/index.ts, MAX_SPECTATORS). Until
 * now the bench was a body standing in the yard with the trigger disabled. This
 * makes it a SEAT BEHIND SOMEBODY ELSE'S EYES: the camera sits at a chosen
 * player's eye, looks where they look, holds their gun, hears what they hear,
 * and left / right click walks the rotation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PERFORMANCE CONTRACT — the reason this file is shaped the way it is
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Spectating must cost the game NOTHING. It is a user requirement and it is
 * also the only honest way to build it, because the spectator's frame budget is
 * the same 4 ms everybody else's is.
 *
 *   1. ONE CAMERA. There is no second view, no second scene, no render target
 *      and no extra pass. This file MOVES the single PerspectiveCamera the
 *      renderer already draws through — exactly what the killcam does, and for
 *      exactly the same reason. Draw calls, triangles, programs and passes are
 *      identical whether you are playing or watching; the only thing that
 *      changes is where the camera's matrix says it is.
 *
 *   2. IT SUBTRACTS WORK, IT DOES NOT ADD IT. A spectating client stops
 *      building, stamping, sending and PREDICTING an input command 64 times a
 *      second (game.ts fixed(), guarded on `spectateCam`) — it does not drive a
 *      body, so it has no business claiming one. It stops painting the 180x180
 *      canvas-2D minimap and the frag pips every frame, because both describe a
 *      body this player does not have. Net per-frame work while spectating is
 *      LOWER than while playing, and the measured frame times say so.
 *
 *   3. THE SERVER NEVER HEARS ABOUT IT. Not one byte of new protocol, not one
 *      new message, not one extra field on the snapshot. The rotation, the
 *      target, the smoothing and the HUD are derived entirely from the snapshot
 *      stream the client is already receiving and already decoding (a spectator
 *      seat is served `all.filter(...)` — every real body in the yard — which is
 *      the whole rotation, already on the wire). Per-tick server cost with a
 *      bench attached is what it was before this file existed, minus the input
 *      commands the bench no longer sends.
 *
 *   4. NO PER-FRAME GARBAGE. The rotation is rebuilt into two module-scope
 *      arrays that are truncated rather than reallocated, the DOM is written
 *      only when a string actually changes, and there is no timer, no
 *      requestAnimationFrame of its own and no observer anywhere in here. The
 *      whole feature is one function call inside the frame that was already
 *      happening.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A HOOK AND NOT AN IMPORT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * game.ts holds a nullable `spectateCam` and calls it where the killcam branch
 * already is. It imports NOTHING from this file — the coupling is one property
 * that is null for every player who is not on the bench, which is also the flag
 * the two other guards read. This keeps the renderer editable by another worker
 * while this feature lands, and it means a spectator client and a playing client
 * run literally the same code path with one predictable branch.
 */

import type { PlayerSnap } from "@shared/protocol";
import { EYE, CROUCH_EYE, SLIDE_EYE } from "@shared/sim";
import { WEAPON_BY_ID } from "@shared/weapons";
import { SCOPE_AT } from "./weapons/hud";
import { angWrap } from "@shared/math";
import { benchPosition } from "./lobby";
import type { Game } from "./game";
import "./spectate.css";

/**
 * FOLLOW SMOOTHING — the one number that decides whether this is watchable.
 *
 * You are riding another player's aim, and their aim is a human flicking a mouse
 * at 64 Hz, delivered to you at 32 Hz and linearly interpolated. Raw, that is a
 * polyline: every direction change is a corner, and corners at head height read
 * as a camera being kicked. Smoothed too hard, the picture lags their shots and
 * you watch them kill people off-screen.
 *
 * These are exponential rates (1 - e^-k·dt), so they are frame-rate independent
 * and they are TIME CONSTANTS, not delays: LOOK_K 17 settles 63% of a step in
 * 59 ms and 95% in 176 ms — under the ~80 ms where a follow starts to read as
 * lag, and comfortably over the ~31 ms snapshot period that produces the
 * corners. Position is tighter (POS_K 26, 38 ms) because the eye must be AT
 * their eye: a soft position is a camera that swims out of the body on every
 * strafe, and unlike aim there is nothing to smooth away — the interpolated
 * position is already continuous.
 */
const LOOK_K = 17;
const POS_K = 26;
/** Field of view chases theirs (ADS, sprint) at the live camera's own rate. */
const FOV_K = 10;

/** Hip / sprint FOV — the same two numbers the playing camera uses. */
const HIP_FOV = 68;
const SPRINT_FOV = 74;

type Ui = {
  root: HTMLElement;
  name: HTMLElement;
  queue: HTMLElement;
  pos: HTMLElement;
  prev: HTMLElement;
  next: HTMLElement;
};

/**
 * What the QA probes read instead of guessing from pixels — the same contract
 * client/src/lobby.ts exposes as window.__lobby.
 */
type Diag = {
  /** TRUE while this client's camera is behind somebody else's eyes. */
  on: boolean;
  /** The spectated player's id and name — what the plate is showing. */
  target: string;
  name: string;
  /** 1-based position in the rotation, and its length. */
  index: number;
  count: number;
  /** 1-based place in the PROMOTION queue (the bench), 0 when not benched. */
  queue: number;
  /** Deliberate switches (click / key) and involuntary ones (death, departure). */
  switches: number;
  autoAdvances: number;
  /** Why the last involuntary switch happened. */
  lastAuto: "" | "died" | "left";
  /** The rotation itself, oldest-stable order — the ids the plate can show. */
  rotation: string[];
};

const diag: Diag = {
  on: false,
  target: "",
  name: "",
  index: 0,
  count: 0,
  queue: 0,
  switches: 0,
  autoAdvances: 0,
  lastAuto: "",
  rotation: [],
};
(window as unknown as { __spectate: Diag }).__spectate = diag;

let game: Game | null = null;
let ui: Ui | null = null;
let targetId = "";
/** Where the target sat in the rotation last frame — the anchor auto-advance uses. */
let lastIdx = 0;
/** The actor we are currently inside, so its mesh can be handed back on a switch. */
let hiddenActor = "";
/** FALSE until the first frame on a target: the camera lands, it does not glide in. */
let primed = false;

// Smoothed camera state. Plain numbers, no vectors, no allocation.
let sx = 0;
let sy = 0;
let sz = 0;
let sYaw = 0;
let sPitch = 0;
let sRoll = 0;
let sFov = HIP_FOV;

// The rotation, rebuilt in place every frame. NEVER reallocated.
const all: PlayerSnap[] = [];
const living: PlayerSnap[] = [];
/**
 * TEAM-ONLY ROTATION (round-based TDM). A player who is dead for the rest of
 * the round watches THEIR OWN TEAM — the bodies whose fate decides the round —
 * and never an enemy: seeing the other side's positions from the grave and
 * calling them out on voice is the oldest exploit in one-life modes. -1 is the
 * bench (a real spectator, everybody visible).
 */
let teamOnly: -1 | 0 | 1 = -1;

function byId(a: PlayerSnap, b: PlayerSnap): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The HUD — four things, built once, written only when a string changes
// ---------------------------------------------------------------------------

function buildUi(): Ui {
  const root = document.createElement("div");
  root.id = "spec-hud";
  root.className = "hidden";

  const plate = document.createElement("div");
  plate.className = "spec-plate";
  const eye = document.createElement("span");
  eye.className = "spec-eye";
  // THE QUEUE POSITION LIVES HERE, and this is the only place it can live during
  // a match: the pre-game bench row that carries it ("#3") is not on screen once
  // the yard is live, and a benched player still has to be able to answer "how
  // long?". Four words on the label that is already up — no second plate.
  const queue = document.createElement("em");
  queue.className = "spec-queue";
  eye.append(document.createElement("i"), document.createTextNode("SPECTATING"), queue);
  const name = document.createElement("b");
  name.id = "spec-name";
  name.textContent = "—";
  plate.append(eye, name);

  const sw = document.createElement("div");
  sw.className = "spec-switch";
  const prev = document.createElement("em");
  prev.textContent = "◀";
  const next = document.createElement("em");
  next.textContent = "▶";
  const lbl = document.createElement("span");
  lbl.className = "spec-lbl";
  lbl.textContent = "SWITCH";
  const pos = document.createElement("i");
  pos.id = "spec-pos";
  pos.textContent = "—";
  sw.append(prev, next, lbl, pos);

  root.append(plate, sw);
  // INSIDE #hud, which is where matchfeel.ts puts its own layer and for the same
  // reason: it inherits the HUD's z-order, its hide-on-menu behaviour and its
  // .killcam-on contract for free, and it costs index.html no edit (that file is
  // shared with other workers in this tree).
  (document.getElementById("hud") ?? document.body).append(root);
  return { root, name, queue, pos, prev, next };
}

function dom(): Ui {
  if (!ui) ui = buildUi();
  return ui;
}

/** Write only what changed: this runs inside the frame, not beside it. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** The keycap flash that proves the click landed even when the yard is chaos. */
let flashT = 0;
let flashEl: HTMLElement | null = null;
function flashKey(el: HTMLElement): void {
  if (flashEl && flashEl !== el) flashEl.classList.remove("hit");
  el.classList.add("hit");
  flashEl = el;
  flashT = 0.14;
}

// ---------------------------------------------------------------------------
// The rotation
// ---------------------------------------------------------------------------

/**
 * Rebuild `all` (every body in the yard that is not us) and `living` (the ones a
 * spectator may be pointed at).
 *
 * THE ORDER IS BY ID, not by roster order, and that is deliberate: `players` is a
 * Map whose insertion order changes every time somebody leaves and rejoins or is
 * re-added by a snapshot, and a rotation that reshuffles under a player's thumb
 * is worse than no rotation at all. Ids are assigned once and never change, so
 * "next" means the same body on every client and on every frame.
 *
 * BOTS ARE IN IT. They hold playable seats, they are in the killfeed and on the
 * scoreboard, and a lobby of one human and nine bots would otherwise give a
 * spectator exactly one thing to look at. The one body that is never in it is
 * another SPECTATOR — the server already erases those from every snapshot except
 * their own (server/index.ts, `hidden`), so there is nothing to filter here.
 */
function rebuild(g: Game): void {
  all.length = 0;
  living.length = 0;
  for (const p of g.players.values()) {
    if (p.id === g.you) continue;
    if (teamOnly !== -1 && p.team !== teamOnly) continue;
    all.push(p);
    if (p.alive) living.push(p);
  }
  all.sort(byId);
  living.sort(byId);
}

/**
 * Point the camera at a living player, and never at anything else.
 *
 * Three cases, in the order they matter:
 *   - the current target is still alive  -> keep it, remember where it sits
 *   - it is gone (mashed, or the seat left) -> AUTO-ADVANCE to the body that has
 *     taken its place in the rotation, which is the next one along, wrapping
 *   - nobody is alive at all (the instant between a double kill and two respawns,
 *     or the end of a match) -> hold the last body we had so the screen keeps a
 *     picture. A black frame is never an acceptable answer.
 */
function resolve(g: Game): PlayerSnap | null {
  const cur = targetId ? g.players.get(targetId) : undefined;
  if (cur && cur.alive) {
    const i = living.indexOf(cur);
    if (i >= 0) lastIdx = i;
    return cur;
  }
  if (living.length) {
    // The dead body is no longer in `living`, so whatever now sits at its old
    // index IS the next player along; past the end, wrap to the front.
    const pick = living[lastIdx % living.length]!;
    if (targetId) {
      diag.autoAdvances++;
      diag.lastAuto = cur ? "died" : "left";
    }
    aim(pick.id, false);
    lastIdx = living.indexOf(pick);
    return pick;
  }
  // Nobody alive. Keep drawing from the last body we had (a corpse still shows
  // the yard) rather than cutting to black; the plate says DOWN.
  return cur ?? all[0] ?? null;
}

/** Take a new target: the camera lands on it rather than gliding across the map. */
function aim(id: string, counted = true): void {
  if (id === targetId) return;
  targetId = id;
  primed = false;
  if (counted) diag.switches++;
}

/** LEFT = previous, RIGHT = next, wrapping. The only two verbs this mode has. */
function spectateStep(dir: -1 | 1): void {
  const g = game;
  if (!g) return;
  rebuild(g);
  if (!living.length) return;
  const cur = targetId ? g.players.get(targetId) : undefined;
  const i = cur && cur.alive ? living.indexOf(cur) : lastIdx - (dir > 0 ? 1 : 0);
  const n = living.length;
  const next = living[(((i + dir) % n) + n) % n]!;
  aim(next.id);
  lastIdx = living.indexOf(next);
  const d = dom();
  flashKey(dir < 0 ? d.prev : d.next);
}

// ---------------------------------------------------------------------------
// Input — the mouse is the headline, the keys are the alternates
// ---------------------------------------------------------------------------

/**
 * ROTATION IS ONLY LIVE WHILE THE MATCH IS ON SCREEN.
 *
 * The POV attaches the instant this seat is benched, which is while the PRE-GAME
 * LOBBY is still up — the roster, the invite link, the host's START button. Every
 * click and key on that screen belongs to that screen, and a window-level capture
 * handler that ate them (or quietly spun the rotation behind them) would be this
 * feature reaching outside its own state. #hud is hidden for the whole of pre-game
 * and shown the moment the countdown starts, so it is exactly the flag: one
 * classList test, no new state, no coupling to lobby.ts.
 *
 * The second half is text fields. Nothing inside the match HUD is one today —
 * the invite bar that used to live there is gone — but the rotation binds A/D
 * and the arrow keys on the window's CAPTURE phase, so any input that ever
 * appears over a live match (a chat box, a console) keeps its own keys.
 */
function povLive(e: Event): boolean {
  const hud = document.getElementById("hud");
  if (!hud || hud.classList.contains("hidden")) return false;
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName;
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !t?.isContentEditable;
}

/**
 * MOUSE — THE HEADLINE. Left click steps back through the rotation, right click
 * steps forward, on the CAPTURE phase of the window so it works over the HUD as
 * well as over the canvas.
 *
 * It does not swallow the event: game.ts's own mousedown still runs, which is
 * what acquires pointer lock on the first click so the cursor gets out of the
 * picture. It cannot fire the gun — the server drops a spectator's trigger
 * outright (gateCmd), lobby.ts has already replaced `keys.fire` with a getter
 * that returns false, and while spectating this client does not send a command
 * at all.
 */
function onMouseDown(e: MouseEvent): void {
  if (!povLive(e)) return;
  if (e.button === 0) spectateStep(-1);
  else if (e.button === 2) {
    e.preventDefault();
    spectateStep(1);
  }
}

/**
 * game.ts already kills the context menu globally. This is belt to that braces,
 * on the capture phase, because a right click that opens a browser menu over a
 * live match is the single most broken thing this feature could do.
 */
function onContextMenu(e: Event): void {
  e.preventDefault();
}

function rotationKey(k: string): -1 | 1 | 0 {
  if (k === "KeyA" || k === "ArrowLeft") return -1;
  if (k === "KeyD" || k === "ArrowRight") return 1;
  return 0;
}

/**
 * KEYS — the alternates. A and D because a spectator's hand is already on WASD,
 * the arrows because a mouse is not the only thing people have.
 *
 * ONLY THE KEYDOWN IS SWALLOWED, and that asymmetry is deliberate. Stopping the
 * press is what keeps game.ts from reading A/D as strafe; letting the RELEASE
 * through costs nothing (it can only ever write `false` into a key that was never
 * set) and removes the one way this could leave a key stuck — a press that
 * happened while the rotation was not live, released after it was, would
 * otherwise hand a promoted player a body that strafes on its own forever.
 */
function onKeyDown(e: KeyboardEvent): void {
  const dir = rotationKey(e.code);
  if (!dir || !povLive(e)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  if (!e.repeat) spectateStep(dir);
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * Called from game.ts draw(), in the slot the killcam already owns, and returns
 * TRUE when it has taken the camera. Everything it touches — position, rotation,
 * fov, the viewmodel, the audio listener — is the same state the playing camera
 * writes, so handing the screen back on promotion is a single frame with nothing
 * to unwind.
 */
function frame(dt: number): boolean {
  const g = game;
  if (!g) return false;
  rebuild(g);
  const t = resolve(g);

  // Keycap flash decay. Seconds, so it is the same 140 ms at 60 fps and at 240.
  if (flashT > 0) {
    flashT -= dt;
    if (flashT <= 0 && flashEl) {
      flashEl.classList.remove("hit");
      flashEl = null;
    }
  }

  paint(t);
  if (!t) {
    // No bodies at all (the roster has not arrived yet). The camera stays where
    // it is and the yard keeps rendering — we simply have nothing to follow, and
    // an empty pair of hands must not hold a gun.
    g.vm.root.visible = false;
    return true;
  }

  // ---- the eye
  const eye = t.slide > 0 ? SLIDE_EYE : t.crouch ? CROUCH_EYE : EYE;
  const px = t.x;
  const py = t.y + eye;
  const pz = t.z;
  const roll = t.slide > 0 ? 0.1 : 0;
  if (!primed) {
    primed = true;
    sx = px;
    sy = py;
    sz = pz;
    sYaw = t.yaw;
    sPitch = t.pitch;
    sRoll = roll;
  } else {
    const kp = 1 - Math.exp(-POS_K * dt);
    sx += (px - sx) * kp;
    sy += (py - sy) * kp;
    sz += (pz - sz) * kp;
    const kl = 1 - Math.exp(-LOOK_K * dt);
    // Shortest way round: without the wrap, a player crossing +-PI spins the
    // spectator's head the long way through the whole yard.
    sYaw += angWrap(t.yaw - sYaw) * kl;
    sPitch += (t.pitch - sPitch) * kl;
    sRoll += (roll - sRoll) * kl;
  }

  const cam = g.camera;
  cam.position.set(sx, sy, sz);
  // Next frame's actor loop sizes tags against THIS eye (see Game.spectateEye).
  (g.spectateEye ??= cam.position.clone()).set(sx, sy, sz);
  cam.up.set(0, 1, 0);
  cam.rotation.order = "YXZ";
  // The same convention the playing camera uses: the sim's yaw looks down -Z, the
  // renderer's looks down +Z, and the half turn is the bridge between them.
  cam.rotation.y = sYaw + Math.PI;
  cam.rotation.x = -sPitch;
  cam.rotation.z = sRoll;

  // ---- their field of view, because ADS is part of what they are seeing
  const w = WEAPON_BY_ID[t.weapon];
  // weapons stream: the same per-weapon ADS rule the playing camera uses — the
  // sights ease the FOV, and a sniper's settled scope IS the view (overlay up,
  // rifle not drawn).
  const hipFov = t.sprint ? SPRINT_FOV : HIP_FOV;
  const adsE = t.ads * t.ads * (3 - 2 * t.ads);
  const scoped = !!w?.scope && t.ads >= SCOPE_AT && (t.swap ?? 0) <= 0;
  const want = !w ? hipFov : w.scope ? (scoped ? w.adsFov : hipFov + (50 - hipFov) * adsE) : hipFov + (w.adsFov - hipFov) * adsE;
  if (scoped) sFov = want;
  else sFov += (want - sFov) * (1 - Math.exp(-FOV_K * dt));
  g.whud.spectScoped = scoped;
  if (Math.abs(cam.fov - sFov) > 0.02) {
    cam.fov = sFov;
    cam.updateProjectionMatrix();
  }
  // Hand the live camera the value the screen is actually showing, so a promotion
  // out of an ADS view punches in instead of jump-cutting (the killcam's trick).
  g.fov = sFov;
  g.grade.uniforms.uAds.value = t.ads;

  // ---- do not draw the inside of their skull
  // The actor loop in draw() only hides a body that is close to the LOCAL player,
  // and the local player is a benched ghost standing somewhere else entirely. It
  // runs BEFORE this, so writing visibility here is what the frame renders.
  if (hiddenActor && hiddenActor !== t.id) {
    const old = g.actors.get(hiddenActor);
    if (old) old.root.visible = true;
  }
  hiddenActor = t.id;
  const a = g.actors.get(t.id);
  if (a) a.root.visible = false;

  // ---- their gun, in their hands
  // One operator, one weapon: the viewmodel in this scene IS their gun, so it is
  // driven from their snapshot rather than hidden. Their reload runs on the plate,
  // their ADS pulls the sights up. `punchY` stays 0 — recoil springback is a local
  // aim channel and does not replicate.
  g.vm.setWeapon(t.weapon);
  const reloadP =
    t.reload > 0 && w ? Math.min(1, Math.max(0.01, 1 - t.reload / ((t.ammo ?? 0) <= 0 ? w.emptyReload : w.reload))) : 0;
  g.vm.update(dt, t.ads, t.sprint, t.slide, Math.hypot(t.vx, t.vz) / 5, reloadP, 0, t.crouch);
  g.vm.root.visible = t.alive && !scoped;

  // ---- their ears
  g.audio.listen(sx, sy, sz, sYaw);
  g.audio.tickAmb(dt);
  return true;
}

/** The four strings. Nothing is written unless it changed. */
function paint(t: PlayerSnap | null): void {
  const d = dom();
  const n = living.length;
  const i = t && t.alive ? living.indexOf(t) : -1;
  setText(d.name, t ? t.name : "—");
  d.name.classList.toggle("down", !!t && !t.alive);
  setText(d.pos, n ? `${(i >= 0 ? i : lastIdx % Math.max(1, n)) + 1} / ${n}` : "—");
  // A findIndex over at most MAX_SPECTATORS (6) ids, into a string that is only
  // written when it changes. Nothing here allocates and nothing here reflows.
  // A dead teammate is not in the promotion queue: the eyebrow says what this
  // seat is waiting for instead.
  const q = teamOnly === -1 ? benchPosition() : 0;
  diag.queue = q;
  setText(d.queue, q > 0 ? `· #${q} IN LINE` : teamOnly !== -1 ? "· TEAM · NEXT ROUND" : "");
  diag.target = t?.id ?? "";
  diag.name = t?.name ?? "";
  diag.index = i >= 0 ? i + 1 : 0;
  diag.count = n;
  if (diag.rotation.length !== living.length) diag.rotation.length = living.length;
  for (let k = 0; k < living.length; k++) diag.rotation[k] = living[k]!.id;
}

// ---------------------------------------------------------------------------
// Attach / detach
// ---------------------------------------------------------------------------

/**
 * Go to the bench. Idempotent — main.ts drives this off the spectator flag, and
 * that flag is read every paint.
 */
export function attachSpectate(g: Game, opts: { team?: 0 | 1 } = {}): void {
  if (game === g) return;
  game = g;
  teamOnly = opts.team ?? -1;
  primed = false;
  targetId = "";
  lastIdx = 0;
  hiddenActor = "";
  sFov = g.fov;
  // A BENCH SEAT PREDICTS NOTHING, so it holds neither of prediction's two
  // artefacts: the unacked command queue and the ghost the server's answers are
  // reconciled against. Dropping them here is what makes `pending === 0 &&
  // ghost === null` an observable fact about a spectating client rather than a
  // hopeful comment, and the first snapshot after a promotion rebuilds the ghost
  // from the spawn the server has just handed over.
  g.pending.length = 0;
  g.ghost = null;
  const d = dom();
  d.root.classList.remove("hidden");
  document.getElementById("hud")?.classList.add("spectate-on");
  document.body.classList.add("spec-pov");
  // A spectator cannot be killed (the server pins their protection and their
  // health), so a killcam can never open over this camera — but if one was on
  // screen at the instant this client was benched, it would stay there forever
  // now that draw() takes the spectator branch first.
  document.getElementById("killcam")?.classList.add("hidden");
  document.getElementById("hud")?.classList.remove("killcam-on");
  window.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("keydown", onKeyDown, true);
  // LAST, so a torn-down attach can never leave the hook live: this property is
  // the flag game.ts's three guards read, and setting it is what starts the mode.
  g.spectateCam = frame;
  diag.on = true;
}

/**
 * Off the bench — promoted into the match, or out of the game entirely. Every
 * piece of shared state this file wrote is handed back in the same order it was
 * taken, so the very next frame is an ordinary playing frame.
 */
export function detachSpectate(g: Game): void {
  if (game !== g && game !== null) return;
  if (g.spectateCam) g.spectateCam = null;
  g.spectateEye = null;
  if (hiddenActor) {
    const old = g.actors.get(hiddenActor);
    if (old) old.root.visible = true;
    hiddenActor = "";
  }
  // The playing camera picks `fov` up from here and eases to its own target, so
  // the cut back into your own eyes is a punch-in and not a jump.
  g.camera.rotation.z = 0;
  game = null;
  teamOnly = -1;
  targetId = "";
  primed = false;
  const d = dom();
  d.root.classList.add("hidden");
  if (flashEl) {
    flashEl.classList.remove("hit");
    flashEl = null;
  }
  flashT = 0;
  document.getElementById("hud")?.classList.remove("spectate-on");
  document.body.classList.remove("spec-pov");
  window.removeEventListener("mousedown", onMouseDown, true);
  window.removeEventListener("contextmenu", onContextMenu, true);
  window.removeEventListener("keydown", onKeyDown, true);
  diag.on = false;
  diag.target = "";
  diag.name = "";
  diag.index = 0;
  diag.count = 0;
  diag.queue = 0;
}
