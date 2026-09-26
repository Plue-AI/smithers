import assert from "node:assert/strict"
import { test } from "node:test"
import { selectedSteps } from "../repository/execution.ts"
import type { Draft } from "../repository/schema.ts"
import { suggestedSetupDraft } from "../repository/setup.ts"

const draft: Draft = {
  steps: [
    {
      id: "research",
      name: "Research issue",
      mode: "automatic",
      prompt: "Classify the issue and inspect relevant source."
    },
    { id: "poc", name: "Quick POC", mode: "manual", prompt: "Explore a cheap bounded fix in an isolated workspace." }
  ],
  checks: [{
    id: "telemetry",
    name: "Telemetry",
    kind: "ai",
    rule: "Handlers record failures.",
    paths: ["src/**"],
    policy: "required"
  }],
  cases: [],
  replies: "draft",
  landing: "ask",
  scope: "future",
  label: "",
  schedule: "",
  choreEvent: "none",
  budgetMinutes: 10,
  connectIssues: false,
  trialTitle: "[Smithers test] Issues",
  trialBody: "A scoped setup trial."
}
type Suggestion = Parameters<typeof suggestedSetupDraft>[1]
const suggestedCase = {
  id: "answers-a-source-question",
  name: "Answers a source question",
  required: true,
  expected: "The reply cites the captured README.",
  input: {
    sourceRevision: "a".repeat(40),
    event: {
      source: "smithers-cloud",
      type: "issues",
      action: "opened",
      deliveryKey: "delivery-1",
      payload: { issue: { title: "What does the CLI do?", body: "Explain the entry point." } }
    },
    assertions: [{ path: "/results/0/status", equals: "completed" }]
  }
} satisfies Suggestion["cases"][number]
/** Every non-step field here differs from the draft, so the host's discards stay observable. */
const suggestion = (extra: Partial<Suggestion> = {}): Suggestion => ({
  checks: draft.checks,
  cases: [suggestedCase],
  replies: "automatic",
  landing: "checks",
  scope: "label",
  label: "model-label",
  schedule: "0 9 * * *",
  choreEvent: "push",
  budgetMinutes: 90,
  connectIssues: true,
  trialTitle: "Reproduce the reported crash",
  trialBody: "A realistic first request.",
  ...extra
})
const captured = "c".repeat(40)
const merge = (existing: Draft, suggested: Suggestion) => suggestedSetupDraft(existing, suggested, captured)

test("a suggestion without step overrides keeps every step and the user's own decisions", () => {
  const merged = merge(draft, suggestion())
  assert.deepEqual(merged.steps, draft.steps)
  assert.equal(merged.steps[0], draft.steps[0], "an unchanged step is the draft's own step")
  assert.equal(merged.steps[1], draft.steps[1])
  for (
    const field of [
      "replies",
      "landing",
      "scope",
      "label",
      "schedule",
      "choreEvent",
      "connectIssues",
      "budgetMinutes"
    ] as const
  ) assert.deepEqual(merged[field], draft[field])
  assert.equal(merged.trialTitle, "Reproduce the reported crash")
  assert.equal(merged.trialBody, "A realistic first request.")
})

test("an override changes only the named step's named field", () => {
  const modes = merge(draft, suggestion({ steps: [{ id: "poc", mode: "automatic" }] }))
  assert.deepEqual(modes.steps[1], { ...draft.steps[1]!, mode: "automatic" })
  assert.equal(modes.steps[0], draft.steps[0])
  const prompts = merge(draft, suggestion({ steps: [{ id: "research", prompt: "Read crates/ first." }] }))
  assert.deepEqual(prompts.steps[0], { ...draft.steps[0]!, prompt: "Read crates/ first." })
  assert.equal(prompts.steps[1], draft.steps[1])
  assert.equal(draft.steps[1]!.mode, "manual", "merging cannot mutate the draft")
})

