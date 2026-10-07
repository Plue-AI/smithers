package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This exercises the real Home socket and durable dispatch projection. It
// deliberately does not claim to prove merged admission or machine execution.
func TestLearningBackgroundHomeComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	digest := sha256.Sum256([]byte("fixture-person"))
	sessionHash := hex.EncodeToString(digest[:])
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "learnowner", LowerUsername: "learnowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"learnowner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo, time.Now().UTC().Format(time.RFC3339Nano)))}))
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: sessionHash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: sessionHash})
	service := services.NewMythicalService(pool, nil)
	_, err = service.FileTodo(ctx, repo, owner.ID, services.MythicalTodoInput{Title: "Retry", Prompt: "Use retry", Request: "fixture", Place: services.MythicalTodoPlace{Mode: "append"}})
	require.NoError(t, err)
	var itemID string
	require.NoError(t, pool.QueryRow(ctx, `UPDATE mythical_items SET state='landed',pr_state='merged' WHERE repository_id=$1 RETURNING id::text`, repo).Scan(&itemID))
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "background-machine", BindingKind: "learning", BindingID: itemID}
	admit := func(id string, target flowruntime.Target, todo int) string {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"target": target, "flowId": "learning", "payload": map[string]int{"todo": todo}})
		receipt, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: id, Payload: payload, AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: id})
		require.NoError(t, err)
		return receipt.OperationID
	}
	operation := admit("learning-one", target, 1)
	_, err = q.EnsureMythicalWiki(ctx, repo)
	require.NoError(t, err)
	// A payload cannot borrow an item from a different tenant or TODO.
	wrong := target
	wrong.TenantID = "repository:999"
	admit("wrong-repo", wrong, 1)
	admit("wrong-todo", target, 2)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	hubCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	topics := &liveTopics{queries: q, todos: service}
	handler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(hubCtx, nil), Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, routerExtras{Live: handler, Mythical: &routes.MythicalHandler{Service: service}})
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		router.ServeHTTP(w, r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &owner, SessionHash: sessionHash})))
	})
	server.Start()
	for _, row := range []struct {
		stored, visible, wikiStored, wikiVisible string
		requested                                bool
	}{
		{"accepted", "queued", "idle", "queued", true},
		{"dispatching", "queued", "off", "", false},
		{"running", "running", "running", "running", false},
		{"waiting", "waiting", "idle", "", false},
		{"failed", "failed", "failed", "failed", false},
		{"uncertain", "failed", "failed", "failed", false},
		{"completed", "", "idle", "", false},
		{"cancelled", "", "off", "", false},
	} {
		t.Run(row.stored, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE product_job_requests SET state=$2,terminal_receipt=CASE WHEN $2 IN ('failed','uncertain','completed','cancelled') THEN '{}'::jsonb ELSE NULL END WHERE id=$1`, operation, row.stored)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_wikis SET state=$2,requested=$3,run_id='wiki-run-1',error='Page review failed' WHERE repository_id=$1`, repo, row.wikiStored, row.requested)
			require.NoError(t, err)
			readCtx, done := context.WithTimeout(ctx, 10*time.Second)
			defer done()
			conn, _, err := websocket.Dial(readCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}}})
			require.NoError(t, err)
			defer conn.CloseNow()
			require.NoError(t, conn.Write(readCtx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
			for {
				_, raw, err := conn.Read(readCtx)
				require.NoError(t, err)
				var frame liveFrame
				require.NoError(t, json.Unmarshal(raw, &frame))
				require.NotEqual(t, "err", frame.T, string(raw))
				if frame.T != "snap" {
					continue
				}
				var home struct {
					Runs   []map[string]any `json:"background_runs"`
					Items  []any            `json:"items"`
					Counts map[string]int   `json:"counts"`
				}
				require.NoError(t, json.Unmarshal(frame.Data, &home))
				require.Empty(t, home.Items)
				require.Equal(t, 1, home.Counts["merged"])
				expected := []map[string]any{}
				if row.visible != "" {
					expected = append(expected, map[string]any{"id": operation, "title": "Learning · T1", "state": row.visible, "actions": []any{}})
				}
				if row.wikiVisible != "" {
					wiki := map[string]any{"id": "wiki-run-1", "title": "Refresh wiki", "state": row.wikiVisible, "actions": []any{}}
					if row.wikiVisible == "failed" {
						wiki["detail"] = "Page review failed"
					}
					expected = append(expected, wiki)
				}
				require.Equal(t, expected, home.Runs)
				break
			}
		})
	}
}
