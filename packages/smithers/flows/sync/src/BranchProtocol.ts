/**
 * The branch collaboration contract: a branch is one shared live document.
 *
 * A branch has no store of its own. Its durable state is exactly one journal
 * run — `branchRunId` is the only mapping — so every replication guarantee the
 * rest of this package already provides (canonical per-run `seq`, exclusive
 * cursors, gap detection, resumable follow) carries over unchanged, and
 * multiplayer never introduces a second source of truth.
 *
 * Ephemeral collaboration state (presence, cursors) deliberately has no
 * representation here beyond the wire shapes: it is leased, never journalled.
 *
 * @since 0.1.0
 */

import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Schema for the identifier of one collaboratively edited branch.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BranchId = Schema.NonEmptyString.pipe(Schema.brand("@smthrs/sync/BranchProtocol/BranchId"))

/**
 * Identifier of one collaboratively edited branch.
 *
 * @category models
 * @since 0.1.0
 */
export type BranchId = typeof BranchId.Type

/**
 * Schema for the identifier of one connected client.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ParticipantId = Schema.NonEmptyString.pipe(Schema.brand("@smthrs/sync/BranchProtocol/ParticipantId"))

/**
 * Identifier of one connected client.
 *
 * @category models
 * @since 0.1.0
 */
export type ParticipantId = typeof ParticipantId.Type

/**
 * Schema for a client-minted command identifier.
 *
 * The identifier is minted once per user intent and reused across optimistic
 * application, retransmission, and concurrent submission, which is what makes
 * it the idempotency key rather than a correlation id.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CommandId = Schema.NonEmptyString.pipe(Schema.brand("@smthrs/sync/BranchProtocol/CommandId"))

/**
 * Client-minted command identifier used as the idempotency key.
 *
 * @category models
 * @since 0.1.0
 */
export type CommandId = typeof CommandId.Type

/**
 * Schema for the access a share capability grants.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Access = Schema.Literals(["read", "write"])

/**
 * The access a share capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export type Access = typeof Access.Type

/**
 * The journal run backing a branch document.
 *
 * The prefix keeps branch runs from colliding with engine runs in the same
 * workspace journal, and makes the mapping reversible for tooling.
 *
 * @category constructors
 * @since 0.1.0
 */
export const branchRunId = (branchId: BranchId): JournalEvent.RunId =>
  `${branchRunPrefix}${branchId}` as JournalEvent.RunId

/** The one prefix {@link branchRunId} writes and {@link branchOfRunId} reads. */
const branchRunPrefix = "flows/branch/"

/**
 * The branch a journal run belongs to, or `null` for a non-branch run.
 *
 * The bare prefix is a non-branch run, not a branch with an empty id.
 * `BranchId` is a branded `NonEmptyString`, so branding `""` would produce a
 * value the brand forbids and hand it to `share.verify` as the branch under
 * authorization. Refusing it here keeps the brand's promise true everywhere
 * downstream of this function.
 *
 * @category constructors
 * @since 0.1.0
 */
export const branchOfRunId = (runId: JournalEvent.RunId): BranchId | null => {
  if (!runId.startsWith(branchRunPrefix)) return null
  const rest = runId.slice(branchRunPrefix.length)
  return rest.length === 0 ? null : rest as BranchId
}

/**
 * The journal producer identity of one admitted command.
 *
 * `(runId, sourceId, sourceSeq)` is the journal's own durable idempotency
 * key. Deriving the source from the client-minted `commandId` — with the
 * fixed {@link commandSourceSeq} — turns that key into the branch's
 * exactly-once admission constraint: two server instances racing the same
 * command collide inside the journal's own transaction, so one appends and
 * the other reads back the canonical sequence, instead of both appending
 * (audit finding F-14). The branch run id already scopes the key, so equal
 * command ids on different branches never collide.
 *
 * @category constructors
 * @since 0.1.0
 */
export const commandSourceId = (commandId: CommandId): JournalEvent.SourceId =>
  `flows/branch-command/${commandId}` as JournalEvent.SourceId

/**
 * The fixed producer sequence of an admitted command.
 *
 * A command's identity lives entirely in {@link commandSourceId}, so its
 * producer sequence is always 0. It must be supplied explicitly: letting the
 * journal allocate would hand a resubmission after a lost response sequence 1,
 * a fresh identity, and therefore a second durable append.
 *
 * @category constructors
 * @since 0.1.0
 */
export const commandSourceSeq: JournalEvent.SourceSeq = 0 as JournalEvent.SourceSeq

/**
 * The single durable event type a branch document is built from.
 *
 * Chat, edits, and flow launches are all commands, so the branch journal has
 * exactly one event shape and the projection has exactly one decoder.
 *
 * @category models
 * @since 0.1.0
 */
export const CommandEvent = "flows/branch/command"

