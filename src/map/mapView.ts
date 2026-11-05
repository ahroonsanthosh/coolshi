// The map: basemap, every data layer, and the render loop that moves tracks.

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Ship the worker as its own asset; MapLibre otherwise looks for it next to
// its own module, which a bundler moves.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
maplibregl.setWorkerUrl(workerUrl);
import { A, AF, S, type HistoryPoint } from '../../shared/protocol.ts';
import { destination, greatCircle, NM, distance } from '../../shared/geo.ts';
import { nightPolygon } from '../../shared/sun.ts';
import { paperStyle, PAPER, LABEL_FONT, LABEL_FONT_BOLD } from './style.ts';
import { addIcons } from './icons.ts';
import { altColorExpr, altColor, EMERGENCY, INK, QUAKE, SHIP, SHIP_STILL } from './colors.ts';
import { picture, type Aircraft, type Ship } from '../state/data.ts';
import { app, type Selection } from '../state/app.ts';
import { altitude } from '../lib/format.ts';
import airportsRaw from '../data/airports.json';

type FC = GeoJSON.FeatureCollection;
const fc = (features: GeoJSON.Feature[] = []): FC => ({ type: 'FeatureCollection', features });

export const AIRPORTS = airportsRaw as [string, string, string, string, string, number, number, number | null, number][];

let map: MlMap;
const sources: Record<string, GeoJSONSource> = {};

export function getMap() { return map; }

export function createMap(container: HTMLElement): Promise<MlMap> {
  map = new maplibregl.Map({
    container,
    style: paperStyle(),
    center: [12, 30],
    zoom: initialZoom(),
    minZoom: 0.6,
    maxZoom: 16,
    attributionControl: false,
    renderWorldCopies: false,
    maxPitch: 60,
    fadeDuration: 150,
  });
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  }), 'bottom-right');
  // Keep the credit to one small (i) until asked for.
  map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  return new Promise((resolve) => map.once('load', () => { setup(); resolve(map); }));
}

function initialZoom() {
  // Fill most of the shorter screen side with the globe.
  const px = Math.min(window.innerWidth, window.innerHeight * 1.05);
  return Math.max(0.9, Math.log2(px / 512) + 1.15);
}

function addSource(id: string, data: FC = fc()) {
  map.addSource(id, { type: 'geojson', data, maxzoom: 14, buffer: 64, tolerance: 0.2 });
  sources[id] = map.getSource(id) as GeoJSONSource;
}

