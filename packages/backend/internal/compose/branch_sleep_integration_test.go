package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Real host storage and authenticated install routes, with a test guest.
// This is not reference-host qualification of native working-copy capture.
type sleepCountRuntime struct {
	idleProviders microsandbox.AdmissionIdleProviders
	idleHolder    string
	workspace.WorkspaceRuntime
	workspace.WorkspaceManagedHosts
	workspace.WorkspaceSourceRevisionResolver
	starts      atomic.Int32
	reads       atomic.Int32
	stops       atomic.Int32
	stop        func() error
	read        func(string)
	unreachable atomic.Bool
	unconfirmed atomic.Bool
	stopped     atomic.Bool
}

func (r *sleepCountRuntime) AdmissionSnapshot() []microsandbox.AdmissionRequest {
	return []microsandbox.AdmissionRequest{{Holder: r.idleHolder, Class: "todo", State: "granted"}}
}
func (r *sleepCountRuntime) SetAdmissionIdleProviders(p microsandbox.AdmissionIdleProviders) error {
	r.idleProviders = p
	return nil
}

type sleepCaptureFunc func(context.Context, string) (machined.CaptureResult, error)

func (f sleepCaptureFunc) Capture(ctx context.Context, id string) (machined.CaptureResult, error) {
	return f(ctx, id)
}
func (r *sleepCountRuntime) StopWorkspace(context.Context, string) error {
	r.stops.Add(1)
	if r.stop != nil {
		if err := r.stop(); err != nil {
			return err
		}
	}
	if !r.unconfirmed.Load() {
		r.stopped.Store(true)
	}
	return nil
}
func (r *sleepCountRuntime) InspectWorkspace(ctx context.Context, id string) (workspace.Workspace, error) {
	if _, ok := workspace.OperationFromContext(ctx); !ok {
		return workspace.Workspace{}, errors.New("runtime identity missing")
	}
	if r.unreachable.Load() {
		return workspace.Workspace{}, errors.New("guest disconnected")
	}
	state := workspace.WorkspaceRunning
	if r.stopped.Load() {
		state = workspace.WorkspaceStopped
	}
	return workspace.Workspace{ID: id, State: state}, nil

}

func (r *sleepCountRuntime) StartWorkspace(ctx context.Context, id string) (workspace.Workspace, error) {
	r.starts.Add(1)
	return r.WorkspaceRuntime.StartWorkspace(ctx, id)
}
func (r *sleepCountRuntime) ReadFile(ctx context.Context, id, path string) ([]byte, error) {
	r.reads.Add(1)
	contents, err := r.WorkspaceRuntime.ReadFile(ctx, id, path)
	if err == nil && r.read != nil {
		r.read(path)
	}
	return contents, err
}
func (r *sleepCountRuntime) ListFiles(ctx context.Context, id, path string) ([]workspace.FileEntry, error) {
	r.reads.Add(1)
	return r.WorkspaceRuntime.ListFiles(ctx, id, path)
}

func TestAdmissionIdleCaptureInstallHTTP(t *testing.T) {
	branchSleepInstall(t, "idle")
}

func TestBranchSleepAuthenticatedCaptureInstallHTTP(t *testing.T) {
	branchSleepInstall(t, "wire")
}

func TestReclaimedBranchRestoresFinalCaptureInstallHTTP(t *testing.T) {
	branchSleepInstall(t, "reclaimed")
}

func TestBranchSleepCapturedReadsNeverWake(t *testing.T) {
	branchSleepInstall(t, "reads")
}

func TestBranchSleepCaptureFailureKeepsRunning(t *testing.T) {
	branchSleepInstall(t, "failure")
}

func TestBranchSleepUnavailableProviders(t *testing.T) {
	for _, provider := range []string{"capture", "binding", "runtime", "identity"} {
		t.Run(provider, func(t *testing.T) { branchSleepInstall(t, "missing_"+provider) })
	}
}

