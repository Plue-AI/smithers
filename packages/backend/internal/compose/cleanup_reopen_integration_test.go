package compose

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/operations"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The policy-suite adapter replaces only the guest slot. The production
// readiness callback still checks member and retained branch authority.
type cleanupProcessRuntime struct{ *rehearsalAdmissionRuntime }

func (r *cleanupProcessRuntime) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	if err := p.Ready(ctx, microsandbox.AdmissionRequest{Class: class, Holder: holder, Actor: actor, Reason: reason}); err != nil {
		return ctx, err
	}
	return ctx, nil
}

// Complete captured bytes are literal inputs at the native capture boundary.
// Removal, host-object verification, GitHub reopen and fresh admission all run
// through the composed install. This process suite is not microVM qualification.
type cleanupReopenProof struct {
	id, root, head string
	canary         string
	number         int64
	files          map[string][]byte
	retained       func()
}

func prepareCleanupReopen(t *testing.T, r *rehearsal, n, repository, owner int64, base string) *cleanupReopenProof {
	t.Helper()
	// Pause composition while installing the completed native-capture input.
	// No live run may replace this fixture's branch binding during construction.
	r.stopBackend()
	ctx := t.Context()
	q := db.New(r.pool)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repository, UserID: machineOwner, Kind: "container", Status: "suspended", TargetBookmark: "smithers/lifecycle-fixture"})
	require.NoError(t, err)
	observed, err := r.processRuntime.CreateWorkspace(ctx, workspace.WorkspaceSpec{ID: row.ID})
	require.NoError(t, err)
	p := &cleanupReopenProof{id: row.ID, root: observed.Root, number: n, files: map[string][]byte{"tracked.txt": []byte("tracked final bytes\n"), "untracked.txt": []byte("untracked final bytes\n"), "binary.bin": {0, 255, 128, 1}, ".gitattributes": []byte("*.txt filter=hostile\n")}}
	git := func(args ...string) string {
		output, err := exec.Command("/usr/bin/git", args...).CombinedOutput()
		require.NoError(t, err, string(output))
		return strings.TrimSpace(string(output))
	}
	git("init", p.root)
	for path, data := range p.files {
		require.NoError(t, r.processRuntime.WriteFile(ctx, p.id, path, data, 0600))
	}
	git("-C", p.root, "add", "tracked.txt")
	git("-C", p.root, "-c", "user.name=Capture", "-c", "user.email=capture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-m", "tracked base")
	git("-C", p.root, "add", ".")
	git("-C", p.root, "-c", "user.name=Capture", "-c", "user.email=capture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-m", "final capture including untracked bytes")
	p.head = git("-C", p.root, "rev-parse", "HEAD")
	tree := git("-C", p.root, "rev-parse", "HEAD^{tree}")
	hostGit := filepath.Join(r.repositoryRoot, "rehearsal-owner", "app", ".jj/repo/store/git")
	git("-C", p.root, "push", hostGit, "HEAD:"+repohost.BranchHeadRef(p.id))
	p.canary = filepath.Join(t.TempDir(), "host-execution")
	hooks := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(hooks, "post-checkout"), []byte("#!/bin/sh\nprintf executed > "+p.canary+"\n"), 0755))
	git("--git-dir", hostGit, "config", "core.hooksPath", hooks)
	for _, filter := range []string{"clean", "smudge"} {
		git("--git-dir", hostGit, "config", "filter.hostile."+filter, "/bin/sh -c 'printf executed > "+p.canary+"'")
	}

	err = r.processRuntime.StopWorkspace(ctx, p.id)
	require.NoError(t, err)
	_, err = r.pool.Exec(ctx, `UPDATE workspaces SET vm_id=$2,head_commit_id=$3,status='suspended' WHERE id=$1`, p.id, p.id, p.head)
	require.NoError(t, err)
	var item db.MythicalItem
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT id FROM mythical_items WHERE number=$1`, n).Scan(&item.ID))
	capturedChange, err := r.options.Repository.GetChange(ctx, "rehearsal-owner", "app", p.head)
	require.NoError(t, err)
	require.NotEmpty(t, capturedChange.ChangeID)
	_, err = r.pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$2,checks=jsonb_set(checks,'{machineItemChanges}',jsonb_build_object($2::text,$3::text)) WHERE id=$1`, item.ID, p.id, capturedChange.ChangeID)
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{RepositoryID: repository, WorkspaceID: p.id, ItemID: item.ID, Name: "lifecycle-fixture"})
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: p.id, OwnerUserID: machineOwner, GranteeUserID: owner, Level: "write"})
	require.NoError(t, err)
	decode := func(s string) []byte { b, err := hex.DecodeString(s); require.NoError(t, err); return b }
	payload := wire.Union(2, wire.Field(1, decode(p.head)), wire.Field(2, decode(tree)), wire.Field(3, decode(base)))
	digest := sha256.Sum256(payload)
	_, err = r.pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome,payload_digest,capture_payload) VALUES($1,$2,'applied',$3,$4)`, p.id, uuid.NewString(), digest[:], payload)
	require.NoError(t, err)
	tx, err := r.pool.Begin(ctx)
	require.NoError(t, err)
	data, err := json.Marshal(map[string]string{"head": p.head, "tree": tree, "vm_id": p.id})
	require.NoError(t, err)
	_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + p.id}, uuid.NewString(), "branch.final_capture", "completed", data)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	r.options.Workspace = &cleanupProcessRuntime{&rehearsalAdmissionRuntime{Runtime: r.processRuntime}}
	r.options.ReadyBindings = func(b operations.Bindings) {
		service := b.Workspaces.(*services.WorkspaceService)
		services.WithWorkspaceBillingPolicy(services.NewMachineAdmissionPolicy(services.NewUnlimitedBillingPolicy()))(service)
		service.EnableMachineAdmission(func(context.Context) (int64, error) { return 400 << 30, nil })
	}
	r.options.CleanupInterval = 100 * time.Millisecond
	r.options.CleanupClock = func() time.Time { return time.Now().Add(24*time.Hour + time.Minute) }
	p.retained = cleanupRetainedEvidence(t, r.pool, p.id)
	r.restartBackend()
	return p
}

func (p *cleanupReopenProof) remove(t *testing.T, r *rehearsal) {
	t.Helper()
	defer func() {
		if t.Failed() {
			t.Log(r.logs.String())
		}
	}()
	require.Eventually(t, func() bool {
		var done bool
		return r.pool.QueryRow(r.ctx, `SELECT disk_reclaimed_at IS NOT NULL FROM workspaces WHERE id=$1`, p.id).Scan(&done) == nil && done
	}, 15*time.Second, 20*time.Millisecond, "production cleaner must delete the dropped machine")
	require.NoDirExists(t, p.root)
	p.retained()
	require.NoFileExists(t, p.canary, "host cleanup must treat hostile configuration as data")
	for path, data := range p.files {
		file, err := r.repoClient.GetFileAtCommit(r.ctx, "rehearsal-owner", "app", p.head, path)
		require.NoError(t, err)
		actual := []byte(file.Content)
		if file.Encoding == "base64" {
			actual, err = base64.StdEncoding.DecodeString(file.Content)
			require.NoError(t, err)
		}
		require.Equal(t, data, actual)
	}
	githubLifecycleBrowserPhase(t, r, p.number, "cleaned", map[string]any{"branch": "lifecycle-fixture", "workspace": p.id})
}
func (p *cleanupReopenProof) reconstruct(t *testing.T, r *rehearsal) {
	t.Helper()
	require.Eventually(t, func() bool {
		var ready bool
		return r.pool.QueryRow(r.ctx, `SELECT pending_op IS NULL FROM mythical_items WHERE number=$1`, p.number).Scan(&ready) == nil && ready
	}, 30*time.Second, 20*time.Millisecond)
	var binding string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT json_build_object('workspace',i.workspace_id,'lanes',(SELECT json_agg(l) FROM mythical_lanes l WHERE l.item_id=i.id))::text FROM mythical_items i WHERE number=$1`, p.number).Scan(&binding))
	t.Log("reopen binding", binding)
	code, body, err := r.request("POST", "/api/repos/rehearsal-owner/app/workspaces/"+p.id+"/resume", "")
	require.NoError(t, err)
	require.Equal(t, 200, code, string(body))
	restored, err := r.processRuntime.InspectWorkspace(context.Background(), p.id)
	require.NoError(t, err)
	for path, want := range p.files {
		got, err := r.processRuntime.ReadFile(r.ctx, p.id, path)
		require.NoError(t, err)
		require.Equal(t, want, got)
		require.Equal(t, sha256.Sum256(want), sha256.Sum256(got))
	}
	p.retained()
	require.DirExists(t, restored.Root)
	require.FileExists(t, filepath.Join(restored.Root, ".git/smithers-workspace-initialization.json"), "production reconstruction must leave its completed checkout receipt")
	row, err := db.New(r.pool).GetWorkspace(r.ctx, p.id)
	require.NoError(t, err)
	require.False(t, row.DiskReclaimedAt.Valid)
	require.False(t, row.BranchArchivedAt.Valid)
	require.Equal(t, p.head, row.HeadCommitID)
	require.NoFileExists(t, p.canary, "production PR reopen and reconstruction must not run host hooks or filters")
	_, err = os.Stat(filepath.Join(restored.Root, "binary.bin"))
	require.NoError(t, err)
}

