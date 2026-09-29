package compose

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// This crosses the same durable boundary as a split API/repo-host deployment:
// Git smart HTTP, native repository storage, a disk outbox, and PostgreSQL.
// The proxy only supplies headers that the authenticated API normally supplies.
func TestPushOutboxRepositoryIdentityAfterRestartPostgres(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built native repository library")
	}
	for _, tc := range []struct {
		name   string
		change string
	}{
		{"unchanged", ""},
		{"deleted", "delete"},
		{"recreated_namespace", "recreate"},
		{"transferred", "transfer"},
		{"legacy_without_identity", "legacy"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			pool, _ := postgresfixture.NewProductDatabase(t)
			q := db.New(pool)
			owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
			require.NoError(t, err)
			var destination db.User
			if tc.change == "transfer" {
				destination, err = q.CreateUser(ctx, db.CreateUserParams{Username: "bob", LowerUsername: "bob", DisplayName: "Bob"})
				require.NoError(t, err)
			}

			const token = "push-identity-callback"
			var failCallback atomic.Bool
			failCallback.Store(true)
			var attempts atomic.Int32
			hook := &routes.InternalPushHookHandler{RepoResolver: q, Events: q}
			callback := httptest.NewServer(middleware.RequireSharedBearerToken(token)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempts.Add(1)
				if failCallback.Load() {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				hook.PostPushEvent(w, r)
			})))
			t.Cleanup(callback.Close)

			storage := t.TempDir()
			config := repohostserver.Config{
				StoragePath: storage, AuthToken: "push-identity-repo",
				PushHookCallbackURL: callback.URL, PushHookCallbackToken: token,
				FFILibraryPath: ffi,
			}
			host, err := repohostserver.New(config)
			require.NoError(t, err)
			t.Cleanup(func() {
				if host != nil {
					shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					require.NoError(t, host.Shutdown(shutdownCtx))
				}
			})
			hostHTTP := httptest.NewServer(host.Handler())
			t.Cleanup(hostHTTP.Close)
			client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: hostHTTP.URL}, config.AuthToken)
			repos := services.NewProductRepoServiceWithPool(q, client, pool)
			original, err := repos.CreateRepo(ctx, &owner, "demo", "", true, "main", false)
			require.NoError(t, err)

			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/info/refs"):
					r.URL.Path = "/repos/alice/demo/git/info-refs"
				case strings.HasSuffix(r.URL.Path, "/git-receive-pack"):
					r.URL.Path = "/repos/alice/demo/git/receive-pack"
				default:
					http.NotFound(w, r)
					return
				}
				r.RequestURI = ""
				r.Header.Set("Authorization", "Bearer "+config.AuthToken)
				if tc.change != "legacy" {
					r.Header.Set(repohost.RepositoryIDHeader, strconv.FormatInt(original.ID, 10))
				}
				r.Header.Set("X-Smithers-Pusher-Id", strconv.FormatInt(owner.ID, 10))
				r.Header.Set("X-Smithers-Pusher-Login", owner.Username)
				r.Header.Set(repohost.PusherCredentialHeader, string(middleware.CredentialPerson))
				host.Handler().ServeHTTP(w, r)
			}))
			t.Cleanup(proxy.Close)
			clientDir := filepath.Join(t.TempDir(), "client")
			pushIdentityGit(t, "init", "--quiet", "--initial-branch=main", clientDir)
			require.NoError(t, os.WriteFile(filepath.Join(clientDir, "a.txt"), []byte("a\n"), 0o644))
			pushIdentityGit(t, "-C", clientDir, "add", "a.txt")
			pushIdentityGit(t, "-C", clientDir, "-c", "user.name=Alice", "-c", "user.email=alice@example.test", "commit", "--quiet", "-m", "first")
			sha := pushIdentityGit(t, "-C", clientDir, "rev-parse", "HEAD")
			pushIdentityGit(t, "-C", clientDir, "push", "--quiet", proxy.URL+"/demo.git", "HEAD:refs/heads/main")
			require.EqualValues(t, 1, attempts.Load(), "the first delivery must reach the failed callback")
			entries := pushIdentityOutboxFiles(t, storage)
			require.Len(t, entries, 1, "an acknowledged Git push must retain its failed callback")
			var durable struct {
				Payload struct {
					DeliveryID   string `json:"delivery_id"`
					RepositoryID int64  `json:"repository_id"`
					Owner        string `json:"owner"`
					Repo         string `json:"repo"`
					CommitSHA    string `json:"commit_sha"`
					PusherID     int64  `json:"pusher_id"`
					Credential   string `json:"pusher_credential"`
				} `json:"payload"`
			}
			bytes, err := os.ReadFile(entries[0])
			require.NoError(t, err)
			require.NoError(t, json.Unmarshal(bytes, &durable))
			require.NotEmpty(t, durable.Payload.DeliveryID)
			if tc.change == "legacy" {
				require.Zero(t, durable.Payload.RepositoryID)
			} else {
				require.Equal(t, original.ID, durable.Payload.RepositoryID)
			}
			require.Equal(t, "alice", durable.Payload.Owner)
			require.Equal(t, "demo", durable.Payload.Repo)
			require.Equal(t, sha, durable.Payload.CommitSHA)
			require.Equal(t, owner.ID, durable.Payload.PusherID)
			require.Equal(t, "person", durable.Payload.Credential)

			switch tc.change {
			case "delete", "recreate":
				require.NoError(t, repos.DeleteRepo(ctx, &owner, "alice", "demo"))
				if tc.change == "recreate" {
					replacement, err := repos.CreateRepo(ctx, &owner, "demo", "", true, "main", false)
					require.NoError(t, err)
					require.NotEqual(t, original.ID, replacement.ID)
				}
			case "transfer":
				moved, err := repos.TransferRepo(ctx, &owner, "alice", "demo", destination.Username)
				require.NoError(t, err)
				require.Equal(t, original.ID, moved.ID)
			}

			shutdownCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			require.NoError(t, host.Shutdown(shutdownCtx))
			cancel()
			host = nil
			hostHTTP.Close()
			failCallback.Store(false)
			// The persisted retry timestamp is intentionally left untouched.
			time.Sleep(5100 * time.Millisecond)
			restarted, err := repohostserver.New(config)
			require.NoError(t, err)
			host = restarted
			require.Eventually(t, func() bool { return attempts.Load() >= 2 }, 10*time.Second, 50*time.Millisecond,
				"restart did not replay the persisted delivery")
			if tc.change == "legacy" {
				require.Equal(t, entries, pushIdentityOutboxFiles(t, storage), "ambiguous legacy delivery must remain for reconciliation")
			} else {
				require.Empty(t, pushIdentityOutboxFiles(t, storage), "settled delivery remained on disk")
			}
			var count int
			var actualID int64
			var eventOwner, eventRepo string
			err = pool.QueryRow(ctx, `SELECT count(*), coalesce(max(repository_id), 0), coalesce(max(owner), ''), coalesce(max(repo), '')
				FROM repo_push_events WHERE delivery_id = $1`, durable.Payload.DeliveryID).Scan(&count, &actualID, &eventOwner, &eventRepo)
			require.NoError(t, err)
			if tc.change == "delete" || tc.change == "recreate" || tc.change == "legacy" {
				require.Zero(t, count, "a deleted repository's push reached another identity")
			} else {
				require.Equal(t, 1, count)
				require.Equal(t, original.ID, actualID)
				if tc.change == "transfer" {
					require.Equal(t, "bob", eventOwner)
				} else {
					require.Equal(t, "alice", eventOwner)
				}
				require.Equal(t, "demo", eventRepo)
			}
		})
	}
}

func pushIdentityGit(t *testing.T, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := command.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

func pushIdentityOutboxFiles(t *testing.T, storage string) []string {
	t.Helper()
	root := filepath.Join(storage, ".push-hook-outbox@")
	var paths []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(path, ".json") {
			paths = append(paths, path)
		}
		return nil
	})
	require.NoError(t, err)
	return paths
}
