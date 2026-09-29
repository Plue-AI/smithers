import { describe, expect, test } from "bun:test"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import type { Card } from "./AppState"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { json, memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })
/*
 * The card a test names, or a failure. `if (card?.kind === "x")` around a
 * block of assertions turns a missing card into a silent pass: the block
 * simply never runs.
 */
type CardRow = NonNullable<ReturnType<AppStore["collections"]["cards"]["get"]>>
const cardOf = <K extends Card["kind"]>(store: AppStore, id: string, kind: K): Extract<CardRow, { kind: K }> => {
  const card = store.collections.cards.get(id)
  if (card === undefined || card.kind !== kind) {
    throw new Error(`no ${kind} card at ${id} (saw ${card?.kind ?? "nothing"})`)
  }
  return card as Extract<CardRow, { kind: K }>
}

interface RecordedRequest {
  readonly path: string
  readonly method: string
  readonly body: unknown
}

const backend = (
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
  recorded: RecordedRequest[] = []
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    recorded.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    })
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function"
          ? answer(new Request(absolute.toString(), init))
          : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

/** A store whose session validates as admin, the only state the admin plugin registers for. */
const adminStore = async (): Promise<AppStore> => {
  const store = await webStore()
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: true,
    scopesPlain: null
  })
  return store
}

const QUEUE = {
  requests: [
    {
      login: "octocat",
      note: "design partner",
      createdAt: "2026-08-07T10:00:00.000Z",
      updatedAt: "2026-08-07T10:00:00.000Z"
    },
    { login: "hubot", note: null, createdAt: "2026-08-08T08:00:00.000Z", updatedAt: "2026-08-08T08:00:00.000Z" }
  ]
}

