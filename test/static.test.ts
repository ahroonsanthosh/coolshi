import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { accepts, StaticFiles } from '../server/static.ts';

test('static: Accept-Encoding parsing', () => {
  assert.ok(accepts('gzip, deflate, br, zstd', 'br'));
  assert.ok(!accepts('gzip, br;q=0', 'br'));
  assert.ok(accepts('br;q=0.5', 'br'));
  assert.ok(!accepts('brotli', 'br'));
  assert.ok(!accepts(undefined, 'gzip'));
});

test('static: compressed once, chosen by Accept-Encoding, never outside dist/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'site-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(root, 'dist-old'));
  const js = 'console.log("hello");\n'.repeat(2000);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(dist, 'assets', 'a.js'), js);
  writeFileSync(join(root, 'dist-old', 'secret.txt'), 'no');
  const files = new StaticFiles(dist);
  assert.equal(await files.warm(), 2);
  const srv = http.createServer((req, res) => { void files.serve(req, res, new URL(req.url!, 'http://x').pathname); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const get = (path: string, ae?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.get({ port, path, headers: ae ? { 'Accept-Encoding': ae } : {} }, (res) => {
      const b: Buffer[] = [];
      res.on('data', (d) => b.push(d)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(b) }));
    }).on('error', reject);
  });
  try {
    const br = await get('/assets/a.js', 'gzip, br');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(brotliDecompressSync(br.body).toString(), js);
    assert.ok(br.body.length < js.length / 10);
    const gz = await get('/assets/a.js', 'gzip');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(gz.body).toString(), js);
    const raw = await get('/assets/a.js');
    assert.equal(raw.headers['content-encoding'], undefined);
    assert.equal(raw.body.toString(), js);
    const page = await get('/some/route', 'gzip');
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.match(gunzipSync(page.body).toString(), /doctype/);
    assert.equal((await get('/..%2fdist-old/secret.txt')).status, 403);
    assert.equal((await get('/%E0%A4%A')).status, 400);
  } finally {
    srv.close();
  }
});
