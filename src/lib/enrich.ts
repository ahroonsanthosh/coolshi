// Facts the live feeds don't carry, fetched for one selected track at a time
// and cached: the airframe (adsbdb), its photo (Planespotters), the route
// filed for its callsign (adsbdb), and a ship's entry on Wikidata.

import { crossAlong, distance, bearing } from '../../shared/geo.ts';

const cache = new Map<string, Promise<any>>();
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, fn().catch(() => null));
  return cache.get(key)!;
}

async function json(url: string, timeout = 9000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export interface Airframe {
  type: string; icaoType: string; manufacturer: string; registration: string; owner: string; ownerCountry: string;
  photo: string | null;
}
export function airframe(hex: string): Promise<Airframe | null> {
  return once(`af:${hex}`, async () => {
    const j = await json(`https://api.adsbdb.com/v0/aircraft/${hex}`);
    const a = j?.response?.aircraft;
    if (!a || typeof a !== 'object') return null;
    return {
      type: a.type ?? '', icaoType: a.icao_type ?? '', manufacturer: a.manufacturer ?? '', registration: a.registration ?? '',
      owner: a.registered_owner ?? '', ownerCountry: a.registered_owner_country_name ?? '', photo: a.url_photo ?? null,
    };
  });
}

export interface Photo { src: string; link: string; credit: string }
export function aircraftPhoto(hex: string, reg: string): Promise<Photo | null> {
  return once(`ph:${hex}`, async () => {
    const pick = (j: any): Photo | null => {
      const p = j?.photos?.[0];
      if (!p) return null;
      return { src: p.thumbnail_large?.src ?? p.thumbnail?.src, link: p.link, credit: `© ${p.photographer} · Planespotters.net` };
    };
    let p = pick(await json(`https://api.planespotters.net/pub/photos/hex/${hex}`));
    if (!p && reg) p = pick(await json(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`));
    return p;
  });
}

export interface Airport { icao: string; iata: string; name: string; city: string; country: string; lat: number; lon: number }
export interface Route { airline: string; airlineCountry: string; from: Airport; to: Airport; callsignIata: string }

export function route(callsign: string): Promise<Route | null> {
  return once(`rt:${callsign}`, async () => {
    const j = await json(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`);
    const r = j?.response?.flightroute;
    if (!r?.origin || !r?.destination) return null;
    const ap = (a: any): Airport => ({
      icao: a.icao_code, iata: a.iata_code, name: a.name, city: a.municipality, country: a.country_name,
      lat: a.latitude, lon: a.longitude,
    });
    return {
      airline: r.airline?.name ?? '', airlineCountry: r.airline?.country ?? '', callsignIata: r.callsign_iata ?? '',
      from: ap(r.origin), to: ap(r.destination),
    };
  });
}

export function airline(callsign: string): Promise<string> {
  const icao = callsign.slice(0, 3);
  if (!/^[A-Z]{3}\d/.test(callsign)) return Promise.resolve('');
  return once(`al:${icao}`, async () => {
    const j = await json(`https://api.adsbdb.com/v0/airline/${icao}`);
    const a = Array.isArray(j?.response) ? j.response[0] : null;
    return a?.name ?? '';
  });
}

export type RouteCheck =
  | { ok: true; progress: number; flown: number; remaining: number; total: number }
  | { ok: false; reason: string };

/**
 * Route databases map a callsign to the route it usually flies, and are
 * wrong often enough (seasonal changes, reused callsigns, diversions) that we
 * check the aircraft is actually on it before showing it.
 */
export function checkRoute(r: Route, lat: number, lon: number, trk: number | null, ground: boolean): RouteCheck {
  const total = distance(r.from.lat, r.from.lon, r.to.lat, r.to.lon);
  if (total < 20_000) return { ok: false, reason: 'origin and destination are the same airport' };
  const toOrigin = distance(lat, lon, r.from.lat, r.from.lon);
  const toDest = distance(lat, lon, r.to.lat, r.to.lon);
  if (ground) {
    if (toOrigin < 15_000) return { ok: true, progress: 0, flown: 0, remaining: total, total };
    if (toDest < 15_000) return { ok: true, progress: 1, flown: total, remaining: 0, total };
    return { ok: false, reason: 'on the ground away from both airports on file' };
  }
  const { xt, at } = crossAlong(r.from.lat, r.from.lon, r.to.lat, r.to.lon, lat, lon);
  const tol = Math.max(90_000, Math.min(400_000, total * 0.12));
  if (Math.abs(xt) > tol || at < -60_000 || at > total + 60_000) {
    return { ok: false, reason: `${Math.round(Math.abs(xt) / 1000)} km off the line between the airports on file` };
  }
  // Heading away from the destination, far from both ends, is a different flight.
  if (trk !== null && toDest > 200_000 && toOrigin > 200_000) {
    const want = bearing(lat, lon, r.to.lat, r.to.lon);
    const diff = Math.abs(((trk - want + 540) % 360) - 180);
    if (diff > 100) return { ok: false, reason: 'flying away from the destination on file' };
  }
  const flown = Math.max(0, Math.min(total, at));
  return { ok: true, progress: flown / total, flown, remaining: toDest, total };
}

export interface ShipFacts { label: string; image: string | null; operator: string; year: string; tonnage: string; klass: string; link: string }
export function shipFacts(imo: number): Promise<ShipFacts | null> {
  if (!imo || imo < 1000000) return Promise.resolve(null);
  return once(`wd:${imo}`, async () => {
    const q = `SELECT ?item ?itemLabel ?image ?opLabel ?inception ?gt ?classLabel WHERE {
      ?item wdt:P458 "${imo}".
      OPTIONAL { ?item wdt:P18 ?image }
      OPTIONAL { ?item wdt:P137 ?op }
      OPTIONAL { ?item wdt:P571 ?inception }
      OPTIONAL { ?item wdt:P1093 ?gt }
      OPTIONAL { ?item wdt:P289 ?class }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 1`;
    const j = await json(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, 12000);
    const b = j?.results?.bindings?.[0];
    if (!b) return null;
    const img = b.image?.value as string | undefined;
    return {
      label: b.itemLabel?.value ?? '',
      image: img ? img.replace(/^http:/, 'https:') + '?width=760' : null,
      operator: b.opLabel?.value ?? '',
      year: b.inception?.value ? b.inception.value.slice(0, 4) : '',
      tonnage: b.gt?.value ?? '',
      klass: b.classLabel?.value ?? '',
      link: b.item?.value ?? '',
    };
  });
}
