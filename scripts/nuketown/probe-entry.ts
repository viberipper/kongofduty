/**
 * Nuketown balcony-vault verification probe (not shipped; runs bundled).
 *
 * Exercises, against the live sim built for the Nuketown process:
 *   1. import-time pins held (11 rails, graph built, no edge crosses rail steel)
 *   2. rail-crossing sweep over every nav-node pair (height-gated, LINK_R pad)
 *   3. height-gate + Minkowski-halo pins per promoted panel
 *   4. player jump-vault deck to outside lawn (walk/slide/crouch block, jump vaults)
 *   5. OOB clamp for bodies (sprint past the fence) and frags (deck launch)
 *   6. built-def cache identity + same-length-mutation rebuild
 *
 * Throws on the first violation; prints PASS lines otherwise.
 */
import { readFileSync } from "node:fs";
import {
  BOT_CLEAR_R,
  botGroundYDebug,
  botNavNodesDebug,
  botPathClearDebug,
  GameSession,
  movePlayer,
  navGraphDebug,
  navRouterReport,
  NADE_RADIUS,
  railSegHitsDebug,
  simMap,
  stepNadeBody,
} from "../../shared/sim";
import { TICK_DT } from "../../shared/protocol";
import { buildNuketown, NUKETOWN_AUDIT } from "../../shared/maps/nuketown";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`PASS ${name}${detail ? " " + detail : ""}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? " " + detail : ""}`);
  }
}

const MAP = simMap();
check("active map is nuketown", MAP.id === "nuketown", `got ${MAP.id}`);
check("11 promoted rails", NUKETOWN_AUDIT.railings === 11, `got ${NUKETOWN_AUDIT.railings}`);
check("solids count", MAP.solids.length === 1924, `got ${MAP.solids.length}`);

// --- 1. graph -------------------------------------------------------------
const report = navRouterReport();
console.log(
  `NAV nodes=${report.nodes} edges=${report.edges} components=${report.components} largest=${report.largestComponent} dense=${report.dense}`,
);
check("nav graph has edges", report.edges > 10, `edges=${report.edges}`);
const LINK_R = BOT_CLEAR_R + ((MAP.navLinkPad as number | undefined) ?? 0.15);
check("link corridor fits 1.10 m doors", LINK_R * 2 <= 1.1, `corridor=${(LINK_R * 2).toFixed(3)}`);
const g = navGraphDebug();
const nodes = botNavNodesDebug();
let edgeCross = 0;
for (let i = 0; i < g.off.length - 1; i++) {
  for (let e = g.off[i]!; e < g.off[i + 1]!; e++) {
    const j = g.to[e]!;
    if (j <= i) continue;
    const a = nodes[i]!;
    const b = nodes[j]!;
    if (railSegHitsDebug(a.x, a.z, b.x, b.z, a.y, b.y, LINK_R)) edgeCross += 1;
  }
}
check("no routed edge crosses rail steel", edgeCross === 0, `crossing=${edgeCross}`);