function setup() {
  addIcons(map);

  // Night: four nested twilight bands, so dusk has depth instead of a line.
  for (const d of [0, 6, 12, 18]) {
    addSource(`night${d}`);
    map.addLayer({
      id: `night${d}`, type: 'fill', source: `night${d}`,
      // Strong on the globe, where day and night are the story; faint at
      // city scale, where they'd only grey the chart.
      paint: {
        'fill-color': '#3b3128',
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, d === 0 ? 0.045 : 0.035, 7, d === 0 ? 0.015 : 0.008],
        'fill-antialias': false,
      },
    });
  }

  // Airports.
  addSource('airports', airportFeatures());
  map.addLayer({
    id: 'airports', type: 'circle', source: 'airports',
    filter: ['any', ['==', ['get', 'rank'], 1], ['>=', ['zoom'], 6]],
    minzoom: 3,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 8, 3.2, 12, 5],
      'circle-color': PAPER.bg,
      'circle-stroke-color': '#8f877d',
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: 'airport-labels', type: 'symbol', source: 'airports', minzoom: 4.5,
    filter: ['any', ['==', ['get', 'rank'], 1], ['>=', ['zoom'], 7]],
    layout: {
      'text-field': ['step', ['zoom'], ['get', 'code'], 8, ['format', ['get', 'code'], {}, '\n', {}, ['get', 'name'], { 'font-scale': 0.85 }]],
      'text-font': LABEL_FONT_BOLD,
      'text-size': 10,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-letter-spacing': 0.06,
      'text-optional': true,
      'text-max-width': 9,
    },
    paint: { 'text-color': '#8a8379', 'text-halo-color': PAPER.bg, 'text-halo-width': 1.4 },
  });

  // Weather radar sits under traffic.
  map.addSource('radar', { type: 'raster', tiles: [], tileSize: 256, maxzoom: 7 } as any);

  // Earthquakes and disasters.
  addSource('quakes');
  map.addLayer({
    id: 'quake-fill', type: 'circle', source: 'quakes',
    paint: {
      'circle-radius': quakeRadius(),
      'circle-color': QUAKE,
      'circle-opacity': ['interpolate', ['linear'], ['get', 'ageH'], 0, 0.22, 24, 0.07, 168, 0.03],
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'quakes', type: 'circle', source: 'quakes',
    paint: {
      'circle-radius': quakeRadius(),
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': QUAKE,
      'circle-stroke-width': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 0.6, 6, 1.4],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'ageH'], 0, 1, 24, 0.55, 168, 0.3],
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'quake-labels', type: 'symbol', source: 'quakes', minzoom: 2,
    filter: ['>=', ['get', 'mag'], 4.5],
    layout: {
      'text-field': ['concat', 'M', ['number-format', ['get', 'mag'], { 'min-fraction-digits': 1, 'max-fraction-digits': 1 }]],
      'text-font': LABEL_FONT_BOLD, 'text-size': 10, 'text-offset': [0, 0], 'text-allow-overlap': false,
    },
    paint: { 'text-color': QUAKE, 'text-halo-color': PAPER.bg, 'text-halo-width': 1.5 },
  });
  addSource('disasters');
  map.addLayer({
    id: 'disasters', type: 'symbol', source: 'disasters',
    layout: {
      'icon-image': 'diamond', 'icon-size': ['match', ['get', 'alert'], 'Red', 0.62, 'Orange', 0.52, 0.42],
      'icon-allow-overlap': true,
      'text-field': ['step', ['zoom'], '', 3, ['get', 'label']],
      'text-font': LABEL_FONT, 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: {
      'icon-color': ['match', ['get', 'alert'], 'Red', '#d9342b', 'Orange', '#e8890c', '#6f9e5b'],
      'icon-halo-color': PAPER.bg, 'icon-halo-width': 1.5, 'icon-opacity': 0.85,
      'text-color': '#7d766d', 'text-halo-color': PAPER.bg, 'text-halo-width': 1.4,
    },
  });

  // Pulses: fresh earthquakes and emergencies breathe.
  addSource('pulse');
  map.addLayer({
    id: 'pulse', type: 'circle', source: 'pulse',
    paint: { 'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 1.5, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-opacity': 0.5, 'circle-pitch-alignment': 'map' },
  });

  // Selected track: its history, the route on file and a short look ahead.
  addSource('route');
  map.addLayer({
    id: 'route', type: 'line', source: 'route',
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': INK, 'line-width': 1.1,
      'line-opacity': ['match', ['get', 'part'], 'flown', 0.22, 0.5],
      'line-dasharray': [2, 3],
    },
  });
  addSource('route-pts');
  map.addLayer({
    id: 'route-pts', type: 'circle', source: 'route-pts',
    paint: { 'circle-radius': 4, 'circle-color': PAPER.bg, 'circle-stroke-color': INK, 'circle-stroke-width': 1.4 },
  });
  map.addLayer({
    id: 'route-labels', type: 'symbol', source: 'route-pts',
    layout: { 'text-field': ['get', 'code'], 'text-font': LABEL_FONT_BOLD, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': true, 'text-letter-spacing': 0.08 },
    paint: { 'text-color': INK, 'text-halo-color': PAPER.bg, 'text-halo-width': 1.6 },
  });
  addSource('trail');
  map.addLayer({
    id: 'trail', type: 'line', source: 'trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['==', ['get', 'kind'], 'sea'], SHIP, altColorExpr()],
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 10, 2.6],
      'line-opacity': 0.9,
    },
  });
  addSource('leader');
  map.addLayer({
    id: 'leader', type: 'line', source: 'leader',
    paint: { 'line-color': INK, 'line-width': 1, 'line-opacity': 0.55, 'line-dasharray': [1, 2] },
  });

  // ISS ground track and the station.
  addSource('iss-track');
  map.addLayer({
    id: 'iss-track', type: 'line', source: 'iss-track',
    paint: { 'line-color': INK, 'line-width': 0.9, 'line-opacity': ['match', ['get', 'part'], 'past', 0.18, 0.4], 'line-dasharray': ['match', ['get', 'part'], 'past', ['literal', [1, 0]], ['literal', [3, 3]]] as any },
  });
  addSource('iss');
  map.addLayer({
    id: 'iss', type: 'symbol', source: 'iss',
    layout: {
      'icon-image': 'iss', 'icon-size': 0.8, 'icon-allow-overlap': true, 'icon-rotation-alignment': 'map',
      'text-field': 'ISS', 'text-font': LABEL_FONT_BOLD, 'text-size': 10, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-letter-spacing': 0.12,
    },
    paint: { 'icon-color': INK, 'icon-halo-color': PAPER.bg, 'icon-halo-width': 2, 'text-color': INK, 'text-halo-color': PAPER.bg, 'text-halo-width': 1.5 },
  });

  // Ships.
  addSource('ships');
  map.addLayer({
    id: 'ships', type: 'symbol', source: 'ships',
    layout: {
      'icon-image': ['case', ['get', 'still'], 'shipStill', 'ship'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['get', 'still'], 0.07, 0.14], 6, ['case', ['get', 'still'], 0.14, 0.3], 9, ['case', ['get', 'still'], 0.24, 0.5], 13, ['case', ['get', 'still'], 0.34, 0.72]],
      'icon-rotate': ['get', 'rot'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['get', 'sort'],
    },
    paint: {
      'icon-color': ['case', ['get', 'sel'], INK, ['get', 'still'], SHIP_STILL, SHIP],
      'icon-halo-color': PAPER.bg,
      'icon-halo-width': 1.2,
      'icon-opacity': ['case', ['get', 'stale'], 0.4, 1],
    },
  });

  // Aircraft.
  addSource('aircraft');
  map.addLayer({
    id: 'aircraft', type: 'symbol', source: 'aircraft',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        1, ['*', ['get', 'size'], 0.2],
        3, ['*', ['get', 'size'], 0.28],
        5, ['*', ['get', 'size'], 0.46],
        9, ['*', ['get', 'size'], 0.72],
        14, ['*', ['get', 'size'], 1.0],
      ],
      'icon-rotate': ['get', 'rot'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['get', 'sort'],
    },
    paint: {
      'icon-color': ['case', ['get', 'em'], EMERGENCY, ['get', 'sel'], INK, altColorExpr()],
      'icon-halo-color': PAPER.bg,
      'icon-halo-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 8, 1.4],
      'icon-opacity': ['case', ['get', 'stale'], 0.35, 1],
    },
  });

  // Labels for both, decluttered by MapLibre's collision.
  addSource('labels');
  map.addLayer({
    id: 'labels', type: 'symbol', source: 'labels', minzoom: 5.5,
    layout: {
      'text-field': [
        'step', ['zoom'], ['get', 'name'],
        8, ['format', ['get', 'name'], {}, '\n', {}, ['get', 'sub'], { 'font-scale': 0.86, 'text-color': '#968f86' }],
      ],
      'text-font': LABEL_FONT_BOLD,
      'text-size': 10.5,
      'text-anchor': 'left',
      'text-justify': 'left',
      'text-offset': [1.1, 0],
      'text-letter-spacing': 0.03,
      'symbol-sort-key': ['get', 'sort'],
      'text-padding': 1,
    },
    paint: { 'text-color': '#4a453f', 'text-halo-color': PAPER.bg, 'text-halo-width': 1.6 },
  });

  // Selection ring on top of everything.
  addSource('sel');
  map.addLayer({
    id: 'sel', type: 'circle', source: 'sel',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 11, 10, 18],
      'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': INK, 'circle-stroke-width': 1.2, 'circle-pitch-alignment': 'map',
    },
  });

  bindPointer();
  applyLayerVisibility();
  app.on('layers', applyLayerVisibility);
  app.on('selection', () => { loadSelectionExtras(); needsFull = true; });
  app.on('filter', () => { needsFull = true; });
  updateNight();
  setInterval(updateNight, 60_000);
  loadRadar();
  setInterval(loadRadar, 5 * 60_000);
  picture.on((w) => { if (w === 'world') updateWorld(); });
  requestAnimationFrame(frame);
}

