/** What a foot lands on (client/src/foot-surface.ts) — each has its own step and landing voice. */
export type FootSurface = "dirt" | "grass" | "hard" | "wood" | "sand" | "metal";

/** Footstep reach is measured in metres, independent of the map's size. */
export type FootstepStyle = { sprint?: boolean; crouch?: boolean; land?: boolean; ally?: boolean; local?: boolean; occluded?: boolean };

export const STEP_VOICES = 4;

export function footstepRange(style: FootstepStyle): number {
  return style.land ? 20 : style.crouch ? 5 : style.sprint ? 22 : 14;
}

export function footstepMix(distance: number, style: FootstepStyle = {}): { gain: number; cutoff: number; priority: number } {
  const range = footstepRange(style);
  const d = Math.max(0, distance);
  const t = Math.min(1, Math.max(0, (d - range * 0.65) / (range * 0.35)));
  const distanceGain = style.local ? 1 : (1 - t * t * (3 - 2 * t)) / (1 + Math.max(0, d - 2) * 0.22);
  const gain = distanceGain * (style.ally ? 0.32 : 1) * (style.crouch && !style.land ? 0.35 : 1) * (style.occluded ? 0.25 : 1);
  return {
    gain,
    cutoff: style.occluded ? 1100 : Math.max(1800, 6500 - d * 220),
    // Own/friendly movement must not evict a nearby enemy cue.
    priority: style.local ? 0.025 : gain * (style.ally ? 0.4 : 1),
  };
}

type Pose = { x: number; y: number; z: number; alive: boolean; grounded: boolean; moving: boolean; sprint: boolean; crouch: boolean; slide: number };
type State = Pose & { phase: number };

/** Advance from displayed displacement, never velocity or wall-clock extrapolation. */
export class FootstepCadence {
  private states = new Map<string, State>();

  clear(): void { this.states.clear(); }
  reset(id: string): void { this.states.delete(id); }
  retain(ids: Set<string>): void {
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
  }

  advance(id: string, pose: Pose, dt: number): "step" | "land" | null {
    const previous = this.states.get(id);
    const next = { ...pose, phase: previous?.phase ?? 0 };
    this.states.set(id, next);
    if (!previous || !pose.alive || !previous.alive || dt <= 0 || dt > 0.25) {
      next.phase = 0;
      return null;
    }
    const moved = Math.hypot(pose.x - previous.x, pose.z - previous.z);
    // Respawns, teleports and accumulated network/frame stalls are not strides.
    if (moved > Math.max(0.75, dt * 14) || Math.abs(pose.y - previous.y) > 2.5) {
      next.phase = 0;
      return null;
    }
    if (!pose.grounded || pose.slide > 0) {
      next.phase = 0;
      return null;
    }
    if (!previous.grounded) {
      next.phase = 0;
      return "land";
    }
    if (!pose.moving) {
      next.phase = 0;
      return null;
    }
    if (moved < 0.003 || moved / dt < 0.25) return null;
    const stride = pose.crouch ? 1.25 : pose.sprint ? 1.85 : 1.55;
    next.phase += moved;
    if (next.phase < stride) return null;
    next.phase %= stride;
    return "step";
  }
}
