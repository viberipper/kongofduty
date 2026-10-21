/** Sustained render cost controls resolution; short hitches never resize it. */
export class RenderQuality {
  constructor(private readonly budgetMs = 12) {}
  scale = 1;
  maxScale = 1;
  private cost = 0;
  private samples = 0;
  private lastChange = 0;
  sample(ms: number, now: number): boolean {
    if (!Number.isFinite(ms) || ms < 0) return false;
    this.cost = this.samples ? this.cost * 0.95 + ms * 0.05 : ms;
    this.samples++;
    if (this.samples < 30 || now - this.lastChange < 2000) return false;
    let next = this.scale;
    if (this.cost > this.budgetMs) next = Math.max(0.5, this.scale * 0.8);
    else if (this.cost < this.budgetMs * (5 / 12)) next = Math.min(this.maxScale, this.scale + 0.05);
    if (next === this.scale) return false;
    this.scale = next;
    this.lastChange = now;
    this.samples = 0;
    this.cost = 0;
    return true;
  }
}
