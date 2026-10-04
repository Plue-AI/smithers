/**
 * The built-in host capabilities, expressed as ordinary executable flows.
 *
 * There is no `ctx.fs`, no `ctx.shell`, no `ctx.memory`, and no `ctx.wait`. A
 * cell that reads a file and a cell that calls a remote MCP tool run the same
 * two lines — look the flow up in `ctx.flows`, invoke it with `ctx.call` — and
 * both boundaries are the same keyed, journaled, permission-gated activity.
 * This module is what makes that true for the standard capabilities: each
 * helper pairs a declaration that already exists (`@smthrs/std`,
 * `@smthrs/memory/Flows`) with the handler that already exists, through the
 * one binding contract in `@smthrs/harness/FlowBinding`.
 *
 * Each helper takes the `Context` the host built, because a handler's
 * requirements are the host's to supply — a browser host provides a different
 * `FileSystem` than a Node host, and neither of them changes what the cell
 * sees.
 *
 * Two capabilities cannot be written generically, and both take a narrow
 * injected port rather than a fake:
 *
 * - {@link approval} needs a human. The port is one `ask`. A host with nobody to
 *   ask refuses with {@link ApprovalUnavailable}, which the cell may catch; a
 *   host that wants the run to *wait* fails with a `HarnessError` carrying a
 *   `Permission.PermissionRequired`, or gates the call in
 *   `Agent.Options.authorize` — either way the park stays in the typed error
 *   channel where the cell can neither see nor swallow it.
 * - {@link clock} needs the durable engine, so it is the one helper here whose
 *   context is `FlowEngine`. It is not part of the browser-safe core, and
 *   nothing in `Agent` imports it. A durable sleep past the in-memory
 *   threshold awaits a `DurableDeferred`, whose key is hashed, so the host
 *   supplies `Crypto` alongside the runtime — the same three services
 *   `FlowEngineLike.make` captures from the flow it is built inside.
 *
 * @since 0.1.0
 */

import * as Capability from "@smthrs/capability/Capability"
import * as Digest from "@smthrs/core/Digest"
import { DurableClock } from "@smthrs/flow"
import type { FlowRuntime } from "@smthrs/flow"
import * as Fault from "@smthrs/flow/Fault"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Judgement from "@smthrs/harness/Judgement"
import * as Relevance from "@smthrs/harness/Relevance"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import type * as Path from "@smthrs/kernel/Path"
import * as MemoryFlows from "@smthrs/memory/Flows"
import { MemoryError } from "@smthrs/memory/MemoryError"
import type * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as WithMemory from "@smthrs/memory/WithMemory"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Bash from "@smthrs/std/Bash"
import * as Container from "@smthrs/std/Container"
import * as Edit from "@smthrs/std/Edit"
import * as Glob from "@smthrs/std/Glob"
import * as Grep from "@smthrs/std/Grep"
import * as Ls from "@smthrs/std/Ls"
import * as PortableSearch from "@smthrs/std/PortableSearch"
import * as Read from "@smthrs/std/Read"
import * as Search from "@smthrs/std/Search"
import * as SearchContract from "@smthrs/std/SearchContract"
import { StdError } from "@smthrs/std/StdError"
import * as TestRun from "@smthrs/std/TestRun"
import type * as TestRunner from "@smthrs/std/TestRunner"
import * as Write from "@smthrs/std/Write"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as ChildFlows from "./ChildFlows.ts"
import * as FlowEngineLike from "./FlowEngineLike.ts"

/** These refusal classes carry host-authored text separately from diagnostic causes. */
const publicRefusal = (error: { readonly message: string }): string => error.message

/** Shell/test execution failures may contain OS diagnostics. */
const publicExecutionError = (error: StdError): string | undefined => {
  if (error.code === "timeout") return "The command timed out."
  return error.code === "command_failed" || error.code === "request_failed" ? undefined : error.message
}

/** A command past its own limit (given or default) is a timeout; see `FlowBinding.Options.timedOut`. */
const commandTimedOut = (error: StdError): { readonly limitMillis?: number | undefined } | undefined =>
  error.code === "timeout" ? { limitMillis: error.limitMillis } : undefined

/**
 * Native search may report raw stderr, so only the contract's own rejection,
 * which names the construct that broke, is published verbatim.
 */
const publicSearchError = (error: StdError): string | undefined => {
  if (SearchContract.isContractRejection(error)) return error.message
  if (error.code === "invalid_pattern") {
    return "Unsupported ripgrep pattern. Use printable ASCII without special groups, lookaround, or backreferences."
  }
  return publicExecutionError(error)
}

/** Source names of the helpers below; see {@link coreSources}. */
const filesystemSource = "std/filesystem"
const shellSource = "std/shell"
const testsSource = "std/tests"
const memorySource = "memory"
const jevSource = "model/jev"
const clockSource = "engine/clock"
const approvalSource = "host/approval"

