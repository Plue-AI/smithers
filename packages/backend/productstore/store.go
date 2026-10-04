// Package productstore supplies the canonical product operations consumed by
// optional runtime adapters. It never opens connections or duplicates SQL.
package productstore

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type DBTX = db.DBTX

// Product includes the optional capabilities used by workspace and workflow
// services as well as their base interfaces, so wrapping it cannot erase them.
// A service skips a feature when its ports.RuntimeStores store lacks the
// capability it type-asserts, so every product capability asserted on those
// stores belongs here; TestRuntimeStoreAssertionsAreClassified in
// internal/services enforces this (smithers#3390).
type Product interface {
	SetWorkspaceClientLease(ctx context.Context, arg db.SetWorkspaceClientLeaseParams) (db.Workspace, error)
	RenewWorkspaceClientLease(ctx context.Context, id string) (db.Workspace, error)
	ListLapsedLeaseWorkspaces(ctx context.Context, maxRows int32) ([]db.Workspace, error)
	SwapWorkspaceHeadPushTokenID(ctx context.Context, id string, userID int64, expected, next pgtype.Int8) (bool, error)
	ListAccessTokensByUserID(ctx context.Context, userID int64) ([]db.AccessToken, error)
	SealOutsiderWorkspaceEgress(ctx context.Context, workspaceID string) error
	StampAgentSessionRevisionsWorkspaceSnapshot(ctx context.Context, arg db.StampAgentSessionRevisionsWorkspaceSnapshotParams) (int64, error)
	ListNeverStartedAgentSessions(ctx context.Context, cutoff time.Time) ([]db.AgentSession, error)
	FailNeverStartedAgentSession(ctx context.Context, arg db.FailNeverStartedAgentSessionParams) (db.AgentSession, error)
	UpdateWorkflowRunCheckRun(ctx context.Context, arg db.UpdateWorkflowRunCheckRunParams) (db.WorkflowRun, error)
	MarkWorkflowRunSuperseded(ctx context.Context, arg db.MarkWorkflowRunSupersededParams) error
	ListSupersededWorkflowRuns(ctx context.Context, arg db.ListSupersededWorkflowRunsParams) ([]int64, error)
	AttachWorkflowArtifactToRelease(ctx context.Context, arg db.AttachWorkflowArtifactToReleaseParams) (db.WorkflowArtifact, error)
	AuthorizePublicWorkspaceService(ctx context.Context, arg db.AuthorizePublicWorkspaceServiceParams) (bool, error)
	CancelWorkflowRun(ctx context.Context, id int64) error
	CancelWorkflowTasks(ctx context.Context, workflowRunID int64) error
	ClaimAgentSessionForDispatch(ctx context.Context, sessionID string, workflowRunID int64) (bool, error)
	ClaimWorkflowArtifactDeletion(ctx context.Context, arg db.ClaimWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error)
	ClaimWorkflowCacheDeletion(ctx context.Context, arg db.ClaimWorkflowCacheDeletionParams) (db.WorkflowCach, error)
	ClearWorkflowRunJJHubTokenID(ctx context.Context, id int64) error
	CloseOrphanedSandboxUsageIntervals(ctx context.Context) error
	CloseSandboxUsageInterval(ctx context.Context, arg db.CloseSandboxUsageIntervalParams) error
	ConfirmWorkflowArtifactUpload(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error)
	CompletePendingWorkspaceSessions(ctx context.Context, workspaceID string) ([]string, error)
	CountActiveSessionsForWorkspace(ctx context.Context, workspaceID string) (int64, error)
	CountActiveWorkspacesByUser(ctx context.Context, userID int64) (int64, error)
	CountLFSObjects(ctx context.Context, repositoryID int64) (int64, error)
	CountUserWorkspacesAcrossRepos(ctx context.Context, userID int64) (int64, error)
	CountWorkspaceSessionsByRepo(ctx context.Context, arg db.CountWorkspaceSessionsByRepoParams) (int64, error)
	CountWorkspaceSnapshotsByRepo(ctx context.Context, arg db.CountWorkspaceSnapshotsByRepoParams) (int64, error)
	CountWorkspacesByRepo(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error)
	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	CreateCommitStatus(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error)
	CreateLFSObject(ctx context.Context, arg db.CreateLFSObjectParams) (db.LfsObject, error)
	CreateWorkflowArtifact(ctx context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error)
	CreateWorkflowRun(ctx context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error)
	CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	CreateWorkflowTask(ctx context.Context, arg db.CreateWorkflowTaskParams) (db.WorkflowTask, error)
	CreateWorkspace(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error)
	CreateWorkspaceLSPSession(ctx context.Context, arg db.CreateWorkspaceLSPSessionParams) (db.WorkspaceSession, error)
	CreateWorkspaceSession(ctx context.Context, arg db.CreateWorkspaceSessionParams) (db.WorkspaceSession, error)
	CreateWorkspaceSnapshot(ctx context.Context, arg db.CreateWorkspaceSnapshotParams) (db.WorkspaceSnapshot, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
	DeleteClaimedWorkflowArtifact(ctx context.Context, arg db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error)
	DeleteClaimedWorkflowCache(ctx context.Context, arg db.DeleteClaimedWorkflowCacheParams) (db.WorkflowCach, error)
	DeleteExpiredLFSUploadReservation(ctx context.Context, arg db.DeleteExpiredLFSUploadReservationParams) (int64, error)
	DeleteLFSObject(ctx context.Context, arg db.DeleteLFSObjectParams) (int64, error)
	DeleteLFSUploadReservation(ctx context.Context, arg db.DeleteLFSUploadReservationParams) error
	DeleteSystemAccessTokensByName(ctx context.Context, arg db.DeleteSystemAccessTokensByNameParams) error
	DeleteUnissuedLFSUploadReservation(ctx context.Context, arg db.DeleteUnissuedLFSUploadReservationParams) (int64, error)
	DeleteWorkspaceSnapshot(ctx context.Context, id string) error
	EnsureWorkflowDefinitionReference(ctx context.Context, arg db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error)
	FailActiveWorkspaceSession(ctx context.Context, id string) (db.WorkspaceSession, error)
	FailProvisioningWorkspaceIfCurrent(ctx context.Context, arg db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error)
	FailStaleStartingWorkspace(ctx context.Context, arg db.FailStaleStartingWorkspaceParams) (db.Workspace, error)
	FailWorkflowRun(ctx context.Context, id int64) error
	FailWorkspaceIfUnchanged(ctx context.Context, arg db.FailWorkspaceIfUnchangedParams) (db.Workspace, error)
	FinalizeWorkflowCache(ctx context.Context, arg db.FinalizeWorkflowCacheParams) (db.WorkflowCach, error)
	FindWorkflowCacheForRestore(ctx context.Context, arg db.FindWorkflowCacheForRestoreParams) (db.WorkflowCach, error)
	GetActiveWorkspaceForUserRepo(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error)
	GetActiveWorkspaceForUserRepoKind(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error)
	GetActiveWorkspaceForIdentity(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error)
	GetActiveWorkspaceLSPSession(ctx context.Context, arg db.GetActiveWorkspaceLSPSessionParams) (db.WorkspaceSession, error)
	GetAgentSessionForFlowProjection(ctx context.Context, arg db.GetAgentSessionForFlowProjectionParams) (db.AgentSession, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetLFSObjectByOID(ctx context.Context, arg db.GetLFSObjectByOIDParams) (db.LfsObject, error)
	GetLFSUploadReservation(ctx context.Context, arg db.GetLFSUploadReservationParams) (db.LfsUploadReservation, error)
	GetMythicalStack(ctx context.Context, repositoryID int64) (db.MythicalStack, error)
	GetMythicalLane(ctx context.Context, workspaceID string) (db.MythicalLane, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	GetOrgCredentialOwnerID(ctx context.Context, organizationID int64) (int64, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetRepoOwnerSlugAndNameByID(ctx context.Context, repositoryID int64) (db.GetRepoOwnerSlugAndNameByIDRow, error)
	GetRepositoryCloneDepth(ctx context.Context, id int64) (int32, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetWorkflowArtifactByName(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error)
	GetWorkflowCacheByID(ctx context.Context, id int64) (db.WorkflowCach, error)
	GetWorkflowCacheByScopeVersion(ctx context.Context, arg db.GetWorkflowCacheByScopeVersionParams) (db.WorkflowCach, error)
	GetWorkflowCacheRepoUsage(ctx context.Context, repositoryID int64) (int64, error)
	GetWorkflowCacheStats(ctx context.Context, repositoryID int64) (db.GetWorkflowCacheStatsRow, error)
	GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	GetWorkflowDefinitionNameByRunID(ctx context.Context, id int64) (string, error)
	GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	GetWorkflowRunByRunID(ctx context.Context, id int64) (db.WorkflowRun, error)
	GetWorkflowRunCodingHost(ctx context.Context, workflowRunID int64) (db.WorkflowRunCodingHost, error)
	GetWorkflowRunJJHubTokenID(ctx context.Context, id int64) (pgtype.Int8, error)
	GetWorkflowTask(ctx context.Context, arg db.GetWorkflowTaskParams) (db.WorkflowTask, error)
	GetWorkflowTaskByRunID(ctx context.Context, workflowRunID int64) (db.WorkflowTask, error)
	GetWorkspace(ctx context.Context, id string) (db.Workspace, error)
	GetWorkspaceByRepo(ctx context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error)
	GetWorkspaceForUserRepo(ctx context.Context, arg db.GetWorkspaceForUserRepoParams) (db.Workspace, error)
	GetWorkspaceIncludingDeleted(ctx context.Context, id string) (db.Workspace, error)
	GetWorkspaceSession(ctx context.Context, id string) (db.WorkspaceSession, error)
	GetWorkspaceSessionByRepo(ctx context.Context, arg db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error)
	GetWorkspaceSessionForUserRepo(ctx context.Context, arg db.GetWorkspaceSessionForUserRepoParams) (db.WorkspaceSession, error)
	GetWorkspaceShare(ctx context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error)
	GetWorkspaceSnapshot(ctx context.Context, id string) (db.WorkspaceSnapshot, error)
	GetWorkspaceSnapshotByRepo(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error)
	GetWorkspaceSnapshotForUserRepo(ctx context.Context, arg db.GetWorkspaceSnapshotForUserRepoParams) (db.WorkspaceSnapshot, error)
	HasWritableWorkspaceShares(ctx context.Context, workspaceID string) (bool, error)
	InsertAuditLog(ctx context.Context, arg db.InsertAuditLogParams) error
	InsertWorkflowRunLogNextSequence(ctx context.Context, arg db.InsertWorkflowRunLogNextSequenceParams) (db.InsertWorkflowRunLogNextSequenceRow, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	IsOutsiderWorkspace(ctx context.Context, workspaceID string) (bool, error)
	IsOutsiderWorkspaceEgressSealed(ctx context.Context, workspaceID string) (bool, error)
	ListExpiredLFSUploadReservationsByOwner(ctx context.Context, repositoryID int64) ([]db.LfsUploadReservation, error)
	ListIdleWorkspaceSessions(ctx context.Context) ([]db.WorkspaceSession, error)
	ListIdleWorkspaces(ctx context.Context) ([]db.Workspace, error)
	ListLFSObjects(ctx context.Context, arg db.ListLFSObjectsParams) ([]db.LfsObject, error)
	ListPrunableWorkflowArtifacts(ctx context.Context, arg db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error)
	ListRepositoryGitHubSources(ctx context.Context, id int64) ([]db.ListRepositoryGitHubSourcesRow, error)
	ListRunningWorkspaces(ctx context.Context) ([]db.Workspace, error)
	ListRunningWorkspacesForUserRepoBookmark(ctx context.Context, arg db.ListRunningWorkspacesForUserRepoBookmarkParams) ([]db.Workspace, error)
	ListStaleActiveSessions(ctx context.Context, startedAt pgtype.Timestamptz) ([]db.AgentSession, error)
	ListStalePendingWorkspaces(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error)
	ListStaleStartingWorkspacesWithVM(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error)
	ListTaskStepInfoForRun(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error)
	ListUserWorkspacesAcrossRepos(ctx context.Context, arg db.ListUserWorkspacesAcrossReposParams) ([]db.ListUserWorkspacesAcrossReposRow, error)
	ListWorkflowArtifactsByRun(ctx context.Context, workflowRunID int64) ([]db.WorkflowArtifact, error)
	ListWorkflowCacheEvictionCandidates(ctx context.Context, arg db.ListWorkflowCacheEvictionCandidatesParams) ([]db.WorkflowCach, error)
	ListWorkflowCacheRepositoryIDs(ctx context.Context) ([]int64, error)
	ListWorkflowCaches(ctx context.Context, arg db.ListWorkflowCachesParams) ([]db.WorkflowCach, error)
	ListWorkflowCachesForClear(ctx context.Context, arg db.ListWorkflowCachesForClearParams) ([]db.WorkflowCach, error)
	ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	ListWorkflowLogsSince(ctx context.Context, arg db.ListWorkflowLogsSinceParams) ([]db.WorkflowLog, error)
	ListWorkflowStepsByRunID(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	ListWorkspaceProvisioningRecovery(ctx context.Context) ([]db.ListWorkspaceProvisioningRecoveryRow, error)
	ListWorkspaceSessionsByRepo(ctx context.Context, arg db.ListWorkspaceSessionsByRepoParams) ([]db.WorkspaceSession, error)
	ListWorkspaceSnapshotsByRepo(ctx context.Context, arg db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error)
	ListWorkspacesByRepo(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error)
	MarkWorkflowTaskTerminalByID(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error)
	MarkWorkflowTaskVMRunning(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error)
	MarkOutsiderWorkspace(ctx context.Context, repositoryID int64, workspaceID string) error
	MarkWorkspaceResumed(ctx context.Context, arg db.MarkWorkspaceResumedParams) error
	MarkWorkspaceSessionRunning(ctx context.Context, id string) (db.WorkspaceSession, error)
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error
	NotifyWorkflowRunLog(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error
	NotifyWorkspaceStatus(ctx context.Context, arg db.NotifyWorkspaceStatusParams) error
	OpenSandboxUsageInterval(ctx context.Context, arg db.OpenSandboxUsageIntervalParams) error
	RecordWorkflowRunCodingHost(ctx context.Context, arg db.RecordWorkflowRunCodingHostParams) (db.WorkflowRunCodingHost, error)
	RecordWorkspaceCodingOperation(ctx context.Context, arg db.RecordWorkspaceCodingOperationParams) (db.JjOperation, error)
	RegisterWorkspaceVM(ctx context.Context, arg db.RegisterWorkspaceVMParams) (db.Workspace, error)
	ReleaseWorkflowArtifactDeletionClaim(ctx context.Context, arg db.ReleaseWorkflowArtifactDeletionClaimParams) error
	ReleaseWorkflowCacheDeletionClaim(ctx context.Context, arg db.ReleaseWorkflowCacheDeletionClaimParams) error
	ResetWorkspaceForReprovision(ctx context.Context, id string) (db.Workspace, error)
	ResumeWorkflowRun(ctx context.Context, id int64) error
	ResumeWorkflowSteps(ctx context.Context, workflowRunID int64) error
	ResumeWorkflowTasks(ctx context.Context, workflowRunID int64) error
	ResumeWorkspaceToRunning(ctx context.Context, id string) (db.Workspace, error)
	RetryWorkflowArtifactDeletion(ctx context.Context, arg db.RetryWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error)
	RetryWorkflowCacheDeletion(ctx context.Context, arg db.RetryWorkflowCacheDeletionParams) (db.WorkflowCach, error)
	RevokeWorkflowRunGuestTokens(ctx context.Context, workflowRunID int64) error
	SetAgentSessionWorkspace(ctx context.Context, arg db.SetAgentSessionWorkspaceParams) error
	SetWorkspaceEnvironmentImage(ctx context.Context, arg db.SetWorkspaceEnvironmentImageParams) error
	SetWorkspaceHeadPushTokenID(ctx context.Context, arg db.SetWorkspaceHeadPushTokenIDParams) error
	SetWorkspaceIdleTimeout(ctx context.Context, arg db.SetWorkspaceIdleTimeoutParams) (db.Workspace, error)
	SetWorkspaceServicePublic(ctx context.Context, arg db.SetWorkspaceServicePublicParams) error
	SkipBlockedWorkflowTask(ctx context.Context, id int64) error
	SoftDeleteWorkspace(ctx context.Context, id string) (db.Workspace, error)
	StopWorkspaceRetainingRow(ctx context.Context, id string) (db.StopWorkspaceRetainingRowRow, error)
	SuspendRunningWorkspace(ctx context.Context, id string) (db.Workspace, error)
	SuspendRunningWorkspaceIfSessionless(ctx context.Context, id string) (db.Workspace, error)
	TouchWorkflowCacheHit(ctx context.Context, id int64) error
	TouchWorkspaceActivity(ctx context.Context, id string) error
	TouchWorkspaceLastAccessed(ctx context.Context, id string) error
	TouchWorkspaceSessionActivity(ctx context.Context, id string) error
	UnblockWorkflowTask(ctx context.Context, id int64) error
	UpdateAgentSessionStartedAt(ctx context.Context, arg db.UpdateAgentSessionStartedAtParams) (db.AgentSession, error)
	UpdateAgentSessionStatus(ctx context.Context, arg db.UpdateAgentSessionStatusParams) (db.AgentSession, error)
	UpdateAgentSessionTerminalStatus(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error)
	UpdateAgentSessionTerminalStatusForFlow(ctx context.Context, arg db.UpdateAgentSessionTerminalStatusForFlowParams) (db.AgentSession, error)
	UpdateAgentSessionTimedOut(ctx context.Context, arg db.UpdateAgentSessionTimedOutParams) (db.AgentSession, error)
	UpdateWorkflowRunAgentToken(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error)
	UpdateWorkflowRunJJHubTokenID(ctx context.Context, arg db.UpdateWorkflowRunJJHubTokenIDParams) error
	UpdateWorkflowRunStatusBasedOnTasks(ctx context.Context, workflowRunID int64) (string, error)
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)
	UpdateWorkspaceExecutionInfo(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error)
	UpdateWorkspaceHead(ctx context.Context, arg db.UpdateWorkspaceHeadParams) (db.Workspace, error)
	UpdateWorkspaceProvisioningStage(ctx context.Context, arg db.UpdateWorkspaceProvisioningStageParams) (db.Workspace, error)
	UpdateWorkspaceSessionSSHConnectionInfo(ctx context.Context, arg db.UpdateWorkspaceSessionSSHConnectionInfoParams) (db.WorkspaceSession, error)
	UpdateWorkspaceSessionStatus(ctx context.Context, arg db.UpdateWorkspaceSessionStatusParams) (db.WorkspaceSession, error)
	UpdateWorkspaceStatus(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error)
	UpdateWorkspaceTargetBookmark(ctx context.Context, arg db.UpdateWorkspaceTargetBookmarkParams) (db.Workspace, error)
	UpsertAgentWorkflowDefinition(ctx context.Context, repositoryID int64) (db.WorkflowDefinition, error)
	UpsertLFSUploadReservation(ctx context.Context, arg db.UpsertLFSUploadReservationParams) (db.LfsUploadReservation, error)
	UpsertPendingWorkflowCache(ctx context.Context, arg db.UpsertPendingWorkflowCacheParams) (db.WorkflowCach, error)
	WorkspaceServicePublic(ctx context.Context, arg db.WorkspaceServicePublicParams) (bool, error)
}

// New binds the product queries to the caller's exact connection or transaction.
func New(conn DBTX) Product { return db.New(conn) }
