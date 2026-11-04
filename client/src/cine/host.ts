/**
 * client/src/cine/host.ts — what the cinematics read and drive on the Game.
 * Structural (Game satisfies it); a few private Game methods are reached by
 * cast, which keeps every hook in game.ts a one-liner.
 */
import type * as THREE from "three";
import type { PlayerSnap } from "@shared/protocol";
import type { TapeFrame } from "../final-killcam";

export type Host = {
  camera: THREE.PerspectiveCamera;
  composer: import("three/addons/postprocessing/EffectComposer.js").EffectComposer;
  depth: { floatDepth: boolean };
  world: { scene: THREE.Scene } | null;
  vm: { root: THREE.Object3D; fire(): void };
  actors: Map<string, { root: THREE.Object3D }>;
  players: Map<string, PlayerSnap>;
  you: string;
  yaw: number;
  pitch: number;
  opts?: { mode: string; gun?: boolean };
  session: {
    time: number;
    phase: string;
    mode: string;
    round: number;
    roundBased: boolean;
    players: Map<string, PlayerSnap & { bench?: boolean; sitOut?: boolean }>;
  } | null;
  testMode: boolean;
  spectateCam: unknown;
  renderT: number;
  endcardUp: boolean;
  fkc: unknown;
  fov: number;
  flash3P?: THREE.PointLight | null;
  whud: { spectScoped: boolean };
  audio: {
    ctx: AudioContext | null;
    buses?: Record<string, GainNode>;
    gun(w: string, x: number, y: number, z: number, local: boolean, src?: string): void;
    hitmarker(head: boolean, kill: boolean): void;
  };
  matchPhase(): string;
  countdownLeftMs(): number;
  roundInfo(): { n: number; wins0: number; wins1: number } | null;
  me(): PlayerSnap | undefined;
  nowMs(): number;
  // private on Game, reached by cast:
  killerGun(k: PlayerSnap | undefined, dt: number, on: boolean): void;
  spawnTracer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, src: string, raw?: boolean, weapon?: string): void;
  sparks(x: number, y: number, z: number, kill: boolean, src?: string, head?: boolean): void;
  hitmarker(head: boolean, kill: boolean): void;
  replayAt(t: number, r: TapeFrame[]): PlayerSnap[];
  stopFinalKillcam(): void;
};

export type Emit = (type: string, detail?: Record<string, unknown>) => void;

export const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
export const angWrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Hold-to-skip on SPACE (a tap, a W, the pointer-lock click never skip). */
export class HoldSkip {
  private down = 0;
  private fired = false;
  constructor(private ms: number) {
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.code !== "Space" || e.repeat) return;
        this.down = performance.now();
        this.fired = false;
      },
      true,
    );
    window.addEventListener(
      "keyup",
      (e) => {
        if (e.code === "Space") this.down = 0;
      },
      true,
    );
    window.addEventListener("blur", () => (this.down = 0));
  }
  /** 0..1 fill of the ring right now. */
  fill(): number {
    return this.down ? Math.min(1, (performance.now() - this.down) / this.ms) : 0;
  }
  /** True exactly once per completed hold. */
  take(): boolean {
    if (this.down && !this.fired && this.fill() >= 1) {
      this.fired = true;
      return true;
    }
    return false;
  }
  /** QA / capture: press-and-hold programmatically. */
  press(): void {
    this.down = performance.now() - this.ms - 1;
    this.fired = false;
  }
}
