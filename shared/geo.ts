// Spherical geometry on a mean-radius Earth. Distances in metres unless a
// name says otherwise. Good to about 0.5% against the ellipsoid, which is far
// below the uncertainty of anything we draw.

export const EARTH_R = 6_371_008.8;
export const NM = 1852;
export const KT = NM / 3600; // m/s per knot
export const FT = 0.3048;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function normLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Great-circle distance in metres (haversine). */
export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = rad(lat1), p2 = rad(lat2);
  const dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true bearing from point 1 to point 2, degrees 0..360. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point reached travelling `dist` metres from a start on a great circle. */
export function destination(lat: number, lon: number, brg: number, dist: number): [number, number] {
  const d = dist / EARTH_R, t = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const sp2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sp2)));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * sp2);
  return [deg(p2), normLon(deg(l2))];
}

/**
 * Signed cross-track distance (m) of point 3 from the great circle 1→2, and
 * the along-track distance (m) from 1 of its foot on that circle.
 */
export function crossAlong(
  lat1: number, lon1: number, lat2: number, lon2: number, lat3: number, lon3: number,
): { xt: number; at: number } {
  const d13 = distance(lat1, lon1, lat3, lon3) / EARTH_R;
  const t13 = rad(bearing(lat1, lon1, lat3, lon3));
  const t12 = rad(bearing(lat1, lon1, lat2, lon2));
  const xt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(t13 - t12))));
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))));
  return { xt: xt * EARTH_R, at: at * EARTH_R * Math.sign(Math.cos(t13 - t12) || 1) };
}

/** Points along the great circle between two places, for drawing. */
export function greatCircle(lat1: number, lon1: number, lat2: number, lon2: number, n = 64): [number, number][] {
  const p1 = rad(lat1), l1 = rad(lon1), p2 = rad(lat2), l2 = rad(lon2);
  const d = distance(lat1, lon1, lat2, lon2) / EARTH_R;
  const out: [number, number][] = [];
  if (d < 1e-9) return [[lon1, lat1], [lon2, lat2]];
  let prevLon = lon1;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = deg(Math.atan2(y, x));
    // Keep the line continuous across the antimeridian for the renderer.
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    prevLon = lon;
    out.push([lon, deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return out;
}
