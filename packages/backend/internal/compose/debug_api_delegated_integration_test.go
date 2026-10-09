package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
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
// App and compiled CLI cross the same real install command authorization door.
func TestDebugAPIDelegatedDispatchBoundariesPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben"})
	require.NoError(t, err)
	installOwner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "will", LowerUsername: "will"})
	require.NoError(t, err)
	repo := ciTestRepo(t, pool, installOwner.ID, "app")
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, installOwner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"will","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo, time.Now().UTC().Format(time.RFC3339)))
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
	router := githubAppSetupComposeRouter(cfg, pool, nil, &routes.UserHandler{ProfileService: services.NewUserService(q)})
	router = withInstallBootstrap(router, newAppBootstrap(bootstrapFeatures{identity: true, debugAPI: true, install: true}), func() []string { return []string{server.URL} })
	var requests atomic.Int64
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/api/bootstrap" && r.URL.Path != "/api/user" {
			require.Equal(t, "/api/commands/debug-api", r.URL.Path, "refusal must never send the chosen API request")
			require.Empty(t, r.URL.RawQuery, "authorization must not transmit the API payload")
		}
		router.ServeHTTP(w, r)
	})
	server.Start()
	t.Cleanup(server.Close)
	// Compile once, then re-read changed credential scope and live roster role
	// on every invocation. No test-only authorizer or command executes the API.
	cli := newPackagedTerminalCLI(t, ctx, server.URL, credential.Token)
	code, identity := cli.invoke("auth", "status")
	require.Zero(t, code, identity)
	require.Equal(t, "ben", identity["username"])
	require.Equal(t, "delegated", identity["credential_kind"])
	require.Equal(t, "smithers", identity["via"])
	var originalScopes string
	require.NoError(t, pool.QueryRow(ctx, `SELECT scopes FROM access_tokens WHERE id=$1`, credential.TokenID).Scan(&originalScopes))
	for _, scenario := range []string{"never", "scope", "role", "restored"} {
		t.Run(scenario, func(t *testing.T) {
			expectedCode, expectedMessage := "never", "Only a person can do this"
			switch scenario {
			case "scope":
				scopes := strings.Split(originalScopes, ",")
				for i, scope := range scopes {
					if scope == "repo" || scope == "write:repository" {
						scopes[i] = "read:repository"
					}
				}
				limited := strings.Join(scopes, ",")
				require.NotEqual(t, originalScopes, limited, "fixture must remove write authority")
				_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, credential.TokenID, limited)
				require.NoError(t, err)
				expectedCode, expectedMessage = "permission", "Insufficient credential scope"
			case "role":
				_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=$2 WHERE id=$1`, credential.TokenID, originalScopes)
				require.NoError(t, err)
				_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='read' WHERE user_id=$1`, owner.ID)
				require.NoError(t, err)
				expectedCode, expectedMessage = "unauthenticated", "Sign in again"
			case "restored":
				_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, owner.ID)
				require.NoError(t, err)
			}
			home := t.TempDir()
			command := exec.CommandContext(ctx, "bun", "e2e/playwright/debug-api/delegated-dispatch.ts")
			command.Dir = "../../../../apps/app"
			appExpectation := scenario
			if appExpectation == "restored" {
				appExpectation = "never"
			}
			command.Env = append(os.Environ(), "SMITHERS_API_ORIGIN="+server.URL, "SMITHERS_TOKEN="+credential.Token,
				"SMITHERS_EXPECT_DEBUG_REFUSAL="+appExpectation, "XDG_CONFIG_HOME="+home, "XDG_DATA_HOME="+home)
			output, err := command.CombinedOutput()
			require.NoError(t, err, string(output))
			require.Contains(t, string(output), "C-UI-10 SHARED APP-AGENT PRECEDENCE PASS")
			for _, args := range [][]string{{"debug", "api"}, {"debug", "api", "--operationId", "get_api_todos"}, {"debug", "api", "--intent", "send"}} {
				before := requests.Load()
				code, receipt := cli.invoke(args...)
				require.NotZero(t, code, receipt)
				require.Equal(t, expectedCode, receipt["code"], receipt)
				require.Contains(t, fmt.Sprint(receipt), expectedMessage)
				require.Equal(t, before+1, requests.Load(), "only command authorization crosses HTTP")
				require.NotContains(t, fmt.Sprint(receipt), credential.Token)
			}
		})
	}

	// A member's own session may open the client-only playground. The door
	// returns no token, execution receipt, or data from the selected operation.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/commands/debug-api", nil)
	require.NoError(t, err)
	request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "debug-api-turn-author"})
	response, err := server.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusNoContent, response.StatusCode)
	require.Equal(t, "no-store", response.Header.Get("Cache-Control"))
	require.NoError(t, response.Body.Close())

	for _, table := range []string{"mythical_items", "workflow_runs", "approvals"} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count))
		require.Zero(t, count, "refused dispatch created %s", table)
	}
}
