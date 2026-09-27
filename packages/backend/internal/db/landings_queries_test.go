package db

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateLandingRequest_AssignsRepoScopedNumber(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-author")
	repoID := mustCreateRepo(t, pool, userID, "landing-repo")

	first, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "first landing",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), first.Number)
	assert.Equal(t, "feature", first.SourceBookmark)

	second, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "second landing",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), second.Number)
	assert.Equal(t, "feature", second.SourceBookmark)

	got, err := q.GetLandingRequestByNumber(context.Background(), GetLandingRequestByNumberParams{
		RepositoryID: repoID,
		Number:       2,
	})
	require.NoError(t, err)
	assert.Equal(t, second.ID, got.ID)
}

func TestLandingRequestTurn_TracksAgentRevisionWithoutOverwritingNewerFeedback(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	userID := mustCreateUser(t, pool, "landing-turn-author")
	repoID := mustCreateRepo(t, pool, userID, "landing-turn-repo")
	sessionID := uuid.NewString()
	_, err := q.CreateAgentSession(ctx, CreateAgentSessionParams{
		ID: sessionID, RepositoryID: repoID, UserID: userID, Title: "landing author", Status: "active",
	})
	require.NoError(t, err)

	landing, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "agent landing", AuthorID: userID,
		TargetBookmark: "main", SourceBookmark: "feature", StackSize: 1,
		AgentAuthored: true, AuthorAgentSessionID: sessionID,
	})
	require.NoError(t, err)
	assert.Equal(t, "reviewer", landing.TurnParty)
	assert.Equal(t, sessionID, landing.TurnActorID)
	assert.Equal(t, "request", landing.TurnReason)
	_, err = q.AddLandingRequestChange(ctx, AddLandingRequestChangeParams{
		LandingRequestID: landing.ID, ChangeID: "turn-change", PositionInStack: 1,
	})
	require.NoError(t, err)
	_, err = q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "turn-change", CommitID: "turn-commit", ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	_, err = q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "turn-change", CommitID: "turn-commit", Source: "agent", AgentSessionID: sessionID,
	})
	require.NoError(t, err)
	err = q.UpdateLandingRequestsTurnForRevision(ctx, UpdateLandingRequestsTurnForRevisionParams{
		RepositoryID: repoID, ChangeID: "turn-change", CommitID: "turn-commit",
	})
	require.NoError(t, err)
	landing, err = q.GetLandingRequestByNumber(ctx, GetLandingRequestByNumberParams{RepositoryID: repoID, Number: landing.Number})
	require.NoError(t, err)
	assert.Equal(t, "reviewer", landing.TurnParty)
	assert.Equal(t, sessionID, landing.TurnActorID)
	assert.Equal(t, "revision", landing.TurnReason)

	// Record another revision before the reviewer responds, but delay its turn
	// callback until after the response. The older revision event must not erase
	// the newer author handoff even though its revision id is newer than the last
	// revision already reflected on the landing.
	_, err = q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "turn-change", CommitID: "turn-commit-delayed", Source: "agent", AgentSessionID: sessionID,
	})
	require.NoError(t, err)
	feedback, err := q.UpdateLandingRequestTurn(ctx, UpdateLandingRequestTurnParams{
		ID: landing.ID, TurnParty: "author", TurnActorID: "42", TurnReason: "comment",
	})
	require.NoError(t, err)
	err = q.UpdateLandingRequestsTurnForRevision(ctx, UpdateLandingRequestsTurnForRevisionParams{
		RepositoryID: repoID, ChangeID: "turn-change", CommitID: "turn-commit-delayed",
	})
	require.NoError(t, err)
	landing, err = q.GetLandingRequestByNumber(ctx, GetLandingRequestByNumberParams{RepositoryID: repoID, Number: landing.Number})
	require.NoError(t, err)
	assert.Equal(t, feedback.TurnSince, landing.TurnSince)
	assert.Equal(t, "author", landing.TurnParty)
	assert.Equal(t, "42", landing.TurnActorID)
	assert.Equal(t, "comment", landing.TurnReason)
}

