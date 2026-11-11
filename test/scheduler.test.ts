import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepGrid } from '../server/grid.ts';
import { KeyedLimiter, TokenBucket } from '../server/pacing.ts';
import { AdsbScheduler, BG_SHARE, LANE_RATES, MIL_TYPES, type Job } from '../server/scheduler.ts';
import { clampView, MAX_POINTS, MAX_VIEWS, MAX_VIEWS_PER_IP, ViewRegistry } from '../server/views.ts';
import { retryAfter } from '../server/feeds/http.ts';
import type { Provider } from '../server/feeds/readsb.ts';

const T0 = 1_800_000_000_000;
const GRID = sweepGrid(new URL('../src/data/airports.json', import.meta.url).pathname);
const LANES = Object.keys(LANE_RATES) as Provider[];

/** Run the lanes as index.ts does, every 100 ms, each request taking `latency` ms. */
function simulate(sched: AdsbScheduler, seconds: number, tick: (now: number) => void = () => {}, latency = 600) {
  const pending: { at: number; job: Job }[] = [];
  const log: { t: number; job: Job }[] = [];
  for (let now = T0; now < T0 + seconds * 1000; now += 100) {
    tick(now);
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= now) { sched.done(pending[i].job, now); pending.splice(i, 1); }
    for (const id of LANES) {
      if (!sched.lanes[id].ready(now)) continue;
      const job = sched.next(id, now);
      if (job) { log.push({ t: now, job }); pending.push({ at: now + latency, job }); }
    }
  }
  return log;
}

test('token bucket: steady rate, burst of one', () => {
  const b = new TokenBucket(2, 1, T0);
  let n = 0;
  for (let t = T0; t < T0 + 10_000; t += 10) if (b.take(t)) n++;
  assert.ok(n >= 20 && n <= 21, `${n} in 10 s at 2/s`);
  b.drain(T0 + 10_000);
  assert.equal(b.take(T0 + 10_100), false);
  assert.equal(b.wait(T0 + 10_250), 0.25);
});

test('keyed limiter: per key, and idle keys forgotten', () => {
  const l = new KeyedLimiter(20, 60);
  let ok = 0;
  for (let i = 0; i < 100; i++) if (l.take('1.2.3.4', T0)) ok++;
  assert.equal(ok, 60);
  assert.ok(l.take('5.6.7.8', T0));
  assert.equal(l.retryAfter('1.2.3.4', T0), 1);
  l.prune(T0 + 10_000);
  assert.equal(l.size, 0);
});

test('scheduler: each lane stays under its limit, and the sweep keeps 40% against a crowd of viewers', () => {
  const views = new ViewRegistry();
  const sched = new AdsbScheduler(GRID, views, T0);
  // 30 viewers zoomed out over Europe and North America: 7 circles each, far more than fit.
  const spots = Array.from({ length: 30 }, (_, i) => [40 + (i % 6) * 3, -100 + Math.floor(i / 6) * 30]);
  const tick = (now: number) => {
    if ((now - T0) % 5000 === 0) spots.forEach(([la, lo], i) => views.register(`c${i}`, `${la},${lo},500`, `10.0.${i}.1`, now));
  };
  const S = 1200;
  const log = simulate(sched, S, tick);
  for (const id of LANES) {
    const mine = log.filter((e) => e.job.lane === id);
    const rate = mine.length / S;
    assert.ok(rate <= LANE_RATES[id] * 1.01, `${id}: ${rate.toFixed(3)} req/s, limit ${LANE_RATES[id]}`);
    assert.ok(rate >= LANE_RATES[id] * 0.9, `${id}: ${rate.toFixed(3)} req/s, should use its budget`);
    // The reserve is sized so the sweep isn't left with a backlog: it uses
    // about 90% of its 40%, and viewers get the rest.
    const bg = mine.filter((e) => e.job.bg).length / mine.length;
    assert.ok(bg >= BG_SHARE * 0.85, `${id}: background share ${bg.toFixed(2)}`);
  }
  const swept = new Set(log.filter((e) => e.job.key.startsWith('sw:')).map((e) => e.job.key));
  assert.equal(swept.size, GRID.length, 'no sweep circle starved by viewers');
  // Round-robin: every viewer is served, none waits long.
  const served = new Map<string, number[]>();
  for (const e of log) if (e.job.view) (served.get(e.job.view.id) ?? served.set(e.job.view.id, []).get(e.job.view.id)!).push(e.t);
  assert.equal(served.size, 30);
  for (const [id, ts] of served) {
    let gap = ts[0] - T0;
    for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
    assert.ok(gap <= 60_000, `${id} waited ${gap / 1000} s`);
  }
  assert.ok(sched.stretch > 1);
});

test('scheduler: viewer order of arrival does not decide who is served', () => {
  const views = new ViewRegistry();
  const sched = new AdsbScheduler([], views, T0);
  views.register('first', '50,0,500', '10.0.0.1', T0); // 7 circles
  views.register('second', '35,-100,100', '10.0.0.2', T0); // 1 circle
  const log = simulate(sched, 10).filter((e) => e.job.view);
  assert.equal(log[0].job.view!.id, 'first');
  assert.equal(log[1].job.view!.id, 'second', 'the second viewer is next, not after all of the first');
});

