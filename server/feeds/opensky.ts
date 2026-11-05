// OpenSky Network: the only free source with a whole-world aircraft picture
// in one request. It costs 4 API credits a poll; anonymous callers get 400 a
// day, a free account 4,000. We poll only while someone is watching and wait
// exactly as long as OpenSky asks when the credits run out.

import type { AircraftReport } from '../store.ts';
import { SRC } from '../../shared/protocol.ts';
import { getJson, HttpError, Status } from './http.ts';

const M_TO_FT = 1 / 0.3048;
const MS_TO_KT = 3600 / 1852;
const MS_TO_FPM = 60 / 0.3048;

// OpenSky's aircraft category index (extended=1) → ADS-B emitter category.
const CATS = ['', '', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'B1', 'B2', 'B3', 'B4', 'B6', 'B7', 'C1', 'C2', 'C3', 'C4', 'C5'];

export class OpenSky {
  status: Status;
  private token: { value: string; exp: number } | null = null;
  private id = process.env.OPENSKY_CLIENT_ID ?? '';
  private secret = process.env.OPENSKY_CLIENT_SECRET ?? '';
  readonly pollS: number;
  creditsLeft: number | null = null;
  /** True while OpenSky is giving us a current world picture. */
  healthy = false;

  constructor() {
    const authed = !!(this.id && this.secret);
    this.pollS = Number(process.env.OPENSKY_POLL_S) || (authed ? 45 : 150);
    this.status = new Status('opensky', 'OpenSky Network', 'air', this.pollS);
    this.status.note = authed ? 'account' : 'anonymous';
  }

  private async auth(): Promise<Record<string, string>> {
    if (!this.id || !this.secret) return {};
    if (this.token && this.token.exp > Date.now() + 30_000) return { Authorization: `Bearer ${this.token.value}` };
    const res = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.id, client_secret: this.secret }),
      },
    );
    if (!res.ok) throw new Error(`OpenSky auth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return { Authorization: `Bearer ${j.access_token}` };
  }

  /** Returns the seconds to wait before the next poll. */
  async poll(ingest: (r: AircraftReport) => void): Promise<number> {
    try {
      const { data, res } = await getJson<{ time: number; states: any[][] | null }>(
        'https://opensky-network.org/api/states/all?extended=1',
        { headers: await this.auth() },
        45_000,
      );
      const left = res.headers.get('x-rate-limit-remaining');
      this.creditsLeft = left === null ? null : Number(left);
      let n = 0;
      for (const s of data.states ?? []) {
        const [icao, cs, , tPos, , lon, lat, baro, onGround, vel, trk, vr, , geo, sq, , , cat] = s;
        if (lat == null || lon == null || tPos == null) continue;
        ingest({
          hex: String(icao).toLowerCase(),
          lat,
          lon,
          posT: tPos,
          alt: onGround ? 0 : baro == null ? null : Math.round(baro * M_TO_FT),
          altGeom: geo == null ? null : Math.round(geo * M_TO_FT),
          ground: !!onGround,
          gs: vel == null ? null : vel * MS_TO_KT,
          trk: trk ?? null,
          vr: vr == null ? null : Math.round(vr * MS_TO_FPM),
          cs: (cs ?? '').trim(),
          sq: sq ?? '',
          cat: typeof cat === 'number' ? (CATS[cat] ?? '') : '',
          src: SRC.opensky,
          cadence: this.pollS,
        });
        n++;
      }
      this.healthy = true;
      this.status.success(n, this.creditsLeft === null ? this.status.note : `${this.creditsLeft} credits left today`);
      return this.pollS;
    } catch (e) {
      this.healthy = false;
      if (e instanceof HttpError && e.status === 429) {
        const wait = e.retryAfter ?? 3600;
        this.status.fail(e, `out of credits; resumes in ${Math.round(wait / 60)} min`);
        return Math.min(wait, 6 * 3600);
      }
      this.status.fail(e);
      return 60;
    }
  }
}
