import { afterEach, expect, test } from "bun:test"
import { createActorBindings } from "../ActorBindings"
import { createAppStore, type AppStore } from "../AppStore"
import type { Card } from "../AppState"
import { memoryStorage } from "../TestFixtures"
import { createIssuesSeam } from "./IssuesSeam"
import type { SeamContext } from "./SeamContext"

type Issue = Extract<Card, { kind: "issue" }>
const seed = (token = "claim-1"): Issue => ({
  id: "issue-will/flows-8", kind: "issue", title: "Chat", status: "active", createdAt: 0, ordinal: 1,
  payload: { repo: "will/flows", number: 8, kind: "chat", visibility: "private", title: "Chat", state: "open",
    author: "will", issueBody: "", labels: [], comments: [],
    sync: { provider: "telegram", connectionId: "bot", scopeId: "123", conversationId: "-100", state: "outcome_unknown", deliveryId: 41, resolutionToken: token } }
})
const checkpoint = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const bounded = async <A>(work: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Resolution fixture work did not settle")), 5_000)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
const ownedFixtures = new Set<{ dispose(): Promise<void> }>()
afterEach(async () => {
  const errors: unknown[] = []
  for (const fixture of ownedFixtures) { try { await fixture.dispose() } catch (error) { errors.push(error) } }
  ownedFixtures.clear()
  if (errors.length) throw new AggregateError(errors, "Resolution fixture cleanup failed")
})

const fixture = async (holdAdmission = false, initial = seed()) => {
  const storage = memoryStorage()
  let failStorage = false, disposed = false
  const admission = Promise.withResolvers<void>()
  const admissionEntered = Promise.withResolvers<void>()
  if (!holdAdmission) admission.resolve()
  const pending = new Set<Promise<unknown>>()
  const releases = new Set<() => void>([() => admission.resolve()])
  const finalizers: Array<() => void> = []
  const unexpectedHttp: string[] = []
  const outcomes: unknown[] = []
  let currentFlight: Promise<void> | undefined
  const writes: Array<{ body: unknown; answer: ReturnType<typeof Promise.withResolvers<Response>>; completed(): Promise<void> }> = []
  let afterSettlement: (() => Promise<void>) | undefined
  const observe = <A>(work: Promise<A>): Promise<A> => {
    pending.add(work)
    const complete = () => { pending.delete(work) }
    void work.then(complete, complete)
    return work
  }
  const drain = async (): Promise<void> => {
    do {
      await Promise.allSettled([...pending])
      await checkpoint()
    } while (pending.size !== 0)
  }
  const trackResponse = (response: Response): Response => {
    const json = response.json.bind(response), text = response.text.bind(response), clone = response.clone.bind(response)
    response.json = () => observe(json())
    response.text = () => observe(text())
    response.clone = () => trackResponse(clone())
    if (response.body !== null) {
      const cancel = response.body.cancel.bind(response.body)
      response.body.cancel = reason => observe(cancel(reason))
    }
    return response
  }
  const gate = () => {
    const held = Promise.withResolvers<void>()
    releases.add(() => held.resolve())
    return held
  }
  const store = await createAppStore({ kind: "localStorage", storage: { ...storage,
    setItem: (key, value) => { if (failStorage) throw new Error("Disk full"); storage.setItem(key, value) }
  } })
  let closing: Promise<void> | undefined
  const retire = () => {
    disposed = true
    const errors: unknown[] = []
    for (const release of finalizers.splice(0)) { try { release() } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, "Resolution subscription retirement failed")
  }
  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = (async () => {
      const errors: unknown[] = []
      try { retire() } catch (error) { errors.push(error) }
      failStorage = false
      for (const release of releases) { try { release() } catch (error) { errors.push(error) } }
      releases.clear()
      for (const write of writes) write.answer.resolve(Response.json({ message: "Stopped" }, { status: 503 }))
      try { await bounded(drain()) } catch (error) { errors.push(error) }
      try {
        if (store.settled === undefined) throw new Error("Resolution fixture requires persistence settlement")
        await store.settled()
      } catch (error) { errors.push(error) }
      try {
        if (store.dispose === undefined) throw new Error("Resolution fixture requires store disposal")
        await store.dispose()
      } catch (error) { errors.push(error) }
      const unexpected = unexpectedHttp.splice(0)
      if (unexpected.length) errors.push(new Error(`Unplanned resolution HTTP: ${unexpected.join(", ")}`))
      if (errors.length) throw new AggregateError(errors, "Resolution fixture disposal failed")
    })()
    return closing
  }
  // Own the real store before the first seed receipt or actor construction can fail.
  ownedFixtures.add({ dispose })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: initial }).isPersisted.promise
  let read = async (_url: string): Promise<Response> => Response.json({ message: "No authoritative issue read fixture" }, { status: 404 })
  const dispatch: AppStore["dispatch"] = transition => {
    const transaction = store.dispatch(transition)
    const persisted = transaction.isPersisted.promise
    observe(persisted)
    if (transition.type !== "card.upsert" || transition.card.kind !== "issue") return transaction
    const settlement = afterSettlement
    const wait = transition.card.payload.sync?.resolution?.status === "requested"
      ? () => { admissionEntered.resolve(); return admission.promise }
      : settlement === undefined ? undefined : () => observe(settlement())
    if (wait === undefined) return transaction
    const receipt = observe(persisted.then(wait))
    return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: receipt }
      : Reflect.get(target, key, receiver) })
  }
  const ctx: SeamContext = { store, dispatch, baseUrl: "https://app.test", actor: () => "user", nextOrdinal: store.nextOrdinal,
    isDisposed: () => disposed, withToast: (key, _title, _done, work) => {
      const completed = Promise.withResolvers<void>()
      const previous = currentFlight
      currentFlight = completed.promise
      try {
        const operation = (async () => {
          const answer = await work()
          if (key.startsWith("issue.resolve:")) outcomes.push(answer)
          return answer
        })()
        return observe(operation.finally(() => completed.resolve()))
      } finally { currentFlight = previous }
    },
    http: (url, init) => observe((async () => {
      const method = init?.method ?? "GET"
      const route = `${method} ${url}`
      if (method === "GET" && ["https://app.test/api/repos/will/flows/issues/8", "https://app.test/api/repos/will/flows/issues/8/comments", "https://app.test/api/repos/will/flows/issues/8/sync"].includes(url)) {
        return trackResponse(await read(url))
      }
      if (route !== "PUT https://app.test/api/repos/will/flows/issues/sync/deliveries/41") {
        unexpectedHttp.push(route)
        throw new Error(`Unplanned resolution HTTP: ${route}`)
      }
      const flight = currentFlight
      if (flight === undefined) throw new Error("Resolution write must have an owned toast operation")
      const answer = Promise.withResolvers<Response>()
      writes.push({ body: JSON.parse(String(init?.body)), answer, completed: async () => {
        await bounded(flight)
        await checkpoint()
        if (store.settled === undefined) throw new Error("Resolution fixture requires persistence settlement")
        await store.settled()
      } })
      return trackResponse(await answer.promise)
    })()) }
  const actors = createActorBindings(release => finalizers.push(release))
  const paired = actors.pair(ctx, context => createIssuesSeam(context))
  const selected = actors.select(paired)
  const owned = (seam: typeof paired) => ({ ...seam,
    resolveIssueSync: (...args: Parameters<typeof seam.resolveIssueSync>) => observe(seam.resolveIssueSync(...args))
  })
  const human = owned(paired), agent = owned(selected)
  human.subscribe(release => finalizers.push(release))
  return { store, human, agent, admission, admissionEntered, writes, outcomes, retire, gate,
    setRead: (next: typeof read) => { read = next },
    afterSettlement: (work: () => Promise<void>) => { afterSettlement = work },
    failStorage: () => { failStorage = true }, current: (): Issue => {
      const card = store.collections.cards.get(initial.id)
      if (card?.kind !== "issue") throw new Error(`Resolution fixture expected issue ${initial.id}`)
      return card
    },
    checkpoint: async () => {
      if (store.settled === undefined) throw new Error("Resolution fixture requires persistence settlement")
      await store.settled()
      await checkpoint()
    },
    dispose
  }
}

