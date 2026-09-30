import * as CloudSession from "@smthrs/cli/CloudSession"
import type { MythicalStack } from "@smthrs/rpc/Mythical"
import { afterEach, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Factory from "../src/factory.ts"

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
  expect(await file("o/r", "Add dark mode")).toEqual({ ok: false, detail: "fetch failed", settled: false })
  const filed = await file("o/r", "Add dark mode")
  expect(filed.ok && filed.item.issue?.number).toBe(40)
  expect(sent.map((each) => [each.path, each.body.request])).toEqual([
    ["/api/repos/o/r/mythical/todos", "id-1"],
    ["/api/repos/o/r/mythical/todos", "id-1"]
  ])
  // An answered filing frees its id: the next filing of the text is a new TODO.
  answers.push(
    () => Promise.reject(new Error("/api/repos/o/r/mythical/todos: HTTP 403")),
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
const stackRoute = "/api/repos/o/r/mythical"
/** The stack as Cloud serves it. */
const served = { ...stack, changes: stack.changes.map((change) => ({ ...change, state: "landed" })) }

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
    text: "#2431 not retried: /api/repos/o/r/mythical/items/2431/retry: HTTP 409",
    tone: "warning"
  })
  const cloud = (await signIn(origin)())!
  expect(await Factory.retry(cloud, "o/r", 2431)).toEqual({
    ok: false,
    detail: "/api/repos/o/r/mythical/items/2431/retry: HTTP 409",
    settled: true
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
    detail: `${stackRoute}: HTTP 503`,
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
    text: "#12 not retried: keyring locked",
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
