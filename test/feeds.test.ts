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
