// Winds aloft, as measured by aircraft: thousands of airliners report the
// wind they are flying through (from their air data and inertial systems).
// [lat, lon, altitude ft, speed kt, from-direction °, outside air temp °C]

export type WindReport = [number, number, number, number, number, number | null];

export const winds = { reports: [] as WindReport[], at: 0 };
const listeners = new Set<() => void>();
export const onWinds = (fn: () => void) => listeners.add(fn);

export async function loadWinds(): Promise<void> {
  try {
    const r = await fetch('/api/winds');
    if (!r.ok) return;
    // Keep only physically plausible winds (the strongest jet streams
    // measured reach about 250 kt).
    winds.reports = ((await r.json()) as WindReport[]).filter((w) => w[3] >= 0 && w[3] <= 260);
    winds.at = Date.now();
    listeners.forEach((fn) => fn());
  } catch { /* optional layer */ }
}

/** ISA temperature (°C) at a pressure altitude, troposphere and tropopause. */
export function isaTemp(ft: number): number {
  return ft < 36_089 ? 15 - 1.98 * (ft / 1000) : -56.5;
}