// The old contract re-emitted every step and passed the model's array through,
// so a rename or an invented step reached the user's draft. It cannot now.
test("a re-emitted old-shape steps array cannot rename a step or add a new one", () => {
  const reEmitted = [
    { id: "research", name: "Renamed by the model", mode: "off", prompt: "Ignore the repository." },
    { id: "poc", name: "Quick POC", mode: "manual", prompt: "Explore a cheap bounded fix in an isolated workspace." },
    { id: "invented", name: "Invented step", mode: "automatic", prompt: "Do unrequested work." }
  ]
  const merged = merge(draft, suggestion({ steps: reEmitted as unknown as NonNullable<Suggestion["steps"]> }))
  assert.deepEqual(merged.steps.map((step) => step.id), ["research", "poc"])
  assert.deepEqual(merged.steps.map((step) => step.name), draft.steps.map((step) => step.name))
  assert.deepEqual(merged.steps[1], draft.steps[1], "a step re-emitted unchanged keeps its draft values")
  assert.deepEqual(merged.steps[0], { ...draft.steps[0]!, mode: "off", prompt: "Ignore the repository." })
})

test("an override for an unknown step ID is dropped, never added", () => {
  const merged = merge(
    draft,
    suggestion({
      steps: [{ id: "invented", mode: "automatic", prompt: "Do new work." }, {
        id: "poc",
        prompt: "Bound the experiment."
      }]
    })
  )
  assert.equal(merged.steps.length, 2)
  assert.deepEqual(merged.steps.map((step) => step.id), ["research", "poc"])
  assert.equal(merged.steps[1]!.prompt, "Bound the experiment.")
})

test("suggested checks stay report-only and existing user cases survive inspection", () => {
  const rewritten = { ...draft.checks[0]!, rule: "Handlers record every failure class." }
  assert.deepEqual(merge(draft, suggestion({ checks: [rewritten] })).checks, [{ ...rewritten, policy: "report" }])
  assert.deepEqual(merge(draft, suggestion()).checks, draft.checks, "an unchanged authored rule keeps its policy")
  const authored: Draft = {
    ...draft,
    cases: [{ id: "mine", name: "Mine", input: "{}", expected: "Answers.", required: true }]
  }
  assert.deepEqual(merge(authored, suggestion()).cases, authored.cases)
  assert.deepEqual(merge(draft, suggestion()).cases, [{
    ...suggestedCase,
    input: JSON.stringify({ ...suggestedCase.input, sourceRevision: captured })
  }], "a model case is stored as validated JSON text")
})

/** A revision the model names is not a revision the host captured, and a case
 * pinned to a commit this workspace never held can never be evaluated. */
test("the held-out source of a suggested case is the commit the inspection captured", () => {
  const cases = suggestedSetupDraft(draft, suggestion(), captured).cases
  assert.equal(JSON.parse(cases[0]!.input).sourceRevision, captured)
  assert.notEqual(suggestedCase.input.sourceRevision, captured)
  const authored: Draft = {
    ...draft,
    cases: [{
      id: "mine",
      name: "Mine",
      input: JSON.stringify(suggestedCase.input),
      expected: "Answers.",
      required: true,
      edited: true
    }]
  }
  assert.deepEqual(
    suggestedSetupDraft(authored, suggestion(), captured).cases,
    authored.cases,
    "the host never rewrites a case the user already has"
  )
})

