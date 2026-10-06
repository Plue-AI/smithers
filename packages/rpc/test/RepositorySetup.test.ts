import { describe, expect, it } from "vitest"
import {
  archiveReplacedSetupReceipt,
  discardSetupDraft,
  editSetup,
  initialSetup,
  reconcileSetupHistory,
  type RepositorySetup,
  RepositorySetupSchema,
  setupActivationProblems,
  setupCandidate,
  SetupDraftSchema,
  SetupHostInputSchema,
  SetupOperationResponseSchema,
  type SetupReceipt,
  SetupRecoveryResponseSchema
} from "../src/RepositorySetup.ts"

const caseFixture = {
  id: "unrelated",
  name: "Unrelated change",
  input: "synthetic case fixture",
  expected: "Take no unrelated actions",
  required: true
}

function receipt(setup: RepositorySetup, operation: SetupReceipt["operation"]): SetupReceipt {
  return {
    requestId: `${operation}-request`,
    runId: `${operation}-run`,
    revision: setup.revision,
    operation,
    phase: "completed",
    digest: setupCandidate(setup),
    updatedAt: 100,
    results: setup.draft.cases.map((test) => ({
      caseId: test.id,
      status: "passed",
      observed: test.expected,
      evidence: [`execution:${test.id}`],
      executionId: test.id
    })),
    evidence: ["webhook:delivery-1", "run:trial-run"],
    sourceRevision: "candidate-commit",
    trialIssue: { source: "github", number: 12, url: "https://github.com/example/repo/issues/12" }
  }
}
const proven = (): RepositorySetup => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  setup.draft.cases = [{ ...caseFixture }]
  return { ...setup, evaluation: receipt(setup, "evaluate"), trial: receipt(setup, "trial") }
}

it("a durable guide request survives edits without becoming setup evidence", () => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  setup.guidance = { id: "6405cbb6-c18f-452e-99db-adb1283ee18a", state: "requested" }
  const parsed = RepositorySetupSchema.parse(setup)
  const changed = editSetup(parsed, { ...parsed.draft, trialTitle: "A concrete issue" })
  expect(changed.guidance).toEqual(setup.guidance)
  expect(setupActivationProblems(changed)).toContain("Run evals for this draft.")
  expect(RepositorySetupSchema.safeParse({ ...setup, guidance: { ...setup.guidance, state: "completed" } }).success)
    .toBe(false)
})

it("a scheduler observation is retained independently of a draft and never supplies activation proof", () => {
  const setup = initialSetup("example/repo", "chores", "maintainer")
  setup.draft.schedule = "0 9 * * *"
  setup.active = {
    revision: 1,
    digest: setupCandidate(setup),
    registrationId: "chore",
    sourceRevision: "source",
    enabled: true,
    schedule: { expression: setup.draft.schedule, nextFireAt: "2026-09-18T09:00:00Z" }
  }
  const parsed = RepositorySetupSchema.parse(setup)
  expect(parsed.active?.schedule).toEqual(setup.active.schedule)
  expect(setupActivationProblems(parsed)).toContain("Run evals for this draft.")
  expect(setupActivationProblems(parsed)).toContain("Complete the live trial for this draft.")
  const changed = editSetup(parsed, { ...parsed.draft, schedule: "" })
  expect(changed.draft.schedule).toBe("")
  expect(changed.active?.schedule?.expression).toBe("0 9 * * *")
  expect(changed.revision).toBe(2)
  expect(
    RepositorySetupSchema.safeParse({
      ...setup,
      active: { ...setup.active, schedule: { expression: "0 9 * * *", nextFireAt: "tomorrow" } }
    }).success
  ).toBe(false)
})

