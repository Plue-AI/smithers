package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A mirrored repository whose hooks list is empty sends no landing, comment or
// status event to github-sync, so nothing on the mirror reaches GitHub
// (plue#706). The reconcile gives each advertised mirror exactly one hook.
func TestSyncedRepos_EnsureSyncWebhooksFeedsEveryMirrorOnce(t *testing.T) {
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	row, err := synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	synced.SetPushAccess(pushAccessFunc(func(context.Context, int64, string, string) error { return nil }))
	store.recordReadyImport(fakeReadyImport{userID: 7, githubOwner: "octo", githubRepo: "widget", repoOwner: "alice", repoName: "widget"})
	require.NoError(t, synced.BindMirror(context.Background(), 7, row, "alice", "widget"))
	// Metadata-only enrollment names no Smithers repository to hook.
	_, err = synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "zulu", Repo: "meta", MetadataOnly: true})
	require.NoError(t, err)

	var hooks []db.Webhook
	querier := webhookQuerier()
	querier.ensureWebhookAtURLFn = func(_ context.Context, arg db.CreateWebhookParams) (db.Webhook, bool, error) {
		for _, hook := range hooks {
			if hook.RepositoryID == arg.RepositoryID && hook.Url == arg.Url {
				return hook, false, nil
			}
		}
		hook := db.Webhook{ID: int64(len(hooks) + 1), RepositoryID: arg.RepositoryID, Url: arg.Url, Secret: arg.Secret, Events: arg.Events, IsActive: arg.IsActive}
		hooks = append(hooks, hook)
		return hook, true, nil
	}
	hookService := NewWebhookService(querier, &mockWebhookSecretCodec{encryptFn: func(plaintext string) (string, error) {
		return "sealed:" + plaintext, nil
	}})
	synced.SetSyncWebhook(func(ctx context.Context, owner, repo string) (bool, error) {
		return hookService.EnsureSystemWebhook(ctx, owner, repo, "https://github-sync.example/webhooks/smithers", "sync-secret", GitHubSyncWebhookEvents)
	})

	created, err := synced.EnsureSyncWebhooks(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, created)
	created, err = synced.EnsureSyncWebhooks(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 0, created, "a second reconcile must not duplicate the hook")

	require.Len(t, hooks, 1)
	hook := hooks[0]
	assert.Equal(t, "https://github-sync.example/webhooks/smithers", hook.Url)
	assert.Equal(t, "sealed:sync-secret", hook.Secret, "the secret is stored encrypted")
	assert.True(t, hook.IsActive)

	// The dispatcher enqueues each event github-sync turns into a GitHub write.
	deliveries := &hookDispatchStore{hooks: hooks}
	dispatcher := webhooks.NewDispatcher(deliveries)
	events := []webhooks.EventType{
		webhooks.EventTypeLandingRequest, webhooks.EventTypeLandingRequestReview,
		webhooks.EventTypeLandingRequestComment, webhooks.EventTypeStatus,
		webhooks.EventTypeIssues, webhooks.EventTypeIssueComment, webhooks.EventTypePush,
	}
	for _, event := range events {
		require.NoError(t, dispatcher.DispatchEvent(context.Background(), hook.RepositoryID, event, map[string]string{}))
	}
	assert.Len(t, deliveries.created, len(events))
}

type hookDispatchStore struct {
	hooks   []db.Webhook
	created []db.CreateWebhookDeliveryParams
}

func (s *hookDispatchStore) ListActiveWebhooksByRepo(context.Context, int64) ([]db.Webhook, error) {
	return s.hooks, nil
}

func (s *hookDispatchStore) ListActiveWebhooksByOrg(context.Context, int64) ([]db.Webhook, error) {
	return nil, nil
}

func (s *hookDispatchStore) CreateWebhookDelivery(_ context.Context, arg db.CreateWebhookDeliveryParams) (db.WebhookDelivery, error) {
	s.created = append(s.created, arg)
	return db.WebhookDelivery{}, nil
}

