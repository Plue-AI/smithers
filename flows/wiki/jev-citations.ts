/** Jev judges whether each cited excerpt actually supports the claim it was
 * cited for. Exact assessment already proves a citation's quote is really on
 * that line of that file; it cannot tell whether the line has anything to do
 * with the sentence it is attached to. That judgement has three answers and
 * Jev gives it, one (claim, citation) pair at a time. */
import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Result, Schema } from "effect"
import { batches } from "../repository/jev-checks.ts"
import { visibleLine } from "./evidence.ts"
import { type Evidence, type Review, WikiError } from "./schema.ts"

/**
 * At or above this confidence a `contradicts` or `unrelated` answer makes the
 * citation unsupported, and a `supports` answer makes it supported.
 *
 * This is the review policy's decision threshold, not a calibrated guarantee
 * about whichever subscription model the host resolves. Lower confidence is
 * recorded as `uncertain` rather than counted either way.
 */
export const UNSUPPORTED_CONFIDENCE = 0.8
/** The most bytes one state may take, matching `@smthrs/std`'s per-state bound. */
export const MAX_STATE_BYTES = 32 * 1024
/** The most bytes of the claim one state carries; the excerpt takes the rest. */
export const MAX_CLAIM_BYTES = 8 * 1024
/** How many source lines either side of the cited line the excerpt carries, so
 * a claim is judged against the line in the context the reviewer saw it in. */
export const CITATION_CONTEXT_LINES = 8

/** One (claim, citation) pair as the classifier sees it. */
export const CitationState = Schema.Struct({
  claim: Schema.String.annotate({ description: "The claim the page makes, as its own section states it" }),
  source: Schema.Struct({
    path: Schema.String.annotate({ description: "The cited file's repository-relative path" }),
    excerpt: Schema.String.annotate({
      description: "The cited source text with its 1-based line numbers, clipped so the whole state stays under 32 KiB"
    })
  }).annotate({ description: "The source the claim cites" })
})
export type CitationState = typeof CitationState.Type

/** The one question every citation answers. */
export const citationClassifier = Classifier.make("citation/support", {
  description:
    "Judge one cited source excerpt against the one claim it is cited for: does the excerpt support that claim?",
  state: CitationState,
  questions: {
    support: Classifier.choice({
      instructions: "Does this source excerpt support the claim it is cited for?",
      criteria: {
        supports: "the excerpt states or directly implies the claim",
        contradicts: "the excerpt states the opposite",
        unrelated: "the excerpt does not bear on the claim"
      }
    })
  }
})

/** What Jev may answer about one citation. */
export const CitationChoice = Schema.Literals(["supports", "contradicts", "unrelated"])
/** What one citation, or a whole page of them, comes to. */
export const CitationOutcome = Schema.Literals(["supported", "unsupported", "uncertain"])
export const CitationVerdict = Schema.Struct({
  section: Schema.String,
  path: Schema.String,
  line: Schema.Int,
  quote: Schema.String,
  choice: CitationChoice,
  confidence: Schema.Number,
  outcome: CitationOutcome
})
export type CitationVerdict = typeof CitationVerdict.Type
export const PageCitations = Schema.Struct({ verdict: CitationOutcome, citations: Schema.Array(CitationVerdict) })
export type PageCitations = typeof PageCitations.Type

/** One citation, the claim it is attached to, and the state Jev is asked about. */
export interface CitationRequest {
  readonly section: string
  readonly path: string
  readonly line: number
  readonly quote: string
  readonly state: CitationState
}

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

/** The cited line with its neighbours, numbered the way the reviewer saw them.
 * A line the page's excerpts hid is not evidence, so it is not shown here
 * either. */
export const citationExcerpt = (evidence: Evidence, path: string, line: number): string => {
  const source = evidence.sources.find((entry) => entry.path === path)
  if (!source) return ""
  const lines = source.text.split("\n")
  const first = Math.max(1, line - CITATION_CONTEXT_LINES)
  const last = Math.min(lines.length, line + CITATION_CONTEXT_LINES)
  const shown: Array<string> = []
  for (let index = first; index <= last; index++) {
    if (visibleLine(evidence, path, index)) shown.push(`${index} | ${lines[index - 1]!}`)
  }
  return shown.join("\n")
}

/** The claim and its excerpt, both clipped so the encoded state fits. */
const fitted = (claim: string, path: string, excerpt: string): CitationState => {
  let text = clipToBytes(claim, MAX_CLAIM_BYTES), shown = excerpt
  for (let guard = 0; guard < 16; guard++) {
    const framed: CitationState = { claim: text, source: { path, excerpt: shown } }
    const over = bytes(JSON.stringify(framed)) - MAX_STATE_BYTES
    if (over <= 0) return framed
    if (shown !== "") shown = clipToBytes(shown, Math.max(0, bytes(shown) - over))
    else text = clipToBytes(text, Math.max(0, bytes(text) - over))
  }
  return { claim: "", source: { path, excerpt: "" } }
}

