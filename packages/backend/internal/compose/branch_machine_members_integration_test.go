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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Composed install HTTP, real sessions and PostgreSQL. The retained machine
// is a fixture; this verifies member admission and removal, not VM isolation.
func TestBranchMachineMemberAccessAndRevocationInstall(t *testing.T) {
	branchMachineMemberInstall(t, false, false, false, "")
}

func TestBranchMachineMemberErasureInstall(t *testing.T) {
	branchMachineMemberInstall(t, true, false, false, "")
}

func TestBranchMachineConcurrentJoinHTTP(t *testing.T) {
	branchMachineMemberInstall(t, false, true, false, "")
}

// Real-machine receipt for concurrent joins and erasure of a member. Guest
// session supervision and the coding agent's tool door are proved by W7/W8.
func TestBranchMachineConcurrentJoinRealMicroVM(t *testing.T) {
	if os.Getenv("SMITHERS_MICROSANDBOX_BIN") == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_MICROSANDBOX_BIN required")
		}
		t.Skip("real microVM opt-in absent")
	}
	branchMachineMemberInstall(t, true, true, true, "")
}

// Supplemental composed HTTP evidence only: the process runtime is a file
// fixture, never an install execution fallback. C-MCH-01 still requires Ben's
// terminal and the agent's tool on a real microVM with provisioned identities.
func TestBranchMachineSharedWorkingCopy(t *testing.T) {
	t.Run("HTTP file bytes survive member erasure", func(t *testing.T) {
		branchMachineMemberInstall(t, true, false, false, "")
	})
}

// Supplemental fail-closed evidence: without root-input qualification the
// production join route must not grant access or create another workspace.
// Fresh/retained real-VM R1-R5 qualification remains a reference-host check.
func TestBranchMachineRootInputsValidated(t *testing.T) {
	for _, gate := range []string{"microvm", "identity"} {
		t.Run(gate, func(t *testing.T) { branchMachineMemberInstall(t, false, false, false, gate) })
	}
}

// Runtime inspection is an external effect sentinel. Holding it unresolved
// proves HTTP joins do not wait for launch, while no repository code runs on
// the host and no VM qualification is inferred from this PostgreSQL proof.
type pendingBranchInspection struct {
	*process.Runtime
	release chan struct{}
	entered chan struct{}
	started sync.Once
	once    sync.Once
}

func (r *pendingBranchInspection) finish() { r.once.Do(func() { close(r.release) }) }
func (r *pendingBranchInspection) InspectWorkspace(ctx context.Context, _ string) (workspaceapi.Workspace, error) {
	r.started.Do(func() { close(r.entered) })
	select {
	case <-ctx.Done():
		return workspaceapi.Workspace{}, ctx.Err()
	case <-r.release:
		return workspaceapi.Workspace{}, errors.New("retained inspection fixture unavailable")
	}
}

