/**
 * client/src/tsl-materials.ts — TSL replacement for custom ShaderMaterial on WebGPU.
 * ============================================================================
 *
 * three.js knows NO node equivalent for custom GLSL (StandardNodeLibrary
 * maps built-ins only) — on WebGPU they fall back to an empty NodeMaterial
 * ("not compatible" error + wrong image). These factories port
 * our unlit procedural shaders 1:1 to TSL (same maths).
 *
 * BUNDLE DISCIPLINE: this module imports three/webgpu + three/tsl STATICALLY
 * and is therefore loaded EXCLUSIVELY via dynamic import()
 * (the game.init WebGPU branch preloads it once; after that everything is in
 * the module cache). Never import statically — otherwise WebGL users
 * pay for the 2.3 MB build too.
 *
 * UNIFORM BRIDGE: factories take the existing FxUniforms object and
 * REPLACE its {value} holders with TSL uniform nodes (same fields,
 * same names). Existing update code (`u.uPx.value = …`,
 * `u.uSunV.value.copy(…)` etc.) thereby keeps writing correctly on both paths
 * — NO call-site changes needed. No factory runs on WebGL.
 */
import * as THREE from "three";
import {
  Fn,
  uniform,
  attribute,
  varying,
  vec2,
  vec3,
  vec4,
  float,
  int,
  sub,
  mix,
  clamp,
  min,
  max,
  pow,
  fract,
  sin,
  cos,
  abs,
  atan,
  floor,
  sqrt,
  dot,
  cross,
  normalize,
  If,
  step,
  exp,
  smoothstep,
  texture,
  uv,
  positionLocal,
  cameraPosition,
  cameraViewMatrix,
  instanceIndex,
} from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import type { FxUniforms } from "./weapons/fx/gpu";

export interface TslMaterial {
  material: THREE.Material;
}

// ---------------------------------------------------------------------------
// Shared building blocks (1:1 from the GLSL COMMON blocks, smoothstep with
// defined behaviour on twisted edges).

const tslSS = (a, e, x) => {
  const t = clamp(x.sub(a).div(sub(e, a)), 0, 1);
  return t.mul(t).mul(float(3).sub(t.mul(2)));
};
const tslH11 = (n) => fract(sin(n.mul(12.9898)).mul(43758.5453));
/** 1D hash (GLSL h11: seed from birth time + instance) — VERT uses it. */
const tslHash11 = (n) => fract(sin(n.mul(12.9898)).mul(43758.5453));
const tslH21 = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
const tslVnoise = (p) => {
  const i = p.floor();
  const f = p.fract();
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = mix(tslH21(i), tslH21(i.add(vec2(1, 0))), u.x);
  const b = mix(tslH21(i.add(vec2(0, 1))), tslH21(i.add(vec2(1, 1))), u.x);
  return mix(a, b, u.y);
};
const tslFbm = (p) =>
  tslVnoise(p)
    .mul(0.6)
    .add(tslVnoise(p.mul(2.13).add(3.7)).mul(0.28))
    .add(tslVnoise(p.mul(4.31).add(9.1)).mul(0.12));
const tslRingNoise = (q, freq, seed) => {
  const d = q.div(max(q.length(), 1e-4));
  return tslVnoise(d.mul(freq).add(seed));
};
const tslCapsule = (dd, aspect) => {
  const px = dd.x.mul(aspect);
  const py = dd.y.mul(0.5);
  const x = clamp(px, 0.5, max(sub(aspect, 0.5), 0.5));
  return vec2(px.sub(x), py.sub(0.5)).length().sub(0.5);
};
/** NaN/Inf guard (IEEE-754 minimumNumber: quiet NaN loses against numbers). */
const tslGuard = (v) => max(min(v, vec3(60000)), vec3(0));
const tslGuardA = (a) => max(min(a, 1), 0);

