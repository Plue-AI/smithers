import { systemFlows } from "./fixtures/system-flows.ts"
/*
 * The repository host's catalog, after one of its own runs writes a flow.
 *
 * `flows/coding/host.ts` assembles its catalog itself: the repository's own
 * `flows/` tree with the ordinary verified loader, and the reserved job
 * declarations out of the measured bundle the host shipped as. That catalog
 * used to be frozen for the life of the process, so `create-flow` — which
 * this host serves — could write `flows/<id>/flow.ts` and leave a flow the
 * same host could neither plan nor run until it was restarted.
 *
 * The composition now serves it through `Executable.layerRefreshable`. This
 * file is about the two halves of that rule holding against the real
 * `repositoryCatalog` and the real `bindRepositoryRegistry`: a project flow
 * written after startup is rebuilt, and a reserved job declaration is not,
 * because its bytes are the bundle and not whatever is on disk.
 */
import { NodeServices } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import {
  bindRepositoryRegistry,
  provisionBuiltins,
  repositoryCatalog,
  repositoryRegistration
} from "../repository/registry.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
const policy = "a".repeat(64)

const Step = Action.make("refresh/Step", { payload: { step: Schema.String }, success: Schema.String })

/** The one delegate every prompt body in this host's catalog resolves to. */
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** The delegate one reserved job declaration names, so the bundle resolves. */
const Reserved = Flow.make("repository/RunSetup", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** The delegate a project flow written after startup names. */
const Project = Flow.make("refresh/Project", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Step.call({ step: "first" }).pipe(Node.andThen(Step.call({ step: "second" })))
})

/** Every registration the runtime was asked for, in order. */
const observed = (registered: Array<string>) =>
  Layer.succeed(
    FlowRuntime.FlowRuntime,
    { register: (flow: { readonly _tag: string }) => Effect.sync(() => void registered.push(flow._tag)) } as never
  )

const workspace = async (t: TestContext) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-catalog-refresh-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repositoryPath = join(temporary, "repo"), stateRoot = join(temporary, "state")
  await mkdir(join(repositoryPath, "flows"), { recursive: true })
  return { repositoryPath, stateRoot }
}

/** The declaration `create-flow`'s scaffold stage leaves in `flows/<id>/`. */
const declaration = `---
description: Written by a run of this host.
model: flow/author
flows: ["refresh/Project"]
---

Do the thing.
`

/** The catalog and refresh `flows/coding/host.ts` composes, over one workspace. */
const host = (repositoryPath: string, stateRoot: string, registered: Array<string>) =>
  Effect.gen(function*() {
    const builtins = yield* provisionBuiltins(stateRoot, policy)
    const project = yield* Registry.make({
      sources: [{ root: join(repositoryPath, "flows"), source: "project", naming: "path" }]
    }).pipe(Effect.provide(Discovery.layer))
    const registry = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows)
    const options = { delegates: [Agent, Project, Reserved] }
    const built = yield* repositoryCatalog(options, builtins.load).pipe(
      Effect.provideService(Registry.Registry, registry)
    )
    return {
      registry,
      built,
      // The host's own composition, not a copy of it: `flows/coding/host.ts`
      // serves its catalog through this exact function.
      layer: repositoryRegistration(options, built, Layer.empty).pipe(
        Layer.provideMerge(Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)),
        Layer.provideMerge(Layer.succeed(Registry.Registry, registry))
      )
    }
  })

