// SIGMETs in force: where they are, and whether an aircraft is inside one
// (inside the area and between its levels).

import type { Hazard, HazardPayload } from '../../shared/protocol.ts';

interface Indexed { h: Hazard; box: [number, number, number, number] }

export const hazards = { items: [] as Hazard[], at: 0 };
let indexed: Indexed[] = [];
let fetched = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const onHazards = (fn: () => void) => listeners.add(fn);

/** Fetch if older than four minutes (or never fetched). */
export function loadHazards(): Promise<void> {
  if (loading) return loading;
  if (Date.now() - fetched < 240_000) return Promise.resolve();
  loading = (async () => {
    try {
      const r = await fetch('/api/hazards');
      if (!r.ok) return;
      const d = (await r.json()) as HazardPayload;
      fetched = Date.now();
      hazards.items = d.items;
      hazards.at = d.at;
      indexed = d.items.map((h) => {
        let w = 180, s = 90, e = -180, n = -90;
        for (const ring of h.rings) for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
        return { h, box: [w, s, e, n] };
      });
      listeners.forEach((fn) => fn());
    } catch { /* optional */ } finally {
      loading = null;
    }
  })();
  return loading;
}

function inRing(ring: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Warnings in force at this point and altitude (ft; null = any level). */
export function hazardsAt(lon: number, lat: number, alt: number | null, now = Date.now()): Hazard[] {
  const out: Hazard[] = [];
  for (const { h, box } of indexed) {
    if (h.from > now || h.to < now) continue;
    if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
    if (alt !== null && ((h.base !== null && alt < h.base) || (h.top !== null && alt > h.top))) continue;
    if (h.rings.some((r) => inRing(r, lon, lat))) out.push(h);
  }
  return out;
}

export const HAZARD_COLOR: Record<Hazard['kind'], string> = {
  storm: '#a01f73', turb: '#c06a00', ice: '#3d6fc0', ash: '#5a524a', cyclone: '#d9342b', wave: '#2e7d9a', dust: '#b07a3c', other: '#8a8379',
};

/** "FL300–FL390", "surface–FL240", "up to FL450". */
export function levels(h: Pick<Hazard, 'base' | 'top'>): string {
  const fl = (ft: number) => (ft >= 18_000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${ft.toLocaleString('en')} ft`);
  if (h.base === null && h.top === null) return 'all levels';
  if (h.base === null || h.base === 0) return h.top === null ? 'all levels' : `surface–${fl(h.top)}`;
  return h.top === null ? `${fl(h.base)} and above` : `${fl(h.base)}–${fl(h.top)}`;
}
