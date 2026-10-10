/**
 * A repository that ships `.smithers/coding-project.json` and no `flows/coding/`
 * tree must still pass the coding host's required-executable check
 * (smithersai/smithers#2764, smithersai/plue#700). Before the configured routes
 * shipped as built-ins, such a repository could only start the host by vendoring
 * minified coding bundles into its own `flows/coding/*`.
 *
 * The catalog here is the host's own composition: `provisionHostBuiltins`,
 * `bindRepositoryRegistry`, `repositoryCatalog` and `missingCodingExecutables`
 * are the functions `flows/coding/host.ts` calls at startup.
 */
import { NodeServices } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Flow, FlowRuntime, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as ExecutionSnapshot from "@smthrs/registry/ExecutionSnapshot"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { factory } from "../../.smithers/FACTORY.ts"
import { bundle } from "../coding/build.mjs"
import { missingCodingExecutables, provisionHostBuiltins } from "../coding/host.ts"
import { Landing } from "../coding/landing.ts"
import { loadProject } from "../coding/project-config.ts"
import { bindRepositoryRegistry, provisionBuiltins, repositoryCatalog } from "../repository/registry.ts"
import { RunJob, RunSetup } from "../repository/setup.ts"
import { RunTrigger } from "../repository/triggers.ts"
import { host as reviewHost } from "../review/tests/host.ts"
import { scriptedSeats } from "../review/tests/workflow/scriptedSeats.ts"
import Todo from "../todo/flow.ts"
import { systemFlows } from "./fixtures/system-flows.ts"

import * as Command from "../../packages/smithers/agent/fs/src/Command.ts"
import * as FileRouter from "../../packages/smithers/agent/fs/src/FileRouter.ts"
import * as FlowInvoker from "../../packages/smithers/agent/fs/src/FlowInvoker.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
const policy = "a".repeat(64)
// Configuration never builds the adapter; only its presence selects `coding/vibe`.
const landing = Layer.succeed(Landing, {} as never)

/** The smallest project that enables every route: planning with its wiki. */
const project = {
  wiki: true,
  wikiOutput: "../wiki",
  reviewer: "test-reviewer-v1",
  implementation: "coding/implementation",
  checks: [],
  pages: [{
    id: "overview",
    title: "Overview",
    purpose: "Describe the repository",
    kind: "current" as const,
    document: "overview.md",
    inputs: ["README.md"],
    related: []
  }]
}

/** A repository with only a coding project file, a README and an empty `flows/`. */
const workspace = async (t: TestContext) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-builtin-routes-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repositoryPath = join(temporary, "repo"), stateRoot = join(temporary, "state")
  await mkdir(join(repositoryPath, "flows"), { recursive: true })
  await mkdir(join(repositoryPath, ".smithers"), { recursive: true })
  await writeFile(join(repositoryPath, "README.md"), "# fixture\n")
  await writeFile(join(repositoryPath, ".smithers", "coding-project.json"), `${JSON.stringify(project, null, 2)}\n`)
  return { repositoryPath, stateRoot }
}

/** What the host's startup check reports missing, and the names the registry lists. */
const startup = (repositoryPath: string, stateRoot: string, provision: "host" | "defaults", withLanding = true) =>
  Effect.gen(function*() {
    const planning = yield* loadProject(repositoryPath, undefined)
    assert.ok(planning?.wiki, "the project configures planning and its wiki")
    const options = withLanding ? { planning, landing } : { planning }
    const builtins = provision === "host"
      ? yield* provisionHostBuiltins(stateRoot, policy, options)
      : yield* provisionBuiltins(stateRoot, policy)
    const project = yield* Registry.make({
      sources: [{ root: join(repositoryPath, "flows"), source: "project", naming: "path" }]
    }).pipe(Effect.provide(Discovery.layer))
    const registry = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows)
    const built = yield* repositoryCatalog({ delegates: [RunSetup, RunJob, RunTrigger] }, builtins.load).pipe(
      Effect.provideService(Registry.Registry, registry)
    )
    const listed = (yield* registry.list()).map((entry) => entry.name)
    return { missing: missingCodingExecutables(built, options), listed }
  }).pipe(Effect.provide(platform), Effect.runPromise)

