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
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { missingCodingExecutables, provisionHostBuiltins } from "../coding/host.ts"
import { Landing } from "../coding/landing.ts"
import { loadProject } from "../coding/project-config.ts"
import { bindRepositoryRegistry, provisionBuiltins, repositoryCatalog } from "../repository/registry.ts"
import { RunJob, RunSetup } from "../repository/setup.ts"
import { RunTrigger } from "../repository/triggers.ts"

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
    const registry = bindRepositoryRegistry(project, builtins.registry, policy)
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
