import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { describe, expect, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import { DEFAULT_TRUSTED_WORKFLOW_REF } from "../../src/server/sessions/trustedWorkflow.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

describe("admin endpoints", () => {
  test("repo upsert + list round trip", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const upsert = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", repositoryId: "1", ownerId: "7", mode: "auto", prsPerMonth: 10, spendCapUsd: 25 }),
      }),
      env,
    );
    expect(upsert.status).toBe(200);
    const list = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        headers: { authorization: "Bearer test-admin" },
      }),
      env,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { repos: Array<{ repo: string; mode: string; prsPerMonth: number }> };
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({ repo: "octo/widgets", mode: "auto", quiz: "auto", prsPerMonth: 10 });
  });

  test("repo upsert configures the trusted workflows: omitted keeps, null restores the default, invalid is refused", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const own = "octo/widgets/.github/workflows/smithers-review.yml@refs/heads/main";
    const upsert = async (extra: Record<string, unknown>) => worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", repositoryId: "1", ownerId: "7", mode: "auto", prsPerMonth: 10, spendCapUsd: 25, ...extra }),
      }),
      env,
    );
    const listed = async () => {
      const list = await worker.fetch(new Request("https://review.test/api/admin/repos", { headers: { authorization: "Bearer test-admin" } }), env);
      return ((await list.json()) as { repos: Array<{ allowedWorkflowRefs: string[] }> }).repos[0].allowedWorkflowRefs;
    };
    const created = await upsert({});
    expect(((await created.json()) as { allowedWorkflowRefs: string[] }).allowedWorkflowRefs).toEqual([DEFAULT_TRUSTED_WORKFLOW_REF]);
    expect((await upsert({ allowedWorkflowRefs: [own] })).status).toBe(200);
    expect(await listed()).toEqual([own]);
    expect((await upsert({ prsPerMonth: 11 })).status).toBe(200);
    expect(await listed()).toEqual([own]);
    for (const bad of [[], "x", [own, "octo/widgets/.github/workflows/a.yml@refs/pull/1/merge"], ["octo/widgets/a.yml@refs/heads/main"]]) {
      expect((await upsert({ allowedWorkflowRefs: bad })).status).toBe(400);
    }
    expect(await listed()).toEqual([own]);
    expect((await upsert({ allowedWorkflowRefs: null })).status).toBe(200);
    expect(await listed()).toEqual([DEFAULT_TRUSTED_WORKFLOW_REF]);
  });

  test("repo upsert accepts an explicit quiz mode and rejects invalid values", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const upsert = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", repositoryId: "1", ownerId: "7", mode: "auto", quiz: "on", prsPerMonth: 10, spendCapUsd: 25 }),
      }),
      env,
    );
    expect(upsert.status).toBe(200);
    expect(((await upsert.json()) as { quiz: string }).quiz).toBe("on");
    const bad = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({
          repo: "octo/widgets",
          mode: "auto",
          quiz: "sometimes",
          prsPerMonth: 10,
          spendCapUsd: 25,
        }),
      }),
      env,
    );
    expect(bad.status).toBe(400);
  });

  test("mints an api key and the key authenticates a session", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", repositoryId: "1", ownerId: "7", mode: "comment", prsPerMonth: 5, spendCapUsd: 25 }),
      }),
      env,
    );
    const mint = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: ["octo/widgets"] }),
      }),
      env,
    );
    expect(mint.status).toBe(201);
    const minted = (await mint.json()) as { key: string };
    expect(minted.key.startsWith("srk_")).toBe(true);

    const session = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: minted.key, repo: "octo/widgets", pr: 17 }),
      }),
      env,
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as { token: string; mode: string };
    expect(body.token.startsWith("srs_")).toBe(true);
    expect(body.mode).toBe("comment");
  });

  test("mints an api key with spendCapUsd and rejects non-positive values", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const mint = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: ["octo/widgets"], spendCapUsd: 3.25 }),
      }),
      env,
    );
    expect(mint.status).toBe(201);
    const body = (await mint.json()) as { key: string; spendCapUsd: number };
    expect(body.key.startsWith("srk_")).toBe(true);
    expect(body.spendCapUsd).toBe(3.25);

    const bad = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: ["octo/widgets"], spendCapUsd: 0 }),
      }),
      env,
    );
    expect(bad.status).toBe(400);
  });

  test("rejects an unscoped (empty-repos) api key on session mint", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const upsert = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", repositoryId: "1", ownerId: "7", mode: "comment", prsPerMonth: 5, spendCapUsd: 25 }),
      }),
      env,
    );
    expect(upsert.status).toBe(200);

    const mint = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: [] }),
      }),
      env,
    );
    expect(mint.status).toBe(201);
    const minted = (await mint.json()) as { key: string };
    expect(minted.key.startsWith("srk_")).toBe(true);

    const session = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: minted.key, repo: "octo/widgets", pr: 17 }),
      }),
      env,
    );
    expect(session.status).toBe(403);
    const body = (await session.json()) as { error: string };
    expect((body.error as string).includes("not scoped")).toBe(true);

    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const reviewed = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviewed_prs WHERE repo = ?")
      .bind("octo/widgets")
      .first<{ n: number }>();
    expect(reviewed?.n).toBe(0);
  });

  test("rejects unauthorized callers", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const res = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});


