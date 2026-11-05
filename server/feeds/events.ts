// Things that happen to the planet rather than move across it: earthquakes
// (USGS), disasters with an alert level (GDACS) and the space station.

import type { Disaster, Quake } from '../../shared/protocol.ts';
import { getJson, Status } from './http.ts';

export class Usgs {
  status = new Status('usgs', 'USGS earthquakes', 'event', 120);
  quakes: Quake[] = [];

  async poll() {
    try {
      // M2.5+ worldwide over the past day, plus M4.5+ over the past week so
      // the biggest recent event is still known after it scrolls off a day.
      const [day, week] = await Promise.all([
        getJson<any>('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'),
        getJson<any>('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson'),
      ]);
      const seen = new Set<string>();
      const out: Quake[] = [];
      for (const f of [...day.data.features, ...week.data.features]) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const p = f.properties;
        const [lon, lat, depth] = f.geometry.coordinates;
        if (p.mag == null) continue;
        out.push({
          id: f.id, mag: p.mag, magType: p.magType ?? '', place: p.place ?? '', time: p.time,
          lat, lon, depth, felt: p.felt ?? null, tsunami: p.tsunami === 1, alert: p.alert ?? null,
          sig: p.sig ?? 0, url: p.url,
        });
      }
      out.sort((a, b) => b.time - a.time);
      this.quakes = out;
      this.status.success(out.length, 'M2.5+ past day, M4.5+ past week');
    } catch (e) {
      this.status.fail(e);
    }
  }
}

const GDACS_TYPES: Record<string, string> = {
  EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire', TS: 'Tsunami',
};

export class Gdacs {
  status = new Status('gdacs', 'GDACS disaster alerts', 'event', 900);
  events: Disaster[] = [];

  async poll() {
    try {
      const { data } = await getJson<any>('https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP', {}, 40_000);
      const out: Disaster[] = [];
      for (const f of data.features ?? []) {
        const p = f.properties;
        if (p.iscurrent === 'false') continue;
        // Earthquakes come from USGS directly; GDACS adds the rest.
        if (p.eventtype === 'EQ') continue;
        const [lon, lat] = f.geometry.coordinates;
        out.push({
          id: `${p.eventtype}${p.eventid}`,
          type: GDACS_TYPES[p.eventtype] ?? p.eventtype,
          name: p.eventname || p.name,
          alert: p.alertlevel,
          country: p.country ?? '',
          lat, lon,
          from: Date.parse(p.fromdate + 'Z'),
          to: Date.parse(p.todate + 'Z'),
          severity: p.severitydata?.severitytext ?? '',
          url: p.url?.report ?? '',
        });
      }
      this.events = out;
      this.status.success(out.length, 'current events');
    } catch (e) {
      this.status.fail(e);
    }
  }
}

/**
 * The ISS: positions from wheretheiss.at (propagated from the current TLE)
 * a minute apart, from 45 minutes back to 45 ahead, so the browser can draw
 * the ground track and interpolate the station between samples.
 */
export class Iss {
  status = new Status('iss', 'ISS position', 'event', 300);
  track: { t: number; lat: number; lon: number; alt: number; vel: number }[] = [];

  async poll() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const stamps: number[] = [];
      for (let m = -45; m <= 45; m++) stamps.push(now + m * 60);
      const out: typeof this.track = [];
      // The API takes at most 10 timestamps a request; go gently.
      for (let i = 0; i < stamps.length; i += 10) {
        const { data } = await getJson<any[]>(
          `https://api.wheretheiss.at/v1/satellites/25544/positions?timestamps=${stamps.slice(i, i + 10).join(',')}&units=kilometers`,
        );
        for (const p of data) out.push({ t: p.timestamp, lat: p.latitude, lon: p.longitude, alt: p.altitude, vel: p.velocity });
        await new Promise((r) => setTimeout(r, 1200));
      }
      this.track = out;
      this.status.success(1, '±45 min ground track');
    } catch (e) {
      this.status.fail(e);
    }
  }
}
