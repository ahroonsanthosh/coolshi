// The aggregator's picture: one record per aircraft (by ICAO 24-bit address)
// and per ship (by MMSI), merged from every feed. A report only moves a track
// if its position is newer than the one we hold, so a slow feed can never
// drag a track back to where it was a minute ago.

import { readFileSync } from 'node:fs';
import { AF, type AircraftRow, type HistoryPoint, type ShipRow, type Delta } from '../shared/protocol.ts';
import { distance } from '../shared/geo.ts';
import { Trail, turned } from './trail.ts';

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
  /** Position is only the rough area of the receivers hearing it. */
  approx?: boolean;
  /** Extra fields the aircraft broadcasts (air data, autopilot, wind). */
  ext?: Record<string, unknown>;
  src: number;
  /** Seconds this source normally takes between reports of one aircraft. */
  cadence: number;
}

/**
 * Change numbers. Every real change to a track takes the next number, and a
 * browser asks for what changed after the last number it saw, so nothing is
 * missed (two changes in the same millisecond, a clock stepping back) and
 * nothing unchanged is sent again. Numbers start from the boot time in
 * microseconds: a cursor from before a restart is always below them, and
 * gets everything.
 */
export class Changes<K> {
  seq = Date.now() * 1000;
  /** Cursors below this may have missed a removal no longer remembered. */
  private floor = this.seq;
  private tomb = new Map<K, [seq: number, t: number]>();
  next() { return ++this.seq; }
  removed(k: K, now: number) { this.tomb.set(k, [this.next(), now]); }
  revived(k: K) { this.tomb.delete(k); }
  prune(now: number, keepMs = 600_000) {
    for (const [k, [s, t]] of this.tomb) if (now - t > keepMs) { this.tomb.delete(k); if (s > this.floor) this.floor = s; }
  }
  /** Can a delta be built from this cursor, or must it be a full send? */
  valid(since: number) { return since >= this.floor && since <= this.seq; }
  removedSince(since: number): K[] {
    const out: K[] = [];
    for (const [k, [s]] of this.tomb) if (s > since) out.push(k);
    return out;
  }
}

/** [west, south, east, north]; may cross the antimeridian. */
export type Box = [number, number, number, number];
export function inBox(box: Box, lat: number, lon: number) {
  const [w, so, e, n] = box;
  return lat >= so && lat <= n && (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);
}

