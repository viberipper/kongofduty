/**
 * MASTER DYNAMICS — ported from Kong Royale (client/src/audio/limiter.ts + the
 * mixer's soft-clip curve), so the recorded weapon set keeps its pressure spike.
 *
 * One AudioWorklet node: a stereo-linked GLUE compressor (threshold -3 dBFS,
 * 2:1, 6 dB knee — it only touches a pile-up of loud sounds, never one shot)
 * followed by a 1.33 ms look-ahead TRUE-PEAK brickwall limiter at -1.5 dBTP
 * (4x oversampled inter-sample peak detector, ITU-R BS.1770 style) with a DUAL
 * release: a gunshot's 1-3 ms spike is shaved and the gain is back within
 * ~10 ms (no pumping of the body behind it); only a sustained overload
 * (>= ~40 ms: an explosion, twelve rifles at once) engages the slow 150 ms
 * release. A static soft-clip curve after it (linear to -1.5 dBFS, never above
 * -0.2 dBFS) is the last safety.
 *
 * Why not the old DynamicsCompressorNode chain: its fixed ~6 ms look-ahead and
 * the -14 dBFS bus compressor in front of it flattened every recorded transient
 * into the "pots and pans" the synth guns were. That chain stays as the
 * fallback when AudioWorklet is unavailable.
 *
 * Loaded from a Blob URL, so no extra file has to be served.
 */
