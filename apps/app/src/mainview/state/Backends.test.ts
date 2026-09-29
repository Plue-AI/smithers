import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { CLOUD_AUTH_SESSION_PATH } from "@smthrs/rpc/CloudTunnel"
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import type { Card } from "./AppState"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { json, memoryStorage, settled, silentAgent, TEST_BOX } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })
const githubBootstrap: NonNullable<AppServices["bootstrap"]> = {
  apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null,
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: false, checkout: false, terminal: false })
}
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

/** A test-double backend: routes answers by path, never a network. */
const backend = (
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
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

const balanceBody = (totalUsd: string, chargeCount = 0) => ({
  user: "will",
  balance: { totalUsd, totalNanos: 0, lifetimeChargedUsd: "0.05375", chargeCount },
  state: totalUsd === "0" ? "empty" : "ok",
  allowedToStartWork: totalUsd !== "0",
  credits: []
})

describe("identity session record", () => {
  test("a canonical user answer drives the signed-in record (actor: system)", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({ "/api/user": json(200, { id: 1, username: "will", is_admin: false }) })
    })
    await controller.loadSession()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-in")
    expect(identity?.login).toBe("will")
    expect(identity?.allowlisted).toBe(true)
    const journal = [...store.collections.transitions.values()]
    expect(journal.some((r) => r.type === "identity.session.loaded" && r.actor === "system")).toBe(true)
  })

  test("a 401 signs out without waiting for a scopes read", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      bootstrap: githubBootstrap,
      ...backend({ "/api/user": json(401, { status: "error" }) })
    })
    await controller.loadSession()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-out")
    expect(identity?.scopesPlain).toBeNull()
  })

  test("the user route's malformed 200 answer leaves identity unavailable", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/user": json(200, { status: "signed-out" }),
        "/api/auth/scopes": json(200, {
          provider: "github",
          requestedScopes: ["read:user"],
          scopes: [{ scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." }]
        })
      })
    })
    await controller.loadSession()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("unavailable")
    expect(identity?.scopesPlain).toBeNull()
  })

  test("a signed-in answer drives the balance read from the session answer, not a blind boot probe", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/user": json(200, { id: 1, username: "will", is_admin: false }),
        "/api/billing/balance": json(200, balanceBody("500"))
      })
    })
    await controller.loadSession()
    await settled()
    const account = store.collections.billingAccounts.get("billing")
    expect(account?.state).toBe("ok")
    expect(account?.totalUsd).toBe("500")
  })

  test("an unreachable seam is recorded as unavailable, which never gates", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => {
        throw new Error("connection refused")
      }
    })
    await controller.loadSession()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
  })

  test("request access confirms once and is honest when the post fails", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/identity/request-access": json(200, { status: "requested" })
      })
    })
    await controller.adoptSession({ state: "signed-in", login: "newcomer", allowlisted: false, admin: false })
    await controller.requestAccess()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.accessRequested).toBe(true)
    expect(
      [...store.collections.transitions.values()].some(
        (r) => r.type === "identity.access.requested" && r.actor === "user"
      )
    ).toBe(true)
  })

  test("a failed access request is an honest state, not a dead end", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/identity/request-access": json(500, { status: "error", message: "queue unavailable" })
      })
    })
    await controller.adoptSession({ state: "signed-in", login: "newcomer", allowlisted: false, admin: false })
    await controller.requestAccess()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.accessRequested).toBe(false)
    expect(identity?.accessError).toBe("queue unavailable")
  })

  test("sign out posts to the seam and clears the record", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/user": json(200, { id: 1, username: "will", is_admin: false }),
        "/api/auth/logout": json(200, { status: "ok" })
      })
    })
    await controller.loadSession()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-in")
    await controller.signOut()
    const identity = store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-out")
    expect(identity?.login).toBeNull()
  })

  test("a signed-out send reaches the backend: identity is not a gate on the chat", async () => {
    const store = await webStore()
    let turns = 0
    const countingAgent: AgentPort = {
      ...silentAgent,
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, countingAgent, {
      ...backend({
        "/api/user": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    controller.send("can you help me?")
    await settled()

    expect(turns).toBe(1)
    const reply = [...store.collections.messages.values()].find((message) =>
      message.text.includes("Sign in with GitHub first")
    )
    expect(reply).toBeUndefined()
  })

  test("a selected backend user can send without an access gate", async () => {
    const store = await webStore()
    let turns = 0
    const countingAgent: AgentPort = {
      ...silentAgent,
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, countingAgent, {
      ...backend({
        "/api/user": json(200, { id: 1, username: "newcomer", is_admin: false })
      })
    })
    await controller.loadSession()
    controller.send("can you help me?")
    await settled()

    expect(turns).toBe(1)
    const reply = [...store.collections.messages.values()].find((message) =>
      message.text.includes("design partners only")
    )
    expect(reply).toBeUndefined()
  })

  test("returning from a failed OAuth redirect is a chat message with a retry action, never a bare page", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, backend({}))
    expect(controller.handleAuthReturn("?auth=failed")).toBe(true)
    const message = [...store.collections.messages.values()].find((entry) =>
      entry.text.includes("GitHub sign-in didn't finish")
    )
    expect(message?.role).toBe("smithers")
    expect(message?.action).toEqual({ flow: "auth.sign-in", label: "Try sign-in again" })
    expect(controller.handleAuthReturn("")).toBe(false)
    expect(controller.handleAuthReturn("?theme=dark")).toBe(false)
  })
})

