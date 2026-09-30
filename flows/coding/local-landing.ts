/**
 * Landing without the backend: the working copy's own jj repository and `gh`.
 *
 * `prepare` builds one candidate commit, the cleaned tip merged onto main with
 * main as its sole parent, without touching the working-copy change. The
 * fast-forward lander then runs the project's checks on it and moves main;
 * the pull-request lander pushes it as `smithers/landing-<request>` and lets
 * GitHub's required checks and branch protection decide the merge. Nothing
 * here retains a source with the backend or reads a credential: the operator's
 * `gh auth login` and jj identity reach these processes through the selected
 * environment only.
 */
import { Effect, type FileSystem, Layer, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { runSourceProcess } from "./immutable-source.ts"
import type { LandingCandidate, LocalLander, LocalPull, PullChecks } from "./landing-schema.ts"
import { Landing, type LocalLanding } from "./landing.ts"
import { NativeCoding } from "./native.ts"
import { CodingError } from "./schema.ts"
import { cleanedTipRefusal, type VibeCleanup } from "./vibe-schema.ts"

export interface Options {
  readonly kind: LocalLander
  readonly repositoryPath: string
  readonly fs: FileSystem.FileSystem
  /** PATH, HOME and the `gh`/jj settings the operator selected; nothing else reaches these processes. */
  readonly environment: Readonly<Record<string, string>>
  /** The bookmark a candidate lands on. */
  readonly target?: string | undefined
}

const commit = /^[0-9a-f]{40}$/
const change = /^[k-z]{32}$/
const evicted = (message: string) => new CodingError({ code: "evicted", message })
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const bounded = (text: string, limit = 2_048) => {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}
const jjMinutes = 2, gitMinutes = 5, ghMinutes = 2
/** `gh pr view --json`; only the fields a receipt needs. */
const PullView = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String }))
})
/** `gh pr checks --required --json`. */
const CheckRows = Schema.Array(Schema.Struct({ name: Schema.String, bucket: Schema.String })).check(
  Schema.isMaxLength(256)
)

