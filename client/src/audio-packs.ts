/**
 * audio-packs — the sample-pack runtime that sits beside the synth AudioRig2.
 * ===========================================================================
 * Four measured packs live at static/assets/audio/<key>/ (Ogg/Opus + a runtime
 * manifest, built by scripts/encode-audio-packs.mjs from the WAV masters in
 * audio-sources/packs/). This module does exactly three things:
 *
 *   1. fetch + decode a pack into AudioBuffers,
 *   2. resolve the GAME's event vocabulary onto whatever that pack called the
 *      same event (every pack named its keys differently: `gun-ar`,
 *      `gun.ar.near`, `gunshot.ar.near` are one sound),
 *   3. hand AudioRig2 a buffer + gain + pitch-variance for an event name.
 *
 * It owns NO audio graph. Playback — panner, distance lowpass, bus, reverb
 * send, voice caps, limiter — stays in audio2.ts play(), so a pack and the
 * synth are mixed by byte-identical code and the A/B the player hears at
 * /audio-sources/audition.html is the A/B they get in game.
 *
 * Anything a pack does not carry (bullet impacts, the local mech tick, the
 * empty-mag click) falls through to the synth family of the same name, so a
 * pack is never a downgrade in coverage.
 */

/** Canonical game events. These are the names game.ts / audio2.ts already play. */
export type PackEventName = string;

export type PackOption = { key: string; label: string };

/** Menu order = the audition page order, with SYNTH kept as the escape hatch. */
export const PACK_OPTIONS: PackOption[] = [
  { key: "studio-real", label: "STUDIO REAL" },
  { key: "toon-punch", label: "TOON PUNCH" },
  { key: "tropical-arcade", label: "TROPICAL ARCADE" },
  { key: "cinematic-soft", label: "CINEMATIC SOFT" },
  { key: "synth", label: "SYNTH (PROCEDURAL)" },
];

/** Closest to the brief: clean hi-fi with real top end. */
export const DEFAULT_PACK = "studio-real";
import { ASSET_BASE, assetUrl } from "./asset-base";

const LS_KEY = "bs.soundpack";

/**
 * canonical event -> the key each pack used, most specific first.
 * A pack wins on the first candidate it actually declares, so one table
 * covers all four naming schemes without a per-pack branch.
 */
const ALIASES: Record<string, string[]> = {
  // --- weapon: the BUNCH CYLINDER is an AR-class body in every pack ---
  "gun-m4a1": ["gun-ar", "gun.ar.near", "gunshot.ar.near"],
  "gun-m4a1-far": ["gun-ar-far", "gun.ar.far", "gunshot.ar.distant"],

  // --- reload, three stages ---
  "rl-magout": ["reload-out", "reload.out", "reload.magout", "reload"],
  "rl-magin": ["reload-in", "reload.in", "reload.magin", "reload"],
  "rl-rack": ["reload-rack", "reload.rack", "reload"],

  // --- locomotion ("step" IS dirt: the yard is packed earth) ---
  step: ["step-dirt", "footstep.dirt"],
  "step-metal": ["step-metal", "footstep.metal"],
  land: ["step-dirt", "footstep.dirt"],

  // --- combat feedback ---
  hit: ["hitmarker", "hit.marker", "feedback.hitmarker"],
  headshot: ["headshot", "hit.headshot", "feedback.headshot"],
  kill: ["kill-confirm", "kill", "hit.kill", "feedback.kill"],
  hurt: ["damage-taken", "damage", "hit.damage_taken", "feedback.damage"],

  // --- banana frag ---
  "nade-pin": ["nade-pin", "grenade.pin"],
  "nade-throw": ["nade-throw", "grenade.throw"],
  "nade-bounce": ["nade-bounce", "grenade.bounce"],
  "nade-boom": ["explosion-near", "grenade.explode.near", "grenade.explosion.near"],
  "nade-boom-far": ["explosion-far", "grenade.explode.far", "grenade.explosion.distant"],

  // --- medal ladder (toon-punch only ships a 4-clip streak set + one banner) ---
  "medal-kill": ["medal-1", "medal-kill", "medal.kill", "medal.streak"],
  "medal-double": ["medal-2", "medal-double", "medal.double", "medal.streak"],
  "medal-triple": ["medal-3", "medal-triple", "medal.triple", "medal.streak"],
  "medal-fury": ["medal-4", "medal-fury", "medal.fury", "medal.streak"],
  "medal-streak": ["medal-streak", "medal.banner", "medal.streak"],

  // --- UI / match ---
  ui: ["ui-click", "ui.click"],
  "ui-go": ["ui-deploy", "ui.deploy"],
  "match-start": ["match-start", "ui-match-start", "ui.match_start", "ui.matchStart"],
  "match-end": ["match-end", "ui-match-end", "ui.match_end", "ui.matchEnd"],

  // --- jungle bed + sparse accents ---
  room: ["amb-jungle", "amb-jungle-loop", "ambience.jungle_loop", "ambience.jungle"],
  bird: ["amb-bird", "amb-bird-piha", "ambience.accent.bird", "ambience.accent"],
  insect: ["amb-insect", "amb-insect-burst", "ambience.accent.insect", "ambience.accent"],
  monkey: ["ambience.accent.monkey"],
};