func TestCreateLandingRequest_StoresStackedChangesInOrder(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-stack-author")
	repoID := mustCreateRepo(t, pool, userID, "landing-stack-repo")

	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "stacked",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: lr.ID,
		ChangeID:         "kabc123",
		PositionInStack:  2,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: lr.ID,
		ChangeID:         "kxyz789",
		PositionInStack:  1,
	})
	require.NoError(t, err)

	changes, err := q.ListLandingRequestChanges(context.Background(), ListLandingRequestChangesParams{
		LandingRequestID: lr.ID,
		PageSize:         50,
		PageOffset:       0,
	})
	require.NoError(t, err)
	require.Len(t, changes, 2)
	assert.Equal(t, "kxyz789", changes[0].ChangeID)
	assert.Equal(t, "kabc123", changes[1].ChangeID)
}

func TestGetMergedLandingRequestForChangePinsRevisionAtMergeTime(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()
	userID := mustCreateUser(t, pool, "landing-revert-author")
	repoID := mustCreateRepo(t, pool, userID, "landing-revert-repo")

	_, err := q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "landed-change", CommitID: "landed-commit", ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	_, err = q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "landed-change", CommitID: "landed-commit", Source: "push",
	})
	require.NoError(t, err)
	landing, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "land this", AuthorID: userID, TargetBookmark: "main", StackSize: 1,
	})
	require.NoError(t, err)
	_, err = q.AddLandingRequestChange(ctx, AddLandingRequestChangeParams{
		LandingRequestID: landing.ID, ChangeID: "landed-change", PositionInStack: 1,
	})
	require.NoError(t, err)
	_, err = q.MergeLandingRequest(ctx, landing.ID)
	require.NoError(t, err)

	time.Sleep(5 * time.Millisecond)
	_, err = q.UpsertChange(ctx, UpsertChangeParams{
		RepositoryID: repoID, ChangeID: "landed-change", CommitID: "later-rewrite", ParentChangeIds: []byte(`[]`),
	})
	require.NoError(t, err)
	_, err = q.RecordChangeRevision(ctx, RecordChangeRevisionParams{
		RepositoryID: repoID, ChangeID: "landed-change", CommitID: "later-rewrite", Source: "revert",
	})
	require.NoError(t, err)

	got, err := q.GetMergedLandingRequestForChange(ctx, GetMergedLandingRequestForChangeParams{
		RepositoryID: repoID, ChangeID: "landed-change",
	})
	require.NoError(t, err)
	assert.Equal(t, landing.ID, got.ID)
	assert.Equal(t, "landed-commit", got.LandedRevision)
}

func TestCreateLandingReview(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-review-author")
	reviewerID := mustCreateUser(t, pool, "landing-reviewer")
	repoID := mustCreateRepo(t, pool, userID, "landing-review-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "review me",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	review, err := q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID,
		ReviewerID:       pgtype.Int8{Int64: reviewerID, Valid: true},
		Type:             "approve",
		Body:             "looks good",
	})
	require.NoError(t, err)
	assert.Equal(t, "approve", review.Type)
}

func TestUpdateLandingRequestReviewState_DismissesReview(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "landing-dismiss-author")
	reviewerID := mustCreateUser(t, pool, "landing-dismiss-reviewer")
	repoID := mustCreateRepo(t, pool, authorID, "landing-dismiss-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "dismiss review",
		Body:           "",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	review, err := q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID,
		ReviewerID:       pgtype.Int8{Int64: reviewerID, Valid: true},
		Type:             "approve",
		Body:             "lgtm",
	})
	require.NoError(t, err)
	assert.Equal(t, "submitted", review.State)

	time.Sleep(5 * time.Millisecond)

	updated, err := q.UpdateLandingRequestReviewState(context.Background(), UpdateLandingRequestReviewStateParams{
		ID:    review.ID,
		State: "dismissed",
	})
	require.NoError(t, err)
	assert.Equal(t, review.ID, updated.ID)
	assert.Equal(t, "dismissed", updated.State)
	assert.True(t, updated.UpdatedAt.After(review.UpdatedAt) || updated.UpdatedAt.Equal(review.UpdatedAt))
}

