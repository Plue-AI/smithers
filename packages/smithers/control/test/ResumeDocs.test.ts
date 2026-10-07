import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

describe("resume ownership documentation", () => {
  it.each(["docs/concepts/ownership.md", "docs/api.md", "src/ControlRuntime.ts"])(
    "%s reserves unrestricted claims for trusted runtime callers",
    (path) => {
      const text = read(path)
      expect(text).not.toMatch(/explicit `Control\.resume`[\s\S]{0,160}omits/)
      expect(text).toMatch(/trusted[\s\S]{0,100}(runtime|low-level)/)
      expect(text).toContain("scope: \"launched\"")
    }
  )

  it.each(["docs/concepts/authority.md", "docs/concepts/ownership.md", "docs/api.md"])(
    "%s documents explicit resume consent delegation to a parked host",
    (path) => {
      const text = read(path)
      expect(text).not.toMatch(/`resume` still records the durable delegation/)
      expect(text).toContain("control.run.resume")
      expect(text).toContain("journal subscriber")
      expect(text).toContain("requestResume")
      expect(text).toContain("consent")
      expect(text).toMatch(/live host parked|parking host/)
    }
  )
})
