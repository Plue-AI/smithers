import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { CLIENT_DISCONNECTED_STATUS, runRequest, UNEXPECTED_FAILURE_MESSAGE } from "./Boundary"

describe("runRequest, the native fetch boundary", () => {
  test("answers the handler's response", async () => {
    const response = await runRequest(Effect.succeed(new Response("ok", { status: 201 })))
    expect(response.status).toBe(201)
    expect(await response.text()).toBe("ok")
  })

  test("a client that disconnects interrupts the handler, runs its finalizers, and is answered 499", async () => {
    let released = false
    const controller = new AbortController()
    const handler = Effect.never.pipe(
      Effect.ensuring(Effect.sync(() => {
        released = true
      })),
      Effect.as(new Response("never"))
    )
    const pending = runRequest(handler, controller.signal)
    await Bun.sleep(5)
    controller.abort()
    const response = await pending
    expect(response.status).toBe(499)
    expect(CLIENT_DISCONNECTED_STATUS).toBe(499)
    expect(await response.json()).toEqual({ status: "error", code: "client_disconnected", message: "The client disconnected." })
    expect(released).toBe(true)
  })

  test("a signal already aborted before the handler starts is answered 499 without running it", async () => {
    const controller = new AbortController()
    controller.abort()
    let ran = false
    const response = await runRequest(
      Effect.sync(() => {
        ran = true
        return new Response("ran")
      }),
      controller.signal
    )
    expect(response.status).toBe(499)
    expect(ran).toBe(false)
  })

  test("a defect is logged and answered with the generic 500, never a stack trace or a hang", async () => {
    const logged: Array<unknown> = []
    const original = console.error
    console.error = (...args: Array<unknown>) => {
      logged.push(args)
    }
    try {
      const response = await runRequest(Effect.die(new Error("boom")))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ status: "error", code: "unexpected_failure", message: "Smithers could not complete this request. Try again in a moment." })
      expect(UNEXPECTED_FAILURE_MESSAGE).toBe("Smithers could not complete this request. Try again in a moment.")
      expect(JSON.stringify(logged.map(String))).toContain("boom")
    } finally {
      console.error = original
    }
  })
})
