// Health, for /healthz and Render's health check. Unhealthy when the event
// loop stays badly behind, or no aircraft report has arrived in ten minutes
// of someone watching. Before the first data, and with no one watching, the
// feeds are quiet by design (they poll only while watched): that is healthy,
// so a cold start passes the check.

import { monitorEventLoopDelay } from 'node:perf_hooks';

export const LAG_LIMIT_MS = 1000;
export const QUIET_LIMIT_MS = 600_000;

/** What is wrong, in words; empty when healthy. */
export function healthProblems(s: { now: number; lagP99: number; lastAirAt: number; watchedSince: number }): string[] {
  const out: string[] = [];
  if (s.lagP99 > LAG_LIMIT_MS) out.push(`event loop ${s.lagP99} ms behind (p99)`);
  // Counted from when watching began: feeds are idle while no one watches.
  if (s.watchedSince && s.now - s.watchedSince > QUIET_LIMIT_MS && s.now - Math.max(s.lastAirAt, s.watchedSince) > QUIET_LIMIT_MS) {
    out.push('no aircraft reports for 10 min while watched');
  }
  return out;
}

/**
 * Event-loop delay over a rolling window. p99 rather than max, so one slow
 * request doesn't count but a loop that stays blocked does.
 */
export class LoopLag {
  private h = monitorEventLoopDelay({ resolution: 20 });
  private prev = { mean: 0, p99: 0, max: 0 };

  constructor(windowMs = 30_000) {
    this.h.enable();
    setInterval(() => { this.prev = this.read(); this.h.reset(); }, windowMs).unref();
  }

  // Delays come in ns and include the timer's own 20 ms resolution.
  private read() {
    const ms = (ns: number) => Math.max(0, Math.round((ns || 0) / 1e6 - 20));
    return { mean: ms(this.h.mean), p99: ms(this.h.percentile(99)), max: ms(this.h.max) };
  }

  /** The worse of the window in progress and the last whole one, ms. */
  get() {
    const cur = this.read();
    return cur.p99 > this.prev.p99 ? cur : this.prev;
  }
}
