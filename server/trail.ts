// Track history, kept compact. A V8 object per point costs about 140 bytes;
// here a point is four or five Int32 fields in one typed array per track
// (16 B for a ship, 20 B for an aircraft), grown as the track lengthens and
// used as a ring once full, so a track's memory is bounded however long it
// lives. Positions are kept to 1e-6° (about 10 cm), time to 0.1 s, speed to
// 0.1 kt, altitude to the foot: what the feeds send, give or take rounding.

import type { HistoryPoint } from '../shared/protocol.ts';

const NIL = -0x80000000;
const enc = (v: number | null | undefined, k: number) => (v == null || !isFinite(v) ? NIL : Math.round(v * k));
const dec = (v: number, k: number) => (v === NIL ? null : v / k);

export class Trail {
  private d: Int32Array | null = null;
  private head = 0; // slot of the oldest point
  private n = 0;
  private t0 = 0; // whole seconds; times are stored in tenths after it
  private readonly w: number;
  private readonly max: number;
  /** Track or course over ground (°) at the newest point, if known. */
  lastTrk: number | null = null;

  constructor(maxPoints: number, withAlt: boolean) {
    this.max = maxPoints;
    this.w = withAlt ? 5 : 4; // t, lat, lon, gs[, alt]
  }

  get length() { return this.n; }
  /** Bytes held by the point store (for measuring). */
  get bytes() { return this.d?.byteLength ?? 0; }

  private slot(i: number) { return ((this.head + i) % (this.d!.length / this.w)) * this.w; }

  /** The newest point, or null. */
  last(): HistoryPoint | null { return this.n ? this.at(this.n - 1) : null; }

  private at(i: number): HistoryPoint {
    const d = this.d!, s = this.slot(i);
    return {
      t: (this.t0 * 10 + d[s]) / 10,
      lat: d[s + 1] / 1e6,
      lon: d[s + 2] / 1e6,
      alt: this.w === 5 ? dec(d[s + 4], 1) : null,
      gs: dec(d[s + 3], 10),
    };
  }

  push(t: number, lat: number, lon: number, alt: number | null, gs: number | null, trk: number | null = null) {
    if (!this.n) { this.t0 = Math.floor(t); this.head = 0; }
    const cap = this.d ? this.d.length / this.w : 0;
    if (this.n === cap) {
      if (cap < this.max) {
        // Grow by half (16 points to start), oldest first in the new store.
        const next = new Int32Array(Math.min(this.max, Math.max(16, Math.ceil(cap * 1.5))) * this.w);
        for (let i = 0; i < this.n; i++) next.set(this.d!.subarray(this.slot(i), this.slot(i) + this.w), i * this.w);
        this.d = next;
        this.head = 0;
      } else {
        // Full: the newest point replaces the oldest.
        this.head = (this.head + 1) % cap;
        this.n--;
      }
    }
    const d = this.d!, s = this.slot(this.n);
    d[s] = Math.max(0, Math.round((t - this.t0) * 10));
    d[s + 1] = Math.round(lat * 1e6);
    d[s + 2] = Math.round(lon * 1e6);
    d[s + 3] = enc(gs, 10);
    if (this.w === 5) d[s + 4] = enc(alt, 1);
    this.n++;
    this.lastTrk = trk;
  }

  /** Forget points older than `t` (s). */
  dropBefore(t: number) {
    const lim = Math.round((t - this.t0) * 10);
    while (this.n && this.d![this.slot(0)] < lim) {
      this.head = (this.head + 1) % (this.d!.length / this.w);
      this.n--;
    }
    if (!this.n) { this.d = null; this.head = 0; }
  }

  /** The wire form, oldest first: the same objects the API always sent. */
  points(): HistoryPoint[] {
    const out: HistoryPoint[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.at(i);
    return out;
  }
}

/** Smallest angle between two bearings, degrees. */
export function turned(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}
