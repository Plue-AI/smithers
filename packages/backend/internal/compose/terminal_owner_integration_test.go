package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Proves the installed HTTP door refuses before any session or credential
// side effects. This does not qualify owner-uid execution without the broker.
func TestTerminalInstallOpenUnavailableHTTP(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"ben","repository_name":"fixture","repository_id":0}`)}))
	verified := fmt.Sprintf(`{"owner_login":"ben","repository_name":"fixture","repository_id":0,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339Nano))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(verified)}))
	hash := sha256.Sum256([]byte("terminal-owner-fixture"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q})
	for _, authenticated := range []bool{false, true} {
		req := httptest.NewRequest(http.MethodPost, "http://localhost:4000/api/terminals", strings.NewReader(`{"branch":"T1","owner":0}`))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://localhost:4000")
		req.Header.Set("X-CSRF-Token", "csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		if authenticated {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "terminal-owner-fixture"})
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if authenticated {
			require.Equal(t, 503, response.Code, response.Body.String())
			require.JSONEq(t, `{"code":"terminal_unavailable","class":"infra","message":"Terminal is unavailable"}`, response.Body.String())
		} else {
			require.Equal(t, 401, response.Code, response.Body.String())
		}
	}
	var tokens, sessions int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&tokens))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspace_sessions`).Scan(&sessions))
	require.Zero(t, tokens)
	require.Zero(t, sessions)
}
