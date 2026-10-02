import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string): string =>
  Fs.readFileSync(NodePath.join(import.meta.dirname, "../docs", path), "utf8").replace(/\s+/g, " ")

describe("guide behavior claims", () => {
  it.each(["quickstart.md", "guides/inspect-a-workspace.md"])(
    "%s describes preview keys without forecasting cache hits",
    (path) => {
      const page = read(path)
      expect(page).not.toContain("whether the cache already holds a result")
      expect(page).not.toContain("its key moved")
      expect(page).toContain("Cache status is unresolved")
      expect(page).toContain("preview")
      expect(page).toContain("explain")
      expect(page).toContain("show target")
      if (path === "guides/inspect-a-workspace.md") {
        expect(page).toContain("`cacheLookup: \"not-wired\"`")
        expect(page).toContain("`wouldRun: true`")
        expect(page).toContain("local `candidate` or `miss`")
        expect(page).toContain("remote cache is not probed")
        expect(page).toContain("execution still validates outputs and dependency results")
      }
    }
  )

  it("execution distinguishes declared values from inherited presence", () => {
    const page = read("concepts/execution.md")
    expect(page).not.toContain("inherited values from the exec allowlist")
    expect(page).not.toContain("A changed `PATH` invalidates command-form builds too")
    expect(page).toContain("presence only")
    expect(page).toContain("Declare output-affecting values in `env`")
    expect(page).toContain("resolved Nix environment variables")
  })

})
