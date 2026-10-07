package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// HostedBranchMachineProviders are a hosted deployment's branch machine
// providers (#3751), composed only on its microVM runtime. A hosted
// deployment has no install roster: a branch's members are the accounts that
// may write its repository, as every other hosted write decides.
//   - Membership is an active account that may sign in, held FOR SHARE until
//     the transaction ends, with write or admin access to the repository
//     (owner, organization owner, team or collaborator).
//   - Authorize admits the install's branch commands for the same accounts.
//   - LaneBinding, MicroVM and SessionIdentity are the install's.
func HostedBranchMachineProviders(runtime workspaceapi.WorkspaceRuntime) BranchMachineProviders {
	return BranchMachineProviders{
		Membership:      hostedBranchMembership,
		Authorize:       hostedBranchAuthorizer,
		LaneBinding:     installLaneBinding,
		MicroVM:         installMicroVM(runtime),
		SessionIdentity: installSessionIdentity(runtime),
	}
}

func hostedBranchMembership(ctx context.Context, tx pgx.Tx, repositoryID, actorID int64) error {
	var id int64
	err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND is_active
        AND deleted_at IS NULL AND NOT prohibit_login FOR SHARE`, actorID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Forbidden("not a writer of this repository")
	}
	if err != nil {
		return err
	}
	return hostedRepositoryWriter(ctx, tx, repositoryID, actorID)
}

func hostedBranchAuthorizer(ctx context.Context, tx pgx.Tx, command string, repositoryID int64, _ string, actorID int64) error {
	if !branchMachineCommands[command] {
		return pkgerrors.Forbidden("branch command " + command + " is not allowed")
	}
	return hostedRepositoryWriter(ctx, tx, repositoryID, actorID)
}

func hostedRepositoryWriter(ctx context.Context, tx pgx.Tx, repositoryID, actorID int64) error {
	q := db.New(tx)
	repository, err := q.GetRepoByID(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return pkgerrors.Forbidden("not a writer of this repository")
	}
	if err != nil {
		return err
	}
	writer, err := canWriteRepo(ctx, q, repository, actorID)
	if err != nil {
		return err
	}
	if !writer {
		return pkgerrors.Forbidden("not a writer of this repository")
	}
	return nil
}
