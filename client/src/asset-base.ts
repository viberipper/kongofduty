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