// ---------------------------------------------------------------------------
// nuke-fx.ts NukeFx puffs — simplified 1:1 port of VERT + FRAG.
// World-space billboard (mesh at identity), sun/shadow/heat/haze as
// in GLSL but without billow noise (follows step by step). Crucial: NO
// ShaderMaterial on the WebGPU path (no "not compatible" error).
// Uniform bridge as in QuadFamily (same fields); uCamR/uCamU are written per
// frame from the camera (NukeFx.update owns them).
export function tslNukePuff(u: {
  uTime: { value: number };
  uSunV: { value: THREE.Vector3 };
  uLit: { value: THREE.Color };
  uShade: { value: THREE.Color };
  uSky: { value: THREE.Color };
  uBounce: { value: THREE.Color };
  uHaze: { value: THREE.Color };
  uHazeK: { value: number };
  uCamR: { value: THREE.Vector3 };
  uCamU: { value: THREE.Vector3 };
}): { material: THREE.Material; U: Record<string, unknown> } {
  const U = {
    uTime: uniform(u.uTime.value),
    uSunV: uniform(u.uSunV.value),
    uLit: uniform(u.uLit.value),
    uShade: uniform(u.uShade.value),
    uSky: uniform(u.uSky.value),
    uBounce: uniform(u.uBounce.value),
    uHaze: uniform(u.uHaze.value),
    uHazeK: uniform(u.uHazeK.value),
    uCamR: uniform(u.uCamR.value),
    uCamU: uniform(u.uCamU.value),
  };
  Object.assign(u, U);

  const iPos = attribute("iPos", "vec3");
  const iDat = attribute("iDat", "vec4");
  const iShade = attribute("iShade", "float");
  const iNrm = attribute("iNrm", "vec3");

  const vUv = varying(vec2(0), "nUv");
  const vDat = varying(vec4(0), "nDat");
  const vShade = varying(float(0), "nShade");
  const vMN = varying(vec3(0, 1, 0), "nMN");

  const positionNode = Fn(() => {
    const seed = iDat.y;
    const a = seed.mul(6.2831);
    const ca = cos(a);
    const sa = sin(a);
    const qx = ca.mul(positionLocal.x).sub(sa.mul(positionLocal.y));
    const qy = sa.mul(positionLocal.x).add(ca.mul(positionLocal.y));
    const wp = iPos.add(U.uCamR.mul(qx).add(U.uCamU.mul(qy)).mul(iDat.x));
    vUv.assign(positionLocal.xy.add(0.5));
    vDat.assign(iDat);
    vShade.assign(iShade);
    vMN.assign(normalize(cameraViewMatrix.mul(vec4(iNrm, 0)).xyz));
    return wp;
  });

  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  (mat as unknown as { positionNode: unknown }).positionNode = positionNode();
  const fragNode = Fn(() => {
    const p = vUv.mul(2).sub(1);
    const r = p.length();
    // Soft disc (instead of a crisp-carved billow silhouette — follows).
    const fall = float(1).sub(smoothstep(0.55, 1.0, r));
    const a = fall.mul(vDat.w);
    const nrm = normalize(vMN);
    const sun = dot(nrm, U.uSunV).mul(0.55).add(0.45).clamp(0, 1);
    const shadeIn = vShade;
    const lit = sun.mul(shadeIn).mul(1.05).sub(0.05).clamp(0, 1);
    const lit2 = lit.mul(lit).mul(float(3).sub(lit.mul(2)));
    const col = mix(U.uShade, U.uLit, lit2).toVar();
    col.assign(col.add(U.uSky.mul(max(nrm.y.mul(0.5).add(0.5), 0)).mul(0.16)));
    col.assign(col.add(U.uBounce.mul(max(nrm.y.mul(-1), 0)).mul(0.22)));
    // Fire: blackbody approximation in 2 stops (instead of 3) — heat from iDat.z.
    const heat = vDat.z;
    const fire = mix(vec3(0.5, 0.07, 0.02), vec3(1.0, 0.55, 0.15).mul(4), smoothstep(0.1, 0.7, heat));
    col.assign(col.add(fire.mul(pow(max(heat, 0), 1.25)).mul(max(float(1.2).sub(r.mul(0.85)), 0))));
    const d = cameraPosition.sub(iPos).length();
    const hazeF = max(float(1).sub(exp(d.div(1100).mul(-1))), 0).mul(U.uHazeK).clamp(0, 0.8);
    col.assign(mix(col, U.uHaze, hazeF));
    return vec4(col, a);
  });
  const out = fragNode();
  (mat as unknown as { colorNode: unknown }).colorNode = (out as unknown as { rgb: unknown }).rgb;
  (mat as unknown as { opacityNode: unknown }).opacityNode = (out as unknown as { a: unknown }).a;
  mat.alphaTest = 0.004;
  return { material: mat as unknown as THREE.Material, U };
}

// ---------------------------------------------------------------------------
// fx.ts NadeFx.ribbon — aFade attribute × head/tail colour.
export function tslNadeRibbon(): TslMaterial {
  const uHead = uniform(new THREE.Color(0xffdc7a).convertSRGBToLinear());
  const uTail = uniform(new THREE.Color(0xcf8a10).convertSRGBToLinear());
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  // NOTE: the ribbon attribute is called aAlpha (not aFade like the
  // instanced families) — see NadeFx constructor (fx.ts).
  const aFade = attribute("aAlpha", "float");
  mat.colorNode = mix(uTail, uHead, aFade);
  mat.opacityNode = aFade.mul(0.4);
  mat.alphaTest = 0.004;
  return { material: mat as unknown as THREE.Material };
}

// ---------------------------------------------------------------------------
// fx.ts spriteMat (flash/puffs/scorch): mask texture, R = coverage, G = mix.
export function tslSprite(tex, blending, gain, colA, colB): TslMaterial {
  // These masks are CANVAS textures. On the node path a minified sample of a
  // canvas source without an explicit mip chain comes back blank, so the whole
  // quad renders as one flat colour — that is the "black / white squares"
  // report on WebGPU. Level 0 with LinearFilter is exact and cheaper.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const uGain = uniform(gain);
  const uA = uniform(new THREE.Color(colA).convertSRGBToLinear());
  const uB = uniform(new THREE.Color(colB).convertSRGBToLinear());
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending, side: THREE.DoubleSide });
  const aFade = attribute("aFade", "float");
  const t = texture(tex, uv());
  mat.colorNode = mix(uA, uB, t.g);
  mat.opacityNode = t.r.mul(aFade).mul(uGain);
  mat.alphaTest = 0.004;
  return { material: mat as unknown as THREE.Material };
}

// ---------------------------------------------------------------------------
// fx.ts boom shock ring: uCol × feather sine over the ring radius.
export function tslBoomRing(): TslMaterial {
  const uCol = uniform(new THREE.Color(0xffd982).convertSRGBToLinear());
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const r = positionLocal.xz.length();
  const vR = r.sub(0.6).div(0.4);
  const aFade = attribute("aFade", "float");
  mat.colorNode = uCol;
  mat.opacityNode = aFade.mul(vR.clamp(0, 1).mul(Math.PI).sin());
  mat.alphaTest = 0.004;
  return { material: mat as unknown as THREE.Material };
}

// ---------------------------------------------------------------------------
// fx.ts ThrowMarker dash: soft line, hard ends.
export function tslMarkerDash(): TslMaterial {
  const uCol = uniform(new THREE.Color(0xf2f0e4).convertSRGBToLinear());
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const aFade = attribute("aFade", "float");
  const across = uv().y.mul(2).sub(1).abs().oneMinus();
  mat.colorNode = uCol;
  mat.opacityNode = aFade.mul(across).mul(across);
  mat.alphaTest = 0.004;
  return { material: mat as unknown as THREE.Material };
}


