package services

import (
	"context"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	smitherscrypto "github.com/smithersai/smithers/packages/backend/internal/pkg/crypto"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallSetupAdmissionRecoveryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := &InstallSetupService{Pool: pool, Jobs: store}
	ctx := t.Context()
	require.NoError(t, service.Initialize(ctx))
	var initialized int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key LIKE 'setup.step.%'`).Scan(&initialized))
	require.Equal(t, 7, initialized)
	body := json.RawMessage(`{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`)
	_, err = service.Admit(ctx, "models", "before-address", json.RawMessage(`{}`))
	require.Error(t, err)
	receipt, err := service.Admit(ctx, "address", "address-1", body)
	require.NoError(t, err)
	replay, err := service.Admit(ctx, "address", "address-1", body)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, replay.OperationID)
	_, err = service.Admit(ctx, "address", "address-1", json.RawMessage(`{"bind":"0.0.0.0:4000","origins":["http://mini.local:4000"]}`))
	require.Error(t, err)
	_, err = service.Admit(ctx, "address", "address-2", body)
	require.Error(t, err)
	// Admission survives replacing the service, before a worker starts.
	service = &InstallSetupService{Pool: pool, Jobs: store}
	require.NoError(t, service.Initialize(ctx))
	steps, err := service.Steps(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{"address", "app_manifest", "sign_in", "repository", "models", "source", "machine"}, []string{steps[0].ID, steps[1].ID, steps[2].ID, steps[3].ID, steps[4].ID, steps[5].ID, steps[6].ID})
	require.Equal(t, InstallRunning, steps[0].Status)
	require.Equal(t, receipt.OperationID, steps[0].OperationID)
	oldClaim, err := store.ClaimForOperations(ctx, "crashed-worker", time.Minute, []string{"install.setup.address"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_set(value,'{expires_at}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE key='setup.step.address'`)
	require.NoError(t, err)
	_, err = service.Admit(ctx, "address", "address-live-lease", body)
	require.Error(t, err)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, receipt.OperationID)
	require.NoError(t, err)
	recovered, err := service.Admit(ctx, "address", "address-recovery", body)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, recovered.OperationID)
	require.ErrorIs(t, store.Complete(ctx, oldClaim, json.RawMessage(`{"stale":true}`)), jobs.ErrClaimLost)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "setup-test", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, Operations: []string{"install.setup.address"}}, service.Handle)
	}()
	require.Eventually(t, func() bool {
		step, err := service.readStep(ctx, db.New(pool), "address")
		return err == nil && step.Status == InstallReady
	}, 5*time.Second, 10*time.Millisecond)
	cancel()
	require.NoError(t, <-done)
	operation, err := store.Get(ctx, jobs.Scope{TenantID: "install", PrincipalID: "owner"}, receipt.OperationID)
	require.NoError(t, err)
	require.Equal(t, jobs.StateCompleted, operation.State)
	setting, err := db.New(pool).GetInstallSetting(ctx, "bind")
	require.NoError(t, err)
	require.JSONEq(t, `"127.0.0.1:4000"`, string(setting.Value))
	replay, err = service.Admit(ctx, "address", "address-1", body)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, replay.OperationID)
	status, err := service.Status(ctx)
	require.NoError(t, err)
	encoded, err := json.Marshal(status)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "operation_id")
	require.NotContains(t, string(encoded), "\"source\":")
	require.NotContains(t, string(encoded), "\"parallel\":")
}

