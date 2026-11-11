// The weather being observed right now: every METAR station in the world and
// the newest global infrared cloud picture. Fetched only while a weather
// layer is on.

import type { WeatherPayload, WxRow } from '../../shared/protocol.ts';

export const weather = {
  stations: [] as WxRow[],
  byId: new Map<string, WxRow>(),
  /** When the server fetched the stations, ms. */
  at: 0,
  /** Newest satellite cloud image, ms. */
  clouds: null as number | null,
};
const listeners = new Set<() => void>();
export const onWeather = (fn: () => void) => listeners.add(fn);

let loading = false;
export async function loadWeather(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const r = await fetch('/api/weather');
    if (!r.ok) return;
    const d = (await r.json()) as WeatherPayload;
    weather.stations = d.stations;
    weather.byId = new Map(d.stations.map((s) => [s[0], s]));
    weather.at = d.at;
    weather.clouds = d.clouds;
    listeners.forEach((fn) => fn());
  } catch { /* optional layer */ } finally {
    loading = false;
  }
}
