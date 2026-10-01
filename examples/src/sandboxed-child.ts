/**
 * The child flow example 41 runs inside a sandbox machine.
 *
 * This module is the ENTRY `SandboxedFlow` bundles: it exports the flow the
 * parent asks for and, as `layer`, the implementation of the one action the
 * flow's body names. Everything the implementation touches is the guest's:
 * `process.cwd()` is the session workdir, and `greeting.txt` lands in the
 * checkout the host captures as the session's work.
 */
import { Action, Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { writeFile } from "node:fs/promises"

/** What the child answers: the greeting it composed and where it composed it. */
export const Greeting = Schema.Struct({ greeting: Schema.String, workdir: Schema.String })

/** The one action the child's body names; its implementation ships in `layer`. */
export const ComposeGreeting = Action.make("examples/SandboxedFlow/ComposeGreeting", {
  payload: { name: Schema.String },
  success: Greeting
})

/** The child flow: a graph of one action, planned and driven inside the guest. */
export const Greet = Flow.make("examples/SandboxedFlow/Greet", {
  payload: { name: Schema.String },
  success: Greeting,
  body: (payload) => ComposeGreeting.call(payload)
})

/** The implementations the guest runner provides beside the interpreter. */
export const layer = ComposeGreeting.toLayer(({ name }) =>
  Effect.promise(async () => {
    const greeting = `hello, ${name}`
    await writeFile("greeting.txt", greeting)
    return { greeting, workdir: process.cwd() }
  })
)