it("a chore event joins the candidate, defaults to none in a stored draft and needs a step that actually runs", () => {
  const unattended = "Set the chore to run automatically or on approval."
  const setup = initialSetup("example/repo", "chores", "maintainer")
  expect(setup.draft.choreEvent).toBe("none")
  const { choreEvent: _absent, ...stored } = setup.draft
  expect(SetupDraftSchema.parse(stored).choreEvent).toBe("none")
  expect(setupActivationProblems(setup)).not.toContain(unattended)
  const running = (draft: RepositorySetup["draft"]) => ({
    ...draft,
    steps: draft.steps.map((step) => ({ ...step, mode: "approved" as const }))
  })
  for (
    const draft of [{ ...setup.draft, choreEvent: "push" as const }, {
      ...setup.draft,
      choreEvent: "labeled" as const,
      label: "chore"
    }, { ...setup.draft, schedule: "0 9 * * *" }]
  ) {
    expect(setupCandidate({ ...setup, draft })).not.toBe(setupCandidate(setup))
    expect(setupActivationProblems({ ...setup, draft })).toContain(unattended)
    expect(setupActivationProblems({ ...setup, draft: running(draft) })).not.toContain(unattended)
  }
  expect(
    setupActivationProblems({
      ...setup,
      draft: { ...setup.draft, choreEvent: "labeled", steps: running(setup.draft).steps }
    })
  )
    .toContain("Choose the issue label.")
  const issues = initialSetup("example/repo", "issues", "maintainer")
  expect(setupActivationProblems({ ...issues, draft: { ...issues.draft, schedule: "0 9 * * *" } })).not.toContain(
    unattended
  )
})

it("refuses a padded label where the label decides what runs, so a label that never fires cannot register", () => {
  const padded = "Remove the spaces around the issue label."
  const chore = initialSetup("example/repo", "chores", "maintainer")
  const running = chore.draft.steps.map((step) => ({ ...step, mode: "approved" as const }))
  expect(
    setupActivationProblems({
      ...chore,
      draft: { ...chore.draft, steps: running, choreEvent: "labeled", label: " chore " }
    })
  ).toContain(padded)
  expect(
    setupActivationProblems({
      ...chore,
      draft: { ...chore.draft, steps: running, choreEvent: "labeled", label: "chore" }
    })
  ).not.toContain(padded)
  const issues = initialSetup("example/repo", "issues", "maintainer")
  expect(setupActivationProblems({ ...issues, draft: { ...issues.draft, scope: "label", label: "triage " } }))
    .toContain(padded)
  const blank = setupActivationProblems({ ...issues, draft: { ...issues.draft, scope: "label", label: " " } })
  expect(blank).toContain("Choose the issue label.")
  expect(blank).not.toContain(padded)
  expect(setupActivationProblems({ ...issues, draft: { ...issues.draft, label: " triage " } })).not.toContain(padded)
})

/** Digests for a draft that never set a chore event, which is what a record
 * stored before that field existed still decodes to. Re-pinned when the trial's
 * own test request left the candidate: every digest computed before that change
 * moves once, and the app re-proves the candidate at its next revision. */
const STORED_DIGESTS = {
  issues: "5ca740ed1ed3e3a2f15d993d8b80dc972de3fcd8c422553f5eb98fcd1a0396e8",
  chores: "43606782a7bd634fd52a35558f1d46ffa55f87531f529ac02490777881c4b342"
} as const

/** R96 B1: digests the build before the trial's own test request left the candidate computed for these
 * drafts. Every registration row, stored request and dispatched job written until now carries this
 * identity, and none of them is ever recomputed where it is stored. */
const REGISTERED_DIGESTS = {
  issues: "eaa65868ff1b8e731c14d789e16b27f980d92492601fca521d9a4534a9b3194f",
  chores: "bbf342a61d1c36d83ecd20c7f7372dbc27cf61bf121f36590b874196b6ffdf35"
} as const

it.each(["issues", "chores"] as const)(
  "a %s request registered before the trial's test request left the candidate still names its draft",
  (job) => {
    const setup = initialSetup("example/repo", job, "maintainer")
    const { choreEvent: _absent, ...stored } = setup.draft
    const decodes = (digest: string, draft: unknown = stored) =>
      SetupHostInputSchema.safeParse({
        requestId: "stored-request",
        repo: setup.repo,
        job,
        revision: setup.revision,
        digest,
        draft,
        operation: "apply"
      }).success
    expect(setupCandidate(setup)).not.toBe(REGISTERED_DIGESTS[job])
    expect(decodes(REGISTERED_DIGESTS[job])).toBe(true)
    expect(decodes(STORED_DIGESTS[job])).toBe(true)
    expect(decodes("0".repeat(64))).toBe(false)
    // The stored row hashed its own trial request, so a configuration edit still replaces the candidate.
    expect(decodes(REGISTERED_DIGESTS[job], { ...stored, budgetMinutes: 20 })).toBe(false)
  }
)

