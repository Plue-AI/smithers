package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Only the unavailable guest is faked. HTTP, owner auth, repository authority,
// workspace service and PostgreSQL use the single-owner install composition.
// This does not qualify the guest's atomicity or real-machine race retention.
type writeReplyRuntime struct {
	*process.Runtime
	repo  int64
	clone string
}

func (r *writeReplyRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}
func (r *writeReplyRuntime) ListFiles(_ context.Context, _, path string) ([]workspaceapi.FileEntry, error) {
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
}
func (r *writeReplyRuntime) ReadFile(_ context.Context, id, _ string) ([]byte, error) {
	return json.Marshal(map[string]any{"version": 1, "workspace_id": id, "repository_id": r.repo, "clone_url": r.clone, "source_bookmark": "smithers/digest", "source_revision": strings.Repeat("a", 40), "initialized_at": time.Now().UTC()})
}
func (r *writeReplyRuntime) ExecuteCommand(_ context.Context, _ string, c workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(c.Args) >= 4 && c.Args[0] == "git" && c.Args[1] == "remote" {
		return workspaceapi.CommandResult{Stdout: r.clone + "\n"}, nil
	}
	return workspaceapi.CommandResult{}, nil
}
func (r *writeReplyRuntime) CompareWriteFiles(_ context.Context, _ string, changes []workspaceapi.FileMutation) (*workspaceapi.FileWriteResult, error) {
	for _, change := range changes {
		if change.BaseDigest != "absent" {
			return nil, &workspaceapi.StaleFileError{Path: change.Path, CurrentDigest: "absent"}
		}
	}
	result := &workspaceapi.FileWriteResult{Raced: []workspaceapi.FileRace{}}
	for _, change := range changes {
		digest := "absent"
		if change.Content != nil {
			digest = fmt.Sprintf("%x", sha256.Sum256(change.Content))
		}
		result.Paths = append(result.Paths, workspaceapi.FileMutationResult{Path: change.Path, Digest: digest})
		if change.Path == "raced" {
			result.Raced = append(result.Raced, workspaceapi.FileRace{Path: change.Path, Version: "retained-outside"})
		}
	}
	return result, nil
}

func TestWorkspaceWriteReplyInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "digestowner", LowerUsername: "digestowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"digestowner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for key, value := range map[string]string{"setup.step.source": `{"id":"source","status":"done"}`, "setup.source.repository": `"digestowner/demo"`, "github.repository": binding, "owner.access": binding} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	const cookie = "digest-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	var id string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,kind,status,vm_id,target_bookmark) VALUES($1,$2,'digest','container','running','fixture','smithers/digest') RETURNING id`, repo.ID, owner.ID).Scan(&id))
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	provider := &writeReplyRuntime{Runtime: runtime, repo: repo.ID, clone: origin + "/digestowner/demo.git"}
	server.Config.Handler = startSplitProcess(t, Options{FlowHostProductAPIURL: origin, Workspace: provider, ChatHost: unusedChatHost{}})
	server.Start()
	defer server.Close()

	digest := fmt.Sprintf("%x", sha256.Sum256([]byte("new")))
	for _, item := range []struct {
		query, request, reply string
		status                int
	}{
		{"?path=a", `{"content":"new","base_digest":"absent"}`, `{"paths":[{"path":"a","post_digest":"` + digest + `"}],"raced":[]}`, 200},
		{"", `{"changes":[{"path":"a","content":"new","base_digest":"absent"},{"path":"removed","content":null,"base_digest":"absent"}]}`, `{"paths":[{"path":"a","post_digest":"` + digest + `"},{"path":"removed","post_digest":"absent"}],"raced":[]}`, 200},
		{"?path=raced", `{"content":"new","base_digest":"absent"}`, `{"paths":[{"path":"raced","post_digest":"` + digest + `"}],"raced":[{"path":"raced","version":"retained-outside"}]}`, 200},
		{"?path=a", `{"content":"new","base_digest":"` + digest + `"}`, `{"code":"stale","current_digest":"absent"}`, 409},
		{"", `{"changes":[{"path":"a","content":"new","base_digest":"` + digest + `"}]}`, `{"code":"stale","path":"a","current_digest":"absent"}`, 409},
	} {
		req, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content"+item.query, strings.NewReader(item.request))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "digest-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, item.status, response.StatusCode, string(body))
		require.JSONEq(t, item.reply, string(body))
	}
}
