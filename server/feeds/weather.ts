// The weather as it is being observed right now, not forecast:
//
// - Every METAR in the world (airports and automatic stations), from NOAA's
//   Aviation Weather Center, which republishes the whole set every minute as
//   one file. Measured temperature, wind, visibility, cloud and present
//   weather (rain, snow, thunder, fog).
// - The time of the newest global infrared cloud picture from EUMETSAT, a
//   mosaic of the geostationary satellites ringing the equator (Meteosat,
//   GOES, Himawari). Browsers fetch its tiles directly; the server only learns
//   which image is newest, so every viewer draws the same one with its time.

import { gunzipSync } from 'node:zlib';
import type { Hazard, WxRow } from '../../shared/protocol.ts';
import { HttpError, Status, UA } from './http.ts';

const METARS = 'https://aviationweather.gov/data/cache/metars.cache.csv.gz';
export const CLOUD_LAYER = 'mumi:worldcloudmap_ir108';
const CLOUD_CAPS = 'https://view.eumetsat.int/geoserver/mumi/worldcloudmap_ir108/ows?service=WMS&version=1.3.0&request=GetCapabilities';

/** Observations older than this are no longer "now". */
const MAX_AGE_S = 3 * 3600;

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new HttpError(res.status, null, `${res.status} ${res.statusText}`.trim());
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Split one CSV line, honouring double quotes (the raw METAR is quoted). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const v = parseFloat(s);
  return isFinite(v) ? v : null;
};

/**
 * Parse AWC's METAR cache CSV into compact rows: one per station, newest
 * report wins, without hidden or placeholder positions or stale reports.
 */
export function parseMetarCsv(text: string, nowS = Date.now() / 1000): WxRow[] {
  const lines = text.split('\n');
  const head = splitCsv(lines[0] ?? '');
  const col = (name: string) => head.indexOf(name);
  const iId = col('station_id'), iT = col('observation_time'), iLat = col('latitude'), iLon = col('longitude');
  const iTemp = col('temp_c'), iDew = col('dewpoint_c'), iDir = col('wind_dir_degrees'), iSpd = col('wind_speed_kt');
  const iGust = col('wind_gust_kt'), iVis = col('visibility_statute_mi'), iWx = col('wx_string');
  if (iId < 0 || iLat < 0 || iLon < 0 || iT < 0) throw new Error('unexpected METAR file layout');

  const best = new Map<string, WxRow>();
  for (let n = 1; n < lines.length; n++) {
    if (!lines[n]) continue;
    const f = splitCsv(lines[n]);
    const id = f[iId];
    const lat = num(f[iLat]), lon = num(f[iLon]);
    // Military and some private stations publish -99.99 instead of a position.
    if (!id || lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const t = Date.parse(f[iT]) / 1000;
    if (!isFinite(t) || nowS - t > MAX_AGE_S || t - nowS > 900) continue;
    const prev = best.get(id);
    if (prev && prev[3] >= t) continue;
    // A north wind is reported as 360, never 000: the file writes variable
    // winds ("VRB03KT") as direction 0 with a speed, and calm as 0 at 0.
    const spd = num(f[iSpd]);
    let dir = f[iDir] === 'VRB' ? -1 : num(f[iDir]);
    if (dir === 0 && spd) dir = -1;
    best.set(id, [
      id, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, Math.round(t),
      num(f[iTemp]), num(f[iDew]),
      dir, spd, num(f[iGust]), num(f[iVis]),
      (f[iWx] ?? '').trim(),
    ]);
  }
  return [...best.values()];
}

export class Metars {
  status = new Status('metars', 'Weather stations (METAR)', 'event', 300);
  stations: WxRow[] = [];

  async poll() {
    try {
      const text = gunzipSync(await fetchBytes(METARS, 30_000)).toString('utf8');
      const rows = parseMetarCsv(text);
      if (!rows.length) throw new Error('no current observations in the file');
      this.stations = rows;
      this.status.success(rows.length, 'NOAA Aviation Weather Center: every METAR worldwide, observed in the last 3 h');
    } catch (e) {
      this.status.fail(e);
    }
  }
}

export class Clouds {
  status = new Status('clouds', 'Satellite clouds (EUMETSAT)', 'event', 900);
  /** Newest image time, ms. */
  time: number | null = null;

  async poll() {
    try {
      const xml = (await fetchBytes(CLOUD_CAPS, 20_000)).toString('utf8');
      const m = xml.match(/<Dimension[^>]*name="time"[^>]*default="([^"]+)"/);
      const t = m ? Date.parse(m[1]) : NaN;
      if (!isFinite(t)) throw new Error('no image time in the capabilities');
      this.time = t;
      const h = new Date(t).toISOString().slice(11, 16);
      this.status.success(1, `infrared 10.8 µm from the geostationary ring, every 3 h; newest ${h} UTC`);
    } catch (e) {
      this.status.fail(e);
    }
  }
}

// ---------------------------------------------------------------------------
// SIGMETs: warnings of weather dangerous to all aircraft (thunderstorms,
// severe turbulence and icing, volcanic ash, tropical cyclones, mountain
// waves), worldwide from the meteorological watch offices, and the US ones
// from the Aviation Weather Center, both via aviationweather.gov.

