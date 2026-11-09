// What an aircraft is, from what ADS-B tells us: the ICAO type designator,
// the emitter category, and the 24-bit address, which ICAO allocates to
// states in blocks (so it names the country of registration).

import countries from '../data/countries.json';

export type AcClass = 'heavy' | 'jet' | 'biz' | 'light' | 'heli' | 'glider' | 'balloon' | 'drone' | 'fighter' | 'unknown';

const HEAVY = /^(A3[3-9]\d|A30[0-9B]|A310|A35K|A388|B74\d|B74[RS]|BLCF|B76\d|B77\d|B77[LW]|B78\d|B3XM|MD11|DC10|L101|IL96|IL76|IL86|A124|A225|C5M?|C17|A400|K35R|KC10|E3TF|E3CF|B52|AN22|C130|C30J|A332|A333|A339|A359|Y20)$/;
const BIZ = /^(C25[0-9ABC]|C5[0-9][0-9A-Z]?|C68A|C700|C750|CL30|CL35|CL60|GL5T|GL7T|GLEX|GLF[2-6]|G150|G280|GA[5-8]C|E35L|E50P|E55P|E545|E550|FA[0-9]{1,2}X?|F2TH|F900|LJ[0-9]{2}|H25[ABC]|HDJT|PRM1|SF50|BE40|PC24|ASTR|GALX|C510|EA50)$/;
const HELI_TYPE = /^(EC\d\d|H\d{2,3}|AS\d\d|AS3[25]|A1[0-9]{2}|AW\d{3}|B06|B06T|B407|B412|B429|B47G|B505|R22|R44|R66|S76|S92|S61|S70|UH1|H60|H64|H47|CH47|MI8|MI17|MI24|MI26|MI28|KA\d\d|NH90|EH10|BK17|EXPL|LYNX|PUMA|TIGR|ALO3|ALH|GAZL|AS50|AS55|AS65|EN28|EN48|HUCO|V22)$/;
const FIGHTER = /^(F1[4-8]|F18[EFS]?|F22|F35|F5|F4|EUFI|RFAL|M200|M2000|MIR2|GRIF|TOR|HAWK|T38|T45|T6|PC21|SU2[4-7]|SU3[0-5]|SU57|MG29|MG31|J10|J11|J20|JF17|A10|AV8B|L39|M346|K8|TEX2|TUCA)$/;
const LIGHT = /^(C1[0-9]{2}|C17[0-9]|C18[0-9]|C20[0-9]|C21[0-9]|C82[RT]?|P28[A-Z0-9]|PA\d{2}|PA[0-9]{2}T|SR2[02]|DA4[02]|DA62|DA20|BE[0-9]{2}|BE3[56]|M20P|M20T|TB[0-9]{2}|RV\d+|AA5|C77R|PC12|TBM[789]|P46T|EPIC|KODI|DHC2|DHC3|DHC6|C208|BN2P|AT[0-9]{2}|ULAC|G115|SIRA|EV97|CRUZ|AC11|PIVI|S22T|P32R|GLID)$/;

const DRONE = /^(Q1|Q4|Q9|Q25|MQ9|RQ4|HRON|H450|H900|TB2|AKNC|WK45|SCAN|S100)$/;

export function classify(type: string, cat: string, desc = ''): AcClass {
  const t = type.toUpperCase();
  if (cat === 'B1' || /GLID|GLIDER/.test(t + desc.toUpperCase())) return 'glider';
  if (cat === 'B2') return 'balloon';
  if (cat === 'B6' || DRONE.test(t) || /\b(UAV|UAS|UNMANNED|DRONE|REAPER|GLOBAL HAWK|TRITON|PREDATOR)\b/i.test(desc)) return 'drone';
  if (cat === 'A7' || HELI_TYPE.test(t) || /HELICOPTER/i.test(desc)) return 'heli';
  if (FIGHTER.test(t) || cat === 'A6') return 'fighter';
  if (cat === 'A5' || HEAVY.test(t)) return 'heavy';
  if (BIZ.test(t)) return 'biz';
  if (cat === 'A1' || LIGHT.test(t)) return 'light';
  if (cat === 'A2' || cat === 'A3' || cat === 'A4' || t) return 'jet';
  return 'unknown';
}

export const CLASS_LABEL: Record<AcClass, string> = {
  heavy: 'Wide-body', jet: 'Airliner', biz: 'Business jet', light: 'Light aircraft', heli: 'Helicopter',
  glider: 'Glider', balloon: 'Balloon', drone: 'Drone', fighter: 'Military jet', unknown: 'Aircraft',
};

const ICAO: [number, number, string, string][] = (countries as any).icao;

/** Country of registration from the ICAO 24-bit address, or null. */
export function registrationCountry(hex: string): { name: string; cc: string } | null {
  if (hex.startsWith('~')) return null; // non-ICAO (TIS-B / anonymous) address
  const n = parseInt(hex, 16);
  if (!isFinite(n)) return null;
  // Smaller blocks are nested inside larger ones; prefer the tightest match.
  let best: [number, number, string, string] | null = null;
  for (const r of ICAO) if (n >= r[0] && n <= r[1] && (!best || r[1] - r[0] < best[1] - best[0])) best = r;
  return best ? { name: best[2], cc: best[3] } : null;
}

export function flagEmoji(cc: string): string {
  if (!/^[a-z]{2}$/i.test(cc)) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

/** "AIRBUS A-320neo" → "Airbus A-320neo" without mangling model codes. */
export function tidyDesc(desc: string): string {
  return desc
    .split(/\s+/)
    .map((w) => (/^[A-Z]{3,}$/.test(w) && !/^(II|III|IV|VIP|STOL|SAR)$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

export const SQUAWK_MEANING: Record<string, string> = {
  '7500': 'Unlawful interference',
  '7600': 'Radio failure',
  '7700': 'General emergency',
  '7000': 'VFR (ICAO)',
  '1200': 'VFR (US)',
  '2000': 'Entering SSR area',
  '7400': 'Lost link (unmanned)',
};
