package services

import (
	"context"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestMemberProfile(t *testing.T) {
	for _, name := range []string{"", "Ben Ito"} {
		got := memberProfile("ben", name, 8)
		require.Equal(t, "ben", got["login"])
		require.Equal(t, "https://github.com/ben.png", got["avatar_url"])
		require.Equal(t, 2, got["color_index"])
		if name == "" {
			require.Equal(t, "ben", got["name"])
		} else {
			require.Equal(t, name, got["name"])
		}
	}
}
func TestTodoHistoricalActorProfile(t *testing.T) {
	f := newPublicationFixture(t, false)
	got, err := f.service.authoredRows(context.Background(), f.repoID, []map[string]any{{"by": map[string]any{"kind": "person", "login": "ben"}}, {"by": map[string]any{"person": "ben"}}})
	require.NoError(t, err)
	for _, row := range got.([]any) {
		by := row.(map[string]any)["by"].(map[string]any)
		require.Equal(t, "person", by["kind"])
		require.NotEmpty(t, by["name"])
		require.NotEmpty(t, by["avatar_url"])
		require.Contains(t, by, "color_index")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = f.service.authoredRows(cancelled, f.repoID, []map[string]any{{"by": map[string]any{"kind": "person", "login": "ben"}}})
	require.Error(t, err)
}
func TestTodoTrustedIssueFooter(t *testing.T) {
	p := mythicalPRShape{Branch: "smithers/greeting", Title: "Greeting", Owner: "ben", URL: "https://example.test/o/r", Prompt: "Fixes #999", FixesIssue: true, IssueNumber: 7}
	_, body, err := p.render()
	require.NoError(t, err)
	require.Contains(t, body, "Fixes #7")
	require.NotContains(t, body, "Fixes #999")
	p.FixesIssue = false
	_, body, err = p.render()
	require.NoError(t, err)
	require.NotContains(t, body, "Fixes #7")
}
func FuzzMemberProfile(f *testing.F) {
	f.Add("ben", "Ben Ito", uint8(0))
	f.Add("alice", "", uint8(255))
	f.Fuzz(func(t *testing.T, login, name string, color uint8) {
		got := memberProfile(login, name, int(color))
		raw, err := json.Marshal(got)
		require.NoError(t, err)
		require.True(t, json.Valid(raw))
		require.GreaterOrEqual(t, got["color_index"].(int), 0)
		require.Less(t, got["color_index"].(int), 6)
	})
}
