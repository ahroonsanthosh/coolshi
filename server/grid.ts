// Where to sweep the ADS-B networks for a worldwide picture without OpenSky:
// a lattice of 250 nm circles kept only where there is a scheduled airport
// within reach (no point asking about empty ocean), and ranked by how many
// airports each covers so busy airspace refreshes first.
//
// Rows and columns are 1.4·R apart (R the circle radius), staggered. Rows
// at different latitudes hold different numbers of columns, so somewhere
// round the globe any two rows' columns line up; even there the middle of
// the four nearest centres is 0.99·R from each, so no point is out of reach.
// (A tidy hexagonal lattice can't promise that once its rows drift out of
// phase.) The old 7.5° lattice left gaps of 520 km and 311 scheduled
// airports, Munich, Stuttgart and Vancouver among them, outside every circle.

import { readFileSync } from 'node:fs';
import { distance, EARTH_R, NM } from '../shared/geo.ts';

export interface SweepPoint { lat: number; lon: number; weight: number }

export const SWEEP_NM = 250;

export function sweepGrid(airportsJson: string, radiusNm = SWEEP_NM): SweepPoint[] {
  const airports = JSON.parse(readFileSync(airportsJson, 'utf8')) as [string, string, string, string, string, number, number][];
  const R = radiusNm * NM;
  const rDeg = (R / EARTH_R) * (180 / Math.PI);
  const row = 1.4 * rDeg;
  const col = 1.4 * rDeg;
  const out: SweepPoint[] = [];
  const kMax = Math.floor(84 / row);
  for (let k = -kMax; k <= kMax; k++) {
    const lat = k * row;
    // Columns spaced for the row's equatorward edge, where a degree of
    // longitude is longest, and a whole number of them round the globe so
    // there is no gap at the antimeridian.
    const edge = Math.max(0, Math.abs(lat) - row / 2);
    const n = Math.max(1, Math.ceil((360 * Math.cos((edge * Math.PI) / 180)) / col));
    const step = 360 / n;
    for (let i = 0; i < n; i++) {
      const lon = -180 + ((k & 1) * step) / 2 + i * step;
      let w = 0;
      for (const a of airports) {
        if (Math.abs(a[5] - lat) <= rDeg && distance(lat, lon, a[5], a[6]) <= R) w++;
      }
      if (w) out.push({ lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, weight: w });
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}