function quakeRadius(): any {
  // Radius grows with released energy, compressed so a M7 doesn't swallow a
  // continent at world zoom.
  const mag = ['interpolate', ['exponential', 1.75], ['get', 'mag'], 2.5, 2.5, 4.5, 6, 6, 13, 7.5, 28];
  return ['interpolate', ['linear'], ['zoom'], 1, ['*', mag, 0.75], 6, ['*', mag, 1.2], 10, ['*', mag, 1.6]];
}

function airportFeatures(): FC {
  return fc(AIRPORTS.map(([icao, iata, name, city, , lat, lon, , rank]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id: icao, code: iata || icao, name: city || name, rank },
  })));
}

// ---------------------------------------------------------------------------
// Visibility

const LAYER_GROUPS: Record<string, string[]> = {
  aircraft: ['aircraft'],
  ships: ['ships'],
  labels: ['labels'],
  airports: ['airports', 'airport-labels'],
  quakes: ['quakes', 'quake-fill', 'quake-labels'],
  disasters: ['disasters'],
  iss: ['iss', 'iss-track'],
  night: ['night0', 'night6', 'night12', 'night18'],
  trails: ['trail'],
};

function applyLayerVisibility() {
  for (const [k, ids] of Object.entries(LAYER_GROUPS)) {
    const on = app.layers[k as keyof typeof app.layers];
    for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  if (map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', app.layers.radar ? 'visible' : 'none');
  needsFull = true;
}

// ---------------------------------------------------------------------------
// Night and weather

function updateNight() {
  const now = Date.now();
  for (const d of [0, 6, 12, 18]) {
    sources[`night${d}`]?.setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [nightPolygon(now, d)] } }]));
  }
}

