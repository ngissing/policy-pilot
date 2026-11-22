import type { Request, Response, NextFunction } from "express";

/**
 * Small in-memory rate limits. PolicyPilot runs as a single process, so memory is enough;
 * counts reset when the server restarts.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** Counts one attempt; returns the seconds to wait if the limit is already used up, else 0. */
export function take(key: string, limit: number, windowMs: number): number {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  if (b.count >= limit) return Math.ceil((b.resetAt - now) / 1000);
  b.count++;
  return 0;
}

export function tooMany(res: Response, waitSeconds: number) {
  const minutes = Math.max(1, Math.ceil(waitSeconds / 60));
  res.setHeader("Retry-After", String(waitSeconds));
  res.status(429).json({ error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
}

/** Middleware: limit by client IP (or by signed-in user when `perUser` is set). */
export function limit(name: string, max: number, windowMs: number, perUser = false) {
  return (req: Request, res: Response, next: NextFunction) => {
    const who = perUser && req.user ? `u${req.user.id}` : req.ip ?? "unknown";
    const wait = take(`${name}:${who}`, max, windowMs);
    if (wait) return tooMany(res, wait);
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 10 * 60_000).unref();
