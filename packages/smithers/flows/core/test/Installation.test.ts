import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import manifest from "../package.json" with { type: "json" }

const guide = readFileSync(new URL("../docs/installation.md", import.meta.url), "utf8")

describe("Installation dependency contract", () => {
  it("installs and identifies the exact Effect peer from the manifest", () => {
    const effect = `effect@${manifest.peerDependencies.effect}`

    expect(guide).toContain("/docs/installation/#use-the-libraries")
    expect(guide).not.toContain("@smthrs/core@next")
    expect(guide).toContain(`\`${effect}\` as an exact peer dependency`)
    expect(guide).not.toContain("it is a dependency, not a peer")
  })

  it("lists only the manifest's runtime dependencies", () => {
    const section = guide.split("runtime dependencies install with it:")[1]?.split("## ")[0] ?? ""
    const dependencies = [...section.matchAll(/^- \[`([^`]+)`\]/gm)].map((match) => match[1])

    expect(dependencies.sort()).toEqual(Object.keys(manifest.dependencies).sort())
    expect(guide).toContain("Five runtime dependencies install with it:")
  })
})
