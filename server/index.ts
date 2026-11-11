// Watchman aggregator. Polls every feed, merges them into one picture, and
// serves it to browsers as small deltas over plain HTTP. Run with Node 22.18+
// (`node server/index.ts`); no build step.

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AirStore, SeaStore, type Box, type AircraftReport } from './store.ts';
import { AircraftDb } from './aircraftDb.ts';
import { OpenSky } from './feeds/opensky.ts';
import { parseReadsb, type Provider } from './feeds/readsb.ts';
import { Kystverket, ownAisFeeds } from './feeds/kystverket.ts';
import { OpenWaters } from './feeds/openwaters.ts';
import { sweepGrid } from './grid.ts';
import { AdsbScheduler, LANE_RATES, type Job } from './scheduler.ts';
import { ViewRegistry } from './views.ts';
import { clientIp, KeyedLimiter } from './pacing.ts';
import { StaticFiles } from './static.ts';
import { healthProblems, LoopLag } from './health.ts';
import { Estimator } from './estimates.ts';
import { AisStream, Digitraffic } from './feeds/ships.ts';
import { Gdacs, Iss, Usgs } from './feeds/events.ts';
import { Clouds, Hazards, Metars } from './feeds/weather.ts';
import { Replay } from './replay.ts';
import { searchShips } from './search.ts';
import { Photos } from './feeds/photos.ts';
import { Gazetteer, News } from './feeds/news.ts';
import { Launches, Spacecraft } from './feeds/space.ts';
import { every, getJson, HttpError, Status } from './feeds/http.ts';
import { AF, SRC, type HazardPayload, type NewsPayload, type SpacePayload, type WeatherPayload, type WorldPayload } from '../shared/protocol.ts';

