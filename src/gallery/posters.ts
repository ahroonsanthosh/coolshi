// The picture right now, as posters. Each one is a single fact pulled from
// live data and set in big type, with the evidence printed underneath.

import { A, AF, S } from '../../shared/protocol.ts';
import { distance } from '../../shared/geo.ts';
import { sunElevation, subsolarPoint } from '../../shared/sun.ts';
import { picture, reportAge, type Aircraft } from '../state/data.ts';
import { SQUAWK_MEANING, tidyDesc } from '../lib/aircraft.ts';
import { airframe } from '../lib/enrich.ts';
import { drawLand } from '../lib/land.ts';
import { shipType } from '../lib/ais.ts';
import * as F from '../lib/format.ts';
import { drawSilhouette } from '../map/icons.ts';
import { AIRPORTS, issNow } from '../map/mapView.ts';

export const PW = 1000;
export const PH = 1400;

export interface Target { kind: 'air' | 'sea' | 'quake' | 'disaster' | 'airport' | 'iss' | 'none'; id: string; lon: number; lat: number; zoom: number }
export interface Poster { key: string; title: string; subtitle: string; target: Target; draw: (c: CanvasRenderingContext2D) => void }

const CREAM = '#fbf4e6';
const INK = '#1d1b19';
const FONT = 'Inter, system-ui, sans-serif';

// ---------------------------------------------------------------------------
// Type helpers

function font(c: CanvasRenderingContext2D, weight: number, size: number, tracking = 0) {
  c.font = `${weight} ${size}px ${FONT}`;
  (c as any).letterSpacing = `${tracking}px`;
}

/** Largest size at which `text` fits `width`, capped at `max`. */
function fit(c: CanvasRenderingContext2D, text: string, weight: number, width: number, max: number, tracking = -0.04) {
  let size = max;
  for (;;) {
    font(c, weight, size, size * tracking);
    if (c.measureText(text).width <= width || size < 20) return size;
    size -= 4;
  }
}

function header(c: CanvasRenderingContext2D, left: string, right: string, color: string) {
  font(c, 700, 30, 7);
  c.fillStyle = color;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.fillText(left.toUpperCase(), 64, 104);
  c.textAlign = 'right';
  font(c, 600, 26, 3);
  c.fillText(right.toUpperCase(), PW - 64, 104);
  c.textAlign = 'left';
}

function footer(c: CanvasRenderingContext2D, lines: string[], color: string) {
  font(c, 500, 27, 0.5);
  c.fillStyle = color;
  lines.forEach((l, i) => c.fillText(l, 64, PH - 70 - (lines.length - 1 - i) * 38));
}

function wrap(c: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lh: number, maxLines = 3) {
  const words = text.split(/\s+/);
  let line = '', n = 0;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (c.measureText(test).width > width && line) {
      c.fillText(line, x, y + n * lh);
      n++;
      line = w;
      if (n >= maxLines - 1) {
        // last line: put the rest, ellipsised
        let rest = words.slice(words.indexOf(w)).join(' ');
        while (c.measureText(rest + '…').width > width && rest.length > 1) rest = rest.slice(0, -1);
        c.fillText(rest + (rest.length < words.slice(words.indexOf(w)).join(' ').length ? '…' : ''), x, y + n * lh);
        return n + 1;
      }
    } else line = test;
  }
  if (line) { c.fillText(line, x, y + n * lh); n++; }
  return n;
}

function bg(c: CanvasRenderingContext2D, color: string) {
  c.fillStyle = color;
  c.fillRect(0, 0, PW, PH);
}

const nowUtc = () => `${F.utc(Date.now())} UTC`;

// ---------------------------------------------------------------------------
// Facts

function airborne(): Aircraft[] {
  const out: Aircraft[] = [];
  for (const a of picture.aircraft.values()) if (!(a.row[A.flags] & AF.ground) && reportAge(a) < a.staleAfter) out.push(a);
  return out;
}

/** Plausible ADS-B: positions with a type and sane numbers, to keep a
 *  garbled altitude or speed from becoming a headline. */
