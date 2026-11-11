// Reading a METAR's present-weather group in plain words.

/** What the weather is doing, by what matters most on a map. */
export type WxKind = 'storm' | 'freezing' | 'snow' | 'rain' | 'fog' | 'dust' | 'ash' | 'haze' | null;

const PRECIP: Record<string, string> = {
  RA: 'rain', DZ: 'drizzle', SN: 'snow', SG: 'snow grains', PL: 'ice pellets', GR: 'hail', GS: 'small hail', IC: 'ice crystals', UP: 'precipitation',
};
const OBSCURE: Record<string, string> = {
  FG: 'fog', BR: 'mist', HZ: 'haze', FU: 'smoke', VA: 'volcanic ash', DU: 'dust', SA: 'sand', PY: 'spray',
};
const OTHER: Record<string, string> = {
  SQ: 'squalls', FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm', PO: 'dust whirls',
};

/**
 * One METAR weather group ("-SHRA", "+TSRA", "VCFG", "FZFG") in words:
 * "light rain showers", "thunderstorm with heavy rain", "fog nearby".
 */
function group(g: string): string {
  let s = g;
  let intensity = '';
  if (s.startsWith('+')) { intensity = 'heavy '; s = s.slice(1); }
  else if (s.startsWith('-')) { intensity = 'light '; s = s.slice(1); }
  let near = false;
  if (s.startsWith('VC')) { near = true; s = s.slice(2); }
  let desc = '';
  const d = s.slice(0, 2);
  if (['MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ'].includes(d) && s.length > 2) { desc = d; s = s.slice(2); }
  else if (s === 'TS') { desc = 'TS'; s = ''; }
  else if (s === 'SH') { desc = 'SH'; s = ''; }
  const kinds: string[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) {
    const c = s.slice(i, i + 2);
    kinds.push(PRECIP[c] ?? OBSCURE[c] ?? OTHER[c] ?? c);
  }
  const what = kinds.join(' and ');
  let out: string;
  if (desc === 'TS') out = what ? `thunderstorm with ${intensity}${what}` : 'thunderstorm';
  else if (desc === 'SH') out = what ? `${intensity}${what} showers` : 'showers';
  else if (desc === 'FZ') out = `${intensity}freezing ${what}`;
  else if (desc === 'BL') out = `blowing ${what}`;
  else if (desc === 'DR') out = `drifting ${what}`;
  else if (desc === 'MI') out = `shallow ${what}`;
  else if (desc === 'BC') out = `patches of ${what}`;
  else if (desc === 'PR') out = `partial ${what}`;
  else out = `${intensity}${what}`;
  return near ? `${out} nearby` : out;
}

/** The present weather in words, "" when nothing is reported. */
export function wxWords(wx: string): string {
  if (!wx) return '';
  return wx.split(/\s+/).filter(Boolean).map(group).join(', ');
}

/** The most significant kind of weather in the group, for the map. */
export function wxKind(wx: string): WxKind {
  if (!wx) return null;
  const here = wx.split(/\s+/).filter((g) => !g.includes('VC'));
  const has = (re: RegExp) => here.some((g) => re.test(g));
  if (has(/TS|FC|SQ/)) return 'storm';
  if (has(/FZ(RA|DZ)|PL/)) return 'freezing';
  if (has(/SN|SG|GR|GS|IC/)) return 'snow';
  if (has(/RA|DZ|UP|SH/)) return 'rain';
  if (has(/VA/)) return 'ash';
  if (has(/FG/)) return 'fog';
  if (has(/DU|SA|SS|DS|PO/)) return 'dust';
  if (has(/BR|HZ|FU/)) return 'haze';
  return null;
}

/** Relative humidity (%) from temperature and dew point (Magnus formula). */
export function humidity(t: number, dew: number): number {
  const g = (x: number) => (17.625 * x) / (243.04 + x);
  return Math.max(0, Math.min(100, 100 * Math.exp(g(dew) - g(t))));
}
