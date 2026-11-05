// Watchfloor aggregator. Polls every feed, merges them into one picture, and
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
import { Kystverket } from './feeds/kystverket.ts';
import { sweepGrid } from './grid.ts';
import { Estimator } from './estimates.ts';
import { AisStream, Digitraffic } from './feeds/ships.ts';
import { Gdacs, Iss, Usgs } from './feeds/events.ts';
import { every, getJson, HttpError, Status } from './feeds/http.ts';
import { AF, SRC, type WorldPayload } from '../shared/protocol.ts';
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
const usgs = new Usgs();
const gdacs = new Gdacs();
const iss = new Iss();
const ingestAir = (r: AircraftReport) => air.ingest(r);

// ---------------------------------------------------------------------------
// Who is watching what. Each browser reports its view; the ADS-B networks are
// asked about those areas, so zooming in gets fresh, detailed traffic.

interface View { lat: number; lon: number; r: number; seen: number }
const views = new Map<string, View>();
const watching = () => [...views.values()].some((v) => Date.now() - v.seen < 60_000);

// ---------------------------------------------------------------------------
// adsb.fi / adsb.lol: two lanes, each paced to what its network allows.

type Job = { key: string; url: (p: typeof PROVIDERS.adsbfi) => string; cadence: number; due: number };
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
    jobs.push({ key, url: (P) => P.point(p.lat, p.lon, p.r), cadence: 6, due: (lastRun.get(key) ?? 0) + 5000 });
  }
  // 2. Military aircraft and emergency squawks, worldwide.
  jobs.push({ key: 'mil', url: (P) => P.mil, cadence: 30, due: (lastRun.get('mil') ?? 0) + 20_000 });
  for (const s of ['7700', '7600', '7500']) {
    jobs.push({ key: `sq${s}`, url: (P) => P.sqk(s), cadence: 30, due: (lastRun.get(`sq${s}`) ?? 0) + 30_000 });
  }
  // 3. Sweep the world, busiest airspace most often. This fills in what
  // OpenSky misses and carries the whole picture when its credits run out.
  const fast = opensky.healthy ? 120_000 : 75_000;
  for (const p of SWEEP) {
    const key = `sw:${p.lat},${p.lon}`;
    const busy = p.weight >= 5;
    jobs.push({ key, url: (P) => P.point(p.lat, p.lon, 250), cadence: busy ? fast / 800 : 330, due: (lastRun.get(key) ?? 0) + (busy ? fast : 300_000) });
  }
  const ready = jobs.filter((j) => j.due <= now).sort((a, b) => a.due - b.due);
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
every(() => 20, () => digitraffic.pollLocations((r) => sea.ingest(r)));
every(() => 600, () => digitraffic.pollMetadata((r) => sea.ingest(r)));
aisstream.start((r) => sea.ingest(r));
every(() => 120, () => usgs.poll());
every(() => 900, () => gdacs.poll());
every(() => 300, () => iss.poll());
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

async function sendJson(req: http.IncomingMessage, res: http.ServerResponse, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
  };
  if (raw.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    const z = await gz(raw, { level: 6 });
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': z.length });
    res.end(z);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': raw.length });
    res.end(raw);
  }
}

function sources() {
  let est = 0;
  for (const r of air.values()) if (r[14] & AF.est) est++;
  estimator.status.count = est;
  estimator.status.note = `${est} aircraft carried beyond receiver range on verified routes`;
  return [opensky.status, laneStatus.adsbfi, laneStatus.adsblol, laneStatus.airplaneslive, laneStatus.adsbone, estimator.status, digitraffic.status, kystverket.status, aisstream.status, usgs.status, gdacs.status, iss.status]
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
    if (p === '/api/sea') return sendJson(req, res, sea.delta(Number(url.searchParams.get('since')) || 0));
    if (p === '/api/world') {
      const body: WorldPayload = {
        now: Date.now(), quakes: usgs.quakes, disasters: gdacs.events, iss: iss.track, sources: sources(),
      };
      return sendJson(req, res, body);
    }
    let m = p.match(/^\/api\/history\/air\/([0-9a-f~]{6,7})$/i);
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
  console.log(`Watchfloor aggregator on http://localhost:${PORT}`);
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
