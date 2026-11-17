import Phaser from 'phaser';
import { WORLD, POND, SPIRAL, LANTERN, MOON, NIGHT, LUNATION, plotPos, spiralPoint, skyAt, cloudsAt, lightWord } from '../shared/garden.js';
import { opensWords, hueWord, speciesName } from '../shared/flora.js';
import { drawPlant, plantBounds, hsl, mix } from './flora.js';
import { darkShape, moonSvg, phaseName } from './moon.js';
import { createBook } from './book.js';

const { width: W, height: H } = WORLD;
const TAU = Math.PI * 2;
const DEPTH = { sky: 0, stars: 0.1, streak: 0.15, moonGlow: 0.2, moon: 0.3, clouds: 0.5, pale: 0.7, wall: 1, mist: 1.5, ground: 2, pond: 2.4, floorGlow: 2.8,
  plant: 3, bloom: 4.5, seed: 5, sparks: 6, halo: 7, fly: 8, label: 9, rain: 10, bokeh: 12 };
const tip = document.getElementById('tip');
const bubbleLayer = document.getElementById('bubbles');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hexToInt = (h) => parseInt(String(h ?? '#dff27a').slice(1), 16);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (v) => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
const span = (s) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`);
const flowerColor = (g) => hex(hsl(g.hue2, g.sat, 0.66));
const leafColor = (g) => hex(hsl(g.hue, g.sat * 0.7, 0.42));

// Glow sprites reused frame to frame.
class GlowPool {
  constructor(scene, depth, blend = Phaser.BlendModes.ADD) { this.scene = scene; this.depth = depth; this.blend = blend; this.items = []; this.used = 0; }
  begin() { this.used = 0; }
  take(x, y, scale, color, alpha) {
    let s = this.items[this.used++];
    if (!s) { s = this.scene.add.image(0, 0, 'glow').setBlendMode(this.blend).setDepth(this.depth); this.items.push(s); }
    return s.setPosition(x, y).setScale(scale).setTint(color).setAlpha(alpha).setVisible(true);
  }
  end() { for (let i = this.used; i < this.items.length; i++) this.items[i].setVisible(false); }
}

// Phones and tablets get a lighter garden: no full-screen vignette (post effects are the likeliest
// thing to fail on a mobile GPU) and fewer particles. ?fx=1 forces the full garden, ?lite=1 the
// light one; ?debug shows what the GPU is.
const params = new URLSearchParams(location.search);
const LITE = params.has('lite') || (!params.has('fx') && matchMedia('(pointer: coarse)').matches);
const DEBUG = params.has('debug');

// Problems that would otherwise leave a silent black garden are shown over it, so they can be read
// off any device.
const diag = document.createElement('div');
diag.id = 'diag';
document.getElementById('garden').appendChild(diag);
const diagLines = [];
function note(line) {
  diagLines.push(line);
  diag.textContent = diagLines.slice(-6).join('\n');
  diag.style.display = 'block';
}
addEventListener('error', (e) => note(`error: ${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`));
addEventListener('unhandledrejection', (e) => note(`error: ${e.reason?.message ?? e.reason}`));
// Phaser reports shader and framebuffer failures on the console rather than throwing.
for (const level of DEBUG ? ['error', 'warn'] : ['error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { note(`${level}: ${args.map(String).join(' ').slice(0, 240)}`); original(...args); };
}

// Each firefly's light keeps its own rhythm: 0 to 1 over time.
const bump = (p, c, w) => Math.exp(-(((p - c) / w) ** 2));
const FLASH = {
  'slow pulse': (t) => (0.5 - 0.5 * Math.cos((t / 2.6) * TAU)) ** 1.5,
  'quick double': (t) => { const p = (t % 2.2) / 2.2; return bump(p, 0.05, 0.045) + bump(p, 0.22, 0.045); },
  'long glow': (t) => { const p = (t % 4) / 4; return smooth(p / 0.15) * (1 - smooth((p - 0.55) / 0.2)); },
  'triple flicker': (t) => { const p = (t % 2.8) / 2.8; return bump(p, 0.03, 0.03) + bump(p, 0.15, 0.03) + bump(p, 0.27, 0.03); },
  'steady ember': (t) => 0.8 + 0.2 * Math.sin(t * 1.9),
};

// The color everything unlit is multiplied by: deep blue in the dark, silvered by moonlight, washed
// warm and bright in the pale.
function ambient(sky) {
  const moon = sky.light, rust = sky.eclipse * (sky.up ? 0.35 : 0);
  const r = 0.27 + 0.33 * moon + rust * 0.12, g = 0.31 + 0.37 * moon - rust * 0.04, b = 0.48 + 0.42 * moon - rust * 0.1;
  const p = sky.pale;
  const ch = (night, day) => Math.round(255 * clamp(night + (day - night) * p, 0, 1));
  return (ch(r, 1) << 16) | (ch(g, 0.93) << 8) | ch(b, 0.86);
}

class Garden extends Phaser.Scene {
  constructor() { super('garden'); }

  create() {
    this.makeTextures();
    this.drawBackdrop();
    this.ents = new Map();     // id -> merged entity state from snapshots
    this.views = new Map();    // id -> display objects
    this.bubbles = new Map();  // firefly id -> bubble
    this.state = { time: 0, at: performance.now() };
    this.top = { spiral: null, omens: [] };
    this.omensSeen = new Set();
    this.hovered = null;
    this.frame = 0;
    this.blooms = new GlowPool(this, DEPTH.bloom);
    this.floorGlow = new GlowPool(this, DEPTH.floorGlow);
    this.halos = new GlowPool(this, DEPTH.halo);
    if (!LITE) {
      // No bloom here: it greys the moon's face and the flowers, which are the brightest things in
      // the garden and carry their own glow sprites.
      try { this.cameras.main.filters.external.addVignette(0.5, 0.5, 0.95, 0.3); } catch (e) { note(`effects off: ${e.message}`); }
    }
    this.game.canvas.addEventListener('webglcontextlost', () => note('the GPU dropped the WebGL context; reload to try again'));
    if (DEBUG) this.showGpu();
    this.input.on('pointermove', (p) => (this.pointer = { x: p.event.clientX, y: p.event.clientY }));
    this.input.on('gameout', () => { this.hovered = null; });
    connect(this);
    if (import.meta.env.DEV || DEBUG) window.garden = this; // for poking at the scene from the console
  }

  showGpu() {
    const gl = this.game.renderer.gl;
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    note(`${LITE ? 'lite' : 'full'} · ${this.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas'} · ` +
      `${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER)} · ${innerWidth}x${innerHeight} @${devicePixelRatio}`);
  }

  // Garden time now: the last snapshot's, run on a little so the sky moves smoothly between them
  // (and stands still when the garden is paused and no more come).
  now() { return this.state.time + Math.min(0.3, (performance.now() - this.state.at) / 1000); }

  // ---------- textures and backdrop ----------

  makeTextures() {
    const canvas = (key, w, h, draw) => {
      const t = this.textures.createCanvas(key, w, h);
      draw(t.getContext(), w, h);
      t.refresh();
    };
    canvas('glow', 64, 64, (c) => {
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    });
    canvas('mote', 8, 8, (c) => {
      const g = c.createRadialGradient(4, 4, 0, 4, 4, 4);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 8, 8);
    });
    // The moon's face: pale, a little darker at the limb, with its seas.
    canvas('moon', 128, 128, (c) => {
      c.beginPath(); c.arc(64, 64, 63, 0, TAU); c.clip();
      const g = c.createRadialGradient(54, 52, 6, 64, 64, 64);
      g.addColorStop(0, '#fbfcff'); g.addColorStop(0.7, '#e6eaf8'); g.addColorStop(1, '#bcc4de');
      c.fillStyle = g; c.fillRect(0, 0, 128, 128);
      c.filter = 'blur(3px)';
      for (const [x, y, r, a] of [[44, 42, 17, 0.32], [70, 36, 12, 0.26], [58, 66, 15, 0.22], [86, 58, 11, 0.24], [40, 78, 10, 0.2], [78, 88, 14, 0.18], [96, 80, 7, 0.16]]) {
        c.fillStyle = `rgba(110,122,160,${a})`;
        c.beginPath(); c.ellipse(x, y, r, r * 0.8, x * 0.1, 0, TAU); c.fill();
      }
      c.filter = 'none';
    });
    canvas('cloud', 512, 192, (c) => {
      for (let i = 0; i < 26; i++) {
        const x = 70 + Math.random() * 372, y = 70 + Math.random() * 60 + Math.abs(x - 256) * 0.08, r = 34 + Math.random() * 46;
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
      }
    });
    // A firefly: a small dark beetle. Its light is drawn separately.
    canvas('fly', 28, 14, (c) => {
      c.fillStyle = '#17120e'; c.beginPath(); c.ellipse(13, 8, 9, 3.6, 0, 0, TAU); c.fill();
      c.fillStyle = '#3a2a1c'; c.beginPath(); c.ellipse(21, 7.5, 3.6, 3, 0, 0, TAU); c.fill();
      c.fillStyle = '#b98f52'; c.fillRect(18.2, 5.2, 1.4, 4.6);
      c.strokeStyle = '#3a2a1c'; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(23.5, 6); c.quadraticCurveTo(26, 2.5, 27.5, 3); c.moveTo(23.5, 7); c.quadraticCurveTo(26.5, 5, 27.5, 6.5); c.stroke();
    });
    canvas('wings', 22, 12, (c) => {
      c.fillStyle = 'rgba(210,225,255,0.55)';
      c.beginPath(); c.ellipse(8, 6, 8, 3.2, -0.25, 0, TAU); c.fill();
      c.beginPath(); c.ellipse(13, 6, 8, 3.2, 0.2, 0, TAU); c.fill();
    });
  }

  // Everything that stands still is painted once, as it looks in the pale's flat light, and tinted
  // down to night (see `ambient`) every frame.
  drawBackdrop() {
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const paint = (key, w, h, draw) => { const t = this.textures.createCanvas(key, w, h); draw(t.getContext()); t.refresh(); };
    const skyH = WORLD.ground + 4;

    paint('sky', W, skyH, (c) => {
      const g = c.createLinearGradient(0, 0, 0, skyH);
      g.addColorStop(0, '#03040c'); g.addColorStop(0.45, '#070b1f'); g.addColorStop(0.8, '#0d1430'); g.addColorStop(1, '#131c3c');
      c.fillStyle = g; c.fillRect(0, 0, W, skyH);
      // A faint band of star-dust across the sky.
      for (let i = 0; i < 1400; i++) {
        const k = Math.random(), x = k * W + rnd(-60, 60), y = 60 + k * 190 + (Math.random() + Math.random() - 1) * 70;
        c.fillStyle = `rgba(190,205,255,${rnd(0.02, 0.1)})`;
        c.fillRect(x, y, rnd(0.6, 1.6), rnd(0.6, 1.6));
      }
    });
    paint('pale', W, skyH, (c) => {
      const g = c.createLinearGradient(0, 0, 0, skyH);
      g.addColorStop(0, '#7f93b8'); g.addColorStop(0.55, '#c3b3b4'); g.addColorStop(0.85, '#f0cda4'); g.addColorStop(1, '#f6dcb4');
      c.fillStyle = g; c.fillRect(0, 0, W, skyH);
    });

    // The wall, and the crowns of whatever grows beyond it.
    const wallY = 230, top = WORLD.wallTop - wallY;
    paint('wall', W, WORLD.ground + 8 - wallY, (c) => {
      for (let i = 0; i < 15; i++) {
        const x = rnd(-20, W + 20), tall = Math.random() < 0.45, h = tall ? rnd(70, 135) : rnd(35, 80), w = tall ? rnd(16, 26) : rnd(50, 95);
        c.fillStyle = `rgb(${38 + rnd(0, 12)},${50 + rnd(0, 14)},${54 + rnd(0, 12)})`;
        c.beginPath(); c.ellipse(x, top + 10 - h / 2, w / 2, h / 2 + 12, 0, 0, TAU); c.fill();
        if (!tall) for (let j = 0; j < 3; j++) { c.beginPath(); c.ellipse(x + rnd(-w / 2, w / 2), top - h * rnd(0.3, 0.8), w * 0.3, h * 0.3, 0, 0, TAU); c.fill(); }
      }
      const body = c.createLinearGradient(0, top, 0, top + 160);
      body.addColorStop(0, '#84838f'); body.addColorStop(1, '#5a5b69');
      c.fillStyle = body; c.fillRect(0, top + 4, W, 170);
      for (let row = 0, y = top + 10; y < top + 164; row++, y += 15) {
        for (let x = row % 2 ? -22 : 0; x < W;) {
          const w = rnd(30, 58), shade = rnd(-16, 16);
          c.fillStyle = `rgb(${118 + shade - row * 3},${118 + shade - row * 3},${132 + shade - row * 3})`;
          c.fillRect(x + 1, y + 1, w - 2, 13);
          x += w;
        }
      }
      // Coping stones along the top, none quite level with its neighbor.
      for (let x = -10; x < W;) {
        const w = rnd(46, 80), lift = rnd(0, 4);
        c.fillStyle = `rgb(${146 + rnd(-10, 10)},${146 + rnd(-10, 10)},${160 + rnd(-10, 10)})`;
        c.fillRect(x + 1, top - lift, w - 2, 11 + lift);
        x += w;
      }
      // Moss and damp, heavier toward the foot.
      for (let i = 0; i < 90; i++) {
        const x = rnd(0, W), y = top + 20 + Math.random() ** 0.6 * 150, r = rnd(8, 34);
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${60 + rnd(0, 20)},${98 + rnd(0, 30)},${70},${rnd(0.12, 0.34)})`); g.addColorStop(1, 'rgba(60,100,70,0)');
        c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const foot = c.createLinearGradient(0, top + 110, 0, top + 170);
      foot.addColorStop(0, 'rgba(30,40,45,0)'); foot.addColorStop(1, 'rgba(30,40,45,0.55)');
      c.fillStyle = foot; c.fillRect(0, top + 110, W, 70);
    });

    // The ground: grass, the spiral bed with its path of pale stones, and the pond's basin.
    const groundY = WORLD.ground - 6;
    paint('ground', W, H - groundY, (c) => {
      const y0 = (y) => y - groundY;
      const g = c.createLinearGradient(0, 0, 0, H - groundY);
      g.addColorStop(0, '#668659'); g.addColorStop(0.12, '#7a9c68'); g.addColorStop(1, '#5f8355');
      c.fillStyle = g; c.fillRect(0, 0, W, H - groundY);
      for (let i = 0; i < 60; i++) {
        const x = rnd(0, W), y = rnd(10, H - groundY), r = rnd(40, 120);
        const p = c.createRadialGradient(x, y, 0, x, y, r);
        p.addColorStop(0, `rgba(${rnd(60, 110)},${rnd(90, 130)},${rnd(60, 80)},0.2)`); p.addColorStop(1, 'rgba(80,110,70,0)');
        c.fillStyle = p; c.save(); c.translate(x, y); c.scale(1, 0.35); c.translate(-x, -y); c.fillRect(x - r, y - r, r * 2, r * 2); c.restore();
      }
      // The spiral's bed: turned earth.
      const bed = c.createRadialGradient(SPIRAL.x, 0, 20, SPIRAL.x, 0, SPIRAL.rx + 26);
      bed.addColorStop(0, '#6b5a4c'); bed.addColorStop(0.85, '#5d4f44'); bed.addColorStop(1, 'rgba(93,79,68,0)');
      c.save(); c.translate(0, y0(SPIRAL.y)); c.scale(1, SPIRAL.ry / SPIRAL.rx);
      c.fillStyle = bed; c.beginPath(); c.arc(SPIRAL.x, 0, SPIRAL.rx + 26, 0, TAU); c.fill(); c.restore();
      // The pond.
      c.fillStyle = '#8f8f9c';
      for (let a = 0; a < TAU; a += rnd(0.1, 0.17)) {
        c.beginPath(); c.ellipse(POND.x + Math.cos(a) * (POND.rx + 5), y0(POND.y) + Math.sin(a) * (POND.ry + 4), rnd(5, 10), rnd(2.5, 4.5), 0, 0, TAU); c.fill();
      }
      const water = c.createLinearGradient(0, y0(POND.y - POND.ry), 0, y0(POND.y + POND.ry));
      water.addColorStop(0, '#3c4d78'); water.addColorStop(1, '#1d2748');
      c.fillStyle = water; c.beginPath(); c.ellipse(POND.x, y0(POND.y), POND.rx, POND.ry, 0, 0, TAU); c.fill();
      // Grass, everywhere but the bed and the water.
      for (let i = 0; i < 5200; i++) {
        const x = rnd(0, W), y = rnd(groundY + 4, H);
        const inBed = ((x - SPIRAL.x) / (SPIRAL.rx + 10)) ** 2 + ((y - SPIRAL.y) / (SPIRAL.ry + 4)) ** 2 < 1;
        const inWater = ((x - POND.x) / (POND.rx + 2)) ** 2 + ((y - POND.y) / (POND.ry + 1)) ** 2 < 1;
        if (inBed || inWater) continue;
        const k = (y - groundY) / (H - groundY), len = 3 + 9 * k * Math.random() + 2;
        c.strokeStyle = `rgba(${84 + rnd(0, 56)},${128 + rnd(0, 56)},${80 + rnd(0, 34)},${rnd(0.35, 0.8)})`;
        c.lineWidth = 0.7 + k;
        c.beginPath(); c.moveTo(x, y0(y)); c.lineTo(x + rnd(-2.5, 2.5), y0(y) - len); c.stroke();
      }
      // The spiral's path, stone by stone, and a ring of darker earth at each plot.
      for (let k = 0.012; k <= 1; k += 0.0064) {
        const p = spiralPoint(k), s = 0.6 + 0.5 * ((p.y - WORLD.ground) / (H - WORLD.ground));
        c.fillStyle = `rgb(${186 + rnd(-22, 22)},${186 + rnd(-22, 22)},${200 + rnd(-18, 18)})`;
        c.beginPath(); c.ellipse(p.x + rnd(-2, 2), y0(p.y + 5 * s) + rnd(-1, 1), rnd(3, 5.2) * s, rnd(1.6, 2.6) * s, rnd(-0.4, 0.4), 0, TAU); c.fill();
      }
      for (let i = 0; i < SPIRAL.plots; i++) {
        const p = plotPos(i), s = 0.6 + 0.5 * ((p.y - WORLD.ground) / (H - WORLD.ground));
        c.fillStyle = 'rgba(52,40,34,0.75)';
        c.beginPath(); c.ellipse(p.x, y0(p.y), 11 * s, 4.2 * s, 0, 0, TAU); c.fill();
      }
      // A stone lantern between the bed and the pond; nobody has lit it in a long time.
      const lx = LANTERN.x, ly = y0(LANTERN.y);
      c.fillStyle = '#8a8c98';
      c.fillRect(lx - 14, ly - 5, 28, 5); c.fillRect(lx - 4, ly - 30, 8, 26); c.fillRect(lx - 12, ly - 34, 24, 5);
      c.fillRect(lx - 9, ly - 50, 18, 16);
      c.beginPath(); c.moveTo(lx - 19, ly - 50); c.quadraticCurveTo(lx, ly - 66, lx + 19, ly - 50); c.closePath(); c.fill();
      c.fillRect(lx - 2, ly - 68, 4, 6);
      c.fillStyle = '#2a2c38'; c.fillRect(lx - 4, ly - 46, 8, 9);
      c.fillStyle = 'rgba(70,110,75,0.5)'; c.fillRect(lx - 14, ly - 6, 12, 3); c.fillRect(lx + 2, ly - 36, 9, 2);
      // The foot of the wall sinks into shadow and weeds.
      const shade = c.createLinearGradient(0, 0, 0, 26);
      shade.addColorStop(0, 'rgba(24,34,36,0.75)'); shade.addColorStop(1, 'rgba(24,34,36,0)');
      c.fillStyle = shade; c.fillRect(0, 0, W, 26);
    });

    this.add.image(0, 0, 'sky').setOrigin(0, 0).setDepth(DEPTH.sky);
    this.paleSky = this.add.image(0, 0, 'pale').setOrigin(0, 0).setDepth(DEPTH.pale).setAlpha(0);
    this.wall = this.add.image(0, wallY, 'wall').setOrigin(0, 0).setDepth(DEPTH.wall);
    this.ground = this.add.image(0, groundY, 'ground').setOrigin(0, 0).setDepth(DEPTH.ground);

    this.stars = Array.from({ length: LITE ? 130 : 280 }, () => {
      const bright = Math.random() < 0.12;
      return this.add.image(Math.random() * W, Math.random() ** 0.8 * (WORLD.wallTop + 10), 'mote').setDepth(DEPTH.stars).setBlendMode(Phaser.BlendModes.ADD)
        .setScale(bright ? 0.9 + Math.random() * 0.6 : 0.3 + Math.random() * 0.45).setTint([0xdfe7ff, 0xfff1d8, 0xcfe0ff, 0xffffff][Math.floor(Math.random() * 4)])
        .setData({ a: bright ? 1 : 0.45 + Math.random() * 0.5, sp: 0.5 + Math.random() * 2.2, ph: Math.random() * 10 });
    });
    this.streaks = [];
    this.fx = this.add.graphics().setDepth(DEPTH.streak).setBlendMode(Phaser.BlendModes.ADD);

    this.moonGlow = [this.add.image(0, 0, 'glow').setScale(10), this.add.image(0, 0, 'glow').setScale(3.4)]
      .map((g) => g.setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.moonGlow));
    this.moon = this.add.image(0, 0, 'moon').setDepth(DEPTH.moon).setScale((MOON.radius * 2) / 128);
    this.moon.setInteractive(new Phaser.Geom.Circle(64, 64, 80), Phaser.Geom.Circle.Contains);
    this.moon.on('pointerover', () => { this.hovered = 'sky'; this.input.setDefaultCursor('pointer'); });
    this.moon.on('pointerout', () => { if (this.hovered === 'sky') this.hovered = null; this.input.setDefaultCursor('default'); });
    this.moon.on('pointerdown', () => openProfile('sky'));
    this.moonShade = this.add.graphics().setDepth(DEPTH.moon + 0.01);
    this.clouds = Array.from({ length: 6 }, () => ({
      body: this.add.image(0, 0, 'cloud').setDepth(DEPTH.clouds),
      lining: this.add.image(0, 0, 'cloud').setDepth(DEPTH.clouds + 0.01).setBlendMode(Phaser.BlendModes.ADD),
    }));
    this.veil = this.add.rectangle(W / 2, skyH / 2, W, skyH, 0x10152c).setDepth(DEPTH.clouds + 0.02).setAlpha(0);

    this.mist = Array.from({ length: LITE ? 3 : 6 }, (_, i) => this.add.image(Math.random() * W, WORLD.ground + 4 + i * 5, 'glow').setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(DEPTH.mist + (i > 2 ? 1.2 : 0)).setScale(16 + Math.random() * 10, 1.4 + Math.random()).setData({ vx: (Math.random() - 0.5) * 8 }));
    this.pond = this.add.graphics().setDepth(DEPTH.pond);
    this.ripples = [];
    this.pondStars = Array.from({ length: 12 }, () => { const a = Math.random() * TAU, k = Math.sqrt(Math.random()) * 0.85; return { x: POND.x + Math.cos(a) * POND.rx * k, y: POND.y + Math.sin(a) * POND.ry * k, ph: Math.random() * 10 }; });
    this.rain = this.add.graphics().setDepth(DEPTH.rain);
    this.drops = Array.from({ length: LITE ? 70 : 150 }, () => ({ x: Math.random() * W, y: Math.random() * H, v: 520 + Math.random() * 260 }));
    this.bokeh = Array.from({ length: LITE ? 3 : 8 }, () => this.add.image(Math.random() * W, 380 + Math.random() * 340, 'glow')
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.bokeh).setScale(2.5 + Math.random() * 4).setAlpha(0.015 + Math.random() * 0.03)
      .setTint([0xdff27a, 0xa7b8ff, 0x9ff2c8][Math.floor(Math.random() * 3)]).setData({ vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 3 }));
    // The whole bed can be opened like any entry; plants on it take the pointer first.
    const bed = this.add.zone(SPIRAL.x, SPIRAL.y, SPIRAL.rx * 2, SPIRAL.ry * 2).setDepth(DEPTH.pond)
      .setInteractive(new Phaser.Geom.Ellipse(SPIRAL.rx, SPIRAL.ry, SPIRAL.rx * 2, SPIRAL.ry * 2), Phaser.Geom.Ellipse.Contains);
    bed.on('pointerover', () => { this.hovered = 'spiral'; this.input.setDefaultCursor('pointer'); });
    bed.on('pointerout', () => { if (this.hovered === 'spiral') this.hovered = null; this.input.setDefaultCursor('default'); });
    bed.on('pointerdown', () => openProfile('spiral'));
    this.sparks = [];
    this.sparkFree = [];
  }

  // A short-lived glow that drifts and fades: the dashes of a firefly's trail, pollen, light
  // pouring up from the Flowering.
  spark(x, y, vx, vy, life, scale, color, alpha) {
    if (this.sparks.length > (LITE ? 220 : 520)) return;
    const img = (this.sparkFree.pop() ?? this.add.image(0, 0, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.sparks))
      .setPosition(x, y).setScale(scale).setTint(color).setAlpha(alpha).setVisible(true);
    this.sparks.push({ img, vx, vy, life, max: life, alpha, scale });
  }

  // ---------- entities ----------

  interactive(obj, id) {
    obj.on('pointerover', () => { this.hovered = id; this.input.setDefaultCursor('pointer'); });
    obj.on('pointerout', () => { if (this.hovered === id) this.hovered = null; this.input.setDefaultCursor('default'); });
    obj.on('pointerdown', () => openProfile(id));
    return obj;
  }

  spawn(e) {
    const v = { kind: e.kind };
    if (e.kind === 'plant') {
      v.g = this.interactive(this.add.graphics({ x: e.x, y: e.y }).setDepth(DEPTH.plant + e.y / 1000).setScale(e.scale ?? 1), e.id);
      v.open = e.open ? 1 : 0;
    } else if (e.kind === 'seed') {
      v.img = this.add.image(e.x, e.y, 'mote').setDepth(DEPTH.seed).setBlendMode(Phaser.BlendModes.ADD).setTint(hsl(e.hue, 0.7, 0.8));
      v.ex = e.x; v.ey = e.y;
    } else if (e.kind === 'firefly') {
      v.wings = this.add.image(e.x, e.y, 'wings').setDepth(DEPTH.fly - 0.1);
      v.img = this.interactive(this.add.image(e.x, e.y, 'fly').setDepth(DEPTH.fly), e.id);
      v.img.setInteractive(new Phaser.Geom.Circle(13, 7, 17), Phaser.Geom.Circle.Contains);
      v.lamp = this.add.image(e.x, e.y, 'glow').setDepth(DEPTH.fly + 0.1).setBlendMode(Phaser.BlendModes.ADD);
      v.core = this.add.image(e.x, e.y, 'mote').setDepth(DEPTH.fly + 0.2).setBlendMode(Phaser.BlendModes.ADD);
      v.seed = this.add.image(e.x, e.y, 'mote').setDepth(DEPTH.fly + 0.2).setVisible(false);
      v.label = this.add.text(e.x, e.y, e.name, { fontFamily: 'Inter, sans-serif', fontSize: '11px', color: '#b9c4e6' })
        .setOrigin(0.5, 0).setDepth(DEPTH.label).setAlpha(0.65);
      v.dots = this.add.text(e.x, e.y, '• • •', { fontFamily: 'Inter, sans-serif', fontSize: '10px', color: '#e6ecff' })
        .setOrigin(0.5, 1).setDepth(DEPTH.label);
      v.ex = e.x; v.ey = e.y;
    }
    return v;
  }

  destroyView(v) {
    for (const k of ['g', 'img', 'wings', 'lamp', 'core', 'seed', 'label', 'dots']) v[k]?.destroy();
  }

  // Snapshots are deltas (server/delta.js): each entity carries only the fields that changed, except
  // in the first one after connecting, which holds everything.
  onSnapshot(snap) {
    this.state = { time: snap.time, at: performance.now() };
    if (snap.full) { this.ents.clear(); this.omensSeen.clear(); }
    const seen = new Set();
    for (const e of snap.entities) {
      seen.add(e.id);
      const prev = this.ents.get(e.id);
      const ent = prev ? Object.assign(prev, e) : e;
      this.ents.set(e.id, ent);
      if (!this.views.has(e.id)) this.views.set(e.id, this.spawn(ent));
    }
    for (const [id, v] of this.views) if (!seen.has(id)) {
      this.destroyView(v);
      this.views.delete(id);
      const e = this.ents.get(id);
      if (e?.kind === 'firefly') {
        departed.set(id, e); // the profile can still show who it was
        if (departed.size > 50) departed.delete(departed.keys().next().value);
      }
      this.ents.delete(id);
      this.bubbles.get(id)?.el.remove();
      this.bubbles.delete(id);
      if (this.hovered === id) this.hovered = null;
    }
    Object.assign(this.top, snap.top);
    for (const o of this.top.omens ?? []) {
      if (this.omensSeen.has(o.id)) continue;
      this.omensSeen.add(o.id);
      if (snap.time - o.at < 5) this.omen(o);
    }
    updateStatus(this);
    // The sidebar is rebuilt at most once a second (its ages tick in seconds).
    const now = performance.now();
    if (snap.full || now - (this.panelAt ?? 0) > 1000) {
      this.panelAt = now;
      renderCodex(this);
      renderProfile(this);
    }
  }

  // Something brief happened: a star fell, something touched the pond, the Flowering began.
  omen(o) {
    if (o.kind === 'star') this.streaks.push({ ...o, t: 0 });
    else if (o.kind === 'ripple') for (let i = 0; i < 3; i++) this.ripples.push({ x: o.x, y: o.y, age: -i * 0.5, life: 4 });
    else if (o.kind === 'flowering') {
      for (let i = 0; i < SPIRAL.plots; i++) {
        const p = plotPos(i);
        for (let j = 0; j < 5; j++) this.spark(p.x, p.y - 20, (Math.random() - 0.5) * 60, -30 - Math.random() * 70, 3 + Math.random() * 2, 0.25, 0xf6f2c8, 0.8);
      }
    }
  }

  // ---------- frame ----------

  update(time, dtMs) {
    const t = time / 1000;
    const dt = Math.min(0.1, dtMs / 1000);
    this.frame++;
    tickClock();
    const sky = skyAt(this.now());
    this.sky = sky;
    this.animateSky(sky, t, dt);
    this.animateGround(sky, t, dt);
    this.blooms.begin(); this.floorGlow.begin(); this.halos.begin();
    const k = 1 - Math.exp(-dtMs / 90);
    // The wind as plants feel it: the sky's, eased so a gust rolls in rather than snapping.
    this.wind = (this.wind ?? 0) + (sky.wind - (this.wind ?? 0)) * Math.min(1, dt * 2);
    const moon = sky.up && sky.cover < 0.9 ? { x: sky.x, y: sky.y } : null;
    for (const [id, v] of this.views) {
      const e = this.ents.get(id);
      if (!e) continue;
      if (e.kind === 'plant') this.drawPlantView(e, v, t, dt, sky, moon);
      else if (e.kind === 'firefly') this.drawFly(e, v, t, dt, k, sky);
      else if (e.kind === 'seed') {
        v.ex += (e.x - v.ex) * k; v.ey += (e.y - v.ey) * k;
        v.img.setPosition(v.ex, v.ey).setScale(0.55 + 0.2 * Math.sin(t * 3 + e.id)).setAlpha(0.85);
      }
    }
    this.flowering(t, dt);
    this.blooms.end(); this.floorGlow.end(); this.halos.end();
    this.updateBubbles();
    this.renderTip();
  }

  animateSky(sky, t, dt) {
    const night = 1 - sky.pale, veil = smooth((sky.cloudiness - 0.75) / 0.2) * 0.7;
    this.paleSky.setAlpha(sky.pale * 0.92);
    const dim = night * (1 - 0.5 * sky.light) * (1 - veil);
    for (const s of this.stars) {
      const d = s.data.values;
      s.x -= dt * 0.5;
      if (s.x < -4) s.x = W + 4;
      s.setAlpha(d.a * dim * (0.65 + 0.35 * Math.sin(t * d.sp + d.ph)));
    }

    // The moon: its whole face, with the part the sun doesn't reach painted over in sky.
    const shown = sky.m > -0.1 && sky.m < 1.1;
    const rust = sky.eclipse;
    const face = mix(0xffffff, 0xb4552e, rust * 0.92);
    const seen = night * (1 - 0.8 * sky.cover);
    this.moon.setVisible(shown).setPosition(sky.x, sky.y).setTint(face).setAlpha(0.3 + 0.7 * night);
    this.moonShade.clear().setVisible(shown).setPosition(sky.x, sky.y);
    if (shown && sky.lit < 0.995) this.moonShade.fillStyle(mix(0x080c20, 0x9fa9c4, sky.pale * 0.9), 0.93).fillPoints(darkShape(sky.phase, MOON.radius + 0.7, 18), true);
    const glowTint = mix(0xcfdcff, 0xd0603a, rust);
    const power = sky.lit * seen * (1 - 0.6 * rust);
    this.moonGlow[0].setVisible(shown).setPosition(sky.x, sky.y).setTint(glowTint).setAlpha(0.24 * power);
    this.moonGlow[1].setVisible(shown).setPosition(sky.x, sky.y).setTint(glowTint).setAlpha(0.7 * power);
    this.fx.clear();
    if (shown && sky.halo && night > 0.5) this.fx.lineStyle(5, 0xcfdcff, 0.05 * sky.lit * seen).strokeCircle(sky.x, sky.y, 92).lineStyle(1.5, 0xe6ecff, 0.09 * sky.lit * seen).strokeCircle(sky.x, sky.y, 90);

    // Falling stars.
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      s.t += dt / 0.9;
      if (s.t > 1.4) { this.streaks.splice(i, 1); continue; }
      const head = Math.min(1, s.t), tail = Math.max(0, s.t - 0.4);
      const px = (k) => s.x + (s.x2 - s.x) * k, py = (k) => s.y + (s.y2 - s.y) * k;
      for (let j = 0; j < 6; j++) {
        const a = tail + ((head - tail) * j) / 6, b = tail + ((head - tail) * (j + 1)) / 6;
        this.fx.lineStyle(0.6 + j * 0.35, 0xf2f6ff, ((j + 1) / 6) * night * (s.t > 1 ? 1 - (s.t - 1) / 0.4 : 1)).lineBetween(px(a), py(a), px(b), py(b));
      }
    }

    // Clouds drift west; near the moon their edges catch its light.
    const banks = cloudsAt(this.now());
    this.clouds.forEach((c, i) => {
      const b = banks[i];
      const sx = (b.w / 512) * 1.5, sy = 0.9 + (i % 3) * 0.15;
      // Banks are a shade lighter than the sky, and silvered when there's a moon to light them.
      c.body.setPosition(b.x, b.y).setScale(sx, sy).setAlpha(b.alpha * 0.9 * (1 - 0.6 * sky.pale)).setTint(mix(mix(0x1a2142, 0x4b5682, power), 0xb9b3bd, sky.pale));
      const near = shown ? clamp(1 - Math.hypot(b.x - sky.x, (b.y - sky.y) * 2) / (b.w * 0.9), 0, 1) : 0;
      c.lining.setPosition(b.x, b.y).setScale(sx, sy).setTint(glowTint).setAlpha(b.alpha * near * 0.3 * sky.lit * night);
    });
    this.veil.setFillStyle(mix(0x171d3a, 0x3a446e, power)).setAlpha(veil * 0.85 * night);

    const amb = ambient(sky);
    this.wall.setTint(amb);
    this.ground.setTint(amb);
  }

  animateGround(sky, t, dt) {
    const night = 1 - sky.pale;
    for (const m of this.mist) {
      m.x += (m.getData('vx') + sky.wind * 14) * dt;
      if (m.x < -500) m.x = W + 500; else if (m.x > W + 500) m.x = -500;
      m.setTint(mix(0x7f8fc8, 0xdfe7ff, sky.light)).setAlpha((0.03 + 0.05 * sky.light + (sky.halo ? 0.035 : 0) + sky.rain * 0.05) * (0.4 + 0.6 * night));
    }
    for (const b of this.bokeh) {
      b.x += b.getData('vx') * dt; b.y += b.getData('vy') * dt;
      if (b.x < -150) b.x = W + 150; else if (b.x > W + 150) b.x = -150;
      if (b.y < 300) b.y = H + 100; else if (b.y > H + 120) b.y = 320;
    }

    // The pond: a sheen of sky, the moon lying in it, a few stars, and rings.
    const g = this.pond.clear();
    g.fillStyle(mix(0x1a2550, 0xc8d4f0, 0.15 + 0.45 * sky.light + 0.5 * sky.pale), 0.2 + 0.25 * sky.light + 0.3 * sky.pale).fillEllipse(POND.x, POND.y - 3, POND.rx * 1.9, POND.ry * 1.5);
    for (const s of this.pondStars) g.fillStyle(0xe6ecff, 0.5 * night * (1 - sky.cloudiness) * Math.max(0, Math.sin(t * 1.3 + s.ph)) ** 3).fillCircle(s.x, s.y, 0.9);
    if (sky.up && sky.cover < 0.9) {
      // It lies on the side of the pond it stands on in the sky, and shivers.
      const mx = POND.x + clamp((sky.x - W / 2) / 640, -1, 1) * POND.rx * 0.5, my = POND.y - 2;
      const power = night * sky.lit ** 0.6 * (1 - 0.8 * sky.cover);
      const color = mix(0xe6ecff, 0xd0603a, sky.eclipse);
      // Rings from a touch break it up for a few breaths.
      const broken = this.ripples.some((r) => r.age > 0 && r.age < 2.5 && Math.abs(r.x - mx) < 40) ? 1 : 0;
      for (let i = -3; i <= 3; i++) {
        const w = (34 - Math.abs(i) * 6) * (0.35 + 0.65 * sky.lit) * (1 - broken * 0.5), shake = Math.sin(t * (1.6 + broken * 6) + i * 1.3) * (1.6 + broken * 7);
        g.fillStyle(color, power * (0.75 - Math.abs(i) * 0.14)).fillEllipse(mx + shake + (sky.waxing ? 1 : -1) * (1 - sky.lit) * 5, my + i * 3.6, w, 2.8);
      }
    }
    if (sky.rain > 0.05 && Math.random() < dt * 40 * sky.rain) {
      const a = Math.random() * TAU, k = Math.sqrt(Math.random()) * 0.9;
      this.ripples.push({ x: POND.x + Math.cos(a) * POND.rx * k, y: POND.y + Math.sin(a) * POND.ry * k, age: 0, life: 1.6, small: true });
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      if (r.age > r.life) { this.ripples.splice(i, 1); continue; }
      if (r.age < 0) continue;
      const rad = r.age * (r.small ? 9 : 20), a = (1 - r.age / r.life) * (r.small ? 0.35 : 0.6);
      // Rings stay on the water.
      if (((r.x - POND.x) / POND.rx) ** 2 + ((r.y - POND.y) / POND.ry) ** 2 < 1.1) g.lineStyle(1, 0xdfe7ff, a * (0.4 + 0.6 * Math.max(sky.light, sky.pale, 0.3))).strokeEllipse(r.x, r.y, rad * 2, rad * 0.5);
    }

    // Rain, slanting with the wind.
    this.rain.clear();
    if (sky.rain > 0.02) {
      const n = Math.round(this.drops.length * sky.rain), slant = sky.wind * 90;
      this.rain.lineStyle(1, 0xc8d4f0, 0.12 + 0.2 * sky.rain);
      for (let i = 0; i < n; i++) {
        const d = this.drops[i];
        d.y += d.v * dt; d.x += slant * dt;
        if (d.y > H) { d.y = -20; d.x = Math.random() * (W + 200) - 100; }
        this.rain.lineBetween(d.x, d.y, d.x - slant * 0.03, d.y - 14);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.life -= dt;
      if (p.life <= 0) { this.sparkFree.push(p.img.setVisible(false)); this.sparks.splice(i, 1); continue; }
      const k = p.life / p.max;
      p.img.setPosition(p.img.x + p.vx * dt, p.img.y + p.vy * dt).setAlpha(p.alpha * k).setScale(p.scale * (0.5 + 0.5 * k));
    }
  }

  // While the spiral is in its Flowering, light pours up out of every plot.
  flowering(t, dt) {
    const sp = this.top.spiral;
    if (!sp || sp.floweringAt == null) return;
    for (const id of sp.plots) {
      const e = this.ents.get(id);
      if (!e?.genome || Math.random() > dt * 2.2) continue;
      this.spark(e.x + (Math.random() - 0.5) * 16, e.y - e.genome.height * e.scale * 0.8, (Math.random() - 0.5) * 10 + this.wind * 12, -22 - Math.random() * 40,
        4 + Math.random() * 3, 0.1 + Math.random() * 0.1, hsl(e.genome.hue2, e.genome.sat, 0.75), 0.8);
    }
    this.halos.take(SPIRAL.x, SPIRAL.y - 150, 9, 0xf2ecc0, 0.05 + 0.02 * Math.sin(t * 1.3)).setScale(9, 12);
    this.floorGlow.take(SPIRAL.x, SPIRAL.y, 1, 0xf2ecc0, 0.16 + 0.04 * Math.sin(t * 2)).setScale(SPIRAL.rx / 26, SPIRAL.ry / 22);
  }

  drawPlantView(e, v, t, dt, sky, moon) {
    if (!e.genome) return;
    const g = e.genome;
    // Flowers ease open and shut over a few seconds.
    v.open += ((e.open ? 1 : 0) - v.open) * Math.min(1, dt / 1.6);
    // Plants are redrawn every other frame, half of them each time; that's plenty for a sway.
    if ((this.frame + e.id) % 2 === 0 || v.fresh !== e.growth) {
      v.fresh = e.growth;
      v.g.setPosition(e.x, e.y).setScale(e.scale ?? 1);
      this.plantEnv ??= {};
      Object.assign(this.plantEnv, { open: v.open, wind: this.wind, moon, light: Math.max(sky.light, sky.pale * 0.8), lite: LITE, glows: null });
      v.glows = [];
      drawPlant(v.g, { take: (x, y, s, c, a) => { v.glows.push([x, y, s, c, a]); } }, e, g, t + e.id * 3.1, this.plantEnv);
    }
    for (const [x, y, s, c, a] of v.glows ?? []) this.blooms.take(x, y, s, c, a);
    const alive = (1 - (e.wither ?? 0)) * (1 - (e.fade ?? 0));
    // A pool of light on the ground under everything that's open.
    if (v.open > 0.05 && g.form !== 'lily') this.floorGlow.take(e.x, e.y + 2, 1, hsl(g.hue2, g.sat, 0.55), 0.1 * g.glow * v.open * alive).setScale((1.4 + g.height / 60) * (e.scale ?? 1), 0.5);
    if (e.state === 'seeding' && Math.random() < dt * 0.5) {
      this.spark(e.x + (Math.random() - 0.5) * 20, e.y - g.height * e.scale * (0.5 + Math.random() * 0.4), this.wind * 14, -5 - Math.random() * 6, 2.5, 0.05, 0xe6ecff, 0.5);
    }
    if (!v.bounds || Math.abs(v.boundsGrowth - e.growth) > 0.05) {
      v.bounds = plantBounds(g, e.growth);
      v.boundsGrowth = e.growth;
      const r = new Phaser.Geom.Rectangle(v.bounds.x, v.bounds.y, v.bounds.w, v.bounds.h);
      if (v.g.input) v.g.input.hitArea = r;
      else v.g.setInteractive(r, Phaser.Geom.Rectangle.Contains);
    }
  }

  drawFly(e, v, t, dt, k, sky) {
    v.ex += (e.x - v.ex) * k;
    v.ey += (e.y - v.ey) * k;
    // Lower on the screen is nearer, so a little larger.
    const size = 0.95 + 0.5 * clamp((v.ey - 320) / 380, 0, 1);
    const speed = Math.hypot(e.vx ?? 0, e.vy ?? 0);
    const x = v.ex, y = v.ey + (e.perched ? 0 : Math.sin(t * 2.3 + e.id) * 2.5);
    const speaking = e.said && this.state.time - e.said.at < 6;
    const selected = profileId === e.id;
    let light = 0.2 + 0.8 * Math.min(1, (FLASH[e.flash] ?? FLASH['slow pulse'])(t + e.id * 0.37));
    if (speaking) light = 0.8 + 0.2 * Math.sin(t * 9 + e.id);
    if (e.waking) light = 1.3;
    if (e.perched) light *= 0.4;
    if (e.age < 5) light *= 0.25 + 0.15 * e.age;
    if (e.leaving) light *= clamp((v.ey + 40) / 320, 0.2, 1);
    light *= 1 - 0.5 * sky.pale;
    const color = hexToInt(e.glow);
    v.img.setPosition(x, y).setFlipX(e.facing < 0).setScale(size).setRotation(clamp((e.vy ?? 0) / 160, -0.4, 0.4) * (e.facing < 0 ? -1 : 1))
      .setTint(mix(0x6a7088, 0xffffff, Math.max(sky.light, sky.pale)));
    v.wings.setPosition(x + e.facing * 1.5 * size, y - 4.5 * size).setScale(size, size * (0.3 + 0.7 * Math.abs(Math.sin(t * 42 + e.id)))).setAlpha(e.perched ? 0 : 0.32);
    const lx = x - e.facing * 7 * size, ly = y + 1.5 * size;
    v.lamp.setPosition(lx, ly).setScale(0.5 * size * (0.7 + 0.5 * light)).setTint(color).setAlpha(Math.min(1, light));
    v.core.setPosition(lx, ly).setScale(0.75 * size).setAlpha(Math.min(1, light * 0.9));
    this.halos.take(lx, ly, size * (1.3 + 1.1 * light) * (e.waking ? 1.6 : 1), color, 0.24 * light + (selected ? 0.07 : 0));
    // Low over the grass, its light pools on the ground.
    if (v.ey > WORLD.ground - 30) this.floorGlow.take(lx, Math.max(ly + 14, WORLD.ground + 6), 1, color, 0.07 * light).setScale(2.2 * size, 0.5);
    v.seed.setVisible(e.carrying != null).setPosition(x + e.facing * 3 * size, y + 6 * size);
    if (e.carrying != null) v.seed.setTint(hsl(e.carrying, 0.7, 0.8));
    v.label.setPosition(x, y + 9 * size).setAlpha(e.leaving ? 0 : selected ? 1 : 0.75);
    v.dots.setPosition(x, y - 10 * size).setVisible(e.brain === 'thinking').setAlpha(0.45 + 0.4 * Math.sin(t * 4));
    v.screenTop = y - 12 * size;
    v.lampAt = { x: lx, y: ly, light };
    // A moving firefly draws its flashes on the dark as dashes of light.
    if (speed > 10 && light > 0.55 && t - (v.trailAt ?? 0) > 0.04) {
      v.trailAt = t;
      this.spark(lx, ly, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 1.3, 0.12 * size, color, 0.5 * light);
    }
    // Pollen sifts off one that has been at the flowers.
    if (e.pollen != null && speed > 10 && Math.random() < dt * 2.5) this.spark(x, y + 3, (Math.random() - 0.5) * 6, 6 + Math.random() * 6, 1.6, 0.04, hsl(e.pollen, 0.8, 0.75), 0.6);
    // Its light lies on the pond when it flies over the water.
    if (Math.abs(lx - POND.x) < POND.rx * 0.9 && ly < POND.y && ly > POND.y - 260) {
      this.floorGlow.take(lx, POND.y + (POND.y - ly) * 0.08 - 6, 1, color, 0.3 * light * (1 - (POND.y - ly) / 260)).setScale(0.5 * size, 0.2);
    }
  }

  // ---------- speech ----------

  toScreen(x, y) {
    const r = this.game.canvas.getBoundingClientRect(), box = bubbleLayer.getBoundingClientRect();
    return { x: r.left - box.left + (x / W) * r.width, y: r.top - box.top + (y / H) * r.height };
  }

  updateBubbles() {
    const now = performance.now();
    for (const [id, e] of this.ents) {
      if (e.kind !== 'firefly' || !e.said) continue;
      let b = this.bubbles.get(id);
      if (b?.at === e.said.at) continue;
      if (this.state.time - e.said.at > 20) continue; // old news, e.g. on first connect
      b?.el.remove();
      const el = document.createElement('div');
      el.className = 'bubble';
      el.style.setProperty('--c', e.glow ?? '#dff27a');
      el.innerHTML = `<b>${esc(e.name)}${e.said.to ? ` → ${esc(e.said.to)}` : ''}</b>${esc(e.said.text)}`;
      bubbleLayer.appendChild(el);
      // As long as the sim holds the floor for it (readTime in server/sim.js), so it can be read.
      b = { el, at: e.said.at, until: now + 1000 * Math.max(4, Math.min(20, 2.5 + e.said.text.length / 16)) };
      this.bubbles.set(id, b);
    }
    // Place each bubble over its firefly, then nudge overlapping ones apart vertically.
    const placed = [];
    for (const [id, b] of this.bubbles) {
      const v = this.views.get(id);
      if (!v || now > b.until + 900) { b.el.remove(); this.bubbles.delete(id); continue; }
      b.el.style.opacity = now > b.until ? '0' : '1';
      const p = this.toScreen(v.ex, v.screenTop ?? v.ey);
      // Bubbles shrink with the garden (never grow past their own size), so on a phone they stay
      // small and sit on their firefly instead of crowding it off the screen.
      const k = Math.min(1, this.game.canvas.getBoundingClientRect().width / W);
      b.el.style.transform = `translate(-50%, -100%) scale(${k})`;
      const w = b.el.offsetWidth * k, h = b.el.offsetHeight * k;
      const boxW = bubbleLayer.clientWidth;
      let x = clamp(p.x, w / 2 + 4, boxW - w / 2 - 4), y = Math.max(h + 4, p.y - 10 * k);
      for (const o of placed) if (Math.abs(o.x - x) < (o.w + w) / 2 && y > o.y - o.h - 6 && y - h < o.y + 6) y = o.y - o.h - 8;
      placed.push({ x, y, w, h });
      // Slid away from its firefly (one at the very edge): the tail would point at nothing.
      b.el.classList.toggle('detached', Math.abs(x - p.x) > w / 2 - 10);
      b.el.style.left = `${x}px`;
      b.el.style.top = `${y}px`;
    }
  }

  // ---------- hover tooltip ----------

  renderTip() {
    const e = this.hovered === 'sky' || this.hovered === 'spiral' ? { kind: this.hovered } : this.hovered != null && this.ents.get(this.hovered);
    const html = e && this.pointer && TIPS[e.kind]?.(e, this);
    if (!html) { tip.style.display = 'none'; return; }
    tip.style.setProperty('--c', e.glow ?? (e.genome ? flowerColor(e.genome) : '#dfe7ff'));
    if (tip.dataset.html !== html) { tip.innerHTML = html; tip.dataset.html = html; }
    tip.style.display = 'block';
    // Beside the pointer, flipped and clamped so it never leaves the window.
    const { x, y } = this.pointer, w = tip.offsetWidth, h = tip.offsetHeight;
    const left = x + 16 + w <= innerWidth - 4 ? x + 16 : x - 16 - w;
    const top = y + 14 + h <= innerHeight - 4 ? y + 14 : y - 14 - h;
    tip.style.left = `${clamp(left, 4, innerWidth - w - 4)}px`;
    tip.style.top = `${clamp(top, 4, innerHeight - h - 4)}px`;
  }
}

// ---------- words for things ----------

const plantState = (e) => ({
  growing: `sprouting (${Math.round(e.growth * 100)}%)`,
  mature: e.genome.form === 'cap' ? (e.open ? 'glowing' : 'dark') : e.open ? (e.woken ? 'open, woken by a firefly' : e.nectar ? `open · ${e.nectar} sip${e.nectar > 1 ? 's' : ''} of nectar` : 'open · drunk dry for now') : 'shut',
  seeding: 'gone to seed', withering: 'withering', dead: 'dead',
})[e.state];

// Where the moon is, as an observer would put it.
function moonWhere(sky) {
  if (!sky.up) return 'below the wall';
  if (sky.alt > 0.88) return 'high overhead';
  return sky.m < 0.5 ? (sky.alt < 0.35 ? 'rising in the east' : 'climbing the eastern sky') : (sky.alt < 0.35 ? 'setting in the west' : 'sinking down the western sky');
}
const weather = (sky) => (sky.rain > 0.3 ? 'rain' : sky.cloudiness > 0.75 ? 'overcast' : sky.cloudiness > 0.4 ? 'drifting cloud' : 'clear');
function skyLine(sky) {
  const moon = sky.eclipse > 0.3 && sky.up ? 'the full moon in eclipse' : `${phaseName(sky.phase)}, ${moonWhere(sky)}`;
  return `Night ${sky.night + 1} · ${sky.pale > 0.5 ? 'the pale' : moon} · ${weather(sky)}`;
}

// When the moon next rises or sets, and the next full and new moons, by looking ahead.
function almanac(time) {
  const now = skyAt(time);
  let turn = null;
  for (let t = time; t < time + NIGHT * 3 && turn == null; t += 5) if (skyAt(t).up !== now.up) turn = t - time;
  const nights = (to) => (((to - now.phase + 1) % 1) * LUNATION);
  return { turn, toFull: nights(0.5), toNew: nights(0) };
}

const TIPS = {
  firefly: (e) => `<b>${esc(e.name)}</b> <span class="muted">· gen ${e.gen} · ${esc(e.emotion)}</span><div class="muted">${esc(e.leaving ? 'rising out of the garden' : e.doing ?? (e.brain === 'thinking' ? 'thinking' : 'hovering'))}</div><div class="hint">click to open</div>`,
  plant: (e) => (e.genome ? `<b>${esc(cap(e.name ?? 'a plant'))}</b><div class="muted">${e.plot != null ? `plot ${e.plot} of the spiral · ` : ''}${plantState(e)}</div><div class="muted">${esc(cap(opensWords(e.genome)))}</div>` : ''),
  sky: (e, s) => `<b>The moon</b><div class="muted">${esc(phaseName(s.sky.phase))}, ${esc(moonWhere(s.sky))}</div><div class="hint">click to open</div>`,
  spiral: (e, s) => (s.top.spiral ? `<b>The ${ordinal(s.top.spiral.number)} spiral</b><div class="muted">${spiralProgress(s)}</div><div class="hint">click to open</div>` : ''),
};

function spiralProgress(s) {
  const sp = s.top.spiral;
  if (sp.floweringAt != null) return `in full flower · ${span(Math.max(0, SPIRAL.flowering - (s.state.time - sp.floweringAt)))} left`;
  const sown = sp.plots.filter((v) => v != null), open = sown.filter((id) => s.ents.get(id)?.open).length;
  return sown.length ? `${sown.length} of ${SPIRAL.plots} plots sown · ${open} open` : 'bare: nothing sown yet';
}

// ---------- side panel ----------

// The sidebar is the Codex; an entry (a firefly, a plant, the sky, the spiral) covers it until you go back.
const panes = Object.fromEntries(['codex', 'profile'].map((k) => [k, document.getElementById(k)]));
function show(pane) {
  for (const [k, p] of Object.entries(panes)) p.classList.toggle('on', k === pane);
}

// The book opens over the garden; its cover sits at the top of the sidebar.
const book = createBook(document.getElementById('book'));
const coverSub = document.getElementById('cover-sub');
document.getElementById('cover-moon').innerHTML = moonSvg(0.14);
document.getElementById('cover').onclick = () => book.open();
function updateCover(c) {
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  coverSub.textContent = c.total ? `${n(c.total, 'myth')} · ${c.authors} firefl${c.authors === 1 ? 'y' : 'ies'} · ${n(c.generations, 'generation')}` : 'nothing set down yet';
}

const lamp = (f, cls = '') => `<div class="lamp ${esc((f.flash ?? '').replace(' ', '-'))} ${cls}" style="--c:${esc(f.glow ?? '#dff27a')}"><i></i></div>`;

// The Codex: who is in the garden, the sky, the spiral, the plants, and everyone who has risen.
let risen = { recent: [], total: 0 }; // the fireflies that most recently rose (server/index.js RISEN), newest first
const departed = new Map();
let scene = null;
function renderCodex(s) {
  const all = [...s.ents.values()];
  const living = all.filter((e) => e.kind === 'firefly');
  const plants = all.filter((e) => e.kind === 'plant' && e.genome && e.plot == null && e.state !== 'dead' && e.state !== 'withering').sort((a, b) => a.x - b.x);
  const sky = skyAt(s.state.time);
  const kin = (f, gone) => `<div class="kin${gone ? ' gone' : ''}" data-entry="${f.id}">${lamp(f)}
    <div><div class="name" style="color:${esc(f.glow ?? '#c9d0ee')}">${esc(f.name)}</div>
    <div class="meta">generation ${f.gen}${f.predecessorName ? ` · followed ${esc(f.predecessorName)}` : ''}${gone ? ' · risen' : f.seenMoon === false ? ' · has not seen the moon' : ''}</div>
    ${f.persona?.hunch ? `<div class="phil">${esc(f.persona.hunch)}</div>` : ''}</div></div>`;
  const plant = (e) => `<div class="kin" data-entry="${e.id}"><div class="swatch"><i style="background:${leafColor(e.genome)};color:${leafColor(e.genome)}"></i><i style="background:${flowerColor(e.genome)};color:${flowerColor(e.genome)}"></i></div>
    <div><div class="name" style="color:${flowerColor(e.genome)}">${esc(cap(e.name))}</div><div class="meta">${plantState(e)}</div></div></div>`;
  const sp = s.top.spiral;
  const html = `<div class="sec">In the garden</div>${living.map((f) => kin(f, false)).join('') || '<div class="empty">No one yet.</div>'}` +
    `<div class="sec">Overhead</div><div class="kin" data-entry="sky"><div class="swatch">${moonSvg(sky.phase, { absent: !sky.up, rust: sky.eclipse > 0.3 })}</div><div><div class="name">The moon</div><div class="meta">${esc(phaseName(sky.phase))}, ${esc(moonWhere(sky))} · moonlight ${lightWord(sky.light)}</div></div></div>` +
    (sp ? `<div class="sec">The shared work</div><div class="kin" data-entry="spiral"><div class="swatch"><i style="background:#f2ecc0;color:#f2ecc0"></i></div><div><div class="name">The ${ordinal(sp.number)} spiral</div><div class="meta">${spiralProgress(s)}</div></div></div>` : '') +
    `<div class="sec">Growing wild (${plants.length})</div>${plants.map(plant).join('')}` +
    `<div class="sec">Risen</div>${risen.recent.map((f) => kin(f, true)).join('') || '<div class="empty">No one has risen yet.</div>'}` +
    (risen.total > risen.recent.length ? `<div class="empty">and ${risen.total - risen.recent.length} before them</div>` : '');
  replace(panes.codex, html);
}
panes.codex.addEventListener('click', (ev) => {
  const k = ev.target.closest('[data-entry]');
  if (k) openProfile(/^\d+$/.test(k.dataset.entry) ? Number(k.dataset.entry) : k.dataset.entry);
});

// What a plant is like, in a sentence or two, from its genome.
const FORM_WORDS = {
  bell: 'arching stems hung with bells', star: 'upright stems, each with one open-faced flower', trumpet: 'stout stems carrying great trumpets', spire: 'a tall spike of florets',
  umbel: 'stems that break into umbrellas of tiny florets', fern: 'arching, curl-tipped fronds dotted with light', grass: 'a tuft of blades with glowing plumes',
  puff: 'a rosette with bare stalks and many-rayed flowers that turn into seed clocks', bush: 'a branching shrub with flowers at its tips', cap: 'a cluster of glowing caps',
  vine: 'a creeper winding up the wall', lily: 'pads on the water around one many-petalled flower',
};
function describePlant(g) {
  const size = g.form === 'lily' || g.form === 'cap' ? '' : g.height > 170 ? 'Tall: ' : g.height < 70 ? 'Low: ' : '';
  const follows = g.form !== 'cap' && g.form !== 'fern' && g.form !== 'grass' ? (g.turn > 0.65 ? ' Its flowers turn to follow the moon across the sky.' : g.turn < 0.2 ? ' Its flowers pay the moon no mind.' : '') : '';
  return `${size}${size ? FORM_WORDS[g.form] : cap(FORM_WORDS[g.form])}, ${hueWord(g.hue2)} with a ${hueWord(g.hue3)} heart. It ${opensWords(g)}.${follows}`;
}

let profileId = null;
function openProfile(id) { profileId = id; panes.profile.scrollTop = 0; renderProfile(scene); show('profile'); }
panes.profile.addEventListener('click', (ev) => {
  if (ev.target.closest('.back')) { profileId = null; show('codex'); return; }
  const k = ev.target.closest('[data-entry]');
  if (k) openProfile(Number(k.dataset.entry));
  const m = ev.target.closest('[data-myth]');
  if (m) book.open(Number(m.dataset.myth));
});
const bars = (rows) => `<div class="bars">${rows.map(([k, v]) => `<div>${k}</div><div class="bar"><i style="width:${Math.round(clamp(v, 0, 1) * 100)}%"></i></div>`).join('')}</div>`;
const back = '<button class="link back">← back</button>';
// Swaps a panel's contents, keeping its scroll position, unless the reader is selecting text in it.
function replace(pane, html) {
  if (pane.dataset.html === html) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed && pane.contains(sel.anchorNode)) return;
  const sc = pane.scrollTop;
  pane.innerHTML = html;
  pane.dataset.html = html;
  pane.scrollTop = sc;
}
const setEntry = (html) => replace(panes.profile, html);

function renderProfile(s) {
  if (profileId == null || !s) return;
  if (profileId === 'sky') return setEntry(skyEntry(s));
  if (profileId === 'spiral') return setEntry(spiralEntry(s));
  const e = s.ents.get(profileId) ?? departed.get(profileId) ?? risen.recent.find((f) => f.id === profileId);
  if (!e) return setEntry(`${back}<div class="empty">Gone from the garden.</div>`);
  setEntry(e.kind === 'plant' ? plantEntry(s, e) : e.kind === 'seed' ? `${back}<div class="empty">A seed on the wind.</div>` : flyEntry(s, e));
}

function skyEntry(s) {
  const sky = skyAt(s.state.time), al = almanac(s.state.time);
  const inNights = (n) => (n < 0.6 ? 'tonight' : n < 1.5 ? 'tomorrow night' : `in ${Math.round(n)} nights`);
  const turn = al.turn == null ? 'It will not be in the sky tonight or tomorrow.' : sky.up ? `It sets in ${span(al.turn)}.` : `It rises in ${span(al.turn)}.`;
  return back + `<svg class="bigmoon" viewBox="-12 -12 24 24">${moonSvg(sky.phase, { rust: sky.eclipse > 0.3 }).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>` +
    `<h2 style="--c:#dfe7ff">The moon</h2>` +
    `<div class="muted">night ${sky.night + 1} of the garden · ${esc(phaseName(sky.phase))} · ${Math.round(sky.lit * 100)}% lit</div>` +
    `<p>${sky.eclipse > 0.3 && sky.up ? 'The full moon is in eclipse: a rust-red shadow lies across it. ' : ''}${cap(moonWhere(sky))}${sky.up && sky.cover > 0.5 ? ', behind cloud' : ''}. ${turn}</p>` +
    `<p class="muted">Full moon ${inNights(al.toFull)}; no moon ${inNights(al.toNew)}. Moonlight in the garden is ${lightWord(sky.light)}; the sky is ${weather(sky)}${sky.halo ? ', with a ring around the moon' : ''}.</p>` +
    bars([['this night', sky.u], ['moonlight', sky.light], ['cloud', sky.cloudiness]]) +
    `<p>The moon goes from new to new in ${LUNATION} nights of ten minutes each, and keeps the real one's habits: a young moon is a thin curve already sinking at dusk, a full one crosses the whole night, an old one rises just before the pale, and for a night or so there is none. Its bright side faces where the pale went down.</p>` +
    `<p class="muted">No firefly lives longer than a single night, so none of them ever sees this. Each sees one shape, in one part of the sky, and has to make sense of what the others say they saw.</p>`;
}

function spiralEntry(s) {
  const sp = s.top.spiral;
  if (!sp) return `${back}<div class="empty">…</div>`;
  const rows = sp.plots.map((id, i) => {
    const e = id != null && s.ents.get(id);
    if (!e?.genome) return `<b>${i}</b><span class="none">empty</span>`;
    return `<b>${i}</b><span class="${e.open ? '' : 'shut'}" data-entry="${e.id}" style="cursor:pointer"><i style="background:${flowerColor(e.genome)};color:${flowerColor(e.genome)}"></i>${esc(cap(e.name))} <span class="muted">· ${e.state === 'growing' ? 'sprouting' : e.open ? 'open' : 'shut'}</span></span>`;
  }).join('');
  const tenders = Object.entries(sp.tenders ?? {}).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${esc(name)} (${n})`).join(', ');
  const sown = sp.plots.filter((v) => v != null).length;
  const last = sp.last;
  return back + `<h2 style="--c:#f2ecc0">The ${ordinal(sp.number)} spiral</h2>` +
    `<div class="muted">${spiralProgress(s)}${sp.past ? ` · ${sp.past} flowered before it` : ''}</div>` +
    `<p>A bed of nineteen plots, winding out from its heart to the front of the garden. Fireflies carry seeds to it from the plants growing wild, pull up what doesn't belong, and wake shut flowers with their own light. When every plot stands open at the same moment the whole spiral flowers and pours its light upward; then it goes to seed, and they begin again.</p>` +
    bars([['sown', sown / SPIRAL.plots]]) +
    (sp.note ? `<p class="muted">${esc(cap(sp.note))}</p>` : '') +
    `<div class="sec">Its plots</div><div class="plots">${rows}</div>` +
    (tenders ? `<div class="sec">Sown by</div><p>${tenders}</p>` : '<p class="muted">No firefly has sown a seed here yet.</p>') +
    (last ? `<div class="sec">The last Flowering</div><p class="muted">The ${ordinal(last.number)} spiral flowered under ${esc(last.moon?.words ?? 'an unknown sky')}: ${[...new Set(last.flowers.map((f) => f.name))].slice(0, 6).map(esc).join(', ')}${new Set(last.flowers.map((f) => f.name)).size > 6 ? ' and more' : ''}.</p>` : '');
}

function plantEntry(s, e) {
  const g = e.genome;
  if (!g) return `${back}<div class="empty">…</div>`;
  const alive = s.ents.has(e.id);
  const life = e.plot != null ? null : 1 - Math.max((e.age - g.growTime) / g.lifespan, 0);
  return back + `<div class="swatches"><i style="background:${leafColor(g)};color:${leafColor(g)}"></i><i style="background:${flowerColor(g)};color:${flowerColor(g)}"></i><i style="background:${hex(hsl(g.hue3, g.sat, 0.75))};color:${hex(hsl(g.hue3, g.sat, 0.75))}"></i></div>` +
    `<h2 style="--c:${flowerColor(g)}">${esc(cap(e.name ?? speciesName(g)))}</h2>` +
    `<div class="muted">generation ${e.gen} · ${span(e.age)} old · ${alive ? plantState(e) : 'gone back into the soil'}${e.plot != null ? ` · plot ${e.plot} of the spiral` : ''}</div>` +
    `<p>${esc(describePlant(g))}</p>` +
    (g.nectar ? `<p class="muted">Holds up to ${g.nectar} sip${g.nectar > 1 ? 's' : ''} of nectar while open. ${e.given ? `Fireflies have drunk from it ${e.given} time${e.given > 1 ? 's' : ''}.` : 'No firefly has drunk from it yet.'}${e.hybrid ? ' A firefly has brought it another flower\'s pollen: its seeds will be hybrids.' : ''}</p>` : '') +
    (alive ? bars([['grown', e.growth], ...(g.nectar ? [['nectar', e.nectar / g.nectar]] : []), ...(life != null ? [['life left', ['withering', 'dead'].includes(e.state) ? 0 : life]] : [])]) : '') +
    (e.plot != null ? '<p class="muted">Sown in the spiral by a firefly. It will wait there, opening and shutting with the moon, until the Flowering.</p>' : '') +
    `<p class="muted">${e.parents?.length === 2 ? `A hybrid of the ${esc(e.parents[0])} and the ${esc(e.parents[1])}: a firefly carried pollen from one to the other.`
      : e.parents?.length === 1 ? `It grew from a seed of the ${esc(e.parents[0])}, a little different from it.`
      : 'It grew from a seed that blew in over the wall.'}${e.gen > 1 ? ` Its line goes back ${e.gen - 1} generation${e.gen > 2 ? 's' : ''}.` : ''}</p>`;
}

function flyEntry(s, e) {
  const live = s.ents.has(e.id);
  const p = e.persona ?? {};
  const doing = !live ? 'rose out of the garden' : e.doing ? `${e.doing}${e.plan?.length ? `, then ${e.plan.join(', then ')}` : ''}` : e.brain === 'thinking' ? 'pausing to think' : 'hovering';
  const reasoning = live && e.reasoning ? `<div class="muted">${e.brain === 'thinking' ? 'Thinking it through…' : 'How it decided'}</div><p class="reasoning">${esc(e.reasoning.trim().replace(/\s+/g, ' ').slice(-400))}</p>` : '';
  const ago = (at) => `<span class="muted">${span(s.state.time - at)} ago</span>`;
  const carried = e.myths?.length ? `<div class="sec">Myths it carries</div><ul class="carried">${e.myths.map((t) => `<li data-myth="${t.id}" style="cursor:pointer">${esc(t.text)} <span>${t.mine ? 'its own' : t.stance === 'embraces' ? 'embraced' : t.stance === 'disputes' ? 'disputed' : ''}</span></li>`).join('')}</ul>` : '';
  const seen = live && e.witnessed?.length ? `<div class="sec">Has seen in the sky</div><ul>${e.witnessed.slice().reverse().map((w) => `<li>${esc(cap(w.text))} ${ago(w.at)}</li>`).join('')}</ul>` : '';
  const notes = live && e.notes?.length ? `<div class="sec">Keeps in mind</div><ul>${e.notes.slice().reverse().map((n) => `<li>${esc(n.text)} ${ago(n.at)}</li>`).join('')}</ul>` : '';
  const memory = live && e.memory?.length ? `<div class="sec">Log</div><ul>${e.memory.slice().reverse().map((m) => `<li>${esc(m.text)} ${ago(m.at)}</li>`).join('')}</ul>` : '';
  const a = e.article;
  const source = a ? `<div class="muted">kindled from ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(a.title)}</a>` : `the poem “${esc(a.title)}”${a.by ? ` by ${esc(a.by)}` : ''}`}</div>` : '';
  return back + lamp(e, 'big') +
    `<h2 style="--c:${esc(e.glow ?? '#dff27a')}">${esc(e.name)}</h2>` +
    `<div class="muted">generation ${e.gen}${e.predecessorName ? `, followed ${esc(e.predecessorName)}` : ''} · ${esc(p.temperament ?? '')}${live ? ` · feels ${esc(e.emotion)}` : ''}</div>` + source +
    (p.hunch ? `<p class="phil">${esc(p.hunch)}</p>` : '') +
    `<p>${esc(p.personality)}</p>` + (p.desire ? `<p class="muted">Wants: ${esc(p.desire)}</p>` : '') +
    (live && e.seenMoon === false ? '<p class="muted">Has never seen the moon with its own eyes.</p>' : '') +
    (live ? `<p class="quote">“${esc(e.thought)}”</p>${reasoning}<p><b>Doing:</b> ${esc(doing)}</p>` +
      bars([['nectar', e.needs.nectar], ['rest', e.needs.rest], ['company', e.needs.company], ['wonder', e.needs.wonder], ['night left', 1 - e.age / e.lifespan]])
      : '<p class="muted">Rose out of the garden.</p>') +
    seen + carried + notes + memory +
    // What it remembers of its time under the soil: the oldest things it knows, so they come last.
    ((e.origins ?? p.memories)?.length ? `<div class="sec">From under the soil</div><ul>${(e.origins ?? p.memories).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '');
}

// The subtitle is a clock of garden time since the first dusk, ticking smoothly between snapshots,
// with tonight's moon beside it; under it, the sky in a line.
const status = document.getElementById('status');
const skyline = document.getElementById('skyline');
const clockFace = { time: 0, at: 0, live: false, shown: '', moon: '' };
function updateStatus(s) {
  if (!clockFace.live) { status.innerHTML = '<span class="clock"><span class="m"></span><b></b><i>since the first dusk</i></span>'; clockFace.shown = ''; clockFace.moon = ''; }
  Object.assign(clockFace, { time: s.state.time, at: performance.now(), live: true });
  tickClock();
}
function tickClock() {
  if (!clockFace.live) return;
  // Run on from the last snapshot, but not more than a few seconds past it.
  const t = Math.floor(clockFace.time + Math.min(3, (performance.now() - clockFace.at) / 1000));
  const text = `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  if (text === clockFace.shown) return;
  clockFace.shown = text;
  status.querySelector('b').textContent = text;
  const sky = skyAt(t);
  const line = skyLine(sky);
  if (skyline.textContent !== line) skyline.textContent = line;
  const moon = moonSvg(sky.phase, { absent: !sky.up, rust: sky.eclipse > 0.3 });
  if (moon !== clockFace.moon) { clockFace.moon = moon; status.querySelector('.m').innerHTML = moon; }
}
function statusNote(text) {
  clockFace.live = false;
  status.textContent = text;
}

// The book arrives whole once, then as the myths that changed (server/delta.js).
const myths = new Map();
function onCompendium(msg) {
  if (msg.full) myths.clear();
  for (const t of msg.upsert) myths.set(t.id, t);
  for (const id of myths.keys()) if (!msg.ids.includes(id)) myths.delete(id);
  const c = { ...msg.head, teachings: msg.ids.map((id) => myths.get(id)).filter(Boolean) };
  book.update(c);
  updateCover(c);
}

// The live connection. A tab that's been hidden for a while lets go of it (nobody is watching, and
// the garden streams constantly) and picks it back up when it's shown again. Reconnects back off,
// with jitter, so a restarted server isn't hit by every observer at once.
let socket = null, retries = 0, hiddenTimer = null;
const sleep = document.getElementById('sleep');
// The note is set as a line and, after its ellipsis, a quieter one ("the garden is sleeping…" / "check back soon").
function sleeping(text) {
  const [head, ...rest] = (text ?? '').split(/(?<=…|\.\.\.)\s+/);
  const p = sleep.querySelector('p');
  p.textContent = head;
  if (rest.length) p.append(Object.assign(document.createElement('span'), { textContent: rest.join(' ') }));
  sleep.hidden = !text;
}
const HIDDEN_GRACE = 30000;
function connect(s) {
  scene = s;
  if (socket || document.hidden) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = (socket = new WebSocket(`${proto}://${location.host}/ws`));
  let paused = false;
  ws.onopen = () => { retries = 0; };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    // A paused garden sends a note first, then the garden as it was left, and nothing after.
    if (msg.t === 'paused') { paused = true; sleeping(msg.text); }
    else if (msg.t === 'snap') { if (msg.full && !paused) sleeping(null); s.onSnapshot(msg); }
    else if (msg.t === 'compendium') onCompendium(msg);
    else if (msg.t === 'departed') { risen = msg; renderCodex(s); }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (document.hidden) return;
    statusNote('reconnecting…');
    const wait = Math.min(30000, 1500 * 2 ** retries++) * (0.5 + Math.random());
    setTimeout(() => connect(s), wait);
  };
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (document.hidden) {
    hiddenTimer = setTimeout(() => {
      const ws = socket;
      socket = null;
      ws?.close();
      statusNote('paused while hidden');
    }, HIDDEN_GRACE);
  } else if (!socket && scene) connect(scene);
});

new Phaser.Game({
  type: Phaser.WEBGL,
  parent: 'garden',
  width: W,
  height: H,
  backgroundColor: '#04060f',
  // Cover the whole garden area (trimming a sliver off whichever edges don't fit) rather than letterboxing it.
  scale: { mode: Phaser.Scale.ENVELOP, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: Garden,
});
