package compose

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Actual install router, session loader, roster authorizer and revocation bus.
// Literal refusal fixtures are independent of the documentation inventory.
func TestLiveChannelComposedUpgradePostgres(t *testing.T) {
	raw := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("SMITHERS_TEST_DATABASE_URL required")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, raw)
	require.NoError(t, err)
	defer admin.Close(context.Background())
	name := "fr_t_col_02_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)
	defer func() {
		_, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
		require.NoError(t, err)
	}()
	target, err := url.Parse(raw)
	require.NoError(t, err)
	target.Path = "/" + name
	pool, err := postgresfixture.Open(ctx, target.String(), 4)
	require.NoError(t, err)
	defer pool.Close()
	require.NoError(t, product.Apply(ctx, pool))
	q := db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "liveowner", LowerUsername: "liveowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1);`, user.ID)
	require.NoError(t, err)
	for key, value := range map[string]string{"github.repository": `{"owner_login":"liveowner","repository_name":"repo","repository_id":1}`, "owner.access": `{"owner_login":"liveowner","repository_name":"repo","repository_id":1,"last_access_check_at":"2026-10-05T00:00:00Z"}`} {
		err = q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)})
		require.NoError(t, err)
	}
	token := "live-channel-session"
	hash := sha256.Sum256([]byte(token))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(24 * time.Hour)})
	require.NoError(t, err)
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(ctx))
	defer cancel()
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: "live", PrincipalID: "shared"}
	var snapshotFailure atomic.Bool
	snapshotFailure.Store(true)
	address := &services.InstallAddress{}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: address.Origins, Topics: func(*http.Request) (live.Resolver, int64) {
		return func(_ context.Context, topic string) (live.Source, string) {
			switch topic {
			case "home":
				return liveJobSource(live.Source{Key: "home", Build: func(ctx context.Context) (json.RawMessage, error) {
					if snapshotFailure.CompareAndSwap(true, false) {
						return nil, errors.New("injected temporary snapshot read failure")
					}
					snapshot, err := store.Snapshot(ctx, scope, 1000)
					if err != nil {
						return nil, err
					}
					return json.Marshal(snapshot)
				}}, store, scope), ""
			case "view:another:main", "confirmations:another":
				return live.Source{}, live.Forbidden
			case "doc:code:12:file", "run:missing":
				return live.Source{}, live.Unsupported
			default:
				return live.Source{}, live.UnknownTopic
			}
		}, 0
	}}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeSelfHosted
	server := httptest.NewServer(hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, billing: &routes.BillingHandler{}, jobs: &routes.RepositoryJobHandler{}, live: handler}))
	defer server.Close()
	require.NoError(t, address.Initialize(ctx, pool, services.InstallSetupInput{Bind: server.Listener.Addr().String(), Origins: []string{server.URL}}))
	headers := http.Header{"Cookie": {"smithers_session=" + token}, "Origin": {server.URL}}

	bearer := http.Header{"Authorization": {"Bearer existing-pat"}}
	_, bearerRefused, bearerErr := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: bearer})
	require.Error(t, bearerErr)
	require.Equal(t, 401, bearerRefused.StatusCode)
	bearerRefused.Body.Close()
	wrong := headers.Clone()
	wrong.Set("Origin", "http://wrong.example")
	_, refused, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: wrong})
	require.Error(t, err)
	require.Equal(t, 403, refused.StatusCode)
	refused.Body.Close()
	unknown := headers.Clone()
	unknown.Set("Host", "other.example")
	_, refused, err = websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: unknown, Host: "other.example"})
	require.Error(t, err)
	require.Equal(t, 421, refused.StatusCode)
	refused.Body.Close()
	require.NoError(t, address.Initialize(ctx, pool, services.InstallSetupInput{Bind: server.Listener.Addr().String(), Origins: []string{server.URL, "http://other.example"}}))
	unknown.Set("Origin", "http://other.example")
	added, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: unknown, Host: "other.example"})
	require.NoError(t, err)
	added.CloseNow()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: headers})
	require.NoError(t, err)
	require.Equal(t, 101, response.StatusCode)
	defer conn.CloseNow()
	read := func() live.Frame {
		t.Helper()
		_, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	for _, tc := range []struct{ topic, code string }{{"doc:code:12:file", "unsupported"}, {"run:missing", "unsupported"}, {"view:another:main", "forbidden"}, {"confirmations:another", "forbidden"}, {"unknown", "unknown_topic"}} {
		b, _ := json.Marshal(map[string]any{"t": "sub", "id": 7, "topic": tc.topic})
		require.NoError(t, conn.Write(ctx, websocket.MessageText, b))
		require.Equal(t, live.Frame{T: "err", ID: 7, Code: tc.code}, read())
	}
	for _, kind := range []byte{1, 2} {
		require.NoError(t, conn.Write(ctx, websocket.MessageBinary, []byte{kind, 0, 0, 0, 7}))
		require.Equal(t, live.Frame{T: "err", ID: 7, Code: "unsupported"}, read())
	}
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"presence","id":7}`)))
	require.Equal(t, "unsupported", read().Code)
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":7,"topic":"home"}`)))
	require.Equal(t, live.Frame{T: "err", ID: 7, Code: "unsupported"}, read())
	require.Equal(t, "snap", read().T)

	writeFact := func(state string, rollback bool) {
		t.Helper()
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		_, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "todo.state", state, json.RawMessage(`{"n":12}`))
		require.NoError(t, err)
		if rollback {
			require.NoError(t, tx.Rollback(ctx))
		} else {
			require.NoError(t, tx.Commit(ctx))
		}
	}
	writeFact("working", true)
	writeFact("starting", false)
	first := read()
	require.Equal(t, "delta", first.T)
	require.EqualValues(t, 1, *first.Cursor)
	var event jobs.Event
	require.NoError(t, json.Unmarshal(first.Data, &event))
	require.Equal(t, jobs.State("starting"), event.State)
	require.NoError(t, conn.CloseNow())
	writeFact("working", false)
	conn, response, err = websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: headers})
	require.NoError(t, err)
	require.Equal(t, 101, response.StatusCode)
	defer conn.CloseNow()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":7,"topic":"home","cursor":1}`)))
	second := read()
	require.Equal(t, "delta", second.T)
	require.EqualValues(t, 2, *second.Cursor)
	require.NoError(t, json.Unmarshal(second.Data, &event))
	require.Equal(t, jobs.State("working"), event.State)

	bun, err := exec.LookPath("bun")
	require.NoError(t, err)
	browser := exec.CommandContext(ctx, bun, "testdata/live/channel-client.mjs", server.URL, token)
	var browserErrors bytes.Buffer
	browser.Stderr = &browserErrors
	browserOutput, err := browser.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, browser.Start())
	defer func() {
		if browser.ProcessState == nil {
			browser.Process.Kill()
			browser.Wait()
		}
	}()
	scanner := bufio.NewScanner(browserOutput)
	require.True(t, scanner.Scan(), browserErrors.String())
	require.JSONEq(t, `{"ready":2}`, scanner.Text())
	var writers sync.WaitGroup
	failures := make(chan error, 50)
	for writer := 0; writer < 50; writer++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for row := 0; row < 20; row++ {
				tx, err := pool.Begin(ctx)
				if err != nil {
					failures <- err
					return
				}
				_, err = jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "todo.state", "working", json.RawMessage(`{"n":12}`))
				if err != nil {
					tx.Rollback(ctx)
					failures <- err
					return
				}
				if err = tx.Commit(ctx); err != nil {
					failures <- err
					return
				}
			}
		}()
	}
	for seq := int64(3); seq <= 1002; seq++ {
		frame := read()
		require.Equal(t, "delta", frame.T)
		require.Equal(t, seq, *frame.Cursor)
	}
	writers.Wait()
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}

	require.True(t, scanner.Scan(), browserErrors.String())
	var clientReceipt struct {
		Applied     []int64 `json:"applied"`
		Connections int     `json:"connections"`
		State       string  `json:"state"`
	}
	require.NoError(t, json.Unmarshal(scanner.Bytes(), &clientReceipt))
	require.NoError(t, browser.Wait(), browserErrors.String())
	require.Len(t, clientReceipt.Applied, 1000)
	for index, seq := range clientReceipt.Applied {
		require.EqualValues(t, index+3, seq)
	}
	require.GreaterOrEqual(t, clientReceipt.Connections, 2)
	require.Equal(t, "working", clientReceipt.State)
	require.NoError(t, store.ExpireEventsThrough(ctx, scope, 1002))

	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":7,"topic":"home","cursor":0}`)))
	fresh := read()
	require.Equal(t, "snap", fresh.T)
	require.EqualValues(t, 1002, *fresh.Cursor)
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":0,"topic":"home"}`)))
	_, _, err = conn.Read(ctx)
	require.Equal(t, websocket.StatusInvalidFramePayloadData, websocket.CloseStatus(err))

	// A real durable revocation, without local delivery, closes the session
	// through the composed route within the five-second product bound.
	revokedConn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: headers})
	require.NoError(t, err)
	defer revokedConn.CloseNow()
	// A second browser session of the same person must retain delivery and
	// access to persisted results when only the first session is revoked.
	otherToken := "live-channel-other-session"
	otherHash := sha256.Sum256([]byte(otherToken))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(otherHash[:]), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(24 * time.Hour)})
	require.NoError(t, err)
	otherHeaders := headers.Clone()
	otherHeaders.Set("Cookie", "smithers_session="+otherToken)
	otherConn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: otherHeaders})
	require.NoError(t, err)
	defer otherConn.CloseNow()
	readOther := func() live.Frame {
		t.Helper()
		deadline, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_, raw, err := otherConn.Read(deadline)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	require.NoError(t, otherConn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":8,"topic":"home"}`)))
	require.Equal(t, "snap", readOther().T)
	started := time.Now()
	require.NoError(t, revocation.NewDBPublisher(q, nil).Publish(ctx, revocation.Event{Kind: revocation.KindBrowserSessionRevoked, TokenHash: hex.EncodeToString(hash[:]), UserID: user.ID}))
	deadline, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	_, _, err = revokedConn.Read(deadline)
	require.Equal(t, websocket.StatusPolicyViolation, websocket.CloseStatus(err))
	require.Less(t, time.Since(started), 5*time.Second)
	_, refused, err = websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: headers})
	require.Error(t, err)
	require.Equal(t, http.StatusUnauthorized, refused.StatusCode)
	refused.Body.Close()
	writeFact("complete", false)
	retained := readOther()
	require.Equal(t, "delta", retained.T)
	require.EqualValues(t, 1003, *retained.Cursor)
	require.NoError(t, json.Unmarshal(retained.Data, &event))
	require.Equal(t, jobs.State("complete"), event.State)
	// Reconnect with the surviving session and replay the saved result.
	require.NoError(t, otherConn.CloseNow())
	otherConn, _, err = websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: otherHeaders})
	require.NoError(t, err)
	defer otherConn.CloseNow()
	require.NoError(t, otherConn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":9,"topic":"home","cursor":1002}`)))
	saved := readOther()
	require.Equal(t, "delta", saved.T)
	require.EqualValues(t, 1003, *saved.Cursor)
	require.JSONEq(t, string(retained.Data), string(saved.Data))
}