test("resolution subscriptions cannot send while the admission receipt is unresolved", async () => {
  const t = await fixture(true)
  const requested = t.agent.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "")
  let duplicateAnswered = false
  const duplicate = t.human.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "").then(answer => { duplicateAnswered = true; return answer })
  try {
    await bounded(t.admissionEntered.promise)
    await t.checkpoint()
    expect(t.writes).toHaveLength(0)
    expect(duplicateAnswered).toBe(false)
    t.admission.resolve()
    expect(await requested).toBe("Resolution requested.")
    expect(await duplicate).toBe("Resolution requested.")
    await t.checkpoint()
    expect(t.writes).toHaveLength(1)
  } finally { t.admission.resolve(); await Promise.all([requested, duplicate]); await t.dispose() }
})

test("human subscriptions and agent resolution share one remote flight", async () => {
  const t = await fixture()
  try {
    await t.agent.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "")
    await t.checkpoint()
    expect(t.writes).toHaveLength(1)
    await t.human.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "")
    expect(t.writes).toHaveLength(1)
  } finally { await t.dispose() }
})

test("an old delivery response cannot replace a newer resolution request", async () => {
  const t = await fixture()
  try {
    await t.human.resolveIssueSync(seed().id, 41, "retry", "First decision", "")
    await t.checkpoint()
    expect(t.writes).toHaveLength(1)
    await t.store.dispatch({ type: "card.view.loaded", actor: "system", card: seed("claim-2") }).isPersisted.promise
    await t.human.resolveIssueSync(seed().id, 41, "skip", "New decision", "")
    t.writes[0]!.answer.resolve(Response.json({ message: "Old refusal" }, { status: 409 }))
    await t.writes[0]!.completed()
    expect(t.current().payload.sync?.resolution).toMatchObject({ expectedToken: "claim-2", action: "skip", status: "requested" })
    expect(t.writes).toHaveLength(2)
  } finally { await t.dispose() }
})

