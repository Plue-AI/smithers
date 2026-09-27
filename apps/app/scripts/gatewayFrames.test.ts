/*
 * The RPC framing the relay speaks to the workspace gateway.
 *
 * The frame shapes here were read off a live rc.0 gateway
 * (packages/smithers/gateway `GatewayServer.test.ts` serves the same mounts), so a
 * change to the gateway's wire that this seam has not followed fails here
 * rather than in a browser.
 */
import { describe, expect, test } from "bun:test"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import {
  ALLOWED_GATEWAY_PROCEDURES,
  decodeGatewayResponse,
  encodeGatewayRequest,
  GATEWAY_PROCEDURE_MOUNTS
} from "./gatewayFrames"

describe("the relayed procedure catalog", () => {
  test("is exactly the product floor, each on the mount that serves it", () => {
    expect(GATEWAY_PROCEDURE_MOUNTS).toEqual({
      Plan: "/rpc",
      Run: "/rpc",
      Cancel: "/rpc",
      Resume: "/rpc",
      Steer: "/rpc",
      Signal: "/rpc",
      List: "/rpc",
      "Projection.Snapshot": "/projections",
      "Approval.Submit": "/projections"
    })
    expect([...ALLOWED_GATEWAY_PROCEDURES].sort()).toEqual([
      "Approval.Submit",
      "Cancel",
      "List",
      "Plan",
      "Projection.Snapshot",
      "Resume",
      "Run",
      "Signal",
      "Steer"
    ])
  })

  test("relays no control procedure the product does not call", () => {
    // The relay holds the gateway credential on the product's behalf, so the
    // allowlist is the reach a compromised session gets. `Resume`, `Steer`,
    // and `Signal` earned their mounts beside the runs lane's callers
    // (apps/app runs.resume / runs.steer / runs.signal); `Approve` and `Deny`
    // stay out because a decision crosses as the gateway's
    // `Approval.Submit`, payload unchanged.
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Approve")
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Deny")
  })

  test("relays no streaming procedure, which belongs on the gateway's socket mounts", () => {
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Watch")
    expect(ALLOWED_GATEWAY_PROCEDURES).not.toContain("Projection.Subscribe")
  })

})

describe("encodeGatewayRequest", () => {
  test("writes one newline-terminated request frame", () => {
    const frame = encodeGatewayRequest("List", { _tag: "runs" })
    expect(frame.endsWith("\n")).toBe(true)
    expect(JSON.parse(frame)).toEqual({
      _tag: "Request",
      id: 1,
      tag: "List",
      payload: { _tag: "runs" },
      headers: []
    })
  })

  test("sends an empty payload for a procedure that takes none", () => {
    expect(JSON.parse(encodeGatewayRequest("Plan", undefined)).payload).toEqual({})
  })
})

describe("decodeGatewayResponse", () => {
  const exit = (outcome: unknown): string => `${JSON.stringify({ _tag: "Exit", requestId: 1, exit: outcome })}\n`

  test("unwraps a success into the value the client renders", () => {
    expect(decodeGatewayResponse(exit({ _tag: "Success", value: { runId: "run-1" } }))).toEqual({
      ok: true,
      payload: { runId: "run-1" }
    })
  })

  test("leads a failure with the cause's own message", () => {
    const decoded = decodeGatewayResponse(exit({ _tag: "Failure", cause: { message: "No run run-9" } }))
    expect(decoded).toMatchObject({ ok: false, error: { message: "No run run-9" } })
  })

  test("falls back to the failure's tag, then to a plain refusal", () => {
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: { _tag: "/control/RunNotFound" } }))).toMatchObject({
      ok: false,
      error: { message: "/control/RunNotFound" }
    })
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: { _tag: "" } }))).toMatchObject({
      ok: false,
      error: { message: "The workspace refused the call." }
    })
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: "nope" }))).toMatchObject({
      ok: false,
      error: { message: "The workspace refused the call." }
    })
  })

  test("names the flow a FlowNotFound refusal lacks, read off the encoded reasons array", () => {
    // ControlError.FlowNotFound declares no message (verified: `new FlowNotFound({ flowId }).message === ""`),
    // and Effect's RPC protocol encodes a failure cause as `[{ _tag: "Fail", error }]`.
    const cause = [{ _tag: "Fail", error: { _tag: "/control/FlowNotFound", code: "flow_not_found", flowId: "prototype" } }]
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause }))).toEqual({
      ok: false,
      error: { message: "No flow \"prototype\" is registered on this workspace.", detail: cause }
    })
    // A typed error with a message inside the reasons array leads with that message; one without falls back to its tag.
    expect(
      decodeGatewayResponse(exit({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "/control/Unavailable", message: "the plane is down" } }] }))
    ).toMatchObject({ ok: false, error: { message: "the plane is down" } })
    expect(
      decodeGatewayResponse(exit({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "/control/RunNotFound", code: "run_not_found" } }] }))
    ).toMatchObject({ ok: false, error: { message: "/control/RunNotFound" } })
    // A defect carries no typed error, so it is named as the crash it is
    // rather than sharing a sentence with a refusal the workspace chose.
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: [{ _tag: "Die", defect: "boom" }] }))).toMatchObject({
      ok: false,
      error: { message: "The workspace crashed: boom" }
    })
    // An empty or unrecognized reasons array still answers with a refusal.
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: [] }))).toMatchObject({
      ok: false,
      error: { message: "The workspace refused the call." }
    })
    expect(decodeGatewayResponse(exit({ _tag: "Failure", cause: [{ _tag: "Sequential" }] }))).toMatchObject({
      ok: false,
      error: { message: "The workspace refused the call." }
    })
  })

  test("reads a nested error message when the cause carries one", () => {
    expect(
      decodeGatewayResponse(exit({ _tag: "Failure", cause: { error: { message: "the plane is down" } } }))
    ).toMatchObject({ ok: false, error: { message: "the plane is down" } })
  })

  test("turns every malformed answer into a refusal a client can show", () => {
    for (const body of ["", "\n\n", "not json\n", '"a string"\n', '{"_tag":"Exit","requestId":1}\n']) {
      const decoded = decodeGatewayResponse(body)
      expect(decoded.ok).toBe(false)
      expect(decoded.ok === false && decoded.error.message.length).toBeGreaterThan(0)
    }
  })

  test("reads the first frame of a multi-line answer", () => {
    const body = `${exit({ _tag: "Success", value: 1 }).trim()}\n{"_tag":"Chunk"}\n`
    expect(decodeGatewayResponse(body)).toEqual({ ok: true, payload: 1 })
  })
})

