package services

import (
	"context"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// installRuntimeBoxCodingBinding prepares source publication before any host
// credential is minted. Its runtime interface permits one fixed root-owned
// file, without giving repository code privileged command execution.
func (s *WorkspaceService) installRuntimeBoxCodingBinding(ctx context.Context, row db.Workspace) error {
	installer, ok := s.runtime.(workspaceapi.WorkspaceCodingBindingInstaller)
	if !ok || !s.runtime.Capabilities().ManagedServices {
		return pkgerrors.Conflict("workspace coding source binding provisioning is unavailable")
	}
	if _, ok := s.q.(workspaceHeadSwapStore); !ok {
		return pkgerrors.Conflict("workspace source publisher store is unavailable")
	}
	slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
	if err != nil {
		return err
	}
	base := strings.TrimRight(strings.TrimSpace(s.gitBaseURL), "/")
	gitURL, err := workspaceRepoGitURL(base, slug)
	if err != nil {
		return pkgerrors.Internal("build workspace coding Git URL").WithCause(err)
	}
	binding := workspaceapi.WorkspaceCodingBinding{ActorID: row.UserID, RepositoryID: row.RepositoryID, RepositorySlug: slug, APIBaseURL: base + "/api", GitURL: gitURL}
	if err := binding.Validate(); err != nil {
		return pkgerrors.Conflict("workspace coding source binding configuration is invalid").WithCause(err)
	}
	updated, err := s.ensureWorkspaceHeadReporter(ctx, row)
	if err != nil {
		return err
	}
	if !updated.HeadPushTokenID.Valid {
		return pkgerrors.Conflict("workspace source publisher is unavailable")
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, row.UserID, workspaceLifecycleOperation(row, "coding-binding"))
	if err != nil {
		return err
	}
	if err := installer.InstallWorkspaceCodingBinding(operationCtx, row.ID, binding); err != nil {
		return pkgerrors.Internal("install workspace coding source binding").WithCause(err)
	}
	return nil
}
