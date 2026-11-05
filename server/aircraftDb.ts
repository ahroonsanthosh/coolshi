// Registration, type, model, owner and military flag for ~620,000 airframes,
// keyed by ICAO 24-bit address, from the tar1090 database (Mictronics and
// wiedehopf, the same data behind adsb.fi and adsb.lol). It fills in what
// OpenSky leaves out, so a plane over the ocean is still "Boeing 777-200".
//
// Kept as one decompressed buffer, sorted by address, with an index of line
// offsets for binary search: ~40 MB and no per-entry objects.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const URL_DB = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz';
const MAX_AGE_MS = 7 * 86_400_000;

export interface AirframeRecord { reg: string; type: string; desc: string; owner: string; year: string; mil: boolean; pia: boolean; ladd: boolean }

export class AircraftDb {
  private buf: Buffer | null = null;
  private starts: Int32Array | null = null;
  status = 'not loaded';
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get size() { return this.starts?.length ?? 0; }

  async load(): Promise<void> {
    const file = join(this.dir, 'aircraft.csv.gz');
    const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < MAX_AGE_MS;
    if (!fresh) {
      try {
        this.status = 'downloading';
        const res = await fetch(URL_DB, { headers: { 'User-Agent': 'Watchfloor/1.0' } });
        if (!res.ok) throw new Error(`${res.status}`);
        const gz = Buffer.from(await res.arrayBuffer());
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(file, gz);
      } catch (e) {
        if (!existsSync(file)) {
          this.status = `unavailable (${e instanceof Error ? e.message : e})`;
          return;
        }
      }
    }
    const buf = gunzipSync(readFileSync(file));
    const starts: number[] = [0];
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10 && i + 1 < buf.length) starts.push(i + 1);
    this.buf = buf;
    this.starts = Int32Array.from(starts);
    this.status = `${this.starts.length.toLocaleString('en')} airframes`;
  }

  private hexAt(i: number): string {
    const s = this.starts![i];
    return this.buf!.toString('latin1', s, s + 6).toLowerCase();
  }

  get(hex: string): AirframeRecord | null {
    if (!this.buf || !this.starts || hex.length !== 6) return null;
    let lo = 0, hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const h = this.hexAt(mid);
      if (h === hex) return this.parse(mid);
      if (h < hex) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  private parse(i: number): AirframeRecord | null {
    const s = this.starts![i];
    const e = i + 1 < this.starts!.length ? this.starts![i + 1] - 1 : this.buf!.length;
    // hex;reg;type;flags;desc;year;owner;
    const f = this.buf!.toString('utf8', s, e).split(';');
    if (/miscode/i.test(f[4] ?? '')) return null;
    const flags = f[3] ?? '';
    return {
      reg: f[1] ?? '', type: f[2] ?? '', desc: f[4] ?? '', year: f[5] ?? '', owner: f[6] ?? '',
      mil: flags[0] === '1', pia: flags[2] === '1', ladd: flags[3] === '1',
    };
  }
}
