import { createOperationalFailureReporter } from "../OperationalFailures"
import { browserWriteRefusal } from "../BrowserWriteFailure"
import { StorageWriteFailedError } from "../StorageRecoveryContract"
import { presentAppFailure } from "./AppFailure"
import { expect, spyOn, test } from "bun:test"
import { editSetup, initialSetup, setupActivationProblems, setupCandidate, type RepositorySetup, type SetupManualRequest, type SetupDraft, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { createAppStore } from "../AppStore"
import { memoryStorage, recordingAgent } from "../TestFixtures"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"
import { applySetupEdit, createRepositorySetupController, projectRecoveredSetup, setupContextSummary, type RepositorySetupDependencies } from "./repositorySetup"
import { cardContainsRun, runScopeFromCard } from "../RunReference"
import { REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import { RECEIPT_CODES, setupFailureSentence } from "../RunFailure"
import { failureDetail } from "@smthrs/rpc/UserFailure"

type Body = { requestId: string; repo: string; job: string; revision: number; digest: string; draft: SetupDraft; workspaceId?: string; manual?: SetupManualRequest }
const workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
const response = (body: Body, phase = "completed", operation = "evaluate") => Response.json({
  requestId: body.requestId, revision: body.revision, digest: body.digest, workspaceId,
  receipt: { requestId: body.requestId, runId: "run-1", revision: body.revision, digest: body.digest,
    operation, phase, updatedAt: 1, results: [], evidence: ["run:run-1"], ...(phase === "failed" ? { error: "Model unavailable" } : {}) }
})
const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}
async function fixture(answer: (body: Body, method: string) => Promise<Response>, storage = memoryStorage(), dependencies?: RepositorySetupDependencies) {
  const store = await createAppStore({ kind: "localStorage", storage })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", allowlisted: true, admin: false, scopesPlain: null })
  if (!store.collections.cards.get("setup")) await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: { ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1 }
  } }).isPersisted.promise
  const calls: Array<{ method: string; body: Body }> = []
  const recovery = { calls: [] as string[], answer: async (repo: string, job: string): Promise<Response> => Response.json({ owner: "maintainer", repo, job, registration: { state: "known" }, setup: { state: "none" } }) }
  const disposers: Array<() => void> = []
  const background: Promise<unknown>[] = []
  // The one seam the controller uses to render its own question: the real
  // registry lives in AppController, so here it is recorded, not executed.
  const asked: Array<{ name: string; args: string }> = []
  let holdAsk: Promise<void> | undefined
  let previous: Body
  const ctx = { failures: createOperationalFailureReporter(), store, commandActor: "user", baseUrl: "", workflowPollMs: 5, toastRuns: new Map(),
    commands: { runAsAgent: async (name: string, args: string) => {
      asked.push({ name, args })
      if (holdAsk) await holdAsk
      return { status: "form" as const, flow: name, cardId: `form-${name}`, fields: ["choice"] }
    } },
    toastDebounceMs: 5, toastAutoDismissMs: 10000, accountEpoch: 0, disposed: false, unref: () => {},
    onDispose: (close: () => void) => { disposers.push(close) },
    errorMessageOf: async () => "The host refused the request.",
    boundedFetch: async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (_url.includes("/state?")) {
        recovery.calls.push(_url)
        const url = new URL(_url, "https://app.test")
        return recovery.answer(url.searchParams.get("repo")!, url.searchParams.get("job")!)
      }
      const selected = _url.includes("/observe?") ? [...store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.payload.request?.id === new URL(_url, "https://app.test").searchParams.get("requestId")) : undefined
      const observed = selected?.kind === "repository-setup" ? selected.payload : undefined
      const body = init?.body ? JSON.parse(String(init.body)) as Body : observed?.request ? {
        requestId: observed.request.id, repo: observed.repo, job: observed.job, revision: observed.request.revision, digest: observed.request.digest, draft: observed.draft, workspaceId: observed.workspaceId
      } : previous!
      previous = body
      calls.push({ method, body })
      return answer(body, method)
    }
  } as unknown as ControllerContext
  const failures = createFailureController(ctx)
  ctx.withToast = ((...args: Parameters<typeof failures.withToast>) => {
    const work = failures.withToast(...args); background.push(work); return work
  }) as typeof ctx.withToast
  const setup = createRepositorySetupController(ctx, dependencies)
  const state = () => (store.collections.cards.get("setup") as { payload: RepositorySetup }).payload
  const close = async () => { disposers.forEach(dispose => dispose()); await store.settled?.(); await store.dispose?.() }
  return { store, storage, calls, recovery, background, setup, state, close, ctx, asked,
    holdAsk: (promise: Promise<void>) => { holdAsk = promise } }
}

const doors = (overrides: Partial<RepositorySetupDependencies> = {}): RepositorySetupDependencies => ({
  promptSignIn: () => {}, chooseRepository: async () => {}, openRun: async () => {}, send: async () => true, guidanceFailed: () => {}, ...overrides
})

test("setup acknowledges persisted intent before launch, deduplicates it, and keeps Chat usable", async () => {
  const gate = deferred()
  const t = await fixture(async body => { await gate.promise; return response(body) })
  try {
    const result = await Promise.race([t.setup.runRepositorySetup("setup", "evaluate"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(result).not.toBe("blocked")
    expect(t.state().request?.state).toBe("requested")
    await t.setup.runRepositorySetup("setup", "evaluate")
    expect(t.calls).toHaveLength(1)
    await t.setup.viewRepositorySetup("setup", "prompts", "research")
    expect(t.state().view).toBe("prompts")
    expect(t.store.session().phase).not.toBe("responding")
    await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
    gate.release(); await Promise.all(t.background)
    expect(t.state().request?.state).toBe("completed")
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["ok"])
  } finally { gate.release(); await t.close() }
})

test("an unresolved launch keeps one durable admission across different button presses", async () => {
  const launch = deferred()
  const t = await fixture(async body => { await launch.promise; return response(body) })
  try {
    const admitted = await t.setup.runRepositorySetup("setup", "evaluate")
    const request = t.state().request!
    expect(admitted).toEqual({ value: "Handle issues: evaluate requested in the background." })
    expect(request).toMatchObject({ operation: "evaluate", state: "requested", revision: t.state().revision })
    expect(request.digest).toBe(setupCandidate(t.state()))
    expect(t.calls.map(call => call.body.requestId)).toEqual([request.id])

    for (const operation of ["evaluate", "trial", "inspect"] as const) {
      expect(await t.setup.runRepositorySetup("setup", operation)).toEqual({ value: "The setup request is already running in the background." })
      expect(t.state().request).toEqual(request)
    }
    expect(t.calls.map(call => [call.method, call.body.requestId])).toEqual([["POST", request.id]])
    await t.setup.viewRepositorySetup("setup", "prompts", "research")
    expect(t.state().view).toBe("prompts")
    expect(t.store.session().phase).toBe("idle")
    await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
    expect(t.state().receipt).toBeUndefined()
    launch.release(); await Promise.all(t.background)
    expect(t.state().request).toMatchObject({ id: request.id, state: "completed" })
    expect(t.state().evaluation).toMatchObject({ requestId: request.id, phase: "completed" })
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["ok"])
  } finally { launch.release(); await t.close() }
})

test.each(["failed", "stopped"] as const)("a running remote job settling %s leaves visible evidence and permits a new attempt", async phase => {
  const observation = deferred()
  let retrying = false
  const t = await fixture(async (body, method) => {
    if (retrying) return response(body)
    if (method === "POST") return response(body, "running")
    await observation.promise
    return response(body, phase)
  })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate")
    const requestId = t.state().request!.id
    await until(() => t.calls.some(call => call.method === "GET"))
    expect(t.state().request).toMatchObject({ id: requestId, state: "running" })
    expect(t.state().evaluation).toMatchObject({ requestId, phase: "running" })
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["running"])
    observation.release(); await Promise.all(t.background)
    expect(t.state().request).toMatchObject({ id: requestId, state: "failed" })
    expect(t.state().evaluation).toMatchObject({ requestId, phase })
    expect(t.state().previousReceipts.map(receipt => [receipt.requestId, receipt.phase])).toEqual([[requestId, phase]])
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["failed"])
    retrying = true
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.state().request).toMatchObject({ state: "completed" })
    expect(t.state().request!.id).not.toBe(requestId)
    expect(t.calls.map(call => [call.method, call.body.requestId])).toEqual([["POST", requestId], ["GET", requestId], ["POST", t.state().request!.id]])
    expect(t.state().previousReceipts.map(receipt => [receipt.requestId, receipt.phase])).toEqual([[requestId, phase]])
  } finally { observation.release(); await t.close() }
})

test("setup edits reject invalid values without changing the candidate", () => {
  const draft = initialSetup("example/repo", "issues", "maintainer").draft
  const invalid: Array<[string, unknown, string]> = [
    ["replies", "automatic", "Automatic replies are not available in this setup."],
    ["budgetMinutes", 0, "The setting does not match the expected value."],
    ["step.missing.prompt", "Run checks", "That flow is not in this setup."],
    ["check.missing.rule", "test -f README.md", "That check is not in this setup."],
    ["case.missing.expected", "Passed", "That case is not in this setup."],
    ["checks.remove", "missing", "That check is not in this setup."],
    ["active", true, "That setting cannot be edited."],
    ["trial.number", -1, "This trial does not select a PR."]
  ]
  for (const [field, value, sentence] of invalid) {
    expect(applySetupEdit(draft, "issues", field, value)).toEqual({ error: sentence })
    expect(draft).toEqual(initialSetup("example/repo", "issues", "maintainer").draft)
  }
  const check = { id: "docs", name: "Docs", kind: "command" as const, rule: "test -f README.md", paths: ["README.md"], policy: "required" as const }
  const added = applySetupEdit(draft, "issues", "checks.add", check)
  expect(added).toHaveProperty("draft")
  if (!("draft" in added)) throw Error("check was not added")
  expect(added.draft.checks).toEqual([check])
  expect(applySetupEdit(added.draft, "issues", "checks.remove", "docs")).toEqual({ draft })
  expect(draft.checks).toEqual([])
})

test("check and case field edits affect only the named item and pin a changed case", () => {
  const base = initialSetup("example/repo", "issues", "maintainer").draft
  const check = { id: "docs", name: "Docs", kind: "command" as const, rule: "test -f README.md", paths: ["README.md"], policy: "report" as const }
  const other = { ...check, id: "types", name: "Types", rule: "pnpm typecheck" }
  const caseOne = { id: "one", name: "One", input: "A bug", expected: "A fix", required: true }
  const caseTwo = { ...caseOne, id: "two", name: "Two", input: "Another bug" }
  const draft = { ...base, checks: [check, other], cases: [caseOne, caseTwo] }
  const changedCheck = applySetupEdit(draft, "issues", "check.docs.policy", "required")
  expect(changedCheck).toHaveProperty("draft")
  if (!("draft" in changedCheck)) throw Error("check edit failed")
  expect(changedCheck.draft.checks).toEqual([{ ...check, policy: "required" }, other])
  const changedCase = applySetupEdit(changedCheck.draft, "issues", "case.two.expected", "A reproduction")
  expect(changedCase).toHaveProperty("draft")
  if (!("draft" in changedCase)) throw Error("case edit failed")
  expect(changedCase.draft.cases).toEqual([caseOne, { ...caseTwo, expected: "A reproduction", edited: true }])
  expect(draft).toEqual({ ...base, checks: [check, other], cases: [caseOne, caseTwo] })
})

test("runtime setup summary bounds prompt text and describes each job's actual trigger", () => {
  const issues = initialSetup("example/repo", "issues", "maintainer")
  const longPrompt = `  First line\n${"a".repeat(100)}  `
  const labeled = { ...issues, draft: { ...issues.draft, scope: "label" as const, label: "maintainer-ready",
    steps: issues.draft.steps.map((step, index) => index === 0 ? { ...step, prompt: longPrompt } : step) } }
  const issueSummary = setupContextSummary(labeled)
  expect(issueSummary.applyTo).toBe('issues labeled "maintainer-ready"')
  expect(issueSummary.steps[0]?.prompt).toBe(`First line ${"a".repeat(69)}…`)
  expect(issueSummary.steps[0]?.prompt).not.toContain("\n")
  expect(issueSummary.gate).toBe("Run evals for this draft.")
  expect(setupContextSummary(issues).applyTo).toBe("new and edited issues")

  const chores = initialSetup("example/repo", "chores", "maintainer")
  for (const [schedule, choreEvent, expected] of [
    ["", "none", "no schedule, no repository event"],
    ["0 9 * * 1", "push", "cron 0 9 * * 1 UTC, on push to the default branch"],
    ["0 9 * * 1", "labeled", 'cron 0 9 * * 1 UTC, on issues labeled "maintainer-ready"']
  ] as const) {
    expect(setupContextSummary({ ...chores, draft: { ...chores.draft, schedule, choreEvent, label: "maintainer-ready" } }).trigger).toBe(expected)
  }
  expect(setupContextSummary(initialSetup("example/repo", "review", "maintainer")).applyTo).toBeUndefined()
})

test("a setup answer is bound to its question, candidate, and offered choice", async () => {
  const t = await fixture(async body => response(body))
  try {
    const before = t.state()
    const digest = setupCandidate(before)
    expect(await t.setup.answerRepositorySetupQuestion("absent", "issues.budget", before.revision, digest, "m30")).toBe("Open the setup first.")
    expect(await t.setup.answerRepositorySetupQuestion("setup", "absent", before.revision, digest, "m30")).toBe("That question is not part of this setup.")
    expect(await t.setup.answerRepositorySetupQuestion("setup", "issues.budget", before.revision, digest, "absent")).toBe("Choose one of the offered answers.")
    expect(await t.setup.answerRepositorySetupQuestion("setup", "issues.budget", before.revision + 1, digest, "m30"))
      .toBe("This setup changed after the question was asked. Ask for setup guidance again to see the current question.")
    expect(await t.setup.answerRepositorySetupQuestion("setup", "issues.budget", before.revision, "stale", "m30"))
      .toBe("This setup changed after the question was asked. Ask for setup guidance again to see the current question.")
    expect(t.state()).toEqual(before)
    expect(await t.setup.answerRepositorySetupQuestion("setup", "issues.budget", before.revision, digest, "keep"))
      .toEqual({ value: "Keeping the current setup." })
    expect(t.state()).toEqual(before)
    expect(await t.setup.answerRepositorySetupQuestion("setup", "issues.budget", before.revision, digest, "m30"))
      .toEqual({ value: "Draft updated." })
    expect(t.state().draft.budgetMinutes).toBe(30)
    expect(t.state().revision).toBe(before.revision + 1)
    expect(t.calls).toEqual([])
    expect(await t.setup.answerRepositorySetupQuestion("setup", "issues.budget", before.revision, digest, "m60"))
      .toBe("This setup changed after the question was asked. Ask for setup guidance again to see the current question.")
    expect(t.state().draft.budgetMinutes).toBe(30)
  } finally { await t.close() }
})

