// The details sheet. Every number on it says where it came from and how old
// it is; anything we can't verify is left out rather than guessed.

import { A, AF, S, SRC_NAMES, type HistoryPoint, type Quake, type Disaster } from '../../shared/protocol.ts';
import { distance } from '../../shared/geo.ts';
import { sunElevation } from '../../shared/sun.ts';
import { picture, reportAge, type Aircraft, type Ship } from '../state/data.ts';
import { app } from '../state/app.ts';
import { CLASS_LABEL, flagEmoji, registrationCountry, SQUAWK_MEANING, tidyDesc } from '../lib/aircraft.ts';
import { flagState, NAV_STATUS, shipType } from '../lib/ais.ts';
import * as F from '../lib/format.ts';
import { aircraftPhoto, airframe, airline, checkRoute, route, shipFacts, type Route } from '../lib/enrich.ts';
import { silhouetteSvg } from '../map/icons.ts';
import { altColor } from '../map/colors.ts';
import { isaTemp } from '../state/winds.ts';
import { AIRPORTS, currentHistory, flyTo, getMap, issNow, onHistory, setRoute } from '../map/mapView.ts';

const el = document.getElementById('panel')!;
let renderedFor = '';
let tick: number | undefined;
let currentRoute: Route | null = null;

export function initPanel() {
  app.on('selection', render);
  app.on('follow', () => {
    const b = el.querySelector<HTMLButtonElement>('[data-act="follow"]');
    if (b) b.setAttribute('aria-pressed', String(app.follow));
  });
  onHistory(() => drawProfile());
  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') app.select(null);
    if (act === 'follow') {
      app.setFollow(!app.follow);
      const tr = app.selection && picture.get(app.selection.id);
      if (app.follow && tr) getMap().easeTo({ center: [tr.x, tr.y], zoom: Math.max(getMap().getZoom(), 8), duration: 900 });
    }
    if (act === 'fly') {
      const lon = Number(t.dataset.lon), lat = Number(t.dataset.lat);
      flyTo(lon, lat, Number(t.dataset.z) || undefined);
    }
    if (act === 'copy') {
      navigator.clipboard?.writeText(location.href).then(() => { t.textContent = 'Link copied'; }).catch(() => {});
    }
  });
}

function open(html: string) {
  el.innerHTML = html;
  el.classList.add('open');
  document.body.classList.add('panel-open');
  el.scrollTop = 0;
}
function close() {
  el.classList.remove('open');
  document.body.classList.remove('panel-open');
  renderedFor = '';
}

function render() {
  clearInterval(tick);
  currentRoute = null;
  setRoute(null);
  const s = app.selection;
  if (!s) return close();
  renderedFor = `${s.kind}:${s.id}`;
  if (s.kind === 'air') {
    const a = picture.aircraft.get(s.id);
    if (!a) return close();
    renderAircraft(a);
  } else if (s.kind === 'sea') {
    const sh = picture.ships.get(s.id);
    if (!sh) return close();
    renderShip(sh);
  } else if (s.kind === 'quake') {
    const q = picture.world?.quakes.find((x) => x.id === s.id);
    if (q) renderQuake(q); else close();
  } else if (s.kind === 'disaster') {
    const d = picture.world?.disasters.find((x) => x.id === s.id);
    if (d) renderDisaster(d); else close();
  } else if (s.kind === 'airport') {
    renderAirport(s.id);
  } else if (s.kind === 'iss') {
    renderIss();
  }
}

const head = (label: string) =>
  `<div class="p-head"><span>${label}</span><button class="x" data-act="close" aria-label="Close">${xIcon}</button></div>`;
const xIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.4"/></svg>';
const cell = (k: string, v: string, s = '', cls = '', key = '') =>
  `<div class="cell ${cls}"${key ? ` data-k="${key}"` : ''}><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : '<div class="s"></div>'}</div>`;

function setCell(key: string, v: string, s?: string) {
  const c = el.querySelector<HTMLElement>(`[data-k="${key}"]`);
  if (!c) return;
  const vv = c.querySelector('.v')!, ss = c.querySelector('.s')!;
  if (vv.innerHTML !== v) vv.innerHTML = v;
  if (s !== undefined && ss.innerHTML !== s) ss.innerHTML = s;
}

function srcNames(bits: number): string {
  return Object.entries(SRC_NAMES).filter(([b]) => bits & Number(b)).map(([, n]) => n).join(', ');
}

// ---------------------------------------------------------------------------
// Aircraft

