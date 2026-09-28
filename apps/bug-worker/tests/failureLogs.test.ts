import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import type { BugKv, BugWorkerEnv } from "../src/env.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits, memoryRepoCompletions } from "./helpers/memoryDurableObjects.ts";

/**
 * Every 503 the Worker answers must leave one structured log line behind, so
 * Workers Logs can tell a KV outage from a GitHub outage from a code defect.
 */
const ADMIN = "test-admin";
const offline = (): BugKv => {
  const fail = async (): Promise<never> => { throw new Error("KV namespace unavailable"); };
  return { get: fail, put: fail, delete: fail, list: fail };
};

let errors: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });

function logged(): Record<string, unknown>[] {
  return errors.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

async function answer(request: Request, env: BugWorkerEnv, fetchImpl?: typeof fetch) {
  const worker = createBugWorker({ now: () => 1788500000000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return worker.fetch(request, env);
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://bug.smithers.sh${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("failure logs", () => {
  const cases: [string, () => Request, string][] = [
    ["bug report post", () => post("/api/bugs", { summary: "x" }), "bug_report.failed"],
    ["bug report read", () => new Request("https://bug.smithers.sh/api/bugs/abc123", { headers: { "x-bug-admin": ADMIN } }), "bug_report.failed"],
    ["repo request list", () => new Request("https://bug.smithers.sh/api/repo-requests"), "repo_request.failed"],
    ["repo confirm", () => post(`/api/repo-requests/confirm?token=${"0".repeat(32)}`, {}), "repo_request.failed"],
    ["repo cancel", () => post(`/api/repo-requests/cancel?token=${"0".repeat(32)}`, {}), "repo_request.failed"],
    ["repo claim read", () => new Request("https://bug.smithers.sh/api/repo-claims?repo=owner/repo"), "repo_claim.failed"],
  ];
  for (const [name, request, event] of cases) {
    test(`${name} logs the route and cause before answering 503`, async () => {
      const req = request();
      const response = await answer(req, { BUGS: offline(), REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN });
      expect(response.status).toBe(503);
      expect(logged()).toEqual([{ event, route: `${req.method} ${new URL(req.url).pathname}`, error: "KV namespace unavailable" }]);
    });
  }

  test("a report write failure after rate-limit admission returns one storage refusal", async () => {
    const kv = memoryKv();
    const writes: string[] = [];
    const env: BugWorkerEnv = {
      BUGS: { ...kv, put: async (key, value, options) => {
        writes.push(key);
        if (key.startsWith("bug:")) throw new Error("report write unavailable");
        await kv.put(key, value, options);
      } },
      REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN,
    };
    const response = await answer(post("/api/bugs", { summary: "lost report" }), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storage unavailable" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(writes).toEqual([expect.stringMatching(/^bug:/)]);
    const reports = writes.filter(key => key.startsWith("bug:"));
    expect(reports).toHaveLength(1);
    expect(await kv.get(reports[0]!)).toBeNull();
    expect(logged()).toEqual([{ event: "bug_report.failed", route: "POST /api/bugs", error: "report write unavailable" }]);
  });

  test("a KV outage during the notification cron is logged, never a failed scheduled event", async () => {
    const worker = createBugWorker({ now: () => 1788500000000 });
    const env: BugWorkerEnv = { BUGS: offline(), REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN, RESEND_API_KEY: "key", NOTIFICATION_FROM: "from@example.com" };
    await worker.scheduled({}, env);
    expect(logged()).toEqual([{ event: "repo_notification.failed", route: "scheduled", error: "KV namespace unavailable" }]);
  });

  test("the notification sweep logs whose fault each undelivered repository is", async () => {
    const kv = memoryKv();
    const env: BugWorkerEnv = { BUGS: kv, REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN, RESEND_API_KEY: "key", NOTIFICATION_FROM: "from@example.com" };
    const ready = JSON.stringify({ appUrl: "https://app.smithers.sh/r", completedAt: "2026-01-01T00:00:00.000Z" });
    await kv.put("repo-ready:a/bad", "{");
    await kv.put("repo-ready:b/down", ready);
    await kv.put("repo-subscriber:b/down:one", "one@example.com");
    await kv.put("repo-ready:c/refused", ready);
    await kv.put("repo-subscriber:c/refused:one", "refused@example.com");
    await kv.put("repo-notification-failure:repo-subscriber:c/refused:one", JSON.stringify({ attempts: 2 }));
    // The queue holds two repositories; the scan reaches the corrupt one.
    for (const name of ["b/down", "c/refused"]) await kv.put(`repo-pending:${name}`, "");
    const provider = (async (_input: string, init: RequestInit) => {
      const to = (JSON.parse(String(init.body)) as { to: string[] }).to[0];
      return new Response("", { status: to === "refused@example.com" ? 422 : 503 });
    }) as unknown as typeof fetch;
    const worker = createBugWorker({ now: () => 1788500000000, fetch: provider });
    const swept = spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled({}, env);
      expect(swept.mock.calls.map((args) => JSON.parse(String(args[0])))).toContainEqual(
        { event: "repo_notification.swept", route: "scheduled", repo: "b/down", sent: 0, rejected: 0, pending: true, cut: "unavailable" });
    } finally { swept.mockRestore(); }
    expect(logged()).toEqual([
      { event: "repo_notification.unavailable", route: "scheduled", repo: "b/down", error: "Email provider returned HTTP 503" },
      { event: "repo_notification.terminal", route: "scheduled", repo: "c/refused", key: "repo-subscriber:c/refused:one", error: "Email provider returned HTTP 422" },
      { event: "repo_notification.failed", route: "scheduled", repo: "a/bad", error: expect.any(String) },
    ]);
  });

  test("a Durable Object failure is logged before answering 503", async () => {
    const failing = { getByName: () => ({ fetch: async () => new Response("", { status: 500 }) }) };
    const env: BugWorkerEnv = { BUGS: memoryKv(), REPO_COMPLETIONS: failing, RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN };
    await env.BUGS.put("repo-request:owner/repo", JSON.stringify({ name: "owner/repo", url: "https://github.com/owner/repo" }));
    for (const route of ["/complete", "/notify"]) {
      const response = await answer(post(`/api/repo-requests${route}`, { repo: "owner/repo", appUrl: "https://app.smithers.sh/r" }, { "x-bug-admin": ADMIN }), env);
      expect(response.status).toBe(503);
    }
    expect(logged()).toEqual(["complete", "notify"].map((route) =>
      ({ event: "repo_request.failed", route: `POST /api/repo-requests/${route}`, error: "Repository completion answered 500" })));
    expect(await env.BUGS.get("repo-ready:owner/repo")).toBeNull();
    expect(await env.BUGS.get("repo-pending:owner/repo")).toBeNull();
  });

  test("a failed confirmation names its fault and still answers the nomination", async () => {
    const github = { private: false, license: { spdx_id: "MIT" } };
    const cases: [string, number, (kv: ReturnType<typeof memoryKv>) => BugKv, string][] = [
      ["repo_confirmation.failed", 200, (kv) => ({ ...kv, put: async (key, value, options) => {
        if (key.startsWith("repo-confirm:")) throw new Error("KV namespace unavailable");
        await kv.put(key, value, options);
      } }), "KV namespace unavailable"],
      ["repo_confirmation.unavailable", 503, (kv) => kv, "Email provider returned HTTP 503"],
      ["repo_confirmation.rejected", 422, (kv) => kv, "Email provider returned HTTP 422"],
    ];
    for (const [event, providerStatus, store, error] of cases) {
      errors.mockClear();
      const env: BugWorkerEnv = { BUGS: store(memoryKv()), REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN, RESEND_API_KEY: "key", NOTIFICATION_FROM: "from@example.com" };
      const provider = (async (input: string) =>
        String(input).includes("api.github.com") ? Response.json(github) : new Response("", { status: providerStatus })) as unknown as typeof fetch;
      const response = await answer(post("/api/repo-requests", { repo: "owner/repo", email: "fan@example.com" }, { "x-bug-admin": ADMIN }), env, provider);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ subscribed: false, confirmation: "send_failed" });
      expect(logged()).toEqual([{ event, route: "POST /api/repo-requests", error }]);
    }
  });

  test("a GitHub outage is logged apart from a storage outage", async () => {
    const env: BugWorkerEnv = { BUGS: memoryKv(), REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN };
    const unreachable = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    expect((await answer(post("/api/repo-requests", { repo: "owner/repo" }, { "x-bug-admin": ADMIN }), env, unreachable)).status).toBe(503);
    const limited = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    expect((await answer(post("/api/repo-requests", { repo: "owner/repo" }, { "x-bug-admin": ADMIN }), env, limited)).status).toBe(503);
    expect(logged()).toEqual([
      { event: "github_check.failed", route: "POST /api/repo-requests", error: "connect ECONNREFUSED" },
      { event: "github_check.failed", route: "POST /api/repo-requests", error: "GitHub answered 403" },
    ]);
  });
});