test("an open setup question refuses candidate execution in the transcript without launching work", async () => {
  const t = await fixture(async body => response(body))
  try {
    const prior = t.state()
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "form-setup.ask:setup", kind: "flow-form", title: "Setup question", status: "active", createdAt: 2,
      ordinal: t.store.nextOrdinal(), payload: { flow: "setup.ask", via: "agent", fields: [], draft: {}, given: { digest: setupCandidate(prior) } }
    } }).isPersisted.promise
    for (const operation of ["evaluate", "trial", "apply"] as const) {
      expect(await t.setup.runRepositorySetup("setup", operation)).toBe("Answer the setup question first.")
      expect(t.state()).toEqual(prior)
    }
    expect(t.calls).toEqual([])
    expect([...t.store.collections.messages.values()].filter(message => message.text === "Answer the setup question first.")).toHaveLength(3)
    await t.setup.configureRepositorySetup("setup", "budgetMinutes", 30)
    expect(t.state().revision).toBe(prior.revision + 1)
    expect(await t.setup.runRepositorySetup("setup", "evaluate")).toEqual({ value: "Handle issues: evaluate requested in the background." })
    await Promise.all(t.background)
    expect(t.calls).toHaveLength(1)
    expect(t.state().request?.state).toBe("completed")
  } finally { await t.close() }
})

test("an observe-only request reconnects under its persisted id and never posts a duplicate", async () => {
  const observation = deferred()
  const t = await fixture(async body => { await observation.promise; return response(body) })
  try {
    const current = t.state()
    const request = { id: "persisted-request", operation: "evaluate" as const, revision: current.revision,
      digest: setupCandidate(current), state: "failed" as const, observeOnly: true, error: "Connection lost" }
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup",
      payload: { ...current, request } } }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "trial")).toEqual({ value: "Setup reconnection requested." })
    expect(t.state().request).toEqual({ ...request, state: "requested", error: undefined })
    expect(t.calls.map(call => [call.method, call.body.requestId])).toEqual([["GET", request.id]])
    expect(await t.setup.runRepositorySetup("setup", "evaluate")).toEqual({ value: "Setup reconnection requested." })
    expect(t.calls).toHaveLength(1)
    observation.release(); await Promise.all(t.background)
    expect(t.state().request).toMatchObject({ id: request.id, state: "completed", observeOnly: true })
    expect(t.state().evaluation?.requestId).toBe(request.id)
    expect(t.calls.map(call => call.method)).toEqual(["GET"])
  } finally { observation.release(); await t.close() }
})

test("a failed recovery remains retryable through the setup action without launching a new operation", async () => {
  const discovery = deferred()
  const t = await fixture(async () => { throw Error("Setup must not launch during recovery") })
  t.recovery.answer = async (repo, job) => { await discovery.promise; return Response.json({ owner: "maintainer", repo, job,
    registration: { state: "known" }, setup: { state: "none" } }) }
  try {
    const current = t.state()
    const recovery = { id: "recover-after-error", baseRevision: current.revision, baseDigest: setupCandidate(current),
      state: "failed" as const, registrationState: "unavailable" as const, error: "Offline" }
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup",
      payload: { ...current, recovery } } }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "evaluate")).toEqual({ value: "Setup recovery requested." })
    expect(t.state().recovery).toEqual({ ...recovery, state: "requested", error: undefined })
    expect(t.recovery.calls).toHaveLength(1)
    expect(await t.setup.runRepositorySetup("setup", "evaluate")).toEqual({ value: "Setup recovery requested." })
    expect(t.recovery.calls).toHaveLength(1)
    expect(t.calls).toEqual([])
    discovery.release(); await Promise.all(t.background)
    expect(t.state().recovery).toMatchObject({ id: recovery.id, state: "completed", registrationState: "known" })
    expect(t.state().request).toBeUndefined()
  } finally { discovery.release(); await t.close() }
})

test("a refused local save names the storage failure in chat and permits the next setup edit", async () => {
  const backing = memoryStorage()
  let armed = false
  const storage = { ...backing, setItem: (key: string, value: string) => {
    if (armed && key.endsWith(".staged")) {
      armed = false
      throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
    }
    backing.setItem(key, value)
  } }
  const t = await fixture(async body => response(body), storage)
  try {
    const prior = t.state()
    armed = true
    const refusal = await t.setup.configureRepositorySetup("setup", "budgetMinutes", 30)
    if (typeof refusal !== "string") throw Error("the refused write returned no sentence")
    expect(refusal).toBe(browserWriteRefusal(Object.assign(new Error("quota"), { name: "QuotaExceededError", code: 22 })))
    expect(t.state().draft.budgetMinutes).toBe(prior.draft.budgetMinutes)
    expect([...t.store.collections.messages.values()].at(-1)?.text).toBe(refusal)
    expect(t.calls).toEqual([])
    expect(await t.setup.configureRepositorySetup("setup", "budgetMinutes", 30)).toEqual({ value: "Draft updated." })
    expect(t.state().draft.budgetMinutes).toBe(30)
  } finally { await t.close() }
})

test("a setup question that cannot open stays visibly retryable and reports the failure once", async () => {
  const reported: Array<{ error: string; admitted: boolean }> = []
  const t = await fixture(async body => response(body), memoryStorage(), doors({
    guidanceFailed: (error, admitted) => { reported.push({ error, admitted }) }
  }))
  let attempts = 0
  const thrown: Error[] = []
  Object.assign(t.ctx.commands, { runAsAgent: async () => { attempts++; const error = Error("Form unavailable"); thrown.push(error); throw error } })
  try {
    expect(await t.setup.guideRepositorySetup("setup")).toEqual({ value: "Setup guidance requested." })
    await until(() => t.state().guidance?.state === "failed")
    expect(attempts).toBe(2)
    // The card keeps the second attempt's full detail for diagnostics, never shown as the sentence.
    expect(t.state().guidance?.error).toBe(failureDetail(thrown[1]))
    expect(t.state().guidance?.error).toStartWith("Error: Form unavailable")
    // The person reads the sentence; the raw message goes only to diagnostics.
    expect(reported).toEqual([{ error: "The setup question could not be opened. Not your fault.", admitted: false }])
    expect(t.ctx.failures.recent().some(entry => entry.seam === "setup.guidance" && entry.message.includes("Form unavailable"))).toBe(true)
    expect(t.calls).toEqual([])
    const failedId = t.state().guidance!.id
    expect(await t.setup.guideRepositorySetup("setup")).toEqual({ value: "Setup guidance requested." })
    await until(() => attempts === 4 && t.state().guidance?.state === "failed")
    expect(t.state().guidance?.id).toBe(failedId)
    expect(reported).toHaveLength(2)
  } finally { await t.close() }
})

test("resuming an already recovered setup reconnects its busy request without a second launch", async () => {
  const launch = deferred()
  const t = await fixture(async body => { await launch.promise; return response(body) })
  try {
    const original = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...original,
      id: "setup:maintainer:example%2Frepo:issues", ordinal: t.store.nextOrdinal() } }).isPersisted.promise
    await t.setup.openRepositorySetup("issues", "example/repo")
    await Promise.all(t.background)
    const card = setupCard(t)
    const state = () => setupCard(t).payload
    expect(state().recovery?.state).toBe("completed")
    await t.setup.runRepositorySetup(card.id, "evaluate")
    const id = state().request!.id
    expect(t.calls.map(call => [call.method, call.body.requestId])).toEqual([["POST", id]])
    t.setup.resumeRepositorySetups()
    t.setup.resumeRepositorySetups()
    expect(t.calls.map(call => [call.method, call.body.requestId])).toEqual([["POST", id]])
    expect(state().request?.state).toBe("requested")
    launch.release(); await Promise.all(t.background)
    expect(state().request).toMatchObject({ id, state: "completed" })
  } finally { launch.release(); await t.close() }
})

test("a launch acknowledgment never resolves the toast before the remote execution completes", async () => {
  const gate = deferred()
  const t = await fixture(async (body, method) => {
    if (method === "POST") return response(body, "running")
    await gate.promise; return response(body)
  })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate")
    await until(() => t.calls.some(call => call.method === "GET"))
    expect(t.state().evaluation?.phase).toBe("running")
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["running"])
    gate.release(); await Promise.all(t.background)
    expect(t.state().evaluation?.phase).toBe("completed")
  } finally { gate.release(); await t.close() }
})

test("a lost response stays visibly retryable and reuses the durable request id", async () => {
  let lost = true
  const t = await fixture(async body => { if (lost) throw Error("Connection lost"); return response(body) })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    const id = t.state().request!.id
    // An untagged failure is the site's sentence on the card and the toast, never its raw message.
    expect(t.state().request?.error).toBe("The setup could not be completed. Not your fault.")
    expect([...t.store.collections.toasts.values()].map(toast => toast.detail).join(" ")).not.toContain("Connection lost")
    expect(t.state().active).toBeUndefined()
    lost = false
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.calls.map(call => call.body.requestId)).toEqual([id, id])
    expect(t.state().request?.state).toBe("completed")
  } finally { await t.close() }
})

test("a storage failure during setup shows its registry sentence, and a host refusal keeps its words", async () => {
  const tagged = await fixture(async () => { throw new StorageWriteFailedError() })
  try {
    await tagged.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(tagged.background)
    expect(tagged.state().request?.error).toBe(presentAppFailure(new StorageWriteFailedError(), () => {}).sentence)
  } finally { await tagged.close() }
  const refused = await fixture(async () => Response.json({ message: "no" }, { status: 503 }))
  try {
    await refused.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(refused.background)
    expect(refused.state().request?.error).toBe("The host refused the request.")
  } finally { await refused.close() }
})

test("an untagged recovery failure shows the recovery sentence, not its raw message", async () => {
  const t = await fixture(async () => { throw Error("Setup must not launch during recovery") })
  t.recovery.answer = async () => { throw Error("socket hang up at recover.ts:1") }
  try {
    const current = t.state()
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...current,
      recovery: { id: "recover-raw", baseRevision: current.revision, baseDigest: setupCandidate(current), state: "failed" as const, registrationState: "unavailable" as const, error: "Offline" } } } }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "evaluate")).toEqual({ value: "Setup recovery requested." })
    await Promise.all(t.background)
    await until(() => t.state().recovery?.state === "failed")
    expect(t.state().recovery?.error).toBe("Setup recovery is unavailable. Not your fault.")
  } finally { await t.close() }
})

test("a known execution failure stays in evidence history while an explicit retry gets a new attempt", async () => {
  const t = await fixture(async body => response(body, "failed"))
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    const id = t.state().request!.id
    expect(t.state().previousReceipts[0]?.requestId).toBe(id)
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.state().request!.id).not.toBe(id)
  } finally { await t.close() }
})

test("editing a prompt ignores a late response, preserves the active version, and invalidates only the draft", async () => {
  const gate = deferred()
  const t = await fixture(async body => { await gate.promise; return response(body) })
  try {
    const state = t.state()
    const card = t.store.collections.cards.get("setup")!
    const active = { revision: 1, digest: setupCandidate(state), registrationId: "active-1", sourceRevision: "commit-1", enabled: true }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...state, active } } }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "evaluate")
    await t.setup.configureRepositorySetup("setup", "step.research.prompt", "A changed prompt")
    gate.release(); await Promise.all(t.background)
    expect(t.state().revision).toBe(2)
    expect(t.state().evaluation).toBeUndefined()
    expect(t.state().active).toEqual(active)
  } finally { gate.release(); await t.close() }
})

test("reload reconnects the same persisted request without granting it success", async () => {
  const gate = deferred()
  const first = await fixture(async body => { await gate.promise; return response(body) })
  await first.setup.runRepositorySetup("setup", "evaluate")
  const id = first.state().request!.id
  await first.close()
  gate.release(); await Promise.all(first.background)
  const second = await fixture(async body => response(body), first.storage)
  try {
    expect(second.state().request?.state).toBe("requested")
    second.setup.resumeRepositorySetups(); await until(() => second.state().request?.state === "completed")
    expect(second.calls[0]?.body.requestId).toBe(id)
    expect(second.state().request?.state).toBe("completed")
  } finally { await second.close() }
})

test("draft commands cannot forge active authority or run as another account", async () => {
  const t = await fixture(async body => response(body))
  try {
    expect(await t.setup.configureRepositorySetup("setup", "active", true)).toBe("That setting cannot be edited.")
    const prior = t.store.collections.cards.get("setup")!
    t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null })
    // Account switching already clears old cards; a restored foreign card is
    // refused by the controller independently of that presentation policy.
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: prior }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "evaluate")).toBe("This setup belongs to a different account.")
    expect(t.calls).toHaveLength(0)
  } finally { await t.close() }
})

test("queued admission creates no synthetic run; the real observed run opens in its recorded workspace", async () => {
  const observation = deferred(), runRead = deferred()
  const opened: unknown[][] = []
  let polls = 0
  const t = await fixture(async (body, method) => {
    if (method === "POST") {
      const queued = await response(body, "queued").json()
      delete queued.receipt.runId
      return Response.json(queued)
    }
    await observation.promise
    if (polls++ === 0) return response(body, "running")
    throw Error("Connection lost")
  }, memoryStorage(), doors({ openRun: async (...args) => { opened.push(args); await runRead.promise } }))
  try {
    await t.setup.runRepositorySetup("setup", "evaluate")
    await until(() => t.calls.some(call => call.method === "GET"))
    expect(t.state().receipt?.runId).toBeUndefined()
    expect(opened).toEqual([])
    observation.release()
    await Promise.all(t.background)
    expect(opened).toEqual([["run-1", "example/repo", "setup"]])
    expect(t.state().request?.state).toBe("failed")
    expect(t.state().receipt?.phase).toBe("running")
    expect(t.state().evaluation?.phase).toBe("running")
    const card = t.store.collections.cards.get("setup")!
    expect(cardContainsRun(card, "run-1")).toBe(true)
    expect(cardContainsRun(card, "invented")).toBe(false)
    expect(runScopeFromCard(t.store, card, "run-1")).toEqual({ repo: "example/repo", runId: "run-1", workspaceId })
  } finally { observation.release(); runRead.release(); await t.close() }
})

test("a result for another workspace is refused without replacing the last run phase", async () => {
  const t = await fixture(async (body, method) => {
    const value = await response(body, "running").json()
    return Response.json({ ...value, workspaceId: method === "POST" ? workspaceId : "1201d1d3-6d38-4b65-9d91-f502d7b7377a" })
  })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    expect(t.state().request?.error).toBe("The host returned a result for a different workspace.")
    expect(t.state().receipt?.phase).toBe("running")
    expect(t.state().workspaceId).toBe(workspaceId)
  } finally { await t.close() }
})

