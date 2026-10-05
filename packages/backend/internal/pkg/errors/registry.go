package errors

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

// Code is a machine-readable failure code. It is a CLOSED set: every value a
// plue response may carry is declared as a constant in this file and has a row
// in registry. Clients branch on it, so a code is a contract — renaming one is
// a breaking change, and inventing one at a call site is a bug the type system
// catches (a bare string cannot be assigned to a Code field unless it is an
// untyped constant, and ParseCode is the only reviewed way to turn a runtime
// string into a Code).
type Code string

// Fault answers the only question a client has when something fails: whose
// problem is this, and what should the interface say?
//
//	user       the caller asked for something it may not have. Fix the request.
//	wait       nothing is wrong; the thing is not ready yet. Retry.
//	infra      plue's own platform failed the caller. Not their fault, and
//	           retrying the same request may work once capacity or a component
//	           comes back.
//	dependency something plue depends on (GitHub, a payment provider, a model
//	           provider) failed or throttled us.
//	bug        plue is defective. The message is never shown to the caller.
//	factory    the factory's own work did not converge (a stalled plan, an
//	           unproven claim). A replan may fix it; it is nobody's request.
//	policy     a cap the owner set stopped the work. Not a defect and not
//	           the platform; raising the cap resumes it.
//
// factory and policy are stamped on failed runs (the observed run's
// failureFault) so the worker picks a response by class alone; no code row
// uses them yet.
type Fault string

const (
	FaultUser       Fault = "user"
	FaultWait       Fault = "wait"
	FaultInfra      Fault = "infra"
	FaultDependency Fault = "dependency"
	FaultBug        Fault = "bug"
	FaultFactory    Fault = "factory"
	FaultPolicy     Fault = "policy"
)

// Faults is every Fault, in the order a taxonomy reads: whose fault, then how
// bad. Exported for the generated artifact and for exhaustiveness checks.
var Faults = []Fault{FaultUser, FaultWait, FaultInfra, FaultDependency, FaultBug, FaultFactory, FaultPolicy}

// Class is the §6.2.3 failure class the app's fault copy is chosen by. Fault
// says whose problem a failure is; Class says which sentence the interface
// shows ("not your fault" for infra and capacity, "Only a person can do this"
// for never).
//
//	user        the request itself is wrong. Fix it.
//	permission  the credential is missing, dead, or not allowed (401, 403).
//	capacity    plue has no room right now.
//	github      GitHub failed or refused.
//	infra       plue's own platform failed.
//	conflict    the subject's state refuses the request.
//	never       this kind of actor may never do this (403).
type Class string

const (
	ClassUser       Class = "user"
	ClassPermission Class = "permission"
	ClassCapacity   Class = "capacity"
	ClassGitHub     Class = "github"
	ClassInfra      Class = "infra"
	ClassConflict   Class = "conflict"
	ClassNever      Class = "never"
)

// Classes is every Class, in §6.2.3 order.
var Classes = []Class{ClassUser, ClassPermission, ClassCapacity, ClassGitHub, ClassInfra, ClassConflict, ClassNever}

// Entry is everything the transport layer needs to answer a failure without
// asking the call site. The call site chooses the Code; it does not get to
// choose the HTTP status, the fault, or the retry pacing.
type Entry struct {
	// Status is the HTTP status this code is answered with.
	Status int
	// Fault is who the failure belongs to.
	Fault Fault
	// Class is the §6.2.3 class the envelope carries. Every code has one;
	// TestRegistryClasses enforces it.
	Class Class
	// RetryAfter, when > 0, is the number of seconds a client should wait
	// before retrying. It feeds the Retry-After header.
	RetryAfter int
	// Doc is one sentence, written for a human reading docs/failure-codes.json
	// in another repository. It says what happened, not what to do about it.
	Doc string
}

// Code blocks, grouped by what failed. Every constant here is a key in
// registry below, and every key in registry is a constant here;
// TestEveryCodeConstantIsRegistered parses this file and proves both.
// Generic codes. The code-less constructors carry these, and
// statusFallbackCode maps a bare status onto them so a hand-built APIError
// still reaches the wire with a code and a fault.
const (
	CodeBadRequest            Code = "bad_request"
	CodeUnauthorized          Code = "unauthorized"
	CodeSetupClosed           Code = "setup_closed"
	CodeOwnerUnverified       Code = "owner_unverified"
	CodeUnknownOrigin         Code = "unknown_origin"
	CodeUnauthenticated       Code = "unauthenticated"
	CodeInvalidToken          Code = "invalid_token"
	CodePermission            Code = "permission"
	CodeForbidden             Code = "forbidden"
	CodeNotFound              Code = "not_found"
	CodeConflict              Code = "conflict"
	CodeSetupRequestReused    Code = "setup_request_reused"
	CodeRequestEntityTooLarge Code = "request_entity_too_large"
	CodeUnsupportedMediaType  Code = "unsupported_media_type"
	CodeUnprocessableEntity   Code = "unprocessable_entity"
	CodeValidationFailed      Code = "validation_failed"
	CodeInternal              Code = "internal"
	CodeNotImplemented        Code = "not_implemented"
	CodeBadGateway            Code = "bad_gateway"
	CodeServiceUnavailable    Code = "service_unavailable"
	CodeGatewayTimeout        Code = "gateway_timeout"
)

// Budgets: the caller asked for more than it may have.
const (
	CodePlanLimitExceeded          Code = "plan_limit_exceeded"
	CodeQuotaExceeded              Code = "quota_exceeded"
	CodeWorkspaceResourcesExceeded Code = "workspace_resources_exceeded"
	CodeRateLimitExceeded          Code = "rate_limit_exceeded"
	CodeGitHubRateLimited          Code = "github_rate_limited"
	CodeRateLimiterUnavailable     Code = "rate_limiter_unavailable"
)

// Repository CI receipts.
const (
	CodeRepositoryCIRunUnverified Code = "repository_ci_run_unverified"
)

// Deployment shape: this build of plue is running somewhere that has not been
// given everything an endpoint needs.
const (
	CodeFeatureNotEnabled          Code = "feature_not_enabled"
	CodeCodingGatewayNotConfigured Code = "coding_gateway_not_configured"
)

// Identity and authorization of the human or the client.
const (
	CodeGitHubReconnectRequired Code = "github_reconnect_required"
	CodeGitHubForbiddenAction   Code = "FORBIDDEN_ACTION"
)

