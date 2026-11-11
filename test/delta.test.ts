import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AirStore, SeaStore, type AircraftReport, type ShipReport } from '../server/store.ts';

const rep = (hex: string, lat: number, lon: number, posT: number, extra: Partial<AircraftReport> = {}): AircraftReport =>
  ({ hex, lat, lon, posT, alt: 35000, gs: 450, trk: 90, src: 2, cadence: 2, ...extra }) as AircraftReport;
const T = 1_794_400_000;

test('deltas: only what changed after the cursor, and nothing twice', () => {
  const s = new AirStore();
  s.ingest(rep('aaaaaa', 51, 0, T), T * 1000);
  s.ingest(rep('bbbbbb', 40, 10, T), T * 1000);
  const first = s.delta(0);
  assert.equal(first.full, true);
  assert.equal(first.rows.length, 2);
  // The same report again changes nothing: not resent.
  s.ingest(rep('aaaaaa', 51, 0, T), T * 1000 + 500);
  const again = s.delta(first.seq);
  assert.equal(again.full, false);
  assert.equal(again.rows.length, 0);
  assert.equal(again.seq, first.seq);
  // A new position is.
  s.ingest(rep('aaaaaa', 51, 0.1, T + 2), T * 1000 + 2000);
  const moved = s.delta(again.seq);
  assert.deepEqual(moved.rows.map((r) => r[0]), ['aaaaaa']);
  assert.ok(moved.seq > again.seq);
});

test('deltas: a view gets its box, what it asked for and every emergency', () => {
  const s = new AirStore();
  s.ingest(rep('aaaaaa', 51, 0, T), T * 1000);
  s.ingest(rep('bbbbbb', 40, 10, T), T * 1000);
  s.ingest(rep('cccccc', -30, 150, T), T * 1000);
  s.ingest(rep('dddddd', 10, -60, T, { emergency: 'general' }), T * 1000);
  const c = s.delta(0).seq - 4; // before all four
  const v = s.delta(c, [-5, 45, 5, 55], new Set(['cccccc']));
  assert.deepEqual(v.rows.map((r) => r[0]).sort(), ['aaaaaa', 'cccccc', 'dddddd']);
});

test('deltas: removals reach a cursor that saw the track; a cursor from before a restart gets everything', () => {
  const s = new AirStore();
  s.ingest(rep('aaaaaa', 51, 0, T), T * 1000);
  const c = s.delta(0).seq;
  s.sweep(T * 1000 + 3600_000); // long gone
  const d = s.delta(c);
  assert.deepEqual(d.removed, ['aaaaaa']);
  assert.equal(s.delta(1).full, true, 'a cursor far below this boot');
  assert.equal(s.delta(s.seq + 1000).full, true, 'a cursor from the future');
});

test('ships: a box is sent whole the first time, then only changes; asked-for ships wherever they are', () => {
  const s = new SeaStore();
  const ship = (mmsi: number, lat: number, lon: number, posT: number): ShipReport => ({ mmsi, lat, lon, posT, sog: 10, cog: 90, src: 256 });
  s.ingest(ship(244000001, 52, 4, T), T * 1000);
  s.ingest(ship(244000002, 52.1, 4.1, T), T * 1000);
  s.ingest(ship(538000003, -20, 60, T), T * 1000);
  const box: [number, number, number, number] = [0, 50, 10, 55];
  const first = s.view(box, 100, 0, new Set([538000003]));
  assert.equal(first.full, true);
  assert.deepEqual(first.rows.map((r) => r[0]).sort(), [244000001, 244000002, 538000003]);
  s.ingest(ship(244000002, 52.11, 4.12, T + 30), T * 1000 + 30_000);
  const next = s.view(box, 100, first.seq, new Set());
  assert.equal(next.full, false);
  assert.deepEqual(next.rows.map((r) => r[0]), [244000002]);
  assert.equal(s.view(null, 100, first.seq, new Set()).full, true, 'the whole world is always whole');
});
