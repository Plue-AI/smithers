/*
 * L106: the registry a workspace really has, and what is in it.
 *
 * `/flow.create` launched `create-workflow` — a 0.x JSX name no 1.0
 * composition ever registered — and refused on every workspace. The half this
 * file guards is the other one: that the id the door now launches
 * (`FLOW_AUTHORING_ENTRY`, imported from the module the app imports, so this
 * cannot pass against a name only this test believes in) resolves in the
 * registry `flows/coding/host.ts` actually composes.
 *
 * That composition is `bindRepositoryRegistry(project, builtins, policy)` over
 * `provisionBuiltins`, and it is built here from the real functions against a
 * real temporary state root and a real empty repository — the shape of a
 * freshly imported repo, which is where this was measured broken. A mock
 * registry would pass whatever the host composed.
 *
 * It also pins the fact the app half depends on: the entry is a PROMPT body.
 * `AgentSession` returns early for every non-Prompt body before its trace and
 * pump, so a module entry would put a run card on screen with no agent frames
 * in it.
 */
import { NodeServices } from "@effect/platform-node"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import {
  FLOW_AUTHORING_ENTRY,
  FLOW_AUTHORING_PACK,
  FLOW_AUTHORING_STAGES
} from "../../packages/rpc/src/FlowAuthoring.ts"
import { authoringBodies, bindRepositoryRegistry, provisionBuiltins } from "../repository/registry.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer

/** The registry `flows/coding/host.ts` builds, over a given repository root. */
const composedRegistry = (repositoryPath: string, stateRoot: string) =>
  Effect.gen(function*() {
    const builtins = yield* provisionBuiltins(stateRoot, "a".repeat(64))
    const project = yield* Registry.make({
      sources: [{ root: join(repositoryPath, "flows"), source: "project", naming: "path" }]
    })
      .pipe(Effect.provide(Discovery.layer))
    return bindRepositoryRegistry(project, builtins.registry, "a".repeat(64))
  })

const workspace = async (t: TestContext, options: { readonly ownFlows?: Record<string, string> } = {}) => {
  const temporary = await mkdtemp(join(tmpdir(), "create-flow-registry-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repositoryPath = join(temporary, "repo"), stateRoot = join(temporary, "state")
  await mkdir(join(repositoryPath, "flows"), { recursive: true })
  for (const [name, text] of Object.entries(options.ownFlows ?? {})) {
    await mkdir(join(repositoryPath, "flows", name), { recursive: true })
    await writeFile(join(repositoryPath, "flows", name, "flow.mdx"), text)
  }
  return { repositoryPath, stateRoot }
}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect as Effect.Effect<A, E, never>)

test("a freshly imported repository can run the flow the app's create door launches", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const resolved = await run(
    composedRegistry(repositoryPath, stateRoot).pipe(
      Effect.flatMap((registry) =>
        Effect.all({
          entry: registry.get(FLOW_AUTHORING_ENTRY),
          body: registry.loadBody(FLOW_AUTHORING_ENTRY),
          listed: registry.list(),
          visible: registry.visible()
        })
      ),
      Effect.provide(platform)
    )
  )

  assert.equal(resolved.entry.name, FLOW_AUTHORING_ENTRY)
  // The app half depends on this: only a Prompt body reaches the trace and pump.
  assert.equal(resolved.body._tag, "Prompt")
  assert.ok(resolved.body.text.trim().length > 0, "the entry body must carry a prompt")
  for (
    const heading of [
      "# Clarify the flow request",
      "# Provision what the new flow needs",
      "# Design the flow graph",
      "# Scaffold the flow",
      "# Fix the flow until it verifies",
      "# Document the new flow"
    ]
  ) {
    assert.ok(resolved.body.text.includes(heading), `the entry is missing ${heading}`)
  }
  assert.ok(resolved.body.text.includes("call `ask`"), "the design must reach the control approval gate")
  assert.ok(
    !resolved.body.text.includes("Call one, do what it says"),
    "the entry must not require nested markdown calls"
  )
  // The entry owns the stage instructions. Stages remain independently
  // runnable, but the parent must not see a nested call this host refuses.
  assert.deepEqual(
    resolved.listed.map((entry) => entry.name).filter((name) => name.startsWith("create-flow")).sort(),
    [...FLOW_AUTHORING_PACK].sort()
  )
  for (const stage of FLOW_AUTHORING_STAGES) {
    assert.ok(!resolved.visible.some((entry) => entry.name === stage), `${stage} must not be callable by the entry`)
  }
  // The 0.x name is not, and never was, in this registry.
  assert.equal(resolved.listed.some((entry) => entry.name === "create-workflow"), false)
})

