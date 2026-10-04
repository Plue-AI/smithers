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

func fixtureStatuses(combined map[string]any) []map[string]any {
	if combined["total_count"] == 0 {
		return []map[string]any{}
	}
	return []map[string]any{{"context": "legacy", "state": combined["state"]}}
}

func (g *recordedGitHub) api(t *testing.T) *mythicalGitHubAPI {
	if g.routes != nil {
		if _, ok := g.routes["GET /repos/o/r/branches/main/protection"]; !ok {
			g.routes["GET /repos/o/r/branches/main/protection"] = answer(200, map[string]any{})
		}
		if _, ok := g.routes["GET /repos/o/r/rules/branches/main"]; !ok {
			g.routes["GET /repos/o/r/rules/branches/main"] = answer(200, []any{})
		}
	}
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
	return &mythicalGitHubAPI{credentials: outboundTestCredentials{}, api: api, text: &gitHubIssueTextAPI{api: api}, tokens: stackTokens{}}
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
				"GET /repos/o/r/commits/abc/check-runs?filter=latest&per_page=100&page=1": answer(http.StatusOK, map[string]any{"check_runs": tc.runs}),
				"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1": answer(http.StatusOK, map[string]any{
					"check_suites": []map[string]any{{"status": "completed", "conclusion": "success"}}}),
				"GET /repos/o/r/commits/abc/statuses?per_page=100&page=1": answer(http.StatusOK, fixtureStatuses(tc.combined)),
			}}
			verdict, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
			require.NoError(t, err)
			assert.Equal(t, tc.want, verdict)
			assert.Contains(t, github.calls[0], " administration=read,checks=read,statuses=read ", "a read-only token")
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
		"DELETE /repos/o/r/issues/3/labels/todo":               answer(http.StatusOK, []any{}),
		"DELETE /repos/o/r/issues/4/labels/todo":               answer(http.StatusNotFound, map[string]any{}),
		"DELETE /repos/o/r/issues/5/labels/todo":               answer(http.StatusForbidden, map[string]any{}),
		"POST /repos/o/r/issues/3/labels":                      answer(http.StatusOK, []any{}),
		"POST /repos/o/r/issues/3/comments":                    answer(http.StatusCreated, map[string]any{}),
		"POST /repos/o/r/issues/4/comments":                    answer(http.StatusForbidden, map[string]any{}),
		"PATCH /repos/o/r/issues/3":                            answer(http.StatusOK, map[string]any{"state": "closed"}),
		"PATCH /repos/o/r/issues/4":                            answer(http.StatusForbidden, map[string]any{}),
		"GET /repos/o/r/issues/3/comments?per_page=100&page=1": answer(http.StatusOK, []map[string]any{}),
		"GET /repos/o/r/issues/4/comments?per_page=100&page=1": answer(http.StatusOK, []map[string]any{}),
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
	require.NoError(t, api.Comment(ctx, stackRepo, 3, "stop", "Smithers stopped work on this TODO"))
	require.Error(t, api.Comment(ctx, stackRepo, 4, "stop", "x"))
	require.NoError(t, api.CloseIssue(ctx, stackRepo, 3))
	require.Error(t, api.CloseIssue(ctx, stackRepo, 4))
	// Without a key a comment posts as written and reads nothing first.
	before := len(github.calls)
	require.NoError(t, api.Comment(ctx, stackRepo, 3, "", "Smithers is holding this TODO"))
	assert.Equal(t, []string{`POST /repos/o/r/issues/3/comments issues=write {"body":"Smithers is holding this TODO"}`}, github.calls[before:])
	for _, call := range github.calls {
		if !strings.HasPrefix(call, "GET ") {
			assert.Contains(t, call, " issues=write ", call)
		}
	}
	assert.Contains(t, github.calls, `POST /repos/o/r/issues/3/comments issues=write {"body":"Smithers stopped work on this TODO\n\n\u003c!-- smithers:stop --\u003e"}`)
	assert.Contains(t, github.calls, `PATCH /repos/o/r/issues/3 issues=write {"state":"closed","state_reason":"completed"}`)
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
				"GET /repos/o/r/commits/abc/check-runs?filter=latest&per_page=100&page=1": answer(http.StatusOK, map[string]any{
					"check_runs": []map[string]any{{"status": "completed", "conclusion": "success"}}}),
				"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1": answer(http.StatusOK, map[string]any{"check_suites": tc.suites}),
				"GET /repos/o/r/commits/abc/statuses?per_page=100&page=1":     answer(http.StatusOK, []any{}),
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
	status := answer(http.StatusOK, []any{})

	t.Run("a failed suite on the second page", func(t *testing.T) {
		t.Parallel()
		github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
			"GET /repos/o/r/commits/abc/check-runs?filter=latest&per_page=100&page=1": answer(http.StatusOK, map[string]any{"check_runs": runs[:1]}),
			"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1":             answer(http.StatusOK, map[string]any{"total_count": 101, "check_suites": suites}),
			"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=2": answer(http.StatusOK, map[string]any{"total_count": 101, "check_suites": []map[string]any{
				{"status": "completed", "conclusion": "failure", "latest_check_runs_count": 1, "app": map[string]any{"slug": "github-actions"}}}}),
			"GET /repos/o/r/commits/abc/statuses?per_page=100&page=1": status,
		}}
		verdict, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
		require.NoError(t, err)
		assert.Equal(t, mythicalCIRed, verdict)
	})
	t.Run("more runs than ten pages", func(t *testing.T) {
		t.Parallel()
		github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
			"GET /repos/o/r/commits/abc/check-suites?per_page=100&page=1": answer(http.StatusOK, map[string]any{"check_suites": suites[:1]}),
			"GET /repos/o/r/commits/abc/statuses?per_page=100&page=1":     status,
		}}
		for page := 1; page <= 10; page++ {
			github.routes["GET /repos/o/r/commits/abc/check-runs?filter=latest&per_page=100&page="+strconv.Itoa(page)] = answer(http.StatusOK, map[string]any{"check_runs": runs})
		}
		verdict, err := github.api(t).HeadChecks(context.Background(), stackRepo, "abc")
		require.ErrorContains(t, err, "listing is incomplete")
		assert.Empty(t, verdict, "an unread eleventh page cannot produce a verdict")
	})
}

