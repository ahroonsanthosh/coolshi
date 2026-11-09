// News: headlines from open RSS and Atom feeds about flying, shipping and the
// world, pinned to the map where the headline names a place we can find.
// Feeds are polled gently (every 10 to 20 minutes each, staggered), parsed
// without a library, and kept for two days.
//
// Placing a story is deliberately conservative. A headline is matched against
// the cities of the 3,300 airports Watchman already knows and against country
// names; a city wins over a country, a bigger airport's city over a smaller
// one's. Words that are also common English ("Nice", "Mobile", "Split") are
// skipped. A story with no confident match is listed but not pinned.

import { readFileSync } from 'node:fs';
import type { NewsItem, NewsTopic } from '../../shared/protocol.ts';
import { Status, UA } from './http.ts';

export interface FeedDef { id: string; name: string; url: string; topic: NewsTopic; everyS: number }

export const FEEDS: FeedDef[] = [
  // Flying
  { id: 'avweek', name: 'Aviation Week', url: 'https://aviationweek.com/rss.xml', topic: 'air', everyS: 900 },
  { id: 'simpleflying', name: 'Simple Flying', url: 'https://simpleflying.com/feed/', topic: 'air', everyS: 900 },
  { id: 'aerotime', name: 'AeroTime', url: 'https://www.aerotime.aero/feed', topic: 'air', everyS: 900 },
  { id: 'airlive', name: 'AirLive', url: 'https://www.airlive.net/feed/', topic: 'air', everyS: 600 },
  { id: 'aviation24', name: 'Aviation24.be', url: 'https://www.aviation24.be/feed/', topic: 'air', everyS: 1200 },
  // Shipping
  { id: 'gcaptain', name: 'gCaptain', url: 'https://gcaptain.com/feed/', topic: 'sea', everyS: 900 },
  { id: 'splash', name: 'Splash247', url: 'https://splash247.com/feed/', topic: 'sea', everyS: 900 },
  { id: 'maritimeexec', name: 'The Maritime Executive', url: 'https://www.maritime-executive.com/articles.rss', topic: 'sea', everyS: 900 },
  { id: 'marinelink', name: 'MarineLink', url: 'https://www.marinelink.com/news/rss', topic: 'sea', everyS: 1200 },
  { id: 'loadstar', name: 'The Loadstar', url: 'https://theloadstar.com/feed/', topic: 'sea', everyS: 1200 },
  { id: 'hellenic', name: 'Hellenic Shipping News', url: 'https://www.hellenicshippingnews.com/feed/', topic: 'sea', everyS: 1200 },
  // The world
  { id: 'bbcworld', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', topic: 'world', everyS: 600 },
  { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', topic: 'world', everyS: 600 },
  { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', topic: 'world', everyS: 900 },
  { id: 'dw', name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-all', topic: 'world', everyS: 900 },
];

const KEEP_MS = 48 * 3600_000;
const MAX_PER_FEED = 60;

// ---------------------------------------------------------------------------
// Parsing

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** Text of an XML fragment: CDATA unwrapped, tags dropped, entities decoded. */
export function textOf(s: string): string {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Entity-encoded HTML (common in descriptions) becomes real tags first.
  if (/&lt;\/?[a-z]/i.test(t)) t = decodeEntities(t);
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}
function attr(block: string, tagName: string, a: string, where?: RegExp): string {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (const m of block.matchAll(re)) {
    if (where && !where.test(m[0])) continue;
    const v = m[0].match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (v) return decodeEntities(v[1]);
  }
  return '';
}

export interface RawItem { title: string; link: string; time: number; summary: string; image: string }

/** RSS 2.0, RSS 1.0 (RDF) and Atom items, newest first. */
export function parseFeed(xml: string): RawItem[] {
  const out: RawItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks) {
    const title = textOf(tag(b, ['title']));
    if (!title) continue;
    let link = textOf(tag(b, ['link']));
    if (!/^https?:/i.test(link)) link = attr(b, 'link', 'href', /rel=["']alternate["']/i) || attr(b, 'link', 'href');
    if (!/^https?:/i.test(link)) {
      const guid = textOf(tag(b, ['guid']));
      if (/^https?:/i.test(guid)) link = guid;
    }
    if (!/^https?:/i.test(link)) continue;
    const when = textOf(tag(b, ['pubDate', 'dc:date', 'published', 'updated']));
    const time = Date.parse(when);
    let summary = textOf(tag(b, ['description', 'summary', 'content:encoded', 'content']));
    if (summary.length > 300) summary = summary.slice(0, 300).replace(/\s+\S*$/, '') + '…';
    // A summary that only repeats the title says nothing.
    if (summary.toLowerCase().startsWith(title.toLowerCase().slice(0, 40)) && summary.length < title.length + 20) summary = '';
    const image = attr(b, 'media:content', 'url', /medium=["']image|type=["']image|\.(jpe?g|png|webp)/i)
      || attr(b, 'media:thumbnail', 'url')
      || attr(b, 'enclosure', 'url', /type=["']image/i)
      || (tag(b, ['description', 'content:encoded']).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? '')
      || (decodeEntities(tag(b, ['description', 'content:encoded'])).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? '');
    out.push({ title, link, time: Number.isFinite(time) ? time : 0, summary, image: /^https:/.test(image) ? image : '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Places

interface Place { name: string; lat: number; lon: number; kind: 'city' | 'country'; rank: number; cc: string }

// Place names that are also everyday words or names, or too ambiguous to pin.
const STOP = new Set([
  'Nice', 'Mobile', 'Split', 'Male', 'Bath', 'Reading', 'Orange', 'Wells', 'Hope', 'Victoria', 'Georgia', 'Jersey', 'Chad', 'Jordan',
  'Normal', 'Florence', 'Lincoln', 'Columbus', 'Cork', 'March', 'May', 'August', 'Kingston', 'Hamilton', 'Richmond',
  'Santa', 'San', 'Saint', 'Port', 'Mount', 'North', 'South', 'East', 'West', 'Central', 'Union', 'Independence', 'Concord',
  'Liberty', 'Eagle', 'Dover', 'Washington', 'Bristol', 'Portland', 'Cambridge', 'Newport', 'Stuart', 'Bay', 'Sale', 'Ely', 'Wick',
  'Turkey', 'Guinea', 'Niger', 'Ural', 'Asia', 'Europe', 'Africa', 'America', 'David', 'Marshall', 'Douglas', 'Charlotte', 'Laurel',
  'Midland', 'Garden', 'Grand', 'Golden', 'Crystal', 'Pleasant', 'Plenty', 'Rocky', 'Ocean', 'Valley', 'Island', 'Islands', 'Lake',
]);
// Places worth pinning even though a naive rule would drop them.
const FORCE_COUNTRY = new Set(['Georgia', 'Jordan', 'Turkey', 'Ukraine', 'Greenland', 'Antarctica', 'Arctic']);
const FORCE: Record<string, [number, number]> = {
  Washington: [38.9072, -77.0369], Georgia: [41.7151, 44.8271], Jordan: [31.9454, 35.9284], Turkey: [39.9334, 32.8597],
  'Strait of Hormuz': [26.57, 56.25], 'Red Sea': [20.0, 38.5], 'Suez Canal': [30.6, 32.33], 'Panama Canal': [9.1, -79.7],
  'Black Sea': [43.4, 34.0], 'South China Sea': [12.0, 114.0], 'Baltic Sea': [57.5, 19.5], 'Gulf of Aden': [12.5, 47.5],
  'Bab el-Mandeb': [12.6, 43.3], 'Taiwan Strait': [24.5, 119.5], 'Strait of Malacca': [3.0, 100.5], 'English Channel': [50.2, -1.0],
  'North Sea': [56.0, 3.0], 'Mediterranean': [35.0, 18.0], 'Persian Gulf': [27.0, 51.5], 'Gaza': [31.45, 34.4], 'Ukraine': [50.45, 30.52],
  'Gulf of Mexico': [25.0, -90.0], 'Arctic': [78.0, 15.0], 'Antarctica': [-77.85, 166.67], 'Greenland': [64.18, -51.7],
};

export class Gazetteer {
  private one = new Map<string, Place>(); // single-word names
  private multi: [string, Place][] = []; // multi-word names, longest first

  constructor(airportsPath: string) {
    const rows = JSON.parse(readFileSync(airportsPath, 'utf8')) as [string, string, string, string, string, number, number, number | null, number][];
    let regionName: (cc: string) => string = (cc) => cc;
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      regionName = (cc) => dn.of(cc) ?? cc;
    } catch { /* no ICU: countries are skipped */ }
    const add = (p: Place) => {
      if (p.name.length < 4 || STOP.has(p.name)) return;
      const prev = p.name.includes(' ') ? this.multi.find(([k]) => k === p.name)?.[1] : this.one.get(p.name);
      // Bigger airport's city wins a name clash; cities beat countries.
      if (prev && (prev.kind === 'city' && p.kind === 'country' || prev.rank <= p.rank)) return;
      if (p.name.includes(' ')) {
        this.multi = this.multi.filter(([k]) => k !== p.name);
        this.multi.push([p.name, p]);
      } else this.one.set(p.name, p);
    };
    const byCc = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      const [, iata, , city, cc, lat, lon, , rank] = r;
      if (iata && rank <= 2) { if (!byCc.has(cc)) byCc.set(cc, []); byCc.get(cc)!.push(r); }
      // Only towns with a big or medium airport: small fields are often
      // named after places that share a name with somewhere better known.
      if (city && rank <= 2) add({ name: city.replace(/\s*\(.*\)$/, '').trim(), lat, lon, kind: 'city', rank, cc });
    }
    for (const [cc, list] of byCc) {
      const name = regionName(cc);
      if (!name || name === cc) continue;
      // Pinned at the big airport nearest the middle of the country's
      // airports: a recognisable place near where most people live.
      const big = list.filter((r) => r[8] === 1);
      const pool = big.length ? big : list;
      const mLat = pool.reduce((a, r) => a + r[5], 0) / pool.length, mLon = pool.reduce((a, r) => a + r[6], 0) / pool.length;
      const r = pool.reduce((b, x) => ((x[5] - mLat) ** 2 + (x[6] - mLon) ** 2 < (b[5] - mLat) ** 2 + (b[6] - mLon) ** 2 ? x : b));
      add({ name, lat: r[5], lon: r[6], kind: 'country', rank: 5, cc });
    }
    for (const [name, [lat, lon]] of Object.entries(FORCE)) {
      const p: Place = { name, lat, lon, kind: FORCE_COUNTRY.has(name) ? 'country' : 'city', rank: 0, cc: '' };
      if (name.includes(' ')) { this.multi = this.multi.filter(([k]) => k !== name); this.multi.push([name, p]); }
      else this.one.set(name, p);
    }
    this.multi.sort((a, b) => b[0].length - a[0].length);
  }

  /** The most specific place a headline names, or null. */
  find(text: string): { name: string; lat: number; lon: number; kind: 'city' | 'country' } | null {
    let best: Place | null = null;
    const better = (p: Place) => !best || (p.kind === 'city' && best.kind === 'country') || (p.kind === best.kind && p.rank < best.rank);
    for (const [name, p] of this.multi) {
      if (text.includes(name) && new RegExp(`(^|[^\\p{L}])${escapeRe(name)}($|[^\\p{L}])`, 'u').test(text) && better(p)) best = p;
    }
    // Capitalised words only, and not the first word of a sentence when it
    // is also an English word (the stop list handles the common ones).
    for (const m of text.matchAll(/\p{Lu}[\p{L}'’-]+/gu)) {
      const w = m[0].replace(/['’]s$/, '');
      const p = this.one.get(w);
      if (!p || !better(p)) continue;
      // "Air Canada", "China Eastern", "Malaysia Airlines": airlines, not places.
      const before = text.slice(Math.max(0, m.index! - 4), m.index!), after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 14);
      if (/Air $/.test(before) || /^ (Airlines?|Airways|Air|Eastern|Southern|Cargo|Express)\b/.test(after)) continue;
      best = p;
    }
    if (!best) return null;
    const b = best as Place;
    return { name: b.name, lat: b.lat, lon: b.lon, kind: b.kind };
  }
}
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// Polling

const SEVERE = /\b(crash(es|ed)?|accident|killed|dead|fatal|emergency landing|mayday|collision|collided|sank|sinks|sinking|capsiz\w*|explosion|hijack\w*|missing|aground|fire on board|on fire|evacuat\w*|attack(ed)?|seized)\b/i;

export class News {
  status = new Status('news', 'News desk', 'news', 600);
  items: NewsItem[] = [];
  feeds = new Map<string, Status>();
  private next = new Map<string, number>();
  private gaz: Gazetteer;
  private defs: FeedDef[];

  constructor(gaz: Gazetteer, defs: FeedDef[] = FEEDS) {
    this.gaz = gaz;
    this.defs = defs;
    defs.forEach((d, i) => {
      this.feeds.set(d.id, new Status(`news:${d.id}`, d.name, 'news', d.everyS));
      this.next.set(d.id, Date.now() + i * 4000); // stagger the first round
    });
  }

  /** Poll whichever feed is due. Returns seconds until the next look. */
  async tick(): Promise<number> {
    if (process.env.NEWS === 'off') { this.status.note = 'off'; return 3600; }
    const now = Date.now();
    const due = this.defs.find((d) => (this.next.get(d.id) ?? 0) <= now);
    if (!due) return 5;
    const st = this.feeds.get(due.id)!;
    this.next.set(due.id, now + due.everyS * 1000);
    try {
      const xml = await fetchText(due.url);
      const got = parseFeed(xml).slice(0, MAX_PER_FEED);
      if (!got.length) throw new Error('no items in feed');
      this.merge(due, got);
      st.success(got.length, due.topic === 'air' ? 'flying' : due.topic === 'sea' ? 'shipping' : 'world');
    } catch (e) {
      st.fail(e);
      this.next.set(due.id, now + Math.min(3600, due.everyS * 2) * 1000);
    }
    const live = [...this.feeds.values()].filter((s) => s.ok).length;
    const pinned = this.items.filter((i) => i.place).length;
    if (live) this.status.success(this.items.length, `${live} of ${this.feeds.size} feeds · ${pinned} stories placed on the map`);
    else this.status.fail(new Error('no feed reachable'), 'retrying');
    return 2;
  }

  private merge(d: FeedDef, got: RawItem[]) {
    const now = Date.now();
    const byKey = new Map(this.items.map((i) => [i.link, i]));
    for (const r of got) {
      if (byKey.has(r.link)) continue;
      const t = r.time && r.time <= now + 600_000 ? Math.min(r.time, now) : now;
      if (now - t > KEEP_MS) continue;
      const place = this.gaz.find(r.title) ?? this.gaz.find(r.summary.slice(0, 160));
      byKey.set(r.link, {
        id: hashId(r.link), topic: d.topic, source: d.name, title: r.title, link: r.link, time: t,
        summary: r.summary, image: r.image, place, severe: SEVERE.test(r.title),
      });
    }
    // Same story from two outlets: keep the first one heard.
    const seen = new Set<string>();
    this.items = [...byKey.values()]
      .filter((i) => now - i.time < KEEP_MS)
      .sort((a, b) => b.time - a.time)
      .filter((i) => {
        const k = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 600);
  }
}

async function fetchText(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
    const text = await res.text();
    if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 2000))) throw new Error('not a feed');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
