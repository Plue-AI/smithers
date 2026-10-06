package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/machinedfake"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/url"
)

type docFixture struct {
	server  *httptest.Server
	conn    *websocket.Conn
	relay   *live.DocRelay
	daemon  *machinedfake.Documents
	binding *machined.Connection
	bus     *revocation.Bus
}

func docGolden(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/cocontracts/doc-" + name + ".bin")
	require.NoError(t, err)
	f, err := wire.Decode(b)
	require.NoError(t, err)
	return f.Payload
}
func newDocFixture(t *testing.T, script ...[]byte) *docFixture {
	t.Helper()
	pool := docDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "doc-owner", LowerUsername: "doc-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"doc-owner","repository_name":"demo","repository_id":%d}`, repo.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	key := "doc-cookie"
	hash := sha256.Sum256([]byte(key))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	registry := &machined.Registry{}
	var boot [16]byte
	boot[0] = 1
	require.NoError(t, registry.BindBoot("branch-a", "machine-a", boot, []byte("credential")))
	connection, err := registry.Admit(boot, []byte("credential"), io.NopCloser(strings.NewReader("")))
	require.NoError(t, err)
	require.NoError(t, connection.Reconciled())
	if len(script) == 0 {
		script = [][]byte{docGolden(t, "epoch"), {3, 1, 2, 0, 0}}
	}
	daemon := &machinedfake.Documents{Script: script}
	client := &machinedfake.Client{OnOpenDocument: func(ctx context.Context, branch, path string, actor []byte) (machined.DocumentStream, error) {
		if err := connection.RequireReady(branch); err != nil {
			return nil, err
		}
		return daemon.OpenDocument(ctx, path, actor)
	}}
	library, err := livedocument.Load(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, err)
	host := &live.CodeDocuments{Library: library}
	t.Cleanup(func() {
		host.Close()
		require.Eventually(t, func() bool { return library.Close() == nil }, time.Second, time.Millisecond)
	})
	relay := &live.DocRelay{Host: host, Authorize: func(_ context.Context, topic live.DocumentTopic, repository, member int64) ([]byte, string) {
		if member != owner.ID || repository != repo.ID || topic.Path == "secret" {
			return nil, live.Forbidden
		}
		return []byte("Be"), ""
	}, Connection: func(context.Context, string) (*machined.Connection, live.DocumentRPC) {
		return connection, machined.Documents(client, "branch-a")
	}}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	topics := &liveTopics{queries: q, documents: relay}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Origins: handler.Origins}, routerExtras{Live: handler})
	server.Start()
	t.Cleanup(server.Close)
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=" + key}}})
	if err != nil && response != nil {
		b, _ := io.ReadAll(response.Body)
		t.Log(string(b))
	}
	require.NoError(t, err)
	conn.SetReadLimit(4 << 20)
	t.Cleanup(func() { conn.CloseNow() })
	return &docFixture{server, conn, relay, daemon, connection, bus}
}
func (f *docFixture) sub(t *testing.T, topic string) {
	t.Helper()
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageText, []byte(`{"t":"sub","id":7,"topic":"`+topic+`"}`)))
}
func (f *docFixture) read(t *testing.T) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	kind, b, err := f.conn.Read(ctx)
	require.NoError(t, err)
	return kind, b
}
func (f *docFixture) text(t *testing.T, want string) {
	t.Helper()
	kind, b := f.read(t)
	require.Equal(t, websocket.MessageText, kind)
	require.Equal(t, want, string(b))
}

// The fake tests routing only. It makes no durability, latency, execution,
// CRDT attribution, or reference-host claim.
func docDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	require.NotEmpty(t, raw)
	admin, err := pgx.Connect(t.Context(), raw)
	require.NoError(t, err)
	lane := os.Getenv("LANE")
	if lane == "" {
		lane = "t_col_08b"
	}
	name := fmt.Sprintf("fr_%s_%d", lane, time.Now().UnixNano())
	_, err = admin.Exec(t.Context(), "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" TEMPLATE template0")
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize())
		require.NoError(t, err)
		admin.Close(context.Background())
	})
	target, err := url.Parse(raw)
	require.NoError(t, err)
	target.Path = "/" + name
	pool, err := postgresfixture.Open(t.Context(), target.String(), 4)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(t.Context(), pool))
	return pool
}
