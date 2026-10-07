package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestInstallOwnerHealthUsesRosterAuthorityPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	_, err := f.pool.Exec(f.ctx, `UPDATE users SET is_admin=false WHERE id=$1`, f.owner.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE users SET is_admin=true WHERE id=$1`, f.other.ID)
	require.NoError(t, err)
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routerExtras{AdminSystemHealth: &routes.AdminSystemHealthHandler{DB: f.pool}})
	session := func(user db.User, value string) string {
		sum := sha256.Sum256([]byte(value))
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return value
	}
	owner, member := session(f.owner, "health-owner"), session(f.other, "health-member")
	for _, tc := range []struct {
		name, cookie, token, code string
		status                    int
	}{
		{"owner", owner, "", "", 200},
		{"member with hosted admin flag", member, "", "permission", 403},
		{"external owner", "", f.token(f.owner, "health-external", "read:repository,read:admin,via:codex", true), "never", 403},
		{"app owner", "", f.token(f.owner, "health-app", "read:repository,read:admin,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true), "never", 403},
		{"run", "", f.token(f.owner, "health-run", "read:repository,read:admin", true), "permission", 403},
		{"machine", "", f.token(f.owner, "health-machine", "read:repository,read:admin,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true), "permission", 403},
		{"anonymous", "", "", "unauthenticated", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/admin/system/health", nil)
			if tc.cookie != "" {
				req.AddCookie(&http.Cookie{Name: "session", Value: tc.cookie})
			}
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			var commands []string
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, tc.status, out.Code, out.Body.String())
			if tc.status == 401 {
				require.Empty(t, commands)
			} else {
				require.Equal(t, []string{"install.read"}, commands)
			}
			if tc.status == 200 {
				require.Contains(t, out.Body.String(), `"status":"ok"`)
				require.Contains(t, out.Body.String(), `"database"`)
			} else {
				require.Contains(t, out.Body.String(), `"code":"`+tc.code+`"`)
				require.NotContains(t, out.Body.String(), `"database"`)
			}
		})
	}
}