describe("billing record", () => {
  test("balance refresh records dollars and allowedToStartWork", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({ "/api/billing/balance": json(200, balanceBody("500")) })
    })
    await controller.refreshBalance()
    const account = store.collections.billingAccounts.get("billing")
    expect(account?.state).toBe("ok")
    expect(account?.totalUsd).toBe("500")
    expect(account?.allowedToStartWork).toBe(true)
  })

  test("the balance card states the first-run line once, in dollars", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({ "/api/billing/balance": json(200, balanceBody("500")) })
    })
    await controller.showBalance()
    const card = cardOf(store, "billing-balance", "balance")
    expect(card.payload.totalUsd).toBe("500")
    expect(card.payload.introUsd).toBe("500")
  })

  test("the intro line is gone once anything has been charged", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({ "/api/billing/balance": json(200, balanceBody("499.94625", 1)) })
    })
    await controller.showBalance()
    expect(cardOf(store, "billing-balance", "balance").payload.introUsd).toBeNull()
  })

  test("a definitive $0 NEVER pauses chat — the turn runs (chat is on us during the alpha)", async () => {
    const store = await webStore()
    let turns = 0
    const countingAgent: AgentPort = {
      ...silentAgent,
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, countingAgent, {
      ...backend({ "/api/billing/balance": json(200, balanceBody("0")) })
    })
    await controller.refreshBalance()
    expect(store.collections.billingAccounts.get("billing")?.allowedToStartWork).toBe(false)

    controller.send("do more work")
    await settled()

    // The free-chat ruling (2026-08-09): interactive chat is complimentary —
    // the pause discipline applies only to non-complimentary (paid) work.
    expect(turns).toBe(1)
    const pause = [...store.collections.messages.values()].find((message) => message.text.includes("balance is at $0"))
    expect(pause).toBeUndefined()
    const submitted = [...store.collections.messages.values()].find(
      (message) => message.text === "do more work"
    )
    expect(submitted?.role).toBe("user")
  })

  test("an unconfigured billing seam is honest and never pauses work", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({})
    })
    await controller.refreshBalance()
    expect(store.collections.billingAccounts.get("billing")?.state).toBe("unavailable")
  })
})

