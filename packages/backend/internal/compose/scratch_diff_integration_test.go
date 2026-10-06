package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// The install router, session authorization, PostgreSQL and repo-host HTTP
// client are real. The remote repository fixture supplies an independent fixed
// patch and records the exact revisions; this isolates the read contract from
// machine execution and avoids treating git's output as its own oracle.
func TestScratchDiffUsesForkRevisionInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	cookie := "scratch-diff-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	const branch = "scratch/ben/try-retry"
	fork, base, head := strings.Repeat("2", 40), strings.Repeat("1", 40), strings.Repeat("3", 40)
	machine, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: branch, Kind: "container", Status: "running", TargetBookmark: branch, EnvironmentSource: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET is_fork=true,source_commit=$2,forked_from_base=$3 WHERE id=$1`, machine.ID, fork, base)
	require.NoError(t, err)
	reads := 0
	unavailable := false
	binary := false
	badBlob := false
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/health":
			w.WriteHeader(200)
		case strings.HasSuffix(r.URL.Path, "/info-refs"):
			line := head + " refs/heads/" + branch + "\n"
			fmt.Fprintf(w, "%04x%s0000", len(line)+4, line)
		case strings.HasSuffix(r.URL.Path, "/diff"):
			reads++
			require.Equal(t, fork, r.URL.Query().Get("from"), "Diff compares against H2, not C1 or moving main")
			require.Equal(t, head, r.URL.Query().Get("to"))
			if unavailable {
				http.Error(w, "unavailable", 503)
				return
			}
			if binary {
				fmt.Fprint(w, `{"file_diffs":[{"path":"asset.bin","change_type":"modified","is_binary":true}]}`)
				return
			}
			fmt.Fprint(w, `{"file_diffs":[{"path":"src/retry.ts","change_type":"added","patch":"@@ -0,0 +1 @@\n+export const backoff = 2\n"}]}`)
		case strings.Contains(r.URL.Path, "/file/"):
			if badBlob {
				fmt.Fprint(w, `{"content":"bad!","encoding":"base64"}`)
				return
			}
			if strings.Contains(r.URL.Path, fork) {
				fmt.Fprint(w, `{"content":"AAE=","encoding":"base64"}`)
			} else {
				fmt.Fprint(w, `{"content":"AAECAw==","encoding":"base64"}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	t.Setenv("SMITHERS_REPO_HOST_URL", remote.URL)
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: remote.URL}, "split-process-repo")
	handler := startSplitProcess(t, Options{Repository: client, ChatHost: unusedChatHost{}})
	call := func(name, session string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("GET", "http://127.0.0.1:4000/api/branches/"+url.PathEscape(name)+"/diff", nil)
		request.RemoteAddr = "127.0.0.1:12345"
		if session != "" {
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	// A credential bound to another branch never reaches even the scratch reader.
	raw := "smithers_" + strings.Repeat("d", 40)
	digest := sha256.Sum256([]byte(raw))
	encoded := hex.EncodeToString(digest[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "other-branch-cli", TokenHash: encoded, TokenLastEight: encoded[len(encoded)-8:], SystemIssued: true, Scopes: "read:repository," + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "cli", Branch: "other-branch"}), ","), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	request := httptest.NewRequest("GET", "http://127.0.0.1:4000/api/branches/"+url.PathEscape(branch)+"/diff", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", "Bearer "+raw)
	refused := httptest.NewRecorder()
	handler.ServeHTTP(refused, request)
	require.Equal(t, 403, refused.Code, refused.Body.String())
	require.Zero(t, reads)
	got := call(branch, cookie)
	require.Equal(t, 200, got.Code, got.Body.String())
	require.JSONEq(t, fmt.Sprintf(`{"files":[{"path":"src/retry.ts","branch":"%s","against":{"kind":"fork","rev":"%s"},"change":"added","hunks":[{"old_start":0,"new_start":1,"lines":[{"op":"+","text":"export const backoff = 2"}]}]}]}`, branch, fork), got.Body.String())
	require.Equal(t, 1, reads)
	require.Equal(t, 401, call(branch, "").Code)
	require.Equal(t, 1, reads, "unauthenticated reads never reach repo-host")
	require.Equal(t, 404, call("smithers/retry", cookie).Code, "missing items keep the accepted-prefix reader response")
	require.Equal(t, 404, call("scratch/ben/missing", cookie).Code)
	binary = true
	got = call(branch, cookie)
	require.Equal(t, 200, got.Code, got.Body.String())
	require.JSONEq(t, fmt.Sprintf(`{"files":[{"path":"asset.bin","branch":"%s","against":{"kind":"fork","rev":"%s"},"change":"modified","binary":{"before_bytes":2,"after_bytes":4},"hunks":[]}]}`, branch, fork), got.Body.String())
	badBlob = true
	require.Equal(t, 503, call(branch, cookie).Code, "malformed binary data never produces a partial diff")
	unavailable = true
	require.Equal(t, 503, call(branch, cookie).Code)
	unchanged, err := q.GetWorkspace(ctx, machine.ID)
	require.NoError(t, err)
	require.Equal(t, "running", unchanged.Status)
	require.Equal(t, machine.ProvisioningGeneration, unchanged.ProvisioningGeneration)
	require.Equal(t, fork, unchanged.SourceCommit)
}
