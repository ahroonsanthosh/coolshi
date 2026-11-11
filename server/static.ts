// The built site (dist/). Text assets are compressed once, with brotli and
// gzip, kept in memory and sent by Accept-Encoding: the main bundle is
// 1.5 MB raw, ~410 KB as brotli. Compressed at startup in the background,
// one file at a time; a request that arrives first waits for its file.
// Brotli at quality 9: within ~10% of 11's size at a twentieth of the CPU,
// which matters on a small instance's first minute.

import type http from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.ico', '.webmanifest', '.txt', '.xml', '.map']);
const MAX_PACK = 16 * 1024 * 1024;

interface Packed { mtime: number; size: number; z: Promise<{ br: Buffer; gzip: Buffer } | null> }

/** Whether an Accept-Encoding header allows `enc` (present, and not q=0). */
export function accepts(header: string | undefined, enc: string): boolean {
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (name !== enc) continue;
    const q = params.find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

export class StaticFiles {
  private dir: string;
  private packs = new Map<string, Packed>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Compress every text asset now, so the first visitors don't wait. */
  async warm(): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    let n = 0;
    const walk = async (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) await walk(f);
        else if (COMPRESSIBLE.has(extname(f))) { const st = statSync(f); if (st.size <= MAX_PACK && (await this.pack(f, st))) n++; }
      }
    };
    await walk(this.dir);
    return n;
  }

  /** The compressed forms of a file, made once per version of it (a rebuild changes mtime). */
  private pack(file: string, st: Stats): Promise<{ br: Buffer; gzip: Buffer } | null> {
    const cur = this.packs.get(file);
    if (cur && cur.mtime === st.mtimeMs && cur.size === st.size) return cur.z;
    const z = readFile(file)
      .then(async (raw) => ({
        br: await brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
        gzip: await gz(raw, { level: 9 }),
      }))
      .catch((e) => { console.warn('[static] compress', file, e?.message ?? e); this.packs.delete(file); return null; });
    this.packs.set(file, { mtime: st.mtimeMs, size: st.size, z });
    return z;
  }

  async serve(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    if (!existsSync(this.dir)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No build found. Run `npm run build`, or use `npm run dev` and open the Vite URL.');
      return;
    }
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
    // dir + sep: a sibling such as dist-old/ must not pass for dist/.
    let file = normalize(join(this.dir, rel));
    if (file !== this.dir && !file.startsWith(this.dir + sep)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(this.dir, 'index.html');
    const st = statSync(file);
    const ext = extname(file);
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (COMPRESSIBLE.has(ext) && st.size <= MAX_PACK) {
      headers.Vary = 'Accept-Encoding';
      const ae = req.headers['accept-encoding'];
      const enc = accepts(ae, 'br') ? 'br' : accepts(ae, 'gzip') ? 'gzip' : null;
      const z = enc ? await this.pack(file, st) : null;
      if (enc && z) {
        res.writeHead(200, { ...headers, 'Content-Encoding': enc, 'Content-Length': z[enc].length });
        res.end(z[enc]);
        return;
      }
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    await pipeline(createReadStream(file), res).catch((e) => {
      // A reader closing the tab mid-download is normal; anything else is worth a line.
      if (e?.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[static]', file, e?.message ?? e);
      res.destroy();
    });
  }
}