test("a coding project with no flows/coding tree serves every configured coding route", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  assert.deepEqual((await startup(repositoryPath, stateRoot, "host")).missing, [])
})

test("fresh and reused hosts retire CI, Feature and Chores command doors", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const root = join(stateRoot, "builtin-flows", policy)
  for (const reused of [false, true]) {
    if (reused) {
      for (const job of ["ci", "feature", "chores"]) {
        const directory = join(root, "repository-jobs", job)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "flow.ts"), "throw new Error('Retired job must not import')")
      }
    }
    const started = await startup(repositoryPath, stateRoot, "host")
    assert.deepEqual(started.missing, [])
    for (const job of ["ci", "feature", "chores"]) {
      assert.equal(started.listed.includes(`repository-jobs/${job}`), false)
      await assert.rejects(access(join(root, "repository-jobs", job)), { code: "ENOENT" })
    }
    for (const job of ["issues", "review"]) {
      assert.equal(started.listed.includes(`repository-jobs/${job}`), true)
    }
    await Effect.gen(function*() {
      const { routes } = yield* FileRouter.scan({ root })
      const commands = yield* Command.make(routes)
      for (const job of ["ci", "feature", "chores"]) {
        assert.equal(routes.some((route) => route.name === `repository-jobs/${job}`), false)
        const result = yield* commands.execute(`repository-jobs ${job}`).pipe(Effect.result)
        assert.equal(result._tag, "Failure", job)
      }
    }).pipe(
      Effect.provideService(
        FlowInvoker.FlowInvoker,
        FlowInvoker.make({ invoke: () => Effect.die("Retired jobs must not dispatch") })
      ),
      Effect.provide(platform),
      Effect.runPromise
    )
  }
})

test("fresh and reused install hosts refuse the five-job setup and maintainer command doors", async (t) => {
  const { stateRoot } = await workspace(t)
  const root = join(stateRoot, "builtin-flows", policy)
  const retired = [
    "repository/setup",
    "repository/trigger",
    "repository-jobs/issues",
    "repository-jobs/review",
    "repository-jobs/ci",
    "repository-jobs/feature",
    "repository-jobs/chores"
  ]
  for (const reused of [false, true]) {
    if (reused) {
      await Effect.runPromise(provisionBuiltins(stateRoot, policy).pipe(Effect.provide(platform)))
      for (const name of retired) {
        const directory = join(root, name)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "flow.ts"), "throw new Error('Retired install door must not import')")
      }
    }
    await Effect.runPromise(
      provisionHostBuiltins(stateRoot, policy, { retainedRepositoryJobs: false }).pipe(Effect.provide(platform))
    )
    await Effect.gen(function*() {
      const { routes } = yield* FileRouter.scan({ root })
      const commands = yield* Command.make(routes)
      for (const name of retired) {
        assert.equal(routes.some((route) => route.name === name), false, name)
        assert.equal((yield* commands.execute(name.replaceAll("/", " ")).pipe(Effect.result))._tag, "Failure", name)
      }
      assert.ok(routes.some((route) => route.name === "coding/implementation"))
    }).pipe(
      Effect.provideService(
        FlowInvoker.FlowInvoker,
        FlowInvoker.make({ invoke: () => Effect.die("Retired install doors must not dispatch") })
      ),
      Effect.provide(platform),
      Effect.runPromise
    )
    for (const name of retired) await assert.rejects(access(join(root, name)), { code: "ENOENT" })
  }
})