const SRC = /* js */ `
class BsMaster extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = 64;
    this.b0 = new Float32Array(this.L); this.b1 = new Float32Array(this.L); this.win = new Float32Array(this.L).fill(1);
    this.w = 0; this.g = 1; this.env = 0; this.gr = 0; this.n = 0;
    this.ceil = Math.pow(10, -1.5 / 20);
    this.h0 = new Float32Array(8); this.h1 = new Float32Array(8); this.hp = 0;
    this.fir = [0.25, 0.5, 0.75].map((f) => { const c = new Float32Array(8); let s = 0;
      for (let k = 0; k < 8; k++) { const t = k - 3 - f, x = Math.PI * t, sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(x) / x;
        const wn = 0.5 + 0.5 * Math.cos(Math.PI * t / 4.5); c[k] = sinc * wn; s += c[k]; }
      for (let k = 0; k < 8; k++) c[k] /= s; return c; });
    this.thr0 = -3; this.ratio = 2.0; this.knee = 6;
    this.drive = 1; this.thr = this.thr0;
    this.port.onmessage = (e) => { const d = e.data && e.data.drive; if (typeof d === "number") { this.drive = Math.pow(10, d / 20); this.thr = this.thr0 + d; } };
    this.gs = 1; this.sAtt = 1 - Math.exp(-1 / (0.04 * sampleRate)); this.sRel = 1 - Math.exp(-1 / (0.15 * sampleRate));
    this.cAtt = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.cRel = 1 - Math.exp(-1 / (0.18 * sampleRate));
    this.lAtt = 1 - Math.exp(-5 / this.L);
    this.lRel = 1 - Math.exp(-1 / (0.009 * sampleRate));
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const o0 = out[0], o1 = out[1] || out[0];
    const n = o0.length;
    const l = inp && inp[0] ? inp[0] : null, r = inp && inp[1] ? inp[1] : l;
    const L = this.L, b0 = this.b0, b1 = this.b1, win = this.win, ceil = this.ceil;
    let w = this.w, g = this.g, gs = this.gs, env = this.env, minG = 1;
    const dv = this.drive;
    for (let i = 0; i < n; i++) {
      const x0 = l ? l[i] * dv : 0, x1 = r ? r[i] * dv : 0;
      const a = Math.max(Math.abs(x0), Math.abs(x1));
      env += (a - env) * (a > env ? this.cAtt : this.cRel);
      const lv = 20 * Math.log10(env + 1e-9), over = lv - this.thr;
      let gdb = 0;
      if (over > this.knee / 2) gdb = -over * (1 - 1 / this.ratio);
      else if (over > -this.knee / 2) gdb = -(1 - 1 / this.ratio) * (over + this.knee / 2) * (over + this.knee / 2) / (2 * this.knee);
      const cg = Math.pow(10, gdb / 20);
      const y0 = x0 * cg, y1 = x1 * cg;
      const h0 = this.h0, h1 = this.h1; let hp = this.hp;
      h0[hp] = y0; h1[hp] = y1; hp = (hp + 1) & 7; this.hp = hp;
      let pk = Math.max(Math.abs(y0), Math.abs(y1));
      if (pk > ceil * 0.5 || Math.abs(h0[(hp + 3) & 7]) > ceil * 0.5 || Math.abs(h1[(hp + 3) & 7]) > ceil * 0.5) {
        for (let f = 0; f < 3; f++) {
          const c = this.fir[f]; let s0 = 0, s1 = 0;
          for (let k = 0; k < 8; k++) { const q = (hp + k) & 7; s0 += c[k] * h0[q]; s1 += c[k] * h1[q]; }
          const a2 = Math.max(Math.abs(s0), Math.abs(s1)); if (a2 > pk) pk = a2;
        }
      }
      win[w] = pk > ceil ? ceil / pk : 1;
      let m = 1;
      for (let k = 0; k < L; k++) if (win[k] < m) m = win[k];
      g += (m - g) * (m < g ? this.lAtt : this.lRel);
      gs += (m - gs) * (m < gs ? this.sAtt : this.sRel);
      const gg = g < gs ? g : gs;
      const d0 = b0[w] * gg, d1 = b1[w] * gg;
      b0[w] = y0; b1[w] = y1;
      w = w + 1 === L ? 0 : w + 1;
      o0[i] = d0 > ceil ? ceil : d0 < -ceil ? -ceil : d0;
      if (out[1]) o1[i] = d1 > ceil ? ceil : d1 < -ceil ? -ceil : d1;
      const tg = gg * cg;
      if (tg < minG) minG = tg;
    }
    this.w = w; this.g = g; this.gs = gs; this.env = env;
    this.gr = Math.min(this.gr, 20 * Math.log10(minG));
    if (++this.n % 8 === 0) { this.port.postMessage(this.gr); this.gr = 0; }
    return true;
  }
}
registerProcessor("bs-master", BsMaster);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** The glue + true-peak limiter node for `ctx`, or null when AudioWorklet is unavailable / refused. */
export function installMaster(ctx: BaseAudioContext): Promise<AudioWorkletNode | null> {
  if (!ctx.audioWorklet || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return Promise.resolve(null);
  let p = loaded.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([SRC], { type: "text/javascript" }));
    p = ctx.audioWorklet.addModule(url).then(
      () => true,
      () => false,
    );
    loaded.set(ctx, p);
  }
  return p.then((ok) => {
    if (!ok) return null;
    try {
      return new AudioWorkletNode(ctx, "bs-master", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
      });
    } catch {
      return null;
    }
  });
}

/** Linear to -1.5 dBFS (the limiter's ceiling), tanh into a -0.2 dBFS ceiling above it. */
export function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  const knee = 0.841;
  const ceil = 0.977;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    let y = a;
    if (a > knee) y = knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/**
 * Swap a graph's master stage for the worklet: `pre` (everything that reaches
 * the master) -> limiter -> soft clip -> `out`. Resolves with the node (null =
 * the fallback chain stays in place, untouched).
 */
export async function upgradeMaster(ctx: BaseAudioContext, pre: AudioNode, out: AudioNode, onGr?: (db: number) => void): Promise<AudioWorkletNode | null> {
  const node = await installMaster(ctx);
  if (!node) return null;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  pre.disconnect();
  pre.connect(node);
  node.connect(clip);
  clip.connect(out);
  if (onGr) node.port.onmessage = (e) => onGr(e.data as number);
  return node;
}
