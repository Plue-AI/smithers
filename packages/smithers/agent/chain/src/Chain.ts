/**
 * The chain trampoline: bootstrap, links, gates, and prefix replay.
 *
 * There is no agent-loop object. A link either runs its authored script to
 * an outcome, or — when it has no script (bootstrap) or its script was
 * rejected by a gate — the harness authors a successor from the goal plus
 * the journaled observations. Continuation is whatever the link returns
 * (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import { Effect, Fiber, Option, Result, Schema } from "effect"
import * as Author from "./Author.ts"
import * as AuthorDeclaration from "./AuthorDeclaration.ts"
import * as Authorize from "./Authorize.ts"
import * as CallKey from "./CallKey.ts"
import * as Catalog from "./Catalog.ts"
import * as Event from "./Event.ts"
import { childRun } from "./internal/childRun.ts"
import { ChildRunError } from "./internal/ChildRunError.ts"
import * as Journal from "./Journal.ts"
import * as JsonBoundary from "./JsonBoundary.ts"
import * as Observation from "./Observation.ts"
import * as Outcome from "./Outcome.ts"
import * as Script from "./Script.ts"
import * as ScriptRunner from "./ScriptRunner.ts"
import * as Steering from "./Steering.ts"

/**
 * A chain that cannot proceed: a replayed link diverged from its journal,
 * the journal is not a valid chain history, or the root scope id uses
 * the reserved child grammar.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ChainError extends Schema.TaggedError<ChainError>()("/chain/ChainError", {
  code: Schema.Literals(["replay_divergence", "invalid_journal"]),
  message: Schema.String
}) {}

class LinkAborted extends Schema.TaggedError<LinkAborted>()("/chain/Chain/LinkAborted", {
  observation: Observation.Observation
}) {}

/**
 * A required approval parks the run mid-link, deliberately without a
 * `LinkEnded`: resuming re-executes the link from its settled prefix and
 * re-asks the seam, converging under whatever grant now exists.
 */
class ApprovalPark extends Schema.TaggedError<ApprovalPark>()("/chain/Chain/ApprovalPark", {
  message: Schema.String
}) {}

/** What one link execution returns: its outcome, or a seam-parked approval. */
type LinkResult = Outcome.Outcome | { readonly _tag: "ApprovalParked"; readonly message: string }

/**
 * Asks the Authorize seam about one live call slot. A required approval
 * parks in place; `onDenied` decides what a denial does, because the model
 * seat and a catalog entry handle it differently.
 */
const authorizeSlot = <E>(
  authorize: Authorize.Service,
  request: Authorize.Request,
  onDenied: (error: Authorize.AuthorizeError) => Effect.Effect<never, E>
): Effect.Effect<void, Authorize.AuthorizeError | ApprovalPark | E> =>
  authorize.authorize(request).pipe(
    Effect.catchTag("/chain/AuthorizeError", (error) =>
      Effect.gen(function*() {
        if (error.code === "approval_required") return yield* new ApprovalPark({ message: error.message })
        if (error.code === "denied") return yield* onDenied(error)
        return yield* error
      }))
  )

/**
 * What a run needs: the goal, the budgets it may spend, and the journal
 * scope it owns.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly goal: string
  /**
   * Opaque run identity pinned into `ChainStarted` and compared on resume:
   * a resumed run whose envelope differs from the journaled one fails with
   * `replay_divergence`. It is NOT a policy input — the {@link Authorize}
   * seam receives only the call's name, the capabilities its catalog entry
   * declares, and the call slot. It is journaled verbatim and never
   * redacted, so keep secrets out of it.
   */
  readonly envelope?: typeof Schema.Json.Type | undefined
  readonly prefix?: string | undefined
  readonly maxLinks?: number | undefined
  readonly maxCallsPerLink?: number | undefined
  /** Caller-supplied context lines appended after the goal in harness-driven author calls. */
  readonly context?: ReadonlyArray<string> | undefined
  /**
   * The root journal scope. Must not contain `/` or match `<digits>.<digits>`;
   * those shapes are reserved for children derived from a spawning call slot.
   */
  readonly chain?: string | undefined
  /** @internal Set only by SubChains for derived child scopes. */
  readonly [childRun]?: true
}

