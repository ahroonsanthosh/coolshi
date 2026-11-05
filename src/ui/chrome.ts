// Everything around the map: clock, caption, status line, legend, layers,
// search, alerts, about page and the opening title.

import { A, AF, S } from '../../shared/protocol.ts';
import { picture, reportAge } from '../state/data.ts';
import { app, type AcFilter, type LayerKey } from '../state/app.ts';
import * as F from '../lib/format.ts';
import { CLASS_LABEL, SQUAWK_MEANING, tidyDesc } from '../lib/aircraft.ts';
import { shipType, NAV_STATUS } from '../lib/ais.ts';
import { silhouetteSvg } from '../map/icons.ts';
import { altGradientCss } from '../map/colors.ts';
import { AIRPORTS, counts, flyTo, issNow, acHidden } from '../map/mapView.ts';

const $ = (id: string) => document.getElementById(id)!;

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
    const target = app.hover ?? app.selection;
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
    el.innerHTML = `<button data-act="about" title="Sources"><span class="dot ${cls}"></span>${label}</button>
      <span>${F.n0(counts.airAll)} aircraft</span><span>${F.n0(counts.seaAll)} ships</span>`;
  };
  draw();
  setInterval(draw, 2000);
  const lg = $('legend');
  lg.innerHTML = `<div>Altitude</div><div class="ramp" style="background:${altGradientCss()}"></div>
    <div class="ticks"><span>0</span><span>10k</span><span>20k</span><span>30k</span><span>45k ft</span></div>`;
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
  ['iss', 'Space station', 'The ISS and its ground track', ''],
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
    disasters: picture.world?.disasters.length, airports: AIRPORTS.length,
  };
  el.innerHTML = `
    <h3>Layers</h3>
    ${LAYER_INFO.map(([k, name, desc, key]) => `
      <div class="tog" role="switch" tabindex="0" aria-checked="${app.layers[k]}" data-layer="${k}">
        <span class="name">${name}${lc[k] !== undefined ? `<span class="count">${F.n0(lc[k]!)}</span>` : ''}${key ? `<kbd>${key}</kbd>` : ''}</span>
        <span class="sw"></span>
        <span class="desc">${desc}</span>
      </div>`).join('')}
    <h3>Show aircraft</h3>
    <div class="chips">
      ${FILTERS.map(([k, label, icon]) => `<button class="fchip" data-filter="${k}" aria-pressed="${!app.hidden.has(k)}">${silhouetteSvg(icon, 13)}${label}<span class="n">${F.n0(n[k] ?? 0)}</span></button>`).join('')}
    </div>`;
}

