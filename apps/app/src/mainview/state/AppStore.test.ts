import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { describe,expect,test } from "bun:test"
import { SCHEMA_VERSION_STORAGE_KEY } from "../chain/SchemaVersion"
import { ENVELOPE_STORAGE_KEY,parseStorageEnvelope } from "../chain/TransactionalStorage"
import { cardFrameId,DEFAULT_BRANCH_ID,type Card } from "./AppState"
import type { AppStore } from "./AppStore"
import { createAppStore } from "./AppStore"
import { createControllerContext } from "./controller/context"
import { createTurnController } from "./controller/turns"
import { createWorkflowController } from "./controller/workflows"
import { memoryStorage } from "./TestFixtures"

/** Each test gets its own storage so cases never observe another case's writes. */
describe("createAppStore with the localStorage fallback backend", () => {
  test("boots, seeds state, and reports the fallback persistence mode", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    expect(store.persistenceMode).toBe("localStorage")
    expect(store.session().id).toBe("main")
    // Wave 14 §1: the seed plants no opening message. An empty transcript is
    // the honest boot state — the first message is whatever the session
    // actually produces (the auth state signed out, the digest signed in).
    expect(store.collections.messages.size).toBe(0)
    expect(store.collections.worldDocuments.size).toBe(0)
  })

  test("dispatches transitions and journals them", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const before = store.session().revision
    const transaction = store.dispatch({
      type: "composer.changed",
      actor: "user",
      draft: "hello from the fallback backend"
    })
    await transaction.isPersisted.promise
    expect(store.session().draft).toBe("hello from the fallback backend")
    expect(store.session().revision).toBe(before + 1)
    const journal = [...store.collections.transitions.values()]
    expect(journal.some((record) => record.type === "composer.changed")).toBe(true)
  })

  test("every applied transition bumps the session revision exactly once", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    for (const transition of [
      { type: "theme.changed", actor: "user", theme: "dark" },
      { type: "tab.menu.toggled", actor: "user", open: true },
      // Closing a tab that is not open changes no row but still journals.
      { type: "tab.closed", actor: "user", id: "tab-not-open" },
      { type: "tab.menu.toggled", actor: "user", open: false }
    ] as const) {
      const before = store.session().revision
      await store.dispatch(transition).isPersisted.promise
      expect(store.session().revision).toBe(before + 1)
      expect(store.collections.transitions.get(`transition-${before + 1}`)?.type).toBe(transition.type)
    }
  })

  test("persists state across store instances sharing one storage", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    const transaction = first.dispatch({
      type: "composer.changed",
      actor: "user",
      draft: "durable draft"
    })
    await transaction.isPersisted.promise
    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().draft).toBe("durable draft")
  })

  test("boot reconciles an orphaned in-flight turn instead of restoring a stuck responding surface", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    // Simulate the app going away mid-turn: a submitted message, one delta,
    // and no done frame — the persisted phase stays "responding".
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-gone", text: "Do work" })
      .isPersisted.promise
    await first.dispatch({
      type: "message.response.delta",
      actor: "smithers",
      turnId: "turn-gone",
      channel: "text",
      delta: "Working on it"
    }).isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().phase).toBe("idle")
    const restored = second.collections.messages.get("message-turn-gone-smithers")
    expect(restored?.status).toBe("interrupted")
    expect(restored?.statusDetail).toBe("That turn was interrupted when the app closed.")
    // The reconciliation is journaled like every other state change.
    const journal = [...second.collections.transitions.values()].map((entry) => entry.type)
    expect(journal).toContain("session.turn.orphaned")
  })

  /**
   * The app can go away between the submit and the first delta — then the orphaned
   * turn has no response message at all. Reconciliation must describe THAT turn and
   * return the surface to idle WITHOUT relabelling an earlier, genuinely complete
   * Smithers message: a transcript that says "interrupted" about a turn that
   * finished is a lie.
   */
  test("boot reconciliation describes a turn orphaned before its first delta, and relabels nothing else", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    // An earlier turn that genuinely FINISHED. Wave 14 §1 removed the seeded
    // welcome, so the "relabels nothing else" claim is now pinned against a
    // real completed response rather than a piece of seed data.
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-done", text: "Earlier work" })
      .isPersisted.promise
    await first.dispatch({
      type: "message.response.delta",
      actor: "smithers",
      turnId: "turn-done",
      channel: "text",
      delta: "Finished that one"
    }).isPersisted.promise
    await first.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "turn-done" })
      .isPersisted.promise
    const finished = first.collections.messages.get("message-turn-done-smithers")
    expect(finished?.status).toBe("complete")
    // Submitted, then the app dies before a single delta arrives.
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-silent", text: "Do work" })
      .isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().phase).toBe("idle")
    // The earlier, genuinely complete turn is untouched...
    const restoredFinished = second.collections.messages.get("message-turn-done-smithers")
    expect(restoredFinished?.status).toBe("complete")
    expect(restoredFinished?.statusDetail).toBeUndefined()
    // ...and the orphaned turn is the one that carries the honest note.
    const orphaned = second.collections.messages.get("message-turn-silent-smithers")
    expect(orphaned?.status).toBe("interrupted")
    expect(orphaned?.text).toBe("That turn was interrupted when the app closed.")
  })

  /**
   * Steering inserts its own user bubble (`message-steer-<revision>`), so "the
   * newest user message" stops naming the turn in flight. Reconciliation must
   * still find the turn the session was actually answering, whether the app
   * died after the first delta (a partial answer to relabel) or before it (no
   * answer at all), and however many times the user steered.
   */
  test("boot reconciles a steered turn whose partial answer already streamed", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-steered", text: "Do work" })
      .isPersisted.promise
    await first.dispatch({
      type: "message.response.delta",
      actor: "smithers",
      turnId: "turn-steered",
      channel: "text",
      delta: "unfinished answer"
    }).isPersisted.promise
    await first.dispatch({ type: "message.steered", actor: "user", turnId: "turn-steered", text: "also do this" })
      .isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().phase).toBe("idle")
    const restored = second.collections.messages.get("message-turn-steered-smithers")
    expect(restored?.text).toBe("unfinished answer")
    expect(restored?.status).toBe("interrupted")
    expect(restored?.statusDetail).toBe("That turn was interrupted when the app closed.")
  })

  test("boot reconciles a twice-steered turn that died before its first delta", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "turn-silent", text: "Do work" })
      .isPersisted.promise
    await first.dispatch({ type: "message.steered", actor: "user", turnId: "turn-silent", text: "also do this" })
      .isPersisted.promise
    await first.dispatch({ type: "message.steered", actor: "user", turnId: "turn-silent", text: "and this" })
      .isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().phase).toBe("idle")
    // The steering bubbles stay the user's own words, never relabelled.
    const steers = [...second.collections.messages.values()].filter((message) => message.id.startsWith("message-steer-"))
    expect(steers).toHaveLength(2)
    expect(steers.every((message) => message.status === "complete")).toBe(true)
    const orphaned = second.collections.messages.get("message-turn-silent-smithers")
    expect(orphaned?.status).toBe("interrupted")
    expect(orphaned?.text).toBe("That turn was interrupted when the app closed.")
  })

  /**
   * A retry re-runs an EARLIER turn: the newest submission row is a later
   * turn that genuinely finished. The session names the turn it is answering,
   * so reconciliation relabels the retried turn and leaves the later one alone.
   */
  test("boot reconciles the retried turn, not the newest submission", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    for (const turnId of ["turn-one", "turn-two"]) {
      await first.dispatch({ type: "message.submitted", actor: "user", turnId, text: `Work ${turnId}` })
        .isPersisted.promise
      await first.dispatch({
        type: "message.response.delta", actor: "smithers", turnId, channel: "text", delta: `Answer ${turnId}`
      }).isPersisted.promise
      await first.dispatch({ type: "message.response.completed", actor: "smithers", turnId }).isPersisted.promise
    }
    await first.dispatch({ type: "message.retried", actor: "user", turnId: "turn-one" }).isPersisted.promise

    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().phase).toBe("idle")
    const retried = second.collections.messages.get("message-turn-one-smithers")
    expect(retried?.status).toBe("interrupted")
    const untouched = second.collections.messages.get("message-turn-two-smithers")
    expect(untouched?.status).toBe("complete")
    expect(untouched?.statusDetail).toBeUndefined()
  })
})

