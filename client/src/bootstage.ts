/**
 * BOOT-STAGE BEACON. The loading screen hung twice in one day and both times
 * the only diagnosis available was reading nginx logs backwards to guess which
 * await never returned. This is the forward answer: every phase of the boot
 * pipeline stamps itself onto the loading card (and the console), so a stuck
 * screen SAYS where it stopped — on the player's machine, no server logs
 * needed.
 *
 * Kept dependency-free (DOM only) so both main.ts and game.ts can import it
 * without creating a cycle.
 */

let last = "";

/**
 * REAL PROGRESS, NOT A FAKE BAR. The loading screen's bar fills to the
 * furthest pipeline stage reached, in the order the pipeline actually runs
 * them (main.ts → audio2.ts → game.ts init → start). A stage this table does
 * not know (a new one, a software-GPU note) moves the text, never the bar.
 */
const STAGES = [
  "AUDIO",
  "AUDIO CONTEXT",
  "AUDIO PACK",
  "WORLD",
  "OPERATOR RIG",
  "VIEWMODEL",
  "EFFECTS",
  "RENDER PIPELINE",
  "PREPARING GRAPHICS",
  "UPLOADING TEXTURES",
  "WARMING WORLD",
  "WARMING PIPELINE",
  "READY",
  "JOINING MATCH",
  "FIRST FRAME",
];
let furthest = -1;

/** New load: the bar starts from empty. */
export function resetBootProgress(): void {
  furthest = -1;
  const fill = document.getElementById("boot-fill");
  if (fill) fill.style.width = "0%";
}

export function bootStage(label: string): void {
  last = label;
  console.info(`[boot] ${label}`);
  const el = document.getElementById("bootstage");
  if (el) {
    el.textContent = label;
    el.classList.remove("boot-stage-err");
  }
  const i = STAGES.findIndex((s) => label === s || label.startsWith(s + " "));
  if (i > furthest) {
    furthest = i;
    const fill = document.getElementById("boot-fill");
    if (fill) fill.style.width = `${Math.round(((i + 1) / STAGES.length) * 100)}%`;
  }
}

/** What the beacon last said — the error hooks below append to it. */
export function bootStageNow(): string {
  return last;
}

/**
 * SILENT FAILURES BECOME VISIBLE. An exception or unhandled rejection thrown
 * from a code path nobody awaits doesn't hit deploy()'s catch — it kills a
 * boot phase and leaves the card up forever with no evidence. Mirror both
 * onto the beacon in red, prefixed with the phase that was running, which is
 * exactly the pair of facts a bug report needs. Installed once, from main.ts.
 */
export function hookBootErrors(): void {
  const paint = (msg: string): void => {
    const el = document.getElementById("bootstage");
    if (!el) return;
    // Only shout while the boot card is actually up — after deploy, errors
    // belong to the console, not to a hidden div.
    const boot = document.getElementById("boot");
    if (!boot || boot.classList.contains("hidden")) return;
    el.textContent = `${last ? last + " — " : ""}ERROR: ${msg}`.slice(0, 300);
    el.classList.add("boot-stage-err");
  };
  window.addEventListener("error", (e) => paint(String(e.message ?? e.error ?? "unknown")));
  window.addEventListener("unhandledrejection", (e) => paint(String((e.reason as Error)?.message ?? e.reason ?? "unhandled rejection")));
}