test("an old owner's completion cannot clear or block the new owner's flight", async () => {
  const t = await fixture()
  try {
    await t.human.resolveIssueSync(seed().id, 41, "retry", "First owner", "")
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: seed("bob-claim") }).isPersisted.promise
    await t.agent.resolveIssueSync(seed().id, 41, "skip", "New owner", "")
    await t.checkpoint()
    expect(t.writes).toHaveLength(2)
    t.writes[0]!.answer.resolve(Response.json({ message: "Old refusal" }, { status: 409 }))
    await t.writes[0]!.completed()
    expect(t.current().payload.sync?.resolution).toMatchObject({ owner: "bob", expectedToken: "bob-claim", status: "requested" })
    await t.human.resolveIssueSync(seed().id, 41, "skip", "New owner", "")
    expect(t.writes).toHaveLength(2)
  } finally { await t.dispose() }
})

for (const boundary of ["account", "dispose"]) test(`${boundary} retirement during admission prevents the remote resolution`, async () => {
  const t = await fixture(true)
  const requested = t.human.resolveIssueSync(seed().id, 41, "retry", "Old request", "")
  try {
    await bounded(t.admissionEntered.promise)
    if (boundary === "account") await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    else t.retire()
    t.admission.resolve()
    expect(await requested).toBe("Resolution is no longer current.")
    expect(t.writes).toHaveLength(0)
  } finally { t.admission.resolve(); await requested; await t.dispose() }
})

test("a failed durable admission never sends a resolution", async () => {
  const t = await fixture()
  try {
    t.failStorage()
    await expect(t.human.resolveIssueSync(seed().id, 41, "retry", "Unsaved decision", "")).rejects.toThrow("Disk full")
    await t.checkpoint()
    expect(t.writes).toHaveLength(0)
  } finally { await t.dispose() }
})

