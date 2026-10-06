package services

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestMemberPermissionFailuresPreserveCommittedAccessPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner"})
	require.NoError(t, err)
	writer, err := q.CreateUser(ctx, db.CreateUserParams{Username: "writer", LowerUsername: "writer"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID))}))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,102,'writer','write')`, repo.ID, writer.ID)
	require.NoError(t, err)
	var mu sync.Mutex
	permissionStatus, permissionBody, repositoryStatus := 404, `{}`, 404
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/acme/app/installation":
			fmt.Fprint(w, `{"id":91}`)
		case "/repos/acme/app/collaborators/writer/permission":
			w.WriteHeader(permissionStatus)
			fmt.Fprint(w, permissionBody)
		case "/users/writer":
			fmt.Fprint(w, `{"id":102,"login":"writer"}`)
		case "/repos/acme/app":
			w.WriteHeader(repositoryStatus)
			fmt.Fprint(w, `{"full_name":"acme/app"}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	members := &Members{Pool: pool, Credentials: memberCredentials{}, Minter: &recordingMinter{}}
	for _, failure := range []struct {
		status     int
		body       string
		repoStatus int
	}{{404, `{}`, 404}, {404, `{}`, 403}, {200, `{}`, 200}, {200, `{"permission":"future"}`, 200}} {
		mu.Lock()
		permissionStatus, permissionBody, repositoryStatus = failure.status, failure.body, failure.repoStatus
		mu.Unlock()
		require.Error(t, members.Recheck(ctx))
		var suspended, prohibited bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT c.suspended_at IS NOT NULL,u.prohibit_login FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.user_id=$1`, writer.ID).Scan(&suspended, &prohibited))
		require.False(t, suspended)
		require.False(t, prohibited)
		var events int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE user_id=$1`, writer.ID).Scan(&events))
		require.Zero(t, events, "a failed permission read must publish nothing")
	}
	mu.Lock()
	permissionStatus, repositoryStatus = 404, 200
	mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	var suspended, prohibited bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT c.suspended_at IS NOT NULL,u.prohibit_login FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.user_id=$1`, writer.ID).Scan(&suspended, &prohibited))
	require.True(t, suspended)
	require.True(t, prohibited)
	mu.Lock()
	permissionStatus, permissionBody = 200, `{"permission":"write","role_name":"write"}`
	mu.Unlock()
	require.NoError(t, members.Recheck(ctx))
	require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE user_id=$1`, writer.ID).Scan(&suspended))
	require.False(t, suspended)
}
