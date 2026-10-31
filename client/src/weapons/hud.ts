/**
 * WEAPONS → HUD. Two jobs, kept apart on purpose:
 *
 *  1. FEED the UI stream's HUD through the contract (client/src/hud-api.ts):
 *     setWeaponHud / setLethalHud every frame, numbers only. How those numbers
 *     look is the UI stream's business.
 *  2. Own the three pieces of weapon chrome that are not HUD layout but part of
 *     the weapon itself: the sniper SCOPE overlay, the frag COOK ring, and the
 *     CoD grenade DANGER indicator. Minimal functional DOM, styled in
 *     client/src/weapons-hud.css (the UI stream may restyle it later — the
 *     class names are the contract).
 */
import * as THREE from "three";
import { WEAPON_BY_ID, HIP_FOV, reloadTime } from "@shared/weapons";
import { NADE_AMMO, NADE_FUSE, shotCone } from "@shared/sim";
import type { NadeSnap, PlayerSnap } from "@shared/protocol";
import type { LoadoutWeaponId } from "@shared/loadout";
import { setLethalHud, setWeaponHud, type WeaponHud, type LethalHud } from "../hud-api";
import "../weapons-hud.css";

/** Ahead of this ADS fraction the sniper's view IS the scope. */
export const SCOPE_AT = 0.86;
/** Grenades inside this radius (m) light the danger indicator. */
const DANGER_R = 8;
const DANGER_POOL = 6;

const V = new THREE.Vector3();
const FWD = new THREE.Vector3();

export type HudFrame = {
  me: PlayerSnap & { onGround?: boolean; heat?: number };
  /** Camera vertical FOV, degrees, as drawn this frame. */
  fov: number;
  /** Seconds the local frag has cooked (predicted), 0 when not cooking. */
  cook: number;
  /** Pin pulled (the local throw cycle is in its cook phase). */
  cooking: boolean;
  nades: readonly NadeSnap[];
  camera: THREE.PerspectiveCamera;
  breath: number;
  breathOut: boolean;
  breathHold: boolean;
  visible: boolean;
};

export class WeaponHudDriver {
  private host: HTMLElement | null = null;
  private scope: HTMLCanvasElement | null = null;
  private scopeBreath: HTMLElement | null = null;
  private scopeW = 0;
  private scopeH = 0;
  private cookEl: HTMLElement | null = null;
  private cookArc: SVGCircleElement | null = null;
  private cookNum: HTMLElement | null = null;
  private danger: HTMLElement[] = [];
  private cross: HTMLElement | null = null;
  private weapon: WeaponHud = {
    slot: 0,
    id: "ar",
    name: "",
    cls: "",
    ammo: 0,
    mag: 0,
    reserve: 0,
    reloadFrac: -1,
    other: null,
    spreadPx: 0,
    ads: 0,
    scoped: false,
  };
  private other = { id: "pistol" as LoadoutWeaponId, name: "", ammo: 0, reserve: 0 };
  private lethal: LethalHud = { count: 0, max: NADE_AMMO, cooking: false, fuseLeft: NADE_FUSE, fuseMax: NADE_FUSE };
  /** Scoped this frame (game.ts reads it for sensitivity and the viewmodel). */
  scoped = false;
  /** Set by the spectator camera each frame: the watched sniper is scoped. */
  spectScoped = false;

