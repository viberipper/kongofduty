/**
 * shared/highlights.ts — PLAY OF THE GAME: what happened, and which bit was best.
 * ===========================================================================
 *
 * AUTHORITY. The process that runs the sim scores the match: the server for
 * every online room (server/cine.ts feeds it the drained events of each
 * room), the local GameSession's owner for an offline bot match (Game feeds it
 * the same events). At match end it picks ONE window — a player and a span of
 * session time — and announces it ({ t: "potg" } on the wire). Every client
 * then replays that same window from its OWN tape of the snapshots it drew
 * (client/src/cine/match-tape.ts), so every screen shows the same play from
 * the same eyes, and nothing about the replay itself has to cross the wire.
 *
 * Pure and DOM-free: the recorder reads the session through SessionLike and
 * asks line-of-sight questions through an injectable `los` (traceWorld on the
 * server and the client, a stub in the tests); scoreHighlights() is a
 * function of plain records, which is what the tests drive
 * (qa/cine-highlights.test.ts).
 *
 * WHAT SCORES (additive, per moment, then per window):
 *   kill                      100, +30 headshot, +60 wallbang
 *                             x0.25 when the victim was NOT on the killer's screen
 *                             (outside the view cone or behind cover): a kill the
 *                             replay cannot show is worth little in a replay
 *   longshot                  +5 per metre past 30 m (cap +150)
 *   collateral                +220 per extra body off ONE trigger pull (same sim
 *                             tick: the sim's own COLLATERAL medal, or the same
 *                             drained batch with the same gun)
 *   multi-kill                chain of kills each within MULTI_GAP_S of the last:
 *                             2 +150, 3 +350, 4 +600, 5 +900, 6+ +1300 — x1.25
 *                             when the chain is tight, x0.7 when it is spread out
 *   clutch (round modes)      kills made as your team's last one alive:
 *                             won 1vN (N >= 2): +150 + 250 x (N - 1)
 *   round-ending kill         +80
 *   plant / defuse            +90 / +120; UNDER FIRE (you took damage in the last
 *                             4 s, or an enemy within 30 m had line of sight to
 *                             you) +260 / +320; a defuse with 2+ attackers alive +150
 *   Domination capture        +110, +170 per kill you made around it
 *   match-winning kill        +70
 *   looking at nothing        -120 per second the player's aim was pinned at the
 *                             sky or the floor inside the window
 *
 * BIG ON SCREEN. A seen gun kill inside 12 m is worth x1.25, past 20 m x0.6:
 * a victim that fills the frame reads; a speck does not.
 *
 * ALWAYS A PLAY. Any match with a kill replays its best window (a lone plain
 * kill included: tagged "plain"); pick() is null only for a match without a
 * kill, and the client shows the MATCH MVP card then.
 *
 * READABLE OR NOTHING. A window is a candidate only if every kill of its player
 * inside it reads in first person: in the view cone, a clear line, and the
 * victim at least MIN_FRAME_FRAC of the frame tall at the killer's FOV.
 *
 * WINDOW. LEAD_S (≤ 1.6 s) before the first moment, TAIL_S after the last,
 * never before the match went live or the life began, never longer than
 * MAX_WINDOW_S. No padding: a quick play is a short clip, and the replay earns
 * its length with slow motion on every kill (client/src/cine/potg.ts).
 */
import type { NetEvent } from "./protocol";
import { WEAPON_BY_ID } from "./weapons";

/** Kills this close together (s) are one multi-kill. CoD's medal window is ~4-5 s. */
export const MULTI_GAP_S = 4.5;
/** A player's moments this close together (s) are one candidate window. */
export const CHAIN_GAP_S = 5.5;
export const LONGSHOT_M = 30;
/** Window shaping (s): lead-up before the first moment, tail after the last. */
export const LEAD_S = 1.6;
export const TAIL_S = 1.5;
export const MAX_WINDOW_S = 10;
/** Under fire: damage taken this recently (s), or an enemy with sight of you this close (m). */
export const UNDER_FIRE_S = 4;
export const UNDER_FIRE_LOS_M = 30;
/** Below this a window is a "plain" play, not no play: pick() replays the best window of every match with a kill (a lone plain kill is ~100). */
export const POTG_MIN_SCORE = 300;
/** A kill reads on screen when the victim was within this half-angle of the killer's aim (rad). */
export const VIEW_CONE = 0.62;
/** Aim pinned past these pitches (rad; the sim's pitch is POSITIVE DOWN) counts as looking at nothing:
 *  more than 25° up (ceilings, sky) or more than 50° down (the floor). */
