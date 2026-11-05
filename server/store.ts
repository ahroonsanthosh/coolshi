// The aggregator's picture: one record per aircraft (by ICAO 24-bit address)
// and per ship (by MMSI), merged from every feed. A report only moves a track
// if its position is newer than the one we hold, so a slow feed can never
// drag a track back to where it was a minute ago.

import { AF, type AircraftRow, type HistoryPoint, type ShipRow, type Delta } from '../shared/protocol.ts';
import { distance } from '../shared/geo.ts';

export interface AircraftReport {
  hex: string;
  lat: number;
  lon: number;
  posT: number; // s
  alt?: number | null;
  altGeom?: number | null;
  ground?: boolean;
  gs?: number | null;
  trk?: number | null;
  vr?: number | null;
  cs?: string;
  type?: string;
  reg?: string;
  desc?: string;
  owner?: string;
  sq?: string;
  cat?: string;
  mlat?: boolean;
  tisb?: boolean;
  mil?: boolean;
  ladd?: boolean;
  pia?: boolean;
  emergency?: string; // ADS-B emergency/priority status
  src: number;
  /** Seconds this source normally takes between reports of one aircraft. */
  cadence: number;
}

interface Aircraft {
  row: AircraftRow;
  upd: number; // server ms of last change
  expires: number; // server ms
  hist: HistoryPoint[];
  sqStreak: number; // consecutive reports with an emergency squawk
}

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
const HIST_MAX_AGE_S = 12 * 3600;
const HIST_MAX_POINTS = 2400;

export class AirStore {
  private map = new Map<string, Aircraft>();
  private tomb = new Map<string, number>();
  private bootedAt = Date.now();

  get size() { return this.map.size; }
  values() { return [...this.map.values()].map((a) => a.row); }
  get(hex: string) { return this.map.get(hex)?.row; }
  history(hex: string): HistoryPoint[] { return this.map.get(hex)?.hist ?? []; }

  ingest(r: AircraftReport, now = Date.now()): void {
    if (!isFinite(r.lat) || !isFinite(r.lon) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) return;
    if (r.posT * 1000 > now + 5000) r.posT = now / 1000; // clock skew guard
    let a = this.map.get(r.hex);
    if (!a) {
      a = {
        row: [r.hex, r.lat, r.lon, r.posT, null, null, null, null, null, '', '', '', '', '', 0, 0, '', '', 0, r.cadence],
        upd: now, expires: 0, hist: [], sqStreak: 0,
      };
      this.map.set(r.hex, a);
      this.tomb.delete(r.hex);
    }
    const row = a.row;
    const newer = r.posT > row[3] + 0.05;
    // Identity fields: take any non-empty value; databases behind adsb.fi and
    // adsb.lol know the type and registration, OpenSky doesn't send them.
    if (r.cs) row[9] = r.cs;
    if (r.type) row[10] = r.type;
    if (r.reg) row[11] = r.reg;
    if (r.cat) row[13] = r.cat;
    if (r.desc) row[16] = r.desc;
    if (r.owner) row[17] = r.owner;
    row[15] |= r.src;
    let flags = row[14] & ~(AF.ground | AF.mlat | AF.tisb);
    if (r.mil) flags |= AF.mil;
    if (r.ladd) flags |= AF.ladd;
    if (r.pia) flags |= AF.pia;
    if (newer || row[3] === r.posT) {
      const moved = newer;
      row[1] = r.lat; row[2] = r.lon; row[3] = r.posT;
      if (moved) row[19] = r.cadence;
      if (r.alt !== undefined) row[4] = r.alt;
      if (r.altGeom !== undefined) row[5] = r.altGeom;
      if (r.gs !== undefined) row[6] = r.gs;
      if (r.trk !== undefined && r.trk !== null) row[7] = r.trk;
      if (r.vr !== undefined) row[8] = r.vr;
      if (r.sq !== undefined) row[12] = r.sq ?? '';
      if (r.ground) flags |= AF.ground;
      if (r.mlat) flags |= AF.mlat;
      if (r.tisb) flags |= AF.tisb;
      // An emergency squawk counts once a second report confirms it, which
      // filters single garbled replies; the ADS-B emergency field is an
      // explicit declaration and counts at once.
      const emSq = EMERGENCY_SQUAWKS.has(row[12]);
      a.sqStreak = emSq ? a.sqStreak + (moved ? 1 : 0) : 0;
      const declared = !!r.emergency && r.emergency !== 'none';
      if ((emSq && a.sqStreak >= 2) || declared) {
        if (!(flags & AF.emergency)) row[18] = Math.round(now / 1000);
        flags |= AF.emergency;
      } else if (!emSq && !declared) {
        flags &= ~AF.emergency;
        row[18] = 0;
      }
      if (moved) this.addHistory(a, r);
    } else {
      flags |= row[14] & (AF.ground | AF.mlat | AF.tisb);
    }
    row[14] = flags;
    a.upd = now;
    // Keep a track for a couple of its source's report intervals.
    const life = Math.max(75, r.cadence * 2.5) * 1000;
    a.expires = Math.max(a.expires, r.posT * 1000 + life);
  }

