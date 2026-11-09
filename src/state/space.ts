// Spacecraft and launches in the browser. Element sets arrive from the
// aggregator a few times a day; every position is propagated here with SGP4,
// so stations and satellites move smoothly and accurately between fetches.

import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';
import type { Launch, SatTle, SpacePayload } from '../../shared/protocol.ts';

export interface SatPos { lat: number; lon: number; alt: number; vel: number }
export interface Sat extends SatTle { rec: SatRec; periodMin: number; incl: number }

class Space {
  sats: Sat[] = [];
  launches: Launch[] = [];
  loaded = false;
  private ls = new Set<() => void>();
  on(fn: () => void) { this.ls.add(fn); return () => this.ls.delete(fn); }

  start() {
    const tick = async () => {
      try {
        const r = await fetch('/api/space');
        if (r.ok) {
          const d = (await r.json()) as SpacePayload;
          this.sats = (d.sats ?? []).flatMap((t) => {
            try {
              const rec = twoline2satrec(t.l1, t.l2);
              // Mean motion is in radians a minute.
              return [{ ...t, rec, periodMin: (2 * Math.PI) / rec.no, incl: (rec.inclo * 180) / Math.PI }];
            } catch { return []; }
          });
          this.launches = d.launches ?? [];
          this.loaded = true;
          for (const fn of this.ls) fn();
        }
      } catch { /* next round */ }
      setTimeout(tick, 30 * 60_000);
    };
    tick();
  }

  get(id: string): Sat | undefined { return this.sats.find((s) => `sat:${s.norad}` === id); }

  /** Where a spacecraft is at `ms`, or null when its elements have decayed. */
  pos(s: Sat, ms = Date.now()): SatPos | null {
    const d = new Date(ms);
    const pv = propagate(s.rec, d);
    if (!pv || typeof pv.position !== 'object' || !pv.position || typeof pv.velocity !== 'object' || !pv.velocity) return null;
    const g = eciToGeodetic(pv.position, gstime(d));
    const v = pv.velocity;
    const vel = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3600;
    const lat = degreesLat(g.latitude), lon = degreesLong(g.longitude);
    if (!isFinite(lat) || !isFinite(lon) || !(g.height > 80)) return null;
    return { lat, lon, alt: g.height, vel };
  }

  /** Ground track from `back` minutes ago to `ahead` minutes on, split at the antimeridian. */
  track(s: Sat, back: number, ahead: number): { past: [number, number][][]; future: [number, number][][] } {
    const now = Date.now();
    const part = (from: number, to: number) => {
      const segs: [number, number][][] = [[]];
      for (let m = from; m <= to; m += 0.5) {
        const p = this.pos(s, now + m * 60_000);
        if (!p) continue;
        const seg = segs[segs.length - 1];
        const prev = seg[seg.length - 1];
        if (prev && Math.abs(prev[0] - p.lon) > 180) segs.push([]);
        segs[segs.length - 1].push([p.lon, p.lat]);
      }
      return segs.filter((x) => x.length > 1);
    };
    return { past: part(-back, 0), future: part(0, ahead) };
  }
}

export const space = new Space();

export const SAT_KIND_LABEL: Record<SatTle['kind'], string> = {
  station: 'Space station', crew: 'Crew spacecraft', cargo: 'Cargo spacecraft', module: 'Station hardware', telescope: 'Space telescope', satellite: 'Satellite',
};

/** "in 3 h 20 min" / "4 min ago". */
export function countdown(ms: number): string {
  const s = Math.round((ms - Date.now()) / 1000);
  const a = Math.abs(s);
  const t = a < 60 ? `${a} s` : a < 3600 ? `${Math.floor(a / 60)} min` : a < 86400 ? `${Math.floor(a / 3600)} h ${Math.floor((a % 3600) / 60)} min` : `${Math.floor(a / 86400)} d ${Math.floor((a % 86400) / 3600)} h`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}
