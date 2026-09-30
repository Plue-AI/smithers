/** Required security review as a registered check. The trusted review policy
 * (the `LlmLint` rows of the target index) is read from the commit the change
 * applies to, the source from the change's immutable head, both through the
 * native tree export, so no Git directory is needed. Every model request runs
 * on the host's subscription seats (`claude-code:<model>`, `codex:<model>`),
 * never an API key. Findings stay in the host's private finding store; the
 * receipt carries only their public summaries. */
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import type * as LlmLint from "@smthrs/targets/LlmLint"
import { Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Label from "../../packages/smithers/build/build-cli/src/Label.ts"
import * as TrustedReview from "../../packages/smithers/build/build-cli/src/TrustedReview.ts"
import { privatePath } from "../repository/check-context.ts"
import { type ImmutableSourceOptions, withImmutableCommit, withImmutableSource } from "./immutable-source.ts"
import { Check, checkInputDigest, CodingError, type Finding, Implementation, Receipt } from "./schema.ts"

/** The registered Markdown flow's verified body, as its first nonempty line: the review labels it applies. */
export const Body = Schema.Struct({
  patterns: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(512))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16)
  )
})

/** The subscription seat one review seat runs on: Claude Code for Claude models, Codex for OpenAI models. */
export const subscriptionSeat = (seat: LlmLint.ReviewSeat): string =>
  seat.engine === "claude" ? `claude-code:${seat.model}` : `codex:${seat.model}`

/** The review transport over the host's seat resolver. */
export const seatTransport = (resolver: SeatResolver.Service): LlmLint.ReviewTransport => (seat) =>
  resolver.resolve(subscriptionSeat(seat)).pipe(
    Effect.map((resolved) => ({ model: resolved.model, modelId: resolved.modelId })),
    Effect.mapError((error) => new Error(error.message))
  )

/** What the receipt's evidence records: labels, statuses and public finding summaries, never a finding's text. */
export interface SecurityReviewEvidence {
  readonly kind: "coding/security-review-check/v1"
  readonly policyRevision: string
  readonly revision: string
  readonly changed: number
  readonly reviews: ReadonlyArray<{
    readonly label: string
    readonly status: "completed" | "failed"
    readonly findings: ReadonlyArray<LlmLint.PublicSummary>
    readonly error?: string
  }>
}

const Input = Schema.Struct({ implementation: Implementation, check: Check })
/** Why a change with nothing to review fails. */
export const emptyChange = "The change has no reviewable path; a required security review cannot pass"
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })

/** Reviews one implementation; the whole review is one durable action whose finding store resumes it. */
export const ReviewSecurity = Action.make("coding/review-security", {
  // Invocation includes the pinned body, so a label change changes the action key.
  payload: Executable.Invocation,
  success: Receipt,
  error: CodingError,
  nondeterministic: true
})
/** Ordinary registered check delegate for `flows/checks/security`. */
export const securityReviewCheckDelegate = Flow.make("coding/SecurityReviewCheck", {
  payload: Executable.Invocation,
  success: Receipt,
  error: CodingError,
  body: (invocation) => ReviewSecurity.call(invocation)
})

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/**
 * One exported tree as a {@link TrustedReview.ReviewSource} revision: every
 * entry by its repository path, its identity its kind, executable bit and
 * content digest. A private repository-job path never enters a review.
 */
const listTree = async (root: string): Promise<Map<string, TrustedReview.SourceEntry>> => {
  const entries = new Map<string, TrustedReview.SourceEntry>()
  const found = await NodeFs.readdir(root, { withFileTypes: true, recursive: true })
  for (
    const dirent of found.sort((left, right) =>
      left.parentPath === right.parentPath
        ? (left.name < right.name ? -1 : 1)
        : (left.parentPath < right.parentPath ? -1 : 1)
    )
  ) {
    if (dirent.isDirectory()) continue
    const absolute = NodePath.join(dirent.parentPath, dirent.name)
    const path = NodePath.relative(root, absolute).split(NodePath.sep).join("/")
    if (privatePath(path)) continue
    if (dirent.isFile()) {
      const executable = ((await NodeFs.stat(absolute)).mode & 0o111) !== 0
      entries.set(path, {
        id: `file:${executable ? 755 : 644}:${sha256(await NodeFs.readFile(absolute))}`,
        regular: true
      })
    } else {
      entries.set(path, {
        id: dirent.isSymbolicLink() ? `link:${await NodeFs.readlink(absolute)}` : "other",
        regular: false
      })
    }
  }
  return entries
}

