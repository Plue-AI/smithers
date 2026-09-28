import { describe, expect, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits, memoryRepoCompletions } from "./helpers/memoryDurableObjects.ts";
import type { BugWorkerEnv } from "../src/env.ts";

function fixture(token = "test-admin") {
  const kv = memoryKv();
  const env: BugWorkerEnv = { BUGS: kv, REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: token };
  const worker = createBugWorker({ now: () => 1788500000000, fetch: (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ private: false, license: { spdx_id: "MIT" } })) as typeof fetch });
  const nominate = (repo = "owner/repo") => worker.fetch(new Request("https://bug.smithers.sh/api/repo-requests", {
    method: "POST", headers: { "content-type": "application/json", "x-bug-admin": token }, body: JSON.stringify({ repo }),
  }), env);
  const claim = (body: unknown, headers: Record<string, string> = { "x-bug-admin": "test-admin" }) => worker.fetch(new Request("https://bug.smithers.sh/api/repo-claims", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), env);
  const read = (query: string) => worker.fetch(new Request(`https://bug.smithers.sh/api/repo-claims${query}`), env);
  return { env, kv, nominate, claim, read };
}

describe("maintainer claims", () => {
  test("refuses anonymous and wrong-token claims with 401 and writes nothing", async () => {
    const f = fixture();
    await f.nominate();
    const before = new Map(f.kv.dump());
    const anonymous = await f.claim({ repo: "owner/repo", login: "maintainer" }, {});
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Claims open with GitHub sign-in in the app." });
    expect((await f.claim({ repo: "owner/repo", login: "maintainer" }, { "x-bug-admin": "nope" })).status).toBe(401);
    expect(f.kv.dump()).toEqual(before);
    expect(await f.env.BUGS.get("repo-claim:owner/repo")).toBeNull();
    expect((await f.read("?repo=owner/repo")).status).toBe(404);
  });
  test("refuses every claim when no operator token is deployed", async () => {
    const f = fixture("");
    await f.nominate();
    expect((await f.claim({ repo: "owner/repo", login: "maintainer" })).status).toBe(401);
    expect(await f.env.BUGS.get("repo-claim:owner/repo")).toBeNull();
  });
  test("records the first claim, returns it without the email, and rejects a second claim", async () => {
    const f = fixture();
    await f.nominate();
    const response = await f.claim({ repo: "https://github.com/Owner/Repo", login: "@Maintainer", email: "Me@Example.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repo: "owner/repo", login: "Maintainer", claimedAt: "2026-09-04T05:33:20.000Z" });
    expect(JSON.parse((await f.env.BUGS.get("repo-claim:owner/repo"))!)).toEqual({ login: "Maintainer", email: "me@example.com", claimedAt: "2026-09-04T05:33:20.000Z" });
    const second = await f.claim({ repo: "owner/repo", login: "someone-else" });
    expect(second.status).toBe(409);
    const stored = await f.read("?repo=owner/repo");
    expect(stored.status).toBe(200);
    expect(await stored.text()).not.toContain("example.com");
    expect(await (await f.read("?repo=OWNER/REPO.git")).json()).toMatchObject({ login: "Maintainer" });
  });
  test("returns 404 for repositories that were never nominated or claimed", async () => {
    const f = fixture();
    expect((await f.claim({ repo: "owner/repo", login: "maintainer" })).status).toBe(404);
    expect(await f.env.BUGS.get("repo-claim:owner/repo")).toBeNull();
    await f.nominate();
    expect((await f.read("?repo=owner/repo")).status).toBe(404);
  });
  test("validates the repository, login, email, and body shape", async () => {
    const f = fixture();
    await f.nominate();
    for (const body of [
      { repo: "https://evil.com/owner/repo", login: "maintainer" },
      { repo: "owner/repo" },
      { repo: "owner/repo", login: "-bad-" },
      { repo: "owner/repo", login: "a".repeat(40) },
      { repo: "owner/repo", login: "maintainer", email: "oops" },
      { repo: "owner/repo", login: "maintainer", email: 5 },
      ["owner/repo"],
    ]) expect((await f.claim(body)).status).toBe(400);
    expect((await f.read("")).status).toBe(400);
    expect((await f.read("?repo=owner/repo/tree/main")).status).toBe(400);
    expect(await f.env.BUGS.get("repo-claim:owner/repo")).toBeNull();
    expect((await f.claim({ repo: "owner/repo", login: "maintainer" })).status).toBe(200);
  });
  test("throttles claims and reports storage failures", async () => {
    const f = fixture();
    await f.nominate();
    for (let i = 0; i < 20; i++) await f.claim({ repo: "owner/repo", login: "maintainer" });
    expect((await f.claim({ repo: "owner/repo", login: "maintainer" })).status).toBe(429);
    f.env.BUGS.get = async () => { throw new Error("offline"); };
    expect((await f.read("?repo=owner/repo")).status).toBe(503);
  });
});
