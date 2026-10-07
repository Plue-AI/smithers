package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
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
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: host, Workspace: runtime, BranchMachines: &providers, FlowHostProductAPIURL: "http://127.0.0.1:4000", FlowHostConfig: flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true}}))
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
	for _, path := range []string{"/api/agent/turn/cancel", "/api/agent/turn/retire", "/api/chat/turn", "/api/chat/cancel"} {
		call("POST", path, `{"runId":"retired","messages":[],"instructions":"never"}`, benCookie, 404)
	}
	call("POST", chat.TurnPath, `{"runId":"retired","messages":[],"instructions":"never"}`, benCookie, 400)
	var retiredWrites int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&retiredWrites))
	require.Zero(t, retiredWrites)
	admit := func(name string) (string, string) {
		payload, err := json.Marshal(map[string]string{"prompt": "original", "idempotencyKey": name})
		require.NoError(t, err)
		// The response is complete while the model host is deliberately held.
		raw := call("POST", "/api/conversations/main/prompt", string(payload), benCookie, 202)
		var accepted struct {
			RunID  string `json:"runId"`
			TurnID string `json:"turnId"`
			LegID  string `json:"legId"`
		}
		require.NoError(t, json.Unmarshal([]byte(raw), &accepted))
		require.NotEmpty(t, accepted.TurnID)
		require.Contains(t, raw, `"status":"accepted"`)
		// Public identities must not reveal the legacy journal capability.
		call("POST", chat.ReplayPath, fmt.Sprintf(`{"runId":%q,"journal":{"version":1,"legId":%q,"token":%q}}`, accepted.RunID, accepted.LegID, strings.TrimPrefix(accepted.RunID, "prompt-")), benCookie, 403)

		duplicate := call("POST", "/api/conversations/main/prompt", string(payload), benCookie, 202)
		require.Contains(t, duplicate, `"status":"existing"`)
		require.Contains(t, duplicate, accepted.TurnID)
		call("POST", "/api/conversations/main/prompt", fmt.Sprintf(`{"prompt":"different","idempotencyKey":%q}`, name), benCookie, 409)
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE run_id=$1`, accepted.RunID).Scan(&count))
		require.Equal(t, 1, count)
		return accepted.RunID, accepted.TurnID
	}
	call("POST", "/api/conversations/main/prompt", `{"prompt":" ","idempotencyKey":"bad"}`, benCookie, 400)
	call("POST", "/api/conversations/main/prompt", `{"prompt":"hello","idempotencyKey":"bad","instructions":"browser canary"}`, benCookie, 400)
	call("POST", "/api/conversations/main/prompt", `{"prompt":"hello"}`, benCookie, 400)
	call("POST", chat.TurnPath, `{"runId":"forged-shared","conversationId":"main","sharedConversation":true,"instructions":"private","messages":[{"role":"user","content":"private legacy canary"}],"journal":{"version":1,"legId":"forged-shared-leg","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`, benCookie, 400)

	// Unknown branches and another repository's UUID never admit a turn.
	call("POST", "/api/conversations/missing/prompt", `{"prompt":"unknown","idempotencyKey":"unknown"}`, benCookie, 404)
	otherRepo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
	require.NoError(t, err)
	foreignBranch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: otherRepo.ID, UserID: ben.ID, Name: "foreign", TargetBookmark: "foreign", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	call("POST", "/api/conversations/"+foreignBranch.ID+"/prompt", `{"prompt":"foreign","idempotencyKey":"foreign"}`, benCookie, 404)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: ben.ID, Name: "feature", TargetBookmark: "scratch/ben/feature", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	for _, reference := range []string{"scratch%2Fben%2Ffeature", branch.ID} {
		call("POST", "/api/conversations/"+reference+"/prompt", `{"prompt":"denied","idempotencyKey":"denied"}`, aliceCookie, 403)
		call("GET", "/api/conversations/"+reference+"/view-state", "", aliceCookie, 403)
	}
	var aliasPrompt struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal([]byte(call("POST", "/api/conversations/scratch%2Fben%2Ffeature/prompt", `{"prompt":"alias","idempotencyKey":"alias"}`, benCookie, 202)), &aliasPrompt))
	require.Contains(t, call("POST", "/api/conversations/"+branch.ID+"/prompt", `{"prompt":"alias","idempotencyKey":"alias"}`, benCookie, 202), aliasPrompt.TurnID)
	var canonicalBranch string
	require.NoError(t, pool.QueryRow(ctx, `SELECT conversation_id FROM chat_turns WHERE id=$1`, aliasPrompt.TurnID).Scan(&canonicalBranch))
	require.Equal(t, branch.ID, canonicalBranch)
	require.Contains(t, call("GET", "/api/conversations/scratch%2Fben%2Ffeature/view-state", "", benCookie, 200), "toasts_hidden")
	select {
	case grant := <-host.started:
		require.Equal(t, aliasPrompt.TurnID, grant.TurnID)
	case <-time.After(5 * time.Second):
		t.Fatal("branch alias turn did not start")
	}
	var aliasQueued struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal([]byte(call("POST", "/api/conversations/scratch%2Fben%2Ffeature/prompt", `{"prompt":"alias queued canary","idempotencyKey":"alias-queued"}`, benCookie, 202)), &aliasQueued))
	require.Contains(t, call("GET", "/api/conversations/scratch%2Fben%2Ffeature/view-state", "", benCookie, 200), "alias queued canary")
	require.Contains(t, call("GET", "/api/conversations/"+branch.ID+"/view-state", "", benCookie, 200), aliasQueued.TurnID)
	call("DELETE", "/api/conversations/"+branch.ID+"/turns/"+aliasQueued.TurnID, "", benCookie, 200)
	require.NotContains(t, call("GET", "/api/conversations/scratch%2Fben%2Ffeature/view-state", "", benCookie, 200), "alias queued canary")
	call("POST", "/api/conversations/scratch%2Fben%2Ffeature/turns/"+aliasPrompt.TurnID+"/stop", "", benCookie, 200)
	select {
	case <-host.stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("branch alias stop did not reach its host")
	}
	first, firstID := admit("held")
	var firstGrant ports.ChatTurnGrant
	select {
	case grant := <-host.started:
		require.Equal(t, first, grant.RunID)
		firstGrant = grant
	case <-time.After(5 * time.Second):
		t.Fatal("first turn did not start")
	}
	frames := fmt.Sprintf(`[{"runId":%q,"type":"delta","kind":"text","text":"Shared answer"},{"runId":%q,"type":"delta","kind":"reasoning","text":"private reasoning canary"},{"runId":%q,"type":"card","card":{"kind":"approval","payload":{"secret":"private Confirm canary"}}},{"runId":%q,"type":"card","card":{"kind":"todo-draft","payload":{"prompt":"private Draft canary"}}},{"runId":%q,"type":"call.settled","link":0,"ordinal":0,"name":"theme","verdict":"run","ui":{"command":"theme","mode":"dark"}}]`, first, first, first, first, first)
	cursorJSON, err := json.Marshal(firstGrant.Cursor)
	require.NoError(t, err)
	producerRequest, err := http.NewRequest("POST", firstGrant.ProducerBaseURL+chat.CommitPath, strings.NewReader(fmt.Sprintf(`{"turnId":%q,"generation":%d,"expected":%s,"frames":%s}`, firstGrant.TurnID, firstGrant.Generation, cursorJSON, frames)))
	require.NoError(t, err)
	producerRequest.Header.Set("Authorization", "Bearer "+firstGrant.Token)
	producerRequest.Header.Set("Content-Type", "application/json")
	producerResponse, err := http.DefaultClient.Do(producerRequest)
	require.NoError(t, err)
	producerBody, err := io.ReadAll(producerResponse.Body)
	producerResponse.Body.Close()
	require.NoError(t, err)
	require.Equal(t, 200, producerResponse.StatusCode, string(producerBody))
	shared := call("GET", "/api/conversations/main", "", benCookie, 200)
	require.JSONEq(t, shared, call("GET", "/api/conversations/main", "", aliceCookie, 200))
	require.Contains(t, shared, firstID)
	require.Contains(t, shared, "Shared answer")
	require.NotContains(t, shared, `"ui"`)
	require.NotContains(t, call("GET", "/api/conversations/main/view-state", "", aliceCookie, 200), `"instructions"`)
	require.Contains(t, call("GET", "/api/conversations/main/view-state", "", benCookie, 200), `"command":"theme","payload":{"mode":"dark"}`)
	call("PUT", "/api/conversations/main/view-state", `{"instructions":[{"id":"forged","command":"theme","mode":"dark"}]}`, benCookie, 400)
	require.NotContains(t, shared, "private reasoning canary")
	require.NotContains(t, shared, "private Confirm canary")
	require.NotContains(t, shared, "private Draft canary")
	require.NotContains(t, shared, aliasPrompt.TurnID)
	require.JSONEq(t, `{"status":"ok","conversations":[],"next":null}`, call("GET", chat.HistoryPath, "", benCookie, 200))
	call("POST", chat.AccountReplayPath, fmt.Sprintf(`{"runId":%q,"legId":%q}`, first, firstGrant.LegID), benCookie, 403)
	var eraseProof string
	require.NoError(t, pool.QueryRow(ctx, `SELECT access_hash FROM chat_turns WHERE id=$1`, firstID).Scan(&eraseProof))
	call("POST", chat.ErasePath, fmt.Sprintf(`{"runId":%q,"legId":%q,"retirementProof":%q}`, first, firstGrant.LegID, eraseProof), benCookie, 403)
	require.JSONEq(t, shared, call("GET", "/api/conversations/main", "", aliceCookie, 200))
	require.NotContains(t, shared, "instructions")
	require.NotContains(t, shared, "token")
	require.Contains(t, shared, `"author":`)
	call("GET", "/api/conversations/missing", "", benCookie, 404)
	call("GET", "/api/conversations/"+foreignBranch.ID, "", benCookie, 404)
	call("GET", "/api/conversations/"+branch.ID, "", aliceCookie, 403)
	// Concurrent retries serialize through the production journal, while the
	// first model execution remains unresolved.
	type retryAnswer struct {
		status int
		body   string
		err    error
	}
	answers := make(chan retryAnswer, 8)
	for range 8 {
		req, err := http.NewRequest("POST", server.URL+"/api/conversations/main/prompt", strings.NewReader(`{"prompt":"concurrent","idempotencyKey":"concurrent"}`))
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: benCookie})
		go func() {
			res, err := server.Client().Do(req)
			if err != nil {
				answers <- retryAnswer{err: err}
				return
			}
			defer res.Body.Close()
			raw, err := io.ReadAll(res.Body)
			answers <- retryAnswer{status: res.StatusCode, body: string(raw), err: err}
		}()
	}
	concurrentID := ""
	acceptedCount := 0
	for range 8 {
		select {
		case answer := <-answers:
			require.NoError(t, answer.err)
			require.Equal(t, 202, answer.status, answer.body)
			var result struct {
				TurnID string `json:"turnId"`
				Status string `json:"status"`
			}
			require.NoError(t, json.Unmarshal([]byte(answer.body), &result))
			if concurrentID == "" {
				concurrentID = result.TurnID
			}
			require.Equal(t, concurrentID, result.TurnID)
			if result.Status == "accepted" {
				acceptedCount++
			}
		case <-time.After(5 * time.Second):
			t.Fatal("admission waited for the held model")
		}
	}
	require.Equal(t, 1, acceptedCount)
	call("DELETE", "/api/conversations/main/turns/"+concurrentID, "", benCookie, 200)
	edited, editedID := admit("edited")
	_, removedID := admit("removed")
	shared = call("GET", "/api/conversations/main", "", aliceCookie, 200)
	require.NotContains(t, shared, editedID)
	require.NotContains(t, shared, removedID)
	require.JSONEq(t, shared, call("GET", "/api/conversations/main", "", benCookie, 200))
	foreign := call("POST", "/api/conversations/main/prompt", `{"prompt":"Alice question","idempotencyKey":"edited"}`, aliceCookie, 202)
	require.NotContains(t, foreign, editedID, "idempotency keys are scoped to the caller")
	var alicePrompt struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal([]byte(foreign), &alicePrompt))
	call("DELETE", "/api/conversations/main/turns/"+alicePrompt.TurnID, "", aliceCookie, 200)
	// A second credential for the same person has its own key namespace.
	secondCookie := "ben-second-cookie"
	secondHash := sha256.Sum256([]byte(secondCookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: ben.ID, Username: ben.Username, SessionKey: hex.EncodeToString(secondHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	var secondQueued struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal([]byte(call("POST", "/api/conversations/main/prompt", `{"prompt":"original","idempotencyKey":"edited"}`, secondCookie, 202)), &secondQueued))
	require.NotEqual(t, editedID, secondQueued.TurnID)
	call("DELETE", "/api/conversations/main/turns/"+secondQueued.TurnID, "", secondCookie, 200)
	rawAgentToken := "smithers_" + strings.Repeat("a", 40)
	agentHash := sha256.Sum256([]byte(rawAgentToken))
	agentDigest := hex.EncodeToString(agentHash[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: ben.ID, Name: "queue-agent-refusal", TokenHash: agentDigest, TokenLastEight: agentDigest[len(agentDigest)-8:], SystemIssued: true, Scopes: "repo,user,agent,via:smithers,terminal-session:" + liveAppTurnCredentialFixture(t, pool, ben.ID) + "/1", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	agentRequest, err := http.NewRequest("POST", server.URL+"/api/conversations/main/prompt", strings.NewReader(`{"prompt":"agent cannot queue","idempotencyKey":"agent"}`))
	require.NoError(t, err)
	agentRequest.Host = "127.0.0.1:4000"
	agentRequest.Header.Set("Authorization", "Bearer "+rawAgentToken)
	agentRequest.Header.Set("Content-Type", "application/json")
	agentResponse, err := server.Client().Do(agentRequest)
	require.NoError(t, err)
	agentBody, err := io.ReadAll(agentResponse.Body)
	agentResponse.Body.Close()
	require.NoError(t, err)
	require.Equal(t, 403, agentResponse.StatusCode, string(agentBody))
	var stored string
	require.NoError(t, pool.QueryRow(ctx, `SELECT request_payload::text FROM chat_turns WHERE id=$1`, editedID).Scan(&stored))
	require.NotContains(t, stored, "browser canary")
	require.Contains(t, stored, "Smithers for the prompt author")
	require.Contains(t, stored, `"sharedConversation": true`)

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
	privateView := call("GET", "/api/conversations/main/view-state", "", benCookie, 200)
	require.Contains(t, privateView, "original")
	require.NotContains(t, privateView, "force rollback")
	call("PATCH", path(editedID), `{"prompt":"list changed tests"}`, benCookie, 200)
	// Queue recovery stays private; shared turns are not Earlier archives.
	var leg string
	require.NoError(t, pool.QueryRow(ctx, `SELECT leg_id FROM chat_turns WHERE id=$1`, editedID).Scan(&leg))
	call("POST", chat.AccountReplayPath, fmt.Sprintf(`{"runId":%q,"legId":%q}`, edited, leg), benCookie, 403)
	require.Contains(t, call("GET", "/api/conversations/main/view-state", "", benCookie, 200), "list changed tests")
	call("DELETE", path(removedID), "", benCookie, 200)
	call("DELETE", path(removedID), "", benCookie, 409)
	call("POST", path(firstID)+"/stop", "", benCookie, 200)
	call("POST", path(firstID)+"/stop", "", benCookie, 200)
	var terminalBatches int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turn_batches WHERE turn_id=$1 AND frames @> '[{"type":"done"}]'::jsonb`, firstID).Scan(&terminalBatches))
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
	shared = call("GET", "/api/conversations/main", "", aliceCookie, 200)
	var transcript chat.SharedConversation
	require.NoError(t, json.Unmarshal([]byte(shared), &transcript))
	require.Len(t, transcript.Entries, 2)
	require.Equal(t, firstID, transcript.Entries[0].ID)
	require.Equal(t, editedID, transcript.Entries[1].ID)
	require.Equal(t, "list changed tests", transcript.Entries[1].Prompt)
	for _, entry := range transcript.Entries {
		require.Contains(t, []string{"ben", "alice"}, entry.AuthorLogin)
	}
	require.JSONEq(t, shared, call("GET", "/api/conversations/main", "", benCookie, 200))
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
	call("POST", "/api/conversations/main/prompt", `{"prompt":"revoked","idempotencyKey":"revoked"}`, benCookie, 403)
	call("GET", "/api/conversations/main", "", benCookie, 403)
	call("PATCH", path(pendingID), `{"prompt":"revoked"}`, benCookie, 403)
	call("POST", path(holdID)+"/stop", "", benCookie, 403)
}
