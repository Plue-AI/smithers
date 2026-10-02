package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestIssueReactionOwnerSurvivesReconnectAndCannotRemoveOthers(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	owner, repo := issueCovSeedUserRepo(t, pool)
	other, _ := issueCovSeedUserRepo(t, pool)
	svc := NewIssueService(db.New(pool))
	issue, err := svc.CreateIssue(ctx, &owner, owner.Username, repo, CreateIssueInput{Title: "Reaction ownership", Kind: "chat"})
	require.NoError(t, err)
	comment, err := svc.CreateIssueComment(ctx, &owner, owner.Username, repo, issue.Number, CreateIssueCommentInput{Body: "Ready"})
	require.NoError(t, err)
	got, err := svc.SetIssueReaction(ctx, &owner, owner.Username, repo, issue.Number, comment.ID, IssueReaction{Name: "eyes", Active: true})
	require.NoError(t, err)
	require.Equal(t, []IssueReaction{{Name: "eyes", Actor: owner.Username, Active: true}}, got, "the mutation response must use the viewer's login")
	var addedActor string
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->'reaction'->>'actor' FROM issue_events WHERE issue_id=$1 AND event_type='comment.reaction' ORDER BY id DESC LIMIT 1`, issue.ID).Scan(&addedActor))
	require.Equal(t, owner.Username, addedActor)
	// Other native and imported reactions share the chip but remain separately owned.
	_, err = pool.Exec(ctx, `INSERT INTO reactions(user_id,target_type,target_id,emoji) VALUES($1,'issue_comment',$2,'eyes')`, other.ID, comment.ID)
	require.NoError(t, err)
	var externalID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO reactions(target_type,target_id,emoji) VALUES('issue_comment',$1,'thumbsup') RETURNING id`, comment.ID).Scan(&externalID))
	_, err = pool.Exec(ctx, `INSERT INTO issue_external_reactions(reaction_id,issue_id,comment_id,actor,name) VALUES($1,$2,$3,$4,'thumbsup')`, externalID, issue.ID, comment.ID, "slack:T001:"+owner.Username)
	require.NoError(t, err)
	reloaded := NewIssueService(db.New(pool))
	got, err = reloaded.IssueReactions(ctx, &owner, owner.Username, repo, issue.Number, comment.ID)
	require.NoError(t, err)
	wantOthers := []IssueReaction{{Name: "eyes", Actor: other.Username, Active: true}, {Name: "thumbsup", Actor: "slack:T001:" + owner.Username, Active: true}}
	require.ElementsMatch(t, append([]IssueReaction{{Name: "eyes", Actor: owner.Username, Active: true}}, wantOthers...), got)
	// The caller-supplied actor must never authorize deleting somebody else's reaction.
	got, err = reloaded.SetIssueReaction(ctx, &owner, owner.Username, repo, issue.Number, comment.ID, IssueReaction{Name: "eyes", Actor: other.Username, Active: false})
	require.NoError(t, err)
	require.ElementsMatch(t, wantOthers, got)
	got, err = reloaded.SetIssueReaction(ctx, &owner, owner.Username, repo, issue.Number, comment.ID, IssueReaction{Name: "thumbsup", Actor: "slack:T001:" + owner.Username, Active: false})
	require.NoError(t, err)
	require.ElementsMatch(t, wantOthers, got)
	var eventActor string
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload->'reaction'->>'actor' FROM issue_events WHERE issue_id=$1 AND event_type='comment.reaction' ORDER BY id DESC LIMIT 1`, issue.ID).Scan(&eventActor))
	require.Equal(t, owner.Username, eventActor, "live events and reload responses must agree")
}