const gz = promisify(gzip);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
loadDotEnv(join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DIST = join(ROOT, 'dist');

const air = new AirStore();
const estimator = new Estimator();
air.quiet = (row) => estimator.quiet(row);
air.estimate = (row) => estimator.estimate(row);
const acdb = new AircraftDb(join(ROOT, '.cache'));
air.identity = acdb; // answers nothing until loaded
const loadAirframes = () => acdb.load()
  .then(() => { air.fillIdentity(); console.log(`  Aircraft database: ${acdb.status}`); })
  .catch((e) => console.warn('[airframes]', e));
loadAirframes();
// The database is refreshed weekly upstream; pick it up without a restart.
setInterval(() => { if (acdb.stale) loadAirframes(); }, 6 * 3_600_000).unref();
const sea = new SeaStore();
const opensky = new OpenSky();
const digitraffic = new Digitraffic();
const aisstream = new AisStream();
const kystverket = new Kystverket();
const ownAis = ownAisFeeds(SRC.local);
const airportPts = (JSON.parse(readFileSync(join(ROOT, 'src/data/airports.json'), 'utf8')) as any[]).map((a) => [a[5], a[6]] as [number, number]);
const openwaters = new OpenWaters(airportPts);
const usgs = new Usgs();
const gdacs = new Gdacs();
const metars = new Metars();
const clouds = new Clouds();
const hazards = new Hazards();
const photos = new Photos();
// A snapshot a minute while anyone has watched in the last hour, so the
// replay has the recent past when someone asks for it.
const replay = new Replay();
let lastWatched = 0;
setInterval(() => {
  if (watching()) lastWatched = Date.now();
  if (Date.now() - lastWatched < 3600_000) replay.snapshot(air.values(), sea.values());
}, 60_000);
const iss = new Iss();
const spacecraft = new Spacecraft();
const launches = new Launches();
const news = new News(new Gazetteer(join(ROOT, 'src/data/airports.json')));
/** When an aircraft report last arrived from any feed, ms (for /healthz). */
let lastAirAt = 0;
const ingestAir = (r: AircraftReport) => { lastAirAt = Date.now(); air.ingest(r); };

// ---------------------------------------------------------------------------
// Who is watching what (server/views.ts), and the ADS-B networks asked about
// it, paced to what each allows (server/scheduler.ts).

const views = new ViewRegistry();
const watching = () => views.watching();
/** Record a client's view from /api/air (clamped and capped per address). */
function registerView(c: string | null, vp: string | null, ip: string) {
  views.register(c, vp, ip);
}

const sched = new AdsbScheduler(sweepGrid(join(ROOT, 'src/data/airports.json')), views);
// ADSB One's terms allow personal use only and forbid redisplaying its data
// (and its API was archived in 2026): asked only when the operator opts in.
if (process.env.ADSBONE !== 'on') sched.lanes.adsbone.backoffUntil = Infinity;
// Rank the types in live traffic; the most common sixty are asked for worldwide.
setInterval(() => {
  const n = new Map<string, number>();
  for (const r of air.values()) if (r[10] && !(r[14] & AF.ground)) n.set(r[10], (n.get(r[10]) ?? 0) + 1);
  sched.setTypes([...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t));
}, 300_000);

const LANES = Object.keys(LANE_RATES) as Provider[];
const laneStatus: Record<Provider, Status> = {
  adsbfi: new Status('adsbfi', 'adsb.fi', 'air', 1 / LANE_RATES.adsbfi),
  adsblol: new Status('adsblol', 'adsb.lol', 'air', 1 / LANE_RATES.adsblol),
  airplaneslive: new Status('airplaneslive', 'airplanes.live', 'air', 1 / LANE_RATES.airplaneslive),
  adsbone: new Status('adsbone', 'adsb.one', 'air', 1 / LANE_RATES.adsbone),
};
if (process.env.ADSBONE !== 'on') laneStatus.adsbone.note = 'off: its terms allow personal use only (ADSBONE=on to opt in)';

async function runJob(job: Job) {
  const st = laneStatus[job.lane];
  try {
    const { data } = await getJson<any>(job.url, {}, 15_000);
    const reports = parseReadsb(data, SRC[job.lane], job.cadence);
    for (const r of reports) ingestAir(r);
    sched.done(job);
    st.interval = 1 / sched.lanes[job.lane].rate(Date.now());
    st.success(reports.length, 'your view, worldwide sweep, military, emergencies');
  } catch (e) {
    const he = e instanceof HttpError ? e : null;
    st.fail(e, sched.done(job, Date.now(), { status: he?.status ?? 0, retryAfter: he?.retryAfter ?? null }));
  }
}

// Each lane starts a request whenever its bucket has a token and work is due.
setInterval(() => {
  if (!watching()) return;
  const now = Date.now();
  sched.openskyHealthy = opensky.healthy;
  for (const id of LANES) {
    if (!sched.lanes[id].ready(now)) continue;
    const job = sched.next(id, now);
    if (job) void runJob(job);
  }
}, 100);

// ---------------------------------------------------------------------------
// Feed schedule

// OpenSky's terms ask for a written agreement before its API feeds any
// live service, even a free one: on only when the operator says they have
// one (OPENSKY=on).
every(() => opensky.pollS, async () => {
  if (process.env.OPENSKY !== 'on') { opensky.status.note = 'off: needs a written agreement with OpenSky (then set OPENSKY=on)'; return 3600; }
  if (!watching()) return 5;
  return opensky.poll(ingestAir);
});
kystverket.start((r) => sea.ingest(r));
for (const f of ownAis) f.start((r) => sea.ingest(r));

// Your own ADS-B receivers: any readsb, dump1090-fa or tar1090 aircraft.json
// (READSB_URLS="http://pi.local/tar1090/data/aircraft.json,…"), polled every
// two seconds, so everything your antenna hears appears with full detail.
const ownAir = (process.env.READSB_URLS ?? '').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s))
  .map((url, i) => ({ url, status: new Status(`readsb${i}`, `Your receiver ${new URL(url).host}`, 'air', 2) }));
