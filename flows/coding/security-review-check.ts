/** Required security review as a registered check. The trusted review policy
 * (the `LlmLint` rows of the target index) is read from the commit the change
 * applies to, the source from the change's immutable head, both through the
 * native tree export, so no Git directory is needed. Every model request runs
 * on a tool-free subscription seat (Claude Code, or Codex without the Smithers
 * MCP server), never an API key. Findings stay in the host's private finding store; the
 * receipt carries only their public summaries. `coding/SecurityAudit` runs the
 * scheduled audits the same way over one whole commit. */
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type * as Model from "@smthrs/model/Model"
import * as Executable from "@smthrs/registry/Executable"
import * as LlmLint from "@smthrs/targets/LlmLint"
import { Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Label from "../../packages/smithers/build/build-cli/src/Label.ts"
import * as TrustedReview from "../../packages/smithers/build/build-cli/src/TrustedReview.ts"
import * as CodexCode from "../../packages/smithers/src/internal/CodexCode.ts"
import * as Providers from "../../packages/smithers/src/Providers.ts"
import { privatePath } from "../repository/check-context.ts"
import { type ImmutableSourceOptions, withImmutableCommit, withImmutableSource } from "./immutable-source.ts"
import { NativeCoding } from "./native.ts"
import { Check, checkInputDigest, CodingError, Implementation, Receipt } from "./schema.ts"

/** The registered Markdown flow's verified body, as its first nonempty line: the review labels it applies. */
export const Body = Schema.Struct({
  patterns: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(512))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16)
  )
})

/** A Codex review seat: the model it runs, or why it cannot. */
export type CodexSeat = (
  model: string
) => Effect.Effect<{ readonly model: Model.Model; readonly modelId: string }, Error>

/**
 * The Codex subscription seat without its Smithers MCP server. Reviewed source
 * is untrusted, so the reviewer gets no tools: the ordinary `codex:` seat
 * loads Smithers MCP for agent cells, so this builds the same seat model with
 * `mcp: false` over the machine's own `codex login`.
 */
export const toolFreeCodex = (environment: Readonly<Record<string, string | undefined>>): CodexSeat => (model) =>
  Effect.promise(() => Providers.codexLogin(environment)).pipe(
    Effect.flatMap((login) =>
      login?.loggedIn === true
        ? Effect.succeed({
          model: CodexCode.make({
            model: Providers.codexModel(model),
            executable: login.executable,
            environment,
            mcp: false
          }),
          modelId: Providers.codexModel(model)
        })
        : Effect.fail(new Error("Codex is not signed in with ChatGPT; run `codex login --device-auth`"))
    )
  )

/**
 * The review transport: Claude models on the host's Claude Code seat
 * (`claude-code:<model>`, which runs no tools or MCP servers), OpenAI models
 * on the tool-free Codex seat.
 */
export const seatTransport = (resolver: SeatResolver.Service, codex: CodexSeat): LlmLint.ReviewTransport => (seat) =>
  seat.engine === "codex" ? codex(seat.model) : resolver.resolve(`claude-code:${seat.model}`).pipe(
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
/** Why a change no selected review governs fails: it would otherwise pass unreviewed. */
export const ungoverned = "No selected security review governs the change; it cannot pass unreviewed"
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

/** A file's SHA-256, streamed so a large committed artifact is never held in memory. */
const sha256 = async (path: string, signal: AbortSignal | undefined) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path, signal === undefined ? {} : { signal })) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/**
 * One exported tree as a {@link TrustedReview.ReviewSource} revision: every
 * entry by its repository path, its identity its kind, executable bit and
 * content digest. A private repository-job path never enters a review.
 */
