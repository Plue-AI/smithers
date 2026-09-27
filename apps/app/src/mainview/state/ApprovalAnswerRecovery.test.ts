import { createCommandIntentLifecycle } from "./controller/commandIntents"
import { createControllerContext } from "./controller/context"
import { silentAgent } from "./TestFixtures"
import { SCHEMA_VERSION_STORAGE_KEY } from "../chain/SchemaVersion"
import { STAGED_ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import type { ApprovalRow } from "@smthrs/gateway/GatewayProjection"
import { createAppStore, type AppStore } from "./AppStore"
import { approvalQuestionKey } from "./ApprovalAnswerState"
import { runtimeApprovalKey } from "./RuntimeProjection"
import { ENTITY_RECOVERY_STORAGE_KEY, readEntityRecoveries, writeEntityRecovery } from "./EntityRecovery"
import { ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import { memoryStorage } from "./TestFixtures"

const scope = { repo: "owner/repo", runId: "run" }
const request = (attempt = 1): ApprovalRow => ({
  runId: scope.runId, requestId: "question", status: "pending", requestedAt: attempt, title: "Which service owns retries?",
  waitRunId: `wait-${attempt}`, request: { kind: "ask", prompt: "Which service owns retries?", attempt },
  payload: { target: { _tag: "Node", runId: scope.runId, requestId: "question", digest: "sha256:reviewed",
    envelope: { capabilities: ["private:test"], flows: [], budget: {} } }, scope: "once", idempotencyKey: "private-review-key" }
})
const id = runtimeApprovalKey(scope, "question", "sha256:reviewed")

const withFixture = async (body: (h: {
  store: AppStore; storage: StorageApi; recovery: StorageApi;
  open: () => Promise<AppStore>; input: { id: string; question: string; text: string }
}) => Promise<void>) => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  const recovery = memoryStorage(), storage = memoryStorage(), stores: AppStore[] = []
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
  const open = async () => { const store = await createAppStore({ kind: "localStorage", storage }); stores.push(store); return store }
  try {
    const store = await open()
    await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [request()] }).isPersisted.promise
    await body({ store, storage, recovery, open, input: { id, question: approvalQuestionKey(request())!, text: "The scheduler owns retries." } })
  } finally {
    for (const store of stores) await store.dispose?.()
    if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
  }
}

