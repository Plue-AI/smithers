import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const vendor = readFileSync(new URL("../VENDOR.md", import.meta.url), "utf8").replace(/\s+/g, " ")

describe("engine fork record", () => {
  it("fork record matches public Flow.make", () => {
    expect(vendor).toContain("### 3. Flow authoring shape is expanded")
    expect(vendor).toContain("`Flow.make` requires a pure plan-time `body` returning one `@smthrs/plan` `Node`")
    expect(vendor).toContain(
      "`Flow.make` accepts `description`, `capabilities`, `effects`, `modelInvocable`, and `maxRounds`"
    )
    expect(vendor).toContain(
      "The required graph body, description, and round budget belong to the expanded public Flow shape"
    )
    expect(vendor).not.toContain("Flow shape is deliberately not expanded")
    expect(vendor).not.toContain("No description, capability, placement, budget, failure-policy, graph")
  })
})
