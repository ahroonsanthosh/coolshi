// The browser's copy of the news desk: headlines the aggregator gathered from
// open feeds, refreshed every two minutes, with helpers to find the stories
// that concern one place, airline or ship.

import type { NewsItem, NewsPayload, SourceStatus } from '../../shared/protocol.ts';
import { distance } from '../../shared/geo.ts';

class NewsDesk {
  items: NewsItem[] = [];
  feeds: SourceStatus[] = [];
  loaded = false;
  private ls = new Set<() => void>();

  on(fn: () => void) { this.ls.add(fn); return () => this.ls.delete(fn); }

  start() {
    const tick = async () => {
      try {
        const r = await fetch('/api/news');
        if (r.ok) {
          const d = (await r.json()) as NewsPayload;
          this.items = d.items ?? [];
          this.feeds = d.feeds ?? [];
          this.loaded = true;
          for (const fn of this.ls) fn();
        }
      } catch { /* try again next round */ }
      setTimeout(tick, document.hidden ? 300_000 : 120_000);
    };
    tick();
  }

  /** Stories pinned to one place (the map groups them by place name). */
  at(place: string): NewsItem[] {
    return this.items.filter((i) => i.place?.name === place);
  }

  /** Stories whose place lies within `km` of a point. */
  near(lat: number, lon: number, km: number): NewsItem[] {
    return this.items.filter((i) => i.place && i.place.kind === 'city' && distance(lat, lon, i.place.lat, i.place.lon) <= km * 1000);
  }

  /** Stories whose headline names any of `terms` as whole words. */
  mentioning(terms: string[], topics?: NewsItem['topic'][]): NewsItem[] {
    const res = terms.map((t) => t.trim()).filter((t) => t.length >= 4)
      .map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu'));
    if (!res.length) return [];
    return this.items.filter((i) => (!topics || topics.includes(i.topic)) && res.some((re) => re.test(i.title)));
  }
}

export const news = new NewsDesk();
