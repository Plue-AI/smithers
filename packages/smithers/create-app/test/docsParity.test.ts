/**
 * What holds `docs/` to the package.
 *
 * `docs/` is the source of create-app.smithers.sh: `apps/docs/shared/sync-content.mjs`
 * stitches it into the site, and `docs/README.md` is the landing page. Nothing
 * in that pipeline reads the package, so without these cases `docs/api.md`
 * could name a subpath the package stopped exporting, a constructor that was
 * renamed, or a flag the bin no longer takes, and every gate stayed green.
 *
 * These cases are the parts a machine can settle: the reference page against
 * the export map and the bin, the landing page against the pages that exist,
 * every count and version pin the prose spells by hand against what it
 * counts or pins, and the changelog against the manifest. Whether the prose
 * is true is a reviewer's job.
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { BrandToken } from "../src/app.ts"
import * as CreateApp from "../src/index.ts"
import { usage } from "../src/routesBin.ts"
import * as Ui from "../src/ui.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const read = (path: string): string => readFileSync(join(packageRoot, path), "utf8")

const api = read("docs/api.md")
const manifest = JSON.parse(read("package.json")) as {
  readonly version: string
  readonly private?: boolean
  readonly repository: { readonly directory: string }
  readonly exports: Record<string, unknown>
  readonly bin: Record<string, string>
  readonly peerDependencies: Record<string, string>
  readonly peerDependenciesMeta: Record<string, { readonly optional?: boolean }>
  readonly publishConfig: { readonly exports: Record<string, unknown> }
}

/** The rows of the "Runtime class of each subpath" table, as import specifiers. */
const documentedSubpaths = [...api.matchAll(/^\| `(@smthrs\/create-app[^`]*)`/gm)].map((match) => match[1]!)

/**
 * The subpaths `package.json` actually serves.
 *
 * The wildcard rows are dropped: `./*` is the escape hatch every module is
 * reachable through and documenting each one would be documenting `src/`. The
 * `null` rows are refusals, not subpaths.
 */
const exportedSubpaths = Object.entries(manifest.exports)
  .filter(([key, value]) => value !== null && !key.includes("*") && key !== "./package.json")
  .map(([key]) => (key === "." ? "@smthrs/create-app" : `@smthrs/create-app${key.slice(1)}`))
  .sort()

describe("docs/api.md", () => {
  it("declares the Vitest adapter as ESM-only in development and publication", () => {
    expect(manifest.exports["./testing"]).toEqual({ types: "./src/testing.ts", import: "./src/testing.ts" })
    expect(manifest.publishConfig.exports["./testing"]).toEqual({
      types: "./dist/esm/testing.d.ts",
      import: "./dist/esm/testing.js"
    })
  })

  it("documents the runtime class of every subpath the package declares", () => {
    expect(exportedSubpaths.filter((subpath) => !documentedSubpaths.includes(subpath))).toEqual([])
  })

  // `./*` serves every module in `src`, so the table may name one the explicit
  // list does not — `./routesBin` is the bin body and is documented as Node.
  // What it may not do is name a module that is not there.
  it("documents no subpath that does not resolve", () => {
    const missing = documentedSubpaths.filter((subpath) => {
      if (exportedSubpaths.includes(subpath)) return false
      const module = subpath.slice("@smthrs/create-app/".length)
      return !existsSync(join(packageRoot, "src", `${module}.ts`))
    })
    expect(missing).toEqual([])
  })

  it("names constructors that exist", () => {
    const constructors = [...api.matchAll(/`(define[A-Z]\w*|CreateApp|cachedModelTest)`/g)].map((match) => match[1]!)
    expect(constructors.length).toBeGreaterThan(0)
    const surface = { ...CreateApp, ...Ui } as Record<string, unknown>
    for (const name of new Set(constructors)) {
      // `cachedModelTest` is `./testing`, which the barrel does not re-export:
      // it imports vitest. Its subpath is in the table above instead.
      if (name === "cachedModelTest") continue
      expect(typeof surface[name], `docs/api.md names \`${name}\``).toBe("function")
    }
  })

  it("shows the bin under the name package.json installs", () => {
    for (const name of Object.keys(manifest.bin)) expect(api).toContain(name)
  })

  it("shows only flags the bin's own usage text documents", () => {
    const shown = [...api.matchAll(/smithers-routes (--[a-z]+)/g)].map((match) => match[1]!)
    expect(shown.length).toBeGreaterThan(0)
    for (const flag of new Set(shown)) expect(usage).toContain(flag)
  })
})

