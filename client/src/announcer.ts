/**
 * client/src/announcer.ts — THE MATCH ANNOUNCER (hive).
 * ===========================================================================
 *
 * A game-show caller over the match: the mode at GO, the clock at one minute /
 * thirty / ten seconds, the lead changing hands, first blood, streaks and
 * multi-kills called BY NAME, and the result. Every line is also a subtitle
 * (#announcer-sub) so it reads with the sound off.
 *
 * The voice is the browser's own speech synthesis, restricted to voices that
 * run ON THIS COMPUTER (`localService`): the network voices some browsers offer
 * would send every line to a third-party server, so a machine with only those
 * gets subtitles and no voice. Lines queue by priority and never pile up: a
 * newer, more important line replaces a waiting one, and stale lines drop.
 *
 * Also YOUR KONG'S OWN VOICE (hive cbbuhicb): broken, Brute-style English on
 * its kills, headshots, reloads, frags, respawns and when it is hurt — `kong()`
 * — pitched deep and slow, on the same local-voice rule, behind its own switch.
 *
 * Volume follows MASTER x INTERFACE; SETTINGS → AUDIO switches each off.
 */
import { prefs } from "./ui/prefs";

type Line = { text: string; prio: number; at: number; kong?: boolean };

const STALE_MS = 2500;
const NUM = ["", "", "DOUBLE KILL", "TRIPLE KILL", "QUAD KILL", "MEGA KILL"];

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
    this.say(lines[Math.floor(Math.random() * lines.length)]!, 0, true);
  }

  // ---------------------------------------------------------------- output

  private say(text: string, prio: number, kong = false): void {
    if (!kong && !prefs().announcer) return;
    const now = performance.now();
    this.queue = this.queue.filter((l) => now - l.at < STALE_MS && l.prio >= prio);
    this.queue.push({ text, prio, at: now, kong });
    this.queue.sort((a, b) => b.prio - a.prio);
    if (this.queue.length > 2) this.queue.length = 2;
    this.pump();
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
    const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
    const voice = this.pickVoice();
    const vol = prefs().master * prefs().ui;
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
