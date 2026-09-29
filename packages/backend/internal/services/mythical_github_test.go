package services

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stackTokens mints a distinct token per permission set, so a test sees
// which narrow token each write used.
type stackTokens struct{}

func (stackTokens) CreateGitHubInstallationTokenForRepositoryOwner(_ context.Context, _, _ int64, _, _ string, permissions map[string]string) (GitHubInstallationToken, error) {
	keys := make([]string, 0, len(permissions))
	for key, level := range permissions {
		keys = append(keys, key+"="+level)
	}
	return GitHubInstallationToken{Token: strings.Join(sortedStrings(keys), ",")}, nil
}

func sortedStrings(values []string) []string {
	for i := range values {
		for j := i + 1; j < len(values); j++ {
			if values[j] < values[i] {
				values[i], values[j] = values[j], values[i]
			}
		}
	}
	return values
}

// recordedGitHub answers the stack's REST calls from routes and records each
// call as "<METHOD> <path> <token> <body>".
type recordedGitHub struct {
	mu     sync.Mutex
	calls  []string
	routes map[string]func(w http.ResponseWriter)
}

func (g *recordedGitHub) api(t *testing.T) *mythicalGitHubAPI {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		key := r.Method + " " + r.URL.RequestURI()
		g.mu.Lock()
		g.calls = append(g.calls, key+" "+strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")+" "+string(body))
		route, ok := g.routes[key]
		g.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusTeapot)
			return
		}
		route(w)
	}))
	t.Cleanup(server.Close)
	api := &landingGitHubAPI{client: server.Client(), baseURL: func() string { return server.URL }}
	return &mythicalGitHubAPI{api: api, text: &gitHubIssueTextAPI{api: api}, tokens: stackTokens{}}
}

func answer(status int, body any) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
}

var stackRepo = mythicalGitHubRepo{Owner: "o", Name: "r", Token: "read-token", userID: 1}

func TestMythicalGitHubHeadChecksNeedsEveryReportGreen(t *testing.T) {
	t.Parallel()
	run := func(status, conclusion string) map[string]any {
		out := map[string]any{"status": status, "conclusion": nil}
		if conclusion != "" {
			out["conclusion"] = conclusion
		}
		return out
	}
	for _, tc := range []struct {
		name     string
		runs     []map[string]any
		combined map[string]any
		want     string
	}{
		{"all green", []map[string]any{run("completed", "success"), run("completed", "skipped")}, map[string]any{"state": "success", "total_count": 1}, mythicalCIGreen},
		{"a run still going", []map[string]any{run("completed", "success"), run("in_progress", "")}, map[string]any{"state": "pending", "total_count": 0}, mythicalCIPending},
		{"nothing reported yet", nil, map[string]any{"state": "pending", "total_count": 0}, mythicalCIPending},
		{"a failed run", []map[string]any{run("in_progress", ""), run("completed", "failure")}, map[string]any{"state": "success", "total_count": 1}, mythicalCIRed},
		{"a cancelled run", []map[string]any{run("completed", "cancelled")}, map[string]any{"state": "success", "total_count": 0}, mythicalCIRed},
		{"a failed status", []map[string]any{run("completed", "success")}, map[string]any{"state": "failure", "total_count": 1}, mythicalCIRed},
		{"a pending status", []map[string]any{run("completed", "success")}, map[string]any{"state": "pending", "total_count": 2}, mythicalCIPending},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/commits/abc/check-runs?per_page=100&page=1": answer(http.StatusOK, map[string]any{"check_runs": tc.runs}),
				"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1": answer(http.StatusOK, map[string]any{
					"check_suites": []map[string]any{{"status": "completed", "conclusion": "success"}}}),
				"GET /repos/o/r/commits/abc/status": answer(http.StatusOK, tc.combined),
			}}
			verdict, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
			require.NoError(t, err)
			assert.Equal(t, tc.want, verdict)
			assert.Contains(t, github.calls[0], " checks=read,statuses=read ", "a read-only token")
		})
	}
	github := &recordedGitHub{}
	_, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
	require.Error(t, err, "an unanswered check read is an error, never green")
}

