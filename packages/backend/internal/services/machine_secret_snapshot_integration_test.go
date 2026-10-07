package services

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Host-side C-SEC-01 automation only. This scans the actual decrypted delivery
// snapshot, not a guest filesystem or capture. Installed-bundle microVM scans,
// production dispatch, model-proxy and session observations remain required.
func TestMachineSecretScanDeliverySnapshotPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "scanowner", LowerUsername: "scanowner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "scan", LowerName: "scan", DefaultBookmark: "main"})
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("machine-scan-test-encryption-key")
	require.NoError(t, err)
	service, injector := NewSecretService(q, codec), NewSecretInjector(q, codec)
	const unbound = "scan-unbound-0123456789abcdef0123456789"
	const rotated = "scan-rotated-0123456789abcdef0123456789"
	const bound = "scan-bound-0123456789abcdef012345678901"
	const mainOnly = "scan-main-0123456789abcdef0123456789012"
	const provider = "scan-provider-0123456789abcdef01234567"
	const pem = "scan-pem-0123456789abcdef01234567890123"
	t.Setenv("ANTHROPIC_API_KEY", provider)
	t.Setenv("GITHUB_APP_PRIVATE_KEY", pem)
	for _, fixture := range []struct {
		name, value string
		main        bool
		binding     *SecretBinding
	}{
		{"CANARY_TOKEN", unbound, false, nil},
		{"HOST_TOKEN", bound, false, &SecretBinding{Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}},
		{"DEPLOY_KEY", mainOnly, true, nil},
	} {
		_, err := service.SetSecret(ctx, &owner, owner.Username, repo.Name, fixture.name, fixture.value, &fixture.main, fixture.binding, nil)
		require.NoError(t, err)
	}
	snapshot := func(want map[string]string, relay []sandbox.EgressProxySecret) RepositorySecretSnapshot {
		t.Helper()
		got, err := injector.RepositorySecrets(ctx, repo.ID, false)
		require.NoError(t, err)
		require.Equal(t, want, got.Env)
		require.Equal(t, want, got.Secrets)
		require.Equal(t, relay, got.Bound)
		body, err := json.Marshal(got.Env)
		require.NoError(t, err)
		for _, forbidden := range []string{bound, mainOnly, provider, pem} {
			require.NotContains(t, string(body), forbidden)
		}
		metadata, err := service.ListSecrets(ctx, &owner, owner.Username, repo.Name)
		require.NoError(t, err)
		body, err = json.Marshal(metadata)
		require.NoError(t, err)
		for _, value := range []string{unbound, rotated, bound, mainOnly, provider, pem} {
			require.NotContains(t, string(body), value)
		}
		return got
	}
	relay := []sandbox.EgressProxySecret{{Name: "HOST_TOKEN", Value: bound, Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}}
	old := snapshot(map[string]string{"CANARY_TOKEN": unbound}, relay)
	_, err = service.SetSecret(ctx, &owner, owner.Username, repo.Name, "CANARY_TOKEN", rotated, nil, nil, nil)
	require.NoError(t, err)
	current := snapshot(map[string]string{"CANARY_TOKEN": rotated}, relay)
	require.Equal(t, unbound, old.Env["CANARY_TOKEN"], "existing consumers retain their snapshot")
	require.NotContains(t, RedactSecretValues(current.Secrets, "probe="+rotated), rotated)
	// Scope changes and host binding changes must remove previously injected names.
	_, err = service.UpdateSecret(ctx, &owner, owner.Username, repo.Name, "CANARY_TOKEN", boolPtr(true), nil, nil)
	require.NoError(t, err)
	snapshot(map[string]string{}, relay)
	_, err = service.UpdateSecret(ctx, &owner, owner.Username, repo.Name, "CANARY_TOKEN", boolPtr(false), nil, nil)
	require.NoError(t, err)
	_, err = service.SetSecretBinding(ctx, &owner, owner.Username, repo.Name, "CANARY_TOKEN", SecretBinding{Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}})
	require.NoError(t, err)
	snapshot(map[string]string{}, []sandbox.EgressProxySecret{
		{Name: "CANARY_TOKEN", Value: rotated, Hosts: []string{"api.example.com"}, MatchHeaders: []string{"authorization"}}, relay[0],
	})
	require.NoError(t, service.DeleteSecret(ctx, &owner, owner.Username, repo.Name, "CANARY_TOKEN"))
	snapshot(map[string]string{}, relay)
}
