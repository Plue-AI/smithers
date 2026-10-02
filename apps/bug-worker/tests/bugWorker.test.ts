import { describe, expect, test } from "bun:test";
import type { BugWorkerEnv } from "../src/worker.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits } from "./helpers/memoryDurableObjects.ts";

const ADMIN = "test-admin-secret";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/**
 * A valid bug report whose JSON encoding is exactly `bytes` long. The detail
 * string is ASCII padding followed by `tail` verbatim, so a caller can park a
 * multibyte character at a known offset from the end of the body.
 */
function bodyOfExactBytes(bytes: number, tail = ""): string {
  const envelopeBytes = encoder.encode(JSON.stringify({ summary: "cap", detail: "" })).byteLength;
  const padding = bytes - envelopeBytes - encoder.encode(tail).byteLength;
  const body = JSON.stringify({ summary: "cap", detail: `${"x".repeat(padding)}${tail}` });
  const built = encoder.encode(body).byteLength;
  if (built !== bytes) throw new Error(`built a ${built}-byte body, wanted ${bytes}`);
  return body;
}

/**
 * POST `body` with an explicit content-length, so the declared-length gate is
 * the one under test: the Request constructor sets no such header on its own.
 */
function postDeclared(body: string, ip: string): Request {
  return new Request("https://bug.smithers.sh/api/bugs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      "content-length": String(encoder.encode(body).byteLength),
    },
    body,
  });
}

/** Deliver `bytes` as two chunks split at `splitAt`, with no content-length. */
function postStreamed(bytes: Uint8Array, splitAt: number, ip: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, splitAt));
      controller.enqueue(bytes.subarray(splitAt));
      controller.close();
    },
  });
  const request = new Request("https://bug.smithers.sh/api/bugs", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (request.headers.get("content-length") !== null) throw new Error("streamed request declared a length");
  return request;
}

function makeEnv(now?: () => number): BugWorkerEnv & { BUGS: ReturnType<typeof memoryKv> } {
  return {
    BUGS: memoryKv(now),
    RATE_LIMITS: memoryRateLimits(),
    BUG_ADMIN_TOKEN: ADMIN,
    PUBLIC_BASE_URL: "https://bug.smithers.sh",
  };
}

