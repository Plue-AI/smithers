package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestIssueSyncDurableRoundTrip(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := NewIssueService(q)
	cfg := IssueSyncInput{Provider: "slack", ConnectionID: "workspace", ScopeID: "T001", ConversationID: "C001", ExternalUserID: "U001"}
	require.NoError(t, svc.ConfigureIssueSyncChannel(ctx, &actor, actor.Username, repo, cfg))
	input := IssueSyncEvent{IssueSyncInput: cfg, DeliveryKey: "E001", MessageID: "100.000001", Version: "100.000001", UserID: "U001", Body: "sync test", Kind: "message"}
	id, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	again, err := NewIssueService(db.New(pool)).IngestIssueSync(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	require.Equal(t, id, again)
	issue, err := q.GetIssueByID(ctx, id)
	require.NoError(t, err)
	input.ThreadID = input.MessageID
	input.MessageID = "101.000001"
	input.Version = input.MessageID
	input.DeliveryKey = "E002"
	input.Body = "reply"
	reply, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	require.Equal(t, id, reply)
	rows, _, count, err := svc.ListIssueComments(ctx, &actor, actor.Username, repo, issue.Number, 0, 100)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
	deliveries, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Empty(t, deliveries, "inbound must not echo")
	input.Kind = "edit"
	input.Body = "edited"
	input.Version = "102.000001"
	input.DeliveryKey = "E003"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	input.Version = "101.500001"
	input.Body = "stale"
	input.DeliveryKey = "E004"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	current, err := svc.GetIssueComment(ctx, &actor, actor.Username, repo, rows[1].ID)
	require.NoError(t, err)
	require.Equal(t, "edited", current.Body)
	input.Kind = "delete"
	input.Version = "103.000001"
	input.DeliveryKey = "E005"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	input.Kind = "message"
	input.Version = "101.000001"
	input.DeliveryKey = "E006"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, input)
	require.NoError(t, err)
	_, _, count, err = svc.ListIssueComments(ctx, &actor, actor.Username, repo, issue.Number, 0, 100)
	require.NoError(t, err)
	require.Equal(t, int64(1), count, "delete must not resurrect")
	posted, err := svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "outbound", IdempotencyKey: "outbound"})
	require.NoError(t, err)
	deliveries, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, deliveries, 1)
	claim, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, deliveries[0].ID)
	require.NoError(t, err)
	require.Equal(t, "dispatching", claim.State)
	afterRestart, err := NewIssueService(db.New(pool)).ClaimIssueSync(ctx, &actor, actor.Username, repo, deliveries[0].ID)
	require.NoError(t, err)
	require.Equal(t, "outcome_unknown", afterRestart.State)
	require.Empty(t, afterRestart.Token)
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, deliveries[0].ID, IssueSyncReceipt{State: "sent", MessageID: "104.000001", Token: claim.Token}))
	_, err = svc.UpdateIssueComment(ctx, &actor, actor.Username, repo, posted.ID, UpdateIssueCommentInput{Body: "outbound edited"})
	require.NoError(t, err)
	deliveries, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, deliveries, 1)
	require.Equal(t, "104.000001", deliveries[0].MessageID)
	require.NoError(t, svc.DeleteIssueComment(ctx, &actor, actor.Username, repo, posted.ID))
	deliveries, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, deliveries, 2)
	require.Equal(t, "104.000001", deliveries[1].MessageID, "mapping survives deletion")
}

