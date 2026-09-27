package modelhost_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

const ownerModelsSecretKey = "owner-models-test-key"

type ownerModelsFixture struct {
	pool     *pgxpool.Pool
	url      string
	owner    int64
	repo     int64
	handlers modelhost.OwnerModels
}

func newOwnerModelsFixture(t *testing.T) ownerModelsFixture {
	t.Helper()
	pool, url := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var owner, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username,lower_username) VALUES ('modelowner','modelowner') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (user_id,name,lower_name) VALUES ($1,'modelrepo','modelrepo') RETURNING id`, owner).Scan(&repo))
	codec, err := webhook.NewSecretCodec(ownerModelsSecretKey)
	require.NoError(t, err)
	return ownerModelsFixture{pool: pool, url: url, owner: owner, repo: repo, handlers: modelhost.OwnerModels{Pool: pool, Codec: codec}}
}

func (f ownerModelsFixture) call(t *testing.T, handler http.HandlerFunc, method string, body any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(body)
	require.NoError(t, err)
	request := httptest.NewRequest(method, "/api/model", bytes.NewReader(encoded))
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: f.owner, Username: "modelowner"}}))
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	var result map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &result), recorder.Body.String())
	return result
}

func (f ownerModelsFixture) credential(t *testing.T, action, requestID, name, origin, value string) map[string]any {
	t.Helper()
	return f.call(t, f.handlers.Credential, http.MethodPost, map[string]string{"action": action, "requestId": requestID, "name": name, "origin": origin, "value": value})
}

func failureCode(result map[string]any) string {
	failure, _ := result["failure"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

func TestOwnerModelCredentialLifecycle(t *testing.T) {
	f := newOwnerModelsFixture(t)
	openai := "https://api.openai.com"

	require.Equal(t, true, f.credential(t, "enroll", "enroll-0001", "OPENAI_API_KEY", openai, "first")["ok"])
	require.Equal(t, "exists", failureCode(f.credential(t, "enroll", "enroll-0002", "OPENAI_API_KEY", openai, "again")))

	removed := f.credential(t, "remove", "remove-0001", "OPENAI_API_KEY", "", "")
	require.Equal(t, true, removed["ok"])
	require.Equal(t, false, removed["credential"].(map[string]any)["present"])

	reenrolled := f.credential(t, "enroll", "enroll-0003", "OPENAI_API_KEY", openai, "second")
	require.Equal(t, true, reenrolled["ok"], reenrolled)
	require.Equal(t, true, reenrolled["credential"].(map[string]any)["present"])

	rotated := f.credential(t, "rotate", "rotate-0001", "OPENAI_API_KEY", "", "third")
	require.Equal(t, true, rotated["ok"], rotated)

	// A retried request ID returns the first committed result.
	replayed := f.credential(t, "enroll", "enroll-0001", "OPENAI_API_KEY", openai, "ignored")
	require.Equal(t, true, replayed["ok"])

	require.Equal(t, "unknown", failureCode(f.credential(t, "remove", "remove-0002", "NEVER_ENROLLED", "", "")))
	require.Equal(t, "unknown", failureCode(f.credential(t, "rotate", "rotate-0002", "NEVER_ENROLLED", "", "value")))
	require.Equal(t, "origin", f.credential(t, "enroll", "enroll-0004", "ANTHROPIC_API_KEY", "https://evil.example", "value")["failure"].(map[string]any)["field"])
	require.Equal(t, "origin", f.credential(t, "enroll", "enroll-0005", "CUSTOM_KEY", "http://example.com", "value")["failure"].(map[string]any)["field"])

	catalog := f.call(t, f.handlers.Catalog, http.MethodGet, nil)
	var openaiRow map[string]any
	for _, entry := range catalog["credentials"].([]any) {
		row := entry.(map[string]any)
		if row["name"] == "OPENAI_API_KEY" {
			openaiRow = row
		}
	}
	require.Equal(t, true, openaiRow["present"])
	require.Equal(t, true, openaiRow["managed"])
}

func TestResolveChatModelCredentialSources(t *testing.T) {
	f := newOwnerModelsFixture(t)
	ctx := context.Background()
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return ownerModelsSecretKey })
	require.NoError(t, err)
	t.Cleanup(resolver.Close)
	request := func(credential string) json.RawMessage {
		encoded, err := json.Marshal(map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "m", "credential": credential}})
		require.NoError(t, err)
		return encoded
	}

	_, err = resolver.ResolveChatModel(ctx, f.owner, 0, json.RawMessage(`{}`))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing, "no default model")

	_, err = resolver.ResolveChatModel(ctx, f.owner, 0, request("OPENAI_API_KEY"))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)

	require.Equal(t, true, f.credential(t, "enroll", "enroll-1001", "OPENAI_API_KEY", "https://api.openai.com", "owner-key")["ok"])
	binding, err := resolver.ResolveChatModel(ctx, f.owner, 0, request("OPENAI_API_KEY"))
	require.NoError(t, err)
	require.Equal(t, "owner-key", binding.CredentialValue)
	require.Empty(t, binding.CredentialOrigin)

	_, err = resolver.ResolveChatModel(ctx, f.owner+1, 0, request("OPENAI_API_KEY"))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing, "another owner's credential")

	// A repository secret takes precedence over the owner credential.
	codec, err := webhook.NewSecretCodec(ownerModelsSecretKey)
	require.NoError(t, err)
	sealed, err := codec.EncryptString("repository-key")
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_secrets (repository_id,name,value_encrypted) VALUES ($1,'OPENAI_API_KEY',$2)`, f.repo, []byte(sealed))
	require.NoError(t, err)
	binding, err = resolver.ResolveChatModel(ctx, f.owner, f.repo, request("OPENAI_API_KEY"))
	require.NoError(t, err)
	require.Equal(t, "repository-key", binding.CredentialValue)

	// A custom credential is pinned to its enrolled origin.
	require.Equal(t, true, f.credential(t, "enroll", "enroll-1002", "CUSTOM_KEY", "https://models.example", "custom-key")["ok"])
	binding, err = resolver.ResolveChatModel(ctx, f.owner, 0, request("CUSTOM_KEY"))
	require.NoError(t, err)
	require.Equal(t, "https://models.example", binding.CredentialOrigin)

	// A removed credential reads as missing, not as an empty key.
	require.Equal(t, true, f.credential(t, "remove", "remove-1001", "CUSTOM_KEY", "", "")["ok"])
	_, err = resolver.ResolveChatModel(ctx, f.owner, 0, request("CUSTOM_KEY"))
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)

	// The owner default model answers a turn with no model field.
	require.Equal(t, true, f.call(t, f.handlers.SetDefault, http.MethodPut, map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "m", "credential": "OPENAI_API_KEY"}})["ok"])
	binding, err = resolver.ResolveChatModel(ctx, f.owner, 0, json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Equal(t, "owner-key", binding.CredentialValue)
	defaults := f.call(t, f.handlers.Default, http.MethodGet, nil)
	require.Equal(t, "OPENAI_API_KEY", defaults["model"].(map[string]any)["credential"])
}

