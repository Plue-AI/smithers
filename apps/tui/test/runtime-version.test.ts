import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as RuntimeVersion from "../src/runtime-version.ts"

describe("runtime version check", () => {
  it("names the upgrade on a Bun older than the minimum", () => {
    expect(RuntimeVersion.problem({ bun: "1.2.20" })).toBe(
      "Smithers TUI needs Bun >= 1.4.0; this is Bun 1.2.20. Run `bun upgrade`."
    )
  })

  it("accepts the minimum, newer Bun, and Node", () => {
    expect(RuntimeVersion.problem({ bun: "1.4.0" })).toBeUndefined()
    expect(RuntimeVersion.problem({ bun: "1.10.1" })).toBeUndefined()
    expect(RuntimeVersion.problem({ bun: "2.0.0" })).toBeUndefined()
    expect(RuntimeVersion.problem({ node: "26.4.0" })).toBeUndefined()
  })

  it("matches the workspace's engines.bun", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"))
    expect(manifest.engines.bun).toBe(`>=${RuntimeVersion.minimumBun}`)
  })
})