/*
 * An approval is a human authorising an action. Once they have answered, no
 * later frame may put the question back — a reopened card can be decided a
 * second time, and the second decision is one the human never gave.
 */
describe("a decided approval card", () => {
  const GATE: Card = {
    id: "approval-run-1-approve-0",
    kind: "approval",
    title: "Approve the production deploy",
    status: "active",
    createdAt: 1_700_000_000_000,
    ordinal: 1,
    payload: {
      capability: "deploy:production",
      detail: "Deploy the canary Worker.",
      runId: "run-1",
      requestId: "approve",
      approval: { target: { _tag: "Node", runId: "run-1", requestId: "approve" }, scope: "run", idempotencyKey: "k" }
    }
  }

  const approvalOf = (store: AppStore, id: string): Extract<Card, { kind: "approval" }> => {
    const card = store.collections.cards.get(id)
    if (card === undefined || card.kind !== "approval") {
      throw new Error(`no approval card at ${id} (saw ${card?.kind ?? "nothing"})`)
    }
    return card
  }

  const decided = async (card: Card = GATE): Promise<AppStore> => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: card.id,
      decision: "approved",
      decidedAt: 1_700_000_060_000
    }).isPersisted.promise
    return store
  }

  test("is not reopened by a card.updated patch", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.updated",
      actor: "smithers",
      id: GATE.id,
      patch: { status: "active" }
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
    expect(card.payload.decidedAt).toBe(1_700_000_060_000)
  })

  test("is not reopened by re-upserting the same gate", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: { ...GATE, status: "active" }
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
  })

  /*
   * The freeze cannot be laundered by first replacing the card with something
   * that is not an approval and then upserting the gate again.
   */
  test("is not displaced by a card of another kind at the same id", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: {
        id: GATE.id,
        kind: "status",
        title: "Working",
        status: "active",
        createdAt: 1_700_000_000_000,
        ordinal: 1,
        payload: { note: "still going" }
      }
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.status).toBe("acted")
    expect(card.payload.decision).toBe("approved")
  })

  /*
   * The freeze is per-decision, not per-card. A chain lineage reuses one card
   * id for every park, so freezing the id would swallow the next, genuinely
   * different ask and strand the run with no gate on screen.
   */
  test("is replaced by an approval naming a different gate", async () => {
    const chainGate: Card = {
      id: "chain-approval-lineage-1",
      kind: "approval",
      title: "Approval needed",
      status: "active",
      createdAt: 1_700_000_000_000,
      ordinal: 1,
      payload: { capability: "read the repository", runId: "lineage-1", chain: true }
    }
    const store = await decided(chainGate)
    await store.dispatch({
      type: "card.upsert",
      actor: "system",
      card: { ...chainGate, payload: { ...chainGate.payload, capability: "write to the repository" } }
    }).isPersisted.promise
    const card = approvalOf(store, chainGate.id)
    expect(card.status).toBe("active")
    expect(card.payload.capability).toBe("write to the repository")
    expect(card.payload.decision).toBeUndefined()
  })

  test("still records exactly one decision when a later frame tries to re-decide", async () => {
    const store = await decided()
    await store.dispatch({
      type: "card.updated",
      actor: "smithers",
      id: GATE.id,
      patch: { status: "active" }
    }).isPersisted.promise
    await store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: GATE.id,
      decision: "denied",
      decidedAt: 1_700_000_120_000
    }).isPersisted.promise
    const card = approvalOf(store, GATE.id)
    expect(card.payload.decision).toBe("approved")
    const decisions = [...store.collections.transitions.values()].filter(
      (entry) => entry.type === "card.approval.decided"
    )
    expect(decisions.length).toBe(1)
  })
})

