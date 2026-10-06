package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The installed composition must supply the existing transactional consumer,
// not an approvals store with no executor. Requests create no TODO; only the
// member's authenticated Confirm press does, atomically and once.
func TestConfirmLearningConsumerInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	busCtx, stopBus := context.WithCancel(ctx)
	defer stopBus()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busCtx))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
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
	turn := liveAppTurnCredentialFixture(t, pool, owner.ID)
	token := "smithers_" + strings.Repeat("c", 40)
	tokenSum := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(tokenSum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "app-confirm", TokenHash: tokenHash, TokenLastEight: tokenHash[len(tokenHash)-8:], Scopes: "read:repository,write:repository,via:smithers,terminal-session:" + turn + "/1", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	todos := services.NewMythicalService(pool, nil)
	handler := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Confirmations: services.NewApprovalsService(q, services.WithConfirmationTodos(pool, todos))})
	call := func(method, path, body, key string, delegated bool, sessionCookies ...string) *httptest.ResponseRecorder {
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
			sessionCookie := cookie
			if len(sessionCookies) > 0 {
				sessionCookie = sessionCookies[0]
			}
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessionCookie})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	other, err := q.CreateUser(ctx, db.CreateUserParams{Username: "other", LowerUsername: "other"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, other.ID)
	require.NoError(t, err)
	otherHash := sha256.Sum256([]byte("other-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: other.ID, Username: other.Username, SessionKey: hex.EncodeToString(otherHash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	readLive := func(after *int64) map[string]any {
		t.Helper()
		hubCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		topics := &liveTopics{queries: q, todos: todos}
		server := httptest.NewUnstartedServer(nil)
		socketCfg := *cfg
		socketCfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
		socketCfg.Server.AllowedOrigins = []string{socketCfg.Server.PublicURL}
		liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(hubCtx, nil), Origins: func() []string { return []string{socketCfg.Server.PublicURL} }, Topics: topics.resolver}
		router := githubAppSetupComposeRouter(&socketCfg, pool, nil, routerExtras{Mythical: &routes.MythicalHandler{Service: todos}, Live: liveHandler})
		server.Config.Handler = router
		server.Start()
		defer server.Close()
		readCtx, done := context.WithTimeout(ctx, 10*time.Second)
		defer done()
		conn, _, err := websocket.Dial(readCtx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {socketCfg.Server.PublicURL}, "Cookie": {"smithers_session=" + cookie}}})
		require.NoError(t, err)
		defer conn.CloseNow()
		input := map[string]any{"t": "sub", "id": 1, "topic": "proposals"}
		if after != nil {
			input["cursor"] = *after
		}
		raw, _ := json.Marshal(input)
		require.NoError(t, conn.Write(readCtx, websocket.MessageText, raw))
		for {
			_, raw, err = conn.Read(readCtx)
			require.NoError(t, err)
			var frame map[string]any
			require.NoError(t, json.Unmarshal(raw, &frame))
			if frame["t"] == "snap" || frame["t"] == "gap" {
				return frame
			}
		}
	}
	_, err = pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,tags_json,status,text,provenance_json,created_at_ms) VALUES('check:lint@review/%2F','flow',$1,'[]','pending','Use lint',$2,1),('dismiss-me','flow',$1,'[]','pending','Use lint',$2,1),('changed','flow',$1,'[]','pending','Use lint',$2,1)`, fmt.Sprintf("learning:%d", repo.ID), `{"repository":"ben/demo","run":"learning-1","signature":"check:lint@review","title":"Run lint","evidence":["3 of 5 failed lint"],"todos":[1],"prompt":"Run lint before review"}`)
	require.NoError(t, err)
	initial := readLive(nil)
	require.Equal(t, "snap", initial["t"])
	require.Equal(t, float64(0), initial["cursor"])
	for _, action := range []struct{ id, path, command, status string }{{"check:lint@review/%2F", "check%3Alint%40review%2F%252F", "accept", "accepted"}, {"dismiss-me", "dismiss-me", "dismiss", "rejected"}} {
		t.Run(action.command, func(t *testing.T) {
			response := call("POST", "/api/proposals/"+action.path+"/"+action.command, `{}`, "ask-"+action.command, true)
			require.Equal(t, 202, response.Code, response.Body.String())
			var receipt services.ConfirmationReceipt
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &receipt))
			require.Equal(t, "pending", receipt.State)
			var status string
			require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM memory_notes WHERE id=$1`, action.id).Scan(&status))
			require.Equal(t, "pending", status)
			wrong := call("POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "wrong-"+action.command, false, "other-cookie")
			require.Equal(t, 403, wrong.Code, wrong.Body.String())
			denied := call("POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "agent-"+action.command, true)
			require.Equal(t, 403, denied.Code, denied.Body.String())
			for range 2 {
				response = call("POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "person-"+action.command, false)
				require.Equal(t, 200, response.Code, response.Body.String())
			}
			require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM memory_notes WHERE id=$1`, action.id).Scan(&status))
			require.Equal(t, action.status, status)
		})
	}
	response := call("POST", "/api/proposals/changed/accept", `{}`, "ask-changed", true)
	require.Equal(t, 202, response.Code, response.Body.String())
	var changed services.ConfirmationReceipt
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &changed))
	response = call("POST", "/api/proposals/changed/dismiss", `{}`, "dismiss-changed", false)
	require.Equal(t, 202, response.Code, response.Body.String())
	response = call("POST", "/api/confirmations/"+changed.ID+"/approve", `{}`, "approve-changed", false)
	require.Equal(t, 409, response.Code, response.Body.String())
	committed := readLive(nil)
	require.Equal(t, "snap", committed["t"])
	require.Greater(t, committed["cursor"].(float64), float64(0))
	require.Len(t, committed["data"], 3)
	// Rebuilding the router and hub retains the cursor from committed facts.
	require.Equal(t, committed["cursor"], readLive(nil)["cursor"])
	stale := int64(0)
	require.Equal(t, "gap", readLive(&stale)["t"])
	var facts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='learning.proposal'`).Scan(&facts))
	require.Equal(t, 3, facts)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE source='todo'`).Scan(&count))
	require.Equal(t, 1, count)
	var prompt string
	require.NoError(t, pool.QueryRow(ctx, `SELECT issue_body FROM mythical_items WHERE source='todo'`).Scan(&prompt))
	require.Contains(t, prompt, "Run lint before review")
	require.Contains(t, prompt, "3 of 5 failed lint")
}
