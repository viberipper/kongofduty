/**
 * client/src/audio-unlock.ts — the one gate between the game and audible audio.
 *
 * Browsers refuse to start an AudioContext (and log "The AudioContext was not
 * allowed to start...") unless the page has seen a user gesture. Creating a
 * context or calling resume() speculatively — on a ?play deep link, on hover
 * (pointerover is NOT activation) — buys nothing but those warnings: the
 * context stays suspended anyway until a real press.
 *
 * So: nothing here creates or resumes. hasUserGesture() reports the
 * User Activation API (sticky hasBeenActive, live isActive) with a fallback
 * latch for browsers without it; onFirstGesture() runs a callback
 * synchronously INSIDE the next real gesture handler, which is the only
 * place resume()/construction is allowed.
 */

type UnlockCb = () => void;

/**
 * The real-press set: pointer + key + touch. pointerover/hover is deliberately
 * NOT here — hover is not user activation and must never unlock audio.
 * touchstart (not just touchend) is included for mobile latency: the press
 * counts at contact. Shared with AudioRig2.hookGesture so both gates listen
 * to the same presses.
 */
export const GESTURE_EVENTS = ["pointerdown", "pointerup", "keydown", "touchstart", "touchend", "click"] as const;

/** Fallback latch for browsers without navigator.userActivation. Set by a capture listener, so it is true before any bubble-phase handler runs. */
let fallbackSeen = false;
let fallbackInstalled = false;

function installFallback(): void {
  // SSR/Node QA harnesses have no window: nothing to latch onto.
  if (fallbackInstalled || typeof window === "undefined") return;
  fallbackInstalled = true;
  const mark = (): void => {
    fallbackSeen = true;
  };
  for (const ev of GESTURE_EVENTS) window.addEventListener(ev, mark, { capture: true, passive: true });
}

/** True once the page may audibly start audio: sticky activation, live activation, or the fallback latch. */
export function hasUserGesture(): boolean {
  try {
    // typeof guard: a bare `navigator` dereference throws ReferenceError under SSR/Node.
    if (typeof navigator !== "undefined") {
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean; isActive?: boolean } })?.userActivation;
      if (ua && (ua.hasBeenActive || ua.isActive)) return true;
    }
  } catch {
    /* navigator unavailable (SSR/tests) — fall through to the latch */
  }
  installFallback();
  return fallbackSeen;
}

/**
 * Run cb synchronously inside the next user-gesture handler (capture phase).
 * If a gesture already happened, cb runs immediately — resume() is allowed
 * then because activation is sticky. One-shot: listeners unhook after firing.
 */
export function onFirstGesture(cb: UnlockCb): void {
  installFallback();
  if (hasUserGesture()) {
    cb();
    return;
  }
  // No window (SSR/Node QA): there will never be a gesture — no-op instead of
  // throwing. If no gesture ever arrives in a browser, the hook below
  // intentionally stays parked for the page lifetime: a few passive capture
  // listeners waiting for the unlock press that may come minutes after deploy.
  if (typeof window === "undefined") return;
  const fire = (e: Event): void => {
    // Only a real, trusted press unlocks audio — a synthetic dispatchEvent()
    // must neither arm nor disarm the gate.
    if (!e.isTrusted) return;
    cleanup();
    cb();
  };
  const cleanup = (): void => {
    for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, fire, true);
  };
  for (const ev of GESTURE_EVENTS) window.addEventListener(ev, fire, { capture: true, passive: true });
}
