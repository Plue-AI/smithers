import type { BugWorkerEnv } from "./env.ts";
import type { RateLimitRequest } from "./RateLimiter.ts";

/**
 * Accepted bug reports per hour across all clients. Rotating addresses defeats
 * any per-client budget, so this bounds the KV bytes anonymous intake can add:
 * at most this many 256 KB reports (500 MB) an hour. It sits far above organic
 * volume so a flood needs 100 clients to spend it; operators bypass it, and a
 * refusal logs `bug_report.global_limit` so the flood is visible.
 */
export const BUG_REPORTS_PER_HOUR = 2000;
/** Default budget: accepted writes per client per hour, per route bucket. */
export const RATE_LIMIT_PER_HOUR = 20;
/**
 * The client a request is charged to. Only Cloudflare's `cf-connecting-ip` is
 * trusted: `x-forwarded-for` is caller-written. An IPv6 client is charged per
 * /64, the smallest prefix one subscriber is routinely assigned, so rotating
 * addresses inside it shares one budget.
 */
export function clientAddress(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim().toLowerCase();
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  // An IPv4-mapped address (::ffff:192.0.2.1) is charged to its IPv4 address.
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * Admit one request against `bucket`'s hourly budget. The count lives in the
 * `RateLimiter` Durable Object named by the bucket, which increments it
 * atomically, so a concurrent burst gets exactly `limit` admissions.
 */
export async function checkRateLimit(env: BugWorkerEnv, bucket: string, now: number, limit = RATE_LIMIT_PER_HOUR): Promise<boolean> {
  const body: RateLimitRequest = { hour: Math.floor(now / 3_600_000), limit };
  const answer = await env.RATE_LIMITS.getByName(bucket).fetch(new Request("https://rate-limiter/", { method: "POST", body: JSON.stringify(body) }));
  if (!answer.ok) throw new Error(`Rate limiter answered ${answer.status}`);
  return (await answer.json() as { allowed: boolean }).allowed;
}
