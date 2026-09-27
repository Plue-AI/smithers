import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { jwksCache } from "../../src/server/sessions/jwksCache.ts";
import { DEFAULT_TRUSTED_WORKFLOW_REF } from "../../src/server/sessions/trustedWorkflow.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { rsaKeypair, type RsaTestKeypair } from "./helpers/rsaKeypair.ts";
import { serveJwks, type ServedJwks } from "./helpers/serveJwks.ts";
import { serveMutableJwks } from "./helpers/serveMutableJwks.ts";
import { signTestJwt } from "./helpers/signTestJwt.ts";

const REPO = "octo/widgets";
const SECOND_REPO = "octo/wrenches";

function baseClaims(repo: string, pr: number, exp: number) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "smithers-review",
    exp,
    iat: Math.floor(Date.now() / 1000),
    repository: repo,
    repository_id: repo.toLowerCase() === SECOND_REPO ? "2" : "1",
    repository_owner_id: "7",
    repository_owner: repo.split("/")[0],
    ref: `refs/pull/${pr}/merge`,
    job_workflow_ref: DEFAULT_TRUSTED_WORKFLOW_REF,
  };
}

let keypair: RsaTestKeypair;
let attacker: RsaTestKeypair;
let jwks: ServedJwks;

beforeAll(async () => {
  [keypair, attacker] = await Promise.all([rsaKeypair("test-kid-1"), rsaKeypair("attacker-kid")]);
  jwks = serveJwks([keypair.publicJwk]);
}, 30_000);

afterAll(() => {
  jwks.stop();
});

beforeEach(() => {
  jwksCache.clear();
});

async function registerRepo(env: ReviewWorkerEnv, repo: string, prsPerMonth = 3) {
  await env.DB.prepare(
    "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at, repository_id, owner_id) VALUES (?, ?, ?, ?, ?, '1', '7')",
  )
    .bind(repo, "auto", prsPerMonth, 10, Date.now())
    .run();
  if (repo === SECOND_REPO) await env.DB.prepare("UPDATE repos SET repository_id = '2' WHERE repo = ?").bind(repo).run();
}

function makeWorker(jwksUrl: string) {
  return createReviewWorker({
    jwksUrl,
    fetchUpstream: fetch,
    now: () => Date.now(),
    anthropicBaseUrl: "http://unused",
    waitUntil: () => undefined,
  });
}

