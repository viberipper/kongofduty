/**
 * client/src/gpu-backend.ts — WEBGPU PRÜFUNG + RENDERER-ABSTRAKTION.
 * ============================================================================
 *
 * BEFUND (Okt 2026, three r170 vendored unter client/vendor/three):
 *  - client/vendor/three/examples/jsm enthält KEIN WebGPU-Modul: kein Ordner
 *    `webgpu/`, keine `WebGPURenderer.js`, kein `tsl/` (TSL-Node-System). Die
 *    r170-WebGPURenderer-Implementierung lebt upstream in
 *    examples/jsm/renderers/WebGPURenderer.js + examples/jsm/nodes/* — beides
 *    ist hier nicht vendored.
 *  - Die Post-Chain (EffectComposer/RenderPass/ShaderPass) ist die
 *    WebGL2-Implementierung; es gibt keinen WebGPU-Backend-Pfad, auf den sie
 *    umhängen könnte.
 *  - KONSEQUENZ: Aktiver Renderer ist WebGL2 (WebGLRenderer + EffectComposer).
 *    Das ist kein Rückschritt, sondern der einzig vollständige Pfad in diesem
 *    Build: Ein halb-verdrahtetes WebGPU (Renderer ohne Post-Chain, ohne
 *    Shadow-/Depth-Repair aus depth-precision.ts) würde den signierten Look
 *    und die ZERO-FLICKER-Garantien brechen.
 *
 * UPGRADE-PFAD (Architektur liegt bereit):
 *  1. three auf eine Version mit WebGPURenderer + TSL vendorn,
 *  2. hier in createRenderer() den WebGPU-Pfad verdrahten (async init, dann
 *     TSL-Post-Chain statt EffectComposer),
 *  3. Prefs-Renderer 'webgpu'/'auto' aktiviert ihn automatisch — das
 *     Settings-Menü, die Prefs und die Fallback-Logik existieren bereits.
 *
 * Bis dahin: 'auto' und 'webgpu' lösen auf WebGL2 auf (mit Console-Hinweis),
 * 'webgl' erzwingt WebGL2 kommentarlos. Alles baut und läuft ohne WebGPU.
 *
 * MINOR 2 (3. Review): Die Capability ist eine COMPILEZEIT-Konstante — der
 * Probe-Import feuert NICHT pro Boot (kein 404), sondern nur hinter
 * ?webgpu-probe=1. Doku der Einzelteile unten entsprechend angepasst.
 *
 * m4-Hinweis zur Detection: probeThreeWebGpu() nutzt einen @vite-ignore-
 * Runtime-Import mit einem Bare-Specifier ("three/addons/..."), den Vite
 * NICHT auf den Vendor-Alias auflöst. Bis examples/jsm/renderers/ vendored
 * ist, liefert die Prüfung daher IMMER not-found — das ist ehrlich so in den
 * reason-Strings dokumentiert, kein Bug. Nach dem Vendor-Upgrade muss der
 * Specifier (oder ein statischer Import) angepasst werden.
 */

export type GpuBackendPref = "auto" | "webgpu" | "webgl";
export type GpuBackendActive = "webgpu" | "webgl";

export interface GpuCapability {
  /** navigator.gpu existiert (WebGPU-API im Browser vorhanden). */
  webgpuApi: boolean;
  /** Der vendored three-Build liefert einen WebGPURenderer. */
  threeWebgpuRenderer: boolean;
  /** Der tatsächlich genutzte Renderer dieses Builds. */
  active: GpuBackendActive;
  /** Einzeiler für Console/QA. */
  reason: string;
}

let cached: GpuCapability | null = null;

/** Liegt eine WebGPU-API im Browser vor (sagt nichts über three-Support). */
export function hasWebGpuApi(): boolean {
  // NIT 4 (3. Review): typeof-Guard VOR jeder Dereferenzierung (Tests/SSR
  // ohne navigator-Umgebung); der getypte Cast (m5) bleibt für die
  // nicht-typisierte gpu-Property.
  try {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as unknown as { gpu?: unknown };
    return !!nav.gpu;
  } catch {
    return false;
  }
}

