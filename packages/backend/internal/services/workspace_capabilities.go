package services

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const repositoryJobsCapability = "repository-jobs/v1"

// The probe may start an already provisioned workspace's host, but never
// allocates compute. A false result means an explicitly incompatible host.
type WorkspaceCapabilityProbe func(context.Context, db.Workspace, string) (bool, error)

func repositoryWorkspacePending(message string) *pkgerrors.APIError {
	return pkgerrors.New(pkgerrors.CodeRepositoryWorkspacePending, message)
}

func WithWorkspaceCapabilityProbe(probe WorkspaceCapabilityProbe) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.capabilityProbe = probe }
}

func WithWorkspaceCapabilityTransactions(transactions RepositoryJobTransactions) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.capabilityTransactions = transactions }
}

// Existing authority wins before any probe. Probe the primary outside the
// transaction, then recheck its identity under the selection lock. Reusing a
// compatible primary consumes no additional sandbox quota; a separate machine
// is reserved only after the existing primary proves unsuitable.
func (s *WorkspaceService) findOrCreateCapabilityWorkspace(ctx context.Context, input CreateWorkspaceInput, bookmark string, environment WorkspaceEnvironment) (db.Workspace, error) {
	if s.capabilityTransactions == nil {
		return db.Workspace{}, pkgerrors.Internal("workspace capability transactions unavailable")
	}
	workspace, found, err := s.selectCapabilityWorkspace(ctx, input, bookmark, environment, nil, false, false)
	if err == nil && found {
		err = s.refuseRebuildRequired(workspace)
	}
	if err != nil || found {
		return workspace, err
	}
	candidate, verified, probeErr := s.compatiblePrimaryWorkspace(ctx, input, bookmark)
	workspace, found, err = s.selectCapabilityWorkspace(ctx, input, bookmark, environment, candidate, verified, probeErr == nil)
	if err == nil && found {
		err = s.refuseRebuildRequired(workspace)
	}
	if err != nil || found {
		return workspace, err
	}
	return db.Workspace{}, probeErr
}

func (s *WorkspaceService) compatiblePrimaryWorkspace(ctx context.Context, input CreateWorkspaceInput, bookmark string) (*db.Workspace, bool, error) {
	if s.capabilityProbe == nil {
		return nil, false, nil
	}
	rows, err := s.q.ListWorkspacesByRepo(ctx, db.ListWorkspacesByRepoParams{RepositoryID: input.RepositoryID, UserID: input.UserID, PageSize: MaxActiveWorkspacesPerUser})
	if err != nil {
		return nil, false, err
	}
	var pending *db.Workspace
	for _, workspace := range rows {
		if workspace.IsFork || workspace.DeletedAt.Valid || workspace.RepositoryID != input.RepositoryID || workspace.UserID != input.UserID ||
			!repositoryJobWorkspaceKind(workspace.Kind) || targetWorkspaceBookmark(workspace.TargetBookmark) != bookmark {
			continue
		}
		if workspace.Status != "running" && workspace.Status != "suspended" && workspace.Status != "starting" && workspace.Status != "pending" {
			continue
		}
		// An import reserves the free plan's only slot before its VM exists.
		// Keep that reservation, but expose no selected identity until its host
		// proves compatibility. Otherwise clients pin an unverified old image.
		if strings.TrimSpace(workspace.VmID) == "" {
			if workspace.Status == "starting" || workspace.Status == "pending" {
				copy := workspace
				pending = &copy
			}
			continue
		}
		compatible, err := s.capabilityProbe(ctx, workspace, input.RequiredCapability)
		var apiErr *pkgerrors.APIError
		if errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeWorkspaceVMMissing {
			// The provider conclusively refused this VM identity. This only
			// selects an UNBOUND setup; established registrations were resolved
			// first and remain pinned. Transient failures never allocate here.
			if err := s.retireMissingCapabilityPrimary(ctx, input, bookmark, workspace); err != nil {
				return nil, false, err
			}
			continue
		}
		if apiErr != nil && apiErr.Code == pkgerrors.CodeRepositoryWorkspacePending {
			copy := workspace
			pending = &copy
			continue
		}
		if err != nil {
			return nil, false, err
		}
		if compatible {
			return &workspace, true, nil
		}
	}
	return pending, false, nil
}

