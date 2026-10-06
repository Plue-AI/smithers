package services

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

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
		if r.URL.Path != "/repos/acme/app/installation" {
			require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/acme/app/installation":
			fmt.Fprint(w, `{"id":91}`)
		case "/repos/acme/app/collaborators/writer/permission":
			w.WriteHeader(permissionStatus)
			fmt.Fprint(w, permissionBody)
		case "/user/102", "/users/writer":
			fmt.Fprint(w, `{"id":102,"login":"writer"}`)
		case "/repos/acme/app":
			fmt.Fprint(w, `{"id":500,"full_name":"acme/app"}`)
		case "/installation/repositories":
			require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
			w.WriteHeader(repositoryStatus)
			fmt.Fprint(w, `{"total_count":1,"repositories":[{"id":500,"full_name":"acme/app"}]}`)
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
	}{{404, `{}`, 404}, {404, `{}`, 403}, {404, `{}`, 401}, {401, `{}`, 200}, {403, `{}`, 200}, {200, `{}`, 200}, {200, `{"permission":"future"}`, 200}} {
		mu.Lock()
		permissionStatus, permissionBody, repositoryStatus = failure.status, failure.body, failure.repoStatus
		mu.Unlock()
		require.Error(t, members.Recheck(ctx))
		if failure.repoStatus == 401 || failure.repoStatus == 403 || failure.repoStatus == 404 || failure.status == 401 || failure.status == 403 {
			setting, e := q.GetInstallSetting(ctx, "github.permissions.health")
			require.NoError(t, e)
			var stream GitHubSyncStream
			require.NoError(t, json.Unmarshal(setting.Value, &stream))
			require.Equal(t, "refused", aggregateGitHubSyncHealth([]GitHubSyncStream{stream}, time.Now()).State)
			streams, e := (gitHubMainPullStreams{receipts: q}).RequiredStreams(ctx)
			require.NoError(t, e)
			require.Equal(t, "refused", aggregateGitHubSyncHealth(streams, time.Now()).State)
		}
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

func TestMemberPermissionIdentityBindingPostgres(t *testing.T) {
	for _, tc := range []struct {
		name, login, permission string
		missing                 bool
		nilID                   bool
		wantSuspended           bool
	}{
		{"removed collaborator renames", "renamed", "none", false, false, true},
		{"old login reassigned to writer", "renamed", "none", false, false, true},
		{"reassigned login cannot regain", "renamed", "none", false, false, true},
		{"same ID unchanged login", "writer", "write", false, false, false},
		{"confirmed ID gone", "", "write", true, false, true},
		{"missing github ID data defect", "writer", "write", false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
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

			if tc.name == "reassigned login cannot regain" {
				_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE github_id=102`)
				require.NoError(t, err)
			}
			if tc.nilID {
				_, err = pool.Exec(ctx, `UPDATE collaborators SET github_id=NULL WHERE user_id=$1`, writer.ID)
				require.NoError(t, err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/repos/acme/app/installation" {
					require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/acme/app/installation":
					fmt.Fprint(w, `{"id":91}`)
				case "/user/102":
					require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
					if tc.missing {
						w.WriteHeader(404)
					} else {
						fmt.Fprintf(w, `{"id":102,"login":%q}`, tc.login)
					}
				case "/repos/acme/app/collaborators/writer/permission":
					if tc.name == "removed collaborator renames" {
						w.WriteHeader(404)
					} else {
						fmt.Fprint(w, `{"permission":"write"}`)
					}
				case "/users/writer":
					w.WriteHeader(404)
				case "/repos/acme/app/collaborators/renamed/permission":
					fmt.Fprintf(w, `{"permission":%q}`, tc.permission)
				case "/repos/acme/app":
					fmt.Fprint(w, `{"id":500,"full_name":"acme/app"}`)
				case "/installation/repositories":
					require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
					fmt.Fprint(w, `{"total_count":1,"repositories":[{"id":500,"full_name":"acme/app"}]}`)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			m := &Members{Pool: pool, Credentials: memberCredentials{}, Minter: &recordingMinter{}}
			err = m.Recheck(ctx)
			if tc.nilID {
				require.ErrorContains(t, err, "github_id")
			} else {
				require.NoError(t, err)
			}
			var suspended bool
			var login string
			require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL,github_login FROM collaborators WHERE user_id=$1`, writer.ID).Scan(&suspended, &login))
			require.Equal(t, tc.wantSuspended, suspended)
			if !tc.missing && !tc.nilID {
				require.Equal(t, tc.login, login)
			}
		})
	}
}

func TestMemberPermissionInstallationRefusalIsRosterAtomicPostgres(t *testing.T) {
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

	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,github_id,github_login,permission) VALUES($1,103,'later','write')`, repo.ID)
	require.NoError(t, err)
	var mu sync.Mutex
	discoveryStatus := 200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/repos/acme/app/installation" {
			require.Equal(t, "Bearer minted-token", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/repos/acme/app/installation":
			w.WriteHeader(discoveryStatus)
			fmt.Fprint(w, `{"id":91}`)
		case "/repos/acme/app":
			fmt.Fprint(w, `{"id":500,"full_name":"acme/app"}`)
		case "/installation/repositories":
			fmt.Fprint(w, `{"total_count":1,"repositories":[{"id":500}]}`)
		case "/user/102":
			fmt.Fprint(w, `{"id":102,"login":"renamed"}`)
		case "/user/103":
			fmt.Fprint(w, `{"id":103,"login":"later"}`)
		case "/repos/acme/app/collaborators/renamed/permission":
			fmt.Fprint(w, `{"permission":"read"}`)
		case "/repos/acme/app/collaborators/later/permission":
			w.WriteHeader(403)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	m := &Members{Pool: pool, Credentials: memberCredentials{}, Minter: &recordingMinter{}}
	for _, status := range []int{200, 401, 403, 404} {
		mu.Lock()
		discoveryStatus = status
		mu.Unlock()
		require.Error(t, m.Recheck(ctx))
		streams, e := (gitHubMainPullStreams{receipts: q}).RequiredStreams(ctx)
		require.NoError(t, e)
		require.Equal(t, "refused", aggregateGitHubSyncHealth(streams, time.Now()).State)
		var suspended bool
		var login string
		require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL,github_login FROM collaborators WHERE user_id=$1`, writer.ID).Scan(&suspended, &login))
		require.False(t, suspended)
		require.Equal(t, "writer", login)
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE user_id=$1`, writer.ID).Scan(&count))
		require.Zero(t, count)
	}
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='github.repository'`)
	require.NoError(t, err)
	require.Error(t, m.Recheck(ctx), "repository lookup failure must not become success")
}
