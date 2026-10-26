/**
 * client/src/announcer.ts — THE MATCH ANNOUNCER (hive).
 * ===========================================================================
 *
 * A game-show caller over the match: the mode at GO, the clock at one minute /
 * thirty / ten seconds, the lead changing hands, first blood, streaks and
 * multi-kills called BY NAME, and the result. Every line is also a subtitle
 * (#announcer-sub) so it reads with the sound off.
 *
 * THE VOICE is a generated deep male announcer (Quake/Doom-like): pre-rendered
 * clips under static/assets/audio/announcer/ (manifest.json), played as plain
 * <audio> one-shots. Fixed lines map exactly; dynamic lines (names, streak
 * counts) play the clip for their fixed head — FIRST BLOOD! KILLER DROPS
 * VICTIM plays "First blood!", DOUBLE KILL FOR KILLER plays "Double kill!" —
 * while the subtitle always carries the full text.
 *
 * Speech synthesis survives as the FALLBACK: a missing/undecodable clip, a
 * rejected play() (no gesture yet), or a line with no clip (unknown mode
 * label) falls back to the browser's localService voice, exactly as before.
 *
 * Also YOUR KONG'S OWN VOICE (hive cbbuhicb): broken, Brute-style English on
 * its kills, headshots, reloads, frags, respawns and when it is hurt — `kong()`
 * — a deeper, slower beastubleed of the same voice, behind its own switch.
 *
 * Volume follows MASTER x INTERFACE; SETTINGS → AUDIO switches each off (the
 * toggles gate the clips, not just the synthesis).
 */
import { prefs } from "./ui/prefs";
import { ASSET_BASE, assetUrl } from "./asset-base";

type Line = { text: string; prio: number; at: number; kong?: boolean; clip?: string };

const STALE_MS = 2500;
const NUM = ["", "", "DOUBLE KILL", "TRIPLE KILL", "QUAD KILL", "MEGA KILL"];

/** Fixed announcer line -> clip file (under assets/audio/announcer/). */
const CLIPS: Record<string, string> = {
  "GUN GAME": "mode-gun-game.ogg",
  "FREE FOR ALL": "mode-free-for-all.ogg",
  "ELIMINATION": "mode-elimination.ogg",
  "TEAM DEATHMATCH": "mode-team-deathmatch.ogg",
  "ONE MINUTE REMAINING": "one-minute.ogg",
  "THIRTY SECONDS": "thirty-seconds.ogg",
  "TEN SECONDS": "ten-seconds.ogg",
  "YOU HAVE TAKEN THE LEAD": "lead-taken-you.ogg",
  "WE HAVE TAKEN THE LEAD": "lead-taken-we.ogg",
  "YOU HAVE LOST THE LEAD": "lead-lost-you.ogg",
  "WE HAVE LOST THE LEAD": "lead-lost-we.ogg",
  "YOU HAVE FALLEN BEHIND": "fallen-behind-you.ogg",
  "THE ENEMY HAS TAKEN THE LEAD": "lead-enemy.ogg",
  "SCORES ARE TIED": "tied.ogg",
  HEADSHOT: "headshot.ogg",
  DRAW: "draw.ogg",
  VICTORY: "victory.ogg",
  DEFEAT: "defeat.ogg",
};

/**
 * Dynamic lines carry names/counts the clips cannot (FIRST BLOOD! X DROPS Y):
 * the clip covers the fixed head, the subtitle the full text. Exact matches
 * win first so HEADSHOT never falls into a keyword rule.
 */
function clipFor(text: string): string | undefined {
  const exact = CLIPS[text];
  if (exact) return exact;
  if (text.startsWith("FIRST BLOOD")) return "first-blood.ogg";
  if (text.includes("ON A RAMPAGE")) return "rampage.ogg";
  if (text.includes("UNSTOPPABLE")) return "unstoppable.ogg";
  if (text.includes("LIVING LEGEND")) return "legend.ogg";
  if (text.includes("DOUBLE KILL")) return "double-kill.ogg";
  if (text.includes("TRIPLE KILL")) return "triple-kill.ogg";
  if (text.includes("QUAD KILL")) return "quad-kill.ogg";
  if (text.includes("MEGA KILL")) return "mega-kill.ogg";
  if (text.startsWith("SHUTDOWN")) return "shutdown.ogg";
  return undefined;
}