export const make = (options: Options) =>
  Effect.gen(function*() {
    const native = yield* NativeCoding, spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = options.repositoryPath, target = options.target ?? "main"
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target)) {
      return yield* unavailable("The landing target must be a bookmark name")
    }
    const run = (argv: ReadonlyArray<string>, minutes: number) =>
      runSourceProcess(options, argv, root, minutes * 60_000).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) =>
          error instanceof CodingError
            ? error
            : unavailable(`${argv[0]} could not run on this host: ${bounded(String(error), 500)}`)
        )
      )
    /** A jj command that must succeed; its stderr is the refusal. */
    const jj = (args: ReadonlyArray<string>) =>
      run(["jj", "--no-pager", "--color=never", ...args], jjMinutes).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result)
            : Effect.fail(unavailable(`jj ${args[0]} refused: ${bounded(result.stderr.text, 1_024)}`))
        )
      )
    const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
    /** Exactly one revision's field, or a refusal naming what was ambiguous. */
    const one = (revset: string, template: string, what: string) =>
      jj(["log", "--no-graph", "-r", revset, "-T", `${template} ++ "\\n"`]).pipe(
        Effect.flatMap((result) => {
          const found = lines(result.stdout.text)
          return found.length === 1 && !result.stdout.truncated
            ? Effect.succeed(found[0]!)
            : Effect.fail(invalid(`${what} must resolve to one revision (${found.length} found)`))
        })
      )
    const readMain = one(target, "commit_id", `The ${target} bookmark`).pipe(
      Effect.flatMap((id) => commit.test(id) ? Effect.succeed(id) : Effect.fail(invalid(`${target} is not a commit`)))
    )
    const marker = (requestId: string) => `smithers/landing ${requestId}`
    const described = (description: string) => `description(exact:${JSON.stringify(`${description}\n`)})`
    // An absent revision is nothing to abandon, and jj skips one already hidden, so a replay is a no-op.
    const abandonRevset = (revset: string) => jj(["abandon", "-r", `present(${revset})`]).pipe(Effect.asVoid)
    const prepare = (cleanup: VibeCleanup, requestId: string) =>
      Effect.gen(function*() {
        const refusal = cleanedTipRefusal(cleanup)
        if (refusal !== undefined) return yield* invalid(refusal)
        if (!/^[0-9a-f-]{36}$/.test(requestId)) return yield* invalid("A candidate needs this run's request identity")
        const tip = cleanup.head.commitId
        const atoms = cleanup.result.changes.flatMap((entry) => entry.implementation.atoms.map((atom) => atom.commitId))
        if (!commit.test(tip) || atoms.some((id) => !commit.test(id))) {
          return yield* invalid("A candidate needs full immutable native commit IDs")
        }
        // A crashed earlier attempt leaves its marked commits; they are not a candidate.
        yield* abandonRevset(
          `${described(`${marker(requestId)} merge`)} | ${described(`${marker(requestId)} candidate`)}`
        )
        const main = yield* readMain
        // The commits to land are the tip's line after main. This request's
        // validated atoms must all be on it: an atom main already has, or one
        // on another line, is not this request's delivery.
        const foreign = yield* jj([
          "log",
          "--no-graph",
          "-r",
          `(${atoms.join(" | ")}) ~ (ancestors(${tip}) ~ ancestors(${main}))`,
          "-T",
          "commit_id ++ \"\\n\""
        ])
        if (lines(foreign.stdout.text).length !== 0) {
          return yield* invalid("The validated atoms are not the cleaned tip's line after main")
        }
        yield* jj(["new", main, tip, "--no-edit", "-m", `${marker(requestId)} merge`])
        const merge = yield* one(described(`${marker(requestId)} merge`), "commit_id", "The merge commit")
        const conflicted = yield* one(merge, "if(conflict, \"conflict\", \"clean\")", "The merge commit")
        if (conflicted === "conflict") {
          const paths = yield* jj(["resolve", "-r", merge, "--list"]).pipe(
            Effect.map((result) => lines(result.stdout.text).map((line) => line.split(/\s{2,}|\t/, 1)[0]!)),
            Effect.orElseSucceed(() => [] as Array<string>)
          )
          yield* abandonRevset(merge)
          return yield* evicted(`The cleaned tip conflicts with ${target}: ${bounded(paths.join(", "), 1_024)}`)
        }
        yield* jj(["new", main, "--no-edit", "-m", `${marker(requestId)} candidate`])
        const placeholder = yield* one(described(`${marker(requestId)} candidate`), "change_id", "The candidate")
        if (!change.test(placeholder)) return yield* invalid("The candidate has no native change identity")
        yield* jj(["restore", "--from", merge, "--into", placeholder])
        yield* abandonRevset(merge)
        const empty = yield* one(placeholder, "if(empty, \"empty\", \"changed\")", "The candidate")
        if (empty === "empty") {
          yield* abandonRevset(placeholder)
          return yield* evicted(`The cleaned tip changes nothing on ${target}`)
        }
        yield* jj(["describe", "-r", placeholder, "-m", cleanup.summary])
        const mainChange = yield* one(main, "change_id", `The ${target} bookmark`)
        const read = yield* native.read([mainChange, placeholder]).pipe(
          Effect.mapError((error) => unavailable(`The candidate could not be read: ${error.message}`))
        )
        const revision = (changeId: string) => {
          const found = read.revisions.find((entry) => entry.changeId === changeId)
          return found === undefined || found.kind !== "resolved" ? undefined : {
            changeId: found.changeId,
            commitId: found.commitId,
            treeId: found.treeId,
            operationId: read.operationId,
            parentCommitIds: [...found.parentCommitIds]
          }
        }
        const base = revision(mainChange), candidate = revision(placeholder)
        if (
          base === undefined || base.commitId !== main || candidate === undefined ||
          candidate.parentCommitIds.length !== 1 || candidate.parentCommitIds[0] !== main
        ) {
          yield* abandonRevset(placeholder)
          return yield* invalid(`The candidate is not one resolved commit on ${target}`)
        }
        return { lander: options.kind, main: base, summary: cleanup.summary, candidate }
      })
    const fastForward = (prepared: LandingCandidate) =>
      Effect.gen(function*() {
        const main = yield* readMain
        if (main !== prepared.main.commitId) {
          return yield* evicted(
            `${target} moved from ${prepared.main.commitId} to ${main} after the candidate was verified`
          )
        }
        const moved = yield* run(
          ["jj", "--no-pager", "--color=never", "bookmark", "set", target, "-r", prepared.candidate.commitId],
          jjMinutes
        )
        if (moved.exitCode !== 0) {
          return yield* /backwards or sideways/.test(moved.stderr.text)
            ? evicted(`${target} moved after the candidate was verified`)
            : unavailable(`jj bookmark set refused: ${bounded(moved.stderr.text, 1_024)}`)
        }
        const landed = yield* readMain
        if (landed !== prepared.candidate.commitId) {
          return yield* invalid(`${target} is ${landed}, not the candidate ${prepared.candidate.commitId}`)
        }
        return landed
      })
    const abandon = (prepared: LandingCandidate) => abandonRevset(prepared.candidate.commitId)
    const gh = (args: ReadonlyArray<string>) => run(["gh", ...args], ghMinutes)
    const branchFor = (requestId: string) => `smithers/landing-${requestId}`
    const viewPull = (branch: string) =>
      gh(["pr", "view", branch, "--json", "number,url,state,headRefOid,headRefName,baseRefName,mergeCommit"]).pipe(
        Effect.flatMap((result) => {
          if (result.exitCode !== 0) {
            return /no pull requests found/i.test(result.stderr.text)
              ? Effect.succeed(undefined)
              : Effect.fail(unavailable(`gh pr view refused: ${bounded(result.stderr.text, 1_024)}`))
          }
          return Effect.try({
            try: () => JSON.parse(result.stdout.text) as unknown,
            catch: () => invalid("gh pr view returned no JSON")
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PullView)),
            Effect.mapError((error) =>
              error instanceof CodingError ? error : invalid("gh pr view returned an unexpected pull request shape")
            ),
            Effect.map((view): LocalPull => ({
              number: view.number,
              url: view.url,
              state: view.state === "OPEN" ? "open" : view.state === "MERGED" ? "merged" : "closed",
              headRef: view.headRefName,
              headSha: view.headRefOid,
              baseRef: view.baseRefName,
              mergeCommitId: view.mergeCommit?.oid ?? null
            }))
          )
        })
      )
    const openPull = (prepared: LandingCandidate, requestId: string) =>
      Effect.gen(function*() {
        if (!/^[0-9a-f-]{36}$/.test(requestId)) {
          return yield* invalid("A pull request needs this run's request identity")
        }
        if (!(yield* options.fs.exists(`${root}/.git`).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* unavailable("The pull-request lander needs a colocated Git repository (jj git init --colocate)")
        }
        const branch = branchFor(requestId), tip = prepared.candidate.commitId
        // Unforced: a branch already at the tip is up to date; one that moved is refused, never overwritten.
        const pushed = yield* run(["git", "push", "origin", `${tip}:refs/heads/${branch}`], gitMinutes)
        if (pushed.exitCode !== 0) {
          return yield* /rejected|non-fast-forward|fetch first/i.test(pushed.stderr.text)
            ? invalid(`The branch ${branch} moved away from the candidate; it is not pushed over`)
            : unavailable(`git push refused: ${bounded(pushed.stderr.text, 1_024)}`)
        }
        const existing = yield* viewPull(branch)
        const pull = existing ?? (yield* Effect.gen(function*() {
          const summary = prepared.summary
          const created = yield* gh([
            "pr",
            "create",
            "--head",
            branch,
            "--base",
            target,
            "--title",
            summary.split(/\r?\n/, 1)[0]!,
            "--body",
            summary
          ])
          if (created.exitCode !== 0 && !/already exists/i.test(created.stderr.text)) {
            return yield* unavailable(`gh pr create refused: ${bounded(created.stderr.text, 1_024)}`)
          }
          const opened = yield* viewPull(branch)
          return opened ?? (yield* invalid(`The pull request for ${branch} was not found after it was created`))
        }))
        if (pull.headRef !== branch || pull.headSha !== tip) {
          return yield* invalid(`Pull request #${pull.number} does not carry the candidate ${tip} on ${branch}`)
        }
        return pull
      })
    const observeChecks = (pull: LocalPull) =>
      gh(["pr", "checks", String(pull.number), "--required", "--json", "name,bucket"]).pipe(
        Effect.flatMap((result): Effect.Effect<PullChecks, CodingError> => {
          let rows: unknown
          try {
            rows = JSON.parse(result.stdout.text)
          } catch {
            rows = undefined
          }
          if (!Schema.is(CheckRows)(rows)) {
            return /no (required )?checks reported/i.test(result.stderr.text)
              ? Effect.succeed({ status: "passed" as const, checks: [] })
              : Effect.fail(unavailable(`gh pr checks refused: ${bounded(result.stderr.text, 1_024)}`))
          }
          const checks = rows.map(({ name, bucket }) => ({ name, bucket }))
          const status = checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")
            ? "failed" as const
            : checks.some((check) => check.bucket === "pending")
            ? "pending" as const
            : "passed" as const
          return Effect.succeed({ status, checks })
        })
      )
    const merge = (pull: LocalPull, prepared: LandingCandidate) =>
      Effect.gen(function*() {
        const summary = prepared.summary
        const merged = yield* gh([
          "pr",
          "merge",
          String(pull.number),
          "--squash",
          "--match-head-commit",
          prepared.candidate.commitId,
          "--subject",
          summary.split(/\r?\n/, 1)[0]!,
          "--body",
          summary
        ])
        const after = yield* viewPull(pull.headRef)
        if (after?.state === "merged" && after.mergeCommitId !== null && commit.test(after.mergeCommitId)) {
          return { status: "merged" as const, mainCommitId: after.mergeCommitId }
        }
        if (merged.exitCode === 0) {
          return yield* unavailable(`gh merged pull request #${pull.number} but its merge commit was not observed`)
        }
        return { status: "open" as const, reason: bounded(merged.stderr.text) }
      })
    const service: LocalLanding = { kind: options.kind, prepare, fastForward, abandon, openPull, observeChecks, merge }
    return service
  })
export const layer = (options: Options) => Layer.effect(Landing)(make(options))
