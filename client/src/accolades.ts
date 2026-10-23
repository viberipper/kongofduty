/**
 * client/src/accolades.ts — WHAT A KILL OF YOURS EARNS (feel stream).
 * ===========================================================================
 *
 * Kong Royale's accolade tracker (client/src/game/accolades.ts there), ported
 * to this game's events and restyled as CoD medals (client/src/ui/medals.ts
 * shows them, client/src/medal-stings.ts plays them). Decided ON THE CLIENT
 * from what the event stream already carries — the kill (src, dst, weapon,
 * head, the sim's medal), the frag throws and bursts, the roster's positions
 * and health — so there is no wire change and shared/sim.ts is untouched
 * (the Shipment sim-equivalence hash cannot move).
 *
 *   DOUBLE / TRIPLE / QUAD KILL, RAMPAGE   kills within 6 s of the one before (KR)
 *   HEADSHOT        the lethal round hit the head
 *   LONGSHOT        a gun kill from range (30 m; 40 m with the sniper)
 *   GRENADE KILL    a frag did it          · COOKED: the fuse was cooked ≥ 0.8 s
 *   PAYBACK         you killed the player who last killed you (KR)
 *   REVENGE         you killed an enemy who killed a squadmate seconds ago
 *   FIRST BLOOD     the match's first kill (the sim's own call)
 *   LAST STAND      the kill landed with you on 25 health or less
 *   BUZZKILL        you ended an enemy's streak of 3+
 *   KILLSTREAK 3/5/7/10   the sim's streak rungs (UAV at 3, artillery at 5)
 *
 * WALLBANG is not here because it pays through the score pops, not the medal
 * row: the sim's round runs on through thin soft walls (shared/penetration.ts
 * bulletPath, `wall` on the hit event) and client/src/ui/score-pops.ts adds
 * +50 for it.
 *
 * DOM-free and allocation-light: game.ts calls it on the kill path.
 */

export type MedalId =
  | "double"
  | "triple"
  | "quad"
  | "rampage"
  | "headshot"
  | "longshot"
  | "frag"
  | "cooked"
  | "payback"
  | "revenge"
  | "firstblood"
  | "laststand"
  | "buzzkill"
  | "streak3"
  | "streak5"
  | "streak7"
  | "streak10";

export type Medal = { id: MedalId; title: string; sub: string; tier: 1 | 2 };

/** Display order and sound tier: 2 = the big ones (multi-kills, streaks), 1 = everything else. */
const META: Record<MedalId, { title: string; tier: 1 | 2; rank: number }> = {
  rampage: { title: "RAMPAGE", tier: 2, rank: 0 },
  quad: { title: "QUAD KILL", tier: 2, rank: 1 },
  triple: { title: "TRIPLE KILL", tier: 2, rank: 2 },
  double: { title: "DOUBLE KILL", tier: 2, rank: 3 },
  streak10: { title: "KILLSTREAK 10", tier: 2, rank: 4 },
  streak7: { title: "KILLSTREAK 7", tier: 2, rank: 5 },
  streak5: { title: "KILLSTREAK 5", tier: 2, rank: 6 },
  streak3: { title: "KILLSTREAK 3", tier: 2, rank: 7 },
  payback: { title: "PAYBACK", tier: 1, rank: 8 },
  revenge: { title: "REVENGE", tier: 1, rank: 9 },
  buzzkill: { title: "BUZZKILL", tier: 1, rank: 10 },
  firstblood: { title: "FIRST BLOOD", tier: 1, rank: 11 },
  cooked: { title: "COOKED", tier: 1, rank: 12 },
  longshot: { title: "LONGSHOT", tier: 1, rank: 13 },
  headshot: { title: "HEADSHOT", tier: 1, rank: 14 },
  laststand: { title: "LAST STAND", tier: 1, rank: 15 },
  frag: { title: "GRENADE KILL", tier: 1, rank: 16 },
};

export const CHAIN_S = 6;
export const LONGSHOT_M = 30;
export const LONGSHOT_SNIPER_M = 40;
export const LAST_STAND_HP = 25;
export const REVENGE_S = 5;
export const COOKED_S = 0.8;
export const BUZZKILL_STREAK = 3;

export type KillIn = {
  /** Game clock, seconds. */
  now: number;
  src: string;
  dst: string;
  weapon: string;
  head: boolean;
  /** The sim's medal string (FIRST BLOOD, TRIPLE KILL = streak 3, …). */
  simMedal: string;
  /** Killer → victim distance at the kill, metres (NaN when unknown). */
  dist: number;
  /** The local player's health when the kill landed. */
  myHp: number;
  /** Team of every id involved (FFA: pass ffa=true and teams are ignored). */
  teamOf: (id: string) => number | undefined;
  ffa: boolean;
};

export class AccoladeTracker {
  private chain = 0;
  private chainAt = -1e9;
  private chainT0 = 0;
  /** Who last killed ME (PAYBACK). */
  private nemesis = "";
  /** Every player's last kill: who they killed and when (REVENGE). */
  private lastKill = new Map<string, { dst: string; at: number }>();
  /** Every player's current streak as the event stream has seen it (BUZZKILL). */
  private streaks = new Map<string, number>();
  /** A kill has been seen this match (FIRST BLOOD is the very first one). */
  private anyKill = false;
  /** Frag throw times by nade id, and the newest burst per thrower (COOKED). */
  private thrown = new Map<number, number>();
  private burst = new Map<string, { at: number; flight: number }>();

  constructor(public you = "") {}

