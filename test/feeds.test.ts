import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReadsb } from '../server/feeds/readsb.ts';
import { decodeEta, decodeRot } from '../server/feeds/ships.ts';
import { AirStore } from '../server/store.ts';
import { AF } from '../shared/protocol.ts';

test('readsb: adsb.fi (seconds) and adsb.lol (ms) clocks give the same position time', () => {
  const ac = [{ hex: 'ABC123', lat: 51, lon: 0, seen_pos: 2, alt_baro: 35000, gs: 450, track: 90, flight: 'BAW1   ' }];
  const fi = parseReadsb({ now: 1_793_840_000, aircraft: ac }, 2, 6);
  const lol = parseReadsb({ now: 1_793_840_000_000, ac }, 4, 6);
  assert.equal(fi[0].posT, 1_793_839_998);
  assert.equal(lol[0].posT, 1_793_839_998);
  assert.equal(fi[0].cs, 'BAW1');
  assert.equal(fi[0].hex, 'abc123');
});

test('readsb: drops ground vehicles, tower beacons and stale positions', () => {
  const out = parseReadsb({ now: 100, aircraft: [
    { hex: '1', lat: 1, lon: 1, seen_pos: 1, category: 'C1' },
    { hex: '2', lat: 1, lon: 1, seen_pos: 1, t: 'TWR' },
    { hex: '3', lat: 1, lon: 1, seen_pos: 90 },
    { hex: '4', lat: 1, lon: 1, seen_pos: 1, alt_baro: 'ground', gs: 0 },
  ] }, 2, 6);
  assert.deepEqual(out.map((r) => r.hex), ['4']);
  assert.equal(out[0].ground, true);
});

test('AIS ETA bits decode to month-day hour:minute', () => {
  assert.equal(decodeEta(728320), '11-03 20:00');
  assert.equal(decodeEta(0), '');
  assert.equal(decodeEta((13 << 16) | (1 << 11)), ''); // month 13 is "not available"
});

test('AIS rate of turn: −128 is not available, ±126 is the scale limit', () => {
  assert.equal(decodeRot(-128), null);
  assert.equal(decodeRot(0), 0);
  assert.ok(decodeRot(10)! > 4 && decodeRot(10)! < 5);
});

test('store: an older report never moves a track backwards', () => {
  const s = new AirStore();
  s.ingest({ hex: 'aaa111', lat: 50, lon: 0, posT: 1000, src: 2, cadence: 6 }, 2_000_000);
  s.ingest({ hex: 'aaa111', lat: 49, lon: 0, posT: 990, src: 1, cadence: 150 }, 2_000_000);
  assert.equal(s.get('aaa111')![1], 50);
});

test('store: an emergency squawk needs two reports, a declared emergency one', () => {
  const s = new AirStore();
  s.ingest({ hex: 'bbb222', lat: 50, lon: 0, posT: 1000, sq: '7700', src: 2, cadence: 6 }, 2_000_000);
  assert.equal(s.get('bbb222')![14] & AF.emergency, 0);
  s.ingest({ hex: 'bbb222', lat: 50.01, lon: 0, posT: 1005, sq: '7700', src: 2, cadence: 6 }, 2_000_000);
  s.ingest({ hex: 'bbb222', lat: 50.02, lon: 0, posT: 1010, sq: '7700', src: 2, cadence: 6 }, 2_000_000);
  assert.ok(s.get('bbb222')![14] & AF.emergency);
  s.ingest({ hex: 'ccc333', lat: 50, lon: 0, posT: 1000, emergency: 'general', src: 2, cadence: 6 }, 2_000_000);
  assert.ok(s.get('ccc333')![14] & AF.emergency);
});

test('readsb: military Mode S without a position becomes an approximate report; civil ones are dropped', () => {
  const out = parseReadsb({ now: 1_793_840_000, aircraft: [
    { hex: '43c966', type: 'mode_s', flight: 'JAVLN26 ', t: 'HAWK', dbFlags: 1, alt_baro: 750, rr_lat: 54.7, rr_lon: -0.8, seen: 0.2 },
    { hex: '400001', type: 'mode_s', t: 'A320', alt_baro: 35000, rr_lat: 51, rr_lon: 0, seen: 0.5 },
  ] }, 2, 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].approx, true);
  assert.equal(out[0].lat, 54.7);
});

test('store: a rough area never overwrites a fresh real position', () => {
  const s = new AirStore();
  s.ingest({ hex: 'ddd444', lat: 54.1, lon: -1.47, posT: 1000, alt: 800, src: 2, cadence: 6 }, 1_100_000);
  s.ingest({ hex: 'ddd444', lat: 54.7, lon: -0.8, posT: 1010, alt: 750, approx: true, src: 2, cadence: 30 }, 1_100_000);
  const r = s.get('ddd444')!;
  assert.equal(r[1], 54.1);
  assert.equal(r[4], 750);
  assert.equal(r[14] & AF.approx, 0);
});

test('opensky: category indices follow the states API (13 reserved, 14 UAV, 15 space), ground vehicles dropped', async () => {
  const { parseStates, CATS } = await import('../server/feeds/opensky.ts');
  const st = (hex: string, cat: number) => [hex, 'TEST1   ', 'X', 1000, 1000, 10, 50, 1000, false, 100, 90, 0, null, 1000, '1234', false, 0, cat];
  const out = parseStates([st('a00001', 2), st('a00008', 8), st('a0000c', 12), st('a0000d', 13), st('a0000e', 14), st('a0000f', 15),
    st('a00010', 16), st('a00011', 17), st('a00012', 18), st('a00013', 19), st('a00014', 20), st('a00015', 0)], 150);
  assert.deepEqual(out.map((r) => [r.hex, r.cat]), [
    ['a00001', 'A1'], ['a00008', 'A7'], ['a0000c', 'B4'], ['a0000d', ''], ['a0000e', 'B6'], ['a0000f', 'B7'], ['a00015', ''],
  ]);
  assert.equal(CATS.length, 21);
  assert.equal(out[0].alt, Math.round(1000 / 0.3048));
  assert.equal(out[0].cs, 'TEST1');
});
