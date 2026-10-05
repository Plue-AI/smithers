package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// The public bookmark routes refuse an install's main and default bookmark
// themselves, with the §6.2.3 permission envelope and no engine call, for
// every credential; hosted routes and other bookmarks reach the engine.
func TestJJVCSHandler_InstallMainBookmarkWritesRefusedAtAdmission(t *testing.T) {
	t.Parallel()
	for _, install := range []bool{true, false} {
		var engineCalls atomic.Int32
		engine := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			engineCalls.Add(1)
			if r.Method == http.MethodDelete {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(repohost.Bookmark{Name: "x"})
		})
		h := &JJVCSHandler{RepoHost: repohost.NewLocalClientWithStagingEndpoint(engine, "test-token", "http://127.0.0.1:1", install),
			RepoResolver: jjVCSLegacyResolver{}, WebhookDispatcher: jjVCSNoopDispatcher{}}
		request := func(method, name string, kind middleware.CredentialKind) *httptest.ResponseRecorder {
			var req *http.Request
			params := map[string]string{"owner": "alice", "repo": "demo"}
			if method == http.MethodPost {
				req = httptest.NewRequest(method, "/api/repos/alice/demo/bookmarks", strings.NewReader(`{"name":"`+name+`","target_change_id":"chg"}`))
				req.Header.Set("Content-Type", "application/json")
			} else {
				req = httptest.NewRequest(method, "/api/repos/alice/demo/bookmarks/"+url.PathEscape(name), nil)
				params["name"] = name
			}
			req = withJJRouteParams(req, params)
			info := &middleware.AuthInfo{User: &db.User{ID: 1, Username: "alice"}}
			if kind == middleware.CredentialAgentRun {
				info.IsTokenAuth, info.TokenSystemIssued, info.RawScopes = true, true, "write:repository,repo:1,agent-session:s1"
			}
			ctx := middleware.ContextWithAuthInfo(req.Context(), info)
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "alice",
				Repository: &db.Repository{ID: 1, Name: "demo", DefaultBookmark: "trunk"}}, middleware.PermissionWrite)
			rec := httptest.NewRecorder()
			if method == http.MethodPost {
				h.CreateBookmark(rec, req.WithContext(ctx))
			} else {
				h.DeleteBookmark(rec, req.WithContext(ctx))
			}
			return rec
		}
		for _, kind := range []middleware.CredentialKind{middleware.CredentialPerson, middleware.CredentialAgentRun} {
			for _, name := range []string{"main", "MAIN", "ma‌in", "trunk", "Trunk"} {
				for _, method := range []string{http.MethodPost, http.MethodDelete} {
					before := engineCalls.Load()
					rec := request(method, name, kind)
					if !install {
						continue
					}
					require.Equal(t, http.StatusForbidden, rec.Code, "%s %s %s: %s", kind, method, name, rec.Body.String())
					var envelope map[string]any
					require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &envelope))
					assert.Equal(t, "permission", envelope["code"])
					assert.Equal(t, "permission", envelope["class"])
					assert.Equal(t, before, engineCalls.Load(), "%s %s %s reached the engine", kind, method, name)
				}
			}
		}
		before := engineCalls.Load()
		require.Equal(t, http.StatusCreated, request(http.MethodPost, "feature", middleware.CredentialPerson).Code)
		require.Equal(t, http.StatusNoContent, request(http.MethodDelete, "feature", middleware.CredentialPerson).Code)
		assert.Equal(t, before+2, engineCalls.Load())
		if !install {
			before = engineCalls.Load()
			require.Equal(t, http.StatusCreated, request(http.MethodPost, "main", middleware.CredentialPerson).Code, "hosted main stays a person's")
			assert.Equal(t, before+1, engineCalls.Load())
		}
	}
}