/** Reads the trees exported at `roots` (revision → export directory) as a review source. */
export const exportedSource = (roots: Readonly<Record<string, string>>): TrustedReview.ReviewSource => {
  const trees = new Map<string, Promise<Map<string, TrustedReview.SourceEntry>>>()
  const tree = (revision: string) => {
    const root = roots[revision]
    if (root === undefined) return Promise.reject(new Error("The review read a revision it did not export"))
    let listed = trees.get(revision)
    if (listed === undefined) trees.set(revision, listed = listTree(root))
    return listed
  }
  const bytes = async (revision: string, path: string, limit: number) => {
    const absolute = NodePath.join(roots[revision]!, ...path.split("/"))
    if ((await NodeFs.stat(absolute)).size > limit) throw new Error("A review file exceeds its size limit")
    return NodeFs.readFile(absolute)
  }
  return {
    tree,
    read: async (revision, path, _entry, limit) =>
      new TextDecoder("utf-8", { fatal: true }).decode(await bytes(revision, path, limit)),
    grep: async (revision, patterns, candidate) => {
      const expressions = patterns.map((pattern) => new RegExp(pattern))
      const matched: Array<string> = []
      for (const [path, entry] of await tree(revision)) {
        if (!entry.regular || !candidate(path)) continue
        const contents = await bytes(revision, path, Number.MAX_SAFE_INTEGER)
        // Binary files never match, as `git grep -I` skips them.
        if (contents.includes(0)) continue
        const text = new TextDecoder().decode(contents)
        if (expressions.some((expression) => expression.test(text))) matched.push(path)
      }
      return matched
    }
  }
}

/**
 * The commit the change applies to: the implementation's parent, or for a
 * verified stack candidate (parent and head are the one retained commit) the
 * commit it was rebased onto.
 */
export const reviewBase = (implementation: Implementation): string | undefined =>
  implementation.parent.commitId !== implementation.head.commitId
    ? implementation.parent.commitId
    : implementation.head.parentCommitIds.length === 1
    ? implementation.head.parentCommitIds[0]
    : undefined

type Reviewed = Awaited<ReturnType<typeof TrustedReview.reviewPrepared>>

/** One receipt from the reviews: passed only when every selected review completed with no blocking finding. */
export const receipt = (
  implementation: Implementation,
  check: Check,
  prepared: Pick<TrustedReview.Prepared, "policyRevision" | "revision" | "changed">,
  reviewed: Reviewed | undefined,
  refused?: string
): Receipt => {
  const finding = (message: string): Finding => ({
    owner: implementation.change,
    sourceCommitId: implementation.head.commitId,
    message: message.slice(0, 2_000)
  })
  const reviews: Array<SecurityReviewEvidence["reviews"][number]> = (reviewed?.reviews ?? []).map((review) => {
    if (review.status === "completed") return { label: review.label, status: review.status, findings: review.findings }
    const error = review.error
    return "findings" in error
      ? { label: review.label, status: review.status, findings: error.findings }
      : { label: review.label, status: review.status, findings: [], error: error.message.slice(0, 1_000) }
  })
  const findings = refused !== undefined ?
    [finding(refused)] :
    reviews.flatMap((review) =>
      review.status === "completed" ? [] : review.error !== undefined
        ? [finding(`${review.label}: the security review did not complete: ${review.error}`)]
        : review.findings.map((summary) =>
          finding(
            [review.label + ":", summary.reference, summary.severity, summary.checkId, summary.impact]
              .filter((part) => part !== undefined).join(" ")
          )
        )
    )
  const evidence: SecurityReviewEvidence = {
    kind: "coding/security-review-check/v1",
    policyRevision: prepared.policyRevision,
    revision: prepared.revision,
    changed: prepared.changed.length,
    reviews
  }
  // A blocking finding is a real red; a review that could not finish resumes from its store on retry.
  const blocked = refused !== undefined || reviews.some((review) => review.status === "failed" && !review.error)
  return {
    checkId: check.id,
    target: check.target,
    tier: check.tier,
    change: implementation.change,
    commitId: implementation.head.commitId,
    treeId: implementation.head.treeId,
    inputDigest: checkInputDigest(implementation, check),
    status: findings.length === 0 ? "passed" : "failed",
    ...(findings.length === 0 ? {} : { fault: blocked ? "factory" as const : "infra" as const }),
    evidence: JSON.stringify(evidence),
    findings
  }
}