describe("pending HumanTask answer recovery", () => {
  for (const accepted of [false, true]) test(`a prepared answer survives reopen ${accepted ? "after" : "before"} its command acceptance`, async () => {
    await withFixture(async ({ store, recovery, open, input }) => {
      expect(store.stagePendingApprovalAnswer(input, "answer-edit")).toBeDefined()
      expect(store.collections.runtimeApprovals.get(id)?.answerDraft).toBeUndefined()
      const pending = readEntityRecoveries(recovery)[0]!
      expect(pending.value).toEqual({ kind: "approval-answer", ...input })
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).not.toContain("private-review-key")
      expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).not.toContain("private:test")
      if (accepted) {
        await store.dispatch({ type: "command.intent.accepted", actor: "user", id: "answer-edit", name: "form.set", source: "command" }).isPersisted.promise
        await expect(store.compactEvents()).rejects.toThrow("compaction is deferred")
      }
      await store.dispose?.()
      const reopened = await open()
      expect(reopened.collections.runtimeApprovals.get(id)?.answerDraft).toEqual({ question: input.question, text: input.text })
      expect((await reopened.verifyState()).valid).toBe(true)
      expect(readEntityRecoveries(recovery)).toEqual([])
      await reopened.compactEvents()
      expect((await reopened.verifyState()).valid).toBe(true)
    })
  })

  for (const accepted of [false, true]) test(`the command door synchronously preserves the latest answer in crash bytes ${accepted ? "after" : "before"} acceptance`, async () => {
    await withFixture(async ({ store, storage, recovery, input }) => {
      await store.dispatch({ type: "card.upsert", actor: "system", card: {
        id: "question-card", kind: "approval", status: "active", title: "Question", createdAt: 1, ordinal: 0,
        runtimeView: { version: 1 }, payload: { repo: scope.repo, runId: scope.runId, requestId: "question",
          capability: request().title, approval: request().payload as unknown as Record<string, unknown> }
      } }).isPersisted.promise
      const held = Promise.withResolvers<void>()
      const wrapped = { ...store, dispatch: (transition: Parameters<AppStore["dispatch"]>[0]) => {
        const receipt = store.dispatch(transition)
        return transition.type !== "command.intent.accepted" ? receipt : new Proxy(receipt, { get: (target, property, receiver) =>
          property === "isPersisted" ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) }
            : Reflect.get(target, property, receiver) })
      } }
      const context = createControllerContext(wrapped, silentAgent, {})
      const lifecycle = createCommandIntentLifecycle(context)
      const first = lifecycle.accept({ name: "form.set", actor: "user", source: "command" }, {
        cardId: "question-card", field: `answer:${input.question}`, value: "first keystroke"
      })
      const second = lifecycle.accept({ name: "form.set", actor: "user", source: "command" }, {
        cardId: "question-card", field: `answer:${input.question}`, value: "latest keystroke"
      })
      let restored: AppStore | undefined
      try {
        if (accepted) await store.settled?.()
        const crashed = memoryStorage(), crashedRecovery = memoryStorage()
        // Capture the physical envelope, its stage and schema without waiting
        // for acceptance when this case models an immediate page loss.
        for (const key of [ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY, SCHEMA_VERSION_STORAGE_KEY]) {
          const value = storage.getItem(key)
          if (value !== null) crashed.setItem(key, value)
        }
        const pending = readEntityRecoveries(recovery)
        expect(pending).toHaveLength(1)
        expect(pending[0]?.value).toEqual({ kind: "approval-answer", ...input, text: "latest keystroke" })
        expect(store.collections.runtimeApprovals.get(id)?.answerDraft).toBeUndefined()
        crashedRecovery.setItem(ENTITY_RECOVERY_STORAGE_KEY, recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)!)
        held.resolve()
        const outcomes = await Promise.all([first, second])
        expect(outcomes.every(outcome => "receipt" in outcome)).toBe(true)
        await store.dispose?.()
        Object.defineProperty(window, "localStorage", { configurable: true, value: crashedRecovery })
        restored = await createAppStore({ kind: "localStorage", storage: crashed })
        expect(restored.collections.runtimeApprovals.get(id)?.answerDraft).toEqual({ question: input.question, text: "latest keystroke" })
        expect(readEntityRecoveries(crashedRecovery)).toEqual([])
        expect((await restored.verifyState()).valid).toBe(true)
      } finally { held.resolve(); await Promise.all([first, second]); await restored?.dispose?.() }
    })
  })

  test("an older acknowledgement cannot clear a newer text or explicit empty answer", async () => {
    await withFixture(async ({ store, recovery, open, input }) => {
      const first = store.stagePendingApprovalAnswer(input, "first")!
      store.stagePendingApprovalAnswer({ ...input, text: "" }, "second")
      first.clear()
      expect(readEntityRecoveries(recovery)[0]?.value).toEqual({ kind: "approval-answer", ...input, text: "" })
      await store.dispose?.()
      expect((await open()).collections.runtimeApprovals.get(id)?.answerDraft).toEqual({ question: input.question, text: "" })
    })
  })

  test("a failed durable edit rolls back the projected answer and removes its recovery slot", async () => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "window")
    const recovery = memoryStorage(), durable = memoryStorage()
    let fail = false
    const storage: StorageApi = { ...durable, setItem: (key, value) => {
      if (fail && key === ENVELOPE_STORAGE_KEY) throw new Error("fixture refused commit")
      durable.setItem(key, value)
    } }
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: recovery, matchMedia: () => ({ matches: false }) } })
    let store: AppStore | undefined, reopened: AppStore | undefined
    try {
      store = await createAppStore({ kind: "localStorage", storage })
      await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [request()] }).isPersisted.promise
      fail = true
      const receipt = store.dispatch({ type: "approval.answer.changed", actor: "user", id, question: approvalQuestionKey(request())!, text: "Unsaved answer" })
      await expect(receipt.isPersisted.promise).rejects.toThrow("fixture refused commit")
      expect(readEntityRecoveries(recovery)).toEqual([])
      expect(store.collections.runtimeApprovals.get(id)?.answerDraft).toBeUndefined()
      fail = false
      await store.dispose?.()
      reopened = await createAppStore({ kind: "localStorage", storage })
      expect(reopened.collections.runtimeApprovals.get(id)?.answerDraft).toBeUndefined()
      expect((await reopened.verifyState()).valid).toBe(true)
    } finally {
      fail = false
      await reopened?.dispose?.(); await store?.dispose?.()
      if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window")
    }
  })

  for (const change of ["question", "decision", "branch", "settled-command", "foreign-prefix", "foreign-stream", "account"] as const) {
    test(`${change} prevents a prepared answer from being applied to a different authority on reload`, async () => {
      await withFixture(async ({ store, recovery, open, input }) => {
        store.stagePendingApprovalAnswer(input, "pending-answer")
        const pending = readEntityRecoveries(recovery)[0]!
        if (change === "question") await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [request(2)] }).isPersisted.promise
        if (change === "decision") await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [{ ...request(), status: "approved" }] }).isPersisted.promise
        if (change === "branch") await store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "other-branch", notes: [] }).isPersisted.promise
        if (change === "settled-command") {
          await store.dispatch({ type: "command.intent.accepted", actor: "user", id: "pending-answer", name: "form.set", source: "command" }).isPersisted.promise
          await store.dispatch({ type: "command.intent.settled", actor: "user", id: "pending-answer", outcome: "failed" }).isPersisted.promise
        }
        if (change === "foreign-prefix") writeEntityRecovery(recovery, { ...pending, authority: { ...pending.authority!, baseEventHash: "0".repeat(64) } })
        if (change === "foreign-stream") writeEntityRecovery(recovery, { ...pending, authority: { ...pending.authority!, streamId: "different-stream" } })
        if (change === "account") {
          await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
          expect(recovery.getItem(ENTITY_RECOVERY_STORAGE_KEY)).toBeNull()
          // A copied old slot remains invalid even if restored after erasure.
          writeEntityRecovery(recovery, pending)
        }
        await store.dispose?.()
        const reopened = await open()
        expect(reopened.collections.runtimeApprovals.get(id)?.answerDraft).toBeUndefined()
        expect(readEntityRecoveries(recovery)).toEqual([])
        expect((await reopened.verifyState()).valid).toBe(true)
      })
    })
  }
})
