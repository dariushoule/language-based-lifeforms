// Draws the garden's plants from their genomes. Each plant is a set of strands (chains of segments,
// possibly branching off other strands) plus decorations along them: leaves, flowers, glowing dots,
// plumes, caps and lily pads. The shape is built once per genome; every frame it is posed (grown out
// from the root joint by joint, swaying, leaning with the wind, drooping as it withers) and drawn
// into the plant's Graphics, with its flowers as far open as they are and turned toward the moon.
import { rng } from '../shared/flora.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Linear blend of two 0xRRGGBB colors.
export const mix = (a, b, t) => {
  const ch = (sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

// ---------- shapes ----------

function strand(parent, at, angle, n, len, w0, w1, bend = () => 0, flex = 1) {
  const segs = [];
  for (let i = 0; i < n; i++) segs.push({ l: len(i), w: w0 + (w1 - w0) * (i / Math.max(1, n - 1)), bend: bend(i) });
  return { parent, at, angle, segs, flex, phase: 0 };
}
const UP = -Math.PI / 2;

const BUILD = {
  // Arching stems with bells hanging from their tips.
  bell(g, r, s) {
    const stems = Math.min(4, g.stems);
    for (let k = 0; k < stems; k++) {
      const side = stems === 1 ? (g.curl < 0 ? -1 : 1) : k % 2 ? 1 : -1;
      const n = 9, h = g.height * (0.75 + r() * 0.35);
      const st = strand(null, 0, UP + side * (0.1 + 0.25 * g.spread * r()), n, () => (h * 1.2) / n, 2.4 * g.thickness, 1,
        (i) => (i < 5 ? side * 0.03 : side * (0.26 + 0.1 * g.spread)), 1);
      st.x = (k - (stems - 1) / 2) * 6;
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: 1, kind: 'leaf', side: -side, size: 16 }, { s: si, i: 2, kind: 'leaf', side, size: 13 });
      for (const i of [n, n - 2, n - 4].slice(0, 2 + (r() < 0.5))) s.decor.push({ s: si, i, kind: 'flower', hang: true, size: 7.5 + r() * 2, cup: 0.75 });
    }
  },
  // Upright stems, each with one open-faced flower.
  star(g, r, s) {
    const stems = Math.min(5, g.stems);
    for (let k = 0; k < stems; k++) {
      const n = 6, h = g.height * (0.6 + r() * 0.4);
      const st = strand(null, 0, UP + (k - (stems - 1) / 2) * 0.22 * g.spread + (r() - 0.5) * 0.1, n, () => h / n, 1.9 * g.thickness, 0.9,
        () => (r() - 0.5) * 0.08 + g.curl * 0.02, 0.9);
      st.x = (k - (stems - 1) / 2) * 5;
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: 2, kind: 'leaf', side: k % 2 ? 1 : -1, size: 11 }, { s: si, i: 3, kind: 'leaf', side: k % 2 ? -1 : 1, size: 9 });
      s.decor.push({ s: si, i: n, kind: 'flower', size: 9 + r() * 3, cup: g.cup * 0.35 });
    }
  },
  // A few stout stems with great trumpets that follow the moon.
  trumpet(g, r, s) {
    const stems = Math.min(3, Math.ceil(g.stems / 2));
    for (let k = 0; k < stems; k++) {
      const n = 7, h = g.height * (0.7 + r() * 0.3);
      const st = strand(null, 0, UP + (k - (stems - 1) / 2) * 0.4 * g.spread, n, () => h / n, 3 * g.thickness, 1.4, () => (r() - 0.5) * 0.07 + g.curl * 0.025, 0.7);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      for (const i of [1, 2, 4]) s.decor.push({ s: si, i, kind: 'leaf', side: i % 2 ? 1 : -1, size: 20 - i * 2, wide: true });
      s.decor.push({ s: si, i: n, kind: 'flower', size: 13 + r() * 3, cup: 0.45 + 0.4 * g.cup, track: 1 });
    }
  },
  // A tall spike with florets up its length, opening from the bottom.
  spire(g, r, s) {
    const stems = Math.min(2, Math.ceil(g.stems / 3));
    for (let k = 0; k < stems; k++) {
      const n = 12, h = g.height * (k ? 0.7 : 1);
      const st = strand(null, 0, UP + (k ? 0.22 * (g.curl < 0 ? -1 : 1) : 0), n, () => h / n, 2.6 * g.thickness, 0.8, () => (r() - 0.5) * 0.03 + g.curl * 0.008, 0.6);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      for (const i of [1, 1, 2, 3]) s.decor.push({ s: si, i, kind: 'leaf', side: r() < 0.5 ? 1 : -1, size: 17 - i * 2 });
      for (let i = 4; i <= n; i++) s.decor.push({ s: si, i, kind: 'flower', size: 5.6 - (i - 4) * 0.28, cup: 0.6, turn: (i % 2 ? 1 : -1) * 1.15, petals: 4, minor: i % 3 !== 0 });
    }
  },
  // A stem that breaks into an umbrella of tiny florets.
  umbel(g, r, s) {
    const stems = Math.min(3, Math.ceil(g.stems / 2));
    for (let k = 0; k < stems; k++) {
      const n = 6, h = g.height * (0.65 + r() * 0.35);
      const st = strand(null, 0, UP + (k - (stems - 1) / 2) * 0.35 * g.spread, n, () => (h * 0.86) / n, 1.9 * g.thickness, 1.1, () => (r() - 0.5) * 0.06, 0.8);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: 1, kind: 'leaf', side: 1, size: 13, feather: true }, { s: si, i: 2, kind: 'leaf', side: -1, size: 12, feather: true });
      const rays = 5 + Math.floor(r() * 4);
      for (let j = 0; j < rays; j++) {
        const ray = strand(si, n, (j / (rays - 1) - 0.5) * (1.5 + 0.5 * g.spread), 2, () => h * 0.085, 0.9, 0.7, () => 0, 0.6);
        const ri = s.strands.push(ray) - 1;
        s.decor.push({ s: ri, i: 2, kind: 'flower', size: 3.6, cup: 0.1, petals: 5, minor: j % 2 === 1 });
      }
    }
  },
  // Fronds that arch outward and curl at the tip, with glowing spore-dots.
  fern(g, r, s) {
    const fronds = 2 + Math.floor(g.stems / 2);
    for (let k = 0; k < fronds; k++) {
      const side = (k - (fronds - 1) / 2) / Math.max(1, (fronds - 1) / 2);
      const n = 10, h = g.height * (0.7 + r() * 0.3);
      const st = strand(null, 0, UP + side * 0.5 * (0.5 + g.spread), n, (i) => (h / 8.6) * (i < 8 ? 1 : 0.45), 2.2 * g.thickness, 0.8,
        (i) => (i < 8 ? side * 0.07 : 0.55 * (side || 1)), 0.9);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      for (let i = 2; i < 9; i++) {
        s.decor.push({ s: si, i, kind: 'leaf', side: 1, size: 13 - i }, { s: si, i, kind: 'leaf', side: -1, size: 13 - i });
        if (i % 2 === 0) s.decor.push({ s: si, i, kind: 'dot', size: 1.5 });
      }
    }
  },
  // A tuft of blades; the tallest carry glowing plumes.
  grass(g, r, s) {
    const blades = 8 + Math.floor(r() * 6) + g.stems;
    for (let k = 0; k < blades; k++) {
      const n = 4, tall = k % 3 === 0, h = g.height * (tall ? 0.8 + r() * 0.2 : 0.35 + r() * 0.4);
      const st = strand(null, 0, UP + (r() - 0.5) * 0.9 * g.spread, n, () => h / n, 1.7 * g.thickness, 0.5, () => (r() - 0.5) * 0.1 + g.curl * 0.05, 1.5);
      st.x = (r() - 0.5) * 22 * g.spread;
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      if (tall) s.decor.push({ s: si, i: n, kind: 'plume', size: 9 + r() * 5 });
    }
  },
  // A rosette of leaves and bare stalks, each topped by a many-rayed flower that becomes a seed clock.
  puff(g, r, s) {
    const leaves = 5 + Math.floor(r() * 3);
    for (let k = 0; k < leaves; k++) {
      const a = UP + (k / (leaves - 1) - 0.5) * 2.5;
      s.decor.push({ s: -1, kind: 'leaf', axis: a, side: 0, size: 15 + r() * 8, jag: true });
    }
    const stalks = Math.min(3, Math.ceil(g.stems / 2));
    for (let k = 0; k < stalks; k++) {
      const n = 5, h = g.height * (0.65 + r() * 0.35);
      const st = strand(null, 0, UP + (k - (stalks - 1) / 2) * 0.3 + (r() - 0.5) * 0.15, n, () => h / n, 1.3, 1, () => (r() - 0.5) * 0.08, 1.2);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: n, kind: 'flower', size: 8 + r() * 2, cup: 0.05, thin: true, clock: true });
    }
  },
  // A branching shrub with small flowers at its tips.
  bush(g, r, s) {
    const grow = (parent, at, angle, len, w, depth) => {
      const n = 3;
      const st = strand(parent, at, angle, n, () => len / n, w, w * 0.7, () => (r() - 0.5) * 0.16 + g.curl * 0.03, 0.5);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: 2, kind: 'leaf', side: r() < 0.5 ? 1 : -1, size: 9 + depth * 2 });
      if (depth <= 0) { s.decor.push({ s: si, i: n, kind: 'flower', size: 5.5 + r() * 1.5, cup: 0.2 + 0.4 * g.cup, minor: r() < 0.4 }); return; }
      const kids = 2 + (r() < 0.3 ? 1 : 0);
      for (let k = 0; k < kids; k++) grow(si, n, (k - (kids - 1) / 2) * (0.5 + 0.5 * g.spread) * (0.8 + r() * 0.4), len * (0.66 + r() * 0.12), w * 0.7, depth - 1);
    };
    const trunks = Math.min(2, Math.ceil(g.stems / 3));
    for (let k = 0; k < trunks; k++) grow(null, 0, UP + (k - (trunks - 1) / 2) * 0.5, g.height * 0.46, 4.2 * g.thickness, 2);
  },
  // A cluster of glowing mushrooms.
  cap(g, r, s) {
    const caps = 2 + Math.floor(r() * 3) + Math.floor(g.stems / 3);
    for (let k = 0; k < caps; k++) {
      const h = g.height * (0.45 + r() * 0.55);
      const st = strand(null, 0, UP + (r() - 0.5) * 0.5, 2, () => h / 2, 2.6, 2, () => (r() - 0.5) * 0.25, 0.3);
      st.x = (k - (caps - 1) / 2) * 9 + (r() - 0.5) * 5;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: 2, kind: 'cap', size: 5 + r() * 5 });
    }
  },
  // One or two creepers winding up the wall, flowering as they go.
  vine(g, r, s) {
    const strands = 1 + (g.stems > 3 ? 1 : 0);
    for (let k = 0; k < strands; k++) {
      const n = 18, lean = (k ? -1 : 1) * (g.curl < 0 ? -1 : 1);
      const st = strand(null, 0, UP + lean * 0.25, n, () => (g.height * (k ? 0.75 : 1) * 1.12) / n, 2.2 * g.thickness, 0.9,
        (i) => Math.sin(i * 0.9 + k * 2) * 0.24 - lean * 0.014, 0.25);
      st.x = k * 10 * lean;
      st.phase = k * 1.3;
      const si = s.strands.push(st) - 1;
      for (let i = 2; i <= n; i++) {
        s.decor.push({ s: si, i, kind: 'leaf', side: i % 2 ? 1 : -1, size: 9.5, wide: true });
        if (i % 4 === 3) s.decor.push({ s: si, i, kind: 'flower', size: 6, cup: 0.3 * g.cup, turn: (i % 8 === 3 ? 1 : -1) * 1.2, minor: i % 8 !== 3 });
      }
    }
  },
  // Pads lying on the pond, and one many-petalled flower sitting on the water.
  lily(g, r, s) {
    const pads = 2 + Math.floor(r() * 3);
    for (let k = 0; k < pads; k++) s.decor.push({ s: -1, kind: 'pad', dx: (k - (pads - 1) / 2) * 17 + (r() - 0.5) * 6, dy: (r() - 0.5) * 7, size: 9 + r() * 5, notch: r() * TAU });
    s.decor.push({ s: -1, kind: 'flower', dx: (r() - 0.5) * 8, dy: -2, size: 8 + r() * 2, cup: 0.55, track: 0.25 });
  },
};

