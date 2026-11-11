// Everything around the map: clock, caption, status line, legend, layers,
// search, alerts, about page and the opening title.

import { A, AF, S } from '../../shared/protocol.ts';
import { picture, reportAge, type Ship } from '../state/data.ts';
import { app, type AcFilter, type LayerKey } from '../state/app.ts';
import * as F from '../lib/format.ts';
import { CLASS_LABEL, SQUAWK_MEANING, tidyDesc } from '../lib/aircraft.ts';
import { shipType, NAV_STATUS } from '../lib/ais.ts';
import { silhouetteSvg } from '../map/icons.ts';
import { altGradientCss, tempGradientCss } from '../map/colors.ts';
import { weather } from '../state/weather.ts';
import { toggleWatched, watchlist } from '../state/watch.ts';
import { wxWords } from '../lib/weather.ts';
import { WX } from '../../shared/protocol.ts';
import { AIRPORTS, counts, flyTo, issNow, acHidden, getMap } from '../map/mapView.ts';
import { news } from '../state/news.ts';
import { space, countdown, SAT_KIND_LABEL } from '../state/space.ts';
import { storyList } from './panel.ts';
import { bearing, distance } from '../../shared/geo.ts';
import type { NewsItem } from '../../shared/protocol.ts';

const $ = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------------------
// Live boxes that refresh themselves every few seconds

const lastHtml = new WeakMap<HTMLElement, string>();

/** The element's identity by its data attributes, to find it again. */
function keyOf(e: Element): string | null {
  const attrs = [...e.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'id');
  if (!attrs.length) return null;
  return e.tagName.toLowerCase() + attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
}

/** Replace a box's HTML only if it changed, keeping keyboard focus and every
 * scroll position, so a refresh never throws a reader back to the top. */
