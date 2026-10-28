/**
 * MAP IDS — the light-weight identity module.
 *
 * The map id list + the default map id, NOTHING else: no geometry, no
 * builders, no fetches, no `node:fs`, no top-level await. Importing this
 * module is side-effect-free and never delays the importer's evaluation.
 *
 * That is why server/src/index.ts takes DEFAULT_MAP_ID from HERE instead of
 * shared/maps (whose module body preloads JSON map data via top-level await
 * and builds geometry): the hub only needs the id for its redirect default,
 * and must not pay the preload cost — or inherit its crash behavior — before
 * its own CLI/ENV parsing runs.
 *
 * shared/maps/index.ts re-exports everything below, so `@shared/maps`
 * importers keep working unchanged.
 */

export const MAP_IDS = ["shipment", "dust2", "ares", "nuketown"] as const;

export type MapId = (typeof MAP_IDS)[number];

export const DEFAULT_MAP_ID: MapId = "ares";

export function isMapId(id: string | null | undefined): id is MapId {
  return !!id && (MAP_IDS as readonly string[]).includes(id);
}
