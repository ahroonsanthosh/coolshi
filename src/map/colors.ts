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
