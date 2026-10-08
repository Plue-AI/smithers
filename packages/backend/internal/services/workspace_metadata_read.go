package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type workspaceMetadataPage[T any] struct {
	rows  []T
	total int64
}

// Metadata admission uses the same credential fence as other install reads.
// The scoped reader uses the transaction's connection, including with pool size
// one. No connection or authority lock survives into a streaming response.
func readInstallWorkspaceMetadata[T any](ctx context.Context, s *WorkspaceService, command string, repository, actor int64, read func(context.Context, *WorkspaceService) (T, error), subjects ...InstallSubject) (T, error) {
	return withInstallWorkspaceMetadata(ctx, s, command, repository, actor, false, read, subjects...)
}

// Some runtime reads record entry recency. Commit those writes only after the
// same final credential fence that protects the returned private data.
func withInstallWorkspaceMetadata[T any](ctx context.Context, s *WorkspaceService, command string, repository, actor int64, commit bool, read func(context.Context, *WorkspaceService) (T, error), subjects ...InstallSubject) (T, error) {
	var zero T
	if s == nil {
		return zero, pkgerrors.Internal("workspace store unavailable")
	}
	if s.installQueries == nil {
		return read(ctx, s)
	}
	if s.transactions == nil {
		return zero, confirmationPermission()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	scoped := *s
	scoped.q = q
	scoped.installQueries = q
	scoped.transactions = tx
	ctx, err = scoped.authorizeInstallWorkspaceMetadata(ctx, command, repository, actor, subjects...)
	if err != nil {
		return zero, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return zero, err
	}
	result, err := read(ctx, &scoped)
	if err != nil {
		return zero, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return zero, err
	}
	if commit {
		if err = tx.Commit(ctx); err != nil {
			return zero, err
		}
	}
	return result, nil
}
