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
import { Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { factory } from "../../.smithers/FACTORY.ts"
import * as PinnedFlow from "../../packages/smithers/src/internal/PinnedFlow.ts"
import { bundle } from "../coding/build.mjs"
import { missingCodingExecutables, provisionHostBuiltins } from "../coding/host.ts"
import { Landing } from "../coding/landing.ts"
import { loadProject } from "../coding/project-config.ts"
import { makePinnedFlows, type PinnedFlows } from "../repository/pinned.ts"
import { bindRepositoryRegistry, provisionBuiltins, repositoryCatalog } from "../repository/registry.ts"
import { RunJob, RunSetup } from "../repository/setup.ts"
import { RunTrigger } from "../repository/triggers.ts"
import Todo from "../todo/flow.ts"
import { systemFlows } from "./fixtures/system-flows.ts"

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
    kind: "current",
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
    "coding/request",
    "coding/vibe",
    "coding/verify",
    "coding/wiki",
    "flow-load"
  ])
})

test("a route the host stops serving is no longer discoverable under the same policy", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const bound = await startup(repositoryPath, stateRoot, "host")
  assert.ok(bound.listed.includes("coding/vibe"))
  const unbound = await startup(repositoryPath, stateRoot, "host", false)
  assert.deepEqual(unbound.missing, [])
  assert.equal(unbound.listed.includes("coding/vibe"), false)
  assert.ok(unbound.listed.includes("coding/request"))
  // The TODO composition is never a host route: only stack admission of a
  // pinned attempt may start it, and no host can tell such a launch apart.
  assert.equal(bound.listed.includes("todo") || unbound.listed.includes("todo"), false)
})

