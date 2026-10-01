package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// WorkspaceRecoveryDetails names existing public create actions, never a
// mutation of the missing workspace. SnapshotID is an owned metadata candidate;
// only the provider's create result establishes whether its disk still exists.
type WorkspaceRecoveryDetails struct {
	WorkspaceID string `json:"workspace_id"`
	SnapshotID  string `json:"snapshot_id,omitempty"`
	CreateFresh bool   `json:"create_fresh"`
}

func (s *WorkspaceService) missingWorkspaceVM(ctx context.Context, workspace db.Workspace, requesterID int64) *pkgerrors.APIError {
	details := WorkspaceRecoveryDetails{WorkspaceID: workspace.ID, CreateFresh: true}
	eligible := func(snapshot db.WorkspaceSnapshot) bool {
		return snapshot.UserID == requesterID && snapshot.RepositoryID == workspace.RepositoryID &&
			strings.TrimSpace(snapshot.ID) != "" && strings.TrimSpace(snapshot.SnapshotID) != "" && !snapshot.RebuildRequiredAt.Valid
	}
	// Enumerate the existing owner-scoped listing in its newest-first order. Its
	// count bounds pagination; a failed read is unknown recovery availability.
	count, err := s.q.CountWorkspaceSnapshotsByRepo(ctx, db.CountWorkspaceSnapshotsByRepoParams{RepositoryID: workspace.RepositoryID, UserID: requesterID})
	if err == nil {
		for offset := int64(0); offset < count; offset += 100 {
			rows, err := s.q.ListWorkspaceSnapshotsByRepo(ctx, db.ListWorkspaceSnapshotsByRepoParams{RepositoryID: workspace.RepositoryID, UserID: requesterID, PageOffset: ClampInt32(int(offset)), PageSize: 100})
			if err != nil || len(rows) == 0 {
				break
			}
			for _, snapshot := range rows {
				if snapshot.WorkspaceID == workspace.ID && eligible(snapshot) {
					details.SnapshotID = snapshot.ID
					break
				}
			}
			if details.SnapshotID != "" {
				break
			}
		}
	}
	if details.SnapshotID == "" && workspace.SourceSnapshotID.Valid {
		snapshot, err := s.q.GetWorkspaceSnapshotForUserRepo(ctx, db.GetWorkspaceSnapshotForUserRepoParams{ID: UUIDString(workspace.SourceSnapshotID), RepositoryID: workspace.RepositoryID, UserID: requesterID})
		if err == nil && snapshot.ID == UUIDString(workspace.SourceSnapshotID) && eligible(snapshot) {
			details.SnapshotID = snapshot.ID
		}
	}
	message := "workspace VM no longer exists; run `smithers workspace create` to provision a fresh workspace"
	if details.SnapshotID != "" {
		message = fmt.Sprintf("workspace VM no longer exists; recreate with `smithers workspace create --snapshot %s`, or create a fresh workspace", details.SnapshotID)
	}
	failure := pkgerrors.New(pkgerrors.CodeWorkspaceVMMissing, message)
	failure.Details = details
	return failure
}

func unavailableWorkspaceSnapshot(workspace db.Workspace, cause error) *pkgerrors.APIError {
	failure := pkgerrors.New(pkgerrors.CodeSnapshotNotFound, "workspace snapshot is unavailable; run `smithers workspace create` to provision a fresh workspace").WithCause(cause)
	failure.Details = WorkspaceRecoveryDetails{WorkspaceID: workspace.ID, CreateFresh: true}
	return failure
}