func repositoryJobWorkspaceKind(kind string) bool { return kind == "vm" || kind == "container" }

// A confirmed provider 404 must not reserve a free user's only compute slot.
// Fence the terminal transition on the exact probe row and serialize it with
// both new capability bindings and registrations. Never delete or repoint the
// old workspace; ordinary billing authorizes any subsequent allocation.
func (s *WorkspaceService) retireMissingCapabilityPrimary(ctx context.Context, input CreateWorkspaceInput, bookmark string, missing db.Workspace) error {
	tx, err := s.capabilityTransactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, input.RepositoryID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM repositories WHERE id=$1 FOR SHARE", input.RepositoryID); err != nil {
		return err
	}
	q := db.New(tx)
	repo, err := (&RepositoryJobService{q: q}).authorizedRepo(ctx, input.RepositoryID, input.UserID, true)
	if err != nil {
		return err
	}
	if targetWorkspaceBookmark(repo.DefaultBookmark) != bookmark {
		return pkgerrors.Conflict("repository default bookmark changed; retry setup")
	}
	if err = q.LockWorkspaceCapability(ctx, db.LockWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID}); err != nil {
		return err
	}
	_, err = q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
	if err == nil {
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	registered, err := q.ListRegisteredJobWorkspaceIDs(ctx, db.ListRegisteredJobWorkspaceIDsParams{RepositoryID: input.RepositoryID, UserID: input.UserID})
	if err != nil {
		return err
	}
	if len(registered) != 0 {
		return nil
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", missing.ID); err != nil {
		return err
	}
	current, err := q.GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: missing.ID, RepositoryID: input.RepositoryID, UserID: input.UserID})
	if err != nil || current.VmID != missing.VmID || current.ProvisioningGeneration != missing.ProvisioningGeneration || current.IsFork || current.Kind != missing.Kind || current.DeletedAt.Valid || targetWorkspaceBookmark(current.TargetBookmark) != bookmark {
		return pkgerrors.Conflict("workspace changed after missing VM probe; retry setup")
	}
	failed, err := q.FailWorkspaceIfUnchanged(ctx, db.FailWorkspaceIfUnchangedParams{ID: missing.ID, ExpectedStatus: missing.Status,
		ExpectedVmID: missing.VmID, ExpectedUpdatedAt: missing.UpdatedAt, FailureCode: string(pkgerrors.CodeWorkspaceVMMissing), FailureMessage: "The recorded VM no longer exists"})
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Conflict("workspace changed after missing VM probe; retry setup")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.meterWorkspaceUsage(ctx, failed, "failed")
	s.notifyWorkspace(ctx, failed.ID, "failed")
	return nil
}

