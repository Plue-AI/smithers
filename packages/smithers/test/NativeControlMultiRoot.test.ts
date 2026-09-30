/**
 * Two native hosts over two project roots in one process (#2746).
 *
 * Each composition names its own root, so the catalog it plans from and the
 * revision it reports belong to it. The hosts below stay open together, hold
 * flows with the same name and different bodies, and must each keep planning
 * their own flow while the other opens and after it closes.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as CoreFlow from "../flows/core/src/Flow.ts"
import * as NodeControl from "../src/NodeControl.ts"

const Probe = Action.make("test/Probe", {
  payload: { value: Schema.String },
  success: Schema.String,
  error: Schema.Unknown
})

/** One committed root whose `native` flow is described and delegated per `label`. */
const committedRoot = async (label: string) => {
  const description = `The ${label} root's native flow.`
  const delegate = `test/Planned${label}`
  const definition = {
    name: "native",
    description,
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Unknown,
    capabilities: [],
    flows: [delegate],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
  } as const
  const root = await mkdtemp(join(tmpdir(), `smithers-native-multiroot-${label}-`))
  await mkdir(join(root, "flows", "native"), { recursive: true })
  await writeFile(
    join(root, "flows", "native", "flow.ts"),
    `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({
  name: "native",
  description: ${JSON.stringify(description)},
  input: Schema.Struct({ value: Schema.String }), output: Schema.Unknown,
  capabilities: [], flows: [${JSON.stringify(delegate)}],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
`
  )
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
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  git("init", "--quiet")
  git("add", "-A")
  git("commit", "--quiet", "-m", label)
  const Planned = Flow.make(delegate, {
    payload: Executable.Invocation,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: ({ input }) =>
      Probe.call({ value: `${label}/${(input as { value: string }).value}` }).pipe(
        Node.andThen(Probe.call({ value: `${label}/${(input as { value: string }).value}/second` }))
      )
  })
  const modules = Executable.layer({
    delegates: [Planned],
    load: () => Effect.succeed({ default: CoreFlow.make(definition) })
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Interpreter.layer(Planned), Probe.toLayer(({ value }) => Effect.succeed(value)))
    ),
    Layer.orDie
  )
  const layer = NodeControl.layerControl(
    { root, evaluator: ScriptedJudge.layer },
    NodeControl.layerRegistry(root),
    undefined,
    modules
  )
  return { root, head: git("rev-parse", "HEAD").trim(), layer }
}

/** Opens one host in a scope of its own, which the caller closes. */
const open = (layer: Layer.Layer<Control.Control>) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(layer, scope)
    return { scope, control: Context.get(context, Control.Control) }
  })

const plan = (control: Control.Service) =>
  control.plan({ flowId: "native", input: { value: "same" } }).pipe(
    Effect.map((card) => ({
      executionDigest: card.executionDigest,
      sourceRevision: card.graph?.sourceRevision,
      keys: card.nodes.map((node) => node.key)
    }))
  )

it("keeps each root's catalog and revision while another root opens and closes", async () => {
  const a = await committedRoot("A")
  const b = await committedRoot("B")
  try {
    const observed = await Effect.runPromise(Effect.gen(function*() {
      const hostA = yield* open(a.layer)
      const first = yield* plan(hostA.control)
      const hostB = yield* open(b.layer)
      const onB = yield* plan(hostB.control)
      const withB = yield* plan(hostA.control)
      yield* Scope.close(hostB.scope, Exit.void)
      const afterB = yield* plan(hostA.control)
      yield* Scope.close(hostA.scope, Exit.void)
      return { first, onB, withB, afterB }
    }))

    expect(observed.first.sourceRevision).toBe(a.head)
    expect(observed.first.keys.length).toBeGreaterThan(1)
    expect(observed.onB.sourceRevision).toBe(b.head)
    expect(observed.onB.executionDigest).not.toBe(observed.first.executionDigest)
    expect(observed.onB.keys).not.toEqual(observed.first.keys)
    // A plans its own flow while B is open, and again once B has closed.
    expect(observed.withB).toEqual(observed.first)
    expect(observed.afterB).toEqual(observed.first)
  } finally {
    await rm(a.root, { recursive: true, force: true })
    await rm(b.root, { recursive: true, force: true })
  }
}, 120_000)