// Snapshot real capture/activity rows before removal. Later events may append,
// but cleanup and reconstruction must preserve every existing row unchanged.
func cleanupRetainedEvidence(t *testing.T, pool *pgxpool.Pool, branch string) func() {
	t.Helper()
	const query = `SELECT jsonb_build_object(
 'receipts', (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM machine_event_receipts r WHERE workspace_id=$1::uuid),
 'activity', (SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM product_job_events e WHERE principal_id='branch:' || $1::text OR data->>'branch'=$1::text),
 'files', (SELECT COALESCE(jsonb_agg(to_jsonb(f)), '[]'::jsonb) FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.principal_id='branch:' || $1::text OR e.data->>'branch'=$1::text))`
	var before []byte
	require.NoError(t, pool.QueryRow(t.Context(), query, branch).Scan(&before))
	var rows map[string][]json.RawMessage
	require.NoError(t, json.Unmarshal(before, &rows))
	require.NotEmpty(t, rows["receipts"], "production capture must leave durable receipts")
	require.NotEmpty(t, rows["activity"], "production capture must leave activity")
	return func() {
		t.Helper()
		var preserved bool
		require.NoError(t, pool.QueryRow(t.Context(), "SELECT $2::jsonb <@ ("+query+")", branch, string(before)).Scan(&preserved))
		require.True(t, preserved, "cleanup/reopen must preserve capture receipts, activity and burst files: %s", before)
	}
}