func branchMachineMemberInstall(t *testing.T, erase, concurrent, realMachine bool, qualification string) {
	t.Cleanup(func() {
		require.Nil(t, revocationChecker, "install shutdown releases the revoked member identities before another install starts")
	})
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := user("owner"), user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	for _, u := range []db.User{owner, ben, alice} {
		permission := "admin"
		if u.ID == alice.ID {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login) VALUES($1,$2,$3,$4)`, repo.ID, u.ID, permission, u.Username)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		key := u.Username + "-view-cookie"
		hash := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	benCookie, aliceCookie := session(ben), session(alice)
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	var runtimeBoundary workspaceapi.WorkspaceRuntime = runtime
	pending := &pendingBranchInspection{Runtime: runtime, release: make(chan struct{}), entered: make(chan struct{})}
	if concurrent && !realMachine {
		runtimeBoundary = pending
	}
	var vm *microsandbox.Runtime
	if realMachine {
		bundlePath := os.Getenv("SMITHERS_CHECK_BUNDLE")
		require.NotEmpty(t, bundlePath, "member provisioning requires the installed bundle")
		bundle, openErr := installbundle.Open(bundlePath)
		require.NoError(t, openErr)
		vm, err = microsandbox.New(ctx, microsandbox.Config{Bundle: bundle, Root: bundletest.ProtectedTempDir(t), CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 3})
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, vm.Close()) })
		runtimeBoundary = vm
	}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	options := Options{ChatHost: unusedChatHost{}, Workspace: runtimeBoundary, FlowHostProductAPIURL: origin, FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: !realMachine}}
	if realMachine {
		options.InstallBranchMachines = true
	} else {
		options.BranchMachines = rehearsalBranchMachines(pool)
		if qualification != "" {
			production := services.InstallBranchMachineProviders(nil, runtime)
			if qualification == "microvm" {
				options.BranchMachines.MicroVM = production.MicroVM
			} else {
				options.BranchMachines.SessionIdentity = production.SessionIdentity
			}
		}
	}
	server.Config.Handler = startSplitProcess(t, options)
	server.Start()
	defer server.Close()
	t.Cleanup(pending.finish)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	machine, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, TargetBookmark: "mythical", Kind: "container", Status: "running", EnvironmentSource: "repository"})
	require.NoError(t, err)
	if realMachine {
		operation := workspaceapi.WithOperation(ctx, workspaceapi.Operation{TenantID: "w4", PrincipalID: "owner", OperationID: "w4-create"})
		created, createErr := vm.CreateWorkspace(operation, workspaceapi.WorkspaceSpec{ID: machine.ID})
		require.NoError(t, createErr)
		t.Cleanup(func() { require.NoError(t, vm.DeleteWorkspace(context.WithoutCancel(operation), machine.ID)) })
		machine, err = q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: machine.ID, VmID: created.ID, Status: "running"})
		require.NoError(t, err)
		require.NoError(t, writeGuestFixture(vm, operation, machine.ID, "shared.txt", []byte("ben\n"), 0664))
	}
	if !realMachine && !concurrent {
		_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: machine.ID})
		require.NoError(t, err)
		require.NoError(t, runtime.WriteFile(ctx, machine.ID, "shared.txt", []byte("ben\n"), 0664))
		_, err = runtime.StartWorkspace(ctx, machine.ID)
		require.NoError(t, err)
	}
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo.ID, IssueTitle: "shared TODO"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{RepositoryID: repo.ID, ItemID: item.ID, WorkspaceID: machine.ID, Name: "shared lane"})
	require.NoError(t, err)
	if !concurrent && qualification == "" {
		for _, u := range []db.User{ben, alice} {
			_, err := q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: machine.ID, OwnerUserID: machineOwner, GranteeUserID: u.ID, Level: "write"})
			require.NoError(t, err)
		}
	}

	_, err = pool.Exec(ctx, `UPDATE users SET created_at='2026-10-01T00:00:00Z' WHERE id=$1`, ben.ID)
	require.NoError(t, err)
	ownerCookie := session(owner)
	call := func(method, path, body, cookie string, expected int) string {
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, expected, res.StatusCode, string(raw))
		return string(raw)
	}

	if qualification != "" {
		for _, cookie := range []string{benCookie, aliceCookie, ownerCookie} {
			call("POST", "/api/repos/owner/demo/workspaces", `{"source_bookmark":"mythical"}`, cookie, 503)
		}
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, repo.ID).Scan(&count))
		require.Equal(t, 1, count)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE workspace_id=$1`, machine.ID).Scan(&count))
		require.Zero(t, count)
		bytes, err := runtime.ReadFile(ctx, machine.ID, "shared.txt")
		require.NoError(t, err)
		require.Equal(t, "ben\n", string(bytes))
		return
	}
	assertSharedBytes := func() {
		var file services.WorkspaceFileContent
		require.NoError(t, json.Unmarshal([]byte(call("GET", "/api/repos/owner/demo/workspaces/"+machine.ID+"/files/content?path=shared.txt", "", aliceCookie, 200)), &file))
		require.Equal(t, "ben\n", file.Content)
		require.Equal(t, "shared.txt", file.Path)
	}
	if !concurrent {
		assertSharedBytes()
	}

	// Listing is roster-authorized, including before a member joins. The
	// database owner is the service identity, so a person-owned query is empty.
	for _, cookie := range []string{ownerCookie, benCookie, aliceCookie} {
		require.Contains(t, call("GET", "/api/branches", "", cookie, 200), machine.ID)
	}

	if concurrent {
		type receipt struct {
			status int
			id     string
			err    error
			body   string
		}
		results := make([]receipt, 60)
		start := make(chan struct{})
		var joins sync.WaitGroup
		for i := range results {
			joins.Add(1)
			go func(i int) {
				defer joins.Done()
				<-start
				cookie := []string{benCookie, aliceCookie, ownerCookie}[i%3]
				req, err := http.NewRequest("POST", server.URL+"/api/repos/owner/demo/workspaces", strings.NewReader(`{"source_bookmark":"mythical"}`))
				if err != nil {
					results[i].err = err
					return
				}
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", origin)
				req.Header.Set("X-CSRF-Token", "csrf-fixture")
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
				client := &http.Client{Timeout: 15 * time.Second}
				res, err := client.Do(req)
				if err != nil {
					results[i].err = err
					return
				}
				defer res.Body.Close()
				body, err := io.ReadAll(res.Body)
				results[i].status, results[i].body, results[i].err = res.StatusCode, string(body), err
				if err == nil && res.StatusCode == 202 {
					var v struct {
						ID string `json:"id"`
					}
					results[i].err = json.Unmarshal(body, &v)
					results[i].id = v.ID
				}
			}(i)
		}
		close(start)

		joins.Wait()
		if !realMachine {
			select {
			case <-pending.entered:
			case <-time.After(3 * time.Second):
				t.Fatal("accepted joins never reached runtime inspection")
			}
			pending.finish()
		}
		for i, v := range results {
			require.NoError(t, v.err, "join %d", i)
			require.Equal(t, 202, v.status, "join %d: %s", i, v.body)
			require.Equal(t, machine.ID, v.id, "join %d", i)
		}
		var count, active, grants int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE deleted_at IS NULL) FROM workspaces WHERE repository_id=$1 AND target_bookmark='mythical'`, repo.ID).Scan(&count, &active))
		require.Equal(t, 1, count)
		require.Equal(t, 1, active)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE workspace_id=$1 AND level='write'`, machine.ID).Scan(&grants))
		require.Equal(t, 3, grants)
	}

	if realMachine {
		// This retained fixture has no imported repository. Probe the member
		// HTTP door through validation without claiming a source-ready edit.
		call("PUT", "/api/repos/owner/demo/workspaces/"+machine.ID+"/files/content?path=shared.txt", `{"content":"ben\n","base_digest":"invalid"}`, benCookie, 400)
		require.Contains(t, call("GET", "/api/repos/owner/demo/workspaces/"+machine.ID+"/files/content?path=shared.txt", "", aliceCookie, 200), "ben")
	}
	for _, cookie := range []string{benCookie, aliceCookie} {
		require.Contains(t, call("GET", "/api/branches/mythical", "", cookie, 200), machine.ID)
	}
	call("POST", "/api/admin/users/alice/erase", `{"request_date":"2026-10-05"}`, aliceCookie, 403)
	if erase {
		data := call("POST", "/api/admin/users/ben/erase", `{"request_date":"2026-10-05"}`, ownerCookie, 200)
		require.Contains(t, data, `"workspaces":0`)
		require.Contains(t, data, `"repositories":0`)
	} else {
		call("DELETE", "/api/members/ben", "", ownerCookie, 204)
	}
	call("GET", "/api/branches/mythical", "", benCookie, 401)
	call("GET", "/api/branches", "", benCookie, 401)
	call("PUT", "/api/repos/owner/demo/workspaces/"+machine.ID+"/files/content?path=shared.txt", `{"content":"revoked","base_digest":"absent"}`, benCookie, 401)
	require.Contains(t, call("GET", "/api/branches/mythical", "", aliceCookie, 200), machine.ID)
	var shares, events, machines int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE workspace_id=$1 AND grantee_user_id=$2`, machine.ID, ben.ID).Scan(&shares))
	require.Equal(t, 0, shares)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE workspace_id=$1 AND user_id=$2 AND kind='workspace_share_removed'`, machine.ID, ben.ID).Scan(&events))
	if !erase {
		require.Equal(t, 1, events)
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1 AND user_id=$2`, machine.ID, machineOwner).Scan(&machines))
	require.Equal(t, 1, machines)
	if realMachine {
		require.Equal(t, 1, vm.InUse(), "all joins retain exactly one real VM")
		operation := workspaceapi.WithOperation(ctx, workspaceapi.Operation{TenantID: "w4", PrincipalID: "alice", OperationID: "w4-after-erase"})
		observed, inspectErr := vm.InspectWorkspace(operation, machine.ID)
		require.NoError(t, inspectErr)
		require.Equal(t, workspaceapi.WorkspaceRunning, observed.State)
		bytes, readErr := vm.ReadFile(operation, machine.ID, "shared.txt")
		require.NoError(t, readErr)
		require.Equal(t, "ben\n", string(bytes))
		require.Contains(t, call("GET", "/api/repos/owner/demo/workspaces/"+machine.ID+"/files/content?path=shared.txt", "", aliceCookie, 200), "ben")
	}
	if !concurrent {
		assertSharedBytes()
	}

	// Ben never owns the repository or machine. Direct erasure of a current
	// member and roster removal each leave Alice's machine row intact.
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, machine.ID, machineOwner).Scan(&machines))
	require.Equal(t, 1, machines)
}