export const BAD_PITCH_UP = 0.44;
export const BAD_PITCH_DOWN = 0.87;
/** A victim further than this from the killer is a speck in a first-person replay (m). */
export const SEEN_MAX_M = 28;
/** A kill READS when the victim stands at least this share of the frame's height in the killer's first-person view. */
export const MIN_FRAME_FRAC = 0.1;
/** The first-person replay's vertical FOV (deg) at hip; ADS uses the weapon's adsFov. Body height for the measure (m). */
const HIP_VFOV = 68;
const BODY_M = 1.8;
/** Share of the frame's height a body `dist` metres away fills at vertical FOV `fovDeg`. */
export function frameFrac(dist: number, fovDeg: number): number {
  return BODY_M / (2 * Math.max(0.1, dist) * Math.tan((fovDeg * Math.PI) / 360));
}

export type HlKill = {
  t: number;
  src: string;
  dst: string;
  srcTeam: number;
  weapon: string;
  head: boolean;
  /** Killer eye to victim, metres. */
  dist: number;
  wall: boolean;
  /** Alive on the killer's team right after the kill (round modes; 0 = unknown). */
  srcAlive: number;
  /** Alive on the victim's team right BEFORE the kill (round modes; 0 = unknown). */
  dstAliveBefore: number;
  round: number;
  /** Victim in the killer's view cone with a clear line (default true when unknown). */
  seen?: boolean;
  /** Same trigger pull as the previous kill by this src (sim tick, not processing time). */
  collateral?: boolean;
};

export type HlObjective = {
  t: number;
  kind: "plant" | "defuse" | "capture";
  by: string;
  team: number;
  site: string;
  underFire: boolean;
  /** Enemies alive at that moment (defuse ninja check). */
  enemiesAlive: number;
  x: number;
  z: number;
};

export type HlRound = { round: number; t: number; winner: number };

export type HlTape = {
  kills: HlKill[];
  objectives: HlObjective[];
  rounds: HlRound[];
  /** Spawn times per player (id -> times). */
  spawns: Map<string, number[]>;
  names: Map<string, string>;
  teams: Map<string, number>;
  /** Session time the match went live (the window never starts before it). */
  liveAt: number;
  /** Session time the match ended. */
  endAt: number;
  ffa: boolean;
  /** Per player, merged [start, end] spans of aim pinned at sky/floor. */
  badAim?: Map<string, [number, number][]>;
};

/** The announced play. Times are SESSION seconds (Snapshot.time, the tape clock / 1000). */
export type Highlight = {
  id: string;
  name: string;
  team: number;
  t0: number;
  t1: number;
  /** The moments inside the window (kill / objective times), for slow-mo and the finisher. */
  keys: number[];
  score: number;
  /** "TRIPLE KILL", "1v3 CLUTCH", "DEFUSED UNDER FIRE" … */
  title: string;
  /** "3 kills in 2.4 s · 2 headshots · 41 m longshot" */
  line: string;
  tags: string[];
};

/** The wire message. */
export type PotgMsg = { t: "potg" } & Highlight;

const MULTI_BONUS = [0, 0, 150, 350, 600, 900, 1300];
const MULTI_TITLE = ["", "", "DOUBLE KILL", "TRIPLE KILL", "QUAD KILL", "FURY KILL", "RAMPAGE"];

type Moment = { t: number; kind: "kill" | "plant" | "defuse" | "capture"; kill?: HlKill; obj?: HlObjective };

