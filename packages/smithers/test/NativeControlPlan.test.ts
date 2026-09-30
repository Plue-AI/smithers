/**
 * The native host's plan hook: a real registry, a real catalog and a real
 * durable control plane, asked to plan.
 *
 * Planning used to answer `nodes: []` for every discovered flow, because the
 * native runtime registered each descriptor without a `plan` hook — so the
 * one surface that can show a human what a run will do before they approve it
 * had nothing to show. The recipe is control/test/PlanHandoff.test.ts's, run
 * against the host instead of against a hand-built MemoryFlow.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Logger, PlatformError, Schema, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as CoreFlow from "../flows/core/src/Flow.ts"
import { settledKind } from "../src/internal/EngineJournalSupervisor.ts"
import * as NodeControl from "../src/NodeControl.ts"

const definition = {
  name: "native",
  description: "A native flow with two dependent steps.",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Unknown,
  capabilities: [],
  flows: ["test/Planned"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

const source = `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({
  name: "native",
  description: ${JSON.stringify(definition.description)},
  input: Schema.Struct({ value: Schema.String }), output: Schema.Unknown,
  capabilities: [], flows: ["test/Planned"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
`

/** One project root holding one discovered flow named `native`. */
const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-native-plan-"))
  await mkdir(join(root, "flows", "native"), { recursive: true })
  await writeFile(join(root, "flows", "native", "flow.ts"), source)
  return root
}

/**
 * The same project, committed, so the tree has a revision to be read at.
 *
 * The ignore file is the repository's own (`.flows/` and the state databases
 * are engine-owned and derived): a host writes its engine and control stores
 * under the checkout it serves, and a tree that counted those as changes
 * could never name a revision for the sources it loaded.
 */
const committedProject = async () => {
  const root = await project()
  await writeFile(join(root, ".gitignore"), ".flows/\n.smithers/\n")
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [
      "-c",
      "user.email=test@smithers.test",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      ...args
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
  git("init", "--quiet")
  git("add", "-A")
  git("commit", "--quiet", "-m", "one")
  return { root, head: git("rev-parse", "HEAD").trim() }
}

const Probe = Action.make("test/Probe", {
  payload: { value: Schema.String },
  success: Schema.String,
  error: Schema.Unknown
})

/** The delegate whose body the plan must graph, rather than the one-call wrapper around it. */
const Planned = Flow.make("test/Planned", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ input }) =>
    Probe.call({ value: `${(input as { value: string }).value}/first` }).pipe(
      Node.andThen(Probe.call({ value: `${(input as { value: string }).value}/second` }))
    )
})

/** A delegate that cannot be graphed: its body throws while the planner walks it. */
const Unplannable = Flow.make("test/Planned", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => {
    throw new Error("this body cannot be planned")
  }
})

/*
 * A delegate the planner walks to completion, whose drafts the plan compiler
 * then refuses: the payload holds a `bigint`, which has no canonical JSON
 * spelling, so `PersistedPlan.compile` rejects the node's material.
 */
const Uncompilable = Flow.make("test/Planned", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ value: 1n as never })
})

/**
 * Plans, approves and runs one discovered flow on the native host, and
 * answers the plan card beside the graph pages the engine recorded.
 *
 * The same host does both, which is the point: a plan is walked out of the
 * catalog this host loaded, and the run drives those same modules, so the
 * revision each of them names has to be the one revision that host read.
 */