it("a paused registration written before the trial's test request left the candidate still restarts", () => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  const active = {
    revision: setup.revision,
    digest: REGISTERED_DIGESTS.issues,
    registrationId: "paused-registration",
    sourceRevision: "candidate-commit",
    enabled: false
  }
  const paused: RepositorySetup = { ...setup, revision: setup.revision + 1, active }
  expect(setupActivationProblems(paused)).toEqual([])
  expect(setupActivationProblems({ ...paused, active: { ...active, digest: "0".repeat(64) } }))
    .toContain("Run evals for this draft.")
})

it.each(["issues", "chores"] as const)(
  "a %s candidate stored before the chore event existed keeps its digest, in both skew directions",
  (job) => {
    const setup = initialSetup("example/repo", job, "maintainer")
    const { choreEvent: _absent, ...stored } = setup.draft
    expect(
      SetupHostInputSchema.safeParse({
        requestId: "stored-request",
        repo: setup.repo,
        job,
        revision: setup.revision,
        digest: STORED_DIGESTS[job],
        draft: stored,
        operation: "apply"
      }).success
    ).toBe(true)
    expect(setupCandidate(setup)).toBe(STORED_DIGESTS[job])
    for (const choreEvent of ["push", "labeled"] as const) {
      expect(setupCandidate({ ...setup, draft: { ...setup.draft, choreEvent } })).not.toBe(STORED_DIGESTS[job])
    }
  }
)

describe("repository setup receipt history", () => {
  it("archiving a displaced receipt preserves terminal evidence and deduplicates without granting activation", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const pause = receipt(setup, "pause"), apply = receipt(setup, "apply")
    setup.receipt = { ...pause, phase: "running", updatedAt: 200 }
    setup.previousReceipts = [pause]
    const archived = archiveReplacedSetupReceipt(setup, apply)
    expect(archived.previousReceipts).toEqual([pause])
    expect(archiveReplacedSetupReceipt(archived, apply).previousReceipts).toEqual([pause])
    expect(archived.receipt).toBe(setup.receipt)
    expect(archived.evaluation).toBeUndefined()
    expect(archived.trial).toBeUndefined()
    expect(setupActivationProblems(archived)).toHaveLength(2)
  })

  it("bounds receipt history while retaining the newly displaced current request", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    setup.receipt = receipt(setup, "pause")
    setup.previousReceipts = Array.from(
      { length: 50 },
      (_, index) => ({ ...receipt(setup, "inspect"), requestId: `older-${index}` })
    )
    const archived = archiveReplacedSetupReceipt(setup, receipt(setup, "apply"))
    expect(archived.previousReceipts).toHaveLength(50)
    expect(archived.previousReceipts[0]?.requestId).toBe("older-1")
    expect(archived.previousReceipts.at(-1)).toEqual(setup.receipt)
    expect(setup.previousReceipts[0]?.requestId).toBe("older-0")
  })

  it("a current receipt is not duplicated, while different candidate identities remain distinct", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    setup.receipt = receipt(setup, "pause")
    expect(archiveReplacedSetupReceipt(setup, { ...setup.receipt, updatedAt: 200 })).toBe(setup)
    const previous = { ...setup.receipt, revision: 2, digest: "other-candidate" }
    setup.previousReceipts = [previous]
    expect(archiveReplacedSetupReceipt(setup, receipt(setup, "apply")).previousReceipts).toEqual([
      previous,
      setup.receipt
    ])
  })

  it("uses actual eval and trial receipts without inventing a missing outcome", () => {
    const setup = proven()
    const unknown = { ...setup.evaluation!, requestId: "unobserved", phase: "running" as const }
    setup.previousReceipts = [
      { ...setup.evaluation!, phase: "running" },
      { ...setup.trial!, phase: "waiting" },
      unknown
    ]
    expect(reconcileSetupHistory(setup).previousReceipts).toEqual([setup.evaluation, setup.trial, unknown])
    expect(setup.previousReceipts[0]?.phase).toBe("running")
  })

  it.each([
    { requestId: "another" },
    { revision: 2 },
    { digest: "another" },
    { operation: "trial" as const },
    { runId: "another" },
    { jobRunId: "another" }
  ])("does not heal a different receipt identity: %j", (changed) => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const previous = { ...receipt(setup, "inspect"), phase: "running" as const, jobRunId: "job-run" }
    setup.previousReceipts = [previous]
    setup.receipt = { ...previous, phase: "completed", ...changed }
    expect(reconcileSetupHistory(setup)).toBe(setup)
  })

  it.each(["completed", "failed", "stopped"] as const)(
    "preserves a %s receipt against later progress or a conflicting terminal result",
    (phase) => {
      const setup = initialSetup("example/repo", "issues", "maintainer")
      const previous = { ...receipt(setup, "inspect"), phase }
      setup.previousReceipts = [previous]
      setup.receipt = { ...previous, phase: "running", updatedAt: 200 }
      expect(reconcileSetupHistory(setup)).toBe(setup)
      const edited = editSetup(setup, { ...setup.draft, trialTitle: "Changed candidate" })
      expect(edited.previousReceipts).toEqual([previous])
      setup.receipt = { ...previous, phase: phase === "completed" ? "failed" : "completed", updatedAt: 300 }
      expect(reconcileSetupHistory(setup)).toBe(setup)
    }
  )

  it("does not replace newer progress with a late observation of the same request", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const pending = { ...receipt(setup, "inspect"), phase: "running" as const, updatedAt: 200 }
    setup.previousReceipts = [pending]
    setup.receipt = { ...pending, updatedAt: 100 }
    expect(reconcileSetupHistory(setup)).toBe(setup)
    setup.receipt = { ...pending, updatedAt: 300 }
    const advanced = reconcileSetupHistory(setup)
    expect(advanced.previousReceipts).toEqual([setup.receipt])
    expect(setup.previousReceipts).toEqual([pending])
  })
})

