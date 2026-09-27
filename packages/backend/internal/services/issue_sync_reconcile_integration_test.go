package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestIssueSyncTokenlessReconcile(t *testing.T) {
	for _, provider := range []string{"slack", "telegram"} {
		for _, event := range []string{"comment.created", "comment.edited", "comment.deleted"} {
			t.Run(provider+"/"+event, func(t *testing.T) {
				pool := newProductTestPool(t)
				ctx := context.Background()
				actor, repo := issueCovSeedUserRepo(t, pool)
				svc := NewIssueService(db.New(pool))
				cfg := IssueSyncInput{Provider: provider, ConnectionID: "workspace", ScopeID: "T001", ConversationID: "C001"}
				messageID := "101.000001"
				if provider == "telegram" {
					cfg.ScopeID, cfg.ConversationID, messageID = "123", "-100", "10"
				}
				issue, err := svc.CreateIssue(ctx, &actor, actor.Username, repo, CreateIssueInput{Title: "chat", Kind: "chat"})
				require.NoError(t, err)
				_, err = svc.PutIssueSync(ctx, &actor, actor.Username, repo, issue.Number, cfg)
				require.NoError(t, err)
				comment, err := svc.CreateIssueComment(ctx, &actor, actor.Username, repo, issue.Number, CreateIssueCommentInput{Body: "first"})
				require.NoError(t, err)
				rows, err := svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
				require.NoError(t, err)
				claim, err := svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID)
				require.NoError(t, err)
				if event != "comment.created" {
					require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID, IssueSyncReceipt{State: "sent", Token: claim.Token, MessageID: messageID}))
					if event == "comment.edited" {
						_, err = svc.UpdateIssueComment(ctx, &actor, actor.Username, repo, comment.ID, UpdateIssueCommentInput{Body: "edit"})
					} else {
						err = svc.DeleteIssueComment(ctx, &actor, actor.Username, repo, comment.ID)
					}
					require.NoError(t, err)
					rows, err = svc.IssueSyncDeliveries(ctx, &actor, actor.Username, repo)
					require.NoError(t, err)
					claim, err = svc.ClaimIssueSync(ctx, &actor, actor.Username, repo, rows[0].ID)
					require.NoError(t, err)
				}
				id := rows[0].ID
				require.NoError(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "outcome_unknown", Token: claim.Token, Error: "connection lost"}))
				err = svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "sent", MessageID: messageID})
				var state string
				var count int
				require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM issue_sync_deliveries WHERE id=$1`, id).Scan(&state))
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_events WHERE issue_id=$1 AND event_type='sync.resolved'`, issue.ID).Scan(&count))
				if provider != "slack" || event != "comment.created" {
					require.Error(t, err, "only Slack create reconciliation may omit the token")
					require.Equal(t, "outcome_unknown", state)
					require.Zero(t, count)
					return
				}
				require.NoError(t, err)
				require.Equal(t, "sent", state)
				require.Equal(t, 1, count)
				var raw []byte
				var auditActor int64
				require.NoError(t, pool.QueryRow(ctx, `SELECT actor_id,payload FROM issue_events WHERE issue_id=$1 AND event_type='sync.resolved'`, issue.ID).Scan(&auditActor, &raw))
				var audit map[string]any
				require.NoError(t, json.Unmarshal(raw, &audit))
				require.Equal(t, actor.ID, auditActor)
				require.Equal(t, float64(id), audit["delivery_id"])
				require.Equal(t, "sent", audit["resolution"])
				require.Equal(t, messageID, audit["message_id"])
				require.NotEmpty(t, audit["evidence"])
				previous := audit["previous"].(map[string]any)
				require.Equal(t, "outcome_unknown", previous["state"])
				require.Equal(t, "connection lost", previous["error"])
				require.NotContains(t, previous, "claim_token")
				require.Error(t, svc.CompleteIssueSync(ctx, &actor, actor.Username, repo, id, IssueSyncReceipt{State: "sent", MessageID: messageID}))
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_events WHERE issue_id=$1 AND event_type='sync.resolved'`, issue.ID).Scan(&count))
				require.Equal(t, 1, count)
			})
		}
	}
}
