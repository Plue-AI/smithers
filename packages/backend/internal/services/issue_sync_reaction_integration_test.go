package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestIssueSyncReactionBeforeOutboundReceiptRetries(t *testing.T) {
	for _, provider := range []string{"slack", "telegram"} {
		t.Run(provider, func(t *testing.T) {
			pool := newProductTestPool(t)
			ctx := context.Background()
			actor, repo := issueCovSeedUserRepo(t, pool)
			svc := NewIssueService(db.New(pool))
			cfg := IssueSyncInput{Provider: "slack", ConnectionID: "workspace", ScopeID: "T001", ConversationID: "C001", ThreadID: "100.000001"}
			messageID, version, user := fmt.Sprintf("%d.000001", time.Now().Unix()), "102.000001", "U001"
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
			// A recent partial/unknown receipt can still identify the exact message.
			receiptID := messageID
			if provider == "telegram" {
				receiptID = "9," + messageID
			}
			require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID, IssueSyncReceipt{State: "outcome_unknown", Token: claim.Token, MessageID: receiptID}))
			_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
			require.ErrorAs(t, err, &retry)
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

func TestIssueSyncUnrelatedReactionIgnored(t *testing.T) {
	for _, provider := range []string{"slack", "telegram"} {
		t.Run(provider, func(t *testing.T) {
			pool := newProductTestPool(t)
			ctx := context.Background()
			actor, repo := issueCovSeedUserRepo(t, pool)
			svc := NewIssueService(db.New(pool))
			cfg := IssueSyncInput{Provider: provider, ConnectionID: "workspace", ScopeID: "T001", ConversationID: "C001", ThreadID: "100.000001"}
			messageID, version, user := "555.000001", "556.000001", "U001"
			if provider == "telegram" {
				cfg.ScopeID, cfg.ConversationID, cfg.ThreadID = "123", "-100", ""
				messageID, version, user = "555", "556.1", "42"
			}
			require.NoError(t, svc.ConfigureIssueSyncChannel(ctx, &actor, actor.Username, repo, cfg))
			issue, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "chat", Kind: "chat"})
			require.NoError(t, err)
			_, err = svc.PutIssueSync(ctx, &actor, actor.Username, repo, issue.Number, cfg)
			require.NoError(t, err)
			_, err = svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "outgoing"})
			require.NoError(t, err)
			rows, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
			require.NoError(t, err)
			_, err = svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID)
			require.NoError(t, err)
			for _, tc := range []struct{ name, state, receipt, age, thread string }{
				{name: "unknown without identity", state: "outcome_unknown", age: "0 seconds"},
				{name: "unknown different identity", state: "outcome_unknown", receipt: "999", age: "0 seconds"},
				{name: "stale dispatch", state: "dispatching", age: "1 minute"},
				{name: "stale unknown matching identity", state: "outcome_unknown", receipt: messageID, age: "1 minute"},
				{name: "dispatch different identity", state: "dispatching", receipt: "999", age: "0 seconds"},
				{name: "dispatch different thread", state: "dispatching", age: "0 seconds", thread: "777"},
			} {
				t.Run(tc.name, func(t *testing.T) {
					_, err = pool.Exec(ctx, `UPDATE issue_sync_deliveries SET state=$2,message_id=$3,updated_at=now()-$4::interval WHERE id=$1`, rows[0].ID, tc.state, tc.receipt, tc.age)
					require.NoError(t, err)
					in := IssueSyncEvent{IssueSyncInput: cfg, DeliveryKey: "unrelated-reaction", MessageID: messageID, Version: version, UserID: user, Kind: "reaction_add", Reaction: "thumbsup"}
					in.ThreadID = tc.thread
					if provider == "slack" && (tc.name == "unknown without identity" || tc.name == "dispatch different thread") {
						in.MessageID = fmt.Sprintf("%d.000001", time.Now().Unix())
					}
					if provider == "slack" && tc.thread != "" {
						in.ThreadID += ".000001"
					}
					_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
					var ignored IssueSyncIgnored
					require.ErrorAs(t, err, &ignored)
				})
			}
			if provider == "slack" {
				_, err = pool.Exec(ctx, `UPDATE issue_sync_deliveries SET state='dispatching',message_id='',updated_at=now() WHERE id=$1`, rows[0].ID)
				require.NoError(t, err)
				in := IssueSyncEvent{IssueSyncInput: cfg, DeliveryKey: "old-message", MessageID: messageID, Version: version, UserID: user, Kind: "reaction_remove", Reaction: "thumbsup"}
				in.ThreadID = ""
				_, err = svc.IngestIssueSync(ctx, &actor, actor.Username, repo, in)
				var ignored IssueSyncIgnored
				require.ErrorAs(t, err, &ignored, "an old Slack post cannot be the in-flight create")
			}
		})
	}
}
