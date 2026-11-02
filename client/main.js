import Phaser from 'phaser';

const ZOOM = 2; // integer scale keeps art on the pixel grid
const FACES = ['curious', 'happy', 'uneasy', 'lonely', 'sleepy'];
const card = document.getElementById('card');

class WorldScene extends Phaser.Scene {
  constructor() { super('world'); }

  preload() {
    this.load.image('lbl_body', 'sprites/lbl_body.png');
    for (const f of FACES) this.load.image(`face_${f}`, `sprites/face_${f}.png`);
    this.load.image('ground', 'sprites/ground.png');
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
    if (!this.textures.exists('ground')) {
      const g = this.make.graphics({ add: false });
      g.fillStyle(0x733e39).fillRect(0, 0, 32, 32);
      g.fillStyle(0x3e8948).fillRect(0, 0, 32, 8);
      g.generateTexture('ground', 32, 32);
    }
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => this.onSnapshot(JSON.parse(ev.data));
    ws.onclose = () => setTimeout(() => this.connect(), 1000);
  }

  onSnapshot(snap) {
    if (!this.state) this.buildWorld(snap.world);
    this.state = snap;
    const seen = new Set();
    for (const e of snap.entities) {
      seen.add(e.id);
      let s = this.sprites.get(e.id);
      if (!s) {
        s = this.add.image(e.x, e.y, e.sprite).setOrigin(0.5, 1).setInteractive({ pixelPerfect: true });
        s.on('pointerover', () => (this.hovered = e.id));
        s.on('pointerout', () => { if (this.hovered === e.id) this.hovered = null; });
        // Faces are overlays on the same 16x24 canvas as the body, so they share its origin.
        s.face = this.add.image(e.x, e.y, 'face_curious').setOrigin(0.5, 1);
        this.sprites.set(e.id, s);
      }
      s.target = e;
      s.face.setTexture(FACES.includes(e.emotion) ? `face_${e.emotion}` : 'face_curious');
    }
    for (const [id, s] of this.sprites) if (!seen.has(id)) { s.face.destroy(); s.destroy(); this.sprites.delete(id); }
  }

  buildWorld(w) {
    this.cameras.main.setBounds(0, 0, w.width, w.height);
    this.add.rectangle(0, w.groundY, w.width, w.height - w.groundY, 0x733e39).setOrigin(0, 0);
    this.add.tileSprite(0, w.groundY, w.width, 32, 'ground').setOrigin(0, 0);
  }

  update(_t, dtMs) {
    // Ease toward the latest server position (snapshots arrive at 10Hz).
    const k = 1 - Math.exp(-dtMs / 60);
    for (const s of this.sprites.values()) {
      s.x += (s.target.x - s.x) * k;
      s.y += (s.target.y - s.y) * k;
      s.x = Math.round(s.x); s.y = Math.round(s.y);
      s.face.setPosition(s.x, s.y);
    }
    this.renderCard();
  }

  moveCard(p) {
    card.style.left = `${p.event.clientX + 16}px`;
    card.style.top = `${p.event.clientY + 16}px`;
  }

  renderCard() {
    const e = this.hovered && this.sprites.get(this.hovered)?.target;
    if (!e) { card.style.display = 'none'; return; }
    const age = Math.floor((Date.now() - e.bornAt) / 1000);
    const bars = Object.entries(e.needs)
      .map(([k, v]) => `<div>${k}</div><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div>`)
      .join('');
    card.innerHTML =
      `<h3>${e.name}</h3><div class="muted">LBL #${e.id} · age ${age}s · feels ${e.emotion}</div>` +
      `<p>${e.background}</p><p><i>“${e.thought}”</i></p>${bars}`;
    card.style.display = 'block';
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
