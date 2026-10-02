import { expect, it } from "vitest"
import * as IssueSync from "../src/core/IssueSync.ts"

const reaction = { kind: "reaction_add", delivery_key: "provider-event", message_id: "100.1" }
const connector: IssueSync.Connector = {
  accepts: () => true,
  deliver: async () => ({ messageId: "100.1" }),
  reconcile: async () => undefined
}

it("retries an early reaction with the same provider identity before acknowledging intake", async () => {
  const received: unknown[] = []
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    request: async (_path, init) => {
      received.push(JSON.parse(String(init?.body)))
      return received.length === 1 ? new Response(null, { status: 409 }) : Response.json({ issue_id: 42 })
    }
  })
  expect(await sync.ingest(reaction)).toBe("applied")
  expect(received).toEqual([reaction, reaction])
})

it("bounds receipt-race retries and leaves an exhausted delivery unacknowledged", async () => {
  let attempts = 0
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    request: async () => {
      attempts++
      return new Response(null, { status: 409 })
    }
  })
  await expect(sync.ingest(reaction)).rejects.toMatchObject({ status: 409 })
  expect(attempts).toBe(4)
})

it("retries a reaction removal without acknowledging it early", async () => {
  let attempts = 0
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    request: async () => {
      attempts++
      return attempts === 1 ? new Response(null, { status: 409 }) : Response.json({ issue_id: 42 })
    }
  })
  expect(await sync.ingest({ ...reaction, kind: "reaction_remove" })).toBe("applied")
  expect(attempts).toBe(2)
})

it.each([
  [{ kind: "message" }, 409],
  [null, 409],
  [reaction, 503]
])("does not retry other intake failures (%j, %s)", async (body, status) => {
  let attempts = 0
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    request: async () => {
      attempts++
      return new Response(null, { status })
    }
  })
  await expect(sync.ingest(body)).rejects.toMatchObject({ status })
  expect(attempts).toBe(1)
})

it("preserves a transport rejection without interpreting it as a receipt race", async () => {
  const sync = IssueSync.make({ owner: "owner", repo: "repo", connector, request: () => Promise.reject("offline") })
  await expect(sync.ingest(reaction)).rejects.toBe("offline")
})

it("preserves Retry-After for host scheduling without retrying a refused request", async () => {
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    request: async () => new Response(null, { status: 429, headers: { "Retry-After": "120" } })
  })
  await expect(sync.drain()).rejects.toMatchObject({ status: 429, retryAfter: "120" })
})

it("stops a batch on a rate-limited receipt before making another API request", async () => {
  let requests = 0
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    request: async (_path, init) => {
      requests++
      if (init?.method === "PUT") return new Response(null, { status: 429, headers: { "Retry-After": "120" } })
      if (init?.method === "POST") return Response.json({ state: "dispatching", token: "claim" })
      return Response.json(
        [1, 2].map((id) => ({
          id,
          key: String(id),
          issue_id: 42,
          state: "pending",
          event: "comment.created",
          payload: { comment: { id, body: "hello" } },
          message_id: "",
          mapping: {
            provider: "slack",
            connection_id: "slack",
            scope_id: "T001",
            conversation_id: "C001",
            thread_id: ""
          }
        }))
      )
    }
  })
  await expect(sync.drain()).rejects.toMatchObject({ status: 429, retryAfter: "120" })
  expect(requests).toBe(4)
})

const messageEvent = {
  source: "example",
  eventName: "integration:example:message",
  correlationId: "one",
  payload: { body: "hello" },
  dedupeKey: "one",
  receivedAtMs: 1
}
it.each([
  [{ ignored: "unmapped" }, messageEvent, true, "ignored", 0],
  [{ issue_id: 42 }, messageEvent, true, "applied", 1],
  [{ issue_id: 42 }, undefined, true, "applied", 0],
  [{ issue_id: 42 }, messageEvent, false, "applied", 0],
  [null, messageEvent, true, "applied", 0],
  [{ issue_id: "42" }, messageEvent, true, "applied", 0]
])("notifies only an accepted, typed issue receipt (%j)", async (receipt, event, notify, expected, count) => {
  const notifications: unknown[] = []
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    ...(notify
      ? {
        onMessage: async (message) => {
          notifications.push(message)
        }
      }
      : {}),
    request: async () => Response.json(receipt)
  })
  expect(await sync.ingest({ kind: "message" }, event)).toBe(expected)
  expect(notifications).toHaveLength(count)
  if (count) expect(notifications).toEqual([{ issueId: 42, event: messageEvent }])
})

it("leaves a callback failure unacknowledged for recovery", async () => {
  const sync = IssueSync.make({
    owner: "owner",
    repo: "repo",
    connector,
    onMessage: async () => {
      throw new Error("journal unavailable")
    },
    request: async () => Response.json({ issue_id: 42 })
  })
  await expect(sync.ingest({ kind: "message" }, messageEvent)).rejects.toThrow("journal unavailable")
})
