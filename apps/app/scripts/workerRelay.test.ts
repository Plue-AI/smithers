import { expect, test } from "bun:test"
import { relayRpc } from "./workerRelay"

const request = (body: unknown) => new Request("http://relay.test/api/workflow/rpc", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
const valid = { repo: "ada/repo", procedure: "List", payload: { _tag: "flows" }, workspaceId: "5b0c4f7e-2d1a-4c3b-9e8f-1a2b3c4d5e6f" }
const { workspaceId: _box, ...boxless } = valid
const fixture = () => {
  const seen: { authorization: string | null; body: string }[] = []
  const server = Bun.serve({ port: 0, async fetch(req) {
    seen.push({ authorization: req.headers.get("authorization"), body: await req.text() })
    return new Response(JSON.stringify({ _tag: "Exit", requestId: "0", exit: { _tag: "Success", value: ["flow"] } }) + "\n")
  } })
  return { seen, server, url: `http://localhost:${server.port}` }
}

test.each([
  [{ ...valid, procedure: "constructor" }, "procedure_not_relayed"],
  [{ ...valid, procedure: "absent" }, "procedure_not_relayed"],
  [{ ...valid, repo: "bad" }, "request_invalid"],
  [{ ...valid, workspaceId: "bad" }, "request_invalid"],
  [boxless, "request_invalid"],
  ["{not json", "request_body_not_json"]
] as const)("the harness uses the Worker refusal for %j", async (body, code) => {
  const f = fixture()
  try {
    const response = await relayRpc(request(body), f.url, "fixture-credential")
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ status: "error", code })
    expect(f.seen).toHaveLength(0)
  } finally { f.server.stop(true) }
})

test("an admitted call crosses the real HTTP seam with its credential and Worker frame", async () => {
  const f = fixture(), forwarded: string[] = []
  try {
    const response = await relayRpc(request(valid), f.url, "fixture-credential", name => forwarded.push(name))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, payload: ["flow"] })
    expect(forwarded).toEqual(["List"])
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0]!.authorization).toBe("Bearer fixture-credential")
  } finally { f.server.stop(true) }
})

test("an unframed upstream refusal keeps the Worker envelope", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("private upstream debug", { status: 503 }) })
  try {
    const response = await relayRpc(request(valid), `http://localhost:${server.port}`, "fixture-credential")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, error: { message: "The workspace answered HTTP 503." } })
  } finally { server.stop(true) }
})

test("the harness enforces the Worker's request and upstream body limits", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("x".repeat(4 * 1024 * 1024 + 1)) })
  try {
    const base = `http://localhost:${server.port}`
    const requestRefusal = await relayRpc(request({ ...valid, payload: "x".repeat(1024 * 1024) }), base, "fixture-credential")
    expect(requestRefusal.status).toBe(413)
    expect(await requestRefusal.json()).toMatchObject({ code: "request_body_too_large" })
    const response = await relayRpc(request(valid), base, "fixture-credential")
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: "upstream_malformed" })
  } finally { server.stop(true) }
})