/**
 * Schema for the claims a share capability carries.
 *
 * `kid` names the key that signed the claims and is itself signed, so a
 * verifier both selects the right key out of a rotating keyring and refuses a
 * capability whose key name was swapped after minting. It matches
 * `WorkspaceShare.WorkspaceClaims`: the two authorities are one scheme, and a
 * branch link that could not survive a secret rotation was the only place they
 * differed.
 *
 * @category schemas
 * @since 0.1.0
 */
export class ShareClaims extends Schema.Class<ShareClaims>("@smthrs/sync/BranchProtocol/ShareClaims")({
  kid: Schema.NonEmptyString,
  branchId: BranchId,
  capabilityId: Schema.NonEmptyString,
  access: Access,
  issuedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for a signed, expiring, branch-scoped share capability.
 *
 * @category schemas
 * @since 0.1.0
 */
export class ShareCapability extends Schema.Class<ShareCapability>("@smthrs/sync/BranchProtocol/ShareCapability")({
  claims: ShareClaims,
  signature: Schema.String
}) {}

/**
 * Schema for a participant's caret inside one embedded card.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Cursor extends Schema.Class<Cursor>("@smthrs/sync/BranchProtocol/Cursor")({
  cardId: Schema.NonEmptyString,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for one live participant on a branch.
 *
 * `leaseExpiresAtMs` is the whole lifetime contract: presence is a lease, so a
 * client that disconnects without saying so disappears on its own.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Participant extends Schema.Class<Participant>("@smthrs/sync/BranchProtocol/Participant")({
  branchId: BranchId,
  participantId: ParticipantId,
  displayName: Schema.NonEmptyString,
  cursor: Schema.NullOr(Cursor),
  leaseExpiresAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for a capability-bearing request for one branch's roster.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RosterRequest = Schema.Struct({ capability: ShareCapability, branchId: BranchId })

/**
 * A capability-bearing request for one branch's roster.
 *
 * @category models
 * @since 0.1.0
 */
export type RosterRequest = typeof RosterRequest.Type

/**
 * Schema for a capability-bearing request to drop one participant.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LeaveRequest = Schema.Struct({ ...RosterRequest.fields, participantId: ParticipantId })

/**
 * A capability-bearing request to drop one participant.
 *
 * @category models
 * @since 0.1.0
 */
export type LeaveRequest = typeof LeaveRequest.Type

/**
 * Schema for one participant's announcement of itself on a branch.
 *
 * The same shape serves join, heartbeat, and cursor movement: an announcement
 * is idempotent, so a client that reconnects simply announces again.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Announcement = Schema.Struct({
  capability: ShareCapability,
  branchId: BranchId,
  participantId: ParticipantId,
  displayName: Schema.NonEmptyString,
  cursor: Schema.NullOr(Cursor)
})

/**
 * One participant's announcement of itself on a branch.
 *
 * @category models
 * @since 0.1.0
 */
export type Announcement = typeof Announcement.Type

/**
 * Schema for one submitted command or flow invocation.
 *
 * Every user action on a shared branch arrives here first — chat messages are
 * the `branch.say` command, renames are `branch.rename`, and a flow launch is
 * that flow's own name. `target` names the shared field a command durably
 * edits and is `""` for commands that only append.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CommandSubmission extends Schema.Class<CommandSubmission>(
  "@smthrs/sync/BranchProtocol/CommandSubmission"
)({
  branchId: BranchId,
  commandId: CommandId,
  participantId: ParticipantId,
  name: Schema.NonEmptyString,
  args: Schema.String,
  target: Schema.String
}) {}

/**
 * Schema for a capability-bearing command submission.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SubmitRequest = Schema.Struct({ capability: ShareCapability, submission: CommandSubmission })

/**
 * A capability-bearing command submission.
 *
 * @category models
 * @since 0.1.0
 */
export type SubmitRequest = typeof SubmitRequest.Type

/**
 * The durable payload stored for an admitted command.
 *
 * Distinct from the wire request: `args` and `target` carry decoding defaults,
 * so a row written before those fields existed still decodes rather than
 * failing the whole ledger rebuild.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CommandEventPayload extends Schema.Class<CommandEventPayload>(
  "@smthrs/sync/BranchProtocol/CommandEventPayload"
)({
  commandId: CommandId,
  participantId: ParticipantId,
  name: Schema.NonEmptyString,
  args: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  target: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
}) {}

/**
 * The command that appends a collaborative chat message.
 *
 * @category models
 * @since 0.1.0
 */
export const SayCommand = "branch.say"

/**
 * Schema for the outcome of admitting a command.
 *
 * `duplicate` is a success, not a failure: it reports the canonical sequence
 * the original submission already occupies so a retransmitting client can
 * settle its optimistic row instead of executing the command twice.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CommandReceipt extends Schema.Class<CommandReceipt>("@smthrs/sync/BranchProtocol/CommandReceipt")({
  branchId: BranchId,
  commandId: CommandId,
  status: Schema.Literals(["admitted", "duplicate"]),
  seq: JournalEvent.Seq
}) {}
