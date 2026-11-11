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
const GAP_MS = 800; // 75 requests a minute, comfortably under the 120 allowed

interface Box { s: number; w: number; n: number; e: number; next: number; count: number }

/** One ship's registry particulars and its last day of track. */
export interface ShipDetail {
  particulars: unknown; firstSeen: string | null; near: string | null;
  track: { coords: [number, number][]; times: string[]; sog: (number | null)[] } | null;
}
const NO_DETAIL: ShipDetail = { particulars: null, firstSeen: null, near: null, track: null };
const DETAIL_TTL_MS = 120_000;
const DETAIL_FAIL_TTL_MS = 60_000;
const DETAIL_CACHE = 500;
const DETAIL_QUEUE = 10;
const DETAIL_WAIT_MS = 20_000;

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
  readonly enabled = process.env.OPENWATERS !== 'off';
  // Ship particulars asked for by viewers, fetched in the sweep's turn so
  // they share its budget: anyone can ask for any MMSI, and each costs two
  // requests of the 120 a minute Open Waters allows anonymous callers.
  private detailCache = new Map<number, { until: number; v: ShipDetail }>();
  private detailWait = new Map<number, Promise<ShipDetail>>();
  private detailQueue: { mmsi: number; resolve: (v: ShipDetail) => void }[] = [];
  private sweepsSinceDetail = 2;

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
      if ((this.focusNext.get(k) ?? 0) <= now) { this.focusNext.set(k, now + 15_000); return f; }
    }
    let best: Box | null = null;
    for (const b of this.boxes) if (b.next <= now && (!best || b.next < best.next)) best = b;
    return best ? { ...best, box: best } : null;
  }

  /** Viewer requests waiting for a turn. */
  get queued() { return this.detailQueue.length; }

  /**
   * One request's turn: a waiting ship detail (at most every third turn,
   * so viewers can take half the requests but never the sweep's share), or
   * the next box of the sweep when `sweep` (someone is watching).
   */
  async tick(ingest: (r: ShipReport) => void, sweep = true): Promise<number> {
    const now = Date.now();
    if (this.backoff > now) {
      for (const d of this.detailQueue.splice(0)) d.resolve(NO_DETAIL);
      return (this.backoff - now) / 1000;
    }
    if (this.detailQueue.length && (this.sweepsSinceDetail >= 2 || !sweep)) {
      const d = this.detailQueue.shift()!;
      this.sweepsSinceDetail = 0;
      d.resolve(await this.fetchDetail(d.mmsi));
      return (2 * GAP_MS) / 1000; // it took two requests
    }
    if (!sweep) return 1;
    this.sweepsSinceDetail++;
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
        // Busy seas every 2 minutes, quiet ones every 7, empty ones hourly.
        q.box.next = now + (n > 200 ? 120_000 : n > 0 ? 420_000 : 3_600_000);
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

  /** A ship's particulars and track: cached, shared while in flight, paced with the sweep. */
  detail(mmsi: number, now = Date.now()): Promise<ShipDetail> {
    const c = this.detailCache.get(mmsi);
    if (c && c.until > now) return Promise.resolve(c.v);
    const w = this.detailWait.get(mmsi);
    if (w) return w;
    if (!this.enabled || this.backoff > now || this.detailQueue.length >= DETAIL_QUEUE) return Promise.resolve(NO_DETAIL);
    const p = new Promise<ShipDetail>((resolve) => {
      const item = { mmsi, resolve };
      this.detailQueue.push(item);
      // Not reached in time (a long queue, the loop paused): answer empty.
      setTimeout(() => {
        const i = this.detailQueue.indexOf(item);
        if (i >= 0) { this.detailQueue.splice(i, 1); resolve(NO_DETAIL); }
      }, DETAIL_WAIT_MS).unref();
    }).finally(() => this.detailWait.delete(mmsi));
    this.detailWait.set(mmsi, p);
    return p;
  }

  private async fetchDetail(mmsi: number): Promise<ShipDetail> {
    const id = String(mmsi).padStart(9, '0');
    const from = new Date(Date.now() - 24 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const init = this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {};
    let failed = false;
    const get = (u: string) => getJson<any>(u, init, 15_000).then((r) => r.data, (e) => {
      if (e instanceof HttpError && e.status === 404) return null; // not a ship it knows: an answer
      failed = true;
      if (e instanceof HttpError && e.status === 429) this.backoff = Date.now() + Math.max(60, e.retryAfter ?? 0) * 1000;
      return null;
    });
    const [d, t] = await Promise.all([get(`${API}/${id}`), get(`${API}/${id}/track?from=${from}`)]);
    const p = d?.properties ?? {};
    const v: ShipDetail = {
      particulars: p.particulars ?? null, firstSeen: p.first_seen ?? null, near: p.near ?? null,
      track: t?.geometry?.type === 'LineString'
        ? { coords: t.geometry.coordinates, times: t.properties?.times ?? [], sog: t.properties?.sog ?? [] }
        : null,
    };
    // A failure is remembered briefly, so a broken ship isn't asked for on every click.
    this.detailCache.delete(mmsi);
    this.detailCache.set(mmsi, { until: Date.now() + (failed ? DETAIL_FAIL_TTL_MS : DETAIL_TTL_MS), v });
    for (const k of this.detailCache.keys()) { if (this.detailCache.size <= DETAIL_CACHE) break; this.detailCache.delete(k); }
    return v;
  }
}