export let radarTime = 0;
async function loadRadar() {
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const j = await r.json();
    const frames = j.radar?.past ?? [];
    const last = frames[frames.length - 1];
    if (!last) return;
    radarTime = last.time * 1000;
    const url = `${j.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`;
    if (map.getLayer('radar')) map.removeLayer('radar');
    if (map.getSource('radar')) map.removeSource('radar');
    map.addSource('radar', { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 7, attribution: '<a href="https://www.rainviewer.com" target="_blank">RainViewer</a>' });
    map.addLayer({
      id: 'radar', type: 'raster', source: 'radar',
      layout: { visibility: app.layers.radar ? 'visible' : 'none' },
      paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.35, 'raster-resampling': 'linear' },
    }, 'quake-fill');
  } catch { /* radar is optional */ }
}

// ---------------------------------------------------------------------------
// World events

function updateWorld() {
  const w = picture.world;
  if (!w) return;
  const now = Date.now();
  sources.quakes.setData(fc(w.quakes.map((q): GeoJSON.Feature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [q.lon, q.lat] },
    properties: { id: q.id, mag: q.mag, ageH: (now - q.time) / 3_600_000 },
  })).sort((a, b) => (a.properties!.mag as number) - (b.properties!.mag as number))));
  sources.disasters.setData(fc(w.disasters.map((d) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
    properties: { id: d.id, alert: d.alert, label: `${d.type}${d.name && !d.name.startsWith(d.type) ? ' ' + d.name : ''}` },
  }))));
  // ISS ground track, split at the antimeridian.
  const past: [number, number][][] = [[]], future: [number, number][][] = [[]];
  const t = now / 1000;
  for (let i = 0; i < w.iss.length; i++) {
    const p = w.iss[i];
    const target = p.t <= t ? past : future;
    const seg = target[target.length - 1];
    const prev = seg[seg.length - 1];
    if (prev && Math.abs(prev[0] - p.lon) > 180) target.push([]);
    target[target.length - 1].push([p.lon, p.lat]);
    if (p.t <= t && w.iss[i + 1] && w.iss[i + 1].t > t) future[0].push([p.lon, p.lat]);
  }
  const lines = [
    ...past.filter((s) => s.length > 1).map((c) => ({ type: 'Feature' as const, properties: { part: 'past' }, geometry: { type: 'LineString' as const, coordinates: c } })),
    ...future.filter((s) => s.length > 1).map((c) => ({ type: 'Feature' as const, properties: { part: 'future' }, geometry: { type: 'LineString' as const, coordinates: c } })),
  ];
  sources['iss-track'].setData(fc(lines));
}

