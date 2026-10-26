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
 * SPAM CONTROL (say-gating, no finish-path changes): the mode call fires only
 * at match start (round 2+ re-arms the clocks but never repeats it), first
 * blood fires once per match, multi-kills hold a 4 s upgrade window so only
 * the highest multi speaks, repeats are damped per line (mode 30 s, lead
 * 25 s, foreign streaks 20 s, shutdowns 15 s), foreign multis stay silent
 * (never enter the multi window — see the game.ts gate), a 2.2 s global pacing gap
 * separates announcer voices (result cuts through), and whatever loses is
 * subtitle-only. Foreign first blood, streaks and shutdowns are subtitle-only,
 * foreign multis stay silent, and damped repeats, never take the voice. Priority: result (5) > multi (4) = clock (4) > streak/mode (3) >
 * lead (2) > info (1) > Kong (0).
 *
 * KILL VOICE EXCLUSION: a kill-related announcer voice for YOUR kill (first
 * blood, your streak, your multi-kill incl. its pending upgrade window, or a
 * shutdown you are involved in) and your Kong's kill line ("Kong smash!") are
 * mutually exclusive — the announcer wins, the Kong line for that kill is
 * dropped. The Kong still talks on kills the announcer leaves alone (plain
 * singles) and always on reload/hurt/spawn/frag. Implemented as a shared kill
 * stamp (killSeq/killVoiceSeq, no timers): every kill() / shutdown() call takes
 * the next sequence number, voice paths for your kills stamp it, and kong()
 * stays silent for kill/head cues when the stamp matches the latest kill — so
 * rapid follow-up kills can never inherit a stale stamp.
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

type Line = { text: string; prio: number; at: number; kong?: boolean; clip?: string; voice: boolean; coolKey?: string };

