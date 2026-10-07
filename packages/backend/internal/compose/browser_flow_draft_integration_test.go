package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Only the machine RPC is recorded: the mounted relay, cookie/CSRF middleware,
// PostgreSQL workspace lookup and renewed host authority are production code.
func TestBrowserFlowDraftComposedAdmission(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	b := newRelayBoxesIn(t, pool)
	b.exec(`INSERT INTO self_host_owners(user_id) VALUES($1)`, b.owner)
	for key, value := range map[string]string{
		"github.repository": fmt.Sprintf(`{"owner_login":%q,"repository_name":"repo","repository_id":%d}`, b.login, b.repo.ID),
		"owner.access":      fmt.Sprintf(`{"owner_login":%q,"repository_name":"repo","repository_id":%d,"last_access_check_at":%q}`, b.login, b.repo.ID, time.Now().UTC().Format(time.RFC3339)),
	} {
		require.NoError(t, b.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	box := b.box(b.repo, b.owner, "running")
	b.exec(`UPDATE workspaces SET target_bookmark='scratch/owner/draft' WHERE id=$1`, box)
	cookie := "draft-session-" + box
	hash := sha256.Sum256([]byte(cookie))
	_, err := b.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: b.owner, Username: b.login, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	dispatcher := &draftAuthorityDispatcher{resolver: browserFlowTarget{queries: b}}
	api := b.api()
	api.installTransactions = pool
	api.dispatcher = dispatcher
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeSelfHosted
	cfg.Auth.SessionCookieName = "session"
	router := chi.NewRouter()
	mountBrowserFlow(router, cfg, b.Queries, api)
	require.True(t, api.install)
	call := func(procedure, flow string) *httptest.ResponseRecorder {
		payload := `{}`
		if procedure == "Plan" {
			payload = fmt.Sprintf(`{"flowId":%q,"input":{}}`, flow)
		}
		req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/workflow/rpc", strings.NewReader(b.body(b.repo, box, procedure, payload)))
		req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	res := call("Plan", "todo")
	require.Equal(t, 200, res.Code, res.Body.String())
	require.Len(t, dispatcher.calls, 1)
	target := dispatcher.calls[0].target
	require.Equal(t, "draft-flow", target.BindingKind)
	authority, err := dispatcher.resolver.ResolveFlowHostTarget(t.Context(), target)
	require.NoError(t, err)
	require.Nil(t, authority.ExecutionPin)
	// A stale draft target cannot keep its authority after branch conversion.
	b.exec(`UPDATE workspaces SET target_bookmark='smithers/filed' WHERE id=$1`, box)
	_, err = dispatcher.resolver.ResolveFlowHostTarget(t.Context(), target)
	require.ErrorContains(t, err, "draft Flow workspace is unavailable")
	res = call("Plan", "todo")
	require.Equal(t, http.StatusForbidden, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), "todo_requires_stack_admission")
	require.Len(t, dispatcher.calls, 1)
	// The browser can reach a granted TODO machine before its first stack
	// host starts. Its host binding still needs the admitted immutable pin.
	box = b.box(b.repo, b.machines, "running", b.owner)
	_, err = b.RequestMythicalBootstrap(t.Context(), b.repo.ID, b.owner, 100, false)
	require.NoError(t, err)
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	var item string
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO mythical_items(repository_id,issue_number,issue_title,state,attempt,workspace_id,flow_digest,checks) VALUES($1,1,'Pinned browser','queued',1,$2,$3,jsonb_build_object('flowSource',$4::text)) RETURNING id::text`, b.repo.ID, box, digest, source).Scan(&item))
	b.exec(`INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'attempt-one')`, box, b.repo.ID, item)
	res = call("List", "hello")
	require.Equal(t, http.StatusOK, res.Code, res.Body.String())
	require.Len(t, dispatcher.calls, 2)
	require.Equal(t, "browser-flow", dispatcher.calls[1].target.BindingKind)
	require.NotNil(t, dispatcher.spec)
	require.Equal(t, "1", dispatcher.spec.Environment["SMITHERS_FLOW_SOURCE_PINNED"])
	require.Equal(t, digest, dispatcher.spec.Environment["SMITHERS_TODO_EXECUTION_DIGEST"])
	require.Equal(t, source, dispatcher.spec.Environment["SMITHERS_SOURCE_REVISION"])
	require.NotContains(t, dispatcher.spec.Environment, "SMITHERS_FLOW_DRAFT_VERSION")
}

type draftAuthorityDispatcher struct {
	browserFlowRecordingDispatcher
	resolver browserFlowTarget
	spec     *flowhost.ProcessSpec
}

func (d *draftAuthorityDispatcher) CallRPC(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	authority, err := d.resolver.ResolveFlowHostTarget(ctx, target)
	if err != nil {
		return nil, err
	}
	if authority.ExecutionPin != nil {
		// The machine transport is a fixture; pin resolution and production
		// launch assembly are real, and must refuse before any machine RPC.
		spec, err := flowhost.BuildProcessSpec(flowhost.HostLaunch{
			Binding: flowhost.Binding{ID: uuid.NewString(), TenantID: target.TenantID, PrincipalID: target.PrincipalID,
				BindingKind: target.BindingKind, BindingID: target.BindingID, RepositoryID: authority.RepositoryID, UserID: authority.UserID,
				WorkspaceID: authority.WorkspaceID, SourceRevision: authority.SourceRevision, CatalogKey: flowhost.CatalogCoding,
				RuntimeArtifactDigest: strings.Repeat("c", 64), OwnerGeneration: 1, State: "pending"},
			Authority: authority, Credential: "test-bearer",
			Catalog: flowhost.Catalog{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/opt/smithers/coding-host", ArtifactDigest: strings.Repeat("c", 64)},
		}, flowhost.WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 7331)
		if err != nil {
			return nil, err
		}
		d.spec = &spec
	}
	return d.browserFlowRecordingDispatcher.CallRPC(ctx, target, procedure, payload)
}