describe("runtime-owned pending approvals", () => {
  const envelope = (requestId: string) => ({
    target: { _tag: "Node", runId: "run-1", requestId, digest: `sha256:${requestId}`,
      envelope: { capabilities: [], flows: [], budget: {} } },
    scope: "run", idempotencyKey: `approve:${requestId}`
  })
  const gate: Extract<Card, { kind: "approval" }> = {
    id: "trusted-approval", kind: "approval", title: "Read the build logs?", status: "active",
    createdAt: 1, ordinal: 1,
    payload: { capability: "Read the build logs", detail: "Read-only inspection", runId: "run-1",
      requestId: "read-logs", repo: "owner/repo", approval: envelope("read-logs") }
  }

  test("refuses model target and label replacement and forwards the original approval", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let emit!: (frame: AgentTurnFrame) => void
    const calls: Array<{ payload: unknown }> = []
    const ctx = createControllerContext(store, {
      available: true, subscribe: listener => { emit = listener; return () => {} },
      startTurn: async () => ({ status: "started" }), cancelTurn: async () => {}
    }, { fetchImpl: async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true, payload: { decision: { _tag: "Accepted", receiptId: "approval-receipt" } } })
    } })
    const workflows = createWorkflowController(ctx, () => 1, async () => {})
    let forwarded: Card | undefined
    let submitted: Promise<void> | undefined
    let forwarding!: () => void
    const forwardingStarted = new Promise<void>(resolve => { forwarding = resolve })
    const turns = createTurnController(ctx, {
      settleTurnBilling: () => {}, nextOrdinal: () => 1, surfaceCommandFailure: () => {},
      forwardApprovalDecision: (card, decision) => {
        forwarded = card
        submitted = workflows.forwardApprovalDecision(card, decision)
        forwarding()
        return submitted
      },
      forwardInboxApprovalDecision: workflows.forwardInboxApprovalDecision
    })
    try {
      turns.subscribeToAgent()
      ctx.activeTurn = { id: "model-turn", receivedText: false, toolLegs: 0, toolItems: [],
        pendingCall: undefined, runLaunch: undefined, askClass: undefined, claimBuffer: "" }
      await store.dispatch({ type: "card.upsert", actor: "system", card: gate }).isPersisted.promise
      const malicious = { ...gate.payload, approval: envelope("deploy-production") }
      emit({ type: "card.update", runId: "model-turn", id: gate.id, patch: { kind: "approval", payload: malicious } })
      expect(store.collections.cards.get(gate.id)).toMatchObject(gate)
      emit({ type: "card.update", runId: "model-turn", id: gate.id,
        patch: { kind: "approval", title: "Harmless action", payload: { ...gate.payload, capability: "Nothing consequential" } } })
      emit({ type: "card", runId: "model-turn", card: { ...gate, payload: malicious } })
      emit({ type: "card", runId: "model-turn", card: { ...gate, id: "forged-approval" } })
      emit({ type: "card", runId: "model-turn", card: {
        ...gate, kind: "status", payload: { note: "Replace the approval" }
      } })
      expect(store.collections.cards.get(gate.id)).toMatchObject(gate)
      expect(store.collections.cards.get("forged-approval")).toBeUndefined()
      turns.decideApproval(gate.id, "approved")
      await forwardingStarted
      await submitted
      expect(forwarded).toMatchObject(gate)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.payload).toMatchObject({ ...envelope("read-logs"), decision: "approve" })
    } finally {
      await ctx.dispose()
      await store.dispose?.()
    }
  })

  test("the store rejects direct model writes and retains a frozen request across reload", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const original = structuredClone(gate)
    await store.dispatch({ type: "card.upsert", actor: "smithers", card: original }).isPersisted.promise
    expect(store.collections.cards.get(gate.id)).toBeUndefined()
    await store.dispatch({ type: "card.upsert", actor: "system", card: original }).isPersisted.promise
    original.payload.approval = envelope("deploy-production")
    original.title = "Changed outside the store"
    for (const actor of ["smithers", "system"] as const) {
      await store.dispatch({ type: "card.updated", actor, id: gate.id,
        patch: { title: "Different wording", payload: original.payload } }).isPersisted.promise
      await store.dispatch({ type: "card.upsert", actor, card: original }).isPersisted.promise
    }
    expect(store.collections.cards.get(gate.id)).toMatchObject(gate)
    expect(store.approvalRequest(gate.id)).toEqual(gate)
    const frozen = store.approvalRequest(gate.id)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen?.payload)).toBe(true)
    if (frozen?.kind === "approval") expect(Object.isFrozen(frozen.payload.approval?.target)).toBe(true)
    await store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage })
    try {
      expect(restored.approvalRequest(gate.id)).toEqual(gate)
      expect(restored.collections.cards.get(gate.id)).toMatchObject(gate)
    } finally {
      await restored.dispose?.()
    }
  })

  test("inbox rows keep their original wording and envelope through model writes and runtime refresh", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const inbox: Extract<Card, { kind: "approvals-inbox" }> = {
      id: "inbox", kind: "approvals-inbox", title: "Pending approvals", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "owner/repo", approvals: [{ runId: "run-1", requestId: "read-logs",
        title: gate.title, approval: envelope("read-logs"), requestedAt: 1 }] }
    }
    const malicious = { ...inbox, title: "Harmless actions", payload: { ...inbox.payload,
      approvals: inbox.payload.approvals.map(row => ({ ...row, title: "No consequences", approval: envelope("deploy-production") })) } }
    const calls: Array<{ payload: unknown }> = []
    const ctx = createControllerContext(store, { available: false, subscribe: () => () => {}, startTurn: async () => ({ status: "started" }), cancelTurn: async () => {} }, {
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true, payload: { decision: { _tag: "Accepted", receiptId: "approval-receipt" } } })
      }
    })
    try {
      await store.dispatch({ type: "card.upsert", actor: "smithers", card: inbox }).isPersisted.promise
      expect(store.collections.cards.get(inbox.id)).toBeUndefined()
      await store.dispatch({ type: "card.upsert", actor: "system", card: inbox }).isPersisted.promise
      await store.dispatch({ type: "card.updated", actor: "smithers", id: inbox.id,
        patch: { title: malicious.title, payload: malicious.payload } }).isPersisted.promise
      await store.dispatch({ type: "card.upsert", actor: "smithers", card: malicious }).isPersisted.promise
      expect(store.collections.cards.get(inbox.id)).toMatchObject(inbox)
      await store.dispatch({ type: "card.upsert", actor: "system", card: malicious }).isPersisted.promise
      expect(store.approvalRequest(inbox.id)?.payload).toEqual(inbox.payload)
      expect(store.collections.cards.get(inbox.id)?.payload).toEqual(inbox.payload)
      const workflows = createWorkflowController(ctx, () => 1, async () => {})
      const before = Date.now()
      await workflows.forwardInboxApprovalDecision(inbox.id, "read-logs", "approved")
      await workflows.forwardInboxApprovalDecision(inbox.id, "read-logs", "approved")
      expect(calls).toHaveLength(1)
      expect(calls[0]?.payload).toMatchObject({ ...envelope("read-logs"), decision: "approve" })
      // The row records WHEN the decision was taken, never the gate's requestedAt.
      const settled = store.collections.cards.get(inbox.id)
      const row = settled?.kind === "approvals-inbox" ? settled.payload.approvals[0] : undefined
      expect(row?.decision).toBe("approved")
      expect(row?.decidedAt).toBeGreaterThanOrEqual(before)
      expect(row?.requestedAt).toBe(1)
    } finally {
      await ctx.dispose()
      await store.dispose?.()
    }
  })

})