func TestUpdateLandingRequestReviewState_RestoresSubmitted(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "landing-restore-author")
	reviewerID := mustCreateUser(t, pool, "landing-restore-reviewer")
	repoID := mustCreateRepo(t, pool, authorID, "landing-restore-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "restore review",
		Body:           "",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	review, err := q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID,
		ReviewerID:       pgtype.Int8{Int64: reviewerID, Valid: true},
		Type:             "approve",
		Body:             "lgtm",
	})
	require.NoError(t, err)

	_, err = q.UpdateLandingRequestReviewState(context.Background(), UpdateLandingRequestReviewStateParams{
		ID:    review.ID,
		State: "dismissed",
	})
	require.NoError(t, err)

	restored, err := q.UpdateLandingRequestReviewState(context.Background(), UpdateLandingRequestReviewStateParams{
		ID:    review.ID,
		State: "submitted",
	})
	require.NoError(t, err)
	assert.Equal(t, review.ID, restored.ID)
	assert.Equal(t, "submitted", restored.State)
}

func TestUpdateLandingRequestReviewState_DismissedExcludedFromApprovedCount(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "landing-approved-count-author")
	reviewerOneID := mustCreateUser(t, pool, "landing-approved-count-reviewer-one")
	reviewerTwoID := mustCreateUser(t, pool, "landing-approved-count-reviewer-two")
	repoID := mustCreateRepo(t, pool, authorID, "landing-approved-count-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "approved count",
		Body:           "",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	firstReview, err := q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID,
		ReviewerID:       pgtype.Int8{Int64: reviewerOneID, Valid: true},
		Type:             "approve",
		Body:             "lgtm one",
	})
	require.NoError(t, err)

	_, err = q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID,
		ReviewerID:       pgtype.Int8{Int64: reviewerTwoID, Valid: true},
		Type:             "approve",
		Body:             "lgtm two",
	})
	require.NoError(t, err)

	initialCount, err := q.CountApprovedLandingRequestReviews(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), initialCount)

	_, err = q.UpdateLandingRequestReviewState(context.Background(), UpdateLandingRequestReviewStateParams{
		ID:    firstReview.ID,
		State: "dismissed",
	})
	require.NoError(t, err)

	approvedCount, err := q.CountApprovedLandingRequestReviews(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), approvedCount)
}

