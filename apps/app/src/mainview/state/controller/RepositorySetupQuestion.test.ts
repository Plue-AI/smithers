import { expect, test } from "bun:test"
import { initialSetup, setupCandidate, REPOSITORY_JOBS, type RepositoryJob, type RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import type { ControllerContext } from "./context"
import { createRepositorySetupController } from "./repositorySetup"
import { defaultSetupQuestion, repositorySetupGuide, setupGuideQuestions, type SetupGuideControl } from "./repositorySetupGuide"

type SetupCard = Extract<Card, { kind: "repository-setup" }>

/*
 * The recorded production guide turn, build 109b613abae2, run bef1cae3, kept
 * at .artifacts/mvp-release-20260916/production-guide-109b-recovered-durable-eval.json
 * (untracked, so its material facts are transcribed here): revision 5, the six
 * issues steps at their shipped modes, one reporting `ai` check, two eval
 * cases, an empty label — and the sentence the model wrote from all of it.
 */
const RECORDED_QUESTION = "What label should automatically be applied to newly opened issues in this repository?"
const APPLYING = "(apply|applies|applied|assign|assigns|assigned|add|adds|added)"
const LABEL_ASSIGNMENT = new RegExp(`\\b${APPLYING}\\b[^.?]*\\blabels?\\b|\\blabels?\\b[^.?]*\\b${APPLYING}\\b`, "i")

const recordedSetup = (): RepositorySetup => {
  const setup = initialSetup("codeplanesmithers/canary-sandbox", "issues", "maintainer")
  setup.revision = 5
  setup.inspectedAt = 1789615559666
  setup.sources = [
    { path: "README.md", status: "read", summary: "Read", revision: "a04cee586c1b0d7eca5fd03900638ec9e135daf3" },
    { path: "github:/repos/codeplanesmithers/canary-sandbox/issues?state=all&per_page=30", status: "read", summary: "30 records" },
    { path: "github:/repos/codeplanesmithers/canary-sandbox/pulls?state=all&per_page=30", status: "read", summary: "1 records" }
  ]
  setup.draft.checks = [{ id: "docs-preserve", name: "Documentation edits preserve existing content", kind: "ai",
    rule: "The existing README title and introduction must be preserved unchanged.", paths: ["README.md"], policy: "report" }]
  setup.draft.cases = [
    { id: "readme-purpose-question", name: "Opened issue asks what this repository is for", input: "{}", expected: "Answers from the README", required: true },
    { id: "issue-53-purpose-section", name: "Issue 53 asks for a purpose section", input: "{}", expected: "Proposes the section", required: true }
  ]
  setup.draft.trialTitle = "Does the README explain the cloud review workflow?"
  return setup
}

const controllerFor = async (payload: RepositorySetup) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const card: SetupCard = { id: "setup", kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: 1, payload }
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
  const dispose: Array<() => void> = []
  const controller = createRepositorySetupController({ store, commandActor: "smithers", accountEpoch: 0,
    onDispose: (close: () => void) => dispose.push(close), unref: () => {} } as unknown as ControllerContext)
  const current = () => (store.collections.cards.get("setup") as SetupCard).payload
  const answer = (questionId: string, choice: string, at = current()) =>
    controller.answerRepositorySetupQuestion("setup", questionId, at.revision, setupCandidate(at), choice)
  return { store, controller, current, answer, close: async () => { dispose.forEach(close => close()); await store.dispose?.() } }
}

const controlFields = (control: SetupGuideControl): string[] => control.kind === "step" ? [control.modeField, control.promptField]
  : control.kind === "issue-filter" ? [control.scopeField, control.labelField]
  : control.kind === "trial" ? [...control.fields] : [control.field]

test("the recorded production draft asks the application's first question, not the model's", () => {
  const setup = recordedSetup()
  const questions = setupGuideQuestions(setup)
  expect(questions[0]?.id).toBe("issues.steps.automatic")
  expect(defaultSetupQuestion(setup)).toEqual(questions[0]!)
  expect(questions[0]?.text).toBe("Keep issue research, duplicate lookup and bug reproduction automatic?")
  expect(questions[0]?.choices.map(choice => choice.id)).toEqual(["keep", "approved", "off"])
})

test("no question this draft can ask is the label-assignment question the model wrote", () => {
  // Mutation parity: this assertion proves nothing unless it catches the real sentence.
  expect(RECORDED_QUESTION).toMatch(LABEL_ASSIGNMENT)
  for (const setup of [recordedSetup(), ...REPOSITORY_JOBS.map(job => initialSetup("example/repo", job, "maintainer"))]) {
    const questions = setupGuideQuestions(setup)
    expect(questions.length).toBeGreaterThan(0)
    for (const question of questions) {
      expect(question.text).not.toBe(RECORDED_QUESTION)
      for (const text of [question.text, ...question.choices.map(choice => choice.label)]) {
        expect(text).not.toMatch(LABEL_ASSIGNMENT)
        expect(text).not.toMatch(/\bclassif/i)
      }
      expect(question.fields).not.toContain("label")
      expect(question.fields).not.toContain("scope")
    }
  }
})

