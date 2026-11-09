// Spacecraft and launches. Orbits come from CelesTrak as two-line element
// sets (the space stations and the visiting crew and cargo vehicles, plus the
// hundred-odd satellites bright enough to see); the browser propagates them
// with SGP4, so positions are computed, not fetched. Upcoming launches, with
// their pads, come from The Space Devs' free Launch Library 2.

import type { Launch, SatTle } from '../../shared/protocol.ts';
import { getJson, Status, UA } from './http.ts';

const GROUPS: [string, SatTle['group']][] = [['stations', 'station'], ['visual', 'bright']];

/** Crewed stations, crew ships and cargo ships, by name. */
export function satKind(name: string, group: SatTle['group']): SatTle['kind'] {
  const n = name.toUpperCase();
  if (/^ISS \(ZARYA\)|^CSS \(TIANHE\)|TIANGONG/.test(n)) return 'station';
  if (/CREW DRAGON|DRAGON (ENDURANCE|RESILIENCE|ENDEAVOUR|FREEDOM|GRACE)|SOYUZ-MS|SHENZHOU|STARLINER|ORION/.test(n)) return 'crew';
  if (/PROGRESS-MS|CYGNUS|TIANZHOU|HTV|CRS-|DREAM CHASER|DRAGON/.test(n)) return 'cargo';
  if (/HST|HUBBLE/.test(n)) return 'telescope';
  if (group === 'station') return 'module';
  return 'satellite';
}

/** Three-line TLE text → element sets. */
export function parseTle(text: string, group: SatTle['group']): SatTle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out: SatTle[] = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const [a, b, c] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!b?.startsWith('1 ') || !c?.startsWith('2 ')) continue;
    const name = a.replace(/^0 /, '').trim();
    const norad = Number(b.slice(2, 7));
    if (!norad) continue;
    out.push({ norad, name, l1: b, l2: c, group, kind: satKind(name, group) });
    i += 2;
  }
  return out;
}

export class Spacecraft {
  status = new Status('celestrak', 'CelesTrak orbits', 'event', 6 * 3600);
  sats: SatTle[] = [];

  async poll(): Promise<number> {
    const got = new Map<number, SatTle>();
    let err: unknown = null;
    for (const [g, group] of GROUPS) {
      try {
        const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        for (const s of parseTle(await res.text(), group)) if (!got.has(s.norad)) got.set(s.norad, s);
      } catch (e) { err = e; }
    }
    if (got.size) {
      this.sats = [...got.values()];
      const crewed = this.sats.filter((s) => s.kind === 'station' || s.kind === 'crew').length;
      this.status.success(this.sats.length, `${crewed} stations and crew ships, ${this.sats.length} objects, orbits propagated in your browser`);
      return 6 * 3600;
    }
    this.status.fail(err ?? new Error('no elements'), 'retrying; the ISS still comes from wheretheiss.at');
    return 1800;
  }
}

export class Launches {
  status = new Status('ll2', 'Launch Library 2', 'event', 1800);
  launches: Launch[] = [];

  // The free tier allows 15 requests an hour; one every half hour is plenty.
  async poll(): Promise<number> {
    try {
      const { data } = await getJson<any>('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?format=json&limit=12&hide_recent_previous=true', {}, 30_000);
      const out: Launch[] = [];
      for (const l of data.results ?? []) {
        const lat = Number(l.pad?.latitude), lon = Number(l.pad?.longitude);
        const net = Date.parse(l.net);
        if (!isFinite(lat) || !isFinite(lon) || !isFinite(net)) continue;
        out.push({
          id: String(l.id), name: l.name ?? '', net, status: l.status?.abbrev ?? '', statusName: l.status?.name ?? '',
          provider: l.launch_service_provider?.name ?? '', rocket: l.rocket?.configuration?.full_name ?? l.rocket?.configuration?.name ?? '',
          mission: l.mission?.name ?? '', missionType: l.mission?.type ?? '', orbit: l.mission?.orbit?.name ?? '',
          description: String(l.mission?.description ?? '').slice(0, 600),
          pad: l.pad?.name ?? '', location: l.pad?.location?.name ?? '', lat, lon,
          image: typeof l.image === 'string' && l.image.startsWith('https:') ? l.image : '',
          crewed: /crew|human/i.test(`${l.mission?.type ?? ''} ${l.name ?? ''}`),
          webcast: !!l.webcast_live,
        });
      }
      this.launches = out;
      this.status.success(out.length, 'upcoming launches worldwide');
      return 1800;
    } catch (e) {
      this.status.fail(e);
      return 1800;
    }
  }
}
