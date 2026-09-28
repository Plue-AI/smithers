/*
 * The pure half of the flow registry ("flows are the app"), cut to this app's
 * surface: the UI-catalog metadata, the recommended (gold) rule, slash
 * filtering, alias resolution, and composer submit parsing. Nothing here
 * touches the DOM, the store, the agent bridge, or Effect, so the whole module
 * is unit-testable in plain bun; the executable half — a flow declaration
 * paired with its handler through `FlowBinding` — lives in Commands.ts.
 *
 * The split is deliberate. Flow IDENTITY (name, description, capabilities,
 * effect tier, whether a model may invoke it) belongs to the declaration and
 * its projected descriptor. Everything below is UI-catalog copy about a flow
 * that already exists, which is why it can stay a plain structural record.
 *
 * The namespace rows, the requirement rows and the recommendation rows are
 * data each namespace module under ./entries exports beside its flows; this
 * module aggregates them in display order. Those are the only value imports,
 * so a lane that adds a namespace, a requirement or a recommendation edits
 * its own module plus one line here.
 */
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { AppBootstrap, RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import type { Schema } from "effect"
import type { Grammar } from "./SlashPayload"
import * as account from "./entries/account"
import * as admin from "./entries/admin"
import * as agent from "./entries/agent"
import * as app from "./entries/app"
import * as signup from "./entries/signup"
import * as appearance from "./entries/appearance"
import * as approval from "./entries/approval"
import * as approvals from "./entries/approvals"
import * as auth from "./entries/auth"
import * as billing from "./entries/billing"
import * as branches from "./entries/branches"
import * as commits from "./entries/commits"
import * as browser from "./entries/browser"
import * as card from "./entries/card"
import * as change from "./entries/change"
import * as chat from "./entries/chat"
import * as cloud from "./entries/cloud"
import * as connector from "./entries/connector"
import * as debug from "./entries/debug"
import * as egress from "./entries/egress"
import * as env from "./entries/env"
import * as feature from "./entries/feature"
import * as files from "./entries/files"
import * as findings from "./entries/findings"
import * as flow from "./entries/flow"
import * as frame from "./entries/frame"
import * as github from "./entries/github"
import * as history from "./entries/history"
import * as issue from "./entries/issue"
import * as issues from "./entries/issues"
import * as integrations from "./entries/integrations"
import * as model from "./entries/model"
import * as notifications from "./entries/notifications"
import * as palette from "./entries/palette"
import * as plugins from "./entries/plugins"
import * as prs from "./entries/prs"
import * as repo from "./entries/repo"
import * as repos from "./entries/repos"
import * as repository from "./entries/repository"
import * as review from "./entries/review"
import * as runs from "./entries/runs"
import * as search from "./entries/search"
import * as setup from "./entries/setup"
import * as smithers from "./entries/smithers"
import * as secrets from "./entries/secrets"
import * as sync from "./entries/sync"
import * as system from "./entries/system"
import * as tab from "./entries/tab"
import * as toast from "./entries/toast"
import * as wiki from "./entries/wiki"
import * as box from "./entries/box"
import * as workspace from "./entries/workspace"
import type { FormHints } from "@smthrs/ui/flow-form"

/**
 * The UI-catalog concerns wrapped around one registered flow.
 *
 * This is the `metadata` half of a registry entry. It carries no flow-identity
 * decision: capabilities and effect tiers live on the declaration, and the
 * user-only axis is the descriptor's `modelInvocable` flag.
 */
export interface FlowMetadata {
  readonly summary: string
  /** Not listed in the slash menu (id-scoped button actions); still invocable. */
  readonly hidden?: boolean
  /** Teach a hidden control to the model without adding it to the human menu. */
  readonly discloseToAgent?: boolean
  /**
   * The slash argument hint, e.g. `<number> [owner/repo]`. Its presence is
   * what makes `/name <text>` parse as an invocation rather than a prompt;
   * the text itself is catalog copy for the human and the model.
   */
  readonly args?: string
  /*
   * The requirement axis: requirement ids (from `flowRequirements`) that must
   * be satisfied before this flow executes. A user-invoked flow with an unmet
   * requirement DEFERS — the run path parks the invocation and dispatches the
   * requirement's fulfilling flow instead; the deferred flow resumes when the
   * requirement's state predicate flips true. Agent-invoked flows never
   * defer: an unmet requirement is an honest failure carrying the reason,
   * because a model must not enqueue work that fires after its turn ends.
   */
  readonly requires?: ReadonlyArray<string>
  /** Host services this flow needs; unavailable flows do not register. */
  readonly runtime?: ReadonlyArray<RuntimeCapability>
  /**
   * Host services of which at least ONE must be present. A flow that serves
   * two hosts (a Cloud repository via Smithers Cloud, or a repository opened in the
   * local app) names both; `runtime` alone cannot say "either".
   */
  readonly runtimeAny?: ReadonlyArray<FlowCapability>
  /**
   * The bootstrap hosts this flow exists on; absent means every host. A flow
   * about one host itself (the web app's download door) names it here, so the
   * other host never registers a flow that reads wrong there. Unlike
   * `runtime`, a missing bootstrap satisfies nothing: no host, no flow.
   */
  readonly hosts?: ReadonlyArray<AppBootstrap["host"]>
  /**
   * The repository flow this door launches when that is not the flow itself
   * (`issue.implement` runs `coding/request`). The app home reads a tile's
   * last result by it (cards/RepositoryHomeCard.tsx); nothing else does.
   */
  readonly workflow?: string
  /**
   * A consequential act the MODEL may ask for but never perform: an
   * agent invocation does not run the handler — it posts a confirmation
   * message whose action button runs the flow as the user. The string is
   * the human-readable label of the act ("land pull request #12").
   * User invocations are unaffected.
   *
   * The function form decides per decoded payload: the label when THIS
   * invocation needs the human's confirmation, undefined when the handler
   * may run for the agent as it stands.
   */
  readonly confirm?: string | ((payload: Record<string, unknown>) => string | undefined)
  /**
   * The sentence the confirmation asks, when "Smithers wants to <label>" is
   * not what happened: an act whose own door asks (the human's button and
   * slash reach a door that posts this confirmation) states the question
   * itself. Absent keeps the model's sentence.
   */
  readonly confirmQuestion?: string
  /**
   * The slash line the confirmation carries, when the raw one the agent typed
   * would not name the act.
   *
   * A confirmation waits for a human, and the world moves while it waits. A
   * flow whose bare form resolves an implicit target — "the active
   * repository" — would otherwise be re-parsed at confirm time and run
   * against whatever is active THEN, not what the label promised. Such a flow
   * resolves its target at ASK time and returns it here, so the button runs
   * the act the message described. Undefined keeps the raw line, which is
   * right for every flow whose payload already names its target.
   */
  readonly confirmArgs?: (payload: Record<string, unknown>) => string | undefined
  /**
   * Why a user-only flow is the human's alone (the three-door law,
   * apps/app/AGENTS.md): the gesture is physically theirs, or the answer is
   * theirs to give. The agent's refusal quotes it, and
   * flows/agent-parity.test.ts enumerates every one — a user-only flow
   * without a reason fails that gate.
   */
  readonly userOnlyReason?: string
  /**
   * THE FORM LAW (apps/app/AGENTS.md): what the flow says about the form a
   * missing-input invocation renders — labels, placeholders, the seam a
   * field's options come from, and the grammar inverses when the positional
   * default is wrong. The fields themselves derive from the input schema
   * (flows/FlowForms.ts); a flow with no hints still gets a derived form.
   */
  readonly form?: FormHints
  /**
   * The slash grammar of a flow declared at RUNTIME (a repository's flow
   * leaf, entries/flow.ts `repositoryFlowLeaves`). SlashPayload's table names
   * the app's own flows and cannot name one that arrives with a projection,
   * so such a flow carries its parser; the composer boundary consults the
   * table first and this second. Absent for every declared flow.
   */
  readonly grammar?: Grammar
}

/** The confirmation label an agent invocation of this flow needs, or undefined when it needs none. */
export const confirmLabel = (metadata: FlowMetadata, payload: Record<string, unknown>): string | undefined =>
  typeof metadata.confirm === "function" ? metadata.confirm(payload) : metadata.confirm

/**
 * One registered flow as the catalog sees it: its name beside its UI metadata.
 *
 * Structural on purpose. The runtime projects `{ binding, metadata }` entries
 * into this shape with {@link itemOf}, and the pure rules below never need the
 * executable half.
 */
export interface CatalogItem extends FlowMetadata {
  readonly name: string
  /** Input capability derived from the declaration; display hints do not decide syntax. */
  readonly acceptsArgs?: boolean
}

/**
 * One registered capability: the executable flow and the UI copy around it.
 *
 * `binding` is the whole capability — a flow declaration (name, description,
 * capabilities, effect tier, typed payload and success schemas) paired with the
 * handler that runs it, projected as a `FlowDescriptor`. `metadata` is only
 * what the catalog needs in order to render and rank it.
 */
export interface FlowEntry<R = never> {
  /** Data preparation only; never executes the flow or publishes a view. */
  readonly prepare?: (payload: Record<string, unknown>) => Promise<void>
  /** Copied from the same declaration; avoids projecting schemas for a name lookup. */
  readonly declaredName?: string
  readonly binding: FlowBinding.Binding<R>
  /** Controller promises observe FlowCancellation and must settle before the binding returns. */
  readonly cooperativeCancellation?: boolean
  readonly metadata: FlowMetadata
  /** The flow's input schema, kept beside the binding so the form derives from it (the descriptor does not carry it). */
  readonly input: Schema.Top
}

/** The declared name; external bindings can still supply it through their descriptor. */
export const nameOf = (entry: FlowEntry): string => entry.declaredName ?? entry.binding.descriptor.name

/** An entry projected into the plain record the pure catalog rules read. */
export const itemOf = (entry: FlowEntry): CatalogItem => ({
  name: nameOf(entry),
  ...entry.metadata,
  acceptsArgs: entry.input.ast._tag !== "Objects" ||
    entry.input.ast.propertySignatures.length > 0 || entry.input.ast.indexSignatures.length > 0
})

/** A door a flow may name in `runtimeAny`: a host capability from the bootstrap. */
export type FlowCapability = RuntimeCapability

/** Whether this bootstrap holds a flow door. */
export const flowCapabilityHeld = (bootstrap: Pick<AppBootstrap, "capabilities">, capability: FlowCapability): boolean =>
  bootstrap.capabilities.includes(capability)

/**
 * A door only the native app opens: the host-held Smithers Cloud PAT session,
 * and the desktop shell itself (`native.shell`).
 *
 * The local services (`local.*`) were retired with the local backend
 * (apps/app/docs/LOCAL-BACKEND-RETIREMENT.md): no host emits one and
 * `RuntimeCapabilitySchema` no longer accepts one.
 */
const nativeDoor = (capability: FlowCapability): boolean => capability === "cloud.pat" || capability === "native.shell"

/**
 * Whether a flow can exist only in the native app — the classification behind
 * the web app's honest refusal (docs/web-mode/PLAN.md §1).
 *
 * A `runtime` entry that is a native door settles it. An either/or flow
 * (`runtimeAny`) is native-only only when EVERY alternative is a native door.
 * A flow that names its `hosts` without the cloud is native-only by
 * declaration.
 */
export const nativeOnly = (metadata: FlowMetadata): boolean =>
  (metadata.runtime ?? []).some(nativeDoor) ||
  (metadata.runtimeAny !== undefined && metadata.runtimeAny.length > 0 && metadata.runtimeAny.every(nativeDoor)) ||
  (metadata.hosts !== undefined && !metadata.hosts.includes("cloud"))

/**
 * The door a host lacks for a declared flow: the host-held PAT session
 * (`cloud.pat`, the native app's Smithers Cloud session), or a door this
 * origin could grow (`origin`: the terminal relay, the Smithers Cloud
 * upstream, keys).
 */
export type MissingDoor = "cloud.pat" | "origin"

/**
 * Why a declared flow is absent from THIS bootstrap, by door — the
 * classification behind every honest refusal (docs/web-mode/PLAN.md §1).
 * Undefined when nothing is missing, and for a host-scoped flow on the other
 * host: that flow is about the other host, not a door this one lacks. The
 * native door is named only on the cloud host; on the native host a
 * missing door is always one the launch could grow.
 */
export const absentDoor = (metadata: FlowMetadata, bootstrap: AppBootstrap): MissingDoor | undefined => {
  const { hosts, runtime = [], runtimeAny } = metadata
  if (hosts !== undefined && !hosts.includes(bootstrap.host)) return undefined
  const has = (capability: FlowCapability): boolean => flowCapabilityHeld(bootstrap, capability)
  const missing = runtime.filter((capability) => !has(capability))
  const alternatives = runtimeAny !== undefined && runtimeAny.length > 0 && !runtimeAny.some(has) ? runtimeAny : []
  if (missing.length === 0 && alternatives.length === 0) return undefined
  if (bootstrap.host !== "cloud") return "origin"
  if (missing.includes("cloud.pat") || (alternatives.length > 0 && alternatives.every(nativeDoor))) return "cloud.pat"
  return "origin"
}

/**
 * Whether a model may invoke this flow.
 *
 * The trigger axis is the descriptor's own `modelInvocable` flag: user-only
 * browser mechanics (sign-in/out, reset, theme, chat.stop, send, maximize)
 * declare `modelInvocable: false`, so they never reach the agent's catalog and
 * the model can neither invoke them nor promise them.
 */
export const modelInvocable = (entry: FlowEntry): boolean => entry.binding.descriptor.modelInvocable

/**
 * A prerequisite a flow can declare via `requires`. The registry resolves
 * unmet requirements in declaration order: the FIRST unmet one wins, its
 * `fulfill` flow runs now, and the original flow re-enters `run` after the
 * predicate flips — so a flow with several requirements steps through them one
 * at a time (sign in → execute), each step re-checked against
 * live state, never a stale plan.
 */
export interface FlowRequirement {
  /** The id flows reference in `requires`. */
  readonly id: string
  /** True when the requirement is already met for this state. */
  readonly satisfied: (state: CommandState) => boolean
  /**
   * The registered flow that fulfills the requirement when unmet. A
   * requirement that is a pure wait — the app is already settling it — names
   * no flow: the command parks and resumes itself.
   */
  readonly fulfill?: string
  /** Honest one-line reason, shown when the requirement defers or fails a flow. */
  readonly reason: string
}

/*
 * The requirement table. Every entry's `satisfied` reads only CommandState, so
 * the table stays unit-testable; every entry's `fulfill` names a registered
 * flow, gated by parity.test.ts. A seam that can SATISFY a requirement
 * (identity load) calls resumeDeferredCommand — adding
 * a requirement here means wiring its satisfying seam there. The rows live in
 * the namespace module whose flow fulfills them (auth.ts today).
 */
export const flowRequirements: ReadonlyArray<FlowRequirement> = [
  ...auth.requirements,
  ...repo.requirements
]

/** The flow's unmet requirements for a state, in declaration order. */
export const unmetRequirements = (
  metadata: FlowMetadata,
  state: CommandState,
  table: ReadonlyArray<FlowRequirement> = flowRequirements
): Array<FlowRequirement> =>
  (metadata.requires ?? []).flatMap((id) => {
    const requirement = table.find((candidate) => candidate.id === id)
    return requirement === undefined || requirement.satisfied(state) ? [] : [requirement]
  })

/** The app state the recommendation rule reads, sampled from the store. */
export interface CommandState {
  readonly surface: "chat" | "world" | "connectors" | "flows" | "plugins"
  readonly typing: boolean
  readonly hasConnectors: boolean
  /** The plugins installed on this workspace (the session's shelf); optional so state fixtures stay minimal. */
  readonly pluginLibrary?: boolean
  readonly plugins?: ReadonlyArray<string>
  /** The validated session carries admin:true; the admin plugin registers only then. */
  readonly admin: boolean
  /** No validated session: the one next step is sign-in. */
  readonly signedOut: boolean
  /**
   * This host spends the DEPLOYMENT's own key behind its own session (the
   * cloud Worker with an identity seam). The local app spends the operator's
   * key on their own machine and asks nobody, so a spend there needs no
   * account. Optional so state fixtures stay minimal.
   */
  readonly hostSpendsOwnKey?: boolean
  /** The selected repository came from the public catalog: readable signed out. */
  readonly publicRepo?: boolean
  /** First run has not finished choosing the starting repository: a bare repository command waits, it does not ask. */
  readonly firstRunTargetPending?: boolean
  /** A named repository still needs a catalog answer before authorization. */
  readonly repositoryReadiness?: { readonly repo: string; readonly phase: "pending" | "unavailable" | "unrequested"; readonly error?: string; readonly scope?: "command" }
  /**
   * The user's recently run commands, most recent first (session
   * recentCommands). Optional so state fixtures stay minimal; missing = [].
   */
  readonly recent?: ReadonlyArray<string>
  /** The active card frame, when a prior command left the transcript maximized. */
  readonly maximizedCardId?: string | null
  /**
   * The identity answer, human-readable ("signed-in as will", "signed-out",
   * "unavailable", "unknown") — the model's truthful "am I logged in?"
   * source. Optional so state fixtures stay minimal.
   */
  readonly identity?: string
}

/** One row of the recommendation table a namespace module exports. */
export interface Recommendation {
  /** The flow to offer. */
  readonly name: string
  /** True when the state calls for the flow. */
  readonly when: (state: CommandState) => boolean
  /**
   * An exclusive recommendation is the whole answer when it applies; the
   * first applicable one in table order wins (typing beats signed-out).
   */
  readonly exclusive?: true
  /** The position among the applicable non-exclusive rows; lower leads. */
  readonly rank: (state: CommandState) => number
}

/*
 * The recommendation table, in precedence order: the exclusive rows resolve
 * in this order, and the rest sort by rank. Each row lives in the namespace
 * module that owns the flow it offers.
 */
export const recommendations: ReadonlyArray<Recommendation> = [
  ...chat.recommendations,
  ...auth.recommendations,
  ...wiki.recommendations,
  ...connector.recommendations,
  ...plugins.recommendations
]

/**
 * The ordered recommendations for an app state — the next-action output the
 * slash menu reads. The first entry is gold: signed-out, sign-in is the only
 * step; away from the chat, returning to it leads.
 */
export const recommendedNames = (state: CommandState): ReadonlyArray<string> => {
  const exclusive = recommendations.find((row) => row.exclusive === true && row.when(state))
  if (exclusive !== undefined) return [exclusive.name]
  return recommendations
    .filter((row) => row.exclusive !== true && row.when(state))
    .sort((left, right) => left.rank(state) - right.rank(state))
    .map((row) => row.name)
}

/*
 * ── The namespace tree ─────────────────────────────────────────────────
 *
 * A flow's namespace is its dotted head (`auth.sign-in` → `auth`). Every
 * Namespaced flows live in one; the only bare names are the surface
 * switches (`chat`, `wiki`, `connect`, `flows`, `plugins`), which ARE the top
 * level of the app and read wrong under any prefix. The hidden `world` alias of `wiki`
 * (entries/world.ts) never lists, so it needs no place here.
 */

/** The surface switches: the one legitimate top-level leaves. */
export const SURFACE_FLOWS: ReadonlyArray<string> = ["chat", "wiki", "connect", "flows", "plugins"]

export interface Namespace {
  readonly id: string
  readonly label: string
  readonly summary: string
}

/** The namespaces in display order; one the table lacks lists last, by id. */
export const NAMESPACES: ReadonlyArray<Namespace> = [
  setup.namespace,
  setup.ciNamespace,
  setup.choresNamespace,
  chat.namespace,
  appearance.namespace,
  repo.namespace,
  repos.namespace,
  repository.namespace,
  feature.namespace,
  connector.namespace,
  wiki.namespace,
  tab.namespace,
  flow.namespace,
  runs.namespace,
  approvals.namespace,
  issues.namespace,
  integrations.namespace,
  issue.namespace,
  prs.namespace,
  github.namespace,
  change.namespace,
  review.namespace,
  findings.namespace,
  box.namespace,
  workspace.namespace,
  egress.namespace,
  agent.namespace,
  files.namespace,
  search.namespace,
  palette.namespace,
  plugins.namespace,
  sync.namespace,
  branches.namespace,
  commits.namespace,
  env.namespace,
  secrets.namespace,
  model.namespace,
  history.namespace,
  notifications.namespace,
  browser.namespace,
  auth.namespace,
  account.namespace,
  cloud.namespace,
  billing.namespace,
  card.namespace,
  frame.namespace,
  approval.namespace,
  debug.namespace,
  app.namespace,
  signup.namespace,
  smithers.namespace,
  admin.namespace,
  system.namespace,
  toast.namespace
]

/** The namespace a flow name belongs to; a bare name has none. */
export const namespaceOf = (name: string): string | undefined => {
  const dot = name.indexOf(".")
  return dot === -1 ? undefined : name.slice(0, dot)
}

const namespaceRank = (id: string): number => {
  const index = NAMESPACES.findIndex((namespace) => namespace.id === id)
  return index === -1 ? NAMESPACES.length : index
}

/** The namespace record for an id, synthesized for one the table lacks. */
export const namespace = (id: string): Namespace =>
  NAMESPACES.find((candidate) => candidate.id === id) ?? { id, label: id, summary: "" }

/**
 * The namespaces that have at least one visible flow, in display order —
 * an empty namespace never shows, and neither does a hidden flow's.
 */
export const namespacesOf = <C extends CatalogItem>(
  commands: ReadonlyArray<C>
): Array<Namespace & { readonly count: number }> => {
  const counts = new Map<string, number>()
  for (const command of visible(commands)) {
    const id = namespaceOf(command.name)
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => namespaceRank(left) - namespaceRank(right) || left.localeCompare(right))
    .map(([id, count]) => ({ ...namespace(id), count }))
}

/** One row of the slash menu: a flow to run, a namespace to open, or a one-line note the listing needs. */
export type SlashRow<C extends CatalogItem> =
  | { readonly kind: "flow"; readonly flow: C; readonly recommended: boolean }
  | { readonly kind: "namespace"; readonly namespace: Namespace; readonly count: number }
  | { readonly kind: "note"; readonly text: string }

/**
 * The collision rule (owner decision, six-area plan): a repository may
 * declare a flow whose id is one of the app's namespaces (`review`). A bare
 * `/review` runs the repository's flow; `/review.` (the trailing dot) opens
 * the namespace; the listing for the bare name says so in one row.
 */
export const collisionNote = <C extends CatalogItem>(id: string): SlashRow<C> => ({
  kind: "note",
  text: `Enter runs /${id}, this repository's flow. Type /${id}. to open the ${id} flows instead.`
})

/**
 * The slash menu as a tree.
 *
 *  - a bare "/" lists the top level: the recommendations (gold) and the
 *    surface switches as leaves, then every non-empty namespace as a row the
 *    user opens (Enter / ArrowRight → the draft becomes `/ns.`);
 *  - `/ns.` (a namespace head with the dot, nothing more) lists that
 *    namespace's visible flows, uncapped — the branch IS the listing;
 *  - anything else is the flat fuzzy filter `slashItems` already does, so a
 *    user who knows a name loses nothing, plus the namespaces whose id the
 *    query starts (`/app` offers `appearance ›` above fuzzy leaves). An exact
 *    flow name always precedes prefix namespaces so Enter runs what was typed.
 */
export const slashTree = <C extends CatalogItem>(
  state: CommandState,
  needle: string,
  commands: ReadonlyArray<C>
): Array<SlashRow<C>> => {
  const query = needle.trim().toLowerCase()
  const namespaces = namespacesOf(commands)
  const asNamespace = (row: Namespace & { readonly count: number }): SlashRow<C> => ({
    kind: "namespace",
    namespace: { id: row.id, label: row.label, summary: row.summary },
    count: row.count
  })
  const asFlow = (item: SlashItem<C>): SlashRow<C> => ({ kind: "flow", flow: item.flow, recommended: item.recommended })
  if (query === "") {
    /*
     * The top level is the recommendations, then EVERY bare leaf in registry
     * order: the surface switches, then the repository's own flows (its
     * projection's rows, featured first). Uncapped on purpose: the cap
     * answers a fuzzy filter, where a wall hides the answer; the top level
     * is the map, and the namespace rows follow it anyway.
     */
    const recommended = slashItems(state, "", commands).filter((item) => item.recommended)
    const named = new Set(recommended.map((item) => item.flow.name))
    const bare = visible(offerable(state, commands))
      .filter((command) => namespaceOf(command.name) === undefined && !named.has(command.name))
      .map((flow): SlashItem<C> => ({ flow, recommended: false }))
    return [...recommended.map(asFlow), ...bare.map(asFlow), ...namespaces.map(asNamespace)]
  }
  const branch = query.endsWith(".") ? query.slice(0, -1) : undefined
  if (branch !== undefined && namespaces.some((row) => row.id === branch)) {
    const names = recommendedNames(state)
    return visible(commands)
      .filter((command) => namespaceOf(command.name) === branch)
      .map((flow) => ({ kind: "flow", flow, recommended: names.includes(flow.name) }))
  }
  const heads = query.includes(".")
    ? []
    : namespaces.filter((row) => row.id.startsWith(query) && row.id !== query).map(asNamespace)
  const collides = !query.includes(".") &&
    namespaces.some((row) => row.id === query) &&
    visible(commands).some((command) => command.name === query)
  const matches = slashItems(state, needle, commands)
  const exact = matches.filter(item => item.flow.name.toLowerCase() === query)
  const fuzzy = matches.filter(item => item.flow.name.toLowerCase() !== query)
  return [...(collides ? [collisionNote<C>(query)] : []), ...exact.map(asFlow), ...heads, ...fuzzy.map(asFlow)]
}

/**
 * §1.2: signed out, sign-in is the one step, so a listing offers only what
 * works signed out. The whole registry used to be listed: `/auth.sign-out`,
 * `/billing.upgrade`, `/issues.create`, every one of which needs a session.
 * Nothing is un-invokable: typing a name still defers through sign-in
 * (§6.2), which is why a flow the user named OUTRIGHT (the whole name) is
 * offered anyway. Enter on it is the deferral, never a different flow.
 * What changes is what the app PRESENTS as available.
 */
const offerable = <C extends CatalogItem>(state: CommandState, commands: ReadonlyArray<C>, query = ""): Array<C> =>
  state.signedOut
    ? commands.filter((command) => command.name.toLowerCase() === query || unmetRequirements(command, state).length === 0)
    : [...commands]

/** The flows listed to the user: hidden id-scoped actions never show. */
export const visible = <C extends CatalogItem>(
  commands: ReadonlyArray<C>
): Array<C> => commands.filter((command) => command.hidden !== true)

/** Model discovery is explicit for internal controls; invocation authority is unchanged. */
export const disclosedToAgent = (metadata: FlowMetadata): boolean =>
  metadata.hidden !== true || metadata.discloseToAgent === true

/** A needle matches a flow by name or summary, case-insensitively. */
export const matches = (command: CatalogItem, needle: string): boolean => {
  const query = needle.trim().toLowerCase()
  if (query === "") return true
  return command.name.toLowerCase().includes(query) || command.summary.toLowerCase().includes(query)
}

/**
 * How directly a flow answers a needle, best first: its own name exactly, then
 * a name that starts with it, then a name that contains it, then a match that
 * only the summary carried.
 *
 * Matching on the summary is what makes the menu searchable ("/repo" finds the
 * flows that talk about repositories), but it must never outrank a name. Before
 * this rank existed, `/flows` listed `flow.list` first — its summary reads
 * "List the flows on your workspace" and it is declared 450 lines earlier
 * in the registry — so Enter ran a different flow than the one the user typed.
 */
const nameRank = (command: CatalogItem, query: string): number => {
  if (query === "") return 0
  const name = command.name.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  return 3
}

/**
 * The matching flows, closest match first. Registry order still decides inside
 * a rank: the sort is stable, so this only ever moves a better answer forward.
 */
export const filtered = <C extends CatalogItem>(needle: string, commands: ReadonlyArray<C>): Array<C> => {
  const query = needle.trim().toLowerCase()
  const shown = commands.filter((command) => matches(command, needle))
  return shown.sort((left, right) => nameRank(left, query) - nameRank(right, query))
}

export interface SlashItem<C extends CatalogItem> {
  readonly flow: C
  readonly recommended: boolean
}

/**
 * A listing longer than this is a wall, not a menu: past the cap, the
 * recommendations plus the user's most recent commands (still matching the
 * filter) are the listing, and the rest stays reachable by typing more.
 */
export const SLASH_MENU_CAP = 8

/**
 * The slash menu's listing, best answer first — because the composer's Enter
 * runs whatever leads it.
 *
 * Match quality orders the listing (`nameRank`); a recommendation leads only
 * among equally good matches. For a bare "/" every flow ranks the same, so the
 * recommendations lead in recommendation order and the first is gold, exactly
 * as the doctrine says. Type a flow's whole name and that flow leads instead:
 * the user was more specific than the app's suggestion.
 *
 * Commands never appear twice. At or under the cap the remainder keeps registry
 * order; over it, recency ranks the remainder and the listing cuts at the cap —
 * but a recommendation, and anything the user named outright, always survives.
 */
export const slashItems = <C extends CatalogItem>(
  state: CommandState,
  needle: string,
  commands: ReadonlyArray<C>
): Array<SlashItem<C>> => {
  const query = needle.trim().toLowerCase()
  const shown = filtered(needle, visible(offerable(state, commands, query)))
  const names = recommendedNames(state)
  const recommendedSet = new Set(names)
  // Within one rank, the recommendations lead in recommendation order.
  const ordered = [0, 1, 2, 3].flatMap((rank) => {
    const tier = shown.filter((command) => nameRank(command, query) === rank)
    return [
      ...names.flatMap((name) => {
        const command = tier.find((candidate) => candidate.name === name)
        return command === undefined ? [] : [{ flow: command, recommended: true }]
      }),
      ...tier
        .filter((command) => !recommendedSet.has(command.name))
        .map((command) => ({ flow: command, recommended: false }))
    ]
  })
  if (ordered.length <= SLASH_MENU_CAP) return ordered
  // Over the cap. What the user named outright (an exact or prefix name match)
  // is never cut, and neither is a recommendation; recency decides who else
  // gets in. Recency chooses the survivors, never their order — the listing
  // above is the only ordering rule.
  /*
   * "Named outright" means the user typed the flow's WHOLE name. An empty
   * query names nothing and a prefix names a set, so neither earns the
   * exemption — treating them as exact matches made every one of the 65
   * visible flows a survivor on a bare "/", leaving `room` at zero and the
   * cap a no-op in exactly the case its doc comment calls "a wall".
   */
  const kept = (item: SlashItem<C>): boolean => item.recommended || (query !== "" && nameRank(item.flow, query) === 0)
  const survivors = ordered.filter(kept)
  const recency = new Map((state.recent ?? []).map((name, index) => [name, index]))
  // Stable sort: recent commands by recency, everything else keeps its order behind them.
  const ranked = ordered
    .filter((item) => !kept(item))
    .sort(
      (a, b) =>
        (recency.get(a.flow.name) ?? Number.POSITIVE_INFINITY) -
        (recency.get(b.flow.name) ?? Number.POSITIVE_INFINITY)
    )
  const room = Math.max(SLASH_MENU_CAP, survivors.length) - survivors.length
  const admitted = new Set([...survivors, ...ranked.slice(0, room)].map((item) => item.flow.name))
  return ordered.filter((item) => admitted.has(item.flow.name))
}

export { parseSubmit } from "@smthrs/ui/command-line"
export type { Submit } from "@smthrs/ui/command-line"