/**
 * The default longest wait a cell may request, in seconds.
 *
 * One hour is long enough for an intentional backoff but short enough that a
 * parked run remains distinguishable from one that hung. Hosts may lower this
 * ceiling when they construct {@link clock}.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxWaitSeconds = 3_600

/**
 * The standard filesystem capabilities, as ordinary flows.
 *
 * All seven are bound, not just `read` and `write`. A host that offers whole-
 * file writes and nothing else forces every edit through "read the file, then
 * write the whole file back", and a model that has an editing tool in its
 * training reaches for one it does not have instead: on SWE-bench instances the
 * built-in harness would emit `apply_patch` heredocs into `bash`, watch the
 * shell report `apply_patch: command not found`, and finish the run claiming a
 * fix it never applied. `@smthrs/std` already declares and implements every one
 * of these; the production composition simply was not offering them.
 *
 * Each handler needs only `FileSystem` and `Path`, which is why they compose
 * from the one context the host already built for `read`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const filesystem = (
  services: Context.Context<FileSystem.FileSystem | Path.Path>,
  search: Search.Search = PortableSearch.make(services)
): FlowBinding.Source => {
  const searchServices = Context.add(services, Search.Search, search)
  return FlowBinding.source(filesystemSource, [
    FlowBinding.provide(
      FlowBinding.make({
        flow: Read.flow,
        handler: Read.run,
        publicError: publicRefusal,
        activity: Read.activity,
        presentation: Read.presentation
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: Write.flow,
        handler: Write.run,
        publicError: publicRefusal,
        activity: Write.activity,
        presentation: Write.presentation
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: Edit.flow,
        handler: Edit.run,
        publicError: publicRefusal,
        activity: Edit.activity,
        presentation: Edit.presentation
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: ApplyPatch.flow,
        handler: ApplyPatch.run,
        publicError: publicRefusal,
        activity: ApplyPatch.activity,
        presentation: ApplyPatch.presentation
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: Ls.flow,
        handler: Ls.run,
        publicError: publicRefusal,
        activity: Ls.activity,
        presentation: Ls.presentation
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: Glob.flow,
        handler: Glob.run,
        publicError: publicSearchError,
        activity: Glob.activity,
        presentation: Glob.presentation
      }),
      searchServices
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: Grep.flow,
        handler: Grep.run,
        publicError: publicSearchError,
        activity: Grep.activity,
        presentation: Grep.presentation
      }),
      searchServices
    )
  ])
}

/**
 * Shell execution, as one ordinary flow.
 *
 * `container` is what makes `bash`'s `container` field mean anything. The flow
 * reads the transport optionally, so a composition that supplies none simply
 * refuses a containerised call — which is the same thing as not offering the
 * affordance at all. A task whose interpreter and test runner live in a
 * container is the ordinary SWE-bench shape, and without a transport the only
 * way in is the agent typing `docker exec c bash -lc '…'` itself: twelve failed
 * probes and one instance's most expensive frame across the measured 45. So the
 * default is the docker/podman CLI rather than `undefined`, because a host with
 * neither fails the spawn with the shell's own "not found" — which is honest —
 * while a host with docker gets the transport it plainly has.
 *
 * `sealedTo` names the one container `bash` may reach; every other call,
 * including one with no container that would run on this host, is refused
 * with `outside_container` (`Bash.sealed`).
 *
 * `terminal: "agent"` selects the dark T-TRM-05 binding. It refuses before
 * either transport is reached until registered PTY execution and card evidence
 * are available; this option cannot enable execution with a container fallback.
 *
 * @category constructors
 * @since 0.1.0
 */
export const shell = (
  services: Context.Context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>,
  container: Container.Container = Container.makeCommand(),
  options?: {
    readonly sealedTo?: string | undefined
    /**
     * T-TRM-05: unavailable until the registered daemon PTY and card checks pass.
     *
     * @since 1.0.0
     */
    readonly terminal?: "agent" | undefined
  }
): FlowBinding.Source =>
  FlowBinding.source(shellSource, [
    FlowBinding.provide(
      FlowBinding.make({
        flow: Bash.flow,
        // Never route the coding terminal binding through Exec or Container.
        // No existing transport proves registered-run PTY ownership/framing.
        handler: options?.terminal === "agent"
          ? () =>
            Effect.fail(
              new StdError({
                code: "provider_unavailable",
                message:
                  "Agent terminal unavailable: registered machine dispatch, PTY lifecycle, owner-only input, participant and card providers require C-J3-10 and C-COL-04."
              })
            )
          : options?.sealedTo === undefined
          ? Bash.run
          : Bash.sealed(options.sealedTo),
        publicError: publicExecutionError,
        timedOut: commandTimedOut,
        presentation: Bash.presentation
      }),
      Context.add(services, Container.Container, container)
    )
  ])