function credible(a: Aircraft) {
  const r = a.row;
  const alt = r[A.alt], gs = r[A.gs];
  if (alt === null || gs === null) return false;
  if (alt > 66_000 || gs > 1300) return false;
  if (r[A.altGeom] !== null && Math.abs(r[A.altGeom]! - alt) > 3000) return false;
  return !!r[A.type] || !!r[A.cs];
}

// Airframe types looked up for poster subjects that the feed sent without
// one (OpenSky doesn't carry types), so a headline never says "Aircraft".
const known = new Map<string, { type: string; desc: string }>();

function topBy(score: (a: Aircraft) => number, n: number): Aircraft[] {
  return airborne().filter(credible).sort((a, b) => score(b) - score(a)).slice(0, n);
}

/** Look up airframes for the likely headline aircraft, briefly. */
export async function prepare(): Promise<void> {
  const cands = [...topBy((a) => a.row[A.alt] ?? 0, 6), ...topBy((a) => a.row[A.gs] ?? 0, 6)]
    .filter((a) => !a.row[A.type] && !known.has(a.row[A.hex]));
  const work = Promise.all(cands.map(async (a) => {
    const af = await airframe(a.row[A.hex]);
    if (af?.icaoType) known.set(a.row[A.hex], { type: af.icaoType, desc: [af.manufacturer, af.type].filter(Boolean).join(' ') });
  }));
  await Promise.race([work, new Promise((r) => setTimeout(r, 2500))]);
}

function typeOf(a: Aircraft): { type: string; desc: string } | null {
  const r = a.row;
  if (r[A.type]) return { type: r[A.type], desc: r[A.desc] ? tidyDesc(r[A.desc]) : r[A.type] };
  return known.get(r[A.hex]) ?? null;
}

