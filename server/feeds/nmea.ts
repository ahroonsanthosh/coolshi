// A decoder for AIS radio messages as NMEA !xxVDM sentences (ITU-R M.1371):
// positions (types 1, 2, 3, 18, 19) and static data (5, 24). Enough to turn
// a raw coastal receiver stream into ship reports.

import type { ShipReport } from '../store.ts';
import { decodeRot } from './ships.ts';

class Bits {
  private b: Uint8Array;
  readonly length: number;
  constructor(payload: string, fill: number) {
    const out: number[] = [];
    for (const ch of payload) {
      let v = ch.charCodeAt(0) - 48;
      if (v > 40) v -= 8;
      for (let i = 5; i >= 0; i--) out.push((v >> i) & 1);
    }
    this.length = out.length - fill;
    this.b = Uint8Array.from(out.slice(0, this.length));
  }
  u(start: number, len: number): number {
    let v = 0;
    for (let i = start; i < start + len; i++) v = v * 2 + (i < this.length ? this.b[i] : 0);
    return v;
  }
  s(start: number, len: number): number {
    const v = this.u(start, len);
    return v >= 2 ** (len - 1) ? v - 2 ** len : v;
  }
  text(start: number, len: number): string {
    let s = '';
    for (let i = start; i + 6 <= start + len && i + 6 <= this.length; i += 6) {
      const c = this.u(i, 6);
      s += String.fromCharCode(c < 32 ? c + 64 : c);
    }
    return s.replace(/@.*$/, '').replace(/\s+/g, ' ').trim();
  }
}

/** A decoded message as a partial ship report (`type` is the ship type). */
export type AisMessage = Partial<ShipReport> & { mmsi: number; msgType: number };

function position(b: Bits, type: number): AisMessage | null {
  const mmsi = b.u(8, 30);
  const classB = type === 18 || type === 19;
  const sog = b.u(classB ? 46 : 50, 10);
  const lon = b.s(classB ? 57 : 61, 28) / 600000;
  const lat = b.s(classB ? 85 : 89, 27) / 600000;
  const cog = b.u(classB ? 112 : 116, 12);
  const hdg = b.u(classB ? 124 : 128, 9);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null; // 91/181 = not available
  const msg: AisMessage = {
    msgType: type, mmsi, lat, lon,
    sog: sog === 1023 ? null : sog / 10,
    cog: cog >= 3600 ? null : cog / 10,
    hdg: hdg >= 360 ? null : hdg,
    nav: classB ? 15 : b.u(38, 4),
    rot: classB ? null : decodeRot(b.s(42, 8)),
  };
  if (type === 19) {
    msg.name = b.text(143, 120);
    const st = b.u(263, 8);
    if (st) msg.type = st;
    const len = b.u(271, 9) + b.u(280, 9), beam = b.u(289, 6) + b.u(295, 6);
    if (len) msg.len = len;
    if (beam) msg.beam = beam;
  }
  return msg;
}

function pad(n: number) { return String(n).padStart(2, '0'); }

export function decodePayload(payload: string, fill: number): AisMessage | null {
  const b = new Bits(payload, fill);
  const type = b.u(0, 6);
  if (type === 1 || type === 2 || type === 3 || type === 18 || type === 19) return position(b, type);
  if (type === 5) {
    if (b.length < 420) return null;
    const month = b.u(274, 4), day = b.u(278, 5), hour = b.u(283, 5), minute = b.u(288, 6);
    const len = b.u(240, 9) + b.u(249, 9), beam = b.u(258, 6) + b.u(264, 6);
    return {
      msgType: type, mmsi: b.u(8, 30), imo: b.u(40, 30) || undefined, callsign: b.text(70, 42), name: b.text(112, 120),
      type: b.u(232, 8) || undefined, len: len || null, beam: beam || null,
      eta: month && day && month <= 12 && hour < 24 && minute < 60 ? `${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}` : '',
      draught: b.u(294, 8) ? b.u(294, 8) / 10 : null, dest: b.text(302, 120),
    };
  }
  if (type === 24) {
    const mmsi = b.u(8, 30);
    if (b.u(38, 2) === 0) return { msgType: type, mmsi, name: b.text(40, 120) };
    const len = b.u(132, 9) + b.u(141, 9), beam = b.u(150, 6) + b.u(156, 6);
    return { msgType: type, mmsi, type: b.u(40, 8) || undefined, callsign: b.text(90, 42), len: len || null, beam: beam || null };
  }
  return null;
}

/**
 * Feeds lines in, gets decoded messages out, joining multi-sentence messages.
 * Lines may carry an NMEA 4.0 tag block (`\c:<unix time>,...*hh\`) whose
 * receive time is used as the position time when present.
 */
export class NmeaAssembler {
  private parts = new Map<string, { n: number; got: string[]; t: number }>();

  push(line: string, now = Date.now() / 1000): (AisMessage & { t: number }) | null {
    let t = now;
    const tag = line.match(/^\\([^\\]*)\\/);
    if (tag) {
      const c = tag[1].match(/(?:^|,)c:(\d{9,13})/);
      if (c) t = Number(c[1]) > 1e11 ? Number(c[1]) / 1000 : Number(c[1]);
      line = line.slice(tag[0].length);
    }
    const m = line.trim().match(/^!..VD[MO],(\d),(\d),(\d*),([^,]*),([^,]*),(\d)\*[0-9A-F]{2}/i);
    if (!m) return null;
    const [, totalS, numS, seq, chan, payload, fillS] = m;
    const total = Number(totalS), num = Number(numS);
    if (t > now + 60 || t < now - 3600) t = now;
    if (total === 1) {
      const msg = decodePayload(payload, Number(fillS));
      return msg ? { ...msg, t } : null;
    }
    const key = `${seq}|${chan}`;
    let p = this.parts.get(key);
    if (!p || num === 1) { p = { n: total, got: [], t }; this.parts.set(key, p); }
    p.got[num - 1] = payload;
    if (num < total) return null;
    this.parts.delete(key);
    if (p.got.filter(Boolean).length !== total) return null;
    const msg = decodePayload(p.got.join(''), Number(fillS));
    if (this.parts.size > 500) this.parts.clear();
    return msg ? { ...msg, t: p.t } : null;
  }
}
