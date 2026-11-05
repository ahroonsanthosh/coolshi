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
import { OpenSky } from './feeds/opensky.ts';
import { PROVIDERS, parseReadsb } from './feeds/readsb.ts';
import { AisStream, Digitraffic } from './feeds/ships.ts';
import { Gdacs, Iss, Usgs } from './feeds/events.ts';
import { every, getJson, HttpError, Status } from './feeds/http.ts';
import { SRC, type WorldPayload } from '../shared/protocol.ts';
import { destination, distance, NM } from '../shared/geo.ts';

const gz = promisify(gzip);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
loadDotEnv(join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DIST = join(ROOT, 'dist');

const air = new AirStore();
const sea = new SeaStore();
const opensky = new OpenSky();
const digitraffic = new Digitraffic();
const aisstream = new AisStream();
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

const HUBS: [number, number][] = [
  [51.5, -0.4], [49.0, 2.5], [50.0, 8.6], [52.3, 4.8], [40.5, -3.6], [41.8, 12.3], [41.2, 28.8],
  [55.9, 37.4], [59.6, 17.9], [52.2, 21.0], [25.2, 55.4], [28.6, 77.1], [19.1, 72.9], [13.7, 100.7],
  [1.4, 104.0], [22.3, 113.9], [31.1, 121.8], [40.1, 116.6], [35.6, 139.8], [37.5, 126.8],
  [-6.1, 106.7], [-33.9, 151.2], [-37.7, 144.8], [-26.1, 28.2], [30.1, 31.4], [6.6, 3.3], [-1.3, 36.9],
  [-23.4, -46.5], [4.7, -74.1], [19.4, -99.1], [40.6, -73.8], [42.0, -87.9], [33.6, -84.4],
  [32.9, -97.0], [39.9, -104.7], [33.9, -118.4], [37.6, -122.4], [47.4, -122.3], [43.7, -79.6],
  [25.8, -80.3], [21.3, -157.9], [61.2, -150.0], [64.1, -21.9], [53.4, -6.3], [38.8, -9.1],
];

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

function nextJob(lane: 'adsbfi' | 'adsblol', now: number): Job | null {
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
  // 3. Without OpenSky's world picture, sweep the busiest airspace instead.
  if (!opensky.healthy) {
    for (const [lat, lon] of HUBS) {
      const key = `hub:${lat},${lon}`;
      jobs.push({ key, url: (P) => P.point(lat, lon, 250), cadence: 90, due: (lastRun.get(key) ?? 0) + 70_000 });
    }
  }
  const ready = jobs.filter((j) => j.due <= now).sort((a, b) => a.due - b.due);
  void lane;
  return ready[0] ?? null;
}

const laneStatus = {
  adsbfi: new Status('adsbfi', 'adsb.fi', 'air', 1.5),
  adsblol: new Status('adsblol', 'adsb.lol', 'air', 1.5),
};

function startLane(lane: 'adsbfi' | 'adsblol', offsetMs: number, gapS: number) {
  const src = lane === 'adsbfi' ? SRC.adsbfi : SRC.adsblol;
  let backoff = 0;
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
      laneStatus[lane].success(reports.length, 'viewport detail, military, emergencies');
    } catch (e) {
      lastRun.set(job.key, now - 4000); // let the other lane retry it
      laneStatus[lane].fail(e);
      const s = e instanceof HttpError ? e.status : 0;
      if (s === 429) backoff = Date.now() + Math.max(60, (e as HttpError).retryAfter ?? 0) * 1000;
      else if (s >= 500 || !s) backoff = Date.now() + 10_000;
    }
  }), offsetMs);
}

// ---------------------------------------------------------------------------
// Feed schedule

every(() => opensky.pollS, async () => {
  if (!watching()) return 5;
  return opensky.poll(ingestAir);
});
// adsb.fi documents one request a second; adsb.lol asks for restraint.
startLane('adsbfi', 300, 1.3);
startLane('adsblol', 1050, 3);
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
  return [opensky.status, laneStatus.adsbfi, laneStatus.adsblol, digitraffic.status, aisstream.status, usgs.status, gdacs.status, iss.status]
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
      return sendJson(req, res, { ok: true, aircraft: air.size, ships: sea.size, watching: watching(), sources: sources() });
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
