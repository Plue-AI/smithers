import { ApprovalAuthority, Control, ControlRuntime } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as McpServer from "../src/McpServer.ts"

const agent = { id: "delegated-session", kind: "agent" }
const demo = {
  flowId: "demo/approval",
  description: "Offline test",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
}
const resolve = (options: McpServer.Options = { approvalTools: true }) =>
  McpServer.tools(options).find((tool) => tool.name === "resolve_approval")!

describe("MCP approval authority", () => {
  it("excludes approval-bearing tools from both discovery and dispatch by default, even on an allowlist", async () => {
    for (const allowedTools of [undefined, ["run_flow", "resolve_approval"]]) {
      const session = McpServer.tools({ allowedTools })
      for (const name of ["run_flow", "resolve_approval"]) {
        expect(session.map((tool) => tool.name)).not.toContain(name)
        const reply = await Effect.runPromise(
          McpServer.respond({ id: 1, method: "tools/call", params: { name, arguments: {} } }, session, "test")
            .pipe(Effect.provide(TestControl.layer()))
        )
        expect(reply).toMatchObject({
          result: { isError: true, structuredContent: { ok: false, error: { code: "unknown_tool" } } }
        })
      }
    }
  })

  for (const decision of ["approve", "deny"] as const) {
    for (const scope of ["once", "run", "remembered"] as const) {
      it(`exposing ${decision}/${scope} does not delegate authority or honor a payload-named operator`, async () => {
        await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control.Control
            const runtime = yield* ControlRuntime.ControlRuntime
            const card = yield* control.plan({ flowId: "system/test", input: {} })
            const before = yield* runtime.lookupApproval(card.approval.target)
            // Exercise the callable itself as well as the protocol admission
            // layer. A direct tool caller cannot sneak in a local principal.
            const result = yield* resolve().call({
              approval: { ...card.approval, principal: { id: "local", kind: "operator", stampedAt: 0 } },
              decision,
              scope,
              principal: { id: "local", kind: "operator", stampedAt: 0 }
            })
            expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } })
            expect(yield* runtime.lookupApproval(card.approval.target)).toEqual(before)
            expect(yield* runtime.grants).toEqual([])
            expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
          }).pipe(Effect.provide(TestControl.layer()), Effect.scoped)
        )
      })
    }
  }

  it("stamps a captured host-authenticated actor and enforces that actor's exact delegated scope", async () => {
    const approvalAuthority = await Effect.runPromise(ApprovalAuthority.make([
      { principal: agent, scopes: ["once"], targets: ["Plan"] }
    ]))
    const hostActor = { ...agent }
    const tool = resolve({ approvalTools: true, principal: hostActor })
    hostActor.id = "changed-after-session-creation"
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        expect(yield* tool.call({ approval: card.approval, decision: "approve", scope: "remembered" }))
          .toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } })
        expect(yield* runtime.grants).toEqual([])
        expect(yield* tool.call({ approval: card.approval, decision: "approve" })).toMatchObject({ ok: true })
        expect((yield* runtime.grants).map((grant) => grant.scope)).toEqual(["once"])
        const denied = yield* control.plan({ flowId: "system/test", input: { denied: true } })
        expect(yield* tool.call({ approval: denied.approval, decision: "deny" })).toMatchObject({ ok: true })
        expect((yield* runtime.getPlan(denied.planId)).decision).toBe("denied")
        const events = yield* Stream.runCollect(control.watch({ runId: `plan:${card.planId}`, follow: false }))
        expect(events.find((event) => event.kind === "control.approval.approved")?.payload)
          .toMatchObject({ principal: agent })
        // A Node request is separately denied by this Plan-only delegation.
        const launched = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "launch"
        })
        if (launched._tag !== "Accepted" || launched.runId === undefined) return yield* Effect.die("expected run")
        const target = {
          _tag: "Node" as const,
          runId: launched.runId,
          requestId: "ask",
          digest: "ask",
          envelope: card.envelope
        }
        const pending = yield* runtime.registerApproval(target)
        expect(yield* tool.call({ approval: { target, scope: "once", idempotencyKey: "node" }, decision: "approve" }))
          .toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } })
        expect(yield* runtime.registerApproval(target)).toEqual(pending)
      }).pipe(Effect.provide(TestControl.layer({ approvalAuthority })), Effect.scoped)
    )
  })

  it("cannot get approval implicitly through run_flow", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const tool = McpServer.supportedTools.find((tool) => tool.name === "run_flow")!
        expect(yield* tool.call({ flowId: demo.flowId })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } })
        expect(yield* runtime.listRuns).toEqual([])
        expect(yield* runtime.grants).toEqual([])
        const ids = yield* runtime.listPlanIds
        expect(ids).toHaveLength(1)
        expect((yield* runtime.getPlan(ids[0]!)).decision).toBe("pending")
      }).pipe(Effect.provide(TestControl.layer({ flows: [demo] })), Effect.scoped)
    )
  })
})
