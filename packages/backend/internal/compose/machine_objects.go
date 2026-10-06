package compose

import (
	"context"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Host DB state chooses the admitted branch's repository. The embedded engine
// holds its writer exclusion throughout Git work; a guest cannot choose a path
// or race repository maintenance. Remote placement grants no local capability.
func bindMachineObjectStores(registry *machined.Registry, pool *pgxpool.Pool, repository *repohost.Client) {
	withStore := func(ctx context.Context, branch string, use func(string) error) error {
		if pool == nil || repository == nil {
			return machined.ErrNotReady
		}
		var owner, name string
		if err := pool.QueryRow(ctx, `SELECT u.username,r.name FROM workspaces w JOIN repositories r ON r.id=w.repository_id JOIN users u ON u.id=r.user_id WHERE w.id=$1`, branch).Scan(&owner, &name); err != nil {
			return err
		}
		return repository.WithLocalGitStore(ctx, owner, name, use)
	}
	registry.BindObjectImporter(func(ctx context.Context, branch string, file *os.File) error {
		return withStore(ctx, branch, func(path string) error {
			return machined.GitBundleImporter(func(context.Context, string) (string, error) { return path, nil })(ctx, branch, file)
		})
	})
	registry.BindObjectExporter(func(ctx context.Context, branch, head string, stream uint32) (*os.File, error) {
		var file *os.File
		err := withStore(ctx, branch, func(path string) error {
			var err error
			file, err = machined.GitBundleExporter(func(context.Context, string) (string, error) { return path, nil })(ctx, branch, head, stream)
			return err
		})
		return file, err
	})
}
