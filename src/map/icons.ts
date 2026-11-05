// Top-down silhouettes, nose up, drawn once into signed distance fields so
// MapLibre can tint each by altitude and give it a crisp paper halo at any
// size. Paths are in a 100×100 box.

import type { Map as MlMap } from 'maplibre-gl';

const PATHS: Record<string, string[]> = {
  jet: [
    'M50 6C54 6 55.2 12 55.2 18L55.2 40L93 58.5L93 64.5L55.2 56L55.2 77L66.5 85.5L66.5 91L50 88L33.5 91L33.5 85.5L44.8 77L44.8 56L7 64.5L7 58.5L44.8 40L44.8 18C44.8 12 46 6 50 6Z',
  ],
  heavy: [
    'M50 2C55.5 2 57.2 10 57.2 18L57.2 37L97 60L97 67.5L57.2 57L57.2 80L71 89L71 95L50 91.5L29 95L29 89L42.8 80L42.8 57L3 67.5L3 60L42.8 37L42.8 18C42.8 10 44.5 2 50 2Z',
    'M21 49h6.5v11h-6.5Z', 'M72.5 49h6.5v11h-6.5Z', 'M9 56h5.5v9h-5.5Z', 'M85.5 56h5.5v9h-5.5Z',
  ],
  biz: [
    'M50 8C53.4 8 54.4 15 54.4 22L54.4 44L86 57L86 61.5L54.4 55L54.4 82L66 88.5L66 92.5L50 90L34 92.5L34 88.5L45.6 82L45.6 55L14 61.5L14 57L45.6 44L45.6 22C45.6 15 46.6 8 50 8Z',
    'M56 64h6v14h-6Z', 'M38 64h6v14h-6Z',
  ],
  light: [
    'M50 13C53 13 54.2 17 54.2 23L54.2 29L95 29L95 37.5L54.2 37.5L54.2 72L70 74.5L70 81L50 83L30 81L30 74.5L45.8 72L45.8 37.5L5 37.5L5 29L45.8 29L45.8 23C45.8 17 47 13 50 13Z',
    'M38 9h24v3.4h-24Z',
  ],
  heli: [
    'M50 6A34 34 0 1 1 49.99 6ZM50 9.5A30.5 30.5 0 1 0 50.01 9.5Z',
    'M50 25C57 25 61 32 61 41C61 50 57 57 50 57C43 57 39 50 39 41C39 32 43 25 50 25Z',
    'M48.2 55h3.6v36h-3.6Z', 'M41 87h18v4h-18Z',
  ],
  glider: [
    'M50 18C52.2 18 53.2 22 53.2 28L53.2 38L99 40.5L99 45L53.2 44.5L53.2 82L63 84L63 88.5L50 88.5L37 88.5L37 84L46.8 82L46.8 44.5L1 45L1 40.5L46.8 38L46.8 28C46.8 22 47.8 18 50 18Z',
  ],
  balloon: [
    'M50 10A27 27 0 1 1 49.99 10Z', 'M44 73h12v10h-12Z', 'M45 62h2v12h-2Z', 'M53 62h2v12h-2Z',
  ],
  drone: [
    'M22 18L50 44L78 18L82 22L56 50L82 78L78 82L50 56L22 82L18 78L44 50L18 22Z',
    'M20 8A12 12 0 1 1 19.99 8Z', 'M80 8A12 12 0 1 1 79.99 8Z', 'M20 68A12 12 0 1 1 19.99 68Z', 'M80 68A12 12 0 1 1 79.99 68Z',
    'M50 40A10 10 0 1 1 49.99 40Z',
  ],
  fighter: [
    'M50 3L54.5 26L57.5 43L91 73L91 79L60 75L62 86L73 92L73 96.5L50 92.5L27 96.5L27 92L38 86L40 75L9 79L9 73L42.5 43L45.5 26Z',
  ],
  unknown: ['M50 12L80 84L50 69L20 84Z'],
  ship: ['M50 6L67 32L67 92L33 92L33 32Z'],
  shipStill: ['M50 30A20 20 0 1 1 49.99 30Z'],
  iss: [
    'M14 30h17v40h-17Z', 'M69 30h17v40h-17Z', 'M31 47.5h38v5h-38Z', 'M43 36h14v28h-14Z',
  ],
  diamond: ['M50 8L92 50L50 92L8 50Z'],
};

const SIZE = 64; // texture px; added at pixelRatio 2, so 32 css px
const PAD = 8; // room for the distance field around the shape
const RADIUS = 8; // MapLibre's SDF_PX
const CUTOFF = 0.25;

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, v: Uint16Array, z: Float64Array, d: Float64Array) {
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1, k = 0; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  for (let q = 0, k = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

function edt(grid: Float64Array, w: number, h: number) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1), v = new Uint16Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, v, z, d);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, v, z, d);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]);
  }
}

function sdfImage(paths: string[], size = SIZE): ImageData {
  const W = size + PAD * 2;
  const c = document.createElement('canvas');
  c.width = c.height = W;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.translate(PAD, PAD);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = '#000';
  for (const p of paths) ctx.fill(new Path2D(p), 'evenodd');
  const src = ctx.getImageData(0, 0, W, W).data;
  const outer = new Float64Array(W * W), inner = new Float64Array(W * W);
  const INF = 1e20;
  for (let i = 0; i < W * W; i++) {
    const a = src[i * 4 + 3] / 255;
    // Sub-pixel edge from the antialiased coverage, as TinySDF does.
    if (a === 1) { outer[i] = 0; inner[i] = INF; }
    else if (a === 0) { outer[i] = INF; inner[i] = 0; }
    else { const e = Math.max(0, 0.5 - a); const g = Math.max(0, a - 0.5); outer[i] = e * e; inner[i] = g * g; }
  }
  edt(outer, W, W);
  edt(inner, W, W);
  const out = new ImageData(W, W);
  for (let i = 0; i < W * W; i++) {
    const dist = outer[i] - inner[i];
    out.data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(255 - 255 * (dist / RADIUS + CUTOFF))));
  }
  return out;
}

export const ICON_NAMES = Object.keys(PATHS);

export function addIcons(map: MlMap) {
  for (const [name, paths] of Object.entries(PATHS)) {
    if (map.hasImage(name)) continue;
    map.addImage(name, sdfImage(paths), { sdf: true, pixelRatio: 2 });
  }
}

/** Plain (non-SDF) canvas drawing of a silhouette, for posters and panels. */
export function drawSilhouette(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, rot = 0) {
  const paths = PATHS[name] ?? PATHS.unknown;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(size / 100, size / 100);
  ctx.translate(-50, -50);
  for (const p of paths) ctx.fill(new Path2D(p), 'evenodd');
  ctx.restore();
}

export function silhouetteSvg(name: string, size = 20, color = 'currentColor'): string {
  const paths = PATHS[name] ?? PATHS.unknown;
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><g fill="${color}" fill-rule="evenodd">${paths
    .map((d) => `<path d="${d}"/>`)
    .join('')}</g></svg>`;
}