/** The ISS's position now, interpolated between one-minute samples. */
export function issNow(): { lat: number; lon: number; alt: number; vel: number } | null {
  const tr = picture.world?.iss;
  if (!tr?.length) return null;
  const t = Date.now() / 1000;
  for (let i = 0; i < tr.length - 1; i++) {
    const a = tr[i], b = tr[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      let dl = b.lon - a.lon;
      if (dl > 180) dl -= 360;
      if (dl < -180) dl += 360;
      let lon = a.lon + dl * f;
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      return { lat: a.lat + (b.lat - a.lat) * f, lon, alt: a.alt + (b.alt - a.alt) * f, vel: a.vel };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tracks: the render loop

let needsFull = true;
let lastDraw = 0;
let visibleAir = 0;
let visibleSea = 0;
export const counts = { air: 0, sea: 0, airAll: 0, seaAll: 0 };

const ICON_SIZE: Record<string, number> = {
  heavy: 1.12, jet: 0.92, biz: 0.78, light: 0.66, heli: 0.78, glider: 0.78, balloon: 0.6, drone: 0.55, fighter: 0.8, unknown: 0.72,
};

export function acHidden(a: Aircraft): boolean {
  const h = app.hidden;
  if (!h.size) return false;
  const ground = (a.row[A.flags] & AF.ground) !== 0;
  if (ground && h.has('ground')) return true;
  if ((a.row[A.flags] & AF.mil) && h.has('military')) return true;
  return h.has(a.cls);
}

function inView(b: maplibregl.LngLatBounds | null, x: number, y: number) {
  if (!b) return true;
  const w = b.getWest(), e = b.getEast();
  if (y < b.getSouth() - 1 || y > b.getNorth() + 1) return false;
  if (e - w >= 360) return true;
  let xx = x;
  while (xx < w - 1) xx += 360;
  while (xx > e + 1) xx -= 360;
  return xx >= w - 1 && xx <= e + 1;
}

function frame(t: number) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const z = map.getZoom();
  // Redraw rate scales with how much is on screen: smooth when zoomed in,
  // thrifty with ten thousand aircraft on the globe.
  const n = visibleAir + visibleSea;
  const interval = n > 6000 ? 1000 : n > 2500 ? 500 : n > 800 ? 200 : z > 6 ? 50 : 120;
  animatePulse(t);
  updateIss();
  if (!needsFull && t - lastDraw < interval) {
    updateSelectionOnly();
    return;
  }
  lastDraw = t;
  needsFull = false;
  drawTracks(z);
}

function viewBounds(z: number): maplibregl.LngLatBounds | null {
  if (z < 2.5) return null;
  try { return map.getBounds(); } catch { return null; }
}

function drawTracks(z: number) {
  const b = viewBounds(z);
  const sel = app.selection;
  const selId = sel && (sel.kind === 'air' || sel.kind === 'sea') ? sel.id : '';
  picture.advance((tr) => tr.id === selId || inView(b, tr.x, tr.y));
  const nowS = (Date.now()) / 1000;
  const air: GeoJSON.Feature[] = [];
  const sea: GeoJSON.Feature[] = [];
  const labels: GeoJSON.Feature[] = [];
  const wantLabels = app.layers.labels && z >= 5.5;
  let ca = 0, cs = 0;
  if (app.layers.aircraft) {
    for (const a of picture.aircraft.values()) {
      if (acHidden(a)) continue;
      if (a.id !== selId && !inView(b, a.x, a.y)) continue;
      const r = a.row;
      const ground = (r[A.flags] & AF.ground) !== 0;
      const em = (r[A.flags] & AF.emergency) !== 0;
      const alt = ground ? -1 : (r[A.alt] ?? r[A.altGeom] ?? 0);
      const stale = nowS - a.posT > a.staleAfter;
      ca++;
      air.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.x, a.y] },
        properties: {
          id: a.id, icon: a.cls, size: ICON_SIZE[a.cls], rot: r[A.trk] ?? 0, alt, em, stale,
          sel: a.id === selId, sort: a.id === selId ? 1e6 : em ? 1e5 : alt,
        },
      });
      if (wantLabels && (z >= 7 || a.id === selId || em)) {
        const name = r[A.cs] || r[A.reg] || r[A.hex].toUpperCase();
        labels.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [a.x, a.y] },
          properties: { name, sub: [altitude(r[A.alt], ground), r[A.type]].filter(Boolean).join('  '), sort: a.id === selId ? -1 : -alt },
        });
      }
    }
  }
  if (app.layers.ships) {
    for (const s of picture.ships.values()) {
      if (s.id !== selId && !inView(b, s.x, s.y)) continue;
      const r = s.row;
      cs++;
      sea.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.x, s.y] },
        properties: {
          id: s.id, still: s.still, rot: r[S.hdg] ?? r[S.cog] ?? 0, sel: s.id === selId,
          stale: nowS - s.posT > s.staleAfter, sort: s.still ? 0 : 1,
        },
      });
      if (wantLabels && z >= 9 && r[S.name]) {
        labels.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [s.x, s.y] },
          properties: { name: r[S.name], sub: s.still ? 'moored / at anchor' : `${Math.round(r[S.sog] ?? 0)} kt`, sort: 1e5 },
        });
      }
    }
  }
  visibleAir = ca;
  visibleSea = cs;
  counts.air = ca; counts.sea = cs;
  counts.airAll = picture.aircraft.size; counts.seaAll = picture.ships.size;
  sources.aircraft.setData(fc(air));
  sources.ships.setData(fc(sea));
  sources.labels.setData(fc(labels));
  updateSelectionOnly();
}

