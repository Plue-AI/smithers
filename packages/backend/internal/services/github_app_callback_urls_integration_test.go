package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

func TestGitHubAppCallbackRegistrationSnapshotPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	codec, err := webhook.NewSecretCodec("callback-snapshot-install-key")
	require.NoError(t, err)
	store := NewGitHubAppCredentialStore(pool, codec)
	require.NoError(t, store.Save(ctx, githubAppTestCredentials(t)))
	original := []string{"http://localhost:4000/api/auth/github/callback", "https://existing.example/api/auth/github/callback"}
	require.NoError(t, store.SaveCallbackURLs(ctx, original))
	setting, err := db.New(pool).GetInstallSetting(ctx, "github.callback_urls")
	require.NoError(t, err)
	require.False(t, setting.Sealed)
	require.False(t, setting.UpdatedBy.Valid, "setup precedes the install owner's account")
	require.False(t, setting.UpdatedAt.IsZero())
	fresh := NewGitHubAppCredentialStore(pool, codec)
	urls, err := fresh.CallbackURLs(ctx)
	require.NoError(t, err)
	require.Equal(t, original, urls)
	fixes, err := fresh.CallbackFixes(ctx, []string{"https://existing.example", "https://new.example"})
	require.NoError(t, err)
	require.Equal(t, []GitHubAppCallbackFix{{SettingsURL: "https://github.com/organizations/smithersai/settings/apps/smithers-test", AddURL: "https://new.example/api/auth/github/callback"}}, fixes)
	unchanged, err := db.New(pool).GetInstallSetting(ctx, "github.callback_urls")
	require.NoError(t, err)
	require.Equal(t, setting.Value, unchanged.Value, "reconciling configured origins must preserve GitHub's recorded callbacks")
	confirmed := append(append([]string(nil), original...), "https://new.example/api/auth/github/callback")
	require.NoError(t, store.SaveCallbackURLs(ctx, confirmed))
	urls, err = fresh.CallbackURLs(ctx)
	require.NoError(t, err)
	require.Equal(t, confirmed, urls, "an explicit confirmed registration update reloads without restart")
	fixes, err = fresh.CallbackFixes(ctx, []string{"http://localhost:4000", "https://existing.example", "https://new.example"})
	require.NoError(t, err)
	require.Empty(t, fixes)
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value=$1::jsonb WHERE key='github.callback_urls'`, json.RawMessage(`{"invalid":"snapshot"}`))
	require.NoError(t, err)
	_, err = fresh.CallbackURLs(ctx)
	require.Error(t, err, "malformed persisted registration must fail closed")
	t.Log("real PostgreSQL preserves creation callbacks, reports exact new-origin fix, reloads explicit registration updates, and rejects invalid snapshots")
}
