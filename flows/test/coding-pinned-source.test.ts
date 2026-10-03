import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { type PinnedTodoSource, preparePinnedSource } from "../coding/pinned-source.ts"

// spec §11.4.1: the pin is the Starting transaction's run binding, not branch HEAD.
const pin = {
  flowName: "todo",
  sourceCommit: "1".repeat(40),
  digest: "a".repeat(64),
  runId: "run-1",
  attempt: 1,
  todoId: 7,
  machineId: "machine-1"
} as const
const run = (effect: Effect.Effect<string, unknown, import("effect").FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

test("unavailable machine provider refuses before materialization", async () => {
  await assert.rejects(run(preparePinnedSource("/branch", { pin })), /infra.*provider/)
})

test("wrong run binding refuses before materialization", async () => {
  let materializations = 0
  const source: PinnedTodoSource = {
    pin,
    provider: {
      validate: () => Effect.fail(new Error("wrong-run binding")),
      materialize: () => {
        materializations++
        return Effect.succeed("/source")
      }
    }
  }
  await assert.rejects(run(preparePinnedSource("/branch", source)), /infra.*wrong-run/)
  assert.equal(materializations, 0)
})

// T-FLW-04 Scope In names each provider and requires infra before source loading.
for (
  const unavailable of ["T-STK-01", "T-FLW-03", "T-FLW-11", "T-COL-02", "T-INS-02", "T-FLW-01", "T-SEC-01", "C-SEC-02"]
) {
  test(`${unavailable} refusal is propagated before source materialization`, async () => {
    let materializations = 0
    await assert.rejects(
      run(preparePinnedSource("/branch", {
        pin,
        provider: {
          validate: () => Effect.fail(new Error(`${unavailable} unavailable`)),
          materialize: () => {
            materializations++
            return Effect.succeed("/source")
          }
        }
      })),
      new RegExp(`infra.*${unavailable}`)
    )
    assert.equal(materializations, 0)
  })
}

test("malformed and draft pins refuse before calling a provider", async () => {
  for (
    const invalid of [
      { flowName: "draft version" },
      { sourceCommit: "HEAD" },
      { digest: "bad" },
      { runId: "" },
      { attempt: 0 },
      { todoId: 0 },
      { machineId: "" }
    ]
  ) {
    let calls = 0
    const source: PinnedTodoSource = {
      pin: { ...pin, ...invalid },
      provider: {
        validate: () => {
          calls++
          return Effect.void
        },
        materialize: () => {
          calls++
          return Effect.succeed("/source")
        }
      }
    }
    await assert.rejects(run(preparePinnedSource("/branch", source)), /infra.*pin/)
    assert.equal(calls, 0)
  }
})

test("only a separate machine-local checkout is accepted after binding validation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pinned-todo-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const events: string[] = []
  const fs = await import("node:fs/promises")
  const branch = join(root, "branch"), pinned = join(root, "source")
  await fs.mkdir(branch)
  await fs.mkdir(pinned)
  const source: PinnedTodoSource = {
    pin,
    provider: {
      validate: (binding) => {
        assert.deepEqual(binding, pin)
        events.push("validate")
        return Effect.void
      },
      materialize: (binding) => {
        assert.equal(binding.sourceCommit, "1".repeat(40))
        events.push("materialize")
        return Effect.succeed(pinned)
      }
    }
  }
  const prepare = (value: PinnedTodoSource) =>
    Effect.runPromise(
      preparePinnedSource(branch, value).pipe(Effect.provide(NodeFileSystem.layer))
    )
  assert.equal(await prepare(source), await fs.realpath(pinned))
  assert.deepEqual(events, ["validate", "materialize"])
  for (const path of [branch, root, join(branch, "source")]) {
    await fs.mkdir(path, { recursive: true })
    await assert.rejects(
      prepare({ ...source, provider: { ...source.provider!, materialize: () => Effect.succeed(path) } }),
      /infra.*separate/
    )
  }
  await assert.rejects(
    prepare({
      ...source,
      provider: { ...source.provider!, materialize: () => Effect.fail(new Error("unavailable commit")) }
    }),
    /infra.*unavailable commit/
  )
  await assert.rejects(
    prepare({ ...source, provider: { ...source.provider!, materialize: () => Effect.succeed(join(root, "missing")) } }),
    /infra/
  )
})

// Uses real discovery and body reads. A builtin collision must not bypass the TODO pin.
test("pinned repository registry forces the admitted digest and never substitutes a builtin", async (t) => {
  const { NodeServices } = await import("@effect/platform-node")
  const Registry = await import("@smthrs/registry/Registry")
  const Discovery = await import("@smthrs/registry/Discovery")
  const Descriptor = await import("@smthrs/registry/Descriptor")
  const { bindRepositoryRegistry } = await import("../repository/registry.ts")
  const fs = await import("node:fs/promises")
  const root = await mkdtemp(join(tmpdir(), "pinned-registry-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await fs.mkdir(join(root, "todo"))
  await fs.writeFile(join(root, "todo/flow.mdx"), "---\ndescription: Pinned TODO\n---\nOriginal source")
  const base = await Effect.runPromise(
    Registry.make({
      sources: [{ root, source: "project", naming: "path" }]
    }).pipe(Effect.provide(Discovery.layer), Effect.provide(NodeServices.layer))
  )
  const digest = Descriptor.executionDigest(await Effect.runPromise(base.get("todo")))!
  // Deliberately use an empty builtin registry with todo in its reserved names.
  const builtins = await Effect.runPromise(Registry.Registry.pipe(
    Effect.provide(
      Registry.layerFromDescriptors([], [])
    ),
    Effect.provide(NodeServices.layer)
  ))
  const registry = bindRepositoryRegistry(base, builtins, "policy", ["todo"], { name: "todo", digest })
  assert.deepEqual((await Effect.runPromise(registry.list())).map((entry) => entry.name), ["todo"])
  assert.deepEqual(
    await Effect.runPromise(registry.loadBody("todo")),
    await Effect.runPromise(base.loadBody("todo", digest))
  )
  const wrong = await Effect.runPromise(registry.loadBody("todo", "b".repeat(64)).pipe(Effect.flip))
  assert.equal(wrong.code, "execution_changed")
  await fs.writeFile(join(root, "todo/flow.mdx"), "---\ndescription: Changed\n---\nEdited source")
  const changed = await Effect.runPromise(registry.loadBody("todo").pipe(Effect.flip))
  assert.equal(changed.code, "body_unavailable")
})