const planAndRunOn = async (root: string, whileLoading?: () => Promise<void>) => {
  const registry = NodeControl.layerRegistry(root)
  const modules = Executable.layer({
    delegates: [Planned],
    load: () => Effect.succeed({ default: CoreFlow.make(definition) })
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Interpreter.layer(Planned), Probe.toLayer(({ value }) => Effect.succeed(value)))
    ),
    Layer.orDie,
    /*
     * The startup window itself: this runs inside the catalog's own build,
     * which is where the host reads the modules, and so between the revision
     * the host reads before that build and the one it reads after it.
     */
    (layer) => whileLoading === undefined ? layer : Layer.tap(layer, () => Effect.promise(whileLoading))
  )
  const card = await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const planned = yield* control.plan({ flowId: "native", input: { value: "planned" } })
      yield* control.approve(planned.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: planned.planId,
        digest: planned.digest,
        envelope: planned.envelope,
        idempotencyKey: `native-source-revision:${planned.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
        return yield* Effect.die("expected an accepted run")
      }
      /*
       * The supervisor's post-commit settlement, which is what
       * `CompositionContract.test.ts` waits for: the native wrapper's own
       * terminal state lands after the executor's handler returns.
       */
      yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
        Stream.filter((event) => event.kind === settledKind),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeoutOrElse({
          duration: "60 seconds",
          orElse: () => Effect.die(`run ${receipt.runId} never settled`)
        })
      )
      return planned
    }).pipe(
      Effect.provide(NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, undefined, modules)),
      Effect.scoped
    )
  )
  const database = new DatabaseSync(NodeControl.executionDatabasePath(root), { readOnly: true })
  try {
    const pages = database.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE event_type IN ('flows.engine.plan-recorded', 'flows.engine.subgraph-appended')"
    ).all().map((row) => {
      const payload = JSON.parse((row as { readonly payload_json: string }).payload_json) as {
        readonly graph?: { readonly sourceRevision?: unknown }
      }
      return payload.graph?.sourceRevision
    })
    return { card, pages }
  } finally {
    database.close()
  }
}

const planOn = async (
  root: string,
  delegate: typeof Planned,
  logs?: Array<string>,
  whileLoading?: () => Promise<void>
) => {
  const registry = NodeControl.layerRegistry(root)
  const modules = Executable.layer({
    delegates: [delegate],
    load: () => Effect.succeed({ default: CoreFlow.make(definition) })
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Interpreter.layer(delegate), Probe.toLayer(({ value }) => Effect.succeed(value)))
    ),
    Layer.orDie,
    (layer) => whileLoading === undefined ? layer : Layer.tap(layer, () => Effect.promise(whileLoading))
  )
  const capture = Logger.make((entry) => void logs?.push(JSON.stringify(entry.message)))
  return await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      return yield* control.plan({ flowId: "native", input: { value: "planned" } })
    }).pipe(
      Effect.provide(NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, undefined, modules)),
      Effect.scoped,
      Effect.provide(Logger.layer([capture]))
    )
  )
}

describe("planning a discovered flow on the native host", () => {
  it.each([
    [
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "AtomicFileSystem",
        method: "readFile",
        description: "Install the native helper or set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to its absolute path"
      }),
      "Install the native helper or set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to its absolute path"
    ],
    [new Error("opaque host failure"), "Flow source cannot be read"],
    [
      PlatformError.systemError({ _tag: "PermissionDenied", module: "AtomicFileSystem", method: "readFile" }),
      "Flow source cannot be read"
    ]
  ])("retains the catalog's designed body refusal before any admission", async (cause, message) => {
    const root = await project()
    try {
      const registry = NodeControl.layerRegistry(root)
      const modules = Layer.succeed(Executable.Catalog, {
        executables: [],
        refused: [
          new Executable.ExecutableError({
            code: "body_unavailable",
            flow: "native",
            available: [],
            message: "Flow source cannot be read",
            cause
          })
        ]
      })
      const planned = Effect.runPromise(
        Effect.flatMap(Control.Control, (control) => control.plan({ flowId: "native", input: { value: "planned" } }))
          .pipe(
            Effect.provide(
              NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, undefined, modules)
            ),
            Effect.scoped
          )
      )
      await expect(planned).rejects.toMatchObject({
        _tag: "/control/InvalidInput",
        issue: `Cannot load flow native: ${message}`
      })
      const database = new DatabaseSync(NodeControl.databasePath(root), { readOnly: true })
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM control_plans").get()).toEqual({ count: 0 })
        expect(database.prepare("SELECT COUNT(*) AS count FROM flows_runs").get()).toEqual({ count: 0 })
      } finally {
        database.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it("answers with the delegate's own keyed nodes and their edges", async () => {
    const root = await project()
    try {
      const card = await planOn(root, Planned)

      expect(card.nodes.length).toBeGreaterThan(1)
      expect(card.nodes.every((node) => /^key1_[0-9a-f]{64}$/.test(node.key))).toBe(true)
      expect(card.nodes.some((node) => node.dependsOn.length > 0)).toBe(true)
      // Every edge names nodes the card also reports, so a reader can draw it.
      const ids = new Set(card.nodes.map((node) => node.id))
      expect(card.nodes.flatMap((node) => [...node.dependsOn]).every((id) => ids.has(id))).toBe(true)
      expect(card.graph?.edges.length).toBeGreaterThan(0)
      expect(card.graph?.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true)
      // No cache probe exists on this host, so nothing may claim a hit.
      expect(card.nodes.map((node) => node.status)).toEqual(card.nodes.map(() => "run"))
      expect(card.plan?.planId).toBe(card.planId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  /*
   * D-054: the reader of a plan opens the node's code, so the card must say
   * where each node was declared. The path is repo-relative by the journal's
   * own rule, and a site this host cannot make relative is omitted rather
   * than recorded as the absolute path of somebody's machine (D-047).
   */
  it("names every node it keys, and leaks no absolute declaration path", async () => {
    const root = await project()
    try {
      const card = await planOn(root, Planned)

      expect(card.nodes.length).toBeGreaterThan(1)
      expect(card.graph?.nodes?.map((node) => node.id)).toEqual(card.nodes.map((node) => node.id))
      // These bodies are declared in this test file, which is outside the
      // project root this host planned in: the site is dropped whole. A host
      // that passed the builder's own path through would report this file.
      expect(card.graph?.nodes?.every((node) => node.declaredAt === undefined)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  /*
   * The other way a plan loses its nodes: the body walks, but the compiler
   * refuses the drafts it produced. Discovery already admitted the flow, so
   * the run door stays open over an empty plan rather than the command
   * failing, and the refusal is said out loud.
   */
  it("still plans a flow whose drafts the compiler refuses, with no nodes", async () => {
    const root = await project()
    try {
      const logs: Array<string> = []
      const card = await planOn(root, Uncompilable, logs)

      expect(card.nodes).toEqual([])
      expect(card.graph).toBeUndefined()
      expect(card.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(card.approval.target.digest).toBe(card.digest)
      // The compiler refused, not the walk: this is the recovery arm, not the
      // unwalkable-body one the test below covers.
      expect(logs.join("\n")).toContain("produced no graph")
      expect(logs.join("\n")).not.toContain("could not walk its body")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  /*
   * A plan with no nodes and no reason is a plan nobody can diagnose. The walk
   * is the only step here that fails in silence, so it says what it hit and on
   * which flow before the empty plan goes out.
   */
  it("says which flow's body it could not walk, and why", async () => {
    const root = await project()
    try {
      const logs: Array<string> = []
      const card = await planOn(root, Unplannable, logs)

      expect(card.nodes).toEqual([])
      const said = logs.join("\n")
      expect(said).toContain("could not walk its body")
      expect(said).toContain("this body cannot be planned")
      expect(said).toContain("native")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it("still plans a flow whose body cannot be graphed, with no nodes", async () => {
    const root = await project()
    try {
      const card = await planOn(root, Unplannable)

      expect(card.nodes).toEqual([])
      expect(card.graph).toBeUndefined()
      expect(card.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(card.approval.target.digest).toBe(card.digest)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

/*
 * D-068: a declaration site says where, never which bytes. The host records
 * the revision it read its flows out of beside the sites, so a reader can ask
 * for the file AT that revision instead of whatever is on disk when they look.
 */
describe("the revision a plan's sites were read at", () => {
  it("is the committed tree's own revision", async () => {
    const { root, head } = await committedProject()
    try {
      const card = await planOn(root, Planned)

      expect(card.graph?.sourceRevision).toBe(head)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  /*
   * The honest absence: a git tree with work that is not committed is not
   * described by any commit, so the host names none rather than a commit that
   * does not hold what it loaded. The plan is unchanged in every other way.
   */
  it("is absent where the tree has moved off every revision it could name", async () => {
    const { root } = await committedProject()
    try {
      await writeFile(join(root, "flows", "native", "flow.ts"), `${source}\n// edited after the commit\n`)
      const card = await planOn(root, Planned)

      expect(card.graph?.sourceRevision).toBeUndefined()
      expect(card.graph?.edges.length).toBeGreaterThan(0)
      expect(card.nodes.length).toBeGreaterThan(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  /*
   * A host is not alone on its tree. Reading the revision once, before the
   * catalog, records a name for bytes the catalog may never have held: the
   * write below lands while the modules are being read, so the tree the first
   * reading named is not the tree that was loaded. Two readings that disagree
   * name nothing, which is the same answer a dirty checkout gets.
   */
  it("names nothing when the tree moved while the catalog was being read", async () => {
    const { root } = await committedProject()
    try {
      const card = await planOn(root, Planned, undefined, async () => {
        await writeFile(
          join(root, "flows", "native", "flow.ts"),
          `${source}
// written during startup
`
        )
      })

      expect(card.graph?.sourceRevision).toBeUndefined()
      expect(card.graph?.edges.length).toBeGreaterThan(0)
      expect(card.nodes.length).toBeGreaterThan(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

/*
 * The other half of D-068: a run's own records carry declaration sites too,
 * and the host that drove them is the host that loaded the modules. Its
 * journal names the same revision its plans do.
 */
describe("the revision a run's recorded sites were driven at", () => {
  it("is the same one the plan named, on every page the engine recorded", async () => {
    const { root, head } = await committedProject()
    try {
      const { card, pages } = await planAndRunOn(root)

      expect(card.graph?.sourceRevision).toBe(head)
      expect(pages.length).toBeGreaterThan(0)
      expect(pages).toEqual(pages.map(() => head))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  /*
   * And it is the same NOTHING when the plan names nothing. The engine's store
   * is composed before the catalog is read, so a revision handed to it at that
   * moment is one nobody has verified yet: it asks for the host's answer at
   * each page instead, and a startup the host could not pin leaves every page
   * of the run with no revision rather than with a tree the run never drove.
   *
   * The write is a peer's, beside the flow rather than in it: the registry
   * pins each discovered body by digest and refuses to load one that moved, so
   * a flow file rewritten here would end the run on that refusal instead of
   * reaching the pages this asserts about. The tree still moved, and a host
   * that cannot prove its revision describes what it loaded names none.
   */
  it("is absent on every page when the tree moved while the catalog was being read", async () => {
    const { root } = await committedProject()
    try {
      const { card, pages } = await planAndRunOn(root, async () => {
        await writeFile(join(root, "peer.txt"), "a peer agent wrote here during startup\n")
      })

      expect(card.graph?.sourceRevision).toBeUndefined()
      expect(pages.length).toBeGreaterThan(0)
      expect(pages).toEqual(pages.map(() => undefined))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
