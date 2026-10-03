import { Refused } from "@smthrs/cli/CliError"
import * as CloudSession from "@smthrs/cli/CloudSession"
import type { MythicalStack } from "@smthrs/rpc/Mythical"
import { TodoSchema, TodoStateSchema } from "@smthrs/rpc/Todo"
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
/** A TODO's `POST /api/todos` answer: persisted, not started. */
const made = (n: number, title: string, state = "queued") => ({
  state: "requested",
  todo: {
    n,
    title,
    state,
    amendments: 0,
    lessons: 0,
    branch: { id: `b${n}`, name: `t${n}` },
    created_by: { kind: "person", id: 1 },
    seq: 1,
    created_at: "2026-09-28T19:00:00Z",
    updated_at: "2026-09-28T19:00:00Z"
  }
})
const todos = "/api/todos?repo=o/r"
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
    text: "Already done.\nhttps://github.com/o/r/issues/2401\n/retry #2401"
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
    text: "No machine matches what this repository declares\nhttps://github.com/o/r/issues/2405\n/retry #2405"
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

it("files a TODO under one Idempotency-Key, resent after an unanswered filing and dropped after a refusal", async () => {
  const sent: Array<{ path: string; body: unknown; key: string | undefined }> = []
  const answers: Array<() => Promise<unknown>> = []
  let ids = 0
  const file = Factory.filer(
    (path, body, _signal, headers) => {
      sent.push({ path, body, key: headers?.["Idempotency-Key"] })
      return answers.shift()!()
    },
    () => `id-${++ids}`
  )
  const queued = made(12, "Add dark mode")
  // A dropped network keeps the id: the same TODO again resends it and makes it once.
  answers.push(() => Promise.reject(new Error("fetch failed")), () => Promise.resolve(queued))
  expect(await file("o/r", "Add dark mode")).toEqual({
    ok: false,
    detail: "That command could not run. Details: /conversation",
    settled: false
  })
  const filed = await file("o/r", "Add dark mode")
  expect(filed.ok && Factory.todoLine(filed.todo)).toBe("T12 Add dark mode · queued")
  expect(sent).toEqual([
    { path: todos, body: { title: "Add dark mode" }, key: "id-1" },
    { path: todos, body: { title: "Add dark mode" }, key: "id-1" }
  ])
  // An answered filing frees its id: the next filing of the text is a new TODO.
  answers.push(
    () => Promise.reject(new Refused({ code: "cloud_request_failed", fault: "user", message: "HTTP 403" })),
    () => Promise.resolve(queued)
  )
  expect(await file("o/r", "Add dark mode")).toMatchObject({ ok: false, settled: true })
  await file("o/r", "Add dark mode")
  expect(sent.map((each) => each.key)).toEqual(["id-1", "id-1", "id-2", "id-3"])
})

it("words each TODO state as the product does", () => {
  const words = ["queued", "starting", "working", "needs you", "paused", "failed", "in review", "merged", "dropped"]
  expect(TodoStateSchema.options.map((state) => Factory.todoLine(TodoSchema.parse(made(7, "Fix it", state).todo))))
    .toEqual(words.map((word) => `T7 Fix it · ${word}`))
})

it("joins a TODO filed while the same one is in flight", async () => {
  const releases: Array<(value: unknown) => void> = []
  const file = Factory.filer(() => new Promise((resolve) => releases.push(resolve)))
  const first = file("o/r", "Same")
  const second = file("o/r", "Same")
  const other = file("o/x", "Same")
  expect(releases).toHaveLength(2)
  for (const release of releases) release(made(41, "Same"))
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
  readonly key: string | undefined
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
        key: request.headers["idempotency-key"] as string | undefined,
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
const stackRoute = "/api/repos/o/r/mythical"
/** The stack as Cloud serves it. */
const served = { ...stack, changes: stack.changes.map((change) => ({ ...change, state: "landed" })) }

it("keeps returned TODO refusals and uncertain failures diagnostic, private and retryable over HTTP", async () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-todo-diagnostic-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const received: Array<Received> = []
    let status = 403
    const origin = await cloudAt(() => ({ status, body: status === 200 ? made(40, "Same TODO") : {} }), received)
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
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true, todo: { n: 40, title: "Same TODO" } })
    expect(received.map((request) => [request.method, request.path, request.key, JSON.parse(request.body)])).toEqual(
      ["request-1", "request-2", "request-3", "request-3"].map((key) => ["POST", todos, key, { title: "Same TODO" }])
    )
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
    const file = Factory.filer(async (_path, _body, _signal, headers) => {
      requests.push(headers!["Idempotency-Key"]!)
      if (attempts++ === 0) throw new Refused({ code, fault, message: "private diagnostic mentions HTTP 403" })
      return made(40, "Same TODO")
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
    const file = Factory.filer(async (_path, _body, _signal, headers) => {
      requests.push(headers!["Idempotency-Key"]!)
      if (requests.length === 1) throw failure
      return made(40, "Same TODO")
    }, () => `request-${++ids}`)
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: false, settled: false })
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true })
    expect(requests).toEqual(["request-1", "request-1"])
  }
})

