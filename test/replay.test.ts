import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packHex, Replay, unpackHex } from '../server/replay.ts';
import { searchShips } from '../server/search.ts';
import type { AircraftRow, ShipRow } from '../shared/protocol.ts';

const ac = (hex: string, lat: number, lon: number, posT: number, flags = 0): AircraftRow =>
  [hex, lat, lon, posT, 35000, 35100, 450, 90, 0, 'TEST1', 'A320', 'G-TEST', '1000', 'A3', flags, 2, '', '', 0, 0, 0, 0, 0] as unknown as AircraftRow;
const ship = (mmsi: number, name: string, lat: number, lon: number, sog: number, posT: number): ShipRow =>
  [mmsi, lat, lon, posT, sog, 180, 181, 0, name, 'CALL', 9000001, 70, 'ROTTERDAM', '', 10, 200, 30, 256, 0, '', 'NL'] as unknown as ShipRow;

test('replay: addresses survive packing, including non-ICAO ones', () => {
  for (const h of ['4ca7b4', '000001', 'ffffff', '~abc123']) assert.equal(unpackHex(packHex(h)), h);
});

test('replay: a snapshot keeps reported aircraft and moving ships, filtered by box', () => {
  const now = 1_794_400_000_000;
  const r = new Replay();
  r.snapshot([ac('4ca7b4', 51.5, -0.12, now / 1000 - 5), ac('aaaaaa', 40, 10, now / 1000 - 5, 128), ac('bbbbbb', 10, 10, now / 1000 - 500)],
    [ship(244000001, 'MOVER', 52, 4, 12, now / 1000 - 30), ship(244000002, 'MOORED', 52, 4, 0, now / 1000 - 30)], now);
  const f = r.frame(now, null)!;
  assert.deepEqual(f.air.map((a) => a[0]), ['4ca7b4'], 'estimated and stale aircraft left out');
  assert.equal(f.air[0][1], 51.5);
  assert.deepEqual(f.sea.map((s) => s[0]), [244000001], 'only ships under way');
  assert.equal(r.frame(now, [0, 0, 10, 10])!.air.length, 0);
  assert.equal(r.index().frames.length, 1);
});

test('ship search: by name, MMSI or destination, best match first', () => {
  const rows = [ship(244000001, 'EVER GIVEN', 1, 1, 10, 0), ship(244000002, 'EVERGREEN STAR', 1, 1, 10, 0), ship(211000003, 'NORDIC', 1, 1, 0, 0)];
  assert.deepEqual(searchShips(rows, 'ever given').map((h) => h[1]), ['EVER GIVEN']);
  assert.deepEqual(searchShips(rows, 'ever').map((h) => h[1]), ['EVER GIVEN', 'EVERGREEN STAR']);
  assert.equal(searchShips(rows, '2110000')[0][0], 211000003);
  assert.equal(searchShips(rows, 'ev').length, 0, 'too short');
});