function renderAircraft(a: Aircraft) {
  const r = a.row;
  const hex = r[A.hex];
  const country = registrationCountry(hex);
  const mil = (r[A.flags] & AF.mil) !== 0;
  const em = (r[A.flags] & AF.emergency) !== 0;
  const title = F.esc(r[A.cs] || r[A.reg] || hex.toUpperCase());
  const desc = r[A.desc] ? tidyDesc(r[A.desc]) : '';
  const chips = [
    em ? `<span class="chip red">Squawk ${r[A.sq]} · ${SQUAWK_MEANING[r[A.sq]] ?? 'Emergency'}</span>` : '',
    mil ? '<span class="chip blue">Military</span>' : '',
    a.est ? '<span class="chip amber">Estimated position · out of range</span>' : '',
    r[A.flags] & AF.approx ? '<span class="chip amber">Approximate position · Mode S only</span>' : '',
    r[A.flags] & AF.ladd ? '<span class="chip">Blocked from public lists (LADD)</span>' : '',
    r[A.flags] & AF.pia ? '<span class="chip">Privacy address (PIA)</span>' : '',
  ].join('');
  open(`
    ${head(`${mil ? 'Military · ' : ''}${CLASS_LABEL[a.cls]}${country ? ' · ' + F.esc(country.name) : ''}`)}
    <div class="p-photo empty" id="ph">${silhouetteSvg(a.cls, 120, 'var(--ink)')}</div>
    <div class="p-title">
      <h2>${title}</h2>
      <div class="sub" id="ac-sub">${F.esc(desc || r[A.type] || 'Type not broadcast')}</div>
      <div class="sub2" id="ac-sub2">${[r[A.reg], r[A.owner]].filter(Boolean).map(F.esc).join(' · ')}</div>
      ${chips}
    </div>
    <div id="route"></div>
    <div class="grid">
      ${cell('Altitude', '', '', '', 'alt')}
      ${cell('Vertical', '', '', '', 'vr')}
      ${cell('Ground speed', '', '', '', 'gs')}
      ${cell('Track', '', '', '', 'trk')}
      ${cell('Squawk', F.esc(r[A.sq] || '—'), F.esc(SQUAWK_MEANING[r[A.sq]] ?? ''), '', 'sq')}
      ${cell('Position', '', '', '', 'src')}
      ${cell('Registration', F.esc(r[A.reg] || '—'), country ? `${flagEmoji(country.cc)} ${F.esc(country.name)}` : 'Non-ICAO address')}
      ${cell('ICAO address', hex.toUpperCase(), F.esc(r[A.type] ? `Type ${r[A.type]}` : ''))}
      ${cell('Last report', '', '', 'wide', 'age')}
    </div>
    <div id="deck"></div>
    <div class="profile" id="profile"></div>
    <div class="actions">
      <button class="btn" data-act="follow" aria-pressed="${app.follow}">Follow</button>
      <a class="btn" href="https://globe.adsb.fi/?icao=${hex}" target="_blank" rel="noopener">adsb.fi ↗</a>
      <button class="btn" data-act="copy">Copy link</button>
    </div>
    <div class="prov" id="prov"></div>
  `);
  updateAircraft();
  let n = 0;
  tick = window.setInterval(() => {
    const cur = app.selection && picture.aircraft.get(app.selection.id);
    if (!cur || renderedFor !== `air:${cur.id}`) return;
    updateAircraft();
    if (++n % 5 === 0) loadDeck(cur);
  }, 1000);
  loadDeck(a);
  drawProfile();
  enrichAircraft(a);
}

function updateAircraft() {
  const a = app.selection && picture.aircraft.get(app.selection.id);
  if (!a) return;
  const r = a.row;
  const ground = (r[A.flags] & AF.ground) !== 0;
  const alt = r[A.alt];
  setCell('alt', `<span style="color:${altColor(alt, ground)}">●</span> ${F.altitude(alt, ground)}`,
    ground || alt === null ? '' : [`${F.n0(alt * 0.3048)} m`, r[A.altGeom] !== null ? `GNSS ${F.n0(r[A.altGeom]!)} ft` : ''].filter(Boolean).join(' · '));
  const vr = r[A.vr];
  if (ground || vr === null) setCell('vr', '—', '');
  else if (Math.abs(vr) < 200) setCell('vr', 'Level', `${vr > 0 ? '+' : ''}${F.n0(vr)} ft/min`);
  else setCell('vr', `<span class="${vr > 0 ? 'vr-up' : 'vr-down'}">${vr > 0 ? '↑' : '↓'} ${F.n0(Math.abs(vr))}</span>`, `ft/min · ${vr > 0 ? 'climbing' : 'descending'}`);
  const gs = r[A.gs];
  setCell('gs', F.speed(gs), gs === null ? '' : `${F.n0(gs * 1.852)} km/h`);
  setCell('trk', F.heading(r[A.trk]), F.compass(r[A.trk]) ? `towards ${F.compass(r[A.trk])}` : '');
  const how = r[A.flags] & AF.approx ? 'Mode S' : r[A.flags] & AF.mlat ? 'MLAT' : r[A.flags] & AF.tisb ? 'TIS-B' : 'ADS-B';
  setCell('src', how, how === 'Mode S' ? 'no position broadcast' : how === 'MLAT' ? 'timed by receivers' : how === 'TIS-B' ? 'relayed from radar' : 'from its own GNSS');
  const age = reportAge(a);
  const est = (r[A.flags] & AF.approx) ? 'rough area only: heard by receivers near here, no position broadcast'
    : a.est ? 'estimated: out of receiver range, carried along its filed route'
    : age > 3 ? `drawn ${F.n0(Math.min(age, a.maxDr))} s ahead on its track` : 'drawn as reported';
  setCell('age', `${F.ago(age)}`, `${est} · ${F.latLon(a.y, a.x)}`);
  const prov = el.querySelector('#prov');
  if (prov) {
    if (r[A.flags] & AF.approx) {
      prov.innerHTML = `<b>Approximate position.</b> This aircraft answers radar with a Mode S transponder (identity, altitude and squawk) but is not broadcasting where it is, as many military aircraft don't. ${F.esc(srcNames(r[A.src]))} place it only near the receivers that hear it, so the ring can be off by a hundred kilometres or more. It moves when receivers elsewhere pick it up.`;
      return;
    }
    if (a.est) {
      const dest = AIRPORTS.find((p) => Math.abs(p[5] - a.est![0]) < 0.01 && Math.abs(p[6] - a.est![1]) < 0.01);
      const eta = r[A.estEta] ? F.utc(r[A.estEta] * 1000) : '';
      prov.innerHTML = `<b>Estimated position.</b> Last heard ${F.ago(age)} by ${F.esc(srcNames(r[A.src]))} at ${F.altitude(r[A.alt])} and ${F.speed(r[A.gs])}, flying a filed route that its position and heading confirmed. Since then it is drawn along the great circle to ${F.esc(dest ? dest[1] || dest[0] : 'its destination')} at that speed${eta ? `, arriving about ${eta} UTC` : ''}. The first real report replaces the estimate.`;
      if (currentRoute) drawRouteBlock(a, currentRoute);
      return;
    }
    prov.innerHTML = `Heard by <b>${F.esc(srcNames(r[A.src]))}</b>, reporting about every ${F.n0(r[A.cad])} s. Between reports the symbol carries on along its great circle at reported ground speed, for up to ${F.n0(a.maxDr)} s; it fades after ${F.n0(a.staleAfter)} s without a report.${
      age > a.staleAfter ? ' <b>This track is stale.</b>' : ''}`;
  }
  if (currentRoute) drawRouteBlock(a, currentRoute);
}

