// Draws the sand mandala on the tank's back wall, and the deposits of colored sand on the floor
// that fish carry it up from. A cell laid in quadrant one is drawn in all four, mirrored.
import { MANDALA, SANDS, slotsIn, cellShape, depositX, sandAt, mandalaCells } from '../shared/world.js';
import { rng } from '../shared/plants.js';

const COLOR = Object.fromEntries(SANDS.map((s) => [s.name, parseInt(s.color.slice(1), 16)]));
const outer = MANDALA.inner + (MANDALA.rings - 1) * MANDALA.step;

// The cell (ring, slot) in quadrant q as a polygon of screen points.
function cellPoints(ring, slot, q) {
  const { r0, r1, a0, a1 } = cellShape(ring, slot, q);
  const steps = Math.max(2, Math.ceil(((a1 - a0) * r1) / 5));
  const at = (r, a) => ({ x: MANDALA.x + Math.cos(a) * r, y: MANDALA.y - Math.sin(a) * r });
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(at(r1, a0 + ((a1 - a0) * i) / steps));
  if (r0 === 0) pts.push(at(0, 0));
  else for (let i = steps; i >= 0; i--) pts.push(at(r0, a0 + ((a1 - a0) * i) / steps));
  return pts;
}

// Lighter and darker flecks so each cell reads as sand, not paint. Seeded per cell, so stable.
function grains(gfx, ring, slot, q) {
  const { r0, r1, a0, a1 } = cellShape(ring, slot, q);
  const r = rng(ring * 1000 + slot * 10 + q + 7);
  const n = Math.round(((a1 - a0) * (r1 * r1 - r0 * r0)) / 40);
  for (let i = 0; i < n; i++) {
    const rad = Math.sqrt(r0 * r0 + r() * (r1 * r1 - r0 * r0)), a = a0 + r() * (a1 - a0);
    const light = r() < 0.5;
    gfx.fillStyle(light ? 0xffffff : 0x000000, light ? 0.14 : 0.18)
      .fillRect(MANDALA.x + Math.cos(a) * rad - 0.6, MANDALA.y - Math.sin(a) * rad - 0.6, 1.2, 1.2);
  }
}

export function drawMandala(gfx, cells) {
  gfx.clear();
  // Just the faint edge of where the mandala will grow.
  gfx.lineStyle(1, 0xd8f4ff, 0.06).strokeCircle(MANDALA.x, MANDALA.y, outer);
  for (const [key, cell] of Object.entries(cells ?? {})) {
    const [ring, slot] = key.split(':').map(Number);
    if (ring >= MANDALA.rings || slot >= slotsIn(ring)) continue;
    for (let q = 0; q < 4; q++) {
      const pts = cellPoints(ring, slot, q);
      gfx.fillStyle(COLOR[cell.color] ?? 0x888888, 0.93).fillPoints(pts, true);
      gfx.lineStyle(0.7, 0x000000, 0.22).strokePoints(pts, true);
      grains(gfx, ring, slot, q);
    }
  }
}

export const mandalaProgress = (cells) => `${Object.keys(cells ?? {}).length} of ${mandalaCells()} places filled`;

// Mounds of colored sand along the floor, one per color.
export function drawDeposits(gfx) {
  gfx.clear();
  SANDS.forEach((s, i) => {
    const x = depositX(i), y = sandAt(x) + 3;
    const c = COLOR[s.name];
    const r = rng(i + 99);
    gfx.fillStyle(c, 0.95).fillEllipse(x, y, 34, 10);
    gfx.fillStyle(c, 0.9).fillEllipse(x, y - 3, 22, 8);
    for (let k = 0; k < 40; k++) {
      const light = r() < 0.5;
      gfx.fillStyle(light ? 0xffffff : 0x000000, light ? 0.2 : 0.22).fillRect(x + (r() - 0.5) * 30, y - 5 + r() * 8, 1.2, 1.2);
    }
  });
}
