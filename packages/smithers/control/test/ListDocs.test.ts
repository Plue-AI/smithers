import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

describe("run listing documentation", () => {
  it.each(["docs/api.md", "docs/guides/list-runs.md"])(
    "%s does not present the page size as a bound on executor observations",
    (path) => {
      const text = read(path)
      expect(text).not.toMatch(/Executor observations and pending steering counts enrich only those/)
      expect(text).toMatch(/walk(s|ing) the\s+source/)
      expect(text).toMatch(/observe[\s\S]{0,40}more runs than `limit`/)
    }
  )
})
