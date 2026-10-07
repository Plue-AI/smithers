package compose

import (
	"context"
	"io"
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
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		stop := context.AfterFunc(lifetime, cancel)
		defer stop()
		if lifetime.Err() != nil {
			return lifetime.Err()
		}
		return machineObjects(pool, host).Visit(ctx, branch, func(path string) error {
			importer := machined.GitBundleImporter(func(context.Context, string) (string, error) { return path, nil })
			return importer(ctx, branch, file)
		})
	}
}

// Export uses the same authoritative workspace/owner lookup and native
// maintenance fence as import, but releases both before streaming the snapshot.
func machineObjectExporter(lifetime context.Context, pool *pgxpool.Pool, host *repohost.Client) machined.ObjectExporter {
	return func(ctx context.Context, branch, head string, stream uint32) (io.ReadCloser, error) {
		if pool == nil || host == nil {
			return nil, machined.ErrNotReady
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		stop := context.AfterFunc(lifetime, cancel)
		defer stop()
		if lifetime.Err() != nil {
			return nil, lifetime.Err()
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer func() {
			cleanup, done := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer done()
			_ = tx.Rollback(cleanup)
		}()
		var source io.ReadCloser
		err = withMachineRepositoryTx(ctx, tx, branch, host, func(path string) error {
			export := machined.GitBundleExporter(func(context.Context, string) (string, error) { return path, nil })
			var e error
			source, e = export(ctx, branch, head, stream)
			return e
		})
		if err == nil {
			err = tx.Commit(ctx)
		}
		if err != nil {
			if source != nil {
				_ = source.Close()
			}
			return nil, err
		}
		return source, nil
	}
}

func bindMachineObjects(ctx context.Context, registry *machined.Registry, pool *pgxpool.Pool, host *repohost.Client) func() {
	if registry == nil {
		return func() {}
	}
	ctx, cancel := context.WithCancel(ctx)
	registry.BindObjectImporter(machineObjectImporter(ctx, pool, host))
	registry.BindObjectExporter(machineObjectExporter(ctx, pool, host))
	return func() { cancel(); registry.BindObjectImporter(nil); registry.BindObjectExporter(nil) }
}

// Resolve every local machine object operation under the same host authority and
// repository exclusion. Stream imports and capture/head verification share it.
func machineObjects(pool *pgxpool.Pool, host *repohost.Client) machined.HostObjects {
	return machined.HostObjects{Visit: func(ctx context.Context, branch string, visit func(string) error) error {
		if pool == nil || host == nil || visit == nil {
			return machined.ErrNotReady
		}
		id, err := uuid.Parse(branch)
		if err != nil || id.String() != branch {
			return machined.ErrUnauthorized
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if tx := machined.SessionAdmissionTransaction(ctx, branch); tx != nil {
			return withMachineRepositoryReadTx(ctx, tx, branch, host, visit)
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
		err = withMachineRepositoryTx(ctx, tx, branch, host, visit)
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}}
}