test("signed-out setup stays editable and offers the sign-in door without inspecting", async () => {
  let signIns = 0
  const t = await fixture(async body => response(body), memoryStorage(), doors({ promptSignIn: () => { signIns++ } }))
  try {
    t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
    await t.setup.openRepositorySetup("issues", "example/preview")
    expect(signIns).toBe(0)
    const card = [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup")!
    await t.setup.configureRepositorySetup(card.id, "replies", "draft")
    await t.setup.runRepositorySetup(card.id, "inspect")
    expect(signIns).toBe(1)
    expect(t.calls).toEqual([])
    expect(card.kind === "repository-setup" && card.payload.request).toBeUndefined()
  } finally { await t.close() }
})

test("the app asks its own first question only after repository inspection, and preserves a typed draft", async () => {
  const inspection = deferred()
  const t = await fixture(async body => {
    await inspection.promise
    return Response.json({ ...await response(body, "completed", "inspect").json(), inspection: {
      sources: [{ path: ".github/workflows/ci.yml", status: "read", summary: "Tests already run for every pull request.", revision: "source-1" }],
      suggestedDraft: initialSetup(body.repo, "ci", "maintainer").draft, inspectedAt: 2
    } })
  }, memoryStorage(), doors())
  try {
    t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep my unfinished question" })
    await t.setup.openRepositorySetup("ci", "example/another")
    expect(t.asked).toEqual([])
    inspection.release(); await Promise.all(t.background)
    expect(t.asked).toEqual([])
    expect(t.store.session().draft).toBe("Keep my unfinished question")
    t.store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
    await until(() => t.asked.length === 1)
    const card = [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.payload.repo === "example/another")!
    expect(t.asked[0]?.name).toBe("setup.ask")
    const asked = card.kind === "repository-setup" ? card.payload : undefined!
    expect(JSON.parse(t.asked[0]!.args)).toEqual({ cardId: card.id, questionId: "ci.steps.automatic",
      revision: asked.revision, digest: setupCandidate(asked) })
    expect(card.kind === "repository-setup" && card.payload.sources[0]?.revision).toBe("source-1")
    await t.setup.openRepositorySetup("ci", "example/another")
    expect(t.asked).toHaveLength(1)
  } finally { inspection.release(); await t.close() }
})

test("inspection receipt history stays completed through the suggested revision and restart", async () => {
  const inspection = deferred()
  const t = await fixture(async (body, method) => {
    if (method === "POST") return response(body, "running", "inspect")
    await inspection.promise
    return Response.json({ ...await response(body, "completed", "inspect").json(), inspection: {
      sources: [{ path: "README.md", status: "read", summary: "Repository usage" }], inspectedAt: 2,
      suggestedDraft: { ...body.draft, cases: [
        { id: "usage", name: "Usage question", input: "How does this repository work?", expected: "Cite README.md", required: true },
        { id: "unknown", name: "Missing detail", input: "An unspecified problem", expected: "Ask for the missing detail", required: true }
      ] }
    } })
  })
  let requestId = ""
  try {
    await t.setup.runRepositorySetup("setup", "inspect")
    await until(() => t.state().receipt?.phase === "running")
    requestId = t.state().request!.id
    inspection.release(); await Promise.all(t.background)
    expect(t.state()).toMatchObject({ revision: 2, request: { id: requestId, state: "completed" }, draft: { cases: [{ id: "usage" }, { id: "unknown" }] } })
    expect(t.state().previousReceipts).toEqual([t.state().receipt!])
    expect(t.state().previousReceipts[0]?.phase).toBe("completed")
  } finally { inspection.release(); await t.close() }
  const restored = await fixture(async body => response(body), t.storage)
  try {
    await restored.setup.runRepositorySetup("setup", "evaluate")
    await Promise.all(restored.background)
    expect(restored.calls.filter(call => call.method === "POST")).toHaveLength(1)
    expect(restored.state().request?.id).not.toBe(requestId)
    expect(restored.state().previousReceipts.find(item => item.requestId === requestId)).toMatchObject({ operation: "inspect", phase: "completed", revision: 1 })
  } finally { await restored.close() }
})

test("inspection receipt history heals from an available receipt before a later operation replaces it", async () => {
  const evaluation = deferred()
  const t = await fixture(async (body, method) => {
    if (method === "POST") return response(body, "running")
    await evaluation.promise
    return response(body)
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    const completed = (await response({ requestId: "old-inspection", repo: t.state().repo, job: "issues", revision: 1, digest: "old-digest", draft: t.state().draft }, "completed", "inspect").json()).receipt
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: {
      ...t.state(), revision: 2, receipt: completed,
      previousReceipts: [{ ...completed, phase: "running" }, { ...completed, requestId: "unobserved-request", phase: "running" }]
    } } }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "evaluate")
    await until(() => t.state().receipt?.operation === "evaluate")
    expect(t.state().receipt?.phase).toBe("running")
    expect(t.state().previousReceipts.find(item => item.requestId === "old-inspection")).toEqual(completed)
    expect(t.state().previousReceipts.find(item => item.requestId === "unobserved-request")?.phase).toBe("running")
    evaluation.release(); await Promise.all(t.background)
  } finally { evaluation.release(); await t.close() }
})

test("the agent guidance door reads current prompts and evidence without launching a nested turn", async () => {
  const t = await fixture(async body => response(body), memoryStorage(), doors())
  try {
    const guide = createRepositorySetupController({ ...t.ctx, commandActor: "smithers" }, doors())
    await t.setup.configureRepositorySetup("setup", "step.research.prompt", "Read the repository's request handlers first.")
    const result = await guide.guideRepositorySetup("setup")
    expect(typeof result === "object" && result.value).toContain("Read the repository's request handlers first.")
    expect(typeof result === "object" && result.value).toContain("The app asks this setup's first question itself")
    // Reading the guide as the model mints no unsolicited first-question intent.
    expect(t.state().guidance).toBeUndefined()
    expect(t.asked).toEqual([])
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("a second explicit guide remains queued while the first question render is held", async () => {
  const held = deferred()
  const t = await fixture(async body => response(body), memoryStorage(), doors())
  t.holdAsk(held.promise)
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: "other-setup", kind: "repository-setup", title: "Review pull requests", status: "active", createdAt: 2, ordinal: t.store.nextOrdinal(),
      payload: { ...initialSetup("example/repo", "review", "maintainer"), inspectedAt: 1 }
    } }).isPersisted.promise
    await t.setup.guideRepositorySetup("setup")
    await until(() => t.asked.length === 1)
    await t.setup.guideRepositorySetup("other-setup")
    expect(t.asked).toHaveLength(1)
    held.release()
    await until(() => t.asked.length === 2)
    expect(JSON.parse(t.asked[0]!.args).cardId).toBe("setup")
    expect(JSON.parse(t.asked[1]!.args).cardId).toBe("other-setup")
  } finally { held.release(); await t.close() }
})

test("new setup ignores an ambient older workspace and keeps the server's compatible binding", async () => {
  const t = await fixture(async body => response(body, "failed", "inspect"))
  try {
    const other = "1201d1d3-6d38-4b65-9d91-f502d7b7377a"
    await t.store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [workspaceId, other].map(id => ({
      id, repoId: "example/repo", name: "Box", targetBookmark: null, status: "running", provisioningStage: null, suspendedAt: null, createdAt: null
    })) }).isPersisted.promise
    await t.store.dispatch({ type: "repo.selected", actor: "user", id: `example/repo#workspace:${other}` }).isPersisted.promise
    await t.setup.openRepositorySetup("ci", "example/repo"); await Promise.all(t.background)
    expect(t.calls[0]?.body.workspaceId).toBeUndefined()
    await t.store.dispatch({ type: "repo.selected", actor: "user", id: `example/repo#workspace:${other}` }).isPersisted.promise
    await t.setup.openRepositorySetup("ci", "example/repo")
    const card = [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.payload.job === "ci")!
    expect(card.kind === "repository-setup" && card.payload.workspaceId).toBe(workspaceId)
    await t.setup.configureRepositorySetup(card.id, "step.checks.prompt", "Run this repository's existing checks.")
    await t.setup.runRepositorySetup(card.id, "inspect"); await Promise.all(t.background)
    expect(t.calls[1]?.body.workspaceId).toBe(workspaceId)
    expect(t.calls[1]?.body.revision).toBe(2)
    await t.close()
    const again = await fixture(async body => response(body, "failed", "inspect"), t.storage)
    try {
      await again.setup.openRepositorySetup("ci", "example/repo"); await Promise.all(again.background)
      await again.setup.retryRepositorySetup(card.id); await Promise.all(again.background)
      expect(again.calls).toHaveLength(1)
      expect(again.calls[0]?.body.workspaceId).toBe(workspaceId)
      await again.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      expect(runScopeFromCard(again.store, card, "run-1")).toBeUndefined()
    } finally { await again.close() }
  } finally { await t.close() }
})

test("PR trials require a real selector and immediate launch uses both ordered field edits", async () => {
  const t = await fixture(async body => response(body, "completed", "trial"))
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: initialSetup("example/repo", "review", "maintainer") } }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "trial")).toBe("Choose a PR for this trial.")
    expect(t.calls).toHaveLength(0)
    const changes = [t.setup.configureRepositorySetup("setup", "trial.source", "smithers-cloud"), t.setup.configureRepositorySetup("setup", "trial.number", 42)]
    await t.setup.runRepositorySetup("setup", "trial")
    await Promise.all([...changes, ...t.background])
    expect(t.calls).toHaveLength(1)
    expect(JSON.parse(t.calls[0]!.body.draft.trialBody)).toEqual({ source: "smithers-cloud", number: 42 })
    // Selecting the PR to trial is the trial's own input, not a new candidate.
    expect(t.calls[0]!.body.revision).toBe(1)
    expect(t.calls[0]!.body.digest).toBe(setupCandidate(t.state()))
  } finally { await t.close() }
})

test("pausing retains evidence and advances the candidate, and the same reviewed draft enables it again", async () => {
  let operation = "pause"
  const t = await fixture(async body => {
    const value = await response(body, "completed", operation).json()
    return Response.json({ ...value, receipt: { ...value.receipt, registrationId: "active-1", sourceRevision: "commit-1" } })
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    const digest = setupCandidate(t.state())
    const evidence = { runId: "prior-run", revision: 1, digest, phase: "completed" as const, updatedAt: 1, results: [], evidence: ["artifact:prior-results"], sourceRevision: "commit-1" }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...t.state(),
      evaluation: { ...evidence, requestId: "eval-1", operation: "evaluate" },
      trial: { ...evidence, requestId: "trial-1", operation: "trial" },
      active: { revision: 1, digest, registrationId: "active-1", sourceRevision: "commit-1", enabled: true }
    } } }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "pause"); await Promise.all(t.background)
    expect(t.state().active).toMatchObject({ revision: 1, enabled: false })
    expect(t.state().revision).toBe(2)
    expect(setupCandidate(t.state())).not.toBe(digest)
    expect(t.state().evaluation).toBeUndefined()
    expect(t.state().trial).toBeUndefined()
    expect(t.state().previousReceipts.map(receipt => receipt.requestId)).toEqual(["eval-1", "trial-1"])
    expect(t.state().receipt?.operation).toBe("pause")
    // The way back: Cloud re-enables a paused row only at a newer revision, and
    // the advanced candidate is the draft that registration was activated with.
    operation = "apply"
    await t.setup.runRepositorySetup("setup", "apply"); await Promise.all(t.background)
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1]?.body.revision).toBe(2)
    expect(t.state().active).toMatchObject({ revision: 2, registrationId: "active-1", enabled: true })
    expect(t.state().request).toMatchObject({ operation: "apply", state: "completed" })
  } finally { await t.close() }
})

test("chore apply refreshes the registry in the background; held duplicate input, edits, pause and restart cannot reuse its old next run", async () => {
  const held = deferred()
  let operation = "apply"
  const t = await fixture(async body => {
    const value = await response(body, "completed", operation).json()
    return Response.json({ ...value, receipt: { ...value.receipt, registrationId: "chore-registration", sourceRevision: "commit-1" } })
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "0 9 * * *"
    payload.draft.steps[0]!.mode = "automatic"
    payload.draft.cases = [{ id: "check", name: "A maintenance change", input: "synthetic case fixture", expected: "A checked proposal", required: true }]
    const digest = setupCandidate(payload)
    const proof = { revision: 1, digest, phase: "completed" as const, updatedAt: 1, results: [{ caseId: "check", status: "passed" as const, observed: "A checked proposal", evidence: ["test:check"], executionId: "eval-case" }], evidence: ["artifact:checked"], sourceRevision: "commit-1" }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...payload,
      evaluation: { ...proof, requestId: "eval", runId: "eval-run", operation: "evaluate" }, trial: { ...proof, requestId: "trial", runId: "trial-run", operation: "trial" }
    } } }).isPersisted.promise
    const policy = { revision: 1, digest, registrationId: "chore-registration", sourceRevision: "commit-1", enabled: true, owned: true, workspaceId, draft: payload.draft,
      schedule: { expression: "0 9 * * *", nextFireAt: "2026-09-18T09:00:00Z" } }
    t.recovery.answer = async () => { await held.promise; return Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: policy }, setup: { state: "none" } }) }
    const acknowledgment = await Promise.race([t.setup.runRepositorySetup("setup", "apply"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(acknowledgment).not.toBe("blocked")
    await until(() => t.recovery.calls.length === 1)
    expect(t.state().request?.state).toBe("completed")
    expect(t.state().active?.schedule).toBeUndefined()
    expect(t.state().recovery?.state).toBe("requested")
    await t.setup.runRepositorySetup("setup", "apply")
    expect(t.calls).toHaveLength(1)
    expect(t.recovery.calls).toHaveLength(1)
    await t.setup.viewRepositorySetup("setup", "flows")
    await t.setup.configureRepositorySetup("setup", "schedule", "0 10 * * *")
    held.release()
    await until(() => t.state().recovery?.state === "completed")
    expect(t.state().draft.schedule).toBe("0 10 * * *")
    expect(t.state().active?.schedule).toEqual(policy.schedule)
    expect(t.state().revision).toBe(2)
    expect(t.store.session().phase).toBe("idle")
    operation = "pause"
    await t.setup.runRepositorySetup("setup", "pause")
    await until(() => t.state().receipt?.operation === "pause")
    expect(t.state().active?.enabled).toBe(false)
    expect(t.state().active?.schedule).toBeUndefined()
    expect(t.calls.map(call => call.method)).toEqual(["POST", "POST"])
    await t.close()
    const again = await fixture(async () => { throw Error("Recovery must not execute") }, t.storage)
    try {
      again.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: { ...policy, enabled: false, schedule: undefined } }, setup: { state: "none" } })
      again.setup.resumeRepositorySetups()
      await until(() => again.state().recovery?.state === "completed")
      expect(again.state().active?.enabled).toBe(false)
      expect(again.state().active?.schedule).toBeUndefined()
      expect(again.state().draft.schedule).toBe("0 10 * * *")
      expect(again.calls).toEqual([])
    } finally { await again.close() }
  } finally { held.release(); await t.close() }
})

