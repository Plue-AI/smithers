package compose

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"io/fs"
)

type restoreVersionFixture struct {
	calls   int
	corrupt bool
}

func (f *restoreVersionFixture) GetFileAtCommit(_ context.Context, owner, repo, commit, path string) (repohost.FileContent, error) {
	f.calls++
	if owner != "presence-owner" || repo != "app" || commit != strings.Repeat("a", 40) || (path != "a/src/a.ts" && path != "b/src/a.ts") {
		return repohost.FileContent{}, fmt.Errorf("unexpected version selection")
	}
	text := "before\n"
	if path == "b/src/a.ts" {
		text = "after\n"
	}
	if f.corrupt {
		text = "corrupt"
	}
	return repohost.FileContent{Path: path, Content: text}, nil
}

type restoreRuntimeFixture struct {
	*writeReplyRuntime
	branch, bookmark string
	files            map[string][]byte
	writes           int
	actor            string
}

func (f *restoreRuntimeFixture) ReadFile(_ context.Context, id, path string) ([]byte, error) {
	if bytes, ok := f.files[path]; ok {
		return append([]byte{}, bytes...), nil
	}
	if path != ".smithers/workspace.json" && strings.HasPrefix(path, "src/") {
		return nil, fs.ErrNotExist
	}
	return json.Marshal(map[string]any{"version": 1, "workspace_id": id, "repository_id": f.repo, "clone_url": f.clone, "source_bookmark": f.bookmark, "source_revision": strings.Repeat("a", 40), "initialized_at": "2026-10-06T12:00:00Z"})
}

// The production service selects the admitted working-copy reader, including
// when the fixture embeds a runtime with its own daemon reader.
func (f *restoreRuntimeFixture) ReadWorkingCopyFile(ctx context.Context, id, path string) ([]byte, error) {
	return f.ReadFile(ctx, id, path)
}
func (f *restoreRuntimeFixture) CompareWriteFiles(ctx context.Context, id string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	if id != f.branch || len(changes) != 1 {
		return nil, fmt.Errorf("restore crossed branch or wrote multiple files")
	}
	change := changes[0]
	current := "absent"
	if b, ok := f.files[change.Path]; ok {
		current = fmt.Sprintf("%x", sha256.Sum256(b))
	}
	if current != change.BaseDigest {
		return nil, &workspaceapi.StaleFileError{Path: change.Path, CurrentDigest: current}
	}
	f.writes++
	op, _ := workspaceapi.OperationFromContext(ctx)
	f.actor = op.PrincipalID
	if change.Content == nil {
		delete(f.files, change.Path)
	} else {
		f.files[change.Path] = append([]byte{}, change.Content...)
	}
	digest := "absent"
	if change.Content != nil {
		digest = fmt.Sprintf("%x", sha256.Sum256(change.Content))
	}
	return &workspaceapi.FileWriteResult{Paths: []workspaceapi.FileMutationResult{{Path: change.Path, Digest: digest}}, Raced: []workspaceapi.FileRace{}}, nil
}

