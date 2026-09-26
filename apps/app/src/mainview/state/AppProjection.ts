import * as PromptQueue from "@smthrs/rpc/PromptQueue"
import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import type { ConfiguredModel, ModelBinding } from "@smthrs/rpc/ConfiguredModel"
import { bindingOf,seatAccepts } from "@smthrs/rpc/ConfiguredModel"
import { StatusRollupSchema } from "@smthrs/rpc/Health"
import { AGENT_TURN_FRONT_DOOR_CALL_PREFIX } from "@smthrs/rpc/NativeAgent"
import { z } from "zod"
import { approvalQuestionKey } from "../cards/ApprovalQuestion"
import { framePath } from "../runtime/FrameHistory"
import { accountOwnerOf, accountProviderChanged } from "./AccountOwner"
import { sameApproval } from "./ApprovalReference"
import type {
AppTransition,
Card,
ChangeRow,
CloudRepository,
CloudSessionRow,
CloudWorkspaceRow,
Frame,
FrameSnapshot,
GitHubAppStatusRow,
LocalRepositoryConnector,
Message,
Recommendation,
RepoTreeRow,
RepositoryCapabilityPattern,
Session,
StoredModel,
TabRow,
Toast,
WorkingCopy,
WorldDocument
} from "./AppState"
import {
AgentRoleSchema,
BillingAccountSchema,
BranchSchema,
CardHistorySchema,
CardPatchSchema,
CardSchema,
ChangeRowSchema,
CloudRepositorySchema,
CloudSessionRowSchema,
CloudWorkspaceRowSchema,
ConnectorOperationSchema,
DEFAULT_BRANCH_ID,
DEFAULT_WORKSPACE_ID,
FrameSchema,
GitHubAppStatusRowSchema,
HarnessSchema,
IdentitySessionSchema,
LocalRepositoryConnectorSchema,
MAIN_TAB_ID,
MessageSchema,
PinnedRepoSchema,
RECOMMENDATION_ID,
RecommendationSchema,
RepoSchema,
RepoTreeRowSchema,
RepositoryFlowsRowSchema,
SeatAssignmentSchema,
SessionSchema,
StarredTargetSchema,
StoredModelSchema,
TabSchema,
ToastSchema,
ToolCallRecordSchema,
TransitionRecordSchema,
WorkingCopySchema,
WorkspaceSchema,
WorldDocumentSchema,
cardFrameId,
conversationTabIdOf,
inConversation,
initialBillingAccount,
initialCloudSession,
initialConnectorOperation,
initialIdentitySession,
initialSession,
initialWorldDocuments,
mainTab,
parseRepoSelection,
repoIdFromRemote,
repoKeyOf,
flowDurationRowId,
FlowDurationsRowSchema,
repoTreeRowId,
rootFrameId
} from "./AppState"
import { CommandIntentSchema } from "./CommandIntent"
import { archiveNotice,conversationNotes } from "./ConversationArchive"
import { canonicalEventValue } from "./EventValue"
import { acceptStatus,exitedStatus,expireStatus } from "./HealthStatus"
import { HttpTurnLegSchema,HttpTurnSchema,httpToolLegCount,projectHttpFrame,settleHttpClaims,verifyHttpBatch } from "./HttpTurn"
import { pendingRecoveryScope,sameRecoveryScope } from "./PendingRecovery"
import { initialSignup, signupAfterIdentity } from "./Signup"
import { RepositoryContextSchema } from "./RepositoryContext"
import { NotificationReadReceiptSchema,RepositoryNotificationSchema,notificationReadVersion,notificationReceiptKey,type RepositoryNotification } from "./RepositoryNotifications"
import { impossibleAskOf,runLaunchCommandOf,toolResultLaunchedRun } from "./RunClaims"
import type { RuntimeApproval } from "./RuntimeProjection"
import {
RuntimeApprovalSchema,RuntimeProjectionIntegrityError,
RuntimeRunSchema,
observeRuntimeRun,observedRuntimeApproval,
projectRuntimeCard,
runtimeApprovalIdOf,
runtimeApprovalKey,
runtimeRunKey,
runtimeScopeOf,
snapshotRuntimeCard,
submitRuntimeApproval
} from "./RuntimeProjection"
import { toolActLine } from "./ToolActLine"
import { journalPayload } from "./TransitionDiagnostics"
import { projectWorkspaceCard,sharedCopyOf,snapshotCard } from "./WorkspaceViews"

/** The domain state whose meaning is defined by this reducer. Journal authority is never a domain row. */
export const APP_PROJECTION_SCHEMAS = {
  runtimeRuns: RuntimeRunSchema,
  runtimeApprovals: RuntimeApprovalSchema,
  httpTurns: HttpTurnSchema,
  httpTurnLegs: HttpTurnLegSchema,
  commandIntents: CommandIntentSchema,
  sessions: SessionSchema,
  messages: MessageSchema,
  connectors: LocalRepositoryConnectorSchema,
  connectorOperations: ConnectorOperationSchema,
  worldDocuments: WorldDocumentSchema,
  cards: CardSchema,
  repositoryContexts: RepositoryContextSchema,
  repositoryNotifications: RepositoryNotificationSchema,
  notificationReceipts: NotificationReadReceiptSchema,
  cardHistories: CardHistorySchema,
  approvalRequests: CardSchema,
  transitions: TransitionRecordSchema,
  identitySessions: IdentitySessionSchema,
  billingAccounts: BillingAccountSchema,
  toasts: ToastSchema,
  toolCalls: ToolCallRecordSchema,
  tabs: TabSchema,
  harnesses: HarnessSchema,
  agents: AgentRoleSchema,
  models: StoredModelSchema,
  seats: SeatAssignmentSchema,
  repos: RepoSchema,
  pinnedRepos: PinnedRepoSchema,
  starredTargets: StarredTargetSchema,
  workspaces: WorkspaceSchema,
  branches: BranchSchema,
  recommendations: RecommendationSchema,
  frames: FrameSchema,
  repositories: CloudRepositorySchema,
  workingCopies: WorkingCopySchema,
  cloudSessions: CloudSessionRowSchema,
  cloudWorkspaces: CloudWorkspaceRowSchema,
  changes: ChangeRowSchema,
  githubAppStatuses: GitHubAppStatusRowSchema,
  repoTree: RepoTreeRowSchema,
  repositoryFlows: RepositoryFlowsRowSchema,
  flowDurations: FlowDurationsRowSchema,
} as const
export type AppProjectionCollectionName = keyof typeof APP_PROJECTION_SCHEMAS
export const APP_PROJECTION_COLLECTION_NAMES = Object.keys(APP_PROJECTION_SCHEMAS) as AppProjectionCollectionName[]
export type AppProjectionRow<K extends AppProjectionCollectionName> = z.infer<(typeof APP_PROJECTION_SCHEMAS)[K]>
export type AppProjectionSnapshot = {
  readonly [K in AppProjectionCollectionName]: ReadonlyArray<AppProjectionRow<K>>
}
/** Exhaustive wire names: adding a domain transition requires a replay implementation. */
export const APP_TRANSITION_TYPES = {
  "gateway.run.observed": true,
  "gateway.run.observer.changed": true,
  "gateway.approvals.observed": true,
  "gateway.approval.submission.changed": true,
  "approval.answer.changed": true,
  "http.turn.started": true,
  "http.leg.prepared": true,
  "http.leg.accepted": true,
  "http.turn.batch.received": true,
  "http.tool.started": true,
  "http.tool.settled": true,
  "http.turn.interrupted": true,
  "command.intent.accepted": true,
  "command.intent.settled": true,
  "input.mode.changed": true,
  "dictation.changed": true,
  "prompt.queued": true,
  "prompt.removed": true,
  "prompt.queue.paused": true,
  "composer.changed": true,
  "chat.sign-in.required": true,
  "message.submitted": true,
  "message.response.delta": true,
  "message.response.completed": true,
  "message.response.failed": true,
  "message.retried": true,
  "message.response.cancelled": true,
  "session.turn.orphaned": true,
  "app.reset": true,
  "conversation.reset": true,
  "conversation.reset.asked": true,
  "conversation.cleared": true,
  "card.maximized": true,
  "card.minimized": true,
  "frame.navigated": true,
  "frame.forked": true,
  "devtools.toggled": true,
  "verbose.toggled": true,
  "experimental.toggled": true,
  "flow.invoked": true,
  "surfaces-menu.toggled": true,
  "connect-menu.toggled": true,
  "add-menu.toggled": true,
  "chat-filter.menu.toggled": true,
  "chat-filter.changed": true,
  "palette.toggled": true,
  "palette.actions.toggled": true,
  "palette.item.opened": true,
  "command.deferred": true,
  "command.deferral.cleared": true,
  "approvals.inbox.requested": true,
  "approvals.inbox.settled": true,
  "runs.open.requested": true,
  "runs.open.settled": true,
  "command.ran": true,
  "toolcall.recorded": true,
  "hint.dismissed": true,
  "first-run.dismissed": true,
  "signup.changed": true,
  "librarian.launches.changed": true,
  "coding.provider.requests.changed": true,
  "stack.wiki.requests.changed": true,
  "theme.changed": true,
  "palette.changed": true,
  "composer.control.changed": true,
  "surface.changed": true,
  "plugin.installed": true,
  "plugin.removed": true,
  "world.document.selected": true,
  "world.document.upserted": true,
  "wiki.pane.changed": true,
  "world.delete.asked": true,
  "world.document.removed": true,
  "connector.local.requested": true,
  "connector.local.cancelled": true,
  "connector.local.failed": true,
  "connector.local.connected": true,
  "connector.access.changed": true,
  "connector.removal.asked": true,
  "connector.removed": true,
  "card.recovered": true,
  "card.view.loaded": true,
  "card.navigated": true,
  "card.history.moved": true,
  "notifications.read": true,
  "notification.tagged": true,
  "repo.update.observed": true,
  "repo.update.published": true,
  "card.upsert": true,
  "card.updated": true,
  "card.approval.decision.pending": true,
  "card.approval.decision.failed": true,
  "card.approval.observed": true,
  "card.approval.decided": true,
  "identity.session.loaded": true,
  "identity.access.requested": true,
  "identity.access.failed": true,
  "identity.session.cleared": true,
  "billing.refreshed": true,
  "billing.plans.loaded": true,
  "billing.unavailable": true,
  "toast.shown": true,
  "toast.progressed": true,
  "toast.resolved": true,
  "toast.dismissed": true,
  "card.removed": true,
  "message.steered": true,
  "message.tool.executed": true,
  "message.claim.substituted": true,
  "message.appended": true,
  "tab.opened": true,
  "tab.selected": true,
  "tab.close.asked": true,
  "tab.closed": true,
  "tab.menu.toggled": true,
  "pty.status.observed": true,
  "status.expired": true,
  "pty.exited": true,
  "harnesses.loaded": true,
  "agents.loaded": true,
  "models.observed": true,
  "model.saved": true,
  "model.removed": true,
  "model.tested": true,
  "seat.assigned": true,
  "repos.loaded": true,
  "repositories.loaded": true,
  "repository.upserted": true,
  "workingcopies.workspaces.loaded": true,
  "cloud.session.loaded": true,
  "workspaces.loaded": true,
  "workspace.updated": true,
  "workspace.session.destroyed": true,
  "workspace.deleted": true,
  "change.loaded": true,
  "github.app-status.loaded": true,
  "repo.pinned": true,
  "repo.unpinned": true,
  "repo.selected": true,
  "repository.entry.changed": true,
  "repository.command.changed": true,
  "repository-flows.loaded": true,
  "flow-durations.loaded": true,
  "repo-tree.toggled": true,
  "repo-tree.loading": true,
  "repo-tree.loaded": true,
  "repo-tree.failed": true,
  "workspace.renamed": true,
  "workspace.rename.toggled": true,
  "target.starred": true,
  "target.unstarred": true,
  "recommendations.updated": true,
  "recommendations.deferred": true,
} as const satisfies Record<AppTransition["type"], true>
export type AppProjectionPersistenceMode = "opfs" | "localStorage" | "memory"
export interface AppProjectionEventContext {
  readonly transition: AppTransition
  readonly revision: number
  readonly createdAt: number
  readonly persistenceMode: AppProjectionPersistenceMode
  /** Recorded event input; absent on historical events, which never compacted. */
}
export interface AppProjectionSeedContext {
  readonly createdAt: number
  readonly theme: Session["theme"]
  readonly seedWiki: boolean
}

/** A single key contract shared by replay, persistence and verification. */
export const appProjectionKey = (collection: AppProjectionCollectionName, row: unknown): string => {
  if (typeof row !== "object" || row === null) throw new Error(`Invalid ${collection} projection row`)
  const descriptor = Object.getOwnPropertyDescriptor(row, collection === "githubAppStatuses" ? "repo" : "id")
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") throw new Error(`Invalid ${collection} projection key`)
  return descriptor.value
}
export const emptyAppProjection = (): AppProjectionSnapshot =>
  Object.fromEntries(APP_PROJECTION_COLLECTION_NAMES.map(name => [name, []])) as unknown as AppProjectionSnapshot

interface ProjectionCollection<Row> {
  readonly size: number
  readonly get: (key: string) => Row | undefined
  readonly has: (key: string) => boolean
  readonly keys: () => IterableIterator<string>
  readonly values: () => IterableIterator<Row>
  readonly insert: (rows: Row | ReadonlyArray<Row>) => void
  readonly update: (key: string, mutate: (draft: Row) => void) => void
  readonly delete: (keys: string | ReadonlyArray<string>) => void
}
type ProjectionCollections = { readonly [K in AppProjectionCollectionName]: ProjectionCollection<AppProjectionRow<K>> }

/** Isolated copy-on-write working tables; neither input rows nor event payloads are mutated. */
const projectionDraft = (previous: AppProjectionSnapshot) => {
  const touched = new Set<AppProjectionCollectionName>()
  const tables = new Map<AppProjectionCollectionName, Map<string, unknown>>()
  const collections = Object.fromEntries(APP_PROJECTION_COLLECTION_NAMES.map(name => {
    // Physical storage order is not a fact. Stable keys break ties anywhere a
    // legacy selection has no explicit ordinal/date ordering (for example the
    // fallback Wiki document). This also makes shuffled checkpoints equivalent.
    const entries = previous[name].map(row => [appProjectionKey(name, row), row] as const)
      .sort(([a], [b]) => compareProjectionStrings(a, b))
    const rows = new Map<string, unknown>(entries)
    tables.set(name, rows)
    const decode = (row: unknown): unknown => APP_PROJECTION_SCHEMAS[name].parse(structuredClone(row))
    const collection: ProjectionCollection<unknown> = {
      get size() { return rows.size },
      get: key => rows.get(key), has: key => rows.has(key), keys: () => rows.keys(), values: () => rows.values(),
      insert: input => {
        for (const inputRow of Array.isArray(input) ? input : [input]) {
          const row = decode(inputRow)
          const key = appProjectionKey(name, row)
          if (rows.has(key)) throw new Error(`Projection row ${name}/${key} already exists`)
          rows.set(key, row)
          touched.add(name)
        }
      },
      update: (key, mutate) => {
        if (!rows.has(key)) throw new Error(`Projection row ${name}/${key} does not exist`)
        const draft = structuredClone(rows.get(key))
        mutate(draft)
        const row = decode(draft)
        if (appProjectionKey(name, row) !== key) throw new Error(`Projection update changed ${name}/${key} identity`)
        rows.set(key, row)
        touched.add(name)
      },
      delete: input => {
        for (const key of typeof input === "string" ? [input] : input) if (rows.delete(key)) touched.add(name)
      }
    }
    return [name, collection]
  })) as ProjectionCollections
  return {
    collections,
    finish: (): AppProjectionSnapshot => touched.size === 0 ? previous :
      Object.fromEntries(APP_PROJECTION_COLLECTION_NAMES.map(name => [name,
        touched.has(name) ? [...tables.get(name)!.values()] : previous[name]
      ])) as unknown as AppProjectionSnapshot
  }
}

/** The same working-copy union the reactive view serves, without a subscription or host. */
const projectedWorkingCopies = (collections: ProjectionCollections): Map<string, WorkingCopy> => {
  const workspaces = [...collections.cloudWorkspaces.values()]
  const stored = [...collections.workingCopies.values()]
  const rows: WorkingCopy[] = stored.filter(copy => !workspaces.some(workspace => workspace.id === copy.workspaceId))
  for (const workspace of workspaces) rows.push({
    id: `workspace:${workspace.id}`, repoId: workspace.repoId, kind: "workspace", label: workspace.name,
    ...(workspace.targetBookmark === null ? {} : { bookmark: workspace.targetBookmark }),
    workspaceId: workspace.id, state: workspace.status, updatedAt: workspace.updatedAt, revision: workspace.revision
  })
  for (const repository of collections.repositories.values()) {
    if (repository.catalog === true && !workspaces.some(workspace => workspace.repoId === repository.id) &&
      !stored.some(copy => copy.kind === "workspace" && copy.repoId === repository.id)) rows.push(sharedCopyOf(repository))
  }
  return new Map(rows.map(row => [row.id, row]))
}

const SESSION_ID = "main"
const PALETTE_RECENTS_CAP = 50
export const MAX_TRANSITION_RECORDS = 500
export const MAX_TOOL_CALL_RECORDS = 250
export const THEME_PICKER_CARD_ID = "theme-picker"
// Code-unit ordering is stable across host locales and replay environments.
const compareProjectionStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const staleLogKeys = <T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
  keep: number,
  order: (row: T) => number
): Array<string> => {
  if (rows.length <= keep) return []
  return [...rows]
    .sort((left, right) => order(left) - order(right) || compareProjectionStrings(left.id, right.id))
    .slice(0, rows.length - keep)
    .map((row) => row.id)
}
const transitionPayload = (transition: AppTransition): string => {
  const { actor: _actor, type: _type, ...payload } = transition
  // Native bearer capabilities are ephemeral, even if an untyped caller
  // accidentally puts one in a transition. The journal and verbose share this.
  return JSON.stringify(payload, (key, value) => key === "authorizationId" || (transition.type.startsWith("http.") && key === "token") ? undefined : value)
}

/** The id prefix of every verbose trace line, so switching off can remove them all. */
export const TRACE_MESSAGE_PREFIX = "message-trace-"
export const VERBOSE_ON_TEXT = "Verbose on — showing every flow, including hidden and background ones"
export const VERBOSE_OFF_TEXT = "Verbose off"

/*
 * Transitions verbose never traces: the per-keystroke and per-token streams
 * would bury everything else, and a user's own flow acts are already traced
 * as the `flow.invoked` record that settles them.
 */
