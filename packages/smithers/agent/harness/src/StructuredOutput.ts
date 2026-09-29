/**
 * Turning one agent's final text into a value the declared output schema
 * accepts, or into a typed failure.
 *
 * A model may answer with a bare JSON document, prose wrapped around a JSON
 * document, a fenced block, or JSON of the wrong shape. Downstream nodes must
 * never receive that ambiguity, so this module implements the recovery
 * contract in `../docs/concepts.md#structured-output`:
 *
 * 1. parse the complete, BOM-stripped response and decode it;
 * 2. otherwise scan once for balanced JSON containers, take the container
 *    whose matching close ends last, and decode that;
 * 3. otherwise report a typed {@link StructuredOutputFailure} carrying bounded
 *    diagnostics, which is what a caller re-prompts with when it still holds a
 *    correction slot.
 *
 * Every candidate is decoded by the declared schema. Extraction never relaxes
 * validation: it only decides which bytes are offered to it, and the schema may
 * accept any JSON root rather than silently requiring an object.
 *
 * The prompt half is {@link instructions}. It renders the declared schema as a
 * JSON Schema document placed in the run's system teaching, which is BAML's
 * `ctx.output_format` injection reached through the seam the vault note
 * specifies — the model is told the shape before it answers, and the answer is
 * still validated locally. Provider acceptance is not a cast.
 *
 * Reference consulted: the `generateObject` function from Effect's
 * `effect/unstable/ai/LanguageModel` module, which
 * sends `responseFormat: { type: "json", schema }` and then decodes the result
 * with the same schema, failing `AiError.InvalidOutputError` on mismatch. The
 * decode-and-fail-typed half is copied. The provider `responseFormat` half is
 * not reachable here: `@smthrs/model`'s `ModelRequest.GenerationParams` has no
 * response-format field, and the cell loop's final answer is a `Cell.Complete`
 * `output` string rather than a provider-decoded value, so the schema is
 * carried in the prompt and enforced at this boundary.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Fault from "@smthrs/flow/Fault"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as elide from "./internal/elide.ts"

/**
 * Stable reasons a structured-output boundary failed.
 *
 * `invalid_json` means candidate text was not JSON. `schema_mismatch` means
 * JSON parsed but the declared schema refused it. `no_candidate` means the
 * answer contained no candidate text. `correction_exhausted` means the
 * boundary had already spent its correction budget.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export const StructuredOutputFailureCode = Schema.Literals([
  "invalid_json",
  "schema_mismatch",
  "no_candidate",
  "correction_exhausted"
])

/**
 * Stable reasons a structured-output boundary failed.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type StructuredOutputFailureCode = typeof StructuredOutputFailureCode.Type

/**
 * Stable reasons an individual structured-output issue was reported.
 *
 * `invalid_json` means candidate text was not JSON. `no_candidate` means the
 * answer contained no candidate text. `invalid_type` means a decoded value had
 * the wrong type. `invalid_value` means a value of the expected type was still
 * invalid. `missing_key` means a required property was absent.
 * `unexpected_key` means a prohibited extra property was present. `forbidden`
 * means decoding attempted an operation the schema forbids. `one_of` means
 * more than one exclusive union member matched. `constraint` means a schema
 * check or empty-union fallback failed.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export const OutputIssueCode = Schema.Literals([
  "invalid_json",
  "no_candidate",
  "invalid_type",
  "invalid_value",
  "missing_key",
  "unexpected_key",
  "forbidden",
  "one_of",
  "constraint"
])

/**
 * Stable reasons an individual structured-output issue was reported.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type OutputIssueCode = typeof OutputIssueCode.Type

/**
 * One bounded issue raised while decoding structured output.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export class OutputIssue extends Schema.Class<OutputIssue>("flows/harness/StructuredOutput/OutputIssue")({
  /** The stable reason this issue was reported. */
  code: OutputIssueCode,
  /** The JSON path of the offending value, dot/bracket joined; empty for the root. */
  path: Schema.String,
  /** What the decoder wanted there. */
  message: Schema.String
}) {
  /** Renders the issue for existing prose-oriented consumers. */
  override toString(): string {
    return this.path === "" ? this.message : `${this.path}: ${this.message}`
  }
}

/**
 * The terminal failure of one structured-output boundary.
 *
 * It carries what an operator needs to tell two identical-looking refusals
 * apart: which schema was demanded, how many correction slots the attempt
 * consumed out of its budget, the digest of the last candidate that was
 * offered to the decoder, and the bounded issue list.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class StructuredOutputFailure extends Schema.TaggedError<StructuredOutputFailure>()(
  "/harness/StructuredOutputFailure",
  {
    /** The stable reason this boundary failed. */
    code: StructuredOutputFailureCode,
    /** The declared output schema's canonical digest. */
    schema: Schema.String,
    /** SHA-256 of the text the decoder was last offered. */
    candidate: Schema.String,
    /** Correction attempts already spent on this boundary. */
    corrections: Schema.Number,
    /** The correction budget the boundary was declared with. */
    limit: Schema.Number,
    /** At most {@link maxIssues} structured validation issues. */
    issues: Schema.Array(OutputIssue),
    message: Schema.String
  }
) {}
// The model's answer did not fit the declared shape: another model may answer it.
Fault.register("/harness/StructuredOutputFailure", "dependency")

