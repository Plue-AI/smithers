package subscriptiontoken

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func chatGPTAccessTokenForTest(t *testing.T) string {
	t.Helper()
	claims, err := json.Marshal(map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct_1", "chatgpt_plan_type": "pro"}})
	require.NoError(t, err)
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"RS256"}`)) + "." + enc(claims) + "." + enc([]byte("sig"))
}

func TestHolds(t *testing.T) {
	t.Parallel()
	chatgpt := chatGPTAccessTokenForTest(t)
	for _, tc := range []struct {
		name, value string
		want        bool
	}{
		{"ANTHROPIC_AUTH_TOKEN", "sk-ant-oat01-abcdef", true},
		{"CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-abcdef", true},
		{"ANYTHING", "  sk-ant-oat01-abcdef\n", true},
		{"CLAUDE_REFRESH", "sk-ant-ort01-abcdef", true},
		{"CLAUDE_SESSION", "sk-ant-sid01-abcdef", true},
		{"", "curl -H 'Cookie: sessionKey=sk-ant-sid02-abc_DEF' https://claude.ai", true},
		{"SIDECAR", "image: flask-ant-sidecar", false},
		{"TASK", "desk-ant-oat-milk", false},
		{"CLAUDE_CODE_OAUTH_TOKEN", "whatever", true},
		{"OPENAI_CODEX_ACCESS_TOKEN", "whatever", true},
		{"CODEX_TOKEN", chatgpt, true},
		{"CODEX_AUTH", `{"auth_mode":"chatgpt","tokens":{"access_token":"a","refresh_token":"r"}}`, true},
		{"ANTHROPIC_API_KEY", "sk-ant-api03-abcdef", false},
		{"ANTHROPIC_AUTH_TOKEN", "gateway-bearer-token", false},
		{"OPENAI_API_KEY", "sk-proj-abcdef", false},
		{"GITHUB_TOKEN", "a.b.c", false},
		{"CONFIG", `{"auth_mode":"apikey"}`, false},
		// Setup scripts: a subscription variable assigned a literal, or a
		// Codex auth.json written inline, is a token; a reference is not.
		{"", "export CLAUDE_CODE_OAUTH_TOKEN=\"plain-literal\"\nnpm ci", true},
		{"", "echo ok\nOPENAI_CODEX_ACCESS_TOKEN=abc123 codex exec", true},
		{"", "cat > ~/.codex/auth.json <<'EOF'\n{\n  \"auth_mode\": \"chatgpt\",\n  \"tokens\": {}\n}\nEOF", true},
		{"", "claude --print hi # uses $CLAUDE_CODE_OAUTH_TOKEN", false},
		{"", "export CLAUDE_CODE_OAUTH_TOKEN=\"$FROM_PROXY\"", false},
		{"", "npm ci && npm test", false},
		{"", "echo -n " + chatgpt + ">/root/.codex/tok", true},
		{"", "curl https://h.example.com/" + chatgpt, true},
		{"", "x.y." + chatgpt, true},
		{"", `cat > ~/.codex/auth.json <<EOF
{"tokens":{"refresh_token":"rt_live"}}
EOF`, true},
		{"", `{"CLAUDE_CODE_OAUTH_TOKEN": "literal"}`, true},
		// Not tokens: blanking, references, commands and prose.
		{"", "CLAUDE_CODE_OAUTH_TOKEN= claude -p hi", false},
		{"", "export CLAUDE_CODE_OAUTH_TOKEN=\nnpm ci", false},
		{"", `echo "CLAUDE_CODE_OAUTH_TOKEN: missing"`, false},
		{"", `[ "$CLAUDE_CODE_OAUTH_TOKEN" = "unset" ]`, false},
		{"", "CLAUDE_CODE_OAUTH_TOKEN=`cat /run/tok`", false},
		{"", `{"CLAUDE_CODE_OAUTH_TOKEN": null}`, false},
		{"", "export CLAUDE_CODE_OAUTH_TOKEN=CLAUDE_CODE_OAUTH_TOKEN", false},
		{"", "export claude_code_oauth_token=x", false},
		{"", `{"CLAUDE_CODE_OAUTH_TOKEN": "CLAUDE_CODE_OAUTH_TOKEN"}`, false},
		{"", `{"tokens":{"access_token":"gho_other_service"}}`, false},
	} {
		assert.Equal(t, tc.want, Holds(tc.name, tc.value), "%s=%s", tc.name, tc.value)
	}
}

func TestRedact(t *testing.T) {
	t.Parallel()
	chatgpt := chatGPTAccessTokenForTest(t)
	for _, tc := range []struct{ script, want string }{
		{"export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\nnpm ci", "export CLAUDE_CODE_OAUTH_TOKEN=[redacted]\nnpm ci"},
		{"export CLAUDE_CODE_OAUTH_TOKEN='literal'", "export CLAUDE_CODE_OAUTH_TOKEN='[redacted]'"},
		{"curl -H 'Authorization: Bearer " + chatgpt + "' x", "curl -H 'Authorization: Bearer [redacted]' x"},
		{`echo '{"auth_mode":"chatgpt","tokens":{"access_token":"a1","refresh_token":"r1"}}' > auth.json`, `echo '{"auth_mode":"[redacted]","tokens":{"access_token":"[redacted]","refresh_token":"[redacted]"}}' > auth.json`},
		{"npm ci # ${CLAUDE_CODE_OAUTH_TOKEN:-unset}", "npm ci # ${CLAUDE_CODE_OAUTH_TOKEN:-unset}"},
		{"echo -n " + chatgpt + ">/root/.codex/tok", "echo -n [redacted]>/root/.codex/tok"},
		{`{"tokens":{"id_token":"` + chatgpt + `","refresh_token":"rt_live"}}`, `{"tokens":{"id_token":"[redacted]","refresh_token":"[redacted]"}}`},
		{`{"CLAUDE_CODE_OAUTH_TOKEN": "literal", "x": 1}`, `{"CLAUDE_CODE_OAUTH_TOKEN": "[redacted]", "x": 1}`},
	} {
		got := Redact(tc.script)
		assert.Equal(t, tc.want, got)
		assert.False(t, Holds("", got), got)
	}
}

// #2777: the stored-token scan removes a Claude token from a setup script in
// place and leaves a ChatGPT one, which only a flag-off deployment refuses.
func TestRemoveClaude(t *testing.T) {
	t.Parallel()
	chatgpt := chatGPTAccessTokenForTest(t)
	for _, tc := range []struct{ script, want string }{
		{"export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\nnpm ci", "export CLAUDE_CODE_OAUTH_TOKEN=[removed:#2777]\nnpm ci"},
		{"export ANTHROPIC_AUTH_TOKEN='sk-ant-oat01-abc' REFRESH=sk-ant-ort01-def", "export ANTHROPIC_AUTH_TOKEN='[removed:#2777]' REFRESH=[removed:#2777]"},
		{"curl -b sessionKey=sk-ant-sid01-abc https://claude.ai", "curl -b sessionKey=[removed:#2777] https://claude.ai"},
		{`{"CLAUDE_CODE_OAUTH_TOKEN": "literal"}`, `{"CLAUDE_CODE_OAUTH_TOKEN": "[removed:#2777]"}`},
		{"export OPENAI_CODEX_ACCESS_TOKEN=" + chatgpt + " CLAUDE_CODE_OAUTH_TOKEN=x", "export OPENAI_CODEX_ACCESS_TOKEN=" + chatgpt + " CLAUDE_CODE_OAUTH_TOKEN=[removed:#2777]"},
		{"export ANTHROPIC_API_KEY=sk-ant-api03-key\nnpm ci", "export ANTHROPIC_API_KEY=sk-ant-api03-key\nnpm ci"},
	} {
		got := RemoveClaude(tc.script)
		assert.Equal(t, tc.want, got)
		assert.False(t, HoldsClaude("", got), got)
		assert.Equal(t, got, RemoveClaude(got), "removal is idempotent")
	}
	assert.True(t, Holds("", RemoveClaude("export OPENAI_CODEX_ACCESS_TOKEN="+chatgpt)), "a ChatGPT token is left for the flag to decide")
}
