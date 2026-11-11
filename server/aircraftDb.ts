// Registration, type, model, owner and military flag for ~620,000 airframes,
// keyed by ICAO 24-bit address, from the tar1090 database (Mictronics and
// wiedehopf, the same data behind adsb.fi and adsb.lol). It fills in what
// OpenSky leaves out, so a plane over the ocean is still "Boeing 777-200".
//
// Kept as one decompressed buffer, sorted by address, with an index of line
// offsets for binary search: ~40 MB and no per-entry objects.

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { UA } from './feeds/http.ts';

const URL_DB = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz';
const MAX_AGE_MS = 7 * 86_400_000;
const TIMEOUT_MS = 120_000; // 8 MB; a stalled download must not hang the refresh forever
const gunzipAsync = promisify(gunzip);

export interface AirframeRecord { reg: string; type: string; desc: string; owner: string; year: string; mil: boolean; pia: boolean; ladd: boolean }

export class AircraftDb {
  private buf: Buffer | null = null;
  private starts: Int32Array | null = null;
  status = 'not loaded';
  private dir: string;
  private loading: Promise<void> | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  get size() { return this.starts?.length ?? 0; }
  private get file() { return join(this.dir, 'aircraft.csv.gz'); }
  /** True when the copy on disk is due for its weekly refresh. */
  get stale() { return !existsSync(this.file) || Date.now() - statSync(this.file).mtimeMs >= MAX_AGE_MS; }

  /**
   * Load the cached copy, downloading it first when missing or a week old.
   * Never rejects: a failure leaves the database as it was (empty at boot)
   * and says why in `status`. A cache that won't decompress (a download
   * cut short) is deleted and fetched again, so it can't fail every boot.
   */
  load(): Promise<void> {
    return (this.loading ??= this.doLoad().finally(() => { this.loading = null; }));
  }

  private async doLoad(): Promise<void> {
    let fetchIt = this.stale;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (fetchIt) {
        try {
          if (!this.buf) this.status = 'downloading';
          await this.download();
        } catch (e) {
          // Keep using an old copy if there is one; else say so and stop.
          console.warn(`[airframes] download failed: ${msg(e)}`);
          if (!existsSync(this.file)) { this.unavailable(msg(e)); return; }
        }
      }
      try {
        await this.read();
        return;
      } catch (e) {
        console.warn(`[airframes] ${this.file} unreadable (${msg(e)}); fetching a new copy`);
        rmSync(this.file, { force: true });
        fetchIt = true;
      }
    }
    this.unavailable('download unreadable');
  }

  private unavailable(why: string) {
    if (!this.buf) this.status = `unavailable (${why})`;
  }

  private async download() {
    const res = await fetch(URL_DB, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    mkdirSync(this.dir, { recursive: true });
    // Write beside and rename, so a crash mid-write never leaves half a file.
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, gz);
    renameSync(tmp, this.file);
  }

  private async read() {
    // Decompressed off the event loop: ~40 MB.
    const buf = await gunzipAsync(await readFile(this.file));
    let n = 1;
    for (let i = buf.indexOf(10); i >= 0 && i + 1 < buf.length; i = buf.indexOf(10, i + 1)) n++;
    if (n < 1000) throw new Error(`only ${n} lines`);
    const starts = new Int32Array(n);
    for (let i = buf.indexOf(10), k = 1; i >= 0 && i + 1 < buf.length; i = buf.indexOf(10, i + 1)) starts[k++] = i + 1;
    // Swapped in whole, so lookups during a weekly reload see one or the other.
    this.buf = buf;
    this.starts = starts;
    this.status = `${n.toLocaleString('en')} airframes`;
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

const msg = (e: unknown) => (e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : String(e));
