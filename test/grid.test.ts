import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sweepGrid, SWEEP_NM } from '../server/grid.ts';
import { distance, NM } from '../shared/geo.ts';

const FILE = new URL('../src/data/airports.json', import.meta.url).pathname;

test('sweep grid: every scheduled airport is inside a 250 nm circle', () => {
  const airports = JSON.parse(readFileSync(FILE, 'utf8')) as [string, string, string, string, string, number, number][];
  const grid = sweepGrid(FILE);
  const R = SWEEP_NM * NM;
  const outside = airports.filter((a) => !grid.some((p) => distance(a[5], a[6], p.lat, p.lon) <= R)).map((a) => a[0]);
  assert.deepEqual(outside, []);
  for (const icao of ['EDDM', 'EDDS', 'CYVR', 'EGNT', 'ENSB', 'SAWH']) assert.ok(airports.some((a) => a[0] === icao), icao);
});

test('sweep grid: a reasonable number of circles, no duplicates, busiest first', () => {
  const grid = sweepGrid(FILE);
  assert.ok(grid.length > 300 && grid.length <= 650, `${grid.length} circles`);
  assert.equal(new Set(grid.map((p) => `${p.lat},${p.lon}`)).size, grid.length);
  for (let i = 1; i < grid.length; i++) assert.ok(grid[i - 1].weight >= grid[i].weight);
  assert.ok(grid.every((p) => Math.abs(p.lat) <= 90 && p.lon >= -180 && p.lon < 180));
});