/** Host inputs: the immutable export and the private directory findings persist in. */
export type SecurityReviewOptions = ImmutableSourceOptions & {
  /** Absolute private directory for runs and findings, outside the repository. */
  readonly store: string
}

/** Reads the change, runs every governing trusted review on the host's seats, and returns the public receipt. */
export const reviewSecurity = (options: SecurityReviewOptions, invocation: typeof Executable.Invocation.Type) =>
  Effect.gen(function*() {
    const { implementation, check } = yield* Schema.decodeUnknownEffect(Input)(invocation.input)
      .pipe(Effect.mapError(() => invalid("Check input must identify the implemented revision and declared check")))
    if (invocation.flow !== check.flow) return yield* invalid("The registered check flow does not match the plan")
    const { patterns } = yield* Effect.try({
      try: () => JSON.parse(invocation.prompt.trimStart().split(/\r?\n/, 1)[0] ?? "") as unknown,
      catch: () => invalid("The registered security check body must be a JSON label declaration")
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Body)),
      Effect.flatMap((body) =>
        Effect.try({
          try: () => ({ patterns: body.patterns.map((pattern) => Label.parse(pattern, "")) }),
          catch: () => undefined
        })
      ),
      Effect.mapError(() => invalid("The registered security check body needs 1 to 16 review target labels"))
    )
    const base = reviewBase(implementation)
    if (base === undefined) return yield* invalid("The security review needs the one commit the change applies to")
    const resolver = yield* SeatResolver.SeatResolver
    return yield* withImmutableSource(
      options,
      implementation.head,
      (_head, headRoot) =>
        withImmutableCommit(options, base, (_base, baseRoot) =>
          Effect.tryPromise({
            try: async () => {
              const source = exportedSource({ [base]: baseRoot, [implementation.head.commitId]: headRoot })
              const prepared = TrustedReview.governing(
                await TrustedReview.prepareSource(source, {
                  policyRevision: base,
                  revision: implementation.head.commitId,
                  patterns,
                  required: true
                })
              )
              // A change with no reviewable path (none, or only private job paths) has nothing a required review could pass on.
              if (prepared.changed.length === 0) {
                return receipt(implementation, check, prepared, undefined, emptyChange)
              }
              const reviewed = await TrustedReview.reviewPrepared(prepared, {
                root: headRoot,
                findingsStore: options.store,
                transport: seatTransport(resolver)
              })
              return receipt(implementation, check, prepared, reviewed)
            },
            catch: (cause) =>
              new CodingError({
                code: "execution",
                message: `The security review could not read its policy or source: ${
                  (cause instanceof Error ? cause.message : String(cause)).slice(0, 1_024)
                }`
              })
          }))
    )
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CodingError ? error : new CodingError({
        code: "execution",
        message: "The security review could not export its source" +
          (error instanceof Error ? `: ${error.message.slice(0, 1_024)}` : "")
      })
    )
  )

/** Supply this layer to the native action table and register {@link securityReviewCheckDelegate}. */
export const securityReviewCheckLayers = (options: SecurityReviewOptions) =>
  Layer.mergeAll(
    Interpreter.layer(securityReviewCheckDelegate),
    ReviewSecurity.toLayer((invocation) => reviewSecurity(options, invocation))
  )
