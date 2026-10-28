/**
 * client/src/menu-music.ts — PER-MAP MENU / LOBBY BACKGROUND MUSIC.
 * ===========================================================================
 * One passive 60 s loop per map (static/assets/audio/music/menu-<map>.ogg,
 * mp3 fallback), switched with a clean crossfade when the picked map changes
 * — on the main-menu cards AND in the private lobby (host's map picker).
 *
 * TWO <audio> ELEMENTS, one always the audible one. select() parks the new
 * track on the idle element and ramps idle 0 -> level while ramping the old
 * 1 -> 0 over FADE_MS, then pauses the old. Loops are seamless (`loop`),
 * so a finished fade never restarts a track mid-bar.
 *
 * VOLUME DRIVER. Every ramp reads the LIVE level (`effLevel()`) each frame
 * instead of closing over a stale `want`, and every completed fade re-runs
 * menuMusicSync(): a slider drag that fires ten syncs in 250 ms can never
 * strand the bed at an intermediate level, and a state flip mid-fade (mute,
 * match start) is honoured at completion instead of parking into silence.
 * One driver per element (chase map + crossfade generation counter), so a
 * retarget cancels — never duplicates — the in-flight ramp.
 *
 * PASSIVE BY CONSTRUCTION. Level is MASTER x MUSIC x BED (0.25): even at full
 * sliders the bed sits clearly under gunfire and the announcer, and MUSIC 0
 * parks both elements. Nothing here creates an AudioContext, so there is no
 * autoplay fight — playback only starts after a real user gesture
 * (audio-unlock.ts) and only while a menu-like screen is up (#menu,
 * #nana-lobby, or the callsign/full gates, with the match HUD down). Match
 * start parks it; coming back to the menu resumes the current map's track.
 */

import { ASSET_BASE, assetUrl } from "./asset-base";
import { hasUserGesture, onFirstGesture } from "./audio-unlock";
import { DEFAULT_MAP_ID, isMapId } from "@shared/maps";
import { onPrefs, prefs } from "./ui/prefs";

/** Crossfade length for a map switch — long enough to feel like a mix, short
 *  enough that rapid card-hopping never stacks inaudible stragglers. */
const FADE_MS = 1500;
/** Fast settle for park/shutdown (no musical crossfade needed). */
const PARK_MS = 300;
/** Bed scaling on top of MASTER x MUSIC: the music is furniture, not a headliner.
 *  Halved once after playtesting (0.5 was still too hot at MUSIC 35). */
const BED = 0.25;
/** Below this effective level both elements stay parked (slider at ~0). */
const AUDIBLE_MIN = 0.005;
/** Bounded play() retries after a rejection (cold cache): then silence until
 *  the next state change, never a retry loop. */
const MAX_PLAY_RETRIES = 5;
const PLAY_RETRY_MS = 1200;

const TRACK_DIR = `${ASSET_BASE}assets/audio/music`;

const trackUrls = (map: string): string[] =>
  [`${TRACK_DIR}/menu-${map}.ogg`, `${TRACK_DIR}/menu-${map}.mp3`].map(assetUrl);

/** Mute-aware level: MASTER x MUSIC x BED, forced to 0 while the topbar toggle mutes. */
const effLevel = (): number => (prefs().musicMuted ? 0 : prefs().master * prefs().music * BED);

function visible(el: HTMLElement | null): boolean {
  return !!el && !el.classList.contains("hidden");
}

/**
 * Audible only over menu-like screens: main menu, private lobby, or the
 * callsign/full gates in between — and never over a live match (HUD up).
 */
function wantAudible(): boolean {
  if (typeof document === "undefined") return false;
  const menuUp = visible(document.getElementById("menu"));
  const lobbyUp = visible(document.getElementById("nana-lobby"));
  const gateUp = visible(document.getElementById("nana-gate")) || visible(document.getElementById("nana-full"));
  const hudUp = visible(document.getElementById("hud"));
  return (menuUp || lobbyUp || gateUp) && !hudUp;
}

