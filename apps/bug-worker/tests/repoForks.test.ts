import { describe, expect, spyOn, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import { forkRepo, type RepoFork } from "../src/repoForks.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRepoCompletions } from "./helpers/memoryRepoCompletions.ts";
import type { BugWorkerEnv } from "../src/env.ts";

function fixture(token: string | null = "fork-token") {
  const env: BugWorkerEnv = { BUGS: memoryKv(), REPO_COMPLETIONS: memoryRepoCompletions(), BUG_ADMIN_TOKEN: "test-admin", ...(token ? { GITHUB_FORK_TOKEN: token } : {}) };
  const calls: { url: string; init?: RequestInit }[] = [];
  let forkStatus = 202;
  let forkThrows = false;
  const worker = createBugWorker({ now: () => 1788500000000, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/forks")) {
      if (forkThrows) throw new Error("network down");
      return Response.json({ full_name: "smithers-community/repo" }, { status: forkStatus });
    }
    return Response.json({ private: false, license: { spdx_id: "MIT" } });
  }) as typeof fetch });
  const nominate = (repo = "owner/repo") => worker.fetch(new Request("https://bug.smithers.sh/api/repo-requests", {
    method: "POST", headers: { "content-type": "application/json", "x-bug-admin": "test-admin" }, body: JSON.stringify({ repo }),
  }), env);
  const forks = () => calls.filter((call) => call.url.endsWith("/forks"));
  const lookups = () => calls.filter((call) => !call.url.endsWith("/forks"));
  const record = async (repo = "owner/repo") => JSON.parse((await env.BUGS.get(`repo-fork:${repo}`))!);
  return { env, nominate, forks, lookups, record, forkStatus: (value: number) => { forkStatus = value; }, forkThrows: () => { forkThrows = true; } };
}

describe("community forks", () => {
  for (const outcome of ["forked", "failed", "skipped"] as const) {
    for (const cause of [new Error("record offline"), "record offline"]) {
      test(`preserves ${outcome} when recording throws ${cause instanceof Error ? "an Error" : "a string"}`, async () => {
        const f = fixture(outcome === "skipped" ? null : "fork-token");
        const writes: Array<{ key: string; value: string }> = [];
        let requests = 0;
        const env: BugWorkerEnv = { ...f.env, BUGS: { ...f.env.BUGS, put: async (key, value) => {
          writes.push({ key, value });
          throw cause;
        } } };
        const logs = spyOn(console, "error").mockImplementation(() => {});
        const expected: RepoFork = outcome === "forked"
          ? { status: "forked", forkedAt: "2026-09-04T05:33:20.000Z" }
          : outcome === "failed" ? { status: "failed", error: "GitHub responded 403" } : { status: "skipped" };
        try {
          const result = await forkRepo(env, { now: () => 1788500000000, fetch: (async () => {
            requests++;
            return new Response(null, { status: outcome === "forked" ? 202 : 403 });
          }) as unknown as typeof fetch }, "owner/repo");
          expect(result).toEqual(expected);
          expect(requests).toBe(outcome === "skipped" ? 0 : 1);
          expect(writes).toEqual([{ key: "repo-fork:owner/repo", value: JSON.stringify(expected) }]);
          expect(logs.mock.calls).toEqual([
            ...(outcome === "failed" ? ["repo-fork owner/repo failed: GitHub responded 403"] : []),
            "repo-fork owner/repo could not be recorded: record offline",
          ].map(message => [message]));
          expect(await f.env.BUGS.get("repo-fork:owner/repo")).toBeNull();
        } finally { logs.mockRestore(); }
      });
    }
  }

  test("forks once per repository into smithers-community with the token", async () => {
    const f = fixture();
    expect((await f.nominate("https://github.com/Owner/Repo")).status).toBe(200);
    expect((await f.nominate("owner/repo.git")).status).toBe(200);
    const forks = f.forks();
    expect(forks).toHaveLength(1);
    expect(forks[0]!.url).toBe("https://api.github.com/repos/owner/repo/forks");
    expect(forks[0]!.init!.method).toBe("POST");
    expect(JSON.parse(String(forks[0]!.init!.body))).toEqual({ organization: "smithers-community" });
    expect((forks[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer fork-token");
    expect(await f.record()).toEqual({ status: "forked", forkedAt: "2026-09-04T05:33:20.000Z" });
    await f.nominate("other/repo");
    expect(f.forks()).toHaveLength(2);
  });
  test("a failed fork is recorded and the nomination still succeeds", async () => {
    const f = fixture();
    f.forkStatus(403);
    expect((await f.nominate()).status).toBe(200);
    expect(await f.record()).toEqual({ status: "failed", error: "GitHub responded 403" });
    expect(await f.env.BUGS.get("repo-request:owner/repo")).not.toBeNull();
    f.forkThrows();
    expect((await f.nominate("owner/other")).status).toBe(200);
    expect(await f.record("owner/other")).toEqual({ status: "failed", error: "network down" });
  });
  test("a missing token records skipped and never calls GitHub's fork endpoint", async () => {
    const f = fixture(null);
    expect((await f.nominate()).status).toBe(200);
    expect(f.forks()).toHaveLength(0);
    expect(await f.record()).toEqual({ status: "skipped" });
    expect((f.lookups()[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });
  test("the repository lookup is authenticated with the token, not the shared egress IP's anonymous quota", async () => {
    const f = fixture();
    expect((await f.nominate()).status).toBe(200);
    const lookups = f.lookups();
    expect(lookups.map((call) => call.url)).toEqual(["https://api.github.com/repos/owner/repo"]);
    expect((lookups[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer fork-token");
  });
});
