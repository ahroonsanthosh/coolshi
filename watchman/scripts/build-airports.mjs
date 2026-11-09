// Builds src/data/airports.json from OurAirports (public domain).
// Keeps large airports and medium airports with scheduled service, which is
// every field an airliner is likely to be flying to or from.
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`OurAirports ${res.status}`);
const [head, ...rows] = parseCsv(await res.text());
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const out = [];
for (const r of rows) {
  const type = r[col.type];
  const sched = r[col.scheduled_service] === 'yes';
  const large = type === 'large_airport';
  if (!(large || (type === 'medium_airport' && sched))) continue;
  const icao = r[col.icao_code] || r[col.gps_code] || r[col.ident];
  const iata = r[col.iata_code] || '';
  out.push([
    icao, iata, r[col.name], r[col.municipality] || '', r[col.iso_country],
    +(+r[col.latitude_deg]).toFixed(4), +(+r[col.longitude_deg]).toFixed(4),
    r[col.elevation_ft] ? +r[col.elevation_ft] : null, large ? 1 : 2,
  ]);
}
out.sort((a, b) => a[8] - b[8]);
writeFileSync(new URL('../src/data/airports.json', import.meta.url), JSON.stringify(out));
console.log(`${out.length} airports (${out.filter((a) => a[8] === 1).length} large)`);
