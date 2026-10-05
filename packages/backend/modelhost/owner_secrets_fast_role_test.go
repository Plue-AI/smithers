package modelhost_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
)

// The app agent's turn names no model. On an install it runs on the fast
// role Model access wrote (mvp.md §6.5), not on the owner's coding model.
func TestResolveChatModelRunsUnnamedTurnsOnTheInstallFastRole(t *testing.T) {
	f := newOwnerModelsFixture(t)
	ctx := context.Background()
	require.Equal(t, true, f.credential(t, "enroll", "enroll-fast-openai", "OPENAI_API_KEY", "https://api.openai.com", "openai-value")["ok"])
	require.Equal(t, true, f.credential(t, "enroll", "enroll-fast-cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai", "cerebras-value")["ok"])
	coding := `{"protocol":"openai-responses","modelId":"gpt-5.1","credential":"OPENAI_API_KEY"}`
	_, err := f.pool.Exec(ctx, `INSERT INTO owner_model_defaults(user_id,model) VALUES($1,$2)`, f.owner, json.RawMessage(coding))
	require.NoError(t, err)
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return ownerModelsSecretKey })
	require.NoError(t, err)
	t.Cleanup(resolver.Close)
	unnamed := json.RawMessage(`{"messages":[]}`)
	resolve := func(request json.RawMessage) modelhost.Binding {
		t.Helper()
		binding, err := resolver.ResolveChatModel(ctx, f.owner, 0, request)
		require.NoError(t, err)
		return binding
	}

	// Before Model access writes the roles, the owner's default answers.
	binding := resolve(unnamed)
	require.JSONEq(t, coding, string(binding.Model))
	require.Equal(t, "openai-value", binding.CredentialValue)

	require.NoError(t, db.New(f.pool).UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:fast", Value: []byte(services.InstallFastModel)}))
	// The install's fast role belongs to its owner, not to any other user.
	binding = resolve(unnamed)
	require.JSONEq(t, coding, string(binding.Model))

	_, err = f.pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, f.owner)
	require.NoError(t, err)
	binding = resolve(unnamed)
	require.JSONEq(t, services.InstallFastModel, string(binding.Model))
	require.Equal(t, "CEREBRAS_API_KEY", binding.CredentialName)
	require.Equal(t, "cerebras-value", binding.CredentialValue)
	binding = resolve(json.RawMessage(`{"model":null}`))
	require.Equal(t, "CEREBRAS_API_KEY", binding.CredentialName)

	// A turn that names its model keeps it.
	named, err := json.Marshal(map[string]any{"model": json.RawMessage(coding)})
	require.NoError(t, err)
	binding = resolve(named)
	require.JSONEq(t, coding, string(binding.Model))
	require.Equal(t, "openai-value", binding.CredentialValue)
}
