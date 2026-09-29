import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { initialSetup, setupActivationProblems, setupCandidate, type RepositoryJob, type SetupReceipt, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { projectRecoveredSetup } from "../state/controller/repositorySetup"
import { flowArgs } from "../flows/FlowArgs"
import { payloadFor } from "../flows/SlashPayload"
import type { CardOf } from "./CardFamily"
import { RepositorySetupCard } from "./RepositorySetupCard"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

// The digest the build before the trial's test request left the candidate computed for the canary's
// `feature` draft at revision 6, and the one its enabled registration still carries in the registry
// (flows/test/repository-stored-registration.test.ts).
const REGISTERED_DIGEST = "7d58fb03b7f0ed28a6ba637caacb19617776ea94925eea34b1a495887a2df04b"
const makeCard = (job: RepositoryJob = "issues"): CardOf<"repository-setup"> => ({
  id: "setup", kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: 1,
  payload: initialSetup("example/repo", job, "maintainer")
})
const mount = (card = makeCard(), signedOut = false) => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = (next = card) => flushSync(() => root.render(<RepositorySetupCard card={next} signedOut={signedOut} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
  render()
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)
  return { host, calls, render, button, close: () => { flushSync(() => root.unmount()); host.remove() } }
}

test("pending prompt edits survive blur and older projections, then accept later external edits", () => {
  const card = makeCard()
  card.payload.view = "prompts"
  const t = mount(card)
  try {
    const field = t.host.querySelector<HTMLTextAreaElement>("textarea")!
    field.focus()
    field.value = "Complete prompt"
    field.dispatchEvent(new Event("input", { bubbles: true }))
    field.blur()
    card.payload.draft.steps[0]!.prompt = "Complete"
    t.render(card)
    expect(field.value).toBe("Complete prompt")
    expect(t.calls).toEqual([["setup.configure", flowArgs("setup.configure", { cardId: card.id, field: `step.${card.payload.draft.steps[0]!.id}.prompt`, value: "Complete prompt" })]])
    card.payload.draft.steps[0]!.prompt = "Complete prompt"
    t.render(card)
    card.payload.draft.steps[0]!.prompt = "New external edit"
    t.render(card)
    expect(field.value).toBe("New external edit")
  } finally { t.close() }
})

test("next chore execution shows the recorded UTC date, never an unenabled, paused or edited schedule", () => {
  const card = makeCard("chores"), t = mount(card)
  try {
    expect(t.host.querySelector("time")).toBeNull()
    card.payload.draft.schedule = "30 1 * * *"
    t.render(card)
    expect(t.host.querySelector("time")).toBeNull()
    card.payload.active = { revision: 1, digest: setupCandidate(card.payload), registrationId: "chore-registration", sourceRevision: "source", enabled: true,
      schedule: { expression: "30 1 * * *", nextFireAt: "2026-12-31T23:30:00-02:00" } }
    t.render(card)
    const time = t.host.querySelector("time")!
    expect(time.dateTime).toBe("2026-12-31T23:30:00-02:00")
    expect(time.textContent).toContain("Jan 1, 2027")
    expect(time.textContent).toContain("1:30 AM UTC")
    expect(t.host.textContent).toContain("Next run")
    card.payload.active.schedule!.nextFireAt = "2000-01-01T00:00:00Z"
    t.render(card)
    expect(t.host.querySelector("time")).toBeNull()
    card.payload.active.schedule!.nextFireAt = "2026-12-31T23:30:00-02:00"
    card.payload.active.enabled = false
    t.render(card)
    expect(t.host.querySelector("time")).toBeNull()
    card.payload.active.enabled = true
    card.payload.draft.schedule = "0 10 * * *"
    t.render(card)
    expect(t.host.querySelector("time")).toBeNull()
    card.payload.draft.schedule = "30 1 * * *"
    card.payload.recovery = { id: "recover", baseRevision: 1, baseDigest: setupCandidate(card.payload), state: "failed", registrationState: "unavailable", error: "Offline" }
    t.render(card)
    expect(t.host.querySelector("time")).toBeNull()
    expect(t.calls).toEqual([])
  } finally { t.close() }
})

test("recovery uses the existing status and Retry slot without claiming Off or borrowing another maintainer's actions", () => {
  const card = makeCard()
  card.payload.recovery = { id: "recover", baseRevision: 1, baseDigest: setupCandidate(card.payload), state: "requested", registrationState: "unknown" }
  const t = mount(card)
  const status = () => t.host.querySelector(".setup-heading")?.lastElementChild?.textContent
  try {
    expect(status()).toBe("")
    expect(t.button("Enable issue handling")?.disabled).toBe(true)
    card.payload.recovery = { ...card.payload.recovery, state: "failed", error: "Registration unavailable", registrationState: "unavailable" }
    t.render(card)
    expect(status()).toBe("")
    t.button("Retry")!.click()
    expect(t.calls).toEqual([["setup.retry", card.id]])
    card.payload.recovery = { ...card.payload.recovery, state: "completed", error: undefined, registrationState: "known" }
    card.payload.active = { revision: 1, digest: setupCandidate(card.payload), registrationId: "active", sourceRevision: "source", enabled: true, owned: false }
    t.render(card)
    expect(status()).toBe("Enabled")
    expect(t.button("Pause")).toBeUndefined()
    expect(t.button("Run")).toBeUndefined()
    expect(t.button("Update issue handling")?.disabled).toBe(true)
    card.payload.active = { ...card.payload.active, enabled: false, owned: true }
    t.render(card)
    expect(status()).toBe("Paused")
    card.payload.active = undefined
    card.payload.recovery.trialRegistration = { revision: 1, digest: setupCandidate(card.payload), registrationId: "trial", sourceRevision: "source", enabled: true, owned: true,
      workspaceId: "11111111-1111-4111-8111-111111111111", draft: card.payload.draft }
    t.render(card)
    expect(status()).toBe("Trial")
  } finally { t.close() }
})

test("signed-out preview has a real sign-in door, editable native controls and no network action", () => {
  const t = mount(makeCard(), true)
  try {
    expect(t.button("Inspect repository")).toBeUndefined()
    expect(t.button("Enable issue handling")).toBeUndefined()
    expect(t.host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(false)
    t.button("Sign in")!.click()
    expect(t.calls).toEqual([["auth.prompt", undefined]])
    expect(t.button("Sign in")!.tabIndex).toBe(0)
  } finally { t.close() }
})

test("Configure in Chat uses the registered card-scoped command grammar", () => {
  const card = makeCard()
  const t = mount(card)
  try {
    t.button("Configure in Chat")!.click()
    expect(t.calls).toEqual([["setup.guide", card.id]])
    expect(payloadFor("setup.guide", card.id)).toEqual({ payload: { cardId: card.id } })
  } finally { t.close() }
})

test.each(["issues", "feature"] as const)("%s links optional CI setup to the same repository", job => {
  const card = makeCard(job)
  const t = mount(card)
  try {
    t.button("Set up CI")!.click()
    expect(t.calls).toEqual([["ci.setup", card.payload.repo]])
    if (job === "feature") {
      expect(t.host.textContent).not.toContain("Start from approved issues")
      expect(t.host.querySelector('input[type="checkbox"]')).toBeNull()
      expect([...t.host.querySelectorAll<HTMLOptionElement>("option")].map(option => option.value)).toContain("approved")
    }
  } finally { t.close() }
})

test.each([
  ["issues", "Create test issue", "Enable issue handling", "Test issue title", "Test issue body"],
  ["review", "Review test PR", "Enable PR reviews", "Test PR", null],
  ["ci", "Test CI checks", "Enable CI checks", "CI trial", null],
  ["feature", "Try feature flow", "Enable feature flow", "Test feature", "Feature request"],
  ["chores", "Run test chore", "Enable chore", "Test chore", "Routine maintenance"]
] as const)("%s trial and activation actions describe the actual job", (job, trial, enable, titleLabel, bodyLabel) => {
  const card = makeCard(job)
  card.payload.view = "test"
  if (job === "review" || job === "ci") card.payload.draft.trialBody = "https://github.com/example/repo/pull/42"
  const t = mount(card)
  try {
    expect(t.button(enable)?.disabled).toBe(true)
    t.button(trial)!.click()
    expect(t.calls).toEqual([["setup.run", flowArgs("setup.run", { cardId: card.id, operation: "trial" })]])
    const title = t.host.querySelector<HTMLInputElement>(`input[aria-label="${titleLabel}"]`)!
    title.value = "A specific trial"
    title.dispatchEvent(new Event("input", { bubbles: true }))
    expect(t.calls.at(-1)).toEqual(["setup.configure", flowArgs("setup.configure", { cardId: card.id, field: "trialTitle", value: "A specific trial" })])
    if (bodyLabel) {
      const body = t.host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${bodyLabel}"]`)!
      body.value = "Find the documented installation command."
      body.dispatchEvent(new Event("input", { bubbles: true }))
      expect(t.calls.at(-1)).toEqual(["setup.configure", flowArgs("setup.configure", { cardId: card.id, field: "trialBody", value: body.value })])
    }
    if (job === "issues" || job === "review") {
      expect(t.host.textContent).toContain("Replies drafted")
      card.payload.draft.replies = "automatic"
      t.render(card)
      expect(t.host.textContent).toContain("Replies drafted")
      expect(t.host.textContent).not.toContain("Test replies may be posted")
    } else expect(t.host.textContent).not.toContain("Replies drafted")
  } finally { t.close() }
})

test.each(["review", "ci"] as const)("%s trial requires an explicit PR and exposes source/number controls", job => {
  const card = makeCard(job)
  card.payload.view = "test"
  const t = mount(card)
  try {
    const action = job === "review" ? "Review test PR" : "Test CI checks"
    expect(t.button(action)?.disabled).toBe(true)
    const source = t.host.querySelector<HTMLSelectElement>('select[aria-label="Source"]')!
    source.value = "smithers-cloud"
    source.dispatchEvent(new Event("change", { bubbles: true }))
    const number = t.host.querySelector<HTMLInputElement>('input[aria-label="PR number"]')!
    number.value = "42"
    number.dispatchEvent(new Event("input", { bubbles: true }))
    expect(t.calls).toEqual([
      ["setup.configure", flowArgs("setup.configure", { cardId: "setup", field: "trial.source", value: "smithers-cloud" })],
      ["setup.configure", flowArgs("setup.configure", { cardId: "setup", field: "trial.number", value: 42 })]
    ])
    t.render({ ...card, payload: { ...card.payload, draft: { ...card.payload.draft, trialBody: '{"source":"smithers-cloud","number":42}' } } })
    expect(t.button(action)?.disabled).toBe(false)
  } finally { t.close() }
})

test("only a real scoped run enables Run; waiting alone never claims an approval", () => {
  const card = makeCard()
  const digest = setupCandidate(card.payload)
  const receipt: SetupReceipt = { requestId: "request", operation: "evaluate", revision: 1, digest, phase: "queued", updatedAt: 1, results: [], evidence: [] }
  card.payload.workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
  card.payload.request = { id: "request", operation: "evaluate", revision: 1, digest, state: "running" }
  card.payload.receipt = receipt
  const t = mount(card)
  try {
    expect(t.button("Run")).toBeUndefined()
    expect(t.button("Approvals")).toBeUndefined()
    const next = { ...card, payload: { ...card.payload, receipt: { ...receipt, runId: "actual-run", phase: "waiting" as const },
      request: { ...card.payload.request, state: "failed" as const, error: "Connection lost" } } }
    t.render(next)
    expect(t.button("Approvals")).toBeUndefined()
    t.button("Run")!.click(); t.button("Reconnect")!.click()
    expect(t.calls).toEqual([
      ["runs.open", flowArgs("runs.open", { sourceCard: card.id, runId: "actual-run", repo: "example/repo" })],
      ["setup.retry", card.id]
    ])
    expect(t.host.textContent).toContain("Connection lost")
    expect(t.host.textContent).not.toContain("Stopped")
  } finally { t.close() }
})

test("a paused job keeps its way back on the card, through the flow every door runs", () => {
  const card = makeCard("feature")
  const digest = setupCandidate(card.payload)
  card.payload.active = { revision: 1, digest, registrationId: "active-1", sourceRevision: "commit-1", enabled: false }
  card.payload.revision = 2
  const t = mount(card)
  const status = () => t.host.querySelector(".setup-heading")?.lastElementChild?.textContent
  try {
    expect(status()).toBe("Paused")
    expect(t.button("Pause")).toBeUndefined()
    expect(t.host.querySelector(".setup-gate")).toBeNull()
    const enable = t.button("Enable feature flow")!
    expect(enable.disabled).toBe(false)
    enable.click()
    expect(t.calls).toEqual([["setup.run", flowArgs("setup.run", { cardId: card.id, operation: "apply" })]])
    expect(payloadFor("setup.run", t.calls[0]![1]!)).toEqual({ payload: { cardId: card.id, operation: "apply" } })
    card.payload.draft.budgetMinutes = 20
    card.payload.revision = 3
    t.render(card)
    expect(t.button("Enable feature flow")?.disabled).toBe(true)
    expect(t.host.querySelector(".setup-gate")?.textContent).toBe("Run evals for this draft.")
  } finally { t.close() }
})

/*
 * R96b follow-up 1: the canary's `feature` registration was enabled under the
 * digest the build before this chain wrote, so its card reads applied and its
 * Update button is already disabled at that revision. The activation gate beside
 * them asks for evals that prove a candidate the row is already running.
 */
test("an enabled registration written with the older identity shows no gate beside its disabled Update", () => {
  const card: CardOf<"repository-setup"> = { id: "setup", kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: 1,
    payload: { ...initialSetup("codeplanesmithers/canary-sandbox", "feature", "maintainer"), revision: 6,
      active: { revision: 6, digest: REGISTERED_DIGEST, registrationId: "canary-feature", sourceRevision: "c2556c7da43868894aa8368a01d7d1ce2c736d0f", enabled: true, owned: true } } }
  const t = mount(card)
  try {
    expect(setupCandidate(card.payload)).not.toBe(REGISTERED_DIGEST)
    expect(setupActivationProblems(card.payload)).toContain("Run evals for this draft.")
    expect(t.host.querySelector(".setup-heading")?.lastElementChild?.textContent).toBe("Enabled")
    expect(t.button("Update feature flow")?.disabled).toBe(true)
    expect(t.host.querySelector(".setup-gate")).toBeNull()
  } finally { t.close() }
})

test("old eval evidence remains readable after a candidate edit", () => {
  const card = makeCard()
  card.payload.view = "evals"
  card.payload.previousReceipts = [{ requestId: "old", runId: "old-run", operation: "evaluate", revision: 1, digest: "old", phase: "completed", updatedAt: 1,
    results: [{ caseId: "repro", status: "failed", observed: "The baseline did not reproduce.", executionId: "case-1", evidence: ["artifact:baseline-log"] }], evidence: ["artifact:eval-report"] }]
  const t = mount(card)
  try {
    expect(t.host.textContent).toContain("The baseline did not reproduce.")
    expect(t.host.textContent).toContain("artifact:baseline-log")
    expect(t.host.textContent).toContain("artifact:eval-report")
  } finally { t.close() }
})

test("a native trial shows one pending phase, real Issue/Run access and closed technical evidence", () => {
  const card = makeCard()
  card.payload.view = "test"
  card.payload.workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
  card.payload.request = { id: "trial", operation: "trial", revision: 1, digest: setupCandidate(card.payload), state: "running" }
  card.payload.receipt = card.payload.trial = { requestId: "trial", runId: "trial-run", jobRunId: "trial-job", operation: "trial", revision: 1, digest: setupCandidate(card.payload), phase: "waiting", updatedAt: 1,
    results: [], evidence: ["issue:42", "candidate:.smithers/setup/candidate.json", "execution:trial-job", "source:immutable-commit"], trialIssue: { source: "smithers-cloud", number: 42 } }
  const t = mount(card)
  const phases = (phase: string) => [...t.host.querySelectorAll("span,p")].filter(node => node.textContent?.toLowerCase() === phase)
  try {
    expect(t.host.querySelector("a")).toBeNull()
    expect(phases("waiting")).toHaveLength(1)
    expect(t.button("Approvals")).toBeUndefined()
    const details = [...t.host.querySelectorAll("details")].find(detail => detail.querySelector("summary")?.textContent === "Technical details")!
    expect(details.open).toBe(false)
    expect([...details.querySelectorAll("code")].map(item => item.textContent)).toEqual(card.payload.trial.evidence)
    t.button("Issue #42")!.click()
    t.button("Job run")!.click()
    expect(t.calls).toEqual([
      ["issues.view", flowArgs("issues.view", { number: 42, repo: "example/repo", source: "smithers-cloud" })],
      ["runs.open", flowArgs("runs.open", { runId: "trial-job", repo: "example/repo", sourceCard: card.id })]
    ])
    const preview = mount(card, true)
    try {
      expect([...preview.host.querySelectorAll("span,p")].filter(node => node.textContent?.toLowerCase() === "waiting")).toHaveLength(1)
      expect(preview.button("Sign in")).toBeDefined()
    } finally { preview.close() }
    card.payload.request.state = "completed"
    card.payload.receipt = card.payload.trial = { ...card.payload.trial, phase: "completed" }
    t.render(card)
    expect(phases("completed")).toHaveLength(1)
    expect(phases("waiting")).toHaveLength(0)
  } finally { t.close() }
})

test("reply settings expose draft behavior and require explicit correction of an old automatic draft", () => {
  const card = makeCard()
  const t = mount(card)
  try {
    const replies = [...t.host.querySelectorAll<HTMLSelectElement>("select")].find(select => select.querySelector('option[value="draft"]'))!
    expect(replies.querySelector('option[value="automatic"]') === null).toBe(true)
    card.payload.draft.replies = "automatic"
    t.render(card)
    expect(replies.querySelector<HTMLOptionElement>('option[value="automatic"]')?.disabled).toBe(true)
    expect(t.host.textContent).toContain("Choose draft replies.")
    expect(t.calls).toHaveLength(0)
  } finally { t.close() }
})

test("a per-step work form edits labeled fields and opens the actual dispatched job", () => {
  const card = makeCard()
  card.payload.workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
  card.payload.active = { enabled: true, revision: 1, digest: setupCandidate(card.payload), registrationId: "registered", sourceRevision: "source" }
  card.payload.view = "work"
  card.payload.manualDraft = { stepId: "fix", source: "smithers-cloud", number: 4, prompt: "Preserve compatibility" }
  const t = mount(card)
  try {
    const source = t.host.querySelector<HTMLSelectElement>('select[aria-label="Source"]')!
    source.value = "github"
    source.dispatchEvent(new Event("change", { bubbles: true }))
    const number = t.host.querySelector<HTMLInputElement>('input[aria-label="Issue number"]')!
    number.value = "8"
    number.dispatchEvent(new Event("input", { bubbles: true }))
    const instructions = t.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions (optional)"]')!
    instructions.value = "Keep the existing behavior."
    instructions.dispatchEvent(new Event("input", { bubbles: true }))
    expect(t.calls).toEqual([
      ["setup.work", flowArgs("setup.work", { cardId: card.id, stepId: "fix", field: "source", value: "github" })],
      ["setup.work", flowArgs("setup.work", { cardId: card.id, stepId: "fix", field: "number", value: 8 })],
      ["setup.work", flowArgs("setup.work", { cardId: card.id, stepId: "fix", field: "prompt", value: instructions.value })]
    ])
    t.calls.length = 0
    t.button("Fix for real")!.click()
    expect(payloadFor("setup.run", t.calls[0]![1]!)).toEqual({ payload: { cardId: "setup", operation: "run" } })
    card.payload.request = { id: "work", operation: "run", revision: 1, digest: setupCandidate(card.payload), state: "running" }
    card.payload.receipt = { requestId: "work", operation: "run", revision: 1, digest: setupCandidate(card.payload), phase: "waiting", updatedAt: 1,
      runId: "wrapper", jobRunId: "actual-job", results: [], evidence: [] }
    t.render(card)
    expect(t.button("Approvals")).toBeUndefined()
    t.button("Job run")!.click()
    expect(t.calls.slice(1)).toEqual([
      ["runs.open", flowArgs("runs.open", { runId: "actual-job", repo: "example/repo", sourceCard: "setup" })]
    ])
    card.payload.revision = 2
    card.payload.request = undefined
    t.render(card)
    expect(t.button("Fix for real")?.disabled).toBe(true)
  } finally { t.close() }
})

test("the issue label input belongs to the issues scope and to a chore's own labeled event", () => {
  const card = makeCard("issues"), t = mount(card)
  try {
    card.payload.draft.choreEvent = "labeled"
    t.render(card)
    expect(t.host.textContent).not.toContain("Issue label")
    card.payload.draft.scope = "label"
    t.render(card)
    expect(t.host.textContent).toContain("Issue label")
    expect(t.calls).toEqual([])
  } finally { t.close() }
})

test("a chore picks an event beside its schedule and cannot enable automation no step would run", () => {
  const unattended = "Set the chore to run automatically or on approval."
  const card = makeCard("chores"), t = mount(card)
  try {
    const select = t.host.querySelector<HTMLSelectElement>('select[aria-label="Also run on"]')!
    expect(select.value).toBe("none")
    expect(t.host.textContent).not.toContain(unattended)
    expect(t.host.textContent).not.toContain("Issue label")
    select.value = "labeled"
    select.dispatchEvent(new Event("change", { bubbles: true }))
    expect(t.calls).toEqual([["setup.configure", flowArgs("setup.configure", { cardId: card.id, field: "choreEvent", value: "labeled" })]])
    card.payload.draft.choreEvent = "labeled"
    card.payload.draft.label = "chore"
    t.render(card)
    expect(t.host.textContent).toContain("Issue label")
    expect(t.host.textContent).toContain(unattended)
    expect(t.button("Enable chore")?.disabled).toBe(true)
    card.payload.draft.steps = card.payload.draft.steps.map(step => ({ ...step, mode: "approved" as const }))
    t.render(card)
    expect(t.host.textContent).not.toContain(unattended)
    expect(t.calls).toHaveLength(1)
  } finally { t.close() }
})

test("a setup whose workspace is gone offers Retry with the typed refusal, never the reconnect dead end", () => {
  const card = makeCard()
  const digest = setupCandidate(card.payload)
  const gone = "workspace_gone — The workspace behind this setup is gone. Not your fault; retry creates a new one."
  card.payload.workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
  card.payload.request = { id: "request", operation: "inspect", revision: 1, digest, state: "failed", observeOnly: true, error: gone }
  card.payload.receipt = { requestId: "request", operation: "inspect", revision: 1, digest, phase: "failed", updatedAt: 1, results: [], evidence: [], error: gone }
  const t = mount(card)
  try {
    expect(t.host.textContent).toContain(gone)
    expect(t.host.textContent).not.toContain("no recorded run to reconnect")
    expect(t.button("Reconnect")).toBeUndefined()
    t.button("Retry")!.click()
    expect(t.calls).toEqual([["setup.retry", card.id]])
  } finally { t.close() }
})

/*
 * The CI inspect of codeplanesmithers/canary-sandbox recorded four reads and
 * three probes that found nothing (.artifacts/mvp-canary-walk-20260917/
 * B-24-state-ci-terminal.json). A probe that found nothing is the evidence
 * behind a default, so it is a row of its own in the fewest words that say it.
 */
test("a probe that found nothing is its own evidence row, in the words a person reads", () => {
  const card = makeCard("ci")
  card.payload.sources = [
    { path: "README.md", status: "read", summary: "Read", revision: "a04cee586c1b0d7eca5fd03900638ec9e135daf3" },
    { path: "package.json", status: "missing", summary: "Not present" },
    { path: "tox.ini", status: "missing", summary: "Not present" },
    { path: "pyproject.toml", status: "missing", summary: "Not present" },
    { path: "github:/repos/codeplanesmithers/canary-sandbox/pulls?state=all&per_page=30", status: "read", summary: "1 records" }
  ]
  const t = mount(card)
  try {
    const rows = [...t.host.querySelectorAll("details li")].map(row => row.textContent)
    expect(rows).toEqual(["README.md · read", "package.json · not found", "tox.ini · not found", "pyproject.toml · not found",
      "github:/repos/codeplanesmithers/canary-sandbox/pulls?state=all&per_page=30 · read1 records"])
    expect(t.host.textContent).not.toContain("Not present")
    expect(t.host.textContent).not.toContain("· missing")
  } finally { t.close() }
})

test("a settled refusal the person must answer reads as the host's sentence, not as its verdict line", () => {
  /* .artifacts/mvp-canary-walk-20260917/B-18-state-trial-terminal.json, receipt run-3. */
  const raw = "failed — invalid_receipt: Run evals for this exact candidate before continuing"
  const card = makeCard()
  card.payload.request = { id: "a05c520e", operation: "trial", revision: card.payload.revision,
    digest: setupCandidate(card.payload), state: "failed", error: raw }
  const t = mount(card)
  try {
    expect(t.host.querySelector(".setup-error p")?.textContent).toBe("Run evals for this exact candidate before continuing")
    /* .artifacts/mvp-canary-walk-20260917/W1-g-discard-and-retry.json `L76-issuesAfterRetry`, after Retry. */
    card.payload.request = { ...card.payload.request, error: "failed — invalid_receipt: Setup input must match the reviewed candidate digest" }
    t.render(card)
    expect(t.host.querySelector(".setup-error p")?.textContent).toBe("This setup changed after it was reviewed. Test this draft again, then apply it.")
    card.payload.request = { ...card.payload.request, error: "failed — invalid_receipt: Setup output failed the shared response contract" }
    t.render(card)
    expect(t.host.querySelector(".setup-error p")?.textContent).toBe("Something on Smithers' side failed. Not your fault, and nothing your request could have changed.")
    /* A host sentence with no code is the host's own; only a verdict line is replaced. */
    card.payload.request = { ...card.payload.request, error: "AI check Documentation edits preserve existing content has no completed in-scope trial result; test a change that exercises it" }
    t.render(card)
    expect(t.host.querySelector(".setup-error p")?.textContent).toBe("AI check Documentation edits preserve existing content has no completed in-scope trial result; test a change that exercises it")
    card.payload.recovery = { id: "recover", baseRevision: 1, baseDigest: setupCandidate(card.payload), state: "failed",
      registrationState: "unavailable", error: "The workspace behind this setup is gone." }
    t.render(card)
    expect(t.host.querySelector(".setup-error p")?.textContent).toBe("The workspace behind this setup is gone.")
  } finally { t.close() }
})

/*
 * Production, .artifacts/mvp-canary-walk-20260917/C-REPORT.md defect C-3: the
 * feature registration stayed enabled at revision 6 while the draft sat at
 * revision 11 behind a required command check whose trial kept failing. The
 * run gate refused the enabled job's manual work for the life of that draft
 * and `C-31-trial-retry.json` `buttonsBefore` held no way back.
 */
test("an enabled job keeps its applied configuration one click away from an unappliable draft", () => {
  const card = makeCard("feature")
  const applied = card.payload.draft
  card.payload.revision = 6
  card.payload.active = { revision: 6, digest: setupCandidate(card.payload), registrationId: "259ef97c", sourceRevision: "fb8c7b08", enabled: true, draft: applied }
  card.payload.revision = 11
  card.payload.draft = { ...applied, checks: [{ id: "hello", name: "Repository check", kind: "command", rule: "test -f docs/nested/hello.txt", paths: ["docs/nested/hello.txt"], policy: "required" }] }
  card.payload.view = "work"
  card.payload.manualDraft = { stepId: "feature", prompt: "Add the greeting", source: "github" }
  const t = mount(card)
  try {
    expect(t.button("Build a feature")?.disabled).toBe(true)
    expect(t.host.textContent).toContain("Test and apply this draft first.")
    t.button("Discard draft")!.click()
    expect(t.calls).toEqual([["setup.discard", card.id]])
    card.payload.revision = 6
    card.payload.draft = applied
    t.render(card)
    expect(t.button("Discard draft")).toBeUndefined()
    expect(t.button("Build a feature")?.disabled).toBe(false)
    expect(t.host.textContent).not.toContain("Test and apply this draft first.")
    card.payload.revision = 11
    card.payload.active = { ...card.payload.active, enabled: false }
    t.render(card)
    expect(t.button("Discard draft")).toBeUndefined()
    card.payload.active = { ...card.payload.active, enabled: true, owned: false }
    t.render(card)
    expect(t.button("Discard draft")).toBeUndefined()
    card.payload.active = { ...card.payload.active, owned: true, draft: undefined }
    t.render(card)
    expect(t.button("Discard draft")).toBeUndefined()
    expect(t.calls).toHaveLength(1)
  } finally { t.close() }
})

/*
 * R96 B1: the enabled registration a person has today carries the digest the
 * build before the trial's own test request left the candidate wrote. The work
 * button reads that row, so it stays live for the job that is still running.
 */
test("an enabled registration written before the candidate changed keeps its work button live", () => {
  const card = makeCard("feature")
  // The digest that build computed for this draft at revision 6.
  const registered = "45fd2fa0d8b6ed547460a7b4c8315592a3ba906563fa678a8e1f95d4ec910822"
  card.payload.revision = 6
  card.payload.active = { revision: 6, digest: registered, registrationId: "259ef97c", sourceRevision: "fb8c7b08", enabled: true, draft: card.payload.draft }
  card.payload.view = "work"
  card.payload.manualDraft = { stepId: "feature", prompt: "Add the greeting", source: "github" }
  const t = mount(card)
  try {
    expect(setupCandidate(card.payload)).not.toBe(registered)
    expect(t.button("Build a feature")?.disabled).toBe(false)
    expect(t.host.textContent).not.toContain("Test and apply this draft first.")
    expect(t.button("Discard draft")).toBeUndefined()
  } finally { t.close() }
})

/*
 * R88 follow-up 1: a card applied before the registration recorded its own
 * configuration hides the door, and the boot recovery every setup card gets
 * (state/controller/repositorySetup.ts requestRecovery on resume) records
 * `active.draft`, so the button is there on the next render.
 */
test("a card applied before the discard door existed finds it once recovery records the configuration", () => {
  const card = makeCard("feature")
  const applied = card.payload.draft
  card.payload.revision = 6
  card.payload.active = { revision: 6, digest: setupCandidate(card.payload), registrationId: "259ef97c", sourceRevision: "fb8c7b08", enabled: true }
  card.payload.revision = 11
  card.payload.draft = { ...applied, budgetMinutes: 30 }
  const t = mount(card)
  try {
    expect(t.button("Discard draft")).toBeUndefined()
    card.payload.recovery = { id: "recover", baseRevision: 11, baseDigest: setupCandidate(card.payload), state: "requested", registrationState: "unknown" }
    const recovered: SetupRecoveryResponse = { owner: "maintainer", repo: card.payload.repo, job: card.payload.job,
      registration: { state: "known", active: { registrationId: "259ef97c", workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a",
        revision: 6, digest: card.payload.active.digest, sourceRevision: "fb8c7b08", enabled: true, owned: true, draft: applied } },
      setup: { state: "none" } }
    t.render({ ...card, payload: projectRecoveredSetup(card.payload, recovered) })
    expect(t.button("Discard draft")).toBeDefined()
    expect(t.calls).toEqual([])
  } finally { t.close() }
})

test("every setup button identifies the flow its click dispatches", () => {
  for (const view of ["flows", "prompts", "checks", "evals", "test"] as const) {
    const card = makeCard(); card.payload.view = view
    const t = mount(card)
    try {
      const buttons = [...t.host.querySelectorAll<HTMLButtonElement>("button")]
      expect(buttons.length).toBeGreaterThan(0)
      for (const button of buttons) {
        expect(button.dataset.flow, button.textContent ?? "button").toBeTruthy()
        if (button.disabled) continue
        const before = t.calls.length
        button.click()
        expect(t.calls[before]?.[0]).toBe(button.dataset.flow!)
      }
    } finally { t.close() }
  }
})

test("an earlier operation's failure reads its operation's sentence; the host receipt's words stay behind Details", () => {
  const raw = "failed — execution: bridge exited 137 (HTTP 500)"
  const cases: ReadonlyArray<readonly [SetupReceipt["operation"], string]> = [
    ["inspect", "Smithers could not inspect this draft. Not your fault."],
    ["evaluate", "Smithers could not run these evals. Not your fault."],
    ["trial", "Smithers could not run this test. Not your fault."],
    ["apply", "Smithers could not apply this draft. Not your fault."],
    ["pause", "Smithers could not pause this flow. Not your fault."],
    ["run", "Smithers could not run this flow. Not your fault."]
  ]
  const card = makeCard()
  card.payload.view = "evals"
  card.payload.previousReceipts = cases.map(([operation], index) => ({ requestId: `old-${operation}`, operation, revision: 1, digest: "old",
    phase: "failed" as const, updatedAt: index, results: [], evidence: [], error: raw }))
  const t = mount(card)
  try {
    const notices = [...t.host.querySelectorAll<HTMLElement>("[data-testid=setup-previous-failure]")]
    expect(notices.map(notice => notice.dataset.failure)).toEqual(cases.map(([operation]) => `setup.${operation}`))
    notices.forEach((notice, index) => {
      expect(notice.getAttribute("role")).toBe("status")
      expect(notice.dataset.fault).toBe("infra")
      expect(notice.querySelector("p")?.textContent).toBe(cases[index]![1])
      expect(notice.querySelector("p")?.textContent).not.toContain("137")
      expect(notice.querySelector("details pre")?.textContent).toBe(raw)
      expect(notice.querySelector("button")).toBeNull()
    })
  } finally { t.close() }
})

test("an earlier refusal the person answers keeps its setup sentence, marked as theirs", () => {
  const raw = "failed — invalid_receipt: Setup input must match the reviewed candidate digest"
  const card = makeCard()
  card.payload.view = "evals"
  card.payload.previousReceipts = [{ requestId: "old", operation: "apply", revision: 1, digest: "old", phase: "failed", updatedAt: 1, results: [], evidence: [], error: raw }]
  const t = mount(card)
  try {
    const notice = t.host.querySelector<HTMLElement>("[data-testid=setup-previous-failure]")!
    expect(notice.dataset.fault).toBe("user")
    expect(notice.dataset.failure).toBe("setup.apply")
    expect(notice.querySelector("p")?.textContent).toBe("This setup changed after it was reviewed. Test this draft again, then apply it.")
    expect(notice.querySelector("p")?.textContent).not.toContain("invalid_receipt")
    expect(notice.querySelector("details pre")?.textContent).toBe(raw)
  } finally { t.close() }
})
