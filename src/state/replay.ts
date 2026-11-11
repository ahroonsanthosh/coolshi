// Replay: the last few hours from the server's snapshots, one a minute,
// blended between snapshots so the picture moves rather than jumps.

import type { ReplayFrame, ReplayIndex } from '../../shared/protocol.ts';

export interface ReplayTrack {
  id: string; kind: 'air' | 'sea'; x: number; y: number;
  alt: number | null; rot: number; flags: number; moving: boolean;
}

export const replay = {
  active: false,
  playing: false,
  /** The moment shown, ms. */
  t: 0,
  from: 0,
  to: 0,
  step: 60_000,
  /** Minutes of replay per second of watching. */
  speed: 60,
  tracks: new Map<string, ReplayTrack>(),
  loading: false,
};

const listeners = new Set<() => void>();
export const onReplay = (fn: () => void) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => fn());

let frames: number[] = [];
const cache = new Map<number, ReplayFrame>();
const pending = new Map<number, Promise<ReplayFrame | null>>();
let bbox: [number, number, number, number] | null = null;
let raf = 0;

export function setReplayBox(b: [number, number, number, number] | null) {
  const key = (x: typeof b) => (x ? x.map((v) => v.toFixed(1)).join(',') : '');
  if (key(b) === key(bbox)) return;
  bbox = b;
  cache.clear();
  if (replay.active) blend();
}

async function frame(t: number): Promise<ReplayFrame | null> {
  const hit = cache.get(t);
  if (hit) return hit;
  let p = pending.get(t);
  if (!p) {
    p = (async () => {
      try {
        const q = `t=${t}${bbox ? `&bbox=${bbox.map((v) => v.toFixed(2)).join(',')}` : ''}`;
        const r = await fetch(`/api/replay/frame?${q}`);
        if (!r.ok) return null;
        const f = (await r.json()) as ReplayFrame;
        cache.set(t, f);
        // Keep a handful around the play head.
        if (cache.size > 8) for (const k of [...cache.keys()].sort((a, b) => Math.abs(a - replay.t) - Math.abs(b - replay.t)).slice(8)) cache.delete(k);
        return f;
      } catch {
        return null;
      } finally {
        pending.delete(t);
      }
    })();
    pending.set(t, p);
  }
  return p;
}

const lerpLon = (a: number, b: number, k: number) => {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  let x = a + d * k;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
};

/** Build the tracks for replay.t from the snapshots either side of it. */
async function blend() {
  const t = replay.t;
  let i = frames.findIndex((f) => f > t) - 1;
  if (i < 0) i = t >= frames[frames.length - 1] ? frames.length - 1 : 0;
  const t0 = frames[i], t1 = frames[Math.min(i + 1, frames.length - 1)];
  replay.loading = !cache.has(t0) || !cache.has(t1);
  const [a, b] = await Promise.all([frame(t0), frame(t1)]);
  // Fetch the next one ahead while this pair plays.
  if (frames[i + 2]) frame(frames[i + 2]);
  replay.loading = false;
  if (!a || t !== replay.t && Math.abs(replay.t - t) > replay.step) return;
  const k = b && t1 > t0 ? Math.min(1, Math.max(0, (replay.t - t0) / (t1 - t0))) : 0;
  const next = new Map<string, ReplayTrack>();
  const bAir = new Map(b?.air.map((r) => [r[0], r]) ?? []);
  for (const r of a.air) {
    const q = bAir.get(r[0]);
    const id = `a:${r[0]}`;
    next.set(id, {
      id, kind: 'air', flags: r[5], moving: true,
      x: q ? lerpLon(r[2], q[2], k) : r[2], y: q ? r[1] + (q[1] - r[1]) * k : r[1],
      alt: q && r[3] !== null && q[3] !== null ? r[3] + (q[3] - r[3]) * k : r[3], rot: r[4] ?? 0,
    });
  }
  const bSea = new Map(b?.sea.map((r) => [r[0], r]) ?? []);
  for (const r of a.sea) {
    const q = bSea.get(r[0]);
    const id = `s:${r[0]}`;
    next.set(id, {
      id, kind: 'sea', flags: 0, moving: r[4] === 1, alt: null, rot: r[3] ?? 0,
      x: q ? lerpLon(r[2], q[2], k) : r[2], y: q ? r[1] + (q[1] - r[1]) * k : r[1],
    });
  }
  replay.tracks = next;
  changed();
}

export async function openReplay(): Promise<boolean> {
  try {
    const r = await fetch('/api/replay');
    if (!r.ok) return false;
    const idx = (await r.json()) as ReplayIndex;
    if (idx.frames.length < 2) return false;
    frames = idx.frames;
    replay.step = idx.step * 1000;
    replay.from = frames[0];
    replay.to = frames[frames.length - 1];
    replay.active = true;
    replay.t = Math.max(replay.from, replay.to - 60 * 60_000);
    await blend();
    changed();
    return true;
  } catch {
    return false;
  }
}

export function closeReplay() {
  pause();
  replay.active = false;
  replay.tracks = new Map();
  cache.clear();
  changed();
}

export function seek(t: number) {
  replay.t = Math.min(replay.to, Math.max(replay.from, t));
  blend();
  changed();
}

export function play() {
  if (replay.playing) return;
  if (replay.t >= replay.to) replay.t = replay.from;
  replay.playing = true;
  let last = performance.now();
  let busy = false;
  const step = (now: number) => {
    if (!replay.playing) return;
    const dt = Math.min(200, now - last);
    last = now;
    // Hold the clock while snapshots load, rather than skipping past them.
    if (!replay.loading) replay.t += dt * replay.speed;
    if (replay.t >= replay.to) { replay.t = replay.to; pause(); }
    if (!busy) { busy = true; blend().finally(() => { busy = false; }); }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  changed();
}

export function pause() {
  replay.playing = false;
  cancelAnimationFrame(raf);
  changed();
}
