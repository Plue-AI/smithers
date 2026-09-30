package compose

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestConfigureGitHubSyncWebhooksOptionalAndRejectsInvalidPairs(t *testing.T) {
	require.NoError(t, configureGitHubSyncWebhooks(config.WebhookConfig{}, nil, nil))
	for _, cfg := range []config.WebhookConfig{
		{GitHubSyncSecret: "private-signing-key"},
		{GitHubSyncURL: "https://sync.example/hook"},
		{GitHubSyncURL: "http://sync.example/hook", GitHubSyncSecret: "private-signing-key"},
		{GitHubSyncURL: "https://", GitHubSyncSecret: "private-signing-key"},
		{GitHubSyncURL: "https://user:password@sync.example/hook", GitHubSyncSecret: "private-signing-key"},
		{GitHubSyncURL: "https://sync.example/hook#fragment", GitHubSyncSecret: "private-signing-key"},
	} {
		err := configureGitHubSyncWebhooks(cfg, nil, nil)
		require.Error(t, err)
		require.NotContains(t, err.Error(), "private-signing-key")
		require.NotContains(t, err.Error(), "password")
	}
}

// Exercise the same composition hook and actual worker over a migrated product
// database. A missing mirror retries; metadata-only rows are never given hooks.
func TestComposedGitHubSyncWebhookReconcilerRealDatabase(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "sync-owner", LowerUsername: "sync-owner", DisplayName: "Sync"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "ready", LowerName: "ready", DefaultBookmark: "main"})
	require.NoError(t, err)
	synced := services.NewGitHubSyncedRepoService(q)
	for _, name := range []string{"ready", "recover", "metadata"} {
		row, err := synced.EnrollGitHubRepo(ctx, services.EnrollGitHubRepoInput{Owner: "github-owner", Repo: name, MetadataOnly: true})
		require.NoError(t, err)
		if name != "metadata" {
			_, err = pool.Exec(ctx, "UPDATE github_synced_repos SET mirror_owner=$1, mirror_repo=$2 WHERE id=$3", user.Username, name, row.ID)
			require.NoError(t, err)
		}
	}
	codec, err := webhook.NewSecretCodec("composed-sync-webhook-secret-codec")
	require.NoError(t, err)
	hooks := services.NewWebhookService(q, codec)
	require.NoError(t, configureGitHubSyncWebhooks(config.WebhookConfig{
		GitHubSyncURL: "https://sync.example/webhooks/smithers", GitHubSyncSecret: "signing-secret",
	}, synced, hooks))
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); synced.StartSyncWebhookReconciler(workerCtx, 20*time.Millisecond) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("sync webhook reconciler did not stop")
		}
	})
	count := func() int {
		var value int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM webhooks").Scan(&value))
		return value
	}
	require.Eventually(t, func() bool { return count() == 1 }, 3*time.Second, 10*time.Millisecond)
	readyHooks, err := q.ListActiveWebhooksByRepo(ctx, repo.ID)
	require.NoError(t, err)
	require.Len(t, readyHooks, 1)
	require.NotEqual(t, "signing-secret", readyHooks[0].Secret)
	secret, err := codec.DecryptString(readyHooks[0].Secret)
	require.NoError(t, err)
	require.Equal(t, "signing-secret", secret)
	require.Equal(t, services.GitHubSyncWebhookEvents, readyHooks[0].Events)
	_, err = q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "recover", LowerName: "recover", DefaultBookmark: "main"})
	require.NoError(t, err)
	require.Eventually(t, func() bool { return count() == 2 }, 3*time.Second, 10*time.Millisecond)
	_, err = pool.Exec(ctx, "UPDATE webhooks SET is_active=false WHERE id=$1", readyHooks[0].ID)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		rows, err := q.ListActiveWebhooksByRepo(ctx, repo.ID)
		return err == nil && len(rows) == 1
	}, 3*time.Second, 10*time.Millisecond)
	require.Equal(t, 2, count(), "reconciliation and recovery never duplicate hooks")
}