/** Every Markdown page under `docs/`, as docs-relative posix paths. */
const pages = (): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(directory, entry.name), relative)
      else if (entry.name.endsWith(".md")) found.push(relative)
    }
  }
  walk(join(packageRoot, "docs"), "")
  return found.sort()
}

describe("docs/README.md", () => {
  const readme = read("docs/README.md")

  /**
   * The landing page is the only entry point a reader lands on, and the
   * sidebar is computed from the synced tree rather than authored, so a page
   * nothing links to is a page nobody finds. This is the cheap half of that:
   * a new page has to be introduced somewhere on the landing page.
   */
  it("links every other page in docs/", () => {
    const others = pages().filter((page) => page !== "README.md")
    expect(others.length).toBeGreaterThan(0)
    expect(others.filter((page) => !readme.includes(`](./${page})`))).toEqual([])
  })
})

/**
 * Every `BrandToken`, as a value.
 *
 * `BrandToken` is a type, so nothing at runtime lists its names. The record's
 * annotation is what holds this to the union: `pnpm check` refuses a missing
 * name and an extra one alike.
 */
const brandTokenNames: Record<BrandToken, null> = {
  primary: null,
  primaryHover: null,
  primaryActive: null,
  primarySubtle: null,
  accent: null,
  accentForeground: null,
  accentSubtle: null,
  accentRing: null,
  secondary: null,
  secondarySubtle: null,
  success: null,
  successSubtle: null,
  warning: null,
  danger: null,
  info: null,
  background: null,
  surface: null,
  surfaceRaised: null,
  border: null,
  borderStrong: null,
  foreground: null,
  foregroundMuted: null,
  foregroundSubtle: null,
  radiusSm: null,
  radiusMd: null,
  radiusLg: null,
  radiusXl: null,
  radiusComposer: null,
  radiusPill: null,
  shadowSm: null,
  shadowMd: null,
  shadowLg: null
}
const brandTokens = Object.keys(brandTokenNames).sort()

describe("BrandToken", () => {
  it("is counted correctly wherever docs/api.md counts it", () => {
    const row = api.match(/^\| `BrandToken` \|(.*)$/m)?.[1]
    expect(row).toBeDefined()
    expect((row!.match(/\d+/g) ?? []).map(Number).filter((count) => count !== brandTokens.length)).toEqual([])
  })

  it("is listed name for name in the brand guide", () => {
    const guide = read("docs/guides/brand-an-app.md")
    const section = guide.slice(guide.indexOf("## The tokens"), guide.indexOf("## The fonts"))
    const named = new Set([...section.matchAll(/`([a-z][A-Za-z]*)`/g)].map((match) => match[1]!))
    expect([...named].sort()).toEqual(brandTokens)
  })
})

/**
 * The lowest version a peer range admits: the floor of its first alternative.
 * It is the version the install commands spell, and the one the `default`
 * template pins.
 */
const floorOf = (range: string): string => range.split("||")[0]!.trim().replace(/^[\^~]/, "")

