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