test.each(["elapsed", "future", "failed"])("an open chore expires its observed time and makes one bounded %s refresh without blocking Chat", async outcome => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const held = deferred(), t = await fixture(async () => { throw Error("A schedule read cannot execute work") })
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true, owned: true, workspaceId, draft: payload.draft,
      schedule: { expression: payload.draft.schedule, nextFireAt: new Date(due).toISOString() } }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => {
      if (t.recovery.calls.length > 1) {
        await held.promise
        if (outcome === "failed") return Response.json({}, { status: 503 })
        if (outcome === "future") policy.schedule.nextFireAt = new Date(due + 60_000).toISOString()
      }
      return Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: policy }, setup: { state: "none" } })
    }
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    expect(t.state().active?.schedule?.nextFireAt).toBe(new Date(due).toISOString())
    now = due
    scheduled[0]!()
    await until(() => t.recovery.calls.length === 2)
    expect(t.state().active?.schedule).toBeUndefined()
    expect(t.state().recovery?.state).toBe("requested")
    scheduled[0]!()
    await t.setup.viewRepositorySetup("setup", "prompts", "chore")
    expect(t.state().view).toBe("prompts")
    expect(t.store.session().phase).toBe("idle")
    held.release()
    await until(() => t.state().recovery?.state !== "requested")
    expect(t.recovery.calls).toHaveLength(2)
    expect(scheduled).toHaveLength(outcome === "future" ? 2 : 1)
    expect(t.state().recovery?.registrationState).toBe(outcome === "failed" ? "unavailable" : "known")
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test.each(["pause", "account", "dispose"])("%s cancels and fences a pending chore time refresh", async stop => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const t = await fixture(async body => {
    const result = await response(body, "completed", "pause").json()
    return Response.json({ ...result, receipt: { ...result.receipt, registrationId: "scheduled" } })
  })
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true, owned: true, workspaceId, draft: payload.draft,
      schedule: { expression: payload.draft.schedule, nextFireAt: new Date(due).toISOString() } }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: policy }, setup: { state: "none" } })
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    if (stop === "pause") {
      await t.setup.runRepositorySetup("setup", "pause")
      await until(() => t.state().active?.enabled === false)
    } else if (stop === "account") {
      Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
      await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      t.setup.resumeRepositorySetups()
    } else await t.close()
    // Pause refreshes registration once from the host; the retired schedule adds no read.
    if (stop === "pause") await until(() => t.recovery.calls.length === 2)
    const readsBeforeExpiredTimer = t.recovery.calls.length
    expect(readsBeforeExpiredTimer).toBe(stop === "pause" ? 2 : 1)
    now = due; scheduled[0]!()
    await new Promise(resolve => originalTimeout(resolve, 10))
    expect(t.recovery.calls).toHaveLength(readsBeforeExpiredTimer)
    expect(t.calls).toHaveLength(stop === "pause" ? 1 : 0)
  } finally { await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test.each(["completed", "failed"])("a due chore keeps a busy setup admission and refreshes once after it %s", async phase => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const held = deferred(), t = await fixture(async body => { await held.promise; return response(body, phase) })
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true, owned: true, workspaceId, draft: payload.draft }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: { ...policy,
      schedule: { expression: payload.draft.schedule, nextFireAt: new Date(t.recovery.calls.length === 1 ? due : due + 60_000).toISOString() }
    } }, setup: { state: "none" } })
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    await t.setup.runRepositorySetup("setup", "evaluate")
    const requestId = t.state().request!.id
    now = due; scheduled[0]!()
    await until(() => t.state().active?.schedule === undefined)
    expect(t.state().request?.id).toBe(requestId)
    expect(t.state().request?.state).toBe("requested")
    expect(t.state().request?.observeOnly).toBeUndefined()
    expect(t.recovery.calls).toHaveLength(1)
    held.release()
    await until(() => scheduled.length === 2)
    expect(t.recovery.calls).toHaveLength(2)
    expect(t.calls).toHaveLength(1)
    expect(t.state().evaluation?.phase).toBe(phase)
    expect(t.state().active?.schedule?.nextFireAt).toBe(new Date(due + 60_000).toISOString())
  } finally { held.release(); await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test("an account switch discards the pending schedule refresh from a busy old-owner setup", async () => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const held = deferred(), t = await fixture(async body => { await held.promise; return response(body) })
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true,
      owned: true, workspaceId, draft: payload.draft, schedule: { expression: payload.draft.schedule, nextFireAt: new Date(due).toISOString() } }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores",
      registration: { state: "known", active: policy }, setup: { state: "none" } })
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    await t.setup.runRepositorySetup("setup", "evaluate")
    now = due; scheduled[0]!()
    await until(() => t.state().active?.schedule === undefined)
    expect(t.recovery.calls).toHaveLength(1)
    Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true,
      admin: false, scopesPlain: null }).isPersisted.promise
    t.setup.resumeRepositorySetups()
    held.release(); await Promise.all(t.background)
    expect(t.recovery.calls).toHaveLength(1)
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect([...t.store.collections.toasts.values()].some(toast => toast.status === "ok")).toBe(false)
  } finally { held.release(); await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test("a failed scheduled refresh reports the lost save without claiming updated registration", async () => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const backing = memoryStorage()
  let refuse = false
  const storage = { ...backing, setItem: (key: string, value: string) => {
    if (refuse && key.endsWith(".staged")) {
      refuse = false
      throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
    }
    backing.setItem(key, value)
  } }
  const t = await fixture(async () => { throw Error("Schedule refresh must not launch work") }, storage)
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true,
      owned: true, workspaceId, draft: payload.draft, schedule: { expression: payload.draft.schedule, nextFireAt: new Date(due).toISOString() } }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores",
      registration: { state: "known", active: policy }, setup: { state: "none" } })
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    refuse = true; now = due; scheduled[0]!()
    await until(() => t.ctx.failures.recent().some(failure => failure.seam === "setup.schedule"))
    expect(t.ctx.failures.recent().filter(failure => failure.seam === "setup.schedule"))
      .toEqual([expect.objectContaining({ subject: "setup", count: 1 })])
    expect(t.recovery.calls).toHaveLength(1)
    expect(t.calls).toEqual([])
    expect(t.state().active?.schedule).toEqual(policy.schedule)
  } finally { await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test("a failed run-card open is reported while the completed setup remains usable", async () => {
  const opened: string[] = []
  const t = await fixture(async body => response(body), memoryStorage(), doors({
    openRun: async runId => { opened.push(runId); throw Error("Run card unavailable") }
  }))
  try {
    await t.setup.runRepositorySetup("setup", "evaluate")
    await Promise.all(t.background)
    await until(() => t.ctx.failures.recent().some(failure => failure.seam === "setup.open-run"))
    expect(opened).toEqual(["run-1"])
    expect(t.state().request?.state).toBe("completed")
    expect(t.state().evaluation?.phase).toBe("completed")
    expect(t.ctx.failures.recent().filter(failure => failure.seam === "setup.open-run"))
      .toEqual([expect.objectContaining({ message: expect.stringContaining("Run card unavailable"), subject: "run-1", count: 1 })])
    expect([...t.store.collections.toasts.values()].some(toast => toast.status === "failed")).toBe(false)
  } finally { await t.close() }
})

test("a non-JSON host refusal stays retryable under the durable request id", async () => {
  let refuse = true
  const t = await fixture(async body => {
    if (refuse) return new Response("gateway unavailable", { status: 503 })
    return response(body)
  })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    const request = t.state().request!
    expect(request).toMatchObject({ state: "failed", error: "The host refused the request." })
    expect(t.state().evaluation).toBeUndefined()
    expect(t.state().active).toBeUndefined()
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["failed"])
    refuse = false
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.calls.map(call => call.body.requestId)).toEqual([request.id, request.id])
    expect(t.state().request).toMatchObject({ id: request.id, state: "completed" })
    expect(t.state().evaluation?.phase).toBe("completed")
  } finally { await t.close() }
})

test("guidance survives a transient store settling error and opens once", async () => {
  const t = await fixture(async body => response(body), memoryStorage(), doors())
  const settle = t.store.settled?.bind(t.store)
  let failOnce = true
  Object.assign(t.store, { settled: async () => {
    if (failOnce) { failOnce = false; throw Error("Store settling interrupted") }
    return settle?.()
  } })
  try {
    expect(await t.setup.guideRepositorySetup("setup")).toEqual({ value: "Setup guidance requested." })
    await until(() => t.state().guidance?.state === "admitted")
    expect(failOnce).toBe(false)
    expect(t.asked.map(item => item.name)).toEqual(["setup.ask"])
    expect(t.calls).toEqual([])
  } finally { Object.assign(t.store, { settled: settle }); await t.close() }
})

test("a rendered setup question reports when its admission cannot be saved", async () => {
  const backing = memoryStorage(), held = deferred()
  let failedWrites = 0
  const storage = { ...backing, setItem: (key: string, value: string) => {
    if (failedWrites > 0 && key.endsWith(".staged")) {
      failedWrites--
      throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
    }
    backing.setItem(key, value)
  } }
  const reported: Array<{ error: string; admitted: boolean }> = []
  const t = await fixture(async body => response(body), storage, doors({
    guidanceFailed: (error, admitted) => { reported.push({ error, admitted }) }
  }))
  t.holdAsk(held.promise)
  try {
    await t.setup.guideRepositorySetup("setup")
    await until(() => t.asked.length === 1)
    failedWrites = 3
    held.release()
    await until(() => reported.length === 1)
    expect(t.asked).toHaveLength(1)
    expect(reported).toEqual([{ error: "The command's outcome could not be saved. Check its result before trying again.", admitted: true }])
    expect(t.ctx.failures.recent().filter(failure => failure.seam === "setup.guidance")).toHaveLength(1)
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close() }
})

test("the composed app renders its own setup question and starts no conversation turn", async () => {
  const { createAppController } = await import("../AppController")
  const requests: StartAgentTurnRequest[] = []
  const t = await fixture(async body => response(body))
  const controller = createAppController(t.store, recordingAgent(requests), {
    fetchImpl: async () => Response.json({}, { status: 404 })
  })
  try {
    const result = await controller.commands.run("setup.guide", "setup")
    expect(result.status).toBe("executed")
    await until(() => t.store.collections.cards.has("form-setup.ask:setup"))
    const question = t.store.collections.cards.get("form-setup.ask:setup")!
    expect(question.kind).toBe("flow-form")
    expect(question.title).toBe("Keep issue research, duplicate lookup and bug reproduction automatic?")
    expect(requests.some(request => request.purpose !== "recommend")).toBe(false)
    expect(t.store.collections.cards.get("setup")?.kind).toBe("repository-setup")
  } finally { await controller.dispose(); await t.close() }
})

test("manual work drafts survive reload without changing the active candidate or evidence", async () => {
  const t = await fixture(async body => response(body))
  try {
    const digest = setupCandidate(t.state())
    await t.setup.prepareRepositoryWork("setup", "fix")
    await t.setup.prepareRepositoryWork("setup", "fix", "source", "smithers-cloud")
    await t.setup.prepareRepositoryWork("setup", "fix", "number", 42)
    await t.setup.prepareRepositoryWork("setup", "fix", "prompt", "Keep the compatibility contract.")
    expect(t.state().manualDraft).toEqual({ stepId: "fix", source: "smithers-cloud", number: 42, prompt: "Keep the compatibility contract." })
    expect(t.state().view).toBe("work")
    expect(setupCandidate(t.state())).toBe(digest)
    expect(t.calls).toHaveLength(0)
    const storage = t.storage
    const saved = t.state().manualDraft
    await t.close()
    const again = await fixture(async body => response(body), storage)
    try { expect(again.state().manualDraft).toEqual(saved) } finally { await again.close() }
  } finally { await t.close() }
})

test("manual execution requires a matched active policy and retries the exact work request", async () => {
  let lost = true
  const opened: string[] = []
  const t = await fixture(async body => {
    if (lost) throw Error("Connection lost")
    const result = await response(body, "completed", "run").json()
    result.receipt.jobRunId = "actual-job-run"
    return Response.json(result)
  }, memoryStorage(), doors({ openRun: async runId => { opened.push(runId) } }))
  const manual = { stepId: "fix", prompt: "Fix the underlying cause", subject: { source: "github", kind: "issue", number: 42 } } as const
  try {
    expect(await t.setup.runRepositorySetup("setup", "run", manual)).toBe("Enable this setup before running work.")
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "run", manual)
    await Promise.all(t.background)
    const requestId = t.state().request!.id
    expect(t.state().request?.manual).toEqual(manual)
    lost = false
    await t.setup.retryRepositorySetup("setup")
    await Promise.all(t.background)
    expect(t.calls.map(call => [call.body.requestId, call.body.manual])).toEqual([[requestId, manual], [requestId, manual]])
    expect(t.state().request?.state).toBe("completed")
    expect(opened).toEqual(["run-1", "actual-job-run"])
    expect(cardContainsRun(t.store.collections.cards.get("setup")!, "actual-job-run")).toBe(true)
    await t.setup.configureRepositorySetup("setup", "step.fix.prompt", "Changed policy")
    expect(await t.setup.runRepositorySetup("setup", "run", manual)).toBe("Test and apply this draft before running work.")
    expect(t.calls).toHaveLength(2)
  } finally { await t.close() }
})

test("manual wrapper completion without a dispatched job stays a visible failure", async () => {
  const t = await fixture(async body => response(body, "completed", "run"))
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "run", { stepId: "poc", prompt: "", subject: { source: "smithers-cloud", kind: "issue", number: 3 } })
    await Promise.all(t.background)
    expect(t.state().request?.state).toBe("failed")
    expect(t.state().request?.error).toBe("The host did not provide the completed job run.")
    expect([...t.store.collections.toasts.values()].some(toast => toast.status === "ok")).toBe(false)
  } finally { await t.close() }
})

test("immediate Run waits for ordered work edits and uses the latest durable form, not an older render", async () => {
  const t = await fixture(async body => {
    const result = await response(body, "completed", "run").json()
    result.receipt.jobRunId = "actual-job"
    return Response.json(result)
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    const edits = [t.setup.prepareRepositoryWork("setup", "fix", "source", "smithers-cloud"),
      t.setup.prepareRepositoryWork("setup", "fix", "number", 42),
      t.setup.prepareRepositoryWork("setup", "fix", "prompt", "Preserve compatibility")]
    const requested = t.setup.runRepositorySetup("setup", "run")
    await Promise.all([...edits, requested])
    await Promise.all(t.background)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.body.manual).toEqual({ stepId: "fix", prompt: "Preserve compatibility", subject: { source: "smithers-cloud", kind: "issue", number: 42 } })
  } finally { await t.close() }
})

test("a bare manual Run opens the persisted work form instead of sending missing subject data", async () => {
  const t = await fixture(async body => response(body))
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "run")).toEqual({ value: "Work request is open." })
    expect(t.state().view).toBe("work")
    expect(t.state().manualDraft).toMatchObject({ stepId: "research", prompt: "" })
    expect(t.calls).toHaveLength(0)
  } finally { await t.close() }
})

const recoveredInspection = (repo = "example/repo"): SetupRecoveryResponse => {
  const setup = initialSetup(repo, "issues", "maintainer")
  const input = { requestId: "stored-inspection", operation: "inspect" as const, repo, job: setup.job, revision: 1, digest: setupCandidate(setup), draft: setup.draft }
  const receipt = { requestId: input.requestId, runId: "stored-run", revision: 1, digest: input.digest, operation: "inspect" as const,
    phase: "completed" as const, updatedAt: 10, results: [], evidence: ["source:abc"] }
  return { owner: "maintainer", repo, job: "issues", registration: { state: "known" }, setup: { state: "found", input,
    result: { requestId: input.requestId, revision: 1, digest: input.digest, workspaceId, receipt,
      inspection: { inspectedAt: 10, sources: [{ path: "README.md", status: "read", summary: "Actual source", revision: "abc" }],
        suggestedDraft: { ...setup.draft, cases: [{ id: "repo-case", name: "Repository case", input: "An example issue", expected: "A source-bound answer", required: true }] } } } } }
}
const setupCard = (t: Awaited<ReturnType<typeof fixture>>) => [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.id !== "setup") as Extract<import("../AppState").Card, { kind: "repository-setup" }>

