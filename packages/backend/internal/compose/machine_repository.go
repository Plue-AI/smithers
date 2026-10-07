package compose

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// withMachineRepositoryTx resolves the host store using the event's existing
// transaction. Never acquire another pool connection from inside an event
// writer: a full pool would leave every writer waiting for itself. Workspace
// deletion/reassignment, repository ownership and engine maintenance remain
// fenced for the visit. No guest path names a host directory.
func withMachineRepositoryTx(ctx context.Context, tx pgx.Tx, branch string, host *repohost.Client, visit func(string) error) error {
	if tx == nil || host == nil || visit == nil {
		return machined.ErrNotReady
	}
	id, err := uuid.Parse(branch)
	if err != nil || id.String() != branch {
		return machined.ErrUnauthorized
	}
	var repository int64
	err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces
 WHERE id=$1 AND deleted_at IS NULL AND vm_id<>''
 AND status IN ('starting','running','suspended','stopped') FOR UPDATE`, branch).Scan(&repository)
	if errors.Is(err, pgx.ErrNoRows) {
		return machined.ErrUnauthorized
	}
	if err != nil {
		return err
	}
	var user, org *int64
	err = tx.QueryRow(ctx, `SELECT user_id,org_id FROM repositories WHERE id=$1 FOR SHARE`, repository).Scan(&user, &org)
	if err != nil {
		return err
	}
	var ownerID int64
	switch {
	case user != nil && org == nil:
		err = tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, *user).Scan(&ownerID)
	case org != nil && user == nil:
		err = tx.QueryRow(ctx, `SELECT id FROM organizations WHERE id=$1 FOR SHARE`, *org).Scan(&ownerID)
	default:
		return machined.ErrUnauthorized
	}
	if err != nil {
		return err
	}
	scope, err := db.New(tx).GetRepoOwnerSlugAndNameByID(ctx, repository)
	if err != nil {
		return err
	}
	return host.WithMachineRepository(ctx, scope.OwnerSlug, scope.RepoName, visit)
}

// machineCaptureWriter binds the same authenticated repository capability as
// object import to the receipt transaction. Recovery/pending-work projection is
// mandatory and runs before the receipt can commit. Stack writers must acquire
// their stack/item fences before entering this workspace-scoped writer.
func machineCaptureWriter(host *repohost.Client, reconcile func(context.Context, pgx.Tx, string, wire.Captured, bool) error) machined.EventWriter {
	return func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
		ack := machined.Acknowledgement{Seq: event.Seq}
		if reconcile == nil {
			return ack, machined.ErrNotReady
		}
		err := withMachineRepositoryTx(ctx, tx, branch, host, func(path string) error {
			writer := &machined.CaptureIngest{Objects: machined.GitCaptureObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }}, Reconcile: reconcile}
			var err error
			ack, err = writer.Write(ctx, tx, branch, event)
			return err
		})
		return ack, err
	}
}
