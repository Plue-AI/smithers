import { Database } from "bun:sqlite"
import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { FlowGesture, type CommandGesture } from "../../flows/CommandGesture"
import { ROW_TABLE_NAME } from "../../chain/SqliteRowStorage"
import { createAppController } from "../AppController"
import { createAppStore, resolvePersistence } from "../AppStore"
import { replayAppEvents } from "../AppEventStream"
import { unavailableAgent } from "../TestFixtures"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Real SQLite and HTTP; only the submitting COMMIT's completion receipt is delayed. */
const fixture = async () => {
  const database = new Database(":memory:")
  const entered = deferred(), released = deferred()
  let armed = false
  let held = false
  let rejectReceipt = false
  const submissionFailure = new Error("SQLite submitting commit refused")
  let status = 200
  const reads: string[] = []
  const rows = <A>(collection: string): A[] =>
    (database.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = ?`).all(collection) as Array<{ value: string }>)
      .map(row => JSON.parse(row.value) as A)
  const durable = () => replayAppEvents(rows("app-event-checkpoints")[0], rows("app-events"), rows("app-event-heads")[0]).snapshot
  let closedSnapshot: ReturnType<typeof durable> | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname
      if (path === "/api/repos/acme/app/contents/README.md") {
        reads.push(path)
        return status === 200 ? Response.json({ type: "file", path: "README.md", content: "# Persisted result", encoding: "utf-8" })
          : Response.json({ message: "read refused" }, { status })
      }
      if (path === "/api/repos/acme/app/contents") return Response.json([{ name: "README.md", path: "README.md", type: "file" }])
      if (path === "/api/repos/acme/app") return Response.json({ default_bookmark: "main" })
      return Response.json({ message: "fixture route absent" }, { status: 404 })
    }
  })
  const resolved = await resolvePersistence({ bootRecord: () => undefined, openDatabase: async () => ({
    execute: async <A>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<A>> => {
      const statement = database.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<A>
      if (sql === "COMMIT" && rejectReceipt && armed && !held && durable().cards.some(card => card.kind === "flow-form" && card.payload.submitting === true)) {
        held = true
        throw submissionFailure
      }
      statement.run(...params as [])
      if (sql === "COMMIT" && armed && !held && durable().cards.some(card => card.kind === "flow-form" && card.payload.submitting === true)) {
        held = true
        entered.resolve()
        await released.promise
      }
      return []
    },
    close: () => { closedSnapshot = durable(); database.close() }
  }) })
  const store = await createAppStore(resolved)
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: "acme/app", org: "acme", ownerKind: "user", name: "app", head: null, catalog: true }
  ] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "acme/app" }).isPersisted.promise
  const controller = createAppController(store, unavailableAgent, {
    baseUrl: server.url.origin,
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["cloud", "identity"], authFlow: "redirect", sandbox: null }
  })
  const form = controller.renderFlowForm({ name: "files.read", args: undefined, via: "user" })!
  await store.settled?.()
  expect(form).toBeDefined()
  expect((await controller.commands.run("form.set", `${form.cardId} path README.md`)).status).toBe("executed")
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "other-card", kind: "file", title: "Other file", status: "active", createdAt: 1, ordinal: 99,
    payload: { repo: "acme/app", path: "other.txt", content: "other", truncated: false }
  } }).isPersisted.promise
  return {
    store, controller, formId: form.cardId, entered: entered.promise, reads, durable: () => closedSnapshot ?? durable(),
    arm: () => { armed = true }, release: released.resolve,
    rejectSubmission: () => { rejectReceipt = true; armed = true },
    refuse: () => { status = 403 },
    dispose: async () => {
      released.resolve()
      const cleanup = async (completion: void | Promise<void>) => {
        try { await completion } catch (cause) {
          if (!rejectReceipt) throw cause
          expect(cause instanceof AggregateError ? cause.errors : [cause]).toEqual([submissionFailure])
        }
      }
      try {
        await cleanup(controller.dispose())
        await cleanup(store.dispose?.())
      } finally { await server.stop(true) }
    }
  }
}

const holdSubmission = async (t: Awaited<ReturnType<typeof fixture>>) => {
  t.arm()
  const pending = t.controller.commands.run("form.submit", t.formId, undefined, t.formId)
  await Promise.race([t.entered, pending.then(outcome => {
    throw new Error(`submission finished before its SQLite barrier: ${JSON.stringify(outcome)}`)
  })])
  expect(t.durable().cards.find(card => card.id === t.formId)).toMatchObject({ payload: { submitting: true } })
  expect(t.reads).toEqual([])
  return { pending }
}

const resultCommitted = (t: Awaited<ReturnType<typeof fixture>>) => {
  expect(t.durable().cards.find(card => card.kind === "file" && card.payload.path === "README.md")).toMatchObject({ payload: { content: "# Persisted result" } })
  expect(t.durable().cards.find(card => card.id === t.formId)).toMatchObject({ status: "acted", payload: { submitting: false } })
  expect(t.reads).toEqual(["/api/repos/acme/app/contents/README.md"])
}

describe("durable form presentation ordering (#3312)", () => {
  test("a newer maximize survives the submitting SQLite receipt and the file result commits", async () => {
    const t = await fixture()
    try {
      const { pending } = await holdSubmission(t)
      t.controller.maximizeCard("other-card")
      expect(t.store.session().maximizedCardId).toBe("other-card")
      t.release()
      expect((await pending).status).toBe("executed")
      await t.store.settled?.()
      resultCommitted(t)
      expect(t.store.session().maximizedCardId).toBe("other-card")
      expect(t.durable().sessions[0]?.maximizedCardId).toBe("other-card")
    } finally { await t.dispose() }
  })

  for (const gesture of ["MAX same form", "MAX other then form", "MIN then MAX form", "MIN"] as const) {
    test(`newer ${gesture} survives the persisted submission`, async () => {
      const t = await fixture()
      try {
        t.controller.maximizeCard(t.formId)
        await t.store.settled?.()
        const frameId = t.store.session().activeFrameId!
        const revision = t.store.collections.frames.get(frameId)!.revision
        const { pending } = await holdSubmission(t)
        // The submitting payload is data; it has not spent another frame gesture.
        expect(t.store.collections.frames.get(frameId)!.revision).toBe(revision)
        if (gesture === "MAX other then form") t.controller.maximizeCard("other-card")
        if (gesture.startsWith("MIN")) t.controller.minimizeCard()
        if (gesture !== "MIN") t.controller.maximizeCard(t.formId)
        expect(t.store.collections.frames.get(frameId)!.revision).toBeGreaterThan(revision)
        t.release()
        expect((await pending).status).toBe("executed")
        await t.store.settled?.()
        resultCommitted(t)
        expect(t.store.session().maximizedCardId).toBe(gesture === "MIN" ? null : t.formId)
        expect(t.durable().sessions[0]?.maximizedCardId).toBe(gesture === "MIN" ? null : t.formId)
      } finally { await t.dispose() }
    })
  }

  test("unchanged same-form presentation reveals the result despite unrelated data/status writes", async () => {
    const t = await fixture()
    try {
      t.controller.maximizeCard(t.formId)
      await t.store.settled?.()
      const frameId = t.store.session().activeFrameId!
      const revision = t.store.collections.frames.get(frameId)!.revision
      const { pending } = await holdSubmission(t)
      t.store.dispatch({ type: "card.updated", actor: "system", id: "other-card", patch: { title: "Updated unrelated file", status: "error" } })
      expect(t.store.collections.frames.get(frameId)!.revision).toBe(revision)
      t.release()
      expect((await pending).status).toBe("executed")
      await t.store.settled?.()
      resultCommitted(t)
      expect(t.store.session().maximizedCardId).toBeNull()
      expect(t.durable().sessions[0]?.maximizedCardId).toBeNull()
      expect(t.durable().cards.find(card => card.id === "other-card")?.title).toBe("Updated unrelated file")
    } finally { await t.dispose() }
  })

  test("a refused HTTP read preserves the newer presentation and persists its form error", async () => {
    const t = await fixture()
    try {
      t.refuse()
      const { pending } = await holdSubmission(t)
      t.controller.maximizeCard("other-card")
      t.release()
      await pending
      await t.store.settled?.()
      const form = t.durable().cards.find(card => card.id === t.formId)
      expect(form?.status).toBe("error")
      expect(form?.kind === "flow-form" && form.payload.submitting === true).toBe(false)
      expect(t.durable().cards.some(card => card.kind === "file" && card.payload.path === "README.md")).toBe(false)
      expect(t.reads).toHaveLength(1)
      expect(t.durable().sessions[0]?.maximizedCardId).toBe("other-card")
    } finally { await t.dispose() }
  })

  test("invalid same-form input retains its focus and starts no read", async () => {
    const t = await fixture()
    try {
      await t.controller.commands.run("form.set", `${t.formId} path`)
      t.controller.maximizeCard(t.formId)
      await t.store.settled?.()
      await t.controller.commands.run("form.submit", t.formId, undefined, t.formId)
      await t.store.settled?.()
      expect(t.durable().sessions[0]?.maximizedCardId).toBe(t.formId)
      const form = t.durable().cards.find(card => card.id === t.formId)
      expect(form?.status).toBe("error")
      expect(form?.kind === "flow-form" && form.payload.submitting === true).toBe(false)
      expect(t.reads).toEqual([])
    } finally { await t.dispose() }
  })

  test("controller cancellation during the submitting receipt executes no result work", async () => {
    const t = await fixture()
    try {
      const { pending } = await holdSubmission(t)
      const disposing = t.controller.dispose()
      t.release()
      await pending
      await disposing
      await t.store.settled?.()
      expect(t.reads).toEqual([])
      expect(t.durable().cards.some(card => card.kind === "file" && card.payload.path === "README.md")).toBe(false)
      expect(t.durable().cards.find(card => card.id === t.formId)?.status).not.toBe("acted")
    } finally { await t.dispose() }
  })

  test("a rejected real SQLite commit rolls back submitting and executes no result work", async () => {
    const t = await fixture()
    try {
      t.rejectSubmission()
      expect((await t.controller.commands.run("form.submit", t.formId, undefined, t.formId)).status).toBe("failed")
      expect(t.reads).toEqual([])
      const form = t.durable().cards.find(card => card.id === t.formId)
      expect(form?.status).toBe("active")
      expect(form?.kind === "flow-form" && form.payload.submitting === true).toBe(false)
      expect(t.durable().cards.some(card => card.kind === "file" && card.payload.path === "README.md")).toBe(false)
    } finally { await t.dispose() }
  })

  for (const path of ["missing input", "sign-in prerequisite"] as const) {
    test(`a stale continuation's ${path} preserves the later frame`, async () => {
      const t = await fixture()
      let restore = () => {}
      try {
        if (path === "sign-in prerequisite") await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
        t.controller.maximizeCard("other-card")
        await t.store.settled?.()
        const name = path === "missing input" ? "files.read" : "flow.list"
        let released = 0
        let observed: CommandGesture | undefined
        if (path === "sign-in prerequisite") {
          const binding = t.controller.commands.find("auth.prompt")!.binding
          const run = binding.run
          const spy = spyOn(binding, "run").mockImplementation(call => Effect.gen(function*() {
            observed = yield* FlowGesture
            return yield* run(call)
          }))
          restore = () => spy.mockRestore()
        }
        const outcome = await t.controller.commands.submit({ name, payload: {}, actor: "user", originCardId: "other-card",
          gesture: { name, presentationCurrent: () => false, takeWriteOnly: () => "private", takeFile: () => undefined,
            openExternal: async () => true, release: () => { released++ } } })
        expect(outcome.status).toBe(path === "missing input" ? "form" : "executed")
        await t.store.settled?.()
        expect(t.durable().sessions[0]?.maximizedCardId).toBe("other-card")
        if (path === "sign-in prerequisite") {
          expect(t.durable().sessions[0]?.pendingCommand).toMatchObject({ name: "flow.list", requirement: "signed-in" })
          expect([...t.store.collections.messages.values()].some(message => message.action?.flow === "sign-in")).toBe(true)
          expect(Object.keys(observed!).sort()).toEqual(["name", "presentationCurrent", "release"])
          expect(observed!.name).toBe("auth.prompt")
        }
        // The caller owns its original reservation, not the unrelated fulfillment.
        expect(released).toBe(0)
        expect(t.reads).toEqual([])
      } finally { restore(); await t.dispose() }
    })
  }

  test("the original inner form preserves browser/write-only closures without releasing them twice", async () => {
    const t = await fixture()
    const binding = t.controller.commands.find("files.read")!.binding
    const run = binding.run
    let observed: CommandGesture | undefined
    const spy = spyOn(binding, "run").mockImplementation(call => Effect.gen(function*() {
      observed = yield* FlowGesture
      return yield* run(call)
    }))
    let released = 0
    const gesture: CommandGesture = { name: "form.submit", openExternal: async () => true, hasWriteOnly: () => false,
      takeWriteOnly: () => undefined, takeFile: () => undefined, release: () => { released++ } }
    try {
      expect((await t.controller.commands.submit({ name: "form.submit", payload: { cardId: t.formId }, actor: "user", gesture })).status).toBe("executed")
      await t.store.settled?.()
      resultCommitted(t)
      expect(observed?.name).toBe("files.read")
      expect(observed?.presentationCurrent).toBeFunction()
      expect(observed?.openExternal).toBe(gesture.openExternal)
      expect(observed?.hasWriteOnly).toBe(gesture.hasWriteOnly)
      expect(observed?.takeWriteOnly).toBe(gesture.takeWriteOnly)
      expect(observed?.takeFile).toBe(gesture.takeFile)
      expect(observed?.release).toBe(gesture.release)
      expect(released).toBe(0)
      gesture.release()
      expect(released).toBe(1)
    } finally { spy.mockRestore(); await t.dispose() }
  })
})
