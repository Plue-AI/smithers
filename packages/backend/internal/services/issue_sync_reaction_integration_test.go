package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestIssueSyncReactionBeforeOutboundReceiptRetries(t *testing.T) {
	for _, provider := range []string{"slack", "telegram"} {
		t.Run(provider, func(t *testing.T) {
			pool := newProductTestPool(t)
			ctx := context.Background()
			actor, repo := issueCovSeedUserRepo(t, pool)
			svc := NewIssueService(db.New(pool))
			cfg := IssueSyncInput{Provider: "slack", ConnectionID: "workspace", ScopeID: "T001", ConversationID: "C001", ThreadID: "100.000001"}
			messageID, version, user := "101.000001", "102.000001", "U001"
			if provider == "telegram" {
				cfg = IssueSyncInput{Provider: provider, ConnectionID: "bot", ScopeID: "123", ConversationID: "-100"}
				messageID, version, user = "10", "102.1", "42"
			}
			require.NoError(t, svc.ConfigureIssueSyncChannel(ctx, &actor, actor.Username, repo, cfg))
			issue, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "chat", Kind: "chat"})
			require.NoError(t, err)
			_, err = svc.PutIssueSync(ctx, &actor, actor.Username, repo, issue.Number, cfg)
			require.NoError(t, err)
			comment, err := svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "outgoing"})
			require.NoError(t, err)
			rows, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
			require.NoError(t, err)
			claim, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID)
			require.NoError(t, err)
			in := IssueSyncEvent{IssueSyncInput: cfg, DeliveryKey: "reaction-before-receipt", MessageID: messageID, Version: version, UserID: user, Kind: "reaction_add", Reaction: "thumbsup"}
			// Slack reactions do not carry thread_ts; the external message link is not committed yet.
			if provider == "slack" {
				in.ThreadID = ""
			}
			_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
			var retry *api.APIError
			require.ErrorAs(t, err, &retry, "receipt race must remain unacknowledged")
			require.Equal(t, 409, retry.Status)
			require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID, IssueSyncReceipt{State: "sent", Token: claim.Token, MessageID: func() string {
				if provider == "telegram" {
					return "9," + messageID
				}
				return messageID
			}()}))
			for range 2 {
				got, err := NewIssueService(db.New(pool)).IngestIssueSync(ctx, &actor, actor.Username, repo, in)
				require.NoError(t, err)
				require.Equal(t, issue.ID, got)
			}
			reactions, err := svc.IssueReactions(ctx, &actor, actor.Username, repo, issue.Number, comment.ID)
			require.NoError(t, err)
			require.Len(t, reactions, 1)
		})
	}
}
