// The moon's lit shape, shared by the scene (as points) and the page (as SVG): the bright limb is a
// half circle on the side the sun went down on, and the terminator is half an ellipse that sweeps
// from that limb (new) through a straight line (half) to the far limb (full).

// Points around the lit part of a disc of radius r centered on (0, 0). phase: 0 new, 0.5 full, 1 new.
export function litShape(phase, r, steps = 14) {
  const lit = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const side = phase < 0.5 ? 1 : -1; // waxing: bright toward the west wall (screen right)
  const pts = [];
  for (let i = 0; i <= steps; i++) { const a = -Math.PI / 2 + (i / steps) * Math.PI; pts.push({ x: side * Math.cos(a) * r, y: Math.sin(a) * r }); }
  for (let i = steps; i >= 0; i--) { const a = -Math.PI / 2 + (i / steps) * Math.PI; pts.push({ x: side * (1 - 2 * lit) * Math.cos(a) * r, y: Math.sin(a) * r }); }
  return pts;
}

// The dark part: what's left of the disc.
export function darkShape(phase, r, steps = 14) {
  const lit = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const side = phase < 0.5 ? 1 : -1;
  const pts = [];
  for (let i = 0; i <= steps; i++) { const a = -Math.PI / 2 + (i / steps) * Math.PI; pts.push({ x: -side * Math.cos(a) * r, y: Math.sin(a) * r }); }
  for (let i = steps; i >= 0; i--) { const a = -Math.PI / 2 + (i / steps) * Math.PI; pts.push({ x: side * (1 - 2 * lit) * Math.cos(a) * r, y: Math.sin(a) * r }); }
  return pts;
}

// A small picture of the moon at `phase`, for the sidebar and the book. `ink` draws it for paper
// (dark on light); otherwise it's drawn for the night. `absent` is a sky with no moon in it.
export function moonSvg(phase, { ink = false, absent = false, rust = false } = {}) {
  const bright = ink ? '#3a3f7a' : rust ? '#d0764a' : '#e6ecff', ghost = ink ? '#3a3f7a' : '#8f9bd0';
  if (absent) return `<svg viewBox="-12 -12 24 24" aria-hidden="true"><circle r="9" fill="none" stroke="${ghost}" stroke-width="0.9" stroke-dasharray="1.6 2.2" opacity="0.7"/></svg>`;
  const d = litShape(phase, 9, 10).map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('') + 'Z';
  return `<svg viewBox="-12 -12 24 24" aria-hidden="true"><circle r="9" fill="${ghost}" opacity="${ink ? 0.14 : 0.2}"/><path d="${d}" fill="${bright}"/>` +
    (ink ? `<circle r="9" fill="none" stroke="${ghost}" stroke-width="0.7"/>` : '') + '</svg>';
}

// The moon as an observer would name it (the fireflies have no such words).
export function phaseName(phase) {
  const names = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
  return names[Math.round(phase * 8) % 8];
}