let a: HTMLAudioElement | null = null;
let b: HTMLAudioElement | null = null;
/** The element currently (or most recently) audible — invariant: non-null after els(). */
let active: HTMLAudioElement | null = null;
/** Map id the bed is on / fading toward. */
let target = "";
/** Parked by stopMenuMusic (match live); resume on the way back. */
let parked = false;
let ready = false;
/** Bumped by every cancel: in-flight rAF drivers with a stale generation return early. */
let fadeGen = 0;
/** The map-crossfade driver (at most one). Plain level chases use chaseRaf. */
let crossRaf = 0;
/** Per-element level chases, so a slider retarget restarts — never duplicates — the ramp. */
const chaseRaf = new Map<HTMLAudioElement, number>();
/** Consecutive play() rejections; bounds cold-cache retries (reset on play/select). */
let playFailures = 0;

function els(): void {
  if (a && b) return;
  a = new Audio();
  b = new Audio();
  for (const el of [a, b]) {
    el.loop = true;
    el.preload = "auto";
    el.volume = 0;
    el.addEventListener("playing", () => {
      playFailures = 0;
    });
  }
  active = a;
}

function idle(): HTMLAudioElement {
  return active === a ? b! : a!;
}

function cancelChase(el: HTMLAudioElement): void {
  const id = chaseRaf.get(el);
  if (id !== undefined) {
    cancelAnimationFrame(id);
    chaseRaf.delete(el);
  }
}

/** Invalidate every in-flight driver (chasers check the generation each frame). */
function cancelAll(): void {
  fadeGen++;
  if (crossRaf) {
    cancelAnimationFrame(crossRaf);
    crossRaf = 0;
  }
  for (const [el, id] of chaseRaf) {
    cancelAnimationFrame(id);
    chaseRaf.delete(el);
  }
}

function park(el: HTMLAudioElement): void {
  cancelChase(el);
  try {
    el.pause();
  } catch {
    /* not playing — nothing to park */
  }
  el.volume = 0;
}

/**
 * ONE arming site (ogg with mp3 fallback for browsers without Opus).
 * No-op when the element already carries this map's primary source, so a
 * re-arm can never interrupt a playing track.
 */
function arm(el: HTMLAudioElement, map: string): void {
  const urls = trackUrls(map);
  if (el.dataset.map === map && el.getAttribute("src") === urls[0]) return;
  el.dataset.map = map;
  el.dataset.srcIdx = "0";
  el.onerror = () => {
    const i = Number(el.dataset.srcIdx || 0);
    if (i + 1 < urls.length) {
      el.dataset.srcIdx = String(i + 1);
      el.src = urls[i + 1]!;
    } else {
      el.onerror = null;
    }
  };
  el.src = urls[0]!;
}

function schedulePlayRetry(): void {
  if (playFailures >= MAX_PLAY_RETRIES) return;
  window.setTimeout(() => menuMusicSync(), PLAY_RETRY_MS);
}

function tryPlay(el: HTMLAudioElement): void {
  if (playFailures >= MAX_PLAY_RETRIES) return;
  let r: unknown;
  try {
    r = el.play();
  } catch {
    playFailures++;
    schedulePlayRetry();
    return;
  }
  const p = r as Promise<void> | undefined;
  if (p && typeof p.catch === "function") {
    p.then(
      () => {
        playFailures = 0;
      },
      () => {
        playFailures++;
        schedulePlayRetry();
      },
    );
  }
}

/**
 * Ramp one element toward the LIVE level. Retarget-safe: restarting a chase
 * starts from the current volume, and the target is re-read every frame, so
 * ten slider ticks in 250 ms converge on the last one — never on a stale want.
 * No completion re-sync: the end state equals the live level by construction,
 * and every pref change re-enters through menuMusicSync() anyway.
 */
function chase(el: HTMLAudioElement, ms: number, onDone?: () => void): void {
  cancelChase(el);
  const gen = fadeGen;
  const from = el.volume;
  const t0 = performance.now();
  const step = (): void => {
    if (gen !== fadeGen) return;
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.volume = from + (effLevel() - from) * k;
    if (k < 1) chaseRaf.set(el, requestAnimationFrame(step));
    else {
      chaseRaf.delete(el);
      onDone?.();
    }
  };
  chaseRaf.set(el, requestAnimationFrame(step));
}

/**
 * Re-evaluate everything: gesture seen + a menu-like screen up + level > 0
 * and not parked for a live match. Called after every state change and after
 * every completed fade (a flip mid-fade is honoured at completion).
 */
