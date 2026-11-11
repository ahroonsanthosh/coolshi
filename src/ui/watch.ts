// Tell the viewer when something they are watching changes: comes into
// range, takes off, lands, squawks an emergency, gets under way or stops.
// A note on the page, and a system notification when the tab is hidden and
// they have allowed it.

import { A, AF } from '../../shared/protocol.ts';
import { SQUAWK_MEANING } from '../lib/aircraft.ts';
import { picture, reportAge, type Aircraft, type Ship } from '../state/data.ts';
import { app } from '../state/app.ts';
import { onWatch, watchlist, type Watched } from '../state/watch.ts';
import { flyTo } from '../map/mapView.ts';
import { toast } from './chrome.ts';
import * as F from '../lib/format.ts';

interface Seen { present: boolean; ground: boolean | null; em: boolean; still: boolean | null }
const seen = new Map<string, Seen>();

function now(w: Watched): Seen {
  const t = picture.get(w.id);
  if (!t || reportAge(t) > t.staleAfter) return { present: false, ground: null, em: false, still: null };
  if (t.kind === 'air') {
    const f = (t as Aircraft).row[A.flags];
    return { present: true, ground: (f & AF.ground) !== 0, em: (f & AF.emergency) !== 0, still: null };
  }
  return { present: true, ground: null, em: false, still: (t as Ship).still };
}

function go(id: string) {
  const t = picture.get(id);
  if (!t) return;
  app.select({ kind: id.startsWith('a:') ? 'air' : 'sea', id });
  flyTo(t.x, t.y, 8);
}

function tell(w: Watched, what: string) {
  toast('Watching', `${F.esc(w.label)} · ${F.esc(what)}`, () => go(w.id), 'watch', 60_000);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(`${w.label}: ${what}`, { tag: `${w.id}:${what}`, body: 'Watchman' });
      n.onclick = () => { window.focus(); go(w.id); n.close(); };
    } catch { /* some browsers only notify from a service worker */ }
  }
}

function check() {
  // Wait for the first full picture, or everything would "come into range".
  if (!picture.aircraft.size) return;
  for (const w of watchlist.values()) {
    const cur = now(w);
    const prev = seen.get(w.id);
    seen.set(w.id, cur);
    if (!prev) continue;
    if (!prev.present && cur.present) tell(w, cur.ground ? 'in range, on the ground' : 'in range');
    else if (prev.present && cur.present) {
      if (prev.ground === true && cur.ground === false) tell(w, 'took off');
      if (prev.ground === false && cur.ground === true) tell(w, 'landed');
      if (prev.still === true && cur.still === false) tell(w, 'under way');
      if (prev.still === false && cur.still === true) tell(w, 'stopped');
    }
    if (!prev.em && cur.em) {
      const a = picture.aircraft.get(w.id);
      const sq = a?.row[A.sq] ?? '';
      tell(w, `squawking ${sq || 'emergency'}${SQUAWK_MEANING[sq] ? `, ${SQUAWK_MEANING[sq].toLowerCase()}` : ''}`);
    }
  }
  for (const k of seen.keys()) if (!watchlist.has(k)) seen.delete(k);
}

export function initWatch() {
  setInterval(check, 3000);
  onWatch(() => { for (const w of watchlist.values()) if (!seen.has(w.id)) seen.set(w.id, now(w)); });
}