// Desktop observe/input verdicts. See docs/specs/workspaces.md.
const ()

// Workspace terminal and language-server sessions.
const (
	CodeLanguageServerMissing        Code = "language_server_missing"
	CodeWorkspaceSessionKindMismatch Code = "workspace_session_kind_mismatch"
	CodeWorkspaceSessionPending      Code = "workspace_session_pending"
)

// Boxes: provisioning, capacity, and source retention.
const (
	CodeNoCapacity                    Code = "no_capacity"
	CodeHostLeaseLost                 Code = "host_lease_lost"
	CodeProvisioningFailed            Code = "provisioning_failed"
	CodeGuestNotReady                 Code = "guest_not_ready"
	CodeRepositoryProvisioningRollout Code = "repository_provisioning_rollout"
	CodeEnvironmentImageUnavailable   Code = "environment_image_unavailable"
	CodeWorkspaceSourceMissing        Code = "workspace_source_missing"
	CodeWorkspaceSourceUnavailable    Code = "workspace_source_unavailable"
	CodeWorkspaceSourceInvalidAck     Code = "workspace_source_invalid_ack"
	CodeUserRefMissing                Code = "user_ref_missing"
	CodeUserRefStack                  Code = "user_ref_stack"
)

// Native coding operations run inside a box.
const (
	CodeCodingProvenancePending       Code = "coding_provenance_pending"
	CodeCodingOutcomeUnknown          Code = "coding_outcome_unknown"
	CodeCodingHostUnavailable         Code = "coding_host_unavailable"
	CodeCodingProviderRefreshRequired Code = "coding_provider_refresh_required"
	CodeCodingInvalidRequest          Code = "coding_invalid_request"
	CodeCodingUnsupportedJJ           Code = "coding_unsupported_jj"
	CodeCodingGuestFailure            Code = "coding_guest_failure"
	CodeCodingWorkspaceBusy           Code = "coding_workspace_busy"
	CodeCodingReporterUpgradeRequired Code = "coding_reporter_upgrade_required"
	CodeCodingFileConflict            Code = "coding_file_conflict"
	CodeCodingFileRecoveryRequired    Code = "coding_file_recovery_required"
	CodeCodingHostUpgradeRequired     Code = "coding_host_upgrade_required"
	CodeWorkspaceSSHUserInvalid       Code = "workspace_ssh_user_invalid"
	CodeWorkspaceVMMissing            Code = "workspace_vm_missing"
	CodeWorkspaceRebuildRequired      Code = "workspace_rebuild_required"
	CodeRepositoryWorkspacePending    Code = "repository_workspace_pending"
	CodeWorkspaceFailed               Code = "workspace_failed"
)

// The retired 0.x in-guest agent loop.
//
// plue used to ship its own agent loop (cmd/runner/workflow, the
// smithers-orchestrator 0.x library) and exec it inside the guest. That loop is
// deleted: plue does not own an agent loop. The Smithers 1.0 replacement runs
// as the staged coding host, which serves flows over the control RPC rather
// than being exec'd once per task, and no 1.0 CLI verb runs a single dispatched
// task. Until a dispatched task has a 1.0 entrypoint, the surfaces that used to
// exec the 0.x loop refuse with this code instead of running retired code.
const (
	CodeAgentLoopRetired Code = "agent_loop_retired"
)

// Repositories, landings, imports and sharing.
const (
	CodeForkNotNeeded             Code = "fork_not_needed"
	CodeLandingBlocked            Code = "landing_blocked"
	CodeAppendTaskMissing         Code = "append_task_missing"
	CodeAppendNotRequested        Code = "append_not_requested"
	CodeAppendReceiptUnavailable  Code = "append_receipt_unavailable"
	CodeAppendReceiptInvalid      Code = "append_receipt_invalid"
	CodeAppendPrepareUnavailable  Code = "append_prepare_unavailable"
	CodeAppendPrepareInvalid      Code = "append_prepare_invalid"
	CodeLandingCreateUnavailable  Code = "landing_create_unavailable"
	CodeLandingRequestConflict    Code = "landing_request_conflict"
	CodeLandingStackInFlight      Code = "landing_stack_in_flight"
	CodeGitHubImportAlreadyActive Code = "github_import_already_active"
	CodeOrgMembershipRequired     Code = "org_membership_required"
	CodeOutOfCredit               Code = "out_of_credit"
	CodeGitHubImportTooLarge      Code = "github_import_too_large"
	CodeGitHubPullDiffTooLarge    Code = "github_pull_diff_too_large"
	CodeGitHubUnavailable         Code = "github_unavailable"
	CodeListingSecretDetected     Code = "listing_secret_detected"
	CodeWikiUnavailable           Code = "wiki_unavailable"
	CodeWikiSpaceUnreadable       Code = "wiki_space_unreadable"
	CodeSSEUnavailable            Code = "sse_unavailable"
	CodeProfileUnavailable        Code = "profile_unavailable"
	CodeRepositoryHeld            Code = "repository_held"
	CodeRepositoryRollbackHeld    Code = "repository_rollback_held"
	CodePushTooSlow               Code = "push_too_slow"
	CodePushTooLarge              Code = "push_too_large"
	CodeUserRefPushTooLarge       Code = "user_ref_push_too_large"
)

// The shared build cache tier.
//
// Its refusals otherwise reuse the generic codes: a malformed digest is
// bad_request, a publication on a read credential is forbidden, and a tier
// that cannot answer is service_unavailable. Only the admission ceiling needs
// a name of its own, because no generic 429 describes it honestly.
const (
	CodeBuildCacheBusy Code = "build_cache_busy"
)

// Microsandbox control plane: the request was wrong.
const (
	CodeImageRequired           Code = "image_required"
	CodeIdempotencyKeyRequired  Code = "idempotency_key_required"
	CodeIdempotencyConflict     Code = "idempotency_conflict"
	CodeNonReplayableOperation  Code = "non_replayable_operation"
	CodeInvalidJSON             Code = "invalid_json"
	CodeInvalidRequest          Code = "invalid_request"
	CodeInvalidPath             Code = "invalid_path"
	CodeInvalidPlacement        Code = "invalid_placement"
	CodeInvalidResourceLink     Code = "invalid_resource_link"
	CodeInvalidEgressAuditBatch Code = "invalid_egress_audit_batch"
	CodeInvalidWorker           Code = "invalid_worker"
	CodeGenerationRequired      Code = "generation_required"
	CodeGuestUserRequired       Code = "guest_user_required"
	CodeRequestTooLarge         Code = "request_too_large"
	CodeSnapshotTooLarge        Code = "snapshot_too_large"
)

