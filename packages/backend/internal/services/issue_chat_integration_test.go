package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestIssueChatPrivacyAndMessageIdentity(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	owner, repo := issueCovSeedUserRepo(t, pool)
	other, _ := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := NewIssueService(q)
	issue, err := svc.CreateIssue(ctx, &owner, owner.Username, repo, CreateIssueInput{Title: "private conversation", Body: "private body", Kind: "chat"})
	require.NoError(t, err)
	require.Equal(t, "chat", issue.Kind)
	require.Equal(t, "private", issue.Visibility)
	for _, viewer := range []*db.User{nil, &other} {
		_, err = svc.GetIssue(ctx, viewer, owner.Username, repo, issue.Number)
		require.Error(t, err)
		rows, _, _, e := svc.ListIssues(ctx, viewer, owner.Username, repo, 0, 100, "")
		require.NoError(t, e)
		require.Empty(t, rows)
		_, _, _, e = svc.ListIssueComments(ctx, viewer, owner.Username, repo, issue.Number, 0, 100)
		require.Error(t, e)
		_, e = NewIssueEventService(q).ListIssueEvents(ctx, viewer, owner.Username, repo, issue.Number, 1, 100)
		require.Error(t, e)
	}
	req := CreateIssueCommentInput{Body: "message", IdempotencyKey: "one", Persona: &IssuePersona{Username: "Navigator", IconEmoji: ":compass:"}}
	first, err := svc.CreateIssueComment(ctx, &owner, owner.Username, repo, issue.Number, req)
	require.NoError(t, err)
	// A new service instance simulates reconnect: the database owns deduplication.
	second, err := NewIssueService(db.New(pool)).CreateIssueComment(ctx, &owner, owner.Username, repo, issue.Number, req)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID)
	req.Body = "different"
	_, err = svc.CreateIssueComment(ctx, &owner, owner.Username, repo, issue.Number, req)
	require.Error(t, err)
	_, err = svc.GetIssueComment(ctx, &other, owner.Username, repo, first.ID)
	require.Error(t, err)
	_, err = svc.UpdateIssueComment(ctx, &other, owner.Username, repo, first.ID, UpdateIssueCommentInput{Body: "leak"})
	require.Error(t, err)
	require.Error(t, svc.DeleteIssueComment(ctx, &other, owner.Username, repo, first.ID))
	_, err = svc.UpdateIssueComment(ctx, &owner, owner.Username, repo, first.ID, UpdateIssueCommentInput{Body: "edited"})
	require.NoError(t, err)
	require.NoError(t, svc.DeleteIssueComment(ctx, &owner, owner.Username, repo, first.ID))
	var count int
	for _, table := range []string{"repository_job_events"} {
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE repository_id=$1", issueTxRepoID(t, pool, repo)).Scan(&count))
		require.Zero(t, count, table)
	}
	require.NoError(t, pool.QueryRow(ctx, "SELECT num_issues FROM repositories WHERE id=$1", issueTxRepoID(t, pool, repo)).Scan(&count))
	require.Zero(t, count)
}

func TestIssueChatThreadAndDeletedMessageRequestIdentity(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	input := CreateIssueInput{Title: "conversation", Kind: "chat", IdempotencyKey: "conversation:one"}
	first, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	again, err := NewIssueService(db.New(pool)).CreateIssue(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	require.Equal(t, first.ID, again.ID)
	require.Equal(t, input.IdempotencyKey, again.IdempotencyKey)
	req := CreateIssueCommentInput{Body: "once", IdempotencyKey: "one"}
	c, err := svc.CreateIssueComment(ctx, &actor, actor.Username, repo, first.Number, req)
	require.NoError(t, err)
	require.Equal(t, req.IdempotencyKey, c.IdempotencyKey)
	_, err = svc.UpdateIssueComment(ctx, &actor, actor.Username, repo, c.ID, UpdateIssueCommentInput{Body: "edited"})
	require.NoError(t, err)
	replay, err := svc.CreateIssueComment(ctx, &actor, actor.Username, repo, first.Number, req)
	require.NoError(t, err)
	require.Equal(t, c.ID, replay.ID)
	require.Equal(t, "edited", replay.Body)
	require.NoError(t, svc.DeleteIssueComment(ctx, &actor, actor.Username, repo, c.ID))
	_, err = svc.CreateIssueComment(ctx, &actor, actor.Username, repo, first.Number, req)
	require.Error(t, err, "a deleted request cannot resurrect")
}

func TestIssueChatConcurrentMessageIdentity(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	issue, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "race", Kind: "chat"})
	require.NoError(t, err)
	ready := make(chan struct{})
	results := make(chan error, 2)
	for _, body := range []string{"first", "different"} {
		go func(body string) {
			<-ready
			_, e := NewIssueService(db.New(pool)).CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: body, IdempotencyKey: "same"})
			results <- e
		}(body)
	}
	close(ready)
	successes := 0
	for range 2 {
		if <-results == nil {
			successes++
		}
	}
	require.Equal(t, 1, successes, "one logical identity may accept only one payload")
	rows, _, count, err := svc.ListIssueComments(ctx, &actor, actor.Username, repo, issue.Number, 0, 100)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
	require.Len(t, rows, 1)
}