/** Every candidate window for every player, best first. Deterministic. */
export function scoreHighlights(tape: HlTape, strict = true): Highlight[] {
  const by = new Map<string, Moment[]>();
  const add = (id: string, m: Moment): void => {
    let l = by.get(id);
    if (!l) by.set(id, (l = []));
    l.push(m);
  };
  for (const k of tape.kills) if (k.src && k.src !== k.dst) add(k.src, { t: k.t, kind: "kill", kill: k });
  for (const o of tape.objectives) add(o.by, { t: o.t, kind: o.kind, obj: o });
  const lastKill = tape.kills.filter((k) => k.src !== k.dst).at(-1);
  const out: Highlight[] = [];
  for (const [id, moments] of by) {
    moments.sort((a, b) => a.t - b.t);
    let chain: Moment[] = [];
    const flush = (): void => {
      if (chain.length) for (const h of windowsOf(id, chain, tape, lastKill, strict)) out.push(h);
      chain = [];
    };
    for (const m of moments) {
      if (chain.length && m.t - chain[chain.length - 1]!.t > CHAIN_GAP_S) flush();
      chain.push(m);
    }
    flush();
  }
  out.sort((a, b) => b.score - a.score || b.t1 - a.t1 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** A chain longer than the window budget is cut to its best sub-window. */
function windowsOf(id: string, chain: Moment[], tape: HlTape, lastKill: HlKill | undefined, strict = true): Highlight[] {
  const budget = MAX_WINDOW_S - TAIL_S - LEAD_S;
  let best: Highlight | null = null;
  for (let i = 0; i < chain.length; i++) {
    for (let j = i; j < chain.length; j++) {
      if (chain[j]!.t - chain[i]!.t > budget) break;
      const h = scoreWindow(id, chain.slice(i, j + 1), tape, lastKill);
      // HARD: every kill of this player the replay will show must READ (on screen, big enough)
      if (strict && tape.kills.some((k) => k.src === id && k.dst !== id && k.seen === false && k.t >= h.t0 - 1e-6 && k.t <= h.t1 + 1e-6)) continue;
      if (!best || h.score > best.score) best = h;
    }
  }
  return best ? [best] : [];
}

function scoreWindow(id: string, ms: Moment[], tape: HlTape, lastKill: HlKill | undefined): Highlight {
  const kills = ms.filter((m) => m.kill).map((m) => m.kill!);
  const objs = ms.filter((m) => m.obj).map((m) => m.obj!);
  const tags: string[] = [];
  let score = 0;
  let heads = 0;
  let longest = 0;
  let walls = 0;
  let unseen = 0;
  for (const k of kills) {
    let v = 100;
    if (k.head) {
      v += 30;
      heads++;
    }
    if (k.wall) {
      v += 60;
      walls++;
    }
    const gun = k.weapon !== "nade" && k.weapon !== "knife";
    if (gun && k.dist > LONGSHOT_M) v += Math.min(150, (k.dist - LONGSHOT_M) * 5);
    if (gun) longest = Math.max(longest, k.dist);
    if (gun && k.seen !== false && k.dist <= LONGSHOT_M) v *= k.dist < 12 ? 1.25 : k.dist > 20 ? 0.6 : 1;
    if (k.seen === false) {
      // the replay cannot show it: a kill nobody sees is not part of the play
      v *= 0.25;
      unseen++;
    }
    score += v;
  }
  if (unseen) tags.push(`unseen${unseen}`);
  // COLLATERALS: bodies off one trigger pull (decided on the sim tick by the recorder).
  const collats = kills.filter((k) => k.collateral).length;
  score += collats * 220;
  if (collats) tags.push("collateral");
  // MULTI-KILL: the longest run of SEEN kills each within MULTI_GAP_S of the last
  // (an off-screen kill disqualifies a multi-kill title, it is not merely a penalty).
  const shown = kills.filter((k) => k.seen !== false);
  let run = shown.length ? 1 : 0;
  let bestRun = run;
  let runStart = 0;
  let bestSpan = 0;
  for (let i = 1; i < shown.length; i++) {
    if (shown[i]!.t - shown[i - 1]!.t <= MULTI_GAP_S) run++;
    else {
      run = 1;
      runStart = i;
    }
    if (run > bestRun) {
      bestRun = run;
      bestSpan = shown[i]!.t - shown[runStart]!.t;
    }
  }
  // Deliberate, upstream 1:1: x0.25 prices the kill, -60 prices the broken window readability.
  if (unseen) score -= 60 * unseen;
  if (bestRun >= 2) {
    const tight = Math.max(0.7, Math.min(1.25, 1.25 - bestSpan / 16));
    score += MULTI_BONUS[Math.min(bestRun, MULTI_BONUS.length - 1)]! * tight;
    tags.push(`multi${bestRun}`);
  }
  // CLUTCH (round modes): kills made as the team's last one alive, round won.
  let clutchN = 0;
  if (!tape.ffa) {
    for (const k of kills) {
      if (k.srcAlive !== 1 || k.dstAliveBefore < 1) continue;
      const won = tape.rounds.find((r) => r.round === k.round && r.t >= k.t - 0.01);
      if (!won || won.winner !== k.srcTeam) continue;
      const alone = kills.filter((x) => x.round === k.round && x.srcAlive === 1);
      clutchN = Math.max(clutchN, alone[0]?.dstAliveBefore ?? 0, k.dstAliveBefore);
    }
    if (clutchN >= 2) {
      score += 150 + 250 * (clutchN - 1);
      tags.push(`clutch1v${clutchN}`);
    }
    for (const k of kills) {
      if (k.dstAliveBefore === 1 && tape.rounds.some((r) => r.round === k.round && r.winner === k.srcTeam && r.t >= k.t - 0.01)) {
        score += 80;
        tags.push("roundwin");
        break;
      }
    }
  }
  // OBJECTIVES.
  for (const o of objs) {
    if (o.kind === "plant") {
      score += o.underFire ? 260 : 90;
      tags.push(o.underFire ? "plantfire" : "plant");
    } else if (o.kind === "defuse") {
      score += o.underFire ? 320 : 120;
      if (o.enemiesAlive >= 2) score += 150;
      tags.push(o.underFire ? "defusefire" : "defuse");
    } else {
      score += 110;
      const near = kills.filter((k) => Math.abs(k.t - o.t) <= 8).length;
      score += near * 170;
      tags.push(near ? "capturekills" : "capture");
    }
  }
  if (lastKill && kills.includes(lastKill)) {
    score += 70;
    tags.push("final");
  }
  // THE WINDOW: lead ≤ LEAD_S, no padding.
  const first = ms[0]!.t;
  const last = ms[ms.length - 1]!.t;
  let t0 = first - LEAD_S;
  const t1 = Math.min(tape.endAt > 0 ? tape.endAt : Infinity, last + TAIL_S);
  const spawns = tape.spawns.get(id) ?? [];
  let life = -Infinity;
  for (const s of spawns) if (s <= first + 1e-6) life = Math.max(life, s);
  t0 = Math.max(t0, tape.liveAt, life + 0.25);
  if (t1 - t0 > MAX_WINDOW_S) t0 = t1 - MAX_WINDOW_S;
  if (!(t0 < first)) t0 = Math.max(0, first - 0.5); // never an inverted window
  // LOOKING AT NOTHING inside the window.
  let blind = 0;
  for (const [a, b] of tape.badAim?.get(id) ?? []) blind += Math.max(0, Math.min(b, t1) - Math.max(a, t0));
  if (blind > 0.25) {
    score -= 120 * blind;
    tags.push("blind");
  }
  // Title + line.
  const span = kills.length > 1 ? kills[kills.length - 1]!.t - kills[0]!.t : 0;
  let title = kills.length === 1 ? "ELIMINATION" : `${kills.length} ELIMINATIONS`;
  if (longest > LONGSHOT_M && kills.length <= 1) title = "LONGSHOT";
  if (bestRun >= 2) title = MULTI_TITLE[Math.min(bestRun, MULTI_TITLE.length - 1)]!;
  if (collats && kills.length >= 2 && collats + 1 >= kills.length) title = `${MULTI_TITLE[Math.min(kills.length, MULTI_TITLE.length - 1)]} · ONE SHOT`;
  const cap = objs.find((o) => o.kind === "capture");
  if (cap) title = kills.length ? `FLAG ${cap.site} TAKEN` : `CAPTURED ${cap.site}`;
  const plant = objs.find((o) => o.kind === "plant");
  if (plant) title = plant.underFire ? "PLANTED UNDER FIRE" : `PLANTED AT ${plant.site}`;
  const defuse = objs.find((o) => o.kind === "defuse");
  if (defuse) title = defuse.underFire ? "DEFUSED UNDER FIRE" : defuse.enemiesAlive >= 2 ? "NINJA DEFUSE" : "BOMB DEFUSED";
  if (clutchN >= 2) title = `1v${clutchN} CLUTCH`;
  const bits: string[] = [];
  if (kills.length === 1) bits.push("1 kill");
  else if (kills.length > 1) {
    if (collats && collats + 1 >= kills.length) bits.push(`${kills.length} kills with one round`);
    else if (span < 0.5) bits.push(`${kills.length} kills in a split second`);
    else bits.push(`${kills.length} kills in ${span.toFixed(1)} s`);
  }
  if (heads) bits.push(heads === 1 ? "headshot" : `${heads} headshots`);
  if (collats && !(collats + 1 >= kills.length)) bits.push(collats === 1 ? "collateral" : `${collats} collaterals`);
  if (longest > LONGSHOT_M) bits.push(`${Math.round(longest)} m longshot`);
  if (walls) bits.push(walls === 1 ? "wallbang" : `${walls} wallbangs`);
  if (plant) bits.push(`planted ${plant.site}${plant.underFire ? " under fire" : ""}`);
  if (defuse) bits.push(`defused ${defuse.site}${defuse.underFire ? " under fire" : ""}`);
  if (cap) bits.push(`captured ${cap.site}`);
  if (tags.includes("final")) bits.push("match-winning kill");
  return {
    id,
    name: tape.names.get(id) ?? id,
    team: tape.teams.get(id) ?? 0,
    t0: round3(t0),
    t1: round3(t1),
    keys: ms.map((m) => round3(m.t)),
    score: Math.round(score),
    title,
    line: bits.join(" · ").toUpperCase(),
    tags,
  };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- recorder

export type SessionPlayer = {
  id: string;
  name: string;
  team: number;
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  alive: boolean;
  bench?: boolean;
  sitOut?: boolean;
};

/** What the recorder reads off a GameSession (it satisfies this structurally). */
export type SessionLike = {
  time: number;
  mode: string;
  round: number;
  roundBased: boolean;
  phase?: string;
  players: Map<string, SessionPlayer>;
};

/** Line of sight between two points (eye to body), true = nothing in between. */
export type LosFn = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;

/**
 * Feeds on drained sim events, timestamped with the session clock at drain
 * (at most one publish interval, ~31 ms, after the tick that made them).
 * Bounded: a 10-minute match is a few hundred kills.
 */
export class HighlightRecorder {
  kills: HlKill[] = [];
  objectives: HlObjective[] = [];
  rounds: HlRound[] = [];
  spawns = new Map<string, number[]>();
  names = new Map<string, string>();
  teams = new Map<string, number>();
  badAim = new Map<string, [number, number][]>();
  liveAt = 0;
  endAt = 0;
  ffa = false;
  /** Last damage taken per player (for "under fire"). */
  private hitsOn = new Map<string, number>();
  private wallHit = new Map<string, boolean>();
  private batch = 0;
  private lastKillOf = new Map<string, { batch: number; weapon: string }>();
  private lastT = -1;

  constructor(private los: LosFn | null = null) {}

  reset(t = 0): void {
    this.kills = [];
    this.objectives = [];
    this.rounds = [];
    this.spawns.clear();
    this.hitsOn.clear();
    this.wallHit.clear();
    this.badAim.clear();
    this.lastKillOf.clear();
    this.liveAt = t;
    this.endAt = 0;
  }

  private sight(a: SessionPlayer, b: SessionPlayer): boolean {
    return !this.los || this.los(a.x, a.y + 1.55, a.z, b.x, b.y + 1.15, b.z);
  }

  /** `phase`: the room's phase when it is not the session's own (a lobby countdown on the server). */
  observe(s: SessionLike, events: readonly NetEvent[], phase: string = s.phase ?? "live"): void {
    const t = s.time;
    const dt = this.lastT >= 0 ? Math.max(0, Math.min(0.1, t - this.lastT)) : 0;
    this.lastT = t;
    this.batch++;
    // the MATCH's start line (a round-based room's later round countdowns are not it)
    if (phase !== "live" && s.round <= 1 && !this.kills.length) this.liveAt = t;
    this.ffa = s.mode === "ffa";
    for (const p of s.players.values()) {
      this.names.set(p.id, p.name);
      this.teams.set(p.id, p.team);
      // LOOKING AT NOTHING: aim pinned at the sky or the floor, merged into spans.
      if (dt > 0 && p.alive && p.pitch !== undefined && (p.pitch < -BAD_PITCH_UP || p.pitch > BAD_PITCH_DOWN)) {
        let l = this.badAim.get(p.id);
        if (!l) this.badAim.set(p.id, (l = []));
        const lastSpan = l[l.length - 1];
        if (lastSpan && t - lastSpan[1] <= dt + 0.02) lastSpan[1] = t;
        else l.push([t - dt, t]);
        if (l.length > 300) l.splice(0, l.length - 300);
      }
    }
    // Alive counts AFTER this batch; walked backwards through the batch's kills
    // to reconstruct the count before each one.
    const alive: [number, number] = [0, 0];
    for (const p of s.players.values()) if (p.alive && !p.bench && !p.sitOut) alive[p.team as 0 | 1] += 1;
    const batchDeaths: [number, number] = [0, 0];
    for (const e of events) {
      if (e.t === "kill") {
        const d = s.players.get(e.dst);
        if (d) batchDeaths[d.team as 0 | 1] += 1;
      }
    }
    const seenDeaths: [number, number] = [0, 0];
    for (const e of events) {
      if (e.t === "match" && e.state === "live") {
        this.reset(t);
      } else if (e.t === "match" && e.state === "end") {
        this.endAt = t;
      } else if (e.t === "spawn") {
        let l = this.spawns.get(e.id);
        if (!l) this.spawns.set(e.id, (l = []));
        l.push(t);
        if (l.length > 400) l.splice(0, l.length - 400);
      } else if (e.t === "hit") {
        if (e.src !== e.dst) this.hitsOn.set(e.dst, t);
        if (e.kill) this.wallHit.set(e.dst, !!e.wall);
      } else if (e.t === "kill") {
        const src = s.players.get(e.src);
        const dst = s.players.get(e.dst);
        if (dst) seenDeaths[dst.team as 0 | 1] += 1;
        if (!src || !dst || e.src === e.dst) continue;
        const dTeam = dst.team as 0 | 1;
        const sTeam = src.team as 0 | 1;
        const dx = dst.x - src.x;
        const dy = dst.y + 1.1 - (src.y + 1.55);
        const dz = dst.z - src.z;
        const dist = Math.hypot(dx, dy, dz);
        // ON SCREEN: inside the killer's view cone, with a clear line.
        let seen = true;
        if (src.yaw !== undefined && dist > 0.5 && e.weapon !== "nade") {
          const fx = Math.sin(src.yaw) * Math.cos(src.pitch ?? 0);
          const fy = -Math.sin(src.pitch ?? 0); // sim pitch is positive DOWN (shared/sim.ts fireDir)
          const fz = Math.cos(src.yaw) * Math.cos(src.pitch ?? 0);
          const cos = (fx * dx + fy * dy + fz * dz) / dist;
          // a point-blank scrum (< 2.2 m) is bodies in the lens, not a readable kill
          // BIG ENOUGH TO READ: ≥ MIN_FRAME_FRAC of the frame tall at the killer's FOV (ADS narrows it)
          const w = WEAPON_BY_ID[e.weapon];
          const fov = (src as { ads?: number }).ads !== undefined && ((src as { ads?: number }).ads ?? 0) > 0.5 && w ? w.adsFov : HIP_VFOV;
          seen = cos > Math.cos(VIEW_CONE) && frameFrac(dist, fov) >= MIN_FRAME_FRAC && dist > 2.2 && this.sight(src, dst);
        } else if (e.weapon === "nade") seen = this.sight(src, dst);
        // COLLATERAL: one trigger pull = one sim tick. The sim says so itself
        // (medal "COLLATERAL"); a streak medal can mask that, so a second kill
        // by the same gun in the same drained batch (≤ 2 ticks, shorter than
        // any gun's fire interval) counts too. Frags never do.
        const prev = this.lastKillOf.get(e.src);
        const sameTick = !!prev && prev.batch === this.batch && prev.weapon === e.weapon;
        const collateral = e.weapon !== "nade" && e.weapon !== "knife" && (e.medal === "COLLATERAL" || sameTick);
        this.lastKillOf.set(e.src, { batch: this.batch, weapon: e.weapon });
        this.kills.push({
          t,
          src: e.src,
          dst: e.dst,
          srcTeam: sTeam,
          weapon: e.weapon,
          head: e.head,
          dist,
          wall: this.wallHit.get(e.dst) ?? false,
          srcAlive: s.roundBased ? alive[sTeam] + batchDeaths[sTeam] - seenDeaths[sTeam] : 0,
          dstAliveBefore: s.roundBased ? alive[dTeam] + (batchDeaths[dTeam] - seenDeaths[dTeam]) + 1 : 0,
          round: s.round,
          seen,
          collateral,
        });
        this.wallHit.delete(e.dst);
      } else if (e.t === "plant" || e.t === "defuse") {
        // UNDER FIRE means it: damage taken in the last UNDER_FIRE_S, or an
        // enemy close enough with a clear line to the planter.
        const hitT = this.hitsOn.get(e.by) ?? -1e9;
        const me = s.players.get(e.by);
        let enemiesAlive = 0;
        let watched = false;
        for (const p of s.players.values()) {
          if (p.team === e.team || !p.alive || p.bench || p.sitOut) continue;
          enemiesAlive++;
          if (me && Math.hypot(p.x - e.x, p.z - e.z) < UNDER_FIRE_LOS_M && this.sight(p, me)) watched = true;
        }
        this.objectives.push({ t, kind: e.t, by: e.by, team: e.team, site: e.site, underFire: t - hitT <= UNDER_FIRE_S || watched, enemiesAlive, x: e.x, z: e.z });
      } else if (e.t === "capture") {
        this.objectives.push({ t, kind: "capture", by: e.by, team: e.team, site: e.flag, underFire: false, enemiesAlive: 0, x: e.x, z: e.z });
      } else if (e.t === "round" && e.state === "end") {
        this.rounds.push({ round: e.round, t, winner: e.winner });
      }
    }
  }

  tape(): HlTape {
    return {
      kills: this.kills,
      objectives: this.objectives,
      rounds: this.rounds,
      spawns: this.spawns,
      names: this.names,
      teams: this.teams,
      liveAt: this.liveAt,
      endAt: this.endAt,
      ffa: this.ffa,
      badAim: this.badAim,
    };
  }

  /**
   * The play of the game. EVERY MATCH WITH A KILL HAS ONE (Overwatch's rule): the best readable window,
   * else (no kill of the match read on screen) the best window at all. null only for a match without a
   * kill — the client shows the MATCH MVP card then. POTG_MIN_SCORE no longer gates the replay; it is
   * what separates a "real" play (multi-kill, clutch, objective) from a plain one (tag "plain").
   */
  pick(): Highlight | null {
    if (!this.kills.some((k) => k.src && k.src !== k.dst) && !this.objectives.length) return null;
    const best = scoreHighlights(this.tape())[0] ?? scoreHighlights(this.tape(), false)[0] ?? null;
    if (best && best.score < POTG_MIN_SCORE && !best.tags.includes("plain")) best.tags.push("plain");
    return best;
  }
}

/** The recorder's line-of-sight question, answered with the bullets' own colliders. */
export function losFromTrace(trace: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) => { t: number }): LosFn {
  return (ax, ay, az, bx, by, bz) => {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return true;
    return trace(ax, ay, az, dx / L, dy / L, dz / L, L).t >= L - 0.1;
  };
}