describe("repository setup candidate recovery", () => {
  it("discards local edits back to the active registration's exact draft and revision", () => {
    const applied = proven()
    const active = {
      revision: applied.revision,
      digest: setupCandidate(applied),
      registrationId: "active-registration",
      sourceRevision: "candidate-commit",
      enabled: true,
      draft: applied.draft
    }
    const changed = editSetup({ ...applied, active }, { ...applied.draft, budgetMinutes: 20 })
    expect(changed.revision).toBe(2)
    expect(changed.evaluation).toBeUndefined()
    expect(changed.trial).toBeUndefined()

    const restored = discardSetupDraft(changed)
    expect(restored.draft).toEqual(applied.draft)
    expect(restored.revision).toBe(active.revision)
    expect(setupCandidate(restored)).toBe(active.digest)
    expect(restored.active).toEqual(active)
    expect(restored.previousReceipts).toEqual([applied.evaluation, applied.trial])
    expect(restored.evaluation).toBeUndefined()
    expect(restored.trial).toBeUndefined()
    expect(changed.draft.budgetMinutes).toBe(20)
  })

  it("cannot discard without the active registration's recorded draft", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    expect(discardSetupDraft(setup)).toBe(setup)
    const active = {
      revision: 1,
      digest: setupCandidate(setup),
      registrationId: "legacy-registration",
      sourceRevision: "candidate-commit",
      enabled: true
    }
    const legacy = { ...setup, active }
    expect(discardSetupDraft(legacy)).toBe(legacy)
  })
})

