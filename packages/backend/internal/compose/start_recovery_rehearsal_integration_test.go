package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Keep every installed runtime capability. Only the remote advertisement is
// faulted, using real git against an HTTP 401 rather than a helper error.
type startRecoveryRuntime struct {
	bindingProcessRuntime
	deny         atomic.Bool
	failDelete   atomic.Bool
	denied       chan string
	unauthorized string
	reader       atomic.Int64
	readers      sync.Map
}

func (r *startRecoveryRuntime) DeleteWorkspace(ctx context.Context, id string) error {
	if r.failDelete.CompareAndSwap(true, false) {
		return errors.New("controller unavailable during failed-start cleanup")
	}
	return r.bindingProcessRuntime.DeleteWorkspace(ctx, id)
}
func (r *startRecoveryRuntime) SyncTodoAdmission(scope string, holders []string, limit int) error {
	return r.bindingProcessRuntime.SyncTodoAdmission(scope, holders, min(limit, 1))
}
func (r *startRecoveryRuntime) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(command.Args) >= 2 && command.Args[0] == "git" && command.Args[1] == "ls-remote" {
		bearer := strings.TrimPrefix(command.Environment["GIT_CONFIG_VALUE_0"], "Authorization: Bearer ")
		digest := sha256.Sum256([]byte(bearer))
		var reader int64
		if err := r.pool.QueryRow(ctx, `SELECT user_id FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(digest[:])).Scan(&reader); err != nil {
			return workspaceapi.CommandResult{}, err
		}
		r.reader.Store(reader)
		r.readers.Store(id, reader)
		r.t.Logf("clone token workspace=%s user=%d", id, reader)
		if r.deny.CompareAndSwap(true, false) {
			command.Args = append([]string(nil), command.Args...)
			command.Args[len(command.Args)-1] = r.unauthorized + "/repo.git"
			result, err := r.bindingProcessRuntime.ExecuteCommand(ctx, id, command)
			r.denied <- id
			return result, err
		}
	}
	return r.bindingProcessRuntime.ExecuteCommand(ctx, id, command)
}

func recoveryInstall(t *testing.T) (*rehearsal, *startRecoveryRuntime) {
	r := newRehearsal(t, "SMITHERS_START_RECOVERY_REHEARSAL", "C-start-recovery", "start-recovery-")
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("composition logs:\n%s", r.logs.String())
		}
	})
	require.True(t, r.install("Install through Machine ready"))
	require.NoError(t, r.waitStackActive())
	require.NoError(t, r.waitSQL(90*time.Second, `SELECT count(*) FROM flow_loads WHERE loaded_commit=commit_id AND loaded_commit<>''`))
	base, ok := r.workspaceRuntime.(bindingProcessRuntime)
	require.True(t, ok, "proof needs the trusted-process coding runtime")
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { http.Error(w, "unauthorized", http.StatusUnauthorized) }))
	t.Cleanup(denied.Close)
	runtime := &startRecoveryRuntime{bindingProcessRuntime: base, denied: make(chan string, 1), unauthorized: denied.URL}
	r.options.Workspace = runtime
	// One machine, one ordered TODO. Synthetic host measurements, not Mac proof.
	r.options.HostProfile.MemoryBytes = 16 << 30
	r.options.HostProfile.PerfCores = 2
	r.restartBackend()
	return r, runtime
}

func TestStartRecoveryClone401ReleasesAndRetries(t *testing.T) {
	r, runtime := recoveryInstall(t)
	runtime.deny.Store(true)
	runtime.failDelete.Store(true)
	first, err := r.file("Failed start", "[PR] [FILE FIRST.md] Add the first change.")
	require.NoError(t, err)
	second, err := r.file("Next start", "[PR] [FILE SECOND.md] Add the next change.")
	require.NoError(t, err)
	var id string
	select {
	case id = <-runtime.denied:
	case <-time.After(40 * time.Second):
		t.Fatal("clone did not reach the HTTP 401")
	}
	// Before the fix admission's two stage writes change updated_at while vm_id
	// is empty; the old failure CAS silently matches no row.
	require.NoError(t, r.waitSQL(30*time.Second, `SELECT count(*) FROM workspaces WHERE id=$1 AND status='failed' AND failure_message LIKE '%advertisement%'`, id))
	failed, err := r.waitTodoWithin(first, 45*time.Second, "failed")
	require.NoError(t, err)
	require.Equal(t, "failed", failed.State)
	data, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", first), "", 200)
	require.NoError(t, err)
	require.Contains(t, string(data), `"retryable":true`)
	require.Eventually(t, func() bool {
		_, err := runtime.InspectWorkspace(t.Context(), id)
		return errors.Is(err, workspaceapi.ErrWorkspaceNotFound)
	}, 15*time.Second, 100*time.Millisecond, "failed initial VM is reaped even after a cleanup transport failure")
	require.NoError(t, r.waitSQL(15*time.Second, `SELECT count(*) FROM workspaces WHERE id=$1 AND status='failed' AND provisioning_stage='start_cleanup_complete'`, id))
	require.NoError(t, r.waitSQL(45*time.Second, `SELECT count(*) FROM mythical_items i JOIN workspaces w ON w.id::text=i.workspace_id WHERE i.number=$1 AND w.status='running'`, second))
	// Finish the second TODO, then use ordinary Sleep to release its retained
	// branch before the person's Retry consumes the only machine again.
	finished, err := r.waitTodoWithin(second, 90*time.Second, "in_review")
	require.NoError(t, err)
	require.NotNil(t, finished.Branch)
	require.NoError(t, r.sleepRebaseBranch(finished.Branch.ID))
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", second), `{"op":"drop"}`, 202)
	require.NoError(t, err)
	_, err = r.expect("POST", fmt.Sprintf("/api/todos/%d", first), `{"op":"retry"}`, 202)
	require.NoError(t, err)
	require.NoError(t, r.waitSQL(45*time.Second, `SELECT count(*) FROM mythical_items i JOIN workspaces w ON w.id::text=i.workspace_id WHERE i.number=$1 AND w.status='running' AND w.id<>$2::uuid`, first, id))
	var owner int64
	require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT id FROM users WHERE lower_username='rehearsal-owner'`).Scan(&owner))
	require.Equal(t, owner, runtime.reader.Load())

}

