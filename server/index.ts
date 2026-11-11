// Watchman aggregator. Polls every feed, merges them into one picture, and
// serves it to browsers as small deltas over plain HTTP. Run with Node 22.18+
// (`node server/index.ts`); no build step.

import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AirStore, SeaStore, type AircraftReport } from './store.ts';
import { AircraftDb } from './aircraftDb.ts';
import { OpenSky } from './feeds/opensky.ts';
import { PROVIDERS, parseReadsb, type Provider } from './feeds/readsb.ts';
import { Kystverket, ownAisFeeds } from './feeds/kystverket.ts';
import { OpenWaters, shipDetail } from './feeds/openwaters.ts';
import { sweepGrid } from './grid.ts';
import { Estimator } from './estimates.ts';
import { AisStream, Digitraffic } from './feeds/ships.ts';
import { Gdacs, Iss, Usgs } from './feeds/events.ts';
import { Clouds, Metars } from './feeds/weather.ts';
import { Gazetteer, News } from './feeds/news.ts';
import { Launches, Spacecraft } from './feeds/space.ts';
import { every, getJson, HttpError, Status } from './feeds/http.ts';
import { AF, SRC, type NewsPayload, type SpacePayload, type WeatherPayload, type WorldPayload } from '../shared/protocol.ts';
import { destination, distance, NM } from '../shared/geo.ts';

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
acdb.load().then(() => {
  air.identity = acdb;
  console.log(`  Aircraft database: ${acdb.status}`);
});
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
const iss = new Iss();
const spacecraft = new Spacecraft();
const launches = new Launches();
const news = new News(new Gazetteer(join(ROOT, 'src/data/airports.json')));
const ingestAir = (r: AircraftReport) => air.ingest(r);

// ---------------------------------------------------------------------------
// Who is watching what. Each browser reports its view; the ADS-B networks are
// asked about those areas, so zooming in gets fresh, detailed traffic.

interface View { lat: number; lon: number; r: number; seen: number }
const views = new Map<string, View>();
const watching = () => [...views.values()].some((v) => Date.now() - v.seen < 60_000);

// ---------------------------------------------------------------------------
// adsb.fi / adsb.lol: two lanes, each paced to what its network allows.

type P = (typeof PROVIDERS)[Provider];
/** pri 0 runs before pri 1 whenever both are due: what people are looking
 *  at, military and emergencies first, the worldwide sweeps after. */
type Job = { key: string; url: (p: P) => string; cadence: number; due: number; needsType?: boolean; pri?: number };

// Worldwide by aircraft type: one request returns every aircraft of that type
// a network can hear, anywhere, so the most common sixty types cover most
// airline traffic in a fraction of the requests a circle sweep needs.
// Military types worth asking for by name, worldwide: tankers, transports,
// patrol, surveillance and command aircraft, and helicopters, many of which
// fly without a callsign a database would recognise.
const MIL_TYPES = ['C17', 'K35R', 'K35E', 'KC46', 'C30J', 'C130', 'A400', 'C5M', 'P8', 'P3', 'E3TF', 'E3CF', 'E6', 'R135', 'E8', 'C2', 'KC10',
  'MRTT', 'A310', 'C295', 'CN35', 'C27J', 'H60', 'H47', 'V22', 'UH1', 'EC45', 'NH90', 'U2', 'Q4', 'B52', 'C40', 'C32', 'E2', 'P1', 'Y20', 'IL76',
  // Fast jets, bombers and jet trainers: rarely broadcast, but when one does
  // (ferry flights, airshows, transits with a tanker) these find it.
  'F16', 'F15', 'F18', 'F18S', 'F35', 'F22', 'F5', 'B1', 'B2', 'EUFI', 'RFAL', 'TOR', 'JAS39', 'HAWK', 'M346', 'T38', 'T45', 'TEX2',
  'A10', 'AJET', 'L39', 'FA50', 'T50', 'PC21', 'K8', 'E7WT', 'E737', 'R135', 'C135', 'KC2',
  // Large drones: Reapers, Global Hawks and Tritons often broadcast on transit.
  'Q9', 'Q4', 'Q1', 'Q25', 'HRON'];