// --- 2. all-pairs rail sweep ------------------------------------------------
let pairs = 0;
let crossings = 0;
let band = 0;
let violations = 0;
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]!;
    const b = nodes[j]!;
    pairs += 1;
    // Mirror botPathClear's height tracking EXACTLY (0.25 m stride, fromY-limited
    // ground): the crossing predicate must see what the live probe sees. A
    // lawn→deck line samples low the whole way (the deck is invisible from
    // below by design) so it is NOT a rail crossing even though the endpoint
    // span touches the rail band — the storey router owns those, and the
    // probe must not second-guess it with endpoint heights.
    const sdx = b.x - a.x;
    const sdz = b.z - a.z;
    const sl = Math.hypot(sdx, sdz);
    const sn = Math.max(1, Math.min(40, Math.ceil(sl / 0.25)));
    let sy = a.y;
    let yLo = a.y;
    let yHi = a.y;
    for (let k = 1; k <= sn; k++) {
      const gg = botGroundYDebug(a.x + (sdx * k) / sn, a.z + (sdz * k) / sn, sy);
      if (gg < yLo) yLo = gg;
      if (gg > yHi) yHi = gg;
      sy = gg;
    }
    // botPathClearDebug enforces the crossing at its own query radius
    // (BOT_CLEAR_R); the sweep classifies with the same pad. The
    // (BOT_CLEAR_R, LINK_R] band is link-builder-only by design: the graph
    // rejects it, steering may pass it at body width under the standoff.
    if (railSegHitsDebug(a.x, a.z, b.x, b.z, yLo, yHi, BOT_CLEAR_R)) {
      crossings += 1;
      if (botPathClearDebug(a.x, a.z, b.x, b.z, a.y)) {
        violations += 1;
        if (violations <= 12) {
          console.log(
            `VIOLATION n${i}(${a.x.toFixed(2)},${a.y.toFixed(2)},${a.z.toFixed(2)}) -> n${j}(${b.x.toFixed(2)},${b.y.toFixed(2)},${b.z.toFixed(2)}) span=[${yLo.toFixed(2)},${yHi.toFixed(2)}]`,
          );
        }
      }
    } else if (railSegHitsDebug(a.x, a.z, b.x, b.z, yLo, yHi, LINK_R)) {
      band += 1;
    }
  }
}
console.log(
  `SWEEP pairs=${pairs} rail-crossings=${crossings} link-only-band=${band} pathClear-violations=${violations}`,
);
check("every rail-crossing pair reads blocked", violations === 0);

// --- 3. height gate + halo per panel ----------------------------------------
const rails = MAP.solids.filter((o) => (o as { railVault?: boolean }).railVault);
check("11 railVault solids in sim", rails.length === 11, `got ${rails.length}`);
for (const o of rails) {
  const bot = o.y - o.sy / 2;
  const tag = `rail@(${o.x.toFixed(1)},${o.z.toFixed(1)})`;
  // Diagonal through the centre, ground height: must MISS (height gate).
  const gnd = railSegHitsDebug(o.x - 2, o.z - 2, o.x + 2, o.z + 2, 0.11, 0.11, LINK_R);
  check(`${tag} ground edge gated out`, !gnd);
  // Same line at deck height: must HIT even with pad 0.
  const deck = railSegHitsDebug(o.x - 2, o.z - 2, o.x + 2, o.z + 2, bot, bot, 0);
  check(`${tag} deck edge hits pad-0`, deck);
  // Parallel offset 0.3 m at deck height: pad 0 misses (halo), LINK_R hits.
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  const tx = c;
  const tz = s;
  const nx = -s;
  const nz = c;
  const ax = o.x - tx * 1.2 + nx * 0.3;
  const az = o.z - tz * 1.2 + nz * 0.3;
  const bx = o.x + tx * 1.2 + nx * 0.3;
  const bz = o.z + tz * 1.2 + nz * 0.3;
  const halo0 = railSegHitsDebug(ax, az, bx, bz, bot, bot, 0);
  const haloR = railSegHitsDebug(ax, az, bx, bz, bot, bot, LINK_R);
  // Railing runs meet at corners: the offset-parallel of one panel can clip
  // its NEIGHBOUR at pad 0 (panel 702 grazes 701). That is geometry, not a
  // halo — skip the pad-0 pin where another panel touches the test segment.
  let neighbour = false;
  for (const q of rails) {
    if (q === o) continue;
    const wb = q.y - q.sy / 2;
    const wt = q.y + q.sy / 2;
    if (bot + 1.74 < wb + 0.05 || bot > wt - 0.02) continue;
    const c2 = Math.cos(-q.yaw);
    const s2 = Math.sin(-q.yaw);
    const lax = (ax - q.x) * c2 - (az - q.z) * s2;
    const laz = (ax - q.x) * s2 + (az - q.z) * c2;
    const lbx = (bx - q.x) * c2 - (bz - q.z) * s2;
    const lbz = (bx - q.x) * s2 + (bz - q.z) * c2;
    const hx = q.sx * 0.5;
    const hz = q.sz * 0.5;
    let tmin = 0;
    let tmax = 1;
    let miss = false;
    const ddx = lbx - lax;
    if (Math.abs(ddx) < 1e-9) {
      if (lax < -hx || lax > hx) miss = true;
    } else {
      let t1 = (-hx - lax) / ddx;
      let t2 = (hx - lax) / ddx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmax < tmin) miss = true;
    }
    if (!miss) {
      const ddz = lbz - laz;
      if (Math.abs(ddz) < 1e-9) {
        if (laz < -hz || laz > hz) miss = true;
      } else {
        let t1 = (-hz - laz) / ddz;
        let t2 = (hz - laz) / ddz;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmax < tmin) miss = true;
      }
    }
    if (!miss) {
      neighbour = true;
      break;
    }
  }
  if (neighbour) {
    console.log(`SKIP ${tag} halo pad-0 (neighbour panel touches the test segment)`);
  } else {
    check(`${tag} halo pad-0 misses`, !halo0);
  }
  check(`${tag} halo LINK_R hits`, haloR);
}

