package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Build each subscriber's source independently: a shared hub can conceal a
// viewer-dependent builder by reusing the first subscriber's snapshot for all.
// Authentication and owner-only writes are covered by the composed install
// boundary tests; this test uses the real projection, capacity and database.
func TestLiveHomeCapacityDoesNotDependOnSubscriber(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	people := make([]db.User, 3)
	for i, login := range []string{"homeowner", "homemaintainer", "homemember"} {
		user, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login})
		require.NoError(t, err)
		people[i] = user
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, people[0].ID)
	require.NoError(t, err)
	var repository int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, people[0].ID).Scan(&repository))
	for i, permission := range []string{"admin", "admin", "write"} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repository, people[i].ID, permission)
		require.NoError(t, err)
	}
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"homeowner","repository_name":"app","repository_id":%d}`, repository))}))
	for i, want := range []services.InstallRole{services.InstallOwner, services.InstallMaintainer, services.InstallMember} {
		role, err := services.InstallRoleOf(ctx, q, people[i].ID)
		require.NoError(t, err)
		require.Equal(t, want, role)
	}
	disk := int64(400 << 30)
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: disk, MacOSVersion: "15.6", Hypervisor: true}, FreeDisk: func(context.Context) (int64, error) { return disk, nil }}
	require.NoError(t, capacity.Set(ctx, people[0].ID, 2))
	topics := &liveTopics{queries: q, todos: services.NewMythicalService(pool, nil), capacity: capacity, install: &services.InstallSetupService{Pool: pool, Capacity: capacity}}
	for _, tc := range []struct {
		name, saved         string
		disk                int64
		parallel, available int
		invalid             bool
	}{
		{name: "saved limit", saved: "1", disk: 400 << 30, parallel: 1, available: 2},
		{name: "capacity clamps limit", saved: "8", disk: 400 << 30, parallel: 2, available: 2},
		{name: "no disk capacity", saved: "8", disk: 0, parallel: 0, available: 0},
		{name: "invalid setting", saved: "null", disk: 400 << 30, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			disk = tc.disk
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "parallel", Value: []byte(tc.saved)}))
			var first json.RawMessage
			// Reverse order too: shared data must not depend on who connects first.
			for _, index := range []int{2, 1, 0, 0, 1, 2} {
				person := people[index]
				source, refusal := topics.resolve(ctx, "home", repository, "homeowner/app", person.ID)
				require.Empty(t, refusal)
				require.Equal(t, "home", source.Key)
				got, err := source.Build(ctx)
				if tc.invalid {
					require.ErrorContains(t, err, "saved parallel must be an integer", person.Username)
					require.Empty(t, got)
					continue
				}
				require.NoError(t, err, person.Username)
				var model struct {
					Parallel *int `json:"parallel"`
					Machines struct {
						InUse    int `json:"in_use"`
						Capacity int `json:"capacity"`
					} `json:"machines"`
				}
				require.NoError(t, json.Unmarshal(got, &model))
				require.NotNil(t, model.Parallel, person.Username)
				require.Equal(t, tc.parallel, *model.Parallel, person.Username)
				require.Equal(t, tc.available, model.Machines.Capacity, person.Username)
				require.Zero(t, model.Machines.InUse)
				if first == nil {
					first = got
				} else {
					require.Equal(t, string(first), string(got), person.Username)
				}
			}
		})
	}
}