describe("service lifecycle", () => {
  test("admin revocation invalidates a key and its previously minted session", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    await env.DB.prepare("INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES ('octo/widgets', 'auto', 5, 10, 0)").run();
    const mint = await worker.fetch(new Request("https://review.test/api/admin/keys", { method: "POST", headers: { authorization: "Bearer test-admin" }, body: JSON.stringify({ owner: "octo", repos: ["octo/widgets"] }) }), env);
    const { key } = await mint.json() as { key: string };
    const hash = await sha256Hex(key);
    const session = await worker.fetch(new Request("https://review.test/api/sessions", { method: "POST", body: JSON.stringify({ apiKey: key, repo: "octo/widgets", pr: 1 }) }), env);
    const { token } = await session.json() as { token: string };
    const url = `https://review.test/api/admin/keys/${hash}/revoke`;
    expect((await worker.fetch(new Request(url, { method: "POST" }), env)).status).toBe(401);
    for (let i = 0; i < 2; i++) expect((await worker.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer test-admin" } }), env)).status).toBe(204);
    for (const credential of [key, token]) {
      expect((await worker.fetch(new Request("https://review.test/anthropic/v1/messages", { method: "POST", headers: { "x-api-key": credential }, body: "{}" }), env)).status).toBe(401);
    }
  });

  test("admin usage defaults to 30 days and refuses unbounded windows", async () => {
    const env = await buildTestEnv();
    const now = Date.now();
    const worker = createReviewWorker({ now: () => now });
    for (const [id, age] of [["recent", 1], ["old", 100]] as const) {
      await env.DB.prepare("INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, 1, 'm', 1, 1, 1, 'messages', ?)").bind(id, id, now - age * 86400000).run();
    }
    const request = (suffix = "") => new Request("https://review.test/api/admin/usage" + suffix, { headers: { authorization: "Bearer test-admin" } });
    const result = await (await worker.fetch(request(), env)).json() as { days: Array<{ repo: string }> };
    expect(result.days.map((day) => day.repo)).toEqual(["recent"]);
    expect((await worker.fetch(request("?days=999"), env)).status).toBe(400);
  });

  test("retention removes expired artifacts and preserves current quota and unsettled accounting", async () => {
    const env = await buildTestEnv();
    const now = Date.now();
    const worker = createReviewWorker({ now: () => now });
    for (const [id, age] of [["old", 100], ["new", 1]] as const) {
      await env.DB.prepare("INSERT INTO walkthroughs (id, repo, pr, bytes, created_at) VALUES (?, 'octo/widgets', 1, 1, ?)").bind(id, now - age * 86400000).run();
      await env.WALKTHROUGHS.put(`walkthroughs/${id}.html`, id);
      await env.DB.prepare("INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, created_at) VALUES (?, 'octo/widgets', 1, ?, 1, 0)").bind(id, now + (id === "old" ? -2 : 1) * 86400000).run();
    }
    for (const id of ["settled", "held"]) {
      await env.DB.prepare("INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, 'octo/widgets', 1, 'm', 1, 1, 1, 'messages', ?)").bind(id, now - 100 * 86400000).run();
    }
    await env.DB.prepare("INSERT INTO usage_reservations (id, repo, session_hash, cost_usd, created_at) VALUES ('held', 'octo/widgets', NULL, 1, 0)").run();
    for (const month of ["2000-01", new Date(now).toISOString().slice(0, 7)]) {
      await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES ('octo/widgets', 1, ?, 0)").bind(month).run();
    }
    await worker.scheduled({}, env);
    expect((await env.DB.prepare("SELECT id FROM usage_events").all<{ id: string }>()).results).toEqual([{ id: "held" }]);
    expect((await env.DB.prepare("SELECT month FROM reviewed_prs").all<{ month: string }>()).results).toEqual([{ month: new Date(now).toISOString().slice(0, 7) }]);
    expect(await env.WALKTHROUGHS.get("walkthroughs/old.html")).toBeNull();
    expect(await env.WALKTHROUGHS.get("walkthroughs/new.html")).not.toBeNull();
    expect((await env.DB.prepare("SELECT hash FROM sessions").all<{ hash: string }>()).results).toEqual([{ hash: "new" }]);
    expect((await env.DB.prepare("SELECT id FROM walkthroughs").all<{ id: string }>()).results).toEqual([{ id: "new" }]);
  });
});


test("retention keeps a failed R2 deletion retryable", async () => {
  const env = await buildTestEnv();
  await env.DB.prepare("INSERT INTO walkthroughs (id, repo, pr, bytes, created_at) VALUES ('retry', 'r', 1, 1, 0)").run();
  const original = env.WALKTHROUGHS;
  env.WALKTHROUGHS = { ...original, delete: async () => { throw new Error("R2 unavailable"); } };
  const worker = makeWorker();
  await expect(worker.scheduled({}, env)).rejects.toThrow("R2 unavailable");
  expect(await env.DB.prepare("SELECT id FROM walkthroughs").first<{ id: string }>()).toEqual({ id: "retry" });
  env.WALKTHROUGHS = original;
  await worker.scheduled({}, env);
  expect(await env.DB.prepare("SELECT id FROM walkthroughs").first<{ id: string }>()).toBeNull();
});


test("registration binds identity once and normalizes new names", async () => {
  const env = await buildTestEnv();
  const worker = makeWorker();
  const post = (body: object) => worker.fetch(new Request("https://review.test/api/admin/repos", {
    method: "POST", headers: { authorization: "Bearer test-admin" },
    body: JSON.stringify({ repo: "Octo/Widgets", repositoryId: "1", ownerId: "7", mode: "auto", prsPerMonth: 1, spendCapUsd: 10, ...body }),
  }), env);
  expect((await post({ repositoryId: null })).status).toBe(400);
  expect((await post({})).status).toBe(200);
  expect((await post({ repo: "OCTO/WIDGETS", quiz: "on" })).status).toBe(200);
  expect((await post({ repositoryId: "2" })).status).toBe(409);
  expect((await post({ ownerId: "8" })).status).toBe(409);
  expect((await post({ repo: "octo/renamed" })).status).toBe(409);
  const rows = await env.DB.prepare("SELECT repo, repository_id, owner_id, quiz FROM repos").all();
  expect(rows.results).toEqual([{ repo: "octo/widgets", repository_id: "1", owner_id: "7", quiz: "on" }]);
});
