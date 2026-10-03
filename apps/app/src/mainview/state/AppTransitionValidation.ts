import { ConversationHistorySchema } from "./ConversationHistory"
import { Data } from "effect"
import { AgentTurnBatchSchema,AgentTurnCursorSchema,AgentTurnJournalRequestSchema } from "@smthrs/rpc/AgentTurnJournal"
import { BillingPlanSchema,SandboxEntitlementSchema } from "@smthrs/rpc/BillingPlans"
import { ConfiguredModelSchema,ModelRecordIdSchema,ModelTestRecordSchema,SeatIdSchema } from "@smthrs/rpc/ConfiguredModel"
import { SignupSchema } from "./Signup"
import { RepoFileEntrySchema } from "@smthrs/rpc/LocalApp"
import { AgentTurnUsageSchema } from "@smthrs/rpc/NativeAgent"
import { REPOSITORY_ACCESS_VALUES } from "@smthrs/rpc/NativeRepository"
import { RepositoryHomeSchema } from "@smthrs/rpc/RepositoryHome"
import { z } from "zod"
import type { AppProjectionSnapshot } from "./AppProjection"
import {
ActorSchema,BranchSchema,CardHistorySchema,CardPatchSchema,CardSchema,ChangeRowSchema,
CloudRepositorySchema,CloudWorkspaceRowSchema,FrameSchema,GitHubAppStatusRowSchema,
MessageSchema,HISTORICAL_PALETTES,
RecommendationSourceSchema,RepositoryEntrySchema,RepositoryCommandEntrySchema,RepositoryFlowSchema,RepositoryJobObservationSchema,
QueuedPromptSchema,SessionSchema,StarredTargetSchema,SuggestionSchema,TabSchema,ToastSchema,
WorkingCopySchema,WorldDocumentSchema,
  WikiSpaceSchema,
type AppTransition,type Card,type Tab
} from "./AppState"
import { CommandIntentOutcomeSchema,CommandIntentSourceSchema } from "./CommandIntent"
import { INPUT_MODES } from "./InputMode"
import { PendingRecoveryScopeSchema } from "./PendingRecovery"
import { RepositoryContextSchema } from "./RepositoryContext"
import { RepositoryNotificationSchema } from "./RepositoryNotifications"
import { RuntimeApprovalObservationSchema,RuntimeApprovalSubmissionSchema,RuntimeObserverSchema,RuntimeRunObservationSchema,RuntimeScopeSchema } from "./RuntimeProjection"

const LocalRepositoryInspectionSchema = z.object({
  root: z.string(), name: z.string(), head: z.string().nullable(), branch: z.string().nullable(), remoteUrl: z.string().nullable()
}).strict()
const cardOf = <K extends Card["kind"]>(kind: K) => CardSchema.pipe(
  z.custom<Extract<Card, { kind: K }>>(card => typeof card === "object" && card !== null && "kind" in card && card.kind === kind)
)
const NewTabSchema = z.union(TabSchema.options.map(option => z.object(Object.fromEntries(
  Object.entries(option.shape).filter(([name]) => name !== "ordinal")
)).strict()) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]) as z.ZodType<Tab>

// Local producers may omit kind; the existing card provides its payload discriminator below.
const CardUpdatePatchSchema = z.object({
  kind: z.custom<Card["kind"]>(value => typeof value === "string" && CardSchema.options.some(option => option.shape.kind.value === value)).optional(),
  title: CardSchema.options[0].shape.title.optional(), body: CardSchema.options[0].shape.body,
  status: CardSchema.options[0].shape.status.optional(), createdAt: CardSchema.options[0].shape.createdAt.optional(),
  ordinal: CardSchema.options[0].shape.ordinal.optional(), payload: z.record(z.string(), z.unknown()).optional()
}).strict() as z.ZodType<Extract<AppTransition, { type: "card.updated" }>["patch"]>

