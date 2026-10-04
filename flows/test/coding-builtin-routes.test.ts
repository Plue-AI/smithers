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
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { missingCodingExecutables, provisionHostBuiltins } from "../coding/host.ts"
import { Landing } from "../coding/landing.ts"
import { loadProject } from "../coding/project-config.ts"
import Todo from "../coding/todo.ts"
import { bindRepositoryRegistry, provisionBuiltins, repositoryCatalog } from "../repository/registry.ts"
import { RunJob, RunSetup } from "../repository/setup.ts"
import { RunTrigger } from "../repository/triggers.ts"
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

test("without the built-in routes the same repository fails the host's startup check", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  assert.deepEqual((await startup(repositoryPath, stateRoot, "defaults")).missing, [
    "coding/request",
    "coding/vibe",
    "coding/verify",
    "coding/wiki"
  ])
})

test("a route the host stops serving is no longer discoverable under the same policy", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  assert.ok((await startup(repositoryPath, stateRoot, "host")).listed.includes("coding/vibe"))
  const unbound = await startup(repositoryPath, stateRoot, "host", false)
  assert.deepEqual(unbound.missing, [])
  assert.equal(unbound.listed.includes("coding/vibe"), false)
  assert.ok(unbound.listed.includes("coding/request"))
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

/** Real discovery/import admission with two minimal packaged flow defaults. */
const boundary = async (t: TestContext, names: ReadonlyArray<string> = systemFlows) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(repositoryPath, "node_modules"), "dir")
  const defaults = join(stateRoot, "defaults")
  for (const name of ["merge", "review"]) {
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
        const name = file.includes("/merge/") ? "merge" : "review"
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
for (const name of ["members.add", "secrets.set", "coding/wiki", "stack.candidate", "todo.preapprove", "todo.unapprove"]) {
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

// Composition inspection does not claim the joint guest/Active-source gate.
// Existing routes remain discoverable exclusively for legacy draining.
test("the TODO composition reuses the request and delivery children and remains unmounted", async (t) => {
  assert.equal(Todo._tag, "todo")
  const graph = Graph.build(Todo, {
    prompt: "Add a regression test.",
    base: {
      commitId: "1111111111111111111111111111111111111111",
      ref: "refs/smithers/workspaces/11111111-2222-3333-4444-555555555555/sources/1111111111111111111111111111111111111111"
    }
  })
  const calls = graph.nodes.flatMap(({ ast }) =>
    ast._tag === "FlowCall" ? [ast.flow] : ast._tag === "ActionCall" ? [ast.action] : []
  )
  assert.deepEqual(calls, ["coding/Request", "coding/todo-delivery", "coding/Vibe", "todo"])
  const { repositoryPath, stateRoot } = await workspace(t)
  assert.equal((await startup(repositoryPath, stateRoot, "host")).listed.includes("todo"), false)
})

test("a TODO override is refused before import until pinned-source activation is integrated", async (t) => {
  const { catalog, write, repositoryPath } = await boundary(t)
  const marker = join(repositoryPath, "todo-imported")
  await write("todo", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported")`)
  const { built, registry } = await catalog()
  assert.deepEqual(built.refused.map(({ flow, code }) => ({ flow, code })), [{ flow: "todo", code: "missing_service" }])
  assert.equal(built.executables.some((entry) => entry.descriptor.name === "todo"), false)
  await assert.rejects(Effect.runPromise(registry.loadBody("todo", "b".repeat(64))), /body_unavailable/)
  assert.equal((await Effect.runPromise(registry.list())).some((entry) => entry.name === "todo"), false)
  await assert.rejects(access(marker), { code: "ENOENT" })
})
