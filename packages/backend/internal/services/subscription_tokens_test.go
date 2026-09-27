package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func chatGPTAccessTokenForTest(t *testing.T) string {
	t.Helper()
	claims, err := json.Marshal(map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct_1", "chatgpt_plan_type": "pro"}})
	require.NoError(t, err)
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"RS256"}`)) + "." + enc(claims) + "." + enc([]byte("sig"))
}

func TestIsSubscriptionToken(t *testing.T) {
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
		assert.Equal(t, tc.want, isSubscriptionToken(tc.name, tc.value), "%s=%s", tc.name, tc.value)
	}
}

func requireSubscriptionTokenRefused(t *testing.T, err error) {
	t.Helper()
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 403, apiErr.Status)
	assert.Contains(t, apiErr.Message, "feature not available")
}

// Hosted Plue (flag off, the default) refuses to store a Claude or ChatGPT
// subscription token through any secret or variable path; a self-hosted
// deployment with the flag on stores it.
func TestSubscriptionTokensRefusedUnlessFlagOn(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	actor := &db.User{ID: 1}
	const token = "sk-ant-oat01-subscription"
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)

	type write func(allowed bool) error
	for name, fn := range map[string]write{
		"repo secret": func(allowed bool) error {
			_, err := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}, WithSecretSubscriptionTokens(allowed)).SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_AUTH_TOKEN", token)
			return err
		},
		"org secret": func(allowed bool) error {
			_, err := NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}, WithSecretSubscriptionTokens(allowed)).SetOrgSecret(ctx, actor, "acme", "CLAUDE_CODE_OAUTH_TOKEN", token)
			return err
		},
		"repo variable": func(allowed bool) error {
			_, err := NewVariableService(&mockVariableQuerier{}, WithVariableSubscriptionTokens(allowed)).SetVariable(ctx, actor, "alice", "demo", "ANTHROPIC_AUTH_TOKEN", token)
			return err
		},
		"org variable": func(allowed bool) error {
			_, err := NewVariableService(&mockVariableQuerier{}, WithVariableSubscriptionTokens(allowed)).SetOrgVariable(ctx, actor, "acme", "ANTHROPIC_AUTH_TOKEN", token)
			return err
		},
		"agent environment secret": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironmentSecret(ctx, &db.User{ID: 7}, "alice", "demo", AgentEnvironmentSecretWrite{Name: "CLAUDE_CODE_OAUTH_TOKEN", Value: token})
			return err
		},
		"agent environment bulk secret": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{Secrets: []AgentEnvironmentSecretWrite{{Name: "ANTHROPIC_AUTH_TOKEN", Value: token}}})
			return err
		},
		"agent environment setup script": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{SetupScript: "export CLAUDE_CODE_OAUTH_TOKEN=" + token + "\nnpm ci"})
			return err
		},
		"agent environment setup script with a ChatGPT token": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{SetupScript: "echo -n " + chatGPTAccessTokenForTest(t) + ">/root/.codex/tok"})
			return err
		},
		"agent environment setup script with a Codex auth.json": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{SetupScript: "cat > ~/.codex/auth.json <<EOF\n{\"tokens\":{\"refresh_token\":\"rt_live\"}}\nEOF"})
			return err
		},
		"agent environment variable": func(allowed bool) error {
			svc := NewAgentEnvironmentService(&agentEnvironmentTestQuerier{}, codec, WithAgentEnvironmentSubscriptionTokens(allowed))
			_, err := svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{Env: []AgentEnvironmentVariable{{Name: "ANTHROPIC_AUTH_TOKEN", Value: token}}})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			requireSubscriptionTokenRefused(t, fn(false))
			require.NoError(t, fn(true))
		})
	}

	// The default constructor is the hosted posture.
	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_AUTH_TOKEN", token)
	requireSubscriptionTokenRefused(t, err)
	// An ordinary API key is unaffected.
	_, err = NewSecretService(&mockSecretQuerier{}, webhook.NoopSecretCodec{}).SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_API_KEY", "sk-ant-api03-key")
	require.NoError(t, err)
}

// An agent environment saved before the setup-script refusal can still hold a
// subscription token in plain text. With the flag off it is never used: the
// public answer redacts it and asks for a reconnect, and provisioning and the
// agent's variables refuse, all without echoing the value.
func TestStoredSubscriptionTokenInAgentEnvironmentIsRefusedAndRedacted(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const token = "sk-ant-oat01-storedplaintext"
	chatgpt := chatGPTAccessTokenForTest(t)
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	stored := func(script, env string) *agentEnvironmentTestQuerier {
		return &agentEnvironmentTestQuerier{config: &db.RepositoryAgentEnvironment{RepositoryID: 42, SetupScript: script, EnvironmentVariables: json.RawMessage(env)}}
	}
	for name, store := range map[string]*agentEnvironmentTestQuerier{
		"setup script":                      stored("export CLAUDE_CODE_OAUTH_TOKEN="+token+"\nnpm ci", `[{"name":"NODE_ENV","value":"test"}]`),
		"codex auth.json without auth_mode": stored("cat > ~/.codex/auth.json <<EOF\n{\"tokens\":{\"id_token\":\""+chatgpt+"\",\"refresh_token\":\"rt_live\"}}\nEOF", `[{"name":"NODE_ENV","value":"test"}]`),
		"variable":                          stored("npm ci", `[{"name":"CODEX_TOKEN","value":"`+chatgpt+`"},{"name":"NODE_ENV","value":"test"}]`),
	} {
		t.Run(name, func(t *testing.T) {
			svc := NewAgentEnvironmentService(store, codec)
			response, err := svc.GetAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo")
			require.NoError(t, err)
			assert.True(t, response.ReconnectRequired)
			encoded, err := json.Marshal(response)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), token)
			assert.NotContains(t, string(encoded), chatgpt)
			assert.NotContains(t, string(encoded), "rt_live")
			assert.Contains(t, string(encoded), `"reconnect_required":true`)
			assert.Contains(t, string(encoded), "NODE_ENV")

			_, err = svc.LoadForProvisioning(ctx, 42)
			requireSubscriptionTokenRefused(t, err)
			assert.NotContains(t, err.Error(), token)
			_, err = svc.LoadVariables(ctx, 42)
			requireSubscriptionTokenRefused(t, err)

			// Saving the redacted answer back clears the stored token.
			_, err = svc.PutAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo", PutAgentEnvironmentInput{SetupScript: response.SetupScript, Env: response.Env})
			require.NoError(t, err)
			assert.NotContains(t, store.config.SetupScript, token)
			assert.NotContains(t, string(store.config.EnvironmentVariables), chatgpt)
			assert.NotContains(t, store.config.SetupScript, "rt_live")
			_, err = svc.LoadForProvisioning(ctx, 42)
			require.NoError(t, err)
			cleared, err := svc.GetAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo")
			require.NoError(t, err)
			assert.False(t, cleared.ReconnectRequired)
		})
	}

	// A self-hosted deployment with the flag on uses what it stored.
	svc := NewAgentEnvironmentService(stored("export CLAUDE_CODE_OAUTH_TOKEN="+token, `[]`), codec, WithAgentEnvironmentSubscriptionTokens(true))
	response, err := svc.GetAgentEnvironment(ctx, &db.User{ID: 7}, "alice", "demo")
	require.NoError(t, err)
	assert.False(t, response.ReconnectRequired)
	assert.Contains(t, response.SetupScript, token)
	config, err := svc.LoadForProvisioning(ctx, 42)
	require.NoError(t, err)
	assert.Contains(t, config.SetupScript, token)
}

func TestRedactSubscriptionTokens(t *testing.T) {
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
		got := redactSubscriptionTokens(tc.script)
		assert.Equal(t, tc.want, got)
		assert.False(t, isSubscriptionToken("", got), got)
	}
}

func TestAgentEnvironmentLoadErrorKeepsTheStoredTokenRefusal(t *testing.T) {
	t.Parallel()
	requireSubscriptionTokenRefused(t, agentEnvironmentLoadError(storedSubscriptionTokenRefused()))
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, agentEnvironmentLoadError(assert.AnError), &apiErr)
	assert.Equal(t, 500, apiErr.Status)
}