const ISIGMET = 'https://aviationweather.gov/api/data/isigmet?format=geojson';
const AIRSIGMET = 'https://aviationweather.gov/api/data/airsigmet?format=geojson';

const QUAL: Record<string, string> = {
  SEV: 'severe', MOD: 'moderate', EMBD: 'embedded', OBSC: 'obscured', FRQ: 'frequent', SQL: 'squall line of', ISOL: 'isolated', OCNL: 'occasional',
};

/** An international SIGMET's hazard in words, and its kind for the map. */
export function describeHazard(hazard: string, qualifier = ''): { kind: Hazard['kind']; label: string } {
  const h = hazard.toUpperCase(), q = qualifier.toUpperCase();
  const qual = q.split(/\s+/).map((w) => QUAL[w]).filter(Boolean).join(' ');
  const w = (s: string) => (qual ? `${qual} ${s}` : s);
  if (h === 'TS' || h === 'TSGR' || h === 'CONVECTIVE') return { kind: 'storm', label: w(h === 'TSGR' ? 'thunderstorms with hail' : 'thunderstorms') };
  if (h === 'TURB') return { kind: 'turb', label: w('turbulence') };
  if (h === 'ICE') return { kind: 'ice', label: w(q.includes('FZRA') ? 'icing in freezing rain' : 'icing') };
  if (h === 'VA' || h === 'ASH') return { kind: 'ash', label: `volcanic ash${q && !QUAL[q] ? `, ${qualifier.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}` : ''}` };
  if (h === 'TC') return { kind: 'cyclone', label: `tropical cyclone${q ? ` ${qualifier.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}` : ''}` };
  if (h === 'MTW') return { kind: 'wave', label: w('mountain waves') };
  if (h === 'DS' || h === 'SS') return { kind: 'dust', label: w(h === 'DS' ? 'duststorm' : 'sandstorm') };
  if (h === 'RDOACT CLD') return { kind: 'other', label: 'radioactive cloud' };
  return { kind: 'other', label: w(h.toLowerCase()) };
}

function rings(g: any): [number, number][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates[0]];
  if (g.type === 'MultiPolygon') return g.coordinates.map((p: any) => p[0]);
  return [];
}

export function parseIsigmet(fc: any, now = Date.now()): Hazard[] {
  const out: Hazard[] = [];
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? {};
    const r = rings(f.geometry);
    const from = Date.parse(p.validTimeFrom), to = Date.parse(p.validTimeTo);
    if (!r.length || !isFinite(to) || to < now) continue;
    const { kind, label } = describeHazard(p.hazard ?? '', p.qualifier ?? '');
    out.push({
      id: `i:${p.firId ?? p.icaoId}:${p.seriesId ?? ''}:${p.validTimeFrom}`, kind, label, area: (p.firName ?? p.firId ?? '').trim(),
      from, to, base: typeof p.base === 'number' ? p.base : null, top: typeof p.top === 'number' ? p.top : null,
      raw: String(p.rawSigmet ?? '').trim(), rings: r,
    });
  }
  return out;
}

export function parseAirSigmet(fc: any, now = Date.now()): Hazard[] {
  const out: Hazard[] = [];
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? {};
    if (p.airSigmetType !== 'SIGMET') continue; // AIRMETs and outlooks are lesser or not yet in force
    const r = rings(f.geometry);
    const from = Date.parse(p.validTimeFrom), to = Date.parse(p.validTimeTo);
    if (!r.length || !isFinite(to) || to < now) continue;
    const { kind, label } = describeHazard(p.hazard ?? '', p.severity >= 4 && p.hazard !== 'CONVECTIVE' ? 'SEV' : '');
    const lo = [p.altitudeLow1, p.altitudeLow2].filter((x) => typeof x === 'number');
    const hi = [p.altitudeHi1, p.altitudeHi2].filter((x) => typeof x === 'number');
    out.push({
      id: `us:${p.seriesId ?? ''}:${p.validTimeFrom}`, kind, label, area: 'United States (AWC)',
      from, to, base: lo.length ? Math.min(...lo) : null, top: hi.length ? Math.max(...hi) : null,
      raw: String(p.rawAirSigmet ?? '').trim(), rings: r,
    });
  }
  return out;
}

export class Hazards {
  status = new Status('sigmets', 'SIGMETs (aviation hazards)', 'event', 600);
  items: Hazard[] = [];

  async poll() {
    try {
      const [i, us] = await Promise.all([
        fetchBytes(ISIGMET, 30_000).then((b) => JSON.parse(b.toString('utf8'))),
        fetchBytes(AIRSIGMET, 30_000).then((b) => JSON.parse(b.toString('utf8'))).catch(() => null),
      ]);
      this.items = [...parseIsigmet(i), ...(us ? parseAirSigmet(us) : [])];
      this.status.success(this.items.length, 'thunderstorms, severe turbulence and icing, volcanic ash, cyclones and mountain waves, in force or soon');
    } catch (e) {
      this.status.fail(e);
    }
  }
}
