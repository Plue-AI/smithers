package services

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type installImportReadStore struct{ pool *pgxpool.Pool }

func WithGitHubImportInstallAuthorization(pool *pgxpool.Pool) GitHubImportOption {
	return func(s *GitHubImportService) { s.installRead = &installImportReadStore{pool} }
}
func InstallGitHubImportReadSubject(id string) (InstallSubject, error) {
	subject := InstallSubject{Resource: "github-import"}
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	if err != nil {
		return subject, pkgerrors.BadRequest("invalid import job id")
	}
	subject.Source = parsed.String()
	return subject, nil
}

func (s *GitHubImportService) getInstallImportJob(ctx context.Context, userID int64, id string) (ImportJob, error) {
	if s.installRead.pool == nil {
		return ImportJob{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "import store unavailable")
	}
	tx, err := s.installRead.pool.Begin(ctx)
	if err != nil {
		return ImportJob{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	subject, validation := InstallGitHubImportReadSubject(id)
	decision, err := Authorize(ctx, q, "github.import-read", subject)
	if err != nil {
		return ImportJob{}, err
	}
	if validation != nil {
		return ImportJob{}, validation
	}
	if userID != decision.UserID {
		return ImportJob{}, confirmationPermission()
	}
	// Import progress exists before the repository is bound. Lock the owner,
	// live user and browser session without requiring a completed install.
	if _, err = tx.Exec(ctx, `SELECT 1 FROM self_host_owners WHERE singleton FOR SHARE`); err != nil {
		return ImportJob{}, err
	}
	if err = lockInstallSessionWrite(ctx, tx, userID); err != nil {
		return ImportJob{}, err
	}
	role, err := InstallRoleOf(ctx, q, userID)
	if err != nil {
		return ImportJob{}, err
	}
	if role != decision.Role {
		return ImportJob{}, confirmationPermission()
	}
	scoped := *s
	scoped.db = tx
	result, err := scoped.getImportJob(ctx, userID, subject.Source)
	if err != nil {
		return ImportJob{}, err
	}
	if err = lockInstallSessionWrite(ctx, tx, userID); err != nil {
		return ImportJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ImportJob{}, err
	}
	return result, nil
}

// Setup polls its own durable import receipt inside the already-admitted
// source job. This private adapter exposes no browser or agent read door.
type installImportReceiptReader struct{ *GitHubImportService }

func (s installImportReceiptReader) GetImportJob(ctx context.Context, userID int64, id string) (ImportJob, error) {
	return s.getImportJob(ctx, userID, id)
}
