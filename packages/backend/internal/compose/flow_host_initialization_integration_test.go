package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The process runtime and real PostgreSQL are the journey composition's. The
// fault changes only the host's expected source; all admission, binding, HTTP and stop paths
// are production paths. It also observes forbidden pre-receipt source reads.
type initializationRaceRuntime struct {
	bindingProcessRuntime
	target      string
	sourceReads atomic.Int32
	starts      atomic.Int32
	mismatch    bool
}

func (r *initializationRaceRuntime) ResolveWorkspaceSourceRevision(ctx context.Context, id string) (string, error) {
	if id == r.target {
		r.sourceReads.Add(1)
	}
	if id != r.target {
		return r.bindingProcessRuntime.ResolveWorkspaceSourceRevision(ctx, id)
	}
	return r.Runtime.ResolveWorkspaceSourceRevision(ctx, id)
}
func (r *initializationRaceRuntime) StartManagedHost(ctx context.Context, id string, spec workspaceapi.ManagedHostSpec) (workspaceapi.ManagedHostConnection, error) {
	if id == r.target {
		r.starts.Add(1)

	}
	if id == r.target {
		build := spec.Builder
		spec.Builder = workspaceapi.ManagedHostBuilderFunc(func(ctx context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
			command, err := build.BuildManagedHost(ctx, placement)
			if err != nil {
				return command, err
			}
			command.Environment["SMITHERS_CODING_LOCAL_OWNER"] = "1"
			if r.mismatch {
				command.Environment["SMITHERS_SOURCE_REVISION"] = strings.Repeat("f", 40)
			}
			command.Environment["SMITHERS_WORKSPACE_CODING_CONFIG"] = filepath.Join(placement.Workspace.Root, ".jj/workspace-coding.json")
			command.Environment["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] = os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY")
			command.Environment["PATH"] = os.Getenv("PATH")
			return command, nil
		})
		connection, err := r.Runtime.StartManagedHost(ctx, id, spec)
		if err != nil {
			observation, inspectErr := r.Runtime.InspectService(context.WithoutCancel(ctx), id, spec.Name)
			r.t.Logf("scratch startup failed: %v; inspect: %v; stderr: %s; stdout: %s", err, inspectErr, observation.Stderr, observation.Stdout)
		}
		return connection, err
	}
	return r.bindingProcessRuntime.StartManagedHost(ctx, id, spec)
}

// This focused process fixture has no branch journal for its ordinary scratch
// box. All other boxes retain the journey daemon and its admission path.
func (r *initializationRaceRuntime) EnsureMachined(ctx context.Context, id string) error {
	if id == r.target {
		return nil
	}
	return r.bindingProcessRuntime.EnsureMachined(ctx, id)
}