func TestIssueSyncDMReactionsAndOutOfOrder(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	q := db.New(pool)
	svc := NewIssueService(q)
	cfg := IssueSyncInput{Provider: "slack", ConnectionID: "workspace", ScopeID: "T001", ConversationID: "direct", ExternalUserID: "U001"}
	require.NoError(t, svc.ConfigureIssueSyncChannel(ctx, &actor, actor.Username, repo, cfg))
	cfg.ConversationID = "D001"
	in := IssueSyncEvent{IssueSyncInput: cfg, DeliveryKey: "delete-first", MessageID: "100.000001", Version: "102.000001", UserID: "U001", Kind: "delete"}
	id, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
	require.NoError(t, err)
	issue, err := q.GetIssueByID(ctx, id)
	require.NoError(t, err)
	in.Kind = "message"
	in.Body = "already deleted"
	in.Version = in.MessageID
	in.DeliveryKey = "late-create"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
	require.NoError(t, err)
	_, _, count, err := svc.ListIssueComments(ctx, &actor, actor.Username, repo, issue.Number, 0, 100)
	require.NoError(t, err)
	require.Zero(t, count)
	in.Kind = "edit"
	in.Body = "latest"
	in.MessageID = "103.000001"
	in.Version = "104.000001"
	in.DeliveryKey = "edit-first"
	same, err := svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
	require.NoError(t, err)
	require.Equal(t, id, same)
	in.Kind = "message"
	in.Body = "old"
	in.Version = in.MessageID
	in.DeliveryKey = "original-late"
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
	require.NoError(t, err)
	rows, _, count, err := svc.ListIssueComments(ctx, &actor, actor.Username, repo, issue.Number, 0, 100)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
	require.Equal(t, "latest", rows[0].Body)
	require.Equal(t, "U001", rows[0].Commenter)
	require.JSONEq(t, `{}`, string(rows[0].Persona), "human Slack messages must retain user role")
	for _, step := range []struct {
		kind, version, key string
		count              int
	}{
		{"reaction_add", "105.000001", "add", 1},
		{"reaction_remove", "106.000001", "remove", 0},
		{"reaction_add", "105.000001", "stale-add", 0},
		{"reaction_add", "107.000001", "re-add", 1},
	} {
		in.Kind = step.kind
		in.Version = step.version
		in.DeliveryKey = step.key
		in.Reaction = "eyes"
		_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
		require.NoError(t, err)
		reactions, e := svc.IssueReactions(ctx, &actor, actor.Username, repo, issue.Number, rows[0].ID)
		require.NoError(t, e)
		require.Len(t, reactions, step.count)
	}
	deliveries, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Empty(t, deliveries, "inbound reactions never echo")
	for _, active := range []bool{true, true, false, false} {
		_, err = svc.SetIssueReaction(ctx, &actor, actor.Username, repo, issue.Number, rows[0].ID, IssueReaction{Name: "eyes", Active: active})
		require.NoError(t, err)
	}
	deliveries, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, deliveries, 2, "only changed local reactions enqueue")
	in.UserID = "U002"
	in.DeliveryKey = "other-user"
	in.Kind = "message"
	in.MessageID = "110.000001"
	in.Version = in.MessageID
	_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
	require.Error(t, err, "another user cannot enter the owner's DM")
}

func TestIssueSyncMappingBackfillAndKnownRetry(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	issue, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "chat", Kind: "chat"})
	require.NoError(t, err)
	_, err = svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "before mapping"})
	require.NoError(t, err)
	cfg := IssueSyncInput{Provider: "slack", ConnectionID: "workspace", ScopeID: "T001", ConversationID: "C001"}
	for range 2 {
		_, err = svc.PutIssueSync(ctx, &actor, actor.Username, repo, issue.Number, cfg)
		require.NoError(t, err)
	}
	deliveries, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, deliveries, 1)
	require.NotEmpty(t, deliveries[0].Key)
	id := deliveries[0].ID
	claim, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, id)
	require.NoError(t, err)
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "failed", Token: claim.Token, Error: "missing_scope"}))
	mapping, err := svc.GetIssueSync(ctx, &actor, actor.Username, repo, issue.Number)
	require.NoError(t, err)
	require.Equal(t, "failed", mapping.State)
	require.Equal(t, id, mapping.DeliveryID)
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "pending"}))
	claim, err = svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, id)
	require.NoError(t, err)
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "outcome_unknown", Token: claim.Token}))
	require.Error(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "pending"}))
	require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "sent", MessageID: "100.000001"}))
	mapping, err = svc.GetIssueSync(ctx, &actor, actor.Username, repo, issue.Number)
	require.NoError(t, err)
	require.Equal(t, "synced", mapping.State)
	require.Equal(t, "100.000001", mapping.ThreadID)
}

func TestIssueSyncDeliveryPaginationDoesNotBlockIndependentThread(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	actor, repo := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	first, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "blocked", Kind: "chat"})
	require.NoError(t, err)
	cfg := IssueSyncInput{Provider: "slack", ConnectionID: "workspace", ScopeID: "T001", ConversationID: "C001", ThreadID: "100.000001"}
	_, err = svc.PutIssueSync(ctx, &actor, actor.Username, repo, first.Number, cfg)
	require.NoError(t, err)
	for range 100 {
		_, err = svc.CreateIssueComment(ctx, &actor, actor.Username, repo, first.Number, CreateIssueCommentInput{Body: "pending"})
		require.NoError(t, err)
	}
	second, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "independent", Kind: "chat"})
	require.NoError(t, err)
	cfg.ThreadID = "101.000001"
	_, err = svc.PutIssueSync(ctx, &actor, actor.Username, repo, second.Number, cfg)
	require.NoError(t, err)
	_, err = svc.CreateIssueComment(ctx, &actor, actor.Username, repo, second.Number, CreateIssueCommentInput{Body: "deliver"})
	require.NoError(t, err)
	page, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
	require.NoError(t, err)
	require.Len(t, page, 100)
	next, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo, page[99].ID)
	require.NoError(t, err)
	require.Len(t, next, 1)
	claim, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, next[0].ID)
	require.NoError(t, err)
	require.Equal(t, "dispatching", claim.State)
}
