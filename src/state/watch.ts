// Aircraft and ships this viewer is watching, kept on this device.

export interface Watched { id: string; label: string; added: number }

const KEY = 'wf.watch';
function load(): Map<string, Watched> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Watched[];
    return new Map(v.filter((w) => /^[as]:/.test(w.id)).map((w) => [w.id, w]));
  } catch {
    return new Map();
  }
}

export const watchlist = load();
const listeners = new Set<() => void>();
export const onWatch = (fn: () => void) => listeners.add(fn);

function save() {
  try { localStorage.setItem(KEY, JSON.stringify([...watchlist.values()])); } catch { /* private window */ }
  listeners.forEach((fn) => fn());
}

export const isWatched = (id: string) => watchlist.has(id);

/** Returns whether it is now watched. */
export function toggleWatched(id: string, label: string): boolean {
  if (watchlist.has(id)) { watchlist.delete(id); save(); return false; }
  if (watchlist.size >= 50) return false;
  watchlist.set(id, { id, label, added: Date.now() });
  save();
  return true;
}

/** Ships to ask the server for wherever they are (MMSIs). */
export function watchedShips(): number[] {
  return [...watchlist.keys()].filter((k) => k.startsWith('s:')).map((k) => Number(k.slice(2))).slice(0, 20);
}
