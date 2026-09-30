package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

type issueCommentsHarness struct {
	pool *pgxpool.Pool
	svc  *services.IssueService
	user db.User
	q    *db.Queries
}

func newIssueCommentsHarness(t *testing.T) (*issueCommentsHarness, func(method, path, body string) (int, json.RawMessage)) {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var user db.User
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES('origin','origin','origin@example.test','origin@example.test') RETURNING id,username`).Scan(&user.ID, &user.Username))
	_, err := pool.Exec(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public) VALUES($1,'repo','repo',true)`, user.ID)
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
		r.Get("/", h.ListIssues)
		r.Post("/", h.CreateIssue)
		r.Put("/sync/channels", h.IssueSyncChannel)
		r.Post("/sync/events", h.IssueSyncEvent)
		r.Get("/comments/{id}", h.GetIssueComment)
		r.Patch("/comments/{id}", h.PatchIssueComment)
		r.Get("/{number}", h.GetIssue)
		r.Post("/{number}/comments", h.PostIssueComment)
		r.Get("/{number}/comments", h.ListIssueComments)
	})
	call := func(method, path, body string) (int, json.RawMessage) {
		t.Helper()
		req := httptest.NewRequest(method, "/api/repos/origin/repo/issues"+path, strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code, json.RawMessage(rec.Body.Bytes())
	}
	return &issueCommentsHarness{pool: pool, svc: svc, user: user, q: q}, call
}

func decodeObject(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var out map[string]any
	require.NoError(t, json.Unmarshal(raw, &out), string(raw))
	return out
}

func decodeArray(t *testing.T, raw json.RawMessage) []map[string]any {
	t.Helper()
	var out []map[string]any
	require.NoError(t, json.Unmarshal(raw, &out), string(raw))
	return out
}

func TestIssueCommentOrigin(t *testing.T) {
	h, call := newIssueCommentsHarness(t)
	ctx := context.Background()

	status, raw := call("PUT", "/sync/channels", `{"provider":"slack","connection_id":"workspace","scope_id":"T001","conversation_id":"C001"}`)
	require.Equal(t, http.StatusOK, status, string(raw))
	event := func(delivery, message, body string) int64 {
		t.Helper()
		status, raw := call("POST", "/sync/events", fmt.Sprintf(`{"provider":"slack","connection_id":"workspace","scope_id":"T001","conversation_id":"C001","thread_id":"100.000001","delivery_key":%q,"message_id":%q,"version":%q,"user_id":"U001","kind":"message","body":%q}`,
			delivery, message, message, body))
		require.Equal(t, http.StatusOK, status, string(raw))
		out := decodeObject(t, raw)
		require.NotContains(t, out, "ignored", string(raw))
		return int64(out["issue_id"].(float64))
	}
	issueID := event("ev:1", "100.000001", "from slack")
	event("ev:2", "100.000002", "slack reply")
	issue, err := h.q.GetIssueByID(ctx, issueID)
	require.NoError(t, err)
	path := fmt.Sprintf("/%d", issue.Number)

	status, raw = call("POST", path+"/comments", `{"body":"from the app","idempotency_key":"app-1"}`)
	require.Equal(t, http.StatusCreated, status, string(raw))
	app := decodeObject(t, raw)
	require.Equal(t, "app", app["origin"], "an API comment is from the app")
	appID := int64(app["id"].(float64))

	status, raw = call("GET", path+"/comments", "")
	require.Equal(t, http.StatusOK, status, string(raw))
	comments := decodeArray(t, raw)
	origins := map[string]string{}
	for _, c := range comments {
		origins[c["body"].(string)] = c["origin"].(string)
	}
	require.Equal(t, "slack", origins["slack reply"], "an intake comment is from Slack: %s", raw)
	require.Equal(t, "app", origins["from the app"])
	for _, c := range comments {
		require.Contains(t, []string{"app", "slack"}, c["origin"])
	}

	// Mirroring the app comment to Slack records its Slack message; it stays an app comment.
	_, err = h.pool.Exec(ctx, `INSERT INTO issue_external_messages(issue_id,comment_id,message_id) VALUES($1,$2,'100.000003')`, issueID, appID)
	require.NoError(t, err)
	status, raw = call("GET", fmt.Sprintf("/comments/%d", appID), "")
	require.Equal(t, http.StatusOK, status, string(raw))
	require.Equal(t, "app", decodeObject(t, raw)["origin"])
	status, raw = call("PATCH", fmt.Sprintf("/comments/%d", appID), `{"body":"edited in the app"}`)
	require.Equal(t, http.StatusOK, status, string(raw))
	require.Equal(t, "app", decodeObject(t, raw)["origin"])

	// The intake's message-identity namespace is reserved.
	for _, key := range []string{"slack:100.000009", "telegram:9"} {
		status, raw = call("POST", path+"/comments", fmt.Sprintf(`{"body":"spoof","idempotency_key":%q}`, key))
		require.Equal(t, http.StatusBadRequest, status, string(raw))
	}
	status, raw = call("POST", path+"/comments", `{"body":"not a provider","idempotency_key":"slackish:1"}`)
	require.Equal(t, http.StatusCreated, status, string(raw))
	require.Equal(t, "app", decodeObject(t, raw)["origin"])
}

