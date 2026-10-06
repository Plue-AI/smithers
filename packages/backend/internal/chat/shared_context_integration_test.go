package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

// Exercise the real conversation HTTP projection and PostgreSQL journal. The
// producer is a literal fixture; this does not qualify packaged-host selection.
func TestSharedConversationRetainsSelectedContext(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	userID, err := seed.CreateUser(ctx, pool, "context-ben")
	require.NoError(t, err)
	q := db.New(pool)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: userID, Valid: true}, Name: "context", LowerName: "context", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, userID)
	require.NoError(t, err)
	setting, _ := json.Marshal(map[string]any{"owner_login": "context-ben", "repository_name": "context", "repository_id": repo.ID})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: setting}))
	store, err := NewStore(pool)
	require.NoError(t, err)
	scope := Scope{RepositoryID: repo.ID, UserID: userID, Owner: "context-ben"}
	journal := testJournal()
	request := json.RawMessage(`{"runId":"context-run","conversationId":"main","sharedConversation":true,"instructions":"Answer","messages":[{"role":"user","content":"Where do we retry?"}]}`)
	admitted, err := store.Admit(ctx, AdmitInput{Scope: scope, RunID: "context-run", Journal: journal, Request: request})
	require.NoError(t, err)
	grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
	require.NoError(t, err)
	selected := strings.Replace(literalPreflight, `"runId":"run"`, `"runId":"context-run"`, 1)
	// Unknown producer data must not cross the shared selection projection.
	selected = strings.Replace(selected, `"reason":"Retry code"`, `"reason":"Retry code","private":"canary-B"`, 1)
	selected = strings.Replace(selected, `"type":"context.preflight"`, `"type":"context.preflight","phase":"completed"`, 1)
	selected = strings.Replace(selected, `"candidates":[`, `"candidates":[{"kind":"file","label":"canary-C","ref":"private"},`, 1)
	started := strings.Replace(selected, `"phase":"completed"`, `"phase":"started"`, 1)
	started = strings.Replace(started, `"reason":"Retry code"`, `"reason":"canary-D"`, 1)
	_, err = store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{json.RawMessage(started), json.RawMessage(selected), frame("context-run", "Retries three times"), done("context-run", "stop")}})
	require.NoError(t, err)
	handler := &Handler{Store: store, ResolveBranch: func(context.Context, Scope, string) (string, error) { return "main", nil }}
	server := httptest.NewServer(authenticatedRoutes(handler, userID, "context-ben"))
	defer server.Close()
	for range 2 { // A second client read restores exactly the stored selection.
		response, err := server.Client().Get(server.URL + "/api/conversations/main")
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, response.StatusCode)
		var body SharedConversation
		require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
		response.Body.Close()
		require.Len(t, body.Entries, 1)
		require.NotNil(t, body.Entries[0].Context)
		require.Len(t, *body.Entries[0].Context, 1)
		require.JSONEq(t, `{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123","reason":"Retry code"}`, string((*body.Entries[0].Context)[0]))
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		require.NotContains(t, string(raw), "canary-B")
		require.NotContains(t, string(raw), "canary-C")
		require.NotContains(t, string(raw), "canary-D")
		require.NotContains(t, string(raw), "owner-fast")
		require.Len(t, body.Entries[0].Frames, 2)
	}
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, userID)
	require.NoError(t, err)
	response, err := server.Client().Get(server.URL + "/api/conversations/main")
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusForbidden, response.StatusCode)
}

func TestSharedConversationAssemblesPreflightAcrossReplayPages(t *testing.T) {
	f := newContextFixture(t)
	grant := f.admit(t, "paged", "Read the catalog", true, true, false)
	for i := 0; i < 20; i++ {
		raw, err := json.Marshal(map[string]any{"runId": grant.RunID, "type": "context.preflight", "phase": "completed",
			"page": map[string]int{"index": i, "total": 20}, "result": map[string]any{"model": "fast", "durationMs": 12, "candidates": []any{},
				"context": []any{map[string]any{"kind": "todo", "label": "TODO", "ref": fmt.Sprintf("T%d", i), "reason": "Selected", "private": "canary"}}}})
		require.NoError(t, err)
		ack, err := f.handler.Store.Commit(t.Context(), CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{raw}})
		require.NoError(t, err)
		grant.Cursor = ack.Cursor
		if i == 18 {
			shared, err := f.handler.Store.SharedEntries(t.Context(), f.scope, "main")
			require.NoError(t, err)
			require.Nil(t, shared.Entries[0].Context, "19 valid pages are not a completed selection")
		}
	}
	_, err := f.handler.Store.Commit(t.Context(), CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{done(grant.RunID, "stop")}})
	require.NoError(t, err)
	cold, err := NewStore(f.handler.Store.pool)
	require.NoError(t, err)
	for range 2 {
		shared, err := cold.SharedEntries(t.Context(), f.scope, "main")
		require.NoError(t, err)
		require.Len(t, *shared.Entries[0].Context, 20)
		for i, raw := range *shared.Entries[0].Context {
			require.JSONEq(t, fmt.Sprintf(`{"kind":"todo","label":"TODO","ref":"T%d","reason":"Selected"}`, i), string(raw))
		}
		raw, err := json.Marshal(shared)
		require.NoError(t, err)
		require.NotContains(t, string(raw), "canary")
	}
}