/*
 * The failure wire, produced by the installed Effect codec instead of by hand.
 *
 * `Rpc.exitSchema` (effect/unstable/rpc/Rpc) builds
 * `Schema.Exit(success, error, Schema.Defect())` for every procedure and
 * `RpcServer` writes that JSON into the `Exit` frame, so encoding an `Exit`
 * with the same schema here is the shape a live workspace sends. A release of
 * Effect that changes `ExitEncoded` reddens this file rather than a browser.
 */
describe("the encoded Exit wire", () => {
  const exitCodec = Schema.toCodecJson(Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Defect()))
  const encode = Schema.encodeSync(exitCodec)
  const relay = (outcome: Exit.Exit<unknown, unknown>) =>
    decodeGatewayResponse(`${JSON.stringify({ _tag: "Exit", requestId: 1, exit: encode(outcome) })}\n`)

  test("encodes a failure cause as an array of reasons", () => {
    // The shape the seam decodes, read off the codec rather than off history.
    expect(encode(Exit.fail({ _tag: "/control/RunNotFound", message: "No run run-9" }))).toEqual({
      _tag: "Failure",
      cause: [{ _tag: "Fail", error: { _tag: "/control/RunNotFound", message: "No run run-9" } }]
    })
    expect(encode(Exit.die(new Error("workspace exploded")))).toEqual({
      _tag: "Failure",
      cause: [{ _tag: "Die", defect: { name: "Error", message: "workspace exploded" } }]
    })
    expect(encode(Exit.interrupt(7))).toEqual({ _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 7 }] })
  })

  test("leads a typed refusal with its own message and hands the code on as detail", () => {
    const decoded = relay(Exit.fail({ _tag: "/control/RunNotFound", code: "run_not_found", message: "No run run-9" }))
    expect(decoded).toEqual({
      ok: false,
      error: {
        message: "No run run-9",
        detail: [{ _tag: "Fail", error: { _tag: "/control/RunNotFound", code: "run_not_found", message: "No run run-9" } }]
      }
    })
  })

  test("names the flow a messageless FlowNotFound refusal lacks", () => {
    expect(relay(Exit.fail({ _tag: "/control/FlowNotFound", code: "flow_not_found", flowId: "prototype" }))).toMatchObject({
      ok: false,
      error: { message: "No flow \"prototype\" is registered on this workspace." }
    })
  })

  test("tells a crash from a refusal, carrying the defect's own message", () => {
    // A defect is the workspace failing, not the workspace saying no: a client
    // that reads one sentence for both cannot tell a bug from a decision.
    expect(relay(Exit.die(new Error("workspace exploded")))).toMatchObject({
      ok: false,
      error: { message: "The workspace crashed: workspace exploded" }
    })
    expect(relay(Exit.die("boom"))).toMatchObject({ ok: false, error: { message: "The workspace crashed: boom" } })
    expect(relay(Exit.die({ note: "no message here" }))).toMatchObject({
      ok: false,
      error: { message: "The workspace crashed." }
    })
  })

  test("tells a cancelled call from a refusal", () => {
    expect(relay(Exit.interrupt(7))).toEqual({
      ok: false,
      error: { message: "The workspace cancelled the call.", detail: [{ _tag: "Interrupt", fiberId: 7 }] }
    })
  })

  test("unwraps a success the codec produced", () => {
    expect(relay(Exit.succeed({ runId: "run-1" }))).toEqual({ ok: true, payload: { runId: "run-1" } })
  })

  test("leads with the refusal the workspace chose when a defect ran beside it", () => {
    const cause = [{ _tag: "Die", defect: "boom" }, { _tag: "Fail", error: { _tag: "/control/Unavailable", message: "the plane is down" } }]
    expect(decodeGatewayResponse(`${JSON.stringify({ _tag: "Exit", requestId: 1, exit: { _tag: "Failure", cause } })}\n`)).toMatchObject({
      ok: false,
      error: { message: "the plane is down" }
    })
  })
})
