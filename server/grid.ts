// Where to sweep the ADS-B networks for a worldwide picture without OpenSky:
// a lattice of 250 nm circles, about 7.5° apart, kept only where there is a
// scheduled airport within reach (no point asking about empty ocean), and
// ranked by how many airports each covers so busy airspace refreshes first.

import { readFileSync } from 'node:fs';
import { distance } from '../shared/geo.ts';

export interface SweepPoint { lat: number; lon: number; weight: number }

export function sweepGrid(airportsJson: string): SweepPoint[] {
  const airports = JSON.parse(readFileSync(airportsJson, 'utf8')) as [string, string, string, string, string, number, number][];
  const out: SweepPoint[] = [];
  for (let row = 0; row < 17; row++) {
    const lat = -52.5 + row * 7.5;
    const step = 7.5 / Math.max(0.3, Math.cos((lat * Math.PI) / 180));
    for (let lon = -180 + (row % 2) * (step / 2); lon < 180; lon += step) {
      let n = 0;
      for (const a of airports) {
        if (Math.abs(a[5] - lat) < 4.5 && distance(lat, lon, a[5], a[6]) < 460_000) n++;
      }
      if (n) out.push({ lat, lon: Math.round(lon * 10) / 10, weight: n });
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}
