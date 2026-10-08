package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// stackActorGitHub is GitHub as the installed composition reaches it: the
// stack's actor connected the repository, so only that account resolves it.
// Any other member's own account answers as resolveGitHubDestination does
// for an unconnected user.
type stackActorGitHub struct {
	mythicalGitHub
	actor int64
}

func (g stackActorGitHub) Resolve(ctx context.Context, repository db.Repository, owner string, actorUserID int64) (mythicalGitHubRepo, error) {
	if actorUserID != g.actor {
		return mythicalGitHubRepo{}, fmt.Errorf("user %d has no GitHub destination for %s/%s", actorUserID, owner, repository.Name)
	}
	return g.mythicalGitHub.Resolve(ctx, repository, owner, actorUserID)
}

// C-J6-02 (found on the installed composition): maintainer Ben, who is not
// the stack's actor, asks for Merge through his delegated laptop credential.
// The Review & merge card reads the pull request's checks as the stack's
// actor, as MergeReady and the merge worker do, so Ben gets a pending card
// rather than 503 confirmation_unavailable, and nothing merges.
func TestMergeConfirmationForNonActorMaintainerPostgres(t *testing.T) {
	h := newMergeHarness(t)
	const repo = "rehearsal-owner/app"
	h.fake.RequireCheck("unit")
	t1, h1, _ := h.first("First")
	h.fake.SetCheck(repo, h1, "unit", "completed", "success")
	h.fake.SetCollaborator(8, "ben", "maintain")
	ben, _ := h.person("ben", 8)
	h.exec(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES ($1,$2,'admin')`, h.repoID, ben)
	h.service.github = stackActorGitHub{mythicalGitHub: h.service.github, actor: h.userID}
	benDelegated := mergeOrderCredential(t, h, ben, "ben-laptop-claude-code", "read:repository,write:repository,via:claude-code")
	approvals := NewApprovalsService(h.q, WithConfirmationTodos(h.pool, h.service))

	input := ConfirmationInput{Command: "merge", Subject: json.RawMessage(fmt.Sprintf(`{"kind":"todo","ref":"T%d"}`, t1)),
		Payload: json.RawMessage(fmt.Sprintf(`{"reviewed_head_sha":%q}`, h1)), Key: "ben-laptop-merge"}
	receipt, err := approvals.RequestConfirmation(benDelegated, input)
	require.NoError(t, err)
	assert.Equal(t, "pending", receipt.State)

	var member int64
	var kind, state string
	var payload []byte
	require.NoError(t, h.pool.QueryRow(context.Background(), `SELECT member_id,kind,state,payload FROM approvals WHERE id=$1`, receipt.ID).Scan(&member, &kind, &state, &payload))
	assert.Equal(t, []any{ben, "review_merge", "pending"}, []any{member, kind, state})
	var stored struct {
		Card struct {
			AskedBy map[string]any `json:"asked_by"`
			Review  struct {
				Evidence struct {
					Items []map[string]any `json:"items"`
				} `json:"evidence"`
			} `json:"review"`
		} `json:"card"`
	}
	require.NoError(t, json.Unmarshal(payload, &stored))
	assert.Equal(t, "ben", stored.Card.AskedBy["for_member"].(map[string]any)["login"], "the card names the member who asked")
	assert.Contains(t, stored.Card.Review.Evidence.Items, map[string]any{"kind": "github_check", "name": "unit", "required": true, "state": "passed",
		"url": "https://github.com/rehearsal-owner/app/pull/1/checks"})
	assert.Empty(t, h.merges(), "requesting the card never merges")
	assert.Nil(t, mythicalChecksOf(h.item(t1)).Land, "requesting the card records no approval")
}