// This is the actual absent-card/controller/store seam. Fixtures answer the
// backend state contract explicitly; no local completion flags are seeded.
test("missing-card recovery acknowledges before an unresolved read, coalesces opens and restores completed cases without POST", async () => {
  const opened: string[] = []
  const t = await fixture(async () => { throw Error("Recovery must not POST") }, memoryStorage(), doors({ openRun: async id => { opened.push(id) } })), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json(recoveredInspection()) }
  try {
    const acknowledged = await Promise.race([t.setup.openRepositorySetup("issues", "example/repo"), new Promise(resolve => setTimeout(() => resolve("blocked"), 150))])
    expect(acknowledged).not.toBe("blocked")
    const card = setupCard(t)
    expect(card.payload.recovery?.state).toBe("requested")
    await t.setup.openRepositorySetup("issues", "example/repo")
    expect(t.recovery.calls).toHaveLength(1)
    await t.setup.viewRepositorySetup(card.id, "evals")
    expect(t.store.session().phase).toBe("idle")
    await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
    held.release(); await Promise.all(t.background)
    const restored = setupCard(t).payload
    expect(restored.draft.cases.map(item => item.id)).toEqual(["repo-case"])
    expect(restored.revision).toBe(2)
    expect(restored.view).toBe("evals")
    expect(restored.request?.observeOnly).toBe(true)
    expect(restored.request?.state).toBe("completed")
    expect(restored.previousReceipts[0]?.phase).toBe("completed")
    expect(restored.workspaceId).toBe(workspaceId)
    expect(opened).toEqual([])
    expect(restored.evaluation).toBeUndefined()
    expect(restored.trial).toBeUndefined()
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close() }
})

test("pending recovery survives restart; late old-owner replies and edited drafts are fenced", async () => {
  const first = await fixture(async () => { throw Error("No launch") }), old = deferred()
  first.recovery.answer = async () => { await old.promise; return Response.json(recoveredInspection()) }
  await first.setup.openRepositorySetup("issues", "example/repo")
  const id = setupCard(first).id
  await first.close()
  const t = await fixture(async () => { throw Error("No launch") }, first.storage), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json(recoveredInspection()) }
  try {
    t.setup.resumeRepositorySetups()
    await until(() => t.recovery.calls.length === 1)
    await t.setup.configureRepositorySetup(id, "budgetMinutes", 17)
    old.release(); await Promise.all(first.background)
    held.release(); await Promise.all(t.background)
    expect(setupCard(t).payload.draft.budgetMinutes).toBe(17)
    expect(setupCard(t).payload.draft.cases).toEqual([])
    expect(setupCard(t).payload.request?.id).toBe("stored-inspection")
    expect(t.calls).toEqual([])
    const again = deferred()
    t.recovery.answer = async () => { await again.promise; return Response.json(recoveredInspection()) }
    await t.setup.openRepositorySetup("issues", "example/repo")
    Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    again.release(); await Promise.all(t.background)
    expect(setupCard(t)).toBeUndefined()
    expect([...t.store.collections.cards.values()].some(card => card.kind === "repository-setup")).toBe(false)
    expect(t.calls).toEqual([])
  } finally { old.release(); held.release(); await t.close() }
})

test("actual observed apply completion cannot replace newer paused policy or become a new POST after reload", async () => {
  const t = await fixture(async body => response(body, "completed", "apply"))
  const recovered = recoveredInspection(), base = initialSetup("example/repo", "issues", "maintainer")
  const digest = setupCandidate(base), newer = { ...base, revision: 3 }
  recovered.setup = { state: "found", input: { requestId: "old-apply", operation: "apply", repo: base.repo, job: base.job, draft: base.draft, revision: 1, digest }, result: {
    requestId: "old-apply", revision: 1, digest, workspaceId, receipt: { requestId: "old-apply", operation: "apply", revision: 1, digest, runId: "run-1", phase: "running", updatedAt: 2, results: [], evidence: ["run:run-1"] }
  } }
  recovered.registration = { state: "known", active: { registrationId: "registration-new", workspaceId, owned: true, enabled: false,
    revision: 3, digest: setupCandidate(newer), sourceRevision: "new-source", draft: base.draft } }
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => setupCard(t).payload.request?.state === "completed")
    expect(setupCard(t).payload.active?.enabled).toBe(false)
    expect(setupCard(t).payload.active?.revision).toBe(3)
    expect(setupCard(t).payload.revision).toBe(4)
    expect(t.calls.map(call => call.method)).toEqual(["GET"])
    const id = setupCard(t).id
    await t.close()
    const again = await fixture(async body => response(body, "completed", "apply"), t.storage)
    try {
      await again.setup.retryRepositorySetup(id); await Promise.all(again.background)
      expect(again.calls.map(call => call.method)).toEqual(["GET"])
      expect(setupCard(again).payload.active?.enabled).toBe(false)
      expect(setupCard(again).payload.request?.observeOnly).toBe(true)
    } finally { await again.close() }
  } finally { await t.close() }
})

test("discovery archives a completed local pause before an older apply replaces it, including repeated reopen", async () => {
  const t = await fixture(async () => { throw Error("Discovery cannot run work") })
  const applied = { ...initialSetup("example/repo", "issues", "maintainer"), revision: 4 }
  const digest = setupCandidate(applied)
  const pause = { requestId: "local-pause", operation: "pause" as const, revision: 4, digest, runId: "pause-run", phase: "completed" as const, updatedAt: 20, results: [], evidence: ["paused:registration"] }
  const history = ["inspect", "evaluate", "trial"].map(operation => ({ ...pause, requestId: `earlier-${operation}`, operation: operation as "inspect" | "evaluate" | "trial", runId: `${operation}-run`, updatedAt: 10 }))
  const active = { registrationId: "paused-registration", workspaceId, owned: true, enabled: false, revision: 4, digest, sourceRevision: "immutable-source", draft: applied.draft }
  const recovered: SetupRecoveryResponse = { owner: "maintainer", repo: applied.repo, job: applied.job, registration: { state: "known", active }, setup: {
    state: "found", input: { requestId: "old-apply", operation: "apply", repo: applied.repo, job: applied.job, draft: applied.draft, revision: 4, digest },
    result: { requestId: "old-apply", revision: 4, digest, workspaceId, receipt: { ...pause, requestId: "old-apply", operation: "apply", runId: "apply-run", updatedAt: 15 } }
  } }
  const id = "setup:maintainer:example%2Frepo:issues"
  await t.store.dispatch({ type: "card.upsert", actor: "system", card: { id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
    payload: { ...applied, revision: 5, inspectedAt: 10, workspaceId, receipt: pause, previousReceipts: history, active,
      request: { id: pause.requestId, operation: "pause", revision: 4, digest, state: "completed" } }
  } }).isPersisted.promise
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", applied.repo); await Promise.all(t.background)
    const state = setupCard(t).payload
    expect(state.receipt?.requestId).toBe("old-apply")
    expect(state.previousReceipts).toEqual([...history, pause])
    expect(state.active?.enabled).toBe(false)
    expect(state.revision).toBe(5)
    expect(state.evaluation).toBeUndefined()
    expect(state.trial).toBeUndefined()
    expect(t.calls).toEqual([])
    await t.close()
    const reopened = await fixture(async () => { throw Error("Discovery cannot run work") }, t.storage)
    reopened.recovery.answer = async () => Response.json(recovered)
    try {
      await reopened.setup.openRepositorySetup("issues", applied.repo); await Promise.all(reopened.background)
      expect(setupCard(reopened).payload.previousReceipts).toEqual([...history, pause])
      expect(setupCard(reopened).payload.active?.enabled).toBe(false)
      expect(reopened.calls).toEqual([])
      expect((await reopened.store.verifyState()).valid).toBe(true)
    } finally { await reopened.close() }
  } finally { await t.close() }
})

test("partial recovery failure never launches a fresh inspection or infers missing eval and trial proof", async () => {
  const t = await fixture(async () => { throw Error("No launch") })
  const base = initialSetup("example/repo", "issues", "maintainer")
  const registration = { registrationId: "active-foreign", workspaceId, revision: 4, digest: setupCandidate({ ...base, revision: 4 }), sourceRevision: "source", enabled: true, owned: false, draft: base.draft }
  t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: base.repo, job: base.job, registration: { state: "known", active: registration }, setup: { state: "unavailable", error: "Stored receipt is unavailable" } })
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.active?.enabled).toBe(true)
    expect(card.payload.active?.owned).toBe(false)
    expect(card.payload.workspaceId).toBeUndefined()
    expect(card.payload.recovery?.registrationState).toBe("known")
    expect(card.payload.evaluation).toBeUndefined()
    expect(card.payload.trial).toBeUndefined()
    expect(card.payload.recovery?.state).toBe("failed")
    expect(t.calls).toEqual([])
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: base.repo, job: base.job, registration: { state: "unavailable", error: "HTTP 503" }, setup: { state: "none" } })
    await t.setup.retryRepositorySetup(card.id); await Promise.all(t.background)
    expect(setupCard(t).payload.recovery?.registrationState).toBe("unavailable")
    expect(setupCard(t).payload.active?.enabled).toBe(true)
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("expired unknown execution has a finite failure toast and its Retry only observes", async () => {
  const t = await fixture(async (_body, method) => { expect(method).toBe("GET"); return Response.json({ message: "No recorded run" }, { status: 503 }) })
  const recovered = recoveredInspection()
  if (recovered.setup.state !== "found") throw Error("fixture")
  const input = { ...recovered.setup.input, operation: "apply" as const }
  recovered.setup = { state: "found", input, observationError: "Expired", result: { requestId: input.requestId, revision: input.revision, digest: input.digest,
    receipt: { requestId: input.requestId, revision: input.revision, digest: input.digest, operation: "apply", phase: "queued", updatedAt: 1, results: [], evidence: [] } } }
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.request?.state).toBe("failed")
    expect(card.payload.request?.error).toContain("unknown")
    expect(t.calls).toEqual([])
    expect([...t.store.collections.toasts.values()].every(toast => toast.status !== "running")).toBe(true)
    await t.setup.retryRepositorySetup(card.id); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["GET"])
    expect(setupCard(t).payload.receipt?.phase).toBe("queued")
  } finally { await t.close() }
})

test("known-run observation error gets one bounded read; another failure settles and Retry remains read-only", async () => {
  let failing = true
  const t = await fixture(async body => {
    if (failing) return Response.json({}, { status: 503 })
    const result = await response(body, "completed", "evaluate").json() as { receipt: { runId: string } }
    result.receipt.runId = "stored-run"
    return Response.json(result)
  })
  const recovered = recoveredInspection()
  if (recovered.setup.state !== "found") throw Error("fixture")
  recovered.setup = { ...recovered.setup, observationError: "Observation expired", input: { ...recovered.setup.input, operation: "evaluate" },
    result: { ...recovered.setup.result, inspection: undefined, receipt: { ...recovered.setup.result.receipt!, operation: "evaluate", phase: "waiting" } } }
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => setupCard(t).payload.request?.state === "failed")
    const id = setupCard(t).id
    expect(t.calls.map(call => call.method)).toEqual(["GET"])
    expect(setupCard(t).payload.receipt?.phase).toBe("waiting")
    expect([...t.store.collections.toasts.values()].every(toast => toast.status !== "running")).toBe(true)
    failing = false
    await t.setup.retryRepositorySetup(id); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["GET", "GET"])
    expect(setupCard(t).payload.request?.state).toBe("completed")
  } finally { await t.close() }
})

test("recovery rejects mismatched candidate and workspace identities while retaining current input", () => {
  const initial = initialSetup("example/repo", "issues", "maintainer")
  const current = { ...initial, recovery: { id: "recover", baseRevision: 1, baseDigest: setupCandidate(initial), adoptDraft: true, state: "requested" as const, registrationState: "unknown" as const } }
  const badDigest = recoveredInspection()
  if (badDigest.setup.state !== "found") throw Error("fixture")
  badDigest.setup.input.draft.budgetMinutes += 1
  expect(() => projectRecoveredSetup(current, badDigest)).toThrow("does not match")
  const otherRequest = recoveredInspection()
  if (otherRequest.setup.state !== "found") throw Error("fixture")
  otherRequest.setup.result.requestId = "another-inspection"
  expect(() => projectRecoveredSetup(current, otherRequest)).toThrow("The recovered receipt does not match its setup request.")
  const wrongWorkspace = recoveredInspection()
  if (wrongWorkspace.setup.state !== "found") throw Error("fixture")
  wrongWorkspace.registration = { state: "known", active: { registrationId: "other-maintainer", workspaceId, owned: false,
    enabled: false, revision: 1, digest: setupCandidate(initial), sourceRevision: "e1846f17", draft: initial.draft } }
  expect(() => projectRecoveredSetup({ ...current, workspaceId: deadPin }, wrongWorkspace)).toThrow("The recovered setup belongs to another workspace.")
  expect(current.revision).toBe(1)
})

test("edits survive a failed discovery followed by successful Retry and later refresh", async () => {
  const t = await fixture(async () => { throw Error("No launch") }), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json({ owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "unavailable", error: "Offline" }, setup: { state: "none" } }) }
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    const id = setupCard(t).id
    await t.setup.configureRepositorySetup(id, "budgetMinutes", 19)
    held.release(); await Promise.all(t.background)
    t.recovery.answer = async () => Response.json(recoveredInspection())
    await t.setup.retryRepositorySetup(id); await Promise.all(t.background)
    expect(setupCard(t).payload.draft.budgetMinutes).toBe(19)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    expect(setupCard(t).payload.draft.budgetMinutes).toBe(19)
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close() }
})

test("held recovery admission persists before network and duplicates cannot cross a failed sign-out epoch", async () => {
  const t = await fixture(async () => { throw Error("No launch") }), held = deferred()
  const dispatch = t.store.dispatch.bind(t.store)
  let persisting = false
  const spy = spyOn(t.store, "dispatch").mockImplementation(transition => {
    const result = dispatch(transition)
    if (transition.type !== "card.upsert" || transition.card.kind !== "repository-setup" || transition.card.payload.recovery?.state !== "requested") return result
    persisting = true
    const persisted = { ...result.isPersisted, promise: held.promise.then(() => result.isPersisted.promise) }
    return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
  })
  try {
    const first = t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => persisting)
    const duplicate = t.setup.openRepositorySetup("issues", "example/repo")
    expect(t.recovery.calls).toEqual([])
    // The identity row remains after refused local sign-out cleanup, but the
    // account epoch already invalidates both waiting admissions.
    Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
    held.release(); await Promise.all([first, duplicate])
    expect(t.recovery.calls).toEqual([])
    expect(t.calls).toEqual([])
  } finally { held.release(); spy.mockRestore(); await t.close() }
})

