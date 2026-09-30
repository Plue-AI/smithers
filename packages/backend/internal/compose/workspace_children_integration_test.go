package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A running workspace's children credential reaches its own children routes
// over real HTTP and nothing else (#2802).
func TestWorkspaceChildrenCredentialOverHTTPPostgres(t *testing.T) {
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	repoHost := httptest.NewServer(&isolationRepoHost{})
	t.Cleanup(repoHost.Close)
	for name, value := range map[string]string{
		"SMITHERS_AUTH_MODE":                     "multitenant",
		"SMITHERS_BILLING_MODE":                  "metered",
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_SERVER_SHUTDOWN_TIMEOUT":       "10s",
		"SMITHERS_REPO_HOST_URL":                 repoHost.URL,
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "children-repo",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "children-callback",
		"SMITHERS_AUTH_SESSION_SECRET":           "children-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "children-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "children-webhook-key",
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_OTEL_EXPORTER":                 "none",
		"SMITHERS_METRICS_TOKEN":                 "children-metrics",
		"SMITHERS_METRICS_ADDR":                  "",
		"SMITHERS_REMOTE_SANDBOX_ENABLED":        "true",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES":      "true",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "true",
	} {
		t.Setenv(name, value)
	}
	provider := sandboxfake.New()
	policy, err := admission.NewMetered(pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	server := httptest.NewServer(startSplitProcess(t, Options{Admission: policy, ComputeProvider: provider}))
	t.Cleanup(server.Close)

	ctx := context.Background()
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "carol", LowerUsername: "carol", DisplayName: "carol"})
	require.NoError(t, err)
	_, err = q.InsertBillingPlanGrant(ctx, db.InsertBillingPlanGrantParams{OwnerType: "user", OwnerID: user.ID,
		SourceKey: "children-test", PlanKey: "pro", ExpiresAt: time.Now().Add(time.Hour), Actor: "test", Reason: "children"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true},
		Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	running := func(name string) db.Workspace {
		row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: user.ID, Name: name,
			TargetBookmark: "main", Kind: "container", EnvironmentSource: ".smithers/environment.nix", Status: "starting"})
		require.NoError(t, err)
		row, err = q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: row.ID, VmID: provider.Boot(nil), Status: "running"})
		require.NoError(t, err)
		return row
	}
	parent, other := running("parent"), running("other")
	token := func(name, scopes string) string {
		sum := sha256.Sum256([]byte(name))
		plaintext := "smithers_" + hex.EncodeToString(sum[:])[:40]
		hash := sha256.Sum256([]byte(plaintext))
		hashString := hex.EncodeToString(hash[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: name, TokenHash: hashString,
			TokenLastEight: hashString[len(hashString)-8:], SystemIssued: true, Scopes: scopes,
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return plaintext
	}
	children := token("children", "read:repository,write:workspace,"+middleware.RepositoryRestrictionScope(repo.ID)+","+
		middleware.WorkspaceRestrictionScope(parent.ID)+","+middleware.WorkspaceChildrenCredentialScope())
	head := token("head", "write:repository,"+middleware.RepositoryRestrictionScope(repo.ID)+","+middleware.WorkspaceRestrictionScope(parent.ID))
	base := "/api/repos/carol/demo/workspaces/"
	call := func(bearer, method, path, body string) isolationResponse {
		var payload []byte
		if body != "" {
			payload = []byte(body)
		}
		return isolationRequest(t, server, bearer, method, path, payload)
	}

	spawned := call(children, http.MethodPost, base+parent.ID+"/children", `{"count":2,"profile":"small"}`)
	require.Equal(t, http.StatusAccepted, spawned.status, spawned.body)
	var batch struct {
		Children []struct {
			WorkspaceID string `json:"workspace_id"`
		} `json:"children"`
	}
	require.NoError(t, json.Unmarshal([]byte(spawned.body), &batch))
	require.Len(t, batch.Children, 2)

	listed := call(children, http.MethodGet, base+parent.ID+"/children", "")
	require.Equal(t, http.StatusOK, listed.status, listed.body)
	require.Contains(t, listed.body, batch.Children[0].WorkspaceID)

	stopped := call(children, http.MethodPost, base+parent.ID+"/children/"+batch.Children[0].WorkspaceID+"/stop", "")
	require.Equal(t, http.StatusOK, stopped.status, stopped.body)
	require.Contains(t, stopped.body, `"stop_reason":"requested"`)

	for name, tc := range map[string]struct{ bearer, method, path, body string }{
		"another workspace's children": {children, http.MethodPost, base + other.ID + "/children", `{"count":1}`},
		"its own workspace":            {children, http.MethodGet, base + parent.ID, ""},
		"a fork":                       {children, http.MethodPost, base + parent.ID + "/fork", `{}`},
		"the head report":              {children, http.MethodPost, base + parent.ID + "/head", `{}`},
		"the account":                  {children, http.MethodGet, "/api/user", ""},
		"the head token spawning":      {head, http.MethodPost, base + parent.ID + "/children", `{"count":1}`},
		"a new access token":           {children, http.MethodPost, "/api/user/tokens", `{"name":"x","scopes":["all"]}`},
	} {
		got := call(tc.bearer, tc.method, tc.path, tc.body)
		require.Equal(t, http.StatusForbidden, got.status, name+": "+got.body)
	}
	var live int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_children WHERE user_id = $1`, user.ID).Scan(&live))
	require.Equal(t, 2, live, "no refused request spawned a child")
}
