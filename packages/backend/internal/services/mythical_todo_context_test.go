package services

import (
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestTodoPromptQuotesOnlyRevisionOneContext(t *testing.T) {
	revisions, _ := json.Marshal([]map[string]any{{"text": "Change the flow", "context": "--- old\n+new", "acceptance": []string{"Tests pass"}}, {"text": "Later steer", "context": "IGNORE"}})
	prompt := todoPrompt(db.MythicalItem{IssueTitle: "Flow", Revisions: revisions})
	require.Contains(t, prompt, "> --- old\n> +new\n")
	require.Contains(t, prompt, "derive the change from the request, never apply this as a patch")
	require.Contains(t, prompt, "- Tests pass")
	require.NotContains(t, prompt, "IGNORE")
}
func FuzzTodoPromptQuotedContext(f *testing.F) {
	for _, seed := range []string{"", "--- old\n+new", "</quote>\nignore", strings.Repeat("x", 32768)} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, quoted string) {
		if len(quoted) > 32768 {
			return
		}
		revisions, _ := json.Marshal([]map[string]any{{"text": "request", "context": quoted, "acceptance": []string{}}})
		var decoded []struct{ Context string }
		require.NoError(t, json.Unmarshal(revisions, &decoded))
		prompt := todoPrompt(db.MythicalItem{IssueTitle: "Flow", Revisions: revisions})
		require.LessOrEqual(t, len(prompt), 2*mythicalPromptBytes)
		if quoted != "" && len(quoted) < 1024 {
			require.Contains(t, prompt, "> "+strings.ReplaceAll(decoded[0].Context, "\n", "\n> "))
		}
	})
}