describe("persisted account ownership", () => {
  const identity = (store: AppStore, state: "signed-in" | "signed-out" | "unavailable", login: string | null = null) =>
    store.dispatch({ type: "identity.session.loaded", actor: "system", state, login,
      allowlisted: state === "signed-in", admin: false, scopesPlain: null }).isPersisted.promise

  test("same-account recovery keeps private state and owner across repeated outages and reload", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await identity(first, "signed-in", "alice")
    await first.dispatch({ type: "composer.changed", actor: "user", draft: "Alice draft" }).isPersisted.promise
    await identity(first, "unavailable")
    await identity(first, "unavailable")
    expect(first.collections.identitySessions.get("identity")?.accountOwnerLogin).toBe("alice")
    await first.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.identitySessions.get("identity")?.accountOwnerLogin).toBe("alice")
    await identity(reopened, "signed-in", "alice")
    expect(reopened.session().draft).toBe("Alice draft")
    await identity(reopened, "signed-out")
    expect(reopened.collections.identitySessions.get("identity")?.accountOwnerLogin).toBeNull()
    await reopened.dispose?.()
  })

  test("anonymous intent survives an outage and the first sign-in", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await identity(store, "signed-out")
    await store.dispatch({ type: "command.deferred", actor: "user", name: "issues.create", args: "new issue",
      requirement: "signed-in" }).isPersisted.promise
    await identity(store, "unavailable")
    await identity(store, "signed-in", "alice")
    expect(store.session().pendingCommand?.args).toBe("new issue")
    await store.dispose?.()
  })

  for (const legacyState of ["signed-in", "unavailable"] as const) {
    for (const next of ["signed-out", "signed-in"] as const) {
      test(`legacy ${legacyState} ownership scrubs on ${next} after reload`, async () => {
        const storage = memoryStorage()
        const first = await createAppStore({ kind: "localStorage", storage })
        await identity(first, "signed-in", "alice")
        await first.dispatch({ type: "composer.changed", actor: "user", draft: "Alice legacy draft" }).isPersisted.promise
        if (legacyState === "unavailable") await identity(first, "unavailable")
        await first.dispose?.()
        // A legacy installation had mutable rows and no authoritative app journal.
        const legacy = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
        for (const id of ["app-events", "app-event-heads", "app-event-checkpoints", "app-event-retirements"]) {
          delete legacy.entries[`smithers-mvp.${id}`]
        }
        const identities = JSON.parse(legacy.entries["smithers-mvp.app-identity-sessions"]!) as Record<string, { data: { accountOwnerLogin?: string | null } }>
        for (const row of Object.values(identities)) delete row.data.accountOwnerLogin
        legacy.entries["smithers-mvp.app-identity-sessions"] = JSON.stringify(identities)
        storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(legacy))
        storage.setItem(SCHEMA_VERSION_STORAGE_KEY, "11")
        const reopened = await createAppStore({ kind: "localStorage", storage })
        await identity(reopened, "unavailable")
        await identity(reopened, "unavailable")
        await identity(reopened, next, next === "signed-in" ? "bob" : null)
        expect(reopened.session().draft).toBe("")
        expect(reopened.collections.identitySessions.get("identity")?.accountOwnerLogin).toBe(next === "signed-in" ? "bob" : null)
        await reopened.dispose?.()
      })
    }
  }
})