describe("repository setup host request boundary", () => {
  const hostInput = (job: RepositorySetup["job"], operation: "run" | "apply" | "trial") => {
    const setup = initialSetup("example/repo", job, "maintainer")
    return {
      requestId: "host-request",
      repo: setup.repo,
      job,
      revision: setup.revision,
      draft: setup.draft,
      digest: setupCandidate(setup),
      operation
    }
  }

  it.each(["issues", "ci", "review", "feature", "chores"] as const)(
    "requires manual work only for a run, while %s activation carries none",
    (job) => {
      const apply = hostInput(job, "apply")
      expect(SetupHostInputSchema.safeParse(apply).success).toBe(true)
      expect(SetupHostInputSchema.safeParse({ ...apply, operation: "trial" }).success).toBe(true)
      expect(SetupHostInputSchema.safeParse({ ...apply, operation: "run" }).success).toBe(false)
      expect(SetupHostInputSchema.safeParse({ ...apply, manual: { stepId: "poc", prompt: "Work" } }).success).toBe(
        false
      )
    }
  )

  it.each(
    [
      ["issues", "issue", "pr"],
      ["review", "pr", "issue"],
      ["ci", "pr", "issue"]
    ] as const
  )("a %s manual run accepts a %s and refuses a %s", (job, acceptedKind, refusedKind) => {
    const input = hostInput(job, "run")
    const manual = { stepId: "poc", prompt: "Work", subject: { source: "github", kind: acceptedKind, number: 12 } }
    // The enabled step comes from this job's own draft; no fabricated operation is needed.
    const stepId = input.draft.steps.find((step) => step.mode !== "off")?.id
    if (stepId === undefined) throw new Error("the fixture has no enabled step")
    const accepted = { ...manual, stepId }
    expect(SetupHostInputSchema.safeParse({ ...input, manual: accepted }).success).toBe(true)
    expect(
      SetupHostInputSchema.safeParse({
        ...input,
        manual: { ...accepted, subject: { ...accepted.subject, kind: refusedKind } }
      }).success
    ).toBe(false)
  })

  it.each(["feature", "chores"] as const)("a %s manual run needs a nonblank work description", (job) => {
    const input = hostInput(job, "run")
    const stepId = input.draft.steps.find((step) => step.mode !== "off")?.id
    if (stepId === undefined) throw new Error("the fixture has no enabled step")
    for (const prompt of ["", " \n "]) {
      expect(SetupHostInputSchema.safeParse({ ...input, manual: { stepId, prompt } }).success).toBe(false)
    }
    expect(
      SetupHostInputSchema.safeParse({
        ...input,
        manual: { stepId, prompt: "Repair the README", subject: undefined }
      }).success
    ).toBe(true)
  })

  it("requires an observed inspection or receipt in every acknowledged operation", () => {
    const base = { requestId: "host-request", revision: 1, digest: "a".repeat(64) }
    expect(SetupOperationResponseSchema.safeParse(base).success).toBe(false)
    expect(SetupOperationResponseSchema.safeParse({ ...base, receipt: { requestId: "partial" } }).success).toBe(false)
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const inspection = { sources: [], suggestedDraft: setup.draft, inspectedAt: 100 }
    expect(SetupOperationResponseSchema.safeParse({ ...base, inspection }).success).toBe(true)
    expect(SetupOperationResponseSchema.safeParse({ ...base, receipt: receipt(setup, "inspect") }).success).toBe(true)
  })

  it("keeps registration availability independent from stored-request recovery", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const input = hostInput("issues", "apply")
    const result = {
      requestId: input.requestId,
      revision: input.revision,
      digest: input.digest,
      inspection: { sources: [], suggestedDraft: setup.draft, inspectedAt: 100 }
    }
    const registrations = [
      { state: "known", active: undefined, trial: undefined },
      { state: "unavailable", error: "Registry offline" }
    ] as const
    const stored = [
      { state: "none" },
      { state: "unavailable", error: "Stored request offline" },
      { state: "found", input, result, observationError: "Observation still pending" }
    ] as const
    for (const registration of registrations) {
      for (const recovered of stored) {
        const wire = { owner: "maintainer", repo: setup.repo, job: setup.job, registration, setup: recovered }
        const parsed = SetupRecoveryResponseSchema.parse(wire)
        expect(parsed.registration).toEqual(registration)
        expect(parsed.setup).toEqual(recovered)
      }
    }
    expect(
      SetupRecoveryResponseSchema.safeParse({
        owner: "maintainer",
        repo: setup.repo,
        job: setup.job,
        registration: registrations[0],
        setup: { state: "found", input }
      }).success
    ).toBe(false)
  })
})