  private mount(): boolean {
    if (this.host?.isConnected) return true;
    const hud = document.getElementById("hud");
    if (!hud) return false;
    let host = document.getElementById("wpn-layer");
    if (!host) {
      host = document.createElement("div");
      host.id = "wpn-layer";
      host.innerHTML = `
        <canvas class="wpn-scope" aria-hidden="true"></canvas>
        <div class="wpn-breath" aria-hidden="true"><i></i><span>HOLD SHIFT · STEADY</span></div>
        <div class="wpn-cook" aria-hidden="true">
          <svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="27"/><circle class="arc" cx="32" cy="32" r="27"/></svg>
          <b></b>
        </div>
        <div class="wpn-danger" aria-hidden="true"></div>`;
      // First child: under every other HUD element, over the 3D canvas.
      hud.insertBefore(host, hud.firstChild);
    }
    this.host = host;
    this.scope = host.querySelector(".wpn-scope");
    this.scopeBreath = host.querySelector(".wpn-breath");
    this.cookEl = host.querySelector(".wpn-cook");
    this.cookArc = host.querySelector(".wpn-cook .arc");
    this.cookNum = host.querySelector(".wpn-cook b");
    const dz = host.querySelector(".wpn-danger") as HTMLElement;
    this.danger = [];
    dz.innerHTML = "";
    for (let i = 0; i < DANGER_POOL; i++) {
      const d = document.createElement("div");
      d.className = "wpn-nade";
      d.innerHTML = `<i class="arrow"></i><svg viewBox="0 0 32 32"><path d="M13 6h6v3h-6z"/><path d="M19 7l6-3 1 2-5 3z"/><ellipse cx="16" cy="19" rx="8" ry="10"/><path class="band" d="M8 17h16v2H8zM8 22h16v2H8z"/></svg>`;
      dz.appendChild(d);
      this.danger.push(d);
    }
    this.cross = document.getElementById("cross");
    return true;
  }

  /** Every frame: feed the HUD contract and drive the weapon chrome. */
  update(f: HudFrame): void {
    const me = f.me;
    const w = WEAPON_BY_ID[me.weapon];
    if (f.visible) this.spectScoped = false;
    if (!this.mount() || !w || !f.visible || !me.alive) {
      this.scoped = false;
      setWeaponHud(null);
      setLethalHud(null);
      if (this.host) this.host.classList.remove("cooking");
      // A spectator watching a scoped sniper sees the scope (spectate.ts).
      if (this.host) {
        if (this.spectScoped) this.paintScope();
        this.host.classList.toggle("scoped", this.spectScoped);
      }
      this.host?.parentElement?.classList.remove("wpn-scoped");
      for (const d of this.danger) d.style.display = "none";
      return;
    }
    const H = innerHeight;
    // ---- the contract: weapon
    const cone = shotCone(
      { ads: me.ads, vx: me.vx, vz: me.vz, onGround: me.onGround ?? true, crouch: me.crouch, heat: me.heat ?? 0 },
      w,
    );
    const half = Math.tan(((f.fov || HIP_FOV) * Math.PI) / 360);
    const spreadPx = (Math.tan(cone) / half) * (H / 2);
    this.scoped = w.scope && me.ads >= SCOPE_AT && me.swap <= 0;
    const hw = this.weapon;
    hw.slot = me.weapon === "pistol" ? 1 : 0;
    hw.id = me.weapon as LoadoutWeaponId;
    hw.name = w.name;
    hw.cls = w.cls;
    hw.ammo = me.ammo ?? 0;
    hw.mag = w.mag;
    hw.reserve = me.reserve ?? 0;
    hw.reloadFrac = me.reload > 0 ? Math.min(1, Math.max(0, 1 - me.reload / reloadTime(w, me.ammo ?? 0))) : -1;
    const ow = WEAPON_BY_ID[me.alt ?? ""];
    if (ow) {
      this.other.id = ow.id as LoadoutWeaponId;
      this.other.name = ow.name;
      this.other.ammo = me.altAmmo ?? 0;
      this.other.reserve = me.altRes ?? 0;
      hw.other = this.other;
    } else hw.other = null;
    hw.spreadPx = Math.round(spreadPx * 10) / 10;
    hw.ads = me.ads;
    hw.scoped = this.scoped;
    setWeaponHud(hw);
    // ---- the contract: lethal
    const fuseLeft = f.cooking ? Math.max(0, NADE_FUSE - f.cook) : NADE_FUSE;
    const L = this.lethal;
    L.count = me.nades ?? 0;
    // The pips follow what the belt carries; the 10-kill reward makes it two.
    L.max = Math.max(NADE_AMMO, L.count);
    L.cooking = f.cooking;
    L.fuseLeft = fuseLeft;
    setLethalHud(L);
    // ---- crosshair bloom + scope hide (a CSS variable; the UI owns the shape)
    if (this.cross) this.cross.style.setProperty("--wpn-gap", `${Math.min(90, spreadPx).toFixed(1)}px`);
    this.host!.parentElement?.classList.toggle("wpn-scoped", this.scoped);
    // ---- scope
    this.paintScope();
    this.host!.classList.toggle("scoped", this.scoped);
    if (this.scopeBreath) {
      this.scopeBreath.classList.toggle("hold", f.breathHold);
      this.scopeBreath.classList.toggle("out", f.breathOut);
      (this.scopeBreath.firstElementChild as HTMLElement).style.transform = `scaleX(${f.breath.toFixed(3)})`;
    }
    // ---- cook ring
    this.host!.classList.toggle("cooking", f.cooking);
    if (f.cooking && this.cookArc && this.cookNum && this.cookEl) {
      const k = fuseLeft / NADE_FUSE;
      const C = 2 * Math.PI * 27;
      this.cookArc.style.strokeDasharray = `${(C * k).toFixed(2)} ${C.toFixed(2)}`;
      this.cookNum.textContent = fuseLeft.toFixed(1);
      this.cookEl.classList.toggle("hot", fuseLeft < 1.0);
    }
    // ---- danger
    this.paintDanger(f);
  }

