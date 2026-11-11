// Token buckets: a steady rate with a small allowance for bursts. Used to
// pace our requests to each upstream network, and to limit what any one
// address may ask of us.

export class TokenBucket {
  rate: number; // tokens a second
  readonly burst: number;
  private tokens: number;
  private t: number;

  constructor(rate: number, burst: number, now = Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.t = now;
  }

  private fill(now: number) {
    if (now > this.t) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.t) / 1000) * this.rate);
      this.t = now;
    }
  }

  /** Tokens available now (fractional). */
  peek(now = Date.now()) { this.fill(now); return this.tokens; }

  take(now = Date.now(), n = 1): boolean {
    this.fill(now);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Change the rate from now on (what has accrued so far stands). */
  setRate(rate: number, now = Date.now()) { this.fill(now); this.rate = rate; }

  /** Spend everything: after a 429 the next request waits a full interval. */
  drain(now = Date.now()) { this.fill(now); this.tokens = 0; }

  /** Seconds until `n` tokens are available. */
  wait(now = Date.now(), n = 1) { this.fill(now); return this.tokens >= n ? 0 : (n - this.tokens) / this.rate; }
}

/**
 * The address to hold a client to. Behind a proxy every connection comes
 * from the proxy, which appends the address it saw to X-Forwarded-For;
 * only entries our own proxies added can be believed (anything before them
 * is whatever the client sent). So: the entry `hops` from the end (1, the
 * first hop, for Render), and only when the connection itself comes from a
 * private address. A server facing the internet directly ignores the header.
 */
export function clientIp(peer: string, xff: string | string[] | undefined, hops = 1): string {
  if (!hops || !xff || !isPrivate(peer)) return peer;
  const list = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list[Math.max(0, list.length - hops)] : peer;
}

function isPrivate(a: string): boolean {
  const v4 = a.replace(/^::ffff:/i, '');
  return /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(v4) || a === '::1' || /^f[cd]|^fe80:/i.test(a);
}

/** One bucket per key (a client address), forgotten once idle and full. */
export class KeyedLimiter {
  private m = new Map<string, TokenBucket>();
  readonly rate: number;
  readonly burst: number;
  private maxKeys: number;

  constructor(rate: number, burst: number, maxKeys = 20_000) {
    this.rate = rate;
    this.burst = burst;
    this.maxKeys = maxKeys;
  }

  get size() { return this.m.size; }

  /** Take `n` tokens for `key`; false (and nothing taken) if it hasn't them. */
  take(key: string, now = Date.now(), n = 1): boolean {
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size >= this.maxKeys) this.prune(now);
      // Still full: the oldest keys go first (a Map iterates in insertion order).
      for (const k of this.m.keys()) { if (this.m.size < this.maxKeys) break; this.m.delete(k); }
      this.m.set(key, (b = new TokenBucket(this.rate, this.burst, now)));
    }
    return b.take(now, n);
  }

  /** Whole seconds until `key` may try again (for Retry-After). */
  retryAfter(key: string, now = Date.now(), n = 1): number {
    return Math.max(1, Math.ceil(this.m.get(key)?.wait(now, n) ?? 0));
  }

  /** Drop buckets that have refilled: they hold no more than a new one would. */
  prune(now = Date.now()) {
    for (const [k, b] of this.m) if (b.peek(now) >= this.burst) this.m.delete(k);
  }
}