/**
 * Probiert, das (derzeit nicht vendored) WebGPURenderer-Modul zu laden.
 * Bleibt absichtlich dynamisch + @vite-ignore: Sobald die Datei vendored ist,
 * findet der Import sie, ohne dass weiterer Code angefasst werden muss — und
 * bis dahin löst der Build sie nicht statisch auf (das würde fehlschlagen).
 * m4: Liefert bis zum Vendor-Upgrade IMMER not-found (siehe Modul-Doc).
 * MINOR 2 (3. Review): Wird NICHT pro Boot aufgerufen (garantierter 404) —
 * nur hinter ?webgpu-probe=1 via resolveBackend(), fürs Vendor-Upgrade.
 */
export async function probeThreeWebGpu(): Promise<{ found: boolean; reason: string }> {
  try {
    const id = "three/addons/renderers/WebGPURenderer.js";
    await import(/* @vite-ignore */ id);
    return { found: true, reason: "WebGPURenderer vendored" };
  } catch {
    return {
      found: false,
      reason: "Detection liefert not-found, bis examples/jsm/renderers/WebGPURenderer.js vendored ist (r170: nicht enthalten) — WebGL2 bleibt aktiv",
    };
  }
}

/** Capability-Report, einmal pro Page-Load erstellt. */
export function gpuCapabilities(): GpuCapability {
  if (cached) return cached;
  const webgpuApi = hasWebGpuApi();
  // Synchroner Befund: Der Vendor-Ordner enthält keinen WebGPU-Renderer
  // (siehe Modul-Doc oben); der async probeThreeWebGpu() bestätigt das zur
  // Laufzeit, sobald jemand WebGPU erzwingen will.
  cached = {
    webgpuApi,
    threeWebgpuRenderer: false,
    active: "webgl",
    reason: webgpuApi
      ? "WebGPU-API vorhanden, aber three r170 vendored ohne WebGPURenderer — WebGL2 aktiv (Upgrade-Pfad siehe gpu-backend.ts)"
      : "keine WebGPU-API in diesem Browser — WebGL2 aktiv",
  };
  return cached;
}

/**
 * Löst die Renderer-Pref auf den tatsächlich genutzten Backend auf.
 * Gibt (noch) immer 'webgl' zurück, dokumentiert aber den Wunsch — sobald
 * probeThreeWebGpu() fündig wird, ist hier die einzige Stelle, die einen
 * WebGPU-Pfad zurückgeben muss.
 */
export async function resolveBackend(pref: GpuBackendPref): Promise<{ active: GpuBackendActive; note: string }> {
  const caps = gpuCapabilities();
  if (pref === "webgl") return { active: "webgl", note: "Renderer-Pref: WebGL2 (erzwungen)" };
  // Review-Runde 2: ohne WebGPU-API im Browser gar nicht erst den (immer
  // 404-)Probe-Import anwerfen — ein garantierter Netzwerk-Fehlschlag pro
  // Boot weniger.
  if (!caps.webgpuApi) {
    if (pref === "webgpu") console.warn("[gpu] Renderer-Pref 'webgpu', aber keine WebGPU-API in diesem Browser — WebGL2 fallback.");
    return { active: "webgl" as GpuBackendActive, note: caps.reason };
  }
  // MINOR 2 (3. Review): Die Capability ist eine COMPILEZEIT-Konstante (kein
  // WebGPURenderer vendored) — kein Probe-Import pro Boot, kein 404. Manuell
  // prüfbar hinter ?webgpu-probe=1 (fürs Vendor-Upgrade).
  let probe = { found: false, reason: "Probe gated hinter ?webgpu-probe=1 — bis zum Vendor-Upgrade liefert sie not-found (siehe Modul-Doc)" };
  try {
    if (new URLSearchParams(location.search).get("webgpu-probe") === "1") probe = await probeThreeWebGpu();
  } catch {
    /* no location */
  }
  if (probe.found) {
    // Noch nicht verdrahtet: Der Import existiert erst nach einem
    // three-Upgrade; createRenderer() müsste dann den TSL-Pfad aufbauen.
    console.warn("[gpu] WebGPURenderer gefunden, aber noch nicht verdrahtet — WebGL2 fallback (siehe gpu-backend.ts Upgrade-Pfad).");
  } else if (pref === "webgpu") {
    console.warn(`[gpu] Renderer-Pref 'webgpu' gewünscht, aber ${probe.reason}. Fallback auf WebGL2.`);
  }
  return { active: "webgl" as GpuBackendActive, note: caps.reason };
}

/** Kurzinfo fürs Settings-Menü / die Boot-Console. */
export function gpuBackendNote(): string {
  return gpuCapabilities().reason;
}
