import * as THREE from "three";
import { TICK_DT } from "@shared/protocol";
import { aimDir } from "@shared/sim";
import { PRIMARY_WEAPON_ID } from "@shared/weapons";
import type { InputCmd } from "@shared/protocol";
import type { Game } from "./game";
import { installInspect } from "./inspect";

/**
 * CLEAR-TEST harness. Activated with ?test in the URL.
 * Gives qa/capture.mjs deterministic control: manual sim stepping, scripted
 * dummy players, and multi-angle re-renders of a single frozen frame.
 */

export type CamSpec =
  | { mode: "fp" }
  | { mode: "orbit" | "side" | "front" | "chase" | "back"; target: string; dist?: number; height?: number; angle?: number }
  | { mode: "free"; x: number; y: number; z: number; lookX: number; lookY: number; lookZ: number; fov?: number };

type DummyDrive = {
  ax: number;
  az: number;
  yaw: number;
  pitch: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  fire: boolean;
  ads: boolean;
  reload: boolean;
  /** BANANA FRAG: hold the wind-up (drives the 3P overhand pre-swing). */
  nadeHold: boolean;
  /** BANANA FRAG: release on this tick, then auto-clears like `jump`. */
  nade: boolean;
  /** The weapon the dummy wants in hand (a swap to its holstered gun). */
  weapon?: string;
};

