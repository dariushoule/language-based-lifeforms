// Geometry shared by the sim and the renderer, so both agree on where the sand and water are.
export const WORLD = { width: 1280, height: 720, surface: 48 };

// The sand floor gently undulates; plants root on it and fish can't swim below it.
export const sandAt = (x) => 648 + 11 * Math.sin(x / 173) + 5 * Math.sin(x / 61 + 1.3);

// The colored sands fish can gather, each from its own deposit on the floor.
export const SANDS = [
  { name: 'bone', color: '#efe4cc' }, { name: 'ochre', color: '#d9a441' }, { name: 'gold', color: '#f5cd4f' },
  { name: 'coral', color: '#ff7f66' }, { name: 'rust', color: '#b8452c' }, { name: 'rose', color: '#e86aa6' },
  { name: 'violet', color: '#8d6cff' }, { name: 'indigo', color: '#3c4fd6' }, { name: 'sky', color: '#7fd4ff' },
  { name: 'teal', color: '#2ec4b6' }, { name: 'jade', color: '#4cb86a' }, { name: 'charcoal', color: '#2c3038' },
];
export const depositX = (i) => Math.round(70 + i * ((WORLD.width - 140) / (SANDS.length - 1)));

// The sand mandala on the tank's back wall. Ring 0 is the center disc; ring r > 0 has 2r slots per
// quadrant. A grain laid in quadrant one is mirrored into the other three.
// Once every place is filled it stands for `admire` seconds, then its sand falls and the wall is bare.
export const MANDALA = { x: WORLD.width / 2, y: 300, rings: 12, inner: 12, step: 13, admire: 600 };
export const slotsIn = (ring) => (ring === 0 ? 1 : ring * 2);
export const mandalaCells = () => {
  let n = 0;
  for (let r = 0; r < MANDALA.rings; r++) n += slotsIn(r);
  return n;
};

// Where (ring, slot) sits in quadrant q (0-3, counterclockwise from upper right), as an angle range
// and radius range; and its center point on screen.
export function cellShape(ring, slot, q) {
  const n = slotsIn(ring);
  const r0 = ring === 0 ? 0 : MANDALA.inner + (ring - 1) * MANDALA.step, r1 = MANDALA.inner + ring * MANDALA.step;
  let a0 = (slot / n) * (Math.PI / 2), a1 = ((slot + 1) / n) * (Math.PI / 2);
  if (q === 1) [a0, a1] = [Math.PI - a1, Math.PI - a0];
  else if (q === 2) [a0, a1] = [Math.PI + a0, Math.PI + a1];
  else if (q === 3) [a0, a1] = [2 * Math.PI - a1, 2 * Math.PI - a0];
  return { r0, r1, a0, a1 };
}
export function cellCenter(ring, slot, q) {
  const { r0, r1, a0, a1 } = cellShape(ring, slot, q);
  const r = ring === 0 ? 0 : (r0 + r1) / 2, a = (a0 + a1) / 2;
  return { x: MANDALA.x + Math.cos(a) * r, y: MANDALA.y - Math.sin(a) * r };
}
