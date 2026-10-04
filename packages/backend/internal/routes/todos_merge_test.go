package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The production numbered handler and service with real PostgreSQL: every
// credential but the owner's browser session is refused in the §6.2.3
// envelope before any read, and no refusal records an approval or a fence.
// Successful dispatch against the GitHub fake is proved in services
// (TestMythicalMergeTodoSquashesAtTheReviewedHead).
func TestTodoMergeHTTPRefusals(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var owner, member, bot, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('merge-owner','merge-owner') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('merge-member','merge-member') RETURNING id`).Scan(&member))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,user_type) VALUES ('merge-bot','merge-bot','bot') RETURNING id`).Scan(&bot))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'merge-repo','merge-repo') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES ('browser-session',$1,'merge-owner',NOW() + interval '1 hour')`, owner)
	require.NoError(t, err)
	q := db.New(pool)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"merge-owner","repository_name":"merge-repo"}`)}))
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo, IssueNumber: pgtype.Int8{Int64: 81, Valid: true}, State: "proposed", Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	head := strings.Repeat("a", 40)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET number=7,pr_number=19,pr_head=$2,pr_state='open',candidate_verified=true WHERE id=$1`, item.ID, head)
	require.NoError(t, err)
	before, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	handler := &TodoHandler{Queries: q, Service: services.NewMythicalService(pool, nil)}
	router := chi.NewRouter()
	router.Post("/api/todos/{n}/merge", handler.Merge)
	// No queries or service at all: a refusal it still answers read nothing.
	unread := chi.NewRouter()
	unread.Post("/api/todos/{n}/merge", (&TodoHandler{}).Merge)
	post := func(router http.Handler, path, body string, info *middleware.AuthInfo, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/todos/"+path+"/merge", strings.NewReader(body))
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		req = req.WithContext(middleware.ContextWithAuthInfo(ctx, info))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &envelope), response.Body.String())
		return response.Code, envelope
	}
	body := `{"reviewed_head_sha":"` + head + `"}`
	sessionRefusal := map[string]any{"code": "permission", "class": "permission", "message": "Merge requires an owner or maintainer browser session"}
	for _, tc := range []struct {
		name     string
		info     *middleware.AuthInfo
		status   int
		envelope map[string]any
	}{
		{"no credential", nil, 401, map[string]any{"code": "unauthenticated", "class": "permission", "message": "Sign in to merge"}},
		{"delegated token", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSource: middleware.TokenSourcePersonalAccessToken}, 403, sessionRefusal},
		{"run credential", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: middleware.RepositoryRestrictionScope(repo) + "," + middleware.AgentSessionRestrictionScope("run-1")}, 403, sessionRefusal},
		{"machine credential", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: middleware.WorkspaceChildrenCredentialScope()}, 403, sessionRefusal},
		{"OAuth application token", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSource: middleware.TokenSourceOAuth2AccessToken}, 403, sessionRefusal},
		{"token carrying a session hash", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, SessionHash: "browser-session"}, 403, sessionRefusal},
		{"agent account session", &middleware.AuthInfo{User: &db.User{ID: bot, UserType: "bot"}, SessionHash: "browser-session"}, 403, sessionRefusal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, router := range []http.Handler{router, unread} {
				status, envelope := post(router, "7", body, tc.info, "press-1")
				require.Equal(t, tc.status, status)
				require.Equal(t, tc.envelope, envelope)
			}
		})
	}
	ownerSession := &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "browser-session"}
	for _, tc := range []struct {
		name, path, body, key, code string
		status                      int
		info                        *middleware.AuthInfo
	}{
		{"member session", "7", body, "press-1", "permission", 403, &middleware.AuthInfo{User: &db.User{ID: member}, SessionHash: "member-session"}},
		{"ended session", "7", body, "press-1", "unauthenticated", 401, &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "ended-session"}},
		{"issue number is not TODO number", "81", body, "press-1", "todo_not_found", 404, ownerSession},
		{"malformed", "7", `{"reviewed_head_sha":42}`, "press-1", "invalid_reviewed_head_sha", 400, ownerSession},
		{"missing", "7", `{}`, "press-1", "invalid_reviewed_head_sha", 400, ownerSession},
		{"trailing body", "7", `{} {}`, "press-1", "invalid_reviewed_head_sha", 400, ownerSession},
		{"short", "7", `{"reviewed_head_sha":"` + head[:39] + `"}`, "press-1", "invalid_reviewed_head_sha", 400, ownerSession},
		{"no Idempotency-Key", "7", body, "", "idempotency_key_required", 400, ownerSession},
		{"GitHub not configured", "7", body, "press-1", "github_unavailable", 503, ownerSession},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, envelope := post(router, tc.path, tc.body, tc.info, tc.key)
			require.Equal(t, tc.status, status, envelope)
			require.Equal(t, tc.code, envelope["code"])
		})
	}
	stored, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, before.Version, stored.Version, "no refusal writes the TODO")
	require.JSONEq(t, `{"todo":true}`, string(stored.Checks))
	require.Empty(t, stored.PendingOp)
	require.Equal(t, "proposed", stored.State)
}
