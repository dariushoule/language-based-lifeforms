import Phaser from 'phaser';

const ZOOM = 2; // integer scale keeps art on the pixel grid
const FACES = ['curious', 'happy', 'uneasy', 'lonely', 'sleepy'];
const DEPTH = { tree: 1, block: 2, lbl: 3, face: 4, carried: 5, bubble: 6 };
const card = document.getElementById('card');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

class WorldScene extends Phaser.Scene {
  constructor() { super('world'); }

  preload() {
    for (const s of ['lbl_body', 'ground', 'tree', 'stump', 'wood_block']) this.load.image(s, `sprites/${s}.png`);
    for (const f of FACES) this.load.image(`face_${f}`, `sprites/face_${f}.png`);
    // Missing art is fine: we fall back to placeholder blocks in create().
    this.load.on('loaderror', () => {});
  }

  create() {
    this.makePlaceholders();
    this.sprites = new Map();
    this.state = null;
    this.hovered = null;
    this.connect();
    this.input.on('pointermove', (p) => this.moveCard(p));
  }

  makePlaceholders() {
    const tex = (key, w, h, draw) => {
      if (this.textures.exists(key)) return;
      const g = this.make.graphics({ add: false });
      draw(g);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    tex('ground', 32, 32, (g) => g.fillStyle(0x733e39).fillRect(0, 0, 32, 32).fillStyle(0x3e8948).fillRect(0, 0, 32, 8));
    tex('tree', 16, 48, (g) => g.fillStyle(0x3e8948).fillRect(0, 0, 16, 24).fillStyle(0x733e39).fillRect(6, 24, 4, 24));
    tex('stump', 8, 6, (g) => g.fillStyle(0x733e39).fillRect(0, 0, 8, 6));
    tex('wood_block', 8, 8, (g) => g.fillStyle(0xb86f50).fillRect(0, 0, 8, 8));
    // Thought bubble shown while the mind is deciding: three dots in a white box.
    tex('bubble', 11, 5, (g) => {
      g.fillStyle(0x181425).fillRect(0, 0, 11, 5).fillStyle(0xffffff).fillRect(1, 1, 9, 3);
      g.fillStyle(0x3e2731).fillRect(2, 2, 1, 1).fillRect(5, 2, 1, 1).fillRect(8, 2, 1, 1);
    });
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => this.onSnapshot(JSON.parse(ev.data));
    ws.onclose = () => setTimeout(() => this.connect(), 1000);
  }

  spawn(e) {
    const s = this.add.image(e.x, e.y, e.sprite).setOrigin(0.5, 1).setDepth(DEPTH[e.kind] ?? 1)
      .setInteractive({ pixelPerfect: true });
    s.on('pointerover', () => (this.hovered = e.id));
    s.on('pointerout', () => { if (this.hovered === e.id) this.hovered = null; });
    s.parts = [];
    if (e.kind === 'lbl') {
      // Faces are overlays on the same 16x24 canvas as the body, so they share its origin.
      s.face = this.add.image(e.x, e.y, 'face_curious').setOrigin(0.5, 1).setDepth(DEPTH.face);
      s.carried = [0, 1, 2].map(() => this.add.image(0, 0, 'wood_block').setOrigin(0.5, 1).setDepth(DEPTH.carried).setVisible(false));
      s.bubble = this.add.image(0, 0, 'bubble').setOrigin(0, 1).setDepth(DEPTH.bubble).setVisible(false);
      s.parts.push(s.face, ...s.carried, s.bubble);
    }
    return s;
  }

  onSnapshot(snap) {
    if (!this.state) this.buildWorld(snap.world);
    this.state = snap;
    const seen = new Set();
    for (const e of snap.entities) {
      seen.add(e.id);
      let s = this.sprites.get(e.id);
      if (!s) this.sprites.set(e.id, (s = this.spawn(e)));
      s.target = e;
      if (s.texture.key !== e.sprite) s.setTexture(e.sprite);
      if (e.kind === 'lbl') s.face.setTexture(FACES.includes(e.emotion) ? `face_${e.emotion}` : 'face_curious');
      if (e.kind !== 'lbl') s.setPosition(e.x, e.y);
    }
    for (const [id, s] of this.sprites) if (!seen.has(id)) {
      for (const p of s.parts) p.destroy();
      s.destroy();
      this.sprites.delete(id);
    }
  }

  buildWorld(w) {
    this.cameras.main.setBounds(0, 0, w.width, w.height);
    this.add.rectangle(0, w.groundY, w.width, w.height - w.groundY, 0x733e39).setOrigin(0, 0);
    this.add.tileSprite(0, w.groundY, w.width, 32, 'ground').setOrigin(0, 0);
  }

  update(time, dtMs) {
    // Ease toward the latest server position (snapshots arrive at 10Hz).
    const k = 1 - Math.exp(-dtMs / 60);
    for (const s of this.sprites.values()) {
      const e = s.target;
      if (e.kind === 'tree') {
        // Cosmetic shake while someone chops it.
        s.x = e.x + (e.choppedBy ? (Math.floor(time / 80) % 2 ? 1 : -1) : 0);
        continue;
      }
      if (e.kind !== 'lbl') continue;
      s.ex = (s.ex ?? e.x) + (e.x - (s.ex ?? e.x)) * k;
      s.ey = (s.ey ?? e.y) + (e.y - (s.ey ?? e.y)) * k;
      const bob = e.moving && Math.floor(time / 120) % 2 ? -1 : 0;
      const x = Math.round(s.ex), y = Math.round(s.ey) + bob;
      s.setPosition(x, y);
      s.face.setPosition(x, y);
      // Carried wood rides on the head, up to three blocks tall.
      s.carried.forEach((c, i) => c.setVisible(i < e.carrying.wood).setPosition(x, y - e.h - i * 8));
      s.bubble.setVisible(e.brain === 'thinking').setPosition(x + 6, y - e.h - Math.min(e.carrying.wood, 3) * 8 - 1);
    }
    this.renderCard();
  }

  moveCard(p) {
    this.pointer = { x: p.event.clientX, y: p.event.clientY };
  }

  // Keeps the card beside the pointer but inside the window, flipping sides near the edges.
  placeCard() {
    if (!this.pointer) return;
    const { x, y } = this.pointer, w = card.offsetWidth, h = card.offsetHeight;
    card.style.left = `${x + 16 + w > innerWidth ? Math.max(0, x - 16 - w) : x + 16}px`;
    card.style.top = `${Math.max(0, Math.min(y + 16, innerHeight - h - 4))}px`;
  }

  ago(at) { return `${Math.max(0, Math.round(this.state.time - at))}s ago`; }

  renderCard() {
    const e = this.hovered && this.sprites.get(this.hovered)?.target;
    if (!e) { card.style.display = 'none'; return; }
    card.innerHTML = this[`card_${e.kind}`]?.(e) ?? '';
    card.style.display = 'block';
    this.placeCard();
  }

  card_lbl(e) {
    const age = Math.floor((Date.now() - e.bornAt) / 1000);
    const bars = Object.entries(e.needs)
      .map(([k, v]) => `<div>${k}</div><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div>`)
      .join('');
    const mind = { mind: 'mind', thinking: 'thinking…', instinct: 'acting on instinct', waking: 'waking up' }[e.brain] ?? e.brain;
    const doing = e.doing ? `${e.doing}${e.plan.length ? `, then ${e.plan.join(', then ')}` : ''}` : e.brain === 'thinking' ? 'stopped to think' : 'idle';
    const memory = e.memory.slice().reverse().map((m) => `<li>${esc(m.text)} <span class="muted">${this.ago(m.at)}</span></li>`).join('');
    return `<h3>${esc(e.name)}</h3><div class="muted">LBL #${e.id} · age ${age}s · feels ${e.emotion} · ${mind}</div>` +
      `<p>${esc(e.background)}</p><p><i>“${esc(e.thought)}”</i></p>` + this.reasoning(e) +
      `<p><b>Doing:</b> ${esc(doing)}<br><b>Carrying:</b> ${e.carrying.wood} wood</p>${bars}` +
      (memory ? `<div class="muted">Remembers</div><ul>${memory}</ul>` : '');
  }

  // The mind's private reasoning: live while it decides, then the end of how it got there.
  reasoning(e) {
    if (!e.reasoning) return '';
    const live = e.brain === 'thinking';
    let text = e.reasoning.trim().replace(/\s+/g, ' ');
    const keep = live ? 420 : 260;
    if (text.length > keep) text = '…' + text.slice(-keep).replace(/^\S*\s/, '');
    return `<div class="muted">${live ? 'Thinking it through…' : 'How it decided'}</div><p class="reasoning">${esc(text)}</p>`;
  }

  card_tree(e) {
    const state = e.wood > 0 ? `${e.wood}/${e.maxWood} wood left` : 'a stump, slowly regrowing';
    return `<h3>Tree #${e.id}</h3><div class="muted">${state}${e.given ? ` · has given ${e.given} wood` : ''}</div><p>${esc(e.background)}</p>`;
  }

  card_block(e) {
    const age = Math.floor((Date.now() - e.placedAt) / 1000);
    return `<h3>Wood block #${e.id}</h3><div class="muted">placed by ${esc(e.placedBy)} ${age}s ago · ${e.row + 1} up from the ground</div>`;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 640,
  height: 360,
  zoom: ZOOM,
  pixelArt: true,
  roundPixels: true,
  backgroundColor: '#0099db',
  scene: WorldScene,
});