it("retains a TODO's identity through real HTTP waits, disconnection and duplicate input", async () => {
  const received: Array<{ key: string | undefined; body: unknown }> = []
  let status = 408
  let disconnect = false
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      received.push({ key: request.headers["idempotency-key"] as string | undefined, body: JSON.parse(body) })
      if (disconnect) {
        request.socket.destroy()
        return
      }
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(status === 202 ? made(40, "Same TODO") : { httpStatus: 401, message: "HTTP 401" }))
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
  status = 202
  expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true, todo: { n: 40 } })
  expect(received).toHaveLength(6)
  expect(received.map((request) => request.key)).toEqual(Array(6).fill("request-1"))
  expect(received.every((request) => JSON.stringify(request.body) === JSON.stringify({ title: "Same TODO" }))).toBe(true)
  expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true })
  expect(received.at(-1)?.key).toBe("request-2")
})

it("keeps a TODO's request id after an invalid HTTP 200 answer and recovers with the same request", async () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-todo-validation-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const received: Array<Received> = []
    let valid = false
    const origin = await cloudAt(
      // The retired filing route's answer, an item, is not a TODO; its diagnostic words never settle it.
      () => ({ status: 200, body: valid ? made(40, "Same TODO") : { ...item("40", "queued"), id: "HTTP 403" } }),
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
    expect(await file("o/r", "Same TODO")).toMatchObject({ ok: true, todo: { n: 40 } })
    expect(received.map((request) => request.key)).toEqual(["request-1", "request-1"])
    expect(readFileSync(Log.path(), "utf8")).toBe(diagnostic)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("keeps thrown retry causes in the redacted log and domain refusals actionable", async () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-retry-diagnostic-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const error = new Error("private keyring /secrets/operator", {
      cause: new Error("Authorization: Bearer sk-private-token")
    })
    const answer = await Factory.retryCommand("#2431", "o/r", async () => {
      throw error
    }).settled
    expect(answer).toEqual({
      text: "#2431 not retried: That command could not run. Details: /conversation",
      tone: "warning"
    })
    const saved = readFileSync(Log.path(), "utf8")
    expect(saved).toContain("private keyring /secrets/operator")
    expect(saved).toContain("Caused by:")
    expect(saved).not.toContain("sk-private-token")
    const origin = await cloudAt(() => ({ status: 200, body: served }))
    expect(await Factory.retryCommand("#2412", "o/r", signIn(origin)).settled).toEqual({
      text: "#2412 not retried: #2412 is implementing",
      tone: "warning"
    })
    expect(readFileSync(Log.path(), "utf8")).toBe(saved)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("retries a blocked TODO as the signed-in person and settles on the item Cloud answers", async () => {
  const received: Array<Received> = []
  const origin = await cloudAt(
    (method, path) =>
      method === "GET" && path === stackRoute
        ? { status: 200, body: served }
        : method === "POST" && path === "/api/repos/o/r/mythical/items/2431/retry"
        ? { status: 202, body: item("2431", "queued") }
        : { status: 404, body: {} },
    received
  )
  const command = Factory.retryCommand("#2431", "o/r", signIn(origin))
  expect(command.now).toEqual({ text: "Retry #2431 requested" })
  expect(await command.settled).toEqual({ text: "#2431 queued" })
  expect(received.map(({ method, path, auth }) => [method, path, auth])).toEqual([
    ["GET", stackRoute, "token tok_retry"],
    ["POST", "/api/repos/o/r/mythical/items/2431/retry", "token tok_retry"]
  ])
  expect(JSON.parse(received[1]!.body)).toEqual({})
})

it("shows a refused retry as a typed failure, and never posts for an issue that is not retryable", async () => {
  const received: Array<Received> = []
  const origin = await cloudAt(
    (method) => method === "GET" ? { status: 200, body: served } : { status: 409, body: { message: "busy" } },
    received
  )
  const refused = await Factory.retryCommand("2431", "o/r", signIn(origin)).settled
  expect(refused).toEqual({
    text: "#2431 not retried: That command could not run. Details: /conversation",
    tone: "warning"
  })
  const cloud = (await signIn(origin)())!
  expect(await Factory.retry(cloud, "o/r", 2431)).toEqual({
    ok: false,
    detail: "That command could not run. Details: /conversation",
    // Cloud classifies a 409 as infrastructure failure, so certainty cannot
    // be inferred from its diagnostic text.
    settled: false
  })
  // A running issue and an issue the stack does not hold are refused here, before any POST.
  expect(await Factory.retryCommand("2412", "o/r", signIn(origin)).settled).toEqual({
    text: "#2412 not retried: #2412 is implementing",
    tone: "warning"
  })
  expect(await Factory.retryCommand("#9", "o/r", signIn(origin)).settled).toEqual({
    text: "#9 not retried: #9 is not in the factory",
    tone: "warning"
  })
  expect(received.filter((each) => each.method === "POST")).toHaveLength(2)
})

it("persists a retry request before authentication or lookup and refuses a failed durable write", async () => {
  const ordering: string[] = []
  const request = Factory.retryCommand("#2431", "o/r", async () => {
    ordering.push("authenticate")
    return undefined
  }, (line) => {
    expect(line).toEqual({ text: "Retry #2431 requested" })
    ordering.push("persist")
  })
  expect(ordering).toEqual(["persist", "authenticate"])
  expect(await request.settled).toEqual({ text: "Sign in to retry: smthrs auth login", tone: "warning" })
  const refused = Factory.retryCommand("#2431", "o/r", async () => {
    ordering.push("must not authenticate")
    return undefined
  }, () => {
    throw new Error("disk full")
  })
  expect(refused.settled).toBeUndefined()
  expect(refused.now).toEqual({
    text: "Retry #2431 not requested: That command could not run. Details: /conversation",
    tone: "warning"
  })
  expect(ordering).toEqual(["persist", "authenticate"])
})

it("the visible retry door presents lookup, POST, authentication and persistence failures without changing domain refusals", async () => {
  const raw: unknown[] = []
  const present = (error: unknown) => {
    raw.push(error)
    return "The command could not run."
  }
  const lookup = await cloudAt(() => ({ status: 503, body: {} }))
  expect(await Factory.retryCommand("#2431", "o/r", signIn(lookup), undefined, present).settled).toEqual({
    text: "#2431 not retried: The command could not run.",
    tone: "warning"
  })
  const post = await cloudAt((method) => method === "GET" ? { status: 200, body: served } : { status: 403, body: {} })
  expect(await Factory.retryCommand("#2431", "o/r", signIn(post), undefined, present).settled).toEqual({
    text: "#2431 not retried: The command could not run.",
    tone: "warning"
  })
  expect(raw.map((error) => (error as { fault: string }).fault)).toEqual(["infra", "user"])
  expect(raw.map((error) => String(error))).toEqual([
    expect.stringContaining("HTTP 503"),
    expect.stringContaining("HTTP 403")
  ])
  const refused = await Factory.retryCommand("#2412", "o/r", signIn(post), undefined, present).settled
  expect(refused).toEqual({ text: "#2412 not retried: #2412 is implementing", tone: "warning" })
  expect(raw).toHaveLength(2)
  const auth = new Error("private keyring path")
  expect(
    await Factory.retryCommand(
      "#2431",
      "o/r",
      async () => {
        throw auth
      },
      undefined,
      present
    ).settled
  ).toEqual({
    text: "#2431 not retried: The command could not run.",
    tone: "warning"
  })
  const disk = new Error("private disk path")
  expect(Factory.retryCommand("#2431", "o/r", signIn(post), () => {
    throw disk
  }, present)).toEqual({
    now: { text: "Retry #2431 not requested: The command could not run.", tone: "warning" }
  })
  expect(raw.slice(2)).toEqual([auth, disk])
})

it("settles an unreachable Cloud as a failure that may not have been sent", async () => {
  const origin = await cloudAt(() => ({ status: 200, body: served }))
  servers.splice(0).forEach((close) => close())
  const settled = await Factory.retryCommand("2431", "o/r", signIn(origin)).settled
  expect(settled?.tone).toBe("warning")
  expect(settled?.text.startsWith("#2431 not retried: ")).toBe(true)
  const answer = await Factory.retry((await signIn(origin)())!, "o/r", 2431)
  expect(answer).toMatchObject({ ok: false, settled: false })
  // A 5xx is not a refusal either.
  const failing = await cloudAt(() => ({ status: 503, body: {} }))
  expect(await Factory.retry((await signIn(failing)())!, "o/r", 2431)).toEqual({
    ok: false,
    detail: "That command could not run. Details: /conversation",
    settled: false
  })
})

it("answers a /retry it cannot send at once: no issue, no repository, signed out, a failing sign-in", async () => {
  for (const argument of ["", "abc", "#0", "12x", "-3"]) {
    expect(Factory.retryCommand(argument, "o/r", signIn("http://127.0.0.1:1"))).toEqual({
      now: { text: "Usage: /retry <issue>", tone: "warning" }
    })
  }
  expect(Factory.retryCommand("12", undefined, signIn("http://127.0.0.1:1"))).toEqual({
    now: { text: "No repository for this directory", tone: "warning" }
  })
  expect(await Factory.retryCommand(" #12 ", "o/r", () => Promise.resolve(undefined)).settled).toEqual({
    text: "Sign in to retry: smthrs auth login",
    tone: "warning"
  })
  expect(await Factory.retryCommand("12", "o/r", () => Promise.reject(new Error("keyring locked"))).settled).toEqual({
    text: "#12 not retried: That command could not run. Details: /conversation",
    tone: "warning"
  })
})

it("names the retry command only on an issue a person may retry", () => {
  const retried = (state: string, extra: Record<string, unknown> = {}) =>
    Factory.rows({ ...stack, items: [item("2500", state, extra)] } as unknown as MythicalStack, now)
      .find((row) => row.label.includes("#2500"))?.details.map((block) => block.kind === "text" ? block.text : "")
      .join("")
  for (const state of ["blocked", "rejected", "declined"]) expect(retried(state)).toContain("/retry #2500")
  expect(retried("proposed", { reviewHeld: true })).toContain("/retry #2500")
  for (const state of ["queued", "running", "landed", "proposed"]) expect(retried(state) ?? "").not.toContain("/retry")
})

it("offers an explicit Retry action only for retryable issue rows, without executing it on publication", () => {
  const row = (state: string, extra: Record<string, unknown> = {}) =>
    Factory.rows({ ...stack, items: [item("2500", state, extra)] } as unknown as MythicalStack, now)
      .find((row) => row.label.includes("#2500"))
  const retry = { label: "Retry", action: { kind: "factory-retry", issue: 2500 } } as const
  for (const state of ["blocked", "rejected", "declined"]) expect(row(state)?.action).toEqual(retry)
  expect(row("proposed", { reviewHeld: true })?.action).toEqual(retry)
  for (const state of ["queued", "running", "retrying", "landed", "proposed"]) {
    expect(row(state)?.action).toBeUndefined()
  }
  const withoutIssue = Factory.rows({
    ...stack,
    items: [{ ...item("2500", "blocked"), issue: undefined }]
  } as unknown as MythicalStack, now)
  expect(withoutIssue.every((row) => row.action === undefined)).toBe(true)
  expect(Factory.rows(stack, now).filter((row) => row.id.startsWith("group:")).every((row) => row.action === undefined))
    .toBe(true)
})

it("lands a proposed TODO at the head the stack served, and never posts for one that is not landable", async () => {
  const head = "f".repeat(40)
  const pullRequest = { number: 50, url: "https://github.com/o/r/pull/50", state: "open", head }
  const landing = {
    ...served,
    items: [
      ...served.items,
      item("2450", "proposed", { todo: { replans: 0 }, pullRequest }),
      item("2451", "proposed", { todo: { replans: 0 }, pullRequest, automerge: true })
    ]
  }
  const received: Array<Received> = []
  const origin = await cloudAt(
    (method, path) =>
      method === "GET" && path === stackRoute
        ? { status: 200, body: landing }
        : method === "POST" && path === "/api/repos/o/r/mythical/items/2450/land"
        ? { status: 202, body: item("2450", "proposed", { todo: { replans: 0 }, pullRequest, automerge: true }) }
        : { status: 404, body: {} },
    received
  )
  const command = Factory.landCommand("#2450", "o/r", signIn(origin))
  expect(command.now).toEqual({ text: "Land #2450 requested" })
  expect(await command.settled).toEqual({ text: "#2450 PR open" })
  expect(JSON.parse(received.find((each) => each.method === "POST")!.body)).toEqual({ head })
  expect(await Factory.landCommand("2451", "o/r", signIn(origin)).settled).toEqual({
    text: "#2451 not landed: #2451 is PR open",
    tone: "warning"
  })
  expect(await Factory.landCommand("2431", "o/r", signIn(origin)).settled).toEqual({
    text: "#2431 not landed: #2431 is blocked",
    tone: "warning"
  })
  expect(Factory.landCommand("x", "o/r", signIn(origin)).now).toEqual({ text: "Usage: /land <issue>", tone: "warning" })
  expect(received.filter((each) => each.method === "POST")).toHaveLength(1)
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