test("a project flow written after the catalog was built is planned from the bytes on disk", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const registered: Array<string> = []
  const observedNames = await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const composed = yield* host(repositoryPath, stateRoot, registered)
      return yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        assert.equal(catalog.executables.some((entry) => entry.descriptor.name === "mine"), false)

        yield* Effect.promise(async () => {
          await mkdir(join(repositoryPath, "flows", "mine"), { recursive: true })
          await writeFile(join(repositoryPath, "flows", "mine", "flow.mdx"), declaration)
        })
        const outcome = yield* refresh.flow("mine")
        assert.equal(outcome._tag, "Registered")

        const entry = catalog.executables.find((candidate) => candidate.descriptor.name === "mine")
        assert.ok(entry, "the rebuilt entry must be in the catalog the host serves")
        assert.equal(entry.delegate, "refresh/Project")
        // The plan this host would now draw is the delegate's own topology,
        // rather than the empty one a missing executable leaves behind.
        assert.ok(
          Graph.drafts(Graph.build(entry.flow, { input: {} })).length > 1,
          "the rebuilt entry must plan its delegate's nodes"
        )
        return registered
      }).pipe(Effect.provide(composed.layer))
    }).pipe(Effect.provide(platform))
  ))

  assert.ok(observedNames.includes("mine"), "the rebuilt entry must be registered with the runtime")
})

test("a reserved job declaration is held fixed against whatever the working tree says", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const registered: Array<string> = []
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const composed = yield* host(repositoryPath, stateRoot, registered)
      const before = composed.built.executables.find((entry) => entry.descriptor.name === "repository/setup")
      assert.ok(before, "the reserved setup job is part of this host's catalog")
      return yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        // Everything this host's catalog holds is registered while it starts.
        const atStartup = [...registered]
        assert.ok(atStartup.includes("repository/setup"), "the reserved setup job registers at startup")
        // A run this host is serving can write anything into the tree. What it
        // must not be able to do is make the host rebuild a reserved job's
        // declaration out of what it wrote.
        yield* Effect.promise(async () => {
          await mkdir(join(repositoryPath, "flows", "repository", "setup"), { recursive: true })
          await writeFile(join(repositoryPath, "flows", "repository", "setup", "flow.mdx"), declaration)
        })
        assert.equal((yield* refresh.flow("repository/setup"))._tag, "Fixed")
        assert.equal(
          catalog.executables.find((entry) => entry.descriptor.name === "repository/setup"),
          before
        )
        assert.deepEqual(registered, atStartup)
      }).pipe(Effect.provide(composed.layer))
    }).pipe(Effect.provide(platform))
  ))
})

/** Real metadata discovery over a minimal packaged merge and a mutable project. */
const collisionHost = (repositoryPath: string, stateRoot: string, registered: Array<string>, packaged = true) =>
  Effect.gen(function*() {
    const defaults = join(stateRoot, "defaults")
    yield* Effect.promise(async () => {
      await mkdir(defaults, { recursive: true })
      if (packaged) {
        await mkdir(join(defaults, "merge"), { recursive: true })
        await writeFile(
          join(defaults, "merge", "flow.ts"),
          `
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
export default Flow.make("merge", { description: "Packaged merge", payload: {}, success: Schema.String })
`
        )
      }
    })
    const make = (root: string, source: string) =>
      Registry.make({ sources: [{ root, source, naming: "path" }] }).pipe(Effect.provide(Discovery.layer))
    const base = yield* make(join(repositoryPath, "flows"), "project")
    const defaultsRegistry = yield* make(defaults, "repository-host")
    // A routine service wrapper must retain collision diagnostics.
    const registry = Registry.Registry.of({
      ...bindRepositoryRegistry(base, defaultsRegistry, policy, systemFlows)
    })
    const options = { delegates: [] }
    const built = yield* repositoryCatalog(options, () =>
      Effect.succeed({
        default: Flow.make("merge", { payload: {}, success: Schema.String, body: () => Node.succeed("Packaged merge") })
      })).pipe(Effect.provideService(Registry.Registry, registry))
    return {
      built,
      layer: repositoryRegistration(options, built, Layer.empty).pipe(
        Layer.provideMerge(Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)),
        Layer.provideMerge(Layer.succeed(Registry.Registry, registry))
      )
    }
  })