export function initLayers() {
  const el = $('layers');
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tog = t.closest<HTMLElement>('[data-layer]');
    if (tog) { const k = tog.dataset.layer as LayerKey; app.setLayer(k, !app.layers[k]); drawLayers(); }
    const f = t.closest<HTMLElement>('[data-filter]');
    if (f) { app.toggleFilter(f.dataset.filter as AcFilter); drawLayers(); }
  });
  el.addEventListener('keydown', (e) => {
    const tog = (e.target as HTMLElement).closest<HTMLElement>('[data-layer]');
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
      <input type="search" placeholder="Callsign, registration, ship, airport…" autocomplete="off" spellcheck="false" aria-label="Search" />
      <div class="results" role="listbox"></div>
      <div class="hint">↑ ↓ to move · Enter to go · Esc to close</div>
    </div>`;
  const input = el.querySelector('input')!;
  const list = el.querySelector<HTMLElement>('.results')!;
  let hits: Hit[] = [];
  let on = 0;
  const draw = () => {
    list.innerHTML = hits.map((h, i) => `
      <div class="res${i === on ? ' on' : ''}" role="option" data-i="${i}">
        <span class="ic">${h.icon}</span>
        <span><div class="t">${F.esc(h.title)}</div><div class="s">${F.esc(h.sub)}</div></span>
        <span class="r">${F.esc(h.right)}</span>
      </div>`).join('');
  };
  const go = (h: Hit | undefined) => {
    if (!h) return;
    closeSearch();
    app.select({ kind: h.kind as any, id: h.id });
    flyTo(h.lon, h.lat, h.kind === 'airport' ? 10 : h.kind === 'quake' ? 6 : 8.5);
  };
  input.addEventListener('input', () => { hits = search(input.value); on = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { on = Math.min(hits.length - 1, on + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { on = Math.max(0, on - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter') go(hits[on]);
    if (e.key === 'Escape') closeSearch();
  });
  list.addEventListener('click', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (r) go(hits[Number(r.dataset.i)]);
  });
  el.addEventListener('mousedown', (e) => { if (e.target === el) closeSearch(); });
  requestAnimationFrame(() => input.focus());
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
  return out.sort((a, b) => b.score - a.score).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Alerts: new emergency squawks and strong earthquakes

export function initAlerts() {
  const box = $('alerts');
  const seen = new Set<string>();
  let primed = false;
  const show = (key: string, tag: string, text: string, onClick: () => void, cls = '') => {
    if (seen.has(key)) return;
    seen.add(key);
    if (!primed) return; // don't flood on first load: the posters cover those
    const div = document.createElement('div');
    div.className = 'alert';
    div.innerHTML = `<span class="tag ${cls}">${tag}</span><span>${text}</span><span class="x">×</span>`;
    div.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).classList.contains('x')) onClick();
      div.remove();
    });
    box.prepend(div);
    while (box.children.length > 3) box.lastElementChild!.remove();
    setTimeout(() => div.remove(), 30_000);
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
    if (picture.aircraft.size && picture.world) primed = true;
  };
  setInterval(check, 3000);
}

// ---------------------------------------------------------------------------
// About

export function openAbout() {
  const el = $('about');
  el.hidden = false;
  const draw = () => {
    const srcs = picture.world?.sources ?? [];
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
            <kbd>L</kbd><span>Layers and filters</span>
            <kbd>F</kbd><span>Follow the selected track</span>
            <kbd>G</kbd><span>Back to the whole globe</span>
            <kbd>R</kbd><span>Weather radar</span>
            <kbd>N</kbd><span>Day and night</span>
            <kbd>Esc</kbd><span>Close, or clear the selection</span>
          </div>
        </div>
        <div>
          <h4>Sources, live</h4>
          ${srcs.map((s) => `
            <div class="src">
              <span class="dot ${s.ok ? '' : s.lastOk ? 'warn' : 'off'}"></span>
              <span class="nm">${F.esc(s.name)}</span>
              <span class="age">${s.lastOk ? F.ago((Date.now() - s.lastOk) / 1000) : 'not yet'}</span>
              <span class="meta">${F.esc([s.note, s.lastError && `last error: ${s.lastError}`].filter(Boolean).join(' · '))}</span>
            </div>`).join('')}
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
  const t = setInterval(() => (el.hidden ? clearInterval(t) : draw()), 3000);
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
      if (!$('index').hidden) return handlers.index();
      return app.select(null);
    }
    if (!$('index').hidden && k !== 'i' && k !== 'I') return;
    if (k === '/') { e.preventDefault(); openSearch(); }
    else if (k === 'l' || k === 'L') toggleLayersPanel();
    else if (k === 'i' || k === 'I') handlers.index();
    else if (k === '?') ($('about').hidden ? openAbout() : closeAbout());
    else if (k === 'f' || k === 'F') { if (app.selection) app.setFollow(!app.follow); }
    else if (k === 'g' || k === 'G') handlers.home();
    else if (k === 'r' || k === 'R') app.setLayer('radar', !app.layers.radar);
    else if (k === 'n' || k === 'N') app.setLayer('night', !app.layers.night);
    else if (k === 'a' || k === 'A') app.setLayer('airports', !app.layers.airports);
    else if (k === 'e' || k === 'E') app.setLayer('quakes', !app.layers.quakes);
    else if (k === 't' || k === 'T') app.setLayer('trails', !app.layers.trails);
  });
}

