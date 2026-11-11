// Aircraft photos from Planespotters.net. Their API is called from our own
// server (browsers are refused), and the answer is passed on unchanged: the
// browser loads the image from Planespotters, links it to the photo's page
// and credits the photographer, as their terms ask. Answers are kept up to
// a day, the longest they allow.

import { getJson } from './http.ts';

export interface PlanePhoto { src: string; link: string; photographer: string }

const DAY = 86_400_000;
const MAX = 5000;

export class Photos {
  private cache = new Map<string, { t: number; v: PlanePhoto | null }>();
  private inflight = new Map<string, Promise<PlanePhoto | null>>();

  get(hex: string, reg: string): Promise<PlanePhoto | null> {
    const key = `${hex}|${reg}`;
    const hit = this.cache.get(key);
    // A miss is asked again after an hour: photos get added.
    if (hit && Date.now() - hit.t < (hit.v ? DAY : 3_600_000)) return Promise.resolve(hit.v);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.lookup(hex, reg).then((v) => {
        if (this.cache.size >= MAX) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { t: Date.now(), v });
        return v;
      }).catch(() => null).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async lookup(hex: string, reg: string): Promise<PlanePhoto | null> {
    const pick = (j: any): PlanePhoto | null => {
      const p = j?.photos?.[0];
      const src = p?.thumbnail_large?.src ?? p?.thumbnail?.src;
      return src && p.link ? { src, link: p.link, photographer: String(p.photographer ?? '') } : null;
    };
    let v = pick((await getJson(`https://api.planespotters.net/pub/photos/hex/${hex}`, {}, 8000)).data);
    if (!v && reg) v = pick((await getJson(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`, {}, 8000)).data);
    return v;
  }
}
