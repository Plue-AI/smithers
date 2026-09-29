import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { memoryBucket } from "./helpers/memoryBucket.ts";

const ID = "abc12345";
const HTML = "<!doctype html><html><body><script>window.walkthrough = true</script></body></html>";
const CONTENT_ORIGIN = "https://walkthroughs.example";
const API_ORIGIN = "https://review.jjhub.tech";

function worker() {
  return createReviewWorker({
    jwksUrl: "https://unused.example/jwks",
    anthropicBaseUrl: "https://unused.example",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

async function fixture(publicBaseUrl?: string) {
  const env = await buildTestEnv({ PUBLIC_BASE_URL: publicBaseUrl });
  // The shared fixture supplies a valid default; these cases must also cover
  // a genuinely absent binding.
  env.PUBLIC_BASE_URL = publicBaseUrl;
  const bucket = memoryBucket();
  env.WALKTHROUGHS = bucket;
  await bucket.put(`walkthroughs/${ID}.html`, HTML);
  const reads: string[] = [];
  const get = bucket.get.bind(bucket);
  bucket.get = async (key) => {
    reads.push(key);
    return get(key);
  };
  return { env, reads };
}

describe("worker content origin boundary", () => {
  test("serves uploaded HTML only on the configured content origin", async () => {
    const { env, reads } = await fixture(CONTENT_ORIGIN);
    const response = await worker().fetch(new Request(`${CONTENT_ORIGIN}/w/${ID}`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe(HTML);
    expect(reads).toEqual([`walkthroughs/${ID}.html`]);
  });

  test.each([
    API_ORIGIN,
    "https://smithers-review.workers.dev",
    "https://unknown.example",
    "http://walkthroughs.example",
    "https://walkthroughs.example:8443",
    "https://walkthroughs.example.",
  ])("rejects /w on another request origin without reading storage: %s", async (origin) => {
    const { env, reads } = await fixture(CONTENT_ORIGIN);
    const response = await worker().fetch(new Request(`${origin}/w/${ID}`), env);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test.each([
    undefined,
    "",
    "not-an-origin",
    "http://walkthroughs.example",
    "https://user:pass@walkthroughs.example",
    "https://walkthroughs.example/path",
    "https://walkthroughs.example/?query=1",
    "https://walkthroughs.example/#fragment",
    "https://walkthroughs.example.",
  ])("fails closed for missing or invalid PUBLIC_BASE_URL: %s", async (publicBaseUrl) => {
    const { env, reads } = await fixture(publicBaseUrl);
    const response = await worker().fetch(new Request(`${CONTENT_ORIGIN}/w/${ID}`), env);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test("rejects a trailing-dot configured origin even on its matching request host", async () => {
    const origin = "https://walkthroughs.example.";
    const { env, reads } = await fixture(origin);
    const response = await worker().fetch(new Request(`${origin}/w/${ID}`), env);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test.each([
    API_ORIGIN,
    "https://api.jjhub.tech",
    "https://jjhub.tech",
    "https://smithers.sh",
    "https://docs.smithers.sh",
    "https://review.jjhub.tech.",
    "https://api.jjhub.tech.",
    "https://smithers.sh.",
    "https://docs.smithers.sh.",
  ])("refuses a product domain as PUBLIC_BASE_URL: %s", async (origin) => {
    const { env, reads } = await fixture(origin);
    const response = await worker().fetch(new Request(`${origin}/w/${ID}`), env);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test.each([
    ["GET", "/"],
    ["GET", "/api/walkthroughs"],
    ["POST", "/api/sessions"],
    ["GET", "/metrics"],
    ["POST", `/w/${ID}`],
  ])("keeps %s %s off the content origin", async (method, path) => {
    const { env, reads } = await fixture(CONTENT_ORIGIN);
    const response = await worker().fetch(new Request(`${CONTENT_ORIGIN}${path}`, { method }), env);

    expect(response.status).toBe(404);
    expect(reads).toEqual([]);
  });

  test.each([
    ["http://walkthroughs.example", "POST", "/api/sessions"],
    ["https://walkthroughs.example:8443", "POST", "/api/sessions"],
    ["https://walkthroughs.example.", "GET", "/api/walkthroughs"],
  ])(
    "does not expose API routes through a content hostname alias: %s %s %s",
    async (origin, method, path) => {
      const { env, reads } = await fixture(CONTENT_ORIGIN);
      const response = await worker().fetch(new Request(`${origin}${path}`, { method }), env);

      expect(response.status).toBe(404);
      expect(reads).toEqual([]);
    },
  );

  test.each([undefined, "not-an-origin", API_ORIGIN])(
    "rejects publish and history before side effects when content origin is untrusted: %s",
    async (publicBaseUrl) => {
      const { env } = await fixture(publicBaseUrl);
      const bucket = env.WALKTHROUGHS as ReturnType<typeof memoryBucket>;
      const writes: string[] = [];
      const put = bucket.put.bind(bucket);
      bucket.put = async (key, ...args) => {
        writes.push(key);
        return put(key, ...args);
      };
      const reviewWorker = worker();

      const publish = await reviewWorker.fetch(new Request(`${API_ORIGIN}/api/walkthroughs`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-publish",
          "content-type": "text/html; charset=utf-8",
        },
        body: HTML,
      }), env);
      const history = await reviewWorker.fetch(new Request(`${API_ORIGIN}/api/walkthroughs?repo=octo/widgets`, {
        headers: { authorization: "Bearer srs_unknown" },
      }), env);

      expect(publish.status).toBe(503);
      expect(history.status).toBe(503);
      expect(writes).toEqual([]);
      expect([...bucket._store.keys()]).toEqual([`walkthroughs/${ID}.html`]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM walkthroughs").first<{ count: number }>())
        .toEqual({ count: 0 });
    },
  );

  test("session URLs remain on the API request origin when a content origin is configured", async () => {
    const { env } = await fixture(CONTENT_ORIGIN);
    const apiKey = "srk_content_origin_test";
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("octo/widgets", "auto", 3, 25, Date.now()).run();
    await env.DB.prepare(
      "INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256Hex(apiKey), "test", JSON.stringify(["octo/widgets"]), Date.now()).run();

    const response = await worker().fetch(new Request(`${API_ORIGIN}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey, repo: "octo/widgets", pr: 7 }),
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json() as { publishUrl: string; anthropicBaseUrl: string };
    expect(body.publishUrl).toBe(API_ORIGIN);
    expect(body.anthropicBaseUrl).toBe(`${API_ORIGIN}/anthropic`);
  });
});