func TestMythicalGitHubCommentSaysEachKeyOnce(t *testing.T) {
	t.Parallel()
	var page2 []map[string]any
	for i := range 100 {
		page2 = append(page2, map[string]any{"id": 1000 + i, "body": "unrelated"})
	}
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /repos/o/r/issues/5/comments?per_page=100&page=1": answer(http.StatusOK, []map[string]any{
			{"id": 40, "body": "quoting <!-- smithers:landed:abc -->", "user": map[string]any{"type": "User"}},
			{"id": 41, "body": "another App <!-- smithers:landed:abc -->", "user": map[string]any{"type": "Bot"}, "performed_via_github_app": map[string]any{"id": 9}},
			{"id": 42, "body": "Landed on main: old\n\n<!-- smithers:landed:abc -->", "user": map[string]any{"type": "Bot"}, "performed_via_github_app": map[string]any{"id": 7}},
		}),
		"PATCH /repos/o/r/issues/comments/42":                  answer(http.StatusOK, map[string]any{}),
		"GET /repos/o/r/issues/6/comments?per_page=100&page=1": answer(http.StatusOK, page2),
		"GET /repos/o/r/issues/6/comments?per_page=100&page=2": answer(http.StatusOK, []map[string]any{
			{"id": 43, "body": "unrelated\n\n<!-- smithers:landed:other -->"},
		}),
		"POST /repos/o/r/issues/6/comments":                    answer(http.StatusCreated, map[string]any{}),
		"GET /repos/o/r/issues/7/comments?per_page=100&page=1": answer(http.StatusBadGateway, map[string]any{}),
		"POST /repos/o/r/issues/8/comments":                    answer(http.StatusCreated, map[string]any{}),
	}}
	for page := 1; page <= mythicalCommentPages+1; page++ {
		github.routes["GET /repos/o/r/issues/8/comments?per_page=100&page="+strconv.Itoa(page)] = answer(http.StatusOK, page2)
	}
	api := github.api(t)
	ctx := context.Background()
	// The App's comment carrying the key is edited, never repeated, however
	// the earlier post was lost from the stack's record; a person's or
	// another account's comment quoting the marker is not it.
	require.NoError(t, api.Comment(ctx, stackRepo, 5, "landed:abc", "Landed on main: new"))
	assert.Equal(t, []string{
		"GET /repos/o/r/issues/5/comments?per_page=100&page=1 read-token ",
		`PATCH /repos/o/r/issues/comments/42 issues=write {"body":"Landed on main: new\n\n\u003c!-- smithers:landed:abc --\u003e"}`,
	}, github.calls)
	github.calls = nil
	// Another key's comment, on any page, is not this one.
	require.NoError(t, api.Comment(ctx, stackRepo, 6, "landed:abc", "Landed on main: new"))
	assert.Equal(t, `POST /repos/o/r/issues/6/comments issues=write {"body":"Landed on main: new\n\n\u003c!-- smithers:landed:abc --\u003e"}`, github.calls[len(github.calls)-1])
	assert.Len(t, github.calls, 3)
	// Unread comments never risk a repeat: nothing is posted.
	github.calls = nil
	require.Error(t, api.Comment(ctx, stackRepo, 7, "landed:abc", "x"))
	assert.Len(t, github.calls, 1, "no write after an unread thread")
	// A thread longer than the bound is taken to hold no earlier say: a new
	// comment, never a completion stuck retrying forever.
	github.calls = nil
	require.NoError(t, api.Comment(ctx, stackRepo, 8, "landed:abc", "Landed on main: new"))
	assert.Len(t, github.calls, mythicalCommentPages+1, "reads the bounded pages, then posts")
	assert.True(t, strings.HasPrefix(github.calls[mythicalCommentPages], "POST /repos/o/r/issues/8/comments "))
	assert.Equal(t, "<!-- smithers:a-b -->", mythicalCommentMarker("a--b"), "a key never ends the marker early")
}