// ---------------------------------------------------------------------------
// Selection extras

let selHistory: HistoryPoint[] = [];
let selHistoryFor = '';
export let routeInfo: RouteDraw | null = null;
export interface RouteDraw { from: [number, number, string]; to: [number, number, string] }

export function setRoute(r: RouteDraw | null) {
  routeInfo = r;
  drawRoute();
}

function drawRoute() {
  const sel = app.selection;
  const tr = sel?.kind === 'air' ? picture.aircraft.get(sel.id) : null;
  if (!routeInfo || !tr) {
    sources.route.setData(fc());
    sources['route-pts'].setData(fc());
    return;
  }
  const [flat, flon, fcode] = routeInfo.from;
  const [tlat, tlon, tcode] = routeInfo.to;
  sources.route.setData(fc([
    { type: 'Feature', properties: { part: 'flown' }, geometry: { type: 'LineString', coordinates: greatCircle(flat, flon, tr.y, tr.x, 48) } },
    { type: 'Feature', properties: { part: 'ahead' }, geometry: { type: 'LineString', coordinates: greatCircle(tr.y, tr.x, tlat, tlon, 96) } },
  ]));
  sources['route-pts'].setData(fc([
    { type: 'Feature', properties: { code: fcode }, geometry: { type: 'Point', coordinates: [flon, flat] } },
    { type: 'Feature', properties: { code: tcode }, geometry: { type: 'Point', coordinates: [tlon, tlat] } },
  ]));
}

