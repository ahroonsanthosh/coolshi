// Solar position from the NOAA / Meeus low-precision algorithm: accurate to
// about 0.01° in declination for this century, ample for a terminator line.

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The point on Earth where the sun is directly overhead at `ms`. */
export function subsolarPoint(ms: number): { lat: number; lon: number } {
  const jd = ms / 86_400_000 + 2_440_587.5;
  const T = (jd - 2_451_545.0) / 36_525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) +
    Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * rad(L0)) -
        2 * e * Math.sin(rad(M)) +
        4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) -
        0.5 * y * y * Math.sin(4 * rad(L0)) -
        1.25 * e * e * Math.sin(2 * rad(M)),
    ); // minutes
  const d = new Date(ms);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
  let lon = -(utcMin + eqTime - 720) / 4;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: decl, lon };
}

/** Sun elevation in degrees at a place (geometric, no refraction). */
export function sunElevation(ms: number, lat: number, lon: number): number {
  const s = subsolarPoint(ms);
  const c =
    Math.sin(rad(lat)) * Math.sin(rad(s.lat)) +
    Math.cos(rad(lat)) * Math.cos(rad(s.lat)) * Math.cos(rad(lon - s.lon));
  return deg(Math.asin(Math.max(-1, Math.min(1, c))));
}

/**
 * Polygon of the region where the sun is more than `depression` degrees below
 * the horizon (0 = the geometric terminator, 6 civil, 12 nautical, 18
 * astronomical twilight), as a closed [lon, lat] ring that runs along the
 * twilight line and closes over the dark pole, so renderers can fill it.
 */
export function nightPolygon(ms: number, depression = 0, step = 1): [number, number][] {
  const s = subsolarPoint(ms);
  const dec = rad(s.lat);
  const A = Math.sin(dec);
  const C = -Math.sin(rad(depression));
  const line: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += step) {
    const B = Math.cos(dec) * Math.cos(rad(lon - s.lon));
    const R = Math.hypot(A, B);
    const phi = Math.atan2(B, A);
    let lat: number;
    if (Math.abs(C / R) >= 1) lat = C / R > 0 ? 90 : -90;
    else {
      const k = Math.asin(C / R);
      lat = k - phi;
      if (lat < -Math.PI / 2 || lat > Math.PI / 2) lat = Math.PI - k - phi;
      if (lat > Math.PI) lat -= 2 * Math.PI;
      if (lat < -Math.PI) lat += 2 * Math.PI;
      lat = deg(lat);
    }
    line.push([lon, Math.max(-89.999, Math.min(89.999, lat))]);
  }
  // The dark pole is the one opposite the sun's declination.
  const pole = s.lat >= 0 ? -89.999 : 89.999;
  return [...line, [180, pole], [-180, pole], line[0]];
}