for (const owner of ["will", "another-owner"]) test(`a restored ${owner} request reconnects only for its owner`, async () => {
  const card = seed()
  card.payload.sync!.resolution = { deliveryId: 41, expectedToken: "claim-1", action: "retry", evidence: "Saved decision", messageId: "", owner, status: "requested" }
  const t = await fixture(false, card)
  try {
    await t.checkpoint()
    expect(t.writes).toHaveLength(owner === "will" ? 1 : 0)
    if (owner === "will") {
      await t.agent.resolveIssueSync(card.id, 41, "retry", "Saved decision", "")
      expect(t.writes).toHaveLength(1)
    }
  } finally { await t.dispose() }
})

const resolvedRead = async (url: string): Promise<Response> => {
  if (url === "https://app.test/api/repos/will/flows/issues/8/comments") return Response.json([])
  if (url === "https://app.test/api/repos/will/flows/issues/8/sync") return Response.json({
    provider: "telegram", connection_id: "bot", scope_id: "123", conversation_id: "-100", state: "unsupported", delivery_id: 41
  })
  if (url === "https://app.test/api/repos/will/flows/issues/8") return Response.json({
    number: 8, title: "Authoritative title", kind: "chat", state: "open", author: { login: "will" }, body: "", labels: []
  })
  throw new Error(`No authoritative read for ${url}`)
}

test("successful resolution reads authoritative state without losing the comment draft", async () => {
  const t = await fixture()
  try {
    t.setRead(resolvedRead)
    await t.human.draftIssueComment(seed().id, "Unsent draft")
    await t.human.resolveIssueSync(seed().id, 41, "skip", "Verified externally", "")
    t.writes[0]!.answer.resolve(Response.json({}))
    await t.writes[0]!.completed()
    expect(t.current()).toMatchObject({ title: "Authoritative title", payload: { commentDraft: "Unsent draft", sync: { state: "unsupported" } } })
    expect(t.current().payload.sync?.resolution).toBeUndefined()
    expect(t.outcomes).toEqual([undefined])
  } finally { await t.dispose() }
})

test("a failed authoritative read reports that the write resolved but refresh failed", async () => {
  const t = await fixture()
  try {
    await t.human.resolveIssueSync(seed().id, 41, "skip", "Verified externally", "")
    t.writes[0]!.answer.resolve(Response.json({}))
    await t.writes[0]!.completed()
    expect(t.outcomes).toEqual([expect.stringContaining("Delivery resolved, but refreshing the card failed:")])
    expect(t.writes).toHaveLength(1)
  } finally { await t.dispose() }
})

test("a delayed success read cannot replace the next delivery's resolution", async () => {
  const t = await fixture()
  const reading = t.gate(), release = t.gate()
  try {
    t.setRead(async url => { if (url.endsWith("/8")) { reading.resolve(); await release.promise }; return resolvedRead(url) })
    await t.human.resolveIssueSync(seed().id, 41, "skip", "First decision", "")
    t.writes[0]!.answer.resolve(Response.json({}))
    await bounded(reading.promise)
    await t.store.dispatch({ type: "card.view.loaded", actor: "system", card: seed("claim-2") }).isPersisted.promise
    await t.agent.resolveIssueSync(seed().id, 41, "retry", "Second decision", "")
    release.resolve()
    await t.writes[0]!.completed()
    expect(t.current().payload.sync?.resolution).toMatchObject({ expectedToken: "claim-2", status: "requested" })
    expect(t.writes).toHaveLength(2)
    await t.human.resolveIssueSync(seed().id, 41, "retry", "Second decision", "")
    expect(t.writes).toHaveLength(2)
  } finally { release.resolve(); await t.dispose() }
})

test("a new delivery appearing during settlement prevents the old refresh from starting", async () => {
  const t = await fixture()
  let reads = 0
  try {
    t.setRead(async url => { reads++; return resolvedRead(url) })
    await t.human.resolveIssueSync(seed().id, 41, "skip", "First decision", "")
    t.afterSettlement(async () => {
      await t.store.dispatch({ type: "card.view.loaded", actor: "system", card: seed("claim-2") }).isPersisted.promise
    })
    t.writes[0]!.answer.resolve(Response.json({}))
    await t.writes[0]!.completed()
    expect(t.current().payload.sync).toMatchObject({ state: "outcome_unknown", resolutionToken: "claim-2" })
    expect(reads).toBe(0)
  } finally { await t.dispose() }
})
