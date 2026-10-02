import { preloadViewModule } from "../ViewModules"
import { FlowGesture, type CommandGesture } from "./CommandGesture"
import type { CommandLifecycle, PendingCommandInput, PendingFieldInput, PendingFormInput } from "./CommandLifecycle"
/*
 * The registry runtime: one dispatch path for every trigger.
 *
 * Every interactive affordance in the app is a registered flow, and every
 * trigger — button, pill, slash menu, agent call — resolves to the SAME
 * `FlowBinding` and invokes it the same way. Launch law: a button with no flow
 * behind it is a launch blocker (parity.test.ts gates this).
 *
 * The catalog disclosed to the agent is not a second projection of this
 * registry; it is this registry narrowed to model-invocable entries, and the
 * same bindings answer the calls. That is why `CommandCatalog.ts` no longer
 * exists: a parallel projection is exactly the drift the one-door law forbids.
 */
import { Authorize } from "@smthrs/chain"
import { canonicalCommandName } from "@smthrs/ui/command-line"
import { FlowCancellation } from "./FlowCancellation"
import { commandFailureSentence } from "./CommandFailureCopy"
import type { AgentInvocation } from "./AgentInvocation"
import { formFlows } from "./entries/form"
import * as Cell from "@smthrs/harness/Cell"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect } from "effect"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { AgentCommandDiscovery, AgentToolCall, AgentToolSpec } from "./agentTools"
import { agentFailureText, agentToolSpecs, executeAgentToolCall, userOnlyError } from "./agentTools"
import type { AppTransition } from "../state/AppState"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows, guideFlows } from "./Flows"
import { repositoryFlowLeaves } from "./entries/flow"
import type { CatalogItem, CommandState, FlowEntry, MissingDoor, SlashItem, SlashRow } from "./registry"
import {
  flowCapabilityHeld,
  absentDoor,
  confirmLabel,
  disclosedToAgent,
  flowRequirements,
  itemOf,
  modelInvocable,
  nameOf,
  namespaceOf,
  parseSubmit,
  recommendedNames,
  slashItems,
  slashTree,
  unmetRequirements,
  visible
} from "./registry"
import type { Parsed } from "./SlashPayload"
import { payloadFor, unknownFlag } from "./SlashPayload"
import { assembleArgs, formFieldsFor, publicFormPayload } from "@smthrs/ui/flow-form"

export type { CommandActions, CommandResult } from "./Flows"

export type CommandOutcome =
  | { readonly status: "executed"; readonly value?: string }
  /** A name no host has. */
  | { readonly status: "unknown-command" }
  /**
   * A declared flow this host lacks the door for (`explainAbsent`): `reason`
   * is the one sentence every trigger says. When the native app is the answer
   * (`door` cloud.pat) the registry has already rendered the refusal
   * card through the named action; for the other doors nothing is rendered
   * and the sentence is the whole answer.
   */
  | {
    readonly status: "unavailable"
    readonly door: AbsentDoor
    readonly reason: string
    readonly action: null
  }
  | {
    readonly status: "failed"
    readonly error: string
    readonly persistenceFailed?: true
    /** This browser would not keep the write, so the loss is stated rather than swallowed. */
    readonly writeRefused?: true
    /**
     * A refusal the APP decided, carried as what it is rather than as prose
     * the surfaces would have to read back. `error` is always its sentence
     * (`refusalSentence`), so a surface with nothing to add renders it like
     * any other failure and one that answers a refusal differently — the
     * transcript, for a misunderstanding the person has to see after a
     * notification would have gone — matches on the kind exhaustively.
     */
    readonly refusal?: CommandRefusal
  }
  /**
   * THE FORM LAW (apps/app/AGENTS.md): the invocation lacked required input,
   * so nothing ran and the flow's form card is rendered instead — prefilled
   * from what the line gave, asking for `fields`. Only the agent and slash
   * doors reach this; a button always carries its args.
   */
  | { readonly status: "form"; readonly flow: string; readonly cardId: string; readonly fields: ReadonlyArray<string> }

/**
 * A refusal the app itself decided about a typed line, before any flow ran.
 *
 * It carries the door and the thing refused, never a rendered sentence: the
 * fault is the PERSON'S INPUT — nothing failed, nothing is retryable, and the
 * way on is to type it differently — which is a different thing from a seam
 * that refused, and the surfaces have to be able to tell them apart without
 * reading English.
 */
export type CommandRefusal = {
  /** A `--flag` the door never declared. */
  readonly kind: "unknown-flag"
  readonly flow: string
  readonly flag: string
}

/**
 * The one sentence each refusal gets. Exhaustive over the union, so a refusal
 * added without copy is a compile error rather than a blank line in front of
 * a person.
 */
export const refusalSentence = (refusal: CommandRefusal): string => {
  switch (refusal.kind) {
    case "unknown-flag":
      return `/${refusal.flow} takes no --${refusal.flag} — nothing ran. Send /${refusal.flow} without it.`
  }
}

/**
 * The door classes an exact miss resolves to. `cloud.session` refines
 * `cloud.pat`: the flows that ARE the PAT session (the `cloud.` namespace),
 * which on the web the GitHub sign-in already answers.
 */
export type AbsentDoor = MissingDoor | "cloud.session"

export interface AbsentExplanation {
  readonly door: AbsentDoor
  /** The one sentence every trigger says. */
  readonly reason: string
}