/**
 * The most validation issues a failure or a correction prompt carries.
 *
 * Bounded for the same reason smithers bounds its own validation summary: a
 * wide struct that mismatched everywhere would otherwise spend the correction
 * prompt's whole budget restating the schema back to the model.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxIssues = 5

/**
 * The JSON Schema document for a declared output schema.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const jsonSchema = (schema: Schema.Top): unknown => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  return Object.keys(document.definitions).length > 0
    ? { ...document.schema, $defs: document.definitions }
    : document.schema
}

/**
 * The canonical digest of a declared output schema.
 *
 * Two declarations that render the same JSON Schema name the same boundary, so
 * this is what a step key folds in rather than the schema value itself.
 *
 * @category identity
 * @since 0.1.0
 * @slop
 */
export const digest = (schema: Schema.Top): string => Digest.digest(Digest.canonical(jsonSchema(schema)))

/**
 * The system teaching that tells a run what its final `output` must be.
 *
 * Written against the cell contract: a cell finishes by calling
 * `ctx.done(output)`, and the sandbox rejects a returned transition, so the
 * instruction is about the argument of that call and not about the assistant
 * message around it. The run passes the value itself: a structured value
 * reaches {@link decode} as canonical JSON, and a string as its own text.
 *
 * @category prompts
 * @since 0.1.0
 * @slop
 */
export const instructions = (schema: Schema.Top): string =>
  `## Required output shape

Finish by calling \`ctx.done(output)\` with the value itself: a JavaScript
value that validates against this JSON Schema, such as
\`ctx.done({ ...fields })\`. Do not stringify it, and add no prose around it.

\`\`\`json
${JSON.stringify(jsonSchema(schema), null, 2)}
\`\`\``

/**
 * The digest of one failure's rendered validation issues.
 *
 * Two rejections that raised the same issues share this digest, which is what a
 * record carries instead of the issues themselves: a journal that repeated the
 * validator's prose for every correction would grow with the model's verbosity,
 * and what an operator actually asks is whether the second answer was wrong the
 * same way as the first.
 *
 * @category identity
 * @since 0.1.0
 */
export const issuesDigest = (failure: StructuredOutputFailure): string =>
  Digest.digest(
    Digest.canonical(failure.issues.map((issue) => ({ path: issue.path, message: issue.message })))
  )

/**
 * The correction teaching appended when a candidate failed to decode.
 *
 * It restates the schema and the bounded diagnostics and nothing else: a
 * correction does not reinterpret the task, so the original prompt is repeated
 * verbatim by the caller and only this section is new.
 *
 * @category prompts
 * @since 0.1.0
 * @slop
 */
export const correction = (failure: StructuredOutputFailure): string =>
  `## Your previous answer did not validate

The output you passed to \`ctx.done\` could not be decoded against the required
schema. Call \`ctx.done(output)\` again with the same information as a value
that validates.

Validation issues:
${failure.issues.map((issue) => `- ${issue}`).join("\n")}`

const stripBom = (text: string): string => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

/**
 * The balanced JSON container whose matching close ends last.
 *
 * Scans once, left to right, tracking object and array delimiters, quoted
 * strings, and escapes. A mismatched close abandons the open container rather
 * than pairing it with the wrong opener, so a truncated prefix cannot be
 * reported as a complete document. `undefined` means the text holds no
 * balanced container at all.
 *
 * This is the array-capable form of smithers' `extractLastBalancedJson`, which
 * is object-only.
 *
 * @category extraction
 * @since 0.1.0
 * @slop
 */
export const lastBalanced = (text: string): string | undefined => {
  const stack: Array<string> = []
  let start = -1
  let found: string | undefined = undefined
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") quoted = false
      continue
    }
    if (char === "\"") {
      if (stack.length > 0) quoted = true
      continue
    }
    if (char === "{" || char === "[") {
      if (stack.length === 0) start = index
      stack.push(char)
      continue
    }
    if (char === "}" || char === "]") {
      const opener = stack.pop()
      if (opener === undefined) continue
      if ((char === "}") !== (opener === "{")) {
        // Mismatched close: abandon the whole open container rather than
        // reporting a pairing the text does not contain.
        stack.length = 0
        start = -1
        continue
      }
      if (stack.length === 0 && start >= 0) found = text.slice(start, index + 1)
    }
  }
  return found
}