test("fresh feature inspection runs a suggested request through its manual step", () => {
  const request = {
    title: "Add a README purpose",
    body: "Document the purpose and run the README check.",
    base: { sha: captured },
    head: { sha: captured }
  }
  const proposed = suggestion({
    cases: [{
      ...suggestedCase,
      input: {
        ...suggestedCase.input,
        event: {
          source: "github",
          type: "pull_request",
          action: "opened",
          deliveryKey: "feature-case",
          payload: { pull_request: request }
        }
      }
    }]
  })
  const featureDraft = {
    ...draft,
    steps: [{
      id: "feature",
      name: "Build a feature",
      mode: "manual" as const,
      prompt: "Implement the requested feature."
    }]
  }
  const saved = suggestedSetupDraft(featureDraft, proposed, captured, "feature").cases[0]!
  const input = JSON.parse(saved.input)
  assert.deepEqual(input.event, {
    source: "smithers-cloud",
    type: "manual",
    action: "manual:feature",
    manualStep: "feature",
    deliveryKey: "feature-case",
    payload: { prompt: "Add a README purpose\n\nDocument the purpose and run the README check." }
  })
  assert.equal(input.sourceRevision, captured)
  assert.deepEqual(input.assertions, suggestedCase.input.assertions)
  assert.equal(saved.expected, suggestedCase.expected)
  assert.deepEqual(
    selectedSteps({ job: "feature", configuration: { ...featureDraft, cases: [saved] }, event: input.event }).map(
      (step) => step.id
    ),
    ["feature"],
    "the production executor reaches the feature step"
  )
  assert.deepEqual(featureDraft.checks, draft.checks, "the configured required check remains in the executing draft")
  const reinspected = suggestedSetupDraft(
    { ...featureDraft, cases: [{ ...proposed.cases[0]!, input: JSON.stringify(proposed.cases[0]!.input) }] },
    proposed,
    "d".repeat(40),
    "feature"
  ).cases[0]!
  const rerun = JSON.parse(reinspected.input)
  assert.equal(
    rerun.event.action,
    "manual:feature",
    "an unedited old generated case becomes executable on reinspection"
  )
  assert.equal(rerun.sourceRevision, "d".repeat(40))
  const automatic = {
    ...featureDraft,
    steps: featureDraft.steps.map((step) => ({ ...step, mode: "automatic" as const }))
  }
  assert.equal(
    JSON.parse(suggestedSetupDraft(automatic, proposed, captured, "feature").cases[0]!.input).event.type,
    "pull_request",
    "automatic setup does not gain a manual case"
  )
  assert.equal(
    JSON.parse(suggestedSetupDraft(featureDraft, proposed, captured, "issues").cases[0]!.input).event.type,
    "pull_request",
    "other jobs retain their suggested event"
  )
  const overridden = suggestedSetupDraft(
    automatic,
    { ...proposed, steps: [{ id: "feature", mode: "manual" }] },
    captured,
    "feature"
  )
  const overriddenEvent = JSON.parse(overridden.cases[0]!.input).event
  assert.deepEqual(
    selectedSteps({ job: "feature", configuration: overridden, event: overriddenEvent }).map((step) => step.id),
    ["feature"],
    "the case must select the final suggested mode, not the previous draft mode"
  )
  const malformed = suggestion({
    cases: [{
      ...suggestedCase,
      input: {
        ...suggestedCase.input,
        event: {
          ...proposed.cases[0]!.input.event,
          payload: { pull_request: { title: request.title, body: request.body, base: { sha: "" }, head: { sha: "" } } }
        }
      }
    }]
  })
  assert.equal(
    JSON.parse(suggestedSetupDraft(featureDraft, malformed, captured, "feature").cases[0]!.input).event.type,
    "pull_request",
    "empty base and head are not a captured placeholder"
  )
  const edited = { ...featureDraft, cases: [{ ...reinspected, edited: true }] }
  assert.deepEqual(
    suggestedSetupDraft(edited, proposed, captured, "feature").cases,
    edited.cases,
    "the host never rewrites an edited case"
  )
})

/** A workspace is replaced; the next inspection captures another commit. Every
 * case that inspection wrote is its own, so its pin moves with it, and a case
 * the maintainer wrote or edited keeps the commit they chose. */
test("a fresh inspection re-pins the cases it authored and leaves an edited case alone", () => {
  const authored = suggestedSetupDraft(draft, suggestion(), captured)
  const replaced = "d".repeat(40)
  const repinned = suggestedSetupDraft(authored, suggestion(), replaced)
  assert.equal(JSON.parse(repinned.cases[0]!.input).sourceRevision, replaced)
  assert.deepEqual(
    { ...JSON.parse(repinned.cases[0]!.input), sourceRevision: captured },
    JSON.parse(authored.cases[0]!.input),
    "only the pin moves; the event, assertions and expected answer are untouched"
  )
  assert.deepEqual({ ...repinned.cases[0]!, input: authored.cases[0]!.input }, authored.cases[0])

  const edited = {
    ...authored,
    cases: [{ ...authored.cases[0]!, edited: true, expected: "The reply cites CONTRIBUTING.md." }]
  }
  assert.deepEqual(
    suggestedSetupDraft(edited, suggestion(), replaced).cases,
    edited.cases,
    "an edited case keeps the commit it names"
  )
})

/** A case the inspection authored names the commit it captured twice: as the pin
 * and as the event's candidate. `checks.ts` accepts no other source for a review
 * or CI event, so a re-pin that moves only the pin moves nothing that decides the
 * run. A candidate the remote published is the event's own fact and stays. */
