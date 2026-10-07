package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Only the machine RPC is recorded: the mounted relay, cookie/CSRF middleware,
// PostgreSQL workspace lookup and renewed host authority are production code.
func TestBrowserFlowDraftComposedAdmission(t *testing.T) {
	b := newRelayBoxes(t)
	box := b.box(b.repo, b.owner, "running")
	b.exec(`UPDATE workspaces SET target_bookmark='scratch/owner/draft' WHERE id=$1`, box)
	cookie := "draft-session-" + box
	hash := sha256.Sum256([]byte(cookie))
	_, err := b.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: b.owner, Username: b.login, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	dispatcher := &draftAuthorityDispatcher{resolver: browserFlowTarget{queries: b}}
	api := b.api()
	api.dispatcher = dispatcher
	cfg := testConfigAllFlagsOn()
	cfg.Auth.SessionCookieName = "session"
	router := chi.NewRouter()
	mountBrowserFlow(router, cfg, b.Queries, api)
	call := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/workflow/rpc", strings.NewReader(b.body(b.repo, box, "Plan", `{"flowId":"todo","input":{}}`)))
		req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	res := call()
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
	res = call()
	require.Equal(t, http.StatusForbidden, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), "todo_requires_stack_admission")
	require.Len(t, dispatcher.calls, 1)
}

type draftAuthorityDispatcher struct {
	browserFlowRecordingDispatcher
	resolver browserFlowTarget
}

func (d *draftAuthorityDispatcher) CallRPC(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	if _, err := d.resolver.ResolveFlowHostTarget(ctx, target); err != nil {
		return nil, err
	}
	return d.browserFlowRecordingDispatcher.CallRPC(ctx, target, procedure, payload)
}