func TestMythicalGitHubMergePinsTheHeadWithANarrowToken(t *testing.T) {
	t.Parallel()
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"PUT /repos/o/r/pulls/7/merge": answer(http.StatusOK, map[string]any{"sha": "merged-sha", "merged": true}),
		"PUT /repos/o/r/pulls/8/merge": answer(http.StatusConflict, map[string]any{"message": "Head branch was modified"}),
	}}
	api := github.api(t)
	commit, err := api.Merge(context.Background(), stackRepo, 7, "head-sha")
	require.NoError(t, err)
	assert.Equal(t, "merged-sha", commit)
	assert.Equal(t, `PUT /repos/o/r/pulls/7/merge contents=write,pull_requests=write {"merge_method":"squash","sha":"head-sha"}`, github.calls[0])
	_, err = api.Merge(context.Background(), stackRepo, 8, "old-head")
	require.Error(t, err, "a moved head is refused, never merged")
}

func TestMythicalGitHubIssueWritesUseAnIssuesToken(t *testing.T) {
	t.Parallel()
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"DELETE /repos/o/r/issues/3/labels/todo": answer(http.StatusOK, []any{}),
		"DELETE /repos/o/r/issues/4/labels/todo": answer(http.StatusNotFound, map[string]any{}),
		"DELETE /repos/o/r/issues/5/labels/todo": answer(http.StatusForbidden, map[string]any{}),
		"POST /repos/o/r/issues/3/labels":        answer(http.StatusOK, []any{}),
		"POST /repos/o/r/issues/3/comments":      answer(http.StatusCreated, map[string]any{}),
		"POST /repos/o/r/issues/4/comments":      answer(http.StatusForbidden, map[string]any{}),
		"GET /repos/o/r/issues/3/events?per_page=100&page=1": answer(http.StatusOK, []map[string]any{
			{"event": "labeled", "actor": map[string]any{"login": "first"}, "label": map[string]any{"name": "todo"}},
			{"event": "labeled", "actor": map[string]any{"login": "other"}, "label": map[string]any{"name": "bug"}},
			{"event": "labeled", "actor": map[string]any{"login": "last"}, "label": map[string]any{"name": "TODO"}},
		}),
		"GET /repos/o/r/issues/4/events?per_page=100&page=1": answer(http.StatusOK, []map[string]any{}),
		"GET /repos/o/r/issues/3":                            answer(http.StatusOK, map[string]any{"labels": []map[string]any{{"name": "todo"}, {"name": "bug"}}}),
		"GET /repos/o/r/issues/4":                            answer(http.StatusOK, map[string]any{"labels": []map[string]any{}}),
	}}
	api := github.api(t)
	ctx := context.Background()
	require.NoError(t, api.RemoveLabel(ctx, stackRepo, 3, "todo"))
	require.NoError(t, api.RemoveLabel(ctx, stackRepo, 4, "todo"), "an absent label is removed")
	require.Error(t, api.RemoveLabel(ctx, stackRepo, 5, "todo"))
	require.NoError(t, api.AddLabel(ctx, stackRepo, 3, "todo"))
	require.NoError(t, api.Comment(ctx, stackRepo, 3, "Smithers stopped work on this TODO"))
	require.Error(t, api.Comment(ctx, stackRepo, 4, "x"))
	for _, call := range github.calls {
		assert.Contains(t, call, " issues=write ", call)
	}
	assert.Contains(t, github.calls, `POST /repos/o/r/issues/3/labels issues=write {"labels":["todo"]}`)
	applier, err := api.LabelApplier(ctx, stackRepo, 3, "todo")
	require.NoError(t, err)
	assert.Equal(t, "last", applier.Actor.Login, "the latest application of the label, case-insensitive")
	applier, err = api.LabelApplier(ctx, stackRepo, 4, "todo")
	require.NoError(t, err)
	assert.Nil(t, applier)
	assert.Contains(t, github.calls[len(github.calls)-1], " read-token ", "the applier is read with the stack's read token")
}

