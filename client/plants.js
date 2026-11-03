// Draws bioluminescent plants from their genomes. Each plant is a set of strands (chains of
// segments, possibly branching off other strands) plus decorations along them: food pods, glowing
// dots, leaves, bulbs and rims. The shape is built once per genome; every frame it is posed with
// sway, growth and withering and drawn into the plant's Graphics.
import { rng } from '../shared/plants.js';

const TAU = Math.PI * 2;

// Linear blend of two 0xRRGGBB colors.
const mix = (a, b, t) => {
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

const BUILD = {
  kelp(g, r, s) {
    const n = 14 + Math.floor(r() * 8);
    for (let k = 0; k < g.stems; k++) {
      const st = strand(null, 0, -Math.PI / 2 + (r() - 0.5) * g.spread * 0.6, n, () => (g.height / n) * (0.8 + r() * 0.4),
        4 * g.thickness, 1.5 * g.thickness, (i) => Math.sin(i * 0.7 + k) * 0.05 + g.curl * 0.015, 1.3);
      st.x = (k - (g.stems - 1) / 2) * 5 * g.spread;
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      for (let i = 2; i < n; i += 2) s.decor.push({ s: si, i, kind: 'leaf', side: i % 4 ? 1 : -1, size: 6 + r() * 6 });
      for (let i = 3; i < n; i += 3) s.decor.push({ s: si, i, kind: 'dot', side: i % 2 ? 1 : -1, size: 1.6 });
      s.decor.push({ s: si, i: n - 1, kind: 'pod', size: 4.5 * g.podSize });
      s.decor.push({ s: si, i: Math.floor(n * 0.7), kind: 'pod', side: 1, size: 3.8 * g.podSize });
    }
  },
  coral(g, r, s) {
    const grow = (parent, at, angle, len, w, depth) => {
      const n = 3 + Math.floor(r() * 2);
      const st = strand(parent, at, angle, n, () => len / n, w, w * 0.7, () => (r() - 0.5) * 0.15 + g.curl * 0.03, 0.4);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      if (depth <= 0) { s.decor.push({ s: si, i: n - 1, kind: 'pod', size: 3.5 * g.podSize }); return; }
      const kids = 2 + (r() < 0.35 ? 1 : 0);
      for (let k = 0; k < kids; k++) {
        const a = (k - (kids - 1) / 2) * g.branch * (0.8 + r() * 0.4) * (kids === 3 ? 0.9 : 1.2);
        grow(si, n - 1, a, len * (0.62 + r() * 0.15), w * 0.68, depth - 1);
      }
    };
    for (let k = 0; k < Math.min(3, g.stems); k++) grow(null, 0, -Math.PI / 2 + (k - (Math.min(3, g.stems) - 1) / 2) * 0.35, g.height * 0.34, 6 * g.thickness, g.depth);
  },
  fan(g, r, s) {
    const trunk = strand(null, 0, -Math.PI / 2, 3, () => g.height * 0.08, 5 * g.thickness, 4 * g.thickness, () => 0, 0.2);
    const t = s.strands.push(trunk) - 1;
    const ribs = 9 + Math.floor(r() * 10);
    const span = 0.7 + g.spread * 0.6;
    for (let k = 0; k < ribs; k++) {
      const a = -span + (2 * span * k) / (ribs - 1);
      const n = 6;
      const st = strand(t, 2, a, n, () => (g.height * 0.9) / n * (0.85 + r() * 0.3), 1.6, 0.7, () => (r() - 0.5) * 0.08, 0.5);
      st.phase = k * 0.3;
      const si = s.strands.push(st) - 1;
      if (k % 2 === 0) s.decor.push({ s: si, i: n - 1, kind: 'pod', size: 3 * g.podSize });
      else s.decor.push({ s: si, i: n - 1, kind: 'dot', size: 2 });
      s.decor.push({ s: si, i: 3, kind: 'dot', size: 1.4 });
    }
    s.lattice = true;
  },
  anemone(g, r, s) {
    s.decor.push({ s: -1, kind: 'bulb', size: g.height * 0.32 * g.thickness });
    const arms = 10 + Math.floor(r() * 14);
    for (let k = 0; k < arms; k++) {
      const a = -Math.PI / 2 + (k / (arms - 1) - 0.5) * (1.6 + g.spread * 1.2);
      const n = 6 + Math.floor(r() * 4);
      const st = strand(null, 0, a, n, () => (g.height * 0.75) / n, 3 * g.thickness, 0.8, (i) => g.curl * 0.12 + Math.sin(i + k) * 0.04, 1.6);
      st.y = -g.height * 0.22;
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: n - 1, kind: k % 3 === 0 ? 'pod' : 'dot', size: k % 3 === 0 ? 3 * g.podSize : 2 });
    }
  },
  lantern(g, r, s) {
    const stalks = 1 + Math.floor(g.stems * 0.8);
    for (let k = 0; k < stalks; k++) {
      const n = 8;
      const h = g.height * (0.55 + r() * 0.45);
      const st = strand(null, 0, -Math.PI / 2 + (r() - 0.5) * 0.5 * g.spread, n, () => h / n, 2.2 * g.thickness, 1.2, () => (r() - 0.5) * 0.06 + g.curl * 0.02, 0.9);
      st.x = (k - (stalks - 1) / 2) * 8;
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: n - 1, kind: 'pod', size: 6.5 * g.podSize, hang: true });
      s.decor.push({ s: si, i: 2, kind: 'leaf', side: 1, size: 8 }, { s: si, i: 3, kind: 'leaf', side: -1, size: 7 });
    }
  },
  fern(g, r, s) {
    const fronds = 1 + Math.floor(g.stems / 2.5);
    for (let k = 0; k < fronds; k++) {
      const n = 16;
      const curlFrom = 11;
      const st = strand(null, 0, -Math.PI / 2 + (k - (fronds - 1) / 2) * 0.4, n, (i) => (g.height / 12) * (i < curlFrom ? 1 : 0.45),
        3 * g.thickness, 1.2, (i) => (i < curlFrom ? g.curl * 0.02 : 0.55 * Math.sign(g.curl || 1)), 0.8);
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      for (let i = 2; i < curlFrom; i++) {
        s.decor.push({ s: si, i, kind: 'leaf', side: 1, size: 14 - i * 0.6 }, { s: si, i, kind: 'leaf', side: -1, size: 14 - i * 0.6 });
        if (i % 3 === 0) s.decor.push({ s: si, i, kind: 'dot', side: 1, size: 1.6, off: 12 });
      }
      s.decor.push({ s: si, i: n - 1, kind: 'pod', size: 4 * g.podSize }, { s: si, i: curlFrom - 2, kind: 'pod', side: -1, size: 3.2 * g.podSize, off: 10 });
    }
  },
  tube(g, r, s) {
    const tubes = 2 + Math.floor(g.stems * 0.9);
    for (let k = 0; k < tubes; k++) {
      const h = g.height * (0.45 + r() * 0.55);
      const w = (6 + r() * 7) * g.thickness;
      const st = strand(null, 0, -Math.PI / 2 + (k - (tubes - 1) / 2) * 0.12 * g.spread, 3, () => h / 3, w, w * 1.1, () => (r() - 0.5) * 0.05, 0.15);
      st.x = (k - (tubes - 1) / 2) * w * 0.9;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: 2, kind: 'rim', size: w * 0.55 });
      s.decor.push({ s: si, i: 2, kind: 'pod', size: 3 * g.podSize, off: -2 });
    }
  },
  grass(g, r, s) {
    const blades = 12 + Math.floor(r() * 18);
    for (let k = 0; k < blades; k++) {
      const n = 5;
      const h = g.height * (0.5 + r() * 0.5);
      const st = strand(null, 0, -Math.PI / 2 + (r() - 0.5) * 0.8 * g.spread, n, () => h / n, 2 * g.thickness, 0.6, () => (r() - 0.5) * 0.08 + g.curl * 0.04, 1.4);
      st.x = (r() - 0.5) * 28 * g.spread;
      st.phase = r() * TAU;
      const si = s.strands.push(st) - 1;
      s.decor.push({ s: si, i: n - 1, kind: k % 4 === 0 ? 'pod' : 'dot', size: k % 4 === 0 ? 2.6 * g.podSize : 1.3 });
    }
  },
  orb(g, r, s) {
    const n = 18;
    const st = strand(null, 0, -Math.PI / 2, n, () => g.height / n, 2 * g.thickness, 1, (i) => Math.sin(i * 0.6) * 0.09 * (0.5 + g.spread), 1.1);
    st.phase = r() * TAU;
    const si = s.strands.push(st) - 1;
    for (let i = 4; i < n; i += 2) s.decor.push({ s: si, i, kind: i % 4 === 0 ? 'pod' : 'dot', size: i % 4 === 0 ? (3 + (n - i) * 0.18) * g.podSize : 3, side: i % 4 ? 1 : -1, off: 7 });
    if (g.stems > 3) {
      const side = strand(si, 6, 0.7, 8, () => g.height / n, 1.4, 0.8, (i) => Math.sin(i) * 0.1, 1.2);
      const sj = s.strands.push(side) - 1;
      for (let i = 2; i < 8; i += 2) s.decor.push({ s: sj, i, kind: 'pod', size: 3 * g.podSize, off: 5, side: 1 });
    }
  },
  vine(g, r, s) {
    const strands = 2 + Math.floor(g.stems / 3);
    for (let k = 0; k < strands; k++) {
      const n = 22;
      const st = strand(null, 0, -Math.PI / 2, n, () => g.height / n, 2.4 * g.thickness, 1, (i) => Math.sin(i * 0.55 + (k * TAU) / strands) * 0.22, 0.9);
      st.x = (k - (strands - 1) / 2) * 4;
      st.phase = k * 1.3;
      const si = s.strands.push(st) - 1;
      for (let i = 3; i < n; i += 4) s.decor.push({ s: si, i, kind: 'leaf', side: k % 2 ? 1 : -1, size: 9 });
      for (let i = 5; i < n; i += 5) s.decor.push({ s: si, i, kind: 'pod', size: 3.2 * g.podSize, side: k % 2 ? -1 : 1, off: 5 });
    }
  },
};

