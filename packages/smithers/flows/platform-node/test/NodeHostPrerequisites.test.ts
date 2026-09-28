import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import { ProcessLedger } from "@smthrs/kernel"
import { Effect, Layer } from "effect"
import { readFileSync } from "node:fs"
import * as NodeHost from "../src/NodeHost.ts"

const installation = readFileSync(new URL("../docs/installation.md", import.meta.url), "utf8")
const quickstart = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")

describe("NodeHost prerequisite documentation", () => {
  it("requires supported jj when constructing every complete host bundle", () => {
    const requirements = installation.split("## Host requirements")[1]?.split("###")[0]
    expect(requirements).toMatch(/\|[^\n]*jj[^\n]*0\.39\.0[^\n]*construction/)
    for (const factory of ["layer", "layerAt", "layerContained", "layerContainedAt"]) {
      expect(installation).toContain(`\`NodeHost.${factory}\``)
    }
    expect(installation).toContain("`not_installed`")
    expect(installation).toContain("`unsupported_version`")
    expect(installation).not.toContain("every other tag works without it")
    expect(installation).not.toContain("Nothing else in the bundle is affected")
  })

  it("lists supported jj before the quickstart constructs the raw host", () => {
    const prerequisites = quickstart.split("## Prerequisites")[1]?.split("## ")[0]
    expect(prerequisites).toMatch(/jj[^\n]*0\.39\.0/)
    expect(prerequisites).toContain("jj --version")
  })

  it("shows individual filesystem, spawner and HTTP layers without a complete bundle", () => {
    const example = installation.split("## Individual services without jj")[1]?.split("## ")[0]
    expect(example).toContain("NodeHost.AtomicFileSystem.layer")
    expect(example).toContain("NodeHost.NodeChildProcessSpawner.layer")
    expect(example).toContain("Layer.provide(platform)")
    expect(example).not.toContain("NodeHost.layer")
  })

  it("composes the egress-aware HTTP client in the copyable individual-services snippet", () => {
    const section = installation.split("## Individual services without jj")[1]?.split("## ")[0] ?? ""
    const code = section.split("```ts")[1]?.split("```")[0] ?? ""
    // A copied snippet must not bypass HTTP_PROXY/HTTPS_PROXY inside an egress-controlled sandbox.
    expect(code).toContain("NodeHost.EgressHttpClient.layer(process.env)")
    expect(code).not.toContain("layerUndici")
  })

  it("marks the allow-all grant store as a test seam wherever a page composes it", () => {
    for (const page of [installation, quickstart]) {
      expect(page).toContain("Layer.provide(GrantStore.layerNoop)")
      expect(page).toContain("not a production policy")
      expect(page).toContain("https://kernel.smithers.sh/guides/write-a-capability-policy/")
    }
  })
})

it.live("refuses a contained host before spawning when jj cannot be resolved", () =>
  Effect.gen(function*() {
    const ledger = yield* ProcessLedger.makeMemory({ hostId: "missing-jj", ownerPid: process.pid })
    const previousPath = process.env.PATH
    const previousOverride = process.env.SMITHERS_JJ_PATH
    // Resolution returns a typed failure before constructing a command runner.
    // Neither an installed binary nor an executable fixture is invoked here.
    process.env.PATH = ""
    delete process.env.SMITHERS_JJ_PATH
    try {
      for (const options of [undefined, { graceMs: 25 }]) {
        const error = yield* Effect.flip(
          Effect.provide(
            Jj,
            NodeHost.layerContained(options).pipe(
              Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
            )
          )
        )
        expect(error).toMatchObject({ code: "not_installed", method: "version", cause: { code: "ENOENT" } })
        expect(error.message).toContain("No jj on PATH")
        expect(yield* ledger.live).toEqual([])
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousOverride === undefined) delete process.env.SMITHERS_JJ_PATH
      else process.env.SMITHERS_JJ_PATH = previousOverride
    }
  }))