func branchSleepInstall(t *testing.T, scenario string) {
	t.Helper()
	_, _, pool := splitProcessDatabase(t)
	if scenario == "reclaimed" {
		t.Setenv("SMITHERS_FEATURE_FLAGS_WORKSPACES", "true")
		t.Setenv("SMITHERS_FEATURE_FLAGS_SANDBOXES", "true")
	}
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
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,kind,status,vm_id,target_bookmark) VALUES($1,$2,'sleep','container','suspended','retained-vm','smithers/sleep-item') RETURNING id`, repo.ID, machineOwner).Scan(&id))
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
	require.NoError(t, os.WriteFile(filepath.Join(seed, "src/retry.ts"), []byte("export const retry = 2;\n"), 0600))

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
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Item base")
	base := git("-C", seed, "rev-parse", "HEAD")
	require.NoError(t, os.WriteFile(filepath.Join(seed, "src/retry.ts"), []byte(retry), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(seed, "src/backoff.ts"), []byte(backoff), 0600))
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Captured tree")
	head := git("-C", seed, "rev-parse", "HEAD")
	hostGit := filepath.Join(storage, "sleepowner", "demo", ".jj/repo/store/git")
	// Fixture construction only: production reads never run Git against files.
	git("-C", seed, "push", hostGit, "HEAD:"+repohost.BranchHeadRef(id))
	require.NoError(t, os.WriteFile(filepath.Join(seed, "src/retry.ts"), []byte("export const retry = 99;\n"), 0600))
	git("-C", seed, "add", ".")
	git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Unrelated main")
	mainHead := git("-C", seed, "rev-parse", "HEAD")
	require.NotEqual(t, base, mainHead)
	require.NotEqual(t, head, mainHead)
	git("-C", seed, "push", hostGit, "HEAD:refs/heads/main")
	require.NoError(t, client.ImportRefs(ctx, "sleepowner", "demo"))
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo.ID, IssueTitle: "Sleep item", WorkspaceID: id, CandidateBase: base, CandidateHead: head})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET base_commit=$2, candidate_verified=false WHERE id=$1`, item.ID, base)
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: id, RepositoryID: repo.ID, ItemID: item.ID, Name: "sleep-item"})
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, head)
	require.NoError(t, err)
	for path, text := range map[string]string{"src/retry.ts": retry, "src/backoff.ts": backoff} {
		file, err := client.GetFileAtCommit(ctx, "sleepowner", "demo", head, path)
		require.NoError(t, err)
		require.Equal(t, text, file.Content)
	}
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	counted := &sleepCountRuntime{WorkspaceRuntime: runtime, WorkspaceManagedHosts: runtime, WorkspaceSourceRevisionResolver: runtime}
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)
	// Test-only runtime qualification; this is not a C-MCH-03 mini receipt.
	providers.MicroVM = func(context.Context) error { return nil }
	providers.SessionIdentity = func(context.Context) error { return nil }
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: id, OwnerUserID: machineOwner, GranteeUserID: owner.ID, Level: "write"})
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	flowRegistry := buildRehearsalCodingHost(t, node, root)
	exporter := rehearsalJJExport(root, os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NotEmpty(t, exporter)
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", exporter)
	capture := sleepCaptureFunc(func(context.Context, string) (machined.CaptureResult, error) {
		return machined.CaptureResult{}, errors.New("undrained")
	})
	var captureProvider services.BranchCapture = sleepCaptureFunc(func(ctx context.Context, id string) (machined.CaptureResult, error) { return capture(ctx, id) })
	switch scenario {
	case "missing_capture":
		captureProvider = nil
	case "missing_binding":
		providers.LaneBinding = nil
	case "missing_runtime":
		providers.MicroVM = nil
	case "missing_identity":
		providers.SessionIdentity = nil
	}
	var registry *machined.Registry
	if scenario == "wire" {
		registry = new(machined.Registry)
	}
	server.Config.Handler = startSplitProcess(t, Options{Machined: registry, FlowHostProductAPIURL: origin, Repository: client, Workspace: counted, BranchCapture: captureProvider, BranchMachines: &providers, ChatHost: unusedChatHost{}, FlowHostRegistry: &flowRegistry, FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}})

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
	headToken, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: machineOwner, Name: "sleep-head", TokenHash: strings.Repeat("a", 64), TokenLastEight: "aaaaaaaa", SystemIssued: true, Scopes: "write:repository"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_push_token_id=$2 WHERE id=$1`, id, headToken.ID)
	require.NoError(t, err)
	assertHeadToken := func(want bool) {
		var exists bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM access_tokens WHERE id=$1)`, headToken.ID).Scan(&exists))
		require.Equal(t, want, exists)
	}
	// Exercise the mounted suspend door with a test-only daemon contract. The
	// host store, database, identity middleware and lifecycle are production.
	sleep := func(want int) {
		req, err := http.NewRequest("POST", server.URL+"/api/repos/sleepowner/demo/workspaces/"+id+"/suspend", nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "sleep-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "sleep-csrf"})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, want, res.StatusCode, string(raw))
	}
	if scenario == "reclaimed" {
		// A replacement machine has no working copy. Main has moved to retry=99;
		// the retained final capture contains retry=3 and the extra backoff file.
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='pending',disk_reclaimed_at=NOW(),branch_archived_at=NOW(),head_commit_id=$2 WHERE id=$1`, id, base)
		require.NoError(t, err)
		resume := func(want int) {
			req, err := http.NewRequest("POST", server.URL+"/api/repos/sleepowner/demo/workspaces/"+id+"/resume", nil)
			require.NoError(t, err)
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", "sleep-csrf")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "sleep-csrf"})
			res, err := server.Client().Do(req)
			require.NoError(t, err)
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			require.NoError(t, err)
			require.Equal(t, want, res.StatusCode, string(body))
		}
		resume(503)
		missing, err := q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.True(t, missing.DiskReclaimedAt.Valid, "an unverifiable capture stays pending")
		_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, head)
		require.NoError(t, err)
		resume(200)
		restored, err := q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, "running", restored.Status)
		require.False(t, restored.DiskReclaimedAt.Valid)
		require.False(t, restored.BranchArchivedAt.Valid)
		for path, text := range map[string]string{"src/retry.ts": retry, "src/backoff.ts": backoff} {
			var file struct{ Content struct{ Kind, Text string } }
			require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/"+path, 200), &file))
			require.Equal(t, text, file.Content.Text)
		}
		// Repeating wake reuses the receipt and never selects the newer main.
		resume(200)
		// A crash can leave a completed checkout beside a reclaimed marker.
		// A valid retained ref for another capture must not adopt that checkout
		// merely because both source commits are present in its object store.
		git("--git-dir", hostGit, "update-ref", repohost.BranchHeadRef(id), base)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='pending',disk_reclaimed_at=NOW(),branch_archived_at=NOW(),head_commit_id=$2 WHERE id=$1`, id, base)
		require.NoError(t, err)
		resume(409)
		refused, err := q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.True(t, refused.DiskReclaimedAt.Valid, "a different checkout cannot discharge reconstruction")
		require.True(t, refused.BranchArchivedAt.Valid)
		// Restoring the original capture allows replay of the completed checkout
		// without replacing files or selecting the moving main.
		git("--git-dir", hostGit, "update-ref", repohost.BranchHeadRef(id), head)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, head)
		require.NoError(t, err)
		resume(200)
		for path, text := range map[string]string{"src/retry.ts": retry, "src/backoff.ts": backoff} {
			var file struct{ Content struct{ Kind, Text string } }
			require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/"+path, 200), &file))
			require.Equal(t, text, file.Content.Text)
		}
		// Lose the authenticated retained ref after preflight, while the guest
		// reads a valid completed checkout receipt. Guest objects alone cannot
		// clear the recovery markers after this loss.
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='pending',disk_reclaimed_at=NOW(),branch_archived_at=NOW() WHERE id=$1`, id)
		require.NoError(t, err)
		lost := false
		counted.read = func(path string) {
			if path == ".git/smithers-workspace-initialization.json" {
				git("--git-dir", hostGit, "update-ref", "-d", repohost.BranchHeadRef(id))
				lost = true
			}
		}
		resume(503)
		counted.read = nil
		require.True(t, lost, "ref disappears during completed checkout replay")
		refused, err = q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.True(t, refused.DiskReclaimedAt.Valid)
		require.True(t, refused.BranchArchivedAt.Valid)
		git("--git-dir", hostGit, "update-ref", repohost.BranchHeadRef(id), head)
		resume(200)
		// A newly pending capture during guest receipt replay invalidates the
		// earlier preflight even when the retained ref still names the same head.
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='pending',disk_reclaimed_at=NOW(),branch_archived_at=NOW() WHERE id=$1`, id)
		require.NoError(t, err)
		pending := false
		counted.read = func(path string) {
			if path == ".git/smithers-workspace-initialization.json" {
				_, err := pool.Exec(ctx, `UPDATE workspaces SET capture_pending='{"id":"new-capture"}' WHERE id=$1`, id)
				require.NoError(t, err)
				pending = true
			}
		}
		resume(409)
		counted.read = nil
		require.True(t, pending)
		refused, err = q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.True(t, refused.DiskReclaimedAt.Valid, "pending capture cannot discharge reconstruction")
		require.True(t, refused.BranchArchivedAt.Valid)
		require.NotEmpty(t, refused.CapturePending)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, id)
		require.NoError(t, err)
		resume(200)
		// A replacement machine binding can arrive during receipt replay. The
		// old guest checkout cannot discharge recovery for the new machine.
		_, err = pool.Exec(ctx, `UPDATE workspaces SET status='pending',disk_reclaimed_at=NOW(),branch_archived_at=NOW() WHERE id=$1`, id)
		require.NoError(t, err)
		rebound := false
		counted.read = func(path string) {
			if path == ".git/smithers-workspace-initialization.json" {
				_, err := pool.Exec(ctx, `UPDATE workspaces SET vm_id='replacement-vm' WHERE id=$1`, id)
				require.NoError(t, err)
				rebound = true
			}
		}
		resume(409)
		counted.read = nil
		require.True(t, rebound)
		refused, err = q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, "replacement-vm", refused.VmID)
		require.True(t, refused.DiskReclaimedAt.Valid, "old guest receipt cannot discharge a replacement binding")
		require.True(t, refused.BranchArchivedAt.Valid)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='retained-vm' WHERE id=$1`, id)
		require.NoError(t, err)
		resume(200)
		otherOwner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "reboundowner", LowerUsername: "reboundowner"})
		require.NoError(t, err)
		otherRepo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
		require.NoError(t, err)
		for _, binding := range []struct {
			name, change    string
			value, original any
		}{
			{"repository", `UPDATE workspaces SET repository_id=$2 WHERE id=$1`, otherRepo.ID, repo.ID},
			{"owner", `UPDATE workspaces SET user_id=$2 WHERE id=$1`, otherOwner.ID, machineOwner},
			{"branch", `UPDATE workspaces SET target_bookmark=$2 WHERE id=$1`, "smithers/rebound-item", "smithers/sleep-item"},
			{"source_commit", `UPDATE workspaces SET source_commit=$2 WHERE id=$1`, base, ""},
		} {
			t.Run("rebound_"+binding.name, func(t *testing.T) {
				_, err := pool.Exec(ctx, `UPDATE workspaces SET status='pending',disk_reclaimed_at=NOW(),branch_archived_at=NOW() WHERE id=$1`, id)
				require.NoError(t, err)
				changed := false
				counted.read = func(path string) {
					if path == ".git/smithers-workspace-initialization.json" {
						_, err := pool.Exec(ctx, binding.change, id, binding.value)
						require.NoError(t, err)
						changed = true
					}
				}
				resume(409)
				counted.read = nil
				require.True(t, changed)
				refused, err := q.GetWorkspace(ctx, id)
				require.NoError(t, err)
				require.True(t, refused.DiskReclaimedAt.Valid)
				require.True(t, refused.BranchArchivedAt.Valid)
				_, err = pool.Exec(ctx, binding.change, id, binding.original)
				require.NoError(t, err)
				resume(200)
			})
		}
		require.NoFileExists(t, marker, "reconstruction never executes captured branch scripts")
		return
	}
	counted.stopped.Store(false)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)
	sleep(503)
	row, err := q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "running", row.Status)
	assertHeadToken(true)
	require.Zero(t, counted.stops.Load())
	if strings.HasPrefix(scenario, "missing_") {
		require.Equal(t, head, row.HeadCommitID)
		require.Zero(t, counted.starts.Load())
		return
	}
	counted.unreachable.Store(true)
	sleep(503)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "releasing", row.Status, "lost guest is not claimed awake or asleep")
	require.Equal(t, head, row.HeadCommitID)
	require.Zero(t, counted.stops.Load())
	counted.unreachable.Store(false)
	counted.stopped.Store(false)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)
	for _, fault := range []struct {
		name   string
		result machined.CaptureResult
		err    error
		stored string
	}{
		{name: "timeout", err: context.DeadlineExceeded, stored: head},
		{name: "undrained outbox", err: errors.New("authenticated delivery has unacknowledged events"), stored: head},
		{name: "missing object", err: errors.New("host rejected missing captured object"), stored: head},
		{name: "unprojected", result: machined.CaptureResult{Head: base, Tree: base}, stored: head},
		{name: "ref mismatch", result: machined.CaptureResult{Head: base, Tree: base}, stored: base},
	} {
		t.Run(fault.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, fault.stored)
			require.NoError(t, err)
			capture = func(context.Context, string) (machined.CaptureResult, error) { return fault.result, fault.err }
			sleep(503)
			row, err := q.GetWorkspace(ctx, id)
			require.NoError(t, err)
			require.Equal(t, "running", row.Status)
			require.Equal(t, fault.stored, row.HeadCommitID, "failed capture preserves the last projected head")
			assertHeadToken(true)
			var projected services.BranchMachineResponse
			require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &projected))
			require.Equal(t, "awake", projected.State)
			require.Zero(t, counted.stops.Load())
		})
	}
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, head)
	require.NoError(t, err)
	capture = func(ctx context.Context, branch string) (machined.CaptureResult, error) {
		row, err := q.GetWorkspace(ctx, branch)
		require.NoError(t, err)
		require.Equal(t, "releasing", row.Status)
		var projected services.BranchMachineResponse
		require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &projected))
		require.Equal(t, "releasing", projected.State)
		return machined.CaptureResult{Head: head, Tree: git("-C", seed, "rev-parse", head+"^{tree}")}, nil
	}
	counted.stop = func() error {
		row, err := q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, "releasing", row.Status)
		require.Equal(t, head, row.HeadCommitID)
		assertHeadToken(true)
		return errors.New("stop refused")
	}
	sleep(503)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "running", row.Status)
	counted.stop = nil
	counted.unconfirmed.Store(true)
	sleep(503)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "running", row.Status, "stop acknowledgment is not observed sleep")
	assertHeadToken(true)
	counted.unconfirmed.Store(false)
	if scenario == "failure" {
		return
	}
	if scenario == "wire" {
		link, peer := presenceTestLink(t, registry, id)
		require.NoError(t, link.Reconciled())
		require.NoError(t, peer.SetDeadline(time.Now().Add(10*time.Second)))
		headBytes, err := hex.DecodeString(head)
		require.NoError(t, err)
		treeBytes, err := hex.DecodeString(git("-C", seed, "rev-parse", head+"^{tree}"))
		require.NoError(t, err)
		baseBytes, err := hex.DecodeString(base)
		require.NoError(t, err)
		done := make(chan struct{})
		go func() {
			defer close(done)
			acknowledged := false
			for {
				frame, err := wire.Read(peer)
				if err != nil {
					return
				}
				if frame.Kind == wire.Events {
					fields, err := wire.Fields("ack", frame.Payload[1:])
					require.NoError(t, err)
					require.Equal(t, []byte{byte(machined.AckApplied)}, fields[2])
					acknowledged = true
					continue
				}
				request, method, _, err := frame.Request()
				require.NoError(t, err)
				var fields [][]byte
				switch wire.Method(method) {
				case wire.Capture:
					fields = [][]byte{wire.Field(1, headBytes), wire.Field(2, treeBytes), wire.Field(3, wire.U16(0))}
				case wire.Status:
					depth := uint32(1)
					if acknowledged {
						depth = 0
					}
					fields = [][]byte{wire.Field(1, []byte{3}), wire.Field(2, wire.U16(2)), wire.Field(3, wire.String("smithers-machined")), wire.Field(4, wire.U32(depth)), wire.Field(5, headBytes), wire.Field(6, wire.U16(0))}
				case wire.SetRoster:
				default:
					t.Errorf("unexpected guest method %d", method)
					return
				}
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(request)), wire.Field(2, wire.Union(method, fields...)))}))
				if wire.Method(method) == wire.Capture {
					event := machined.Event{Seq: 1, EventID: [16]byte{1}, Payload: wire.Union(2, wire.Field(1, headBytes), wire.Field(2, treeBytes), wire.Field(3, baseBytes))}
					require.NoError(t, wire.Write(peer, transcriptEventFrame(event)))
				}
			}
		}()
		defer func() { peer.Close(); <-done }()
		capture = registry.Capture
	}

	if scenario == "idle" {
		counted.idleHolder = "workspace:" + id
		svc := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(counted), services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(providers), services.WithBranchHeads(client), services.WithBranchCapture(captureProvider))
		svc.EnableMachineAdmission(func(context.Context) (int64, error) { return 140 << 30, nil })
		safety := microsandbox.AdmissionSafety{IdleSince: time.Now().Add(-time.Hour), PresenceKnown: true, SessionsKnown: true, RunKnown: true, BurstsEnabled: true, BurstsKnown: true}
		require.NoError(t, svc.EnableMachineIdleRelease(func(context.Context) (int64, error) { return 140 << 30, nil }, func(context.Context, db.Workspace) (microsandbox.AdmissionSafety, error) { return safety, nil }))
		observed, err := counted.idleProviders.Safety(ctx)
		require.NoError(t, err)
		require.Len(t, observed, 1)
		require.Equal(t, counted.idleHolder, observed[0].Holder)
		before := counted.stops.Load()
		safety.BurstsKnown = false
		require.ErrorContains(t, counted.idleProviders.Prepare(ctx, counted.idleHolder), "no longer safe-idle")
		require.Equal(t, before, counted.stops.Load())
		safety.BurstsKnown = true

		var arriving string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace_sessions(workspace_id,repository_id,user_id,kind,status) VALUES($1,$2,$3,'terminal','pending') RETURNING id`, id, repo.ID, owner.ID).Scan(&arriving))
		require.ErrorContains(t, counted.idleProviders.Prepare(ctx, counted.idleHolder), "admission changed before capture")
		require.Equal(t, before, counted.stops.Load(), "a new terminal cannot begin a force-stop timer")
		_, err = pool.Exec(ctx, `DELETE FROM workspace_sessions WHERE id=$1`, arriving)
		require.NoError(t, err)
		successful := capture
		capture = func(context.Context, string) (machined.CaptureResult, error) {
			return machined.CaptureResult{}, errors.New("unacknowledged unsaved edit")
		}
		require.Error(t, counted.idleProviders.Prepare(ctx, counted.idleHolder))
		require.Equal(t, before, counted.stops.Load())
		retained, err := q.GetWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, "running", retained.Status)
		capture = successful
		require.NoError(t, counted.idleProviders.Prepare(ctx, counted.idleHolder))
		require.NoError(t, counted.idleProviders.Stop(ctx, counted.idleHolder))
		require.Equal(t, before+1, counted.stops.Load())
		var projected services.BranchMachineResponse
		require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &projected))
		require.Equal(t, "asleep", projected.State)
		require.Equal(t, head, projected.Head)
		for file, expected := range map[string]string{"src/retry.ts": retry, "src/backoff.ts": backoff} {
			var retained struct{ Content struct{ Text string } }
			require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/"+file, 200), &retained))
			require.Equal(t, expected, retained.Content.Text)
		}
		return
	}

	sleep(200)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "suspended", row.Status)
	require.Equal(t, head, row.HeadCommitID)
	require.EqualValues(t, 3, counted.stops.Load())
	assertHeadToken(false)
	if scenario == "wire" {
		var receipts int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1`, id).Scan(&receipts))
		require.Equal(t, 1, receipts, "HTTP sleep drains the production committed capture receipt")
		var projected services.BranchMachineResponse
		require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &projected))
		require.Equal(t, "asleep", projected.State)
		return
	}
	sleep(200)
	require.EqualValues(t, 3, counted.stops.Load(), "duplicate sleep must not capture or stop again")
	// The spec's branch operation is durable and returns before capture drains.
	counted.stopped.Store(false)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)
	entered, release := make(chan struct{}), make(chan struct{})
	capture = func(ctx context.Context, _ string) (machined.CaptureResult, error) {
		close(entered)
		select {
		case <-release:
			return machined.CaptureResult{Head: head, Tree: base}, nil
		case <-ctx.Done():
			return machined.CaptureResult{}, ctx.Err()
		}
	}
	requestOp := "sleep"
	control := func(key string) jobs.RequestReceipt {
		requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(requestCtx, "POST", server.URL+"/api/branches/"+id, strings.NewReader(fmt.Sprintf(`{"op":%q}`, requestOp)))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "sleep-csrf"})
		req.Header.Set("X-CSRF-Token", "sleep-csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("Content-Type", "application/json")
		res, err := server.Client().Do(req)
		require.NoError(t, err, "request must not await capture")
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, 202, res.StatusCode, string(raw))
		var receipt jobs.RequestReceipt
		require.NoError(t, json.Unmarshal(raw, &receipt))
		return receipt
	}
	requested := control("sleep-contract")
	require.NotEmpty(t, requested.OperationID)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("sleep worker did not reach capture")
	}
	require.Equal(t, requested.OperationID, control("sleep-contract").OperationID)
	require.EqualValues(t, 3, counted.stops.Load(), "capture still draining")
	readPath("/api/branches/"+id, 200)
	close(release)
	require.Eventually(t, func() bool { row, err := q.GetWorkspace(ctx, id); return err == nil && row.Status == "suspended" }, 5*time.Second, 10*time.Millisecond)
	require.EqualValues(t, 4, counted.stops.Load())
	jobStore, err := jobs.NewStore(pool)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	require.Eventually(t, func() bool {
		operation, err := jobStore.Get(ctx, scope, requested.OperationID)
		return err == nil && operation.State == jobs.StateCompleted
	}, 5*time.Second, 10*time.Millisecond)

	counted.stopped.Store(false)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)
	capture = func(context.Context, string) (machined.CaptureResult, error) {
		return machined.CaptureResult{}, context.DeadlineExceeded
	}
	refused := control("sleep-failure")
	require.Eventually(t, func() bool {
		operation, err := jobStore.Get(ctx, scope, refused.OperationID)
		return err == nil && operation.State == jobs.StateFailed
	}, 5*time.Second, 10*time.Millisecond)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "running", row.Status)
	require.EqualValues(t, 4, counted.stops.Load())
	var failedRequest services.WorkspaceCommandRun
	require.NoError(t, json.Unmarshal(readPath("/api/repos/sleepowner/demo/workspaces/"+id+"/command-runs/"+refused.OperationID, 200), &failedRequest))
	require.Equal(t, jobs.StateFailed, failedRequest.State)
	require.Equal(t, "Branch request failed", failedRequest.Error)

	capture = func(context.Context, string) (machined.CaptureResult, error) {
		return machined.CaptureResult{Head: head, Tree: base}, nil
	}
	retried := control("sleep-retry")
	require.Eventually(t, func() bool {
		operation, err := jobStore.Get(ctx, scope, retried.OperationID)
		return err == nil && operation.State == jobs.StateCompleted
	}, 5*time.Second, 10*time.Millisecond)
	require.EqualValues(t, 5, counted.stops.Load())
	var completedRequest services.WorkspaceCommandRun
	require.NoError(t, json.Unmarshal(readPath("/api/repos/sleepowner/demo/workspaces/"+id+"/command-runs/"+retried.OperationID, 200), &completedRequest))
	require.Equal(t, jobs.StateCompleted, completedRequest.State)
	require.NotNil(t, completedRequest.Machine)
	require.Equal(t, "suspended", completedRequest.Machine.Status)
	requestOp = "wake"
	wakeRefused := control("wake-without-admission")
	require.Eventually(t, func() bool {
		operation, err := jobStore.Get(ctx, scope, wakeRefused.OperationID)
		return err == nil && operation.State == jobs.StateFailed
	}, 5*time.Second, 10*time.Millisecond)
	require.Zero(t, counted.starts.Load(), "wake requires admission")
	requestOp = "sleep"

	// Activity is already durable host state; it is read without consulting
	// captured files or contacting the guest, through HTTP and the live topic.
	activityTx, err := pool.Begin(ctx)
	require.NoError(t, err)
	activity, err := jobs.RecordFactInTx(ctx, activityTx, jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: "branch:" + id}, "00000000-0000-4000-8000-000000000007", "branch.burst", "completed", json.RawMessage(`{"id":"sleep-burst","kind":"burst","actor":{"id":"outside","kind":"outside","via":"tool"},"versions":"1111111111111111111111111111111111111111"}`))
	require.NoError(t, err)
	_, err = activityTx.Exec(ctx, `INSERT INTO burst_files(event_id,path,change,after_blob) VALUES($1,'src/backoff.ts','added','2222222222222222222222222222222222222222')`, activity.EventID)
	require.NoError(t, err)
	_, err = activityTx.Exec(ctx, `UPDATE product_job_events SET recorded_at='2026-10-06T12:00:00Z' WHERE event_id=$1`, activity.EventID)
	require.NoError(t, err)
	require.NoError(t, activityTx.Commit(ctx))
	assertActivity := func(afterApp bool) {
		t.Helper()
		var entries []struct {
			ID, Kind, Versions, At string
			Actor                  json.RawMessage
			Files                  json.RawMessage
		}
		require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/activity", 200), &entries))
		if afterApp {
			require.Len(t, entries, 3)
			require.Equal(t, "steer", entries[1].Kind)
			require.True(t, strings.HasPrefix(entries[1].ID, "steer:"))
			require.Equal(t, "answer", entries[2].Kind)
			require.Equal(t, "answer:branch-question-1", entries[2].ID)
		} else {
			require.Len(t, entries, 1)
		}
		require.Equal(t, "sleep-burst", entries[0].ID)
		require.Equal(t, "burst", entries[0].Kind)
		require.Equal(t, "2026-10-06T12:00:00Z", entries[0].At)
		require.Equal(t, "1111111111111111111111111111111111111111", entries[0].Versions)
		require.JSONEq(t, `{"id":"outside","kind":"outside","via":"tool"}`, string(entries[0].Actor))
		require.JSONEq(t, `[{"path":"src/backoff.ts","change":"added","after_blob":"2222222222222222222222222222222222222222"}]`, string(entries[0].Files))
	}
	assertActivity(false)
	assertDiff := func() {
		var diff services.BranchDiff
		require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/diff", 200), &diff))
		against := services.BranchDiffAgainst{Kind: "item_base", Rev: base}
		require.Equal(t, services.BranchDiff{Files: []services.BranchDiffModel{
			{Path: "src/backoff.ts", Branch: id, Against: against, Change: "added", Hunks: []services.BranchDiffHunk{{OldStart: 0, NewStart: 1, Lines: []services.BranchDiffLine{{Op: "+", Text: "export const backoff = 100;"}}}}},
			{Path: "src/retry.ts", Branch: id, Against: against, Change: "modified", Hunks: []services.BranchDiffHunk{{OldStart: 1, NewStart: 1, Lines: []services.BranchDiffLine{{Op: "-", Text: "export const retry = 2;"}, {Op: "+", Text: "export const retry = 3;"}}}}},
		}}, diff)
	}
	assertDiff()
	// A Branch answer must bind the question from the TODO read, even when
	// its activity stream contains no question and no TODO was opened.
	waits := fmt.Sprintf(`[{"id":"branch-question-1","kind":"question","prompt":"Include cancelled retries?","since":"2026-10-07T00:00:00Z","signal":{"scope":{"TenantID":"repository:%d","PrincipalID":"user:%d"},"target":{"TenantID":"repository:%d","PrincipalID":"user:%d","WorkspaceID":"%s","BindingKind":"mythical-item","BindingID":"%s"},"flow":"todo","run":"branch-question-run","name":"answer:branch-question-1"}}]`, repo.ID, owner.ID, repo.ID, owner.ID, id, fmt.Sprintf("%x-%x-%x-%x-%x", item.ID.Bytes[0:4], item.ID.Bytes[4:6], item.ID.Bytes[6:8], item.ID.Bytes[8:10], item.ID.Bytes[10:16]))
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',state='waiting',paused_at=now(),checks=jsonb_set(COALESCE(NULLIF(checks,'null'::jsonb),'{}'::jsonb),'{waits}',$2::jsonb) WHERE id=$1`, item.ID, waits)
	require.NoError(t, err)
	var questionProjection struct {
		State string
		Waits []struct{ ID string }
	}
	require.NoError(t, json.Unmarshal(readPath("/api/todos/1", 200), &questionProjection))
	require.Equal(t, "needs_you", questionProjection.State)
	require.Len(t, questionProjection.Waits, 1)
	require.Equal(t, "branch-question-1", questionProjection.Waits[0].ID)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	t.Run("app dispatcher and mounted Branch against PostgreSQL", func(t *testing.T) {
		require.Equal(t, int64(1), item.Number.Int64)
		script, err := filepath.Abs("../../../../apps/app/e2e/real/branch-card-install.fixture.tsx")
		require.NoError(t, err)
		command := exec.CommandContext(t.Context(), "bun", "run", script)
		command.Env = append(os.Environ(), "SMITHERS_BRANCH_CARD_ORIGIN="+server.URL, "SMITHERS_BRANCH_CARD_ID="+id)
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		t.Log(string(output))
	})
	var answeredBy, answer string
	require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'waits'->0->>'answered_by',checks->'waits'->0->>'answer' FROM mythical_items WHERE id=$1`, item.ID).Scan(&answeredBy, &answer))
	require.Equal(t, "sleepowner", answeredBy)
	require.Equal(t, "Include them", answer)
	var steerText string
	var steerAuthor int64
	var steerCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT checks->'steers'->0->>'text',(checks->'steers'->0->>'author')::bigint,jsonb_array_length(checks->'steers') FROM mythical_items WHERE id=$1`, item.ID).Scan(&steerText, &steerAuthor, &steerCount))
	require.Equal(t, "Keep retry backoff bounded", steerText)
	require.Equal(t, owner.ID, steerAuthor)
	require.Equal(t, 1, steerCount, "the mounted Steer persists exactly one authored input")
	var signals int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&signals))
	require.Equal(t, 1, signals, "the mounted Answer admits exactly one durable signal")
	t.Run("cold machine transitions stay visible without a host", func(t *testing.T) {
		conn, response, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{
			Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {server.URL}, "Cookie": {"smithers_session=" + cookie}},
		})
		require.NoError(t, err, "live upgrade response: %v", response)
		defer conn.CloseNow()
		conn.SetReadLimit(live.SendBudget)
		sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, id))
		first := readPresenceFrame(t, conn)
		require.Equal(t, "snap", first.T)
		require.Contains(t, string(first.Data), `"state":"asleep"`)
		for _, transition := range []struct{ status, state string }{{"pending", "waking"}, {"failed", "failed"}, {"starting", "waking"}, {"suspended", "asleep"}} {
			_, err := pool.Exec(t.Context(), `UPDATE workspaces SET status=$2 WHERE id=$1`, id, transition.status)
			require.NoError(t, err)
			frame := readPresenceFrame(t, conn)
			require.Equal(t, "snap", frame.T)
			require.Contains(t, string(frame.Data), `"state":"`+transition.state+`"`)
			require.Contains(t, string(frame.Data), `"id":"`+id+`"`)
		}
		require.Zero(t, counted.starts.Load(), "machine projections never launch a workspace")
		require.Zero(t, counted.reads.Load(), "cold projections never read a guest")
	})
	// An awake/released candidate keeps its existing immutable candidate semantics.
	counted.stopped.Store(false)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)

	// A current awake file comes from the retained runtime, not the mirrored head.
	liveWorkspace, err := runtime.CreateWorkspace(ctx, workspace.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, id)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Join(liveWorkspace.Root, "src"), 0700))
	const uncommitted = "export const retry = 17;\n"
	require.NoError(t, os.WriteFile(filepath.Join(liveWorkspace.Root, "src/retry.ts"), []byte(uncommitted), 0600))
	var currentFile struct{ Content struct{ Kind, Text string } }
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/src/retry.ts", 200), &currentFile))
	require.Equal(t, uncommitted, currentFile.Content.Text)
	require.Equal(t, int32(1), counted.reads.Load())
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/src/retry.ts?at="+head, 200), &currentFile))
	require.Equal(t, retry, currentFile.Content.Text)
	require.Equal(t, int32(1), counted.reads.Load(), "a pinned revision does not read the working copy")
	// Start a fresh measurement interval for all subsequent sleeping reads.
	counted.reads.Store(0)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=true, candidate_head=$2 WHERE id=$1`, item.ID, base)
	require.NoError(t, err)
	require.JSONEq(t, `{"files":[]}`, string(readPath("/api/branches/"+id+"/diff", 200)))
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, id)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=false, candidate_head=$2 WHERE id=$1`, item.ID, head)
	require.NoError(t, err)
	assertDiff()
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET base_commit=$2 WHERE id=$1`, item.ID, strings.Repeat("e", 40))
	require.NoError(t, err)
	readPath("/api/branches/"+id+"/diff", 503)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET base_commit=$2 WHERE id=$1`, item.ID, base)
	require.NoError(t, err)
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
	readPath("/api/branches/"+id+"/files/src/missing.ts", 404)
	// The shared retained reader distinguishes non-regular objects from absent
	// files: a symlink is unavailable, never an absence eligible for caching.
	readPath("/api/branches/"+id+"/files/outside-link", 503)
	require.Zero(t, counted.starts.Load())
	require.Zero(t, counted.reads.Load())
	minted := 0
	mint := func(branch string) (string, int64) {
		minted++
		raw := "smithers_" + fmt.Sprintf("%040d", minted)
		digest := sha256.Sum256([]byte(raw))
		encoded := hex.EncodeToString(digest[:])
		token, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "sleep-cli-" + branch, TokenHash: encoded, TokenLastEight: encoded[len(encoded)-8:], SystemIssued: true, Scopes: fmt.Sprintf("read:repository,repo:%d,", repo.ID) + strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "cli", Branch: branch}), ","), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
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
		assertDiff()
		assertActivity(true)
		readPath("/api/branches/"+id+"/files?path=src", 200)
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NOW() WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
		require.NoError(t, err)
		for _, path := range []string{"/api/branches/" + id + "/files/src/backoff.ts", "/api/branches/" + id + "/diff", "/api/branches/" + id + "/activity"} {
			require.Contains(t, string(readPath(path, 401)), `"code":"unauthenticated"`)
		}
	}
	cookie = ownerCookie
	var tokenID int64
	credential, tokenID = mint(id)
	assertActivity(true)
	for _, op := range []string{"sleep", "wake"} {
		req, err := http.NewRequest("POST", server.URL+"/api/branches/"+id, strings.NewReader(fmt.Sprintf(`{"op":%q}`, op)))
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+credential)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "delegated-"+op)
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		raw, err := io.ReadAll(res.Body)
		res.Body.Close()
		require.NoError(t, err)
		require.Equal(t, 403, res.StatusCode, string(raw))
	}

	var projection services.BranchMachineResponse
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &projection))
	require.Equal(t, head, projection.Head)
	require.Equal(t, "asleep", projection.State)
	// The Branch card remains readable without captured objects. File reads
	// still require the independently verified retained head and never wake.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id='' WHERE id=$1`, id)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &projection))
	require.Equal(t, "asleep", projection.State)
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 503)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, id, head)
	require.NoError(t, err)

	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id+"/files/src/backoff.ts", 200), &branchFile))
	require.Equal(t, backoff, branchFile.Content.Text)
	read("/files/content?path=src/retry.ts", 200)
	assertDiff()
	// An unrestricted repository read scope does not erase a branch binding.
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, tokenID, "read:repository,"+strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "cli", Branch: id}), ","))
	require.NoError(t, err)
	readPath("/api/branches/main/files/src/retry.ts", 403)
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 200)
	assertDiff()
	// Full-scope delegated readers use the catalog decision. Only a stored
	// branch restriction narrows them to one branch.
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes='read:repository,via:cli' WHERE id=$1`, tokenID)
	require.NoError(t, err)
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 200)
	assertDiff()
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE id=$1`, tokenID)
	require.NoError(t, err)
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 401)
	readPath("/api/branches/"+id+"/diff", 401)
	readPath("/api/branches/"+id+"/activity", 401)
	credential, _ = mint("different-branch")
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 403)
	readPath("/api/branches/"+id+"/diff", 403)
	readPath("/api/branches/"+id+"/activity", 403)
	readPath("/api/branches/"+id, 403)
	read("/files/content?path=src/retry.ts", 403)
	credential, tokenID = mint(id)
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, tokenID, strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "cli", Branch: id}), ","))
	require.NoError(t, err)
	for _, endpoint := range []string{"/api/branches/" + id, "/api/branches/" + id + "/files", "/api/branches/" + id + "/diff", "/api/branches/" + id + "/files/src/backoff.ts"} {
		readPath(endpoint, 403)
	}
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, tokenID, fmt.Sprintf("read:repository,repo:%d,", repo.ID+1)+strings.Join(middleware.DelegationScopes(middleware.Delegation{Via: "cli", Branch: id}), ","))
	require.NoError(t, err)
	for _, endpoint := range []string{"/api/branches/" + id, "/api/branches/" + id + "/files", "/api/branches/" + id + "/diff", "/api/branches/" + id + "/files/src/backoff.ts"} {
		readPath(endpoint, 403)
	}
	credential = ""
	// A native capture response alone is not a sleep receipt. Exercise the
	// production Registry through the install route while delivery is pending.
	registry = new(machined.Registry)
	authority, err := registry.MintBoot(id, "capture-vm")
	require.NoError(t, err)
	link, daemon := externalTranscriptLink(t, registry, id, authority)
	require.NoError(t, link.Reconciled())
	require.NoError(t, daemon.SetDeadline(time.Now().Add(10*time.Second)))
	capture = registry.Capture
	counted.stopped.Store(false)
	headToken, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: machineOwner, Name: "sleep-drain-head", TokenHash: strings.Repeat("b", 64), TokenLastEight: "bbbbbbbb", SystemIssued: true, Scopes: "write:repository"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running',head_push_token_id=$2 WHERE id=$1`, id, headToken.ID)
	require.NoError(t, err)
	stopsBeforeDrain := counted.stops.Load()
	draining := control("sleep-registry-drain")
	requestFrame := func(method wire.Method) uint32 {
		t.Helper()
		frame, err := wire.Read(daemon)
		require.NoError(t, err)
		request, got, _, err := frame.Request()
		require.NoError(t, err)
		require.Equal(t, byte(method), got)
		return request
	}
	respond := func(request uint32, method wire.Method, fields ...[]byte) {
		t.Helper()
		require.NoError(t, wire.Write(daemon, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(request)), wire.Field(2, wire.Union(byte(method), fields...)))}))
	}
	headBytes, err := hex.DecodeString(head)
	require.NoError(t, err)
	treeBytes, err := hex.DecodeString(git("-C", seed, "rev-parse", head+"^{tree}"))
	require.NoError(t, err)
	respond(requestFrame(wire.Capture), wire.Capture, wire.Field(1, headBytes), wire.Field(2, treeBytes), wire.Field(3, wire.U16(0)))
	statusFields := func(depth uint32) [][]byte {
		return [][]byte{wire.Field(1, []byte{3}), wire.Field(2, wire.U16(2)), wire.Field(3, wire.String("smithers-machined")), wire.Field(4, wire.U32(depth)), wire.Field(5, headBytes), wire.Field(6, wire.U16(0))}
	}
	respond(requestFrame(wire.Status), wire.Status, statusFields(2)...)
	statusRequest := requestFrame(wire.Status)
	require.Equal(t, stopsBeforeDrain, counted.stops.Load())
	assertHeadToken(true)
	var drainingProjection services.BranchMachineResponse
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &drainingProjection))
	require.Equal(t, "releasing", drainingProjection.State)
	respond(statusRequest, wire.Status, statusFields(0)...)
	require.Eventually(t, func() bool {
		operation, err := jobStore.Get(ctx, scope, draining.OperationID)
		return err == nil && operation.State == jobs.StateCompleted
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, stopsBeforeDrain+1, counted.stops.Load())
	assertHeadToken(false)
	require.NoError(t, json.Unmarshal(readPath("/api/branches/"+id, 200), &drainingProjection))
	require.Equal(t, "asleep", drainingProjection.State)
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
	readPath("/api/branches/"+id+"/diff", 503)
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
