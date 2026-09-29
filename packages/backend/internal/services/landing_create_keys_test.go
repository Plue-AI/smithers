package services

import (
	"context"
	stdErrors "errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	"github.com/stretchr/testify/require"
)

func TestLandingReviewAndCommentCreateKeysSurviveReplay(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	landing, err := q.CreateLandingRequest(ctx, db.CreateLandingRequestParams{RepositoryID: repoID, Title: "review keys", AuthorID: userID, TargetBookmark: "main", StackSize: 1})
	require.NoError(t, err)
	changeID, commitID := "change-"+uuid.NewString(), "commit-"+uuid.NewString()
	_, err = q.AddLandingRequestChange(ctx, db.AddLandingRequestChangeParams{LandingRequestID: landing.ID, ChangeID: changeID, PositionInStack: 1})
	require.NoError(t, err)
	_, err = q.UpsertChange(ctx, db.UpsertChangeParams{RepositoryID: repoID, ChangeID: changeID, CommitID: commitID, ParentChangeIds: []byte("[]")})
	require.NoError(t, err)
	_, err = q.RecordChangeRevision(ctx, db.RecordChangeRevisionParams{RepositoryID: repoID, ChangeID: changeID, CommitID: commitID, Source: "push"})
	require.NoError(t, err)
	svc := NewLandingServiceWithPool(q, &mockLandingRepoHostClient{getChangeFn: func(context.Context, string, string, string) (repohost.Change, error) {
		return repohost.Change{ChangeID: changeID, CommitID: commitID, ParentChangeIDs: []string{}}, nil
	}}, pool)
	reviewIn := CreateLandingReviewInput{IdempotencyKey: "github:review:1", Type: "comment", Body: "same text", CommitID: commitID}
	commentIn := CreateLandingCommentInput{IdempotencyKey: "github:comment:1", Body: "same text", CommitID: commitID}
	var wg sync.WaitGroup
	reviewIDs, commentIDs := make(chan int64, 6), make(chan int64, 6)
	errors := make(chan error, 12)
	for i := 0; i < 6; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			r, e := svc.CreateLandingReview(ctx, &actor, actor.Username, repo.Name, landing.Number, reviewIn)
			reviewIDs <- r.ID
			errors <- e
		}()
		go func() {
			defer wg.Done()
			c, e := svc.CreateLandingComment(ctx, &actor, actor.Username, repo.Name, landing.Number, commentIn)
			commentIDs <- c.ID
			errors <- e
		}()
	}
	wg.Wait()
	close(reviewIDs)
	close(commentIDs)
	close(errors)
	for e := range errors {
		require.NoError(t, e)
	}
	var reviewID, commentID int64
	for id := range reviewIDs {
		require.NotZero(t, id)
		if reviewID == 0 {
			reviewID = id
		}
		require.Equal(t, reviewID, id)
	}
	for id := range commentIDs {
		require.NotZero(t, id)
		if commentID == 0 {
			commentID = id
		}
		require.Equal(t, commentID, id)
	}
	var reviews, comments int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM landing_request_reviews WHERE landing_request_id=$1`, landing.ID).Scan(&reviews))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM landing_request_comments WHERE landing_request_id=$1`, landing.ID).Scan(&comments))
	require.Equal(t, 1, reviews)
	require.Equal(t, 1, comments)
	changedReview := reviewIn
	changedReview.Body = "changed"
	_, err = svc.CreateLandingReview(ctx, &actor, actor.Username, repo.Name, landing.Number, changedReview)
	require.Equal(t, 409, landingAPIStatus(t, err))
	changedComment := commentIn
	changedComment.Body = "changed"
	_, err = svc.CreateLandingComment(ctx, &actor, actor.Username, repo.Name, landing.Number, changedComment)
	require.Equal(t, 409, landingAPIStatus(t, err))
	reviewIn.IdempotencyKey = "github:review:2"
	distinctReview, err := svc.CreateLandingReview(ctx, &actor, actor.Username, repo.Name, landing.Number, reviewIn)
	require.NoError(t, err)
	require.NotEqual(t, reviewID, distinctReview.ID)
	commentIn.IdempotencyKey = "github:comment:2"
	distinctComment, err := svc.CreateLandingComment(ctx, &actor, actor.Username, repo.Name, landing.Number, commentIn)
	require.NoError(t, err)
	require.NotEqual(t, commentID, distinctComment.ID)

	// The row can commit before event delivery fails. The next request resumes
	// the unfinished stage, and a later replay leaves all stages untouched.
	dispatcher := &mockLandingDispatcher{}
	failed := true
	dispatcher.dispatchFn = func(context.Context, int64, webhooks.EventType, any) error {
		if failed {
			failed = false
			return stdErrors.New("delivery unavailable")
		}
		return nil
	}
	recovering := NewLandingServiceWithPool(q, svc.repoHost, pool, WithLandingWebhookDispatcher(dispatcher))
	reviewIn.IdempotencyKey = "github:review:recover"
	_, err = recovering.CreateLandingReview(ctx, &actor, actor.Username, repo.Name, landing.Number, reviewIn)
	require.Error(t, err)
	var recoveredReviewID int64
	var phase int
	require.NoError(t, pool.QueryRow(ctx, `SELECT id,create_effects_phase FROM landing_request_reviews WHERE landing_request_id=$1 AND create_key=$2`, landing.ID, reviewIn.IdempotencyKey).Scan(&recoveredReviewID, &phase))
	require.Equal(t, 2, phase)
	recoveredReview, err := recovering.CreateLandingReview(ctx, &actor, actor.Username, repo.Name, landing.Number, reviewIn)
	require.NoError(t, err)
	require.Equal(t, recoveredReviewID, recoveredReview.ID)
	_, err = recovering.CreateLandingReview(ctx, &actor, actor.Username, repo.Name, landing.Number, reviewIn)
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 2)
	require.NoError(t, pool.QueryRow(ctx, `SELECT create_effects_phase FROM landing_request_reviews WHERE id=$1`, recoveredReviewID).Scan(&phase))
	require.Equal(t, 3, phase)

	failed = true
	commentIn.IdempotencyKey = "github:comment:recover"
	_, err = recovering.CreateLandingComment(ctx, &actor, actor.Username, repo.Name, landing.Number, commentIn)
	require.Error(t, err)
	var recoveredCommentID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT id,create_effects_phase FROM landing_request_comments WHERE landing_request_id=$1 AND create_key=$2`, landing.ID, commentIn.IdempotencyKey).Scan(&recoveredCommentID, &phase))
	require.Equal(t, 1, phase)
	recoveredComment, err := recovering.CreateLandingComment(ctx, &actor, actor.Username, repo.Name, landing.Number, commentIn)
	require.NoError(t, err)
	require.Equal(t, recoveredCommentID, recoveredComment.ID)
	_, err = recovering.CreateLandingComment(ctx, &actor, actor.Username, repo.Name, landing.Number, commentIn)
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 4)
	require.NoError(t, pool.QueryRow(ctx, `SELECT create_effects_phase FROM landing_request_comments WHERE id=$1`, recoveredCommentID).Scan(&phase))
	require.Equal(t, 3, phase)

	config := pool.Config()
	config.MaxConns = 1
	config.MinConns = 0
	single, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	defer single.Close()
	bounded, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	smallPool := NewLandingServiceWithPool(db.New(single), svc.repoHost, single)
	reviewIn.IdempotencyKey = "github:review:one-connection"
	smallReview, err := smallPool.CreateLandingReview(bounded, &actor, actor.Username, repo.Name, landing.Number, reviewIn)
	require.NoError(t, err)
	replaySmallReview, err := smallPool.CreateLandingReview(bounded, &actor, actor.Username, repo.Name, landing.Number, reviewIn)
	require.NoError(t, err)
	require.Equal(t, smallReview.ID, replaySmallReview.ID)
}

func TestLandingCreateKeyValidation(t *testing.T) {
	for _, raw := range []string{" ", " leading", "trailing ", string(make([]byte, 256))} {
		_, err := landingCreateKey(raw)
		require.Error(t, err)
	}
	key, err := landingCreateKey("provider:42")
	require.NoError(t, err)
	require.Equal(t, "provider:42", key)
}
