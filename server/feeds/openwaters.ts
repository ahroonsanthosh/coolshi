// Open Waters AIS (openwaters.io): an open network that merges government
// feeds, AISHub, aisstream.io and volunteer receivers into one stream, readable
// without an account. Anonymous clients may ask for the last known positions
// in a box of up to 100 square degrees, 120 times a minute. We tile the seas
// into 10° boxes and sweep them, visiting busy boxes often and empty ones
// rarely, and look at whatever a viewer is watching first.
//
// Every report names the network it came from; we keep it for attribution.

import type { ShipReport } from '../store.ts';
import { SRC } from '../../shared/protocol.ts';
import { getJson, HttpError, Status } from './http.ts';

const API = 'https://ais.openwaters.io/v1/vessels';
const GAP_MS = 1300; // ~46 requests a minute, well under the 120 allowed

interface Box { s: number; w: number; n: number; e: number; next: number; count: number }

const VIA: Record<string, string> = {
  aishub: 'AISHub', aisstream: 'aisstream.io', barentswatch: 'BarentsWatch', kystverket: 'Kystverket', digitraffic: 'Fintraffic',
};

export class OpenWaters {
  status = new Status('openwaters', 'Open Waters AIS', 'sea', GAP_MS / 1000);
  private boxes: Box[] = [];
  token = process.env.OPENWATERS_TOKEN ?? '';
  private backoff = 0;
  /** Boxes a viewer is looking at right now, polled ahead of the sweep. */
  focus: { s: number; w: number; n: number; e: number }[] = [];
  private focusNext = new Map<string, number>();
  ships = 0;

  /** `ports`: [lat, lon] of places ships gather, to order the first sweep. */
  constructor(ports: [number, number][]) {
    // A personal token allows 400 square degrees a request: 20° boxes, a
    // quarter of the requests for the same seas.
    const step = this.token ? 20 : 10;
    for (let s = -70; s < 80; s += step) for (let w = -180; w < 180; w += step) {
      const n = Math.min(90, s + step), e = w + step;
      const near = ports.filter(([la, lo]) => la >= s && la < n && lo >= w && lo < e).length;
      // First pass: busiest boxes first (a lower `next` is visited sooner).
      this.boxes.push({ s, w, n, e, next: -near, count: -1 });
    }
    this.status.note = 'worldwide: AISHub, aisstream.io, BarentsWatch and volunteers';
  }

  private pick(now: number): { s: number; w: number; n: number; e: number; box?: Box } | null {
    for (const f of this.focus) {
      const k = `${f.s},${f.w},${f.n},${f.e}`;
      if ((this.focusNext.get(k) ?? 0) <= now) { this.focusNext.set(k, now + 20_000); return f; }
    }
    let best: Box | null = null;
    for (const b of this.boxes) if (b.next <= now && (!best || b.next < best.next)) best = b;
    return best ? { ...best, box: best } : null;
  }

  async tick(ingest: (r: ShipReport) => void): Promise<number> {
    const now = Date.now();
    if (this.backoff > now) return (this.backoff - now) / 1000;
    const q = this.pick(now);
    if (!q) return GAP_MS / 1000;
    const url = `${API}?bbox=${q.s},${q.w},${q.n},${q.e}&max_age=6h&max_age_moving=30m&kind=vessel`;
    try {
      const { data } = await getJson<any>(url, this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {}, 30_000);
      let n = 0;
      for (const f of data.features ?? []) {
        const p = f.properties ?? {};
        const [lon, lat] = f.geometry?.coordinates ?? [];
        const t = Date.parse(p.seen);
        if (!isFinite(lat) || !isFinite(lon) || !isFinite(t) || !p.mmsi) continue;
        const via = VIA[p.source] ?? (String(p.source ?? '').startsWith('udp') || String(p.source ?? '').startsWith('station') ? 'volunteer receiver' : String(p.source ?? ''));
        ingest({
          mmsi: p.mmsi, lat, lon, posT: t / 1000,
          sog: p.sog ?? null, cog: p.cog ?? null, hdg: p.heading ?? null, nav: p.nav_status ?? 15,
          name: p.name, callsign: p.callsign, imo: p.imo, type: p.type, dest: p.destination, eta: p.eta,
          draught: p.draught ?? null,
          // A dimension at AIS's maximum code means "this or more": unknown.
          len: p.to_bow >= 511 || p.to_stern >= 511 ? null : p.length ?? null,
          beam: p.to_port >= 63 || p.to_starboard >= 63 ? null : p.beam ?? null,
          via, flag: p.flag, src: SRC.openwaters,
        });
        n++;
      }
      if (q.box) {
        q.box.count = n;
        // Busy seas every 3 minutes, quiet ones every 10, empty ones hourly.
        q.box.next = now + (n > 200 ? 180_000 : n > 0 ? 600_000 : 3_600_000);
      }
      this.status.success(this.ships, 'worldwide: AISHub, aisstream.io, BarentsWatch and volunteers');
    } catch (e) {
      if (q.box) q.box.next = now + 300_000;
      this.status.fail(e);
      const s = e instanceof HttpError ? e.status : 0;
      if (s === 429) this.backoff = now + Math.max(60, (e as HttpError).retryAfter ?? 0) * 1000;
      else if (s === 401 || s === 403) this.backoff = now + 600_000;
    }
    return GAP_MS / 1000;
  }
}

/** One ship's registry particulars and its last day of track, cached. */
const shipCache = new Map<number, { t: number; v: unknown }>();
export async function shipDetail(mmsi: number): Promise<unknown> {
  const c = shipCache.get(mmsi);
  if (c && Date.now() - c.t < 120_000) return c.v;
  const token = process.env.OPENWATERS_TOKEN ?? '';
  const h: Record<string, string> = { 'User-Agent': 'Watchman/1.0' };
  if (token) h.Authorization = `Bearer ${token}`;
  const id = String(mmsi).padStart(9, '0');
  const from = new Date(Date.now() - 24 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const get = (u: string) => fetch(u, { headers: h }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [d, t] = await Promise.all([
    get(`https://ais.openwaters.io/v1/vessels/${id}`),
    get(`https://ais.openwaters.io/v1/vessels/${id}/track?from=${from}`),
  ]) as [any, any];
  const p = d?.properties ?? {};
  const v = {
    particulars: p.particulars ?? null, firstSeen: p.first_seen ?? null, near: p.near ?? null,
    track: t?.geometry?.type === 'LineString'
      ? { coords: t.geometry.coordinates as [number, number][], times: (t.properties?.times ?? []) as string[], sog: (t.properties?.sog ?? []) as (number | null)[] }
      : null,
  };
  shipCache.set(mmsi, { t: Date.now(), v });
  if (shipCache.size > 500) shipCache.clear();
  return v;
}
