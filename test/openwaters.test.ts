import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenWaters } from '../server/feeds/openwaters.ts';

function stubFetch(answer: (url: string) => Response) {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => { urls.push(String(u)); return answer(String(u)); }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = real; } };
}

const vessel = { properties: { particulars: { year_built: 2004 }, first_seen: '2020-01-01T00:00:00Z', near: 'Rotterdam' } };
const track = { geometry: { type: 'LineString', coordinates: [[4, 52], [4.1, 52.1]] }, properties: { times: ['a', 'b'], sog: [10, 11] } };

test('ship detail: paced with the sweep, shared while in flight, cached', async () => {
  const f = stubFetch((u) => Response.json(u.includes('/track') ? track : vessel));
  try {
    const ow = new OpenWaters([]);
    const a = ow.detail(244123456), b = ow.detail(244123456);
    assert.equal(f.urls.length, 0, 'nothing is fetched outside the pacer');
    assert.equal(ow.queued, 1, 'one request in flight per ship');
    const wait = await ow.tick(() => {}, false);
    assert.equal(wait, 1.6, 'two requests from the same budget');
    const [da, db] = await Promise.all([a, b]);
    assert.equal(da, db);
    assert.equal((da.particulars as any).year_built, 2004);
    assert.equal(da.track?.coords.length, 2);
    assert.equal(f.urls.length, 2);
    assert.ok(f.urls.every((u) => u.includes('/v1/vessels/244123456')));
    assert.equal(await ow.detail(244123456), da, 'cached');
    assert.equal(f.urls.length, 2);
  } finally {
    f.restore();
  }
});

test('ship detail: failures cached briefly, a long queue answered empty at once, the sweep keeps its turns', async () => {
  const f = stubFetch(() => new Response('busy', { status: 503 }));
  try {
    const ow = new OpenWaters([]);
    const p = ow.detail(111111111);
    await ow.tick(() => {}, false);
    const d = await p;
    assert.equal(d.particulars, null);
    const n = f.urls.length;
    assert.equal(await ow.detail(111111111), d, 'the failure is remembered');
    assert.equal(f.urls.length, n);

    const many = Array.from({ length: 30 }, (_, i) => ow.detail(200000000 + i));
    assert.equal(ow.queued, 10);
    const empty = await Promise.race([many[29], new Promise((r) => setTimeout(() => r('waiting'), 50))]);
    assert.deepEqual(empty, { particulars: null, firstSeen: null, near: null, track: null });

    // With the sweep running, a detail gets at most every third turn.
    const turns: string[] = [];
    for (let i = 0; i < 9; i++) {
      const before = ow.queued;
      await ow.tick(() => {}, true);
      turns.push(ow.queued < before ? 'detail' : 'sweep');
    }
    assert.ok(turns.filter((t) => t === 'detail').length <= 3, turns.join(' '));
  } finally {
    f.restore();
  }
});
