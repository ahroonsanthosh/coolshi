// The browser's copy of the picture, kept current by polling the aggregator
// for deltas. Positions are dead-reckoned between reports along great
// circles, and a new report never makes a track jump: the gap between where
// we drew it and where it really is closes over a second.

import { A, AF, S, type AircraftRow, type Delta, type ShipRow, type WorldPayload } from '../../shared/protocol.ts';
import { bearing, destination, KT } from '../../shared/geo.ts';
import { classify, type AcClass } from '../lib/aircraft.ts';
import { isStationary } from '../lib/ais.ts';

export interface Track {
  kind: 'air' | 'sea';
  id: string; // 'a:<hex>' or 's:<mmsi>'
  lat: number;
  lon: number;
  posT: number; // s
  speed: number | null; // kt over ground
  course: number | null; // deg true
  // Smoothing: offset (deg) from the dead-reckoned position that decays to 0.
  dLat: number;
  dLon: number;
  dT: number; // ms when the correction began
  // Last drawn position.
  x: number;
  y: number;
  /** How far ahead (s) we may carry it, and when it counts as stale. */
  maxDr: number;
  staleAfter: number;
  /** Estimated beyond coverage: carried along the great circle to here. */
  est?: [number, number] | null;
}

export interface Aircraft extends Track {
  kind: 'air';
  row: AircraftRow;
  cls: AcClass;
}
export interface Ship extends Track {
  kind: 'sea';
  row: ShipRow;
  still: boolean;
}

/** Server clock minus ours, so "seconds ago" is right on a skewed laptop. */
let skew = 0;
export const serverNow = () => Date.now() + skew;

const MAX_DR_SEA = 600;

/** Dead-reckoning budget from the feed's report interval: a fresh local
 *  receiver feed gets 45 s, a worldwide poll every few minutes a little more
 *  than its interval, so the track glides instead of freezing and jumping. */
function airBudget(cad: number) {
  if (!(cad > 0)) cad = 10;
  return { maxDr: Math.min(240, Math.max(45, cad * 1.25)), staleAfter: Math.max(60, cad * 1.7) };
}

/** Out of range on a verified route: steer for the destination until ETA. */
function applyEstimate(a: Aircraft) {
  const r = a.row;
  if (!(r[A.flags] & AF.est) || !r[A.estEta]) { a.est = null; return; }
  a.est = [r[A.estLat], r[A.estLon]];
  a.course = bearing(r[A.lat], r[A.lon], r[A.estLat], r[A.estLon]);
  a.maxDr = Math.max(0, r[A.estEta] - r[A.posT]);
  a.staleAfter = 1e9;
}
const SMOOTH_MS = 1200;

export class Picture {
  aircraft = new Map<string, Aircraft>();
  ships = new Map<string, Ship>();
  world: WorldPayload | null = null;
  listeners = new Set<(what: 'air' | 'sea' | 'world') => void>();
  private airSince = 0;
  private seaSince = 0;
  private clientId = Math.random().toString(36).slice(2, 10);
  view = { lat: 30, lon: 10, r: 5000 };
  connected = false;
  lastAirOk = 0;

  on(fn: (what: 'air' | 'sea' | 'world') => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(w: 'air' | 'sea' | 'world') {
    for (const fn of this.listeners) fn(w);
  }

  start() {
    const loop = (fn: () => Promise<void>, ms: () => number) => {
      const tick = async () => {
        try { await fn(); } catch (e) { console.warn(e); }
        setTimeout(tick, document.hidden ? Math.max(ms(), 10_000) : ms());
      };
      tick();
    };
    loop(() => this.pollAir(), () => 2000);
    loop(() => this.pollSea(), () => 8000);
    loop(() => this.pollWorld(), () => 30_000);
  }

  private async pollAir() {
    const vp = `${this.view.lat.toFixed(3)},${this.view.lon.toFixed(3)},${Math.round(this.view.r)}`;
    let res: Response;
    try {
      res = await fetch(`/api/air?since=${this.airSince}&c=${this.clientId}&vp=${vp}`);
    } catch {
      this.connected = false;
      return;
    }
    if (!res.ok) { this.connected = false; return; }
    const d = (await res.json()) as Delta<AircraftRow>;
    this.connected = true;
    this.lastAirOk = Date.now();
    skew = d.now - Date.now();
    const now = Date.now();
    if (d.full) {
      const keep = new Set(d.rows.map((r) => r[A.hex]));
      for (const k of this.aircraft.keys()) if (!keep.has(k.slice(2))) this.aircraft.delete(k);
    }
    for (const r of d.rows) this.upsertAir(r, now);
    for (const hex of d.removed) this.aircraft.delete(`a:${hex}`);
    this.airSince = d.now;
    this.emit('air');
  }

  private upsertAir(r: AircraftRow, now: number) {
    const id = `a:${r[A.hex]}`;
    const ground = (r[A.flags] & AF.ground) !== 0;
    let a = this.aircraft.get(id);
    if (!a) {
      a = {
        kind: 'air', id, row: r, cls: classify(r[A.type], r[A.cat], r[A.desc]),
        lat: r[A.lat], lon: r[A.lon], posT: r[A.posT], speed: null, course: null,
        dLat: 0, dLon: 0, dT: 0, x: r[A.lon], y: r[A.lat], ...airBudget(r[A.cad]),
      };
      this.aircraft.set(id, a);
    } else {
      // Where we are drawing it now vs where the new report puts it now.
      const before = [a.x, a.y];
      a.row = r;
      a.cls = classify(r[A.type], r[A.cat], r[A.desc]);
      a.lat = r[A.lat]; a.lon = r[A.lon]; a.posT = r[A.posT];
      a.speed = ground && (r[A.gs] ?? 0) < 3 ? 0 : r[A.gs];
      a.course = r[A.trk];
      Object.assign(a, airBudget(r[A.cad]));
      applyEstimate(a);
      const [nx, ny] = drPosition(a, now / 1000 + skew / 1000, a.maxDr);
      let dx = before[0] - nx;
      if (dx > 180) dx -= 360;
      if (dx < -180) dx += 360;
      const dy = before[1] - ny;
      // Only smooth small corrections; a big one is a real jump.
      if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) { a.dLon = dx; a.dLat = dy; a.dT = now; }
      else { a.dLon = 0; a.dLat = 0; }
      return;
    }
    a.speed = ground && (r[A.gs] ?? 0) < 3 ? 0 : r[A.gs];
    a.course = r[A.trk];
    applyEstimate(a);
  }

