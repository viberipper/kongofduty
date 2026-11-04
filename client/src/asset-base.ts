import * as THREE from "three";

/**
 * The deploy subpath, injected by Vite from `base` — always "/" now (page,
 * socket and assets share the origin root), so this is the identity and
 * `assetUrl()` below is a no-op for "/assets/..." literals.
 */
export const ASSET_BASE = import.meta.env.BASE_URL || "/";

/**
 * Runtime asset loads are written as absolute "/assets/..." literals in a dozen
 * places (bruiser.glb, launcher-bunch.glb, nade-frag.glb, ammo-bunch-tracer.glb,
 * the jungle textures, the sound packs). Vite rewrites the paths it can see at
 * build time, but not these — so under a subpath deploy every one of them 404s
 * and the game boots to a menu with no character, no gun and no audio.
 *
 * Rewriting centrally beats patching each call site: three's loaders all use the
 * default LoadingManager, so one URL modifier covers every model and texture,
 * and `assetUrl` covers the handful of raw fetches. (History: the game used
 * to deploy under a /kong/ subpath, where every absolute "/assets/..." 404d —
 * with base "/" the modifier stays off and assetUrl is the identity.)
 */
export function assetUrl(url: string): string {
  return url.startsWith("/assets/") ? ASSET_BASE + url.slice(1) : url;
}

if (ASSET_BASE !== "/") {
  THREE.DefaultLoadingManager.setURLModifier(assetUrl);
}

const SAFE_SEG = /^[A-Za-z0-9._-]+$/;

/**
 * Defense-in-depth (katana manifest key paths: v3 tex/library manifest,
 * prop-kit built/nature.json, art materials.json + lightmap files): a
 * manifest-driven relative asset path is only accepted when every `/`
 * segment is a plain filename — `..`, `.`, `\`, `:` and URL schemes are
 * rejected, so a tampered manifest cannot make the game fetch outside its
 * own asset directory.
 */
export function safeAssetPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.includes("\\") || p.includes(":") || p.startsWith("/")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return false; // scheme / protocol-relative
  const segs = p.split("/");
  if (!segs.length || segs.some((s) => !SAFE_SEG.test(s) || s === "." || s === "..")) return false;
  return true;
}

/**
 * Defense-in-depth (katana GLB external URIs): a LoadingManager whose URL
 * modifier keeps every load — including textures / buffers a GLB pulls in
 * by relative URI — on our own origin (plus `data:` / `blob:`, which cannot
 * leave the page). Anything else is warned about and sent to a sentinel
 * that fails the single load instead of leaking a request cross-origin.
 * Pass it to the GLTF / texture / HDRI loaders of the katana worlds.
 */
export function sameOriginManager(): THREE.LoadingManager {
  const m = new THREE.LoadingManager();
  m.setURLModifier((url) => {
    const mapped = assetUrl(url);
    try {
      const u = new URL(mapped, location.href);
      if (u.protocol === "data:" || u.protocol === "blob:") return mapped;
      if (u.origin === location.origin) return mapped;
    } catch {
      /* unparseable: fall through to the block below */
    }
    console.warn(`[assets] blocked cross-origin load: ${url}`);
    return "about:blank";
  });
  return m;
}
