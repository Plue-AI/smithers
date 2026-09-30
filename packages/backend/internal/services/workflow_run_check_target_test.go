package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A Cloud repository that mirrors a GitHub repository under another name
// (smithers-canary/plue-release-ci mirrors smithersai/plue) runs CI on the
// mirror's commits, which are the GitHub commits. Its check runs belong on the
// GitHub source, where branch protection and release gates read them; posting
// them under the mirror's own name reaches no repository.

// sourcedRunQuerier gives the run querier a recorded GitHub source.
type sourcedRunQuerier struct {
	*terminalRunQuerier
	sources []db.ListRepositoryGitHubSourcesRow
}

func (q *sourcedRunQuerier) ListRepositoryGitHubSources(context.Context, int64) ([]db.ListRepositoryGitHubSourcesRow, error) {
	return q.sources, nil
}

type checkTargetCall struct{ owner, repo string }

func newSourcedCheckRunService(t *testing.T, sources []db.ListRepositoryGitHubSourcesRow, mirrorDestination string) (*workflowRunService, *sourcedRunQuerier, *mockWorkflowRunCheckRunService, *[]checkTargetCall) {
	t.Helper()
	q := &sourcedRunQuerier{
		terminalRunQuerier: &terminalRunQuerier{
			mockWorkflowRunQuerier: &mockWorkflowRunQuerier{
				getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
					return db.Repository{ID: id, Name: "plue-release-ci", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 1, Valid: true}, MirrorDestination: mirrorDestination}, nil
				},
				getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
					return db.User{ID: id, Username: "smithers-canary"}, nil
				},
				listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
					return []db.WorkflowDefinition{makeWorkflowDef(1, 100, "github-ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)}, nil
				},
			},
			definitionName: "github-ci",
		},
		sources: sources,
	}
	checks := &mockWorkflowRunCheckRunService{
		postFn: func(context.Context, int64, string, string, GitHubCheckRunInput) (GitHubCheckRunResult, error) {
			return GitHubCheckRunResult{ID: 77}, nil
		},
	}
	resolved := &[]checkTargetCall{}
	svc := NewWorkflowRunService(q,
		WithWorkflowRunGitHubCheckRunService(checks),
		WithWorkflowRunGitHubInstallationResolver(&mockRunnerInstallationResolver{
			resolveFn: func(_ context.Context, _, _ int64, owner, repo string) (int64, error) {
				*resolved = append(*resolved, checkTargetCall{owner, repo})
				return 5, nil
			},
		}),
	).(*workflowRunService)
	return svc, q, checks, resolved
}

func TestWorkflowRunCheckRun_MirrorPostsOnItsGitHubSource(t *testing.T) {
	for _, tc := range []struct {
		name        string
		sources     []db.ListRepositoryGitHubSourcesRow
		destination string
	}{
		{name: "recorded source", sources: []db.ListRepositoryGitHubSourcesRow{{GithubOwner: "smithersai", GithubRepo: "plue"}}},
		{name: "mirror destination", destination: "https://github.com/smithersai/plue.git"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, q, checks, resolved := newSourcedCheckRunService(t, tc.sources, tc.destination)
			ctx := context.Background()

			results, err := svc.DispatchForEvent(ctx, DispatchForEventInput{
				RepositoryID: 100,
				Event:        TriggerEvent{Type: "push", Ref: "main", CommitSHA: "cafebabe"},
			})
			require.NoError(t, err)
			require.Len(t, results, 1)
			require.Len(t, checks.postCalls, 1)
			assert.Equal(t, "smithersai", checks.postCalls[0].owner)
			assert.Equal(t, "plue", checks.postCalls[0].repo)
			assert.Equal(t, "cafebabe", checks.postCalls[0].input.HeadSHA)
			assert.Equal(t, "smithers / github-ci", checks.postCalls[0].input.Name)
			require.Len(t, q.updateCheckRunCalls, 1)

			svc.PublishWorkflowRunTerminal(ctx, sandboxTerminalRun("failure"))
			require.Len(t, checks.updateCalls, 1)
			assert.Equal(t, "smithersai", checks.updateCalls[0].owner)
			assert.Equal(t, "plue", checks.updateCalls[0].repo)
			assert.Equal(t, "failure", checks.updateCalls[0].update.Conclusion)

			for _, call := range *resolved {
				assert.Equal(t, checkTargetCall{"smithersai", "plue"}, call, "the installation is resolved for the GitHub source")
			}
		})
	}
}

// Without one GitHub source the check run keeps the repository's own name.
func TestWorkflowRunCheckRun_UnsourcedRepositoryKeepsItsName(t *testing.T) {
	for _, sources := range [][]db.ListRepositoryGitHubSourcesRow{nil, {{GithubOwner: "a", GithubRepo: "b"}, {GithubOwner: "c", GithubRepo: "d"}}} {
		svc, _, checks, _ := newSourcedCheckRunService(t, sources, "")
		svc.PublishWorkflowRunTerminal(context.Background(), sandboxTerminalRun("success"))
		require.Len(t, checks.updateCalls, 1)
		assert.Equal(t, "smithers-canary", checks.updateCalls[0].owner)
		assert.Equal(t, "plue-release-ci", checks.updateCalls[0].repo)
	}
}

// GitHub branch protection and Smithers' own landing checks count neutral as
// passing, so a run that did not succeed must never conclude neutral.
func TestWorkflowRunCheckRun_ConclusionFailsClosed(t *testing.T) {
	for status, conclusion := range map[string]string{
		"success":   "success",
		"failure":   "failure",
		"error":     "failure",
		"cancelled": "cancelled",
	} {
		t.Run(status, func(t *testing.T) {
			publisher, surfaces := newTerminalPublisher(t)
			publisher.PublishWorkflowRunTerminal(context.Background(), sandboxTerminalRun(status))
			require.Len(t, surfaces.checkRuns.updateCalls, 1)
			assert.Equal(t, conclusion, surfaces.checkRuns.updateCalls[0].update.Conclusion)
		})
	}
	assert.Equal(t, "failure", workflowRunStatusToCheckRunConclusion("unknown"))
}
