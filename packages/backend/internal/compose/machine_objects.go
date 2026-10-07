package compose

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// The authenticated link chooses the branch. Resolve its repository from host
// records and keep the engine's maintenance lock for the complete import. No
// guest path or bundle ref name selects a host path or moves a product ref.
func machineObjectImporter(lifetime context.Context, pool *pgxpool.Pool, host *repohost.Client) machined.ObjectImporter {
	return func(ctx context.Context, branch string, file *os.File) error {
		if pool == nil || host == nil || file == nil {
			return machined.ErrNotReady
		}
		id, err := uuid.Parse(branch)
		if err != nil || id.String() != branch {
			return machined.ErrUnauthorized
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		stop := context.AfterFunc(lifetime, cancel)
		defer stop()
		if lifetime.Err() != nil {
			return lifetime.Err()
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer func() {
			cleanup, done := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer done()
			_ = tx.Rollback(cleanup)
		}()
		// Keep deletion/reassignment serialized through import without checking out
		// any branch. This transaction needs only its own database connection.
		var repository int64
		err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces
   WHERE id=$1 AND deleted_at IS NULL AND vm_id<>''
   AND status IN ('starting','running','suspended','stopped') FOR SHARE`, branch).Scan(&repository)
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
		err = host.WithMachineRepository(ctx, scope.OwnerSlug, scope.RepoName, func(path string) error {
			importer := machined.GitBundleImporter(func(context.Context, string) (string, error) { return path, nil })
			return importer(ctx, branch, file)
		})
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
}

func bindMachineObjects(ctx context.Context, registry *machined.Registry, pool *pgxpool.Pool, host *repohost.Client) func() {
	if registry == nil {
		return func() {}
	}
	ctx, cancel := context.WithCancel(ctx)
	registry.BindObjectImporter(machineObjectImporter(ctx, pool, host))
	return func() { cancel(); registry.BindObjectImporter(nil) }
}