  reset(you = this.you): void {
    this.you = you;
    this.chain = 0;
    this.chainAt = -1e9;
    this.nemesis = "";
    this.anyKill = false;
    this.lastKill.clear();
    this.streaks.clear();
    this.thrown.clear();
    this.burst.clear();
  }

  /** A player's current streak as the event stream has counted it. */
  streakOf(id: string): number {
    return this.streaks.get(id) ?? 0;
  }

  /** A frag left a hand (net event "nade"). */
  nadeThrown(id: number, now: number): void {
    this.thrown.set(id, now);
    if (this.thrown.size > 32) this.thrown.delete(this.thrown.keys().next().value!);
  }

  /** A frag went off (net event "boom"): how long it flew after the throw. */
  nadeBoom(id: number, src: string, now: number): void {
    const at = this.thrown.get(id);
    this.thrown.delete(id);
    // No throw seen: it went off in the hand (a full cook), or we joined after the throw.
    this.burst.set(src, { at: now, flight: at === undefined ? 0 : now - at });
  }

  /**
   * EVERY kill in the match goes through here (the bookkeeping needs them all);
   * the return is the local player's medals for this kill, highest first — empty
   * when the kill was not theirs or earned nothing beyond the kill itself.
   */
  kill(k: KillIn, fuse: number): Medal[] {
    const out: Medal[] = [];
    const victimStreak = this.streaks.get(k.dst) ?? 0;
    const first = !this.anyKill && k.src !== k.dst;
    if (k.src !== k.dst) this.anyKill = true;
    // Bookkeeping for everyone.
    this.streaks.set(k.dst, 0);
    if (k.src !== k.dst) this.streaks.set(k.src, (this.streaks.get(k.src) ?? 0) + 1);
    const avenged = this.lastKill.get(k.dst);
    if (k.src !== k.dst) this.lastKill.set(k.src, { dst: k.dst, at: k.now });
    if (k.dst === this.you && k.src !== this.you) this.nemesis = k.src;
    if (k.dst === this.you) {
      // Dying ends your chain.
      this.chain = 0;
      this.chainAt = -1e9;
    }
    if (k.src !== this.you || k.dst === this.you) return out;

    const add = (id: MedalId, sub: string): void => {
      out.push({ id, title: META[id].title, sub, tier: META[id].tier });
    };
    const gun = k.weapon !== "nade" && k.weapon !== "strike" && k.weapon !== "knife" && k.weapon !== "melee";
    // Multi-kills (KR: within 6 s of the one before).
    if (k.now - this.chainAt <= CHAIN_S) this.chain++;
    else {
      this.chain = 1;
      this.chainT0 = k.now;
    }
    this.chainAt = k.now;
    const secs = Math.max(1, Math.round(k.now - this.chainT0));
    if (this.chain === 2) add("double", `2 KILLS IN ${secs} S`);
    else if (this.chain === 3) add("triple", `3 KILLS IN ${secs} S`);
    else if (this.chain === 4) add("quad", `4 KILLS IN ${secs} S`);
    else if (this.chain >= 5) add("rampage", `${this.chain} KILLS IN ${secs} S`);
    // The sim's streak rungs (its medal string is the authority: the UAV / the
    // artillery ride the same count); past 10, every fifth kill.
    const st = this.streaks.get(this.you) ?? 0;
    if (k.simMedal === "TRIPLE KILL") add("streak3", "UAV ONLINE");
    else if (k.simMedal === "FURY KILL") add("streak5", "ARTILLERY INBOUND");
    else if (k.simMedal === "RELENTLESS") add("streak7", "7 WITHOUT DYING");
    else if (k.simMedal === "UNSTOPPABLE" && st >= 10 && st % 5 === 0) add("streak10", `${st} WITHOUT DYING`);
    if (k.dst === this.nemesis) {
      this.nemesis = "";
      add("payback", "GOT YOUR KILLER");
    }
    if (!k.ffa && avenged && k.now - avenged.at <= REVENGE_S) {
      const t = k.teamOf(avenged.dst);
      if (avenged.dst !== this.you && t !== undefined && t === k.teamOf(this.you)) add("revenge", "AVENGED A SQUADMATE");
    }
    if (victimStreak >= BUZZKILL_STREAK) add("buzzkill", `ENDED A ${victimStreak} STREAK`);
    // The sim calls FIRST BLOOD on anyone's first kill without a death in FFA
    // (its test reads team scores FFA never moves); the first kill this client
    // saw is the tiebreak.
    if (k.simMedal === "FIRST BLOOD" && first) add("firstblood", "FIRST KILL OF THE MATCH");
    if (k.weapon === "nade") {
      const b = this.burst.get(k.src);
      const cooked = b && k.now - b.at < 0.5 ? fuse - b.flight : 0;
      if (b && b.flight > 0 && cooked >= COOKED_S) add("cooked", `${cooked.toFixed(1)} S COOK`);
      else add("frag", "FRAG");
    }
    if (gun && Number.isFinite(k.dist) && k.dist >= (k.weapon === "sniper" ? LONGSHOT_SNIPER_M : LONGSHOT_M)) add("longshot", `${Math.round(k.dist)} M`);
    if (gun && k.head) add("headshot", "RIGHT BETWEEN THE EYES");
    if (k.myHp > 0 && k.myHp <= LAST_STAND_HP) add("laststand", `ON ${Math.max(1, Math.round(k.myHp))} HEALTH`);
    out.sort((a, b) => META[a.id].rank - META[b.id].rank);
    return out;
  }
}
