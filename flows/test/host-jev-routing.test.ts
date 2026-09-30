/** Real judged hosts route auto steps and execute Jev with the selected stance. */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as EventSink from "@smthrs/agent/EventSink"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Migrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as Migration from "@smthrs/migrate/flow/Layers"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as Suggest from "../../packages/smithers/src/suggest/SuggestFlow.ts"
import { agentLayers as releaseLayers } from "../release-support/runtime.ts"
import { agentLayers as wikiLayers } from "../wiki/runtime.ts"

const environment = { SMITHERS_SUPERVISOR_STANCE: "paranoid" }
const script = () =>
  [
    `const result = await ctx.call("jev", { state: { task: "Answer a question.", flow: "host-proof", description: "Answer", capabilities: [] }, questions: ${
      JSON.stringify(SeatRouter.edgeQuestions)
    } });`,
    "if (result.ok === false) throw new Error(JSON.stringify(result));",
    "ctx.done(\"{\\\"answer\\\":\\\"ok\\\"}\");"
  ].join("\n")
const model = Suggest.scriptedModel(script)
const seats = SeatResolver.layer({
  resolve: (id) =>
    Effect.succeed(Seat.make({
      id,
      modelId: id,
      model,
      contextWindowTokens: 200_000,
      route: {
        prepare: () =>
          Effect.succeed({
            routeId: "host-test",
            protocolId: "host-test",
            method: "POST",
            url: "https://example.invalid",
            publicHeaders: {},
            body: new TextEncoder().encode("{}"),
            bodyText: "{}"
          })
      }
    }))
})
const catalog = SeatRouter.layer({ candidates: Effect.succeed(SeatRouter.seats), variants: SeatRouter.defaultVariants })

for (const host of ["wiki", "release-support", "suggest", "migrate"] as const) {
  test(
    `${host}: auto routing, executable Jev and paranoid discipline reach the journal`,
    { timeout: 60_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "smithers-host-jev-"))
      t.after(() => rm(root, { recursive: true, force: true }))
      const step = AgentAction.make(`test/${host}/Auto`, {
        payload: { topic: Schema.String },
        output: Schema.Struct({ answer: Schema.String }),
        seat: Seat.auto,
        prompt: ({ topic }) => topic
      })
      const flow = Flow.make(`test/${host}/Proof`, {
        payload: { topic: Schema.String },
        success: Schema.Struct({ answer: Schema.String }),
        error: AgentAction.AgentFailure,
        body: (input) => step.call(input)
      })
      const production = host === "wiki" ?
        wikiLayers(seats, 60_000, ScriptedJudge.layerAll, { environment, catalog }) :
        host === "release-support" ?
        releaseLayers(seats, 100_000, ScriptedJudge.layerAll, { environment, catalog }) :
        host === "suggest" ?
        Suggest.layerScripted({ root, script, environment }) :
        Migration.layerScripted({
          root,
          commands: { typecheck: [], flowsDir: "flows" },
          runStatePaths: [],
          script,
          environment
        })
      const stores = SqlJournal.layer({ capacity: 256, overflow: "reject" }).pipe(
        Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
      )
      const runId = `host-${host}` as JournalEvent.RunId
      const sink = Layer.effect(
        EventSink.EventSink,
        Effect.map(Journal.Journal, (journal) => {
          let sequence = 0
          const project = AgentSession.tracer()
          return EventSink.make({
            emit: (event) => {
              const trace = project(event)
              return trace === undefined ? Effect.void : journal.emitLossy(
                new JournalEvent.Input({
                  runId,
                  sourceId: "host-proof" as JournalEvent.SourceId,
                  sourceSeq: sequence++ as JournalEvent.SourceSeq,
                  eventType: trace.eventType,
                  payload: trace.payload
                }, { disableChecks: true })
              ).pipe(Effect.asVoid, Effect.orDie)
            }
          })
        })
      )
      const wiring = Layer.mergeAll(step.layer, Interpreter.layer(flow)).pipe(
        Layer.provideMerge([production]),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(sink),
        Layer.provideMerge(stores)
      )
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(wiring)
        const result = yield* flow.execute({ topic: "Answer a question." }, { executionId: runId }).pipe(
          Effect.provideContext(context)
        )
        assert.deepEqual(result, { answer: "ok" })
        const journal = yield* Journal.Journal.pipe(Effect.provideContext(context))
        yield* journal.flush
        const entries = (yield* journal.entries({ runId, limit: 256 })).entries
        assert.ok(entries.some((entry) => entry.eventType === "control.agent.seat-routed"))
        const armed = entries.find((entry) => entry.eventType === "control.agent.discipline-armed")
        assert.ok(armed)
        assert.equal((armed.payload as { stance: string }).stance, "paranoid")
        assert.ok(entries.some((entry) =>
          entry.eventType === "control.agent.cell-call-settled" &&
          JSON.stringify(entry.payload).includes("\"flowName\":\"jev\"") &&
          JSON.stringify(entry.payload).includes("\"outcome\":\"success\"")
        ))
      })))
    }
  )
}
