import { expect, test } from "bun:test";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { handleAnthropic, type HandleAnthropicDeps } from "../../src/server/proxy/handleAnthropic.ts";
import { PROXY_IN_FLIGHT_LIMIT } from "../../src/server/proxy/proxyInFlightLimit.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
const REPO = "octo/widgets";
function createReviewWorker(deps: HandleAnthropicDeps & { jwksUrl: string }) {
  return {
    fetch: (request: Request, env: ReviewWorkerEnv) => handleAnthropic(request, env, deps, new URL(request.url)),
  };
}
async function seedSession(env: ReviewWorkerEnv, repo: string, spendCapUsd = 1) {
  await env.DB.prepare("INSERT OR IGNORE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, 'auto', 100, 100, 0)").bind(repo).run();
  const token = "srs_testsessiontoken";
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(hash, repo, 99, Date.now() + 60_000, spendCapUsd, 0, Date.now())
    .run();
  return token;
}

async function registerRepo(env: ReviewWorkerEnv, repo: string, prsPerMonth = 5, spendCapUsd = 1) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(repo, "auto", prsPerMonth, spendCapUsd, Date.now())
    .run();
}

for (const [credential, repoCap, sessionCap, keyCap] of [
  ["session", 10, 1, null],
  ["session", 1, 10, null],
  ["api-key", 1, 10, null],
  ["api-key", 10, 10, 1],
] as const) {
  test(`atomically admits six concurrent ${credential} requests against reserved budget (repo=${repoCap}, session=${sessionCap}, key=${keyCap})`, async () => {
    const env = await buildTestEnv();
    await registerRepo(env, REPO, 1, repoCap);
    let token = await seedSession(env, REPO, sessionCap);
    if (credential === "api-key") {
      token = "srk_concurrent";
      await env.DB.prepare(
        "INSERT INTO api_keys (hash, owner, repos_json, created_at, spend_cap_usd) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(await sha256Hex(token), "octo", JSON.stringify([REPO]), Date.now(), keyCap)
        .run();
    }
    let forwarded = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
      fetchUpstream: (async () => {
        forwarded++;
        return new Response(
          new ReadableStream({
            async start(controller) {
              await held;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 40_000 } }),
                ),
              );
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        worker.fetch(
          new Request("https://review.test/anthropic/v1/messages", {
            method: "POST",
            headers: { "x-api-key": token },
            body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 40_000, messages: [] }),
          }),
          env,
        ),
      ),
    );
    const reserved = await env.DB.prepare("SELECT SUM(cost_usd) AS spend FROM usage_reservations").first<{
      spend: number;
    }>();
    release();
    const bodies = await Promise.all(responses.map((r) => r.text()));
    await Promise.all(meterings);
    expect(forwarded).toBe(1);
    expect(reserved!.spend).toBeGreaterThan(0);
    expect(reserved!.spend).toBeLessThanOrEqual(1);
    // An exhausted budget is restored by a person, not a timer: 402, no Retry-After.
    const refused = responses.flatMap((r, i) => (r.status === 200 ? [] : [{ r, body: JSON.parse(bodies[i]!) }]));
    expect(refused.map(({ r }) => r.status)).toEqual([402, 402, 402, 402, 402]);
    for (const { r, body } of refused) {
      expect(r.headers.get("retry-after")).toBeNull();
      expect(body.error).toBe("spend cap prevents reservation");
    }
    const spend = await env.DB.prepare("SELECT SUM(cost_usd) AS spend FROM usage_events").first<{ spend: number }>();
    expect(spend!.spend).toBeLessThanOrEqual(1);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session!.spent_usd).toBeLessThanOrEqual(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
  });
}

