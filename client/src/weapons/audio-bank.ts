/**
 * THE WEAPON SOUND BANK — every level, band, delay and keyframe the recorded
 * weapon set is played with. This file IS the weapon mix; audio-engine.ts only
 * executes it. Assets: static/assets/audio/weapons/ (scripts/encode-weapon-audio.mjs,
 * Kong Royale's recorded library + CC0 frag/knife foley).
 *
 * LEVEL CONVENTION. Every file plays at `g + dB` where `g` is its manifest level
 * correction (KR normDb: every variant of a group lands at one loudness), so a
 * dB below is relative to the GROUP's calibrated loudness, not to the file.
 * Each group's measured 100 ms transient loudness `p` (manifest) is what the
 * `match` layers use to be loudness-matched to another group (a far report is
 * exactly as loud as the near body at equal weight, so an equal-power band
 * crossfade never adds loudness — KR r3). The gun numbers are Kong Royale's
 * reviewed GUN / OWN / TAIL_1P / RELOAD tables (client/src/audio/bank.ts),
 * rebased from an island (bands at 15-480 m) to a 6v6 arena (bands at 8-80 m,
 * times the map's audioScale).
 *
 * ── MIX DESIGN (12 players firing at once must stay readable) ──────────────
 *   HIERARCHY (100 ms loudness through the master, measured by
 *   qa/weapon-audio-mix.mjs): hit confirms > YOUR gun > a near enemy gun >
 *   explosions at range > far guns > foley. Your gun is the loudest RECURRING
 *   sound and sits under the master glue threshold, so a single shot is never
 *   compressed; a confirm cuts through your own full-auto (it ducks your gun
 *   and enemy guns 6 dB for ~90 ms, KR duckConfirm).
 *   YOUR GUN: the stereo first-person take (lossless FLAC, the pressure spike
 *   intact, no pitch jitter — resampling flattens the spike), the action
 *   cycling 22-32 ms later, the near-field ring-out 50 ms later. 2D, full
 *   width. Each of your shots pulls enemy guns -3.5 dB x duck and the ambience
 *   -7 dB for ~70 ms so it cuts through.
 *   ENEMY GUNS: a mono body through ONE HRTF panner per shot (one panner config
 *   for every emitter in the game, see audio2.ts), level from a designed curve
 *   (-a dB per doubling to `knee`, -b beyond — a gun is a proximity cue up close
 *   and still CARRIES across the map); DISTANCE BANDS crossfade the near body
 *   into the gun's own far report and, on big maps, its distant report, while
 *   the rolling far tail rises against the report with range (the
 *   direct-to-tail ratio tells the range, never a level bump). Air absorption
 *   low-passes with distance, a wall between you muffles (-6 dB / 1.8 kHz).
 *   VOICE LIMITS: a remote gun keeps at most 3 shots ringing (its older shots
 *   are choked under the new transient), yours 5; the gun group holds 18
 *   shots. When it is full, the quietest/oldest voice that is not yours and
 *   not one of the 4 nearest shooters is stolen (20 ms fade); a newcomer that
 *   matters less than everything playing is dropped. Impacts 8, bounces 4,
 *   explosions 4, confirms 4, foley 10, whizzes 2, casings 4.
 *   MASTER: glue compressor (-3 dBFS, 2:1) + 1.33 ms look-ahead true-peak
 *   limiter at -1.5 dBTP with a dual release, then a soft clip (audio-master.ts).
 *   The user's volume is applied after it.
 */

export type GunId = "ar" | "smg" | "sniper" | "pistol";
export const GUN_IDS: readonly GunId[] = ["ar", "smg", "sniper", "pistol"];

/** Any weapon id the game sends -> the recorded gun that voices it (knife / unknown handled by callers). */
export function gunOf(id: string): GunId | null {
  if (id === "ar" || id === "smg" || id === "sniper" || id === "pistol") return id;
  // legacy ids (synth-era maps, old QA): rifles speak with the AR, the rest with their nearest class
  if (id === "m4a1" || id === "ak47" || id === "helios") return "ar";
  if (id === "mp5" || id === "mp7") return "smg";
  if (id === "m40a3") return "sniper";
  if (id === "m1911") return "pistol";
  return null;
}

/**
 * GLOBAL WEAPON TRIM (dB) — where the whole recorded weapon mix sits against the
 * rest of the game (footsteps, UI, ambience, medals, which are older and were
 * balanced against the synth guns). Calibrated by qa/weapon-audio-mix.mjs: your
 * AR's 100 ms loudness lands on the old synth AR's, so the footstep / UI
 * balance is unchanged while the gun gets its real transient (+5-7 dB of peak).
 */
