/**
 * client/src/nuketown-egg.ts — THE MANNEQUIN HEADS (feel stream R2; Nuketown only).
 * ===========================================================================
 *
 * BO1's Nuketown easter egg: shoot the head off every mannequin in the match
 * and the town plays you a song. Here:
 *
 *  - Every mannequin's head is its own node (`mq_<kind>_head`, props-in GLBs).
 *    A server SHOT (Game.worldEvents — the authoritative ray, identical on
 *    every client) that reaches a head's sphere before it reaches a wall pops
 *    it off: the head flies along the round, tumbles, bounces on the floor and
 *    rests there (fixed 1/120 s steps on the time since the pop, so every
 *    client's head comes to rest in the same place). A frag going off within
 *    2.2 m pops heads too. A soft "thock" on each pop, and a quiet counter.
 *  - All of them, within the match → a short period-music sting (a 1950s
 *    doo-wop turnaround — vibraphone comp, walking upright bass, brushes and
 *    a clarinet line — synthesised, ~8 s, at a polite level on the INTERFACE
 *    bus) and a subtle notice. Shared world, shared egg: it is the whole
 *    lobby's, on every client at once.
 *  - Heads go back on at the next match.
 *
 * WHICH MANNEQUINS. The ones the map places (any `mq_*_head` in the scene).
 * Today the map's interior props-in placements are all held (enabled: false in
 * assets-3d/nuketown/placements.json), so when the scene has none this module
 * stands the ten STANDING ones of that same list (window, sink, garage,
 * child's room, wardrobe × both houses) where the houses' placements put
 * them — cosmetic only: no colliders, nothing in the sim. When the map stream
 * enables the placements (with their colliders), this falls away by itself.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { assetUrl } from "./asset-base";
import { groundHeight, traceWorld } from "@shared/map";
import { activeMap } from "@shared/maps";
import type { NetEvent } from "@shared/protocol";
import type { Game } from "./game";

/** The houses' own placements (assets-3d/nuketown/placements.json), standing poses only. rotY = three.js rotation.y. */
const STANDING: { asset: string; pos: [number, number, number]; rotY: number }[] = [
  { asset: "mq_woman_blouse", pos: [14.893, 0.22, -0.73], rotY: (-82 * Math.PI) / 180 },
  { asset: "mq_woman_blouse", pos: [20.567, 0.22, -1.679], rotY: (98 * Math.PI) / 180 },
  { asset: "mq_man_suit", pos: [18.547, 0.22, -9.726], rotY: (98 * Math.PI) / 180 },
  { asset: "mq_child_stand", pos: [17.943, 3.09, -4.895], rotY: (188 * Math.PI) / 180 },
  { asset: "mq_woman_dress", pos: [13.9, 3.09, -5.286], rotY: (98 * Math.PI) / 180 },
  { asset: "mq_woman_blouse", pos: [-13.2916, 0.22, -4.2378], rotY: 1.4488 },
  { asset: "mq_woman_blouse", pos: [-21.7793, 0.22, -11.6792], rotY: -1.89019 },
  { asset: "mq_man_suit", pos: [-18.0324, 0.22, -3.1198], rotY: 0.71098 },
  { asset: "mq_child_stand", pos: [-20.8713, 3.05, -6.7972], rotY: 1.2514 },
  { asset: "mq_woman_dress", pos: [-12.8535, 3.05, -6.1994], rotY: -1.59873 },
];

const STEP = 1 / 120;
const G = 9.8;

type Head = {
  obj: THREE.Object3D;
  home: THREE.Object3D;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  restScale: THREE.Vector3;
  center: THREE.Vector3;
  radius: number;
  popped: boolean;
  t: number;
  acc: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  w: THREE.Vector3;
  resting: boolean;
  /** Head centre above the node's origin (the floor contact uses the centre). */
  lift: number;
};

