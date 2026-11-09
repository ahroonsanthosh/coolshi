import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Gazetteer, parseFeed, textOf } from '../server/feeds/news.ts';
import { parseTle, satKind } from '../server/feeds/space.ts';

const AIRPORTS = fileURLToPath(new URL('../src/data/airports.json', import.meta.url));

test('RSS 2.0 items: CDATA, entities, images, dates', () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>X</title>
    <item><title><![CDATA[Tanker &amp; tug collide off Rotterdam]]></title><link>https://example.com/a</link>
      <pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Both vessels &lt;b&gt;damaged&lt;/b&gt;.&lt;/p&gt;</description>
      <media:content url="https://example.com/a.jpg" medium="image"/></item>
    <item><title>No link</title></item>
  </channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Tanker & tug collide off Rotterdam');
  assert.equal(items[0].summary, 'Both vessels damaged .');
  assert.equal(items[0].image, 'https://example.com/a.jpg');
  assert.equal(items[0].time, Date.UTC(2026, 10, 9, 10));
});

test('Atom entries take the alternate link', () => {
  const xml = `<feed><entry><title>Hello</title><link rel="alternate" href="https://example.com/h"/><updated>2026-11-09T08:00:00Z</updated></entry></feed>`;
  const [e] = parseFeed(xml);
  assert.equal(e.link, 'https://example.com/h');
  assert.equal(textOf('a &#8217; b &hellip;'), 'a ’ b …');
});

test('headlines are placed conservatively', () => {
  const g = new Gazetteer(AIRPORTS);
  assert.equal(g.find('Fire breaks out on ferry near Helsinki')?.name, 'Helsinki');
  assert.equal(g.find('Houthis target ship in the Red Sea')?.name, 'Red Sea');
  assert.equal(g.find('Floods hit Pakistan')?.kind, 'country');
  // A city beats a country named in the same headline.
  assert.equal(g.find('Brazil: storm closes São Paulo airports')?.name, 'São Paulo');
  // Airline names are not places, and common words are not towns.
  assert.equal(g.find('Air Canada adds a route'), null);
  assert.equal(g.find('Nice weather for flying'), null);
});

test('TLE sets parse and spacecraft are classified', () => {
  const l1 = '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9005';
  const l2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
  const sats = parseTle(`ISS (ZARYA)\n${l1}\n${l2}\ngarbage\nSOYUZ-MS 27\n${l1.replace('25544', '61234')}\n${l2}\n`, 'station');
  assert.deepEqual(sats.map((s) => [s.name, s.norad, s.kind]), [['ISS (ZARYA)', 25544, 'station'], ['SOYUZ-MS 27', 61234, 'crew']]);
  assert.equal(satKind('PROGRESS-MS 30', 'station'), 'cargo');
  assert.equal(satKind('NOAA 19', 'bright'), 'satellite');
});
