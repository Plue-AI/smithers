package services

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type installGitMirrorStore struct{ pool *pgxpool.Pool }

func WithGitMirrorInstallAuthorization(pool *pgxpool.Pool) GitMirrorSyncOption {
	return func(s *GitMirrorSyncService) { s.install = &installGitMirrorStore{pool: pool} }
}
func InstallMirrorSyncReadSubject(repository, run int64) InstallSubject {
	return InstallSubject{RepositoryID: repository, RunID: strconv.FormatInt(run, 10), Resource: "mirror-sync"}
}
func (s *GitMirrorSyncService) getInstallMirrorSyncRun(ctx context.Context, repository, run int64) (GitMirrorSyncRunResult, error) {
	if s.install.pool == nil {
		return GitMirrorSyncRunResult{}, confirmationPermission()
	}
	tx, err := s.install.pool.Begin(ctx)
	if err != nil {
		return GitMirrorSyncRunResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	subject := InstallMirrorSyncReadSubject(repository, run)
	decision, err := Authorize(ctx, q, "mirror.read", subject)
	if err != nil {
		return GitMirrorSyncRunResult{}, err
	}
	ctx = WithInstallAuthorization(ctx, "mirror.read", decision, subject)
	if err = guardInstallMemberCredential(ctx, tx, repository, decision.UserID, false); err != nil {
		return GitMirrorSyncRunResult{}, err
	}
	if err = validateMirrorSyncRead(s, repository, run); err != nil {
		return GitMirrorSyncRunResult{}, err
	}
	// The composed recovery worker owns expired-run transitions. A private
	// status read neither writes repository health nor starts external Git work.
	result, err := readMirrorSyncRun(ctx, q, repository, run)
	if err != nil {
		return GitMirrorSyncRunResult{}, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, decision.UserID, false); err != nil {
		return GitMirrorSyncRunResult{}, err
	}
	return result, nil
}
