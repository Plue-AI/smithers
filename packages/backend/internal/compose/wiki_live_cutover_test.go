package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/stretchr/testify/require"
)

func TestWikiLiveCutoverRetiresHTTPProtocol(t *testing.T) {
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeSelfHosted
	pool, _ := postgresfixture.NewProductDatabase(t)
	router := hostStatusProductionRouter(cfg, db.New(pool), &services.InstallCapacityService{})
	served := map[string]servedRoute{}
	walkServedRoutes(t, router, served)
	published := documentedOperations(loadOpenAPIPaths(t))
	for _, probe := range []struct{ method, suffix string }{
		{"GET", "updates"}, {"POST", "updates"}, {"GET", "stream"},
	} {
		t.Run(probe.method+"_"+probe.suffix, func(t *testing.T) {
			key := map[string]string{"GET": "get", "POST": "post"}[probe.method] + " /api/repos/{owner}/{repo}/wiki/{slug}/" + probe.suffix
			require.NotContains(t, served, key)
			require.NotContains(t, published, key)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(probe.method, "https://plue.test/api/repos/alice/demo/wiki/home/"+probe.suffix, nil))
			require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
		})
	}
	require.Contains(t, served, "get /api/repos/{owner}/{repo}/wiki/{slug}/document")
	require.Contains(t, served, "get /api/repos/{owner}/{repo}/wiki/{slug}/revisions")
	var writer string
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT pg_get_functiondef('wiki_record_revision()'::regprocedure)`).Scan(&writer))
	require.NotContains(t, writer, "pg_notify")
}

// The real session middleware and install resolver refuse document traffic;
// snapshot streams continue on the same authenticated socket.
func TestWikiLiveCutoverDocumentAdmission(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "wiki-owner", LowerUsername: "wiki-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
	require.NoError(t, err)
	repository, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding, err := json.Marshal(map[string]any{"owner_login": "wiki-owner", "repository_name": "app", "repository_id": repository.ID})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	access, err := json.Marshal(map[string]any{"owner_login": "wiki-owner", "repository_name": "app", "repository_id": repository.ID, "last_access_check_at": time.Now().UTC().Format(time.RFC3339Nano)})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
	sum := sha256.Sum256([]byte("wiki-live-browser"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,$3,NOW()+interval '1 hour')`, hex.EncodeToString(sum[:]), owner.ID, owner.Username)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeSelfHosted
	cfg.Auth.SessionCookieName = "session"
	var origin string
	topics := &liveTopics{queries: q}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Router creation waits until the listener assigned its effective origin.
		hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{live: handler}).ServeHTTP(w, r)
	}))
	defer server.Close()
	origin = server.URL
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=wiki-live-browser"}}})
	if err != nil && response != nil {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("live upgrade: %v: %s", err, raw)
	}
	require.NoError(t, err)
	defer conn.CloseNow()
	for _, topic := range []string{"doc:wiki:42", "doc:wiki:private-page"} {
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"`+topic+`"}`)))
		kind, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		require.Equal(t, websocket.MessageText, kind)
		require.JSONEq(t, `{"t":"err","id":1,"code":"unsupported"}`, string(raw))
	}
	require.NoError(t, conn.Write(ctx, websocket.MessageBinary, []byte{1, 0, 0, 0, 1, 0}))
	_, raw, err := conn.Read(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `{"t":"err","id":1,"code":"unsupported"}`, string(raw))
	// The rejected document does not darken unrelated facts on the socket.
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":2,"topic":"agents"}`)))
	_, raw, err = conn.Read(ctx)
	require.NoError(t, err)
	var answer struct {
		T    string
		ID   int
		Data json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &answer))
	require.Equal(t, "snap", answer.T)
	require.Equal(t, 2, answer.ID)
}
