/**
 * client/src/sprays.ts — SPRAY PAINT (hive).
 * ===========================================================================
 *
 * Press the SPRAY key (T) facing a wall, crate or floor within SPRAY_REACH and
 * your tag goes up there — and everyone in the match sees it: the request goes
 * to the server (offline: straight into the local session), which checks the
 * range and a cooldown and broadcasts a `spray` event like any other. Each
 * player owns ONE spray at a time (a new one replaces it, CS-style) and the
 * walls are scrubbed at the next match.
 *
 * Four tags, picked in SETTINGS → GAMEPLAY: BANANA, KONG, GG, EZ. They are
 * painted on a canvas once each — stencil edges softened with overspray and a
 * few drips — and drawn as a small decal with polygon offset, placed on the
 * face of the collider the aim ray hit (its normal worked out from the OBB).
 */
import * as THREE from "three";
import { traceWorld, worldToLocal, type OBB } from "@shared/map";

export const SPRAY_REACH = 4;
export const SPRAY_NAMES = ["BANANA", "KONG", "GG", "EZ"] as const;
const SIZE = 1.15;
const MAX_SPRAYS = 24;

/** Where a spray from this eye along this aim lands, or null (nothing within reach). */
export function sprayHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null {
  const tr = traceWorld(ox, oy, oz, dx, dy, dz, SPRAY_REACH);
  if (tr.t >= SPRAY_REACH - 1e-3) return null;
  const x = ox + dx * tr.t, y = oy + dy * tr.t, z = oz + dz * tr.t;
  const n = tr.hit ? faceNormal(tr.hit, x, y, z) : { nx: 0, ny: 1, nz: 0 };
  return { x, y, z, ...n };
}

/** The outward normal of the OBB face nearest a point on its surface. */
function faceNormal(o: OBB, x: number, y: number, z: number): { nx: number; ny: number; nz: number } {
  const l = worldToLocal(o, x, z);
  const fx = o.sx / 2 - Math.abs(l.x), fz = o.sz / 2 - Math.abs(l.z), fy = o.sy / 2 - Math.abs(y - o.y);
  if (fy <= fx && fy <= fz) return { nx: 0, ny: Math.sign(y - o.y) || 1, nz: 0 };
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
  // local +x -> world (cos, sin), local +z -> world (-sin, cos) (shared/map.ts localToWorld)
  if (fx <= fz) { const k = Math.sign(l.x) || 1; return { nx: c * k, ny: 0, nz: s * k }; }
  const k = Math.sign(l.z) || 1;
  return { nx: -s * k, ny: 0, nz: c * k };
}

export class Sprays {
  private bySrc = new Map<string, THREE.Mesh>();
  private order: string[] = [];
  private tex: THREE.Texture[] = [];
  private geo = new THREE.PlaneGeometry(SIZE, SIZE);

  constructor(private scene: THREE.Scene) {}

  place(src: string, tag: number, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.remove(src);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture(tag),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
      fog: true,
    });
    const m = new THREE.Mesh(this.geo, mat);
    m.name = "spray";
    const n = new THREE.Vector3(nx, ny, nz).normalize();
    m.position.set(x, y, z).addScaledVector(n, 0.012);
    // face out of the surface; on a floor, upright toward +z so the tag is never mirrored
    if (Math.abs(n.y) > 0.9) m.up.set(0, 0, 1); // a floor: lookAt needs an up that is not the normal
    m.lookAt(m.position.clone().add(n));
    m.renderOrder = 2;
    this.scene.add(m);
    this.bySrc.set(src, m);
    this.order.push(src);
    while (this.order.length > MAX_SPRAYS) this.remove(this.order[0]!);
  }

  /** The next match starts on clean walls. */
  clear(): void {
    for (const s of [...this.bySrc.keys()]) this.remove(s);
  }

  private remove(src: string): void {
    const m = this.bySrc.get(src);
    this.order = this.order.filter((s) => s !== src);
    if (!m) return;
    this.scene.remove(m);
    (m.material as THREE.Material).dispose();
    this.bySrc.delete(src);
  }

  private texture(tag: number): THREE.Texture {
    const i = Math.max(0, Math.min(SPRAY_NAMES.length - 1, tag | 0));
    if (this.tex[i]) return this.tex[i]!;
    const t = new THREE.CanvasTexture(paintSpray(i));
    t.colorSpace = THREE.SRGBColorSpace;
    this.tex[i] = t;
    return t;
  }
}

/** One tag on a 256 canvas: the design, overspray halo, a few drips. Exported for the settings preview. */
export function paintSpray(i: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d")!;
  let seed = 7 + i * 131;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const drips = (col: string, xs: number[], y0: number): void => {
    x.fillStyle = col;
    for (const dx of xs) {
      const len = 14 + rnd() * 34;
      x.fillRect(dx, y0, 3, len);
      x.beginPath();
      x.arc(dx + 1.5, y0 + len, 3, 0, Math.PI * 2);
      x.fill();
    }
  };
  x.lineCap = x.lineJoin = "round";
  x.shadowBlur = 7; // overspray
  if (i === 0) {
    // BANANA: a fat crescent with a stem, outlined
    x.shadowColor = "rgba(255,210,40,0.8)";
    x.strokeStyle = "#1b1206";
    x.fillStyle = "#ffd21f";
    x.lineWidth = 10;
    x.beginPath();
    x.moveTo(52, 70);
    x.quadraticCurveTo(70, 205, 210, 170);
    x.quadraticCurveTo(110, 165, 84, 60);
    x.closePath();
    x.fill();
    x.stroke();
    x.fillStyle = "#5a3a12";
    x.fillRect(58, 46, 22, 22);
    drips("#ffd21f", [120, 170], 176);
  } else if (i === 1) {
    // KONG: a gorilla face, brow ridge and muzzle
    x.shadowColor = "rgba(60,30,10,0.8)";
    x.fillStyle = "#3a2214";
    x.beginPath();
    x.arc(128, 116, 82, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#c98c55";
    x.beginPath();
    x.ellipse(128, 150, 54, 40, 0, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#c98c55";
    x.beginPath();
    x.ellipse(100, 104, 22, 18, 0, 0, Math.PI * 2);
    x.ellipse(156, 104, 22, 18, 0, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#111";
    x.beginPath();
    x.arc(102, 106, 7, 0, Math.PI * 2);
    x.arc(154, 106, 7, 0, Math.PI * 2);
    x.fill();
    x.fillRect(84, 84, 88, 9); // brow
    x.beginPath();
    x.ellipse(116, 140, 6, 4, 0, 0, Math.PI * 2);
    x.ellipse(140, 140, 6, 4, 0, 0, Math.PI * 2);
    x.fill();
    x.lineWidth = 5;
    x.strokeStyle = "#111";
    x.beginPath();
    x.arc(128, 150, 24, 0.25 * Math.PI, 0.75 * Math.PI);
    x.stroke();
    drips("#3a2214", [80, 176, 140], 190);
  } else {
    // GG / EZ: chunky stencil letters, outlined
    const txt = SPRAY_NAMES[i]!;
    const col = i === 2 ? "#2ee6a0" : "#ff4fa3";
    x.font = '900 150px "Barlow Condensed", Impact, Arial Black, sans-serif';
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = col;
    x.lineWidth = 14;
    x.strokeStyle = "#0c0c10";
    x.strokeText(txt, 128, 120);
    x.fillStyle = col;
    x.fillText(txt, 128, 120);
    drips(col, [88, 132, 170], 178);
  }
  return c;
}
