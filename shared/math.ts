export const TAU = Math.PI * 2;

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function approach(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

export function angWrap(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export function angLerp(a: number, b: number, t: number): number {
  return a + angWrap(b - a) * t;
}

export function len2(x: number, z: number): number {
  return Math.hypot(x, z);
}

export function norm2(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z);
  if (l < 1e-8) return [0, 0];
  return [x / l, z / l];
}

export function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export type Vec3 = { x: number; y: number; z: number };

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