const SEED_TYPES = ['C172', 'PC12', 'C208', 'B350', 'AT72', 'AT75', 'E145', 'CRJ2', 'E170', 'B734', 'B753', 'B78X', 'A35K', 'A339', 'C56X', 'CL35', 'GLF5', 'GLEX', 'B738', 'A320', 'A20N', 'A21N', 'A321', 'B38M', 'B739', 'A319', 'B789', 'B77W', 'A359', 'B763', 'B788', 'A333', 'E75L', 'CRJ9', 'B737', 'B752', 'DH8D', 'AT76', 'E190', 'A332', 'B772', 'B744', 'B748', 'A388', 'CRJ7', 'E195', 'BCS3', 'B39M'];
let topTypes = [...SEED_TYPES, ...MIL_TYPES];
setInterval(() => {
  const n = new Map<string, number>();
  for (const r of air.values()) if (r[10] && !(r[14] & 1)) n.set(r[10], (n.get(r[10]) ?? 0) + 1);
  const ranked = [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => /^[A-Z0-9]{2,4}$/.test(t));
  topTypes = [...new Set([...ranked.slice(0, 180), ...SEED_TYPES])].slice(0, 190).concat(MIL_TYPES.filter((t) => !ranked.slice(0, 180).includes(t)));
}, 300_000);
const lastRun = new Map<string, number>();

const SWEEP = sweepGrid(join(ROOT, 'src/data/airports.json'));

function viewPoints(v: View): { lat: number; lon: number; r: number }[] {
  if (v.r <= 250) return [{ lat: v.lat, lon: v.lon, r: Math.max(25, Math.min(250, v.r * 1.1)) }];
  if (v.r > 650) return [];
  const pts = [{ lat: v.lat, lon: v.lon, r: 250 }];
  for (let b = 0; b < 360; b += 60) {
    const [lat, lon] = destination(v.lat, v.lon, b, Math.min(v.r * 0.7, 420) * NM);
    pts.push({ lat, lon, r: 250 });
  }
  return pts;
}

function nextJob(lane: Provider, now: number): Job | null {
  const jobs: Job[] = [];
  // 1. What people are looking at, refreshed every ~5 s.
  const pts: { lat: number; lon: number; r: number }[] = [];
  for (const v of views.values()) {
    if (now - v.seen > 30_000) continue;
    for (const p of viewPoints(v)) {
      if (!pts.some((q) => distance(q.lat, q.lon, p.lat, p.lon) < 60 * NM && q.r >= p.r)) pts.push(p);
    }
  }
  for (const p of pts.slice(0, 14)) {
    const key = `pt:${p.lat.toFixed(1)},${p.lon.toFixed(1)}`;
    jobs.push({ key, url: (P) => P.point(p.lat, p.lon, p.r), cadence: 6, due: (lastRun.get(key) ?? 0) + 5000, pri: 0 });
  }
  // 2. Military aircraft and emergency squawks, worldwide.
  // Each network hears different military traffic: ask every one of them.
  jobs.push({ key: `mil:${lane}`, url: (P) => P.mil, cadence: 30, due: (lastRun.get(`mil:${lane}`) ?? 0) + 20_000, pri: 0 });
  for (const s of ['7700', '7600', '7500']) {
    jobs.push({ key: `sq${s}`, url: (P) => P.sqk(s), cadence: 30, due: (lastRun.get(`sq${s}`) ?? 0) + 30_000, pri: 0 });
  }
  // 2b. Worldwide lists in one request: LADD and privacy-address aircraft,
  // mostly business jets that other networks leave out.
  PROVIDERS[lane].lists.forEach((u, i) => {
    const key = `ls${i}:${lane}`;
    jobs.push({ key, url: () => u, cadence: 90, due: (lastRun.get(key) ?? 0) + 75_000, pri: 0 });
  });
  // 3. Worldwide by type, on the networks that offer it.
  if (PROVIDERS[lane].type) {
    for (const t of topTypes) {
      const key = `ty:${t}`;
      jobs.push({ key, url: (P) => P.type!(t), cadence: 240, due: (lastRun.get(key) ?? 0) + 150_000, needsType: true });
    }
  }
  // 4. Sweep the world, busiest airspace most often. This fills in what
  // OpenSky misses and carries the whole picture when its credits run out.
  const fast = opensky.healthy ? 120_000 : 75_000;
  for (const p of SWEEP) {
    const key = `sw:${p.lat},${p.lon}`;
    const busy = p.weight >= 5;
    jobs.push({ key, url: (P) => P.point(p.lat, p.lon, 250), cadence: busy ? fast / 800 : 330, due: (lastRun.get(key) ?? 0) + (busy ? fast : 300_000) });
  }
  const ready = jobs.filter((j) => j.due <= now).sort((a, b) => (a.pri ?? 1) - (b.pri ?? 1) || a.due - b.due);
  void lane;
  return ready[0] ?? null;
}

const laneStatus: Record<Provider, Status> = {
  adsbfi: new Status('adsbfi', 'adsb.fi', 'air', 1.5),
  adsblol: new Status('adsblol', 'adsb.lol', 'air', 1.5),
  airplaneslive: new Status('airplaneslive', 'airplanes.live', 'air', 1.5),
  adsbone: new Status('adsbone', 'adsb.one', 'air', 1.5),
};

