import { describe, expect, test } from "bun:test";
import { BUG_REPORTS_PER_HOUR, clientAddress, PUBLIC_READS_PER_HOUR, RATE_LIMIT_PER_HOUR } from "../src/checkRateLimit.ts";
import type { BugWorkerEnv } from "../src/env.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits, memoryRepoCompletions } from "./helpers/memoryDurableObjects.ts";

const worker = createBugWorker({ now: () => 1788500000000 });
const env = (): BugWorkerEnv & { BUGS: ReturnType<typeof memoryKv> } => ({
  BUGS: memoryKv(), REPO_COMPLETIONS: memoryRepoCompletions(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: "admin",
});
const report = (headers: Record<string, string>) => new Request("https://bug.smithers.sh/api/bugs", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ summary: "flood" }),
});
const statuses = async (responses: Promise<Response>[]) => (await Promise.all(responses)).map((response) => response.status);
const stored = (e: ReturnType<typeof env>) => [...e.BUGS.dump().keys()].filter((key) => key.startsWith("bug:")).length;

describe("rate limits", () => {
  test("a concurrent burst from one client stores exactly the hourly budget", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: 3 * RATE_LIMIT_PER_HOUR }, () => worker.fetch(report({ "cf-connecting-ip": "203.0.113.5" }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(RATE_LIMIT_PER_HOUR);
    expect(codes.filter((code) => code === 429)).toHaveLength(2 * RATE_LIMIT_PER_HOUR);
    expect(stored(e)).toBe(RATE_LIMIT_PER_HOUR);
  });

  test("rotating IPv6 addresses inside one /64 shares one budget", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: 2 * RATE_LIMIT_PER_HOUR }, (_, i) =>
      worker.fetch(report({ "cf-connecting-ip": `2001:db8:1:2:${i.toString(16)}::1` }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(RATE_LIMIT_PER_HOUR);
  });

  test("x-forwarded-for never chooses the bucket", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: 2 * RATE_LIMIT_PER_HOUR }, (_, i) =>
      worker.fetch(report({ "x-forwarded-for": `198.51.100.${i}` }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(RATE_LIMIT_PER_HOUR);
  });

  test("distinct clients together store at most the all-clients hourly cap", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: BUG_REPORTS_PER_HOUR + 50 }, (_, i) =>
      worker.fetch(report({ "cf-connecting-ip": `10.${i >> 8}.${i & 255}.1` }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(BUG_REPORTS_PER_HOUR);
    expect(stored(e)).toBe(BUG_REPORTS_PER_HOUR);
  });

  test("an operator files while a flood holds the all-clients cap, and the refusal is logged", async () => {
    const e = env();
    const flood = await statuses(Array.from({ length: BUG_REPORTS_PER_HOUR }, (_, i) =>
      worker.fetch(report({ "cf-connecting-ip": `10.${i >> 8}.${i & 255}.1` }), e)));
    expect(flood.every((code) => code === 201)).toBe(true);
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => void logged.push(line);
    try {
      expect((await worker.fetch(report({ "cf-connecting-ip": "198.51.100.9" }), e)).status).toBe(429);
      expect((await worker.fetch(report({ "cf-connecting-ip": "198.51.100.9", "x-bug-admin": "admin" }), e)).status).toBe(201);
      expect((await worker.fetch(report({ "cf-connecting-ip": "198.51.100.9", "x-bug-admin": "wrong" }), e)).status).toBe(429);
    } finally {
      console.error = original;
    }
    expect(logged.map((line) => JSON.parse(line).event)).toEqual(["bug_report.global_limit", "bug_report.global_limit"]);
    expect(stored(e)).toBe(BUG_REPORTS_PER_HOUR + 1);
  });

  test("the all-clients cap takes at least 100 per-client budgets to spend", () => {
    expect(BUG_REPORTS_PER_HOUR / RATE_LIMIT_PER_HOUR).toBeGreaterThanOrEqual(100);
    expect(BUG_REPORTS_PER_HOUR * 256 * 1024).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  test("anonymous claim reads share the public-read budget", async () => {
    const e = env();
    const read = () => worker.fetch(new Request("https://bug.smithers.sh/api/repo-claims?repo=owner/repo", { headers: { "cf-connecting-ip": "203.0.113.8" } }), e);
    const codes = await statuses(Array.from({ length: PUBLIC_READS_PER_HOUR + 5 }, read));
    expect(codes.filter((code) => code === 404)).toHaveLength(PUBLIC_READS_PER_HOUR);
    expect(codes.filter((code) => code === 429)).toHaveLength(5);
  });

  test("a client is its IPv4 address or its IPv6 /64", () => {
    const at = (ip?: string) => clientAddress(new Request("https://x/", { headers: ip ? { "cf-connecting-ip": ip } : {} }));
    expect(at("203.0.113.5")).toBe("203.0.113.5");
    expect(at("2001:DB8:0001:0002:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(at("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(at("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(at("::1")).toBe("0:0:0:0::/64");
    expect(at("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(at()).toBe("unknown");
  });
});
