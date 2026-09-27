import * as NodeServices from "@effect/platform-node/NodeServices"
import { afterEach, expect, test } from "bun:test"
import { Effect, FileSystem, Layer, Path } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Rooted from "../src/rooted.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const project = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tui-rooted-")))
  roots.push(root)
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "a\n")
  return root
}

const run = <A, E>(
  root: string,
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
) => Effect.runPromise(Effect.provide(effect, Rooted.layer(root).pipe(Layer.provideMerge(NodeServices.layer))))

test("paths, globs and commands resolve against the root, not the process cwd", async () => {
  const root = project()
  expect(process.cwd()).not.toBe(root)
  const result = await run(
    root,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return {
        resolved: path.resolve("src"),
        relative: path.relative(".", "src/a.ts"),
        read: yield* fs.readFileString("src/a.ts"),
        glob: yield* fs.glob("src/*.ts"),
        pwd: (yield* spawner.string(ChildProcess.make`pwd -P`)).trim(),
        nested: (yield* spawner.string(ChildProcess.make({ cwd: "src" })`pwd -P`)).trim(),
        piped: (yield* spawner.string(ChildProcess.make`ls`.pipe(ChildProcess.pipeTo(ChildProcess.make`cat`)))).trim()
      }
    })
  )
  expect(result).toEqual({
    resolved: join(root, "src"),
    relative: "src/a.ts",
    read: "a\n",
    glob: ["src/a.ts"],
    pwd: root,
    nested: join(root, "src"),
    piped: "src"
  })
})

test("absolute paths pass through", async () => {
  const root = project()
  const other = project()
  await run(
    root,
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(join(other, "b.ts"), "b\n"))
  )
  expect(await Bun.file(join(other, "b.ts")).text()).toBe("b\n")
})