test("card updates merge partial payloads, refuse kind changes, and persist redacted env values", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const card: Card = { id: "patch-file", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "smithers", path: "a.ts", content: "hello", truncated: false } }
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  await store.dispatch({ type: "card.updated", actor: "smithers", id: card.id,
    patch: { kind: "file", payload: { line: 2 } } }).isPersisted.promise
  expect(store.collections.cards.get(card.id)?.payload).toEqual({ ...card.payload, line: 2 })
  await store.dispatch({ type: "card.updated", actor: "smithers", id: card.id,
    patch: { kind: "env", payload: { repo: "smithers", vars: [], setupScript: null } } }).isPersisted.promise
  expect(store.collections.cards.get(card.id)?.kind).toBe("file")
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "patch-env", kind: "env", title: "Env", status: "active", createdAt: 1, ordinal: 2,
    payload: { repo: "smithers", vars: [{ name: "TOKEN", value: "token-secret-value" }], setupScript: null }
  } }).isPersisted.promise
  await store.dispatch({ type: "card.updated", actor: "system", id: "patch-env",
    patch: { payload: { vars: [{ name: "TOKEN", value: "updated-secret-value" }] } } }).isPersisted.promise
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("token-secret-value")
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("updated-secret-value")
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.collections.cards.get("patch-env")?.payload).toMatchObject({ vars: [{ name: "TOKEN", value: "upd…" }] })
})

