import Phaser from 'phaser';
import { WORLD, sandAt } from '../shared/world.js';
import { drawPlant, plantBounds, hsl } from './plants.js';
import { drawMandala, drawDeposits, mandalaProgress } from './mandala.js';
import { speciesName, hueWord } from '../shared/plants.js';
import { SANDS, MANDALA, mandalaCells, cellShape } from '../shared/world.js';
import { createBook } from './book.js';

const { width: W, height: H } = WORLD;
const FISH_WIDTH = 85; // on-screen px of a size-1 fish (server/sim.js HALF_LENGTH is half of it)
const DEPTH = { bg: 0, caustics: 0.5, mandala: 0.8, deposits: 0.9, rays: 1, snowFar: 2, plankton: 2.5, plantGlow: 3, plant: 4, pod: 5, corpse: 6, sparks: 6.5, halo: 7, shadow: 7.5, fish: 8, label: 9, snowNear: 10, bubble: 11, bokeh: 12 };
const tip = document.getElementById('tip');
const bubbleLayer = document.getElementById('bubbles');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hexToInt = (h) => parseInt(String(h ?? '#7fdcff').slice(1), 16);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const span = (s) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const plantColor = (g) => `#${hsl(g.hue2, g.sat, 0.68).toString(16).padStart(6, '0')}`;

// Additive glow sprites reused frame to frame.
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

// Phones and tablets get a lighter tank: no full-screen post effects (bloom, vignette, masked
// caustics), which are the costliest thing to render and the likeliest to fail on a mobile GPU, and
// fewer particles. ?fx=1 forces the full tank, ?lite=1 the light one; ?debug shows what the GPU is.
const params = new URLSearchParams(location.search);
const LITE = params.has('lite') || (!params.has('fx') && matchMedia('(pointer: coarse)').matches);
const DEBUG = params.has('debug');

// Problems that would otherwise leave a silent black tank are shown over it, so they can be read off
// any device.
const diag = document.createElement('div');
diag.id = 'diag';
document.getElementById('tank').appendChild(diag);
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

class Tank extends Phaser.Scene {
  constructor() { super('tank'); }

  create() {
    this.makeTextures();
    this.drawBackdrop();
    this.ents = new Map();     // id -> merged entity state from snapshots
    this.views = new Map();    // id -> display objects
    this.bubbles = new Map();  // fish id -> bubble
    this.state = { time: 0 };
    this.hovered = null;
    this.podGlow = new GlowPool(this, DEPTH.pod);
    this.floorGlow = new GlowPool(this, DEPTH.plantGlow);
    this.halos = new GlowPool(this, DEPTH.halo);
    if (!LITE) {
      try {
        Phaser.Actions.AddEffectBloom(this.cameras.main, { threshold: 0.42, blurRadius: 2.5, blurSteps: 5, blurQuality: 1, blendAmount: 0.85 });
        this.cameras.main.filters.external.addVignette(0.5, 0.5, 0.95, 0.45);
      } catch (e) { note(`effects off: ${e.message}`); }
    }
    this.game.canvas.addEventListener('webglcontextlost', () => note('the GPU dropped the WebGL context; reload to try again'));
    if (DEBUG) this.showGpu();
    this.input.on('pointermove', (p) => (this.pointer = { x: p.event.clientX, y: p.event.clientY }));
    this.input.on('gameout', () => { this.hovered = null; });
    connect(this);
    if (import.meta.env.DEV) window.tank = this; // for poking at the scene from the console
  }

