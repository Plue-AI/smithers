/**
 * The archive, and the four deterministic rewrites, over the real manifests
 * and tsconfigs the fixtures carry.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Archive from "@smthrs/migrate/flow/Archive"
import * as Scan from "@smthrs/migrate/Scan"
import * as Effect from "effect/Effect"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { copyFixture, fixture } from "../fixtures/helpers.ts"

const platform = NodeServices.layer

const read = (name: string, file: string): string => readFileSync(join(fixture(name), file), "utf8")

describe("Archive.rewriteManifest", () => {
  it("removes the old packages the scan named and pins the ones the migration needs", () => {
    const { text } = Archive.rewriteManifest(read("jsx-single", "package.json"), {
      remove: ["smthrs", "zod", "ai", "@ai-sdk/anthropic"],
      add: ["@smthrs/agent", "@smthrs/engine", "@smthrs/flow", "@smthrs/plan"]
    })
    const manifest = JSON.parse(text) as { dependencies: Record<string, string> }

    expect(manifest.dependencies).toEqual({
      "@smthrs/agent": "1.0.0-rc.0",
      "@smthrs/engine": "1.0.0-rc.0",
      "@smthrs/flow": "1.0.0-rc.0",
      "@smthrs/plan": "1.0.0-rc.0",
      effect: "4.0.0-beta.105"
    })
    expect(text.endsWith("\n")).toBe(true)
  })

  it("pins effect to the one version the repository ships", () => {
    const { text } = Archive.rewriteManifest(read("jsx-single", "package.json"), {
      remove: ["smthrs", "zod", "ai", "@ai-sdk/anthropic", "effect"],
      add: ["effect"]
    })
    expect((JSON.parse(text) as { dependencies: Record<string, string> }).dependencies.effect)
      .toBe("4.0.0-rc.115")
  })

  it("rewrites `smithers up <file>` into the canonical flow start command", () => {
    const { scripts } = Archive.rewriteManifest(read("jsx-single", "package.json"), { remove: [], add: [] })
    const start = scripts.find((entry) => entry.name === "start")

    expect(start?.before).toContain("smithers up simple-workflow.jsx")
    expect(start?.after).toBe("smthrs flow start simple-workflow --data '{\"topic\":\"x\"}'")
    expect(start?.unsupported).toBeUndefined()
  })

  it("rewrites a `bunx smthrs up` script and keeps a nested workflow's position in its flow name", () => {
    const { scripts } = Archive.rewriteManifest(read("plue-pack", "package.json"), { remove: [], add: [] })

    expect(scripts.find((entry) => entry.name === "ci")?.after)
      .toBe("smthrs flow start pipelines/ci-fast --detached")
    expect(scripts.find((entry) => entry.name === "wf")?.after).toBe("smithers workflow run")
    expect(scripts.find((entry) => entry.name === "wf")?.unsupported).toEqual(expect.any(String))
  })

  it("leaves a verb with no counterpart alone and reports it", () => {
    const rewritten = Archive.rewriteScripts({ ui: "smithers ui --app", ok: "vitest" })

    expect(rewritten[0]).toEqual({
      name: "ui",
      before: "smithers ui --app",
      after: "smithers ui --app",
      unsupported: "Legacy CLI command requires manual mapping to the 1.0 command tree"
    })
    expect(rewritten[1]?.unsupported).toBeUndefined()
  })

  it("drops a dependency map that ends up empty", () => {
    const { text } = Archive.rewriteManifest(
      JSON.stringify({ name: "x", devDependencies: { smthrs: "0.35.0" } }),
      { remove: ["smthrs"], add: [] }
    )
    expect(JSON.parse(text)).toEqual({ name: "x" })
  })
})

describe("Archive.rewriteTsconfig", () => {
  it.each([undefined, null, 42, false, {}])("does not classify a non-string JSX source as retired: %j", (source) => {
    expect(Archive.isOldJsxImportSource(source)).toBe(false)
  })

  it("preserves an untouched React tsconfig byte for byte", () => {
    const text =
      "{\n  // Retained UI\n  \"compilerOptions\": { \"jsx\": \"react-jsx\", \"jsxImportSource\": \"react\" }\n}\n"
    expect(Archive.rewriteTsconfig(text)).toBe(text)
  })

  it.each([
    { jsx: "react-jsx", jsxImportSource: "react" },
    { jsx: "react-jsxdev", jsxImportSource: "preact" },
    { jsx: "preserve", jsxImportSource: "solid-js" },
    { jsx: "react" },
    { jsx: "preserve" },
    { jsx: "react-jsx", jsxImportSource: "smithers" },
    { jsx: "react-jsx", jsxImportSource: "@smthrs/core" }
  ])("preserves JSX settings without evidence of a retired runtime: %j", (options) => {
    const compilerOptions = { ...options, strict: true, paths: { "smthrs/*": ["./legacy/*"], "@app/*": ["./src/*"] } }
    expect(JSON.parse(Archive.rewriteTsconfig(JSON.stringify({ compilerOptions })))).toEqual({
      compilerOptions: { ...options, strict: true, paths: { "@app/*": ["./src/*"] } }
    })
  })

  it.each([
    { source: "smthrs", context: {} },
    { source: "smithers-orchestrator", context: {} },
    { source: "smithers", context: { localFacade: true } },
    { source: "@smthrs/core", context: { oldScoped: ["core"] } }
  ])("removes JSX settings supported by legacy evidence: %j", ({ source, context }) => {
    const compilerOptions = { jsx: "react-jsx", jsxImportSource: source, strict: true }
    expect(JSON.parse(Archive.rewriteTsconfig(JSON.stringify({ compilerOptions }), context))).toEqual({
      compilerOptions: { strict: true }
    })
  })

  it("removes the JSX settings that made every .tsx resolve through the old runtime", () => {
    const rewritten = JSON.parse(Archive.rewriteTsconfig(read("jsx-single", "tsconfig.json"))) as {
      compilerOptions: Record<string, unknown>
    }

    expect(rewritten.compilerOptions.jsx).toBeUndefined()
    expect(rewritten.compilerOptions.jsxImportSource).toBeUndefined()
    expect(rewritten.compilerOptions.strict).toBe(true)
  })

  it("removes the old path mappings and keeps every other one", () => {
    const rewritten = JSON.parse(Archive.rewriteTsconfig(JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "smithers-orchestrator",
        paths: { "smthrs/*": ["./node_modules/smthrs/*"], "@app/*": ["./src/*"] }
      }
    }))) as { compilerOptions: { paths: Record<string, unknown> } }

    expect(rewritten.compilerOptions.paths).toEqual({ "@app/*": ["./src/*"] })
  })

  it("reads a tsconfig that carries comments", () => {
    const original = `{
  // ordinary JSX configuration
  "compilerOptions": { "jsx": "react-jsx", "strict": true }
}`
    expect(Archive.rewriteTsconfig(original)).toBe(original)
  })

  it("keeps an include list whose globs look like comments", () => {
    // `"**/*.ts", "**/*.tsx"` carries `/*`, then `*/`, then `/*` again. Read as
    // a block comment that is the middle of the list, and the rewrite would
    // leave valid JSON naming files that do not exist.
    const rewritten = Archive.rewriteTsconfig(read("jsx-single", "tsconfig.json"))

    expect((JSON.parse(rewritten) as { include: ReadonlyArray<string> }).include).toEqual([
      "**/*.ts",
      "**/*.jsx",
      "**/*.tsx",
      "**/*.js"
    ])
  })

  it("removes the paths keys the unit's own scan calls old, and keeps every other one", () => {
    // A paths key is judged by the predicate the postcondition judges it by,
    // `Archive.isOldPathsKey`, and by nothing else. Written twice, the two
    // spellings drift: a bare `smithers` key in a project inside the old
    // monorepo survived a rewrite that filtered three literal prefixes and
    // then failed the unit's own postcondition, after the archive had run.
    const text = JSON.stringify({
      compilerOptions: {
        paths: {
          "smithers": ["../../smithers/index.js"],
          "smithers/*": ["../../smithers/*"],
          "@smthrs/engine": ["../../packages/smithers/flows/engine/src/index.ts"],
          "@smithers/*": ["../../packages/*"],
          "smthrs/*": ["./node_modules/smthrs/*"],
          "@app/*": ["./src/*"]
        }
      }
    })
    const specifiers = { localFacade: true, oldScoped: ["engine"] }

    const rewritten = JSON.parse(Archive.rewriteTsconfig(text, specifiers)) as {
      compilerOptions: { paths: Record<string, unknown> }
    }
    expect(rewritten.compilerOptions.paths).toEqual({ "@app/*": ["./src/*"] })

    // And the same predicate is what kept them: with no manifest declaring the
    // bare name as the facade and no 0.x pin on `@smthrs/engine`, neither key
    // is old, and neither the rewrite nor the postcondition may touch it.
    const kept = JSON.parse(Archive.rewriteTsconfig(text)) as {
      compilerOptions: { paths: Record<string, unknown> }
    }
    expect(Object.keys(kept.compilerOptions.paths).sort()).toEqual([
      "@app/*",
      "@smthrs/engine",
      "smithers",
      "smithers/*"
    ])
    for (const key of Object.keys(kept.compilerOptions.paths)) {
      expect([key, Archive.isOldPathsKey(key)]).toEqual([key, false])
    }
    for (const key of ["smithers", "smithers/*", "@smthrs/engine", "@smithers/*", "smthrs/*"]) {
      expect([key, Archive.isOldPathsKey(key, specifiers)]).toEqual([key, true])
    }
  })

  it("removes the paths key entirely when nothing survives it", () => {
    const rewritten = Archive.rewriteTsconfig(
      JSON.stringify({ compilerOptions: { paths: { "smthrs/*": ["x"] } } })
    )
    expect(JSON.parse(rewritten)).toEqual({ compilerOptions: {} })
  })
})

