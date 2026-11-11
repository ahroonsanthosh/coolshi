// Who is watching what. Each browser reports its view with every /api/air
// poll; the ADS-B networks are asked about those areas, so zooming in gets
// fresh, detailed traffic. The view comes from the client, so it is clamped,
// counted per address and in total, and snapped to a grid before any
// pairwise work: a thousand made-up client ids cost what 200 real ones do.

import { destination, distance, NM, normLon } from '../shared/geo.ts';

export interface View { id: string; ip: string; lat: number; lon: number; r: number; seen: number; served: number }
export interface ViewPoint { key: string; lat: number; lon: number; r: number }

export const MAX_VIEWS_PER_IP = 4;
export const MAX_VIEWS = 200;
/** Circles asked about for viewers, at most; more than the networks can refresh every few seconds anyway. */
export const MAX_POINTS = 48;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** "lat,lon,r(nm)" → a view on the globe with a sane radius, or null. */
export function clampView(vp: string | null | undefined): { lat: number; lon: number; r: number } | null {
  const v = vp?.split(',').slice(0, 3).map(Number);
  if (!v || v.length < 3 || !v.every(Number.isFinite)) return null;
  // Longitude is wrapped rather than cut off: a map scrolled past the
  // antimeridian reports 190°, which is -170°.
  return { lat: clamp(v[0], -90, 90), lon: normLon(v[1]), r: clamp(v[2], 1, 5000) };
}

const R_STEPS = [25, 35, 50, 70, 100, 140, 200, 250];

/**
 * A circle of at least `r` nm near (lat, lon), on a grid an eighth of its
 * radius across, so nearby views share one circle and one request. The
 * centre moves at most 0.09 of the radius and the radius only grows, so
 * the circle still covers what was asked for.
 */
export function snapPoint(lat: number, lon: number, r: number): ViewPoint {
  const rr = R_STEPS.find((x) => x >= r) ?? 250;
  const dLat = rr / 8 / 60;
  const sLat = clamp(Math.round(lat / dLat) * dLat, -89.5, 89.5);
  const dLon = dLat / Math.max(0.05, Math.cos((sLat * Math.PI) / 180));
  const sLon = normLon(Math.round(lon / dLon) * dLon);
  return { key: `pt:${sLat.toFixed(2)},${sLon.toFixed(2)},${rr}`, lat: sLat, lon: sLon, r: rr };
}

/** The circles (≤ 250 nm, the networks' limit) that cover a view. */
export function viewPoints(v: { lat: number; lon: number; r: number }): ViewPoint[] {
  if (v.r <= 250) return [snapPoint(v.lat, v.lon, Math.max(25, v.r * 1.1))];
  if (v.r > 650) return []; // the worldwide sweep covers a view this wide
  const pts = [snapPoint(v.lat, v.lon, 250)];
  for (let b = 0; b < 360; b += 60) {
    const [lat, lon] = destination(v.lat, v.lon, b, Math.min(v.r * 0.7, 420) * NM);
    pts.push(snapPoint(lat, lon, 250));
  }
  return pts;
}

export class ViewRegistry {
  private map = new Map<string, View>();
  private cache: { t: number; pts: ViewPoint[]; of: Map<View, number[]> } | null = null;

  get size() { return this.map.size; }

  /** Record a client's view. False if it was malformed or there is no room. */
  register(id: string | null | undefined, vp: string | null | undefined, ip: string, now = Date.now()): boolean {
    const v = id ? clampView(vp) : null;
    if (!id || !v) return false;
    const key = id.slice(0, 40);
    const cur = this.map.get(key);
    if (cur) { cur.lat = v.lat; cur.lon = v.lon; cur.r = v.r; cur.seen = now; cur.ip = ip; return true; }
    // A new viewer. One address may hold a few (tabs, a household behind
    // one router); past that its stalest view gives way.
    let n = 0, stalest: View | null = null;
    for (const x of this.map.values()) {
      if (x.ip !== ip) continue;
      n++;
      if (!stalest || x.seen < stalest.seen) stalest = x;
    }
    if (n >= MAX_VIEWS_PER_IP && stalest) this.map.delete(stalest.id);
    else if (this.map.size >= MAX_VIEWS) {
      this.prune(now);
      if (this.map.size >= MAX_VIEWS) return false;
    }
    this.map.set(key, { id: key, ip, ...v, seen: now, served: 0 });
    return true;
  }

  watching(now = Date.now()): boolean {
    for (const v of this.map.values()) if (now - v.seen < 60_000) return true;
    return false;
  }

  /** Views reported in the last `within` ms. */
  active(now = Date.now(), within = 30_000): View[] {
    const out: View[] = [];
    for (const v of this.map.values()) if (now - v.seen <= within) out.push(v);
    return out;
  }

  prune(now = Date.now()) {
    for (const [k, v] of this.map) if (now - v.seen > 120_000) this.map.delete(k);
  }

  /**
   * The circles to ask about for everyone watching, at most MAX_POINTS, and
   * for each viewer the ones that cover it. Viewers served longest ago
   * claim circles first, so when there are more than fit, no one is left
   * out for long. Rebuilt at most once a second.
   */
  points(now = Date.now()): { pts: ViewPoint[]; of: Map<View, number[]> } {
    if (this.cache && now - this.cache.t < 1000) return this.cache;
    const pts: ViewPoint[] = [];
    const byKey = new Map<string, number>();
    const of = new Map<View, number[]>();
    for (const v of this.active(now).sort((a, b) => a.served - b.served)) {
      const mine: number[] = [];
      for (const p of viewPoints(v)) {
        let i = byKey.get(p.key) ?? -1;
        // A bigger circle close by already covers it. Pairwise, but over
        // at most MAX_POINTS snapped circles.
        if (i < 0) i = pts.findIndex((q) => q.r >= p.r && Math.abs(q.lat - p.lat) < 1 && distance(q.lat, q.lon, p.lat, p.lon) < 60 * NM);
        if (i < 0) {
          if (pts.length >= MAX_POINTS) continue;
          i = pts.push(p) - 1;
          byKey.set(p.key, i);
        }
        if (!mine.includes(i)) mine.push(i);
      }
      if (mine.length) of.set(v, mine);
    }
    this.cache = { t: now, pts, of };
    return this.cache;
  }
}
