package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// withInstallFileCoedit binds validated, owned bytes before machine admission.
// Restore has already consumed its own command. Coding-host grants additionally
// retain exact raw-body verification and the existing serialized live-host fence.
func (s *WorkspaceService) withInstallFileCoedit(ctx context.Context, workspace string, repository, actor int64, digest string, coedit bool, write func(context.Context) error) error {
	if s.installQueries == nil || !coedit {
		return write(ctx)
	}
	subject := InstallSubject{RepositoryID: repository, WorkspaceID: workspace, PayloadDigest: digest, Resource: "files"}
	if InstallExecutionCredential(ctx) {
		var err error
		subject, err = InstallExecutionFileSubject(ctx, s.installQueries, repository, workspace)
		if err != nil {
			return err
		}
		subject.PayloadDigest = digest
	}
	if binding, ok := middleware.CodingFileCredential(middleware.AuthInfoFromContext(ctx)); ok {
		subject.RunID, subject.Source, subject.Base = binding.RunID, binding.HostID, binding.Fence
	}
	decision, err := Authorize(ctx, s.installQueries, "flow.source-coedit", subject)
	if err != nil {
		return err
	}
	if decision.UserID != actor || s.transactions == nil {
		return confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, "flow.source-coedit", decision, subject)
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return err
	}
	q := db.New(tx)
	row, err := q.GetWorkspace(ctx, workspace)
	if errors.Is(err, pgx.ErrNoRows) {
		return confirmationPermission()
	}
	if err != nil {
		return err
	}
	if row.RepositoryID != repository || row.DeletedAt.Valid || middleware.IsCodingFileCredential(middleware.AuthInfoFromContext(ctx)) && row.Status != "running" {
		return confirmationPermission()
	}
	if InstallExecutionCredential(ctx) {
		var present int
		if err := tx.QueryRow(ctx, `SELECT 1 FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR SHARE`, repository, subject.TodoNumber).Scan(&present); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return confirmationPermission()
			}
			return err
		}
		current, err := InstallExecutionFileSubject(ctx, q, repository, workspace)
		if err != nil {
			return err
		}
		current.PayloadDigest = digest
		if current != subject || row.Status != "running" {
			return confirmationPermission()
		}
		if _, err := authorizeExecutionTodoRead(ctx, q, subject); err != nil {
			return err
		}
	}
	return write(ctx)
}

// The coding host's issuer-only grant is narrower than ordinary delegated
// editing: one host generation, workspace, run and exact verified request.
// It never acquires the app agent's authority or a general file-write scope.
func authorizeCodingFileCoedit(ctx context.Context, q *db.Queries, subject InstallSubject) (InstallAuthorization, error) {
	token, decision, err := authenticateInstallStoredToken(ctx, q)
	if err != nil {
		return InstallAuthorization{}, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	binding, ok := middleware.CodingFileCredential(info)
	if !ok || !middleware.CodingFileBatchVerified(info, binding.BatchDigest) ||
		token.Name != "coding-file-"+binding.HostID || subject.RepositoryID != binding.RepositoryID ||
		subject.WorkspaceID != binding.WorkspaceID || subject.RunID != binding.RunID ||
		subject.Source != binding.HostID || subject.Base != binding.Fence || subject.PayloadDigest == "" || subject.Resource != "files" {
		return InstallAuthorization{}, confirmationPermission()
	}
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if repository != binding.RepositoryID {
		return InstallAuthorization{}, confirmationPermission()
	}
	workspace, err := q.GetWorkspace(ctx, binding.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstallAuthorization{}, confirmationPermission()
	}
	if err != nil {
		return InstallAuthorization{}, err
	}
	if workspace.RepositoryID != repository || workspace.DeletedAt.Valid || workspace.Status != "running" {
		return InstallAuthorization{}, confirmationPermission()
	}
	live, err := q.CodingFileHostIsActive(ctx, binding.HostID, decision.UserID, repository, binding.WorkspaceID, binding.Fence)
	if err != nil {
		return InstallAuthorization{}, err
	}
	if !live {
		return InstallAuthorization{}, confirmationPermission()
	}
	return decision, nil
}