// Shapes are cached per genome (plants come and go, so only the most recent ones are kept).
const shapes = new Map();
function shapeOf(g) {
  const key = `${g.form}:${g.seed}`;
  let s = shapes.get(key);
  if (!s) {
    if (shapes.size > 200) shapes.delete(shapes.keys().next().value);
    s = { strands: [], decor: [] };
    BUILD[g.form](g, rng(g.seed), s);
    for (const st of s.strands) st.base = st.parent == null ? 0 : s.strands[st.parent].base + st.at;
    s.span = Math.max(1, ...s.strands.map((st) => st.base + st.segs.length));
    shapes.set(key, s);
  }
  return s;
}

// ---------- posing and drawing ----------

// Positions of every strand's joints right now, and how far grown each joint is (0 to 1): a plant
// grows out from its root, joint after joint, so a sprout is its first few segments, not a small
// copy of the whole. Wind leans each strand and sets it shivering.
function pose(g, s, t, growth, wither, wind) {
  const out = [];
  const reach = growth * (s.span + 1.5);
  for (let k = 0; k < s.strands.length; k++) {
    const st = s.strands[k];
    let x, y, a;
    if (st.parent == null) { x = (st.x ?? 0) * Math.min(1, growth * 2); y = 0; a = st.angle; }
    else { const p = out[st.parent]; x = p.pts[st.at].x; y = p.pts[st.at].y; a = p.ang[st.at] + st.angle; }
    const pts = [{ x, y }], ang = [a], grown = [clamp(reach - st.base, 0, 1)];
    for (let i = 0; i < st.segs.length; i++) {
      const seg = st.segs[i];
      const f = clamp(reach - (st.base + i), 0, 1);
      // In air a stem stands nearly still and shivers as a whole when the wind gets up (a slow wave
      // rolling up it would read as weed under water).
      const sway = g.sway * 0.04 * st.flex * (0.12 + 1.5 * Math.min(1, Math.abs(wind))) * Math.sin(t * (1.6 + g.sway * 0.8) + st.phase - i * 0.1);
      // Withering plants droop: every joint bends a little toward the ground.
      const droop = wither * 0.13 * Math.sign(Math.cos(a) || 1);
      a += seg.bend * f + sway + droop + wind * 0.035 * st.flex;
      x += Math.cos(a) * seg.l * f;
      y += Math.sin(a) * seg.l * f;
      pts.push({ x, y });
      ang.push(a);
      grown.push(clamp(reach - (st.base + i + 0.5), 0, 1));
    }
    out.push({ pts, ang, grown });
  }
  return out;
}

