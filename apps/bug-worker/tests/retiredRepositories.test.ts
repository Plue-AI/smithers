import { describe, expect, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import type { BugWorkerEnv } from "../src/env.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits } from "./helpers/memoryDurableObjects.ts";

// Exercise the real router with populated legacy storage. Retired URLs cannot
// read or mutate that data, send mail, fork repositories, or spend intake quota.
describe("retired community repository lifecycle", () => {
  const paths = [
    "/api/repo-requests", "/api/repo-requests/owner/repo",
    "/api/repo-requests/confirm?token=" + "0".repeat(32),
    "/api/repo-requests/cancel?token=" + "0".repeat(32),
    "/api/repo-requests/complete", "/api/repo-requests/notify",
    "/api/repo-claims?repo=owner/repo",
  ];
  for (const path of paths) {
    for (const method of ["GET", "POST", "DELETE"]) {
      test(`${method} ${path} stays retired with historical records and operator credentials`, async () => {
        const kv = memoryKv();
        await kv.put("repo-request:owner/repo", JSON.stringify({ name: "owner/repo" }));
        await kv.put("repo-ready:owner/repo", JSON.stringify({ appUrl: "https://app.smithers.sh/r" }));
        await kv.put("repo-subscriber:owner/repo:old", JSON.stringify({ email: "old@example.test" }));
        const before = new Map(kv.dump());
        const unexpected = () => { throw new Error("retired route touched storage"); };
        const env: BugWorkerEnv = {
          BUGS: { ...kv, get: unexpected, put: unexpected, delete: unexpected, list: unexpected },
          RATE_LIMITS: { getByName: unexpected }, BUG_ADMIN_TOKEN: "admin",
        };
        const worker = createBugWorker({ now: unexpected });
        const response = await worker.fetch(new Request(`https://bug.smithers.sh${path}`, {
          method, headers: { "x-bug-admin": "admin", "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ repo: "owner/repo", email: "new@example.test" }) } : {}),
        }), env);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not found" });
        expect(kv.dump()).toEqual(before);
        expect("scheduled" in worker).toBe(false);
      });
    }
  }

  test("retired requests leave bug intake and authenticated delivery usable", async () => {
    const kv = memoryKv();
    const env: BugWorkerEnv = { BUGS: kv, RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: "admin" };
    const worker = createBugWorker({ now: () => 1788500000000 });
    for (const path of paths) {
      expect((await worker.fetch(new Request(`https://bug.smithers.sh${path}`), env)).status).toBe(404);
    }
    const payload = { summary: "maintainer bug", platform: "darwin-arm64" };
    const accepted = await worker.fetch(new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST", body: JSON.stringify(payload),
    }), env);
    expect(accepted.status).toBe(201);
    const { url } = await accepted.json() as { url: string };
    expect((await worker.fetch(new Request(url), env)).status).toBe(401);
    const delivered = await worker.fetch(new Request(url, { headers: { "x-bug-admin": "admin" } }), env);
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ report: payload });
    expect([...kv.dump().keys()].every((key) => key.startsWith("bug:"))).toBe(true);
  });
});