test("rejects an unknown paid model before forwarding", async () => {
  const env = await buildTestEnv();
  const token = await seedSession(env, REPO);
  let forwarded = 0;
  const worker = createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "https://anthropic.test",
    now: () => Date.now(),
    waitUntil: () => undefined,
    fetchUpstream: (async () => {
      forwarded++;
      return Response.json({ model: "claude-opus-4-6", usage: { input_tokens: 1_000_000, output_tokens: 1 } });
    }) as unknown as typeof fetch,
  });
  const res = await worker.fetch(
    new Request("https://review.test/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token },
      body: JSON.stringify({ model: "claude-opus-999", max_tokens: 1, messages: [] }),
    }),
    env,
  );
  expect(res.status).toBe(400);
  expect(forwarded).toBe(0);
});

test("rejects unbounded request shapes without forwarding", async () => {
  const env = await buildTestEnv();
  const token = await seedSession(env, REPO);
  let forwarded = 0;
  const worker = createReviewWorker({
    jwksUrl: "unused",
    anthropicBaseUrl: "https://anthropic.test",
    now: Date.now,
    waitUntil: () => undefined,
    fetchUpstream: (async () => {
      forwarded++;
      return Response.json({});
    }) as unknown as typeof fetch,
  });
  const valid = { model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] };
  const bodies = [
    "{broken",
    JSON.stringify({ ...valid, max_tokens: undefined }),
    JSON.stringify({ ...valid, max_tokens: -1 }),
    JSON.stringify({ ...valid, max_tokens: 1.5 }),
    JSON.stringify({ ...valid, max_tokens: 64_001 }),
    JSON.stringify({ ...valid, messages: [{ role: "user", content: "x".repeat(48_000) }] }),
    JSON.stringify({
      ...valid,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/x" } }] }],
    }),
    JSON.stringify({ ...valid, tools: [{ type: "web_search_20250305", name: "web_search" }] }),
    JSON.stringify({
      ...valid,
      system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }],
    }),
    JSON.stringify({ ...valid, speed: "fast" }),
  ];
  for (const body of bodies) {
    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body,
      }),
      env,
    );
    expect(response.status).toBe(400);
  }
  const beta = await worker.fetch(
    new Request("https://review.test/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token, "anthropic-beta": "unknown-pricing" },
      body: JSON.stringify(valid),
    }),
    env,
  );
  expect(beta.status).toBe(400);
  expect(forwarded).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
});

test("in-flight cap holds ambiguous failures and releases definite rejections", async () => {
  const env = await buildTestEnv();
  const token = await seedSession(env, REPO, 100);
  let calls = 0;
  const pending: Promise<unknown>[] = [];
  const worker = createReviewWorker({
    jwksUrl: "unused",
    anthropicBaseUrl: "https://anthropic.test",
    now: Date.now,
    waitUntil: (p) => pending.push(p),
    fetchUpstream: (async () => {
      calls++;
      return Response.json({}, { status: calls === 1 ? 429 : 200 });
    }) as unknown as typeof fetch,
  });
  const request = () =>
    worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      }),
      env,
    );
  const rejected = await request();
  expect(rejected.status).toBe(429);
  await rejected.text();
  await Promise.all(pending);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
  const responses = await Promise.all(Array.from({ length: PROXY_IN_FLIGHT_LIMIT + 2 }, request));
  const bodies = await Promise.all(responses.map((r) => r.text()));
  await Promise.all(pending);
  expect(responses.filter((r) => r.status === 200)).toHaveLength(PROXY_IN_FLIGHT_LIMIT);
  // A full in-flight window reopens when a hold settles, so it is a rate
  // limit the client parks on, never the terminal 402 of an empty budget.
  const refused = responses.flatMap((r, i) => (r.status === 200 ? [] : [{ r, body: JSON.parse(bodies[i]!) }]));
  expect(refused.map(({ r }) => r.status)).toEqual([429, 429]);
  for (const { r, body } of refused) {
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(body).toEqual({ error: "in-flight limit reached", repo: REPO, inFlightLimit: PROXY_IN_FLIGHT_LIMIT });
  }
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(
    PROXY_IN_FLIGHT_LIMIT,
  );
});

