package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// InstallExecutionFileSubject resolves the stored lane before admitting an
// execution read. A commit selector or arbitrary workspace grants no authority.
func InstallExecutionFileSubject(ctx context.Context, q *db.Queries, repository int64, workspace string) (InstallSubject, error) {
	subject, err := ResolveInstallExecutionSubject(ctx, q, repository)
	if err != nil {
		var refusal *AccessError
		if !errors.As(err, &refusal) || refusal.Status != 403 {
			return InstallSubject{}, err
		}
		subject = InstallSubject{RepositoryID: repository}
	}
	subject.WorkspaceID = workspace
	subject.Resource = "files"
	return subject, nil
}

// Serialized credential/member and sponsor checks also apply to direct service
// reads. Hold those facts through the read so a later removal cannot disclose
// bytes from an earlier bound authorization decision.
func (s *WorkspaceService) withInstallExecutionFileRead(ctx context.Context, workspace string, repository, actor int64, read func(context.Context) error) error {
	if !InstallExecutionCredential(ctx) || s.installQueries == nil {
		return read(ctx)
	}
	if s.transactions == nil {
		return confirmationPermission()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return err
	}
	q := db.New(tx)
	subject, err := InstallExecutionFileSubject(ctx, q, repository, workspace)
	if err != nil {
		return err
	}
	var present int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR SHARE`, repository, subject.TodoNumber).Scan(&present); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return confirmationPermission()
		}
		return err
	}
	decision, err := Authorize(ctx, q, "branch.read", subject)
	if err != nil {
		return err
	}
	// Authorize may reuse the request's decision. Stored facts are checked again
	// under the transaction without making a second command-policy decision.
	if _, err := authorizeExecutionTodoRead(ctx, q, subject); err != nil {
		return err
	}
	return read(WithInstallAuthorization(ctx, "branch.read", decision, subject))
}