function patch(el: HTMLElement, html: string) {
  if (lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  const scrolled = [el, ...el.querySelectorAll<HTMLElement>('*')]
    .filter((x) => x.scrollTop > 0)
    .map((x) => ({ k: x === el ? null : `${x.tagName}.${x.className}`, t: x.scrollTop }));
  const a = document.activeElement;
  const focus = a && a !== el && el.contains(a) ? keyOf(a) : null;
  el.innerHTML = html;
  for (const { k, t } of scrolled) {
    const x = k === null ? el : [...el.querySelectorAll<HTMLElement>('*')].find((y) => `${y.tagName}.${y.className}` === k);
    if (x) x.scrollTop = t;
  }
  if (focus) el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
}

/** Someone is pointing at, touching or scrolling this box: hold it still. */
function busy(el: HTMLElement) {
  return el.matches(':hover') || Number(el.dataset.busyUntil ?? 0) > Date.now();
}
function watchBusy(el: HTMLElement) {
  const mark = () => { el.dataset.busyUntil = String(Date.now() + 1500); };
  el.addEventListener('touchstart', mark, { passive: true });
  el.addEventListener('scroll', mark, { passive: true, capture: true });
}

// ---------------------------------------------------------------------------
// Clock

export function initClock() {
  const c = $('clock');
  const tick = () => { c.textContent = `${F.utc(Date.now(), true)} UTC`; };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Caption: what the pointer is on, else what is selected, else the picture.

export function initCaption() {
  const box = $('caption');
  const t = box.querySelector<HTMLElement>('.caption-t')!;
  const s = box.querySelector<HTMLElement>('.caption-s')!;
  let last = '';
  const set = (title: string, sub: string, live: boolean) => {
    const sig = title + '|' + sub;
    if (sig === last) return;
    const swapTitle = title !== t.textContent;
    last = sig;
    if (swapTitle) {
      box.classList.add('swap');
      setTimeout(() => {
        t.textContent = title; s.textContent = sub;
        box.classList.toggle('is-live', live);
        box.classList.remove('swap');
      }, 140);
    } else {
      s.textContent = sub;
    }
  };
  const update = () => {
    // A hovered aircraft the filters have since hidden doesn't count.
    const hov = app.hover?.kind === 'air' && (() => { const a = picture.aircraft.get(app.hover!.id); return !a || acHidden(a); })() ? null : app.hover;
    const target = hov ?? app.selection;
    if (target) {
      const d = describe(target.kind, target.id);
      if (d) return set(d[0], d[1], true);
    }
    const n = picture.aircraft.size, m = picture.world?.ships?.total ?? picture.ships.size;
    if (!n && !m) return set('Listening…', 'gathering the world’s transponders', false);
    let airborne = 0, est = 0;
    for (const a of picture.aircraft.values()) {
      if (a.est) est++;
      else if (!(a.row[A.flags] & AF.ground) && reportAge(a) < a.staleAfter) airborne++;
    }
    const q = picture.world?.quakes.filter((x) => Date.now() - x.time < 86_400_000).length ?? 0;
    set(`${F.n0(airborne)} aircraft aloft`, `${est ? `${F.n0(est)} more estimated beyond range · ` : ''}${F.n0(m)} ships · ${q} earthquakes today`, false);
  };
  app.on('hover', update);
  app.on('selection', update);
  setInterval(update, 1000);
  update();
}

export function describe(kind: string, id: string): [string, string] | null {
  if (kind === 'air') {
    const a = picture.aircraft.get(id);
    if (!a) return null;
    const r = a.row;
    const ground = (r[A.flags] & AF.ground) !== 0;
    const what = r[A.desc] ? tidyDesc(r[A.desc]) : r[A.type] || CLASS_LABEL[a.cls];
    const em = r[A.flags] & AF.emergency ? ` · squawk ${r[A.sq]}` : '';
    if (r[A.flags] & AF.approx) return [r[A.cs] || r[A.reg] || r[A.hex].toUpperCase(), `${what} · ${F.altitude(r[A.alt])} · rough position only (Mode S, no position broadcast)`];
    if (a.est) return [r[A.cs] || r[A.reg] || r[A.hex].toUpperCase(), `${what} · estimated position, out of receiver range ${F.ago(reportAge(a)).replace(' ago', '')}`];
    return [r[A.cs] || r[A.reg] || r[A.hex].toUpperCase(), `${what} · ${F.altitude(r[A.alt], ground)}${ground ? '' : ' · ' + F.speed(r[A.gs])}${em}`];
  }
  if (kind === 'sea') {
    const s = picture.ships.get(id);
    if (!s) return null;
    const r = s.row;
    const st = NAV_STATUS[r[S.nav]];
    return [r[S.name] || `MMSI ${r[S.mmsi]}`, `${shipType(r[S.type]).label}${s.still ? ` · ${st || 'stationary'}` : ` · ${F.n1(r[S.sog] ?? 0)} kt`}${r[S.dest] ? ' → ' + r[S.dest] : ''}`];
  }
  if (kind === 'quake') {
    const q = picture.world?.quakes.find((x) => x.id === id);
    if (!q) return null;
    return [`M${q.mag.toFixed(1)} earthquake`, `${q.place} · ${F.ago((Date.now() - q.time) / 1000)} · ${F.n0(q.depth)} km deep`];
  }
  if (kind === 'disaster') {
    const d = picture.world?.disasters.find((x) => x.id === id);
    if (!d) return null;
    return [d.name, `${d.type} · ${d.alert} alert · ${d.country}`];
  }
  if (kind === 'airport') {
    const ap = AIRPORTS.find((x) => x[0] === id);
    if (!ap) return null;
    return [ap[1] || ap[0], `${ap[2]}${ap[3] ? ' · ' + ap[3] : ''}`];
  }
  if (kind === 'news') {
    const items = news.at(id);
    if (!items.length) return null;
    return [id, `${items.length > 1 ? `${items.length} stories · ` : ''}${items[0].title}`];
  }
  if (kind === 'sat') {
    const sat = space.get(id);
    const p = sat && space.pos(sat);
    if (!sat) return null;
    return [sat.name, `${SAT_KIND_LABEL[sat.kind]}${p ? ` · ${F.n0(p.alt)} km up · ${F.n0(p.vel)} km/h` : ''}`];
  }
  if (kind === 'launch') {
    const l = space.launches.find((x) => x.id === id);
    if (!l) return null;
    return [l.name, `${l.location} · ${countdown(l.net)} · ${l.statusName || l.status}`];
  }
  if (kind === 'wx') {
    const r = weather.byId.get(id);
    if (!r) return null;
    const ap = AIRPORTS.find((x) => x[0] === id);
    const t = r[WX.temp], wd = r[WX.wdir], ws = r[WX.wspd];
    const wind = ws === null ? '' : ws === 0 ? 'calm' : `wind ${wd === -1 || wd === null ? 'variable' : F.heading(wd)} ${ws} kt${r[WX.gust] ? ` gusting ${r[WX.gust]}` : ''}`;
    const words = wxWords(r[WX.wx]);
    return [`${t !== null ? `${Math.round(t)}°C · ` : ''}${ap ? ap[1] || id : id}`,
      [words && words.charAt(0).toUpperCase() + words.slice(1), wind, `observed ${F.ago(Date.now() / 1000 - r[WX.t])}`].filter(Boolean).join(' · ')];
  }
  if (kind === 'iss') {
    const p = issNow();
    return ['International Space Station', p ? `${F.n0(p.alt)} km up · ${F.n0(p.vel)} km/h` : 'in orbit'];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status line and legend

export function initStatus() {
  const el = $('status');
  const draw = () => {
    const w = picture.world;
    const srcs = w?.sources ?? [];
    const air = srcs.filter((s) => s.kind === 'air');
    const okAir = air.filter((s) => s.ok).length;
    const os = srcs.find((s) => s.id === 'opensky');
    const stale = Date.now() - picture.lastAirOk > 15_000;
    const cls = !picture.connected || stale ? 'off' : okAir === air.length ? 'live' : 'warn';
    const label = !picture.connected ? 'Offline' : stale ? 'Reconnecting' : os && !os.ok ? 'Live · regional' : 'Live';
    patch(el, `<button data-act="about" title="Sources"><span class="dot ${cls}"></span>${label}</button>
      <span>${F.n0(counts.airAll)} aircraft</span><span>${F.n0(counts.seaAll)} ships</span>`);
  };
  draw();
  setInterval(draw, 2000);
  const lg = $('legend');
  const drawLegend = () => {
    lg.innerHTML = `<div>Altitude</div><div class="ramp" style="background:${altGradientCss()}"></div>
    <div class="ticks"><span>0</span><span>10k</span><span>20k</span><span>30k</span><span>45k ft</span></div>${app.layers.weather ? `
    <div class="lg2">Air temperature</div><div class="ramp" style="background:${tempGradientCss()}"></div>
    <div class="ticks"><span>−40</span><span>−20</span><span>0</span><span>20</span><span>40 °C</span></div>` : ''}`;
  };
  drawLegend();
  app.on('layers', drawLegend);
}

// ---------------------------------------------------------------------------
// Layers

const LAYER_INFO: [LayerKey, string, string, string][] = [
  ['aircraft', 'Aircraft', 'Coloured by altitude; shape by type', ''],
  ['ships', 'Ships', 'Teal when under way, pale when moored or anchored. Those in view, up to 12,000', ''],
  ['labels', 'Labels', 'Callsigns and names when zoomed in', ''],
  ['trails', 'Trail', 'Where the selected track has been', 'T'],
  ['airports', 'Airports', '3,300 with scheduled service', 'A'],
  ['quakes', 'Earthquakes', 'USGS, M2.5+ today and M4.5+ this week', 'E'],
  ['disasters', 'Disasters', 'GDACS cyclones, floods, volcanoes, fires', ''],
  ['news', 'News', 'Headlines about flying, shipping and the world, pinned where they happen', ''],
  ['iss', 'Space station', 'The ISS and its ground track', ''],
  ['space', 'Spacecraft and launches', 'Stations, crew and cargo ships, bright satellites (CelesTrak orbits) and upcoming launches', 'S'],
  ['winds', 'Winds aloft', 'Wind measured by aircraft in flight, last 10 min; arrows point downwind', 'W'],
  ['weather', 'Weather now', 'Measured at about 5,000 stations worldwide (METAR): temperature, wind, and a ring where it is raining, snowing, storming or foggy', 'C'],
  ['clouds', 'Satellite clouds', 'Infrared picture from the geostationary satellites (EUMETSAT), every 3 hours', 'V'],
  ['radar', 'Weather radar', 'Latest rain and snow, RainViewer', 'R'],
  ['night', 'Day and night', 'Terminator with civil, nautical and astronomical twilight', 'N'],
];

const FILTERS: [AcFilter, string, string][] = [
  ['jet', 'Airliners', 'jet'], ['heavy', 'Wide-body', 'heavy'], ['biz', 'Business', 'biz'], ['light', 'Light', 'light'],
  ['heli', 'Helicopters', 'heli'], ['fighter', 'Fast jets', 'fighter'], ['glider', 'Gliders', 'glider'],
  ['drone', 'Drones', 'drone'], ['unknown', 'Unknown', 'unknown'], ['military', 'Military', 'fighter'], ['ground', 'On ground', 'unknown'],
];

export function toggleLayersPanel(force?: boolean) {
  const el = $('layers');
  const show = force ?? el.hidden;
  el.hidden = !show;
  document.querySelector('[data-act="layers"]')?.setAttribute('aria-pressed', String(show));
  if (show) drawLayers();
}

function drawLayers() {
  const el = $('layers');
  if (el.hidden) return;
  const n: Record<string, number> = {};
  for (const a of picture.aircraft.values()) {
    n[a.cls] = (n[a.cls] ?? 0) + 1;
    if (a.row[A.flags] & AF.mil) n.military = (n.military ?? 0) + 1;
    if (a.row[A.flags] & AF.ground) n.ground = (n.ground ?? 0) + 1;
  }
  const lc: Partial<Record<LayerKey, number>> = {
    aircraft: picture.aircraft.size, ships: picture.world?.ships?.total ?? picture.ships.size, quakes: picture.world?.quakes.length,
    disasters: picture.world?.disasters.length, airports: AIRPORTS.length, news: news.items.filter((i) => i.place).length, space: space.sats.length + space.launches.length,
    ...(weather.stations.length ? { weather: weather.stations.length } : {}),
  };
  // Say how old the weather is, since it is only as new as its last report.
  const desc: Partial<Record<LayerKey, string>> = {
    ...(weather.clouds ? { clouds: `Infrared picture from the geostationary satellites (EUMETSAT), every 3 hours; this one ${new Date(weather.clouds).toISOString().slice(11, 16)} UTC, ${F.ago((Date.now() - weather.clouds) / 1000)}` } : {}),
  };
  patch(el, `
    <h3>Layers</h3>
    ${LAYER_INFO.map(([k, name, info, key]) => `
      <div class="tog" role="switch" tabindex="0" aria-checked="${app.layers[k]}" data-layer="${k}">
        <span class="name">${name}${lc[k] !== undefined ? `<span class="count">${F.n0(lc[k]!)}</span>` : ''}${key ? `<kbd>${key}</kbd>` : ''}</span>
        <span class="sw"></span>
        <span class="desc">${desc[k] ?? info}</span>
      </div>`).join('')}
    <h3>Show aircraft</h3>
    <div class="tog" role="switch" tabindex="0" aria-checked="${app.milOnly}" data-milonly="1">
      <span class="name">Military only<span class="count">${F.n0(n.military ?? 0)}</span><kbd>M</kbd></span>
      <span class="sw"></span>
      <span class="desc">Aircraft flagged military by the networks, the airframe database or their ICAO address block</span>
    </div>
    <div class="chips">
      ${FILTERS.map(([k, label, icon]) => `<button class="fchip" data-filter="${k}" aria-pressed="${!app.hidden.has(k)}">${silhouetteSvg(icon, 13)}${label}<span class="n">${F.n0(n[k] ?? 0)}</span></button>`).join('')}
    </div>`);
}

export function initLayers() {
  const el = $('layers');
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tog = t.closest<HTMLElement>('[data-layer]');
    if (tog) { const k = tog.dataset.layer as LayerKey; app.setLayer(k, !app.layers[k]); drawLayers(); }
    if (t.closest('[data-milonly]')) { app.setMilOnly(!app.milOnly); drawLayers(); }
    const f = t.closest<HTMLElement>('[data-filter]');
    if (f) { app.toggleFilter(f.dataset.filter as AcFilter); drawLayers(); }
  });
  el.addEventListener('keydown', (e) => {
    const tog = (e.target as HTMLElement).closest<HTMLElement>('[data-layer], [data-milonly]');
    if (tog && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tog.click(); }
  });
  setInterval(drawLayers, 3000);
}

// ---------------------------------------------------------------------------
// Search

interface Hit { kind: string; id: string; title: string; sub: string; right: string; icon: string; score: number; lon: number; lat: number }

export function openSearch() {
  const el = $('search');
  el.hidden = false;
  el.innerHTML = `<div class="search-box">
      <input type="search" placeholder="Callsign, registration, ship, airport…" autocomplete="off" spellcheck="false" aria-label="Search"
        role="combobox" aria-controls="search-results" aria-expanded="false" aria-autocomplete="list" />
      <div class="results" id="search-results" role="listbox" aria-label="Results"></div>
      <div class="hint">↑ ↓ to move · Enter to go · Esc to close</div>
    </div>`;
  const input = el.querySelector('input')!;
  const list = el.querySelector<HTMLElement>('.results')!;
  let hits: Hit[] = [];
  let on = 0;
  const draw = () => {
    input.setAttribute('aria-expanded', String(hits.length > 0));
    if (hits.length) input.setAttribute('aria-activedescendant', `sr-${on}`);
    else input.removeAttribute('aria-activedescendant');
    list.innerHTML = hits.map((h, i) => `
      <div class="res${i === on ? ' on' : ''}" role="option" id="sr-${i}" aria-selected="${i === on}" data-i="${i}">
        <span class="ic">${h.icon}</span>
        <span><div class="t">${F.esc(h.title)}</div><div class="s">${F.esc(h.sub)}</div></span>
        <span class="r">${F.esc(h.right)}</span>
      </div>`).join('');
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const go = (h: Hit | undefined) => {
    if (!h) return;
    closeSearch();
    app.select({ kind: h.kind as any, id: h.id });
    flyTo(h.lon, h.lat, h.kind === 'airport' ? 10 : h.kind === 'quake' ? 6 : h.kind === 'news' ? 6 : h.kind === 'sat' ? 3 : h.kind === 'launch' ? 8 : 8.5);
  };
  // About 45,000 things to score: wait for a pause in typing.
  let typing = 0;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = window.setTimeout(() => { hits = search(input.value); on = 0; draw(); }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { on = Math.min(hits.length - 1, on + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { on = Math.max(0, on - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter') { clearTimeout(typing); if (!hits.length) hits = search(input.value); go(hits[on]); }
    if (e.key === 'Escape') closeSearch();
  });
  list.addEventListener('click', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (r) go(hits[Number(r.dataset.i)]);
  });
  el.onmousedown = (e) => { if (e.target === el) closeSearch(); };
  // Now, not next frame: on a slow device the first letters would be lost.
  input.focus();
}

export function closeSearch() {
  const el = $('search');
  el.hidden = true;
  el.innerHTML = '';
}

function search(q: string): Hit[] {
  q = q.trim().toUpperCase();
  if (q.length < 2) return [];
  const out: Hit[] = [];
  const score = (field: string, base: number) => {
    if (!field) return 0;
    const f = field.toUpperCase();
    if (f === q) return base + 3;
    if (f.startsWith(q)) return base + 2;
    if (f.includes(q)) return base + 1;
    return 0;
  };
  for (const a of picture.aircraft.values()) {
    if (acHidden(a)) continue;
    const r = a.row;
    const s = Math.max(score(r[A.cs], 10), score(r[A.reg], 9), score(r[A.hex], 8), score(r[A.sq], q.length === 4 ? 7 : 0), score(r[A.type], 4) * 0.9);
    if (!s) continue;
    out.push({
      kind: 'air', id: a.id, title: r[A.cs] || r[A.reg] || r[A.hex].toUpperCase(),
      sub: [r[A.desc] ? tidyDesc(r[A.desc]) : r[A.type] || CLASS_LABEL[a.cls], r[A.reg], F.altitude(r[A.alt], (r[A.flags] & AF.ground) !== 0)].filter(Boolean).join(' · '),
      right: r[A.sq] && SQUAWK_MEANING[r[A.sq]] && score(r[A.sq], 1) ? `Squawk ${r[A.sq]}` : 'Aircraft', icon: silhouetteSvg(a.cls, 20),
      score: s, lon: a.x, lat: a.y,
    });
  }
  for (const sh of picture.ships.values()) {
    const r = sh.row;
    const s = Math.max(score(r[S.name], 9), score(String(r[S.mmsi]), 8), score(r[S.imo] ? String(r[S.imo]) : '', 8), score(r[S.callsign], 7), score(r[S.dest], 3));
    if (!s) continue;
    out.push({
      kind: 'sea', id: sh.id, title: r[S.name] || `MMSI ${r[S.mmsi]}`, sub: [shipType(r[S.type]).label, r[S.dest] && `→ ${r[S.dest]}`].filter(Boolean).join(' · '),
      right: 'Ship', icon: silhouetteSvg('ship', 18, 'var(--sea)'), score: s, lon: sh.x, lat: sh.y,
    });
  }
  for (const ap of AIRPORTS) {
    const s = Math.max(score(ap[1], 9), score(ap[0], 8.5), score(ap[2], 5), score(ap[3], 6));
    if (!s) continue;
    out.push({
      kind: 'airport', id: ap[0], title: `${ap[1] || ap[0]} · ${ap[3] || ap[2]}`, sub: ap[2], right: 'Airport',
      icon: '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
      score: s + (ap[8] === 1 ? 0.5 : 0), lon: ap[6], lat: ap[5],
    });
  }
  for (const qk of picture.world?.quakes ?? []) {
    const s = score(qk.place, 4);
    if (!s) continue;
    out.push({ kind: 'quake', id: qk.id, title: `M${qk.mag.toFixed(1)} · ${qk.place}`, sub: F.ago((Date.now() - qk.time) / 1000), right: 'Earthquake', icon: '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--quake)" stroke-width="1.4"/></svg>', score: s + qk.mag / 10, lon: qk.lon, lat: qk.lat });
  }
  for (const sat of space.sats) {
    const s = Math.max(score(sat.name, 7), score(String(sat.norad), 7));
    const p = s ? space.pos(sat) : null;
    if (!s || !p) continue;
    out.push({ kind: 'sat', id: `sat:${sat.norad}`, title: sat.name, sub: `${SAT_KIND_LABEL[sat.kind]} · ${F.n0(p.alt)} km up · NORAD ${sat.norad}`, right: 'Spacecraft', icon: silhouetteSvg('sat', 16), score: s + (sat.kind === 'satellite' ? 0 : 0.5), lon: p.lon, lat: p.lat });
  }
  for (const l of space.launches) {
    const s = Math.max(score(l.name, 5), score(l.provider, 4), score(l.location, 3));
    if (!s) continue;
    out.push({ kind: 'launch', id: l.id, title: l.name, sub: `${l.location} · ${countdown(l.net)}`, right: 'Launch', icon: silhouetteSvg('rocket', 16), score: s, lon: l.lon, lat: l.lat });
  }
  for (const n of news.items) {
    if (!n.place) continue;
    const s = score(n.title, 2);
    if (!s) continue;
    out.push({
      kind: 'news', id: n.place.name, title: n.title, sub: `${n.source} · ${F.ago((Date.now() - n.time) / 1000)} · ${n.place.name}`, right: 'News',
      icon: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="3" width="10" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 6h6M4 8.5h4" stroke="currentColor" stroke-width="1.1"/></svg>',
      score: s, lon: n.place.lon, lat: n.place.lat,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Alerts: new emergency squawks and strong earthquakes

/** A note in the corner. `tag` and `text` are HTML: escape what you pass. */
export function toast(tag: string, text: string, onClick: (() => void) | null = null, cls = '', ms = 30_000) {
  const box = $('alerts');
  const div = document.createElement('div');
  div.className = 'alert';
  div.innerHTML = `<span class="tag ${cls}">${tag}</span><span>${text}</span><button class="x" aria-label="Dismiss">×</button>`;
  div.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).classList.contains('x')) onClick?.();
    div.remove();
  });
  box.prepend(div);
  while (box.children.length > 3) box.lastElementChild!.remove();
  setTimeout(() => div.remove(), ms);
}

export function initAlerts() {
  const seen = new Set<string>();
  let primed = false;
  const show = (key: string, tag: string, text: string, onClick: () => void, cls = '') => {
    if (seen.has(key)) return;
    seen.add(key);
    if (!primed) return; // don't flood on first load: the posters cover those
    toast(tag, text, onClick, cls);
  };
  const check = () => {
    for (const a of picture.aircraft.values()) {
      const r = a.row;
      if (!(r[A.flags] & AF.emergency)) continue;
      show(`em:${a.id}:${r[A.emSince]}`, `Squawk ${r[A.sq] || 'emergency'}`,
        `${F.esc(r[A.cs] || r[A.reg] || r[A.hex])} · ${F.esc(SQUAWK_MEANING[r[A.sq]] ?? 'Emergency declared')}`,
        () => { app.select({ kind: 'air', id: a.id }); flyTo(a.x, a.y, 8); });
    }
    for (const q of picture.world?.quakes ?? []) {
      if (q.mag < 5.5 || Date.now() - q.time > 3 * 3600_000) continue;
      show(`q:${q.id}`, `M${q.mag.toFixed(1)}`, F.esc(q.place), () => { app.select({ kind: 'quake', id: q.id }); flyTo(q.lon, q.lat, 5); }, 'q');
    }
    for (const n of news.items) {
      if (!n.severe || n.topic === 'world' || Date.now() - n.time > 2 * 3600_000) continue;
      show(`n:${n.id}`, n.topic === 'air' ? 'Aviation' : 'Shipping', F.esc(n.title.length > 90 ? n.title.slice(0, 88) + '…' : n.title),
        () => { if (n.place) { app.select({ kind: 'news', id: n.place.name }); flyTo(n.place.lon, n.place.lat, 6); } else window.open(n.link, '_blank', 'noopener'); }, 'n');
    }
    if (picture.aircraft.size && picture.world && news.loaded) primed = true;
  };
  setInterval(check, 3000);
}

// ---------------------------------------------------------------------------
// About

let aboutTimer = 0;
const srcRows = () => (picture.world?.sources ?? []).map((s) => `
            <div class="src">
              <span class="dot ${s.ok ? '' : s.lastOk ? 'warn' : 'off'}"></span>
              <span class="nm">${F.esc(s.name)}</span>
              <span class="age">${s.lastOk ? F.ago((Date.now() - s.lastOk) / 1000) : 'not yet'}</span>
              <span class="meta">${F.esc([s.note, s.lastError && `last error: ${s.lastError}`].filter(Boolean).join(' · '))}</span>
            </div>`).join('');

export function openAbout() {
  const el = $('about');
  el.hidden = false;
  const draw = () => {
    el.innerHTML = `
      <button class="close" data-act="close-about">Close</button>
      <div class="about-in">
        <div>
          <h1>Watchman</h1>
          <p>A live picture of the planet’s traffic: every aircraft broadcasting ADS-B that a volunteer receiver can hear, ships reporting over AIS, earthquakes as they are recorded, disasters with an alert level, and the space station overhead.</p>
          <p>Nothing here is simulated. Each track is placed where it last reported and carried forward along its great circle at its reported speed until the next report: for 45 seconds when a nearby receiver hears it every few seconds, a little longer than the polling interval when only the worldwide feed sees it. Fade means stale. Over oceans and other gaps, airliners on a verified route are carried on as faded, clearly labelled estimates until receivers near their destination hear them again. Routes are only drawn when the aircraft is actually flying them, because route databases are often wrong.</p>
          <p>Coverage follows the volunteers. Europe and North America are dense; oceans, much of Africa and Central Asia are thin. Ships come from Open Waters AIS, an open network that merges government feeds, AISHub, aisstream.io and volunteer receivers, plus Finland's and Norway's own feeds. That covers most coasts and busy straits; the open ocean is out of reach of coastal receivers, so ships there appear when they near land.</p>
          <h4>Keys</h4>
          <div class="keys">
            <kbd>/</kbd><span>Search tracks, ships, airports and earthquakes</span>
            <kbd>I</kbd><span>Index: the picture right now, as posters</span>
            <kbd>H</kbd><span>Headlines: news about flying, shipping and the world</span>
            <kbd>O</kbd><span>Overhead: what is flying and sailing near you</span>
            <kbd>K</kbd><span>Log: spacecraft, launches, drones, military and emergencies</span>
            <kbd>S</kbd><span>Spacecraft and launches on the map</span>
            <kbd>L</kbd><span>Layers and filters</span>
            <kbd>F</kbd><span>Follow the selected track</span>
            <kbd>G</kbd><span>Back to the whole globe</span>
            <kbd>M</kbd><span>Military aircraft only</span>
            <kbd>W</kbd><span>Winds aloft, measured by aircraft</span>
            <kbd>C</kbd><span>Weather now, measured at stations</span>
            <kbd>V</kbd><span>Satellite clouds</span>
            <kbd>R</kbd><span>Weather radar</span>
            <kbd>N</kbd><span>Day and night</span>
            <kbd>Esc</kbd><span>Close, or clear the selection</span>
          </div>
        </div>
        <div>
          <h4>Sources, live</h4>
          <div id="about-src">${srcRows()}</div>
          <div class="src"><span class="dot"></span><span class="nm">CelesTrak, The Space Devs</span><span class="age">6 h · 30 min</span><span class="meta">orbital elements for stations, crew and cargo ships and bright satellites; upcoming launches (Launch Library 2)</span></div>
          <div class="src"><span class="dot"></span><span class="nm">News feeds</span><span class="age">every 10–20 min</span><span class="meta">${F.esc(news.feeds.map((f) => `${f.name}${f.ok ? '' : ' (not reachable)'}`).join(', ') || 'loading')}. Headlines link to the publisher.</span></div>
          <div class="src"><span class="dot"></span><span class="nm">Planespotters.net, adsbdb</span><span class="age">on demand</span><span class="meta">aircraft photos, airframes and filed routes</span></div>
          <div class="src"><span class="dot"></span><span class="nm">Wikidata, Wikimedia Commons</span><span class="age">on demand</span><span class="meta">ship particulars and photos, matched by IMO number</span></div>
          <div class="src"><span class="dot"></span><span class="nm">OpenFreeMap, OpenStreetMap, Natural Earth</span><span class="age"></span><span class="meta">basemap and relief</span></div>
          <div class="src"><span class="dot"></span><span class="nm">Ship data credits</span><span class="age"></span><span class="meta">Open Waters AIS (openwaters.io/ais), AISHub (aishub.net), aisstream.io, data delivered by BarentsWatch; contains data under the Norwegian licence for Open Government data (NLOD) distributed by the Norwegian Coastal Administration; Fintraffic / digitraffic.fi, CC BY 4.0</span></div>
          <div class="src"><span class="dot"></span><span class="nm">tar1090 aircraft database</span><span class="age">weekly</span><span class="meta">registration, type and operator for 620,000 airframes (Mictronics, wiedehopf)</span></div>
          <div class="src"><span class="dot"></span><span class="nm">OurAirports, ICAO, ITU</span><span class="age"></span><span class="meta">airports, address blocks by state, maritime identification digits</span></div>
          <h4>Units</h4>
          <p style="font-size:13px">Altitude is pressure altitude in feet (flight levels above 18,000 ft), speed is over the ground in knots, tracks and courses are degrees true, times are UTC.</p>
        </div>
      </div>`;
  };
  draw();
  // Only the live list refreshes, so reading and scrolling aren't disturbed.
  clearInterval(aboutTimer);
  aboutTimer = window.setInterval(() => {
    if (el.hidden) return clearInterval(aboutTimer);
    const box = el.querySelector('#about-src');
    const html = srcRows();
    if (box && box.innerHTML !== html) box.innerHTML = html;
  }, 3000);
  requestAnimationFrame(() => el.querySelector<HTMLElement>('[data-act="close-about"]')?.focus({ preventScroll: true }));
  el.onclick = (e) => { if ((e.target as HTMLElement).dataset.act === 'close-about') closeAbout(); };
  document.querySelector('[data-act="about"]')?.setAttribute('aria-pressed', 'true');
}
export function closeAbout() {
  $('about').hidden = true;
  document.querySelector('[data-act="about"]')?.setAttribute('aria-pressed', 'false');
}

// ---------------------------------------------------------------------------
// Intro

export function initIntro(ready: Promise<unknown>) {
  const word = document.querySelector('.intro-word')!;
  word.innerHTML = [...'Watchman'].map((c, i) => `<span style="animation-delay:${i * 45}ms">${c}</span>`).join('');
  const lines = $('intro-lines');
  const said = new Set<string>();
  const say = (k: string, s: string) => {
    if (said.has(k)) return;
    said.add(k);
    const d = document.createElement('div');
    d.textContent = s;
    lines.append(d);
    while (lines.children.length > 3) lines.firstElementChild!.remove();
  };
  say('start', 'Tuning in');
  const off = picture.on((w) => {
    if (w === 'air' && picture.aircraft.size) say('air', `${F.n0(picture.aircraft.size)} aircraft heard`);
    if (w === 'sea' && picture.ships.size) say('sea', `${F.n0(picture.ships.size)} ships`);
    if (w === 'world' && picture.world) say('world', `${picture.world.quakes.length} earthquakes this week`);
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    off();
    $('intro').classList.add('done');
    setTimeout(() => $('intro').remove(), 1200);
  };
  Promise.all([ready, new Promise((r) => setTimeout(r, 1600))]).then(() => {
    const wait = () => (picture.aircraft.size ? setTimeout(finish, 500) : setTimeout(wait, 250));
    wait();
  });
  setTimeout(finish, 9000);
}

// ---------------------------------------------------------------------------
// Keyboard

export function initKeys(handlers: { index: () => void; home: () => void }) {
  document.addEventListener('keydown', (e) => {
    const inField = (e.target as HTMLElement).closest('input, textarea');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
    if (inField) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') {
      if (!$('search').hidden) return closeSearch();
      if (!$('about').hidden) return closeAbout();
      if (!$('layers').hidden) return toggleLayersPanel(false);
      if (!$('news').hidden) return toggleNews(false);
      if (!$('nearby').hidden) return toggleNearby(false);
      if (!$('log').hidden) return toggleLog(false);
      if (!$('index').hidden) return handlers.index();
      return app.select(null);
    }
    if (!$('index').hidden && k !== 'i' && k !== 'I') return;
    if (k === '/') { e.preventDefault(); openSearch(); }
    else if (k === 'l' || k === 'L') toggleLayersPanel();
    else if (k === 'h' || k === 'H') toggleNews();
    else if (k === 'o' || k === 'O') toggleNearby();
    else if (k === 'k' || k === 'K') toggleLog();
    else if (k === 's' || k === 'S') app.setLayer('space', !app.layers.space);
    else if (k === 'i' || k === 'I') handlers.index();
    else if (k === '?') ($('about').hidden ? openAbout() : closeAbout());
    else if (k === 'f' || k === 'F') { if (app.selection) app.setFollow(!app.follow); }
    else if (k === 'g' || k === 'G') handlers.home();
    else if (k === 'r' || k === 'R') app.setLayer('radar', !app.layers.radar);
    else if (k === 'c' || k === 'C') app.setLayer('weather', !app.layers.weather);
    else if (k === 'v' || k === 'V') app.setLayer('clouds', !app.layers.clouds);
    else if (k === 'w' || k === 'W') app.setLayer('winds', !app.layers.winds);
    else if (k === 'm' || k === 'M') app.setMilOnly(!app.milOnly);
    else if (k === 'n' || k === 'N') app.setLayer('night', !app.layers.night);
    else if (k === 'a' || k === 'A') app.setLayer('airports', !app.layers.airports);
    else if (k === 'e' || k === 'E') app.setLayer('quakes', !app.layers.quakes);
    else if (k === 't' || k === 'T') app.setLayer('trails', !app.layers.trails);
  });
}


// ---------------------------------------------------------------------------
// Headlines: the news desk as a drawer, filterable by topic or by the view.

type NewsTab = 'all' | 'air' | 'sea' | 'world' | 'view';
let newsTab: NewsTab = 'all';
let newsSeen = 0;

export function toggleNews(force?: boolean) {
  const el = $('news');
  const show = force ?? el.hidden;
  if (show) { toggleNearby(false); toggleLog(false); }
  el.hidden = !show;
  document.querySelector('[data-act="news"]')?.setAttribute('aria-pressed', String(show));
  if (show) { newsSeen = Date.now(); drawNews(); }
  drawNewsBadge();
}

function drawNewsBadge() {
  const b = document.querySelector<HTMLElement>('[data-act="news"]');
  if (!b) return;
  const fresh = news.items.filter((i) => i.severe && i.topic !== 'world' && i.time > Math.max(newsSeen, Date.now() - 6 * 3600_000)).length;
  b.dataset.badge = fresh && $('news').hidden ? String(fresh) : '';
}

function newsInView(i: NewsItem): boolean {
  if (!i.place) return false;
  try { return getMap().getBounds().contains([i.place.lon, i.place.lat]); } catch { return false; }
}

function drawNews() {
  const el = $('news');
  if (el.hidden) return;
  const all = news.items;
  const list = newsTab === 'all' ? all : newsTab === 'view' ? all.filter(newsInView) : all.filter((i) => i.topic === newsTab);
  const n = (t: NewsTab) => (t === 'all' ? all.length : t === 'view' ? all.filter(newsInView).length : all.filter((i) => i.topic === t).length);
  const tabs: [NewsTab, string][] = [['all', 'All'], ['air', 'Flying'], ['sea', 'Shipping'], ['world', 'World'], ['view', 'On screen']];
  const live = news.feeds.filter((f) => f.ok).length;
  const scroll = el.querySelector('.stories')?.scrollTop ?? 0;
  el.innerHTML = `
    <div class="drawer-h"><h3>Headlines</h3><span>${live} of ${news.feeds.length} feeds live</span><button class="x" data-act="close-news" aria-label="Close">×</button></div>
    <div class="tabs" role="tablist">${tabs.map(([k, label]) => `<button role="tab" aria-selected="${newsTab === k}" data-tab="${k}">${label}<span>${n(k)}</span></button>`).join('')}</div>
    <div class="stories drawer-list">
      ${!news.loaded ? '<div class="empty">Gathering headlines…</div>' : !list.length ? `<div class="empty">${newsTab === 'view' ? 'No stories placed in this part of the map. Zoom out or pan.' : 'Nothing yet.'}</div>` : ''}
      ${list.slice(0, 150).map((i) => `
        <div class="story-row">
          ${storyList([i], 1)}
          ${i.place ? `<button class="on-map" data-place="${F.esc(i.place.name)}" title="Show on the map">${F.esc(i.place.name)} →</button>` : ''}
        </div>`).join('')}
    </div>
    <div class="drawer-f">Placed by the first city or country a headline names. Links open the publisher’s page.</div>`;
  const box = el.querySelector('.stories');
  if (box) box.scrollTop = scroll;
}

export function initNews() {
  const el = $('news');
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="close-news"]')) return toggleNews(false);
    const tab = t.closest<HTMLElement>('[data-tab]');
    if (tab) { newsTab = tab.dataset.tab as NewsTab; drawNews(); return; }
    const pl = t.closest<HTMLElement>('[data-place]');
    if (pl) {
      const item = news.at(pl.dataset.place!)[0];
      if (!item?.place) return;
      app.select({ kind: 'news', id: item.place.name });
      flyTo(item.place.lon, item.place.lat, item.place.kind === 'country' ? 4.5 : 7);
      if (window.innerWidth < 760) toggleNews(false);
    }
  });
  news.on(() => { drawNews(); drawNewsBadge(); });
  getMap().on('moveend', () => { if (newsTab === 'view') drawNews(); });
  news.start();
}

// ---------------------------------------------------------------------------
// Overhead: what is flying and sailing near you (or near the map's centre),
// with where to look: compass direction and angle above the horizon.

let me: { lat: number; lon: number; label: string } | null = null;
let nearbyTimer = 0;
let nearbyR = 60;

function loadMe() {
  try {
    const v = JSON.parse(localStorage.getItem('wf.me') ?? 'null');
    if (v && isFinite(v.lat) && isFinite(v.lon)) me = { lat: v.lat, lon: v.lon, label: 'your location' };
  } catch { /* ignore */ }
}

export function toggleNearby(force?: boolean) {
  const el = $('nearby');
  const show = force ?? el.hidden;
  if (show) { toggleNews(false); toggleLog(false); }
  el.hidden = !show;
  document.querySelector('[data-act="nearby"]')?.setAttribute('aria-pressed', String(show));
  clearInterval(nearbyTimer);
  if (show) {
    if (!me) loadMe();
    drawNearby(true);
    nearbyTimer = window.setInterval(() => drawNearby(), 2000);
  }
}

function locate() {
  const el = $('nearby');
  if (!navigator.geolocation) return;
  const b = el.querySelector<HTMLElement>('[data-act="locate"]');
  if (b) b.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition((p) => {
    // Rounded to about a kilometre: enough to look up, and kept on this device.
    me = { lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100, label: 'your location' };
    try { localStorage.setItem('wf.me', JSON.stringify({ lat: me.lat, lon: me.lon })); } catch { /* ignore */ }
    flyTo(me.lon, me.lat, 8.5);
    drawNearby(true);
  }, () => {
    if (b) b.textContent = 'Location refused';
  }, { maximumAge: 600_000, timeout: 15_000 });
}

function drawNearby(force = false) {
  const el = $('nearby');
  if (el.hidden) return;
  if (!force && busy(el)) return;
  const c = getMap().getCenter();
  const at = me ?? { lat: c.lat, lon: c.lng, label: 'the map centre' };
  const R = nearbyR * 1000;
  type Row = { id: string; kind: 'air' | 'sea'; d: number; brg: number; html: string; x: number; y: number };
  const rows: Row[] = [];
  for (const a of picture.aircraft.values()) {
    if (acHidden(a)) continue;
    const d = distance(at.lat, at.lon, a.y, a.x);
    if (d > R) continue;
    const r = a.row;
    const ground = (r[A.flags] & AF.ground) !== 0;
    const altM = ground ? 0 : (r[A.altGeom] ?? r[A.alt] ?? 0) * 0.3048;
    // Elevation above the horizon, allowing for the Earth's curve.
    const elev = ground ? 0 : (Math.atan2(altM - (d * d) / (2 * 6_371_000), Math.max(d, 1)) * 180) / Math.PI;
    const brg = bearing(at.lat, at.lon, a.y, a.x);
    const what = r[A.desc] ? tidyDesc(r[A.desc]) : r[A.type] || CLASS_LABEL[a.cls];
    rows.push({
      id: a.id, kind: 'air', d, brg, x: a.x, y: a.y,
      html: `<span class="ic">${silhouetteSvg(a.cls, 20)}</span>
        <span><div class="t">${F.esc(r[A.cs] || r[A.reg] || r[A.hex].toUpperCase())}</div><div class="s">${F.esc([what, F.altitude(r[A.alt], ground), ground ? '' : F.speed(r[A.gs])].filter(Boolean).join(' · '))}</div></span>
        <span class="r"><b>${F.km(d)}</b><br>${ground || elev < 0.5 ? F.compass(brg) : `${F.compass(brg)} · ${Math.round(elev)}° up`}</span>`,
    });
  }
  for (const sh of picture.ships.values()) {
    const d = distance(at.lat, at.lon, sh.y, sh.x);
    if (d > Math.min(R, 40_000)) continue;
    const r = sh.row;
    const brg = bearing(at.lat, at.lon, sh.y, sh.x);
    rows.push({
      id: sh.id, kind: 'sea', d, brg, x: sh.x, y: sh.y,
      html: `<span class="ic">${silhouetteSvg('ship', 18, 'var(--sea)')}</span>
        <span><div class="t">${F.esc(r[S.name] || `MMSI ${r[S.mmsi]}`)}</div><div class="s">${F.esc([shipType(r[S.type]).label, sh.still ? NAV_STATUS[r[S.nav]] || 'stationary' : `${F.n1(r[S.sog] ?? 0)} kt`, r[S.dest] && `→ ${r[S.dest]}`].filter(Boolean).join(' · '))}</div></span>
        <span class="r"><b>${F.km(d)}</b><br>${F.compass(brg)}</span>`,
    });
  }
  rows.sort((a, b) => a.d - b.d);
  const air = rows.filter((r) => r.kind === 'air'), sea = rows.filter((r) => r.kind === 'sea');
  const above = air.filter((r) => r.d < 15_000).length;
  const stories = news.near(at.lat, at.lon, 150).slice(0, 3);
  patch(el, `
    <div class="drawer-h"><h3>Overhead</h3><span>around ${F.esc(at.label)}</span><button class="x" data-act="close-nearby" aria-label="Close">×</button></div>
    <div class="near-sum">
      <div><b>${air.length}</b><span>aircraft within ${nearbyR} km</span></div>
      <div><b>${above}</b><span>within 15 km</span></div>
      <div><b>${sea.length}</b><span>ships within ${Math.min(nearbyR, 40)} km</span></div>
    </div>
    <div class="near-ctl">
      ${me ? '<button class="btn" data-act="use-centre">Use map centre</button>' : '<button class="btn" data-act="locate">Use my location</button>'}
      ${[25, 60, 150].map((k) => `<button class="btn" data-r="${k}" aria-pressed="${nearbyR === k}">${k} km</button>`).join('')}
    </div>
    <div class="results near-list">
      ${rows.slice(0, 60).map((r) => `<div class="res" role="button" tabindex="0" data-id="${r.id}" data-x="${r.x}" data-y="${r.y}">${r.html}</div>`).join('') || `<div class="empty">Nothing heard within ${nearbyR} km right now. Receiver coverage is thin in some places; try a wider radius.</div>`}
    </div>
    ${stories.length ? `<div class="deck-h"><span>News nearby</span><span>within 150 km</span></div><div class="stories">${storyList(stories, 3)}</div>` : ''}
    <div class="drawer-f">Direction is where to look from ${F.esc(at.label)}; the angle is height above the horizon, allowing for the Earth’s curve.${me ? ' Your location stays on this device.' : ''}</div>`);
}

export function initNearby() {
  watchBusy($('nearby'));
  keyActivate($('nearby'));
  const el = $('nearby');
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="close-nearby"]')) return toggleNearby(false);
    if (t.closest('[data-act="locate"]')) return locate();
    if (t.closest('[data-act="use-centre"]')) { me = null; try { localStorage.removeItem('wf.me'); } catch { /* ignore */ } return drawNearby(true); }
    const r = t.closest<HTMLElement>('[data-r]');
    if (r) { nearbyR = Number(r.dataset.r); return drawNearby(true); }
    const row = t.closest<HTMLElement>('[data-id]');
    if (row) {
      const id = row.dataset.id!;
      app.select({ kind: id.startsWith('a:') ? 'air' : 'sea', id });
      flyTo(Number(row.dataset.x), Number(row.dataset.y), Math.max(getMap().getZoom(), 9));
    }
  });
}

