// Shared plumbing for polled feeds: a polite fetch with a timeout and a
// status record the UI reads to say honestly what is and isn't live.

import type { SourceStatus } from '../../shared/protocol.ts';

export const UA = 'Watchman/1.0 (+https://github.com/ahroonsanthosh/coolshi)';

export class HttpError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(status: number, retryAfter: number | null, message: string) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After is seconds or an HTTP date; seconds from now, or null. */
export function retryAfter(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : null;
}

export async function getJson<T = any>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<{ data: T; res: Response }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip', ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const ra = res.headers.get('retry-after') ?? res.headers.get('x-rate-limit-retry-after-seconds');
      throw new HttpError(res.status, retryAfter(ra), `${res.status} ${res.statusText}`.trim());
    }
    return { data: (await res.json()) as T, res };
  } finally {
    clearTimeout(timer);
  }
}

export class Status implements SourceStatus {
  ok = false;
  lastOk = 0;
  lastError = '';
  note = '';
  count = 0;
  id: string;
  name: string;
  kind: 'air' | 'sea' | 'event' | 'news';
  interval: number;
  constructor(id: string, name: string, kind: 'air' | 'sea' | 'event' | 'news', interval: number) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.interval = interval;
  }
  success(count: number, note = '') {
    this.ok = true;
    this.lastOk = Date.now();
    this.lastError = '';
    this.count = count;
    this.note = note;
  }
  fail(err: unknown, note = '') {
    this.ok = false;
    this.lastError = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err);
    if (note) this.note = note;
  }
  toJSON(): SourceStatus {
    const { id, name, kind, ok, lastOk, lastError, note, count, interval } = this;
    return { id, name, kind, ok, lastOk, lastError, note, count, interval };
  }
}

/** Run `fn` every `everyS` seconds, never overlapping, starting now. */
export function every(everyS: () => number, fn: () => Promise<number | void>): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    let wait = everyS();
    try {
      const override = await fn();
      if (typeof override === 'number') wait = override;
    } catch (e) {
      console.warn('[feed]', e);
    }
    if (!stopped) timer = setTimeout(tick, Math.max(0.5, wait) * 1000);
  };
  tick();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