/** Every (claim, citation) pair one reviewed page puts to Jev, in review order.
 * The claim is the section's own Markdown, which is the unit the reviewer
 * attached the citation to. */
export const citationRequests = (evidence: Evidence, review: Review): ReadonlyArray<CitationRequest> => {
  const claims = new Map(evidence.sections.map((section) => [section.id, section.markdown]))
  const found: Array<CitationRequest> = []
  for (const section of review.sections) {
    const claim = claims.get(section.id) ?? ""
    for (const citation of section.citations) {
      found.push({
        section: section.id,
        path: citation.path,
        line: citation.line,
        quote: citation.quote,
        state: fitted(claim, citation.path, citationExcerpt(evidence, citation.path, citation.line))
      })
    }
  }
  return found
}

/** One answer per citation becomes one verdict, and the page takes the worst
 * of them: unsupported when any citation is, uncertain when any is unsure and
 * none is unsupported, supported only when every one is. */
export const citationVerdicts = (
  requests: ReadonlyArray<CitationRequest>,
  answers: ReadonlyArray<{ readonly support: Classifier.ChoiceAnswer<typeof CitationChoice.Type> }>
): PageCitations => {
  const citations = requests.map((request, index): CitationVerdict => {
    const support = answers[index]!.support
    const outcome = support.confidence < UNSUPPORTED_CONFIDENCE ?
      "uncertain" as const
      : support.value === "supports"
      ? "supported" as const
      : "unsupported" as const
    return {
      section: request.section,
      path: request.path,
      line: request.line,
      quote: request.quote,
      choice: support.value,
      confidence: support.confidence,
      outcome
    }
  })
  const verdict = citations.some((citation) => citation.outcome === "unsupported") ?
    "unsupported" as const
    : citations.some((citation) => citation.outcome === "uncertain")
    ? "uncertain" as const
    : "supported" as const
  return { verdict, citations }
}

/** The typed failure a citation Jev could not answer becomes. It names the
 * evaluator's own code so a refused run says which part of the transport gave
 * out, not merely that the page was not checked. */
export const citationCheckUnavailable = (evidence: Evidence, failure: Classifier.ClassifierError): WikiError =>
  new WikiError({
    code: "citation-check-unavailable",
    message: `Jev could not check the citations of ${evidence.spec.id}: ${failure.code} — ${failure.message}`
  })

/** The refusal an unsupported page becomes, naming the citations that earned
 * it the way exact assessment names the ones that are not really there. */
export const unsupportedCitations = (evidence: Evidence, page: PageCitations): WikiError => {
  const failing = page.citations.filter((citation) => citation.outcome === "unsupported")
  return new WikiError({
    code: "review-failed",
    message: `Review citation does not support its claim: ${evidence.spec.id}/${failing[0]!.section}; ` +
      JSON.stringify({
        unsupportedCitationCount: failing.length,
        citations: failing.slice(0, 24).map((citation) => ({
          section: citation.section.slice(0, 80),
          path: citation.path.slice(0, 320),
          line: citation.line,
          quote: citation.quote.slice(0, 320),
          choice: citation.choice,
          confidence: citation.confidence
        }))
      })
  })
}

/**
 * Asks Jev about every citation of one reviewed page and reports what it
 * decided.
 *
 * Jev is the only model that answers this: a host with no transport, a refused
 * provider, a timeout and a malformed answer all fail the call with
 * {@link citationCheckUnavailable}, so a page is never published unchecked and
 * no frontier seat is asked to make the judgement instead. An unsure answer is
 * different: that is Jev deciding it cannot tell, and it rides along as an
 * `uncertain` verdict.
 */
export const checkCitations = (
  evidence: Evidence,
  review: Review
): Effect.Effect<PageCitations, WikiError, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const requests = citationRequests(evidence, review)
    if (!requests.length) return { verdict: "supported" as const, citations: [] }
    const answered = yield* Effect.forEach(batches(requests), (batch) =>
      citationClassifier.evaluateAll(batch.map((request) => request.state)), { concurrency: 1 })
    const answers: Array<{ readonly support: Classifier.ChoiceAnswer<typeof CitationChoice.Type> }> = []
    for (const answer of answered.flat()) {
      if (Result.isFailure(answer)) {
        return yield* Effect.fail(citationCheckUnavailable(evidence, answer.failure))
      }
      answers.push(answer.success)
    }
    return citationVerdicts(requests, answers)
  })