/** Every clip file, so the first line warms (preloads) the whole set. */
const ALL_CLIPS: string[] = (() => {
  const out = new Set(Object.values(CLIPS));
  for (const f of ["first-blood", "rampage", "unstoppable", "legend", "double-kill", "triple-kill", "quad-kill", "mega-kill", "shutdown"]) out.add(`${f}.ogg`);
  const kongCounts: Record<string, number> = { kill: 8, head: 3, reload: 3, frag: 3, spawn: 3, hurt: 2 };
  for (const [cue, n] of Object.entries(kongCounts)) for (let i = 0; i < n; i++) out.add(`kong/${cue}-${i}.ogg`);
  return [...out];
})();

const clipUrl = (file: string): string => assetUrl(`${ASSET_BASE}assets/audio/announcer/${file}`);

export interface AnnounceState {
  live: boolean;
  remain: number;
  score0: number;
  score1: number;
  /** Your team (TDM), or -1. */
  team: number;
  ffa: boolean;
  /** FFA: your kills and the top kill count of anyone else. */
  myKills: number;
  bestOther: number;
  modeLabel: string;
}

export class Announcer {
  private queue: Line[] = [];
  private speaking = false;
  private voice: SpeechSynthesisVoice | null | undefined;
  private sub: HTMLElement | null = null;
  private subTimer = 0;
  private wasLive = false;
  private lastRemain = Infinity;
  /** -1 behind, 0 tied, 1 ahead (from your side), or null before the first call. */
  private lead: number | null = null;
  private kills = 0;
  private lastKong = 0;
  /** Clip cache (one <audio> per file) + the currently playing element. */
  private clips = new Map<string, HTMLAudioElement>();
  private active: HTMLAudioElement | null = null;
  private warmed = false;

  /** Per frame, from Game.paintHud: GO, clock calls and lead changes. */
  tick(s: AnnounceState): void {
    if (s.live && !this.wasLive) {
      this.kills = 0;
      this.lead = 0;
      this.lastRemain = s.remain;
      this.say(s.modeLabel, 3);
    }
    if (!s.live) {
      this.wasLive = false;
      return;
    }
    this.wasLive = true;
    for (const [at, text] of [
      [60, "ONE MINUTE REMAINING"],
      [30, "THIRTY SECONDS"],
      [10, "TEN SECONDS"],
    ] as [number, string][]) {
      if (this.lastRemain > at && s.remain <= at && s.remain > 0) this.say(text, 4);
    }
    this.lastRemain = s.remain;
    let lead: number;
    if (s.ffa) lead = s.myKills > s.bestOther ? 1 : s.myKills === s.bestOther ? 0 : -1;
    else if (s.team === 0 || s.team === 1) {
      const d = s.team === 0 ? s.score0 - s.score1 : s.score1 - s.score0;
      lead = Math.sign(d);
    } else lead = 0;
    if (this.lead !== null && lead !== this.lead && (s.ffa ? s.myKills + s.bestOther : s.score0 + s.score1) > 0) {
      if (lead === 1) this.say(s.ffa ? "YOU HAVE TAKEN THE LEAD" : "WE HAVE TAKEN THE LEAD", 3);
      else if (lead === -1 && this.lead === 1) this.say(s.ffa ? "YOU HAVE LOST THE LEAD" : "WE HAVE LOST THE LEAD", 3);
      else if (lead === -1) this.say(s.ffa ? "YOU HAVE FALLEN BEHIND" : "THE ENEMY HAS TAKEN THE LEAD", 2);
      else if (lead === 0 && this.lead !== 0) this.say("SCORES ARE TIED", 2);
    }
    this.lead = lead;
  }

  /** A kill: first blood, streaks and multi-kills, called with the player's name. */
  kill(killer: string, victim: string, mine: boolean, streak: number, multi: number, head: boolean): void {
    this.kills++;
    if (this.kills === 1 && killer && victim) {
      this.say(`FIRST BLOOD! ${killer} DROPS ${victim}`, 3);
      return;
    }
    if (streak === 5 || streak === 10 || streak === 15) {
      this.say(`${killer} IS ${streak === 5 ? "ON A RAMPAGE" : streak === 10 ? "UNSTOPPABLE" : "A LIVING LEGEND"}! ${streak} IN A ROW`, 3);
      return;
    }
    if (multi >= 2) {
      this.say(mine ? NUM[Math.min(5, multi)]! : `${NUM[Math.min(5, multi)]} FOR ${killer}`, mine ? 3 : 1);
      return;
    }
    if (mine && head) this.say("HEADSHOT", 1);
  }