export function buildPosters(): Poster[] {
  const posters: Poster[] = [];
  const air = airborne();
  const world = picture.world;

  // 1. In the air now
  {
    const bands = new Array(10).fill(0);
    for (const a of air) {
      const alt = a.row[A.alt];
      if (alt === null) continue;
      bands[Math.min(9, Math.max(0, Math.floor(alt / 5000)))]++;
    }
    const total = air.length;
    posters.push({
      key: 'aloft', title: `${F.n0(total)} aircraft aloft`, subtitle: 'every one a live transponder · altitude in bands of 5,000 ft',
      target: { kind: 'none', id: '', lon: 10, lat: 35, zoom: 1.7 },
      draw: (c) => {
        bg(c, '#11a14a');
        header(c, 'In the air', nowUtc(), CREAM);
        const size = fit(c, F.n0(total), 900, PW - 128, 300);
        c.fillStyle = CREAM;
        c.fillText(F.n0(total), 58, 150 + size * 0.86);
        // Altitude histogram, highest band at the top.
        const max = Math.max(1, ...bands);
        const top = 240 + size, bottom = PH - 200;
        const h = (bottom - top) / bands.length;
        for (let i = 0; i < bands.length; i++) {
          const y = bottom - (i + 1) * h;
          const w = ((PW - 300) * bands[i]) / max;
          c.fillStyle = CREAM;
          c.globalAlpha = 0.18;
          c.fillRect(64, y + 6, PW - 300, h - 12);
          c.globalAlpha = 1;
          c.fillRect(64, y + 6, Math.max(3, w), h - 12);
          font(c, 600, 24, 0);
          c.fillText(i === 9 ? '45k+' : `${i * 5}k`, PW - 220, y + h / 2 + 9);
          c.textAlign = 'right';
          c.fillText(F.n0(bands[i]), PW - 64, y + h / 2 + 9);
          c.textAlign = 'left';
        }
        footer(c, ['Airborne aircraft with a current position from', 'volunteer ADS-B receivers and OpenSky.'], CREAM);
      },
    });
  }

  // 2. Highest (only aircraft whose type we know, so the claim can be checked)
  const highest = air.filter(credible).filter((a) => typeOf(a)).sort((a, b) => (b.row[A.alt] ?? 0) - (a.row[A.alt] ?? 0))[0];
  if (highest) {
    const r = highest.row;
    const alt = r[A.alt]!;
    const label = F.altitude(alt);
    const name = r[A.cs] || r[A.reg] || r[A.hex].toUpperCase();
    const what = typeOf(highest)!.desc;
    posters.push({
      key: 'highest', title: `Highest: ${name}`, subtitle: `${what} at ${F.n0(alt)} ft`,
      target: { kind: 'air', id: highest.id, lon: highest.x, lat: highest.y, zoom: 7 },
      draw: (c) => {
        bg(c, '#2a36c7');
        header(c, 'Highest', nowUtc(), CREAM);
        // Altitude ladder
        c.strokeStyle = CREAM;
        c.globalAlpha = 0.25;
        c.lineWidth = 2;
        for (let i = 0; i <= 12; i++) {
          const y = 180 + i * 72;
          c.beginPath(); c.moveTo(64, y); c.lineTo(i % 2 ? 110 : 150, y); c.stroke();
        }
        c.globalAlpha = 1;
        c.fillStyle = CREAM;
        drawSilhouette(c, highest.cls, PW / 2 + 120, 470, 420, 35);
        const size = fit(c, label, 900, PW - 128, 280);
        c.fillText(label, 58, 1010);
        font(c, 800, 64, -1.5);
        c.fillText(name, 64, 1100);
        font(c, 500, 34, 0);
        c.globalAlpha = 0.8;
        wrap(c, what, 64, 1150, PW - 128, 42, 2);
        c.globalAlpha = 1;
        void size;
        footer(c, [`${F.n0(alt)} ft pressure altitude · ${F.n0(alt * 0.3048)} m`], CREAM);
      },
    });
  }

  // 3. Fastest over the ground
  const fastest = air.filter(credible).filter((a) => !(a.row[A.flags] & AF.mlat) && typeOf(a) && (a.row[A.gs] ?? 0) < 760)
    .sort((a, b) => (b.row[A.gs] ?? 0) - (a.row[A.gs] ?? 0))[0];
  if (fastest) {
    const r = fastest.row;
    const gs = Math.round(r[A.gs]!);
    const name = r[A.cs] || r[A.reg] || r[A.hex].toUpperCase();
    const what = typeOf(fastest)!.desc;
    posters.push({
      key: 'fastest', title: `Fastest: ${name}`, subtitle: `${F.n0(gs)} kt over the ground · ${F.n0(gs * 1.852)} km/h`,
      target: { kind: 'air', id: fastest.id, lon: fastest.x, lat: fastest.y, zoom: 7 },
      draw: (c) => {
        bg(c, '#ff5b1f');
        header(c, 'Fastest', nowUtc(), INK);
        c.fillStyle = INK;
        // speed lines
        for (let i = 0; i < 9; i++) {
          c.globalAlpha = 0.12 + i * 0.03;
          c.fillRect(64, 200 + i * 34, 380 + i * 50, 10);
        }
        c.globalAlpha = 1;
        drawSilhouette(c, fastest.cls, PW - 260, 360, 300, 90);
        const t = String(gs);
        const size = fit(c, t, 900, PW - 128, 420, -0.05);
        c.fillText(t, 50, 560 + size * 0.75);
        font(c, 800, 90, 4);
        c.fillText('KNOTS', 64, 600 + size * 0.75 + 90);
        font(c, 800, 56, -1);
        c.fillText(name, 64, PH - 250);
        font(c, 500, 32, 0);
        wrap(c, what, 64, PH - 200, PW - 128, 40, 1);
        footer(c, ['Ground speed: the jet stream is in this number.'], INK);
      },
    });
  }

  // 4. Emergencies
  const em = [...picture.aircraft.values()].filter((a) => a.row[A.flags] & AF.emergency);
  if (em.length) {
    const a = em[0];
    const r = a.row;
    const name = r[A.cs] || r[A.reg] || r[A.hex].toUpperCase();
    const meaning = SQUAWK_MEANING[r[A.sq]] ?? 'Emergency declared';
    posters.push({
      key: 'emergency', title: `Squawk ${r[A.sq] || 'emergency'}: ${name}`, subtitle: `${meaning}${em.length > 1 ? ` · ${em.length - 1} more` : ''}`,
      target: { kind: 'air', id: a.id, lon: a.x, lat: a.y, zoom: 8 },
      draw: (c) => {
        bg(c, '#e2231a');
        header(c, 'Emergency', nowUtc(), CREAM);
        c.fillStyle = CREAM;
        font(c, 700, 44, 6);
        c.fillText('SQUAWK', 64, 300);
        const size = fit(c, r[A.sq] || '7700', 900, PW - 128, 380, -0.04);
        c.fillText(r[A.sq] || '7700', 50, 300 + size * 0.85);
        font(c, 800, 72, -1.5);
        c.fillText(name, 64, 920);
        font(c, 600, 40, 0);
        c.fillText(meaning, 64, 980);
        font(c, 500, 32, 0);
        c.globalAlpha = 0.85;
        c.fillText(`${F.altitude(r[A.alt], (r[A.flags] & AF.ground) !== 0)} · ${F.speed(r[A.gs])} · since ${F.utc((r[A.emSince] || Date.now() / 1000) * 1000)} UTC`, 64, 1034);
        c.globalAlpha = 1;
        footer(c, em.length > 1 ? [`And ${em.length - 1} other aircraft squawking emergency codes.`] : ['Confirmed by at least two reports.'], CREAM);
      },
    });
  } else {
    posters.push({
      key: 'quiet', title: 'All quiet', subtitle: 'no aircraft squawking 7500, 7600 or 7700',
      target: { kind: 'none', id: '', lon: 10, lat: 35, zoom: 1.7 },
      draw: (c) => {
        bg(c, CREAM);
        header(c, 'Emergencies', nowUtc(), INK);
        c.fillStyle = INK;
        const size = fit(c, 'ALL', 900, PW - 128, 420);
        c.fillText('ALL', 50, 220 + size * 0.8);
        fit(c, 'QUIET', 900, PW - 128, 420);
        c.fillText('QUIET', 50, 220 + size * 1.62);
        font(c, 700, 44, 2);
        ['7500', '7600', '7700'].forEach((s, i) => {
          c.fillStyle = '#e2231a';
          c.fillRect(64 + i * 290, 1060, 250, 4);
          c.fillStyle = INK;
          c.fillText(s, 64 + i * 290, 1130);
        });
        footer(c, ['No hijack, radio-failure or emergency', 'codes in the air right now.'], INK);
      },
    });
  }

  // 5. Strongest earthquake this week
  const quakes = world?.quakes ?? [];
  const strongest = [...quakes].sort((a, b) => b.mag - a.mag)[0];
  if (strongest) {
    const q = strongest;
    posters.push({
      key: 'quake', title: `M${q.mag.toFixed(1)}: ${q.place}`, subtitle: `strongest this week · ${F.ago((Date.now() - q.time) / 1000)} · ${F.n0(q.depth)} km deep`,
      target: { kind: 'quake', id: q.id, lon: q.lon, lat: q.lat, zoom: 5 },
      draw: (c) => {
        bg(c, '#f7b3cc');
        header(c, 'Strongest this week', 'USGS', '#b0161a');
        c.strokeStyle = '#d61f26';
        const cx = PW / 2, cy = 560;
        for (let i = 1; i <= 9; i++) {
          c.globalAlpha = 1 - i * 0.09;
          c.lineWidth = 10 - i * 0.8;
          c.beginPath(); c.arc(cx, cy, i * 46, 0, Math.PI * 2); c.stroke();
        }
        c.globalAlpha = 1;
        c.fillStyle = '#d61f26';
        c.beginPath(); c.arc(cx, cy, 20, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#b0161a';
        const t = `M${q.mag.toFixed(1)}`;
        const size = fit(c, t, 900, PW - 128, 300);
        c.fillText(t, 54, 1000 + size * 0.2);
        font(c, 600, 40, -0.5);
        wrap(c, q.place, 64, 1120, PW - 128, 48, 2);
        footer(c, [`${F.ago((Date.now() - q.time) / 1000)} · ${F.n0(q.depth)} km deep${q.tsunami ? ' · tsunami flag' : ''}`], '#b0161a');
      },
    });
  }

  // 6. Earthquakes today
  const today = quakes.filter((q) => Date.now() - q.time < 86_400_000);
  if (today.length) {
    const ss = subsolarPoint(Date.now());
    posters.push({
      key: 'quakes-today', title: `${today.length} earthquakes today`, subtitle: 'M2.5 and up, the past 24 hours, plotted where they struck',
      target: { kind: 'none', id: '', lon: 150, lat: 10, zoom: 1.6 },
      draw: (c) => {
        bg(c, INK);
        header(c, 'The past day', 'M2.5+', CREAM);
        // Equirectangular plot of epicentres.
        const x0 = 64, y0 = 200, w = PW - 128, h = w / 2;
        c.fillStyle = 'rgba(251,244,230,0.13)';
        drawLand(c, x0, y0, w, h);
        c.strokeStyle = 'rgba(251,244,230,0.12)';
        c.lineWidth = 1.5;
        c.strokeRect(x0, y0, w, h);
        for (let lon = -120; lon <= 120; lon += 60) { const x = x0 + ((lon + 180) / 360) * w; c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y0 + h); c.stroke(); }
        for (let lat = -60; lat <= 60; lat += 30) { const y = y0 + ((90 - lat) / 180) * h; c.beginPath(); c.moveTo(x0, y); c.lineTo(x0 + w, y); c.stroke(); }
        const sx = x0 + ((ss.lon + 180) / 360) * w, sy = y0 + ((90 - ss.lat) / 180) * h;
        c.fillStyle = '#ffbe0b';
        c.beginPath(); c.arc(sx, sy, 9, 0, Math.PI * 2); c.fill();
        for (const q of [...today].sort((a, b) => a.mag - b.mag)) {
          const x = x0 + ((q.lon + 180) / 360) * w, y = y0 + ((90 - q.lat) / 180) * h;
          const rr = Math.max(3, (q.mag - 2) ** 1.9 * 3.2);
          c.fillStyle = 'rgba(255, 92, 80, 0.35)';
          c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill();
          c.strokeStyle = '#ff5c50';
          c.lineWidth = 2;
          c.stroke();
        }
        c.fillStyle = CREAM;
        const t = String(today.length);
        const size = fit(c, t, 900, PW - 128, 330);
        c.fillText(t, 54, y0 + h + 60 + size * 0.75);
        font(c, 700, 40, 1);
        c.fillText('EARTHQUAKES', 64, y0 + h + 120 + size * 0.75);
        footer(c, ['Yellow: the point where the sun is overhead now.'], 'rgba(251,244,230,0.7)');
      },
    });
  }

  // 7. Sunrise and sunset, now
  {
    const rising: { city: string; code: string; lon: number; lat: number }[] = [];
    const setting: typeof rising = [];
    const now = Date.now();
    for (const ap of AIRPORTS) {
      if (ap[8] !== 1) continue;
      const lat = ap[5], lon = ap[6];
      const e0 = sunElevation(now, lat, lon);
      if (Math.abs(e0 + 0.833) > 1.2) continue; // within a few minutes of the horizon event
      const e1 = sunElevation(now + 300_000, lat, lon);
      const item = { city: ap[3] || ap[2], code: ap[1] || ap[0], lon, lat };
      if (e1 > e0) rising.push(item); else setting.push(item);
    }
    const uniq = (xs: typeof rising) => xs.filter((x, i) => xs.findIndex((y) => y.city === x.city) === i);
    const ri = uniq(rising), se = uniq(setting);
    if (ri.length) posters.push(sunPoster('sunrise', 'Sunrise now', ri, '#ffbe0b', INK));
    if (se.length) posters.push(sunPoster('sunset', 'Sunset now', se, '#6d3fd0', CREAM));
  }

  // 8. ISS
  const iss = issNow();
  if (iss) {
    const dip = (Math.acos(6371 / (6371 + iss.alt)) * 180) / Math.PI;
    const lit = sunElevation(Date.now(), iss.lat, iss.lon) > -dip;
    posters.push({
      key: 'iss', title: 'International Space Station', subtitle: `${F.n0(iss.alt)} km up · ${F.n0(iss.vel)} km/h · ${lit ? 'in sunlight' : 'in Earth’s shadow'}`,
      target: { kind: 'iss', id: 'iss', lon: iss.lon, lat: iss.lat, zoom: 3 },
      draw: (c) => {
        bg(c, lit ? '#e9e4da' : '#14161f');
        const fg = lit ? INK : CREAM;
        header(c, 'Overhead', nowUtc(), fg);
        c.fillStyle = fg;
        // The ground track over a small world map, centred on the station.
        const tr = picture.world?.iss ?? [];
        const x0 = 64, y0 = 180, w = PW - 128, h = w / 2;
        const shift = (lon: number) => ((((lon - iss.lon) % 360) + 540) % 360) - 180; // station at centre
        c.save();
        c.beginPath(); c.rect(x0, y0, w, h); c.clip();
        c.fillStyle = lit ? 'rgba(29,27,25,0.12)' : 'rgba(251,244,230,0.12)';
        for (const off of [-360, 0, 360]) {
          // shifting the land: draw with an x offset so the station sits mid-map
          const dx = ((-iss.lon + off) / 360) * w;
          c.save(); c.translate(dx, 0); drawLand(c, x0, y0, w, h); c.restore();
        }
        c.strokeStyle = fg;
        c.lineWidth = 3;
        let prevX: number | null = null;
        c.beginPath();
        for (const p of tr) {
          const x = x0 + ((shift(p.lon) + 180) / 360) * w, y = y0 + ((90 - p.lat) / 180) * h;
          if (prevX === null || Math.abs(x - prevX) > w / 2) c.moveTo(x, y); else c.lineTo(x, y);
          prevX = x;
        }
        c.globalAlpha = 0.8;
        c.setLineDash([10, 8]);
        c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 1;
        c.fillStyle = fg;
        drawSilhouette(c, 'iss', x0 + w / 2, y0 + ((90 - iss.lat) / 180) * h, 90, 0);
        c.restore();
        fit(c, 'ISS', 900, PW - 128, 400);
        c.fillText('ISS', 50, 1040);
        font(c, 600, 38, 0);
        c.fillText(`${F.n0(iss.alt)} km up · ${F.n0(iss.vel)} km/h`, 64, 1120);
        c.fillText(lit ? 'In sunlight' : 'In Earth’s shadow', 64, 1172);
        footer(c, [F.latLon(iss.lat, iss.lon)], fg);
      },
    });
  }

  // 9. Ships
  if (picture.ships.size) {
    let moving = 0, still = 0;
    let biggest: { name: string; len: number; type: string; id: string; lon: number; lat: number } | null = null;
    const groups: Record<string, number> = {};
    for (const s of picture.ships.values()) {
      if (s.still) still++; else moving++;
      const t = shipType(s.row[S.type]);
      groups[t.group] = (groups[t.group] ?? 0) + 1;
      const len = s.row[S.len] ?? 0;
      if (len > (biggest?.len ?? 0) && len < 460 && s.row[S.name]) biggest = { name: s.row[S.name], len, type: t.label, id: s.id, lon: s.x, lat: s.y };
    }
    const b = biggest;
    posters.push({
      key: 'ships', title: `${F.n0(moving)} ships under way`, subtitle: `${F.n0(still)} moored or at anchor${b ? ` · largest: ${b.name}, ${b.len} m` : ''}`,
      target: b ? { kind: 'sea', id: b.id, lon: b.lon, lat: b.lat, zoom: 8 } : { kind: 'none', id: '', lon: 22, lat: 59, zoom: 5 },
      draw: (c) => {
        bg(c, '#0d8a7c');
        header(c, 'At sea', nowUtc(), CREAM);
        c.fillStyle = CREAM;
        // Hulls in a grid, one per 25 ships under way
        const n = Math.min(120, Math.ceil(moving / 25));
        for (let i = 0; i < n; i++) {
          const col = i % 12, row = Math.floor(i / 12);
          drawSilhouette(c, 'ship', 100 + col * 72, 210 + row * 70, 56, 90);
        }
        const t = F.n0(moving);
        fit(c, t, 900, PW - 128, 300);
        c.fillText(t, 54, 900);
        font(c, 700, 40, 1);
        c.fillText('UNDER WAY', 64, 970);
        if (b) {
          font(c, 500, 32, 0);
          c.globalAlpha = 0.85;
          wrap(c, `Largest: ${b.name}, ${b.type.toLowerCase()}, ${b.len} m long.`, 64, 1050, PW - 128, 42, 2);
          c.globalAlpha = 1;
        }
        footer(c, ['Each hull is 25 ships. AIS from the Baltic', 'and every network the server can hear.'], CREAM);
      },
    });
  }

  // 10. Busiest approach
  {
    let best: { ap: (typeof AIRPORTS)[number]; n: number } | null = null;
    const low = air.filter((a) => (a.row[A.alt] ?? 1e9) < 12_000);
    for (const ap of AIRPORTS) {
      if (ap[8] !== 1) continue;
      let n = 0;
      for (const a of low) if (Math.abs(a.y - ap[5]) < 0.5 && distance(ap[5], ap[6], a.y, a.x) < 40_000) n++;
      if (n > (best?.n ?? 2)) best = { ap, n };
    }
    if (best) {
      const { ap, n } = best;
      posters.push({
        key: 'busiest', title: `Busiest sky: ${ap[1] || ap[0]}`, subtitle: `${n} aircraft below 12,000 ft within 40 km of ${ap[3] || ap[2]}`,
        target: { kind: 'airport', id: ap[0], lon: ap[6], lat: ap[5], zoom: 9 },
        draw: (c) => {
          bg(c, '#2f6bff');
          header(c, 'Busiest sky', nowUtc(), CREAM);
          c.strokeStyle = CREAM;
          c.lineWidth = 3;
          const cx = PW / 2, cy = 560;
          for (let i = 1; i <= 4; i++) { c.globalAlpha = 0.5; c.beginPath(); c.arc(cx, cy, i * 90, 0, Math.PI * 2); c.stroke(); }
          c.globalAlpha = 1;
          c.fillStyle = CREAM;
          for (const a of low) {
            const d = distance(ap[5], ap[6], a.y, a.x);
            if (d > 40_000) continue;
            const dx = (a.x - ap[6]) * Math.cos((ap[5] * Math.PI) / 180) * 111_320, dy = (a.y - ap[5]) * 110_540;
            drawSilhouette(c, a.cls, cx + (dx / 40_000) * 360, cy - (dy / 40_000) * 360, 70, a.row[A.trk] ?? 0);
          }
          const t = ap[1] || ap[0];
          const size = fit(c, t, 900, PW - 128, 300);
          c.fillText(t, 54, 1000 + size * 0.15);
          font(c, 600, 38, 0);
          c.fillText(`${n} aircraft on approach or climb-out`, 64, 1120);
          footer(c, [`${ap[2]}. Rings every 10 km.`], CREAM);
        },
      });
    }
  }

  // 11. Military
  {
    const mil = [...picture.aircraft.values()].filter((a) => a.row[A.flags] & AF.mil && !(a.row[A.flags] & AF.ground));
    if (mil.length) {
      const types: Record<string, number> = {};
      for (const a of mil) { const t = a.row[A.type] || '?'; types[t] = (types[t] ?? 0) + 1; }
      const top = Object.entries(types).filter(([t]) => t !== '?').sort((a, b) => b[1] - a[1]).slice(0, 5);
      posters.push({
        key: 'military', title: `${mil.length} military aircraft`, subtitle: 'broadcasting in the open · most common types listed',
        target: { kind: 'none', id: '', lon: 10, lat: 45, zoom: 3 },
        draw: (c) => {
          bg(c, '#5d6b3a');
          header(c, 'Military', nowUtc(), CREAM);
          c.fillStyle = CREAM;
          const t = String(mil.length);
          const size = fit(c, t, 900, PW - 128, 360);
          c.fillText(t, 50, 170 + size * 0.85);
          font(c, 700, 40, 1);
          c.fillText('AIRCRAFT', 64, 260 + size * 0.85);
          let y = 420 + size * 0.85;
          for (const [ty, n] of top) {
            c.fillRect(64, y - 44, PW - 128, 2);
            font(c, 800, 56, -1);
            c.fillText(ty, 64, y + 20);
            c.textAlign = 'right';
            font(c, 500, 44, 0);
            c.fillText(String(n), PW - 64, y + 20);
            c.textAlign = 'left';
            y += 104;
          }
          footer(c, ['Only aircraft that choose to transmit ADS-B', 'or are caught by multilateration.'], CREAM);
        },
      });
    }
  }

  // 12. Disasters
  const dis = (world?.disasters ?? []).filter((d) => d.alert !== 'Green');
  if (dis.length) {
    const lead = [...dis].sort((a, b) => (a.alert === 'Red' ? -1 : 1) - (b.alert === 'Red' ? -1 : 1))[0];
    posters.push({
      key: 'disasters', title: `${dis.length} disaster alert${dis.length > 1 ? 's' : ''}`, subtitle: `${lead.type}: ${lead.name} · ${lead.alert}`,
      target: { kind: 'disaster', id: lead.id, lon: lead.lon, lat: lead.lat, zoom: 4 },
      draw: (c) => {
        bg(c, CREAM);
        header(c, 'Alerts', 'GDACS', INK);
        let y = 230;
        for (const d of dis.slice(0, 6)) {
          c.fillStyle = d.alert === 'Red' ? '#e2231a' : '#f08c00';
          c.save(); c.translate(84, y - 18); c.rotate(Math.PI / 4); c.fillRect(-20, -20, 40, 40); c.restore();
          c.fillStyle = INK;
          font(c, 800, 46, -1);
          wrap(c, d.name, 140, y, PW - 210, 50, 1);
          font(c, 500, 28, 0);
          c.globalAlpha = 0.7;
          c.fillText(`${d.type} · ${d.alert} · ${d.country}`.slice(0, 60), 140, y + 42);
          c.globalAlpha = 1;
          y += 150;
        }
        footer(c, ['Orange and red alerts: likely humanitarian impact.'], INK);
      },
    });
  }

  return posters;
}