  private addHistory(a: Aircraft, r: AircraftReport) {
    const h = a.hist;
    const last = h[h.length - 1];
    const p: HistoryPoint = { t: r.posT, lat: r.lat, lon: r.lon, alt: r.ground ? 0 : (r.alt ?? null), gs: r.gs ?? null };
    if (last) {
      const dt = p.t - last.t;
      if (dt < 4) return;
      // Reject a jump no aircraft could make (garbled position or a
      // duplicate address): faster than Mach 3 between two reports.
      const v = distance(last.lat, last.lon, p.lat, p.lon) / dt;
      if (v > 1000 && dt < 600) return;
    }
    h.push(p);
    const cutoff = p.t - HIST_MAX_AGE_S;
    let i = 0;
    while (i < h.length && h[i].t < cutoff) i++;
    if (i) h.splice(0, i);
    if (h.length > HIST_MAX_POINTS) h.splice(0, h.length - HIST_MAX_POINTS);
  }

  sweep(now = Date.now()) {
    for (const [hex, a] of this.map) {
      if (a.expires < now) {
        this.map.delete(hex);
        this.tomb.set(hex, now);
      }
    }
    for (const [hex, t] of this.tomb) if (now - t > 600_000) this.tomb.delete(hex);
  }

  delta(since: number, now = Date.now()): Delta<AircraftRow> {
    const full = !since || now - since > 540_000 || since < this.bootedAt;
    const rows: AircraftRow[] = [];
    for (const a of this.map.values()) if (full || a.upd > since) rows.push(a.row);
    const removed: string[] = [];
    if (!full) for (const [hex, t] of this.tomb) if (t > since) removed.push(hex);
    return { now, full, rows, removed };
  }
}

export interface ShipReport {
  mmsi: number;
  lat?: number;
  lon?: number;
  posT?: number;
  sog?: number | null;
  cog?: number | null;
  hdg?: number | null;
  nav?: number;
  rot?: number | null;
  name?: string;
  callsign?: string;
  imo?: number;
  type?: number;
  dest?: string;
  eta?: string;
  draught?: number | null;
  len?: number | null;
  beam?: number | null;
  src: number;
}

interface Ship { row: ShipRow; upd: number; hist: HistoryPoint[] }

export class SeaStore {
  private map = new Map<number, Ship>();
  /** Static data that arrived before any position. */
  private pending = new Map<number, ShipReport>();
  private tomb = new Map<number, number>();
  private bootedAt = Date.now();
  readonly lifeS = 30 * 60;

  get size() { return this.map.size; }
  values() { return [...this.map.values()].map((s) => s.row); }
  history(mmsi: number) { return this.map.get(mmsi)?.hist ?? []; }

  ingest(r: ShipReport, now = Date.now()) {
    let s = this.map.get(r.mmsi);
    const hasPos = r.lat !== undefined && r.lon !== undefined && r.posT !== undefined &&
      Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180;
    if (!s) {
      if (!hasPos) {
        this.pending.set(r.mmsi, { ...this.pending.get(r.mmsi), ...r });
        return;
      }
      s = {
        row: [r.mmsi, r.lat!, r.lon!, 0, null, null, null, 15, '', '', 0, 0, '', '', null, null, null, 0, null],
        upd: now, hist: [],
      };
      this.map.set(r.mmsi, s);
      this.tomb.delete(r.mmsi);
      const pend = this.pending.get(r.mmsi);
      if (pend) { this.pending.delete(r.mmsi); this.applyStatic(s.row, pend); }
    }
    const row = s.row;
    if (hasPos && r.posT! > row[3]) {
      row[1] = r.lat!; row[2] = r.lon!; row[3] = r.posT!;
      if (r.sog !== undefined) row[4] = r.sog;
      if (r.cog !== undefined) row[5] = r.cog;
      if (r.hdg !== undefined) row[6] = r.hdg;
      if (r.nav !== undefined) row[7] = r.nav;
      if (r.rot !== undefined) row[18] = r.rot;
      const h = s.hist, last = h[h.length - 1];
      if (!last || r.posT! - last.t >= 30) {
        h.push({ t: r.posT!, lat: r.lat!, lon: r.lon!, alt: null, gs: r.sog ?? null });
        if (h.length > 1500) h.splice(0, h.length - 1500);
      }
    }
    this.applyStatic(row, r);
    row[17] |= r.src;
    s.upd = now;
  }

  private applyStatic(row: ShipRow, r: ShipReport) {
    if (r.name) row[8] = r.name;
    if (r.callsign) row[9] = r.callsign;
    if (r.imo) row[10] = r.imo;
    if (r.type) row[11] = r.type;
    if (r.dest) row[12] = r.dest;
    if (r.eta) row[13] = r.eta;
    if (r.draught != null) row[14] = r.draught;
    if (r.len) row[15] = r.len;
    if (r.beam) row[16] = r.beam;
  }

  sweep(now = Date.now()) {
    for (const [k, s] of this.map) {
      if (now / 1000 - s.row[3] > this.lifeS) {
        this.map.delete(k);
        this.tomb.set(k, now);
      }
    }
    for (const [k, t] of this.tomb) if (now - t > 600_000) this.tomb.delete(k);
    if (this.pending.size > 50_000) this.pending.clear();
  }

  delta(since: number, now = Date.now()): Delta<ShipRow> {
    const full = !since || now - since > 540_000 || since < this.bootedAt;
    const rows: ShipRow[] = [];
    for (const s of this.map.values()) if (full || s.upd > since) rows.push(s.row);
    const removed: number[] = [];
    if (!full) for (const [k, t] of this.tomb) if (t > since) removed.push(k);
    return { now, full, rows, removed };
  }
}
