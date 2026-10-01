import { expect, test } from "bun:test"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { AgentRuntimeContextSchema, AgentRuntimeSetupDraftSchema, composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import { agentVisibleCatalog } from "../flows/agentTools"
import { flowArgs } from "../flows/FlowArgs"
import type { StorageApi } from "@tanstack/db"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"
import type { AgentPort } from "../runtime/AgentPort"
import { setupContextSummary, setupQuestionCardId } from "./controller/repositorySetup"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { MAX_TURN_REQUEST_BYTES, turnRequestBytes } from "./AgentTurnPolicy"
import { memoryStorage, recordingAgent, scriptedToolAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const id = "setup:maintainer:example%2Frepo:issues"
// The digest the build before the trial's test request left the candidate computed for the canary's
// `feature` draft at revision 6, and the one its enabled registration still carries in the registry
// (flows/test/repository-stored-registration.test.ts).
const REGISTERED_DIGEST = "7d58fb03b7f0ed28a6ba637caacb19617776ea94925eea34b1a495887a2df04b"
const setupNames =["setup.guide", "setup.configure", "setup.view", "setup.work", "setup.run", "setup.discard", "setup.retry"]
const QUESTION = "Keep issue research, duplicate lookup and bug reproduction automatic?"
const CHOICES = ["Keep them automatic", "Ask me before each one runs", "Turn them off"]

const pendingHttpAgent = (requests: StartAgentTurnRequest[]): AgentPort => ({
  available: true, startTurn: async request => { requests.push(request); return { status: "started" } },
  cancelTurn: async () => {}, subscribe: () => () => {},
  journal: { subscribe: () => () => {}, disconnect: () => {}, retire: async () => {}, read: async () => ({ status: "error", code: "storage_failed" }) }
})

async function fixture(agent?: (requests: StartAgentTurnRequest[]) => AgentPort, beforeRecovery?: Promise<void>, settleRecovery = true, storage: StorageApi = memoryStorage()) {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", admin: false, scopesPlain: null }).isPersisted.promise
  const payload = { ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1234 }
  if (!store.collections.cards.has(id)) await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(), payload
  } }).isPersisted.promise
  const requests: StartAgentTurnRequest[] = [], fetches: { url: string; method: string }[] = []
  const controller = createAppController(store, agent?.(requests) ?? recordingAgent(requests), {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      const url = String(input), method = init?.method ?? "GET"
      fetches.push({ url, method })
      if (url.includes("/repository-setup/state?")) {
        if (beforeRecovery) await beforeRecovery
        return Response.json({ owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" } })
      }
      return Response.json({}, { status: 404 })
    }
  })
  if (settleRecovery) await waitFor(() => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" && card.payload.recovery?.state === "completed" })
  const call = (input: unknown) => controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify(input) })
  const close = async () => { await controller.dispose(); await store.dispose?.() }
  const guidance = () => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" ? card.payload.guidance : undefined }
  const setup = () => { const card = store.collections.cards.get(id)!; return card.kind === "repository-setup" ? card.payload : undefined! }
  const question = () => { const card = store.collections.cards.get(setupQuestionCardId(id)); return card?.kind === "flow-form" ? card : undefined }
  const untouched = () => !fetches.some(({ url, method }) => url.includes("/repository-setup") && method !== "GET")
  return { store, storage, payload, controller, requests, fetches, call, close, guidance, setup, question, untouched }
}

/*
 * A deterministic model that answers only from the turn it was given: it reads
 * the automatic step names out of its own composed instructions, and says the
 * production sentence when it finds none.
 */
const echoingAgent = (requests: StartAgentTurnRequest[]): AgentPort => scriptedToolAgent([request => {
  requests.push(request)
  const automatic = [...composeAgentInstructions(request.instructions, request.context).matchAll(/^ +- (.+?): automatic \|/gm)]
  return [{ type: "delta" as const, kind: "text" as const, text: automatic.length === 0
    ? "Nothing runs automatically—flows only start when you invoke them."
    : `Automatic in this setup: ${automatic.map(match => match[1]).join(", ")}.` },
    { type: "done" as const, reason: "stop" as const }]
}]).agent

const transcript = (store: Awaited<ReturnType<typeof createAppStore>>): string =>
  [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal).map(message => message.text).join("\n")

const conversationTurn = (requests: ReadonlyArray<StartAgentTurnRequest>) =>
  requests.find(request => request.purpose === undefined || request.purpose === "conversation")!

const askAndWait = async (t: Awaited<ReturnType<typeof fixture>>) => {
  await t.controller.commands.run("setup.guide", id)
  await waitFor(() => t.question() !== undefined && t.guidance()?.state === "admitted")
  return t.question()!
}