/**
 * Events no pack authors — bullet impacts, the local mech tick, the empty-mag
 * click, the slide scrub. audio2 keeps synthesising these under every pack, so
 * a pack is never a downgrade in coverage. Listed here so the gap is visible
 * rather than discovered.
 */
export const SYNTH_ONLY = [
  "flesh",
  "impact",
  "mech-rifle",
  "mech-shot",
  "mech-bolt",
  "nade-empty",
  "slide",
  "whoosh",
  "metal-far",
  // MATCH FEEL (the 3-2-1, the kill resupply, the health-recovered cue). The
  // packs were mastered before these events existed and none of them ships a
  // countdown, so they are synthesised under every pack — see the fam() block
  // in audio2.ts. Listed here so packStatus reports the gap honestly.
  "count-tick",
  "count-go",
  "resupply",
  "recover",
];

export type PackEvent = {
  /** the pack's own key, for reporting */
  key: string;
  buffers: AudioBuffer[];
  /** manifest gain, applied on top of the call-site volume */
  gain: number;
  /** manifest pitchVarPct: playbackRate jitters +/- half of this, in percent */
  pitchVar: number;
  loop: boolean;
  /**
   * Level-match multiplier onto the synth family's level, filled in by
   * AudioRig2.matchPackLevels(). See the note there: a pack swap is a TIMBRE
   * swap, and the game's own mix balance must survive it.
   */
  match: number;
};

/**
 * Loudness proxy for a one-shot: the RMS of its loudest `ms` window, AND its
 * true peak. Both are needed to match levels honestly.
 *
 * Whole-buffer RMS would rate a 4 s medal sting as quiet just for having a
 * tail, and a 140 ms footstep as loud for having none — hence the window. But
 * a window-RMS match alone over-boosts a transient-heavy clip: matching a tight
 * 60 ms crack to a synth shot with a long tail pushes its PEAK ~7 dB higher,
 * which measured as the whole game running into the compressor. So the peak
 * travels with it and the caller takes whichever bound binds first.
 */
export function loudness(buf: AudioBuffer, ms = 60): { rms: number; peak: number } {
  const n = Math.max(1, Math.min(buf.length, Math.round((buf.sampleRate * ms) / 1000)));
  const hop = Math.max(1, Math.round(n / 4));
  let bestRms = 0;
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]!);
      if (a > peak) peak = a;
    }
    if (d.length < n) {
      let e = 0;
      for (let i = 0; i < d.length; i++) e += d[i]! * d[i]!;
      bestRms = Math.max(bestRms, Math.sqrt(e / n));
      continue;
    }
    for (let s = 0; s + n <= d.length; s += hop) {
      let e = 0;
      for (let i = s; i < s + n; i++) e += d[i]! * d[i]!;
      bestRms = Math.max(bestRms, Math.sqrt(e / n));
    }
  }
  return { rms: bestRms, peak };
}

type RuntimeManifest = {
  pack: string;
  title: string;
  codec: string;
  bytes: number;
  fileCount: number;
  events: Record<string, { files: string[]; gain?: number; pitchVarPct?: number; loop?: boolean }>;
};

/** Bounded parallel map — 8 concurrent fetch+decode keeps a cold pack under ~1 s
 *  without opening 60 sockets at once on the same connection. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Manifest file entries must be plain relative paths inside the pack dir —
 *  anything else (parent traversal, absolute paths, absolute URLs) is skipped
 *  so a tampered manifest cannot make the game fetch outside the pack. */
function safePackFile(f: string): boolean {
  if (!f || f.startsWith("/") || f.includes("\\")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(f)) return false; // scheme: / protocol-relative
  if (f.split("/").includes("..")) return false;
  return true;
}

export class SamplePack {
  key = "";
  title = "";
  bytes = 0;
  /** canonical event -> resolved clips */
  events = new Map<string, PackEvent>();
  /** canonical events this pack does not carry (they fall back to synth) */
  missing: string[] = [];
  /** per-event shuffle bags, so round-robin never repeats a clip back to back */
  private bags = new Map<string, number[]>();
  private lastPick = new Map<string, number>();

  get(name: string): PackEvent | null {
    return this.events.get(name) ?? null;
  }

