package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeIssueHTTPCommentLookupAfterSyncRetirement(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var user db.User
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES('phase2','phase2','phase2@example.test','phase2@example.test') RETURNING id,username`).Scan(&user.ID, &user.Username))
	_, err := pool.Exec(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public)VALUES($1,'repo','repo',true)`, user.ID)
	require.NoError(t, err)
	q := db.New(pool)
	svc := services.NewIssueService(q)
	h := &IssueHandler{Service: svc}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), middleware.UserContextKey, &user)))
		})
	})
	r.Route("/api/repos/{owner}/{repo}/issues", func(r chi.Router) {
		r.Post("/{number}/comments", h.PostIssueComment)
		r.Get("/{number}/comments", h.ListIssueComments)
	})
	call := func(method, path, body string) (int, map[string]any) {
		req := httptest.NewRequest(method, "/api/repos/phase2/repo/issues"+path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
		return rec.Code, out
	}
	issue, err := svc.CreateIssue(ctx, &user, user.Username, "repo", services.CreateIssueInput{Title: "chat", Kind: "chat"})
	require.NoError(t, err)
	path := fmt.Sprintf("/%d", issue.Number)
	status, out := call("POST", path+"/comments", `{"body":"reply","idempotency_key":"dispatch:step","persona":{"username":"Builder"}}`)
	require.Equal(t, 201, status, out)
	status, found := call("GET", path+"/comments?idempotency_key=dispatch%3Astep", "")
	require.Equal(t, 200, status)
	require.Equal(t, out["id"], found["id"])
	require.NoError(t, svc.DeleteIssueComment(ctx, &user, user.Username, "repo", int64(out["id"].(float64))))
	status, _ = call("GET", path+"/comments?idempotency_key=dispatch%3Astep", "")
	require.Equal(t, 409, status)

}
