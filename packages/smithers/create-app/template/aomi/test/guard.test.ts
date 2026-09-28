import { authorized, readJson } from "@smthrs/create-app/http"
import { describe, expect, test, vi } from "vitest"
import { Routes } from "../src/api.ts"
import type { Env } from "../worker/env.ts"
import { handle } from "../worker/router.ts"

const origin = "https://aomi.smithers.sh"
const request = (headers: HeadersInit = {}): Request =>
  new Request(`${origin}${Routes.turnCancel}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: "s1" })
  })

const harness = (vars: { APP_API_TOKEN?: string; APP_API_OPEN?: string } = {}) => {
  const cancel = vi.fn(() => ({ cancelled: true }))
  const idFromName = vi.fn((id: string) => id)
  const env = {
    APP_NAME: "aomi",
    ...vars,
    SESSIONS: { idFromName, get: () => ({ cancel }) }
  } as unknown as Env
  return { env, cancel, idFromName }
}

describe("request admission", () => {
  test.each([undefined, ""])("fails closed with token %s", async (token) => {
    const { env, idFromName } = harness(token === undefined ? {} : { APP_API_TOKEN: token })
    expect(authorized(request(), token)).toBe(false)
    expect((await handle(request({ "content-type": "application/json" }), env)).status).toBe(401)
    expect(idFromName).not.toHaveBeenCalled()
  })

  test.each(["0", "true", ""])("does not opt in with APP_API_OPEN=%s", async (open) => {
    const { env, idFromName } = harness({ APP_API_OPEN: open })
    expect((await handle(request({ "content-type": "application/json" }), env)).status).toBe(401)
    expect(idFromName).not.toHaveBeenCalled()
  })

  test.each([undefined, ""])("explicit local opt-in admits token %s", async (token) => {
    const { env, cancel } = harness({ APP_API_OPEN: "1", ...(token === undefined ? {} : { APP_API_TOKEN: token }) })
    expect((await handle(request({ "content-type": "application/json" }), env)).status).toBe(200)
    expect(cancel).toHaveBeenCalledWith("s1")
  })

  test("local opt-in never bypasses a configured token", async () => {
    const { env, idFromName } = harness({ APP_API_OPEN: "1", APP_API_TOKEN: "s3cret" })
    expect((await handle(request({ "content-type": "application/json" }), env)).status).toBe(401)
    expect(idFromName).not.toHaveBeenCalled()
    expect((await handle(request({ "content-type": "application/json", authorization: "Bearer s3cret" }), env)).status)
      .toBe(200)
  })

  test.each([Routes.turn, Routes.turnCancel, Routes.flowRun])("%s refuses simple POSTs before accessing an object", async (path) => {
    const { env, idFromName } = harness({ APP_API_OPEN: "1" })
    const req = new Request(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ sessionId: "s1", flowId: "build", message: "hi", payload: {} })
    })
    expect((await handle(req, env)).status).toBe(415)
    expect(idFromName).not.toHaveBeenCalled()
  })

  test.each([
    { origin: "https://attacker.example" },
    { origin: "https://sub.aomi.smithers.sh" },
    { origin: "http://aomi.smithers.sh" },
    { origin: "null" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
    { "sec-fetch-site": "" },
    { origin, "sec-fetch-site": "cross-site" },
    { origin: "https://attacker.example", "sec-fetch-site": "same-origin" }
  ])("refuses foreign browser metadata %j", async (headers) => {
    const { env, idFromName } = harness({ APP_API_OPEN: "1" })
    expect((await handle(request({ "content-type": "application/json", ...headers }), env)).status).toBe(403)
    expect(idFromName).not.toHaveBeenCalled()
  })

  test("refuses cross-origin simple requests even in local open mode", async () => {
    const { env, idFromName } = harness({ APP_API_OPEN: "1" })
    expect((await handle(request({ "content-type": "text/plain", origin: "https://attacker.example" }), env)).status)
      .toBe(403)
    expect(idFromName).not.toHaveBeenCalled()
  })

  test("a credential does not bypass the browser origin check", async () => {
    const { env, idFromName } = harness({ APP_API_TOKEN: "s3cret" })
    expect((await handle(request({
      "content-type": "application/json",
      authorization: "Bearer s3cret",
      origin: "https://attacker.example"
    }), env)).status).toBe(403)
    expect(idFromName).not.toHaveBeenCalled()
  })

  test("accepts same-origin browser metadata", async () => {
    const { env, cancel } = harness({ APP_API_OPEN: "1" })
    expect((await handle(request({ "content-type": "application/json", origin, "sec-fetch-site": "same-origin" }), env)).status)
      .toBe(200)
    expect(cancel).toHaveBeenCalledWith("s1")
  })
})

describe("JSON media type", () => {
  test.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp", ""])(
    "refuses %s", async (type) => {
      expect(await readJson(request({ "content-type": type }))).toMatchObject({ ok: false, status: 415 })
    }
  )

  test("refuses a missing content-type", async () => {
    const req = request()
    req.headers.delete("content-type")
    expect(await readJson(req)).toMatchObject({ ok: false, status: 415 })
  })

  test.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])("accepts %s", async (type) => {
    expect(await readJson(request({ "content-type": type }))).toEqual({ ok: true, value: { sessionId: "s1" } })
  })
})
