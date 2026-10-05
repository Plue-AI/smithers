package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// recordingIssues answers the issue reads and records what was asked.
type recordingIssues struct {
	asked []string
	fail  error
}

func (s *recordingIssues) InstallIssues(_ context.Context, repo int64, state string, page int) ([]services.InstallIssue, error) {
	s.asked = append(s.asked, fmt.Sprintf("list %d %s %d", repo, state, page))
	if s.fail != nil {
		return nil, s.fail
	}
	return []services.InstallIssue{{Number: 2, Title: "Say goodbye", State: "open", User: &services.InstallIssuePerson{Login: "ben"},
		Labels: []services.InstallIssueLabel{{Name: "todo", Color: "0e8a16"}}, Assignees: []services.InstallIssuePerson{}, Comments: 1}}, nil
}

func (s *recordingIssues) InstallIssue(_ context.Context, repo, number int64) (services.InstallIssueThread, error) {
	s.asked = append(s.asked, fmt.Sprintf("issue %d %d", repo, number))
	if s.fail != nil {
		return services.InstallIssueThread{}, s.fail
	}
	return services.InstallIssueThread{Issue: services.InstallIssue{Number: number, Title: "Say goodbye", State: "open", Labels: []services.InstallIssueLabel{},
		Assignees: []services.InstallIssuePerson{}}, Comments: []services.InstallIssueComment{{ID: 5, Body: "Seen it too.", User: &services.InstallIssuePerson{Login: "carol"}}}}, nil
}

// GET /api/issues and /api/issues/{n} through the production handler on
// real PostgreSQL: the owner and every active roster member read the
// install repository's issues (issue.read is a Member's); a person off the
// roster, a suspended member and a token read none; the repository is the
// install's, and the query reaches the service as asked.
func TestInstallIssueRoutesReadByRole(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	person := func(login string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,display_name) VALUES ($1,$1,$1) RETURNING id`, login).Scan(&id))
		return id
	}
	owner, ben, alice, carol, dave := person("maya"), person("ben"), person("alice"), person("carol"), person("dave")
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'app','app') RETURNING id`, owner).Scan(&repo))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES (true,$1)`, owner)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d}`, repo))}))
	for _, row := range []struct {
		user       int64
		permission string
		suspended  bool
	}{{ben, "admin", false}, {alice, "write", false}, {dave, "write", true}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,suspended_at) VALUES ($1,$2,$3,CASE WHEN $4::boolean THEN now() END)`, repo, row.user, row.permission, row.suspended)
		require.NoError(t, err)
	}
	service := &recordingIssues{}
	handler := &InstallIssuesHandler{Queries: q, Service: service}
	router := chi.NewRouter()
	router.Get("/api/issues", handler.List)
	router.Get("/api/issues/{n}", handler.Get)
	call := func(info *middleware.AuthInfo, path string) (int, string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(middleware.ContextWithAuthInfo(ctx, info))
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res.Code, res.Body.String()
	}
	session := func(user int64) *middleware.AuthInfo {
		return &middleware.AuthInfo{User: &db.User{ID: user}, SessionHash: fmt.Sprintf("session-%d", user)}
	}

	for _, reader := range []int64{owner, ben, alice} {
		status, body := call(session(reader), "/api/issues")
		require.Equal(t, http.StatusOK, status, body)
		require.JSONEq(t, `[{"number":2,"title":"Say goodbye","body":"","state":"open","html_url":"","user":{"login":"ben"},
			"labels":[{"name":"todo","color":"0e8a16"}],"assignees":[],"comments":1}]`, body)
		status, body = call(session(reader), "/api/issues/2")
		require.Equal(t, http.StatusOK, status, body)
		require.JSONEq(t, `{"issue":{"number":2,"title":"Say goodbye","body":"","state":"open","html_url":"","user":null,"labels":[],"assignees":[],"comments":0},
			"comments":[{"id":5,"body":"Seen it too.","user":{"login":"carol"}}]}`, body)
	}
	status, _ := call(session(alice), "/api/issues?state=closed&page=3")
	require.Equal(t, http.StatusOK, status)
	want := []string{}
	for range 3 {
		want = append(want, fmt.Sprintf("list %d open 1", repo), fmt.Sprintf("issue %d 2", repo))
	}
	require.Equal(t, append(want, fmt.Sprintf("list %d closed 3", repo)), service.asked)

	// Refused before any read.
	service.asked = nil
	token := &middleware.AuthInfo{User: &db.User{ID: alice}, IsTokenAuth: true}
	for _, refused := range []*middleware.AuthInfo{session(carol), session(dave), token} {
		for _, path := range []string{"/api/issues", "/api/issues/2"} {
			status, body := call(refused, path)
			require.Equal(t, http.StatusForbidden, status, body)
			var envelope map[string]any
			require.NoError(t, json.Unmarshal([]byte(body), &envelope))
			require.Equal(t, "permission", envelope["class"])
		}
	}
	for _, path := range []string{"/api/issues?page=two", "/api/issues/0", "/api/issues/x"} {
		status, body := call(session(alice), path)
		require.Equal(t, http.StatusBadRequest, status, body)
		require.Contains(t, body, `"code":"invalid_issue_query"`)
	}
	require.Empty(t, service.asked)

	// The service's refusals keep their envelope.
	service.fail = &services.TodoControlError{Status: http.StatusNotFound, Code: "not_found", Class: "user", Message: "Issue #9 was not found"}
	status, body := call(session(alice), "/api/issues/9")
	require.Equal(t, http.StatusNotFound, status)
	require.JSONEq(t, `{"code":"not_found","class":"user","message":"Issue #9 was not found"}`, body)
	service.fail = &services.TodoControlError{Status: http.StatusServiceUnavailable, Code: "github_unavailable", Class: "infra", Message: "Could not read issues from GitHub"}
	status, body = call(session(owner), "/api/issues")
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.JSONEq(t, `{"code":"github_unavailable","class":"infra","message":"Could not read issues from GitHub"}`, body)

	// Without the install's repository binding nothing is read.
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='github.repository'`)
	require.NoError(t, err)
	service.asked, service.fail = nil, nil
	status, _ = call(session(owner), "/api/issues")
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.Empty(t, service.asked)
}