  /** Shuffle-bag round-robin over a manifest event's `files`. */
  pick(name: string, ev: PackEvent): AudioBuffer {
    const n = ev.buffers.length;
    if (n === 1) return ev.buffers[0]!;
    let bag = this.bags.get(name);
    if (!bag || !bag.length) {
      bag = Array.from({ length: n }, (_, k) => k);
      for (let k = bag.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [bag[k], bag[j]] = [bag[j]!, bag[k]!];
      }
      const last = this.lastPick.get(name) ?? -1;
      if (bag[bag.length - 1] === last && bag.length > 1) {
        const j = Math.floor(Math.random() * (bag.length - 1));
        [bag[bag.length - 1], bag[j]] = [bag[j]!, bag[bag.length - 1]!];
      }
      this.bags.set(name, bag);
    }
    const idx = bag.pop()!;
    this.lastPick.set(name, idx);
    return ev.buffers[idx]!;
  }

  /** playbackRate jitter from the manifest's pitchVarPct (peak-to-peak percent). */
  rate(ev: PackEvent): number {
    if (!ev.pitchVar) return 1;
    return 1 + ((Math.random() * 2 - 1) * ev.pitchVar) / 200;
  }

  static async load(key: string, ctx: BaseAudioContext, base = `${ASSET_BASE}assets/audio`): Promise<SamplePack> {
    // Allowlist (mirrors AudioRig2.loadPack): only known packs are fetchable.
    if (key !== "synth" && !PACK_OPTIONS.some((p) => p.key === key)) throw new Error(`pack ${key}: unknown pack key`);
    // Normalize through assetUrl (same as WeaponLibrary): a future caller
    // passing a "/assets/..." literal keeps working even if the game is ever
    // mounted under a subpath again — assetUrl leaves anything else untouched.
    const root = `${assetUrl(base.replace(/\/+$/, ""))}/${key}`;
    const res = await fetch(assetUrl(`${root}/manifest.json`), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`pack ${key}: manifest ${res.status}`);
    const man = (await res.json()) as RuntimeManifest;

    // Decode each distinct FILE once — several canonical events legitimately
    // share one clip (land reuses step-dirt; toon-punch's medal ladder is one
    // 4-clip set), and decoding it per alias would triple the work and the RAM.
    const wanted = new Set<string>();
    const resolved = new Map<string, { key: string; def: RuntimeManifest["events"][string] }>();
    for (const [canon, cands] of Object.entries(ALIASES)) {
      const hit = cands.find((c) => man.events[c]);
      if (!hit) continue;
      resolved.set(canon, { key: hit, def: man.events[hit]! });
      for (const f of man.events[hit]!.files) if (safePackFile(f)) wanted.add(f);
    }

    const list = [...wanted].slice(0, 96);
    const decodedRaw = await pool(list, 8, async (f) => {
      // One corrupt clip skips that file instead of failing the whole pack;
      // the synth twin covers the event (see the missing-event path below).
      try {
        const r = await fetch(assetUrl(`${root}/${f}`), { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        if (ab.byteLength > 8 * 1024 * 1024) return null;
        try {
          return { f, bytes: ab.byteLength, buf: await ctx.decodeAudioData(ab) };
        } catch {
          return null;
        }
      } catch {
        return null;
      }
    });
    const decoded = decodedRaw.filter((d): d is { f: string; bytes: number; buf: AudioBuffer } => d !== null);

    const p = new SamplePack();
    p.key = key;
    p.title = man.title ?? key;
    const byFile = new Map(decoded.map((d) => [d.f, d.buf]));
    p.bytes = decoded.reduce((a, d) => a + d.bytes, 0);
    for (const [canon, { key: pk, def }] of resolved) {
      const buffers = def.files.filter(safePackFile).map((f) => byFile.get(f)!).filter(Boolean);
      // Everything rejected (or failed to decode): report the event as missing
      // so play() falls through to the synth twin instead of a broken clip.
      if (!buffers.length) continue;
      p.events.set(canon, {
        key: pk,
        buffers,
        gain: def.gain ?? 1,
        pitchVar: def.pitchVarPct ?? 0,
        loop: !!def.loop,
        match: 1,
      });
    }
    p.missing = Object.keys(ALIASES).filter((c) => !p.events.has(c));
    return p;
  }
}

/** ?pack=<key> wins (QA + shareable links), then the saved choice, then default. */
export function readPackPref(search: string = typeof location !== "undefined" ? location.search : ""): string {
  const q = new URLSearchParams(search).get("pack");
  if (q && (q === "synth" || PACK_OPTIONS.some((p) => p.key === q))) return q;
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s && (s === "synth" || PACK_OPTIONS.some((p) => p.key === s))) return s;
  } catch {
    /* private mode */
  }
  return DEFAULT_PACK;
}

export function writePackPref(key: string): void {
  try {
    localStorage.setItem(LS_KEY, key);
  } catch {
    /* private mode */
  }
}
