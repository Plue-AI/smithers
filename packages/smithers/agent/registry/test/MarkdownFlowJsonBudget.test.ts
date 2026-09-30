import { Option } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"

vi.mock("../src/internal/Frontmatter.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal/Frontmatter.ts")>()
  return {
    ...actual,
    parse: () => ({
      fields: Object.freeze({
        name: "review",
        description: "Reviews a change",
        capabilities: Object.freeze([]),
        budget: Object.freeze({ tokens: 120_000, milliseconds: 900_000, usd: 1.25 }),
        deadline: 600_000
      }),
      warnings: []
    })
  }
})

describe("MarkdownFlow JSON budget", () => {
  it("accepts finite numeric ceilings from sanitized JSON frontmatter", () => {
    const result = MarkdownFlow.fromMarkdown({
      text: "frontmatter supplied by the parser double",
      path: "/flows/review/flow.mdx",
      baseDirectory: "/flows/review",
      naming: "frontmatter",
      name: Option.none(),
      dirBasename: "review",
      provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
    })

    expect(Option.getOrThrow(result.descriptor).budget).toEqual({
      tokens: 120_000,
      milliseconds: 900_000,
      usd: 1.25,
      deadline: 600_000
    })
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ code: "invalid_budget" }))
  })
})