test("retiring packaged job doors preserves pinned source for existing history", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const root = join(stateRoot, "builtin-flows", policy)
  const directory = join(root, "repository-jobs", "ci")
  await mkdir(directory, { recursive: true })
  const body = `import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"
export default ({ name: "repository-jobs/ci", description: "Run the reviewed ci responsibility with recorded evidence.", capabilities: ["*"], flows: ["repository/RunJob"], effects: undefined, input: Schema.Unknown, output: Schema.Unknown } satisfies FlowBinding.Declared)
`
  await writeFile(join(directory, "flow.ts"), body)
  await Effect.gen(function*() {
    const registry = yield* Registry.make({
      sources: [{ root, source: "repository-host", naming: "path", system: true }]
    })
    const descriptor = yield* registry.get("repository-jobs/ci")
    const executable = yield* Executable.fromDescriptor(descriptor, {
      delegates: [RunJob],
      // The packaged host loads its compiled declaration after exact-byte
      // admission; this temporary root has no package installation.
      load: (_file, source) => {
        assert.equal(new TextDecoder().decode(source.bytes), body)
        return Effect.succeed({
          default: {
            name: "repository-jobs/ci",
            description: "Run the reviewed ci responsibility with recorded evidence.",
            capabilities: ["*"],
            flows: [RunJob._tag],
            effects: undefined,
            input: Schema.Unknown,
            output: Schema.Unknown
          }
        })
      }
    })
    const digest = Descriptor.executionDigest(executable.descriptor)!
    const snapshots = yield* ExecutionSnapshot.makeFileSystem({ root: repositoryPath })
    yield* snapshots.pin(executable)
    yield* provisionHostBuiltins(stateRoot, policy, {
      planning: { ...project, implementation: "coding/implementation" },
      landing,
      retainedRepositoryJobs: false
    })
    const restored = yield* snapshots.restore(digest)
    assert.equal(restored.descriptor.name, "repository-jobs/ci")
    assert.equal(Descriptor.executionDigest(restored.descriptor), digest)
    assert.equal(restored.descriptor.body._tag, "Module")
    assert.equal(new TextDecoder().decode(restored.bytes), body)
  }).pipe(
    Effect.provide(Discovery.layer),
    Effect.provide(NodeCrypto.layer),
    Effect.provide(platform),
    Effect.runPromise
  )
  await assert.rejects(access(directory), { code: "ENOENT" })
})

test("a repository with no flows of its own serves the stack's review on the coding/review role", async (t) => {
  // The stack launches review/change on every open TODO pull request
  // (mythicalReviewFlow); a customer's repository carries no flows/review.
  const { repositoryPath, stateRoot } = await workspace(t)
  for (const provision of ["host", "defaults"] as const) {
    assert.ok((await startup(repositoryPath, stateRoot, provision)).listed.includes("review/change"), provision)
  }
  const review = await Effect.gen(function*() {
    const builtins = yield* provisionBuiltins(stateRoot, policy)
    const project = yield* Registry.make({
      sources: [{ root: join(repositoryPath, "flows"), source: "project", naming: "path" }]
    }).pipe(Effect.provide(Discovery.layer))
    return yield* bindRepositoryRegistry(project, builtins.registry, policy, systemFlows).get("review/change")
  }).pipe(Effect.provide(platform), Effect.runPromise)
  assert.equal(review.provenance.source, "repository-host")
  // A seat alias would need that vendor's key; the role resolves on the
  // host's own keys (reviewSeats), so an install with one key still reviews.
  assert.equal(Option.getOrUndefined(review.model), "coding/review")
})

test("without the built-in routes the same repository fails the host's startup check", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  assert.deepEqual((await startup(repositoryPath, stateRoot, "defaults")).missing, [
    "coding/rebase-conflict",
    "coding/verify",
    "coding/wiki",
    "flow-load"
  ])
})

test("retired routes stay absent with or without a landing binding", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const bound = await startup(repositoryPath, stateRoot, "host")
  assert.equal(bound.listed.includes("coding/vibe"), false)
  const unbound = await startup(repositoryPath, stateRoot, "host", false)
  assert.deepEqual(unbound.missing, [])
  assert.equal(unbound.listed.includes("coding/vibe"), false)
  assert.equal(unbound.listed.includes("coding/request"), false)
  // The TODO composition is never a host route: only stack admission of a
  // pinned attempt may start it, and no host can tell such a launch apart.
  assert.equal(bound.listed.includes("todo") || unbound.listed.includes("todo"), false)
})

// 2026-09-29, production: in a workspace of smithersai/smithers the repository's
// own flows/coding/request/flow.ts (the former built-in source) shadowed the
// bundled route and could not load on the host ("runs code this host cannot
// pin"), so every coding host exited with "Required coding executable
// coding/request is unavailable". An older copy of flows/coding.mdx in another
// repository failed the same way.
test("a stale repository request entry cannot restore the retired route", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  await mkdir(join(repositoryPath, "flows", "coding", "request"), { recursive: true })
  // Discovered, then refused at load (a prompt body needs the "agent"
  // delegate this host does not register), as the production copies were.
  await writeFile(
    join(repositoryPath, "flows", "coding", "request", "flow.mdx"),
    "---\ndescription: A stale repository copy of the request route.\n---\n\nPlan the request.\n"
  )
  const started = await startup(repositoryPath, stateRoot, "host")
  assert.deepEqual(started.missing, [])
  assert.equal(started.listed.filter((name) => name === "coding/request").length, 0)
})