test.each(["registration", "setup"] as const)("a held %s partial-response body cannot cross owner epochs or release the next observer", async failed => {
  const t = await fixture(async () => { throw Error("No launch") }), old = deferred(), next = deferred()
  let count = 0, reading = false
  const value: SetupRecoveryResponse = failed === "registration" ? { ...recoveredInspection(), registration: { state: "unavailable", error: "Policy offline" } }
    : { owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "unavailable", error: "Receipt offline" } }
  t.recovery.answer = async () => {
    count += 1
    if (count > 1) { await next.promise; return Response.json(recoveredInspection()) }
    const response = Response.json(value)
    response.json = async () => { reading = true; await old.promise; return value }
    return response
  }
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => reading)
    Object.assign(t.ctx, { accountEpoch: t.ctx.accountEpoch + 1 })
    await t.setup.openRepositorySetup("issues", "example/repo")
    expect(count).toBe(2)
    old.release(); await t.background[0]
    expect(setupCard(t).payload.recovery?.state).toBe("requested")
    await t.setup.openRepositorySetup("issues", "example/repo")
    expect(count).toBe(2)
    next.release(); await Promise.all(t.background)
    expect(setupCard(t).payload.request?.state).toBe("completed")
    expect(setupCard(t).payload.recovery?.state).toBe("completed")
    expect(setupCard(t).payload.draft.cases[0]?.id).toBe("repo-case")
    expect(t.calls).toEqual([])
  } finally { old.release(); next.release(); await t.close() }
})

test("a late discovery remains bound to its explicit repository when global selection changes", async () => {
  const t = await fixture(async () => { throw Error("No launch") }), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json(recoveredInspection()) }
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await t.store.dispatch({ type: "repo.selected", actor: "user", id: "other/repository" }).isPersisted.promise
    held.release(); await Promise.all(t.background)
    expect(setupCard(t).payload.repo).toBe("example/repo")
    expect(setupCard(t).payload.request?.state).toBe("completed")
    expect(t.recovery.calls.every(url => new URL(url, "https://app.test").searchParams.get("repo") === "example/repo")).toBe(true)
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close() }
})

test("a changed server session cannot adopt another account's recovery before the local identity row refreshes", async () => {
  const t = await fixture(async () => { throw Error("No launch") })
  t.recovery.answer = async () => Response.json({ ...recoveredInspection(), owner: "bob" })
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.owner).toBe("maintainer")
    expect(card.payload.recovery?.error).toContain("different account")
    expect(card.payload.workspaceId).toBeUndefined()
    expect(card.payload.request).toBeUndefined()
    expect(card.payload.draft.cases).toEqual([])
    expect(card.payload.active).toBeUndefined()
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

/*
 * The workspace a setup is pinned to can be deleted between two operations.
 * The host then selects a replacement on the same route a first setup uses,
 * and the card has to follow it instead of refusing its own new box.
 */
const replacement = "33333333-3333-4333-8333-333333333333"
const WORKSPACE_GONE = "workspace_gone — The workspace behind this setup is gone. Not your fault; retry creates a new one."
/* WORKSPACE_GONE is not a `<phase> — <code>: <sentence>` verdict, so the card shows this in its place and keeps the raw text on the receipt. */
const UNREADABLE_RECEIPT = "The setup host's answer couldn't be read. Not your fault."

const pinned = async (t: Awaited<ReturnType<typeof fixture>>, payload: Partial<RepositorySetup>) => {
  const card = t.store.collections.cards.get("setup")!
  await t.store.dispatch({ type: "card.upsert", actor: "system",
    card: { ...card, kind: "repository-setup", payload: { ...t.state(), workspaceId, ...payload } } }).isPersisted.promise
}

test("a host that replaced the deleted workspace this request pinned has its new one adopted", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed").json()
    return Response.json({ ...value, workspaceId: replacement })
  })
  try {
    await pinned(t, {})
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    expect(t.calls[0]?.body.workspaceId).toBe(workspaceId)
    expect(t.state().request?.error).toBeUndefined()
    expect(t.state().request?.state).toBe("completed")
    expect(t.state().workspaceId).toBe(replacement)
  } finally { await t.close() }
})

test("retrying a setup its workspace outlived reruns the operation instead of reconnecting", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", "inspect").json()
    return Response.json({ ...value, workspaceId: replacement })
  })
  try {
    const digest = setupCandidate(t.state())
    const receipt = { requestId: "lost", operation: "inspect" as const, revision: t.state().revision, digest,
      phase: "failed" as const, updatedAt: 1, results: [], evidence: [], error: WORKSPACE_GONE }
    await pinned(t, { receipt, previousReceipts: [receipt],
      request: { id: "lost", operation: "inspect", revision: t.state().revision, digest, state: "failed", observeOnly: true, error: WORKSPACE_GONE } })
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect(t.calls[0]?.body.requestId).not.toBe("lost")
    expect(t.calls[0]?.body.workspaceId).toBe(workspaceId)
    expect(t.state().request?.state).toBe("completed")
    expect(t.state().request?.error).toBeUndefined()
    expect(t.state().workspaceId).toBe(replacement)
  } finally { await t.close() }
})

/*
 * The same settled failure learned from the host after a reload, as production
 * served it: the page never watched this request fail, so the recovered
 * receipt is the card's only evidence that the attempt is over.
 */
const SETTLED_REQUEST = "896394a9-7bc3-442a-a2f7-b5d6a4f858eb"
const deadPin = "f387bca6-6c93-4e22-9a5a-dbe0b455d51d"
const settledWorkspaceGone = (): SetupRecoveryResponse => {
  const base = initialSetup("example/repo", "issues", "maintainer")
  const digest = setupCandidate({ ...base, revision: 5 })
  const input = { requestId: SETTLED_REQUEST, operation: "inspect" as const, repo: base.repo, job: base.job,
    revision: 5, digest, draft: base.draft, workspaceId: deadPin }
  const receipt = { requestId: SETTLED_REQUEST, operation: "inspect" as const, revision: 5, digest,
    phase: "failed" as const, updatedAt: 1789685252210, results: [], evidence: [], error: WORKSPACE_GONE }
  return { owner: "maintainer", repo: base.repo, job: base.job,
    registration: { state: "known", active: { registrationId: "a5622c49", workspaceId: replacement, owned: true, enabled: false,
      revision: 4, digest: setupCandidate({ ...base, revision: 4 }), sourceRevision: "e1846f17", draft: base.draft } },
    setup: { state: "found", input, result: { requestId: SETTLED_REQUEST, revision: 5, digest, receipt } } }
}

test("retrying a settled failure recovered after a reload starts a new request instead of replaying the old one", async () => {
  const t = await fixture(async body => response(body, "completed", "inspect"))
  t.recovery.answer = async () => Response.json(settledWorkspaceGone())
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.revision).toBe(5)
    expect(card.payload.request).toMatchObject({ id: SETTLED_REQUEST, state: "failed", error: UNREADABLE_RECEIPT })
    expect(card.payload.request?.error).not.toContain("workspace_gone")
    expect(card.payload.receipt?.error).toBe(WORKSPACE_GONE)
    expect(t.calls).toEqual([])
    await t.setup.retryRepositorySetup(card.id); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect(t.calls[0]?.body.requestId).not.toBe(SETTLED_REQUEST)
    expect(t.calls[0]?.body.workspaceId).toBeUndefined()
    expect(setupCard(t).payload.request).toMatchObject({ operation: "inspect", state: "completed" })
    expect(setupCard(t).payload.previousReceipts.find(item => item.requestId === SETTLED_REQUEST)?.error).toBe(WORKSPACE_GONE)
  } finally { await t.close() }
})

test("a browser pinned to the deleted workspace adopts the registration's live one instead of refusing recovery", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", "inspect").json() as Record<string, unknown>
    return Response.json({ ...value, workspaceId: replacement })
  })
  t.recovery.answer = async () => Response.json(settledWorkspaceGone())
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: "setup:maintainer:example%2Frepo:issues",
      kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
      payload: { ...initialSetup("example/repo", "issues", "maintainer"), workspaceId: deadPin, inspectedAt: 1 } } }).isPersisted.promise
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.recovery).toMatchObject({ state: "completed", registrationState: "known" })
    expect(card.payload.recovery?.error).toBeUndefined()
    expect(card.payload.workspaceId).toBe(replacement)
    expect(card.payload.request).toMatchObject({ id: SETTLED_REQUEST, state: "failed", error: UNREADABLE_RECEIPT })
    expect(card.payload.request?.error).not.toContain("workspace_gone")
    expect(card.payload.receipt?.error).toBe(WORKSPACE_GONE)
    expect(t.calls).toEqual([])
    await t.setup.retryRepositorySetup(card.id); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect(t.calls[0]?.body.requestId).not.toBe(SETTLED_REQUEST)
    expect(t.calls[0]?.body.workspaceId).toBe(replacement)
    expect(setupCard(t).payload.request).toMatchObject({ operation: "inspect", state: "completed" })
    expect(setupCard(t).payload.workspaceId).toBe(replacement)
  } finally { await t.close() }
})

/*
 * A request that pinned a deleted workspace ends on the replacement the host
 * bound for it, and the recovered result reports that replacement while the
 * recorded input keeps the dead pin. A page that never watched the allocation
 * reads both back, so recovery has to follow the host instead of refusing the
 * whole projection and leaving every door answering "Setup recovery requested."
 */
const persistedSetup = async (t: Awaited<ReturnType<typeof fixture>>, workspace?: string) =>
  t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: "setup:maintainer:example%2Frepo:issues",
    kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
    payload: { ...initialSetup("example/repo", "issues", "maintainer"), workspaceId: workspace, inspectedAt: 1 } } }).isPersisted.promise

const loadedWorkspaces = async (t: Awaited<ReturnType<typeof fixture>>, ...ids: Array<string>) =>
  t.store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: "example/repo",
    workspaces: ids.map(id => ({ id, repoId: "example/repo", name: id, targetBookmark: null, status: "running" as const,
      provisioningStage: null, suspendedAt: null, createdAt: null })) }).isPersisted.promise

const boundTo = (pin: string | undefined): SetupRecoveryResponse => {
  const recovered = settledWorkspaceGone()
  if (recovered.setup.state !== "found") throw Error("fixture")
  recovered.setup = { ...recovered.setup, input: { ...recovered.setup.input, workspaceId: pin },
    result: { ...recovered.setup.result, workspaceId: replacement } }
  return recovered
}

const registeredOn = (workspace: string): SetupRecoveryResponse => {
  const base = initialSetup("example/repo", "issues", "maintainer")
  return { owner: "maintainer", repo: base.repo, job: base.job,
    registration: { state: "known", active: { registrationId: "a5622c49", workspaceId: workspace, owned: true, enabled: false,
      revision: 4, digest: setupCandidate({ ...base, revision: 4 }), sourceRevision: "e1846f17", draft: base.draft } },
    setup: { state: "none" } }
}

test("a recovered result naming the replacement of the pin its own request carried recovers, and every door acts", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", "inspect").json() as Record<string, unknown>
    return Response.json({ ...value, workspaceId: replacement })
  })
  t.recovery.answer = async () => Response.json(boundTo(deadPin))
  try {
    await persistedSetup(t, deadPin)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.recovery).toMatchObject({ state: "completed", registrationState: "known" })
    expect(card.payload.recovery?.error).toBeUndefined()
    expect(card.payload.workspaceId).toBe(replacement)
    expect(card.payload.request).toMatchObject({ id: SETTLED_REQUEST, state: "failed", error: UNREADABLE_RECEIPT })
    expect(card.payload.request?.error).not.toContain("workspace_gone")
    expect(card.payload.receipt?.error).toBe(WORKSPACE_GONE)
    await t.setup.retryRepositorySetup(card.id); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect(t.calls[0]?.body.workspaceId).toBe(replacement)
    const answers: Array<unknown> = []
    for (const operation of ["inspect", "evaluate", "trial", "apply", "pause"] as const) {
      answers.push(await t.setup.runRepositorySetup(card.id, operation)); await Promise.all(t.background)
    }
    expect(answers).not.toContainEqual({ value: "Setup recovery requested." })
    // Retry, then the four operations a paused registration accepts; pause is
    // the one refusal, because this registration is already paused.
    expect(t.calls.filter(call => call.method === "POST")).toHaveLength(5)
    expect(answers.at(-1)).toBe("This setup is not enabled.")
    expect(t.calls.every(call => call.body.workspaceId === replacement)).toBe(true)
  } finally { await t.close() }
})

test("a recovered result for a request that carried no pin adopts the host's workspace instead of refusing", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", "inspect").json() as Record<string, unknown>
    return Response.json({ ...value, workspaceId: replacement })
  })
  t.recovery.answer = async () => Response.json(boundTo(undefined))
  try {
    await persistedSetup(t, deadPin)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.recovery).toMatchObject({ state: "completed", registrationState: "known" })
    expect(card.payload.recovery?.error).toBeUndefined()
    expect(card.payload.workspaceId).toBe(replacement)
    const inspect = await t.setup.runRepositorySetup(card.id, "inspect"); await Promise.all(t.background)
    expect(inspect).not.toEqual({ value: "Setup recovery requested." })
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect(t.calls[0]?.body.workspaceId).toBe(replacement)
  } finally { await t.close() }
})