// Shapes are cached per genome (plants come and go, so only the most recent ones are kept).
const shapes = new Map();
function shapeOf(g) {
  const key = `${g.form}:${g.seed}`;
  let s = shapes.get(key);
  if (!s) {
    if (shapes.size > 120) shapes.delete(shapes.keys().next().value);
    s = { strands: [], decor: [] };
    BUILD[g.form](g, rng(g.seed), s);
    for (const st of s.strands) st.base = st.parent == null ? 0 : s.strands[st.parent].base + st.at;
    s.span = Math.max(...s.strands.map((st) => st.base + st.segs.length));
    // Food grows highest first, so the first `food` pods are the top ones.
    s.pods = s.decor.filter((d) => d.kind === 'pod');
    shapes.set(key, s);
  }
  return s;
}

// ---------- posing and drawing ----------

// Positions of every strand's joints right now: sway travels up each strand like a wave.
function pose(g, s, t, growth, wither) {
  const out = [];
  const omega = g.swaySpeed * TAU * 0.5;
  for (let k = 0; k < s.strands.length; k++) {
    const st = s.strands[k];
    let x, y, a;
    if (st.parent == null) { x = (st.x ?? 0) * growth; y = (st.y ?? 0) * growth; a = st.angle; }
    else { const p = out[st.parent]; x = p.pts[st.at].x; y = p.pts[st.at].y; a = p.ang[st.at] + st.angle; }
    const pts = [{ x, y }], ang = [a];
    for (let i = 0; i < st.segs.length; i++) {
      const seg = st.segs[i];
      const sway = g.sway * 0.045 * st.flex * Math.sin(t * omega + st.phase - i * 0.35);
      // Withering plants droop: every joint bends a little toward the sand.
      const droop = wither * 0.12 * Math.sign(Math.cos(a) || 1);
      a += seg.bend + sway + droop;
      x += Math.cos(a) * seg.l * growth;
      y += Math.sin(a) * seg.l * growth;
      pts.push({ x, y });
      ang.push(a);
    }
    out.push({ pts, ang });
  }
  return out;
}