func TestIssueListLastComment(t *testing.T) {
	h, call := newIssueCommentsHarness(t)
	ctx := context.Background()
	create := func(title string) services.IssueResponse {
		t.Helper()
		issue, err := h.svc.CreateIssue(ctx, &h.user, h.user.Username, "repo", services.CreateIssueInput{Title: title})
		require.NoError(t, err)
		return issue
	}
	quiet := create("no comments")
	busy := create("two comments")
	long := create("long comment")
	for _, body := range []string{"first", "second and newest"} {
		status, raw := call("POST", fmt.Sprintf("/%d/comments", busy.Number), fmt.Sprintf(`{"body":%q}`, body))
		require.Equal(t, http.StatusCreated, status, string(raw))
	}
	longBody := strings.Repeat("é", 150) + strings.Repeat("x", 150)
	status, raw := call("POST", fmt.Sprintf("/%d/comments", long.Number), fmt.Sprintf(`{"body":%q}`, longBody))
	require.Equal(t, http.StatusCreated, status, string(raw))

	status, raw = call("GET", "/?state=all", "")
	require.Equal(t, http.StatusOK, status, string(raw))
	rows := map[string]map[string]any{}
	for _, row := range decodeArray(t, raw) {
		require.Contains(t, row, "last_comment", "every list row carries the field")
		rows[row["title"].(string)] = row
	}
	require.Nil(t, rows["no comments"]["last_comment"])
	last := rows["two comments"]["last_comment"].(map[string]any)
	require.Equal(t, "second and newest", last["excerpt"])
	require.Equal(t, "origin", last["commenter"])
	require.Equal(t, "app", last["origin"])
	require.NotEmpty(t, last["created_at"])
	excerpt := rows["long comment"]["last_comment"].(map[string]any)["excerpt"].(string)
	require.Equal(t, 200, utf8.RuneCountInString(excerpt))
	require.Equal(t, strings.Repeat("é", 150)+strings.Repeat("x", 50), excerpt)

	status, raw = call("GET", fmt.Sprintf("/%d", busy.Number), "")
	require.Equal(t, http.StatusOK, status, string(raw))
	require.Equal(t, "second and newest", decodeObject(t, raw)["last_comment"].(map[string]any)["excerpt"])
	status, raw = call("GET", fmt.Sprintf("/%d", quiet.Number), "")
	require.Equal(t, http.StatusOK, status, string(raw))
	got := decodeObject(t, raw)
	require.Contains(t, got, "last_comment")
	require.Nil(t, got["last_comment"])
}