// 2026-09-29, production: in a workspace of smithersai/smithers the repository's
// own flows/coding/request/flow.ts (the source of the built-in) shadowed the
// bundled route and could not load on the host ("runs code this host cannot
// pin"), so every coding host exited with "Required coding executable
// coding/request is unavailable". An older copy of flows/coding.mdx in another
// repository failed the same way.
test("a repository's own coding route never replaces the one the host requires", async (t) => {
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
  assert.equal(started.listed.filter((name) => name === "coding/request").length, 1)
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
  packagedNames: ReadonlyArray<string> = ["merge", "review"],
  pinned?: (repositoryPath: string) => PinnedFlows
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
      const registry = bindRepositoryRegistry(base, packaged, policy, names, pinned?.(repositoryPath))
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
    "todo.retry-current-flow"
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

// The composition plans the host's own request and delivery children, and a
// host lists it only while a TODO's pinned launch has activated a version.
test("the TODO composition reuses the request and delivery children and no host lists it unpinned", async (t) => {
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
  assert.deepEqual(calls, ["coding/Request", "coding/todo-delivery", "coding/Vibe", "todo"])
  const { repositoryPath, stateRoot } = await workspace(t)
  const started = await startup(repositoryPath, stateRoot, "host")
  assert.deepEqual(started.missing, [])
  assert.equal(started.listed.includes("todo"), false)
})

// Packaged or repository, `todo` is refused before import unless a TODO's
// pinned launch activated its version (spec §11.4.1): a generic route, such as
// an invoked or triggered run, never reaches it.
for (const packaged of [false, true]) {
  test(`a TODO ${packaged ? "beside a packaged composition " : ""}is refused before import without a pinned launch`, async (t) => {
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

/** The version digest flow-load measures for a `todo` source (flow-load.ts versionDigest). */
const measuredDigest = async (t: TestContext, source: string) => {
  const root = await mkdtemp(join(tmpdir(), "coding-pinned-measure-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "todo"), { recursive: true })
  await writeFile(join(root, "todo", "flow.ts"), source)
  return (await todoDescriptor(root)).body.contentDigest!
}

// Spec §11.4.1: a TODO's pinned launch reads `flows/todo/flow.ts` from the
// pinned main commit, or the built-in when that commit has none, never from
// the working copy, and serves it only at the pinned digest.
test("a pinned launch activates the TODO flow read at its source commit, never the working copy", async (t) => {
  const pinnedSource = moduleSource("todo", "Pinned todo")
  const reads: Array<string> = []
  let pinned: PinnedFlows | undefined
  const { catalog, write, repositoryPath } = await boundary(
    t,
    systemFlows,
    ["merge", "review"],
    (repositoryPath) =>
      pinned ??= Effect.gen(function*() {
        return makePinnedFlows({
          // Host state beside the fixture's node_modules, outside its flows/.
          root: join(repositoryPath, ".host-state"),
          read: (commit, relative) => {
            reads.push(`${commit}:${relative}`)
            return Effect.succeed(commit === "1".repeat(40) ? pinnedSource : undefined)
          },
          builtin: (name) => name === "todo" ? moduleSource("todo", "Built-in todo") : undefined,
          fs: yield* FileSystem.FileSystem,
          path: yield* Path.Path
        })
      }).pipe(Effect.provide(platform), Effect.runSync)
  )
  const marker = join(repositoryPath, "working-copy-todo-imported")
  await write("todo", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported")`)
  const { registry } = await catalog()
  const activate = PinnedFlow.of(registry)
  assert.ok(activate, "the bound registry carries its pinning capability")
  const digest = await measuredDigest(t, pinnedSource)
  // Another digest is refused and leaves the TODO flow dark.
  await assert.rejects(
    Effect.runPromise(activate({ flow: "todo", sourceCommit: "1".repeat(40), executionDigest: "e".repeat(64) })),
    /execution_changed|measures/
  )
  await assert.rejects(Effect.runPromise(registry.get("todo")), /body_unavailable/)
  await assert.rejects(
    Effect.runPromise(activate({ flow: "review", sourceCommit: "1".repeat(40), executionDigest: digest })),
    /not a pinned flow/
  )
  const descriptor = await Effect.runPromise(
    activate({ flow: "todo", sourceCommit: "1".repeat(40), executionDigest: digest })
  )
  assert.deepEqual(reads.slice(-1), [`${"1".repeat(40)}:flows/todo/flow.ts`])
  assert.equal(descriptor.description, "Pinned todo")
  assert.equal((await Effect.runPromise(registry.get("todo"))).description, "Pinned todo")
  const listed = (await Effect.runPromise(registry.list())).filter((entry) => entry.name === "todo")
  assert.deepEqual(listed.map((entry) => entry.description), ["Pinned todo"])
  // The catalog builds the pinned version, and the working copy's is never imported.
  const { built } = await catalog()
  const executable = built.executables.find((entry) => entry.descriptor.name === "todo")
  assert.ok(executable, JSON.stringify(built.refused))
  assert.equal(executable.descriptor.description, "Pinned todo")
  assert.equal(built.refused.some((entry) => entry.flow === "todo"), false)
  await assert.rejects(access(marker), { code: "ENOENT" })
  assert.ok(pinned?.active("todo"))
})

test("a pinned launch at a commit without flows/todo runs the built-in composition at its digest", async (t) => {
  const builtin = moduleSource("todo", "Built-in todo")
  const { catalog } = await boundary(t, systemFlows, ["merge", "review"], (repositoryPath) =>
    Effect.gen(function*() {
      return makePinnedFlows({
        root: join(repositoryPath, ".host-state"),
        read: () => Effect.succeed(undefined),
        builtin: (name) => name === "todo" ? builtin : undefined,
        fs: yield* FileSystem.FileSystem,
        path: yield* Path.Path
      })
    }).pipe(Effect.provide(platform), Effect.runSync))
  const { registry } = await catalog()
  const descriptor = await Effect.runPromise(
    PinnedFlow.of(registry)!({
      flow: "todo",
      sourceCommit: "2".repeat(40),
      executionDigest: await measuredDigest(t, builtin)
    })
  )
  assert.equal(descriptor.description, "Built-in todo")
})

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
    "Request",
    "RequestInput",
    "StackBase",
    "TodoDelivery",
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
    "coding/Request",
    "coding/todo-delivery",
    "coding/Vibe"
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
