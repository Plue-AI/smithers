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
	selected = strings.Replace(selected, `"candidates":[`, `"candidates":[{"kind":"todo","label":"T1","ref":"T1","text":"canary-C"},`, 1)
	selected = strings.Replace(selected, `"candidates":[`, `"candidates":[{"kind":"file","label":"unbound-candidate-canary","ref":"private"},`, 1)
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
		require.Equal(t, "Where do we retry?", body.Entries[0].Title)
		require.Equal(t, "done", body.Entries[0].Tone)
		require.NotNil(t, body.Entries[0].Context)
		require.Len(t, *body.Entries[0].Context, 1)
		require.JSONEq(t, `{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123","reason":"Retry code"}`, string((*body.Entries[0].Context)[0]))
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		require.NotContains(t, string(raw), "canary-B")
		require.NotContains(t, string(raw), "canary-C")
		require.NotContains(t, string(raw), "unbound-candidate-canary")
		require.NotContains(t, string(raw), "canary-D")
		require.NotNil(t, body.Entries[0].Preflight)
		require.Equal(t, "owner-fast", body.Entries[0].Preflight.Model)
		require.Equal(t, float64(12), body.Entries[0].Preflight.DurationMs)
		require.Len(t, body.Entries[0].Preflight.Candidates, 2)
		require.JSONEq(t, `{"kind":"todo","label":"T1","ref":"T1"}`, string(body.Entries[0].Preflight.Candidates[0]))
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
			require.Nil(t, shared.Entries[0].Preflight)
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
		require.Len(t, shared.Entries[0].Preflight.Context, 20)
		require.Empty(t, shared.Entries[0].Preflight.Candidates)
		for i, raw := range *shared.Entries[0].Context {
			require.JSONEq(t, fmt.Sprintf(`{"kind":"todo","label":"TODO","ref":"T%d","reason":"Selected"}`, i), string(raw))
		}
		raw, err := json.Marshal(shared)
		require.NoError(t, err)
		require.NotContains(t, string(raw), "canary")
		require.Contains(t, string(raw), `"candidates":[]`)
	}
}

func TestSharedConversationIndependentToastPreferences(t *testing.T) {
	f := newContextFixture(t)
	// The same authenticated HTTP door writes both preferences, independently.
	server := httptest.NewServer(authenticatedRoutes(f.handler, f.scope.UserID, f.scope.Owner))
	defer server.Close()
	write := func(body string) map[string]any {
		req, err := http.NewRequest(http.MethodPut, server.URL+"/api/conversations/main/view-state", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, http.StatusOK, response.StatusCode)
		var view map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&view))
		return view
	}
	view := write(`{"toasts_hidden":true,"global_toasts_hidden":false}`)
	require.Equal(t, true, view["toasts_hidden"])
	require.Equal(t, false, view["global_toasts_hidden"])
	view = write(`{"toasts_hidden":false,"global_toasts_hidden":true}`)
	require.Equal(t, false, view["toasts_hidden"])
	require.Equal(t, true, view["global_toasts_hidden"])
	raw, err := f.handler.Store.ReadMemberViewState(t.Context(), f.scope.UserID, "another-branch")
	require.NoError(t, err)
	require.JSONEq(t, `{"global_toasts_hidden":true}`, string(raw))
}

func TestSharedConversationCardCursorRetainsFirstJournalPosition(t *testing.T) {
	f := newContextFixture(t)
	grant := f.admit(t, "card-cursor", "Read files", true, true, false)
	card := json.RawMessage(`{"runId":"card-cursor","type":"card","card":{"id":"new-card","kind":"file","title":"retry.ts","status":"active","payload":{"repo":"smithersai/smithers","path":"retry.ts","content":"retry","truncated":false},"createdAt":0,"ordinal":0}}`)
	hidden := json.RawMessage(`{"runId":"card-cursor","type":"card","card":{"id":"private-confirm","kind":"confirmation","title":"Private"}}`)
	ack, err := f.handler.Store.Commit(t.Context(), CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{frame(grant.RunID, "Answer"), card, hidden}})
	require.NoError(t, err)
	read := func() SharedConversation {
		response, e := f.server.Client().Get(f.server.URL + "/api/conversations/main")
		require.NoError(t, e)
		defer response.Body.Close()
		require.Equal(t, 200, response.StatusCode)
		var shared SharedConversation
		require.NoError(t, json.NewDecoder(response.Body).Decode(&shared))
		return shared
	}
	first := read()
	require.Len(t, first.Entries, 1)
	require.Equal(t, int64(1_000_004), first.Entries[0].EntrySequences["new-card"])
	require.NotContains(t, first.Entries[0].EntrySequences, "private-confirm")
	// An update of the same card is not a new entry. Recovery rereads the
	// first sealed position, independent of the latest row's source revision.
	_, err = f.handler.Store.Commit(t.Context(), CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: ack.Cursor, Frames: []json.RawMessage{card, done(grant.RunID, "stop")}})
	require.NoError(t, err)
	cold, err := NewStore(f.handler.Store.pool)
	require.NoError(t, err)
	f.handler.Store = cold
	restored := read()
	require.Equal(t, int64(1_000_004), restored.Entries[0].EntrySequences["new-card"])
	require.Equal(t, int64(1_000_001), restored.Entries[0].EntrySequences[grant.TurnID+":answer"])
}
