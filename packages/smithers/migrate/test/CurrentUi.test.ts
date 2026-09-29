import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Detect from "@smthrs/migrate/Detect"
import * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import type * as Options from "@smthrs/migrate/flow/Options"
import * as Scan from "@smthrs/migrate/Scan"
import * as Effect from "effect/Effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { copyFixture, fixture } from "./fixtures/helpers.ts"

const uiImport = "import { statusClass } from \"@smthrs/ui/status\"\nexport const action = statusClass(\"healthy\")\n"

const mixedProject = () => {
  const root = copyFixture("jsx-single")
  // Earlier units remove this 0.x preload; this case starts at project finish.
  rmSync(join(root, "bunfig.toml"))
  rmSync(join(root, "preload.js"))
  const manifestPath = join(root, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>
  }
  manifest.dependencies["@smthrs/ui"] = "1.0.0-rc.1"
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  mkdirSync(join(root, "lib"), { recursive: true })
  writeFileSync(join(root, "lib", "ui.ts"), uiImport)
  mkdirSync(join(root, "node_modules", "@smthrs"), { recursive: true })
  symlinkSync(fileURLToPath(new URL("../../ui/", import.meta.url)), join(root, "node_modules", "@smthrs", "ui"), "dir")
  return root
}

const uiProject = (version: string) => {
  const root = mkdtempSync(join(tmpdir(), "migrate-ui-"))
  writeFileSync(
    join(root, "package.json"),
    `${
      JSON.stringify({
        name: "ui-project",
        type: "module",
        dependencies: { "@smthrs/ui": version }
      })
    }\n`
  )
  mkdirSync(join(root, "lib"))
  writeFileSync(join(root, "lib", "ui.ts"), uiImport)
  return root
}

describe("current @smthrs/ui migration", () => {
  it("classifies retired UI by version while accepting current UI imports", () => {
    for (const version of ["^0.35.0", "0.35.0"]) {
      expect(Detect.classifyPackage("@smthrs/ui", version)).toBe("old-version")
    }
    for (const version of ["1.0.0-rc.0", "1.0.0-rc.1", "1.0.0", "workspace:*"]) {
      expect(Detect.classifyPackage("@smthrs/ui", version)).toBeUndefined()
    }
    expect(Detect.isOldSpecifier("@smthrs/ui", { oldScoped: ["ui"] })).toBe(true)
    expect(Detect.isOldSpecifier("@smthrs/ui/components", { oldScoped: ["ui"] })).toBe(true)
    expect(Detect.isOldSpecifier("@smthrs/ui")).toBe(false)
    expect(Detect.isOldSpecifier("@smthrs/ui/components")).toBe(false)
  })

  it.effect("scans a mixed project without assigning current UI to a migration unit", () =>
    Effect.gen(function*() {
      const root = mixedProject()
      const scanned = yield* Scan.scan(root)
      const oldPackages = scanned.detection.manifests.flatMap((manifest) => manifest.oldPackages)
      expect(oldPackages).toContainEqual({
        name: "smthrs",
        version: "0.35.0",
        field: "dependencies",
        reason: "old-name"
      })
      expect(oldPackages.some((entry) => entry.name === "@smthrs/ui")).toBe(false)
      expect(
        scanned.detection.imports.find((entry) => entry.file === "lib/ui.ts" && entry.specifier === "@smthrs/ui/status")
          ?.kind
      )
        .not.toBe("old")
      expect(scanned.units.some((unit) => unit.id === "project")).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("scans current-only UI as current and retired UI as old", () =>
    Effect.gen(function*() {
      const currentRoot = uiProject("1.0.0-rc.1")
      const retiredRoot = uiProject("0.35.0")
      try {
        const current = yield* Scan.scan(currentRoot)
        expect(current.detection.manifests.flatMap((manifest) => manifest.oldPackages)).toEqual([])
        expect(
          current.detection.imports.find((entry) =>
            entry.file === "lib/ui.ts" && entry.specifier === "@smthrs/ui/status"
          )?.kind
        )
          .not.toBe("old")
        expect(current.units.flatMap((unit) => unit.specifiers.oldScoped)).toEqual([])

        const retired = yield* Scan.scan(retiredRoot)
        expect(retired.detection.manifests.flatMap((manifest) => manifest.oldPackages)).toContainEqual({
          name: "@smthrs/ui",
          version: "0.35.0",
          field: "dependencies",
          reason: "old-version"
        })
        expect(
          retired.detection.imports.find((entry) =>
            entry.file === "lib/ui.ts" && entry.specifier === "@smthrs/ui/status"
          )?.kind
        )
          .toBe("old")
      } finally {
        rmSync(currentRoot, { recursive: true, force: true })
        rmSync(retiredRoot, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps the UI dependency and import through the exported project finish", () =>
    Effect.gen(function*() {
      const root = mixedProject()
      const chosen: Options.MigrateOptions = {
        root,
        mode: "apply",
        commands: {
          typecheck: [],
          test:
            "bun -e 'import { action } from \"./lib/ui.ts\"; import { readFileSync } from \"node:fs\"; const manifest = JSON.parse(readFileSync(\"package.json\", \"utf8\")); if (action !== \"ok\" || manifest.dependencies[\"@smthrs/ui\"] !== \"1.0.0-rc.1\") process.exit(1)'"
        }
      }
      const scanned = yield* MigrateFlow.scan(chosen)
      const outline = MigrateFlow.outlines(scanned, chosen).find((unit) => unit.id === "project")!
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(
        join(root, "flows", "simple-workflow", "flow.ts"),
        readFileSync(join(fixture("jsx-single.migrated"), "flows", "simple-workflow", "flow.ts"), "utf8")
      )
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: [...new Set([...outline.sources, ...outline.targets])].sort(),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate", ".flows"]
      })
      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: { unit: outline.id, changedFiles: [], decisions: [], unresolved: [], unsupported: [], notes: "" },
        verification: {
          install: {
            command: "",
            exitCode: 0,
            durationMs: 0,
            stdoutTail: "",
            stderrTail: "",
            skipped: "not needed here"
          },
          format: {
            command: "",
            exitCode: 0,
            durationMs: 0,
            stdoutTail: "",
            stderrTail: "",
            skipped: "not needed here"
          },
          typecheck: [],
          tests: {
            command: "",
            exitCode: 0,
            durationMs: 0,
            stdoutTail: "",
            stderrTail: "",
            skipped: "not needed here"
          },
          discovery: { command: "discovery flows", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "" }
        },
        repairRounds: 0
      })

      expect(outcome.status, JSON.stringify({ unresolved: outcome.unresolved, verification: outcome.verification }))
        .toBe(
          "migrated"
        )
      expect(outcome.verification?.tests?.command).toBe(chosen.commands?.test)
      expect(outcome.verification?.tests?.exitCode).toBe(0)
      expect(outcome.verification?.tests?.skipped).toBeUndefined()
      const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      expect(after.dependencies["smthrs"]).toBeUndefined()
      expect(after.dependencies["@smthrs/ui"]).toBe("1.0.0-rc.1")
      expect(readFileSync(join(root, "lib", "ui.ts"), "utf8")).toBe(uiImport)
    }).pipe(Effect.provide(NodeServices.layer)))
})