const UNTRACED_TRANSITIONS: ReadonlySet<string> = new Set([
  "composer.changed",
  "message.response.delta",
  "http.turn.batch.received",
  "gateway.run.observed",
  "gateway.run.observer.changed",
  "gateway.approvals.observed",
  "gateway.approval.submission.changed",
  "approval.answer.changed",
  // Already a visible marker line in every transcript.
  "message.tool.executed",
  "verbose.toggled"
])

const TRACE_PAYLOAD_MAX = 160

/**
 * The one-line trace a transition renders under /verbose, or undefined when it
 * is not traced. Every flow invocation is traced (user, agent, hidden, alias,
 * deferred); beyond that, every transition an actor other than the user
 * dispatched — the background, system, and agent work a normal transcript
 * never shows.
 */
export const verboseTrace = (transition: AppTransition): string | undefined => {
  if (transition.type === "flow.invoked") {
    const who = transition.actor === "smithers" ? "Smithers" : "You"
    const args = transition.args === null ? "" : ` ${transition.args}`
    const detail = transition.detail === null ? "" : ` (${transition.detail})`
    const hidden = transition.hidden ? " [hidden]" : ""
    return `${who} ran /${transition.name}${args}${hidden} → ${transition.outcome}${detail} · ${transition.durationMs}ms`
  }
  if (transition.actor === "user" || UNTRACED_TRANSITIONS.has(transition.type)) return undefined
  const payload = transitionPayload(transition)
  const shown = payload === "{}"
    ? ""
    : ` ${payload.length > TRACE_PAYLOAD_MAX ? `${payload.slice(0, TRACE_PAYLOAD_MAX)}…` : payload}`
  return `${transition.actor}: ${transition.type}${shown}`
}

type ApprovalRequest = Extract<Card, { kind: "approval" | "approvals-inbox" }>
/*
 * The turn a session persisted before it recorded `turnId` was answering.
 * Only a submission row (`message-<turnId>-user`) names a turn: steering
 * inserts `message-steer-<revision>` user bubbles, so the newest user
 * message is not the turn in flight.
 */
const latestSubmittedTurnId = (messages: Iterable<Message>): string | undefined =>
  [...messages]
    .filter((message) => message.role === "user")
    .sort((left, right) => left.ordinal - right.ordinal)
    .reverse()
    .map((message) => message.id.match(/^message-(.+)-user$/)?.[1])
    .find((id) => id !== undefined)

const isApprovalRequest = (card: Card | undefined): card is ApprovalRequest =>
  card?.kind === "approval" || card?.kind === "approvals-inbox"

const freezeRequest = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeRequest(child)
    Object.freeze(value)
  }
  return value
}

type ApprovalCard = Extract<Card, { kind: "approval" }>

/**
 * The gate an approval card asks about — the thing a decision decides.
 *
 * A workflow gate is the run's own request id; the ask's wording is not part
 * of it, so restating the same gate in different words is still the same
 * decision. A chain park has no request id: the runtime reuses one card id per
 * lineage, and what changes between parks is the capability being asked for, so
 * that is the gate's identity there.
 */
const approvalGateKey = (card: ApprovalCard): string => {
  const { runId = "", requestId, chain, flow = "", capability } = card.payload
  return requestId === undefined
    ? `ask:${runId}:${chain === true}:${flow}:${capability}`
    : `gate:${runId}:${requestId}`
}

/**
 * The card, when it carries a decision a human already made.
 *
 * A recorded decision — not the "acted" status — is what freezes an approval.
 * The status is a generic terminal marker any card kind uses and a streamed
 * frame can set; the decision is the human's authorisation, and it is the thing
 * that must never be given twice. `AppController.runAwaitsApproval` reads the
 * same field to decide whether a run is still parked on a human.
 */
const decidedApproval = (card: Card | undefined): ApprovalCard | undefined =>
  card !== undefined && card.kind === "approval" && card.payload.decision !== undefined
    ? card
    : undefined
/** The strip's order: main first, then creation order. */
const orderedTabs = (collections: Pick<ProjectionCollections, "tabs">): Array<TabRow> =>
  [...collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal)

/*
 * Remove tabs from the strip in one transaction: the nearest surviving tab
 * to the left of the active one takes over (else main), a pending close
 * question about a removed tab is answered, and a harness tab's agent card
 * follows its process. Main is never removed.
 */
const closeTabRows = (
  collections: Pick<ProjectionCollections, "tabs" | "sessions" | "cards">,
  ids: ReadonlyArray<string>,
  revision: number
): void => {
  const closing: Array<TabRow> = []
  for (const id of ids) {
    const tab = collections.tabs.get(id)
    if (tab !== undefined && tab.kind !== "main") closing.push(tab)
  }
  if (closing.length === 0) return
  const closingIds = new Set(closing.map((tab) => tab.id))
  const activeId = collections.sessions.get(SESSION_ID)?.activeTabId ?? MAIN_TAB_ID
  let fallback: string | undefined
  if (closingIds.has(activeId)) {
    const ordered = orderedTabs(collections)
    const index = ordered.findIndex((candidate) => candidate.id === activeId)
    fallback = MAIN_TAB_ID
    for (let left = index - 1; left >= 0; left -= 1) {
      const candidate = ordered[left]!
      if (!closingIds.has(candidate.id)) {
        fallback = candidate.id
        break
      }
    }
  }
  collections.tabs.delete([...closingIds])
  for (const tab of closing) {
    if (tab.kind !== "harness") continue
    // Closing a subagent's tab stops its process; its card says so with no exit code to claim.
    for (const card of collections.cards.values()) {
      if (card.kind === "agent" && !("cloud" in card.payload) && card.payload.tabId === tab.id && card.payload.phase === "running") {
        collections.cards.update(card.id, (draft) => {
          if (draft.kind !== "agent" || "cloud" in draft.payload) return
          draft.payload.phase = "exited"
          draft.payload.exitCode = null
          draft.status = "acted"
        })
      }
    }
  }
  collections.sessions.update(SESSION_ID, (draft) => {
    if (fallback !== undefined) draft.activeTabId = fallback
    if (draft.pendingTabCloseId !== undefined && draft.pendingTabCloseId !== null && closingIds.has(draft.pendingTabCloseId)) {
      draft.pendingTabCloseId = null
    }
    draft.revision = revision
  })
}

/** The terminal tabs attached to cloud workspaces — all of them, or those of the named workspaces. */
const workspaceTabIds = (collections: Pick<ProjectionCollections, "tabs">, workspaceIds?: ReadonlySet<string>): Array<string> =>
  [...collections.tabs.values()]
    .filter((tab) =>
      tab.kind === "terminal" && tab.workspaceId !== undefined && (workspaceIds === undefined || workspaceIds.has(tab.workspaceId))
    )
    .map((tab) => tab.id)
const repositoryCapabilities = (
  root: string,
  access: LocalRepositoryConnector["access"]
): ReadonlyArray<RepositoryCapabilityPattern> => {
  const resource = `${root.replace(/\/$/, "")}/**`
  return [
    { action: "fs:read", resource },
    ...(access === "read-write" ? ([{ action: "fs:write", resource }] as const) : [])
  ]
}

/** One account-boundary predicate governs projection cleanup and private journal rotation. */
export const appTransitionErasesPrivateState = (snapshot: AppProjectionSnapshot, transition: AppTransition): boolean => {
  if (transition.type === "app.reset") return true
  const identity = snapshot.identitySessions.find(row => row.id === "identity")
  if (identity === undefined) return false
  if (transition.type === "identity.session.cleared") return true
  if (transition.type !== "identity.session.loaded") return false
  const owner = accountOwnerOf(identity)
  return owner !== null && (transition.state === "signed-out" ||
    (transition.state === "signed-in" && (owner !== transition.login || accountProviderChanged(identity.provider, transition.provider))))
}

/*
 * The next place at the END of the transcript.
 *
 * Messages and cards are ONE ordered list, so they must number themselves off
 * one counter. Numbering a message over the messages alone put every message
 * posted after a card above that card — and because the ordinals persist, the
 * wrong order survived a reload (§7.5).
 */
/*
 * Writes a model over its stored row. Updates merge fields, so the optional
 * ones the new record omits are cleared explicitly. A test is evidence about
 * one route: it survives only a write that leaves the route where it was.
 */
const writeModel = (draft: StoredModel, model: ConfiguredModel): void => {
  const rerouted = canonicalEventValue(bindingOf(draft)) !== canonicalEventValue(bindingOf(model))
  Object.assign(draft, { baseUrl: undefined, path: undefined, builtin: undefined }, model)
  if (rerouted) draft.lastTest = undefined
}

/*
 * A composer kept off the live cards, in an archived conversation, a frame's
 * snapshot, a card history or a recovery, is read against the record as it is
 * now: an answer its binding did not give leaves, its fixture with it, and so
 * does an answer written before answers kept their binding. With `returning`
 * the card is coming back from a conversation that left, and an ask it held
 * as out is over too: its answer had no card to land on.
 */
const currentModelCallCard = (collections: ProjectionCollections, card: Card, returning: boolean): Card => {
  if (card.kind !== "model-call") return card
  const record = collections.models.get(card.payload.model)
  const binding = record === undefined ? undefined : canonicalEventValue(bindingOf(record))
  const current = (evidence: { readonly binding?: ModelBinding | undefined } | undefined): boolean =>
    evidence?.binding !== undefined && canonicalEventValue(evidence.binding) === binding
  const { response, pending, asking: _asking, fixture, ...draft } = card.payload
  return { ...card, payload: {
    ...draft,
    ...(current(response) ? { response, ...(fixture === undefined ? {} : { fixture }) } : {}),
    ...(!returning && current(pending) ? { pending } : {})
  } }
}

/*
 * A composer's answer, its fixture and its ask that is still out are evidence
 * about one binding too. A model rebound or removed takes them off its
 * composer in the same commit, so a late answer finds no ask to settle and a
 * record recreated under the name inherits nothing. The draft is the
 * person's, and stays.
 */
const forgetModelCallEvidence = (collections: ProjectionCollections, id: string): void => {
  const forgotten = (card: Card): Card => {
    if (card.kind !== "model-call" || card.payload.model !== id) return card
    const { response: _response, pending: _pending, asking: _asking, fixture: _fixture, ...draft } = card.payload
    return { ...card, payload: draft }
  }
  const holds = (cards: ReadonlyArray<Card>): boolean => cards.some((card) => card.kind === "model-call" && card.payload.model === id)
  for (const card of [...collections.cards.values()]) {
    if (card.kind !== "model-call" || card.payload.model !== id) continue
    collections.cards.update(card.id, (draft) => {
      if (draft.kind !== "model-call") return
      delete draft.payload.response
      delete draft.payload.pending
      delete draft.payload.asking
      delete draft.payload.fixture
    })
  }
  // The same composer wherever else it is kept: a record recreated under the name inherits nothing from there either.
  for (const branch of [...collections.branches.values()]) {
    if (branch.snapshot === undefined || !holds(branch.snapshot.cards)) continue
    collections.branches.update(branch.id, (draft) => { draft.snapshot = { ...draft.snapshot!, cards: draft.snapshot!.cards.map(forgotten) } })
  }
  for (const frame of [...collections.frames.values()]) {
    if (frame.snapshot === undefined || !holds(frame.snapshot.cards)) continue
    collections.frames.update(frame.id, (draft) => { draft.snapshot = { ...draft.snapshot!, cards: draft.snapshot!.cards.map(forgotten) } })
  }
  for (const history of [...collections.cardHistories.values()]) {
    if (!holds(history.entries)) continue
    collections.cardHistories.update(history.id, (draft) => { draft.entries = draft.entries.map(forgotten) })
  }
}

/** A stored record rewritten as `model`, its composer's evidence leaving with its route. */
const rewriteModel = (collections: ProjectionCollections, existing: StoredModel, model: ConfiguredModel): void => {
  const rerouted = canonicalEventValue(bindingOf(existing)) !== canonicalEventValue(bindingOf(model))
  collections.models.update(model.id, (draft) => { writeModel(draft, model) })
  if (rerouted) forgetModelCallEvidence(collections, model.id)
}

/*
 * Everything on screen that belonged to the account that just left.
 *
 * The transcript, its cards and the balance are persisted, so signing out and
 * reloading still rendered the previous account's repository names, balance
 * and open cards — on a shared machine, to whoever sits down next (§2.4).
 * Signing out empties them.
 *
 * World notes are deliberately NOT dropped: they are the product's memory of
 * the work on this machine, sign-out is not "delete my data", and losing them
 * is not undoable.
 */
const forgetAccountState = (collections: ProjectionCollections, createdAt: number): void => {
  for (
    const collection of [
      collections.messages,
      collections.cards,
      collections.cardHistories,
      collections.commandIntents,
      collections.httpTurns,
      collections.httpTurnLegs,
      collections.runtimeRuns,
      collections.runtimeApprovals,
      collections.repositoryContexts,
      collections.repositoryNotifications,
      collections.notificationReceipts,
      collections.approvalRequests,
      collections.toasts,
      collections.toolCalls,
      collections.transitions,
      collections.recommendations,
      collections.repositories,
      collections.workingCopies,
      collections.cloudWorkspaces,
      collections.changes,
      collections.githubAppStatuses,
      collections.repoTree,
      collections.repositoryFlows,
      collections.flowDurations,
      collections.models,
      collections.seats
    ]
  ) {
    const keys = [...(collection as { keys: () => Iterable<string> }).keys()]
    if (keys.length > 0) (collection as { delete: (keys: string[]) => void }).delete(keys)
  }
  // Cloud Wiki content and unsent CRDT updates belong to the signed-in account.
  const cloudNotes = [...collections.worldDocuments.values()].filter((row) => row.cloud !== undefined).map((row) => row.id)
  if (cloudNotes.length > 0) collections.worldDocuments.delete(cloudNotes)
  // Card tabs and cloud terminals also carry private repository names.
  closeTabRows(collections, [
    ...workspaceTabIds(collections),
    ...[...collections.tabs.values()].filter((tab) => tab.kind === "card").map((tab) => tab.id)
  ], collections.sessions.get(SESSION_ID)!.revision)
  collections.cloudSessions.update("cloud", (draft) => Object.assign(draft, initialCloudSession(createdAt)))
  const cardFrameKeys = [...collections.frames.values()]
    .filter((frame) => frame.kind === "card")
    .map((frame) => frame.id)
  if (cardFrameKeys.length > 0) collections.frames.delete(cardFrameKeys)
  // Archived conversations must obey the same account boundary as the live projection.
  for (const branch of collections.branches.values()) {
    if (branch.snapshot !== undefined) collections.branches.update(branch.id, (draft) => { delete draft.snapshot })
  }
  for (const frame of collections.frames.values()) {
    if (frame.snapshot !== undefined) collections.frames.update(frame.id, (draft) => { delete draft.snapshot })
  }
  collections.sessions.update(SESSION_ID, (draft) => {
    const branchId = draft.activeBranchId ?? DEFAULT_BRANCH_ID
    if (draft.signup !== undefined) draft.signup = initialSignup()
    draft.draft = ""
    delete draft.queuedPrompts
    delete draft.promptQueuePaused
    draft.pendingCommand = null
    delete draft.repositoryCommandEntry
    delete draft.approvalsInboxRequests
    delete draft.runOpenRequests
    draft.phase = "idle"
    draft.composerOwner = "user"
    draft.turnTabId = null
    draft.turnId = null
    draft.devtoolsOpen = false
    draft.resetConfirmOpen = false
    draft.paletteActionsRef = null
    draft.paletteLastQuery = ""
    draft.paletteRecents = []
    if (draft.selectedWorldDocumentId !== null && cloudNotes.includes(draft.selectedWorldDocumentId)) {
      draft.selectedWorldDocumentId = [...collections.worldDocuments.values()][0]?.id ?? null
    }
    draft.activeRepoKey = null
    delete draft.librarianLaunches
    delete draft.wikiRequests
    draft.maximizedCardId = null
    draft.activeFrameId = rootFrameId(branchId)
  })
  const reset = initialBillingAccount()
  if (collections.billingAccounts.get("billing") === undefined) {
    collections.billingAccounts.insert(reset)
  } else {
    collections.billingAccounts.update("billing", (draft) => {
      draft.planKey = reset.planKey
      draft.sandbox = reset.sandbox
      draft.plans = reset.plans
      draft.creditBalanceCents = reset.creditBalanceCents
      draft.creditResetsAt = reset.creditResetsAt
      draft.state = reset.state
      draft.totalUsd = reset.totalUsd
      draft.allowedToStartWork = reset.allowedToStartWork
      draft.lifetimeChargedUsd = reset.lifetimeChargedUsd
      draft.chargeCount = reset.chargeCount
      draft.refreshedAt = reset.refreshedAt
      draft.revision = reset.revision
    })
  }
}

/**
 * A successful session observation answers the requirement in the same durable
 * transaction. Keep the prompt, order, and original action as history; sign-out
 * cannot resurrect it. Older stored actions infer their requirement from the
 * door. Never infer success from a persisted session at boot or a mere click.
 */
const answerSignInPrompts = (
  collections: Pick<ProjectionCollections, "messages" | "cards"> & Partial<Pick<ProjectionCollections, "toasts">>,
  requirement: "identity" | "cloud",
  login: string | null,
  answeredAt: number,
  provider?: "github" | "local"
): void => {
  // Omitted provider preserves pre-provider journal receipts byte-for-byte.
  const answer = `${requirement === "identity" ? (provider === "local" ? "Signed in" : "Signed in with GitHub") : "Signed in to Smithers Cloud"}${login ? ` as @${login}` : ""}.`
  const matches = (action: Message["action"]): boolean => {
    if (!action || (action.flow !== "auth.sign-in" && action.flow !== "cloud.sign-in")) return false
    return (action.signInRequirement ?? (action.flow === "cloud.sign-in" ? "cloud" : "identity")) === requirement
  }
  for (const message of collections.messages.values()) {
    if (!matches(message.action)) continue
    const answeredAction = { ...message.action!, answer, answeredAt }
    collections.messages.update(message.id, draft => {
      draft.answeredAction = answeredAction
      draft.action = undefined
    })
  }
  for (const toast of collections.toasts?.values() ?? []) {
    if (!matches(toast.action)) continue
    const answeredAction = { ...toast.action!, answer, answeredAt }
    collections.toasts!.update(toast.id, draft => {
      draft.answeredAction = answeredAction
      draft.action = undefined
      draft.updatedAt = answeredAt
      // The requirement succeeded; the attempted command may still have failed.
    })
  }
  if (requirement === "identity") {
    for (const card of collections.cards.values()) {
      if (card.kind === "anonymous-ceiling" && card.status !== "acted") {
        collections.cards.update(card.id, draft => { draft.status = "acted" })
      } else if (card.kind === "connect") {
        const connected = provider !== "local"
        const githubLogin = connected ? login : null
        if (card.payload.github.connected !== connected || card.payload.github.login !== githubLogin ||
            (provider !== undefined && card.payload.provider !== provider)) {
          collections.cards.update(card.id, draft => {
            if (draft.kind !== "connect") return
            draft.payload.github = { connected, login: githubLogin }
            if (provider !== undefined) draft.payload.provider = provider
          })
        }
      }
    }
  }
}