test('scheduler: when the sweep outgrows its share, cadences stretch and every circle still comes round', () => {
  const views = new ViewRegistry();
  const sched = new AdsbScheduler(GRID, views, T0);
  views.register('w', '0,0,5000', '10.0.0.1', T0); // watching the whole globe: no view circles
  const S = 3600;
  const log = simulate(sched, S, (now) => { if ((now - T0) % 20_000 === 0) views.register('w', '0,0,5000', '10.0.0.1', now); });
  assert.ok(sched.stretch > 1 && sched.stretch < 8, `stretch ${sched.stretch}`);
  const runs = new Map<string, number>();
  for (const e of log) runs.set(e.job.key, (runs.get(e.job.key) ?? 0) + 1);
  const missed = GRID.filter((p) => !runs.has(`sw:${p.lat},${p.lon}`));
  assert.deepEqual(missed, [], 'every circle swept within the hour');
  assert.ok(MIL_TYPES.every((t) => runs.has(`ty:${t}`)), 'every military type asked for');
  assert.equal(new Set(MIL_TYPES).size, MIL_TYPES.length, 'no duplicate military types');
  assert.equal(sched.types.length, 48, 'seed types until live traffic is ranked');
  sched.setTypes(['A320', 'C17', 'x', ...Array.from({ length: 100 }, (_, i) => `T${i}`)]);
  assert.equal(sched.types.length, 60);
  assert.equal(sched.types[0], 'A320');
  assert.ok(!sched.types.includes('C17'), 'military types are asked for separately');
  const total = log.length / S;
  assert.ok(total <= Object.values(LANE_RATES).reduce((a, b) => a + b) + 0.01, `${total.toFixed(2)} req/s`);
});

test('scheduler: a 429 honours Retry-After, then the lane runs at half rate and recovers', () => {
  const views = new ViewRegistry();
  const sched = new AdsbScheduler(GRID, views, T0);
  views.register('w', '0,0,5000', '10.0.0.1', T0);
  const lane = sched.lanes.adsblol;
  const job = sched.next('adsblol', T0)!;
  const note = sched.done(job, T0 + 500, { status: 429, retryAfter: 120 });
  assert.match(note, /rate limited/);
  assert.equal(lane.ready(T0 + 100_000), false);
  assert.ok(lane.available(T0 + 120_600));
  assert.ok(Math.abs(lane.rate(T0 + 500) - LANE_RATES.adsblol / 2) < 1e-9);
  assert.equal(lane.rate(T0 + 700_000), LANE_RATES.adsblol);
  // A second 429 soon after, with no Retry-After, waits longer than the first default.
  const j2 = sched.next('adsblol', T0 + 125_000)!;
  sched.done(j2, T0 + 125_500, { status: 429, retryAfter: null });
  assert.ok(lane.backoffUntil - (T0 + 125_500) >= 60_000);
  // The failed job is due again soon, for any lane.
  assert.equal(sched.next('adsbfi', T0 + 125_600)?.key !== undefined, true);
  assert.equal(retryAfter('120'), 120);
  assert.equal(retryAfter(new Date(T0 + 30_000).toUTCString(), T0), 30);
});

test('views: clamped to the globe and a sane radius', () => {
  assert.deepEqual(clampView('1000,-1000,1e9'), { lat: 90, lon: 80, r: 5000 });
  assert.deepEqual(clampView('-91,190,0'), { lat: -90, lon: -170, r: 1 });
  assert.equal(clampView('1,2'), null);
  assert.equal(clampView('1,NaN,3'), null);
  assert.equal(clampView('1,Infinity,3'), null);
  assert.equal(clampView(null), null);
});

test('views: a few per address, a cap in all, and a thousand fake ids stay cheap', () => {
  const v = new ViewRegistry();
  for (let i = 0; i < 6; i++) v.register(`tab${i}`, `50,${i},100`, '1.1.1.1', T0 + i);
  assert.equal(v.size, MAX_VIEWS_PER_IP);
  assert.ok(v.active(T0 + 10).every((x) => x.id !== 'tab0' && x.id !== 'tab1'), 'the stalest gave way');
  for (let i = 0; i < 1000; i++) v.register(`fake${i}`, `${(i * 7) % 170 - 85},${(i * 13) % 360 - 180},500`, `10.${i >> 8}.${i & 255}.9`, T0 + 100);
  assert.equal(v.size, MAX_VIEWS);
  const t = performance.now();
  const { pts, of } = v.points(T0 + 200);
  const ms = performance.now() - t;
  assert.ok(pts.length <= MAX_POINTS);
  assert.ok(of.size > 0);
  assert.ok(ms < 100, `${ms.toFixed(1)} ms to plan 200 views`);
});

test('client address: X-Forwarded-For believed only from our own proxy, first hop only', async () => {
  const { clientIp } = await import('../server/pacing.ts');
  assert.equal(clientIp('10.1.2.3', '203.0.113.9'), '203.0.113.9', 'Render proxy: the address it saw');
  assert.equal(clientIp('10.1.2.3', '6.6.6.6, 203.0.113.9'), '203.0.113.9', 'a forged entry before it is ignored');
  assert.equal(clientIp('::ffff:172.20.0.1', '203.0.113.9'), '203.0.113.9');
  assert.equal(clientIp('198.51.100.7', '6.6.6.6'), '198.51.100.7', 'no proxy in front: the header is ignored');
  assert.equal(clientIp('10.1.2.3', '1.1.1.1, 203.0.113.9', 2), '1.1.1.1');
  assert.equal(clientIp('10.1.2.3', '203.0.113.9', 0), '10.1.2.3');
  assert.equal(clientIp('10.1.2.3', undefined), '10.1.2.3');
});