/** Full QuadFamily (glow/smoke/decal) as TSL. Unlit, HDR-linear. */
export function tslQuadFamily(kind, u) {
  // Uniform bridge: same fields, TSL nodes instead of {value} holders.
  // NOTE: all three families (glow/smoke/decal) SHARE one FxUniforms
  // (WeaponFx.u) — the bridge may only be built ONCE, otherwise the
  // second call would see TSL nodes instead of numbers/colours. The marker guards it.
  let U: any = (u as any).__tslU;
  if (!U) {
    U = {
      uTime: uniform(u.uTime.value),
      uPx: uniform(u.uPx.value),
      uDt: uniform(u.uDt.value),
      uFogNear: uniform(u.uFogNear.value),
      uFogFar: uniform(u.uFogFar.value),
      uSunV: uniform(u.uSunV.value),
      uSunW: uniform(u.uSunW.value),
      uSunCol: uniform(u.uSunCol.value),
      uAmb: uniform(u.uAmb.value),
      uFogCol: uniform(u.uFogCol.value),
      uCamR: uniform(u.uCamR.value),
      uCamU: uniform(u.uCamU.value),
    };
    Object.assign(u, U, { __tslU: U });
  }

  const iP = attribute("iP", "vec4");
  const iV = attribute("iV", "vec4");
  const iS = attribute("iS", "vec4");
  const iC = attribute("iC", "vec4");
  const iM = attribute("iM", "vec4");
  const iX = attribute("iX", "vec4");

  // VARYINGS AS EXPRESSIONS. r187 no longer lets a Fn used as positionNode
  // carry varying writes into the fragment stage ("build before() nodes only in
  // the setup stage"), so the old `.assign()` pattern left every varying at its
  // initial value: the decal frag saw a constant uv, its `r > 1` discard then
  // swallowed the whole quad (invisible, or black where the blend still wrote),
  // and smoke sampled a single texel (the white squares). Everything the
  // fragment NEEDS is therefore an expression TSL emits itself.
  const c0 = positionLocal.xy;
  const modeV = iM.y;
  const ang0 = iM.z.add(iM.w.mul(U.uTime.sub(iP.w)));
  const ca0 = cos(ang0);
  const sa0 = sin(ang0);
  const rot0 = vec2(c0.x.mul(ca0).sub(c0.y.mul(sa0)), c0.x.mul(sa0).add(c0.y.mul(ca0)));
  /** BILL (0) and PLANE (>= 5) use the raw corner, the strip modes the remap. */
  const useCorner = modeV.lessThan(0.5).or(modeV.greaterThanEqual(4.5));

  const vUv = varying(useCorner.select(c0, vec2(c0.x.mul(0.5).add(0.5), c0.y)), "qUv");
  const vN = varying(useCorner.select(rot0, c0), "qN");
  const vC = varying(iC, "qC");
  const vA = varying(
    vec3(
      U.uTime.sub(iP.w).div(iV.w.max(0.0001)),
      tslHash11(iP.w.mul(7.31).add(iP.x.mul(12.9898).add(iM.x.mul(1.618)))),
      iM.x,
    ),
    "qA",
  );
  const vX = varying(vec4(0), "qX");
  const vW = varying(float(1), "qW");
  const vFog = varying(float(0), "qFog");

  const sideOf = (ax, toC, fallback) => {
    const cr = cross(ax, toC);
    const len = cr.length();
    const out = fallback.toVar();
    If(len.greaterThan(1e-4), () => {
      out.assign(cr.div(len));
    });
    return out;
  };

  /**
   * A decal record is ALWAYS PLANE (M.PLANE), so it gets its own single-purpose
   * position node instead of the five-branch mode dispatch. That dispatch is
   * what left the decal family dead on WEBGPU ONLY (instances spawned, nothing
   * rasterised, no compile error, no console warning) while the same mesh
   * rendered fine with the smoke material: a shared positionNode whose chain
   * ends in a branch the decal never takes. Standing alone also means the
   * depth-pull below is plain, unguarded plane maths.
   */
  const decalPositionNode = Fn(() => {
    const c = positionLocal.xy;
    const age = U.uTime.sub(iP.w);
    const size = mix(iS.x, iS.y, age.div(iV.w.max(0.0001)));
    const n = normalize(iV.xyz);
    // As in the GLSL ternary: choose the up vector, never normalize(0).
    const upv = abs(n.y).lessThan(0.99).select(vec3(0, 1, 0), vec3(1, 0, 0));
    const t1 = normalize(cross(n, upv));
    const t2 = cross(n, t1);
    const a = iM.z.add(iM.w.mul(age));
    const ca = cos(a);
    const sa = sin(a);
    const r = vec2(c.x.mul(ca).sub(c.y.mul(sa)), c.x.mul(sa).add(c.y.mul(ca)));
    const dc = cameraPosition.sub(iP.xyz).length();
    // OFFSET ALONG THE SURFACE NORMAL, NOT ALONG THE VIEW RAY.
    //
    // The decal is placed on the COLLIDER face, while the geometry you see is
    // drawn up to ~7 cm proud of it. It therefore has to move off the collider,
    // and the direction matters:
    //   view ray  -> camera-dependent: the same splat can end up in front of a
    //               crate standing between you and the wall it belongs to
    //               (the "decals bleed through props" report).
    //   normal    -> surface-dependent: it lands on the skin that belongs to
    //               THAT face and cannot cross anything else.
    // The record's view-ray budget (iX.x, 5 cm) is reused as extra normal lift,
    // so the decal clears the skin exactly as before — it just no longer moves
    // toward the camera.
    const lift = iX.z.add(iX.x).add(dc.mul(0.00045));
    const w2 = iP.xyz
      .add(n.mul(lift))
      .add(t1.mul(r.x).add(t2.mul(r.y)).mul(size).mul(0.5));
    return w2;
  });

  const positionNode = Fn(() => {
    const c = positionLocal.xy;
    const age = U.uTime.sub(iP.w);
    const life = iV.w;
    const k = age.div(life.max(0.0001));
    const mode = iM.y;
    const kk = k.toVar();
    If(iX.w.greaterThan(0), () => {
      kk.assign(float(1).sub(pow(max(float(1).sub(k), 0), iX.w)));
    });
    const size = mix(iS.x, iS.y, kk);
    const camR = U.uCamR;
    const camU = U.uCamU;
    const wp = iP.xyz.toVar();
    const alive = float(1).toVar();
    If(age.lessThan(0), () => {
      alive.assign(float(0));
    });
    If(age.greaterThanEqual(life), () => {
      alive.assign(float(0));
    });
    vW.assign(alive);
    vX.assign(vec4(0, 0, iX.z, 0));
    If(mode.lessThan(1.5), () => {
      const drag = iS.z;
      const e = exp(drag.mul(age).mul(-1));
      const f = age.toVar();
      If(drag.greaterThan(0.0001), () => {
        f.assign(float(1).sub(e).div(drag));
      });
      const p = iP.xyz.add(iV.xyz.mul(f));
      const py = p.y.sub(float(0.5).mul(iS.w).mul(age).mul(age));
      const p2 = vec3(p.x, py, p.z);
      If(mode.lessThan(0.5), () => {
        const a = iM.z.add(iM.w.mul(age));
        const ca = cos(a);
        const sa = sin(a);
        const r = vec2(c.x.mul(ca).sub(c.y.mul(sa)), c.x.mul(sa).add(c.y.mul(ca)));
        wp.assign(p2.add(camR.mul(r.x).add(camU.mul(r.y)).mul(size).mul(0.5)));
      }).Else(() => {
        const vel = iV.xyz.mul(e);
        const vely = vel.y.sub(iS.w.mul(age));
        const vel2 = vec3(vel.x, vely, vel.z);
        const sp = vel2.length();
        const axn = vel2.div(sp.max(0.0001));
        const toC = cameraPosition.sub(p2);
        const sd = sideOf(axn, toC, camR);
        const wdt = size.toVar();
        const wmin = toC.length().mul(U.uPx).mul(1.3);
        If(wdt.lessThan(wmin), () => {
          vW.assign(wdt.div(wmin).mul(alive));
          wdt.assign(wmin);
        });
        const len = wdt.add(sp.mul(iX.x));
        wp.assign(p2.add(axn.mul(c.x.mul(0.5).sub(0.5)).mul(len)).add(sd.mul(c.y).mul(wdt).mul(0.5)));
        vX.assign(vec4(len.div(wdt), wdt, iX.z, toC.length()));
      });
    })
      .ElseIf(mode.lessThan(2.5), () => {
        const ax = normalize(iV.xyz);
        const toC = cameraPosition.sub(iP.xyz);
        const sdisc = sideOf(ax, toC, camR);
        const w = size.mul(iX.y);
        wp.assign(iP.xyz.add(ax.mul(c.x.mul(0.5).add(0.5)).mul(size)).add(sdisc.mul(c.y).mul(w).mul(0.5)));
      })
      .ElseIf(mode.lessThan(4.5), () => {
        const dir0 = iV.xyz;
        const dist = dir0.length();
        const dir = dir0.div(max(dist, 0.00001));
        const h = dist.toVar();
        const t = float(0).toVar();
        If(mode.greaterThan(3.5), () => {
          const L = clamp(iX.x.mul(U.uDt).mul(1.1), iX.y, iX.y.mul(3.5));
          const run = age.mul(iX.x);
          h.assign(min(run, dist));
          t.assign(clamp(run.sub(L), 0, dist));
        });
        const mid = iP.xyz.add(dir.mul(mix(t, h, c.x.mul(0.5).add(0.5))));
        const toC = cameraPosition.sub(mid);
        const sdisc = sideOf(dir, toC, camR);
        const w = size.toVar();
        const dc = toC.length();
        const wmin2 = dc.mul(U.uPx).mul(2);
        If(w.lessThan(wmin2), () => {
          vW.assign(w.div(wmin2).mul(alive));
          w.assign(wmin2);
        });
        wp.assign(mid.add(sdisc.mul(c.y).mul(w).mul(0.5)));
        vX.assign(vec4(h.sub(t), w, iX.z, dc));
      })
      .Else(() => {
        const n = normalize(iV.xyz);
        // GLSL chooses the up vector per ternary; doing normalize(0) first (and
        // fixing it in an If afterwards) leaves a NaN in the graph for
        // floor/ceiling decals — select() never forms it.
        const upv = abs(n.y).lessThan(0.99).select(vec3(0, 1, 0), vec3(1, 0, 0));
        const t1 = normalize(cross(n, upv));
        const t2 = cross(n, t1);
        const a = iM.z.add(iM.w.mul(age));
        const ca = cos(a);
        const sa = sin(a);
        const r = vec2(c.x.mul(ca).sub(c.y.mul(sa)), c.x.mul(sa).add(c.y.mul(ca)));
        const dc = cameraPosition.sub(iP.xyz).length();
        const w2 = iP.xyz
          .add(n.mul(iX.z.add(dc.mul(0.00045))))
          .add(t1.mul(r.x).add(t2.mul(r.y)).mul(size).mul(0.5));
        const tv = w2.sub(cameraPosition);
        const tl = tv.length();
        wp.assign(cameraPosition.add(tv.mul(max(float(0.05), float(1).sub(iX.x.add(dc.mul(0.002))).div(max(tl, 0.001))))));
        vX.assign(vec4(n, 0));
      });
    If(mode.lessThan(1.5), () => {
      If(iX.y.greaterThan(0), () => {
        const tv = wp.sub(cameraPosition);
        const tl = tv.length();
        wp.assign(cameraPosition.add(tv.mul(max(float(0.1), float(1).sub(iX.y.div(max(tl, 0.0001)))))));
      });
    });
    const mvZ = cameraViewMatrix.mul(vec4(wp, float(1))).z;
    vFog.assign(tslSS(U.uFogNear, U.uFogFar, mvZ.mul(-1)));
    If(alive.lessThan(0.5), () => {
      wp.assign(iP.xyz);
      vW.assign(float(0));
    });
    return wp;
  });

  // FRAG per family (1:1 ports of the GLSL fragment shaders) + material.
  // colorNode/opacityNode = o.rgb/o.a; discard rules live in the fns.
  // (Glow carries coverage in RGB, alpha is incidental; decal does not use alpha at
  // all — blending DstColor/SrcColor with zero/one alpha.)
  const frag = kind === "glow" ? tslGlowFrag({ vUv, vN, vC, vA, vX, vW, vFog }, U) : kind === "smoke" ? tslSmokeFrag({ vUv, vN, vC, vA, vX, vW, vFog }, U) : tslDecalFrag({ vUv, vN, vC, vA, vX, vW, vFog });
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    // As in the GLSL material: a decal is a MULTIPLIER on the surface, so it
    // must not be tone-mapped (ACES would bend the modulate value).
    toneMapped: kind !== "decal",
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    ...(kind === "decal"
      ? {
          // MODULATE: dst * src, one pass. The GLSL path uses DstColor/SrcColor
          // (dst*src + src*dst); the WebGPU backend drops a draw that carries
          // DstColor as a blend factor (no error, the mesh simply never
          // appears), so the equivalent Zero/SrcColor pair is used here and the
          // fragment emits the multiplier itself (tslDecalFrag).
          blendSrc: THREE.ZeroFactor,
          blendDst: THREE.SrcColorFactor,
          blendSrcAlpha: THREE.ZeroFactor,
          blendDstAlpha: THREE.OneFactor,
          // ZERO-FLICKER, second half (the record's view-ray pull above is the
          // first): a bias toward the camera, exactly as the GLSL material asks
          // for. three negates it under reversed depth, so both depth modes agree.
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        }
      : {
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
          blendSrcAlpha: THREE.OneFactor,
          blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        }),
  });
  (mat as unknown as { positionNode: unknown }).positionNode = (kind === "decal" ? decalPositionNode : positionNode)();
  (mat as unknown as { colorNode: unknown }).colorNode = (frag as unknown as { rgb: unknown }).rgb;
  (mat as unknown as { opacityNode: unknown }).opacityNode = (frag as unknown as { a: unknown }).a;
  return { material: mat as unknown as THREE.Material };
}