const moduleSource = (name: string, description: string, topLevel = "") => `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
${topLevel}
export default Flow.make(${JSON.stringify(name)}, {
  description: ${JSON.stringify(description)}, capabilities: [],
  payload: {}, success: Schema.String,
  body: () => Node.succeed(${JSON.stringify(description)})
})
`

/** Real discovery/import admission with minimal packaged flow defaults. */
const boundary = async (
  t: TestContext,
  names: ReadonlyArray<string> = systemFlows,
  packagedNames: ReadonlyArray<string> = ["merge", "review"]
) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(repositoryPath, "node_modules"), "dir")
  const defaults = join(stateRoot, "defaults")
  for (const name of packagedNames) {
    await mkdir(join(defaults, name), { recursive: true })
    await writeFile(join(defaults, name, "flow.ts"), moduleSource(name, `Packaged ${name}`))
  }
  const catalog = () =>
    Effect.gen(function*() {
      const make = (root: string, source: string) =>
        Registry.make({ sources: [{ root, source, naming: "path" }] })
          .pipe(Effect.provide(Discovery.layer))
      const base = yield* make(join(repositoryPath, "flows"), "project")
      const packaged = yield* make(defaults, "repository-host")
      const registry = bindRepositoryRegistry(base, packaged, policy, names)
      const built = yield* repositoryCatalog({ delegates: [] }, (file) => {
        const name = packagedNames.find((candidate) => file.includes(`/${candidate}/`)) ?? "review"
        return Effect.succeed({
          default: Flow.make(name, {
            payload: {},
            success: Schema.String,
            body: () => Node.succeed(`Packaged ${name}`)
          })
        })
      }).pipe(Effect.provideService(Registry.Registry, registry))
      return { built, registry }
    }).pipe(Effect.provide(platform), Effect.runPromise)
  const write = async (name: string, topLevel = "") => {
    await mkdir(join(repositoryPath, "flows", name), { recursive: true })
    await writeFile(join(repositoryPath, "flows", name, "flow.ts"), moduleSource(name, `Repository ${name}`, topLevel))
  }
  return { catalog, write, repositoryPath }
}

