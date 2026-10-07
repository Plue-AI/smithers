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

	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, owner.ID)
	require.NoError(t, err)
	token := "smithers_" + strings.Repeat("c", 40)
	tokenSum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(tokenSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "codex-confirm", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository,via:codex", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	handler := startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
	call := func(method, path, body, key string, delegated bool) *httptest.ResponseRecorder {
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
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	const input = `{"title":"Keep the greeting","prompt":"Keep the exact greeting.","acceptance":["Greeting remains"]}`
	var receipt services.ConfirmationReceipt
	for range 2 {
		response := call("POST", "/api/todos", input, "delegated-new", true)
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
	var count int
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
	require.Equal(t, "Keep the greeting", title)
	require.Equal(t, "Keep the exact greeting.", prompt)
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, receipt.ID).Scan(&state))
	require.Equal(t, "approved", state)
}