test("cloud setup controls are discoverable to the model and stay out of the human menu", async () => {
  const t = await fixture()
  try {
    const listed = JSON.parse(await t.call({ action: "list", namespace: "setup" }))
    const controls = listed.commands.filter((command: { name: string }) => command.name.startsWith("setup."))
    const names = controls.map((command: { name: string }) => command.name)
    expect(names).toEqual(setupNames)
    expect(controls.every((command: { args?: string }) => typeof command.args === "string")).toBe(true)
    expect(agentVisibleCatalog(t.controller.commands.callable()).filter(command => command.name.startsWith("setup.")).map(command => command.name)).toEqual(setupNames)
    expect(t.controller.commands.disclosed().filter(command => command.name.startsWith("setup.")).map(command => command.name)).toEqual(setupNames)
    expect(t.controller.commands.slashItems("setup.").some(item => setupNames.includes(item.flow.name))).toBe(false)
    // The question flow is the app's own act: invocable so the controller can
    // render the form, never offered to the model or to the slash menu.
    expect(t.controller.commands.callable().some(command => command.binding.descriptor.name === "setup.ask")).toBe(true)
    expect(t.controller.commands.slashItems("setup.ask")).toHaveLength(0)
    expect(JSON.stringify(listed)).not.toContain("setup.ask")
    const read = JSON.parse(await t.call({ action: "execute", name: "setup.guide", args: id }))
    expect(read).toMatchObject({ cardId: id, repo: "example/repo", job: "issues", revision: 1, inspectedAt: 1234, draft: t.payload.draft })
    expect(read.controls).toContainEqual(expect.objectContaining({ kind: "issue-filter", scopeField: "scope", labelField: "label", labelMeaning: "match-existing-label" }))
    expect(read.instruction).toContain("The app asks this setup's first question itself")
    // A model reading the guide never mints an unsolicited first-question intent.
    expect(t.guidance()).toBeUndefined()
    expect(t.question()).toBeUndefined()
    expect(t.requests).toHaveLength(0)
    expect(t.untouched()).toBe(true)
  } finally { await t.close() }
})

test.each(["ready", "recovering", "immediate"])("the app itself asks the first question while %s, with no provider turn", async phase => {
  let release!: () => void
  const beforeRecovery = new Promise<void>(resolve => { release = resolve })
  const t = await fixture(pendingHttpAgent, phase === "recovering" ? beforeRecovery : undefined, phase === "ready")
  try {
    if (phase === "recovering") await waitFor(() => t.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
    const outcome = await t.controller.commands.run("setup.guide", id)
    expect(outcome.status).not.toBe("failed")
    if (phase === "recovering") {
      expect(t.question()).toBeUndefined()
      const requested = t.guidance()
      await t.controller.commands.run("setup.guide", id)
      expect(t.guidance()).toEqual(requested)
    }
    release()
    await waitFor(() => t.question() !== undefined && t.guidance()?.state === "admitted")
    const card = t.question()!
    expect(card.title).toBe(QUESTION)
    expect(card.payload.flow).toBe("setup.ask")
    expect(card.payload.via).toBe("agent")
    expect(card.payload.fields.map(field => field.name)).toEqual(["choice"])
    expect(card.payload.fields[0]?.kind).toBe("select")
    expect(card.payload.fields[0]?.options?.map(option => option.label)).toEqual(CHOICES)
    // The answer is bound to the exact candidate it was asked about.
    expect(card.payload.given).toMatchObject({ cardId: id, questionId: "issues.steps.automatic", revision: 1, digest: setupCandidate(t.setup()) })
    expect(t.requests).toHaveLength(0)
    expect(t.store.collections.messages.size).toBe(0)
    expect([...t.store.collections.httpTurns.values()]).toHaveLength(0)
    expect(t.setup().draft).toEqual(t.payload.draft)
    expect(t.untouched()).toBe(true)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { release(); await t.close() }
})

test("the question is worded once: the card's title carries it, the select is named for the answer", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    const rendered = [card.title, ...card.payload.fields.flatMap(field =>
      [field.label, field.placeholder ?? "", ...(field.options ?? []).map(option => option.label)])].join("\n")
    expect(rendered.split(QUESTION)).toHaveLength(2)
    expect(card.title).toBe(QUESTION)
    expect(card.payload.fields.map(field => field.label)).toEqual(["Answer"])
  } finally { await t.close() }
})


