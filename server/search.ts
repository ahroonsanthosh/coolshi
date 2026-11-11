// Ships by name, MMSI, IMO, callsign or destination, anywhere in the world:
// the browser only holds the ships in view.

import { S, type ShipRow } from '../shared/protocol.ts';

/** [mmsi, name, imo, callsign, type, destination, lat, lon] */
export type ShipHit = [number, string, number | null, string, number, string, number, number];

export function searchShips(rows: Iterable<ShipRow>, query: string, limit = 20): ShipHit[] {
  const q = query.trim().toUpperCase().slice(0, 40);
  if (q.length < 3) return [];
  const score = (field: string, base: number) => {
    if (!field) return 0;
    const f = field.toUpperCase();
    return f === q ? base + 3 : f.startsWith(q) ? base + 2 : f.includes(q) ? base + 1 : 0;
  };
  const best: [number, ShipRow][] = [];
  for (const r of rows) {
    const s = Math.max(score(r[S.name], 9), score(String(r[S.mmsi]), 8), score(r[S.imo] ? String(r[S.imo]) : '', 8), score(r[S.callsign], 7), score(r[S.dest], 3));
    if (s) best.push([s + ((r[S.sog] ?? 0) >= 1 ? 0.1 : 0), r]);
  }
  best.sort((a, b) => b[0] - a[0]);
  return best.slice(0, limit).map(([, r]) => [r[S.mmsi], r[S.name], r[S.imo] || null, r[S.callsign], r[S.type], r[S.dest], r[S.lat], r[S.lon]]);
}