describe("approval round trip", () => {
  const approvalCard = (store: AppStore, workspaceId: string | null = TEST_BOX): Card => {
    const card: Card = {
      id: "approval-1",
      kind: "approval",
      title: "Deploy it?",
      status: "active",
      createdAt: Date.now(),
      ordinal: 900,
      payload: {
        capability: "run the deploy flow",
        runId: "run_01",
        requestId: "approve",
        repo: "codeplanesmithers/smithers-demo",
        ...(workspaceId === null ? {} : { workspaceId }),
        approval: {
          target: { _tag: "Node", runId: "run_01", requestId: "approve", digest: "d", envelope: {} },
          scope: "run",
          idempotencyKey: "approve:approve"
        }
      }
    }
    store.dispatch({ type: "card.upsert", actor: "system", card })
    return card
  }

  test("decision → pending → gateway → freeze from the gateway's own answer", async () => {
    const store = await webStore()
    let posted: unknown
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/workflow/rpc": async (request) => {
          posted = await request.json()
          return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "approval-receipt" }, resume: { _tag: "Accepted" } } })
        }
      })
    })
    approvalCard(store)
    controller.decideApproval("approval-1", "approved")
    expect(cardOf(store, "approval-1", "approval").payload.pending).toBe(true)
    await settled()
    // The exact envelope the gateway published goes back, plus the decision:
    // the client never reconstructs the authority it is exercising.
    expect(posted).toEqual({
      repo: "codeplanesmithers/smithers-demo",
      procedure: "Approval.Submit",
      payload: {
        target: { _tag: "Node", runId: "run_01", requestId: "approve", digest: "d", envelope: {} },
        scope: "run",
        idempotencyKey: "approve:approve",
        decision: "approve"
      },
      workspaceId: TEST_BOX
    })
    const card = cardOf(store, "approval-1", "approval")
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
    expect(card.payload.pending).toBe(false)
    expect(card.payload.decidedAt).toBeDefined()
  })

  test("an approval recorded with no box refuses visibly, calls nothing, and never freezes", async () => {
    const store = await webStore()
    let calls = 0
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => { calls += 1; return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "r" } } }) }
    })
    approvalCard(store, null)
    controller.decideApproval("approval-1", "approved")
    await settled()
    const card = cardOf(store, "approval-1", "approval")
    expect(card.status).toBe("error")
    expect(card.payload.error).toBe("This run's box is gone.")
    expect(card.payload.decision).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("the deny path round-trips and freezes denied from the gateway's answer", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/workflow/rpc": json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "approval-receipt" } } })
      })
    })
    approvalCard(store)
    controller.decideApproval("approval-1", "denied")
    await settled()
    const card = cardOf(store, "approval-1", "approval")
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("denied")
  })

  test("a failed round trip is a retryable honest error, never a silent freeze", async () => {
    const store = await webStore()
    let attempts = 0
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (!url.includes("/api/workflow/rpc")) return json(404, {})
        attempts += 1
        if (attempts === 1) return json(502, { status: "error", message: "gateway unreachable" })
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "approval-receipt" } } })
      }
    })
    approvalCard(store)
    controller.decideApproval("approval-1", "approved")
    await settled()
    let card = cardOf(store, "approval-1", "approval")
    expect(card.status).toBe("error")
    expect(card.payload.error).toBe("gateway unreachable")
    expect(card.payload.pending).toBe(false)
    expect(card.payload.decision).toBeUndefined()
    // Retry from the error state succeeds.
    controller.decideApproval("approval-1", "approved")
    await settled()
    card = cardOf(store, "approval-1", "approval")
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
  })

  for (const [name, receipt] of [
    ["conflicting idempotency key", { _tag: "Conflict", message: "That key names another decision" }],
    ["terminal without a recorded decision", { _tag: "Terminal", runId: "run_01", status: "completed" }],
    ["receipt for a different run", { _tag: "Accepted", receiptId: "a", runId: "other-run" }],
    ["malformed accepted receipt", { _tag: "Accepted" }],
    ["an unrelated success receipt", { _tag: "Parked", runId: "run_01" }],
  ] as const) {
    test(`${name} cannot freeze an approval as decided`, async () => {
      const store = await webStore()
      const controller = createAppController(store, silentAgent, backend({
        "/api/workflow/rpc": async (request) => {
          const body = await request.json() as { procedure: string }
          return json(200, { ok: true, payload: body.procedure === "Approval.Submit" ? { decision: receipt } : { rows: [] } })
        }
      }))
      approvalCard(store)
      controller.decideApproval("approval-1", "approved")
      await settled()
      const card = cardOf(store, "approval-1", "approval")
      expect(card.status).toBe("error")
      expect(card.payload.decision).toBeUndefined()
      expect(card.payload.pending).toBe(false)
      expect([...store.collections.transitions.values()].some((event) => event.type === "card.approval.decision.failed" && event.actor === "system")).toBe(true)
    })
  }

  test("a terminal receipt reconciles the actual opposite decision made by another client", async () => {
    const store = await webStore()
    const trusted = approvalCard(store) as Extract<Card, { kind: "approval" }>
    const controller = createAppController(store, silentAgent, backend({
      "/api/workflow/rpc": async (request) => {
        const body = await request.json() as { procedure: string }
        return json(200, { ok: true, payload: body.procedure === "Approval.Submit"
          ? { decision: { _tag: "Terminal", runId: "run_01", status: "completed" } }
          : { rows: [{ runId: "run_01", requestId: "approve", title: "Deploy it?", request: {},
            payload: { ...trusted.payload.approval, target: { ...trusted.payload.approval!.target as object,
              envelope: { capabilities: [], flows: [], budget: {} } } }, requestedAt: 1, status: "denied" }] } })
      }
    }))
    controller.decideApproval("approval-1", "approved")
    await settled()
    const card = cardOf(store, "approval-1", "approval")
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("denied")
    expect(card.payload.decidedAt).toBeUndefined()
    expect([...store.collections.transitions.values()].filter((event) => event.type === "gateway.approvals.observed").map((event) => event.actor)).toEqual(["system"])
  })

  test("an idempotent receipt settles the same human decision without another resume request", async () => {
    const store = await webStore()
    const calls: string[] = []
    const controller = createAppController(store, silentAgent, backend({
      "/api/workflow/rpc": async (request) => {
        const body = await request.json() as { procedure: string }
        calls.push(body.procedure)
        return json(200, { ok: true, payload: { decision: { _tag: "AlreadyApplied", receiptId: "a", runId: "run_01" } } })
      }
    }))
    approvalCard(store)
    controller.decideApproval("approval-1", "denied")
    await settled()
    expect(cardOf(store, "approval-1", "approval").payload.decision).toBe("denied")
    expect(calls).toEqual(["Approval.Submit"])
  })

  test("a card with no run identity cannot be fake-decided", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, backend({}))
    store.dispatch({
      type: "card.upsert",
      actor: "system",
      card: {
        id: "approval-local",
        kind: "approval",
        title: "Local only",
        status: "active",
        createdAt: Date.now(),
        ordinal: 900,
        payload: { capability: "a demo card" }
      }
    })
    controller.decideApproval("approval-local", "approved")
    const card = cardOf(store, "approval-local", "approval")
    expect(card.status).toBe("error")
    expect(card.payload.error).toContain("not linked to a run")
    expect(card.payload.decision).toBeUndefined()
  })
})

