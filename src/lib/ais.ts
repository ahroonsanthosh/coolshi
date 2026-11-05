// AIS codes, from ITU-R M.1371.

import countries from '../data/countries.json';

const MID: Record<string, string> = (countries as any).mid;

export function shipType(code: number): { label: string; group: string } {
  if (!code) return { label: 'Vessel', group: 'other' };
  const cargoSuffix = (c: number) =>
    ({ 1: ' (hazard A)', 2: ' (hazard B)', 3: ' (hazard C)', 4: ' (hazard D)' } as Record<number, string>)[c % 10] ?? '';
  if (code >= 20 && code <= 29) return { label: 'Wing in ground', group: 'other' };
  if (code === 30) return { label: 'Fishing vessel', group: 'fishing' };
  if (code === 31 || code === 32) return { label: 'Towing vessel', group: 'service' };
  if (code === 33) return { label: 'Dredger', group: 'service' };
  if (code === 34) return { label: 'Diving operations', group: 'service' };
  if (code === 35) return { label: 'Military operations', group: 'military' };
  if (code === 36) return { label: 'Sailing vessel', group: 'leisure' };
  if (code === 37) return { label: 'Pleasure craft', group: 'leisure' };
  if (code >= 40 && code <= 49) return { label: 'High-speed craft' + cargoSuffix(code), group: 'passenger' };
  if (code === 50) return { label: 'Pilot vessel', group: 'service' };
  if (code === 51) return { label: 'Search and rescue', group: 'service' };
  if (code === 52) return { label: 'Tug', group: 'service' };
  if (code === 53) return { label: 'Port tender', group: 'service' };
  if (code === 54) return { label: 'Anti-pollution', group: 'service' };
  if (code === 55) return { label: 'Law enforcement', group: 'military' };
  if (code === 58) return { label: 'Medical transport', group: 'service' };
  if (code === 59) return { label: 'Noncombatant ship', group: 'military' };
  if (code >= 60 && code <= 69) return { label: 'Passenger ship' + cargoSuffix(code), group: 'passenger' };
  if (code >= 70 && code <= 79) return { label: 'Cargo ship' + cargoSuffix(code), group: 'cargo' };
  if (code >= 80 && code <= 89) return { label: 'Tanker' + cargoSuffix(code), group: 'tanker' };
  return { label: 'Vessel', group: 'other' };
}

export const NAV_STATUS: Record<number, string> = {
  0: 'Under way using engine',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted manoeuvrability',
  4: 'Constrained by draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Engaged in fishing',
  8: 'Under way sailing',
  11: 'Towing astern',
  12: 'Pushing ahead or towing alongside',
  14: 'AIS-SART active',
  15: '',
};

/** A ship is stationary if it says so, or barely moving. */
export function isStationary(nav: number, sog: number | null): boolean {
  if (nav === 1 || nav === 5 || nav === 6) return (sog ?? 0) < 2;
  return sog !== null && sog < 0.5;
}

/** Flag state from the MMSI's Maritime Identification Digits. */
export function flagState(mmsi: number): string {
  const s = String(mmsi).padStart(9, '0');
  if (s.startsWith('111')) return MID[s.slice(3, 6)] ? `${MID[s.slice(3, 6)]} (SAR aircraft)` : 'SAR aircraft';
  if (s.startsWith('00')) return MID[s.slice(2, 5)] ? `${MID[s.slice(2, 5)]} (coast station)` : '';
  if (s.startsWith('0')) return MID[s.slice(1, 4)] ?? '';
  if (s.startsWith('98') || s.startsWith('99')) return MID[s.slice(2, 5)] ?? '';
  return MID[s.slice(0, 3)] ?? '';
}
