import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalPublishUrl = process.env.SMITHERS_REVIEW_PUBLISH_URL;
const originalPublishToken = process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalPublishUrl === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
  else process.env.SMITHERS_REVIEW_PUBLISH_URL = originalPublishUrl;
  if (originalPublishToken === undefined) delete process.env.SMITHERS_REVIEW_PUBLISH_TOKEN;
  else process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = originalPublishToken;
  globalThis.fetch = originalFetch;
});

describe("publishWalkthrough", () => {
  test("requires an explicit publish URL instead of using a default host", async () => {
    const { publishWalkthrough } = await import("../src/cli/publishWalkthrough");
    const dir = mkdtempSync(join(tmpdir(), "review-publish-"));
    const homeDir = join(dir, "home");
    const htmlPath = join(dir, "walkthrough.html");
    writeFileSync(htmlPath, "<!doctype html><html><body>walkthrough</body></html>");
    delete process.env.SMITHERS_REVIEW_PUBLISH_URL;
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "test-token";

    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(JSON.stringify({ url: "https://example.test/w/abc" }), { status: 201 }));
    }) as unknown as typeof fetch;

    try {
      await expect(publishWalkthrough(htmlPath, { homeDir })).rejects.toThrow("no publish URL");
      expect(fetchCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never sends the bearer token to a plain-http remote URL", async () => {
    const { publishWalkthrough } = await import("../src/cli/publishWalkthrough");
    const dir = mkdtempSync(join(tmpdir(), "review-publish-"));
    const htmlPath = join(dir, "walkthrough.html");
    writeFileSync(htmlPath, "<!doctype html><html><body>walkthrough</body></html>");
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "test-token";

    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response(JSON.stringify({ url: "https://example.test/w/abc" }), { status: 201 }));
    }) as unknown as typeof fetch;

    try {
      for (const url of ["http://share.test", "ftp://share.test", "not a url", "http://127.0.0.1.evil.test"]) {
        process.env.SMITHERS_REVIEW_PUBLISH_URL = url;
        await expect(publishWalkthrough(htmlPath, { homeDir: dir })).rejects.toThrow(/publish URL/);
      }
      expect(fetchCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts plain http only for a loopback host", async () => {
    const { publishWalkthrough } = await import("../src/cli/publishWalkthrough");
    const dir = mkdtempSync(join(tmpdir(), "review-publish-"));
    const htmlPath = join(dir, "walkthrough.html");
    writeFileSync(htmlPath, "<!doctype html><html><body>walkthrough</body></html>");
    process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "test-token";
    const requested: Array<string> = [];
    globalThis.fetch = ((input: string) => {
      requested.push(input);
      return Promise.resolve(new Response(JSON.stringify({ url: "https://example.test/w/abc" }), { status: 201 }));
    }) as unknown as typeof fetch;

    try {
      for (const url of ["http://localhost:8787", "http://127.0.0.1:9", "http://[::1]:9"]) {
        process.env.SMITHERS_REVIEW_PUBLISH_URL = url;
        await publishWalkthrough(htmlPath, { homeDir: dir });
      }
      expect(requested).toEqual([
        "http://localhost:8787/api/walkthroughs",
        "http://127.0.0.1:9/api/walkthroughs",
        "http://[::1]:9/api/walkthroughs",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
