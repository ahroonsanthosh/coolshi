// Filed routes and the check that an aircraft is really flying one.

import { bearing, crossAlong, distance } from './geo.ts';

export interface Airport { icao: string; iata: string; name: string; city: string; country: string; lat: number; lon: number }
export interface Route { airline: string; airlineCountry: string; from: Airport; to: Airport; callsignIata: string }

export type RouteCheck =
  | { ok: true; progress: number; flown: number; remaining: number; total: number }
  | { ok: false; reason: string };

/**
 * Route databases map a callsign to the route it usually flies, and are
 * wrong often enough (seasonal changes, reused callsigns, diversions) that we
 * check the aircraft is actually on it before showing it.
 */
export function checkRoute(r: Route, lat: number, lon: number, trk: number | null, ground: boolean): RouteCheck {
  const total = distance(r.from.lat, r.from.lon, r.to.lat, r.to.lon);
  if (total < 20_000) return { ok: false, reason: 'origin and destination are the same airport' };
  const toOrigin = distance(lat, lon, r.from.lat, r.from.lon);
  const toDest = distance(lat, lon, r.to.lat, r.to.lon);
  if (ground) {
    if (toOrigin < 15_000) return { ok: true, progress: 0, flown: 0, remaining: total, total };
    if (toDest < 15_000) return { ok: true, progress: 1, flown: total, remaining: 0, total };
    return { ok: false, reason: 'on the ground away from both airports on file' };
  }
  const { xt, at } = crossAlong(r.from.lat, r.from.lon, r.to.lat, r.to.lon, lat, lon);
  // Long flights legitimately stray from the great circle to ride or dodge
  // jet streams and weather, so the corridor widens with route length.
  const tol = Math.max(100_000, Math.min(650_000, total * 0.15));
  if (Math.abs(xt) > tol || at < -60_000 || at > total + 60_000) {
    return { ok: false, reason: `${Math.round(Math.abs(xt) / 1000)} km off the line between the airports on file` };
  }
  // Heading away from the destination, far from both ends, is a different flight.
  if (trk !== null && toDest > 200_000 && toOrigin > 200_000) {
    const want = bearing(lat, lon, r.to.lat, r.to.lon);
    const diff = Math.abs(((trk - want + 540) % 360) - 180);
    if (diff > 100) return { ok: false, reason: 'flying away from the destination on file' };
  }
  const flown = Math.max(0, Math.min(total, at));
  return { ok: true, progress: flown / total, flown, remaining: toDest, total };
}