/**
 * The repository's own test runner, as one ordinary flow.
 *
 * Separate from {@link shell} because it needs one thing a shell does not: the
 * host's declaration of how this repository runs its tests. A host that has one
 * binds `TestRunner`; a host that does not binds `TestRunner.layerNoop` and the
 * flow says so when it is called. A host whose runner lives in a container adds
 * `Container` to the same context, which is also what `bash` reads it from.
 *
 * It needs the `Evaluator` too: the flow asks Jev whether a non-zero exit is
 * the tree's failure or the command failing to resolve a name, and a host
 * whose evaluator is `Evaluator.layerUnavailable()` gets that refusal as the
 * call's own typed failure rather than an unjudged result.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const tests = (
  services: Context.Context<
    ChildProcessSpawner.ChildProcessSpawner | Evaluator.Evaluator | TestRunner.TestRunner
  >
): FlowBinding.Source =>
  FlowBinding.source(testsSource, [
    FlowBinding.provide(
      FlowBinding.make({
        flow: TestRun.flow,
        handler: TestRun.run,
        publicError: publicExecutionError,
        timedOut: commandTimedOut,
        activity: TestRun.activity,
        presentation: TestRun.presentation
      }),
      // A failed run's attribution reading is charged to the calling run (#3010).
      FlowEngineLike.metered(services)
    )
  ])

/**
/**
 * Output for the agent's `recall` flow: the rows kept, and the rows Jev
 * withheld as unneeded.
 *
 * `unjudged` is present when Jev could not answer. Every row is then kept, and
 * this field, journaled with the call's settled result, is the receipt.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const JudgedRecallOutput = Schema.Struct({
  rows: MemoryFlows.RecallOutput,
  withheld: Schema.Array(Schema.Struct({ key: Schema.String, digest: Schema.String, p: Schema.Number })),
  unjudged: Schema.optional(Schema.Struct({ reason: AgentEvent.UnjudgedReason, detail: Schema.String }))
})

/**
 * The agent's `recall` declaration: `@smthrs/memory`'s recall, filtered by
 * `Relevance`.
 *
 * @category flows
 * @since 1.0.0-rc.0
 */
export const recallFlow = {
  capabilities: [],
  name: MemoryFlows.recallName,
  description:
    `${MemoryFlows.recallDescription} Rows Jev is at least 90% sure the query does not need are withheld and listed.`,
  input: MemoryFlows.RecallInput,
  output: JudgedRecallOutput,
  effects: MemoryFlows.recallEffects
} as const

/**
 * The one memory namespace a run's model-facing `remember` and `recall` may
 * reach.
 *
 * `policy` is `WithMemory.Policy` exactly as `@smthrs/memory` defines it: the
 * namespace, whether recall answers at all (`"none"` answers no rows), the
 * default recall budget, and whether writes are kept (`"never"` drops them).
 * `provenance` is recorded on every fact the bound `remember` writes and is
 * part of the scope's identity, so a host binds the run coordinates it knows
 * when it composes the run.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemoryScope {
  readonly policy: WithMemory.Policy
  readonly provenance?: MemoryStore.Provenance | undefined
}

/**
 * The explicit unscoped memory composition: `remember` and `recall` reach any
 * bank a call names. A host passes it to {@link memory} only when no flow in
 * the run declares a memory policy and the operator owns the whole store.
 *
 * @category constants
 * @since 1.0.0
 */
export const hostWide = "host-wide" as const

/**
 * The type of {@link hostWide}.
 *
 * @category models
 * @since 1.0.0
 */
export type HostWide = typeof hostWide

type RecallRows = typeof MemoryFlows.RecallOutput.Type

/**
 * Asks `judge` which recalled rows `input.query` does not need, and journals
 * the reading into the calling run. See {@link memory}.
 */
const judgedRows = (
  input: typeof MemoryFlows.RecallInput.Type,
  call: Cell.Call,
  rows: RecallRows,
  judge: Context.Context<Evaluator.Evaluator>
) =>
  Effect.gen(function*() {
    if (rows.length === 0) return { rows, withheld: [] }
    const journal = yield* AgentEvent.Journal
    const at = { scope: call.identity.session, frame: call.identity.frame }
    const judged = yield* Effect.result(
      Relevance.judge(
        { task: input.query },
        rows.map((row) => ({ kind: "memory" as const, id: row.key, text: row.text }))
      ).pipe(Effect.provideContext(judge))
    )
    if (judged._tag === "Failure") {
      yield* journal(
        Judgement.unjudgedEvent(judged.failure, {
          ...at,
          classifier: "relevance/unnecessary",
          items: rows.length
        })
      )
      return { rows, withheld: [], unjudged: judged.failure }
    }
    const reading = judged.success
    const acted = reading.verdicts.some((verdict) => verdict.withheld)
    for (const asked of reading.asked) yield* journal(Judgement.decision(asked, { ...at, acted }))
    yield* journal(Relevance.settled(reading, { ...at, source: "recall" }))
    return {
      rows: rows.filter((_, index) => !reading.verdicts[index]!.withheld),
      withheld: reading.verdicts.filter((verdict) => verdict.withheld).map((verdict) => ({
        key: verdict.item.id,
        digest: verdict.digest,
        p: verdict.p
      }))
    }
  })