// ---------------------------------------------------------------------------
// The flight deck: what the aircraft's own systems broadcast (Mode S enhanced
// surveillance and ADS-B v2): autopilot selections, air data, and the wind
// and temperature it is flying through.

const MODES: Record<string, string> = {
  autopilot: 'Autopilot', vnav: 'VNAV', lnav: 'LNAV', althold: 'Altitude hold', approach: 'Approach', tcas: 'TCAS',
};
// ADS-B position accuracy category (NACp) → 95% containment radius.
const NACP: Record<number, string> = {
  11: '< 3 m', 10: '< 10 m', 9: '< 30 m', 8: '< 93 m', 7: '< 185 m', 6: '< 556 m', 5: '< 926 m', 4: '< 1.9 km', 3: '< 3.7 km', 2: '< 7.4 km', 1: '< 18.5 km',
};

async function loadDeck(a: Aircraft) {
  const id = a.id;
  let e: any = null;
  try { e = await (await fetch(`/api/detail/air/${a.row[A.hex]}`)).json(); } catch { return; }
  const box = el.querySelector<HTMLElement>('#deck');
  if (!box || app.selection?.id !== id) return;
  if (!e) { box.innerHTML = ''; return; }
  const r = a.row;
  const alt = r[A.alt] ?? 0;
  const trk = r[A.trk];
  const cells: string[] = [];
  const sel = e.nav_altitude_fms ?? e.nav_altitude_mcp;
  if (typeof sel === 'number') {
    const diff = sel - alt;
    const what = Math.abs(diff) < 300 ? 'holding it' : diff > 0 ? `climbing, ${F.n0(diff)} ft to go` : `descending, ${F.n0(-diff)} ft to go`;
    cells.push(cell('Selected altitude', F.altitude(sel), what));
  }
  if (typeof e.nav_heading === 'number') cells.push(cell('Selected heading', F.heading(e.nav_heading), e.mag_heading != null ? `nose on ${F.heading(e.mag_heading)} magnetic` : ''));
  if (typeof e.ias === 'number' || typeof e.tas === 'number') {
    cells.push(cell('Airspeed', e.ias != null ? `${F.n0(e.ias)} kt` : `${F.n0(e.tas)} kt`, [e.ias != null ? 'indicated' : 'true', e.ias != null && e.tas != null ? `true ${F.n0(e.tas)} kt` : ''].filter(Boolean).join(' · ')));
  }
  if (typeof e.mach === 'number') cells.push(cell('Mach', e.mach.toFixed(2), `${F.n0(e.mach * 100)}% of local sound speed`));
  if (typeof e.ws === 'number' && typeof e.wd === 'number') {
    let comp = '';
    if (trk !== null) {
      const rad = ((e.wd - trk) * Math.PI) / 180;
      const head = e.ws * Math.cos(rad); // + from ahead
      const cross = e.ws * Math.sin(rad);
      comp = `${Math.abs(head) >= 1 ? `${F.n0(Math.abs(head))} kt ${head > 0 ? 'head' : 'tail'}` : 'no head/tail'}${Math.abs(cross) >= 3 ? ` · ${F.n0(Math.abs(cross))} kt cross ${cross > 0 ? 'R' : 'L'}` : ''}`;
    }
    cells.push(cell('Wind outside', `${F.heading(e.wd)} at ${F.n0(e.ws)} kt`, comp));
  }
  // Temperatures from older Mode S replies are sometimes garbage (−116 °C);
  // show only what the atmosphere can actually be at that height.
  if (typeof e.oat === 'number' && e.oat >= -80 && e.oat <= 50 && Math.abs(e.oat - isaTemp(alt)) <= 30) {
    const isa = isaTemp(alt);
    const dev = e.oat - isa;
    cells.push(cell('Outside air', `${e.oat} °C`, `ISA ${dev >= 0 ? '+' : '−'}${Math.abs(Math.round(dev))} °C${typeof e.tat === 'number' ? ` · total ${e.tat} °C` : ''}`));
  }
  if (typeof e.roll === 'number') {
    const b = Math.abs(e.roll);
    cells.push(cell('Bank', b < 2 ? 'Wings level' : `${Math.round(b)}° ${e.roll < 0 ? 'left' : 'right'}`, typeof e.track_rate === 'number' && Math.abs(e.track_rate) >= 0.1 ? `turning ${Math.abs(e.track_rate).toFixed(1)}°/s` : ''));
  }
  if (typeof e.nav_qnh === 'number') cells.push(cell('Altimeter set', `${e.nav_qnh.toFixed(0)} hPa`, Math.abs(e.nav_qnh - 1013.25) < 0.6 ? 'standard, flight levels' : 'local pressure'));
  if (typeof e.nac_p === 'number' && NACP[e.nac_p]) cells.push(cell('Position accuracy', NACP[e.nac_p], `95% of the time · ADS-B v${e.version ?? '?'}`));
  const modes = Array.isArray(e.nav_modes) ? (e.nav_modes as string[]).map((m) => MODES[m] ?? m) : [];
  const age = Math.max(0, Date.now() / 1000 - e.t);
  box.innerHTML = cells.length || modes.length ? `
    <div class="deck-h"><span>On the flight deck</span><span>broadcast ${F.ago(age)}</span></div>
    ${modes.length ? `<div class="deck-modes">${modes.map((m) => `<span class="chip">${F.esc(m)}</span>`).join('')}</div>` : ''}
    <div class="grid deck">${cells.join('')}</div>` : '';
}

