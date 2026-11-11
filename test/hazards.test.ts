import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHazard, parseAirSigmet, parseIsigmet } from '../server/feeds/weather.ts';
import { hazards, hazardsAt, levels, loadHazards } from '../src/state/hazards.ts';

const NOW = Date.parse('2026-11-11T11:00:00Z');
const box = (w: number, s: number, e: number, n: number) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

test('SIGMET hazards in words', () => {
  assert.deepEqual(describeHazard('TURB', 'SEV'), { kind: 'turb', label: 'severe turbulence' });
  assert.deepEqual(describeHazard('TS', 'EMBD'), { kind: 'storm', label: 'embedded thunderstorms' });
  assert.deepEqual(describeHazard('TC', 'CEMPAKA'), { kind: 'cyclone', label: 'tropical cyclone Cempaka' });
  assert.deepEqual(describeHazard('VA', 'ETNA'), { kind: 'ash', label: 'volcanic ash, Etna' });
  assert.equal(describeHazard('MTW', 'SEV').label, 'severe mountain waves');
  assert.equal(describeHazard('CONVECTIVE').kind, 'storm');
});

test('international SIGMETs: expired ones dropped, levels and areas kept', () => {
  const fc = { features: [
    { properties: { firId: 'EGTT', firName: 'EGTT LONDON', seriesId: 'A1', hazard: 'TURB', qualifier: 'SEV', base: 30000, top: 39000,
      validTimeFrom: '2026-11-11T09:00:00Z', validTimeTo: '2026-11-11T13:00:00Z', rawSigmet: 'EGTT SIGMET A1' },
      geometry: { type: 'Polygon', coordinates: box(-5, 50, 0, 55) } },
    { properties: { firId: 'LFFF', seriesId: 'B2', hazard: 'TS', validTimeFrom: '2026-11-11T05:00:00Z', validTimeTo: '2026-11-11T09:00:00Z' },
      geometry: { type: 'Polygon', coordinates: box(0, 45, 5, 50) } },
    { properties: { firId: 'RJJJ', seriesId: 'L2', hazard: 'TC', qualifier: 'X', validTimeFrom: '2026-11-11T07:00:00Z', validTimeTo: '2026-11-11T13:00:00Z', top: 54000 },
      geometry: { type: 'MultiPolygon', coordinates: [box(140, 20, 145, 25), box(146, 20, 148, 22)] } },
  ] };
  const out = parseIsigmet(fc, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].area, 'EGTT LONDON');
  assert.equal(out[0].base, 30000);
  assert.equal(out[1].rings.length, 2);
});

test('US SIGMETs only, not AIRMETs or outlooks', () => {
  const p = (t: string) => ({ properties: { airSigmetType: t, hazard: 'CONVECTIVE', seriesId: t, severity: 5, altitudeHi1: 43000, validTimeFrom: '2026-11-11T10:55:00Z', validTimeTo: '2026-11-11T12:55:00Z' }, geometry: { type: 'Polygon', coordinates: box(-90, 25, -85, 30) } });
  const out = parseAirSigmet({ features: [p('SIGMET'), p('AIRMET'), p('OUTLOOK')] }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].top, 43000);
  assert.equal(out[0].base, null);
});

test('an aircraft is inside a hazard only within its area and levels', async () => {
  const items = parseIsigmet({ features: [{ properties: { firId: 'EGTT', seriesId: 'A1', hazard: 'TURB', qualifier: 'SEV', base: 30000, top: 39000,
    validTimeFrom: '2026-11-11T09:00:00Z', validTimeTo: '2026-11-11T13:00:00Z' }, geometry: { type: 'Polygon', coordinates: box(-5, 50, 0, 55) } }] }, NOW);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ at: NOW, items }))) as typeof fetch;
  try { await loadHazards(); } finally { globalThis.fetch = real; }
  assert.equal(hazards.items.length, 1);
  assert.equal(hazardsAt(-2, 52, 35000, NOW).length, 1);
  assert.equal(hazardsAt(-2, 52, 25000, NOW).length, 0, 'below the base');
  assert.equal(hazardsAt(2, 52, 35000, NOW).length, 0, 'outside the area');
  assert.equal(hazardsAt(-2, 52, 35000, Date.parse('2026-11-11T14:00:00Z')).length, 0, 'expired');
  assert.equal(levels({ base: 30000, top: 39000 }), 'FL300–FL390');
  assert.equal(levels({ base: null, top: 24000 }), 'surface–FL240');
  assert.equal(levels({ base: null, top: null }), 'all levels');
});
