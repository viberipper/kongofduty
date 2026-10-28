/**
 * client/src/voice-lines.ts — EVERY SPOKEN LINE, as text.
 * ===========================================================================
 *
 * Ported from upstream (.origin 28.10. client/src/voice-lines.ts CALLS):
 * the Modi/Time/Lead/Streak/Headshot/Resultat/multi-2..5 content table,
 * used here as the TEXT source (banner + subtitle wording).
 *
 * Adapted to our clip system — no broken references:
 *  - Upstream renders audio/voice/<id>.mp3 via scripts/build-voice-lines.mjs
 *    (multi-kills cut from audio-sources/voice/kong-kill-streaks.wav with
 *    from/to seconds, everything else ElevenLabs TTS with a `tag`).
 *    That script is deliberately NOT ported: our clips are pre-rendered
 *    .ogg committed under static/assets/audio/announcer/ (Warlord lines plus
 *    per-killer kong/<cue>-<i>.ogg clone variants, see manifest.json and
 *    client/src/announcer.ts CLIPS), so a WAV/TTS build step has nothing to
 *    build from and would only add a dead dependency.
 *  - One wording delta vs upstream: multi-5 is "MEGA KILL" here (mega-kill.ogg),
 *    not upstream's "Killtacular!" cut.
 *
 * No imports: like upstream, this file loads anywhere (docs, tests, Node).
 */

export type VoiceCallId =
  | "mode-tdm"
  | "mode-ffa"
  | "mode-gun"
  | "mode-elim"
  | "time-60"
  | "time-30"
  | "time-10"
  | "lead-we-took"
  | "lead-you-took"
  | "lead-we-lost"
  | "lead-you-lost"
  | "lead-enemy"
  | "lead-behind"
  | "lead-tied"
  | "first-blood"
  | "streak-5"
  | "streak-10"
  | "streak-15"
  | "headshot"
  | "shutdown"
  | "victory"
  | "defeat"
  | "draw"
  | "multi-2"
  | "multi-3"
  | "multi-4"
  | "multi-5";

/** Spoken text plus the pre-rendered clip under static/assets/audio/announcer/. */
export const VOICE_CALLS: Record<VoiceCallId, { text: string; clip: string }> = {
  "mode-tdm": { text: "Team Deathmatch!", clip: "mode-team-deathmatch.ogg" },
  "mode-ffa": { text: "Free for all!", clip: "mode-free-for-all.ogg" },
  "mode-gun": { text: "Gun Game!", clip: "mode-gun-game.ogg" },
  "mode-elim": { text: "Elimination!", clip: "mode-elimination.ogg" },
  "time-60": { text: "One minute remaining!", clip: "one-minute.ogg" },
  "time-30": { text: "Thirty seconds!", clip: "thirty-seconds.ogg" },
  "time-10": { text: "Ten seconds!", clip: "ten-seconds.ogg" },
  "lead-we-took": { text: "We have taken the lead!", clip: "lead-taken-we.ogg" },
  "lead-you-took": { text: "You have taken the lead!", clip: "lead-taken-you.ogg" },
  "lead-we-lost": { text: "We have lost the lead!", clip: "lead-lost-we.ogg" },
  "lead-you-lost": { text: "You have lost the lead!", clip: "lead-lost-you.ogg" },
  "lead-enemy": { text: "The enemy has taken the lead!", clip: "lead-enemy.ogg" },
  "lead-behind": { text: "You have fallen behind!", clip: "fallen-behind-you.ogg" },
  "lead-tied": { text: "Scores are tied!", clip: "tied.ogg" },
  "first-blood": { text: "First blood!", clip: "first-blood.ogg" },
  "streak-5": { text: "Rampage!", clip: "rampage.ogg" },
  "streak-10": { text: "Unstoppable!", clip: "unstoppable.ogg" },
  "streak-15": { text: "Living legend!", clip: "legend.ogg" },
  headshot: { text: "Headshot!", clip: "headshot.ogg" },
  shutdown: { text: "Shutdown!", clip: "shutdown.ogg" },
  victory: { text: "Victory!", clip: "victory.ogg" },
  defeat: { text: "Defeat.", clip: "defeat.ogg" },
  draw: { text: "Draw.", clip: "draw.ogg" },
  "multi-2": { text: "Double kill!", clip: "double-kill.ogg" },
  "multi-3": { text: "Triple kill!", clip: "triple-kill.ogg" },
  "multi-4": { text: "Quad kill!", clip: "quad-kill.ogg" },
  "multi-5": { text: "Mega kill!", clip: "mega-kill.ogg" },
};
