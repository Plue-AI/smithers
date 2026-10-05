import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { freePort, githubBases, layerSnapshots, modelBase, proxyGuard, setupLine, walkHome, walkOptions } from "./run-local-no-github"
import { githubRoute, isManifest } from "../e2e/local/github-route"
import type { BrowserContext, Route } from "@playwright/test"

describe("local no-GitHub orchestration", () => {
  test("only the three GitHub bases, the model origin and the refusing proxy pair are injected", () => {
    expect({ ...githubBases("http://127.0.0.1:9"), ...modelBase("http://127.0.0.1:8"), ...proxyGuard }).toEqual({
      SMITHERS_GITHUB_APP_API_BASE_URL: "http://127.0.0.1:9", SMITHERS_AUTH_GITHUB_API_BASE_URL: "http://127.0.0.1:9", SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL: "http://127.0.0.1:9",
      SMITHERS_MODEL_PROVIDER_ORIGIN: "http://127.0.0.1:8",
      HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost,::1"
    })
  })
  test("flags: real models and a pinned bundle are opt-in; anything else is refused", () => {
    expect(walkOptions([], {})).toEqual({ browser: true, keep: false, realModels: false, bundle: undefined })
    expect(walkOptions(["--no-browser", "--real-models", "--keep", "--real-models"], { SMITHERS_PROOF_BUNDLE: " /b/.native " }))
      .toEqual({ browser: false, keep: true, realModels: true, bundle: "/b/.native" })
    expect(walkOptions(["--no-browser"], { SMITHERS_PROOF_BUNDLE: "  " }).bundle).toBeUndefined()
    for (const argv of [["--real"], ["--keep", "x"], ["--REAL-MODELS"], [""]]) expect(() => walkOptions(argv, {})).toThrow("Usage")
    expect(() => walkOptions([], { SMITHERS_PROOF_BUNDLE: "relative/.native" })).toThrow("absolute")
  })
  test("flags: any order and repetition of known flags parses the same (property)", () => {
    const known = ["--no-browser", "--keep", "--real-models"]
    for (let seed = 1; seed <= 500; seed++) {
      let x = seed
      const next = () => (x = (x * 1103515245 + 12345) % 2147483648)
      const argv = Array.from({ length: next() % 7 }, () => known[next() % known.length]!)
      expect(walkOptions(argv, {})).toEqual({ browser: !argv.includes("--no-browser"), keep: argv.includes("--keep"), realModels: argv.includes("--real-models"), bundle: undefined })
      expect(() => walkOptions([...argv, `--x${seed}`], {})).toThrow("Usage")
    }
  })
  test("handoff parser refuses malformed or broadened receipts", () => {
    expect(setupLine('ordinary log')).toBeUndefined()
    expect(setupLine('{"setup_urls":["http://localhost:4000/setup?token=one"]}')).toBe("http://localhost:4000/setup?token=one")
    for (const line of ['{"setup_urls":[]}', '{"setup_urls":[1]}', '{"setup_urls":["file:///etc/passwd"]}', '{"setup_urls":["http://localhost"],"extra":true}', '{"setup_urls":["http://localhost"]}\n', '{"setup_urls":']) expect(() => setupLine(line)).toThrow()
  })
  test("each run's home is a fresh 0700 directory in the account's caches", () => {
    const account = mkdtempSync(join(tmpdir(), "walk-account-"))
    try {
      const [first, second] = [walkHome(account), walkHome(account)]
      expect(first).not.toBe(second)
      for (const home of [first, second]) {
        expect(dirname(home)).toBe(join(account, "Library/Caches"))
        expect(lstatSync(home).mode & 0o777).toBe(0o700)
      }
    } finally { rmSync(account, { recursive: true, force: true }) }
  })
  // The bundle is macOS-only: there the backend approves this data root.
  test.skipIf(process.platform !== "darwin")("the real home has no group- or world-writable ancestor", () => {
    const home = walkHome()
    try {
      for (let at = realpathSync(home); ; at = dirname(at)) {
        const info = lstatSync(at)
        expect({ at, owner: info.uid === 0 || info.uid === process.getuid!(), writable: (info.mode & 0o022) !== 0 }).toEqual({ at, owner: true, writable: false })
        if (at === "/") break
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  test("stop removes only the layer snapshots this install's records name", () => {
    const records = mkdtempSync(join(tmpdir(), "walk-layers-"))
    try {
      expect(layerSnapshots(join(records, "missing"))).toEqual([])
      mkdirSync(join(records, "nested.json"))
      const record = (file: string, body: string) => writeFileSync(join(records, file), body)
      record("tc.json", JSON.stringify({ kind: "toolchain", name: "smthrs-tc-3a2e5eb3-b537c2dcb99200913df8" }))
      record("dp.json", JSON.stringify({ kind: "dependencies", name: "smthrs-dp-3a2e5eb3-9b4b330307eeaf5fb809" }))
      record("option.json", JSON.stringify({ name: "--all" }))
      record("other.json", JSON.stringify({ name: "smthrs-env-62079da5-9045cf9f7956-055b2dec5652acfe7e19" }))
      record("number.json", JSON.stringify({ name: 7 }))
      record("broken.json", "{")
      record("notes.txt", JSON.stringify({ name: "smthrs-tc-3a2e5eb3-b537c2dcb99200913df9" }))
      expect(layerSnapshots(records).sort()).toEqual(["smthrs-dp-3a2e5eb3-9b4b330307eeaf5fb809", "smthrs-tc-3a2e5eb3-b537c2dcb99200913df8"])
    } finally { rmSync(records, { recursive: true, force: true }) }
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
