/**
 * The umbrella's own target declarations against what its gates read.
 *
 * `smithers-build` keys, caches, and schedules a target from what the
 * declaration names. A suite that reads a file its target never declared
 * keeps a cached result through an edit to that file, a lint target that
 * names fewer files than the package's lint script leaves the difference
 * out of CI, and a suite that skips itself unless an operator exports a
 * database URL is no gate at all. These cases hold the declarations to the
 * reads, and the published manifest to the README that ships inside it.
 */
import type * as Attr from "@smthrs/targets/Attr"
import type * as Docker from "@smthrs/targets/Docker"
import type * as EsLint from "@smthrs/targets/EsLint"
import type * as Input from "@smthrs/targets/Input"
import type * as NodeTest from "@smthrs/targets/NodeTest"
import * as Reference from "@smthrs/targets/Reference"
import type * as Shell from "@smthrs/targets/Shell"
import * as Target from "@smthrs/targets/Target"
import type * as Vitest from "@smthrs/targets/Vitest"
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, it, vi } from "vitest"
import { Package } from "../PACKAGE.ts"

const packageRoot = NodePath.join(import.meta.dirname, "..")
const packageDirectory = "packages/smithers/build"

const attrsOf = <A>(target: Target.AnyTarget): A => Target.metadata(target).attrs as A

/**
 * One declared input as package-relative text. A workspace-absolute `//` path
 * is resolved against this package, so a sibling package's file reads as the
 * `../` path a suite passes to `read`.
 */
const declaredText = (input: Input.Declared): string | undefined => {
  const text = input._tag === "File" ? input.path : input._tag === "Glob" ? input.pattern : undefined
  return text?.startsWith("//") ? NodePath.posix.relative(packageDirectory, text.slice(2)) : text
}

/** Whether a package-relative path is named by one of the declared inputs. */
const covers = (inputs: ReadonlyArray<Input.Declared>, path: string): boolean =>
  inputs.some((input) => {
    const text = declaredText(input)
    if (text === undefined) return false
    return input._tag === "File" ? text === path : NodePath.matchesGlob(path, text)
  })

/**
 * Every package-relative path the Vitest suites read by literal, collected
 * from the suites themselves so the inventory has one source. The two forms
 * are the `read` helper in `Docs.test.ts` and a raw `readFileSync` joined
 * onto `packageRoot`; an absence check is not a read, and the walk in
 * `proseFiles` is covered by the Markdown declarations instead.
 */
const literalReads = (): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const name of Fs.readdirSync(import.meta.dirname)) {
    if (!name.endsWith(".test.ts")) continue
    const source = Fs.readFileSync(NodePath.join(import.meta.dirname, name), "utf8")
    for (
      const match of source.matchAll(/\bread\("([^"]+)"\)|readFileSync\(\s*NodePath\.join\(packageRoot,\s*"([^"]+)"\)/g)
    ) {
      found.add(match[1] ?? match[2]!)
    }
  }
  return [...found].sort()
}

/**
 * What the target index reads from each declaration: the rule, the attrs,
 * and the rules of its dependency edges. A target inside the attrs
 * serializes as its rule tag, so a dropped service edge changes the text.
 */
const declarationShape = (module: { readonly Package: Record<string, unknown> }) =>
  Object.fromEntries(
    Object.entries(module.Package).filter((entry): entry is [string, Target.AnyTarget] => Target.isTarget(entry[1]))
      .map(([name, target]) => {
        const metadata = Target.metadata(target)
        return [name, {
          rule: metadata.target,
          attrs: JSON.stringify(metadata.attrs),
          dependencies: metadata.dependencies.map((dependency) => Target.metadata(dependency).target)
        }]
      })
  )

/** Evaluates PACKAGE.ts afresh while `process.platform` reports `platform`. */
const declaredOn = async (platform: NodeJS.Platform) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...original, value: platform })
  try {
    vi.resetModules()
    return declarationShape(await import("../PACKAGE.ts"))
  } finally {
    Object.defineProperty(process, "platform", original)
  }
}

describe("host independence", () => {
  it("declares the same targets and edges on every host, so the checked-in index does not depend on who wrote it", async () => {
    const linux = await declaredOn("linux")
    expect(linux.cacheServicePostgres?.dependencies).toContain("Docker.Service")
    expect(await declaredOn("darwin")).toEqual(linux)
  })
})

