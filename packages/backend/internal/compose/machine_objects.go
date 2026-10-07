package compose

import (
	"context"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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
		err = withMachineRepositoryTx(ctx, tx, branch, host, func(path string) error {
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