// ---------------------------------------------------------------------------
// GLOW-FRAG port (1:1 from gpu.ts): 6 shapes, o.a mostly 0 (rgb carries everything),
// blending One/OneMinusSrcAlpha. Fog + guards + discard as in GLSL.
function tslGlowFrag(V, U) {
  return Fn(() => {
    const k = V.vA.x;
    const seed = V.vA.y;
    const shape = V.vA.z;
    const o = vec4(0).toVar();
    If(shape.lessThan(0.5), () => {
      // shape 0: soft hot glow
      const g = max(exp(dot(V.vUv, V.vUv).mul(-4.5)).sub(0.011), 0);
      const f = float(1).sub(k);
      const ff = f.mul(f);
      o.assign(vec4(V.vC.rgb.mul(g).mul(ff).mul(V.vC.a), 0));
    }).ElseIf(shape.lessThan(1.5), () => {
      // shape 1: velocity-stretched spark
      const dd = tslCapsule(V.vUv, V.vX.x);
      const cov = tslSS(0.05, -0.3, dd);
      const along = float(0.2).add(float(0.8).mul(V.vUv.x));
      const heat = float(1).sub(k);
      const col = mix(vec3(2.4, 0.55, 0.07), vec3(5.2, 3.1, 1.05), heat.mul(heat).mul(along));
      const f = float(1).sub(tslSS(0.6, 1.0, k));
      o.assign(vec4(col.mul(V.vC.rgb).mul(cov).mul(along).mul(f).mul(V.vW).mul(V.vC.a), 0));
    }).ElseIf(shape.lessThan(2.5), () => {
      // shape 2: TRACER
      const L = max(V.vX.x, 1e-3);
      const W = max(V.vX.y, 1e-3);
      const coreF = max(V.vX.z, 1e-3);
      const x = clamp(V.vUv.x, 0, 1);
      const y = V.vUv.y;
      const hd = float(1).sub(x).mul(L);
      const along = pow(max(x, 0), 1.7).mul(tslSS(0, min(0.05, L.mul(0.3)), hd.add(0.004)));
      const core = exp(y.mul(y).div(coreF.mul(coreF)).mul(-1.6));
      const glow = exp(y.mul(y).mul(-4)).mul(0.55).add(exp(y.mul(y).mul(-14)).mul(0.45));
      const bead = exp(hd.mul(hd).div(W.mul(W).mul(1.5)).mul(-1)).mul(exp(y.mul(y).mul(-6)));
      const col = vec3(7, 5.6, 3.6).mul(core).add(vec3(2.1, 0.78, 0.16).mul(glow)).add(vec3(4, 3, 1.6).mul(bead));
      const near = tslSS(0.12, 0.6, V.vX.w);
      o.assign(vec4(col.mul(V.vC.rgb).mul(along).mul(V.vW).mul(V.vC.a).mul(near).mul(float(1).sub(V.vFog.mul(0.85))), 0));
    }).ElseIf(shape.lessThan(3.5), () => {
      // shape 3: muzzle/impact flash core
      const r = V.vUv.length();
      const th = atan(V.vUv.y, V.vUv.x.add(1e-5));
      const n = tslVnoise(vec2(th.mul(2.2).add(seed.mul(13)), seed.mul(7).add(k.mul(3))));
      const prong = pow(abs(cos(th.mul(2).add(seed.mul(6.283)))), 10).mul(0.32).add(pow(abs(cos(th.mul(3).add(seed.mul(3.1)))), 14).mul(0.18));
      const rad = float(0.42).add(float(0.22).mul(n)).add(prong);
      const e = r.div(rad);
      const a = exp(e.mul(e).mul(-2.8));
      const col = mix(vec3(1.7, 0.6, 0.1), vec3(4.6, 3.6, 2), exp(e.mul(e).mul(-6)));
      const col2 = mix(col, vec3(8, 7.4, 6.2), exp(e.mul(e).mul(-22)));
      const f = float(1).sub(tslSS(0.35, 1.0, k));
      o.assign(vec4(col2.mul(V.vC.rgb).mul(a).mul(f).mul(V.vC.a), a.mul(f).mul(0.12).mul(V.vC.a)));
    }).ElseIf(shape.lessThan(4.5), () => {
      // shape 4: flame tongue
      const x = clamp(V.vUv.x, 0, 1);
      const y = V.vUv.y;
      const n = tslVnoise(vec2(x.mul(5).add(seed.mul(20)), y.mul(1.7).add(seed.mul(7))));
      const hw = pow(max(x, 0), 0.35).mul(pow(max(float(1).sub(x), 0), 0.9)).mul(1.9).mul(float(0.72).add(float(0.5).mul(n)));
      const cov = tslSS(hw, hw.mul(0.35), abs(y)).mul(tslSS(0, 0.06, x));
      const T = float(1).sub(x.mul(0.95)).mul(float(1).sub(float(0.6).mul(abs(y)).div(max(hw, 1e-3))));
      const col = mix(vec3(1.3, 0.3, 0.04), vec3(3.4, 2, 0.55), tslSS(0.1, 0.45, T));
      const col2 = mix(col, vec3(7, 6.2, 4.6), tslSS(0.6, 0.92, T));
      const f = float(1).sub(tslSS(0.45, 1.0, k));
      o.assign(vec4(col2.mul(V.vC.rgb).mul(cov).mul(f).mul(V.vC.a), cov.mul(f).mul(0.2).mul(V.vC.a)));
    }).Else(() => {
      // shape 5: 4-point glint
      const p = vec2(abs(V.vUv.x), abs(V.vUv.y));
      const g = exp(p.x.mul(-18)).mul(exp(p.y.mul(-2.4))).add(exp(p.y.mul(-18)).mul(exp(p.x.mul(-2.4)))).add(exp(dot(p, p).mul(-22)).mul(1.5));
      const f = sin(float(3.14159).mul(sqrt(max(k, 0))));
      o.assign(vec4(V.vC.rgb.mul(g).mul(f).mul(V.vC.a), 0));
    });
    // Fog + guards + discard as in GLSL.
    o.assign(vec4(o.rgb.mul(float(1).sub(V.vFog.mul(0.7))), o.a));
    o.assign(vec4(min(max(o.rgb, vec3(0, 0, 0)), vec3(60000, 60000, 60000)), min(max(o.a, 0), 1)));
    If(o.a.lessThanEqual(0), () => {
      If(o.rgb.dot(vec3(1, 1, 1)).lessThanEqual(0.0004), () => {
        float(1).equal(1).discard();
      });
    });
    return o;
  })();
}

