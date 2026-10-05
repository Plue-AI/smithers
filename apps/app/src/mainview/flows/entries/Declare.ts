/*
 * What every flow module declares with: the `flow` constructor that pairs a
 * declaration with its handler, the shared payload schemas, and the controller
 * surface a handler acts on. Flows.ts re-exports the public half.
 */
import type { Refusal } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"
import type * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Schema } from "effect"
import { FlowCancellation } from "../FlowCancellation"
import { FlowGesture, type CommandGesture } from "../CommandGesture"
import type { AppBootstrap, RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import { NoInput, type Operation, type OperationPayload } from "@smthrs/ui/app-operations"
import type { AppController } from "../../state/AppController"
import { lostActRefusal } from "../../state/BrowserWriteFailure"
import type { CommandState, FlowEntry, FlowMetadata } from "../registry"

/**
 * What a flow handler resolves: nothing, an honest error string, a typed refusal
 * (`{ refusal }`), or a success VALUE (`{ value }`) — the payload an invocation hands back to its caller
 * (e.g. the browser flow's extracted text). Agent tool payloads never render
 * raw in the transcript (DESIGN.md §3, trigger axis); the controller may
 * surface a HUMAN caller's value as that command's embedded answer.
 */
export type CommandResult = void | string | { readonly value: string } | { readonly refusal: Refusal }

/**
 * The controller actions flows bind to. This is the AppController surface minus
 * the dispatch members themselves, so the registry never calls back through its
 * own run path.
 */
export type CommandActions =
  & Omit<
    AppController,
    | "store"
    // Control focus is the composition root's DOM-owned projection, never a flow's act.
    | "controlFocus"
    | "formFocus"
    // The mounted guide reports host visibility independently of command admission.
    | "observeGuideVisibility"
    | "storageRecoveryState"
    | "privacyNotices"
    | "nativeAgentAvailable"
    | "slashCommands"
    | "slashItems"
    | "slashTree"
    | "runCommand"
    | "runCommandForResult"
    | "submitCommand"
    | "commands"
    | "tappedFetch"
    // Owner credential presentation is a composition-owned panel, never a command action.
    // Live stack snapshots are what the Stack views read, never an act.
    | "installSnapshots"
    | "githubSyncSnapshots"
    // A Codex session the conversation shows read-only (M-38), never an act.
    | "externalSession"
    // The fast model's titles are what the timeline reads, never an act.
    | "timelineTitles"
    // The roster and the person's role are what the Members card reads, never an act.
    | "membersRoster"
    | "membersRole"
    // The flow catalog is what the Flow card reads, never an act.
    | "flowCatalog"
    | "stackSnapshots"
    // The TODO list Home reads where no `home` topic is served, never an act.
    | "todoList"
    // Live wiki navigation indexes and attachments are what the Wiki views read, never an act.
    | "wikiIndexes"
    | "wikiAttachments"
    // Feature flags and the download URL are the composition root's configuration, never an action.
    | "features"
    // The scope close is the composition root's act, never a flow's.
    | "dispose"
  >
  & {
    readonly snapshot: (repo?: string, path?: string) => CommandState
  }

/**
 * The success schema every app flow shares.
 *
 * These flows act on the app rather than compute a result, so the honest
 * success payload is "it ran", optionally carrying the one string the agent
 * boundary hands back to the model.
 */
export const Ack = Schema.Struct({ value: Schema.optional(Schema.String) })

/**
 * Runs a controller call as the flow's handler.
 *
 * The controller's string return is its honest refusal, so it becomes the
 * typed error channel — which `FlowBinding` renders as a catchable `failure`
 * call result rather than a harness failure. Thrown host errors use the opaque
 * default; only explicitly returned refusal strings are public.
 */
const act = (
  run: (signal: AbortSignal) => CommandResult | Promise<CommandResult>
): Effect.Effect<{ readonly value?: string }, string | { readonly refusal: Refusal } | { readonly cause: unknown }> =>
  Effect.suspend(() => {
    let pending: Promise<CommandResult> | undefined
    return Effect.tryPromise({
      try: async (signal) => {
        pending = Promise.resolve(run(signal))
        return pending
      },
      // Preserve diagnostics for host-side error taps, including thrown strings.
      catch: (cause) => ({ cause })
    }).pipe(
      // Abort is cooperative. A controller that cannot abort must finish before
      // its binding exits, so no abandoned promise can mutate after Stop returns.
      Effect.onInterrupt(() => Effect.promise(async () => { await pending?.catch(() => {}) })),
      Effect.flatMap((result): Effect.Effect<{ readonly value?: string }, string | { readonly refusal: Refusal }> =>
        typeof result === "string"
          ? Effect.fail(result)
          : typeof result === "object" && result !== null && "refusal" in result
          ? Effect.fail(result)
          : Effect.succeed(
            typeof result === "object" && result !== null ? { value: result.value } : {}
          ))
    )
  })

/** A shared operation as this app registers it: its host services and host kinds are the bootstrap's. */
export type AppOperation<I extends OperationPayload = OperationPayload> = Operation<I, RuntimeCapability, AppBootstrap["host"]>

/** What the GUI runs for one operation. */
export type Handler<I extends OperationPayload> = (payload: I["Type"], signal: AbortSignal, call: Cell.Call, gesture?: CommandGesture) => CommandResult | Promise<CommandResult>

/**
 * Everything one registered flow declares, in one literal: the shared
 * operation (`@smthrs/ui/app-operations`) plus the GUI's handler. Every
 * `userOnly` flow states its `userOnlyReason`; flows/agent-parity.test.ts
 * enumerates them.
 */
export interface Declaration<I extends OperationPayload> extends AppOperation<I>, FlowMetadata {
  /** The call identity is available for destination-side idempotency. */
  readonly prepare?: (payload: I["Type"]) => void | Promise<void>
  readonly handler: Handler<I>
}

/**
 * Declares one flow and binds it to its handler.
 *
 * The declaration's description is the catalog line the MODEL reads, so it
 * carries the argument hint; `metadata.summary` stays the human's catalog copy.
 */
export const flow = <I extends OperationPayload>(declaration: Declaration<I>): FlowEntry => {
  const { name, input, handler, prepare, userOnly, ...metadata } = declaration
  const described = metadata.args === undefined ? metadata.summary : `${metadata.summary} (args: ${metadata.args})`
  let binding: FlowEntry["binding"] | undefined
  return {
    prepare: prepare === undefined ? undefined : async (payload) => {
      const decoded = Schema.decodeUnknownSync(input)(payload)
      await prepare(decoded)
    },
    cooperativeCancellation: true,
    declaredName: name,
    // JSON schema projection and executable binding are needed on invocation
    // or agent catalog disclosure, not to paint the human's command names.
    get binding() {
      return binding ??= FlowBinding.make({
        flow: ({ capabilities: [], effects: undefined,
          name,
          description: described,
          input,
          output: Ack
        }),
        modelInvocable: userOnly !== true,
        /*
         * A returned refusal is the handler's own words and travels as it is.
         * A THROWN one used to render as nothing, which reached the person as
         * "/runs.open failed" — the flow's own name, no cause, no next act,
         * for a press whose durable write this browser had refused. The throw
         * is still typed here, one frame before the cell boundary erases it,
         * so it is classified here: a recognized write fault gets that fault's
         * sentence, a stopped act says it was stopped, and anything else is
         * this app's bug and says so. Host-authored text over a closed set,
         * never a thrown message; `cause` still rides to the error taps.
         */
        publicError: (failure: string | { readonly refusal: Refusal } | { readonly cause: unknown }) => typeof failure === "string" ? failure : "refusal" in failure ? refusalLine(failure.refusal, "") : lostActRefusal(failure.cause),
        handler: (payload, call) => Effect.flatMap(FlowCancellation, (cancellation) =>
          Effect.flatMap(FlowGesture, gesture => act((signal) => handler(payload, cancellation ?? signal, call, gesture))))
      })
    },
    metadata,
    input
  }
}

/**
 * The GUI handler for each shared operation, keyed by name. The map is
 * exhaustive: an operation without a handler does not compile.
 */
export type Handlers<Ops extends ReadonlyArray<AppOperation>> = {
  readonly [O in Ops[number] as O["name"]]: Handler<O["input"]>
}

/** `H` with no key beyond `Allowed`: a handler left for a removed operation does not compile. */
type Exact<H, Allowed> = H & { readonly [K in Exclude<keyof H, keyof Allowed>]: never }

/**
 * Binds each shared operation to its GUI handler, in the operations' order.
 * A list widened past its literal names escapes the compile-time check, so a
 * missing handler also throws when the registry is built.
 */
export const bind = <const Ops extends ReadonlyArray<AppOperation>, H extends Handlers<Ops>>(
  operations: Ops,
  handlers: Exact<H, Handlers<Ops>>
): ReadonlyArray<FlowEntry> =>
  operations.map((declared) => {
    const handler = (handlers as Readonly<Record<string, Handler<OperationPayload> | undefined>>)[declared.name]
    if (handler === undefined) throw new Error(`No GUI handler for the ${declared.name} operation.`)
    return flow({ ...declared, handler })
  })

/** The payload of a flow that takes nothing. */
export const NoPayload = NoInput
/** An optional trailing `owner/repo` target. */
export const RepoTarget = Schema.Struct({ repo: Schema.optional(Schema.String) })
/** A card id, the handle every id-scoped card act takes. */
export const CardTarget = Schema.Struct({ cardId: Schema.String })
/** A Smithers target: the repository it belongs to, its detected workspace, and its label. */
export const TargetRef = Schema.Struct({ repoId: Schema.String, label: Schema.String, workspace: Schema.optional(Schema.String) })
/** A positive issue or pull-request number beside its optional repo. */
export const NumberedTarget = Schema.Struct({
  number: Schema.Number,
  repo: Schema.optional(Schema.String)
})
/** A 1-based position in a repository file (`<path>:<line>:<col> [owner/repo]`, docs/code-intel/PLAN.md §4). */
export const CodePosition = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  repo: Schema.optional(Schema.String)
})
