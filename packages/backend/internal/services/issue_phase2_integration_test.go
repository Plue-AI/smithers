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

func TestIssueTelegramUsesSharedSync(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := NewIssueService(q)
	cfg := IssueSyncInput{Provider: "telegram", ConnectionID: "bot", ScopeID: "123", ConversationID: "-100001", ExternalUserID: "42"}
	require.NoError(t, svc.ConfigureIssueSyncChannel(ctx, &actor, actor.Username, repo, cfg))
	event := IssueSyncEvent{IssueSyncInput: cfg, DeliveryKey: "update:1", MessageID: "10", Version: "100.0000000001", UserID: "42", Body: "sync test", Kind: "message"}
	id, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.NoError(t, err)
	repeated, err := NewIssueService(db.New(pool)).IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.NoError(t, err)
	require.Equal(t, id, repeated)
	event.DeliveryKey = "update:2"
	event.MessageID = "11"
	event.Version = "100.0000000002"
	event.Body = "reply"
	reply, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.NoError(t, err)
	require.Equal(t, id, reply)
	event.Kind = "edit"
	event.DeliveryKey = "update:3"
	event.Version = "100.0000000003"
	event.Body = "edited same second"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.NoError(t, err)
	issue, err := q.GetIssueByID(ctx, id)
	require.NoError(t, err)
	rows, _, count, err := svc.ListIssueComments(ctx, &actor, actor.Username, repo, issue.Number, 0, 100)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
	require.Equal(t, "edited same second", rows[1].Body)
	pending, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Empty(t, pending)
	event.Kind = "message"
	event.ThreadID = "7"
	event.DeliveryKey = "update:4"
	event.MessageID = "12"
	event.Version = "101.0000000004"
	topic, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.NoError(t, err)
	require.NotEqual(t, id, topic)
	event.UserID = "99"
	event.DeliveryKey = "forbidden"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.Error(t, err)
	posted, err := svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "outbound", IdempotencyKey: "outbound"})
	require.NoError(t, err)
	pending, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, pending, 1)
	require.Equal(t, "telegram", pending[0].Mapping.Provider)
	claim, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, pending[0].ID)
	require.NoError(t, err)
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, pending[0].ID, IssueSyncReceipt{State: "sent", Token: claim.Token, MessageID: "20,21"}))
	_, err = svc.UpdateIssueComment(ctx, &actor, actor.Username, repo, posted.ID, UpdateIssueCommentInput{Body: "longer"})
	require.NoError(t, err)
	pending, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Equal(t, "20,21", pending[0].MessageID)
	claim, err = svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, pending[0].ID)
	require.NoError(t, err)
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, pending[0].ID, IssueSyncReceipt{State: "outcome_unknown", Token: claim.Token, MessageID: "20,21,22"}))
	recovered, e := NewIssueService(db.New(pool)).IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, e)
	require.Equal(t, "20,21,22", recovered[0].MessageID, "partial receipt must survive restart ahead of old mapping")
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, pending[0].ID, IssueSyncReceipt{State: "sent", Token: claim.Token, MessageID: "20,21,22"}))
	require.NoError(t, svc.DeleteIssueComment(ctx, &actor, actor.Username, repo, posted.ID))
	pending, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Equal(t, "20,21,22", pending[0].MessageID)
}

func TestIssueTelegramTopicAdmission(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	cfg := IssueSyncInput{Provider: "telegram", ConnectionID: "bot", ScopeID: "123", ConversationID: "-100", ThreadID: "7"}
	require.NoError(t, svc.ConfigureIssueSyncChannel(ctx, &actor, actor.Username, repo, cfg))
	event := IssueSyncEvent{IssueSyncInput: cfg, DeliveryKey: "one", MessageID: "10", Version: "100.1", UserID: "42", Body: "topic", Kind: "message"}
	_, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.NoError(t, err)
	event.ThreadID = "8"
	event.DeliveryKey = "two"
	event.MessageID = "11"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.Error(t, err)
	event.ThreadID = ""
	event.DeliveryKey = "three"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, event)
	require.Error(t, err)
}
