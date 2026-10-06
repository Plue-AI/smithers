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
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// This proves the mounted legacy File-card doors with a real host store. Final
// capture and the branch-route matrix remain dependent on the daemon lane.
type sleepCountRuntime struct {
	workspace.WorkspaceRuntime
	starts atomic.Int32
	reads  atomic.Int32
}

func (r *sleepCountRuntime) StartWorkspace(ctx context.Context, id string) (workspace.Workspace, error) {
	r.starts.Add(1)
	return r.WorkspaceRuntime.StartWorkspace(ctx, id)
}
func (r *sleepCountRuntime) ReadFile(ctx context.Context, id, path string) ([]byte, error) {
	r.reads.Add(1)
	return r.WorkspaceRuntime.ReadFile(ctx, id, path)
}
func (r *sleepCountRuntime) ListFiles(ctx context.Context, id, path string) ([]workspace.FileEntry, error) {
	r.reads.Add(1)
	return r.WorkspaceRuntime.ListFiles(ctx, id, path)
}

func TestBranchSleepStoredFilesInstallNeverWake(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "sleepowner", LowerUsername: "sleepowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"sleepowner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for key, value := range map[string]string{"setup.step.source": `{"id":"source","status":"done"}`, "setup.source.repository": `"sleepowner/demo"`} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	cookie := "sleep-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	storage := t.TempDir()
	engine, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "split-process-repo", FFILibraryPath: os.Getenv("SMITHERS_FFI_LIBRARY_PATH"), InstallMainMirror: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, engine.Shutdown(context.Background())) })
	client := engine.Client()
	require.NoError(t, client.InitRepo(ctx, "sleepowner", "demo", "main", false))
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	var id string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,kind,status,vm_id,target_bookmark) VALUES($1,$2,'sleep','container','suspended','retained-vm','scratch/sleepowner/sleep') RETURNING id`, repo.ID, machineOwner).Scan(&id))
	seed := t.TempDir()
	git := func(args ...string) string {
		out, err := exec.Command("/usr/bin/git", args...).CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("init", seed)
	require.NoError(t, os.MkdirAll(filepath.Join(seed, "src"), 0700))
	const retry = "export const retry = 3;\n"
	const backoff = "export const backoff = 100;\n"
	require.NoError(t, os.WriteFile(filepath.Join(seed, "src/retry.ts"), []byte(retry), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(seed, "src/backoff.ts"), []byte(backoff), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(seed, "binary.bin"), []byte{0xff, 0x00, 0x01}, 0600))
	marker := filepath.Join(t.TempDir(), "executed")
	hostile := "#!/bin/sh\ntouch '" + marker + "'\n"
	require.NoError(t, os.MkdirAll(filepath.Join(seed, ".hooks"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(seed, ".hooks/post-checkout"), []byte(hostile), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(seed, "hostile.sh"), []byte(hostile), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(seed, ".env"), []byte("SNAPSHOT_FIXTURE=visible\n"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(seed, "large.bin"), []byte(strings.Repeat("x", services.MaxWorkspaceFileBytes+1)), 0600))
	require.NoError(t, os.Symlink("/etc/passwd", filepath.Join(seed, "outside-link")))
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Captured tree")
	head := git("-C", seed, "rev-parse", "HEAD")
	hostGit := filepath.Join(storage, "sleepowner", "demo", ".jj/repo/store/git")
	// Fixture construction only: production reads never run Git against files.
	git("-C", seed, "push", hostGit, "HEAD:"+repohost.BranchHeadRef(id))
	require.NoError(t, client.ImportRefs(ctx, "sleepowner", "demo"))
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, head)
	require.NoError(t, err)
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	counted := &sleepCountRuntime{WorkspaceRuntime: runtime}
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	server.Config.Handler = startSplitProcess(t, Options{FlowHostProductAPIURL: origin, Repository: client, Workspace: counted, BranchMachines: &providers, ChatHost: unusedChatHost{}})
	server.Start()
	defer server.Close()
	credential := ""
	readPath := func(endpoint string, status int) []byte {
		req, err := http.NewRequest("GET", server.URL+endpoint, nil)
		require.NoError(t, err)
		if credential == "" {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		} else {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, status, res.StatusCode, string(raw))
		return raw
	}
	read := func(suffix string, status int) []byte {
		return readPath("/api/repos/sleepowner/demo/workspaces/"+id+suffix, status)
	}
	for file, content := range map[string]string{"retry.ts": retry, "backoff.ts": backoff} {
		var value services.WorkspaceFileContent
		require.NoError(t, json.Unmarshal(read("/files/content?path=src/"+file, 200), &value))
		require.Equal(t, content, value.Content)
	}
	var entries []services.WorkspaceFileEntry
	require.NoError(t, json.Unmarshal(read("/files?path=src", 200), &entries))
	require.Equal(t, []services.WorkspaceFileEntry{{Name: "backoff.ts", Path: "src/backoff.ts", Type: "file", Size: int64(len(backoff))}, {Name: "retry.ts", Path: "src/retry.ts", Type: "file", Size: int64(len(retry))}}, entries)
	var binary services.WorkspaceFileContent
	require.NoError(t, json.Unmarshal(read("/files/content?path=binary.bin", 200), &binary))
	require.Equal(t, "base64", binary.Encoding)
	require.Equal(t, "/wAB", binary.Content)
	require.Equal(t, int64(3), binary.Size)
	var branchFile struct{ Content struct{ Kind, Text string } }
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/src/backoff.ts", 200), &branchFile))
	require.Equal(t, backoff, branchFile.Content.Text)
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files?path=src", 200), &entries))
	require.Equal(t, 2, len(entries))
	read("/files/content?path=../secret", 400)
	read("/files/content?path=src/missing.ts", 404)
	read("/files/content?path=large.bin", 413)
	readPath("/api/branches/"+id+"/files", 200)
	readPath("/api/branches/"+id+"/files/outside-link", 404)
	require.Zero(t, counted.starts.Load())
	require.Zero(t, counted.reads.Load())
	mint := func(branch string) (string, int64) {
		raw := "smithers_" + strings.Repeat("d", 39) + fmt.Sprint(len(branch)%10)
		digest := sha256.Sum256([]byte(raw))
		encoded := hex.EncodeToString(digest[:])
		token, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "sleep-cli-" + branch, TokenHash: encoded, TokenLastEight: encoded[len(encoded)-8:], SystemIssued: true, Scopes: "read:repository," + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "cli", Branch: branch}), ","), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return raw, token.ID
	}
	ownerCookie := cookie
	for _, permission := range []string{"admin", "write"} {
		member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "sleep" + permission, LowerUsername: "sleep" + permission})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, member.ID, permission)
		require.NoError(t, err)
		cookie = "sleep-cookie-" + permission
		digest := sha256.Sum256([]byte(cookie))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: member.ID, Username: member.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/src/backoff.ts", 200), &branchFile))
		require.Equal(t, backoff, branchFile.Content.Text)
		read("/files/content?path=src/retry.ts", 200)
		readPath("/api/branches/"+id+"/files?path=src", 200)
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NOW() WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
		require.NoError(t, err)
		readPath("/api/branches/"+id+"/files/src/backoff.ts", 403)
	}
	cookie = ownerCookie
	var tokenID int64
	credential, tokenID = mint(id)
	var projection services.BranchMachineResponse
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &projection))
	require.Equal(t, head, projection.Head)
	require.Equal(t, "asleep", projection.State)
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/src/backoff.ts", 200), &branchFile))
	require.Equal(t, backoff, branchFile.Content.Text)
	read("/files/content?path=src/retry.ts", 200)
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE id=$1`, tokenID)
	require.NoError(t, err)
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 401)
	credential, _ = mint("different-branch")
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 403)
	readPath("/api/branches/"+id, 403)
	read("/files/content?path=src/retry.ts", 403)
	credential = ""
	// A changed ref cannot serve stale or unrelated bytes.
	var captured struct{ Content struct{ Kind, Text string } }
	for file, expected := range map[string]string{"hostile.sh": hostile, ".hooks/post-checkout": hostile, ".env": "SNAPSHOT_FIXTURE=visible\n"} {
		require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/"+file, 200), &captured))
		require.Equal(t, expected, captured.Content.Text)
	}
	require.NoFileExists(t, marker)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, strings.Repeat("e", 40))
	require.NoError(t, err)
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 503)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, head)
	require.NoError(t, err)
	git("--git-dir", hostGit, "update-ref", "-d", repohost.BranchHeadRef(id))
	read("/files/content?path=src/retry.ts", 503)
	var status string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, id).Scan(&status))
	require.Equal(t, "suspended", status)
	require.Zero(t, counted.starts.Load())
	require.Zero(t, counted.reads.Load())
}
