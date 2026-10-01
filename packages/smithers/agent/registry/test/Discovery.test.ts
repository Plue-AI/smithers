import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { inputDocument, type Source, SourceScan } from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"

const projectRoot = fileURLToPath(new URL("./fixtures/project/flows", import.meta.url))
const foreignRoot = fileURLToPath(new URL("./fixtures/foreign", import.meta.url))
const missingRoot = fileURLToPath(new URL("./fixtures/does-not-exist", import.meta.url))

const discoveryLayer = Discovery.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const scan = (source: Source) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const discovery = yield* Discovery.Discovery
      return yield* discovery.scan(source)
    }).pipe(Effect.provide(discoveryLayer))
  )

const writeMarkdownFlow = (directory: string, name?: string): void => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "flow.mdx"),
    [
      "---",
      ...(name === undefined ? [] : [`name: ${name}`]),
      "description: A temporary flow.",
      "capabilities: []",
      "---",
      "body"
    ].join("\n")
  )
}

const withTemporaryRoot = async <A>(run: (root: string) => Promise<A>): Promise<A> => {
  const root = mkdtempSync(join(tmpdir(), "smithers-registry-discovery-"))
  try {
    return await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("Discovery", () => {
  it("discloses unrestricted imports from action helpers without evaluating them", async () => {
    await withTemporaryRoot(async (root) => {
      const directory = join(root, "native")
      mkdirSync(directory)
      writeFileSync(
        join(directory, "flow.ts"),
        `import { Flow } from "@smthrs/flow";
import "./vm.ts";
export default Flow.make("native", { description: "Native action", capabilities: [] });`
      )
      writeFileSync(
        join(directory, "vm.ts"),
        `import { NodeVm } from "microsandbox";
import "node:fs";
export * from "node:child_process";
const sdk = () => import("microsandbox");
const fs = require("node:fs");
throw new Error("discovery must never execute this action helper");`
      )
      const result = await scan({ source: "project", root, naming: "path" })
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0]!.capabilities).toEqual([])
      expect(result.entries[0]!.body).toMatchObject({
        hostImports: ["@smthrs/flow", "microsandbox", "node:child_process", "node:fs"]
      })
      expect(Schema.decodeUnknownSync(SourceScan)(Schema.encodeSync(SourceScan)(result)).entries[0]!.body)
        .toMatchObject({
          hostImports: ["@smthrs/flow", "microsandbox", "node:child_process", "node:fs"]
        })
    })
  })

  it("publishes proven payload metadata from real files without evaluating their modules", async () => {
    await withTemporaryRoot(async (root) => {
      const marker = join(root, "evaluated.txt")
      const directory = join(root, "echo")
      mkdirSync(directory)
      const file = join(directory, "flow.ts")
      writeFileSync(
        file,
        `import { Schema as S } from "effect";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "loaded");
throw new Error("must never evaluate during metadata discovery");
export default Flow.make("echo", { description: "Echo a value", payload: { value: S.String } });`
      )
      const scanned = await scan({ source: "project", root, naming: "path" })
      expect(scanned.entries).toHaveLength(1)
      const descriptor = scanned.entries[0]!
      expect(descriptor.input).toMatchObject({ _tag: "Module", path: file, field: "input" })
      expect(inputDocument(descriptor.input)).toMatchObject({
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"]
        }
      })
      expect(scanned.warnings).toEqual([])
      expect(existsSync(marker)).toBe(false)
      writeFileSync(
        file,
        "import { Schema as S } from \"effect\"; export default Flow.make(\"echo\", { description: \"Echo a value\", payload: { value: S.String.check(refine) } });"
      )
      const edited = await scan({ source: "project", root, naming: "path" })
      expect(edited.entries[0]!.input).toMatchObject({ _tag: "Module", path: file, field: "input" })
      expect(inputDocument(edited.entries[0]!.input)).toBeUndefined()
      expect(edited.warnings).toContainEqual(expect.objectContaining({
        code: "unsupported_module_metadata",
        path: file,
        message: "Payload schema cannot be projected statically; retaining its module locator"
      }))
      expect(existsSync(marker)).toBe(false)
    })
  })
  it("discovers path-named markdown and module flows without loading their bodies", async () => {
    const result = await scan({
      source: "project",
      root: projectRoot,
      naming: "path"
    })

    expect(result.entries.map((entry) => entry.name)).toEqual([
      "changelog",
      "hidden",
      "review",
      "review/read-pr"
    ])
    expect(
      result.warnings.some((item) =>
        item.code === "name_field_ignored" && item.path === join(projectRoot, "review", "flow.mdx")
      )
    ).toBe(true)
    expect(
      result.warnings.some((item) =>
        item.code === "missing_description" && item.path === join(projectRoot, "broken", "flow.mdx")
      )
    ).toBe(true)
    expect(result.entries.some((entry) => entry.name === "broken")).toBe(false)

    const hidden = result.entries.find((entry) => entry.name === "hidden")
    expect(hidden?.modelInvocable).toBe(false)

    const moduleFlow = result.entries.find((entry) => entry.name === "review/read-pr")
    expect(moduleFlow?.body).toMatchObject({
      _tag: "Module",
      path: join(projectRoot, "review", "read-pr", "flow.ts")
    })
    expect(moduleFlow?.input).toMatchObject({
      _tag: "Module",
      path: join(projectRoot, "review", "read-pr", "flow.ts"),
      field: "input"
    })
    expect(moduleFlow?.output).toMatchObject({
      _tag: "Module",
      path: join(projectRoot, "review", "read-pr", "flow.ts"),
      field: "output"
    })
    expect(moduleFlow?.capabilities).toEqual(["fs:read:.", "net:get:api.github.com"])
    expect(moduleFlow?.effects.tier).toBe("irreversible")
    expect(Option.getOrUndefined(moduleFlow?.placement ?? Option.none())).toBe("local")
    expect(moduleFlow?.description).toBe("Reads a PR and summarizes it.")
  })

  it("discovers unmodified foreign skills using frontmatter names", async () => {
    const result = await scan({
      source: "foreign",
      root: foreignRoot,
      naming: "frontmatter"
    })

    expect(result.entries.map((entry) => entry.name)).toEqual(["pdf-processing", "review", "template-skill"])
    expect(result.entries.find((entry) => entry.name === "pdf-processing")?.flows).toEqual([
      "Read",
      "Write",
      "Bash(pdftotext:*)",
      "Bash(pdfinfo:*)",
      "Bash(qpdf:*)"
    ])
    expect(result.entries.find((entry) => entry.name === "pdf-processing")?.capabilities).toEqual(["*"])
    expect(result.entries.find((entry) => entry.name === "pdf-processing")?.effects.tier).toBe("irreversible")
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "unprojectable_authority",
      path: join(foreignRoot, "pdf", "SKILL.md")
    }))
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "directory_name_mismatch",
      name: "pdf-processing"
    }))
  })

  it("fails a missing source root with the stable root_missing code", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan({
            source: "missing",
            root: missingRoot,
            naming: "path"
          })
        }).pipe(Effect.provide(discoveryLayer))
      )
    )

    expect(error.code).toBe("root_missing")
    expect(error.path).toBe(missingRoot)
  })

  it("reads only metadata during discovery and never calls readFileString", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const discovery = Discovery.make(
          FileSystem.makeNoop({
            exists: fs.exists,
            stat: fs.stat,
            readDirectory: fs.readDirectory,
            stream: fs.stream,
            readFile: fs.readFile,
            readFileString: () => Effect.die("discovery must not load complete bodies")
          }),
          path
        )
        return yield* discovery.scan({
          source: "project",
          root: projectRoot,
          naming: "path"
        })
      }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
    )

    expect(result.entries.map((entry) => entry.name)).toContain("review/read-pr")
  })

  it("preserves an underlying FileSystem cause on source access failure", async () => {
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "access",
      pathOrDescriptor: projectRoot
    })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        const discovery = Discovery.make(
          FileSystem.makeNoop({ exists: () => Effect.fail(cause) }),
          path
        )
        return yield* Effect.flip(discovery.scan({
          source: "project",
          root: projectRoot,
          naming: "path"
        }))
      }).pipe(Effect.provide(NodePath.layer))
    )

    expect(error).toMatchObject({ code: "read_failed", cause })
  })

  it("scans nothing from a stub and keeps overridden methods", async () => {
    const source: Source = { source: "stub", root: projectRoot, naming: "path" }
    const overridden = new SourceScan({ entries: [], warnings: [] })

    const result = await Effect.runPromise(
      Effect.all([
        Discovery.makeNoop().scan(source),
        Discovery.makeNoop({ scan: () => Effect.succeed(overridden) }).scan(source),
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan(source)
        }).pipe(Effect.provide(Discovery.layerNoop())),
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan(source)
        }).pipe(Effect.provide(Discovery.layerNoop({ scan: () => Effect.succeed(overridden) })))
      ])
    )

    expect(result).toEqual([
      new SourceScan({ entries: [], warnings: [] }),
      overridden,
      new SourceScan({ entries: [], warnings: [] }),
      overridden
    ])
  })

  it("returns deterministic scans", async () => {
    const source = {
      source: "project",
      root: projectRoot,
      naming: "path"
    } as const

    const first = await scan(source)
    const second = await scan(source)

    expect(second).toEqual(first)
  })

  it("pins a load after automatic semicolon insertion and refuses a computed one behind a keyword-named member (#3106)", async () => {
    await withTemporaryRoot(async (root) => {
      const flows: Record<string, string> = {
        asi: `for (;;) { if (globalThis.c) break\n/'/.test(""); import("../evil.ts"); /'/ }`,
        private: `class X { #return = 1; run(p) { return this.#return / import(p) / 1 } }`,
        unicode: `const éreturn = 2; export const run = (p) => éreturn / import(p) / 1`
      }
      for (const [name, body] of Object.entries(flows)) {
        const directory = join(root, name)
        mkdirSync(directory)
        writeFileSync(
          join(directory, "flow.ts"),
          `${body}\nexport default Flow.make("${name}", { description: "${name} flow" })`
        )
      }
      writeFileSync(join(root, "evil.ts"), "export const evil = 1")
      const scanned = await scan({ source: "shared", root, naming: "path" })
      const imports = Object.fromEntries(
        scanned.entries.map((entry) => [
          entry.name,
          entry.body._tag === "Module" ? entry.body.imports?.map(({ path }) => path) : undefined
        ])
      )

      expect(imports).toEqual({
        asi: ["../evil.ts"],
        private: ["the entry computes the target of 1 import() or require() call(s)"],
        unicode: ["the entry computes the target of 1 import() or require() call(s)"]
      })
    })
  })

  it("keeps shared module receipts per flow and refreshes them on the next scan", async () => {
    await withTemporaryRoot(async (root) => {
      for (const name of ["one", "two"]) {
        const directory = join(root, name)
        mkdirSync(directory)
        writeFileSync(
          join(directory, "flow.ts"),
          [
            `import "../shared.ts"`,
            `export default Flow.make("${name}", { description: "${name} flow" })`
          ].join("\n")
        )
      }
      writeFileSync(join(root, "shared.ts"), `import "./missing.ts"\nexport const shared = 1`)
      const source: Source = { source: "shared", root, naming: "path" }
      const first = await scan(source)
      const second = await scan(source)

      expect(second).toEqual(first)
      expect(first.entries.map(({ name }) => name)).toEqual(["one", "two"])
      const receipts = first.entries.map((entry) => entry.body._tag === "Module" ? entry.body.imports : undefined)
      expect(receipts[0]).toEqual(receipts[1])
      expect(receipts[0]?.map(({ path }) => path)).toEqual([
        `"../shared.ts" imports "./missing.ts", which resolves to no file`,
        "../shared.ts"
      ])

      writeFileSync(join(root, "shared.ts"), `import "./missing.ts"\nexport const shared = 2`)
      writeFileSync(join(root, "missing.ts"), "export const missing = 1")
      const refreshed = await scan(source)
      const updated = refreshed.entries.map((entry) => entry.body._tag === "Module" ? entry.body.imports : undefined)
      expect(updated[0]).toEqual(updated[1])
      expect(updated[0]?.map(({ path }) => path)).toEqual(["../missing.ts", "../shared.ts"])
      expect(updated[0]?.find(({ path }) => path === "../shared.ts")?.contentDigest)
        .not.toBe(receipts[0]?.find(({ path }) => path === "../shared.ts")?.contentDigest)
    })
  })

  it("stops an ancestor symlink after the first physical directory visit", async () => {
    await withTemporaryRoot(async (root) => {
      const directory = join(root, "a", "b")
      const loop = join(directory, "loop")
      writeMarkdownFlow(directory)
      symlinkSync(root, loop, "dir")

      const result = await scan({ source: "cycle", root, naming: "path" })

      expect(result.entries.map((entry) => entry.name)).toEqual(["a/b"])
      expect(result.warnings).toEqual([expect.objectContaining({
        code: "symlink_cycle",
        path: loop,
        message: expect.stringContaining(root)
      })])
    })
  })

  it("reports the first visited location of a revisited intermediate directory", async () => {
    await withTemporaryRoot(async (root) => {
      const ancestor = join(root, "a")
      const directory = join(ancestor, "b")
      const loop = join(directory, "loop")
      writeMarkdownFlow(directory)
      symlinkSync(ancestor, loop, "dir")

      const result = await scan({ source: "intermediate", root, naming: "path" })

      expect(result.entries.map((entry) => entry.name)).toEqual(["a/b"])
      expect(result.warnings).toEqual([expect.objectContaining({
        code: "symlink_cycle",
        path: loop,
        message: `Directory "${loop}" resolves to already visited directory "${ancestor}"; skipping recursive traversal`
      })])
    })
  })

  it("bounds a sibling symlink that would duplicate a frontmatter name", async () => {
    await withTemporaryRoot(async (root) => {
      const target = join(root, "a")
      const link = join(root, "b")
      writeMarkdownFlow(target, "a")
      symlinkSync(target, link, "dir")

      const result = await scan({ source: "sibling", root, naming: "frontmatter" })

      expect(result.entries.map((entry) => entry.name)).toEqual(["a"])
      expect(result.warnings).toEqual([expect.objectContaining({
        code: "symlink_cycle",
        path: link,
        message: expect.stringContaining(target)
      })])
    })
  })

  it("stops a self-link without rediscovering its flow", async () => {
    await withTemporaryRoot(async (root) => {
      const directory = join(root, "self")
      const loop = join(directory, "loop")
      writeMarkdownFlow(directory)
      symlinkSync(directory, loop, "dir")

      const result = await scan({ source: "self", root, naming: "path" })

      expect(result.entries.map((entry) => entry.name)).toEqual(["self"])
      expect(result.warnings).toEqual([expect.objectContaining({
        code: "symlink_cycle",
        path: loop,
        message: expect.stringContaining(directory)
      })])
    })
  })

  it("discovers an acyclic flow just under the traversal depth ceiling", async () => {
    await withTemporaryRoot(async (root) => {
      const segments = Array.from({ length: 31 }, (_, index) => `d${String(index).padStart(2, "0")}`)
      writeMarkdownFlow(join(root, ...segments))

      const result = await scan({ source: "deep", root, naming: "path" })

      expect(result.entries.map((entry) => entry.name)).toEqual([segments.join("/")])
      expect(result.warnings).toEqual([])
    })
  })

  it("warns and stops before traversing beyond 32 entry-name segments", async () => {
    await withTemporaryRoot(async (root) => {
      const segments = Array.from({ length: 33 }, (_, index) => `d${String(index).padStart(2, "0")}`)
      const directory = join(root, ...segments)
      writeMarkdownFlow(directory)

      const result = await scan({ source: "too-deep", root, naming: "path" })

      expect(result.entries).toEqual([])
      expect(result.warnings).toEqual([expect.objectContaining({
        code: "max_depth_exceeded",
        path: directory
      })])
    })
  })
})
