// Kystverket, the Norwegian Coastal Administration, streams every AIS
// message its coastal network hears (mainland Norway, the North Sea approaches
// and Svalbard) as raw NMEA over TCP, openly and without a key (NLOD licence).

import net from 'node:net';
import type { ShipReport } from '../store.ts';
import { SRC } from '../../shared/protocol.ts';
import { Status } from './http.ts';
import { NmeaAssembler } from './nmea.ts';

const HOST = process.env.KYSTVERKET_HOST || '153.44.253.27';
const PORT = Number(process.env.KYSTVERKET_PORT) || 5631;

export class Kystverket {
  status = new Status('kystverket', 'Kystverket (Norway)', 'sea', 0);
  private backoff = 5;
  private count = 0;

  start(ingest: (r: ShipReport) => void) {
    if (process.env.KYSTVERKET === 'off') { this.status.note = 'off'; return; }
    const asm = new NmeaAssembler();
    let buf = '';
    let alive = 0;
    const sock = net.connect({ host: HOST, port: PORT });
    sock.setEncoding('latin1');
    sock.setTimeout(90_000);
    sock.on('connect', () => { this.backoff = 5; this.status.note = 'Norwegian coast, North Sea, Svalbard'; });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = asm.push(line);
        if (!m) continue;
        const { msgType, t, ...rest } = m;
        const hasPos = rest.lat !== undefined;
        ingest({ ...rest, ...(hasPos ? { posT: t } : {}), src: SRC.kystverket } as ShipReport);
        if (hasPos && ++this.count % 50 === 0) this.status.success(this.count, 'Norwegian coast, North Sea, Svalbard');
        alive++;
        void msgType;
      }
      if (buf.length > 100_000) buf = '';
    });
    sock.on('timeout', () => sock.destroy(new Error('no data for 90 s')));
    sock.on('error', (e) => this.status.fail(e));
    sock.on('close', () => {
      if (!alive) this.status.fail(new Error('could not connect'), 'retrying; some hosts block outbound TCP');
      setTimeout(() => this.start(ingest), this.backoff * 1000);
      this.backoff = Math.min(600, this.backoff * 2);
    });
  }
}