/** Whether the native app is the answer to a miss of this door: the refusal card carries the download. */

/** The sentence a miss of each door gets, after the flow it names. */
export const absentReason = (name: string, door: AbsentDoor): string => {
  switch (door) {
    case "cloud.pat":
      return `/${name} is not in the web app — it needs a local Smithers Cloud session.`
    case "cloud.session":
      return `/${name} is not in the web app — on the web your GitHub sign-in is your Smithers Cloud sign-in.`
    case "origin":
      return `/${name} is not available on this origin yet.`
  }
}

/** The flow the registry renders for a native-only miss on the web. */


/**
 * One flow invoked with its input ALREADY NAMED — the door a form submits
 * through.
 *
 * `payload` is the record the declaration's input schema validates, so no
 * field can shift onto its neighbour on the way in; `display` is the
 * equivalent slash line, kept for the trace, the confirmation message and the
 * card's echo, and never parsed back into the payload. Availability, the
 * requirement axis, the confirmation axis and the agent authorization are the
 * ones every other trigger meets: this is the same `runAs` path with the
 * text-shaped step already done.
 */
export interface FlowSubmission {
  readonly name: string
  readonly payload: Record<string, unknown>
  readonly actor: "user" | "agent"
  /** The equivalent slash line, for display and the trace only. */
  readonly display?: string
  readonly invocation?: AgentInvocation
  /** A form's original browser gesture, never serialized into its card. */
  readonly gesture?: CommandGesture
  /** Presentation context only; it conveys no command authority. */
  readonly originCardId?: string
}

export interface CommandRegistry {
  /** Every registered flow as UI-catalog records, admin entries included only for admin sessions. */
  readonly all: () => ReadonlyArray<CatalogItem>
  /** The same flows as executable entries. */
  readonly entries: () => ReadonlyArray<FlowEntry>
  readonly find: (name: string) => FlowEntry | undefined
  /**
   * Why an exact name is absent from THIS host, classified against the
   * unfiltered catalog by the door the host lacks (registry.ts `absentDoor`):
   * the native app (`cloud.pat`), the session flows the GitHub
   * sign-in already answers on the web (`cloud.session`), or a door this
   * origin could grow (`origin`). Undefined for a present flow, for a name no
   * host has, and for a flow about the other host. A prerequisite (sign-in)
   * is never a reason here — it is the requirement axis, resolved by `run`.
   */
  readonly explainAbsent: (name: string) => AbsentExplanation | undefined
  readonly state: () => CommandState
  readonly slashItems: (needle: string) => Array<SlashItem<CatalogItem>>
  /** The slash menu as a tree: leaves and namespace rows (registry.slashTree). */
  readonly slashTree: (needle: string) => Array<SlashRow<CatalogItem>>
  readonly recommended: () => CatalogItem
  readonly preload?: (name: string, args?: string) => Promise<void>
  readonly run: (name: string, args?: string, source?: "automatic", originCardId?: string) => Promise<CommandOutcome>
  /**
   * `run` at the agent boundary (requirement axis): an unmet requirement is an
   * honest failure carrying the reason — never a deferral, because a model must
   * not enqueue work that fires after its turn ends.
   */
  readonly runAsAgent: (name: string, args?: string, httpCall?: AgentToolCall["httpCall"]) => Promise<CommandOutcome>
  /**
   * The agent's entry point: one call through the identical run path buttons
   * and slash use. The result is an honest string that round-trips to the model.
   */
  readonly executeForAgent: (call: AgentToolCall, discover?: AgentCommandDiscovery) => Promise<string>
  /**
   * One flow as the agent actor, answered as a TYPED outcome. The string
   * channel executeForAgent returns cannot distinguish a failure from a success
   * value that happens to start with a failure prefix; this path never sniffs
   * strings.
   */
  readonly runForAgent: (name: string, args?: string, invocation?: AgentInvocation, signal?: AbortSignal) => Promise<CommandOutcome>
  /**
   * One flow run from a payload the caller already named (the form door):
   * the same path, entered past the composer boundary rather than through it.
   */
  readonly submit: (submission: FlowSubmission) => Promise<CommandOutcome>
  /** The flows the agent may call: the registry narrowed to model-invocable entries. */
  readonly callable: () => ReadonlyArray<FlowEntry>
  /** What the prompt's catalog block teaches: callable flows that are not hidden. */
  readonly disclosed: () => ReadonlyArray<Descriptor.FlowDescriptor>
  readonly toolSpecs: () => ReadonlyArray<AgentToolSpec>
}

/**
 * Chain calls carry their lineage, script digest and ordinal into the binding
 * so a handler opening a durable boundary can key it to the same invocation.
 * Buttons and slash calls have no replay frame and retain the app identity.
 */
const callFor = (entry: FlowEntry, payload: Record<string, unknown>, invocation?: AgentInvocation): Cell.Call =>
  new Cell.Call({
    flowName: nameOf(entry),
    input: payload as Cell.Call["input"],
    capabilities: entry.binding.descriptor.capabilities,
    effects: entry.binding.descriptor.effects,
    placement: entry.binding.descriptor.placement,
    identity: new Cell.CallIdentity({
      session: invocation?.lineage === undefined ? "app" : `${invocation.lineage}/${invocation.slot.chain}`,
      frame: invocation?.slot.link ?? 0,
      cell: invocation?.slot.key?.scriptDigest ?? "app",
      ordinal: invocation?.slot.ordinal ?? 0,
      declaration: Cell.declarationDigest(entry.binding.descriptor),
      layers: []
    })
  })

