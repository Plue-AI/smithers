/**
 * The local CLI's flow registry.
 *
 * The composition used to be `Registry.layerNoop()`, so the CLI discovered no
 * flows at all. These cases run the real Node discovery path against a real
 * directory on disk.
 */
import * as Registry from "@smthrs/registry/Registry"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-cli-registry-"))
  await mkdir(join(root, "flows", "review"), { recursive: true })
  await writeFile(
    join(root, "flows", "review", "SKILL.md"),
    [
      "---",
      "description: Reviews a proposed change and reports concrete risks.",
      "---",
      "",
      "# Review",
      "",
      "Inspect the proposed change and report only actionable findings.",
      ""
    ].join("\n")
  )
})

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true })
})

describe("NodeControl.projectSources", () => {
  it("points at the project flows directory", () => {
    expect(NodeControl.projectSources("/work")).toEqual([
      { source: "project", root: join("/work", "flows"), naming: "path", optionalRoot: true }
    ])
  })
})

describe("NodeControl.layerRegistry", () => {
  it("discovers a project flow from disk", async () => {
    const names = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const entries = yield* registry.list()
        return entries.map((entry) => entry.name)
      }).pipe(Effect.provide(NodeControl.layerRegistry(root)), Effect.scoped)
    )

    expect(names).toContain("review")
  })

  it("loads the discovered flow body", async () => {
    const body = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.loadBody("review")
      }).pipe(Effect.provide(NodeControl.layerRegistry(root)), Effect.scoped, Effect.orDie)
    )

    expect(JSON.stringify(body)).toContain("actionable findings")
  })

  it("scans empty when the project has no flows directory", async () => {
    const empty = await mkdtemp(join(tmpdir(), "flows-cli-registry-empty-"))
    try {
      const entries = await Effect.runPromise(
        Effect.flatMap(Registry.Registry, (registry) => registry.list()).pipe(
          Effect.provide(NodeControl.layerRegistry(empty)),
          Effect.scoped
        )
      )
      expect(entries).toEqual([])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
