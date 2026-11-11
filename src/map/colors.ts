// One saturated family for aircraft, ordered by altitude so height reads at a
// glance (warm and low → cool and high), one teal for ships, red for the
// planet itself (earthquakes) and for emergencies.

export const ALT_STOPS: [number, string][] = [
  [0, '#e8890c'],
  [4000, '#ea5a1c'],
  [10000, '#df3a58'],
  [20000, '#c1338f'],
  [30000, '#8a3fc4'],
  [38000, '#4b4bd6'],
  [45000, '#1f5fd1'],
];
export const GROUND = '#a29b92';
export const SHIP = '#0d8a7c';
export const SHIP_STILL = '#7fb3aa';
export const QUAKE = '#d9342b';
export const EMERGENCY = '#e2231a';
export const INK = '#2a2724';

export function altColorExpr(): any {
  const e: any[] = ['interpolate', ['linear'], ['get', 'alt']];
  for (const [ft, c] of ALT_STOPS) e.push(ft, c);
  return ['case', ['<', ['get', 'alt'], 0], GROUND, e];
}

export function altColor(ft: number | null, ground = false): string {
  if (ground) return GROUND;
  if (ft === null) return '#8a847c';
  if (ft <= ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for (let i = 1; i < ALT_STOPS.length; i++) {
    const [a, ca] = ALT_STOPS[i - 1], [b, cb] = ALT_STOPS[i];
    if (ft <= b) return mix(ca, cb, (ft - a) / (b - a));
  }
  return ALT_STOPS[ALT_STOPS.length - 1][1];
}

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export function altGradientCss(): string {
  const max = 45000;
  return `linear-gradient(90deg, ${ALT_STOPS.map(([ft, c]) => `${c} ${(ft / max) * 100}%`).join(', ')})`;
}

// Air temperature at weather stations: a diverging ramp, cold blue through
// a pale near-freezing to hot red, kept apart from the aircraft family.
export const TEMP_STOPS: [number, string][] = [
  [-40, '#2c1f6e'],
  [-20, '#3c4fb0'],
  [-5, '#5f9bd0'],
  [5, '#93c2c4'],
  [15, '#d8c27a'],
  [25, '#e98b3c'],
  [33, '#cf3f2e'],
  [40, '#8e1838'],
];

export function tempColorExpr(): any {
  const e: any[] = ['interpolate', ['linear'], ['get', 't']];
  for (const [c, col] of TEMP_STOPS) e.push(c, col);
  return e;
}

export function tempColor(c: number): string {
  if (c <= TEMP_STOPS[0][0]) return TEMP_STOPS[0][1];
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [a, ca] = TEMP_STOPS[i - 1], [b, cb] = TEMP_STOPS[i];
    if (c <= b) return mix(ca, cb, (c - a) / (b - a));
  }
  return TEMP_STOPS[TEMP_STOPS.length - 1][1];
}

export function tempGradientCss(): string {
  const lo = TEMP_STOPS[0][0], hi = TEMP_STOPS[TEMP_STOPS.length - 1][0];
  return `linear-gradient(90deg, ${TEMP_STOPS.map(([c, col]) => `${col} ${((c - lo) / (hi - lo)) * 100}%`).join(', ')})`;
}