async function loadSelectionExtras() {
  const sel = app.selection;
  selHistory = [];
  selHistoryFor = '';
  routeInfo = null;
  sources.trail?.setData(fc());
  sources.route?.setData(fc());
  sources['route-pts']?.setData(fc());
  sources.leader?.setData(fc());
  if (!sel || (sel.kind !== 'air' && sel.kind !== 'sea')) {
    sources.sel?.setData(fc());
    return;
  }
  const id = sel.id;
  const url = sel.kind === 'air' ? `/api/history/air/${id.slice(2)}` : `/api/history/sea/${id.slice(2)}`;
  try {
    const h = (await (await fetch(url)).json()) as HistoryPoint[];
    if (app.selection?.id !== id) return;
    selHistory = h;
    selHistoryFor = id;
    historyListeners.forEach((fn) => fn(h));
  } catch { /* none */ }
}

const historyListeners = new Set<(h: HistoryPoint[]) => void>();
export function onHistory(fn: (h: HistoryPoint[]) => void) { historyListeners.add(fn); }
export function currentHistory() { return selHistoryFor === app.selection?.id ? selHistory : []; }

let lastTrailDraw = 0;
function updateSelectionOnly() {
  const sel = app.selection;
  if (!sel || (sel.kind !== 'air' && sel.kind !== 'sea')) return;
  const tr = picture.get(sel.id);
  if (!tr) return;
  picture.advance((t) => t === tr);
  sources.sel.setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [tr.x, tr.y] } }]));
  if (app.follow) map.setCenter([tr.x, tr.y]);
  const now = performance.now();
  if (now - lastTrailDraw < 250) return;
  lastTrailDraw = now;
  // Trail: server history plus the live point, one segment per pair so each
  // can carry its altitude colour.
  const pts = selHistoryFor === sel.id ? selHistory.slice() : [];
  const live: HistoryPoint = {
    t: tr.posT, lat: tr.y, lon: tr.x,
    alt: tr.kind === 'air' ? (((tr as Aircraft).row[A.flags] & AF.ground) ? 0 : (tr as Aircraft).row[A.alt]) : null, gs: tr.speed,
  };
  if (!pts.length || pts[pts.length - 1].t < tr.posT) {
    // keep recent live reports so the trail grows while watching
    if (selHistoryFor === sel.id) {
      const last = selHistory[selHistory.length - 1];
      if (!last || tr.posT - last.t >= 5) selHistory.push({ t: tr.posT, lat: tr.lat, lon: tr.lon, alt: live.alt, gs: tr.speed });
    }
  }
  pts.push(live);
  const segs: GeoJSON.Feature[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    let bl = b.lon;
    if (bl - a.lon > 180) bl -= 360;
    if (bl - a.lon < -180) bl += 360;
    // A gap of more than 10 minutes is a hole in coverage; don't draw a lie.
    if (b.t - a.t > 600 && distance(a.lat, a.lon, b.lat, b.lon) > 50 * NM) continue;
    segs.push({
      type: 'Feature',
      properties: { kind: tr.kind, alt: a.alt === 0 && tr.kind === 'air' ? -1 : (a.alt ?? 0) },
      geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [bl, b.lat]] },
    });
  }
  sources.trail.setData(fc(segs));
  // Look-ahead: where it will be in two minutes (ships: ten) on present course.
  if (tr.speed && tr.course !== null) {
    const ahead = tr.kind === 'air' ? 120 : 600;
    const end = greatCircleAhead(tr.y, tr.x, tr.course, tr.speed * 0.514444 * ahead);
    sources.leader.setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[tr.x, tr.y], end] } }]));
  } else sources.leader.setData(fc());
  if (routeInfo) drawRoute();
}

function greatCircleAhead(lat: number, lon: number, brg: number, m: number): [number, number] {
  const [la, lo] = destination(lat, lon, brg, m);
  let l = lo;
  if (l - lon > 180) l -= 360;
  if (l - lon < -180) l += 360;
  return [l, la];
}

// ---------------------------------------------------------------------------
// Pulses and ISS