test("a system-name collision is refused before importing its top-level canary and the packaged flow survives", async (t) => {
  const { catalog, write, repositoryPath } = await boundary(t)
  const marker = join(repositoryPath, "reserved-imported")
  await write("merge", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported")`)
  const { built, registry } = await catalog()
  assert.deepEqual(built.refused.map(({ flow, code }) => ({ flow, code })), [{ flow: "merge", code: "reserved_name" }])
  const executable = built.executables.find((entry) => entry.descriptor.name === "merge")
  assert.ok(executable)
  assert.equal(executable.descriptor.provenance.source, "repository-host")
  assert.ok(Graph.build(executable.flow, { input: {} }).nodes.some((node) => node.payload === "Packaged merge"))
  const refusal = built.refused[0]!
  assert.equal(
    Schema.decodeSync(Executable.ExecutableError)(Schema.encodeSync(Executable.ExecutableError)(refusal)).code,
    "reserved_name"
  )
  assert.equal((await Effect.runPromise(registry.get("merge"))).description, "Packaged merge")
  await assert.rejects(access(marker), { code: "ENOENT" })
})

test("a repository review overrides its packaged default and its module is admitted", async (t) => {
  const { catalog, write, repositoryPath } = await boundary(t)
  const marker = join(repositoryPath, "review-imported")
  await write("review", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported")`)
  const { built } = await catalog()
  assert.deepEqual(built.refused, [])
  assert.equal(built.executables.filter((entry) => entry.descriptor.name === "review").length, 1)
  const executable = built.executables.find((entry) => entry.descriptor.name === "review")!
  assert.equal(executable.descriptor.provenance.source, "project")
  assert.ok(Graph.build(executable.flow, { input: {} }).nodes.some((node) => node.payload === "Repository review"))
  await access(marker)
})

test("a system-named repository module is refused even when no packaged default exists", async (t) => {
  const { catalog, write } = await boundary(t)
  await write("flow-load", "throw new Error(\"Reserved module must never be imported\")")
  const { built, registry } = await catalog()
  assert.equal(built.refused.find((entry) => entry.flow === "flow-load")?.code, "reserved_name")
  assert.equal(built.executables.some((entry) => entry.descriptor.name === "flow-load"), false)
  await assert.rejects(Effect.runPromise(registry.get("flow-load")), /not_found/)
})

test("system name matching is exact and takes its names only from the launch catalog", async (t) => {
  // Separate trees preserve casing on case-insensitive macOS filesystems.
  for (const name of ["Merge", "merge/x", "repository/setup", "members.add.more", "secrets.set.more"]) {
    const { catalog, write } = await boundary(t, ["merge", "members.add", "secrets.set"])
    await write(name)
    const { built } = await catalog()
    assert.deepEqual(built.refused, [])
    assert.ok(built.executables.some((entry) => entry.descriptor.name === name), name)
  }
})

// Compatibility coding routes retain install ownership even when unconfigured.
for (
  const name of [
    "members.add",
    "secrets.set",
    "coding/wiki",
    "stack.candidate",
    "todo.preapprove",
    "todo.unapprove",
    "todo.retry-current-flow",
    "repository-jobs/ci",
    "repository-jobs/feature",
    "repository-jobs/chores"
  ]
) {
  test(`install-owned ${name} is refused before import without a packaged default`, async (t) => {
    const { catalog, write, repositoryPath } = await boundary(t)
    const marker = join(repositoryPath, "reserved-imported")
    await write(name, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported")`)
    const { built, registry } = await catalog()
    assert.deepEqual(built.refused.map(({ flow, code }) => ({ flow, code })), [{ flow: name, code: "reserved_name" }])
    assert.equal(built.executables.some((entry) => entry.descriptor.name === name), false)
    await assert.rejects(Effect.runPromise(registry.get(name)), /not_found/)
    await assert.rejects(access(marker), { code: "ENOENT" })
  })
}

const requestSteps = [
  "coding/RequestFeedback",
  "coding/prepare-stack-base",
  "coding/create-stack-base",
  "coding/install-dependency-pages",
  "factory/Todo",
  "coding/PrepareRequest",
  "coding/admit-retained-source",
  "coding/CoordinateRequest",
  "factory/stamp-route",
  "coding/Request"
]
const pauseBoundary = ["coding/todo-pause-requested", "system/wait-for", "coding/todo-resume", "coding/todo-boundary"]

// Composition inspection does not claim the joint guest/Active-source gate.
// Existing routes remain discoverable exclusively for legacy draining.
test("the TODO composition reuses request steps and inlines delivery while no host serves it", async (t) => {
  assert.equal(Todo._tag, "todo")
  const graph = Graph.build(Todo, {
    prompt: "Add a regression test.",
    base: {
      commitId: "1111111111111111111111111111111111111111",
      ref:
        "refs/smithers/workspaces/11111111-2222-3333-4444-555555555555/sources/1111111111111111111111111111111111111111"
    }
  })
  const calls = graph.nodes.flatMap(({ ast }) =>
    ast._tag === "FlowCall" ? [ast.flow] : ast._tag === "ActionCall" ? [ast.action] : []
  )
  assert.deepEqual(calls, [
    ...pauseBoundary,
    ...requestSteps,
    ...pauseBoundary,
    "coding/todo-delivery",
    "coding/AdmitVibe",
    "coding/CleanVibeHistory",
    "coding/LandVibe",
    "coding/Vibe",
    ...pauseBoundary,
    "todo"
  ])
  assert.equal(
    calls.includes("coding/todo-review"),
    false,
    "E-19 ends delivery instead of parking the TODO run for review"
  )
  assert.equal(calls.includes("coding/Verify"), false, "verification remains an engine launch")
  assert.equal(calls.includes("review/change"), false, "review remains an engine launch")
  const { repositoryPath, stateRoot } = await workspace(t)
  const started = await startup(repositoryPath, stateRoot, "host")
  assert.deepEqual(started.missing, [])
  assert.equal(started.listed.includes("todo"), false)
})

// Packaged or repository, `todo` is refused before import until pinned-source
// activation binds a launch to its attempt (T-FLW-03/04): a generic route,
// such as an invoked or triggered run, never reaches it.
for (const packaged of [false, true]) {
  test(`a TODO ${packaged ? "beside a packaged composition " : ""}is refused before import until pinned-source activation is integrated`, async (t) => {
    const { catalog, write, repositoryPath } = await boundary(
      t,
      systemFlows,
      packaged ? ["merge", "review", "todo"] : ["merge", "review"]
    )
    const marker = join(repositoryPath, "todo-imported")
    assert.deepEqual(factory.on["issue.labeled:todo"], { flow: "todo", description: "Implement every TODO" })
    await write("todo", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported")`)
    const { built, registry } = await catalog()
    assert.deepEqual(built.refused.map(({ flow, code }) => ({ flow, code })), [{
      flow: "todo",
      code: "missing_service"
    }])
    assert.equal(built.executables.some((entry) => entry.descriptor.name === "todo"), false)
    await assert.rejects(Effect.runPromise(registry.get("todo")), /body_unavailable/)
    await assert.rejects(Effect.runPromise(registry.loadBody("todo", "b".repeat(64))), /body_unavailable/)
    assert.equal((await Effect.runPromise(registry.list())).some((entry) => entry.name === "todo"), false)
    await assert.rejects(access(marker), { code: "ENOENT" })
  })
}

/** The `todo` descriptor discovery measures under a flows root, without importing it. */
const todoDescriptor = (flowsRoot: string) =>
  Registry.make({ sources: [{ root: flowsRoot, source: "project", naming: "path" }] }).pipe(
    Effect.flatMap((registry) => registry.get("todo")),
    Effect.provide(Discovery.layer),
    Effect.provide(platform),
    Effect.runPromise
  )
const closure = (descriptor: Descriptor.FlowDescriptor) =>
  descriptor.body._tag === "Module" ? descriptor.body.imports ?? [] : undefined

// A repository overrides `todo` by copying only flows/todo/flow.ts (spec
// §10.4.1a); the steps it imports come from the coding host the install ships
// (§11.3.0). The copy needs no flows/coding tree and no installed packages:
// the packaged host loads it with the host's own step flows.
test("a repository copy of the TODO composition loads on the packaged host with the host's steps", {
  timeout: 300_000
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-todo-copy-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repository = join(temporary, "repository"), flows = join(repository, "flows")
  await mkdir(join(flows, "todo"), { recursive: true })
  await copyFile(fileURLToPath(new URL("../todo/flow.ts", import.meta.url)), join(flows, "todo", "flow.ts"))
  const probe = join(repository, "steps.mjs")
  await writeFile(probe, "export * from \"@smthrs/coding\"\n")
  const output = join(temporary, "host.mjs")
  await bundle(fileURLToPath(new URL("./fixtures/coding-host-todo-entry.ts", import.meta.url)), output)
  const payload = {
    prompt: "Add a regression test.",
    base: {
      commitId: "1111111111111111111111111111111111111111",
      ref:
        "refs/smithers/workspaces/11111111-2222-3333-4444-555555555555/sources/1111111111111111111111111111111111111111"
    }
  }
  const flags = process.versions.bun ? [] : ["--experimental-strip-types"]
  const host = JSON.parse(
    execFileSync(process.execPath, [...flags, output, flows, probe, JSON.stringify(payload)], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"]
    })
  )
  assert.deepEqual(host.refused, [])
  assert.equal(host.loaded, "todo")
  assert.deepEqual(host.exports, [
    "CheckCommand",
    "Request",
    "RequestInput",
    "StackBase",
    "TodoBoundary",
    "TodoDelivery",
    "TodoReview",
    "Vibe",
    "VibeDelivered",
    "VibeError"
  ])
  assert.equal(host.hostSteps, true, "the copy runs the host's own step flows, not a second copy")
  // The copy plans exactly the built-in's steps.
  const builtin = Graph.build(Todo, payload).nodes.map(({ ast }) =>
    ast._tag === "FlowCall" ? ast.flow : ast._tag === "ActionCall" ? ast.action : ast._tag
  )
  assert.deepEqual(host.calls, builtin)
  assert.deepEqual(builtin.filter((call) => call.includes("/")), [
    ...pauseBoundary,
    ...requestSteps,
    ...pauseBoundary,
    "coding/todo-delivery",
    "coding/AdmitVibe",
    "coding/CleanVibeHistory",
    "coding/LandVibe",
    "coding/Vibe",
    ...pauseBoundary
  ])
  // Source discovery and the packaged host measure one version, and it is the
  // composition alone: the steps are the host's, so no coding module is in its
  // closure. The built-in here measures the same bytes, so a byte-identical
  // copy differs from it only by where it lives.
  const copy = await todoDescriptor(flows)
  assert.equal(host.digest, Descriptor.executionDigest(copy))
  assert.deepEqual(host.imports, [])
  assert.deepEqual(closure(copy), [])
  const own = await todoDescriptor(fileURLToPath(new URL("../", import.meta.url)))
  assert.deepEqual(closure(own), [])
  assert.equal(own.body.contentDigest, copy.body.contentDigest)
})

test("an admitted pin loads the packaged default TODO without a repository override", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const { todo: digest } = JSON.parse(
    await readFile(new URL("../../packages/backend/internal/services/builtin_flows.json", import.meta.url), "utf8")
  )
  await Effect.gen(function*() {
    const builtins = yield* provisionBuiltins(stateRoot, policy)
    const project = yield* Registry.make({
      sources: [{
        root: join(repositoryPath, "flows"),
        source: "project",
        naming: "path",
        lockfileRoot: repositoryPath
      }]
    }).pipe(Effect.provide(Discovery.layer))
    const pinned = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows, digest)
    const descriptor = yield* pinned.get("todo")
    assert.equal(Descriptor.executionDigest(descriptor), digest)
    assert.equal((yield* pinned.loadBody("todo", digest))._tag, "Module")
    const built = yield* repositoryCatalog({ delegates: [RunSetup, RunJob, RunTrigger] }, builtins.load).pipe(
      Effect.provideService(Registry.Registry, pinned)
    )
    assert.equal(built.executables.find((entry) => entry.descriptor.name === "todo")?.declaredTag, "todo")
    const generic = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows)
    assert.equal((yield* generic.loadBody("todo", digest).pipe(Effect.result))._tag, "Failure")
    const stale = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows, "0".repeat(64))
    assert.equal((yield* stale.loadBody("todo").pipe(Effect.result))._tag, "Failure")
  }).pipe(Effect.provide(platform), Effect.runPromise)
})

