// Facts the live feeds don't carry, fetched for one selected track at a time
// and cached: the airframe (adsbdb), its photo (Planespotters), the route
// filed for its callsign (adsbdb), and a ship's entry on Wikidata.


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

import type { Airport, Route } from '../../shared/route.ts';
export { checkRoute, type Airport, type Route, type RouteCheck } from '../../shared/route.ts';

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