describe("POST /api/sessions (OIDC)", () => {
  test("refuses an unbound legacy registration before spending quota", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    await env.DB.prepare("UPDATE repos SET repository_id = NULL, owner_id = NULL").run();
    const token = await signTestJwt(keypair, {
      ...baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600),
      repository_id: "1", repository_owner_id: "7",
    });
    const response = await makeWorker(jwks.url).fetch(new Request("https://review.test/api/sessions", {
      method: "POST", body: JSON.stringify({ oidcToken: token }),
    }), env);
    expect(response.status).toBe(503);
    expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>()).toEqual({ c: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs").first<{ c: number }>()).toEqual({ c: 0 });
  });

  test.each([{ repository_id: "99" }, { repository_owner_id: "99" }, { repository_id: undefined }])(
    "refuses a different or missing immutable identity: %j", async (claims) => {
      const env = await buildTestEnv();
      await registerRepo(env, REPO);
      const token = await signTestJwt(keypair, { ...baseClaims(REPO, 1, Math.floor(Date.now() / 1000) + 600), ...claims });
      const response = await makeWorker(jwks.url).fetch(new Request("https://review.test/api/sessions", {
        method: "POST", body: JSON.stringify({ oidcToken: token }),
      }), env);
      expect(response.status).toBe(claims.repository_id === undefined && "repository_id" in claims ? 401 : 403);
      expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>()).toEqual({ c: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs").first<{ c: number }>()).toEqual({ c: 0 });
    },
  );

  test.each([
    ["the pull request's own workflow file", "octo/widgets/.github/workflows/pr-review.yml@refs/pull/1/merge"],
    ["the trusted workflow on a pull request branch", "smithersai/smithers/.github/workflows/review.yml@refs/heads/pr-branch"],
    ["a different workflow file at main", "smithersai/smithers/.github/workflows/ci.yml@refs/heads/main"],
    ["no job_workflow_ref claim", undefined],
  ])("refuses a token from %s before spending quota", async (_, jobWorkflowRef) => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const token = await signTestJwt(keypair, {
      ...baseClaims(REPO, 1, Math.floor(Date.now() / 1000) + 600),
      job_workflow_ref: jobWorkflowRef,
    });
    const response = await makeWorker(jwks.url).fetch(new Request("https://review.test/api/sessions", {
      method: "POST", body: JSON.stringify({ oidcToken: token }),
    }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "oidc: untrusted workflow",
      jobWorkflowRef: jobWorkflowRef ?? null,
      allowedWorkflowRefs: [DEFAULT_TRUSTED_WORKFLOW_REF],
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>()).toEqual({ c: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs").first<{ c: number }>()).toEqual({ c: 0 });
  });

  test("a registration's allowed workflows replace the default", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const own = "octo/widgets/.github/workflows/smithers-review.yml@refs/heads/main";
    await env.DB.prepare("UPDATE repos SET allowed_workflow_refs = ?").bind(JSON.stringify([own])).run();
    const worker = makeWorker(jwks.url);
    const mint = async (pr: number, jobWorkflowRef: string) =>
      (await worker.fetch(new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          oidcToken: await signTestJwt(keypair, {
            ...baseClaims(REPO, pr, Math.floor(Date.now() / 1000) + 600),
            job_workflow_ref: jobWorkflowRef,
          }),
        }),
      }), env)).status;
    expect(await mint(1, own)).toBe(200);
    expect(await mint(2, DEFAULT_TRUSTED_WORKFLOW_REF)).toBe(403);
  });

  test("case variants share the stored registration and its quota", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, "Octo/Widgets", 1);
    const worker = makeWorker(jwks.url);
    for (const [repo, pr, status] of [[REPO, 1, 200], ["OCTO/WIDGETS", 2, 402]] as const) {
      const token = await signTestJwt(keypair, baseClaims(repo, pr, Math.floor(Date.now() / 1000) + 600));
      const response = await worker.fetch(new Request("https://review.test/api/sessions", {
        method: "POST", body: JSON.stringify({ oidcToken: token }),
      }), env);
      expect(response.status).toBe(status);
    }
    expect((await env.DB.prepare("SELECT repo FROM reviewed_prs").all()).results).toEqual([{ repo: "Octo/Widgets" }]);
  });

  test("verifies a valid token and mints a session", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at, repository_id, owner_id) VALUES (?, ?, ?, ?, ?, '1', '7')",
    )
      .bind(REPO, "comment", 5, 25, Date.now())
      .run();
    const token = await signTestJwt(keypair, {
      ...baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600),
      event_name: "issue_comment",
      ref: "refs/heads/main",
    });
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token, pr: 42 }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.token).toBe("string");
    expect((body.token as string).startsWith("srs_")).toBe(true);
    expect(body.mode).toBe("comment");
    expect(body.plan).toEqual({ prsPerMonth: 5, used: 1 });
    expect(body.quiz).toBe("auto");
    const quota = body.quota as { limit: number; remaining: number; resetsAt: string };
    expect(quota.limit).toBe(5);
    expect(quota.remaining).toBe(4);
    expect(new Date(quota.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.anthropicBaseUrl).toBe("https://review.test/anthropic");
    expect(body.publishUrl).toBe("https://review.test");
  });

  test("refuses a pull_request token for a comment-mode repo without claiming quota or minting", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at, repository_id, owner_id) VALUES (?, ?, ?, ?, ?, '1', '7')",
    )
      .bind(REPO, "comment", 1, 25, Date.now())
      .run();
    const exp = Math.floor(Date.now() / 1000) + 600;
    const pullRequestToken = await signTestJwt(keypair, { ...baseClaims(REPO, 42, exp), event_name: "pull_request" });
    const refused = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: pullRequestToken }),
      }),
      env,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "comment-mode", repo: REPO });
    const reviewed = await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs").first<{ c: number }>();
    expect(reviewed?.c).toBe(0);
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>();
    expect(sessions?.c).toBe(0);

    // The one-PR plan is still unspent, so the magic-phrase comment reviews.
    const commentToken = await signTestJwt(keypair, {
      ...baseClaims(REPO, 42, exp),
      event_name: "issue_comment",
      ref: "refs/heads/main",
    });
    const accepted = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: commentToken, pr: 42 }),
      }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { plan: unknown }).plan).toEqual({ prsPerMonth: 1, used: 1 });
  });

  test("mints a session after the issuer rotates its JWKS within the cache TTL", async () => {
    const keyA = await rsaKeypair("worker-rotation-a");
    const keyB = await rsaKeypair("worker-rotation-b");
    const rotatingJwks = serveMutableJwks([keyA.publicJwk]);
    try {
      const env = await buildTestEnv();
      await registerRepo(env, REPO, 3);
      const worker = makeWorker(rotatingJwks.url);
      const exp = Math.floor(Date.now() / 1000) + 600;

      const tokenA = await signTestJwt(keyA, baseClaims(REPO, 51, exp));
      const first = await worker.fetch(
        new Request("https://review.test/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ oidcToken: tokenA }),
        }),
        env,
      );
      expect(first.status).toBe(200);
      expect(rotatingJwks.requestCount).toBe(1);

      rotatingJwks.setKeys([keyA.publicJwk, keyB.publicJwk]);
      const tokenB = await signTestJwt(keyB, baseClaims(REPO, 52, exp));
      const second = await worker.fetch(
        new Request("https://review.test/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ oidcToken: tokenB }),
        }),
        env,
      );
      expect(second.status).toBe(200);
      expect(typeof ((await second.json()) as { token?: unknown }).token).toBe("string");
      expect(rotatingJwks.requestCount).toBe(2);

      const sessions = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>();
      expect(sessions?.c).toBe(2);
    } finally {
      rotatingJwks.stop();
    }
  });

  test("returns the repo's registered quiz mode", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, quiz, prs_per_month, spend_cap_usd, created_at, repository_id, owner_id) VALUES (?, ?, ?, ?, ?, ?, '1', '7')",
    )
      .bind(REPO, "auto", "on", 5, 25, Date.now())
      .run();
    const token = await signTestJwt(keypair, baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.quiz).toBe("on");
  });

  test("accepts body pr only for issue_comment oidc tokens without a pull request ref", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO);
    const claims = {
      ...baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600),
      event_name: "issue_comment",
      ref: "refs/heads/main",
    };
    const token = await signTestJwt(keypair, claims);
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token, pr: 77 }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const reviewed = await env.DB.prepare("SELECT pr FROM reviewed_prs WHERE repo = ?")
      .bind(REPO)
      .first<{ pr: number }>();
    expect(reviewed?.pr).toBe(77);
  });

  test("rejects body pr for oidc tokens that are not tied to a pull request event", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO);
    const claims = {
      ...baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600),
      event_name: "push",
      ref: "refs/heads/main",
    };
    const token = await signTestJwt(keypair, claims);
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token, pr: 42 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("missing pull request number");
  });

  test("rejects body pr that disagrees with the oidc pull request ref", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO);
    const token = await signTestJwt(keypair, baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token, pr: 41 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("does not match");
  });

  test("rejects oidc tokens with conflicting pull request claims", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO);
    const claims = {
      ...baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600),
      pull_request: { number: 41 },
    };
    const token = await signTestJwt(keypair, claims);
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("claims do not match");
  });

  test("rejects a token with an unknown kid", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const wrong = attacker;
    const worker = makeWorker(jwks.url);
    const token = await signTestJwt(wrong, baseClaims(REPO, 7, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test.each(["forged", "tampered", "malformed"] as const)(
    "rejects a %s signature without minting a session or consuming quota",
    async (kind) => {
      const env = await buildTestEnv();
      await registerRepo(env, REPO);
      const claims = baseClaims(REPO, 7, Math.floor(Date.now() / 1000) + 600);
      const original = await signTestJwt(keypair, { ...claims, repository: SECOND_REPO });
      const [header, payload, signature] = original.split(".");
      const tampered = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const token =
        kind === "forged"
          ? await signTestJwt(attacker, claims, { kid: keypair.kid })
          : kind === "tampered"
            ? `${header}.${tampered}.${signature}`
            : `${header}.${payload}.!`;
      const res = await makeWorker(jwks.url).fetch(
        new Request("https://review.test/api/sessions", {
          method: "POST",
          body: JSON.stringify({ oidcToken: token }),
        }),
        env,
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: `oidc: ${kind === "malformed" ? "malformed" : "bad-signature"}` });
      expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>()).toEqual({ c: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs").first<{ c: number }>()).toEqual({ c: 0 });
    },
    15_000,
  );

  test("returns 503 for a stalled JWKS body and retries after cooldown", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    let now = Date.now();
    let attempts = 0;
    let signal: AbortSignal | null | undefined;
    const fetchUpstream = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      attempts += 1;
      signal = init?.signal;
      if (attempts === 1) return new Response(new ReadableStream());
      return Response.json({ keys: [keypair.publicJwk] });
    }) as typeof fetch;
    const worker = createReviewWorker({ jwksUrl: "https://stalled.test/jwks", fetchUpstream, now: () => now });
    const token = await signTestJwt(keypair, baseClaims(REPO, 7, Math.floor(now / 1000) + 600));
    const mint = () => worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    const started = performance.now();
    const res = await mint();
    expect(performance.now() - started).toBeLessThan(7_000);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "oidc: jwks-unavailable" });
    expect(signal?.aborted).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>()).toEqual({ c: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs").first<{ c: number }>()).toEqual({ c: 0 });
    expect((await mint()).status).toBe(503);
    expect(attempts).toBe(1);
    now += 5_000;
    expect((await mint()).status).toBe(200);
    expect(attempts).toBe(2);
  }, 30_000);

  test("rejects a token with the wrong audience", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const worker = makeWorker(jwks.url);
    const claims = baseClaims(REPO, 7, Math.floor(Date.now() / 1000) + 600);
    claims.aud = "elsewhere";
    const token = await signTestJwt(keypair, claims);
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("wrong-audience");
  });

  test("rejects an expired token", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const worker = makeWorker(jwks.url);
    const token = await signTestJwt(keypair, baseClaims(REPO, 7, Math.floor(Date.now() / 1000) - 60));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("expired");
  });

  test("returns a 503 JSON error when the issuer's JWKS is down", async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const flaky = serveMutableJwks([keypair.publicJwk]);
    flaky.setResponse({ error: "unavailable" }, 503);
    const worker = makeWorker(flaky.url);
    const token = await signTestJwt(keypair, baseClaims(REPO, 7, Math.floor(Date.now() / 1000) + 600));
    try {
      const res = await worker.fetch(
        new Request("https://review.test/api/sessions", {
          method: "POST",
          body: JSON.stringify({ oidcToken: token }),
        }),
        env,
      );
      // A transient upstream blip must stay inside the documented JSON error
      // contract, not escape as an unhandled throw the runtime turns into a
      // bare 500 the action cannot tell apart from a hard auth failure.
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain("jwks-unavailable");
    } finally {
      flaky.stop();
    }
  });

  test("returns 403 with a registration hint for unknown repos", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    const token = await signTestJwt(keypair, baseClaims("not/registered", 9, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.hint).toContain("/api/admin/repos");
  });

  test("returns 402 when the monthly quota is spent", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO, 2);
    const sign = async (pr: number) => signTestJwt(keypair, baseClaims(REPO, pr, Math.floor(Date.now() / 1000) + 600));
    expect(
      (
        await worker.fetch(
          new Request("https://review.test/api/sessions", {
            method: "POST",
            body: JSON.stringify({ oidcToken: await sign(1) }),
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          new Request("https://review.test/api/sessions", {
            method: "POST",
            body: JSON.stringify({ oidcToken: await sign(2) }),
          }),
          env,
        )
      ).status,
    ).toBe(200);
    const blocked = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: await sign(3) }),
      }),
      env,
    );
    expect(blocked.status).toBe(402);
  });

  test("re-reviewing a PR already counted this month does not consume quota", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, SECOND_REPO, 1);
    const sign = async (pr: number) =>
      signTestJwt(keypair, baseClaims(SECOND_REPO, pr, Math.floor(Date.now() / 1000) + 600));
    expect(
      (
        await worker.fetch(
          new Request("https://review.test/api/sessions", {
            method: "POST",
            body: JSON.stringify({ oidcToken: await sign(11) }),
          }),
          env,
        )
      ).status,
    ).toBe(200);
    // Same PR — quota stays at 1/1.
    const again = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: await sign(11) }),
      }),
      env,
    );
    expect(again.status).toBe(200);
    const body = (await again.json()) as { plan: { used: number } };
    expect(body.plan.used).toBe(1);
  });

  test("ignores body.pr when the claims are not from a PR context", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO, 1);
    // First: legitimate PR review consumes the whole quota.
    const prToken = await signTestJwt(keypair, {
      ...baseClaims(REPO, 42, Math.floor(Date.now() / 1000) + 600),
      event_name: "pull_request",
    });
    const first = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: prToken }),
      }),
      env,
    );
    expect(first.status).toBe(200);
    // Then: a push-triggered token claims the already-reviewed PR via the
    // body. Trusting body.pr lets alreadyReviewed grant a free session
    // forever; instead the PR number is rejected outright.
    const pushToken = await signTestJwt(keypair, {
      ...baseClaims(REPO, 0, Math.floor(Date.now() / 1000) + 600),
      ref: "refs/heads/main",
      event_name: "push",
    });
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: pushToken, pr: 42 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("pull request");
  });

  test("accepts body.pr when the claims prove an issue_comment context", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO, 3);
    // issue_comment workflows run on the default branch ref: no PR in the
    // ref or pull_request claim, so the body is the only source.
    const token = await signTestJwt(keypair, {
      ...baseClaims(REPO, 0, Math.floor(Date.now() / 1000) + 600),
      ref: "refs/heads/main",
      event_name: "issue_comment",
    });
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token, pr: 7 }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT pr FROM sessions").first<{ pr: number }>();
    expect(row?.pr).toBe(7);
  });

  test("atomically enforces the monthly PR quota under concurrent mints", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    await registerRepo(env, REPO, 3);
    const exp = Math.floor(Date.now() / 1000) + 600;
    // Six distinct new PRs racing at once against a 3-PR plan. A check-then-insert
    // split lets more than three pass the read; the atomic claim must grant three.
    const tokens = await Promise.all([1, 2, 3, 4, 5, 6].map((pr) => signTestJwt(keypair, baseClaims(REPO, pr, exp))));
    const responses = await Promise.all(
      tokens.map((token) =>
        worker.fetch(
          new Request("https://review.test/api/sessions", {
            method: "POST",
            body: JSON.stringify({ oidcToken: token }),
          }),
          env,
        ),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBe(3);
    expect(statuses.filter((s) => s === 402).length).toBe(3);
    const reviewed = await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs WHERE repo = ?")
      .bind(REPO)
      .first<{ c: number }>();
    expect(reviewed?.c).toBe(3);
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>();
    expect(sessions?.c).toBe(3);
  });

  test("402s minting once the repo's monthly spend cap is reached (re-mint cannot reset it)", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker(jwks.url);
    // Ceiling = prs_per_month * spend_cap_usd = 1 * 0.01 = 0.01.
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at, repository_id, owner_id) VALUES (?, ?, ?, ?, ?, '1', '7')",
    )
      .bind(REPO, "auto", 1, 0.01, Date.now())
      .run();
    // Prior sessions this month already spent past the ceiling.
    await env.DB.prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("u1", REPO, 1, "claude-sonnet-4-6", 0, 0, 0.05, "messages", Date.now())
      .run();
    // A fresh mint for a brand-new PR — the re-mint that would otherwise reset
    // the per-session budget — must be refused.
    const token = await signTestJwt(keypair, baseClaims(REPO, 2, Math.floor(Date.now() / 1000) + 600));
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("monthly spend cap");
    // Rejected before claiming a quota slot or minting a session.
    const reviewed = await env.DB.prepare("SELECT COUNT(*) AS c FROM reviewed_prs WHERE repo = ?")
      .bind(REPO)
      .first<{ c: number }>();
    expect(reviewed?.c).toBe(0);
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions").first<{ c: number }>();
    expect(sessions?.c).toBe(0);
  });
});
