package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

type countingPoolScopes struct{ calls int }

func (s *countingPoolScopes) Scope(ctx context.Context, bearer string) (int64, int64, bool) {
	s.calls++
	return fakeScopes{ok: true}.Scope(ctx, bearer)
}

func TestProviderPoolDecisionCannotBeSubstituted(t *testing.T) {
	for _, change := range []string{"unchanged", "bearer", "credential", "method", "path", "handler", "body", "headers", "query"} {
		t.Run(change, func(t *testing.T) {
			scopes := &countingPoolScopes{}
			h := &ProviderPoolHandler{Pool: &fakePool{}, Scopes: scopes}
			request := httptest.NewRequest(http.MethodGet, "/provider-pool/routes", nil).WithContext(workspaceContext())
			request.Header.Set("Authorization", "Bearer smithers_pooltoken")
			response := httptest.NewRecorder()
			h.Authorize(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				target := h
				switch change {
				case "bearer":
					r.Header.Set("Authorization", "Bearer another")
				case "credential":
					r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 8}, IsTokenAuth: true}))
				case "method":
					r.Method = http.MethodPost
				case "path":
					r.URL.Path = "/provider-pool/another"
				case "body":
					r.Body = io.NopCloser(strings.NewReader(`{"model":"substituted"}`))
				case "headers":
					r.Header.Set("Anthropic-Beta", "substituted")
				case "query":
					r.URL.RawQuery = "substituted=true"
				case "handler":
					target = &ProviderPoolHandler{Pool: h.Pool, Scopes: scopes}
				}
				target.serveRoutes(w, r)
			})).ServeHTTP(response, request)
			require.Equal(t, 1, scopes.calls, "one scoped decision, including refused substitutions")
			if change == "unchanged" {
				require.Equal(t, http.StatusOK, response.Code)
				require.JSONEq(t, `{"routes":[]}`, response.Body.String())
			} else {
				require.Equal(t, http.StatusForbidden, response.Code)
				require.Contains(t, response.Body.String(), `"permission"`)
			}
		})
	}
}

func TestProviderPoolBoundPayloadReachesOnlyAdmittedUpstream(t *testing.T) {
	for _, substitute := range []bool{false, true} {
		t.Run(map[bool]string{false: "original", true: "substituted"}[substitute], func(t *testing.T) {
			const body = `{"model":"original","input":"hello"}`
			var calls atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				raw, err := io.ReadAll(r.Body)
				require.NoError(t, err)
				require.Equal(t, body, string(raw))
				_, _ = io.WriteString(w, `{"id":"response"}`)
			}))
			defer upstream.Close()
			pool := &fakePool{pooled: true, accounts: codexAccounts("a")}
			h := poolHandler(pool, upstream.URL)
			scopes := &countingPoolScopes{}
			h.Scopes = scopes
			h.MaxBodyBytes = int64(len(body))
			boundary := h.Authorize(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if substitute {
					r.Body = io.NopCloser(strings.NewReader(`{"model":"other"}`))
				}
				h.ServeHTTP(w, r)
			}))
			out := proxyRequest(t, boundary, "/provider-pool/chatgpt/codex/responses", body, workspaceContext())
			require.Equal(t, 1, scopes.calls)
			if substitute {
				require.Equal(t, 403, out.Code, out.Body.String())
				require.Zero(t, calls.Load())
				require.Zero(t, pool.next, "must refuse before selecting a provider account")
			} else {
				require.Equal(t, 200, out.Code, out.Body.String())
				require.EqualValues(t, 1, calls.Load())
			}
		})
	}
}
