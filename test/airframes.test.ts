import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AircraftDb } from '../server/aircraftDb.ts';
import { AirStore } from '../server/store.ts';
import { AF } from '../shared/protocol.ts';

function csv(n: number): Buffer {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`${i.toString(16).padStart(6, '0').toUpperCase()};G-T${i};A320;0000;AIRBUS A-320;2010;Test Air;`);
  return gzipSync(lines.join('\n') + '\n');
}

test('airframes: a truncated cache is deleted and fetched again, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acdb-'));
  const good = csv(1500);
  writeFileSync(join(dir, 'aircraft.csv.gz'), good.subarray(0, good.length >> 1)); // fresh but cut short
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(good); }) as typeof fetch;
  try {
    const db = new AircraftDb(dir);
    await db.load();
    assert.equal(calls, 1);
    assert.equal(db.status, '1,500 airframes');
    assert.equal(db.get('0005db')?.reg, 'G-T1499');
    assert.equal(db.get('0005dc'), null);
    assert.deepEqual(readFileSync(join(dir, 'aircraft.csv.gz')), good);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('airframes: a corrupt cache and no network leaves it unavailable, without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acdb-'));
  writeFileSync(join(dir, 'aircraft.csv.gz'), Buffer.from('not gzip at all'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  try {
    const db = new AircraftDb(dir);
    await db.load();
    assert.match(db.status, /^unavailable/);
    assert.equal(db.get('000001'), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('store: aircraft seen before the database loaded get identity once it does', () => {
  const s = new AirStore();
  s.ingest({ hex: 'abc123', lat: 50, lon: 0, posT: 1000, src: 1, cadence: 150 }, 2_000_000);
  s.ingest({ hex: 'abc124', lat: 50, lon: 0, posT: 1000, type: 'B738', src: 2, cadence: 6 }, 2_000_000);
  assert.equal(s.get('abc123')![10], '');
  s.identity = { get: (hex) => ({ reg: `R-${hex}`, type: 'C17', desc: 'BOEING C-17', owner: 'Air Force', mil: false, pia: false, ladd: true }) };
  s.fillIdentity();
  const a = s.get('abc123')!;
  assert.equal(a[10], 'C17');
  assert.equal(a[11], 'R-abc123');
  assert.ok(a[14] & AF.mil, 'a military-only type');
  assert.ok(a[14] & AF.ladd);
  assert.equal(s.get('abc124')![10], 'B738', 'what a feed said is kept');
});
