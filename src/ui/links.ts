// The address bar holds what is on screen, so a link opens the same picture:
//
//   #@51.4700,-0.4543,8.50/a:4ca7b4/layers:+weather,-ships
//
// a view (centre and zoom), a selection, and any layers that differ from the
// defaults. Older links (#a:<hex>, #s:<mmsi>) still work. Something a link
// names that isn't being tracked right now gets a note saying so, instead of
// a selection that silently never happens.

import { app, DEFAULT_LAYERS, type LayerKey, type Selection } from '../state/app.ts';
import { picture } from '../state/data.ts';
import { loadWeather } from '../state/weather.ts';
import { flyTo, getMap } from '../map/mapView.ts';
import { describe, toast } from './chrome.ts';
import * as F from '../lib/format.ts';

const CODES: [Selection['kind'], string][] = [
  ['quake', 'q'], ['disaster', 'd'], ['airport', 'ap'], ['news', 'n'], ['sat', 'sat'], ['launch', 'go'], ['wx', 'wx'], ['iss', 'iss'],
];

interface Parsed {
  view: { lat: number; lon: number; z: number } | null;
  sel: Selection | null;
  layers: Partial<Record<LayerKey, boolean>> | null;
}

export function parseHash(hash: string): Parsed {
  const out: Parsed = { view: null, sel: null, layers: null };
  for (const part of hash.replace(/^#/, '').split('/')) {
    if (!part) continue;
    let m = part.match(/^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
    if (m) {
      const lat = Number(m[1]), lon = Number(m[2]), z = Number(m[3]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && z >= 0 && z <= 16) out.view = { lat, lon, z };
      continue;
    }
    m = part.match(/^layers:(.+)$/);
    if (m) {
      out.layers = {};
      for (const t of m[1].split(',')) {
        const k = t.slice(1) as LayerKey;
        if ((t[0] === '+' || t[0] === '-') && k in DEFAULT_LAYERS) out.layers[k] = t[0] === '+';
      }
      continue;
    }
    m = part.match(/^([as]):([0-9a-f~]{6,7}|\d{6,9})$/i);
    if (m) {
      out.sel = { kind: m[1] === 'a' ? 'air' : 'sea', id: `${m[1]}:${m[2].toLowerCase()}` };
      continue;
    }
    if (part === 'iss') { out.sel = { kind: 'iss', id: 'iss' }; continue; }
    m = part.match(/^([a-z]+):(.+)$/);
    const kind = m && CODES.find(([, c]) => c === m![1])?.[0];
    if (kind) {
      try { out.sel = { kind, id: decodeURIComponent(m![2]) }; } catch { /* malformed */ }
    }
  }
  return out;
}

export function formatHash(view: Parsed['view'], sel: Selection | null, layers: Record<LayerKey, boolean>): string {
  const parts: string[] = [];
  if (view) parts.push(`@${view.lat.toFixed(4)},${view.lon.toFixed(4)},${view.z.toFixed(2)}`);
  if (sel) {
    if (sel.kind === 'air' || sel.kind === 'sea') parts.push(sel.id);
    else if (sel.kind === 'iss') parts.push('iss');
    else parts.push(`${CODES.find(([k]) => k === sel.kind)![1]}:${encodeURIComponent(sel.id)}`);
  }
  const diff = (Object.keys(DEFAULT_LAYERS) as LayerKey[]).filter((k) => !!layers[k] !== DEFAULT_LAYERS[k]);
  if (diff.length) parts.push(`layers:${diff.map((k) => (layers[k] ? '+' : '-') + k).join(',')}`);
  return parts.length ? `#${parts.join('/')}` : '';
}

/** True when the page was opened at a particular place or thing. */
export function linkedAtStart() {
  const p = parseHash(location.hash);
  return !!(p.view || p.sel);
}

let userMovedMap = false;
let applying = false;
let pending: { sel: Selection; give: number; fly: boolean } | null = null;
let writeTimer = 0;

function write() {
  if (applying) return;
  clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    const map = getMap();
    const c = map.getCenter();
    // The view joins the link once someone has moved the map, so the idle
    // spin doesn't fill the address bar.
    const view = userMovedMap ? { lat: c.lat, lon: c.lng, z: map.getZoom() } : null;
    const h = formatHash(view, app.selection ?? pending?.sel ?? null, app.layers);
    if (h === location.hash || (!h && !location.hash)) return;
    try { history.replaceState(null, '', h || location.pathname + location.search); } catch { /* ignore */ }
  }, 300);
}

function exists(s: Selection) {
  if (s.kind === 'air' || s.kind === 'sea') return !!picture.get(s.id);
  return describe(s.kind, s.id) !== null;
}

function where(s: Selection): [number, number] | null {
  if (s.kind === 'air' || s.kind === 'sea') {
    const t = picture.get(s.id);
    return t ? [t.x, t.y] : null;
  }
  return null;
}

function tryPending() {
  if (!pending) return;
  const { sel, fly } = pending;
  if (exists(sel)) {
    pending = null;
    app.select(sel);
    const p = where(sel);
    if (fly && p) flyTo(p[0], p[1], 8);
    return;
  }
  if (Date.now() > pending.give) {
    pending = null;
    const name = sel.kind === 'air' ? `Aircraft ${sel.id.slice(2).toUpperCase()}` : sel.kind === 'sea' ? `MMSI ${sel.id.slice(2)}` : sel.id;
    toast('Link', `${F.esc(name)} isn't being tracked right now. It may be out of receiver range, or the event has passed.`, null, 'info', 12_000);
    write();
  }
}

function apply(hash: string, first: boolean) {
  const p = parseHash(hash);
  applying = true;
  try {
    if (p.layers) app.applyLayers(p.layers);
    if (p.view) {
      userMovedMap = true;
      getMap().jumpTo({ center: [p.view.lon, p.view.lat], zoom: p.view.z });
    }
  } finally {
    applying = false;
  }
  if (!p.sel) {
    if (!first) app.select(null);
    return;
  }
  // A ship is only sent while in view, unless asked for by MMSI.
  if (p.sel.kind === 'sea') { picture.seaSel = Number(p.sel.id.slice(2)); picture.refreshSea(); }
  if (p.sel.kind === 'wx') loadWeather();
  pending = { sel: p.sel, give: Date.now() + (p.sel.kind === 'air' || p.sel.kind === 'sea' ? 45_000 : 30_000), fly: !p.view };
  tryPending();
}

export function initLinks() {
  const map = getMap();
  apply(location.hash, true);
  // Keep trying while data arrives; stop if the viewer picks something else.
  picture.on(() => tryPending());
  window.setInterval(() => { if (pending) tryPending(); }, 1000);
  app.on('selection', () => {
    if (pending && app.selection && (app.selection.kind !== pending.sel.kind || app.selection.id !== pending.sel.id)) pending = null;
    write();
  });
  app.on('layers', write);
  // Moves the app makes itself (the idle spin, follow) carry `auto`.
  map.on('moveend', (e: any) => {
    if (e.auto) return;
    userMovedMap = true;
    write();
  });
  window.addEventListener('hashchange', () => apply(location.hash, false));
}