export function menuMusicSync(): void {
  if (!ready || typeof Audio === "undefined") return;
  els();
  const el = active!;
  const other = idle();
  const audible = hasUserGesture() && !parked && wantAudible() && effLevel() >= AUDIBLE_MIN && !!target;
  if (!audible) {
    // Settle fast and silent — a card click that launches a match must never
    // clip the bed, and a mute must never leave a tail.
    cancelAll();
    park(other);
    if (el.paused && el.volume <= 0.001) {
      park(el);
      return;
    }
    chase(el, PARK_MS, () => {
      park(el);
      menuMusicSync();
    });
    return;
  }
  // A crossfade in flight already tracks the live level and re-syncs on
  // completion — never fight it (and never re-arm `active`, which is its
  // fading `from` element, mid-fade).
  if (crossRaf) return;
  arm(el, target);
  if (el.paused) {
    el.volume = Math.min(el.volume, effLevel());
    tryPlay(el);
  } else if (playFailures >= MAX_PLAY_RETRIES) {
    return; // unplayable source: don't chase ghosts on a paused element
  }
  if (!chaseRaf.has(el) && Math.abs(el.volume - effLevel()) <= 0.002) return;
  chase(el, 250);
}

/**
 * Switch the bed to a map's track with a clean crossfade. No-op for the map
 * already targeted (so lobby repaints and repeat card clicks can never
 * restart an in-flight fade); unknown ids fall back to ares, never to
 * silence.
 */
export function selectMenuMusic(map: string): void {
  const want = isMapId(map) ? map : DEFAULT_MAP_ID;
  playFailures = 0;
  if (!ready || typeof Audio === "undefined") {
    target = want;
    return;
  }
  els();
  if (want === target && !crossRaf) {
    menuMusicSync();
    return;
  }
  target = want;
  const audibleNow = hasUserGesture() && !parked && wantAudible() && effLevel() >= AUDIBLE_MIN;
  if (!audibleNow) {
    // No fade needed — just arm the track for when audibility returns.
    cancelAll();
    park(idle());
    arm(active!, target);
    park(active!);
    return;
  }
  const from = active!;
  // Nothing audible to preserve: snap over and fade the new track in via sync.
  if (from.paused) {
    cancelAll();
    park(idle());
    park(from);
    active = idle();
    arm(active, target);
    menuMusicSync();
    return;
  }
  // Audible crossfade. Volumes are read BEFORE anything is touched (no snap),
  // the target level is re-read live each frame, and completion re-syncs.
  cancelAll();
  const to = idle();
  arm(to, target);
  to.volume = 0;
  const startFade = (): void => {
    const gen = fadeGen;
    const fromVol = from.volume;
    const t0 = performance.now();
    const step = (): void => {
      if (gen !== fadeGen) return;
      const k = Math.min(1, (performance.now() - t0) / FADE_MS);
      // Equal-power-ish: sqrt ramps keep the summed loudness flat mid-fade.
      to.volume = effLevel() * Math.sqrt(k);
      from.volume = fromVol * Math.sqrt(1 - k);
      if (k < 1) {
        crossRaf = requestAnimationFrame(step);
      } else {
        crossRaf = 0;
        active = to;
        park(from);
        menuMusicSync();
      }
    };
    crossRaf = requestAnimationFrame(step);
  };
  let r: unknown;
  try {
    r = to.play();
  } catch {
    playFailures++;
    schedulePlayRetry();
    return; // leave `from` playing — never park good audio for a failed start
  }
  const p = r as Promise<void> | undefined;
  if (p && typeof p.catch === "function") {
    p.then(
      () => {
        playFailures = 0;
        startFade();
      },
      () => {
        // Rejected (cold cache, no gesture after all): `from` keeps playing,
        // the bounded retry re-enters through sync.
        playFailures++;
        schedulePlayRetry();
      },
    );
  } else {
    startFade();
  }
}

/** Match going live: park the bed (faded, never cut). */
export function stopMenuMusic(): void {
  parked = true;
  menuMusicSync();
}

/** Back on a menu-like screen: resume the targeted track. */
export function startMenuMusic(map?: string): void {
  parked = false;
  if (map) selectMenuMusic(map);
  else menuMusicSync();
}

/** Arm the bed once; safe to call before any gesture (playback waits for one). */
export function initMenuMusic(initialMap: string): void {
  if (ready || typeof Audio === "undefined") return;
  ready = true;
  target = isMapId(initialMap) ? initialMap : DEFAULT_MAP_ID;
  els();
  arm(active!, target);
  onPrefs(() => menuMusicSync());
  onFirstGesture(() => menuMusicSync());
  menuMusicSync();
}
