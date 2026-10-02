package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestIssueCommentFactsAndLookup(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	owner, repo := issueCovSeedUserRepo(t, pool)
	other, _ := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := NewIssueService(q)
	issue, err := svc.CreateIssue(ctx, &owner, owner.Username, repo, CreateIssueInput{Title: "private", Kind: "chat"})
	require.NoError(t, err)
	c, err := svc.CreateIssueComment(ctx, &owner, owner.Username, repo, issue.Number, CreateIssueCommentInput{Body: "reply", IdempotencyKey: "dispatch:step", Persona: &IssuePersona{Username: "Builder"}})
	require.NoError(t, err)
	got, err := svc.FindIssueComment(ctx, &owner, owner.Username, repo, issue.Number, "dispatch:step")
	require.NoError(t, err)
	require.Equal(t, c.ID, got.ID)
	_, err = svc.FindIssueComment(ctx, &other, owner.Username, repo, issue.Number, "dispatch:step")
	require.Error(t, err)
	_, err = svc.UpdateIssueComment(ctx, &owner, owner.Username, repo, c.ID, UpdateIssueCommentInput{Body: "edited"})
	require.NoError(t, err)
	got, err = svc.FindIssueComment(ctx, &owner, owner.Username, repo, issue.Number, "dispatch:step")
	require.NoError(t, err)
	require.Equal(t, "edited", got.Body)
	require.NoError(t, svc.DeleteIssueComment(ctx, &owner, owner.Username, repo, c.ID))
	_, err = svc.FindIssueComment(ctx, &owner, owner.Username, repo, issue.Number, "dispatch:step")
	require.ErrorContains(t, err, "deleted")
	_, err = svc.FindIssueComment(ctx, &owner, owner.Username, repo, issue.Number, "missing")
	require.ErrorContains(t, err, "not found")
	facts := NewIssueEventService(q)
	page, err := facts.ListIssueStateFacts(ctx, &owner, owner.Username, repo, 0, 0, 1)
	require.NoError(t, err)
	require.Len(t, page.Events, 1)
	require.Equal(t, "issue_comment", page.Events[0].EntityType)
	require.Contains(t, string(page.Events[0].PostImage), "Builder")
	resumed, err := facts.ListIssueStateFacts(ctx, &owner, owner.Username, repo, 0, page.Cursor, 100)
	require.NoError(t, err)
	require.Len(t, resumed.Events, 2)
	require.Equal(t, "deleted", resumed.Events[1].Operation)
	require.Empty(t, resumed.Events[1].PostImage)
	hidden, err := facts.ListIssueStateFacts(ctx, &other, owner.Username, repo, 0, 0, 100)
	require.NoError(t, err)
	require.Empty(t, hidden.Events)
	require.Equal(t, resumed.Cursor, hidden.Cursor)
	require.False(t, hidden.HasMore)
	projection, err := RebuildIssueStateProjection(append(page.Events, resumed.Events...))
	require.NoError(t, err)
	require.Empty(t, projection.Comments)
	// Delete the parent: retained private tombstones must remain owner-filtered.
	_, err = pool.Exec(ctx, `DELETE FROM issues WHERE id=$1`, issue.ID)
	require.NoError(t, err)
	hidden, err = facts.ListIssueStateFacts(ctx, &other, owner.Username, repo, 0, 0, 100)
	require.NoError(t, err)
	require.Empty(t, hidden.Events)
}

func TestRetiredMappingsDoNotDispatchNativeCommentChanges(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	owner, repo := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	issue, err := svc.CreateIssue(ctx, &owner, owner.Username, repo, CreateIssueInput{Title: "chat", Kind: "chat"})
	require.NoError(t, err)
	// Existing mapping and receipt survive; the migration changes no old data.
	_, err = pool.Exec(ctx, `INSERT INTO issue_sync_threads(issue_id,owner_id,provider,connection_id,scope_id,conversation_id) VALUES($1,$2,'slack','old','T001','C001')`, issue.ID, owner.ID)
	require.NoError(t, err)
	var eventID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO issue_events(issue_id,actor_id,event_type,payload) VALUES($1,$2,'comment.created','{}') RETURNING id`, issue.ID, owner.ID).Scan(&eventID))
	_, err = pool.Exec(ctx, `INSERT INTO issue_sync_deliveries(issue_id,event_id,state,error) VALUES($1,$2,'outcome_unknown','historical receipt')`, issue.ID, eventID)
	require.NoError(t, err)
	comment, err := svc.CreateIssueComment(ctx, &owner, owner.Username, repo, issue.Number, CreateIssueCommentInput{Body: "first", IdempotencyKey: "native-message"})
	require.NoError(t, err)
	reactions, err := svc.SetIssueReaction(ctx, &owner, owner.Username, repo, issue.Number, comment.ID, IssueReaction{Name: "eyes", Active: true})
	require.NoError(t, err)
	require.Len(t, reactions, 1)
	_, err = svc.UpdateIssueComment(ctx, &owner, owner.Username, repo, comment.ID, UpdateIssueCommentInput{Body: "edited"})
	require.NoError(t, err)
	require.NoError(t, svc.DeleteIssueComment(ctx, &owner, owner.Username, repo, comment.ID))
	var events []string
	var deliveries int
	require.NoError(t, pool.QueryRow(ctx, `SELECT array_agg(event_type ORDER BY id) FROM issue_events WHERE issue_id=$1`, issue.ID).Scan(&events))
	require.Equal(t, []string{"opened", "comment.created", "comment.created", "comment.reaction", "comment.edited", "comment.deleted"}, events, "native timeline plus historical event and create/reaction/edit/delete remain durable")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_sync_deliveries WHERE issue_id=$1`, issue.ID).Scan(&deliveries))
	require.Equal(t, 1, deliveries, "native changes never enqueue retired provider deliveries")
	var state, reason string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state,error FROM issue_sync_deliveries WHERE issue_id=$1`, issue.ID).Scan(&state, &reason))
	require.Equal(t, "outcome_unknown", state)
	require.Equal(t, "historical receipt", reason)
}