func TestComposedFlowHostInitializationRace(t *testing.T) {
	testComposedFlowHostInitialization(t, false)
}
func TestComposedFlowHostMismatchReleasesMachine(t *testing.T) {
	testComposedFlowHostInitialization(t, true)
}
func testComposedFlowHostInitialization(t *testing.T, mismatch bool) {
	r := newRehearsal(t, "SMITHERS_FLOW_HOST_INIT_REHEARSAL", "fr35-init", "fr35-")
	r.stopBackend()
	base := r.workspaceRuntime.(bindingProcessRuntime)
	runtime := &initializationRaceRuntime{bindingProcessRuntime: base, target: uuid.NewString(), mismatch: mismatch}
	r.options.Workspace = runtime
	r.stdout.mu.Lock()
	r.stdout.buffer.Reset()
	r.stdout.mu.Unlock()
	r.restartBackend()
	require.True(t, r.setupSource())
	require.True(t, r.setupMachine())
	ctx := t.Context()
	q := db.New(r.pool)
	var owner, repo int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT user_id,id FROM repositories WHERE lower_name='app'`).Scan(&owner, &repo))
	_, err := r.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,kind,status,name,target_bookmark) VALUES($1,$2,$3,'container','running','initializing','scratch/init-race')`, runtime.target, repo, owner)
	require.NoError(t, err)
	row, err := q.GetWorkspace(ctx, runtime.target)
	require.NoError(t, err)
	op := workspaceapi.WithOperation(ctx, workspaceapi.Operation{TenantID: strconv.FormatInt(owner, 10), PrincipalID: strconv.FormatInt(owner, 10), OperationID: "fr35-create"})
	observed, err := r.processRuntime.CreateWorkspace(op, workspaceapi.WorkspaceSpec{ID: row.ID})
	require.NoError(t, err)
	_, err = r.processRuntime.StartWorkspace(op, row.ID)
	require.NoError(t, err)
	git := func(args ...string) string {
		out, err := exec.Command("/usr/bin/git", args...).CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("clone", filepath.Join(r.gitRoot, "rehearsal-owner", "app.git"), observed.Root)
	before := git("-C", observed.Root, "rev-parse", "HEAD")
	// Keep a disk marker through a failed start and the eventual machine stop.
	marker := filepath.Join(observed.Root, ".git/fr35-retained")
	require.NoError(t, os.WriteFile(marker, []byte("retained"), 0600))

	body := fmt.Sprintf(`{"repo":"rehearsal-owner/app","workspaceId":%q,"procedure":"List","payload":{}}`, row.ID)
	call := func() {
		status, _, err := r.request("POST", "/api/workflow/rpc", body)
		require.NoError(t, err)
		require.Contains(t, []int{200, 503, 409}, status)
	}
	call()
	require.Eventually(t, func() bool {
		for _, line := range strings.Split(r.logs.String(), "\n") {
			if strings.Contains(line, "workspace_initializing") && strings.Contains(line, row.ID) {
				return true
			}
		}
		return false
	}, 20*time.Second, 50*time.Millisecond, r.logs.String())
	var count int
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM flow_runtime_host_bindings WHERE workspace_id=$1`, row.ID).Scan(&count))
	require.Zero(t, count, "partial clone must not bind")
	require.Zero(t, runtime.sourceReads.Load(), "partial clone must not resolve source")
	require.Zero(t, runtime.starts.Load())
	// Complete the repository's initialization with a different clean revision,
	// then write the same receipt the real initializer writes last.
	git("-C", observed.Root, "-c", "user.name=Init", "-c", "user.email=init@example.test", "commit", "--allow-empty", "-m", "post-init snapshot")
	require.NoError(t, provisionRehearsalJJ(observed.Root))
	after, err := r.processRuntime.ResolveWorkspaceSourceRevision(op, row.ID)
	require.NoError(t, err)
	require.NotEqual(t, before, after)
	receipt, _ := json.Marshal(map[string]any{"version": 1, "workspace_id": row.ID, "repository_id": repo, "source_revision": after, "initialized_at": time.Now().UTC(), "source_bookmark": "scratch/init-race"})
	require.NoError(t, os.WriteFile(filepath.Join(observed.Root, ".git/smithers-workspace-initialization.json"), receipt, 0600))
	var state, revision, code string
	require.Eventually(t, func() bool {
		call()
		err := r.pool.QueryRow(ctx, `SELECT state,source_revision,last_error_code FROM flow_runtime_host_bindings WHERE workspace_id=$1`, row.ID).Scan(&state, &revision, &code)
		if err != nil {
			return false
		}
		if mismatch {
			return code == "runtime_source_revision_mismatch_terminal"
		}
		return state == "running"
	}, 90*time.Second, 200*time.Millisecond, r.logs.String())
	require.Equal(t, after, revision, "binding must use the post-init snapshot")
	if mismatch {
		require.Equal(t, int32(2), runtime.starts.Load(), "only one refreshed retry")
		require.Eventually(t, func() bool {
			ws, err := r.processRuntime.InspectWorkspace(ctx, row.ID)
			return err == nil && ws.State == workspaceapi.WorkspaceStopped
		}, 10*time.Second, 50*time.Millisecond)
		current, err := q.GetWorkspace(ctx, row.ID)
		require.NoError(t, err)
		require.Equal(t, "stopped", current.Status)
		runtime.admissionMu.Lock()
		released := runtime.released["workspace:"+row.ID]
		runtime.admissionMu.Unlock()
		require.True(t, released, "confirmed stop must release the admission slot")
		// A later demand must not revive this terminal binding.
		call()
		require.Equal(t, int32(2), runtime.starts.Load())
	}
	require.FileExists(t, marker, "failed-host stop must keep the disk")
}
