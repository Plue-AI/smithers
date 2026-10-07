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
	"sync"
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

// A retained failed attempt is the initial fixture, not a simulated transition.
// Both Retry requests traverse the install router and commit one source fact.
func TestLiveRetryDuplicateAcceptanceThroughInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "retry-owner", LowerUsername: "retry-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	for key, value := range map[string]string{"github.repository": fmt.Sprintf(`{"owner_login":"retry-owner","repository_name":"app","repository_id":%d}`, repo.ID), "owner.access": fmt.Sprintf(`{"owner_login":"retry-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-07T00:00:00Z"}`, repo.ID)} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	third, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "blocked", Title: pgtype.Text{String: "Retained failure", Valid: true}, OwnerID: pgtype.Int8{Int64: owner.ID, Valid: true}, Checks: []byte(`{"todo":true,"run_launched":true,"run_attached":true}`)})
	require.NoError(t, err)
	third.Attempt = 1
	third.RequestRunID = "retained-failed-run"
	third.Reason = "model request refused"
	third.FlowDigest = pgtype.Text{String: strings.Repeat("a", 64), Valid: true}
	third, err = q.SaveMythicalItem(ctx, third)
	require.NoError(t, err)
	token := "retry-browser"
	hash := sha256.Sum256([]byte(token))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	busContext, stopBus := context.WithCancel(ctx)
	defer stopBus()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	service := services.NewMythicalService(pool, nil)
	topics := &liveTopics{queries: q, todos: service, jobs: store}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL, cfg.Server.AllowedOrigins = origin, []string{origin}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	composed := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, live: handler, mythical: &routes.MythicalHandler{Service: service}})
	var retryArrivals []time.Time
	var retryMu sync.Mutex
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.Header.Get("Idempotency-Key") == "duplicate-retry" {
			retryMu.Lock()
			retryArrivals = append(retryArrivals, time.Now())
			retryMu.Unlock()
		}
		composed.ServeHTTP(w, r)
	})
	server.Start()
	defer server.Close()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + token}, "Origin": {origin}}})
	require.NoError(t, err)
	defer socket.CloseNow()
	require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:1"}`)))
	read := func() live.Frame {
		deadline, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_, raw, err := socket.Read(deadline)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	initial := read()
	require.Equal(t, "snap", initial.T)
	require.EqualValues(t, 0, *initial.Cursor)
	require.Contains(t, string(initial.Data), `"state":"failed"`)
	type retryResult struct {
		status  int
		receipt services.TodoControlReceipt
		err     error
	}
	results := make(chan retryResult, 2)
	start := make(chan struct{})
	for range 2 {
		go func() {
			<-start
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/todos/%d", origin, third.Number.Int64), strings.NewReader(`{"op":"retry"}`))
			if err != nil {
				results <- retryResult{err: err}
				return
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", origin)
			request.Header.Set("Idempotency-Key", "duplicate-retry")
			request.Header.Set("X-CSRF-Token", "csrf")
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
			request.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
			response, err := server.Client().Do(request)
			if err != nil {
				results <- retryResult{err: err}
				return
			}
			defer response.Body.Close()
			var receipt services.TodoControlReceipt
			err = json.NewDecoder(response.Body).Decode(&receipt)
			results <- retryResult{status: response.StatusCode, receipt: receipt, err: err}
		}()
	}
	close(start)
	for range 2 {
		result := <-results
		require.NoError(t, result.err)
		require.Equal(t, http.StatusAccepted, result.status)
		require.Equal(t, services.TodoControlReceipt{State: "accepted", Attempt: 2}, result.receipt)
	}
	retryMu.Lock()
	arrivals := append([]time.Time(nil), retryArrivals...)
	retryMu.Unlock()
	require.Len(t, arrivals, 2)
	require.Less(t, arrivals[1].Sub(arrivals[0]), 100*time.Millisecond)
	var retries, retryFacts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_array_length(checks->'retries') FROM mythical_items WHERE id=$1`, third.ID).Scan(&retries))
	require.Equal(t, 1, retries)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND event_type='todo.retried'`,
		strconv.FormatInt(repo.ID, 10), "todo:"+uuid.UUID(third.ID.Bytes).String()).Scan(&retryFacts))
	require.Equal(t, 1, retryFacts)
	queued, err := service.Todo(ctx, repo.ID, third.Number.Int64)
	require.NoError(t, err)
	require.Equal(t, "queued", queued["state"])

	delta := read()
	require.Equal(t, "delta", delta.T)
	require.EqualValues(t, 1, *delta.Cursor)
	var fact jobs.Event
	require.NoError(t, json.Unmarshal(delta.Data, &fact))
	require.Equal(t, "todo.retried", fact.Type)
	require.Equal(t, jobs.State("queued"), fact.State)
	var payload struct{ Card struct{ State string } }
	require.NoError(t, json.Unmarshal(fact.Data, &payload))
	require.Equal(t, "queued", payload.Card.State)
	page, err := store.Replay(ctx, jobs.Scope{TenantID: strconv.FormatInt(repo.ID, 10), PrincipalID: "todo:" + uuid.UUID(third.ID.Bytes).String()}, 0, 100)
	require.NoError(t, err)
	require.Len(t, page.Events, 1)
	require.EqualValues(t, 1, page.Head)
}