func TestAgentLGTMDoesNotCountAsHumanApprovalAndIsCommitBound(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "agent-lgtm-author")
	humanID := mustCreateUser(t, pool, "agent-lgtm-human")
	agentID := mustCreateUser(t, pool, "agent-lgtm-agent")
	_, err := pool.Exec(context.Background(), `UPDATE users SET user_type = 'bot' WHERE id = $1`, agentID)
	require.NoError(t, err)
	repoID := mustCreateRepo(t, pool, authorID, "agent-lgtm-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID: repoID, Title: "agent review", AuthorID: authorID,
		TargetBookmark: "main", SourceBookmark: "feature", StackSize: 1,
	})
	require.NoError(t, err)

	_, err = q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID,
		ReviewerID:       pgtype.Int8{Int64: humanID, Valid: true},
		ReviewerKind:     "human",
		Type:             "approve",
		Body:             "human approval",
	})
	require.NoError(t, err)
	agentReview, err := q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
		LandingRequestID: lr.ID,
		ReviewerID:       pgtype.Int8{Int64: agentID, Valid: true},
		ReviewerKind:     "agent",
		Type:             "approve",
		Verdict:          "lgtm",
		ConfidenceBucket: "high",
		Summary:          "Current revision is safe.",
		CommitID:         "commit-current",
		Body:             "Current revision is safe.",
	})
	require.NoError(t, err)
	assert.Equal(t, "agent", agentReview.ReviewerKind)
	assert.Equal(t, "lgtm", agentReview.Verdict.String)

	humanCount, err := q.CountApprovedLandingRequestReviews(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), humanCount)
	currentAgentCount, err := q.CountCurrentAgentLandingReviewCommits(context.Background(), CountCurrentAgentLandingReviewCommitsParams{
		LandingRequestID: lr.ID,
		CommitIds:        []string{"commit-current", "commit-other"},
		ReviewerLogins:   []string{"agent-lgtm-agent"},
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), currentAgentCount)
	// Only a named reviewer agent's LGTM counts.
	unnamedCount, err := q.CountCurrentAgentLandingReviewCommits(context.Background(), CountCurrentAgentLandingReviewCommitsParams{
		LandingRequestID: lr.ID,
		CommitIds:        []string{"commit-current"},
		ReviewerLogins:   []string{"another-agent"},
	})
	require.NoError(t, err)
	assert.Zero(t, unnamedCount)
	staleAgentCount, err := q.CountCurrentAgentLandingReviewCommits(context.Background(), CountCurrentAgentLandingReviewCommitsParams{
		LandingRequestID: lr.ID,
		CommitIds:        []string{"commit-new"},
		ReviewerLogins:   []string{"agent-lgtm-agent"},
	})
	require.NoError(t, err)
	assert.Zero(t, staleAgentCount)
}

func TestCreateLandingComment(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-comment-author")
	repoID := mustCreateRepo(t, pool, userID, "landing-comment-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "comment me",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	comment, err := q.CreateLandingRequestComment(context.Background(), CreateLandingRequestCommentParams{
		LandingRequestID: lr.ID,
		UserID:           pgtype.Int8{Int64: userID, Valid: true},
		Path:             "README.md",
		Line:             10,
		Side:             "right",
		Body:             "nit",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(10), comment.Line)
}

func TestLandingRequestThreadStateTransitions(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "thread-state-author")
	reviewerID := mustCreateUser(t, pool, "thread-state-reviewer")
	repoID := mustCreateRepo(t, pool, authorID, "thread-state-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID: repoID, Title: "thread states", AuthorID: authorID,
		TargetBookmark: "main", SourceBookmark: "feature", StackSize: 1,
	})
	require.NoError(t, err)
	thread, err := q.CreateLandingRequestComment(context.Background(), CreateLandingRequestCommentParams{
		LandingRequestID: lr.ID,
		UserID:           pgtype.Int8{Int64: reviewerID, Valid: true},
		Path:             "README.md",
		Line:             10,
		Side:             "right",
		Body:             "please fix",
	})
	require.NoError(t, err)
	assert.Equal(t, "open", thread.State)
	assert.JSONEq(t, `null`, string(thread.ResolvedInRevision))

	unresolved, err := q.CountUnresolvedLandingRequestThreads(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), unresolved)

	done, err := q.MarkLandingRequestThreadDone(context.Background(), MarkLandingRequestThreadDoneParams{
		DoneBy:             pgtype.Int8{Int64: authorID, Valid: true},
		ResolvedInRevision: []byte(`{"seq":3,"commit_id":"abc123"}`),
		ID:                 thread.ID,
		LandingRequestID:   lr.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, "done", done.State)
	assert.True(t, done.DoneAt.Valid)
	assert.Equal(t, authorID, done.DoneBy.Int64)
	assert.JSONEq(t, `{"seq":3,"commit_id":"abc123"}`, string(done.ResolvedInRevision))

	_, err = q.MarkLandingRequestThreadDone(context.Background(), MarkLandingRequestThreadDoneParams{
		DoneBy: pgtype.Int8{Int64: authorID, Valid: true}, ResolvedInRevision: []byte(`{"seq":3,"commit_id":"abc123"}`),
		ID: thread.ID, LandingRequestID: lr.ID,
	})
	assert.ErrorIs(t, err, pgx.ErrNoRows)

	resolved, err := q.AckLandingRequestThread(context.Background(), AckLandingRequestThreadParams{
		ResolvedBy: pgtype.Int8{Int64: reviewerID, Valid: true}, ID: thread.ID, LandingRequestID: lr.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, "resolved", resolved.State)
	assert.True(t, resolved.ResolvedAt.Valid)
	assert.Equal(t, reviewerID, resolved.ResolvedBy.Int64)
	unresolved, err = q.CountUnresolvedLandingRequestThreads(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Zero(t, unresolved)

	reopened, err := q.ReopenLandingRequestThread(context.Background(), ReopenLandingRequestThreadParams{ID: thread.ID, LandingRequestID: lr.ID})
	require.NoError(t, err)
	assert.Equal(t, "open", reopened.State)
	assert.False(t, reopened.DoneAt.Valid)
	assert.False(t, reopened.DoneBy.Valid)
	assert.False(t, reopened.ResolvedAt.Valid)
	assert.False(t, reopened.ResolvedBy.Valid)
	assert.JSONEq(t, `null`, string(reopened.ResolvedInRevision))
}

func TestListLandingRequestsWithChangeIDsByRepoFiltered_Pagination(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-list-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-list-repo")

	for _, title := range []string{"first", "second", "third"} {
		_, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
			RepositoryID:   repoID,
			Title:          title,
			Body:           "",
			AuthorID:       userID,
			TargetBookmark: "main",
			SourceBookmark: "feature",
			StackSize:      1,
		})
		require.NoError(t, err)
	}

	page, err := q.ListLandingRequestsWithChangeIDsByRepoFiltered(context.Background(), ListLandingRequestsWithChangeIDsByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "",
		PageOffset:   1,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, int64(2), page[0].Number)
}

