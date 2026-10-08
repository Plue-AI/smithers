package services

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func (s *WorkspaceService) cancelInstallWorkspaceCommandRun(ctx context.Context, workspace string, repository, actor int64, operationID string) (WorkspaceCommandRun, error) {
	if s.transactions == nil {
		return WorkspaceCommandRun{}, confirmationPermission()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return WorkspaceCommandRun{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	scoped := *s
	scoped.q, scoped.installQueries, scoped.transactions = q, q, tx
	subject := InstallWorkspaceCommandReadSubject(repository, workspace, operationID)
	ctx, err = scoped.authorizeInstallWorkspaceMetadata(ctx, "runs.cancel", repository, actor, subject)
	if err != nil {
		return WorkspaceCommandRun{}, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return WorkspaceCommandRun{}, err
	}
	var result WorkspaceCommandRun
	err = scoped.withWorkspaceMutation(ctx, workspace, repository, actor, func(ctx context.Context, _ db.Workspace) error {
		operation, err := scoped.workspaceCommandRun(ctx, workspace, repository, actor, operationID, WorkspaceAccessWrite)
		if err != nil {
			return err
		}
		operation, err = scoped.commandJobs.RequestCancellationInTx(ctx, tx, operation.Scope, operation.ID)
		if err != nil {
			return err
		}
		result, err = commandRunReceipt(operation)
		return err
	})
	if err != nil {
		return WorkspaceCommandRun{}, err
	}
	if err = guardInstallMemberCredential(ctx, tx, repository, actor, false); err != nil {
		return WorkspaceCommandRun{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return WorkspaceCommandRun{}, err
	}
	return result, nil
}
