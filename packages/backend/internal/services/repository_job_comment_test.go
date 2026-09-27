package services

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

type repositoryCommentFailedRow struct{}

func (repositoryCommentFailedRow) Scan(...interface{}) error {
	return fmt.Errorf("receipt store failed")
}

type repositoryCommentFailureTx struct{ pgx.Tx }

func (tx repositoryCommentFailureTx) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
	if strings.HasPrefix(sql, "-- name: CreateRepositoryJobComment") {
		return repositoryCommentFailedRow{}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

type repositoryCommentFailureTransactions struct{ RepositoryJobTransactions }

func (store repositoryCommentFailureTransactions) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := store.RepositoryJobTransactions.Begin(ctx)
	return repositoryCommentFailureTx{tx}, err
}

func TestRepositoryJobsIntegrationNativeReply(t *testing.T) {
	pool, _, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	trialInput := RepositoryJobTrialInput{Repo: input.Repo, WorkspaceID: input.WorkspaceID, Revision: input.Revision, Digest: input.Digest, Title: "Reply test"}
	pressTrial(t, pool, g.target, "issues", "native-reply-trial", trialInput)
	trial, err := s.CreateTrial(ctx, "gateway", "token", "issues", "native-reply-trial", trialInput)
	require.NoError(t, err)
	input.Mode, input.TrialSource, input.TrialIssueNumber = "trial", "smithers-cloud", trial.Number
	_, err = s.Register(ctx, "gateway", "token", "issues", input)
	require.NoError(t, err)
	repositoryJobPoll(t, s, g)
	dispatches, err := s.Dispatches(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	require.Len(t, dispatches, 1)
	require.Equal(t, "submitted", dispatches[0].Status)
	request := RepositoryJobCommentInput{Repo: input.Repo, WorkspaceID: input.WorkspaceID, Revision: input.Revision, Digest: input.Digest,
		DeliveryKey: dispatches[0].DeliveryKey, Source: trial.Source, IssueNumber: trial.Number, Body: "Which configuration reproduces this?"}
	// The service reaches the real INSERT and its outbox trigger, then fails
	// the receipt write. Both externally visible rows must roll back together.
	s.transactions = repositoryCommentFailureTransactions{pool}
	_, err = s.CreateComment(ctx, "gateway", "token", "issues", "research:question", request)
	require.ErrorContains(t, err, "receipt store failed")
	s.transactions = pool
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_comments WHERE issue_id=$1`, trial.IssueID).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1 AND event_type='issue_comment'`, g.target.RepositoryID).Scan(&count))
	require.Zero(t, count)

	results := make([]RepositoryJobCommentResult, 8)
	errors := make([]error, 8)
	var group sync.WaitGroup
	for i := range results {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			results[i], errors[i] = s.CreateComment(ctx, "gateway", "token", "issues", "research:question", request)
		}(i)
	}
	group.Wait()
	for i := range results {
		require.NoError(t, errors[i])
		require.Equal(t, results[0], results[i])
	}
	receipt := results[0]
	require.Positive(t, receipt.CommentID)
	require.Equal(t, "/repos/"+input.Repo+fmt.Sprintf("/issues/%d/comments", trial.Number), receipt.APIPath)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_comments WHERE issue_id=$1`, trial.IssueID).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_events WHERE repository_id=$1 AND event_type='issue_comment' AND event_action='created'`, g.target.RepositoryID).Scan(&count))
	require.Equal(t, 1, count)
	repositoryJobPoll(t, s, g)
	require.Len(t, g.runs, 1, "the job must never trigger on its own automatic reply")
	require.Empty(t, g.signalKeys, "its own question is not an author reply")

	for name, edit := range map[string]func(*RepositoryJobCommentInput){
		"body":       func(r *RepositoryJobCommentInput) { r.Body = "different" },
		"digest":     func(r *RepositoryJobCommentInput) { r.Digest = strings.Repeat("e", 64) },
		"source":     func(r *RepositoryJobCommentInput) { r.Source = "github" },
		"issue":      func(r *RepositoryJobCommentInput) { r.IssueNumber++ },
		"event":      func(r *RepositoryJobCommentInput) { r.DeliveryKey = "native:not-admitted" },
		"workspace":  func(r *RepositoryJobCommentInput) { r.WorkspaceID = "other" },
		"repository": func(r *RepositoryJobCommentInput) { r.Repo = "other/repo" },
	} {
		t.Run(name, func(t *testing.T) {
			other := request
			edit(&other)
			_, err := s.CreateComment(ctx, "gateway", "token", "issues", "research:question", other)
			require.Error(t, err)
		})
	}
	_, err = s.Pause(ctx, g.target.RepositoryID, g.target.UserID, "issues")
	require.NoError(t, err)
	_, err = s.CreateComment(ctx, "gateway", "token", "issues", "research:followup", request)
	require.ErrorContains(t, err, "paused")
	replay, err := s.CreateComment(ctx, "gateway", "token", "issues", "research:question", request)
	require.NoError(t, err)
	require.Equal(t, receipt, replay)
	_, err = pool.Exec(ctx, `DELETE FROM issue_comments WHERE id=$1`, receipt.CommentID)
	require.NoError(t, err)
	replay, err = s.CreateComment(ctx, "gateway", "token", "issues", "research:question", request)
	require.NoError(t, err)
	require.Equal(t, receipt, replay, "deleting a posted comment must not cause it to reappear on retry")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_comments WHERE issue_id=$1`, trial.IssueID).Scan(&count))
	require.Zero(t, count)
}
