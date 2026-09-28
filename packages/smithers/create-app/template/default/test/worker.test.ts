import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { describe, expect, test } from "vitest"
import { type Env, handle } from "../worker/handle.ts"

const env: Env = {
  APP_NAME: "app",
  APP_API_TOKEN: "s3cret",
  ASSETS: { fetch: async () => new Response("asset") }
}

const turn = (body: unknown, overrides: Partial<Env> = {}) =>
  handle(
    new Request("https://app.test/api/turn", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" }
    }),
    { ...env, ...overrides },
    QuickJSSandbox.layerVariantLive
  )

const chat = { flow: "chat", payload: { message: "hi" } }

describe("worker routes", () => {
  test("/api/routes reports the routed flows and panes", async () => {
    const response = await handle(new Request("https://app.test/api/routes"), env, QuickJSSandbox.layerVariantLive)
    expect(await response.json()).toEqual({
      app: "app",
      panes: ["message"],
      flows: [{ id: "chat", file: "flows/chat/flow.ts" }]
    })
  })

  test("everything else is served from the assets bucket", async () => {
    const response = await handle(new Request("https://app.test/"), env, QuickJSSandbox.layerVariantLive)
    expect(await response.text()).toBe("asset")
  })

  test("/api/turn refuses a request without the token before reading the body", async () => {
    for (const overrides of [{ APP_API_TOKEN: "other" }, { APP_API_TOKEN: undefined }]) {
      const response = await turn(chat, overrides)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: "unauthorized" })
    }
  })

  test("/api/turn admits a tokenless request only under APP_API_OPEN=1", async () => {
    const response = await turn(chat, { APP_API_TOKEN: undefined, APP_API_OPEN: "1" })
    expect(response.status).toBe(503)
  })

  test("/api/turn names the seat key it is missing", async () => {
    const response = await turn(chat)
    expect(response.status).toBe(503)
    const body = await response.json() as { error: string; message: string }
    expect(body.error).toBe("host_unconfigured")
    expect(body.message).toContain("ANTHROPIC_API_KEY")
  })


  test("/api/turn refuses an unrouted flow and a malformed body", async () => {
    const unrouted = await turn({ flow: "nope", payload: {} })
    expect(unrouted.status).toBe(400)
    expect(await unrouted.json()).toMatchObject({ error: "flow_not_routed", known: ["chat"] })
    const malformed = await turn("not json")
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: "invalid_request" })
  })
})
