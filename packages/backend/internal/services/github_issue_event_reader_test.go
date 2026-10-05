package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestGitHubIssueEventProvenanceIsScopedToIssue(t *testing.T) {
	const person = `{"id":10,"event":"labeled","issue":{"number":3},"actor":{"login":"alice","type":"User"},"label":{"name":"todo"},"created_at":"2026-10-05T10:00:00Z"}`
	const other = `{"id":11,"event":"labeled","issue":{"number":4},"actor":{"login":"alice","type":"User"},"label":{"name":"todo"},"created_at":"2026-10-05T10:00:00Z","performed_via_github_app":{"id":42}}`
	const app = `{"id":12,"event":"labeled","issue":{"number":3},"actor":{"login":"alice","type":"User"},"label":{"name":"todo"},"created_at":"2026-10-05T10:00:00Z","performed_via_github_app":{"id":42}}`
	for _, tc := range []struct {
		name, body           string
		allowed, unavailable bool
	}{
		{"person", "[" + person + "]", true, false},
		{"another issue does not change attribution", "[" + other + "," + person + "]", true, false},
		{"another issue is not evidence", "[" + other + "]", false, true},
		{"app action", "[" + app + "]", false, false},
		{"ambiguous nearby actions", "[" + app + "," + person + "]", false, false},
		{"missing event", "[]", false, true},
		{"malformed event", `[{"event":"labeled","issue":{"number":3}}]`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/issues/events?per_page=100&page=1": answer(http.StatusOK, json.RawMessage(tc.body)),
			}}
			g := &gitHubIssueTextAPI{api: github.api(t).api}
			at := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
			allowed, err := g.LabelAppliedByPerson(context.Background(), "read-token", "o", "r", 3, "TODO", "Alice", at)
			require.Equal(t, tc.allowed, allowed)
			if tc.unavailable {
				require.ErrorIs(t, err, errGitHubIssueTextUnavailable)
			} else {
				require.NoError(t, err)
			}
			require.Len(t, github.calls, 1)
			require.Contains(t, github.calls[0], "GET /repos/o/r/issues/events?per_page=100&page=1 read-token")
		})
	}
}

func TestGitHubIssueEventProvenanceRequiresCompleteHistory(t *testing.T) {
	full := make([]map[string]any, 100)
	for i := range full {
		full[i] = map[string]any{"id": 201 - i, "event": "labeled", "issue": map[string]int{"number": 3}, "actor": map[string]string{"login": "alice"}, "label": map[string]string{"name": "todo"}, "created_at": "2026-10-05T10:00:00Z"}
	}
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /repos/o/r/issues/events?per_page=100&page=1": answer(http.StatusOK, full),
		"GET /repos/o/r/issues/events?per_page=100&page=2": answer(http.StatusServiceUnavailable, map[string]string{"message": "temporarily unavailable"}),
		"GET /repos/o/r/issues/3":                          answer(http.StatusOK, map[string]any{"labels": []map[string]string{{"name": "todo"}}}),
	}}
	api := github.api(t)
	g := &gitHubIssueTextAPI{api: api.api}
	allowed, err := g.LabelAppliedByPerson(context.Background(), "read-token", "o", "r", 3, "todo", "alice", time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC))
	require.False(t, allowed)
	require.ErrorIs(t, err, errGitHubIssueTextUnavailable)
	applier, err := api.LabelApplier(context.Background(), stackRepo, 3, "todo")
	require.Nil(t, applier)
	require.Error(t, err, "a matching first page cannot authorize a partial history")
}

func TestGitHubIssueEventReadDoesNotTruncateAtTenPages(t *testing.T) {
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){}}
	for page := 1; page <= 11; page++ {
		batch := []map[string]any{}
		for id := 1050 - (page-1)*100; id > 1050-page*100 && id > 0; id-- {
			batch = append(batch, map[string]any{"id": id, "event": "labeled", "issue": map[string]int{"number": 3}, "label": map[string]string{"name": "todo"}})
		}
		github.routes[fmt.Sprintf("GET /repos/o/r/issues/events?per_page=100&page=%d", page)] = answer(http.StatusOK, batch)
	}
	events, newest, err := github.api(t).IssueEvents(context.Background(), stackRepo, 0)
	require.NoError(t, err)
	require.Len(t, events, 1050)
	require.EqualValues(t, 1050, newest)
	require.EqualValues(t, 1, events[0].ID)
	require.EqualValues(t, 1050, events[len(events)-1].ID)
	require.Len(t, github.calls, 11)
}
