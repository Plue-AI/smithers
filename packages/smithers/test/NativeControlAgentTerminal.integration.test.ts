/** The coding host's actual standard-flow composition never falls back to spawn. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option } from "effect"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NativeControl from "../src/internal/NativeControl.ts"
import { platform } from "../src/internal/NodeControlHost.ts"

it("the coding terminal selection refuses Bash through the assembled host without spawning", async () => {
  const scratch = join(process.cwd(), ".cache", "agent-terminal")
  mkdirSync(scratch, { recursive: true })
  const base = realpathSync(mkdtempSync(join(scratch, "host-")))
  const workspace = join(base, "workspace")
  mkdirSync(workspace)
  try {
    const native = NativeControl.make({ ...platform, shellTerminal: "agent" })
    let shell: FlowBinding.Binding | undefined
    const modules = Layer.effect(Executable.Catalog)(Effect.gen(function*() {
      const host = yield* AgentAction.Host
      const bindings = yield* Effect.forEach(host.flows ?? [], (source) => source.bindings())
      shell = bindings.flat().find((binding) => binding.descriptor.name === "bash")
      return Executable.Catalog.of({ executables: [], refused: [] })
    })).pipe(Layer.orDie)
    const registry = native.layerRegistry(workspace)
    const engine = native.engineDurable(workspace, registry)
    const executor = native.layerExecutor(registry, engine, workspace, {
      evaluator: ScriptedJudge.layerAll,
      environment: {},
      grants: GrantStore.layerNoop,
      modules
    })
    const application = Application.layer({ root: workspace }, registry, engine, executor) as Layer.Layer<
      Control.Control
    >
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Control.Control
        expect(shell).toBeDefined()
        const database = new DatabaseSync(native.executionDatabasePath(workspace), { readOnly: true })
        try {
          const spawned = () =>
            database.prepare(
              "SELECT COUNT(*) AS count FROM flows_journal_events WHERE event_type = 'flows.host.process-spawned.v1'"
            ).get()!.count
          const before = spawned()
          for (const container of [undefined, "branch"]) {
            const result = yield* shell!.run(
              new Cell.Call({
                flowName: "bash",
                input: {
                  mode: "unhermetic",
                  command: "printf escaped > ../agent-escape",
                  cwd: workspace,
                  ...(container === undefined ? {} : { container })
                },
                capabilities: [],
                effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
                placement: Option.none(),
                identity: new Cell.CallIdentity({
                  session: "agent-terminal",
                  frame: 0,
                  cell: "cell",
                  ordinal: 0,
                  declaration: "declaration",
                  layers: []
                })
              })
            )
            expect(result.outcome).toBe("failure")
            expect(JSON.stringify(result)).toContain("Agent terminal unavailable")
            expect(JSON.stringify(result)).toContain("C-J3-10 and C-COL-04")
            expect(existsSync(join(base, "agent-escape"))).toBe(false)
            expect(spawned()).toBe(before)
          }
        } finally {
          database.close()
        }
      }).pipe(Effect.provide(application), Effect.scoped)
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

it("the coding host's agent terminal port runs Bash through the assembled host without a host spawn", async () => {
  const scratch = join(process.cwd(), ".cache", "agent-terminal")
  mkdirSync(scratch, { recursive: true })
  const base = realpathSync(mkdtempSync(join(scratch, "host-")))
  const workspace = join(base, "workspace")
  mkdirSync(workspace)
  try {
    const seen: Array<unknown> = []
    const native = NativeControl.make({
      ...platform,
      shellTerminal: "agent",
      agentTerminal: () => ({
        execute: async function*(input) {
          seen.push(input)
          yield { kind: "output", bytes: new TextEncoder().encode("AGENT_TERMINAL_SECOND") }
          yield { kind: "exit", code: 0 }
        },
        killRun: async () => {}
      })
    })
    let shell: FlowBinding.Binding | undefined
    const modules = Layer.effect(Executable.Catalog)(Effect.gen(function*() {
      const host = yield* AgentAction.Host
      const bindings = yield* Effect.forEach(host.flows ?? [], (source) => source.bindings())
      shell = bindings.flat().find((binding) => binding.descriptor.name === "bash")
      return Executable.Catalog.of({ executables: [], refused: [] })
    })).pipe(Layer.orDie)
    const registry = native.layerRegistry(workspace)
    const engine = native.engineDurable(workspace, registry)
    const executor = native.layerExecutor(registry, engine, workspace, {
      evaluator: ScriptedJudge.layerAll, environment: {}, grants: GrantStore.layerNoop, modules
    })
    const application = Application.layer({ root: workspace }, registry, engine, executor) as Layer.Layer<Control.Control>
    await Effect.runPromise(Effect.gen(function*() {
      yield* Control.Control
      expect(shell).toBeDefined()
      const database = new DatabaseSync(native.executionDatabasePath(workspace), { readOnly: true })
      try {
        const spawned = () => database.prepare(
          "SELECT COUNT(*) AS count FROM flows_journal_events WHERE event_type = 'flows.host.process-spawned.v1'"
        ).get()!.count
        const before = spawned()
        const input = { mode: "unhermetic", command: "printf AGENT_TERMINAL_SECOND", cwd: workspace }
        const result = yield* shell!.run(new Cell.Call({
          flowName: "bash",
          input,
          capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
          placement: Option.none(),
          identity: new Cell.CallIdentity({ session: "agent-terminal", frame: 0, cell: "cell", ordinal: 0,
            declaration: "declaration", layers: [] })
        }))
        expect(result).toMatchObject({ outcome: "success", value: { exitCode: 0, stdout: "AGENT_TERMINAL_SECOND", stderr: "" } })
        expect(seen).toEqual([input])
        expect(spawned()).toBe(before)
      } finally {
        database.close()
      }
    }).pipe(Effect.provide(application), Effect.scoped))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
