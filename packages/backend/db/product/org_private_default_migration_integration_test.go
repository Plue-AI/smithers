package product

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOrgPrivateDefaultMigration_PostgreSQL(t *testing.T) {
	t.Run("fresh install", func(t *testing.T) {
		pool := newProductTestPool(t)
		ctx := context.Background()
		require.NoError(t, Apply(ctx, pool))
		var visibility string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations(name, lower_name) VALUES ('fresh', 'fresh') RETURNING visibility`).Scan(&visibility))
		require.Equal(t, "private", visibility)
		for _, explicit := range []string{"public", "limited", "private"} {
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations(name, lower_name, visibility) VALUES ($1, $1, $2) RETURNING visibility`, "fresh-"+explicit, explicit).Scan(&visibility))
			require.Equal(t, explicit, visibility)
		}
	})
	t.Run("upgrade preserves existing visibility", func(t *testing.T) {
		pool := newProductTestPool(t)
		ctx := context.Background()
		registered, err := registeredMigrations()
		require.NoError(t, err)
		require.GreaterOrEqual(t, len(registered), 83, "private default migration must be registered")
		require.NoError(t, applyOnce(ctx, pool, registered[:82]))
		var visibility string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations(name, lower_name, description) VALUES ('old-default', 'old-default', 'unchanged') RETURNING visibility`).Scan(&visibility))
		require.Equal(t, "public", visibility, "previous schema remains public until upgraded")
		for _, explicit := range []string{"public", "limited", "private"} {
			_, err := pool.Exec(ctx, `INSERT INTO organizations(name, lower_name, description, visibility) VALUES ($1, $1, 'unchanged', $2)`, "old-"+explicit, explicit)
			require.NoError(t, err)
		}
		pending, err := Status(ctx, pool)
		require.NoError(t, err)
		require.NotEmpty(t, pending)
		require.Equal(t, 83, pending[0])
		require.NoError(t, Apply(ctx, pool))
		for name, want := range map[string]string{"old-default": "public", "old-public": "public", "old-limited": "limited", "old-private": "private"} {
			var description string
			require.NoError(t, pool.QueryRow(ctx, `SELECT visibility, description FROM organizations WHERE lower_name=$1`, name).Scan(&visibility, &description))
			require.Equal(t, want, visibility)
			require.Equal(t, "unchanged", description)
		}
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations(name, lower_name) VALUES ('after-upgrade', 'after-upgrade') RETURNING visibility`).Scan(&visibility))
		require.Equal(t, "private", visibility)
		require.NoError(t, Apply(ctx, pool), "migration replay through the ledger must be safe")
		pending, err = Status(ctx, pool)
		require.NoError(t, err)
		require.Empty(t, pending)
	})
}
