import { Refused } from "@smthrs/cli/CliError"
import * as CloudSession from "@smthrs/cli/CloudSession"
import type { MythicalStack } from "@smthrs/rpc/Mythical"
import { afterEach, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Factory from "../src/factory.ts"
import * as Log from "../src/log.ts"

const now = Date.parse("2026-09-28T20:00:00Z")
const item = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  state,
  attempt: 1,
  runs: {},
  dependsOn: [],
  updatedAt: "2026-09-28T19:00:00Z",
  issue: { number: Number(id), title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}` },
  ...extra
})
const stack = {
  repository: "o/r",
  state: "active",
  generation: 1,
  mainBehind: false,
  changes: [{ id: "c1", changeId: "k", commitId: "a".repeat(40), title: "↩ revert", kind: "revert", position: 0 }],
  items: [
    item("2431", "blocked", { reason: "very hard 3/3", todo: { replans: 2, veryHard: true } }),
    item("2412", "running", { lane: 0, todo: { replans: 1 } }),
    item("2388", "landed", {
      createdAt: "2026-09-28T16:00:00Z",
      humanEdited: false,
      costNanos: 2_000_000_000,
      route: { as: "close", landed: "change" }
    }),
    item("2391", "declined", { reason: "Already done." })
  ],
  lanes: [],
  limits: { maxParallel: 3 }
} as unknown as MythicalStack

it("lists the factory's issues under Needs you, Working and Done, each with its title and word", () => {
  expect(Factory.rows(stack, now).map((row) => [row.label, row.status])).toEqual([
    ["◆ Needs you 1", undefined],
    ["◆ #2431 Issue 2431 · blocked", undefined],
    ["◐ Working 1", undefined],
    ["#2412 Issue 2412 · implementing · plan 2 of 3", "running"],
    ["● Done 2", undefined],
    ["#2388 Issue 2388 · landed", "done"],
    ["#2391 Issue 2391 · declined", "done"]
  ])
})

it("heads the list with the shared measured numbers on one line", () => {
  expect(Factory.metrics(stack)).toBe(
    "1/3 landed · 100% landed unedited · 3h p50 · $2.00/landed · 1 revert · 1 misroute · 3 replans"
  )
  expect(Factory.metrics({ ...stack, items: [], changes: [] })).toBe("0 reverts · 0 misroutes · 0 replans")
})

it("shows very hard only during the continuation and derives plan number from replans", () => {
  const continuing = {
    ...stack,
    items: [item("2412", "running", { lane: 0, todo: { replans: 2, veryHard: true } })]
  } as unknown as MythicalStack
  expect(Factory.rows(continuing, now)[1]?.label).toBe("#2412 Issue 2412 · implementing · plan 3 of 3 · very hard")
  expect(Factory.metrics(continuing)).toContain("1 very hard")
  const blocked = {
    ...continuing,
    items: [item("2412", "blocked", { todo: { replans: 2, veryHard: true } })]
  } as unknown as MythicalStack
  expect(Factory.rows(blocked, now)[1]?.label).not.toContain("very hard")
  expect(Factory.metrics(blocked)).not.toContain("very hard")
})

it("uses the outcome word for Working and Done, with the reason in details", () => {
  const value = {
    ...stack,
    items: [
      item("2400", "retrying", { reason: "seat unavailable", todo: { replans: 1 } }),
      item("2401", "declined", { reason: "Already done." })
    ]
  } as unknown as MythicalStack
  const rows = Factory.rows(value, now)
  expect(rows.find((row) => row.label.includes("#2400"))?.label).toContain("· retrying · plan 2 of 3")
  expect(rows.find((row) => row.label.includes("#2401"))?.label).toBe("#2401 Issue 2401 · declined")
  expect(rows.find((row) => row.label.includes("#2401"))?.details).toEqual([{
    kind: "text",
    text: "Already done.\nhttps://github.com/o/r/issues/2401"
  }])
})

it("shows each check receipt on the candidate in details, and nothing without receipts", () => {
  const commit = "1a2b3c4d".padEnd(40, "0")
  const value = {
    ...stack,
    items: [
      item("2402", "retrying", {
        reason: "failed: affected-test",
        checks: {
          state: "failed",
          failed: ["affected-test"],
          receipts: [
            { check: "affected-lint", tier: "fast", status: "passed", commit },
            { check: "affected-test", tier: "slow", status: "failed", commit }
          ]
        }
      }),
      item("2403", "proposed", { checks: { state: "passed", failed: [] } })
    ]
  } as unknown as MythicalStack
  const rows = Factory.rows(value, now)
  expect(rows.find((row) => row.label.includes("#2402"))?.details).toEqual([{
    kind: "text",
    text: "failed: affected-test\n✓ affected-lint 1a2b3c4 · ✗ affected-test 1a2b3c4\nhttps://github.com/o/r/issues/2402"
  }])
  expect(rows.find((row) => row.label.includes("#2403"))?.details).toEqual([{
    kind: "text",
    text: "https://github.com/o/r/issues/2403"
  }])
})

it("appends each receipt's duration and names the run that recorded them", () => {
  const commit = "1a2b3c4d".padEnd(40, "0")
  const value = {
    ...stack,
    items: [
      item("2405", "proposed", {
        checks: {
          state: "passed",
          failed: [],
          receipts: [
            { check: "affected-lint", tier: "fast", status: "passed", commit, runId: "run-verify-21", durationMs: 850 },
            {
              check: "affected-test",
              tier: "slow",
              status: "passed",
              commit,
              runId: "run-verify-21",
              durationMs: 64_000
            },
            { check: "affected-docs", tier: "fast", status: "passed", commit }
          ]
        }
      })
    ]
  } as unknown as MythicalStack
  expect(Factory.rows(value, now).find((row) => row.label.includes("#2405"))?.details).toEqual([{
    kind: "text",
    text:
      "✓ affected-lint 1a2b3c4 0s · ✓ affected-test 1a2b3c4 1m 04s · ✓ affected-docs 1a2b3c4 · run run-verify-21\n" +
      "https://github.com/o/r/issues/2405"
  }])
})

it("shows the machine an issue's lane runs on in details: its kind and image", () => {
  const value = {
    ...stack,
    items: [
      item("2404", "running", {
        lane: 0,
        placement: {
          declared: { environment: ".smithers/environment.nix", tools: ["go"] },
          kind: "vm",
          vcpus: 2,
          memoryMiB: 4096,
          imageId: "img-1",
          image: "registry/env:abc"
        }
      }),
      item("2405", "blocked", {
        reason: "No machine matches what this repository declares",
        placement: { declared: { vcpus: 8 }, refusal: "machine_too_small", reason: "it needs 8 vCPUs" }
      })
    ]
  } as unknown as MythicalStack
  const rows = Factory.rows(value, now)
  expect(rows.find((row) => row.label.includes("#2404"))?.details).toEqual([{
    kind: "text",
    text: "vm · registry/env:abc\nhttps://github.com/o/r/issues/2404"
  }])
  expect(rows.find((row) => row.label.includes("#2405"))?.details).toEqual([{
    kind: "text",
    text: "No machine matches what this repository declares\nhttps://github.com/o/r/issues/2405"
  }])
})

it("names the repository from SMITHERS_REPO, else the checkout's remote", () => {
  expect(Factory.repository("/nowhere", { SMITHERS_REPO: "smithersai/smithers" })).toBe("smithersai/smithers")
  expect(Factory.repository("/nowhere", {})).toBeUndefined()
  expect(Factory.repository("/nowhere", { SMITHERS_REPO: "../x" })).toBeUndefined()
})

it("lists at most a group's worth of issues, then how many more", () => {
  const long = {
    ...stack,
    items: Array.from({ length: Factory.perGroup + 5 }, (_, at) => item(String(3000 + at), "queued"))
  }
  const shown = Factory.rows(long as unknown as MythicalStack, now)
  expect(shown).toHaveLength(Factory.perGroup + 2)
  expect(shown.at(-1)).toMatchObject({ id: "more:working", label: "… 5 more" })
})

it("files a TODO under one request id, resent after an unanswered filing and dropped after a refusal", async () => {
  const sent: Array<{ path: string; body: { title: string; request: string } }> = []
  const answers: Array<() => Promise<unknown>> = []
  let ids = 0
  const file = Factory.filer(
    (path, body) => {
      sent.push({ path, body: body as { title: string; request: string } })
      return answers.shift()!()
    },
    () => `id-${++ids}`
  )
  const queued = item("40", "queued")
  // A dropped network keeps the id: the same TODO again resends it and files once.
  answers.push(() => Promise.reject(new Error("fetch failed")), () => Promise.resolve(queued))
  expect(await file("o/r", "Add dark mode")).toEqual({
    ok: false,
    detail: "That command could not run. Details: /conversation",
    settled: false
  })
  const filed = await file("o/r", "Add dark mode")
  expect(filed.ok && filed.item.issue?.number).toBe(40)
  expect(sent.map((each) => [each.path, each.body.request])).toEqual([
    ["/api/repos/o/r/mythical/todos", "id-1"],
    ["/api/repos/o/r/mythical/todos", "id-1"]
  ])
  // An answered filing frees its id: the next filing of the text is a new TODO.
  answers.push(
    () => Promise.reject(new Refused({ code: "cloud_request_failed", fault: "user", message: "HTTP 403" })),
    () => Promise.resolve(queued)
  )
  expect(await file("o/r", "Add dark mode")).toMatchObject({ ok: false, settled: true })
  await file("o/r", "Add dark mode")
  expect(sent.map((each) => each.body.request)).toEqual(["id-1", "id-1", "id-2", "id-3"])
})

it("joins a TODO filed while the same one is in flight", async () => {
  const releases: Array<(value: unknown) => void> = []
  const file = Factory.filer(() => new Promise((resolve) => releases.push(resolve)))
  const first = file("o/r", "Same")
  const second = file("o/r", "Same")
  const other = file("o/x", "Same")
  expect(releases).toHaveLength(2)
  for (const release of releases) release(item("41", "queued"))
  expect(await first).toBe(await second)
  expect((await other).ok).toBe(true)
})

const servers: Array<() => void> = []
afterEach(() => {
  for (const close of servers.splice(0)) close()
})
interface Received {
  readonly method: string
  readonly path: string
  readonly auth: string | undefined
  readonly body: string
}
/** A Cloud origin on a local port: `reply` answers each request by method and path. */
const cloudAt = async (
  reply: (method: string, path: string) => { status: number; body: unknown },
  received: Array<Received> = []
): Promise<string> => {
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        path: request.url ?? "",
        auth: request.headers.authorization,
        body
      })
      const answer = reply(request.method ?? "", request.url ?? "")
      response.writeHead(answer.status, { "content-type": "application/json" })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const signIn = (origin: string) => () =>
  CloudSession.signedIn({
    HOME: mkdtempSync(join(tmpdir(), "tui-retry-")),
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "tui-retry-")),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_TOKEN: "tok_retry"
  })

it("keeps returned TODO refusals and uncertain failures diagnostic, private and retryable over HTTP", async () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-todo-diagnostic-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const received: Array<Received> = []
    let status = 403
    const origin = await cloudAt(() => ({ status, body: status === 200 ? item("40", "queued") : {} }), received)
    const cloud = (await signIn(origin)())!
    let ids = 0
    const file = Factory.filer(cloud.post, () => `request-${++ids}`)
    expect(await file("o/r", "Same TODO")).toEqual({
      ok: false,
      detail: "That command could not run.",
      settled: true
    })
    expect(readFileSync(Log.path(), "utf8")).toContain("HTTP 403")
    status = 401
    expect(await file("o/r", "Same TODO")).toEqual({
      ok: false,
      detail: "That command could not run.",
      settled: true
    })
    expect(readFileSync(Log.path(), "utf8")).toContain("HTTP 401")
    status = 503
    expect(await file("o/r", "Same TODO")).toEqual({
      ok: false,
      detail: "That command could not run. Details: /conversation",
      settled: false
    })
    status = 200
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true, item: { issue: { number: 40 } } })
    expect(received.map((request) => JSON.parse(request.body).request)).toEqual([
      "request-1",
      "request-2",
      "request-3",
      "request-3"
    ])
    const lines = readFileSync(Log.path(), "utf8").trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain("HTTP 503")
    expect(statSync(Log.path()).mode & 0o777).toBe(0o600)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("uses typed refusal authority rather than diagnostic HTTP words to retain an uncertain TODO's request id", async () => {
  for (
    const [code, fault, settled] of [
      ["cloud_request_failed", "infra", false],
      ["cloud_invalid_response", "infra", false],
      ["cloud_invalid_response", "user", false],
      ["cloud_request_failed", "user", true]
    ] as const
  ) {
    let attempts = 0
    let ids = 0
    const requests: string[] = []
    const file = Factory.filer(async (_path, body) => {
      requests.push((body as { request: string }).request)
      if (attempts++ === 0) throw new Refused({ code, fault, message: "private diagnostic mentions HTTP 403" })
      return item("40", "queued")
    }, () => `request-${++ids}`)
    const answer = await file("o/r", "Same TODO")
    expect(answer).toMatchObject({ ok: false, settled })
    expect(answer.ok ? "" : answer.detail).not.toContain("private diagnostic")
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true })
    expect(requests).toEqual(["request-1", settled ? "request-2" : "request-1"])
  }
})

it("retains the TODO request for uncertain status metadata and old HTTP-looking diagnostics", async () => {
  const refusal = { _tag: "/cli/Refused", code: "cloud_request_failed", fault: "user", message: "HTTP 401" }
  const failures: unknown[] = [
    ...[408, 409, 429, 503, undefined, "401", 401.5, NaN, 99, 600].map((httpStatus) => ({ ...refusal, httpStatus })),
    new Error("HTTP 409: try again"),
    new Error("HTTP 401: old diagnostic", { cause: { ...refusal, httpStatus: 401 } }),
    { ...refusal, code: "other_refusal", httpStatus: 401 }
  ]
  for (const failure of failures) {
    const requests: string[] = []
    let ids = 0
    const file = Factory.filer(async (_path, body) => {
      requests.push((body as { request: string }).request)
      if (requests.length === 1) throw failure
      return item("40", "queued")
    }, () => `request-${++ids}`)
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: false, settled: false })
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true })
    expect(requests).toEqual(["request-1", "request-1"])
  }
})

it("retains a TODO's identity through real HTTP waits, disconnection and duplicate input", async () => {
  const received: Array<{ request: string }> = []
  let status = 408
  let disconnect = false
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      received.push(JSON.parse(body))
      if (disconnect) {
        request.socket.destroy()
        return
      }
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(status === 201 ? item("40", "queued") : { httpStatus: 401, message: "HTTP 401" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(() => server.close())
  const cloud = (await signIn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)())!
  let ids = 0
  const file = Factory.filer(cloud.post, () => `request-${++ids}`)
  for (status of [408, 409, 429, 503]) {
    const pending = file("o/r", "Same TODO")
    expect(file("o/r", "Same TODO")).toBe(pending)
    expect(await pending).toMatchObject({ ok: false, settled: false })
  }
  disconnect = true
  expect(await file("o/r", "Same TODO")).toMatchObject({ ok: false, settled: false })
  disconnect = false
  status = 201
  expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true, item: { issue: { number: 40 } } })
  expect(received).toHaveLength(6)
  expect(received.map((request) => request.request)).toEqual(Array(6).fill("request-1"))
  expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true })
  expect(received.at(-1)?.request).toBe("request-2")
})

it("keeps a TODO's request id after an invalid HTTP 200 answer and recovers with the same request", async () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-todo-validation-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const received: Array<Received> = []
    let valid = false
    const origin = await cloudAt(
      () => ({ status: 200, body: valid ? item("40", "queued") : { id: "HTTP 403" } }),
      received
    )
    const cloud = (await signIn(origin)())!
    let ids = 0
    const file = Factory.filer(cloud.post, () => `request-${++ids}`)
    expect(await file("o/r", "Same TODO")).toEqual({
      ok: false,
      detail: "That command could not run. Details: /conversation",
      settled: false
    })
    const diagnostic = readFileSync(Log.path(), "utf8")
    expect(diagnostic).toContain("state")
    expect(diagnostic.trim().split("\n")).toHaveLength(1)
    valid = true
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true, item: { issue: { number: 40 } } })
    expect(received.map((request) => JSON.parse(request.body).request)).toEqual(["request-1", "request-1"])
    expect(readFileSync(Log.path(), "utf8")).toBe(diagnostic)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("exposes no TODO land door", () => {
  expect("land" in Factory).toBe(false)
  expect("landCommand" in Factory).toBe(false)
})

// A TODO's Retry is POST /api/todos/{n} on the install; the stack's item retry route is gone, so the TUI offers none.
it("exposes no retry door on the factory's issues", () => {
  expect("retry" in Factory).toBe(false)
  expect("retryCommand" in Factory).toBe(false)
  const rows = Factory.rows({ ...stack, items: [item("2500", "blocked"), item("2501", "rejected")] } as unknown as MythicalStack, now)
  expect(rows.every((row) => row.action === undefined)).toBe(true)
  expect(rows.flatMap((row) => row.details).some((block) => block.kind === "text" && block.text.includes("/retry"))).toBe(false)
})

it("keeps raw Cloud failures out of filing results", async () => {
  const raw = "HTTP 503: private backend stack trace"
  const file = Factory.filer(async () => {
    throw new Error(raw)
  })
  const answer = await file("o/r", "Fix it")
  expect(answer).toMatchObject({ ok: false, settled: false })
  expect(answer.ok ? "" : answer.detail).not.toContain(raw)
})
