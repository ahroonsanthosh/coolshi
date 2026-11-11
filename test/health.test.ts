import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthProblems } from '../server/health.ts';

const now = 1_800_000_000_000;
const MIN = 60_000;

test('health: a cold start before any data is healthy, watched or not', () => {
  assert.deepEqual(healthProblems({ now, lagP99: 0, lastAirAt: 0, watchedSince: 0 }), []);
  assert.deepEqual(healthProblems({ now, lagP99: 0, lastAirAt: 0, watchedSince: now - 2 * MIN }), []);
});

test('health: no aircraft for ten minutes of watching is not', () => {
  assert.equal(healthProblems({ now, lagP99: 0, lastAirAt: 0, watchedSince: now - 11 * MIN }).length, 1);
  assert.equal(healthProblems({ now, lagP99: 0, lastAirAt: now - 11 * MIN, watchedSince: now - 60 * MIN }).length, 1);
  assert.deepEqual(healthProblems({ now, lagP99: 0, lastAirAt: now - 30_000, watchedSince: now - 60 * MIN }), []);
  // Idle for an hour, then someone arrives: the feeds get ten minutes from then.
  assert.deepEqual(healthProblems({ now, lagP99: 0, lastAirAt: now - 60 * MIN, watchedSince: now - 3 * MIN }), []);
  // No one watching: feeds are paused by design.
  assert.deepEqual(healthProblems({ now, lagP99: 0, lastAirAt: now - 60 * MIN, watchedSince: 0 }), []);
});

test('health: a loop that stays blocked is not', () => {
  assert.match(healthProblems({ now, lagP99: 1500, lastAirAt: now, watchedSince: now - MIN })[0], /event loop 1500 ms/);
  assert.deepEqual(healthProblems({ now, lagP99: 400, lastAirAt: now, watchedSince: now - MIN }), []);
});