func TestInstallSetupModelFlagsBeforeConfirmationPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "model-owner", LowerUsername: "model-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_defaults(user_id,model) VALUES($1,'{"protocol":"openai-chat","modelId":"gpt-5","credential":"OPENAI_API_KEY"}')`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_credentials(user_id,name,value_encrypted,origin) VALUES($1,'OPENAI_API_KEY','sealed-key-fixture',''),($1,'AI_GATEWAY_API_KEY','sealed-key-fixture','')`, owner.ID)
	require.NoError(t, err)
	service := &InstallSetupService{Pool: pool}
	status, err := service.Status(ctx)
	require.NoError(t, err)
	models := status["models"].([]map[string]string)
	require.Equal(t, []map[string]string{{"role": "fast", "provider": "Cerebras", "key": "none"}, {"role": "coding", "provider": "OpenAI", "key": "saved"}, {"role": "jev", "provider": "AI Gateway", "key": "saved"}}, models)
	raw, err := json.Marshal(status)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "sealed-key-fixture")
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_credentials(user_id,name,value_encrypted,origin) VALUES($1,'CEREBRAS_API_KEY','sealed-key-fixture','')`, owner.ID)
	require.NoError(t, err)
	status, err = service.Status(ctx)
	require.NoError(t, err)
	models = status["models"].([]map[string]string)
	require.Equal(t, "Cerebras", models[0]["provider"])
}

func TestInstallSetupExpiredProjectionPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	now := time.Now().UTC()
	service := &InstallSetupService{Pool: pool, Now: func() time.Time { return now }}
	for _, id := range InstallStepIDs {
		raw, err := json.Marshal(InstallStep{Status: InstallRunning, ExpiresAt: now.Add(time.Minute)})
		require.NoError(t, err)
		require.NoError(t, db.New(pool).UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "setup.step." + id, Value: raw}))
	}
	steps, err := service.Steps(t.Context())
	require.NoError(t, err)
	for _, step := range steps {
		require.Equal(t, InstallRunning, step.Status, step.ID)
	}
	now = now.Add(time.Minute)
	steps, err = service.Steps(t.Context())
	require.NoError(t, err)
	for _, step := range steps {
		require.Equal(t, InstallPending, step.Status, step.ID)
	}
	// Projection does not change the persisted operation or its recovery fence.
	for _, id := range InstallStepIDs {
		step, err := service.readStep(t.Context(), db.New(pool), id)
		require.NoError(t, err)
		require.Equal(t, InstallRunning, step.Status)
	}
}

func TestInstallStatusRepositoriesPostgres(t *testing.T) {
	for _, installed := range []bool{true, false} {
		t.Run(map[bool]string{true: "installed", false: "not-installed"}[installed], func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx := t.Context()
			q := db.New(pool)
			fixture, credentials := manifestFixture(t)
			fixture.Close()
			installations := []githubfake.Installation{}
			if installed {
				installations = append(installations, githubfake.Installation{ID: 91, Repositories: []githubfake.Repository{{ID: 100, FullName: "acme/app"}}})
			}
			fake, err := githubfake.New(githubfake.Config{AppID: credentials.ID, Slug: credentials.Slug, OwnerLogin: credentials.OwnerLogin, OwnerKind: credentials.OwnerKind, PrivateKeyPEM: credentials.PEM, ClientID: credentials.ClientID, ClientSecret: credentials.ClientSecret, ConversionCode: "manifest-code", Installations: installations})
			require.NoError(t, err)
			defer fake.Close()
			t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", fake.URL)
			response, err := http.Post(fake.URL+"/app-manifests/manifest-code/conversions", "application/json", strings.NewReader("{}"))
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, 201, response.StatusCode)
			response, err = http.PostForm(fake.URL+"/login/oauth/access_token", url.Values{"code": {"owner-code"}, "client_id": {credentials.ClientID}, "client_secret": {credentials.ClientSecret}, "redirect_uri": {"http://localhost:4000/api/auth/github/callback"}})
			require.NoError(t, err)
			response.Body.Close()
			require.Equal(t, 200, response.StatusCode)
			codec, err := webhook.NewSecretCodec("install-key")
			require.NoError(t, err)
			app := NewGitHubAppCredentialStore(pool, codec)
			require.NoError(t, app.Save(ctx, credentials))
			owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "acme", LowerUsername: "acme"})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
			require.NoError(t, err)
			token, err := smitherscrypto.Encrypt(smitherscrypto.DeriveKey("session-key"), []byte("ghu_githubfake_owner"))
			require.NoError(t, err)
			_, err = q.CreateOAuthAccount(ctx, db.CreateOAuthAccountParams{UserID: owner.ID, Provider: "github", ProviderUserID: "7", AccessTokenEncrypted: token, ProfileData: json.RawMessage(`{}`)})
			require.NoError(t, err)
			access := NewGitHubUserReposService(q, NewAuthService(q, config.AuthConfig{SessionSecret: "session-key"}, nil, nil), WithGitHubUserReposCredentialStore(app), WithGitHubUserReposHTTPClient(fake.Client()))
			service := &InstallSetupService{Pool: pool, RepositoryAccess: access}
			status, err := service.Status(ctx)
			require.NoError(t, err)
			github := status["github"].(map[string]any)
			require.Equal(t, installed, github["app_installed"])
			if installed {
				require.Equal(t, []string{"acme/app"}, status["repositories"])
			} else {
				require.Empty(t, status["repositories"])
				step := status["steps"].([]map[string]any)[3]
				require.Equal(t, "blocked", step["state"])
				require.Equal(t, map[string]string{"line": "Install the GitHub App", "fix_url": "https://github.com/apps/smithers-integration/installations/new"}, step["blocked"])
			}
		})
	}
}
func TestInstallStatusNamesProvidersBeforeKeysPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	status, err := (&InstallSetupService{Pool: pool}).Status(t.Context())
	require.NoError(t, err)
	require.Equal(t, []map[string]string{{"role": "fast", "provider": "Cerebras", "key": "none"}, {"role": "coding", "provider": "OpenAI", "key": "none"}, {"role": "jev", "provider": "AI Gateway", "key": "none"}}, status["models"])
}
