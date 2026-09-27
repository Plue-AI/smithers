package services

import (
	"context"
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestIssueSyncOwnerResolvesUnknownTelegramEdit(t *testing.T) {
	for _, action := range []string{"skip", "retry", "sent"} {
		t.Run(action, func(t *testing.T) {
			pool := newProductTestPool(t)
			ctx := context.Background()
			actor, repo := issueCovSeedUserRepo(t, pool)
			svc := NewIssueService(db.New(pool))
			issue, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "chat", Kind: "chat"})
			require.NoError(t, err)
			_, err = svc.PutIssueSync(ctx, &actor, actor.Username, repo, issue.Number, IssueSyncInput{Provider: "telegram", ConnectionID: "bot", ScopeID: "123", ConversationID: "-100"})
			require.NoError(t, err)
			comment, err := svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "first"})
			require.NoError(t, err)
			rows, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
			require.NoError(t, err)
			claim, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID)
			require.NoError(t, err)
			require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID, IssueSyncReceipt{State: "sent", Token: claim.Token, MessageID: "10"}))
			_, err = svc.UpdateIssueComment(ctx, &actor, actor.Username, repo, comment.ID, UpdateIssueCommentInput{Body: "edit"})
			require.NoError(t, err)
			rows, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
			require.NoError(t, err)
			id := rows[0].ID
			claim, err = svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, id)
			require.NoError(t, err)
			require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "outcome_unknown", Token: claim.Token, MessageID: "10", Error: "connection lost"}))
			_, err = svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "next"})
			require.NoError(t, err)
			rows, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
			require.NoError(t, err)
			require.Len(t, rows, 2)
			blocked, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, rows[1].ID)
			require.NoError(t, err)
			require.Empty(t, blocked.Token)
			mapping, err := svc.GetIssueSync(ctx, &actor, actor.Username, repo, issue.Number)
			require.NoError(t, err)
			require.Equal(t, "outcome_unknown", mapping.State)
			require.Equal(t, id, mapping.DeliveryID)
			require.Equal(t, claim.Token, mapping.ResolutionToken)
			state := map[string]string{"skip": "unsupported", "retry": "pending", "sent": "sent"}[action]
			var resolution IssueSyncReceipt
			require.NoError(t, json.Unmarshal([]byte(`{"state":"`+state+`","resolution":"`+action+`","error":"Owner checked Telegram; accepts duplicate risk","message_id":"10"}`), &resolution))

			resolution.ExpectedToken = claim.Token
			invalid := resolution
			invalid.Error = ""
			require.Error(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, invalid))
			invalid = resolution
			invalid.Provider = "slack"
			require.Error(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, invalid))
			other, _ := issueCovSeedUserRepo(t, pool)
			require.Error(t, svc.CompleteIssueSync(ctx, &other, actor.Username, repo, id, resolution))
			require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, resolution))
			require.Error(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, resolution), "repeated resolution must not reset attempt")
			require.Error(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "sent", Token: claim.Token, MessageID: "10"}), "old worker is fenced")
			if action == "retry" {
				retry, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, id)
				require.NoError(t, err)
				require.NotEmpty(t, retry.Token)
				require.NotEqual(t, claim.Token, retry.Token)
				// The same request arriving after a second unknown outcome must
				// not grant a second retry; it belongs to the earlier attempt.
				require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "outcome_unknown", Token: retry.Token, MessageID: "10"}))
				require.Error(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, resolution))
				require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "sent", Token: retry.Token, MessageID: "10"}))
			}
			next, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, rows[1].ID)
			require.NoError(t, err)
			require.NotEmpty(t, next.Token)
			require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, rows[1].ID, IssueSyncReceipt{State: "sent", Token: next.Token, MessageID: "11"}))
			var evidence string
			require.NoError(t, pool.QueryRow(ctx, `SELECT payload->>'resolution' FROM issue_events WHERE issue_id=$1 AND event_type='sync.resolved'`, issue.ID).Scan(&evidence))
			require.Equal(t, action, evidence)
		})
	}
}
