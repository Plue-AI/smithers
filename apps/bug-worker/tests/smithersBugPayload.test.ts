import { ControlSchema } from "@smthrs/control";
import { Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { bugReportSchema } from "../src/bugReportSchema.ts";
import type { BugWorkerEnv } from "../src/worker.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits, memoryRepoCompletions } from "./helpers/memoryDurableObjects.ts";

const decodeRunSummary = Schema.decodeUnknownSync(ControlSchema.RunSummary);
const decodeControlEvent = Schema.decodeUnknownSync(ControlSchema.ControlEvent);

const runSummary = decodeRunSummary({
  runId: "run-01JQ8Z2K3M4N5P6Q7R8S9T0V1W",
  flowId: "flows/build-and-review",
  status: "failed",
  planId: "plan-7f3c",
  planDigest: "sha256:0e1d",
  createdAt: 1_788_000_000_000,
  updatedAt: 1_788_000_042_000,
});

const controlEvents = [
  { sequence: 1, kind: "control.run.accepted", runId: runSummary.runId, occurredAt: 1_788_000_000_100, payload: {} },
  {
    sequence: 2,
    kind: "control.approval.requested",
    runId: runSummary.runId,
    occurredAt: 1_788_000_010_000,
    payload: { target: { _tag: "Node", nodeId: "review" } },
  },
  {
    sequence: 3,
    kind: "control.run.failed",
    runId: runSummary.runId,
    occurredAt: 1_788_000_042_000,
    payload: { message: "the review step exhausted its correction budget" },
  },
].map((event) => decodeControlEvent(event));

const payload = {
  summary: "the review step exhausted its correction budget",
  version: "1.0.0-rc.0",
  platform: "darwin-arm64",
  node: "22.19.0",
  runs: [runSummary],
  digest: { runId: runSummary.runId, events: controlEvents },
};

// The complete 0.x example in README.md.
const legacyPayload = {
  title: "Run run-01JQ… failed: the review step exhausted its correction budget",
  body: "It failed the same way twice on a clean checkout.",
  smithersVersion: "0.35.0",
  platform: { os: "darwin", arch: "arm64", nodeVersion: "v22.19.0" },
  createdAtMs: 1788000050000,
  run: { runId: "r-123", workflowName: "build-and-review", status: "failed", events: [] },
};

function makeEnv(): BugWorkerEnv & { BUGS: ReturnType<typeof memoryKv> } {
  return { BUGS: memoryKv(), REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: "admin", PUBLIC_BASE_URL: "https://bug.smithers.sh" };
}

function post(body: unknown): Request {
  return new Request("https://bug.smithers.sh/api/bugs", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

describe("the smithers bug payload contract", () => {
  test("round-trips the documented 0.x payload through POST and admin GET", async () => {
    const worker = createBugWorker();
    const env = makeEnv();
    const response = await worker.fetch(post(legacyPayload), env);
    expect(response.status).toBe(201);

    const { id, url } = (await response.json()) as { id: string; url: string };
    const stored = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as { report: typeof legacyPayload };
    expect(stored.report).toEqual(legacyPayload);
    const read = await worker.fetch(new Request(url, { headers: { "x-bug-admin": "admin" } }), env);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(stored);
  });

  test("accepts an object platform with a summary and preserves unknown platform fields", async () => {
    const report = { ...payload, platform: { os: "darwin", arch: "arm64", bunVersion: "1.4.1", extra: true } };
    const env = makeEnv();
    const response = await createBugWorker().fetch(post(report), env);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const stored = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as { report: typeof report };
    expect(stored.report).toEqual(report);
  });

  test("accepts and stores the CLI payload", async () => {
    expect(bugReportSchema.safeParse(payload).success).toBe(true);
    const env = makeEnv();
    const response = await createBugWorker().fetch(post(payload), env);
    expect(response.status).toBe(201);

    const { id } = (await response.json()) as { id: string };
    const record = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as { report: typeof payload };
    expect(record.report.summary).toBe(payload.summary);
    expect(record.report.runs[0]?.flowId).toBe("flows/build-and-review");
    expect(record.report.digest.events).toHaveLength(3);
  });

  test("stores every current run status", async () => {
    const env = makeEnv();
    for (const status of ControlSchema.RunStatus.literals) {
      const response = await createBugWorker().fetch(post({ ...payload, runs: [{ ...runSummary, status }] }), env);
      expect(response.status).toBe(201);
    }
  });

  test("accepts a report without a run digest", async () => {
    const response = await createBugWorker().fetch(
      post({ summary: "init wrote no flow", version: "1.0.0-rc.0", platform: "linux-x64", node: "22.19.0", runs: [] }),
      makeEnv(),
    );
    expect(response.status).toBe(201);
  });

  test("accepts a 500-character headline and rejects 501", async () => {
    const atCap = "x".repeat(500);
    const overCap = "x".repeat(501);
    for (const field of ["summary", "title"] as const) {
      expect(bugReportSchema.safeParse({ [field]: atCap }).success).toBe(true);
      expect(bugReportSchema.safeParse({ [field]: overCap }).success).toBe(false);
    }

    const env = makeEnv();
    const accepted = await createBugWorker().fetch(post({ ...payload, summary: atCap }), env);
    expect(accepted.status).toBe(201);
    const { id } = (await accepted.json()) as { id: string };
    const stored = JSON.parse((await env.BUGS.get(`bug:${id}`))!) as { report: { summary: string } };
    expect(stored.report.summary).toBe(atCap);

    const rejected = await createBugWorker().fetch(post({ ...payload, summary: overCap }), env);
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as Record<string, unknown>;
    // The reply names the field, never the schema library's own message.
    expect(body).toEqual({ error: "invalid bug report", fields: ["summary"] });
  });

  test("an invalid report names every bad field once, and a non-object body as the body", async () => {
    const env = makeEnv();
    const nested = await createBugWorker().fetch(post({ ...payload, summary: 7, environment: { os: 1 } }), env);
    expect(nested.status).toBe(400);
    const body = (await nested.json()) as { fields: string[] };
    expect(body.fields).toContain("summary");
    expect(new Set(body.fields).size).toBe(body.fields.length);
    expect(JSON.stringify(body)).not.toMatch(/expected|received|invalid_type/i);
    const scalar = await createBugWorker().fetch(post(5 as never), env);
    expect(scalar.status).toBe(400);
    expect(await scalar.json()).toEqual({ error: "invalid bug report", fields: ["(body)"] });
  });

  test("requires a non-empty headline", () => {
    expect(bugReportSchema.safeParse({ version: "1.0.0-rc.0", runs: [] }).success).toBe(false);
    expect(bugReportSchema.safeParse({ summary: "" }).success).toBe(false);
    for (const report of [{ title: "" }, { summary: "   ", title: "\t" }, { summary: null, title: null }]) {
      expect(bugReportSchema.safeParse(report).success).toBe(false);
    }
  });
});