for (const f of ownAir) {
  every(() => 2, async () => {
    try {
      const { data } = await getJson<any>(f.url, {}, 8000);
      const reports = parseReadsb(data, SRC.local, 2);
      for (const r of reports) ingestAir(r);
      f.status.success(reports.length, 'your antenna, every 2 s');
    } catch (e) {
      f.status.fail(e);
      return 15;
    }
  });
}
every(() => 0.8, async () => {
  if (!openwaters.enabled) return 3600;
  // Nobody watching: no sweep, but a ship's details still get their turn.
  if (!watching()) return openwaters.tick((r) => sea.ingest(r), false);
  // Viewers' views first: the 10° boxes their screens overlap, if few.
  const focus: { s: number; w: number; n: number; e: number }[] = [];
  for (const v of views.active()) {
    if (v.r > 700) continue;
    const dLat = v.r / 60, dLon = v.r / 60 / Math.max(0.2, Math.cos((v.lat * Math.PI) / 180));
    for (let s = Math.floor((v.lat - dLat) / 10) * 10; s < v.lat + dLat; s += 10) {
      for (let w = Math.floor((v.lon - dLon) / 10) * 10; w < v.lon + dLon; w += 10) {
        if (s >= -90 && s < 90 && focus.length < 6) focus.push({ s, w: ((w + 540) % 360) - 180, n: Math.min(90, s + 10), e: ((w + 540) % 360) - 170 });
      }
    }
  }
  openwaters.focus = focus;
  openwaters.ships = sea.size;
  return openwaters.tick((r) => sea.ingest(r));
});
every(() => 20, () => digitraffic.pollLocations((r) => sea.ingest(r)));
every(() => 600, () => digitraffic.pollMetadata((r) => sea.ingest(r)));
aisstream.start((r) => sea.ingest(r));
every(() => 120, () => usgs.poll());
every(() => 900, () => gdacs.poll());
every(() => 300, () => iss.poll());
// Weather only while someone is watching (and once at start): the station
// file every five minutes, the newest satellite image time every fifteen.
every(() => 300, async () => { if (!watching() && metars.stations.length) return 30; await metars.poll(); });
every(() => 900, async () => { if (!watching() && clouds.time) return 30; await clouds.poll(); });
every(() => 600, async () => { if (!watching() && hazards.status.lastOk) return 30; await hazards.poll(); });
// Headlines keep coming whether or not anyone is watching, so the desk is
// full when someone arrives; each feed is asked every 10 to 20 minutes.
every(() => 2, () => news.tick());
every(() => 6 * 3600, () => spacecraft.poll());
every(() => 1800, () => launches.poll());
setInterval(() => { air.sweep(); sea.sweep(); }, 5000);
setInterval(() => {
  views.prune();
  sched.prune();
  for (const l of [apiLimit, fullLimit, lookupLimit]) l.prune();
}, 30_000);

// ---------------------------------------------------------------------------
// HTTP

const statics = new StaticFiles(DIST);

// Payloads that are the same object for every viewer until their data
// changes are serialised and compressed once, not once per request.
const packed = new WeakMap<object, { raw: Buffer; z?: Buffer }>();

async function sendJson(req: http.IncomingMessage, res: http.ServerResponse, body: unknown, shared = false, status = 200) {
  let pk = shared && body && typeof body === 'object' ? packed.get(body) : undefined;
  if (!pk) {
    pk = { raw: Buffer.from(JSON.stringify(body)) };
    if (shared && body && typeof body === 'object') packed.set(body, pk);
  }
  const raw = pk.raw;
  // No Access-Control-Allow-Origin: the app is same-origin, and the
  // volunteer networks' data is theirs to publish, not ours to re-serve to
  // any website that asks.
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (raw.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    const z = pk.z ?? (pk.z = await gz(raw, { level: 6 }));
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': z.length });
    res.end(z);
  } else {
    res.writeHead(status, { ...headers, 'Content-Length': raw.length });
    res.end(raw);
  }
}

// ---------------------------------------------------------------------------
// Health (server/health.ts): event-loop delay, heap, and how long since an
// aircraft report arrived; HTTP 503 when not ok.

const loopLag = new LoopLag();
let watchedSince = 0;
setInterval(() => {
  const w = watching();
  if (w && !watchedSince) watchedSince = Date.now();
  else if (!w) watchedSince = 0;
}, 5000).unref();

function health() {
  const now = Date.now();
  const lag = loopLag.get();
  const problems = healthProblems({ now, lagP99: lag.p99, lastAirAt, watchedSince });
  return {
    ok: !problems.length, problems,
    aircraft: air.size, ships: sea.size, airframes: acdb.status, watching: watching(),
    lagMs: lag, heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    lastAircraftS: lastAirAt ? Math.round((now - lastAirAt) / 1000) : null,
    sources: sources(),
  };
}

let wxBody: WeatherPayload | null = null;
function weatherBody(): WeatherPayload {
  if (!wxBody || wxBody.stations !== metars.stations || wxBody.clouds !== clouds.time) {
    wxBody = { at: metars.status.lastOk, stations: metars.stations, clouds: clouds.time };
  }
  return wxBody;
}

/** A box from the query string, [west, south, east, north], or null. */
function parseBox(v: string | null): Box | null {
  const b = v?.split(',').map(Number);
  if (!b || b.length !== 4 || !b.every(isFinite)) return null;
  const lon = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
  return [lon(b[0]), Math.max(-90, b[1]), lon(b[2]), Math.min(90, b[3])];
}

