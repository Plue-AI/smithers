package modelhost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestOwnerGatewayUsesSealedRoleAndRefusesFallbackPostgres(t *testing.T) {
	pool, url := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	owner, err := db.New(pool).CreateUser(ctx, db.CreateUserParams{Username: "gateway-owner", LowerUsername: "gateway-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	codec, err := webhook.NewSecretCodec("gateway-install-fixture-key")
	require.NoError(t, err)
	secret, err := codec.EncryptString("sealed-gateway-test-key")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_credentials(user_id,name,value_encrypted,origin) VALUES($1,'AI_GATEWAY_API_KEY',$2,'')`, owner.ID, []byte(secret))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('agent:jev','{"protocol":"openai-chat","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}')`)
	require.NoError(t, err)
	t.Setenv("AI_GATEWAY_API_KEY", "hostile-env-key")
	t.Setenv("SMITHERS_PLATFORM_MODEL_KEYS_FILE", "/hostile/file")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer sealed-gateway-test-key", r.Header.Get("Authorization"))
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"answers":{"command1":{"type":"choice","choice":"help"}}}`))
	}))
	defer server.Close()
	resolver, err := NewOwnerSecretResolver(func() string { return url }, func() string { return "gateway-install-fixture-key" })
	require.NoError(t, err)
	recommender, err := NewJevRecommender(OwnerGatewayKeys{Resolver: resolver}, server.URL, server.Client())
	require.NoError(t, err)
	_, err = recommender.Recommend(context.Background(), ports.RecommendationRequest{Commands: []ports.RecommendationCommand{{Name: "help", Summary: "Help"}}})
	require.NoError(t, err)
	require.Equal(t, int32(1), calls.Load())
	resolver.Close() // Reopen durable sealed access after a host restart.
	key, err := (OwnerGatewayKeys{Resolver: resolver}).PlatformModelKey(ctx, "vercel")
	require.NoError(t, err)
	require.Equal(t, "sealed-gateway-test-key", key)
	_, err = pool.Exec(ctx, `DELETE FROM owner_model_credentials WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = (OwnerGatewayKeys{Resolver: resolver}).PlatformModelKey(ctx, "vercel")
	require.Error(t, err)
	require.NotContains(t, err.Error(), "hostile-env-key")
	require.False(t, strings.Contains(err.Error(), "sealed-gateway-test-key"))
	_, err = (OwnerGatewayKeys{Resolver: resolver}).PlatformModelKey(ctx, "openai")
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	resolver.Close()
}
