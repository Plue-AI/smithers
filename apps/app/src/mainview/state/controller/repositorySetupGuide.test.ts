import { expect, test } from "bun:test"
import { initialSetup, REPOSITORY_JOBS, setupCandidate, type RepositoryJob, type SetupDraft } from "@smthrs/rpc/RepositorySetup"
import { createAppStore } from "../AppStore"
import type { Card } from "../AppState"
import { memoryStorage } from "../TestFixtures"
import type { ControllerContext } from "./context"
import { createRepositorySetupController, setupGuidance } from "./repositorySetup"
import { repositorySetupGuide, type SetupGuideControl } from "./repositorySetupGuide"

type SetupCard = Extract<Card, { kind: "repository-setup" }>
const setupCard = (job: RepositoryJob): SetupCard => ({
  id: "setup", kind: "repository-setup", title: job, status: "active", createdAt: 1, ordinal: 1,
  payload: initialSetup("example/repo", job, "maintainer")
})
const fields = (control: SetupGuideControl): string[] => control.kind === "step" ? [control.modeField, control.promptField]
  : control.kind === "issue-filter" ? [control.scopeField, control.labelField]
  : control.kind === "chore-event" ? [control.field, control.labelField]
  : control.kind === "trial" ? [...control.fields] : [control.field]

test.each([...REPOSITORY_JOBS])("%s advertises only supported current steps and job-specific inputs", job => {
  const card = setupCard(job), setup = card.payload
  const supported = setup.draft.steps.map(step => step.id)
  const unrelatedStep = job === "issues" ? "chore" : "research"
  setup.draft.steps = [...setup.draft.steps.slice(1),
    { id: "invented", name: "Apply labels", mode: "automatic", prompt: "Set a fixed issue category" },
    { id: unrelatedStep, name: "Another job's step", mode: "manual", prompt: "Not supported by this job" }]
  setup.draft.replies = "automatic"
  setup.draft.connectIssues = true
  const before = structuredClone(card), guide = repositorySetupGuide(setup)
  expect(guide.controls.filter(control => control.kind === "step").map(control => control.stepId)).toEqual(supported.slice(1))
  const advertised = guide.controls.flatMap(fields)
  expect(advertised).not.toContain("replies")
  expect(advertised).not.toContain("connectIssues")
  expect(advertised).not.toContain("step.invented.mode")
  expect(advertised).not.toContain("step.invented.prompt")
  expect(advertised).not.toContain(`step.${unrelatedStep}.mode`)
  expect(advertised.includes("scope")).toBe(job === "issues")
  expect(advertised.includes("label")).toBe(job === "issues" || job === "chores")
  expect(advertised.includes("schedule")).toBe(job === "chores")
  expect(advertised.includes("choreEvent")).toBe(job === "chores")
  expect(guide.controls.filter(control => control.kind === "chore-event")).toEqual(job === "chores"
    ? [{ kind: "chore-event", field: "choreEvent", labelField: "label", values: ["none", "push", "labeled"], pushRef: "default-branch" }] : [])
  expect(guide.controls.filter(control => control.kind === "trial")).toEqual(job === "review" || job === "ci"
    ? [{ kind: "trial", subject: "pull-request", fields: ["trialTitle", "trial.source", "trial.number"], sources: ["github", "smithers-cloud"] }]
    : [{ kind: "trial", subject: "test-request", fields: ["trialTitle", "trialBody"] }])
  expect(card).toEqual(before)
})

test.each(["fresh", "edited", "recovered", "paused"])("guide reads a %s candidate without changing policy or claiming source content", state => {
  const card = setupCard("issues"), setup = card.payload
  if (state !== "fresh") {
    setup.revision = 7
    setup.draft.steps[0] = { ...setup.draft.steps[0]!, mode: "manual", prompt: "Use the actual issue's facts." }
    setup.draft.scope = "label"; setup.draft.label = "needs-investigation"
    setup.inspectedAt = 100
    setup.sources = [
      { path: ".github/workflows/check.yml", status: "read", summary: "Read", revision: "source-digest" },
      { path: "github:issues", status: "failed", summary: "Could not read issues" },
      { path: "README.md", status: "missing", summary: "Not present" }
    ]
  }
  if (state === "recovered" || state === "paused") {
    setup.recovery = { id: "discovery", baseRevision: 7, baseDigest: setupCandidate(setup), state: "completed", registrationState: "known" }
    setup.active = { revision: 6, digest: "retained-digest", registrationId: "actual-registration", sourceRevision: "actual-source", enabled: state !== "paused" }
  }
  const before = structuredClone(card), guide = JSON.parse(setupGuidance(card))
  expect(guide).toMatchObject({ revision: setup.revision, draft: setup.draft, sources: setup.sources })
  expect(guide.active).toEqual(setup.active)
  expect(guide.controls.find((control: SetupGuideControl) => control.kind === "issue-filter")).toEqual({
    kind: "issue-filter", scopeField: "scope", labelField: "label", values: ["future", "label"], labelMeaning: "match-existing-label"
  })
  // Controls derive from capabilities, never treat source summaries as a label inventory or suggested classification.
  expect(guide.controls).toEqual(repositorySetupGuide(initialSetup(setup.repo, setup.job, setup.owner)).controls)
  expect(guide.evaluation).toBeUndefined()
  expect(guide.trial).toBeUndefined()
  expect(card).toEqual(before)
})