test("a pin the loaded workspaces still list is not moved by a registration naming a deleted box", async () => {
  const t = await fixture(async body => response(body, "completed", "inspect"))
  t.recovery.answer = async () => Response.json(registeredOn(deadPin))
  try {
    await persistedSetup(t, replacement)
    await loadedWorkspaces(t, replacement)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    expect(setupCard(t).payload.recovery).toMatchObject({ state: "completed", registrationState: "known" })
    expect(setupCard(t).payload.workspaceId).toBe(replacement)
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("a pin the loaded workspaces no longer list is replaced by the registration's own box", async () => {
  const t = await fixture(async body => response(body, "completed", "inspect"))
  t.recovery.answer = async () => Response.json(registeredOn(replacement))
  try {
    await persistedSetup(t, deadPin)
    await loadedWorkspaces(t, replacement)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    expect(setupCard(t).payload.recovery).toMatchObject({ state: "completed", registrationState: "known" })
    expect(setupCard(t).payload.workspaceId).toBe(replacement)
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

/*
 * Canary walk run 3 (B3-N4): the fixture workspace was deleted and replaced, the
 * registration still named the deleted one, so nothing moved the card's pin and
 * every request created that morning carried `input.workspaceId` of a workspace
 * that no longer existed while the host ran the work on the box it allocated.
 */
test("a request never carries a pin the loaded workspaces no longer list", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", "inspect").json() as Record<string, unknown>
    return Response.json({ ...value, workspaceId: replacement })
  })
  t.recovery.answer = async () => Response.json(registeredOn(deadPin))
  try {
    await persistedSetup(t, deadPin)
    await loadedWorkspaces(t, replacement)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.recovery).toMatchObject({ state: "completed", registrationState: "known" })
    await t.setup.runRepositorySetup(card.id, "inspect"); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect(t.calls[0]?.body.workspaceId).toBeUndefined()
    expect(setupCard(t).payload.request).toMatchObject({ operation: "inspect", state: "completed" })
    expect(setupCard(t).payload.workspaceId).toBe(replacement)
  } finally { await t.close() }
})

/*
 * The next inspection re-pins the cases it wrote to the commit it captured
 * (flows/repository/setup.ts). A case the person or the agent has written
 * through this door is theirs, pin included, so the write drops that mark.
 */
test("editing a case through the configure door makes it the maintainer's, so the next inspection leaves its pin", () => {
  const inspected = editSetup(initialSetup("example/repo", "issues", "maintainer"),
    { ...initialSetup("example/repo", "issues", "maintainer").draft, cases: [
      { id: "c1", name: "Answers a source question", input: "{\"pin\":1}", expected: "It cites the README.", required: true },
      { id: "c2", name: "Reproduces the reported bug", input: "{\"pin\":2}", expected: "It runs the fixture.", required: true }
    ] })
  expect(inspected.draft.cases.map(test => test.edited)).toEqual([undefined, undefined])
  const edited = applySetupEdit(inspected.draft, "issues", "cases",
    inspected.draft.cases.map(test => test.id === "c1" ? { ...test, expected: "It cites CONTRIBUTING.md." } : test))
  expect("error" in edited).toBe(false)
  expect("draft" in edited && edited.draft.cases.map(test => test.edited)).toEqual([true, undefined])
  expect("draft" in edited && edited.draft.cases[0]?.expected).toBe("It cites CONTRIBUTING.md.")
})

test("a pin no loaded collection can contradict is still sent", async () => {
  const t = await fixture(async body => response(body, "completed", "inspect"))
  t.recovery.answer = async () => Response.json(registeredOn(workspaceId))
  try {
    await persistedSetup(t, workspaceId)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    await t.setup.runRepositorySetup(setupCard(t).id, "inspect"); await Promise.all(t.background)
    expect(t.calls[0]?.body.workspaceId).toBe(workspaceId)
  } finally { await t.close() }
})

/* Both host spellings of a same-id POST whose input differs must spend the id. */
const REUSED = { status: "error", code: "setup_request_reused",
  message: "This setup request was already used for another operation. Not your fault; retry starts a new one." }

test.each(["setup_request_conflict", "setup_request_reused"])("a request id refused with %s is spent: the next Retry asks under a new one", async (code) => {
  let lost = true
  const spent = new Set<string>()
  const t = await fixture(async body => {
    if (lost) { lost = false; spent.add(body.requestId); throw Error("Connection lost") }
    return spent.has(body.requestId) ? Response.json({ ...REUSED, code }, { status: 409 }) : response(body)
  })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    const id = t.state().request!.id
    expect(t.state().request?.state).toBe("failed")
    // The lost response is retried under its own id, exactly as before.
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.calls.map(call => call.body.requestId)).toEqual([id, id])
    expect(t.state().request?.state).toBe("failed")
    // The refusal says this one is spent, so a third attempt must not repeat it.
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.calls).toHaveLength(3)
    expect(t.calls[2]?.body.requestId).not.toBe(id)
    expect(t.state().request?.state).toBe("completed")
    expect(t.state().previousReceipts.some(item => item.requestId === id)).toBe(false)
  } finally { await t.close() }
})

/*
 * Setup requests the retired Worker host admitted were not moved to the
 * backend (#2198): a reload finds no record of one there, and observing it
 * answers 404. The card must settle retryable, not reconnect forever.
 */
test("a reconnect to a request the host has no record of settles, and Retry asks again under a new id", async () => {
  const t = await fixture(async (body, method) => method === "GET"
    ? Response.json({ status: "error", code: "not_found", message: "Setup request not found" }, { status: 404 })
    : response(body))
  try {
    const digest = setupCandidate(t.state())
    await pinned(t, { request: { id: "worker-era", operation: "evaluate", revision: t.state().revision, digest, state: "running", observeOnly: true } })
    t.setup.resumeRepositorySetups()
    await until(() => t.state().request?.state === "failed")
    await Promise.all(t.background)
    expect(t.calls.map(call => [call.method, call.body.requestId])).toEqual([["GET", "worker-era"]])
    expect(t.state().request?.observeOnly).toBeUndefined()
    expect(t.state().recovery?.state).toBe("completed")
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["GET", "POST"])
    expect(t.calls[1]?.body.requestId).not.toBe("worker-era")
    expect(t.state().request?.state).toBe("completed")
  } finally { await t.close() }
})

test("the host's username names the same account in any case", () => {
  const current = { ...initialSetup("example/repo", "issues", "Maintainer"), recovery: { id: "r", baseRevision: 1, baseDigest: "d", state: "requested" as const, registrationState: "unknown" as const } }
  const recovered: SetupRecoveryResponse = { owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" } }
  expect(projectRecoveredSetup(current, recovered).recovery?.state).toBe("completed")
  expect(() => projectRecoveredSetup(current, { ...recovered, owner: "someone-else" })).toThrow("different account")
})

test("a settled failure recovered after a reload never reaches the reused-id refusal at all", async () => {
  const t = await fixture(async body => body.requestId === SETTLED_REQUEST
    ? Response.json(REUSED, { status: 409 }) : response(body, "completed", "inspect"))
  t.recovery.answer = async () => Response.json(settledWorkspaceGone())
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    expect(setupCard(t).payload.request).toMatchObject({ id: SETTLED_REQUEST, state: "failed" })
    await t.setup.retryRepositorySetup(setupCard(t).id); await Promise.all(t.background)
    expect(t.calls.every(call => call.body.requestId !== SETTLED_REQUEST)).toBe(true)
    expect(setupCard(t).payload.request).toMatchObject({ operation: "inspect", state: "completed" })
  } finally { await t.close() }
})

/*
 * R77b follow-up 1: the workspace guard lost its `current.workspaceId`
 * precondition, so a card that carries no pin at all measured
 * `result.workspaceId !== undefined` as a mismatch and refused. That card has
 * nothing to protect and no other door, so it adopts what the host reports.
 */
const unowned = "c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
const unownedElsewhere = (): SetupRecoveryResponse => {
  const recovered = boundTo(undefined)
  if (recovered.setup.state !== "found" || recovered.registration.state !== "known" || !recovered.registration.active) throw Error("fixture")
  return { ...recovered, registration: { ...recovered.registration, active: { ...recovered.registration.active, workspaceId: unowned, owned: false } },
    setup: { ...recovered.setup, result: { ...recovered.setup.result, workspaceId: unowned } } }
}

test("a card with no pin adopts the host's workspace even where the registration says another account owns it", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", "inspect").json() as Record<string, unknown>
    return Response.json({ ...value, workspaceId: unowned })
  })
  t.recovery.answer = async () => Response.json(unownedElsewhere())
  try {
    await persistedSetup(t)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.recovery).toMatchObject({ state: "completed", registrationState: "known" })
    expect(card.payload.recovery?.error).toBeUndefined()
    expect(card.payload.workspaceId).toBe(unowned)
    const inspect = await t.setup.runRepositorySetup(card.id, "inspect"); await Promise.all(t.background)
    expect(inspect).not.toEqual({ value: "Setup recovery requested." })
    expect(t.calls.map(call => call.method)).toEqual(["POST"])
    expect(t.calls[0]?.body.workspaceId).toBe(unowned)
  } finally { await t.close() }
})

test("the toast a settled setup refusal leaves states the host's sentence while the card keeps the verdict", async () => {
  const REFUSAL = "Run evals for this exact candidate before continuing"
  /* The 300ms law: only work that outlives the debounce leaves a toast, and a real setup run does. */
  const gate = deferred()
  const t = await fixture(async body => {
    await gate.promise
    const value = await response(body, "failed", "trial").json() as { receipt: Record<string, unknown> }
    return Response.json({ ...value, receipt: { ...value.receipt, error: `failed — invalid_receipt: ${REFUSAL}` } })
  })
  try {
    await t.setup.runRepositorySetup("setup", "trial")
    await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
    gate.release()
    await Promise.all(t.background)
    expect(t.state().request?.state).toBe("failed")
    expect(t.state().request?.error).toBe(`failed — invalid_receipt: ${REFUSAL}`)
    const toasts = [...t.store.collections.toasts.values()].filter(toast => toast.status === "failed")
    expect(toasts.map(toast => toast.detail)).toEqual([REFUSAL])
  } finally { await t.close() }
})

test("the toast a settled refusal recovered after a reload states the host's sentence too", async () => {
  const REFUSAL = "Run evals for this exact candidate before continuing"
  /* The 300ms law again: recovery only leaves a toast when the host's answer outlives the debounce. */
  const gate = deferred()
  const t = await fixture(async body => response(body, "completed", "inspect"))
  t.recovery.answer = async () => {
    await gate.promise
    const recovered = settledWorkspaceGone()
    const receipt = recovered.setup.state === "found" ? recovered.setup.result.receipt : undefined
    if (recovered.setup.state !== "found" || receipt === undefined) throw Error("fixture")
    recovered.setup = { ...recovered.setup, input: { ...recovered.setup.input, operation: "trial" },
      result: { ...recovered.setup.result, receipt: { ...receipt, operation: "trial",
        evidence: ["run:run-3"], error: `failed — invalid_receipt: ${REFUSAL}` } } }
    return Response.json(recovered)
  }
  try {
    const opened = t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
    gate.release()
    await opened; await Promise.all(t.background)
    expect(setupCard(t).payload.request).toMatchObject({ id: SETTLED_REQUEST, state: "failed", error: `failed — invalid_receipt: ${REFUSAL}` })
    const toasts = [...t.store.collections.toasts.values()].filter(toast => toast.status === "failed")
    expect(toasts.map(toast => toast.detail)).toEqual([REFUSAL])
  } finally { gate.release(); await t.close() }
})

/*
 * W1 item 1b, at the two call sites that raise the toast, not only at the card
 * (.artifacts/mvp-claude-orchestration-20260917/R103-review-L103.md): the same
 * Retry press that produced `W1-g L76-issuesAfterRetry` put the fault's own
 * sentence on the card and `failed — execution: The workspace died mid-apply`
 * on the toast beside it. A settled verdict is `<phase> — <code>: <sentence>`,
 * and every code `RECEIPT_CODES` holds is answered on both surfaces by the one
 * exhaustive path, so a member added there and left unanswered fails this test
 * as well as the compiler.
 */
const ENGINE_SENTENCE = "The workspace died mid-apply"
const settledToasts = (t: Awaited<ReturnType<typeof fixture>>) =>
  [...t.store.collections.toasts.values()].filter(toast => toast.status === "failed").map(toast => toast.detail)

/*
 * Two answers are allowed and nothing else: the host's own sentence, when the
 * code says the request is the person's to change, or that fault's standing
 * lead. The verdict line itself is never one of them.
 */
const LEADS = Object.values(REFUSAL_COPY).map(copy => copy.lead)
const answersForPerson = (detail: string | undefined, verdict: string, code: string) => {
  expect(detail).toBeString()
  expect(detail).toBe(setupFailureSentence(verdict))
  expect([ENGINE_SENTENCE, ...LEADS]).toContain(detail ?? "")
  expect(detail).not.toContain(code)
  expect(detail).not.toContain("failed — ")
}

test("every receipt code a settled setup raises reaches the toast as its fault's sentence", async () => {
  for (const code of RECEIPT_CODES) {
    const verdict = `failed — ${code}: ${ENGINE_SENTENCE}`
    const gate = deferred()
    const t = await fixture(async body => {
      await gate.promise
      const value = await response(body, "failed", "trial").json() as { receipt: Record<string, unknown> }
      return Response.json({ ...value, receipt: { ...value.receipt, error: verdict } })
    })
    try {
      await t.setup.runRepositorySetup("setup", "trial")
      await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
      gate.release()
      await Promise.all(t.background)
      expect(t.state().request?.error).toBe(verdict)
      const [detail, ...rest] = settledToasts(t)
      expect(rest).toEqual([])
      answersForPerson(detail, verdict, code)
    } finally { gate.release(); await t.close() }
  }
})

test("every receipt code recovered after a reload reaches the toast as its fault's sentence", async () => {
  for (const code of RECEIPT_CODES) {
    const verdict = `failed — ${code}: ${ENGINE_SENTENCE}`
    const gate = deferred()
    const t = await fixture(async body => response(body, "completed", "inspect"))
    t.recovery.answer = async () => {
      await gate.promise
      const recovered = settledWorkspaceGone()
      const receipt = recovered.setup.state === "found" ? recovered.setup.result.receipt : undefined
      if (recovered.setup.state !== "found" || receipt === undefined) throw Error("fixture")
      recovered.setup = { ...recovered.setup, input: { ...recovered.setup.input, operation: "trial" },
        result: { ...recovered.setup.result, receipt: { ...receipt, operation: "trial", evidence: ["run:run-3"], error: verdict } } }
      return Response.json(recovered)
    }
    try {
      const opened = t.setup.openRepositorySetup("issues", "example/repo")
      await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
      gate.release()
      await opened; await Promise.all(t.background)
      expect(setupCard(t).payload.request).toMatchObject({ state: "failed", error: verdict })
      const [detail, ...rest] = settledToasts(t)
      expect(rest).toEqual([])
      answersForPerson(detail, verdict, code)
    } finally { gate.release(); await t.close() }
  }
})

/*
 * Defect C-3 (.artifacts/mvp-canary-walk-20260917/C-REPORT.md): one required
 * command check whose trial kept failing left the feature job enabled at
 * revision 6 with the draft at revision 11, and manual work refused for the
 * life of that draft. The run gate is the product's own rule — `setup.run`
 * with operation `run` "requires an active revision/digest match"
 * (docs/mvp/ENGINEERING.md) — so the way back is returning the candidate to
 * the registration's own configuration.
 */
