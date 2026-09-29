import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Archive from "@smthrs/migrate/flow/Archive"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import * as Transform from "@smthrs/migrate/flow/Transform"
import * as Scan from "@smthrs/migrate/Scan"
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { copyFixture } from "./fixtures/helpers.ts"

const workspace = fileURLToPath(new URL("../../../../", import.meta.url))
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url))
// Use the UI package's declared React dependencies through normal resolution.
const uiRequire = createRequire(join(workspace, "apps", "app", "package.json"))
const reactTypes = dirname(uiRequire.resolve("@types/react/package.json"))
const react = dirname(uiRequire.resolve("react/package.json"))
const app = "import * as React from 'react'\nexport const App = () => <div>Retained React UI</div>\n"

const config = (source?: string) => ({
  compilerOptions: {
    target: "ES2022",
    module: "Preserve",
    moduleResolution: "bundler",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    jsx: "react-jsx",
    ...(source === undefined ? {} : { jsxImportSource: source })
  },
  include: ["src/App.tsx"]
})

const installReact = (root: string): void => {
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "node_modules", "@types"), { recursive: true })
  symlinkSync(react, join(root, "node_modules", "react"), "dir")
  symlinkSync(reactTypes, join(root, "node_modules", "@types", "react"), "dir")
  writeFileSync(join(root, "src", "App.tsx"), app)
}

const compile = (root: string, tsconfig = "tsconfig.json"): void => {
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", tsconfig], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000
  })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

const project = (root: string) =>
  Effect.gen(function*() {
    const scanned = yield* Scan.scan(root)
    const outline = scanned.units.find((unit) => unit.id === "project")
    expect(outline).toBeDefined()
    if (outline === undefined) throw new Error("scan did not plan a project unit")
    return { scanned, outline: Transform.outline(scanned, outline, { root, mode: "plan" }) }
  })