export const WEAPON_TRIM_DB = 4;

/** Bus trims (dB) — the engine's own buses, all into the shared master stage. */
export const BUS_DB = { p1: -1, p3: 0, world: 0, ui: -1 } as const;

export interface GunMix {
  /** your shot: the whole event (every local layer keeps its level relative to it) */
  own: number;
  /** the 1P take's offset inside it */
  p1: number;
  /** the action cycling (bolt carrier / slide), and when (s after the shot) */
  mech: number;
  mechT: number;
  /** your near-field ring-out (YOUR tail sits lower than the one others hear: the range's reflections blurred the signature) */
  tail1p: number;
  /** someone else's shot at 5 m */
  hear: number;
  /** their near-field ring-out, rel. the body */
  tail: number;
  /** the mid-range report / the distant report / the rolling far tail, each loudness-matched to the body */
  far: number;
  dist: number;
  ftail: number;
  /** loudness vs distance: -a dB per doubling from 5 m to `knee` m, -b beyond (metres x map scale) */
  a: number;
  knee: number;
  b: number;
  /** near body -> far report crossfade (m x scale) */
  near: [number, number];
  /** own-fire ducking strength of enemy guns / ambience */
  duck: number;
  /** ± random pitch (semitones) on someone else's body */
  pitch: number;
  /** yard reverb send (dB) of someone else's shot */
  send: number;
  /** a wall between you: dB lost and the low-pass (Hz) */
  occlDb: number;
  occlHz: number;
  /** the spent case lands (s after the shot), when no FX stream drives casings */
  caseT: number;
}

// KR GUN table (own/tail/far/dist/ftail/duck/pitch/send) with three arena changes: the mech is raised (KR -32..-40 dB is
// inaudible under the blast at island ranges; here the action is part of the gun's identity between shots), someone
// else's shot sits 4-5 dB lower (`hear`: YOUR gun stays on top — at 5 m an enemy AR is level with yours, beyond it is
// under it) and the curve / bands moved in from island to arena ranges.
export const GUN_MIX: Record<GunId, GunMix> = {
    pistol: { own: -8.5, p1: 2.5, mech: -24, mechT: 0.024, tail1p: -15.8, hear: -11.9, tail: -12.8, far: 0, dist: -2, ftail: -14, a: 5.0, knee: 22, b: 4.0, near: [8, 28], duck: 0.6, pitch: 0.35, send: -30, occlDb: 6, occlHz: 1800, caseT: 0.2 },
  smg: { own: -7.0, p1: 2.5, mech: -25, mechT: 0.022, tail1p: -18.7, hear: -10.3, tail: -13.7, far: 0, dist: -2, ftail: -14, a: 4.5, knee: 25, b: 3.6, near: [8, 30], duck: 0.55, pitch: 0.4, send: -26, occlDb: 6, occlHz: 1800, caseT: 0.3 },
  ar: { own: -6.1, p1: 2.5, mech: -25, mechT: 0.032, tail1p: -13.1, hear: -10.5, tail: -8.1, far: 0, dist: -2, ftail: -14, a: 4.2, knee: 28, b: 3.2, near: [9, 32], duck: 0.8, pitch: 0.3, send: -20, occlDb: 6, occlHz: 1800, caseT: 0.46 },
  // THE SNIPER is the loudest gun at every range and carries furthest; a wall shades its crack, it does not swallow it
  sniper: { own: -9.0, p1: 2.5, mech: -30, mechT: 0.03, tail1p: -7.0, hear: -12.5, tail: -1.1, far: 1.5, dist: 2.5, ftail: -14, a: 3.0, knee: 30, b: 3.0, near: [14, 45], duck: 1.0, pitch: 0.25, send: -21, occlDb: 3, occlHz: 4500, caseT: 0 },
};

/** far report -> distant report (m x scale) — only the big maps ever reach it */
export const FAR_BAND: [number, number] = [36, 80];
/** the near-field ring-out thins out over (m x scale) */
export const TAIL_BAND: [number, number] = [10, 40];
/** the rolling far tail: fades in over [0,1], then rises `[2]` dB per doubling from `[3]` m (x scale), capped +9 dB */
export const FTAIL_BAND: [number, number, number, number] = [14, 45, 5, 16];
/** air absorption: low-pass at 20 kHz · e^(−d / (AIR_M · scale)), never under 2.2 kHz */
export const AIR_M = 95;
/** reference distance of every designed curve (m, NOT scaled: how loud a thing is when it is CLOSE) */
export const REF_M = 5;