// ---------------------------------------------------------------------------
// Log: the unusual things in the sky right now (spacecraft, launches, drones,
// military aircraft, emergencies), and a running log of first sightings kept
// on this device.

interface LogEntry { t: number; kind: 'drone' | 'emergency' | 'launch' | 'mil' | 'space'; id: string; text: string }
let logEntries: LogEntry[] = [];
let logTimer = 0;
const logged = new Set<string>();
try { logEntries = JSON.parse(localStorage.getItem('wf.log') ?? '[]'); } catch { logEntries = []; }
for (const e of logEntries) logged.add(`${e.kind}:${e.id}:${new Date(e.t).toDateString()}`);

function addLog(kind: LogEntry['kind'], id: string, text: string) {
  const key = `${kind}:${id}:${new Date().toDateString()}`;
  if (logged.has(key)) return;
  logged.add(key);
  logEntries.unshift({ t: Date.now(), kind, id, text });
  logEntries = logEntries.slice(0, 200);
  try { localStorage.setItem('wf.log', JSON.stringify(logEntries)); } catch { /* ignore */ }
}

/** Watch for things worth a line in the log, whether or not it is open. */
function scanLog() {
  for (const a of picture.aircraft.values()) {
    const r = a.row;
    if (reportAge(a) > a.staleAfter) continue;
    const name = r[A.cs] || r[A.reg] || r[A.hex].toUpperCase();
    const what = r[A.desc] ? tidyDesc(r[A.desc]) : r[A.type] || CLASS_LABEL[a.cls];
    if (a.cls === 'drone') addLog('drone', a.id, `${name} · ${what} · ${F.altitude(r[A.alt], (r[A.flags] & AF.ground) !== 0)}`);
    if (r[A.flags] & AF.emergency) addLog('emergency', a.id, `${name} squawking ${r[A.sq]} · ${SQUAWK_MEANING[r[A.sq]] ?? 'emergency'}`);
    if ((r[A.flags] & AF.mil) && a.cls === 'fighter' && !(r[A.flags] & AF.ground)) addLog('mil', a.id, `${name} · ${what}`);
  }
  for (const l of space.launches) {
    if (l.net <= Date.now() && Date.now() - l.net < 6 * 3600_000 && (l.status === 'Go' || l.status === 'Success' || l.status === 'In Flight')) addLog('launch', l.id, `${l.name} · ${l.location}`);
  }
  for (const s of space.sats) if (s.kind === 'crew') addLog('space', `sat:${s.norad}`, `${s.name} in orbit`);
}

