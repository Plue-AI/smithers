import { Authorize } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { afterEach,describe,expect,test } from "bun:test"
import { Effect,Schema } from "effect"
import type { AgentInvocation } from "../flows/AgentInvocation"
import type { AppController,AppServices } from "./AppController"
import { emptyAppProjection,projectAppEvent,seedAppProjection } from "./AppProjection"
import { createAppStore,type AppStore } from "./AppStore"
import { createCommandIntentLifecycle } from "./controller/commandIntents"
import { createControllerContext } from "./controller/context"
import { scopedControllers } from "./ControllerTestScope"
import { readEntityRecoveries } from "./EntityRecovery"
import { memoryStorage, repositoryHttpFixture, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

const controllers: AppController[] = []
const stores: AppStore[] = []
const releaseGates: Array<() => void> = []
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release()
  for (const controller of controllers.splice(0)) await Promise.resolve(controller.dispose()).catch(() => {})
  for (const store of stores.splice(0)) await Promise.resolve(store.dispose?.()).catch(() => {})
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  releaseGates.push(resolve)
  return { resolve, promise }
}
const open = async (storage: StorageApi = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  stores.push(store)
  return store
}
const controllerFor = (store: AppStore, services: AppServices = {}) => {
  const controller = createAppController(store, silentAgent, services)
  controllers.push(controller)
  return controller
}
const hold = (store: AppStore, type: string, held: ReturnType<typeof deferred>, entered: ReturnType<typeof deferred>): AppStore => ({
  ...store,
  dispatch: transition => {
    const transaction = store.dispatch(transition)
    if (transition.type !== type) return transaction
    entered.resolve()
    return new Proxy(transaction, { get: (target, property, receiver) => property === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) }
      : Reflect.get(target, property, receiver) })
  }
})
const invocation = (lineage = "lineage", ordinal = 1): AgentInvocation => ({
  lineage, slot: { chain: "chain", link: 1, ordinal },
  authorize: Authorize.make({ authorize: () => Effect.void }), refused: () => {}
})