const DUMMY_NAMES = ["Pulp Punk", "Stem Scout", "Bunch Cap", "Nana Kai", "Coco Loco"];

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export class TestRig {
  ready = false;
  drives = new Map<string, Partial<DummyDrive>>();
  dummySeq = new Map<string, number>();

  constructor(public game: Game) {}

  /** Advance the fixed sim `ticks` times with the given local keys held, then draw once. */
  step(ticks: number, keys: Partial<Game["keys"]> & { yaw?: number; pitch?: number } = {}): void {
    const g = this.game;
    for (let i = 0; i < ticks; i++) {
      if (keys.yaw !== undefined) g.yaw = keys.yaw;
      if (keys.pitch !== undefined) g.pitch = keys.pitch;
      Object.assign(g.keys, { ...keys, yaw: undefined, pitch: undefined });
      delete (g.keys as Record<string, unknown>).yaw;
      delete (g.keys as Record<string, unknown>).pitch;
      this.driveDummies();
      g.fixed();
      g.timeMs += TICK_DT * 1000;
    }
    g.draw(TICK_DT * Math.max(1, ticks));
  }

  /**
   * Add a scripted (non-bot, non-AI) player the harness moves via drive().
   * `opts.weapon` picks its primary ("ar" | "smg" | "sniper"; anything else is
   * the default AR) — the pistol is always its secondary.
   */
  spawnDummy(id: string, opts: { x?: number; z?: number; yaw?: number; team?: 0 | 1; weapon?: string; name?: string } = {}): void {
    const s = this.game.session;
    if (!s) throw new Error("no session");
    const p = s.addPlayer(
      id,
      opts.name ?? DUMMY_NAMES[this.drives.size % DUMMY_NAMES.length]!,
      "bruiser",
      opts.team ?? 1,
      opts.weapon ?? PRIMARY_WEAPON_ID,
      "",
      false,
    );
    if (opts.x !== undefined) p.x = opts.x;
    if (opts.z !== undefined) p.z = opts.z;
    if (opts.yaw !== undefined) p.yaw = opts.yaw;
    p.protect = 0;
    this.drives.set(id, {});
    this.dummySeq.set(id, 0);
  }

  /** Set what a dummy does each tick until changed. */
  drive(id: string, d: Partial<DummyDrive>): void {
    this.drives.set(id, { ...this.drives.get(id), ...d });
  }

  private driveDummies(): void {
    const s = this.game.session;
    if (!s) return;
    for (const [id, d] of this.drives) {
      const p = s.players.get(id);
      if (!p || !p.alive) continue;
      const yaw = d.yaw ?? p.yaw;
      const pitch = d.pitch ?? p.pitch;
      const dir = aimDir(yaw, pitch);
      const seq = (this.dummySeq.get(id) ?? 0) + 1;
      this.dummySeq.set(id, seq);
      const cmd: InputCmd = {
        seq,
        dt: TICK_DT,
        ax: d.ax ?? 0,
        az: d.az ?? 0,
        jump: d.jump ?? false,
        crouch: d.crouch ?? false,
        sprint: d.sprint ?? false,
        tac: false,
        ads: d.ads ?? false,
        yaw,
        pitch,
        fire: d.fire ?? false,
        reload: d.reload ?? false,
        melee: false,
        nade: d.nade ?? false,
        nadeHold: d.nadeHold ?? false,
        weapon: d.weapon ?? p.weapon,
        clientTime: s.time,
        ox: p.x,
        oy: s.eyeY(p),
        oz: p.z,
        dx: dir.dx,
        dy: dir.dy,
        dz: dir.dz,
      };
      s.applyInput(p, cmd, false);
      if (d.jump) d.jump = false;
      if (d.reload) d.reload = false;
      // One-shot like jump: a scripted throw fires on exactly one tick.
      if (d.nade) d.nade = false;
    }
  }

  /**
   * weapons stream: re-kit the LOCAL player for a capture (primary + which
   * slot is in hand), fully stocked, ready to fire.
   */
  arm(primary: string, slot: 0 | 1 = 0): void {
    const g = this.game;
    const s = g.session;
    const p = s?.players.get(g.you);
    if (!s || !p) return;
    p.loadout = { primary: primary as never, secondary: "pistol", lethal: "frag" };
    p.nextLoadout = null;
    const keep = { x: p.x, z: p.z, yaw: p.yaw };
    s.spawn(p);
    p.x = keep.x;
    p.z = keep.z;
    p.yaw = keep.yaw;
    p.protect = 0;
    // weapons stream: a fresh harness has never seen this body alive, and the game's
    // "a fresh life opens on the primary" reset would eat the slot request on the next
    // tick. Let that tick pass first, then ask for the slot.
    this.step(1);
    if (slot === 1) {
      g.wantWeapon = "pistol";
    } else g.wantWeapon = "";
  }

  /** Teleport + orient the local player. */
  place(x: number, z: number, yaw = 0, pitch = 0): void {
    const g = this.game;
    const p = g.session?.players.get(g.you);
    if (p) {
      p.x = x;
      p.z = z;
      p.y = 0;
      p.vx = p.vz = p.vy = 0;
      p.yaw = yaw;
    }
    g.yaw = yaw;
    g.pitch = pitch;
    g.recY = g.recP = g.punchY = g.punchP = 0;
  }

  kill(id: string): void {
    const s = this.game.session;
    const p = s?.players.get(id);
    const me = s?.players.get(this.game.you);
    if (s && p && me) s.kill(me, p, me.weapon, false);
  }

  hud(on: boolean): void {
    for (const id of ["hud"]) document.getElementById(id)?.classList.toggle("hidden", !on);
  }

  /**
   * The camera that was ACTUALLY used by the last renderWith(), read off the
   * camera at the instant of the render.
   *
   * A CamSpec is a REQUEST, not a camera. `{mode:"fp"}` in particular asks for
   * "wherever the sim left the player", so two builds can serialise the byte-
   * identical spec and still render two different places in the world — which
   * is exactly how a before/after pair once shipped as two different scenes
   * with a spec-equality check reporting it clean. Compare THIS across arms, not
   * the spec: a matching spec proves nothing, a matching pose proves the pair.
   */
  lastCam: { spec: string; pos: number[]; quat: number[]; fov: number } | null = null;

  private recordCam(spec: CamSpec): void {
    const c = this.game.camera;
    c.updateMatrixWorld(true);
    const r = (n: number): number => Math.round(n * 1e6) / 1e6;
    this.lastCam = {
      spec: spec.mode,
      pos: [r(c.position.x), r(c.position.y), r(c.position.z)],
      quat: [r(c.quaternion.x), r(c.quaternion.y), r(c.quaternion.z), r(c.quaternion.w)],
      fov: r(c.fov),
    };
  }

  /** Re-render the current (frozen) frame from a camera spec without advancing sim. */
  renderWith(spec: CamSpec): void {
    const g = this.game;
    const cam = g.camera;
    if (spec.mode === "fp") {
      g.composer.render();
      this.recordCam(spec);
      return;
    }
    const prevPos = cam.position.clone();
    const prevQuat = cam.quaternion.clone();
    const prevFov = cam.fov;
    const vmVisible = g.vm.root.visible;
    g.vm.root.visible = false;
    if (spec.mode === "free") {
      cam.position.set(spec.x, spec.y, spec.z);
      cam.lookAt(spec.lookX, spec.lookY, spec.lookZ);
      if (spec.fov) {
        cam.fov = spec.fov;
        cam.updateProjectionMatrix();
      }
    } else {
      const t = g.players.get(spec.target);
      if (t) {
        const dist = spec.dist ?? 3.6;
        const h = spec.height ?? 1.5;
        let ang = t.yaw;
        if (spec.mode === "side") ang = t.yaw + Math.PI / 2;
        if (spec.mode === "front") ang = t.yaw;
        if (spec.mode === "back" || spec.mode === "chase") ang = t.yaw + Math.PI;
        if (spec.mode === "orbit") ang = spec.angle ?? 0;
        cam.position.set(t.x + Math.sin(ang) * dist, t.y + h, t.z + Math.cos(ang) * dist);
        cam.lookAt(t.x, t.y + 0.95, t.z);
        cam.fov = (spec as { fov?: number }).fov ?? 46;
        cam.updateProjectionMatrix();
      }
    }
    cam.updateMatrixWorld(true);
    g.composer.render();
    this.recordCam(spec);
    cam.position.copy(prevPos);
    cam.quaternion.copy(prevQuat);
    cam.fov = prevFov;
    cam.updateProjectionMatrix();
    g.vm.root.visible = vmVisible;
  }

  flatGround: THREE.Mesh | null = null;
  flatGrid: THREE.Object3D | null = null;

  /** 'flat' hides the map and shows a neutral studio floor — isolates character review. */
  stage(mode: "flat" | "map"): void {
    const w = this.game.world;
    if (!w) return;
    const flat = mode === "flat";
    w.root.visible = !flat;
    if (flat && !this.flatGround) {
      const g = new THREE.Mesh(
        new THREE.CircleGeometry(30, 48),
        new THREE.MeshStandardMaterial({ color: 0xdcd6c8, roughness: 1 }),
      );
      g.rotation.x = -Math.PI / 2;
      g.receiveShadow = true;
      this.flatGround = g;
      w.scene.add(g);
      this.flatGrid = null;
    }
    if (this.flatGround) this.flatGround.visible = flat;
  }

  /** Force a raw animation clip on an actor (bypasses locomotion/aim logic). */
  forceClip(id: string, clip: string | null, timeScale = 1): void {
    const a = this.game.actors.get(id);
    if (a) a.forceClip(clip, timeScale);
  }

  /** Numeric probe for assertions. */
  state(): unknown {
    const g = this.game;
    const me = g.me();
    return {
      time: g.session?.time ?? 0,
      me: me ? { x: me.x, y: me.y, z: me.z, hp: me.hp, ammo: me.ammo, weapon: me.weapon, sprint: me.sprint, crouch: me.crouch, ads: me.ads } : null,
      players: [...g.players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, alive: p.alive, firing: p.firing })),
      actors: [...g.actors.keys()],
      cam: { x: g.camera.position.x, y: g.camera.position.y, z: g.camera.position.z, fov: g.camera.fov },
    };
  }
}

export async function installTestMode(game: Game, params: URLSearchParams): Promise<TestRig> {
  Math.random = seededRandom(Number(params.get("seed") ?? 1337));
  game.testMode = true;
  game.locked = true;
  const rig = new TestRig(game);
  (window as unknown as { __test: TestRig }).__test = rig;
  await game.init();
  await game.start({
    name: "Peel Bruiser",
    mode: (params.get("mode") as "tdm" | "ffa") ?? "tdm",
    host: "",
    sens: 1,
    vol: 0,
    tac: true,
    bots: Number(params.get("bots") ?? 0),
  });
  installInspect(game);
  // ZERO-FLICKER detector (scripts/qa/flicker-gate.mjs, depth-probe.mjs) — window.__flicker.
  (await import("./flicker-qa")).installFlickerQA(game);
  rig.ready = true;
  return rig;
}