function animatePulse(t: number) {
  const feats: GeoJSON.Feature[] = [];
  const now = Date.now();
  for (const a of picture.aircraft.values()) {
    if (a.row[A.flags] & AF.emergency) feats.push({ type: 'Feature', properties: { color: EMERGENCY }, geometry: { type: 'Point', coordinates: [a.x, a.y] } });
  }
  for (const q of picture.world?.quakes ?? []) {
    if (now - q.time < 3 * 3600_000 && q.mag >= 3) feats.push({ type: 'Feature', properties: { color: QUAKE }, geometry: { type: 'Point', coordinates: [q.lon, q.lat] } });
  }
  if (!feats.length) {
    if (pulseCount) { sources.pulse.setData(fc()); pulseCount = 0; }
    return;
  }
  const phase = (t % 2400) / 2400;
  map.setPaintProperty('pulse', 'circle-radius', 6 + phase * 26);
  map.setPaintProperty('pulse', 'circle-stroke-opacity', 0.7 * (1 - phase));
  if (pulseCount !== feats.length || t - lastPulseData > 1000) {
    sources.pulse.setData(fc(feats));
    pulseCount = feats.length;
    lastPulseData = t;
  }
}
let pulseCount = 0;
let lastPulseData = 0;

let lastIss = 0;
function updateIss() {
  const now = performance.now();
  if (now - lastIss < 500) return;
  lastIss = now;
  const p = issNow();
  if (!p) return;
  sources.iss.setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }]));
}

// ---------------------------------------------------------------------------
// Pointer

const PICKABLE = ['aircraft', 'ships', 'quakes', 'disasters', 'airports', 'iss'];

function toSelection(f: MapGeoJSONFeature): Selection | null {
  const id = f.properties?.id as string;
  switch (f.layer.id) {
    case 'aircraft': return { kind: 'air', id };
    case 'ships': return { kind: 'sea', id };
    case 'quakes': return { kind: 'quake', id };
    case 'disasters': return { kind: 'disaster', id };
    case 'airports': return { kind: 'airport', id };
    case 'iss': return { kind: 'iss', id: 'iss' };
  }
  return null;
}

function pick(point: maplibregl.Point): Selection | null {
  const layers = PICKABLE.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]];
  const feats = map.queryRenderedFeatures(box, { layers });
  if (!feats.length) return null;
  // Nearest wins, with tracks preferred over the background events.
  const rank = (l: string) => (l === 'aircraft' || l === 'ships' || l === 'iss' ? 0 : l === 'airports' ? 2 : 1);
  feats.sort((a, b) => rank(a.layer.id) - rank(b.layer.id));
  return toSelection(feats[0]);
}

function bindPointer() {
  let raf = 0;
  map.on('mousemove', (e) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const s = pick(e.point);
      map.getCanvas().style.cursor = s ? 'pointer' : '';
      app.setHover(s);
    });
  });
  map.on('mouseout', () => app.setHover(null));
  map.on('click', (e) => {
    const s = pick(e.point);
    app.select(s);
  });
  map.on('dragstart', () => { if (app.follow) app.setFollow(false); });
  map.on('moveend', reportView);
  map.on('move', () => { needsFull = true; });
  reportView();
}

function reportView() {
  const c = map.getCenter();
  const b = map.getBounds();
  // Radius of the view in nm, for the aggregator's detail polling.
  const r = Math.max(
    distance(c.lat, c.lng, b.getNorth(), c.lng),
    distance(c.lat, c.lng, c.lat, b.getEast()),
  ) / NM;
  picture.view = { lat: c.lat, lon: c.lng, r: map.getZoom() < 3 ? 5000 : Math.min(5000, r) };
}

// ---------------------------------------------------------------------------
// Camera

export function flyTo(lon: number, lat: number, zoom?: number) {
  const z = zoom ?? Math.max(map.getZoom(), 6.5);
  map.flyTo({ center: [lon, lat], zoom: z, speed: 1.1, curve: 1.5, essential: true });
}

export function altColorFor(a: Aircraft) {
  return altColor(a.row[A.alt], (a.row[A.flags] & AF.ground) !== 0);
}

export function shipColor(s: Ship) { return s.still ? SHIP_STILL : SHIP; }