  private async pollSea() {
    const res = await fetch(`/api/sea?since=${this.seaSince}`).catch(() => null);
    if (!res?.ok) return;
    const d = (await res.json()) as Delta<ShipRow>;
    const now = Date.now();
    if (d.full) {
      const keep = new Set(d.rows.map((r) => String(r[S.mmsi])));
      for (const k of this.ships.keys()) if (!keep.has(k.slice(2))) this.ships.delete(k);
    }
    for (const r of d.rows) {
      const id = `s:${r[S.mmsi]}`;
      const sog = r[S.sog];
      const still = isStationary(r[S.nav], sog);
      // A course of 360 or a speed above 50 kt from a merchant ship is bad
      // data: draw it where it was reported, don't extrapolate.
      const plausible = sog !== null && sog < 50;
      let s = this.ships.get(id);
      const before = s ? [s.x, s.y] : null;
      if (!s) {
        s = {
          kind: 'sea', id, row: r, still, lat: r[S.lat], lon: r[S.lon], posT: r[S.posT], speed: null, course: null,
          dLat: 0, dLon: 0, dT: 0, x: r[S.lon], y: r[S.lat], maxDr: MAX_DR_SEA, staleAfter: 900,
        };
        this.ships.set(id, s);
      }
      s.row = r; s.still = still;
      s.lat = r[S.lat]; s.lon = r[S.lon]; s.posT = r[S.posT];
      s.speed = still || !plausible ? 0 : sog;
      s.course = r[S.cog] ?? r[S.hdg];
      if (before) {
        const [nx, ny] = drPosition(s, now / 1000 + skew / 1000, MAX_DR_SEA);
        const dx = before[0] - nx, dy = before[1] - ny;
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) { s.dLon = dx; s.dLat = dy; s.dT = now; }
      }
    }
    for (const m of d.removed) this.ships.delete(`s:${m}`);
    this.seaSince = d.now;
    this.emit('sea');
  }

  private async pollWorld() {
    const res = await fetch('/api/world').catch(() => null);
    if (!res?.ok) return;
    this.world = (await res.json()) as WorldPayload;
    this.emit('world');
  }

  /** Advance every track's drawn position to now. */
  advance(only?: (t: Track) => boolean) {
    const nowMs = Date.now();
    const nowS = (nowMs + skew) / 1000;
    const step = (t: Track) => {
      if (only && !only(t)) return;
      const [x, y] = drPosition(t, nowS, t.maxDr);
      const k = t.dT ? Math.max(0, 1 - (nowMs - t.dT) / SMOOTH_MS) : 0;
      const e = k * k * (3 - 2 * k); // smoothstep
      t.x = x + t.dLon * e;
      t.y = y + t.dLat * e;
      if (k === 0) t.dT = 0;
    };
    for (const a of this.aircraft.values()) step(a);
    for (const s of this.ships.values()) step(s);
  }

  get(id: string): Aircraft | Ship | undefined {
    return id.startsWith('a:') ? this.aircraft.get(id) : this.ships.get(id);
  }
}

export function drPosition(t: Track, nowS: number, maxS: number): [number, number] {
  if (!t.speed || t.course === null) return [t.lon, t.lat];
  const dt = Math.min(maxS, Math.max(0, nowS - t.posT));
  if (dt <= 0) return [t.lon, t.lat];
  const [lat, lon] = destination(t.lat, t.lon, t.course, t.speed * KT * dt);
  return [lon, lat];
}

export function isEstimated(t: Track): boolean {
  return !!t.est;
}

/** Seconds since the last position report. */
export function reportAge(t: Track): number {
  return serverNow() / 1000 - t.posT;
}

export const picture = new Picture();
