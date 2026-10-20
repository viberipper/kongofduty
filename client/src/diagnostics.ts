/** Opt-in, local-only measurements from the playing browser. No telemetry is sent. */
export class SampleWindow {
  private values: Float64Array;
  private cursor = 0;
  total = 0;
  constructor(capacity = 8192) { this.values = new Float64Array(capacity); }
  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.values.length;
    this.total++;
  }
  report() {
    const sorted = [...this.values.subarray(0, Math.min(this.total, this.values.length))].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? null;
    return { samples: sorted.length, total: this.total, p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1) ?? null };
  }
}

export class ClientDiagnostics {
  readonly frameMs = new SampleWindow();
  readonly drawCpuMs = new SampleWindow();
  readonly rttMs = new SampleWindow(240);
  readonly snapshotGapMs = new SampleWindow();
  readonly correctionMeters = new SampleWindow();
  private pings = new Map<number, number>();
  private lastSnapshot = 0;
  private started = new Date().toISOString();
  private samplesSince = performance.now();
  constructor(private context: () => unknown) {}
  ping(t0: number, now: number): void {
    this.pings.set(t0, now);
    if (this.pings.size > 16) this.pings.delete(this.pings.keys().next().value!);
  }
  pong(t0: number, now: number): void {
    const sent = this.pings.get(t0);
    if (sent !== undefined) { this.rttMs.add(now - sent); this.pings.delete(t0); }
  }
  snapshot(now: number, visible: boolean): void {
    if (visible && this.lastSnapshot) this.snapshotGapMs.add(now - this.lastSnapshot);
    this.lastSnapshot = visible ? now : 0;
  }
  resetConnection(): void { this.pings.clear(); this.lastSnapshot = 0; }
  report() {
    return {
      version: 1, started: this.started, durationSeconds: (performance.now() - this.samplesSince) / 1000,
      context: this.context(), frameMs: this.frameMs.report(), drawCpuMs: this.drawCpuMs.report(),
      rttMs: this.rttMs.report(), snapshotGapMs: this.snapshotGapMs.report(), correctionMeters: this.correctionMeters.report(),
      interpretation: "RTT includes browser/server scheduling and transport. Snapshot gaps are application delivery gaps, not a packet-loss estimate. Frames cover visible live play. Corrections exclude observed death/respawn transitions. Percentiles use bounded recent samples; no geographic latency is simulated.",
    };
  }
  download(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.report(), null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `kong-performance-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