test("the model command door cannot answer an already visible setup question", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const question = await askAndWait(t)
    const before = structuredClone(t.setup())
    const given = question.payload.given
    const answer = JSON.stringify({ ...given, choice: "approved" })
    const direct = await t.controller.commands.runAsAgent("setup.ask", answer)
    expect(direct).toMatchObject({ status: "failed", error: expect.stringContaining("human") })
    const envelope = await t.call({ action: "execute", name: "setup.ask", args: answer })
    expect(envelope).toContain("human")
    expect(t.setup().draft).toEqual(before.draft)
    expect(t.setup().revision).toBe(before.revision)
    expect(t.setup().guidance).toEqual(before.guidance)
    expect(t.question()?.status).toBe("active")
    expect(t.question()?.payload.draft).toEqual(question.payload.draft)
    expect(t.untouched()).toBe(true)
    expect(await t.store.verifyState()).toMatchObject({ valid: true })
    // The same candidate and choice still work through the human's form.
    expect(await t.controller.commands.run("form.set", `${question.id} choice approved`)).toMatchObject({ status: "executed" })
    expect(await t.controller.commands.run("form.submit", question.id)).toMatchObject({ status: "executed" })
    expect(t.setup().revision).toBe(before.revision + 1)
  } finally { await t.close() }
})

test("answering through the real form controller edits the draft only", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    expect(await t.controller.commands.run("form.set", `${card.id} choice approved`)).toMatchObject({ status: "executed" })
    expect(t.question()?.payload.draft).toEqual({ choice: "approved" })
    expect(await t.controller.commands.run("form.submit", card.id)).toMatchObject({ status: "executed" })
    await waitFor(() => t.question()?.status === "acted")
    const draft = t.setup().draft
    expect(draft.steps.map(step => step.mode)).toEqual(["approved", "approved", "approved", "manual", "manual", "manual"])
    expect(draft.label).toBe("")
    expect(draft.scope).toBe("future")
    expect(t.setup().request).toBeUndefined()
    expect(t.setup().evaluation).toBeUndefined()
    expect(t.setup().trial).toBeUndefined()
    expect(t.setup().active).toBeUndefined()
    expect(t.requests).toHaveLength(0)
    expect(t.untouched()).toBe(true)
    // A submitted question is closed: no second answer, and no re-ask.
    expect(await t.controller.commands.run("form.submit", card.id)).toMatchObject({ status: "failed", error: expect.stringContaining("already submitted") })
    expect(await t.controller.commands.run("form.set", `${card.id} choice off`)).toMatchObject({ status: "failed" })
    expect(t.question()?.status).toBe("acted")
    expect(t.setup().draft).toEqual(draft)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

test("a stale candidate refuses visibly in the card and edits nothing", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    await t.call({ action: "execute", name: "setup.configure", args: JSON.stringify({ cardId: id, field: "budgetMinutes", value: 45 }) })
    const before = structuredClone(t.setup().draft)
    await t.controller.commands.run("form.set", `${card.id} choice off`)
    await t.controller.commands.run("form.submit", card.id)
    await waitFor(() => t.question()?.payload.error !== undefined)
    expect(t.question()?.payload.error).toContain("changed after the question was asked")
    expect(t.question()?.status).toBe("error")
    expect(t.setup().draft).toEqual(before)
  } finally { await t.close() }
})

test("a second Configure in Chat points at the open question instead of resetting it", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    const intent = t.guidance()!
    await t.controller.commands.run("form.set", `${card.id} choice off`)
    await t.controller.commands.run("setup.guide", id)
    await t.store.settled?.()
    expect(t.guidance()).toEqual(intent)
    expect(t.question()?.payload.draft).toEqual({ choice: "off" })
    expect([...t.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
    expect(t.requests).toHaveLength(0)
  } finally { await t.close() }
})

test("a reload during admission re-admits the same question without re-rendering it", async () => {
  const storage = memoryStorage()
  const first = await fixture(pendingHttpAgent, undefined, true, storage)
  const card = await askAndWait(first)
  await first.controller.commands.run("form.set", `${card.id} choice off`)
  const intent = first.guidance()!
  // Reopen from the same disk with guidance still unacknowledged.
  const stored = first.store.collections.cards.get(id)!
  if (stored.kind !== "repository-setup") throw Error("setup card missing")
  await first.store.dispatch({ type: "card.upsert", actor: "system",
    card: { ...stored, payload: { ...stored.payload, guidance: { id: intent.id, state: "requested" } } } }).isPersisted.promise
  await first.close()
  const resumed = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    await waitFor(() => resumed.guidance()?.state === "admitted")
    expect(resumed.guidance()?.id).toBe(intent.id)
    expect(resumed.question()?.payload.draft).toEqual({ choice: "off" })
    expect(resumed.question()?.title).toBe(QUESTION)
    expect(resumed.requests).toHaveLength(0)
    expect((await resumed.store.verifyState()).valid).toBe(true)
  } finally { await resumed.close() }
})

