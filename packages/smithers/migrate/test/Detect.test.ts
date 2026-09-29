import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import * as Detect from "../src/Detect.ts"
import * as Fs from "../src/internal/Fs.ts"
import { copyFixture, nodeLayer } from "./fixtures/helpers.ts"

const detect = (root: string, options: Detect.ScanOptions = {}) =>
  Detect.scan(root, options).pipe(Effect.provide(nodeLayer))

describe("Detect.classifyPackage", () => {
  it("leaves unsupported numeric versions unresolved instead of planning shared-package deletion", () => {
    const tooLarge = "9007199254740992"
    const beyondBinary64 = "9".repeat(311)
    for (const numeric of [tooLarge, beyondBinary64]) {
      for (const specifier of [`${numeric}.0.0`, `0.${numeric}.0`, `0.0.${numeric}`]) {
        expect(Detect.classifyPackage("@smthrs/flow", specifier)).toBeUndefined()
        expect(Detect.classifyPackage("@smthrs/cli", specifier)).toBeUndefined()
        expect(Detect.classifyPackage("smithers", specifier)).toBeUndefined()
      }
    }
    expect(Detect.classifyPackage("@smthrs/flow", "0.35.0")).toBe("old-version")
    expect(Detect.classifyPackage("@smthrs/components", `0.${tooLarge}.0`)).toBe("deleted-package")
  })

  it("decides an old-tree-only name by name and a shared name by version", () => {
    expect(Detect.classifyPackage("smthrs", "0.35.0")).toBe("old-name")
    expect(Detect.classifyPackage("smithers-orchestrator", "file:../../smithers/packages/smithers")).toBe("old-name")
    expect(Detect.classifyPackage("@smithers/components", "0.1.0")).toBe("old-scope")
    expect(Detect.classifyPackage("@smthrs/components", "0.35.0")).toBe("deleted-package")
    expect(Detect.classifyPackage("@smthrs/cli", "0.35.0")).toBe("old-version")
    expect(Detect.classifyPackage("@smthrs/cli", "1.0.0-rc.0")).toBeUndefined()
    expect(Detect.classifyPackage("@smthrs/ui", "0.35.0")).toBe("old-version")
    expect(Detect.classifyPackage("@smthrs/ui", "1.0.0-rc.1")).toBeUndefined()
    expect(Detect.isOldSpecifier("@smthrs/ui")).toBe(false)
    expect(Detect.isOldSpecifier("@smthrs/ui/Button", { oldScoped: ["ui"] })).toBe(true)
    expect(Detect.isOldSpecifier("@smthrs/ui/Button")).toBe(false)
    expect(Detect.classifyPackage("effect", "4.0.0-beta.105")).toBeUndefined()
  })

  it("decides the bare name by its spec", () => {
    // A pack inside the old monorepo links the facade by directory name. The
    // name alone proves nothing: `smithers` is not a Smithers package on the
    // registry.
    expect(Detect.classifyPackage("smithers", "file:../../../../smithers")).toBe("old-name")
    expect(Detect.classifyPackage("smithers", "link:../smithers")).toBe("old-name")
    expect(Detect.classifyPackage("smithers", "workspace:*")).toBe("old-name")
    // A scoped 1.0 package pinned by a 1.0 monorepo's own protocol is not old;
    // a checkout link on this machine is.
    expect(Detect.classifyPackage("@smthrs/flow", "workspace:*")).toBeUndefined()
    expect(Detect.classifyPackage("@smthrs/flow", "catalog:")).toBeUndefined()
    expect(Detect.classifyPackage("@smthrs/flow", "*")).toBeUndefined()
    expect(Detect.classifyPackage("@smthrs/flow", "latest")).toBeUndefined()
    expect(Detect.classifyPackage("@smthrs/flow", "npm:@smthrs/flow@1.0.0-rc.0")).toBeUndefined()
    expect(Detect.classifyPackage("@smthrs/flow", "file:../smithers/packages/smithers/flows/flow")).toBe("old-version")
    expect(Detect.classifyPackage("@smthrs/flow", "link:../smithers/packages/smithers/flows/flow")).toBe("old-version")
    expect(Detect.classifyPackage("@smthrs/components", "file:../smithers/packages/components")).toBe("deleted-package")
    expect(Detect.classifyPackage("@smthrs/flow", "0.35.0")).toBe("old-version")
    expect(Detect.classifyPackage("smithers", "0.35.0")).toBe("old-version")
    expect(Detect.classifyPackage("smithers", "^2.1.0")).toBeUndefined()
    expect(Detect.classifyPackage("smithers", "latest")).toBeUndefined()
  })

  it("decides a name the 1.0 tree deleted by name, whatever it is pinned to", () => {
    // `@smthrs/components` has no 1.0 release, so every specifier on it names
    // a package that only ever existed in the 0.x tree. The spec-based rule
    // that keeps `@smthrs/flow: workspace:*` is about names that exist in both
    // trees; applying it here left a dependency nothing can install out of
    // `oldPackages`, so no unit planned it, the archive never removed it, and
    // the postconditions passed over it.
    for (const version of ["workspace:*", "catalog:", "*", "latest", "0.35.0", "1.0.0-rc.0"]) {
      expect(Detect.classifyPackage("@smthrs/components", version)).toBe("deleted-package")
    }
    expect(Detect.classifyPackage("@smthrs/gateway-ui", "latest")).toBe("deleted-package")
    expect(Detect.classifyPackage("@smthrs/react-reconciler", "npm:@smthrs/react-reconciler@0.35.0"))
      .toBe("deleted-package")
    // The import classifier already decided the same names by name alone, and
    // the two halves of the same detection must not disagree.
    expect(Detect.isOldSpecifier("@smthrs/components")).toBe(true)
  })
})

