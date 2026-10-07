package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The remote permission read must not freeze the local account binding or
// resurrect a roster row that a maintainer removed while GitHub was replying.
func TestMemberRecheckConcurrentRosterPostgres(t *testing.T) {
	for _, mode := range []string{"first sign-in", "removed while restoring", "removed and added again"} {
		t.Run(mode, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
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
			var userID *int64
			if mode != "first sign-in" {
				userID = &writer.ID
			}
			_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,102,'writer','write')`, repo.ID, userID)
			require.NoError(t, err)
			if mode == "removed while restoring" {
				_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE github_id=102`)
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, writer.ID)
				require.NoError(t, err)
			}
			// Adding again resolves the same account, as it does after a real login.
			_, err = pool.Exec(ctx, `INSERT INTO oauth_accounts(user_id,provider,provider_user_id) VALUES($1,'workos','102')`, writer.ID)
			require.NoError(t, err)

			entered, resume := make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			var once sync.Once
			release := func() { once.Do(func() { close(resume) }) }
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/keys") {
					fmt.Fprint(w, "[]")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/repos/acme/app/installation":
					fmt.Fprint(w, `{"id":91}`)
				case "/repos/acme/app":
					fmt.Fprint(w, `{"id":500,"full_name":"acme/app"}`)
				case "/installation/repositories":
					fmt.Fprint(w, `{"total_count":1,"repositories":[{"id":500}]}`)
				case "/user/102", "/users/writer":
					fmt.Fprint(w, `{"id":102,"login":"writer"}`)
				case "/repos/acme/app/collaborators/writer/permission":
					permission := "write"
					if calls.Add(1) == 1 {
						close(entered)
						select {
						case <-resume:
						case <-r.Context().Done():
							return
						}
						if mode != "removed while restoring" {
							permission = "read"
						}
					}
					fmt.Fprintf(w, `{"user":{"id":102},"permission":%q}`, permission)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			defer release()
			t.Setenv(envGitHubAppAPIBaseURL, server.URL)
			m := &Members{Pool: pool, Credentials: memberCredentials{}, Minter: &recordingMinter{}}
			done := make(chan error, 1)
			go func() { done <- m.Recheck(ctx) }()
			select {
			case <-entered:
			case err := <-done:
				t.Fatalf("recheck ended before permission barrier: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			asOwner := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"})
			if mode == "first sign-in" {
				require.NoError(t, m.LinkGitHub(ctx, 102, writer.ID, "writer"))
			} else {
				require.NoError(t, m.Remove(asOwner, "writer"))
				if mode == "removed and added again" {
					require.NoError(t, m.Add(asOwner, "writer"))
				}
			}
			if mode != "removed while restoring" {
				_, err = (&InstallSetupSessions{Pool: pool}).ClaimOwner(ctx, writer, "new-member-session", time.Now().Add(time.Hour))
				require.NoError(t, err)
			}
			release()
			require.NoError(t, <-done)

			var prohibited bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT prohibit_login FROM users WHERE id=$1`, writer.ID).Scan(&prohibited))
			require.Equal(t, mode != "removed and added again", prohibited, "an old recheck must neither spare a newly linked account nor undo removal")
			var sessions, events, rows int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id=$1`, writer.ID).Scan(&sessions))
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE user_id=$1 AND kind='collaborator_removed'`, writer.ID).Scan(&events))
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM collaborators WHERE github_id=102`).Scan(&rows))
			require.Equal(t, 1, events, "exactly the committed suspension or removal publishes revocation")
			if mode == "removed and added again" {
				require.Equal(t, 1, sessions, "old row evidence must not revoke the new membership")
			} else {
				require.Zero(t, sessions)
			}
			if mode == "removed while restoring" {
				require.Zero(t, rows)
			} else {
				require.Equal(t, 1, rows)
				var suspended bool
				require.NoError(t, pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE github_id=102`).Scan(&suspended))
				require.Equal(t, mode == "first sign-in", suspended)
			}
		})
	}
}