// Persist the crash boundary the install left behind: branch binding and
// person's share exist, but no requester survives in the restarted host.
func seedInterruptedCatalogStart(t *testing.T, r *rehearsal, state string) (string, int64) {
	t.Helper()
	r.stopBackend()
	ctx := t.Context()
	q := db.New(r.pool)
	var owner, repo int64
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT id FROM users WHERE lower_username='rehearsal-owner'`).Scan(&owner))
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository'`).Scan(&repo))
	var id string
	require.NoError(t, r.pool.QueryRow(ctx, `SELECT id::text FROM workspaces WHERE repository_id=$1 AND name LIKE 'flow-load g%' AND source_commit<>'' ORDER BY created_at DESC LIMIT 1`, repo).Scan(&id))
	row, err := q.GetWorkspace(ctx, id)
	require.NoError(t, err)
	if state == "starting" {
		// This boundary predates guest admission. Remove the completed setup
		// guest and its native transport/journal before replaying a first boot;
		// retaining an old admitted daemon would describe a different crash.
		require.NoError(t, r.options.Workspace.StopWorkspace(ctx, row.ID))
		require.NoError(t, r.processRuntime.DeleteWorkspace(ctx, row.ID))
		if runtime, ok := r.options.Workspace.(*startRecoveryRuntime); ok {
			runtime.daemonStates.Delete(row.ID)
		}
	}
	_, err = r.pool.Exec(ctx, `UPDATE workspaces SET status=$2::text,name='flow-load g999',vm_id=CASE WHEN $2::text='starting' THEN '' ELSE vm_id END,provisioning_stage='',updated_at=now()-interval '11 minutes' WHERE id=$1`, row.ID, state)
	require.NoError(t, err)

	_, err = r.pool.Exec(ctx, `UPDATE flow_loads SET workspace_id=$1,state='running',generation=999,run_id='',outcome='',started_at=now(),version=version+1 WHERE repository_id=$2`, row.ID, repo)
	require.NoError(t, err)
	return row.ID, owner
}

func TestStartRecoveryRestartClonesAsPerson(t *testing.T) {
	r, runtime := recoveryInstall(t)
	id, person := seedInterruptedCatalogStart(t, r, "starting")
	r.restartBackend()
	require.NoError(t, r.waitSQL(45*time.Second, `SELECT count(*) FROM workspaces WHERE id=$1 AND status='running'`, id))
	reader, _ := runtime.readers.Load(id)
	require.Equal(t, person, reader, "no HTTP requester: the clone token belongs to the durable person, not smithers-machines")
	data, err := r.expect("GET", "/api/install", "", 200)
	require.NoError(t, err)
	require.Contains(t, string(data), `"capacity":1`)
}

func TestStartRecoveryRestartSettlesCatalogRelease(t *testing.T) {
	startRecoveryCatalogRelease(t, false)
}

func TestStartRecoveryRestartSettlesLiveCatalogRelease(t *testing.T) {
	startRecoveryCatalogRelease(t, true)
}

func startRecoveryCatalogRelease(t *testing.T, live bool) {
	t.Helper()
	r, runtime := recoveryInstall(t)
	id, _ := seedInterruptedCatalogStart(t, r, "releasing")
	// The host died before publishing final capture/status. Keep the real
	// process checkout across recomposition, with a stopped or still-live guest.
	ctx := t.Context()
	_, err := runtime.Runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	if live {
		observed, err := runtime.Runtime.StartWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, workspaceapi.WorkspaceRunning, observed.State)
	} else {
		require.NoError(t, runtime.Runtime.StopWorkspace(ctx, id))
	}
	_, err = r.pool.Exec(ctx, `UPDATE workspaces SET vm_id=$1::text,updated_at=now() WHERE id=$1::uuid`, id)
	require.NoError(t, err)
	_, err = r.pool.Exec(ctx, `UPDATE flow_loads SET state='idle',loaded_commit='',next_attempt_at=now(),version=version+1 WHERE workspace_id=$1`, id)
	require.NoError(t, err)
	r.restartBackend()
	require.NoError(t, r.waitSQL(45*time.Second, `SELECT count(*) FROM workspaces WHERE id=$1 AND status='failed' AND failure_message LIKE '%release interrupted%'`, id))
	nextMain, err := r.pushGitHubMain("Catalog after interrupted release", map[string]string{"JOURNEY.md": "Catalog recovery\n"})
	require.NoError(t, err)
	// Replacement catalog generation must provision and finish, not remain
	// waiting behind the old stopped machine.
	require.NoError(t, r.waitSQL(90*time.Second, `SELECT count(*) FROM flow_loads WHERE generation>999 AND loaded_commit=commit_id AND loaded_commit=$2 AND workspace_id<>$1`, id, nextMain))
	_, err = r.expect("GET", "/api/install", "", 200)
	require.NoError(t, err)
}