// ---------------------------------------------------------------------------
// SMOKE-FRAG port (1:1 from gpu.ts): DUST/MIST, GRIT/DROP, TRAIL.
// o = vec4(lit*a, a) — premultiplied-like, blending One/OneMinusSrcAlpha.
function tslSmokeFrag(V, U) {
  return Fn(() => {
    const k = V.vA.x;
    const seed = V.vA.y;
    const shape = V.vA.z;
    const sunK = float(1).sub(clamp(V.vX.z, 0, 1));
    const o = vec4(0).toVar();
    If(shape.lessThan(0.5), () => {
      // shapes 0/2 share the body (DUST vs MIST only in the light).
      // (Branch below on shape==2.)
      const q = V.vUv;
      const r = q.length();
      r.greaterThan(1).discard();
      const sp = q.mul(1.35).add(seed.mul(23)).add(vec2(0, k.mul(0.6)));
      const n = tslFbm(sp.mul(1.6));
      const edge = float(0.74).add(float(0.22).mul(tslRingNoise(q, 2.6, seed.mul(11))));
      const F = r.div(edge);
      const er = tslSS(0.15, 1.0, k);
      const body = tslSS(1.0, 0.32, F.add(er.mul(float(0.25).add(float(0.9).mul(float(1).sub(n))))));
      const cov = body.mul(float(0.55).add(float(0.45).mul(n)));
      cov.lessThanEqual(0.002).discard();
      const nrm = normalize(vec3(V.vN.x.mul(0.9).add(n.sub(0.5).mul(0.6)), V.vN.y.mul(0.9).add(n.sub(0.5).mul(0.6)), sqrt(max(float(1).sub(dot(V.vN, V.vN).mul(0.8)), 0.05))));
      const dif = clamp(dot(nrm, U.uSunV).mul(0.55).add(0.45), 0, 1);
      const lit = vec3(0, 0, 0).toVar();
      If(shape.lessThan(0.5), () => {
        lit.assign(V.vC.rgb.mul(U.uAmb.mul(float(0.85).add(float(0.25).mul(nrm.y))).add(U.uSunCol.mul(dif).mul(sunK))));
      }).Else(() => {
        lit.assign(V.vC.rgb.mul(U.uAmb.mul(0.9).add(U.uSunCol.mul(dif).mul(0.6).mul(sunK))));
      });
      const a = cov.mul(V.vC.a).mul(tslSS(0, 0.04, k));
      lit.assign(mix(lit, U.uFogCol, V.vFog));
      o.assign(vec4(lit.r, lit.g, lit.b, a));
    }).ElseIf(shape.lessThan(1.5), () => {
      // shape 1: GRIT
      const dd = tslCapsule(V.vUv, V.vX.x);
      const cov = tslSS(0, -0.25, dd);
      const lit = V.vC.rgb.mul(U.uAmb.add(U.uSunCol.mul(0.8).mul(sunK)));
      const a = cov.mul(V.vC.a).mul(float(1).sub(tslSS(0.7, 1.0, k))).mul(V.vW);
      o.assign(vec4(mix(lit, U.uFogCol, V.vFog).mul(a), a));
    }).ElseIf(shape.lessThan(2.5), () => {
      // shape 2: MIST (like DUST, darker/denser, barely any sun)
      const q = V.vUv;
      const r = q.length();
      r.greaterThan(1).discard();
      const sp = q.mul(1.35).add(seed.mul(23)).add(vec2(0, k.mul(0.6)));
      const n = tslFbm(sp.mul(1.6));
      const edge = float(0.74).add(float(0.22).mul(tslRingNoise(q, 2.6, seed.mul(11))));
      const F = r.div(edge);
      const er = tslSS(0.15, 1.0, k);
      const body = tslSS(1.0, 0.32, F.add(er.mul(float(0.25).add(float(0.9).mul(float(1).sub(n))))));
      const cov = body.mul(float(0.55).add(float(0.45).mul(n)));
      cov.lessThanEqual(0.002).discard();
      const nrm = normalize(vec3(V.vN.x.mul(0.9).add(n.sub(0.5).mul(0.6)), V.vN.y.mul(0.9).add(n.sub(0.5).mul(0.6)), sqrt(max(float(1).sub(dot(V.vN, V.vN).mul(0.8)), 0.05))));
      const dif = clamp(dot(nrm, U.uSunV).mul(0.55).add(0.45), 0, 1);
      const lit = V.vC.rgb.mul(U.uAmb.mul(0.9).add(U.uSunCol.mul(dif).mul(0.6).mul(sunK)));
      const a = cov.mul(V.vC.a).mul(tslSS(0, 0.04, k));
      const lm = mix(lit, U.uFogCol, V.vFog);
      o.assign(vec4(lm.r, lm.g, lm.b, a));
    }).ElseIf(shape.lessThan(3.5), () => {
      // shape 3: TRAIL
      const y = V.vUv.y;
      const n = tslFbm(vec2(V.vUv.x.mul(V.vX.x).mul(0.9).add(seed.mul(17)), y.mul(0.8).add(k.mul(1.5)).add(seed.mul(3))));
      const body = exp(y.mul(y).mul(-3.2)).mul(float(0.45).add(float(0.75).mul(n)));
      const ends = tslSS(0, 0.03, V.vUv.x).mul(tslSS(1.0, 0.985, V.vUv.x));
      const a = body.mul(ends).mul(V.vC.a).mul(pow(max(float(1).sub(k), 0), 1.6)).mul(V.vW);
      const lit = V.vC.rgb.mul(U.uAmb.add(U.uSunCol.mul(0.6).mul(sunK)));
      o.assign(vec4(mix(lit, U.uFogCol, V.vFog).mul(a), a));
    }).Else(() => {
      // shape 4: DROP (blood drops)
      const dd = tslCapsule(V.vUv, V.vX.x);
      const cov = tslSS(0, -0.25, dd);
      const lit = V.vC.rgb.mul(U.uAmb.mul(0.8).add(U.uSunCol.mul(0.3).mul(sunK))).add(vec3(0.06, 0.03, 0.03).mul(tslSS(0.2, 0.7, V.vUv.y)));
      const a = cov.mul(V.vC.a).mul(float(1).sub(tslSS(0.7, 1.0, k))).mul(V.vW);
      o.assign(vec4(mix(lit, U.uFogCol, V.vFog).mul(a), a));
    });
    // Guards + discard as in GLSL (a <= 0.002 discards).
    o.assign(vec4(min(max(o.rgb, vec3(0, 0, 0)), vec3(60000, 60000, 60000)), min(max(o.a, 0), 1)));
    o.a.lessThanEqual(0.002).discard();
    return o;
  })();
}