let hzBody: HazardPayload | null = null;
function hazardBody(): HazardPayload {
  // Drop warnings that expired since the last poll.
  if (!hzBody || hzBody.items !== hazards.items || hzBody.items.some((h) => h.to < Date.now())) {
    hzBody = { at: hazards.status.lastOk, items: hazards.items.filter((h) => h.to >= Date.now()) };
    hazards.items = hzBody.items;
  }
  return hzBody;
}

let windCache = { t: 0, v: [] as ReturnType<typeof air.winds> };
function windsCached() {
  if (Date.now() - windCache.t > 15_000) windCache = { t: Date.now(), v: air.winds() };
  return windCache.v;
}

// Airport weather: the latest METAR from aviationweather.gov (NOAA), decoded
// by them into fields, cached five minutes; a failed lookup is remembered
// for three, and a lookup already under way is shared.
const metarCache = new Map<string, { until: number; v: unknown }>();
const metarWait = new Map<string, Promise<unknown>>();
function metar(icao: string): Promise<unknown> {
  const c = metarCache.get(icao);
  if (c && Date.now() < c.until) return Promise.resolve(c.v);
  let p = metarWait.get(icao);
  if (!p) {
    p = getJson<any[]>(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`, {}, 10_000)
      .then(({ data }) => ({ v: data?.[0] ?? null, ttl: 300_000 }), () => ({ v: null, ttl: 180_000 }))
      .then(({ v, ttl }) => {
        if (metarCache.size >= 1000) metarCache.clear();
        metarCache.set(icao, { until: Date.now() + ttl, v });
        return v;
      })
      .finally(() => metarWait.delete(icao));
    metarWait.set(icao, p);
  }
  return p;
}

let statsCache = { t: 0, v: sea.stats() };
function shipStats() {
  if (Date.now() - statsCache.t > 20_000) statsCache = { t: Date.now(), v: sea.stats() };
  return statsCache.v;
}

function sources() {
  let est = 0;
  for (const r of air.values()) if (r[14] & AF.est) est++;
  estimator.active = est;
  return [...ownAir.map((f) => f.status), opensky.status, laneStatus.adsbfi, laneStatus.adsblol, laneStatus.airplaneslive, laneStatus.adsbone, estimator.status, openwaters.status, digitraffic.status, kystverket.status, ...ownAis.map((f) => f.status), aisstream.status, usgs.status, gdacs.status, metars.status, clouds.status, hazards.status, iss.status, spacecraft.status, launches.status, news.status]
    .map((s) => s.toJSON());
}

// Every rejection ends here: an unobserved one would take the process down.
const server = http.createServer((req, res) => {
  serve(req, res).catch((e) => failed(res, e));
});

function failed(res: http.ServerResponse, e: unknown) {
  console.error(e);
  if (!res.headersSent) res.writeHead(500);
  res.end();
}

// ---------------------------------------------------------------------------
// Limits per client address. Generous for a browser (it polls a few
// endpoints every few seconds), firm for a script.

/** Any /api/ request: 20 a second, bursts of 60. */
const apiLimit = new KeyedLimiter(20, 60);
/** Whole aircraft snapshots (since=0), the most expensive answer: three, then one per 10 s. */
const fullLimit = new KeyedLimiter(0.1, 3);
/** Lookups that cost an upstream request (METAR, ship particulars). */
const lookupLimit = new KeyedLimiter(1, 10);

// The client's address, from X-Forwarded-For's first hop behind Render's
// proxy (see clientIp). TRUST_PROXY_HOPS=0 ignores the header; 2 if
// another proxy sits in front. Logged once so a deploy can check it.
const PROXY_HOPS = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY_HOPS || 1)) || 0); // unset or empty: 1
let xffNoted = false;
function ipOf(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff && !xffNoted) {
    xffNoted = true;
    console.log(`  X-Forwarded-For from ${req.socket.remoteAddress}: ${String(xff).split(',').length} entries; trusting the last ${PROXY_HOPS}`);
  }
  return clientIp(req.socket.remoteAddress ?? '', xff, PROXY_HOPS);
}

function tooMany(res: http.ServerResponse, retryS: number) {
  res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(retryS) });
  res.end('{"error":"too many requests"}');
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const ip = ipOf(req);
    if ((p.startsWith('/api/') || p === '/healthz') && !apiLimit.take(ip)) return tooMany(res, apiLimit.retryAfter(ip));
    if (/^\/api\/(metar|detail\/sea|photo)\//.test(p) && !lookupLimit.take(ip)) return tooMany(res, lookupLimit.retryAfter(ip));
    if (p === '/api/air') {
      registerView(url.searchParams.get('c'), url.searchParams.get('vp'), ip);
      // Only what changed after the browser's cursor; a whole world (the
      // costly answer) is rate-limited per address.
      const since = Number(url.searchParams.get('since')) || 0;
      if (!air.cursorValid(since) && !fullLimit.take(ip)) return tooMany(res, fullLimit.retryAfter(ip));
      return await sendJson(req, res, air.delta(since));
    }
    if (p === '/api/sea') {
      // The ships in the viewer's box (or the busiest of them): all of them
      // when the box is new, then what changed; selected and watched ships
      // wherever they are.
      const box = parseBox(url.searchParams.get('bbox'));
      const want = new Set([url.searchParams.get('sel') ?? '', ...(url.searchParams.get('watch') ?? '').split(',')]
        .map(Number).filter((m) => Number.isInteger(m) && m > 99_999 && m < 1_000_000_000).slice(0, 25));
      return await sendJson(req, res, sea.view(box, box ? 15_000 : 5_000, Number(url.searchParams.get('since')) || 0, want));
    }
    if (p === '/api/world') {
      const body: WorldPayload = {
        now: Date.now(), quakes: usgs.quakes, disasters: gdacs.events, iss: iss.track, sources: sources(),
        ships: shipStats(),
      };
      return await sendJson(req, res, body);
    }
    let m = p.match(/^\/api\/detail\/air\/([0-9a-f~]{6,7})$/i);
    if (m) return await sendJson(req, res, air.extras(m[1].toLowerCase()));
    m = p.match(/^\/api\/detail\/sea\/(\d{6,9})$/);
    if (m) return await sendJson(req, res, await openwaters.detail(Number(m[1])));
    if (p === '/api/winds') return await sendJson(req, res, windsCached());
    if (p === '/api/weather') return await sendJson(req, res, weatherBody(), true);
    if (p === '/api/hazards') return await sendJson(req, res, hazardBody(), true);
    const ph = p.match(/^\/api\/photo\/air\/(~?[0-9a-f]{6})$/i);
    if (ph) return await sendJson(req, res, await photos.get(ph[1].toLowerCase(), (url.searchParams.get('reg') ?? '').slice(0, 12)));
    if (p === '/api/search') return await sendJson(req, res, { ships: searchShips(sea.values(), url.searchParams.get('q') ?? '') });
    if (p === '/api/replay') return await sendJson(req, res, replay.index());
    if (p === '/api/replay/frame') {
      return await sendJson(req, res, replay.frame(Number(url.searchParams.get('t')) || Date.now(), parseBox(url.searchParams.get('bbox'))));
    }
    if (p === '/api/space') {
      const body: SpacePayload = { now: Date.now(), sats: spacecraft.sats, launches: launches.launches };
      return await sendJson(req, res, body);
    }
    if (p === '/api/news') {
      const body: NewsPayload = { now: Date.now(), items: news.items, feeds: [...news.feeds.values()].map((s) => s.toJSON()) };
      return await sendJson(req, res, body);
    }
    m = p.match(/^\/api\/metar\/([A-Z0-9]{3,4})$/i);
    if (m) return await sendJson(req, res, await metar(m[1].toUpperCase()));
    m = p.match(/^\/api\/history\/air\/([0-9a-f~]{6,7})$/i);
    if (m) return await sendJson(req, res, air.history(m[1].toLowerCase()));
    m = p.match(/^\/api\/history\/sea\/(\d{6,9})$/);
    if (m) return await sendJson(req, res, sea.history(Number(m[1])));
    if (p === '/healthz') {
      const h = health();
      return await sendJson(req, res, h, false, h.ok ? 200 : 503);
    }
    // Static files (production build), compressed once and kept in memory.
    return await statics.serve(req, res, p);
  } catch (e) {
    failed(res, e);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Watchman aggregator on http://localhost:${PORT}`);
  console.log(`  OpenSky: ${opensky.status.note}, every ${opensky.pollS}s while watched`);
  console.log(`  AISStream: ${aisstream.enabled ? 'on' : 'off (no AISSTREAM_API_KEY)'}`);
  statics.warm().then((n) => { if (n) console.log(`  Site: ${n} files compressed`); }, (e) => console.warn('[static]', e));
});

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