  /** Someone with a streak went down. */
  shutdown(killer: string, victim: string, streak: number): void {
    if (streak >= 5) this.say(`SHUTDOWN! ${killer} ENDS ${victim}'S STREAK`, 3);
  }

  end(win: boolean, draw: boolean): void {
    this.queue.length = 0;
    this.hush();
    this.say(draw ? "DRAW" : win ? "VICTORY" : "DEFEAT", 5);
  }

  /** hive cbbuhicb: your Kong talks — gruff, broken gorilla English (Halo's Brutes). */
  kong(kind: KongCue): void {
    if (!prefs().kongVoice) return;
    const now = performance.now();
    const kill = kind === "kill" || kind === "head";
    if (now - this.lastKong < (kill ? 1200 : 5000)) return;
    // the chatter stays a spice: every kill gets a line, the rest only sometimes
    if (!kill && Math.random() < 0.5) return;
    this.lastKong = now;
    const lines = KONG_LINES[kind];
    const idx = Math.floor(Math.random() * lines.length);
    this.say(lines[idx]!, 0, true, `kong/${kind}-${idx}.ogg`);
  }

  // ---------------------------------------------------------------- output

  private say(text: string, prio: number, kong = false, clip?: string): void {
    if (!kong && !prefs().announcer) return;
    const now = performance.now();
    this.queue = this.queue.filter((l) => now - l.at < STALE_MS && l.prio >= prio);
    this.queue.push({ text, prio, at: now, kong, clip: clip ?? (!kong ? clipFor(text) : undefined) });
    this.queue.sort((a, b) => b.prio - a.prio);
    if (this.queue.length > 2) this.queue.length = 2;
    this.pump();
  }

  /** Silence a playing clip without touching the queue (end() hushes, then calls). */
  private hush(): void {
    try {
      this.active?.pause();
    } catch {
      /* a pausing clip is best-effort */
    }
    try {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    } catch {
      /* cancelling synthesis is best-effort */
    }
    this.active = null;
    this.speaking = false;
  }

  private pump(): void {
    if (this.speaking) return;
    const now = performance.now();
    let line: Line | undefined;
    while ((line = this.queue.shift()) && now - line.at > STALE_MS) {
      /* stale */
    }
    if (!line) return;
    this.subtitle(line);
    const vol = prefs().master * prefs().ui;
    if (line.clip && vol > 0.01 && this.playClip(line, vol)) return;
    this.synthLine(line, vol);
  }