const listTree = async (
  root: string,
  signal: AbortSignal | undefined
): Promise<Map<string, TrustedReview.SourceEntry>> => {
  const entries = new Map<string, TrustedReview.SourceEntry>()
  const found = await NodeFs.readdir(root, { withFileTypes: true, recursive: true })
  for (
    const dirent of found.sort((left, right) =>
      left.parentPath === right.parentPath
        ? (left.name < right.name ? -1 : 1)
        : (left.parentPath < right.parentPath ? -1 : 1)
    )
  ) {
    signal?.throwIfAborted()
    if (dirent.isDirectory()) continue
    const absolute = NodePath.join(dirent.parentPath, dirent.name)
    const path = NodePath.relative(root, absolute).split(NodePath.sep).join("/")
    if (privatePath(path)) continue
    if (dirent.isFile()) {
      const executable = ((await NodeFs.stat(absolute)).mode & 0o111) !== 0
      entries.set(path, {
        id: `file:${executable ? 755 : 644}:${await sha256(absolute, signal)}`,
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

/** Reads the trees exported at `roots` (revision → export directory) as a review source; `signal` stops it. */
export const exportedSource = (
  roots: Readonly<Record<string, string>>,
  signal?: AbortSignal
): TrustedReview.ReviewSource => {
  const trees = new Map<string, Promise<Map<string, TrustedReview.SourceEntry>>>()
  const tree = (revision: string) => {
    const root = roots[revision]
    if (root === undefined) return Promise.reject(new Error("The review read a revision it did not export"))
    let listed = trees.get(revision)
    if (listed === undefined) trees.set(revision, listed = listTree(root, signal))
    return listed
  }
  const bytes = async (revision: string, path: string, limit: number) => {
    signal?.throwIfAborted()
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
        // A file past the review limit cannot be a reviewed caller.
        const contents = await bytes(revision, path, LlmLint.maximumReviewFileBytes).catch(() => undefined)
        if (contents === undefined) continue
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

/**
 * Why a review did not finish, in fixed public words: a diagnostic can name
 * reviewed files or host paths, so only its kind leaves the host.
 */
export const unfinished = (message: string): string =>
  message.startsWith("Review seat unavailable") ?
    "a review seat is unavailable" :
    message.startsWith("Review budget exhausted") ?
    "its budget is exhausted" :
    message.startsWith("Review incomplete") ?
    "batches remain; the next run resumes them" :
    message.startsWith("Required review selected no files") ?
    "it selected no file" :
    message === "Review provider refused the request" ?
    "the model refused it" :
    message === "The review response could not be used; see the private run record" ?
    "a model answer could not be used" :
    "it failed; see the private run record"

/**
 * The public outcome of a set of reviews: one message per public finding
 * summary or unfinished review, and whether a finding (not an outage) failed it.
 */
export const summarize = (
  prepared: Pick<TrustedReview.Prepared, "policyRevision" | "revision" | "changed">,
  reviewed: Reviewed | undefined,
  refused?: string
) => {
  const reviews: Array<SecurityReviewEvidence["reviews"][number]> = (reviewed?.reviews ?? []).map((review) => {
    if (review.status === "completed") return { label: review.label, status: review.status, findings: review.findings }
    const error = review.error
    return "findings" in error
      ? { label: review.label, status: review.status, findings: error.findings }
      : { label: review.label, status: review.status, findings: [], error: unfinished(error.message) }
  })
  const messages = refused !== undefined ?
    [refused] :
    reviews.flatMap((review) =>
      review.status === "completed" ? [] : review.error !== undefined
        ? [`${review.label}: the security review did not complete: ${review.error}`]
        : review.findings.map((summary) =>
          [review.label + ":", summary.reference, summary.severity, summary.checkId, summary.impact]
            .filter((part) => part !== undefined).join(" ")
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
  return { evidence, messages, blocked }
}

/** One receipt from the reviews: passed only when every selected review completed with no blocking finding. */
export const receipt = (
  implementation: Implementation,
  check: Check,
  prepared: Pick<TrustedReview.Prepared, "policyRevision" | "revision" | "changed">,
  reviewed: Reviewed | undefined,
  refused?: string
): Receipt => {
  const { evidence, messages, blocked } = summarize(prepared, reviewed, refused)
  return {
    checkId: check.id,
    target: check.target,
    tier: check.tier,
    change: implementation.change,
    commitId: implementation.head.commitId,
    treeId: implementation.head.treeId,
    inputDigest: checkInputDigest(implementation, check),
    status: messages.length === 0 ? "passed" : "failed",
    ...(messages.length === 0 ? {} : { fault: blocked ? "factory" as const : "infra" as const }),
    evidence: JSON.stringify(evidence),
    findings: messages.map((message) => ({
      owner: implementation.change,
      sourceCommitId: implementation.head.commitId,
      message: message.slice(0, 2_000)
    }))
  }
}

/** The review labels the registered body's first line declares, parsed as target patterns. */
const bodyPatterns = (invocation: typeof Executable.Invocation.Type) =>
  Effect.try({
    try: () => JSON.parse(invocation.prompt.trimStart().split(/\r?\n/, 1)[0] ?? "") as unknown,
    catch: () => undefined
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Body)),
    Effect.flatMap((body) =>
      Effect.try({ try: () => body.patterns.map((pattern) => Label.parse(pattern, "")), catch: () => undefined })
    ),
    Effect.mapError(() => invalid("The registered security body needs 1 to 16 review target labels"))
  )

/** Host inputs: the immutable export and the private directory findings persist in. */
export type SecurityReviewOptions = ImmutableSourceOptions & {
  /** Absolute private directory for runs and findings, outside the repository. */
  readonly store: string
  /** The Codex seat; defaults to {@link toolFreeCodex} over the host's environment. */
  readonly codex?: CodexSeat | undefined
}

/** A failure's message with host paths and credentials removed, for an error that may be shown. */
const hostSafe = (cause: unknown): string =>
  LlmLint.redactCredentials(cause instanceof Error ? cause.message : String(cause))
    .replace(/(?:[A-Za-z]:)?(?:\/[^\s/"'`:]+){2,}\/?/g, "<path>").slice(0, 1_024)

/** Reads the change, runs every governing trusted review on the host's seats, and returns the public receipt. */
export const reviewSecurity = (options: SecurityReviewOptions, invocation: typeof Executable.Invocation.Type) =>
  Effect.gen(function*() {
    const { implementation, check } = yield* Schema.decodeUnknownEffect(Input)(invocation.input)
      .pipe(Effect.mapError(() => invalid("Check input must identify the implemented revision and declared check")))
    if (invocation.flow !== check.flow) return yield* invalid("The registered check flow does not match the plan")
    const patterns = yield* bodyPatterns(invocation)
    const base = reviewBase(implementation)
    if (base === undefined) return yield* invalid("The security review needs the one commit the change applies to")
    const resolver = yield* SeatResolver.SeatResolver
    return yield* withImmutableSource(
      options,
      implementation.head,
      (_head, headRoot) =>
        withImmutableCommit(options, base, (_base, baseRoot) =>
          Effect.tryPromise({
            try: async (signal) => {
              const source = exportedSource({ [base]: baseRoot, [implementation.head.commitId]: headRoot }, signal)
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
              if (prepared.policies.length === 0) return receipt(implementation, check, prepared, undefined, ungoverned)
              const reviewed = await TrustedReview.reviewPrepared(prepared, {
                root: headRoot,
                findingsStore: options.store,
                transport: seatTransport(resolver, options.codex ?? toolFreeCodex(process.env)),
                signal
              })
              return receipt(implementation, check, prepared, reviewed)
            },
            catch: (cause) =>
              new CodingError({
                code: "execution",
                message: `The security review could not read its policy or source: ${hostSafe(cause)}`
              })
          }))
    )
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CodingError ? error : new CodingError({
        code: "execution",
        message: "The security review could not export its source" +
          (error instanceof Error ? `: ${hostSafe(error)}` : "")
      })
    )
  )

/** What a scheduled audit reports: the audited commit and the public outcome of every audit review. */
export const AuditResult = Schema.Struct({
  status: Schema.Literals(["passed", "failed"]),
  commitId: Schema.String,
  evidence: Schema.String,
  findings: Schema.Array(Schema.String)
})
export type AuditResult = typeof AuditResult.Type

/** Audits one commit; like the check, one durable action whose finding store resumes an unfinished audit. */
export const AuditSecurity = Action.make("coding/audit-security", {
  payload: Executable.Invocation,
  success: AuditResult,
  error: CodingError,
  nondeterministic: true
})
/** Registered delegate for a scheduled audit flow such as `flows/security-audit`. */
export const securityAuditDelegate = Flow.make("coding/SecurityAudit", {
  payload: Executable.Invocation,
  success: AuditResult,
  error: CodingError,
  body: (invocation) => AuditSecurity.call(invocation)
})

/** Why an audit whose labels select no included file fails. */
export const emptyAudit = "The audit selected no file; a required security audit cannot pass"

/**
 * Audits the committed tip the host's working copy sits on with the audit
 * reviews its body names (`//...:securityAudit`): every included file, not a
 * diff, under that commit's own trusted policy, on the host's seats.
 */
export const auditSecurity = (options: SecurityReviewOptions, invocation: typeof Executable.Invocation.Type) =>
  Effect.gen(function*() {
    const patterns = yield* bodyPatterns(invocation)
    const { head } = yield* (yield* NativeCoding).read().pipe(
      Effect.mapError((error) => new CodingError({ code: "execution", message: error.message }))
    )
    const commitId = head.parentCommitIds.length === 1 ? head.parentCommitIds[0]! : undefined
    if (commitId === undefined) return yield* invalid("The security audit needs the one commit the workspace is on")
    const resolver = yield* SeatResolver.SeatResolver
    return yield* withImmutableCommit(options, commitId, (_tree, root) =>
      Effect.tryPromise({
        try: async (signal): Promise<AuditResult> => {
          const prepared = TrustedReview.governing(
            await TrustedReview.prepareSource(exportedSource({ [commitId]: root }, signal), {
              policyRevision: commitId,
              revision: commitId,
              patterns,
              required: true
            })
          )
          const reviewed = prepared.policies.length === 0 ? undefined : await TrustedReview.reviewPrepared(prepared, {
            root,
            findingsStore: options.store,
            transport: seatTransport(resolver, options.codex ?? toolFreeCodex(process.env)),
            signal
          })
          const { evidence, messages } = summarize(prepared, reviewed, reviewed === undefined ? emptyAudit : undefined)
          return {
            status: messages.length === 0 ? "passed" : "failed",
            commitId,
            evidence: JSON.stringify(evidence),
            findings: messages.map((message) => message.slice(0, 2_000))
          }
        },
        catch: (cause) =>
          new CodingError({
            code: "execution",
            message: `The security audit could not read its policy or source: ${hostSafe(cause)}`
          })
      }))
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CodingError ? error : new CodingError({
        code: "execution",
        message: "The security audit could not export its source" +
          (error instanceof Error ? `: ${hostSafe(error)}` : "")
      })
    )
  )

/** Supply this layer to the native action table and register {@link securityReviewCheckDelegate} and {@link securityAuditDelegate}. */
export const securityReviewCheckLayers = (options: SecurityReviewOptions) =>
  Layer.mergeAll(
    Interpreter.layer(securityReviewCheckDelegate),
    Interpreter.layer(securityAuditDelegate),
    ReviewSecurity.toLayer((invocation) => reviewSecurity(options, invocation)),
    AuditSecurity.toLayer((invocation) => auditSecurity(options, invocation))
  )