// A repository without flows/review runs the install's review (C-J10-09
// setup): the entry and every module beside it are the shipped bytes, and the
// value is the module the host compiled from them, its layer included.
test("a repository without its own review runs the packaged default with its modules and layer", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const { review: digest } = JSON.parse(
    await readFile(new URL("../../packages/backend/internal/services/builtin_flows.json", import.meta.url), "utf8")
  )
  const subject = join(repositoryPath, "..", "subject")
  await mkdir(subject)
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: subject, stdio: "pipe" })
  git("init", "-q")
  await writeFile(join(subject, "file.ts"), "export const n = 1;\n")
  git("add", ".")
  git(
    "-c",
    "user.name=Review",
    "-c",
    "user.email=review@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "base"
  )
  await writeFile(join(subject, "file.ts"), "export const n = 2;\n")
  let asked = 0
  const result = await Effect.gen(function*() {
    const builtins = yield* provisionBuiltins(stateRoot, policy)
    const project = yield* Registry.make({
      sources: [{ root: join(repositoryPath, "flows"), source: "project", naming: "path" }]
    }).pipe(Effect.provide(Discovery.layer))
    const registry = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows)
    const descriptor = yield* registry.get("review")
    assert.equal(descriptor.provenance.source, "repository-host")
    assert.equal(Descriptor.executionDigest(descriptor), digest)
    assert.equal((yield* registry.loadBody("review", digest))._tag, "Module")
    const built = yield* repositoryCatalog({ delegates: [] }, builtins.load).pipe(
      Effect.provideService(Registry.Registry, registry)
    )
    assert.equal(built.refused.find((entry) => entry.flow === "review"), undefined)
    const review = built.executables.find((entry) => entry.descriptor.name === "review")
    assert.equal(review?.declaredTag, "review")
    yield* Layer.build(review!.layer)
    const runtime = yield* FlowRuntime.FlowRuntime
    return yield* runtime.execute(review!.flow, {
      payload: { input: { repo: subject, narrate: false, verify: false } },
      executionId: crypto.randomUUID()
    })
  }).pipe(
    Effect.scoped,
    Effect.provide(reviewHost(scriptedSeats(() => {
      asked++
      return { status: "success", comments: [], warnings: [] }
    }))),
    Effect.runPromise
  ) as { review: { status: string }; ui: { kind: string; html: string } }
  assert.equal(asked, 1)
  assert.equal(result.review.status, "success")
  assert.equal(result.ui.kind, "html")
  assert.match(result.ui.html, /file\.ts/)
})