func TestMythicalGitHubLabelApplierReadsTheLabelAsItStandsNow(t *testing.T) {
	t.Parallel()
	event := func(kind, login string, viaApp bool) map[string]any {
		out := map[string]any{"event": kind, "actor": map[string]any{"login": login}, "label": map[string]any{"name": "automerge"}}
		if viaApp {
			out["performed_via_github_app"] = map[string]any{"slug": "other-app"}
		}
		return out
	}
	withID := func(event map[string]any, id int64) map[string]any {
		event["id"] = id
		return event
	}
	full := make([]map[string]any, 100)
	for i := range full {
		full[i] = event("labeled", "roninjin10", false)
	}
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /repos/o/r/issues/1/events?per_page=100&page=1": answer(http.StatusOK, []map[string]any{
			event("labeled", "roninjin10", false), withID(event("unlabeled", "roninjin10", false), 12)}),
		"GET /repos/o/r/issues/2/events?per_page=100&page=1": answer(http.StatusOK, []map[string]any{event("labeled", "roninjin10", true)}),
		"GET /repos/o/r/issues/1":                            answer(http.StatusOK, map[string]any{"labels": []map[string]any{}}),
		"GET /repos/o/r/issues/2":                            answer(http.StatusOK, map[string]any{"labels": []map[string]any{{"name": "automerge"}}}),
		"GET /repos/o/r/issues/3":                            answer(http.StatusOK, map[string]any{"labels": []map[string]any{{"name": "automerge"}}}),
		// The labels moved on and the history has not caught up yet: the
		// label is gone although its last event applied it.
		"GET /repos/o/r/issues/4":                            answer(http.StatusOK, map[string]any{"labels": []map[string]any{}}),
		"GET /repos/o/r/issues/4/events?per_page=100&page=1": answer(http.StatusOK, []map[string]any{event("labeled", "roninjin10", false)}),
	}}
	for page := 1; page <= 10; page++ {
		github.routes["GET /repos/o/r/issues/3/events?per_page=100&page="+strconv.Itoa(page)] = answer(http.StatusOK, full)
	}
	api := github.api(t)
	ctx := context.Background()
	applier, err := api.LabelApplier(ctx, stackRepo, 1, "automerge")
	require.NoError(t, err)
	assert.False(t, applier.present(), "a removed label is not on the issue")
	assert.Equal(t, &mythicalLabelApplier{Actor: gitHubActor{Login: "roninjin10"}, EventID: 12, Removed: true}, applier, "its remover is named")
	applier, err = api.LabelApplier(ctx, stackRepo, 2, "automerge")
	require.NoError(t, err)
	assert.True(t, applier.ViaApp, "an App's application is marked")
	_, err = api.LabelApplier(ctx, stackRepo, 3, "automerge")
	require.ErrorContains(t, err, "too long to read whole", "a history read in part is refused")
	_, err = api.LabelApplier(ctx, stackRepo, 4, "automerge")
	require.ErrorContains(t, err, "trails the issue's labels", "a label gone from the issue never answers its former applier")
}

