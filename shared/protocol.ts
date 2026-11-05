// Wire format between the aggregator and the browser. Rows are positional
// arrays because a world picture is ~10,000 aircraft and keys would double it.

/** Aircraft row. Units: ft, kt, ft/min, degrees true, seconds since epoch. */
export const A = {
  hex: 0, lat: 1, lon: 2, posT: 3, alt: 4, altGeom: 5, gs: 6, trk: 7, vr: 8, cs: 9, type: 10, reg: 11,
  sq: 12, cat: 13, flags: 14, src: 15, desc: 16, owner: 17, emSince: 18, cad: 19,
} as const;
/** Bit flags in A.flags */
export const AF = { ground: 1, mlat: 2, mil: 4, emergency: 8, tisb: 16, ladd: 32, pia: 64 } as const;
/** Source bit flags */
export const SRC = { opensky: 1, adsbfi: 2, adsblol: 4, digitraffic: 8, aisstream: 16, airplaneslive: 32, kystverket: 64 } as const;
export const SRC_NAMES: Record<number, string> = {
  1: 'OpenSky Network', 2: 'adsb.fi', 4: 'adsb.lol', 8: 'Fintraffic Digitraffic', 16: 'AISStream',
  32: 'airplanes.live', 64: 'Kystverket (Norway)',
};

export type AircraftRow = [
  hex: string, lat: number, lon: number, posT: number, alt: number | null, altGeom: number | null,
  gs: number | null, trk: number | null, vr: number | null, cs: string, type: string, reg: string,
  sq: string, cat: string, flags: number, src: number, desc: string, owner: string, emSince: number,
  /** Seconds between reports from the feed that sent the latest position. */
  cad: number,
];

/** Ship row. Units: kt, degrees true, metres, seconds since epoch. */
export const S = {
  mmsi: 0, lat: 1, lon: 2, posT: 3, sog: 4, cog: 5, hdg: 6, nav: 7, name: 8, callsign: 9, imo: 10, type: 11,
  dest: 12, eta: 13, draught: 14, len: 15, beam: 16, src: 17, rot: 18,
} as const;
export type ShipRow = [
  mmsi: number, lat: number, lon: number, posT: number, sog: number | null, cog: number | null,
  hdg: number | null, nav: number, name: string, callsign: string, imo: number, type: number,
  dest: string, eta: string, draught: number | null, len: number | null, beam: number | null, src: number,
  rot: number | null,
];

export interface Delta<R> {
  now: number; // server ms
  full: boolean;
  rows: R[];
  removed: (string | number)[];
}

export interface Quake {
  id: string; mag: number; magType: string; place: string; time: number; lat: number; lon: number;
  depth: number; felt: number | null; tsunami: boolean; alert: string | null; sig: number; url: string;
}
export interface Disaster {
  id: string; type: string; name: string; alert: 'Green' | 'Orange' | 'Red'; country: string;
  lat: number; lon: number; from: number; to: number; severity: string; url: string;
}
export interface SourceStatus {
  id: string; name: string; kind: 'air' | 'sea' | 'event'; ok: boolean; lastOk: number;
  lastError: string; note: string; count: number; interval: number;
}
export interface WorldPayload {
  now: number;
  quakes: Quake[];
  disasters: Disaster[];
  iss: { t: number; lat: number; lon: number; alt: number; vel: number }[];
  sources: SourceStatus[];
}
export interface HistoryPoint { t: number; lat: number; lon: number; alt: number | null; gs: number | null }
