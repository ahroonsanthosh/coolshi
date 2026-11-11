// Estimated positions beyond receiver range, the way commercial trackers
// fill the oceans: when an airliner at cruise falls silent, and its filed
// route is confirmed by where it is and where it is heading, it is carried on
// along the great circle to its destination at its last ground speed until
// receivers near the destination should hear it again. Estimates are flagged
// as such everywhere they are shown, and replaced by the first real report.

import { A, AF, type AircraftRow } from '../shared/protocol.ts';
import { bearing, distance } from '../shared/geo.ts';
import { checkRoute, type Airport, type Route } from '../shared/route.ts';
import { every, getJson, Status } from './feeds/http.ts';

const AIRLINE_CS = /^[A-Z]{3}\d[0-9A-Z]{0,4}$/;
const TTL_MS = 6 * 3_600_000;

export class Estimator {
  status = new Status('estimates', 'Estimated positions', 'air', 1.2);
  private routes = new Map<string, { r: Route | null; t: number }>();
  private queue: string[] = [];
  private queued = new Set<string>();

  constructor() {
    this.status.note = 'beyond receiver range, from verified routes';
    // One lookup at a time: a slow adsbdb must not stack calls up (an
    // interval timer started a new one every 1.2 s whatever the last did).
    every(() => 1.2, () => this.work());
  }

  /** How many aircraft are being carried as estimates now (the store knows; index.ts counts). */
  set active(n: number) {
    this.status.count = n;
    this.status.note = `${n} aircraft carried beyond receiver range on verified routes`;
  }

  private eligible(row: AircraftRow): boolean {
    if (row[A.flags] & (AF.ground | AF.mil)) return false;
    return AIRLINE_CS.test(row[A.cs]) && (row[A.alt] ?? 0) >= 20_000 && (row[A.gs] ?? 0) >= 250 && row[A.trk] !== null;
  }

  /** Look the route up ahead of time, while the aircraft is still fresh. */
  quiet(row: AircraftRow) {
    const cs = row[A.cs];
    if (!this.eligible(row) || this.queued.has(cs)) return;
    const c = this.routes.get(cs);
    if (c && Date.now() - c.t < TTL_MS) return;
    this.queued.add(cs);
    this.queue.push(cs);
    if (this.queue.length > 2000) this.queued.delete(this.queue.shift()!);
  }

  private async work() {
    const cs = this.queue.shift();
    if (!cs) return;
    this.queued.delete(cs);
    try {
      const { data } = await getJson<any>(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, {}, 8000);
      const fr = data?.response?.flightroute;
      const ap = (a: any): Airport => ({
        icao: a.icao_code, iata: a.iata_code, name: a.name, city: a.municipality, country: a.country_name, lat: a.latitude, lon: a.longitude,
      });
      this.routes.set(cs, {
        r: fr?.origin && fr?.destination ? { airline: fr.airline?.name ?? '', airlineCountry: '', callsignIata: '', from: ap(fr.origin), to: ap(fr.destination) } : null,
        t: Date.now(),
      });
      this.status.success(this.status.count, this.status.note);
    } catch (e: any) {
      // adsbdb answers 404 for callsigns it doesn't know.
      if (e?.status === 404) this.routes.set(cs, { r: null, t: Date.now() });
      else this.status.fail(e);
    }
    if (this.routes.size > 20_000) this.routes.clear();
  }

  estimate(row: AircraftRow): { lat: number; lon: number; eta: number } | null {
    if (!this.eligible(row)) return null;
    const r = this.routes.get(row[A.cs])?.r;
    if (!r) return null;
    const lat = row[A.lat], lon = row[A.lon], trk = row[A.trk]!;
    const chk = checkRoute(r, lat, lon, trk, false);
    if (!chk.ok) return null;
    // Stricter than for drawing a route: it must be pointing at the
    // destination, since we are about to extrapolate towards it.
    const want = bearing(lat, lon, r.to.lat, r.to.lon);
    if (Math.abs(((trk - want + 540) % 360) - 180) > 30) return null;
    const remaining = distance(lat, lon, r.to.lat, r.to.lon);
    if (remaining < 500_000) return null; // close enough to be heard again
    const eta = row[A.posT] + remaining / ((row[A.gs] ?? 0) * 0.514444);
    return { lat: r.to.lat, lon: r.to.lon, eta };
  }
}
