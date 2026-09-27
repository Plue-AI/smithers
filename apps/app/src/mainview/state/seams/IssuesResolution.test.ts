import { expect, test } from "bun:test"
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
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const fixture = async (holdAdmission = false, initial = seed()) => {
  const storage = memoryStorage()
  let failStorage = false
  const store = await createAppStore({ kind: "localStorage", storage: { ...storage,
    setItem: (key, value) => { if (failStorage) throw new Error("Disk full"); storage.setItem(key, value) }
  } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: initial }).isPersisted.promise
  const admission = Promise.withResolvers<void>()
  if (!holdAdmission) admission.resolve()
  const writes: Array<{ body: unknown; answer: ReturnType<typeof Promise.withResolvers<Response>> }> = []
  const outcomes: unknown[] = []
  let read = async (_url: string): Promise<Response> => Response.json({ message: "No read fixture" }, { status: 404 })
  let afterSettlement: (() => Promise<void>) | undefined
  let disposed = false
  const finalizers: Array<() => void> = []
  const dispatch: AppStore["dispatch"] = transition => {
    const transaction = store.dispatch(transition)
    if (transition.type !== "card.upsert" || transition.card.kind !== "issue") return transaction
    const wait = transition.card.payload.sync?.resolution?.status === "requested" ? () => admission.promise : afterSettlement
    if (wait === undefined) return transaction
    return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(wait) }
      : Reflect.get(target, key, receiver) })
  }
  const ctx: SeamContext = { store, dispatch, baseUrl: "https://app.test", actor: () => "user", nextOrdinal: store.nextOrdinal,
    isDisposed: () => disposed, withToast: async (key, _title, _done, work) => { const answer = await work(); if (key.startsWith("issue.resolve:")) outcomes.push(answer); return answer },
    http: async (url, init) => {
      if (init?.method !== "PUT") return read(url)
      const answer = Promise.withResolvers<Response>()
      writes.push({ body: JSON.parse(String(init.body)), answer })
      return answer.promise
    } }
  const actors = createActorBindings(release => finalizers.push(release))
  const human = actors.pair(ctx, context => createIssuesSeam(context))
  const agent = actors.select(human)
  human.subscribe(release => finalizers.push(release))
  const retire = () => { disposed = true; for (const release of finalizers.splice(0)) release() }
  return { store, human, agent, admission, writes, outcomes, retire, setRead: (next: typeof read) => { read = next },
    afterSettlement: (work: () => Promise<void>) => { afterSettlement = work },
    failStorage: () => { failStorage = true }, current: () => store.collections.cards.get(seed().id) as Issue,
    dispose: async () => {
      retire()
      failStorage = false
      admission.resolve()
      for (const write of writes) write.answer.resolve(Response.json({ message: "Stopped" }, { status: 503 }))
      await flush()
      await store.dispose?.()
    } }
}

test("resolution subscriptions cannot send while the admission receipt is unresolved", async () => {
  const t = await fixture(true)
  const requested = t.agent.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "")
  let duplicateAnswered = false
  const duplicate = t.human.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "").then(answer => { duplicateAnswered = true; return answer })
  try {
    await flush()
    expect(t.writes).toHaveLength(0)
    expect(duplicateAnswered).toBe(false)
    t.admission.resolve()
    expect(await requested).toBe("Resolution requested.")
    expect(await duplicate).toBe("Resolution requested.")
    await flush()
    expect(t.writes).toHaveLength(1)
  } finally { t.admission.resolve(); await Promise.all([requested, duplicate]); await t.dispose() }
})

test("human subscriptions and agent resolution share one remote flight", async () => {
  const t = await fixture()
  try {
    await t.agent.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "")
    await flush()
    expect(t.writes).toHaveLength(1)
    await t.human.resolveIssueSync(seed().id, 41, "retry", "Accept duplicate risk", "")
    expect(t.writes).toHaveLength(1)
  } finally { await t.dispose() }
})

