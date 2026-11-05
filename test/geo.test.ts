import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearing, crossAlong, destination, distance, greatCircle } from '../shared/geo.ts';
import { nightPolygon, subsolarPoint, sunElevation } from '../shared/sun.ts';

const near = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);

test('great-circle distance: LHR to JFK is about 5,540 km', () => {
  near(distance(51.47, -0.4543, 40.6413, -73.7781) / 1000, 5540, 15);
});

test('initial bearing: LHR to JFK leaves at about 288°', () => {
  near(bearing(51.47, -0.4543, 40.6413, -73.7781), 288.2, 0.5);
});

test('destination inverts distance and bearing', () => {
  const [lat, lon] = destination(51.47, -0.4543, 288.2, 1_000_000);
  near(distance(51.47, -0.4543, lat, lon), 1_000_000, 1);
});

test('destination wraps across the antimeridian', () => {
  const [, lon] = destination(0, 179.9, 90, 50_000);
  assert.ok(lon < -179 && lon > -180);
});

test('cross-track: a point on the route has ~0 cross-track distance', () => {
  const mid = greatCircle(51.47, -0.4543, 40.6413, -73.7781, 2)[1];
  const { xt, at } = crossAlong(51.47, -0.4543, 40.6413, -73.7781, mid[1], mid[0]);
  near(xt, 0, 50);
  near(at / 1000, 2770, 15);
});

test('subsolar point at the June 2026 solstice', () => {
  const p = subsolarPoint(Date.UTC(2026, 5, 21, 12, 0, 0));
  near(p.lat, 23.44, 0.02);
  near(p.lon, 0.45, 0.2); // equation of time ≈ −1.8 min
});

test('subsolar point matches wheretheiss.at (independent NOAA implementation)', () => {
  const p = subsolarPoint(1_793_840_000_000);
  near(p.lat, -15.623, 0.01);
  near(p.lon, 162.558, 0.05);
});

test('sun is overhead at the subsolar point and set on the terminator', () => {
  const t = Date.UTC(2026, 10, 5, 3, 0, 0);
  const s = subsolarPoint(t);
  near(sunElevation(t, s.lat, s.lon), 90, 0.01);
  for (const [lon, lat] of nightPolygon(t, 0, 15).slice(0, 25)) near(sunElevation(t, lat, lon), 0, 0.05);
});

test('civil twilight line sits 6° below the horizon', () => {
  const t = Date.UTC(2026, 2, 1, 18, 0, 0);
  for (const [lon, lat] of nightPolygon(t, 6, 20).slice(0, 19)) {
    if (Math.abs(lat) > 89) continue;
    near(sunElevation(t, lat, lon), -6, 0.05);
  }
});