test("discarding a draft returns the candidate to the enabled registration and unfreezes manual work", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", body.manual ? "run" : "apply").json()
    return Response.json({ ...value, receipt: { ...value.receipt, registrationId: "active-1", sourceRevision: "commit-1",
      ...(body.manual ? { jobRunId: "actual-job-run" } : {}) } })
  })
  const manual = { stepId: "fix", prompt: "Fix the underlying cause", subject: { source: "github", kind: "issue", number: 42 } } as const
  try {
    const card = t.store.collections.cards.get("setup")!
    const payload = { ...t.state(), draft: { ...t.state().draft,
      cases: [{ id: "case", name: "A known bug", input: "a recorded bug", expected: "A reproduction", required: true }] } }
    const digest = setupCandidate(payload)
    const proof = { runId: "prior-run", revision: payload.revision, digest, phase: "completed" as const, updatedAt: 1,
      results: [{ caseId: "case", status: "passed" as const, observed: "A reproduction", evidence: ["test:case"], executionId: "eval-case" }],
      evidence: ["artifact:prior-results"], sourceRevision: "commit-1" }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...payload,
      evaluation: { ...proof, requestId: "eval-1", operation: "evaluate" },
      trial: { ...proof, requestId: "trial-1", operation: "trial", trialIssue: { source: "smithers-cloud", number: 59 } }
    } } }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "apply"); await Promise.all(t.background)
    expect(t.state().active).toEqual({ revision: payload.revision, digest, registrationId: "active-1",
      sourceRevision: "commit-1", enabled: true, draft: payload.draft })
    const applied = t.state().active!
    await t.setup.configureRepositorySetup("setup", "checks", [{ id: "hello", name: "Repository check", kind: "command",
      rule: "test -f docs/nested/hello.txt", paths: ["docs/nested/hello.txt"], policy: "required" }])
    await t.setup.configureRepositorySetup("setup", "budgetMinutes", 30)
    expect(t.state().revision).toBe(applied.revision + 2)
    expect(await t.setup.runRepositorySetup("setup", "run", manual)).toBe("Test and apply this draft before running work.")
    expect(await t.setup.discardRepositorySetupDraft("setup")).toEqual({ value: "Draft discarded." })
    expect(t.state().revision).toBe(applied.revision)
    expect(t.state().draft).toEqual(applied.draft!)
    expect(setupCandidate(t.state())).toBe(applied.digest)
    expect(t.state().active).toEqual(applied)
    expect(t.state().evaluation).toBeUndefined()
    expect(t.state().trial).toBeUndefined()
    expect(t.state().previousReceipts.map(receipt => receipt.requestId)).toContain("trial-1")
    await t.setup.runRepositorySetup("setup", "run", manual); await Promise.all(t.background)
    expect(t.state().request?.state).toBe("completed")
    expect(t.calls.map(call => [call.body.revision, call.body.digest]))
      .toEqual([[applied.revision, applied.digest], [applied.revision, applied.digest]])
    const storage = t.storage
    await t.close()
    const again = await fixture(async body => response(body), storage)
    try {
      expect(again.state().revision).toBe(applied.revision)
      expect(again.state().draft).toEqual(applied.draft!)
    } finally { await again.close() }
  } finally { await t.close() }
})

test("a discard needs this account's own enabled registration and the configuration it recorded", async () => {
  const t = await fixture(async body => response(body))
  try {
    expect(await t.setup.discardRepositorySetupDraft("absent")).toBe("Open the setup first.")
    expect(await t.setup.discardRepositorySetupDraft("setup")).toBe("This setup is not enabled.")
    const active = { revision: 1, digest: setupCandidate(t.state()), registrationId: "active-1", sourceRevision: "commit-1",
      enabled: true, owned: false, draft: t.state().draft }
    const seed = async (payload: Partial<RepositorySetup>) => {
      const card = t.store.collections.cards.get("setup")!
      await t.store.dispatch({ type: "card.upsert", actor: "system",
        card: { ...card, kind: "repository-setup", payload: { ...t.state(), ...payload } } }).isPersisted.promise
    }
    await seed({ active })
    await t.setup.configureRepositorySetup("setup", "budgetMinutes", 30)
    expect(await t.setup.discardRepositorySetupDraft("setup")).toBe("This registration belongs to another maintainer.")
    await seed({ active: { ...active, owned: true, draft: undefined } })
    expect(await t.setup.discardRepositorySetupDraft("setup")).toEqual({ value: "Handle issues requested." })
    expect(t.state().recovery?.state).toBe("requested")
    await Promise.all(t.background)
    await seed({ revision: 1, draft: active.draft, active: { ...active, owned: true }, recovery: undefined })
    expect(setupCandidate(t.state())).toBe(active.digest)
    expect(await t.setup.discardRepositorySetupDraft("setup")).toEqual({ value: "Keeping the current setup." })
    expect(t.state().revision).toBe(1)
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("recovery records the enabled registration's own configuration so the way back survives a reload", () => {
  const initial = initialSetup("example/repo", "issues", "maintainer")
  const current: RepositorySetup = { ...initial, revision: 3, draft: { ...initial.draft, budgetMinutes: 30 },
    recovery: { id: "recover", baseRevision: 3, baseDigest: "stale", state: "requested", registrationState: "unknown" } }
  const policy = { registrationId: "active-1", workspaceId, revision: 1, digest: setupCandidate(initial),
    sourceRevision: "commit-1", enabled: true, owned: true, draft: initial.draft }
  const recovered: SetupRecoveryResponse = { owner: "maintainer", repo: initial.repo, job: initial.job,
    registration: { state: "known", active: policy }, setup: { state: "none" } }
  const projected = projectRecoveredSetup(current, recovered)
  expect(projected.revision).toBe(3)
  expect(projected.active?.draft).toEqual(initial.draft)
  expect(setupCandidate({ ...projected, revision: policy.revision, draft: projected.active!.draft! })).toBe(policy.digest)
})

/*
 * R88 follow-up 3: discarding destroys the prompts, checks and eval cases the
 * person wrote, with no undo. A consequential act confirms whoever invokes it
 * (apps/app/AGENTS.md three-door law), so the door the button and the slash
 * reach asks the same confirmation the model's invocation gets, and only the
 * human's answer discards.
 */
test("the discard door asks first, and only the confirmation's own door discards", async () => {
  const t = await fixture(async body => response(body))
  try {
    expect(await t.setup.askRepositorySetupDiscard("absent")).toBe("Open the setup first.")
    expect(await t.setup.askRepositorySetupDiscard("setup")).toBe("This setup is not enabled.")
    expect(t.asked).toEqual([])
    const active = { revision: 1, digest: setupCandidate(t.state()), registrationId: "active-1", sourceRevision: "commit-1",
      enabled: true, owned: true, draft: t.state().draft }
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system",
      card: { ...card, kind: "repository-setup", payload: { ...t.state(), active } } }).isPersisted.promise
    await t.setup.configureRepositorySetup("setup", "budgetMinutes", 30)
    const edited = t.state()
    expect(await t.setup.askRepositorySetupDiscard("setup")).toBeUndefined()
    expect(t.asked).toEqual([{ name: "setup.discard.confirm", args: "setup" }])
    // Cancelling is not answering: nothing the person wrote has moved.
    expect(t.state()).toEqual(edited)
    expect(await t.setup.discardRepositorySetupDraft("setup")).toEqual({ value: "Draft discarded." })
    expect(t.state().revision).toBe(active.revision)
    expect(t.state().draft).toEqual(active.draft)
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

/*
 * Walk run 3, defect B3-N1: the issues card's `Test issue title` and `Test
 * issue body` were candidate fields, so filling them moved the draft from
 * revision 10 to 12 and `Create test issue` refused with "Run evals for this
 * exact candidate before continuing"
 * (.artifacts/mvp-canary-walk-20260917/B3-13-state-trial-terminal.json).
 */
test("filling the trial's test request trials the candidate the evals passed on", async () => {
  const t = await fixture(async body => response(body, "completed", "trial"))
  try {
    const card = t.store.collections.cards.get("setup")!
    const payload = { ...t.state(), revision: 10, draft: { ...t.state().draft,
      cases: [{ id: "case", name: "A known bug", input: "a recorded bug", expected: "A reproduction", required: true }] } }
    const digest = setupCandidate(payload)
    const evaluation = { requestId: "eval-1", runId: "eval-run", operation: "evaluate" as const, revision: payload.revision,
      digest, phase: "completed" as const, updatedAt: 1, evidence: ["artifact:evals"], sourceRevision: "commit-1",
      results: [{ caseId: "case", status: "passed" as const, observed: "A reproduction", evidence: ["test:case"], executionId: "eval-case" }] }
    await t.store.dispatch({ type: "card.upsert", actor: "system",
      card: { ...card, kind: "repository-setup", payload: { ...payload, evaluation } } }).isPersisted.promise
    const title = "[canary 20260918 b3d] Does the README explain the cloud review workflow?"
    await t.setup.configureRepositorySetup("setup", "trialTitle", title)
    await t.setup.configureRepositorySetup("setup", "trialBody", "Answer the question from README.md.")
    expect(t.state().revision).toBe(10)
    expect(setupCandidate(t.state())).toBe(digest)
    expect(t.state().evaluation).toEqual(evaluation)
    await t.setup.runRepositorySetup("setup", "trial"); await Promise.all(t.background)
    expect(t.calls.map(call => [call.body.revision, call.body.digest])).toEqual([[10, digest]])
    expect(t.calls[0]!.body.draft.trialTitle).toBe(title)
    expect(t.state().request?.state).toBe("completed")
  } finally { await t.close() }
})

/*
 * A card whose active registration names neither identity of its draft — the
 * draft was edited somewhere this card never saw. Recovery advances the
 * candidate past the active revision and archives its stale proof, so the job
 * keeps running under its registration while the person re-proves the draft.
 */
test("a card whose registration names another draft recovers by advancing the candidate", () => {
  const initial = initialSetup("example/repo", "issues", "maintainer")
  const stale = "4ae1937060bb181a4d1e1a910fab2b986e4139b8513c296f4c7279fd532686bd"
  const proof = (operation: "evaluate" | "trial") => ({ requestId: `${operation}-1`, runId: `${operation}-run`, revision: 4,
    operation, phase: "completed" as const, digest: stale, updatedAt: 1, results: [], evidence: [`run:${operation}-run`],
    sourceRevision: "commit-1" })
  const current: RepositorySetup = { ...initial, revision: 4, evaluation: proof("evaluate"), trial: proof("trial"),
    active: { revision: 4, digest: stale, registrationId: "active-1", sourceRevision: "commit-1", enabled: true, owned: true, draft: initial.draft },
    recovery: { id: "recover", baseRevision: 4, baseDigest: stale, state: "requested", registrationState: "unknown" } }
  const recovered: SetupRecoveryResponse = { owner: "maintainer", repo: initial.repo, job: initial.job,
    registration: { state: "known", active: { registrationId: "active-1", workspaceId, revision: 4, digest: stale,
      sourceRevision: "commit-1", enabled: true, owned: true, draft: initial.draft } }, setup: { state: "none" } }
  const projected = projectRecoveredSetup(current, recovered)
  expect(setupCandidate(current)).not.toBe(stale)
  expect(projected.revision).toBe(5)
  expect(projected.draft).toEqual(initial.draft)
  expect(projected.active?.enabled).toBe(true)
  expect(projected.evaluation).toBeUndefined()
  expect(projected.trial).toBeUndefined()
  expect(projected.previousReceipts.map(receipt => receipt.requestId)).toEqual(["evaluate-1", "trial-1"])
  expect(setupActivationProblems(projected)).toContain("Run evals for this draft.")
})

/*
 * R96 B1: a registration enabled before the trial's own test request left the
 * candidate carries the digest that hashed it, and Plue never recomputes it.
 * That row still names this draft here too, so recovery leaves the candidate
 * where it is instead of asking for a cycle the running job does not need.
 */
// The digest the build before that change computed for this draft at revision 4.
const registeredDigest = "1eeac04690cc9bee3617a8abc04ebbee093d5849bc78b6cc1dd4b21c33f24942"

test("a registration enabled before the candidate changed still names this draft", () => {
  const initial = initialSetup("example/repo", "issues", "maintainer")
  const current: RepositorySetup = { ...initial, revision: 4,
    recovery: { id: "recover", baseRevision: 4, baseDigest: setupCandidate({ ...initial, revision: 4 }), adoptDraft: true, state: "requested", registrationState: "unknown" } }
  const policy = { registrationId: "active-1", workspaceId, revision: 4, digest: registeredDigest,
    sourceRevision: "commit-1", enabled: true, owned: true, draft: initial.draft }
  const recovered: SetupRecoveryResponse = { owner: "maintainer", repo: initial.repo, job: initial.job,
    registration: { state: "known", active: policy }, setup: { state: "none" } }
  const projected = projectRecoveredSetup(current, recovered)
  expect(setupCandidate(projected)).not.toBe(registeredDigest)
  expect(projected.revision).toBe(4)
  expect(projected.draft).toEqual(initial.draft)
  expect(projected.active?.digest).toBe(registeredDigest)
})

test("manual work and Discard draft read a registration enabled before the candidate changed as applied", async () => {
  const t = await fixture(async body => response(body))
  try {
    // The same draft at revision 1, which is where this card's fixture stands.
    const registered = "eaa65868ff1b8e731c14d789e16b27f980d92492601fca521d9a4534a9b3194f"
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup",
      payload: { ...t.state(), active: { revision: 1, digest: registered, registrationId: "active-1",
        sourceRevision: "commit-1", enabled: true, owned: true, draft: t.state().draft } } } }).isPersisted.promise
    expect(setupCandidate(t.state())).not.toBe(registered)
    expect(await t.setup.runRepositorySetup("setup", "run")).toEqual({ value: "Work request is open." })
    expect(await t.setup.discardRepositorySetupDraft("setup")).toEqual({ value: "Keeping the current setup." })
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("recovered failed receipt replaces its earlier observation without duplicating history", () => {
  const base = initialSetup("example/repo", "issues", "maintainer")
  const recovered = recoveredInspection()
  if (recovered.setup.state !== "found" || !recovered.setup.result.receipt) throw Error("expected recorded setup")
  const failed = { ...recovered.setup.result.receipt, phase: "failed" as const, error: "Model unavailable" }
  const older = { ...failed, requestId: "older-request", runId: "older-run", phase: "completed" as const, error: undefined }
  const current: RepositorySetup = { ...base, previousReceipts: [{ ...failed, phase: "running", error: undefined }, older],
    recovery: { id: "recover", baseRevision: base.revision, baseDigest: setupCandidate(base), state: "requested", registrationState: "unknown" } }
  recovered.setup = { ...recovered.setup, result: { ...recovered.setup.result, inspection: undefined, receipt: failed } }
  const projected = projectRecoveredSetup(current, recovered)
  // "Model unavailable" is not a verdict line: the request reads the unreadable-answer sentence, the receipt keeps the raw words.
  expect(projected.request).toMatchObject({ id: failed.requestId, state: "failed", error: "The setup host's answer couldn't be read. Not your fault." })
  expect(projected.request?.error).not.toContain("Model unavailable")
  expect(projected.receipt).toEqual(failed)
  expect(projected.previousReceipts.map(receipt => [receipt.requestId, receipt.phase])).toEqual([
    [older.requestId, "completed"], [failed.requestId, "failed"]
  ])
})

test("manual Run falls back from a disabled selected step to the first enabled step", async () => {
  const t = await fixture(async body => response(body))
  try {
    const original = t.state()
    const draft = { ...original.draft, steps: original.draft.steps.map(step => step.id === "research" ? { ...step, mode: "off" as const } : step) }
    const candidate = { ...original, draft, selectedStep: "research" }
    const active = { revision: candidate.revision, digest: setupCandidate(candidate), registrationId: "registered",
      sourceRevision: "source", enabled: true, owned: true }
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup",
      payload: { ...candidate, active } } }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "run")).toEqual({ value: "Work request is open." })
    expect(t.state().manualDraft).toEqual({ stepId: "duplicates", prompt: "", source: "github" })
    expect(t.state().view).toBe("work")
    expect(t.calls).toEqual([])

    const allOff = { ...t.state(), manualDraft: undefined, draft: { ...draft,
      steps: draft.steps.map(step => ({ ...step, mode: "off" as const })) } }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup",
      payload: { ...allOff, active: { ...active, digest: setupCandidate(allOff) } } } }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "run")).toBe("Choose an enabled step.")
    expect(t.state().manualDraft).toBeUndefined()
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})
