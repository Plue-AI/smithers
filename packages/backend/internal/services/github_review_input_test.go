package services

import (
	"github.com/stretchr/testify/require"
	"testing"
	"time"
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

func TestGitHubReviewDecisionAcrossTodoStates(t *testing.T) {
	// Literal contract expectations: queued/failed/paused work receives input
	// only when its ordinary start, Retry or Resume path admits it. A review
	// never answers a Needs you wait or reopens a settled TODO.
	for _, tc := range []struct{ state, input, event string }{
		{"queued", "hold", ""},
		{"starting", "hold", ""},
		{"working", "steer", ""},
		{"needs_you", "steer", ""},
		{"in_review", "steer", "working"},
		{"failed", "hold", ""},
		{"paused", "hold", ""},
		{"merged", "", ""},
		{"dropped", "", ""},
	} {
		for _, kind := range []string{"review", "review_comment", "conversation_comment"} {
			t.Run(tc.state+"/"+kind, func(t *testing.T) {
				fact := mythicalGitHubFact{Kind: kind, Review: &gitHubReviewFact{
					State: "CHANGES_REQUESTED", Change: "created", ActiveMember: true,
				}}
				got := decideGitHubFact(fact, mythicalGitHubFactItem{State: tc.state}, time.Time{})
				require.Equal(t, mythicalGitHubFactDecision{Event: tc.event,
					Review: &gitHubReviewEffect{Activity: "upsert", Input: tc.input, PRReview: kind == "review"}}, got)
				fact.Review.State = "COMMENTED"
				require.Equal(t, got, decideGitHubFact(fact, mythicalGitHubFactItem{State: tc.state}, time.Time{}))
			})
		}
	}
}

func TestGitHubReviewDecisionNeverBorrowsAuthority(t *testing.T) {
	for _, state := range []string{"queued", "starting", "working", "needs_you", "in_review", "failed", "paused", "merged", "dropped"} {
		for _, kind := range []string{"review", "review_comment", "conversation_comment"} {
			t.Run(state+"/"+kind, func(t *testing.T) {
				fact := mythicalGitHubFact{Kind: kind, Review: &gitHubReviewFact{State: "CHANGES_REQUESTED", Change: "created"}}
				want := mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "upsert", PRReview: kind == "review"}}
				require.Equal(t, want, decideGitHubFact(fact, mythicalGitHubFactItem{State: state}, time.Time{}), "outsiders, suspended and removed members are record-only")
				fact.Review.OwnApp, fact.Review.ActiveMember = true, true
				require.Equal(t, mythicalGitHubFactDecision{Noop: "own_app"}, decideGitHubFact(fact, mythicalGitHubFactItem{State: state}, time.Time{}), "App identity wins even if its login resolves to a member")
			})
		}
		for _, reviewState := range []string{"APPROVED", "DISMISSED", "PENDING", "", "unrecognized"} {
			fact := mythicalGitHubFact{Kind: "review", Review: &gitHubReviewFact{State: reviewState, Change: "created", ActiveMember: true}}
			require.Equal(t, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "upsert", PRReview: true}}, decideGitHubFact(fact, mythicalGitHubFactItem{State: state}, time.Time{}), "GitHub approval is not permission to run or merge")
		}
	}
}

func TestGitHubReviewDecisionLifecycle(t *testing.T) {
	for _, tc := range []struct {
		name, state string
		input       gitHubReviewFact
		want        mythicalGitHubFactDecision
	}{
		{"duplicate", "in_review", gitHubReviewFact{Change: "created", ActiveMember: true, Duplicate: true}, mythicalGitHubFactDecision{Noop: "duplicate"}},
		{"stale delete", "working", gitHubReviewFact{Change: "deleted", Held: true, Stale: true}, mythicalGitHubFactDecision{Noop: "stale"}},
		{"edit held", "failed", gitHubReviewFact{Change: "edited", ActiveMember: true, Held: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "upsert", Input: "hold"}}},
		{"edit unconsumed", "working", gitHubReviewFact{Change: "edited", ActiveMember: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "upsert", Input: "steer"}}},
		{"edit consumed", "in_review", gitHubReviewFact{Change: "edited", ActiveMember: true, Consumed: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "upsert"}}},
		{"delete held", "failed", gitHubReviewFact{Change: "deleted", Held: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "hide", Input: "withdraw"}}},
		{"delete consumed", "working", gitHubReviewFact{Change: "deleted", Held: true, Consumed: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "hide"}}},
		{"delete delivered", "working", gitHubReviewFact{Change: "deleted"}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Activity: "hide"}}},
		{"member revoked before retry", "working", gitHubReviewFact{Change: "deliver-held", Held: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Input: "withdraw"}}},
		{"retry held", "working", gitHubReviewFact{Change: "deliver-held", Held: true, ActiveMember: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Input: "steer"}}},
		{"still paused", "paused", gitHubReviewFact{Change: "deliver-held", Held: true, ActiveMember: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Input: "hold"}}},
		{"dropped before delivery", "dropped", gitHubReviewFact{Change: "deliver-held", Held: true, ActiveMember: true}, mythicalGitHubFactDecision{Review: &gitHubReviewEffect{Input: "withdraw"}}},
		{"consumed delivery", "working", gitHubReviewFact{Change: "deliver-held", Held: true, Consumed: true, ActiveMember: true}, mythicalGitHubFactDecision{Noop: "input_not_held"}},
		{"missing held receipt", "working", gitHubReviewFact{Change: "deliver-held", ActiveMember: true}, mythicalGitHubFactDecision{Noop: "input_not_held"}},
		{"unknown change", "working", gitHubReviewFact{Change: "unknown", ActiveMember: true}, mythicalGitHubFactDecision{Noop: "unknown_review_change"}},
		{"unknown todo state", "unknown", gitHubReviewFact{Change: "created", ActiveMember: true}, mythicalGitHubFactDecision{Noop: "unknown_todo_state", Review: &gitHubReviewEffect{Activity: "upsert"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := decideGitHubFact(mythicalGitHubFact{Kind: "conversation_comment", Review: &tc.input}, mythicalGitHubFactItem{State: tc.state}, time.Time{})
			require.Equal(t, tc.want, got)
		})
	}
	for _, kind := range []string{"review", "review_comment", "conversation_comment"} {
		require.Equal(t, mythicalGitHubFactDecision{Noop: "review_facts_missing"}, decideGitHubFact(mythicalGitHubFact{Kind: kind}, mythicalGitHubFactItem{State: "working"}, time.Time{}))
	}
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