func TestGetLandingRequestWithChangeIDs_IncludesTargetBookmarkAndStackMetadata(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-change-ids-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-change-ids-repo")

	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "stack query",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: lr.ID,
		ChangeID:         "k-two",
		PositionInStack:  2,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: lr.ID,
		ChangeID:         "k-one",
		PositionInStack:  1,
	})
	require.NoError(t, err)

	_, err = pool.Exec(context.Background(), `UPDATE landing_requests SET stack_size = 2 WHERE id = $1`, lr.ID)
	require.NoError(t, err)

	row, err := q.GetLandingRequestWithChangeIDsByNumber(context.Background(), GetLandingRequestWithChangeIDsByNumberParams{
		RepositoryID: repoID,
		Number:       lr.Number,
	})
	require.NoError(t, err)
	assert.Equal(t, "main", row.TargetBookmark)
	assert.Equal(t, int64(2), row.StackSize)
	assert.Equal(t, []string{"k-one", "k-two"}, row.ChangeIds)
}

func TestListLandingRequestsWithChangeIDsByRepoFiltered_PaginatesAndReturnsOrderedStacks(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-list-change-ids-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-list-change-ids-repo")

	first, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "first",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	second, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "second",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: second.ID,
		ChangeID:         "k-second-2",
		PositionInStack:  2,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: second.ID,
		ChangeID:         "k-second-1",
		PositionInStack:  1,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: first.ID,
		ChangeID:         "k-first-1",
		PositionInStack:  1,
	})
	require.NoError(t, err)

	rows, err := q.ListLandingRequestsWithChangeIDsByRepoFiltered(context.Background(), ListLandingRequestsWithChangeIDsByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "",
		PageOffset:   0,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, second.Number, rows[0].Number)
	assert.Equal(t, []string{"k-second-1", "k-second-2"}, rows[0].ChangeIds)

	nextRows, err := q.ListLandingRequestsWithChangeIDsByRepoFiltered(context.Background(), ListLandingRequestsWithChangeIDsByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "",
		PageOffset:   1,
		PageSize:     1,
	})
	require.NoError(t, err)
	require.Len(t, nextRows, 1)
	assert.Equal(t, first.Number, nextRows[0].Number)
	assert.Equal(t, []string{"k-first-1"}, nextRows[0].ChangeIds)
}

