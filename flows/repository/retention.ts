/** Capture only exact source named by a repository-authorized event. */
import * as Digest from "@smthrs/core/Digest"
import { FlowRuntime } from "@smthrs/flow"
import { Effect, Option, Schema } from "effect"
import { type ImmutableSourceOptions, runSourceProcess } from "../coding/immutable-source.ts"
import { Landing } from "../coding/landing.ts"
import { NativeCoding, NativeCodingError, type NativeRevision, requestIdFor } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { sourceEvent } from "./events.ts"
import { RepositoryRemote, RetainSourceRequest } from "./remote.ts"
import type { Event } from "./schema.ts"

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const sourceRequest = (event: typeof Event.Type, capturedPayload: Schema.Json) =>
  Effect.gen(function*() {
    const payload = object(capturedPayload), pr = object(payload.pull_request)
    let request: unknown
    if (event.source === "github" && event.type === "push") {
      const normalized = yield* Effect.try({
        try: () => sourceEvent(event),
        catch: (error) =>
          error instanceof CodingError
            ? error
            : new CodingError({ code: "source_refused", message: "Invalid source event" })
      })
      if (normalized.ignored) return undefined
      const pushed = object(normalized.payload)
      request = {
        kind: "push",
        head: pushed.candidateCommitId,
        base: pushed.baseCommitId,
        ref: pushed.ref,
        delivery_key: event.deliveryKey
      }
    } else if (
      pr.source === "github" ||
      event.source === "github" && (event.type === "pull_request" || event.manualStep !== undefined)
    ) {
      // A captured PR payload records the head and base this host read, not the
      // delivery that named the pull request. With no number there is nothing to
      // ask the remote for, and source this host already holds stays readable.
      const number = pr.number ?? event.issueNumber
      if (number === undefined) return undefined
      request = { kind: "pull_request", number, head: object(pr.head).sha, base: object(pr.base).sha }
    } else return undefined
    return yield* Schema.decodeUnknownEffect(RetainSourceRequest)(request).pipe(
      Effect.mapError(() =>
        new CodingError({
          code: "source_refused",
          message: "The repository event has no exact retainable source identity"
        })
      )
    )
  })

const unanswered = () =>
  new CodingError({ code: "source_unavailable", message: "The native source lookup could not complete" })
/** Exit zero with an empty revset is not evidence that JJ knows the object, and a
 * lookup that never answered is not evidence that JJ lacks it: that is `undefined`. */
const lookupSourceCommits = (options: ImmutableSourceOptions, commits: ReadonlyArray<string>, operationId: string) =>
  Effect.gen(function*() {
    if (
      !commits.length || commits.length > 2 || commits.some((commit) => !/^(?!0{40}$)[0-9a-f]{40}$/.test(commit)) ||
      !/^[0-9a-f]{128}$/.test(operationId)
    ) {
      return yield* new CodingError({
        code: "source_refused",
        message: "Source lookup requires full native identities"
      })
    }
    const result = yield* runSourceProcess(
      options,
      [
        "jj",
        "--ignore-working-copy",
        `--at-op=${operationId}`,
        "log",
        "--no-graph",
        "-r",
        commits.map((commit) => `commit_id("${commit}")`).join(" | "),
        "-T",
        "commit_id ++ \"\\n\""
      ],
      options.repositoryPath,
      30_000
    )
    if (result.exitCode !== 0 || result.stdout.truncated || result.stderr.truncated) return undefined
    const found = result.stdout.text.trim().split("\n").filter(Boolean).sort()
    return JSON.stringify(found) === JSON.stringify([...new Set(commits)].sort())
  }).pipe(Effect.mapError((error) => error instanceof CodingError ? error : unanswered()))
/** Retention imports what the lookup could not find and what it could not read. */
export const hasSourceCommits = (
  options: ImmutableSourceOptions,
  commits: ReadonlyArray<string>,
  operationId: string
) => lookupSourceCommits(options, commits, operationId).pipe(Effect.map((held) => held === true))
/** Absence is proven only by a lookup that answered; the rest keeps its fault class. */
export const heldSourceCommits = (
  options: ImmutableSourceOptions,
  commits: ReadonlyArray<string>,
  operationId: string
) =>
  lookupSourceCommits(options, commits, operationId).pipe(
    Effect.flatMap((held) => held === undefined ? Effect.fail(unanswered()) : Effect.succeed(held))
  )

