/**
 * The public server's guards (FACEVISA_PUBLIC=1, behind a reverse proxy): every client IP is rate limited for reads
 * and for actions. Spending limits are per brand, in the FaceVisa data layer and the pipeline.
 */
import type { IncomingMessage } from "node:http";

/** A fixed one-minute window per key (a client IP). */
export class RateLimit {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(readonly perMinute: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.start >= 60_000) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    return ++h.n <= this.perMinute;
  }
}

export interface Guard {
  reads: RateLimit;
  actions: RateLimit;
}

export function guardFromEnv(): Guard | undefined {
  if (process.env.FACEVISA_PUBLIC !== "1") return undefined;
  return { reads: new RateLimit(300), actions: new RateLimit(30) };
}

/** The client's IP: behind the proxy, the last X-Forwarded-For entry (the address the proxy saw). */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "unknown";
}