function sunPoster(key: string, label: string, places: { city: string; code: string; lon: number; lat: number }[], color: string, fg: string): Poster {
  const p0 = places[0];
  return {
    key, title: `${label}: ${places.slice(0, 3).map((p) => p.city).join(', ')}`, subtitle: `at ${places.length} major airport${places.length > 1 ? 's' : ''}, within minutes of now`,
    target: { kind: 'none', id: '', lon: p0.lon, lat: p0.lat, zoom: 3 },
    draw: (c) => {
      bg(c, color);
      header(c, label, nowUtc(), fg);
      c.fillStyle = fg;
      // the sun on its horizon
      c.beginPath(); c.arc(PW / 2, 520, 200, Math.PI, 0); c.fill();
      c.fillRect(64, 524, PW - 128, 6);
      for (let i = 0; i < 6; i++) c.fillRect(64 + i * 30, 560 + i * 26, PW - 128 - i * 60, 8 - i);
      let y = 830;
      for (const p of places.slice(0, 5)) {
        font(c, 800, 64, -1.5);
        c.fillText(p.city, 64, y);
        c.textAlign = 'right';
        font(c, 600, 36, 2);
        c.fillText(p.code, PW - 64, y);
        c.textAlign = 'left';
        y += 82;
      }
      footer(c, ['Sun crossing the horizon (−0.83°, refraction', 'included) at the world’s largest airports.'], fg);
    },
  };
}