describe("optional peers", () => {
  it("are listed in docs/installation.md at the ranges package.json declares", () => {
    const installation = read("docs/installation.md")
    const start = installation.indexOf("## Optional peer dependencies")
    const section = installation.slice(start, installation.indexOf("\n## ", start))
    const rows = [...section.matchAll(/^\| `([^`]+)` +\| `([^`]+)` +\|/gm)]
    const listed = Object.fromEntries(rows.map((row) => [row[1]!, row[2]!.replaceAll("\\|", "|")]))
    const optional = Object.entries(manifest.peerDependencies).filter(([name]) =>
      manifest.peerDependenciesMeta[name]?.optional === true
    )
    expect(optional.length).toBeGreaterThan(0)
    expect(listed).toEqual(Object.fromEntries(optional))
  })

  it("are pinned at the floor of their peer range wherever the docs name a version", () => {
    const prose = [read("README.md"), ...pages().map((page) => read(`docs/${page}`))]
    const pins = prose.flatMap((text) =>
      [...text.matchAll(/`((?:@[\w.-]+\/)?[\w.-]+)@(\d[^`\s]*)`/g)].map((pin) => ({ name: pin[1]!, version: pin[2]! }))
    )
    const peers = pins.filter((pin) => pin.name in manifest.peerDependencies)
    expect(peers.filter((pin) => pin.version !== floorOf(manifest.peerDependencies[pin.name]!))).toEqual([])
  })
})

/**
 * The directory names `smithers-build create-app` never copies: the `skipped`
 * set in `@smthrs/build-cli`'s `CreateApp.ts`. It counts every other file.
 */
const neverCopied = new Set(["node_modules", "dist", ".wrangler", ".flows"])

/** How many files scaffolding `template` copies, counted the way the scaffold counts. */
const copiedFiles = (template: string): number => {
  const count = (directory: string): number =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !neverCopied.has(entry.name))
      .reduce((total, entry) => total + (entry.isDirectory() ? count(join(directory, entry.name)) : 1), 0)
  return count(join(packageRoot, "template", template))
}

describe("template file counts", () => {
  it("match the scaffold result docs/quickstart.md shows", () => {
    const shown = [...read("docs/quickstart.md").matchAll(/"files": (\d+)/g)].map((match) => Number(match[1]))
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.filter((count) => count !== copiedFiles("default"))).toEqual([])
  })

  it("match the Files copied row of docs/reference/templates.md", () => {
    const row = read("docs/reference/templates.md").match(/^\| Files copied +\| (\d+) +\| (\d+) +\|$/m)
    expect(row).not.toBeNull()
    expect([Number(row![1]), Number(row![2])]).toEqual([copiedFiles("default"), copiedFiles("aomi")])
  })
})

describe("CHANGELOG.md", () => {
  const changelog = read("CHANGELOG.md")

  it("opens its first release section at the version package.json declares", () => {
    const releases = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]!)
    expect(releases.find((release) => release !== "Unreleased")).toBe(manifest.version)
  })

  it("calls the package private only when package.json does", () => {
    if (manifest.private !== true) expect(changelog).not.toMatch(/package is private/)
  })

  it("links the documentation site the README links", () => {
    const site = read("README.md").match(/\*\*Documentation:\*\* (\S+)/)?.[1]
    expect(site).toBeDefined()
    expect(changelog).toContain(site)
  })
})

describe("target labels", () => {
  /**
   * A label is `//<package directory>:<target>`, and the package moved under
   * `packages/smithers/`, so a label written before the move names a package
   * that no longer exists.
   */
  it("name this package's directory and a target PACKAGE.ts declares", () => {
    const targets = read("PACKAGE.ts").match(/targets: \{([^}]*)\}/)?.[1]?.split(",").map((name) => name.trim())
    expect(targets).toBeDefined()
    const prose = [read("CHANGELOG.md"), read("README.md"), ...pages().map((page) => read(`docs/${page}`))]
    const labels = prose.flatMap((text) =>
      [...text.matchAll(/\/\/packages\/[\w./-]*create-app:[\w-]+/g)].map((match) => match[0])
    )
    expect(
      labels.filter((label) => {
        const [path, target] = label.split(":")
        return path !== `//${manifest.repository.directory}` || !targets!.includes(target!)
      })
    ).toEqual([])
  })
})
