import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Cause, Effect, Layer, Option } from "effect"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as FileRouter from "../src/FileRouter.ts"

const root = fileURLToPath(new URL("./fixtures/router/flows", import.meta.url))

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const scan = () => Effect.runPromise(FileRouter.scan({ root }).pipe(Effect.provide(platformLayer)))

describe("FileRouter", () => {
  it("routes directory entries by path without evaluating module bodies", async () => {
    const result = await scan()

    expect(result.routes.map((route) => route.name)).toEqual([
      "directives/panel",
      "directives/sandboxed",
      "domains",
      "domains/list",
      "mixed",
      "review",
      "skills/demo"
    ])
    expect(result.routes.find((route) => route.name === "review")?.segments).toEqual(["review"])
    expect(result.routes.find((route) => route.name === "domains/list")?.segments).toEqual(["domains", "list"])
    expect(result.routes.find((route) => route.name === "review")?.sourcePath).toBe(join(root, "review", "flow.ts"))
  })

  it("preserves registry entry precedence and diagnostics", async () => {
    const result = await scan()

    expect(result.routes.find((route) => route.name === "mixed")?.kind).toBe("module")
    expect(result.routes.find((route) => route.name === "mixed")?.sourcePath).toBe(join(root, "mixed", "flow.ts"))
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "multiple_entry_files", path: join(root, "mixed") }),
      expect.objectContaining({ code: "root_level_entry", path: join(root, "flow.ts") }),
      expect.objectContaining({ code: "name_field_ignored", path: join(root, "review", "flow.ts") })
    ]))
  })

  it("records UI companions without routing companions or colocated tests", async () => {
    const result = await scan()
    const review = result.routes.find((route) => route.name === "review")

    expect(Option.getOrUndefined(review?.ui ?? Option.none())).toBe(join(root, "review", "ui.tsx"))
    expect(result.routes.some((route) => basename(route.sourcePath) === "ui.tsx")).toBe(false)
    expect(result.routes.some((route) => basename(route.sourcePath) === "flow.test.ts")).toBe(false)
  })

  it("routes skills as metadata while leaving skill parsing lazy", async () => {
    const result = await scan()
    const skill = result.routes.find((route) => route.name === "skills/demo")

    expect(skill).toMatchObject({ kind: "skill", sourcePath: expect.stringMatching(/SKILL\.md$/) })
  })

  it("is deterministic", async () => {
    const first = await scan()
    const second = await scan()

    expect(second).toEqual(first)
  })

  it("resolves a relative root once and returns absolute immutable routes", async () => {
    const relativeRoot = relative(process.cwd(), root)
    const config = { root: relativeRoot }
    const pending = Effect.runPromise(FileRouter.scan(config).pipe(Effect.provide(platformLayer)))
    config.root = "/"
    const result = await pending

    expect(result.routes.length).toBeGreaterThan(0)
    expect(result.routes.every((route) => isAbsolute(route.sourcePath))).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.routes)).toBe(true)
  })

  it("preserves a literal backslash segment on POSIX", async () => {
    if (sep !== "/") return
    const temporary = await mkdtemp(`${tmpdir()}/smithers-fs-router-`)
    try {
      const source = `import * as Schema from "effect/Schema"
import { Flow } from "@smthrs/core"
export default ({ capabilities: [], effects: undefined, input: Schema.Void, output: Schema.Unknown,  name: "fixture", description: "fixture"  })
`
      await mkdir(`${temporary}/a\\b`, { recursive: true })
      await mkdir(`${temporary}/a/b`, { recursive: true })
      await writeFile(`${temporary}/a\\b/flow.ts`, source)
      await writeFile(`${temporary}/a/b/flow.ts`, source)
      const result = await Effect.runPromise(
        FileRouter.scan({ root: temporary }).pipe(Effect.provide(platformLayer))
      )
      expect(result.routes.map((route) => route.name)).toEqual(["a/b", "a\\b"])
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it("preserves discovery error codes and refuses hostile config", async () => {
    const missing = await Effect.runPromise(Effect.exit(
      FileRouter.scan({ root: "/definitely/missing/smithers-flows" }).pipe(Effect.provide(platformLayer))
    ))
    expect(missing._tag).toBe("Failure")
    if (missing._tag === "Failure") {
      const error = Option.getOrThrow(Cause.findErrorOption(missing.cause))
      expect(error.code).toBe("root_missing")
    }

    let called = false
    const config = Object.defineProperty({}, "root", {
      enumerable: true,
      get: () => {
        called = true
        return root
      }
    })
    const hostile = await Effect.runPromise(Effect.exit(
      FileRouter.scan(config as FileRouter.ScanConfig).pipe(Effect.provide(platformLayer))
    ))
    expect(hostile._tag).toBe("Failure")
    expect(called).toBe(false)
  })
  it("never routes a flow or UI companion whose real path leaves the root", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "smithers-fs-escape-"))
    try {
      const source = `import * as Schema from "effect/Schema"
import { Flow } from "@smthrs/core"
export default ({ capabilities: [], effects: undefined, input: Schema.Void, output: Schema.Unknown,  name: "fixture", description: "fixture"  })
`
      const flows = join(temporary, "flows")
      const outside = join(temporary, "outside")
      await mkdir(join(flows, "inside"), { recursive: true })
      await mkdir(join(flows, "linkedui"), { recursive: true })
      await mkdir(join(outside, "escape"), { recursive: true })
      await writeFile(join(flows, "inside", "flow.ts"), source)
      await writeFile(join(outside, "escape", "flow.ts"), source)
      await writeFile(join(outside, "loose.ts"), source)
      await writeFile(join(outside, "ui.tsx"), "export default null\n")
      await symlink(join(outside, "escape"), join(flows, "dir"))
      await mkdir(join(flows, "file"))
      await symlink(join(outside, "loose.ts"), join(flows, "file", "flow.ts"))
      await writeFile(join(flows, "linkedui", "flow.ts"), source)
      await symlink(join(outside, "ui.tsx"), join(flows, "linkedui", "ui.tsx"))

      const result = await Effect.runPromise(
        FileRouter.scan({ root: flows }).pipe(Effect.provide(platformLayer))
      )

      expect(result.routes.map((route) => route.name)).toEqual(["inside", "linkedui"])
      expect(Option.isNone(result.routes.find((route) => route.name === "linkedui")!.ui)).toBe(true)
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "outside_root", path: join(flows, "dir") }),
        expect.objectContaining({ code: "outside_root", path: join(flows, "file", "flow.ts") })
      ]))
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