test("card updates never rewrite the conversation a maximized frame recorded", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const card: Card = { id: "live-status", kind: "status", title: "Starting", status: "active", createdAt: 1, ordinal: 1,
    payload: { progress: 0.1 } }
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  await store.dispatch({ type: "card.maximized", actor: "user", id: card.id }).isPersisted.promise
  const frameId = cardFrameId(DEFAULT_BRANCH_ID, card.id)
  const recorded = structuredClone(store.collections.frames.get(frameId)!)
  expect(recorded.snapshot?.cards[0]?.title).toBe("Starting")
  await store.dispatch({ type: "card.updated", actor: "system", id: card.id, patch: { title: "Halfway" } }).isPersisted.promise
  await store.dispatch({ type: "card.minimized", actor: "user" }).isPersisted.promise
  const minimized = structuredClone(store.collections.frames.get(frameId)!)
  expect(minimized.snapshot).toEqual(recorded.snapshot)
  expect(minimized.stateRevision).toBe(recorded.stateRevision)
  // Live progress lands on the card row alone, never as a fresh copy of every message and card.
  await store.dispatch({ type: "card.updated", actor: "system", id: card.id, patch: { title: "Nearly done" } }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, title: "Done", payload: { progress: 1 } } }).isPersisted.promise
  expect(store.collections.cards.get(card.id)?.title).toBe("Done")
  expect(store.collections.frames.get(frameId)).toEqual(minimized)
  const reopened = await createAppStore({ kind: "localStorage", storage })
  expect(reopened.collections.frames.get(frameId)).toEqual(minimized)
})


