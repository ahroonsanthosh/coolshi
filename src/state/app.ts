// UI state shared by the map and the panels, with the few preferences worth
// remembering kept in localStorage (guarded: private windows may refuse).

import type { AcClass } from '../lib/aircraft.ts';

export type LayerKey =
  | 'aircraft' | 'ships' | 'labels' | 'airports' | 'quakes' | 'disasters' | 'news' | 'iss' | 'space' | 'radar' | 'night' | 'trails' | 'winds'
  | 'weather' | 'clouds';

export type AcFilter = AcClass | 'ground' | 'military';

export interface Selection {
  kind: 'air' | 'sea' | 'quake' | 'disaster' | 'airport' | 'iss' | 'news' | 'sat' | 'launch' | 'wx';
  id: string;
}

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  aircraft: true, ships: true, labels: true, airports: true, quakes: true, disasters: true, news: true, iss: true, space: true,
  radar: false, night: true, trails: true, winds: false, weather: false, clouds: false,
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}

type Listener = () => void;

class AppState {
  layers = load('wf.layers', DEFAULT_LAYERS);
  hidden = new Set<AcFilter>(load<{ v: AcFilter[] }>('wf.hidden', { v: [] }).v);
  selection: Selection | null = null;
  hover: Selection | null = null;
  follow = false;
  private ls = new Map<string, Set<Listener>>();

  on(ev: 'layers' | 'selection' | 'hover' | 'filter' | 'follow', fn: Listener) {
    if (!this.ls.has(ev)) this.ls.set(ev, new Set());
    this.ls.get(ev)!.add(fn);
  }
  private emit(ev: string) {
    for (const fn of this.ls.get(ev) ?? []) fn();
  }

  setLayer(k: LayerKey, v: boolean) {
    this.layers[k] = v;
    save('wf.layers', this.layers);
    this.emit('layers');
  }
  /** Show only military aircraft (everything else on the map stays). */
  milOnly = load<{ v: boolean }>('wf.milOnly', { v: false }).v;
  setMilOnly(v: boolean) {
    this.milOnly = v;
    save('wf.milOnly', { v });
    this.emit('filter');
  }
  toggleFilter(f: AcFilter) {
    if (this.hidden.has(f)) this.hidden.delete(f);
    else this.hidden.add(f);
    save('wf.hidden', { v: [...this.hidden] });
    this.emit('filter');
  }
  select(s: Selection | null) {
    if (s?.id === this.selection?.id && s?.kind === this.selection?.kind) return;
    this.selection = s;
    if (!s) this.follow = false;
    this.emit('selection');
    this.emit('follow');
    const hash = s && (s.kind === 'air' || s.kind === 'sea') ? `#${s.id}` : ' ';
    try { history.replaceState(null, '', hash === ' ' ? location.pathname + location.search : hash); } catch { /* ignore */ }
  }
  setHover(s: Selection | null) {
    if (s?.id === this.hover?.id) return;
    this.hover = s;
    this.emit('hover');
  }
  setFollow(v: boolean) {
    this.follow = v;
    this.emit('follow');
  }
}

export const app = new AppState();
