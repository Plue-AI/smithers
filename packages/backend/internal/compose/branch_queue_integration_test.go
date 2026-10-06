package compose

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBranchConversationQueueMutationInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	user := func(login string) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		return u
	}
	owner, ben, alice := user("owner"), user("ben"), user("alice")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"owner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	for _, u := range []db.User{owner, ben, alice} {
		permission := "admin"
		if u.ID == alice.ID {
			permission = "write"
		}
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, u.ID, permission)
		require.NoError(t, err)
	}
	session := func(u db.User) string {
		key := u.Username + "-view-cookie"
		hash := sha256.Sum256([]byte(key))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return key
	}
	benCookie, aliceCookie := session(ben), session(alice)

	host := revokedAuthorHost{started: make(chan ports.ChatTurnGrant, 8), stopped: make(chan string, 8)}
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: host}))
	defer server.Close()
	request := func(method, path, body, cookie string) *http.Response {
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		return res
	}
	call := func(method, path, body, cookie string, expected int) string {
		res := request(method, path, body, cookie)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, expected, res.StatusCode, string(raw))
		return string(raw)
	}
	admit := func(name string) (string, string) {
		run := name + "-" + uuid.NewString()
		payload, err := json.Marshal(map[string]any{"runId": run, "conversationId": "main", "instructions": "Answer", "messages": []any{map[string]string{"role": "user", "content": "original"}}, "journal": map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("c", 48)}})
		require.NoError(t, err)
		res := request("POST", chat.TurnPath, string(payload), benCookie)
		defer res.Body.Close()
		require.Equal(t, 200, res.StatusCode)
		line, err := bufio.NewReader(res.Body).ReadString('\n')
		require.NoError(t, err)
		require.Contains(t, line, `"type":"accepted"`)
		var id string
		require.NoError(t, pool.QueryRow(ctx, `SELECT id FROM chat_turns WHERE run_id=$1`, run).Scan(&id))
		return run, id
	}
	first, firstID := admit("held")
	select {
	case grant := <-host.started:
		require.Equal(t, first, grant.RunID)
	case <-time.After(5 * time.Second):
		t.Fatal("first turn did not start")
	}
	edited, editedID := admit("edited")
	_, removedID := admit("removed")
	path := func(id string) string { return "/api/conversations/main/turns/" + id }
	require.Contains(t, call("PATCH", path(editedID), `{"prompt":"foreign"}`, aliceCookie, 403), `"permission"`)
	call("DELETE", path(removedID), "", aliceCookie, 403)
	call("POST", path(firstID)+"/stop", "", aliceCookie, 403)
	call("PATCH", path(firstID), `{"prompt":"running"}`, benCookie, 409)
	call("DELETE", path(firstID), "", benCookie, 409)
	call("PATCH", path(editedID), `{"prompt":" "}`, benCookie, 400)
	call("PATCH", path(editedID), `{"prompt":"changed","author":"alice"}`, benCookie, 400)
	call("PATCH", "/api/conversations/other/turns/"+editedID, `{"prompt":"wrong branch"}`, benCookie, 404)
	// A failure after the row update rolls its prompt and acceptance back together.
	_, err = pool.Exec(ctx, `CREATE FUNCTION refuse_queue_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.request_payload::text LIKE '%force rollback%' THEN RAISE EXCEPTION 'test write refusal'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_queue_edit BEFORE UPDATE ON chat_turns FOR EACH ROW EXECUTE FUNCTION refuse_queue_edit()`)
	require.NoError(t, err)
	call("PATCH", path(editedID), `{"prompt":"force rollback"}`, benCookie, 503)
	var retained string
	require.NoError(t, pool.QueryRow(ctx, `SELECT request_payload->'messages'->0->>'content' FROM chat_turns WHERE id=$1`, editedID).Scan(&retained))
	require.Equal(t, "original", retained)
	call("PATCH", path(editedID), `{"prompt":"list changed tests"}`, benCookie, 200)
	// Account recovery uses the same journal verifier after the acceptance was resealed.
	var leg string
	require.NoError(t, pool.QueryRow(ctx, `SELECT leg_id FROM chat_turns WHERE id=$1`, editedID).Scan(&leg))
	replay := call("POST", chat.AccountReplayPath, fmt.Sprintf(`{"runId":%q,"legId":%q}`, edited, leg), benCookie, 200)
	require.Contains(t, replay, "list changed tests")
	call("DELETE", path(removedID), "", benCookie, 200)
	call("DELETE", path(removedID), "", benCookie, 409)
	call("POST", path(firstID)+"/stop", "", benCookie, 200)
	call("POST", path(firstID)+"/stop", "", benCookie, 200)
	var terminalBatches int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turn_batches WHERE turn_id=$1`, firstID).Scan(&terminalBatches))
	require.Equal(t, 1, terminalBatches, "repeated stop must append only one terminal receipt")
	select {
	case run := <-host.stopped:
		require.Equal(t, first, run)
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not abort host")
	}
	select {
	case grant := <-host.started:
		require.Equal(t, edited, grant.RunID)
		require.Contains(t, string(grant.Request), "list changed tests")
		require.NotContains(t, string(grant.Request), "original")
	case <-time.After(5 * time.Second):
		t.Fatal("edited turn did not start")
	}
	var state string
	var leased bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT state,producer_token_hash IS NOT NULL OR producer_lease_expires_at IS NOT NULL FROM chat_turns WHERE id=$1`, removedID).Scan(&state, &leased))
	require.Equal(t, "cancelled", state)
	require.False(t, leased)
	call("POST", path(editedID)+"/stop", "", benCookie, 200)
	// Suspended authors cannot mutate a queued prompt even with an existing session.
	// Keep the dispatcher held so this prompt stays queued while suspension commits.
	_, holdID := admit("hold-again")
	select {
	case grant := <-host.started:
		require.Equal(t, holdID, grant.TurnID, "removed prompt must never start")
	case <-time.After(5 * time.Second):
		t.Fatal("hold did not start")
	}
	_, pendingID := admit("pending")
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, ben.ID)
	require.NoError(t, err)
	call("PATCH", path(pendingID), `{"prompt":"revoked"}`, benCookie, 403)
	call("POST", path(holdID)+"/stop", "", benCookie, 403)
}
