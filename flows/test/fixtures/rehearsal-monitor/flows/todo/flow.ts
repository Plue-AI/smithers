/** C-J11-04: immutable-source commands, edits and retries in the native host. */
import { CheckCommand, Request, RequestInput, StackBase, TodoDelivery, Vibe, VibeDelivered, VibeError } from "@smthrs/coding"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"

const Stop = Action.make("monitor/check-stop", { payload: {}, success: VibeDelivered, error: Schema.String, implementationVersion: "1" })
export const layer = Stop.toLayer(() => Effect.fail("Recorded check failure"), { implementationVersion: "1" })

export default Flow.make("todo", {
  description: "Deliver a TODO and exercise recorded monitor checks.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Schema.Struct({ ...RequestInput.fields, base: StackBase }),
  success: VibeDelivered,
  error: Schema.Union([Request.errorSchema, VibeError, CheckCommand.errorSchema, Schema.String]),
  body: input => {
    const clear = input.prompt.includes("[CLEAR]") || input.feedback?.includes("[CLEAR]") === true
    const single = input.feedback?.includes("[SINGLE]") === true
    const split = input.prompt.includes("[SPLIT]")
    const stop = input.prompt.includes("[STOP]") || split
    const edited = input.prompt.includes("[EDIT]")
    return Request.call(input).pipe(
      Node.map(Node.capture({}, request => ({ request, implementation: request.outcome.result!.changes[0]!.implementation }))),
      Node.bindPlanned(Node.capture({ clear, single, split, stop, edited }, prepared => {
        const implementation = prepared.implementation
        const check = { id: "TestRetryBackoff", target: ".", flow: "checks/monitor", flowDigest: "monitor-fixture-v1", tier: "slow" as const, required: false }
        const invocation = (n: number, passed: boolean) => ({
          flow: check.flow, input: { implementation, check },
          prompt: JSON.stringify({ argv: ["sh", "-c", `echo 'TestRetryBackoff retry.go:${40 + n}'; exit ${passed ? 0 : 1}`], cwd: ".", timeoutMs: 10000 }),
          model: null, placement: null, placementOptions: null, capabilities: ["*"], flows: []
        })
        const invocationInput = invocation(3, false)
        const first = CheckCommand.call(invocation(1, false)).pipe(
          Node.andThen(single ? Node.succeed(null) : CheckCommand.call(invocation(2, false)))
        )
        const editedNode = TodoDelivery.call({ request: prepared.request }).pipe(
          Node.bindPlanned(delivery => Vibe.call(delivery)),
          Node.bindPlanned(delivered => CheckCommand.call(invocationInput).pipe(Node.andThen(Node.succeed(delivered))))
        )
        const unchangedNode = Node.succeed(null).pipe(
          Node.andThen(split || single ? Node.succeed(null) : CheckCommand.call(invocation(3, false))),
          Node.andThen(clear ? CheckCommand.call(invocation(4, true)) : Node.succeed(null)),
          Node.andThen(Node.succeed(prepared.request).pipe(Node.branch({
            if: Node.capture({ stop, clear }, () => stop && !clear),
            then: Node.capture({}, () => Stop.call({})),
            else: request => TodoDelivery.call({ request }).pipe(Node.bindPlanned(delivery => Vibe.call(delivery)))
          })))
        )
        return first.pipe(Node.branch({
          if: Node.capture({ edited }, () => edited),
          then: () => editedNode,
          else: () => unchangedNode
        }))
      }))
    )
  }
})
