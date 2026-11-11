// What each ADS-B network is asked next. Four lanes (adsb.fi, adsb.lol,
// airplanes.live, adsb.one), each paced by a token bucket to under its
// published limit. Two kinds of work share a lane:
//
// - foreground: emergency squawks, military lists, LADD/PIA lists, and the
//   areas people are looking at (round-robin between viewers);
// - background: the worldwide circle sweep and worldwide queries by type.
//
// Background is guaranteed 40% of every lane when both want it, and takes
// whatever foreground leaves. When the background asks for more than its
// share can carry, its cadences stretch evenly instead of piling up a
// backlog. A 429 halves the lane's rate (recovering over ten minutes) and
// stops it for as long as Retry-After says, doubling while 429s repeat.

import { PROVIDERS, type Provider } from './feeds/readsb.ts';
import type { SweepPoint } from './grid.ts';
import { TokenBucket } from './pacing.ts';
import type { View, ViewRegistry } from './views.ts';

/**
 * Requests a second per lane. adsb.fi, airplanes.live and adsb.one publish
 * one a second; we stay under it (adsb.one, archived upstream in 2026,
 * further). adsb.lol's limits are "dynamic, based on load": one every 4 s.
 */
export const LANE_RATES: Record<Provider, number> = { adsbfi: 0.85, airplaneslive: 0.85, adsbone: 0.66, adsblol: 0.25 };
export const BG_SHARE = 0.4;
const MAX_IN_FLIGHT = 2;
const VIEW_MS = 5000;
const MAX_STRETCH = 8;

// Worldwide by aircraft type: one request returns every aircraft of that type
// a network can hear, anywhere, so the most common sixty types cover most
// airline traffic in a fraction of the requests a circle sweep needs.
export const CIVIL_TYPES = 60;
const CIVIL_MS = 150_000;
// Military types worth asking for by name, worldwide: tankers, transports,
// patrol, surveillance and command aircraft, and helicopters, many of which
// fly without a callsign a database would recognise. Rarely airborne in
// numbers, so asked for a quarter as often.
export const MIL_TYPES = ['C17', 'K35R', 'K35E', 'KC46', 'C30J', 'C130', 'A400', 'C5M', 'P8', 'P3', 'E3TF', 'E3CF', 'E6', 'R135', 'E8', 'C2', 'KC10',
  'MRTT', 'A310', 'C295', 'CN35', 'C27J', 'H60', 'H47', 'V22', 'UH1', 'EC45', 'NH90', 'U2', 'Q4', 'B52', 'C40', 'C32', 'E2', 'P1', 'Y20', 'IL76',
  // Fast jets, bombers and jet trainers: rarely broadcast, but when one does
  // (ferry flights, airshows, transits with a tanker) these find it.
  'F16', 'F15', 'F18', 'F18S', 'F35', 'F22', 'F5', 'B1', 'B2', 'EUFI', 'RFAL', 'TOR', 'JAS39', 'HAWK', 'M346', 'T38', 'T45', 'TEX2',
  'A10', 'AJET', 'L39', 'FA50', 'T50', 'PC21', 'K8', 'E7WT', 'E737', 'C135', 'KC2',
  // Large drones: Reapers, Global Hawks and Tritons often broadcast on transit.
  'Q9', 'Q1', 'Q25', 'HRON'];
const MIL_MS = 600_000;
const MIL_SET = new Set(MIL_TYPES);
const SEED_TYPES = ['B738', 'A320', 'A20N', 'A21N', 'A321', 'B38M', 'B739', 'A319', 'B789', 'B77W', 'A359', 'B763', 'B788', 'A333', 'E75L', 'CRJ9',
  'B737', 'B752', 'DH8D', 'AT76', 'E190', 'A332', 'B772', 'B744', 'B748', 'A388', 'CRJ7', 'E195', 'BCS3', 'B39M', 'C172', 'PC12', 'C208', 'B350',
  'AT72', 'AT75', 'E145', 'CRJ2', 'E170', 'B734', 'B753', 'B78X', 'A35K', 'A339', 'C56X', 'CL35', 'GLF5', 'GLEX'];
const SQUAWKS = ['7700', '7600', '7500'];

export interface Job {
  key: string;
  lane: Provider;
  url: string;
  /** Seconds this kind of report normally takes to come round again (for the store). */
  cadence: number;
  /** ms between runs, as scheduled when it started. */
  interval: number;
  bg: boolean;
  view?: View;
}

export class Lane {
  readonly id: Provider;
  readonly base: number;
  readonly bucket: TokenBucket;
  readonly hasType: boolean;
  backoffUntil = 0;
  inFlight = 0;
  /** Background's claim on the next request: +0.4 a request, −1 when used. */
  credit = 0;
  refused = 0;
  private mul = 1;
  private struckAt = -Infinity;
  private strikes = 0;

