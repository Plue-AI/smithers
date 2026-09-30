package services

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func TestAgentEnvironmentService_SecretBindingsRoundTripAndOnlyBoundSecretsReachTheProxy(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	store := &agentEnvironmentTestQuerier{now: now}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	service := NewAgentEnvironmentService(store, codec)
	actor := &db.User{ID: 7}

	saved, err := service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", AgentEnvironmentSecretWrite{
		Name: "WAREHOUSE_TOKEN", Value: "wh-real",
		Hosts: []string{" Warehouse.Internal.Example ", "warehouse.internal.example"}, MatchHeaders: []string{"Authorization"},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"warehouse.internal.example"}, saved.Hosts, "normalised and deduplicated")
	assert.Equal(t, []string{"authorization"}, saved.MatchHeaders)
	assert.True(t, saved.ProxyBound())
	encoded, err := json.Marshal(saved)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "wh-real")
	assert.Contains(t, string(encoded), `"hosts":["warehouse.internal.example"]`)

	bound, err := service.LoadProxyBoundSecrets(context.Background(), 42)
	require.NoError(t, err)
	require.Len(t, bound, 1)
	assert.Equal(t, "WAREHOUSE_TOKEN", bound[0].Name)
	assert.Equal(t, "wh-real", bound[0].Value)
	assert.Equal(t, []string{"warehouse.internal.example"}, bound[0].Hosts)

	// An unbound secret stays on the legacy path and is invisible to the proxy loader.
	_, err = service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", AgentEnvironmentSecretWrite{Name: "LEGACY", Value: "plain"})
	require.NoError(t, err)
	bound, err = service.LoadProxyBoundSecrets(context.Background(), 42)
	require.NoError(t, err)
	assert.Empty(t, bound, "the test querier keeps one row; the unbound replacement is not proxy-visible")
}

func TestAgentEnvironmentService_RejectsUnenforceableBindings(t *testing.T) {
	t.Parallel()
	store := &agentEnvironmentTestQuerier{now: time.Now()}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	service := NewAgentEnvironmentService(store, codec)
	actor := &db.User{ID: 7}
	cases := map[string]AgentEnvironmentSecretWrite{
		"hosts without headers": {Name: "K", Value: "v", Hosts: []string{"a.example"}},
		"headers without hosts": {Name: "K", Value: "v", MatchHeaders: []string{"authorization"}},
		"host with scheme":      {Name: "K", Value: "v", Hosts: []string{"https://a.example"}, MatchHeaders: []string{"authorization"}},
		"bad header":            {Name: "K", Value: "v", Hosts: []string{"a.example"}, MatchHeaders: []string{"not a header"}},
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", input)
			require.Error(t, err)
		})
	}
}

// assertSecretHostNotExact checks the typed refusal of a wildcard or CIDR
// secret host (#3212): validation_failed on the hosts field, naming the host.
func assertSecretHostNotExact(t *testing.T, err error, mentions string) {
	t.Helper()
	apiErr := apiError(t, err)
	assert.Equal(t, http.StatusUnprocessableEntity, apiErr.Status)
	assert.Equal(t, pkgerrors.CodeValidationFailed, apiErr.Code)
	assert.Equal(t, pkgerrors.FaultUser, apiErr.Fault)
	assert.Equal(t, []pkgerrors.FieldError{{Resource: "Secret", Field: "hosts", Code: "invalid"}}, apiErr.Errors)
	assert.Contains(t, apiErr.Message, mentions)
}

// A wildcard or address range would let the proxy swap the value into
// requests to any host it covers; only exact host names bind (#3212).
func TestAgentEnvironmentService_RefusesWildcardAndCIDRHosts(t *testing.T) {
	t.Parallel()
	store := &agentEnvironmentTestQuerier{now: time.Now()}
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	service := NewAgentEnvironmentService(store, codec)
	actor := &db.User{ID: 7}
	for _, host := range []string{"*.ngrok-free.app", " *.Example.COM ", "127.0.0.0/8", "10.0.0.1/32", "0.0.0.0/0", "::/0"} {
		_, err := service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", AgentEnvironmentSecretWrite{
			Name: "K", Value: "v", Hosts: []string{"a.example", host}, MatchHeaders: []string{"authorization"},
		})
		assertSecretHostNotExact(t, err, strings.ToLower(strings.TrimSpace(host)))
		_, err = service.PutAgentEnvironment(context.Background(), actor, "alice", "demo", PutAgentEnvironmentInput{
			Secrets: []AgentEnvironmentSecretWrite{{Name: "K", Value: "v", Hosts: []string{host}, MatchHeaders: []string{"authorization"}}},
		})
		assertSecretHostNotExact(t, err, strings.ToLower(strings.TrimSpace(host)))
	}
	assert.Empty(t, store.secretValues, "nothing refused is stored")

	// An address literal is one exact host, stored in canonical form.
	saved, err := service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", AgentEnvironmentSecretWrite{
		Name: "K", Value: "v", Hosts: []string{"0:0::1", "::1", "10.0.0.7"}, MatchHeaders: []string{"authorization"},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"10.0.0.7", "::1"}, saved.Hosts)

	// A malformed host stays a plain bad request.
	_, err = service.PutAgentEnvironmentSecret(context.Background(), actor, "alice", "demo", AgentEnvironmentSecretWrite{
		Name: "K", Value: "v", Hosts: []string{"https://a.example"}, MatchHeaders: []string{"authorization"},
	})
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
}

// A row stored with a wildcard before exact hosts were required never reaches
// the proxy: loading it refuses with the same typed error, naming the secret.
func TestAgentEnvironmentService_StoredWildcardBindingIsRefusedAtLoad(t *testing.T) {
	t.Parallel()
	codec, err := webhook.NewSecretCodec("agent-environment-unit-test-key")
	require.NoError(t, err)
	encrypted, err := codec.EncryptString("tunnel-token")
	require.NoError(t, err)
	store := &agentEnvironmentTestQuerier{now: time.Now(), secretValues: []db.ListRepositoryAgentEnvironmentSecretValuesRow{
		{Name: "TUNNEL_TOKEN", ValueEncrypted: []byte(encrypted), Hosts: []string{"*.ngrok-free.app"}, MatchHeaders: []string{"authorization"}},
	}}
	bound, err := NewAgentEnvironmentService(store, codec).LoadProxyBoundSecrets(context.Background(), 42)
	assertSecretHostNotExact(t, err, "TUNNEL_TOKEN")
	assert.Nil(t, bound)
	assert.NotContains(t, err.Error(), "tunnel-token")
}
