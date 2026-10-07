package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

// A committed UI request reaches only its author's view state, as its command
// and payload; the shared conversation carries neither.
func TestUIInstructionsReachOnlyTheirAuthorsView(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	ben, err := seed.CreateUser(ctx, pool, "ui-ben")
	require.NoError(t, err)
	alice, err := seed.CreateUser(ctx, pool, "ui-alice")
	require.NoError(t, err)
	q := db.New(pool)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: ben, Valid: true}, Name: "ui", LowerName: "ui", DefaultBookmark: "main"})
	require.NoError(t, err)
	for _, user := range []int64{ben, alice} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, user)
		require.NoError(t, err)
	}
	setting, _ := json.Marshal(map[string]any{"owner_login": "ui-ben", "repository_name": "ui", "repository_id": repo.ID})
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: setting}))
	store, err := NewStore(pool)
	require.NoError(t, err)
	scope := Scope{RepositoryID: repo.ID, UserID: ben, Owner: "ui-ben"}
	request := json.RawMessage(`{"runId":"ui-run","conversationId":"main","sharedConversation":true,"instructions":"Answer","messages":[{"role":"user","content":"Dismiss the run card and go dark"}]}`)
	admitted, err := store.Admit(ctx, AdmitInput{Scope: scope, RunID: "ui-run", Journal: testJournal(), Request: request})
	require.NoError(t, err)
	grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
	require.NoError(t, err)
	_, err = store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{
		json.RawMessage(`{"runId":"ui-run","type":"call.settled","link":0,"ordinal":0,"name":"card.dismiss","verdict":"run","ui":{"command":"card.dismiss","cardId":"card-7"}}`),
		json.RawMessage(`{"runId":"ui-run","type":"call.settled","link":0,"ordinal":1,"name":"theme","verdict":"run","ui":{"command":"theme","mode":"dark"}}`),
		frame("ui-run", "Done"), done("ui-run", "stop"),
	}})
	require.NoError(t, err)
	read := func(user int64, login, path string) string {
		handler := &Handler{Store: store, ResolveBranch: func(context.Context, Scope, string) (string, error) { return "main", nil }}
		server := httptest.NewServer(authenticatedRoutes(handler, user, login))
		defer server.Close()
		response, err := server.Client().Get(server.URL + path)
		require.NoError(t, err)
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, response.StatusCode, string(body))
		return string(body)
	}
	var view struct {
		Instructions []json.RawMessage `json:"instructions"`
	}
	require.NoError(t, json.Unmarshal([]byte(read(ben, "ui-ben", "/api/conversations/main/view-state")), &view))
	require.Len(t, view.Instructions, 2)
	require.JSONEq(t, `{"id":"`+admitted.TurnID+`:1:0","command":"card.dismiss","payload":{"cardId":"card-7"}}`, string(view.Instructions[0]))
	require.JSONEq(t, `{"id":"`+admitted.TurnID+`:1:1","command":"theme","payload":{"mode":"dark"}}`, string(view.Instructions[1]))
	require.NotContains(t, read(alice, "ui-alice", "/api/conversations/main/view-state"), `"instructions"`)
	shared := read(alice, "ui-alice", "/api/conversations/main")
	require.Contains(t, shared, "Done")
	require.NotContains(t, shared, `"ui"`)
	require.NotContains(t, shared, "card-7")
}
