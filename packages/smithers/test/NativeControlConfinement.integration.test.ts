/** The shipped native executor keeps owner adapters separate from agent commands. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Control } from "@smthrs/control"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option, type Schema } from "effect"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const scratch = process.env.SMITHERS_CONFINEMENT_TEST_SCRATCH ?? join(process.cwd(), ".cache", "process-confinement")
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})
const fixture = () => {
  mkdirSync(scratch, { recursive: true })
  const base = realpathSync(mkdtempSync(join(scratch, "native-boundary-")))
  roots.add(base)
  const workspace = join(base, "workspace")
  mkdirSync(workspace)
  return { base, workspace }
}
const call = (input: Schema.Json, flowName = "bash"): Cell.Call =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "native-boundary",
      frame: 0,
      cell: "cell",
      ordinal: 0,
      declaration: "declaration",
      layers: []
    })
  })
const build = (workspace: string, options: Partial<Parameters<typeof NodeControl.layerExecutor>[3]>) => {
  const registry = NodeControl.layerRegistry(workspace)
  const engine = NodeControl.engineDurable(workspace, registry)
  const executor = NodeControl.layerExecutor(registry, engine, workspace, {
    evaluator: ScriptedJudge.layerAll,
    environment: {},
    grants: GrantStore.layerNoop,
    ...options
  })
  // This local application branch uses no RPC socket or remote HTTP transport.
  return Application.layer({ root: workspace }, registry, engine, executor) as Layer.Layer<Control.Control>
}

it("starts an explicitly configured owner MCP adapter with its host access", async () => {
  const { base, workspace } = fixture()
  const marker = join(base, "owner-adapter")
  const server = `
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'owner');
    process.stdin.setEncoding('utf8'); let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
        if (!line.trim()) continue; const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {tools:{}}, serverInfo:{name:'owner',version:'0'} }
          : {tools:[]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
      }
    });`
  await Effect.runPromise(Control.Control.pipe(
    Effect.provide(
      build(workspace, { mcpServers: [{ server: "owner", command: process.execPath, args: ["-e", server] }] })
    ),
    Effect.scoped,
    Effect.timeout("25 seconds")
  ))
  expect(existsSync(marker)).toBe(true)
})

it("refuses native baseline comparison before any process and keeps workspace tests confined", async () => {
  const { base, workspace } = fixture()
  const escaped = join(base, "test-escape")
  const control = join(workspace, "runner-control")
  // Even repository metadata directing Git outside the grant must never be consulted.
  writeFileSync(join(workspace, ".git"), `gitdir: ${base}/outside-repository\n`)
  writeFileSync(
    join(workspace, "runtests.sh"),
    [
      `printf escaped 2>/dev/null > '${escaped}' || true`,
      "printf allowed > runner-control",
      "printf '1 passed in 0.1s\\n'"
    ].join("\n")
  )
  let tests: FlowBinding.Binding | undefined
  const modules = Layer.effect(Executable.Catalog)(Effect.gen(function*() {
    const host = yield* AgentAction.Host
    const bindings = yield* Effect.forEach(host.flows ?? [], (source) => source.bindings())
    tests = bindings.flat().find((binding) => binding.descriptor.name === "test")
    return Executable.Catalog.of({ executables: [], refused: [] })
  })).pipe(Layer.orDie)
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      expect(tests).toBeDefined()
      const database = new DatabaseSync(NodeControl.executionDatabasePath(workspace), { readOnly: true })
      try {
        const spawned = () =>
          database.prepare(
            "SELECT COUNT(*) AS count FROM flows_journal_events WHERE event_type = 'flows.host.process-spawned.v1'"
          ).get()!.count
        const before = spawned()
        const baseline = yield* tests!.run(call({ against: "base" }, "test"))
        expect(baseline.outcome).toBe("failure")
        expect(JSON.stringify(baseline)).toContain("Baseline comparison is unavailable on this host")
        expect(spawned()).toBe(before)
        expect(existsSync(control)).toBe(false)
        expect(existsSync(escaped)).toBe(false)
        const result = yield* tests!.run(call({ against: "workspace" }, "test"))
        expect(result.outcome, JSON.stringify(result)).toBe("success")
        const value = result.value as { exitCode: number; passed: number }
        expect(value.exitCode).toBe(0)
        expect(value.passed, JSON.stringify(value)).toBe(1)
        expect(spawned()).not.toBe(before)
        expect(existsSync(control)).toBe(true)
        expect(existsSync(escaped)).toBe(false)
      } finally {
        database.close()
      }
    }).pipe(
      Effect.provide(build(workspace, {
        modules,
        environment: { SMITHERS_TEST_COMMAND: "bash runtests.sh" },
        grants: GrantStore.layer({
          attended: false,
          rules: [
            new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "fs:*", resource: workspace }) }),
            new Rule({
              effect: "allow",
              pattern: new CapabilityPattern({ action: "fs:*", resource: `${workspace}/**` })
            }),
            new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" }) })
          ]
        }).pipe(Layer.provide(Workspace.layer(workspace)), Layer.orDie)
      })),
      Effect.scoped
    )
  )
}, 60_000)

it("keeps registered agent shell confined and refuses a named Docker transport", async () => {
  const { base, workspace } = fixture()
  let shell: FlowBinding.Binding | undefined
  const modules = Layer.effect(Executable.Catalog)(Effect.gen(function*() {
    const host = yield* AgentAction.Host
    const bindings = yield* Effect.forEach(host.flows ?? [], (source) => source.bindings())
    shell = bindings.flat().find((binding) => binding.descriptor.name === "bash")
    return Executable.Catalog.of({ executables: [], refused: [] })
  })).pipe(Layer.orDie)
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      expect(shell).toBeDefined()
      const result = yield* shell!.run(
        call({ mode: "unhermetic", command: "printf escaped > ../agent-escape", cwd: workspace })
      )
      expect(result.outcome).toBe("success")
      expect((result.value as { exitCode: number }).exitCode).not.toBe(0)
      expect(existsSync(join(base, "agent-escape"))).toBe(false)
      const database = new DatabaseSync(NodeControl.executionDatabasePath(workspace), { readOnly: true })
      const spawned = () =>
        database.prepare(
          "SELECT COUNT(*) AS count FROM flows_journal_events WHERE event_type = 'flows.host.process-spawned.v1'"
        ).get()!.count
      const before = spawned()
      const container = yield* shell!.run(call({ mode: "unhermetic", command: "true", container: "unowned-container" }))
      expect(container.outcome).toBe("failure")
      expect(JSON.stringify(container)).toContain("has no container transport")
      expect(spawned()).toBe(before)
      database.close()
    }).pipe(Effect.provide(build(workspace, { modules })), Effect.scoped)
  )
})