describe("Detect.classifyPrompt", () => {
  it("separates interpolation-only prompts from JSX ones", () => {
    expect(Detect.classifyPrompt("Research this: {props.topic}")).toEqual({
      classification: "interpolation-only",
      props: ["topic"]
    })
    expect(Detect.classifyPrompt("Key points: {JSON.stringify(props.keyPoints)}")).toEqual({
      classification: "interpolation-only",
      props: ["keyPoints"]
    })
    expect(Detect.classifyPrompt("import Shared from \"./shared.mdx\"\n\nHello").classification).toBe("jsx")
    expect(Detect.classifyPrompt("Total: {props.items.length}").classification).toBe("jsx")
  })
})

describe("Detect.scan over jsx-single", () => {
  it.effect("finds the old dependency, the effect pin conflict, and the tsconfig JSX settings", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const detection = yield* detect(root)

      const manifest = detection.manifests.find((entry) => entry.kind === "root")
      expect(manifest?.oldPackages).toEqual([
        { name: "smthrs", version: "0.35.0", field: "dependencies", reason: "old-name" }
      ])
      expect(manifest?.companions.map((entry) => entry.name).sort()).toEqual([
        "@ai-sdk/anthropic",
        "ai",
        "effect",
        "zod"
      ])
      expect(detection.effectPin).toBe("4.0.0-beta.105")
      expect(detection.warnings.some((warning) => warning.code === "effect-pin-conflict")).toBe(true)

      const tsconfig = detection.tsconfigs.find((entry) => entry.path === "tsconfig.json")
      expect(tsconfig?.jsx).toBe("react-jsx")
      expect(tsconfig?.jsxImportSource).toBe("smthrs")
    }))

  it.effect("reads a tsconfig whose own text looks like a comment, path mappings and include alike", () =>
    Effect.gen(function*() {
      // The shape this tool exists to find, and the shape a regular expression
      // could not read: a `smthrs/*` path mapping beside a `**\/*` include,
      // which carries two `/*` sequences and a `*\/` between them. Stripping
      // comments by pattern deleted the middle of the include list, and with a
      // path mapping in front of it the file stopped parsing at all, so the
      // tsconfig never entered the detection: no unit owned it, no rewrite
      // reached it, and no typecheck ran over it.
      const root = copyFixture("jsx-single")
      writeFileSync(
        join(root, "tsconfig.json"),
        [
          "{",
          "  // the compiler options this project builds with",
          "  \"compilerOptions\": {",
          "    \"jsx\": \"react-jsx\",",
          "    \"jsxImportSource\": \"smthrs\", /* the 0.x runtime */",
          "    \"types\": [\"node\"],",
          "    \"paths\": {",
          "      \"smthrs/*\": [\"./node_modules/smthrs/*\"],",
          "      \"@/*\": [\"./src/*\"],",
          "    }",
          "  },",
          "  \"include\": [\"**/*.ts\", \"**/*.tsx\", \"**/*.jsx\", \"**/*.js\"]",
          "}",
          ""
        ].join("\n")
      )

      const detection = yield* detect(root)
      const tsconfig = detection.tsconfigs.find((entry) => entry.path === "tsconfig.json")

      // Only the 0.x mappings: the project's own `@/*` alias is not the
      // migration's business, and the finding exists to name what has to go.
      expect(tsconfig?.paths).toEqual(["smthrs/*"])
      expect(tsconfig?.include).toEqual(["**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.js"])
      expect(tsconfig?.types).toEqual(["node"])
      expect(tsconfig?.jsx).toBe("react-jsx")
      expect(tsconfig?.jsxImportSource).toBe("smthrs")
      expect(detection.warnings.some((warning) => warning.code === "unparsable-tsconfig")).toBe(false)
    }))

  it.effect("names the global state paths with one separator whatever the environment spelled", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // macOS ends TMPDIR with a slash and Linux does not; the two halves of a
      // detection have to agree on the path the operator is told about.
      const trailing = yield* detect(root, { environment: { HOME: "/home/op/", TMPDIR: "/tmp/t/" } })
      const bare = yield* detect(root, { environment: { HOME: "/home/op", TMPDIR: "/tmp/t" } })
      expect(trailing.globalState).toEqual(["/home/op/.smithers", "/tmp/t/smithers-gateway"])
      expect(bare.globalState).toEqual(trailing.globalState)
      const empty = yield* detect(root, { environment: { HOME: "", TMPDIR: "/" } })
      expect(empty.globalState).toEqual([])
    }))

  it.effect("judges every effect declaration against the exact release pin, manifests and lockfiles alike", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
        devDependencies?: Record<string, string>
      }
      // A range, a later prerelease, and a second manifest that disagrees:
      // each is a version this release was not built against.
      manifest.dependencies["effect"] = "^4.0.0-rc.115"
      manifest.devDependencies = { effect: "4.0.0-rc.999" }
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      mkdirSync(join(root, "packages", "member"), { recursive: true })
      writeFileSync(
        join(root, "packages", "member", "package.json"),
        `${JSON.stringify({ name: "member", dependencies: { effect: "4.0.0-rc.107" } })}\n`
      )
      writeFileSync(
        join(root, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n\npackages:\n\n  effect@4.0.0-rc.107:\n    resolution: {integrity: sha512-x}\n\n  '@effect/platform-node@4.0.0-rc.115':\n    resolution: {integrity: sha512-y}\n"
      )

      const detection = yield* detect(root)

      expect(detection.effectPin).toBe("^4.0.0-rc.115")
      expect(detection.effectDeclarations).toEqual([
        { file: "package.json", field: "dependencies", version: "^4.0.0-rc.115" },
        { file: "package.json", field: "devDependencies", version: "4.0.0-rc.999" },
        { file: "packages/member/package.json", field: "dependencies", version: "4.0.0-rc.107" }
      ])
      const conflicts = detection.warnings.filter((warning) => warning.code === "effect-pin-conflict")
      expect(conflicts.map((warning) => `${warning.file}: ${warning.message}`)).toEqual([
        "package.json: dependencies.\"effect\" is \"^4.0.0-rc.115\"; Smithers 1.0 requires exactly 4.0.0-rc.115",
        "package.json: devDependencies.\"effect\" is \"4.0.0-rc.999\"; Smithers 1.0 requires exactly 4.0.0-rc.115",
        "packages/member/package.json: dependencies.\"effect\" is \"4.0.0-rc.107\"; Smithers 1.0 requires exactly 4.0.0-rc.115",
        "package.json: the manifests declare effect as \"4.0.0-rc.107\", \"4.0.0-rc.999\", \"^4.0.0-rc.115\"; one version, 4.0.0-rc.115, has to be declared everywhere",
        "pnpm-lock.yaml: \"pnpm-lock.yaml\" resolves effect to \"4.0.0-rc.107\"; Smithers 1.0 requires exactly 4.0.0-rc.115"
      ])

      // The exact pin everywhere is the one shape that earns no warning.
      manifest.dependencies["effect"] = "4.0.0-rc.115"
      manifest.devDependencies = { effect: "4.0.0-rc.115" }
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      writeFileSync(
        join(root, "packages", "member", "package.json"),
        `${JSON.stringify({ name: "member", dependencies: { effect: "4.0.0-rc.115" } })}\n`
      )
      writeFileSync(
        join(root, "pnpm-lock.yaml"),
        "packages:\n\n  effect@4.0.0-rc.115:\n    resolution: {integrity: sha512-x}\n"
      )
      const pinned = yield* detect(root)
      expect(pinned.warnings.filter((warning) => warning.code === "effect-pin-conflict")).toEqual([])
    }))

  it("reads the version each lockfile dialect resolved effect to", () => {
    expect(
      Detect.resolvedEffectVersions(
        "  effect@4.0.0-rc.115:\n  '@effect/platform-node@4.0.0-rc.115':\n  redux-effect@1.2.3:\n"
      )
    )
      .toEqual(["4.0.0-rc.115"])
    expect(Detect.resolvedEffectVersions("\"effect\": [\"effect@4.0.0-rc.107\", \"\", {}, \"sha512-x\"],"))
      .toEqual(["4.0.0-rc.107"])
    expect(
      Detect.resolvedEffectVersions("\"node_modules/effect\": {\n  \"version\": \"3.19.0\",\n  \"resolved\": \"x\"\n}")
    )
      .toEqual(["3.19.0"])
    expect(Detect.resolvedEffectVersions("\"effect@npm:^4.0.0-rc.115\":\n  version: 4.0.0-rc.115\n  resolution: x\n"))
      .toEqual(["4.0.0-rc.115"])
    expect(Detect.resolvedEffectVersions("nothing here")).toEqual([])
  })

  it.effect("reports every path it could not read or would not descend into, instead of dropping it", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // Deeper than the walk goes: fourteen directories, a workflow at the bottom.
      const deep = join(root, ...Array.from({ length: 14 }, (_, index) => `d${index}`))
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, "lost.jsx"), "/** @jsxImportSource smthrs */\n")
      // Larger than the scanner reads.
      writeFileSync(join(root, "huge.js"), Buffer.alloc(Fs.maxFileBytes + 1, 0x20))

      const detection = yield* detect(root)

      const skipped = detection.warnings.filter((warning) => warning.code === "incomplete-scan")
      expect(skipped.map((warning) => warning.file)).toEqual([
        "d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12",
        "huge.js"
      ])
      expect(skipped[0]?.message).toContain("more than 12 directories deep")
      expect(skipped[1]?.message).toContain("above the 8388608 byte scan limit")
      expect(detection.files).not.toContain("d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/d13/lost.jsx")
    }))

  it.effect("never reads a source through a link that leads out of the project, and says so", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const outside = mkdtempSync(join(tmpdir(), "migrate-detect-outside-"))
      try {
        writeFileSync(join(outside, "leak.jsx"), "/** @jsxImportSource smthrs */\nexport const secret = 1\n")
        symlinkSync(outside, join(root, "external"))
        symlinkSync(join(outside, "leak.jsx"), join(root, "leak.jsx"))

        const detection = yield* detect(root)

        expect(detection.files.filter((file) => file.includes("leak"))).toEqual([])
        expect([...detection.sources.keys()].filter((file) => file.includes("leak"))).toEqual([])
        const skipped = detection.warnings.filter((warning) => warning.code === "incomplete-scan")
        expect(skipped.map((warning) => warning.file)).toEqual(["external", "leak.jsx"])
        expect(skipped[0]?.message).toContain("symbolic link that leads outside the project")
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    }))

  it.effect.skipIf(userInfo().uid === 0)(
    "reports a directory it cannot list as an incomplete scan",
    () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        mkdirSync(join(root, "locked"))
        writeFileSync(join(root, "locked", "hidden.jsx"), "/** @jsxImportSource smthrs */\n")
        chmodSync(join(root, "locked"), 0o000)
        try {
          const detection = yield* detect(root)
          const skipped = detection.warnings.filter((warning) => warning.code === "incomplete-scan")
          expect(skipped.map((warning) => warning.file)).toEqual(["locked"])
          expect(skipped[0]?.message).toContain("could not be listed")
        } finally {
          chmodSync(join(root, "locked"), 0o755)
        }
      })
  )

  it.effect("finds one workflow with no pragma, both prompts, and the test file", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const detection = yield* detect(root)

      expect(detection.workflowFiles.map((entry) => `${entry.path}:${entry.api}:${entry.kind}`)).toEqual([
        "simple-workflow.jsx:smthrs:jsx"
      ])
      expect(detection.pragmas).toEqual([])
      expect(detection.prompts.map((entry) => `${entry.path}:${entry.classification}`).sort()).toEqual([
        "prompts/simple-workflow/research.mdx:interpolation-only",
        "prompts/simple-workflow/write.mdx:interpolation-only"
      ])
      expect(detection.tests).toEqual(["tests/_setup.ts"])
      expect(detection.libs).toEqual(["_example-kit.js"])
    }))

  it.effect("finds the old CLI script and the mdxPlugin preload", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const detection = yield* detect(root)

      expect(detection.scripts.some((hit) => hit.kind === "cli-verb" && hit.text === "smithers up")).toBe(true)
      expect(detection.config.preload).toEqual([{ path: "preload.js", mdxPlugin: true }])
      expect(detection.config.bunfig).toEqual([{ path: "bunfig.toml", preload: ["./preload.js"] }])
      expect(detection.config.assetTypes).toEqual(["mdx-assets.d.ts"])
      expect(detection.lockfiles).toEqual([])
    }))
})