test("a packaged review whose modules changed on disk is refused before its compiled value runs", async (t) => {
  const { stateRoot } = await workspace(t)
  await Effect.gen(function*() {
    const builtins = yield* provisionBuiltins(stateRoot, policy)
    const root = join(stateRoot, "builtin-flows", policy)
    const helper = join(root, "review", "src", "workflow", "reviewFlow.ts")
    yield* Effect.promise(async () => writeFile(helper, `${await readFile(helper, "utf8")}\n// changed\n`))
    const registry = yield* Registry.make({
      sources: [{ root, source: "repository-host", naming: "path", system: true }]
    }).pipe(Effect.provide(Discovery.layer))
    const descriptor = yield* registry.get("review")
    assert.equal(
      descriptor.body._tag === "Module" &&
        descriptor.body.imports?.some((entry) => entry.path === "src/workflow/reviewFlow.ts"),
      true
    )
    const built = yield* Executable.catalog({ delegates: [], load: builtins.load }).pipe(
      Effect.provideService(Registry.Registry, registry)
    )
    const refusal = built.refused.find((entry) => entry.flow === "review")
    assert.equal(refusal?.code, "body_unavailable")
    assert.match(String((refusal?.cause as Error | undefined)?.message), /Bundled declaration bytes changed/)
    assert.equal(built.executables.some((entry) => entry.descriptor.name === "review"), false)
  }).pipe(Effect.provide(platform), Effect.runPromise)
})