export function toggleLog(force?: boolean) {
  const el = $('log');
  const show = force ?? el.hidden;
  if (show) { toggleNews(false); toggleNearby(false); }
  el.hidden = !show;
  document.querySelector('[data-act="log"]')?.setAttribute('aria-pressed', String(show));
  clearInterval(logTimer);
  if (show) { drawLog(true); logTimer = window.setInterval(() => drawLog(), 2000); }
}

function drawLog(force = false) {
  const el = $('log');
  if (el.hidden) return;
  // Hold still while someone is pointing at a row, so clicks land.
  if (!force && busy(el)) return;
  const row = (kind: string, id: string, icon: string, t: string, sub: string, right: string, _x: number, _y: number, z: number) =>
    `<div class="res" role="button" tabindex="0" data-kind="${kind}" data-id="${F.esc(id)}" data-z="${z}"><span class="ic">${icon}</span><span><div class="t">${F.esc(t)}</div><div class="s">${F.esc(sub)}</div></span><span class="r">${right}</span></div>`;
  // Spacecraft: everything crewed or visiting a station, and telescopes.
  const craft = space.sats.filter((s) => s.kind !== 'satellite' && s.kind !== 'module').flatMap((s) => {
    const p = space.pos(s);
    return p ? [row('sat', `sat:${s.norad}`, silhouetteSvg(s.kind === 'telescope' ? 'sat' : 'iss', 18), s.name, `${SAT_KIND_LABEL[s.kind]} · ${F.n0(p.vel)} km/h`, `<b>${F.n0(p.alt)} km</b>`, p.lon, p.lat, 3)] : [];
  });
  const iss = issNow();
  if (iss && !space.sats.some((s) => s.norad === 25544)) craft.unshift(row('iss', 'iss', silhouetteSvg('iss', 18), 'ISS', 'Space station', `<b>${F.n0(iss.alt)} km</b>`, iss.lon, iss.lat, 3));
  const launches = space.launches.filter((l) => l.net > Date.now() - 3600_000).slice(0, 8)
    .map((l) => row('launch', l.id, silhouetteSvg('rocket', 16, l.crewed ? '#b3261e' : 'currentColor'), l.name, `${l.location} · ${l.statusName || l.status}`, `<b>${countdown(l.net)}</b>`, l.lon, l.lat, 8));
  const aloft = [...picture.aircraft.values()].filter((a) => !(a.row[A.flags] & AF.ground) && reportAge(a) < a.staleAfter);
  const acRow = (a: (typeof aloft)[number]) => {
    const r = a.row;
    return row('air', a.id, silhouetteSvg(a.cls, 20), r[A.cs] || r[A.reg] || r[A.hex].toUpperCase(),
      [r[A.desc] ? tidyDesc(r[A.desc]) : r[A.type] || CLASS_LABEL[a.cls], r[A.owner]].filter(Boolean).join(' · '),
      `<b>${F.altitude(r[A.alt])}</b>`, a.x, a.y, 8);
  };
  const drones = aloft.filter((a) => a.cls === 'drone');
  const em = aloft.filter((a) => a.row[A.flags] & AF.emergency);
  const mil = aloft.filter((a) => a.row[A.flags] & AF.mil);
  const fast = mil.filter((a) => a.cls === 'fighter');
  const milTypes = new Map<string, number>();
  for (const a of mil) { const t = a.row[A.type] || '?'; milTypes.set(t, (milTypes.get(t) ?? 0) + 1); }
  const topMil = [...milTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t} ${n}`).join(' · ');
  const sect = (title: string, right: string, body: string, empty: string) =>
    `<div class="deck-h log-h"><span>${title}</span><span>${right}</span></div><div class="results near-list">${body || `<div class="empty small">${empty}</div>`}</div>`;
  const icons: Record<LogEntry['kind'], string> = { drone: 'Drone', emergency: 'Squawk', launch: 'Launch', mil: 'Fast jet', space: 'In orbit' };
  // What this viewer is watching, tracked or not.
  const watching = [...watchlist.values()].map((w) => {
    const t = picture.get(w.id);
    const live = t && reportAge(t) < t.staleAfter;
    if (t && w.id.startsWith('a:')) {
      const a = t as (typeof aloft)[number];
      const ground = (a.row[A.flags] & AF.ground) !== 0;
      return row('air', w.id, silhouetteSvg(a.cls, 20), w.label, live ? (ground ? 'on the ground' : 'airborne') : 'last seen ' + F.ago(reportAge(t)), `<b>${F.altitude(a.row[A.alt], ground)}</b>`, t.x, t.y, 8);
    }
    if (t) return row('sea', w.id, silhouetteSvg('ship', 18), w.label, live ? ((t as Ship).still ? 'moored or at anchor' : 'under way') : 'last seen ' + F.ago(reportAge(t)), `<b>${F.n1(t.speed ?? 0)} kt</b>`, t.x, t.y, 9);
    return `<div class="res off" data-unwatch="${F.esc(w.id)}"><span class="ic"></span><span><div class="t">${F.esc(w.label)}</div><div class="s">not being tracked right now</div></span><span class="r"><button class="linkish" data-act="unwatch" data-id="${F.esc(w.id)}">stop</button></span></div>`;
  });
  patch(el, `
    <div class="drawer-h"><h3>Log</h3><span>unusual traffic, now</span><button class="x" data-act="close-log" aria-label="Close">×</button></div>
    <div class="drawer-list">
      ${watching.length ? sect('Watching', 'kept on this device', watching.join(''), '') : ''}
      ${em.length ? sect('Emergencies', `${em.length}`, em.map(acRow).join(''), '') : ''}
      ${sect('Spacecraft', `${space.sats.length ? `${space.sats.length} tracked` : 'ISS only'}`, craft.join(''), 'Orbits not loaded yet.')}
      ${sect('Next launches', 'Launch Library 2', launches.join(''), space.loaded ? 'No launches listed.' : 'Loading…')}
      ${sect('Drones aloft', `${drones.length}`, drones.slice(0, 20).map(acRow).join(''), 'No drone is broadcasting its position right now. Large military drones (Reaper, Global Hawk, Triton) appear when they transit with their transponder on.')}
      ${sect('Military aloft', `${mil.length}${topMil ? ` · ${F.esc(topMil)}` : ''}`, fast.slice(0, 20).map(acRow).join(''), 'No fast jets broadcasting. Use M on the map to see every military aircraft.')}
      <div class="deck-h log-h"><span>Sightings log</span><span>${logEntries.length ? `<button class="linkish" data-act="clear-log">clear</button>` : 'kept on this device'}</span></div>
      <div class="loglist">${logEntries.slice(0, 80).map((e) => `<div class="logrow" data-log="${F.esc(e.id)}" data-lk="${e.kind}"><span class="lt">${new Date(e.t).toUTCString().slice(5, 11)} ${F.utc(e.t)}</span><span class="lk lk-${e.kind}">${icons[e.kind]}</span><span class="lx">${F.esc(e.text)}</span></div>`).join('') || '<div class="empty small">First sightings of drones, emergencies, fast jets, launches and crew ships are written here, once a day each.</div>'}</div>
    </div>
    <div class="drawer-f">Tanks and other ground vehicles carry no public transponder, so no open source can show them. Aircraft and ships appear only when they broadcast.</div>`);
}

/** Rows that act like buttons answer Enter and Space too. */
function keyActivate(el: HTMLElement) {
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && t.getAttribute('role') === 'button' && t.tagName !== 'BUTTON') { e.preventDefault(); t.click(); }
  });
}

export function initLog() {
  const el = $('log');
  watchBusy(el);
  keyActivate(el);
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="close-log"]')) return toggleLog(false);
    if (t.closest('[data-act="clear-log"]')) { logEntries = []; logged.clear(); try { localStorage.removeItem('wf.log'); } catch { /* ignore */ } return drawLog(true); }
    const uw = t.closest<HTMLElement>('[data-act="unwatch"]');
    if (uw) { const w = watchlist.get(uw.dataset.id!); if (w) toggleWatched(w.id, w.label); return drawLog(true); }
    const r = t.closest<HTMLElement>('[data-kind]');
    if (r) {
      const kind = r.dataset.kind as 'air' | 'sea' | 'sat' | 'launch' | 'iss';
      const id = r.dataset.id!;
      // Where it is now, not where it was when the row was drawn.
      const sat = kind === 'sat' ? space.get(id) : undefined;
      const at = kind === 'air' || kind === 'sea' ? (() => { const a = picture.get(id); return a && { lon: a.x, lat: a.y }; })()
        : kind === 'launch' ? space.launches.find((l) => l.id === id)
        : kind === 'iss' ? issNow() : sat && space.pos(sat);
      app.select({ kind, id });
      if (at) flyTo(at.lon, at.lat, kind === 'sat' || kind === 'iss' ? Math.min(getMap().getZoom(), 3) : Number(r.dataset.z));
      return;
    }
    const lg = t.closest<HTMLElement>('[data-log]');
    if (lg) {
      const id = lg.dataset.log!, k = lg.dataset.lk;
      if (k === 'launch') { const l = space.launches.find((x) => x.id === id); if (l) { app.select({ kind: 'launch', id }); flyTo(l.lon, l.lat, 8); } return; }
      if (k === 'space') { const s = space.get(id); const p = s && space.pos(s); if (p) { app.select({ kind: 'sat', id }); flyTo(p.lon, p.lat, 3); } return; }
      const a = picture.aircraft.get(id);
      if (a) { app.select({ kind: 'air', id }); flyTo(a.x, a.y, 8); }
    }
  });
  setInterval(scanLog, 5000);
  space.start();
}