function startLane(lane: Provider, offsetMs: number, gapS: number) {
  const src = SRC[lane];
  let backoff = 0;
  let refused = 0;
  laneStatus[lane].interval = gapS;
  setTimeout(() => every(() => gapS, async () => {
    if (!watching()) return 2;
    if (backoff > Date.now()) return (backoff - Date.now()) / 1000;
    const now = Date.now();
    const job = nextJob(lane, now);
    if (!job) return 1;
    lastRun.set(job.key, now);
    try {
      const { data } = await getJson<any>(job.url(PROVIDERS[lane]), {}, 15_000);
      const reports = parseReadsb(data, src, job.cadence);
      for (const r of reports) air.ingest(r);
      refused = 0;
      laneStatus[lane].success(reports.length, 'your view, worldwide sweep, military, emergencies');
    } catch (e) {
      lastRun.set(job.key, now - 4000); // let the other lane retry it
      laneStatus[lane].fail(e);
      const s = e instanceof HttpError ? e.status : 0;
      if (s === 429) backoff = Date.now() + Math.max(60, (e as HttpError).retryAfter ?? 0) * 1000;
      else if (s === 401 || s === 403) {
        // Some networks refuse cloud servers; stop asking for an hour.
        if (++refused >= 5) { backoff = Date.now() + 3_600_000; laneStatus[lane].fail(e, 'refused from this server; retrying hourly'); }
      } else if (s >= 500 || !s) backoff = Date.now() + 10_000;
    }
  }), offsetMs);
}

// ---------------------------------------------------------------------------
// Feed schedule