func TestCountLandingRequestsByRepoFiltered_AllState(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-count-user")
	repoOneID := mustCreateRepo(t, pool, userID, "landing-count-repo-one")
	repoTwoID := mustCreateRepo(t, pool, userID, "landing-count-repo-two")

	for _, repoID := range []int64{repoOneID, repoOneID, repoTwoID} {
		_, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
			RepositoryID:   repoID,
			Title:          "count me",
			Body:           "",
			AuthorID:       userID,
			TargetBookmark: "main",
			SourceBookmark: "feature",
			StackSize:      1,
		})
		require.NoError(t, err)
	}

	totalOne, err := q.CountLandingRequestsByRepoFiltered(context.Background(), CountLandingRequestsByRepoFilteredParams{
		RepositoryID: repoOneID,
		State:        "",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(2), totalOne)

	totalTwo, err := q.CountLandingRequestsByRepoFiltered(context.Background(), CountLandingRequestsByRepoFilteredParams{
		RepositoryID: repoTwoID,
		State:        "",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), totalTwo)
}

func TestCountLandingRequestsByRepoFiltered(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-filter-count-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-filter-count-repo")

	first, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "open",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	second, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "closed",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	third, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "merged",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	mustExec(t, pool, `UPDATE landing_requests SET state = 'closed' WHERE id = $1`, second.ID)
	mustExec(t, pool, `UPDATE landing_requests SET state = 'merged' WHERE id = $1`, third.ID)

	openCount, err := q.CountLandingRequestsByRepoFiltered(context.Background(), CountLandingRequestsByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "open",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), openCount)

	closedCount, err := q.CountLandingRequestsByRepoFiltered(context.Background(), CountLandingRequestsByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "closed",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), closedCount)

	allCount, err := q.CountLandingRequestsByRepoFiltered(context.Background(), CountLandingRequestsByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(3), allCount)

	row, err := q.GetLandingRequestByNumber(context.Background(), GetLandingRequestByNumberParams{
		RepositoryID: repoID,
		Number:       first.Number,
	})
	require.NoError(t, err)
	assert.Equal(t, "open", row.State)
}

func TestListLandingRequestsWithChangeIDsByRepoFiltered(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-filter-list-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-filter-list-repo")

	openLR, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "open landing",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	closedLR, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "closed landing",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: openLR.ID,
		ChangeID:         "k-open",
		PositionInStack:  1,
	})
	require.NoError(t, err)
	_, err = q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
		LandingRequestID: closedLR.ID,
		ChangeID:         "k-closed",
		PositionInStack:  1,
	})
	require.NoError(t, err)

	mustExec(t, pool, `UPDATE landing_requests SET state = 'closed' WHERE id = $1`, closedLR.ID)

	rows, err := q.ListLandingRequestsWithChangeIDsByRepoFiltered(context.Background(), ListLandingRequestsWithChangeIDsByRepoFilteredParams{
		RepositoryID: repoID,
		State:        "open",
		PageOffset:   0,
		PageSize:     10,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, openLR.Number, rows[0].Number)
	assert.Equal(t, []string{"k-open"}, rows[0].ChangeIds)
}