async function enrichAircraft(a: Aircraft) {
  const id = a.id;
  const r = a.row;
  const hex = r[A.hex];
  const still = () => app.selection?.id === id;
  aircraftPhoto(hex, r[A.reg]).then(async (p) => {
    if (!still()) return;
    let photo = p;
    if (!photo) {
      const af = await airframe(hex);
      if (af?.photo) photo = { src: af.photo, link: af.photo, credit: 'airport-data.com' };
    }
    const box = el.querySelector<HTMLElement>('#ph');
    if (!box || !photo) return;
    box.classList.remove('empty');
    box.innerHTML = `<a href="${F.esc(photo.link)}" target="_blank" rel="noopener"><img alt="Photo of ${F.esc(r[A.reg] || hex)}" referrerpolicy="no-referrer" src="${F.esc(photo.src)}"></a><div class="credit">${F.esc(photo.credit)}</div>`;
    const img = box.querySelector('img')!;
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => { box.classList.add('empty'); box.innerHTML = silhouetteSvg(a.cls, 120, 'var(--ink)'); };
  });
  // Fill in what the feed didn't send.
  if (!r[A.type] || !r[A.reg] || !r[A.owner]) {
    airframe(hex).then((af) => {
      if (!still() || !af) return;
      const sub = el.querySelector('#ac-sub'), sub2 = el.querySelector('#ac-sub2');
      if (sub && !r[A.desc]) sub.textContent = [af.manufacturer, af.type].filter(Boolean).join(' ') || sub.textContent;
      if (sub2 && !sub2.textContent) sub2.textContent = [af.registration, af.owner].filter(Boolean).join(' · ');
    });
  }
  const cs = r[A.cs];
  if (cs && /^[A-Z]{3}\d/.test(cs)) {
    const [rt, al] = await Promise.all([route(cs), airline(cs)]);
    if (!still()) return;
    const sub2 = el.querySelector('#ac-sub2');
    const operator = rt?.airline || al;
    if (sub2 && operator && !sub2.textContent!.includes(operator)) {
      sub2.textContent = [operator, sub2.textContent].filter(Boolean).join(' · ');
    }
    if (rt) {
      currentRoute = rt;
      drawRouteBlock(a, rt);
    }
  }
}

