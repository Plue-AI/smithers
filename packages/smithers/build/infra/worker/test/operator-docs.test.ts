import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { compileFunction, runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

// Load the Node host API during suite setup without adding its source graph
// to this test project's Cloudflare ambient types. These are real constructors.
const { Smithers } = await import(import.meta.resolve("@smthrs/targets"))

const evaluateWorkspace = (example: string): unknown => {
  // The real declaration constructors validate inert data without I/O.
  // Compile in this realm so RemoteCache's plain-object check sees native
  // objects, just as it does when the workspace loader imports the example.
  // A standalone RemoteCache export must not count as Workspace.cache.remote.
  const source = example.replace(/^import .*$/gm, "").replace(/^export /gm, "")
  const evaluate = compileFunction(
    `${source}\n; return typeof Workspace === "undefined" ? undefined : Workspace`,
    ["S", "Smithers"]
  )
  // Bound execution without moving the compiled function's objects or the
  // real constructors into the VM context's realm.
  return runInNewContext("evaluate(Smithers, Smithers)", { evaluate, Smithers }, { timeout: 1_000 })
}

describe("operator documentation", () => {
  it("connects the rollout's split credentials to the workspace cache", async () => {
    const guide = await readFile(new URL("../../CACHE-TRUST.md", import.meta.url), "utf8")
    const example = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1]!)
      .find((source) => source.includes("RemoteCache.make"))
    expect(example).toBeDefined()

    const workspace = evaluateWorkspace(example!)
    expect(workspace).toMatchObject({
      cache: {
        directory: ".flows",
        remote: {
          endpoint: "https://build.smithers.sh",
          // RemoteCache.make normalizes the read alias into its token slot.
          token: { env: "SMITHERS_CACHE_READ_TOKEN" },
          write: { env: "SMITHERS_CACHE_WRITE_TOKEN" }
        }
      }
    })
    expect(guide).toContain(".smithers/WORKSPACE.ts")
    expect(guide).toContain("docs/guides/remote-cache/")
  })

  it("stops a 1200 ms synchronous example at the one-second execution deadline", () => {
    expect(() =>
      evaluateWorkspace(`
        const started = performance.now()
        while (performance.now() - started < 1_200) {}
      `)
    ).toThrow("Script execution timed out after 1000ms")
  })

  it("documents process-long target-cache degradation separately from CAS recovery", async () => {
    const guide = (await readFile(new URL("../../README.md", import.meta.url), "utf8")).replace(/\s+/g, " ")
    expect(guide).not.toContain("clients treat as retryable")
    expect(guide).toMatch(/target-cache CLI[^.]*503[^.]*degraded/)
    expect(guide).toMatch(/local[^.]*rest of the process/)
    expect(guide).toContain("fresh invocation")
    expect(guide).toMatch(/CAS client[^.]*missing[^.]*republish/)
  })

  it("describes the read path, the bindings, and the row bound the code implements", async () => {
    const guide = (await readFile(new URL("../../README.md", import.meta.url), "utf8")).replace(/\s+/g, " ")
    const { readTouchDays } = await import("../D1ActionCache.ts")
    const { maxActionCacheRowBytes, maxD1RowBytes } = await import("../protocol.ts")
    const { cacheWorkerOptions } = await import("../../deployment.ts")
    const bindings = Object.keys(
      cacheWorkerOptions({ database: 0, bucket: 0, rateLimit: () => 0, metrics: () => 0 })({ stage: "prod" }).env
    )

    expect(readTouchDays).toBe(1)
    expect(guide).toContain("refreshes access metadata at most once per day per key")
    expect(guide).not.toContain("updates D1 access metadata in the same statement")
    expect(bindings).toHaveLength(9)
    expect(guide).toContain("with its nine bindings")
    expect(guide).toContain(`exceed ${maxActionCacheRowBytes} bytes`)
    expect(guide).toContain(`over ${maxD1RowBytes} bytes`)
    expect(guide).toMatch(/`429` as a miss for that GET or a dropped publication/)
  })
})
