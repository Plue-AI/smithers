import { expect, it } from "vitest"
import { IntegrationFailure } from "../src/core/ActionFailure.ts"
import * as IssueSync from "../src/core/IssueSync.ts"

const delivery = (overrides: Partial<typeof IssueSync.Delivery.Type> = {}): typeof IssueSync.Delivery.Type => ({
  id: 1,
  key: "one",
  issue_id: 42,
  state: "pending",
  event: "comment.created",
  payload: { comment: { id: 7, body: "hello" } },
  message_id: "",
  mapping: { provider: "github", connection_id: "gh", scope_id: "o", conversation_id: "r", thread_id: "42" },
  ...overrides
})
const fixture = (rows = [delivery()], options: {
  accepts?: IssueSync.Connector["accepts"]
  deliver?: IssueSync.Connector["deliver"]
  reconcile?: IssueSync.Connector["reconcile"]
  claim?: unknown
  settle?: (body: unknown) => Response
  pages?: (path: string, reads: number) => unknown
} = {}) => {
  const calls: Array<{ path: string; method: string; body?: any }> = []
  const delivered: Array<string> = []
  let reads = 0
  const sync = IssueSync.make({
    owner: "o",
    repo: "r",
    connector: {
      accepts: options.accepts ?? (() => true),
      deliver: options.deliver ?? (async (_row, executionId) => {
        delivered.push(executionId)
        return { messageId: "10" }
      }),
      reconcile: options.reconcile ?? (async () => undefined)
    },
    request: async (path, init) => {
      const method = init?.method ?? "GET", body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      calls.push({ path, method, body })
      if (method === "POST") {
        return Response.json(Object.hasOwn(options, "claim") ? options.claim : { state: "dispatching", token: "lease" })
      }
      if (method === "PUT") return options.settle?.(body) ?? Response.json({})
      return Response.json(options.pages?.(path, ++reads) ?? rows)
    }
  })
  return { sync, calls, delivered }
}

it("fences a claimed delivery and records its exact durable execution identity", async () => {
  const f = fixture()
  expect(await f.sync.drain()).toBe(1)
  expect(f.delivered).toEqual(["issue-sync:1:lease"])
  expect(f.calls.find((c) => c.method === "PUT")?.body).toEqual({ state: "sent", token: "lease", message_id: "10" })
})

it.each([
  delivery({ state: "dispatching" }),
  delivery({ state: "dispatching", claim_token: "" }),
  delivery({ state: "sent", event: "reaction.created" })
])("does not dispatch an active lease or an already settled non-comment (%j)", async (row) => {
  const f = fixture([row])
  expect(await f.sync.drain()).toBe(0)
  expect(f.delivered).toEqual([])
  expect(f.calls.some((c) => c.method !== "GET")).toBe(false)
})

it("ignores mappings outside the connector and rows removed since the first read", async () => {
  const denied = fixture([delivery()], { accepts: () => false })
  expect(await denied.sync.drain()).toBe(0)
  expect(denied.calls).toHaveLength(1)
  const gone = fixture([delivery()], { pages: (_path, reads) => reads === 1 ? [delivery()] : [] })
  expect(await gone.sync.drain()).toBe(0)
  expect(gone.delivered).toEqual([])
})

it.each([null, {}, { state: "pending", token: "lease" }, { state: "dispatching", token: 7 }])(
  "refuses a malformed claim without dispatch (%j)",
  async (claim) => {
    const f = fixture([delivery()], { claim })
    expect(await f.sync.drain()).toBe(0)
    expect(f.delivered).toEqual([])
  }
)

it("replays an expired claim with its original token without claiming again", async () => {
  const f = fixture([delivery({ state: "dispatching", claim_token: "original" })])
  expect(await f.sync.drain()).toBe(1)
  expect(f.delivered).toEqual(["issue-sync:1:original"])
  expect(f.calls.some((c) => c.method === "POST")).toBe(false)
})