function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class MannequinEgg {
  private heads: Head[] = [];
  private placed: THREE.Object3D[] = [];
  private note: HTMLElement | null = null;
  private noteT = 0;
  private noteDur = 0;
  private done = false;
  private tune: AudioBuffer | null = null;
  private wasEnded = false;
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private readonly solids = activeMap().solids;

  constructor(private game: Game) {}

  /** Find the map's mannequins; stand the held ones in if there are none. */
  async init(): Promise<void> {
    const scene = this.game.world!.scene;
    if (!this.find(scene).length) await this.standIn(scene);
    // a stable order on every client (the GLBs finish loading in any order): by where the head is
    this.heads = this.find(scene)
      .map((obj) => this.head(obj))
      .sort((a, b) => a.center.x - b.center.x || a.center.z - b.center.z || a.center.y - b.center.y);
    this.game.worldEvents.push((e) => this.onEvent(e));
    (window as unknown as { __mannequins?: MannequinEgg }).__mannequins = this;
  }

  private find(scene: THREE.Object3D): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (/^mq_[a-z_]+_head$/.test(o.name)) out.push(o);
    });
    return out;
  }

  private async standIn(scene: THREE.Scene): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const cache = new Map<string, Promise<THREE.Group | null>>();
    const get = (asset: string) => {
      let p = cache.get(asset);
      if (!p) {
        p = loader.loadAsync(assetUrl(`/assets/nuketown/props/${asset}.glb`)).then((g) => g.scene).catch(() => null);
        cache.set(asset, p);
      }
      return p;
    };
    const root = new THREE.Group();
    root.name = "nuketown/mannequins (feel stand-ins)";
    await Promise.all(
      STANDING.map(async (m) => {
        const tpl = await get(m.asset);
        if (!tpl) return;
        const inst = tpl.clone(true);
        inst.position.set(...m.pos);
        inst.rotation.y = m.rotY;
        inst.userData.kind = "prop";
        inst.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        root.add(inst);
        this.placed.push(inst);
      }),
    );
    scene.add(root);
    root.updateMatrixWorld(true);
  }

  private head(obj: THREE.Object3D): Head {
    obj.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    return {
      obj,
      home: obj.parent!,
      restPos: obj.position.clone(),
      restQuat: obj.quaternion.clone(),
      restScale: obj.scale.clone(),
      center,
      radius: Math.max(0.09, Math.max(size.x, size.y, size.z) * 0.55),
      popped: false,
      t: 0,
      acc: 0,
      p: new THREE.Vector3(),
      v: new THREE.Vector3(),
      w: new THREE.Vector3(),
      resting: false,
      lift: 0,
    };
  }

  /** How many heads there are / are off (QA, the counter). */
  count(): { total: number; popped: number } {
    return { total: this.heads.length, popped: this.heads.filter((h) => h.popped).length };
  }

  // ---------------------------------------------------------------- the shots

  private onEvent(e: NetEvent): void {
    if (this.game.ended) return;
    if (e.t === "shot") {
      const wall = traceWorld(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, 200).t + 0.05;
      let best: Head | null = null;
      let bestT = wall;
      for (const h of this.heads) {
        if (h.popped) continue;
        // ray-sphere
        const cx = h.center.x - e.ox, cy = h.center.y - e.oy, cz = h.center.z - e.oz;
        const tc = cx * e.dx + cy * e.dy + cz * e.dz;
        if (tc <= 0) continue;
        const d2 = cx * cx + cy * cy + cz * cz - tc * tc;
        if (d2 > h.radius * h.radius) continue;
        const t = tc - Math.sqrt(h.radius * h.radius - d2);
        if (t < bestT) {
          bestT = t;
          best = h;
        }
      }
      if (best) this.pop(best, e.dx, e.dy, e.dz, hash(e.ox * 13.1 + e.oz, e.dy * 97.3));
    } else if (e.t === "boom") {
      for (const h of this.heads) {
        if (h.popped) continue;
        const dx = h.center.x - e.x, dy = h.center.y - e.y, dz = h.center.z - e.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < 2.2) this.pop(h, dx / (d || 1), 0.5, dz / (d || 1), hash(e.x, e.z));
      }
    }
  }

  private pop(h: Head, dx: number, dy: number, dz: number, r: number): void {
    h.popped = true;
    h.t = 0;
    h.acc = 0;
    h.resting = false;
    const scene = this.game.world!.scene;
    scene.attach(h.obj); // keep its world transform, move in world space from here
    h.p.copy(h.obj.position);
    h.lift = h.center.y - h.obj.position.y;
    h.v.set(dx * 4.2 + (r - 0.5) * 1.2, Math.max(1.6, dy * 2 + 2.6), dz * 4.2 + (hash(r, 3.1) - 0.5) * 1.2);
    h.w.set((r - 0.5) * 16, (hash(r, 7) - 0.5) * 10, (hash(r, 11) - 0.5) * 16);
    this.game.audio.impact(h.center.x, h.center.y, h.center.z, "wood");
    const c = this.count();
    if (c.popped >= c.total && c.total > 0 && !this.done) {
      this.done = true;
      this.show("ALL MANNEQUINS DOWN", "NUKETOWN EASTER EGG FOUND", 6.5, true);
      void this.playTune();
    } else {
      this.show(`MANNEQUINS  ${c.popped} / ${c.total}`, "", 1.7, false);
    }
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const g = this.game;
    // heads back on for the next match
    if (this.wasEnded && !g.ended) this.reset();
    this.wasEnded = g.ended;
    for (const h of this.heads) {
      if (!h.popped || h.resting) continue;
      h.acc += Math.min(0.1, dt);
      while (h.acc >= STEP && !h.resting) {
        h.acc -= STEP;
        h.t += STEP;
        this.stepHead(h);
      }
      h.obj.position.copy(h.p);
      this.q.setFromAxisAngle(this.v3.copy(h.w).normalize(), h.w.length() * Math.min(0.1, dt));
      if (h.w.lengthSq() > 1e-4) h.obj.quaternion.premultiply(this.q);
    }
    this.tickNote(dt);
  }

  private stepHead(h: Head): void {
    h.v.y -= G * STEP;
    // walls: a head never flies through the house it was in
    const sp = h.v.length() * STEP;
    if (sp > 1e-4) {
      const tr = traceWorld(h.p.x, h.p.y + h.lift, h.p.z, h.v.x / (sp / STEP), h.v.y / (sp / STEP), h.v.z / (sp / STEP), sp + h.radius * 0.6);
      if (tr.t < sp + h.radius * 0.6 && Math.abs(h.v.y) < Math.hypot(h.v.x, h.v.z) * 2) {
        h.v.x *= -0.3;
        h.v.z *= -0.3;
      }
    }
    h.p.addScaledVector(h.v, STEP);
    const floor = groundHeight(h.p.x, h.p.z, this.solids, h.p.y + h.lift + 0.3) + h.radius * 0.8 - h.lift;
    if (h.p.y < floor) {
      h.p.y = floor;
      if (h.v.y < 0) h.v.y = -h.v.y * 0.32;
      h.v.x *= 0.62;
      h.v.z *= 0.62;
      h.w.multiplyScalar(0.55);
      if (h.v.length() < 0.35) {
        h.resting = true;
        h.w.set(0, 0, 0);
      }
    }
    if (h.t > 6) h.resting = true;
  }

  private reset(): void {
    for (const h of this.heads) {
      if (!h.popped) continue;
      h.home.add(h.obj);
      h.obj.position.copy(h.restPos);
      h.obj.quaternion.copy(h.restQuat);
      h.obj.scale.copy(h.restScale);
      h.popped = false;
      h.resting = false;
    }
    this.done = false;
  }

  // ---------------------------------------------------------------- the notice

  private show(title: string, sub: string, secs: number, big: boolean): void {
    const hud = document.getElementById("hud");
    if (!hud) return;
    if (!this.note || !this.note.isConnected) {
      this.note = document.getElementById("egg-note") ?? document.createElement("div");
      this.note.id = "egg-note";
      hud.append(this.note);
    }
    this.note.className = big ? "big" : "";
    this.note.replaceChildren();
    if (big) {
      const i = document.createElement("i");
      i.setAttribute("aria-hidden", "true");
      this.note.append(i);
    }
    const b = document.createElement("b");
    b.textContent = title;
    this.note.append(b);
    if (sub) {
      const s = document.createElement("span");
      s.textContent = sub;
      this.note.append(s);
    }
    this.noteT = 0;
    this.noteDur = secs;
  }

  private tickNote(dt: number): void {
    if (!this.note) return;
    this.noteT += dt;
    const t = this.noteT;
    const o = t > this.noteDur ? 0 : Math.min(1, t / 0.25) * Math.min(1, (this.noteDur - t) / 0.5);
    const v = o.toFixed(2);
    if (this.note.style.opacity !== v) this.note.style.opacity = v;
  }

  // ---------------------------------------------------------------- the tune

  private async playTune(): Promise<void> {
    const rig = this.game.audio as unknown as { ctx: AudioContext | null; ready: boolean; buses?: Record<string, GainNode> };
    const ctx = rig.ctx;
    const bus = rig.buses?.ui;
    if (!ctx || !bus || !rig.ready) return;
    this.tune ??= await renderTune(ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = this.tune;
    const g = ctx.createGain();
    g.gain.value = 0.62;
    src.connect(g).connect(bus);
    src.start(ctx.currentTime + 0.25);
  }

  dispose(): void {
    for (const p of this.placed) p.removeFromParent();
  }
}

