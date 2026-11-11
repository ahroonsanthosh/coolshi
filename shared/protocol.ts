// Wire format between the aggregator and the browser. Rows are positional
// arrays because a world picture is ~10,000 aircraft and keys would double it.

/** Aircraft row. Units: ft, kt, ft/min, degrees true, seconds since epoch. */
export const A = {
  hex: 0, lat: 1, lon: 2, posT: 3, alt: 4, altGeom: 5, gs: 6, trk: 7, vr: 8, cs: 9, type: 10, reg: 11,
  sq: 12, cat: 13, flags: 14, src: 15, desc: 16, owner: 17, emSince: 18, cad: 19, estLat: 20, estLon: 21, estEta: 22,
} as const;
/** Bit flags in A.flags */
export const AF = { ground: 1, mlat: 2, mil: 4, emergency: 8, tisb: 16, ladd: 32, pia: 64, est: 128, approx: 256 } as const;
/** Source bit flags */
export const SRC = { opensky: 1, adsbfi: 2, adsblol: 4, digitraffic: 8, aisstream: 16, airplaneslive: 32, kystverket: 64, adsbone: 128, openwaters: 256, local: 512 } as const;
export const SRC_NAMES: Record<number, string> = {
  1: 'OpenSky Network', 2: 'adsb.fi', 4: 'adsb.lol', 8: 'Fintraffic Digitraffic', 16: 'AISStream',
  32: 'airplanes.live', 64: 'Kystverket (Norway)', 128: 'adsb.one', 256: 'Open Waters AIS', 512: 'your own receiver',
};

export type AircraftRow = [
  hex: string, lat: number, lon: number, posT: number, alt: number | null, altGeom: number | null,
  gs: number | null, trk: number | null, vr: number | null, cs: string, type: string, reg: string,
  sq: string, cat: string, flags: number, src: number, desc: string, owner: string, emSince: number,
  /** Seconds between reports from the feed that sent the latest position. */
  cad: number,
  /** Estimated track (AF.est): destination it is carried towards, and ETA (s). */
  estLat: number, estLon: number, estEta: number,
];

/** Ship row. Units: kt, degrees true, metres, seconds since epoch. */
export const S = {
  mmsi: 0, lat: 1, lon: 2, posT: 3, sog: 4, cog: 5, hdg: 6, nav: 7, name: 8, callsign: 9, imo: 10, type: 11,
  dest: 12, eta: 13, draught: 14, len: 15, beam: 16, src: 17, rot: 18, via: 19, flag: 20,
} as const;
export type ShipRow = [
  mmsi: number, lat: number, lon: number, posT: number, sog: number | null, cog: number | null,
  hdg: number | null, nav: number, name: string, callsign: string, imo: number, type: number,
  dest: string, eta: string, draught: number | null, len: number | null, beam: number | null, src: number,
  rot: number | null,
  /** Upstream network that relayed it (for attribution), and ISO flag code. */
  via: string, flag: string,
];

export interface Delta<R> {
  now: number; // server ms
  /** Change cursor: send it back as `since` to get only what changed after
   * it. Starts from the server's boot time, so a restart forces a full send. */
  seq: number;
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
  id: string; name: string; kind: 'air' | 'sea' | 'event' | 'news'; ok: boolean; lastOk: number;
  lastError: string; note: string; count: number; interval: number;
}
export interface WorldPayload {
  now: number;
  quakes: Quake[];
  disasters: Disaster[];
  iss: { t: number; lat: number; lon: number; alt: number; vel: number }[];
  sources: SourceStatus[];
  /** Whole-world ship totals (the browser only receives ships in view). */
  ships: { total: number; moving: number; largest: { name: string; len: number; type: number; mmsi: number; lat: number; lon: number } | null };
}
export interface HistoryPoint { t: number; lat: number; lon: number; alt: number | null; gs: number | null }

export type NewsTopic = 'air' | 'sea' | 'world';
export interface NewsItem {
  id: string; topic: NewsTopic; source: string; title: string; link: string;
  /** Published, ms (or when first heard, if the feed gives no date). */
  time: number;
  summary: string; image: string;
  /** Where the headline says it happened, when a place could be matched. */
  place: { name: string; lat: number; lon: number; kind: 'city' | 'country' } | null;
  /** Crash, collision, sinking, emergency and the like. */
  severe: boolean;
}
export interface NewsPayload { now: number; items: NewsItem[]; feeds: SourceStatus[] }

/** A two-line element set, propagated in the browser with SGP4. */
export interface SatTle {
  norad: number; name: string; l1: string; l2: string;
  group: 'station' | 'bright';
  kind: 'station' | 'crew' | 'cargo' | 'module' | 'telescope' | 'satellite';
}
export interface Launch {
  id: string; name: string; net: number; status: string; statusName: string; provider: string; rocket: string;
  mission: string; missionType: string; orbit: string; description: string; pad: string; location: string;
  lat: number; lon: number; image: string; crewed: boolean; webcast: boolean;
}
export interface SpacePayload { now: number; sats: SatTle[]; launches: Launch[] }

/**
 * Weather observed at a station (METAR), compact for the wire.
 * [station, lat, lon, observed (unix s), temp °C, dew point °C,
 *  wind from ° true (-1 variable), wind kt, gust kt, visibility statute mi,
 *  present weather (METAR codes, e.g. "-RA BR")]
 */
export type WxRow = [
  string, number, number, number, number | null, number | null,
  number | null, number | null, number | null, number | null, string,
];
export const WX = { id: 0, lat: 1, lon: 2, t: 3, temp: 4, dew: 5, wdir: 6, wspd: 7, gust: 8, vis: 9, wx: 10 } as const;
export interface WeatherPayload {
  /** When the server last fetched the station file, ms. */
  at: number;
  stations: WxRow[];
  /** The newest global infrared cloud image (ms), or null if unknown. */
  clouds: number | null;
}

/** A SIGMET: a warning to aircraft of weather dangerous to all of them,
 * valid for an area, a band of levels and a few hours. */
export interface Hazard {
  id: string;
  kind: 'storm' | 'turb' | 'ice' | 'ash' | 'cyclone' | 'wave' | 'dust' | 'other';
  /** In words: "severe turbulence", "embedded thunderstorms". */
  label: string;
  /** Who issued it: flight information region, or the US desk. */
  area: string;
  from: number; to: number;
  /** Feet; null base is the surface, null top no stated limit. */
  base: number | null; top: number | null;
  raw: string;
  /** Outer rings, [lon, lat]. */
  rings: [number, number][][];
}
export interface HazardPayload { at: number; items: Hazard[] }

/** Replay: snapshots of every track, kept on the server for a few hours. */
export interface ReplayIndex { step: number; frames: number[] }
/** One snapshot. Aircraft: [hex, lat, lon, alt ft | null, track ° | null, flags].
 * Ships: [mmsi, lat, lon, course ° | null, moving 0/1]. */
export interface ReplayFrame {
  t: number;
  air: [string, number, number, number | null, number | null, number][];
  sea: [number, number, number, number | null, number][];
}
