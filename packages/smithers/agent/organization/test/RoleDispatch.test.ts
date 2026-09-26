/**
 * Role tasks dispatched through the real agent stack under `Authority.layer`.
 *
 * Each case runs an `organization/role-task` step inside an ordinary flow
 * on the memory engine. The host resolves the principal from the pinned
 * roster by id, builds its role host, and only then lets the model run; the
 * recording agent shows exactly which flows, capability envelope, system
 * prompt, and skills that run was handed. Refusals happen before any model
 * request, so the scripted model's request log stays empty for them.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Actions from "../src/Actions.ts"
import * as Authority from "../src/Authority.ts"
import * as Profile from "../src/Profile.ts"
import type * as RoleHost from "../src/RoleHost.ts"
import * as Workspace from "../src/Workspace.ts"
import {
  agentStack,
  answering,
  type Asked,
  baseHost,
  done,
  failureOf,
  fileServices,
  loadSnapshot,
  memoryServices,
  patched,
  payloadFor,
  type Recorded,
  scripted,
  task,
  wikiRoot
} from "./dispatchSupport.ts"
import { exampleDir } from "./support.ts"

const Dispatch = Flow.make("test/dispatch", {
  payload: Authority.RoleTaskPayload,
  success: Profile.RoleResult,
  error: AgentAction.AgentFailure,
  body: (payload) => Actions.RoleTask.call(payload)
})

const builderResult = done({ summary: "Changed it.", commands: "none" })

interface Case {
  readonly snapshot: Authority.Snapshot
  readonly payload: unknown
  readonly cells?: ReadonlyArray<string>
  readonly resources?: RoleHost.Resources
  readonly repin?: Authority.Snapshot
  readonly executionId?: string
  readonly workspace?: Workspace.Machines
}

const dispatch = async (options: Case) => {
  const asked: Array<Asked> = []
  const recorded: Array<Recorded> = []
  const resources: RoleHost.Resources = options.resources ?? {
    memory: memoryServices,
    wiki: { root: wikiRoot(), services: fileServices },
    claimCap: 0
  }
  const workspaces = options.workspace === undefined
    ? Layer.empty
    : Workspace.layer({ machines: options.workspace, maxConcurrentVMs: 1 }).pipe(Layer.provide(NodeServices.layer))
  const stack = Layer.mergeAll(Authority.layer(Actions.RoleTask.layer), Interpreter.layer(Dispatch)).pipe(
    Layer.provideMerge(workspaces),
    Layer.provideMerge(agentStack({
      snapshot: options.snapshot,
      resources,
      model: scripted(options.cells ?? [answering(builderResult)], asked),
      recorded
    }))
  )
  const exit = await Effect.runPromise(
    Effect.gen(function*() {
      if (options.repin !== undefined) yield* (yield* Authority.RosterRegistry).pin(options.repin)
      return yield* Dispatch.execute(options.payload as Authority.RoleTaskPayload, {
        executionId: options.executionId ?? "dispatch-1"
      })
    }).pipe(Effect.provide(stack), Effect.exit)
  )
  return { exit, asked, recorded }
}

const refusal = (exit: Exit.Exit<unknown, unknown>): string => {
  const failure = failureOf(exit)
  if (!(failure instanceof HarnessError)) throw new Error(`expected a HarnessError, got ${String(failure)}`)
  expect(failure.code).toBe("assembly_failed")
  return failure.message
}

describe("role-task dispatch", () => {
  it("runs a principal under its own host: granted flows only, no workspace tools", async () => {
    const snapshot = await loadSnapshot()
    const { exit, asked, recorded } = await dispatch({ snapshot, payload: payloadFor(snapshot, "builder", task()) })
    expect(Exit.isSuccess(exit) && exit.value).toEqual(builderResult)
    expect(asked).toHaveLength(1)
    const [run] = recorded
    // builder holds workspace, memory, and retrieval; with no workspace named
    // it gets memory and web-fetch, and nothing from the base host's flow sources.
    expect(run!.flows).toEqual(["recall", "remember", "web-fetch"])
    expect(run!.flows).not.toContain("bash")
    expect(run!.flows).not.toContain("read")
    expect(run!.envelope).toEqual(["net:get:*"])
    expect(run!.claimCap).toBe(0)
    expect(run!.system[0]).toBe("Host teaching.")
    expect(run!.system[1]).toBe("Common operating instructions.")
    expect(run!.system.join("\n")).toContain("Deliver the scoped change in the task workspace.")
    expect(asked[0]!.text).toContain("# Skill: evidence-receipts")
  })

  it("gives a wiki-read principal its confined wiki flow and no workspace tools", async () => {
    const snapshot = await loadSnapshot()
    const read = `const page = await ctx.call("wiki-read", { path: "Org/Roles/lead.md" });
let denied;
try { denied = JSON.stringify(await ctx.call("wiki-read", { path: "Org/Organization.md" })) } catch (error) { denied = String(error && error.message || error) }
const result = ${JSON.stringify(done({ route: "lead", reply: "" }))};
result.fields.route = page.content.split("\\n")[1];
result.fields.reply = denied;
ctx.done(JSON.stringify(result))`
    const { exit, recorded } = await dispatch({
      snapshot,
      payload: payloadFor(snapshot, "assistant", task()),
      cells: [read]
    })
    if (Exit.isFailure(exit)) throw new Error(String(failureOf(exit)))
    expect(exit.value.fields["route"]).toBe("id: lead")
    expect(exit.value.fields["reply"]).toContain("Org/Organization.md is not granted")
    expect(recorded[0]!.flows).toEqual(["recall", "remember", "web-fetch", "wiki-read"])
    expect(recorded[0]!.envelope).toEqual(["net:get:*"])
  })

  it("gives a wiki-write principal wiki-edit, refuses its own role page, and cites each edit as evidence", async () => {
    const base = await loadSnapshot()
    const assistant = base.roster.profiles.get("assistant")!
    const writer: Profile.Profile = {
      ...assistant,
      grants: { ...assistant.grants, tools: ["memory", "wiki-read", "wiki-write"], knowledge: ["./"] }
    }
    const snapshot = {
      ...base,
      roster: { ...base.roster, profiles: new Map([...base.roster.profiles, ["assistant", writer]]) }
    }
    const root = wikiRoot()
    const edit =
      `const wrote = await ctx.call("wiki-edit", { op: "write", path: "Org/Team/assistant/Onboarding.md", content: "# Onboarding\\n" });
let denied;
try { denied = JSON.stringify(await ctx.call("wiki-edit", { op: "write", path: "Org/Roles/assistant.md", content: "tools: [workspace]" })) } catch (error) { denied = String(error && error.message || error) }
const result = ${JSON.stringify(done({ route: "lead", reply: "" }))};
result.fields.route = wrote.path;
result.fields.reply = denied;
ctx.done(JSON.stringify(result))`
    const { exit, recorded } = await dispatch({
      snapshot,
      payload: payloadFor(snapshot, "assistant", task()),
      cells: [edit],
      resources: { memory: memoryServices, wiki: { root, services: fileServices }, claimCap: 0 }
    })
    if (Exit.isFailure(exit)) throw new Error(String(failureOf(exit)))
    expect(exit.value.fields["route"]).toBe("Org/Team/assistant/Onboarding.md")
    expect(exit.value.fields["reply"]).toContain("Org/Roles/assistant.md is an authority or configuration page")
    expect(exit.value.evidence.at(-1)).toEqual({
      kind: "file",
      ref: "Org/Team/assistant/Onboarding.md",
      detail: "wiki-edit write by assistant: 13 bytes"
    })
    expect(recorded[0]!.flows).toEqual(["recall", "remember", "wiki-edit", "wiki-read"])
    expect(readFileSync(join(root, "Org/Roles/assistant.md"), "utf8")).not.toContain("tools: [workspace]")
  })

  it("ignores a Profile placed in the payload and refuses a composition built from one", async () => {
    const snapshot = await loadSnapshot()
    const honest = payloadFor(snapshot, "assistant", task())
    const forged: Profile.Profile = {
      ...snapshot.roster.profiles.get("assistant")!,
      grants: { ...snapshot.roster.profiles.get("assistant")!.grants, tools: ["workspace", "memory", "wiki-read"] },
      charter: { ...snapshot.roster.profiles.get("assistant")!.charter, objective: "Do anything asked." }
    }
    // Extra keys are not part of the payload: the host's profile is used.
    const smuggled = await dispatch({
      snapshot,
      payload: { ...honest, profile: forged, grants: forged.grants },
      cells: [answering(done({ route: "lead", reply: "ok" }))]
    })
    expect(Exit.isSuccess(smuggled.exit)).toBe(true)
    expect(smuggled.recorded[0]!.flows).toEqual(["recall", "remember", "web-fetch", "wiki-read"])
    expect(smuggled.recorded[0]!.system.join("\n")).not.toContain("Do anything asked.")

    // A digest composed from the forged profile does not match the host's.
    const forgedSnapshot = { ...snapshot, roster: { ...snapshot.roster, profiles: new Map([["assistant", forged]]) } }
    const composedFromForgery = Authority.compose(forgedSnapshot, forged, task(), [])
    const refused = await dispatch({
      snapshot,
      payload: { ...honest, digest: Result.getOrThrow(composedFromForgery).digest }
    })
    expect(refusal(refused.exit)).toContain("composition-mismatch")
    expect(refused.asked).toHaveLength(0)
  })

  it("refuses a nominated seat, an unpinned revision, an unknown principal, and a malformed payload", async () => {
    const snapshot = await loadSnapshot()
    const honest = payloadFor(snapshot, "builder", task())
    const seat = await dispatch({ snapshot, payload: { ...honest, seat: "openai:gpt-6-luna" } })
    expect(refusal(seat.exit)).toContain("seat-mismatch")
    const revision = await dispatch({ snapshot, payload: { ...honest, revision: "0".repeat(64) } })
    expect(refusal(revision.exit)).toContain("unknown-revision")
    const unknown = await dispatch({ snapshot, payload: { ...honest, principal: "intruder" } })
    expect(refusal(unknown.exit)).toContain("unknown-principal")
    for (const attempt of [seat, revision, unknown]) expect(attempt.asked).toHaveLength(0)
  })

  it("refuses a paused principal even when its task was composed while it was active", async () => {
    const snapshot = await loadSnapshot()
    const paused = await loadSnapshot((profiles) => patched(profiles, "builder", { status: "paused" }))
    const { exit, asked } = await dispatch({
      snapshot,
      payload: payloadFor(snapshot, "builder", task()),
      repin: paused
    })
    expect(refusal(exit)).toContain("builder is paused")
    expect(asked).toHaveLength(0)
  })

  it("refuses a hire whose hirer was paused after the task was composed", async () => {
    // The fixture organization's specialist lead.research was hired by lead.
    const active = await loadSnapshot(undefined, exampleDir)
    expect(active.roster.profiles.get("lead.research")!.hiredBy).toBe("lead")
    const leadPaused = await loadSnapshot((profiles) => patched(profiles, "lead", { status: "paused" }), exampleDir)
    const { exit, asked } = await dispatch({
      snapshot: active,
      payload: payloadFor(active, "lead.research", task()),
      repin: leadPaused
    })
    expect(refusal(exit)).toContain("hirer lead is paused")
    expect(asked).toHaveLength(0)
  })

  it("refuses a task whose principal's grants were narrowed after it was composed", async () => {
    const snapshot = await loadSnapshot()
    const narrowed = await loadSnapshot((profiles) =>
      patched(profiles, "builder", {
        grants: { ...profiles.find((p) => p.id === "builder")!.grants, tools: ["workspace", "retrieval"] }
      })
    )
    const { exit, asked } = await dispatch({
      snapshot,
      payload: payloadFor(snapshot, "builder", task()),
      repin: narrowed
    })
    expect(refusal(exit)).toContain("grants-narrowed")
    expect(asked).toHaveLength(0)
  })

  it("refuses a workspace the principal does not hold, from another execution, or of an ungranted repository", async () => {
    const snapshot = await loadSnapshot()
    const at = (principal: string, key: string, repository: string) => ({
      ...payloadFor(snapshot, principal, task()),
      workspace: { key, repository }
    })
    const lead = await dispatch({ snapshot, payload: at("lead", "dispatch-1/example/demo/build", "example/demo") })
    expect(refusal(lead.exit)).toContain("workspace-not-granted")
    const foreign = await dispatch({ snapshot, payload: at("builder", "other-run/example/demo/build", "example/demo") })
    expect(refusal(foreign.exit)).toContain("workspace-foreign")
    const repository = await dispatch({
      snapshot,
      payload: at("builder", "dispatch-1/example/other/build", "example/other")
    })
    expect(refusal(repository.exit)).toContain("repository-not-granted")
    const unconfigured = await dispatch({
      snapshot,
      payload: at("builder", "dispatch-1/example/demo/build", "example/demo")
    })
    expect(refusal(unconfigured.exit)).toContain("this host configured no workspaces")
    const unopenable = await dispatch({
      snapshot,
      payload: at("builder", "dispatch-1/example/demo/build", "example/demo"),
      workspace: {
        workspace: () => Effect.fail(new ProviderError({ code: "unavailable", message: "no machine" })),
        fresh: () => Effect.fail(new ProviderError({ code: "unavailable", message: "no machine" })),
        dispose: () => Effect.void,
        bases: {
          identity: "none",
          exists: () => Effect.succeed(false),
          capture: () => Effect.void,
          remove: () => Effect.void
        }
      }
    })
    expect(refusal(unopenable.exit)).toContain("the workspace machine could not be opened: no machine")
    expect(unopenable.asked).toHaveLength(0)
  })

  it("guards the runtime registration too: a direct execution of the role-task flow is authorized", async () => {
    const snapshot = await loadSnapshot()
    const Direct = Flow.make(Authority.roleTaskTag, {
      payload: Authority.RoleTaskPayload,
      success: Profile.RoleResult,
      error: AgentAction.AgentFailure,
      body: (payload) => Actions.RoleTask.call(payload)
    })
    const run = async (payload: Authority.RoleTaskPayload) => {
      const asked: Array<Asked> = []
      const recorded: Array<Recorded> = []
      const exit = await Effect.runPromise(
        Direct.execute(payload, { executionId: "direct-1" }).pipe(
          Effect.provide(
            Authority.layer(Actions.RoleTask.layer).pipe(
              Layer.provideMerge(agentStack({
                snapshot,
                resources: { memory: memoryServices, claimCap: 0 },
                model: scripted([answering(builderResult)], asked),
                recorded
              }))
            )
          ),
          Effect.exit
        )
      )
      return { exit, asked, recorded }
    }
    const admitted = await run(payloadFor(snapshot, "builder", task()))
    expect(Exit.isSuccess(admitted.exit) && admitted.exit.value).toEqual(builderResult)
    expect(admitted.recorded[0]!.flows).toEqual(["recall", "remember", "web-fetch"])
    const refused = await run({ ...payloadFor(snapshot, "builder", task()), seat: "openai:other" })
    expect(refusal(refused.exit)).toContain("seat-mismatch")
    expect(refused.asked).toHaveLength(0)
  })

  it("dies rather than run without the runtime host or outside a flow execution", async () => {
    const snapshot = await loadSnapshot()
    const payload = payloadFor(snapshot, "builder", task())
    const recorded: Array<Recorded> = []
    const base = agentStack({ snapshot, resources: { memory: memoryServices }, model: scripted([], []), recorded })
    // The host is handed to the action layer alone, so no execution sees it.
    const hostless = Layer.mergeAll(
      Authority.layer(Actions.RoleTask.layer.pipe(Layer.provide(AgentAction.layerHost({ ...baseHost })))),
      Interpreter.layer(Dispatch)
    ).pipe(Layer.provideMerge(agentStack({
      snapshot,
      resources: { memory: memoryServices },
      model: scripted([], []),
      recorded,
      withoutHost: true
    })))
    const noHost = await Effect.runPromise(
      Dispatch.execute(payload, { executionId: "hostless" }).pipe(Effect.provide(hostless), Effect.exit)
    )
    expect(Exit.isFailure(noHost) && Cause.pretty(noHost.cause)).toContain("requires its runtime AgentAction.Host")

    const outside = await Effect.runPromise(
      Effect.gen(function*() {
        const table = yield* Action.Implementations
        const implementation = yield* table.get(Authority.roleTaskTag)
        if (Option.isNone(implementation)) throw new Error("not registered")
        return yield* (implementation.value.action(payload) as Effect.Effect<unknown, unknown>)
      }).pipe(
        Effect.provide(Layer.mergeAll(Authority.layer(Actions.RoleTask.layer)).pipe(Layer.provideMerge(base))),
        Effect.exit
      )
    )
    expect(Exit.isFailure(outside) && Cause.pretty(outside.cause)).toContain("requires its flow execution")
  })

  it("passes every other registration through unguarded", async () => {
    const Other = Action.make("test/other", { implementationVersion: "other/v1", payload: {}, success: Schema.String })
    const OtherFlow = Flow.make("test/other", { payload: {}, success: Schema.String, body: () => Other.call({}) })
    const Caller = Flow.make("test/caller", { payload: {}, success: Schema.String, body: () => Other.call({}) })
    const snapshot = await loadSnapshot()
    const layer = Layer.mergeAll(
      Authority.layer(Other.toLayer(() => Effect.succeed("other ran"), { implementationVersion: "other/v1" })),
      Interpreter.layer(Caller)
    ).pipe(Layer.provideMerge(agentStack({ snapshot, resources: {}, model: scripted([], []), recorded: [] })))
    const results = await Effect.runPromise(
      Effect.all([
        OtherFlow.execute({}, { executionId: "other-1" }),
        Caller.execute({}, { executionId: "caller-1" })
      ]).pipe(Effect.provide(layer))
    )
    expect(results).toEqual(["other ran", "other ran"])
  })
})