describe("repository setup activation evidence", () => {
  it("manual work selects an enabled step and an explicit subject, without accepting signed event data", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const input = {
      requestId: "manual-request",
      repo: setup.repo,
      job: setup.job,
      revision: setup.revision,
      draft: setup.draft,
      digest: setupCandidate(setup),
      operation: "run",
      manual: {
        stepId: "poc",
        prompt: "Try the reported fix",
        subject: { source: "github", kind: "issue", number: 12 }
      }
    }
    expect(SetupHostInputSchema.safeParse(input).success).toBe(true)
    expect(SetupHostInputSchema.parse({ ...input, event: { sender: "admin" } })).not.toHaveProperty("event")
    for (
      const manual of [undefined, { ...input.manual, stepId: "missing" }, { ...input.manual, subject: undefined }, {
        ...input.manual,
        subject: { ...input.manual.subject, number: -1 }
      }]
    ) {
      expect(SetupHostInputSchema.safeParse({ ...input, manual }).success).toBe(false)
    }
    expect(SetupHostInputSchema.safeParse({ ...input, operation: "trial" }).success).toBe(false)
  })
  it("does not let two expected cases share the same execution result id", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    expect(
      SetupDraftSchema.safeParse({
        ...setup.draft,
        cases: [{ ...caseFixture }, { ...caseFixture, expected: "A different expectation" }]
      }).success
    ).toBe(false)
  })
  it("is opt-in with production fixes and POCs independent and manually started", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    expect(setup.active).toBeUndefined()
    expect(setup.draft.steps.filter((step) => step.mode === "automatic").map((step) => step.id)).toEqual([
      "research",
      "duplicates",
      "reproduce"
    ])
    expect(setup.draft.steps.find((step) => step.id === "poc")?.mode).toBe("manual")
    expect(setup.draft.steps.find((step) => step.id === "fix")?.mode).toBe("manual")
    expect(setup.draft.replies).toBe("draft")
    expect(setupActivationProblems(setup)).toHaveLength(2)
  })
  /*
   * Walk run 3, defect B3-N1: the issues draft stood at revision 10 with its
   * evals passed when the maintainer filled `Test issue title` and `Test issue
   * body`. That moved the candidate to revision 12, and `Create test issue`
   * refused with "Run evals for this exact candidate before continuing"
   * (.artifacts/mvp-canary-walk-20260917/B3-13-state-trial-terminal.json).
   */
  it("filling the trial's own test request keeps the candidate its evals and trial were run on", () => {
    const setup = { ...initialSetup("example/repo", "issues", "maintainer"), revision: 10 }
    setup.draft.cases = [{ ...caseFixture }]
    const evaluated: RepositorySetup = {
      ...setup,
      evaluation: receipt(setup, "evaluate"),
      trial: receipt(setup, "trial")
    }
    expect(setupActivationProblems(evaluated)).toEqual([])
    const filled = editSetup(evaluated, {
      ...evaluated.draft,
      trialTitle: "[canary 20260918 b3d] Does the README explain the cloud review workflow?",
      trialBody: "Answer the question from README.md."
    })
    expect(filled.draft.trialTitle).toBe("[canary 20260918 b3d] Does the README explain the cloud review workflow?")
    expect(filled.revision).toBe(10)
    expect(setupCandidate(filled)).toBe(setupCandidate(evaluated))
    expect(filled.evaluation).toEqual(evaluated.evaluation)
    expect(filled.trial).toEqual(evaluated.trial)
    expect(filled.previousReceipts).toEqual([])
    expect(setupActivationProblems(filled)).toEqual([])
    // A trial PR is selected through the same field, and a configured change
    // beside it is still a new candidate that owes its own proof.
    const pr = editSetup(filled, { ...filled.draft, trialBody: JSON.stringify({ source: "github", number: 2 }) })
    expect(pr.revision).toBe(10)
    expect(setupActivationProblems(pr)).toEqual([])
    const configured = editSetup(pr, { ...pr.draft, budgetMinutes: 20, trialTitle: "Another test issue" })
    expect(configured.revision).toBe(11)
    expect(setupActivationProblems(configured)).toContain("Run evals for this draft.")
  })
  it("restarts a paused registration from the draft it was activated with, without new evals or trial", () => {
    const applied = proven()
    const active = {
      revision: applied.revision,
      digest: setupCandidate(applied),
      registrationId: "paused-registration",
      sourceRevision: "candidate-commit",
      enabled: false
    }
    // The post-pause card: Cloud re-enables only a newer revision, so the
    // candidate advances while its evidence moves into the history.
    const paused: RepositorySetup = {
      ...applied,
      revision: applied.revision + 1,
      evaluation: undefined,
      trial: undefined,
      active,
      previousReceipts: [applied.evaluation!, applied.trial!]
    }
    expect(setupActivationProblems(paused)).toEqual([])
    expect(setupActivationProblems({ ...paused, active: { ...active, enabled: true } })).toHaveLength(2)
    const edited = editSetup(paused, { ...paused.draft, budgetMinutes: 20 })
    expect(setupActivationProblems(edited)).toContain("Complete the live trial for this draft.")
    expect(setupActivationProblems(edited)).toContain("Run evals for this draft.")
    expect(setupActivationProblems({ ...paused, active: { ...active, digest: setupCandidate(edited) } })).toContain(
      "Run evals for this draft."
    )
  })
  it("requires both current evals and a real live issue trial", () => {
    const setup = proven()
    expect(setupActivationProblems(setup)).toEqual([])
    setup.trial!.phase = "running"
    expect(setupActivationProblems(setup)).toContain("Complete the live trial for this draft.")
    setup.trial!.phase = "completed"
    delete setup.trial!.trialIssue
    expect(setupActivationProblems(setup)).toContain("The live trial needs a real issue receipt.")
  })
  it("does not accept launch success, cross-repository receipts, or mismatched operation receipts", () => {
    const setup = proven()
    setup.evaluation!.phase = "queued"
    expect(setupActivationProblems(setup)).toContain("Run evals for this draft.")
    setup.evaluation = receipt(initialSetup("other/repo", "issues", "maintainer"), "evaluate")
    expect(setupActivationProblems(setup)).toContain("Run evals for this draft.")
    setup.evaluation = receipt(setup, "trial")
    expect(setupActivationProblems(setup)).toContain("Run evals for this draft.")
  })
  it.each(["failed", "review", "error"] as const)("a required case that is %s blocks activation", (status) => {
    const setup = proven()
    setup.evaluation!.results[0]!.status = status
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
  })
  it("rejects missing, duplicate, and unsupported passing results", () => {
    const setup = proven()
    setup.evaluation!.results.shift()
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
    setup.evaluation = receipt(setup, "evaluate")
    setup.evaluation.results.push(setup.evaluation.results[0]!)
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
    setup.evaluation = receipt(setup, "evaluate")
    setup.evaluation.results[0]!.evidence = []
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
  })
  it("prompt edits invalidate candidate evidence while preserving the active policy", () => {
    const setup = proven()
    setup.active = {
      revision: 1,
      digest: setupCandidate(setup),
      registrationId: "registration-1",
      sourceRevision: "commit-1",
      enabled: true
    }
    const changed = editSetup(setup, {
      ...setup.draft,
      steps: setup.draft.steps.map((step) => step.id === "research" ? { ...step, prompt: "A revised rule" } : step)
    })
    expect(changed.revision).toBe(2)
    expect(changed.active).toEqual(setup.active)
    expect(changed.evaluation).toBeUndefined()
    expect(changed.trial).toBeUndefined()
    expect(setupActivationProblems({ ...changed, evaluation: setup.evaluation, trial: setup.trial })).toHaveLength(2)
    expect(editSetup(changed, changed.draft)).toBe(changed)
  })
  it("editing recovered pending work retains its read-only identity until a real terminal receipt arrives", () => {
    const setup = proven()
    setup.receipt = { ...receipt(setup, "apply"), phase: "waiting" }
    setup.request = {
      id: setup.receipt.requestId,
      operation: "apply",
      revision: setup.revision,
      digest: setupCandidate(setup),
      state: "failed",
      error: "Disconnected",
      observeOnly: true
    }
    const edited = editSetup(setup, { ...setup.draft, budgetMinutes: 12 })
    expect(edited.request).toEqual(setup.request)
    expect(edited.receipt?.phase).toBe("waiting")
    expect(edited.evaluation).toBeUndefined()
    expect(edited.trial).toBeUndefined()
    const finished = editSetup({ ...edited, receipt: { ...edited.receipt!, phase: "completed" } }, {
      ...edited.draft,
      budgetMinutes: 13
    })
    expect(finished.request).toBeUndefined()
    expect(finished.previousReceipts.find((item) => item.requestId === setup.receipt!.requestId)?.phase).toBe(
      "completed"
    )
  })
  it.each([
    { state: "requested" as const },
    { state: "running" as const },
    { state: "failed" as const, error: "Disconnected" }
  ])(
    "editing recovered $state work before its first receipt keeps the request without inventing proof",
    ({ state, ...details }) => {
      const initial = initialSetup("example/repo", "issues", "maintainer")
      const setup = RepositorySetupSchema.parse({
        ...initial,
        request: {
          id: "recovered-apply-request",
          operation: "apply",
          revision: 1,
          digest: setupCandidate(initial),
          state,
          observeOnly: true,
          ...details
        }
      })
      const before = structuredClone(setup)
      const edited = editSetup(setup, { ...setup.draft, budgetMinutes: 12 })
      expect(edited.revision).toBe(2)
      expect(edited.draft.budgetMinutes).toBe(12)
      expect(setupCandidate(edited)).not.toBe(setupCandidate(setup))
      expect(edited.request).toEqual(setup.request)
      expect(edited.receipt).toBeUndefined()
      expect(edited.evaluation).toBeUndefined()
      expect(edited.trial).toBeUndefined()
      expect(edited.previousReceipts).toEqual([])
      expect(setupActivationProblems(edited)).toContain("Run evals for this draft.")
      expect(setupActivationProblems(edited)).toContain("Complete the live trial for this draft.")
      expect(setup).toEqual(before)
    }
  )
  it("requires a label for label-scoped activation and at least one enabled flow", () => {
    const setup = proven()
    setup.draft.scope = "label"
    setup.draft.steps = setup.draft.steps.map((step) => ({ ...step, mode: "off" }))
    expect(setupActivationProblems(setup)).toContain("Choose the issue label.")
    expect(setupActivationProblems(setup)).toContain("Choose a flow to enable.")
  })
  it("names incomplete check rules before a candidate can activate", () => {
    const setup = proven()
    const check = {
      id: "ci",
      name: "CI",
      kind: "command" as const,
      rule: " \n ",
      paths: [],
      policy: "required" as const
    }
    setup.draft.checks = [check]
    expect(setupActivationProblems(setup)).toContain("Complete the check rules.")
    setup.draft.checks = [{ ...check, rule: "pnpm test" }]
    expect(setupActivationProblems(setup)).not.toContain("Complete the check rules.")
  })
  it("waits for repository inspection to author real cases and refuses empty-case activation", () => {
    for (const job of ["issues", "ci", "review", "feature", "chores"] as const) {
      const setup = initialSetup("example/repo", job, null)
      expect(setup.draft.cases).toEqual([])
      setup.evaluation = receipt(setup, "evaluate")
      setup.trial = receipt(setup, "trial")
      expect(setupActivationProblems(setup)).toContain("Add required eval cases.")
    }
  })
})

