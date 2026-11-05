import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRoute, type Route } from '../src/lib/enrich.ts';

const ewrSfo: Route = {
  airline: 'United', airlineCountry: 'US', callsignIata: 'UA1904',
  from: { icao: 'KEWR', iata: 'EWR', name: 'Newark', city: 'Newark', country: 'US', lat: 40.6925, lon: -74.1687 },
  to: { icao: 'KSFO', iata: 'SFO', name: 'San Francisco', city: 'San Francisco', country: 'US', lat: 37.619, lon: -122.375 },
};

test('route: an aircraft over Nebraska heading west is on EWR→SFO', () => {
  const r = checkRoute(ewrSfo, 41.2, -100.5, 268, false);
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.progress > 0.5 && r.progress < 0.75);
});

test('route: the same aircraft heading east is not', () => {
  assert.equal(checkRoute(ewrSfo, 41.2, -100.5, 88, false).ok, false);
});

test('route: an aircraft over Texas is not on EWR→SFO', () => {
  assert.equal(checkRoute(ewrSfo, 31.0, -97.0, 270, false).ok, false);
});

test('route: on the ground at the origin counts as 0% flown', () => {
  const r = checkRoute(ewrSfo, 40.69, -74.17, null, true);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.progress, 0);
});

import { AirStore } from '../server/store.ts';
import { AF } from '../shared/protocol.ts';

test('estimates: a verified airliner leaving coverage is carried on, then replaced by a real report', () => {
  const s = new AirStore();
  const t0 = 1_793_840_000;
  s.estimate = () => ({ lat: 37.6, lon: -122.4, eta: t0 + 3600 });
  s.ingest({ hex: 'abc123', lat: 41.2, lon: -100.5, posT: t0, alt: 36000, gs: 450, trk: 268, cs: 'UAL1904', src: 2, cadence: 6 }, t0 * 1000);
  s.sweep(t0 * 1000 + 200_000); // well past expiry
  const row = s.get('abc123')!;
  assert.ok(row[14] & AF.est);
  assert.equal(row[22], t0 + 3600);
  s.sweep(t0 * 1000 + 3_000_000); // 20 min before ETA: let go
  assert.equal(s.get('abc123'), undefined);
});

test('estimates: a real report clears the estimate', () => {
  const s = new AirStore();
  const t0 = 1_793_840_000;
  s.estimate = () => ({ lat: 37.6, lon: -122.4, eta: t0 + 7200 });
  s.ingest({ hex: 'abc124', lat: 41.2, lon: -100.5, posT: t0, alt: 36000, gs: 450, trk: 268, cs: 'UAL1', src: 2, cadence: 6 }, t0 * 1000);
  s.sweep(t0 * 1000 + 200_000);
  s.ingest({ hex: 'abc124', lat: 40, lon: -110, posT: t0 + 1500, alt: 36000, gs: 450, trk: 268, src: 2, cadence: 6 }, (t0 + 1500) * 1000);
  assert.equal(s.get('abc124')![14] & AF.est, 0);
});