// allocate=false only resolves existing authority. A pending imported primary
// returns a typed wait without a selected workspace or capability binding.
func (s *WorkspaceService) selectCapabilityWorkspace(ctx context.Context, input CreateWorkspaceInput, bookmark string, environment WorkspaceEnvironment, candidate *db.Workspace, verified, allocate bool) (db.Workspace, bool, error) {
	tx, err := s.capabilityTransactions.Begin(ctx)
	if err != nil {
		return db.Workspace{}, false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, input.RepositoryID); err != nil {
		return db.Workspace{}, false, err
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM repositories WHERE id=$1 FOR SHARE", input.RepositoryID); err != nil {
		return db.Workspace{}, false, err
	}
	q := db.New(tx)
	repo, err := (&RepositoryJobService{q: q}).authorizedRepo(ctx, input.RepositoryID, input.UserID, true)
	if err != nil {
		return db.Workspace{}, false, err
	}
	if targetWorkspaceBookmark(repo.DefaultBookmark) != bookmark {
		return db.Workspace{}, false, pkgerrors.Conflict("repository default bookmark changed; retry setup")
	}
	if err = q.LockWorkspaceCapability(ctx, db.LockWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID}); err != nil {
		return db.Workspace{}, false, err
	}
	workspace, err := q.GetWorkspaceCapability(ctx, db.GetWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID, RequiredCapability: input.RequiredCapability})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return db.Workspace{}, false, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// An existing trial/applied/paused registration already owns a machine.
		// Selection must never migrate its durable history or authority.
		ids, err := q.ListRegisteredJobWorkspaceIDs(ctx, db.ListRegisteredJobWorkspaceIDsParams{RepositoryID: input.RepositoryID, UserID: input.UserID})
		if err != nil {
			return db.Workspace{}, false, err
		}
		if len(ids) > 1 {
			return db.Workspace{}, false, pkgerrors.Conflict("repository jobs use different workspaces; select the existing job's workspace explicitly")
		}
		if len(ids) == 1 {
			workspace, err = q.GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: ids[0], RepositoryID: input.RepositoryID, UserID: input.UserID})
			if err != nil {
				return db.Workspace{}, false, pkgerrors.Conflict("the registered repository workspace is unavailable")
			}
		} else if candidate != nil {
			if _, err = tx.Exec(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", candidate.ID); err != nil {
				return db.Workspace{}, false, err
			}
			workspace, err = q.GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: candidate.ID, RepositoryID: input.RepositoryID, UserID: input.UserID})
			if err != nil || workspace.DeletedAt.Valid || workspace.IsFork || workspace.Kind != candidate.Kind ||
				workspace.VmID != candidate.VmID || workspace.ProvisioningGeneration != candidate.ProvisioningGeneration ||
				targetWorkspaceBookmark(workspace.TargetBookmark) != bookmark ||
				(verified && workspace.Status != "running") || (!verified && workspace.Status != "starting" && workspace.Status != "pending" && workspace.Status != "running" && workspace.Status != "suspended") {
				return db.Workspace{}, false, pkgerrors.Conflict("repository workspace changed during capability check; retry setup")
			}
			if !verified {
				return db.Workspace{}, false, repositoryWorkspacePending("Repository workspace compatibility is still being checked")
			}
		} else {
			if !allocate {
				return db.Workspace{}, false, nil
			}
			scoped := *s
			scoped.q = q
			if err = scoped.enforceWorkspaceQuota(ctx, input.UserID); err != nil {
				return db.Workspace{}, false, err
			}
			workspace, err = scoped.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: input.RepositoryID, UserID: input.UserID,
				Name: strings.TrimSpace(input.Name), IsFork: true, TargetBookmark: bookmark, Kind: "vm", Status: "starting",
				EnvironmentSource: environment.Source, EnvironmentRevision: environment.Revision, EnvironmentClosureHash: environment.ClosureHash})
			if err != nil {
				return db.Workspace{}, false, mapWorkspaceCreateError(err, "create repository workspace")
			}
		}
		if err = q.BindWorkspaceCapability(ctx, db.BindWorkspaceCapabilityParams{RepositoryID: input.RepositoryID, UserID: input.UserID,
			RequiredCapability: input.RequiredCapability, WorkspaceID: workspace.ID}); err != nil {
			return db.Workspace{}, false, err
		}
	}
	if workspace.DeletedAt.Valid || workspace.RepositoryID != input.RepositoryID || workspace.UserID != input.UserID || !repositoryJobWorkspaceKind(workspace.Kind) {
		return db.Workspace{}, false, pkgerrors.Conflict("the selected repository workspace is unavailable; its existing binding is preserved")
	}
	if targetWorkspaceBookmark(workspace.TargetBookmark) != bookmark {
		return db.Workspace{}, false, pkgerrors.Conflict("the selected repository workspace has a different bookmark")
	}
	if err := tx.Commit(ctx); err != nil {
		return db.Workspace{}, false, err
	}
	return workspace, true, nil
}
