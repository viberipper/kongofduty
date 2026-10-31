import * as THREE from "three";
import { decodeServerMessage } from '../../shared/snapshot-wire';
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import {
  GameSession,
  localCmd,
  predictMovement,
  aimDir,
  leanEye,
  nadeSpawn,
  predictNade,
  rayPlayer,
  isHeadshot,
  botPrimary,
  EYE,
  CROUCH_EYE,
  SLIDE_EYE,
  MAX_RENDER_LAG,
  NADE_SPEED,
  NADE_UP,
  NADE_INHERIT,
  NADE_FUSE,
  type NadeBody,
} from "@shared/sim";
import { WEAPON_BY_ID, PRIMARY_WEAPON_ID, HIP_FOV } from "@shared/weapons";
import { readLoadout, saveLoadout, sanitizeLoadout, type Loadout } from "@shared/loadout";
// weapons stream: recoil/punch/scope feel and the weapon HUD feed live in their own modules.
import { WeaponFeel } from "./weapons/feel";
import { WeaponHudDriver, SCOPE_AT } from "./weapons/hud";
import { traceWorld, groundHeight, worldToLocal } from "@shared/map";
import { bulletPath } from "@shared/penetration";
import { activeMap, withMapQuery } from "@shared/maps";
import { ClientDiagnostics } from "./diagnostics";
import { openUdp, udpApiFor, type UdpLane } from "./udp";
import { FootstepCadence, footstepRange, type FootSurface, type FootstepStyle } from "./footsteps";
import { footSurface } from "./foot-surface";
import { nuketownHardFloor } from "./nuketown-surface"; // nuketown: footstep surface
import { captureBugReport } from "./bug-report";

/**
 * THE ACTIVE MAP, read once. `activeMap()` resolves `?map=` on its first call
 * (which happens inside shared/sim.ts's module body, long before this line) and
 * then never changes: one page load is one map, by design — see
 * shared/maps/index.ts. Holding it in a module const rather than calling through
 * on every minimap frame keeps the hot paths free of the lookup.
 */
const MAP = activeMap();
const MAP_SOLIDS = MAP.solids;
/**
 * SHADOW PENUMBRA CAP (both backends): r187 removed PCFSoft entirely, and both
 * surviving PCF paths are a FIVE-SAMPLE VOGEL-DISK filter whose only width knob
 * is shadowRadius in shadow texels — WebGL: the PCF `getShadow` in
 * `ShaderChunk.shadowmap_pars_fragment` (build/three.module.js — note the chunk
 * lives there, NOT in three.core.js, where a grep finds nothing) sums
 * `vogelDiskSample( 0..4, 5, phi )` over `radius = shadowRadius * texelSize`;
 * WebGPU/TSL: `PCFShadowFilter` in build/three.webgpu.nodes.js, "5 samples using
 * Vogel disk distribution". Widening that toward the old authored radii reads
 * as speckle. Clamped to 1.6 texels; see clampShadowRadii.
 */
const SHADOW_RADIUS_MAX = 1.6;
/**
 * `groundHeight` with the footprint tolerance taken OFF (shared/map.ts matches
 * with GH_TOL = 0.12 m so a 0.30 m body is caught by a point test). The sim
 * wants the tolerance — it is what stops a body falling through a tread seam.
 * The RENDERER wants the other answer once: "is this body strictly over that
 * floor, or is the sim carrying it early?" — see `remoteStepY`. Point test,
 * same y-awareness, no allocation; only called while a remote body is inside a
 * step ease, which is a handful of actors for ~135 ms at a time.
 */
function strictGroundY(x: number, z: number, fromY: number): number {
  let h = MAP.floorY ?? 0;
  const lim = fromY + 1.05;
  for (let i = 0; i < MAP_SOLIDS.length; i++) {
    const o = MAP_SOLIDS[i]!;
    if (!o.climb) continue;
    const top = o.y + o.sy * 0.5;
    if (top > lim || top <= h) continue;
    const loc = worldToLocal(o, x, z);
    if (Math.abs(loc.x) <= o.sx * 0.5 && Math.abs(loc.z) <= o.sz * 0.5) h = top;
  }
  return h;
}
import { angWrap } from "@shared/math";
import {
  TICK_DT,
  SNAP_HZ,
  INTERP_MS,
  TDM_MATCH_TIME,
  FFA_KILL_LIMIT,
  ROUNDS_TO_WIN,
  matchTimeFor,
  scoreLimit,
  RESPITE,
  BOT_NAMES,
  type RoundState,
  type InputCmd,
  type PlayerSnap,
  type PredictionState,
  type NadeSnap,
  type NetEvent,
  type ServerMsg,
  type Team,
} from "@shared/protocol";
import { buildWorld } from "./world";
import {
  Viewmodel,
  NADE_READY_T,
  NADE_THROW_T,
  NADE_RECOVER_T,
  NADE_RELEASE_AT,
  NADE_HOLD_MAX,
  type NadePhase,
} from "./viewmodel";
import { BruiserActor, loadBruiserTemplate, type BruiserTemplate } from "./bruiser";
import { NadeFx, BoomFx, ThrowMarker, NADE_R } from "./fx";
// weapons stream: CoD tracers / per-surface impacts + decals / flesh / 3P flash / brass
import { WeaponFx, viewmodelEject } from "./weapons/fx";
import { AudioRig2 } from "./audio2";
import { aaSamples, isSoftwareGL, maxAnisotropy } from "./textures";
import { MatchFeel } from "./matchfeel";
import { bootStage } from "./bootstage";
// UI stream hooks: player settings (sens/ADS/FOV/invert/render scale) and the
// one seat table every room and the offline match share.
import { prefs, teamColors, vfov } from "./ui/prefs";
import { asModeId, seatsFor, maxSeats, simMode } from "@shared/modes";
import { GUN_KILLS_PER_TIER, asGunKills, gunGoal } from "@shared/gungame";
import { Announcer } from "./announcer"; // match announcer (voice + subtitles)
import { Sprays, sprayHit } from "./sprays"; // spray paint
import { medalLabel, killHow } from "./ui/labels";
import { uiSfx } from "./ui/sfx"; // text chat: one tick per incoming line
import { actionOf, keyboardCodes, wheelCodes, type Action } from "./ui/keybinds"; // feel stream: rebindable controls
// gamepad stream: standard controller mapping, sticks, rumble, aim-assist math (ui/gamepad.ts).
import {
  PAD,
  TRIGGER_HELD,
  activePad,
  assistSlow,
  notePadInput,
  padHeld,
  readPadSticks,
  rumbleBoom,
  rumbleHit,
  rumbleHurt,
  rumbleShot,
} from "./ui/gamepad";
import "./feel.css"; // feel stream: final killcam, medals, kill-feed icons, nuke, extras (one sheet, ui/tokens.css primitives)
// feel stream: the FINAL KILLCAM (clip bookkeeping, pick rule, title/plate chrome)
import {
  FinalKillTape,
  FinalKillcamUi,
  FKC_PRE_MS,
  FKC_TAIL_MS,
  FKC_HOLD_S,
  fkcRate,
  fkcDuration,
  type Clip,
  type TapeHit,
  type TapeShot,
} from "./final-killcam";
// feel stream: CoD medals (KR's accolades), their stings, and the kill feed's weapon icons
import { AccoladeTracker } from "./accolades";
import { Medals } from "./ui/medals";
import { MedalStings } from "./medal-stings";
import { killIconHtml } from "./ui/weapon-icons";
import { FeelExtras } from "./feel-extras"; // feel stream: heartbeat, death recap, spawn-protection crosshair
import { ScorePops } from "./ui/score-pops"; // feel stream R2: +100 KILL beside the crosshair
import { RenderQuality } from "./quality";
import { softwareMaterials } from "./software-materials";
import { RenderTimeline } from "./render-timeline";
import { DepthPrecision } from "./depth-precision";
import { COUNTDOWN_MS, inputLocked, isStaleMatchTick, type MatchPhase } from "@shared/matchphase";
// AAA graphics (feature/aaa-graphics): fused cinematic final pass, map-agnostic
// contact AO, selective bloom, opt-in motion blur, quality presets, GPU-backend
// detection (WebGPU-first via the vendored three r187 WebGPURenderer — see gpu-backend).
import { CINEMATIC } from "./cinematic";
import { ContactAO } from "./ssao";
import { BloomPass } from "./bloom";
import { MotionBlurPass } from "./motion-blur";
import { QUALITY_ENV_BOOST, QUALITY_MAX_SCALE, SHADOW_SIZES } from "./graphics-presets";
import { createRenderer, probeThreeWebGpu, type AnyRenderer, type GpuBackendActive } from "./gpu-backend";
// TSL pipeline as a type only (bundle discipline): it is loaded via
// dynamic import() in init()'s WebGPU branch — see webgpu-pipeline.ts.
import type { WebgpuPipeline, WebgpuPrefsSnapshot } from "./webgpu-pipeline";

/** One received server snapshot, timestamped on the SERVER's clock in ms. */
type Snapshot = { t: number; players: PlayerSnap[]; nades?: NadeSnap[] };

export type BootOpts = {
  name: string;
  mode: "tdm" | "ffa";
  /** GUN GAME: FFA with the ladder (shared/gungame.ts) switched on. */
  gun?: boolean;
  host: string;
  room?: string;
  sens: number;
  vol: number;
  tac: boolean;
  bots?: number;
};

/**
 * NATIVE-RESOLUTION TRUTH. The drawing buffer is the display's real pixel
 * count, capped at 2. Uncapped DPR 3 phones would pay 2.25x the fill of DPR 2
 * for detail no eye resolves; the old cap of 1.75 was worse than either — it
 * asked a retina display for 87.5% of its pixels and then let the compositor
 * scale the result back up, which is exactly the soft "low-res" frame this pass
 * exists to kill. Re-read on EVERY resize: browser zoom and dragging the window
 * between monitors both change devicePixelRatio, and a renderer left on the old
 * ratio draws an upscaled frame until the tab is reloaded.
 */
function pixelRatio(): number {
  // SOFTWARE GL IS A DIFFERENT MACHINE. MEASURED (qa/out/_probe3.mjs, SwiftShader,
  // 1440x900): at DPR 2 the first frame lands 8 s after READY and every frame
  // after it costs 2.8 s — the boot card is the last thing the player ever sees.
  // A Mac whose Chrome has fallen back to SwiftShader (GPU process crashed,
  // "graphics acceleration" off) hit exactly this live on 2026-08-26. Fill cost
  // is the whole bill on a software rasteriser, so the tier renders at a fixed
  // fraction of CSS pixels regardless of the display's DPR.
  if (softwareTier) return SOFTWARE_DPR;
  return Math.min(window.devicePixelRatio || 1, 2);
}
type AaPass = { setSize?(w: number, h: number): void; dispose?(): void };

const SOFTWARE_DPR = 0.45;
let softwareTier = false;

/**
 * QA/automation switch (?nolock=1): drive keyboard and fire WITHOUT pointer
 * lock. The lock needs a trusted user gesture, which a headless harness cannot
 * produce, so every FX/impact check used to be manual. Gameplay-neutral: the
 * switch only widens the input gate, nothing else changes.
 */
const qaNoLock = (): boolean => {
  try {
    return new URLSearchParams(location.search).get("nolock") === "1";
  } catch {
    return false;
  }
};

/**
 * THE POST CHAIN (WebGL slots; see the notes at each pass in init()):
 *
 *   RenderPass (HDR, MSAA) -> ContactAO (ssao.ts, hardware tier only)
 *   -> BloomPass (bloom.ts, HDR highlights only)
 *   -> [MotionBlurPass (motion-blur.ts, opt-in, default OFF)]
 *   -> CINEMATIC (cinematic.ts: the old GRADE's tone map + sRGB encode
 *      VERBATIM, fused with vignette, chromatic aberration, film grain,
 *      color grade, CAS-lite sharpen and DOF-lite)
 *   -> [FXAA (software tier only: the tier where the composer target carries
 *      no MSAA samples, see aaSamples)].
 *
 * WEBGPU (webgpu-pipeline.ts) mirrors exactly this order in TSL:
 *   pass → GTAO → Bloom → [Afterimage] → CINEMATIC extras (linear HDR, 1:1
 *   from cinematic.ts) → renderOutput(ACES+sRGB) →
 *   [FXAA (both tiers)]. See there for the deliberate nuances
 *   (height fog, bloom knee, max-hold, single-sample scene pass) and the
 *   still-open custom ShaderMaterial ports (weapon/nade/nuke FX, Ares
 *   core, Nuketown sky — falling back to empty NodeMaterial).
 *
 * MSAA on the composer's own target (aaSamples) is the real anti-aliasing:
 * SMAA used to run on LINEAR HDR pixels and under-detected exactly the dark
 * edges it was there for, while MSAA antialiases the geometry before anything
 * is resolved. MSAA alone is NOT enough: an alphaTest cutout silhouette is a
 * per-fragment kill that MSAA never sees, so EVERY cutout material must also
 * set alphaToCoverage (jungle-world.ts threads cutoutAA to all six card
 * systems). Miss one and it ships a 1-pixel staircase.
 */
const EMPTY: unknown[] = [];
const EMPTY_NADES: NadeSnap[] = [];

/** QA killswitch (?fxaa=0): drop the FXAA tail (bisection edges vs. grade). */
function qaFxaaOff(): boolean {
  try {
    return new URLSearchParams(location.search).get("fxaa") === "0";
  } catch {
    return false;
  }
}

/**
 * Share of each shot's recoil that goes into the SPRINGBACK channel (recP/recY)
 * instead of the permanent aim climb. The total per-shot kick is unchanged —
 * this only decides how much of it comes back on its own, at w.recoilRec.
 */
const RECOVER = 0.45;

/** Seconds a floating damage number lives. */
const DMG_LIFE = 0.66;

// KILLCAM camera search. The sweep starts on the kill sightline and fans out;
// the first ring of offsets is what a clean yard kill uses, the wide ones are
// for a killer stood in a doorway or hard against a container.
const KC_ARC = [0, 0.28, -0.28, 0.52, -0.52, 0.85, -0.85, 1.25, -1.25, 1.75, -1.75, 2.3, -2.3, Math.PI];
/** The over-the-shoulder offset the sweep aims for, in radians. */
const KC_SHOULDER = 0.28;
const KC_HEIGHTS = [1.78, 2.24, 1.44];
const KC_FALLBACK_HEIGHTS = [1.78, 2.24, 2.9, 1.44];
/** How far behind the killer the camera wants to be, and how far it stays off a wall. */
const KC_IDEAL = 3.0;
const KC_CLEAR = 0.45;
const KC_MIN = 1.5;
/** Circumference of the countdown ring in index.html (r=19). */
const KC_RING = 2 * Math.PI * 19;

// KILLCAM REPLAY. The cut is a killer's-eye REPLAY of the seconds that killed
// you, not a live shot of them standing wherever they wandered next. The tape
// is the drawn frame itself (recordFrame), so what plays back is exactly what
// was on screens — prediction, interpolation and all. The whole cut has to fit
// inside RESPITE (2.35 s): 2.0 s of lead-up, then 0.35 s past the kill, then
// hold on that frame until respawn.
const KC_PRE_MS = 2000;
const KC_TAIL_MS = 350;
/** Record cadence (~33 Hz) and how much tape is kept. */
const KC_REC_MS = 30;
const KC_REC_KEEP_MS = 4500;

export class Game {
  /** Backend-spanning renderer (WebGPURenderer XOR WebGLRenderer). */
  renderer!: AnyRenderer;
  /** Active backend (createRenderer resolves the pref, with WebGL2 fallback). */
  backend: GpuBackendActive = "webgl";
  camera: THREE.PerspectiveCamera;
  /** WebGL2 post chain; null on the WebGPU path (pipeline, see below). */
  composer: EffectComposer | null = null;
  /**
   * TSL post chain (webgpu-pipeline.ts); null on the WebGL path.
   * Public so nuketown-live.ts can read/write the exposure
   * (fallback chain grade → pipeline → 1).
   */
  pipeline: WebgpuPipeline | null = null;
  /** ZERO-FLICKER layer 1 (depth-precision.ts) — WebGL-only, null on WebGPU. */
  depth: DepthPrecision | null = null;
  grade: ShaderPass | null = null;
  world: Awaited<ReturnType<typeof buildWorld>> | null = null;
  inited = false;
  vm = new Viewmodel();
  audio = new AudioRig2();
  /** The 3-2-1 card, the resupply flash and the recovered flash. */
  matchFeel = new MatchFeel();
  /** feel stream: what your kills earn (accolades.ts), how they show (ui/medals.ts) and sound (medal-stings.ts). */
  accolades = new AccoladeTracker();
  medals = new Medals();
  stings = new MedalStings(this.audio);
  extras = new FeelExtras(this.audio);
  scorePops = new ScorePops();
  session: GameSession | null = null;
  net: WebSocket | null = null;
  you = "local";
  snaps: Snapshot[] = [];
  players = new Map<string, PlayerSnap>();
  actors = new Map<string, BruiserActor>();
  bruiserTpl: BruiserTemplate | null = null;
  lastEv: NetEvent[] = [];
  keys = { f: false, b: false, l: false, r: false, jump: false, crouch: false, leanL: false, leanR: false, sprint: false, tac: false, ads: false, fire: false, reload: false, melee: false };
  /**
   * GAMEPAD (ui/gamepad.ts). Analog move −1..1, refreshed every render frame by
   * pollGamepad; fixed() lets the louder of stick vs. WASD win (see localCmd).
   * Buttons feed the SAME inputAction() keyboard/mouse use, so pause menus,
   * the killcam skip and the nade cycle behave identically on both.
   */
  private padMoveX = 0;
  private padMoveZ = 0;
  private padPrev: boolean[] = [];
  /** Last polled RT state — fire's dry-click must fire once per pull, not per frame. */
  private padWasFire = false;
  /** Last polled LT state (analog threshold, not the digital pressed flag). */
  private padWasAds = false;
  yaw = 0;
  pitch = 0;
  recY = 0;
  recP = 0;
  punchY = 0;
  punchP = 0;
  /**
   * ADS-SMOOTHED LOOK (aiming frame-skip fix). The mousemove handler used to
   * read the snapshot's `ads` raw: a 0→1 flip lands up to a snapshot late
   * while the FOV is still mid-lerp, so sensitivity steps mid-zoom and the
   * camera skips. sensAds eases toward the snapshot value on the same ~18/s
   * the FOV lerps at, so the turn rate tracks the picture instead of the
   * network. lastLookT stamps the previous look event for the ease.
   */
  private sensAds = 0;
  private lastLookT = 0;
  /**
   * SINGLE-FRAME LOOK CAP (wall-flick fix). movementX/Y bursts (lock
   * re-acquire, DPI jumps, high-poll-rate stacking) arrive as mousemove
   * events, and the ±160 px spike clamp alone still lets ONE event turn
   * ~89° at max sens — plus N events stack unboundedly per frame. This
   * token bucket bounds the applied look to LOOK_BURST rad instantly and
   * LOOK_RATE rad/s sustained (~1900°/s: honest flicks up to that rate,
   * e.g. a 180° in 100 ms, pass; faster sustained turns are capped, and
   * a teleport does not). Refill uses the event clock
   * so it is refresh-rate independent. lookGapUntil drops the re-acquire
   * burst after a pointer-lock re-acquire (see bindInput).
   */
  private static readonly LOOK_BURST = 0.55;
  private static readonly LOOK_RATE = 0.55 / (1 / 60);
  private lookTokens = Game.LOOK_BURST;
  private lookBudgetT = 0;
  private lookGapUntil = 0;
  /** Set on the first pointer lock; the gap guard only fires on re-acquire. */
  private lookHadLock = false;
  /**
   * Corner-lean view state (Q/E, view-only). leanSm eases toward the held
   * keys every render frame so the eye glides instead of stepping.
   */
  private leanSm = 0;
  /** weapons stream: recoil pattern, punch springs, trauma, scope sway + breath. */
  feel = new WeaponFeel();
  /** weapons stream: hud-api feed + scope / cook ring / grenade danger chrome. */
  whud = new WeaponHudDriver();
  /** The weapon the player last ASKED for (1 / 2 / wheel / Y); "" = keep what is in hand. */
  wantWeapon = "";
  private feelOut: [number, number, number] = [0, 0, 0];
  private wasAlive = false;
  private lastCookTick = 0;
  seq = 0;
  pending: InputCmd[] = [];
  ghost: PlayerSnap | null = null;
  running = false;
  /**
   * TRUE from the first line of start() to stop(), which is EARLIER than
   * `running` — see start(). `running` is what qa/ waits on to mean "the game is
   * up" and is deliberately set only once a seat exists; this one exists to make
   * start() re-entrant-safe across its own awaits, and the two must not be merged.
   */
  private booting = false;
  /** The 1 Hz keepalive, held so a second start() can never leak another. */
  private keepAliveTimer = 0;
  /**
   * THE INPUT CLOCK. Online, commands are built on a ~4 ms timer as well as on
   * the frame: a frame-driven fixed step sends nothing while a heavy frame
   * renders and then the whole backlog at once, and those bursts are what the
   * server's queue backed up on. The timer spreads them back out to one per
   * 15.6 ms wherever the main thread allows. `stepAt` is the wall clock the
   * accumulator was last advanced to, shared by both drivers.
   */
  private stepTimer = 0;
  private stepAt = 0;
  /** THE UDP FAST LANE (client/src/udp.ts): an extra copy of input up and snapshots down. */
  private udp: UdpLane | null = null;
  private udpTries = 0;
  /**
   * Snapshot ticks, because a tick can now arrive twice (UDP and WebSocket):
   * the newest one applied, and the recent ones seen from either lane.
   */
  private snapTick = -1;
  private seenTicks = new Set<number>();
  /** Upstream (.origin 28.10.): NETWORK STATS — [arrival ms, tick] of every distinct snapshot in the last few seconds. */
  private statSnaps: [number, number][] = [];
  private statPings: number[] = [];
  locked = false;
  opts!: BootOpts;
  // r186: THREE.Clock is deprecated (warns per boot) — Timer is the
  // successor with identical getDelta() semantics (seconds), but needs
  // an update() per frame (see loop) instead of auto-update.
  clock = new THREE.Timer();
  acc = 0;
  fov = 68;
  lastHp = 100;
  /** weapons stream: every round's look — tracers, impacts, decals, brass, 3P flash (client/src/weapons/fx). */
  wfx: WeaponFx | null = null;
  /** Banana frags in flight, their trails, the bursts, and the landing marker. */
  nadeFx: NadeFx | null = null;
  boomFx: BoomFx | null = null;
  marker!: ThrowMarker;
  // weapons stream: impacts are timed on the GPU (spawn delay = tracer flight) — no pending list, no per-shot meshes
  bits: THREE.Points | null = null;
  camDummy = new THREE.Object3D();
  /**
   * SPECTATING — the ONE property that couples client/src/spectate.ts to the
   * renderer, and it is null for everybody who is playing.
   *
   * When a client is on the bench, spectate.ts installs a function here that
   * MOVES this camera to another player's eye and returns true. There is no
   * second camera, no second scene, no extra pass: it is the killcam's trick
   * (put the one camera somewhere else and take the local chrome off) held open
   * for as long as the bench lasts.
   *
   * It is also the flag two other guards read — fixed() sends and predicts
   * nothing while it is set, and paintHud() skips the readouts that describe a
   * body this client does not have — so a spectating frame does strictly LESS
   * work than a playing one. Nothing here imports spectate.ts; the hook is the
   * whole contract.
   */
  spectateCam: ((dt: number) => boolean) | null = null;
  /**
   * Where the spectator camera WILL be this frame, written by spectate.ts's
   * frame() and read by draw() before the actor loop. The loop sizes every
   * chevron and name tag against BruiserActor.cameraPos, and it runs BEFORE
   * spectateCam moves the camera — against a stale eye (the corpse, 40 m away)
   * every tag on the spectated squad hit its 2.4x distance boost and a teammate
   * three metres off wore a name three metres wide.
   */
  spectateEye: THREE.Vector3 | null = null;
  /** Round-based TDM: this body is dead for the round and the killcam is over (main.ts reads it every paint). */
  deadSpectate = false;
  killcamT = 0;
  killerId = "";
  /** Length of the cut that is running — the countdown ring reads this. */
  killcamDur = RESPITE;
  /** Name plate text. ONLY the killer's name: the tag lives in its own element. */
  killerName = "";
  /** "MASHED YOU" / "NANA FRAG" / "YOUR OWN NANA" — the how, under the name. */
  killerTag = "";
  /** Seconds the killcam has had no killer to point at (they left the match). */
  private kcLost = 0;
  /** A shot has been framed for this cut (so a mid-cut death can freeze it). */
  private kcPlaced = false;
  private kcPos: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  /** Where you fell. The killcam plants a fading ghost ring on this spot. */
  deathAt: { x: number; y: number; z: number } | null = null;
  /** The killcam tape: drawn frames on the renderT clock, in ms. */
  private rec: { t: number; players: PlayerSnap[] }[] = [];
  /** Shots that flew while the tape rolled, replayed as tracers. */
  private recShots: TapeShot[] = [];
  /** feel stream: hits on the tape (the final killcam replays its killer's hitmarkers). */
  private recHits: TapeHit[] = [];
  /** feel stream: every kill's clip, for the final killcam (final-killcam.ts). */
  private fkTape = new FinalKillTape();
  private fkUi = new FinalKillcamUi();
  /**
   * feel stream: the FINAL KILLCAM while it runs ("play"), and its freeze frame
   * held behind the endcard afterwards ("hold"). null in every live frame.
   */
  fkc: { clip: Clip; clock: number; freeze: number; phase: "play" | "hold"; held: number; shotIdx: number; hitIdx: number; dur: number; t: number; end: () => void } | null = null;
  /** performance.now() when this match ended (main.ts: the endcard countdown subtracts the final killcam). */
  endedAt = 0;
  /**
   * feel stream R2: listeners for the world's SHOT and BOOM events, in server
   * order, on every client (the authoritative rays — the same on all of them),
   * before any local-echo filtering. Cosmetic world reactions hang here.
   */
  worldEvents: ((e: NetEvent) => void)[] = [];
  private recLastT = 0;
  /** Replay playhead on the tape clock (ms); < 0 = no replay, use the old framing. */
  private kcClock = -1;
  /** Playhead value the replay freezes on — the kill moment plus the tail. */
  private kcFreeze = 0;
  /** Next recShots entry the playhead has not passed yet. */
  private kcShotIdx = 0;
  /** feel stream: next recHits entry the playhead has not passed yet. */
  private kcHitIdx = 0;
  /** True exactly while draw() is feeding actors from the tape. */
  private kcReplayOn = false;
  /** The floating YOU tag over your own body in the replay. Built once. */
  private youMarker: THREE.Sprite | null = null;
  /** The banana-yellow death-spot marker, built once and reused. */
  private ghostRing: THREE.Mesh | null = null;
  /** Live frags this frame — the minimap danger blip reads them. */
  private nadeLive: NadeSnap[] = EMPTY_NADES;
  /** id -> when/where that player last fired (minimap gunfire ping). */
  private mapFired = new Map<string, { t: number; x: number; z: number }>();
  onHud: ((s: HudState) => void) | null = null;
  onEnd: ((win: boolean, s0: number, s1: number, board?: EndRow[]) => void) | null = null;
  ended = false;
  /** A new match began after this client's endcard (see the match event). */
  onRematch?: () => void;
  lastShot = 0;
  fireHeld = false;
  shiftTap = 0;
  snapTime = 0;
  snapRecv = 0;
  /** Score and match clock as of the newest snapshot — the online HUD's source. */
  netScore0 = 0;
  netScore1 = 0;
  netRemain = TDM_MATCH_TIME;
  /**
   * END-OF-MATCH WATCHDOG (endWatchdog, called from fixed()): performance.now()
   * when an end-of-match signal was last seen on the wire while !ended — a
   * remain<=0 snapshot, a match/end event, or clinched round wins. Cleared on
   * match/live. The watchdog enters finish() only when this evidence exists
   * AND no snapshot has arrived for seconds, so mid-match jitter can never
   * trip it.
   */
  private endEvidenceAt = 0;
  /**
   * ROLLOVER POINT (shared/matchphase.ts isStaleMatchTick): the snapshot tick
   * the last match/live event was consumed on (-1 = none yet). Duplicate-tick
   * end signals on ticks at or before it are the PREVIOUS match's (frozen-tick
   * retransmit or unordered-lane redelivery landing after the rollover) and
   * must not re-enter finish() — that re-raises the endcard over a live match
   * no further match/live will ever take down.
   */
  private liveTick = -1;
  /**
   * ROUND-BASED TDM (shared/protocol.ts RoundState): the round block off the
   * newest snapshot, null on every other room. Offline the local session is
   * asked directly — roundInfo() is the one read for both.
   */
  netRound: RoundState | null = null;
  lastPredMark = 0;
  /** GUN GAME (shared/gungame.ts): this room plays the ladder, on- or offline. */
  gunGame = false;
  /** GUN GAME kills per gun — this match's (offline: Settings; online: the lobby's). */
  gunKills = GUN_KILLS_PER_TIER;

  /** This match's COMBAT STATS for you (endcard panel; reset at every match start). */
  combat: CombatStats = freshCombat();

  /** SPRAY PAINT — your tag on the surface in front of you, seen by everyone. */
  sprays: Sprays | null = null;
  private sprayAt = 0;
  private spray(): void {
    if (!this.matchLive()) return;
    const b = this.heldBody();
    const now = performance.now();
    if (!b || !b.alive || this.ended || !this.locked || now - this.sprayAt < 1500) return;
    const d = aimDir(this.yaw, this.pitch);
    const c = this.camera.position;
    const hit = sprayHit(c.x, c.y, c.z, d.dx, d.dy, d.dz);
    if (!hit) return;
    this.sprayAt = now;
    const tag = prefs().spray;
    if (this.session) this.session.events.push({ t: "spray", src: this.you, tag, ...hit });
    else if (this.net?.readyState === 1) this.net.send(JSON.stringify({ t: "spray", tag, ...hit }));
    // The hiss is yours and immediate (2D, like the nade-pin click) — the
    // broadcast echo (online) / drained event (offline) skips src === you below.
    this.audio.play("spray", { vol: 0.5, src: "local" });
  }

  /** The match announcer (client/src/announcer.ts). */
  announcer = new Announcer();

