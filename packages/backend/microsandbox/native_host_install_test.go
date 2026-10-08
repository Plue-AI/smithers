package microsandbox_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The daemon transport is controlled to withhold its cleanup receipt. HTTP,
// authentication, workspace service and native lifecycle projection are real.
// This is not a real-microVM confinement receipt.
func TestNativeHostCleanupThroughComposedInstall(t *testing.T) {
	for _, row := range []struct {
		name   string
		lost   bool
		frame  []byte
		status int
	}{
		{"confirmed", false, []byte{5, 0, 0, 0, 0, 0}, 0},
		{"lost", true, []byte{5, 0, 0, 0, 0, 0}, 0},
		{"terminated", false, []byte{5, 1, 2, 0}, 143},
	} {
		lost := row.lost
		t.Run(row.name, func(t *testing.T) {
			pool, url := postgresfixture.NewProductDatabase(t)
			q, ctx := db.New(pool), t.Context()
			owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "terminal-owner", LowerUsername: "terminal-owner"})
			require.NoError(t, err)
			repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
			require.NoError(t, err)
			for _, key := range []string{"github.repository", "owner.access"} {
				require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"terminal-owner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))}))
			}
			branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "coding", TargetBookmark: "scratch/terminal-owner/coding", Kind: "container", Status: "running"})
			require.NoError(t, err)
			hash := sha256.Sum256([]byte("terminal-browser"))
			_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			for k, v := range map[string]string{
				"SMITHERS_DATABASE_URL": url, "SMITHERS_BLOB_DATA_DIR": t.TempDir(), "SMITHERS_AUTH_MODE": "selfhost",
				"SMITHERS_AUTH_SESSION_SECRET": "test-secret", "SMITHERS_LFS_SIGNING_SECRET": "test-lfs-signing-secret",
				"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "test-webhook-key", "SMITHERS_REPO_HOST_AUTH_TOKEN": "repo-token",
				"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "push-callback-token", "SMITHERS_SERVER_ADDR": "127.0.0.1:0",
				"SMITHERS_PUBLIC_URL": "http://127.0.0.1:4000", "SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false",
				"SMITHERS_FEATURE_FLAGS_SANDBOXES": "false", "SMITHERS_FEATURE_FLAGS_WORKSPACES": "true",
			} {
				t.Setenv(k, v)
			}
			runtime, begin, entered, release, finished := microsandbox.NativeHostLifecycleForTest(ctx, branch.ID, lost, row.frame)
			defer release()
			serverCtx, cancel := context.WithCancel(ctx)
			ready, stopped := make(chan http.Handler, 1), make(chan error, 1)
			go func() {
				defer close(stopped)
				stopped <- compose.StartWithOptions(serverCtx, nil, io.Discard, io.Discard, compose.Options{Workspace: runtime, Duties: compose.DutiesHTTP, FlowHostProductAPIURL: "http://127.0.0.1:4000"}, func(h http.Handler) { ready <- h })
			}()
			defer func() {
				cancel()
				select {
				case err := <-stopped:
					require.NoError(t, err)
				case <-time.After(10 * time.Second):
					t.Error("install did not stop")
				}
			}()
			var router http.Handler
			select {
			case router = <-ready:
			case err := <-stopped:
				t.Fatalf("start: %v", err)
			case <-time.After(30 * time.Second):
				t.Fatal("install did not start")
			}
			begin()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("cleanup not requested")
			}
			read := func() string {
				req := httptest.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:4000/api/repos/terminal-owner/app/workspaces/%s/services", branch.ID), nil)
				req.RemoteAddr = "127.0.0.1:49100"
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "terminal-browser"})
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, 200, out.Code, out.Body.String())
				var rows []struct {
					State string `json:"state"`
				}
				require.NoError(t, json.Unmarshal(out.Body.Bytes(), &rows), out.Body.String())
				require.Len(t, rows, 1)
				observations, err := runtime.(workspaceapi.WorkspaceServiceCatalog).ListServices(ctx, branch.ID)
				require.NoError(t, err)
				require.Len(t, observations, 1)
				require.Equal(t, "literal\x00SMITHERS-EXIT 42\x00", observations[0].Stderr)
				if rows[0].State != "running" {
					require.Equal(t, row.status, observations[0].ExitCode, "status comes from the daemon, never diagnostic text")
				}
				return rows[0].State
			}
			require.Equal(t, "running", read())
			release()
			<-finished
			expected := "stopped"
			if lost || row.status != 0 {
				expected = "failed"
			}
			require.Equal(t, expected, read())
		})
	}
}