describe("turn cost + stop discipline", () => {
  const streamingAgent = (
    emit: (runId: string, push: (frame: AgentTurnFrame) => void) => void
  ): { agent: AgentPort; cancelled: string[] } => {
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    const cancelled: string[] = []
    return {
      cancelled,
      agent: {
        available: true,
        startTurn: async (request) => {
          queueMicrotask(() => emit(request.runId, (frame) => listeners.forEach((l) => l(frame))))
          return { status: "started" }
        },
        cancelTurn: async (runId) => {
          cancelled.push(runId)
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  }

  test("a completed turn carries NO per-turn dollar line — chat is complimentary", async () => {
    const store = await webStore()
    let usageReads = 0
    const { agent } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "Done." })
      push({ runId, type: "done" })
    })
    const controller = createAppController(store, agent, {
      ...backend({
        "/api/billing/balance": json(200, balanceBody("499.94625", 1)),
        "/api/billing/usage": () => {
          usageReads += 1
          return json(200, { runId: "x", charges: [{ chargeId: "c1" }], totalUsd: "0.05375" })
        }
      })
    })
    controller.send("hello")
    await settled()
    await settled()
    const response = [...store.collections.messages.values()].find((m) => m.text === "Done.")
    // The true cost is recorded by the billing seam (zero debited); the UI
    // never states a per-turn dollar line and never asks for one.
    expect("costUsd" in (response ?? {})).toBe(false)
    expect(usageReads).toBe(0)
    // The balance chip still refreshes from the real answer after the turn.
    expect(store.collections.billingAccounts.get("billing")?.totalUsd).toBe("499.94625")
  })

  test("a turn that dies server-side mid-stream surfaces as an honest failure", async () => {
    const store = await webStore()
    const { agent } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "partial" })
      push({
        runId,
        type: "done",
        error: "The response stream ended before Smithers finished the turn."
      })
    })
    const controller = createAppController(store, agent, backend({}))
    controller.send("hello")
    await settled()
    const response = [...store.collections.messages.values()].find((m) => m.text === "partial")
    expect(response?.status).toBe("failed")
    expect(response?.statusDetail).toContain("stream ended")
    expect(store.session().phase).toBe("idle")
  })

  test("a server-side kill surfaces as an interrupted turn with the honest line", async () => {
    const store = await webStore()
    const { agent } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "partial work" })
      // The Worker's terminal frame for a kill through /api/agent/turn/cancel.
      push({ runId, type: "done", reason: "cancelled" })
    })
    const controller = createAppController(store, agent, backend({}))
    controller.send("hello")
    await settled()
    const response = [...store.collections.messages.values()].find((m) => m.text === "partial work")
    expect(response?.status).toBe("interrupted")
    expect(response?.statusDetail).toBe("That turn was stopped by the server.")
    expect(store.session().phase).toBe("idle")
  })

  test("a kill landing before the first delta still describes the turn, never silence", async () => {
    const store = await webStore()
    const { agent } = streamingAgent((runId, push) => {
      // No delta at all: the kill beat the model's first token.
      push({ runId, type: "done", reason: "cancelled" })
    })
    const controller = createAppController(store, agent, backend({}))
    controller.send("hello")
    await settled()
    const response = [...store.collections.messages.values()].find(
      (m) => m.text === "That turn was stopped by the server."
    )
    expect(response?.role).toBe("smithers")
    expect(response?.status).toBe("interrupted")
    expect(store.session().phase).toBe("idle")
  })

  test("stop cancels the endpoint and says what it stopped, keeping the partial text", async () => {
    const store = await webStore()
    const { agent, cancelled } = streamingAgent((runId, push) => {
      push({ runId, type: "delta", kind: "text", text: "working on it" })
    })
    const controller = createAppController(store, agent, backend({}))
    controller.send("hello")
    await settled()
    controller.stop()
    expect(cancelled).toHaveLength(1)
    const response = [...store.collections.messages.values()].find((m) => m.text === "working on it")
    expect(response?.status).toBe("interrupted")
    expect(response?.statusDetail).toBe("Stopped the current response.")
    expect(store.session().phase).toBe("idle")
  })
})