/**
 * The candidates offered to the decoder, in the declared recovery order.
 *
 * @category extraction
 * @since 0.1.0
 * @slop
 */
export const candidates = (text: string): ReadonlyArray<string> => {
  const stripped = stripBom(text).trim()
  const balanced = lastBalanced(stripped)
  return balanced === undefined || balanced === stripped ? [stripped] : [stripped, balanced]
}

const issueMessage = (message: string): string => elide.head(message, 240, "reissue the answer to see the whole issue")

const issuePath = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((segment, index) =>
    typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`
  ).join("")

type FormattedIssue = {
  readonly message: string
  readonly path: ReadonlyArray<PropertyKey>
}

const issueCodeSeparator = "\u0000"

const leafCodes: Record<SchemaIssue.Leaf["_tag"], OutputIssueCode> = {
  InvalidType: "invalid_type",
  InvalidValue: "invalid_value",
  MissingKey: "missing_key",
  UnexpectedKey: "unexpected_key",
  Forbidden: "forbidden",
  OneOf: "one_of"
}

const formatSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => `${issue._tag}${issueCodeSeparator}${SchemaIssue.defaultLeafHook(issue)}`
})

const schemaIssuesOf = (error: Schema.SchemaError): ReadonlyArray<OutputIssue> =>
  (formatSchemaIssues(error.issue).issues as ReadonlyArray<FormattedIssue>).slice(0, maxIssues).map((issue) => {
    const separator = issue.message.indexOf(issueCodeSeparator)
    const tagged = separator >= 0
    return new OutputIssue({
      code: tagged ? leafCodes[issue.message.slice(0, separator) as SchemaIssue.Leaf["_tag"]] : "constraint",
      path: issuePath(issue.path),
      message: issueMessage(tagged ? issue.message.slice(separator + issueCodeSeparator.length) : issue.message)
    })
  })

const textIssuesOf = (code: OutputIssueCode, message: string): ReadonlyArray<OutputIssue> =>
  message.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).slice(0, maxIssues).map((line) =>
    new OutputIssue({ code, path: "", message: issueMessage(line) })
  )

const quoted = (text: string): boolean => {
  try {
    return typeof JSON.parse(text) === "string"
  } catch {
    return false
  }
}

/**
 * Decodes one agent answer with the declared output schema.
 *
 * Tries every {@link candidates} entry in order and returns the first the
 * schema accepts, then the answer itself, untrimmed, as a string unless it is
 * a JSON string literal, which is how a `ctx.done("text")` answer reaches a
 * string schema. When none does, the failure reports the issues raised by the
 * LAST candidate, which is the narrowest text the extractor could isolate and
 * therefore the one a correction prompt should be about.
 *
 * @category decoding
 * @since 0.1.0
 * @slop
 */
export const decode = <S extends Schema.Top>(
  schema: S,
  text: string,
  attempt: { readonly corrections: number; readonly limit: number }
): Effect.Effect<S["Type"], StructuredOutputFailure, S["DecodingServices"]> =>
  Effect.gen(function*() {
    const offered = candidates(text)
    const decoder = Schema.decodeUnknownEffect(schema)
    let code: StructuredOutputFailureCode = "no_candidate"
    let issues: ReadonlyArray<OutputIssue> = [
      new OutputIssue({ code: "no_candidate", path: "", message: "the answer held no JSON document" })
    ]
    for (const candidate of offered) {
      if (candidate.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate)
      } catch (error) {
        code = "invalid_json"
        // The ECMAScript JSON parser throws a SyntaxError with a message.
        issues = textIssuesOf("invalid_json", (error as SyntaxError).message)
        continue
      }
      const result = yield* Effect.result(decoder(parsed))
      if (result._tag === "Success") return result.success
      code = "schema_mismatch"
      issues = schemaIssuesOf(result.failure)
    }
    // `ctx.done("text")` reaches the boundary as the text itself, not as a
    // JSON string, so a schema that accepts the raw answer takes it as it is.
    // An answer that is a whole JSON string literal already said which string
    // it meant, and its quotes are not part of it.
    // Untrimmed, so an empty or whitespace-bearing string arrives as written.
    const raw = stripBom(text)
    if (!quoted(offered[0]!)) {
      const result = yield* Effect.result(decoder(raw))
      if (result._tag === "Success") return result.success
    }
    return yield* new StructuredOutputFailure({
      // Once the budget is spent, exhaustion is the actionable classification;
      // the issue records retain whether the last candidate was invalid JSON or
      // failed schema decoding.
      code: attempt.corrections >= attempt.limit ? "correction_exhausted" : code,
      schema: digest(schema),
      candidate: Digest.digest(offered[offered.length - 1]!),
      corrections: attempt.corrections,
      limit: attempt.limit,
      issues,
      message:
        `The agent's answer did not validate against its declared output schema after ${attempt.corrections} of ${attempt.limit} corrections`
    })
  })
