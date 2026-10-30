/**
 * client/src/ui/weapon-icons.ts — the kill feed's weapon glyphs (feel stream).
 *
 * Clean monochrome side-profile silhouettes, one per weapon CLASS (CoD draws the
 * gun, not its name): AR, SMG, SNIPER, PISTOL, FRAG, KNIFE, plus ARTILLERY and
 * the HEADSHOT mark. Inline SVG, `fill: currentColor`, so the feed colours them
 * and they stay crisp at any HUD size. Each is drawn facing right (muzzle →),
 * on a 22-unit-tall box so every icon sits on the same baseline.
 */
import { WEAPON_BY_ID } from "@shared/weapons";

type Icon = { w: number; d: string; rule?: "evenodd" | "nonzero" };

const ICONS: Record<string, Icon> = {
  // KR-4 class: fixed stock, flat-top receiver with an optic, curved mag, free-float handguard.
  AR: {
    w: 74,
    d: "M2 9.2 15 8v6.6L4.5 17.5 2 16.6Z M15 7h26v5.2H15Z M18 5.4h17V7H18Z M27.5 2.6h7v2.8h-7Z M41 7.6h17v4H41Z M58 8.5h11v1.9H58Z M68 7.9h4.4v3.1H68Z M17 12.2h4.6L19.3 19l-4.4-1.1Z M27 12.2h6.2l-2.3 8.3-5.6-1Z M44 11.6h3v2.2h-3Z",
  },
  // MX9 class: folding wire stock, compact receiver, straight stick mag, short barrel.
  SMG: {
    w: 60,
    d: "M2 8h11v1.6H3.8v3.6H13V15H2Z M13 6.4h24V12H13Z M16 4.8h12v1.6H16Z M37 7.6h9V10h-9Z M45 7.2h4v3.2h-4Z M15.5 12h4.4l-1.7 6.4-4-1Z M25.5 12h4.2v9h-4.2Z",
  },
  // SR-7 class: long stock with cheek rest, receiver, big scope, bolt, long barrel.
  SNIPER: {
    w: 84,
    d: "M2 9 20 7.6v6.6L6 16.8 2 15.8Z M7 7.2h9v1.4H7Z M20 7.6h21v4.6H20Z M22.5 3.4h15v3.2h-15Z M19.6 2.4h3.6v5.2h-3.6Z M37 2h4.6v5.6H37Z M25 6.6h1.6v1h-1.6Z M33 6.6h1.6v1H33Z M41 8.6h38V10.4H41Z M77.5 8h4.6v3h-4.6Z M21.5 12.2h4.2l-2 5.6-3.8-1.1Z M29.5 12.2h4v3.6h-4Z M36 12.2h1.6l1.6 2.6-1.4.8Z",
  },
  // P-9 class: slide, frame, raked grip, trigger guard.
  PISTOL: {
    w: 40,
    d: "M6 5h28v5.2H6Z M3 5.6h3v3.6H3Z M9 10.2h16v2.4H9Z M9.5 12.4h6.2L13.6 21l-6.6-1.5Z M16.4 12.6h1.6v3h4.6v-2.4h1.6v4H16.4Z",
  },
  // M67-style frag: body, fuse cap, spoon, pull ring.
  FRAG: {
    rule: "evenodd",
    w: 22,
    d: "M11 6.2c4.2 0 6.8 3.3 6.8 7.4S15.2 21 11 21s-6.8-3.3-6.8-7.4S6.8 6.2 11 6.2Z M8.4 2.6h5.2v3.8H8.4Z M13.6 3.2l4.6 2.6-1 1.6-4-2.2Z M4.6 2.4a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Zm0 1.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  },
  KNIFE: {
    w: 50,
    d: "M2 10.4c0-1.1.9-2 2-2h11v6H4c-1.1 0-2-.9-2-2Z M15 7h2.6v10H15Z M17.6 9.2H40c4.2 0 6.8 1.6 7.6 3.4H17.6Z",
  },
  // a mortar shell, nose right: tail fins, body, fuse
  ARTILLERY: {
    w: 40,
    d: "M2 6.4 9 9v4l-7 2.6Z M8 8.6h4v4.8H8Z M12 7.6h15c4.4 0 8.4 1.5 11 3.4-2.6 1.9-6.6 3.4-11 3.4H12Z",
  },
};

/** A small reticle-over-head mark, drawn after the gun on a headshot. */
const HEAD: Icon = {
  rule: "evenodd",
  w: 20,
  d: "M10 3.2a6.8 6.8 0 1 1 0 13.6 6.8 6.8 0 0 1 0-13.6Zm0 1.8a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z M9.2 0h1.6v5H9.2Z M9.2 15h1.6v5H9.2Z M3.2 9.2h5v1.6h-5Z M11.8 9.2h5v1.6h-5Z M10 8.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z",
};

/** The icon class for a kill-event weapon id. */
export function iconClass(weapon: string): keyof typeof ICONS {
  if (weapon === "nade") return "FRAG";
  if (weapon === "strike") return "ARTILLERY";
  if (weapon === "nuke") return "ARTILLERY";
  if (weapon === "knife" || weapon === "melee") return "KNIFE";
  const c = (WEAPON_BY_ID as Record<string, { class?: string } | undefined>)[weapon]?.class;
  if (c === "SMG") return "SMG";
  if (c === "SR") return "SNIPER";
  if (c === "PISTOL") return "PISTOL";
  if (c === "MELEE") return "KNIFE";
  return "AR";
}

function svg(i: Icon, cls: string, label: string): string {
  return `<svg class="${cls}" viewBox="0 0 ${i.w} 22" width="${i.w}" height="22" role="img" aria-label="${label}"><path fill="currentColor" fill-rule="${i.rule ?? "nonzero"}" d="${i.d}"/></svg>`;
}

/** The kill feed's middle: the weapon silhouette (+ the headshot mark). Safe HTML (no user text). */
export function killIconHtml(weapon: string, head: boolean): string {
  const k = iconClass(weapon);
  return svg(ICONS[k]!, `kf-ico kf-${k.toLowerCase()}`, k) + (head ? svg(HEAD, "kf-ico kf-headmark", "HEADSHOT") : "");
}

/** Raw path data, for the medal emblems that reuse the glyphs. */
export function iconPath(k: keyof typeof ICONS | "HEAD"): Icon {
  return k === "HEAD" ? HEAD : ICONS[k]!;
}