describe("retained React JSX through project migration", () => {
  it.effect("keeps and verifies a hyphenated tsconfig while the React UI still compiles", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "migrate-react-hyphenated-"))
      const filename = "tsconfig-build.json"
      const configFile = join(root, filename)
      const archiveDir = join(root, ".smithers-migrate", "archive")
      try {
        installReact(root)
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({ name: "react-ui", dependencies: { react: "19.2.8" } })
        )
        writeFileSync(join(root, ".gitignore"), "node_modules\n")
        const initial = config("react")
        writeFileSync(
          configFile,
          `${
            JSON.stringify(
              {
                ...initial,
                compilerOptions: { ...initial.compilerOptions, paths: { "smthrs/*": ["./legacy/*"] } }
              },
              null,
              2
            )
          }\n`
        )
        compile(root, filename)

        const { scanned, outline } = yield* project(root)
        expect(scanned.detection.tsconfigs.map((entry) => entry.path)).toContain(filename)
        expect(outline.sources).toContain(filename)
        const result = yield* Archive.run({
          root,
          unit: outline.id,
          kind: "project",
          sources: outline.sources,
          targets: outline.targets,
          archiveDir,
          keepOldSources: false,
          specifiers: outline.specifiers
        })

        expect(existsSync(configFile)).toBe(true)
        expect(existsSync(join(archiveDir, filename))).toBe(false)
        expect(result.changed).toContainEqual(expect.objectContaining({ path: filename, change: "modified" }))
        const retained = JSON.parse(readFileSync(configFile, "utf8"))
        expect(retained.compilerOptions).toMatchObject({ jsx: "react-jsx", jsxImportSource: "react" })
        expect(retained.compilerOptions.paths).toBeUndefined()
        compile(root, filename)

        const check = (yield* MigrateFlow.postconditions(root, outline))
          .find((entry) => entry.name === "no tsconfig configures the 0.x JSX runtime")
        expect(check).toMatchObject({ ok: true, findings: [] })

        retained.compilerOptions.paths = { "smthrs/*": ["./legacy/*"] }
        writeFileSync(configFile, `${JSON.stringify(retained, null, 2)}\n`)
        const failedCheck = (yield* MigrateFlow.postconditions(root, outline))
          .find((entry) => entry.name === "no tsconfig configures the 0.x JSX runtime")
        expect(failedCheck).toMatchObject({
          ok: false,
          findings: [expect.objectContaining({ file: filename })]
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps the mixed project's React UI compiling before and after cleanup", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      installReact(root)
      writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify(config("react"), null, 2)}\n`)
      compile(root)

      const { scanned, outline } = yield* project(root)
      expect(scanned.units.some((unit) => unit.kind === "workflow")).toBe(true)
      expect(outline.sources).toContain("tsconfig.json")
      yield* Archive.run({
        root,
        unit: outline.id,
        kind: "project",
        sources: outline.sources,
        targets: outline.targets,
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false,
        specifiers: outline.specifiers
      })

      expect(existsSync(join(root, "src", "App.tsx"))).toBe(true)
      expect(JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")).compilerOptions)
        .toMatchObject({ jsx: "react-jsx", jsxImportSource: "react" })
      compile(root)
      const checks = yield* MigrateFlow.postconditions(root, outline)
      expect(checks.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime"))
        .toMatchObject({ ok: true, findings: [] })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps a React-only configuration without an import source", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "migrate-react-only-"))
      try {
        installReact(root)
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({ name: "react-only", dependencies: { react: "19.2.8" } })
        )
        writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify(config(), null, 2)}\n`)
        writeFileSync(join(root, ".gitignore"), "node_modules\n")
        compile(root)
        const { scanned, outline } = yield* project(root)
        expect(scanned.units.some((unit) => unit.kind === "workflow")).toBe(false)
        yield* Archive.run({
          root,
          unit: outline.id,
          kind: "project",
          sources: outline.sources,
          targets: outline.targets,
          archiveDir: join(root, ".smithers-migrate", "archive"),
          keepOldSources: false,
          specifiers: outline.specifiers
        })
        expect(JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")).compilerOptions.jsx).toBe("react-jsx")
        compile(root)
        const checks = yield* MigrateFlow.postconditions(root, outline)
        expect(checks.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime"))
          .toMatchObject({ ok: true, findings: [] })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("removes a retired scoped JSX runtime when the manifest supplies oldScoped evidence", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const manifestFile = join(root, "package.json")
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
      manifest.dependencies["@smthrs/core"] = "0.35.0"
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      const configFile = join(root, "tsconfig.json")
      const tsconfig = JSON.parse(readFileSync(configFile, "utf8"))
      tsconfig.compilerOptions.jsxImportSource = "@smthrs/core"
      writeFileSync(configFile, `${JSON.stringify(tsconfig, null, 2)}\n`)
      const { outline } = yield* project(root)
      expect(outline.specifiers.oldScoped).toContain("core")
      yield* Archive.run({
        root,
        unit: outline.id,
        kind: "project",
        sources: outline.sources,
        targets: outline.targets,
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false,
        specifiers: outline.specifiers
      })
      const options = JSON.parse(readFileSync(configFile, "utf8")).compilerOptions
      expect(options.jsx).toBeUndefined()
      expect(options.jsxImportSource).toBeUndefined()
      const checks = yield* MigrateFlow.postconditions(root, outline)
      expect(checks.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime"))
        .toMatchObject({ ok: true, findings: [] })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("preserves an unrelated JSX import source through cleanup and postconditions", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const configFile = join(root, "tsconfig.json")
      const tsconfig = JSON.parse(readFileSync(configFile, "utf8"))
      tsconfig.compilerOptions.jsxImportSource = "preact"
      writeFileSync(configFile, `${JSON.stringify(tsconfig, null, 2)}\n`)
      const { outline } = yield* project(root)
      yield* Archive.run({
        root,
        unit: outline.id,
        kind: "project",
        sources: outline.sources,
        targets: outline.targets,
        archiveDir: join(root, ".smithers-migrate", "archive"),
        keepOldSources: false,
        specifiers: outline.specifiers
      })
      expect(JSON.parse(readFileSync(configFile, "utf8")).compilerOptions)
        .toMatchObject({ jsx: "react-jsx", jsxImportSource: "preact" })
      const checks = yield* MigrateFlow.postconditions(root, outline)
      expect(checks.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime"))
        .toMatchObject({ ok: true, findings: [] })
    }).pipe(Effect.provide(NodeServices.layer)))
})