describe("Archive.pinFor", () => {
  it("pins the effect family and the smithers packages, and refuses to guess for anything else", () => {
    expect(Archive.pinFor("effect")).toBe(Archive.effectVersion)
    expect(Archive.pinFor("@effect/platform-node")).toBe(Archive.effectVersion)
    expect(Archive.pinFor("@smthrs/flow")).toBe(Archive.smithersVersion)
    expect(Archive.pinFor("zod")).toBeUndefined()
    // A name with no pin is left out rather than written as `"*"`.
    const before = JSON.stringify({ name: "p", dependencies: { zod: "4.0.0" } })
    const { text } = Archive.rewriteManifest(before, { remove: [], add: ["left-pad", "@smthrs/flow"] })
    expect(JSON.parse(text)).toEqual({
      name: "p",
      dependencies: { "@smthrs/flow": Archive.smithersVersion, zod: "4.0.0" }
    })
    const untouched = Archive.rewriteManifest(before, { remove: [], add: ["left-pad"] })
    expect(JSON.parse(untouched.text)).toEqual(JSON.parse(before))
  })
})

describe("Archive.rewriteGitignore", () => {
  it("adds the 1.0 state directory once", () => {
    expect(Archive.rewriteGitignore("node_modules\n")).toBe("node_modules\n.flows/\n")
    expect(Archive.rewriteGitignore("node_modules\n.flows/\n")).toBe("node_modules\n.flows/\n")
    expect(Archive.rewriteGitignore("node_modules")).toBe("node_modules\n.flows/\n")
    expect(Archive.rewriteGitignore("")).toBe(".flows/\n")
  })
})

