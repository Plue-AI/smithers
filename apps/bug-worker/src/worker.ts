import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";
import { bugReportSchema } from "./bugReportSchema.ts";
import { BUG_REPORTS_PER_HOUR, checkRateLimit, clientAddress, RATE_LIMIT_PER_HOUR } from "./checkRateLimit.ts";
import { isOperator } from "./isOperator.ts";
import { logFailure } from "./logFailure.ts";
import { newBugId } from "./newBugId.ts";
import { publicBaseUrl } from "./publicBaseUrl.ts";
import { readBodyBounded } from "./readBodyBounded.ts";

export type { BugWorkerDeps } from "./deps.ts";
export type { BugWorkerEnv, BugKv } from "./env.ts";
export { RateLimiter } from "./RateLimiter.ts";

const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Permissive on purpose: the CLI is the main client, but anyone may POST. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, x-bug-admin",
  "access-control-max-age": "86400",
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

async function handlePostBug(request: Request, env: BugWorkerEnv, now: number): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return json(413, { error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  }

  const raw = await readBodyBounded(request, MAX_PAYLOAD_BYTES);
  if (raw === null) {
    return json(413, { error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const result = bugReportSchema.safeParse(parsed);
  if (!result.success) {
    // Field paths only: a schema library's own messages are jargon, never a reply.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.map(String).join(".") || "(body)"))];
    return json(400, { error: "invalid bug report", fields });
  }

  // The budgets count valid reports only, so rejected requests never spend a
  // reporter's hourly quota. A storage exception escaping the fetch handler
  // becomes workerd's 1101 HTML page; answer a clean JSON error instead.
  // An operator skips both budgets, so triage can still file during a flood
  // that has spent the all-clients cap.
  let admitted: "yes" | "client" | "all";
  try {
    admitted = await isOperator(request, env) ? "yes"
      : !(await checkRateLimit(env, `bugs:${clientAddress(request)}`, now)) ? "client"
      : !(await checkRateLimit(env, "bugs:all", now, BUG_REPORTS_PER_HOUR)) ? "all"
      : "yes";
  } catch (error) {
    logFailure("bug_report.failed", request, error);
    return json(503, { error: "storage unavailable" });
  }
  if (admitted === "client") {
    return json(429, { error: `rate limit exceeded (${RATE_LIMIT_PER_HOUR} reports per hour per IP)` });
  }
  if (admitted === "all") {
    logFailure("bug_report.global_limit", request, `all-clients cap of ${BUG_REPORTS_PER_HOUR} reports per hour reached`);
    return json(429, { error: "rate limit exceeded (too many reports this hour; try again later)" });
  }

  const id = newBugId(now);
  const record = { id, receivedAt: new Date(now).toISOString(), report: result.data };
  try {
    await env.BUGS.put(`bug:${id}`, JSON.stringify(record));
  } catch (error) {
    logFailure("bug_report.failed", request, error);
    return json(503, { error: "storage unavailable" });
  }

  return json(201, { id, url: `${publicBaseUrl(env)}/api/bugs/${id}` });
}

async function handleGetBug(request: Request, env: BugWorkerEnv, id: string): Promise<Response> {
  if (!(await isOperator(request, env))) {
    return json(401, { error: "x-bug-admin header required" });
  }
  let stored: string | null;
  try {
    stored = await env.BUGS.get(`bug:${id}`);
  } catch (error) {
    logFailure("bug_report.failed", request, error);
    return json(503, { error: "storage unavailable" });
  }
  if (stored === null) return json(404, { error: "not found" });
  return new Response(stored, {
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

/**
 * Build the worker module with explicit deps; tests inject a controllable
 * clock. The default export uses the real clock.
 */
export function defaultBugWorkerDeps(): BugWorkerDeps {
  return {
    now: () => Date.now(),
  };
}

export function createBugWorker(overrides?: Partial<BugWorkerDeps>) {
  const deps: BugWorkerDeps = { ...defaultBugWorkerDeps(), ...overrides };
  return {
    async fetch(request: Request, env: BugWorkerEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/bugs") {
        return handlePostBug(request, env, deps.now());
      }
      const match = url.pathname.match(/^\/api\/bugs\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && match) {
        return handleGetBug(request, env, match[1]!);
      }
      return json(404, { error: "not found" });
    },
  };
}

export default createBugWorker();
