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

func TestIssueSyncHTTPMappingsAndCommentLookup(t *testing.T) {
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
		r.Put("/{number}/sync", h.IssueSync)
		r.Get("/{number}/sync", h.IssueSync)
		r.Put("/sync/channels", h.IssueSyncChannel)
		r.Post("/sync/events", h.IssueSyncEvent)
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
	status, out := call("PUT", path+"/sync", `{"provider":"slack","connection_id":"workspace","scope_id":"T001","conversation_id":"C001","thread_id":"100.000001"}`)
	require.Equal(t, 200, status, out)
	require.Equal(t, "C001", out["conversation_id"])
	status, out = call("GET", path+"/sync", "")
	require.Equal(t, 200, status)
	require.Equal(t, "slack", out["provider"])
	require.Equal(t, "C001", out["conversation_id"])
	status, _ = call("PUT", path+"/sync", "null")
	require.Equal(t, 400, status)
	status, out = call("POST", path+"/comments", `{"body":"reply","idempotency_key":"dispatch:step","persona":{"username":"Builder"}}`)
	require.Equal(t, 201, status, out)
	status, found := call("GET", path+"/comments?idempotency_key=dispatch%3Astep", "")
	require.Equal(t, 200, status)
	require.Equal(t, out["id"], found["id"])
	require.NoError(t, svc.DeleteIssueComment(ctx, &user, user.Username, "repo", int64(out["id"].(float64))))
	status, _ = call("GET", path+"/comments?idempotency_key=dispatch%3Astep", "")
	require.Equal(t, 409, status)
	status, out = call("PUT", "/sync/channels", `{"provider":"telegram","connection_id":"bot","scope_id":"123","conversation_id":"-100"}`)
	require.Equal(t, 200, status, out)
	status, out = call("POST", "/sync/events", `{"provider":"telegram","connection_id":"bot","scope_id":"123","conversation_id":"-100","delivery_key":"update:1","message_id":"7","version":"100.0000000001","user_id":"42","kind":"message","body":"sync test"}`)
	require.Equal(t, 200, status, out)
	telegram, err := q.GetIssueByID(ctx, int64(out["issue_id"].(float64)))
	require.NoError(t, err)
	status, out = call("GET", fmt.Sprintf("/%d/sync", telegram.Number), "")
	require.Equal(t, 200, status, out)
	require.Equal(t, "telegram", out["provider"])
	require.Equal(t, "-100", out["conversation_id"])
	// Routine per-event refusals are acknowledged so one event cannot stop intake.
	status, out = call("POST", "/sync/events", `{"provider":"telegram","connection_id":"bot","scope_id":"123","conversation_id":"-999","delivery_key":"update:2","message_id":"8","version":"100.0000000002","user_id":"42","kind":"message","body":"elsewhere"}`)
	require.Equal(t, 200, status, out)
	require.Equal(t, map[string]any{"ignored": "sync conversation not mapped"}, out)
	status, out = call("POST", "/sync/events", `{"provider":"telegram","connection_id":"bot","scope_id":"123","conversation_id":"-100","delivery_key":"update:3","message_id":"999","version":"100.0000000003","user_id":"42","kind":"reaction_add","reaction":"thumbsup"}`)
	require.Equal(t, 200, status, out)
	require.Equal(t, map[string]any{"ignored": "external message not mapped"}, out)
	status, out = call("POST", "/sync/events", `{"provider":"telegram","connection_id":"bot","scope_id":"123","conversation_id":"-100","delivery_key":"update:4","message_id":"9","version":"100.0000000004","user_id":"42","kind":"shout"}`)
	require.Equal(t, 400, status, "a malformed event is a connector defect and stays an error")
	status, _ = call("POST", "/sync/events", `{"provider":"telegram","connection_id":"","scope_id":"123","conversation_id":"-100","delivery_key":"update:5","message_id":"9","version":"100.0000000005","user_id":"42","kind":"message","body":"x"}`)
	require.Equal(t, 400, status, "an invalid connection stays an error")
}