func TestMythicalGitHubOnMainComparesTheBookmark(t *testing.T) {
	t.Parallel()
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /repos/o/r/compare/main...landed":  answer(http.StatusOK, map[string]any{"status": "behind", "ahead_by": 0}),
		"GET /repos/o/r/compare/main...other":   answer(http.StatusOK, map[string]any{"status": "diverged", "ahead_by": 1}),
		"GET /repos/o/r/compare/main...unknown": answer(http.StatusNotFound, map[string]any{}),
	}}
	api := github.api(t)
	ctx := context.Background()
	on, err := api.OnMain(ctx, stackRepo, "main", "landed")
	require.NoError(t, err)
	assert.True(t, on)
	on, err = api.OnMain(ctx, stackRepo, "main", "other")
	require.NoError(t, err)
	assert.False(t, on, "a commit main lacks is not on it")
	_, err = api.OnMain(ctx, stackRepo, "main", "unknown")
	require.Error(t, err, "an unanswered compare is an error, never on main")
	assert.Contains(t, github.calls[0], " read-token ", "read with the stack's read token")
}

func TestMythicalGitHubClosePull(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusForbidden, http.StatusNotFound, http.StatusInternalServerError} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			server := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"PATCH /repos/o/r/pulls/12": answer(status, map[string]any{"state": "closed"}),
			}}
			api := server.api(t)
			err := api.ClosePull(context.Background(), stackRepo, 12)
			if status == http.StatusOK {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
			require.Equal(t, []string{`PATCH /repos/o/r/pulls/12 pull_requests=write {"state":"closed"}`}, server.calls)
		})
	}
}