// Microsandbox control plane: the resource is in the wrong state.
const (
	CodeStaleGeneration           Code = "stale_generation"
	CodeOperationInProgress       Code = "operation_in_progress"
	CodeExecInProgress            Code = "exec_in_progress"
	CodeSnapshotInUse             Code = "snapshot_in_use"
	CodeSnapshotNotFound          Code = "snapshot_not_found"
	CodeRetainedRuntimeNotFound   Code = "retained_runtime_not_found"
	CodeRetainedRuntimeNotRunning Code = "retained_runtime_not_running"
	CodeRetainedRuntimeNotStopped Code = "retained_runtime_not_stopped"
	CodeQuiesceFailed             Code = "quiesce_failed"
)

// Microsandbox control plane: identity and authority.
const (
	CodeAccessDenied                Code = "access_denied"
	CodePeerIdentityDenied          Code = "peer_identity_denied"
	CodeWorkerIdentityDenied        Code = "worker_identity_denied"
	CodeWorkerIdentityExpired       Code = "worker_identity_expired"
	CodeWorkerIdentityInvalid       Code = "worker_identity_invalid"
	CodeWorkerIdentityConflict      Code = "worker_identity_conflict"
	CodeWorkerIdentityStale         Code = "worker_identity_stale"
	CodeWorkerRegistrationConflict  Code = "worker_registration_conflict"
	CodeWorkerFenced                Code = "worker_fenced"
	CodeAuthenticationNotConfigured Code = "authentication_not_configured"
)

// Microsandbox control plane: the platform failed.
const (
	CodeWorkerDraining            Code = "worker_draining"
	CodeEgressProxyUnavailable    Code = "egress_proxy_unavailable"
	CodeSecretDeliveryUnavailable Code = "secret_delivery_unavailable"
	CodePreviewUnavailable        Code = "preview_unavailable"
	CodeWorkerError               Code = "worker_error"
	CodeSandboxInternalError      Code = "internal_error"
	CodeSandboxRuntimeError       Code = "runtime_error"
	CodeSandboxControlBusy        Code = "sandbox_control_busy"
	CodeTokenGenerationFailed     Code = "token_generation_failed"
)

