import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

/** Collapse JSDoc gutters and wrapping so a claim reads as one line. */
const flatten = (text: string) => text.replace(/^\s*\*/gm, " ").replace(/\s+/g, " ")

const manifest = JSON.parse(read("../package.json")) as {
  readonly peerDependencies: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

const requiredPeers = Object.keys(manifest.peerDependencies)
  .filter((name) => manifest.peerDependenciesMeta?.[name]?.optional !== true)
  .sort()

describe("Installation docs", () => {
  it("require jj for every complete bundle in installation and quickstart", () => {
    // Every `BunHost` factory is `Layer.mergeAll` over a `BunJj` layer whose
    // version probe runs at construction, so a program that asks for only
    // `FileSystem` still fails with `not_installed` on a host without jj.
    for (const page of ["../docs/installation.md", "../docs/quickstart.md"]) {
      const text = flatten(read(page))
      expect(text).toMatch(/jj 0\.39\.0 or (later|newer)/)
      expect(text).toMatch(/Jujutsu/)
      expect(text).not.toMatch(/if your program uses that slot/)
    }
  })

  it("documents construction-time JjError on every host factory", () => {
    const source = read("../src/BunHost.ts")
    for (const factory of ["layer", "layerAt", "layerContained", "layerContainedAt"]) {
      const declaration = source.search(new RegExp(`\\nexport const ${factory}\\b`))
      expect(declaration, factory).toBeGreaterThan(0)
      const jsdoc = source.slice(source.lastIndexOf("/**", declaration), declaration)
      expect(flatten(jsdoc), factory).toMatch(/JjError/)
    }
  })

  it("gives the contained factories the JjError channel in troubleshooting", () => {
    const source = flatten(read("../src/BunHost.ts"))
    const signature = source.match(/layerContained = \([^)]*\): (Layer\.Layer<[^>]+>)/)?.[1]
    expect(signature).toBeDefined()
    const troubleshooting = flatten(read("../docs/troubleshooting.md"))
    expect(troubleshooting).toContain(signature!)
    expect(troubleshooting).not.toMatch(/Layer\.Layer<BunHost, never,/)
  })

  it("documents the manifest's required peers as required", () => {
    expect(requiredPeers.length).toBeGreaterThan(0)
    for (const page of ["../README.md", "../docs/installation.md"]) {
      const text = flatten(read(page))
      for (const peer of requiredPeers) expect(text, `${page} names ${peer}`).toContain(`\`${peer}\``)
      expect(text).not.toMatch(/is not a peer of this package/)
      expect(text).not.toMatch(/not a peer/)
    }
    expect(flatten(read("../docs/README.md"))).not.toMatch(/optional peer/)
  })
})