describe("Detect.scan over plue-pack", () => {
  it.effect("finds the pre-rename package under a workspace member manifest", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* detect(root)

      const pack = detection.manifests.find((entry) => entry.path === ".smithers/package.json")
      expect(pack?.kind).toBe("smithers")
      expect(pack?.oldPackages).toEqual([
        { name: "smithers-orchestrator", version: "0.32.0", field: "dependencies", reason: "old-name" }
      ])
      expect(detection.manifests.find((entry) => entry.kind === "root")?.workspaces).toEqual([".smithers"])
    }))

  it.effect("classifies every workflow file, including the foreign one", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* detect(root)

      expect(detection.workflowFiles.map((entry) => `${entry.path}:${entry.api}`).sort()).toEqual([
        ".smithers/workflows/implement.tsx:smithers-orchestrator",
        ".smithers/workflows/pipelines/ci-fast.tsx:smithers-orchestrator",
        ".smithers/workflows/ralph.tsx:smithers-orchestrator",
        ".smithers/workflows/release.tsx:foreign",
        ".smithers/workflows/review.tsx:smithers-orchestrator"
      ])
      expect(
        detection.warnings.filter((warning) => warning.code === "unknown-authoring-api").map((warning) => warning.file)
      ).toEqual([".smithers/workflows/release.tsx"])
    }))

  it.effect("parses the smithers-* headers on a workflow", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* detect(root)

      const ralph = detection.workflowFiles.find((entry) => entry.path.endsWith("ralph.tsx"))
      expect(ralph?.headers.get("source")).toBe("seeded")
      expect(ralph?.headers.get("display-name")).toBe("Ralph")
    }))

  it.effect("finds the pragma spelling, the tsconfig import source, and the shared components", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* detect(root)

      expect(detection.pragmas.every((hit) => hit.text.includes("smithers-orchestrator"))).toBe(true)
      expect(detection.pragmas.map((hit) => hit.file)).toContain(".smithers/workflows/ralph.tsx")
      expect(detection.tsconfigs[0]?.jsxImportSource).toBe("smithers-orchestrator")
      expect([...detection.components].sort()).toEqual([
        ".smithers/components/Review.tsx",
        ".smithers/components/ValidationLoop.tsx",
        ".smithers/components/roles.ts"
      ])
      expect(detection.libs).toContain(".smithers/agents.ts")
    }))

  it.effect("resolves the <UI entry> to a file and records the workflow that names it", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* detect(root)

      expect(detection.uis).toEqual([
        {
          path: ".smithers/ui/pipelines-ci-fast.tsx",
          resolved: true,
          referencedBy: [".smithers/workflows/pipelines/ci-fast.tsx"]
        }
      ])
      expect(detection.warnings.some((warning) => warning.code === "unresolved-ui-entry")).toBe(false)
    }))

  it.effect("records a missing <UI entry> as a warning", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      writeFileSync(
        join(root, ".smithers", "workflows", "gone.tsx"),
        [
          "/** @jsxImportSource smithers-orchestrator */",
          "import { UI, createSmithers } from \"smithers-orchestrator\";",
          "const { Workflow, smithers } = createSmithers({});",
          "export default smithers(() => (<Workflow name=\"gone\"><UI entry=\"../ui/missing.tsx\" /></Workflow>));",
          ""
        ].join("\n")
      )
      const detection = yield* detect(root)

      expect(detection.warnings.some((warning) => warning.code === "unresolved-ui-entry")).toBe(true)
      expect(detection.uis.some((entry) => entry.path === "../ui/missing.tsx" && !entry.resolved)).toBe(true)
    }))

  it.effect("finds both old CLI scripts and the documentation mention", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* detect(root)

      expect(detection.scripts.filter((hit) => hit.file === "package.json").map((hit) => hit.text).sort()).toEqual([
        "bunx smthrs",
        "smithers workflow"
      ])
      expect(detection.scripts.some((hit) => hit.file === "CLAUDE.md" && hit.text === "smithers up")).toBe(true)
    }))

  it.effect("parses smithers.config.ts and the preload plugin", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const detection = yield* detect(root)

      expect(detection.config.smithersConfig?.path).toBe(".smithers/smithers.config.ts")
      expect(detection.config.smithersConfig?.backend).toBeUndefined()
      expect(detection.config.preload).toEqual([{ path: ".smithers/preload.ts", mdxPlugin: true }])
      expect([...detection.config.agents].sort()).toEqual([
        ".smithers/agents.ts",
        ".smithers/agents/claude-code.ts",
        ".smithers/agents/codex.ts",
        ".smithers/agents/index.ts",
        ".smithers/agents/opencode.ts"
      ])
    }))
})

