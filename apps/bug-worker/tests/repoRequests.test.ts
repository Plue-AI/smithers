import { describe, expect, spyOn, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import { repoName } from "../src/repoName.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits, memoryRepoCompletions } from "./helpers/memoryDurableObjects.ts";
import type { BugWorkerEnv } from "../src/env.ts";

function fixture() {
  const kv = memoryKv();
  const env: BugWorkerEnv = { BUGS: kv, REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: "test-admin", RESEND_API_KEY: "test-key", NOTIFICATION_FROM: "Smithers <test@example.com>" };
  const calls: { url: string; init?: RequestInit }[] = [];
  let now = 1788500000000;
  let emailStatus = 200;
  let recipientStatus: ((email: string) => number) | undefined;
  let emailError: Error | undefined;
  let github: unknown = { private: false, license: { spdx_id: "MIT" } };
  let githubStatus = 200;
  const worker = createBugWorker({ now: () => now, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("api.github.com")) return Response.json(github, { status: githubStatus });
    if (url.includes("resend") && emailError) throw emailError;
    return Response.json({ id: "email-1" }, { status: url.includes("resend") ? recipientStatus?.(JSON.parse(String(init?.body)).to[0]) ?? emailStatus : 200 });
  }) as typeof fetch });
  const call = (body?: unknown, route = "", admin = true, ip = "203.0.113.1") => worker.fetch(new Request(`https://bug.smithers.sh/api/repo-requests${route}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(admin ? { "x-bug-admin": "test-admin" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const complete = () => call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/repos/owner/repo" }, "/complete", true);
  const mails = (subject: string) => calls.filter((call) => call.url.includes("resend"))
    .map((call) => JSON.parse(String(call.init?.body)) as { to: string[]; subject: string; text: string })
    .filter((mail) => mail.subject.includes(subject));
  const confirmTokenFor = (to: string) => /confirm\?token=([0-9a-f]{32})/.exec(mails("Confirm your Smithers notification").find((mail) => mail.to[0] === to)!.text)![1]!;
  /** The button on an emailed link's page: a bodiless POST back to the same URL. */
  const press = (route: string) => worker.fetch(new Request(`https://bug.smithers.sh/api/repo-requests${route}`, { method: "POST" }), env);
  const confirm = (to: string) => press(`/confirm?token=${confirmTokenFor(to)}`);
  return { env, kv, worker, calls, call, press, complete, mails, confirm, confirmTokenFor, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; }, emailError: (value: Error | undefined) => { emailError = value; }, recipientStatus: (value: (email: string) => number) => { recipientStatus = value; }, emailStatus: (value: number) => { emailStatus = value; }, github: (value: unknown, status = 200) => { github = value; githubStatus = status; } };
}

/** Completed repositories with nothing left to send, sorted before `owner/zz-target`. */
async function idleCompletedRepositories(f: { env: BugWorkerEnv }) {
  const ready = JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" });
  for (let i = 0; i < 99; i++) await f.env.BUGS.put(`repo-ready:owner/r${String(i).padStart(3, "0")}`, ready);
}

/** Make KV `op` throw for keys under `prefix`, `times` times, then behave again. */
function failKv(f: { env: BugWorkerEnv; kv: ReturnType<typeof memoryKv> }, op: "put" | "delete", prefix: string, times = Infinity) {
  const kv = f.kv;
  let left = times;
  const trip = (key: string) => { if (key.startsWith(prefix) && left-- > 0) throw new Error("KV namespace unavailable"); };
  f.env.BUGS = op === "put"
    ? { ...kv, put: async (key, value, options) => { trip(key); await kv.put(key, value, options); } }
    : { ...kv, delete: async (key) => { trip(key); await kv.delete(key); } };
}

/** Run `body` with console.error captured; returns the JSON lines it logged. */
async function logsOf(body: () => Promise<void>): Promise<unknown[]> {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await body();
    return errors.mock.calls.map((args) => JSON.parse(String(args[0])));
  } finally { errors.mockRestore(); }
}

