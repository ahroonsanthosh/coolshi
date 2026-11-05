const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

export const n0 = (v: number) => nf0.format(v);
export const n1 = (v: number) => nf1.format(v);

export function altitude(ft: number | null, ground = false): string {
  if (ground) return 'On ground';
  if (ft === null) return '—';
  if (ft >= 18000) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
  return `${n0(Math.round(ft / 25) * 25)} ft`;
}

export function altitudeSub(ft: number | null, ground = false): string {
  if (ground || ft === null) return '';
  return `${n0(ft)} ft · ${n0(ft * 0.3048)} m`;
}

export function speed(kt: number | null): string {
  return kt === null ? '—' : `${n0(kt)} kt`;
}

export function compass(deg: number | null): string {
  if (deg === null) return '';
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
    Math.round(((deg % 360) + 360) % 360 / 22.5) % 16
  ];
}

export function heading(deg: number | null): string {
  return deg === null ? '—' : `${String(Math.round(deg) % 360).padStart(3, '0')}°`;
}

export function ago(sec: number): string {
  if (!isFinite(sec)) return '—';
  if (sec < 1) return 'just now';
  if (sec < 60) return `${Math.round(sec)} s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return m ? `${h} h ${m} min ago` : `${h} h ago`;
  }
  return `${Math.round(sec / 86400)} d ago`;
}

export function km(m: number): string {
  if (m < 10_000) return `${n1(m / 1000)} km`;
  return `${n0(m / 1000)} km`;
}

export function utc(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${withSeconds ? ':' + p(d.getUTCSeconds()) : ''}`;
}

export function latLon(lat: number, lon: number): string {
  const f = (v: number, pos: string, neg: string) => {
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return `${d}°${m.toFixed(2).padStart(5, '0')}′${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 'N', 'S')}  ${f(lon, 'E', 'W')}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