test("a reload after the answer never re-asks and keeps the edit", async () => {
  const storage = memoryStorage()
  const first = await fixture(pendingHttpAgent, undefined, true, storage)
  const card = await askAndWait(first)
  await first.controller.commands.run("form.set", `${card.id} choice approved`)
  await first.controller.commands.run("form.submit", card.id)
  await waitFor(() => first.question()?.status === "acted")
  await first.close()
  const resumed = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    await resumed.store.settled?.()
    await resumed.store.dispatch({ type: "composer.changed", actor: "user", draft: "still usable" }).isPersisted.promise
    expect(resumed.guidance()?.state).toBe("admitted")
    expect(resumed.question()?.status).toBe("acted")
    expect(resumed.setup().draft.steps.slice(0, 3).map(step => step.mode)).toEqual(["approved", "approved", "approved"])
    expect(resumed.requests).toHaveLength(0)
    expect(resumed.store.session().draft).toBe("still usable")
  } finally { await resumed.close() }
})

test("a saved guide request survives a held recovery and full store/controller reopen", async () => {
  const storage = memoryStorage()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = await fixture(pendingHttpAgent, held, false, storage)
  await waitFor(() => first.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
  await first.controller.commands.run("setup.guide", id)
  const requested = first.guidance()!
  expect(requested.state).toBe("requested")
  expect(first.question()).toBeUndefined()
  await first.close(); release()
  const resumed = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    await waitFor(() => resumed.guidance()?.state === "admitted")
    expect(resumed.guidance()?.id).toBe(requested.id)
    expect(resumed.question()?.title).toBe(QUESTION)
    expect(resumed.requests).toHaveLength(0)
    expect((await resumed.store.verifyState()).valid).toBe(true)
  } finally { await resumed.close() }
})

test.each([1, 2])("the question is never asked twice after %s failed card writes", async failures => {
  const disk = memoryStorage()
  let remaining = 0, rejected = 0
  const storage: StorageApi = { ...disk, setItem: (key, value) => {
    if (key === ENVELOPE_STORAGE_KEY && remaining > 0) {
      const rows = JSON.parse(parseStorageEnvelope(value)!.entries["smithers-mvp.app-cards"] ?? "{}")
      if (rows[`s:${setupQuestionCardId(id)}`] !== undefined) { remaining--; rejected++; throw Error("Question card disk failure") }
    }
    disk.setItem(key, value)
  } }
  const t = await fixture(pendingHttpAgent, undefined, true, storage)
  try {
    remaining = failures
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => failures === 1
      ? t.question() !== undefined && t.guidance()?.state === "admitted"
      : t.guidance()?.state === "failed")
    await t.store.settled?.()
    expect(rejected).toBe(failures)
    // The chat never wedges on a failed question write.
    await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat remains editable" }).isPersisted.promise
    expect(t.store.session().draft).toBe("Chat remains editable")
    expect([...t.store.collections.cards.values()].filter(card => card.kind === "flow-form")).toHaveLength(failures === 1 ? 1 : 0)
    expect(t.requests).toHaveLength(0)
    if (failures === 2) {
      expect(t.guidance()?.error).toContain("could not be saved")
      await waitFor(() => [...t.store.collections.toasts.values()].some(toast => toast.key === "command.failed.setup.guide"))
      await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "" }).isPersisted.promise
      const retried = await t.controller.commands.run("setup.guide", id)
      expect(retried.status).not.toBe("failed")
      await waitFor(() => t.question() !== undefined)
    }
    expect(t.question()?.title).toBe(QUESTION)
    expect([...t.store.collections.cards.values()].filter(card => card.kind === "flow-form")).toHaveLength(1)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

test("an account change while discovery is held cannot render or recreate the prior account's question", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const t = await fixture(pendingHttpAgent, held, false)
  try {
    await waitFor(() => t.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
    await t.controller.commands.run("setup.guide", id)
    const requested = t.guidance()
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", admin: false, scopesPlain: null }).isPersisted.promise
    release(); await t.store.settled?.()
    await t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Other account question" }).isPersisted.promise
    expect(requested?.state).toBe("requested")
    expect(t.guidance()).toBeUndefined() // The identity boundary retires private cards.
    expect(t.question()).toBeUndefined()
    expect(t.requests).toHaveLength(0)
    expect(t.store.session().draft).toBe("Other account question")
  } finally { release(); await t.close() }
})

test("a refused answer can be asked again, and the fresh question is bound to the current draft", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    await t.call({ action: "execute", name: "setup.configure", args: JSON.stringify({ cardId: id, field: "budgetMinutes", value: 45 }) })
    await t.controller.commands.run("form.set", `${card.id} choice off`)
    await t.controller.commands.run("form.submit", card.id)
    await waitFor(() => t.question()?.status === "error")
    const stale = t.guidance()!
    // The refusal tells the user to ask again; asking again must ask again.
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => t.question()?.status === "active")
    expect(t.guidance()?.id).not.toBe(stale.id)
    expect(t.question()?.payload.given).toMatchObject({ revision: t.setup().revision, digest: setupCandidate(t.setup()) })
    expect(t.question()?.payload.error).toBeUndefined()
    expect([...t.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
    // And that fresh question answers.
    await t.controller.commands.run("form.set", `${t.question()!.id} choice off`)
    await t.controller.commands.run("form.submit", t.question()!.id)
    await waitFor(() => t.question()?.status === "acted")
    expect(t.setup().draft.steps.slice(0, 3).map(step => step.mode)).toEqual(["off", "off", "off"])
    expect(t.setup().draft.budgetMinutes).toBe(45)
    expect(t.requests).toHaveLength(0)
  } finally { await t.close() }
})

