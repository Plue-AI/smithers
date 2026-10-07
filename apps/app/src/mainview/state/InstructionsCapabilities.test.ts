import { describe, expect, test } from "bun:test"
import { CODE_INTEL_LINE, smithersInstructions } from "./Instructions"

describe("registered instruction capabilities", () => {
  test("code intelligence is stated only where its flows are registered", async () => {
    const honesty = { github: { connected: true, login: "will", repositories: 1 }, localRepositories: [], localRepositoriesAvailable: false } as const
    const catalog = [{ name: "files.read", summary: "Read a file" }]
    expect(smithersInstructions(catalog, honesty)).not.toContain("code.hover")
    expect(smithersInstructions(catalog, honesty)).not.toContain(CODE_INTEL_LINE)
    const enabled = smithersInstructions([...catalog, { name: "code.hover", summary: "The type at a position" }], honesty)
    expect(enabled).toContain(CODE_INTEL_LINE)
    expect(enabled).not.toContain("need the native app")
  })
})
