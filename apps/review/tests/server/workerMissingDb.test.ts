import { describe, expect, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { memoryBucket } from "./helpers/memoryBucket.ts";

function envWithoutDb(): ReviewWorkerEnv {
  return {
    WALKTHROUGHS: memoryBucket(),
    PUBLIC_BASE_URL: "https://content.example",
    // Simulates a worker deployed without the D1 binding.
    DB: undefined as unknown as ReviewWorkerEnv["DB"],
    REVIEW_PUBLISH_TOKEN: "test-publish",
    ADMIN_TOKEN: "test-admin",
    METRICS_TOKEN: "test-metrics",
    ANTHROPIC_API_KEY: "sk-ant-test",
  };
}

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

describe("worker without a DB binding", () => {
  test("API routes answer 503 JSON instead of crashing", async () => {
    const worker = makeWorker();
    const env = envWithoutDb();
    for (const request of [
      new Request("https://review.test/api/sessions", { method: "POST", body: "{}" }),
      new Request("https://review.test/anthropic/v1/messages", { method: "POST", body: "{}" }),
      new Request("https://review.test/metrics"),
      new Request("https://review.test/api/admin/repos"),
    ]) {
      const res = await worker.fetch(request, env);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("database unavailable");
    }
  });

  test("landing page still serves without a DB", async () => {
    const worker = makeWorker();
    const res = await worker.fetch(new Request("https://review.test/"), envWithoutDb());
    expect(res.status).toBe(200);
  });
});

describe("worker without a walkthrough storage binding", () => {
  test("serves walkthrough requests with a 503 JSON error instead of crashing", async () => {
    const worker = makeWorker();
    const env = envWithoutDb();
    env.DB = {} as ReviewWorkerEnv["DB"];
    env.WALKTHROUGHS = undefined as unknown as ReviewWorkerEnv["WALKTHROUGHS"];

    const response = await worker.fetch(new Request("https://content.example/w/abc12345"), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "walkthrough storage unavailable" });
  });

  test("rejects walkthrough publishes with a 503 JSON error instead of crashing", async () => {
    const worker = makeWorker();
    const env = await buildTestEnv();
    env.WALKTHROUGHS = undefined as unknown as ReviewWorkerEnv["WALKTHROUGHS"];

    const response = await worker.fetch(
      new Request("https://review.test/api/walkthroughs", {
        method: "POST",
        headers: { authorization: "Bearer test-publish", "content-type": "text/html" },
        body: "<p>walkthrough</p>",
      }),
      env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "walkthrough storage unavailable" });
  });

  test("rejects walkthrough deletes with a 503 JSON error instead of crashing", async () => {
    const worker = makeWorker();
    const env = await buildTestEnv();
    const id = "abc12345";
    await env.DB.prepare(
      "INSERT INTO walkthroughs (id, repo, pr, bytes, session_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, "smithersai/smithers", 1, 1, null, Date.now())
      .run();
    env.WALKTHROUGHS = undefined as unknown as ReviewWorkerEnv["WALKTHROUGHS"];

    const response = await worker.fetch(
      new Request(`https://review.test/api/walkthroughs/${id}`, {
        method: "DELETE",
        headers: { authorization: "Bearer test-publish" },
      }),
      env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "walkthrough storage unavailable" });
  });
});
