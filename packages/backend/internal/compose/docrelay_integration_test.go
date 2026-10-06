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
	daemon := &machinedfake.Documents{Script: script}
	client := &machinedfake.Client{OnOpenDocument: func(ctx context.Context, branch, path string, actor []byte) (machined.DocumentStream, error) {
		if err := connection.RequireReady(branch); err != nil {
			return nil, err
		}
		return daemon.OpenDocument(ctx, path, actor)
	}}
	relay := &live.DocRelay{Topology: "relay", Authorize: func(_ context.Context, topic live.DocumentTopic, repository, member int64) ([]byte, string) {
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
	return &docFixture{server, conn, relay, daemon, connection}
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

func TestDocRelayWireContract(t *testing.T) {
	f := newDocFixture(t, docGolden(t, "epoch"), docGolden(t, "sync"), docGolden(t, "awareness"), docGolden(t, "saved"), docGolden(t, "gone"))
	f.sub(t, "doc:code:branch-a:retry.ts")
	f.text(t, `{"t":"snap","id":7,"cursor":0,"data":{"epoch":"00112233445566778899aabbccddeeff","client_id":42}}`)
	kind, b := f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	require.Equal(t, []byte{1, 0, 0, 0, 7, 0, 1, 0}, b)
	kind, b = f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	require.Equal(t, []byte{2, 0, 0, 0, 7, 0}, b)
	f.text(t, `{"t":"saved","id":7,"sv":"ASoB","at":"2026-10-03T12:00:00Z"}`)
	f.text(t, `{"t":"gone","id":7,"data":{"deleted":true,"by":"Ben"}}`)
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, []byte{1, 0, 0, 0, 7, 0, 1, 0}))
	require.Eventually(t, func() bool { _, sent, _ := f.daemon.Recorded(); return len(sent) == 1 }, time.Second, time.Millisecond)
	opened, sent, _ := f.daemon.Recorded()
	require.Equal(t, docGolden(t, "input"), sent[0])
	require.Equal(t, "retry.ts", opened[0].Path)
	require.Equal(t, []byte("Be"), opened[0].Actor)
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageText, []byte(`{"t":"unsub","id":7}`)))
	require.Eventually(t, func() bool { _, _, closed := f.daemon.Recorded(); return closed == 1 }, time.Second, time.Millisecond)
	wireSent, control := f.daemon.RecordedWire()
	expected, err := os.ReadFile("testdata/cocontracts/doc-input.bin")
	require.NoError(t, err)
	require.Equal(t, expected, wireSent[0])
	expected, err = os.ReadFile("testdata/cocontracts/req_open_doc_s3.bin")
	require.NoError(t, err)
	require.Equal(t, expected, control[0])
	expected, err = os.ReadFile("testdata/cocontracts/req_close_doc_s3.bin")
	require.NoError(t, err)
	require.Equal(t, expected, control[1])

}

