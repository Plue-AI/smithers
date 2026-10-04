package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallCapacityOwnerLowerRestoreAndPermissionPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	owner := int64(0)
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username,lower_username) VALUES ('capacityowner','capacityowner') RETURNING id`).Scan(&owner))
	_, err := pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES ($1)`, owner)
	require.NoError(t, err)
	svc := InstallCapacityService{Queries: db.New(pool), Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	// C-MCH-04 steps 3–5: only the owner, never above the formula; write refusal preserves saved value.
	require.NoError(t, svc.Set(t.Context(), owner, 1))
	status, err := svc.Read(t.Context())
	require.NoError(t, err)
	require.Equal(t, 1, status.Machines.Capacity)
	svc.Profile = microsandbox.HostProfile{MemoryBytes: 24 << 30, PerfCores: 8, DiskFreeBytes: 200 << 30}
	status, err = svc.Read(t.Context())
	require.NoError(t, err)
	require.Equal(t, 1, status.Machines.Capacity)
	svc.Profile = microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}
	for _, value := range []int{0, -1, 4} {
		err = svc.Set(t.Context(), owner, value)
		var typed *microsandbox.CapacityError
		require.ErrorAs(t, err, &typed)
		require.Equal(t, "user", typed.Class)
		if value == 4 {
			require.Contains(t, err.Error(), "3")
		}
	}
	for _, role := range []string{"maintainer", "member"} {
		var id int64
		require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username,lower_username) VALUES ($1,$1) RETURNING id`, role).Scan(&id))
		err = svc.Set(t.Context(), id, 1)
		var typed *microsandbox.CapacityError
		require.ErrorAs(t, err, &typed)
		require.Equal(t, "permission", typed.Class)
	}
	status, err = svc.Read(t.Context())
	require.NoError(t, err)
	require.Equal(t, 1, status.Machines.Capacity)
	require.NoError(t, svc.Set(t.Context(), owner, 3))
	svc.Profile = microsandbox.HostProfile{MemoryBytes: 24 << 30, PerfCores: 8, DiskFreeBytes: 200 << 30}
	status, err = svc.Read(t.Context())
	require.NoError(t, err)
	require.Equal(t, 2, status.Machines.Capacity)
	svc.Profile.DiskFreeBytes = 60 << 30
	status, err = svc.Read(t.Context())
	require.NoError(t, err)
	require.Zero(t, status.Machines.Capacity)
	require.Equal(t, "disk", status.Limits.LimitingTerm)
	require.Equal(t, "free 12 GiB on the state volume", status.Limits.Fix)
	require.NoError(t, svc.ValidateStart(t.Context()))
}

func TestInstallCapacityFreshZeroStartPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	for _, p := range []microsandbox.HostProfile{{MemoryBytes: 13 << 30, PerfCores: 8, DiskFreeBytes: 200 << 30}, {MemoryBytes: 16 << 30, PerfCores: 1, DiskFreeBytes: 200 << 30}, {MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 60 << 30}} {
		svc := InstallCapacityService{Queries: db.New(pool), Profile: p}
		var typed *microsandbox.CapacityError
		require.ErrorAs(t, svc.ValidateStart(t.Context()), &typed)
		require.Equal(t, "capacity", typed.Class)
	}
}

// Supplemental real-store evidence. Production install/dispatcher/scheduler/live
// acceptance stays dark until those providers land; this is not C-STK-02.
func TestInstallParallelPersistencePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	var owner int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username,lower_username) VALUES ('parallelowner','parallelowner') RETURNING id`).Scan(&owner))
	_, err := pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES ($1)`, owner)
	require.NoError(t, err)
	s := InstallCapacityService{Queries: db.New(pool), Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}, AuthorizeParallel: func(context.Context) error { return nil }}
	result, err := s.Parallel(t.Context())
	require.NoError(t, err)
	require.Equal(t, InstallParallel{2, 2}, result)
	ctx := parallelOwnerContext(t.Context(), owner)
	require.NoError(t, s.SetParallel(ctx, 8))
	// A reconstructed service reads persistence without needing authority for a write.
	restarted := InstallCapacityService{Queries: db.New(pool), Profile: s.Profile}
	result, err = restarted.Parallel(t.Context())
	require.NoError(t, err)
	require.Equal(t, InstallParallel{8, 3}, result)
	restarted.Profile.DiskFreeBytes = 104 << 30
	result, err = restarted.Parallel(t.Context())
	require.NoError(t, err)
	require.Equal(t, InstallParallel{8, 2}, result)
	restarted.Profile.DiskFreeBytes = 60 << 30
	result, err = restarted.Parallel(t.Context())
	require.NoError(t, err)
	require.Equal(t, InstallParallel{8, 0}, result)
	for _, actor := range []int64{0, owner + 1} {
		count, err := db.New(pool).SetInstallParallel(t.Context(), db.SetInstallParallelParams{ActorID: actor, Value: []byte(`1`)})
		require.NoError(t, err)
		require.Zero(t, count)
	}
	raw, err := db.New(pool).GetInstallParallel(t.Context())
	require.NoError(t, err)
	require.JSONEq(t, `8`, string(raw))
}
func TestInstallParallelLegacyMigrationPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	// Find the forward migration by its statement, not its registry number.
	paths, err := filepath.Glob("../../db/product/migrations/*.sql")
	require.NoError(t, err)
	var migration []byte
	for _, path := range paths {
		content, err := os.ReadFile(path)
		require.NoError(t, err)
		if strings.Contains(string(content), "SELECT 'parallel', to_jsonb(max_parallel)") {
			require.Nil(t, migration, "one install parallel migration")
			migration = content
		}
	}
	require.NotNil(t, migration)
	var owner, repo int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username,lower_username) VALUES ('legacyparallel','legacyparallel') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'legacy','legacy') RETURNING id`, owner).Scan(&repo))
	_, err = pool.Exec(t.Context(), `INSERT INTO mythical_stacks(repository_id,max_parallel) VALUES ($1,5)`, repo)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), string(migration))
	require.NoError(t, err)
	raw, err := db.New(pool).GetInstallParallel(t.Context())
	require.NoError(t, err)
	require.JSONEq(t, `5`, string(raw))
	_, err = pool.Exec(t.Context(), `UPDATE install_settings SET value = '8' WHERE key = 'parallel'`)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), string(migration))
	require.NoError(t, err)
	raw, err = db.New(pool).GetInstallParallel(t.Context())
	require.NoError(t, err)
	require.JSONEq(t, `8`, string(raw))
}
