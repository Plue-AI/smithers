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
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Real authenticated install HTTP/websocket routes and PostgreSQL share the
// production repository reader. The repository HTTP fixture supplies immutable
// data; activation/merge and microVM execution are not qualified by this test.
func TestLiveAgentModelsRetainActivatedSeatsAfterOwnerSwitchPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	busCtx, stopBus := context.WithCancel(ctx)
	defer stopBus()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busCtx))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "seatowner", LowerUsername: "seatowner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "seatmember", LowerUsername: "seatmember"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	sessions := map[string]string{}
	for _, person := range []struct {
		user       db.User
		permission string
	}{{owner, "admin"}, {member, "write"}} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, person.user.ID, person.permission)
		require.NoError(t, err)
		token := person.user.Username + "-session"
		hash := sha256.Sum256([]byte(token))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.user.ID, Username: person.user.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		sessions[person.user.Username] = token
	}
	binding := fmt.Sprintf(`{"owner_login":"seatowner","repository_name":"app","repository_id":%d}`, repo.ID)
	activeKey, revision := fmt.Sprintf("agent.instructions.main:%d", repo.ID), strings.Repeat("a", 40)
	for key, value := range map[string]string{
		"github.repository": binding,
		"owner.access":      binding[:len(binding)-1] + `,"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`,
		"agent:coding":      `{"protocol":"openai-chat","modelId":"owner-a","credential":"OPENAI_API_KEY"}`,
		activeKey:           `"` + revision + `"`,
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	repository := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/seatowner:app/file/"+revision+"/.smithers/coding-project.json" {
			http.Error(w, "unactivated source", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(repohost.FileContent{Content: `{"seats":{"coding/review":"openai:repository-review"}}`})
	}))
	defer repository.Close()
	sources := repositorySourceFiles{client: repohost.NewClient(&repohost.StaticStorageSetResolver{URL: repository.URL}, "source-fixture")}
	topics := &liveTopics{queries: q, sources: sources}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL, cfg.Server.AllowedOrigins = origin, []string{origin}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, live: handler})
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: pool}, q, cfg, sources)
	server.Config.Handler = router
	server.Start()
	defer server.Close()
	address := &services.InstallAddress{}
	require.NoError(t, address.Initialize(ctx, pool, services.InstallSetupInput{Bind: server.Listener.Addr().String(), Origins: []string{origin}}))
	call := func(method, body string) *httptest.ResponseRecorder {
		path := "/api/agents"
		if method == http.MethodPut {
			path += "/coding/model"
		}
		req := httptest.NewRequest(method, origin+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: sessions[owner.Username]})
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "seat-csrf"})
		req.Header.Set("X-CSRF-Token", "seat-csrf")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		require.Equal(t, 200, res.Code, res.Body.String())
		return res
	}
	sharedHTTP := func(raw []byte) string {
		var body map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(raw, &body))
		delete(body, "canAssign")
		shared, err := json.Marshal(body)
		require.NoError(t, err)
		return string(shared)
	}
	read := func(socket *websocket.Conn) json.RawMessage {
		bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := socket.Read(bounded)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		require.Equal(t, "snap", frame.T, string(raw))
		return frame.Data
	}
	sockets := []*websocket.Conn{}
	first := call(http.MethodGet, "")
	for _, person := range []db.User{member, owner} {
		socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + sessions[person.Username]}, "Origin": {origin}}})
		require.NoError(t, err)
		defer socket.CloseNow()
		sockets = append(sockets, socket)
		require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"agents"}`)))
		require.JSONEq(t, sharedHTTP(first.Body.Bytes()), string(read(socket)), person.Username)
	}
	changed := call(http.MethodPut, `{"model":{"protocol":"openai-chat","modelId":"owner-b","credential":"OPENAI_API_KEY"}}`)
	for _, socket := range sockets {
		next := read(socket)
		require.JSONEq(t, sharedHTTP(changed.Body.Bytes()), string(next))
		require.Contains(t, string(next), `"id":"repository-review"`)
		require.Contains(t, string(next), `"source":"repository"`)
		require.Contains(t, string(next), `"id":"owner-b"`)
	}
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key=$1`, activeKey)
	require.NoError(t, err)
	withoutActivation := call(http.MethodGet, "")
	for _, socket := range sockets {
		next := read(socket)
		require.JSONEq(t, sharedHTTP(withoutActivation.Body.Bytes()), string(next))
		require.NotContains(t, string(next), "repository-review")
		require.NotContains(t, string(next), `"source":"repository"`)
	}
}