  /** The tactical scope: black body, clean lens, fine mil-dot duplex. Painted on resize. */
  private paintScope(): void {
    const c = this.scope;
    if (!c) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.round(innerWidth * dpr);
    const H = Math.round(innerHeight * dpr);
    if (W === this.scopeW && H === this.scopeH) return;
    this.scopeW = c.width = W;
    this.scopeH = c.height = H;
    paintTacticalScope(c);
  }

  private paintDanger(f: HudFrame): void {
    const me = f.me;
    const cam = f.camera;
    cam.getWorldDirection(FWD);
    const W = innerWidth;
    const H = innerHeight;
    let n = 0;
    for (const g of f.nades) {
      if (n >= this.danger.length) break;
      const dx = g.x - me.x;
      const dz = g.z - me.z;
      const dy = g.y - (me.y + 1);
      const d = Math.hypot(dx, dy, dz);
      if (d > DANGER_R) continue;
      const el = this.danger[n++]!;
      el.style.display = "block";
      // On screen: ON the frag. Off screen (or behind): on an ellipse round the
      // crosshair along the frag's bearing, arrow pointing out at it.
      V.set(g.x, g.y, g.z).project(cam);
      const inFront = V.z < 1 && V.x > -0.92 && V.x < 0.92 && V.y > -0.86 && V.y < 0.86;
      let sx: number;
      let sy: number;
      // bearing relative to the view, in screen terms
      const yawTo = Math.atan2(dx, dz);
      const yawFwd = Math.atan2(FWD.x, FWD.z);
      let rel = yawTo - yawFwd;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (inFront) {
        sx = (V.x * 0.5 + 0.5) * W;
        sy = (-V.y * 0.5 + 0.5) * H;
        el.classList.remove("edge");
      } else {
        sx = W / 2 - Math.sin(rel) * W * 0.27;
        sy = H / 2 - Math.cos(rel) * H * 0.3;
        el.classList.add("edge");
      }
      const close = 1 - d / DANGER_R;
      const fuse = g.fuse ?? NADE_FUSE;
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) scale(${(0.85 + close * 0.45).toFixed(3)})`;
      el.style.setProperty("--wpn-rot", `${(-rel).toFixed(3)}rad`);
      el.style.opacity = (0.55 + close * 0.45).toFixed(3);
      el.classList.toggle("hot", fuse < 1.2 || d < 3);
      el.classList.toggle("own", g.src === me.id);
    }
    for (let i = n; i < this.danger.length; i++) this.danger[i]!.style.display = "none";
  }
}

/**
 * A modern tactical sniper scope, painted once per resize. Everything outside
 * the lens is matte black; the lens carries a faint cool tint, a soft vignette
 * into the tube, a hair of chromatic fringe at the rim and a glint; the reticle
 * is a fine duplex with mil-dots — black, thin, legible on sky and on steel.
 * (Kong Royale's coconut-shell scope, rebuilt for a military optic.)
 */
export function paintTacticalScope(c: HTMLCanvasElement): void {
  const g = c.getContext("2d");
  if (!g) return;
  const W = c.width;
  const H = c.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const R = H * 0.445;
  // body: black with a faint falloff so the tube does not look cut out
  g.fillStyle = "#030405";
  g.beginPath();
  g.rect(0, 0, W, H);
  g.arc(cx, cy, R * 1.06, 0, Math.PI * 2, true);
  g.fill();
  // the tube wall: a thin dark ring with a faint machined highlight
  const tube = g.createRadialGradient(cx, cy, R * 0.985, cx, cy, R * 1.06);
  tube.addColorStop(0, "rgba(0,0,0,1)");
  tube.addColorStop(0.35, "rgba(22,26,30,1)");
  tube.addColorStop(0.55, "rgba(9,11,13,1)");
  tube.addColorStop(1, "rgba(3,4,5,1)");
  g.fillStyle = tube;
  g.beginPath();
  g.arc(cx, cy, R * 1.06, 0, Math.PI * 2);
  g.arc(cx, cy, R * 0.985, 0, Math.PI * 2, true);
  g.fill();
  // lens: cool tint + vignette into the tube
  const vig = g.createRadialGradient(cx, cy, R * 0.45, cx, cy, R);
  vig.addColorStop(0, "rgba(10,30,40,0.05)");
  vig.addColorStop(0.72, "rgba(4,14,20,0.12)");
  vig.addColorStop(0.93, "rgba(0,4,8,0.48)");
  vig.addColorStop(1, "rgba(0,0,0,0.92)");
  g.fillStyle = vig;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  // chromatic fringe at the rim
  g.lineWidth = R * 0.01;
  g.strokeStyle = "rgba(255,60,40,0.14)";
  g.beginPath();
  g.arc(cx - R * 0.003, cy, R * 0.975, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = "rgba(40,180,255,0.13)";
  g.beginPath();
  g.arc(cx + R * 0.003, cy, R * 0.962, 0, Math.PI * 2);
  g.stroke();
  // glint
  g.lineWidth = R * 0.045;
  g.strokeStyle = "rgba(200,230,255,0.035)";
  g.beginPath();
  g.arc(cx, cy, R * 0.86, Math.PI * 1.1, Math.PI * 1.4);
  g.stroke();
  // reticle: fine cross, duplex posts, mil dots
  const ink = "rgba(4,6,6,0.96)";
  const thin = Math.max(1, H * 0.0009);
  const post = Math.max(3, H * 0.0038);
  const inner = R * 0.5;
  const gap = R * 0.006;
  g.strokeStyle = ink;
  g.lineCap = "butt";
  g.lineWidth = thin;
  g.beginPath();
  g.moveTo(cx - inner, cy);
  g.lineTo(cx - gap, cy);
  g.moveTo(cx + gap, cy);
  g.lineTo(cx + inner, cy);
  g.moveTo(cx, cy - inner);
  g.lineTo(cx, cy - gap);
  g.moveTo(cx, cy + gap);
  g.lineTo(cx, cy + inner);
  g.stroke();
  g.lineWidth = post;
  g.beginPath();
  g.moveTo(cx - R, cy);
  g.lineTo(cx - inner, cy);
  g.moveTo(cx + inner, cy);
  g.lineTo(cx + R, cy);
  g.moveTo(cx, cy + inner);
  g.lineTo(cx, cy + R);
  g.moveTo(cx, cy - R);
  g.lineTo(cx, cy - inner * 1.25);
  g.stroke();
  const mil = inner / 5;
  g.fillStyle = ink;
  for (let i = 1; i <= 4; i++) {
    const r = Math.max(1.3, H * 0.0014);
    for (const [x, y] of [
      [cx + i * mil, cy],
      [cx - i * mil, cy],
      [cx, cy - i * mil],
      [cx, cy + i * mil],
    ] as const) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // half-mil hash marks on the lower stadia (holdover)
    g.fillRect(cx - H * 0.004, cy + (i - 0.5) * mil - thin / 2, H * 0.008, thin);
  }
  // centre: a tiny open dot so the crosshair never hides the head it is on
  g.lineWidth = thin;
  g.beginPath();
  g.arc(cx, cy, Math.max(1.6, H * 0.0018), 0, Math.PI * 2);
  g.stroke();
}