describe("Detect.scan over persisted-db", () => {
  it.effect("reads the sqlite backend and the repoCommands from smithers.config.ts", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const detection = yield* detect(root)

      expect(detection.config.smithersConfig?.backend).toBe("sqlite")
      expect(detection.config.smithersConfig?.repoCommands.get("test")).toBe("bun test tests")
    }))

  it.effect("never walks into the executions directory", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const detection = yield* detect(root)

      expect(detection.files.some((file) => file.startsWith(".smithers/executions/"))).toBe(false)
    }))
})

describe("Detect.scan over batch-issues", () => {
  it.effect("treats the bare specifier as the old facade because the manifest links it", () =>
    Effect.gen(function*() {
      const root = copyFixture("batch-issues")
      const detection = yield* detect(root)
      const pack = detection.manifests.find((entry) => entry.path.endsWith("batch-issues/package.json"))

      expect(pack?.oldPackages).toEqual([
        {
          name: "smithers",
          version: "file:../../../../smithers",
          field: "dependencies",
          reason: "old-name"
        }
      ])
      const old = detection.imports.filter((hit) => hit.kind === "old" && hit.specifier === "smithers")
      expect(old.length).toBeGreaterThan(10)
      expect(detection.imports.some((hit) => hit.kind === "old" && hit.specifier === "smithers/tools")).toBe(true)
    }))

  it.effect("calls the pack's own manifest workflow-adjacent", () =>
    Effect.gen(function*() {
      const root = copyFixture("batch-issues")
      const detection = yield* detect(root)

      expect(detection.manifests.map((entry) => `${entry.path}:${entry.kind}`)).toEqual([
        ".smithers/workflows/batch-issues/package.json:workflow-adjacent",
        "package.json:root"
      ])
    }))

  it.effect("keeps schemas, prompts, and config out of the workflow list", () =>
    Effect.gen(function*() {
      const root = copyFixture("batch-issues")
      const detection = yield* detect(root)
      const paths = detection.workflowFiles.map((workflow) => workflow.path)

      // A `.ts` or `.mdx` file under the workflow directory has to earn the
      // name; only the JSX files are workflows here.
      expect(paths.every((path) => path.endsWith(".tsx"))).toBe(true)
      expect(paths).toContain(".smithers/workflows/batch-issues/workflow.tsx")
      expect(paths.some((path) => path.includes("/schemas/"))).toBe(false)
      expect(paths.some((path) => path.includes("/prompts/"))).toBe(false)
      expect(detection.libs).toContain(".smithers/workflows/batch-issues/smithers.ts")
    }))

  it.effect("gives the pack one workflow and files its components as components", () =>
    Effect.gen(function*() {
      const root = copyFixture("batch-issues")
      const detection = yield* detect(root)

      // Only `workflow.tsx` default-exports the factory call. The other
      // thirteen `.tsx` files export function components, and planning them as
      // flows would give the pack fourteen flows and one real one.
      expect(detection.workflowFiles.map((workflow) => `${workflow.path}:${workflow.api}`)).toEqual([
        ".smithers/workflows/batch-issues/workflow.tsx:smthrs"
      ])
      // Eight of the thirteen name no old package at all; they reach the facade
      // through `../smithers`, and they are still 0.x source.
      expect(detection.components).toEqual([
        ".smithers/workflows/batch-issues/components/BatchLoop.tsx",
        ".smithers/workflows/batch-issues/components/FetchIssues.tsx",
        ".smithers/workflows/batch-issues/components/GeminiContext.tsx",
        ".smithers/workflows/batch-issues/components/Implement.tsx",
        ".smithers/workflows/batch-issues/components/IssuePipeline.tsx",
        ".smithers/workflows/batch-issues/components/MergeToMain.tsx",
        ".smithers/workflows/batch-issues/components/PlanBacklog.tsx",
        ".smithers/workflows/batch-issues/components/Report.tsx",
        ".smithers/workflows/batch-issues/components/Research.tsx",
        ".smithers/workflows/batch-issues/components/Review.tsx",
        ".smithers/workflows/batch-issues/components/ReviewFix.tsx",
        ".smithers/workflows/batch-issues/components/RunCI.tsx",
        ".smithers/workflows/batch-issues/components/Validate.tsx",
        ".smithers/workflows/batch-issues/components/index.ts"
      ])
      expect(detection.warnings.filter((warning) => warning.code === "unknown-authoring-api")).toEqual([])
    }))

  it.effect("reports an imported name the construct catalog does not hold", () =>
    Effect.gen(function*() {
      const root = copyFixture("batch-issues")
      const detection = yield* detect(root)
      const uncatalogued = detection.warnings.filter((warning) => warning.code === "uncatalogued-import")

      expect(uncatalogued.map((warning) => warning.file)).toEqual([
        ".smithers/workflows/batch-issues/components/FetchIssues.tsx",
        ".smithers/workflows/batch-issues/components/FetchIssues.tsx"
      ])
      expect(uncatalogued[0]?.message).toContain("getLinearClient")
    }))

  it.effect("exempts a type-only import from the catalog rule", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const detection = yield* detect(root)
      const setup = detection.imports.find((hit) => hit.file === "tests/_setup.ts" && hit.kind === "old")

      // `import type { WorkflowCoverageOptions }` binds no value, so the
      // catalog does not have to hold it, but the import still has to move.
      expect(setup?.typeOnly).toBe(true)
      expect(detection.warnings.filter((warning) => warning.code === "uncatalogued-import")).toEqual([])
    }))
})