function drawRouteBlock(a: Aircraft, rt: Route) {
  const box = el.querySelector<HTMLElement>('#route');
  if (!box) return;
  const r = a.row;
  const ground = (r[A.flags] & AF.ground) !== 0;
  const chk = checkRoute(rt, a.y, a.x, r[A.trk], ground);
  if (!chk.ok) {
    setRoute(null);
    box.innerHTML = `<div class="note">Route databases list <b>${F.esc(rt.from.iata || rt.from.icao)} → ${F.esc(rt.to.iata || rt.to.icao)}</b> for ${F.esc(r[A.cs])}, but this aircraft is ${F.esc(chk.reason)}, so it isn't shown.</div>`;
    return;
  }
  setRoute({ from: [rt.from.lat, rt.from.lon, rt.from.iata || rt.from.icao], to: [rt.to.lat, rt.to.lon, rt.to.iata || rt.to.icao] });
  const gs = r[A.gs] ?? 0;
  let eta = '';
  if (!ground && gs > 80 && chk.remaining > 5000) {
    const sec = chk.remaining / (gs * 0.514444);
    eta = `arrives ≈ ${F.utc(Date.now() + sec * 1000)} UTC at this speed`;
  }
  const pct = Math.round(chk.progress * 1000) / 10;
  const html = `
    <div class="route">
      <div class="route-ends">
        <div><div class="code">${F.esc(rt.from.iata || rt.from.icao)}</div><div class="city">${F.esc(rt.from.city || rt.from.name)}</div></div>
        <div class="mid">${F.km(chk.total)}</div>
        <div class="end"><div class="code">${F.esc(rt.to.iata || rt.to.icao)}</div><div class="city">${F.esc(rt.to.city || rt.to.name)}</div></div>
      </div>
      <div class="route-bar"><div class="done" style="width:${pct}%"></div><div class="plane" style="left:${pct}%">${silhouetteSvg('jet', 18)}</div></div>
      <div class="route-meta"><span>${F.km(chk.flown)} flown</span><span>${F.km(chk.remaining)} to go</span></div>
      ${eta ? `<div class="route-meta" style="margin-top:4px"><span></span><span>${eta}</span></div>` : ''}
    </div>`;
  if (box.dataset.sig !== `${pct}|${eta}`) {
    box.innerHTML = html;
    box.dataset.sig = `${pct}|${eta}`;
  }
}