/** Did a report change anything a browser would see? */
function differs(a: unknown[], b: unknown[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

interface Aircraft {
  row: AircraftRow;
  upd: number; // change number of the last change
  expires: number; // server ms
  hist: Trail;
  sqStreak: number; // consecutive reports with an emergency squawk
  ext?: Record<string, unknown>;
  extT?: number;
}

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
// Track history. A point is kept when the track turns, climbs or descends,
// lands or takes off, or a minute has passed (five if it hasn't moved), so a
// straight cruise costs one point a minute however often it is reported.
const HIST_MAX_AGE_S = 12 * 3600;
const HIST_MAX_POINTS = 1000;
const SHIP_HIST_MAX_AGE_S = 6 * 3600;
const SHIP_HIST_MAX_POINTS = 400;

export interface IdentityLookup {
  get(hex: string): { reg: string; type: string; desc: string; owner: string; mil: boolean; pia: boolean; ladd: boolean } | null;
}

// ICAO address blocks states reserve for military aircraft, from the
// tar1090 database (wiedehopf); catches aircraft no database has flagged.
const MIL_RANGES: [number, number][] = (JSON.parse(readFileSync(new URL('../src/data/milranges.json', import.meta.url), 'utf8')) as [string, string][])
  .map(([a, b]) => [parseInt(a, 16), parseInt(b, 16)]);
export function inMilitaryBlock(hex: string): boolean {
  if (hex.length !== 6) return false;
  const n = parseInt(hex, 16);
  return MIL_RANGES.some(([a, b]) => n >= a && n <= b);
}

// Types only air forces fly (no civil variant shares the designator).
const MIL_ONLY_TYPES = new Set(['C17', 'K35R', 'K35E', 'KC46', 'A400', 'C5M', 'P8', 'P3', 'E3TF', 'E3CF', 'E6', 'R135', 'E8', 'C2', 'KC10',
  'V22', 'U2', 'Q4', 'B52', 'B1', 'B2', 'E2', 'P1', 'Y20', 'H47', 'H60', 'NH90', 'EUFI', 'F16', 'F15', 'F18', 'F35', 'F22', 'RFAL', 'TOR', 'HAWK', 'T38', 'A10']);

export class AirStore {
  private map = new Map<string, Aircraft>();
  /** Airframe database, consulted once per new aircraft. */
  identity: IdentityLookup | null = null;
  private changes = new Changes<string>();

  get size() { return this.map.size; }
  values() { return [...this.map.values()].map((a) => a.row); }
  get seq() { return this.changes.seq; }
  cursorValid(since: number) { return this.changes.valid(since); }
  get(hex: string) { return this.map.get(hex)?.row; }
  history(hex: string): HistoryPoint[] { return this.map.get(hex)?.hist.points() ?? []; }
  extras(hex: string) {
    const a = this.map.get(hex);
    return a?.ext ? { t: a.extT ?? 0, ...a.ext } : null;
  }
  /** Wind and temperature measured by aircraft in the last ten minutes. */
  winds(now = Date.now()): [number, number, number, number, number, number | null][] {
    const out: [number, number, number, number, number, number | null][] = [];
    for (const a of this.map.values()) {
      const e = a.ext;
      if (!e || typeof e.ws !== 'number' || typeof e.wd !== 'number') continue;
      if (now / 1000 - (a.extT ?? 0) > 600 || (a.row[4] ?? 0) < 5000) continue;
      if (a.row[14] & AF.approx) continue; // no real position to pin a wind to
      const oat = typeof e.oat === 'number' && e.oat >= -80 && e.oat <= 50 ? e.oat : null;
      out.push([+a.row[1].toFixed(3), +a.row[2].toFixed(3), a.row[4] ?? 0, e.ws, e.wd, oat]);
    }
    return out;
  }

  /** Airframe database fields, where no feed has filled them in. */
  private applyIdentity(row: AircraftRow) {
    const id = this.identity?.get(row[0]);
    if (!id) return;
    if (MIL_ONLY_TYPES.has(id.type)) row[14] |= AF.mil;
    if (!row[10]) row[10] = id.type;
    if (!row[11]) row[11] = id.reg;
    if (!row[16]) row[16] = id.desc;
    if (!row[17]) row[17] = id.owner;
    row[14] |= (id.mil ? AF.mil : 0) | (id.pia ? AF.pia : 0) | (id.ladd ? AF.ladd : 0);
  }

  /**
   * Fill in identity for aircraft first seen before the database loaded.
   * Browsers get the filled rows with each aircraft's next report, seconds
   * away for anything still being heard.
   */
  fillIdentity() {
    for (const a of this.map.values()) this.applyIdentity(a.row);
  }

  ingest(r: AircraftReport, now = Date.now()): void {
    if (!isFinite(r.lat) || !isFinite(r.lon) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) return;
    if (r.posT * 1000 > now + 5000) r.posT = now / 1000; // clock skew guard
    let a = this.map.get(r.hex);
    let created = false;
    if (!a) {
      a = {
        row: [r.hex, r.lat, r.lon, r.posT, null, null, null, null, null, '', '', '', '', '', 0, 0, '', '', 0, r.cadence, 0, 0, 0],
        upd: 0, expires: 0, hist: new Trail(HIST_MAX_POINTS, true), sqStreak: 0,
      };
      created = true;
      this.map.set(r.hex, a);
      this.changes.revived(r.hex);
      if (inMilitaryBlock(r.hex)) a.row[14] |= AF.mil;
      this.applyIdentity(a.row);
    }
    const row = a.row;
    const prev = created ? null : row.slice();
    const newer = r.posT > row[3] + 0.05;
    // Identity fields: take any non-empty value; databases behind adsb.fi and
    // adsb.lol know the type and registration, OpenSky doesn't send them.
    if (r.cs) row[9] = r.cs;
    if (r.type) row[10] = r.type;
    if (MIL_ONLY_TYPES.has(row[10])) row[14] |= AF.mil;
    if (r.reg) row[11] = r.reg;
    if (r.cat) row[13] = r.cat;
    if (r.desc) row[16] = r.desc;
    if (r.owner) row[17] = r.owner;
    row[15] |= r.src;
    let flags = row[14] & ~(AF.ground | AF.mlat | AF.tisb);
    if (r.mil) flags |= AF.mil;
    if (r.ladd) flags |= AF.ladd;
    if (r.pia) flags |= AF.pia;
    // A rough area never replaces a real position heard in the last five
    // minutes; a real position always replaces a rough one.
    if (r.approx && !(row[14] & AF.approx) && row[3] > 0 && r.posT - row[3] < 300 && !(row[14] & AF.est) && row[1] !== r.lat) {
      if (typeof r.alt === 'number') row[4] = r.alt;
      if (r.sq) row[12] = r.sq;
      row[14] = flags | (row[14] & (AF.ground | AF.mlat | AF.tisb));
      if (!prev || differs(prev, row)) a.upd = this.changes.next();
      return;
    }
    if (newer || row[3] === r.posT) flags = r.approx ? flags | AF.approx : flags & ~AF.approx;
    if (newer && (row[14] & AF.est)) {
      // Back in range: a real report replaces the estimate.
      flags &= ~AF.est;
      row[20] = row[21] = row[22] = 0;
      a.expires = 0;
    }
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
      if (moved && !r.approx) this.addHistory(a, r);
      if (r.ext) { a.ext = r.ext; a.extT = r.posT; }
    } else {
      flags |= row[14] & (AF.ground | AF.mlat | AF.tisb);
    }
    row[14] = flags;
    if (!prev || differs(prev, row)) a.upd = this.changes.next();
    // Keep a track for a couple of its source's report intervals.
    const life = Math.max(75, r.cadence * 2.5) * 1000;
    a.expires = Math.max(a.expires, r.posT * 1000 + life);
  }

  private addHistory(a: Aircraft, r: AircraftReport) {
    const h = a.hist;
    const last = h.last();
    const alt = r.ground ? 0 : (r.alt ?? null);
    const trk = a.row[7];
    if (last) {
      const dt = r.posT - last.t;
      if (dt < 4) return;
      // Reject a jump no aircraft could make (garbled position or a
      // duplicate address): faster than Mach 3 between two reports.
      const d = distance(last.lat, last.lon, r.lat, r.lon);
      if (d / dt > 1000 && dt < 600) return;
      const turn = trk !== null && h.lastTrk !== null && turned(trk, h.lastTrk) >= 5;
      const climb = alt !== null && last.alt !== null && (Math.abs(alt - last.alt) >= 500 || (alt === 0) !== (last.alt === 0));
      if (!turn && !climb && dt < (d < 30 ? 300 : 60)) return;
    }
    h.push(r.posT, r.lat, r.lon, alt, r.gs ?? null, trk);
    h.dropBefore(r.posT - HIST_MAX_AGE_S);
  }

  /**
   * Called for an aircraft about to drop out of coverage. Return the
   * destination and ETA to carry it on as an estimate, or null to let it go.
   */
  estimate: ((row: AircraftRow) => { lat: number; lon: number; eta: number } | null) | null = null;
  /** Called for aircraft that have gone quiet and may soon expire. */
  quiet: ((row: AircraftRow) => void) | null = null;

  sweep(now = Date.now()) {
    for (const [hex, a] of this.map) {
      const row = a.row;
      if (!(row[14] & AF.est) && now - row[3] * 1000 > 45_000 && a.expires - now < 240_000) this.quiet?.(row);
      if (a.expires >= now) continue;
      const est = !(row[14] & AF.est) ? this.estimate?.(row) : null;
      if (est) {
        row[14] |= AF.est;
        row[20] = est.lat; row[21] = est.lon; row[22] = est.eta;
        // Hold it until about 20 minutes out, when receivers near the
        // destination should be hearing it again.
        a.expires = Math.min(est.eta * 1000 - 1_200_000, now + 10 * 3_600_000);
        a.upd = this.changes.next();
        if (a.expires > now) continue;
      }
      this.map.delete(hex);
      this.changes.removed(hex, now);
    }
    this.changes.prune(now);
  }

  /**
   * What changed after `since`: everywhere, or only inside `box` (plus the
   * aircraft in `want` and every emergency, wherever they are). A cursor
   * that can't be trusted gets the whole world.
   */
  delta(since: number, box: Box | null = null, want: Set<string> | null = null, now = Date.now()): Delta<AircraftRow> {
    const c = this.changes;
    const full = !c.valid(since);
    const rows: AircraftRow[] = [];
    for (const [hex, a] of this.map) {
      if (!full && a.upd <= since) continue;
      const r = a.row;
      if (full || !box || inBox(box, r[1], r[2]) || want?.has(hex) || (r[14] & AF.emergency)) rows.push(r);
    }
    return { now, seq: c.seq, full, rows, removed: full ? [] : c.removedSince(since) };
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
  via?: string;
  flag?: string;
  src: number;
}

interface Ship { row: ShipRow; upd: number; hist: Trail }

export class SeaStore {
  private map = new Map<number, Ship>();
  /** Static data that arrived before any position. */
  private pending = new Map<number, ShipReport>();
  private changes = new Changes<number>();
  readonly lifeS = 30 * 60;

  get size() { return this.map.size; }
  values() { return [...this.map.values()].map((s) => s.row); }
  history(mmsi: number): HistoryPoint[] { return this.map.get(mmsi)?.hist.points() ?? []; }

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
        row: [r.mmsi, r.lat!, r.lon!, 0, null, null, null, 15, '', '', 0, 0, '', '', null, null, null, 0, null, '', ''],
        upd: 0, hist: new Trail(SHIP_HIST_MAX_POINTS, false),
      };
      this.map.set(r.mmsi, s);
      this.changes.revived(r.mmsi);
      const pend = this.pending.get(r.mmsi);
      if (pend) { this.pending.delete(r.mmsi); this.applyStatic(s.row, pend); }
    }
    const row = s.row;
    const prev = s.upd ? row.slice() : null;
    if (hasPos && r.posT! > row[3]) {
      row[1] = r.lat!; row[2] = r.lon!; row[3] = r.posT!;
      if (r.sog !== undefined) row[4] = r.sog;
      if (r.cog !== undefined) row[5] = r.cog;
      if (r.hdg !== undefined) row[6] = r.hdg;
      if (r.nav !== undefined) row[7] = r.nav;
      if (r.rot !== undefined) row[18] = r.rot;
      this.addHistory(s.hist, r.posT!, r.lat!, r.lon!, r.sog ?? null, row[5]);
    }
    this.applyStatic(row, r);
    row[17] |= r.src;
    if (!prev || differs(prev, row)) s.upd = this.changes.next();
  }

  /**
   * A point when the ship has gone a kilometre or turned, else every five
   * minutes: a moored ship reporting every few seconds costs 12 points an
   * hour, not 120. Six hours at most.
   */
  private addHistory(h: Trail, t: number, lat: number, lon: number, sog: number | null, cog: number | null) {
    const last = h.last();
    if (last) {
      const dt = t - last.t;
      if (dt < 30) return;
      const d = distance(last.lat, last.lon, lat, lon);
      // GPS wander at a berth is tens of metres and its course random.
      const turn = d >= 100 && cog !== null && h.lastTrk !== null && turned(cog, h.lastTrk) >= 10;
      if (d < 1000 && !turn && dt < 300) return;
    }
    h.push(t, lat, lon, null, sog, cog);
    h.dropBefore(t - SHIP_HIST_MAX_AGE_S);
  }

  private applyStatic(row: ShipRow, r: ShipReport) {
    if (r.name) row[8] = r.name;
    if (r.callsign) row[9] = r.callsign;
    if (r.imo) row[10] = r.imo;
    if (r.type) row[11] = r.type;
    if (r.dest) row[12] = r.dest;
    if (r.eta) row[13] = r.eta;
    if (r.draught != null) row[14] = r.draught;
    // AIS caps each hull dimension (511 m bow/stern, 63 m port/starboard)
    // and crews mistype them; no ship exceeds ~460 m by 70 m.
    if (r.len && r.len <= 460) row[15] = r.len;
    if (r.beam && r.beam <= 70) row[16] = r.beam;
    if (r.via) row[19] = r.via;
    if (r.flag) row[20] = r.flag;
  }

  sweep(now = Date.now()) {
    for (const [k, s] of this.map) {
      // A ship moored or at anchor stays where it was: keep it six hours.
      const r = s.row;
      const still = r[7] === 1 || r[7] === 5 || (r[4] !== null && r[4] < 0.5);
      if (now / 1000 - r[3] > (still ? 6 * 3600 : this.lifeS)) {
        this.map.delete(k);
        this.changes.removed(k, now);
      }
    }
    this.changes.prune(now);
    if (this.pending.size > 50_000) this.pending.clear();
  }

  /**
   * Ships inside a box ([west, south, east, north], may cross the
   * antimeridian), at most `cap` of them: the selected ship, then those under
   * way, then the largest. A world of ships is too much for one browser.
   */
  inView(box: Box | null, cap: number, want: Set<number> = new Set(), since = -1): ShipRow[] {
    const hit: ShipRow[] = [];
    for (const s of this.map.values()) {
      if (s.upd <= since) continue;
      const r = s.row;
      if (want.has(r[0]) || !box || inBox(box, r[1], r[2])) hit.push(r);
    }
    if (hit.length <= cap) return hit;
    const score = (r: ShipRow) => (want.has(r[0]) ? 1e9 : 0) + ((r[4] ?? 0) >= 1 ? 1e6 : 0) + (r[15] ?? 0);
    return hit.sort((a, b) => score(b) - score(a)).slice(0, cap);
  }

  /**
   * The ships a browser should have for its box: all of them (at most
   * `cap`) the first time or when the box changed, then only what changed
   * after its cursor, plus the ones it asked for by MMSI wherever they are.
   * The whole world (no box) is always sent whole: which ships make the
   * busiest few thousand keeps changing.
   */
  view(box: Box | null, cap: number, since: number, want: Set<number>, now = Date.now()): Delta<ShipRow> {
    const c = this.changes;
    if (!box || !c.valid(since)) return { now, seq: c.seq, full: true, rows: this.inView(box, cap, want), removed: [] };
    return { now, seq: c.seq, full: false, rows: this.inView(box, cap, want, since), removed: c.removedSince(since) };
  }

  stats() {
    let moving = 0;
    let largest: ShipRow | null = null;
    for (const s of this.map.values()) {
      const r = s.row;
      if ((r[4] ?? 0) >= 1 && r[7] !== 1 && r[7] !== 5) moving++;
      // Largest merchant ship, ignoring sizes no ship has (crews mistype them):
      // passenger, cargo or tanker, and within the 400 m of today's giants.
      const len = r[15] ?? 0, t = r[11];
      if (r[8] && t >= 60 && t <= 89 && len <= 400 && (r[16] ?? 0) <= 66 && len > (largest?.[15] ?? 0)) largest = r;
    }
    return {
      total: this.map.size, moving,
      largest: largest ? { name: largest[8], len: largest[15]!, type: largest[11], mmsi: largest[0], lat: largest[1], lon: largest[2] } : null,
    };
  }

  delta(since: number, now = Date.now()): Delta<ShipRow> {
    const c = this.changes;
    const full = !c.valid(since);
    const rows: ShipRow[] = [];
    for (const s of this.map.values()) if (full || s.upd > since) rows.push(s.row);
    return { now, seq: c.seq, full, rows, removed: full ? [] : c.removedSince(since) };
  }
}
