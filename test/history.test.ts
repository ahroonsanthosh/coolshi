import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AirStore, SeaStore } from '../server/store.ts';
import { Trail } from '../server/trail.ts';
import { destination } from '../shared/geo.ts';

const T0 = 1_793_840_000;

test('history: same shape as before, values to the feed\'s precision', () => {
  const s = new AirStore();
  const now = (T0 + 300) * 1000;
  // As before, the report that creates a track starts it; history begins with the next.
  s.ingest({ hex: 'abc001', lat: 51, lon: -1, posT: T0 - 60, alt: 34000, gs: 450, trk: 90, src: 2, cadence: 6 }, now);
  s.ingest({ hex: 'abc001', lat: 51.123456, lon: -0.987654, posT: T0 + 0.3, alt: 35000, gs: 452.3, trk: 90, src: 2, cadence: 6 }, now);
  s.ingest({ hex: 'abc001', lat: 51.2, lon: -0.5, posT: T0 + 120.7, ground: true, alt: 0, gs: null, trk: 90, src: 2, cadence: 6 }, now);
  const h = s.history('abc001');
  assert.deepEqual(h, [
    { t: T0 + 0.3, lat: 51.123456, lon: -0.987654, alt: 35000, gs: 452.3 },
    { t: T0 + 120.7, lat: 51.2, lon: -0.5, alt: 0, gs: null },
  ]);
  assert.deepEqual(Object.keys(h[0]), ['t', 'lat', 'lon', 'alt', 'gs']);
  assert.deepEqual(JSON.parse(JSON.stringify(h)), h);
  assert.deepEqual(s.history('nope00'), []);

  const sea = new SeaStore();
  sea.ingest({ mmsi: 230123456, lat: 60.1, lon: 24.9, posT: T0, sog: 12.4, cog: 45, src: 8 });
  assert.deepEqual(sea.history(230123456), [{ t: T0, lat: 60.1, lon: 24.9, alt: null, gs: 12.4 }]);
});

test('history: an aircraft reported every 5 s for a day stays bounded', () => {
  const s = new AirStore();
  let lat = 40, lon = -30, trk = 80;
  for (let i = 0; i < (24 * 3600) / 5; i++) {
    const t = T0 + i * 5;
    // Mostly straight, with a gentle turn now and then and step climbs.
    if (i % 400 < 20) trk = (trk + 3) % 360;
    [lat, lon] = destination(lat, lon, trk, 450 * 0.514444 * 5);
    const alt = 31000 + Math.floor(i / 2000) * 1000;
    s.ingest({ hex: 'abc002', lat, lon, posT: t, alt, gs: 450, trk, src: 2, cadence: 6 }, t * 1000);
  }
  const h = s.history('abc002');
  assert.ok(h.length <= 1000, `${h.length} points`);
  assert.ok(h.length >= 600, `${h.length} points: still about one a minute`);
  const span = h[h.length - 1].t - h[0].t;
  assert.ok(span <= 12 * 3600, `${span} s of history`);
  for (let i = 1; i < h.length; i++) assert.ok(h[i].t > h[i - 1].t);
  // A straight cruise is one point a minute, not twelve.
  const straight = h.filter((p) => p.t > T0 + 3600 * 13 && p.t < T0 + 3600 * 13 + 600);
  assert.ok(straight.length <= 14, `${straight.length} points in 10 min`);
});

test('history: a moored ship reporting every 10 s keeps six hours at one point per five minutes', () => {
  const sea = new SeaStore();
  for (let i = 0; i < (24 * 3600) / 10; i++) {
    const jitter = ((i * 7919) % 13) * 1e-5; // GPS wander, metres
    sea.ingest({ mmsi: 257000001, lat: 59.9 + jitter, lon: 10.7 - jitter, posT: T0 + i * 10, sog: 0, cog: (i * 37) % 360, nav: 5, src: 64 });
  }
  const h = sea.history(257000001);
  assert.ok(h.length <= (6 * 3600) / 300 + 1, `${h.length} points`);
  assert.ok(h.length >= 70);
  assert.ok(h[h.length - 1].t - h[0].t <= 6 * 3600);
});

test('history: a ship under way is capped too', () => {
  const sea = new SeaStore();
  let lat = 50, lon = -5;
  for (let i = 0; i < (24 * 3600) / 5; i++) {
    [lat, lon] = destination(lat, lon, 200 + (i % 50), 30 * 0.514444 * 5); // fast and weaving
    sea.ingest({ mmsi: 235000002, lat, lon, posT: T0 + i * 5, sog: 30, cog: 200 + (i % 50), nav: 0, src: 16 });
  }
  assert.ok(sea.history(235000002).length <= 400);
});

test('trail: a ring keeps the newest points in order once full', () => {
  const tr = new Trail(20, true);
  for (let i = 0; i < 55; i++) tr.push(T0 + i, i / 10, -i / 10, i * 100, i);
  const p = tr.points();
  assert.equal(p.length, 20);
  assert.equal(p[0].t, T0 + 35);
  assert.equal(p[19].t, T0 + 54);
  assert.equal(p[19].alt, 5400);
  assert.equal(p[19].lon, -5.4);
  assert.ok(tr.bytes <= 20 * 20);
  tr.dropBefore(T0 + 50);
  assert.deepEqual(tr.points().map((q) => q.t), [50, 51, 52, 53, 54].map((x) => T0 + x));
  tr.dropBefore(T0 + 100);
  assert.equal(tr.length, 0);
  assert.equal(tr.bytes, 0);
});