it.each([undefined, "existing"])("reconciles an uncertain comment before settling (%s)", async (found) => {
  let identity = ""
  const f = fixture([delivery({ state: "outcome_unknown" })], {
    reconcile: async (_d, id) => {
      identity = id
      return found
    }
  })
  expect(await f.sync.drain()).toBe(found === undefined ? 0 : 1)
  expect(identity).toMatch(/^issue-sync-reconcile:1:/)
  expect(f.delivered).toEqual([])
  if (found !== undefined) {
    expect(f.calls.find((c) => c.method === "PUT")?.body).toEqual({ state: "sent", token: "", message_id: "existing" })
  }
})

it("marks an unsupported delivery with the connector's diagnostic", async () => {
  const f = fixture([delivery()], { deliver: async () => ({ messageId: "", unsupported: "not supported" }) })
  expect(await f.sync.drain()).toBe(1)
  expect(f.calls.find((c) => c.method === "PUT")?.body).toEqual({
    state: "unsupported",
    token: "lease",
    message_id: "",
    error: "not supported"
  })
})

it.each([
  [new IntegrationFailure({ reason: "permission-denied", message: "refused", retryable: false }), "failed", ""],
  [
    new IntegrationFailure({ reason: "delivery-failed", message: "uncertain", retryable: false, outcomeUnknown: true }),
    "outcome_unknown",
    ""
  ],
  [
    new IntegrationFailure({
      reason: "delivery-failed",
      message: "partial",
      retryable: false,
      deliveredMessageIds: [10, 11]
    }),
    "outcome_unknown",
    "10,11"
  ],
  [new Error("foreign failure"), "outcome_unknown", ""]
])(
  "records refusal, ambiguity, and partial outcomes before another delivery (%j)",
  async (failure, state, messageId) => {
    const f = fixture([delivery()], {
      deliver: async () => {
        throw { cause: { error: failure } }
      }
    })
    expect(await f.sync.drain()).toBe(0)
    expect(f.calls.find((c) => c.method === "PUT")?.body).toMatchObject({
      state,
      message_id: messageId,
      token: "lease"
    })
  }
)

it("does not loop through a cyclic foreign failure", async () => {
  const cyclic: any = {}
  cyclic.cause = cyclic
  const f = fixture([delivery()], {
    deliver: async () => {
      throw cyclic
    }
  })
  expect(await f.sync.drain()).toBe(0)
  expect(f.calls.find((c) => c.method === "PUT")?.body.error).toBe("Delivery did not settle; reconcile before retrying")
})

it("treats a receipt settled by another worker as moot", async () => {
  const f = fixture([delivery()], { settle: () => new Response(null, { status: 409 }) })
  expect(await f.sync.drain()).toBe(0)
  expect(f.delivered).toHaveLength(1)
})

it("keeps a failed receipt recoverable and reports it without repeating the write", async () => {
  const f = fixture([delivery()], { settle: () => new Response(null, { status: 503 }) })
  await expect(f.sync.drain()).rejects.toThrow("receipts did not commit")
  expect(f.delivered).toHaveLength(1)
})

it("pages monotonically and rejects a stuck cursor before dispatch", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => delivery({ id: i + 1 }))
  const f = fixture(rows, { accepts: () => false, pages: (path) => path.includes("after_id") ? [] : rows })
  expect(await f.sync.drain()).toBe(0)
  expect(f.calls.at(-1)?.path).toContain("after_id=100")
  const stuck = fixture(rows, { pages: () => rows })
  await expect(stuck.sync.drain()).rejects.toThrow("cursor did not advance")
  expect(stuck.delivered).toEqual([])
})

it("rejects malformed deliveries before claims", async () => {
  const f = fixture([], { pages: () => [{}] })
  await expect(f.sync.drain()).rejects.toThrow()
  expect(f.calls.some((c) => c.method === "POST")).toBe(false)
})

it("does not count a reconciliation another worker already settled", async () => {
  const f = fixture([delivery({ state: "outcome_unknown" })], {
    reconcile: async () => "existing",
    settle: () => new Response(null, { status: 409 })
  })
  expect(await f.sync.drain()).toBe(0)
  expect(f.delivered).toEqual([])
  expect(f.calls.find((c) => c.method === "PUT")?.body.token).toBe("")
})