func TestDocRelayAuthorization(t *testing.T) {
	f := newDocFixture(t, docGolden(t, "epoch"))
	for _, topic := range []string{"doc:code:branch-b:retry.ts", "doc:code:branch-a:secret"} {
		f.sub(t, topic)
		f.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	}
	opened, _, _ := f.daemon.Recorded()
	require.Empty(t, opened)
	f.daemon.Reply = func([]byte) [][]byte { return [][]byte{docGolden(t, "spoof")} }
	f.sub(t, "doc:code:branch-a:retry.ts")
	f.text(t, `{"t":"snap","id":7,"cursor":0,"data":{"epoch":"00112233445566778899aabbccddeeff","client_id":42}}`)
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, []byte{1, 0, 0, 0, 7, 2, 2, 0, 0}))
	f.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	_, sent, _ := f.daemon.Recorded()
	require.Equal(t, []byte{1, 1, 0, 0, 0, 7, 1, 0, 0, 0, 2, 66, 101, 2, 2, 0, 0}, sent[0])
}
func TestDocRelayBackpressure(t *testing.T) {
	big := append([]byte{3}, make([]byte, 2<<20)...)
	f := newDocFixture(t, docGolden(t, "epoch"), big)
	f.sub(t, "doc:code:branch-a:retry.ts")
	// Epoch may already be queued; the oversized update must yield gap, never binary.
	for {
		kind, b := f.read(t)
		require.Equal(t, websocket.MessageText, kind)
		var v map[string]any
		require.NoError(t, json.Unmarshal(b, &v))
		if v["t"] == "gap" {
			break
		}
		require.Equal(t, "snap", v["t"])
	}
	require.Eventually(t, func() bool { _, _, closed := f.daemon.Recorded(); return closed == 1 }, time.Second, time.Millisecond)
	f.daemon.Script = [][]byte{docGolden(t, "epoch"), docGolden(t, "sync")}
	f.sub(t, "doc:code:branch-a:retry.ts")
	f.text(t, `{"t":"snap","id":7,"cursor":0,"data":{"epoch":"00112233445566778899aabbccddeeff","client_id":42}}`)
	kind, b := f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	require.Equal(t, []byte{1, 0, 0, 0, 7, 0, 1, 0}, b)
}
func TestDocRelayDarkLanding(t *testing.T) {
	for _, missing := range []string{"topology", "authorizer", "connection", "daemon", "wiki"} {
		t.Run(missing, func(t *testing.T) {
			f := newDocFixture(t)
			topic := "doc:code:branch-a:retry.ts"
			switch missing {
			case "topology":
				f.relay.Topology = ""
			case "authorizer":
				f.relay.Authorize = nil
			case "connection":
				f.relay.Connection = nil
			case "daemon":
				f.relay.Connection = func(context.Context, string) (*machined.Connection, live.DocumentRPC) { return f.binding, nil }
			case "wiki":
				topic = "doc:wiki:page"
			}
			f.sub(t, topic)
			f.text(t, `{"t":"err","id":7,"code":"unsupported"}`)
			require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, []byte{1, 0, 0, 0, 7, 2, 2, 0, 0}))
			f.text(t, `{"t":"err","id":7,"code":"unsupported"}`)
			opened, sent, _ := f.daemon.Recorded()
			require.Empty(t, opened)
			require.Empty(t, sent)
		})
	}
}
func TestDocRelayDataOnly(t *testing.T) {
	f := newDocFixture(t, docGolden(t, "epoch"))
	path := "$(touch marker);echo text"
	f.sub(t, "doc:code:branch-a:"+path)
	f.text(t, `{"t":"snap","id":7,"cursor":0,"data":{"epoch":"00112233445566778899aabbccddeeff","client_id":42}}`)
	payload := []byte("import('file:///tmp/branch'); $(sudo launchctl load x); exec('rm -rf /')")
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, append([]byte{1, 0, 0, 0, 7}, payload...)))
	require.Eventually(t, func() bool { _, sent, _ := f.daemon.Recorded(); return len(sent) == 1 }, time.Second, time.Millisecond)
	opened, sent, _ := f.daemon.Recorded()
	require.Equal(t, path, opened[0].Path)
	require.Equal(t, payload, sent[0][13:])
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

func TestDocRelayRevocation(t *testing.T) {
	for _, when := range []string{"startup", "admitted"} {
		t.Run(when, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			routes.SetRevocationSource(bus)
			t.Cleanup(func() { routes.SetRevocationSource(nil) })
			f := newDocFixture(t, docGolden(t, "epoch"))
			if when == "startup" {
				old := f.relay.Authorize
				f.relay.Authorize = func(ctx context.Context, doc live.DocumentTopic, repo, member int64) ([]byte, string) {
					bus.Deliver(revocation.Event{Kind: revocation.KindCollaboratorRemoved, RepositoryID: repo, UserID: member})
					select {
					case <-ctx.Done():
						return nil, live.Forbidden
					case <-time.After(time.Second):
						t.Error("revocation did not cancel startup")
						return old(ctx, doc, repo, member)
					}
				}
			}
			f.sub(t, "doc:code:branch-a:retry.ts")
			if when == "admitted" {
				f.text(t, `{"t":"snap","id":7,"cursor":0,"data":{"epoch":"00112233445566778899aabbccddeeff","client_id":42}}`)
				// All fixture principals use this opaque session digest; no browser actor controls it.
				digest := sha256.Sum256([]byte("doc-cookie"))
				bus.Deliver(revocation.Event{Kind: revocation.KindBrowserSessionRevoked, TokenHash: hex.EncodeToString(digest[:])})
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			for {
				_, _, err := f.conn.Read(ctx)
				if err != nil {
					require.NotEqual(t, context.DeadlineExceeded, ctx.Err())
					break
				}
			}
			if when == "startup" {
				opened, sent, _ := f.daemon.Recorded()
				require.Empty(t, opened)
				require.Empty(t, sent)
			} else {
				require.Eventually(t, func() bool { _, _, n := f.daemon.Recorded(); return n == 1 }, time.Second, time.Millisecond)
			}
		})
	}
}