// The approved capability ceiling applies even to bindings without a policy.
// Check the whole request before any bank is read or written.
const memoryAuthority = (operation: "read" | "write", banks: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const ceiling = yield* CapabilitySet.current
    for (const bank of banks) {
      const canonical = Recall.bankForNamespace(Recall.namespaceForBank(bank))
      if (
        !CapabilitySet.allows(ceiling, Capability.make(`memory:${operation}`, bank)) &&
        !CapabilitySet.allows(ceiling, Capability.make(`memory:${operation}`, canonical))
      ) {
        return yield* Effect.fail(
          new MemoryError({ code: "invalid_namespace", message: "memory bank is outside the approved capabilities" })
        )
      }
    }
  })

const guardedRemember =
  (handler: ReturnType<typeof MemoryFlows.handlersFor>["remember"]) => (input: typeof MemoryFlows.RememberInput.Type) =>
    memoryAuthority("write", [input.bank]).pipe(Effect.andThen(handler(input)))
const guardedRecall =
  (handler: ReturnType<typeof MemoryFlows.handlersFor>["recall"]) => (input: typeof MemoryFlows.RecallInput.Type) =>
    memoryAuthority("read", input.banks).pipe(Effect.andThen(handler(input)))

const unscopedMemory = (
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  judge: Context.Context<Evaluator.Evaluator> | undefined
): FlowBinding.Source =>
  FlowBinding.source(memorySource, [
    FlowBinding.provide(
      FlowBinding.make({
        flow: MemoryFlows.remember,
        handler: guardedRemember(MemoryFlows.runRemember),
        publicError: publicRefusal
      }),
      services
    ),
    judge === undefined
      ? FlowBinding.provide(
        FlowBinding.make({
          flow: MemoryFlows.recall,
          handler: guardedRecall(MemoryFlows.runRecall),
          publicError: publicRefusal
        }),
        services
      )
      : FlowBinding.provide(
        FlowBinding.make({
          flow: recallFlow,
          publicError: publicRefusal,
          handler: (input, call) =>
            guardedRecall(MemoryFlows.runRecall)(input).pipe(
              Effect.flatMap((rows) => judgedRows(input, call, rows, judge))
            )
        }),
        services
      )
  ])

/**
 * A scoped refusal leads with its stable code, and a foreign bank also names
 * the bank this run may use: `remember` requires a bank, so the model has to
 * learn which one is its own.
 */
const scopedRefusal = (bank: string) => (error: MemoryError): string =>
  error.code === "invalid_namespace"
    ? `${error.code}: ${error.message}; this run's memory bank is ${bank}.`
    : `${error.code}: ${error.message}`

/**
 * The executable identity of a scoped handler: its code, the policy it
 * enforces, and the run coordinates the scope records. `recall` is sealed, and
 * a sealed call is content-addressed on its declaration across runs, so two
 * scopes must never share one: a recall recorded in one namespace would
 * otherwise answer the same call in another, and a recall recorded by one run
 * would answer the next run from memory that run may since have changed. The
 * coordinates are fixed-order JSON so a host's key order and a non-finite
 * iteration cannot change or break the identity.
 */
const scopedBodyDigest = (
  handler: (...args: never) => unknown,
  policy: WithMemory.Policy,
  provenance: MemoryStore.Provenance
): string =>
  Digest.digest(Digest.canonical({
    handler: Function.prototype.toString.call(handler),
    policy,
    provenance: JSON.stringify([provenance.runId ?? null, provenance.nodeId ?? null, provenance.iteration ?? null])
  }))

const decodePolicy = Schema.decodeUnknownResult(WithMemory.Policy)