const stableHead = ({ operationId: _operation, ...identity }: NativeRevision) => identity
/** Retention may populate object storage during eval/trial, but cannot edit or publish source. */
export const ensureSource = (
  options: ImmutableSourceOptions,
  event: typeof Event.Type,
  capturedPayload: Schema.Json,
  executionId: string
) =>
  Effect.gen(function*() {
    const request = yield* sourceRequest(event, capturedPayload)
    if (request === undefined) return
    const commits = [...new Set([request.head, request.base].filter((commit) => commit !== "0".repeat(40)))]
    const native = yield* NativeCoding, before = yield* native.read()
    if (yield* hasSourceCommits(options, commits, before.operationId)) return
    const remote = yield* Effect.serviceOption(RepositoryRemote)
    if (Option.isNone(remote) || !remote.value.retainSource || !native.importSource) {
      return yield* new CodingError({
        code: "source_unavailable",
        message: "Update this repository host to import the selected GitHub source"
      })
    }
    const retained = yield* remote.value.retainSource(request)
    const imported = yield* native.importSource({
      requestId: requestIdFor(executionId, `repository/source/${Digest.digest(Digest.canonical(request))}`),
      commits: commits.map((commitId) => ({
        commitId,
        ref: commitId === retained.head ? retained.head_ref : retained.base_ref!
      }))
    })
    if (
      imported.workspaceId !== remote.value.workspaceId ||
      JSON.stringify(stableHead(imported.head)) !== JSON.stringify(stableHead(before.head))
    ) {
      return yield* new CodingError({
        code: "stale_revision",
        message: "The owning workspace or editing revision changed during source import"
      })
    }
    if (!(yield* hasSourceCommits(options, commits, imported.operationId))) {
      return yield* new CodingError({
        code: "invalid_receipt",
        message: "Imported source is not available to native immutable capture"
      })
    }
  }).pipe(Effect.mapError((error) => {
    if (error instanceof CodingError) return error
    if (error instanceof NativeCodingError) {
      const code = error.code === "source_missing" || error.code === "source_changed" || error.code === "source_refused"
        ? error.code
        : "source_unavailable"
      return new CodingError({ code, message: error.message })
    }
    return new CodingError({ code: "source_unavailable", message: "The selected source could not be imported" })
  }))

/** The expected main comes from native bookmark authority, never an event SHA.
 * Every retained/imported source is rechecked against current main before use. */
export const ensureMainSource = (options: ImmutableSourceOptions, expectedMain: string) =>
  Effect.gen(function*() {
    const landing = yield* Landing, native = yield* NativeCoding
    const checkMain = Effect.gen(function*() {
      if ((yield* landing.readMain) !== expectedMain) {
        return yield* new CodingError({
          code: "source_changed",
          message: "Main changed before capture; inspect its current revision"
        })
      }
    })
    yield* checkMain
    const before = yield* native.read()
    if (yield* hasSourceCommits(options, [expectedMain], before.operationId)) {
      yield* checkMain
      return
    }
    const remote = yield* Effect.serviceOption(RepositoryRemote),
      execution = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    if (Option.isNone(remote) || !remote.value.retainMain || !native.importSource || Option.isNone(execution)) {
      return yield* new CodingError({
        code: "source_unavailable",
        message: "Update this repository host to import verified native main"
      })
    }
    const retained = yield* remote.value.retainMain(expectedMain)
    yield* checkMain
    const imported = yield* native.importSource({
      requestId: requestIdFor(execution.value.executionId, `repository/main/${expectedMain}`),
      commits: [{ commitId: expectedMain, ref: retained.head_ref }]
    })
    if (
      imported.workspaceId !== landing.binding.workspaceId || imported.workspaceId !== remote.value.workspaceId ||
      imported.repositoryId !== landing.binding.repositoryId ||
      JSON.stringify(stableHead(imported.head)) !== JSON.stringify(stableHead(before.head))
    ) {
      return yield* new CodingError({
        code: "stale_revision",
        message: "The owning workspace or editing revision changed during main import"
      })
    }
    yield* checkMain
    if (!(yield* hasSourceCommits(options, [expectedMain], imported.operationId))) {
      return yield* new CodingError({
        code: "invalid_receipt",
        message: "Imported main is unavailable to native immutable capture"
      })
    }
    yield* checkMain
  }).pipe(Effect.mapError((error) => {
    if (error instanceof CodingError) return error
    if (
      error instanceof NativeCodingError &&
      (error.code === "source_missing" || error.code === "source_changed" || error.code === "source_refused")
    ) return new CodingError({ code: error.code, message: error.message })
    return new CodingError({ code: "source_unavailable", message: "Verified native main could not be imported" })
  }))