const initialChecks: SetupDraft["checks"] = [
  { id: "command", name: "Repository tests", kind: "command", rule: "bun test", paths: [], policy: "report" },
  { id: "observability", name: "Observability", kind: "ai", rule: "Check boundary errors", paths: ["src/handler.ts"], policy: "report" }
]
const initialCases: SetupDraft["cases"] = [
  { id: "case-a", name: "Concrete input", input: "Actual case A", expected: "Expected A", required: true },
  { id: "case-b", name: "Other input", input: "Actual case B", expected: "Expected B", required: true }
]

test.each([...REPOSITORY_JOBS])("every %s advertised field and enum is accepted by the real configure handler", async job => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const card = setupCard(job)
  card.payload.draft.checks = structuredClone(initialChecks)
  card.payload.draft.cases = structuredClone(initialCases)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
  const dispose: Array<() => void> = []
  const controller = createRepositorySetupController({ store, commandActor: "smithers", accountEpoch: 0,
    onDispose: (close: () => void) => dispose.push(close), unref: () => {} } as unknown as ControllerContext)
  const current = () => (store.collections.cards.get(card.id) as SetupCard).payload
  const edits: Array<[string, unknown]> = []
  for (const control of repositorySetupGuide(card.payload).controls) {
    switch (control.kind) {
      case "step":
        edits.push(...control.modes.map(mode => [control.modeField, mode] as [string, unknown]), [control.promptField, "Retain actual source evidence."])
        break
      case "issue-filter": edits.push(...control.values.map(value => [control.scopeField, value] as [string, unknown]), [control.labelField, "needs-investigation"]); break
      case "time-limit": edits.push([control.field, control.min], [control.field, control.max]); break
      case "landing": edits.push(...control.values.map(value => [control.field, value] as [string, unknown])); break
      case "checks":
        for (const kind of control.kinds) for (const policy of control.policies) edits.push([control.field, initialChecks.map(check => check.id === "command" ? { ...check, kind, policy } : check)])
        break
      case "eval-cases": edits.push([control.field, initialCases.map(item => item.id === "case-a" ? { ...item, input: "Revised input", expected: "Revised expectation" } : item)]); break
      case "schedule": edits.push([control.field, "0 9 * * 1"], [control.field, ""]); break
      case "chore-event":
        edits.push(...control.values.map(value => [control.field, value] as [string, unknown]), [control.labelField, "maintenance"])
        break
      case "trial":
        edits.push(["trialTitle", "A meaningful scoped trial"])
        if (control.subject === "pull-request") edits.push(...control.sources.map(source => ["trial.source", source] as [string, unknown]), ["trial.number", 42])
        else edits.push(["trialBody", "Exercise the relevant source and report the actual result."])
        break
    }
  }
  try {
    for (const [field, value] of edits) {
      expect(await controller.configureRepositorySetup(card.id, field, value)).toEqual({ value: "Draft updated." })
      expect(current().active).toBeUndefined()
      expect(current().request).toBeUndefined()
    }
    expect(current().draft.checks[1]).toEqual(initialChecks[1])
    expect(current().draft.cases[1]).toEqual(initialCases[1])
    for (const [field, value] of [["replies", "automatic"], ["step.research.mode", "always"], ["check.missing.policy", "required"], ["case.missing.expected", "fabricated pass"], ["check.command.policy", "always"], ["case.case-a.expected", ""]] as const) {
      const before = structuredClone(current())
      expect(await controller.configureRepositorySetup(card.id, field, value)).not.toEqual({ value: "Draft updated." })
      expect(current()).toEqual(before)
    }
    expect((await store.verifyState()).valid).toBe(true)
  } finally { dispose.forEach(close => close()); await store.dispose?.() }
})