test("a truncated stream or a JSON response without usage retains the budget hold", async () => {
  for (const [contentType, body] of [
    ["application/json", '{"model":"claude-sonnet-4-6"}'],
    [
      "text/event-stream",
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
    ],
  ]) {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const pending: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "unused",
      anthropicBaseUrl: "https://anthropic.test",
      now: Date.now,
      waitUntil: (p) => pending.push(p),
      fetchUpstream: (async () =>
        new Response(body, { headers: { "content-type": contentType } })) as unknown as typeof fetch,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] }),
      }),
      env,
    );
    await res.text();
    await Promise.all(pending);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(0);
  }
});

test("successful settlement releases budget for another request", async () => {
  const env = await buildTestEnv();
  const token = await seedSession(env, REPO, 0.04);
  const pending: Promise<unknown>[] = [];
  const worker = createReviewWorker({
    jwksUrl: "unused",
    anthropicBaseUrl: "https://anthropic.test",
    now: Date.now,
    waitUntil: (p) => pending.push(p),
    fetchUpstream: (async () =>
      Response.json({
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 10 },
      })) as unknown as typeof fetch,
  });
  for (let i = 0; i < 6; i++) {
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 100,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(pending);
  }
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(6);
});

test("the next admission retries a failed settlement before reserving more budget", async () => {
  const env = await buildTestEnv();
  const token = await seedSession(env, REPO, 0.04);
  const pending: Promise<unknown>[] = [];
  const worker = createReviewWorker({
    jwksUrl: "unused",
    anthropicBaseUrl: "https://anthropic.test",
    now: Date.now,
    waitUntil: (p) => pending.push(p),
    fetchUpstream: (async () =>
      Response.json({
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 300, output_tokens: 42 },
      })) as unknown as typeof fetch,
  });
  const request = () =>
    worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] }),
      }),
      env,
    );
  await env.DB.exec(
    "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
  );
  const first = await request();
  expect(first.status).toBe(200);
  await first.text();
  await Promise.all(pending);
  expect((await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(0);
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE settlement_json IS NOT NULL").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(1);
  expect((await request()).status).toBe(503);
  await env.DB.exec("DROP TRIGGER fail_usage");
  const second = await request();
  expect(second.status).toBe(200);
  await second.text();
  await Promise.all(pending);
  expect(
    (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd,
  ).toBeCloseTo(0.00306, 9);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(2);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
});

test("holds older than the upstream deadline settle at their reserved cost and free the in-flight slots", async () => {
  const env = await buildTestEnv();
  await registerRepo(env, REPO, 100, 100);
  const token = "srs_expiringholds";
  const hash = await sha256Hex(token);
  const start = Date.UTC(2026, 8, 30, 23, 50);
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(hash, REPO, 7, start + 24 * 60 * 60_000, 100, 0, start)
    .run();
  let clock = start;
  let settle = false;
  const pending: Promise<unknown>[] = [];
  const worker = createReviewWorker({
    jwksUrl: "unused",
    anthropicBaseUrl: "https://anthropic.test",
    now: () => clock,
    waitUntil: (p) => pending.push(p),
    fetchUpstream: (async () =>
      Response.json(
        settle
          ? { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 10 } }
          : { model: "claude-sonnet-4-6" },
      )) as unknown as typeof fetch,
  });
  const request = async () => {
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] }),
      }),
      env,
    );
    await res.text();
    await Promise.all(pending);
    return res.status;
  };
  for (let i = 0; i < PROXY_IN_FLIGHT_LIMIT; i++) expect(await request()).toBe(200);
  expect(await request()).toBe(429);
  const reserved = (await env.DB.prepare("SELECT SUM(cost_usd) AS usd FROM usage_reservations").first<{ usd: number }>())!
    .usd;

  clock = start + 15 * 60_000;
  settle = true;
  expect(await request()).toBe(200);

  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
  const expired = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(cost_usd) AS usd, MIN(created_at) AS at FROM usage_events WHERE kind = 'expired_hold' AND model = 'claude-sonnet-4-6' AND pr = 7",
  ).first<{ n: number; usd: number; at: number }>();
  expect(expired).toEqual({ n: 4, usd: reserved, at: start });
  const spent = (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())!.spent_usd;
  expect(spent).toBeGreaterThan(reserved);
});