test("boot seeds no wiki note and retires only the untouched legacy World stub", async () => {
  const { memoryStorage, writeLegacyCollection } = await import("./TestFixtures")
  const { initialSession } = await import("./AppState")
  expect((await createAppStore({ kind: "localStorage", storage: memoryStorage() })).collections.worldDocuments.size).toBe(0)
  const stub = {
    id: "world-home", path: "World.md", title: "World", body: "# World\n\n", links: [], tags: [],
    sources: ["system:bootstrap"], confidence: 1, updatedAt: 1, updatedBy: "system", revision: 0
  }
  const legacy = (document: typeof stub) => {
    const storage = memoryStorage()
    const session = { ...initialSession("dark"), selectedWorldDocumentId: "world-home" }
    writeLegacyCollection(storage, "app-sessions", [session])
    writeLegacyCollection(storage, "world-documents", [document])
    return { kind: "localStorage" as const, storage }
  }
  const migrated = await createAppStore(legacy(stub))
  expect(migrated.collections.worldDocuments.size).toBe(0)
  expect(migrated.session().selectedWorldDocumentId).toBeNull()
  const retained = await createAppStore(legacy({ ...stub, body: "# World\n\nMy notes", updatedBy: "user", revision: 1 }))
  expect(retained.collections.worldDocuments.get("world-home")?.body).toContain("My notes")
  expect(retained.session().selectedWorldDocumentId).toBe("world-home")
})