// --- 4. player rail vault: walk/slide/crouch BLOCK, jump VAULTS ---------------
// Jump-vault gate: a grounded body sprinting, sliding or crouching into a
// deck rail reads it as hard steel (resolveCircle + groundHeight snap both
// gated on airborne) — only a body airborne after a jump mantles over.
{
  const s = new GameSession();
  const p = s.addPlayer("vault", "t", "op", 0, "ar", "x", false);
  s.spawn(p);
  p.protect = 0;
  // Nearest promoted rail: walk straight at its centre.
  // NOTE: movePlayer steers by the BODY's yaw (p.yaw), not cmd.yaw.
  let ri = 0;
  let rd = 1e9;
  rails.forEach((o, i) => {
    const d = Math.hypot(o.x - -24.5, o.z - -8.0);
    if (d < rd) {
      rd = d;
      ri = i;
    }
  });
  const r = rails[ri]!;
  const railTop = r.y + r.sy / 2;
  const railBot = r.y - r.sy / 2;
  const dx = r.x - -24.5;
  const dz = r.z - -8.0;
  const dl = Math.hypot(dx, dz);
  const ux = dx / dl;
  const uz = dz / dl;
  const yaw = Math.atan2(ux, uz);
  const pastOf = (): number => (p.x - r.x) * ux + (p.z - r.z) * uz;
  const mkCmd = (t: number, jump: boolean, crouch: boolean): Parameters<typeof movePlayer>[1] => ({
    seq: t,
    dt: TICK_DT,
    ax: 0,
    az: 1,
    jump,
    crouch,
    sprint: true,
    tac: false,
    ads: false,
    yaw,
    pitch: 0,
    fire: false,
    reload: false,
    melee: false,
    weapon: p.weapon,
    clientTime: 0,
    ox: 0,
    oy: 0,
    oz: 0,
    dx: 0,
    dy: 0,
    dz: 0,
  });
  const resetRun = (sx: number, sz: number, sy: number): void => {
    p.x = sx;
    p.y = sy;
    p.z = sz;
    p.yaw = yaw;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.onGround = true;
    p.crouch = false;
    p.slide = 0;
  };
  // --- 4a. SPRINT into the rail, no jump: must block like a steel wall. ----
  resetRun(-24.5, -8.0, 3.05);
  let maxY = p.y;
  for (let t = 0; t < 64 * 5; t++) {
    movePlayer(p, mkCmd(t, false, false), TICK_DT);
    if (p.y > maxY) maxY = p.y;
  }
  {
    const past = pastOf();
    console.log(
      `WALK-BLOCK rail${ri} top=${railTop.toFixed(2)} maxY=${maxY.toFixed(2)} final=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) past=${past.toFixed(2)}`,
    );
    check("walk never mounts the rail", maxY < railTop - 0.3, `maxY=${maxY.toFixed(2)}`);
    check("walk never crosses the rail line", past < 0.05, `past=${past.toFixed(2)}`);
    check("walk stays on the deck", Math.abs(p.y - 3.05) < 0.15, `y=${p.y.toFixed(2)}`);
  }
  // --- 4b. SLIDE into the rail: sprint up, then slide — must also block. ---
  // Slide needs full sprint speed first (movePlayer gates on speed > 4.2).
  // Same known-good deck start as 4a (a clear sprint line to the rail face).
  resetRun(-24.5, -8.0, 3.05);
  maxY = p.y;
  for (let t = 0; t < 64 * 6; t++) {
    movePlayer(p, mkCmd(t, false, t >= 10), TICK_DT);
    if (p.y > maxY) maxY = p.y;
  }
  {
    const past = pastOf();
    console.log(
      `SLIDE-BLOCK rail${ri} top=${railTop.toFixed(2)} maxY=${maxY.toFixed(2)} final=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) past=${past.toFixed(2)} slid=${p.slide.toFixed(2)}`,
    );
    check("slide never mounts the rail", maxY < railTop - 0.3, `maxY=${maxY.toFixed(2)}`);
    check("slide never crosses the rail line", past < 0.15, `past=${past.toFixed(2)}`);
    check("slide stays on the deck", Math.abs(p.y - 3.05) < 0.15, `y=${p.y.toFixed(2)}`);
  }
  // --- 4b2. CROUCH-WALK into the rail: must block as well. ------------------
  resetRun(r.x - ux * 2.0, r.z - uz * 2.0, 3.05);
  maxY = p.y;
  for (let t = 0; t < 64 * 5; t++) {
    movePlayer(p, mkCmd(t, false, true), TICK_DT);
    if (p.y > maxY) maxY = p.y;
  }
  {
    const past = pastOf();
    console.log(
      `CROUCH-BLOCK rail${ri} top=${railTop.toFixed(2)} maxY=${maxY.toFixed(2)} final=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) past=${past.toFixed(2)}`,
    );
    check("crouch never mounts the rail", maxY < railTop - 0.3, `maxY=${maxY.toFixed(2)}`);
    check("crouch never crosses the rail line", past < 0.05, `past=${past.toFixed(2)}`);
  }
  // --- 4c. JUMP vault: sprint at the rail, jump once just before it. --------
  // Same known-good deck start as 4a (a clear sprint line to the rail face).
  resetRun(-24.5, -8.0, 3.05);
  maxY = p.y;
  let crossedWest = false;
  let jumped = false;
  const trail: string[] = [];
  for (let t = 0; t < 64 * 6; t++) {
    const pastNow = pastOf();
    // Jump once, ~0.8 m before the rail face: at sprint the body reaches the
    // panel rising (feet ~deck+0.6, inside the mantle window), never walking.
    const jump = !jumped && p.onGround && pastNow > -0.8;
    if (jump) jumped = true;
    movePlayer(p, mkCmd(t, jump, false), TICK_DT);
    if (p.y > maxY) maxY = p.y;
    if (pastOf() > 0.3 && p.y < 1.0) crossedWest = true;
    if (t % 32 === 0) trail.push(`t=${(t / 64).toFixed(1)}s (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) past=${pastOf().toFixed(1)}`);
  }
  console.log(`VAULT-TRAIL ${trail.join(" ")}`);
  {
    const past = pastOf();
    console.log(
      `VAULT rail${ri} top=${railTop.toFixed(2)} bot=${railBot.toFixed(2)} maxY=${maxY.toFixed(2)} final=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) past=${past.toFixed(2)} jumped=${jumped}`,
    );
    check("jump was taken", jumped);
    check("vault mounts the rail top", maxY >= railTop - 0.15, `maxY=${maxY.toFixed(2)}`);
    check("vault crosses to the outside at lawn height", crossedWest, `past=${past.toFixed(2)} y=${p.y.toFixed(2)}`);
    check("vault lands off the deck", p.y < 1.0, `y=${p.y.toFixed(2)}`);
    check("vault stays in bounds", p.x >= -48.9 + 0.3 && p.x <= 46.48 - 0.3, `x=${p.x.toFixed(2)}`);
  }
}