function drawProfile() {
  const box = el.querySelector<HTMLElement>('#profile');
  const s = app.selection;
  if (!box || !s || s.kind !== 'air') return;
  const h = currentHistory().filter((p) => p.alt !== null) as (HistoryPoint & { alt: number })[];
  if (h.length < 3) {
    box.innerHTML = '';
    return;
  }
  const W = 340, H = 92;
  const t0 = h[0].t, t1 = h[h.length - 1].t;
  const span = Math.max(60, t1 - t0);
  const maxAlt = Math.max(1000, ...h.map((p) => p.alt));
  const top = Math.ceil(maxAlt / 5000) * 5000;
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (alt: number) => H - 14 - (alt / top) * (H - 22);
  let d = '';
  h.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.alt).toFixed(1)}`; });
  const area = `${d}L${x(t1).toFixed(1)} ${H - 14}L0 ${H - 14}Z`;
  const gsPts = h.filter((p) => p.gs !== null);
  const maxGs = Math.max(100, ...gsPts.map((p) => p.gs!));
  let g = '';
  gsPts.forEach((p, i) => { g += `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${(H - 14 - (p.gs! / maxGs) * (H - 30)).toFixed(1)}`; });
  const stops = h.filter((_, i) => i % Math.ceil(h.length / 24) === 0 || i === h.length - 1)
    .map((p) => `<stop offset="${(((p.t - t0) / span) * 100).toFixed(1)}%" stop-color="${altColor(p.alt, p.alt <= 0)}"/>`).join('');
  box.innerHTML = `
    <div class="k"><span>Altitude since ${F.utc(t0 * 1000)} UTC</span><span><span style="color:var(--ink)">—</span> alt <span style="color:var(--mute-2)">┄</span> speed</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="altg" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient></defs>
      <line x1="0" x2="${W}" y1="${H - 14}" y2="${H - 14}" stroke="var(--rule-2)" stroke-width="1"/>
      <path d="${area}" fill="url(#altg)" opacity="0.14"/>
      <path d="${g}" fill="none" stroke="var(--mute-2)" stroke-width="1" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>
      <path d="${d}" fill="none" stroke="url(#altg)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <text class="axis" x="0" y="${H - 1}">${F.utc(t0 * 1000)}</text>
      <text class="axis" x="${W}" y="${H - 1}" text-anchor="end">${F.utc(t1 * 1000)}</text>
      <text class="axis" x="0" y="8">${F.altitude(top)}</text>
    </svg>`;
}

// ---------------------------------------------------------------------------
// Ship

function renderShip(s: Ship) {
  const r = s.row;
  const t = shipType(r[S.type]);
  const flag = flagState(r[S.mmsi]);
  const name = r[S.name] || `MMSI ${r[S.mmsi]}`;
  open(`
    ${head(`${F.esc(t.label)}${flag ? ' · ' + F.esc(flag) : ''}`)}
    <div class="p-photo empty" id="ph">${silhouetteSvg('ship', 90, 'var(--sea)')}</div>
    <div class="p-title">
      <h2>${F.esc(name)}</h2>
      <div class="sub">${F.esc(t.label)}${r[S.len] ? ` · ${r[S.len]} × ${r[S.beam] ?? '?'} m` : ''}</div>
      <div class="sub2" id="sh-sub2">${r[S.dest] ? `Bound for <b>${F.esc(r[S.dest])}</b>${r[S.eta] ? `, ETA ${F.esc(r[S.eta])} UTC` : ''}` : 'No destination broadcast'}</div>
      ${NAV_STATUS[r[S.nav]] ? `<span class="chip teal">${F.esc(NAV_STATUS[r[S.nav]])}</span>` : ''}
    </div>
    <div class="grid">
      ${cell('Speed', '', '', '', 'sog')}
      ${cell('Course', '', '', '', 'cog')}
      ${cell('Heading', '', '', '', 'hdg')}
      ${cell('Turning', '', '', '', 'rot')}
      ${cell('Draught', r[S.draught] ? `${r[S.draught]} m` : '—', 'as entered by the crew')}
      ${cell('Flag', `${flagEmoji(r[S.flag])} ${F.esc(flag || '—')}`, `MMSI ${r[S.mmsi]}`)}
      ${cell('IMO', r[S.imo] ? String(r[S.imo]) : '—', r[S.callsign] ? `Call sign ${F.esc(r[S.callsign])}` : '')}
      ${cell('Size', r[S.len] ? `${r[S.len]} m` : '—', r[S.beam] ? `beam ${r[S.beam]} m` : '')}
      ${cell('Last report', '', '', 'wide', 'age')}
    </div>
    <div id="owd"></div>
    <div id="wd"></div>
    <div class="actions">
      <button class="btn" data-act="follow" aria-pressed="${app.follow}">Follow</button>
      ${r[S.imo] ? `<a class="btn" href="https://www.marinetraffic.com/en/ais/details/ships/imo:${r[S.imo]}" target="_blank" rel="noopener">MarineTraffic ↗</a>` : ''}
      <button class="btn" data-act="copy">Copy link</button>
    </div>
    <div class="prov">Reported over AIS, heard by <b>${F.esc(srcNames(r[S.src]))}</b>${r[S.via] ? ` (relayed from ${F.esc(r[S.via])})` : ''}. Moving ships are carried forward on their course for up to ten minutes between reports. Type, size, destination and draught are typed in by the crew and are often out of date.</div>
  `);
  const upd = () => {
    const cur = app.selection && picture.ships.get(app.selection.id);
    if (!cur) return;
    const rr = cur.row;
    setCell('sog', rr[S.sog] === null ? '—' : `${F.n1(rr[S.sog]!)} kt`, rr[S.sog] === null ? '' : `${F.n1(rr[S.sog]! * 1.852)} km/h`);
    setCell('cog', F.heading(rr[S.cog]), F.compass(rr[S.cog]));
    setCell('hdg', F.heading(rr[S.hdg]), rr[S.hdg] === null ? 'not reported' : 'bow points');
    setCell('rot', rr[S.rot] === null ? '—' : Math.abs(rr[S.rot]!) < 1 ? 'Straight' : `${rr[S.rot]! > 0 ? 'Starboard' : 'Port'}`, rr[S.rot] === null ? '' : `${F.n1(Math.abs(rr[S.rot]!))}°/min`);
    const age = reportAge(cur);
    setCell('age', F.ago(age), F.latLon(cur.y, cur.x));
  };
  upd();
  tick = window.setInterval(upd, 1000);
  const id = s.id;
  fetch(`/api/detail/sea/${r[S.mmsi]}`).then((x) => x.json()).then((d: any) => {
    if (!d || app.selection?.id !== id) return;
    const p = d.particulars ?? {};
    const bits = [
      p.year_built && cell('Built', String(p.year_built), `${new Date().getUTCFullYear() - p.year_built} years old`),
      p.gross_tonnage && cell('Gross tonnage', F.n0(p.gross_tonnage), 'enclosed volume'),
      p.deadweight && cell('Deadweight', `${F.n0(p.deadweight)} t`, 'cargo, fuel and stores it can carry'),
      (p.registry || p.home_port) && cell('Registry', F.esc(p.registry ?? '—'), F.esc(p.home_port ? `home port ${p.home_port}` : '')),
      d.near && cell('Near', F.esc(d.near), 'nearest town or region'),
      d.firstSeen && cell('First heard', new Date(d.firstSeen).toUTCString().slice(5, 16), 'by the Open Waters network'),
    ].filter(Boolean);
    const box = el.querySelector<HTMLElement>('#owd');
    if (box && bits.length) box.innerHTML = `<div class="deck-h"><span>Particulars</span><span>registry data via Open Waters</span></div><div class="grid deck">${bits.join('')}</div>`;
  }).catch(() => {});
  shipFacts(r[S.imo]).then((f) => {
    if (!f || app.selection?.id !== id) return;
    const wd = el.querySelector('#wd');
    if (wd) {
      const bits = [f.klass && `${F.esc(f.klass)}`, f.operator && `operated by ${F.esc(f.operator)}`, f.year && `built ${f.year}`, f.tonnage && `${F.n0(Number(f.tonnage))} GT`].filter(Boolean);
      if (bits.length) wd.innerHTML = `<div class="note">${bits.join(' · ')} <a href="${F.esc(f.link)}" target="_blank" rel="noopener">Wikidata ↗</a></div>`;
    }
    if (f.image) {
      const box = el.querySelector<HTMLElement>('#ph');
      if (!box) return;
      box.classList.remove('empty');
      box.innerHTML = `<img alt="Photo of ${F.esc(name)}" referrerpolicy="no-referrer" src="${F.esc(f.image)}"><div class="credit">Wikimedia Commons</div>`;
      const img = box.querySelector('img')!;
      img.onload = () => img.classList.add('loaded');
    }
  });
}

// ---------------------------------------------------------------------------
// Earthquake, disaster, airport, ISS

function renderQuake(q: Quake) {
  const age = (Date.now() - q.time) / 1000;
  const depthClass = q.depth < 70 ? 'shallow' : q.depth < 300 ? 'intermediate depth' : 'deep';
  // Felt intensity falls with depth; a shallow M6 matters more than a deep one.
  open(`
    ${head('Earthquake · USGS')}
    <div class="p-title" style="padding-top:22px">
      <h2 style="font-size:64px;color:var(--quake)">M${q.mag.toFixed(1)}</h2>
      <div class="sub">${F.esc(q.place || 'Unnamed location')}</div>
      <div class="sub2">${F.ago(age)} · ${new Date(q.time).toUTCString().replace('GMT', 'UTC')}</div>
      ${q.tsunami ? '<span class="chip red">Tsunami flag set</span>' : ''}
      ${q.alert ? `<span class="chip ${q.alert === 'green' ? 'teal' : q.alert === 'yellow' ? 'amber' : 'red'}">PAGER ${F.esc(q.alert)}</span>` : ''}
    </div>
    <div class="grid">
      ${cell('Depth', `${F.n0(q.depth)} km`, depthClass)}
      ${cell('Magnitude type', F.esc(q.magType || '—'), 'as reviewed by USGS')}
      ${cell('Felt reports', q.felt ? F.n0(q.felt) : '—', 'Did You Feel It?')}
      ${cell('Significance', F.n0(q.sig), 'USGS index, 0–1000+')}
      ${cell('Epicentre', F.latLon(q.lat, q.lon), '', 'wide')}
    </div>
    <div class="actions"><a class="btn" href="${F.esc(q.url)}" target="_blank" rel="noopener">USGS event page ↗</a></div>
    <div class="prov">From the USGS real-time feed (M2.5+ worldwide in the past day, M4.5+ in the past week). Early magnitudes are often revised within the hour.</div>
  `);
}

function renderDisaster(d: Disaster) {
  open(`
    ${head(`${F.esc(d.type)} · GDACS`)}
    <div class="p-title" style="padding-top:22px">
      <h2>${F.esc(d.name)}</h2>
      <div class="sub">${F.esc(d.country)}</div>
      <span class="chip ${d.alert === 'Red' ? 'red' : d.alert === 'Orange' ? 'amber' : 'teal'}">${F.esc(d.alert)} alert</span>
    </div>
    <div class="grid">
      ${cell('Since', new Date(d.from).toUTCString().slice(5, 16), F.ago((Date.now() - d.from) / 1000))}
      ${cell('Last update', new Date(d.to).toUTCString().slice(5, 16), '')}
      ${cell('Severity', F.esc(d.severity || '—'), '', 'wide')}
    </div>
    <div class="actions"><a class="btn" href="${F.esc(d.url)}" target="_blank" rel="noopener">GDACS report ↗</a></div>
    <div class="prov">Alert levels are GDACS's estimate of humanitarian impact (green, orange, red), from the UN and European Commission's Global Disaster Alert and Coordination System.</div>
  `);
}

function renderAirport(icao: string) {
  const ap = AIRPORTS.find((a) => a[0] === icao);
  if (!ap) return close();
  const [code, iata, name, city, cc, lat, lon, elev] = ap;
  const near = () => {
    let arr = 0, dep = 0, ground = 0, nearby = 0;
    for (const a of picture.aircraft.values()) {
      const d = distance(lat, lon, a.y, a.x);
      if (d > 40_000) continue;
      const r = a.row;
      if (r[A.flags] & AF.ground) { if (d < 5000) ground++; continue; }
      if ((r[A.alt] ?? 99999) > 12000) continue;
      nearby++;
      const vr = r[A.vr] ?? 0;
      if (vr < -300) arr++;
      else if (vr > 300) dep++;
    }
    return { arr, dep, ground, nearby };
  };
  const n = near();
  const sun = sunElevation(Date.now(), lat, lon);
  const light = sun > 0 ? 'Daylight' : sun > -6 ? 'Civil twilight' : sun > -12 ? 'Nautical twilight' : sun > -18 ? 'Astronomical twilight' : 'Night';
  open(`
    ${head(`Airport · ${F.esc(cc)} ${flagEmoji(cc)}`)}
    <div class="p-title" style="padding-top:22px">
      <h2 style="font-size:56px">${F.esc(iata || code)}</h2>
      <div class="sub">${F.esc(name)}</div>
      <div class="sub2">${F.esc(city)}${iata ? ` · ICAO ${F.esc(code)}` : ''}</div>
    </div>
    <div class="grid">
      ${cell('Arriving', F.n0(n.arr), 'descending within 40 km')}
      ${cell('Departing', F.n0(n.dep), 'climbing within 40 km')}
      ${cell('In the circuit', F.n0(n.nearby), 'below 12,000 ft, 40 km')}
      ${cell('On the ground', F.n0(n.ground), 'transmitting, within 5 km')}
      ${cell('Elevation', elev !== null ? `${F.n0(elev)} ft` : '—', elev !== null ? `${F.n0(elev * 0.3048)} m` : '')}
      ${cell('Sun', light, `${sun.toFixed(1)}° elevation`)}
    </div>
    <div id="metar"></div>
    <div class="actions">
      <button class="btn" data-act="fly" data-lon="${lon}" data-lat="${lat}" data-z="11">Zoom to field</button>
      <a class="btn" href="https://aviationweather.gov/data/metar/?ids=${code}&decoded=1" target="_blank" rel="noopener">Weather ↗</a>
    </div>
    <div class="prov">Counts are from the aircraft currently on the map, so they depend on receiver coverage near the field. Weather is the latest METAR via NOAA's Aviation Weather Center. Airport data from OurAirports.</div>
  `);
  loadMetar(code);
}

// Flight categories as pilots use them, from ceiling and visibility.
const CATS: Record<string, [string, string]> = {
  VFR: ['#2f9e44', 'Visual flight rules'], MVFR: ['#1c7ed6', 'Marginal VFR'], IFR: ['#e03131', 'Instrument flight rules'], LIFR: ['#ae3ec9', 'Low IFR'],
};
const COVER: Record<string, string> = { SKC: 'Clear', CLR: 'Clear', NCD: 'No cloud', NSC: 'No significant cloud', CAVOK: 'Clear, visibility OK', FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast', VV: 'Sky obscured' };

async function loadMetar(icao: string) {
  let m: any = null;
  try { m = await (await fetch(`/api/metar/${icao}`)).json(); } catch { return; }
  const box = el.querySelector<HTMLElement>('#metar');
  if (!box || app.selection?.id !== icao || !m) return;
  const cat = CATS[m.fltCat];
  const clouds = (m.clouds ?? []).map((c: any) => `${COVER[c.cover] ?? c.cover}${c.base != null ? ` ${F.n0(c.base)} ft` : ''}`).join(', ') || COVER[m.cover] || '—';
  const wind = m.wspd === 0 ? 'Calm' : `${m.wdir === 'VRB' ? 'Variable' : F.heading(Number(m.wdir))} at ${m.wspd} kt${m.wgst ? `, gusting ${m.wgst}` : ''}`;
  const vis = m.visib === '10+' || m.visib === '6+' ? `${m.visib === '6+' ? '10 km' : '10 mi'} or more` : `${m.visib} mi`;
  const age = (Date.now() / 1000 - m.obsTime);
  box.innerHTML = `
    <div class="deck-h"><span>Weather at the field</span><span>observed ${F.ago(age)}</span></div>
    <div class="grid deck">
      ${cell('Conditions', cat ? `<span class="cat" style="background:${cat[0]}">${F.esc(m.fltCat)}</span>` : '—', cat ? cat[1] : '')}
      ${cell('Wind', F.esc(wind), m.wspd ? 'surface, magnetic' : '')}
      ${cell('Visibility', F.esc(vis), '')}
      ${cell('Cloud', F.esc(clouds), '')}
      ${cell('Temperature', m.temp != null ? `${m.temp} °C` : '—', m.dewp != null ? `dew point ${m.dewp} °C` : '')}
      ${cell('Pressure', m.altim != null ? `${Math.round(m.altim)} hPa` : '—', m.altim != null ? `${(m.altim * 0.02953).toFixed(2)} inHg` : '')}
    </div>
    <div class="metar-raw">${F.esc(m.rawOb ?? '')}</div>`;
}

function renderIss() {
  open(`
    ${head('Space station · NORAD 25544')}
    <div class="p-title" style="padding-top:22px">
      <h2>ISS</h2>
      <div class="sub">International Space Station</div>
      <div class="sub2">Ground track: 45 minutes behind (solid) and ahead (dashed)</div>
    </div>
    <div class="grid">
      ${cell('Altitude', '', '', '', 'alt')}
      ${cell('Speed', '', '', '', 'vel')}
      ${cell('Sunlight', '', '', '', 'sun')}
      ${cell('Orbit', '≈ 92 min', '15.5 orbits a day')}
      ${cell('Over', '', '', 'wide', 'pos')}
    </div>
    <div class="actions"><button class="btn" data-act="follow" aria-pressed="false">Follow</button></div>
    <div class="prov">Positions propagated from the current two-line element set by wheretheiss.at, sampled a minute apart and interpolated.</div>
  `);
  const upd = () => {
    const p = issNow();
    if (!p) return;
    setCell('alt', `${F.n0(p.alt)} km`, `${F.n0(p.alt / 1.852)} nm`);
    setCell('vel', `${F.n0(p.vel)} km/h`, `${F.n1(p.vel / 3600)} km/s`);
    // The station is lit while the sun is above its (depressed) horizon:
    // at 420 km it sees about 20° past the ground terminator.
    const horizonDip = (Math.acos(6371 / (6371 + p.alt)) * 180) / Math.PI;
    const el = sunElevation(Date.now(), p.lat, p.lon);
    setCell('sun', el > -horizonDip ? 'Sunlit' : 'In Earth’s shadow', `sun ${el.toFixed(0)}° at the point below`);
    setCell('pos', F.latLon(p.lat, p.lon), '');
    if (app.follow) getMap().setCenter([p.lon, p.lat]);
  };
  upd();
  tick = window.setInterval(upd, 500);
}