const scopedMemory = (
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  judge: Context.Context<Evaluator.Evaluator> | undefined,
  scope: MemoryScope
): FlowBinding.Source => {
  const decoded = decodePolicy(scope.policy)
  if (Result.isFailure(decoded)) {
    // Falling back to the unscoped bindings would hand the run every bank.
    const refused = new HarnessError({
      code: "assembly_failed",
      message: "The memory scope's policy is invalid, so no memory flows were bound.",
      cause: decoded.failure
    })
    return { name: memorySource, bindings: () => Effect.fail(refused) }
  }
  const policy = decoded.success
  const provenance = scope.provenance ?? {}
  const remember = WithMemory.withMemory(MemoryFlows.remember, policy)
  // `RememberInput.bank` is a non-empty bank name, so every write names its bank.
  const rememberHandler = guardedRemember(MemoryFlows.handlersFor(remember, provenance).remember)
  const publicError = scopedRefusal(policy.banks.join(", "))
  const rememberBinding = FlowBinding.provide(
    FlowBinding.make({
      flow: remember,
      handler: rememberHandler,
      publicError,
      bodyDigest: scopedBodyDigest(rememberHandler, policy, provenance)
    }),
    services
  )
  if (judge === undefined) {
    const recall = WithMemory.withMemory(MemoryFlows.recall, policy)
    const scopedRecallHandler = MemoryFlows.handlersFor(recall).recall
    const recallHandler = (input: typeof MemoryFlows.RecallInput.Type) =>
      guardedRecall(scopedRecallHandler)({ ...input, banks: input.banks.length ? input.banks : policy.banks })
    return FlowBinding.source(memorySource, [
      rememberBinding,
      FlowBinding.provide(
        FlowBinding.make({
          flow: recall,
          handler: recallHandler,
          publicError,
          bodyDigest: scopedBodyDigest(recallHandler, policy, provenance)
        }),
        services
      )
    ])
  }
  // The same policy enforcement, then the same Relevance reading the
  // unscoped `recall` takes.
  const recall = WithMemory.withMemory(recallFlow, policy)
  const recallHandler = (input: typeof MemoryFlows.RecallInput.Type, call: Cell.Call) =>
    guardedRecall((value) => MemoryFlows.runRecallFor(recall, value))({
      ...input,
      banks: input.banks.length ? input.banks : policy.banks
    }).pipe(Effect.flatMap((rows) => judgedRows(input, call, rows, judge)))
  return FlowBinding.source(memorySource, [
    rememberBinding,
    FlowBinding.provide(
      FlowBinding.make({
        flow: recall,
        handler: recallHandler,
        publicError,
        bodyDigest: scopedBodyDigest(recallHandler, policy, provenance)
      }),
      services
    )
  ])
}

/**
 * Durable memory, as two ordinary flows.
 *
 * With a `judge`, `recall` asks it which recalled rows the query does not
 * need, as `memory` items with the query as the task, and returns the rest. A
 * row is withheld only at `Relevance.withholdAt`; a reading Jev cannot make
 * keeps every row and says so in `unjudged`. Either way the reading is
 * journaled into the calling run through `AgentEvent.Journal`: its
 * `decision-settled` rows and a `relevance-settled` row with source `recall`,
 * or its `decision-unjudged` row. Without one, `recall` answers the rows
 * `@smthrs/memory` recalls.
 *
 * Every composition states its scope. {@link hostWide} is the deliberate
 * unscoped case: the two flows reach any bank a call names, for a host whose
 * operator owns the whole memory database. A {@link MemoryScope} binds them the way `@smthrs/memory` binds model-facing memory,
 * `WithMemory.withMemory` then `Flows.handlersFor`, so the policy namespace
 * is enforced before any I/O: a call naming a bank outside it fails with
 * `invalid_namespace`, a recall naming no bank reads the policy namespace, and
 * `recall: "none"` and `retain: "never"` behave as the memory package defines
 * them. A scope's policy and provenance are its declaration identity, so a
 * sealed recall recorded under one scope never answers a call under another;
 * give each run its own `provenance.runId` and keep it across that run's
 * resumes. A policy that does not decode binds nothing: composing the source
 * fails with `assembly_failed`.
 *
 * @category constructors
 * @since 0.1.0
 */
export function memory(
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  scope: MemoryScope | HostWide
): FlowBinding.Source
export function memory(
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  judge: Context.Context<Evaluator.Evaluator>,
  scope: MemoryScope | HostWide
): FlowBinding.Source
export function memory(
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  judgeOrScope: Context.Context<Evaluator.Evaluator> | MemoryScope | HostWide,
  scoped?: MemoryScope | HostWide
): FlowBinding.Source {
  // Each relevance reading a call takes is charged to the calling run (#3010).
  const [judge, scope] = Context.isContext(judgeOrScope)
    ? [FlowEngineLike.metered(judgeOrScope), scoped]
    : [undefined, judgeOrScope]
  if (scope === hostWide) return unscopedMemory(services, judge)
  if (scope === undefined) {
    // A missing scope never widens to every bank.
    const refused = new HarnessError({
      code: "assembly_failed",
      message: "The memory flows name no scope, so none were bound."
    })
    return { name: memorySource, bindings: () => Effect.fail(refused) }
  }
  return scopedMemory(services, judge, scope)
}