// registry is the closed taxonomy. One row per code, no exceptions: a code
// without a row cannot reach the wire with a fault, and a row without a
// constant cannot be raised.
var registry = map[Code]Entry{
	CodeAppendTaskMissing:        {Status: http.StatusNotFound, Fault: FaultUser, Class: ClassUser, Doc: "No append task has been queued for this landing."},
	CodeAppendNotRequested:       {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, Doc: "The landing's existing task is not a native append request."},
	CodeAppendReceiptUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, Doc: "The exact native append receipt cannot currently be verified."},
	CodeAppendReceiptInvalid:     {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, Doc: "The durable append request or task state has no valid matching native receipt."},
	CodeAppendPrepareUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, Doc: "Native append preparation or its transactional revision projection is unavailable."},
	CodePushTooSlow:              {Status: http.StatusRequestTimeout, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The push held its repository longer than the push duration limit and was stopped; nothing changed."},
	CodePushTooLarge:             {Status: http.StatusRequestEntityTooLarge, Fault: FaultUser, Class: ClassUser, Doc: "The push exceeds the repository push size limit."},
	CodeUserRefPushTooLarge:      {Status: http.StatusRequestEntityTooLarge, Fault: FaultUser, Class: ClassUser, Doc: "The push exceeds the user ref push size limit."},
	CodeRepositoryHeld:           {Status: http.StatusServiceUnavailable, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 5, Doc: "The repository refuses writes until maintenance a restarted repository host found running there has finished; reads still work."},
	CodeRepositoryRollbackHeld:   {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, Doc: "The repository refuses writes because a refused push could not be rolled back; the operator restores its refs and removes the hold. Reads still work."},
	CodeAppendPrepareInvalid:     {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, Doc: "Native append preparation did not return the requested exact source identities."},
	CodeLandingCreateUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, Doc: "Idempotent landing creation requires the existing transactional store."},
	CodeLandingRequestConflict:   {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, Doc: "The landing request identity was already used with different input or agent authority."},
	CodeLandingStackInFlight:     {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, Doc: "An in-flight landing request already carries this exact stack onto the target; details.number names it."},
	// The request was malformed or carried a value the endpoint cannot
	// accept.
	CodeBadRequest: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The request was malformed or carried a value the endpoint cannot accept."},
	// The request carried no credential, or one the server could not verify.
	CodeUnknownOrigin:   {Status: http.StatusMisdirectedRequest, Fault: FaultUser, Class: ClassUser, Doc: "The request host matches no configured install origin."},
	CodeOwnerUnverified: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, Doc: "Owner repository access has not been verified."},
	CodeSetupClosed:     {Status: http.StatusUnauthorized, Fault: FaultUser, Class: ClassPermission, Doc: "The owner claim invalidated the setup credential."},
	CodeUnauthenticated: {Status: http.StatusUnauthorized, Fault: FaultUser, Class: ClassPermission, Doc: "The setup credential is missing, expired or invalid."},
	CodeUnauthorized:    {Status: http.StatusUnauthorized, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The request carried no credential, or one the server could not verify."},
	CodeInvalidToken:    {Status: http.StatusUnauthorized, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The presented token has an unrecognized format or is no longer valid."},
	// The credential is valid but is not allowed to perform this operation.
	CodePermission: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, Doc: "Install permission policy refused the operation."},
	CodeForbidden:  {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The credential is valid but is not allowed to perform this operation."},
	// The addressed resource does not exist, or the caller may not see that
	// it does.
	CodeNotFound: {Status: http.StatusNotFound, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The addressed resource does not exist, or the caller may not see that it does."},
	// The resource is in a state that refuses this operation right now.
	CodeSetupRequestReused: {Status: http.StatusConflict, Fault: FaultInfra, Class: ClassConflict, RetryAfter: 0, Doc: "The setup request identity was already admitted with different input."},
	CodeConflict:           {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The resource is in a state that refuses this operation right now."},
	// The request body is larger than the endpoint accepts.
	CodeRequestEntityTooLarge: {Status: http.StatusRequestEntityTooLarge, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The request body is larger than the endpoint accepts."},
	// The request's Content-Type is not one this endpoint reads.
	CodeUnsupportedMediaType: {Status: http.StatusUnsupportedMediaType, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The request's Content-Type is not one this endpoint reads."},
	// The request parsed but its meaning cannot be acted on.
	CodeUnprocessableEntity: {Status: http.StatusUnprocessableEntity, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The request parsed but its meaning cannot be acted on."},
	// One or more fields failed validation; the errors array names each one.
	CodeValidationFailed: {Status: http.StatusUnprocessableEntity, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "One or more fields failed validation; the errors array names each one."},
	// plue failed in a way it does not have a name for. It is a defect, not
	// a condition the caller can fix.
	CodeInternal: {Status: http.StatusInternalServerError, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "plue failed in a way it does not have a name for. It is a defect, not a condition the caller can fix."},
	// The route exists but its implementation does not.
	CodeNotImplemented: {Status: http.StatusNotImplemented, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "The route exists but its implementation does not."},
	// An upstream service plue depends on answered in a way plue could not
	// use.
	CodeBadGateway: {Status: http.StatusBadGateway, Fault: FaultDependency, Class: ClassInfra, RetryAfter: 0, Doc: "An upstream service plue depends on answered in a way plue could not use."},
	// plue is up but a component it needs is not answering.
	CodeServiceUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "plue is up but a component it needs is not answering."},
	// plue gave up waiting for an upstream call it made on the caller's
	// behalf.
	CodeGatewayTimeout: {Status: http.StatusGatewayTimeout, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "plue gave up waiting for an upstream call it made on the caller's behalf."},
	// The account is at a per-resource cap, such as the number of boxes it
	// may keep running.
	CodePlanLimitExceeded:          {Status: http.StatusPaymentRequired, Fault: FaultUser, Class: ClassUser, Doc: "The user has exhausted a limit included in their plan."},
	CodeWorkspaceResourcesExceeded: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "Requested workspace CPU, memory or disk exceeds the configured maximum."},
	CodeQuotaExceeded:              {Status: http.StatusTooManyRequests, Fault: FaultUser, Class: ClassCapacity, RetryAfter: 0, Doc: "The account is at a per-resource cap, such as the number of boxes it may keep running."},
	// The caller sent more requests, or held more live connections, than the
	// endpoint's budget allows.
	CodeRateLimitExceeded: {Status: http.StatusTooManyRequests, Fault: FaultUser, Class: ClassCapacity, RetryAfter: 0, Doc: "The caller sent more requests, or held more live connections, than the endpoint's budget allows."},
	// GitHub rate-limited the call plue made on the caller's behalf.
	CodeGitHubRateLimited: {Status: http.StatusTooManyRequests, Fault: FaultDependency, Class: ClassGitHub, RetryAfter: 0, Doc: "GitHub rate-limited the call plue made on the caller's behalf."},
	// plue's rate-limit store is not answering, and the endpoint fails closed
	// rather than letting a budget go unenforced. The caller is inside its
	// budget; plue simply cannot prove it right now, so the pacing rides in
	// the body as well as the header.
	CodeRateLimiterUnavailable:    {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 1, Doc: "plue's rate-limit store is not answering and the endpoint fails closed rather than let a budget go unenforced."},
	CodeRepositoryCIRunUnverified: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The CI check receipt names a run this repository and workspace retain no usable dispatch for."},
	// The endpoint's storage is not provisioned on this deployment, so the
	// feature is switched off here. Nothing the caller sent is wrong, and no
	// retry helps until the deployment is migrated.
	CodeFeatureNotEnabled: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The endpoint's storage is not provisioned on this deployment, so the feature is switched off here. Retrying does not help until the deployment is migrated."},
	// This deployment has no workspace-gateway health probe configured, so it
	// cannot verify a box's coding gateway and refuses rather than answer for
	// one it has not seen. It is an unset variable on plue's own pod: no box
	// on the deployment can open a coding gateway until an operator sets it,
	// and nothing about any particular box or caller is wrong.
	CodeCodingGatewayNotConfigured: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "This deployment has no workspace-gateway health probe configured, so it cannot verify a box's coding gateway and refuses every bound gateway until an operator configures one."},
	// The GitHub grant is dead in a way no server-side refresh can repair;
	// the person has to re-authorize the GitHub App.
	CodeGitHubReconnectRequired: {Status: http.StatusUnauthorized, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The GitHub grant is dead in a way no server-side refresh can repair; the person has to re-authorize the GitHub App."},
	// The GitHub proxy refuses this action for the caller's grant. Legacy
	// SCREAMING_CASE spelling kept for the clients that already branch on
	// it.
	CodeGitHubForbiddenAction: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The GitHub proxy refuses this action for the caller's grant. Legacy SCREAMING_CASE spelling kept for the clients that already branch on it."},
	// The box is up but its desktop helpers have not finished linking; the
	// same request works seconds later.
	// The box is suspended, failed, or has no VM. Observe and input never
	// auto-resume: the caller asks for a resume first.
	// Another action holds this box's desktop lock. Nothing was injected;
	// retry once the other action returns.
	// The box booted from an image older than the one shipping the desktop
	// helpers. It is terminal for that box.
	//
	// infra, not user: the caller asked a healthy box for something it is
	// entitled to, and the helpers are missing because plue has not rebuilt
	// and re-registered the base image for every closure yet. Opening a new
	// box is a remedy the caller can perform; it is not an admission that they
	// did anything wrong. The status stays 409 because nothing is down — the
	// box's own image is the conflict — and no retry against this box can ever
	// succeed, so it carries no retry window.
	// The framebuffer geometry moved between the observation the plan was
	// aimed at and the injection. Nothing was injected.
	// The focused window is a terminal and the caller did not set
	// allow_terminal, so the keystroke was refused.
	// This act_id already ran on this box; the guest replayed its verdict
	// instead of acting twice.
	// A positioned action fell outside the live framebuffer. Earlier actions
	// in the same plan may already have run.
	// The box has no binary for the session's language. The message is the
	// install line, verbatim.
	CodeLanguageServerMissing: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The box has no binary for the session's language. The message is the install line, verbatim."},
	// A session of one kind was opened on the other kind's stream route.
	CodeWorkspaceSessionKindMismatch: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "A session of one kind was opened on the other kind's stream route."},
	// The session row exists but its box is still provisioning; the same
	// open succeeds once it is running.
	CodeWorkspaceSessionPending: {Status: http.StatusTooEarly, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 2, Doc: "The session row exists but its box is still provisioning; the same open succeeds once it is running."},
	// The controller's lease on a sandbox host has expired, so the host is no
	// longer the controller's to act on. plue lost a machine; the operator's
	// request was fine.
	CodeHostLeaseLost: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The controller's lease on a sandbox host has expired, so the host is no longer the controller's to act on."},
	// No worker in the pool has free CPU, memory or VM slots for the box, at
	// placement or at resume. The box and its disk are untouched.
	CodeNoCapacity: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassCapacity, RetryAfter: 30, Doc: "No worker in the pool has free CPU, memory or VM slots for the box, at placement or at resume. The box and its disk are untouched."},
	// Provisioning a box failed for a reason plue has no specific code for.
	// Persisted on the workspace row as failure_code.
	CodeProvisioningFailed: {Status: http.StatusInternalServerError, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "Provisioning a box failed for a reason plue has no specific code for. Persisted on the workspace row as failure_code."},
	// The guest is reachable but activation has not finished exposing its
	// login shell.
	CodeGuestNotReady: {Status: http.StatusServiceUnavailable, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 3, Doc: "The guest is reachable but activation has not finished exposing its login shell."},
	// Repository provisioning is mid-rollout on this deployment and is not
	// accepting new work.
	CodeRepositoryProvisioningRollout: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "Repository provisioning is mid-rollout on this deployment and is not accepting new work."},
	// No NixOS environment image is registered for this workspace kind on this
	// deployment, so no box of that kind can boot here. The same rollout lag
	// as desktop_tools_unavailable, one step earlier: there the image is old,
	// here it was never registered. Both are plue's to fix, so both are infra
	// at 409 with no retry window. It answered a bare `conflict` (user fault)
	// until 2026-09-14, which blamed the caller for an image nobody built.
	CodeEnvironmentImageUnavailable: {Status: http.StatusConflict, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "No NixOS environment image is registered for this workspace kind on this deployment, so no box of that kind can boot until plue builds and registers one."},
	// The original source is not retained in this box.
	CodeWorkspaceSourceMissing: {Status: http.StatusNotFound, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The original source is not retained in this box."},
	// plue could not verify the box's native source.
	CodeWorkspaceSourceUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "plue could not verify the box's native source."},
	// The box acknowledged a different revision than the one requested.
	CodeWorkspaceSourceInvalidAck: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The box acknowledged a different revision than the one requested."},
	// A change asked to start from a pushed ref the caller does not have.
	CodeUserRefMissing: {Status: http.StatusNotFound, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The pushed ref refs/smithers/users/<id>/<name> does not exist or expired; push it again with `smithers repo push`."},
	// The repository lands through its mythical stack, whose lanes start from the stack tip.
	CodeUserRefStack: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "This repository lands through its mythical stack, so a change cannot start from a pushed ref."},
	// The mutation is saved in the box but its provenance projection has not
	// landed; the identical request finishes it.
	CodeCodingProvenancePending: {Status: http.StatusServiceUnavailable, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 1, Doc: "The mutation is saved in the box but its provenance projection has not landed; the identical request finishes it."},
	// The transport to the box was interrupted before its receipt came back;
	// the identical request recovers it.
	CodeCodingOutcomeUnknown: {Status: http.StatusServiceUnavailable, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 1, Doc: "The transport to the box was interrupted before its receipt came back; the identical request recovers it."},
	// The box's staged coding host or native adapter is older than the one the
	// operation requires, or never registered the coding capability.
	//
	// infra, not user: "configured" here means plue-configured. plue stages
	// the host binary and the adapter into the box from the API pod's own
	// filesystem (addWorkspaceCodingHost) — no repository, owner or caller
	// chooses, pins or edits any of it. A box provisioned before the current
	// artifact shipped refuses a perfectly good request, exactly as
	// desktop_tools_unavailable does, and for exactly the same reason: plue
	// has not re-staged it. The status stays 409 because the box's own
	// provisioned state is the conflict rather than an outage, and it carries
	// no retry window because nothing changes until that box is re-provisioned
	// or replaced.
	CodeCodingHostUnavailable:         {Status: http.StatusConflict, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The box's staged coding host or native adapter is older than the operation requires, or never registered the coding capability. plue stages both, so it is plue's rollout lag rather than anything the caller did."},
	CodeCodingProviderRefreshRequired: {Status: http.StatusConflict, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The box has no usable configured coding model. Connect a provider and resume an idle box or use a fresh box to apply credentials. Existing live work is preserved."},
	CodeCodingFileConflict:            {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "A file preimage, installed file or native snapshot changed during application. Displaced bytes remain in the private recovery directory; no rollback overwrites newer content."},
	CodeCodingFileRecoveryRequired:    {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "File installation was interrupted or could not safely finish. Inspect the retained preimages and proposed files before replanning; details contain the recovery receipt."},
	CodeCodingHostUpgradeRequired:     {Status: http.StatusConflict, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The existing live host lacks the requested capability. Existing runs and streams are preserved; initial setup may select a dedicated compatible workspace, while established bindings remain explicit."},
	CodeWorkspaceSSHUserInvalid:       {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The requested workspace SSH user is not offered; ask for the workspace user or root."},
	CodeWorkspaceVMMissing:            {Status: http.StatusConflict, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The recorded workspace VM no longer exists. Recovery details offer creation of a new workspace from owned snapshot metadata, or fresh creation. Provider restoration must succeed; the old workspace and recovery identifiers remain intact."},
	CodeWorkspaceRebuildRequired:      {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The workspace or snapshot was built while its repository stored a Claude or ChatGPT subscription token, which may remain on its disk. It is not reused; delete it and create a new workspace."},
	CodeRepositoryWorkspacePending:    {Status: http.StatusConflict, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 2, Doc: "The repository workspace or gateway is still starting. Poll the same request; an unverified primary is not an authoritative workspace selection."},
	CodeWorkspaceFailed:               {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The workspace failed to provision and runs nothing; its failure is on the workspace. Create a new workspace."},
	// The guest refused the coding request as malformed.
	CodeCodingInvalidRequest: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The guest refused the coding request as malformed."},
	// The box's jj is too old for the requested operation.
	CodeCodingUnsupportedJJ: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The box's jj is too old for the requested operation."},
	// The guest's coding helper failed. The guest's own sentence is logged
	// server-side, never returned.
	CodeCodingGuestFailure: {Status: http.StatusServiceUnavailable, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "The guest's coding helper failed. The guest's own sentence is logged server-side, never returned."},

	CodeAgentLoopRetired: {Status: http.StatusNotImplemented, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "plue's own 0.x agent loop was retired and the Smithers 1.0 replacement has no entrypoint for a single dispatched task yet. Nothing the caller did."},
	// Another coding operation holds the box's reporter lock.
	CodeCodingWorkspaceBusy: {Status: http.StatusServiceUnavailable, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 1, Doc: "Another coding operation holds the box's reporter lock."},
	// The box's reporter is older than the operation requires; it upgrades
	// on the next boot.
	CodeCodingReporterUpgradeRequired: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The box's reporter is older than the operation requires; it upgrades on the next boot."},
	// Another person or agent holds the branch lock; details carry the
	// holder and whether the caller may ask to join.
	// The caller can already write to this repository, so forking it would
	// only fragment the history. Forks exist to give a reader a namespace they
	// can write in; a writer already has one.
	CodeForkNotNeeded: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The caller already has write access to this repository, so there is nothing to fork: edit it in place."},
	// The landing request cannot proceed as asked; details name what is
	// blocking it.
	CodeLandingBlocked: {Status: http.StatusUnprocessableEntity, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The landing request cannot proceed as asked; details name what is blocking it."},
	// An import for this repository is already running.
	CodeGitHubImportAlreadyActive: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "An import for this repository is already running."},
	// The requested owner is an organization on this deployment and the
	// caller does not belong to it. Imports never silently fall back to the
	// caller's own namespace; join the organization or fork the repository.
	CodeOrgMembershipRequired: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The requested owner is an organization on this deployment and the caller does not belong to it. Join the organization, or fork the repository into your own namespace."},
	// The account's credit cannot cover the next metered model call. Plue's
	// model proxy answers it; the Worker relays it unchanged.
	CodeOutOfCredit: {Status: http.StatusPaymentRequired, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The account's credit balance cannot cover the next model call; upgrade or top up, then retry."},
	// The GitHub repository is larger than plue's import limit. Refused
	// before the mirror clone, so nothing was written.
	CodeGitHubImportTooLarge: {Status: http.StatusRequestEntityTooLarge, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The GitHub repository is larger than plue's import limit. It is refused before the clone, so nothing was written."},
	// GitHub's diff for this pull request is larger than plue will buffer.
	CodeGitHubPullDiffTooLarge: {Status: http.StatusBadGateway, Fault: FaultDependency, Class: ClassGitHub, RetryAfter: 0, Doc: "GitHub's diff for this pull request is larger than plue will buffer."},
	// plue could not complete a call it made to GitHub on the caller's
	// behalf: the request failed, or GitHub answered with something plue
	// could not read. Distinct from github_rate_limited, which is GitHub
	// deliberately refusing, and from bad_gateway, which names no upstream.
	CodeGitHubUnavailable: {Status: http.StatusBadGateway, Fault: FaultDependency, Class: ClassGitHub, RetryAfter: 0, Doc: "plue could not complete a call it made to GitHub on the caller's behalf: the request failed, or GitHub answered with something plue could not read."},
	// The share listing contains something that scans as a credential; it
	// was not published.
	CodeListingSecretDetected: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The share listing contains something that scans as a credential; it was not published."},
	// The wiki's collaboration backend is not answering.
	CodeWikiUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 1, Doc: "The wiki's collaboration backend is not answering."},
	// A readable repository's private wiki needs explicit repository access.
	CodeWikiSpaceUnreadable: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The repository is readable, but its private wiki needs explicit repository access (owner, member or collaborator)."},
	// plue's event-stream tier could not open the stream: the LISTEN backing
	// it failed, or the broker refused the subscription. The stream was never
	// established, so a client loses nothing by reconnecting.
	CodeSSEUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 1, Doc: "plue's event-stream tier could not open the stream: the LISTEN backing it failed, or the broker refused the subscription. The stream was never established."},
	// The signup profile store failed; the client keeps the typed input and
	// retries the same write.
	CodeProfileUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 1, Doc: "The signup profile store could not read or save the caller's account claim and poll answers. Nothing was changed."},
	// The build cache is at its own concurrency ceiling. Not
	// rate_limit_exceeded, which is a user fault: this bound is one process's,
	// shared across every caller, so a client well inside its own budget is
	// refused because other principals hold the slots. That is the same
	// "another request holds it, the identical retry works" shape as
	// desktop_busy and coding_workspace_busy, so it carries their wait fault.
	// The 429 is the build cache protocol's, not a budget verdict: the sibling
	// implementations of this protocol answer 429 for a full admission queue
	// and the clients read that status, so the status is fixed and the fault
	// is what has to be honest. One second is the real pacing — the slots are
	// held by requests in flight, not by a refilling window.
	CodeBuildCacheBusy: {Status: http.StatusTooManyRequests, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 1, Doc: "The build cache is at its own concurrency ceiling; the caller is inside its budget and the identical request works once a slot frees."},
	// The sandbox create request named neither an image nor a snapshot.
	CodeImageRequired: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The sandbox create request named neither an image nor a snapshot."},
	// The operation requires an idempotency key and the request carried
	// none.
	CodeIdempotencyKeyRequired: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The operation requires an idempotency key and the request carried none."},
	// The idempotency key was reused with a different request body.
	CodeIdempotencyConflict: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The idempotency key was reused with a different request body."},
	// The recorded operation for this idempotency key cannot be replayed.
	CodeNonReplayableOperation: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The recorded operation for this idempotency key cannot be replayed."},
	// The sandbox request body is not the JSON the endpoint expects.
	CodeInvalidJSON: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The sandbox request body is not the JSON the endpoint expects."},
	// The sandbox request is missing a required field or carries an
	// impossible combination.
	CodeInvalidRequest: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The sandbox request is missing a required field or carries an impossible combination."},
	// The guest file path is absent, relative, or escapes the sandbox root.
	CodeInvalidPath: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The guest file path is absent, relative, or escapes the sandbox root."},
	// The placement the controller handed the worker does not describe a
	// runnable VM.
	CodeInvalidPlacement: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The placement the controller handed the worker does not describe a runnable VM."},
	// The resource link on the request does not name a resource this
	// controller owns.
	CodeInvalidResourceLink: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The resource link on the request does not name a resource this controller owns."},
	// The egress audit batch is malformed or larger than the controller
	// accepts.
	CodeInvalidEgressAuditBatch: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The egress audit batch is malformed or larger than the controller accepts."},
	// The worker identity on the request is not one the controller knows.
	CodeInvalidWorker: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The worker identity on the request is not one the controller knows."},
	// The worker request omitted the placement generation that fences it.
	CodeGenerationRequired: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The worker request omitted the placement generation that fences it."},
	// The exec request did not name the guest user to run as.
	CodeGuestUserRequired: {Status: http.StatusBadRequest, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The exec request did not name the guest user to run as."},
	// The sandbox request body exceeds the controller's limit.
	CodeRequestTooLarge: {Status: http.StatusRequestEntityTooLarge, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The sandbox request body exceeds the controller's limit."},
	// The snapshot upload exceeds the worker's limit.
	CodeSnapshotTooLarge: {Status: http.StatusRequestEntityTooLarge, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The snapshot upload exceeds the worker's limit."},
	// The request carries an older placement generation than the one the
	// worker holds; another actor moved the VM.
	CodeStaleGeneration: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The request carries an older placement generation than the one the worker holds; another actor moved the VM."},
	// Another operation on this sandbox is still running; the same request
	// works once it settles.
	CodeOperationInProgress: {Status: http.StatusConflict, Fault: FaultWait, Class: ClassCapacity, RetryAfter: 1, Doc: "Another operation on this sandbox is still running; the same request works once it settles."},
	// An exec is already running in this sandbox and the endpoint serializes
	// them.
	CodeExecInProgress: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassCapacity, RetryAfter: 0, Doc: "An exec is already running in this sandbox and the endpoint serializes them."},
	// The snapshot backs a live sandbox and cannot be changed or deleted.
	CodeSnapshotInUse: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The snapshot backs a live sandbox and cannot be changed or deleted."},
	// The named sandbox snapshot does not exist. Distinct from not_found so
	// a bad golden snapshot is diagnosable.
	CodeSnapshotNotFound: {Status: http.StatusNotFound, Fault: FaultUser, Class: ClassUser, RetryAfter: 0, Doc: "The named sandbox snapshot does not exist. Distinct from not_found so a bad golden snapshot is diagnosable."},
	// The worker holds no retained runtime under that id.
	CodeRetainedRuntimeNotFound: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The worker holds no retained runtime under that id."},
	// The retained runtime exists but is not running, and the operation
	// needs it running.
	CodeRetainedRuntimeNotRunning: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The retained runtime exists but is not running, and the operation needs it running."},
	// The retained runtime is still running, and the operation needs it
	// stopped.
	CodeRetainedRuntimeNotStopped: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The retained runtime is still running, and the operation needs it stopped."},
	// The worker could not quiesce the guest in time to take the action;
	// retrying usually succeeds.
	CodeQuiesceFailed: {Status: http.StatusConflict, Fault: FaultWait, Class: ClassConflict, RetryAfter: 1, Doc: "The worker could not quiesce the guest in time to take the action; retrying usually succeeds."},
	// The access grant presented to the controller does not cover this
	// sandbox.
	CodeAccessDenied: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The access grant presented to the controller does not cover this sandbox."},
	// The calling peer's mTLS identity is not one this worker accepts.
	CodePeerIdentityDenied: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The calling peer's mTLS identity is not one this worker accepts."},
	// The worker's identity key is not the one the controller registered.
	CodeWorkerIdentityDenied: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The worker's identity key is not the one the controller registered."},
	// The worker's identity assertion is past its validity window.
	CodeWorkerIdentityExpired: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The worker's identity assertion is past its validity window."},
	// The worker heartbeat's identity key is malformed.
	CodeWorkerIdentityInvalid: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The worker heartbeat's identity key is malformed."},
	// Two workers claim the same id with different identity keys.
	CodeWorkerIdentityConflict: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "Two workers claim the same id with different identity keys."},
	// The worker heartbeat's identity was superseded by a newer
	// registration.
	CodeWorkerIdentityStale: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The worker heartbeat's identity was superseded by a newer registration."},
	// The worker's registration conflicts with a live one under the same id.
	CodeWorkerRegistrationConflict: {Status: http.StatusForbidden, Fault: FaultUser, Class: ClassPermission, RetryAfter: 0, Doc: "The worker's registration conflicts with a live one under the same id."},
	// The request targets a different worker than the one holding the
	// placement, or the worker lost its controller authorization.
	CodeWorkerFenced: {Status: http.StatusConflict, Fault: FaultUser, Class: ClassConflict, RetryAfter: 0, Doc: "The request targets a different worker than the one holding the placement, or the worker lost its controller authorization."},
	// The controller has no authentication material configured, so it
	// refuses every authenticated call.
	CodeAuthenticationNotConfigured: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The controller has no authentication material configured, so it refuses every authenticated call."},
	// The worker is draining and takes no new placements.
	CodeWorkerDraining: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The worker is draining and takes no new placements."},
	// The box's egress proxy is not answering, so the box would have had no
	// outbound network.
	CodeEgressProxyUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The box's egress proxy is not answering, so the box would have had no outbound network."},
	// This worker build cannot deliver secrets into a guest.
	CodeSecretDeliveryUnavailable: {Status: http.StatusNotImplemented, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "This worker build cannot deliver secrets into a guest."},
	// The preview gateway could not reach the port the box is serving.
	CodePreviewUnavailable: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The preview gateway could not reach the port the box is serving."},
	// A Microsandbox worker failed an operation and the controller has no
	// more specific code for it.
	CodeWorkerError: {Status: http.StatusBadGateway, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "A Microsandbox worker failed an operation and the controller has no more specific code for it."},
	// A sandbox control operation failed in a way the controller does not
	// have a name for.
	CodeSandboxInternalError: {Status: http.StatusInternalServerError, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "A sandbox control operation failed in a way the controller does not have a name for."},
	// The worker's runtime driver failed: a VMM, a snapshot restore, or a
	// guest transport on one machine. That is plue's platform breaking under
	// the caller, not a defect in plue's code, so it is infra — the caller may
	// well succeed on another worker.
	CodeSandboxRuntimeError: {Status: http.StatusInternalServerError, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 0, Doc: "The worker's runtime driver failed: a VMM, a snapshot restore, or a guest transport on one machine. Another worker may well succeed."},
	// A control-plane transaction kept losing a race with a concurrent writer.
	// Nothing changed, and the identical request works once the contention clears.
	CodeSandboxControlBusy: {Status: http.StatusServiceUnavailable, Fault: FaultInfra, Class: ClassInfra, RetryAfter: 2, Doc: "A control-plane transaction kept losing a race with a concurrent writer. Nothing changed, and the identical request works once the contention clears."},
	// The controller could not mint the token the operation needs.
	CodeTokenGenerationFailed: {Status: http.StatusInternalServerError, Fault: FaultBug, Class: ClassInfra, RetryAfter: 0, Doc: "The controller could not mint the token the operation needs."},
}

// Lookup returns the registry row for a code.
func Lookup(code Code) (Entry, bool) {
	entry, ok := registry[code]
	return entry, ok
}

// Codes returns every registered code, sorted. The order is stable so the
// generated artifact is byte-reproducible.
func Codes() []Code {
	codes := make([]Code, 0, len(registry))
	for code := range registry {
		codes = append(codes, code)
	}
	sort.Slice(codes, func(i, j int) bool { return codes[i] < codes[j] })
	return codes
}

// ParseCode is the ONE reviewed ingress for a code that arrived as a string
// from another process: the Microsandbox controller's error envelope, a
// worker's body, or a failure_code column written by an older build. Every
// other conversion from string to Code is a bug.
//
// An unrecognized string is NOT passed through. It reports (CodeInternal,
// false) so a caller that ignores the boolean still produces a registered
// code and the wire stays total: plue does not know what happened, which is
// plue's defect, not the caller's.
func ParseCode(s string) (Code, bool) {
	code := Code(strings.TrimSpace(s))
	if _, ok := registry[code]; ok {
		return code, true
	}
	return CodeInternal, false
}

// New builds an APIError from its code. The registry supplies the status, the
// fault and the retry pacing, so two call sites raising the same code can
// never disagree about what the client sees.
//
// An unregistered code (only reachable by conversion, which the registry test
// and review forbid) degrades to a 500 bug rather than a 200 or a zero status.
func New(code Code, msg string) *APIError {
	entry, ok := Lookup(code)
	if !ok {
		entry = Entry{Status: http.StatusInternalServerError, Fault: FaultBug}
	}
	return &APIError{
		Class:      entry.Class,
		Status:     entry.Status,
		Code:       code,
		Fault:      entry.Fault,
		Message:    msg,
		RetryAfter: entry.RetryAfter,
	}
}

// statusFallbackCode names the code for a response built as a bare APIError
// composite with no Code. Those call sites are swept over time; until then
// this keeps `code` and `fault` present on every response instead of
// serializing an empty string.
func statusFallbackCode(status int) Code {
	switch status {
	case http.StatusBadRequest:
		return CodeBadRequest
	case http.StatusUnauthorized:
		return CodeUnauthorized
	case http.StatusForbidden:
		return CodeForbidden
	case http.StatusNotFound:
		return CodeNotFound
	case http.StatusConflict:
		return CodeConflict
	case http.StatusRequestEntityTooLarge:
		return CodeRequestEntityTooLarge
	case http.StatusUnsupportedMediaType:
		return CodeUnsupportedMediaType
	case http.StatusUnprocessableEntity:
		return CodeUnprocessableEntity
	case http.StatusTooEarly:
		return CodeWorkspaceSessionPending
	case http.StatusTooManyRequests:
		return CodeRateLimitExceeded
	case http.StatusNotImplemented:
		return CodeNotImplemented
	case http.StatusBadGateway:
		return CodeBadGateway
	case http.StatusServiceUnavailable:
		return CodeServiceUnavailable
	case http.StatusGatewayTimeout:
		return CodeGatewayTimeout
	}
	if status >= 400 && status < 500 {
		return CodeBadRequest
	}
	return CodeInternal
}

// DocumentSchemaVersion is bumped when the SHAPE of docs/failure-codes.json
// changes, never when a code is added or removed. Consumers pin it.
const DocumentSchemaVersion = 1

// Document is the generated cross-repo artifact: the whole registry, sorted,
// with a digest other repositories compare against a running deployment.
type Document struct {
	SchemaVersion int          `json:"schema_version"`
	Digest        string       `json:"digest"`
	Faults        []Fault      `json:"faults"`
	Codes         []CodeRecord `json:"codes"`
}

// CodeRecord is one row of Document.Codes.
type CodeRecord struct {
	Code       Code   `json:"code"`
	Fault      Fault  `json:"fault"`
	Status     int    `json:"status"`
	RetryAfter int    `json:"retry_after"`
	Doc        string `json:"doc"`
}

// Export renders the registry as the artifact other repositories consume. The
// digest covers Codes only, so it changes when and only when the taxonomy
// does.
func Export() Document {
	codes := Codes()
	records := make([]CodeRecord, 0, len(codes))
	for _, code := range codes {
		entry := registry[code]
		records = append(records, CodeRecord{
			Code:       code,
			Fault:      entry.Fault,
			Status:     entry.Status,
			RetryAfter: entry.RetryAfter,
			Doc:        entry.Doc,
		})
	}
	payload, err := json.Marshal(records)
	if err != nil {
		// CodeRecord is a flat struct of strings and ints; Marshal cannot fail.
		panic("errors: marshal failure-code records: " + err.Error())
	}
	sum := sha256.Sum256(payload)
	return Document{
		SchemaVersion: DocumentSchemaVersion,
		Digest:        "sha256:" + hex.EncodeToString(sum[:]),
		Faults:        Faults,
		Codes:         records,
	}
}

// MarshalDocument renders Export() exactly as docs/failure-codes.json holds
// it. cmd/failurecodes writes these bytes, the served route hands them out,
// and TestFailureCodesJSONIsFresh compares them to the checked-in file, so
// there is one formatter and no drift between the three.
func MarshalDocument() ([]byte, error) {
	payload, err := json.MarshalIndent(Export(), "", "  ")
	if err != nil {
		return nil, err
	}
	return append(payload, '\n'), nil
}
