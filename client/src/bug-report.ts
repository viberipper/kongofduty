/**
 * client/src/bug-report.ts — F8: SNAPSHOT WHERE YOU ARE, FOR A BUG REPORT.
 * ===========================================================================
 *
 * One key press captures what a reproduction needs and nothing else: the map,
 * the mode, the build, where the camera stands and where it looks. The text is
 * copied to the clipboard (paste it straight into the report), logged to the
 * console and kept as the last few reports in localStorage
 * (`shipment.bugReports`) in case the clipboard was refused.
 *
 * THE BUILD. A production build serves `dist/release.json` (written by
 * scripts/precompress.mjs) next to the page; `vite dev` has none, so a dev
 * session reports "dev". Fetched once, from our own origin.
 */
import { ASSET_BASE } from "./asset-base";

export interface BugSnapshot {
  map: string;
  mode: string;
  room: string;
  online: boolean;
  /** Feet position, metres. */
  pos: [number, number, number] | null;
  /** Camera (eye) position, metres. */
  eye: [number, number, number];
  /** Look direction, radians. */
  yaw: number;
  pitch: number;
  alive: boolean;
  weapon: string;
}

const STORE_KEY = "shipment.bugReports";
const KEEP = 10;

let buildP: Promise<string> | null = null;

/** The running build's revision, or "dev" when the page has no release.json. */
export function buildId(): Promise<string> {
  buildP ??= fetch(`${ASSET_BASE}release.json`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { revision?: unknown; builtAt?: unknown } | null) => {
      const rev = typeof j?.revision === "string" ? j.revision : "";
      const at = typeof j?.builtAt === "string" ? j.builtAt : "";
      return rev ? (at ? `${rev} (${at})` : rev) : "dev";
    })
    .catch(() => "dev");
  return buildP;
}

const f3 = (v: [number, number, number]): string => v.map((n) => n.toFixed(3)).join(", ");
const deg = (r: number): string => `${((r * 180) / Math.PI).toFixed(2)}°`;

/** The page without anything a public paste must not carry: the query is
 * scrubbed down to the `map` param (?join=CODE would leak the lobby code). */
function scrubbedQuery(): string {
  const map = new URLSearchParams(location.search).get("map");
  return map ? `?map=${encodeURIComponent(map)}` : "";
}

export function formatReport(s: BugSnapshot, build: string, at = new Date()): string {
  return [
    "BANANA SHIPMENT BUG REPORT",
    `time   ${at.toISOString()}`,
    `build  ${build}`,
    `map    ${s.map} · ${s.mode}${s.online ? ` · online${s.room ? ` room ${s.room}` : ""}` : " · offline"}`,
    `feet   ${s.pos ? f3(s.pos) : "—"}`,
    `eye    ${f3(s.eye)}`,
    `aim    yaw ${s.yaw.toFixed(4)} rad (${deg(s.yaw)}) · pitch ${s.pitch.toFixed(4)} rad (${deg(s.pitch)})`,
    `state  ${s.alive ? "alive" : "dead"} · ${s.weapon || "—"}`,
    `page   ${location.pathname}${scrubbedQuery()}`,
  ].join("\n");
}

function remember(text: string): void {
  try {
    const prev = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    const list = Array.isArray(prev) ? prev.filter((x) => typeof x === "string") : [];
    list.unshift(text);
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, KEEP)));
  } catch {
    /* private window / storage blocked: the console copy still has it */
  }
}

/** Build, copy, log and keep one report. Resolves true when the clipboard took it. */
export async function captureBugReport(s: BugSnapshot): Promise<boolean> {
  const text = formatReport(s, await buildId());
  console.info(`[bug-report]\n${text}`);
  remember(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