function postBug(body: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://bug.smithers.sh/api/bugs", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("bug worker", () => {
  test("healthz", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(new Request("https://bug.smithers.sh/healthz"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("valid post returns id + url and stores the report in KV", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const res = await worker.fetch(
      postBug({
        summary: "engine crashed on resume",
        version: "1.0.0-rc.0",
        platform: "darwin-arm64",
        digest: { runId: "r-123", status: "failed" },
        extraLooseField: true,
      }),
      env,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { id, url } = (await res.json()) as { id: string; url: string };
    expect(id.length).toBeGreaterThan(10);
    expect(url).toBe(`https://bug.smithers.sh/api/bugs/${id}`);

    const stored = await env.BUGS.get(`bug:${id}`);
    expect(stored).not.toBeNull();
    const record = JSON.parse(stored!);
    expect(record.report.summary).toBe("engine crashed on resume");
    expect(record.report.digest.runId).toBe("r-123");
    expect(record.report.extraLooseField).toBe(true);
  });

  test("null optional fields are accepted", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const res = await worker.fetch(
      postBug({ summary: "report without a run", version: null, platform: null, digest: null }),
      env,
    );
    expect(res.status).toBe(201);
  });

  test("title-only reports round-trip through POST and admin GET", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const report = { title: "engine crashed on resume" };
    const posted = await worker.fetch(postBug(report), env);
    expect(posted.status).toBe(201);
    const { id, url } = (await posted.json()) as { id: string; url: string };
    const stored = JSON.parse((await env.BUGS.get(`bug:${id}`))!);
    expect(stored.report).toEqual(report);
    const read = await worker.fetch(new Request(url, { headers: { "x-bug-admin": ADMIN } }), env);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(stored);
  });

  test("invalid payload (missing headline) rejected 400", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(postBug({ version: "1.0.0-rc.0" }), makeEnv());
    expect(res.status).toBe(400);
  });

  test("non-JSON body rejected 400", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(postBug("not json {{{"), makeEnv());
    expect(res.status).toBe(400);
  });

  test("oversized payload rejected 413", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(postBug({ summary: "big", detail: "x".repeat(256 * 1024 + 1) }), makeEnv());
    expect(res.status).toBe(413);
  });

  test("declared content-length over the cap is rejected 413 before the body is read", async () => {
    const worker = createBugWorker();
    const request = new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.99",
        "content-length": String(256 * 1024 + 1),
      },
      body: JSON.stringify({ summary: "big" }),
    });
    const res = await worker.fetch(request, makeEnv());
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large", maxBytes: 256 * 1024 });
  });

  test("oversized streamed body with no content-length is rejected 413 by the stream counter", async () => {
    const worker = createBugWorker();
    const oversized = new TextEncoder().encode(JSON.stringify({ summary: "big", detail: "x".repeat(256 * 1024 + 1) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit in chunks so the running byte count crosses the cap mid-stream.
        for (let offset = 0; offset < oversized.byteLength; offset += 64 * 1024) {
          controller.enqueue(oversized.subarray(offset, offset + 64 * 1024));
        }
        controller.close();
      },
    });
    const request = new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.42" },
      body: stream,
      // No content-length header: the size gate must come from stream-counting.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();

    const res = await worker.fetch(request, makeEnv());
    expect(res.status).toBe(413);
  });

  test("a body of exactly the cap is accepted and stored whole", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const body = bodyOfExactBytes(MAX_PAYLOAD_BYTES);
    const request = postDeclared(body, "203.0.113.11");
    // The declared-length gate must admit a length equal to the cap, not just below it.
    expect(request.headers.get("content-length")).toBe(String(MAX_PAYLOAD_BYTES));

    const res = await worker.fetch(request, env);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const record = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as { report: unknown };
    expect(record.report).toEqual(JSON.parse(body));
  });

  test("a body one byte under the cap is accepted", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(postDeclared(bodyOfExactBytes(MAX_PAYLOAD_BYTES - 1), "203.0.113.12"), makeEnv());
    expect(res.status).toBe(201);
  });

  test("a body one byte over the cap is rejected 413 by the declared length", async () => {
    const worker = createBugWorker();
    const request = postDeclared(bodyOfExactBytes(MAX_PAYLOAD_BYTES + 1), "203.0.113.13");
    expect(request.headers.get("content-length")).toBe(String(MAX_PAYLOAD_BYTES + 1));
    const res = await worker.fetch(request, makeEnv());
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  });

  test("a streamed body of exactly the cap is accepted; one more byte is rejected 413", async () => {
    const worker = createBugWorker();
    const atCap = encoder.encode(bodyOfExactBytes(MAX_PAYLOAD_BYTES));
    const accepted = await worker.fetch(postStreamed(atCap, MAX_PAYLOAD_BYTES - 1, "203.0.113.14"), makeEnv());
    expect(accepted.status).toBe(201);

    // The first chunk lands the running count exactly on the cap; only the
    // final byte crosses it, so this fails if the counter used >= instead of >.
    const overCap = encoder.encode(bodyOfExactBytes(MAX_PAYLOAD_BYTES + 1));
    const rejected = await worker.fetch(postStreamed(overCap, MAX_PAYLOAD_BYTES, "203.0.113.15"), makeEnv());
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({ error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  });

  test("a multibyte character split across chunks survives a body at the cap", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const multibyte = "\u65e5"; // 3 UTF-8 bytes
    const body = bodyOfExactBytes(MAX_PAYLOAD_BYTES, multibyte);
    const bytes = encoder.encode(body);
    // The body ends with the character, then the closing quote and brace. Cut
    // one byte into the sequence so neither chunk holds a whole character.
    const splitAt = bytes.byteLength - 2 - 3 + 1;

    const res = await worker.fetch(postStreamed(bytes, splitAt, "203.0.113.16"), env);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const record = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as { report: { detail: string } };
    expect(record.report.detail.endsWith(multibyte)).toBe(true);
    expect(record.report.detail).not.toContain("\ufffd");
  });

  test('post with an empty (null) body reads as "" and is rejected 400 as non-JSON', async () => {
    const worker = createBugWorker();
    const request = new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.55" },
    });
    expect(request.body).toBeNull();
    const res = await worker.fetch(request, makeEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be JSON" });
  });

  test("rate limit trips at 21 posts from one IP within the hour", async () => {
    let clock = Date.parse("2026-07-02T10:00:00Z");
    const worker = createBugWorker({ now: () => clock });
    const env = makeEnv(() => clock);
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(postBug({ summary: `bug ${i}` }), env);
      expect(res.status).toBe(201);
    }
    const blocked = await worker.fetch(postBug({ summary: "bug 21" }), env);
    expect(blocked.status).toBe(429);

    // Different IP is unaffected.
    const otherIp = await worker.fetch(postBug({ summary: "other" }, "198.51.100.9"), env);
    expect(otherIp.status).toBe(201);

    // Next hour bucket resets the counter.
    clock += 61 * 60 * 1000;
    const nextHour = await worker.fetch(postBug({ summary: "next hour" }), env);
    expect(nextHour.status).toBe(201);
  });

  test("rejected posts never spend the IP's hourly budget", async () => {
    const clock = Date.parse("2026-07-02T10:00:00Z");
    const worker = createBugWorker({ now: () => clock });
    const env = makeEnv(() => clock);
    const ip = "203.0.113.77";
    const rejected = [
      { request: postBug("not json", ip), status: 400 },
      { request: postBug({ detail: "no summary" }, ip), status: 400 },
      { request: postDeclared(bodyOfExactBytes(MAX_PAYLOAD_BYTES + 1), ip), status: 413 },
    ];
    for (let i = 0; i < 25; i++) {
      const { request, status } = rejected[i % rejected.length]!;
      const res = await worker.fetch(request.clone(), env);
      expect(res.status).toBe(status);
    }
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(postBug({ summary: `real bug ${i}` }, ip), env);
      expect(res.status).toBe(201);
    }
    const blocked = await worker.fetch(postBug({ summary: "real bug 21" }, ip), env);
    expect(blocked.status).toBe(429);
  });

  test("admin GET requires x-bug-admin and returns the stored record", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const posted = await worker.fetch(postBug({ summary: "gated" }), env);
    const { id } = (await posted.json()) as { id: string };

    const noHeader = await worker.fetch(new Request(`https://bug.smithers.sh/api/bugs/${id}`), env);
    expect(noHeader.status).toBe(401);

    const wrong = await worker.fetch(
      new Request(`https://bug.smithers.sh/api/bugs/${id}`, { headers: { "x-bug-admin": "nope" } }),
      env,
    );
    expect(wrong.status).toBe(401);

    const ok = await worker.fetch(
      new Request(`https://bug.smithers.sh/api/bugs/${id}`, { headers: { "x-bug-admin": ADMIN } }),
      env,
    );
    expect(ok.status).toBe(200);
    const record = (await ok.json()) as { id: string; report: { summary: string } };
    expect(record.id).toBe(id);
    expect(record.report.summary).toBe("gated");
  });

  test("admin GET 404s for an unknown id", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(
      new Request("https://bug.smithers.sh/api/bugs/doesnotexist", { headers: { "x-bug-admin": ADMIN } }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  test("admin tokens of different lengths still compare correctly (no length shortcut)", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const posted = await worker.fetch(postBug({ summary: "length check" }), env);
    const { id } = (await posted.json()) as { id: string };
    for (const guess of [ADMIN.slice(0, -1), `${ADMIN}x`, ""]) {
      const res = await worker.fetch(
        new Request(`https://bug.smithers.sh/api/bugs/${id}`, { headers: { "x-bug-admin": guess } }),
        env,
      );
      expect(res.status).toBe(401);
    }
    const ok = await worker.fetch(
      new Request(`https://bug.smithers.sh/api/bugs/${id}`, { headers: { "x-bug-admin": ADMIN } }),
      env,
    );
    expect(ok.status).toBe(200);
  });

  test("a KV outage answers a clean 503 JSON error, never a thrown 1101 page", async () => {
    const worker = createBugWorker();
    const broken = {
      async get(): Promise<string | null> {
        throw new Error("KV namespace unavailable");
      },
      async put(): Promise<void> {
        throw new Error("KV namespace unavailable");
      },
      async delete(): Promise<void> {
        throw new Error("KV namespace unavailable");
      },
    };
    const env: BugWorkerEnv = { ...makeEnv(), BUGS: broken };

    const posted = await worker.fetch(postBug({ summary: "posted during a KV outage" }), env);
    expect(posted.status).toBe(503);
    expect(posted.headers.get("content-type")).toContain("application/json");
    expect(await posted.json()).toEqual({ error: "storage unavailable" });

    const read = await worker.fetch(
      new Request("https://bug.smithers.sh/api/bugs/abc123", { headers: { "x-bug-admin": ADMIN } }),
      env,
    );
    expect(read.status).toBe(503);
    expect(read.headers.get("content-type")).toContain("application/json");
    expect(await read.json()).toEqual({ error: "storage unavailable" });
  });

  test("unmatched route falls through to 404", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(new Request("https://bug.smithers.sh/nope", { method: "DELETE" }), makeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("onboarding answers are not an intake: the signup poll saves them to the account profile", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const url = "https://bug.smithers.sh/api/onboarding-answers";
    const posted = await worker.fetch(new Request(url, { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), heard: "friend", project: "" }) }), env);
    const listed = await worker.fetch(new Request(url, { headers: { "x-bug-admin": ADMIN } }), env);
    expect([posted.status, listed.status]).toEqual([404, 404]);
    expect([...env.BUGS.dump().keys()]).toEqual([]);
  });

  test("OPTIONS preflight allows POST from anywhere", async () => {
    const worker = createBugWorker();
    const res = await worker.fetch(new Request("https://bug.smithers.sh/api/bugs", { method: "OPTIONS" }), makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
