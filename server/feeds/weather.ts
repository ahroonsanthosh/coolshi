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
import type { WxRow } from '../../shared/protocol.ts';
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