test("a draft carrying an invented step or a check named after a label still cannot mint that question", () => {
  for (const job of REPOSITORY_JOBS) {
    const setup = initialSetup("example/repo", job, "maintainer")
    setup.draft.steps = [...setup.draft.steps,
      { id: "invented", name: "Apply the triage label", mode: "automatic", prompt: "Assign a fixed label to every new issue" }]
    setup.draft.checks = [{ id: "invented-check", name: "Apply the triage label to every issue", kind: "ai", rule: "x", paths: [], policy: "report" }]
    for (const question of setupGuideQuestions(setup)) {
      for (const text of [question.text, ...question.choices.map(choice => choice.label)]) expect(text).not.toMatch(LABEL_ASSIGNMENT)
      expect(question.fields).not.toContain("step.invented.mode")
    }
  }
})

test.each([...REPOSITORY_JOBS])("every %s question is attached to real controls and every choice passes the real configure handler", async job => {
  const setup = initialSetup("example/repo", job as RepositoryJob, "maintainer")
  setup.draft.checks = [{ id: "repo-tests", name: "Repository tests", kind: "command", rule: "bun test", paths: [], policy: "report" }]
  const t = await controllerFor(setup)
  try {
    const questions = setupGuideQuestions(setup)
    expect(questions.length).toBeGreaterThan(0)
    expect(defaultSetupQuestion(setup)).toEqual(questions[0]!)
    expect(questions.map(question => question.id)).toEqual([...new Set(questions.map(question => question.id))])
    const advertised = new Set(repositorySetupGuide(setup).controls.flatMap(controlFields))
    for (const question of questions) {
      expect(question.choices.length).toBeGreaterThan(1)
      expect([...new Set(question.choices.flatMap(choice => choice.edits.map(edit => edit.field)))].sort())
        .toEqual([...question.fields].sort())
      for (const field of question.fields) expect(advertised.has(field)).toBe(true)
      for (const choice of question.choices) {
        for (const edit of choice.edits) {
          expect(await t.controller.configureRepositorySetup("setup", edit.field, edit.value)).toEqual({ value: "Draft updated." })
          expect(t.current().request).toBeUndefined()
          expect(t.current().active).toBeUndefined()
        }
      }
    }
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

test("an unknown question id, an unoffered choice, and a stale candidate are all refused with no edit", async () => {
  const t = await controllerFor(recordedSetup())
  try {
    const before = structuredClone(t.current())
    for (const [questionId, choice] of [["issues.label", "keep"], ["issues.steps.automatic", "needs-triage"]] as const) {
      expect(await t.answer(questionId, choice)).toBeTypeOf("string")
      expect(t.current()).toEqual(before)
    }
    // A stale candidate never applies, and never silently resolves to a newer question.
    expect(await t.controller.answerRepositorySetupQuestion("setup", "issues.steps.automatic", 4, setupCandidate(before), "approved")).toBeTypeOf("string")
    expect(await t.controller.answerRepositorySetupQuestion("setup", "issues.steps.automatic", 5, "0".repeat(64), "approved")).toBeTypeOf("string")
    expect(t.current()).toEqual(before)
  } finally { await t.close() }
})

test("a substituted check cannot be answered with the replaced check's edits", async () => {
  const setup = initialSetup("example/repo", "ci", "maintainer")
  setup.draft.checks = [{ id: "first", name: "First check", kind: "command", rule: "bun test", paths: [], policy: "report" }]
  const t = await controllerFor(setup)
  try {
    const asked = t.current()
    expect(setupGuideQuestions(asked)[0]?.id).toBe("ci.checks.keep")
    await t.controller.configureRepositorySetup("setup", "checks",
      [{ id: "second", name: "Another check", kind: "command", rule: "bun run lint", paths: [], policy: "report" }])
    expect(await t.controller.answerRepositorySetupQuestion("setup", "ci.checks.keep", asked.revision, setupCandidate(asked), "remove")).toBeTypeOf("string")
    expect(t.current().draft.checks.map(check => check.id)).toEqual(["second"])
    // The question re-derived against the live draft answers the check that is actually there.
    expect(await t.answer("ci.checks.keep", "remove")).toEqual({ value: "Draft updated." })
    expect(t.current().draft.checks).toEqual([])
  } finally { await t.close() }
})

test("answering the recorded draft edits the draft only, and keep edits nothing", async () => {
  const t = await controllerFor(recordedSetup())
  try {
    expect(await t.answer("issues.steps.automatic", "keep")).toEqual({ value: "Keeping the current setup." })
    expect(t.current().revision).toBe(5)
    expect(await t.answer("issues.steps.automatic", "approved")).toEqual({ value: "Draft updated." })
    const after = t.current()
    expect(after.draft.steps.map(step => step.mode)).toEqual(["approved", "approved", "approved", "manual", "manual", "manual"])
    expect(after.draft.checks).toEqual(recordedSetup().draft.checks)
    expect(after.draft.cases).toEqual(recordedSetup().draft.cases)
    expect(after.draft.label).toBe("")
    expect(after.draft.scope).toBe("future")
    expect(after.request).toBeUndefined()
    expect(after.evaluation).toBeUndefined()
    expect(after.trial).toBeUndefined()
    expect(after.active).toBeUndefined()
    // The question now describes the modes the draft actually holds.
    expect(setupGuideQuestions(after).map(question => question.id)).not.toContain("issues.steps.automatic")
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

test("the keep choice never claims a mode the draft does not hold", async () => {
  const setup = recordedSetup()
  setup.draft.steps = setup.draft.steps.map(step => step.id === "research" ? { ...step, mode: "manual" as const } : step)
  const question = setupGuideQuestions(setup)[0]!
  expect(question.id).toBe("issues.steps.automatic")
  expect(question.text).toBe("Keep duplicate lookup and bug reproduction automatic?")
  expect(question.fields).toEqual(["step.duplicates.mode", "step.reproduce.mode"])
  const t = await controllerFor(setup)
  try {
    expect(await t.answer("issues.steps.automatic", "off")).toEqual({ value: "Draft updated." })
    expect(t.current().draft.steps.find(step => step.id === "research")?.mode).toBe("manual")
    expect(t.current().draft.steps.filter(step => ["duplicates", "reproduce"].includes(step.id)).map(step => step.mode)).toEqual(["off", "off"])
  } finally { await t.close() }
})

test("the chore question clears every trigger it names, and keeps manual and approved distinct", async () => {
  const setup = initialSetup("example/repo", "chores", "maintainer")
  setup.draft.schedule = "0 9 * * 1-5"
  setup.draft.steps = setup.draft.steps.map(step => ({ ...step, mode: "approved" as const }))
  const question = setupGuideQuestions(setup)[0]!
  expect(question.id).toBe("chores.schedule")
  const manual = question.choices.find(choice => choice.id === "manual")!
  // Clearing cron beside a live event trigger would be a false answer, so the
  // choice names every trigger field the draft actually carries.
  expect(manual.edits.map(edit => edit.field)).toEqual(["schedule", "step.chore.mode",
    ...("choreEvent" in setup.draft ? ["choreEvent"] : [])])
  expect(manual.edits.find(edit => edit.field === "step.chore.mode")?.value).toBe("manual")
  expect(manual.edits.find(edit => edit.field === "choreEvent")?.value ?? "none").toBe("none")
  const t = await controllerFor(setup)
  try {
    expect(await t.answer("chores.schedule", "manual")).toEqual({ value: "Draft updated." })
    expect(t.current().draft.schedule).toBe("")
    expect(t.current().draft.steps[0]?.mode).toBe("manual")
    expect(await t.answer("chores.schedule", "weekly")).toEqual({ value: "Draft updated." })
    expect(t.current().draft.schedule).toBe("0 9 * * 1")
    expect(t.current().draft.steps[0]?.mode).toBe("approved")
  } finally { await t.close() }
})

/*
 * The chore event trigger arrives with the chore-events candidate f3989046 as
 * `z.enum(["none","push","labeled"])`, so its "no trigger" value is "none" and
 * "" would be refused by the real validator the moment that lands. The edit is
 * emitted exactly when the draft carries the field, so this reads the same
 * before and after that candidate; the value the choice carries is asserted on
 * a draft that carries it either way.
 */
test("the chore trigger is cleared with the value its schema accepts, through the real validator", async () => {
  const setup = initialSetup("example/repo", "chores", "maintainer")
  setup.draft.schedule = "0 9 * * 1-5"
  const carrying = { ...setup, draft: { ...setup.draft, choreEvent: "labeled" } as typeof setup.draft }
  const manual = setupGuideQuestions(carrying).find(question => question.id === "chores.schedule")!
    .choices.find(choice => choice.id === "manual")!
  expect(manual.edits.find(edit => edit.field === "choreEvent")).toEqual({ field: "choreEvent", value: "none" })
  const t = await controllerFor(setup)
  try {
    // The edit follows the field, and every edit the choice emits is accepted
    // by the shared validator.
    expect(setupGuideQuestions(setup).find(question => question.id === "chores.schedule")!
      .choices.find(choice => choice.id === "manual")!.edits.some(edit => edit.field === "choreEvent")).toBe("choreEvent" in setup.draft)
    expect(await t.answer("chores.schedule", "manual")).toEqual({ value: "Draft updated." })
    expect(t.current().draft.schedule).toBe("")
  } finally { await t.close() }
})

/*
 * REQUIRES THE FEATURE-MODE CHANGE ON MAIN (root's 980c7650). Until the
 * feature branch of flows/repository/activation.ts `normalEvents` lands, the
 * feature job registers issue events in every mode, so "Only when I ask" and
 * "Never" would over-promise. The wording below is true only with it.
 */
test("the feature question edits the step mode alone and keeps manual and off distinct", async () => {
  const setup = initialSetup("example/repo", "feature", "maintainer")
  const question = setupGuideQuestions(setup)[0]!
  expect(question.id).toBe("feature.steps.mode")
  expect(question.text).toBe("Start feature work when an issue is opened, edited, reopened or labeled?")
  expect(question.choices.map(choice => choice.id)).toEqual(["manual", "approved", "automatic", "off"])
  // Short options: a choice label is a choice, never an explanatory paragraph.
  for (const choice of question.choices) expect(choice.label.length).toBeLessThanOrEqual(30)
  expect(question.fields).toEqual(["step.feature.mode"])
  const t = await controllerFor(setup)
  try {
    for (const mode of ["approved", "automatic", "off", "manual"] as const) {
      expect(await t.answer("feature.steps.mode", mode)).toEqual({ value: "Draft updated." })
      expect(t.current().draft.steps).toEqual([{ ...setup.draft.steps[0]!, mode }])
    }
  } finally { await t.close() }
})

test("another account's setup and an account switch both refuse the answer", async () => {
  const t = await controllerFor(recordedSetup())
  try {
    const foreign = { ...initialSetup("other/private", "issues", "other"), inspectedAt: 5 }
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: "foreign", kind: "repository-setup",
      title: "Other setup", status: "active", createdAt: 1, ordinal: 2, payload: foreign } }).isPersisted.promise
    expect(await t.controller.answerRepositorySetupQuestion("foreign", "issues.steps.automatic", foreign.revision, setupCandidate(foreign), "approved"))
      .toBe("This setup belongs to a different account.")
    expect((t.store.collections.cards.get("foreign") as SetupCard).payload).toEqual(foreign)
    const before = structuredClone(t.current())
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", admin: false, scopesPlain: null }).isPersisted.promise
    expect(await t.answer("issues.steps.automatic", "approved", before)).toBeTypeOf("string")
    const after = t.store.collections.cards.get("setup")
    if (after?.kind === "repository-setup") expect(after.payload).toEqual(before)
  } finally { await t.close() }
})

/*
 * PRODUCT.md O-07: a new AI check starts report-only, and making one required
 * is a separate reviewed decision after evals and a trial. On 2026-09-18 the CI
 * setup's very first question was "Must this repository's configured check pass
 * before a change lands, or only report?", and answering "It must pass" wrote
 * policy "required" into the draft before either existed
 * (.artifacts/mvp-canary-walk-20260917/B-24-state-ci-terminal.json).
 */
test("no setup question can make a check required, and CI first asks what a person can decide now", async () => {
  const suggested = { id: "docs-grounded", name: "Documentation stays grounded in what the README supports", kind: "ai" as const,
    rule: "Every documentation claim is supported by the README.", paths: [], policy: "report" as const }
  for (const job of REPOSITORY_JOBS) {
    const setup = initialSetup("codeplanesmithers/canary-sandbox", job, "maintainer")
    setup.draft.checks = [suggested]
    for (const question of setupGuideQuestions(setup)) {
      for (const choice of question.choices) {
        for (const edit of choice.edits) expect(JSON.stringify(edit.value)).not.toContain("required")
      }
    }
  }
  const setup = initialSetup("codeplanesmithers/canary-sandbox", "ci", "maintainer")
  setup.draft.checks = [suggested]
  const question = setupGuideQuestions(setup)[0]!
  expect(question.id).toBe("ci.checks.keep")
  expect(question.text).toBe("Keep the suggested check, reporting findings without blocking?")
  expect(question.choices.map(choice => choice.id)).toEqual(["keep", "remove"])
  const t = await controllerFor(setup)
  try {
    expect(await t.answer("ci.checks.keep", "keep")).toEqual({ value: "Draft updated." })
    expect(t.current().draft.checks).toEqual([suggested])
    expect(await t.answer("ci.checks.keep", "remove")).toEqual({ value: "Draft updated." })
    expect(t.current().draft.checks).toEqual([])
  } finally { await t.close() }
})