/** Complete payload and actor contracts, keyed for constant-time validation before append or replay. */
export const APP_TRANSITION_SCHEMAS = {
  "gateway.run.observed": z.object({ type: z.literal("gateway.run.observed"), actor: z.literal("system"), observation: RuntimeRunObservationSchema }).strict(),
  "gateway.run.observer.changed": z.object({ type: z.literal("gateway.run.observer.changed"), actor: z.literal("system"), scope: RuntimeScopeSchema, observer: RuntimeObserverSchema }).strict(),
  "gateway.approvals.observed": RuntimeApprovalObservationSchema.extend({ type: z.literal("gateway.approvals.observed"), actor: z.literal("system") }).strict(),
  "approval.answer.changed": z.object({ type: z.literal("approval.answer.changed"), actor: z.literal("user"), id: z.string().min(1), question: z.string().regex(/^[0-9a-f]{64}$/), text: z.string() }).strict(),
  "gateway.approval.submission.changed": z.object({ type: z.literal("gateway.approval.submission.changed"), actor: z.enum(["user", "system"]), submission: RuntimeApprovalSubmissionSchema }).strict(),
  "http.turn.started": z.object({ type: z.literal("http.turn.started"), actor: z.enum(["user", "smithers"]), attemptId: z.string().min(1).max(160), turnId: z.string().min(1).max(160), text: z.string(), retry: z.boolean(), journal: AgentTurnJournalRequestSchema, preserveDraft: z.boolean().optional() }).strict(),
  "http.leg.prepared": z.object({ type: z.literal("http.leg.prepared"), actor: z.literal("system"), attemptId: z.string(), journal: AgentTurnJournalRequestSchema }).strict(),
  "http.leg.accepted": z.object({ type: z.literal("http.leg.accepted"), actor: z.literal("system"), attemptId: z.string(), legId: z.string(), cursor: AgentTurnCursorSchema }).strict(),
  "http.turn.batch.received": z.object({ type: z.literal("http.turn.batch.received"), actor: z.literal("system"), attemptId: z.string(), legId: z.string(), batch: AgentTurnBatchSchema }).strict(),
  "http.tool.started": z.object({ type: z.literal("http.tool.started"), actor: z.literal("smithers"), attemptId: z.string(), legId: z.string() }).strict(),
  "http.tool.settled": z.object({ type: z.literal("http.tool.settled"), actor: z.literal("smithers"), attemptId: z.string(), legId: z.string(), result: z.string() }).strict(),
  "http.turn.interrupted": z.object({ type: z.literal("http.turn.interrupted"), actor: z.enum(["user", "system"]), attemptId: z.string(), status: z.enum(["failed", "cancelled", "ambiguous"]), detail: z.string(), silent: z.boolean().optional() }).strict(),
  "command.intent.accepted": z.object({ type: z.literal("command.intent.accepted"), actor: ActorSchema, id: z.string().min(1), name: z.string().min(1), source: CommandIntentSourceSchema, invocationKey: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  "command.intent.settled": z.object({ type: z.literal("command.intent.settled"), actor: ActorSchema, id: z.string().min(1), outcome: CommandIntentOutcomeSchema, retryable: z.boolean().optional() }).strict(),
  "repo.update.observed": z.object({ "type": z.literal("repo.update.observed"), "actor": ActorSchema, "context": RepositoryContextSchema, "notifications": z.array(RepositoryNotificationSchema) }).strict(),
  "repo.update.published": z.object({ "type": z.literal("repo.update.published"), "actor": ActorSchema, "card": cardOf("repo-update"), "notifications": z.array(RepositoryNotificationSchema) }).strict(),
  "notifications.read": z.object({ "type": z.literal("notifications.read"), "actor": ActorSchema, "receipts": z.array(z.object({ "id": z.string(), "version": z.string() }).strict()) }).strict(),
  "notification.tagged": z.object({ "type": z.literal("notification.tagged"), "actor": ActorSchema, "id": z.string(), "tag": z.string() }).strict(),
  "card.recovered": z.object({ type: z.literal("card.recovered"), actor: ActorSchema, workspaceId: z.string(), branchId: z.string(), id: z.string(), card: CardSchema.nullable(), history: CardHistorySchema.optional() }).strict(),
  "card.view.loaded": z.object({ type: z.literal("card.view.loaded"), actor: ActorSchema, card: CardSchema }).strict(),
  "hint.dismissed": z.object({ type: z.literal("hint.dismissed"), actor: ActorSchema, id: z.string() }).strict(),
  "librarian.launches.changed": z.object({ type: z.literal("librarian.launches.changed"), actor: ActorSchema, launches: z.array(z.unknown()) }).strict(),
  "coding.provider.requests.changed": z.object({ type: z.literal("coding.provider.requests.changed"), actor: ActorSchema, requests: SessionSchema.shape.codingProviderRequests.unwrap() }).strict(),
  "secret.requests.changed": z.object({ type: z.literal("secret.requests.changed"), actor: ActorSchema, requests: SessionSchema.shape.secretRequests.unwrap() }).strict(),
  "egress.requests.changed": z.object({ type: z.literal("egress.requests.changed"), actor: ActorSchema, requests: SessionSchema.shape.egressRequests.unwrap() }).strict(),
  "stack.wiki.requests.changed": z.object({ type: z.literal("stack.wiki.requests.changed"), actor: ActorSchema, requests: SessionSchema.shape.wikiRequests.unwrap() }).strict(),
  "first-run.dismissed": z.object({ type: z.literal("first-run.dismissed"), actor: ActorSchema }).strict(),
  "signup.changed": z.object({ type: z.literal("signup.changed"), actor: ActorSchema, patch: SignupSchema.partial() }).strict(),
  "card.navigated": z.object({ "type": z.literal("card.navigated"), "actor": ActorSchema, "card": CardSchema }).strict(),
  "card.history.moved": z.object({ "type": z.literal("card.history.moved"), "actor": ActorSchema, "id": z.string(), "delta": z.union([z.literal(-1), z.literal(1)]) }).strict(),
  "input.mode.changed": z.object({ "type": z.literal("input.mode.changed"), "actor": ActorSchema, "mode": z.enum(INPUT_MODES) }).strict(),
  "dictation.changed": z.object({ "type": z.literal("dictation.changed"), "actor": ActorSchema, "listening": z.boolean() }).strict(),
  "prompt.queued": z.object({ type: z.literal("prompt.queued"), actor: z.literal("user"), prompt: QueuedPromptSchema, preserveDraft: z.boolean().optional() }).strict(),
  "prompt.removed": z.object({ type: z.literal("prompt.removed"), actor: z.literal("user"), id: z.string(), edit: z.boolean().optional() }).strict(),
  "prompt.queue.paused": z.object({ type: z.literal("prompt.queue.paused"), actor: ActorSchema, paused: z.boolean() }).strict(),
  "composer.changed": z.object({ "type": z.literal("composer.changed"), "actor": ActorSchema, "draft": z.string(), recoveryScope: PendingRecoveryScopeSchema.optional() }).strict(),
  "chat.sign-in.required": z.object({ type: z.literal("chat.sign-in.required"), actor: z.literal("system"), draft: z.string(), provider: z.enum(["github", "local"]), turnId: z.string().optional(), attemptId: z.string().optional() }).strict(),
  "message.submitted": z.object({ "type": z.literal("message.submitted"), "actor": z.enum(["user", "smithers"]), "turnId": z.string(), "text": z.string(), preserveDraft: z.boolean().optional() }).strict(),
  "message.response.delta": z.object({ "type": z.literal("message.response.delta"), "actor": z.literal("smithers"), "turnId": z.string(), "channel": z.enum(["text", "reasoning"]), "delta": z.string() }).strict(),
  "message.response.completed": z.object({ "type": z.literal("message.response.completed"), "actor": z.literal("smithers"), "turnId": z.string() }).strict(),
  "chat.usage.recorded": z.object({ "type": z.literal("chat.usage.recorded"), "actor": z.literal("smithers"), "turnId": z.string(), "usage": AgentTurnUsageSchema.strict() }).strict(),
  "message.response.failed": z.object({ "type": z.literal("message.response.failed"), "actor": z.literal("system"), "turnId": z.string(), "message": z.string() }).strict(),
  "message.retried": z.object({ "type": z.literal("message.retried"), "actor": z.literal("user"), "turnId": z.string() }).strict(),
  "message.response.cancelled": z.object({ "type": z.literal("message.response.cancelled"), "actor": z.enum(["user", "system"]), "turnId": z.string(), "detail": z.string().optional() }).strict(),
  "session.turn.orphaned": z.object({ "type": z.literal("session.turn.orphaned"), "actor": z.literal("system") }).strict(),
  "conversation.restored": z.object({ type: z.literal("conversation.restored"), actor: z.literal("system"), owner: z.string().min(1), afterRevision: z.number().int().nonnegative(), conversations: z.array(ConversationHistorySchema) }).strict(),
  "conversation.reset": z.object({ "type": z.literal("conversation.reset"), "actor": z.literal("user") }).strict(),
  "conversation.reset.asked": z.object({ "type": z.literal("conversation.reset.asked"), "actor": z.literal("user"), "open": z.boolean() }).strict(),
  "conversation.cleared": z.object({ "type": z.literal("conversation.cleared"), "actor": z.literal("user"), "branchId": z.string(), "notes": z.array(z.object({ "title": z.string(), "body": z.string(), "confidence": z.number().finite() }).strict()), "interruptedTurnId": z.string().optional() }).strict(),
  "app.reset": z.object({ "type": z.literal("app.reset"), "actor": ActorSchema }).strict(),
  "theme.changed": z.object({ "type": z.literal("theme.changed"), "actor": z.enum(["user", "system"]), "theme": SessionSchema.shape["theme"] }).strict(),
  "palette.changed": z.object({ "type": z.literal("palette.changed"), "actor": z.enum(["user", "system"]), "palette": z.enum(HISTORICAL_PALETTES) }).strict(),
  "card.maximized": z.object({ "type": z.literal("card.maximized"), "actor": z.literal("user"), "id": z.string() }).strict(),
  "card.minimized": z.object({ "type": z.literal("card.minimized"), "actor": z.literal("user") }).strict(),
  "frame.navigated": z.object({ "type": z.literal("frame.navigated"), "actor": z.enum(["user", "system"]), "workspaceId": z.string(), "branchId": z.string(), "frameId": z.string() }).strict(),
  "frame.forked": z.object({ "type": z.literal("frame.forked"), "actor": z.literal("user"), "branch": BranchSchema, "rootFrame": FrameSchema, "selectedFrame": FrameSchema }).strict(),
  "devtools.toggled": z.object({ "type": z.literal("devtools.toggled"), "actor": z.literal("user"), "open": z.boolean() }).strict(),
  "verbose.toggled": z.object({ "type": z.literal("verbose.toggled"), "actor": z.literal("user"), "on": z.boolean() }).strict(),
  "flow.invoked": z.object({ "type": z.literal("flow.invoked"), "actor": ActorSchema, "name": z.string(), "args": z.union([z.string(), z.null()]), "hidden": z.boolean(), "outcome": z.enum(["executed", "failed", "unknown-command", "deferred", "confirm-requested", "form"]), "detail": z.union([z.string(), z.null()]), "durationMs": z.number().finite() }).strict(),
  "surfaces-menu.toggled": z.object({ "type": z.literal("surfaces-menu.toggled"), "actor": z.literal("user"), "open": z.boolean() }).strict(),
  "connect-menu.toggled": z.object({ "type": z.literal("connect-menu.toggled"), "actor": z.literal("user"), "open": z.boolean() }).strict(),
  "add-menu.toggled": z.object({ "type": z.literal("add-menu.toggled"), "actor": z.literal("user"), "open": z.boolean() }).strict(),
  "chat-filter.menu.toggled": z.object({ type: z.literal("chat-filter.menu.toggled"), actor: ActorSchema, open: z.boolean() }).strict(),
  "chat-filter.changed": z.object({ type: z.literal("chat-filter.changed"), actor: ActorSchema, filter: SessionSchema.shape.chatFilter.unwrap() }).strict(),
  "palette.toggled": z.object({ "type": z.literal("palette.toggled"), "actor": z.enum(["user", "system"]), "open": z.boolean(), "lastQuery": z.string().optional() }).strict(),
  "palette.actions.toggled": z.object({ "type": z.literal("palette.actions.toggled"), "actor": z.literal("user"), "ref": z.union([z.string(), z.null()]) }).strict(),
  "palette.item.opened": z.object({ "type": z.literal("palette.item.opened"), "actor": z.literal("user"), "ref": z.string(), "kind": z.string(), "at": z.number().finite() }).strict(),
  "command.deferred": z.object({ "type": z.literal("command.deferred"), "actor": z.literal("user"), "name": z.string(), "args": z.union([z.string(), z.null()]), "requirement": z.string(), repositoryRetry: z.object({ requestId: z.string(), repo: z.string() }).strict().optional(), repositoryRequest: z.object({ requestId: z.string(), repo: z.string(), owner: z.string().nullable() }).strict().optional() }).strict(),
  "command.deferral.cleared": z.object({ "type": z.literal("command.deferral.cleared"), "actor": z.literal("system") }).strict(),
  "approvals.inbox.requested": z.object({ "type": z.literal("approvals.inbox.requested"), "actor": z.enum(["user", "smithers"]), "request": z.object({ id: z.string().min(1), repo: z.string().min(1), workspaceId: z.string().optional(), owner: z.string().min(1) }).strict() }).strict(),
  "approvals.inbox.settled": z.object({ "type": z.literal("approvals.inbox.settled"), "actor": z.literal("system"), "id": z.string().min(1), "error": z.string().optional() }).strict(),
  "runs.open.requested": z.object({ type: z.literal("runs.open.requested"), actor: z.enum(["user", "smithers"]), request: z.object({ id: z.string().min(1), repo: z.string().min(1), workspaceId: z.string().optional(), owner: z.string().min(1), runId: z.string().min(1), cardId: z.string(), requireExisting: z.boolean().optional() }).strict() }).strict(),
  "runs.open.settled": z.object({ type: z.literal("runs.open.settled"), actor: z.literal("system"), id: z.string().min(1), error: z.string().optional() }).strict(),
  "command.ran": z.object({ "type": z.literal("command.ran"), "actor": z.literal("user"), "name": z.string() }).strict(),
  "toolcall.recorded": z.object({ "type": z.literal("toolcall.recorded"), "actor": z.literal("smithers"), "turnId": z.string(), "name": z.string(), "arguments": z.string(), "result": z.string() }).strict(),
  "composer.control.changed": z.object({ "type": z.literal("composer.control.changed"), "actor": z.enum(["smithers", "system"]), "owner": SessionSchema.shape["composerOwner"], "draft": z.string().optional() }).strict(),
  "surface.changed": z.object({ "type": z.literal("surface.changed"), "actor": ActorSchema, "surface": SessionSchema.shape["surface"] }).strict(),
  "plugin.installed": z.object({ "type": z.literal("plugin.installed"), "actor": ActorSchema, "plugin": z.string() }).strict(),
  "plugin.removed": z.object({ "type": z.literal("plugin.removed"), "actor": ActorSchema, "plugin": z.string() }).strict(),
  "world.document.selected": z.object({ "type": z.literal("world.document.selected"), "actor": ActorSchema, "id": z.string() }).strict(),
  "world.document.upserted": z.object({ "type": z.literal("world.document.upserted"), "actor": ActorSchema, recoveryScope: PendingRecoveryScopeSchema.optional(), "document": WorldDocumentSchema.omit({ "updatedAt": true, "updatedBy": true, "revision": true }), "select": z.boolean().optional() }).strict(),
  "world.document.removed": z.object({ "type": z.literal("world.document.removed"), "actor": ActorSchema, "id": z.string() }).strict(),
  "wiki.pane.changed": z.object({ "type": z.literal("wiki.pane.changed"), "actor": ActorSchema, "pane": z.enum(["document", "graph"]), "path": z.union([z.string(), z.null()]) }).strict(),
  "wiki.space.changed": z.object({ "type": z.literal("wiki.space.changed"), "actor": ActorSchema, "space": WikiSpaceSchema }).strict(),
  "wiki.page-view.changed": z.object({ "type": z.literal("wiki.page-view.changed"), "actor": ActorSchema, "view": z.enum(["read", "edit"]) }).strict(),
  "world.delete.asked": z.object({ "type": z.literal("world.delete.asked"), "actor": ActorSchema, "id": z.union([z.string(), z.null()]) }).strict(),
  "connector.local.requested": z.object({ "type": z.literal("connector.local.requested"), "actor": z.literal("user"), "access": z.enum(REPOSITORY_ACCESS_VALUES) }).strict(),
  "connector.local.cancelled": z.object({ "type": z.literal("connector.local.cancelled"), "actor": z.enum(["user", "system"]) }).strict(),
  "connector.local.failed": z.object({ "type": z.literal("connector.local.failed"), "actor": z.literal("system"), "message": z.string() }).strict(),
  "connector.local.connected": z.object({ "type": z.literal("connector.local.connected"), "actor": z.literal("system"), "access": z.enum(REPOSITORY_ACCESS_VALUES), "repository": LocalRepositoryInspectionSchema }).strict(),
  "connector.access.changed": z.object({ "type": z.literal("connector.access.changed"), "actor": z.literal("user"), "id": z.string(), "access": z.enum(REPOSITORY_ACCESS_VALUES) }).strict(),
  "connector.removal.asked": z.object({ "type": z.literal("connector.removal.asked"), "actor": z.literal("user"), "id": z.union([z.string(), z.null()]) }).strict(),
  "connector.removed": z.object({ "type": z.literal("connector.removed"), "actor": z.literal("user"), "id": z.string() }).strict(),
  "card.upsert": z.object({ "type": z.literal("card.upsert"), "actor": ActorSchema, "card": CardSchema, turnId: z.string().optional() }).strict(),
  "card.updated": z.object({ "type": z.literal("card.updated"), "actor": ActorSchema, "id": z.string(), "patch": CardUpdatePatchSchema }).strict(),
  "card.approval.decision.pending": z.object({ "type": z.literal("card.approval.decision.pending"), "actor": z.literal("user"), "id": z.string() }).strict(),
  "card.approval.decision.failed": z.object({ "type": z.literal("card.approval.decision.failed"), "actor": z.literal("system"), "id": z.string(), "message": z.string() }).strict(),
  "card.approval.decided": z.object({ "type": z.literal("card.approval.decided"), "actor": z.literal("user"), "id": z.string(), "decision": z.enum(["approved", "denied"]), "decidedAt": z.number().finite() }).strict(),
  "card.approval.observed": z.object({ "type": z.literal("card.approval.observed"), "actor": z.literal("system"), "id": z.string(), "runId": z.string(), "requestId": z.string(), "digest": z.string(), "decision": z.enum(["approved", "denied"]) }).strict(),
  "identity.session.loaded": z.object({ "type": z.literal("identity.session.loaded"), provider: z.enum(["github", "local"]).optional(), "actor": z.literal("system"), "state": z.enum(["signed-out", "signed-in", "unavailable"]), "login": z.union([z.string(), z.null()]), displayName: z.string().min(1).optional(), "admin": z.boolean(), "scopesPlain": z.union([z.string(), z.null()]) }).strict(),
  "identity.session.cleared": z.object({ "type": z.literal("identity.session.cleared"), "actor": z.literal("user") }).strict(),
  "billing.refreshed": z.object({ "type": z.literal("billing.refreshed"), "actor": z.literal("system"), "state": z.enum(["ok", "low", "empty"]), "totalUsd": z.string(), "allowedToStartWork": z.boolean(), "lifetimeChargedUsd": z.string(), "chargeCount": z.number().finite() }).strict(),
  "billing.plans.loaded": z.object({ type: z.literal("billing.plans.loaded"), actor: ActorSchema, planKey: z.string(), sandbox: SandboxEntitlementSchema.nullable(), plans: z.array(BillingPlanSchema), creditBalanceCents: z.number().int().nullable().optional(), creditResetsAt: z.string().nullable().optional() }).strict(),
  "billing.unavailable": z.object({ "type": z.literal("billing.unavailable"), "actor": z.literal("system") }).strict(),
  "toast.shown": z.object({ "type": z.literal("toast.shown"), sourceCard: z.string().optional(), "actor": z.literal("system"), "key": z.string(), "title": z.string(), "action": ToastSchema.shape["action"].optional() }).strict(),
  "toast.progressed": z.object({ "type": z.literal("toast.progressed"), "actor": z.literal("system"), "key": z.string(), "detail": z.string(), "title": z.string().optional() }).strict(),
  "toast.resolved": z.object({ "type": z.literal("toast.resolved"), "actor": z.literal("system"), "key": z.string(), "status": z.enum(["ok", "failed", "cancelled"]), "title": z.string().optional(), "detail": z.string(), "action": ToastSchema.shape["action"].optional() }).strict(),
  "toast.dismissed": z.object({ "type": z.literal("toast.dismissed"), "actor": z.enum(["user", "system"]), "id": z.string() }).strict(),
  "card.removed": z.object({ "type": z.literal("card.removed"), "actor": ActorSchema, "id": z.string() }).strict(),
  "message.tool.executed": z.object({ "type": z.literal("message.tool.executed"), "actor": z.literal("smithers"), "turnId": z.string(), "text": z.string() }).strict(),
  "message.steered": z.object({ "type": z.literal("message.steered"), "actor": z.literal("user"), "turnId": z.string(), "text": z.string(), preserveDraft: z.boolean().optional() }).strict(),
  "message.claim.substituted": z.object({ "type": z.literal("message.claim.substituted"), "actor": z.literal("system"), "turnId": z.string(), "text": z.string() }).strict(),
  "message.commands.disclosed": z.object({ "type": z.literal("message.commands.disclosed"), "actor": z.enum(["system", "smithers"]), "turnId": z.string(), "names": z.array(z.string().min(1).max(160)).max(64) }).strict(),
  "confirmation.cancelled": z.object({ type: z.literal("confirmation.cancelled"), actor: z.literal("user"), id: z.string(), revision: z.string() }).strict(),
  "message.appended": z.object({ "type": z.literal("message.appended"), "actor": z.enum(["system", "user", "smithers"]), "text": z.string(), "action": MessageSchema.shape["action"].optional(), "spoken": MessageSchema.shape["spoken"] }).strict(),
  "tab.opened": z.object({ "type": z.literal("tab.opened"), "actor": ActorSchema, "tab": NewTabSchema }).strict(),
  "tab.selected": z.object({ "type": z.literal("tab.selected"), "actor": ActorSchema, "id": z.string() }).strict(),
  "tab.closed": z.object({ "type": z.literal("tab.closed"), "actor": z.enum(["user", "system"]), "id": z.string() }).strict(),
  "status.expired": z.object({ "type": z.literal("status.expired"), "actor": z.literal("system"), "now": z.number().finite(), "runtime": z.literal(true).optional() }).strict(),
  "models.observed": z.object({ "type": z.literal("models.observed"), "actor": z.literal("system"), "models": z.array(ConfiguredModelSchema) }).strict(),
  "model.saved": z.object({ "type": z.literal("model.saved"), "actor": ActorSchema, "model": ConfiguredModelSchema }).strict(),
  "model.removed": z.object({ "type": z.literal("model.removed"), "actor": ActorSchema, "id": ModelRecordIdSchema }).strict(),
  "model.tested": z.object({ "type": z.literal("model.tested"), "actor": z.literal("system"), "test": ModelTestRecordSchema }).strict(),
  "seat.assigned": z.object({ "type": z.literal("seat.assigned"), "actor": ActorSchema, "seat": SeatIdSchema, "recordId": ModelRecordIdSchema.nullable() }).strict(),
  "repositories.loaded": z.object({ "type": z.literal("repositories.loaded"), "actor": z.literal("system"), "repositories": z.array(CloudRepositorySchema.pick({ "id": true, "org": true, "ownerKind": true, "name": true, "head": true, "catalog": true, "summary": true })) }).strict(),
  "repository.upserted": z.object({ "type": z.literal("repository.upserted"), "actor": z.literal("system"), "repository": CloudRepositorySchema.pick({ "id": true, "org": true, "ownerKind": true, "name": true, "head": true, "catalog": true, "summary": true }) }).strict(),
  "workingcopies.workspaces.loaded": z.object({ "type": z.literal("workingcopies.workspaces.loaded"), "actor": z.literal("system"), "copies": z.array(WorkingCopySchema.pick({ "id": true, "repoId": true, "kind": true, "label": true, "workspaceId": true, "state": true })) }).strict(),
  "cloud.session.loaded": z.object({ "type": z.literal("cloud.session.loaded"), "actor": z.literal("system"), "state": z.enum(["signed-out", "signing-in", "signed-in"]), "username": z.union([z.string(), z.null()]), "expiresAt": z.union([z.string(), z.null()]), "scopes": z.union([z.literal("degraded"), z.null()]) }).strict(),
  "workspaces.list.started": z.object({ type: z.literal("workspaces.list.started"), actor: z.literal("system"), requestId: z.string(), repoId: z.string().optional() }).strict(),
  "workspaces.list.failed": z.object({ type: z.literal("workspaces.list.failed"), actor: z.literal("system"), requestId: z.string(), repoId: z.string().optional(), error: z.string() }).strict(),
  "workspaces.loaded": z.object({ "type": z.literal("workspaces.loaded"), "actor": z.literal("system"), requestId: z.string().optional(), "workspaces": z.array(CloudWorkspaceRowSchema.omit({ updatedAt: true, revision: true })), "repoId": z.string().optional() }).strict(),
  "workspace.updated": z.object({ "type": z.literal("workspace.updated"), "actor": z.literal("system"), "workspace": CloudWorkspaceRowSchema.omit({ updatedAt: true, revision: true }) }).strict(),
  "workspace.session.destroyed": z.object({ "type": z.literal("workspace.session.destroyed"), "actor": ActorSchema, "sessionId": z.string() }).strict(),
  "workspace.deleted": z.object({ "type": z.literal("workspace.deleted"), "actor": ActorSchema, "workspaceId": z.string() }).strict(),
  "change.loaded": z.object({ "type": z.literal("change.loaded"), "actor": z.literal("system"), "change": ChangeRowSchema.omit({ updatedAt: true, revision: true }) }).strict(),
  "github.app-status.loaded": z.object({ "type": z.literal("github.app-status.loaded"), "actor": z.literal("system"), "status": GitHubAppStatusRowSchema.omit({ updatedAt: true, revision: true }) }).strict(),
  "repo.selected": z.object({ "type": z.literal("repo.selected"), "actor": ActorSchema, "id": z.string() }).strict(),
  "repository.entry.changed": z.object({ type: z.literal("repository.entry.changed"), actor: z.literal("system"), entry: RepositoryEntrySchema.nullable() }).strict(),
  "repository.command.changed": z.object({ type: z.literal("repository.command.changed"), actor: z.literal("system"), entry: RepositoryCommandEntrySchema }).strict(),
  "repo-tree.toggled": z.object({ "type": z.literal("repo-tree.toggled"), "actor": ActorSchema, "copyId": z.string(), "path": z.string(), "expanded": z.boolean() }).strict(),
  "repo-tree.loading": z.object({ "type": z.literal("repo-tree.loading"), "actor": ActorSchema, "copyId": z.string(), "path": z.string() }).strict(),
  "repo-tree.loaded": z.object({ "type": z.literal("repo-tree.loaded"), "actor": z.literal("system"), "copyId": z.string(), "path": z.string(), "entries": z.array(RepoFileEntrySchema), "truncated": z.boolean() }).strict(),
  "repo-tree.failed": z.object({ "type": z.literal("repo-tree.failed"), "actor": z.literal("system"), "copyId": z.string(), "path": z.string(), "error": z.string() }).strict(),
  "repository-job.observed": z.object({ type: z.literal("repository-job.observed"), actor: z.literal("system"), observation: RepositoryJobObservationSchema }).strict(),
  "repository-flows.loaded": z.object({ "type": z.literal("repository-flows.loaded"), "actor": z.literal("system"), "repo": z.string(), "flows": z.array(RepositoryFlowSchema), "home": z.union([RepositoryHomeSchema, z.object({ kind: z.literal("error"), message: z.string() })]).optional() }).strict(),
  "flow-durations.loaded": z.object({ "type": z.literal("flow-durations.loaded"), "actor": z.literal("system"), "repo": z.string(), "workspaceId": z.string().optional(), "flowId": z.string(), "rows": z.array(z.object({ "actionTag": z.string(), "samples": z.number(), "p50Ms": z.number(), "p90Ms": z.number() }).strict()) }).strict(),
  "workspace.renamed": z.object({ "type": z.literal("workspace.renamed"), "actor": ActorSchema, "name": z.string() }).strict(),
  "workspace.rename.toggled": z.object({ "type": z.literal("workspace.rename.toggled"), "actor": z.literal("user"), "open": z.boolean() }).strict(),
  "target.starred": z.object({ "type": z.literal("target.starred"), "actor": ActorSchema, "repoId": z.string(), "star": StarredTargetSchema }).strict(),
  "target.unstarred": z.object({ "type": z.literal("target.unstarred"), "actor": ActorSchema, "repoId": z.string(), "id": z.string() }).strict(),
  "recommendations.updated": z.object({ "type": z.literal("recommendations.updated"), "actor": z.enum(["system", "smithers"]), "suggestions": z.array(SuggestionSchema), "source": RecommendationSourceSchema, "revision": z.number().finite() }).strict(),
  "recommendations.deferred": z.object({ "type": z.literal("recommendations.deferred"), "actor": z.literal("system"), "retryAt": z.number().finite(), "origin": z.string().min(1).max(512) }).strict(),
} as const satisfies { [K in AppTransition["type"]]: z.ZodType<Extract<AppTransition, { type: K }>> }

export class InvalidAppTransitionError extends Data.TaggedError("InvalidAppTransitionError")<{ readonly message: string }> {
  constructor() { super({ message: "The app transition does not match its event contract." }) }
}

/** Input must already be detached by the lossless codec; this function never reads a host. */
export const validateAppTransition = (snapshot: AppProjectionSnapshot, value: unknown): AppTransition => {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string" ||
    !Object.hasOwn(APP_TRANSITION_SCHEMAS, value.type)) throw new InvalidAppTransitionError()
  const schema: z.ZodType<AppTransition> = APP_TRANSITION_SCHEMAS[value.type as AppTransition["type"]]
  const decoded = schema.safeParse(value)
  if (!decoded.success) throw new InvalidAppTransitionError()
  const transition = decoded.data
  if (transition.type === "card.updated") {
    const existing = snapshot.cards.find(card => card.id === transition.id)
    // A missing row or a deliberate kind mismatch retains the reducer's no-op contract.
    if (existing && (transition.patch.kind === undefined || transition.patch.kind === existing.kind)) {
      const patch = CardPatchSchema.safeParse({ ...transition.patch, kind: existing.kind })
      if (!patch.success) throw new InvalidAppTransitionError()
      return { ...transition, patch: { ...patch.data, ...(transition.patch.kind === undefined ? { kind: undefined } : {}) } }
    }
  }
  return transition
}
