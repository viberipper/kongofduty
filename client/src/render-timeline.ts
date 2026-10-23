/** Absorb clock/buffer adjustments without making remote players run backwards. */
export class RenderTimeline {
  private time = Number.NaN;
  private previous = 0;
  reset(): void { this.time = Number.NaN; this.previous = 0; }
  advance(now: number, target: number): number {
    if (!Number.isFinite(this.time)) this.time = target;
    else {
      const dt = Math.max(0, now - this.previous);
      // Gradually catch up or rebuild interpolation headroom, at +/-10% speed.
      this.time += Math.max(dt * .9, Math.min(dt * 1.1, target - this.time));
    }
    this.previous = now;
    return this.time;
  }
}