const reviewCase = (
  head: string,
  pin: string,
  extra: Partial<Draft["cases"][number]> = {}
): Draft["cases"][number] => ({
  id: "review",
  name: "Review",
  required: true,
  expected: "The review runs on the candidate.",
  ...extra,
  input: JSON.stringify({
    event: {
      source: "github",
      type: "pull_request",
      action: "opened",
      deliveryKey: "delivery-2",
      payload: {
        pull_request: { title: "Canary", body: "Read the README.", base: { sha: "b".repeat(40) }, head: { sha: head } }
      }
    },
    sourceRevision: pin,
    assertions: [{ path: "/results/0/status", equals: "completed" }]
  })
})

test("a re-pin moves the event candidate that same pin wrote, and never one the remote published", () => {
  const replaced = "d".repeat(40)
  const own: Draft = { ...draft, cases: [reviewCase(captured, captured)] }
  const moved = JSON.parse(suggestedSetupDraft(own, suggestion(), replaced).cases[0]!.input)
  assert.equal(moved.sourceRevision, replaced)
  assert.equal(
    moved.event.payload.pull_request.head.sha,
    replaced,
    "the candidate this inspection wrote moves with the pin"
  )
  assert.equal(moved.event.payload.pull_request.base.sha, "b".repeat(40), "the remote's own base is untouched")
  assert.deepEqual(
    moved,
    JSON.parse(reviewCase(captured, captured).input.split(captured).join(replaced)),
    "and nothing else moves"
  )

  const published: Draft = { ...draft, cases: [reviewCase("e".repeat(40), captured)] }
  const kept = JSON.parse(suggestedSetupDraft(published, suggestion(), replaced).cases[0]!.input)
  assert.equal(kept.sourceRevision, replaced, "the held-out pin still moves")
  assert.equal(
    kept.event.payload.pull_request.head.sha,
    "e".repeat(40),
    "a candidate this inspection did not write is the event's own"
  )

  const edited: Draft = { ...draft, cases: [reviewCase(captured, captured, { edited: true })] }
  assert.deepEqual(suggestedSetupDraft(edited, suggestion(), replaced).cases, edited.cases, "an edited case keeps both")

  // A manual checks case names its candidate in the payload the CI step reads.
  for (const field of ["head_commit_id", "candidateCommitId"] as const) {
    const manual: Draft = {
      ...draft,
      cases: [{
        id: "checks",
        name: "Checks",
        required: true,
        expected: "The checks step reports honestly.",
        input: JSON.stringify({
          event: {
            source: "smithers-cloud",
            type: "manual",
            action: "manual:checks",
            manualStep: "checks",
            deliveryKey: "delivery-3",
            payload: { prompt: "Run the repository checks", [field]: captured }
          },
          sourceRevision: captured,
          assertions: [{ path: "/results/0/status", equals: "completed" }]
        })
      }]
    }
    const moved = JSON.parse(suggestedSetupDraft(manual, suggestion(), replaced).cases[0]!.input)
    assert.equal(moved.event.payload[field], replaced, `a re-pin moves the candidate named by ${field}`)
    assert.equal(moved.event.payload.prompt, "Run the repository checks", "and leaves the rest of the payload alone")
  }
})

test("a suggested case whose input the maintainer replaced with unreadable text is left as written", () => {
  const authored = suggestedSetupDraft(draft, suggestion(), captured)
  const opaque = { ...authored, cases: [{ ...authored.cases[0]!, input: "answer the question" }] }
  assert.deepEqual(suggestedSetupDraft(opaque, suggestion(), "d".repeat(40)).cases, opaque.cases)
})

/** The event a chore runs on is the maintainer's decision, not a suggestion. */
test("an inspection cannot change the chore event the maintainer chose", () => {
  assert.equal(merge(draft, suggestion({ choreEvent: "push" })).choreEvent, "none")
  assert.equal(merge(draft, suggestion({ choreEvent: "labeled" })).choreEvent, "none")
  const pushing: Draft = { ...draft, choreEvent: "push" }
  assert.equal(merge(pushing, suggestion({ choreEvent: "none" })).choreEvent, "push")
  assert.equal(merge(pushing, suggestion({ choreEvent: "labeled" })).choreEvent, "push")
})