// The delivery queue disables a hook after repeated failures, and a secret
// rotation leaves it signing with the old key; either would stop github-sync
// for good, so the reconcile restores the platform's hook.
func TestWebhookService_EnsureSystemWebhookRestoresADriftedHook(t *testing.T) {
	const url = "https://github-sync.example/webhooks/smithers"
	for name, existing := range map[string]db.Webhook{
		"disabled after failures": {ID: 9, Url: url, Secret: "sync-secret", Events: GitHubSyncWebhookEvents, IsActive: false},
		"secret rotated":          {ID: 9, Url: url, Secret: "old-secret", Events: GitHubSyncWebhookEvents, IsActive: true},
		"events narrowed":         {ID: 9, Url: url, Secret: "sync-secret", Events: []string{"push"}, IsActive: true},
	} {
		t.Run(name, func(t *testing.T) {
			querier := webhookQuerier()
			querier.ensureWebhookAtURLFn = func(context.Context, db.CreateWebhookParams) (db.Webhook, bool, error) {
				return existing, false, nil
			}
			var restored *db.UpdateRepoWebhookByOwnerAndRepoParams
			querier.updateRepoWebhookByOwnerAndRepoFn = func(_ context.Context, arg db.UpdateRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
				restored = &arg
				return db.Webhook{}, nil
			}
			created, err := newWebhookService(t, querier).EnsureSystemWebhook(context.Background(), "alice", "demo", url, "sync-secret", GitHubSyncWebhookEvents)
			require.NoError(t, err)
			assert.False(t, created)
			require.NotNil(t, restored)
			assert.Equal(t, db.UpdateRepoWebhookByOwnerAndRepoParams{
				Url: url, Secret: "sync-secret", Events: GitHubSyncWebhookEvents, IsActive: true,
				WebhookID: 9, Owner: "alice", Repo: "demo",
			}, *restored)
		})
	}
}

func TestWebhookService_EnsureSystemWebhookLeavesAHealthyHookAlone(t *testing.T) {
	querier := webhookQuerier()
	querier.ensureWebhookAtURLFn = func(context.Context, db.CreateWebhookParams) (db.Webhook, bool, error) {
		return db.Webhook{ID: 9, Url: "https://github-sync.example/webhooks/smithers", Secret: "sync-secret", Events: GitHubSyncWebhookEvents, IsActive: true}, false, nil
	}
	querier.updateRepoWebhookByOwnerAndRepoFn = func(context.Context, db.UpdateRepoWebhookByOwnerAndRepoParams) (db.Webhook, error) {
		t.Fatal("a healthy hook must not be rewritten")
		return db.Webhook{}, nil
	}
	created, err := newWebhookService(t, querier).EnsureSystemWebhook(context.Background(), "alice", "demo",
		"https://github-sync.example/webhooks/smithers", "sync-secret", GitHubSyncWebhookEvents)
	require.NoError(t, err)
	assert.False(t, created)
}

func TestSyncedRepos_EnsureSyncWebhooksContinuesPastAFailure(t *testing.T) {
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	synced.SetPushAccess(pushAccessFunc(func(context.Context, int64, string, string) error { return nil }))
	for _, name := range []string{"one", "two"} {
		row, err := synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: name})
		require.NoError(t, err)
		store.recordReadyImport(fakeReadyImport{userID: 7, githubOwner: "octo", githubRepo: name, repoOwner: "alice", repoName: name})
		require.NoError(t, synced.BindMirror(context.Background(), 7, row, "alice", name))
	}
	var seen []string
	synced.SetSyncWebhook(func(_ context.Context, owner, repo string) (bool, error) {
		seen = append(seen, owner+"/"+repo)
		if repo == "one" {
			return false, assert.AnError
		}
		return true, nil
	})
	created, err := synced.EnsureSyncWebhooks(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, created)
	assert.ElementsMatch(t, []string{"alice/one", "alice/two"}, seen)
}

// A newly bound mirror is hooked at bind time, not up to one reconcile later,
// so its first landing or status reaches github-sync.
func TestSyncedRepos_BindMirrorHooksTheMirror(t *testing.T) {
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	synced.SetPushAccess(pushAccessFunc(func(context.Context, int64, string, string) error { return nil }))
	var hooked []string
	synced.SetSyncWebhook(func(_ context.Context, owner, repo string) (bool, error) {
		hooked = append(hooked, owner+"/"+repo)
		return true, nil
	})
	row, err := synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	store.recordReadyImport(fakeReadyImport{userID: 7, githubOwner: "octo", githubRepo: "widget", repoOwner: "alice", repoName: "widget"})
	require.NoError(t, synced.BindMirror(context.Background(), 7, row, "alice", "widget"))
	assert.Equal(t, []string{"alice/widget"}, hooked)
}