/**
 * THE SNIPER'S BOLT CYCLE after every shot (s after the shot; the rifle fires every 1.25 s): handle up (lugs unlock),
 * bolt back (case out), bolt forward (a round stripped into the chamber), handle down (lock-up). KR's SNIPER_BOLT
 * (keyed for a 1.43 s cycle) scaled to the SR-7's 48 rpm. The viewmodel's bolt animation can key on these.
 */
export const SNIPER_BOLT: { part: "up" | "back" | "fwd" | "down"; t: number; db: number }[] = [
  { part: "up", t: 0.4, db: -15 },
  { part: "back", t: 0.49, db: -13 },
  { part: "fwd", t: 0.65, db: -13 },
  { part: "down", t: 0.75, db: -12 },
];

/** a reload keyframe: group, fraction `u` of the reload time it lands at, dB rel. the reload event */
export type ReloadKey = { g: string; u: number; db?: number };

/**
 * RELOAD CHOREOGRAPHY — fractions of the sim's reload time (shared/weapons.ts reload / emptyReload), inside the
 * viewmodel's down (0-0.16) / up (0.82-1) envelope. TACTICAL (rounds left): mag out, fresh mag from the pouch, mag
 * seated — nothing to charge. EMPTY: the dry mag drops to the floor ~70 ms after it is let go, and the action is
 * charged at the end (charging handle / slide release / the bolt worked twice on the sniper). Nothing sounds after
 * u = 0.9: a swap or death cancels whatever has not played yet.
 */
export const RELOAD_KEYS: Record<GunId, { tac: ReloadKey[]; empty: ReloadKey[] }> = {
  ar: {
    tac: [{ g: "ar/rl-out", u: 0.2 }, { g: "ar/rl-pouch", u: 0.38, db: -11 }, { g: "ar/rl-in", u: 0.62 }],
    empty: [{ g: "ar/rl-out", u: 0.16 }, { g: "ar/rl-drop", u: 0.24, db: -9 }, { g: "ar/rl-pouch", u: 0.36, db: -11 }, { g: "ar/rl-in", u: 0.56 }, { g: "ar/rl-rack", u: 0.8, db: -3 }],
  },
  smg: {
    tac: [{ g: "smg/rl-out", u: 0.22 }, { g: "smg/rl-pouch", u: 0.4, db: -11 }, { g: "smg/rl-in", u: 0.64 }],
    empty: [{ g: "smg/rl-out", u: 0.16 }, { g: "smg/rl-drop", u: 0.25, db: -9 }, { g: "smg/rl-pouch", u: 0.37, db: -11 }, { g: "smg/rl-in", u: 0.58 }, { g: "smg/rl-rack", u: 0.82, db: -4 }],
  },
  pistol: {
    tac: [{ g: "pistol/rl-out", u: 0.12 }, { g: "pistol/rl-pouch", u: 0.34, db: -11 }, { g: "pistol/rl-in", u: 0.62 }],
    empty: [{ g: "pistol/rl-out", u: 0.1 }, { g: "pistol/rl-drop", u: 0.2, db: -9 }, { g: "pistol/rl-pouch", u: 0.32, db: -11 }, { g: "pistol/rl-in", u: 0.56 }, { g: "pistol/rl-rack", u: 0.82 }],
  },
  sniper: {
    tac: [{ g: "sniper/rl-out", u: 0.18 }, { g: "sniper/rl-pouch", u: 0.36, db: -11 }, { g: "sniper/rl-in", u: 0.62 }],
    empty: [
      { g: "sniper/bolt-up", u: 0.08, db: -2 }, { g: "sniper/bolt-back", u: 0.14, db: -1 }, { g: "sniper/rl-out", u: 0.26 },
      { g: "sniper/rl-pouch", u: 0.4, db: -11 }, { g: "sniper/rl-in", u: 0.58 }, { g: "sniper/bolt-fwd", u: 0.76, db: -1 }, { g: "sniper/bolt-down", u: 0.84 },
    ],
  },
};
/** the reload event level (dB): close foley in your hands (KR reload dbLocal) */
export const RELOAD_DB = -17.5;

/**
 * RAISE (swap) per weapon: the shared handling take at the gun's own pitch, plus a light metal "seat" from the gun's own
 * foley at the top of the raise (fraction of WeaponDef.swap) — a pistol snaps up, a rifle settles, the sniper's bolt
 * handle knocks. dB rel. EQUIP_DB.
 */