/**
 * The largest `state` one `jev` call sends, in UTF-8 bytes of its JSON, when
 * a host names no ceiling.
 *
 * Jev reads the whole state for every question, so the ceiling is what keeps
 * one call's latency and cost bounded; a cell with more to judge splits the
 * items across calls.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxJevStateBytes = Judgement.maxStateBytes

/**
 * Input for the `jev` flow.
 *
 * `questions` decodes model-authored questions through `Classifier.Question`,
 * the same ad-hoc path a typed classifier's declaration goes through, so a
 * choice with one option or a score with a repeated rung is refused before any
 * transport is asked.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const JevInput = Schema.Struct({
  state: Schema.Json.annotate({
    description:
      "The JSON every question is about: the items to judge, each with whatever a question needs to read. At most 256 KiB as JSON."
  }),
  questions: Schema.Record(Schema.String, Classifier.Question).annotate({
    description:
      "Questions keyed by your own ids. Each is { type: \"boolean\", instructions, criteria?: { true, false } }, { type: \"choice\", instructions, criteria: { option: meaning, ... } } with 2 to 255 options, or { type: \"score\", instructions, criteria: [rung, ...] } with 2 or more distinct rungs ordered worst to best. All are answered in parallel in one request."
  })
})

/**
 * Output for the `jev` flow.
 *
 * `usage` and `latencyMs` are the metered cost of the call, journaled with the
 * call's recorded result so a run's Jev spend is read back from the same
 * record its other calls are.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const JevOutput = Schema.Struct({
  answers: Schema.Record(Schema.String, Classifier.Answer).annotate({
    description:
      "One answer per question id. boolean: { value, probability }. choice: { value, probabilities, confidence }. score: { value, label, probabilities, confidence }."
  }),
  confidence: Schema.optional(Schema.Record(Schema.String, Schema.Number)).annotate({
    description: "The provider's own per-question confidence, when it reported one"
  }),
  usage: Schema.optional(Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number })).annotate({
    description: "Tokens the call cost, when the transport reported them"
  }),
  latencyMs: Schema.Number.annotate({ description: "Wall-clock milliseconds the evaluation took" })
})

/**
 * The `jev` declaration.
 *
 * The description carries the details the doctrine only points at: what Jev
 * is for, that fan-out belongs inside one call, and what it never does. The
 * host settles a cell's calls one at a time and caps a cell at a fixed number
 * of calls, so a call per item is both slow and finite; one call with one
 * question per item is the shape that scales.
 *
 * `sealed` is the honest tier: the answer is a function of the state and the
 * questions, holds nothing open, and writes nothing, so a replayed cell
 * returns the recorded answers rather than asking again.
 *
 * @category flows
 * @since 1.0.0-rc.0
 */
