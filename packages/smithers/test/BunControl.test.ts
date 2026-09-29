/** The public Bun composition loads under Bun and discovers without importing flow modules. */
import { Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it, vi } from "vitest"
import * as BunControl from "../src/BunControl.ts"

const implementation = vi.hoisted(() => ({
  loaded: vi.fn(),
  layerControl: vi.fn(),
  layerRegistry: vi.fn()
}))

vi.mock("../src/internal/BunControl.ts", () => {
  implementation.loaded()
  return { native: implementation }
})

it("defers Bun adapters until building either public layer and forwards each root", async () => {
  const built: Array<string> = []
  implementation.layerControl.mockReturnValue(Layer.effectDiscard(Effect.sync(() => {
    built.push("control")
  })))
  implementation.layerRegistry.mockReturnValue(Layer.effectDiscard(Effect.sync(() => {
    built.push("registry")
  })))
  const controlConfig = { root: "/virtual/control" }
  const control = BunControl.layerControl(controlConfig)
  const registry = BunControl.layerRegistry("/virtual/registry")
  expect(implementation.loaded).not.toHaveBeenCalled()
  expect(implementation.layerControl).not.toHaveBeenCalled()
  expect(implementation.layerRegistry).not.toHaveBeenCalled()
  expect(built).toEqual([])

  await Effect.runPromise(Effect.provide(Effect.void, control))
  expect(implementation.layerControl).toHaveBeenCalledExactlyOnceWith(controlConfig)
  expect(implementation.layerRegistry).not.toHaveBeenCalled()
  expect(built).toEqual(["control"])

  await Effect.runPromise(Effect.provide(Effect.void, registry))
  expect(implementation.layerRegistry).toHaveBeenCalledExactlyOnceWith("/virtual/registry")
  expect(implementation.loaded).toHaveBeenCalledTimes(1)
  expect(built).toEqual(["control", "registry"])
})

const execute = promisify(execFile)
const module = new URL("../src/BunControl.ts", import.meta.url).href

it("lists no flows under Bun for a root without flows/", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-control-"))
  try {
    const script = `
      import * as BunControl from ${JSON.stringify(module)}
      import * as Registry from "@smthrs/registry/Registry"
      import { Effect } from "effect"
      const listed = await Effect.runPromise(Registry.Registry.pipe(
        Effect.flatMap((registry) => registry.list()),
        Effect.provide(BunControl.layerRegistry(${JSON.stringify(root)}))
      ))
      console.log(JSON.stringify({ listed: listed.length }))
    `
    const { stdout } = await execute("bun", ["--eval", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: join(root, "missing-helper") },
      timeout: 120_000
    })
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ listed: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 125_000)

it("discovers a real Bun flow descriptor without the guarded filesystem helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-control-flow-"))
  try {
    await mkdir(join(root, "flows", "review"), { recursive: true })
    await writeFile(
      join(root, "flows", "review", "SKILL.md"),
      [
        "---",
        "description: Reviews the change.",
        "---",
        "",
        "# Review",
        "",
        "Inspect the change."
      ].join("\n")
    )
    const script = `
      import * as BunControl from ${JSON.stringify(module)}
      import * as Registry from "@smthrs/registry/Registry"
      import { Effect } from "effect"
      const listed = await Effect.runPromise(Registry.Registry.pipe(
        Effect.flatMap((registry) => registry.list()),
        Effect.provide(BunControl.layerRegistry(${JSON.stringify(root)}))
      ))
      console.log(JSON.stringify(listed.map(({ name, description, body, path }) => ({ name, description, bodyTag: body._tag, path }))))
    `
    const { stdout } = await execute("bun", ["--eval", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: join(root, "missing-helper") },
      timeout: 120_000
    })
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual([{
      name: "review",
      description: "Reviews the change.",
      bodyTag: "Markdown",
      path: join(root, "flows", "review", "SKILL.md")
    }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 125_000)