test("an answered question can be asked again, and the next question is offered", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    await t.controller.commands.run("form.set", `${card.id} choice approved`)
    await t.controller.commands.run("form.submit", card.id)
    await waitFor(() => t.question()?.status === "acted")
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => t.question()?.status === "active")
    // issues.steps.automatic is no longer offerable, so the next one is.
    expect(t.question()?.payload.given).toMatchObject({ questionId: "issues.landing", digest: setupCandidate(t.setup()) })
    expect(t.question()?.title).toBe("Land an issue fix after its checks pass, or ask you first?")
    expect([...t.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
    expect(t.requests).toHaveLength(0)
  } finally { await t.close() }
})

test("a question card carrying another candidate's digest never suppresses the app's own question", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    // What an agent that guessed the undisclosed flow name could leave behind.
    expect(await t.call({ action: "execute", name: "setup.ask",
      args: JSON.stringify({ cardId: id, questionId: "issues.landing", revision: 99, digest: "0".repeat(64) }) })).toContain("rendered a form")
    expect(t.question()?.payload.given).toMatchObject({ digest: "0".repeat(64) })
    await t.controller.commands.run("setup.guide", id)
    await waitFor(() => t.question()?.payload.given["digest"] === setupCandidate(t.setup()))
    expect(t.question()?.title).toBe(QUESTION)
    expect(t.question()?.payload.given).toMatchObject({ questionId: "issues.steps.automatic", revision: 1 })
    expect(t.guidance()?.state).toBe("admitted")
    expect([...t.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
  } finally { await t.close() }
})

test("a controller disposed before the idle window renders no question", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const t = await fixture(pendingHttpAgent, held, false)
  await waitFor(() => t.fetches.some(({ url }) => url.includes("/repository-setup/state?")))
  await t.controller.commands.run("setup.guide", id)
  expect(t.guidance()?.state).toBe("requested")
  await t.controller.dispose()
  release()
  await t.store.settled?.()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(t.question()).toBeUndefined()
  expect(t.requests).toHaveLength(0)
  await t.store.dispose?.()
})

test("a specific change asked in chat stays usable beside the question, and pruned tool history changes nothing", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    // The model's own door still works while the app's question is open.
    expect(await t.call({ action: "execute", name: "setup.configure", args: JSON.stringify({ cardId: id, field: "landing", value: "checks" }) })).toContain("Draft updated")
    expect(t.setup().draft.landing).toBe("checks")
    expect(t.question()?.status).toBe("active")
    /*
     * Whether the question was asked is the durable card and the guidance
     * receipt, never a tool-call row: pruned or absent tool history (there is
     * none here at all) changes nothing.
     */
    expect(t.store.collections.toolCalls.size).toBe(0)
    await t.store.settled?.()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect([...t.store.collections.cards.values()].filter(row => row.kind === "flow-form")).toHaveLength(1)
    expect(t.question()?.id).toBe(card.id)
    expect(t.requests).toHaveLength(0)
    // The user can close the question without answering it; nothing re-opens it.
    expect(await t.controller.commands.run("card.dismiss", card.id)).toMatchObject({ status: "executed" })
    await t.store.settled?.()
    expect(t.question()).toBeUndefined()
    expect(t.guidance()?.state).toBe("admitted")
  } finally { await t.close() }
})