/**
 * The name every script uses to call the author seat, re-exported from
 * the shared declaration leaf.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorName = AuthorDeclaration.authorName

/**
 * The author entry's one-line description, shared with the prompt's
 * catalog block so the model sees the same declaration the key pins.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorDescription = AuthorDeclaration.authorDescription

/**
 * The declaration digest pinned into every author call key.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorDigest: string = AuthorDeclaration.authorDigest

/**
 * The capability claim the chain sends to the {@link Authorize} seam for the
 * model seat — the string an operator's policy rule must cover to let a
 * chain author at all.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorCapability: string = AuthorDeclaration.authorCapability

/**
 * The link budget a run inherits when {@link Options.maxLinks} is unset.
 * Exceeding it parks the chain with a `quota` reason.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultMaxLinks = 32

/**
 * The per-link call budget a run inherits when
 * {@link Options.maxCallsPerLink} is unset. Exceeding it rejects the call as
 * a `fuel` observation, which parks the chain on the next attempt.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultMaxCallsPerLink = 64

const decodeScript = Schema.decodeUnknownOption(Script.Script)

const sameJson = (left: typeof Schema.Json.Type, right: typeof Schema.Json.Type): boolean =>
  Digest.canonical(left) === Digest.canonical(right)

// Excerpts start near the mismatch so a long shared prefix cannot hide the
// changed value. JSON quoting keeps control characters out of diagnostics.
const payloadDifference = (left: typeof Schema.Json.Type, right: typeof Schema.Json.Type): string => {
  const journaled = Digest.canonical(left)
  const live = Digest.canonical(right)
  let offset = 0
  while (journaled[offset] === live[offset]) offset++
  const start = Math.max(0, offset - 64)
  return `at JSON offset ${offset}: journaled ${JSON.stringify(journaled.slice(start, offset + 256))}; live ${
    JSON.stringify(live.slice(start, offset + 256))
  }`
}

const observationContext = (observations: ReadonlyArray<Observation.Observation>): ReadonlyArray<string> => {
  const lines: Array<string> = []
  const marker = "[truncated]"
  let remaining = 32768 - marker.length
  for (const observation of observations) {
    const line = Observation.render(observation)
    if (line.length >= remaining) {
      lines.push(line.slice(0, Math.max(0, remaining - 1)) + marker)
      break
    }
    lines.push(line)
    remaining -= line.length + 1
  }
  return lines
}

type RunError =
  | ChainError
  | Journal.JournalError
  | Author.AuthorError
  | Steering.SteeringError
  | Authorize.AuthorizeError

type Services = Journal.Journal | Catalog.Catalog | Author.Author | ScriptRunner.ScriptRunner

/**
 * Runs a chain to a terminal outcome or an in-place approval wait,
 * resuming from whatever the journal already holds: a finished chain
 * returns its terminal without executing
 * anything, and a half-finished link replays its settled calls by ordinal
 * before running live.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const run = (options: Options): Effect.Effect<Outcome.RunResult, RunError, Services> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const catalog = yield* Catalog.Catalog
    const author = yield* Author.Author
    const runner = yield* ScriptRunner.ScriptRunner
    const chainId = options.chain ?? ""
    const isRoot = options[childRun] !== true
    if (isRoot && (chainId.includes("/") || /^\d+\.\d+$/.test(chainId))) {
      return yield* new ChainError({
        code: "invalid_journal",
        message: `root chain id ${JSON.stringify(chainId)} uses the reserved child scope grammar`
      })
    }
    // Steering is optional context: a chain without the service runs
    // unchanged and journals identically. It is also the ROOT's channel
    // only — a sub-chain never drains, so an instruction meant for the
    // root can never be consumed by an unattended child. The envelope
    // seam is optional the same way — end-state it is the kernel's job.
    const steering = isRoot
      ? yield* Effect.serviceOption(Steering.Steering)
      : Option.none<Steering.Service>()
    const authorize = yield* Effect.serviceOption(Authorize.Authorize)
    const maxLinks = options.maxLinks ?? defaultMaxLinks
    const maxCalls = options.maxCallsPerLink ?? defaultMaxCallsPerLink
    const prefix = options.prefix ?? ""

    const initial = yield* journal.read

    // Only this scope's events are mirrored: every fold takes the scope, so
    // a child's or a sibling's events never need to be held here, and the
    // mirror grows by one per append instead of being rebuilt from a fresh
    // read of the whole journal before every event.
    const events: Array<Event.Event> = initial.filter((event) => Event.inChain(event, chainId))

    const existing = Event.terminal(events, chainId)

    // `position` is the journal length this run last observed. A run cannot
    // simply trust it: a sub-chain legitimately appends to the same journal
    // under its own id while this frame is suspended inside the spawning
    // handler. The next append then conflicts, and ONE fresh read decides
    // what moved. Counting our own scope restores the guarantee the
    // `expectedPosition` argument exists for: a second writer on THIS chain
    // is a conflict, a child writing its own scope is not, and the retry
    // lands on the position the child left behind.
    let position = initial.length

    const append = (event: Event.Event): Effect.Effect<void, Journal.JournalError> =>
      Effect.gen(function*() {
        const scoped = chainId === "" ? event : { ...event, chain: chainId }
        for (;;) {
          const attempt = yield* Effect.result(journal.append(scoped, position))
          if (Result.isSuccess(attempt)) break
          if (attempt.failure.code !== "journal_conflict") return yield* attempt.failure
          const latest = yield* journal.read
          const seen = latest.filter((candidate) => Event.inChain(candidate, chainId)).length
          if (seen !== events.length) {
            // Never absorb the other writer's events mid-link: their call
            // ordinals are keyed to a state this run does not hold, and
            // continuing would settle one slot twice.
            return yield* new Journal.JournalError({
              code: "journal_conflict",
              message: `chain ${
                JSON.stringify(chainId)
              } holds ${events.length} events but the journal carries ${seen}: another writer advanced it`
            })
          }
          // A binding that refuses the very position its read reports has
          // nothing this run can repair; retry only when the journal moved.
          if (latest.length === position) return yield* attempt.failure
          position = latest.length
        }
        events.push(scoped)
        position = position + 1
      })

    // Scans the live mirror, unlike a link's `rejectedPrior` snapshot taken
    // when the link starts executing.
    const hasRejection = (link: number, ordinal: number): boolean =>
      events.some((event) =>
        event._tag === "GateRejected" && event.link === link && event.ordinal === ordinal
        && Event.inChain(event, chainId)
      )

    const started = events.find(
      (event): event is Event.ChainStarted => event._tag === "ChainStarted" && Event.inChain(event, chainId)
    )
    if (started === undefined) {
      yield* append({ _tag: "ChainStarted", goal: options.goal, envelope: options.envelope ?? null })
    } else if (started.goal !== options.goal || !sameJson(started.envelope, options.envelope ?? null)) {
      return yield* new ChainError({
        code: "replay_divergence",
        message: `chain ${JSON.stringify(chainId)} was started with a different goal or envelope`
      })
    }
    if (existing !== undefined) return existing

    const executeLink = (link: number): Effect.Effect<Outcome.Outcome, RunError | ApprovalPark> =>
      Effect.gen(function*() {
        const script = Event.authored(events, link, chainId)
        const linkDigest = script === undefined ? CallKey.harnessDigest : script.digest
        const settledPrior = Event.settled(events, link, chainId)
        const rejectedPrior = Event.rejected(events, link, chainId)
        let counter = 0
        let lastRejection: Observation.Observation | undefined

        // Steering is link-cumulative: every author attempt of a link sees
        // all lines drained into the link so far, so a gate-rejected
        // attempt never swallows the user's instruction. A boundary is
        // drained at most once per execution and recorded drains are never
        // re-drained; empty drains journal nothing (a settled call pins
        // its context in its payload).
        const steeringLines: Array<string> = [...Event.steeringLines(events, link, chainId)]
        const steeredOrdinals = new Set(Event.steeredOrdinals(events, link, chainId))
        const steeringFor = (ordinal: number): Effect.Effect<ReadonlyArray<string>, RunError> =>
          Effect.gen(function*() {
            if (Option.isNone(steering) || steeredOrdinals.has(ordinal)) return steeringLines
            steeredOrdinals.add(ordinal)
            const drained = yield* steering.value.drain(`${chainId === "" ? "" : `${chainId}/`}${link}/${ordinal}`)
            if (drained.length > 0) {
              yield* append({ _tag: "SteeringDrained", link, messages: drained, ordinal })
              steeringLines.push(...drained)
            }
            return steeringLines
          })

        // Live rejections never need dedupe: a resumed link replays its
        // recorded rejection from `rejectedPrior` before this path can run.
        const reject = (ordinal: number, observation: Observation.Observation) =>
          Effect.gen(function*() {
            lastRejection = observation
            yield* append({ _tag: "GateRejected", link, observation, ordinal })
            return yield* new LinkAborted({ observation })
          })

        const executeCall = (
          origin: "harness" | "script",
          name: string,
          payload: unknown
        ): Effect.Effect<unknown, RunError | LinkAborted | ApprovalPark> =>
          Effect.gen(function*() {
            const ordinal = counter++
            const priorRejection = rejectedPrior.get(ordinal)
            if (priorRejection !== undefined) {
              lastRejection = priorRejection.observation
              return yield* new LinkAborted({ observation: priorRejection.observation })
            }
            const prior = settledPrior.get(ordinal)
            // Replay is budget-free; every live attempt spends fuel before
            // inspecting its payload, including attempts the boundary refuses.
            if (prior === undefined && ordinal >= maxCalls) {
              return yield* reject(
                ordinal,
                Observation.make("fuel", `link ${link} exceeded its budget of ${maxCalls} calls`)
              )
            }
            const payloadBoundary = JsonBoundary.jsonBoundary(payload)
            if (payloadBoundary._tag === "Refused") {
              return yield* reject(
                ordinal,
                origin === "harness"
                  ? Observation.make(
                    "fuel",
                    "harness author payload exceeds the JSON boundary; cannot recover by authoring"
                  )
                  : Observation.make("call_failed", `"${name}" received input that is not JSON-serializable`)
              )
            }
            // Every consumer below reads this copy, never the live payload: a
            // runner binding may pass an object whose getters answer
            // differently on a second read, and the handler must act on
            // exactly what was authorized and journaled.
            const jsonPayload = payloadBoundary.value as typeof Schema.Json.Type
            const scriptDigest = origin === "script" ? linkDigest : CallKey.harnessDigest
            if (prior !== undefined) {
              if (prior.key.link !== link || prior.key.scriptDigest !== scriptDigest) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message: `link ${link} call ${ordinal} settled under a different link or script than the current call`
                })
              }
              if (prior.name !== name) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message: `link ${link} call ${ordinal} requested "${name}" but the journal settled "${prior.name}"`
                })
              }
              if (!sameJson(prior.payload, jsonPayload)) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message:
                    `link ${link} call ${ordinal} ("${name}") received a different payload than the journaled call; ${
                      payloadDifference(prior.payload, jsonPayload)
                    }${origin === "harness" ? "; check Options.context for this harness author payload" : ""}`
                })
              }
              // The settled result only replays under the same declaration
              // it was produced under: a redeclared entry re-keys its calls
              // and a resumed chain refuses loudly rather than serving a
              // stale result (the declaration-identity resume rule).
              const entry = catalog.lookup(name)
              const currentDigest = name === authorName
                ? authorDigest
                : entry === undefined
                ? undefined
                : Catalog.entryDigest(entry)
              if (currentDigest !== prior.key.entryDigest) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message:
                    `link ${link} call ${ordinal} ("${name}") settled under a different declaration than the catalog now carries`
                })
              }
              return prior.result
            }
            if (name === authorName) {
              if (Option.isSome(authorize)) {
                // The model seat is inside the envelope too: a deny-all
                // envelope must not burn model tokens routing around its
                // own denials. A denied seat is unrecoverable by
                // re-authoring, so it propagates typed instead of
                // journaling an observation; an ask parks in place.
                yield* authorizeSlot(
                  authorize.value,
                  { capabilities: [AuthorDeclaration.authorCapability], name, slot: { chain: chainId, link, ordinal } },
                  Effect.fail
                )
              }
              const promoted = yield* steeringFor(ordinal)
              const context = [
                ...Author.contextOf(jsonPayload),
                ...promoted.map((line) => `[steering] ${line}`)
              ]
              const raw = yield* author.author({ context, prefix })
              const extraction = Script.extract(raw)
              if (extraction._tag === "Rejected") {
                // The rejection is journaled before the settled marker so a
                // crash between the two resumes through `rejectedPrior`
                // instead of replaying the marker as an author result.
                const observation = Observation.make("shape", extraction.reason)
                lastRejection = observation
                yield* append({ _tag: "GateRejected", link, observation, ordinal })
                yield* append({
                  _tag: "CallSettled",
                  key: CallKey.make(link, scriptDigest, ordinal, authorDigest),
                  link,
                  name,
                  payload: jsonPayload,
                  result: { raw, rejected: true }
                })
                return yield* new LinkAborted({ observation })
              }
              const result = { digest: extraction.script.digest, text: extraction.script.text }
              yield* append({
                _tag: "CallSettled",
                key: CallKey.make(link, scriptDigest, ordinal, authorDigest),
                link,
                name,
                payload: jsonPayload,
                result
              })
              return result
            }
            const entry = catalog.lookup(name)
            if (entry === undefined) {
              return yield* reject(ordinal, Observation.make("catalog", `"${name}" is not a catalog entry`))
            }
            // An undeclared entry claims everything; an explicit empty
            // claim set claims no external authority and skips the seam.
            const claims = entry.capabilities ?? ["*"]
            if (Option.isSome(authorize) && claims.length > 0) {
              // Gate 4, live calls only: replayed settled calls already
              // ran, and the check stays out of the journal so a later
              // grant is re-decidable (see the Authorize.ts module comment).
              yield* authorizeSlot(
                authorize.value,
                { capabilities: claims, name, slot: { chain: chainId, link, ordinal } },
                (error) => reject(ordinal, Observation.make("denied", error.message))
              )
            }
            const key = CallKey.make(link, scriptDigest, ordinal, Catalog.entryDigest(entry))
            const settle = (signal?: AbortSignal) =>
              Effect.gen(function*() {
                const result = yield* entry.handler(jsonPayload, { chain: chainId, link, ordinal, key, signal }).pipe(
                  Effect.catchTag("/chain/CallError", (error) =>
                    Effect.gen(function*() {
                      // Run failures stay typed and un-settled, through every
                      // level of recursion. Ordinary handler failures reject.
                      if (error instanceof ChildRunError) return yield* error.error
                      // A handler surfacing a required approval — a sub-chain
                      // waiting on a grant — parks in place like the seam's
                      // own ask: nothing settles, resume re-enters here.
                      if (error.cause === "approval_required") {
                        return yield* new ApprovalPark({ message: error.message })
                      }
                      return yield* reject(
                        ordinal,
                        Observation.make("call_failed", `"${name}" failed: ${error.message}`)
                      )
                    }))
                )
                const resultBoundary = JsonBoundary.jsonBoundary(result)
                if (resultBoundary._tag === "Refused") {
                  return yield* reject(
                    ordinal,
                    Observation.make("call_failed", `"${name}" produced a result that is not JSON-serializable`)
                  )
                }
                yield* append({
                  _tag: "CallSettled",
                  key,
                  link,
                  name,
                  payload: jsonPayload,
                  result: resultBoundary.value as typeof Schema.Json.Type
                })
                return resultBoundary.value
              })
            if (entry.settleOnInterrupt !== true) return yield* settle()
            // The parent remains interruptible, while the child owns both the
            // started action and its receipt. Stop signals the action and joins
            // settlement; it cannot abandon an irreversible controller promise.
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function*() {
                const cancellation = new AbortController()
                const fiber = yield* Effect.forkChild(settle(cancellation.signal), { uninterruptible: true })
                return yield* restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() =>
                  Effect.sync(() => cancellation.abort()).pipe(
                    Effect.andThen(Fiber.join(fiber)),
                    // A refused/interrupted binding has already journaled its
                    // observation. Journal failures must still escape the join.
                    Effect.catchTag("/chain/Chain/LinkAborted", () => Effect.void)
                  )
                ))
              })
            )
          })

        if (script !== undefined) {
          const ran = yield* runner
            .run(script, (request) => executeCall("script", request.name, request.payload))
            .pipe(
              Effect.catchTag("/chain/Chain/LinkAborted", () => Effect.succeed(undefined)),
              Effect.catchTag("/chain/ScriptFailure", (failure) =>
                Effect.gen(function*() {
                  // A failing script — compile, throw, or bad outcome — is an
                  // observation like any gate, not a harness crash. An
                  // unavailable runner lands here too and recovers by
                  // authoring scriptless successors until the link budget
                  // parks the chain.
                  const ordinal = counter++
                  const observation = Observation.make("script_failed", `${failure.code}: ${failure.message}`)
                  lastRejection = observation
                  if (!hasRejection(link, ordinal)) {
                    yield* append({ _tag: "GateRejected", link, observation, ordinal })
                  }
                  return undefined
                }))
            )
          if (ran !== undefined) return ran
        }

        while (true) {
          if (lastRejection !== undefined && lastRejection.kind === "fuel") {
            return Outcome.park("quota", lastRejection.message)
          }
          const attempt = yield* executeCall("harness", authorName, {
            context: [
              options.goal,
              ...(options.context ?? []),
              ...observationContext(Event.observations(events, link, chainId))
            ]
          }).pipe(Effect.catchTag("/chain/Chain/LinkAborted", () => Effect.succeed(undefined)))
          if (attempt === undefined) continue
          const decoded = decodeScript(attempt)
          if (decoded._tag === "None") {
            return yield* new ChainError({
              code: "invalid_journal",
              message: `link ${link} settled an author call whose result is not a script`
            })
          }
          return Outcome.to(decoded.value)
        }
      })

    let link = Event.linkCount(events, chainId)
    while (true) {
      if (link >= maxLinks) {
        const parked = Outcome.park("quota", `the chain reached its budget of ${maxLinks} links`)
        yield* append({ _tag: "LinkEnded", link, outcome: parked })
        return parked
      }
      // A required approval surfaces here as its typed marker: the run
      // parks WITHOUT a LinkEnded, so resuming re-executes this link from
      // its settled prefix and re-asks the seam under the current grants.
      // (A script deliberately returning park("approval") still ends its
      // link below — only the seam's park is resumable-in-place.)
      const outcome: LinkResult = yield* executeLink(link).pipe(
        Effect.catchTag(
          "/chain/Chain/ApprovalPark",
          (error) => Effect.succeed({ _tag: "ApprovalParked" as const, message: error.message })
        )
      )
      if (outcome._tag === "ApprovalParked") {
        return { _tag: "ApprovalWait", reason: { code: "approval", message: outcome.message } }
      }
      if (outcome._tag === "To") {
        // The successor's digest is re-derived here, whatever the runner
        // handed back: `script.digest` becomes the replay key of every call
        // the next link makes, and the script that chose the text must not
        // also choose that key. `Outcome.to` normalizes the same way, so a
        // runner double that bypasses `decodeOutcome` cannot forge it either.
        const successor = Outcome.to(outcome.script)
        if (Event.authored(events, link + 1, chainId) === undefined) {
          yield* append({ _tag: "LinkAuthored", link: link + 1, script: successor.script })
        }
        yield* append({ _tag: "LinkEnded", link, outcome: successor })
        link = link + 1
        continue
      }
      yield* append({ _tag: "LinkEnded", link, outcome })
      return outcome
    }
  })