describe("Archive.run", () => {
  it.effect("keeps 0.x packages through the dependencies unit and removes them only in the project unit", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const manifestFile = join(root, "package.json")
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        dependencies: Record<string, string>
      }
      manifest.dependencies["@smthrs/flow"] = "1.0.0-rc.0"
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

      yield* Archive.run({
        root,
        unit: "dependencies",
        kind: "dependencies",
        sources: ["package.json"],
        targets: ["package.json"],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false
      })

      const inherited = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        dependencies: Record<string, string>
      }
      expect(inherited.dependencies["@smthrs/flow"]).toBe("1.0.0-rc.0")
      expect(inherited.dependencies["smthrs"]).toBe("0.35.0")
      expect(inherited.dependencies["effect"]).toBe(Archive.effectVersion)

      yield* Archive.run({
        root,
        unit: "project",
        kind: "project",
        sources: ["package.json"],
        targets: ["package.json"],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false
      })

      const final = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        dependencies: Record<string, string>
      }
      expect(final.dependencies["smthrs"]).toBeUndefined()
      expect(final.dependencies["@smthrs/flow"]).toBe("1.0.0-rc.0")
    }).pipe(Effect.provide(platform)))

  it.effect("moves the old sources into the archive and reports each one", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const archiveDir = join(root, ".smithers-migrate", "archive")

      const moved = yield* Archive.run({
        root,
        unit: "workflow:simple-workflow",
        kind: "workflow",
        targets: [],
        sources: ["simple-workflow.jsx", "prompts/simple-workflow/research.mdx"],
        archiveDir,
        keepOldSources: false
      })

      expect(moved.changed.map((entry) => entry.path)).toEqual([
        "prompts/simple-workflow/research.mdx",
        "simple-workflow.jsx"
      ])
      expect(moved.changed.every((entry) => entry.change === "archived")).toBe(true)
      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(false)
      expect(readFileSync(join(archiveDir, "simple-workflow.jsx"), "utf8"))
        .toBe(read("jsx-single", "simple-workflow.jsx"))
    }).pipe(Effect.provide(platform)))

  it.effect("keeps the source's mode in its archive copy", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const archiveDir = join(root, ".smithers-migrate", "archive")
      chmodSync(join(root, "simple-workflow.jsx"), 0o750)

      yield* Archive.run({
        root,
        unit: "workflow:simple-workflow",
        kind: "workflow",
        targets: [],
        sources: ["simple-workflow.jsx"],
        archiveDir,
        keepOldSources: false
      })

      // The copy is the record of the file as it was, permissions included.
      expect(statSync(join(archiveDir, "simple-workflow.jsx")).mode & 0o777).toBe(0o750)
      chmodSync(join(archiveDir, "simple-workflow.jsx"), 0o644)
    }).pipe(Effect.provide(platform)))

  it.effect("leaves the sources in place when the operator asked to keep them", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const moved = yield* Archive.run({
        root,
        unit: "workflow:simple-workflow",
        kind: "workflow",
        targets: [],
        sources: ["simple-workflow.jsx"],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: true
      })

      expect(moved.changed).toEqual([])
      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("ignores a source the unit named but the transform already removed", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const moved = yield* Archive.run({
        root,
        unit: "workflow:gone",
        kind: "workflow",
        targets: [],
        sources: ["never-existed.jsx"],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false
      })

      expect(moved.changed).toEqual([])
    }).pipe(Effect.provide(platform)))

  it.effect("rewrites the files a 1.0 project keeps instead of archiving them", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const result = yield* Archive.run({
        root,
        unit: "project",
        kind: "project",
        sources: ["package.json", "tsconfig.json", "preload.js"],
        targets: ["flows/seats.ts"],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false
      })

      // The manifest and the tsconfig are still where the project keeps them,
      // rewritten. Archiving them would delete the project.
      expect(existsSync(join(root, "package.json"))).toBe(true)
      expect(existsSync(join(root, "tsconfig.json"))).toBe(true)
      expect(existsSync(join(root, "preload.js"))).toBe(false)
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
        scripts: Record<string, string>
      }
      expect(manifest.dependencies["smthrs"]).toBeUndefined()
      expect(manifest.dependencies["effect"]).toBe(Archive.effectVersion)
      expect(manifest.scripts["start"]).toContain("smthrs flow start simple-workflow")
      const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
        compilerOptions: Record<string, unknown>
      }
      expect(tsconfig.compilerOptions["jsxImportSource"]).toBeUndefined()
      expect(result.changed.map((entry) => [entry.path, entry.change])).toEqual([
        ["package.json", "modified"],
        ["tsconfig.json", "modified"],
        ["preload.js", "archived"]
      ])
    }).pipe(Effect.provide(platform)))

  it.effect("preserves scanned documentation and command scripts after their in-place rewrites", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const archiveDir = join(root, ".smithers-migrate", "archive")
      const scripts = {
        "README.md": "Run `smithers up simple-workflow.jsx`\n",
        "docs/commands.md": "Run `smithers up simple-workflow.jsx`\n",
        "Makefile": "start:\n\tsmithers up simple-workflow.jsx\n",
        "scripts/start.sh": "#!/bin/sh\nsmithers up simple-workflow.jsx\n",
        "Justfile": "start:\n  smithers up simple-workflow.jsx\n",
        "scripts/justfile": "start:\n  smithers up simple-workflow.jsx\n",
        "Procfile": "worker: smithers up simple-workflow.jsx\n",
        "bunfig.toml": "# smithers up simple-workflow.jsx\n",
        ".github/workflows/start.yml": "jobs:\n  start:\n    steps:\n      - run: smithers up simple-workflow.jsx\n",
        ".github/workflows/start.yaml": "jobs:\n  start:\n    steps:\n      - run: smithers up simple-workflow.jsx\n",
        "docker-compose.yml": "services:\n  worker:\n    command: smithers up simple-workflow.jsx\n",
        "deploy/docker-compose.dev.yaml": "services:\n  worker:\n    command: smithers up simple-workflow.jsx\n"
      }
      for (const [file, text] of Object.entries(scripts)) {
        mkdirSync(dirname(join(root, file)), { recursive: true })
        writeFileSync(join(root, file), text)
      }
      chmodSync(join(root, "scripts/start.sh"), 0o755)
      const scan = yield* Scan.scan(root)
      const project = scan.units.find((unit) => unit.kind === "project")!
      const rewritten = Object.entries(scripts).map(([file, text]) =>
        [
          file,
          text.replace("smithers up simple-workflow.jsx", "smthrs flow start simple-workflow")
        ] as const
      )
      for (const [file, text] of rewritten) {
        expect(scan.detection.scripts.some((hit) => hit.file === file)).toBe(true)
        expect(project.sources).toContain(file)
        expect(project.targets).not.toContain(file)
        writeFileSync(join(root, file), text)
      }
      const retired = readFileSync(join(root, "preload.js"), "utf8")
      expect(project.sources).toContain("preload.js")

      const result = yield* Archive.run({
        ...project,
        root,
        unit: project.id,
        archiveDir,
        keepOldSources: false
      })

      for (const [file, text] of rewritten) {
        expect(existsSync(join(root, file)), file).toBe(true)
        expect(readFileSync(join(root, file), "utf8")).toBe(text)
        expect(existsSync(join(archiveDir, file)), file).toBe(false)
        expect(result.changed.some((entry) => entry.path === file)).toBe(false)
      }
      expect(statSync(join(root, "scripts/start.sh")).mode & 0o777).toBe(0o755)
      expect(existsSync(join(root, "preload.js"))).toBe(false)
      expect(readFileSync(join(archiveDir, "preload.js"), "utf8")).toBe(retired)
      expect(result.changed).toContainEqual({
        path: "preload.js",
        change: "archived",
        bytes: new TextEncoder().encode(retired).length
      })
    }).pipe(Effect.provide(platform)))

  it.effect("archives nothing for a unit whose sources are rewritten where they are", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const result = yield* Archive.run({
        root,
        unit: "integration:github",
        kind: "integration",
        sources: ["_example-kit.js"],
        targets: [],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false
      })

      expect(result.changed).toEqual([])
      expect(existsSync(join(root, "_example-kit.js"))).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("reports the script verbs 1.0 has no answer for instead of deleting them", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>
      }
      manifest.scripts["ui"] = "smithers gui --port 7331"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)

      const result = yield* Archive.run({
        root,
        unit: "project",
        kind: "project",
        sources: ["package.json"],
        targets: ["package.json"],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false
      })

      expect(result.unsupportedScripts).toEqual([
        {
          script: "ui",
          file: "package.json",
          reason: "Legacy CLI command requires manual mapping to the 1.0 command tree"
        }
      ])
      const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>
      }
      expect(after.scripts["ui"]).toBe("smithers gui --port 7331")
    }).pipe(Effect.provide(platform)))

  for (const through of ["file", "directory"] as const) {
    it.effect(`refuses to archive a source reached through a symlinked ${through}`, () =>
      Effect.gen(function*() {
        // Archiving reads the source and then removes it. Through a link that
        // copies a file from outside the project into the archive.
        const root = copyFixture("jsx-single")
        const outside = mkdtempSync(join(tmpdir(), "migrate-archive-outside-"))
        try {
          writeFileSync(join(outside, "shared.jsx"), "outside bytes\n")
          const source = through === "file" ? "linked.jsx" : "linked/shared.jsx"
          symlinkSync(
            through === "file" ? join(outside, "shared.jsx") : outside,
            join(root, through === "file" ? "linked.jsx" : "linked")
          )
          const archiveDir = join(root, ".smithers-migrate", "archive")

          const failure = yield* Effect.flip(Archive.run({
            root,
            unit: "workflow:linked",
            kind: "workflow",
            targets: [],
            sources: [source],
            archiveDir,
            keepOldSources: false
          }))

          expect(failure.code).toBe("invalid-layout")
          expect(failure.message).toContain("symbolic link")
          expect(existsSync(join(archiveDir, source))).toBe(false)
          expect(readFileSync(join(outside, "shared.jsx"), "utf8")).toBe("outside bytes\n")
          expect(lstatSync(join(root, through === "file" ? "linked.jsx" : "linked")).isSymbolicLink()).toBe(true)
        } finally {
          rmSync(outside, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(platform)))
  }

  it.effect("refuses to move a source that is 0.x run state", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      mkdirSync(join(root, ".smithers"), { recursive: true })
      writeFileSync(join(root, ".smithers", "smithers.db"), "a real database\n")

      // Tool code gets the rule the agent gets. The deterministic checks run
      // before the archive, so an archive that could reach run state would move
      // it with nothing left to notice.
      const failure = yield* Effect.flip(Archive.run({
        root,
        unit: "project",
        kind: "project",
        sources: [".smithers/smithers.db"],
        targets: [],
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false,
        runStatePaths: [".smithers/smithers.db"]
      }))

      expect(failure.code).toBe("run-state-blocked")
      expect(failure.message).toContain(".smithers/smithers.db")
      expect(existsSync(join(root, ".smithers", "smithers.db"))).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("writes every copy before it removes any source", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // The archive directory is a file, so the first copy cannot create its
      // parent directory and the move fails at its first step.
      writeFileSync(join(root, "archive"), "in the way\n")

      const failure = yield* Effect.flip(Archive.run({
        root,
        unit: "workflow:simple-workflow",
        kind: "workflow",
        sources: ["simple-workflow.jsx", "preload.js"],
        targets: [],
        archiveDir: join(root, "archive"),
        keepOldSources: false
      }))

      expect(failure.code).toBe("io")
      // Nothing was removed: a failed archive leaves the sources where a
      // restore can find them.
      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(true)
      expect(existsSync(join(root, "preload.js"))).toBe(true)
    }).pipe(Effect.provide(platform)))
})