const nextOrdinal = (collections: Pick<ProjectionCollections, "messages" | "cards">): number => {
  let highest = -1
  for (const message of collections.messages.values()) highest = Math.max(highest, message.ordinal)
  for (const card of collections.cards.values()) highest = Math.max(highest, card.ordinal)
  return highest + 1
}

const recordNotificationRead = (collections: ProjectionCollections, notificationId: string, version: string): void => {
  const id = notificationReceiptKey(notificationId, version)
  if (!collections.notificationReceipts.has(id)) collections.notificationReceipts.insert({ id, notificationId, version })
}

const projectNotificationObservation = (collections: ProjectionCollections, observed: RepositoryNotification): void => {
  // A source observation may already carry an upstream read receipt. Normalize
  // it once, then compute the compatibility field from the receipt collection.
  if (observed.readVersion !== undefined) recordNotificationRead(collections, observed.id, observed.readVersion)
  const row = { ...observed, readVersion: notificationReadVersion(observed, collections.notificationReceipts) }
  if (collections.repositoryNotifications.has(row.id)) collections.repositoryNotifications.update(row.id, draft => { Object.assign(draft, row) })
  else collections.repositoryNotifications.insert(row)
}

/** Explicit, versioned boot inputs make seed/migration behavior replayable. */
export const seedAppProjection = (previous: AppProjectionSnapshot, context: AppProjectionSeedContext): AppProjectionSnapshot => {
  const { createdAt, theme, seedWiki } = context
  if (!Number.isFinite(createdAt)) throw new Error("Invalid app boot context")
  const draft = projectionDraft(previous)
  const { collections } = draft
  // Custom definitions are retired; even pre-upgrade stores use only built-in roles.
  const oldAgents = [...collections.agents.keys()]
  if (oldAgents.length > 0) collections.agents.delete(oldAgents)
  for (const role of AGENT_ROLES) collections.agents.insert({ ...role })
  // Legacy cards establish a captured baseline only. They do not establish
  // missing gateway lifecycle events, cursors, or server approval timestamps.
  for (const card of [...collections.cards.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (card.kind !== "run-trace" || card.runtimeView?.revision !== undefined) continue
    // An authoring launch intent is not a gateway run until its receipt names one.
    if (card.payload.authoring !== undefined && card.payload.runId === "") continue
    const id = runtimeRunKey(card.payload)
    if (collections.runtimeRuns.has(id)) continue
    collections.runtimeRuns.insert({ id, scope: runtimeScopeOf(card)!, events: [], steps: [], baseline: card.payload, observedAt: createdAt, revision: 0 })
  }
  // A lost local decision response never proves an outcome. Re-observe the
  // exact remote gate after boot, without automatically submitting it again.
  for (const row of collections.runtimeApprovals.values()) if (row.pending) {
    collections.runtimeApprovals.update(row.id, draft => {
      draft.pending = undefined; draft.submissionId = undefined
      draft.error = "The previous decision's outcome is unknown. Check the recorded gate before deciding again."
    })
  }
  // Import only read facts that this installation actually retained. Archived
  // cards are evidence for their own versions, not for the current version.
  for (const row of collections.repositoryNotifications.values()) {
    if (row.readVersion !== undefined) recordNotificationRead(collections, row.id, row.readVersion)
  }
  const importReadCards = (cards: Iterable<Card>): void => {
    for (const card of cards) if (card.kind === "repo-update") for (const item of card.payload.items) {
      if (item.read) recordNotificationRead(collections, item.id, item.version)
    }
  }
  importReadCards(collections.cards.values())
  for (const history of collections.cardHistories.values()) importReadCards(history.entries)
  for (const frame of collections.frames.values()) if (frame.snapshot) importReadCards(frame.snapshot.cards)
  for (const branch of collections.branches.values()) if (branch.snapshot) importReadCards(branch.snapshot.cards)
  for (const row of collections.repositoryNotifications.values()) {
    const readVersion = notificationReadVersion(row, collections.notificationReceipts)
    if (readVersion !== row.readVersion) collections.repositoryNotifications.update(row.id, draft => { draft.readVersion = readVersion })
  }
  // These observations belong to one host lifetime; a recorded boot expires them.
  for (const name of ["repoTree", "repositoryFlows", "flowDurations"] as const) {
    const keys = [...collections[name].keys()]
    if (keys.length > 0) collections[name].delete(keys)
  }
    if (collections.sessions.get(SESSION_ID) === undefined) {
      // A saved session row that no longer parses loads as absent while the
      // transition journal it numbered survives: continue that revision.
      const revision = Math.max(0, ...[...collections.transitions.values()].map(row => row.revision))
      collections.sessions.insert({ ...initialSession(theme), revision })
    } else {
      /*
       * Heal a session row persisted before newer required fields existed
       * (updates validate the FULL row, so one missing field would wedge every
       * later dispatch — composer typing included). Seed values fill exactly
       * the absent keys, once, so the schema stays strict with no migration
       * table. Generic over the seed so the next added field heals too.
       */
      const persisted = collections.sessions.get(SESSION_ID) as unknown as Record<string, unknown>
      const seed = initialSession(theme) as unknown as Record<string, unknown>
      const missing = Object.keys(seed).filter((key) => persisted[key] === undefined)
      if (missing.length > 0) {
        collections.sessions.update(SESSION_ID, (draft) => {
          const target = draft as unknown as Record<string, unknown>
          for (const key of missing) target[key] = seed[key]
        })
      }
    }
    // Wave 14 §1: nothing seeds the transcript. Signed out, the auth message is
    // the whole conversation; signed in, the transcript opens clean and the
    // inventory seam fills the repositories. See AppState's note.
    if (collections.connectorOperations.get("connector-operation") === undefined) {
      collections.connectorOperations
        .insert(initialConnectorOperation(createdAt))
    }
    if (seedWiki && collections.worldDocuments.size === 0) {
      collections.worldDocuments.insert([...initialWorldDocuments(createdAt)])
    } else if (!seedWiki) {
      // Only the untouched bootstrap placeholder is retired. User notes keep their content and identity.
      const stub = collections.worldDocuments.get("world-home")
      if (stub?.path === "World.md" && stub.title === "World" && stub.body === "# World\n\n" &&
        stub.updatedBy === "system" && stub.revision === 0 && stub.sources.length === 1 && stub.sources[0] === "system:bootstrap") {
        collections.worldDocuments.delete(stub.id)
      }
      if (!collections.worldDocuments.has(collections.sessions.get(SESSION_ID)?.selectedWorldDocumentId ?? "")) {
        collections.sessions.update(SESSION_ID, draft => { draft.selectedWorldDocumentId = null })
      }
    }
    if (collections.identitySessions.get("identity") === undefined) {
      collections.identitySessions.insert(initialIdentitySession(createdAt))
    }
    if (collections.billingAccounts.get("billing") === undefined) {
      collections.billingAccounts.insert(initialBillingAccount())
    }
    if (collections.cloudSessions.get("cloud") === undefined) {
      collections.cloudSessions.insert(initialCloudSession(createdAt))
    }
    if (collections.tabs.get(MAIN_TAB_ID) === undefined) {
      collections.tabs.insert(mainTab())
    }
    if (collections.workspaces.get(DEFAULT_WORKSPACE_ID) === undefined) {
      collections.workspaces.insert({
        id: DEFAULT_WORKSPACE_ID,
        title: "Smithers",
        createdAt: createdAt,
        revision: 0
      })
    }
    if (collections.branches.get(DEFAULT_BRANCH_ID) === undefined) {
      collections.branches.insert({
        id: DEFAULT_BRANCH_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        title: "Main",
        parentBranchId: null,
        forkedFromFrameId: null,
        forkedAtRevision: null,
        createdAt: createdAt,
        revision: 0
      })
    }
    const defaultRootFrameId = rootFrameId(DEFAULT_BRANCH_ID)
    if (collections.frames.get(defaultRootFrameId) === undefined) {
      collections.frames.insert({
        id: defaultRootFrameId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        branchId: DEFAULT_BRANCH_ID,
        kind: "root",
        parentFrameId: null,
        cardId: null,
        presentation: "embedded",
        stateRevision: 0,
        createdAt: createdAt,
        updatedAt: createdAt,
        revision: 0
      })
    }
    const session = collections.sessions.get(SESSION_ID)
    const workspaceId = session?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
    const branchId = session?.activeBranchId ?? DEFAULT_BRANCH_ID
    for (const card of collections.cards.values()) {
      const id = cardFrameId(branchId, card.id)
      if (collections.frames.get(id) !== undefined) continue
      collections.frames.insert({
        id,
        workspaceId,
        branchId,
        kind: "card",
        parentFrameId: rootFrameId(branchId),
        cardId: card.id,
        presentation: session?.maximizedCardId === card.id ? "maximized" : "embedded",
        stateRevision: session?.revision ?? 0,
        createdAt: card.createdAt,
        updatedAt: createdAt,
        revision: session?.revision ?? 0
      })
    }
    if (session?.maximizedCardId !== null && session?.maximizedCardId !== undefined) {
      const id = cardFrameId(branchId, session.maximizedCardId)
      if (collections.frames.get(id) !== undefined && session.activeFrameId !== id) {
        collections.sessions.update(SESSION_ID, (draft) => {
          draft.activeWorkspaceId = workspaceId
          draft.activeBranchId = branchId
          draft.activeFrameId = id
        })
      }
    }

  return draft.finish()
}

/**
 * The domain transition reducer. Replay invokes only this function: no dispatch,
 * React, clock, transport, storage, logging or effect execution is involved.
 * A refused transition returns the original snapshot; successful transitions
 * include their legacy bounded diagnostic row as a derived projection.
 */
export const projectAppEvent = (previous: AppProjectionSnapshot, context: AppProjectionEventContext): AppProjectionSnapshot => {
  let { transition } = context
  const { revision, createdAt, persistenceMode } = context
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(createdAt)) throw new Error("Invalid app event context")
  const draft = projectionDraft(previous)
  const { collections } = draft
  const current = collections.sessions.get(SESSION_ID)
  if (current === undefined) throw new Error("Smithers app projection is not initialized")
  if (revision !== current.revision + 1) throw new Error("App event does not follow the projected revision")
  const views = { workingCopies: projectedWorkingCopies(collections) }
  const approvalRequest = (id: string): ApprovalRequest | undefined => {
    const request = collections.approvalRequests.get(id)
    return isApprovalRequest(request) ? freezeRequest(structuredClone(CardSchema.parse(request)) as ApprovalRequest) : undefined
  }
  if ((transition.type === "card.upsert" || transition.type === "card.view.loaded") && transition.card.kind === "env") {
    transition = { ...transition, card: CardSchema.parse(transition.card) }
  } else if (transition.type === "card.updated" &&
    (transition.patch.kind ?? collections.cards.get(transition.id)?.kind) === "env") {
    transition = { ...transition, patch: CardPatchSchema.parse({ ...transition.patch, kind: "env" }) }
  }
  let applied = false
  // A transport batch uses the same primitive cases as ordinary dispatch.
  // Nested facts share one authoritative revision and use a stable position
  // suffix for rows which normally derive their identity from that revision.
  const reduce = (nestedTransition: AppTransition = transition, position?: number | string): void => {
      const transition = nestedTransition
      const current = collections.sessions.get(SESSION_ID)!
      const recordId = position === undefined ? `${revision}` : `${revision}-${position}`
      const activeWorkspaceId = current.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
      const activeBranchId = current.activeBranchId ?? DEFAULT_BRANCH_ID
      const currentCard = (card: Card): Card => projectRuntimeCard(projectWorkspaceCard(
        card, card.kind === "workspace" ? collections.cloudWorkspaces.get(card.payload.workspaceId) : undefined
      ), [...collections.runtimeRuns.values()], [...collections.runtimeApprovals.values()])
      const capturedCard = (card: Card): Card => snapshotRuntimeCard(snapshotCard(currentCard(card)),
        [...collections.runtimeRuns.values()], [...collections.runtimeApprovals.values()], revision)
      const snapshot = (): FrameSnapshot => ({
        revision,
        messages: [...collections.messages.values()],
        cards: [...collections.cards.values()].map(capturedCard),
        worldDocuments: [...collections.worldDocuments.values()],
        draft: collections.sessions.get(SESSION_ID)?.draft ?? "",
        selectedWorldDocumentId: collections.sessions.get(SESSION_ID)?.selectedWorldDocumentId ?? null
      })
      const restoreSnapshot = (saved: FrameSnapshot): void => {
        const messageIds = new Set(saved.messages.map((row) => row.id))
        const cardIds = new Set(saved.cards.map((row) => row.id))
        const worldIds = new Set(saved.worldDocuments.map((row) => row.id))
        const messageKeys = [...collections.messages.keys()].filter((id) => !messageIds.has(id))
        const cardKeys = [...collections.cards.keys()].filter((id) => !cardIds.has(id))
        const worldKeys = [...collections.worldDocuments.keys()].filter((id) => !worldIds.has(id))
        if (messageKeys.length > 0) collections.messages.delete(messageKeys)
        if (cardKeys.length > 0) collections.cards.delete(cardKeys)
        if (worldKeys.length > 0) collections.worldDocuments.delete(worldKeys)
        const replace = (draft: object, row: object): void => {
          const target = draft as Record<string, unknown>
          for (const key of Object.keys(target)) if (!(key in row)) delete target[key]
          Object.assign(draft, row)
        }
        for (const row of saved.messages) {
          if (collections.messages.get(row.id) === undefined) collections.messages.insert(row)
          else collections.messages.update(row.id, (draft) => replace(draft, row))
        }
        for (const savedCard of saved.cards) {
          const row = currentModelCallCard(collections, snapshotRuntimeCard(snapshotCard(savedCard), [], [], saved.revision), true)
          if (collections.cards.get(row.id) === undefined) collections.cards.insert(row)
          else collections.cards.update(row.id, (draft) => replace(draft, row))
        }
        for (const savedRow of saved.worldDocuments) {
          // A recorded Wiki projection cannot revive a transport or publish its pending edits.
          const row = savedRow.cloud === undefined || savedRow.cloud.phase === "deleted" ? savedRow :
            { ...savedRow, cloud: { ...savedRow.cloud, phase: "cached" as const } }
          if (collections.worldDocuments.get(row.id) === undefined) collections.worldDocuments.insert(row)
          else collections.worldDocuments.update(row.id, (draft) => replace(draft, row))
        }
        collections.sessions.update(SESSION_ID, (draft) => {
          draft.draft = saved.draft
          draft.selectedWorldDocumentId = saved.selectedWorldDocumentId !== undefined
            ? saved.selectedWorldDocumentId
            : saved.worldDocuments[0]?.id ?? null
        })
        // Restoring an older conversation cannot undo a later observed login.
        // Answer only the restored projection, leaving the recorded snapshot
        // untouched. The revision check excludes a newer reauthentication step;
        // current toasts are not part of this historical projection either.
        const restored = { messages: collections.messages, cards: collections.cards }
        const identity = collections.identitySessions.get("identity")
        if (identity?.state === "signed-in" && identity.sessionObservation && identity.sessionObservation.revision > saved.revision) {
          answerSignInPrompts(restored, "identity", identity.login, identity.sessionObservation.at, identity.provider)
        }
        const cloud = collections.cloudSessions.get("cloud")
        if (cloud?.state === "signed-in" && cloud.scopes !== "degraded" && cloud.revision > saved.revision) {
          answerSignInPrompts(restored, "cloud", cloud.username, cloud.updatedAt)
        }
      }
      /*
       * The conversation every row written by this dispatch belongs to
       * (docs/LOCAL-APP.md "Tabs"): undefined, the one Smithers conversation.
       * Read from `current` so a turn's replies land where the turn started;
       * the two helpers are the only way a message or a card enters its
       * collection here.
       */
      const conversationTabId = conversationTabIdOf(current)
      const insertMessage = (row: Message): void => {
        collections.messages.insert(conversationTabId === undefined ? row : { ...row, tabId: conversationTabId })
      }
      const insertCard = (row: Card): void => {
        collections.cards.insert(conversationTabId === undefined ? row : { ...row, tabId: conversationTabId })
      }
      const ensureCardFrame = (cardId: string): Frame => {
        const id = cardFrameId(activeBranchId, cardId)
        const existing = collections.frames.get(id)
        if (existing !== undefined) return existing
        const frame: Frame = {
          id,
          workspaceId: activeWorkspaceId,
          branchId: activeBranchId,
          kind: "card",
          parentFrameId: rootFrameId(activeBranchId),
          cardId,
          presentation: "embedded",
          stateRevision: revision,
          createdAt,
          updatedAt: createdAt,
          revision
        }
        collections.frames.insert(frame)
        return frame
      }
      switch (transition.type) {
        case "gateway.run.observed": {
          const id = runtimeRunKey(transition.observation.scope), previous = collections.runtimeRuns.get(id)
          const next = observeRuntimeRun(previous, transition.observation, createdAt, revision)
          if (previous === undefined) collections.runtimeRuns.insert(next)
          else if (next !== previous) collections.runtimeRuns.update(id, draft => { Object.assign(draft, next) })
          // Transport deduplication uses committed evidence before dispatch.
          // An explicit observation still needs a real receipt when its rows
          // merely match another pending optimistic write.
          break
        }
        case "gateway.run.observer.changed": {
          const id = runtimeRunKey(transition.scope), previous = collections.runtimeRuns.get(id)
          if (previous !== undefined && canonicalEventValue(previous.observer) === canonicalEventValue(transition.observer)) return
          if (previous === undefined) collections.runtimeRuns.insert({ id, scope: transition.scope, events: [], steps: [], observer: transition.observer, observedAt: createdAt, revision })
          else collections.runtimeRuns.update(id, draft => {
            draft.observer = transition.observer; draft.observedAt = createdAt; draft.revision = revision
            if (transition.observer.action === "retry") draft.steps = [...draft.steps, "Checking the run again…"].slice(-8)
          })
          break
        }
        case "gateway.approvals.observed": {
          // Validate the whole response before changing any gate.
          const observed = new Map<string, RuntimeApproval>()
          const rows = transition.rows.map(row => {
            if (row.payload.target._tag !== "Node") throw new RuntimeProjectionIntegrityError("Runtime gate needs a node target")
            const id = runtimeApprovalKey(transition.scope, row.requestId, row.payload.target.digest)
            const next = observedRuntimeApproval(observed.get(id) ?? collections.runtimeApprovals.get(id), transition.scope, row, createdAt, revision)
            observed.set(id, next)
            return next
          })
          for (const row of rows) {
            const previous = collections.runtimeApprovals.get(row.id)
            if (previous === row) continue
            if (previous === undefined) collections.runtimeApprovals.insert(row)
            else collections.runtimeApprovals.update(row.id, draft => { Object.assign(draft, row) })
          }
          break
        }
        case "approval.answer.changed": {
          const previous = collections.runtimeApprovals.get(transition.id)
          if (transition.actor !== "user" || previous === undefined || previous.row.status !== "pending" || previous.pending ||
            approvalQuestionKey(previous.row) !== transition.question ||
            previous.answerDraft?.question === transition.question && previous.answerDraft.text === transition.text) return
          collections.runtimeApprovals.update(previous.id, draft => {
            draft.answerDraft = { question: transition.question, text: transition.text }
            draft.revision = revision
          })
          break
        }
        case "gateway.approval.submission.changed": {
          const input = transition.submission, previous = collections.runtimeApprovals.get(input.id)
          if (previous === undefined || (input.state === "pending" && transition.actor !== "user") || (input.state === "failed" && transition.actor !== "system")) return
          const next = submitRuntimeApproval(previous, input, createdAt, revision)
          if (next === previous) return
          collections.runtimeApprovals.update(input.id, draft => { Object.assign(draft, next) })
          break
        }
        case "http.turn.started": {
          if (current.phase !== "idle" || collections.httpTurns.has(transition.attemptId) || collections.httpTurnLegs.has(transition.journal.legId)) return
          if (transition.text.trim() === "" || (transition.retry && collections.messages.get(`message-${transition.turnId}-user`)?.text !== transition.text.trim())) return
          reduce(transition.retry ? { type: "message.retried", actor: "user", turnId: transition.turnId }
            : { type: "message.submitted", actor: transition.actor, turnId: transition.turnId, text: transition.text }, 0)
          const owner = accountOwnerOf(collections.identitySessions.get("identity"))
          collections.httpTurns.insert({ id: transition.attemptId, turnId: transition.turnId, owner, legId: transition.journal.legId,
            status: "active", receivedText: false, askClass: impossibleAskOf(transition.text), claimBuffer: "", createdAt, revision })
          collections.httpTurnLegs.insert({ id: transition.journal.legId, attemptId: transition.attemptId, turnId: transition.turnId,
            ordinal: 0, journal: transition.journal, status: "prepared", createdAt })
          break
        }
        case "http.leg.prepared": {
          const turn = collections.httpTurns.get(transition.attemptId)
          const previousLeg = turn === undefined ? undefined : collections.httpTurnLegs.get(turn.legId)
          if (turn?.status !== "active" || current.phase !== "responding" || current.turnId !== turn.turnId || previousLeg?.status !== "tool-settled" ||
            collections.httpTurnLegs.has(transition.journal.legId)) return
          collections.httpTurnLegs.insert({ id: transition.journal.legId, attemptId: turn.id, turnId: turn.turnId,
            ordinal: previousLeg.ordinal + 1, journal: transition.journal, status: "prepared", createdAt })
          collections.httpTurns.update(turn.id, draft => { draft.legId = transition.journal.legId; draft.revision = revision })
          break
        }
        case "http.leg.accepted": {
          const turn = collections.httpTurns.get(transition.attemptId), leg = collections.httpTurnLegs.get(transition.legId)
          if (turn?.status !== "active" || turn.legId !== leg?.id || leg.attemptId !== turn.id || current.phase !== "responding" || current.turnId !== turn.turnId) return
          const cursor = transition.cursor
          if (cursor.runId !== turn.turnId || cursor.legId !== leg.id || cursor.batch !== 0 || cursor.position !== 0) throw new Error("Invalid HTTP acceptance cursor")
          if (leg.cursor !== undefined) return
          if (leg.status !== "prepared") return
          collections.httpTurnLegs.update(leg.id, draft => { draft.cursor = cursor; draft.status = "streaming" })
          break
        }
        case "http.turn.batch.received": {
          const turn = collections.httpTurns.get(transition.attemptId), leg = collections.httpTurnLegs.get(transition.legId)
          if (!turn || !leg || current.phase !== "responding" || current.turnId !== turn.turnId) return
          const cursor = verifyHttpBatch(turn, leg, transition.batch)
          if (cursor === undefined) return
          let nextTurn = turn, nextLeg = leg
          for (const [index, frame] of transition.batch.frames.entries()) {
            const projected = projectHttpFrame(nextTurn, nextLeg, frame, {
              answer: collections.messages.get(`message-${turn.turnId}-smithers`)?.text ?? "",
              card: id => collections.cards.get(id), protectedCard: id => approvalRequest(id) !== undefined,
              executedLegs: httpToolLegCount(collections.httpTurnLegs.values(), turn.id)
            })
            for (const [factIndex, fact] of projected.transitions.entries()) reduce(fact, `${transition.batch.from + index}.${factIndex}`)
            nextTurn = projected.turn; nextLeg = projected.leg
          }
          collections.httpTurns.update(turn.id, draft => { Object.assign(draft, nextTurn, { revision }) })
          collections.httpTurnLegs.update(leg.id, draft => { Object.assign(draft, nextLeg, { cursor }) })
          break
        }
        case "http.tool.started": {
          const turn = collections.httpTurns.get(transition.attemptId), leg = collections.httpTurnLegs.get(transition.legId)
          if (turn?.status !== "active" || current.phase !== "responding" || current.turnId !== turn.turnId || turn.legId !== leg?.id ||
            leg.attemptId !== turn.id || leg.status !== "tool-ready" || !leg.call) return
          collections.httpTurnLegs.update(leg.id, draft => { draft.status = "tool-executing" })
          break
        }
        case "http.tool.settled": {
          const turn = collections.httpTurns.get(transition.attemptId), leg = collections.httpTurnLegs.get(transition.legId)
          if (turn?.status !== "active" || current.phase !== "responding" || current.turnId !== turn.turnId || turn.legId !== leg?.id ||
            leg.attemptId !== turn.id || leg.status !== "tool-executing" || !leg.call) return
          /*
           * A call the front door minted (apps/server frontDoor.ts) is the
           * whole turn: its act line is the answer, and no model prose
           * follows it, so the claim surface has nothing to police.
           */
          const answersTurn = leg.call.callId.startsWith(AGENT_TURN_FRONT_DOOR_CALL_PREFIX)
          const launched = runLaunchCommandOf(leg.call.name, leg.call.args)
          if (!answersTurn && launched !== undefined && toolResultLaunchedRun(transition.result)) collections.httpTurns.update(turn.id, draft => { draft.runLaunch = launched; draft.revision = revision })
          collections.httpTurnLegs.update(leg.id, draft => { draft.status = "tool-settled"; draft.result = transition.result })
          reduce({ type: "toolcall.recorded", actor: "smithers", turnId: turn.turnId, name: leg.call.name, arguments: leg.call.args, result: transition.result }, 0)
          reduce({ type: "message.tool.executed", actor: "smithers", turnId: turn.turnId, text: toolActLine(leg.call, transition.result),
            ...(answersTurn ? { answersTurn: true as const } : {}) }, 1)
          break
        }
        case "http.turn.interrupted": {
          const turn = collections.httpTurns.get(transition.attemptId)
          if (turn?.status !== "active" || current.phase !== "responding" || current.turnId !== turn.turnId) return
          const claims = settleHttpClaims(turn, collections.messages.get(`message-${turn.turnId}-smithers`)?.text ?? "")
          for (const [index, fact] of claims.transitions.entries()) reduce(fact, index)
          collections.httpTurns.update(turn.id, draft => { Object.assign(draft, claims.turn, { status: transition.status, revision }) })
          if (collections.httpTurnLegs.has(turn.legId)) collections.httpTurnLegs.update(turn.legId, draft => { draft.status = transition.status })
          reduce(transition.silent ? { type: "message.response.completed", actor: "smithers", turnId: turn.turnId }
            : transition.status === "failed" ? { type: "message.response.failed", actor: "system", turnId: turn.turnId, message: transition.detail }
            : { type: "message.response.cancelled", actor: transition.actor, turnId: turn.turnId, detail: transition.detail }, 2)
          break
        }
        case "input.mode.changed":
          collections.sessions.update(SESSION_ID, (draft) => { draft.inputMode = transition.mode })
          break

        case "dictation.changed":
          collections.sessions.update(SESSION_ID, (draft) => { draft.dictating = transition.listening })
          break

        case "prompt.queued":
          collections.sessions.update(SESSION_ID, draft => {
            draft.queuedPrompts = [...PromptQueue.enqueue(draft.queuedPrompts ?? [], transition.prompt)]
            if (draft.draft.trim() === transition.prompt.text.trim()) draft.draft = ""
          })
          break
        case "prompt.removed": {
          const prompt = current.queuedPrompts?.find(item => item.id === transition.id)
          if (!prompt) return
          collections.sessions.update(SESSION_ID, draft => {
            draft.queuedPrompts = [...PromptQueue.remove(draft.queuedPrompts ?? [], transition.id)]
            if (transition.edit) {
              draft.draft = PromptQueue.restoreDraft([prompt], draft.draft)
              draft.paletteOpen = true
            }
          })
          break
        }
        case "prompt.queue.paused":
          collections.sessions.update(SESSION_ID, draft => { draft.promptQueuePaused = transition.paused })
          break

        case "chat.sign-in.required": {
          if (transition.turnId !== undefined && (current.phase !== "responding" || current.turnId !== transition.turnId)) return
          if (transition.attemptId !== undefined) {
            const turn = collections.httpTurns.get(transition.attemptId)
            if (turn?.status !== "active" || turn.turnId !== transition.turnId) return
            reduce({ type: "http.turn.interrupted", actor: "system", attemptId: turn.id, status: "failed", detail: "Sign in required.", silent: true }, 0)
          } else if (transition.turnId !== undefined) {
            reduce({ type: "message.response.completed", actor: "smithers", turnId: transition.turnId }, 0)
          }
          // The refusal and both recovery outputs share one durable receipt.
          if (current.draft === "" && transition.draft !== "") {
            reduce({ type: "composer.changed", actor: "system", draft: transition.draft }, 1)
          }
          const label = transition.provider === "github" ? "Sign in with GitHub" : "Sign in"
          reduce({ type: "message.appended", actor: "system", text: `${label} to send this message.`, action: { flow: "auth.sign-in", label } }, 2)
          break
        }
        case "composer.changed":
          if (transition.recoveryScope && !sameRecoveryScope(transition.recoveryScope, pendingRecoveryScope(current))) {
            const scope = transition.recoveryScope, branch = collections.branches.get(scope.branchId)
            if (scope.branchId === activeBranchId || branch?.workspaceId !== scope.workspaceId || !branch.snapshot) return
            collections.branches.update(branch.id, draft => { draft.snapshot = { ...draft.snapshot!, draft: transition.draft } })
            break
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = transition.draft
          })
          break

        case "message.submitted": {
          const text = transition.text.trim()
          if (text === "" || current.phase !== "idle") return
          if (!collections.messages.has(`message-${transition.turnId}-user`)) insertMessage({
            id: `message-${transition.turnId}-user`,
            role: "user",
            text,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            const queued = draft.queuedPrompts?.some(item => item.id === transition.turnId)
            if (queued) draft.queuedPrompts = [...PromptQueue.remove(draft.queuedPrompts ?? [], transition.turnId)]
            else draft.draft = ""
            draft.phase = "responding"
            // The turn belongs to the conversation it was asked in, whatever tab is active later.
            draft.turnTabId = conversationTabId ?? null
            draft.turnId = transition.turnId
          })
          break
        }

        case "message.response.delta": {
          if (transition.delta === "" || current.phase !== "responding" || current.turnId !== transition.turnId) return
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            insertMessage({
              id: messageId,
              role: "smithers",
              text: transition.channel === "text" ? transition.delta : "",
              reasoning: transition.channel === "reasoning" ? transition.delta : undefined,
              status: "complete",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              if (transition.channel === "reasoning") {
                draft.reasoning = (draft.reasoning ?? "") + transition.delta
              } else {
                draft.text += transition.delta
              }
            })
          }
          break
        }

        case "message.response.completed":
          if (current.phase !== "responding" || current.turnId !== transition.turnId) return
          // A chain turn may legitimately complete with no prose bubble
          // (act rows or a park told the story), so its matching completion
          // settles the phase even when there is no answer message.
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
          })
          break

        case "message.response.failed": {
          if (current.phase !== "responding" || current.turnId !== transition.turnId) return
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            insertMessage({
              id: messageId,
              role: "smithers",
              text: `I couldn't complete that turn. ${transition.message}`,
              status: "failed",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              draft.status = "failed"
              draft.statusDetail = transition.message
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            if (draft.queuedPrompts?.length) draft.promptQueuePaused = true
          })
          break
        }

        case "message.retried": {
          // The turn's own answer (and its act rows) make way for the
          // re-run; the user's message stays exactly where it was.
          if (current.phase !== "idle") return
          const userMessage = collections.messages.get(`message-${transition.turnId}-user`)
          if (userMessage === undefined) return
          const answerId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(answerId) !== undefined) {
            collections.messages.delete(answerId)
          }
          for (const message of collections.messages.values()) {
            if (message.act !== undefined && message.turnId === transition.turnId) collections.messages.delete(message.id)
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "responding"
            draft.turnId = transition.turnId
          })
          break
        }

        case "message.response.cancelled": {
          if (current.phase !== "responding" || current.turnId !== transition.turnId) return
          const messageId = `message-${transition.turnId}-smithers`
          const detail = transition.detail ?? "Stopped the current response."
          if (collections.messages.get(messageId) !== undefined) {
            collections.messages.update(messageId, (draft) => {
              draft.status = "interrupted"
              draft.statusDetail = detail
            })
          } else {
            // Killed before the first delta: there is no response to mark
            // up, so say what happened on that turn rather than leaving the
            // user's message hanging with nothing after it — same discipline
            // as `session.turn.orphaned`. A kill must never read as silence.
            insertMessage({
              id: messageId,
              role: "smithers",
              text: detail,
              status: "interrupted",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            if (draft.queuedPrompts?.length) draft.promptQueuePaused = true
          })
          break
        }

        case "session.turn.orphaned": {
          // The restored session claimed a turn was streaming, but the app
          // was closed — that stream is gone. Mark that turn's response
          // interrupted with the honest line; never restore a silently stuck
          // pending surface.
          //
          // The session names the turn it was answering, and that turn's
          // response lives at the id derived from it — resolving it that way
          // (rather than "the last Smithers message") is what keeps the
          // reconciliation honest: if the app died between the submit and the
          // first delta there is no response yet, and an earlier turn that
          // genuinely completed must not be relabelled as interrupted.
          if (current.phase !== "responding") return
          // A verified HTTP leg owns enough state to resume its committed output.
          // The recovery driver decides whether an uncompleted tool is ambiguous.
          if ([...collections.httpTurns.values()].some(turn => turn.turnId === current.turnId && turn.status === "active" &&
            collections.httpTurnLegs.get(turn.legId)?.attemptId === turn.id)) return
          const turnId = current.turnId ?? latestSubmittedTurnId(collections.messages.values())
          const orphaned = turnId === undefined
            ? undefined
            : collections.messages.get(`message-${turnId}-smithers`)
          if (orphaned !== undefined) {
            collections.messages.update(orphaned.id, (draft) => {
              draft.status = "interrupted"
              draft.statusDetail = "That turn was interrupted when the app closed."
            })
          } else if (turnId !== undefined) {
            // Died before the first delta: the turn has no response at all.
            // Say so on that turn rather than leaving the user's message
            // hanging with nothing after it (Launch Checklist B-1 asks for
            // restored work to be *correctly described*, not merely unstuck).
            insertMessage({
              id: `message-${turnId}-smithers`,
              role: "smithers",
              text: "That turn was interrupted when the app closed.",
              status: "interrupted",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.phase = "idle"
            draft.turnId = null
            if (draft.queuedPrompts?.length) draft.promptQueuePaused = true
          })
          break
        }

        case "app.reset": {
          for (const name of APP_PROJECTION_COLLECTION_NAMES) {
            if (name === "sessions") continue
            const collection = collections[name]
            const keys = [...collection.keys()]
            if (keys.length > 0) collection.delete(keys)
          }
          collections.sessions.update(SESSION_ID, draft => {
            const target = draft as unknown as Record<string, unknown>
            // Updates merge fields; explicit undefined clears optional persisted values.
            for (const key of Object.keys(target)) target[key] = undefined
            Object.assign(target, initialSession("light"), { revision })
          })
          break
        }

        case "conversation.reset": {
          // A reset clears the conversation it was asked in: a chat tab's own rows, or all of main's.
          const keys = [...collections.messages.values()]
            .filter((message) => inConversation(message, conversationTabId))
            .map((message) => message.id)
          if (keys.length > 0) collections.messages.delete(keys)
          // A reset conversation is empty — it does not re-seed a welcome.
          const cardKeys = [...collections.cards.values()]
            .filter((card) => inConversation(card, conversationTabId))
            .map((card) => card.id)
          if (cardKeys.length > 0) collections.cards.delete(cardKeys)
          const removedCards = new Set(cardKeys)
          const cardFrameKeys = [...collections.frames.values()]
            .filter((frame) => frame.branchId === activeBranchId && frame.kind === "card" && frame.cardId !== null && removedCards.has(frame.cardId))
            .map((frame) => frame.id)
          if (cardFrameKeys.length > 0) collections.frames.delete(cardFrameKeys)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "idle"
            if (draft.queuedPrompts?.length) draft.promptQueuePaused = true
            draft.composerOwner = "user"
            draft.maximizedCardId = null
            draft.activeFrameId = rootFrameId(activeBranchId)
            draft.resetConfirmOpen = false
          })
          break
        }

        case "conversation.reset.asked":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.resetConfirmOpen = transition.open
          })
          break

        case "conversation.cleared": {
          const branchId = transition.branchId
          const rootId = rootFrameId(branchId)
          if (collections.branches.has(branchId) || collections.frames.has(rootId)) {
            throw new Error("The new conversation already exists")
          }
          const saved = { ...snapshot(), revision: current.revision }
          if (transition.interruptedTurnId !== undefined) {
            const responseId = `message-${transition.interruptedTurnId}-smithers`
            const detail = "This turn was stopped when the conversation was archived."
            const response = saved.messages.find((message) => message.id === responseId)
            saved.messages = response === undefined
              ? [...saved.messages, { id: responseId, role: "smithers", text: detail, status: "interrupted", createdAt, ordinal: nextOrdinal(collections), ...(conversationTabId === undefined ? {} : { tabId: conversationTabId }) }]
              : saved.messages.map((message) => message.id === responseId ? { ...message, status: "interrupted" as const, statusDetail: detail } : message)
          }
          collections.branches.update(activeBranchId, (draft) => { draft.snapshot = saved })
          collections.branches.insert({
            id: branchId, workspaceId: activeWorkspaceId, title: `Conversation ${new Date(createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
            parentBranchId: activeBranchId, forkedFromFrameId: rootFrameId(activeBranchId),
            forkedAtRevision: current.revision, createdAt, revision
          })
          collections.frames.insert({
            id: rootId, workspaceId: activeWorkspaceId, branchId, kind: "root", parentFrameId: null,
            cardId: null, presentation: "embedded", stateRevision: revision, createdAt, updatedAt: createdAt, revision
          })
          for (const note of conversationNotes(transition.notes, saved.worldDocuments, activeBranchId, current.revision, branchId, revision, createdAt)) {
            collections.worldDocuments.insert(note)
          }
          // Legacy conversation rows are recoverable data too. Only remove
          // this conversation from the new branch's live projection. All
          // outgoing frames remain owned by the archived branch.
          const keys = [...collections.messages.values()].filter((row) => inConversation(row, conversationTabId)).map((row) => row.id)
          if (keys.length > 0) collections.messages.delete(keys)
          const cardKeys = saved.cards.filter((row) => inConversation(row, conversationTabId)).map((row) => row.id)
          if (cardKeys.length > 0) collections.cards.delete(cardKeys)
          const previous = framePath({ workspaceId: activeWorkspaceId, branchId: activeBranchId, frameId: rootFrameId(activeBranchId) })
          const kept = transition.notes.length
          insertMessage({
            id: `message-${revision}-cleared`,
            role: "smithers",
            text: archiveNotice(kept, previous, persistenceMode === "memory"),
            status: "complete",
            createdAt,
            ordinal: 0
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
            draft.phase = "idle"
            draft.composerOwner = "user"
            draft.maximizedCardId = null
            draft.activeBranchId = branchId
            draft.activeFrameId = rootId
            draft.turnTabId = null
            draft.turnId = null
            draft.resetConfirmOpen = false
          })
          break
        }

        case "card.maximized":
          if (collections.cards.get(transition.id) === undefined) return
          {
            const frame = ensureCardFrame(transition.id)
            const previousFrameId = current.activeFrameId
            if (previousFrameId !== undefined && previousFrameId !== frame.id && collections.frames.get(previousFrameId) !== undefined) {
              collections.frames.update(previousFrameId, (draft) => {
                draft.presentation = "embedded"
                draft.updatedAt = createdAt
                draft.revision = revision
              })
            }
            collections.frames.update(frame.id, (draft) => {
              draft.presentation = "maximized"
              draft.stateRevision = revision
              draft.snapshot = snapshot()
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.maximizedCardId = transition.id
            draft.activeWorkspaceId = activeWorkspaceId
            draft.activeBranchId = activeBranchId
            draft.activeFrameId = cardFrameId(activeBranchId, transition.id)
          })
          break

        case "card.minimized":
          if (current.activeFrameId !== undefined && collections.frames.get(current.activeFrameId) !== undefined) {
            collections.frames.update(current.activeFrameId, (draft) => {
              draft.presentation = "embedded"
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.maximizedCardId = null
            draft.activeWorkspaceId = activeWorkspaceId
            draft.activeBranchId = activeBranchId
            draft.activeFrameId = rootFrameId(activeBranchId)
          })
          break

        case "frame.navigated": {
          const workspace = collections.workspaces.get(transition.workspaceId)
          const branch = collections.branches.get(transition.branchId)
          const frame = collections.frames.get(transition.frameId)
          if (
            workspace === undefined ||
            branch?.workspaceId !== workspace.id ||
            frame?.workspaceId !== workspace.id ||
            frame.branchId !== branch.id ||
            (frame.cardId !== null && collections.cards.get(frame.cardId) === undefined &&
              !branch.snapshot?.cards.some((card) => card.id === frame.cardId))
          ) return
          if (branch.id !== activeBranchId) {
            if (current.phase === "responding") return
            const outgoing = snapshot()
            collections.branches.update(activeBranchId, (draft) => { draft.snapshot = outgoing })
            if (branch.snapshot !== undefined) restoreSnapshot(branch.snapshot)
          }
          if (current.activeFrameId !== undefined && current.activeFrameId !== frame.id && collections.frames.get(current.activeFrameId) !== undefined) {
            collections.frames.update(current.activeFrameId, (draft) => {
              draft.presentation = "embedded"
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          collections.frames.update(frame.id, (draft) => {
            draft.presentation = frame.kind === "card" ? "maximized" : "embedded"
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeWorkspaceId = workspace.id
            draft.activeBranchId = branch.id
            draft.activeFrameId = frame.id
            draft.maximizedCardId = frame.cardId
          })
          break
        }

        case "frame.forked":
          if (
            collections.branches.get(transition.branch.id) !== undefined ||
            collections.frames.get(transition.rootFrame.id) !== undefined ||
            collections.frames.get(transition.selectedFrame.id) !== undefined ||
            transition.branch.workspaceId !== transition.rootFrame.workspaceId ||
            transition.branch.workspaceId !== transition.selectedFrame.workspaceId ||
            transition.branch.id !== transition.rootFrame.branchId ||
            transition.branch.id !== transition.selectedFrame.branchId
          ) return
          if (current.phase === "responding") return
          collections.branches.update(activeBranchId, (draft) => { draft.snapshot = snapshot() })
          if (transition.branch.snapshot !== undefined) restoreSnapshot(transition.branch.snapshot)
          collections.branches.insert(transition.branch)
          collections.frames.insert(transition.rootFrame)
          if (transition.selectedFrame.id !== transition.rootFrame.id) collections.frames.insert(transition.selectedFrame)
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeWorkspaceId = transition.branch.workspaceId
            draft.activeBranchId = transition.branch.id
            draft.activeFrameId = transition.selectedFrame.id
            draft.maximizedCardId = transition.selectedFrame.cardId
          })
          break

        case "devtools.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.devtoolsOpen = transition.open
          })
          break

        case "experimental.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.experimental = transition.on
          })
          break

        case "verbose.toggled": {
          // Off removes every trace line: the transcript reads exactly as it
          // would have without verbose. The transition log keeps the records.
          if (!transition.on) {
            const traceKeys = [...collections.messages.keys()].filter((key) => key.startsWith(TRACE_MESSAGE_PREFIX))
            if (traceKeys.length > 0) collections.messages.delete(traceKeys)
          }
          insertMessage({
            id: `message-verbose-${revision}`,
            role: "smithers",
            text: transition.on ? VERBOSE_ON_TEXT : VERBOSE_OFF_TEXT,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.verbose = transition.on
          })
          break
        }

        case "flow.invoked":
          // Recorded by the transition insert below; rendered by the verbose
          // trace after the switch. The session row moves like every dispatch.
          break

        // Existing journals can contain these retired chrome events.
        case "surfaces-menu.toggled":
        case "connect-menu.toggled":
        case "add-menu.toggled":
          break

        case "chat-filter.menu.toggled":
          collections.sessions.update(SESSION_ID, draft => { draft.chatFilterMenuOpen = transition.open })
          break

        case "chat-filter.changed":
          collections.sessions.update(SESSION_ID, draft => { draft.chatFilter = transition.filter })
          break

        case "palette.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.paletteOpen = transition.open
            if (!transition.open) draft.paletteActionsRef = null
            if (transition.lastQuery !== undefined) draft.paletteLastQuery = transition.lastQuery
          })
          break

        case "palette.actions.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.paletteActionsRef = transition.ref
          })
          break

        case "palette.item.opened":
          collections.sessions.update(SESSION_ID, (draft) => {
            const rest = (draft.paletteRecents ?? []).filter((row) => row.ref !== transition.ref || row.kind !== transition.kind)
            const seen = (draft.paletteRecents ?? []).find((row) => row.ref === transition.ref && row.kind === transition.kind)
            draft.paletteRecents = [
              { ref: transition.ref, kind: transition.kind, count: (seen?.count ?? 0) + 1, lastSeen: transition.at },
              ...rest
            ].slice(0, PALETTE_RECENTS_CAP)
          })
          break

        case "command.deferred":
          collections.sessions.update(SESSION_ID, (draft) => {
            if (transition.repositoryRetry !== undefined) draft.repositoryEntry = { ...transition.repositoryRetry, phase: "pending" }
            if (transition.repositoryRequest !== undefined) draft.repositoryCommandEntry = { ...transition.repositoryRequest, phase: "pending" }
            draft.pendingCommand = {
              name: transition.name,
              args: transition.args,
              requirement: transition.requirement,
              requestedAt: createdAt
            }
          })
          break

        case "command.deferral.cleared":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingCommand = null
          })
          break

        case "approvals.inbox.requested":
          collections.sessions.update(SESSION_ID, (draft) => {
            // One request per target: a new ask replaces the earlier (or failed) one for the same repo/workspace.
            const others = (draft.approvalsInboxRequests ?? []).filter((row) =>
              row.repo !== transition.request.repo || row.workspaceId !== transition.request.workspaceId)
            draft.approvalsInboxRequests = [...others, { ...transition.request, requestedAt: createdAt }]
          })
          break

        case "approvals.inbox.settled":
          collections.sessions.update(SESSION_ID, (draft) => {
            // Only the request that was settled changes; a superseding ask keeps its own row.
            const rows = draft.approvalsInboxRequests ?? []
            if (!rows.some((row) => row.id === transition.id)) return
            draft.approvalsInboxRequests = transition.error === undefined
              ? rows.filter((row) => row.id !== transition.id)
              : rows.map((row) => row.id === transition.id ? { ...row, error: transition.error } : row)
          })
          break

        case "runs.open.requested":
          collections.sessions.update(SESSION_ID, (draft) => {
            const request = transition.request
            const others = (draft.runOpenRequests ?? []).filter(row => row.repo !== request.repo || row.workspaceId !== request.workspaceId || row.runId !== request.runId || row.cardId !== request.cardId)
            draft.runOpenRequests = [...others, { ...request, requestedAt: createdAt }]
          })
          break

        case "runs.open.settled":
          collections.sessions.update(SESSION_ID, (draft) => {
            const rows = draft.runOpenRequests ?? []
            if (!rows.some(row => row.id === transition.id)) return
            draft.runOpenRequests = transition.error === undefined ? rows.filter(row => row.id !== transition.id)
              : rows.map(row => row.id === transition.id ? { ...row, error: transition.error } : row)
          })
          break

        case "command.ran":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.recentCommands = [
              transition.name,
              ...(draft.recentCommands ?? []).filter((name) => name !== transition.name)
            ].slice(0, 20)
          })
          break

        case "toolcall.recorded":
          collections.toolCalls.insert({
            id: `toolcall-${recordId}`,
            turnId: transition.turnId,
            name: transition.name,
            arguments: transition.arguments,
            result: transition.result,
            createdAt
          })
          break

        case "command.intent.accepted":
          if (collections.commandIntents.has(transition.id)) return
          collections.commandIntents.insert({
            id: transition.id, name: transition.name, actor: transition.actor,
            source: transition.source, invocationKey: transition.invocationKey,
            acceptedAt: createdAt, acceptedRevision: revision, status: "accepted"
          })
          break

        case "command.intent.settled": {
          const intent = collections.commandIntents.get(transition.id)
          if (!intent || intent.status !== "accepted" || intent.actor !== transition.actor) return
          collections.commandIntents.update(intent.id, draft => {
            draft.status = "settled"
            draft.outcome = transition.outcome
            draft.retryable = transition.retryable ?? false
            draft.settledAt = createdAt
            draft.settledRevision = revision
          })
          break
        }

        case "hint.dismissed": {
          collections.sessions.update(SESSION_ID, draft => {
            if (!draft.hintsSeen?.includes(transition.id)) draft.hintsSeen = [...(draft.hintsSeen ?? []), transition.id]
          })
          break
        }
        case "first-run.dismissed": {
          collections.sessions.update(SESSION_ID, draft => { draft.firstRunDismissed = true })
          break
        }
        case "signup.changed": {
          collections.sessions.update(SESSION_ID, draft => { draft.signup = { ...(draft.signup ?? initialSignup()), ...transition.patch } })
          break
        }
        case "librarian.launches.changed": {
          collections.sessions.update(SESSION_ID, draft => { draft.librarianLaunches = transition.launches })
          break
        }
        case "coding.provider.requests.changed": {
          collections.sessions.update(SESSION_ID, draft => { draft.codingProviderRequests = transition.requests })
          break
        }
        case "stack.wiki.requests.changed": {
          collections.sessions.update(SESSION_ID, draft => { draft.wikiRequests = transition.requests })
          break
        }
        case "theme.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.theme = transition.theme
          })
          break

        case "palette.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.palette = transition.palette
          })
          break

        case "composer.control.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.composerOwner = transition.owner
            if (transition.draft !== undefined) draft.draft = transition.draft
          })
          break

        case "surface.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.surface = transition.surface
          })
          break

        /*
         * The plugin shelf: installing twice is the same shelf, so the write
         * is idempotent, and the order is the order a person added them.
         */
        case "plugin.installed":
          collections.sessions.update(SESSION_ID, (draft) => {
            const installed = draft.plugins ?? []
            if (!installed.includes(transition.plugin)) draft.plugins = [...installed, transition.plugin]
          })
          break

        case "plugin.removed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.plugins = (draft.plugins ?? []).filter((plugin) => plugin !== transition.plugin)
          })
          break

        case "world.document.selected":
          if (collections.worldDocuments.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.selectedWorldDocumentId = transition.id
          })
          break

        case "world.document.upserted": {
          const document: WorldDocument = {
            ...transition.document,
            updatedAt: createdAt,
            updatedBy: transition.actor,
            revision
          }
          if (transition.recoveryScope && (transition.recoveryScope.branchId !== activeBranchId || transition.recoveryScope.workspaceId !== activeWorkspaceId)) {
            const scope = transition.recoveryScope, branch = collections.branches.get(scope.branchId)
            if (branch?.workspaceId !== scope.workspaceId || !branch.snapshot) return
            collections.branches.update(branch.id, draft => { draft.snapshot = { ...draft.snapshot!,
              worldDocuments: [...draft.snapshot!.worldDocuments.filter(row => row.id !== document.id), document] } })
            break
          }
          if (collections.worldDocuments.get(document.id) === undefined) {
            collections.worldDocuments.insert(document)
          } else {
            collections.worldDocuments.update(document.id, (draft) => {
              Object.assign(draft, document)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            if (transition.select !== false) draft.selectedWorldDocumentId = document.id
          })
          break
        }

        case "wiki.pane.changed":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.wikiPane = transition.pane
            draft.wikiGraphPath = transition.path
          })
          break

        case "world.delete.asked": {
          if (transition.id !== null && collections.worldDocuments.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingWorldDeleteId = transition.id
          })
          break
        }

        case "world.document.removed": {
          if (collections.worldDocuments.get(transition.id) === undefined) return
          collections.worldDocuments.delete(transition.id)
          const remaining = [...collections.worldDocuments.values()].find(
            (document) => document.id !== transition.id
          )
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.selectedWorldDocumentId = remaining?.id ?? null
            // The question this answered is closed with it.
            if (draft.pendingWorldDeleteId === transition.id) draft.pendingWorldDeleteId = null
          })
          break
        }

        case "connector.local.requested":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "selecting-local-repository"
            draft.requestedAccess = transition.access
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break

        case "connector.local.cancelled":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break

        case "connector.local.failed":
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = transition.message
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break

        case "connector.local.connected": {
          const id = `local-repository:${transition.repository.root}`
          const existing = collections.connectors.get(id)
          const connector: LocalRepositoryConnector = {
            id,
            kind: "local-repository",
            status: "connected",
            access: transition.access,
            name: transition.repository.name,
            root: transition.repository.root,
            head: transition.repository.head,
            branch: transition.repository.branch,
            remoteUrl: transition.repository.remoteUrl,
            capabilities: [...repositoryCapabilities(transition.repository.root, transition.access)],
            createdAt: existing?.createdAt ?? createdAt,
            updatedAt: createdAt,
            revision
          }
          if (existing === undefined) {
            collections.connectors.insert(connector)
          } else {
            collections.connectors.update(id, (draft) => {
              Object.assign(draft, connector)
            })
          }
          collections.connectorOperations.update("connector-operation", (draft) => {
            draft.phase = "idle"
            draft.requestedAccess = null
            draft.error = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break
        }

        case "connector.access.changed":
          if (collections.connectors.get(transition.id) === undefined) return
          collections.connectors.update(transition.id, (draft) => {
            draft.access = transition.access
            draft.capabilities = [
              ...repositoryCapabilities(draft.root, transition.access)
            ]
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break

        case "connector.removal.asked":
          if (transition.id !== null && collections.connectors.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingConnectorRemovalId = transition.id
          })
          break

        case "connector.removed":
          if (collections.connectors.get(transition.id) === undefined) return
          collections.connectors.delete(transition.id)
          collections.sessions.update(SESSION_ID, (draft) => {
            if (draft.pendingConnectorRemovalId === transition.id) draft.pendingConnectorRemovalId = null
          })
          break

        case "card.navigated": {
          const currentCard = collections.cards.get(transition.card.id)
          if (!currentCard || isApprovalRequest(currentCard) || isApprovalRequest(transition.card) || approvalRequest(currentCard.id)) return
          const history = collections.cardHistories.get(currentCard.id)
          const snapshot = { ...capturedCard(currentCard), navigation: undefined }
          const entries = history ? [...history.entries.slice(0, history.index), snapshot] : [snapshot]
          entries.push({ ...transition.card, navigation: undefined, id: currentCard.id, ordinal: currentCard.ordinal, createdAt: currentCard.createdAt, tabId: currentCard.tabId })
          // Forward history belongs to the old path; a new navigation forks it.
          const bounded = entries.slice(-50)
          const index = bounded.length - 1
          const row = { id: currentCard.id, index, entries: bounded }
          if (history) collections.cardHistories.update(row.id, draft => { Object.assign(draft, row) })
          else collections.cardHistories.insert(row)
          collections.cards.update(row.id, draft => { Object.assign(draft, { loading: undefined, viewKey: undefined, viewRepo: undefined }, bounded[index], { navigation: { index, length: bounded.length } }) })
          for (const frame of collections.frames.values()) {
            if (frame.cardId !== row.id || frame.snapshot !== undefined || frame.branchId !== activeBranchId) continue
            collections.frames.update(frame.id, draft => { draft.stateRevision = revision; draft.updatedAt = createdAt; draft.revision = revision })
          }
          break
        }
        case "card.history.moved": {
          const history = collections.cardHistories.get(transition.id)
          const card = collections.cards.get(transition.id)
          if (!history || !card || isApprovalRequest(card) || approvalRequest(card.id)) return
          const index = history.index + transition.delta
          if (index < 0 || index >= history.entries.length) return
          if (isApprovalRequest(history.entries[index])) return
          const entries = [...history.entries]
          entries[history.index] = { ...capturedCard(card), navigation: undefined }
          collections.cardHistories.update(transition.id, draft => { draft.index = index; draft.entries = entries })
          collections.cards.update(transition.id, draft => { Object.assign(draft, { loading: undefined, viewKey: undefined, viewRepo: undefined }, currentModelCallCard(collections, entries[index]!, true), { navigation: { index, length: entries.length } }) })
          for (const frame of collections.frames.values()) {
            if (frame.cardId !== transition.id || frame.snapshot !== undefined || frame.branchId !== activeBranchId) continue
            collections.frames.update(frame.id, draft => { draft.stateRevision = revision; draft.updatedAt = createdAt; draft.revision = revision })
          }
          break
        }
        case "card.recovered": {
          // A recovered composer's ask resumes with the session (`resumeModelCalls`); an entry of its history holds none.
          const card = transition.card === null ? null : currentModelCallCard(collections, transition.card, false)
          const protectedCard = (row: Card): boolean => row.kind === "env" || row.kind === "approval" || row.kind === "approvals-inbox" ||
            (row.kind === "flow-form" && row.payload.flow === "env.set")
          if ((card !== null && (card.id !== transition.id || protectedCard(card))) || approvalRequest(transition.id)) return
          const history = transition.history
          if (history && (history.id !== transition.id || history.index >= history.entries.length || history.entries.some(row => row.id !== transition.id || protectedCard(row)))) return
          const active = transition.workspaceId === activeWorkspaceId && transition.branchId === activeBranchId
          if (!active) {
            const branch = collections.branches.get(transition.branchId)
            if (branch?.workspaceId !== transition.workspaceId || !branch.snapshot) return
            if (branch.snapshot.cards.some(row => row.id === transition.id && protectedCard(row))) return
            const cards = card === null ? branch.snapshot.cards.filter(row => row.id !== transition.id)
              : [...branch.snapshot.cards.filter(row => row.id !== transition.id), capturedCard(card)]
            collections.branches.update(branch.id, draft => { draft.snapshot = { ...draft.snapshot!, cards } })
            break
          }
          const existing = collections.cards.get(transition.id)
          if (existing && protectedCard(existing)) return
          if (card === null) {
            if (existing) collections.cards.delete(transition.id)
            if (collections.cardHistories.has(transition.id)) collections.cardHistories.delete(transition.id)
            break
          }
          if (existing) collections.cards.update(card.id, draft => { Object.assign(draft, { loading: undefined, viewKey: undefined, viewRepo: undefined }, card) })
          else collections.cards.insert(card)
          if (history) {
            const restored = { ...history, entries: history.entries.map((entry, index) => index === history.index ? currentModelCallCard(collections, entry, false) : capturedCard(currentModelCallCard(collections, entry, true))) }
            if (collections.cardHistories.has(history.id)) collections.cardHistories.update(history.id, draft => { Object.assign(draft, restored) })
            else collections.cardHistories.insert(restored)
          }
          ensureCardFrame(card.id)
          for (const frame of collections.frames.values()) {
            if (frame.cardId !== card.id || frame.branchId !== activeBranchId || frame.snapshot !== undefined) continue
            collections.frames.update(frame.id, draft => { draft.stateRevision = revision; draft.updatedAt = createdAt; draft.revision = revision })
          }
          break
        }
        case "notifications.read": {
          for (const { id, version } of transition.receipts) {
            const row = collections.repositoryNotifications.get(id)
            // A stale observation must never mark a newer update as read.
            if (row?.version !== version) continue
            recordNotificationRead(collections, id, version)
            const readVersion = notificationReadVersion(row, collections.notificationReceipts)
            if (readVersion !== row.readVersion) collections.repositoryNotifications.update(id, draft => { draft.readVersion = readVersion })
          }
          break
        }
        case "notification.tagged": {
          const row = collections.repositoryNotifications.get(transition.id)
          if (!row) return
          const tags = [...new Set([...row.tags, transition.tag])]
          collections.repositoryNotifications.update(row.id, draft => { draft.tags = tags })
          break
        }
        case "repo.update.observed": {
          const row = transition.context
          if (collections.repositoryContexts.has(row.id)) collections.repositoryContexts.update(row.id, draft => { Object.assign(draft, row) })
          else collections.repositoryContexts.insert(row)
          for (const notice of transition.notifications) projectNotificationObservation(collections, notice)
          break
        }
        case "repo.update.published":
        case "card.view.loaded":
        case "card.upsert": {
          if (transition.type === "repo.update.published") for (const row of transition.notifications) projectNotificationObservation(collections, row)
          const existing = collections.cards.get(transition.card.id)
          const trusted = approvalRequest(transition.card.id)
          const incoming = transition.card
          // Only runtime code creates approval authority. The model cannot
          // replace a protected id with a presentation card to bypass this.
          if ((isApprovalRequest(incoming) || isApprovalRequest(existing) || trusted !== undefined) &&
            transition.actor !== "system") return
          if (trusted !== undefined && !isApprovalRequest(incoming)) return
          // One pending gate owns both its wording and envelope until decided.
          if (trusted?.kind === "approval" && existing?.kind === "approval" &&
            existing.payload.decision === undefined) return
          /*
           * A decided approval owns its id. An approval is a human
           * authorising an action, so a frame from the model's own
           * stream must never be able to un-decide one — and a frame
           * that replaced the card with some other kind would launder
           * the freeze away, so nothing but a new gate displaces it.
           *
           * The freeze is per-decision, not per-card: the chain runtime
           * reuses `chain-approval-<lineage>` for every park on a
           * lineage, so freezing the id would swallow the NEXT ask and
           * strand the run with no gate on screen. A frame naming a
           * different gate is a different question, and it replaces the
           * answered one.
           */
          const decided = decidedApproval(existing)
          if (decided !== undefined) {
            const incoming = transition.card.kind === "approval" ? transition.card : undefined
            if (incoming === undefined || approvalGateKey(incoming) === approvalGateKey(decided)) return
          }
          if (transition.type === "card.view.loaded" && existing?.viewKey !== transition.card.viewKey) {
            const history = collections.cardHistories.get(transition.card.id)
            if (history) collections.cardHistories.update(history.id, draft => {
              draft.entries = draft.entries.map(entry => entry.viewKey === transition.card.viewKey ? { ...capturedCard(transition.card), navigation: undefined } : entry)
            })
            break
          }
          let card = transition.card
          if (isApprovalRequest(card)) {
            // A refreshed inbox may add/remove rows, but a surviving request
            // keeps the exact description and envelope first shown to the human.
            if (card.kind === "approvals-inbox" && trusted?.kind === "approvals-inbox") {
              card = { ...card, title: trusted.title, payload: { ...trusted.payload, approvals: card.payload.approvals.map((row) => {
                const prior = trusted.payload.approvals.find((entry) => sameApproval(entry, row))
                return prior === undefined ? row : { ...row, runId: prior.runId, title: prior.title,
                  approval: prior.approval, requestedAt: prior.requestedAt }
              }) } }
            }
            const request = structuredClone(CardSchema.parse(card))
            card = structuredClone(request)
            if (trusted === undefined) collections.approvalRequests.insert(request)
            else collections.approvalRequests.update(card.id, (draft) => { Object.assign(draft, request) })
          }
          if (existing === undefined) {
            insertCard(card)
          } else {
            collections.cards.update(card.id, (draft) => { Object.assign(draft, { loading: undefined, viewKey: undefined, viewRepo: undefined }, card) })
          }
          if (transition.type === "card.view.loaded" && card.kind === "issue" && card.payload.conversation && card.payload.number > 0) {
            const seen = new Set<string>()
            for (const comment of card.payload.comments) {
              if (comment.id === undefined) continue
              const id = comment.idempotencyKey?.startsWith("message-") ? comment.idempotencyKey : `issue-comment:${card.id}:${comment.id}`
              seen.add(id)
              if (current.phase === "responding" && id === `message-${current.turnId}-smithers`) continue
              if (card.payload.pendingComments?.some(request => request.id === id && request.text !== comment.commentBody)) continue
              const previous = collections.messages.get(id)
              const parsedAt = comment.createdAt ? Date.parse(comment.createdAt) : NaN
              const row: Message = {
                ...previous, id, role: comment.persona?.username.trim() ? "smithers" : "user", text: comment.commentBody,
                issueCardId: card.id, issueCommentId: comment.id,
                status: "complete", createdAt: previous?.createdAt ?? (Number.isFinite(parsedAt) ? parsedAt : createdAt),
                ordinal: previous?.ordinal ?? nextOrdinal(collections)
              }
              if (previous) collections.messages.update(id, draft => { Object.assign(draft, row) })
              else insertMessage(row)
            }
            const removed = [...collections.messages.values()].filter(row => row.issueCardId === card.id && !seen.has(row.id)).map(row => row.id)
            if (removed.length) collections.messages.delete(removed)
          }
          const history = collections.cardHistories.get(card.id)
          if (history) collections.cardHistories.update(card.id, draft => {
            draft.entries[draft.index] = { ...card, navigation: undefined }
          })
          const frame = ensureCardFrame(card.id)
          // A recorded frame keeps the revision it was maximized at; live card state is the card row.
          if (frame.snapshot === undefined) {
            collections.frames.update(frame.id, (draft) => {
              draft.stateRevision = revision
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          break
        }

        case "card.updated": {
          const existing = collections.cards.get(transition.id)
          if (existing === undefined) return
          if (existing.kind === "approval") return
          if (existing.kind === "approvals-inbox" && transition.actor === "smithers") return
          if (transition.patch.kind !== undefined && transition.patch.kind !== existing.kind) return
          const decoded = CardPatchSchema.safeParse({ ...transition.patch, kind: existing.kind })
          if (!decoded.success) return
          const candidate = CardSchema.safeParse({
            ...existing,
            ...decoded.data,
            payload: decoded.data.payload === undefined ? existing.payload :
              { ...existing.payload, ...decoded.data.payload }
          })
          if (!candidate.success) return
          let patch: typeof transition.patch = candidate.data
          if (existing.kind === "approvals-inbox") {
            const trusted = approvalRequest(transition.id)
            const merged = CardSchema.safeParse({ ...existing, ...patch })
            if (trusted?.kind !== "approvals-inbox" || !merged.success || merged.data.kind !== "approvals-inbox") return
            const updates = merged.data.payload.approvals
            // Generic inbox updates can only settle decision state, never
            // change which request a row or its wording refers to.
            patch = { status: patch.status, payload: { ...trusted.payload,
              approvals: trusted.payload.approvals.map((row) => {
                const update = updates.find((entry) => sameApproval(entry, row))
                return { ...row, decision: update?.decision, decidedAt: update?.decidedAt,
                  pending: update?.pending, decisionError: update?.decisionError }
              }) } }
            if (patch.status === undefined) delete patch.status
          }
          collections.cards.update(transition.id, (draft) => {
            Object.assign(draft, patch)
          })
          for (const frame of collections.frames.values()) {
            if (frame.cardId !== transition.id || frame.branchId !== activeBranchId || frame.snapshot !== undefined) continue
            collections.frames.update(frame.id, (draft) => {
              draft.stateRevision = revision
              draft.updatedAt = createdAt
              draft.revision = revision
            })
          }
          break
        }

        case "card.approval.decision.pending": {
          if (transition.actor !== "user" || approvalRequest(transition.id)?.kind !== "approval") return
          const card = collections.cards.get(transition.id)
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          const normalizedId = runtimeApprovalIdOf(approvalRequest(transition.id)!), normalized = normalizedId === undefined ? undefined : collections.runtimeApprovals.get(normalizedId)
          if (normalized !== undefined) {
            const next = submitRuntimeApproval(normalized, { id: normalized.id, submissionId: recordId, state: "pending" }, createdAt, revision)
            if (next === normalized) return
            collections.runtimeApprovals.update(normalized.id, draft => { Object.assign(draft, next) })
            break
          }
          collections.cards.update(transition.id, (draft) => {
            if (draft.kind === "approval") {
              draft.payload.pending = true
              draft.payload.error = undefined
            }
          })
          break
        }

        case "card.approval.decision.failed": {
          if (transition.actor !== "system" || approvalRequest(transition.id)?.kind !== "approval") return
          const card = collections.cards.get(transition.id)
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            draft.status = "error"
            if (draft.kind === "approval") {
              draft.payload.pending = false
              draft.payload.error = transition.message
            }
          })
          break
        }

        case "card.approval.observed": {
          const trusted = approvalRequest(transition.id)
          const card = collections.cards.get(transition.id)
          if (transition.actor !== "system" || trusted?.kind !== "approval" || card?.kind !== "approval" || trusted.payload.chain === true) return
          const target = trusted.payload.approval?.target as { _tag?: unknown; runId?: unknown; requestId?: unknown; digest?: unknown } | undefined
          if (target?._tag !== "Node" || target.runId !== transition.runId || target.requestId !== transition.requestId ||
            target.digest !== transition.digest || trusted.payload.runId !== transition.runId || trusted.payload.requestId !== transition.requestId) return
          collections.cards.update(transition.id, (draft) => {
            if (draft.kind !== "approval") return
            draft.status = "acted"
            draft.payload.decision = transition.decision
            draft.payload.decidedAt = undefined
            draft.payload.pending = false
            draft.payload.error = undefined
          })
          break
        }

        case "card.approval.decided": {
          if (transition.actor !== "user" || approvalRequest(transition.id)?.kind !== "approval") return
          const card = collections.cards.get(transition.id)
          // A failed decision attempt stays retryable, so "error" can still decide.
          if (card === undefined || card.kind !== "approval" || card.status === "acted") return
          collections.cards.update(transition.id, (draft) => {
            draft.status = "acted"
            if (draft.kind === "approval") {
              draft.payload.decision = transition.decision
              draft.payload.decidedAt = transition.decidedAt
              draft.payload.pending = false
              draft.payload.error = undefined
            }
          })
          break
        }

        case "identity.session.loaded": {
          const existing = collections.identitySessions.get("identity")
          if (existing === undefined) return
          // Availability is transient; ownership lasts until a definitive answer.
          // Legacy signed-in rows still name their owner. A legacy outage has
          // lost that name, so undefined conservatively means unknown owner.
          const owner = accountOwnerOf(existing)
          if (appTransitionErasesPrivateState(previous, transition)) {
            forgetAccountState(collections, createdAt)
          }
          const nextOwner = transition.state === "signed-in" ? transition.login : transition.state === "signed-out" ? null : owner
          // A definitive sign-in carries an unfinished signup past its doors (state/Signup.ts).
          if (transition.state === "signed-in") {
            const session = collections.sessions.get(SESSION_ID)
            const advanced = signupAfterIdentity(session?.signup, "signed-in", transition.login, owner)
            if (advanced !== undefined && advanced !== session?.signup) collections.sessions.update(SESSION_ID, draft => { draft.signup = advanced })
          }
          const commandEntry = collections.sessions.get(SESSION_ID)?.repositoryCommandEntry
          if (commandEntry !== undefined && commandEntry.owner !== nextOwner) {
            collections.sessions.update(SESSION_ID, draft => {
              delete draft.repositoryCommandEntry
              if (draft.pendingCommand?.requirement !== "repository-ready") return
              try {
                const payload = JSON.parse(draft.pendingCommand.args ?? "")
                if (typeof payload?.repo === "string" && payload.repo.toLowerCase() === commandEntry.repo.toLowerCase()) draft.pendingCommand = null
              } catch { /* Invalid saved commands are handled by the readiness controller. */ }
            })
          }
          collections.identitySessions.update("identity", (draft) => {
            draft.ownerRevision = owner !== nextOwner || transition.state === "signed-out" ||
              (transition.state === "signed-in" && accountProviderChanged(existing.provider, transition.provider))
              ? revision : existing.ownerRevision ?? existing.revision
            draft.accountOwnerLogin = transition.state === "signed-in"
              ? transition.login
              : transition.state === "signed-out" ? null : owner
            draft.state = transition.state
            draft.login = transition.login
            if (transition.provider !== undefined && transition.state !== "unavailable") draft.provider = transition.provider
            draft.sessionObservation = { at: createdAt, revision }
            draft.allowlisted = transition.allowlisted
            draft.admin = transition.admin
            if (transition.scopesPlain !== null) draft.scopesPlain = transition.scopesPlain
            if (transition.state !== "signed-in") draft.accessRequested = false
            if (transition.state === "signed-in") draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          if (transition.state === "signed-in") answerSignInPrompts(collections, "identity", transition.login, createdAt, transition.provider)
          break
        }

        case "identity.access.requested": {
          const identity = collections.identitySessions.get("identity")
          if (identity === undefined || identity.state !== "signed-in") return
          collections.identitySessions.update("identity", (draft) => {
            draft.accessRequested = true
            draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break
        }

        case "identity.access.failed": {
          if (collections.identitySessions.get("identity") === undefined) return
          collections.identitySessions.update("identity", (draft) => {
            draft.accessError = transition.message
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break
        }

        case "identity.session.cleared": {
          if (collections.identitySessions.get("identity") === undefined) return
          forgetAccountState(collections, createdAt)
          collections.identitySessions.update("identity", (draft) => {
            draft.ownerRevision = revision
            draft.state = "signed-out"
            draft.login = null
            draft.accountOwnerLogin = null
            draft.allowlisted = false
            draft.admin = false
            draft.accessRequested = false
            draft.accessError = null
            draft.updatedAt = createdAt
            draft.revision = revision
          })
          break
        }

        case "billing.refreshed": {
          if (collections.billingAccounts.get("billing") === undefined) return
          collections.billingAccounts.update("billing", (draft) => {
            draft.state = transition.state
            draft.totalUsd = transition.totalUsd
            draft.allowedToStartWork = transition.allowedToStartWork
            draft.lifetimeChargedUsd = transition.lifetimeChargedUsd
            draft.chargeCount = transition.chargeCount
            draft.refreshedAt = createdAt
            draft.revision = revision
          })
          break
        }

        case "billing.plans.loaded": {
          collections.billingAccounts.update("billing", draft => {
            draft.planKey = transition.planKey
            draft.sandbox = transition.sandbox
            draft.plans = transition.plans
            draft.creditBalanceCents = transition.creditBalanceCents ?? null
            draft.creditResetsAt = transition.creditResetsAt ?? null
            draft.revision = revision
          })
          break
        }

        case "billing.unavailable": {
          const account = collections.billingAccounts.get("billing")
          if (account === undefined) return
          collections.billingAccounts.update("billing", (draft) => {
            // Keep the last known balance honest-but-stale; only an account
            // that never loaded falls back to plain "unavailable".
            if (draft.state === "unknown") draft.state = "unavailable"
            draft.revision = revision
          })
          break
        }

        case "toast.shown": {
          const id = `toast-${transition.key}`
          const existing = collections.toasts.get(id)
          const toast: Toast = {
            id,
            key: transition.key,
            title: transition.title,
            sourceCard: transition.sourceCard,
            status: "running",
            detail: "",
            action: transition.action,
            answeredAction: undefined,
            createdAt: existing?.createdAt ?? createdAt,
            updatedAt: createdAt
          }
          if (existing === undefined) {
            collections.toasts.insert(toast)
          } else {
            collections.toasts.update(id, (draft) => {
              Object.assign(draft, toast)
            })
          }
          break
        }

        case "toast.progressed": {
          const id = `toast-${transition.key}`
          if (collections.toasts.get(id)?.status !== "running") return
          collections.toasts.update(id, (draft) => {
            draft.detail = transition.detail
            if (transition.title !== undefined) draft.title = transition.title
            draft.updatedAt = createdAt
          })
          break
        }

        case "toast.resolved": {
          const id = `toast-${transition.key}`
          if (collections.toasts.get(id) === undefined) return
          collections.toasts.update(id, (draft) => {
            draft.status = transition.status
            if (transition.title !== undefined) draft.title = transition.title
            draft.detail = transition.detail
            draft.action = transition.action
            draft.answeredAction = undefined
            draft.updatedAt = createdAt
          })
          break
        }

        case "toast.dismissed":
          if (collections.toasts.get(transition.id) === undefined) return
          collections.toasts.delete(transition.id)
          break

        case "card.removed": {
          if (collections.cards.get(transition.id) === undefined) return
          collections.cards.delete(transition.id)
          if (collections.cardHistories.has(transition.id)) collections.cardHistories.delete(transition.id)
          const removedFrames = new Set<string>()
          for (const frame of collections.frames.values()) {
            if (frame.branchId === activeBranchId && frame.cardId === transition.id) {
              removedFrames.add(frame.id)
              collections.frames.delete(frame.id)
            }
          }
          for (const frame of collections.frames.values()) {
            if (frame.branchId !== activeBranchId) continue
            if (removedFrames.has(frame.parentFrameId ?? "") || frame.snapshot?.cards.some(card => card.id === transition.id)) {
              collections.frames.update(frame.id, draft => {
                if (removedFrames.has(draft.parentFrameId ?? "")) draft.parentFrameId = rootFrameId(activeBranchId)
                if (draft.snapshot) draft.snapshot.cards = draft.snapshot.cards.filter(card => card.id !== transition.id)
              })
            }
          }
          if (current.maximizedCardId === transition.id || removedFrames.has(current.activeFrameId ?? "")) {
            collections.sessions.update(SESSION_ID, draft => {
              draft.maximizedCardId = null
              draft.activeFrameId = rootFrameId(activeBranchId)
            })
          }
          break
        }

        case "message.steered": {
          const steered = transition.text.trim()
          if (steered === "" || current.phase !== "responding") return
          insertMessage({
            id: `message-steer-${recordId}`,
            role: "user",
            text: steered,
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          // The turn's prose continues AFTER the steer, so the turn bubble
          // moves below it; deltas keep appending to the same message.
          const turnBubble = collections.messages.get(`message-${transition.turnId}-smithers`)
          if (turnBubble !== undefined) {
            collections.messages.update(turnBubble.id, (draft) => {
              draft.ordinal = nextOrdinal(collections)
            })
          }
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.draft = ""
          })
          break
        }

        case "message.tool.executed": {
          insertMessage({
            id: `message-act-${recordId}`,
            turnId: transition.turnId,
            role: "smithers",
            text: transition.text,
            act: transition.text,
            ...(transition.answersTurn === undefined ? {} : { answersTurn: transition.answersTurn }),
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          break
        }

        case "message.claim.substituted": {
          // The turn's whole answer becomes the deterministic line: a
          // partially-suppressed claim is still a claim on screen.
          const messageId = `message-${transition.turnId}-smithers`
          if (collections.messages.get(messageId) === undefined) {
            insertMessage({
              id: messageId,
              role: "smithers",
              text: transition.text,
              status: "complete",
              createdAt,
              ordinal: nextOrdinal(collections)
            })
          } else {
            collections.messages.update(messageId, (draft) => {
              draft.text = transition.text
            })
          }
          break
        }

        case "message.appended": {
          insertMessage({
            id: `message-appended-${recordId}`,
            role: "smithers",
            text: transition.text,
            ...(transition.action === undefined ? {} : { action: transition.action }),
            ...(transition.spoken === undefined ? {} : { spoken: transition.spoken }),
            status: "complete",
            createdAt,
            ordinal: nextOrdinal(collections)
          })
          break
        }

        /*
         * The local-app tabs (docs/LOCAL-APP.md "Tabs"): main is seeded and
         * never inserted or removed; every other tab takes the next place
         * in the strip and becomes the active one as it opens.
         */
        case "tab.opened": {
          if (transition.tab.kind === "main" || collections.tabs.get(transition.tab.id) !== undefined) return
          let highest = 0
          for (const tab of collections.tabs.values()) highest = Math.max(highest, tab.ordinal)
          collections.tabs.insert({ ...transition.tab, ordinal: highest + 1 })
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeTabId = transition.tab.id
            draft.tabMenuOpen = false
          })
          break
        }

        case "tab.selected":
          if (collections.tabs.get(transition.id) === undefined) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeTabId = transition.id
          })
          break

        case "tab.close.asked": {
          const asked = transition.id === null ? undefined : collections.tabs.get(transition.id)
          if (transition.id !== null && (asked === undefined || asked.kind === "main")) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.pendingTabCloseId = transition.id
          })
          break
        }

        case "tab.closed":
          closeTabRows(collections, [transition.id], revision)
          break

        case "tab.menu.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.tabMenuOpen = transition.open
          })
          break

        case "pty.status.observed": {
          if (transition.actor !== "system") return
          const decoded = StatusRollupSchema.safeParse(transition.status)
          if (!decoded.success || decoded.data.subjectId !== `session:${transition.sessionId}` ||
            !["spawning", "running", "exited"].includes(decoded.data.state)) return
          const status = expireStatus(decoded.data, createdAt)
          for (const tab of collections.tabs.values()) {
            if ((tab.kind !== "terminal" && tab.kind !== "harness") || tab.sessionId !== transition.sessionId ||
              (tab.kind === "terminal" && tab.workspaceId !== undefined) || !acceptStatus(tab.statusRollup, status)) continue
            if (tab.exitCode === undefined && status.state === "exited") continue
            collections.tabs.update(tab.id, (draft) => {
              if (draft.kind === "terminal" || draft.kind === "harness") draft.statusRollup = draft.exitCode === undefined
                ? status : exitedStatus(transition.sessionId, draft.exitCode, status, createdAt)
            })
          }
          for (const card of collections.cards.values()) {
            if (card.kind !== "agent" || "cloud" in card.payload || card.payload.sessionId !== transition.sessionId || !acceptStatus(card.payload.statusRollup, status)) continue
            if (card.payload.phase === "running" && status.state === "exited") continue
            collections.cards.update(card.id, (draft) => {
              if (draft.kind === "agent" && !("cloud" in draft.payload)) draft.payload.statusRollup = draft.payload.phase === "exited"
                ? exitedStatus(transition.sessionId, draft.payload.exitCode, status, createdAt) : status
            })
          }
          break
        }
        case "status.expired": {
          if (transition.actor !== "system" || !Number.isFinite(transition.now)) return
          // Older events expired only stored cards. Preserve their exact replay;
          // new events also expire the authoritative presentation source so the
          // runtime card projection cannot revive an already-expired reading.
          if (transition.runtime === true) for (const run of collections.runtimeRuns.values()) {
            const previous = run.summary?.statusRollup
            if (previous === undefined) continue
            const status = expireStatus(previous, transition.now)
            if (status !== previous) collections.runtimeRuns.update(run.id, draft => {
              if (draft.summary !== undefined) draft.summary = { ...draft.summary, statusRollup: status }
            })
          }
          for (const tab of collections.tabs.values()) {
            if ((tab.kind !== "terminal" && tab.kind !== "harness") || tab.statusRollup === undefined) continue
            const status = expireStatus(tab.statusRollup, transition.now)
            if (status !== tab.statusRollup) collections.tabs.update(tab.id, (draft) => {
              if (draft.kind === "terminal" || draft.kind === "harness") draft.statusRollup = status
            })
          }
          for (const card of collections.cards.values()) {
            if (card.kind === "run-list") {
              const runs = card.payload.runs.map((run) => run.statusRollup === undefined ? run :
                { ...run, statusRollup: expireStatus(run.statusRollup, transition.now) })
              if (runs.some((run, index) => run.statusRollup !== card.payload.runs[index]?.statusRollup)) collections.cards.update(card.id, (draft) => {
                if (draft.kind === "run-list") draft.payload.runs = runs
              })
              continue
            }
            if ((card.kind !== "agent" && card.kind !== "run-trace") || (card.kind === "agent" && "cloud" in card.payload) || card.payload.statusRollup === undefined) continue
            const status = expireStatus(card.payload.statusRollup, transition.now)
            if (status !== card.payload.statusRollup) collections.cards.update(card.id, (draft) => {
              if ((draft.kind === "agent" && !("cloud" in draft.payload)) || draft.kind === "run-trace") draft.payload.statusRollup = status
            })
          }
          break
        }
        case "pty.exited": {
          for (const tab of collections.tabs.values()) {
            if ((tab.kind === "terminal" || tab.kind === "harness") && tab.sessionId === transition.sessionId) {
              collections.tabs.update(tab.id, (draft) => {
                if (draft.kind === "terminal" || draft.kind === "harness") {
                  draft.exitCode = transition.code
                  draft.statusRollup = exitedStatus(transition.sessionId, transition.code, draft.statusRollup, createdAt)
                }
              })
            }
          }
          // The subagent card follows its process: exited, with the code the PTY reported.
          for (const card of collections.cards.values()) {
            if (card.kind === "agent" && !("cloud" in card.payload) && card.payload.sessionId === transition.sessionId) {
              collections.cards.update(card.id, (draft) => {
                if (draft.kind !== "agent" || "cloud" in draft.payload) return
                draft.payload.phase = "exited"
                draft.payload.exitCode = transition.code
                draft.payload.statusRollup = exitedStatus(transition.sessionId, transition.code, draft.payload.statusRollup, createdAt)
                draft.status = transition.code === 0 || transition.code === null ? "acted" : "error"
              })
            }
          }
          break
        }

        /*
         * A reload replaces the list: rows the server still names update in
         * place, new rows insert, the rest delete. One transaction cannot
         * delete and re-insert the same key ("Unhandled mutation combination:
         * delete-insert"), so a wholesale clear-then-insert threw on every
         * reload whose list overlapped the last one.
         */

        case "harnesses.loaded": {
          const next = new Set<string>(transition.harnesses.map((harness) => harness.id))
          const stale = [...collections.harnesses.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.harnesses.delete(stale)
          for (const harness of transition.harnesses) {
            if (collections.harnesses.get(harness.id) === undefined) collections.harnesses.insert({ ...harness })
            else {
              collections.harnesses.update(harness.id, (draft) => {
                Object.assign(draft, harness)
              })
            }
          }
          break
        }

        case "agents.loaded": {
          // Same replace-in-place rule as the harnesses: update, insert, delete, never delete-then-insert one key.
          const next = new Set<string>(AGENT_ROLES.map((agent) => agent.id))
          const stale = [...collections.agents.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.agents.delete(stale)
          for (const agent of AGENT_ROLES) {
            if (collections.agents.get(agent.id) === undefined) collections.agents.insert({ ...agent })
            else {
              collections.agents.update(agent.id, (draft) => {
                Object.assign(draft, agent)
              })
            }
          }
          break
        }

        case "models.observed": {
          // The harnesses' replace-in-place rule over the host's own rows only: a user's record is never the host's to rewrite.
          const next = new Set<string>(transition.models.map((model) => model.id))
          const stale = [...collections.models.values()].filter((row) => row.builtin === true && !next.has(row.id)).map((row) => row.id)
          if (stale.length > 0) collections.models.delete(stale)
          for (const id of stale) forgetModelCallEvidence(collections, id)
          for (const model of transition.models) {
            const existing = collections.models.get(model.id)
            if (existing === undefined) collections.models.insert({ ...model, builtin: true })
            else if (existing.builtin === true) rewriteModel(collections, existing, { ...model, builtin: true })
          }
          break
        }

        case "model.saved": {
          // A user row omits `builtin`, whatever the event claimed.
          const { builtin: _builtin, ...model } = transition.model
          const existing = collections.models.get(model.id)
          if (existing === undefined) collections.models.insert(model)
          else if (existing.builtin !== true) rewriteModel(collections, existing, model)
          break
        }

        case "model.removed": {
          const existing = collections.models.get(transition.id)
          if (existing === undefined || existing.builtin === true) break
          collections.models.delete(transition.id)
          forgetModelCallEvidence(collections, transition.id)
          const freed = [...collections.seats.values()].filter((seat) => seat.recordId === transition.id).map((seat) => seat.id)
          if (freed.length > 0) collections.seats.delete(freed)
          break
        }

        case "model.tested": {
          if (collections.models.get(transition.test.id) === undefined) break
          collections.models.update(transition.test.id, (draft) => {
            draft.lastTest = transition.test
          })
          break
        }

        case "seat.assigned": {
          const { seat, recordId } = transition
          if (recordId === null) {
            collections.seats.delete(seat)
            break
          }
          const record = collections.models.get(recordId)
          if (record === undefined || !seatAccepts(seat, record.protocol)) break
          if (collections.seats.get(seat) === undefined) collections.seats.insert({ id: seat, recordId })
          else {
            collections.seats.update(seat, (draft) => {
              draft.recordId = recordId
            })
          }
          break
        }

        case "repos.loaded": {
          const next = new Set(transition.repos.map((repo) => repo.id))
          const before = new Set([...collections.repos.values()].map((repo) => repoKeyOf(repo.path)))
          const stale = [...collections.repos.keys()].filter((id) => !next.has(id))
          if (stale.length > 0) collections.repos.delete(stale)
          for (const repo of transition.repos) {
            if (collections.repos.get(repo.id) === undefined) collections.repos.insert({ ...repo })
            else {
              collections.repos.update(repo.id, (draft) => {
                Object.assign(draft, repo)
              })
            }
          }
          /*
           * Opening pins (docs/LOCAL-APP.md "Tabs"): every open repository is
           * a pinned row, keyed by path so it survives the server's fresh id
           * on a reopen. The active repository stays the one named when it
           * is still open; otherwise the first open one takes over.
           */
          const now = createdAt
          for (const repo of transition.repos) {
            const id = repoKeyOf(repo.path)
            const pin = { id, name: repo.name, path: repo.path, branch: repo.git?.branch ?? null, origin: "local" as const }
            if (collections.pinnedRepos.get(id) === undefined) collections.pinnedRepos.insert({ ...pin, pinnedAt: now })
            else {
              collections.pinnedRepos.update(id, (draft) => {
                Object.assign(draft, pin)
              })
            }
            /*
             * Lane piper: an open checkout is a local working copy. The
             * repoId comes from the checkout's remote when it parses, else
             * the checkout's own name (never an invented owner); the jj
             * probe fills ahead/readAt when the server ran one.
             */
            const copyId = id
            const existing = collections.workingCopies.get(copyId)
            const repoId = repoIdFromRemote(repo.git?.remote) ?? existing?.repoId ?? repo.name
            const copy: WorkingCopy = {
              id: copyId,
              repoId,
              kind: "local",
              label: repo.name,
              path: repo.path,
              ...(repo.jj?.ahead !== null && repo.jj?.ahead !== undefined ? { ahead: repo.jj.ahead } : {}),
              ...(repo.jj !== null && repo.jj !== undefined
                ? { readAt: { changeId: repo.jj.changeId, commitId: repo.jj.commitId } }
                : {}),
              updatedAt: now,
              revision
            }
            if (existing === undefined) collections.workingCopies.insert(copy)
            else {
              collections.workingCopies.update(copyId, (draft) => {
                Object.assign(draft, copy)
              })
            }
          }
          const openKeys = new Set(transition.repos.map((repo) => repoKeyOf(repo.path)))
          const byName = [...transition.repos].sort((left, right) => compareProjectionStrings(left.name, right.name))
          // A repository that just opened is the one the human asked for: it becomes the active one.
          const opened = byName.find((repo) => !before.has(repoKeyOf(repo.path)))
          collections.sessions.update(SESSION_ID, (draft) => {
            const named = draft.activeRepoKey ?? null
            if (opened !== undefined) draft.activeRepoKey = repoKeyOf(opened.path)
            else if (named === null || !openKeys.has(named)) {
              draft.activeRepoKey = byName[0] === undefined ? named : repoKeyOf(byName[0].path)
            }
          })
          break
        }
        case "repositories.loaded": {
          /*
           * The private inventory replaces private rows; public catalog rows
           * have their own authority and survive a late inventory read. A row
           * keeps its fresher head when the new answer carries none (the
           * per-repo bookmarks call failed this round): an absent answer is
           * not a fact about the repo.
           */
          const next = new Set(transition.repositories.map((repository) => repository.id))
          const stale = [...collections.repositories.values()].filter((repo) => !next.has(repo.id) && repo.catalog !== true).map(repo => repo.id)
          if (stale.length > 0) collections.repositories.delete(stale)
          for (const repository of transition.repositories) {
            const existing = collections.repositories.get(repository.id)
            const row: CloudRepository = {
              ...repository,
              head: repository.head ?? existing?.head ?? null,
              updatedAt: createdAt,
              revision
            }
            if (existing === undefined) collections.repositories.insert(row)
            else {
              collections.repositories.update(repository.id, (draft) => {
                Object.assign(draft, row)
              })
            }
          }
          break
        }
        case "repository.upserted": {
          /*
           * One row, never the collection: the rows beside it keep their own
           * revision. A row keeps its fresher head when the upsert carries
           * none, the same reading `repositories.loaded` takes.
           */
          const { repository } = transition
          const existing = collections.repositories.get(repository.id)
          const row: CloudRepository = {
            ...repository,
            head: repository.head ?? existing?.head ?? null,
            updatedAt: createdAt,
            revision
          }
          if (existing === undefined) collections.repositories.insert(row)
          else {
            collections.repositories.update(repository.id, (draft) => {
              Object.assign(draft, row)
            })
          }
          break
        }
        case "workingcopies.workspaces.loaded": {
          /* The cloud workspace list replaces the workspace copies only. */
          const next = new Set(transition.copies.map((copy) => copy.id))
          const stale = [...collections.workingCopies.values()]
            .filter((copy) => copy.kind === "workspace" && !next.has(copy.id))
            .map((copy) => copy.id)
          if (stale.length > 0) collections.workingCopies.delete(stale)
          for (const copy of transition.copies) {
            const row: WorkingCopy = { ...copy, updatedAt: createdAt, revision }
            if (collections.workingCopies.get(copy.id) === undefined) collections.workingCopies.insert(row)
            else {
              collections.workingCopies.update(copy.id, (draft) => {
                Object.assign(draft, row)
              })
            }
          }
          break
        }
        case "cloud.session.loaded": {
          const previousCloud = collections.cloudSessions.get("cloud")
          const previousOwner = previousCloud?.state === "signed-in" ? previousCloud.username : null
          const nextCloudOwner = transition.state === "signed-in" ? transition.username : null
          const row: CloudSessionRow = {
            id: "cloud",
            state: transition.state,
            username: transition.username,
            expiresAt: transition.expiresAt,
            scopes: transition.scopes,
            updatedAt: createdAt,
            revision,
            ownerRevision: previousOwner !== nextCloudOwner || transition.state === "signed-out"
              ? revision : previousCloud?.ownerRevision ?? previousCloud?.revision ?? 0
          }
          if (collections.cloudSessions.get("cloud") === undefined) collections.cloudSessions.insert(row)
          else {
            collections.cloudSessions.update("cloud", (draft) => {
              Object.assign(draft, row)
            })
          }
          // Signed out, no workspace terminal can attach: its tabs close with the session, in this transaction.
          if (transition.state === "signed-out") closeTabRows(collections, workspaceTabIds(collections), revision)
          if (transition.state === "signed-in" && transition.scopes !== "degraded") {
            answerSignInPrompts(collections, "cloud", transition.username, createdAt)
          }
          break
        }
        /*
         * Lane citc: the workspaces collection is the authority; the
         * workspace working copies and live card headers are query projections.
         * Ordinary updates write the workspace row.
         */
        case "workspaces.loaded": {
          const scope = transition.repoId
          const next = new Set(transition.workspaces.map((workspace) => workspace.id))
          const stale = [...collections.cloudWorkspaces.values()]
            .filter((workspace) => (scope === undefined || workspace.repoId === scope) && !next.has(workspace.id))
            .map((workspace) => workspace.id)
          if (stale.length > 0) {
            const removed = new Set(stale)
            // Leaving the live inventory captures the last observed facts once.
            for (const card of collections.cards.values()) {
              if (card.kind !== "workspace" || !removed.has(card.payload.workspaceId)) continue
              const captured = currentCard(card)
              collections.cards.update(card.id, (draft) => {
                Object.assign(draft, captured)
              })
            }
            collections.cloudWorkspaces.delete(stale)
            closeTabRows(collections, workspaceTabIds(collections, removed), revision)
          }
          const staleCopies = [...collections.workingCopies.values()]
            .filter((copy) =>
              copy.kind === "workspace" &&
              (scope === undefined || copy.repoId === scope) &&
              copy.workspaceId !== undefined &&
              !next.has(copy.workspaceId)
            )
            .map((copy) => copy.id)
          if (staleCopies.length > 0) collections.workingCopies.delete(staleCopies)
          for (const workspace of transition.workspaces) {
            const row: CloudWorkspaceRow = { ...workspace, updatedAt: createdAt, revision }
            if (collections.cloudWorkspaces.get(workspace.id) === undefined) collections.cloudWorkspaces.insert(row)
            else {
              collections.cloudWorkspaces.update(workspace.id, (draft) => {
                Object.assign(draft, row)
              })
            }
          }
          break
        }
        case "workspace.updated": {
          const workspace = transition.workspace
          const row: CloudWorkspaceRow = { ...workspace, updatedAt: createdAt, revision }
          if (collections.cloudWorkspaces.get(workspace.id) === undefined) collections.cloudWorkspaces.insert(row)
          else {
            collections.cloudWorkspaces.update(workspace.id, (draft) => {
              Object.assign(draft, row)
            })
          }
          break
        }
        case "workspace.session.destroyed": {
          // The tab attached to the session closes and the card stops pointing at it, together.
          closeTabRows(
            collections,
            [...collections.tabs.values()]
              .filter((tab) => tab.kind === "terminal" && tab.workspaceId !== undefined && tab.sessionId === transition.sessionId)
              .map((tab) => tab.id),
            revision
          )
          for (const card of collections.cards.values()) {
            if (card.kind !== "workspace" || card.payload.terminalSessionId !== transition.sessionId) continue
            collections.cards.update(card.id, (draft) => {
              if (draft.kind !== "workspace") return
              delete draft.payload.terminalSessionId
            })
          }
          break
        }
        case "workspace.deleted": {
          // Gone is a fact: the card, the collection row, its tree copy, and its terminal tabs leave in one transaction.
          const { workspaceId } = transition
          const cardId = `workspace-${workspaceId}`
          if (collections.cards.get(cardId) !== undefined) collections.cards.delete(cardId)
          if (collections.cloudWorkspaces.get(workspaceId) !== undefined) collections.cloudWorkspaces.delete(workspaceId)
          const copyId = `workspace:${workspaceId}`
          if (collections.workingCopies.get(copyId) !== undefined) collections.workingCopies.delete(copyId)
          closeTabRows(collections, workspaceTabIds(collections, new Set([workspaceId])), revision)
          break
        }
        /* Lane change: one change upsert; pinned cards read the current revision from here. */
        case "change.loaded": {
          const change = transition.change
          const row: ChangeRow = { ...change, updatedAt: createdAt, revision }
          if (collections.changes.get(change.id) === undefined) collections.changes.insert(row)
          else {
            collections.changes.update(change.id, (draft) => {
              Object.assign(draft, row)
            })
          }
          break
        }
        case "github.app-status.loaded": {
          const status = transition.status
          const row: GitHubAppStatusRow = { ...status, updatedAt: createdAt, revision }
          if (collections.githubAppStatuses.get(status.repo) === undefined) collections.githubAppStatuses.insert(row)
          else {
            collections.githubAppStatuses.update(status.repo, (draft) => {
              Object.assign(draft, row)
            })
          }
          break
        }
        case "repo.pinned": {
          if (collections.pinnedRepos.get(transition.pin.id) === undefined) {
            collections.pinnedRepos.insert({ ...transition.pin })
          } else {
            collections.pinnedRepos.update(transition.pin.id, (draft) => {
              Object.assign(draft, transition.pin)
            })
          }
          // Lane piper: a pinned checkout is a local working copy row.
          if (collections.workingCopies.get(transition.pin.id) === undefined) {
            collections.workingCopies.insert({
              id: transition.pin.id,
              repoId: transition.pin.name,
              kind: "local",
              label: transition.pin.name,
              path: transition.pin.path,
              updatedAt: createdAt,
              revision
            })
          }
          break
        }
        case "repo.unpinned": {
          if (collections.pinnedRepos.get(transition.id) === undefined) return
          collections.pinnedRepos.delete(transition.id)
          if (collections.workingCopies.get(transition.id)?.kind === "local") {
            collections.workingCopies.delete(transition.id)
          }
          const treeKeys = [...collections.repoTree.values()].filter((row) => row.copyId === transition.id).map((row) => row.id)
          if (treeKeys.length > 0) collections.repoTree.delete(treeKeys)
          collections.sessions.update(SESSION_ID, (draft) => {
            if (draft.activeRepoKey === transition.id) draft.activeRepoKey = null
            const selected = draft.activeRepoKey
            if (selected !== undefined && selected !== null && selected.endsWith(`#${transition.id}`)) {
              draft.activeRepoKey = null
            }
          })
          break
        }
        case "repository.command.changed": {
          if (collections.sessions.get(SESSION_ID)?.repositoryCommandEntry?.requestId !== transition.entry.requestId) break
          collections.sessions.update(SESSION_ID, draft => { draft.repositoryCommandEntry = transition.entry })
          break
        }
        case "repository.entry.changed": {
          const entry = transition.entry
          if (entry !== null && entry.phase !== "pending" && collections.sessions.get(SESSION_ID)?.repositoryEntry?.requestId !== entry.requestId) break
          collections.sessions.update(SESSION_ID, draft => {
            draft.repositoryEntry = entry
            if (entry?.phase !== "pending") return
            const selected = draft.activeRepoKey == null ? null : parseRepoSelection(draft.activeRepoKey)
            // Keep the same repository's selected working copy across reload.
            // A different entry must not inherit a saved checkout.
            if (selected === null || !("repoId" in selected) || selected.repoId.toLowerCase() !== entry.repo.toLowerCase()) {
              draft.activeRepoKey = null
            }
          })
          break
        }
        case "repo.selected": {
          /*
           * Lane piper grammar: `org/repo` selects the repository (its
           * head), `org/repo#copyId` one working copy, and `local:/path` a
           * checkout with no repository remote.
           */
          const selection = parseRepoSelection(transition.id)
          if (selection === null) return
          if ("repoId" in selection) {
            if (selection.copyId !== undefined) {
              if (views.workingCopies.get(selection.copyId) === undefined) return
            } else if (
              collections.repositories.get(selection.repoId) === undefined &&
              ![...views.workingCopies.values()].some((copy) => copy.repoId === selection.repoId)
            ) return
          } else if (
            collections.pinnedRepos.get(selection.localCopyId) === undefined &&
            views.workingCopies.get(selection.localCopyId) === undefined
          ) return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.activeRepoKey = transition.id
          })
          break
        }
        case "repository-flows.loaded": {
          /*
           * One row per repository, replaced whole: the projection is the
           * catalog, so a reload keeps nothing of a stale one. An absent
           * projection leaves no leaves, while a homepage can keep the row.
           */
          const existing = collections.repositoryFlows.get(transition.repo)
          if (transition.flows.length === 0 && transition.home === undefined) {
            if (existing !== undefined) collections.repositoryFlows.delete(transition.repo)
          } else if (existing === undefined) {
            collections.repositoryFlows.insert({ id: transition.repo, flows: [...transition.flows], home: transition.home, loadedAt: createdAt })
          } else {
            collections.repositoryFlows.update(transition.repo, (draft) => {
              draft.flows = [...transition.flows]
              draft.home = transition.home
              draft.loadedAt = createdAt
            })
          }
          break
        }
        case "flow-durations.loaded": {
          /*
           * One flow's rows, replaced whole: the projection is a snapshot of
           * the whole history, so a re-read keeps nothing of an older one and
           * a tag that stopped being measured stops having a row. A tag the
           * re-read still measures is UPDATED in place, never deleted and
           * re-inserted, which one transaction refuses (ListReload.test.ts).
           */
          const wanted = new Map(transition.rows.map((row) =>
            [flowDurationRowId(transition.repo, transition.flowId, row.actionTag, transition.workspaceId), row]))
          for (const row of collections.flowDurations.values()) {
            if (row.repo !== transition.repo || row.flowId !== transition.flowId || row.workspaceId !== transition.workspaceId) continue
            if (!wanted.has(row.id)) collections.flowDurations.delete(row.id)
          }
          for (const [id, row] of wanted) {
            if (collections.flowDurations.get(id) === undefined) {
              collections.flowDurations.insert({
                id,
                repo: transition.repo,
                ...(transition.workspaceId === undefined ? {} : { workspaceId: transition.workspaceId }),
                flowId: transition.flowId,
                actionTag: row.actionTag,
                samples: row.samples,
                p50Ms: row.p50Ms,
                p90Ms: row.p90Ms,
                loadedAt: createdAt
              })
            } else {
              collections.flowDurations.update(id, (draft) => {
                draft.samples = row.samples
                draft.p50Ms = row.p50Ms
                draft.p90Ms = row.p90Ms
                draft.loadedAt = createdAt
              })
            }
          }
          break
        }
        case "repo-tree.toggled": {
          const id = repoTreeRowId(transition.copyId, transition.path)
          if (collections.repoTree.get(id) === undefined) return
          collections.repoTree.update(id, (draft) => {
            draft.expanded = transition.expanded
          })
          break
        }
        case "repo-tree.loading":
        case "repo-tree.loaded":
        case "repo-tree.failed": {
          /*
           * One row per directory: a first expand inserts it loading (and
           * expanded — the caret turns at once, the listing follows); the
           * route's answer rewrites the same row. A retry of a failed row
           * keeps nothing of the failure; a load keeps nothing of a stale
           * listing. `expanded` is the user's, so an answer never changes it.
           */
          const id = repoTreeRowId(transition.copyId, transition.path)
          const existing = collections.repoTree.get(id)
          const next: RepoTreeRow = transition.type === "repo-tree.loading"
            ? { id, copyId: transition.copyId, path: transition.path, expanded: true, state: "loading", entries: existing?.entries ?? [], loadedAt: createdAt }
            : transition.type === "repo-tree.loaded"
            ? {
              id,
              copyId: transition.copyId,
              path: transition.path,
              expanded: existing?.expanded ?? true,
              state: "loaded",
              entries: [...transition.entries],
              ...(transition.truncated ? { truncated: true } : {}),
              loadedAt: createdAt
            }
            : { id, copyId: transition.copyId, path: transition.path, expanded: existing?.expanded ?? true, state: "failed", entries: [], error: transition.error, loadedAt: createdAt }
          if (existing === undefined) {
            collections.repoTree.insert(next)
          } else {
            collections.repoTree.update(id, (draft) => {
              draft.expanded = next.expanded
              draft.state = next.state
              draft.entries = next.entries
              draft.error = next.error
              draft.truncated = next.truncated
              draft.loadedAt = next.loadedAt
            })
          }
          break
        }
        case "workspace.renamed": {
          const name = transition.name.trim()
          if (name === "") return
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.workspaceName = name
            draft.workspaceRenameOpen = false
          })
          break
        }
        case "workspace.rename.toggled":
          collections.sessions.update(SESSION_ID, (draft) => {
            draft.workspaceRenameOpen = transition.open
          })
          break
        case "target.starred":
        case "target.unstarred": {
          // Personal stars are normalized rows; card bodies join them at read time.
          const repoKey = transition.type === "target.starred" ? transition.star.repoKey :
            transition.id.slice(0, transition.id.lastIndexOf("::"))
          // Bind legacy cards once to the same stable repository as this act.
          for (const card of collections.cards.values()) {
            if (card.kind !== "targets" || card.payload.repoId !== transition.repoId || card.payload.repoKey !== undefined) continue
            collections.cards.update(card.id, draft => {
              if (draft.kind === "targets") draft.payload.repoKey = repoKey
            })
          }
          if (transition.type === "target.starred") {
            if (collections.starredTargets.get(transition.star.id) === undefined) {
              collections.starredTargets.insert({ ...transition.star })
            }
          } else if (collections.starredTargets.get(transition.id) !== undefined) {
            collections.starredTargets.delete(transition.id)
          }
          break
        }
        case "recommendations.updated": {
          /*
           * Latest state wins: a read made against an older revision than the
           * row already holds is stale (a slower agent answer landing after
           * the rule already answered the newer state) and is dropped.
           */
          const existing = collections.recommendations.get(RECOMMENDATION_ID)
          if (existing !== undefined && existing.revision > transition.revision) {
            break
          }
          // The rule writes through a retry window; an agent answer proves the window is over.
          const retry = transition.source === "agent" ? undefined : existing?.retry
          const row: Recommendation = {
            id: RECOMMENDATION_ID,
            suggestions: transition.suggestions.map((suggestion) => ({ ...suggestion })),
            source: transition.source,
            revision: transition.revision,
            createdAt,
            ...(retry === undefined ? {} : { retry: { ...retry } })
          }
          if (existing === undefined) collections.recommendations.insert(row)
          else {
            collections.recommendations.update(RECOMMENDATION_ID, (draft) => {
              Object.assign(draft, row)
              if (retry === undefined) delete draft.retry
            })
          }
          break
        }
        case "recommendations.deferred": {
          /*
           * The window binds to the account that asked, read here like
           * http.turn.started reads it: the persisted owner outlives an
           * identity outage, a visitor is null, and an unknown owner (a legacy
           * row before its first definitive answer) retains nothing, because
           * there is no one to bind it to. No row means the account already
           * left (forgetAccountState); a window for it would be an empty row.
           */
          const existing = collections.recommendations.get(RECOMMENDATION_ID)
          if (existing === undefined) return
          const owner = accountOwnerOf(collections.identitySessions.get("identity"))
          if (owner === undefined) return
          collections.recommendations.update(RECOMMENDATION_ID, (draft) => {
            draft.retry = { at: transition.retryAt, owner, origin: transition.origin }
          })
          break
        }
        default: {
          const exhaustive: never = transition
          throw new Error(`Unknown app transition: ${String((exhaustive as { type?: unknown }).type)}`)
        }
      }
      if (position !== undefined) return
      // Conversation/archive/tab actions can end the turn seat without a
      // transport terminal frame. Their local cancellation must not leave a
      // recovery record claiming that the old conversation is still active.
      if (collections.sessions.get(SESSION_ID)?.phase !== "responding") {
        for (const turn of collections.httpTurns.values()) {
          if (turn.status !== "active" || turn.turnId !== current.turnId) continue
          const status = transition.type === "message.response.completed" ? "complete" : transition.type === "message.response.failed" ? "failed" : "cancelled"
          collections.httpTurns.update(turn.id, draft => { draft.status = status; draft.revision = revision })
          if (collections.httpTurnLegs.has(turn.legId)) collections.httpTurnLegs.update(turn.legId, draft => { draft.status = status })
        }
      }
      // Every transition that reaches here applied, so it takes its revision once.
      collections.sessions.update(SESSION_ID, (draft) => { draft.revision = revision })

      /*
       * /verbose: the maintainer's view of everything. A traced transition
       * becomes one marker line in the transcript. Read from `current` (the session before
       * this dispatch) so the switch-off dispatch itself is not traced.
       */
      const traced = transition.type !== "app.reset" && current.verbose === true && (transition.type === "verbose.toggled" ? transition.on : true)
        ? verboseTrace(transition)
        : undefined
      if (traced !== undefined) {
        insertMessage({
          id: `${TRACE_MESSAGE_PREFIX}${revision}`,
          role: "smithers",
          text: traced,
          act: traced,
          status: "complete",
          createdAt,
          ordinal: nextOrdinal(collections)
        })
      }

      collections.transitions.insert({
        id: `transition-${revision}`,
        revision,
        actor: transition.actor,
        type: transition.type,
        payload: journalPayload(transitionPayload(transition)),
        createdAt
      })
      /*
       * Retention (docs/persistence.md): derived diagnostic logs compact inside
       * the appending transaction, so the bound is part of the atomic commit
       * and a crash can never leave a half-swept log.
       */
      const staleTransitions = staleLogKeys(
        [...collections.transitions.values()],
        MAX_TRANSITION_RECORDS,
        (record) => record.revision
      )
      if (staleTransitions.length > 0) collections.transitions.delete(staleTransitions)
      const staleToolCalls = staleLogKeys(
        [...collections.toolCalls.values()],
        MAX_TOOL_CALL_RECORDS,
        (record) => record.createdAt
      )
      if (staleToolCalls.length > 0) collections.toolCalls.delete(staleToolCalls)
      applied = true

  }
  reduce()
  return applied ? draft.finish() : previous
}
