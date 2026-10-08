package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The catalog's delegated run-policy must reach the durable Stop/Resume
// dispatcher. No guest is resolved before the HTTP acknowledgment; signals
// and replays are observed in PostgreSQL, never replaced by a service fake.
func TestAccessDelegatedStopResumeEffectsComposedPostgres(t *testing.T) {
	var todos *services.MythicalService
	h := newTodoSignalLiteralInstall(t, func(s *services.MythicalService, _ *pgxpool.Pool) { todos = s })
	ctx := t.Context()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := todoMergeComposeRouter(cfg, h.q, h.pool, &routes.MythicalHandler{Service: todos})
	issuer := services.NewAuthService(h.q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	issuer.Members = &services.Members{Pool: h.pool}
	owner, err := h.q.GetUserByID(ctx, h.owner)
	require.NoError(t, err)
	users := []db.User{owner}
	for _, role := range []struct{ name, permission string }{{"ben", "admin"}, {"alice", "write"}} {
		user, err := h.q.CreateUser(ctx, db.CreateUserParams{Username: role.name, LowerUsername: role.name})
		require.NoError(t, err)
		_, err = h.pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, user.ID)
		require.NoError(t, err)
		_, err = h.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, h.item.RepositoryID, user.ID, role.permission)
		require.NoError(t, err)
		users = append(users, user)
	}
	digest := rehearsalBuiltinTodoDigest(t)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", h.item.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", h.owner)}
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "11111111-1111-4111-8111-111111111111", BindingKind: "mythical-item", BindingID: uuid.UUID(h.item.ID.Bytes).String()}
	count := func() int {
		var n int
		require.NoError(t, h.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.signal'`).Scan(&n))
		return n
	}
	cells := 0
	for _, user := range users {
		for _, via := range []string{"cli", "codex", "claude-code", "smithers"} {
			token := ""
			if via == "smithers" {
				issued, err := issuer.MintForTurn(ctx, user.ID, liveAppTurnCredentialFixture(t, h.pool, user.ID), 1)
				require.NoError(t, err)
				token = issued.Token
			} else {
				issued, err := issuer.CreateToken(ctx, user.ID, services.CreateTokenRequest{Name: "pause-matrix-" + via, Via: via, Scopes: []string{"repo", "user"}})
				require.NoError(t, err)
				token = issued.Token
			}
			for _, op := range []string{"stop", "resume"} {
				t.Run(user.Username+"/"+via+"/"+op, func(t *testing.T) {
					facts := map[string]any{"todo": true, "run_launched": true, "run_attached": true, "flowSource": strings.Repeat("a", 40)}
					if op == "resume" {
						facts["pause"] = map[string]any{"generation": 1, "run": "run-1", "requested": true, "at": "2026-10-02T12:00:00Z", "wait": services.TodoWaitSignal{Scope: scope, Target: target, Flow: "todo", Run: "run-1", Name: "resume#1"}}
					}
					raw, err := json.Marshal(facts)
					require.NoError(t, err)
					_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET state='running',checks=$2,attempt=1,request_run_id='run-1',request_outcome='',workspace_id=$3,flow_digest=$4,paused_at=CASE WHEN $5 THEN '2026-10-02T12:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, h.item.ID, raw, target.WorkspaceID, digest, op == "resume")
					require.NoError(t, err)
					before := count()
					key := fmt.Sprintf("pause-matrix-%s-%s-%s", user.Username, via, op)
					call := func() *httptest.ResponseRecorder {
						req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/todos/1", strings.NewReader(fmt.Sprintf(`{"op":%q}`, op)))
						req.RemoteAddr = "127.0.0.1:51900"
						req.Header.Set("Origin", cfg.Server.PublicURL)
						req.Header.Set("Content-Type", "application/json")
						req.Header.Set("Authorization", "Bearer "+token)
						req.Header.Set("Idempotency-Key", key)
						req.Header.Set("Smithers-Actor", "person")
						req.Header.Set("Smithers-Via", "terminal")
						var decisions []string
						req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
						out := httptest.NewRecorder()
						router.ServeHTTP(out, req)
						require.Equal(t, http.StatusAccepted, out.Code, out.Body.String())
						require.Equal(t, []string{"todo." + op}, decisions)
						require.NotContains(t, out.Body.String(), "confirmation")
						return out
					}
					out := call()
					require.Equal(t, before+1, count())
					saved, err := h.q.GetMythicalItem(ctx, h.item.ID)
					require.NoError(t, err)
					var factsAfter struct {
						Pause    struct{ Requested, Resuming bool }
						Attached bool `json:"run_attached"`
					}
					require.NoError(t, json.Unmarshal(saved.Checks, &factsAfter))
					require.True(t, factsAfter.Pause.Requested)
					require.Equal(t, op == "resume", factsAfter.Pause.Resuming)
					require.False(t, saved.PausedAt.Valid)
					replay := call()
					require.JSONEq(t, out.Body.String(), replay.Body.String())
					require.Equal(t, before+1, count())
					again, err := h.q.GetMythicalItem(ctx, h.item.ID)
					require.NoError(t, err)
					require.Equal(t, saved, again)
					cells++
				})
			}
		}
	}
	require.Equal(t, 24, cells)
	t.Logf("delegated Stop/Resume: %d admitted effect cells, %d replays", cells, cells)
}
