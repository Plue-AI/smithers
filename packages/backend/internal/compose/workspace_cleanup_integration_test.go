package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/operations"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type cleanupInstallRuntime struct{ *process.Runtime }

func (*cleanupInstallRuntime) ReclaimWorkspaceDisk(context.Context, string) error {
	panic("unavailable capture/broker must retain install disk")
}

// This fake supplies the missing dependency contract to exercise the durable
// pending-capture guard through the actual install cleaner and HTTP projection.
type cleanupPendingInstallRuntime struct {
	*cleanupInstallRuntime
	calls int
}

func (r *cleanupPendingInstallRuntime) WithFinalCapture(_ context.Context, row workspaceapi.CleanupWorkspace, fn func(workspaceapi.DiskReclaimCapture) error) error {
	r.calls++
	return fn(workspaceapi.DiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: row.Head, RetainedHead: row.Head, CaptureID: "fixture-capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true})
}

// Isolate other scheduler jobs, while the production reclaim service is the
// very instance serving the install's HTTP branch read.
type cleanupInstallTick struct {
	*services.WorkspaceService
	done chan struct{}
}

func (*cleanupInstallTick) CleanupIdleSessions(context.Context) error           { return nil }
func (*cleanupInstallTick) CleanupStalePendingWorkspaces(context.Context) error { return nil }
func (*cleanupInstallTick) CleanupIdleWorkspaces(context.Context) error         { return nil }
func (*cleanupInstallTick) CleanupOverQuotaWorkspaces(context.Context) error    { return nil }
func (*cleanupInstallTick) CleanupAbandonedWorkspaces(context.Context) error    { return nil }
func (*cleanupInstallTick) ReapWorkspaceChildren(context.Context) error         { return nil }
func (s *cleanupInstallTick) CleanupOrphanFlowJournals(context.Context) error {
	select {
	case s.done <- struct{}{}:
	default:
	}
	return nil
}

func TestCleanupComposedInstallRetainsWithoutCaptureBroker(t *testing.T) {
	testCleanupComposedInstallRetains(t, false)
}

func TestCleanupComposedInstallRetainsPendingCapture(t *testing.T) {
	testCleanupComposedInstallRetains(t, true)
}

func testCleanupComposedInstallRetains(t *testing.T, pending bool) {
	_, _, pool := splitProcessDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "cleanupowner", LowerUsername: "cleanupowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"cleanupowner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for key, value := range map[string]string{"setup.step.source": `{"id":"source","status":"done"}`, "setup.source.repository": `"cleanupowner/demo"`, "github.repository": binding, "owner.access": binding} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	cookie := "cleanup-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, TargetBookmark: "scratch/member/retained", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='retained',head_commit_id='head',branch_archived_at=now()-interval '30 days' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)
	var service *services.WorkspaceService
	var installRuntime workspaceapi.WorkspaceRuntime = &cleanupInstallRuntime{runtime}
	fenced := &cleanupPendingInstallRuntime{cleanupInstallRuntime: &cleanupInstallRuntime{runtime}}
	if pending {
		_, err = pool.Exec(ctx, `UPDATE workspaces SET capture_pending='{"head":"head"}'::jsonb WHERE id=$1`, row.ID)
		require.NoError(t, err)
		installRuntime = fenced
	}
	handler := startSplitProcess(t, Options{FlowHostProductAPIURL: "http://127.0.0.1:4000", Workspace: installRuntime, BranchMachines: &providers, ChatHost: unusedChatHost{}, ReadyBindings: func(b operations.Bindings) { service = b.Workspaces.(*services.WorkspaceService) }})
	require.NotNil(t, service)
	tick := &cleanupInstallTick{service, make(chan struct{}, 1)}
	runner := cleanup.NewWorkspaceCleaner(tick, 100*time.Millisecond)
	runner.Start(ctx)
	select {
	case <-tick.done:
	case <-time.After(5 * time.Second):
		runner.Stop()
		t.Fatal("no cleanup tick")
	}
	runner.Stop()
	stored, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.False(t, stored.DiskReclaimedAt.Valid)
	require.Empty(t, stored.CleanupPendingHead)
	require.False(t, stored.DeletedAt.Valid)
	if pending {
		require.GreaterOrEqual(t, fenced.calls, 1)
		require.JSONEq(t, `{"head":"head"}`, string(stored.CapturePending))
	}
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4000/api/branches/"+row.ID, nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	var branch services.BranchMachineResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &branch))
	require.Equal(t, row.TargetBookmark, branch.Name)
	require.Equal(t, "head", branch.Head)
	// The member action records the time, retains its disk and is replay-safe.
	_, err = pool.Exec(ctx, `UPDATE workspaces SET branch_archived_at=NULL WHERE id=$1`, row.ID)
	require.NoError(t, err)
	archive := func(status int) {
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:4000/api/branches/"+row.ID+"/archive", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("X-CSRF-Token", "archive-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "archive-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		require.Equal(t, status, res.Code, res.Body.String())
	}
	archive(200)
	archived, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.True(t, archived.BranchArchivedAt.Valid)
	require.False(t, archived.DiskReclaimedAt.Valid)
	require.Equal(t, "retained", archived.VmID)
	archive(200)
	repeated, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, archived.BranchArchivedAt, repeated.BranchArchivedAt)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &branch))
	require.Equal(t, "closed", branch.State)

}
