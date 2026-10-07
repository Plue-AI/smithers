package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Imported content is shared only through normalized conversation history.
// Neither an authenticated owner nor a member can retrieve raw home transcripts
// through the retired HTTP route or subscribe to a raw-file growth topic.
func TestExternalRawSessionsUnavailableComposedInstallPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	routes.SetRevocationSource(revocation.NewBus(pool, nil))
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	sentinel := []byte("private unrelated historical transcript\n")
	file := filepath.Join(home, "unrelated.jsonl")
	require.NoError(t, os.WriteFile(file, sentinel, 0600))
	cookies := []string{}
	people := []db.User{}
	for _, login := range []string{"ben", "maya"} {
		person, err := q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login})
		require.NoError(t, err)
		if login == "ben" {
			_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, person.ID)
			require.NoError(t, err)
		}
		key := login + "-cookie"
		digest := sha256.Sum256([]byte(key))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: login, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		cookies = append(cookies, key)
		people = append(people, person)
	}
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: people[0].ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"acme","repository_name":"app","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	for _, person := range people {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,github_id,github_login) VALUES($1,$2,'admin',$2,$3)`, repo.ID, person.ID, person.Username)
		require.NoError(t, err)
	}
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`)}))
	github := &rosterGitHub{roles: map[string]string{"ben": "admin", "maya": "maintain"}}
	provider := httptest.NewServer(http.HandlerFunc(github.serve))
	defer provider.Close()
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	members := &services.Members{Pool: pool, Credentials: rosterAppCredentials{}, Minter: services.NewRepoConnectionService(nil, rosterAppCredentials{})}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	topics := &liveTopics{queries: q}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = buildRouterCompat(cfg, q, pool, &routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}}, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil, routerExtras{Live: handler, Members: &routes.MembersHandler{Service: members}})
	server.Start()
	defer server.Close()
	for _, cookie := range cookies {
		for _, path := range []string{"/api/external/sessions?agent=codex&session=unrelated", "/api/external/sessions?agent=claude-code&session=unrelated", "/api/external/codex?session=unrelated"} {
			request, err := http.NewRequest(http.MethodGet, origin+path, nil)
			require.NoError(t, err)
			request.Header.Set("Origin", origin)
			request.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			response, err := server.Client().Do(request)
			require.NoError(t, err)
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			require.NoError(t, err)
			require.Equal(t, http.StatusNotFound, response.StatusCode, string(body))
			require.NotContains(t, string(body), string(sentinel))
		}
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		socket, _, err := websocket.Dial(deadline, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=" + cookie}}})
		require.NoError(t, err)
		require.NoError(t, socket.Write(deadline, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"external:codex:0199e2e0"}`)))
		_, body, err := socket.Read(deadline)
		require.NoError(t, err)
		var reply map[string]any
		require.NoError(t, json.Unmarshal(body, &reply))
		require.Equal(t, "err", reply["t"])
		require.Equal(t, live.Unsupported, reply["code"])
		require.NotContains(t, string(body), string(sentinel))
		_ = socket.Close(websocket.StatusNormalClosure, "")
		cancel()
	}
	actual, err := os.ReadFile(file)
	require.NoError(t, err)
	require.Equal(t, sentinel, actual)
}