export const EQUIP: Record<GunId | "knife", { rate: number; seat?: { g: string; u: number; db: number } }> = {
  ar: { rate: 1.0, seat: { g: "ar/rl-rack", u: 0.78, db: -5 } },
  smg: { rate: 1.07, seat: { g: "smg/rl-rack", u: 0.78, db: -6 } },
  sniper: { rate: 0.9, seat: { g: "sniper/bolt-down", u: 0.8, db: -3 } },
  pistol: { rate: 1.16, seat: { g: "pistol/rl-rack", u: 0.75, db: -4 } },
  knife: { rate: 1.25 },
};
export const EQUIP_DB = -16;

/** dry fire: the trigger on an empty chamber (KR: a click, not a shot), per gun rate */
export const DRY_DB = -22.5;
export const DRY_RATE: Record<GunId, number> = { ar: 1.0, smg: 1.08, sniper: 0.88, pistol: 1.14 };

/** casings: a subtle ring on the ground near you (KR: -26 dB under the gun's body; ~20 dB under your shot here) */
export const CASING_DB = -26;

/**
 * HIT CONFIRMS (2D, the UI bus: never ducked, never filtered). KR's CoD-dry confirms: your hit = the crisp 'tk' 35 ms
 * after the shot (past your gun's crack, where it cuts through full-auto) over a faint flesh slap 12 ms in; a headshot
 * its own sharper, heavier 'dink'; a kill the dry heavy thwack — the biggest reward of the fight.
 */
export const CONFIRM = {
  body: { db: -15, layers: [{ g: "hit/tick", db: 2.0, delay: 0.035, pitch: 0.4 }, { g: "hit/body", db: -8, delay: 0.012, pitch: 0.5 }] },
  head: { db: -11, layers: [{ g: "hit/head", db: -0.5, delay: 0.035, pitch: 0.25 }, { g: "hit/body", db: -9, delay: 0.012, pitch: 0.5 }] },
  kill: { db: -7, layers: [{ g: "hit/kill", db: 0, delay: 0.012, pitch: 0 }] },
};

/**
 * Everything else, as [dB at the reference distance, reference m, -dB per doubling to `knee` m, then beyond, max m].
 * Distances are x map scale except `ref`.
 */
export type Spot = { db: number; ref: number; a: number; knee: number; b: number; max: number };
export const SPOT = {
  /** a bullet into someone near you (flesh slap) */
  flesh: { db: -22, ref: 3, a: 6, knee: 12, b: 6, max: 40 },
  /** bullet impact on the world */
  impact: { db: -12, ref: 2, a: 6, knee: 10, b: 5, max: 36 },
  /** frag bouncing */
  bounce: { db: -10, ref: 2, a: 6, knee: 10, b: 5, max: 40 },
  /** someone's frag leaving their hand */
  throw: { db: -10, ref: 2, a: 6, knee: 8, b: 6, max: 24 },
  /** a spent case landing near you (someone else's) */
  casing: { db: -24, ref: 1.5, a: 6, knee: 6, b: 6, max: 12 },
  /** a knife swing near you */
  knife: { db: -12, ref: 2, a: 6, knee: 6, b: 6, max: 16 },
  /** someone ELSE reloading near you — the CoD "he's reloading, push" cue: clear inside a room, gone past ~18 m */
  reload: { db: -15, ref: 2, a: 6, knee: 8, b: 7, max: 18 },
  /** the frag explosion: louder and flatter up close, then rolls off (bands below) */
  boom: { db: -10, ref: 6, a: 3, knee: 20, b: 5, max: 400 },
} satisfies Record<string, Spot>;

/** bullet impacts per surface class (dB on top of SPOT.impact: the glass take is a thin tinkle, dirt a soft puff) */
export const IMPACT_DB: Record<string, number> = { "imp/glass": 6, "imp/sand": 1 };

/** local foley levels (dB rel. the group) */
export const FOLEY = {
  hurt: -14,
  pin: -13,
  tick: -15,
  throw: -20,
  knife: -14,
  empty: -22.5,
  whizz: -7,
};

/** explosion bands (m x scale): the close blast (crack + sub thump + debris) hands over to the rolling far boom */
export const BOOM_NEAR: [number, number] = [10, 34];
export const BOOM_FAR: [number, number] = [6, 22];
/** under this (m x scale) a blast shell-shocks you: your guns and theirs go dull for a beat */
export const SHOCK_M = 6;
