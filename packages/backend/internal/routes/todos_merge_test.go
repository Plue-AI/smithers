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

// These HTTP tests use the production numbered handler and service. They prove
// refusal while install dispatch is unavailable, not successful GitHub merging.
func TestTodoMergeHTTPRefusesWithoutDispatch(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var user, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('merge-owner','merge-owner') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'merge-repo','merge-repo') RETURNING id`, user).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, user)
	require.NoError(t, err)
	q := db.New(pool)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"merge-owner","repository_name":"merge-repo"}`)}))
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo, IssueNumber: pgtype.Int8{Int64: 81, Valid: true}, State: "proposed", Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	head := strings.Repeat("a", 40)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET number=7,pr_number=19,pr_head=$2,pr_state='open' WHERE id=$1`, item.ID, head)
	require.NoError(t, err)
	handler := &TodoHandler{Queries: q, Service: services.NewMythicalService(pool, nil)}
	router := chi.NewRouter()
	router.Post("/api/todos/{n}/merge", handler.Merge)
	for _, tc := range []struct {
		name, path, body, code string
		status                 int
		token                  bool
	}{
		{"dispatch unavailable", "7", `{"reviewed_head_sha":"` + head + `"}`, "rechecking", 409, false},
		{"stale", "7", `{"reviewed_head_sha":"` + strings.Repeat("b", 40) + `"}`, "stale_head", 409, false},
		{"issue number is not TODO number", "81", `{"reviewed_head_sha":"` + head + `"}`, "todo_not_found", 404, false},
		{"malformed", "7", `{"reviewed_head_sha":42}`, "invalid_reviewed_head_sha", 400, false},
		{"missing", "7", `{}`, "invalid_reviewed_head_sha", 400, false},
		{"trailing body", "7", `{} {}`, "invalid_reviewed_head_sha", 400, false},
		{"token", "7", `{"reviewed_head_sha":"` + head + `"}`, "permission", 403, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/todos/"+tc.path+"/merge", strings.NewReader(tc.body))
			req = req.WithContext(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: user}, SessionHash: "browser-session", IsTokenAuth: tc.token}))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			var body map[string]any
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Equal(t, tc.code, body["code"])
			if tc.code == "stale_head" {
				require.Equal(t, head, body["current_head_sha"])
			}
			stored, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.JSONEq(t, `{"todo":true}`, string(stored.Checks))
			require.Empty(t, stored.PendingOp)
			require.Equal(t, "proposed", stored.State)
		})
	}
}
