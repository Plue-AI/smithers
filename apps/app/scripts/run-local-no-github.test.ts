import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { freePort, githubBases, proxyGuard, setupLine } from "./run-local-no-github"
import { githubRoute, isManifest } from "../e2e/local/github-route"
import type { BrowserContext, Route } from "@playwright/test"

describe("local no-GitHub orchestration", () => {
  test("only the three existing bases and refusing proxy pair are injected", () => {
    expect({ ...githubBases("http://127.0.0.1:9"), ...proxyGuard }).toEqual({
      SMITHERS_GITHUB_APP_API_BASE_URL: "http://127.0.0.1:9", SMITHERS_AUTH_GITHUB_API_BASE_URL: "http://127.0.0.1:9", SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost,::1"
    })
  })
  test("handoff parser refuses malformed or broadened receipts", () => {
    expect(setupLine('ordinary log')).toBeUndefined()
    expect(setupLine('{"setup_urls":["http://localhost:4000/setup?token=one"]}')).toBe("http://localhost:4000/setup?token=one")
    for (const line of ['{"setup_urls":[]}', '{"setup_urls":[1]}', '{"setup_urls":["file:///etc/passwd"]}', '{"setup_urls":["http://localhost"],"extra":true}', '{"setup_urls":["http://localhost"]}\n', '{"setup_urls":']) expect(() => setupLine(line)).toThrow()
  })
  test("port preflight refuses an occupied listener", async () => {
    const server = createServer()
    await new Promise<void>(ok => server.listen(0, ok))
    const addr = server.address() as { port: number }
    try { await expect(freePort(addr.port)).rejects.toThrow("must be free") }
    finally { await new Promise<void>(ok => server.close(() => ok())) }
    await freePort(addr.port)
  })
  test("route carries only the manifest POST and aborts other provider requests", async () => {
    let handler!: (route: Route) => Promise<void>
    const context = { route: async (_pattern: RegExp, callback: typeof handler) => { handler = callback } } as unknown as BrowserContext
    const traffic = await githubRoute(context, "http://127.0.0.1:42")
    for (const [method, url, allowed] of [
      ["POST", "https://github.com/settings/apps/new", true],
      ["POST", "https://github.com/organizations/local/settings/apps/new", true],
      ["GET", "https://github.com/settings/apps/new", false],
      ["POST", "https://api.github.com/settings/apps/new", false],
      ["POST", "https://github.com/settings/apps/new/extra", false],
      ["POST", "http://github.com/settings/apps/new", false],
      ["GET", "https://raw.githubusercontent.com/local/demo/main/file", false]
    ] as const) {
      expect(isManifest(method, url)).toBe(allowed)
      let action = ""
      await handler({ request: () => ({ method: () => method, url: () => url }),
        fetch: async ({ url: target, maxRedirects }: { url: string; maxRedirects: number }) => { expect(target).toBe("http://127.0.0.1:42" + new URL(url).pathname); expect(maxRedirects).toBe(0); return {} },
        fulfill: async () => { action = "fulfill" }, abort: async () => { action = "abort" }
      } as unknown as Route)
      expect(action).toBe(allowed ? "fulfill" : "abort")
    }
    expect(traffic.routed).toHaveLength(2); expect(traffic.aborted).toHaveLength(5)
  })
})
