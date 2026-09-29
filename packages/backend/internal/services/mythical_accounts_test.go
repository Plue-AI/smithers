package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TestMythicalLaneAccountsOnProductSchema records pooled model calls against
// lane workspaces (migration 0029) and reads them back through the snapshot:
// each busy lane's start, the account of its latest call, how many accounts
// served it, and its seat.
func TestMythicalLaneAccountsOnProductSchema(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('lane-owner', 'lane-owner') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'smithers', 'smithers') RETURNING id`, userID).Scan(&repoID))
	_, err := q.RequestMythicalBootstrap(ctx, repoID, userID, 100, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state = 'active', max_parallel = 2 WHERE repository_id = $1`, repoID)
	require.NoError(t, err)

	workspace := func() string {
		var id string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id) VALUES ($1, $2) RETURNING id::text`, repoID, userID).Scan(&id))
		return id
	}
	ws1, ws2, ws3, ws4 := workspace(), workspace(), workspace(), workspace()
	connection := func(provider, label, email string) string {
		kind := "api_key"
		if provider == "codex" {
			kind = "oauth"
		}
		var id string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO provider_connections (owner_type, user_id, provider, kind, label, account_email, access_token_encrypted)
			VALUES ('user', $1, $2, $5, $3, $4, 'sk-ant-api03-never-shown'::bytea) RETURNING id::text`, userID, provider, label, email, kind).Scan(&id))
		return id
	}
	browser := connection("claude", "web-3f1c", "")
	work := connection("claude", "Work", "work@example.com")
	codex := connection("codex", "codex", "codex@example.com")

	started := time.Now().Add(-7 * time.Minute).UTC().Truncate(time.Second)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items (repository_id, issue_number, issue_title, state, attempt, lane, workspace_id, lane_started_at) VALUES
		($1, 1, 'One', 'running', 1, 0, $2, $4),
		($1, 2, 'Two', 'verifying', 1, 3, $3, NULL),
		($1, 3, 'Three', 'blocked', 3, 1, $5, NOW()),
		($1, 4, 'Four', 'retrying', 1, 2, $6, NOW())`, repoID, ws1, ws2, started, ws3, ws4)
	require.NoError(t, err)

	// ws1's calls rotate across two Claude accounts: most ran on opus, the
	// latest (a background call) on another model and account.
	for range 3 {
		require.NoError(t, q.RecordWorkspaceProviderUse(ctx, ws1, browser, "claude-opus-5-5"))
	}
	require.NoError(t, q.RecordWorkspaceProviderUse(ctx, ws1, work, "claude-haiku-4-5"))
	require.NoError(t, q.RecordWorkspaceProviderUse(ctx, ws2, codex, "gpt-6-luna"))
	require.NoError(t, q.RecordWorkspaceProviderUse(ctx, ws3, codex, "gpt-6-sol"))
	require.NoError(t, q.RecordWorkspaceProviderUse(ctx, ws4, codex, "gpt-6-sol"))

	service := NewMythicalService(pool, nil)
	owner := MythicalViewer{UserID: userID}
	view, err := service.Snapshot(ctx, repoID, "o/smithers", "", owner)
	require.NoError(t, err)
	require.Len(t, view.Lanes, 4, "lanes 0 and 1 of the limit, and lanes 2 and 3 above it that still hold items")
	lane0, lane1, lane2, lane3 := view.Lanes[0], view.Lanes[1], view.Lanes[2], view.Lanes[3]
	assert.Equal(t, "busy", lane0.State)
	assert.Equal(t, started.Format(time.RFC3339), lane0.StartedAt)
	require.NotNil(t, lane0.Account)
	assert.Equal(t, MythicalAccountView{Provider: "claude", Label: "work@example.com", Count: 2}, *lane0.Account, "the latest call's account, and how many served the lane")
	assert.Equal(t, "opus", lane0.Seat, "the seat most calls ran on, not a background call's model")
	assert.Equal(t, MythicalLaneView{Index: 1, State: "idle"}, lane1, "a settled item's lane is idle and shows no account")
	assert.Equal(t, "busy", lane2.State)
	assert.Empty(t, lane2.StartedAt, "a retrying item's failed attempt is not what the lane runs now")
	assert.Nil(t, lane2.Account)
	assert.Empty(t, lane2.Seat)
	assert.EqualValues(t, 3, lane3.Index)
	assert.Empty(t, lane3.StartedAt, "an attempt launched before the start was recorded shows none")
	require.NotNil(t, lane3.Account)
	assert.Equal(t, MythicalAccountView{Provider: "codex", Label: "codex@example.com", Count: 1}, *lane3.Account)
	assert.Equal(t, "luna", lane3.Seat)

	// Anyone else, a repository admin or a public reader, sees the provider
	// and seat, never whose account it is.
	for _, viewer := range []MythicalViewer{{}, {UserID: userID + 1000, Admin: true}} {
		other, err := service.Snapshot(ctx, repoID, "o/smithers", "", viewer)
		require.NoError(t, err)
		assert.Equal(t, MythicalAccountView{Provider: "claude", Count: 2}, *other.Lanes[0].Account)
		encoded, err := json.Marshal(other)
		require.NoError(t, err)
		assert.NotContains(t, string(encoded), "example.com")
		assert.NotContains(t, string(encoded), "sk-ant")
	}

	// The pool moves ws1 back to the browser-connected account: it is the
	// latest now, and its internal request label is not shown as a name.
	require.NoError(t, q.RecordWorkspaceProviderUse(ctx, ws1, browser, ""))
	view, err = service.Snapshot(ctx, repoID, "o/smithers", "", owner)
	require.NoError(t, err)
	assert.Equal(t, MythicalAccountView{Provider: "claude", Count: 2}, *view.Lanes[0].Account)
	assert.Equal(t, "opus", view.Lanes[0].Seat, "a call naming no model does not change the seat")
	encoded, err := json.Marshal(view)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "web-3f1c")

	// An unknown model is shown as itself, never as a guessed alias.
	for range 2 {
		require.NoError(t, q.RecordWorkspaceProviderUse(ctx, ws2, codex, "gpt-7-nova"))
	}
	view, err = service.Snapshot(ctx, repoID, "o/smithers", "", owner)
	require.NoError(t, err)
	assert.Equal(t, "gpt-7-nova", view.Lanes[3].Seat)

	// A deleted workspace or a disconnected account takes its records with it.
	_, err = pool.Exec(ctx, `DELETE FROM workspaces WHERE id = $1`, ws2)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM provider_connections WHERE id = $1`, work)
	require.NoError(t, err)
	uses, err := q.ListLatestWorkspaceProviderUses(ctx, []string{ws1, ws2})
	require.NoError(t, err)
	require.Len(t, uses, 1)
	assert.Equal(t, ws1, uses[0].WorkspaceID)
	assert.EqualValues(t, 1, uses[0].Accounts)
}

func TestMythicalViewerOwnsOnlyItsAccounts(t *testing.T) {
	user := db.WorkspaceProviderUse{OwnerType: "user", OwnerUserID: 7}
	org := db.WorkspaceProviderUse{OwnerType: "org"}
	assert.True(t, MythicalViewer{UserID: 7}.owns(user))
	assert.False(t, MythicalViewer{UserID: 8, Admin: true}.owns(user))
	assert.False(t, MythicalViewer{}.owns(db.WorkspaceProviderUse{OwnerType: "user"}))
	assert.True(t, MythicalViewer{UserID: 8, Admin: true}.owns(org))
	assert.False(t, MythicalViewer{UserID: 8}.owns(org))
}
