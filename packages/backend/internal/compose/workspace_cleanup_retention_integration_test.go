package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/stretchr/testify/require"
)

// A member's legacy delete door cannot bypass branch cleanup, even for a
// scratch branch with no TODO/lane binding. This uses the composed install.
func TestCleanupScratchRetentionThroughInstallHTTP(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	t.Setenv("SMITHERS_FEATURE_FLAGS_WORKSPACES", "true")
	t.Setenv("SMITHERS_FEATURE_FLAGS_SANDBOXES", "true")
	q, ctx := db.New(pool), t.Context()
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, member.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: member.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, member.ID)
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner, Name: "scratch", TargetBookmark: "scratch", Kind: "vm", EnvironmentSource: ".smithers/environment.nix", Status: "suspended"})
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: row.ID, OwnerUserID: owner, GranteeUserID: member.ID, Level: "write"})
	require.NoError(t, err)
	const cookie = "cleanup-member-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: member.ID, Username: member.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	// Policy proof uses the rehearsal's trusted-process runtime. It creates
	// no guest and is not real-microVM or root-boundary qualification.
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: unusedChatHost{}, ComputeProvider: sandboxfake.New(), Workspace: runtime, BranchMachines: rehearsalBranchMachines(pool),
		FlowHostProductAPIURL: "http://127.0.0.1:4000", FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}}))
	defer server.Close()
	req, err := http.NewRequest(http.MethodDelete, server.URL+"/api/repos/owner/demo/workspaces/"+row.ID, nil)
	require.NoError(t, err)
	req.Host = "127.0.0.1:4000"
	req.Header.Set("X-CSRF-Token", "cleanup-csrf")
	req.Header.Set("Origin", "http://127.0.0.1:4000")
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "cleanup-csrf"})
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
	res, err := server.Client().Do(req)
	require.NoError(t, err)
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusConflict, res.StatusCode, string(body))
	require.Contains(t, string(body), "branch is retained")
	retained, err := q.GetWorkspaceIncludingDeleted(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "suspended", retained.Status)
	require.False(t, retained.DeletedAt.Valid)
}