func TestFileRestoreCommandBoundary(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	ctx := t.Context()
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	defer runtime.Close()
	provider := &restoreRuntimeFixture{writeReplyRuntime: &writeReplyRuntime{Runtime: runtime, repo: f.row.RepositoryID, clone: "http://fixture/presence-owner/app.git"}, branch: f.row.ID, bookmark: f.row.TargetBookmark, files: map[string][]byte{"src/a.ts": []byte("after\n"), "src/b.ts": []byte("untouched\n")}}
	versions := &restoreVersionFixture{}
	s := services.NewWorkspaceService(q, services.WithWorkspaceInstallAuthorization(q), services.WithWorkspaceRuntime(provider), services.WithWorkspaceTransactions(f.pool), services.WithWorkspaceGitBaseURL("http://fixture"), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)), services.WithWorkspaceBurstVersions(f.pool, versions))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{f.origin}
	cfg.Server.PublicURL = f.origin
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.WorkspaceHandler{Service: s})
	seed := func(change, post string) {
		t.Helper()
		tx, err := f.pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		fact, err := jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(f.row.RepositoryID), PrincipalID: "branch:" + f.row.ID}, uuid.NewString(), "branch.burst", "completed", json.RawMessage(`{"actor":{"kind":"person","id":"`+fmt.Sprint(f.user.ID)+`","via":"ssh"},"versions":"`+strings.Repeat("a", 40)+`"}`))
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `INSERT INTO burst_files(event_id,path,change,before_blob,post_digest) VALUES($1,'src/a.ts',$2,'90be1f3056c4f471f977a28497b8d4b392c55a02',NULLIF($3,''))`, fact.EventID, change, post)
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
	}
	const post = "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919"
	seed("modified", post)
	afterBlob := fmt.Sprintf("%x", sha1.Sum([]byte("blob 6\x00after\n")))
	_, err = f.pool.Exec(ctx, `UPDATE burst_files SET after_blob=$1 WHERE path='src/a.ts' AND change='modified'`, afterBlob)
	require.NoError(t, err)

	read := func(selector string, status int) {
		t.Helper()
		req := httptest.NewRequest("GET", f.origin+"/api/branches/"+f.row.ID+"/files/src/a.ts"+selector, nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
		req.RemoteAddr = "127.0.0.1:61000"
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, status, rec.Code, rec.Body.String())
		if status == 200 {
			var result map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
			require.Equal(t, post, result["digest"])
			require.Equal(t, map[string]any{"kind": "text", "text": "after\n"}, result["content"])
		}
	}
	read("", 200)
	read("?digest="+post, 200)
	read("?digest="+strings.Repeat("b", 64), 409)
	compareReq := httptest.NewRequest("GET", f.origin+"/api/branches/"+f.row.ID+"/files/src/a.ts?compare="+strings.Repeat("a", 40), nil)
	compareReq.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
	compareReq.RemoteAddr = "127.0.0.1:61000"
	compareRec := httptest.NewRecorder()
	router.ServeHTTP(compareRec, compareReq)
	require.Equal(t, 200, compareRec.Code, compareRec.Body.String())
	require.JSONEq(t, `{"text":"before\n"}`, compareRec.Body.String())

	require.Zero(t, provider.writes)

	var responseBody string
	call := func(path, body, cookie string, bearer ...string) int {
		t.Helper()
		req := httptest.NewRequest("POST", f.origin+"/api/branches/"+f.row.ID+"/files/"+path, strings.NewReader(body))
		req.Header.Set("Origin", f.origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "restore-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "restore-csrf"})
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if len(bearer) > 0 {
			req.Header.Set("Authorization", "Bearer "+bearer[0])
		}
		req.RemoteAddr = "127.0.0.1:61000"
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		responseBody = rec.Body.String()
		t.Logf("restore HTTP %d %s", rec.Code, rec.Body.String())
		return rec.Code
	}
	body := `{"action":"restore","version":"` + strings.Repeat("a", 40) + `","base_digest":"` + post + `"}`
	require.Equal(t, 401, call("src/a.ts", body, ""))
	require.Zero(t, provider.writes)
	require.Equal(t, 400, call("src/a.ts", strings.TrimSuffix(body, "}")+`,"actor":"spoofed"}`, f.cookie))
	require.Zero(t, provider.writes)
	require.Equal(t, 200, call("src/a.ts", body, f.cookie))
	require.Equal(t, []byte("before\n"), provider.files["src/a.ts"])
	require.Equal(t, []byte("untouched\n"), provider.files["src/b.ts"])
	require.Equal(t, fmt.Sprint(f.user.ID), provider.actor)
	require.Equal(t, 1, provider.writes)
	read("?digest="+post, 200)
	require.Equal(t, 409, call("src/a.ts", body, f.cookie))
	require.Equal(t, 1, provider.writes)
	versions.corrupt = true
	require.Equal(t, 503, call("src/a.ts", body, f.cookie))
	require.Equal(t, 1, provider.writes)
	versions.corrupt = false
	seed("deleted", "")
	delete(provider.files, "src/a.ts")
	goneReq := httptest.NewRequest("GET", f.origin+"/api/branches/"+f.row.ID+"/files/src/a.ts?digest=absent", nil)
	goneReq.AddCookie(&http.Cookie{Name: "session", Value: f.cookie})
	goneReq.RemoteAddr = "127.0.0.1:61000"
	goneRec := httptest.NewRecorder()
	router.ServeHTTP(goneRec, goneReq)
	require.Equal(t, 200, goneRec.Code, goneRec.Body.String())
	var gone map[string]any
	require.NoError(t, json.Unmarshal(goneRec.Body.Bytes(), &gone))
	require.Equal(t, "deleted", gone["gone"].(map[string]any)["kind"])
	require.Equal(t, "ssh", gone["last_writer"].(map[string]any)["via"])

	deleted := `{"action":"restore-deleted","version":"` + strings.Repeat("a", 40) + `","base_digest":"absent"}`
	require.Equal(t, 200, call("src/a.ts", deleted, f.cookie))
	require.Equal(t, []byte("before\n"), provider.files["src/a.ts"])
	require.Equal(t, 2, provider.writes)
	require.Equal(t, 409, call("src/a.ts", deleted, f.cookie))

	require.Equal(t, 2, provider.writes)
	seed("renamed", "")
	_, err = f.pool.Exec(ctx, `UPDATE burst_files SET renamed_to='src/deliver.ts' WHERE path='src/a.ts' AND change='renamed'`)
	require.NoError(t, err)
	delete(provider.files, "src/a.ts")
	goneRec = httptest.NewRecorder()
	router.ServeHTTP(goneRec, goneReq)
	require.Equal(t, 200, goneRec.Code, goneRec.Body.String())
	require.NoError(t, json.Unmarshal(goneRec.Body.Bytes(), &gone))
	require.Equal(t, "renamed", gone["gone"].(map[string]any)["kind"])
	require.Equal(t, "src/deliver.ts", gone["gone"].(map[string]any)["to"])
	require.Equal(t, 2, provider.writes)

	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, 409, call("src/a.ts", deleted, f.cookie))
	require.Equal(t, 2, provider.writes)
	var sleepState string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, f.row.ID).Scan(&sleepState))
	require.Equal(t, "suspended", sleepState)
	// The independent member-access case operates on an awake branch.
	// Its write share requires the fixture's coding host to be retired.
	_, err = f.pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE workspace_id=$1 AND catalog_key='coding'`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	// presenceInstall supplies a running coding-host binding. A write share
	// cannot coexist with that host's owner credential; retire the fixture
	// binding before exercising the independent member Restore boundary.
	_, err = f.pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE workspace_id=$1 AND catalog_key='coding'`, f.row.ID)
	require.NoError(t, err)
	// A member removed after opening a version cannot restore it.
	// The presence fixture seeds a private coding host. End that host before
	// granting shared write access, as the installed database requires.
	_, err = f.pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE workspace_id=$1 AND catalog_key='coding'`, f.row.ID)
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "w6-member", LowerUsername: "w6-member"})
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, f.row.RepositoryID, member.ID)
	require.NoError(t, err)
	// This restore fixture has no coding host; retire the shared presence
	// fixture's binding before granting write access to another member.
	_, err = f.pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE workspace_id=$1 AND catalog_key='coding'`, f.row.ID)
	require.NoError(t, err)
	// Retire the fixture's coding host before the independent member case.
	// This case grants sharing only after private execution has ended.
	_, err = f.pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='retired' WHERE workspace_id=$1 AND catalog_key='coding'`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'write')`, f.row.ID, f.user.ID, member.ID)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("w6-member-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: member.ID, Username: member.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	for i, credential := range []struct{ name, scopes string }{
		{"external actor", "write:repository,via:codex"},
		{"run", "write:repository"},
		{"machine", "write:repository,workspace:" + f.row.ID},
		{"insufficient scope", "read:repository,via:codex"},
	} {
		t.Run(credential.name, func(t *testing.T) {
			raw := fmt.Sprintf("smithers_%040x", 7100+i)
			digest := sha256.Sum256([]byte(raw))
			hash := hex.EncodeToString(digest[:])
			_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: member.ID, Name: credential.name, TokenHash: hash, TokenLastEight: hash[56:], Scopes: credential.scopes, SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
			require.NoError(t, err)
			before := versions.calls
			for _, payload := range []string{body, deleted} {
				require.Equal(t, 403, call("src/a.ts", payload, "", raw))
				var refusal map[string]any
				require.NoError(t, json.Unmarshal([]byte(responseBody), &refusal))
				require.Equal(t, "permission", refusal["code"], responseBody)
				require.Equal(t, "permission", refusal["class"], responseBody)
				require.Equal(t, before, versions.calls)
				require.Equal(t, 2, provider.writes)
			}
		})
	}
	// An active member with a write share uses the same concrete command as
	// the owner. Previously the outer route fell into owner-only admission.
	delete(provider.files, "src/a.ts")
	seed("deleted", "")
	require.Equal(t, 200, call("src/a.ts", deleted, "w6-member-cookie"))
	require.Equal(t, fmt.Sprint(member.ID), provider.actor)
	require.Equal(t, 3, provider.writes)
	_, err = f.pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, member.ID)
	require.NoError(t, err)
	beforeCalls := versions.calls
	status := call("src/a.ts", deleted, "w6-member-cookie")
	require.Contains(t, []int{401, 403}, status)
	require.Equal(t, beforeCalls, versions.calls)
	require.Equal(t, 3, provider.writes)
	require.Empty(t, runtime.WorkspaceIDs(), "test-only provider did not start a host workspace")
	t.Run("restore decision binds the complete request", func(t *testing.T) {
		for _, field := range []string{"path", "version", "base", "deleted", "branch", "actor"} {
			t.Run(field, func(t *testing.T) {
				decisions := 0
				ctx := services.WithAuthorizationObserver(middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &f.user, SessionHash: fmt.Sprintf("%x", sha256.Sum256([]byte(f.cookie)))}), func(command string) { decisions++ })
				subject, command, err := services.InstallFileRestoreSubject(ctx, q, f.row.RepositoryID, f.row.ID, "src/a.ts", strings.Repeat("a", 40), "absent", true)
				require.NoError(t, err)
				decision, err := services.Authorize(ctx, q, command, subject)
				require.NoError(t, err)
				bound := services.WithInstallAuthorization(ctx, command, decision, subject)
				branch, path, version, base, deleted, actor := f.row.ID, "src/a.ts", strings.Repeat("a", 40), "absent", true, f.user.ID
				switch field {
				case "path":
					path = "src/b.ts"
				case "version":
					version = strings.Repeat("b", 40)
				case "base":
					base = strings.Repeat("b", 64)
				case "deleted":
					deleted = false
				case "branch":
					branch = "main"
				case "actor":
					actor = member.ID
				}
				beforeReads, beforeWrites := versions.calls, provider.writes
				_, err = s.RestoreBranchFile(bound, branch, f.row.RepositoryID, actor, path, version, base, deleted)
				var denied *services.AccessError
				require.ErrorAs(t, err, &denied)
				require.Equal(t, 403, denied.Status)
				require.Equal(t, 1, decisions)
				require.Equal(t, beforeReads, versions.calls)
				require.Equal(t, beforeWrites, provider.writes)
			})
		}
	})

}
