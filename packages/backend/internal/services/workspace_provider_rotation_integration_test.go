package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// The workspace keeps its boot profile while the account pool changes. Its
// coding host must therefore be free to select a model from the current pool.
func TestWorkspaceProviderPoolRotationDoesNotPersistBootAccountModel(t *testing.T) {
	strict := os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1"
	node, err := exec.LookPath("node")
	if err != nil {
		if strict {
			t.Fatalf("node required for coding-host integration: %v", err)
		}
		t.Skipf("node unavailable: %v", err)
	}
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	for _, dependency := range []string{"effect", filepath.Join("@smthrs", "agent")} {
		path := filepath.Join(root, "flows", "node_modules", dependency)
		if _, err := os.Stat(path); err != nil {
			if strict {
				t.Fatalf("coding-host dependency %s required: %v", path, err)
			}
			t.Skipf("coding-host dependency %s unavailable: %v", path, err)
		}
	}
	ctx := context.Background()
	pool := newProductTestPool(t)
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "rotation-owner", LowerUsername: "rotation-owner", DisplayName: "Rotation Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "rotation", LowerName: "rotation", DefaultBookmark: "main"})
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("workspace-provider-rotation-integration-key")
	require.NoError(t, err)
	connections := NewProviderConnectionService(q, codec, nil, WithSubscriptionConnectionsEnabled(true))
	workspace := sampleDBWorkspace(uuid.NewString())
	workspace.UserID, workspace.RepositoryID = owner.ID, repo.ID
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != ProviderPoolPath+"/routes" {
			http.NotFound(w, r)
			return
		}
		routes := []string{}
		for provider, route := range map[string]string{ProviderConnectionProviderCodex: "chatgpt", ProviderConnectionProviderClaude: "anthropic"} {
			has, err := connections.HasPool(r.Context(), owner.ID, repo.ID, provider)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if has {
				routes = append(routes, route)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"routes": routes})
	}))
	t.Cleanup(server.Close)
	service := NewWorkspaceService(q, WithWorkspaceGitBaseURL(server.URL), WithWorkspaceProviderConnections(connections), WithWorkspaceProviderBootstrap(seatsFor(t, "anthropic"), ""))
	startHost := func(profile, model, route string) {
		t.Helper()
		command := exec.CommandContext(t.Context(), "/bin/sh", "-c", profile+"\nexec \"$1\" --experimental-strip-types \"$2\"", "host", node,
			filepath.Join(root, "flows/test/fixtures/workspace-provider-seat.ts"))
		command.Dir = root
		command.Env = []string{"HOME=" + t.TempDir(), "PATH=" + os.Getenv("PATH")}
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		var resolved struct{ Model, URL string }
		require.NoError(t, json.Unmarshal(output, &resolved), string(output))
		require.Equal(t, model, resolved.Model)
		require.Equal(t, server.URL+route, resolved.URL)
	}

	connect := func(provider string) string {
		t.Helper()
		input := ConnectProviderInput{Provider: provider, Label: provider + "-rotation"}
		if provider == ProviderConnectionProviderCodex {
			input.AccessToken, input.RefreshToken, input.AccountID = "codex-access", "codex-refresh", "codex-account"
		} else {
			input.AccessToken = "sk-ant-oat01-rotation"
		}
		account, err := connections.ConnectForUser(ctx, &owner, input)
		require.NoError(t, err)
		return account.ID
	}
	checkCurrent := func(provider, absent string) {
		t.Helper()
		present, err := connections.HasPool(ctx, owner.ID, repo.ID, provider)
		require.NoError(t, err)
		require.True(t, present, provider)
		missing, err := connections.HasPool(ctx, owner.ID, repo.ID, absent)
		require.NoError(t, err)
		require.False(t, missing, absent)
		pick, err := connections.PickForModelCall(ctx, owner.ID, repo.ID, provider, nil)
		require.NoError(t, err)
		require.True(t, pick.Pooled)
		require.NotNil(t, pick.Connection)
		require.Equal(t, provider, pick.Connection.Provider)
	}

	codex := connect(ProviderConnectionProviderCodex)
	binding, err := service.resolveWorkspaceProviderBindings(ctx, workspace)
	require.NoError(t, err)
	require.Empty(t, bootstrapModel(binding.environment), "boot must not persist a pool-derived Codex pin")
	require.Equal(t, "anthropic:claude-sonnet-4-6", bootstrapFallbackModel(binding.environment))
	profile, err := renderWorkspaceAgentEnvironmentProfile(binding.environment.Env, binding.environment.ProxyBound)
	require.NoError(t, err)
	require.NotContains(t, profile, "SMITHERS_CODING_IMPLEMENT_MODEL")
	require.Contains(t, profile, "SMITHERS_CODING_FALLBACK_MODEL")
	require.Contains(t, profile, ProviderPoolURLEnvName)
	checkCurrent(ProviderConnectionProviderCodex, ProviderConnectionProviderClaude)
	startHost(profile, "openai:gpt-6-luna", ProviderPoolPath+"/chatgpt/codex/responses")

	require.NoError(t, connections.Revoke(ctx, &owner, codex))
	claude := connect(ProviderConnectionProviderClaude)
	checkCurrent(ProviderConnectionProviderClaude, ProviderConnectionProviderCodex)
	startHost(profile, "anthropic:claude-sonnet-4-6", ProviderPoolPath+"/anthropic/v1/messages")
	require.NoError(t, connections.Revoke(ctx, &owner, claude))
	codex = connect(ProviderConnectionProviderCodex)
	checkCurrent(ProviderConnectionProviderCodex, ProviderConnectionProviderClaude)
	startHost(profile, "openai:gpt-6-luna", ProviderPoolPath+"/chatgpt/codex/responses")
	require.NoError(t, connections.Revoke(ctx, &owner, codex))
	for _, provider := range []string{ProviderConnectionProviderCodex, ProviderConnectionProviderClaude} {
		has, err := connections.HasPool(ctx, owner.ID, repo.ID, provider)
		require.NoError(t, err)
		require.False(t, has, provider)
	}
	startHost(profile, "anthropic:claude-sonnet-4-6", "/model-proxy/anthropic/v1/messages")
	require.Empty(t, bootstrapModel(binding.environment), "the original workspace profile remains unpinned through both rotations")
}
