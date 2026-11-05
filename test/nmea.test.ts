import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NmeaAssembler, decodePayload } from '../server/feeds/nmea.ts';

// Reference sentences and values from the gpsd AIVDM/AIVDO protocol guide.

test('type 1 position report', () => {
  const m = decodePayload('177KQJ5000G?tO`K>RA1wUbN0TKH', 0)!;
  assert.equal(m.msgType, 1);
  assert.equal(m.mmsi, 477553000);
  assert.equal(m.nav, 5); // moored
  assert.equal(m.sog, 0);
  assert.ok(Math.abs(m.lon! - -122.345832) < 1e-5);
  assert.ok(Math.abs(m.lat! - 47.582833) < 1e-5);
  assert.equal(m.cog, 51);
  assert.equal(m.hdg, 181);
});

test('type 5 static and voyage data across two sentences', () => {
  const a = new NmeaAssembler();
  assert.equal(a.push('!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C', 1000), null);
  const m = a.push('!AIVDM,2,2,1,A,88888888880,2*25', 1000)!;
  assert.equal(m.msgType, 5);
  assert.equal(m.mmsi, 351759000);
  assert.equal(m.imo, 9134270);
  assert.equal(m.callsign, '3FOF8');
  assert.equal(m.name, 'EVER DIADEM');
  assert.equal(m.type, 70);
  assert.equal(m.len, 225 + 70);
  assert.equal(m.beam, 1 + 31);
  assert.equal(m.eta, '05-15 14:00');
  assert.equal(m.draught, 12.2);
  assert.equal(m.dest, 'NEW YORK');
});

test('tag block receive time is used as the position time', () => {
  const a = new NmeaAssembler();
  const m = a.push('\\s:2573345,c:1793840000*0B\\!BSVDM,1,1,,A,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C', 1793840010)!;
  assert.equal(m.t, 1793840000);
  assert.equal(m.mmsi, 477553000);
});
