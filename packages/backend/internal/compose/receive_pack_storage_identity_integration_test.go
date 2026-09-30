package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A push is authorized for a repository ID resolved from owner/name, and
// repo-host selects native storage by owner/name when it takes the
// repository lock. This pauses a real authenticated Git push between the two,
// replaces the repository through the canonical service, and checks where
// the pack went: native refs and objects of every storage the name has
// pointed at, and the repository IDs the push callback reported (#2846).
func TestReceivePackStorageIdentityAcrossReplacementPostgres(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built native repository library")
	}
	for _, change := range []string{"unchanged", "recreate", "transfer"} {
		t.Run(change, func(t *testing.T) {
			ctx := context.Background()
			pool, _ := postgresfixture.NewProductDatabase(t)
			q := db.New(pool)
			alice, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
			require.NoError(t, err)
			bob, err := q.CreateUser(ctx, db.CreateUserParams{Username: "bob", LowerUsername: "bob", DisplayName: "Bob"})
			require.NoError(t, err)

			// The real callback handler over the real SQL queries, recording
			// the repository ID each delivery named.
			const callbackToken = "storage-identity-callback"
			var callbackMu sync.Mutex
			var callbackIDs []int64
			hook := &routes.InternalPushHookHandler{RepoResolver: q, Events: q}
			callback := httptest.NewServer(middleware.RequireSharedBearerToken(callbackToken)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, readErr := io.ReadAll(r.Body)
				require.NoError(t, readErr)
				var payload struct {
					RepositoryID int64 `json:"repository_id"`
				}
				require.NoError(t, json.Unmarshal(body, &payload))
				callbackMu.Lock()
				callbackIDs = append(callbackIDs, payload.RepositoryID)
				callbackMu.Unlock()
				r.Body = io.NopCloser(bytes.NewReader(body))
				hook.PostPushEvent(w, r)
			})))
			t.Cleanup(callback.Close)

			config := repohostserver.Config{
				StoragePath: t.TempDir(), AuthToken: "storage-identity-repo",
				PushHookCallbackURL: callback.URL, PushHookCallbackToken: callbackToken,
				FFILibraryPath: ffi,
			}
			host, err := repohostserver.New(config)
			require.NoError(t, err)
			t.Cleanup(func() {
				shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				require.NoError(t, host.Shutdown(shutdownCtx))
			})
			// The deterministic pause: a receive-pack stops in front of
			// repo-host, before it takes the repository lock.
			arrived := make(chan struct{})
			release := make(chan struct{})
			var pauseOnce sync.Once
			hostHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/git/receive-pack") {
					pauseOnce.Do(func() {
						close(arrived)
						<-release
					})
				}
				host.Handler().ServeHTTP(w, r)
			}))
			t.Cleanup(hostHTTP.Close)
			client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: hostHTTP.URL}, config.AuthToken)
			repos := services.NewProductRepoServiceWithPool(q, client, pool)
			original, err := repos.CreateRepo(ctx, &alice, "demo", "", false, "main", true)
			require.NoError(t, err)

			git := &routes.GitSmartHandler{
				Service: services.NewGitHTTPProxyService(q, services.NewSSHAuthorizationService(q), client),
				Metrics: routes.NewSmithersMetrics(),
			}
			router := chi.NewRouter()
			router.Get("/{owner}/{repo}/info/refs", git.InfoRefs)
			router.Post("/{owner}/{repo}/git-upload-pack", git.UploadPack)
			router.Post("/{owner}/{repo}/git-receive-pack", git.ReceivePack)
			api := httptest.NewServer(router)
			t.Cleanup(api.Close)
			token := storageIdentityToken(t, q, alice.ID)

			clientDir := filepath.Join(t.TempDir(), "client")
			storageIdentityGit(t, "", "clone", "--quiet", api.URL+"/alice/demo.git", clientDir, "-c", "http.extraHeader=Authorization: Bearer "+token)
			require.NoError(t, os.WriteFile(filepath.Join(clientDir, "pushed.txt"), []byte("authorized for the original\n"), 0o644))
			// A root commit on a new bookmark: the pack is complete on its own
			// and the ref update expects nothing, so no repository state other
			// than identity can refuse it.
			storageIdentityGit(t, clientDir, "checkout", "--quiet", "--orphan", "feature")
			storageIdentityGit(t, clientDir, "add", "pushed.txt")
			storageIdentityGit(t, clientDir, "-c", "user.name=Alice", "-c", "user.email=alice@example.test", "commit", "--quiet", "-m", "pushed")
			sha := storageIdentityGit(t, clientDir, "rev-parse", "HEAD")

			type pushResult struct {
				output string
				err    error
			}
			pushed := make(chan pushResult, 1)
			go func() {
				command := exec.Command("git", "-c", "http.extraHeader=Authorization: Bearer "+token, "push", "origin", "HEAD:refs/heads/feature")
				command.Dir = clientDir
				command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
				out, pushErr := command.CombinedOutput()
				pushed <- pushResult{output: string(out), err: pushErr}
			}()
			select {
			case <-arrived:
			case result := <-pushed:
				t.Fatalf("push finished before reaching repo-host: %v: %s", result.err, result.output)
			case <-time.After(30 * time.Second):
				t.Fatal("push never reached repo-host")
			}

			// Replace the repository at alice/demo while the authorized push waits.
			var replacement db.Repository
			switch change {
			case "recreate":
				require.NoError(t, repos.DeleteRepo(ctx, &alice, "alice", "demo"))
				replacement, err = repos.CreateRepo(ctx, &alice, "demo", "", false, "main", true)
				require.NoError(t, err)
			case "transfer":
				request, transferErr := repos.TransferRepo(ctx, &alice, "alice", "demo", bob.Username)
				require.NoError(t, transferErr)
				moved, acceptErr := repos.AcceptRepoTransfer(ctx, &bob, request.PendingTransfer.ID)
				require.NoError(t, acceptErr)
				require.Equal(t, original.ID, moved.ID)
				replacement, err = repos.CreateRepo(ctx, &alice, "demo", "", false, "main", true)
				require.NoError(t, err)
			}
			close(release)
			var result pushResult
			select {
			case result = <-pushed:
			case <-time.After(60 * time.Second):
				t.Fatal("push did not finish after the pause")
			}

			var events int
			var eventRepositoryID int64
			readEvents := func() {
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*), coalesce(max(repository_id), 0)
					FROM repo_push_events WHERE commit_sha = $1`, sha).Scan(&events, &eventRepositoryID))
			}
			delivered := func() []int64 {
				callbackMu.Lock()
				defer callbackMu.Unlock()
				return append([]int64(nil), callbackIDs...)
			}

			if change == "unchanged" {
				require.NoError(t, result.err, result.output)
				require.True(t, storageIdentityHas(t, config.GitBackendPath("alice", "demo"), sha))
				require.Eventually(t, func() bool { readEvents(); return events == 1 }, 10*time.Second, 50*time.Millisecond)
				require.Equal(t, original.ID, eventRepositoryID)
				require.Equal(t, []int64{original.ID}, delivered())
				return
			}
			require.NotEqual(t, original.ID, replacement.ID)
			// The pack was authorized for the original repository. It must
			// not land in the storage now at alice/demo, and the original's
			// storage never received it either.
			require.Error(t, result.err, "a push authorized for the replaced repository succeeded: %s", result.output)
			require.Contains(t, result.output, "409", "the refusal is a retryable conflict")
			require.False(t, storageIdentityHas(t, config.GitBackendPath("alice", "demo"), sha),
				"the pack authorized for repository %d landed in replacement %d", original.ID, replacement.ID)
			if change == "transfer" {
				require.False(t, storageIdentityHas(t, config.GitBackendPath("bob", "demo"), sha))
			}
			// A refused push never reached git, so it has no callback to wait for.
			readEvents()
			require.Zero(t, events, "a refused push recorded an event")
			require.Empty(t, delivered(), "a refused push reported a callback")
		})
	}
}

// storageIdentityHas reports whether native storage holds commit sha, as an
// object or on any ref.
func storageIdentityHas(t *testing.T, gitDir, sha string) bool {
	t.Helper()
	if _, err := os.Stat(gitDir); err != nil {
		return false
	}
	object := exec.Command("git", "--git-dir", gitDir, "cat-file", "-e", sha+"^{commit}")
	if object.Run() == nil {
		return true
	}
	refs, err := exec.Command("git", "--git-dir", gitDir, "for-each-ref", "--format=%(objectname)").Output()
	require.NoError(t, err)
	return strings.Contains(string(refs), sha)
}

func storageIdentityToken(t *testing.T, q *db.Queries, userID int64) string {
	t.Helper()
	sum := sha256.Sum256([]byte("storage-identity-token"))
	token := "smithers_" + hex.EncodeToString(sum[:])[:40]
	hash := sha256.Sum256([]byte(token))
	digest := hex.EncodeToString(hash[:])
	_, err := q.CreateAccessToken(context.Background(), db.CreateAccessTokenParams{
		UserID: userID, Name: "push", TokenHash: digest, TokenLastEight: digest[len(digest)-8:],
		Scopes: "write:repository,read:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	require.NoError(t, err)
	return token
}

func storageIdentityGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := command.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}
