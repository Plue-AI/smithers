package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The production control route, source transaction, card builder and upgrade
// route share real PostgreSQL. Only the repository/machine providers are absent:
// dropping a queued TODO executes no repository code and needs neither.
func TestLiveTodoCommittedCardsRollbackAndReplay(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "live-owner", LowerUsername: "live-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1);`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	for key, value := range map[string]string{"github.repository": fmt.Sprintf(`{"owner_login":"live-owner","repository_name":"app","repository_id":%d}`, repo.ID), "owner.access": fmt.Sprintf(`{"owner_login":"live-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-06T00:00:00Z"}`, repo.ID)} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "queued", Title: pgtype.Text{String: "Committed card", Valid: true}, OwnerID: pgtype.Int8{Int64: owner.ID, Valid: true}, Checks: []byte(`{"todo":true}`)})
	require.NoError(t, err)
	require.EqualValues(t, 1, item.Number.Int64)
	item.Title = pgtype.Text{String: "Committed card", Valid: true}
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	token := "live-card-browser"
	hash := sha256.Sum256([]byte(token))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	busContext, stopBus := context.WithCancel(ctx)
	defer stopBus()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	topics := &liveTopics{queries: q, todos: service, jobs: store}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL, cfg.Server.AllowedOrigins = origin, []string{origin}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, live: handler, mythical: &routes.MythicalHandler{Service: service}})
	server.Start()
	defer server.Close()
	headers := http.Header{"Cookie": {"smithers_session=" + token}, "Origin": {origin}}
	dial := func() *websocket.Conn {
		socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: headers})
		require.NoError(t, err)
		t.Cleanup(func() { socket.CloseNow() })
		return socket
	}
	read := func(socket *websocket.Conn) live.Frame {
		deadline, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_, raw, err := socket.Read(deadline)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	socket := dial()
	require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1"}`)))
	initial := read(socket)
	require.Equal(t, "snap", initial.T)
	require.EqualValues(t, 0, *initial.Cursor)
	require.Contains(t, string(initial.Data), `"state":"queued"`)
	call := func(key string) int {
		request, err := http.NewRequest("POST", origin+"/api/todos/1", strings.NewReader(`{"op":"drop"}`))
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		request.Header.Set("Idempotency-Key", key)
		request.Header.Set("X-CSRF-Token", "csrf")
		request.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		defer response.Body.Close()
		return response.StatusCode
	}
	// Fail after the item update, before its fact can commit.
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_live_card_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected source failure'; END $$; CREATE TRIGGER reject_live_card_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION reject_live_card_fact()`)
	require.NoError(t, err)
	require.Equal(t, 503, call("rolled-back-drop"))
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM mythical_items WHERE id=$1`, item.ID).Scan(&state))
	require.Equal(t, "queued", state)
	scope := jobs.Scope{TenantID: strconv.FormatInt(repo.ID, 10), PrincipalID: "todo:" + uuid.UUID(item.ID.Bytes).String()}
	head, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Zero(t, head)
	// A concurrent reader stays alive across the absence assertion.
	type pendingRead struct {
		frame live.Frame
		err   error
	}
	received := make(chan pendingRead, 1)
	go func() {
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := socket.Read(deadline)
		var frame live.Frame
		if err == nil {
			err = json.Unmarshal(raw, &frame)
		}
		received <- pendingRead{frame, err}
	}()
	select {
	case <-received:
		t.Fatal("rollback published a frame")
	case <-time.After(500 * time.Millisecond):
	}
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_live_card_fact ON product_job_events; DROP FUNCTION reject_live_card_fact()`)
	require.NoError(t, err)
	require.Equal(t, 202, call("committed-drop"))
	var delta live.Frame
	select {
	case result := <-received:
		require.NoError(t, result.err)
		delta = result.frame
	case <-time.After(6 * time.Second):
		t.Fatal("committed fact was not delivered")
	}
	require.Equal(t, "delta", delta.T)
	require.EqualValues(t, 1, *delta.Cursor)
	var event struct {
		State string
		Data  struct {
			Card json.RawMessage `json:"card"`
		}
	}
	require.NoError(t, json.Unmarshal(delta.Data, &event))
	require.Equal(t, "dropped", event.State)
	require.Contains(t, string(event.Data.Card), `"state":"dropped"`)
	require.Contains(t, string(event.Data.Card), `"n":1`)
	require.Contains(t, string(event.Data.Card), `"title":"Committed card"`)
	replay := dial()
	require.NoError(t, replay.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1","cursor":0}`)))
	resumed := read(replay)
	require.Equal(t, "delta", resumed.T)
	require.JSONEq(t, string(delta.Data), string(resumed.Data))
	require.EqualValues(t, 1, *resumed.Cursor)
	require.NoError(t, store.ExpireEventsThrough(ctx, scope, 1))
	require.NoError(t, replay.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1","cursor":0}`)))
	retained := read(replay)
	require.Equal(t, "snap", retained.T)
	require.EqualValues(t, 1, *retained.Cursor)
	require.Contains(t, string(retained.Data), `"state":"dropped"`)
}
