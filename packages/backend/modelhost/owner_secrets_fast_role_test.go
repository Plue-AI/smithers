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

// On an install, an active roster member's app agent turn runs on the
// install's models, which the owner set and pays for; a model the member's
// request names is ignored. A suspended member or a person off the roster
// has no install models.
func TestResolveChatModelRunsMemberTurnsOnTheInstallModels(t *testing.T) {
	f := newOwnerModelsFixture(t)
	ctx := context.Background()
	require.Equal(t, true, f.credential(t, "enroll", "enroll-member-cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai", "cerebras-value")["ok"])
	require.Equal(t, true, f.credential(t, "enroll", "enroll-member-openai", "OPENAI_API_KEY", "https://api.openai.com", "openai-value")["ok"])
	_, err := f.pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, f.owner)
	require.NoError(t, err)
	q := db.New(f.pool)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:fast", Value: []byte(services.InstallFastModel)}))
	var repo int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'demo','demo') RETURNING id`, f.owner).Scan(&repo))
	binding, _ := json.Marshal(map[string]any{"owner_login": "maya", "repository_name": "demo", "repository_id": repo})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	person := func(login, permission string, suspended bool) int64 {
		var id int64
		require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, login).Scan(&id))
		if permission != "" {
			_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,suspended_at) VALUES($1,$2,$3,CASE WHEN $4::boolean THEN now() END)`, repo, id, permission, suspended)
			require.NoError(t, err)
		}
		return id
	}
	ben, alice, dave, carol := person("ben", "admin", false), person("alice", "write", false), person("dave", "write", true), person("carol", "", false)
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return ownerModelsSecretKey })
	require.NoError(t, err)
	t.Cleanup(resolver.Close)
	named := json.RawMessage(`{"model":{"protocol":"openai-responses","modelId":"gpt-5.1-pro","credential":"OPENAI_API_KEY"}}`)
	for _, member := range []int64{ben, alice} {
		for _, request := range []json.RawMessage{json.RawMessage(`{"messages":[]}`), named} {
			got, err := resolver.ResolveChatModel(ctx, member, 0, request)
			require.NoError(t, err)
			require.JSONEq(t, services.InstallFastModel, string(got.Model))
			require.Equal(t, "CEREBRAS_API_KEY", got.CredentialName)
			require.Equal(t, "cerebras-value", got.CredentialValue)
		}
	}
	for _, outsider := range []int64{dave, carol} {
		_, err := resolver.ResolveChatModel(ctx, outsider, 0, json.RawMessage(`{"messages":[]}`))
		require.ErrorIs(t, err, modelhost.ErrOwnerModelUnset)
	}
}
