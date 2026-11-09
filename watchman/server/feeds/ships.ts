// Ships. Fintraffic's Digitraffic publishes every AIS message heard by the
// Finnish coastal network (the Baltic, Gulf of Finland and Bothnia) openly and
// without a key. AISStream covers far more of the world but needs a free key
// (AISSTREAM_API_KEY); with one, it streams alongside.

import type { ShipReport } from '../store.ts';
import { SRC } from '../../shared/protocol.ts';
import { getJson, Status } from './http.ts';

const NA_SOG = 102.3;

/** AIS ETA bits (month, day, hour, minute) → "MM-DD HH:MM" UTC, or "". */
export function decodeEta(v: number): string {
  if (!v) return '';
  const month = (v >> 16) & 0xf, day = (v >> 11) & 0x1f, hour = (v >> 6) & 0x1f, min = v & 0x3f;
  if (!month || !day || month > 12 || hour > 23 || min > 59) return '';
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function cleanText(s: string | undefined): string {
  return (s ?? '').replace(/@+$/g, '').replace(/\s+/g, ' ').trim();
}

/** AIS rate-of-turn indicator → degrees a minute (null when not available). */
export function decodeRot(raw: number | null | undefined): number | null {
  if (raw == null || raw === -128 || Math.abs(raw) > 126) return null;
  const v = (raw / 4.733) ** 2;
  return Math.round(Math.sign(raw) * v * 10) / 10;
}

export class Digitraffic {
  status = new Status('digitraffic', 'Fintraffic Digitraffic', 'sea', 20);
  private lastLoc = 0;
  private lastMeta = 0;

  async pollLocations(ingest: (r: ShipReport) => void): Promise<void> {
    const from = this.lastLoc ? `?from=${this.lastLoc - 60_000}` : '';
    try {
      const { data } = await getJson<any>(`https://meri.digitraffic.fi/api/ais/v1/locations${from}`, {
        headers: { 'Digitraffic-User': 'Watchman/1.0' },
      });
      let n = 0, newest = this.lastLoc;
      for (const f of data.features ?? []) {
        const p = f.properties;
        const [lon, lat] = f.geometry.coordinates;
        const t = p.timestampExternal as number;
        if (t > newest) newest = t;
        ingest({
          mmsi: p.mmsi,
          lat, lon,
          posT: t / 1000,
          sog: p.sog >= NA_SOG ? null : p.sog,
          cog: p.cog >= 360 ? null : p.cog,
          hdg: p.heading >= 360 ? null : p.heading,
          nav: p.navStat ?? 15,
          rot: decodeRot(p.rot),
          src: SRC.digitraffic,
        });
        n++;
      }
      this.lastLoc = newest;
      this.status.success(n, 'Baltic Sea and Gulf of Finland');
    } catch (e) {
      this.status.fail(e);
    }
  }

  async pollMetadata(ingest: (r: ShipReport) => void): Promise<void> {
    const from = this.lastMeta ? `?from=${this.lastMeta - 60_000}` : '';
    try {
      const { data } = await getJson<any[]>(`https://meri.digitraffic.fi/api/ais/v1/vessels${from}`, {
        headers: { 'Digitraffic-User': 'Watchman/1.0' },
      });
      for (const v of data) {
        if (v.timestamp > this.lastMeta) this.lastMeta = v.timestamp;
        const len = (v.referencePointA ?? 0) + (v.referencePointB ?? 0);
        const beam = (v.referencePointC ?? 0) + (v.referencePointD ?? 0);
        ingest({
          mmsi: v.mmsi,
          name: cleanText(v.name),
          callsign: cleanText(v.callSign),
          imo: v.imo || 0,
          type: v.shipType || 0,
          dest: cleanText(v.destination),
          eta: decodeEta(v.eta),
          draught: v.draught ? v.draught / 10 : null,
          len: len || null,
          beam: beam || null,
          src: SRC.digitraffic,
        });
      }
    } catch (e) {
      console.warn('[digitraffic meta]', e);
    }
  }
}

/** AISStream.io, a free worldwide AIS relay. Optional: needs a key. */
export class AisStream {
  status = new Status('aisstream', 'AISStream', 'sea', 0);
  private key = process.env.AISSTREAM_API_KEY ?? '';
  private backoff = 2;
  private count = 0;

  get enabled() { return !!this.key; }

  start(ingest: (r: ShipReport) => void) {
    if (!this.key) {
      this.status.note = 'off: set AISSTREAM_API_KEY for worldwide ships';
      return;
    }
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.addEventListener('open', () => {
      this.backoff = 2;
      ws.send(JSON.stringify({
        APIKey: this.key,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'],
      }));
    });
    ws.addEventListener('message', async (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data : await (ev.data as Blob).text();
        const m = JSON.parse(text);
        if (m.error) { this.status.fail(new Error(m.error)); return; }
        const meta = m.MetaData ?? {};
        const mmsi = meta.MMSI as number;
        if (!mmsi) return;
        const t = Date.parse(String(meta.time_utc).replace(/\.\d+/, '').replace(' +0000 UTC', 'Z').replace(' ', 'T'));
        const pr = m.Message?.PositionReport ?? m.Message?.StandardClassBPositionReport;
        if (pr) {
          if (!pr.Valid) return;
          ingest({
            mmsi,
            lat: pr.Latitude, lon: pr.Longitude,
            posT: (isFinite(t) ? t : Date.now()) / 1000,
            sog: pr.Sog >= NA_SOG ? null : pr.Sog,
            cog: pr.Cog >= 360 ? null : pr.Cog,
            hdg: pr.TrueHeading >= 360 ? null : pr.TrueHeading,
            nav: pr.NavigationalStatus ?? 15,
            rot: decodeRot(pr.RateOfTurn),
            name: cleanText(meta.ShipName),
            src: 16,
          });
          this.status.success(++this.count, 'worldwide, volunteer receivers');
        }
        const sd = m.Message?.ShipStaticData;
        if (sd) {
          const d = sd.Dimension ?? {};
          const e = sd.Eta ?? {};
          ingest({
            mmsi,
            name: cleanText(sd.Name),
            callsign: cleanText(sd.CallSign),
            imo: sd.ImoNumber || 0,
            type: sd.Type || 0,
            dest: cleanText(sd.Destination),
            eta: e.Month ? `${String(e.Month).padStart(2, '0')}-${String(e.Day).padStart(2, '0')} ${String(e.Hour).padStart(2, '0')}:${String(e.Minute).padStart(2, '0')}` : '',
            draught: sd.MaximumStaticDraught || null,
            len: (d.A ?? 0) + (d.B ?? 0) || null,
            beam: (d.C ?? 0) + (d.D ?? 0) || null,
            src: 16,
          });
        }
      } catch {
        /* skip malformed message */
      }
    });
    ws.addEventListener('close', () => {
      this.status.fail(new Error('disconnected'));
      setTimeout(() => this.start(ingest), this.backoff * 1000);
      this.backoff = Math.min(120, this.backoff * 2);
    });
    ws.addEventListener('error', () => { /* close follows */ });
  }
}
