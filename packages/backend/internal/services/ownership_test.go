package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type ownershipTestQueries struct{}

func (ownershipTestQueries) ListSubmittedLandingApprovals(context.Context, int64) ([]db.LandingRequestReview, error) {
	return []db.LandingRequestReview{{ReviewerID: pgtype.Int8{Int64: 7, Valid: true}, ChangeRevisions: json.RawMessage(`{"c1":{"commit_id":"k1","seq":4}}`)}}, nil
}
func (ownershipTestQueries) GetUserByID(context.Context, int64) (db.User, error) {
	return db.User{ID: 7, Username: "reviewer", UserType: "user"}, nil
}
func (ownershipTestQueries) ListTeamNamesForUserByRepository(context.Context, db.ListTeamNamesForUserByRepositoryParams) ([]string, error) {
	return []string{"data"}, nil
}

type ownershipTestRepoHost struct{ files map[string]string }

func (r ownershipTestRepoHost) GetFileAtChange(_ context.Context, _, _, _, filePath string) (repohost.FileContent, error) {
	if content, ok := r.files[filePath]; ok {
		return repohost.FileContent{Path: filePath, Content: content}, nil
	}
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
}

type landingGateTestQueries struct{ *mockLandingQuerier }

func (q landingGateTestQueries) UpsertChange(context.Context, db.UpsertChangeParams) (db.Change, error) {
	return db.Change{RevisionSeq: 4}, nil
}
func (q landingGateTestQueries) CountCurrentApprovedLandingRequestReviews(context.Context, db.CountCurrentApprovedLandingRequestReviewsParams) (int64, error) {
	return 0, nil
}
func (q landingGateTestQueries) ListSubmittedLandingApprovals(context.Context, int64) ([]db.LandingRequestReview, error) {
	return nil, nil
}
func (q landingGateTestQueries) ListTeamNamesForUserByRepository(context.Context, db.ListTeamNamesForUserByRepositoryParams) ([]string, error) {
	return nil, nil
}

type landingGateTestRepoHost struct{ *mockLandingRepoHostClient }

func (r landingGateTestRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetChangeID: "target"}}, "", nil
}

func TestResolveChangeOwnershipAddsSatisfactionAndMissingApprovals(t *testing.T) {
	t.Parallel()
	rh := ownershipTestRepoHost{files: map[string]string{
		"OWNERS":      "alice\nreviewers: sage # upstream-of //src\n",
		"data/OWNERS": "team:data\nagents: deny\n",
	}}
	result, err := resolveChangeOwnership(context.Background(), ownershipTestQueries{}, rh, 11, "acme", "demo", "target", []OwnershipTouchedFile{
		{Path: "data/schema.graphql", ChangeID: "c1", CommitID: "k1", RevisionSeq: 4},
		{Path: "cmd/main.go", ChangeID: "c1", CommitID: "k1", RevisionSeq: 4},
	}, 22)
	require.NoError(t, err)
	require.Len(t, result.TouchedPaths, 2)
	assert.Equal(t, "reviewer", result.TouchedPaths[0].SatisfiedBy.Login)
	assert.Equal(t, int64(4), result.TouchedPaths[0].SatisfiedBy.Seq)
	assert.Equal(t, "deny", result.TouchedPaths[0].AgentPolicy)
	assert.Nil(t, result.TouchedPaths[1].SatisfiedBy)
	assert.Equal(t, []MissingOwnershipApproval{{Path: "cmd/main.go", Candidates: []string{"alice"}}}, result.MissingApprovals)
	assert.Equal(t, []string{"alice", "team:data"}, result.RequiredApprovers)
	assert.Equal(t, []string{"sage"}, result.SuggestedReviewers)
}

func TestResolveChangeOwnershipRejectsStaleApproval(t *testing.T) {
	t.Parallel()
	rh := ownershipTestRepoHost{files: map[string]string{"OWNERS": "team:data\n"}}
	result, err := resolveChangeOwnership(context.Background(), ownershipTestQueries{}, rh, 11, "acme", "demo", "target", []OwnershipTouchedFile{
		{Path: "schema.sql", ChangeID: "c1", CommitID: "new", RevisionSeq: 5},
	}, 22)
	require.NoError(t, err)
	assert.Nil(t, result.TouchedPaths[0].SatisfiedBy)
	assert.Equal(t, []MissingOwnershipApproval{{Path: "schema.sql", Candidates: []string{"team:data"}}}, result.MissingApprovals)
}

func TestLandingOwnershipGateBlocksAgentOnDeniedPath(t *testing.T) {
	t.Parallel()
	q := landingGateTestQueries{mockLandingQuerier: &mockLandingQuerier{}}
	rh := landingGateTestRepoHost{mockLandingRepoHostClient: &mockLandingRepoHostClient{
		getFileAtChangeFn: func(_ context.Context, _, _, _, filePath string) (repohost.FileContent, error) {
			if filePath == "OWNERS" {
				return repohost.FileContent{Content: "team:security\nagents: deny\n"}, nil
			}
			return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
		},
	}}
	svc := NewLandingService(q, rh)
	err := svc.enforceOwnershipGate(context.Background(), db.Repository{ID: 11, Name: "demo"}, "acme", "demo", db.GetLandingRequestWithChangeIDsByNumberRow{
		ID: 22, TargetBookmark: "main", AgentAuthored: true,
	}, []OwnershipTouchedFile{{Path: "secrets/key.txt", ChangeID: "c1", CommitID: "k1", RevisionSeq: 4}}, true)
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok)
	assert.Equal(t, pkgerrors.CodeLandingBlocked, apiErr.Code)
	details := apiErr.Details.(LandingBlockedDetails)
	assert.Equal(t, []LandingOwnerBlock{{Kind: "agent_policy", Path: "secrets/key.txt", Candidates: []string{"team:security"}}}, details.BlockedBy)
}

func TestLandingRevisionSnapshotReadsFilesAtPinnedCommit(t *testing.T) {
	rh := &mockLandingRepoHostClient{
		getChangeFn: func(_ context.Context, _, _, changeID string) (repohost.Change, error) {
			return repohost.Change{ChangeID: changeID, CommitID: "immutable-reviewed-commit"}, nil
		},
		getChangeFilesFn: func(_ context.Context, _, _, revision string) ([]repohost.ChangeFile, error) {
			require.Equal(t, "immutable-reviewed-commit", revision, "a rewrite between calls must not change the reviewed file list")
			return []repohost.ChangeFile{{Path: "protected.txt"}}, nil
		},
	}
	svc := NewLandingService(&mockLandingQuerier{}, rh)
	touched, revisions, err := svc.syncLandingChangeRevisions(t.Context(), 1, "owner", "repo", []string{"stable-change"})
	require.NoError(t, err)
	require.Equal(t, "immutable-reviewed-commit", touched[0].CommitID)
	pins, err := landingRevisionPins(revisions)
	require.NoError(t, err)
	require.Equal(t, "immutable-reviewed-commit", pins["stable-change"])
}

func (r landingGateTestRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := r.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
