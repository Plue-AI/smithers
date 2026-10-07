package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The installed composition must supply the existing transactional consumer,
// not an approvals store with no executor. Requests create no TODO; only the
// member's authenticated Confirm press does, atomically and once.
func TestConfirmTodoConsumerInstall(t *testing.T) {
	testConfirmTodoConsumerInstall(t, "Keep the greeting", "Keep the exact greeting.")
}

// Literal flow-edit prompts cross the same installed TODO and confirmation
// doors. Diff bytes remain revision context; approval never applies a patch.
func TestConfirmFlowEditConsumerInstall(t *testing.T) {
	for _, tc := range []struct{ name, prompt, body string }{
		{"request", "Change flows/todo/flow.ts: Run tests; start from the built-in composition when no override exists", `{"request":"Run tests"}`},
		{"diff", "Change flows/todo/flow.ts: Run tests; start from the built-in composition when no override exists\n\nProposed diff (untrusted context):\n> diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n> +pnpm test\n> +```\n> +<script>untrusted</script>", `{"request":"Run tests","diff":"diff --git a/flows/todo/flow.ts b/flows/todo/flow.ts\n+pnpm test\n+\u0060\u0060\u0060\n+<script>untrusted</script>"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testConfirmTodoConsumerInstall(t, "Change the TODO flow: Run tests", tc.prompt, tc.body)
		})
	}
}

func testConfirmTodoConsumerInstall(t *testing.T, wantTitle, wantPrompt string, flowBody ...string) {
	t.Helper()
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	cookie := "scratch-diff-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)

	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya", DisplayName: "Maya"})
	require.NoError(t, err)
	otherCookie := "other-flow-edit-cookie"
	otherHash := sha256.Sum256([]byte(otherCookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: other.ID, Username: other.Username, SessionKey: hex.EncodeToString(otherHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, other.ID)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	token := "smithers_" + strings.Repeat("c", 40)
	tokenSum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(tokenSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "codex-confirm", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	handler := startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
	call := func(method, path, body, key string, delegated bool, cookies ...string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "http://127.0.0.1:4000"+path, strings.NewReader(body))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		request.Header.Set("Origin", "http://127.0.0.1:4000")
		request.Header.Set("X-CSRF-Token", "confirm-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "confirm-csrf"})
		if delegated {
			request.Header.Set("Authorization", "Bearer "+token)
		} else {
			session := cookie
			if len(cookies) > 0 {
				session = cookies[0]
			}
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	encoded, err := json.Marshal(map[string]any{"title": wantTitle, "prompt": wantPrompt, "acceptance": []string{"Greeting remains"}, "place": map[string]string{"mode": "append"}})
	require.NoError(t, err)
	input := string(encoded)
	endpoint := "/api/todos"
	if len(flowBody) > 0 {
		input, endpoint = flowBody[0], "/api/flows/todo/edit"
		refused := call("POST", "/api/flows/merge/edit", `{"request":"Change merge"}`, "builtin-edit", true)
		require.Equal(t, 409, refused.Code, refused.Body.String())
		require.Contains(t, refused.Body.String(), `"code":"flow_builtin"`)
	}
	var receipt services.ConfirmationReceipt
	for range 2 {
		response := call("POST", endpoint, input, "delegated-new", true)
		require.Equal(t, 202, response.Code, response.Body.String())
		var next services.ConfirmationReceipt
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &next))
		require.Equal(t, "pending", next.State)
		require.NotEmpty(t, next.ID)
		if receipt.ID != "" {
			require.Equal(t, receipt.ID, next.ID)
		}
		receipt = next
	}
	changed := call("POST", "/api/todos", `{"title":"Changed","prompt":"Apply a different patch"}`, "delegated-new", true)
	require.Equal(t, 409, changed.Code, changed.Body.String())
	require.Contains(t, changed.Body.String(), `"code":"idempotency_mismatch"`)
	expectedApprovals := 1
	if len(flowBody) > 0 {
		// A newly Active flow version invalidates the proposal before filing.
		_, err = q.InsertFlowVersion(ctx, repo.ID, "todo", "flows/todo/flow.ts", strings.Repeat("a", 40), strings.Repeat("b", 64), "loaded", "", []byte(`{"steps":[]}`))
		require.NoError(t, err)
		_, err = q.ActivateFlowVersion(ctx, repo.ID, "todo", strings.Repeat("b", 64))
		require.NoError(t, err)
		stale := call("POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "stale-flow-press", false)
		require.Equal(t, 409, stale.Code, stale.Body.String())
		var staleState string
		require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, receipt.ID).Scan(&staleState))
		require.Equal(t, "expired", staleState)
		fresh := call("POST", endpoint, input, "fresh-flow-edit", true)
		require.Equal(t, 202, fresh.Code, fresh.Body.String())
		require.NoError(t, json.Unmarshal(fresh.Body.Bytes(), &receipt))
		expectedApprovals = 2
	}
	var approvals int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&approvals))
	require.Equal(t, expectedApprovals, approvals)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE source='todo'`).Scan(&count))
	require.Zero(t, count)
	wrongMember := call("POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "other-press", false, otherCookie)
	require.Equal(t, 403, wrongMember.Code, wrongMember.Body.String())
	require.JSONEq(t, `{"class":"permission","code":"permission","message":"Not your confirmation"}`, wrongMember.Body.String())
	var pending string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, receipt.ID).Scan(&pending))
	require.Equal(t, "pending", pending)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE source='todo'`).Scan(&count))
	require.Zero(t, count)
	denied := call("POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "agent-press", true)
	require.Equal(t, 403, denied.Code, denied.Body.String())
	for range 2 {
		response := call("POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "person-press", false)
		require.Equal(t, 200, response.Code, response.Body.String())
		require.JSONEq(t, fmt.Sprintf(`{"id":"%s","state":"approved"}`, receipt.ID), response.Body.String())
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE source='todo'`).Scan(&count))
	require.Equal(t, 1, count)
	var title, prompt, state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title,revisions->0->>'text' FROM mythical_items WHERE source='todo'`).Scan(&title, &prompt))
	require.Equal(t, wantTitle, title)
	require.Equal(t, wantPrompt, prompt)
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, receipt.ID).Scan(&state))
	require.Equal(t, "approved", state)
	// A person's direct create uses the same writer and appends behind the
	// confirmed request. Replaying its key never creates a third stack item.
	for range 2 {
		response := call("POST", endpoint, input, "person-new", false)
		require.Equal(t, 202, response.Code, response.Body.String())
	}
	changed = call("POST", "/api/todos", `{"title":"Changed","prompt":"Different request"}`, "person-new", false)
	require.Equal(t, 409, changed.Code, changed.Body.String())
	require.Contains(t, changed.Body.String(), `"code":"idempotency_mismatch"`)
	rows, err := pool.Query(ctx, `SELECT stack_position, title, revisions->0->>'text', jsonb_array_length(revisions) FROM mythical_items WHERE source='todo' ORDER BY stack_position`)
	require.NoError(t, err)
	defer rows.Close()
	count = 0
	for rows.Next() {
		var position int64
		var revisions int
		require.NoError(t, rows.Scan(&position, &title, &prompt, &revisions))
		count++
		require.Equal(t, int64(count), position)
		require.Equal(t, wantTitle, title)
		require.Equal(t, wantPrompt, prompt)
		require.Equal(t, 1, revisions)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, 2, count)
}