const writeCollision = async (repositoryPath: string) => {
  const directory = join(repositoryPath, "flows", "merge")
  const marker = join(repositoryPath, "merge-imported")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "flow.ts"),
    `
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(marker)}, "imported")
export default Flow.make("merge", { description: "Repository merge", payload: {}, success: Schema.String })
`
  )
  return marker
}

for (const initiallyPresent of [false, true]) {
  test(`reserved merge diagnostics reconcile add/remove with a fixed packaged entry (initially ${initiallyPresent})`, async (t) => {
    const { repositoryPath, stateRoot } = await workspace(t)
    const registered: Array<string> = []
    const marker = join(repositoryPath, "merge-imported")
    if (initiallyPresent) await writeCollision(repositoryPath)
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const composed = yield* collisionHost(repositoryPath, stateRoot, registered)
        return yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          const packaged = catalog.executables.find((entry) => entry.descriptor.name === "merge")
          assert.ok(packaged)
          const atStartup = [...registered]
          const expected = [{
            flow: "merge",
            code: "reserved_name",
            path: join(repositoryPath, "flows", "merge", "flow.ts")
          }]
          const refusals = () => catalog.refused.map(({ flow, code, path }) => ({ flow, code, path }))
          assert.deepEqual(refusals(), initiallyPresent ? expected : [])
          if (!initiallyPresent) yield* Effect.promise(() => writeCollision(repositoryPath))
          assert.equal((yield* refresh.flow("merge"))._tag, "Fixed")
          assert.deepEqual(refusals(), expected)
          // Mixed concurrent refreshes must publish the latest discovery once,
          // even when another selected name has no descriptor.
          const repeated = yield* Effect.all([refresh.flow("merge"), refresh.flow("absent")], {
            concurrency: "unbounded"
          })
          assert.deepEqual(repeated.map((result) => result._tag), ["Fixed", "Removed"])
          assert.deepEqual(refusals(), expected)
          assert.equal(catalog.executables.find((entry) => entry.descriptor.name === "merge"), packaged)
          assert.ok(Graph.build(packaged.flow, { input: {} }).nodes.some((node) => node.payload === "Packaged merge"))
          assert.equal(yield* catalog.load!("merge"), packaged)
          yield* Effect.promise(() => rm(join(repositoryPath, "flows", "merge"), { recursive: true }))
          assert.equal((yield* refresh.flow("merge"))._tag, "Fixed")
          assert.deepEqual(refusals(), [])
          yield* Effect.all([refresh.flow("absent"), refresh.flow("merge")], { concurrency: "unbounded" })
          assert.deepEqual(refusals(), [])
          assert.equal(catalog.executables.find((entry) => entry.descriptor.name === "merge"), packaged)
          assert.deepEqual(registered, atStartup)
        }).pipe(Effect.provide(composed.layer))
      }).pipe(Effect.provide(platform))
    ))
    await assert.rejects(access(marker), { code: "ENOENT" })
  })
}

test("a live reserved collision without a packaged executable remains a typed refusal", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const composed = yield* collisionHost(repositoryPath, stateRoot, [], false)
      return yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* Effect.promise(() => writeCollision(repositoryPath))
        assert.equal((yield* refresh.flow("merge"))._tag, "Removed")
        assert.equal(catalog.refused.find((entry) => entry.flow === "merge")?.code, "reserved_name")
        const result = yield* Effect.result(catalog.load!("merge"))
        assert.equal(result._tag, "Failure")
        if (result._tag === "Failure") assert.equal(result.failure.code, "reserved_name")
        yield* Effect.promise(() => rm(join(repositoryPath, "flows", "merge"), { recursive: true }))
        yield* refresh.flow("merge")
        assert.deepEqual(catalog.refused, [])
      }).pipe(Effect.provide(composed.layer))
    }).pipe(Effect.provide(platform))
  ))
  await assert.rejects(access(join(repositoryPath, "merge-imported")), { code: "ENOENT" })
})