describe("the admin plugin (admin session)", () => {
  test("human-authority confirmations are structurally absent from the model catalog", async () => {
    const store = await adminStore()
    const controller = createAppController(store, silentAgent)
    const callable = controller.commands.callable().map((entry) => entry.binding.descriptor.name)
    expect(callable).not.toContain("admin.grant.confirm")
    expect(callable).not.toContain("admin.grant.cancel")
    expect(callable).not.toContain("admin.queue.approve")
    expect((await controller.commands.runForAgent("admin.grant.confirm", "grant-card")).status).toBe("failed")
  })

  test("allowlist add posts and confirms from the server echo", async () => {
    const store = await adminStore()
    const recorded: RecordedRequest[] = []
    const controller = createAppController(store, silentAgent, {
      ...backend(
        {
          "/api/admin/allowlist": json(201, {
            applied: true,
            action: "add",
            login: "octocat",
            requester: "will"
          })
        },
        recorded
      )
    })
    const outcome = await controller.commands.run("admin.allowlist.add", "octocat")
    expect(outcome.status).toBe("executed")
    const posted = recorded.find((r) => r.path === "/api/admin/allowlist")
    expect(posted?.body).toEqual({ login: "octocat", action: "add" })
    const line = [...store.collections.messages.values()].find((m) => m.text.includes("octocat added to the allowlist"))
    expect(line).toBeDefined()
  })

  test("grant asks first: the confirmation card states exactly what happens before posting", async () => {
    const store = await adminStore()
    const recorded: RecordedRequest[] = []
    const controller = createAppController(store, silentAgent, {
      ...backend(
        {
          "/api/admin/grant": json(201, { granted: true, grantId: "admin:product-x", userId: "octocat" })
        },
        recorded
      )
    })
    expect((await controller.commands.run("admin.grant", "25 octocat")).status).toBe("executed")
    // Nothing posted yet — the card asks first.
    expect(recorded.some((r) => r.path === "/api/admin/grant")).toBe(false)
    const found = [...store.collections.cards.values()].find((c) => c.kind === "grant-confirm")
    const card = cardOf(store, found?.id ?? "", "grant-confirm")
    expect(card.title).toBe("Grant $25 to octocat?")
    expect(card.payload.phase).toBe("confirm")
    expect(card.payload.amountUsd).toBe(25)
    expect(card.payload.login).toBe("octocat")

    expect((await controller.commands.run("admin.grant.confirm", card.id)).status).toBe("executed")
    const posted = recorded.find((r) => r.path === "/api/admin/grant")
    expect(posted?.body).toEqual({ login: "octocat", amountUsd: 25, operationKey: card.id })
    const granted = cardOf(store, card.id, "grant-confirm")
    expect(granted.status).toBe("acted")
    expect(granted.payload.phase).toBe("granted")
    expect(granted.payload.grantId).toBe("admin:product-x")
  })

  test("a failed grant retried from its card sends the same operation key", async () => {
    const store = await adminStore()
    const recorded: RecordedRequest[] = []
    let attempts = 0
    const controller = createAppController(store, silentAgent, {
      ...backend(
        {
          "/api/admin/grant": () => {
            attempts += 1
            return attempts === 1
              ? json(502, { status: "error", message: "The billing service is unreachable right now." })
              : json(200, { granted: true, duplicate: true, grantId: "admin:product-x", userId: "octocat" })
          }
        },
        recorded
      )
    })
    await controller.commands.run("admin.grant", "25 octocat")
    const card = [...store.collections.cards.values()].find((c) => c.kind === "grant-confirm")
    await controller.commands.run("admin.grant.confirm", card?.id ?? "")
    const failed = store.collections.cards.get(card?.id ?? "")
    expect(failed?.kind === "grant-confirm" ? failed.payload.phase : undefined).toBe("failed")
    await controller.commands.run("admin.grant.confirm", card?.id ?? "")
    const bodies = recorded.filter((r) => r.path === "/api/admin/grant").map((r) => r.body)
    expect(bodies).toEqual([
      { login: "octocat", amountUsd: 25, operationKey: card?.id },
      { login: "octocat", amountUsd: 25, operationKey: card?.id }
    ])
    const granted = store.collections.cards.get(card?.id ?? "")
    expect(granted?.kind === "grant-confirm" ? granted.payload.phase : undefined).toBe("granted")
  })

  test("grant cancel removes the card without posting", async () => {
    const store = await adminStore()
    const recorded: RecordedRequest[] = []
    const controller = createAppController(store, silentAgent, {
      ...backend({}, recorded)
    })
    await controller.commands.run("admin.grant", "10 hubot")
    const card = [...store.collections.cards.values()].find((c) => c.kind === "grant-confirm")
    expect(card).toBeDefined()
    await controller.commands.run("admin.grant.cancel", card?.id ?? "")
    expect(store.collections.cards.get(card?.id ?? "")).toBeUndefined()
    expect(recorded.some((r) => r.path === "/api/admin/grant")).toBe(false)
  })

  test("requests renders the queue card and one-click approve posts allowlist add then re-reads", async () => {
    const store = await adminStore()
    const recorded: RecordedRequest[] = []
    const controller = createAppController(store, silentAgent, {
      ...backend(
        {
          // The landed identity contract does NOT drain the queue on
          // approval (allowlistApply writes the entry + audit only), so the
          // double keeps the row; the product re-reads the server's truth.
          "/api/admin/requests": () => json(200, QUEUE),
          "/api/admin/allowlist": () => json(201, { applied: true, action: "add", login: "octocat", requester: "will" })
        },
        recorded
      )
    })
    expect((await controller.commands.run("admin.requests")).status).toBe("executed")
    const card = cardOf(store, "admin-requests", "request-queue")
    expect(card.payload.requests.map((r) => r.login)).toEqual(["octocat", "hubot"])

    expect((await controller.commands.run("admin.queue.approve", "octocat")).status).toBe("executed")
    const posted = recorded.find((r) => r.path === "/api/admin/allowlist")
    expect(posted?.body).toEqual({ login: "octocat", action: "add" })
    // The card re-read from the server after the approve — never local optimism.
    const queueReads = recorded.filter((r) => r.path === "/api/admin/requests")
    expect(queueReads.length).toBeGreaterThanOrEqual(2)
    const refreshed = cardOf(store, "admin-requests", "request-queue")
    expect(refreshed.payload.approving).toBeNull()
    expect(refreshed.payload.requests.map((r) => r.login)).toEqual(["octocat", "hubot"])
  })

  test("health composes the per-service card from the real read", async () => {
    const store = await adminStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/admin/health": json(200, {
          services: [
            { name: "billing", status: "ok", detail: "healthz ok — rateCardVersion: \"2026-08-08\"" },
            { name: "identity", status: "ok", detail: "healthz ok." }
          ],
          charges: { chargeCount: 3, lifetimeChargedUsd: "0.16125" },
          queueDepth: 2,
          checkedAt: "2026-08-08T09:30:00.000Z"
        })
      })
    })
    expect((await controller.commands.run("admin.health")).status).toBe("executed")
    const card = cardOf(store, "admin-health", "admin-health")
    expect(card.payload.services.map((s) => `${s.name}:${s.status}`)).toEqual([
      "billing:ok",
      "identity:ok"
    ])
    expect(card.payload.queueDepth).toBe(2)
    expect(card.payload.charges?.lifetimeChargedUsd).toBe("0.16125")
  })

  test("an admin route failure is an honest line, never a dead end", async () => {
    const store = await adminStore()
    const refused = {
      status: "error",
      message: "The identity admin surface is not configured on this deployment (IDENTITY_ADMIN_TOKEN is unset)."
    }
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/admin/requests": json(501, refused)
      })
    })
    await controller.commands.run("admin.requests")
    const expected = `The request queue didn't answer. ${refusalLead(refusalOf({ body: refused, status: 501, message: refused.message }))}`
    const texts = [...store.collections.messages.values()].map((m) => m.text)
    expect(texts).toContain(expected)
    expect(texts.join("\n")).not.toContain("IDENTITY_ADMIN_TOKEN")
    expect(store.collections.cards.get("admin-requests")).toBeUndefined()
  })
})