it("preserves safe pre-run observations on reload and accepts recovery", () => {
  const setup = initialSetup("owner/repo", "review", "owner")
  const queued = {
    ...receipt(setup, "inspect"),
    runId: undefined,
    phase: "queued" as const,
    observation: { state: "blocked" as const, code: "runtime_unavailable" as const, observedAt: 200 },
    updatedAt: 200
  }
  const parsed = RepositorySetupSchema.parse({ ...setup, receipt: queued })
  expect(parsed.receipt?.observation).toEqual(queued.observation)
  const recovered = { ...queued, phase: "running" as const, runId: "same-run", observation: undefined, updatedAt: 201 }
  const result = reconcileSetupHistory({ ...parsed, previousReceipts: [queued], receipt: recovered })
  expect(result.previousReceipts[0]?.phase).toBe("running")
  expect(result.previousReceipts[0]?.observation).toBeUndefined()
  for (
    const observation of [
      { state: "failed", code: "runtime_unrecoverable", observedAt: 202 },
      { state: "blocked", code: "runtime_unavailable", observedAt: 200 }
    ]
  ) {
    expect(RepositorySetupSchema.parse({ ...setup, receipt: { ...queued, observation } }).receipt?.observation).toEqual(
      observation
    )
  }
  for (
    const observation of [
      { state: "blocked", code: "raw_provider_secret", observedAt: 200 },
      { state: "unknown", code: "runtime_unavailable", observedAt: 200 },
      { state: "blocked", code: "runtime_unavailable", observedAt: 0 }
    ]
  ) {
    expect(RepositorySetupSchema.safeParse({ ...setup, receipt: { ...queued, observation } }).success).toBe(false)
  }
})
