package product

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// startRun records a coding run's managed Flow host on repositoryID for the
// user who initiated it, and answers the host's pool credential: the model
// credential derived from its binding.
func startRun(t *testing.T, f poolFixture, repositoryID, userID int64) string {
	t.Helper()
	ctx := context.Background()
	// Each independent coding host needs its own branch machine (M-17).
	var workspaceID string
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id, target_bookmark) VALUES ($1, $2, $3) RETURNING id::text`, repositoryID, userID, "pool-run/"+uuid.NewString()).Scan(&workspaceID))
	bindingID := uuid.NewString()
	control := "control-" + bindingID
	controlHash := sha256.Sum256([]byte(control))
	_, err := f.pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings (id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation, credential_ciphertext, credential_hash, state)
		VALUES ($1, $2, $3, 'agent-session', $4, $5, $6, $7, 'coding', 'smithers-coding-host', $8, $9, 1, $10, $11, 'running')`,
		bindingID, fmt.Sprintf("repository:%d", repositoryID), fmt.Sprintf("user:%d", userID), "session-"+bindingID,
		repositoryID, userID, workspaceID, strings.Repeat("a", 64), strings.Repeat("b", 40), "enc:"+control, controlHash[:])
	require.NoError(t, err)
	return flowhost.ModelCredential(bindingID, control)
}

// #1758: a coding run's host calls models through the account pool with its
// binding's model credential, one account per request. With two Codex accounts and the first at
// its usage limit, the run's call is served by the second before any byte
// reaches the guest, and the run's next call goes straight to the second.
func TestProviderPoolServesAnAgentRunAndSkipsALimitedCodexAccount(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	var ids []string
	for _, account := range []string{"a", "b"} {
		out, err := f.svc.ConnectForUser(ctx, f.alice, services.ConnectProviderInput{Provider: "codex", Kind: "oauth", Label: "codex-" + account, AccessToken: "codex-" + account, RefreshToken: "refresh-" + account, AccountID: "acct-" + account})
		require.NoError(t, err)
		ids = append(ids, out.ID)
	}
	// Account a is first in the rotation.
	require.NoError(t, f.svc.Reorder(ctx, f.alice, "codex", ids))
	var mu sync.Mutex
	var served []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		account := r.Header.Get("Chatgpt-Account-Id")
		mu.Lock()
		served = append(served, account)
		mu.Unlock()
		if account == "acct-a" {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\"}\n\n")
	}))
	t.Cleanup(upstream.Close)
	handler := &routes.ProviderPoolHandler{Pool: f.svc, Scopes: services.NewProviderPoolScopes(f.q, f.pool, poolCodec{}), Upstreams: map[string]string{"chatgpt": upstream.URL}}
	credential := startRun(t, f, f.repoID, f.alice.ID)
	call := func() int {
		req := httptest.NewRequest(http.MethodPost, "/provider-pool/chatgpt/codex/responses", strings.NewReader(`{"model":"gpt-6-luna","stream":true,"input":[]}`))
		req.Header.Set("Authorization", "Bearer "+credential)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}

	require.Equal(t, http.StatusOK, call())
	require.Equal(t, []string{"acct-a", "acct-b"}, served, "the 429 is retried on the next account before anything reaches the guest")
	var limited bool
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT limited_until > now() FROM provider_connections WHERE account_id = 'acct-a'`).Scan(&limited))
	require.True(t, limited, "the limited account is parked until its reset")

	served = nil
	require.Equal(t, http.StatusOK, call())
	require.Equal(t, []string{"acct-b"}, served, "the run's next call uses the second account")

	// The guest learns which routes have accounts from the pool itself.
	req := httptest.NewRequest(http.MethodGet, "/provider-pool/routes", nil)
	req.Header.Set("Authorization", "Bearer "+credential)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	require.JSONEq(t, `{"routes":["chatgpt"]}`, rec.Body.String())
}

// #1945: a run on an organization repository uses the initiating user's
// granted accounts under the repository's preference; without a grant it
// keeps the platform credentials (organization connections never serve
// runs), and another member's run never spends the user's accounts. The
// scope comes from the host's own credential, never from the caller.
func TestProviderPoolRunsUseTheInitiatingUsersGrantedAccounts(t *testing.T) {
	f := newPoolFixture(t)
	ctx := context.Background()
	var orgID, orgRepo int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO organizations(name, lower_name) VALUES('acme','acme') RETURNING id`).Scan(&orgID))
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO repositories(org_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, orgID).Scan(&orgRepo))
	require.NoError(t, f.svc.SetRepositoryPreference(ctx, orgRepo, services.ProviderConnectionPreferenceUserFirst))
	connection := f.connect(t, "alice-claude")
	scopes := services.NewProviderPoolScopes(f.q, f.pool, poolCodec{})

	aliceRun := startRun(t, f, orgRepo, f.alice.ID)
	bobRun := startRun(t, f, orgRepo, 2)
	pickFor := func(credential string) services.ProviderPoolPick {
		t.Helper()
		userID, repositoryID, ok := scopes.Scope(ctx, credential)
		require.True(t, ok)
		require.Equal(t, orgRepo, repositoryID)
		pick, err := f.svc.PickForModelCall(ctx, userID, repositoryID, "claude", nil)
		require.NoError(t, err)
		return pick
	}

	require.False(t, pickFor(aliceRun).Pooled, "no grant: platform credentials")
	_, err := f.svc.AddGrant(ctx, f.alice, connection, services.ProviderConnectionGrantInput{RepositoryID: &orgRepo})
	require.NoError(t, err)
	pick := pickFor(aliceRun)
	require.NotNil(t, pick.Connection)
	require.Equal(t, connection, pick.Connection.ConnectionID, "user_first: the initiating user's granted account")
	require.False(t, pickFor(bobRun).Pooled, "another member's run never spends alice's account")
	_, _, ok := scopes.Scope(ctx, aliceRun[:len(aliceRun)-4]+"AAAA")
	require.False(t, ok, "a forged host credential has no pool")

	require.NoError(t, f.svc.SetRepositoryPreference(ctx, orgRepo, services.ProviderConnectionPreferenceOrgOnly))
	require.False(t, pickFor(aliceRun).Pooled, "org_only keeps the platform credentials")
}