const STALE_MS = 4000;
/** Minimum airtime between two announcer voice lines (result cuts through). */
const ANNOUNCE_GAP_MS = 2200;
/** Multi-kill upgrade window: a higher multi inside it replaces the lower one. */
const MULTI_WINDOW_MS = 4000;
/** Repeat damping per line family (ms). */
const MODE_COOL_MS = 30000;
const LEAD_COOL_MS = 25000;
const STREAK_FOREIGN_COOL_MS = 20000;
const SHUTDOWN_COOL_MS = 15000;
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
  /** Current round number (1-based) in round-based modes, 0 everywhere else. */
  roundN: number;
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
  /** Own-side score at the last tick (TDM: your team's score, FFA: your kills). */
  private leadScore = 0;
  private kills = 0;
  private lastKong = 0;
  /** First blood fired this match (match-scoped: exactly once per match). */
  private bloodSeen = false;
  /** Last announcer (non-Kong) voice start, for the global pacing gap. */
  private lastVoiceAt = -1e9;
  /** Last voice start per cooldown key (repeat damping). */
  private lastVoiceByKey = new Map<string, number>();
  /** Deferred pump while the pacing gap is still open. */
  private gapTimer = 0;
  /** Pending multi-kill upgrade: only the highest multi in the window speaks. */
  private multiPending: { level: number; killer: string; mine: boolean; kid: number } | null = null;
  private multiTimer = 0;
  /** Kill-voice exclusion stamp: sequence number of the latest kill() /
   *  shutdown() call, and of the latest of those calls whose announcer line
   *  for YOUR kill takes (or, for a pending multi, will take) the voice.
   *  kong() drops kill/head lines while both match — the announcer owns that
   *  kill, so the Kong stays silent instead of doubling it. */
  private killSeq = 0;
  private killVoiceSeq = -1;
  /** Clip cache (one <audio> per file) + the currently playing element. */
  private clips = new Map<string, HTMLAudioElement>();
  private active: HTMLAudioElement | null = null;
  private warmed = false;

  /** Per frame, from Game.paintHud: GO, clock calls and lead changes. */
  tick(s: AnnounceState): void {
    if (s.live && !this.wasLive) {
      this.lastRemain = s.remain;
      if ((s.roundN | 0) <= 1) {
        // MATCH start (or a mode without rounds): full reset, mode call once.
        this.kills = 0;
        this.bloodSeen = false;
        this.lead = 0;
        this.leadScore = 0;
        this.clearMulti();
        // Fresh match, fresh ears: the GO call always speaks, later repeats
        // of the same mode line are damped for MODE_COOL_MS.
        this.lastVoiceByKey.delete(`mode:${s.modeLabel}`);
        this.say(s.modeLabel, 3, false, undefined, true, `mode:${s.modeLabel}`, MODE_COOL_MS);
      } else {
        // ROUND start (round 2+): clocks re-arm, but the mode is NOT called
        // again and match-scoped state (first blood, streak kills) survives.
        this.clearMulti();
      }
    }
    if (!s.live) {
      this.clearMulti();
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
    const myScore = s.ffa ? s.myKills : s.team === 0 ? s.score0 : s.team === 1 ? s.score1 : 0;
    const total = s.ffa ? s.myKills + s.bestOther : s.score0 + s.score1;
    if (this.lead !== null && total > 0) {
      // Lead-taken only from the leading side's 3rd point: 1:0 and 2:0 stay
      // fully silent (no voice, no subtitle). Fires on the lead change into a
      // 3+ lead, or when a still-unannounced lead grows to 3 (lead unchanged).
      if (lead === 1 && myScore >= 3 && (this.lead !== 1 || this.leadScore < 3)) {
        // Lead lines are damped (25 s per line): a swingy match must not loop them.
        this.sayLead(s.ffa ? "YOU HAVE TAKEN THE LEAD" : "WE HAVE TAKEN THE LEAD");
      } else if (lead !== this.lead) {
        if (lead === -1 && this.lead === 1) this.sayLead(s.ffa ? "YOU HAVE LOST THE LEAD" : "WE HAVE LOST THE LEAD");
        else if (lead === -1) this.sayLead(s.ffa ? "YOU HAVE FALLEN BEHIND" : "THE ENEMY HAS TAKEN THE LEAD");
        else if (lead === 0 && this.lead !== 0) this.sayLead("SCORES ARE TIED");
      }
    }
    this.lead = lead;
    this.leadScore = myScore;
  }

  /** Lead call with repeat damping (prio 2: streaks and multis outrank it). */
  private sayLead(text: string): void {
    this.say(text, 2, false, undefined, true, `lead:${text}`, LEAD_COOL_MS);
  }

  /** A kill: first blood, streaks and multi-kills, called with the player's name. */
  kill(killer: string, victim: string, mine: boolean, streak: number, multi: number, head: boolean): void {
    // Kill-voice exclusion stamp (see kong()): every kill takes the next
    // sequence number. Only your kills can collide with your Kong, and only
    // while the announcer itself is switched on — with it off there is no
    // voice to defer to, so nothing is stamped.
    const kid = ++this.killSeq;
    const ownVoice = mine && prefs().announcer;
    this.kills++;
    if (!this.bloodSeen && this.kills === 1 && killer && victim) {
      this.bloodSeen = true;
      if (ownVoice) this.killVoiceSeq = kid;
      // Strangers' openers are subtitles: only your first blood speaks.
      this.say(`FIRST BLOOD! ${killer} DROPS ${victim}`, mine ? 3 : 1, false, undefined, mine);
      return;
    }
    // Killstreak toggle (SETTINGS → AUDIO, default OFF): the streak and
    // multi-kill branches below are skipped entirely — no voice, no subtitle,
    // no pending window/timer, no kill-voice stamp (so the Kong still talks on
    // those kills). Shutdowns stay outside the toggle (shutdown(), unchanged).
    const ks = prefs().killstreaks;
    if ((streak === 5 || streak === 10 || streak === 15) && ks) {
      // A streak call covers any pending multi: same killer (the streak is
      // the bigger news) and other killers alike (no double voice right
      // after the streak) — drop it.
      if (this.multiPending) this.clearMulti();
      // Player relevance: your streaks speak (3), anyone else's is subtitle-only
      // (1) and repeats per killer at most every 20 s.
      if (ownVoice) this.killVoiceSeq = kid;
      this.say(
        `${killer} IS ${streak === 5 ? "ON A RAMPAGE" : streak === 10 ? "UNSTOPPABLE" : "A LIVING LEGEND"}! ${streak} IN A ROW`,
        mine ? 3 : 1,
        false,
        undefined,
        mine,
        mine ? undefined : `streak:${killer}`,
        mine ? 0 : STREAK_FOREIGN_COOL_MS,
      );
      return;
    }
    if (multi >= 2 && ks) {
      // No "Double... Triple... Quad..." pile-up: hold the window and speak
      // only the highest multi reached inside it (prio 4: above streaks).
      // Stamped now, not when the window fires — the Kong line for this kill
      // is decided at kill time, while the announcer line is still pending.
      // If the pending is discarded before it speaks (clearMulti/pushMulti
      // take the stamp back), the Kong must not stay silent for a voiceless kill.
      if (ownVoice) this.killVoiceSeq = kid;
      this.pushMulti(killer, Math.min(5, multi), mine, kid);
      return;
    }
    if (mine && head) {
      // Kill-voice stamp like every other voiced own-kill path above: without
      // it kong("head") fires for the same kill and the voice doubles.
      if (ownVoice) this.killVoiceSeq = kid;
      this.say("HEADSHOT", 1);
    }
  }

  /** Someone with a streak went down. */
  shutdown(killer: string, victim: string, streak: number, involved = false): void {
    const kid = ++this.killSeq;
    // Your streaks (ended or ending) speak; strangers' shutdowns are subtitles.
    if (streak >= 5) {
      // Kill-voice stamp only when the line really takes the voice: the
      // damping decision is computed once here and passed to say() as voice,
      // so a repeat inside the 15 s window stays subtitle-only AND leaves the
      // Kong unstamped (say() re-checks the same key, consistently degrading).
      // Mirrors the coolKey/coolMs check in say().
      const now = performance.now();
      const willVoice =
        involved && prefs().announcer && now - (this.lastVoiceByKey.get(`shutdown:${victim}`) ?? -1e12) >= SHUTDOWN_COOL_MS;
      if (willVoice) this.killVoiceSeq = kid;
      this.say(`SHUTDOWN! ${killer} ENDS ${victim}'S STREAK`, involved ? 3 : 1, false, undefined, willVoice, `shutdown:${victim}`, SHUTDOWN_COOL_MS);
    }
  }

  /** Hold a multi-kill for the upgrade window; only the highest speaks. */
  private pushMulti(killer: string, level: number, mine: boolean, kid: number): void {
    // Highest wins across killers: replace only for the same killer (higher
    // level) or when the new level beats the pending one — a pending Quad
    // for A must survive a Double for B.
    if (this.multiPending && (killer === this.multiPending.killer ? level <= this.multiPending.level : level < this.multiPending.level)) {
      if (this.killVoiceSeq === kid) this.killVoiceSeq = -1;
      return;
    }
    const old = this.multiPending;
    this.multiPending = { level, killer, mine, kid };
    // A displaced pending never speaks, so its optimistic kill-voice stamp
    // goes back — else the Kong stays silent for a voice that never comes.
    // A no-op unless the stamp still points at the displaced pending: own
    // upgrades already restamped the new kill above, and a foreign pending
    // (unreachable via game.ts, which gates multi to 0 for foreign kills)
    // was never stamped (stamps only ever point at own kills, so === is exact).
    if (old && this.killVoiceSeq === old.kid) this.killVoiceSeq = -1;
    if (typeof window !== "undefined") {
      clearTimeout(this.multiTimer);
      this.multiTimer = window.setTimeout(() => this.fireMulti(), MULTI_WINDOW_MS);
    } else this.fireMulti();
  }

  private fireMulti(): void {
    const p = this.multiPending;
    this.multiPending = null;
    this.multiTimer = 0;
    if (!p || !this.wasLive) return;
    // Toggled off mid-window: the pending multi never speaks (clearMulti
    // retracts its kill-voice stamp, so the Kong is free to talk that kill).
    if (!prefs().killstreaks) {
      if (this.killVoiceSeq === p.kid) this.killVoiceSeq = -1;
      return;
    }
    // Your multis speak (prio 4); anyone else's stays silent — game.ts gates
    // multi to 0 for foreign kills, so foreign multis never enter the window
    // and the else branch below is unreachable via game.ts (kept, not removed).
    if (p.mine) this.say(NUM[p.level]!, 4);
    else this.say(`${NUM[p.level]} FOR ${p.killer}`, 1, false, undefined, false);
  }

  private clearMulti(): void {
    // Same retraction as in pushMulti: a discarded own pending (round/match
    // end, streak cover) never speaks, so its stamp goes back. A no-op unless
    // the stamp still points at the discarded pending (a newer own kill
    // restamped since, or the pending was foreign and never stamped).
    if (this.multiPending && this.killVoiceSeq === this.multiPending.kid) this.killVoiceSeq = -1;
    this.multiPending = null;
    if (typeof window !== "undefined" && this.multiTimer) clearTimeout(this.multiTimer);
    this.multiTimer = 0;
  }

  end(win: boolean, draw: boolean): void {
    this.queue.length = 0;
    this.hush();
    this.say(draw ? "DRAW" : win ? "VICTORY" : "DEFEAT", 5);
  }

  /** hive cbbuhicb: your Kong talks — gruff, broken gorilla English (Halo's Brutes). */
  kong(kind: KongCue): void {
    if (!prefs().kongVoice) return;
    // KILL VOICE EXCLUSION: the announcer owns this kill (first blood, your
    // streak, your pending multi-kill, or your shutdown all stamped killSeq) —
    // exactly one of the two speaks, and it is not the Kong. Every other cue
    // (reload/hurt/spawn/frag) and every kill the announcer leaves alone
    // (plain singles) still talk.
    if ((kind === "kill" || kind === "head") && this.killSeq > 0 && this.killVoiceSeq === this.killSeq) return;
    const now = performance.now();
    const kill = kind === "kill" || kind === "head";
    // Damped: no endless roaring — a kill line every few seconds at most.
    if (now - this.lastKong < (kill ? 4000 : 8000)) return;
    // the chatter stays a spice: every kill gets a line, the rest only sometimes
    if (!kill && Math.random() < 0.5) return;
    this.lastKong = now;
    const lines = KONG_LINES[kind];
    const idx = Math.floor(Math.random() * lines.length);
    this.say(lines[idx]!, 0, true, `kong/${kind}-${idx}.ogg`);
  }

  // ---------------------------------------------------------------- output

  /**
   * Queue a line. `voice=false` (repeat-damped or foreign lines) shows only
   * the subtitle. `coolKey`/`coolMs` damp repeats: a line heard recently is
   * demoted to subtitle-only instead of looping. Priority order: result (5) >
   * multi-kill (4) = clock (4) > streak (3) = mode (3) > lead (2) > info (1) >
   * Kong (0).
   */
  private say(text: string, prio: number, kong = false, clip?: string, voice = true, coolKey?: string, coolMs = 0): void {
    if (!kong && !prefs().announcer) return;
    const now = performance.now();
    if (voice && !kong && coolKey && coolMs > 0) {
      const last = this.lastVoiceByKey.get(coolKey) ?? -1e12;
      if (now - last < coolMs) voice = false;
    }
    this.queue = this.queue.filter((l) => now - l.at < STALE_MS && l.prio >= prio);
    this.queue.push({ text, prio, at: now, kong, clip: clip ?? (!kong ? clipFor(text) : undefined), voice, coolKey });
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
    while (this.queue.length && now - this.queue[0]!.at > STALE_MS) this.queue.shift(); // stale
    const line = this.queue[0];
    if (!line) return;
    if (!line.voice) {
      // Subtitle-only (damped/foreign): show the text, hold the slot briefly.
      this.queue.shift();
      this.subtitle(line);
      this.speaking = true;
      setTimeout(() => {
        this.speaking = false;
        this.pump();
      }, 350);
      return;
    }
    if (!line.kong && line.prio < 5 && now - this.lastVoiceAt < ANNOUNCE_GAP_MS) {
      // Global pacing: at most one announcer voice per gap (result cuts through).
      if (!this.gapTimer && typeof window !== "undefined") {
        const wait = ANNOUNCE_GAP_MS - (now - this.lastVoiceAt) + 50;
        this.gapTimer = window.setTimeout(() => {
          this.gapTimer = 0;
          this.pump();
        }, wait);
      }
      return;
    }
    this.queue.shift();
    this.subtitle(line);
    this.lastVoiceAt = performance.now();
    if (line.coolKey) this.lastVoiceByKey.set(line.coolKey, this.lastVoiceAt);
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
