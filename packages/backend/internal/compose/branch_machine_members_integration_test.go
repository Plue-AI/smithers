package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

// Composed install HTTP, real sessions and PostgreSQL. The retained machine
// is a fixture; this verifies member admission and removal, not VM isolation.
func TestBranchMachineMemberAccessAndRevocationInstall(t *testing.T) {
	branchMachineMemberInstall(t, false)
}

func TestBranchMachineMemberErasureInstall(t *testing.T) {
	branchMachineMemberInstall(t, true)
}

func branchMachineMemberInstall(t *testing.T, erase bool) {
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
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
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
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: unusedChatHost{}, Workspace: runtime, FlowHostProductAPIURL: "http://127.0.0.1:4000", FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}, BranchMachines: rehearsalBranchMachines(pool)}))
	defer server.Close()
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	machine, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, TargetBookmark: "mythical", Kind: "container", Status: "running", EnvironmentSource: "repository"})
	require.NoError(t, err)
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo.ID, IssueTitle: "shared TODO"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{RepositoryID: repo.ID, ItemID: item.ID, WorkspaceID: machine.ID, Name: "shared lane"})
	require.NoError(t, err)
	for _, u := range []db.User{ben, alice} {
		_, err := q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: machine.ID, OwnerUserID: machineOwner, GranteeUserID: u.ID, Level: "write"})
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `UPDATE users SET created_at='2026-10-01T00:00:00Z' WHERE id=$1`, ben.ID)
	require.NoError(t, err)
	ownerCookie := session(owner)
	call := func(method, path, body, cookie string, expected int) string {
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
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
	// Ben never owns the repository or machine. Direct erasure of a current
	// member and roster removal each leave Alice's machine row intact.
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, machine.ID, machineOwner).Scan(&machines))
	require.Equal(t, 1, machines)
}