// #2222: a model credential is an API key. A Claude or ChatGPT subscription
// token is refused on save and on read, with the detector secrets use, on
// every deployment; subscription logins belong to the provider connections
// pool.
func TestOwnerModelCredentialsRefuseSubscriptionTokens(t *testing.T) {
	f := newOwnerModelsFixture(t)
	ctx := context.Background()
	anthropic := "https://api.anthropic.com"
	invalidField := func(result map[string]any) string {
		failure, _ := result["failure"].(map[string]any)
		field, _ := failure["field"].(string)
		return failureCode(result) + ":" + field
	}

	require.Equal(t, "invalid:value", invalidField(f.credential(t, "enroll", "enroll-2001", "ANTHROPIC_API_KEY", anthropic, "sk-ant-oat01-subscription")))
	require.Equal(t, "invalid:value", invalidField(f.credential(t, "enroll", "enroll-2002", "CLAUDE_CODE_OAUTH_TOKEN", anthropic, "anything")))
	require.Equal(t, true, f.credential(t, "enroll", "enroll-2003", "ANTHROPIC_API_KEY", anthropic, "sk-ant-api03-key")["ok"])
	require.Equal(t, "invalid:value", invalidField(f.credential(t, "rotate", "rotate-2001", "ANTHROPIC_API_KEY", "", "sk-ant-ort01-subscription")))

	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return f.url }, func() string { return ownerModelsSecretKey })
	require.NoError(t, err)
	t.Cleanup(resolver.Close)
	request, err := json.Marshal(map[string]any{"model": map[string]string{"protocol": "anthropic-messages", "modelId": "m", "credential": "ANTHROPIC_API_KEY"}})
	require.NoError(t, err)
	binding, err := resolver.ResolveChatModel(ctx, f.owner, f.repo, request)
	require.NoError(t, err)
	require.Equal(t, "sk-ant-api03-key", binding.CredentialValue)

	// A repository secret overriding the owner's API key with a token is
	// refused as a missing credential, naming the credential, not the value.
	codec, err := webhook.NewSecretCodec(ownerModelsSecretKey)
	require.NoError(t, err)
	seal := func(value string) string {
		sealed, err := codec.EncryptString(value)
		require.NoError(t, err)
		return sealed
	}
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_secrets (repository_id,name,value_encrypted) VALUES ($1,'ANTHROPIC_API_KEY',$2)`, f.repo, []byte(seal("sk-ant-oat01-repository")))
	require.NoError(t, err)
	_, err = resolver.ResolveChatModel(ctx, f.owner, f.repo, request)
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	require.ErrorContains(t, err, "ANTHROPIC_API_KEY holds a Claude or ChatGPT subscription token")
	require.NotContains(t, err.Error(), "sk-ant-oat01")

	// An owner credential stored before the save refusal is refused on read.
	_, err = f.pool.Exec(ctx, `UPDATE owner_model_credentials SET value_encrypted=$2 WHERE user_id=$1 AND name='ANTHROPIC_API_KEY'`, f.owner, seal("sk-ant-oat01-stored"))
	require.NoError(t, err)
	_, err = resolver.ResolveChatModel(ctx, f.owner, 0, request)
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	require.NotContains(t, err.Error(), "sk-ant-oat01")

	// Replacing it with an API key is the recovery.
	require.Equal(t, true, f.credential(t, "rotate", "rotate-2002", "ANTHROPIC_API_KEY", "", "sk-ant-api03-new")["ok"])
	binding, err = resolver.ResolveChatModel(ctx, f.owner, 0, request)
	require.NoError(t, err)
	require.Equal(t, "sk-ant-api03-new", binding.CredentialValue)
}