const at = (posed, d, growth) => {
  if (d.s < 0) return { x: (d.dx ?? 0) * growth, y: (d.dy ?? 0) * growth, a: d.axis ?? UP, f: growth };
  const p = posed[d.s];
  const i = Math.min(d.i ?? p.pts.length - 1, p.pts.length - 1);
  return { x: p.pts[i].x, y: p.pts[i].y, a: p.ang[i], f: p.grown[i] };
};

// The shortest way from angle a to angle b, k of the way.
const toward = (a, b, k) => a + (((b - a + Math.PI * 3) % TAU) - Math.PI) * k;

function petal(gfx, x, y, a, len, wid, color, alpha) {
  const dx = Math.cos(a), dy = Math.sin(a);
  const mx = x + dx * len * 0.55, my = y + dy * len * 0.55;
  gfx.fillStyle(color, alpha).fillPoints([
    { x, y }, { x: mx - dy * wid, y: my + dx * wid }, { x: x + dx * len, y: y + dy * len }, { x: mx + dy * wid, y: my - dx * wid },
  ], true);
}

// Draws plant `p` into graphics `gfx` (positioned at the plant's root and scaled by the plant's
// depth) and places its glow sprites from `glows` (a pool with take()).
// env: { open (0-1, how far its flowers are open), wind, moon ({x, y} on screen, or null), light (0-1), lite }
export function drawPlant(gfx, glows, p, g, t, env) {
  const s = shapeOf(g);
  const growth = Math.max(0.03, p.growth);
  const wither = p.wither ?? 0;
  const alive = 1 - (p.fade ?? 0);
  const scale = p.scale ?? 1;
  const open = env.open;
  const seeding = p.state === 'seeding' || p.state === 'withering' || p.state === 'dead';
  const posed = pose(g, s, t, growth, wither, env.wind);
  const sat = g.sat * (1 - wither * 0.8);
  const pulse = 0.65 + 0.35 * Math.sin(t * g.pulse * TAU + (g.seed % 7));
  const glow = g.glow * (1 - wither * 0.85) * alive;
  // Leaves and stems are dark, and pick up a little of whatever moonlight there is.
  const lum = 0.15 + 0.13 * env.light;
  const stemBase = hsl(g.hue, sat * 0.5, lum * 0.8), stemTip = hsl(g.hue, sat * 0.6, lum * 1.5);
  const leaf = hsl(g.hue, sat * 0.6, lum * 1.3), leafEdge = hsl(g.hue, sat * 0.8, lum * 2.3);
  const vein = hsl(g.hue2, sat, 0.6);
  const petalA = hsl(g.hue2, sat, 0.54 + 0.14 * open), petalB = hsl(g.hue2, sat * 0.9, 0.66 + 0.14 * open);
  const heart = hsl(g.hue3, Math.min(1, sat + 0.1), 0.78);
  const husk = hsl(g.hue2, sat * 0.25, 0.3);

  gfx.clear();
  for (let k = 0; k < s.strands.length; k++) {
    const { pts, grown } = posed[k];
    const st = s.strands[k];
    for (let i = 0; i < st.segs.length; i++) {
      if (grown[i] <= 0) break;
      const u = (st.base + i) / s.span;
      gfx.lineStyle(Math.max(1.1, st.segs[i].w * 1.6 * (0.5 + 0.5 * grown[i])), mix(stemBase, stemTip, u), 0.96 * alive);
      gfx.lineBetween(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }
  }
  // A thread of light climbs every stem at the plant's own pace.
  if (!env.lite && g.form !== 'cap') {
    const climb = t * (0.5 + g.pulse) * 2.4;
    for (let k = 0; k < s.strands.length; k++) {
      const { pts, grown } = posed[k];
      const st = s.strands[k];
      for (let i = 0; i < st.segs.length; i++) {
        if (grown[i] <= 0) break;
        const wave = Math.max(0, Math.sin(climb - (st.base + i) * 0.6 + st.phase * 0.3)) ** 6;
        if (wave < 0.08) continue;
        gfx.lineStyle(Math.max(0.7, st.segs[i].w * 0.4), vein, wave * 0.7 * glow);
        gfx.lineBetween(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      }
    }
  }

  let lit = 0;
  for (const d of s.decor) {
    const q = at(posed, d, growth);
    if (q.f <= 0.02) continue;
    if (d.kind === 'leaf') {
      const la = d.side ? q.a + d.side * 0.95 : q.a;
      const len = d.size * q.f * 1.35, wd = len * (d.wide ? 0.36 : d.jag ? 0.2 : 0.26);
      petal(gfx, q.x, q.y, la, len, wd, leaf, 0.92 * alive);
      gfx.lineStyle(0.7, leafEdge, 0.6 * alive).lineBetween(q.x, q.y, q.x + Math.cos(la) * len * 0.85, q.y + Math.sin(la) * len * 0.85);
      if (d.feather && !env.lite) for (const sgn of [-1, 1]) {
        const mx = q.x + Math.cos(la) * len * 0.5, my = q.y + Math.sin(la) * len * 0.5;
        gfx.lineBetween(mx, my, mx + Math.cos(la + sgn * 0.8) * len * 0.35, my + Math.sin(la + sgn * 0.8) * len * 0.35);
      }
    } else if (d.kind === 'dot') {
      gfx.fillStyle(vein, (0.25 + 0.75 * open) * (0.5 + 0.5 * pulse) * glow).fillCircle(q.x, q.y, d.size * q.f * (1.1 + 0.7 * open));
    } else if (d.kind === 'plume') {
      const len = d.size * q.f * 1.3;
      for (let j = 0; j < 5; j++) {
        const a = q.a + (j - 2) * 0.16 * (0.4 + 0.6 * open), l = len * (1 - Math.abs(j - 2) * 0.16);
        gfx.lineStyle(1.1, mix(husk, petalB, open), (0.5 + 0.5 * open * pulse) * alive).lineBetween(q.x, q.y, q.x + Math.cos(a) * l, q.y + Math.sin(a) * l);
      }
      if (open > 0.3 && lit++ < 3) glows.take(p.x + (q.x + Math.cos(q.a) * len * 0.6) * scale, p.y + (q.y + Math.sin(q.a) * len * 0.6) * scale, 0.16 * scale, vein, 0.5 * open * glow * pulse);
    } else if (d.kind === 'cap') {
      const w = d.size * q.f * 1.3, h = w * 0.62;
      // A dome with a lit underside: mushrooms glow from below.
      const dome = [];
      for (let j = 0; j <= 8; j++) { const a = Math.PI + (j / 8) * Math.PI; dome.push({ x: q.x + Math.cos(a) * w, y: q.y + Math.sin(a) * h }); }
      gfx.fillStyle(mix(hsl(g.hue2, sat * 0.6, 0.2), petalB, open * 0.7), alive).fillPoints(dome, true);
      gfx.fillStyle(heart, 0.75 * open * pulse * glow).fillEllipse(q.x, q.y + 1, w * 1.7, 2.4);
      if (open > 0.2 && lit++ < 3) glows.take(p.x + q.x * scale, p.y + (q.y + 3) * scale, 0.05 * w * scale, vein, 0.55 * open * glow * pulse);
    } else if (d.kind === 'pad') {
      const w = d.size * q.f;
      gfx.fillStyle(leaf, 0.95 * alive).fillEllipse(q.x, q.y, w * 2, w * 0.62);
      gfx.lineStyle(0.8, leafEdge, 0.5 * alive).strokeEllipse(q.x, q.y, w * 2, w * 0.62);
      gfx.lineBetween(q.x, q.y, q.x + Math.cos(d.notch) * w, q.y + Math.sin(d.notch) * w * 0.3);
    } else if (d.kind === 'flower') {
      const size = d.size * q.f * 1.45;
      // A flower faces along its stem (or hangs), and turns toward the moon as far as its kind does.
      let axis = d.hang ? Math.PI / 2 + Math.sin(t * 1.3 + q.x) * 0.08 + env.wind * 0.25 : q.a + (d.turn ?? 0);
      const track = d.hang ? 0 : (d.track ?? g.turn * 0.7) * open;
      if (env.moon && track > 0.02) axis = toward(axis, Math.atan2(env.moon.y - (p.y + q.y * scale), env.moon.x - (p.x + q.x * scale)), track);
      if (seeding) {
        // Gone to seed: a husk, and for clockflowers a ball of down that thins as its seeds leave.
        const r0 = size * 0.32;
        gfx.fillStyle(husk, 0.9 * alive).fillCircle(q.x, q.y, r0);
        if (d.clock && p.state === 'seeding') {
          const rays = 4 + 3 * (p.seedsLeft ?? 0);
          for (let j = 0; j < rays; j++) {
            const a = (j / rays) * TAU + d.size, l = size * 0.95;
            gfx.lineStyle(0.6, 0xdfe8ff, 0.5 * alive).lineBetween(q.x, q.y, q.x + Math.cos(a) * l, q.y + Math.sin(a) * l);
            gfx.fillStyle(0xf2f6ff, 0.75 * alive).fillCircle(q.x + Math.cos(a) * l, q.y + Math.sin(a) * l, 0.9);
          }
        } else if (p.state === 'seeding' && !d.minor) gfx.fillStyle(0xe8efff, 0.55 * alive * pulse).fillCircle(q.x + Math.cos(axis) * r0, q.y + Math.sin(axis) * r0, 1.2);
        continue;
      }
      const cup = d.cup ?? g.cup;
      const n = d.petals ?? g.petals;
      const len = size * g.petalLen * (0.5 + 0.5 * open);
      const wid = size * (d.thin ? 0.1 : 0.3) * g.petalWid * (0.55 + 0.45 * open);
      // Shut, the petals lie together along the axis as a bud; open, they fan out, all the way
      // round for flat flowers, or into a cup.
      const full = Math.PI * (1 - 1 / n);
      const spread = 0.1 + (full + (1.05 - full) * cup - 0.1) * open;
      for (let j = 0; j < n; j++) petal(gfx, q.x, q.y, axis + (n > 1 ? (j / (n - 1) - 0.5) * 2 * spread : 0), len, wid, j % 2 ? petalA : petalB, (0.75 + 0.2 * open) * alive);
      if (open > 0.15) {
        gfx.fillStyle(heart, Math.min(1, open * 1.2) * alive * (0.75 + 0.25 * pulse)).fillCircle(q.x + Math.cos(axis) * len * 0.1, q.y + Math.sin(axis) * len * 0.1, size * 0.2 * open);
        if (!d.minor && lit++ < 4) glows.take(p.x + (q.x + Math.cos(axis) * len * 0.35) * scale, p.y + (q.y + Math.sin(axis) * len * 0.35) * scale,
          size * 0.07 * scale * (0.9 + 0.2 * pulse), vein, 0.8 * open * glow * (0.7 + 0.3 * pulse));
      }
    }
  }
}

// How far a plant reaches, for its hover area (in its own unscaled coordinates).
export function plantBounds(g, growth) {
  if (g.form === 'lily') return { x: -34, y: -18, w: 68, h: 30 };
  const h = Math.max(18, g.height * Math.max(0.15, growth));
  const w = Math.max(28, Math.min(150, h * (0.3 + g.spread * 0.5)));
  return { x: -w / 2, y: -h - 10, w, h: h + 14 };
}