test("the chat prompt keeps the setup handoff, states that the app asks, and stays under the request limit", async () => {
  const t = await fixture()
  try {
    await t.controller.send("what is set up for this repo?")
    await waitFor(() => t.requests.length > 0)
    const request = t.requests[0]!
    expect(request.instructions).toContain("Current repository setup cards:")
    expect(request.instructions).toContain(JSON.stringify({ cardId: id, repo: "example/repo", job: "issues", revision: 1, digest: setupCandidate(t.payload), inspectedAt: 1234, state: "draft" }))
    expect(request.instructions).toContain('"name":"setup.guide","args":"<cardId>"')
    for (const control of setupNames) {
      const command = agentVisibleCatalog(t.controller.commands.callable()).find(command => command.name === control)!
      expect(request.instructions).toContain(`- /${control} ${command.args} — ${command.summary}`)
    }
    expect(request.instructions).toContain("The app asks this setup's first question itself")
    expect(request.instructions).not.toContain("one short question at a time")
    expect(request.instructions).not.toContain("setup.ask")
    expect(turnRequestBytes(request)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
  } finally { await t.close() }
})

/*
 * The kickoff turn that used to name this card id in the user's own message is
 * gone, so a setup compacted out of the recent window is no longer carried into
 * the prompt by a mention. What must still hold is that nothing injects the
 * draft's full prompts or its held-out eval answers, at any window position.
 */
test("a compacted setup card injects no full prompts or eval answers, and a named one still carries its identity", async () => {
  const t = await fixture()
  try {
    const marker = "DO-NOT-INJECT-FULL-DRAFT-OR-HELDOUT-ANSWER"
    await t.controller.configureRepositorySetup(id, "step.research.prompt", marker.repeat(100))
    for (let index = 0; index < 15; index++) {
      await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: `recent-file-${index}`, kind: "file", title: `File ${index}`, status: "active", createdAt: 2, ordinal: t.store.nextOrdinal(),
        payload: { repo: "example/repo", path: `file-${index}.md`, content: "Source", truncated: false }
      } }).isPersisted.promise
    }
    await t.controller.send("summarize the setup")
    await waitFor(() => t.requests.length > 0)
    const compacted = t.requests[0]!
    expect(compacted.context?.recentCards?.some(card => card.id === id)).toBe(false)
    expect(compacted.instructions).not.toContain(marker)
    expect(turnRequestBytes(compacted)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
    await waitFor(() => t.store.session().phase === "idle")
    await t.controller.send(`what is set up in ${id}?`)
    await waitFor(() => t.requests.length > 1)
    const named = t.requests[1]!
    expect(named.instructions).toContain(`"cardId":"${id}"`)
    expect(named.instructions).toContain('"revision":2')
    expect(named.instructions).not.toContain(marker)
  } finally { await t.close() }
})

test("setup authority refreshes after an edit and never includes another account's card", async () => {
  const t = await fixture()
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: "foreign-setup", kind: "repository-setup", title: "Other setup", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
      payload: { ...initialSetup("other/private", "issues", "other"), inspectedAt: 5 }
    } }).isPersisted.promise
    await t.call({ action: "execute", name: "setup.configure", args: JSON.stringify({ cardId: id, field: "step.research.mode", value: "manual" }) })
    const read = JSON.parse(await t.call({ action: "execute", name: "setup.guide", args: id }))
    expect(read.revision).toBe(2)
    expect(read.draft.steps.find((step: { id: string }) => step.id === "research").mode).toBe("manual")
    await t.controller.send("what changed?")
    await waitFor(() => t.requests.length > 0)
    const line = t.requests[0]!.instructions.split("\n").find(line => line.startsWith("Current repository setup cards:"))!
    const cards = JSON.parse(line.slice("Current repository setup cards: ".length))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ cardId: id, revision: 2, digest: setupCandidate(t.setup()) })
    expect(line).not.toContain("other/private")
    expect(await t.call({ action: "execute", name: "setup.guide", args: "foreign-setup" })).toContain("different account")
  } finally { await t.close() }
})

/*
 * R96b B1. The canary's enabled `feature` registration sits at revision 6 under
 * the digest the build before this chain wrote; Plue keeps that digest and
 * dispatches from it verbatim. This line is the model's only reading of that
 * row, so recomputing the candidate and comparing for equality tells it a
 * running registration is a draft — the state the walk's "Nothing runs
 * automatically" answer was built on.
 */
test("an enabled registration keeps its state in the turn under the identity it was registered with", async () => {
  const t = await fixture()
  try {
    const registered = "setup:maintainer:codeplanesmithers%2Fcanary-sandbox:feature"
    const payload = { ...initialSetup("codeplanesmithers/canary-sandbox", "feature", "maintainer"), revision: 6, inspectedAt: 1234,
      active: { revision: 6, digest: REGISTERED_DIGEST, registrationId: "canary-feature", sourceRevision: "c2556c7da43868894aa8368a01d7d1ce2c736d0f", enabled: true, owned: true } }
    expect(setupCandidate(payload)).not.toBe(REGISTERED_DIGEST)
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: registered, kind: "repository-setup", title: "Ship a feature", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(), payload } }).isPersisted.promise
    await t.controller.send(`what is set up in ${registered}?`)
    await waitFor(() => t.requests.length > 0)
    const card = t.store.collections.cards.get(registered)!
    expect(card.kind === "repository-setup" && card.payload.active?.digest).toBe(REGISTERED_DIGEST)
    const line = conversationTurn(t.requests).instructions.split("\n").find(line => line.startsWith("Current repository setup cards:"))!
    const cards = JSON.parse(line.slice("Current repository setup cards: ".length))
    expect(cards.find((row: { cardId: string }) => row.cardId === registered)).toMatchObject({ revision: 6, state: "enabled" })
  } finally { await t.close() }
})

