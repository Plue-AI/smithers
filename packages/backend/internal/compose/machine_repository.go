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
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// withMachineRepositoryTx resolves the host store using the event's existing
// transaction. Never acquire another pool connection from inside an event
// writer: a full pool would leave every writer waiting for itself. Workspace
// deletion/reassignment, repository ownership and engine maintenance remain
// fenced for the visit. No guest path names a host directory.
func withMachineRepositoryTx(ctx context.Context, tx pgx.Tx, branch string, host *repohost.Client, visit func(string) error) error {
	return withMachineRepositoryAuthorityTx(ctx, tx, branch, host, visit, "FOR UPDATE")
}

// Read-only admission holds SHARE authority already; upgrading it while another
// admitted opener waits on the daemon mutex would deadlock both opens.
func withMachineRepositoryReadTx(ctx context.Context, tx pgx.Tx, branch string, host *repohost.Client, visit func(string) error) error {
	return withMachineRepositoryAuthorityTx(ctx, tx, branch, host, visit, "FOR SHARE")
}
func withMachineRepositoryAuthorityTx(ctx context.Context, tx pgx.Tx, branch string, host *repohost.Client, visit func(string) error, lock string) error {
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
 AND status IN ('starting','running','suspended','stopped') `+lock, branch).Scan(&repository)
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

// prepareMachineCaptureWriter locks stack/items before the workspace or receipt
// FK, then binds capture publication or wake settlement to this transaction.
func prepareMachineCaptureWriter(host *repohost.Client) machined.EventPreparation {
	return func(ctx context.Context, tx pgx.Tx, branch string, _ machined.Event) (machined.EventWriter, error) {
		if host == nil {
			return nil, machined.ErrNotReady
		}
		projection, err := services.PrepareMachineCaptureTx(ctx, tx, branch)
		if err != nil {
			return nil, err
		}
		return func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
			ack := machined.Acknowledgement{Seq: event.Seq}
			if err := projection.ValidatePublication(); err != nil {
				return ack, err
			}
			err := withMachineRepositoryTx(ctx, tx, branch, host, func(path string) error {
				objects := machined.GitCaptureObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }}
				if len(event.Payload) > 0 && event.Payload[0] == 3 {
					writer := &machined.ReconcileIngest{Objects: objects, Apply: projection.Reconcile}
					var err error
					ack, err = writer.Write(ctx, tx, branch, event)
					return err
				}
				writer := &machined.CaptureIngest{Objects: objects, Reconcile: func(ctx context.Context, _ pgx.Tx, _ string, capture wire.Captured, applied bool) error {
					return projection.Apply(ctx, capture, applied, objects)
				}}
				var err error
				ack, err = writer.Write(ctx, tx, branch, event)
				return err
			})
			return ack, err
		}, nil
	}
}