  /**
   * The generated voice. Returns true when a clip attempt owns the line
   * (playing or loading); false when there is nothing to play with, so the
   * caller falls through to synthesis. Any failure mid-attempt (missing file,
   * undecodable bytes, rejected play()) falls back to synthesis for that line.
   */
  private playClip(line: Line, vol: number): boolean {
    if (typeof Audio === "undefined") return false;
    this.warmClips();
    let el = this.clips.get(line.clip!);
    if (!el) {
      el = new Audio(clipUrl(line.clip!));
      el.preload = "auto";
      this.clips.set(line.clip!, el);
    }
    // A re-fire of the currently playing clip restarts it; the settled guard
    // below keeps the queue advance to exactly one handoff. currentTime is
    // only rewound once metadata is there: on a fresh element it throws and
    // would wrongly force the synthesis fallback for a clip that exists.
    try {
      if (this.active && this.active !== el) {
        try {
          this.active.pause();
        } catch {
          /* a pausing clip is best-effort */
        }
      }
      el.pause();
      if (el.readyState > 0 && (el.currentTime > 0 || el.ended)) el.currentTime = 0;
    } catch {
      return false;
    }
    this.speaking = true;
    this.active = el;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (this.active === el) this.active = null;
      this.speaking = false;
      this.pump();
    };
    el.volume = Math.min(1, vol);
    el.onended = done;
    el.onerror = () => {
      if (settled) return;
      settled = true;
      if (this.active === el) this.active = null;
      this.speaking = false;
      this.synthLine(line, vol);
    };
    // A clip that never ends must never stall the queue for the rest of the
    // match (same guard the synthesis path has).
    const cap = Math.min(8000, 4000 + line.text.length * 45);
    setTimeout(() => {
      if (!settled && this.speaking && this.active === el) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
        done();
      }
    }, cap);
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // play() rejected (no gesture yet, or the file 404d): synthesis.
          if (settled) return;
          settled = true;
          if (this.active === el) this.active = null;
          this.speaking = false;
          this.synthLine(line, vol);
        });
      }
    } catch {
      if (settled) return true;
      settled = true;
      this.active = null;
      this.speaking = false;
      this.synthLine(line, vol);
    }
    return true;
  }

  /** Fire-and-forget preload of the whole clip set, once, on first use. */
  private warmClips(): void {
    if (this.warmed || typeof Audio === "undefined") return;
    this.warmed = true;
    try {
      for (const f of ALL_CLIPS) {
        if (this.clips.has(f)) continue;
        const el = new Audio(clipUrl(f));
        el.preload = "auto";
        this.clips.set(f, el);
      }
    } catch {
      /* preload is best-effort; playClip re-creates on demand */
    }
  }

  /** The synthesis fallback: subtitles alone, or the local voice, as before. */
  private synthLine(line: Line, vol: number): void {
    const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
    const voice = this.pickVoice();
    if (!synth || !voice || vol <= 0.01) {
      // no local voice: the subtitle alone, held for about as long as the line would take
      this.speaking = true;
      setTimeout(() => {
        this.speaking = false;
        this.pump();
      }, 600 + line.text.length * 45);
      return;
    }
    const u = new SpeechSynthesisUtterance(line.kong ? line.text : line.text.toLowerCase().replace(/!/g, "."));
    u.voice = voice;
    u.volume = Math.min(1, vol);
    // the announcer: brisk and level; the Kong: slow, from the bottom of the chest
    u.rate = line.kong ? 0.78 : 1.08;
    u.pitch = line.kong ? 0.05 : 0.7;
    this.speaking = true;
    const done = (): void => {
      this.speaking = false;
      this.pump();
    };
    u.onend = done;
    u.onerror = done;
    // A stuck engine must never stall the queue for the rest of the match.
    setTimeout(() => {
      if (this.speaking) done();
    }, 5000);
    synth.speak(u);
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.voice !== undefined && this.voice !== null) return this.voice;
    if (typeof speechSynthesis === "undefined") return (this.voice = null);
    const local = speechSynthesis.getVoices().filter((v) => v.localService);
    if (!local.length) return null; // voices load late on some browsers: try again next line
    const en = local.filter((v) => /^en/i.test(v.lang));
    const pool = en.length ? en : local;
    this.voice = pool.find((v) => /male|daniel|david|alex|fred|guy/i.test(v.name)) ?? pool[0]!;
    return this.voice;
  }

  private subtitle(line: Line): void {
    if (typeof document === "undefined") return;
    if (!this.sub) {
      this.sub = document.getElementById("announcer-sub") ?? document.createElement("div");
      this.sub.id = "announcer-sub";
      this.sub.setAttribute("aria-live", "polite");
      if (!this.sub.isConnected) (document.getElementById("hud") ?? document.body).append(this.sub);
    }
    this.sub.textContent = line.kong ? `KONG: ${line.text}` : line.text;
    this.sub.classList.toggle("is-kong", !!line.kong);
    this.sub.classList.add("is-on");
    clearTimeout(this.subTimer);
    this.subTimer = window.setTimeout(() => this.sub?.classList.remove("is-on"), 1400 + line.text.length * 55);
  }
}

export type KongCue = "kill" | "head" | "reload" | "frag" | "spawn" | "hurt";

/** hive cbbuhicb: what your Kong says. Short, broken, gorilla-proud. */
const KONG_LINES: Record<KongCue, string[]> = {
  kill: ["Kong smash!", "Too easy. Hah!", "You fall. Kong stand.", "Weak one go down!", "Kong hungry for more!", "Hah! Me break you!", "Run, little monkey!", "Banana for Kong!"],
  head: ["Head go pop!", "Bonk! Right in head!", "Kong aim good!"],
  reload: ["Me need more boom!", "Feed gun!", "Reload! Cover Kong!"],
  frag: ["Catch banana!", "Boom gift for you!", "Eat this!"],
  spawn: ["Kong back! Kong angry!", "Who want smash?", "Kong find you!"],
  hurt: ["Grr! That hurt Kong!", "You make Kong mad!"],
};