/*
 * The canary walk's Job 1 "Ordinary chat question": beside the open issues card
 * with research, duplicates and reproduce all `automatic`, "what will run
 * automatically?" was answered "Nothing runs automatically—flows only start
 * when you invoke them.", then "Nothing runs on its own." The draft reached the
 * model only through the setup.guide TOOL, which the prompt tells it to call for
 * a setup guide request — so an ordinary question was answered about flows in
 * general and contradicted the card beside it.
 */
test("a chat question beside the open setup carries that setup's real draft into the turn", async () => {
  const t = await fixture()
  try {
    await t.controller.configureRepositorySetup(id, "cases", [{ id: "c1", name: "Opened issue asks what this repository is for",
      input: "What is this repository for?", expected: "HELD-OUT-ANSWER-NEVER-IN-A-TURN", required: true }])
    await t.controller.send("what will run automatically?")
    await waitFor(() => t.requests.length > 0)
    const request = conversationTurn(t.requests)
    const seen = composeAgentInstructions(request.instructions, request.context)
    for (const name of ["Research issue", "Find duplicates", "Reproduce bugs"]) expect(seen).toContain(`- ${name}: automatic`)
    for (const name of ["Quick POC", "Fix for real", "Split issue"]) expect(seen).toContain(`- ${name}: manual`)
    expect(seen).toContain("Classify the issue and inspect relevant source")
    expect(seen).toContain("apply to new and edited issues")
    expect(seen).toContain("landing ask")
    expect(seen).toContain("time limit 10 minutes")
    expect(seen).toContain("Run evals for this draft.")
    // A held-out eval answer is never carried into a turn, at any window position.
    expect(seen).not.toContain("HELD-OUT-ANSWER-NEVER-IN-A-TURN")
    expect(turnRequestBytes(request)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
  } finally { await t.close() }
})

test("a model answering only from that turn names the automatic steps instead of denying them", async () => {
  const t = await fixture(echoingAgent)
  try {
    await t.controller.send("what will run automatically?")
    await waitFor(() => transcript(t.store).includes("Automatic in this setup") || transcript(t.store).includes("Nothing runs automatically"))
    expect(transcript(t.store)).toContain("Automatic in this setup: Research issue, Find duplicates, Reproduce bugs.")
    expect(transcript(t.store)).not.toContain("Nothing runs automatically")
  } finally { await t.close() }
})

/*
 * Each context metadata string is one instruction line and carries no CR or LF
 * (packages/rpc/docs/agent-context.md); AgentRuntimeContextSchema enforces it
 * and the server answers a context that fails it with 400. A draft's label is
 * free text with no newline rule, so without the collapse every question asked
 * beside a label-scoped card came back as a failed turn instead of an answer.
 */
test("a newline in the draft's label still posts a context the boundary accepts", async () => {
  const t = await fixture()
  try {
    await t.controller.configureRepositorySetup(id, "scope", "label")
    await t.controller.configureRepositorySetup(id, "label", "needs\ninvestigation")
    expect(t.setup().draft.label).toBe("needs\ninvestigation")
    await t.controller.send("what will run automatically?")
    await waitFor(() => t.requests.length > 0)
    const request = conversationTurn(t.requests)
    expect(AgentRuntimeContextSchema.safeParse(request.context).success).toBe(true)
    expect(request.context?.recentCards?.find(card => card.id === id)?.setup?.applyTo).toBe('issues labeled "needs investigation"')
    expect(composeAgentInstructions(request.instructions, request.context)).toContain('apply to issues labeled "needs investigation"')
  } finally { await t.close() }
})

/*
 * A step name and an eval case name reach the draft from the repository
 * inspection's own suggestedDraft, not only from a person, and neither has a
 * newline rule either. Every string this summary emits is collapsed.
 */
test("every string the summary emits is one line, including a step name and a gate", () => {
  const setup = initialSetup("example/repo", "chores", "maintainer")
  setup.draft.steps = [{ ...setup.draft.steps[0]!, name: "Tidy\r\nthe repository", mode: "automatic" }]
  setup.draft.schedule = "0 9\n* * 1"
  setup.draft.choreEvent = "labeled"
  setup.draft.label = "needs\ninvestigation"
  setup.draft.cases = [{ id: "weekly", name: "A weekly\ntidy", input: "Tidy the repository", expected: "A checked proposal", required: true }]
  const digest = setupCandidate(setup)
  const summary = setupContextSummary({ ...setup, evaluation: { requestId: "eval", runId: "eval-run", operation: "evaluate",
    revision: setup.revision, digest, phase: "completed", updatedAt: 1, results: [], evidence: ["artifact:eval"], sourceRevision: "commit-1" } })
  expect(AgentRuntimeSetupDraftSchema.safeParse(summary).success).toBe(true)
  expect(summary.steps[0]!.name).toBe("Tidy the repository")
  expect(summary.trigger).toBe('cron 0 9 * * 1 UTC, on issues labeled "needs investigation"')
  expect(summary.gate).toBe("Resolve eval: A weekly tidy.")
})

/*
 * R88 follow-up 3: the button and the slash are the same act as the agent's
 * door, so the human's own invocation posts the confirmation the model's
 * invocation posts, and the draft survives until they answer it.
 */
test("the human's own discard door confirms before the draft goes", async () => {
  const t = await fixture()
  try {
    const applied = t.setup().draft
    const active = { revision: t.setup().revision, digest: setupCandidate(t.setup()), registrationId: "active-1",
      sourceRevision: "commit-1", enabled: true, owned: true, draft: applied }
    const card = t.store.collections.cards.get(id)!
    await t.store.dispatch({ type: "card.upsert", actor: "system",
      card: { ...card, kind: "repository-setup", payload: { ...t.setup(), active } } }).isPersisted.promise
    await t.controller.commands.run("setup.configure", JSON.stringify({ cardId: id, field: "budgetMinutes", value: 30 }))
    const edited = t.setup()
    expect(edited.revision).toBe(active.revision + 1)
    const outcome = await t.controller.commands.run("setup.discard", id)
    expect(outcome).toEqual({ status: "executed", value: expect.stringContaining("nothing has happened yet") })
    expect(t.setup()).toEqual(edited)
    const confirmation = [...t.store.collections.messages.values()].find(message => message.action?.flow === "setup.discard.confirm")
    expect(confirmation?.text).toBe("Discard the draft and keep the enabled configuration?")
    expect(confirmation?.action?.args).toBe(id)
    await t.controller.commands.run(confirmation!.action!.flow, confirmation!.action!.args)
    expect(t.setup().revision).toBe(active.revision)
    expect(t.setup().draft).toEqual(applied)
    expect(t.untouched()).toBe(true)
  } finally { await t.close() }
})

/*
 * Walk run 3, C3-N5: `Run evals`, pressed while the setup's first question was
 * still open, sent no request for fourteen minutes and said nothing — the
 * footer went on asking for the evals the door would not run. The question is
 * asked about the exact candidate an evaluate, trial or apply submits, so the
 * door refuses that press where the person is looking instead of swallowing it.
 */
test("an operation on the candidate the open question is about refuses at once, and says so", async () => {
  const t = await fixture(pendingHttpAgent)
  try {
    const card = await askAndWait(t)
    const outcome = await t.controller.commands.run("setup.run", JSON.stringify({ cardId: id, operation: "evaluate" }))
    expect(outcome).toEqual({ status: "failed", error: "Answer the setup question first." })
    expect(transcript(t.store)).toContain("Answer the setup question first.")
    expect(t.setup().request).toBeUndefined()
    expect(t.untouched()).toBe(true)
    await t.controller.commands.run("form.set", `${card.id} choice approved`)
    await t.controller.commands.run("form.submit", card.id)
    await waitFor(() => t.question()?.status === "acted")
    await t.controller.commands.run("setup.run", JSON.stringify({ cardId: id, operation: "evaluate" }))
    expect(t.setup().request?.operation).toBe("evaluate")
    await waitFor(() => t.fetches.some(({ url, method }) => url.includes("/repository-setup/evaluate") && method === "POST"))
  } finally { await t.close() }
})

/*
 * Walk run 3, B3-N5: `When to run Fix for real` was set to `Automatic`, the
 * select went back to `Manual`, and the durable draft never carried the mode.
 * The card projects the draft, so a refused edit shows up as that revert and
 * nothing else — the door's own sentence reached the person as a toast that
 * leaves after four seconds. It goes to the transcript too, where they are
 * still looking. The accepted half is the evidence that the write path itself
 * carries a step mode: the same args the card's select dispatches.
 */
test("a draft edit moves the durable draft, and one that is refused says so where the person is looking", async () => {
  const t = await fixture()
  try {
    const before = t.setup().revision
    const accepted = await t.controller.commands.run("setup.configure", flowArgs("setup.configure", { cardId: id, field: "step.fix.mode", value: "automatic" }))
    expect(accepted).toEqual({ status: "executed", value: "Draft updated." })
    expect(t.setup().draft.steps.find(step => step.id === "fix")?.mode).toBe("automatic")
    expect(t.setup().revision).toBe(before + 1)
    const refused = await t.controller.commands.run("setup.configure", flowArgs("setup.configure", { cardId: id, field: "replies", value: "automatic" }))
    expect(refused).toEqual({ status: "failed", error: "Automatic replies are not available in this setup." })
    expect(transcript(t.store)).toContain("Automatic replies are not available in this setup.")
    expect(t.setup().draft.replies).toBe("draft")
    expect(t.setup().revision).toBe(before + 1)
  } finally { await t.close() }
})
