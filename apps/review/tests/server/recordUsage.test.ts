import { expect, test } from "bun:test";
import { recordUsage } from "../../src/server/proxy/recordUsage.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

async function setup() {
  const env = await buildTestEnv();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind("session", "octo/widgets", 1, Date.now() + 60_000, 1, Date.now())
    .run();
  const options = {
    requestId: "stable-request-id",
    sessionHash: "session",
    repo: "octo/widgets",
    pr: 1,
    summary: {
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 42,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    kind: "messages" as const,
    now: Date.now(),
  };
  return { env, options };
}

test("event insertion failure rolls back the session debit", async () => {
  const { env, options } = await setup();
  await env.DB.exec(
    "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
  );
  await expect(recordUsage(env.DB, options)).rejects.toThrow("injected event failure");
  expect((await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(0);
});

test("replaying a stable request id debits and records once", async () => {
  const { env, options } = await setup();
  await Promise.all([recordUsage(env.DB, options), recordUsage(env.DB, options)]);
  expect(
    (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd,
  ).toBeCloseTo(0.00153, 9);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(1);
});

test("a failed settlement retains its reservation and durable payload for retry", async () => {
  const { env, options } = await setup();
  await env.DB.prepare(
    "INSERT INTO usage_reservations (id, repo, session_hash, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(options.requestId, options.repo, options.sessionHash, 0.5, options.now)
    .run();
  await env.DB.exec(
    "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
  );
  await expect(recordUsage(env.DB, options)).rejects.toThrow("injected event failure");
  const pending = await env.DB.prepare("SELECT * FROM usage_reservations").first<{
    cost_usd: number;
    settlement_json: string;
  }>();
  expect(pending?.cost_usd).toBe(0.5);
  expect(JSON.parse(pending!.settlement_json)).toEqual(options);
  expect((await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd).toBe(0);
  await env.DB.exec("DROP TRIGGER fail_usage");
  const { retryUsage } = await import("../../src/server/proxy/retryUsage.ts");
  await retryUsage(env.DB, options.repo);
  await retryUsage(env.DB, options.repo);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(1);
  expect(
    (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd,
  ).toBeCloseTo(0.00153, 9);
});

test("a prompt at the long-context threshold settles at the long-context rate", async () => {
  const { env, options } = await setup();
  await recordUsage(env.DB, {
    ...options,
    summary: {
      model: "claude-sonnet-4-5",
      inputTokens: 150_000,
      outputTokens: 100,
      cacheCreationTokens: 40_000,
      cacheReadTokens: 10_000,
    },
  });
  // 200k prompt tokens reach claude-sonnet-4-5's longContextFrom, so every
  // class bills at the tiered 6/22.5/7.5/0.6 rates, not the standard ones.
  expect(
    (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd,
  ).toBeCloseTo(1.20825, 9);
});

test("outstanding reservations still constrain repository budget after UTC month rollover", async () => {
  const { reserveUsage } = await import("../../src/server/proxy/reserveUsage.ts");
  const { env } = await setup();
  const options = {
    requestId: "before",
    repo: "octo/widgets",
    sessionHash: null,
    model: "claude-sonnet-4-6",
    repoCapUsd: 1,
    costUsd: 0.6,
    now: Date.UTC(2026, 7, 31, 23, 59),
  };
  expect(await reserveUsage(env.DB, options)).toBe("reserved");
  expect(await reserveUsage(env.DB, { ...options, requestId: "after", now: Date.UTC(2026, 8, 1) })).toBe("spend_cap");
  expect(await reserveUsage(env.DB, options)).toBe("spend_cap");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(1);
});

test("distinct request IDs record separately, including spend after an administrative cap reduction", async () => {
  const { env, options } = await setup();
  await env.DB.prepare("UPDATE sessions SET spend_cap_usd = 0.001").run();
  await recordUsage(env.DB, options);
  await recordUsage(env.DB, { ...options, requestId: "second" });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(2);
  expect(
    (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd,
  ).toBeCloseTo(0.00306, 9);
});

test("a failed session debit never commits an event or releases the hold", async () => {
  const { env, options } = await setup();
  await env.DB.prepare(
    "INSERT INTO usage_reservations (id, repo, session_hash, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(options.requestId, options.repo, options.sessionHash, 0.5, options.now)
    .run();
  await env.DB.exec(
    "CREATE TRIGGER fail_debit BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'injected debit failure'); END",
  );
  await expect(recordUsage(env.DB, options)).rejects.toThrow("injected debit failure");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(1);
});

test("interrupted usage retries idempotently without releasing its budget hold", async () => {
  const { env, options: base } = await setup();
  const options = { ...base, retainReservation: true };
  await env.DB.prepare(
    "INSERT INTO usage_reservations (id, repo, session_hash, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(options.requestId, options.repo, options.sessionHash, 0.5, options.now)
    .run();
  await env.DB.exec(
    "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
  );
  await expect(recordUsage(env.DB, options)).rejects.toThrow("injected event failure");
  expect(
    JSON.parse(
      (await env.DB.prepare("SELECT settlement_json FROM usage_reservations").first<{ settlement_json: string }>())!
        .settlement_json,
    ),
  ).toEqual(options);
  await env.DB.exec("DROP TRIGGER fail_usage");
  const { retryUsage } = await import("../../src/server/proxy/retryUsage.ts");
  await retryUsage(env.DB, options.repo);
  await retryUsage(env.DB, options.repo);
  expect(
    await env.DB.prepare("SELECT cost_usd, settlement_json FROM usage_reservations").first<{
      cost_usd: number;
      settlement_json: string | null;
    }>(),
  ).toEqual({
    cost_usd: 0.5,
    settlement_json: null,
  });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(1);
  expect(
    (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())?.spent_usd,
  ).toBeCloseTo(0.00153, 9);
});