  constructor(id: Provider, base: number, now = Date.now()) {
    this.id = id;
    this.base = base;
    this.bucket = new TokenBucket(base, 1, now);
    this.hasType = !!PROVIDERS[id].type;
  }

  /** Requests a second allowed now: halved by a 429, back to full over ten minutes. */
  rate(now: number) { return this.base * Math.min(1, this.mul + (now - this.struckAt) / 600_000); }
  available(now: number) { return this.backoffUntil <= now; }

  /** True when the lane may start a request now. */
  ready(now: number): boolean {
    if (!this.available(now) || this.inFlight >= MAX_IN_FLIGHT) return false;
    this.bucket.setRate(this.rate(now), now);
    return this.bucket.peek(now) >= 1;
  }

  /** A 429. Returns the seconds the lane will wait. */
  limited(now: number, retryAfterS: number | null): number {
    this.strikes = now - this.struckAt < 900_000 ? this.strikes + 1 : 1;
    this.mul = Math.max(0.125, this.rate(now) / this.base / 2);
    this.struckAt = now;
    const wait = Math.max(retryAfterS ?? 0, Math.min(1800, 30 * 2 ** (this.strikes - 1)));
    this.backoffUntil = now + wait * 1000;
    this.bucket.drain(now);
    return wait;
  }
}

export class AdsbScheduler {
  readonly lanes: Record<Provider, Lane>;
  /** When each job last started, ms. */
  private last = new Map<string, number>();
  private running = new Set<string>();
  private sweep: { key: string; lat: number; lon: number; busy: boolean }[];
  private civil: { key: string; t: string }[] = [];
  private mil = MIL_TYPES.map((t) => ({ key: `ty:${t}`, t }));
  private views: ViewRegistry;
  /** OpenSky is giving a world picture, so the sweep can go slower. */
  openskyHealthy = false;
  /** How much the background cadences are stretched to fit the lanes. */
  stretch = 1;
  private stretchAt = -Infinity;

  constructor(sweep: SweepPoint[], views: ViewRegistry, now = Date.now()) {
    this.sweep = sweep.map((p) => ({ key: `sw:${p.lat},${p.lon}`, lat: p.lat, lon: p.lon, busy: p.weight >= 5 }));
    this.views = views;
    this.lanes = {
      adsbfi: new Lane('adsbfi', LANE_RATES.adsbfi, now),
      adsblol: new Lane('adsblol', LANE_RATES.adsblol, now),
      airplaneslive: new Lane('airplaneslive', LANE_RATES.airplaneslive, now),
      adsbone: new Lane('adsbone', LANE_RATES.adsbone, now),
    };
    this.setTypes([]);
  }

  /** Types seen in live traffic, most common first; the top sixty civil ones are asked for. */
  setTypes(ranked: string[]) {
    const civil = [...new Set([...ranked.filter((t) => /^[A-Z0-9]{2,4}$/.test(t) && !MIL_SET.has(t)), ...SEED_TYPES])].slice(0, CIVIL_TYPES);
    this.civil = civil.map((t) => ({ key: `ty:${t}`, t }));
  }

  get types() { return this.civil.map((c) => c.t); }

  private sweepMs(busy: boolean) { return busy ? (this.openskyHealthy ? 120_000 : 75_000) : 300_000; }

  /**
   * Requests a second the background needs at its base cadences, against
   * what the lanes can give it once foreground demand (up to 60%) is met.
   */
  private restretch(now: number) {
    if (now - this.stretchAt < 10_000) return;
    this.stretchAt = now;
    const live = Object.values(this.lanes).filter((l) => l.available(now));
    const cap = live.reduce((s, l) => s + l.rate(now), 0);
    if (!cap) return;
    const fgWant = this.views.points(now).pts.length / (VIEW_MS / 1000) + live.length / 20 + SQUAWKS.length / 30 +
      live.reduce((s, l) => s + PROVIDERS[l.id].lists.length, 0) / 75;
    const bgCap = (cap - Math.min((1 - BG_SHARE) * cap, fgWant)) * 0.9;
    let want = 0;
    for (const s of this.sweep) want += 1000 / this.sweepMs(s.busy);
    if (live.some((l) => l.hasType)) want += this.civil.length / (CIVIL_MS / 1000) + this.mil.length / (MIL_MS / 1000);
    this.stretch = Math.min(MAX_STRETCH, Math.max(1, want / bgCap));
  }

  private due(key: string, interval: number) { return (this.last.get(key) ?? 0) + interval; }