test("a freshly imported repository carries the first-party issue and PR review prompts", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const names = ["issue/repro", "issue/poc", "pr-triage"]
  const installed = await run(
    composedRegistry(repositoryPath, stateRoot).pipe(
      Effect.flatMap((registry) =>
        Effect.forEach(
          names,
          (name) => Effect.all({ descriptor: registry.get(name), body: registry.loadBody(name) })
        )
      ),
      Effect.provide(platform)
    )
  )
  for (const [index, name] of names.entries()) {
    const flow = installed[index]!
    assert.equal(flow.descriptor.name, name)
    assert.equal(flow.body._tag, "Prompt")
    assert.ok(flow.body.text.trim().length > 0)
    assert.equal(flow.descriptor.model._tag, "Some")
    if (flow.descriptor.model._tag === "Some") {
      assert.equal(flow.descriptor.model.value, name === "issue/repro" ? "repository/research" : name === "issue/poc" ? "coding/poc" : "luna")
    }
    if (name === "pr-triage") {
      assert.deepEqual(flow.descriptor.capabilities, ["fs:read:**", "fs:write:.triage/report.json", "proc:spawn:rg *"])
      assert.match(flow.body.text, /Never execute code from the PR/)
      assert.match(flow.body.text, /Never\s+approve, merge, close, or assign the PR/)
      assert.equal(flow.descriptor.provenance.source, "repository-host")
    }
  }
})

test("every pack body declares a seat the host can resolve, or the run fails at launch", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const descriptors = await run(
    composedRegistry(repositoryPath, stateRoot).pipe(
      Effect.flatMap((registry) => Effect.forEach(FLOW_AUTHORING_PACK, (name) => registry.get(name))),
      Effect.provide(platform)
    )
  )
  // `AgentSession.approvedSeat` refuses a prompt flow whose descriptor names
  // no model, so a body without one is a run that dies at launch rather than
  // a flow that is merely unconfigured. `flows/coding/host.ts` maps this role
  // onto whatever model the deployment writes code with.
  for (const descriptor of descriptors) {
    assert.equal(descriptor.model._tag, "Some", `${descriptor.name} declares no model seat`)
    assert.equal(descriptor.model.value, "flow/author")
  }
})

test("a repository that writes its own create-flow keeps it", async (t) => {
  const own =
    "---\ndescription: This repository's own authoring flow.\nmodel: flow/author\n---\n\nUse our house rules.\n"
  const { repositoryPath, stateRoot } = await workspace(t, { ownFlows: { "create-flow": own } })
  const body = await run(
    composedRegistry(repositoryPath, stateRoot).pipe(
      Effect.flatMap((registry) => registry.loadBody(FLOW_AUTHORING_ENTRY)),
      Effect.provide(platform)
    )
  )
  assert.equal(body._tag, "Prompt")
  assert.ok(body.text.includes("Use our house rules."), "the project's own body must win over the built-in")
})

test("a repository's own PR triage prompt overrides the bundled default", async (t) => {
  const own = "---\ndescription: This repository's PR intake.\nmodel: luna\ncapabilities: [\"fs:read:**\"]\n---\n\nApply our review checklist.\n"
  const { repositoryPath, stateRoot } = await workspace(t, { ownFlows: { "pr-triage": own } })
  const resolved = await run(composedRegistry(repositoryPath, stateRoot).pipe(
    Effect.flatMap((registry) => Effect.all({ descriptor: registry.get("pr-triage"), body: registry.loadBody("pr-triage") })),
    Effect.provide(platform)
  ))
  assert.equal(resolved.descriptor.provenance.source, "project")
  assert.deepEqual(resolved.descriptor.capabilities, ["fs:read:**"])
  assert.equal(resolved.body._tag, "Prompt")
  assert.match(resolved.body.text, /Apply our review checklist/)
  assert.doesNotMatch(resolved.body.text, /Never execute code from the PR/)
})

test("the bodies the host installs are the bodies in this repository", async () => {
  const bodies = await run(authoringBodies.pipe(Effect.provide(platform)))
  assert.deepEqual([...bodies.keys()].sort(), [...FLOW_AUTHORING_PACK, "issue/repro", "issue/poc", "pr-triage"].sort())
  for (const [name, text] of bodies) {
    assert.ok(text.startsWith("---\n"), `${name} must carry frontmatter`)
    const seat = name === "issue/repro" ? "repository/research" : name === "issue/poc" ? "coding/poc" : name === "pr-triage" ? "luna" : "flow/author"
    assert.ok(text.includes(`model: ${seat}`), `${name} must declare the configured seat`)
  }
})