describe("public repository requests", () => {
  test("normalizes roots and rejects foreign hosts, paths, credentials, and invalid names", () => {
    expect(repoName(" https://github.com/Owner/Repo.git/ ")).toBe("owner/repo");
    for (const value of ["https://evil.com/owner/repo", "https://github.com/owner/repo/tree/main", "https://github.com@evil.com/a/b", "owner/..", "owner/repo?x=1", null]) expect(repoName(value)).toBeNull();
  });
  test("persists smithering, deduplicates repo and emails, and keeps email private", async () => {
    const f = fixture();
    const response = await f.call({ repo: "https://github.com/Owner/Repo", email: "Me@example.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repo: { name: "owner/repo", status: "smithering", appUrl: null }, subscribed: true });
    await f.call({ repo: "owner/repo.git", email: "me@example.com" });
    expect(f.calls.filter((call) => call.url.includes("api.github.com"))).toHaveLength(1);
    const listing = await (await f.call()).text();
    expect(listing).toContain('"smithering"');
    expect(listing).not.toContain("example.com");
    // Nothing is deliverable until the recipient confirms; submissions hold pending tokens only.
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(2);
    expect(f.mails("Confirm your Smithers notification").map((mail) => mail.to[0])).toEqual(["me@example.com", "me@example.com"]);
    expect((await f.confirm("me@example.com")).status).toBe(200);
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
  });
  test("refuses anonymous and wrong-token nominations before GitHub, forks, mail, or storage", async () => {
    const f = fixture();
    const before = new Map(f.kv.dump());
    const nominate = (headers: Record<string, string>) => f.worker.fetch(new Request("https://bug.smithers.sh/api/repo-requests", {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ repo: "owner/repo", email: "stranger@example.com" }),
    }), f.env);
    for (const headers of [{}, { "x-bug-admin": "wrong" }] as Record<string, string>[]) {
      const refused = await nominate(headers);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "Admin authentication required." });
    }
    expect(f.calls).toHaveLength(0);
    expect(new Map(f.kv.dump())).toEqual(before);
  });
  test("validates email before creating requests and rejects private or unlicensed repos", async () => {
    const f = fixture();
    expect((await f.call({ repo: "owner/repo", email: "oops" })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
    for (const github of [{ private: true, license: { spdx_id: "MIT" } }, { private: false }, { private: false, license: { spdx_id: "NOASSERTION" } }]) {
      f.github(github);
      expect((await f.call({ repo: "owner/repo" })).status).toBe(400);
    }
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(0);
  });
  test("checks GitHub with a manual redirect and refuses a moved repository like a missing one", async () => {
    // workerd rejects redirect: "error" before sending, so the check must ask for "manual"
    // and read a 3xx answer itself; "follow" would land on the renamed repository instead.
    const f = fixture();
    f.github({ message: "Moved Permanently" }, 301);
    const moved = await f.call({ repo: "owner/moved" });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toEqual({ error: "That repository was not found. Please use a public GitHub repository." });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.github.com/repos/owner/moved");
    expect(f.calls[0]!.init?.redirect).toBe("manual");
    f.github({ message: "Not Found" }, 404);
    const missing = await f.call({ repo: "owner/missing" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "That repository was not found. Please use a public GitHub repository." });
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-nominations:" })).keys).toHaveLength(0);
    f.github({ private: false, license: { spdx_id: "MIT" } }, 200);
    expect((await f.call({ repo: "owner/repo" })).status).toBe(200);
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(1);
  });
  test("completion requires authentication and an allowed public app URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    expect((await f.call({ repo: "owner/repo" }, "/complete", false)).status).toBe(401);
    for (const appUrl of ["javascript:alert(1)", "https://evil.com", "https://user@app.smithers.sh", "http://app.smithers.sh"]) {
      expect((await f.call({ repo: "owner/repo", appUrl }, "/complete", true)).status).toBe(400);
    }
    expect((await f.complete()).status).toBe(200);
    expect(await (await f.call()).json()).toMatchObject({ repos: [{ status: "ready", appUrl: "https://app.smithers.sh/repos/owner/repo" }] });
    expect(await (await f.call({ repo: "owner/repo", email: "later@example.com" })).json()).toMatchObject({ repo: { status: "ready" }, subscribed: false });
  });
  test("concurrent conflicting completions publish and notify only the winning URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect((await f.confirm("one@example.com")).status).toBe(200);
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    let arrivals = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    // Hold both requests at their first KV read so they reach the Durable Object together.
    f.env.BUGS.get = async (key) => {
      const value = await get(key);
      if (key === "repo-request:owner/repo" && arrivals < 2) {
        if (++arrivals === 2) release();
        await both;
      }
      return value;
    };
    const responses = await Promise.all(["first", "second"].map((path) =>
      f.call({ repo: "owner/repo", appUrl: `https://app.smithers.sh/${path}` }, "/complete", true)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await responses.find((response) => response.status === 200)!.json();
    const ready = JSON.parse((await get("repo-ready:owner/repo"))!);
    expect(ready.appUrl).toBe(winner.repo.appUrl);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    await f.worker.scheduled({}, f.env);
    const emails = f.mails("is ready in Smithers");
    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain(winner.repo.appUrl);
    expect((await f.call({ repo: "owner/repo", appUrl: winner.repo.appUrl }, "/complete", true)).status).toBe(200);
    expect(JSON.parse((await get("repo-ready:owner/repo"))!)).toEqual(ready);
  });
  test("KV readiness is a mirror, never an authority", async () => {
    const appUrl = "https://app.smithers.sh/repos/owner/repo";
    // An off-domain URL, a wrong shape, and corrupt JSON must not poison the committed record.
    for (const poison of [JSON.stringify({ appUrl: "https://evil.com/x", completedAt: "2026-01-01T00:00:00.000Z" }), JSON.stringify({ nope: true }), "{"]) {
      const f = fixture();
      await f.call({ repo: "owner/repo" });
      await f.env.BUGS.put("repo-ready:owner/repo", poison);
      const completed = await f.complete();
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({ repo: { status: "ready", appUrl } });
      expect(JSON.parse((await f.env.BUGS.get("repo-ready:owner/repo"))!)).toEqual({ appUrl, completedAt: new Date(1788500000000).toISOString() });
      expect(await (await f.call(undefined, "?repo=owner/repo")).json()).toMatchObject({ repo: { status: "ready", appUrl } });
      expect((await f.call({ repo: "owner/repo", appUrl: "https://evil.com/x" }, "/complete", true)).status).toBe(400);
      expect((await f.call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/other" }, "/complete", true)).status).toBe(409);
    }
  });
  test("notify repairs a lost or corrupt mirror from the committed record", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect((await f.confirm("one@example.com")).status).toBe(200);
    expect((await f.call({ repo: "owner/repo" }, "/notify", true)).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    const committed = await f.env.BUGS.get("repo-ready:owner/repo");
    for (const damage of [() => f.env.BUGS.put("repo-ready:owner/repo", "{"), () => f.env.BUGS.delete("repo-ready:owner/repo")]) {
      await damage();
      const notified = await f.call({ repo: "owner/repo" }, "/notify", true);
      expect(notified.status).toBe(200);
      expect(await notified.json()).toMatchObject({ repo: { status: "ready", appUrl: "https://app.smithers.sh/repos/owner/repo" }, delivery: "queued" });
      expect(await f.env.BUGS.get("repo-ready:owner/repo")).toBe(committed);
    }
    await f.worker.scheduled({}, f.env);
    const emails = f.mails("is ready in Smithers");
    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain("https://app.smithers.sh/repos/owner/repo");
  });
  test("a failed readiness mirror cannot let a retry publish a different URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect((await f.confirm("one@example.com")).status).toBe(200);
    const put = f.env.BUGS.put.bind(f.env.BUGS);
    f.env.BUGS.put = async (key, value, options) => {
      if (key.startsWith("repo-ready:")) throw new Error("KV unavailable");
      return put(key, value, options);
    };
    expect((await f.complete()).status).toBe(503);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    f.env.BUGS.put = put;
    expect((await f.call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/other" }, "/complete", true)).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    expect(JSON.parse((await f.env.BUGS.get("repo-ready:owner/repo"))!).appUrl).toBe("https://app.smithers.sh/repos/owner/repo");
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(1);
  });
  test("stale KV readiness cannot overwrite the durable publication", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    expect((await f.complete()).status).toBe(200);
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    const original = await get("repo-ready:owner/repo");
    f.env.BUGS.get = (key) => key === "repo-ready:owner/repo" ? Promise.resolve(null) : get(key);
    expect((await f.call({ repo: "OWNER/REPO", appUrl: "https://app.smithers.sh/other" }, "/complete", true)).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    expect(await (await f.call({ repo: "owner/repo" }, "/notify", true)).json()).toMatchObject({ repo: { status: "ready" } });
    expect(await get("repo-ready:owner/repo")).toBe(original);
    await f.call({ repo: "owner/another" });
    expect((await f.call({ repo: "owner/another", appUrl: "https://app.smithers.sh/another" }, "/complete", true)).status).toBe(200);
  });
  test("completion returns a queued receipt before any send, and the sweep delivers", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    await f.call({ repo: "owner/repo", email: "two@example.com" });
    await f.confirm("one@example.com");
    await f.confirm("two@example.com");
    const response = await f.complete();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repo: { name: "owner/repo", url: "https://github.com/owner/repo", status: "ready", appUrl: "https://app.smithers.sh/repos/owner/repo" },
      delivery: "queued",
    });
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBe("");
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0]).sort()).toEqual(["one@example.com", "two@example.com"]);
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBeNull();
    expect((await f.env.BUGS.list!({ prefix: "repo-notified:" })).keys).toHaveLength(2);
  });
  test("notify requeues a completed repository without sending", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    expect((await f.call({ repo: "owner/repo" }, "/notify", true)).status).toBe(409);
    await f.complete();
    await f.env.BUGS.put("repo-subscriber:owner/repo:late", "late@example.com");
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(1);
    await f.env.BUGS.put("repo-subscriber:owner/repo:later", "later@example.com");
    const requeued = await f.call({ repo: "owner/repo" }, "/notify", true);
    expect(await requeued.json()).toMatchObject({ repo: { status: "ready" }, delivery: "queued" });
    expect(f.mails("is ready in Smithers")).toHaveLength(1);
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBe("");
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0])).toEqual(["late@example.com", "later@example.com"]);
  });
  test("notifies all subscribers once and retries a provider failure without rolling back readiness", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    await f.call({ repo: "owner/repo", email: "two@example.com" });
    await f.confirm("one@example.com");
    await f.confirm("two@example.com");
    f.emailStatus(500);
    expect(await (await f.complete()).json()).toMatchObject({ repo: { status: "ready" }, delivery: "queued" });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try { await f.worker.scheduled({}, f.env); } finally { log.mockRestore(); }
    // A 500 is the provider's fault: the page stops at the first send and nobody is charged.
    expect((await f.env.BUGS.list!({ prefix: "repo-notification-failure:" })).keys).toHaveLength(0);
    expect(await (await f.call(undefined, "?repo=owner/repo")).json()).toMatchObject({ repo: { status: "ready" } });
    f.emailStatus(200);
    await f.worker.scheduled({}, f.env);
    const emails = f.calls.filter((call) => call.url.includes("resend") && String(call.init?.body).includes("is ready in Smithers"));
    expect(emails).toHaveLength(3);
    expect(emails[0]!.init!.headers).toEqual(emails[1]!.init!.headers);
    await f.complete();
    await f.worker.scheduled({}, f.env);
    expect(f.calls.filter((call) => call.url.includes("resend") && String(call.init?.body).includes("is ready in Smithers"))).toHaveLength(3);
  });
  test("a permanent rejection cannot starve later pages and reaches terminal state", async () => {
    const f = fixture();
    const ready = { appUrl: "https://app.smithers.sh/repos/owner/repo", completedAt: "2026-01-01T00:00:00.000Z" };
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify(ready));
    for (let i = 0; i < 51; i++) {
      await f.env.BUGS.put(`repo-subscriber:owner/repo:${String(i).padStart(3, "0")}`, `user${i}@example.com`);
    }
    f.recipientStatus((email) => email === "user0@example.com" ? 422 : 200);
    await f.worker.scheduled({}, f.env);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("50");
    await f.worker.scheduled({}, f.env);
    expect(await f.env.BUGS.get("repo-notified:repo-subscriber:owner/repo:050")).toBe(ready.completedAt);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("");
    for (let i = 0; i < 6; i++) await f.worker.scheduled({}, f.env);
    const emails = f.calls.filter((call) => call.url.includes("resend"));
    expect(emails).toHaveLength(53);
    expect(emails.filter((call) => JSON.parse(String(call.init?.body)).to[0] === "user0@example.com")).toHaveLength(3);
    expect((await f.env.BUGS.list!({ prefix: "repo-notified:" })).keys).toHaveLength(50);
    expect(JSON.parse((await f.env.BUGS.get("repo-notification-failure:repo-subscriber:owner/repo:000"))!)).toMatchObject({ attempts: 3, terminal: true });
  });
  test("a legacy plain-address subscriber is migrated and mailed a working unsubscribe link", async () => {
    const f = fixture();
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" }));
    await f.env.BUGS.put("repo-subscriber:owner/repo:legacy", "legacy@example.com");
    await f.worker.scheduled({}, f.env);
    const [mail] = f.mails("is ready in Smithers");
    expect(mail?.to).toEqual(["legacy@example.com"]);
    const cancel = /Unsubscribe: https:\/\/bug\.smithers\.sh\/api\/repo-requests\/cancel\?token=([0-9a-f]{32})$/.exec(mail!.text)?.[1];
    expect(cancel).toBeDefined();
    expect(JSON.parse((await f.env.BUGS.get("repo-subscriber:owner/repo:legacy"))!)).toEqual({ email: "legacy@example.com", cancel });
    expect((await f.press(`/cancel?token=${cancel}`)).status).toBe(200);
    expect(await f.env.BUGS.get("repo-subscriber:owner/repo:legacy")).toBeNull();
  });
  test("a transient failure is retried on the next sweep and receipted", async () => {
    const f = fixture();
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" }));
    await f.env.BUGS.put("repo-subscriber:owner/repo:one", "one@example.com");
    f.emailStatus(500);
    await f.worker.scheduled({}, f.env);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("");
    expect(await f.env.BUGS.get("repo-notified:repo-subscriber:owner/repo:one")).toBeNull();
    f.emailStatus(200);
    await f.worker.scheduled({}, f.env);
    await f.worker.scheduled({}, f.env);
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(2);
    expect(await f.env.BUGS.get("repo-notified:repo-subscriber:owner/repo:one")).toBe("2026-01-01T00:00:00.000Z");
  });
  test("a provider outage never charges a recipient and holds the page", async () => {
    const f = fixture();
    const ready = { appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" };
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify(ready));
    for (let i = 0; i < 51; i++) await f.env.BUGS.put(`repo-subscriber:owner/repo:${String(i).padStart(3, "0")}`, `user${i}@example.com`);
    await f.env.BUGS.put("repo-pending:owner/repo", "");
    f.emailError(new DOMException("The operation timed out.", "TimeoutError"));
    const log = spyOn(console, "error").mockImplementation(() => {});
    let logged: unknown[];
    try {
      await f.worker.scheduled({}, f.env);
      logged = log.mock.calls.map((args) => JSON.parse(String(args[0])));
    } finally { log.mockRestore(); }
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(1);
    expect((await f.env.BUGS.list!({ prefix: "repo-notification-failure:" })).keys).toHaveLength(0);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("");
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBe("");
    expect(logged).toContainEqual({ event: "repo_notification.unavailable", route: "scheduled", repo: "owner/repo", error: "The operation timed out." });
    f.emailError(undefined);
    for (let i = 0; i < 3; i++) await f.worker.scheduled({}, f.env);
    const recipients = f.mails("is ready in Smithers").map((mail) => mail.to[0]!);
    expect(new Set(recipients).size).toBe(51);
    expect(recipients).toHaveLength(52);
    expect((await f.env.BUGS.list!({ prefix: "repo-notified:" })).keys).toHaveLength(51);
  });
  test.each([[401, false], [403, false], [408, false], [409, false], [429, false], [500, false], [503, false], [400, true], [404, true], [422, true]])(
    "a provider answer of %i charges the recipient: %p", async (status, charged) => {
      const f = fixture();
      await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" }));
      await f.env.BUGS.put("repo-subscriber:owner/repo:one", "one@example.com");
      f.emailStatus(status);
      const log = spyOn(console, "error").mockImplementation(() => {});
      try { await f.worker.scheduled({}, f.env); } finally { log.mockRestore(); }
      expect(await f.env.BUGS.get("repo-notification-failure:repo-subscriber:owner/repo:one") !== null).toBe(charged);
    });
  test("three failed visits during an outage still deliver after recovery", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "fan@example.com" });
    await f.confirm("fan@example.com");
    await f.complete();
    f.emailStatus(503);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try { for (let i = 0; i < 3; i++) await f.worker.scheduled({}, f.env); } finally { log.mockRestore(); }
    expect((await f.env.BUGS.list!({ prefix: "repo-notification-failure:" })).keys).toHaveLength(0);
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBe("");
    f.emailStatus(200);
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(4);
    expect((await f.env.BUGS.list!({ prefix: "repo-notified:" })).keys).toHaveLength(1);
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBeNull();
  });
  test("a sweep starts no send after its budget and resumes the page next tick", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    await f.complete();
    for (const id of ["a", "b", "c"]) await f.env.BUGS.put(`repo-subscriber:owner/repo:${id}`, `${id}@example.com`);
    // Each send takes three minutes, so the third would start past the five-minute budget.
    f.recipientStatus(() => { f.advance(3 * 60_000); return 200; });
    const log = spyOn(console, "log").mockImplementation(() => {});
    let logged: unknown[];
    try {
      await f.worker.scheduled({}, f.env);
      logged = log.mock.calls.map((args) => JSON.parse(String(args[0])));
    } finally { log.mockRestore(); }
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0])).toEqual(["a@example.com", "b@example.com"]);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("");
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBe("");
    expect(logged).toContainEqual({ event: "repo_notification.swept", route: "scheduled", repo: "owner/repo", sent: 2, rejected: 0, pending: true, cut: "budget" });
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0])).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBeNull();
  });
  test("the sweep cursor does not skip repositories cut by the budget", async () => {
    const f = fixture();
    const ready = JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" });
    for (const name of ["a/first", "b/second", "z/third"]) {
      await f.env.BUGS.put(`repo-ready:${name}`, ready);
      await f.env.BUGS.put(`repo-subscriber:${name}:one`, `${name[0]}@example.com`);
    }
    // The first repository's send exhausts the budget before the second is visited.
    f.recipientStatus((email) => { if (email === "a@example.com") f.advance(6 * 60_000); return 200; });
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0])).toEqual(["a@example.com"]);
    expect(await f.env.BUGS.get("repo-notification-sweep") ?? "").toBe("");
    await f.worker.scheduled({}, f.env);
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0])).toEqual(["a@example.com", "b@example.com", "z@example.com"]);
  });
  test("drains every subscriber page and every repository page exactly once", async () => {
    const f = fixture();
    const ready = { appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" };
    const expected: string[] = [];
    for (const name of ["a/first", "m/middle", "z/last"]) {
      await f.env.BUGS.put(`repo-ready:${name}`, JSON.stringify(ready));
      // The middle repository spans two subscriber pages; three repositories span two scan pages.
      for (let i = 0; i < (name === "m/middle" ? 51 : 1); i++) {
        const email = `${name.replace("/", "-")}-${String(i).padStart(3, "0")}@example.com`;
        await f.env.BUGS.put(`repo-subscriber:${name}:${String(i).padStart(3, "0")}`, email);
        expected.push(email);
      }
    }
    for (let i = 0; i < 8; i++) await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0]!).sort()).toEqual(expected.sort());
    expect(await f.env.BUGS.get("repo-notification-sweep")).toBe("");
    for (const name of ["a/first", "m/middle", "z/last"]) expect(await f.env.BUGS.get(`repo-notification-cursor:${name}`)).toBe("");
    expect((await f.env.BUGS.list!({ prefix: "repo-pending:" })).keys).toHaveLength(0);
  });
  test("a rejection on a nonterminal page never skips the next page or a recipient", async () => {
    const f = fixture();
    const ready = { appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" };
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify(ready));
    const all = [...Array(51)].map((_, i) => `user${String(i).padStart(3, "0")}@example.com`);
    for (const [i, email] of all.entries()) await f.env.BUGS.put(`repo-subscriber:owner/repo:${String(i).padStart(3, "0")}`, email);
    let refuse = true;
    f.recipientStatus((email) => refuse && email === "user007@example.com" ? 422 : 200);
    await f.worker.scheduled({}, f.env);
    // The provider rejected user007 while the subscriber cursor was nonterminal, so the second
    // page is owed as well as the retry, and the repository stays queued.
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("50");
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).not.toBeNull();
    await f.worker.scheduled({}, f.env);
    expect(await f.env.BUGS.get("repo-notified:repo-subscriber:owner/repo:050")).toBe(ready.completedAt);
    refuse = false;
    for (let i = 0; i < 4; i++) await f.worker.scheduled({}, f.env);
    const recipients = f.mails("is ready in Smithers").map((mail) => mail.to[0]!);
    expect(recipients.filter((to) => to === "user007@example.com")).toHaveLength(2);
    expect([...new Set(recipients)].sort()).toEqual([...all].sort());
    expect((await f.env.BUGS.list!({ prefix: "repo-notified:" })).keys).toHaveLength(51);
    expect(await f.env.BUGS.get("repo-pending:owner/repo")).toBeNull();
  });
  test("a signup confirmed after completion is delivered on the next cron, not behind idle history", async () => {
    const f = fixture();
    await idleCompletedRepositories(f);
    await f.call({ repo: "owner/zz-target", email: "late@example.com" });
    expect((await f.call({ repo: "owner/zz-target", appUrl: "https://app.smithers.sh/repos/owner/zz-target" }, "/complete", true)).status).toBe(200);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    await f.confirm("late@example.com");
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0])).toEqual(["late@example.com"]);
  });
  test("a send that failed during an outage is retried on the next cron, not behind idle history", async () => {
    const f = fixture();
    await idleCompletedRepositories(f);
    await f.call({ repo: "owner/zz-target", email: "late@example.com" });
    await f.confirm("late@example.com");
    expect((await f.call({ repo: "owner/zz-target", appUrl: "https://app.smithers.sh/repos/owner/zz-target" }, "/complete", true)).status).toBe(200);
    f.emailStatus(500);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try { await f.worker.scheduled({}, f.env); } finally { log.mockRestore(); }
    expect(await f.env.BUGS.get("repo-pending:owner/zz-target")).toBe("");
    f.emailStatus(200);
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers").map((mail) => mail.to[0])).toEqual(["late@example.com", "late@example.com"]);
    expect((await f.env.BUGS.list!({ prefix: "repo-notified:repo-subscriber:owner/zz-target:" })).keys).toHaveLength(1);
  });
  test.each(["{", "null", "[]", "{}", '{"appUrl":7,"completedAt":true}', '{"appUrl":"https://evil.com","completedAt":"2026-01-01"}', '{"appUrl":"https://app.smithers.sh/repo","completedAt":"invalid"}'])("skips and logs corrupt readiness %s while advancing the sweep", async (corrupt) => {
    const f = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const ready = JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" });
      await f.env.BUGS.put("repo-ready:a/bad", corrupt);
      await f.env.BUGS.put("repo-subscriber:a/bad:one", "bad@example.com");
      for (const name of ["b/good", "z/good"]) {
        await f.env.BUGS.put(`repo-ready:${name}`, ready);
        await f.env.BUGS.put(`repo-subscriber:${name}:one`, `${name[0]}@example.com`);
      }
      await f.worker.scheduled({}, f.env);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls.map((args) => JSON.parse(String(args[0]))))
        .toContainEqual(expect.objectContaining({ event: "repo_notification.failed", route: "scheduled", repo: "a/bad" }));
      expect(await f.env.BUGS.get("repo-notified:repo-subscriber:b/good:one")).not.toBeNull();
      expect(await f.env.BUGS.get("repo-notification-sweep")).toBe("2");
      await f.worker.scheduled({}, f.env);
      expect(await f.env.BUGS.get("repo-notified:repo-subscriber:z/good:one")).not.toBeNull();
      expect(await f.env.BUGS.get("repo-notification-sweep")).toBe("");
      expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(2);
    } finally { log.mockRestore(); }
  });
  test.each(["readiness", "subscriber", "cursor"])("isolates a %s KV failure and retries after recovery", async (site) => {
    const f = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {});
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    const put = f.env.BUGS.put.bind(f.env.BUGS);
    try {
      for (const name of ["a/bad", "b/good", "z/good"]) {
        await put(`repo-ready:${name}`, JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" }));
        await put(`repo-subscriber:${name}:one`, `${name[0]}@example.com`);
      }
      f.env.BUGS.get = async (key) => {
        if (key === (site === "readiness" ? "repo-ready:a/bad" : site === "subscriber" ? "repo-subscriber:a/bad:one" : "")) throw new Error("KV offline");
        return get(key);
      };
      f.env.BUGS.put = async (key, value, options) => {
        if (site === "cursor" && key === "repo-notification-cursor:a/bad") throw new Error("KV offline");
        return put(key, value, options);
      };
      await f.worker.scheduled({}, f.env);
      expect(log.mock.calls.some((args) => String(args[0]).includes("a/bad"))).toBe(true);
      expect(await get("repo-notified:repo-subscriber:b/good:one")).not.toBeNull();
      expect(await get("repo-notification-sweep")).toBe("2");
      f.env.BUGS.get = get;
      f.env.BUGS.put = put;
      await f.worker.scheduled({}, f.env);
      await f.worker.scheduled({}, f.env);
      expect(await get("repo-notified:repo-subscriber:a/bad:one")).not.toBeNull();
      expect(await get("repo-notified:repo-subscriber:z/good:one")).not.toBeNull();
      expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(3);
    } finally { log.mockRestore(); }
  });
  test("without email configuration no consent can be obtained and nothing is delivered", async () => {
    const f = fixture();
    delete f.env.RESEND_API_KEY;
    const submitted = await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect(await submitted.json()).toMatchObject({ subscribed: false, confirmation: "email_not_configured" });
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(0);
    expect(await (await f.complete()).json()).toMatchObject({ repo: { status: "ready" }, delivery: "email_not_configured" });
    // Configuring the provider later cannot mail the unconfirmed address; the sweep skips it.
    f.env.RESEND_API_KEY = "test-key";
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    // A fresh subscribe-confirm-complete round on another repo delivers normally.
    await f.call({ repo: "owner/other", email: "one@example.com" });
    expect((await f.confirm("one@example.com")).status).toBe(200);
    await f.call({ repo: "owner/other", appUrl: "https://app.smithers.sh/other" }, "/complete", true);
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(1);
  });
  test("scheduled sweep picks up signups arriving after completion", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    await f.complete();
    await f.env.BUGS.put("repo-subscriber:owner/repo:late-signup", "late@example.com");
    await f.worker.scheduled({}, f.env);
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(1);
  });
  test("delivers to an address only after the recipient confirms", async () => {
    const f = fixture();
    const submitted = await f.call({ repo: "owner/repo", email: "fan@example.com" });
    expect(await submitted.json()).toMatchObject({ subscribed: true });
    // A submission creates one pending token and one confirmation email, never a subscriber.
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(1);
    const confirmation = f.mails("Confirm your Smithers notification for owner/repo");
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]!.to).toEqual(["fan@example.com"]);
    expect(confirmation[0]!.text).toContain("cancel?token=");
    // Completion and the scheduled sweep both skip the unconfirmed address.
    await f.complete();
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    const confirmed = await f.confirm("fan@example.com");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ repo: "owner/repo", subscribed: true });
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
    await f.worker.scheduled({}, f.env);
    const ready = f.mails("is ready in Smithers");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.to).toEqual(["fan@example.com"]);
    expect(ready[0]!.text).toContain("Unsubscribe: https://bug.smithers.sh/api/repo-requests/cancel?token=");
  });
  test("opening an emailed confirm or cancel link writes nothing, so mail scanners that prefetch it cannot act for the recipient", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "fan@example.com" });
    const token = f.confirmTokenFor("fan@example.com");
    const before = f.env.BUGS as ReturnType<typeof memoryKv>;
    const snapshot = [...before.dump()];
    for (const route of [`/confirm?token=${token}`, `/cancel?token=${token}`]) {
      const opened = await f.call(undefined, route);
      expect(opened.status).toBe(200);
      expect(opened.headers.get("content-type")).toContain("text/html");
      const page = await opened.text();
      expect(page).toContain(`<form method="post" action="/api/repo-requests${route}">`);
      expect([...before.dump()]).toEqual(snapshot);
    }
    expect((await f.call(undefined, "/confirm?token=oops")).status).toBe(400);
    expect((await f.call(undefined, "/cancel?token=<script>")).status).toBe(400);
    // Only the recipient's POST from that page acts on the token.
    expect((await f.confirm("fan@example.com")).status).toBe(200);
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
  });
  test("confirmation tokens are validated, single-use, and expire after 24 hours", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "fan@example.com" });
    const token = f.confirmTokenFor("fan@example.com");
    expect((await f.press("/confirm?token=oops")).status).toBe(400);
    expect((await f.press(`/confirm?token=${"0".repeat(32)}`)).status).toBe(410);
    expect((await f.confirm("fan@example.com")).status).toBe(200);
    expect((await f.press(`/confirm?token=${token}`)).status).toBe(410);
    await f.call({ repo: "owner/repo", email: "late@example.com" });
    const lateToken = f.confirmTokenFor("late@example.com");
    f.setNow(1788500000000 + 25 * 3_600_000);
    const expired = await f.press(`/confirm?token=${lateToken}`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "This confirmation link has expired." });
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
  });
  test("cancellation removes pending and confirmed subscriptions", async () => {
    const f = fixture();
    // Pending: the cancel link in the confirmation email kills the token before any delivery.
    await f.call({ repo: "owner/repo", email: "pending@example.com" });
    const pendingToken = /cancel\?token=([0-9a-f]{32})/.exec(f.mails("Confirm your Smithers notification").find((mail) => mail.to[0] === "pending@example.com")!.text)![1]!;
    expect(await (await f.press(`/cancel?token=${pendingToken}`)).json()).toEqual({ cancelled: true });
    expect((await f.press(`/confirm?token=${pendingToken}`)).status).toBe(410);
    await f.complete();
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    // Confirmed: the cancel URL returned at confirmation removes the subscriber record.
    await f.call({ repo: "owner/other", email: "confirmed@example.com" });
    const confirmed = await (await f.confirm("confirmed@example.com")).json();
    const cancelToken = /cancel\?token=([0-9a-f]{32})/.exec(confirmed.cancel)![1]!;
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
    expect(await (await f.press(`/cancel?token=${cancelToken}`)).json()).toEqual({ cancelled: true });
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
    expect((await f.press(`/cancel?token=${cancelToken}`)).status).toBe(404);
    await f.call({ repo: "owner/other", appUrl: "https://app.smithers.sh/other" }, "/complete", true);
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
  });
  test("confirmation sends are throttled per recipient across repositories", async () => {
    const f = fixture();
    for (const name of ["owner/r1", "owner/r2", "owner/r3", "owner/r4"]) {
      await f.env.BUGS.put(`repo-request:${name}`, JSON.stringify({ name, url: `https://github.com/${name}` }));
    }
    for (const name of ["owner/r1", "owner/r2", "owner/r3"]) {
      expect(await (await f.call({ repo: name, email: "fan@example.com" })).json()).toMatchObject({ subscribed: true });
    }
    expect(await (await f.call({ repo: "owner/r4", email: "fan@example.com" })).json()).toMatchObject({ subscribed: false, confirmation: "rate_limited" });
    expect(f.mails("Confirm your Smithers notification")).toHaveLength(3);
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(3);
  });
  test("a failed confirmation send reports it and keeps the pending record; nothing is deliverable", async () => {
    const f = fixture();
    f.emailStatus(500);
    await logsOf(async () => {
      expect(await (await f.call({ repo: "owner/repo", email: "fan@example.com" })).json()).toMatchObject({ subscribed: false, confirmation: "send_failed" });
    });
    f.emailStatus(200);
    await f.complete();
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
  });
  test("a confirmation token that cannot be stored is never mailed, and the nomination still counts", async () => {
    const f = fixture();
    failKv(f, "put", "repo-confirm:");
    await logsOf(async () => {
      const response = await f.call({ repo: "owner/repo", email: "fan@example.com" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ repo: { nominations: 1 }, subscribed: false, confirmation: "send_failed" });
    });
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(0);
    expect(await f.env.BUGS.get("repo-request:owner/repo")).not.toBeNull();
  });
  test("a send that times out may still arrive, so its link confirms", async () => {
    const f = fixture();
    f.emailError(new DOMException("The operation timed out.", "TimeoutError"));
    await logsOf(async () => {
      expect(await (await f.call({ repo: "owner/repo", email: "fan@example.com" })).json()).toMatchObject({ subscribed: false, confirmation: "send_failed" });
    });
    f.emailError(undefined);
    const confirmed = await f.confirm("fan@example.com");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ repo: "owner/repo", subscribed: true });
  });
  test("failed confirmation sends spend the recipient's hourly attempts", async () => {
    const f = fixture();
    f.emailStatus(503);
    await logsOf(async () => {
      for (let i = 0; i < 3; i++) {
        expect(await (await f.call({ repo: "owner/repo", email: "fan@example.com" })).json()).toMatchObject({ subscribed: false, confirmation: "send_failed" });
      }
    });
    expect(await (await f.call({ repo: "owner/repo", email: "fan@example.com" })).json()).toMatchObject({ subscribed: false, confirmation: "rate_limited" });
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(3);
  });
  test("a storage failure while confirming answers 503 and the same link confirms on retry", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "fan@example.com" });
    const token = f.confirmTokenFor("fan@example.com");
    failKv(f, "put", "repo-subscriber:", 1);
    await logsOf(async () => {
      expect((await f.press(`/confirm?token=${token}`)).status).toBe(503);
    });
    const retried = await f.press(`/confirm?token=${token}`);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ repo: "owner/repo", subscribed: true });
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(0);
  });
  test("a storage failure while cancelling answers 503 and the same link cancels on retry", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "fan@example.com" });
    const cancelToken = /cancel\?token=([0-9a-f]{32})/.exec((await (await f.confirm("fan@example.com")).json()).cancel)![1]!;
    failKv(f, "delete", "repo-subscriber:", 1);
    await logsOf(async () => {
      expect((await f.press(`/cancel?token=${cancelToken}`)).status).toBe(503);
    });
    expect(await (await f.press(`/cancel?token=${cancelToken}`)).json()).toEqual({ cancelled: true });
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
    expect((await f.press(`/cancel?token=${cancelToken}`)).status).toBe(404);
  });
  test("a repeated nomination of the same repo increments its count", async () => {
    const f = fixture();
    expect(await (await f.call({ repo: "owner/repo" })).json()).toMatchObject({ repo: { name: "owner/repo", nominations: 1 } });
    expect(await (await f.call({ repo: "https://github.com/Owner/Repo.git", email: "me@example.com" })).json()).toMatchObject({ repo: { nominations: 2 } });
    expect(await (await f.call(undefined, "?repo=OWNER/repo")).json()).toMatchObject({ repo: { name: "owner/repo", status: "smithering", nominations: 2 } });
    expect((await f.call(undefined, "?repo=owner/never")).status).toBe(404);
    expect((await f.call(undefined, "?repo=https://evil.com/owner/repo")).status).toBe(400);
  });
  test("rejected nominations do not count", async () => {
    const f = fixture();
    expect((await f.call({ repo: "owner/repo", email: "oops" })).status).toBe(400);
    f.github({ private: true, license: { spdx_id: "MIT" } });
    expect((await f.call({ repo: "owner/private" })).status).toBe(400);
    expect((await f.env.BUGS.list!({ prefix: "repo-nominations:" })).keys).toHaveLength(0);
  });
  test("counts are independent per repo and the public list ranks by count, capped at 20", async () => {
    const f = fixture();
    // Records beyond any fixed scan window: the leaderboard must still rank a late-sorting name first.
    for (let i = 0; i < 250; i++) await f.env.BUGS.put(`repo-request:owner/r${String(i).padStart(3, "0")}`, JSON.stringify({ name: `owner/r${i}`, url: `https://github.com/owner/r${i}` }));
    for (let i = 0; i < 22; i++) await f.call({ repo: `owner/r${i}` });
    await f.call({ repo: "owner/second" });
    await f.call({ repo: "owner/zzz" });
    await f.call({ repo: "owner/zzz" });
    await f.call({ repo: "owner/second" });
    await f.call({ repo: "owner/zzz" });
    const response = await f.call();
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const { repos } = await response.json();
    expect(repos).toHaveLength(20);
    expect(repos.slice(0, 3)).toMatchObject([
      { name: "owner/zzz", url: "https://github.com/owner/zzz", status: "smithering", nominations: 3 },
      { name: "owner/second", nominations: 2 },
      { name: "owner/r0", nominations: 1 },
    ]);
    expect(repos.slice(2).every((repo: { nominations: number }) => repo.nominations === 1)).toBe(true);
    expect(JSON.stringify(repos)).not.toContain("example.com");
    // Listing reads the materialized leaderboard only (the throttle lives in a
    // Durable Object): no per-entry readiness lookups and never the whole catalog.
    let reads = 0;
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    f.env.BUGS.get = async (key: string) => { reads++; return get(key); };
    f.env.BUGS.list = async () => { throw new Error("list must not be used"); };
    expect((await f.call()).status).toBe(200);
    expect(reads).toBe(1);
  });
  test("completion rebuilds the materialized list so readiness costs no extra read", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    await f.call({ repo: "owner/other" });
    expect((await f.complete()).status).toBe(200);
    let reads = 0;
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    f.env.BUGS.get = async (key: string) => { reads++; return get(key); };
    const { repos } = await (await f.call()).json();
    expect(reads).toBe(1);
    expect(repos).toMatchObject([
      { name: "owner/other", status: "smithering", appUrl: null, nominations: 1 },
      { name: "owner/repo", status: "ready", appUrl: "https://app.smithers.sh/repos/owner/repo", nominations: 1 },
    ]);
    // A later nomination keeps the published readiness in the rebuilt entry.
    expect(await (await f.call({ repo: "owner/repo" })).json()).toMatchObject({ repo: { status: "ready" } });
    expect((await (await f.call()).json()).repos[0]).toMatchObject({ name: "owner/repo", status: "ready", appUrl: "https://app.smithers.sh/repos/owner/repo", nominations: 2 });
  });
  test("leaderboard entries written before readiness was materialized still resolve it", async () => {
    const f = fixture();
    await f.env.BUGS.put("repo-request:owner/old", JSON.stringify({ name: "owner/old", url: "https://github.com/owner/old" }));
    await f.env.BUGS.put("repo-nominations:owner/old", "4");
    await f.env.BUGS.put("repo-nominations-top", JSON.stringify([{ name: "owner/old", count: 4 }]));
    await f.env.BUGS.put("repo-ready:owner/old", JSON.stringify({ appUrl: "https://app.smithers.sh/repos/owner/old", completedAt: "2026-09-01T00:00:00Z" }));
    expect((await (await f.call()).json()).repos).toMatchObject([{ name: "owner/old", status: "ready", appUrl: "https://app.smithers.sh/repos/owner/old", nominations: 4 }]);
  });
  test("throttles public catalog reads per IP", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) expect((await f.call()).status).toBe(200);
    const limited = await f.call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect((await f.call(undefined, "?repo=owner/repo")).status).toBe(429);
    expect((await f.call(undefined, "", true, "203.0.113.2")).status).toBe(200);
    f.setNow(1788500000000 + 3_600_000);
    expect((await f.call()).status).toBe(200);
  });
  test("limits payloads and reports storage failures", async () => {
    const f = fixture();
    expect((await f.call({ repo: "x".repeat(5000) })).status).toBe(413);
    f.env.BUGS.get = async () => { throw new Error("offline"); };
    expect((await f.call()).status).toBe(503);
  });
});
