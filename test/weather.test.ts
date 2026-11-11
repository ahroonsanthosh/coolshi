import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetarCsv } from '../server/feeds/weather.ts';
import { humidity, wxKind, wxWords } from '../src/lib/weather.ts';
import { WX } from '../shared/protocol.ts';

const HEAD = 'raw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wind_dir_degrees,wind_speed_kt,wind_gust_kt,visibility_statute_mi,altim_in_hg,wx_string,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,flight_category';
const NOW = Date.parse('2026-11-11T01:30:00Z') / 1000;

test('METAR file: parses quoted reports, keeps the newest per station, drops hidden and stale ones', () => {
  const csv = [
    HEAD,
    '"METAR EGLL 110050Z AUTO 04008KT 7000 -RA FEW012 OVC018 09/08 Q1003",EGLL,2026-11-11T00:50:00.000Z,51.477,-0.461,9,8,40,8,,4.35,29.62,-RA,FEW,1200,OVC,1800,MVFR',
    '"METAR EGLL 110020Z 05009KT 9999 BKN020 09/07 Q1003",EGLL,2026-11-11T00:20:00.000Z,51.477,-0.461,9,7,50,9,,6+,29.62,,BKN,2000,,,VFR',
    '"METAR KQEW 110110Z AUTO 02001KT 9999 CLR 07/03 A3035",KQEW,2026-11-11T01:10:00.000Z,-99.9900,-99.9900,7,3,20,1,,6+,30.35,,CLR,,,,VFR',
    '"METAR OLD1 102000Z 00000KT 9999 SKC 10/05 Q1020",OLD1,2026-11-10T20:00:00.000Z,10,10,10,5,0,0,,6+,30.1,,SKC,,,,VFR',
    '"SPECI CYMH 110107Z AUTO VRB03KT 2 1/2SM BR OVC004 04/04 A2966, with a comma",CYMH,2026-11-11T01:07:00.000Z,52.3040,-55.8330,4,4,0,3,,2.5,29.66,BR,OVC,400,,,LIFR',
    '"METAR CALM 110100Z 00000KT CAVOK 12/03 Q1015",CALM,2026-11-11T01:00:00.000Z,40,20,12,3,0,0,,6+,29.97,,CAVOK,,,,VFR',
  ].join('\n');
  const rows = parseMetarCsv(csv, NOW);
  const by = new Map(rows.map((r) => [r[WX.id], r]));
  assert.deepEqual([...by.keys()].sort(), ['CALM', 'CYMH', 'EGLL']);
  const egll = by.get('EGLL')!;
  assert.equal(egll[WX.t], Date.parse('2026-11-11T00:50:00Z') / 1000);
  assert.equal(egll[WX.temp], 9);
  assert.equal(egll[WX.wdir], 40);
  assert.equal(egll[WX.wx], '-RA');
  assert.equal(egll[WX.vis], 4.35);
  // VRB03KT arrives as direction 0 with a speed: variable, not north.
  assert.equal(by.get('CYMH')![WX.wdir], -1);
  assert.equal(by.get('CYMH')![WX.wspd], 3);
  // Calm stays calm.
  assert.equal(by.get('CALM')![WX.wdir], 0);
  assert.equal(by.get('CALM')![WX.wspd], 0);
});

test('METAR file: an unexpected layout is an error, not an empty map', () => {
  assert.throws(() => parseMetarCsv('<html>maintenance</html>', NOW));
});

test('present weather in words', () => {
  assert.equal(wxWords('-RA BR'), 'light rain, mist');
  assert.equal(wxWords('+TSRA'), 'thunderstorm with heavy rain');
  assert.equal(wxWords('-SHSN'), 'light snow showers');
  assert.equal(wxWords('FZFG'), 'freezing fog');
  assert.equal(wxWords('VCTS'), 'thunderstorm nearby');
  assert.equal(wxWords('-RADZ'), 'light rain and drizzle');
  assert.equal(wxWords(''), '');
});

test('the most significant weather wins on the map, and nearby weather is not here', () => {
  assert.equal(wxKind('-RA BR'), 'rain');
  assert.equal(wxKind('TSRA'), 'storm');
  assert.equal(wxKind('-FZRA'), 'freezing');
  assert.equal(wxKind('-SN BR'), 'snow');
  assert.equal(wxKind('FG'), 'fog');
  assert.equal(wxKind('VCSH'), null);
  assert.equal(wxKind('HZ'), 'haze');
  assert.equal(wxKind(''), null);
});

test('relative humidity from temperature and dew point', () => {
  assert.equal(Math.round(humidity(20, 20)), 100);
  assert.equal(Math.round(humidity(20, 10)), 53);
  assert.equal(Math.round(humidity(-5, -10)), 68);
});