for (const state of ["signed-in", "signed-out", "degraded"] as const) {
  test(`selected user identity mirrors Cloud without a cloud-auth session read: ${state}`, async () => {
    const store = await webStore()
    const requests: string[] = []
    let signedOut = state === "signed-out"
    const controller = createAppController(store, silentAgent, {
      bootstrap: {
        apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null,
        capabilities: cloudCapabilities({ identity: true, cloud: true, agent: false, checkout: false, terminal: true })
      },
      fetchImpl: async input => {
        const path = new URL(String(input), "https://web.test").pathname
        requests.push(path)
        if (path === "/api/user") return signedOut
          ? json(401, { code: "unauthenticated" })
          : json(200, { id: 1, username: "will", is_admin: false, ...(state === "degraded" ? { token_scopes: [] } : {}) })
        if (path === "/api/auth/scopes") return json(200, { scopes: [] })
        if (path === CLOUD_AUTH_SESSION_PATH) return json(200, {
          state: signedOut ? "signed-out" : "signed-in", username: signedOut ? null : "will", expiresAt: null,
          ...(!signedOut && state === "degraded" ? { scopes: "degraded" } : {})
        })
        return json(200, [])
      }
    })
    await controller.loadSession()
    expect(requests).toContain("/api/user")
    expect(requests).not.toContain(CLOUD_AUTH_SESSION_PATH)
    expect(store.collections.cloudSessions.get("cloud")).toMatchObject({
      state: signedOut ? "signed-out" : "signed-in", username: signedOut ? null : "will",
      scopes: state === "degraded" ? "degraded" : null
    })
    signedOut = true
    await controller.loadSession()
    expect(store.collections.cloudSessions.get("cloud")).toMatchObject({ state: "signed-out", username: null, scopes: null })
  })
}
