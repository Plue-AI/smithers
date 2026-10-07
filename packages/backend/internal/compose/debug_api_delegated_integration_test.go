package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Uses an admitted/claimed real turn and the production host-only issuer.
// This proves eligible dispatch; the combined acceptance also needs scope/role
// precedence through the shared dispatcher, tracked separately in C-UI-10.
func TestDebugAPIEligibleDelegatedDispatchPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	repo := ciTestRepo(t, pool, owner.ID, "app")
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"ben","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo, time.Now().UTC().Format(time.RFC3339)))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
	}
	cookieHash := sha256.Sum256([]byte("debug-api-turn-author"))
	sessionHash := hex.EncodeToString(cookieHash[:])
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: sessionHash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	turns, err := chat.NewStore(pool)
	require.NoError(t, err)
	scope := chat.Scope{UserID: owner.ID, Owner: owner.Username}
	run := uuid.NewString()
	admitted, err := turns.Admit(ctx, chat.AdmitInput{Scope: scope, RunID: run,
		Journal: chat.JournalRequest{Version: 1, LegID: uuid.NewString(), Token: uuid.NewString()},
		Request: []byte(`{"messages":[{"role":"user","content":"Open the API playground"}]}`)})
	require.NoError(t, err)
	grant, err := turns.Claim(ctx, scope, admitted.TurnID, time.Minute)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	auth := services.NewAuthService(q, cfg.Auth, nil, nil)
	auth.Members = &services.Members{Pool: pool}
	issuer := services.InstallAPI{Auth: auth}
	credential, err := issuer.Begin(ctx, middleware.Credential{SessionHash: sessionHash}, owner.ID, grant.TurnID, grant.Generation)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, issuer.End(context.WithoutCancel(ctx), owner.ID, credential.TokenID)) })
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, nil, &routes.UserHandler{ProfileService: services.NewUserService(q)})
	server.Start()
	t.Cleanup(server.Close)
	home := t.TempDir()
	command := exec.CommandContext(ctx, "bun", "e2e/playwright/debug-api/delegated-dispatch.ts")
	command.Dir = "../../../../apps/app"
	command.Env = append(os.Environ(), "SMITHERS_API_ORIGIN="+server.URL, "SMITHERS_TOKEN="+credential.Token, "XDG_CONFIG_HOME="+home, "XDG_DATA_HOME="+home)
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	require.Contains(t, string(output), "C-UI-10 AUTHENTICATED DELEGATED DISPATCH PASS")
	for _, table := range []string{"mythical_items", "workflow_runs", "approvals"} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, "refused dispatch created %s", table)
	}
}