export const jevFlow = {
  name: "jev",
  description:
    "Ask Jev, a fast typed decision model, any number of boolean, choice or score questions about one JSON state, all answered in parallel in one request of about 300 ms, far cheaper than reading the items yourself. Answers are typed, never free text. Use it for every enumerable judgment over many items (classify, triage, rank, filter, yes/no, pick-one, score): put the items in state and write one question per item, keyed by your own ids; one call carries hundreds of questions. Calls from one cell settle one at a time and a cell's calls are capped, so pack the items into one call rather than firing a call per item. state is capped at 256 KiB of JSON. Not for generating text or code, and not for a question whose answer must be quoted. It never guesses: a judge that fails answers { ok: false } with the failure code first in error.message.",
  input: JevInput,
  output: JevOutput,
  capabilities: [`model:call:${Evaluator.defaultModel}`],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

/** A `jev` refusal the binding turns into a catchable call result. */
class JevRefused extends Schema.TaggedError<JevRefused>()(
  "@smthrs/agent/StandardFlows/JevRefused",
  { message: Schema.String }
) {}
// Call refusals the agent reads back: its own call was malformed or unroutable.
Fault.register("@smthrs/agent/StandardFlows/JevRefused", "factory")

/**
 * The public text of a `jev` failure: the refusal's own message, or the
 * evaluator's code first so a cell can branch on it. The message is
 * `Evaluator.publicMessage`, the text the supervisor journals for the same
 * failure: an `unreachable` transport message is the HTTP client's and may
 * name hosts or URLs, so that code carries a fixed sentence instead. It says
 * Jev was unavailable and nothing more; what the run does next is its own
 * decision, and this text does not make it.
 */
const jevPublicError = (error: Evaluator.EvaluatorError | Classifier.ClassifierError | JevRefused): string =>
  error instanceof JevRefused ? error.message : `${error.code}: ${Evaluator.publicMessage(error)}`

/**
 * Jev, as one ordinary flow.
 *
 * Bound only by a host that holds an `Evaluator`: the context is the whole
 * requirement, so a composition without a judge cannot call this and the
 * catalog it shows a cell has no `jev` in it. A judge that fails is the call's
 * own typed failure, with the `EvaluatorError` code first in the message;
 * nothing here falls back to another model or answers a default.
 *
 * `options.maxStateBytes` may only LOWER {@link defaultMaxJevStateBytes}, for
 * the same reason `clock` clamps its ceiling: a non-finite or larger value
 * would remove the bound without saying so.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const jev = (
  services: Context.Context<Evaluator.Evaluator>,
  options: { readonly maxStateBytes?: number | undefined } = {}
): FlowBinding.Source => {
  const requested = options.maxStateBytes
  const maxStateBytes = requested === undefined || !Number.isFinite(requested) || requested > defaultMaxJevStateBytes
    ? defaultMaxJevStateBytes
    : requested
  return FlowBinding.source(jevSource, [
    FlowBinding.provide(
      FlowBinding.make({
        flow: jevFlow,
        publicError: jevPublicError,
        activity: "checks",
        presentation: {
          verb: { pending: "asking Jev", success: "asked Jev", failure: "failed to ask Jev" },
          subject: "none",
          result: "none"
        },
        handler: (input) =>
          Effect.gen(function*() {
            const questionCount = Object.keys(input.questions).length
            if (questionCount === 0) {
              return yield* Effect.fail(new JevRefused({ message: "jev needs at least one question." }))
            }
            const bytes = new TextEncoder().encode(JSON.stringify(input.state)).byteLength
            if (bytes > maxStateBytes) {
              return yield* Effect.fail(
                new JevRefused({
                  message:
                    `jev refuses a state of ${bytes} bytes; this host's ceiling is ${maxStateBytes} bytes. Send shorter excerpts, or split the items across calls.`
                })
              )
            }
            const evaluator = yield* Evaluator.Evaluator
            const response = yield* evaluator.evaluate({ state: input.state, questions: input.questions })
            const answers = yield* Classifier.decodeAnswers(input.questions, response.answers)
            return {
              answers,
              ...(response.confidence === undefined ? {} : { confidence: response.confidence }),
              ...(response.usage === undefined ? {} : { usage: response.usage }),
              latencyMs: response.latencyMs
            }
          })
      }),
      // Each reading a call takes is charged to the calling run (#3010).
      FlowEngineLike.metered(services)
    )
  ])
}

/**
 * Input for the durable wait flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WaitInput = Schema.Struct({
  seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "How long to wait, in finite seconds, up to the host ceiling (one hour by default)"
  }),
  reason: Schema.optional(Schema.String).annotate({ description: "Why the run is waiting" })
})

/**
 * Output for the durable wait flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WaitOutput = Schema.Struct({ waitedSeconds: Schema.Number })

/**
 * The durable wait declaration.
 *
 * `irreversible` is the honest tier: waiting is not content-addressable, so the
 * boundary is run-scoped on the cell identity and a replayed cell returns the
 * recorded completion instead of sleeping again.
 *
 * @category flows
 * @since 0.1.0
 */
export const waitFlow = {
  capabilities: [],
  name: "wait",
  description:
    "Wait for a finite number of seconds up to the host ceiling (one hour by default). The wait is durable: a replay does not re-wait.",
  input: WaitInput,
  output: WaitOutput,
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
} as const

/** A wait refusal the binding turns into a catchable call result. */
class WaitRefused extends Schema.TaggedError<WaitRefused>()(
  "@smthrs/agent/StandardFlows/WaitRefused",
  { message: Schema.String }
) {}
Fault.register("@smthrs/agent/StandardFlows/WaitRefused", "factory")

/**
 * A durable wait, as one ordinary flow.
 *
 * The sleep itself is the engine's `DurableClock`, so a short wait runs in
 * memory and a long one is scheduled by the engine. Either way the enclosing
 * cell call is the durable boundary, which is what makes the wait replay rather
 * than repeat.
 *
 * The clock's name is the call identity, not the duration. A durable clock is
 * identified by name — the deferred it awaits is `DurableClock/<name>` — so
 * naming it after the duration would make a cell that waits twice for the same
 * number of seconds await one already-settled deferred and return from the
 * second wait immediately. The call identity is both unique per call and stable
 * across replay, which is exactly what the name has to be.
 *
 * `options.maxSeconds` may only LOWER {@link defaultMaxWaitSeconds}. The
 * ceiling is the one thing keeping a parked run distinguishable from a hung
 * one, and a configuration read straight into the comparison could remove it
 * without saying so: `NaN` makes every `seconds > maxSeconds` test false, and
 * `Infinity` or an enormous finite value admits a wait no operator will
 * outlive. Both are clamped to the default rather than refused, because the
 * host has already been composed by the time this runs and a throw here would
 * take down a composition over a wait it has not been asked to make yet. A
 * value at or below zero is a host that means "no waiting", which is a
 * coherent thing to ask for and is kept.
 *
 * @category constructors
 * @since 0.1.0
 */
export const clock = (
  services: Context.Context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>,
  options: { readonly maxSeconds?: number | undefined } = {}
): FlowBinding.Source => {
  const requested = options.maxSeconds
  const maxSeconds = requested === undefined || !Number.isFinite(requested) || requested > defaultMaxWaitSeconds
    ? defaultMaxWaitSeconds
    : requested
  return FlowBinding.source(clockSource, [
    FlowBinding.provide(
      FlowBinding.make({
        flow: waitFlow,
        publicError: publicRefusal,
        handler: (input, call) => {
          if (!Number.isFinite(input.seconds)) {
            return Effect.fail(
              new WaitRefused({ message: `wait requires finite seconds no greater than ${maxSeconds}.` })
            )
          }
          if (input.seconds > maxSeconds) {
            return Effect.fail(
              new WaitRefused({
                message:
                  `wait refuses ${input.seconds} seconds; this host's ceiling is ${maxSeconds} seconds. Retry with a smaller value.`
              })
            )
          }
          return Effect.as(
            DurableClock.sleep({
              name:
                `harness/wait/${call.identity.session}/${call.identity.frame}/${call.identity.cell}/${call.identity.ordinal}`,
              duration: Duration.seconds(input.seconds)
            }),
            { waitedSeconds: input.seconds }
          )
        }
      }),
      services
    )
  ])
}

/**
 * Input for the approval flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AskInput = Schema.Struct({
  question: Schema.String.annotate({ description: "What the run needs a human to decide" }),
  options: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "The answers the run can act on, when the question is a choice"
  }),
  to: Schema.optional(Schema.Literals(["parent", "person"])).annotate({
    description:
      "Who answers: the agent that started this one, escalating toward the person (parent, the default), or the person"
  })
})

/**
 * Output for the approval flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AskOutput = Schema.Struct({
  answer: Schema.String,
  approved: Schema.Boolean
})

/**
 * The approval declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export const askFlow = {
  capabilities: [],
  name: "ask",
  description: "Ask whoever started this task, the agent above or the person, a question, and wait for the answer.",
  input: AskInput,
  output: AskOutput,
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
} as const

/**
 * A host that has nobody to ask.
 *
 * Separate from `HarnessError` on purpose: this is a refusal the agent can see
 * and route around, and the binding contract turns it into an ordinary
 * catchable call failure. Parking is the other seam — a host that wants the run
 * to wait for a person fails with a `HarnessError` carrying a
 * `Permission.PermissionRequired`, or gates the call in `Agent.Options.authorize`,
 * which is where a park can be re-decided against a later grant instead of
 * being journaled forever.
 *
 * @category errors
 * @since 0.1.0
 */
export class ApprovalUnavailable extends Schema.TaggedError<ApprovalUnavailable>()(
  "@smthrs/agent/StandardFlows/ApprovalUnavailable",
  { message: Schema.String }
) {}
Fault.register("@smthrs/agent/StandardFlows/ApprovalUnavailable", "factory")

/**
 * The narrow host port an approval flow needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Asker {
  readonly ask: (
    input: typeof AskInput.Type
  ) => Effect.Effect<typeof AskOutput.Type, HarnessError | ApprovalUnavailable>
}

/**
 * Human approval, as one ordinary flow.
 *
 * @category constructors
 * @since 0.1.0
 */
export const approval = (asker: Asker): FlowBinding.Source =>
  FlowBinding.source(approvalSource, [
    FlowBinding.make({ flow: askFlow, handler: asker.ask, publicError: publicRefusal })
  ])

/**
 * An approval port for a host with nobody to ask.
 *
 * @category constructors
 * @since 0.1.0
 */
export const askerNoop = (): Asker => ({
  ask: (input) =>
    Effect.fail(
      new ApprovalUnavailable({
        message: `This host has nobody to ask "${input.question}". Decide without approval or stop.`
      })
    )
})

/**
 * The source names of every helper here and of `ChildFlows.source`: the
 * sources whose flows a run cannot do without. A host pins their flows, so
 * the run-start relevance reading never withholds them.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const coreSources: ReadonlyArray<string> = [
  filesystemSource,
  shellSource,
  testsSource,
  memorySource,
  jevSource,
  clockSource,
  approvalSource,
  ChildFlows.sourceName
]