describe("Detect.scan reports a file that mixes authoring APIs", () => {
  it.effect("names the foreign specifier beside the old one", () =>
    Effect.gen(function*() {
      const detection = yield* detect(copyFixture("mixed-api"))
      const file = ".smithers/workflows/issue-pipeline.tsx"
      const mixed = detection.warnings.filter((warning) => warning.code === "mixed-authoring-api")

      expect(mixed).toHaveLength(1)
      expect(mixed[0]?.file).toBe(file)
      expect(mixed[0]?.message).toContain("@smithers-ai/workflow")
      // The file is still a 0.x workflow: it imports the old agents and
      // `Worktree`, and those have to be migrated.
      expect(detection.workflowFiles.find((workflow) => workflow.path === file)?.api).toBe("smithers-orchestrator")
      expect(detection.warnings.some((warning) => warning.code === "unknown-authoring-api")).toBe(false)
    }))
})

describe("Detect.isOldSpecifier is gated by what the manifests said", () => {
  it.effect("treats an @smthrs package pinned below 1.0 as an old import", () =>
    Effect.gen(function*() {
      // `@smthrs/engine` exists in both trees. Only the manifest can say which
      // one a file imports, and design 3.2 says the import rules are gated by
      // what 3.1 read.
      const root = copyFixture("jsx-single")
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      manifest.dependencies["@smthrs/engine"] = "0.35.0"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      mkdirSync(join(root, "lib"), { recursive: true })
      writeFileSync(
        join(root, "lib", "eng.ts"),
        "import { runWorkflow } from \"@smthrs/engine\"\nexport const go = runWorkflow\n"
      )

      const detection = yield* detect(root)
      const hit = detection.imports.find((entry) => entry.file === "lib/eng.ts")

      expect(detection.manifests.some((entry) =>
        entry.oldPackages.some((old) => old.name === "@smthrs/engine" && old.reason === "old-version")
      )).toBe(true)
      expect(hit?.kind).toBe("old")
      expect(Detect.isOldSpecifier("@smthrs/engine", { oldScoped: ["engine"] })).toBe(true)
    }))

  it("leaves a 1.0 @smthrs package alone", () => {
    expect(Detect.isOldSpecifier("@smthrs/engine")).toBe(false)
    expect(Detect.isOldSpecifier("@smthrs/engine", { oldScoped: [] })).toBe(false)
    // A package the 1.0 tree deleted needs no manifest to be old.
    expect(Detect.isOldSpecifier("@smthrs/components")).toBe(true)
    // The bare name is the old facade only where a manifest declared it.
    expect(Detect.isOldSpecifier("smithers")).toBe(false)
    expect(Detect.isOldSpecifier("smithers", { localFacade: true })).toBe(true)
  })
})

