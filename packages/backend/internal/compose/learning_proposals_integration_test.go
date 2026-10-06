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

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Learning proposal actions through the composed install router, real auth,
// CSRF and migrated PostgreSQL. Notes stand in for the pending learning output;
// this proof does not qualify merge admission or isolated machine execution.
func TestLearningProposalsComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo))}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("placement-session"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	note := `{"signature":"check:lint@review","title":"Run lint","prompt":"Run lint before review","diff":"+pnpm lint","evidence":["3 of the last 5 failed lint at review"],"todos":[1,3,5],"repository":"maya/app","run":"learning-5"}`
	_, err = pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,text,tags_json,provenance_json,status,created_at_ms) VALUES('lint','flow',$1,'Run lint','[]',$2,'pending',1),('dismiss','flow',$1,'Run lint','[]',$2,'pending',2),('fail','flow',$1,'Run lint','[]',$2,'pending',4),('other','flow','learning:999','Run lint','[]',$2,'pending',3)`, fmt.Sprintf("learning:%d", repo), note)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	call := func(method, path, body, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "placement-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "placement-csrf"})
		req.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: "placement-session"})
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var result map[string]any
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &result), res.Body.String())
		return res.Code, result
	}
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='frozen' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	failedCode, failedBody := call("POST", "/api/proposals/fail/accept", "{}", "failed")
	require.Equal(t, 503, failedCode, failedBody)
	var noteStatus string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM memory_notes WHERE id='fail'`).Scan(&noteStatus))
	require.Equal(t, "pending", noteStatus)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	code, body := call("POST", "/api/proposals/lint/accept", "{}", "accept")
	require.Equal(t, 202, code, body)
	require.Equal(t, "accepted", body["state"])
	require.Equal(t, float64(1), body["todo"].(map[string]any)["n"])
	code, body = call("POST", "/api/proposals/lint/accept", "{}", "retry")
	require.Equal(t, 202, code, body)
	require.Equal(t, float64(1), body["todo"].(map[string]any)["n"])
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 1, count)
	var prompt string
	require.NoError(t, pool.QueryRow(ctx, `SELECT issue_body FROM mythical_items WHERE repository_id=$1`, repo).Scan(&prompt))
	require.Contains(t, prompt, "3 of the last 5 failed lint at review")
	require.Contains(t, prompt, "+pnpm lint")
	code, body = call("POST", "/api/proposals/dismiss/dismiss", "{}", "dismiss")
	require.Equal(t, 202, code, body)
	require.Equal(t, "dismissed", body["state"])
	var dismissed int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT status_at_ms FROM memory_notes WHERE id='dismiss'`).Scan(&dismissed))
	code, body = call("POST", "/api/proposals/dismiss/dismiss", "{}", "replay")
	require.Equal(t, 202, code, body)
	var replay int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT status_at_ms FROM memory_notes WHERE id='dismiss'`).Scan(&replay))
	require.Equal(t, dismissed, replay)
	code, body = call("POST", "/api/proposals/dismiss/accept", "{}", "wrong")
	require.Equal(t, 409, code, body)
	code, body = call("POST", "/api/proposals/other/accept", "{}", "other")
	require.Equal(t, 404, code, body)
	source, refusal := (&liveTopics{todos: service}).resolve(ctx, "proposals", repo, "maya/app", owner.ID)
	require.Empty(t, refusal)
	payload, err := source.Build(ctx)
	require.NoError(t, err)
	var cards []map[string]any
	require.NoError(t, json.Unmarshal(payload, &cards))
	require.Len(t, cards, 3)
	for _, card := range cards {
		require.NotEqual(t, "other", card["id"])
	}
	get := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/proposals", nil)
	get.RemoteAddr = "127.0.0.1:51900"
	get.Header.Set("Origin", cfg.Server.PublicURL)
	get.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: "placement-session"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, get)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &cards))
	require.Len(t, cards, 3)
	_, err = pool.Exec(ctx, `DELETE FROM self_host_owners`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	code, body = call("POST", "/api/proposals/lint/accept", "{}", "revoked")
	require.Equal(t, 403, code, body)
}