describe("umbrella lint target", () => {
  const lint = attrsOf<EsLint.Attrs>(Package.lint)

  it("lints the suite and the self-hosted service beside the sources, as the lint script does", () => {
    // package.json's `lint` runs `eslint src test terraform/modules/cache/service`;
    // the graph is what CI invokes, so the two must name the same trees.
    for (const path of ["src/Install.ts", "test/Docs.test.ts", "terraform/modules/cache/service/storage.js"]) {
      expect(covers(lint.sources, path), `lint never names ${path}`).toBe(true)
    }
  })

  it("keeps the flat config and the root conventions it imports as key material", () => {
    const configs = lint.configs.map((config) => config.path)
    expect(configs).toContain("eslint.config.js")
    expect(configs).toContain("//eslint.jsdoc.js")
    expect(configs).toContain("//eslint.invariants.js")
  })
})

describe("umbrella test target", () => {
  const test = attrsOf<Vitest.Attrs>(Package.test)

  it("declares every file the suites read by literal", () => {
    const reads = literalReads()
    expect(reads).toContain("infra/deployment.ts")
    expect(reads).toContain("infra/package.json")
    expect(reads).toContain("infra/worker/protocol.ts")
    expect(reads).toContain("terraform/modules/cache/service/protocol.js")
    for (const path of reads) {
      expect(Fs.existsSync(NodePath.join(packageRoot, path)), `${path} does not exist`).toBe(true)
      expect(covers(test.sources, path), `test never declares ${path}`).toBe(true)
    }
  })

  it("declares the package Markdown the docs suite walks", () => {
    for (const path of ["README.md", "DESIGN.md", "WIRING.md", "API-REVIEW.md", "CHANGELOG.md"]) {
      expect(covers(test.sources, path), `test never declares ${path}`).toBe(true)
    }
  })
})

describe("self-hosted cache service targets", () => {
  const migration = "terraform/modules/cache/migrations/0001_initial.sql"

  it("keys the fake-backed suite on the migration postgres_test.js reads at load", () => {
    const attrs = attrsOf<NodeTest.Attrs>(Package.cacheService)
    expect(covers(attrs.srcs, migration)).toBe(true)
  })

  it("runs postgres_test.js against a pinned Postgres service with the URL it skips without", () => {
    const attrs = attrsOf<(typeof Shell.TestAttrs)["Type"]>(Package.cacheServicePostgres)
    expect(attrs.bin).toEqual(Reference.hostBin("bun"))
    expect(attrs.args).toEqual([
      "test",
      "packages/smithers/build/terraform/modules/cache/service/test/postgres_test.js"
    ])
    expect(attrs.hosts).toEqual(["linux"])
    expect(attrs.sandbox).toEqual({ network: "loopback" })
    expect(attrs.services).toHaveLength(1)
    const service = attrs.services![0]!
    expect(Target.metadata(service).target).toBe("Docker.Service")
    const postgres = attrsOf<(typeof Docker.ServeAttrs)["Type"]>(service)
    expect(postgres.image).toMatch(/^postgres@sha256:[0-9a-f]{64}$/)
    expect(postgres.tag).toBeUndefined()

    const url = new URL(attrs.env!["SMITHERS_CACHE_TEST_DATABASE_URL"]!)
    expect(url.protocol).toBe("postgres:")
    expect(url.hostname).toBe("127.0.0.1")
    expect(Number(url.port)).toBe(postgres.ports?.["5432"])
    expect(url.password).toBe(postgres.env?.["POSTGRES_PASSWORD"])
    expect(url.pathname.slice(1)).toBe(postgres.env?.["POSTGRES_DB"])

    // `pg_isready` over TCP: the socket answers during initdb's temporary
    // server, the published port does not, so only a TCP probe means ready.
    expect(postgres.readiness).toMatchObject({ exec: expect.arrayContaining(["pg_isready", "-h", "127.0.0.1"]) })

    const data = (attrs.data ?? []).flat().filter((member: Attr.DataMember): member is Input.Declared =>
      !Target.isTarget(member) && "_tag" in member && (member._tag === "File" || member._tag === "Glob")
    )
    for (
      const path of [
        migration,
        "terraform/modules/cache/service/storage.js",
        "terraform/modules/cache/service/test/postgres_test.js"
      ]
    ) {
      expect(covers(data, path), `postgres gate never declares ${path}`).toBe(true)
    }
  })
})

describe("published README", () => {
  it("links only to files the package.json files allowlist ships", () => {
    const manifest = JSON.parse(Fs.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8")) as {
      readonly files: ReadonlyArray<string>
    }
    const shipped = new Set(
      manifest.files.flatMap((pattern) =>
        Fs.globSync(pattern, { cwd: packageRoot }).map((path) => path.split(NodePath.sep).join("/"))
      )
    )
    const readme = Fs.readFileSync(NodePath.join(packageRoot, "README.md"), "utf8")
    const relative = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1]!)
      .filter((target) => !/^(?:[a-z]+:|#)/i.test(target))
      .map((target) => target.split("#")[0]!)
    for (const target of relative) {
      expect(shipped.has(target), `README links ${target}, which the published package omits`).toBe(true)
    }
  })
})