// --- 5a. OOB bodies ----------------------------------------------------------
{
  const s = new GameSession();
  const p = s.addPlayer("oob", "t", "op", 0, "ar", "x", false);
  s.spawn(p);
  p.protect = 0;
  p.x = 45.0;
  p.y = 5;
  p.z = 0;
  p.yaw = Math.atan2(1, 0);
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  const yaw = Math.atan2(1, 0);
  for (let t = 0; t < 64 * 3; t++) {
    movePlayer(
      p,
      {
        seq: t,
        dt: TICK_DT,
        ax: 0,
        az: 1,
        jump: false,
        crouch: false,
        sprint: true,
        tac: false,
        ads: false,
        yaw,
        pitch: 0,
        fire: false,
        reload: false,
        melee: false,
        weapon: p.weapon,
        clientTime: 0,
        ox: 0,
        oy: 0,
        oz: 0,
        dx: 0,
        dy: 0,
        dz: 0,
      },
      TICK_DT,
    );
  }
  console.log(`OOB-BODY final=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) vx=${p.vx.toFixed(2)}`);
  check("body clamped in bounds", p.x <= 46.48 - 0.3 + 1e-9, `x=${p.x.toFixed(3)}`);
  check("body has ground", p.y >= -0.01 && p.onGround, `y=${p.y.toFixed(2)} onGround=${p.onGround}`);
}