/*
 * FlowBinding frames a handler refusal for the cell that will read it next
 * ("Flow x failed: …"). The app surfaces the same refusal to a human, where the
 * frame is noise, so the deterministic prefix comes back off. The honest fix is
 * for CallResult to carry the failure as typed data instead of a sentence.
 */
const unframe = (name: string, message: string | undefined): string => {
  if (message === undefined || message === `Flow ${name} failed.`) return `/${name} failed`
  const failed = `Flow ${name} failed: `
  if (message.startsWith(failed)) return message.slice(failed.length)
  return message
}

/** The one string an app flow's success may carry back to the model. */
const valueOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const carried = (value as { readonly value?: unknown }).value
  return typeof carried === "string" ? carried : undefined
}

/** Chrome commands that render no card, so they leave a maximized card in place. */
const OVER_MAXIMIZED_CARD: ReadonlySet<string> = new Set(["chat.open", "chat.dictate", "palette.open", "palette.actions", "appearance.dark-mode", "input.mode"])

export const createCommandRegistry = (actions: CommandActions, agentActions: CommandActions = actions, lifecycle?: CommandLifecycle): CommandRegistry => {
  /*
   * The app's own invocation carries no host authority. Approval is a
   * host-injected decorator over typed capabilities (a GrantStore the cell
   * loop will hand in), never something a flow declaration claims, so an
   * invocation nobody scoped is authorized by nobody and passes.
   */
  const unscopedInvocation: AgentInvocation = {
    slot: { chain: "app", link: 0, ordinal: 0 },
    authorize: Authorize.make({ authorize: () => Effect.void }),
    refused: () => {}
  }
  const base = baseFlows(actions)
  const admin = adminFlows(actions)
  const guide = guideFlows(actions)
  /*
   * The repository's own flows, derived from its factory projection each
   * time the projection lands (entries/flow.ts `repositoryFlowLeaves`) and
   * gone with it. Cached on the row's identity because the slash tree reads
   * the registry per keystroke. A declared flow keeps its name: a projection
   * row that shares one (`chat`, `flow.list`) gets no leaf, so no name ever
   * resolves to two entries.
   */
  let leafCache: { readonly repo: string; readonly loadedAt: number; readonly leaves: ReadonlyArray<FlowEntry> } | undefined
  const leaves = (): ReadonlyArray<FlowEntry> => {
    const catalog = actions.repositoryFlows()
    if (catalog === undefined) return []
    if (leafCache !== undefined && leafCache.repo === catalog.repo && leafCache.loadedAt === catalog.loadedAt) return leafCache.leaves
    const taken = new Set([...base, ...guide, ...admin].map(nameOf))
    const built = repositoryFlowLeaves(actions, catalog.repo, catalog.flows).filter((entry) => !taken.has(nameOf(entry)))
    leafCache = { repo: catalog.repo, loadedAt: catalog.loadedAt, leaves: built }
    return built
  }
  let agentEntries: ReadonlyArray<FlowEntry> | undefined
  const agentEntry = (name: string): FlowEntry | undefined => {
    agentEntries ??= agentActions === actions ? [...base, ...guide, ...admin] : [...baseFlows(agentActions), ...guideFlows(agentActions), ...adminFlows(agentActions)]
    const declared = agentEntries.find((candidate) => nameOf(candidate) === name)
    if (declared !== undefined) return declared
    if (agentActions === actions) return leaves().find((candidate) => nameOf(candidate) === name)
    const catalog = agentActions.repositoryFlows()
    return catalog === undefined
      ? undefined
      : repositoryFlowLeaves(agentActions, catalog.repo, catalog.flows).find((candidate) => nameOf(candidate) === name)
  }

  const available = (entry: FlowEntry): boolean => {
    const bootstrap = actions.bootstrap
    const { hosts } = entry.metadata
    // A host-scoped flow exists only where the bootstrap names its host: no bootstrap, no host, no flow.
    if (hosts !== undefined && (bootstrap === undefined || !hosts.includes(bootstrap.host))) return false
    if (bootstrap === undefined) return true
    const { runtime = [], runtimeAny } = entry.metadata
    return runtime.every((capability) => hasCapability(bootstrap, capability)) &&
      (runtimeAny === undefined || runtimeAny.some((capability) => flowCapabilityHeld(bootstrap, capability)))
  }

  const entries = (): ReadonlyArray<FlowEntry> =>
    [...base, ...guide,
      ...(actions.snapshot().admin ? admin : []), ...leaves()].filter(available)

  const items = (): ReadonlyArray<CatalogItem> => entries().map(itemOf)

  const find = (name: string): FlowEntry | undefined => entries().find((entry) => nameOf(entry) === name)

  /*
   * The honest refusal (docs/web-mode/PLAN.md §1). The enabled catalog stays
   * the only executable surface; an exact miss is classified against the
   * UNFILTERED declarations by the door this bootstrap lacks, so the flow is
   * never reported as nonexistent when it is this origin that lacks the door.
   * Only a name absent from the declarations stays unknown-command.
   */
  const explainAbsent = (name: string): AbsentExplanation | undefined => {
    const bootstrap = actions.bootstrap
    if (bootstrap === undefined || find(name) !== undefined) return undefined
    const declared = base.find((entry) => nameOf(entry) === name) ?? leaves().find((entry) => nameOf(entry) === name)
    if (declared === undefined) return undefined
    const missing = absentDoor(declared.metadata, bootstrap)
    if (missing === undefined) return undefined
    const door: AbsentDoor = missing === "cloud.pat" && namespaceOf(name) === "cloud" ? "cloud.session" : missing
    return { door, reason: absentReason(name, door) }
  }

  /** Invokes one flow through its binding — the single door every trigger shares. */
  const invoke = async (
    entry: FlowEntry,
    payload: Record<string, unknown>,
    invocation?: AgentInvocation,
    gesture?: CommandGesture
  ): Promise<CommandOutcome> => {
    const name = nameOf(entry)
    const settled = await Effect.runPromise(
      Effect.result(entry.binding.run(callFor(entry, payload, invocation))).pipe(
        Effect.provideService(FlowCancellation, invocation?.signal),
        Effect.provideService(FlowGesture, gesture)
      ),
      // Controller promises receive the signal but retain their result when a
      // write cannot abort. Effect-native bindings use fiber interruption.
      { signal: entry.cooperativeCancellation === true ? undefined : invocation?.signal }
    )
    if (settled._tag === "Failure") {
      // A permission park or an assembly failure is not the human's business
      // to catch; surfaced honestly, it is still a failed invocation.
      return { status: "failed", error: commandFailureSentence(name, settled.failure) }
    }
    const result = settled.success
    if (result.outcome === "failure") {
      return { status: "failed", error: unframe(name, result.message) }
    }
    const value = valueOf(result.value)
    return value === undefined ? { status: "executed" } : { status: "executed", value }
  }

  /**
   * The one execution path every trigger (button, pill, slash, agent) shares.
   * The requirement axis resolves FIRST: a user-invoked flow with an unmet
   * requirement parks durably (actions.deferCommand) and the requirement's
   * fulfilling flow runs in its place — the controller resumes the parked flow
   * when the requirement's predicate flips true. Requirements resolve one at a
   * time against live state, so a flow needing sign-in AND a repo selection
   * steps through both. `seen` guards a misconfigured requirement table (a
   * fulfill cycle) with an honest failure instead of recursion.
   */
  /*
   * The /verbose trace: every invocation that passes this door is recorded
   * as one `flow.invoked` transition — actor, name, args, outcome, duration —
   * whichever trigger sent it and whether or not the flow is listed. The
   * store renders the record only while verbose is on.
   */
  const trace = (
    invoker: "user" | "agent" | "system",
    name: string,
    args: string | undefined,
    startedAt: number,
    outcome: Extract<AppTransition, { type: "flow.invoked" }>["outcome"],
    detail: string | null
  ): void => {
    // Diagnostics are persisted even with verbose off. Keep execution input
    // untouched, but never hand environment or form values to the trace sink.
    let tracedArgs = args ?? null
    if (args !== undefined && (name === "env.set" || name === "form.set")) {
      const parsed = payloadFor(name, args, undefined, actions.knownRepositories())
      tracedArgs = "[REDACTED]"
      if (!("error" in parsed)) {
        if (name === "env.set" && typeof parsed.payload.assignment === "string") {
          const variable = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(parsed.payload.assignment)?.[1]
          if (variable !== undefined) {
            tracedArgs = `${variable}=[REDACTED]${typeof parsed.payload.repo === "string" ? ` ${parsed.payload.repo}` : ""}`
          }
        } else if (name === "form.set") {
          // Mask every form.set value, including arbitrary card/field targets.
          // Write-only controls never enter this path in the first place.
          tracedArgs = `${parsed.payload.cardId} ${parsed.payload.field} [REDACTED]`
        }
      }
    }
    // Both errors and success text can echo input; form.submit also carries
    // the nested flow's assembled arguments even though its own args are an id.
    const sensitive = name === "env.set" || name === "form.set" || name === "form.submit"
    actions.traceFlow({
      type: "flow.invoked",
      actor: invoker === "agent" ? "smithers" : invoker,
      name,
      args: tracedArgs,
      hidden: find(name)?.metadata.hidden === true,
      outcome,
      detail: sensitive && detail ? "[REDACTED]" : detail,
      durationMs: Math.max(0, Math.round(Date.now() - startedAt))
    })
  }

  const runAs = async (
    invoker: "user" | "agent" | "system",
    name: string,
    args?: string,
    seen: ReadonlySet<string> = new Set(),
    invocation?: AgentInvocation,
    named?: Record<string, unknown>,
    httpCall?: AgentToolCall["httpCall"],
    inheritedGesture?: CommandGesture,
    originCardId?: string
  ): Promise<CommandOutcome> => {
    invocation?.signal?.throwIfAborted()
    const request = { name, actor: invoker === "agent" ? "smithers" as const : invoker,
      source: named !== undefined ? "form" as const : invoker === "system" ? "automatic" as const : "command" as const, invocation, httpCall }
    const early = lifecycle?.before?.(request, args, named)
    if (early !== undefined) return early
    const declared = find(name)
    if (named !== undefined && declared !== undefined) {
      const fields = formFieldsFor(declared.input, declared.metadata.form)
      named = publicFormPayload(fields, named)
      if (fields.some(field => field.kind === "write-only")) args = assembleArgs(fields, declared.metadata.form, named)
    }
    const gesture = inheritedGesture?.name === name ? inheritedGesture
      : invoker === "user" && find(name) !== undefined ? lifecycle?.reserveGesture?.(request, args, named) : undefined
    // A new human command is a return to the transcript. A stale maximized
    // card from an earlier session must not hide the card this command renders.
    // Commands raised by a maximized card itself keep that presentation until
    // their own frame or card handler decides where to go. Chrome commands
    // render no card: Chat opens over the card and closes back to it.
    // A recognized slash submission only transports the inner command. Its
    // own registry invocation decides whether to return to the transcript.
    const submitted = name === "chat.send" && declared !== undefined
      ? named === undefined ? payloadFor(name, args, declared.metadata.grammar, actions.knownRepositories()) : { payload: named }
      : undefined
    const transportsCommand = submitted !== undefined && !("error" in submitted) &&
      typeof submitted.payload.text === "string" && parseSubmit(submitted.payload.text, items()).kind === "command"
    const maximizedCardId = actions.snapshot().maximizedCardId
    const staysInMaximizedCard = (originCardId !== undefined && originCardId === maximizedCardId) ||
      name === "card.maximize" || name === "card.minimize" || name.startsWith("card.history.") ||
      name.startsWith("frame.") || OVER_MAXIMIZED_CARD.has(name) || transportsCommand
    if (invoker === "user" && maximizedCardId != null && !staysInMaximizedCard) actions.minimizeCard()
    // Only the human's local field edit has a synchronous recovery preparation.
    // Agent input waits for capability authorization in settle before dispatch.
    let pendingFieldInput: PendingFieldInput | PendingFormInput | undefined
    if (invoker === "user" && (name === "form.set" || name === "signup.set")) {
      const entry = find(name)
      if (entry !== undefined && unmetRequirements(entry.metadata, actions.snapshot(), flowRequirements).length === 0) {
        const parsed = named === undefined ? payloadFor(name, args, entry.metadata.grammar, actions.knownRepositories()) : { payload: named }
        if (!("error" in parsed)) {
          const { cardId, field, value } = parsed.payload
          if (typeof field === "string" && typeof value === "string") {
            if (name === "signup.set") pendingFieldInput = { field, value }
            else if (typeof cardId === "string") pendingFieldInput = { cardId, field, value }
          }
        }
      }
    }
    let pendingInput: PendingCommandInput | undefined
    try {
    const acceptance = lifecycle === undefined ? undefined : await lifecycle.accept(request, pendingFieldInput)
    if (acceptance !== undefined && "receipt" in acceptance) pendingInput = acceptance.pendingInput
    if (acceptance !== undefined && "refusal" in acceptance) return {
      status: "failed", error: acceptance.refusal, ...(acceptance.persistenceFailed ? { persistenceFailed: true } : {}),
      ...(acceptance.writeRefused ? { writeRefused: true } : {})
    }
    if (acceptance !== undefined && lifecycle?.canExecute?.(acceptance.receipt, request) === false) {
      return { status: "failed", error: "The command's controller, account, or turn closed before execution.", persistenceFailed: true }
    }
    // Cancellation while the intent commit was pending must not reach a binding.
    invocation?.signal?.throwIfAborted()
    const startedAt = Date.now()
    let authorizationRefused = false
    const execution = { invoked: false }
    const scopedInvocation = invocation === undefined ? undefined : { ...invocation, refused: (error: Parameters<AgentInvocation["refused"]>[0]) => {
      authorizationRefused = true
      invocation.refused(error)
    } }
    const canPublish = (): boolean => acceptance === undefined || lifecycle?.canPublish?.(acceptance.receipt, request) !== false
    let outcome: CommandOutcome
    try { outcome = await settle(invoker, name, args, seen, startedAt, scopedInvocation, named, gesture, execution, canPublish) }
    catch { outcome = { status: "failed", error: "The command did not finish. Check its result before trying again." } }
    const retryableAuthorization = authorizationRefused && (!execution.invoked || name === "form.submit")
    if (acceptance !== undefined && lifecycle !== undefined && !await lifecycle.settle(acceptance.receipt, outcome, retryableAuthorization)) {
      return { status: "failed", error: "The command's outcome could not be saved. Check its result before trying again.", persistenceFailed: true }
    }
    if (canPublish()) trace(
      invoker,
      name,
      args,
      startedAt,
      // The trace's outcome vocabulary predates the host boundary: an unavailable flow is recorded as the miss it is, with the reason as its detail.
      outcome.status === "unavailable" ? "unknown-command" : outcome.status,
      outcome.status === "failed"
        ? outcome.error
        : outcome.status === "unavailable"
        ? outcome.reason
        : outcome.status === "form"
        ? `rendered a form for ${outcome.fields.join(", ")}`
        : outcome.status === "executed"
        ? outcome.value ?? null
        : null
    )
    return outcome
    } finally {
      pendingInput?.clear()
      if (gesture !== inheritedGesture) gesture?.release()
    }
  }

  const settle = async (
    invoker: "user" | "agent" | "system",
    name: string,
    args: string | undefined,
    seen: ReadonlySet<string>,
    startedAt: number,
    invocation?: AgentInvocation,
    /** The payload a named submission already carries; absent for a text invocation. */
    named?: Record<string, unknown>,
    gesture?: CommandGesture,
    execution?: { invoked: boolean },
    canPublish: () => boolean = () => true
  ): Promise<CommandOutcome> => {
    const entry = find(name)
    if (entry === undefined) {
      const absent = explainAbsent(name)
      if (absent === undefined) return { status: "unknown-command" }
      const { door, reason } = absent
      return { status: "unavailable", door, reason, action: null }

    }
    let target = invoker === "agent" ? agentEntry(nameOf(entry)) ?? entry : entry
    if (invoker === "agent" && !modelInvocable(target)) {
      return { status: "failed", error: userOnlyError(nameOf(target), target.metadata.userOnlyReason) }
    }
    const acting = invoker === "agent" ? agentActions : actions
    /*
     * A flag the flow never declared (SlashPayload.unknownFlag) is refused
     * before anything runs, and NOT through the form law: the form collects
     * input a flow asks for, and a flow with no reading for `--summarize` has
     * no field to offer — rendering one would answer a refused flag with a
     * door to the very option that was refused.
     */
    const stray = named === undefined ? unknownFlag(args, target.metadata.args) : undefined
    if (stray !== undefined) {
      const refusal: CommandRefusal = { kind: "unknown-flag", flow: nameOf(target), flag: stray }
      return { status: "failed", error: refusalSentence(refusal), refusal }
    }
    // Parse once before prerequisites: an explicit public repository is a
    // read source even when the current URL could not be opened.
    const parsed: Parsed = named === undefined
      ? payloadFor(nameOf(target), args, target.metadata.grammar, actions.knownRepositories())
      : { payload: named }
    /*
     * A named payload survives as text only where the text reads back as that
     * payload. A deferred command and a confirmation button re-run the LINE
     * through the grammar, and a form value carrying a binding (`from:x`, a
     * trailing `owner/repo`) or a withheld value would otherwise run with a
     * field the payload never held, or without one it did. `extra` names the
     * fields the line may add: a confirmation's `confirmArgs` binds the
     * implicit repository.
     */
    const lineCarries = (line: string | undefined, extra: ReadonlySet<string> = new Set()): boolean =>
      named === undefined || carriesPayload(
        payloadFor(nameOf(target), line, target.metadata.grammar, actions.knownRepositories()),
        named,
        extra
      )
    const repo = "payload" in parsed && typeof parsed.payload.repo === "string" ? parsed.payload.repo : undefined
    const readsRepository = target.metadata.requires?.includes("repo-source") === true
    const sourcePath = readsRepository
      ? "payload" in parsed && typeof parsed.payload.path === "string" ? parsed.payload.path : ""
      : undefined
    const snapshot = actions.snapshot(repo, sourcePath)
    // Repository prerequisites use the resolved payload target; display text
    // cannot authorize a different repository.
    const readiness = snapshot.repositoryReadiness
    const pendingPayload = "payload" in parsed ? parsed.payload : !args?.trim() ? {} : undefined
    if (readsRepository && readiness && pendingPayload !== undefined) {
      if (invoker !== "user") return { status: "failed", error: readiness.phase !== "pending" ? readiness.error ?? "The repository catalog is unavailable." : "The repository is still loading. Try again when it is ready." }
      const prefix = `/${readiness.repo}`
      const globalPath = repo === undefined && sourcePath !== undefined && (sourcePath.toLowerCase() === prefix.toLowerCase() || sourcePath.toLowerCase().startsWith(`${prefix.toLowerCase()}/`))
      await actions.deferRepositoryCommand(nameOf(target), {
        ...pendingPayload,
        ...(globalPath ? { path: sourcePath!.slice(prefix.length).replace(/^\/+/, "") } : {}),
        repo: repo ?? readiness.repo
      }, { refresh: readiness.phase !== "pending", scope: readiness.scope })
      if (canPublish()) trace(invoker, name, args, startedAt, "deferred", "waits on repository catalog")
      return { status: "executed", value: "Requested" }
    }
    const unmet = unmetRequirements(target.metadata, snapshot, flowRequirements)[0]
    if (unmet !== undefined) {
      if (invoker === "agent") {
        /*
         * The machinery renders the missing sign-in step ITSELF — a model told
         * about auth.prompt sometimes writes the name as prose instead of
         * invoking it, and prose is not a button.
         */
        if (unmet.fulfill === "auth.prompt") {
          acting.promptSignIn(false, { name: nameOf(target), args })
          return {
            status: "failed",
            error: `${unmet.reason} — the sign-in step is already rendered in the chat; point the user at it`
          }
        }
        return { status: "failed", error: `${unmet.reason} — /${nameOf(target)} waits on that` }
      }
      if (!lineCarries(args)) {
        return { status: "failed", error: `${unmet.reason}. Submit the form again once that is done.` }
      }
      if (unmet.fulfill === undefined) {
        /*
         * A pure wait: the app is already settling this prerequisite, so there
         * is nothing to ask and nothing to run. The command parks and the seam
         * that settles the prerequisite resumes it — Chat answers now.
         */
        actions.deferCommand(nameOf(target), args ?? null, unmet.id)
        if (canPublish()) trace(invoker, name, args, startedAt, "deferred", `waits on ${unmet.id}`)
        return { status: "executed", value: "Requested" }
      }
      if (seen.has(unmet.fulfill)) {
        return {
          status: "failed",
          error: `${unmet.reason} — and /${unmet.fulfill} could not fulfill it`
        }
      }
      actions.deferCommand(nameOf(target), args ?? null, unmet.id)
      // The deferral is its own trace; the fulfilling flow traces itself below.
      if (canPublish()) trace(invoker, name, args, startedAt, "deferred", `waits on ${unmet.id}`)
      return runAs(invoker, unmet.fulfill, undefined, new Set([...seen, unmet.fulfill]))
    }
    // JSON can parse successfully while omitting a required schema field.
    // Let the form collect it before the binding can produce an input error.
    const fields = formFieldsFor(target.input, target.metadata.form)
    if ("error" in parsed || fields.some(field => field.required && (field.kind === "write-only"
      ? invoker !== "agent" && gesture?.hasWriteOnly?.(field.name) !== true
      : parsed.payload[field.name] === undefined))) {
      /*
       * THE FORM LAW: a line without the flow's required input renders the
       * flow's form — derived from its input schema, prefilled with what the
       * line gave — and nothing else. No door answers with a usage sentence;
       * the grammar's own reason stays the fallback only for a flow with no
       * fields to ask for (none today).
       */
      // A form is a new transcript card: a maximized card must not hide it.
      if (invoker === "user" && actions.snapshot().maximizedCardId != null) actions.minimizeCard()
      const rendered = acting.renderFlowForm({
        name: nameOf(target),
        args,
        via: invoker === "agent" ? "agent" : "user",
        invocation: invocation === undefined ? undefined : { ...invocation, authorized: undefined, signal: undefined },
        input: target.input,
        ...(target.metadata.form === undefined ? {} : { hints: target.metadata.form })
      })
      if (rendered === undefined) return { status: "failed", error: "error" in parsed ? parsed.error : "Required input is missing" }
      return { status: "form", flow: nameOf(target), cardId: rendered.cardId, fields: rendered.missing }
    }
    // The app may ask this question through the agent-shaped form path, but
    // only a human may answer it. Check after the form branch so a partial
    // application invocation still renders the question without running it.
    if (invoker === "agent" && nameOf(target) === "setup.ask") {
      return { status: "failed", error: "Only the human can answer the setup question through its form." }
    }
    /*
     * A `confirm` flow asked for by the MODEL: consequential acts (land a
     * PR, remove a credential, launch a harness) are invocable by the agent
     * — every listed flow is — but never performed by it. The invocation
     * posts a confirmation message whose button runs the flow as the user.
     * The label may depend on the payload (registry.ts `confirm`).
     */
    const confirmation = invoker === "agent" ? confirmLabel(target.metadata, parsed.payload) : undefined
    if (confirmation !== undefined) {
      /*
       * The line the button will run. A flow whose bare form resolves an
       * implicit target binds it here (registry.ts `confirmArgs`), so the
       * confirmation cannot drift to a different target while it waits.
       */
      const bound = target.metadata.confirmArgs?.(parsed.payload) ?? args
      if (!lineCarries(bound, target.metadata.confirmArgs === undefined ? undefined : new Set(["repo"]))) {
        return {
          status: "failed",
          error: `/${nameOf(target)} cannot be confirmed from this input: its command line would not run the same values`
        }
      }
      acting.requestFlowConfirmation(nameOf(target), bound ?? null, confirmation, target.metadata.confirmQuestion)
      trace(invoker, name, bound, startedAt, "confirm-requested", confirmation)
      return {
        status: "executed",
        value:
          `asked the user to confirm "/${nameOf(target)}${bound === undefined ? "" : ` ${bound}`}" — it runs only when they confirm, and nothing has happened yet`
      }
    }
    if (invoker === "agent") {
      if (invocation !== undefined && invocation.authorized !== Cell.declarationDigest(target.binding.descriptor)) {
        const request = {
          name: nameOf(target),
          capabilities: target.binding.descriptor.capabilities,
          slot: invocation.slot
        }
        const authorization = invocation.authorize.authorize(request)
        const decision = await Effect.runPromise(Effect.result(authorization), { signal: invocation.signal })
        if (decision._tag === "Failure") {
          invocation.refused(decision.failure)
          return { status: "failed", error: commandFailureSentence(nameOf(target), decision.failure) }
        }
      }
      // Bind this continuation explicitly. No shared mutable actor or authority
      // can leak into another concurrent command, and card metadata grants nothing.
      if (nameOf(target) === "form.submit") {
        const continuation = invocation === undefined ? unscopedInvocation : { ...invocation, authorized: undefined }
        target = formFlows(acting, continuation).find((candidate) => nameOf(candidate) === "form.submit")!
      }
    }
    invocation?.signal?.throwIfAborted()
    if (execution !== undefined) execution.invoked = true
    const settledOutcome = await invoke(target, parsed.payload, invocation, gesture)
    /*
     * The agent reads a refusal as its next act: a handler that points the
     * human at a slash the model cannot run (`/cloud.sign-in`) points the
     * model at the prompt flow that renders that button instead.
     */
    const outcome: CommandOutcome = invoker === "agent" && settledOutcome.status === "failed"
      ? { status: "failed", error: agentFailureText(settledOutcome.error) }
      : settledOutcome
    // A successful, user-invoked, LISTED flow feeds the slash menu's recency
    // ranking; hidden id-scoped acts never rank.
    if (canPublish() && outcome.status === "executed" && invoker === "user" && target.metadata.hidden !== true) {
      actions.noteCommandRun(nameOf(target))
    }
    return outcome
  }

  const run: CommandRegistry["run"] = (name, args, source, originCardId) =>
    runAs(source === "automatic" ? "system" : "user", name, args, new Set(), undefined, undefined, undefined, undefined, originCardId)

  const callable = (): ReadonlyArray<FlowEntry> => entries().filter(modelInvocable)

  const preload = async (name: string, args?: string): Promise<void> => {
    const entry = find(name)
    if (!entry) return
    const parsed = payloadFor(nameOf(entry), args, entry.metadata.grammar, actions.knownRepositories())
    if ("error" in parsed) return
    // Speculation resolves the same target the run will: an explicit repository
    // is never authorized by the selection behind it.
    const repo = typeof parsed.payload.repo === "string" ? parsed.payload.repo : undefined
    if (unmetRequirements(entry.metadata, actions.snapshot(repo)).length) return
    try { await Promise.all([preloadViewModule(nameOf(entry), parsed.payload), entry.prepare?.(parsed.payload)]) } catch { /* Speculation must never interrupt the user. */ }
  }

  const registry: CommandRegistry = {
    preload,
    all: items,
    entries,
    find,
    explainAbsent,
    state: actions.snapshot,
    slashItems: (needle) => slashItems(actions.snapshot(), needle, items()),
    slashTree: (needle) => slashTree(actions.snapshot(), needle, items()),
    recommended: () => {
      const name = recommendedNames(actions.snapshot())[0]
      const command = name === undefined ? undefined : items().find((item) => item.name === name)
      if (command === undefined) throw new Error("The recommended flow is not registered")
      return command
    },
    run,
    // Preserve the native host's direct tool path. Form continuations
    // still enter runForAgent below and must bring authority or fail closed.
    runAsAgent: (name, args, httpCall) => runAs("agent", name, args, new Set(), undefined, undefined, httpCall),
    executeForAgent: (call, discover) => executeAgentToolCall(registry, call, discover),
    runForAgent: async (name, args, invocation, signal) => {
      const clean = canonicalCommandName(name)
      const early = lifecycle?.before?.({ name: clean, actor: "smithers", source: "command", invocation }, args)
      if (early !== undefined) return early
      const target = find(clean)
      if (target !== undefined && !modelInvocable(target)) {
        return { status: "failed", error: userOnlyError(clean, target.metadata.userOnlyReason) }
      }
      return runAs("agent", clean, args, new Set(), {
        ...(invocation ?? unscopedInvocation),
        signal: signal ?? invocation?.signal
      })
    },
    submit: async ({ name, payload, actor, display, invocation, gesture, originCardId }) => {
      const clean = canonicalCommandName(name)
      if (actor === "user") return runAs("user", clean, display, new Set(), invocation, payload, undefined, gesture, originCardId)
      const early = lifecycle?.before?.({ name: clean, actor: "smithers", source: "form", invocation }, display, payload)
      if (early !== undefined) return early
      const target = find(clean)
      if (target !== undefined && !modelInvocable(target)) {
        return { status: "failed", error: userOnlyError(clean, target.metadata.userOnlyReason) }
      }
      return runAs("agent", clean, display, new Set(), { ...(invocation ?? unscopedInvocation) }, payload)
    },
    callable,
    /*
     * Callable vs disclosed mirrors the tool contract exactly: the agent may
     * EXECUTE every model-invocable flow (hidden id-scoped actions like
     * world.new-note included — hidden means unlisted to the human, not barred
     * to the agent), while the DISCLOSED set the prompt's catalog block
     * teaches follows the declaration's model-disclosure setting.
     */
    disclosed: () =>
      callable()
        .filter((entry) => disclosedToAgent(entry.metadata))
        .map((entry) => entry.binding.descriptor),
    toolSpecs: () => agentToolSpecs
  }
  return registry
}