  private pickFg(lane: Lane, now: number): Job | null {
    const P = PROVIDERS[lane.id];
    let best: Job | null = null, bestDue = Infinity;
    const consider = (key: string, url: () => string, cadence: number, interval: number) => {
      if (this.running.has(key)) return;
      const d = this.due(key, interval);
      if (d <= now && d < bestDue) { bestDue = d; best = { key, lane: lane.id, url: url(), cadence, interval, bg: false }; }
    };
    // Emergencies and military first: cheap, worldwide, and what people look for.
    for (const s of SQUAWKS) consider(`sq${s}`, () => P.sqk(s), 30, 30_000);
    // Each network hears different military traffic: ask every one of them.
    consider(`mil:${lane.id}`, () => P.mil, 30, 20_000);
    // Worldwide lists in one request: LADD and privacy-address aircraft,
    // mostly business jets that other networks leave out.
    P.lists.forEach((u, i) => consider(`ls${i}:${lane.id}`, () => u, 90, 75_000));
    return best ?? this.pickView(lane, now);
  }

  /** The longest-waiting viewer's next stale circle. */
  private pickView(lane: Lane, now: number): Job | null {
    const { pts, of } = this.views.points(now);
    const order = [...of.keys()].sort((a, b) => a.served - b.served);
    for (const v of order) {
      for (const i of of.get(v)!) {
        const p = pts[i];
        if (this.running.has(p.key) || this.due(p.key, VIEW_MS) > now) continue;
        return { key: p.key, lane: lane.id, url: PROVIDERS[lane.id].point(p.lat, p.lon, p.r), cadence: 6, interval: VIEW_MS, bg: false, view: v };
      }
    }
    return null;
  }

  /** The most overdue sweep circle or type query. */
  private pickBg(lane: Lane, now: number): Job | null {
    const P = PROVIDERS[lane.id];
    let pick: { key: string; url: () => string; interval: number; cadence: number } | null = null, bestDue = Infinity;
    for (const s of this.sweep) {
      const iv = this.sweepMs(s.busy) * this.stretch;
      const d = this.due(s.key, iv);
      if (d <= now && d < bestDue && !this.running.has(s.key)) {
        bestDue = d;
        pick = { key: s.key, url: () => P.point(s.lat, s.lon, 250), interval: iv, cadence: (iv * 1.25) / 1000 };
      }
    }
    const type = P.type;
    if (type) {
      for (const [list, base] of [[this.civil, CIVIL_MS], [this.mil, MIL_MS]] as const) {
        const iv = base * this.stretch;
        for (const c of list) {
          const d = this.due(c.key, iv);
          if (d <= now && d < bestDue && !this.running.has(c.key)) {
            bestDue = d;
            pick = { key: c.key, url: () => type(c.t), interval: iv, cadence: (iv * 1.6) / 1000 };
          }
        }
      }
    }
    return pick && { key: pick.key, lane: lane.id, url: pick.url(), cadence: pick.cadence, interval: pick.interval, bg: true };
  }

  /**
   * The job `lane` runs now, or null if nothing is due. Call when
   * `lane.ready(now)`; the returned job has started (token spent, marked
   * running) and must be finished with done().
   */
  next(id: Provider, now = Date.now()): Job | null {
    const lane = this.lanes[id];
    this.restretch(now);
    const bg = this.pickBg(lane, now);
    const fg = this.pickFg(lane, now);
    if (!bg && !fg) return null;
    lane.credit += BG_SHARE;
    let job: Job;
    if (bg && (lane.credit >= 1 || !fg)) {
      job = bg;
      lane.credit = Math.max(0, lane.credit - 1);
    } else {
      job = fg!;
      // Nothing in the background: no banking a burst for later.
      if (!bg) lane.credit = Math.min(lane.credit, 1);
    }
    lane.bucket.take(now);
    lane.inFlight++;
    this.last.set(job.key, now);
    this.running.add(job.key);
    if (job.view) job.view.served = now;
    return job;
  }

  /**
   * Finish a job. On failure it is due again in 5 s (another lane may
   * take it), and the lane backs off as the error says. Returns a note for
   * the lane's status when it changes state.
   */
  done(job: Job, now = Date.now(), err?: { status: number; retryAfter: number | null }): string {
    this.running.delete(job.key);
    const lane = this.lanes[job.lane];
    lane.inFlight = Math.max(0, lane.inFlight - 1);
    if (!err) { lane.refused = 0; return ''; }
    this.last.set(job.key, now - job.interval + 5000);
    const s = err.status;
    if (s === 429) {
      const wait = lane.limited(now, err.retryAfter);
      return `rate limited; resuming in ${Math.round(wait)} s at ${Math.round(lane.rate(now + wait * 1000) * 100) / 100} req/s`;
    }
    if (s === 401 || s === 403) {
      // Some networks refuse cloud servers; stop asking for an hour.
      if (++lane.refused >= 5) { lane.backoffUntil = now + 3_600_000; return 'refused from this server; retrying hourly'; }
      return '';
    }
    if (s >= 500 || !s) lane.backoffUntil = now + 10_000;
    return '';
  }

  /** Forget jobs that no longer exist: view circles come and go with every pan. */
  prune(now = Date.now()) {
    for (const [k, t] of this.last) {
      if (now - t > (k.startsWith('pt:') ? 600_000 : 7_200_000)) this.last.delete(k);
    }
  }
}