// Between a workflow's stages every run so far finished while its suite has
// not: that is not green yet, and a failed suite is red.
func TestMythicalGitHubHeadChecksWaitsForEverySuite(t *testing.T) {
	t.Parallel()
	suite := func(app, status string, conclusion any, runs int) map[string]any {
		return map[string]any{"status": status, "conclusion": conclusion, "latest_check_runs_count": runs, "app": map[string]any{"slug": app}}
	}
	// The shape GitHub answered on smithersai/smithers PR heads (#2625,
	// #1673): Apps that may write checks but never run leave a queued suite
	// with no runs beside the Actions suite.
	placeholders := []map[string]any{suite("cursor", "queued", nil, 0), suite("mintlify", "queued", nil, 0)}
	for _, tc := range []struct {
		name   string
		suites []map[string]any
		want   string
	}{
		{"a suite still running", []map[string]any{suite("github-actions", "in_progress", nil, 3)}, mythicalCIPending},
		{"a failed suite", []map[string]any{suite("github-actions", "completed", "failure", 3)}, mythicalCIRed},
		{"a finished suite", []map[string]any{suite("github-actions", "completed", "success", 3)}, mythicalCIGreen},
		{"placeholder suites beside a green Actions suite", append(placeholders[:2:2], suite("github-actions", "completed", "success", 13)), mythicalCIGreen},
		{"placeholder suites beside a failed Actions suite", append(placeholders[:2:2], suite("github-actions", "completed", "failure", 13)), mythicalCIRed},
		{"an Actions suite whose jobs are not created yet", append(placeholders[:2:2], suite("github-actions", "queued", nil, 0)), mythicalCIPending},
		{"another App's suite that runs", []map[string]any{suite("buildkite", "in_progress", nil, 1)}, mythicalCIPending},
		{"another App's failed suite with no runs", []map[string]any{suite("buildkite", "completed", "failure", 0)}, mythicalCIRed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/commits/abc/check-runs?per_page=100&page=1": answer(http.StatusOK, map[string]any{
					"check_runs": []map[string]any{{"status": "completed", "conclusion": "success"}}}),
				"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1": answer(http.StatusOK, map[string]any{"check_suites": tc.suites}),
				"GET /repos/o/r/commits/abc/status":                           answer(http.StatusOK, map[string]any{"state": "pending", "total_count": 0}),
			}}
			verdict, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
			require.NoError(t, err)
			assert.Equal(t, tc.want, verdict)
		})
	}
}

// CI is never green on a part of it: a second page of suites is read, and
// runs past the tenth page keep the head pending (Astra r3 1).
func TestMythicalGitHubHeadChecksReadsEveryPage(t *testing.T) {
	t.Parallel()
	green := map[string]any{"status": "completed", "conclusion": "success", "latest_check_runs_count": 1, "app": map[string]any{"slug": "github-actions"}}
	suites := make([]map[string]any, 100)
	runs := make([]map[string]any, 100)
	for i := range suites {
		suites[i] = green
		runs[i] = map[string]any{"status": "completed", "conclusion": "success"}
	}
	status := answer(http.StatusOK, map[string]any{"state": "pending", "total_count": 0})

	t.Run("a failed suite on the second page", func(t *testing.T) {
		t.Parallel()
		github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
			"GET /repos/o/r/commits/abc/check-runs?per_page=100&page=1":   answer(http.StatusOK, map[string]any{"check_runs": runs[:1]}),
			"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1": answer(http.StatusOK, map[string]any{"total_count": 101, "check_suites": suites}),
			"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=2": answer(http.StatusOK, map[string]any{"total_count": 101, "check_suites": []map[string]any{
				{"status": "completed", "conclusion": "failure", "latest_check_runs_count": 1, "app": map[string]any{"slug": "github-actions"}}}}),
			"GET /repos/o/r/commits/abc/status": status,
		}}
		verdict, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
		require.NoError(t, err)
		assert.Equal(t, mythicalCIRed, verdict)
	})
	t.Run("more runs than ten pages", func(t *testing.T) {
		t.Parallel()
		github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
			"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1": answer(http.StatusOK, map[string]any{"check_suites": suites[:1]}),
			"GET /repos/o/r/commits/abc/status":                           status,
		}}
		for page := 1; page <= 10; page++ {
			github.routes["GET /repos/o/r/commits/abc/check-runs?per_page=100&page="+strconv.Itoa(page)] = answer(http.StatusOK, map[string]any{"check_runs": runs})
		}
		verdict, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
		require.NoError(t, err)
		assert.Equal(t, mythicalCIPending, verdict, "an unread eleventh page could be red")
	})
}