describe("durable command intent at the active shared door", () => {
  for (const line of ["/theme paper", "/missing-command", "the original prompt"]) {
    for (const next of [line, "a different next draft"]) {
      test(`a delayed submission of ${line} preserves a newly entered draft: ${next}`, async () => {
        const store = await open()
        const held = deferred(), entered = deferred()
        const controller = controllerFor(hold(store, "command.intent.accepted", held, entered))
        controller.changeDraft(line)
        const pending = controller.commands.run("chat.send", line)
        await entered.promise
        controller.changeDraft("")
        controller.changeDraft(next)
        expect(store.session().draft).toBe(next)
        held.resolve()
        await pending
        if (line === "the original prompt") {
          expect([...store.collections.messages.values()].filter(row => row.role === "user" && row.text === line)).toHaveLength(1)
        }
        expect(store.session().draft).toBe(next)
      })
    }
  }

  test("a held Chat slash admission preserves the card and waits before executing its inner command", async () => {
    const store = await open()
    const held = deferred(), entered = deferred()
    const controller = controllerFor(hold(store, "command.intent.accepted", held, entered))
    const card = { id: "slash-file", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 10,
      payload: { repo: "smithersai/smithers", path: "notes.txt", content: "note", truncated: false } } as const
    store.dispatch({ type: "card.upsert", actor: "smithers", card })
    store.dispatch({ type: "card.maximized", actor: "user", id: card.id })
    controller.changeDraft("/input.mode vim")
    const pending = controller.commands.run("chat.send", "/input.mode vim")
    await entered.promise
    expect(store.session().maximizedCardId).toBe(card.id)
    expect(store.session().inputMode).toBe("normal")
    expect([...store.collections.commandIntents.values()].some(row => row.name === "input.mode")).toBe(false)
    controller.changeDraft("a newer draft")
    held.resolve()
    await pending
    await store.settled?.()
    expect(store.session().inputMode).toBe("vim")
    expect(store.session().maximizedCardId).toBe(card.id)
    expect(store.session().draft).toBe("a newer draft")
  })

  test("cancelling a held Chat slash admission never reaches the inner command", async () => {
    const store = await open()
    const held = deferred(), entered = deferred(), abort = new AbortController()
    const controller = controllerFor(hold(store, "command.intent.accepted", held, entered))
    const card = { id: "cancelled-slash-file", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 10,
      payload: { repo: "smithersai/smithers", path: "notes.txt", content: "note", truncated: false } } as const
    store.dispatch({ type: "card.upsert", actor: "smithers", card })
    store.dispatch({ type: "card.maximized", actor: "user", id: card.id })
    const pending = controller.commands.submit({ name: "chat.send", payload: { text: "/input.mode vim" }, actor: "user",
      invocation: { ...invocation(), signal: abort.signal } })
    await entered.promise
    abort.abort()
    held.resolve()
    expect(await pending).toMatchObject({ status: "failed", persistenceFailed: true })
    expect(store.session().maximizedCardId).toBe(card.id)
    expect(store.session().inputMode).toBe("normal")
    expect([...store.collections.commandIntents.values()].some(row => row.name === "input.mode")).toBe(false)
  })

  test("a refused Chat slash admission preserves the card and never executes its inner command", async () => {
    const bytes = memoryStorage()
    let fail = false
    const storage: StorageApi = { ...bytes, setItem: (key, value) => { if (fail) throw new Error("disk failed"); bytes.setItem(key, value) } }
    const store = await open(storage), controller = controllerFor(store)
    const card = { id: "slash-file", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 10,
      payload: { repo: "smithersai/smithers", path: "notes.txt", content: "note", truncated: false } } as const
    store.dispatch({ type: "card.upsert", actor: "smithers", card })
    store.dispatch({ type: "card.maximized", actor: "user", id: card.id })
    controller.changeDraft("/input.mode vim")
    await store.settled?.()
    fail = true
    expect(await controller.commands.run("chat.send", "/input.mode vim")).toMatchObject({ status: "failed", persistenceFailed: true })
    expect(store.session().maximizedCardId).toBe(card.id)
    expect(store.session().inputMode).toBe("normal")
    expect(store.session().draft).toBe("/input.mode vim")
    expect([...store.collections.commandIntents.values()].some(row => row.name === "input.mode")).toBe(false)
    fail = false
  })

  test("a delayed queue submission preserves a freshly retyped identical draft", async () => {
    const store = await open()
    const held = deferred(), entered = deferred()
    const controller = controllerFor(hold(store, "command.intent.accepted", held, entered))
    store.dispatch({ type: "prompt.queue.paused", actor: "user", paused: true })
    controller.changeDraft("queued prompt")
    const pending = controller.commands.run("chat.queue", "queued prompt")
    await entered.promise
    controller.changeDraft("")
    controller.changeDraft("queued prompt")
    held.resolve()
    await pending
    expect(store.session().queuedPrompts?.map(row => row.text)).toEqual(["queued prompt"])
    expect(store.session().draft).toBe("queued prompt")
  })

  test("a failed Chat admission leaves its original draft retryable", async () => {
    const bytes = memoryStorage()
    let fail = false
    const storage: StorageApi = { ...bytes, setItem: (key, value) => { if (fail) throw new Error("disk failed"); bytes.setItem(key, value) } }
    const store = await open(storage), controller = controllerFor(store)
    controller.changeDraft("My prompt")
    await store.settled?.()
    fail = true
    expect(await controller.commands.run("chat.send", "My prompt")).toMatchObject({ status: "failed", persistenceFailed: true })
    expect(store.session().draft).toBe("My prompt")
    expect([...store.collections.messages.values()].filter(row => row.role === "user" && row.text === "My prompt")).toHaveLength(0)
    fail = false
    expect((await controller.commands.run("chat.send", "My prompt")).status).toBe("executed")
    expect(store.session().draft).toBe("")
    expect([...store.collections.messages.values()].filter(row => row.role === "user" && row.text === "My prompt")).toHaveLength(1)
  })

  test("submitting a Chat form leaves an identical composer draft alone", async () => {
    const store = await open(), controller = controllerFor(store)
    controller.changeDraft("My prompt")
    controller.renderFlowForm({ name: "chat.send", args: "My prompt", via: "user" })
    expect((await controller.commands.run("form.submit", "form-chat.send")).status).toBe("executed")
    expect([...store.collections.messages.values()].filter(row => row.role === "user" && row.text === "My prompt")).toHaveLength(1)
    expect(store.session().draft).toBe("My prompt")
  })

  test("pure replay refuses duplicate accepts and mismatched settlements", () => {
    const baseline = seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "light" })
    const accept = { type: "command.intent.accepted", actor: "smithers", id: "call", name: "repo.update", source: "command" } as const
    const accepted = projectAppEvent(baseline, { transition: accept, revision: 1, createdAt: 2, persistenceMode: "memory" })
    expect(baseline.commandIntents).toEqual([])
    expect(projectAppEvent(accepted, { transition: accept, revision: 2, createdAt: 3, persistenceMode: "memory" })).toBe(accepted)
    const settle = { type: "command.intent.settled", actor: "user", id: "call", outcome: "executed" } as const
    expect(projectAppEvent(accepted, { transition: settle, revision: 2, createdAt: 3, persistenceMode: "memory" })).toBe(accepted)
    const settled = projectAppEvent(accepted, { transition: { ...settle, actor: "smithers" }, revision: 2, createdAt: 3, persistenceMode: "memory" })
    expect(settled.commandIntents).toMatchObject([{ status: "settled", acceptedRevision: 1, settledRevision: 2, acceptedAt: 2, settledAt: 3 }])
  })

  for (const viaForm of [false, true]) test(`a typed authorization park can resume ${viaForm ? "through a form" : "directly"}, but a failed executed binding cannot`, async () => {
    const store = await open()
    let effects = 0
    let approved = false
    const controller = controllerFor(store, { fetchImpl: async () => { effects++; return Response.json({ message: "external refusal" }, { status: 503 }) } })
    const authority: AgentInvocation = { ...invocation("parked"), authorize: Authorize.make({ authorize: request =>
      request.name === "browser.open" && !approved ? Effect.fail(new Authorize.AuthorizeError({ code: "approval_required", message: "Needs approval" })) : Effect.void }) }
    if (viaForm) controller.renderFlowForm({ name: "browser.open", args: "https://example.test/private", via: "agent", invocation: authority })
    const name = viaForm ? "form.submit" : "browser.open"
    const args = viaForm ? "form-browser.open" : "https://example.test/private"
    expect((await controller.commands.runForAgent(name, args, authority)).status).toBe("failed")
    expect(effects).toBe(0)
    expect([...store.collections.commandIntents.values()].filter(row => row.name === name)).toMatchObject([{ status: "settled", retryable: true }])
    approved = true
    expect((await controller.commands.runForAgent(name, args, authority)).status).toBe("failed")
    expect(effects).toBe(1)
    expect(await controller.commands.runForAgent(name, args, authority)).toMatchObject({ status: "failed", error: expect.stringContaining("saved outcome") })
    expect(effects).toBe(1)
  })

  test("an authorization refusal whose settlement was lost cannot be retried as if its non-execution was durable", async () => {
    const bytes = memoryStorage()
    let fail = false
    const storage: StorageApi = { ...bytes, setItem: (key, value) => { if (fail) throw new Error("disk failed"); bytes.setItem(key, value) } }
    const store = await open(storage)
    let effects = 0
    let approved = false
    const authority: AgentInvocation = { ...invocation("lost-refusal"), authorize: Authorize.make({ authorize: () => approved
      ? Effect.void : Effect.fail(new Authorize.AuthorizeError({ code: "approval_required", message: "Needs approval" })) }) }
    const services: AppServices = { fetchImpl: async () => { effects++; return Response.json({ status: 200, text: "read" }) } }
    const controller = controllerFor({ ...store, dispatch: transition => {
      if (transition.type === "command.intent.settled") fail = true
      return store.dispatch(transition)
    } }, services)
    expect(await controller.commands.runForAgent("browser.open", "https://example.test", authority)).toMatchObject({ status: "failed", persistenceFailed: true })
    await Promise.resolve(controller.dispose()).catch(() => {})
    fail = false
    approved = true
    const restored = await open(storage)
    const next = controllerFor(restored, services)
    expect(await next.commands.runForAgent("browser.open", "https://example.test", authority)).toMatchObject({ status: "failed", error: expect.stringContaining("outcome is unknown") })
    expect(effects).toBe(0)
  })

  test("an effecting flow waits for the accepted receipt, then settlement is persisted", async () => {
    const store = await open()
    const held = deferred(), entered = deferred()
    let effects = 0
    const services: AppServices = { fetchImpl: async () => { effects++; return Response.json({ status: 200, text: "read" }) } }
    const controller = controllerFor(hold(store, "command.intent.accepted", held, entered), services)
    const pending = controller.commands.run("browser.open", "https://example.test")
    await entered.promise
    expect(effects).toBe(0)
    expect([...store.collections.commandIntents.values()]).toMatchObject([{ actor: "user", name: "browser.open", status: "accepted" }])
    held.resolve()
    expect((await pending).status).toBe("executed")
    expect(effects).toBe(1)
    expect([...store.collections.commandIntents.values()]).toMatchObject([{ actor: "user", status: "settled", outcome: "executed" }])
    expect((await store.verifyState()).valid).toBe(true)
  })

  test("a real failed intent commit runs no effect and emits no secondary failure writes", async () => {
    const bytes = memoryStorage()
    let fail = false
    const storage: StorageApi = { ...bytes, setItem: (key, value) => { if (fail) throw new Error("disk failed"); bytes.setItem(key, value) } }
    const store = await open(storage)
    let effects = 0
    const controller = controllerFor(store, { fetchImpl: async () => { effects++; return Response.json({ status: 200, text: "read" }) } })
    fail = true
    const outcome = await controller.commands.run("browser.open", "https://example.test")
    // The refusal names the browser's own fault class and the act that clears
    // it, never the thrown message ("disk failed") and never the flow's id.
    expect(outcome).toMatchObject({ status: "failed", persistenceFailed: true, writeRefused: true,
      error: "This browser did not save that change. Not your fault, and nothing about the change would have avoided it. Make it again; if it fails twice, reload the page." })
    expect(effects).toBe(0)
    expect(store.collections.commandIntents.size).toBe(0)
  })

  test("an effect followed by failed settlement stays ambiguous across reload and is never replayed", async () => {
    const bytes = memoryStorage()
    let fail = false
    const storage: StorageApi = { ...bytes, setItem: (key, value) => { if (fail) throw new Error("disk failed"); bytes.setItem(key, value) } }
    const store = await open(storage)
    let effects = 0
    const services: AppServices = { fetchImpl: async () => { effects++; return Response.json({ status: 200, text: "read" }) } }
    const controller = controllerFor({ ...store, dispatch: transition => {
      if (transition.type === "command.intent.settled") fail = true
      return store.dispatch(transition)
    } }, services)
    expect(await controller.commands.run("browser.open", "https://example.test")).toMatchObject({ status: "failed", persistenceFailed: true })
    expect(effects).toBe(1)
    const id = [...store.collections.commandIntents.keys()][0]!
    await Promise.resolve(controller.dispose()).catch(() => {})
    fail = false
    const restored = await open(storage)
    const restoredController = controllerFor(restored, services)
    await restored.settled?.()
    expect(restored.collections.commandIntents.get(id)?.status).toBe("accepted")
    expect(effects).toBe(1)
    expect((await restored.verifyState()).valid).toBe(true)
    await restoredController.dispose()
  })

  test("stable chain identities refuse concurrent/replayed calls while distinct slots remain independent", async () => {
    const store = await open()
    const lifecycle = createCommandIntentLifecycle(createControllerContext(store, silentAgent, {}))
    const live = invocation()
    const request = { name: "repo.update", actor: "smithers" as const, source: "command" as const,
      invocation: { ...live, slot: { ...live.slot, signal: new AbortController().signal } } }
    const first = lifecycle.accept(request)
    expect(await lifecycle.accept(request)).toHaveProperty("refusal")
    const accepted = await first
    if (!("receipt" in accepted)) throw new Error("acceptance failed")
    expect(await lifecycle.settle(accepted.receipt, { status: "executed", value: "private result" })).toBe(true)
    expect(await lifecycle.accept(request)).toMatchObject({ refusal: expect.stringContaining("saved outcome") })
    expect(await lifecycle.accept({ ...request, invocation: { ...live, slot: { ...live.slot, signal: new AbortController().signal } } })).toHaveProperty("refusal")
    expect(await lifecycle.accept({ ...request, invocation: invocation("lineage", 2) })).toHaveProperty("receipt")
    const history = JSON.stringify(await store.eventHistory())
    expect(history).not.toContain("private result")
    expect(history).not.toContain('"authorize"')
  })

  test("HTTP tool calls carry stable turn/call identity through executeForAgent", async () => {
    const store = await open()
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "http-turn", text: "read" }).isPersisted.promise
    const http = repositoryHttpFixture()
    const controller = controllerFor(store, { fetchImpl: (url, init) => http(String(url), init) })
    const call = { name: "commands", arguments: JSON.stringify({ action: "execute", name: "repo.update", args: "owner/repo" }), httpCall: { turnId: "http-turn", callId: "tool-1" } }
    expect(await controller.commands.executeForAgent(call)).not.toContain("failed:")
    expect([...store.collections.repositoryContexts.values()][0]?.data.repo).toBe("owner/repo")
    expect(await controller.commands.executeForAgent(call)).toContain("saved outcome")
    expect([...store.collections.commandIntents.values()].filter(row => row.name === "repo.update")).toMatchObject([{ actor: "smithers", status: "settled", invocationKey: expect.any(String) }])
    await store.dispatch({ type: "message.response.cancelled", actor: "user", turnId: "http-turn" }).isPersisted.promise
    expect(await controller.commands.executeForAgent({ ...call, httpCall: { ...call.httpCall, callId: "tool-2" } })).toContain("no longer active")
  })

  test("automatic and named form doors preserve their attribution and drafts survive reload", async () => {
    const bytes = memoryStorage()
    const store = await open(bytes)
    const http = repositoryHttpFixture()
    const controller = controllerFor(store, { fetchImpl: (url, init) => http(String(url), init) })
    expect((await controller.commands.run("repo.update", "owner/repo", "automatic")).status).toBe("executed")
    expect((await controller.commands.submit({ name: "repo.update", actor: "user", payload: { repo: "owner/repo" } })).status).toBe("executed")
    controller.renderFlowForm({ name: "repo.tree", args: undefined, via: "user", input: Schema.Struct({ purpose: Schema.optional(Schema.String), id: Schema.String }) })
    await controller.setFormField("form-repo.tree", "purpose", "A durable purpose")
    await controller.setFormField("form-repo.tree", "id", "my-agent")
    await controller.setFormField("form-repo.tree", "purpose", "")
    await store.settled?.()
    await controller.dispose()
    const restored = await open(bytes)
    const form = restored.collections.cards.get("form-repo.tree")
    expect(form?.kind === "flow-form" && form.payload.draft).toEqual({ id: "my-agent" })
    expect([...restored.collections.commandIntents.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: "system", source: "automatic", status: "settled" }),
      expect.objectContaining({ actor: "user", source: "form", status: "settled" })
    ]))
  })

  for (const rejected of [false, true]) test(`form provider reads ${rejected ? "never start after failed" : "wait for"} rendered-card persistence`, async () => {
    const store = await open()
    const held = deferred(), started = deferred()
    let reads = 0
    const observed: AppStore = { ...store, dispatch: transition => {
      const transaction = store.dispatch(transition)
      if (transition.type !== "card.upsert") return transaction
      return new Proxy(transaction, { get: (target, property, receiver) => property === "isPersisted"
        ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise).then(() => { if (rejected) throw new Error("draft commit failed") }) }
        : Reflect.get(target, property, receiver) })
    } }
    const controller = controllerFor(observed, { fetchImpl: async () => {
      reads++; started.resolve(); return Response.json([])
    } })
    controller.renderFlowForm({ name: "files.read", args: "README.md will/smithers", via: "user",
      input: Schema.Struct({ path: Schema.String, repo: Schema.optional(Schema.String) }),
      hints: { fields: { path: { optionsFrom: "files" } } } })
    expect(reads).toBe(0)
    held.resolve()
    if (!rejected) await started.promise
    else { await store.settled?.(); await Promise.resolve(); await Promise.resolve() }
    expect(reads).toBe(rejected ? 0 : 1)
  })

  for (const boundary of ["completion", "disposal", "departure"] as const) test(`pending human form input follows ${boundary} during admission`, async () => {
    const close = boundary !== "completion", pageLifetime = new AbortController()
    const bytes = memoryStorage()
    const store = await open(bytes)
    const held = deferred(), entered = deferred()
    let cleared = 0
    const staged: Array<{ cardId: string; card: unknown; intentId: string }> = []
    const controller = controllerFor({ ...hold(store, "command.intent.accepted", held, entered),
      stagePendingCardInput: (cardId, card, intentId) => {
        staged.push({ cardId, card, intentId })
        return { clear: () => { cleared++ } }
      }
    }, { pageLifetime: pageLifetime.signal })
    controller.renderFlowForm({ name: "repo.tree", args: undefined, via: "user", input: Schema.Struct({ purpose: Schema.String }) })
    await store.settled?.()
    const pending = controller.commands.run("form.set", "form-repo.tree purpose pending words")
    // The actual shared door reaches the private preparation without yielding.
    expect(staged).toMatchObject([{ cardId: "form-repo.tree", card: { payload: { draft: { purpose: "pending words" } } } }])
    expect(store.collections.commandIntents.get(staged[0]!.intentId)?.name).toBe("form.set")
    const before = store.collections.cards.get("form-repo.tree")
    expect(before?.kind === "flow-form" && before.payload.draft).toEqual({})
    await entered.promise
    if (boundary === "disposal") await controller.dispose()
    if (boundary === "departure") pageLifetime.abort()
    held.resolve()
    expect((await pending).status).toBe(close ? "failed" : "executed")
    expect(cleared).toBe(boundary === "departure" ? 0 : 1)
    const readable = close ? await open(bytes) : store
    const after = readable.collections.cards.get("form-repo.tree")
    expect(after?.kind === "flow-form" && after.payload.draft).toEqual(close ? {} : { purpose: "pending words" })
  })

  /*
   * The classifier answers for the storage boundary, and only for it. Staging
   * a human's form edit runs before any write and cannot fail the way a
   * browser fails: when it throws, it is this app's bug. Classified as a lost
   * write it reached the person as "This browser did not save that change…
   * Make it again; if it fails twice, reload the page" — retry advice for
   * something that will never succeed, plus a false line in the transcript
   * about a write that was never attempted.
   *
   * Keeping it out of that classifier is half the answer. The other half is
   * that the person still hears it: an escaped throw left the door with no
   * outcome at all, which is the silence this whole rule exists to delete.
   */
  test("a bug in the staged form preparation is named as a bug, not as a browser that would not save", async () => {
    const store = await open()
    const controller = controllerFor({ ...store, stagePendingCardInput: () => { throw new TypeError("the form card is not ready") } })
    controller.renderFlowForm({ name: "repo.tree", args: undefined, via: "user", input: Schema.Struct({ purpose: Schema.String }) })
    await store.settled?.()
    const outcome = await controller.commands.run("form.set", "form-repo.tree purpose pending words")
    // What the person gets: an act that failed, in words that name a bug and
    // ask for nothing a person could have done differently.
    expect(outcome).toEqual({ status: "failed", writeRefused: true, persistenceFailed: true, error:
      "Smithers hit a bug of its own, so that didn't finish. Not your fault, and nothing about what you did would have avoided it. Reload the page to see where it got to, then make the change again." })
    // Not this browser's saved data, and not the thrown message.
    expect(outcome.status === "failed" && outcome.error).not.toContain("This browser")
    expect(outcome.status === "failed" && outcome.error).not.toContain("the form card is not ready")
    // The write was never reached, so nothing was accepted and nothing is owed
    // a sentence about this browser's saved data.
    expect(store.collections.commandIntents.size).toBe(0)
  })

  test("invalid form input and agent input cannot use the pre-authorization recovery preparation", async () => {
    const store = await open()
    let stages = 0
    const controller = controllerFor({ ...store, stagePendingCardInput: () => { stages++; return { clear: () => {} } } })
    controller.renderFlowForm({ name: "repo.tree", args: undefined, via: "user", input: Schema.Struct({ purpose: Schema.String, count: Schema.Number }) })
    await store.settled?.()
    expect((await controller.commands.run("form.set", "form-repo.tree count invalid-number")).status).toBe("failed")
    expect((await controller.commands.run("form.set", "form-repo.tree missing ignored")).status).toBe("failed")
    expect((await controller.commands.runForAgent("form.set", "form-repo.tree purpose agent words", invocation("form-edit"))).status).toBe("executed")
    expect(stages).toBe(0)
    const card = store.collections.cards.get("form-repo.tree")
    expect(card?.kind === "flow-form" && card.payload.draft).toEqual({ purpose: "agent words" })
  })

  for (const acceptSaved of [false, true]) test(`rapid human form edits recover together ${acceptSaved ? "after" : "before"} command acceptance is durable`, async () => {
    const storageFor = (values: Map<string, string>): StorageApi => ({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: key => { values.delete(key) }
    })
    const values = new Map<string, string>(), recoveryValues = new Map<string, string>()
    const storage = storageFor(values), recovery = storageFor(recoveryValues)
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const host = Object.assign(new EventTarget(), { localStorage: recovery, location: new URL("https://example.invalid/"), matchMedia: () => ({ matches: false }) })
    Object.defineProperty(globalThis, "window", { configurable: true, value: host })
    const held = deferred(), entered = deferred()
    let controller: AppController | undefined
    try {
      const store = await open(storage)
      controller = controllerFor(hold(store, "command.intent.accepted", held, entered))
      controller.renderFlowForm({ name: "repo.tree", args: undefined, via: "user", input: Schema.Struct({ purpose: Schema.String, description: Schema.String }) })
      await store.settled?.()
      const first = controller.commands.run("form.set", "form-repo.tree purpose first field")
      const second = controller.commands.run("form.set", "form-repo.tree description second field")
      if (acceptSaved) await store.settled?.()
      const frozen = new Map(values), frozenRecovery = new Map(recoveryValues)
      const pending = readEntityRecoveries(storageFor(frozenRecovery))
      expect(pending).toHaveLength(1)
      expect(pending[0]?.value).toMatchObject({ card: { payload: { draft: { purpose: "first field", description: "second field" } } } })
      // Finish only the old fixture owner, then reopen the exact captured crash bytes.
      held.resolve()
      expect((await first).status).toBe("executed")
      expect((await second).status).toBe("executed")
      await controller.dispose()
      host.localStorage = storageFor(frozenRecovery)
      const restored = await open(storageFor(frozen))
      const card = restored.collections.cards.get("form-repo.tree")
      expect(card?.kind === "flow-form" && card.payload.draft).toEqual({ purpose: "first field", description: "second field" })
      expect(readEntityRecoveries(host.localStorage)).toEqual([])
      expect((await restored.verifyState()).valid).toBe(true)
    } finally {
      held.resolve()
      await controller?.dispose()
      if (priorWindow === undefined) Reflect.deleteProperty(globalThis, "window")
      else Object.defineProperty(globalThis, "window", priorWindow)
    }
  })

  test("privacy erasure does not recreate the erased command at settlement", async () => {
    const store = await open()
    const lifecycle = createCommandIntentLifecycle(createControllerContext(store, silentAgent, {}))
    const accepted = await lifecycle.accept({ name: "app.reset", actor: "user", source: "command" })
    if (!("receipt" in accepted)) throw new Error("acceptance failed")
    await store.dispatch({ type: "app.reset", actor: "user" }).isPersisted.promise
    expect(await lifecycle.settle(accepted.receipt, { status: "executed" })).toBe(true)
    expect(store.collections.commandIntents.size).toBe(0)
    expect(JSON.stringify(await store.eventHistory())).not.toContain(accepted.receipt.id)
  })
})
