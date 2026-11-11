// Replay: one snapshot a minute of every aircraft and every ship under way,
// kept for a couple of hours in typed arrays (about 18 bytes an aircraft
// and 17 a ship), so a viewer can scrub back through the recent past.

import { A, AF, S, type AircraftRow, type ReplayFrame, type ReplayIndex, type ShipRow } from '../shared/protocol.ts';

const STEP_S = 60;
const KEEP_S = Math.max(1, Number(process.env.REPLAY_HOURS) || 2) * 3600;
const NO_ALT = -2147483648;
const MAX_SHIPS = 25_000;

interface Frame {
  t: number;
  /** ICAO address as a number; bit 24 marks a non-ICAO (~) address. */
  hex: Uint32Array; alat: Int32Array; alon: Int32Array; alt: Int32Array; trk: Int16Array; flags: Uint16Array;
  mmsi: Uint32Array; slat: Int32Array; slon: Int32Array; cog: Int16Array;
}

const q = (deg: number) => Math.round(deg * 1e5);
const dq = (v: number) => v / 1e5;

export function packHex(hex: string): number {
  const tilde = hex.startsWith('~');
  return (parseInt(tilde ? hex.slice(1) : hex, 16) & 0xffffff) | (tilde ? 0x1000000 : 0);
}
export function unpackHex(n: number): string {
  const h = (n & 0xffffff).toString(16).padStart(6, '0');
  return n & 0x1000000 ? `~${h}` : h;
}

export class Replay {
  frames: Frame[] = [];

  /** Take a snapshot now. Estimated and approximate positions are left out:
   * replay shows only where things reported being. */
  snapshot(air: Iterable<AircraftRow>, sea: Iterable<ShipRow>, now = Date.now()) {
    const a: AircraftRow[] = [];
    for (const r of air) if (!(r[A.flags] & (AF.est | AF.approx)) && now / 1000 - r[A.posT] < 120) a.push(r);
    const s: ShipRow[] = [];
    for (const r of sea) if ((r[S.sog] ?? 0) >= 1 && now / 1000 - r[S.posT] < 900 && s.length < MAX_SHIPS) s.push(r);
    const f: Frame = {
      t: now,
      hex: new Uint32Array(a.length), alat: new Int32Array(a.length), alon: new Int32Array(a.length),
      alt: new Int32Array(a.length), trk: new Int16Array(a.length), flags: new Uint16Array(a.length),
      mmsi: new Uint32Array(s.length), slat: new Int32Array(s.length), slon: new Int32Array(s.length), cog: new Int16Array(s.length),
    };
    a.forEach((r, i) => {
      f.hex[i] = packHex(r[A.hex]); f.alat[i] = q(r[A.lat]); f.alon[i] = q(r[A.lon]);
      f.alt[i] = r[A.alt] ?? NO_ALT; f.trk[i] = r[A.trk] === null ? -1 : Math.round(r[A.trk]!); f.flags[i] = r[A.flags];
    });
    s.forEach((r, i) => {
      f.mmsi[i] = r[S.mmsi]; f.slat[i] = q(r[S.lat]); f.slon[i] = q(r[S.lon]);
      const c = r[S.cog] ?? r[S.hdg];
      f.cog[i] = c === null ? -1 : Math.round(c);
    });
    this.frames.push(f);
    while (this.frames.length && now - this.frames[0].t > KEEP_S * 1000) this.frames.shift();
  }

  index(): ReplayIndex {
    return { step: STEP_S, frames: this.frames.map((f) => f.t) };
  }

  /** The snapshot taken at `t` (or the nearest), within a box if given. */
  frame(t: number, box: [number, number, number, number] | null): ReplayFrame | null {
    if (!this.frames.length) return null;
    let f = this.frames[0];
    for (const g of this.frames) if (Math.abs(g.t - t) < Math.abs(f.t - t)) f = g;
    const [w, so, e, n] = box ?? [-180, -90, 180, 90];
    const inside = (lat: number, lon: number) => lat >= so && lat <= n && (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);
    const air: ReplayFrame['air'] = [];
    for (let i = 0; i < f.hex.length; i++) {
      const lat = dq(f.alat[i]), lon = dq(f.alon[i]);
      if (!inside(lat, lon)) continue;
      air.push([unpackHex(f.hex[i]), lat, lon, f.alt[i] === NO_ALT ? null : f.alt[i], f.trk[i] < 0 ? null : f.trk[i], f.flags[i]]);
    }
    const sea: ReplayFrame['sea'] = [];
    for (let i = 0; i < f.mmsi.length; i++) {
      const lat = dq(f.slat[i]), lon = dq(f.slon[i]);
      if (!inside(lat, lon)) continue;
      sea.push([f.mmsi[i], lat, lon, f.cog[i] < 0 ? null : f.cog[i], 1]);
    }
    return { t: f.t, air, sea };
  }

  get bytes() {
    let b = 0;
    for (const f of this.frames) b += f.hex.byteLength * 4.5 + f.mmsi.byteLength * 3.5;
    return b;
  }
}

export const REPLAY_STEP_S = STEP_S;