every(() => opensky.pollS, async () => {
  if (process.env.OPENSKY === 'off') { opensky.status.note = 'off'; return 3600; }
  if (!watching()) return 5;
  return opensky.poll(ingestAir);
});
// adsb.fi and airplanes.live document one request a second; adsb.lol asks
// for restraint. Each lane stays under its network's limit.
startLane('adsbfi', 300, 1.15);
startLane('adsblol', 1050, 2.5);
startLane('airplaneslive', 700, 1.15);
startLane('adsbone', 900, 1.5);
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
      for (const r of reports) air.ingest(r);
      f.status.success(reports.length, 'your antenna, every 2 s');
    } catch (e) {
      f.status.fail(e);
      return 15;
    }
  });
}
every(() => 0.8, async () => {
  if (process.env.OPENWATERS === 'off') return 3600;
  if (!watching()) return 5;
  // Viewers' views first: the 10° boxes their screens overlap, if few.
  const focus: { s: number; w: number; n: number; e: number }[] = [];
  for (const v of views.values()) {
    if (Date.now() - v.seen > 30_000 || v.r > 700) continue;
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
// Headlines keep coming whether or not anyone is watching, so the desk is
// full when someone arrives; each feed is asked every 10 to 20 minutes.
every(() => 2, () => news.tick());
every(() => 6 * 3600, () => spacecraft.poll());
every(() => 1800, () => launches.poll());
setInterval(() => { air.sweep(); sea.sweep(); }, 5000);
setInterval(() => {
  for (const [k, v] of views) if (Date.now() - v.seen > 120_000) views.delete(k);
}, 30_000);

// ---------------------------------------------------------------------------
// HTTP

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// Payloads that are the same object for every viewer until their data
// changes are serialised and compressed once, not once per request.
const packed = new WeakMap<object, { raw: Buffer; z?: Buffer }>();

async function sendJson(req: http.IncomingMessage, res: http.ServerResponse, body: unknown, shared = false) {
  let pk = shared && body && typeof body === 'object' ? packed.get(body) : undefined;
  if (!pk) {
    pk = { raw: Buffer.from(JSON.stringify(body)) };
    if (shared && body && typeof body === 'object') packed.set(body, pk);
  }
  const raw = pk.raw;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
  };
  if (raw.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    const z = pk.z ?? (pk.z = await gz(raw, { level: 6 }));
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': z.length });
    res.end(z);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': raw.length });
    res.end(raw);
  }
}

let wxBody: WeatherPayload | null = null;
function weatherBody(): WeatherPayload {
  if (!wxBody || wxBody.stations !== metars.stations || wxBody.clouds !== clouds.time) {
    wxBody = { at: metars.status.lastOk, stations: metars.stations, clouds: clouds.time };
  }
  return wxBody;
}

let windCache = { t: 0, v: [] as ReturnType<typeof air.winds> };
function windsCached() {
  if (Date.now() - windCache.t > 15_000) windCache = { t: Date.now(), v: air.winds() };
  return windCache.v;
}

// Airport weather: the latest METAR from aviationweather.gov (NOAA), decoded
// by them into fields, cached five minutes.
const metarCache = new Map<string, { t: number; v: unknown }>();
async function metar(icao: string): Promise<unknown> {
  const c = metarCache.get(icao);
  if (c && Date.now() - c.t < 300_000) return c.v;
  try {
    const { data } = await getJson<any[]>(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`, {}, 10_000);
    const v = data?.[0] ?? null;
    metarCache.set(icao, { t: Date.now(), v });
    if (metarCache.size > 1000) metarCache.clear();
    return v;
  } catch {
    return null;
  }
}

let statsCache = { t: 0, v: sea.stats() };
function shipStats() {
  if (Date.now() - statsCache.t > 20_000) statsCache = { t: Date.now(), v: sea.stats() };
  return statsCache.v;
}

function sources() {
  let est = 0;
  for (const r of air.values()) if (r[14] & AF.est) est++;
  estimator.status.count = est;
  estimator.status.note = `${est} aircraft carried beyond receiver range on verified routes`;
  return [...ownAir.map((f) => f.status), opensky.status, laneStatus.adsbfi, laneStatus.adsblol, laneStatus.airplaneslive, laneStatus.adsbone, estimator.status, openwaters.status, digitraffic.status, kystverket.status, ...ownAis.map((f) => f.status), aisstream.status, usgs.status, gdacs.status, metars.status, clouds.status, iss.status, spacecraft.status, launches.status, news.status]
    .map((s) => s.toJSON());
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/api/air') {
      const c = url.searchParams.get('c');
      const vp = url.searchParams.get('vp')?.split(',').map(Number);
      if (c && vp && vp.length >= 3 && vp.every(isFinite)) {
        views.set(c.slice(0, 40), { lat: vp[0], lon: vp[1], r: vp[2], seen: Date.now() });
      }
      return sendJson(req, res, air.delta(Number(url.searchParams.get('since')) || 0));
    }
    if (p === '/api/sea') {
      // The ships in the viewer's box (or the busiest of them), whole each time.
      const b = url.searchParams.get('bbox')?.split(',').map(Number);
      const box = b && b.length === 4 && b.every(isFinite) ? (b as [number, number, number, number]) : null;
      const rows = sea.inView(box, box ? 15_000 : 5_000, Number(url.searchParams.get('sel')) || 0);
      return sendJson(req, res, { now: Date.now(), full: true, rows, removed: [] });
    }
    if (p === '/api/world') {
      const body: WorldPayload = {
        now: Date.now(), quakes: usgs.quakes, disasters: gdacs.events, iss: iss.track, sources: sources(),
        ships: shipStats(),
      };
      return sendJson(req, res, body);
    }
    let m = p.match(/^\/api\/detail\/air\/([0-9a-f~]{6,7})$/i);
    if (m) return sendJson(req, res, air.extras(m[1].toLowerCase()));
    m = p.match(/^\/api\/detail\/sea\/(\d{6,9})$/);
    if (m) return sendJson(req, res, await shipDetail(Number(m[1])));
    if (p === '/api/winds') return sendJson(req, res, windsCached());
    if (p === '/api/weather') return sendJson(req, res, weatherBody(), true);
    if (p === '/api/space') {
      const body: SpacePayload = { now: Date.now(), sats: spacecraft.sats, launches: launches.launches };
      return sendJson(req, res, body);
    }
    if (p === '/api/news') {
      const body: NewsPayload = { now: Date.now(), items: news.items, feeds: [...news.feeds.values()].map((s) => s.toJSON()) };
      return sendJson(req, res, body);
    }
    m = p.match(/^\/api\/metar\/([A-Z0-9]{3,4})$/i);
    if (m) return sendJson(req, res, await metar(m[1].toUpperCase()));
    m = p.match(/^\/api\/history\/air\/([0-9a-f~]{6,7})$/i);
    if (m) return sendJson(req, res, air.history(m[1].toLowerCase()));
    m = p.match(/^\/api\/history\/sea\/(\d{6,9})$/);
    if (m) return sendJson(req, res, sea.history(Number(m[1])));
    if (p === '/healthz') {
      return sendJson(req, res, { ok: true, aircraft: air.size, ships: sea.size, airframes: acdb.status, watching: watching(), sources: sources() });
    }
    // Static files (production build).
    if (!existsSync(DIST)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No build found. Run `npm run build`, or use `npm run dev` and open the Vite URL.');
    }
    let file = normalize(join(DIST, decodeURIComponent(p)));
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Watchman aggregator on http://localhost:${PORT}`);
  console.log(`  OpenSky: ${opensky.status.note}, every ${opensky.pollS}s while watched`);
  console.log(`  AISStream: ${aisstream.enabled ? 'on' : 'off (no AISSTREAM_API_KEY)'}`);
});

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
