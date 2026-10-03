package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestGitHubAppCallbackFixesForOriginsAddedAfterCreation(t *testing.T) {
	for _, kind := range []string{"user", "org"} {
		credentials := githubAppTestCredentials(t)
		credentials.OwnerKind = kind
		store, q := githubAppTestStore(t, credentials)
		original := []string{"http://localhost:4000/api/auth/github/callback", "https://existing.example/api/auth/github/callback"}
		require.NoError(t, store.SaveCallbackURLs(context.Background(), original))
		fixes, err := store.CallbackFixes(context.Background(), []string{"https://existing.example", "https://new.example"})
		require.NoError(t, err)
		settingsURL := "https://github.com/settings/apps/smithers-test"
		if kind == "org" {
			settingsURL = "https://github.com/organizations/smithersai/settings/apps/smithers-test"
		}
		require.Equal(t, []GitHubAppCallbackFix{{SettingsURL: settingsURL, AddURL: "https://new.example/api/auth/github/callback"}}, fixes)
		urls, err := store.CallbackURLs(context.Background())
		require.NoError(t, err)
		require.Equal(t, original, urls, "origin changes must never claim GitHub registered a new callback")
		require.Equal(t, "github.callback_urls", q.savedSetting.Key)
		require.False(t, q.savedSetting.Sealed)
		fixes, err = store.CallbackFixes(context.Background(), []string{"http://localhost:4000", "https://existing.example"})
		require.NoError(t, err)
		require.Empty(t, fixes)
		require.NotNil(t, fixes, "JSON must encode no fixes as an empty array")
	}
}

func TestGitHubAppRecordedCallbackURLsUpdatesAndStrictFailures(t *testing.T) {
	store, q := githubAppTestStore(t, githubAppTestCredentials(t))
	q.settingError = pgx.ErrNoRows
	_, err := store.CallbackURLs(context.Background())
	require.Error(t, err, "missing recorded callbacks must never mean registered")
	q.settingError = context.Canceled
	_, err = store.CallbackURLs(context.Background())
	require.ErrorIs(t, err, context.Canceled)
	require.ErrorIs(t, store.SaveCallbackURLs(context.Background(), []string{"http://localhost:4000/api/auth/github/callback"}), context.Canceled)
	q.settingError = nil
	for _, value := range []string{"null", `{}`, `[1]`, `["https://host/path"]`, `["ftp://host"]`, `["https://user@host"]`, `[] true`} {
		q.setting.Value = json.RawMessage(value)
		_, err := store.CallbackURLs(context.Background())
		require.Error(t, err, "invalid callback snapshot %s must fail closed", value)
	}
	q.setting.Value = json.RawMessage(`["http://localhost:4000/api/auth/github/callback"]`)
	q.setting.Sealed = true
	_, err = store.CallbackURLs(context.Background())
	require.Error(t, err, "callback snapshot is public JSON, never sealed")
	q.setting.Sealed = false
	for _, value := range []string{"https://host/path", "https://host?query", "https://host#fragment", "ftp://host", "https://user@host"} {
		q.savedSetting = nil
		require.Error(t, store.SaveCallbackURLs(context.Background(), []string{value}))
		require.Nil(t, q.savedSetting)
	}
	require.NoError(t, store.SaveCallbackURLs(context.Background(), []string{"http://localhost:4000/api/auth/github/callback"}))
	q.setting.Value = json.RawMessage(`["http://localhost:4000/api/auth/github/callback","https://confirmed.example/api/auth/github/callback"]`)
	urls, err := store.CallbackURLs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"http://localhost:4000/api/auth/github/callback", "https://confirmed.example/api/auth/github/callback"}, urls, "reads must reload a newly confirmed GitHub snapshot")
	q.err = errors.New("App database unavailable")
	_, err = store.CallbackFixes(context.Background(), []string{"https://new.example"})
	require.ErrorContains(t, err, "App database unavailable")
}

func TestGitHubAppCallbackSnapshotBoundariesAndUnavailableStore(t *testing.T) {
	store, q := githubAppTestStore(t, githubAppTestCredentials(t))
	for _, urls := range [][]string{nil, make([]string, 11), {"https://"}, {"http://[bad"}} {
		require.Error(t, store.SaveCallbackURLs(context.Background(), urls))
	}
	require.NoError(t, store.SaveCallbackURLs(context.Background(), []string{"http://localhost:4000/api/auth/github/callback", "http://localhost:4000/api/auth/github/callback"}))
	urls, err := store.CallbackURLs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"http://localhost:4000/api/auth/github/callback"}, urls)
	_, err = store.CallbackFixes(context.Background(), []string{"https://host/path"})
	require.Error(t, err)
	q.settingError = context.DeadlineExceeded
	_, err = store.CallbackFixes(context.Background(), []string{"http://localhost:4000"})
	require.ErrorIs(t, err, context.DeadlineExceeded)
	var unavailable *GitHubAppCredentialStore
	require.Error(t, unavailable.SaveCallbackURLs(context.Background(), []string{"http://localhost:4000/api/auth/github/callback"}))
	_, err = unavailable.CallbackURLs(context.Background())
	require.Error(t, err)
}
