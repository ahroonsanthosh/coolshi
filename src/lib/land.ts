// Natural Earth 1:110m land (public domain), via world-atlas's TopoJSON,
// decoded to [lon, lat] rings for drawing small maps on posters.

import topo from '../data/land-110m.json';

type Ring = [number, number][];
let cache: Ring[] | null = null;

export function landRings(): Ring[] {
  if (cache) return cache;
  const t = topo as any;
  const [sx, sy] = t.transform.scale;
  const [tx, ty] = t.transform.translate;
  const arcs: Ring[] = t.arcs.map((arc: [number, number][]) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty] as [number, number]; });
  });
  const ringOf = (ids: number[]): Ring => {
    const out: Ring = [];
    for (const id of ids) {
      const a = id < 0 ? arcs[~id].slice().reverse() : arcs[id];
      out.push(...(out.length ? a.slice(1) : a));
    }
    return out;
  };
  const rings: Ring[] = [];
  for (const g of t.objects.land.geometries) {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    for (const poly of polys) for (const r of poly) rings.push(ringOf(r));
  }
  cache = rings;
  return rings;
}

/** Fill land on a 2D canvas in a plate carrée box. */
export function drawLand(c: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number) {
  c.beginPath();
  for (const ring of landRings()) {
    ring.forEach(([lon, lat], i) => {
      const x = x0 + ((lon + 180) / 360) * w, y = y0 + ((90 - lat) / 180) * h;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    });
    c.closePath();
  }
  c.fill('evenodd');
}
