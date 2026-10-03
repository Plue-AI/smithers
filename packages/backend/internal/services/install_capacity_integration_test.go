package services

import (
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
