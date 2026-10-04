package services

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestNormalizeGitHubReviewText(t *testing.T) {
	line, original := int64(9), int64(3)
	author := gitHubActor{ID: 12, Login: "member"}
	review := gitHubReviewInput{ID: 42, User: author, Body: "Fix these"}
	for _, id := range []int64{3, 1, 2} {
		review.Comments = append(review.Comments, gitHubReviewLine{ID: id, User: author, Path: "a.go", Line: &line, CommitID: "head", Body: "fix"})
	}
	text, err := normalizeGitHubReviewText(review, 99)
	require.NoError(t, err)
	require.Equal(t, "Fix these\n\na.go:9 @ head\nfix\n\na.go:9 @ head\nfix\n\na.go:9 @ head\nfix", text)
	require.Equal(t, int64(3), review.Comments[0].ID, "normalization must not mutate fetched data")
	review.Comments = []gitHubReviewLine{{ID: 1, User: author, Path: "old.go", OriginalLine: &original, OriginalCommitID: "original", Body: "old"}}
	text, err = normalizeGitHubReviewText(review, 99)
	require.NoError(t, err)
	require.Equal(t, "Fix these\n\nold.go:3 @ original\nold", text)
	review.Comments = append(review.Comments, review.Comments[0], gitHubReviewLine{ID: 2, User: gitHubActor{ID: 33}}, gitHubReviewLine{ID: 3, User: gitHubActor{ID: 99}})
	repeated, err := normalizeGitHubReviewText(review, 99)
	require.NoError(t, err)
	require.Equal(t, text, repeated)
	text, err = normalizeGitHubReviewText(review, 12)
	require.NoError(t, err)
	require.Empty(t, text)
}

func TestNormalizeGitHubReviewTextRefusesIncompleteFetchedData(t *testing.T) {
	author := gitHubActor{ID: 12, Login: "member"}
	for _, review := range []gitHubReviewInput{
		{}, {ID: 1}, {ID: 1, User: gitHubActor{ID: 12}},
		{ID: 1, User: author, Comments: []gitHubReviewLine{{User: author}}},
		{ID: 1, User: author, Comments: []gitHubReviewLine{{ID: 1, User: author, Path: "a.go"}}},
	} {
		text, err := normalizeGitHubReviewText(review, 0)
		require.Error(t, err)
		require.Empty(t, text)
	}
}

func TestNormalizeGitHubStandaloneCommentText(t *testing.T) {
	line := int64(4)
	comment := gitHubReviewLine{ID: 18, User: gitHubActor{ID: 12, Login: "member"}, Body: "Use the helper", Path: "src/retry.ts", OriginalLine: &line, OriginalCommitID: "original"}
	for _, tc := range []struct {
		name string
		line bool
		app  int64
		want string
	}{
		{"conversation", false, 99, "Use the helper"},
		{"line", true, 99, "src/retry.ts:4 @ original\nUse the helper"},
		{"app conversation", false, 12, ""},
		{"app line", true, 12, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text, err := normalizeGitHubCommentText(comment, tc.line, tc.app)
			require.NoError(t, err)
			require.Equal(t, tc.want, text)
		})
	}
	comment.OriginalCommitID = ""
	text, err := normalizeGitHubCommentText(comment, true, 99)
	require.Error(t, err)
	require.Empty(t, text)
	comment.ID = 0
	text, err = normalizeGitHubCommentText(comment, false, 99)
	require.Error(t, err)
	require.Empty(t, text)
}