func TestUpdateLandingRequest_UpdatesEditableFieldsAndTimestamp(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-update-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-update-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "before",
		Body:           "before body",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	time.Sleep(5 * time.Millisecond)

	updated, err := q.UpdateLandingRequest(context.Background(), UpdateLandingRequestParams{
		ID:             lr.ID,
		Title:          "after",
		Body:           "after body",
		State:          "draft",
		TargetBookmark: "release",
		SourceBookmark: "feature-v2",
		ConflictStatus: "conflicted",
		StackSize:      3,
		ClosedAt:       pgtype.Timestamptz{},
		MergedAt:       pgtype.Timestamptz{},
		ExpectedState:  lr.State,
	})
	require.NoError(t, err)
	assert.Equal(t, "after", updated.Title)
	assert.Equal(t, "after body", updated.Body)
	assert.Equal(t, "draft", updated.State)
	assert.Equal(t, "release", updated.TargetBookmark)
	assert.Equal(t, "feature-v2", updated.SourceBookmark)
	assert.Equal(t, "conflicted", updated.ConflictStatus)
	assert.Equal(t, int64(3), updated.StackSize)
	assert.True(t, updated.UpdatedAt.After(lr.UpdatedAt) || updated.UpdatedAt.Equal(lr.UpdatedAt))
}

func TestUpdateLandingRequest_SetsClosedStateAndTimestamp(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-close-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-close-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "close me",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	closed, err := q.UpdateLandingRequest(context.Background(), UpdateLandingRequestParams{
		ID:             lr.ID,
		Title:          lr.Title,
		Body:           lr.Body,
		State:          "closed",
		TargetBookmark: lr.TargetBookmark,
		SourceBookmark: lr.SourceBookmark,
		ConflictStatus: lr.ConflictStatus,
		StackSize:      lr.StackSize,
		ClosedAt:       pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
		MergedAt:       lr.MergedAt,
		ExpectedState:  lr.State,
	})
	require.NoError(t, err)
	assert.Equal(t, "closed", closed.State)
	assert.True(t, closed.ClosedAt.Valid)
}

func TestMergeLandingRequest_SetsMergedStateAndTimestamp(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-merge-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-merge-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "merge me",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	merged, err := q.MergeLandingRequest(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, "merged", merged.State)
	assert.True(t, merged.MergedAt.Valid)
}

