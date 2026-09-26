/** Jev picks the release narrative. Which of four write-ups a release calls
 * for is a closed choice over an enumerated answer set, so the decision-only
 * model makes it and the writer seat is left the part that is text: the
 * outline of the narrative it was handed. */
import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Schema } from "effect"
import { type Analysis, type ContentInput, type Evidence, ReleaseError } from "../release-support/schema.ts"

/**
 * At or above this confidence Jev's narrative is the release's narrative.
 *
 * The vendor publishes no calibration curve, and the one agreement figure it
 * does publish is 76.0% against frontier reference labels on its
 * best-reported task, a ceiling and not an average, since its other published tasks run 61.7 to 71.6 (https://github.com/smithersai/smithers/issues/1654), so the bar is the top
 * of the range on purpose: the narrative decides what every published channel
 * of the release claims to be about, and a release announced as the wrong kind
 * of thing is read by every user before anyone corrects it.
 */
export const TEMPLATE_CONFIDENCE = 0.8
/** The most bytes one state may take, matching `@smthrs/std`'s per-state bound. */
export const MAX_STATE_BYTES = 32 * 1024
/** The most bytes of the operator's own words one state carries. */
export const MAX_NOTES_BYTES = 4 * 1024

/** What each narrative is for. These are the only four answers Jev may give,
 * and each criterion names the job the write-up does rather than its shape,
 * because the evidence is what decides which job this release needs done. */
export const templateCriteria = {
  "feature deep dive":
    "one new capability carries the release, and the write-up exists to explain how that capability works and when to reach for it",
  "migration guide":
    "the release changes or removes behavior people already depend on, and the write-up exists to get them from the old behavior to the new one",
  "reliability report":
    "the release is mostly fixes, performance or durability work, and the write-up exists to say what stopped going wrong and what is now safe to rely on",
  "release roundup":
    "the release is several unrelated changes of comparable weight, and the write-up exists to list them so a reader can find the one that affects them"
} as const

/** The narratives, in the order the criteria declare them. */
export const templates = Object.keys(templateCriteria) as ReadonlyArray<keyof typeof templateCriteria>
/** The answer set as a schema, so a pick that is not one of the four cannot be persisted. */
export const ReleaseTemplate = Schema.Literals(
  templates as unknown as readonly [
    "feature deep dive",
    "migration guide",
    "reliability report",
    "release roundup"
  ]
)
export type ReleaseTemplate = typeof ReleaseTemplate.Type

/** One release as the classifier sees it: the claim ledger the analyst built,
 * the evidence it was built from, and what the operator asked for. The
 * publication flags the prompt used to ship are left out; whether a thread is
 * enabled does not bear on which write-up the evidence calls for. */
export const TemplateState = Schema.Struct({
  version: Schema.String.annotate({ description: "The version being released" }),
  notes: Schema.String.annotate({
    description: "What the release operator asked for, in their own words; empty when they asked for nothing"
  }),
  ledger: Schema.String.annotate({
    description:
      "The claim ledger: the analyst's title, summary, highlights, risks, migration steps and every claim with its sources"
  }),
  evidence: Schema.String.annotate({
    description:
      "The release's own evidence: commit subjects, changed paths and documentation excerpts, clipped so the whole state stays under 32 KiB"
  })
})
export type TemplateState = typeof TemplateState.Type

/** The one question every release answers. */
export const templateClassifier = Classifier.make("release/template", {
  description: "Judge one release's evidence and claim ledger: which of four release write-ups does it call for?",
  state: TemplateState,
  questions: {
    template: Classifier.choice({
      instructions: "Which write-up does this release's evidence call for?",
      criteria: templateCriteria
    })
  }
})

/** The narrative, and how sure Jev was of it. `PickTemplate` is its only
 * writer, so a writer seat that names a narrative in its own output cannot
 * forge the record. */
export const TemplatePick = Schema.Struct({ template: ReleaseTemplate, confidence: Schema.Number })
export type TemplatePick = typeof TemplatePick.Type

const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).length
/** Clips to a byte budget without splitting a surrogate pair. */
const clipToBytes = (value: string, limit: number): string => {
  if (limit <= 0) return ""
  if (bytes(value) <= limit) return value
  let end = Math.min(value.length, limit)
  while (end > 0 && bytes(value.slice(0, end)) > limit) end -= 1
  if (end > 0 && value.codePointAt(end - 1)! >= 0xd800 && value.codePointAt(end - 1)! <= 0xdbff) end -= 1
  return value.slice(0, end)
}