// ---------------------------------------------------------------------------
// DECAL-FRAG port (1:1 from gpu.ts): MODULATE 2x — out 0.5 = untouched.
// Output vec4(m*0.5, 1); alpha is ignored by the blending (zero/one).
// step() is backend-ambiguous (WebGL/WebGPU swap the args!) —
// hence overall ss-like steps (deviation < 1e-3, invisible).
function tslDecalFrag(V) {
  return Fn(() => {
    const k = V.vA.x;
    const seed = V.vA.y;
    const shape = V.vA.z;
    // A decal always lies in its quad: the corner comes straight from the uv
    // attribute (0..1 -> -1..1). Reading a varying here was the bug: r187 does
    // not carry varying writes out of positionNode, so q was constant and every
    // decal discarded itself.
    const q = uv().mul(2).sub(1);
    const r = q.length();
    r.greaterThan(1).discard();
    const th = atan(q.y, q.x.add(1e-5));
    const wob = tslRingNoise(q, 3.0, seed.mul(17));
    const fine = tslVnoise(q.mul(11).add(seed.mul(31)));
    const F = float(1).toVar();
    const a = float(0).toVar();
    If(shape.lessThan(0.5), () => {
      // METAL
      const hole = tslSS(0.21, 0.15, r.sub(float(0.03).mul(wob)));
      const lip = tslSS(0.34, 0.24, r.sub(float(0.04).mul(wob)));
      const bare = tslSS(0.5, 0.3, r.add(wob.sub(0.5).mul(0.22)).add(fine.sub(0.5).mul(0.12))).mul(float(1).sub(lip));
      const soot = tslSS(0.95, 0.35, r.add(wob.sub(0.5).mul(0.3))).mul(0.55);
      F.assign(mix(1.0, 0.72, soot));
      F.assign(mix(F, 1.7, bare.mul(0.85)));
      F.assign(mix(F, 0.42, lip));
      F.assign(mix(F, 0.04, hole));
      a.assign(max(max(soot, bare), lip));
    }).ElseIf(shape.lessThan(1.5), () => {
      // STONE/CONCRETE
      const crater = tslSS(0.42, 0.32, r.sub(float(0.14).mul(wob.sub(0.4))).sub(float(0.05).mul(fine.sub(0.5))));
      const pit = tslSS(0.2, 0.13, r.sub(float(0.04).mul(wob)));
      const powder = tslSS(0.92, 0.38, r.add(wob.sub(0.5).mul(0.4)).add(fine.sub(0.5).mul(0.18)));
      const sec = float(6.2831853).div(5);
      const i = floor(th.div(sec).add(0.5));
      const jit = tslH11(i.add(seed.mul(50))).sub(0.5).mul(0.7);
      const d = abs(th.sub(i.add(jit).mul(sec)));
      const crackLen = float(0.45).add(float(0.45).mul(tslH11(i.mul(3.1).add(seed.mul(13)))));
      const crack = tslSS(0.035, 0, d.mul(r)).mul(tslSS(0.199, 0.201, r)).mul(tslSS(crackLen, crackLen.mul(0.7), r));
      F.assign(mix(1.0, 1.32, powder.mul(0.8)));
      F.assign(mix(F, 0.55, crack.mul(0.7)));
      F.assign(mix(F, float(0.5).add(float(0.12).mul(fine)), crater));
      F.assign(mix(F, 0.06, pit));
      a.assign(max(max(powder.mul(0.8), crater), max(pit, crack)));
    }).ElseIf(shape.lessThan(2.5), () => {
      // WOOD
      const sec = float(6.2831853).div(8);
      const i = floor(th.div(sec).add(0.5));
      const jit = tslH11(i.add(seed.mul(50))).sub(0.5).mul(0.5);
      const d = abs(th.sub(i.add(jit).mul(sec))).div(sec.mul(0.5));
      const len = float(0.35).add(float(0.5).mul(tslH11(i.mul(3.1).add(seed.mul(13)))));
      const ray = tslSS(0.02, -0.02, r.sub(float(0.16).add(len.sub(0.16).mul(pow(max(float(1).sub(d), 0), 3)))));
      const hole = tslSS(0.17, 0.12, r.sub(float(0.04).mul(wob)));
      const soot = tslSS(0.7, 0.2, r).mul(0.35);
      F.assign(mix(1.0, 0.75, soot));
      F.assign(mix(F, 1.45, ray.mul(0.9)));
      F.assign(mix(F, 0.05, hole));
      a.assign(max(max(soot, ray), hole));
    }).ElseIf(shape.lessThan(3.5), () => {
      // DIRT/SAND
      const div = tslSS(0.75, 0.05, r.add(wob.sub(0.5).mul(0.35)));
      const crumbs = tslSS(0.719, 0.721, tslVnoise(q.mul(9).add(seed.mul(19)))).mul(tslSS(1.0, 0.45, r));
      F.assign(mix(1.0, 0.55, div));
      F.assign(mix(F, 0.62, crumbs.mul(0.8)));
      a.assign(max(div, crumbs.mul(0.8)));
    }).ElseIf(shape.lessThan(4.5), () => {
      // GLASS
      const sec = float(6.2831853).div(9);
      const i = floor(th.div(sec).add(0.5));
      const jit = tslH11(i.add(seed.mul(50))).sub(0.5).mul(0.5);
      const d = abs(th.sub(i.add(jit).mul(sec)));
      const len = float(0.5).add(float(0.45).mul(tslH11(i.mul(3.1).add(seed.mul(13)))));
      const line = tslSS(0.03, 0, d.mul(r)).mul(tslSS(r.sub(0.001), r.add(0.001), len));
      const ring = tslSS(0.02, 0, abs(r.sub(0.34).sub(float(0.06).mul(wob)))).mul(tslSS(0.449, 0.451, tslVnoise(vec2(th.mul(3), seed.mul(7)))));
      const frost = tslSS(0.3, 0.1, r).mul(0.6);
      const hole = tslSS(0.1, 0.06, r);
      F.assign(mix(1.0, 1.8, max(max(line, ring), frost)));
      F.assign(mix(F, 0.15, hole));
      a.assign(max(max(line, ring), max(frost, hole)));
    });
    // Every hole is a GREY multiplier; blood (shape 5) is the one TINTED decal:
    // vC.rgb is its per-channel multiplier, so it reads red on any wall. The
    // shape chain runs 0-4 only (GLSL: `if (shape == 5)` sits AFTER it), so the
    // glass branch above must not swallow 5 — it is bounded by shape < 4.5.
    const T = vec3(F).toVar();
    If(shape.greaterThan(4.5), () => {
      const blob = tslSS(0.6, 0.44, r.add(wob.sub(0.5).mul(0.55)).add(fine.sub(0.5).mul(0.16)));
      const core = tslSS(0.34, 0.16, r.add(wob.sub(0.5).mul(0.3)));
      const gq = q.mul(6).add(seed.mul(23));
      const cell = gq.floor();
      const hr = tslH11(cell.x.mul(7).add(cell.y.mul(13)).add(seed.mul(41)));
      const drop = tslSS(0.719, 0.721, hr).mul(tslSS(0.24, 0.12, gq.fract().sub(0.5).length())).mul(tslSS(1.0, 0.5, r));
      a.assign(max(max(blob, drop), core));
      T.assign(mix(V.vC.rgb, V.vC.rgb.mul(0.5), core));
    });
    const fade = float(1).sub(tslSS(0.82, 1.0, k)).mul(V.vC.a).mul(tslSS(0, 0.002, k));
    const m = mix(vec3(1), T, a.mul(fade)).toVar();
    m.assign(mix(m, vec3(1), V.vFog));
    // NaN firewall, exactly as GLSL (`!(x in [0,4]) -> 1`). min/max alone do NOT
    // clear a NaN on every backend, so both range checks go through select():
    // a NaN fails both comparisons and lands on the neutral 1.0.
    m.assign(m.greaterThanEqual(0).select(m, vec3(1)));
    m.assign(m.lessThanEqual(4).select(m, vec3(1)));
    m.sub(1).length().lessThan(0.006).discard();
    // MODULATE 1x: the material blends Zero/SrcColor (dst * src), so the
    // multiplier IS the output. The GLSL path emitted m*0.5 and blended
    // DstColor/SrcColor (dst*src + src*dst = 2*src*dst) — the same product,
    // but DstColor as a blend factor is what WebGPU drops here.
    return vec4(m, 1);
  })();
}