test("legacy coding doors and engine verification/review are absent from model commands", async (t) => {
  const names = ["coding/request", "coding/vibe", "coding/verify", "review/change"]
  const { catalog, write } = await boundary(t, names, names)
  for (const name of ["coding/request", "coding/vibe"]) {
    await write(name, "throw new Error(\"retired modules must never import\")")
  }
  const { registry, built } = await catalog()
  for (const name of ["coding/request", "coding/vibe"]) {
    assert.equal(built.executables.some((entry) => entry.descriptor.name === name), false)
    assert.equal((await Effect.runPromise(registry.getOption(name)))._tag, "None")
    assert.equal((await Effect.runPromise(registry.loadBody(name).pipe(Effect.result)))._tag, "Failure")
  }
  const visible = await Effect.runPromise(registry.visible())
  assert.deepEqual(visible.filter((entry) => names.includes(entry.name)), [])
  // Retained engine execution still resolves the packaged implementation.
  for (const name of ["coding/verify", "review/change"]) {
    const entry = await Effect.runPromise(registry.get(name))
    assert.equal(entry.name, name)
    assert.equal(entry.modelInvocable, false)
  }
})

test("filesystem commands cannot start the retired request or delivery entries", async () => {
  await Effect.gen(function*() {
    const { routes } = yield* FileRouter.scan({ root: fileURLToPath(new URL("../", import.meta.url)) })
    assert.equal(routes.some((route) => ["coding/request", "coding/vibe"].includes(route.name)), false)
    for (const name of ["coding/verify", "review/change"]) {
      assert.equal(routes.find((route) => route.name === name)?.modelInvocable, false)
    }
    const commands = yield* Command.make(routes)
    for (const command of ["coding request", "coding vibe", "coding verify", "review change"]) {
      const result = yield* commands.execute(command).pipe(Effect.result)
      assert.equal(result._tag, "Failure")
    }
  }).pipe(
    Effect.provideService(
      FlowInvoker.FlowInvoker,
      FlowInvoker.make({
        invoke: () => Effect.die("A retired command must never dispatch")
      })
    ),
    Effect.provide(platform),
    Effect.runPromise
  )
})