/** Re-exported so surfaces can name the catalog record without reaching for registry.ts. */
export type { CatalogItem } from "./registry"

/** The visible catalog, for the "/flows" answer and the slash menu. */
export const visibleItems = (registry: CommandRegistry): Array<CatalogItem> => visible(registry.all())

/** A form value as the grammar compares it: whitespace-collapsed text, or JSON for a structure; blank is absent. */
const comparable = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === false) return undefined
  const text = Array.isArray(value) ? value.map(String).join(" ")
    : typeof value === "object" ? JSON.stringify(value) : String(value)
  const collapsed = text.trim().split(/\s+/).join(" ")
  return collapsed === "" ? undefined : collapsed
}

/**
 * Whether a re-parsed line holds exactly the named payload: every field the
 * payload holds, read back as itself, and no other field except those in
 * `extra` the payload left unset.
 *
 * @internal
 */
export const carriesPayload = (
  reread: Parsed,
  named: Readonly<Record<string, unknown>>,
  extra: ReadonlySet<string>
): boolean => {
  if ("error" in reread) return false
  const fields = new Set([...Object.keys(named), ...Object.keys(reread.payload)])
  for (const field of fields) {
    const want = comparable(named[field])
    const got = comparable(reread.payload[field])
    if (want === got) continue
    if (want === undefined && extra.has(field)) continue
    return false
  }
  return true
}