// --- 5b. OOB frags -----------------------------------------------------------
{
  const b = { x: -24, y: 6, z: -8, vx: 30, vy: 4, vz: 0, grounded: false, asleep: false };
  for (let t = 0; t < 64 * 5 && !b.asleep; t++) stepNadeBody(b, TICK_DT);
  console.log(`OOB-NADE rest=(${b.x.toFixed(2)},${b.y.toFixed(2)},${b.z.toFixed(2)})`);
  check(
    "frag rests in bounds",
    b.x >= -48.9 + NADE_RADIUS - 1e-6 &&
      b.x <= 46.48 - NADE_RADIUS + 1e-6 &&
      b.z >= -25.61 + NADE_RADIUS - 1e-6 &&
      b.z <= 16.74 - NADE_RADIUS + 1e-6,
    `(${b.x.toFixed(2)},${b.z.toFixed(2)})`,
  );
  // Backstop path: a frag that somehow starts outside the fence (teleported
  // scenery, never gameplay — the 56-rect fence owns the real exits) is
  // fenced back inside on the next step instead of detonating in the void.
  const oob = { x: -60, y: 5, z: 0, vx: -5, vy: 0, vz: 0, grounded: false, asleep: false };
  stepNadeBody(oob, TICK_DT);
  check("backstop fences an outside frag inside", oob.x >= -48.9 + NADE_RADIUS - 1e-9, `x=${oob.x.toFixed(3)}`);
  check("backstop kills outward velocity", oob.vx >= 0, `vx=${oob.vx.toFixed(3)}`);
}

// --- 6. cache identity + mutation rebuild ------------------------------------
{
  const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const d1 = buildNuketown(raw);
  const d2 = buildNuketown(raw);
  check("cache hits identical def", d1 === d2);
  raw.solids[0] = { ...raw.solids[0], color: "#000000" };
  const d3 = buildNuketown(raw);
  check("same-length in-place mutation rebuilds", d3 !== d1);
  check("rebuild sees the mutation", d3.solids[0].color === "#000000");
  check("old def unmutated", d1.solids[0].color !== "#000000");
}

if (failures > 0) {
  console.error(`PROBE FAILURES: ${failures}`);
  process.exit(1);
}
console.log("PROBE OK");