describe("Detect.scan over a project that is already on 1.0", () => {
  it.effect("finds no workflow to migrate in the tool's own definition of clean output", () =>
    Effect.gen(function*() {
      // `jsx-single.migrated` is what a correct migration of `jsx-single`
      // produces. A second run has to see a finished project, not a workflow.
      // The file's JSDoc says "the old `<Sequence>` is one `Node.andThen`",
      // which read as text looks like a rendered element and read as syntax is
      // a comment. Reading it as text planned a `workflow:flow` unit whose
      // target was `flows/flow/flow.ts`: the agent would have been handed a
      // finished flow and its output written beside the original under a name
      // taken from `flow.ts`.
      const root = copyFixture("jsx-single.migrated")
      const detection = yield* detect(root)

      expect(detection.workflowFiles).toEqual([])
      expect(detection.warnings).toEqual([])
      expect(detection.manifests.flatMap((manifest) => manifest.oldPackages)).toEqual([])
    }))

  it.effect("names a 1.0 file that still sits where the old workflows were, and does not call it unknown", () =>
    Effect.gen(function*() {
      // A pack migrated one file at a time has 1.0 and 0.x source side by side
      // in the same directory. Position alone makes a `.tsx` there a workflow,
      // so the finished half has to be recognized by what it imports.
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, ".smithers/workflows"), { recursive: true })
      writeFileSync(
        join(root, ".smithers/workflows/done.tsx"),
        [
          `import { Flow } from "@smthrs/flow"`,
          `import * as Schema from "effect/Schema"`,
          ``,
          `export default Flow.make("done", {`,
          `  payload: Schema.Struct({ topic: Schema.String }),`,
          `  success: Schema.String`,
          `})`,
          ``
        ].join("\n")
      )

      const detection = yield* detect(root)
      const done = detection.workflowFiles.find((workflow) => workflow.path === ".smithers/workflows/done.tsx")

      expect(done?.api).toBe("flows")
      expect(detection.warnings.filter((warning) => warning.code === "unknown-authoring-api")).toEqual([])
      expect(detection.warnings.filter((warning) => warning.code === "already-migrated")).toEqual([{
        code: "already-migrated",
        file: ".smithers/workflows/done.tsx",
        message:
          `".smithers/workflows/done.tsx" already imports the Smithers 1.0 authoring API and is not migrated again`
      }])
    }))

  it.effect("still calls a half-migrated file 0.x, because its old half is real work", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, ".smithers/workflows"), { recursive: true })
      writeFileSync(
        join(root, ".smithers/workflows/half.tsx"),
        [
          `import { Flow } from "@smthrs/flow"`,
          `import { Task } from "smthrs"`,
          ``,
          `export default Flow.make("half", { steps: [Task] })`,
          ``
        ].join("\n")
      )

      const detection = yield* detect(root)

      expect(detection.workflowFiles.find((workflow) => workflow.path === ".smithers/workflows/half.tsx")?.api)
        .toBe("smthrs")
      expect(detection.warnings.filter((warning) => warning.code === "already-migrated")).toEqual([])
    }))
})