  showGpu() {
    const gl = this.game.renderer.gl;
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    note(`${LITE ? 'lite' : 'full'} · ${this.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas'} · ` +
      `${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER)} · max texture ${gl?.getParameter(gl.MAX_TEXTURE_SIZE)} · ` +
      `${innerWidth}x${innerHeight} @${devicePixelRatio}`);
  }

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
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 8, 8);
    });
    canvas('bubble', 16, 16, (c) => {
      c.strokeStyle = 'rgba(200,240,255,0.8)'; c.lineWidth = 1.2; c.beginPath(); c.arc(8, 8, 6.5, 0, Math.PI * 2); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.8)'; c.beginPath(); c.arc(5.5, 5.5, 1.6, 0, Math.PI * 2); c.fill();
    });
    canvas('ray', 64, 512, (c) => {
      const h = c.createLinearGradient(0, 0, 64, 0);
      h.addColorStop(0, 'rgba(255,255,255,0)'); h.addColorStop(0.5, 'rgba(255,255,255,1)'); h.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = h; c.fillRect(0, 0, 64, 512);
      c.globalCompositeOperation = 'destination-in';
      const v = c.createLinearGradient(0, 0, 0, 512);
      v.addColorStop(0, 'rgba(0,0,0,1)'); v.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = v; c.fillRect(0, 0, 64, 512);
    });
    // Caustics: the bright web sunlight makes through a rippling surface. Each texture is the edge
    // network of a wrap-around Voronoi pattern (F2 - F1), so it tiles seamlessly.
    for (const [key, cells] of [['caustA', 12], ['caustB', 20]]) canvas(key, 256, 256, (c, w, h) => {
      const pts = Array.from({ length: cells }, () => [Math.random() * w, Math.random() * h]);
      const img = c.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let f1 = 1e9, f2 = 1e9;
        for (const [px, py] of pts) for (let ox = -w; ox <= w; ox += w) for (let oy = -h; oy <= h; oy += h) {
          const d = (x - px - ox) ** 2 + (y - py - oy) ** 2;
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
        const v = Math.exp(-(Math.sqrt(f2) - Math.sqrt(f1)) * 0.2);
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(255 * v ** 2.4);
      }
      c.putImageData(img, 0, 0);
    });
    // Stand-in for a fish whose portrait hasn't been drawn (or loaded) yet.
    canvas('blob', 220, 120, (c) => {
      c.fillStyle = '#fff';
      c.beginPath(); c.ellipse(120, 60, 78, 36, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.moveTo(50, 60); c.lineTo(8, 22); c.lineTo(20, 60); c.lineTo(8, 98); c.closePath(); c.fill();
      c.fillStyle = '#000'; c.beginPath(); c.arc(170, 52, 6, 0, Math.PI * 2); c.fill();
    });
  }

  drawBackdrop() {
    const t = this.textures.createCanvas('backdrop', W, H);
    const c = t.getContext();
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const water = c.createLinearGradient(0, 0, 0, H);
    water.addColorStop(0, '#13657f'); water.addColorStop(0.07, '#0c4660'); water.addColorStop(0.35, '#072b44');
    water.addColorStop(0.7, '#041628'); water.addColorStop(1, '#01070d');
    c.fillStyle = water; c.fillRect(0, 0, W, H);
    // Daylight pooling down from the surface.
    const sun = c.createRadialGradient(W * 0.42, -160, 40, W * 0.42, -160, 900);
    sun.addColorStop(0, 'rgba(150,230,255,0.22)'); sun.addColorStop(1, 'rgba(150,230,255,0)');
    c.fillStyle = sun; c.fillRect(0, 0, W, H);
    const band = c.createLinearGradient(0, WORLD.surface - 10, 0, WORLD.surface + 70);
    band.addColorStop(0, 'rgba(170,240,255,0.18)'); band.addColorStop(1, 'rgba(170,240,255,0)');
    c.fillStyle = band; c.fillRect(0, WORLD.surface - 10, W, 80);

    // Far away, in haze: a kelp forest, rock arches and the glimmer of other creatures.
    c.filter = 'blur(3px)';
    for (let i = 0; i < 48; i++) {
      const x = rnd(-20, W + 20), h = rnd(140, 430), y0 = 600 + rnd(-10, 30);
      c.strokeStyle = `rgba(18,${66 + rnd(0, 24)},${86 + rnd(0, 24)},${rnd(0.4, 0.65)})`;
      c.lineWidth = rnd(3, 8);
      c.beginPath(); c.moveTo(x, y0);
      const sway = rnd(-40, 40);
      c.bezierCurveTo(x + sway, y0 - h * 0.35, x - sway, y0 - h * 0.7, x + sway * 0.5, y0 - h);
      c.stroke();
    }
    for (const [cx, r] of [[180, 150], [1060, 190], [640, 90]]) {
      c.fillStyle = 'rgba(11,44,62,0.85)';
      c.beginPath(); c.ellipse(cx, 610, r * 1.6, r, 0, Math.PI, 0); c.fill();
      c.fillStyle = 'rgba(5,25,38,0.9)'; // the arch's opening
      c.beginPath(); c.ellipse(cx, 612, r * 0.7, r * 0.55, 0, Math.PI, 0); c.fill();
    }
    for (let i = 0; i < 80; i++) {
      const x = rnd(0, W), y = rnd(200, 620), r = rnd(0.8, 2.6);
      c.fillStyle = `hsla(${rnd(150, 320)},90%,70%,${rnd(0.2, 0.55)})`;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
    c.filter = 'none';
    // Nearer rock, darker and sharper.
    c.fillStyle = 'rgba(6,26,38,0.85)';
    c.beginPath(); c.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) c.lineTo(x, 575 - 50 * Math.sin(x / 210) - 30 * Math.sin(x / 77 + 2) - 70 * Math.exp(-(((x - 900) / 140) ** 2)));
    c.lineTo(W, H); c.fill();

    // Sand, with ripples and grain.
    const sand = c.createLinearGradient(0, 600, 0, H);
    sand.addColorStop(0, '#22322f'); sand.addColorStop(0.3, '#141e1d'); sand.addColorStop(1, '#05090a');
    c.fillStyle = sand;
    c.beginPath(); c.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) c.lineTo(x, sandAt(x));
    c.lineTo(W, H); c.fill();
    c.lineWidth = 1;
    for (let i = 0; i < 60; i++) {
      const x = rnd(0, W), y = sandAt(x) + rnd(6, 60), len = rnd(30, 90);
      c.strokeStyle = `rgba(150,200,200,${rnd(0.03, 0.07)})`;
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + len / 2, y - 3, x + len, y); c.stroke();
    }
    for (let i = 0; i < 1600; i++) {
      const x = Math.random() * W, y = sandAt(x) + 2 + Math.random() * (H - sandAt(x));
      c.fillStyle = `rgba(${150 + Math.random() * 60},${170 + Math.random() * 40},${170 + Math.random() * 40},${Math.random() * 0.09})`;
      c.fillRect(x, y, 1.5, 1.5);
    }
    c.strokeStyle = 'rgba(140,210,215,0.16)';
    c.beginPath();
    for (let x = 0; x <= W; x += 4) c[x ? 'lineTo' : 'moveTo'](x, sandAt(x) + 0.5);
    c.stroke();
    t.refresh();
    this.add.image(0, 0, 'backdrop').setOrigin(0, 0).setDepth(DEPTH.bg);

    // Caustics dance over the sand (two nets drifting apart), masked to the sand's own shape. The light
    // tank skips the mask and starts them at the sand's average height instead.
    const sandShape = this.make.graphics({ add: false }).fillStyle(0xffffff).beginPath().moveTo(0, H);
    for (let x = 0; x <= W; x += 8) sandShape.lineTo(x, sandAt(x));
    sandShape.lineTo(W, H).closePath().fillPath();
    const top = LITE ? 650 : 600;
    this.caustics = [['caustA', 0.3, 1.8], ['caustB', 0.2, 1.1]].map(([key, alpha, scale]) => {
      const tile = this.add.tileSprite(0, top, W, H - top, key).setOrigin(0, 0).setDepth(DEPTH.caustics)
        .setBlendMode(Phaser.BlendModes.ADD).setAlpha(alpha).setTint(0xaef2ff).setTileScale(scale, scale * 0.5);
      if (!LITE) {
        try {
          // A screen-space mask: the internal (object-space) one hid the whole layer.
          tile.enableFilters();
          tile.filters.external.addMask(sandShape);
        } catch (e) { note(`caustic mask off: ${e.message}`); }
      }
      return tile;
    });

    this.rays = Array.from({ length: 9 }, (_, i) => this.add.image(40 + i * 150 + Math.random() * 60, -40, 'ray')
      .setOrigin(0.5, 0).setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.rays)
      .setScale(0.8 + Math.random() * 3.5, 1.3 + Math.random() * 0.4).setAlpha(0.05)
      .setTint(0x9fe6ff).setData('phase', Math.random() * 10));
    this.surface = this.add.graphics().setDepth(DEPTH.rays).setBlendMode(Phaser.BlendModes.ADD);
    // Glints where the surface catches the light.
    this.glints = Array.from({ length: 34 }, () => this.add.image(Math.random() * W, WORLD.surface - 1, 'mote')
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.rays).setTint(0xd8f8ff).setScale(0.5 + Math.random() * 0.8)
      .setData({ phase: Math.random() * 10, speed: 0.6 + Math.random() * 1.6 }));
    this.snow = Array.from({ length: LITE ? 70 : 150 }, () => {
      const near = Math.random() < 0.2;
      return this.add.image(Math.random() * W, Math.random() * H, 'mote').setDepth(near ? DEPTH.snowNear : DEPTH.snowFar)
        .setScale(near ? 0.7 + Math.random() * 0.6 : 0.25 + Math.random() * 0.4).setAlpha(near ? 0.25 : 0.12 + Math.random() * 0.25)
        .setTint(0xbfe9ff).setData({ vy: 3 + Math.random() * 6, phase: Math.random() * 10 });
    });
    // Bioluminescent plankton: faint until a fish swims through, then they flare.
    const tints = [0x7fffd4, 0x7fdcff, 0xb4ffa0, 0x9fb8ff];
    this.plankton = Array.from({ length: LITE ? 90 : 220 }, () => {
      const x = Math.random() * W;
      return this.add.image(x, WORLD.surface + 30 + Math.random() * (sandAt(x) - WORLD.surface - 50), 'mote')
        .setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.plankton).setTint(tints[Math.floor(Math.random() * tints.length)])
        .setData({ base: 0.05 + Math.random() * 0.12, s0: 0.25 + Math.random() * 0.35, flare: 0, phase: Math.random() * 10 });
    });
    // Out-of-focus motes drifting right in front of the glass.
    this.bokeh = Array.from({ length: LITE ? 4 : 10 }, () => this.add.image(Math.random() * W, Math.random() * H, 'glow')
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.bokeh).setScale(2.5 + Math.random() * 4.5)
      .setAlpha(0.02 + Math.random() * 0.035).setTint([0x7fdcff, 0xa78bff, 0x7fffd4][Math.floor(Math.random() * 3)])
      .setData({ vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 3 }));
    this.rising = [];
    this.sparks = [];
    this.falling = []; // grains of a finished mandala on their way to the floor
    this.mandalaGlow = this.add.image(MANDALA.x, MANDALA.y, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.mandala)
      .setScale(7).setAlpha(0.05).setTint(0xf2e6c8);
    // The mandala and the sand deposits only change now and then, so they're drawn once into textures
    // instead of re-tessellating thousands of shapes every frame.
    const reach = 2 * (MANDALA.inner + MANDALA.rings * MANDALA.step + 4);
    this.mandala = this.add.renderTexture(MANDALA.x, MANDALA.y, reach, reach).setDepth(DEPTH.mandala);
    this.mandalaPen = this.make.graphics({ add: false });
    this.mandalaRev = -1;
    this.drawMandala({});
    const deposits = this.make.graphics({ add: false });
    drawDeposits(deposits);
    this.bake(this.add.renderTexture(0, 600, W, H - 600).setOrigin(0, 0).setDepth(DEPTH.deposits), deposits, 0, 600);
    deposits.destroy();
    // A soft dark ellipse behind each fish keeps it readable in front of bright plants.
    this.shadows = new GlowPool(this, DEPTH.shadow, Phaser.BlendModes.NORMAL); // short-lived glows: fish wakes and spores drifting off plants
  }

  // Draws Graphics `gfx` (in world coordinates) into render texture `rt`, whose top left is at (x, y).
  bake(rt, gfx, x, y) {
    rt.clear().draw(gfx, -x, -y).render();
  }

  drawMandala(cells) {
    drawMandala(this.mandalaPen, cells);
    this.bake(this.mandala, this.mandalaPen, MANDALA.x - this.mandala.width / 2, MANDALA.y - this.mandala.height / 2);
  }

  // The grains of a finished mandala let go of the wall and pour down to the sand.
  sandFall(cells) {
    const color = Object.fromEntries(SANDS.map((c) => [c.name, parseInt(c.color.slice(1), 16)]));
    for (const [key, cell] of Object.entries(cells ?? {})) {
      const [ring, slot] = key.split(':').map(Number);
      for (let q = 0; q < 4; q++) for (let n = 0; n < 2; n++) {
        if (this.falling.length > 900) return;
        const { r0, r1, a0, a1 } = cellShape(ring, slot, q);
        const r = r0 + Math.random() * (r1 - r0), a = a0 + Math.random() * (a1 - a0);
        const x = MANDALA.x + Math.cos(a) * r, y = MANDALA.y - Math.sin(a) * r;
        const img = this.add.image(x, y, 'mote').setDepth(DEPTH.sparks).setTint(color[cell.color] ?? 0xcccccc).setScale(0.45 + Math.random() * 0.3);
        // Outer rings let go first, so the mandala crumbles from its edge inward.
        this.falling.push({ img, vx: (Math.random() - 0.5) * 14, vy: 0, wait: (1 - r / (MANDALA.inner + MANDALA.rings * MANDALA.step)) * 3 + Math.random() * 0.8, rest: 0 });
      }
    }
  }

  // A short-lived glow that drifts and fades: wakes behind fish, spores rising off plants.
  spark(x, y, vx, vy, life, scale, color, alpha) {
    if (this.sparks.length > 160) return;
    const img = this.add.image(x, y, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.sparks).setScale(scale).setTint(color).setAlpha(alpha);
    this.sparks.push({ img, vx, vy, life, max: life, alpha, scale });
  }

  // ---------- entities ----------

  ensureFishTexture(url) {
    if (!url) return 'blob';
    const key = `fish:${url}`;
    if (this.textures.exists(key)) return key;
    if (!this.loading?.has(key)) {
      (this.loading ??= new Set()).add(key);
      this.load.image(key, url);
      this.load.start();
    }
    return 'blob';
  }

  // Frees a portrait no one in the tank wears any more (fish come and go for as long as the tab is open).
  releaseFishTexture(url) {
    if (!url) return;
    for (const e of this.ents.values()) if (e.sprite === url) return;
    const key = `fish:${url}`;
    if (this.textures.exists(key)) this.textures.remove(key);
    this.loading?.delete(key);
  }

  interactive(obj, id) {
    obj.on('pointerover', () => { this.hovered = id; this.input.setDefaultCursor('pointer'); });
    obj.on('pointerout', () => { if (this.hovered === id) this.hovered = null; this.input.setDefaultCursor('default'); });
    obj.on('pointerdown', () => { const e = this.ents.get(id); if (e?.kind === 'fish' || e?.kind === 'plant') openProfile(id); });
    return obj;
  }

  // A fish image's hover area: an ellipse over the body, in texture pixels.
  fitHitArea(img) {
    const { width: w, height: h } = img.frame;
    if (img.input) img.input.hitArea.setTo(w / 2, h / 2, w * 0.9, h * 0.85);
    else img.setInteractive(new Phaser.Geom.Ellipse(w / 2, h / 2, w * 0.9, h * 0.85), Phaser.Geom.Ellipse.Contains);
  }

  spawn(e) {
    const v = { kind: e.kind };
    if (e.kind === 'plant') {
      v.g = this.interactive(this.add.graphics({ x: e.x, y: e.y }).setDepth(DEPTH.plant), e.id);
    } else if (e.kind === 'urchin') {
      v.glow = this.add.image(e.x, e.y, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.corpse);
      v.g = this.interactive(this.add.graphics({ x: e.x, y: e.y }).setDepth(DEPTH.corpse), e.id);
      v.g.setInteractive(new Phaser.Geom.Circle(0, 0, 16), Phaser.Geom.Circle.Contains);
      v.ex = e.x; v.ey = e.y; v.spin = 0;
    } else if (e.kind === 'fish' || e.kind === 'corpse') {
      v.img = this.interactive(this.add.image(e.x, e.y, 'blob').setDepth(e.kind === 'fish' ? DEPTH.fish : DEPTH.corpse), e.id);
      this.fitHitArea(v.img);
      if (e.kind === 'fish') {
        v.label = this.add.text(e.x, e.y, e.name, { fontFamily: 'Inter, sans-serif', fontSize: '11px', color: '#a9d3e2' })
          .setOrigin(0.5, 0).setDepth(DEPTH.label).setAlpha(0.65);
        v.dots = this.add.text(e.x, e.y, '• • •', { fontFamily: 'Inter, sans-serif', fontSize: '10px', color: '#cdefff' })
          .setOrigin(0.5, 1).setDepth(DEPTH.label);
        v.grain = this.add.image(e.x, e.y, 'mote').setDepth(DEPTH.label).setScale(0.95).setVisible(false);
        v.ex = e.x; v.ey = e.y;
      }
    }
    return v;
  }

  destroyView(v) {
    for (const k of ['g', 'img', 'label', 'dots', 'grain', 'glow']) v[k]?.destroy();
  }

  // Snapshots are deltas (server/delta.js): each entity carries only the fields that changed, except
  // in the first one after connecting, which holds everything.
  onSnapshot(snap) {
    this.state = { time: snap.time };
    if (snap.full) this.ents.clear();
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
      if (e?.kind === 'fish') {
        departed.set(id, e); // the profile can still show who it was
        if (departed.size > 50) departed.delete(departed.keys().next().value);
      }
      this.ents.delete(id);
      this.bubbles.get(id)?.el.remove();
      this.bubbles.delete(id);
      if (this.hovered === id) this.hovered = null;
      this.releaseFishTexture(e?.sprite);
    }
    updateStatus(this);
    if (snap.mandala) {
      this.mandalaState = snap.mandala;
      if (snap.mandala.rev !== this.mandalaRev || snap.mandala.number !== this.mandalaNumber) {
        // A new mandala means the last one's time is up: its sand falls to the floor.
        if (this.mandalaNumber != null && snap.mandala.number !== this.mandalaNumber) this.sandFall(this.mandalaCells);
        this.mandalaRev = snap.mandala.rev;
        this.mandalaNumber = snap.mandala.number;
        this.mandalaCells = snap.mandala.cells;
        this.drawMandala(snap.mandala.cells);
      }
    }
    // The sidebar is rebuilt at most once a second (its ages tick in seconds).
    const now = performance.now();
    if (snap.full || snap.mandala || now - (this.panelAt ?? 0) > 1000) {
      this.panelAt = now;
      renderCodex(this);
      renderProfile(this);
    }
  }

  // ---------- frame ----------

  update(time, dtMs) {
    const t = time / 1000;
    const dt = dtMs / 1000;
    tickClock();
    this.animateWater(t, dt);
    this.podGlow.begin(); this.floorGlow.begin(); this.halos.begin(); this.shadows.begin();
    const k = 1 - Math.exp(-dtMs / 90);
    for (const [id, v] of this.views) {
      const e = this.ents.get(id);
      if (!e) continue;
      if (e.kind === 'plant') this.drawPlantView(e, v, t);
      else if (e.kind === 'fish') this.drawFish(e, v, t, k);
      else if (e.kind === 'corpse') this.drawCorpse(e, v);
      else if (e.kind === 'urchin') this.drawUrchin(e, v, t, dt, k);
    }
    this.podGlow.end(); this.floorGlow.end(); this.halos.end(); this.shadows.end();
    this.updateBubbles();
    this.renderTip();
  }

  animateWater(t, dt) {
    for (const r of this.rays) r.setRotation(0.18 + Math.sin(t * 0.07 + r.getData('phase')) * 0.08)
      .setAlpha(0.03 + 0.045 * (0.5 + 0.5 * Math.sin(t * 0.21 + r.getData('phase') * 3)) ** 2);
    const [ca, cb] = this.caustics;
    ca.tilePositionX = t * 9; ca.tilePositionY = Math.sin(t * 0.2) * 20;
    cb.tilePositionX = -t * 6; cb.tilePositionY = t * 4;
    for (const g of this.glints) g.setAlpha(Math.max(0, Math.sin(t * g.getData('speed') + g.getData('phase'))) ** 8 * 0.9);
    for (const b of this.bokeh) {
      b.x += b.getData('vx') * dt; b.y += b.getData('vy') * dt;
      if (b.x < -150) b.x = W + 150; else if (b.x > W + 150) b.x = -150;
      if (b.y < -150) b.y = H + 150; else if (b.y > H + 150) b.y = -150;
    }
    // Plankton flare where fish are swimming; the light fades over a second or two.
    const swimmers = [];
    for (const [id, v] of this.views) {
      const e = this.ents.get(id);
      if (e?.kind === 'fish' && Math.hypot(e.vx ?? 0, e.vy ?? 0) > 8) swimmers.push(v);
    }
    for (const m of this.plankton) {
      const d = m.data.values;
      m.x += Math.sin(t * 0.2 + d.phase) * 3 * dt;
      m.y += Math.cos(t * 0.15 + d.phase) * 2 * dt;
      for (const v of swimmers) if ((m.x - v.ex) ** 2 + (m.y - v.ey) ** 2 < 75 * 75) d.flare = 1;
      d.flare = Math.max(0, d.flare - dt * 0.7);
      m.setAlpha(d.base + d.flare * 0.8).setScale(d.s0 * (1 + d.flare * 1.4));
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const g = this.falling[i];
      if ((g.wait -= dt) > 0) continue;
      const floor = sandAt(g.img.x) + 2;
      if (g.img.y < floor) {
        g.vy = Math.min(140, g.vy + 90 * dt);
        g.img.setPosition(g.img.x + g.vx * dt, Math.min(floor, g.img.y + g.vy * dt));
      } else if ((g.rest += dt) > 4) { g.img.destroy(); this.falling.splice(i, 1); }
      else g.img.setAlpha(1 - g.rest / 4);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.life -= dt;
      if (p.life <= 0) { p.img.destroy(); this.sparks.splice(i, 1); continue; }
      const k = p.life / p.max;
      p.img.setPosition(p.img.x + p.vx * dt, p.img.y + p.vy * dt).setAlpha(p.alpha * k).setScale(p.scale * (1.3 - 0.3 * k));
    }
    this.surface.clear();
    for (let band = 0; band < 2; band++) {
      this.surface.lineStyle(band ? 1 : 3, 0x9fe6ff, band ? 0.35 : 0.08);
      this.surface.beginPath();
      for (let x = 0; x <= W; x += 10) {
        const y = WORLD.surface - 2 + Math.sin(x / 47 + t * 0.9) * 1.6 + Math.sin(x / 19 - t * 1.4) * 0.8;
        if (x) this.surface.lineTo(x, y); else this.surface.moveTo(x, y);
      }
      this.surface.strokePath();
    }
    for (const m of this.snow) {
      m.y += m.getData('vy') * dt * (m.depth === DEPTH.snowNear ? 2 : 1);
      m.x += Math.sin(t * 0.3 + m.getData('phase')) * 4 * dt;
      if (m.y > H) { m.y = WORLD.surface; m.x = Math.random() * W; }
    }
    if (Math.random() < dt * 0.6) { const x = Math.random() * W; this.bubbleUp(x, sandAt(x) - 4, 1); }
    for (let i = this.rising.length - 1; i >= 0; i--) {
      const b = this.rising[i];
      b.y -= b.getData('vy') * dt;
      b.x += Math.sin(t * 3 + b.getData('phase')) * 10 * dt;
      if (b.y < WORLD.surface) { b.destroy(); this.rising.splice(i, 1); }
    }
  }

  bubbleUp(x, y, n) {
    for (let i = 0; i < n && this.rising.length < 60; i++) {
      this.rising.push(this.add.image(x + (Math.random() - 0.5) * 6, y - i * 7, 'bubble').setDepth(DEPTH.bubble)
        .setScale(0.3 + Math.random() * 0.4).setAlpha(0.55).setData({ vy: 25 + Math.random() * 20, phase: Math.random() * 10 }));
    }
  }

  drawPlantView(e, v, t) {
    if (!e.genome) return;
    drawPlant(v.g, this.podGlow, e, e.genome, t + e.id * 3.1);
    if (e.food > 0 && Math.random() < this.game.loop.delta / 1000 * 0.15 * e.food) {
      this.spark(e.x + (Math.random() - 0.5) * 30, e.y - e.genome.height * e.growth * (0.5 + Math.random() * 0.45), (Math.random() - 0.5) * 4,
        -6 - Math.random() * 8, 3 + Math.random() * 2, 0.06 + Math.random() * 0.05, hsl(e.genome.hue2, e.genome.sat, 0.7), 0.7);
    }
    // A pool of light on the sand under every living plant.
    const light = e.genome.glow * (1 - (e.wither ?? 0)) * (1 - (e.fade ?? 0)) * Math.max(0.2, e.growth);
    this.floorGlow.take(e.x, e.y + 2, 1, hsl(e.genome.hue2, e.genome.sat, 0.55), 0.13 * light).setScale(2 + e.genome.height / 70, 0.7);
    if (!v.bounds || Math.abs(v.boundsGrowth - e.growth) > 0.05) {
      v.bounds = plantBounds(e.genome, e.growth);
      v.boundsGrowth = e.growth;
      const r = new Phaser.Geom.Rectangle(v.bounds.x, v.bounds.y, v.bounds.w, v.bounds.h);
      if (v.g.input) v.g.input.hitArea = r;
      else v.g.setInteractive(r, Phaser.Geom.Rectangle.Contains);
    }
  }

  drawFish(e, v, t, k) {
    const key = this.ensureFishTexture(e.sprite);
    if (v.img.texture.key !== key) { v.img.setTexture(key); this.fitHitArea(v.img); }
    v.img.setTint(key === 'blob' ? hexToInt(e.glow) : 0xffffff);
    v.ex += (e.x - v.ex) * k;
    v.ey += (e.y - v.ey) * k;
    const speed = Math.hypot(e.vx ?? 0, e.vy ?? 0);
    const wob = Math.sin(t * (3 + speed * 0.09) + e.id);
    const x = v.ex, y = v.ey + Math.sin(t * 1.1 + e.id) * 2.2;
    const base = (FISH_WIDTH * e.size) / v.img.frame.width;
    v.img.setPosition(x, y).setFlipX(e.facing < 0)
      .setRotation(clamp((e.vy ?? 0) / 140, -0.35, 0.35) * (e.facing < 0 ? -1 : 1))
      .setScale(base * (1 + 0.012 * wob), base * (1 - 0.025 * wob));
    if (this.state.time - (e.bitAt ?? -1e9) < 0.5) v.img.setTint(0xff7070);
    const speaking = e.said && this.state.time - e.said.at < 6;
    const half = (v.img.frame.height * base) / 2;
    const selected = profileId === e.id;
    this.shadows.take(x, y, 1, 0x00060c, 0.5).setScale(e.size * 1.4, e.size * 0.8);
    this.halos.take(x, y, e.size * 1.4 * (speaking ? 1.15 + 0.08 * Math.sin(t * 6) : 1), hexToInt(e.glow), speaking ? 0.38 : selected ? 0.34 : 0.26);
    v.grain.setVisible(Boolean(e.carrying)).setPosition(x + e.facing * FISH_WIDTH * e.size * 0.48, y + 2);
    if (e.carrying) v.grain.setTint(hexToInt(e.carrying));
    v.label.setPosition(x, y + half + 3).setAlpha(selected ? 1 : 0.65);
    v.dots.setPosition(x, y - half - 4).setVisible(e.brain === 'thinking').setAlpha(0.45 + 0.4 * Math.sin(t * 4));
    v.screenTop = y - half;
    if (speed > 18 && t - (v.wakeAt ?? 0) > 0.08) {
      v.wakeAt = t;
      this.spark(x - e.facing * FISH_WIDTH * e.size * 0.42, y + (Math.random() - 0.5) * 8, -e.facing * 6, (Math.random() - 0.5) * 4,
        1.1, 0.13 * e.size, hexToInt(e.glow), 0.3);
    }
  }

  // A spiky glowing ball. It turns slowly at rest, faster as it falls, and leaves a faint trail.
  drawUrchin(e, v, t, dt, k) {
    v.ex += (e.x - v.ex) * k;
    v.ey += (e.y - v.ey) * k;
    v.spin += dt * (e.state === 'falling' ? 0.9 : e.state === 'carried' ? 0.4 : 0.06);
    const body = hsl(e.hue, 0.6, 0.22), spine = hsl(e.hue, 0.9, 0.55), tip = hsl(e.hue, 1, 0.8);
    const pulse = 0.7 + 0.3 * Math.sin(t * 1.6 + e.id);
    v.glow.setPosition(v.ex, v.ey).setScale(0.9 + 0.25 * pulse).setTint(spine).setAlpha((e.state === 'falling' ? 0.6 : 0.42) * pulse);
    const g = v.g.setPosition(v.ex, v.ey).clear();
    for (let i = 0; i < 18; i++) {
      const a = v.spin + (i / 18) * Math.PI * 2, len = 9 + (i % 3) * 2.5;
      g.lineStyle(1.3, spine, 0.9).lineBetween(Math.cos(a) * 5, Math.sin(a) * 5, Math.cos(a) * len, Math.sin(a) * len);
      g.fillStyle(tip, 0.9 * pulse).fillCircle(Math.cos(a) * len, Math.sin(a) * len, 1.1);
    }
    g.fillStyle(body, 1).fillCircle(0, 0, 6).fillStyle(spine, 0.55 * pulse).fillCircle(-1.5, -1.5, 3);
    if (e.state === 'falling' && Math.random() < dt * 6) this.spark(v.ex, v.ey, (Math.random() - 0.5) * 4, -4, 1.6, 0.08, spine, 0.5);
  }

  drawCorpse(e, v) {
    const key = this.ensureFishTexture(e.sprite);
    if (v.img.texture.key !== key) { v.img.setTexture(key); this.fitHitArea(v.img); }
    const base = (FISH_WIDTH * e.size) / v.img.frame.width;
    v.img.setPosition(e.x, e.y).setFlipX(e.facing < 0).setFlipY(true).setScale(base)
      .setTint(0x5a6a78).setAlpha(clamp(1 - e.age / 300, 0.15, 0.8));
  }

  // ---------- speech ----------

  toScreen(x, y) {
    const r = this.game.canvas.getBoundingClientRect(), tank = bubbleLayer.getBoundingClientRect();
    return { x: r.left - tank.left + (x / W) * r.width, y: r.top - tank.top + (y / H) * r.height };
  }

  updateBubbles() {
    const now = performance.now();
    for (const [id, e] of this.ents) {
      if (e.kind !== 'fish' || !e.said) continue;
      let b = this.bubbles.get(id);
      if (b?.at === e.said.at) continue;
      if (this.state.time - e.said.at > 20) continue; // old news, e.g. on first connect
      b?.el.remove();
      const el = document.createElement('div');
      el.className = 'bubble';
      el.style.setProperty('--c', e.glow ?? '#7fe0ff');
      el.innerHTML = `<b>${esc(e.name)}${e.said.to ? ` → ${esc(e.said.to)}` : ''}</b>${esc(e.said.text)}`;
      bubbleLayer.appendChild(el);
      // As long as the sim holds the floor for it (readTime in server/sim.js), so it can be read.
      b = { el, at: e.said.at, until: now + 1000 * Math.max(4, Math.min(20, 2.5 + e.said.text.length / 16)) };
      this.bubbles.set(id, b);
      const v = this.views.get(id);
      if (v) this.bubbleUp(v.ex + (e.facing ?? 1) * 40 * e.size, v.ey, 3);
    }
    // Place each bubble over its fish, then nudge overlapping ones apart vertically.
    const placed = [];
    for (const [id, b] of this.bubbles) {
      const v = this.views.get(id);
      if (!v || now > b.until + 900) { b.el.remove(); this.bubbles.delete(id); continue; }
      b.el.style.opacity = now > b.until ? '0' : '1';
      const p = this.toScreen(v.ex, v.screenTop ?? v.ey);
      // Bubbles shrink with the tank (never grow past their own size), so on a phone they stay small
      // and sit on their fish instead of crowding it off the screen.
      const k = Math.min(1, this.game.canvas.getBoundingClientRect().width / W);
      b.el.style.transform = `translate(-50%, -100%) scale(${k})`;
      const w = b.el.offsetWidth * k, h = b.el.offsetHeight * k;
      const tankW = bubbleLayer.clientWidth;
      let x = clamp(p.x, w / 2 + 4, tankW - w / 2 - 4), y = Math.max(h + 4, p.y - 10 * k);
      for (const o of placed) if (Math.abs(o.x - x) < (o.w + w) / 2 && y > o.y - o.h - 6 && y - h < o.y + 6) y = o.y - o.h - 8;
      placed.push({ x, y, w, h });
      // Slid away from its fish (one swimming in or out at the edge): the tail would point at nothing.
      b.el.classList.toggle('detached', Math.abs(x - p.x) > w / 2 - 10);
      b.el.style.left = `${x}px`;
      b.el.style.top = `${y}px`;
    }
  }

  // ---------- hover tooltip ----------

  renderTip() {
    const e = this.hovered != null && this.ents.get(this.hovered);
    const html = e && this.pointer && TIPS[e.kind]?.(e);
    if (!html) { tip.style.display = 'none'; return; }
    tip.style.setProperty('--c', e.glow ?? (e.genome ? plantColor(e.genome) : '#7fe0ff'));
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

const TIPS = {
  fish: (e) => `<b>${esc(e.name)}</b> <span class="muted">· gen ${e.gen} · ${esc(e.emotion)}</span><div class="muted">${esc(e.leaving ? 'swimming out past the edge' : e.doing ?? (e.brain === 'thinking' ? 'thinking' : 'drifting'))}</div><div class="hint">click to open</div>`,
  plant: (e) => e.genome ? `<b>${esc(cap(e.name ?? 'a plant'))}</b><div class="muted">${e.genome.form} · ${e.food ? `${e.food} pod${e.food > 1 ? 's' : ''} to eat` : e.state === 'growing' ? `growing (${Math.round(e.growth * 100)}%)` : e.state === 'mature' ? 'no food right now' : e.state}</div>` : '',
  urchin: (e) => `<b>A glowing sea urchin</b><div class="muted">${e.state === 'falling' ? 'drifting down' : e.state === 'carried' ? `carried up by ${esc(e.carrier)}` : 'resting on the sand'}${e.falls ? ` · has fallen ${e.falls} time${e.falls > 1 ? 's' : ''}` : ''}</div>`,
  corpse: (e) => `<b>The remains of ${esc(e.name)}</b><div class="muted">${esc(howDied(e.cause))} · ${e.food ? `${e.food} bites left` : 'picked clean'}</div>`,
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// Causes read 'killed by X', 'starvation' or 'its wounds'.
const howDied = (cause) => (/^(killed|swam)/.test(String(cause)) ? cause : `died of ${cause ?? 'unknown causes'}`);

// ---------- side panel ----------

// The sidebar is the Codex; an entry (a fish, a plant, the mandala) covers it until you go back.
const panes = Object.fromEntries(['codex', 'profile'].map((k) => [k, document.getElementById(k)]));
function show(pane) {
  for (const [k, p] of Object.entries(panes)) p.classList.toggle('on', k === pane);
}

// The compendium is a book that opens over the tank; its cover sits at the top of the sidebar.
const book = createBook(document.getElementById('book'));
const coverSub = document.getElementById('cover-sub');
document.getElementById('cover').onclick = () => book.open();
function updateCover(c) {
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  coverSub.textContent = c.total ? `${n(c.total, 'teaching')} · ${c.authors} fish · ${n(c.generations, 'generation')}` : 'nothing set down yet';
}

// The Codex: who is in the tank, who is on the way, the mandala, the plants, and everyone who has
// swum out. Any of them opens an entry.
let swumOut = { recent: [], total: 0 }; // the fish that most recently swam out (server/index.js SWUM_OUT), newest first
const departed = new Map();
let scene = null;
const plantColor2 = (g) => `#${hsl(g.hue, g.sat, 0.6).toString(16).padStart(6, '0')}`;
function renderCodex(s) {
  const all = [...s.ents.values()];
  const living = all.filter((e) => e.kind === 'fish');
  const plants = all.filter((e) => e.kind === 'plant' && e.genome && e.state !== 'dead').sort((a, b) => a.x - b.x);
  const kin = (f, gone) => `<div class="kin${gone ? ' gone' : ''}" data-entry="${f.id}">${f.sprite ? `<img src="${esc(f.sprite)}" alt="">` : '<img alt="">'}
    <div><div class="name" style="color:${esc(f.glow ?? '#9fd8ea')}">${esc(f.name)}</div>
    <div class="meta">generation ${f.gen}${f.predecessorName ? ` · followed ${esc(f.predecessorName)}` : ''}${gone ? ` · ${esc(f.cause ?? 'swam out')}` : ''}</div>
    ${f.persona?.philosophy ? `<div class="phil">${esc(f.persona.philosophy)}</div>` : ''}</div></div>`;
  const plant = (e) => `<div class="kin" data-entry="${e.id}"><div class="swatch"><i style="background:${plantColor2(e.genome)};color:${plantColor2(e.genome)}"></i><i style="background:${plantColor(e.genome)};color:${plantColor(e.genome)}"></i></div>
    <div><div class="name" style="color:${plantColor(e.genome)}">${esc(cap(e.name))}</div><div class="meta">${plantState(e)}</div></div></div>`;
  const m = s.mandalaState;
  const gone = swumOut.recent;
  const html = `<div class="sec">In the tank</div>${living.map((f) => kin(f, false)).join('') || '<div class="empty">No one yet.</div>'}` +
    (m ? `<div class="sec">The mandala</div><div class="kin" data-entry="mandala"><div class="swatch"><i style="background:#f2e6c8;color:#f2e6c8"></i></div><div><div class="name">The ${ordinal(m.number)} mandala</div><div class="meta">${m.completedAt != null ? `complete · its sand falls in ${fallsIn(s, m)}` : mandalaProgress(m.cells)}</div></div></div>` : '') +
    `<div class="sec">Plants (${plants.length})</div>${plants.map(plant).join('')}` +
    `<div class="sec">Swum out</div>${gone.map((f) => kin(f, true)).join('') || '<div class="empty">No one has left yet.</div>'}` +
    (swumOut.total > gone.length ? `<div class="empty">and ${swumOut.total - gone.length} before them</div>` : '');
  replace(panes.codex, html);
}
panes.codex.addEventListener('click', (ev) => {
  const k = ev.target.closest('[data-entry]');
  if (k) openProfile(k.dataset.entry === 'mandala' ? 'mandala' : Number(k.dataset.entry));
});
const fallsIn = (s, m) => span(Math.max(0, MANDALA.admire - (s.state.time - m.completedAt)));
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`);
const plantState = (e) => ({
  growing: `growing (${Math.round(e.growth * 100)}%)`, mature: e.food ? `${e.food} pod${e.food > 1 ? 's' : ''} to eat` : 'in its prime, no food right now',
  withering: 'withering', dead: 'dead',
})[e.state];

// What a plant is like, in a sentence or two, from its genome.
const FORM_WORDS = {
  kelp: 'ribbons of kelp', coral: 'branching coral', fan: 'a lacework sea fan', anemone: 'an anemone of curling tendrils',
  lantern: 'lantern stalks', fern: 'curled fern fronds', tube: 'a cluster of chimney tubes', grass: 'a tuft of fine blades',
  orb: 'a stalk strung with glowing beads', vine: 'twining vines',
};
function describePlant(g) {
  const size = g.height > 220 ? 'Towering' : g.height > 140 ? 'Tall' : g.height > 70 ? 'Low' : 'Tiny';
  const pace = g.pulse > 1.2 ? 'flickers quickly' : g.pulse < 0.5 ? 'breathes slowly' : 'pulses steadily';
  const motion = g.sway > 1 ? ' It sways wide in the current.' : g.sway < 0.45 ? ' It barely stirs in the current.' : '';
  return `${size} ${FORM_WORDS[g.form]}, ${hueWord(g.hue)} in body, whose ${hueWord(g.hue2)} light ${pace}.${motion}`;
}

let profileId = null;
function openProfile(id) { profileId = id; panes.profile.scrollTop = 0; renderProfile(scene); show('profile'); }
panes.profile.addEventListener('click', (ev) => {
  if (ev.target.closest('.back')) { profileId = null; show('codex'); }
});
const bars = (rows) => `<div class="bars">${rows.map(([k, v]) => `<div>${k}</div><div class="bar"><i style="width:${Math.round(clamp(v, 0, 1) * 100)}%"></i></div>`).join('')}</div>`;
const back = '<button class="link back">← back</button>';
function setEntry(html) {
  replace(panes.profile, html);
}
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

function renderProfile(s) {
  if (profileId == null || !s) return;
  if (profileId === 'mandala') return setEntry(mandalaEntry(s));
  const e = s.ents.get(profileId) ?? departed.get(profileId) ?? swumOut.recent.find((f) => f.id === profileId);
  if (!e) return setEntry(`${back}<div class="empty">Gone from the tank.</div>`);
  setEntry(e.kind === 'plant' ? plantEntry(s, e) : fishEntry(s, e));
}

function plantEntry(s, e) {
  const g = e.genome;
  if (!g) return `${back}<div class="empty">…</div>`;
  const alive = s.ents.has(e.id);
  const life = 1 - e.age / (g.growTime + g.lifespan);
  return back + `<div class="swatches"><i style="background:${plantColor2(g)};color:${plantColor2(g)}"></i><i style="background:${plantColor(g)};color:${plantColor(g)}"></i></div>` +
    `<h2 style="--c:${plantColor(g)}">${esc(cap(e.name ?? speciesName(g)))}</h2>` +
    `<div class="muted">${g.form} · generation ${e.gen} · ${span(e.age)} old · ${alive ? plantState(e) : 'gone back into the sand'}</div>` +
    `<p>${esc(describePlant(g))}</p>` +
    `<p class="muted">Holds up to ${g.food} pod${g.food > 1 ? 's' : ''} of food and grows a new one every ${g.regen}s. ${e.given ? `It has fed fish ${e.given} time${e.given > 1 ? 's' : ''}.` : 'No fish has eaten from it yet.'}</p>` +
    (alive ? bars([['grown', e.growth], ['food', e.food / g.food], ['life left', e.state === 'withering' || e.state === 'dead' ? 0 : life]]) : '') +
    `<p class="muted">${e.parents?.length === 2 ? `A hybrid of the ${esc(e.parents[0])} and the ${esc(e.parents[1])}: a fish carried pollen from one to the other.`
      : e.parents?.length === 1 ? `It grew from a seed of the ${esc(e.parents[0])}, a little different from it.`
      : 'It grew from a spore that drifted in, or where a fish once fell.'}${e.gen > 1 ? ` Its line goes back ${e.gen - 1} generation${e.gen > 2 ? 's' : ''}.` : ''}</p>`;
}

function mandalaEntry(s) {
  const m = s.mandalaState;
  if (!m) return `${back}<div class="empty">…</div>`;
  const counts = {};
  for (const c of Object.values(m.cells ?? {})) counts[c.color] = (counts[c.color] ?? 0) + 1;
  const palette = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<span><i style="background:${SANDS.find((x) => x.name === name)?.color}"></i>${name} ${n}</span>`).join('');
  const makers = Object.entries(m.makers ?? {}).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${esc(name)} (${n})`).join(', ');
  const laid = Object.keys(m.cells ?? {}).length;
  return back + `<h2 style="--c:#f2e6c8">The ${ordinal(m.number)} mandala</h2>` +
    `<div class="muted">${m.completedAt != null ? `complete · its sand falls in ${fallsIn(s, m)}` : `${laid} of ${mandalaCells()} places filled`}${m.past ? ` · ${m.past} fell away before it` : ''}</div>` +
    `<p>On the back wall the fish lay sand, one grain at a time, carried up from the colored deposits on the floor. Every grain is mirrored into all four quarters. When the last place is filled the mandala stands for ten minutes; then its sand falls away and the wall is bare again.</p>` +
    bars([['filled', laid / mandalaCells()]]) +
    (palette ? `<div class="sec">Its sand</div><div class="palette">${palette}</div>` : '') +
    (makers ? `<div class="sec">Laid by</div><p>${makers}</p>` : '<p class="muted">No fish has laid a grain yet.</p>');
}

function fishEntry(s, e) {
  const live = s.ents.has(e.id);
  const p = e.persona ?? {};
  const doing = !live ? 'swam out past the edge' : e.doing ? `${e.doing}${e.plan?.length ? `, then ${e.plan.join(', then ')}` : ''}` : e.brain === 'thinking' ? 'pausing to think' : 'drifting';
  const reasoning = live && e.reasoning ? `<div class="muted">${e.brain === 'thinking' ? 'Thinking it through…' : 'How it decided'}</div><p class="reasoning">${esc(e.reasoning.trim().replace(/\s+/g, ' ').slice(-400))}</p>` : '';
  const carried = e.teachings?.length ? `<div class="sec">Musing</div><ul class="carried">${e.teachings.map((t) => `<li>${esc(t.text)} <span>${t.mine ? 'its own' : t.stance === 'embraces' ? 'embraced' : t.stance === 'disputes' ? 'disputed' : ''}</span></li>`).join('')}</ul>` : '';
  const notes = live && e.notes?.length ? `<div class="sec">Keeps in mind</div><ul>${e.notes.slice().reverse().map((n) => `<li>${esc(n.text)} <span class="muted">${span(s.state.time - n.at)} ago</span></li>`).join('')}</ul>` : '';
  const memory = live && e.memory?.length ? `<div class="sec">Log</div><ul>${e.memory.slice().reverse().map((m) => `<li>${esc(m.text)} <span class="muted">${span(s.state.time - m.at)} ago</span></li>`).join('')}</ul>` : '';
  return back +
    (e.sprite ? `<img class="portrait" src="${esc(e.sprite)}" alt="" style="--c:${esc(e.glow ?? '#7fe0ff')}">` : '') +
    `<h2 style="--c:${esc(e.glow ?? '#7fe0ff')}">${esc(e.name)}</h2>` +
    `<div class="muted">generation ${e.gen}${e.predecessorName ? `, followed ${esc(e.predecessorName)}` : ''} · ${esc(p.temperament ?? '')}${live ? ` · feels ${esc(e.emotion)}` : ''}</div>` +
    (e.article ? `<div class="muted">born of <a href="${esc(e.article.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(e.article.title)}</a></div>` : '') +
    (p.philosophy ? `<p class="phil">${esc(p.philosophy)}</p>` : '') +
    `<p>${esc(p.personality)}</p>` + (p.desire ? `<p class="muted">Wants: ${esc(p.desire)}</p>` : '') +
    (live ? `<p class="quote">“${esc(e.thought)}”</p>${reasoning}<p><b>Doing:</b> ${esc(doing)}</p>` +
      bars([['health', e.health], ['fed', e.needs.hunger], ['energy', e.needs.energy], ['social', e.needs.social], ['meaning', e.needs.meaning]])
      : `<p class="muted">${esc(cap(howDied(e.cause ?? 'swam out past the edge')))}.</p>`) +
    carried + notes + memory +
    // What it remembers of its life before the tank: the oldest things it knows, so they come last.
    ((e.origins ?? p.memories)?.length ? `<div class="sec">Glimmers of Memory</div><ul>${(e.origins ?? p.memories).map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '');
}

// The subtitle is a clock of tank time since genesis, ticking smoothly between snapshots.
const status = document.getElementById('status');
const clockFace = { time: 0, at: 0, live: false, shown: '' };
const CLOCK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.2V8l2.6 1.6"/></svg>';
function updateStatus(s) {
  if (!clockFace.live) { status.innerHTML = `<span class="clock">${CLOCK_ICON}<b></b><i>since genesis</i></span>`; clockFace.shown = ''; }
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
}
function statusNote(text) {
  clockFace.live = false;
  status.textContent = text;
}

// The compendium arrives whole once, then as the teachings that changed (server/delta.js).
const teachings = new Map();
function onCompendium(msg) {
  if (msg.full) teachings.clear();
  for (const t of msg.upsert) teachings.set(t.id, t);
  for (const id of teachings.keys()) if (!msg.ids.includes(id)) teachings.delete(id);
  const c = { ...msg.head, teachings: msg.ids.map((id) => teachings.get(id)).filter(Boolean) };
  book.update(c);
  updateCover(c);
}

// The live connection. A tab that's been hidden for a while lets go of it (nobody is watching, and
// the tank streams constantly) and picks it back up when it's shown again. Reconnects back off,
// with jitter, so a restarted server isn't hit by every observer at once.
let socket = null, retries = 0, hiddenTimer = null;
const sleep = document.getElementById('sleep');
// The note is set as a line and, after its ellipsis, a quieter one ("the fish are sleeping…" / "check back soon").
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
    // A paused tank sends a note first, then the tank as it was left, and nothing after.
    if (msg.t === 'paused') { paused = true; sleeping(msg.text); }
    else if (msg.t === 'snap') { if (msg.full && !paused) sleeping(null); s.onSnapshot(msg); }
    else if (msg.t === 'compendium') onCompendium(msg);
    else if (msg.t === 'departed') { swumOut = msg; renderCodex(s); }
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
  parent: 'tank',
  width: W,
  height: H,
  backgroundColor: '#02070c',
  // Cover the whole tank area (trimming a sliver off whichever edges don't fit) rather than letterboxing it.
  scale: { mode: Phaser.Scale.ENVELOP, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: Tank,
});