/**
 * A 1950s doo-wop turnaround in C, swung 8ths at 132 bpm: I – vi – ii7 V7 – I.
 * Vibraphone comp on 2 and 4 (sine + its 4th partial, motor tremolo), a walking
 * upright bass, brushes, and a soft clarinet-ish lead with vibrato; ends on a
 * C6 arpeggio. Rendered once, offline.
 */
export async function renderTune(sr: number): Promise<AudioBuffer> {
  const beat = 60 / 132;
  const len = beat * 18 + 2.2;
  const ctx = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  const out = ctx.createGain();
  out.gain.value = 0.9;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 6500;
  out.connect(lp).connect(ctx.destination);
  const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
  const swing = (b: number) => (b % 1 > 0.01 ? Math.floor(b) + 2 / 3 : b); // swung 8ths
  const at = (b: number) => 0.05 + swing(b) * beat;
  const pan = (node: AudioNode, p: number) => {
    const s = ctx.createStereoPanner();
    s.pan.value = p;
    node.connect(s).connect(out);
    return s;
  };
  // vibraphone: sine + 4th partial, 5.5 Hz motor tremolo
  const vib = (m: number, t: number, dur: number, amp: number, p = 0.15) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    const trem = ctx.createGain();
    trem.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lg = ctx.createGain();
    lg.gain.value = 0.18;
    lfo.connect(lg).connect(trem.gain);
    for (const [k, a] of [[1, 1], [4, 0.18], [10, 0.03]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = hz(m) * k;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
    g.connect(trem);
    pan(trem, p);
  };
  // upright bass: a plucked fundamental + a little 2nd, quick decay, slight pitch sag
  const bass = (m: number, t: number, dur: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.55, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    for (const [k, a] of [[1, 1], [2, 0.35], [3, 0.08]] as const) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(hz(m) * k * 1.01, t);
      o.frequency.exponentialRampToValueAtTime(hz(m) * k, t + 0.08);
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    pan(g, -0.1);
  };
  // brushes: band-passed noise
  const noise = ctx.createBuffer(1, Math.ceil(sr * 0.4), sr);
  {
    const d = noise.getChannelData(0);
    let s = 7;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = s / 4294967296 * 2 - 1;
    }
  }
  const brush = (t: number, amp: number, dur: number) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 4200;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    n.connect(bp).connect(g);
    pan(g, 0.3);
    n.start(t);
    n.stop(t + dur + 0.02);
  };
  // lead: clarinet-ish (odd partials), soft attack, vibrato
  const lead = (m: number, t: number, dur: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2, t + 0.04);
    g.gain.setValueAtTime(0.2, t + Math.max(0.05, dur - 0.08));
    g.gain.linearRampToValueAtTime(0, t + dur);
    const vibr = ctx.createOscillator();
    vibr.frequency.value = 5.2;
    const vg = ctx.createGain();
    vg.gain.value = hz(m) * 0.006;
    vibr.connect(vg);
    for (const [k, a] of [[1, 1], [3, 0.32], [5, 0.12]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = hz(m) * k;
      vg.connect(o.frequency);
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    vibr.start(t);
    vibr.stop(t + dur + 0.02);
    pan(g, 0.05);
  };
  // the changes: C6 | Am7 | Dm7 G7 | C6 …
  const chords: [number, number[]][] = [
    [0, [60, 64, 67, 69]],
    [4, [57, 60, 64, 67]],
    [8, [62, 65, 69, 72]],
    [10, [55, 59, 62, 65]],
    [12, [60, 64, 67, 69]],
  ];
  for (const [b, notes] of chords) {
    const span = b === 8 || b === 10 ? 2 : 4;
    for (let k = 1; k < span; k += 2) for (const m of notes) vib(m + 12, at(b + k), beat * 1.6, 0.07);
  }
  const walk = [48, 52, 55, 57, 45, 48, 52, 55, 50, 53, 43, 47, 48, 43, 48];
  walk.forEach((m, i) => bass(m - 12, at(i), beat * 0.95));
  for (let b = 0; b < 16; b++) {
    if (b % 2 === 1) brush(at(b), 0.09, 0.16);
    brush(at(b + 0.5), 0.035, 0.08);
  }
  const mel: [number, number, number][] = [
    [76, 0, 1], [79, 1, 0.5], [81, 1.5, 0.5], [79, 2, 1], [76, 3, 1],
    [72, 4, 1], [76, 5, 0.5], [74, 5.5, 0.5], [72, 6, 1], [69, 7, 1],
    [74, 8, 0.5], [77, 8.5, 0.5], [81, 9, 1], [79, 10, 0.5], [77, 10.5, 0.5], [74, 11, 1],
    [76, 12, 1], [74, 13, 0.5], [72, 13.5, 2.5],
  ];
  for (const [m, b, d] of mel) lead(m, at(b), d * beat);
  // the button: a C6 arpeggio on the vibes over the held bass
  [60, 64, 67, 69, 72].forEach((m, i) => vib(m + 12, at(16) + i * 0.07, 1.8, 0.09, 0.25));
  bass(36, at(16), 1.6);
  return ctx.startRendering();
}
