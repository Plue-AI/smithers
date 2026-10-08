package compose

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestReviewFindingsRejectIncompleteOrUnanchoredOutput(t *testing.T) {
	a := services.ReviewAdmission{Number: 50, URL: "https://github.com/acme/app/pull/50", Head: strings.Repeat("a", 40)}
	for _, raw := range []string{
		`null`, `{}`, `{"review":{"ok":false,"status":"success"}}`,
		`{"review":{"ok":true,"status":"failed"}}`,
		`{"review":{"ok":true,"status":"completed_with_errors"}}`,
		`{"review":{"ok":true,"status":"skipped"}}`,
		`{"review":{"ok":true,"status":"success","comments":[{"path":"cache.ts","content":"Off by one","startLine":0,"severity":"major"}]}}`,
		`{"review":{"ok":true,"status":"success","comments":[{"path":"cache.ts","content":"Off by one","startLine":1.5,"severity":"major"}]}}`,
		`{"review":{"ok":true,"status":"success","comments":[{"path":"cache.ts","content":"Off by one","startLine":2,"severity":"unknown"}]}}`,
	} {
		_, err := reviewChange(a, raw)
		require.Error(t, err, raw)
	}
	for _, severity := range []string{"critical", "major", "minor", "info"} {
		raw := `{"review":{"ok":true,"status":"success","comments":[{"path":"cache.ts","content":"Off by one","startLine":20,"severity":"` + severity + `","suggestionCode":"return x+1"}]}}`
		change, err := reviewChange(a, raw)
		require.NoError(t, err)
		var card struct {
			Repo, CommitID string
			Findings       []struct {
				Severity, Path, Summary, Suggestion string
				Line                                int
			}
		}
		require.NoError(t, json.Unmarshal(change, &card))
		require.Len(t, card.Findings, 1)
		require.Equal(t, "acme/app", card.Repo)
		require.Equal(t, a.Head, card.CommitID)
		require.Equal(t, "cache.ts", card.Findings[0].Path)
		require.Equal(t, 20, card.Findings[0].Line)
		require.Equal(t, "Off by one", card.Findings[0].Summary)
		require.Equal(t, "return x+1", card.Findings[0].Suggestion)
		if severity == "info" {
			require.Equal(t, "info", card.Findings[0].Severity)
		} else {
			require.Equal(t, "fix", card.Findings[0].Severity)
		}
	}
	clean, err := reviewChange(a, `{"review":{"ok":true,"status":"success","comments":[]}}`)
	require.NoError(t, err)
	require.Contains(t, string(clean), `"findings":[]`)
	a.URL = "https://github.com/acme/app"
	_, err = reviewChange(a, `{"review":{"ok":true,"status":"success","comments":[]}}`)
	require.Error(t, err)
}