const list = (label: string, entries: ReadonlyArray<string>): string =>
  entries.length === 0 ? "" : `${label}:\n${entries.map((entry) => `- ${entry}`).join("\n")}\n`

/** The ledger as lines rather than JSON, so clipping it leaves readable
 * evidence instead of a truncated object. */
const ledgerText = (analysis: Analysis): string =>
  `Title: ${analysis.title}\nSummary: ${analysis.summary}\n` +
  list("Highlights", analysis.highlights) + list("Risks", analysis.risks) + list("Migration", analysis.migration) +
  list("Claims", analysis.claims.map((claim) => `${claim.id}: ${claim.text} [${claim.sources.join(", ")}]`))

const evidenceText = (evidence: Evidence): string =>
  `Commits:\n${evidence.commits}\nChanged files:\n${evidence.changes}\nDocumentation:\n${evidence.documents}\n`

/**
 * The state one release is judged as, clipped so the encoded state fits.
 *
 * A release too large for one state gives up the ledger and the evidence in
 * proportion rather than one before the other: both bear on which write-up the
 * release calls for, so a ledger of four hundred claims must not crowd the
 * changed paths out of the state, nor a hundred thousand lines of diff the
 * migration steps.
 */
export const templateState = (input: ContentInput, evidence: Evidence, analysis: Analysis): TemplateState => {
  const notes = clipToBytes([input.title, input.notes].filter((part) => part !== "").join("\n"), MAX_NOTES_BYTES)
  let ledger = ledgerText(analysis), raw = evidenceText(evidence)
  for (let guard = 0; guard < 16; guard++) {
    const state: TemplateState = { version: input.version, notes, ledger, evidence: raw }
    const over = bytes(JSON.stringify(state)) - MAX_STATE_BYTES
    if (over <= 0) return state
    const total = bytes(ledger) + bytes(raw)
    if (total === 0) break
    const shrink = (value: string) =>
      clipToBytes(value, Math.max(0, bytes(value) - Math.ceil(over * (bytes(value) / total))))
    ledger = shrink(ledger)
    raw = shrink(raw)
  }
  return { version: input.version, notes, ledger: "", evidence: "" }
}

const refusal = (message: string): ReleaseError => new ReleaseError({ step: "pick-template", message })

/** The typed failure a release Jev could not answer for. It names the
 * evaluator's own code and message so a refused run says which part of the
 * transport gave out, not merely that no narrative was chosen. */
export const templateUnavailable = (input: ContentInput, failure: Classifier.ClassifierError): ReleaseError =>
  refusal(`Jev could not choose a release narrative for ${input.version}: ${failure.code} — ${failure.message}`)

/**
 * The typed failure an unsure answer becomes.
 *
 * Below the floor Jev is saying the evidence does not point at one write-up.
 * A release announced as the wrong kind of thing is worse than a release not
 * announced yet, and picking a house default would publish a claim about the
 * release that nothing in the evidence supports, so the step fails and hands
 * the operator the distribution it could not decide on. Their two honest
 * moves are both real: sharpen the evidence, or say in `notes` what this
 * release is for. Nothing falls back to the writer seat choosing.
 */
export const undecidedTemplate = (
  input: ContentInput,
  answer: Classifier.ChoiceAnswer<ReleaseTemplate>
): ReleaseError =>
  refusal(
    `Jev could not tell which release narrative fits ${input.version}: ${answer.value} at ${answer.confidence} is ` +
      `below the ${TEMPLATE_CONFIDENCE} floor. ${JSON.stringify(answer.probabilities)}. ` +
      `Sharpen the evidence or say what this release is for in notes, then run again.`
  )

/**
 * Asks Jev which write-up this release calls for.
 *
 * Jev is the only model that decides this. A host with no transport, a refused
 * gateway, a timeout and a malformed answer all fail with
 * {@link templateUnavailable}, and an answer below {@link TEMPLATE_CONFIDENCE}
 * fails with {@link undecidedTemplate}; no seat is asked instead and no
 * narrative is defaulted.
 */
export const chooseTemplate = (
  input: ContentInput,
  evidence: Evidence,
  analysis: Analysis
): Effect.Effect<TemplatePick, ReleaseError, Evaluator.Evaluator> =>
  templateClassifier.evaluate(templateState(input, evidence, analysis)).pipe(
    Effect.mapError((failure) => templateUnavailable(input, failure)),
    Effect.flatMap(({ template }) =>
      template.confidence < TEMPLATE_CONFIDENCE
        ? Effect.fail(undecidedTemplate(input, template))
        : Effect.succeed({ template: template.value, confidence: template.confidence })
    )
  )
