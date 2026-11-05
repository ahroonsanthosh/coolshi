// adsb.fi and adsb.lol: volunteer ADS-B networks that answer in readsb's
// JSON format. Rich records (type, registration, military flag) and fresh
// positions, but only by area ("within N nm of a point", N ≤ 250) or by
// category (military, a squawk), never the whole world at once.

import type { AircraftReport } from '../store.ts';

const KM_PER_NM = 1.852;

interface ReadsbAc {
  hex: string;
  type?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  ownOp?: string;
  dbFlags?: number;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  emergency?: string;
  category?: string;
  lat?: number;
  lon?: number;
  seen_pos?: number;
  mlat?: string[];
  tisb?: string[];
  lastPosition?: { lat: number; lon: number; seen_pos: number };
}

export function parseReadsb(json: any, src: number, cadence: number): AircraftReport[] {
  const list: ReadsbAc[] = json.ac ?? json.aircraft ?? [];
  let now: number = json.now ?? Date.now() / 1000;
  if (now > 1e11) now /= 1000; // adsb.lol sends ms, adsb.fi seconds
  const out: AircraftReport[] = [];
  for (const a of list) {
    if (a.lat === undefined || a.lon === undefined || a.seen_pos === undefined) continue;
    if (a.seen_pos > 60) continue; // too old to trust as "now"
    const hex = a.hex.toLowerCase();
    // Ground vehicles and fixed transmitters (tower beacons, ADS-B
    // equipped tugs and follow-me cars) are not traffic.
    const cat = a.category ?? '';
    if (cat.startsWith('C') || a.t === 'TWR' || a.t === 'GND') continue;
    const cs = (a.flight ?? '').trim();
    const ground = a.alt_baro === 'ground';
    const flags = a.dbFlags ?? 0;
    out.push({
      hex,
      lat: a.lat,
      lon: a.lon,
      posT: now - a.seen_pos,
      alt: ground ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : null,
      altGeom: typeof a.alt_geom === 'number' ? a.alt_geom : null,
      ground,
      gs: a.gs ?? null,
      trk: a.track ?? a.true_heading ?? null,
      vr: a.baro_rate ?? a.geom_rate ?? null,
      cs: /^[@ ]*$/.test(cs) ? '' : cs,
      type: a.t && a.t !== 'TWR' ? a.t : '',
      reg: a.r ?? '',
      desc: a.desc ?? '',
      owner: a.ownOp ?? '',
      sq: a.squawk ?? '',
      cat,
      mlat: (a.mlat?.includes('lat') ?? false) || a.type === 'mlat',
      tisb: (a.tisb?.includes('lat') ?? false) || (a.type?.startsWith('tisb') ?? false),
      mil: (flags & 1) === 1,
      pia: (flags & 4) === 4,
      ladd: (flags & 8) === 8,
      emergency: a.emergency,
      src,
      cadence,
    });
  }
  return out;
}

export const PROVIDERS = {
  adsbfi: {
    point: (lat: number, lon: number, nm: number) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${Math.round(nm)}`,
    mil: 'https://opendata.adsb.fi/api/v2/mil',
    sqk: (s: string) => `https://opendata.adsb.fi/api/v2/sqk/${s}`,
  },
  adsblol: {
    point: (lat: number, lon: number, nm: number) =>
      `https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${Math.round(nm)}`,
    mil: 'https://api.adsb.lol/v2/mil',
    sqk: (s: string) => `https://api.adsb.lol/v2/sqk/${s}`,
  },
  airplaneslive: {
    point: (lat: number, lon: number, nm: number) =>
      `https://api.airplanes.live/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${Math.round(nm)}`,
    mil: 'https://api.airplanes.live/v2/mil',
    sqk: (s: string) => `https://api.airplanes.live/v2/squawk/${s}`,
  },
  adsbone: {
    point: (lat: number, lon: number, nm: number) =>
      `https://api.adsb.one/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${Math.round(nm)}`,
    mil: 'https://api.adsb.one/v2/mil',
    sqk: (s: string) => `https://api.adsb.one/v2/sqk/${s}`,
  },
};
export type Provider = keyof typeof PROVIDERS;

export { KM_PER_NM };