test("an old delivery response cannot replace a newer resolution request", async () => {
  const t = await fixture()
  try {
    await t.human.resolveIssueSync(seed().id, 41, "retry", "First decision", "")
    await flush()
    expect(t.writes).toHaveLength(1)
    await t.store.dispatch({ type: "card.view.loaded", actor: "system", card: seed("claim-2") }).isPersisted.promise
    await t.human.resolveIssueSync(seed().id, 41, "skip", "New decision", "")
    t.writes[0]!.answer.resolve(Response.json({ message: "Old refusal" }, { status: 409 }))
    await flush()
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
    await flush()
    expect(t.writes).toHaveLength(2)
    t.writes[0]!.answer.resolve(Response.json({ message: "Old refusal" }, { status: 409 }))
    await flush()
    expect(t.current().payload.sync?.resolution).toMatchObject({ owner: "bob", expectedToken: "bob-claim", status: "requested" })
    await t.human.resolveIssueSync(seed().id, 41, "skip", "New owner", "")
    expect(t.writes).toHaveLength(2)
  } finally { await t.dispose() }
})

for (const boundary of ["account", "dispose"]) test(`${boundary} retirement during admission prevents the remote resolution`, async () => {
  const t = await fixture(true)
  const requested = t.human.resolveIssueSync(seed().id, 41, "retry", "Old request", "")
  try {
    await flush()
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
    await flush()
    expect(t.writes).toHaveLength(0)
  } finally { await t.dispose() }
})

for (const owner of ["will", "another-owner"]) test(`a restored ${owner} request reconnects only for its owner`, async () => {
  const card = seed()
  card.payload.sync!.resolution = { deliveryId: 41, expectedToken: "claim-1", action: "retry", evidence: "Saved decision", messageId: "", owner, status: "requested" }
  const t = await fixture(false, card)
  try {
    await flush()
    expect(t.writes).toHaveLength(owner === "will" ? 1 : 0)
    if (owner === "will") {
      await t.agent.resolveIssueSync(card.id, 41, "retry", "Saved decision", "")
      expect(t.writes).toHaveLength(1)
    }
  } finally { await t.dispose() }
})

const resolvedRead = async (url: string) => Response.json(url.endsWith("/comments") ? [] : url.endsWith("/sync") ? {
  provider: "telegram", connection_id: "bot", scope_id: "123", conversation_id: "-100", state: "unsupported", delivery_id: 41
} : { number: 8, title: "Authoritative title", kind: "chat", state: "open", author: { login: "will" }, body: "", labels: [] })

test("successful resolution reads authoritative state without losing the comment draft", async () => {
  const t = await fixture()
  try {
    t.setRead(resolvedRead)
    await t.human.draftIssueComment(seed().id, "Unsent draft")
    await t.human.resolveIssueSync(seed().id, 41, "skip", "Verified externally", "")
    t.writes[0]!.answer.resolve(Response.json({}))
    await flush()
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
    await flush()
    expect(t.outcomes).toEqual([expect.stringContaining("Delivery resolved, but refreshing the card failed:")])
    expect(t.writes).toHaveLength(1)
  } finally { await t.dispose() }
})

test("a delayed success read cannot replace the next delivery's resolution", async () => {
  const t = await fixture()
  const reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    t.setRead(async url => { if (url.endsWith("/8")) { reading.resolve(); await release.promise }; return resolvedRead(url) })
    await t.human.resolveIssueSync(seed().id, 41, "skip", "First decision", "")
    t.writes[0]!.answer.resolve(Response.json({}))
    await reading.promise
    await t.store.dispatch({ type: "card.view.loaded", actor: "system", card: seed("claim-2") }).isPersisted.promise
    await t.agent.resolveIssueSync(seed().id, 41, "retry", "Second decision", "")
    release.resolve()
    await flush()
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
    await flush()
    expect(t.current().payload.sync).toMatchObject({ state: "outcome_unknown", resolutionToken: "claim-2" })
    expect(reads).toBe(0)
  } finally { await t.dispose() }
})
