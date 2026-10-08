// Real SQLite Control journal and gateway projections, with a deterministic
// external producer in place of a coding machine (no microVM on this fleet).
import { createServer } from "node:http"
import { Effect, ManagedRuntime } from "effect"
import { Control } from "../../../../../../packages/smithers/control/src/Control.ts"
import { Projections } from "../../../../../../packages/smithers/gateway/src/Projections.ts"
import { stack, emit } from "../../../../../../packages/smithers/gateway/test/GatewayStack.ts"
const runtime = ManagedRuntime.make(stack())
const runId = await runtime.runPromise(Effect.gen(function* () {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve({ target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope }, scope: card.approval.scope, idempotencyKey: `approve:${card.planId}` })
  return (yield* control.run({ _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope, idempotencyKey: `run:${card.planId}` })).runId
}))
// A long model transcript precedes the measured changes: suffix reads must
// stay fast after the run has accumulated substantial event payloads.
await runtime.runPromise(Effect.forEach(Array.from({ length: 750 }), (_, index) =>
  emit(runId, "control.agent.cell-output", { index, text: "x".repeat(32768) }), { discard: true }))
const server = createServer(async (req, res) => {
  try {
    let body = ""
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body || "{}")
    let result
    if (req.url === "/append") {
      const committedAt = Date.now() // Conservative: includes durable append I/O.
      await runtime.runPromise(emit(runId, "control.agent.cell-call-started", { flowName: `step-${input.index}` }))
      result = { committedAt }
    } else {
      result = { ok: true, payload: await runtime.runPromise(Effect.flatMap(Projections, p => p.snapshot(input.selector, input.after))) }
    }
    res.end(JSON.stringify(result))
  } catch (error) { res.statusCode = 500; res.end(String(error)) }
})
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, runId })))
