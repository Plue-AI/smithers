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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
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
	workspace.WorkspaceManagedHosts
	workspace.WorkspaceSourceRevisionResolver
	starts      atomic.Int32
	reads       atomic.Int32
	stops       atomic.Int32
	stop        func() error
	unreachable atomic.Bool
}

type sleepCaptureFunc func(context.Context, string) (machined.CaptureResult, error)

func (f sleepCaptureFunc) Capture(ctx context.Context, id string) (machined.CaptureResult, error) {
	return f(ctx, id)
}
func (r *sleepCountRuntime) StopWorkspace(context.Context, string) error {
	r.stops.Add(1)
	if r.stop != nil {
		return r.stop()
	}
	return nil
}
func (r *sleepCountRuntime) InspectWorkspace(_ context.Context, id string) (workspace.Workspace, error) {
	if r.unreachable.Load() {
		return workspace.Workspace{}, errors.New("guest disconnected")
	}
	return workspace.Workspace{ID: id, State: workspace.WorkspaceRunning}, nil
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
	capture := sleepCaptureFunc(func(context.Context, string) (machined.CaptureResult, error) {
		return machined.CaptureResult{}, errors.New("undrained")
	})
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	registry := buildRehearsalCodingHost(t, node, root)
	exporter := rehearsalJJExport(root, os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NotEmpty(t, exporter)
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", exporter)
	server.Config.Handler = startSplitProcess(t, Options{FlowHostProductAPIURL: origin, Repository: client, Workspace: counted, BranchCapture: sleepCaptureFunc(func(ctx context.Context, id string) (machined.CaptureResult, error) { return capture(ctx, id) }), BranchMachines: &providers, ChatHost: unusedChatHost{}, FlowHostRegistry: &registry, FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}})
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
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)
	sleep(503)
	row, err := q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "running", row.Status)
	require.Zero(t, counted.stops.Load())
	counted.unreachable.Store(true)
	sleep(503)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "releasing", row.Status, "lost guest is not claimed awake or asleep")
	require.Equal(t, head, row.HeadCommitID)
	require.Zero(t, counted.stops.Load())
	counted.unreachable.Store(false)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)
	for _, fault := range []struct {
		name   string
		result machined.CaptureResult
		err    error
		stored string
	}{
		{name: "timeout", err: context.DeadlineExceeded, stored: head},
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
		return errors.New("stop refused")
	}
	sleep(503)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "running", row.Status)
	counted.stop = nil
	sleep(200)
	row, err = q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "suspended", row.Status)
	require.Equal(t, head, row.HeadCommitID)
	require.EqualValues(t, 2, counted.stops.Load())
	sleep(200)
	require.EqualValues(t, 2, counted.stops.Load(), "duplicate sleep must not capture or stop again")
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
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked',checks=jsonb_set(COALESCE(NULLIF(checks,'null'::jsonb),'{}'::jsonb),'{waits}',$2::jsonb) WHERE id=$1`, item.ID, waits)
	require.NoError(t, err)
	var questionProjection struct {
		State string
		Waits []struct{ ID string }
	}
	require.NoError(t, json.Unmarshal(readPath("/api/todos/1", 200), &questionProjection))
	require.Equal(t, "needs_you", questionProjection.State)
	require.Len(t, questionProjection.Waits, 1)
	require.Equal(t, "branch-question-1", questionProjection.Waits[0].ID)
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
	var signals int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&signals))
	require.Equal(t, 1, signals, "the mounted Answer admits exactly one durable signal")
	// An awake/released candidate keeps its existing immutable candidate semantics.
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
		readPath("/api/branches/"+id+"/files?path=src", 200)
		_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NOW() WHERE repository_id=$1 AND user_id=$2`, repo.ID, member.ID)
		require.NoError(t, err)
		readPath("/api/branches/"+id+"/files/src/backoff.ts", 403)
		readPath("/api/branches/"+id+"/diff", 403)
	}
	cookie = ownerCookie
	var tokenID int64
	credential, tokenID = mint(id)
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
	_, err = pool.Exec(ctx, `DELETE FROM access_tokens WHERE id=$1`, tokenID)
	require.NoError(t, err)
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 401)
	readPath("/api/branches/"+id+"/diff", 401)
	credential, _ = mint("different-branch")
	readPath("/api/branches/"+id+"/files/src/backoff.ts", 403)
	readPath("/api/branches/"+id+"/diff", 403)
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