  /** The round state, or null when this room is not round-based. */
  roundInfo(): RoundState | null {
    if (this.session) return this.session.roundSnap() ?? null;
    return this.netRound;
  }
  /**
   * The interpolated poses the last frame DREW — the list predictHit tests
   * against, and the only list whose timestamp matches the InputCmd.rt every
   * fire command carries. Empty until the first draw(), which is honest: a body
   * that has never been rendered is a body the player has not seen.
   */
  drawn: PlayerSnap[] = [];
  testMode = false;
  timeMs = 0;
  /** The ws:// URL of the seat, kept so a dropped socket can be reopened. */
  netUrl = "";
  /** TRUE between connect() and stop(): a close while this is set is a DROP. */
  private netWanted = false;
  /** Consecutive failed/lost connections, for the reconnect backoff. */
  private netTries = 0;
  /** How many times this session has been dropped and had to reconnect. */
  netDrops = 0;
  readonly diagnostics = new URLSearchParams(location.search).has("diagnostics") ? new ClientDiagnostics(() => {
    // WebGL-only GL introspection; on WebGPU the backend reports itself.
    const gl = this.backend === "webgl" ? (this.renderer as THREE.WebGLRenderer).getContext() : null;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const endpoint = this.netUrl ? new URL(this.netUrl) : null;
    return {
      map: MAP.id, server: endpoint ? `${endpoint.origin}${endpoint.pathname}` : null,
      userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], pixelRatio: this.renderer.getPixelRatio(),
      gpu: this.backend === "webgpu" ? "webgpu" : ext && gl ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable",
      disconnects: this.netDrops, online: !!this.net, interpolationMs: this.interpDelay,
      pendingInputs: this.pending.length, readyAtPageMs: this.firstFrameAt,
      udp: this.udp ? { ...this.udp.stats } : null,
    };
  }) : null;
  /** Has the server/client map disagreement already been reported? Once is
   *  information; thirty-two times a second is a broken HUD. */
  private mapWarned = false;
  /** The last close frame the server or the browser gave us, for the gates. */
  netClose: { code: number; reason: string; wasClean: boolean; at: number } | null = null;
  /** Wall clock of the last keepalive ping actually sent. */
  private lastPingAt = 0;

  /** Live tracer streaks. qa/combat-pov + qa/stress-perf read `game.tracers.length`. */
  get tracers(): { length: number } {
    // weapons stream: WeaponFx keeps the count
    return this.wfx ? this.wfx.tracerStat : EMPTY;
  }

  nowMs(): number {
    return this.testMode ? this.timeMs : performance.now();
  }

  /**
   * This client's estimate of the server clock, in server seconds.
   *
   * ONE estimator, used by both halves of hit registration: interpPlayers draws
   * the world at svNow() - INTERP_MS, and every InputCmd is stamped with
   * svNow(). They used to be two — the interpolation ran on the svOffset EMA
   * while clientTime was extrapolated off the raw last-snapshot arrival — so
   * the gap between "what I shot at" and "what I told the server the time was"
   * moved with every jitter spike instead of being the fixed, reconstructible
   * INTERP_MS. The EMA is the right clock for both: it is the one that is
   * immune to a single late packet.
   */
  svNow(): number {
    if (this.session) return this.session.time;
    if (this.svOffset === 0) return this.snapTime + (performance.now() - this.snapRecv) / 1000;
    return (performance.now() - this.svOffset) / 1000;
  }

  /* ── MATCH PHASE (shared/matchphase.ts) ──────────────────────────────────
   * The SERVER owns the truth and the client renders it. Offline the local
   * GameSession IS the server, so both branches read one authority and there is
   * no third copy of the phase to drift.
   */

  /** Server-clock ms the match goes live. 0 = no countdown pending. Net only. */
  netStartAt = 0;
  /** The phase the network last told us about. Net only; offline reads the sim. */
  netPhase: MatchPhase = "live";

  matchPhase(): MatchPhase {
    if (this.session) return this.session.phase;
    return this.netPhase;
  }

  /** Ms until the match goes live. Negative once it is; 0 in pregame. */
  countdownLeftMs(): number {
    if (this.session) return this.session.countdownLeft() * 1000;
    if (this.netPhase === "pregame" || !this.netStartAt) return 0;
    return this.netStartAt - this.svNow() * 1000;
  }

  /** Movement and the trigger are live. Look/aim is never gated. QA waits on it. */
  matchLive(): boolean {
    return !inputLocked(this.matchPhase());
  }

  /**
   * StartMsg arrived: the match goes live at `startAt`, and the card counts to it.
   *
   * WHICH CLOCK startAt IS ON — and why this reads it three ways.
   *
   * `netStartAt` is always stored on the SNAPSHOT clock, because svNow() is the
   * only server clock this client can actually track and countdownLeftMs()
   * subtracts from it. The value on the wire, though, comes from whoever wrote
   * the server:
   *
   *   - snapshot clock (the contract in shared/matchphase.ts): a small number,
   *     seconds-since-session x 1000. Used as-is — perfect sync, since both ends
   *     are on the clock the snapshots already reconcile.
   *   - WALL clock (a server that sent Date.now() + COUNTDOWN_MS, which is what
   *     the shipped server/index.ts does): ~1.7e12, unmistakably not the
   *     snapshot clock, so it is measured against OUR Date.now() instead. Two
   *     NTP-sane machines agree to well inside a frame; on one machine (dev,
   *     qa/lobby-e2e) they agree exactly.
   *   - anything else: fall back to a full COUNTDOWN_MS from the moment the
   *     message landed. A disagreement between two authors must degrade into a
   *     countdown that works, never into a card counting down to 1970.
   */
  armCountdown(startAt: number): void {
    const svMs = this.svNow() * 1000;
    let left = COUNTDOWN_MS;
    if (Number.isFinite(startAt)) left = startAt > 1e12 ? startAt - Date.now() : startAt - svMs;
    if (!(left > -2000 && left < COUNTDOWN_MS + 5000)) left = COUNTDOWN_MS;
    this.netStartAt = svMs + left;
    this.netPhase = "countdown";
    // A (re-)armed match starts on clean walls (rematch after lobby return).
    this.sprays?.clear();
    this.matchFeel.reset();
  }

  constructor(private canvas: HTMLCanvasElement) {
    // The renderer is only created in init() (createRenderer, async): WebGPU
    // needs await renderer.init(), and a canvas binds exactly one
    // context type — a boot WebGLRenderer would block the WebGPU path.
    // Prefetch: the ~2 MB WebGPU chunk already loads during menu time, so
    // the deploy boot does not reload it (cached, one import per page load).
    if (prefs().renderer !== "webgl") void probeThreeWebGpu().catch(() => undefined);
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.03, 420);
    this.camera.add(this.vm.root);
    // A hidden viewmodel must not remove a light and recompile the world on death.
    this.camera.add(this.vm.flash);
    // Bound HERE, not at the end of init(): init() only runs once you deploy
    // into a match, so a window resized while sitting on the menu left the
    // canvas frozen at its boot size and the uncovered area rendered black.
    // resize() is written to be safe before the composer exists.
    window.addEventListener("resize", () => this.resize());
    const gunKey = new THREE.DirectionalLight(0xffd2b0, 0.48);
    gunKey.position.set(0.28, 0.62, 0.18);
    this.camera.add(gunKey);
    // weapons stream: pin the key light's target in camera space (unparented it aimed at the WORLD origin, so the gun's light swung as you walked)
    gunKey.target.position.set(0, 0, -1);
    this.camera.add(gunKey.target);
    // Off-axis fill: sitting at (0,0,0) on the sight line put N·H = 1.0 dead
    // centre on flat optic lenses during the ADS raise (a white specular ball
    // over the reticle). Offset up-left keeps the fill on the gun without
    // retro-reflecting straight back into the eye.
    const gunFill = new THREE.PointLight(0xc8d6ee, 0.16, 2.2, 1.6);
    gunFill.position.set(-0.22, 0.28, 0.14);
    this.camera.add(gunFill);
  }

  async init(): Promise<void> {
    if (this.inited) return;
    // RENDERER FIRST: createRenderer() resolves the renderer pref
    // (WebGPU-first, WebGL2 fallback with console warning — never a black
    // canvas) and initialises async. Everything after (PMREM, composer,
    // warm-up) needs the finished renderer.
    const created = await createRenderer(this.canvas, prefs().renderer);
    this.renderer = created.renderer;
    this.backend = created.backend;
    console.info(`[gpu] renderer: ${created.note}`);
    if (this.backend === "webgpu") void import("./webgpu-gaps").then((m) => m.reportGpuGaps()).catch(() => undefined);
    // ZERO-FLICKER hook: WebGL-only (reversed-Z request + standard-depth
    // shadows, see depth-precision.ts). The WebGPU path uses the backend's native
    // reversed float depth (reversedDepthBuffer, no split pass).
    this.depth = this.backend === "webgl" ? new DepthPrecision(this.renderer as THREE.WebGLRenderer) : null;
    this.depth?.configureCamera(this.camera); // split mode moves near out
    softwareTier = isSoftwareGL(this.renderer);
    document.documentElement.classList.toggle("software-gpu", softwareTier);
    if (softwareTier) {
      console.warn("[gpu] WebGL is running in SOFTWARE (no hardware acceleration). Rendering at reduced resolution.");
      bootStage("SOFTWARE GPU DETECTED — check chrome://gpu, restart the browser");
    }
    this.renderer.shadowMap.enabled = !softwareTier;
    // Preload the TSL materials (tsl-materials.ts) ONCE when the WebGPU
    // path is active: FX/weapon/marker builders (below) are handed the module,
    // world builders load it themselves (module cache: one chunk).
    // WebGL pays nothing (no static import anywhere).
    const TSL = this.backend === "webgpu" ? await import("./tsl-materials") : null;
    // The astronaut suit is a shader patch on the body skin; on WebGPU it has to
    // come from TSL (onBeforeCompile is ignored there), so hand the module over
    // before any actor is built.
    if (TSL) await import("./astronaut").then((m) => m.setAstronautTsl(TSL)).catch(() => undefined);
    else void import("./astronaut").then((m) => m.setAstronautTsl(null)).catch(() => undefined);
    // THE WORLD-BUILDER DISPATCH. Jungle Shipment is the shipping map; ?classic
    // keeps the original yard as a dev-only reference (1200+ unmerged draw calls
    // — never ships).
    //
    // ?map=dust2 now selects BOTH halves: the sim (colliders, spawns, nav,
    // grenade fence, floor plane, minimap, audio scale — live since Phase 2) and
    // the renderer, via the dust world builder. The dispatch is a dynamic
    // import on purpose: the dust builder and its textures must never enter the
    // Shipment bundle's boot path, and `MAP.id` is frozen long before this line
    // (shared/maps/index.ts resolves on shared/sim.ts's module body), so the
    // branch is decided, not raced.
    const useClassic = import.meta.env.DEV && new URLSearchParams(location.search).has("classic");
    if (MAP.id !== "shipment") {
      console.warn(`[map] booting "${MAP.id}" — ${MAP.solids.length} colliders, floorY ${MAP.floorY}.`);
    }
    // The close-up reflection environment for the Ares viewmodel exists before
    // the carbine's materials are built (it is a PMREM of a tiny scene).
    if (MAP.id === "ares") this.vm.envMap = await (await import("./ares-world")).aresViewmodelEnv(this.renderer);
    // Start independent downloads together, before procedural world building.
    const assets = Promise.all([
      loadBruiserTemplate(softwareTier),
      Promise.all([this.vm.initBanana(softwareTier), this.vm.initNade()]),
      Promise.all([NadeFx.create(TSL)]), // weapons stream: the banana-round tracer GLB is gone (WeaponFx)
    ]);
    bootStage("WORLD");
    const world = useClassic
      ? buildWorld(this.renderer)
      : MAP.id === "ares"
        ? import("./ares-world").then((m) => {
            // The Ares procedural shaders (core/sky/Mars/shell) are GLSL-only in
            // their original form; the TSL port needs the module before the world
            // is built, so hand it over first.
            m.setAresTsl(TSL);
            return m.buildAresWorld(this.renderer);
          })
        : MAP.id === "nuketown" // nuketown: Blender-built map + PBR library (client/src/nuketown-world.ts)
          ? import("./nuketown-world").then(async (m) => {
              // The procedural sky is GLSL-only; its TSL port needs the module
              // before buildSkyRig runs.
              (await import("./nuketown-sky")).setSkyTsl(TSL);
              return m.buildNuketownWorld(this.renderer);
            })
        : MAP.id === "dust2"
        ? import("./dust-world").then(m => m.buildDustWorld(this.renderer))
        : import("./jungle-world").then(m => m.buildJungleWorld(this.renderer));
    const [loadedWorld, [rig, , effects]] = await Promise.all([world, assets]);
    this.world = loadedWorld;
    // SHADOW PENUMBRA, BOTH BACKENDS — see clampShadowRadii: r187 removed
    // PCFSoft entirely, and both surviving PCF paths are the 5-sample Vogel-disk
    // filter (authored: ares 1.5, nuketown 2.0, jungle 3.1, dust2 3.1 from its
    // env data — all tuned against PCFSoft's much wider kernel). Called here so
    // every map's sun is covered; applyShadowQuality calls it again at each
    // re-arm, so lights PRESENT THEN are covered too (a light added after boot
    // without a quality change is not — no map does that today).
    this.clampShadowRadii();
    // feel stream: Nuketown live events — clock tower = match clock, live POPULATION sign, the nuke at match end (client/src/nuketown-live.ts)
    if (MAP.id === "nuketown") await (await import("./nuketown-live")).attachNuketownLive(this);
    // November-December set dressing (client/src/xmas.ts) — ?xmas=1 / ?xmas=0 force it.
    {
      const xq = new URLSearchParams(location.search).get("xmas");
      const month = new Date().getMonth();
      if (xq === "1" || (xq !== "0" && !this.testMode && (month === 10 || month === 11))) {
        this.world.scene.add((await import("./xmas")).buildXmas(MAP));
      }
    }
    this.world.scene.add(this.camera);
    bootStage("OPERATOR RIG");
    this.bruiserTpl = rig;
    bootStage("VIEWMODEL");
    bootStage("EFFECTS");
    [this.nadeFx] = effects;
    this.nadeFx.addTo(this.world.scene);
    this.boomFx = new BoomFx(TSL);
    this.boomFx.addTo(this.world.scene);
    // Keep the light count stable: adding this on the first remote shot
    // recompiles every lit material in the map during combat.
    this.flash3P = new THREE.PointLight(MAP.id === "ares" ? 0xffc890 : 0xffc070, 0, 3.2, 2);
    this.world.scene.add(this.flash3P);
    // weapons stream: pooled GPU weapon FX (4 draws total); the 3P flash reuses flash3P
    this.sprays = new Sprays(this.world.scene); // spray paint
    this.wfx = new WeaponFx(this.world.scene, { mapId: MAP.id, sun: this.world.sun, low: softwareTier, eject: viewmodelEject(this.vm, this.camera) }, TSL);
    this.wfx.light = this.flash3P;
    // weapons stream: brass leaves the viewmodel's port on the frame the gun ejects (bolt guns: on the bolt stroke)
    this.vm.onEject = (pos, dir, weapon, scale) => this.wfx?.ejectAt(pos, dir, weapon, scale);
    this.wfx.vmDrivesEject = true;
    this.marker = new ThrowMarker(TSL);
    this.marker.addTo(this.world.scene);
    // Everything is in the graph by now (world, statement props, viewmodel under
    // the camera, FX) — one sweep lifts every .glb-borne texture off three's
    // default anisotropy of 1. The operator template is not parented yet, so it
    // is swept by hand; its materials are shared by every actor cloned from it.
    maxAnisotropy(this.world.scene);
    maxAnisotropy(this.bruiserTpl.scene);
    if (softwareTier) softwareMaterials(this.world.scene, this.bruiserTpl.scene);
    bootStage("RENDER PIPELINE");
    // The map exposure as the basis (nuketown: NUKETOWN_EXPOSURE); the
    // exposure slider scales relative to it — see setGraphicsOptions().
    const ntSky = MAP.id === "nuketown" ? await import("./nuketown-sky") : null;
    this.baseExposure = ntSky?.NUKETOWN_EXPOSURE ?? 1.12;
    // M3: measure the map-authored shadow size BEFORE prefs touch it
    // (Shipment/Nuketown/Ares/Dust2: 4096). ?classic/minimalWorld sets
    // neither mapSize (default 512) nor castShadow — see mapShadowsOn.
    // shadowQuality "high" resolves against mapShadowSize and never overrides
    // the world.
    this.mapShadowSize = this.world.sun.shadow.mapSize.x > 0 ? this.world.sun.shadow.mapSize.x : 2048;
    this.mapShadowsOn = this.world.sun.castShadow;
    // m8: measure the env bases (reversible — setGraphicsOptions applies the boost
    // live per preset, without compounding).
    this.captureEnvBases();
    if (this.backend === "webgpu") {
      // TSL post chain (webgpu-pipeline.ts): scene → GTAO → bloom →
      // [afterimage] → CINEMATIC extras → renderOutput(ACES+sRGB) → [FXAA].
      // Lazy chunk, so the WebGL boot never loads it (only this branch
      // imports).
      const { createWebgpuPipeline } = await import("./webgpu-pipeline");
      // Anti-aliasing on WebGPU: the geometry pass is single-sample (GTAO
      // precondition), so MSAA choices resolve to SMAA — the best post filter
      // available — instead of silently doing nothing.
      const aaPref = prefs().aa;
      const gpuAa = aaPref === "off" ? "off" : aaPref === "smaa" || aaPref.startsWith("msaa") ? "smaa" : "fxaa";
      if (aaPref.startsWith("msaa")) {
        console.info("[gpu] WebGPU runs SMAA for the requested MSAA level (single-sample pass is a GTAO precondition).");
      }
      this.pipeline = await createWebgpuPipeline(this.renderer, this.world.scene, this.camera, gpuAa);
      console.info("[gpu] WebGPU-Pfad: TSL-RenderPipeline aktiv (GTAO/Bloom/Grade/sRGB, siehe webgpu-pipeline.ts).");
      // Open nuance (no crash, wrong look): three knows NO node equivalent for
      // custom ShaderMaterial (StandardNodeLibrary maps built-ins only) — they
      // fall back to an empty NodeMaterial until ported to TSL.
      // Affected: weapon FX (tracers/muzzle/smoke/decals,
      // weapons/fx), nade/boom/nuke FX, Ares reactor core (+
      // sky extras), Nuketown sky shader. One entry per material already warns
      // from three itself (NodeBuilder "not compatible").
    } else {
      this.buildComposer(ntSky);
    }
    this.setGraphicsOptions();
    // The resize listener is bound in the constructor (see the note there).
    // Re-sync once here so any resize that happened on the menu — before the
    // renderer existed to be resized — is picked up on the way into a match.
    this.resize();
    await this.prepareGraphics();
    this.bindInput();
    this.inited = true;
  }

  /**
   * WebGL2 post chain (EffectComposer + custom passes). WebGPU-only code lives
   * in gpu-backend.ts/createRenderer; this method runs ONLY on WebGL.
   */
  private async buildComposer(ntSky: { FOG_DENSITY: number; FOG_GROUND: number; FOG_H: number; FOG_VEIL: number } | null): Promise<void> {
    // EffectComposer sizes its buffers from renderer.getSize() * pixelRatio, so
    // it is already at true device resolution — but ONLY when built with no
    // target argument. Handing it a pre-made WebGLRenderTarget reads that
    // target's device size as if it were CSS size and multiplies by the pixel
    // ratio a second time, so `samples` is set on the buffers it made itself,
    // before the first render allocates their framebuffers.
    const renderer = this.renderer as THREE.WebGLRenderer;
    this.composer = new EffectComposer(renderer);
    if (softwareTier) {
      this.composer.renderTarget1.texture.type = THREE.UnsignedByteType;
      this.composer.renderTarget2.texture.type = THREE.UnsignedByteType;
    }
    const samples = aaSamples(this.renderer);
    this.setSamples(samples);
    this.composer.addPass(new RenderPass(this.world!.scene, this.camera));
    // ZERO-FLICKER hook: float depth targets (+ split-mode viewmodel pass).
    this.depth!.attachComposer(this.composer, this.world!.scene, this.camera, [this.vm.root]);
    // AAA: screen-space contact AO before the grade, hardware tier only (ssao.ts).
    // ?ssao=0 builds the pass with enabled=false (never runs) and saves the
    // depth resolve (m2, review round 2) — so the pass is constructed
    // but neither rendered nor paid for.
    // MINOR 1 (3rd review): in split-depth mode (no EXT_clip_control) the
    // ViewmodelPass clears the scene depth after the world pass — AO would read
    // the far plane everywhere (silent no-op). Gate hard instead of running silently:
    if (!softwareTier && this.depth!.mode !== "split") {
      this.aoPass = new ContactAO(this.camera, this.composer, this.depth!.mode === "reversed", this.world!.scene, prefs().ao);
      // m1: couple in the Nuketown height fog (constants from nuketown-sky.ts —
      // no static import in ssao.ts, so the sky lands in no other
      // map bundle). The module is already loaded with the world.
      if (ntSky) {
        this.aoPass.setHeightFog({ density: ntSky.FOG_DENSITY, ground: ntSky.FOG_GROUND, h: ntSky.FOG_H, veil: ntSky.FOG_VEIL });
      }
      this.composer.addPass(this.aoPass);
    } else if (this.depth!.mode === "split") {
      console.info("[gpu] ContactAO off: split depth mode clears scene depth for the viewmodel pass — AO would read far plane everywhere.");
    }
    // AAA: selective HDR bloom (bloom.ts) — highlights only, no fullscreen wash.
    this.bloomPass = new BloomPass();
    this.composer.addPass(this.bloomPass);
    // AAA: opt-in afterimage motion blur (motion-blur.ts), default OFF.
    this.motionPass = new MotionBlurPass();
    this.composer.addPass(this.motionPass);
    this.grade = new ShaderPass(CINEMATIC);
    this.composer.addPass(this.grade);
    // ANTI-ALIASING, post-filter half. When the composer target carries no MSAA
    // samples (software tier, or the player picked a post filter) exactly one
    // fullscreen pass resolves edges: SMAA when chosen, FXAA otherwise.
    // ?fxaa=0 still drops it for bisection.
    const aaMode = prefs().aa;
    if (samples === 0 && !qaFxaaOff() && aaMode !== "off") {
      if (aaMode === "smaa") {
        const { SMAAPass } = await import("three/addons/postprocessing/SMAAPass.js");
        this.aaPass = new SMAAPass() as unknown as AaPass;
        this.composer.addPass(this.aaPass as never);
      } else {
        const { FXAAShader } = await import("three/addons/shaders/FXAAShader.js");
        this.softwareAA = new ShaderPass(FXAAShader);
        this.composer.addPass(this.softwareAA);
      }
    }
  }

  private async prepareGraphics(): Promise<void> {
    const scene = this.world!.scene;
    bootStage("PREPARING GRAPHICS");
    // Compile skinning as well as the world before the network seat exists.
    // The actor clones/tints materials and adds sprites; compile that exact
    // graph, since the GLB template alone misses its first-use programs.
    this.warmActor ??= new BruiserActor({ id: "warmup", name: "RECRUIT", yaw: 0 } as PlayerSnap, this.bruiserTpl!);
    const template = this.warmActor.root;
    scene.add(template);
    // A full roster arrives in one snapshot at START. Prepare its independent
    // skeletons/materials before the seat exists instead of cloning them all
    // in that first countdown frame. These actors have never played a pose.
    const prepared: BruiserActor[] = [];
    const capacity = maxSeats(MAP.id); // UI stream: shared/modes.ts seat table
    try {
      while (this.preparedActors.length < capacity) {
        const actor = new BruiserActor({ id: "prepared", name: "", yaw: 0 } as PlayerSnap, this.bruiserTpl!);
        this.preparedActors.push(actor);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      prepared.push(...this.preparedActors);
      for (const actor of prepared) scene.add(actor.root);
      const spawn = MAP.spawns[0]!;
      this.camera.position.set(spawn.x, spawn.y + EYE, spawn.z);
      this.camera.rotation.set(0, spawn.yaw + Math.PI, 0, "YXZ");
      this.camera.updateMatrixWorld();
      const forward = this.camera.getWorldDirection(new THREE.Vector3());
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      // A driver can defer fragment/pipeline compilation until pixels are
      // actually rasterized. Warm visible actors in front of a camera above
      // the spawn floor, including the name/flash states used after joining.
      for (const [i, actor] of [this.warmActor, ...prepared].entries()) {
        actor.root.position.copy(this.camera.position).addScaledVector(forward, 4 + Math.floor(i / 4) * 2)
          .addScaledVector(right, (i % 4 - 1.5) * 1.5);
        actor.root.position.y = spawn.y;
        actor.prepareVisibleEffects(true);
      }
      // Compile with the same linear output as the composer's world pass.
      // Compiling against the sRGB canvas creates a second set of programs
      // that is thrown away on the first actual HDR render. WebGPU path: the
      // TSL pipeline compiles by itself on the first frame (no RT dance).
      if (this.backend === "webgl") {
        const glRenderer = this.renderer as THREE.WebGLRenderer;
        const compileTarget = glRenderer.getRenderTarget();
        glRenderer.setRenderTarget(this.composer!.renderTarget1);
        try { await glRenderer.compileAsync(scene, this.camera); }
        finally { glRenderer.setRenderTarget(compileTarget); }
      }
      bootStage("UPLOADING TEXTURES");
      const textures = new Set<THREE.Texture>();
      scene.traverse((o) => {
        const material = (o as THREE.Mesh).material;
        for (const m of Array.isArray(material) ? material : material ? [material] : []) {
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
          const uniforms = (m as THREE.ShaderMaterial).uniforms;
          if (uniforms) for (const u of Object.values(uniforms)) if (u.value instanceof THREE.Texture) textures.add(u.value);
        }
      });
      // Yield between uploads so the loading card and browser stay responsive.
      let slice = performance.now();
      for (const texture of textures) {
        if (softwareTier) {
          const source = texture.image as { width?: number; height?: number; data?: unknown } | undefined;
          if (source?.width && source.height && !source.data && Math.max(source.width, source.height) > 512) {
            const scale = 512 / Math.max(source.width, source.height);
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(source.width * scale));
            canvas.height = Math.max(1, Math.round(source.height * scale));
            canvas.getContext("2d", { willReadFrequently: true })!.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
            texture.image = canvas;
            texture.needsUpdate = true;
          }
          texture.anisotropy = 1;
          texture.generateMipmaps = false;
          if (texture.minFilter !== THREE.NearestFilter) texture.minFilter = THREE.LinearFilter;
          // Canvas uploads can force the GPU process to read back a 2D surface
          // and convert every pixel synchronously. Prepare bitmaps outside GL.
          if (typeof createImageBitmap === "function" && !texture.userData.actorName && texture.image && !texture.image.data && !(texture.image instanceof ImageBitmap)) {
            const bitmap = await createImageBitmap(texture.image, {
              imageOrientation: texture.flipY ? "flipY" : "from-image",
              premultiplyAlpha: texture.premultiplyAlpha ? "premultiply" : "none",
              colorSpaceConversion: "none",
            });
            texture.image = bitmap;
            texture.flipY = false;
            texture.needsUpdate = true;
          }
        }
        // WebGL-only: initTexture() exists only on the WebGLRenderer; the
        // WebGPU backend uploads by itself on first render (initiated).
        if (this.backend === "webgl") (this.renderer as THREE.WebGLRenderer).initTexture(texture);
        if (performance.now() - slice > 8) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          slice = performance.now();
        }
      }
      bootStage("WARMING WORLD");
      // Warm the actual pipeline and the actor's skinning buffers together.
      // A separate target adds another allocation and render at cold boot.
      const flags: [THREE.Object3D, boolean][] = [];
      scene.traverse((o) => { flags.push([o, o.frustumCulled]); o.frustumCulled = false; });
      try {
        this.renderFrame();
        await this.waitForGpu();
      } finally {
        for (const [o, flag] of flags) o.frustumCulled = flag;
      }
      bootStage("WARMING PIPELINE");
      if (softwareTier && new URLSearchParams(location.search).get("quality") !== "native") {
        // Measure a completed frame before joining a room. Calibration includes
        // GPU work; CPU submission time alone hides an overloaded rasterizer.
        const started = performance.now();
        this.renderFrame();
        await this.waitForGpu();
        this.quality.scale = Math.max(0.5, Math.min(1, Math.sqrt(12 / (performance.now() - started))));
        // CPU submission can look cheap while a software GPU is still busy.
        // Keep the completed-frame calibration as its recovery ceiling, so
        // countdown/idle frames cannot trigger buffer reallocations in combat.
        this.quality.maxScale = this.quality.scale;
        this.resize();
        this.renderFrame();
        await this.waitForGpu();
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    } finally {
      template.removeFromParent();
      for (const actor of prepared) actor.root.removeFromParent();
      for (const actor of [this.warmActor, ...prepared]) {
        actor.root.position.set(0, 0, 0);
        actor.root.updateMatrixWorld(true);
        actor.prepareVisibleEffects(false);
      }
    }
  }

  private async waitForGpu(): Promise<void> {
    // WebGL-only (fenceSync on the GL context); WebGPU syncs implicitly.
    if (this.backend !== "webgl") return;
    const gl = (this.renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext;
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) return;
    gl.flush();
    try {
      while (!gl.isContextLost()) {
        const state = gl.clientWaitSync(fence, 0, 0);
        if (state !== gl.TIMEOUT_EXPIRED) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    } finally { gl.deleteSync(fence); }
  }

  /** MSAA level of the HDR buffers. Disposing forces three to reallocate them. */
  private setSamples(n: number): void {
    // WebGL-only (composer targets): the TSL pipeline allocates its
    // scene-pass RTs itself (single-sample) — nothing to set here.
    if (!this.composer) return;
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === n) continue;
      rt.samples = n;
      rt.dispose();
    }
  }

  /**
   * ONE presented frame on both backends: WebGL2 via the
   * EffectComposer (post chain), WebGPU via the TSL render pipeline
   * (webgpu-pipeline.ts — scene → GTAO → bloom → [afterimage] → grade extras
   * [→ renderOutput ACES+sRGB] → [FXAA]). If the pipeline fails (null), the
   * WebGPU path renders the scene directly instead of staying black.
   * Public for ?test (test.ts renders stills without sim — dt = 0 means
   * no uTime progress, deterministic frame).
   */
  renderFrame(dt = 0): void {
    // QA bypass (?pipeline=direct): scene straight to the canvas without the
    // TSL pipeline — halves debugging (black = scene/renderer, picture =
    // pipeline chain). ?pipeline=nograde: chain without the grade fn (scene →
    // render output) — picture here, black otherwise = grade node. Debug only,
    // no settings path.
    try {
      if (typeof location !== "undefined" && new URLSearchParams(location.search).get("pipeline") === "direct") {
        const world = this.world;
        if (world) this.renderer.render(world.scene, this.camera);
        return;
      }
    } catch {
      /* no location (SSR/harness) */
    }
    if (this.backend === "webgpu") {
      if (this.pipeline) {
        this.pipeline.render(dt);
        return;
      }
      const world = this.world;
      if (world) this.renderer.render(world.scene, this.camera);
      return;
    }
    if (!this.composer) return;
    this.composer.render();
  }

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    // AAA: the preset caps the internal scale (LOW renders smaller).
    const cap = QUALITY_MAX_SCALE[prefs().quality] ?? 1;
    const pr = pixelRatio() * (prefs().renderScale === "native" ? 1 : Math.min(this.quality.scale, cap)); // UI stream hook
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Pre-init (menu resizes before init()): the renderer does not exist yet —
    // just follow with the camera. Afterwards everything runs through the renderer.
    const renderer = this.renderer as AnyRenderer | null;
    if (!renderer) return;
    // The composer caches the pixel ratio it was CONSTRUCTED with; without this
    // a DPR change (zoom, second monitor) leaves its buffers at the old
    // resolution and the frame is scaled, not redrawn, at the new one. It is
    // guarded because setPixelRatio() resizes the buffers itself: calling it
    // unconditionally would reallocate every render target TWICE per resize
    // event, which is a visible hitch while a window is being dragged.
    if (pr !== renderer.getPixelRatio()) {
      renderer.setPixelRatio(pr);
      this.composer?.setPixelRatio(pr);
    }
    renderer.setSize(w, h);
    // Optional chaining is load-bearing: the composer is built in init(), while
    // this now runs from the constructor's listener too (menu resizes).
    this.composer?.setSize(w, h);
    // AAA: MSAA follows the preset — LOW halves to 2x. CINEMATIC may go 8x,
    // but ONLY with the DPR gate (S1): pixelRatio() <= 1.25 AND the driver reports
    // MAX_SAMPLES >= 8. Otherwise it stays at aaSamples() — no broken FBO.
    if (this.composer) {
      const q = prefs().quality;
      let samples = aaSamples(renderer);
      // The preset only tunes the AUTOMATIC choice. An explicit MSAA level from
      // GRAPHICS ▸ Anti-Aliasing is the player's decision and stands as chosen.
      if (prefs().aa === "auto") {
        if (q === "low") samples = Math.min(samples, 2);
        else if (q === "cinematic" && samples === 4 && pixelRatio() <= 1.25 && this.maxSamples() >= 8) samples = 8;
      }
      this.setSamples(samples);
    }
    // M4: real pixels for chroma/sharpness/DOF (uTexel), DPR-independent.
    if (this.grade) {
      const db = renderer.getDrawingBufferSize(new THREE.Vector2());
      this.grade.uniforms.uTexel.value.set(1 / Math.max(1, db.x), 1 / Math.max(1, db.y));
    }
    if (this.softwareAA) this.softwareAA.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    // SMAAPass carries its own edge/weight/blend targets and sizes them itself.
    this.aaPass?.setSize?.(Math.round(w * pr), Math.round(h * pr));
    // WebGPU path: pull the TSL chain up via the drawing-buffer size
    // (uTexel for chroma/sharpness/DOF; pass RTs scale by themselves).
    this.pipeline?.setSize(w, h, pr);
  }

  /** S1: GL_MAX_SAMPLES, read once and cached. */
  private maxSamples(): number {
    // WebGL-only (GL context query); WebGPU uses renderer MSAA at creation.
    if (this.backend !== "webgl") return 4;
    if (this.cachedMaxSamples) return this.cachedMaxSamples;
    try {
      const gl = (this.renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext;
      const v = gl.getParameter(gl.MAX_SAMPLES) as number;
      this.cachedMaxSamples = Number.isFinite(v) && v > 0 ? v : 4;
    } catch {
      this.cachedMaxSamples = 4;
    }
    return this.cachedMaxSamples;
  }

  /**
   * AAA: apply all graphics prefs live (no reload). Called once from init()
   * and then on every prefs change from main.ts. On the
   * software tier bloom/AO/chroma/DOF/sharpness stay off entirely —
   * there every fragment-shader instruction counts in milliseconds.
   */
  setGraphicsOptions(): void {
    // WebGPU path: the composer passes (AO/bloom/motion/CINEMATIC) are the
    // WebGL2 implementation — everything here delegates to the TSL pipeline
    // (webgpu-pipeline.ts, same switches, same order).
    if (this.backend === "webgpu") {
      const p = prefs();
      const sw = softwareTier;
      const snapshot: WebgpuPrefsSnapshot = {
        bloom: p.bloom && !sw && p.bloomStrength > 0,
        bloomStrength: p.bloom ? p.bloomStrength : 0,
        ao: p.ao && !sw,
        aoStrength: p.aoStrength,
        chromatic: p.chromatic && !sw,
        grain: p.grain,
        vignette: p.vignette,
        motionBlur: p.motionBlur && !sw,
        dof: p.dof && !sw,
        sharpen: sw ? 0 : p.sharpen,
        exposure: this.baseExposure * (p.exposure / 1.12),
      };
      this.pipeline?.applyPrefs(snapshot);
      this.applyShadowQuality();
      this.applyEnvBoost();
      return;
    }
    // The guard is the chain existing (init builds it), not `inited` —
    // init() calls this here BEFORE setting `inited = true`.
    if (!this.grade) return;
    const p = prefs();
    // Anti-Aliasing: MSAA level + the single post filter are rebuilt live on
    // WebGL. (The WebGPU chain resolves its own filter at boot.)
    if (p.aa !== this.aaApplied) {
      this.aaApplied = p.aa;
      void this.applyAaMode();
    }
    const sw = softwareTier;
    // Review round 2: the adaptive cap only applies under ADAPTIVE scale. At
    // NATIVE it is moot — reset it, otherwise an old
    // 2048 cap hangs over ULTRA/CINEMATIC (main.ts calls us on every
    // renderScale change, because renderScale is in the GFX list).
    if (p.renderScale === "native") this.adaptiveShadowCap = null;
    if (this.aoPass) {
      const on = p.ao && !sw && !this.aoPass.qaOff;
      // m2: only pay the resolve once AO actually runs (default HIGH: off).
      if (on && !this.aoPass.depthResolved) this.aoPass.ensureDepthResolved(this.composer);
      this.aoPass.enabled = on;
      this.aoPass.strength = p.aoStrength;
    }
    if (this.bloomPass) {
      this.bloomPass.enabled = p.bloom && !sw && p.bloomStrength > 0;
      this.bloomPass.strength = p.bloom ? p.bloomStrength : 0;
    }
    if (this.motionPass) {
      const on = p.motionBlur && !sw;
      this.motionPass.enabled = on;
      this.motionPass.amount = on ? 0.25 : 0;
      if (!on) this.motionPass.reset();
    }
    const g = this.grade.uniforms;
    g.uChroma.value = p.chromatic && !sw ? 1 : 0;
    g.uGrain.value = p.grain ? 1 : 0;
    g.uVignette.value = p.vignette ? 1 : 0;
    g.uSharpen.value = sw ? 0 : p.sharpen;
    g.uDof.value = p.dof && !sw ? 1 : 0;
    // Exposure: signed map basis times player slider (1.12 = neutral).
    const exposure = this.baseExposure * (p.exposure / 1.12);
    g.uExposure.value = exposure;
    // MINOR 4 (3rd review): NO renderer.toneMappingExposure sync any more — the
    // old line claimed an invariant that never held on Nuketown (0.63
    // vs p.exposure). three applies tonemapping only to direct renders
    // to the canvas anyway (never to RT/composer paths); the cinematic pass maps
    // via uExposure itself. Direct renders (qa/flip-hunt) keep the
    // constructor value 1.12.
    this.applyShadowQuality();
    this.applyEnvBoost();
  }

  /**
   * AAA: switch shadow resolution live. OFF kills the whole shadow-map
   * pass — the biggest single lever on weak GPUs.
   *
   * MAJOR fix (2nd review): `renderer.shadowMap.enabled = false` ALONE
   * recompiles nothing — the USE_SHADOWMAP programs would stay and
   * sample against a disposed (null) texture. The switch that
   * really recompiles is `sun.castShadow`: it changes numDirectional-
   * Shadows → lights state version → all materials pick the matching program in BOTH
   * directions (OFF→ON included). shadowMap.enabled
   * is tracked synchronously (shadow-pass skip), map disposal as before.
   *
   * OWNERSHIP (M3/m3): the pref wins. "high" resolves against mapShadowSize
   * (no overwrite of the map authoring); adaptQuality only lays the
   * transient adaptiveShadowCap over it (min), which is never cleared here.
   * Re-alloc only on actual size change (no re-alloc per
   * slider tick — the guard below).
   *
   * MINOR 3 (3rd review): the FIRST OFF→ON switch after a shadowless
   * boot recompiles all shadow programs — a one-off hitch
   * (cached after that, switching is free). prepareGraphics deliberately warms
   * only the boot configuration; a second full compile in boot would be
   * more expensive than the one-off live hitch. NIT 1: ?classic/minimalWorld
   * authorises no shadows (mapShadowsOn=false) and stays shadowless on every
   * tier as before.
   */
  applyShadowQuality(): void {
    if (!this.world) return;
    const q = softwareTier ? "off" : prefs().shadowQuality;
    let size = q === "high" ? this.mapShadowSize : (SHADOW_SIZES[q] ?? 2048);
    if (this.adaptiveShadowCap && size > this.adaptiveShadowCap) size = this.adaptiveShadowCap;
    const sun = this.world.sun;
    const shadow = sun.shadow;
    if (size > 0) {
      if (shadow.mapSize.x !== size) {
        shadow.map?.dispose();
        shadow.map = null;
        shadow.mapSize.set(size, size);
        shadow.needsUpdate = true;
      }
    } else {
      shadow.map?.dispose();
      shadow.map = null;
    }
    // The recompile lever: castShadow changes the light-state version, so
    // all materials pick the shadow or non-shadow program —
    // in both directions, with no materials-needsUpdate marathon. NIT 1: only
    // if the map authorises shadows (?classic stays shadowless).
    const want = size > 0 && this.mapShadowsOn;
    sun.castShadow = want;
    // Late-added lights and a quality re-arm escape the init() clamp, so clamp
    // again here: cheap, idempotent, and no shadow map source is touched.
    this.clampShadowRadii();
    this.renderer.shadowMap.enabled = want;
  }

  /**
   * Clamp every shadow-casting directional light's penumbra to
   * SHADOW_RADIUS_MAX (runs at init() and at every applyShadowQuality()
   * re-arm). Total, not just a top bound — defensive: every radius in the tree
   * is a finite literal today (dust2 reads its `ENVV` record, also a literal),
   * but a future non-finite or negative value would otherwise pass Math.min
   * straight into the shadow sampler.
   */
  private clampShadowRadii(): void {
    if (!this.world) return;
    this.world.scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (!l.isDirectionalLight || !l.castShadow) return;
      const r = Number(l.shadow.radius);
      l.shadow.radius = Number.isFinite(r) ? Math.min(Math.max(r, 0), SHADOW_RADIUS_MAX) : SHADOW_RADIUS_MAX;
    });
  }

  /**
   * m8 + VIEWMODEL FREEZE (strict user requirement): measure env bases once
   * (hardware tier only).
   *
   * The camera subtree (vm.root, muzzle flash, gunKey+target, point light)
   * hangs via world.scene.add(camera) INSIDE this scene — tracked as an exclude
   * list by object identity (camera.traverse). Weapon materials are thus
   * never captured (material identity additionally as belt-and-braces, in case
   * a material were ever shared), and applyEnvBoost does not touch them even
   * transiently → weapon look bit-identical on all presets (no
   * boost-on-and-back, but exclusion from the start).
   */
  private captureEnvBases(): void {
    this.envBases.clear();
    if (softwareTier || !this.world) return;
    const vmObjects = new Set<THREE.Object3D>();
    this.camera.traverse((o) => vmObjects.add(o));
    const vmMats = new Set<THREE.Material>();
    for (const o of vmObjects) {
      const mesh = o as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) vmMats.add(m);
    }
    this.world.scene.traverse((o) => {
      if (vmObjects.has(o)) return;
      const mesh = o as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        if (vmMats.has(m)) continue;
        const std = m as THREE.MeshStandardMaterial;
        if (typeof std.envMapIntensity === "number" && !this.envBases.has(m)) this.envBases.set(m, std.envMapIntensity);
      }
    });
  }

  /**
   * m8 + VIEWMODEL FREEZE: env boost per preset, REVERSIBLE around the measured
   * basis — live on every preset switch.
   *
   * DECISION (weapon look frozen): per-material boost ONLY for
   * world materials; scene.environmentIntensity is NO longer scaled globally
   * (that would hit the weapon too, since it hangs in the same scene).
   * The world thereby loses NO visible IBL: every captured
   * world material carries its own envMapIntensity (textures.ts sets it
   * explicitly, e.g. 0.18–0.55; default 1.0 otherwise) — the product
   * envMapIntensity × environmentIntensity rises precisely by the
   * preset factor for the world, while for the weapon it stays untouched (its uniforms and the
   * global environmentIntensity never change → bit-identical).
   * Note: previously it also scaled globally (effectively boost²); that
   * double scaling is gone — ULTRA/CINEMATIC are returned to the intended
   * boost×, HIGH (default 1.0) is identical in both variants.
   */
  private applyEnvBoost(): void {
    if (!this.world || !this.envBases.size) return;
    const boost = QUALITY_ENV_BOOST[prefs().quality] ?? 1;
    for (const [m, base] of this.envBases) {
      (m as THREE.MeshStandardMaterial).envMapIntensity = base * boost;
    }
  }

  /**
   * ONE CLIENT PER PAGE — the guard, and the bug it exists for.
   *
   * start() was re-entrant and every line of it was destructive: connect() simply
   * overwrote `this.net` without closing the socket it was replacing, the 1 Hz
   * keepalive was a fresh unheld setInterval, and loop() is a self-perpetuating
   * rAF chain with no re-entry guard of its own. So N calls to start() left N
   * render loops running for the LIFE OF THE PAGE. Two Enter presses 60 ms apart
   * in the callsign gate were enough (see submitGate's guard in lobby.ts) and it
   * was measurable: draws per displayed frame went 1 -> 2 and never came back.
   *
   * `booting` and not `running` because start() has four awaits in it — audio,
   * GLB parsing, the socket — and `running` is deliberately not set until a seat
   * exists, which is after all of them. The window that has to be closed is the
   * whole call, from its first line.
   */
  /** performance.now() of the first rendered frame of this match; 0 until then. */
  firstFrameAt = 0;
  private loopEntries = 0;
  private quality = new RenderQuality(MAP.id === "ares" ? 4.2 : MAP.id === "nuketown" ? 7 : 12);
  private warmActor: BruiserActor | null = null;
  private preparedActors: BruiserActor[] = [];
  /**
   * Apply the Anti-Aliasing choice to the live WebGL chain: MSAA level on the
   * composer targets plus exactly one post filter (FXAA or SMAA) when the
   * targets carry no samples. The WebGPU chain picks its filter at boot (the
   * pipeline relinks its output node), so there the setting needs a reload.
   */
  private async applyAaMode(): Promise<void> {
    if (!this.composer) return;
    const mode = prefs().aa;
    if (this.softwareAA) {
      this.composer.removePass(this.softwareAA);
      this.softwareAA = null;
    }
    if (this.aaPass) {
      this.composer.removePass(this.aaPass as never);
      this.aaPass = null;
    }
    this.resize();
    const samples = aaSamples(this.renderer as AnyRenderer);
    if (samples !== 0 || qaFxaaOff() || mode === "off") return;
    if (mode === "smaa") {
      const { SMAAPass } = await import("three/addons/postprocessing/SMAAPass.js");
      this.aaPass = new SMAAPass() as unknown as AaPass;
      this.composer.addPass(this.aaPass as never);
    } else {
      const { FXAAShader } = await import("three/addons/shaders/FXAAShader.js");
      this.softwareAA = new ShaderPass(FXAAShader);
      this.composer.addPass(this.softwareAA);
      const pr = this.renderer.getPixelRatio();
      this.softwareAA.uniforms.resolution.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
    }
  }

  private softwareAA: ShaderPass | null = null;
  /** Structured AA pass (SMAAPass) when the player picks SMAA on WebGL. */
  private aaPass: AaPass | null = null;
  /** Last applied Anti-Aliasing pref (live rebuild trigger). */
  private aaApplied = "";
  /** AAA post chain (feature/aaa-graphics) — null until init() builds the chain. */
  private aoPass: ContactAO | null = null;
  private bloomPass: BloomPass | null = null;
  private motionPass: MotionBlurPass | null = null;
  /** The signed map exposure (nuketown: NUKETOWN_EXPOSURE, else 1.12). */
  private baseExposure = 1.12;
  /** M3: map-authored shadow size (measured at world build). */
  private mapShadowSize = 2048;
  /**
   * NIT 1 (review round 3): whether the map authorises shadows at all —
   * measured at world build (sun.castShadow). Shipment/Nuketown/Ares/Dust2:
   * true (4096). ?classic/minimalWorld (dev-only): false — no castShadow,
   * no mapSize, never any shadows rendered. HIGH/ULTRA add NOTHING
   * there (the dev path's look stays), the map just stays as shadowless
   * as before.
   */
  private mapShadowsOn = true;
  /** m3: transient adaptQuality cap — NEVER overrides the pref (owner: pref). */
  private adaptiveShadowCap: number | null = null;
  /** m8: env bases for the reversible live boost (material → base intensity). World materials only (no viewmodel, see captureEnvBases). */
  private envBases = new Map<THREE.Material, number>();
  /** S1: cached GL_MAX_SAMPLES for the 8x gate. */
  private cachedMaxSamples = 0;
  private actorFrustum = new THREE.Frustum();
  private actorProjection = new THREE.Matrix4();
  private actorSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  /** main.ts hides the boot card here — after a frame exists to reveal. */
  onFirstFrame: (() => void) | null = null;

  private adaptQuality(renderMs: number): void {
    // UI stream hook: GRAPHICS → RENDER RESOLUTION (prefs also honours ?quality=native).
    if (this.testMode || prefs().renderScale === "native") return;
    if (!this.quality.sample(renderMs, performance.now())) return;
    // m3: ONE owner — the pref. adaptQuality only sets a transient
    // cap (shadows ≤2048 at small scale) that never overrides the pref;
    // applyShadowQuality resolves min(pref, cap) and never clears it back.
    // NIT 2 (3rd review): NATIVE→ADAPTIVE leaves the cap for ~2 s at most
    // (RenderQuality cooldown) — the next adapt tick re-evaluates
    // (self-heals); setGraphicsOptions clears it immediately at NATIVE.
    const cap = this.quality.scale < 0.9 ? 2048 : null;
    if (cap !== this.adaptiveShadowCap) {
      this.adaptiveShadowCap = cap;
      this.applyShadowQuality();
    }
    this.resize();
  }

  async start(opts: BootOpts): Promise<void> {
    if (this.booting || this.running) return;
    this.booting = true;
    try {
      await this.boot(opts);
    } finally {
      this.booting = false;
    }
  }

  private async boot(opts: BootOpts): Promise<void> {
    this.opts = opts;
    this.gunGame = !!opts.gun;
    this.audio.setVol(opts.vol);
    await this.audio.resume();
    this.audio.loopAmb();
    // Not in ?test: the harness renders deterministic frames and a 1.5 s sting
    // ringing over the first sim ticks would sit in every audio measurement.
    if (!this.testMode) this.audio.matchStart();
    // The 3-2-1 lives in the HUD, so it is created here rather than in
    // index.html and inherits the HUD's z-order and its .killcam-on contract.
    const hud = document.getElementById("hud");
    if (hud) this.matchFeel.mount(hud);
    this.matchFeel.reset();
    this.netPhase = "live";
    this.netStartAt = 0;
    this.ended = false;
    // Fresh boot/re-deploy clears stale watchdog evidence (see resetPrediction).
    this.endEvidenceAt = 0;
    this.liveTick = -1;
    this.endcardUp = false;
    // Every boot (re-)starts on clean walls: the Sprays instance and the scene
    // outlive a match (QuickMatch-Neustart, leave-to-menu → re-deploy), so old
    // tags would otherwise survive into the next match.
    this.sprays?.clear();
    this.stopFinalKillcam(); // feel stream
    this.fkTape.reset();
    this.accolades.reset(this.you);
    this.medals.clear();
    this.extras.reset();
    this.scorePops.clear();
    this.yaw = 0;
    this.pitch = 0;
    this.combat = freshCombat();
    if (opts.host.trim()) {
      await this.connect(opts.host.trim());
    } else {
      this.session = new GameSession();
      this.session.mode = opts.mode;
      this.session.gunGame = this.gunGame;
      this.session.gunKills = this.gunKills = asGunKills(prefs().gunKills); // Settings → Gun Game
      this.session.remain = matchTimeFor(opts.mode);
      const me = this.session.addPlayer("local", opts.name, "bruiser", 0, readLoadout().primary, "", false);
      this.you = me.id;
      this.yaw = me.yaw;
      // Offline bot count follows the map's seat count (shared/modes.ts — the
      // same table the server's rooms use): the room minus the one human.
      const nBots = opts.bots ?? seatsFor(MAP.id, opts.mode) - 1;
      // Team split: bots [0, half) oppose, the rest join the human, so the human's
      // side ends one short of the enemy's before the human is counted. 9 bots
      // gives the old 5v5; 11 gives 6v6.
      const half = Math.ceil((nBots + 1) / 2);
      for (let i = 0; i < nBots; i++) {
        this.session.addPlayer(
          "bot-" + i,
          BOT_NAMES[i % BOT_NAMES.length]!,
          "bruiser",
          opts.mode === "ffa" ? ((i % 2) as 0 | 1) : ((i < half ? 1 : 0) as 0 | 1),
          botPrimary("bot-" + i),
          "",
          true,
        );
      }
      // A LOCAL MATCH COUNTS ITSELF DOWN. There is no host to press START and no
      // server to broadcast a StartMsg, so the session that IS the authority here
      // arms its own countdown and the card reads it off the sim clock — the same
      // code path, the same numbers, and stepped-clock-safe for the capture rig.
      // Never in ?test: those scenarios pose exact tick counts and a 3.2 s input
      // lock at t=0 would silently eat the first frames of every one of them.
      if (!this.testMode) this.session.beginCountdown();
    }
    // SET AFTER THE SEAT EXISTS, NOT BEFORE. `running` is what every gate in
    // qa/ waits on to mean "the game is up", and it used to be set before
    // connect() was even called — so a gate could pass, read the roster and
    // assert on a client that had no socket yet.
    this.running = true;
    this.clock.reset();
    // THE BOOT CARD COMES DOWN ON THE FIRST PAINTED FRAME, NOT BEFORE. On a
    // software rasteriser the first frame (every shader compiled, every texture
    // uploaded) can take many seconds; until it lands, the card says so.
    bootStage(softwareTier ? "FIRST FRAME (SOFTWARE GPU — THIS CAN TAKE A WHILE)" : "FIRST FRAME");
    this.firstFrameAt = 0;
    this.loopEntries = 0;
    if (this.testMode) return;
    if (this.net && !this.keepAliveTimer) this.keepAliveTimer = window.setInterval(() => this.keepAlive(), 1000);
    this.stepAt = 0;
    if (this.net && !this.stepTimer) this.stepTimer = window.setInterval(() => { if (this.running && !this.session) this.stepFixed(); }, 4);
    this.loop();
  }

  /**
   * KEEPALIVE, AND WHY IT IS NOT ONLY A TIMER.
   *
   * The server drops a seat that has said nothing for 20 s (server/index.ts).
   * The only thing that used to refresh that was `setInterval(1000)`, and a
   * setInterval is exactly what a stalled main thread does not run: two
   * SwiftShader pages sharing one box (qa/lobby-e2e's own staging, and any
   * first load on a slow machine, a long GC or a throttled background tab) sent
   * FIVE messages in 48 s and were closed with code 1006 mid-match.
   *
   * So it is called from the timer AND opportunistically from the render loop
   * and every snapshot arrival — anything that proves this thread is alive also
   * proves it to the server, at no cost when the timer is already keeping up
   * (the 1 s floor makes the extra calls free).
   */
  private keepAlive(): void {
    if (this.net?.readyState !== 1) return;
    const now = Date.now();
    if (now - this.lastPingAt < 1000) return;
    this.lastPingAt = now;
    this.diagnostics?.ping(now, performance.now());
    // rtt: the last round trip this client measured, reported back so the
    // server can put a real number in everyone else's scoreboard — p.ping was
    // never written server-side, so every remote row showed 0.
    this.net.send(JSON.stringify({ t: "ping", t0: now, rtt: this.ghost?.ping ?? 0 }));
  }

  stop(opts?: { keepLock?: boolean; keepFullscreen?: boolean }): void {
    this.running = false;
    // Deliberate teardown, so onclose must NOT read this as a drop and start
    // reconnecting into a stopped game.
    this.netWanted = false;
    this.net?.close();
    this.net = null;
    this.session = null;
    // Scrub the tags on teardown (menu, Play Again): the scene outlives the
    // match, so without this the next boot would inherit the old walls.
    this.sprays?.clear();
    // The timer outlives the socket it was pinging otherwise, and RETURN TO MENU
    // -> DEPLOY would leave one running per match played.
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = 0;
    }
    clearInterval(this.stepTimer);
    this.stepTimer = 0;
    this.udp?.close();
    this.udp = null;
    // IN-PLACE REMATCH (Quick Play -> PLAY AGAIN): the teardown must not drop
    // the lock/fullscreen from under the new match — their async change events
    // would land after deploy() is already inMatch() and open the pause menu.
    if (!opts?.keepLock) document.exitPointerLock();
    this.keyboard()?.unlock();
    if (!opts?.keepFullscreen && document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => {});
    this.clearInput();
    this.resetPrediction();
  }

  private resetPrediction(): void {
    this.footstepCadence.clear();
    this.diagnostics?.resetConnection();
    this.snaps.length = 0;
    this.pending.length = 0;
    this.predMarked.clear();
    this.ghost = null;
    this.drawn = [];
    this.errX = this.errY = this.errZ = 0;
    this.svOffset = 0;
    this.lastSnapArr = this.gapMax = this.renderT = 0;
    this.interpDelay = INTERP_MS;
    this.acc = 0;
    this.stepAt = 0;
    this.snapTick = -1;
    this.seenTicks.clear();
    // STALE WATCHDOG EVIDENCE must not survive a boot/reconnect: lastSnapArr
    // is reset above, so old evidence would fire the watchdog before the
    // first snapshot of the new seat arrives.
    this.endEvidenceAt = 0;
    // A reconnect is a new seat on continuing server ticks: a carried-over
    // rollover point would read the new match's early end signals as stale.
    this.liveTick = -1;
    this.statSnaps.length = 0;
    this.statPings.length = 0;
    this.renderTimeline.reset();
  }

  connect(url: string): Promise<void> {
    this.netUrl = withMapQuery(url.startsWith("ws") ? url : `ws://${location.host}/ws`, MAP.id);
    this.netWanted = true;
    this.netTries = 0;
    return new Promise((resolve, reject) => {
      this.open(resolve, reject);
    });
  }

  /**
   * ONE SOCKET, WIRED. Called for the first connection and for every reconnect.
   *
   * There was NO close handler here at all: a player whose main thread stalled
   * past the server's 20 s idle window (first load on a slow box, a long GC, a
   * throttled tab) was closed with code 1006, never reconnected, shown nothing,
   * and left staring at a frozen yard with `net.readyState === 3` forever. The
   * game kept running, kept predicting, kept drawing the last snapshot it had.
   */
  private open(resolve?: () => void, reject?: (e: Error) => void): void {
    const ws = new WebSocket(this.netUrl);
    this.net = ws;
    let opened = false;
    let ready = false;
    const timeout = window.setTimeout(() => {
      if (ready) return;
      if (reject) this.netWanted = false;
      reject?.(new Error("game server handshake timed out"));
      ws.close();
    }, 15000);
    ws.onopen = () => {
      opened = true;
      this.netTries = 0;
      // A reconnect is a NEW SEAT: the server hands out a fresh id, and every
      // per-connection estimate — the snapshot buffer, the server-clock EMA, the
      // unacked command queue, the predicted-shot ledger — belongs to the seat
      // that just died. Carrying any of it over would interpolate across a
      // discontinuity and stamp fire commands with a render instant from a
      // session the new server seat has never heard of.
      if (this.netDrops > 0) {
        this.resetPrediction();
        this.netStatus("");
        this.banner("RECONNECTED");
      }
      ws.send(
        JSON.stringify({
          t: "join",
          snapshotFormat: "compact-v1",
          name: this.opts.name,
          team: -1,
          room: this.opts.room || undefined,
          mode: this.gunGame ? "gun" : this.opts.mode,
          // Which world this client has ALREADY built its sim out of. Not a
          // request — shared/maps froze it before any of this ran — so the
          // server whitelists it, clamps it to what it can simulate, and tells
          // us the truth back on every snapshot.
          map: MAP.id,
          // A named room from this client is always the lobby door (host or
          // invite) — the yard names no room. FFA implies it server-side; a
          // 3v3 TDM lobby has to say so (see protocol.ts ClientMsg).
          lobby: this.opts.room ? true : undefined,
          // weapons stream: the saved loadout is this seat's first kit.
          loadout: readLoadout(),
        }),
      );
    };
    ws.onerror = () => {
      // A FIRST connection that never opened is a bad host, not a drop: start()
      // is about to reject and put the player back on the menu, so the reconnect
      // loop must not keep dialling a server nobody is waiting for. Any error
      // AFTER the socket opened is a drop and belongs to onclose.
      if (!opened && reject) this.netWanted = false;
      clearTimeout(timeout);
      reject?.(new Error("net"));
    };
    ws.onclose = (ev) => {
      clearTimeout(timeout);
      if (!ready) reject?.(new Error("game server closed before sending a world"));
      // Recorded whether or not anything is done about it: qa/lobby-e2e reads
      // this so a red roster assertion says WHICH half broke instead of blaming
      // the roster for a socket the server closed.
      this.netClose = { code: ev.code, reason: String(ev.reason || ""), wasClean: !!ev.wasClean, at: Date.now() };
      if (this.net === ws) {
        this.net = null;
        this.udp?.close();
        this.udp = null;
      }
      if (!this.netWanted || this.testMode || this.ended) return;
      this.netDrops++;
      // ONE EVENT, ONE NOTIFICATION. This used to raise the persistent net line
      // AND a kill-banner saying the same thing at the same instant, in two
      // different type systems, on top of each other.
      // A server kick carries a reason (AFK close 4001): surface it instead of
      // the generic drop line, so a kick never reads as a network fault.
      const kickReason = String(ev.reason || "").trim();
      this.netStatus(kickReason ? `${kickReason.toUpperCase()} (${ev.code}) — RECONNECTING` : `CONNECTION LOST (${ev.code}) — RECONNECTING`);
      // Exponential backoff, capped: 0.5s, 1s, 2s, 4s, 8s, 8s... A dropped
      // player retries forever rather than being told to reload the page, but a
      // server that is down does not get hammered at 2 Hz by every client.
      const wait = Math.min(8000, 500 * 2 ** Math.min(4, this.netTries++));
      setTimeout(() => {
        if (this.netWanted && !this.net) this.open();
      }, wait);
    };
    // One handler for both lanes: the WebSocket, and the UDP fast lane's copy of
    // every snapshot (openLane).
    const onData = (raw: string): void => {
        // A message arriving proves this thread is running; tell the server so
        // (rate-limited to 1 Hz inside keepAlive), because the timer that is
        // supposed to do it is the first thing a stalled main thread loses.
        this.keepAlive();
        const msg = decodeServerMessage(JSON.parse(raw));
        if (msg.t === "snap" && !this.freshSnap(msg)) return;
        if (msg.t === "welcome") {
          this.you = msg.id;
          this.udpTries = 0;
          if (msg.udp) this.openLane(ws, msg.udp, onData);
        }
        // MATCH START (shared/matchphase.ts StartMsg). Read off a widened view
        // of the message rather than the ServerMsg union, so this client counts
        // down correctly whether or not the variant has been added to the
        // protocol union yet — the message is the contract, the type is
        // bookkeeping.
        const wide = msg as unknown as { t: string; startAt?: number; phase?: MatchPhase };
        if (wide.t === "start") {
          this.armCountdown(Number(wide.startAt));
        } else if (wide.phase === "countdown" && wide.startAt && this.netPhase !== "countdown") {
          // LATE JOINER. Somebody who connects mid-countdown never sees the
          // StartMsg, so the same timestamp is taken off whatever message
          // carries it (the shipped server puts phase + startAt on the welcome
          // and on every snapshot). Guarded on the phase so the 32 Hz repeat
          // cannot re-arm the card and re-ring beats that have already rung.
          this.armCountdown(Number(wide.startAt));
        } else if (wide.phase === "live") {
          this.netPhase = "live";
          this.netStartAt = 0;
        } else if (wide.phase === "pregame" || wide.phase === "countdown") {
          // A late joiner learns the phase from a message that carries it, not
          // from a StartMsg it was not connected for. A "countdown" with no
          // timestamp to count to is, to this client, a PREGAME: the input lock
          // is real, the numerals are not, and the card says STAND BY until a
          // real startAt lands. An already-armed countdown is never downgraded.
          if (this.netPhase !== "countdown") this.netPhase = "pregame";
        }
        // A REFUSAL IS NOT A DROP. "server full" is a decision, and retrying it
        // every 8 s forever would be a client hammering a server that has already
        // said no — and would say nothing to the player either way.
        if (msg.t === "err") {
          clearTimeout(timeout);
          reject?.(new Error(msg.msg));
          this.netWanted = false;
          this.netStatus(String(msg.msg || "SERVER REFUSED THE CONNECTION").toUpperCase());
        }
        if (msg.t === "pong") {
          this.diagnostics?.pong(msg.t0, performance.now());
          const ping = Math.max(0, Date.now() - msg.t0);
          if (this.ghost) this.ghost.ping = ping;
          this.statPings.push(ping);
          if (this.statPings.length > 10) this.statPings.shift();
        }
        // A private server notice (e.g. the chat filter): rendered as a
        // system line in the chat log, never as a connection state.
        if (msg.t === "notice") {
          this.chatLine("SERVER", String(msg.text ?? ""), true);
        }
        if (msg.t === "snap") {
          if (!ready) {
            ready = true;
            clearTimeout(timeout);
            const me = msg.players.find((p) => p.id === msg.you);
            if (me) this.yaw = me.yaw;
            resolve?.();
          }
          this.snapTime = msg.time;
          this.snapRecv = performance.now();
          this.diagnostics?.snapshot(this.snapRecv, !document.hidden);
          // THE MATCH CLOCK AND THE SCORE, OFF THE WIRE. paintHud read these from
          // `this.session`, which is the OFFLINE sim and is null for every online
          // client — so every networked player's scorebug has been showing 0:00
          // and 0 — 0 for the whole match. They ride every snapshot already; they
          // just had nowhere to land. (Found while building the spectator HUD:
          // a spectator staring at a 0:00 clock over a live firefight is the same
          // lie, just easier to notice.)
          this.netScore0 = msg.score0;
          this.netScore1 = msg.score1;
          this.netRemain = msg.remain;
          this.netRound = msg.round ?? null;
          // THE ROOM'S MODE IS THE HOST'S, NOT THIS CLIENT'S. An invited guest
          // dials in with whatever mode their own menu last held; every mode
          // read in this file (HUD, nameplates, minimap, the endcard) goes
          // through opts.mode, so the server's word overwrites it once here.
          if (msg.mode && this.opts) {
            const next = simMode(asModeId(msg.mode));
            const nextGun = msg.mode === "gun";
            if (this.opts.mode !== next || this.gunGame !== nextGun) {
              this.opts.mode = next;
              this.gunGame = nextGun;
            }
          }
          // THE MAP IS NOT THE MODE: a mode is a rule this client can adopt in
          // one assignment, a map is sixty (or two thousand) colliders, a nav
          // graph and a grenade fence that were all built before `boot()` ran.
          // So a disagreement cannot be absorbed — it can only be REPORTED, as
          // loudly as the HUD allows, because everything downstream of it is a
          // lie: your bullets stop on walls the server does not have and pass
          // through walls it does. Once, not every snapshot.
          if (msg.map && msg.map !== MAP.id && !this.mapWarned) {
            this.mapWarned = true;
            console.error(
              `[map] MAP MISMATCH: this client simulates "${MAP.id}", the server is running "${msg.map}". ` +
                `Reload with ?map=${msg.map} — one process is one map (shared/maps/index.ts).`,
            );
            this.netStatus(`SERVER IS ON ${msg.map.toUpperCase()} — RELOAD WITH ?map=${msg.map}`);
          }
          // Track the server clock (EMA) so interpolation runs on snap timestamps,
          // making world motion immune to packet-arrival jitter.
          const svMs = msg.time * 1000;
          const arr = performance.now();
          const off = arr - svMs;
          this.svOffset = this.svOffset === 0 ? off : this.svOffset * 0.9 + off * 0.1;
          // Feed the adaptive interpolation delay: gapMax decays ~4%/snapshot,
          // so one late arrival widens the buffer for about a second and a calm
          // wire narrows it back to INTERP_MS.
          if (this.lastSnapArr) {
            this.gapMax = Math.max(arr - this.lastSnapArr, this.gapMax * 0.96);
            this.interpDelay = Math.min(MAX_RENDER_LAG, Math.max(INTERP_MS, this.gapMax * 2));
          }
          this.lastSnapArr = arr;
          this.snaps.push({ t: svMs, players: msg.players, nades: msg.nades });
          if (this.snaps.length > 24) this.snaps.shift();
          // Roster tracks the WIRE, not the frame rate (see applyRoster).
          this.applyRoster(msg.players);
          this.lastEv.push(...msg.ev);
          this.handleEvents(msg.ev, msg.tick);
          // End-of-match trigger (client-side endcard fallback; the server is
          // authoritative). TDM ends on the clock or a team hitting the map's
          // score limit (scoreLimit: 100 on Nuketown, SCORE_LIMIT elsewhere);
          // FFA ends on the clock or any single player hitting FFA_KILL_LIMIT
          // (team scores never move in FFA, so SCORE_LIMIT must not apply).
          // GUN GAME ends on the clock or any single player finishing the ladder.
          const gun = (msg.mode ?? (this.gunGame ? "gun" : this.opts?.mode)) === "gun";
          const ffa = (msg.mode ?? this.opts?.mode) !== "tdm";
          const best = ffa
            ? msg.players.reduce((m, p) => (num(p.kills) > m ? num(p.kills) : m), 0)
            : 0;
          const gunBest = gun ? msg.players.reduce((m, p) => Math.max(m, num(p.gun ?? 0)), 0) : 0;
          const limitHit = gun ? gunBest >= gunGoal(this.gunKills) : ffa ? best >= FFA_KILL_LIMIT : num(msg.score0) >= scoreLimit(msg.map ?? MAP.id) || num(msg.score1) >= scoreLimit(msg.map ?? MAP.id);
          // END-OF-MATCH WATCHDOG (endWatchdog, fixed()): record that the end
          // was seen on the wire — before finish() runs, so the evidence
          // survives even if finish() ever failed to run. Round-based rooms
          // park remain on ROUND_TIME and score round wins, so neither trigger
          // above fires there: clinched round wins (>= ROUNDS_TO_WIN ends the
          // match synchronously in the sim) count as end evidence too.
          if (!this.ended && (msg.remain <= 0 || limitHit)) this.endEvidenceAt = performance.now();
          if (!this.ended && (this.netRound ? this.netRound.wins0 >= ROUNDS_TO_WIN || this.netRound.wins1 >= ROUNDS_TO_WIN : false)) this.endEvidenceAt = performance.now();
          // TRANSIENT FALSE EVIDENCE must not linger: a fresh live snapshot with
          // a healthy stand (clock running, no limit, no clinched rounds) clears
          // it. Snaps with remain<=0/limitHit/clinch never reach this branch —
          // they set evidence above.
          else if (!this.ended && msg.remain > 0 && !limitHit && !(this.netRound ? this.netRound.wins0 >= ROUNDS_TO_WIN || this.netRound.wins1 >= ROUNDS_TO_WIN : false)) this.endEvidenceAt = 0;
          if (msg.remain <= 0 || limitHit)
            this.finish(num(msg.score0), num(msg.score1));
          // A BENCHED SEAT HAS NOTHING TO RECONCILE. Reconciliation exists to
          // replay the commands the server has not acknowledged yet; a spectator
          // sends none (fixed() returns before it builds one), so this whole
          // block would allocate a fresh ghost 32 times a second and replay an
          // empty queue over it. `ghost` stays null while watching, which is also
          // what interpPlayers wants — the wire pose IS the truth for a body
          // nobody is driving — and the first snapshot after a promotion rebuilds
          // it from the spawn the server just gave them.
          const me = this.spectateCam ? undefined : msg.players.find((p) => p.id === this.you);
          if (me) {
            // Reconcile: adopt the authoritative state, then replay every input
            // the server has not processed yet (seq > acked seq).
            // Where the eye was showing this body a moment ago (pose + the
            // residual still being smoothed off) — the new residual is measured
            // against THIS, so successive corrections chain without popping.
            const hadGhost = this.ghost && this.ghost.alive && me.alive;
            const previousPosition = this.diagnostics && hadGhost && this.matchLive() ? [this.ghost!.x, this.ghost!.y, this.ghost!.z] : null;
            const px = (this.ghost?.x ?? 0) + this.errX;
            const py = (this.ghost?.y ?? 0) + this.errY;
            const pz = (this.ghost?.z ?? 0) + this.errZ;
            this.ghost = this.ghostFrom(me, msg.prediction);
            for (const s of this.predMarked) if (s <= me.seq) this.predMarked.delete(s);
            for (const cmd of this.pending) {
              if (cmd.seq > me.seq) predictMovement(this.ghost as never, cmd, TICK_DT, this.matchLive());
            }
            while (this.pending.length && this.pending[0]!.seq <= me.seq) this.pending.shift();
            if (previousPosition && !document.hidden) this.diagnostics!.correctionMeters.add(Math.hypot(
              previousPosition[0]! - this.ghost.x, previousPosition[1]! - this.ghost.y, previousPosition[2]! - this.ghost.z,
            ));
            // The correction this reconcile just applied, kept as a render-only
            // residual that draw() decays. Big steps (respawn, teleport, real
            // desync) snap instead of glide.
            if (hadGhost) {
              const ex = px - this.ghost.x;
              const ey = py - this.ghost.y;
              const ez = pz - this.ghost.z;
              const m = Math.hypot(ex, ey, ez);
              if (m < 0.6) {
                this.errX = ex;
                this.errY = ey;
                this.errZ = ez;
              } else {
                this.errX = this.errY = this.errZ = 0;
              }
            } else {
              this.errX = this.errY = this.errZ = 0;
            }
          }
        }
      };
    ws.onmessage = (ev) => onData(String(ev.data));
  }

  /**
   * OPEN THE UDP FAST LANE beside socket `ws` (client/src/udp.ts). Its snapshots
   * go through the same handler as the socket's, and only while `ws` is still
   * the live socket. If it fails or dies, the WebSocket already carries
   * everything; it is retried a few times (a relay restart), never in a loop.
   */
  private openLane(ws: WebSocket, token: string, onData: (raw: string) => void): void {
    this.udp?.close();
    this.udp = null;
    if (this.session || this.net !== ws) return;
    const lane = openUdp(
      udpApiFor(this.netUrl),
      token,
      MAP.id,
      (raw) => { if (this.net === ws) onData(raw); },
      () => {
        if (this.udp !== lane) return;
        this.udp = null;
        if (this.net === ws && this.udpTries++ < 3) {
          setTimeout(() => { if (this.net === ws && !this.udp) this.openLane(ws, token, onData); }, 5000);
        }
      },
    );
    this.udp = lane;
  }

  /**
   * A TICK CAN NOW ARRIVE TWICE — once over UDP, once over the WebSocket — and
   * is applied once, from whichever copy lands first. A copy OLDER than the
   * newest tick applied (the UDP copy was lost, the WebSocket's came late) has
   * nothing to say about the world any more, but its events (kills, hits,
   * sounds) are still news: those are played, and nothing else. The server
   * never puts an event in two different ticks (server/game-server.ts), so
   * nothing plays twice. A big step backwards is a new session, not a late copy.
   */
  /**
   * Upstream (.origin 28.10.): the NETWORK STATS overlay's numbers (main.ts
   * paints them). Loss is the share of snapshot ticks in the last 3 s that
   * never arrived on either lane — the server publishes every SNAP_EVERY-th
   * tick, so the gaps are countable. Jitter is the mean deviation of the last
   * ten pings. null = offline (bots).
   */
  netStats(): { ping: number; jitter: number; loss: number; snapHz: number; lane: string } | null {
    if (!this.net || this.testMode) return null;
    const now = performance.now();
    while (this.statSnaps.length && now - this.statSnaps[0]![0] > 3000) this.statSnaps.shift();
    const snaps = this.statSnaps;
    const step = Math.max(1, Math.round(1 / TICK_DT / SNAP_HZ));
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, t] of snaps) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
    const expected = snaps.length > 1 ? Math.round((hi - lo) / step) + 1 : snaps.length;
    const loss = expected > 0 ? Math.max(0, 1 - snaps.length / expected) : 0;
    const span = snaps.length > 1 ? (now - snaps[0]![0]) / 1000 : 0;
    const pings = this.statPings;
    const mean = pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : 0;
    const jitter = pings.length > 1 ? pings.reduce((a, b) => a + Math.abs(b - mean), 0) / pings.length : 0;
    return {
      ping: this.ghost?.ping ?? Math.round(mean),
      jitter,
      loss,
      snapHz: span > 0.5 ? (snaps.length - 1) / span : 0,
      lane: this.udp?.stats.up ? "UDP" : "WS",
    };
  }

  private freshSnap(msg: { tick: number; ev: NetEvent[]; remain?: number; score0?: number; score1?: number }): boolean {
    if (this.seenTicks.has(msg.tick)) {
      // END-OF-MATCH RETRANSMIT (server/index.ts, over window): the end state
      // repeats on the FROZEN end tick until the rollover, so every repeat is
      // a "duplicate" by tick — and must never swallow the end of the match.
      // Only the idempotent end signals are replayed here (finish() returns
      // when already ended); kills/feed stay deduplicated, nothing plays twice.
      // STALE-ROLLOVER GUARD: a duplicate of the PREVIOUS match's frozen end
      // tick landing after the rollover (unordered UDP redelivery, WS replay
      // after a reconnect) must NOT re-enter finish() — the endcard would come
      // back up over a live match that no further match/live will ever end.
      // RECONNECT WINDOW: before the first match/live of this session
      // (liveTick < 0) duplicates replay nothing at all. The legitimate cases
      // need no replay: the first sighting of the end tick is always fresh
      // and finishes there (remain<=0 covers the eventless path), finish() is
      // idempotent, and a fast reconnect into a live match carries no end
      // signals while one into the over window re-finishes off its first
      // fresh remain<=0 snapshot.
      if (this.liveTick >= 0 && !isStaleMatchTick(msg.tick, this.liveTick)) {
      for (const e of msg.ev) {
        if (e.t === "match" && e.state === "end") {
          try { this.finish(e.score0, e.score1); } catch (err) { console.debug("[events] match/end replay failed", err); /* the match end is never blocked */ }
        }
      }
      // The over window pins remain to 0 on that same frozen tick: the main
      // remain<=0 trigger never runs for duplicates, so it runs here.
      if ((msg.remain ?? 1) <= 0) {
        try { this.finish(num(msg.score0), num(msg.score1)); } catch (err) { console.debug("[events] remain<=0 replay failed", err); /* the match end is never blocked */ }
      }
      }
      return false;
    }
    this.seenTicks.add(msg.tick);
    this.statSnaps.push([performance.now(), msg.tick]);
    if (this.statSnaps.length > 256) this.statSnaps.shift();
    if (this.seenTicks.size > 256) this.seenTicks.delete(this.seenTicks.values().next().value!);
    if (msg.tick < this.snapTick && this.snapTick - msg.tick < 1024) {
      this.lastEv.push(...msg.ev);
      this.handleEvents(msg.ev, msg.tick);
      return false;
    }
    this.snapTick = msg.tick;
    return true;
  }

  /**
   * The one player-facing line about the network. Persistent (a banner fades in
   * 1.7 s and a player who looked away would never know they had been dropped),
   * created on demand so the HTML does not have to carry an element for a state
   * it is normally never in. Empty text removes it.
   */
  private netStatus(text: string): void {
    let el = document.getElementById("netstatus");
    if (!text) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "netstatus";
      // STYLED IN style.css (#netstatus), not here. The inline string this used
      // to carry was the only system-ui font, the only #ffd34d and the only
      // rounded corner in the entire client — a developer placeholder rendering
      // at z-index 60 over the Bungee pre-game title every time a socket blinked.
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  bindInput(): void {
    // feel stream: EVERY game input resolves through the keybinding table
    // (ui/keybinds.ts — SETTINGS → CONTROLS rebinds it, persisted). Keys, mouse
    // buttons ("Mouse0".."Mouse4") and wheel notches are all just codes; this
    // switch is the one place an action becomes game state.
    // (Gamepad buttons feed the same switch via inputAction(), below.)
    const act = (a: Action | null, on: boolean): void => this.inputAction(a, on);
    const down = (e: KeyboardEvent) => {
      // feel stream: the final killcam is skippable with or without the pointer.
      if (this.fkc && !e.repeat && (e.code === "Enter" || e.code === "NumpadEnter" || actionOf(e.code) === "jump")) this.killcamSkip();
      // F8 snapshots map / build / position / aim for a bug report (fixed, never rebindable).
      if (e.code === "F8" && this.running) {
        e.preventDefault();
        if (!e.repeat) this.bugReport();
        return;
      }
      if (!this.running || !(this.locked || qaNoLock()) || (e.target instanceof HTMLElement && e.target.closest("input,textarea,[contenteditable=true]"))) return;
      // CHAT OWNS ITS KEYS. While the line is open no key drives the game —
      // including when focus slipped off the input (pointer-lock quirk): those
      // keys would otherwise type nothing AND move the body (the "random open
      // eats input" report). ENTER sends and ESC closes even unfocused; any
      // other key pulls focus back instead of playing.
      if (this.isChatOpen()) {
        if (e.code === "Enter" || e.code === "NumpadEnter") {
          const box = document.getElementById("chat-input") as HTMLInputElement | null;
          if (box) {
            e.preventDefault();
            this.sendChat(box.value);
            this.closeChat();
            this.chatDraft = "";
          }
        } else if (e.code === "Escape") {
          this.closeChat();
        } else if (!e.repeat) {
          (document.getElementById("chat-input") as HTMLInputElement | null)?.focus({ preventScroll: true });
        }
        return;
      }
      const a = actionOf(e.code);
      // Keyboard Lock delivers reserved combinations in supported fullscreen browsers.
      // The scoreboard key only belongs to the game while the HUD is up: on every
      // pre-game screen TAB is focus traversal (eight Tabs on the host lobby used to
      // leave focus on COPY LINK all eight times — see the scoreboard case above).
      if (a && (a !== "scoreboard" || !document.getElementById("hud")?.classList.contains("hidden"))) e.preventDefault();
      if (e.repeat) return;
      if (e.code === "Enter" || e.code === "NumpadEnter") this.killcamSkip();
      act(a, true);
    };
    const up = (e: KeyboardEvent) => {
      if (!this.running || !(this.locked || qaNoLock()) || (e.target instanceof HTMLElement && e.target.closest("input,textarea,[contenteditable=true]"))) return;
      // Matches `down`: while the chat line is open, releases never touch
      // game state either (keys were already cleared by openChat).
      if (this.isChatOpen()) return;
      act(actionOf(e.code), false);
    };
    const chatIn = document.getElementById("chat-input") as HTMLInputElement | null;
    chatIn?.addEventListener("keydown", (e) => {
      // The line owns its keys: nothing typed here reaches the window's game handler.
      e.stopPropagation();
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        this.sendChat(chatIn.value);
        this.closeChat();
        this.chatDraft = "";
      } else if (e.code === "Escape") {
        this.closeChat();
      }
    });
    chatIn?.addEventListener("blur", () => {
      // FOCUS LOSS IS NOT A DISMISS (review LOW): a pointer-lock quirk or an
      // alt-tab used to closeChat() here and eat the typed line. Keep the
      // draft; only ENTER (sent) and ESC dismiss the line.
      if (this.isChatOpen()) this.chatDraft = chatIn.value;
    });
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    // The SKIP button is a real button for anyone with a cursor; with the
    // pointer locked there is no cursor, so a click anywhere is the same beat.
    document.getElementById("kc-skip")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.killcamSkip();
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.running) return;
      if ((this.killcamT > 0 || this.fkc) && e.button === 0) this.killcamSkip();
      // A click while the chat line is open is typing business, not shooting:
      // pull focus back; the re-lock path below still runs when unlocked.
      if (this.isChatOpen()) {
        (document.getElementById("chat-input") as HTMLInputElement | null)?.focus({ preventScroll: true });
        if (this.locked) return;
      }
      if (!this.locked && !qaNoLock()) {
        this.captureKeyboard();
        // Chromium returns a Promise here and REJECTS it when the lock cannot be
        // taken right now (SecurityError: the user just pressed Esc and the
        // browser's cool-down is running; WrongDocumentError mid-navigation).
        // Nothing to do about either — the next click asks again — but an
        // unhandled rejection is a page error, so it is swallowed explicitly.
        const r = this.canvas.requestPointerLock() as unknown;
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
        return;
      }
      if (e.button === 1) e.preventDefault(); // no autoscroll
      act(actionOf(`Mouse${e.button}`), true);
    });
    window.addEventListener("mouseup", (e) => act(actionOf(`Mouse${e.button}`), false));
    window.addEventListener("contextmenu", (e) => { if (this.running && this.locked) e.preventDefault(); });
    // weapons stream: the mouse wheel cycles the two slots (one notch = one swap).
    // feel stream: the wheel is a bindable code too — a notch is a tap of its action.
    let wheelAt = 0;
    window.addEventListener("wheel", (e) => {
      if (!this.running || !this.locked || Math.abs(e.deltaY) < 1) return;
      const now = performance.now();
      if (now - wheelAt < 140) return;
      wheelAt = now;
      const [dir, any] = wheelCodes(e.deltaY);
      const a = actionOf(dir) ?? actionOf(any);
      if (!a) return;
      act(a, true);
      if (a !== "swap" && a !== "primary" && a !== "secondary") setTimeout(() => act(a, false), 60);
    }, { passive: true });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.keyboard()?.unlock(); this.clearInput(); }
      else {
        // RE-ACQUIRE BURST GUARD: the first events after a re-acquire carry
        // stale accumulated movement (ESC/pause/alt-tab). Swallow ~50 ms of
        // look — below human reaction time, so no honest input is lost.
        // Skipped on the very first lock (no stale movement to swallow).
        const now = performance.now();
        if (this.lookHadLock) this.lookGapUntil = now + 50;
        this.lookHadLock = true;
        this.lastLookT = now;
        if (document.fullscreenElement) void this.keyboard()?.lock(this.gameKeyCodes).catch(() => {});
      }
    });
    window.addEventListener("blur", () => this.clearInput());
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) { this.keyboard()?.unlock(); this.clearInput(); }
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      // SPIKE CLAMP: pointer-lock movement on Windows throws occasional huge
      // deltas (lock re-acquire, DPI jumps) that read as a spin; no honest
      // single event turns further than this.
      let dx = e.movementX;
      let dy = e.movementY;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const nowMs = performance.now();
      // POINTER-LOCK GAP: drop the re-acquire burst (see pointerlockchange).
      if (nowMs < this.lookGapUntil) return;
      dx = Math.max(-160, Math.min(160, dx));
      dy = Math.max(-160, Math.min(160, dy));
      const me = this.me();
      // NaN SELF-HEAL: one poisoned value (snapshot ads, sens, zoom) used to
      // stick yaw/pitch at NaN forever — a permanent wall-stare. Clamp the
      // inputs and recover the state instead.
      const adsRaw = me?.ads ?? 0;
      const ads = Number.isFinite(adsRaw) ? Math.max(0, Math.min(1, adsRaw)) : 0;
      if (!Number.isFinite(this.sensAds)) this.sensAds = ads;
      if (!Number.isFinite(this.yaw)) this.yaw = Number.isFinite(me?.yaw) ? me!.yaw : 0;
      if (!Number.isFinite(this.pitch)) this.pitch = 0;
      // weapons stream: through a scope the turn rate follows the zoom (same
      // feel per screen-width at 4x as at the hip); sights keep the ADS slow-down.
      // UI stream hook: sens / ADS multiplier / invert Y come from SETTINGS (ui/prefs.ts).
      // ADS is eased (see sensAds), never stepped: the snapshot flips late
      // while the FOV lerps, and stepping here is the aiming skip.
      const ldt = Math.max(0.001, Math.min(0.1, (nowMs - this.lastLookT) / 1000 || 0.008));
      this.lastLookT = nowMs;
      this.sensAds += (ads - this.sensAds) * (1 - Math.exp(-18 * ldt));
      const a = this.sensAds;
      const pf = prefs();
      const zoomRaw = this.whud.scoped ? (Math.tan((this.fov * Math.PI) / 360) / Math.tan((vfov() * Math.PI) / 360)) * 1.15 : 1 - a * 0.38;
      // ZOOM FINITE-CLAMP: a NaN fov/vfov (or tan pole) must not poison s —
      // an unclamped NaN zoom returns early on every event (dead look).
      const zoom = Number.isFinite(zoomRaw) ? Math.max(0.05, Math.min(4, zoomRaw)) : 1;
      // SENS CLAMP AT THE USE SITE (review LOW-MED): prefs() is sanitised on
      // load/set, but a mutated object must never become a spin multiplier —
      // sens and the ADS multiplier are both pinned to 0.1–3 here.
      const sensBase = Number.isFinite(pf.sens) ? pf.sens : 1;
      const adsMult = Number.isFinite(pf.adsSens) ? pf.adsSens : 1;
      const s = Math.max(0.1, Math.min(3, sensBase)) * 0.00215 * zoom * (1 + a * (Math.max(0.1, Math.min(3, adsMult)) - 1));
      if (!Number.isFinite(s) || s <= 0) return;
      let dyaw = -dx * s;
      let dpitch = dy * s * (pf.invertY ? -1 : 1);
      if (!Number.isFinite(dyaw) || !Number.isFinite(dpitch)) return;
      // SINGLE-FRAME CAP (token bucket, see the field note): refill since the
      // last look event, then scale the event down to what the bucket holds.
      // Honest flicks are many small events across frames and pass untouched;
      // only an impossible single-frame jump gets clipped.
      if (!Number.isFinite(this.lookTokens) || !Number.isFinite(this.lookBudgetT)) {
        this.lookTokens = Game.LOOK_BURST;
        this.lookBudgetT = nowMs;
      }
      this.lookTokens = Math.min(Game.LOOK_BURST, this.lookTokens + Math.max(0, nowMs - this.lookBudgetT) * Game.LOOK_RATE / 1000);
      this.lookBudgetT = nowMs;
      const cost = Math.hypot(dyaw, dpitch);
      if (cost > this.lookTokens) {
        if (this.lookTokens <= 0) return;
        const k = this.lookTokens / cost;
        dyaw *= k;
        dpitch *= k;
        this.lookTokens = 0;
      } else {
        this.lookTokens -= cost;
      }
      this.yaw = angWrap(this.yaw + dyaw);
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + dpitch));
    });
  }

  /** Keyboard Lock list in fullscreen: every bound keyboard key (feel stream: ui/keybinds.ts). */
  private get gameKeyCodes(): string[] {
    return keyboardCodes();
  }

  /**
   * THE ONE PLACE an action becomes game state (keyboard, mouse, wheel AND
   * gamepad all land here). bindInput's `act` closure is this method, so the
   * pad path can never drift from the keyboard path.
   */
  private inputAction(a: Action | null, on: boolean): void {
    switch (a) {
      case "forward": this.keys.f = on; break;
      case "back": this.keys.b = on; break;
      case "left": this.keys.l = on; break;
      case "right": this.keys.r = on; break;
      case "jump":
        this.keys.jump = on;
        // SKIP the killcam: the jump key (or ENTER / a click / pad A), the same beat as the on-screen button.
        if (on) this.killcamSkip();
        break;
      case "crouch": this.keys.crouch = on; break;
      // CORNER LEAN (Q/E, view-only): the eye shifts and the model rolls on
      // the snapshot's lean value; the capsule never moves (shared/sim.ts).
      case "leanL": this.keys.leanL = on; break;
      case "leanR": this.keys.leanR = on; break;
      case "sprint":
        if (on) {
          const now = performance.now();
          this.keys.tac = prefs().tacSprint && now - this.shiftTap < 280; // UI stream hook: SETTINGS tac sprint
          this.shiftTap = now;
          this.keys.sprint = true;
        } else {
          this.keys.sprint = false;
          this.keys.tac = false;
        }
        break;
      case "reload": {
        this.keys.reload = on;
        // The Kong grumbles for ammo — only when a reload will actually happen.
        const rb = this.heldBody();
        const rw = rb && WEAPON_BY_ID[rb.weapon];
        if (on && rb?.alive && rw && rb.ammo < rw.mag && rb.reserve > 0 && rb.reload <= 0) this.announcer.kong("reload");
        break;
      }
      case "melee": this.keys.melee = on; break;
      // BANANA FRAG. Hold to keep aiming (the landing marker stays live), release to throw.
      case "frag": if (on) this.nadeDown(); else this.nadeUp(); break;
      // weapons stream: primary, pistol, and the toggle (the wheel by default).
      case "primary": if (on) this.selectSlot(0); break;
      case "secondary": if (on) this.selectSlot(1); break;
      case "swap": if (on) this.selectSlot(-1); break;
      case "spray": if (on) this.spray(); break;
      case "fire":
        this.keys.fire = on;
        this.fireHeld = on;
        if (on) {
          // weapons stream: dry fire — a trigger pull on an empty gun with nothing left to reload
          const b = this.heldBody();
          const dw = b?.alive && this.matchLive() ? WEAPON_BY_ID[b.weapon] : undefined;
          if (b && dw && dw.mag > 0 && b.ammo <= 0 && b.reserve <= 0 && b.reload <= 0) this.audio.dry(b.weapon);
        }
        break;
      // UI stream hook: ADS hold / toggle (SETTINGS → GAMEPLAY).
      case "ads":
        if (on) this.keys.ads = prefs().adsMode === "toggle" ? !this.keys.ads : true;
        else if (prefs().adsMode !== "toggle") this.keys.ads = false;
        break;
      case "scoreboard": {
        // TAB IS THE SCOREBOARD, AND THE SCOREBOARD BELONGS TO A MATCH: #hud is
        // hidden for the whole of the menu and pre-game (see `down`).
        const sb = document.getElementById("scoreboard");
        if (!on) sb?.classList.add("hidden");
        else if (!document.getElementById("hud")?.classList.contains("hidden")) sb?.classList.remove("hidden");
        break;
      }
      // TEXT CHAT. The input field takes the keyboard from here on (the guard
      // in `down` skips form targets) until ENTER or ESC. Re-pressing while
      // open is a no-op (never a reset that eats the typed line).
      case "chat": if (on && !this.isChatOpen() && !document.getElementById("hud")?.classList.contains("hidden")) this.openChat(); break;
      default:
        break;
    }
  }

  /** TRUE while any modal owns the input (settings/pause/loadout/endcard/lobby/gate). */
  private modalOpen(): boolean {
    try {
      return !!(
        document.getElementById("settings") ||
        document.getElementById("pause") ||
        document.getElementById("loadout") ||
        document.getElementById("nana-lobby") ||
        document.getElementById("nana-gate") ||
        document.getElementById("nana-full") ||
        document.getElementById("endcard")?.classList.contains("hidden") === false
      );
    } catch {
      return false;
    }
  }

  /**
   * GAMEPAD POLL, once per render frame (loop() calls it before stepFixed).
   * Sticks are analog (−1..1 after deadzone+curve), buttons feed inputAction().
   * Works WITHOUT pointer lock (a pad needs no cursor); modals and the bench
   * (spectateCam) take no game input. Look uses frame dt so 30 fps turns as
   * fast as 144 fps; buttons edge-detect against padPrev.
   */
  private pollGamepad(dt: number): void {
    const clear = (): void => {
      this.padMoveX = 0;
      this.padMoveZ = 0;
    };
    let pad: Gamepad | null = null;
    try {
      if (!prefs().padEnabled || !this.running || this.spectateCam || this.modalOpen()) {
        // Keep prev in sync so reopening the game does not fire stale edges.
        try {
          const p = activePad();
          this.padPrev = p ? [...p.buttons.map((b) => !!b?.pressed)] : [];
        } catch {
          this.padPrev = [];
        }
        clear();
        return;
      }
      pad = activePad();
    } catch {
      clear();
      return;
    }
    if (!pad) {
      this.padPrev = [];
      clear();
      return;
    }
    const pf = prefs();
    const prev = this.padPrev;
    const nowPressed = (i: number): boolean => !!pad!.buttons[i]?.pressed;
    const edge = (i: number): boolean => nowPressed(i) && !prev[i];
    const southpaw = pf.padStick === "southpaw";
    const tactical = pf.padLayout === "tactical";

    // --- sticks
    let sticks: { moveX: number; moveZ: number; lookX: number; lookY: number };
    try {
      sticks = readPadSticks(pad, pf.padDeadzone, pf.padCurve, southpaw);
    } catch {
      sticks = { moveX: 0, moveZ: 0, lookX: 0, lookY: 0 };
    }
    this.padMoveX = sticks.moveX;
    this.padMoveZ = sticks.moveZ;

    // Footer-strip device vote (ui/keys.ts, last input wins): every real pad
    // input counts, not just the first. Drift inside the deadzone must not
    // vote (sticks read ~0 there anyway — 0.25 needs a deliberate push).
    {
      const stickHot = Math.hypot(sticks.moveX, sticks.moveZ) > 0.25 || Math.hypot(sticks.lookX, sticks.lookY) > 0.25;
      if (stickHot || pad.buttons.some((b) => !!b?.pressed)) notePadInput();
    }

    // --- look (right stick), same zoom/ADS math as the mouse, per-frame dt
    const lookMag = Math.hypot(sticks.lookX, sticks.lookY);
    if (lookMag > 0.0005 && dt > 0 && Number.isFinite(dt)) {
      const me = this.me();
      // ADS CLAMP (mouse parity): snapshot ads pinned to 0–1, NaN -> 0.
      const adsRaw = me?.ads ?? (this.ghost as unknown as { ads?: number } | null)?.ads ?? 0;
      const ads = Number.isFinite(adsRaw) ? Math.max(0, Math.min(1, adsRaw)) : 0;
      // NaN SELF-HEAL (mouse parity): angWrap(NaN) = NaN sticks yaw forever.
      if (!Number.isFinite(this.yaw)) this.yaw = Number.isFinite(me?.yaw) ? me!.yaw : 0;
      if (!Number.isFinite(this.pitch)) this.pitch = 0;
      if (!Number.isFinite(this.sensAds)) this.sensAds = ads;
      // ADS EASE (mouse parity, ~18/s like the FOV lerp): the snapshot flips
      // late while the FOV is still mid-lerp — raw ads here steps the turn
      // rate mid-zoom (pad aim skip). sensAds tracks the picture instead.
      const adt = Math.max(0.001, Math.min(0.1, dt));
      this.sensAds += (ads - this.sensAds) * (1 - Math.exp(-18 * adt));
      const a = this.sensAds;
      const zoomRaw = this.whud.scoped ? (Math.tan((this.fov * Math.PI) / 360) / Math.tan((vfov() * Math.PI) / 360)) * 1.15 : 1 - a * 0.38;
      // ZOOM FINITE-CLAMP (mouse parity): a NaN fov/vfov (or tan pole) must
      // not poison rate -> NaN yaw (yaw-poison).
      const zoom = Number.isFinite(zoomRaw) ? Math.max(0.05, Math.min(4, zoomRaw)) : 1;
      // SENS CLAMP AT THE USE SITE (mouse parity): pad sens + ADS mult pinned to 0.1–3.
      const padBase = Number.isFinite(pf.padSens) ? pf.padSens : 1;
      const padAdsMult = Number.isFinite(pf.padAdsSens) ? pf.padAdsSens : 1;
      let rate = Math.max(0.1, Math.min(3, padBase)) * 2.6 * zoom * (1 + a * (Math.max(0.1, Math.min(3, padAdsMult)) - 1));
      // Aim assist: slow the stick near a visible enemy + pull toward them.
      let yawPull = 0;
      let pitchPull = 0;
      if (pf.padAimAssist) {
        const assist = this.padAssist();
        if (assist) {
          rate *= assist.slow;
          yawPull = assist.yawPull;
          pitchPull = assist.pitchPull;
        }
      }
      const step = Math.min(0.1, dt);
      // YAW WRAP (mouse parity): stick delta + assist pull both wrapped.
      // RATE FINITE-GUARD (mouse parity): poisoned rate never reaches angWrap.
      if (Number.isFinite(rate) && rate > 0) {
        this.yaw = angWrap(this.yaw - sticks.lookX * rate * step + yawPull * step);
        this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + sticks.lookY * rate * step * (pf.padInvertY ? -1 : 1) + pitchPull * step));
      }
    } else if (pf.padAimAssist && lookMag <= 0.0005) {
      // Idle stick: no magnet (it would fight the player's chosen aim).
    }

    // --- triggers (analog, edge-pulsed so an idle pad never clears mouse input:
    // each side only writes on its own press/release; holding both is OR-ed).
    const rtHeld = padHeld(pad, PAD.RT, TRIGGER_HELD);
    const ltHeld = padHeld(pad, PAD.LT, TRIGGER_HELD);
    if (rtHeld && !this.padWasFire) this.inputAction("fire", true);
    else if (!rtHeld && this.padWasFire) this.inputAction("fire", false);
    else if (rtHeld) this.keys.fire = true;
    this.padWasFire = rtHeld;
    if (prefs().adsMode === "toggle") {
      if (ltHeld && !this.padWasAds) this.inputAction("ads", true);
    } else if (ltHeld !== this.padWasAds) this.inputAction("ads", ltHeld);
    else if (ltHeld) this.keys.ads = true;
    this.padWasAds = ltHeld;

    // --- face buttons (edge = pulse actions; holds only write on change)
    if (edge(PAD.A)) this.inputAction("jump", true);
    const crouchBtn = tactical ? PAD.R3 : PAD.B;
    if (nowPressed(crouchBtn) !== !!prev[crouchBtn]) this.inputAction("crouch", nowPressed(crouchBtn));
    const meleeBtns = tactical ? [PAD.B, PAD.RB] : [PAD.R3, PAD.RB];
    this.inputAction("crouch", nowPressed(crouchBtn));
    if (edge(PAD.X)) this.inputAction("reload", true);
    if (edge(PAD.Y)) this.inputAction("swap", true);
    for (const m of meleeBtns) {
      if (edge(m)) {
        this.inputAction("melee", true);
        break;
      }
    }
    // --- frag: LB (hold to cook). RB is melee in both layouts.
    const fragHeld = nowPressed(PAD.LB);
    if (fragHeld && !prev[PAD.LB]) this.inputAction("frag", true);
    else if (!fragHeld && prev[PAD.LB]) this.inputAction("frag", false);
    // --- sprint: L3 hold (tac double-tap logic lives in inputAction)
    const sprintHeld = nowPressed(PAD.L3);
    if (sprintHeld && !prev[PAD.L3]) this.inputAction("sprint", true);
    else if (!sprintHeld && prev[PAD.L3]) this.inputAction("sprint", false);
    else if (sprintHeld) this.keys.sprint = true;
    // --- d-pad weapons
    if (edge(PAD.DUP)) this.inputAction("primary", true);
    if (edge(PAD.DDOWN)) this.inputAction("secondary", true);
    // --- spray paint: D-RIGHT (free in both layouts)
    if (edge(PAD.DRIGHT)) this.inputAction("spray", true);
    // --- scoreboard: BACK hold
    const sbHeld = nowPressed(PAD.BACK);
    if (sbHeld !== !!prev[PAD.BACK]) this.inputAction("scoreboard", sbHeld);
    // DLEFT doubles as scoreboard for pads without a BACK button wired.
    if (edge(PAD.DLEFT)) this.inputAction("scoreboard", true);
    else if (!nowPressed(PAD.DLEFT) && prev[PAD.DLEFT]) this.inputAction("scoreboard", false);

    this.padPrev = [...pad.buttons.map((b) => !!b?.pressed)];
  }

  /**
   * AIM ASSIST target: nearest visible enemy within ~10° of the crosshair.
   * Returns the stick slowdown + a small magnet pull (rad/s toward the chest).
   * LOS-checked (traceWorld) so nobody aims through a container.
   */
  private padAssist(): { slow: number; yawPull: number; pitchPull: number } | null {
    try {
      if (!prefs().padAimAssist || this.spectateCam || this.killcamT > 0 || this.fkc) return null;
      if (!this.matchLive() || this.ended) return null;
      const me = this.ghost ?? this.me();
      if (!me || !me.alive) return null;
      const eyeY = me.slide > 0 ? SLIDE_EYE : me.crouch ? CROUCH_EYE : EYE;
      const ex = me.x;
      const ey = me.y + eyeY;
      const ez = me.z;
      const myTeam = this.me()?.team;
      const ffa = this.opts?.mode === "ffa";
      let best: { yaw: number; pitch: number; miss: number; dist: number } | null = null;
      for (const p of this.drawn) {
        if (p.id === this.you || !p.alive) continue;
        if (!ffa && myTeam !== undefined && p.team === myTeam) continue;
        const dx = p.x - ex;
        const dy = p.y + 1.0 - ey;
        const dz = p.z - ez;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 55 || dist < 0.5) continue;
        const wantYaw = Math.atan2(-dx, -dz);
        const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
        let dyaw = (wantYaw - this.yaw) % (Math.PI * 2);
        if (dyaw > Math.PI) dyaw -= Math.PI * 2;
        if (dyaw < -Math.PI) dyaw += Math.PI * 2;
        const dpitch = wantPitch - this.pitch;
        const miss = Math.sqrt(dyaw * dyaw + dpitch * dpitch) * (180 / Math.PI);
        if (miss > 10) continue;
        if (!best || miss < best.miss) best = { yaw: wantYaw, pitch: wantPitch, miss, dist };
      }
      if (!best) return null;
      // LOS: the assist must not grab a body behind a wall. Aim vector matches
      // aimDir(): forward = (−sin yaw·cos pitch, sin pitch, −cos yaw·cos pitch).
      const ax = -Math.sin(best.yaw) * Math.cos(best.pitch);
      const ay = Math.sin(best.pitch);
      const az = -Math.cos(best.yaw) * Math.cos(best.pitch);
      const wall = traceWorld(ex, ey, ez, ax, ay, az, Math.min(best.dist, 60));
      if (wall.t < best.dist - 0.6) return null;
      // STRENGTH FINITE-CLAMP (mouse parity): a NaN/Infinity pref must not
      // poison slow/pull via assistSlow/k — NaN survives Math.max/min and
      // ends up in yaw (yaw-poison). Falls back to the prefs default 0.6.
      const strengthRaw = prefs().padAimStrength;
      const strength = Number.isFinite(strengthRaw) ? Math.max(0, Math.min(1, strengthRaw)) : 0.6;
      const slow = assistSlow(best.miss, strength);
      // Magnet: up to ~0.9 rad/s at full strength, fading with miss angle.
      const k = strength * 0.9 * Math.max(0, 1 - best.miss / 10);
      let pullYaw = (best.yaw - this.yaw) % (Math.PI * 2);
      if (pullYaw > Math.PI) pullYaw -= Math.PI * 2;
      if (pullYaw < -Math.PI) pullYaw += Math.PI * 2;
      const pullPitch = best.pitch - this.pitch;
      const clampPull = (v: number): number => Math.max(-1.2, Math.min(1.2, v * 4));
      return { slow, yawPull: clampPull(pullYaw) * k, pitchPull: clampPull(pullPitch) * k };
    } catch {
      return null;
    }
  }

  /** The body whose weapons this client drives: the offline sim's, or the predicted ghost. */
  private heldBody(): (PlayerSnap & { cook?: number; heat?: number; onGround?: boolean }) | undefined {
    if (this.session) return this.session.players.get(this.you) as never;
    return (this.ghost ?? this.me()) as never;
  }

  /**
   * weapons stream: 0 = primary, 1 = pistol, -1 = the other one. Only records
   * the WISH — the next command carries it (InputCmd.weapon) and the sim, the
   * same on both sides of the wire, performs the swap.
   */
  selectSlot(slot: 0 | 1 | -1): void {
    const b = this.heldBody();
    if (!b || !b.alive || !b.alt) return;
    const primary = b.weapon === "pistol" ? b.alt : b.weapon;
    const current = this.wantWeapon && (this.wantWeapon === b.weapon || this.wantWeapon === b.alt) ? this.wantWeapon : b.weapon;
    const next = slot === 0 ? primary : slot === 1 ? "pistol" : current === b.weapon ? b.alt : b.weapon;
    if (next === current) return;
    this.wantWeapon = next;
  }

  /** The weapon id this tick's command asks for. */
  private wantedWeapon(b: { weapon: string; alt?: string } | undefined): string {
    if (!b) return PRIMARY_WEAPON_ID;
    if (this.wantWeapon && (this.wantWeapon === b.weapon || this.wantWeapon === b.alt)) return this.wantWeapon;
    return b.weapon;
  }

  /** Seconds the local frag has cooked, as the sim (or the prediction) has it. */
  localCook(): number {
    return this.heldBody()?.cook ?? 0;
  }

  /**
   * weapons stream: the LOADOUT CHANGE the UI's loadout screen calls. Saved
   * locally (it rides the next join), sent to the server (applies at next
   * spawn mid-match, at once in the lobby / countdown), and offline handed to
   * the local sim under the same rule.
   */
  setLoadout(l: Loadout): void {
    const clean = sanitizeLoadout(l);
    saveLoadout(clean);
    if (this.session) {
      const p = this.session.players.get(this.you);
      if (p) this.session.setLoadout(p, clean);
    } else if (this.net?.readyState === 1) {
      this.net.send(JSON.stringify({ t: "loadout", loadout: clean }));
    }
  }

  private keyboard(): { lock(keys: string[]): Promise<void>; unlock(): void } | undefined {
    return (navigator as Navigator & { keyboard?: { lock(keys: string[]): Promise<void>; unlock(): void } }).keyboard;
  }

  private captureKeyboard(): void {
    const keyboard = this.keyboard();
    if (!keyboard || !document.documentElement.requestFullscreen) return;
    const lock = (): void => { if (this.running) void keyboard.lock(this.gameKeyCodes).catch(() => {}); };
    if (document.fullscreenElement) lock();
    else void document.documentElement.requestFullscreen().then(lock).catch(() => {});
  }

  private clearInput(): void {
    for (const key of Object.keys(this.keys)) (this.keys as unknown as Record<string, boolean>)[key] = false;
    this.fireHeld = false;
    this.nadeHeld = false;
    // gamepad stream: sticks re-assert every frame, so clearing is safe (no stuck move after pause/blur).
    this.padMoveX = 0;
    this.padMoveZ = 0;
  }

  me(): PlayerSnap | undefined {
    return this.players.get(this.you);
  }

  /** TRUE while the chat line is visibly open (input unhidden). */
  isChatOpen(): boolean {
    const box = document.getElementById("chat-input");
    return !!box && !box.classList.contains("hidden");
  }

  /** Unsent chat line kept across blur/ESC so focus loss never eats typing. */
  private chatDraft = "";

  /** Open the chat line. Held movement is let go so you stop while typing. */
  openChat(): void {
    const box = document.getElementById("chat-input") as HTMLInputElement | null;
    if (!box || !this.running) return;
    // Idempotent: re-pressing T (or a refocus click) while open must never
    // clear the line being typed — that reset is the "eats input" half.
    if (!box.classList.contains("hidden")) {
      box.focus({ preventScroll: true });
      return;
    }
    this.clearInput();
    // Restore the draft (blur/ESC keeps it; only a sent line clears it).
    box.value = this.chatDraft;
    box.classList.remove("hidden");
    document.getElementById("chat")?.classList.add("open");
    box.focus({ preventScroll: true });
  }

  closeChat(): void {
    const box = document.getElementById("chat-input") as HTMLInputElement | null;
    if (!box || box.classList.contains("hidden")) return;
    // Keep the draft: only a SENT line clears it (see the Enter paths), so
    // ESC or a later reopen never loses what was typed.
    this.chatDraft = box.value;
    box.classList.add("hidden");
    document.getElementById("chat")?.classList.remove("open");
    box.blur();
  }

  /** Online the server cleans the line and echoes it back to everyone; vs bots it is only ours. */
  sendChat(raw: string): void {
    const text = raw.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) return;
    if (this.net?.readyState === 1) this.net.send(JSON.stringify({ t: "chat", text }));
    else this.chatLine(this.me()?.name ?? this.opts?.name ?? "YOU", text);
  }

  /** One line in the chat log: name in team colour, text as plain text (never HTML).
   *  System lines (server notices) render in their own neutral style, never in
   *  a player's team colour, so a callsign can never impersonate them. */
  chatLine(name: string, text: string, sys = false): void {
    const log = document.getElementById("chat-log");
    if (!log) return;
    const row = document.createElement("div");
    const who = document.createElement("b");
    if (sys) {
      row.classList.add("is-system");
      who.className = "kf-system";
    } else {
      const myTeam = this.me()?.team;
      const from = [...this.players.values()].find((p) => p.name === name);
      const ffa = this.opts?.mode === "ffa";
      who.className = from?.id === this.you ? "kf-you" : !ffa && from?.team === myTeam ? "kf-ally" : "kf-enemy";
    }
    who.textContent = `${name}:`;
    const said = document.createElement("span");
    said.textContent = text;
    row.append(who, said);
    log.append(row);
    while (log.children.length > 5) log.firstChild?.remove();
    setTimeout(() => row.remove(), 10000);
    uiSfx("tick");
  }

  /** F8 — copy where you stand and look (plus map, mode, build) for a bug report. */
  bugReport(): void {
    const me = this.me();
    const c = this.camera.position;
    void captureBugReport({
      map: MAP.id,
      mode: this.opts?.mode ?? "tdm",
      room: this.opts?.room ?? "",
      online: !!this.net,
      pos: me ? [me.x, me.y, me.z] : null,
      eye: [c.x, c.y, c.z],
      yaw: this.yaw,
      pitch: this.pitch,
      alive: !!me?.alive,
      weapon: me?.weapon ?? "",
    }).then((copied) => this.banner("BUG REPORT SAVED", 1.6, copied ? "COPIED TO CLIPBOARD · F8" : "SEE CONSOLE · F8"));
  }

  // -------------------------------------------------------------- banana frag
  /** 0 idle, 1 winding up, 2 throwing, 3 recovering (mirrors viewmodel.ts). */
  nadePhase: NadePhase = 0;
  nadePhaseT = 0;
  /** G (or MMB) is physically down. */
  nadeHeld = false;
  /** TRUE once the current cook has actually been seen burning — the cook-off
   *  signal. The sim zeroes `cook` exactly when the frag is spent (`handBoom`
   *  detonation or `dropCooked` on death), so "we were cooking and now we are
   *  not" stands the cycle down. A belt-count comparison breaks as soon as the
   *  belt can hold two and a streak grant lands mid-cook: the sim spends
   *  exactly one frag, so the count can still equal the start value and the
   *  cycle would stay live and throw the second frag. */
  private nadeSawCook = false;
  /** The release command for this cycle has already been sent. */
  nadeSent = false;
  /** Predicted arc, refilled every fixed tick while readying. Never realloced. */
  nadeArc = new Float32Array(90 * 3);
  nadeArcN = 0;
  nadeRest = { x: 0, y: 0, z: 0 };
  nadeSurfaceY = 0;
  private nadeBody: NadeBody = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false, asleep: false };
  private handV = new THREE.Vector3();
  /** Grenade views keyed by sim id, so snapshots can drive them by identity. */
  private nadeSeen = new Set<number>();

  nadeDown(): void {
    this.nadeHeld = true;
    if (this.nadePhase !== 0) return;
    // Nothing leaves a paw before the match is live. Silently, not with the
    // empty-mag click: the frag is not missing, the match has not started.
    if (!this.matchLive()) return;
    const me = this.me();
    if (!me || !me.alive || (me.nades ?? 0) <= 0) {
      if (me?.alive) this.audio.play("nade-empty", { vol: 0.3 });
      return;
    }
    this.nadePhase = 1;
    this.nadePhaseT = 0;
    this.nadeSent = false;
    this.lastCookTick = 0;
    this.nadeSawCook = false;
    this.audio.play("nade-pin", { vol: 0.42 });
    this.hideNadeHint();
  }

  nadeUp(): void {
    this.nadeHeld = false;
  }

  /**
   * Advance the throw cycle one tick and report whether THIS tick is the release
   * — the frag leaves the paw at the top of the whip, not on key-up, so the
   * viewmodel hand and the world grenade change hands on the same frame.
   *
   * COOKING (weapons stream): phase 1 is the pin pulled and the fuse burning
   * (the sim cooks it from the first nadeHold command). There is no auto-throw:
   * hold it and it goes off in your hand — the sim decides that, and this cycle
   * simply stands down when the frag is gone.
   */
  private tickNadePhase(): boolean {
    let release = false;
    if (this.nadePhase === 1) {
      this.nadePhaseT += TICK_DT;
      // The cook has really started once the sim reports it burning — this
      // latches, so a streak grant landing mid-cook cannot confuse the signal.
      if (this.localCook() > 0) this.nadeSawCook = true;
      const ready = this.nadePhaseT >= NADE_READY_T;
      const me = this.me();
      const dead = !me || !me.alive;
      // Cooked off in the paw: we were cooking and now we are not. The sim
      // zeroes `cook` in exactly three places — `handBoom` (detonates in the
      // hand, always lethal), `dropCooked` (death with the pin out) and
      // `throwNade` (a throw the sim honoured). The first two kill the body, so
      // the `dead` branch would also catch them; the throw is safe because the
      // client is in phase 2 by then (release at NADE_RELEASE_AT) and this check
      // only runs in phase 1. A belt-count comparison would break as soon as the
      // belt can hold two and a grant lands mid-cook, so the count is
      // deliberately not consulted here.
      const cookedOff = this.nadePhaseT > 0.1 && this.nadeSawCook && this.localCook() <= 0;
      if (dead || cookedOff) {
        this.nadePhase = 0;
        this.nadePhaseT = 0;
        this.nadeSawCook = false;
      } else if (!this.nadeHeld && ready) {
        this.nadePhase = 2;
        this.nadePhaseT = 0;
      }
      // The fuse is audible in the hand: a tick every half second of cook.
      const cook = this.localCook();
      if (this.nadePhase === 1 && cook > 0 && Math.floor(cook / 0.5) !== this.lastCookTick) {
        this.lastCookTick = Math.floor(cook / 0.5);
        this.audio.play("nade-tick", { vol: NADE_FUSE - cook < 1 ? 0.34 : 0.22, rate: NADE_FUSE - cook < 1 ? 1.25 : 1 });
      }
    } else if (this.nadePhase === 2) {
      this.nadePhaseT += TICK_DT;
      if (!this.nadeSent && this.nadePhaseT >= NADE_RELEASE_AT) {
        this.nadeSent = true;
        release = true;
      }
      if (this.nadePhaseT >= NADE_THROW_T) {
        this.nadePhase = 3;
        this.nadePhaseT = 0;
      }
    } else if (this.nadePhase === 3) {
      this.nadePhaseT += TICK_DT;
      if (this.nadePhaseT >= NADE_RECOVER_T) {
        this.nadePhase = 0;
        this.nadePhaseT = 0;
      }
    }
    this.vm.setNade(this.nadePhase, this.nadePhaseT);
    return release;
  }

  /**
   * Roll the throw forward with the sim's own kernel. Not an approximation of
   * the grenade path — literally the path, computed by predictNade() in
   * shared/sim.ts at the sim tick rate against the sim's colliders.
   */
  private computeNadeArc(): void {
    const me = this.me();
    if (!me) {
      this.nadeArcN = 0;
      return;
    }
    const eye = me.slide > 0 ? SLIDE_EYE : me.crouch ? CROUCH_EYE : EYE;
    const d = aimDir(this.yaw + this.recY, this.pitch + this.recP);
    const s = nadeSpawn(me.x, me.y + eye, me.z, d.dx, d.dy, d.dz);
    const b = this.nadeBody;
    b.x = s.x;
    b.y = s.y;
    b.z = s.z;
    b.vx = d.dx * NADE_SPEED + me.vx * NADE_INHERIT;
    b.vy = d.dy * NADE_SPEED + NADE_UP;
    b.vz = d.dz * NADE_SPEED + me.vz * NADE_INHERIT;
    b.grounded = false;
    b.asleep = false;
    // A COOKED frag's marker is where it goes off: the fuse it would leave with
    // if released NOW. Exactly: the wind-up still owed, then the transition tick,
    // the whip's ceil(RELEASE_AT/dt) ticks and the release tick itself all cook.
    const owed = Math.max(0, NADE_READY_T - this.nadePhaseT);
    const whip = (Math.ceil(NADE_RELEASE_AT / TICK_DT - 1e-9) + 1) * TICK_DT;
    const fuse = Math.max(TICK_DT, NADE_FUSE - this.localCook() - owed - whip);
    this.nadeArcN = predictNade(b, this.nadeArc, this.nadeRest, 2, fuse);
    this.nadeSurfaceY = this.surfaceUnder(this.nadeRest.x, this.nadeRest.y, this.nadeRest.z);
  }

  /** Height of whatever the frag is sitting on (floor, roof, crate lid). */
  surfaceUnder(x: number, y: number, z: number): number {
    const tr = traceWorld(x, y + 0.02, z, 0, -1, 0, 4);
    return tr.t < 4 ? y + 0.02 - tr.t : Math.max(0, y - NADE_R);
  }

  /** Reconcile the drawn frags with the authoritative list. */
  private syncNades(list: NadeSnap[]): void {
    const fx = this.nadeFx;
    if (!fx) return;
    this.nadeSeen.clear();
    for (const n of list) {
      this.nadeSeen.add(n.id);
      const v = fx.get(n.id) ?? fx.spawn(n.id, n.x, n.y, n.z, null);
      fx.set(v, n.x, n.y, n.z, n.spin, n.st);
    }
    // A frag that vanished without a boom (owner left, snapshot gap): drop it.
    for (let i = fx.live.length - 1; i >= 0; i--) {
      const v = fx.live[i]!;
      if (!this.nadeSeen.has(v.id) && v.age > 0.2) fx.kill(v.id);
    }
  }

  /** Server play: interpolate frag positions on the same clock as the players. */
  private interpNades(): NadeSnap[] {
    if (this.session) return this.session.nadeSnap() ?? EMPTY_NADES;
    if (this.snaps.length < 2) return this.snaps[0]?.nades ?? EMPTY_NADES;
    const { a, b, t } = this.interpPair(performance.now() - this.svOffset - this.interpDelay);
    // The common case is a yard with no frags in it: cost nothing there.
    if (!b.nades?.length) return EMPTY_NADES;
    const out: NadeSnap[] = [];
    for (const nb of b.nades) {
      const na = (a.nades ?? EMPTY_NADES).find((x) => x.id === nb.id);
      if (!na) {
        out.push(nb);
        continue;
      }
      out.push({
        id: nb.id,
        src: nb.src,
        x: na.x + (nb.x - na.x) * t,
        y: na.y + (nb.y - na.y) * t,
        z: na.z + (nb.z - na.z) * t,
        spin: na.spin + (nb.spin - na.spin) * t,
        // State is a fact about the body, not a quantity: take the older of the
        // two samples, which is the one the interpolated position belongs to.
        st: na.st,
      });
    }
    return out;
  }

  loop = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    // Second entry = the first frame has been drawn AND presented; that is the
    // moment the boot card can come down over a real picture.
    if (this.firstFrameAt === 0) {
      if (this.loopEntries++ > 0) {
        this.firstFrameAt = performance.now();
        bootStage("READY");
        this.onFirstFrame?.();
      }
    }
    // The frame is proof this thread is alive; the 1 s keepalive timer is not
    // (see keepAlive). A page whose first frames are seconds apart under a
    // software rasteriser now holds its seat off its own render loop.
    if (!this.session) this.keepAlive();
    this.clock.update();
    const elapsed = this.clock.getDelta();
    const dt = Math.min(this.session ? 0.05 : 0.125, elapsed);
    // GAMEPAD: sticks + buttons, once per frame (look needs frame dt).
    try {
      this.pollGamepad(dt);
    } catch {
      /* pad must never break the frame */
    }
    this.stepFixed();
    const beforeDraw = performance.now();
    this.draw(dt);
    const renderMs = performance.now() - beforeDraw;
    if (this.diagnostics && this.matchLive() && !document.hidden) {
      this.diagnostics.frameMs.add(elapsed * 1000);
      this.diagnostics.drawCpuMs.add(renderMs);
    }
    this.adaptQuality(Math.max(renderMs, elapsed > 0.025 ? Math.min(100, elapsed * 1000) : 0));
  };

  /**
   * Advance the fixed step to NOW, from whichever driver gets there first — the
   * frame or the input clock (stepTimer). Capped exactly as the frame step
   * always was, so a suspended tab cannot bank a burst of commands.
   */
  private stepFixed(): void {
    const t = performance.now();
    const elapsed = this.stepAt ? (t - this.stepAt) / 1000 : 0;
    this.stepAt = t;
    this.acc += Math.min(this.session ? 0.05 : 0.125, elapsed);
    while (this.acc >= TICK_DT) {
      this.fixed();
      this.acc -= TICK_DT;
    }
  }

  /**
   * END-OF-MATCH WATCHDOG — last resort behind the retransmit (server), the
   * duplicate-tick end replay (freshSnap) and the per-event catch
   * (handleEvents). If an end-of-match signal was seen on the wire but
   * finish() still has not run — and no snapshot has arrived for seconds
   * (4 s) — enter the finish path instead of waiting for the
   * rollover. Requires BOTH a stall AND end evidence, so mid-match jitter
   * (snaps flowing, or no end signal seen) can never trip it; and a fresh
   * match clears the evidence on match/live while flowing snaps hold the
   * stall gate shut. Runs on the fixed tick (foreground); a throttled tab
   * relies on the retransmit instead.
   */
  private endWatchdog(): void {
    if (this.ended || this.session || !this.net || this.testMode) return;
    if (!this.endEvidenceAt) return;
    if (!this.matchLive()) return;
    // No snapshot for seconds while the end was seen: the match is over and
    // the wire went quiet — finish on the newest scores, do not wait.
    if (performance.now() - this.lastSnapArr < 4000) return;
    try { this.finish(this.netScore0, this.netScore1); } catch { /* never throw out of the frame loop */ }
  }

  fixed(): void {
    BruiserActor.nowMs = this.nowMs();
    // Online only (offline ends off session.over below); spectators included.
    if (!this.session) this.endWatchdog();
    // SPECTATING: THIS CLIENT DRIVES NOTHING. Not one InputCmd is built, stamped,
    // queued, sent or locally predicted for a body it is not playing — which is
    // the difference between a spectator that costs the server nothing and one
    // that costs it a seat's worth of drained commands every tick. The seat stays
    // alive on the 1 s keepalive ping (keepAlive), exactly as it did while the
    // page was still loading. Movement audio follows the displayed poses in
    // draw(), including the spectator's camera and its current listener.
    if (this.spectateCam) {
      // OFFLINE, THE SIM IS THIS CLIENT. A dead-for-the-round body watching its
      // teammates in a local bot match still has to let the round play out —
      // no input is applied, but the yard keeps stepping, the bots keep
      // fighting and the round ends and respawns it. A bench seat never has a
      // session, so online behaviour is unchanged.
      if (this.session) {
        this.session.step(TICK_DT);
        const ev = this.session.drainEvents();
        this.lastEv.push(...ev);
        this.handleEvents(ev);
        this.syncFromSession();
        if (this.session.over && !this.ended) this.finish(this.session.score0, this.session.score1);
      }
      return;
    }
    const me = this.session?.players.get(this.you);
    // THE LEANING MUZZLE (Q/E): the posted origin is the eye the player is
    // aiming through — the body eye shifted 0.30 m sideways when leaned
    // (leanEye, shared/sim.ts: the same wall-clamped point the server traces
    // from), so the tracer, the predicted hitmarker and the authoritative ray
    // are one ray. Discrete keys, not the eased camera shift: the server replays
    // the discrete lean, and easing here would diverge from it mid-transition.
    const cmdYaw = this.yaw + this.recY + this.feel.swayY;
    const cmdPitch = this.pitch + this.recP + this.feel.swayP;
    const cmdLean = (this.keys.leanR ? 1 : 0) - (this.keys.leanL ? 1 : 0);
    const baseOrigin = me
      ? { x: me.x, y: this.session!.eyeY(me), z: me.z }
      : { x: this.ghost?.x ?? 0, y: (this.ghost?.y ?? 0) + (this.ghost?.slide ? SLIDE_EYE : this.ghost?.crouch ? CROUCH_EYE : EYE), z: this.ghost?.z ?? 0 };
    const leanOrg = leanEye(baseOrigin.x, baseOrigin.y, baseOrigin.z, cmdYaw, cmdLean);
    const origin = { x: leanOrg.x, y: baseOrigin.y, z: leanOrg.z };

    // weapons stream: the gun in hand, and the one the player is asking for.
    const body = this.heldBody();
    if (body?.alive && !this.wasAlive) {
      // A fresh life opens on the primary: forget the last life's wish.
      this.wantWeapon = "";
      this.feel.reset();
    }
    this.wasAlive = !!body?.alive;
    const wpn = body?.weapon ?? PRIMARY_WEAPON_ID;
    const def = WEAPON_BY_ID[wpn];
    const now = this.svNow();
    // The trigger is sent as HELD for every gun: semi/bolt discipline (one round
    // per pull, presses inside the interval wait for it) is the sim's job on
    // both sides of the wire (SimPlayer.armed), not a client-side pulse.
    const fire = this.keys.fire;
    // The frag cycle runs on the fixed tick so the release lands on an exact
    // sim tick — the marker was computed from this same aim last tick.
    const throwNow = this.tickNadePhase();
    // weapons stream: scope sway + hold breath (Shift) — AIM, so it advances on
    // the fixed tick like the recoil springback does.
    this.feel.tickScope(TICK_DT, this.whud.scoped, this.keys.sprint, this.nowMs() / 1000);
    // THE CLIENT HALF OF THE INPUT GATE. The sim refuses these commands anyway
    // (applyInput drops everything but the aim while the phase is not "live"),
    // so this is not what makes the rule true — it is what makes the rule LOOK
    // true: zeroing the keys here means the viewmodel never plays a fire or a
    // reload the sim discarded, the local shot audio and predicted hitmarker
    // never fire, and no footstep cadence advances under a body that is not
    // moving. Look and ADS are deliberately untouched: aiming stays free through
    // the whole countdown so a player settles their crosshair before "GO".
    // Corpse input must not become queued movement/fire for the next life.
    // feel stream: + a match that is over takes no input (the final killcam / endcard must not fire predicted shots).
    const gated = !this.matchLive() || this.ended || (this.session ? me?.alive === false : this.ghost?.alive === false);
    const cmd = localCmd(
      ++this.seq,
      TICK_DT,
      gated
        ? {
            ...this.keys,
            f: false,
            b: false,
            l: false,
            r: false,
            jump: false,
            crouch: false,
            sprint: false,
            tac: false,
            fire: false,
            reload: false,
            melee: false,
            nade: false,
            nadeHold: false,
          }
        : {
            ...this.keys,
            fire: fire && this.nadePhase === 0,
            tac: this.keys.tac,
            l: this.keys.r,
            r: this.keys.l,
            nade: throwNow,
            // The pin stays out (the fuse keeps cooking) until the frag actually
            // leaves the paw at the top of the whip.
            nadeHold: this.nadePhase === 1 || (this.nadePhase === 2 && !this.nadeSent && !throwNow),
          },
      cmdYaw,
      cmdPitch,
      gated ? wpn : this.wantedWeapon(body),
      origin,
      now,
      this.session || this.renderT <= 0 ? undefined : this.renderT,
    );
    // GAMEPAD analog move: the stick (−1..1) beats the WASD step when louder.
    // Keyboard convention is ax>0 = LEFT (see the l/r swap above), so the
    // stick's right-positive X is negated; forward is +Z on both.
    if (!gated) {
      const padMag = Math.hypot(this.padMoveX, this.padMoveZ);
      if (padMag > 0.01) {
        const keyMag = Math.hypot(cmd.ax, cmd.az);
        if (padMag >= keyMag) {
          const l = padMag > 1 ? padMag : 1;
          cmd.ax = -this.padMoveX / l;
          cmd.az = this.padMoveZ / l;
        }
      }
    }
    if (cmd.melee) this.audio.knife(); // weapons stream: knife swing (the engine mirrors the melee cooldown)
    if (!this.session) {
      this.pending.push(cmd);
      if (this.pending.length > 128) this.pending.shift();
    }

    if (this.session) {
      const p = this.session.players.get(this.you);
      if (p) this.session.applyInput(p, cmd, false);
      this.session.step(TICK_DT);
      const ev = this.session.drainEvents();
      this.lastEv.push(...ev);
      this.handleEvents(ev);
      this.syncFromSession();
      if (this.session.over && !this.ended) this.finish(this.session.score0, this.session.score1);
    } else if (this.net?.readyState === 1) {
      this.net.send(JSON.stringify({ t: "in", cmd }));
      this.udp?.sendInput(cmd);
      const fired = this.predict(cmd);
      if (fired) {
        // The spread-applied ray predictMovement fired down — the SAME ray the
        // server traces (deterministic spread, shared/sim.ts fireDir).
        const g = this.ghost as unknown as { lastShotDx: number; lastShotDy: number; lastShotDz: number; weapon: string } | null;
        const sdx = g?.lastShotDx ?? cmd.dx;
        const sdy = g?.lastShotDy ?? cmd.dy;
        const sdz = g?.lastShotDz ?? cmd.dz;
        const firedW = g?.weapon ?? wpn;
        this.predictHit(cmd, sdx, sdy, sdz);
        const me = this.ghost ?? this.me();
        if (me) this.audio.gun(firedW, me.x, me.y + EYE, me.z, true);
        // THE TRIGGER PULL IS THE SHOT. Flash, kick, tracer and recoil land on
        // this tick instead of one round trip later when the server echoes it:
        // the server fires down cmd's own aim, so nothing here can disagree with
        // it. The echo is consumed by predShots in handleEvents.
        this.predShots.push(performance.now());
        this.localShotFx(firedW, cmd.ox, cmd.oy, cmd.oz, sdx, sdy, sdz);
      }
    }

    // Refresh the landing marker while the nana is in the paw (and through the
    // wind-up of the throw, so the arc does not blink out before it flies).
    if (this.nadePhase === 1) this.computeNadeArc();

    // The recoil-recovery springback is AIM, not a visual: it is summed into
    // every InputCmd above and therefore decides where bullets go, so it decays
    // on the fixed 64 Hz tick and never on the render frame — frame rate must
    // not change your recoil pattern. Decaying it HERE, after this tick's shot
    // has already been added, means the value the camera renders in draw() is
    // the exact value the next command fires with.
    // w.recoilRec is the rate: 5 = slow sniper settle, 17 = snappy SMG. It is
    // read off the weapon the player is actually HOLDING, not off a hard-coded
    // PRIMARY_WEAPON: with the old constant every weapon in weapons.ts settled
    // at the Bunch Cylinder's 14/s and the 5–17 spread was unreachable
    // (qa/out/rangecard.json, "WeaponDef.recoilRec is wired for m4a1 only").
    const held = WEAPON_BY_ID[this.heldBody()?.weapon ?? wpn] ?? def;
    const recK = Math.exp(-(held?.recoilRec ?? 14) * TICK_DT);
    this.recY *= recK;
    this.recP *= recK;

    this.keys.jump = false;
    this.keys.reload = false;
    this.keys.melee = false;
  }

  private footstepCadence = new FootstepCadence();
  private audioForward = new THREE.Vector3();

  /** One cue stream from the poses being displayed, including our predicted body. */
  private updateFootsteps(list: PlayerSnap[], dt: number): void {
    if (!this.matchLive() || document.hidden) {
      this.footstepCadence.clear();
      return;
    }
    const seen = new Set<string>();
    const me = this.me();
    for (const p of list) {
      seen.add(p.id);
      const grounded = p.y <= groundHeight(p.x, p.z, MAP_SOLIDS, p.y) + 0.08;
      const cue = this.footstepCadence.advance(p.id, {
        x: p.x, y: p.y, z: p.z, alive: p.alive, grounded,
        moving: Math.hypot(p.vx, p.vz) >= 0.6, sprint: p.sprint, crouch: p.crouch, slide: p.slide,
      }, dt);
      if (!cue) continue;
      const local = p.id === this.you && !this.spectateCam && this.killcamT <= 0;
      const style: FootstepStyle = {
        sprint: p.sprint, crouch: p.crouch, land: cue === "land",
        ally: !local && this.opts?.mode !== "ffa" && !!me && p.team === me.team,
      };
      const x = this.audio.listenerX, y = this.audio.listenerY, z = this.audio.listenerZ;
      const dx = p.x - x, dy = p.y + 0.6 - y, dz = p.z - z;
      const distance = Math.hypot(dx, dy, dz);
      if (!local && distance >= footstepRange(style)) continue;
      // Test only audible cues. A body-height ray avoids mistaking its own floor
      // for a wall while retaining roofs/ceilings between different elevations.
      if (!local && distance > 0.3) {
        const obstruction = traceWorld(x, y, z, dx / distance, dy / distance, dz / distance, distance - 0.15);
        style.occluded = obstruction.t < distance - 0.15;
      }
      this.audio.footstep({
        ...style, surface: this.footSurfaceAt(p.x, p.z, p.y), src: p.id,
        ...(local ? {} : { x: p.x, y: p.y + 0.12, z: p.z }),
      });
    }
    this.footstepCadence.retain(seen);
  }

  /**
   * The footstep voice under a body (client/src/foot-surface.ts): the solid it
   * stands on by material; on the bare floor, each map's own ground — Shipment's
   * earth (or a walk-through container's steel floor), dust2's sand, Nuketown's
   * street asphalt or a house's floorboards.
   */
  footSurfaceAt(x: number, z: number, y: number): FootSurface {
    const s = footSurface(MAP.id, x, y, z, () => {
      if (MAP.id === "dust2") return "sand";
      if (MAP.id === "nuketown") return nuketownHardFloor(x, y, z) ? "wood" : "hard";
      return this.isMetalAt(x, z, y) ? "metal" : "dirt";
    });
    // Nuketown's ground floors stand on lawn-height slabs: indoors, that is floorboards.
    return MAP.id === "nuketown" && s === "grass" && nuketownHardFloor(x, y, z) ? "wood" : s;
  }

  /**
   * Surface under a point: the yard is packed earth, the containers are steel.
   * Standing ON a climbable solid (a lid) is metal; so is standing INSIDE one
   * of the walk-through containers, whose floor is at ground level.
   */
  isMetalAt(x: number, z: number, y = 0): boolean {
    // Dust2 elevations are stone, not Shipment container lids.
    if (MAP.id === "dust2") return false;
    // nuketown: hard surfaces (decks, stairs, house floors, porch roof) take the
    // hard step; lawn, street and yard dirt the soft one (client/src/nuketown-surface.ts)
    if (MAP.id === "nuketown") return nuketownHardFloor(x, y, z);
    if (groundHeight(x, z) > MAP.floorY + 0.05) return true;
    for (const c of MAP.visualContainers) {
      if (!c.open) continue;
      const dx = x - c.x;
      const dz = z - c.z;
      const cs = Math.cos(c.yaw);
      const sn = Math.sin(c.yaw);
      const lx = dx * cs + dz * sn;
      const lz = -dx * sn + dz * cs;
      if (Math.abs(lx) <= c.sx * 0.5 && Math.abs(lz) <= c.sz * 0.5) return true;
    }
    return false;
  }

  /**
   * Command seqs whose predicted hitmarker has already been shown. The server's
   * `hit` event now carries the landing command's seq, so confirmation dedupe
   * is exact per bullet — the 180 ms wall-clock window stays only as the
   * fallback for events without one (blasts, old servers).
   */
  private predMarked = new Set<number>();

  /** Shots played on the trigger pull, awaiting the server's echo (ms stamps). */
  private predShots: number[] = [];

  /** Online trigger pull: everything the shooter sees, on the tick it happens. */
  private localShotFx(weapon: string, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    this.spawnTracer(ox, oy, oz, dx, dy, dz, this.you, false, weapon); // weapons stream: + weapon
    this.applyLocalRecoil(weapon);
    rumbleShot(); // gamepad stream: trigger pull echo (no-op without pad/vibration)
  }

  /**
   * CoD recoil model, both halves. The per-shot kick is split between two
   * channels:
   *   pitch/yaw  — the permanent climb you must compensate yourself
   *   recP/recY  — the springback, decayed at w.recoilRec on the fixed tick
   * plus a render-only punch (punchP/punchY) that sells the impulse without
   * moving the aim.
   */
  private applyLocalRecoil(weapon: string): void {
    this.vm.fire();
    const w = WEAPON_BY_ID[weapon];
    if (!w) return;
    // weapons stream: the per-weapon PATTERN (client/src/weapons/feel.ts, KR's
    // localFire), split between the permanent climb and the springback.
    const b = this.heldBody();
    const k = this.feel.kick(w, b?.ads ?? 0, !!b?.crouch, this.nowMs());
    this.pitch = Math.max(-1.45, this.pitch + k.pitch);
    this.recP += k.recP;
    this.yaw += k.yaw;
    this.recY += k.recY;
    this.lastShot = 0;
  }

  predictHit(cmd: InputCmd, sdx = cmd.dx, sdy = cmd.dy, sdz = cmd.dz): void {
    // Client-side hit prediction, run through the SERVER'S OWN hit test
    // (rayPlayer) against the very poses this frame drew — the same poses the
    // server will rewind to, because cmd.rt stamps the timestamp they were
    // interpolated at. What is left over is arithmetic, not policy, so a
    // hitmarker here and a hit event there now stand or fall together.
    //
    // IT ITERATES `drawn`, NOT `players`, AND THAT DISTINCTION IS THE WHOLE
    // CONTRACT. `players` is the ROSTER, and applyRoster refreshes it from the
    // RAW newest snapshot on every snapshot arrival — a pose INTERP_MS = 80 ms
    // ahead of the one this frame drew and the server rewinds to, which at RUN
    // 4.35 m/s is 0.35 m of lateral error against a 0.32 m capsule radius.
    // loop() drains its fixed ticks BEFORE draw(), so any trigger pull in a rAF
    // turn that a snapshot landed in tested the newer body: the prediction
    // coin-tossed between two poses (matched the drawn one on 81% of shots, the
    // raw one on 50%, one or the other on 100%) and the hitmarker was silently
    // dropped on ~1 shot in 5 — 98 of 503 server-awarded hits over two runs drew
    // no marker at all, so the feedback arrived with the server's snapshot
    // instead of on the trigger pull. `drawn` is the list draw() last handed to
    // the renderer, so this can only ever test what the player was looking at.
    //
    // Three ways this used to disagree with the server and draw a marker for a
    // shot that was never awarded: it tested an infinite cylinder with 0.1 m of
    // vertical slop instead of the server's box (edges and crown), it marked
    // the FIRST body along the ray instead of the NEAREST, and it never checked
    // spawn protection — every shot into a just-respawned enemy drew a
    // hitmarker the server always discarded.
    // Through walls the same way the sim's hitscan goes (shared/penetration.ts).
    const wall = bulletPath(cmd.ox, cmd.oy, cmd.oz, sdx, sdy, sdz, 180, WEAPON_BY_ID[cmd.weapon], MAP.id);
    const me = this.me();
    let best: PlayerSnap | null = null;
    let bestT = wall.t;
    for (const p of this.drawn) {
      if (p.id === this.you || !p.alive) continue;
      if (me && p.team === me.team && this.opts.mode !== "ffa") continue;
      const t = rayPlayer(cmd.ox, cmd.oy, cmd.oz, sdx, sdy, sdz, p);
      if (t < bestT) {
        bestT = t;
        best = p;
      }
    }
    if (!best || best.protect > 0) return;
    this.lastPredMark = performance.now();
    this.predMarked.add(cmd.seq);
    const head = isHeadshot(cmd.oy + sdy * bestT, best);
    this.hitmarker(head, false, true);
    this.audio.hitmarker(head, false);
  }

  predict(cmd: InputCmd): boolean {
    if (!this.ghost) {
      const p = this.me();
      if (!p) return false;
      this.ghost = this.ghostFrom(p);
    }
    return predictMovement(this.ghost as never, cmd, TICK_DT, this.matchLive());
  }

  syncFromSession(): void {
    if (!this.session) return;
    this.players.clear();
    for (const p of this.session.snap()) this.players.set(p.id, p);
  }

  /**
   * THE ROSTER IS SNAPSHOT-FED, NOT FRAME-FED.
   *
   * `players` used to be rebuilt in ONE place — draw() — from the interpolated
   * list, which quietly made every consumer of it frame-rate-coupled: the
   * scoreboard, the killfeed, the minimap and `me()` all read a roster that was
   * as old as the last rendered frame. At a healthy 143 fps that is invisible;
   * on a machine that is drawing at 1-2 fps (two SwiftShader pages sharing a
   * box, which is exactly what qa/lobby-e2e.mjs stages) it means a player who
   * joined a second ago is absent from a roster whose own newest snapshot
   * already contains them. Measured: the gate failed 4 runs of 4 that way, page
   * A reporting itself + 7 bots while its newest snapshot held both humans, and
   * page B reporting players.size 0 with a live socket and `you` already set.
   *
   * Called on every snapshot arrival, so identity and membership track the wire.
   * draw() still overwrites POSITIONS from interpPlayers() — those must stay
   * interpolated, that is the whole hit-registration contract — but it no longer
   * owns who exists.
   */
  private applyRoster(roster: PlayerSnap[]): void {
    // The local player keeps its PREDICTED pose, exactly as interpPlayers gives
    // it: `me()` has always meant "where I think I am", and swapping it for the
    // server's acknowledged pose on every snapshot arrival would make the local
    // player visibly rubber-band one round trip whenever anything read it
    // between two frames. Membership is what this function is for; the local
    // pose is not its business.
    for (const p of roster) this.players.set(p.id, p.id === this.you && this.ghost ? { ...p, ...this.ghost } : p);
    // After that loop `players` is a superset of `roster`, so equal sizes IS set
    // equality — no allocation on the common frame where nobody joined or left.
    if (this.players.size !== roster.length) {
      const live = new Set(roster.map((p) => p.id));
      for (const id of [...this.players.keys()]) if (!live.has(id)) this.players.delete(id);
    }
  }

  /**
   * THE TWO SNAPSHOTS THIS FRAME IS DRAWN FROM, and where between them it sits.
   *
   * Always an ADJACENT pair — one 32 Hz step, ~31 ms — which is the whole point.
   * The search used to leave `a` at the OLDEST snapshot and `b` at the NEWEST
   * whenever no pair bracketed renderAt, i.e. every time the buffer ran a frame
   * short or the server clock stepped. That is a 24-deep buffer, so the fallback
   * span was up to 750 ms: with renderAt past the newest the world was drawn
   * from a three-quarter-second-old ROSTER, and with renderAt before the oldest
   * every remote body was drawn three quarters of a second in the past — and
   * stamped as such on every shot, past the server's own 350 ms rewind cap, so
   * the shots could not land. Falling back to the nearest adjacent PAIR keeps
   * the worst case at one snapshot of staleness.
   *
   * t is clamped, so past either end the frame shows the nearest pose the client
   * actually holds — and renderT reports that, rather than a time it never drew.
   */
  private interpPair(renderAt: number): { a: Snapshot; b: Snapshot; t: number } {
    let i = 0;
    for (let k = 0; k < this.snaps.length - 1; k++) if (this.snaps[k]!.t <= renderAt) i = k;
    const a = this.snaps[i]!;
    const b = this.snaps[i + 1]!;
    return { a, b, t: Math.max(0, Math.min(1, (renderAt - a.t) / Math.max(1, b.t - a.t))) };
  }

  interpPlayers(): PlayerSnap[] {
    if (this.session) {
      this.renderT = this.session.time;
      return [...this.players.values()];
    }
    if (this.snaps.length < 2) {
      if (this.snaps[0]) this.renderT = this.snaps[0].t / 1000;
      return this.snaps[0]?.players ?? [];
    }
    // Interpolate on the server clock, not packet arrival time.
    const now = performance.now();
    const renderAt = this.renderTimeline.advance(now, now - this.svOffset - this.interpDelay);
    const { a, b, t } = this.interpPair(renderAt);
    // The timestamp of the world this frame is ACTUALLY showing, which is not
    // always renderAt: t is clamped, so a starved or over-full snapshot buffer
    // draws the nearest pose it has instead. Every fire command made against
    // this frame carries this number (InputCmd.rt) and the server rewinds to
    // it, so the shot is resolved against the bodies the player saw — buffer
    // hiccups included, rather than a formula that assumes there were none.
    this.renderT = (a.t + (b.t - a.t) * t) / 1000;
    const out: PlayerSnap[] = [];
    // Rostered off the NEWER frame. Iterating the older one dropped anyone who
    // had joined or respawned since it was taken — invisible until the buffer
    // rolled past them — and kept drawing anyone who had left.
    for (const pb of b.players) {
      const pa = a.players.find((x) => x.id === pb.id) ?? pb;
      if (pb.id === this.you) {
        const live = this.ghost ?? pb;
        out.push({ ...pb, ...live });
        continue;
      }
      out.push({
        ...pb,
        x: pa.x + (pb.x - pa.x) * t,
        y: pa.y + (pb.y - pa.y) * t,
        z: pa.z + (pb.z - pa.z) * t,
        yaw: pa.yaw + angWrap(pb.yaw - pa.yaw) * t,
        pitch: pa.pitch + (pb.pitch - pa.pitch) * t,
      });
    }
    return out;
  }

  handleEvents(ev: NetEvent[], tick: number = this.snapTick): void {
    // END-OF-MATCH ROBUSTNESS: each event runs in its own try/catch, so one
    // faulty event in the final flush (feed, accolades, announcer, tracer)
    // can never throw past the match/end event — and finish() — behind it.
    // `tick` is the snapshot tick carrying these events: the match/end branch
    // below drops stale ones against it (see the rollover point, liveTick).
    for (const e of ev) {
      try {
      if (e.t === "chat") this.chatLine(e.name, e.text);
      // feel stream R2: map modules (Nuketown's mannequin heads, breakable glass) hear every server shot and blast
      if ((e.t === "shot" || e.t === "boom") && this.worldEvents.length) for (const f of this.worldEvents) f(e);
      if (e.t === "shot") {
        if (e.src === this.you) this.combat.shots++; // combat stats (accuracy)
        // Minimap gunfire ping: the shot is HEARD, so the shooter is placed on
        // the map for 1.2 s (fading) even when you never got eyes on them.
        this.mapFired.set(e.src, { t: this.nowMs() / 1000, x: e.ox, z: e.oz });
        this.stings.noteShot(this.nowMs() / 1000); // feel stream: medal stings duck under gunfire
        this.extras.noteShot(this.nowMs() / 1000);
        // Onto the killcam tape. Online, the event rides the wire ~INTERP_MS
        // ahead of the drawn world, so it is stamped forward onto the frame
        // where the bodies will visibly fire; offline the clocks are one.
        const recShot: TapeShot = {
          t: this.renderT * 1000 + (this.session ? 0 : INTERP_MS),
          ox: e.ox,
          oy: e.oy,
          oz: e.oz,
          dx: e.dx,
          dy: e.dy,
          dz: e.dz,
          src: e.src,
          weapon: e.weapon,
        };
        this.recShots.push(recShot);
        this.fkTape.shot(recShot); // feel stream: open final-killcam clips keep their shots
        const local = e.src === this.you;
        // Online, our own shots were already played on the trigger pull
        // (localShotFx). Consume the oldest prediction; anything older than a
        // second was refused by the server and is dropped so the queue can
        // never stall a later echo.
        if (local && this.net) {
          const nowMs = performance.now();
          while (this.predShots.length && nowMs - this.predShots[0]! > 1000) this.predShots.shift();
          if (this.predShots.length) {
            this.predShots.shift();
            continue;
          }
        }
        if (local) this.spawnTracer(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, e.src, false, e.weapon); // weapons stream: + weapon
        else this.pendingShots.push(e);
        if (!local) this.audio.flyby(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, e.src); // weapons stream: a round whizzing past your head
        // e.src is the SHOOTER: the audio rig scopes its same-event cooldown per
        // emitter, so ten bots firing on one tick are ten voices (a firefight
        // that sounds like ten guns) instead of one collapsed transient.
        if (!(local && this.net)) this.audio.gun(e.weapon, e.ox, e.oy, e.oz, local, e.src);
        // weapons stream: the 3P flash cards, the shared flash3P light and the brass
        // leave the freshly POSED muzzle in spawnTracer (draw pass), not this stale one.
        if (!local) this.actors.get(e.src)?.onShot();
        if (local) this.applyLocalRecoil(e.weapon);
      }
      // ---- banana frag: throw, bounce, burst
      if (e.t === "nade") {
        if (e.src === this.you) this.announcer.kong("frag"); // "Catch banana!"
        this.accolades.nadeThrown(e.id, this.nowMs() / 1000); // feel stream: COOKED medal
        // Deferred to the draw pass for the same reason remote tracers are: the
        // hand this frag has to leave has not been posed yet on this frame.
        this.pendingNades.push(e);
        continue;
      }
      if (e.t === "bounce") {
        // Thunk scales with the impact, so a lob onto sand is not a clang.
        const k = Math.min(1, e.hard / 9);
        this.audio.play("nade-bounce", { x: e.x, y: e.y, z: e.z, vol: 0.1 + k * 0.3, rate: 0.9 + k * 0.3, src: "nade" + e.id });
        continue;
      }
      if (e.t === "boom") {
        this.accolades.nadeBoom(e.id, e.src, this.nowMs() / 1000); // feel stream: COOKED medal
        this.onBoom(e);
        this.blastCue = { x: e.x, z: e.z, src: e.src };
        // gamepad stream: explosion rumble, scaled by proximity to the local body.
        try {
          const me = this.ghost ?? this.me();
          if (me) {
            const d = Math.hypot(e.x - me.x, e.z - me.z);
            rumbleBoom(Math.max(0, 1 - d / 25));
          } else rumbleBoom(0.3);
        } catch (err) {
          console.debug("[events] boom rumble failed", err); /* cosmetic */
        }
        continue;
      }
      if (e.t === "hit") {
        // COMBAT STATS — headshots, body shots, damage dealt / taken (the endcard's panel).
        if (!this.ended) {
          if (e.src === this.you && e.dst !== this.you) {
            this.combat.dmg += e.dmg;
            if (e.seq !== undefined || !this.net) e.head ? this.combat.heads++ : this.combat.body++;
          }
          if (e.dst === this.you) this.combat.taken += e.dmg;
        }
        if (e.dst === this.you && !e.kill && e.src !== this.you) this.announcer.kong("hurt");
        {
          // feel stream: onto the tape too — the final killcam replays its killer's hitmarkers
          const h: TapeHit = { t: this.renderT * 1000 + (this.session ? 0 : INTERP_MS), src: e.src, dst: e.dst, head: e.head, kill: e.kill, x: e.x, y: e.y, z: e.z };
          this.recHits.push(h);
          this.fkTape.hit(h);
        }
        this.sparks(e.x, e.y, e.z, e.kill, e.src, e.head); // weapons stream: CoD flesh hit
        this.actors.get(e.dst)?.onHit();
        this.audio.play(e.kill || e.head ? "flesh" : "impact", { x: e.x, y: e.y, z: e.z, vol: 0.22, src: e.dst });
        if (e.src === this.you) {
          // Suppress the duplicate white X when we already predicted this hit;
          // upgrades (head/kill) always show.
          // has(), not delete(): a multi-pellet burst lands several hit events
          // with ONE seq, and all of them belong to the marker already shown.
          // The set is pruned on reconcile (seq <= acked is settled).
          const predicted =
            e.seq != null ? this.predMarked.has(e.seq) : this.net && performance.now() - this.lastPredMark < 180;
          if (!predicted || e.head || e.kill) {
            this.hitmarker(e.head, e.kill);
            this.audio.hitmarker(e.head, e.kill);
          } else {
            // The server agreed with the prediction: grey -> white, no new sound.
            const hm = document.getElementById("hitmarker");
            if (hm?.classList.contains("pred")) hm.className = "confirm";
          }
          rumbleHit(e.kill); // gamepad stream: hit confirmation (no-op without pad)
          this.dmgNumber(e);
          this.markEnemy(e.dst, 1100); // feel stream: who you are hitting stays marked a beat
          if (e.dst !== this.you) this.scorePops.hit(e.dst, e.dmg, this.nowMs() / 1000, !!e.wall); // feel stream R2: assists
        }
        if (e.dst === this.you) {
          this.extras.hitOnMe(e.src, e.dmg, this.nowMs() / 1000); // feel stream: the killcam's death recap
          this.audio.play("hurt", { vol: 0.28 });
          rumbleHurt(); // gamepad stream: damage taken (no-op without pad)
          // Damage flash: WebGL into the grade, WebGPU into the pipeline.
          if (this.grade) this.grade.uniforms.uHurt.value = 1;
          else this.pipeline?.setHurt(1);
          // Blast damage points at the BANANA, not at whoever threw it three
          // seconds ago from somewhere else entirely.
          const bc = this.blastCue;
          if (bc && bc.src === e.src) this.dmgCueAt(bc.x, bc.z);
          else this.dmgCue(e.src, e.x, e.z);
        }
      }
      // explode() pushes its "boom" and then its hits back to back, so the cue
      // only survives across those hits — anything else clears it.
      if (e.t !== "hit") this.blastCue = null;
      // Upstream (.origin 28.10.): a fresh life opens on the sim's spawn facing
      // (toward the middle of the map). The view yaw is the client's own and
      // rides every command, so without this the new body would turn straight
      // back to where you died looking.
      if (e.t === "spawn" && e.id === this.you && typeof e.yaw === "number") {
        this.yaw = e.yaw;
        this.pitch = 0;
        this.recY = this.recP = this.punchY = this.punchP = 0;
      }
      if (e.t === "spawn" && e.id === this.you && this.matchLive()) this.announcer.kong("spawn");
      // A spray tag went up somewhere (client/src/sprays.ts).
      if (e.t === "spray") {
        this.sprays?.place(e.src, e.tag, e.x, e.y, e.z, e.nx, e.ny, e.nz);
        // Someone else's can: positional hiss — heard when you stand next to
        // it, culled past CULL_M by play(). Your own echo already hissed above.
        if (e.src !== this.you) this.audio.play("spray", { x: e.x, y: e.y, z: e.z, vol: 0.4, src: e.src });
        continue;
      }
      if (e.t === "kill") {
        this.feed(e);
        // feel stream: every kill opens a final-killcam clip (final-killcam.ts picks the winning one at the end)
        {
          const killer = this.players.get(e.src);
          this.fkTape.kill(
            { t: this.renderT * 1000 + (this.session ? 0 : INTERP_MS), src: e.src, dst: e.dst, weapon: e.weapon, head: e.head, srcTeam: killer?.team ?? -1, killer: killer?.name ?? "", victim: this.players.get(e.dst)?.name ?? "" },
            this.rec,
            this.recShots,
            this.recHits,
          );
        }
        // feel stream: MEDALS. Every kill feeds the tracker (it keeps everyone's
        // streaks, last kills and your nemesis); yours come back as CoD medals —
        // the row in the top-centre band, ELIMINATED under the crosshair — and ONE
        // quiet sting for the kill's most important medal (medal-stings.ts).
        {
          const now = this.nowMs() / 1000;
          const killer = this.players.get(e.src);
          const victim = this.players.get(e.dst);
          const meK = this.me();
          this.accolades.you = this.you;
          const vStreak = this.accolades.streakOf(e.dst); // BEFORE kill(): it zeroes the victim's streak
          const earned = this.accolades.kill(
            {
              now,
              src: e.src,
              dst: e.dst,
              weapon: e.weapon,
              head: e.head,
              simMedal: e.medal,
              dist: killer && victim ? Math.hypot(killer.x - victim.x, killer.y - victim.y, killer.z - victim.z) : NaN,
              myHp: meK?.hp ?? 100,
              teamOf: (id) => this.players.get(id)?.team,
              ffa: this.opts?.mode === "ffa",
            },
            NADE_FUSE,
          );
          this.scorePops.kill(e.src, e.dst, this.you, e.head, e.weapon, earned, this.nowMs()); // feel stream R2
          // The announcer calls first blood, streaks, multi-kills and shutdowns by name.
          if (e.src !== e.dst && !this.ended) {
            const kn = killer?.name ?? "", vn = victim?.name ?? "";
            // Structural gate (upstream parity): only your own medals can feed the
            // multi-kill window — strangers' multis never enter the voice-capable
            // path, whatever the tracker returns. (accolades.kill() already
            // returns [] for foreign kills, so this is defence in depth.)
            const multi = e.src === this.you ? Math.max(0, ...earned.map((m) => (m.id === "double" ? 2 : m.id === "triple" ? 3 : m.id === "quad" ? 4 : m.id === "rampage" ? 5 : 0))) : 0;
            if (vStreak >= 5) this.announcer.shutdown(kn, vn, vStreak, e.src === this.you || e.dst === this.you);
            else this.announcer.kill(kn, vn, e.src === this.you, this.accolades.streakOf(e.src), multi, e.head);
          }
          if (e.src === this.you && e.dst !== this.you) {
            this.announcer.kong(e.head ? "head" : "kill"); // "Kong smash!"
            this.medals.kill(earned, victim?.name ?? "", this.nowMs());
            const top = earned[0];
            if (top) {
              const n = top.id === "double" ? 2 : top.id === "triple" ? 3 : top.id === "quad" ? 4 : top.id === "rampage" ? 5 : 0;
              this.stings.play(top.id, top.tier, n, now);
            }
          }
        }
        if (e.dst === this.you) {
          // The cut runs exactly as long as you are down: it ends on the tick
          // you respawn, so there is no dead air between the killcam and the
          // game (RESPITE is the sim's own respawn timer).
          //
          // The cut only exists when there is somebody to show. Your own nana
          // has no killer to frame (you have no third-person actor), so a
          // self-kill goes straight to the respawn instead of to an empty shot.
          // ONE LIFE PER ROUND (round-based TDM): the cut is the same RESPITE
          // beat as everywhere else — the replay of who got you — and when it
          // ends, main.ts's paint sees "dead, round mode, no killcam" and puts
          // this client on the team-only spectator POV (client/src/spectate.ts)
          // until the next round respawns it.
          this.killcamDur = RESPITE;
          this.killcamT = e.src === e.dst ? 0 : this.killcamDur;
          this.kcLost = 0;
          this.kcPlaced = false;
          this.killerId = e.src;
          // Arm the REPLAY: rewind the tape KC_PRE_MS, but never past its start
          // and never past the killer's first recorded appearance. A tape that
          // cannot show the killer at all (they joined this instant, or the
          // match just started) falls back to the live framing sweep.
          this.kcClock = -1;
          if (e.src !== e.dst && this.rec.length >= 2) {
            const nowT = this.rec[this.rec.length - 1]!.t;
            const firstK = this.rec.find((f) => f.players.some((p) => p.id === e.src));
            if (firstK) {
              this.kcClock = Math.max(this.rec[0]!.t, nowT - KC_PRE_MS, firstK.t);
              this.kcFreeze = nowT + KC_TAIL_MS;
              this.kcShotIdx = this.recShots.length;
              for (let i = 0; i < this.recShots.length; i++)
                if (this.recShots[i]!.t >= this.kcClock) {
                  this.kcShotIdx = i;
                  break;
                }
              this.kcHitIdx = this.recHits.length;
              for (let i = 0; i < this.recHits.length; i++)
                if (this.recHits[i]!.t >= this.kcClock) {
                  this.kcHitIdx = i;
                  break;
                }
            }
          }
          const nm = this.players.get(e.src)?.name ?? "UNKNOWN";
          // The plate is the killer's NAME and nothing else — how they did it
          // is its own line, so the name always reads as a name.
          this.killerName = nm;
          this.killerTag = killHow(e.weapon, e.src === e.dst); // UI stream: "FRAG GRENADE", weapon name…
          // feel stream: + how far, + headshot, and the run of hits that did it ("4 HITS · 112 DMG IN 0.6 S")
          {
            const kp = this.players.get(e.src);
            const mp = this.players.get(this.you);
            if (e.src !== e.dst) this.killerTag = this.extras.how(this.killerTag, kp && mp ? Math.hypot(kp.x - mp.x, kp.y - mp.y, kp.z - mp.z) : NaN, e.head);
            this.extras.paintRecap(e.src !== e.dst ? this.extras.recap(e.src, this.nowMs() / 1000) : "");
          }
          // Where you fell: the killcam plants the ghost ring here.
          const meNow = this.players.get(this.you);
          if (meNow) this.deathAt = { x: meNow.x, y: meNow.y, z: meNow.z };
          // Winding up when you died: put the paw away (and forget the cook —
          // the next pin-pull re-arms the signal from scratch in nadeDown()).
          this.nadePhase = 0;
          this.nadePhaseT = 0;
          this.nadeSawCook = false;
          this.vm.setNade(0, 0);
        }
      }
      // Legacy foot events reset the phase; displayed movement owns playback.
      if (e.t === "foot" && e.id !== this.you) {
        // Cadence has one owner: displayed displacement. A compatibility foot
        // event must not add a second sound or place it at the wrong elevation.
        this.footstepCadence.reset(e.id);
      }
      // feel stream: relative, like the rest of the HUD — your side's UAV is already
      // on your KILLSTREAK 3 medal when it is yours; the enemy's gets its own word.
      if (e.t === "uav" && this.opts?.mode !== "ffa") {
        const mine = this.me()?.team;
        if (e.team !== mine) this.banner("ENEMY UAV ONLINE", 1.7);
        else if (this.accolades.streakOf(this.you) < 3) this.banner("UAV ONLINE", 1.5);
      }
      // KILLSTREAK REWARD (10 without dying): the blast no longer exists — the
      // reward is the frag, granted sim-side — so this is the moment only:
      // banner, announcer call, no shake. Reward, never a match end: the match plays on.
      // THE KILLSTREAK TOGGLE IS COSMETIC-ONLY: with killstreaks off there is no
      // banner and no voice — announcer.nuke() gates the same way.
      if (e.t === "nuke" && !this.ended && prefs().killstreaks) {
        const kn = this.players.get(e.src)?.name ?? "UNKNOWN";
        const mine = e.src === this.you;
        // The streak rides the wire untrusted (a hostile/replayed frame can put
        // anything in it) and lands in a subtitle AND a spoken line: coerce it
        // to the only values this callout can honestly mean — a multiple of ten
        // between 10 and 990 — so it can neither spoof text nor pin the
        // subtitle with a huge number.
        const raw = Number(e.streak);
        const streak = Number.isFinite(raw) ? Math.min(990, Math.max(10, Math.trunc(raw))) : 10;
        this.banner(mine ? "TACTICAL NUKE — YOURS" : `TACTICAL NUKE — ${kn}`, 3, `${streak} KILLS WITHOUT DYING · EXTRA FRAG`);
        this.announcer.nuke(kn, mine, streak);
      }
      // ROUND CARDS. The result holds for the whole intermission (the sim's
      // ROUND_INTERMISSION_S) so the 3-2-1 that follows lands on a screen that
      // has already said who took it; the start card is one short beat that
      // names the round and gets out of the numerals' way.
      if (e.t === "round") {
        // UI stream: relative, like CoD — the round is WON or LOST from where you stand.
        const mine = this.me()?.team;
        const res = e.winner === -1 ? "DRAW" : e.winner === mine ? "WON" : "LOST";
        const [ours, theirs] = mine === 1 ? [e.wins1, e.wins0] : [e.wins0, e.wins1];
        if (e.state === "end") this.banner(`ROUND ${res}`, 4.5, `ROUND ${e.round} · ${ours}–${theirs}`);
        else this.banner(`ROUND ${e.round}`, 1.2);
      }
      if (e.t === "match" && e.state === "end") {
        // STALE-ROLLOVER GUARD (see liveTick): a late frozen-tick duplicate of
        // the PREVIOUS match's end landing after the rollover — via the
        // old-tick branch or a fresh match/end branch — must not re-enter
        // finish() over the live match. Legitimate retransmits of the CURRENT
        // end carry a tick past liveTick and still pass.
        // RECONNECT WINDOW: after a reconnect liveTick is -1, so nothing is
        // stale by the guard above — but an end on a tick OLDER than the
        // newest applied one cannot be the current match's (its frozen tick
        // admits nothing newer until the rollover, which sets liveTick), so a
        // pre-first-rollover old-tick end replay is the previous match's and
        // is dropped too. Fresh-tick ends with liveTick < 0 stay allowed:
        // the first match (and round rooms, whose remain never drops) end so.
        if (isStaleMatchTick(tick, this.liveTick)) continue;
        if (this.liveTick < 0 && tick < this.snapTick) continue;
        // END-OF-MATCH WATCHDOG (endWatchdog): the end was seen on the wire,
        // even if finish() below ever failed to run it.
        this.endEvidenceAt = performance.now();
        this.finish(e.score0, e.score1);
      }
      // A FRESH MATCH AFTER AN ENDCARD: the 24/7 rollover or a created lobby
      // that dropped back to its pre-game screen. Re-arm finish() for the next
      // one and let main.ts take the endcard down.
      else if (e.t === "match" && e.state === "live" && this.ended) {
        // The rollover point (see liveTick): stale end signals on ticks at or
        // before this one belong to the match that just ended.
        this.liveTick = this.snapTick;
        this.forceRollover();
      }
      } catch (err) {
        // One bad event must never block the events behind it (match/end) —
        // logged at debug so real bugs stay visible without changing behaviour.
        console.debug("[events] dropped event", e.t, err);
      }
    }
  }

  /** The burst whose damage events are still arriving (for the direction cue). */
  blastCue: { x: number; z: number; src: string } | null = null;
  shakeT = 0;
  shakeAmp = 0;

  /**
   * A frag entered the world. The sim spawn point is authoritative; the DRAWN
   * frag starts at the thrower's actual paw and blends onto it over ~0.13 s, so
   * from every angle the banana leaves a hand and not a chest.
   */
  private flushNades(): void {
    for (const e of this.pendingNades) {
      const local = e.src === this.you;
      let hand: THREE.Vector3 | null = null;
      // World-scale by default; the local thrower hands over from a SCALE MODEL
      // (the viewmodel frag is drawn at ~42% of world size, 40 cm from the eye),
      // so his frag is born at that apparent size and grows into a real banana
      // over the handoff instead of doubling in size on the release frame.
      let born = 1;
      if (local) {
        // The viewmodel lives in camera space: make sure it is where the eye is
        // before asking it for a world position.
        this.vm.root.updateWorldMatrix(true, true);
        hand = this.vm.nadeHandWorld();
        born = this.vm.nadeApparentScale();
      } else {
        const actor = this.actors.get(e.src);
        if (actor) {
          hand = actor.nadeHandWorld().clone();
          born = actor.nadeScale; // weapons stream: the 3P frag is drawn larger than life (bruiser.ts NADE_TP_SCALE)
          actor.onThrow();
        }
      }
      this.nadeFx?.spawn(e.id, e.x, e.y, e.z, hand, born);
      this.audio.play("nade-throw", local ? { vol: 0.4, src: "local" } : { x: e.x, y: e.y, z: e.z, vol: 0.34, src: e.src });
    }
    this.pendingNades.length = 0;
  }

  /** Detonation: burst FX, scorch on whatever surface it died on, and a shove. */
  private onBoom(e: Extract<NetEvent, { t: "boom" }>): void {
    this.nadeFx?.kill(e.id);
    this.boomFx?.boom(e.x, e.y, e.z, this.surfaceUnder(e.x, e.y, e.z));
    const me = this.me();
    const d = me ? Math.hypot(me.x - e.x, me.y + EYE - e.y, me.z - e.z) : 40;
    this.audio.boom(e.x, e.y, e.z, d, "nade" + e.id);
    // Small, and it decays fast: a frag going off nearby is a nudge, never a
    // camera the player has to fight.
    const k = Math.max(0, 1 - d / 15);
    if (k > 0.01) {
      this.shakeAmp = Math.min(0.05, Math.max(this.shakeAmp, k * k * 0.05));
      this.shakeT = 0;
    }
  }

  hitmarkerT = 0;
  pendingShots: Extract<NetEvent, { t: "shot" }>[] = [];
  /** Throws waiting for their thrower to be posed (see flushNades). */
  pendingNades: Extract<NetEvent, { t: "nade" }>[] = [];
  eyeSmooth = EYE;
  /**
   * STEP SMOOTHING — how far the eye is currently LAGGING the feet, in metres.
   *
   * `groundHeight` is a snap, not a slope: `integrate()` does `if (p.y <= gh)
   * p.y = gh` and there is no interpolation anywhere in the sim. On Shipment's
   * flat yard that is invisible. On dust2 the source's 0.8128 m vertical quantum
   * halves into 0.406 m stair treads, and the three main ramps are built of them,
   * so walking up mid is **eight instant +0.406 m jumps of `me.y`, each inside a
   * single 64 Hz tick** (measured: `qa/out/r2/heights-drives-before.json`, mid up
   * 8 steps, CT up 6, A up 4). The camera read `me.y` raw, so a smooth cobble
   * slope was climbed as invisible stairs at roughly two pops a second.
   *
   * This is a RENDER offset and nothing else. The body's y, the collision, the
   * hit registration, the network state and every QA number derived from the sim
   * are untouched — deliberately: easing the SIM's y would leave the feet inside
   * the tread for the duration of the ease, which is precisely what `penetration()`
   * scores as a CLIP and what spec-qa §G6 gates on. The pop is a presentation
   * problem and it is fixed in presentation.
   *
   * The eye absorbs an upward snap up to STEP_SMOOTH_MAX and gives it back at
   * STEP_SMOOTH_RATE m/s, which at 60 fps is 5 cm a frame — the bound the fix
   * order asks for on the EYE. Bigger rises (a real drop, a teleport, a respawn)
   * are left alone: they are supposed to be felt.
   */
  stepLag = 0;
  /** Previous frame's `me.y`, for detecting the snap. */
  private lastFeetY: number | null = null;
  bannerT = 0;
  svOffset = 0;
  /**
   * Reconciliation residual, RENDER-ONLY. The camera shows ghost + err and err
   * decays to zero over ~100 ms, so a small server correction is a glide the
   * eye cannot see instead of a 32 Hz pop. Sim state never includes it — the
   * ghost, prediction and every fired command stay on the authoritative pose.
   * A correction past 0.6 m snaps (that is a real desync, hiding it would draw
   * the player somewhere they cannot be shot).
   */
  private errX = 0;
  private errY = 0;
  private errZ = 0;
  /**
   * Interpolation delay actually in use, ms. Starts at INTERP_MS and grows
   * toward 160 while snapshot arrivals are jittery: with a fixed 80 ms budget a
   * single late packet froze every remote body at the newest pose and then
   * teleported it when the burst landed. gapMax is a decaying max of arrival
   * gaps (time constant ~0.8 s), so the buffer breathes back down when the
   * network calms.
   */
  private interpDelay = INTERP_MS;
  private gapMax = 0;
  private lastSnapArr = 0;
  private renderTimeline = new RenderTimeline();
  /** Server-clock time (s) of the world the last drawn frame showed. */
  renderT = 0;
  lastReloadVal = 0;

  /**
   * Build a sim-capable ghost from an authoritative snapshot of the local player.
   *
   * Owner-only replay state restores exact position, velocity and timers at
   * the acknowledged command. The older-server fallback carries the fields
   * missing from its public pose so a slide does not stop at each snapshot.
   */
  ghostFrom(p: PlayerSnap, state?: PredictionState): PlayerSnap {
    const onGround = p.y <= groundHeight(p.x, p.z, MAP_SOLIDS, p.y) + 0.02;
    const g =
      this.ghost && this.ghost.id === p.id && p.alive && this.ghost.alive ?
        (this.ghost as PlayerSnap & {
          wantAds?: boolean;
          tacFuel?: number;
          slideVx?: number;
          slideVz?: number;
          fireCd?: number;
          sprintOut?: number;
          cmdBank?: number;
          moveBank?: number;
        })
      : null;
    return {
      ...p,
      onGround,
      wantAds: g?.wantAds ?? false,
      tacFuel: g?.tacFuel ?? 2,
      // Mid-slide with nothing to carry from (joined into one?): seed with the
      // wire velocity rather than parking the body.
      slideVx: p.slide > 0 ? (g?.slideVx ?? p.vx) : 0,
      slideVz: p.slide > 0 ? (g?.slideVz ?? p.vz) : 0,
      fireCd: g?.fireCd ?? 0,
      swap: p.swap ?? 0,
      nadeCd: 0,
      sprintOut: g?.sprintOut ?? 0,
      // weapons stream: bloom, trigger arm and the exact cook (the snapshot's
      // own `cook` is quantised) come from the owner-only state when present.
      heat: 0,
      shotAgo: 9,
      armed: true,
      ...state,
      // EARNED-TIME BANKS (review HIGH-1/HIGH-2): the spread above seeds both
      // from the ack when the server sends them, but a pre-bank server (or a
      // first snapshot with no prediction yet) sends neither — and `{...p}`
      // never carries them at all (PlayerSnap has no bank fields), so without
      // this the reconcile rebuilt the account from 0 + dt on every snapshot
      // while the authority kept banking on the wall clock. Preserve the old
      // ghost's accounts as the fallback, exactly like fireCd/sprintOut above:
      // after an idle second the ghost replays out of ~0.5 s banked, like the
      // server drains, instead of 1-2 ticks.
      cmdBank: state?.cmdBank ?? g?.cmdBank ?? 0,
      moveBank: state?.moveBank ?? g?.moveBank ?? 0,
    } as PlayerSnap;
  }

  hitmarker(head: boolean, kill: boolean, predicted = false): void {
    const el = document.getElementById("hitmarker");
    if (!el) return;
    // weapons stream: CoD confirm ladder — a PREDICTED mark ("pred", grey) on
    // the trigger pull, upgraded by the server's verdict ("confirm" white body,
    // "head" gold, "kill" red). The UI stream styles the classes.
    el.className = kill ? "kill" : head ? (predicted ? "pred head" : "head") : predicted ? "pred" : "confirm";
    this.hitmarkerT = kill ? 1.05 : 1;
    const cross = document.getElementById("cross");
    if (cross) {
      cross.classList.remove("hit");
      void cross.offsetWidth;
      cross.classList.add("hit");
    }
  }

  tickHitmarker(dt: number): void {
    const el = document.getElementById("hitmarker");
    if (!el) return;
    if (this.hitmarkerT <= 0) {
      el.style.opacity = "0";
      return;
    }
    this.hitmarkerT = Math.max(0, this.hitmarkerT - dt / 0.22);
    const t = Math.min(1, this.hitmarkerT);
    el.style.opacity = String(Math.min(1, t * 2.5));
    const pop = 1 + 0.35 * (1 - t);
    el.style.transform = `translate(-50%, -50%) scale(${pop.toFixed(3)})`;
  }

  banner(text: string, secs = 1.7, sub = ""): void {
    const el = document.getElementById("killbanner");
    if (!el || !text) return;
    // UI stream: a callout is a title and an optional sub-line (victim, round score).
    el.replaceChildren();
    const b = document.createElement("b");
    b.textContent = text;
    el.append(b);
    if (sub) {
      const span = document.createElement("span");
      span.textContent = sub;
      el.append(span);
    }
    this.bannerT = secs;
    this.bannerDur = secs;
  }
  /** Length of the banner currently up, so the pop/fade envelope scales. */
  bannerDur = 1.7;
  /** The "IN NEXT ROUND" card has been shown for this wait (round-based TDM). */
  private sitOutSaid = false;

  tickBanner(dt: number): void {
    const el = document.getElementById("killbanner");
    if (!el) return;
    if (this.bannerT <= 0) {
      el.style.opacity = "0";
      return;
    }
    this.bannerT = Math.max(0, this.bannerT - dt);
    const age = this.bannerDur - this.bannerT;
    // UI stream: the CoD medal settle — in at 1.35x, down to size in 180 ms
    // on an ease-out (no overshoot, no bounce), hold, 300 ms fade.
    const inT = Math.min(1, age / 0.18);
    const ease = 1 - (1 - inT) * (1 - inT) * (1 - inT);
    const scale = 1.35 - 0.35 * ease;
    const fade = this.bannerT < 0.3 ? this.bannerT / 0.3 : 1;
    el.style.opacity = String(ease * fade);
    el.style.transform = `translateX(-50%) scale(${scale.toFixed(3)})`;
  }

  // ---------------------------------------------------------------- damage cue
  dmgCueT = 0;

  /** Paint #dmg on the bearing of the monkey that shot us. */
  dmgCue(srcId: string, hx: number, hz: number): void {
    const src = this.players.get(srcId);
    this.dmgCueAt(src ? src.x : hx, src ? src.z : hz);
  }

  /** Paint #dmg on the bearing of a world point (a shooter, or a banana). */
  dmgCueAt(wx: number, wz: number): void {
    const me = this.me();
    const el = document.getElementById("dmg");
    if (!me || !el) return;
    // Point at the SHOOTER. The impact point (e.x/e.z) is a spot on our OWN
    // capsule, so taking its bearing was reading a ~0.3 m random offset — that,
    // plus a gradient that was transparent at its own centre and opaque at the
    // rim, is why qa/out/killcam.json measured a mean cue error of 158 deg.
    // Upstream (.origin 28.10.): the bearing is measured CLOCKWISE on screen
    // (positive = to your right). A world bearing above your yaw is to your
    // LEFT — the camera looks along (sin yaw, cos yaw) with its right at
    // (-cos yaw, sin yaw) — so it is yaw minus bearing. The other way round
    // mirrored every cue left/right: a shot from your left lit the right of
    // the screen (the frag danger arrows in weapons/hud.ts already flip it
    // the same way).
    let ang = me.yaw - Math.atan2(wx - me.x, wz - me.z);
    ang = Math.atan2(Math.sin(ang), Math.cos(ang));
    // #dmg is now OPAQUE at (--dx,--dy) and fades outward, so the bloom sits ON
    // the attacker's bearing. The X and Y gains differ because the offset is in
    // percent of WIDTH vs HEIGHT: 34/46 lands the bloom's true alpha centroid on
    // the bearing for every aspect from 4:3 to 21:9 (worst case 6.6 deg).
    el.style.setProperty("--dx", (50 + Math.sin(ang) * 34).toFixed(2) + "%");
    el.style.setProperty("--dy", (50 - Math.cos(ang) * 46).toFixed(2) + "%");
    el.style.setProperty("--ang", ((ang * 180) / Math.PI).toFixed(1) + "deg"); // UI stream: damage arc bearing
    this.dmgCueT = 1;
  }

  tickDmgCue(dt: number): void {
    const el = document.getElementById("dmg");
    if (!el) return;
    if (this.dmgCueT <= 0) {
      el.style.opacity = "0";
      return;
    }
    // Sim-dt driven like the hitmarker and the hurt grade. This used to be a
    // wall-clock setTimeout, which does not reproduce in a stepped replay.
    this.dmgCueT = Math.max(0, this.dmgCueT - dt / 0.45);
    el.style.opacity = (Math.min(1, this.dmgCueT * 2.4)).toFixed(3);
  }

  // ------------------------------------------------------------ damage numbers
  dmgLayer: HTMLElement | null = null;
  dmgNums: { el: HTMLElement; dst: string; t: number; age: number; sx: number; sy: number; total: number; pop: number; kind: string }[] = [];
  dmgPool: HTMLElement[] = [];
  private nv = new THREE.Vector3();

  private dmgHost(): HTMLElement | null {
    if (this.dmgLayer?.isConnected) return this.dmgLayer;
    const hud = document.getElementById("hud");
    if (!hud) return null;
    let l = document.getElementById("dmgnum-layer");
    if (!l) {
      l = document.createElement("div");
      l.id = "dmgnum-layer";
      hud.appendChild(l);
    }
    this.dmgLayer = l;
    return l;
  }

  /**
   * A small floating number at the impact point. Rapid hits on the same monkey
   * STACK into one rising total instead of stuttering out a column of digits,
   * and every number is pushed clear of the crosshair's dead zone.
   */
  dmgNumber(e: Extract<NetEvent, { t: "hit" }>): void {
    const host = this.dmgHost();
    if (!host) return;
    const kind = e.kill ? "kill" : e.head ? "head" : "";

    const prev = this.dmgNums.find((d) => d.dst === e.dst && d.age < 0.42 && d.kind !== "kill");
    if (prev) {
      prev.total += e.dmg;
      prev.kind = kind || prev.kind;
      prev.age = 0;
      prev.t = Math.max(prev.t, DMG_LIFE);
      prev.pop = 1;
      this.paintDmg(prev);
      return;
    }

    const [sx, sy] = this.projectClear(e.x, e.y, e.z);
    const el = this.dmgPool.pop() ?? document.createElement("b");
    host.appendChild(el);
    const row = { el, dst: e.dst, t: DMG_LIFE, age: 0, sx, sy, total: e.dmg, pop: 1, kind };
    this.dmgNums.push(row);
    this.paintDmg(row);
    // Never a column of noise: the oldest goes first.
    while (this.dmgNums.length > 5) this.retireDmg(0);
  }

  private paintDmg(d: { el: HTMLElement; total: number; kind: string }): void {
    d.el.className = "dnum" + (d.kind ? " " + d.kind : "");
    d.el.textContent = (d.kind === "kill" ? "✕ " : "") + String(Math.round(d.total));
  }

  private retireDmg(i: number): void {
    const d = this.dmgNums[i];
    if (!d) return;
    d.el.remove();
    if (this.dmgPool.length < 10) this.dmgPool.push(d.el);
    this.dmgNums.splice(i, 1);
  }

  /** World point → screen px, pushed out of the crosshair's dead ellipse. */
  private projectClear(x: number, y: number, z: number): [number, number] {
    const W = innerWidth;
    const H = innerHeight;
    const cx = W * 0.5;
    const cy = H * 0.5;
    this.camera.updateMatrixWorld();
    this.nv.set(x, y, z).applyMatrix4(this.camera.matrixWorldInverse);
    const behind = this.nv.z > -0.15;
    this.nv.applyMatrix4(this.camera.projectionMatrix);
    let px = behind ? cx : cx + this.nv.x * cx;
    let py = behind ? cy - 120 : cy - this.nv.y * cy;
    // Keep the crosshair, hitmarker and reload bar completely clear.
    const rx = 132;
    const ry = 92;
    let ox = px - cx;
    let oy = py - cy - 26;
    const r = Math.hypot(ox / rx, oy / ry);
    if (r < 1) {
      if (r < 1e-3) {
        ox = 0;
        oy = -ry;
      } else {
        ox /= r;
        oy /= r;
      }
      px = cx + ox;
      py = cy + 26 + oy;
    }
    return [Math.max(70, Math.min(W - 70, px)), Math.max(70, Math.min(H - 130, py))];
  }

  tickDmgNums(dt: number): void {
    for (let i = this.dmgNums.length - 1; i >= 0; i--) {
      const d = this.dmgNums[i]!;
      d.t -= dt;
      d.age += dt;
      if (d.t <= 0) {
        this.retireDmg(i);
        continue;
      }
      d.pop = Math.max(0, d.pop - dt / 0.11);
      const k = 1 - d.t / DMG_LIFE;
      const rise = 30 * (1 - (1 - k) * (1 - k));
      const fade = d.t < 0.24 ? d.t / 0.24 : 1;
      const scale = (d.kind === "kill" ? 1.16 : 1) * (1 + d.pop * d.pop * 0.24);
      d.el.style.opacity = fade.toFixed(3);
      d.el.style.transform = `translate(-50%,-50%) translate(${d.sx.toFixed(1)}px, ${(d.sy - rise).toFixed(1)}px) scale(${scale.toFixed(3)})`;
    }
  }

  feed(e: Extract<NetEvent, { t: "kill" }>): void {
    const box = document.getElementById("killfeed");
    if (!box) return;
    const pa = this.players.get(e.src);
    const pb = this.players.get(e.dst);
    const row = document.createElement("div");
    if (e.src === this.you || e.dst === this.you) row.className = "me";
    // UI stream: CoD colour rule — relative, never absolute. Your team is blue,
    // the enemy red/orange; in FFA everyone but you is the enemy. Names are
    // escaped (they come off the wire) and styled by class, not inline.
    const myTeam = this.me()?.team;
    const ffa = this.opts?.mode === "ffa";
    const side = (id: string, t?: number) => (id === this.you ? "kf-you" : !ffa && t === myTeam ? "kf-ally" : "kf-enemy");
    const nm = (id: string, p?: PlayerSnap) => `<span class="${side(id, p?.team)}">${escHtml(p?.name ?? id)}</span>`;
    // The frag gets its own glyph — you should never wonder what killed you.
    // feel stream: every weapon CLASS is its own monochrome silhouette (ui/weapon-icons.ts), + the headshot mark.
    const nade = e.weapon === "nade";
    const mid = killIconHtml(e.src === e.dst && nade ? "nade" : e.weapon, e.head && !nade);
    if (nade) row.classList.add("nade");
    // Blowing yourself up is one name, not two.
    if (e.src === e.dst) {
      row.innerHTML = `${mid}${nm(e.dst, pb)}`;
      box.prepend(row);
      while (box.children.length > 6) box.lastChild?.remove();
      setTimeout(() => row.remove(), 5200);
      return;
    }
    row.innerHTML = `${nm(e.src, pa)}${mid}${nm(e.dst, pb)}`;
    box.prepend(row);
    while (box.children.length > 6) box.lastChild?.remove();
    setTimeout(() => row.remove(), 5200);
  }

  // weapons stream: scratch for the drawn round (no per-shot allocation of our own)
  private fxStart = new THREE.Vector3();

  /**
   * weapons stream: one round as DRAWN — the CoD tracer muzzle -> impact, the
   * per-surface impact + decal timed for the tracer's arrival, the 3P flash +
   * light + brass for remote shooters, the local brass for ours (WeaponFx).
   */
  spawnTracer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, src: string, raw = false, weapon?: string): void {
    const fx = this.wfx;
    if (!fx) return;
    const w = weapon ?? this.players.get(src)?.weapon ?? PRIMARY_WEAPON_ID;
    const start = this.fxStart.set(ox, oy, oz);
    let local = false;
    let tracer = true;
    if (raw) {
      // Killcam replay: the live actors are posed on the TAPE, not on the wire,
      // so neither muzzle lookup below can be trusted. The recorded origin is
      // the eye — nudge it down the ray so the round reads as leaving a gun.
      start.set(ox + dx * 0.28, oy - 0.1, oz + dz * 0.28);
    } else if (src === this.you) {
      const me = this.me();
      if (me) {
        // Read the muzzle from the LIVE camera pose draw() set — lean
        // (wall-clamped), eye smoothing, bob and step lag included. Never
        // re-pose the camera here: a fresh pose without those terms parks the
        // muzzle ~0.30 m off the leaned eye and the tracer reads as starting
        // mid-visor. (The ray origin ox/oy/oz stays the authoritative leaned
        // eye from leanEye; the start below is only the visual muzzle.)
        this.vm.root.updateWorldMatrix(true, true);
        start.copy(this.vm.muzzleWorld());
        local = true;
      }
    } else {
      const actor = this.actors.get(src);
      if (actor) {
        // The 3P flash (cards + the one shared light) and the brass leave the
        // gun this frame posed; bruiser.ts's flash rule (aim stance >= 0.35).
        if (actor.aimYawW > 0.35) {
          // Oriented down the authoritative ray: the bore and the round agree
          // even while a rig's bench-tuned fire axis is a few degrees off.
          const ex = actor.exitPoint();
          fx.muzzle3P(ex.pos.x, ex.pos.y, ex.pos.z, dx, dy, dz, w);
          fx.casing3P(ex.pos.x, ex.pos.y, ex.pos.z, dx, dy, dz, w);
          start.copy(ex.pos);
        }
        // While the actor is still turning into the aim stance the barrel is off
        // the fire line — no tracer detached from the gun, but the round still lands.
        if (actor.aimYawW <= 0.82) tracer = false;
      } else start.set(ox + dx * 0.28, oy - 0.1, oz + dz * 0.28);
    }
    // Down the authoritative ray, stopping on the world or on a body.
    fx.round(start.x, start.y, start.z, ox, oy, oz, dx, dy, dz, w, src, local, this.fxBodyT(ox, oy, oz, dx, dy, dz, src), tracer);
    if (local) fx.localShot(w);
  }

  /** weapons stream: where a drawn round stops on a body (the poses this frame drew, like predictHit). */
  private fxBodyT(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, src: string): number {
    const shooter = this.players.get(src);
    const ffa = this.opts?.mode === "ffa";
    let best = Infinity;
    for (const p of this.drawn) {
      if (p.id === src || !p.alive) continue;
      if (!ffa && shooter && p.team === shooter.team) continue;
      const t = rayPlayer(ox, oy, oz, dx, dy, dz, p);
      if (t < best) best = t;
    }
    return best;
  }

  flash3P: THREE.PointLight | null = null;

  /**
   * weapons stream: a round into a body — WeaponFx's short dark-red mist along
   * the round's path (from the shooter's eye; blasts spray from the victim up).
   */
  sparks(x: number, y: number, z: number, kill: boolean, src = "", head = false): void {
    const s = this.players.get(src);
    let dx = 0, dy = 0.4, dz = 0;
    if (s) {
      dx = x - s.x;
      dy = y - (s.y + EYE);
      dz = z - s.z;
    }
    this.wfx?.flesh(x, y, z, dx, dy, dz, head, kill);
  }

  tickFx(dt: number): void {
    if (this.flash3P && this.flash3P.intensity > 0) this.flash3P.intensity = Math.max(0, this.flash3P.intensity - 100 * dt);
    // weapons stream: advance + upload the pooled weapon FX (emits this frame get stamped here)
    if (this.wfx) {
      this.wfx.setCamera(this.camera);
      this.wfx.update(dt);
    }
    this.nadeLive = this.interpNades();
    this.syncNades(this.nadeLive);
    this.nadeFx?.update(dt, this.camera);
    this.boomFx?.update(dt, this.camera);
    // The marker only exists for the player holding the nana.
    if (this.nadePhase === 1 && this.nadeArcN > 0) {
      this.marker.set(this.nadeArc, this.nadeArcN, this.nadeRest, this.nadeSurfaceY, dt, this.camera);
    } else {
      this.marker.hide(dt);
    }
  }

  private rigTmp = new THREE.Vector3();
  /** Rest-pose forward offset of the rig's Pelvis from the actor root, metres. */
  private rigRestZ = 0;
  /**
   * Rest-pose LATERAL offset of the same bone. The clip's root translation is
   * authored along the rig's forward axis, but the legs are yawed off the body
   * by bruiser.ts's legYaw joint whenever a player travels at an angle to its
   * facing, and a rotated forward offset has a sideways component. Cancelling
   * only the forward one leaves that component in the drawn body's position, so
   * both axes are measured and both are cancelled.
   */
  private rigRestX = 0;
  private rigRestN = 0;

  /**
   * THE SECOND HALF OF HIT REGISTRATION — draw the body ON the body the server
   * tests.
   *
   * The gait clips are authored with the skeleton standing somewhere else. The
   * rig's own root bone (Hip, which Pelvis and Waist sit on) measures, in
   * actor-root space: -0.232 m standing, -0.229 m walking, +0.560 m running —
   * a step of +0.792 m that holds flat for as long as the run clip plays. So a
   * running Bruiser was DRAWN most of a metre in front of the position the sim,
   * the server, the minimap and the hit capsule all agree he is at, and the
   * crosshair you put on his chest was pointing at empty jungle.
   *
   * Measured on the exact deformed geometry (CPU skinning of every vertex in
   * the crosshair's own row, actor-root space, 750 running frames, both the
   * offline sim and a live server): the drawn body's silhouette at chest height
   * sat a median +0.635 m ahead of its capsule, p95 +0.894 m — the 0.726 m the
   * overseer's board reported, found. With this correction the same measurement
   * reads a median -0.055 m, |p95| 0.289 m, i.e. inside the 0.32 m capsule
   * instead of a body-length outside it.
   *
   * Because the offset is CONSTANT within a clip it carries no velocity, which
   * is why cancelling it cannot disturb the gait — a constant added to a
   * position cannot move a planted foot — and qa/motion.mjs re-measures the
   * skating figures unchanged. What it does remove is the 0.79 m lunge the body
   * used to make every time the walk/run blend crossed over.
   *
   * The shift goes on the actor's holder, never on the root: the root stays the
   * authoritative position for tracers, audio, the chevron, the minimap and
   * every instrument that reads it, and only the drawn body moves back onto it.
   * The rest offset is read off the asset itself (see calibrateRig), so
   * re-exporting the model cannot silently rot a magic number.
   *
   * NOTE for the rig: this cancels the symptom at draw time. The clips still
   * carry the translation, and CLIP_GAIT's measured mps/steps in bruiser.ts
   * were fitted with it in the picture, so re-authoring the clips in place has
   * to re-measure those constants against qa/motion.mjs.
   */
  /** Per-remote-actor render-only y lag, in metres BELOW the true feet height. */
  private remoteStepLag = new Map<string, number>();
  /** weapons stream: last seen reload timer per remote body (reload-start detection). */
  private remoteReload = new Map<string, number>();
  private remoteLastY = new Map<string, number>();
  /**
   * REMOTE STEP SMOOTHING — fix-round-3 order 5, and the shape of it is a
   * measurement, not a preference.
   *
   * The order asks for "the stepLag smoothing per remote actor". The local
   * version (draw() below) holds the EYE back by up to 0.45 m and hands it
   * back at 3 m/s. Ported verbatim to a body it is not a smoothing, it is a
   * clip: the eye is a point in the air, but the actor's root is its FEET, and
   * drawing feet 0.4 m under the tread they are standing on is exactly what
   * `__inspect.penetration()` reports and what `qa/botwatch.mjs` gates at
   * `CLIP_DEPTH = 0.08 m`. The same work order demands "0 CORE clips", so the
   * verbatim port fails its own acceptance by a factor of five. That is not an
   * argument for doing nothing; it is a bound on what may be done.
   *
   * What is left inside the bound: `groundHeight` snaps a body up ONE TREAD
   * EARLY, because it matches footprints with a 0.12 m tolerance
   * (`shared/map.ts` GH_TOL) against a 0.30 m body. For those 0.12 m the sim
   * has the body a tread high while the art still has floor under it at the
   * lower tread — the visual pop is real and the lag that hides it is provably
   * OUTSIDE the solid, because the strict-footprint ground there IS the lower
   * tread. So the lag is rate-limited AND clamped to the strict ground under
   * the body: it may never draw the feet below a floor. Where the body has
   * genuinely left the lower tread the clamp collapses the lag to zero and the
   * remaining step is shown, honestly, as a step.
   *
   * Render-only, like the local one: `p` here is a copy. `this.drawn`, the
   * hit-registration list and every snapshot the server rewinds to are the
   * untouched interpolated poses.
   */
  private remoteStepY(p: PlayerSnap, dt: number): number {
    const STEP_SMOOTH_MAX = MAP.stepSmoothMax ?? 0.45;
    const RATE = 3.0;
    let lag = this.remoteStepLag.get(p.id) ?? 0;
    const last = this.remoteLastY.get(p.id);
    if (last !== undefined && p.alive) {
      const rise = p.y - last;
      if (rise > 0.0005 && rise <= STEP_SMOOTH_MAX && Math.abs(p.vy) < 0.5) lag = Math.min(STEP_SMOOTH_MAX, lag + rise);
      else if (rise < -STEP_SMOOTH_MAX || rise > STEP_SMOOTH_MAX) lag = 0;
    }
    this.remoteLastY.set(p.id, p.y);
    lag = Math.max(0, lag - RATE * dt);
    // THE CLAMP. `groundHeight` with the sim's own footprint tolerance is what
    // lifted the body early; ask it again for the floor the body is strictly
    // over and never draw below that.
    if (lag > 0) lag = Math.min(lag, Math.max(0, p.y - strictGroundY(p.x, p.z, p.y)));
    this.remoteStepLag.set(p.id, lag);
    return p.y - lag;
  }

  private plantOnHitbox(a: BruiserActor, p: PlayerSnap): void {
    const pel = a.bones?.Pelvis;
    // A corpse keeps whatever correction it died with: the fall clip is
    // authored to travel, and re-zeroing here would jump the body a metre
    // forward on the exact frame the killcam cuts to it.
    if (!pel || !this.rigRestN || !p.alive) return;
    // Cancelled as a 2-D VECTOR in root space, not one axis of it: a rotated
    // forward offset has a sideways component, and legYaw (bruiser.ts) yaws the
    // lower body off the actor's facing whenever a player travels at an angle
    // to where it is looking.
    //
    // THE X TERM IS NOT ZERO. It was documented here as "exactly zero on today's
    // rig, defensive only, safe to drop" — that is false, and the measurement
    // that replaces it is below rather than an adjective.
    //
    // qa/planted.mjs --mode=off --strafe (the diagonal run whose legYaw sweeps
    // the full +-90 deg), 992 frames, reproduced to 3 d.p. across two runs on an
    // unchanged rig:
    //
    //     holder.position.x   min 0.042 m   median 0.061 m   max 0.076 m
    //                         ONE-SIGNED on 100% of frames
    //
    // A distribution that never crosses zero is not noise: it is a constant of
    // ~6 cm, 19% of the hit capsule's 0.32 m radius, with a small gait term on
    // top. planted.mjs now prints min/median/max in its `plant-x-cancel` verdict
    // every run, so this stays checkable against the artifact.
    //
    // WHAT CANCELLING IT IS ACTUALLY WORTH, measured the only way that settles
    // it — this line commented out, same command, same tree, same bruiser.ts:
    //
    //     band   latMedian WITH   latMedian WITHOUT
    //     hip        +0.020 m         -0.014 m
    //     chest      +0.036 m         -0.012 m
    //     full       +0.022 m         -0.014 m
    //     crosshair-row silhouette vs capsule (the statistic that decides
    //     whether a shot lands): 0.076 m median / 0.161 m p95 — IDENTICAL.
    //
    // So the honest reading is neither of the two claims made about this line.
    // It is not zero, and it is not buying alignment either: it shifts the drawn
    // body ~3-5 cm and slightly OVERSHOOTS centre, while the pixel statistic hit
    // registration is actually judged on does not move at all. That signature —
    // one-signed, constant, overshooting — points at rigRestX being sampled off
    // a skeleton that is not at rest (calibrateRig below reads the FIRST actor
    // ever constructed), which is a rig calibration question and belongs with
    // whoever owns bruiser.ts.
    //
    // It stays, in 2-D, until that is settled: cancelling one axis of a two-axis
    // offset is only correct by accident, and this rig is being edited.
    a.holder.position.set(0, a.holder.position.y, 0);
    pel.updateWorldMatrix(true, false);
    const v = a.root.worldToLocal(this.rigTmp.setFromMatrixPosition(pel.matrixWorld));
    a.holder.position.z = -Math.max(-1, Math.min(1, v.z - this.rigRestZ));
    a.holder.position.x = -Math.max(-1, Math.min(1, v.x - this.rigRestX));
  }

  /**
   * The rig's REST pelvis offset, measured once off the asset itself.
   *
   * A just-constructed actor has already run play("idle") + mixer.update(0), so
   * its skeleton is standing in the rest pose and the offset is read straight
   * off it. Measured in root space, so the actor's own position and facing fall
   * out of it. This is deliberately not "wait for a player to stand still": a
   * scenario that runs from its first frame — every qa/motion.mjs locomotion
   * case — never stands still, and the correction would silently never arm.
   */
  private calibrateRig(a: BruiserActor): void {
    const pel = a.bones?.Pelvis;
    if (!pel || this.rigRestN) return;
    a.holder.position.set(0, a.holder.position.y, 0);
    pel.updateWorldMatrix(true, false);
    const v = a.root.worldToLocal(this.rigTmp.setFromMatrixPosition(pel.matrixWorld));
    this.rigRestZ = v.z;
    this.rigRestX = v.x;
    this.rigRestN = 1;
  }

  draw(dt: number): void {
    BruiserActor.cameraPos = this.spectateCam && this.spectateEye ? this.spectateEye : this.camera.position;
    BruiserActor.nowMs = this.nowMs();
    // feel stream: markers keep a constant on-screen size, and nothing in the world draws over the endcard
    BruiserActor.viewTan = Math.tan((this.camera.fov * Math.PI) / 360);
    BruiserActor.overlays = !this.endcardUp && !this.fkc;
    const list = this.interpPlayers();
    // THE POSES THIS FRAME IS ABOUT TO PUT ON SCREEN, kept for hit prediction.
    // predictHit runs from fixed(), which loop() drains BEFORE draw(), so it can
    // only ever see the PREVIOUS frame's list — which is the correct one: the
    // command it is predicting carries that frame's render instant (cmd.rt =
    // renderT, set right above by interpPlayers), and that is the instant the
    // server rewinds to. Reading the roster instead is the defect this exists to
    // make impossible; see predictHit.
    this.drawn = list;
    // MEMBERSHIP from the newest snapshot actually received, POSITIONS from the
    // interpolated list. Rebuilding membership from `list` was the frame-rate
    // coupling applyRoster exists to kill, and it also dropped a player for one
    // whole frame every time somebody joined — the interpolation window is
    // INTERP_MS behind the wire, so a brand-new body is in the roster before it
    // is in the pair being drawn between. Offline (`session`) keeps its own
    // roster in syncFromSession and interpPlayers hands it straight back.
    if (!this.session) this.applyRoster(this.snaps.length ? this.snaps[this.snaps.length - 1]!.players : []);
    for (const p of list) this.players.set(p.id, p);
    this.recordFrame(list);

    // KILLCAM REPLAY playhead — advanced HERE, before the actor loop, so the
    // bodies this frame poses come off the tape and not off the wire. The tape
    // keeps recording the live list above throughout, so the tail past the kill
    // is already on it by the time the playhead gets there.
    // feel stream: the FINAL KILLCAM plays off its own clip (final-killcam.ts) and outranks everything.
    const fk = this.fkc;
    const kcKiller = fk ? fk.clip.kill.src : this.killerId;
    const replayOn = !!fk || (this.killcamT > 0 && !!this.killerId && this.kcClock >= 0 && !this.spectateCam);
    let alist = list;
    if (fk) {
      alist = this.tickFinalKillcam(dt);
    } else if (replayOn) {
      this.kcClock = Math.min(this.kcClock + dt * 1000, this.kcFreeze);
      alist = this.replayAt(this.kcClock);
      this.replayShotsTo(this.kcClock);
      // A one-life cut has no respawn to end the freeze frame on: once the tape
      // has held its tail, hand the bodies back and follow the killer live
      // (frameKiller) for the rest of the round.
      if (this.killcamDur > RESPITE && this.kcClock >= this.kcFreeze) this.kcClock = -1;
    }
    if (this.kcReplayOn && !replayOn) {
      // The cut just ended: hand every body back to the wire. The you-actor is
      // reaped by the removal loop below; the killer gets their body back now
      // (the visibility line inside the loop only runs for live players).
      for (const a of this.actors.values()) a.root.visible = true;
      if (this.youMarker) this.youMarker.visible = false;
      this.kcClock = -1;
    }
    if (this.kcReplayOn !== replayOn) this.footstepCadence.clear();
    this.kcReplayOn = replayOn;

    for (const p of alist) {
      // Your own body has no actor in live play (you are the camera) — but the
      // replay is shot through the KILLER's eyes, so there it needs one.
      if (p.id === this.you && !replayOn) continue;
      let a = this.actors.get(p.id);
      if (!a && this.bruiserTpl) {
        a = this.preparedActors.pop();
        if (a) a.claim(p);
        else a = new BruiserActor(p, this.bruiserTpl);
        this.calibrateRig(a);
        const meT = this.me();
        a.setRelation(p.id === this.you || (this.opts?.mode !== "ffa" && !!meT && p.team === meT.team));
        this.actors.set(p.id, a);
        // weapons stream: the 3P muzzle flash is WeaponFx's per-weapon cards — retire the actor's old sprite
        const oldFlash = (a as unknown as { flashSprite?: THREE.Sprite }).flashSprite;
        if (oldFlash) (oldFlash.material as THREE.Material).visible = false;
        this.world!.scene.add(a.root);
      }
      if (!a) continue;
      // Relation is re-asserted every frame (setRelation no-ops when nothing
      // changed): the construct-time-only call latched "enemy" forever on any
      // actor built before me() resolved or before the server corrected the
      // room's mode.
      {
        const meT = this.me();
        a.setRelation(p.id === this.you || (this.opts?.mode !== "ffa" && !!meT && p.team === meT.team));
      }
      // Render-only step ease on remote bodies (fix-round-3 order 5). The
      // ORIGINAL `p` goes on to plantOnHitbox and is what the hit list holds;
      // only the drawn root moves.
      a.apply(p.id === this.you ? p : { ...p, y: this.remoteStepY(p, dt) }, dt);
      // weapons stream: an enemy reloading is AUDIBLE (CoD's push cue) — the sim
      // sends no event, so a fresh rise of the snapshot's reload timer is the start.
      if (!replayOn && p.id !== this.you) {
        const was = this.remoteReload.get(p.id) ?? 0;
        if (p.alive && p.reload > was + 0.3) this.audio.reloadRemote(p.weapon, p.reload, p.x, p.y + 1.1, p.z, p.id);
        this.remoteReload.set(p.id, p.reload);
      }
      this.plantOnHitbox(a, p);
      if (replayOn) {
        // First person: the killer IS the camera, so their body stays off it.
        a.root.visible = p.id !== kcKiller;
      } else {
        const meNow = this.me();
        if (meNow && p.alive) {
          const d = Math.hypot(p.x - meNow.x, p.z - meNow.z);
          a.root.visible = d > 0.85;
        }
      }
    }
    for (const [id, a] of this.actors) {
      if (!this.players.has(id) || (id === this.you && !replayOn)) {
        this.world!.scene.remove(a.root);
        a.dispose();
        this.actors.delete(id);
      }
    }
    // Remote tracers spawn after actor poses update so they leave the fresh
    // muzzle. During the replay the live ones are DROPPED, not deferred: the
    // actors are posed on the tape, so a wire-time tracer would leave a gun
    // that is seconds away from where that player is standing.
    if (!replayOn) for (const e of this.pendingShots) this.spawnTracer(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, e.src, false, e.weapon); // weapons stream: + weapon
    this.pendingShots.length = 0;

    const me = this.me();
    this.lastShot += dt;
    // Visual punch only — recY/recP are AIM and are decayed on the fixed tick.
    this.punchY *= Math.exp(-18 * dt);
    this.punchP *= Math.exp(-18 * dt);
    // Reconciliation residual glides out over ~100 ms (render-only, see errX).
    const errK = Math.exp(-14 * dt);
    this.errX *= errK;
    this.errY *= errK;
    this.errZ *= errK;
    // CINEMATIC uniforms (WebGL) OR TSL pipeline tick (WebGPU): uTime/uHurt/
    // uAds live on exactly one of the two paths — never on both.
    if (this.grade) {
      this.grade.uniforms.uTime.value += dt;
      this.grade.uniforms.uHurt.value = Math.max(0, this.grade.uniforms.uHurt.value - dt * 2.4);
      this.grade.uniforms.uAds.value = me?.ads ?? 0;
    } else {
      this.pipeline?.setAds(me?.ads ?? 0);
    }

    // SPECTATING FIRST (client/src/spectate.ts). It owns the camera, the
    // viewmodel and the audio listener for as long as this client is benched, and
    // it is the same one camera the branches below move — never a second view.
    // The hook is null for every playing client, so this is one property test.
    if (fk) {
      // feel stream: FINAL KILLCAM — the killer's eye and gun, off the clip.
      if (this.ghostRing) this.ghostRing.visible = false;
      this.finalCam(alist, dt);
    } else if (this.spectateCam && this.spectateCam(dt)) {
      if (this.ghostRing) this.ghostRing.visible = false;
    } else if (this.killcamT > 0 && this.killerId) {
      this.killcamT -= dt;
      // Back in the fight = cut. In net play the snapshot can lag the kill
      // event, so only after the cut has actually been on screen for a beat.
      if (me?.alive && this.killcamT < this.killcamDur - 0.5) this.killcamT = 0;
      // The death flash belongs to the death, not to the cut: clear the blood
      // grade fast so the killcam is a clean picture of who did it. WebGPU:
      // the hurt decay runs in the pipeline tick (renderFrame), nothing here.
      if (this.grade) this.grade.uniforms.uHurt.value *= Math.exp(-7 * dt);
      const k = this.players.get(this.killerId);
      if (replayOn) {
        // THE REPLAY: the camera is the killer's own eye, walked along the
        // tape. Your body is on screen in third person under the YOU tag.
        const rk = alist.find((p) => p.id === this.killerId);
        if (rk) {
          this.kcLost = 0;
          this.replayCam(rk, dt);
          this.killerGun(rk, dt, true); // feel stream: the killer's gun in the death killcam too
        } else {
          this.kcLost += dt;
          if (this.kcLost > 0.3) {
            this.killcamT = 0;
            this.kcClock = -1;
          }
        }
        this.placeYouMarker(alist);
      } else if (k) {
        this.kcLost = 0;
        // ONE LIFE PER ROUND: the follow runs until the next round, and the
        // killer may well die in the meantime. Staring at their corpse for a
        // minute is not a spectator seat, so a dead killer hands the camera to
        // a living body — a teammate first, anybody otherwise. RESPITE-length
        // cuts (every other room) never get here with a dead killer for long.
        const follow = this.killcamDur > RESPITE && !k.alive ? (this.aliveFollow() ?? k) : k;
        this.frameKiller(follow);
        this.showGhostRing();
      } else {
        // The killer left the match. Staring at the hole where they stood is
        // not a killcam — cut back. The grace absorbs a snapshot hiccup.
        this.kcLost += dt;
        if (this.kcLost > 0.3) this.killcamT = 0;
        this.showGhostRing();
      }
      document.getElementById("killcam")?.classList.remove("hidden");
      document.getElementById("hud")?.classList.add("killcam-on");
      if (!replayOn) {
        this.vm.root.visible = false;
        this.whud.spectScoped = false;
      }
      this.paintKillcam(k);
    } else {
      if (this.ghostRing) this.ghostRing.visible = false;
      document.getElementById("killcam")?.classList.add("hidden");
      document.getElementById("hud")?.classList.remove("killcam-on");
      // A corpse holds no gun: the viewmodel stays away until you are alive
      // again (qa/out/killcam.json corpseCamWithViewmodel).
      this.vm.root.visible = me ? me.alive : true;
      if (me) {
        const eyeTarget = me.slide > 0 ? SLIDE_EYE : me.crouch ? CROUCH_EYE : EYE;
        this.eyeSmooth += (eyeTarget - this.eyeSmooth) * (1 - Math.exp(-14 * dt));
        const phase = this.nowMs() * 0.001 * (me.sprint ? 19 : 12.5);
        const moveF = Math.min(1, Math.hypot(me.vx, me.vz) / 4);
        const bob = Math.sin(phase) * (me.sprint ? 0.042 : me.crouch ? 0.012 : 0.022) * moveF;
        // Blast shake: a fast decaying wobble on the LOOK only. It never moves
        // the eye (that would clip walls) and never touches aim — recY/recP are
        // the aim channel and are decayed on the fixed tick, not here.
        let shakeX = 0;
        let shakeZ = 0;
        if (this.shakeAmp > 0.0004) {
          this.shakeT += dt;
          const decay = Math.exp(-9 * this.shakeT);
          this.shakeAmp *= Math.exp(-9 * dt);
          shakeX = Math.sin(this.shakeT * 71) * this.shakeAmp * decay;
          shakeZ = Math.sin(this.shakeT * 53 + 1.1) * this.shakeAmp * decay * 1.3;
        } else {
          this.shakeAmp = 0;
        }
        // --- step smoothing: absorb the tread quantum, hand it back at 3 m/s ---
        /**
         * THE CAP IS PER MAP (fix-round-3 order 5). 0.45 m was chosen against
         * Shipment, whose only rises are the 0.20-0.45 m prop mantles, and it
         * is kept there — every archived Shipment feel note still holds. dust2
         * has an 0.8128 m vertical quantum: the judge's eyetrace measured an
         * 0.84 m single-frame camera pop at (32.6, -68.3), an AUTO-MANTLE the
         * body takes without a jump, and a cap of 0.45 refuses to smooth it at
         * all (the `rise > STEP_SMOOTH_MAX` branch zeroes the lag), so the one
         * pop that read as a teleport was the one pop left raw. dust2 declares
         * 0.90 — over its quantum plus weld slack, under the sim's own 1.05 m
         * mantle ceiling, so a real fall is still felt.
         */
        const STEP_SMOOTH_MAX = MAP.stepSmoothMax ?? 0.45;
        const STEP_SMOOTH_RATE = 3.0;
        if (this.lastFeetY !== null) {
          const rise = me.y - this.lastFeetY;
          // Only an UPWARD snap the body took while on the ground, and only one
          // small enough to be a step rather than a fall or a teleport.
          if (rise > 0.0005 && rise <= STEP_SMOOTH_MAX && Math.abs(me.vy) < 0.5) {
            this.stepLag = Math.min(STEP_SMOOTH_MAX, this.stepLag + rise);
          } else if (rise < -STEP_SMOOTH_MAX || rise > STEP_SMOOTH_MAX) {
            this.stepLag = 0; // a fall, a mantle over the limit, a respawn: show it
          }
        }
        this.lastFeetY = me.y;
        this.stepLag = Math.max(0, this.stepLag - STEP_SMOOTH_RATE * dt);
        // CORNER LEAN (Q/E, view-only): ease toward the held keys, shift the
        // eye sideways — lean+ (E) is screen-right, i.e. the negated sim +ax
        // side (-(cos yaw, -sin yaw); sim +ax is LEFT, see the l/r swap at the
        // tick input mapping) — and bank the view (the yaw+PI camera banks
        // right with -lean, so the bank sign below is already correct). Dead
        // bodies lean nothing; the capsule never moves — only the muzzle follows
        // the eye (shared/sim.ts `leanEye`, same 0.3 m shift, wall-clamped).
        const leanTgt = ((this.keys.leanR ? 1 : 0) - (this.keys.leanL ? 1 : 0)) * (me.alive ? 1 : 0);
        this.leanSm += (leanTgt - this.leanSm) * (1 - Math.exp(-12 * dt));
        // WALL-CLAMPED LEAN (render side of shared/sim.ts `leanEye`, same
        // 0.30 m shift): the shot eye stops at the first solid, so the camera
        // must too — otherwise leaning into a wall parks the near plane inside
        // the steel (visual wallhack). The trace runs from the unshifted body
        // eye along the smoothed shift and only shortens the applied distance
        // (same all-or-nothing epsilon as `segmentClear`: full offset while
        // clear, 0 at full blockade). `leanSm` keeps easing underneath at its
        // own rate and is never written back to, so there is no per-frame snap
        // and no feedback loop — walking along a wall slides the free distance
        // smoothly instead of jittering.
        const leanDist = this.leanSm * 0.3;
        let leanClamped = leanDist;
        const leanLen = Math.abs(leanDist);
        if (leanLen > 1e-4) {
          const sgn = leanDist > 0 ? 1 : -1;
          const ldx = -Math.cos(this.yaw) * sgn;
          const ldz = Math.sin(this.yaw) * sgn;
          const baseX = me.x + this.errX;
          const baseY = me.y - this.stepLag + this.errY + this.eyeSmooth + bob;
          const baseZ = me.z + this.errZ;
          const tr = traceWorld(baseX, baseY, baseZ, ldx, 0, ldz, leanLen);
          leanClamped = sgn * (tr.t >= leanLen - 1e-4 ? leanLen : Math.max(0, tr.t - 1e-4));
        }
        const leanX = -Math.cos(this.yaw) * leanClamped;
        const leanZ = Math.sin(this.yaw) * leanClamped;
        this.camera.position.set(me.x + this.errX + leanX, me.y - this.stepLag + this.errY + this.eyeSmooth + bob, me.z + this.errZ + leanZ);
        // weapons stream: punch springs + trauma (visual) and the scope sway (aim).
        this.feel.update(dt);
        const fo = this.feel.offsets(this.feelOut);
        this.punchP = fo[0];
        this.punchY = fo[1];
        // Through a scope the look bob is the breathing, not the gait.
        const bobK = this.whud.scoped ? 0.15 : 1;
        this.camera.rotation.order = "YXZ";
        this.camera.rotation.y = this.yaw + Math.PI + this.recY + this.feel.swayY + fo[1];
        this.camera.rotation.x = -(this.pitch + this.recP + this.feel.swayP + fo[0]) + Math.sin(phase) * 0.0045 * moveF * bobK + shakeX;
        this.camera.rotation.z =
          (me.slide > 0 ? 0.1 : 0) - this.leanSm * 0.1 + fo[2] + fo[1] * 0.25 + Math.sin(phase * 0.5) * (me.sprint ? 0.009 : 0.006) * moveF * bobK + shakeZ;
        const w = WEAPON_BY_ID[me.weapon];
        // ADS FOV per weapon (WeaponDef.adsFov, authored against HIP_FOV) scaled to the
        // player's SETTINGS field of view (UI stream hook: vfov()). A sniper zooms a
        // little while the rifle comes up, then the SCOPE is the view — a hard cut,
        // as through a real optic (scope FOV stays absolute).
        const baseFov = vfov();
        const hipFov = me.sprint ? baseFov + 6 : baseFov;
        const adsE = me.ads * me.ads * (3 - 2 * me.ads);
        const scoped = !!w?.scope && me.ads >= SCOPE_AT && (me.swap ?? 0) <= 0;
        const adsFov = !w ? baseFov : w.scope ? w.adsFov : w.adsFov * (baseFov / HIP_FOV);
        const targetFov = !w ? hipFov : w.scope ? (scoped ? adsFov : hipFov + (50 - hipFov) * adsE) : hipFov + (adsFov - hipFov) * adsE;
        if (scoped || (w?.scope && this.fov < 40)) this.fov = targetFov;
        else this.fov += (targetFov - this.fov) * (1 - Math.exp(-18 * dt));
        this.camera.fov = this.fov;
        this.camera.updateProjectionMatrix();
        this.vm.setWeapon(me.weapon);
        this.audio.frame(this, me.weapon, me.alive); // weapons stream: raise foley on a swap, reload cut on death, FX impact/brass sounds
        this.vm.setSwap(w && (me.swap ?? 0) > 0 ? Math.min(1, (me.swap ?? 0) / w.swap) : 0);
        const reloadP =
          me.reload > 0 && w ? Math.min(1, Math.max(0.01, 1 - me.reload / ((me.ammo ?? 0) <= 0 ? w.emptyReload : w.reload))) : 0;
        if (me.reload > this.lastReloadVal + 0.3 && w) this.audio.reloadStart(me.weapon, me.reload);
        this.lastReloadVal = me.reload;
        this.vm.look(this.yaw, this.pitch);
        if (w) this.vm.setAmmo(me.ammo ?? 0, w.mag);
        this.vm.update(dt, me.ads, me.sprint, me.slide, Math.hypot(me.vx, me.vz) / 5, reloadP, this.punchY, me.crouch);
        // Scoped: the optic IS the view — the rifle is not drawn over it.
        if (scoped) this.vm.root.visible = false;
        this.audio.tickAmb(dt);
      }
    }

    // Listener and movement cues share this frame's camera and actor positions,
    // including spectator follow and killcam playback.
    this.camera.getWorldDirection(this.audioForward);
    this.audio.listen(this.camera.position.x, this.camera.position.y, this.camera.position.z,
      Math.atan2(this.audioForward.x, this.audioForward.z));
    this.updateFootsteps(alist, dt);

    // Frags enter the world only now, with every paw in this frame's pose.
    if (this.pendingNades.length) this.flushNades();
    this.tickFx(dt);
    this.tickHitmarker(dt);
    this.tickBanner(dt);
    this.medals.tick(this.nowMs()); // feel stream
    this.scorePops.tick(this.nowMs());
    this.tickDmgCue(dt);
    this.tickDmgNums(dt);
    this.world?.update(dt, this.camera);
    this.vm.pose.updateMatrix();
    this.vm.root.updateMatrix();
    this.vm.flashLightPos(this.vm.flash.position); // weapons stream: the flash light rides ahead of the muzzle (no blown-out gun)
    if (!this.vm.root.visible) this.vm.flash.intensity = 0;
    // Skinned meshes disable vertex-based culling because their animations
    // deform the bounds. Cull whole bodies with a conservative world-space
    // sphere while retaining their independent relation/name sprites.
    this.camera.updateMatrixWorld();
    this.actorFrustum.setFromProjectionMatrix(this.actorProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    for (const a of this.actors.values()) {
      this.actorSphere.center.copy(a.root.position).y += 1;
      // Hardware shadow maps can need an off-camera body as a caster.
      a.body.visible = this.renderer.shadowMap.enabled || this.actorFrustum.intersectsSphere(this.actorSphere);
    }
    this.renderFrame(dt);
    this.paintHud(dt);
  }

  /* ── MATCH FEEL: the countdown card and the two flashes ──────────────────
   * Both flashes are DERIVED FROM THE SNAPSHOT, not from a new net event, and
   * that is deliberate: `reserve` and `hp` are already replicated and already
   * authoritative, so one watcher covers online play, local bot matches and the
   * ?test rig identically and shared/protocol.ts does not grow a message for a
   * HUD flash. (It also means the flash can never disagree with the number
   * beside it — it IS that number's delta.)
   */
  private mfReserve = -1;
  private mfHp = 100;
  /** Lowest hp seen since the last time this body was whole. */
  private mfLowHp = 100;
  private mfAlive = false;

  /**
   * The dip that earns a RECOVERED cue. A graze healing back is not an event —
   * announcing 4 hp of chip damage would train the player to ignore the cue,
   * which is exactly what a notification must not do. 15 hp is one round of the
   * BUNCH CYLINDER's 28 with room to spare, so anything that ever mattered
   * qualifies and nothing that did not.
   */
  private static readonly MF_DIP = 15;

  private tickMatchFeel(me: PlayerSnap): void {
    const now = this.nowMs();
    const res = me.reserve ?? 0;
    // Dead, respawning, or the first frame of this seat: adopt the numbers in
    // silence. A respawn refills the reserve and the health by design, and
    // neither of those is a resupply or a recovery.
    if (!me.alive || !this.mfAlive) {
      this.mfAlive = me.alive;
      this.mfReserve = res;
      this.mfHp = me.hp;
      this.mfLowHp = me.hp;
      return;
    }
    // RESUPPLY. Any rise in the reserve while alive is ammunition the sim just
    // handed over — a kill's magazine or a scavenged clip. The threshold is 2 so
    // a reload (which MOVES rounds out of the reserve) can never read as one.
    if (res > this.mfReserve + 1) this.matchFeel.ammo(res - this.mfReserve, now, this.audio);
    this.mfReserve = res;
    // RECOVERED. Health arriving back at full after a dip that mattered.
    if (me.hp < this.mfLowHp) this.mfLowHp = me.hp;
    if (me.hp >= 99.5 && this.mfHp < 99.5 && this.mfLowHp <= 100 - Game.MF_DIP) {
      this.matchFeel.health(now, this.audio);
      this.mfLowHp = 100;
    }
    if (me.hp >= 99.5) this.mfLowHp = 100;
    this.mfHp = me.hp;
  }

  paintHud(dt: number): void {
    const me = this.me();
    if (!me || !this.onHud) return;
    const s = this.session;
    const score0 = s ? s.score0 : this.netScore0;
    const score1 = s ? s.score1 : this.netScore1;
    const remain = s ? s.remain : this.netRemain;
    const round = this.roundInfo();
    // DEAD IN A ONE-LIFE ROUND: the killcam has played, the body is down until
    // the next round. The paint hands this to main.ts, which puts the client
    // on the spectator POV restricted to living teammates (and takes it off the
    // instant the next round respawns the body).
    this.deadSpectate = !!round && !me.alive && this.killcamT <= 0 && me.team !== undefined && !this.fkc; // feel stream: not over the final killcam
    // The announcer listens to the same paint — GO, the clock, the lead.
    {
      const ffa = this.opts?.mode === "ffa";
      let bestOther = 0;
      if (ffa) for (const p of this.players.values()) if (p.id !== this.you) bestOther = Math.max(bestOther, num(p.kills));
      this.announcer.tick({
        live: this.matchLive() && !this.ended,
        remain,
        score0,
        score1,
        team: ffa ? -1 : me.team,
        ffa,
        myKills: num(me.kills),
        bestOther,
        modeLabel: this.gunGame ? "GUN GAME" : ffa ? "FREE FOR ALL" : round ? "ELIMINATION" : "TEAM DEATHMATCH",
        roundN: round ? round.n : 0,
      });
    }
    this.onHud({
      me,
      score0,
      score1,
      remain,
      players: [...this.players.values()],
      you: this.you,
      locked: this.locked,
      mode: this.opts?.mode ?? "tdm",
      gun: this.gunGame,
      gunKills: this.gunKills,
      round,
      spectating: !!this.spectateCam,
    });
    // SAT OUT (round-based TDM): a seat that arrived mid-round lies dead with
    // no killer and no killcam until the next round respawns it. Say so once
    // per wait, or the first thing a late joiner sees is a still yard and a
    // dead HUD with no word on why.
    if (round && !me.alive && this.killcamT <= 0 && !this.spectateCam) {
      if (!this.sitOutSaid) {
        this.sitOutSaid = true;
        this.banner("IN NEXT ROUND", 3);
      }
    } else if (me.alive) this.sitOutSaid = false;
    // SPECTATING: three readouts about a body this client does not have. The
    // minimap is a 180x180 canvas-2D repaint EVERY FRAME of a ghost nobody else
    // can see, the frag pips describe nanas that cannot be thrown, and the
    // match-feel watcher tracks a health pool the server pins at 999 for a benched
    // seat. Skipping them is why a spectating frame measures faster than a playing
    // one instead of slower.
    // weapons stream: hud-api feed + scope / cook ring / grenade danger.
    {
      const b = this.heldBody();
      this.whud.update({
        me: (b ? { ...me, ...b } : me) as never,
        fov: this.fov,
        cook: this.localCook(),
        cooking: this.nadePhase === 1 || (this.nadePhase === 2 && !this.nadeSent),
        nades: this.nadeLive,
        camera: this.camera,
        breath: this.feel.breath,
        breathOut: this.feel.breathOut,
        breathHold: this.feel.breathHold,
        visible: !this.spectateCam && this.killcamT <= 0 && !this.fkc, // feel stream: the final killcam drives its own scope (finalCam)
      });
    }
    // feel stream: the low-health heartbeat (only for the body you are actually playing, in a live match)
    this.extras.heartbeat(me.hp, me.alive && !this.spectateCam && this.killcamT <= 0 && !this.ended && this.matchLive(), this.nowMs() / 1000, dt);
    if (!this.spectateCam) {
      this.crossRelation(me);
      this.paintNades(me, dt);
      this.drawMap(me);
      // AFTER onHud: the flashes light readouts that paintHud has just written, so
      // they run last and are handed straight back (MatchFeel.tickPulse).
      this.tickMatchFeel(me);
    }
    const phase = this.matchPhase();
    if (!this.session && phase === "countdown" && this.countdownLeftMs() <= 0) this.netPhase = "live";
    this.matchFeel.update(this.nowMs(), phase, this.countdownLeftMs(), this.audio);
  }

  /**
   * FRIEND-OR-FOE ON THE CROSSHAIR. The exact ray a fire command would carry
   * (aimDir off yaw/pitch, tested against the drawn poses and the world, same
   * as predictHit) — red ticks over an enemy, amber over a squadmate. Aiming
   * at a teammate used to produce silence: predictHit skips allies, so the
   * player got ambiguity exactly when they were asking "do I shoot this?".
   */
  private crossRelation(me: PlayerSnap): void {
    const cross = document.getElementById("cross");
    if (!cross) return;
    const { dx, dy, dz } = aimDir(this.yaw, this.pitch);
    const ox = me.x;
    const oy = me.y + this.eyeSmooth;
    const oz = me.z;
    const wall = traceWorld(ox, oy, oz, dx, dy, dz, 180);
    let bestT = wall.t;
    let rel = "";
    let foe = "";
    let shielded = false;
    for (const p of this.drawn) {
      if (p.id === this.you || !p.alive) continue;
      const t = rayPlayer(ox, oy, oz, dx, dy, dz, p);
      if (t < bestT) {
        bestT = t;
        rel = this.opts?.mode !== "ffa" && p.team === me.team ? "friend" : "foe";
        foe = rel === "foe" ? p.id : "";
        shielded = rel === "foe" && p.protect > 0;
      }
    }
    // feel stream: an enemy still under spawn protection — your rounds will not count, and the crosshair says so
    cross.classList.toggle("protected", shielded);
    // feel stream: an enemy under the crosshair shows its red marker + name (CoD)
    if (foe) this.markEnemy(foe, 450);
    cross.classList.toggle("foe", rel === "foe");
    cross.classList.toggle("friend", rel === "friend");
  }

  private nadePips: HTMLElement[] = [];
  private nadeHintShown = false;
  private nadeHintT = 0;

  /**
   * Frag pips beside the ammo, and the G hint — once per session, on the first
   * spawn, gone the moment you use it or after a few seconds.
   */
  private paintNades(me: PlayerSnap, dt: number): void {
    const box = document.getElementById("nades");
    if (box) {
      if (!this.nadePips.length) this.nadePips = [...box.querySelectorAll("i")] as HTMLElement[];
      const n = me.nades ?? 0;
      for (let i = 0; i < this.nadePips.length; i++) {
        this.nadePips[i]!.classList.toggle("spent", i >= n);
      }
      box.classList.toggle("ready", this.nadePhase === 1);
    }
    const hint = document.getElementById("nadehint");
    if (!hint) return;
    if (!this.nadeHintShown && me.alive && this.locked) {
      this.nadeHintShown = true;
      this.nadeHintT = 5;
      hint.classList.remove("hidden");
    }
    if (this.nadeHintT > 0) {
      // Seconds, not frames: at 240 fps a per-frame decrement would flash the
      // hint for a second and a quarter.
      this.nadeHintT -= dt;
      hint.style.opacity = String(Math.min(1, this.nadeHintT / 0.6));
      if (this.nadeHintT <= 0) hint.classList.add("hidden");
    }
  }

  private hideNadeHint(): void {
    this.nadeHintT = 0;
    this.nadeHintShown = true;
    document.getElementById("nadehint")?.classList.add("hidden");
  }

  // ---------------------------------------------------------------- killcam --

  private kcHead = new THREE.Vector3();

  /** How deep a point sits inside a map collider. 0 = free air. */
  private solidDepth(x: number, y: number, z: number): number {
    let worst = 0;
    for (const o of MAP_SOLIDS) {
      const l = worldToLocal(o, x, z);
      const dx = o.sx * 0.5 - Math.abs(l.x);
      if (dx <= 0) continue;
      const dz = o.sz * 0.5 - Math.abs(l.z);
      if (dz <= 0) continue;
      const dyT = o.y + o.sy * 0.5 - y;
      const dyB = y - (o.y - o.sy * 0.5);
      if (dyT <= 0 || dyB <= 0) continue;
      const d = Math.min(dx, dz, dyT, dyB);
      if (d > worst) worst = d;
    }
    return worst;
  }

  /** Nothing in the map stands between the two points — a bullet's own test. */
  private clearSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return true;
    const reach = L - 0.06;
    return traceWorld(ax, ay, az, dx / L, dy / L, dz / L, reach).t >= reach;
  }

  /**
   * True when another body stands in the line — a killcam that frames a
   * teammate's back instead of the killer's is no answer to "who killed me"
   * (qa/out/killcam.json killcam-blocked-by-another-player, the decoy runs).
   */
  private bodyInLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number, killer: string): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return false;
    for (const p of this.players.values()) {
      if (p.id === killer || p.id === this.you) continue;
      if (Math.hypot(p.x - bx, p.z - bz) > 7) continue;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / len2));
      if (t <= 0.02 || t >= 0.98) continue;
      if (Math.hypot(ax + dx * t - p.x, az + dz * t - p.z) > 0.42) continue;
      const y = ay + (by - ay) * t;
      if (y > p.y - 0.1 && y < p.y + 1.8) return true;
    }
    return false;
  }

  /** The killer's head in world space — the real bone when the actor has one. */
  private headPoint(p: PlayerSnap, out: THREE.Vector3): THREE.Vector3 {
    const a = this.actors.get(p.id);
    const hb = a?.bones?.Head;
    if (hb) {
      a!.root.updateMatrixWorld(true);
      hb.getWorldPosition(out);
      // Sanity, not stance: a dying bruiser's head ends up well below standing
      // height and a metre from its own root, and that is exactly the head the
      // cut has to keep in frame. Only a bone that is nowhere near the body is
      // rejected.
      if (Math.hypot(out.x - p.x, out.z - p.z) < 2.5 && Math.abs(out.y - p.y) < 2.5) return out;
    }
    return out.set(p.x, p.y + (p.crouch ? 1.18 : 1.6), p.z);
  }

  /**
   * KILLCAM FRAMING. Sweep back from the killer along the kill sightline and
   * keep the best camera that (a) is not inside a collider, (b) has clear sight
   * of the killer's head AND chest, (c) can hold the whole body between the
   * letterbox bars. The shipped camera was a hard 0.6 m floor straight behind
   * the killer's own yaw, which pushed the eye THROUGH the wall it had just
   * measured on 20 of 30 rig deaths, and beheaded the killer on 24 of 30
   * (qa/out/killcam.json: burial mode + headGone).
   */
  private frameKiller(k: PlayerSnap): void {
    const head = this.headPoint(k, this.kcHead);
    const chestY = k.y + (k.crouch ? 0.86 : 1.14);
    const feetY = k.y + 0.08;
    // The sightline: the camera sits on the far side of the killer from your
    // body and looks down the line that killed you, so the killer is centre
    // frame and your ghost ring lies beyond them.
    let bx = -Math.sin(k.yaw);
    let bz = -Math.cos(k.yaw);
    const d0 = this.deathAt;
    if (d0) {
      const vx = k.x - d0.x;
      const vz = k.z - d0.z;
      const L = Math.hypot(vx, vz);
      if (L > 1.2) {
        bx = vx / L;
        bz = vz / L;
      }
    }
    // How far the camera may swing before it leaves the map. This was
    // `lim = HALF - 0.5` — one scalar for both axes, i.e. a square yard. On a
    // 106 x 123 m rectangle that pins every killcam inside a 32 m box at the
    // world origin, which for dust2 is somewhere under mid. It is a rect now,
    // and `p` is compared against that axis's own two edges.
    const edgeIn = (p: number, dir: number, lo: number, hi: number): number => {
      if (dir > 1e-6) return (hi - p) / dir;
      if (dir < -1e-6) return (lo - p) / dir;
      return Infinity;
    };
    const bx0 = MAP.bounds.minX + 0.5;
    const bx1 = MAP.bounds.maxX - 0.5;
    const bz0 = MAP.bounds.minZ + 0.5;
    const bz1 = MAP.bounds.maxZ - 0.5;
    const edgeX = (p: number, dir: number): number => edgeIn(p, dir, bx0, bx1);
    const edgeZ = (p: number, dir: number): number => edgeIn(p, dir, bz0, bz1);
    // Traded mid-cut: hold the camera that was already framing them and let the
    // body fall inside the shot (the framing below still tracks it down). A new
    // sweep every frame would chase a collapsing skeleton around the yard.
    let best: { x: number; y: number; z: number } | null = !k.alive && this.kcPlaced ? this.kcPos : null;
    let bestScore = -1e9;
    for (const camH of best ? [] : KC_HEIGHTS) {
      const oy = k.y + camH;
      for (const a of KC_ARC) {
        const c = Math.cos(a);
        const s = Math.sin(a);
        const dx = bx * c - bz * s;
        const dz = bx * s + bz * c;
        let d = Math.min(KC_IDEAL, traceWorld(k.x, oy, k.z, dx, 0, dz, KC_IDEAL + KC_CLEAR).t - KC_CLEAR);
        d = Math.min(d, edgeX(k.x, dx), edgeZ(k.z, dz));
        if (d < KC_MIN) continue;
        const px = k.x + dx * d;
        const pz = k.z + dz * d;
        if (this.solidDepth(px, oy, pz) > 0) continue;
        if (!this.clearSight(px, oy, pz, head.x, head.y, head.z)) continue;
        if (!this.clearSight(px, oy, pz, k.x, chestY, k.z)) continue;
        if (this.bodyInLine(px, oy, pz, k.x, chestY, k.z, k.id)) continue;
        const feet = this.clearSight(px, oy, pz, k.x, feetY, k.z);
        // Distance buys framing; swinging off the sightline and off eye height
        // costs readability, so both are paid for. The sweet spot is a shoulder
        // off the line (KC_SHOULDER) — dead astern hides your own ghost ring
        // behind the very body the shot is about.
        const score =
          d * 1.4 + (feet ? 1.1 : 0) - Math.abs(Math.abs(a) - KC_SHOULDER) * 0.62 - Math.abs(camH - KC_HEIGHTS[0]!) * 0.8;
        if (score > bestScore) {
          bestScore = score;
          best = { x: px, y: oy, z: pz };
        }
      }
    }
    // Boxed in on every ray: take the roomiest clear spot there is, even if the
    // killer is partly screened. Being outside the wall always beats being in it.
    if (!best) {
      let bestD = -1;
      for (const camH of KC_FALLBACK_HEIGHTS) {
        const oy = k.y + camH;
        for (const a of KC_ARC) {
          const c = Math.cos(a);
          const s = Math.sin(a);
          const dx = bx * c - bz * s;
          const dz = bx * s + bz * c;
          let d = Math.min(2.6, traceWorld(k.x, oy, k.z, dx, 0, dz, 3.0).t - 0.4);
          d = Math.min(d, edgeX(k.x, dx), edgeZ(k.z, dz));
          if (d < 0.8 || d <= bestD) continue;
          const px = k.x + dx * d;
          const pz = k.z + dz * d;
          if (this.solidDepth(px, oy, pz) > 0) continue;
          bestD = d;
          best = { x: px, y: oy, z: pz };
        }
      }
    }
    if (!best) best = { x: k.x, y: k.y + 2.3, z: k.z + 0.45 };
    this.kcPos = best;
    this.kcPlaced = true;

    // FRAMING. With the killer on the frame's vertical centre line the screen
    // height of a point is v = 0.5 - 0.5*tan(elev - pitch)/tan(fov/2). Solve fov
    // AND pitch so the top of the silhouette lands 20% down the frame — the
    // letterbox eats the top 9%, so that is an 11% clear margin over the bar,
    // measured on the SILHOUETTE and not on the head bone (the bruiser's skull
    // stands 0.4 m proud of its Head bone) — and the boots land at 88%.
    // Aim at the body's own axis, not at the root: a killer who is dying during
    // the cut falls away from their feet, and the head is what must stay framed.
    const dead = !k.alive;
    const ax = dead ? head.x : (head.x + k.x) * 0.5;
    const az = dead ? head.z : (head.z + k.z) * 0.5;
    const horiz = Math.max(0.35, Math.hypot(best.x - ax, best.z - az));
    const ah = Math.atan2((dead ? head.y + 0.5 : Math.max(head.y + 0.4, k.y + 0.7)) - best.y, horiz);
    const af = Math.atan2(Math.min(feetY, head.y) - 0.16 - best.y, horiz);
    const span = Math.max(0.08, ah - af);
    let lo = 0.32;
    let hi = 0.92;
    for (let i = 0; i < 16; i++) {
      const T = (lo + hi) * 0.5;
      if (Math.atan(0.6 * T) + Math.atan(0.76 * T) < span) lo = T;
      else hi = T;
    }
    const fov = Math.min(74, Math.max(40, (Math.atan((lo + hi) * 0.5) * 360) / Math.PI));
    const T = Math.tan((fov * 0.5 * Math.PI) / 180);
    const pitch = ah - Math.atan(0.6 * T);
    this.camera.position.set(best.x, best.y, best.z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(ax, best.y + Math.tan(pitch) * horiz, az);
    if (Math.abs(this.camera.fov - fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // Hand the live-play smoother the value the player is actually looking
    // through, so the first frame back is a punch-in, not a jump-cut.
    this.fov = fov;
  }

  /** The banana-yellow ghost ring on the spot where you fell, fading as it goes. */
  private showGhostRing(): void {
    const at = this.deathAt;
    if (!at || !this.world) return;
    if (!this.ghostRing) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.54, 0.84, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffd24a,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 4;
      this.ghostRing = m;
      this.world.scene.add(m);
    }
    const r = this.ghostRing;
    const t = Math.max(0, Math.min(1, 1 - this.killcamT / Math.max(0.001, this.killcamDur)));
    r.visible = !this.endcardUp;
    r.position.set(at.x, at.y + 0.04, at.z);
    const s = 1 + t * 0.55;
    r.scale.set(s, s, 1);
    (r.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t) + 0.06;
  }

  /**
   * THE TAPE. Every drawn frame lands here at ~33 Hz on the renderT clock —
   * exactly the world the player saw, prediction and interpolation included —
   * so the killcam can rewind it. ~4.5 s is kept; a replay needs 2.35.
   */
  private recordFrame(list: PlayerSnap[]): void {
    const t = this.renderT * 1000;
    if (this.rec.length) {
      const last = this.rec[this.rec.length - 1]!.t;
      if (t - last < KC_REC_MS) return;
      // The render clock stepped backwards (server-clock EMA correction, match
      // rollover): a tape that spans the step would interpolate through it.
      if (t < last) {
        this.rec.length = 0;
        this.recShots.length = 0;
        this.recHits.length = 0;
      }
    }
    const frame = { t, players: list.map((p) => ({ ...p })) };
    this.rec.push(frame);
    this.fkTape.frame(frame); // feel stream: open final-killcam clips collect their tail
    while (this.rec.length && this.rec[0]!.t < t - KC_REC_KEEP_MS) this.rec.shift();
    // (the replay cursors index these lists: keep them on the same entries as the front is pruned)
    while (this.recShots.length && this.recShots[0]!.t < t - KC_REC_KEEP_MS) {
      this.recShots.shift();
      if (this.kcShotIdx > 0) this.kcShotIdx--;
    }
    while (this.recHits.length && this.recHits[0]!.t < t - KC_REC_KEEP_MS) {
      this.recHits.shift();
      if (this.kcHitIdx > 0) this.kcHitIdx--;
    }
  }

  /** The tape's poses at playhead t — same adjacent-pair interpolation as live. */
  private replayAt(t: number, r: { t: number; players: PlayerSnap[] }[] = this.rec): PlayerSnap[] {
    if (!r.length) return [];
    let i = 0;
    for (let k = 0; k < r.length - 1; k++) if (r[k]!.t <= t) i = k;
    const a = r[i]!;
    const b = r[Math.min(i + 1, r.length - 1)]!;
    const f = Math.max(0, Math.min(1, (t - a.t) / Math.max(1, b.t - a.t)));
    const out: PlayerSnap[] = [];
    for (const pb of b.players) {
      const pa = a.players.find((x) => x.id === pb.id) ?? pb;
      out.push({
        ...pb,
        x: pa.x + (pb.x - pa.x) * f,
        y: pa.y + (pb.y - pa.y) * f,
        z: pa.z + (pb.z - pa.z) * f,
        yaw: pa.yaw + angWrap(pb.yaw - pa.yaw) * f,
        pitch: pa.pitch + (pb.pitch - pa.pitch) * f,
      });
    }
    return out;
  }

  /** Every recorded shot the playhead just passed becomes a tracer again. */
  private replayShotsTo(t: number): void {
    while (this.kcShotIdx < this.recShots.length && this.recShots[this.kcShotIdx]!.t <= t) {
      const s = this.recShots[this.kcShotIdx++]!;
      this.spawnTracer(s.ox, s.oy, s.oz, s.dx, s.dy, s.dz, s.src, true);
      // feel stream: the killer's own rounds kick their gun in the viewmodel and are heard as theirs
      if (s.src === this.killerId) {
        if (this.vm.root.visible) this.vm.fire();
        this.audio.gun(s.weapon ?? "ar", s.ox, s.oy, s.oz, true);
      }
    }
    // feel stream: and their hits land as hitmarkers, as on their screen
    while (this.kcHitIdx < this.recHits.length && this.recHits[this.kcHitIdx]!.t <= t) {
      const h = this.recHits[this.kcHitIdx++]!;
      if (h.src !== this.killerId) continue;
      this.hitmarker(h.head, h.kill);
      this.audio.hitmarker(h.head, h.kill);
    }
  }

  /** The killer's first-person eye, straight off the tape pose. */
  private replayCam(k: PlayerSnap, dt: number): void {
    const eye = k.slide > 0 ? SLIDE_EYE : k.crouch ? CROUCH_EYE : EYE;
    this.camera.position.set(k.x, k.y + eye, k.z);
    this.camera.up.set(0, 1, 0);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = k.yaw + Math.PI;
    this.camera.rotation.x = -k.pitch;
    this.camera.rotation.z = 0;
    const w = WEAPON_BY_ID[k.weapon];
    const fov = k.ads > 0.5 && w ? w.adsFov : vfov(); // UI stream hook
    this.fov += (fov - this.fov) * (1 - Math.exp(-14 * dt));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * The YOU tag: an amber "YOU" over a down arrow, floating and bobbing above
   * your own head in the replay. depthTest off — the one thing this cut must
   * never do is lose track of which monkey you are.
   */
  private placeYouMarker(alist: PlayerSnap[]): void {
    if (!this.youMarker) {
      if (!this.world) return;
      const cv = document.createElement("canvas");
      cv.width = 256;
      cv.height = 224;
      const g = cv.getContext("2d")!;
      g.font = "900 88px Arial, sans-serif";
      g.textAlign = "center";
      g.lineJoin = "round";
      g.lineWidth = 16;
      g.strokeStyle = "rgba(10,10,10,0.95)";
      g.fillStyle = "#ffd24a";
      g.strokeText("YOU", 128, 84);
      g.fillText("YOU", 128, 84);
      g.beginPath();
      g.moveTo(128 - 40, 116);
      g.lineTo(128 + 40, 116);
      g.lineTo(128, 196);
      g.closePath();
      g.lineWidth = 12;
      g.stroke();
      g.fill();
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
      );
      s.scale.set(1.35, 1.18, 1);
      s.renderOrder = 30;
      this.youMarker = s;
      this.world.scene.add(s);
    }
    const meR = alist.find((p) => p.id === this.you);
    if (!meR || this.endcardUp) {
      this.youMarker.visible = false;
      return;
    }
    this.youMarker.visible = true;
    const bob = Math.sin(this.nowMs() * 0.004) * 0.09;
    this.youMarker.position.set(meR.x, meR.y + 2.85 + bob, meR.z);
    // Cancel perspective shrink past 8 m — this is the one tag the cut exists
    // to make unmissable, so it grows harder than the chevrons do.
    const d = Math.hypot(
      this.camera.position.x - meR.x,
      this.camera.position.y - meR.y,
      this.camera.position.z - meR.z,
    );
    const ds = Math.min(3.4, Math.max(1, d / 8));
    this.youMarker.scale.set(1.35 * ds, 1.18 * ds, 1);
  }

  /** Name plate, kill tag, the killer's remaining HP, countdown ring. */
  private paintKillcam(k: PlayerSnap | undefined): void {
    const set = (id: string, txt: string): void => {
      const el = document.getElementById(id);
      if (el && el.textContent !== txt) el.textContent = txt;
    };
    // #killer is the killer's NAME and only the name — every other word on the
    // plate has its own element (qa/out/killcam.json name-plate check).
    set("killer", this.killerName || k?.name || "UNKNOWN");
    set("kc-tag", this.killerTag || "");
    const hp = k ? Math.max(0, Math.min(100, Math.round(num(k.hp)))) : 0;
    const bar = document.getElementById("kc-hp");
    if (bar) {
      bar.style.width = `${hp}%`;
      bar.classList.toggle("low", hp <= 35);
    }
    set("kc-hpnum", k ? String(hp) : "—");
    const left = Math.max(0, this.killcamT);
    // One-life rounds have no respawn clock to count: the seat is back next round.
    set("kc-count", this.killcamDur > RESPITE ? "NEXT ROUND" : left.toFixed(1));
    const arc = document.getElementById("kc-arc");
    if (arc) arc.style.strokeDashoffset = String((1 - left / Math.max(0.001, this.killcamDur)) * KC_RING);
  }

  /** SKIP — cut the killcam and hand the screen straight back to the game. */
  killcamSkip(): void {
    // feel stream: SKIP the final killcam straight to the endcard (same 0.35 s arm).
    if (this.fkc) {
      if (this.fkc.phase === "play" && this.fkc.t > 0.35) this.endFinalKillcam();
      return;
    }
    // A trigger still held from the firefight must not eat the cut: SKIP arms
    // 0.35 s in.
    if (this.killcamT <= 0 || this.killcamT > this.killcamDur - 0.35) return;
    // ONE LIFE PER ROUND: there is no respawn behind the cut, so "skip" means
    // skip the replay — the live follow stays up until the next round respawns
    // you. Cutting to first person at your own corpse would leave a dead
    // screen for up to two minutes.
    if (this.killcamDur > RESPITE) {
      this.kcClock = -1;
      return;
    }
    this.killcamT = 0;
  }

  /**
   * A living body to follow while you wait for the next round: a teammate if
   * one is standing, else anyone; null when the yard is empty.
   */
  private aliveFollow(): PlayerSnap | null {
    const me = this.me();
    let any: PlayerSnap | null = null;
    for (const p of this.players.values()) {
      if (!p.alive || p.id === this.you) continue;
      if (me && p.team === me.team) return p;
      any ??= p;
    }
    return any;
  }

  /** The loaded radar for this map, or null (none declared, or still loading). */
  private radarImg: HTMLImageElement | null | undefined;
  private radarImage(): HTMLImageElement | null {
    if (this.radarImg === undefined) {
      const rel = MAP.minimapImage;
      if (!rel) {
        this.radarImg = null;
      } else {
        const img = new Image();
        img.decoding = "async";
        img.src = new URL(rel, document.baseURI).toString();
        this.radarImg = img;
      }
    }
    const img = this.radarImg;
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  drawMap(me: PlayerSnap): void {
    const c = document.getElementById("mmap") as HTMLCanvasElement | null;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    /**
     * THE CANVAS IS SIZED BY THE MAP, not by the markup.
     *
     * 180 px is a Shipment number: 180 px over a 33 m yard is 5.45 px/m, and a
     * 2.44 x 6.06 m container lands 13 x 33 px — a shape. The same 180 px over
     * dust2's 113.7 x 128 m is **1.41 px/m**, at which a 0.8 m doorway is one
     * pixel, a 2 m crate is three, and `docs/dustmap/spec-qa.md` §G7 records the
     * consequence plainly: below ~2 px/m the centroid-error numbers stop meaning
     * anything, so the gate could not be graded at all.
     *
     * So the backing store is whatever it takes to hold `MIN_PX_PER_M` over the
     * map's longer axis, clamped to `MAX_MMAP_PX` so the HUD corner stays a HUD
     * corner. dust2 resolves to 256 px = exactly 2.0 px/m; Shipment resolves to
     * the 180 it has always been, the assignment is skipped, and the projection
     * below is arithmetically identical to the archived one.
     *
     * The on-screen box follows in the same ratio the markup already uses
     * (168 CSS px for a 180 px store), so the canvas is never resampled to a
     * different aspect than it was drawn at.
     */
    const MIN_PX_PER_M = 2.0;
    const MAX_MMAP_PX = 256;
    const BASE_MMAP_PX = 180;
    const span = Math.max(MAP.bounds.maxX - MAP.bounds.minX, MAP.bounds.maxZ - MAP.bounds.minZ);
    const want = Math.max(BASE_MMAP_PX, Math.min(MAX_MMAP_PX, Math.ceil(span * MIN_PX_PER_M)));
    if (c.width !== want || c.height !== want) {
      c.width = want;
      c.height = want;
      const box = c.parentElement as HTMLElement | null;
      if (box) {
        const cssPx = Math.round((want * 168) / BASE_MMAP_PX);
        box.style.width = `${cssPx}px`;
        box.style.height = `${cssPx}px`;
      }
    }
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(8,10,12,0.85)";
    ctx.fillRect(0, 0, w, h);
    // THE PROJECTION. This was `((x + HALF) / (HALF*2)) * w` on both axes: one
    // scalar, a square map, and a fixed 180x180 canvas. dust2 is 106 x 123 m, so
    // a single scalar either crops it or stretches it into a different shape
    // than the one the player is walking. It is a LETTERBOX now — one uniform
    // metres-to-pixels scale sized by whichever axis is tighter, centred in the
    // canvas, so the drawn map is the map, in proportion, on any bounds rect.
    // Shipment's square yard fills the square canvas exactly as before.
    const bw = MAP.bounds.maxX - MAP.bounds.minX;
    const bh = MAP.bounds.maxZ - MAP.bounds.minZ;
    const k = Math.min(w / bw, h / bh);
    const ox = (w - bw * k) * 0.5;
    const oz = (h - bh * k) * 0.5;
    const sx = (x: number) => ox + (x - MAP.bounds.minX) * k;
    const sz = (z: number) => oz + (z - MAP.bounds.minZ) * k;
    /**
     * Sight/heard radii below are metre counts tuned against a 33 m yard.
     * `audioScale` is this map's distance scale (1 on Shipment, 2.2 on dust2) —
     * the same multiplier the audio rig applies for the same reason, so an
     * 11 m blip radius does not become a 3-container bubble on a 123 m map.
     */
    const range = MAP.audioScale;
    // Desaturated fills so threat colors (red/teal) stay reserved for blips.
    const MAP_COL: Record<string, string> = {
      red: "#6f625c",
      blue: "#5c666e",
      orange: "#6e675a",
      green: "#5f6a5a",
      sand: "#6e6558",
    };
    // A map that ships a RADAR (MapDef.minimapImage — dust2's walkable floor as
    // a flat fill with its boundary as a line) draws that, covering exactly
    // `bounds` in the same projection as everything below. The rect pass is
    // what Shipment draws, and what any map draws until its radar has loaded.
    const radar = this.radarImage();
    if (radar) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(radar, sx(MAP.bounds.minX), sz(MAP.bounds.minZ), bw * k, bh * k);
    }
    for (const v of radar ? [] : MAP.minimap) {
      ctx.save();
      ctx.translate(sx(v.x), sz(v.z));
      // Canvas space (x right, z down) has the sim's own handedness, so the OBB
      // yaw goes in UNFLIPPED here. three.js is the mirrored one — that is why
      // the world builder wraps every prop in RENDER_YAW and this does not.
      // Verified against the live meshes: 100% of the tilted wrecks' vertices
      // fall inside the +yaw footprint drawn here, 35.8% inside the mirror.
      ctx.rotate(v.yaw);
      ctx.fillStyle = MAP_COL[v.color ?? "sand"] ?? "#8a8578";
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      const rw = v.sx * k;
      const rh = v.sz * k;
      ctx.fillRect(-rw / 2, -rh / 2, rw, rh);
      // A 1 px stroke on a 3 px rect is all stroke: outline only the footprints
      // big enough to read as shapes, so a dense map does not turn into a grey
      // wash. Shipment's containers are 9-17 px and all keep their outline.
      if (rw > 4 && rh > 4) ctx.strokeRect(-rw / 2, -rh / 2, rw, rh);
      ctx.restore();
    }
    const now = this.nowMs() / 1000;
    const ffa = this.opts?.mode === "ffa";

    // ---- your view cone: which way the map is being read from ---------------
    ctx.save();
    ctx.translate(sx(me.x), sz(me.z));
    ctx.rotate(Math.PI - me.yaw);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let i = -6; i <= 6; i++) {
      const a = (i / 6) * 0.52;
      ctx.lineTo(Math.sin(a) * 30, -Math.cos(a) * 30);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.12)"; // UI stream: neutral view cone
    ctx.fill();
    ctx.restore();

    // ---- live frags near you: the one thing worth shouting about ------------
    for (const n of this.nadeLive) {
      if (Math.hypot(n.x - me.x, n.z - me.z) > 12 * range) continue;
      const pulse = 0.5 + 0.5 * Math.sin(now * 13);
      ctx.save();
      ctx.translate(sx(n.x), sz(n.z));
      ctx.fillStyle = `rgba(255,124,40,${(0.45 + 0.4 * pulse).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,124,40,${(0.45 * pulse).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, 5 + 3.5 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // ---- enemies: seen, or heard. never through a wall ----------------------
    // The old gate was pure XZ distance under a comment claiming "no wallhack
    // minimap"; qa/out/minimap.json measured a blip at exactly the same 11 m
    // through a closed container pair as across open ground. An enemy now
    // reaches the map only when somebody on your side has real line of sight to
    // them (the same trace a bullet takes) or when their own gunfire gave them
    // away inside the last 1.2 s — and that ping fades out where it was fired.
    const mates: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      if (p.alive && p.id !== this.you && !ffa && p.team === me.team) mates.push(p);
    }
    for (const p of this.players.values()) {
      if (!p.alive || p.id === this.you) continue;
      if (!ffa && p.team === me.team) continue;
      let seen = Math.hypot(p.x - me.x, p.z - me.z) <= 11 * range && this.canSee(me, p);
      if (!seen) {
        for (const m of mates) {
          if (Math.hypot(p.x - m.x, p.z - m.z) <= 22 * range && this.canSee(m, p)) {
            seen = true;
            break;
          }
        }
      }
      let px = p.x;
      let pz = p.z;
      let fade = 1;
      if (!seen) {
        const f = this.mapFired.get(p.id);
        if (!f || now - f.t > 1.2) continue;
        fade = 1 - (now - f.t) / 1.2;
        px = f.x;
        pz = f.z;
      }
      ctx.save();
      ctx.translate(sx(px), sz(pz));
      const foe = teamColors().miniEnemy; // colour-vision mode (default "255,80,64")
      if (seen) {
        ctx.fillStyle = foe === "255,80,64" ? "#ff5040" : `rgb(${foe})`;
        ctx.beginPath();
        ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fill();
      } else {
        // Heard, not seen: a hollow ring, drawn where the shot came from and
        // fading out — never the solid white-ringed dot a confirmed sighting
        // gets, because a muzzle flash is a rumour, not a position.
        // The fill is set (faintly) before the arc on purpose: the recorded
        // fillStyle at arc time is what qa/minimap identifies a confirmed blip
        // by, and a rumour must never inherit a confirmed blip's colour.
        ctx.fillStyle = `rgba(${foe},${(0.07 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(0, 0, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(${foe},${(0.95 * fade).toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- your squad, and you ------------------------------------------------
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const isMe = p.id === this.you;
      if (!isMe && (ffa || p.team !== me.team)) continue;
      ctx.save();
      ctx.translate(sx(p.x), sz(p.z));
      ctx.rotate(Math.PI - p.yaw);
      // You are WHITE, the squad is friendly BLUE (UI stream: CoD colour rule) —
      // one shared colour made every blip read as "maybe me" at a glance.
      const pal = teamColors().miniAlly; // colour-vision mode (default "74,168,255")
      ctx.fillStyle = isMe ? "#ffffff" : pal === "74,168,255" ? "#4aa8ff" : `rgb(${pal})`;
      const s = isMe ? 1.35 : 1;
      ctx.beginPath();
      ctx.moveTo(0, -5.5 * s);
      ctx.lineTo(3.6 * s, 3.6 * s);
      ctx.lineTo(-3.6 * s, 3.6 * s);
      ctx.closePath();
      if (isMe) {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.fill();
      ctx.restore();
    }

    // ---- frame + compass. The map never rotates: north is world -z, up. -----
    ctx.strokeStyle = "rgba(255,255,255,0.16)"; // UI stream: neutral frame
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.font = '700 9px "Barlow Condensed", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(6,8,10,0.9)";
    ctx.lineWidth = 2.5;
    ctx.fillStyle = "rgba(245,238,218,0.5)";
    for (const [t, tx, ty] of [
      ["N", w * 0.5, 7],
      ["S", w * 0.5, h - 7],
      ["W", 7, h * 0.5],
      ["E", w - 7, h * 0.5],
    ] as [string, number, number][]) {
      ctx.strokeText(t, tx, ty);
      ctx.fillText(t, tx, ty);
    }
  }

  /**
   * feel stream: the endcard is on screen — world tags/sprites stay off it
   * (BruiserActor.overlays, the YOU tag, the ghost ring). Set where the endcard
   * is handed over (finish), cleared on a rematch.
   */
  endcardUp = false;

  /** feel stream: show an enemy's marker for `ms` (aimed at, or just hit). */
  markEnemy(id: string, ms: number): void {
    const a = this.actors.get(id);
    if (a) a.markUntil = Math.max(a.markUntil, BruiserActor.nowMs + ms);
  }

  /** Bullet-truth line of sight between two players (eye to chest). */
  private canSee(a: PlayerSnap, b: PlayerSnap): boolean {
    return this.clearSight(a.x, a.y + (a.crouch ? CROUCH_EYE : EYE), a.z, b.x, b.y + 1.05, b.z);
  }

  /**
   * THE ROLLOVER, WITH OR WITHOUT THE EVENT. Runs the exact reset the
   * match/live branch runs (re-arm finish(), drop the endcard via onRematch)
   * and is what the endcard-countdown fallback calls when the wire is
   * provably live but the single match/live event never landed. It starts
   * nothing and rejoins nothing — the seat never left the room — so calling
   * it twice, or after the event path already ran, can never double-start a
   * match. If the server is actually still over, the next remain<=0 snapshot
   * re-enters finish() and the card comes back.
   */
  forceRollover(): void {
    if (!this.ended) {
      this.onRematch?.();
      return;
    }
    // ROLLOVER POINT, LIKE THE EVENT PATH: the countdown-expiry fallback
    // takes over exactly when the single match/live event was missed, so it
    // lifts liveTick to the newest applied tick itself — otherwise the point
    // stays one rollover behind and a stale frozen-tick duplicate landing now
    // would re-enter finish() over the live match.
    this.liveTick = this.snapTick;
    this.ended = false;
    this.endEvidenceAt = 0;
    this.endcardUp = false;
    this.stopFinalKillcam(); // feel stream
    this.sprays?.clear(); // fresh walls for the next match
    this.combat = freshCombat(); // combat stats are per match
    this.accolades.reset(this.you);
    this.medals.clear();
    this.scorePops.clear();
    this.onRematch?.();
  }

  finish(s0: number, s1: number): void {
    s0 = num(s0); s1 = num(s1);
    if (this.ended) return;
    this.ended = true;
    this.endedAt = performance.now();
    this.audio.matchEnd();
    const me = this.me();
    const board = this.endBoard(s0, s1);
    let end: () => void;
    // feel stream: who won, for the final killcam's pick (the winning side's last kill)
    let winner: (k: { src: string; srcTeam: number }) => boolean;
    if (this.opts?.mode === "ffa") {
      const top = Math.max(0, ...[...this.players.values()].map((p) => num(p.kills)));
      const win = num(me?.kills ?? 0) >= top;
      const leaders = new Set([...this.players.values()].filter((p) => num(p.kills) === top && top > 0).map((p) => p.id));
      winner = (k) => leaders.has(k.src);
      end = () => this.onEnd?.(win, num(me?.kills ?? 0), top, board);
      this.announcer.end(win, false);
    } else {
      const win = me ? (me.team === 0 ? num(s0) >= num(s1) : num(s1) >= num(s0)) : num(s0) !== num(s1);
      const team = s0 > s1 ? 0 : s1 > s0 ? 1 : -1;
      winner = (k) => k.srcTeam === team;
      end = () => this.onEnd?.(win, s0, s1, board);
      this.announcer.end(win, s0 === s1);
    }
    // feel stream: FINAL KILLCAM first (final-killcam.ts), then the endcard. Never in ?test.
    const clip = this.testMode ? null : this.fkTape.pick(winner);
    if (clip) this.startFinalKillcam(clip, end);
    else {
      this.endcardUp = true;
      end();
    }
  }

  // ------------------------------------------------------- final killcam (feel stream)

  /** Seconds since this match ended (main.ts: the endcard's countdown is the server's, not ours). */
  sinceEndS(): number {
    return this.endedAt ? (performance.now() - this.endedAt) / 1000 : 0;
  }

  /** Roll the match-winning kill off its clip, then hand over to `end` (the endcard). */
  private startFinalKillcam(clip: Clip, end: () => void): void {
    // A personal killcam that was running when the match ended is superseded.
    this.killcamT = 0;
    this.kcClock = -1;
    const k = clip.kill;
    const from = Math.max(clip.frames[0]!.t, k.t - FKC_PRE_MS);
    let shotIdx = clip.shots.findIndex((x) => x.t >= from);
    if (shotIdx < 0) shotIdx = clip.shots.length;
    let hitIdx = clip.hits.findIndex((x) => x.t >= from);
    if (hitIdx < 0) hitIdx = clip.hits.length;
    this.fkc = { clip, clock: from, freeze: k.t + FKC_TAIL_MS, phase: "play", held: 0, shotIdx, hitIdx, dur: fkcDuration(from, k.t), t: 0, end };
    const me = this.me();
    const rel = (id: string, team: number): "you" | "ally" | "enemy" =>
      id === this.you ? "you" : this.opts?.mode !== "ffa" && me && team === me.team ? "ally" : "enemy";
    const victimTeam = this.players.get(k.dst)?.team ?? -1;
    this.fkUi.show(
      { killer: k.killer || "UNKNOWN", victim: k.victim || "UNKNOWN", how: killHow(k.weapon, false), rel: rel(k.src, k.srcTeam), victimRel: rel(k.dst, victimTeam) },
      this.nowMs(),
    );
    this.extras.paintRecap("");
    // Whatever bodies the live frame had hidden (spectator first person) come back for the cut.
    for (const a of this.actors.values()) a.root.visible = true;
    document.body.classList.add("fkc-on");
  }

  /** Advance the cut one frame: the playhead (slow through the shot), the replayed shots and hits. */
  private tickFinalKillcam(dt: number): PlayerSnap[] {
    const f = this.fkc!;
    const killer = f.clip.kill.src;
    if (f.phase === "play") {
      f.t += dt;
      f.clock = Math.min(f.freeze, f.clock + dt * 1000 * fkcRate(f.clock - f.clip.kill.t));
      // The killer's shots: their gun fires in the viewmodel and is heard as theirs; everyone else's is a tracer in the world.
      while (f.shotIdx < f.clip.shots.length && f.clip.shots[f.shotIdx]!.t <= f.clock) {
        const sh = f.clip.shots[f.shotIdx++]!;
        this.spawnTracer(sh.ox, sh.oy, sh.oz, sh.dx, sh.dy, sh.dz, sh.src, true);
        const w = sh.weapon ?? "ar";
        if (sh.src === killer) {
          if (this.vm.root.visible) this.vm.fire();
          this.audio.gun(w, sh.ox, sh.oy, sh.oz, true);
        } else this.audio.gun(w, sh.ox, sh.oy, sh.oz, false, sh.src);
      }
      while (f.hitIdx < f.clip.hits.length && f.clip.hits[f.hitIdx]!.t <= f.clock) {
        const h = f.clip.hits[f.hitIdx++]!;
        this.sparks(h.x, h.y, h.z, h.kill, h.src, h.head);
        if (h.src === killer) {
          this.hitmarker(h.head, h.kill);
          this.audio.hitmarker(h.head, h.kill);
        }
      }
      if (f.clock >= f.freeze) {
        f.held += dt;
        if (f.held >= FKC_HOLD_S) this.endFinalKillcam();
      }
      this.fkUi.tick(this.nowMs());
    }
    return this.replayAt(f.clock, f.clip.frames);
  }

  /** The cut is over (or skipped): the endcard, with the freeze frame held behind it. */
  private endFinalKillcam(): void {
    const f = this.fkc;
    if (!f || f.phase !== "play") return;
    f.phase = "hold";
    f.clock = f.freeze;
    this.fkUi.done();
    this.hitmarkerT = 0;
    document.getElementById("killcam")?.classList.add("hidden");
    this.whud.spectScoped = false;
    this.vm.root.visible = false;
    this.endcardUp = true;
    f.end();
  }

  /** Drop the cut entirely (rematch, new boot) and give #killcam back to the personal killcam. */
  private stopFinalKillcam(): void {
    if (!this.fkc) return;
    this.fkc = null;
    this.fkUi.restore();
    this.whud.spectScoped = false;
    document.body.classList.remove("fkc-on");
    document.getElementById("killcam")?.classList.add("hidden");
    document.getElementById("hud")?.classList.remove("killcam-on");
    for (const a of this.actors.values()) a.root.visible = true;
  }

  /**
   * THE KILLER'S GUN in first person, posed off the tape (both killcams): their
   * weapon in the viewmodel, ADS'd as they were, kicking on every replayed
   * shot (replayShotsTo / tickFinalKillcam). Through a scope the optic is the
   * view (the weapons hud's spectator scope) and the gun is not drawn over it.
   */
  private killerGun(k: PlayerSnap | undefined, dt: number, on: boolean): void {
    const w = k ? WEAPON_BY_ID[k.weapon] : undefined;
    const scoped = !!(k && w?.scope && num(k.ads) >= SCOPE_AT);
    this.whud.spectScoped = on && scoped;
    if (on && k && w && k.alive && !scoped) {
      this.vm.root.visible = true;
      this.vm.setWeapon(k.weapon);
      this.vm.setSwap(0);
      this.vm.look(k.yaw, k.pitch);
      this.vm.setAmmo(num(k.ammo ?? w.mag), w.mag);
      this.vm.update(dt, num(k.ads), num(k.sprint), num(k.slide), Math.hypot(num(k.vx), num(k.vz)) / 5, 0, 0, num(k.crouch));
    } else this.vm.root.visible = false;
  }

  /** The killer's eye and gun off the clip; during the hold, the freeze frame behind the endcard. */
  private finalCam(alist: PlayerSnap[], dt: number): void {
    const f = this.fkc!;
    const k = alist.find((p) => p.id === f.clip.kill.src);
    if (k) this.replayCam(k, dt);
    const playing = f.phase === "play";
    this.killerGun(k, dt, playing);
    const kc = document.getElementById("killcam");
    document.getElementById("hud")?.classList.add("killcam-on");
    if (!playing) return;
    kc?.classList.remove("hidden");
    // The plate: the killer's health on the tape, and the cut's own countdown ring.
    const hp = k ? Math.max(0, Math.min(100, Math.round(num(k.hp)))) : 0;
    const bar = document.getElementById("kc-hp");
    if (bar) {
      bar.style.width = `${hp}%`;
      bar.classList.toggle("low", hp <= 35);
    }
    const hpNum = document.getElementById("kc-hpnum");
    if (hpNum && hpNum.textContent !== String(hp)) hpNum.textContent = String(hp);
    const left = Math.max(0, f.dur - f.t);
    const cnt = document.getElementById("kc-count");
    const txt = left.toFixed(1);
    if (cnt && cnt.textContent !== txt) cnt.textContent = txt;
    const arc = document.getElementById("kc-arc");
    if (arc) arc.style.strokeDashoffset = String((1 - left / Math.max(0.001, f.dur)) * KC_RING);
  }

  /**
   * The endcard leaderboard: every body on the roster, sorted kills-then-fewest-
   * deaths, with the winner(s) marked — the top killer in FFA, the whole winning
   * team in TDM (a draw crowns both sides, same as the endcard's own s0 >= s1).
   */
  private endBoard(s0: number, s1: number): EndRow[] {
    const ffa = this.opts?.mode === "ffa";
    // Online the wire roster is the truth; offline it is never filled, so the
    // local sim's bodies stand in — same fields, same sort.
    const src = this.players.size
      ? [...this.players.values()]
      : this.session
        ? [...this.session.players.values()]
        : [];
    const rows = src
      .map((p): EndRow => ({ name: p.name, kills: num(p.kills), gun: num(p.gun ?? 0), deaths: num(p.deaths), team: p.team === 1 ? 1 : 0, you: p.id === this.you, bot: p.bot === true }))
      .sort((a, b) => num(b.kills) - num(a.kills) || num(a.deaths) - num(b.deaths));
    const top = num(rows[0]?.kills ?? 0);
    for (const r of rows) r.win = ffa ? num(r.kills) >= top && top > 0 : (r.team === 0 ? num(s0) >= num(s1) : num(s1) >= num(s0));
    return rows;
  }
}

/** One leaderboard line on the endcard. */
export type EndRow = {
  name: string;
  kills: number;
  /** GUN GAME ladder progress (0 elsewhere). */
  gun?: number;
  deaths: number;
  team: Team;
  you: boolean;
  win?: boolean;
  /** TRUE when this line is a bot — the endboard badges it like the scoreboard. */
  bot?: boolean;
};

/** Your combat numbers for one match (Fortnite-style), counted off the authoritative hit events. */
export type CombatStats = { shots: number; heads: number; body: number; dmg: number; taken: number };
export function freshCombat(): CombatStats {
  return { shots: 0, heads: 0, body: 0, dmg: 0, taken: 0 };
}

export type HudState = {
  me: PlayerSnap;
  score0: number;
  score1: number;
  remain: number;
  players: PlayerSnap[];
  you: string;
  locked: boolean;
  mode: "tdm" | "ffa";
  /** GUN GAME: FFA standings rank by ladder progress (PlayerSnap.gun), not kills. */
  gun: boolean;
  /** GUN GAME kills per gun. */
  gunKills: number;
  /** Round-based TDM only (shared/protocol.ts RoundState); null elsewhere. */
  round: RoundState | null;
  /** This client is on the bench: its own body is a camera, not a player. */
  spectating: boolean;
};

/** Team display names, in team order — the same two words main.ts prints on the scorebug. */
// UI stream: the HUD names teams RELATIVELY (YOUR TEAM / ENEMY, CoD rule); this
// absolute pair is kept only for code that needs a neutral index label.
export const TEAM_NAMES: readonly [string, string] = ["TEAM A", "TEAM B"];

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Wire/board numbers are untrusted: coerce so hostile strings can never poison math, sorts or comparisons. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
