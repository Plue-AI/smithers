package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestInstalledPullFactsCommitAndFailureRetainPreviousRead(t *testing.T) {
	for _, failure := range []string{"transport", "conversation-transport", "invalid", "unsolicited-304", "head-moved", "revoked"} {
		t.Run(failure, func(t *testing.T) {
			s, pool, row := newFetchedFixture(t)
			allowFetched(s)
			head := strings.Repeat("a", 40)
			detail := strings.Replace(fetchedPullDetail, "head-1", head, 1)
			active := false
			pages := 0
			s.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) GitHubSyncedRepoConditionalFetcher {
				return func(ctx context.Context, resource string, query url.Values, etag string) (GitHubSyncedRepoConditionalPage, error) {
					if resource == "pulls/7" {
						return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(detail)}, nil
					}
					require.True(t, gitHubPullFactResource(resource))
					require.Empty(t, etag)
					require.Equal(t, "100", query.Get("per_page"))
					body := `[]`
					if strings.HasSuffix(resource, "check-runs") {
						if query.Get("page") == "1" {
							body = `{"check_runs":[` + strings.TrimSuffix(strings.Repeat(`{"id":1},`, 100), ",") + `]}`
						} else {
							body = `{"check_runs":[]}`
						}
						pages++
					}
					if active && failure == "conversation-transport" && resource == "issues/7/comments" {
						return GitHubSyncedRepoConditionalPage{}, errors.New("offline conversation snapshot")
					}
					if active && strings.HasSuffix(resource, "reviews") {
						switch failure {
						case "transport":
							return GitHubSyncedRepoConditionalPage{}, errors.New("offline")
						case "invalid":
							body = `{}`
						case "unsolicited-304":
							return GitHubSyncedRepoConditionalPage{NotModified: true}, nil
						case "head-moved":
							_, err := pool.Exec(ctx, `UPDATE github_synced_issues SET payload=jsonb_set(payload,'{head,sha}',to_jsonb($1::text)) WHERE resource='pulls'`, strings.Repeat("b", 40))
							require.NoError(t, err)
						case "revoked":
							s.install.authorize = func(context.Context, db.GithubSyncedRepo) error { return errors.New("revoked") }
						}
					}
					return GitHubSyncedRepoConditionalPage{Body: json.RawMessage(body)}, nil
				}
			})
			require.NoError(t, s.pollInstallPull(t.Context(), row, 7))
			require.NoError(t, s.pollInstallPullFacts(t.Context(), row, 7))
			require.Equal(t, 2, pages, "all check pages must be read")
			var before string
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT related_facts->'reviews' FROM github_synced_issues WHERE resource='pulls'`).Scan(&before))
			require.Contains(t, before, head)
			require.NotNil(t, s.syncStreamObservation(row, "reviews/7", "reviews").LastSuccessAt)
			active = true
			require.Error(t, s.pollInstallPullFacts(t.Context(), row, 7))
			var after string
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT related_facts->'reviews' FROM github_synced_issues WHERE resource='pulls'`).Scan(&after))
			require.Equal(t, before, after, "a failed, stale or revoked read cannot replace committed facts")
		})
	}
}

func TestPullFactResourcePaths(t *testing.T) {
	for _, resource := range []string{"pulls/7/reviews", "pulls/7/comments", "issues/7/comments", "commits/" + strings.Repeat("a", 40) + "/check-runs", "commits/" + strings.Repeat("b", 64) + "/statuses"} {
		require.True(t, gitHubPullFactResource(resource), resource)
	}
	for _, resource := range []string{"pulls/0/reviews", "pulls/01/reviews", "pulls/../reviews", "commits/main/check-runs", "commits/" + strings.Repeat("x", 40) + "/statuses", "pulls/7/merge", "issues/01/comments", "issues/7/reviews"} {
		require.False(t, gitHubPullFactResource(resource), resource)
	}
}

func TestPullFactBudgetStreams(t *testing.T) {
	require.Equal(t, "conversation-comments", gitHubBudgetStream("/repos/o/r/issues/7/comments"))
	require.Equal(t, "reviews", gitHubBudgetStream("/repos/o/r/pulls/7/reviews"))
	require.Equal(t, "reviews", gitHubBudgetStream("/repos/o/r/pulls/7/comments"))
	require.Equal(t, "checks", gitHubBudgetStream("/repos/o/r/commits/sha/check-runs"))
	require.Equal(t, "pulls", gitHubBudgetStream("/repos/o/r/pulls/7"))
}

func TestPullFactReaderRejectsUnknownKind(t *testing.T) {
	s := &GitHubSyncedRepoService{}
	require.Error(t, s.ReadInstallPullFacts(t.Context(), db.GithubSyncedRepo{}, 7, "head", "unknown"))
}