const at = (posed, d) => {
  if (d.s < 0) return { x: 0, y: 0, a: -Math.PI / 2 };
  const p = posed[d.s];
  const i = Math.min(d.i ?? p.pts.length - 1, p.pts.length - 1);
  const a = p.ang[Math.min(i, p.ang.length - 1)];
  const off = (d.off ?? 0) * (d.side ?? 0);
  return { x: p.pts[i].x + Math.cos(a + Math.PI / 2) * off, y: p.pts[i].y + Math.sin(a + Math.PI / 2) * off, a };
};

// Draws plant `p` into graphics `gfx` (positioned at the plant's root) and places its glow
// sprites from `glows` (a pool with take()). Returns the plant's bounds for hit testing.
export function drawPlant(gfx, glows, p, g, t) {
  const s = shapeOf(g);
  const growth = Math.max(0.05, p.growth);
  const wither = p.wither ?? 0;
  const alive = 1 - (p.fade ?? 0);
  const posed = pose(g, s, t, growth, wither);
  const sat = g.sat * (1 - wither * 0.8);
  const pulse = 0.65 + 0.35 * Math.sin(t * g.pulse * TAU + g.seed % 7);
  const light = g.glow * (1 - wither * 0.85) * alive;
  const stem = hsl(g.hue, sat * 0.7, 0.22 + 0.08 * g.glow);
  const vein = hsl(g.hue2, sat, 0.64);
  const bright = hsl(g.hue2, sat, 0.78);
  // Bodies darken toward the sand and light up toward the tips; veins shift from the plant's own
  // hue to its accent as they climb.
  const stemBase = hsl(g.hue, sat * 0.55, 0.12 + 0.04 * g.glow), stemTip = hsl(g.hue, sat * 0.85, 0.3 + 0.1 * g.glow);
  const veinBase = hsl(g.hue, sat, 0.5), veinTip = hsl(g.hue2, sat, 0.72);
  // Pulses of light run up every stem from the root, at the plant's own pace.
  const climb = t * (0.6 + g.pulse) * Math.PI;

  gfx.clear();
  // Halo pass, body pass, then glowing veins.
  for (const pass of [0, 1, 2]) {
    for (let k = 0; k < s.strands.length; k++) {
      const { pts } = posed[k];
      const st = s.strands[k];
      for (let i = 0; i < st.segs.length; i++) {
        const w = st.segs[i].w * 1.3 * Math.sqrt(growth);
        const u = (st.base + i) / s.span;
        if (pass === 0) gfx.lineStyle(w * 3.4, mix(veinBase, veinTip, u), 0.1 * light * alive);
        else if (pass === 1) gfx.lineStyle(w, mix(stemBase, stemTip, u), 0.95 * alive);
        else {
          const wave = Math.max(0, Math.sin(climb - (st.base + i) * 0.55 + st.phase * 0.3)) ** 6;
          gfx.lineStyle(Math.max(0.9, w * (0.34 + 0.3 * wave)), mix(veinBase, veinTip, Math.min(1, u + wave * 0.3)), Math.min(1, 0.32 + 0.3 * pulse + 0.75 * wave) * light);
        }
        gfx.lineBetween(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      }
    }
  }
  if (s.lattice) {
    // Sea fans: cross-threads between neighboring ribs.
    gfx.lineStyle(0.9, vein, 0.4 * light);
    for (let k = 2; k < posed.length; k++)
      for (let i = 2; i < posed[k].pts.length; i += 2) {
        const a = posed[k - 1].pts[Math.min(i, posed[k - 1].pts.length - 1)], b = posed[k].pts[i];
        gfx.lineBetween(a.x, a.y, b.x, b.y);
      }
  }

  let podIndex = 0;
  for (const d of s.decor) {
    const q = at(posed, d);
    if (d.kind === 'leaf') {
      const la = q.a + d.side * 0.9;
      const len = d.size * growth * 1.15;
      const dx = Math.cos(la), dy = Math.sin(la), wd = len * 0.26;
      const mx = q.x + dx * len * 0.45, my = q.y + dy * len * 0.45;
      gfx.fillStyle(stemTip, 0.7 * alive).fillPoints([
        { x: q.x, y: q.y }, { x: mx - dy * wd, y: my + dx * wd }, { x: q.x + dx * len, y: q.y + dy * len }, { x: mx + dy * wd, y: my - dx * wd },
      ], true);
      gfx.fillStyle(veinTip, 0.12 * light).fillPoints([
        { x: q.x, y: q.y }, { x: mx - dy * wd * 0.5, y: my + dx * wd * 0.5 }, { x: q.x + dx * len * 0.9, y: q.y + dy * len * 0.9 }, { x: mx + dy * wd * 0.5, y: my - dx * wd * 0.5 },
      ], true);
      gfx.lineStyle(0.8, veinTip, (0.35 + 0.4 * pulse) * light);
      gfx.lineBetween(q.x, q.y, q.x + dx * len * 0.85, q.y + dy * len * 0.85);
    } else if (d.kind === 'bulb') {
      const r = d.size * growth;
      gfx.fillStyle(stem, 0.95 * alive).fillEllipse(0, -r * 0.5, r * 1.5, r * 1.1);
      gfx.fillStyle(vein, 0.25 * light * pulse).fillEllipse(0, -r * 0.6, r * 1.1, r * 0.6);
      glows.take(p.x, p.y - r * 0.5, r * 0.09, vein, 0.25 * light);
    } else if (d.kind === 'rim') {
      gfx.lineStyle(1.6, bright, (0.5 + 0.4 * pulse) * light).strokeEllipse(q.x, q.y, d.size * 2 * Math.sqrt(growth), d.size * 0.7);
      glows.take(p.x + q.x, p.y + q.y, d.size * 0.09, vein, 0.3 * light);
    } else if (d.kind === 'dot') {
      gfx.fillStyle(bright, (0.5 + 0.5 * pulse) * light).fillCircle(q.x, q.y, d.size * Math.sqrt(growth));
    } else if (d.kind === 'pod') {
      // Food: lit pods while the plant has it, dark husks where it has been eaten.
      const full = podIndex++ < p.food;
      const r = d.size * (d.hang ? 1 : 0.9);
      const y = q.y + (d.hang ? r * 0.8 : 0);
      if (full) {
        const podPulse = 0.75 + 0.25 * Math.sin(t * g.pulse * TAU * 1.3 + podIndex);
        gfx.fillStyle(bright, alive).fillCircle(q.x, y, r);
        gfx.fillStyle(0xffffff, 0.75 * alive * podPulse).fillCircle(q.x - r * 0.25, y - r * 0.25, r * 0.4);
        glows.take(p.x + q.x, p.y + y, r * 0.22 * (0.9 + 0.3 * podPulse), vein, 0.75 * light * podPulse);
      } else if (p.state !== 'growing') {
        gfx.fillStyle(stem, 0.9 * alive).fillCircle(q.x, y, r * 0.55);
      }
    }
  }
}

// How far a plant reaches, for its hover area.
export function plantBounds(g, growth) {
  const h = Math.max(20, g.height * Math.max(0.15, growth));
  const w = Math.max(30, Math.min(160, h * (0.25 + g.spread * 0.5)));
  return { x: -w / 2, y: -h - 10, w, h: h + 14 };
}