func TestListLandingRequestReviewsAndCount(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "landing-reviews-author")
	reviewerID := mustCreateUser(t, pool, "landing-reviews-reviewer")
	repoID := mustCreateRepo(t, pool, authorID, "landing-reviews-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "review list",
		Body:           "",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	created := make([]int64, 0, 3)
	for _, reviewType := range []string{"comment", "approve", "request_changes"} {
		review, err := q.CreateLandingRequestReview(context.Background(), CreateLandingRequestReviewParams{
			LandingRequestID: lr.ID,
			ReviewerID:       pgtype.Int8{Int64: reviewerID, Valid: true},
			Type:             reviewType,
			Body:             reviewType + " body",
		})
		require.NoError(t, err)
		created = append(created, review.ID)
	}

	reviews, err := q.ListLandingRequestReviews(context.Background(), ListLandingRequestReviewsParams{
		LandingRequestID: lr.ID,
		PageOffset:       1,
		PageSize:         1,
	})
	require.NoError(t, err)
	require.Len(t, reviews, 1)
	assert.Equal(t, created[1], reviews[0].ID)

	total, err := q.CountLandingRequestReviews(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
}

func TestLandingRequestAutoLandIntentLifecycle(t *testing.T) {
	q, pool := newQueries(t)
	ctx := context.Background()

	ownerID := mustCreateUser(t, pool, "landing-auto-owner")
	repoID := mustCreateRepo(t, pool, ownerID, "landing-auto-repo")
	lr, err := q.CreateLandingRequest(ctx, CreateLandingRequestParams{
		RepositoryID: repoID, Title: "land when green", AuthorID: ownerID,
		TargetBookmark: "main", SourceBookmark: "feature", StackSize: 1,
	})
	require.NoError(t, err)
	assert.False(t, lr.AutoLandEnabled)
	assert.False(t, lr.AutoLandSetBy.Valid)

	enabled, err := q.SetLandingRequestAutoLand(ctx, SetLandingRequestAutoLandParams{
		ID: lr.ID, SetBy: pgtype.Int8{Int64: ownerID, Valid: true},
	})
	require.NoError(t, err)
	assert.True(t, enabled.AutoLandEnabled)
	assert.Equal(t, ownerID, enabled.AutoLandSetBy.Int64)
	assert.True(t, enabled.AutoLandSetAt.Valid)
	assert.False(t, enabled.AutoLandCheckedAt.Valid)

	claimed, err := q.ClaimAutoLandCandidate(ctx)
	require.NoError(t, err)
	assert.Equal(t, lr.ID, claimed.ID)
	assert.True(t, claimed.AutoLandCheckedAt.Valid)

	queued, err := q.EnqueueAutoLandRequest(ctx, EnqueueAutoLandRequestParams{
		ID: lr.ID, QueuedBy: pgtype.Int8{Int64: ownerID, Valid: true},
		TargetBookmark: "main", SourceBookmark: "feature",
	})
	require.NoError(t, err)
	assert.Equal(t, "queued", queued.State)

	cleared, err := q.ClearLandingRequestAutoLand(ctx, lr.ID)
	require.NoError(t, err)
	assert.False(t, cleared.AutoLandEnabled)
	assert.False(t, cleared.AutoLandSetBy.Valid)
	assert.False(t, cleared.AutoLandSetAt.Valid)
}

func TestListLandingRequestCommentsAndCount(t *testing.T) {
	q, pool := newQueries(t)

	authorID := mustCreateUser(t, pool, "landing-comments-author")
	reviewerID := mustCreateUser(t, pool, "landing-comments-reviewer")
	repoID := mustCreateRepo(t, pool, authorID, "landing-comments-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "comment list",
		Body:           "",
		AuthorID:       authorID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	created := make([]int64, 0, 3)
	for i := 0; i < 3; i++ {
		comment, err := q.CreateLandingRequestComment(context.Background(), CreateLandingRequestCommentParams{
			LandingRequestID: lr.ID,
			UserID:           pgtype.Int8{Int64: reviewerID, Valid: true},
			Path:             "README.md",
			Line:             int64(i + 1),
			Side:             "right",
			Body:             "comment body",
		})
		require.NoError(t, err)
		created = append(created, comment.ID)
	}

	comments, err := q.ListLandingRequestComments(context.Background(), ListLandingRequestCommentsParams{
		LandingRequestID: lr.ID,
		PageOffset:       1,
		PageSize:         1,
	})
	require.NoError(t, err)
	require.Len(t, comments, 1)
	assert.Equal(t, created[1], comments[0].ID)

	total, err := q.CountLandingRequestComments(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
}

func TestCountLandingRequestChanges(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-changes-count-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-changes-count-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "change count",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	for idx, changeID := range []string{"k-a", "k-b", "k-c"} {
		_, err := q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
			LandingRequestID: lr.ID,
			ChangeID:         changeID,
			PositionInStack:  int64(idx + 1),
		})
		require.NoError(t, err)
	}

	total, err := q.CountLandingRequestChanges(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
}

func TestDeleteLandingRequestChanges(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "landing-changes-delete-user")
	repoID := mustCreateRepo(t, pool, userID, "landing-changes-delete-repo")
	lr, err := q.CreateLandingRequest(context.Background(), CreateLandingRequestParams{
		RepositoryID:   repoID,
		Title:          "change delete",
		Body:           "",
		AuthorID:       userID,
		TargetBookmark: "main",
		SourceBookmark: "feature",
		StackSize:      1,
	})
	require.NoError(t, err)

	for idx, changeID := range []string{"k-a", "k-b", "k-c"} {
		_, err := q.AddLandingRequestChange(context.Background(), AddLandingRequestChangeParams{
			LandingRequestID: lr.ID,
			ChangeID:         changeID,
			PositionInStack:  int64(idx + 1),
		})
		require.NoError(t, err)
	}

	err = q.DeleteLandingRequestChanges(context.Background(), lr.ID)
	require.NoError(t, err)

	total, err := q.CountLandingRequestChanges(context.Background(), lr.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), total)
}
