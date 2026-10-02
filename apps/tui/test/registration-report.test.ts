import { afterAll, expect, it } from "bun:test"
import { createServer } from "node:http"
import * as RegistrationReport from "../src/registration-report.ts"

const requests: Array<{ url: string | undefined; body: unknown }> = []
let answer: { status: number; body: string } = { status: 200, body: "{}" }
const server = createServer(async (req, res) => {
  const chunks: Array<Buffer> = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
  res.writeHead(answer.status, { "content-type": "application/json" })
  res.end(answer.body)
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`
afterAll(() => {
  server.close()
})

const ask = (repo = "Acme/Widgets") =>
  RegistrationReport.lookup({ baseUrl, fetch, cloudRepo: "acme/widgets", workspaceId: "box-1", repo })
const reply = (report: unknown, status = 200) => {
  answer = { status, body: JSON.stringify({ ok: true, payload: { report } }) }
}

it("returns the recorded report with its commit and asks the relay for the lowercased repository", async () => {
  reply({ repo: "acme/widgets", commit: "fc3f257b643b41dd", report: { repo: "acme/widgets" } })
  const cached = await ask()
  expect(requests.at(-1)).toEqual({
    url: "/api/workflow/rpc",
    body: {
      repo: "acme/widgets",
      procedure: "Registration.Report",
      payload: { repo: "acme/widgets" },
      workspaceId: "box-1"
    }
  })
  expect(cached).toEqual({ repo: "acme/widgets", commit: "fc3f257b643b41dd", report: { repo: "acme/widgets" } })
  expect(RegistrationReport.label(cached!)).toBe("Cached · fc3f257")
})

it("no report, a refusal, a malformed or other repository's report, or an unreachable relay is no report", async () => {
  reply(null)
  expect(await ask()).toBeUndefined()
  reply({ repo: "acme/widgets", commit: "", report: { repo: "acme/widgets" } })
  expect(await ask()).toBeUndefined()
  reply({ repo: "acme/widgets", commit: "abc", report: { repo: "acme/other" } })
  expect(await ask()).toBeUndefined()
  reply({ repo: "acme/widgets", commit: "abc", report: "x" })
  expect(await ask()).toBeUndefined()
  reply(null, 503)
  expect(await ask()).toBeUndefined()
  answer = { status: 200, body: JSON.stringify({ ok: false }) }
  expect(await ask()).toBeUndefined()
  answer = { status: 200, body: "not json" }
  expect(await ask()).toBeUndefined()
  expect(
    await RegistrationReport.lookup({
      baseUrl: "http://127.0.0.1:1",
      fetch,
      cloudRepo: "a/b",
      workspaceId: "x",
      repo: "a/b"
    })
  ).toBeUndefined()
})
