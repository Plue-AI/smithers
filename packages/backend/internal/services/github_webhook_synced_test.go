package services

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newSyncedWebhookService(t *testing.T) (*GitHubWebhookService, *GitHubSyncedRepoService, *fakeSyncedRepoStore) {
	t.Helper()
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "webhook-secret", WithGitHubWebhookSyncedRepos(synced))
	return svc, synced, store
}

func deliverGitHubWebhook(t *testing.T, svc *GitHubWebhookService, event string, payload string) {
	t.Helper()
	require.NoError(t, svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		event,
		signGitHubWebhookForTest([]byte(payload), "webhook-secret"),
		[]byte(payload),
	))
}

func TestGitHubWebhook_InstallationEnrollsReposIntoSyncRegistry(t *testing.T) {
	svc, _, store := newSyncedWebhookService(t)

	deliverGitHubWebhook(t, svc, "installation", `{
		"action":"created",
		"installation":{"id":42,"repository_selection":"selected","account":{"login":"octo","type":"User"}},
		"repositories":[{"id":1,"name":"widget","full_name":"octo/widget","owner":{"login":"octo"}}]
	}`)

	row, err := store.GetGitHubSyncedRepo(context.Background(), githubSyncedRepoParams("octo", "widget"))
	require.NoError(t, err)
	assert.Equal(t, GitHubSyncedRepoEnrolledViaInstallation, row.EnrolledVia)
	assert.True(t, row.SyncRefs, "ref mirroring is on by default for enrolled repos")
	assert.Equal(t, int64(42), row.InstallationID.Int64)

	// installation_repositories: added grants access to another repo.
	deliverGitHubWebhook(t, svc, "installation_repositories", `{
		"action":"added",
		"installation":{"id":42,"repository_selection":"selected","account":{"login":"octo","type":"User"}},
		"repositories_added":[{"id":2,"name":"gadget","full_name":"octo/gadget","owner":{"login":"octo"}}]
	}`)
	_, err = store.GetGitHubSyncedRepo(context.Background(), githubSyncedRepoParams("octo", "gadget"))
	require.NoError(t, err)

	// A removal must NOT enroll anything.
	deliverGitHubWebhook(t, svc, "installation_repositories", `{
		"action":"removed",
		"installation":{"id":42,"account":{"login":"octo","type":"User"}},
		"repositories_removed":[{"id":3,"name":"gone","full_name":"octo/gone","owner":{"login":"octo"}}]
	}`)
	_, err = store.GetGitHubSyncedRepo(context.Background(), githubSyncedRepoParams("octo", "gone"))
	require.Error(t, err)
}

func TestGitHubWebhook_IssueAndCommentEventsRefreshTheStore(t *testing.T) {
	svc, synced, store := newSyncedWebhookService(t)
	row, err := synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))

	deliverGitHubWebhook(t, svc, "issues", `{
		"action":"opened",
		"repository":{"id":1,"name":"widget","full_name":"octo/widget","owner":{"login":"octo"}},
		"issue":{"id":10,"number":4,"state":"open","title":"Bug","updated_at":"2026-08-01T00:00:00Z"}
	}`)
	deliverGitHubWebhook(t, svc, "pull_request", `{
		"action":"opened",
		"repository":{"id":1,"name":"widget","full_name":"octo/widget","owner":{"login":"octo"}},
		"pull_request":{"id":11,"number":9,"state":"open","title":"Fix","updated_at":"2026-08-01T00:00:00Z"}
	}`)
	deliverGitHubWebhook(t, svc, "issue_comment", `{
		"action":"created",
		"repository":{"id":1,"name":"widget","full_name":"octo/widget","owner":{"login":"octo"}},
		"issue":{"id":10,"number":4},
		"comment":{"id":77,"body":"me too","updated_at":"2026-08-01T00:00:00Z"}
	}`)

	assert.Len(t, store.issues, 2, "an issue and a pull request are stored as distinct rows")
	assert.Len(t, store.comments, 1)
	assert.True(t, store.repoByID(row.ID).LastWebhookAt.Valid, "deliveries heartbeat freshness")

	// A push carries no metadata but still proves deliveries are arriving.
	before := store.repoByID(row.ID).LastWebhookAt.Time
	deliverGitHubWebhook(t, svc, "push", `{
		"repository":{"id":1,"name":"widget","full_name":"octo/widget","owner":{"login":"octo"}}
	}`)
	assert.False(t, store.repoByID(row.ID).LastWebhookAt.Time.Before(before))
}

func TestGitHubWebhook_StoreFailureDoesNotRejectTheDelivery(t *testing.T) {
	// A nil registry is the pre-mirror wiring: deliveries must still be accepted.
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "webhook-secret")
	deliverGitHubWebhook(t, svc, "issues", `{
		"action":"opened",
		"repository":{"id":1,"name":"widget","full_name":"octo/widget","owner":{"login":"octo"}},
		"issue":{"id":10,"number":4,"state":"open"}
	}`)
}
