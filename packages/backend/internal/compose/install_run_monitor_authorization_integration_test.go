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

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// PostgreSQL admission and the composed install router are real. The monitor
// reader uses the existing guest wire fixture because this VM has no guest
// runtime; this test qualifies authorization, not native journal folding.
type admissionMonitorReader struct{ calls int }

func (r *admissionMonitorReader) Monitor(ctx context.Context, target flowruntime.Target, run string, at *int64) (json.RawMessage, error) {
	r.calls++
	return (monitorContractReader{}).Monitor(ctx, target, run, at)
}

func TestInstallRunMonitorAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", f.owner.ID)}
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	_, err = store.Admit(f.ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: "monitor-authorization", Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile})
	require.NoError(t, err)
	claim, err := store.Claim(f.ctx, "monitor-authorization", time.Minute)
	require.NoError(t, err)
	checkpoint, err := json.Marshal(flowdispatch.RuntimeCheckpoint{RunID: "thrash-run", FlowID: "todo", ExecutionDigest: strings.Repeat("a", 64), Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "monitor-box"}})
	require.NoError(t, err)
	_, err = store.BeginExternal(f.ctx, claim, json.RawMessage(`{"kind":"launching"}`))
	require.NoError(t, err)
	err = store.Park(f.ctx, claim, checkpoint, time.Hour)
	require.NoError(t, err)
	reader := &admissionMonitorReader{}
	router := hostStatusProductionRouter(cfg, f.q, &services.InstallCapacityService{}, conformanceServices{pool: f.pool})
	mountRunMonitors(router, cfg, f.q, &runMonitors{pool: f.pool, reader: reader})
	session := func(user db.User, raw string) {
		sum := sha256.Sum256([]byte(raw))
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	ownerCookie, memberCookie := "monitor-owner", "monitor-member"
	session(f.owner, ownerCookie)
	session(f.other, memberCookie)
	app := f.token(f.other, "monitor-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.other.ID)+"/1", true)
	external := f.token(f.other, "monitor-external", "write:repository,via:codex", true)
	run := f.token(f.owner, "monitor-run", "write:repository", true)
	machine := f.token(f.owner, "monitor-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	wrongScope := f.token(f.owner, "monitor-wrong-scope", "read:user,via:codex", true)
	for _, actor := range []struct {
		name, cookie, token string
		status, decisions   int
	}{
		{"owner", ownerCookie, "", 200, 1}, {"member", memberCookie, "", 200, 1}, {"app", "", app, 200, 1}, {"external", "", external, 200, 1},
		{"unbound run", "", run, 403, 1}, {"unbound machine", "", machine, 403, 1}, {"wrong scope", "", wrongScope, 403, 1}, {"anonymous", "", "", 401, 0},
	} {
		for _, path := range []string{"/api/runs", "/api/runs/thrash-run", "/api/runs/monitor-box:thrash-run/trace"} {
			t.Run(actor.name+path, func(t *testing.T) {
				req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
				if actor.cookie != "" {
					req.AddCookie(&http.Cookie{Name: "session", Value: actor.cookie})
				}
				if actor.token != "" {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				}
				var commands []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
				before := reader.calls
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Len(t, commands, actor.decisions)
				if actor.decisions > 0 {
					require.Equal(t, []string{"monitor"}, commands)
				}
				if actor.status == 200 {
					require.Contains(t, out.Body.String(), "thrash-run")
					require.Equal(t, before+1, reader.calls)
				} else {
					require.Equal(t, before, reader.calls)
					require.NotContains(t, out.Body.String(), "thrash-run")
					if actor.status == 403 {
						require.Contains(t, out.Body.String(), `"class":"permission"`)
						require.Contains(t, out.Body.String(), `"code":"permission"`)
					}
				}
			})
		}
	}
}
