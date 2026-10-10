import { NodeServices } from "@effect/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import * as HostRegistry from "../coding/host-registry.ts"

const parent = fileURLToPath(new URL("../", import.meta.url))
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("probe", { description: "Original source", payload: {}, success: Schema.String,
 body: () => Node.succeed("original") })`

test("host execution snapshots stay outside source and restore the prior closure after restart", async () => {
  const temporary = await mkdtemp(join(parent, ".host-registry-"))
  const root = join(temporary, "source"), state = join(temporary, "state")
  try {
    await mkdir(join(root, "flows", "probe"), { recursive: true })
    const entry = join(root, "flows", "probe", "flow.ts")
    await writeFile(entry, source)
    const publish = Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const descriptor = yield* registry.get("probe")
      const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [], snapshots: registry.snapshots })
      yield* registry.snapshots!.pin(executable)
      return Descriptor.executionDigest(descriptor)!
    })
    const digest = await Effect.runPromise(publish.pipe(
      Effect.provide(HostRegistry.layer(root, state, NodeServices.layer)),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))
    assert.equal(await readFile(entry, "utf8"), source)
    await assert.rejects(lstat(join(root, ".flows")), { code: "ENOENT" })
    assert.ok((await lstat(join(state, "registry", ".flows", "executions", `${digest}.json`))).isFile())
    await writeFile(entry, source.replaceAll("original", "edited"))
    const retained = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return yield* registry.snapshots!.restore(digest)
      }).pipe(
        Effect.provide(HostRegistry.layer(root, state, NodeServices.layer)),
        Effect.provide(NodeServices.layer),
        Effect.scoped
      )
    )
    assert.equal(retained.descriptor.description, "Original source")
    assert.equal(new TextDecoder().decode(retained.bytes), source)
    await assert.rejects(lstat(join(root, ".flows")), { code: "ENOENT" })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test("legacy archives relocate once and finish after a partial migration", async () => {
  const temporary = await mkdtemp(join(parent, ".host-registry-"))
  const root = join(temporary, "source"), state = join(temporary, "state")
  try {
    for (const kind of ["objects", "executions"]) {
      await mkdir(join(root, ".flows", kind), { recursive: true })
      await writeFile(join(root, ".flows", kind, "retained"), kind)
    }
    await run(HostRegistry.relocateExecutionArchive(root, state))
    await run(HostRegistry.relocateExecutionArchive(root, state))
    for (const kind of ["objects", "executions"]) {
      assert.equal(await readFile(join(state, "registry", ".flows", kind, "retained"), "utf8"), kind)
      await assert.rejects(lstat(join(root, ".flows", kind)), { code: "ENOENT" })
    }
    // The first rename survived a crash; the second directory was not moved.
    await rm(join(state, "registry", ".flows", "executions"), { recursive: true })
    await mkdir(join(root, ".flows", "executions"))
    await writeFile(join(root, ".flows", "executions", "retained"), "execution evidence")
    await run(HostRegistry.relocateExecutionArchive(root, state))
    assert.equal(
      await readFile(join(state, "registry", ".flows", "executions", "retained"), "utf8"),
      "execution evidence"
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test("archive relocation refuses links and collisions without changing retained bytes", async () => {
  const temporary = await mkdtemp(join(parent, ".host-registry-"))
  const root = join(temporary, "source"), state = join(temporary, "state")
  try {
    await mkdir(root)
    await mkdir(join(state, "registry", ".flows", "objects"), { recursive: true })
    await writeFile(join(state, "registry", ".flows", "objects", "retained"), "current")
    await symlink(join(state, "registry", ".flows"), join(root, ".flows"))
    await assert.rejects(run(HostRegistry.relocateExecutionArchive(root, state)), /not a directory/)
    await rm(join(root, ".flows"))
    await mkdir(join(root, ".flows", "objects"), { recursive: true })
    await writeFile(join(root, ".flows", "objects", "retained"), "legacy")
    await assert.rejects(run(HostRegistry.relocateExecutionArchive(root, state)), /conflicts/)
    assert.equal(await readFile(join(root, ".flows", "objects", "retained"), "utf8"), "legacy")
    assert.equal(await readFile(join(state, "registry", ".flows", "objects", "retained"), "utf8"), "current")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
